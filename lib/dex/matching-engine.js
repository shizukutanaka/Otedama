/**
 * Matching Engine for Otedama DEX
 * High-performance order matching with various algorithms
 */

import { EventEmitter } from 'events';
import { OrderType, OrderStatus } from './order-book.js';

export const MatchingAlgorithm = {
  PRICE_TIME: 'PRICE_TIME',    // First In First Out at same price
  PRO_RATA: 'PRO_RATA',        // Proportional distribution
  PRICE_SIZE_TIME: 'PRICE_SIZE_TIME' // Larger orders get priority
};

export class Trade {
  constructor(params) {
    this.id = params.id || crypto.randomUUID();
    this.buyOrderId = params.buyOrderId;
    this.sellOrderId = params.sellOrderId;
    this.buyUserId = params.buyUserId;
    this.sellUserId = params.sellUserId;
    this.price = params.price;
    this.amount = params.amount;
    this.timestamp = params.timestamp || Date.now();
    this.fee = params.fee || 0;
    this.metadata = params.metadata || {};
  }
}

export class MatchingEngine extends EventEmitter {
  constructor(orderBook, options = {}) {
    super();
    this.orderBook = orderBook;
    this.algorithm = options.algorithm || MatchingAlgorithm.PRICE_TIME;
    this.minOrderSize = options.minOrderSize || 0.00001;
    this.maxOrderSize = options.maxOrderSize || 1000000;
    this.feeRate = options.feeRate || 0.001; // 0.1%
    this.trades = [];
    this.isMatching = false;
    
    // Performance metrics
    this.metrics = {
      totalTrades: 0,
      totalVolume: 0,
      avgMatchTime: 0,
      lastMatchTime: 0
    };
  }

  /**
   * Match a new order against the order book
   */
  async matchOrder(order) {
    if (this.isMatching) {
      throw new Error('Matching already in progress');
    }
    
    this.isMatching = true;
    const startTime = Date.now();
    const trades = [];
    
    try {
      // Add order to book first if it's a limit order
      if (order.orderType === 'LIMIT') {
        this.orderBook.addOrder(order);
      }
      
      // Get opposite side orders
      const oppositeOrders = order.type === OrderType.BUY 
        ? this.orderBook.sellOrders 
        : this.orderBook.buyOrders;
      
      // Match against opposite side
      for (const oppositeOrder of oppositeOrders) {
        if (order.remainingAmount <= 0) break;
        
        // Check if orders can match
        if (this.canMatch(order, oppositeOrder)) {
          const trade = this.executeTrade(order, oppositeOrder);
          if (trade) {
            trades.push(trade);
            this.trades.push(trade);
            
            // Emit trade event
            this.emit('trade', trade);
            
            // Remove filled orders
            if (oppositeOrder.isFilled) {
              this.orderBook.cancelOrder(oppositeOrder.id);
            }
          }
        }
      }
      
      // Update metrics
      const matchTime = Date.now() - startTime;
      this.updateMetrics(trades, matchTime);
      
      // If order not fully filled and it's a limit order, it stays in the book
      if (order.remainingAmount > 0 && order.orderType === 'LIMIT') {
        // Order already added to book
      } else if (order.remainingAmount > 0 && order.orderType === 'MARKET') {
        // Market order not fully filled - cancel remainder
        order.status = OrderStatus.CANCELLED;
        this.emit('orderCancelled', order);
      }
      
      return trades;
      
    } finally {
      this.isMatching = false;
    }
  }

  /**
   * Check if two orders can match
   */
  canMatch(buyOrder, sellOrder) {
    // For market orders, price doesn't matter
    if (buyOrder.orderType === 'MARKET' || sellOrder.orderType === 'MARKET') {
      return true;
    }
    
    // For limit orders, buy price must be >= sell price
    const effectiveBuyPrice = buyOrder.type === OrderType.BUY ? buyOrder.price : sellOrder.price;
    const effectiveSellPrice = buyOrder.type === OrderType.SELL ? buyOrder.price : sellOrder.price;
    
    return effectiveBuyPrice >= effectiveSellPrice;
  }

  /**
   * Execute a trade between two orders
   */
  executeTrade(order1, order2) {
    // Determine buy and sell orders
    const buyOrder = order1.type === OrderType.BUY ? order1 : order2;
    const sellOrder = order1.type === OrderType.SELL ? order1 : order2;
    
    // Determine trade price (price of the order that was in the book first)
    const tradePrice = buyOrder.timestamp < sellOrder.timestamp ? buyOrder.price : sellOrder.price;
    
    // Determine trade amount
    const tradeAmount = Math.min(buyOrder.remainingAmount, sellOrder.remainingAmount);
    
    if (tradeAmount <= 0) return null;
    
    // Fill orders
    const buyFilled = buyOrder.fill(tradeAmount);
    const sellFilled = sellOrder.fill(tradeAmount);
    
    // Calculate fees
    const buyFee = tradeAmount * this.feeRate;
    const sellFee = tradeAmount * tradePrice * this.feeRate;
    
    // Create trade record
    const trade = new Trade({
      buyOrderId: buyOrder.id,
      sellOrderId: sellOrder.id,
      buyUserId: buyOrder.userId,
      sellUserId: sellOrder.userId,
      price: tradePrice,
      amount: tradeAmount,
      fee: {
        buy: buyFee,
        sell: sellFee
      }
    });
    
    // Update last trade price
    this.orderBook.lastTradePrice = tradePrice;
    
    return trade;
  }

  /**
   * Match orders using pro-rata algorithm
   */
  matchProRata(incomingOrder, oppositeOrders) {
    const trades = [];
    const matchableOrders = [];
    
    // Find all orders at the best price
    const bestPrice = oppositeOrders[0]?.price;
    if (!bestPrice) return trades;
    
    for (const order of oppositeOrders) {
      if (order.price === bestPrice && this.canMatch(incomingOrder, order)) {
        matchableOrders.push(order);
      } else {
        break; // Orders are sorted, so we can stop
      }
    }
    
    // Calculate total available amount
    const totalAmount = matchableOrders.reduce((sum, order) => sum + order.remainingAmount, 0);
    
    // Distribute incoming order proportionally
    for (const order of matchableOrders) {
      if (incomingOrder.remainingAmount <= 0) break;
      
      const proportion = order.remainingAmount / totalAmount;
      const matchAmount = Math.min(
        incomingOrder.remainingAmount * proportion,
        order.remainingAmount
      );
      
      if (matchAmount > this.minOrderSize) {
        const trade = this.executeTrade(incomingOrder, order);
        if (trade) trades.push(trade);
      }
    }
    
    return trades;
  }

  /**
   * Update performance metrics
   */
  updateMetrics(trades, matchTime) {
    this.metrics.totalTrades += trades.length;
    this.metrics.totalVolume += trades.reduce((sum, trade) => sum + trade.amount * trade.price, 0);
    this.metrics.lastMatchTime = matchTime;
    
    // Update average match time
    if (this.metrics.totalTrades > 0) {
      this.metrics.avgMatchTime = 
        (this.metrics.avgMatchTime * (this.metrics.totalTrades - trades.length) + matchTime) / 
        this.metrics.totalTrades;
    }
  }

  /**
   * Get recent trades
   */
  getRecentTrades(limit = 100) {
    return this.trades.slice(-limit).reverse();
  }

  /**
   * Get trade history for a user
   */
  getUserTrades(userId, limit = 100) {
    return this.trades
      .filter(trade => trade.buyUserId === userId || trade.sellUserId === userId)
      .slice(-limit)
      .reverse();
  }

  /**
   * Get matching engine statistics
   */
  getStats() {
    return {
      algorithm: this.algorithm,
      ...this.metrics,
      recentTrades: this.trades.length,
      orderBookStats: this.orderBook.getStats()
    };
  }

  /**
   * Calculate market price impact
   */
  calculatePriceImpact(type, amount) {
    const orders = type === OrderType.BUY ? this.orderBook.sellOrders : this.orderBook.buyOrders;
    let remainingAmount = amount;
    let totalCost = 0;
    let worstPrice = null;
    
    for (const order of orders) {
      const fillAmount = Math.min(remainingAmount, order.remainingAmount);
      totalCost += fillAmount * order.price;
      remainingAmount -= fillAmount;
      worstPrice = order.price;
      
      if (remainingAmount <= 0) break;
    }
    
    if (remainingAmount > 0) {
      // Not enough liquidity
      return {
        canFill: false,
        averagePrice: null,
        worstPrice: null,
        priceImpact: null
      };
    }
    
    const averagePrice = totalCost / amount;
    const currentPrice = this.orderBook.lastTradePrice || 
      (this.orderBook.getBestBid()?.price + this.orderBook.getBestAsk()?.price) / 2;
    
    return {
      canFill: true,
      averagePrice,
      worstPrice,
      priceImpact: currentPrice ? ((averagePrice - currentPrice) / currentPrice) * 100 : 0
    };
  }
}