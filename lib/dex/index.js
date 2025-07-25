/**
 * DEX Module - Otedama
 * Decentralized Exchange functionality
 * 
 * Features:
 * - High-performance order matching
 * - Order book management
 * - MEV protection
 * - Multiple order types
 * - Cross-chain support
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import { LRUCache } from '../core/performance.js';

const logger = createLogger('DEX');

/**
 * Order types
 */
export const OrderType = {
  MARKET: 'market',
  LIMIT: 'limit',
  STOP_LOSS: 'stop_loss',
  STOP_LIMIT: 'stop_limit',
  TRAILING_STOP: 'trailing_stop'
};

/**
 * Order side
 */
export const OrderSide = {
  BUY: 'buy',
  SELL: 'sell'
};

/**
 * Order status
 */
export const OrderStatus = {
  PENDING: 'pending',
  OPEN: 'open',
  PARTIALLY_FILLED: 'partially_filled',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
};

/**
 * Order class
 */
export class Order {
  constructor(params) {
    this.id = params.id || crypto.randomUUID();
    this.userId = params.userId;
    this.pair = params.pair;
    this.side = params.side;
    this.type = params.type;
    this.price = params.price || 0;
    this.amount = params.amount;
    this.filled = 0;
    this.status = OrderStatus.PENDING;
    this.timestamp = Date.now();
    this.expiry = params.expiry || null;
    this.stopPrice = params.stopPrice || null;
    this.trailingPercent = params.trailingPercent || null;
    this.fees = 0;
    this.trades = [];
  }
  
  get remaining() {
    return this.amount - this.filled;
  }
  
  get fillPercent() {
    return (this.filled / this.amount) * 100;
  }
  
  get isActive() {
    return [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED].includes(this.status);
  }
  
  fill(amount, price) {
    const fillAmount = Math.min(amount, this.remaining);
    this.filled += fillAmount;
    
    if (this.filled >= this.amount) {
      this.status = OrderStatus.FILLED;
    } else if (this.filled > 0) {
      this.status = OrderStatus.PARTIALLY_FILLED;
    }
    
    const trade = {
      amount: fillAmount,
      price,
      timestamp: Date.now()
    };
    
    this.trades.push(trade);
    return trade;
  }
  
  cancel() {
    if (this.isActive) {
      this.status = OrderStatus.CANCELLED;
      return true;
    }
    return false;
  }
}

/**
 * Order Book
 */
export class OrderBook extends EventEmitter {
  constructor(pair) {
    super();
    
    this.pair = pair;
    this.bids = []; // Buy orders (sorted high to low)
    this.asks = []; // Sell orders (sorted low to high)
    this.orderMap = new Map(); // orderId -> order
    this.userOrders = new Map(); // userId -> Set of orderIds
    
    this.lastPrice = 0;
    this.lastUpdateTime = Date.now();
    
    // Statistics
    this.stats = {
      totalVolume: 0,
      volumeLast24h: 0,
      high24h: 0,
      low24h: Infinity,
      tradesLast24h: 0
    };
  }
  
  /**
   * Add order to book
   */
  addOrder(order) {
    if (order.type === OrderType.MARKET) {
      return this.executeMarketOrder(order);
    }
    
    order.status = OrderStatus.OPEN;
    this.orderMap.set(order.id, order);
    
    // Add to user orders
    if (!this.userOrders.has(order.userId)) {
      this.userOrders.set(order.userId, new Set());
    }
    this.userOrders.get(order.userId).add(order.id);
    
    // Add to appropriate side
    const side = order.side === OrderSide.BUY ? this.bids : this.asks;
    side.push(order);
    
    // Sort orders
    this.sortOrders();
    
    this.emit('order:added', order);
    
    // Try to match orders
    this.matchOrders();
    
    return order;
  }
  
  /**
   * Execute market order
   */
  executeMarketOrder(order) {
    const otherSide = order.side === OrderSide.BUY ? this.asks : this.bids;
    const trades = [];
    
    while (order.remaining > 0 && otherSide.length > 0) {
      const bestOrder = otherSide[0];
      const tradeAmount = Math.min(order.remaining, bestOrder.remaining);
      const tradePrice = bestOrder.price;
      
      // Fill both orders
      const buyTrade = order.fill(tradeAmount, tradePrice);
      const sellTrade = bestOrder.fill(tradeAmount, tradePrice);
      
      // Create trade record
      const trade = {
        id: crypto.randomUUID(),
        buyOrderId: order.side === OrderSide.BUY ? order.id : bestOrder.id,
        sellOrderId: order.side === OrderSide.SELL ? order.id : bestOrder.id,
        price: tradePrice,
        amount: tradeAmount,
        timestamp: Date.now()
      };
      
      trades.push(trade);
      this.recordTrade(trade);
      
      // Remove filled order
      if (bestOrder.remaining === 0) {
        otherSide.shift();
        this.removeOrder(bestOrder.id);
      }
    }
    
    if (order.remaining > 0) {
      order.status = OrderStatus.CANCELLED;
      this.emit('order:cancelled', order);
    }
    
    return { order, trades };
  }
  
  /**
   * Match orders in the book
   */
  matchOrders() {
    const trades = [];
    
    while (this.bids.length > 0 && this.asks.length > 0) {
      const bestBid = this.bids[0];
      const bestAsk = this.asks[0];
      
      // Check if orders can match
      if (bestBid.price < bestAsk.price) {
        break;
      }
      
      // Determine trade price (favor earlier order)
      const tradePrice = bestBid.timestamp < bestAsk.timestamp ? bestBid.price : bestAsk.price;
      const tradeAmount = Math.min(bestBid.remaining, bestAsk.remaining);
      
      // Fill both orders
      bestBid.fill(tradeAmount, tradePrice);
      bestAsk.fill(tradeAmount, tradePrice);
      
      // Create trade record
      const trade = {
        id: crypto.randomUUID(),
        buyOrderId: bestBid.id,
        sellOrderId: bestAsk.id,
        price: tradePrice,
        amount: tradeAmount,
        timestamp: Date.now()
      };
      
      trades.push(trade);
      this.recordTrade(trade);
      
      // Remove filled orders
      if (bestBid.remaining === 0) {
        this.bids.shift();
        this.removeOrder(bestBid.id);
      }
      
      if (bestAsk.remaining === 0) {
        this.asks.shift();
        this.removeOrder(bestAsk.id);
      }
    }
    
    return trades;
  }
  
  /**
   * Cancel order
   */
  cancelOrder(orderId, userId = null) {
    const order = this.orderMap.get(orderId);
    if (!order) {
      return { success: false, error: 'Order not found' };
    }
    
    // Check ownership
    if (userId && order.userId !== userId) {
      return { success: false, error: 'Unauthorized' };
    }
    
    if (!order.cancel()) {
      return { success: false, error: 'Order cannot be cancelled' };
    }
    
    // Remove from book
    this.removeOrder(orderId);
    
    this.emit('order:cancelled', order);
    
    return { success: true, order };
  }
  
  /**
   * Remove order from book
   */
  removeOrder(orderId) {
    const order = this.orderMap.get(orderId);
    if (!order) return;
    
    // Remove from order map
    this.orderMap.delete(orderId);
    
    // Remove from user orders
    const userOrderSet = this.userOrders.get(order.userId);
    if (userOrderSet) {
      userOrderSet.delete(orderId);
      if (userOrderSet.size === 0) {
        this.userOrders.delete(order.userId);
      }
    }
    
    // Remove from bid/ask list
    const side = order.side === OrderSide.BUY ? this.bids : this.asks;
    const index = side.findIndex(o => o.id === orderId);
    if (index !== -1) {
      side.splice(index, 1);
    }
  }
  
  /**
   * Sort orders
   */
  sortOrders() {
    // Sort bids high to low
    this.bids.sort((a, b) => b.price - a.price);
    
    // Sort asks low to high
    this.asks.sort((a, b) => a.price - b.price);
  }
  
  /**
   * Record trade
   */
  recordTrade(trade) {
    this.lastPrice = trade.price;
    this.lastUpdateTime = Date.now();
    
    // Update statistics
    this.stats.totalVolume += trade.amount * trade.price;
    this.stats.tradesLast24h++;
    
    // Update 24h high/low
    if (trade.price > this.stats.high24h) {
      this.stats.high24h = trade.price;
    }
    if (trade.price < this.stats.low24h) {
      this.stats.low24h = trade.price;
    }
    
    this.emit('trade', trade);
  }
  
  /**
   * Get order book depth
   */
  getDepth(levels = 20) {
    return {
      bids: this.bids.slice(0, levels).map(o => ({
        price: o.price,
        amount: o.remaining,
        total: o.remaining * o.price
      })),
      asks: this.asks.slice(0, levels).map(o => ({
        price: o.price,
        amount: o.remaining,
        total: o.remaining * o.price
      }))
    };
  }
  
  /**
   * Get spread
   */
  getSpread() {
    if (this.bids.length === 0 || this.asks.length === 0) {
      return null;
    }
    
    const bestBid = this.bids[0].price;
    const bestAsk = this.asks[0].price;
    const spread = bestAsk - bestBid;
    const spreadPercent = (spread / bestAsk) * 100;
    
    return {
      bestBid,
      bestAsk,
      spread,
      spreadPercent
    };
  }
  
  /**
   * Get user orders
   */
  getUserOrders(userId) {
    const orderIds = this.userOrders.get(userId) || new Set();
    return Array.from(orderIds).map(id => this.orderMap.get(id)).filter(Boolean);
  }
  
  /**
   * Get market stats
   */
  getStats() {
    return {
      ...this.stats,
      lastPrice: this.lastPrice,
      spread: this.getSpread(),
      bidVolume: this.bids.reduce((sum, o) => sum + o.remaining, 0),
      askVolume: this.asks.reduce((sum, o) => sum + o.remaining, 0),
      orderCount: this.orderMap.size
    };
  }
}

/**
 * MEV Protection
 */
export class MEVProtection {
  constructor(options = {}) {
    this.minOrderDelay = options.minOrderDelay || 100; // 100ms minimum delay
    this.maxPriceImpact = options.maxPriceImpact || 0.05; // 5% max price impact
    this.sandwichDetectionWindow = options.sandwichDetectionWindow || 1000; // 1 second
    
    this.recentOrders = new LRUCache(1000);
    this.suspiciousPatterns = new Map();
  }
  
  /**
   * Check order for MEV attempts
   */
  async checkOrder(order, orderBook) {
    const checks = {
      timing: this.checkTiming(order),
      priceImpact: this.checkPriceImpact(order, orderBook),
      sandwichAttack: this.checkSandwichAttack(order, orderBook),
      washTrading: this.checkWashTrading(order)
    };
    
    const issues = Object.entries(checks)
      .filter(([, result]) => !result.safe)
      .map(([type, result]) => ({ type, ...result }));
    
    if (issues.length > 0) {
      logger.warn('MEV protection triggered:', { order: order.id, issues });
      
      // Add delay for suspicious orders
      await this.delay(this.minOrderDelay * issues.length);
    }
    
    return {
      safe: issues.length === 0,
      issues,
      recommendation: this.getRecommendation(issues)
    };
  }
  
  /**
   * Check order timing
   */
  checkTiming(order) {
    const recentOrder = this.recentOrders.get(order.userId);
    
    if (recentOrder && Date.now() - recentOrder.timestamp < this.minOrderDelay) {
      return {
        safe: false,
        reason: 'Order submitted too quickly',
        timeSinceLastOrder: Date.now() - recentOrder.timestamp
      };
    }
    
    this.recentOrders.set(order.userId, {
      timestamp: Date.now(),
      orderId: order.id
    });
    
    return { safe: true };
  }
  
  /**
   * Check price impact
   */
  checkPriceImpact(order, orderBook) {
    if (order.type !== OrderType.MARKET) {
      return { safe: true };
    }
    
    const depth = orderBook.getDepth();
    const otherSide = order.side === OrderSide.BUY ? depth.asks : depth.bids;
    
    let totalCost = 0;
    let totalAmount = 0;
    let remaining = order.amount;
    
    for (const level of otherSide) {
      const fillAmount = Math.min(remaining, level.amount);
      totalCost += fillAmount * level.price;
      totalAmount += fillAmount;
      remaining -= fillAmount;
      
      if (remaining <= 0) break;
    }
    
    if (totalAmount === 0) {
      return { safe: true };
    }
    
    const avgPrice = totalCost / totalAmount;
    const currentPrice = orderBook.lastPrice || otherSide[0]?.price || 0;
    const priceImpact = Math.abs(avgPrice - currentPrice) / currentPrice;
    
    if (priceImpact > this.maxPriceImpact) {
      return {
        safe: false,
        reason: 'Excessive price impact',
        priceImpact: priceImpact * 100,
        maxAllowed: this.maxPriceImpact * 100
      };
    }
    
    return { safe: true, priceImpact: priceImpact * 100 };
  }
  
  /**
   * Check for sandwich attacks
   */
  checkSandwichAttack(order, orderBook) {
    const userOrders = orderBook.getUserOrders(order.userId);
    const recentOrders = userOrders.filter(o => 
      Date.now() - o.timestamp < this.sandwichDetectionWindow
    );
    
    // Check for buy-sell-buy or sell-buy-sell pattern
    if (recentOrders.length >= 2) {
      const sides = recentOrders.map(o => o.side);
      sides.push(order.side);
      
      if (this.isSandwichPattern(sides)) {
        return {
          safe: false,
          reason: 'Potential sandwich attack pattern detected',
          pattern: sides
        };
      }
    }
    
    return { safe: true };
  }
  
  /**
   * Check for wash trading
   */
  checkWashTrading(order) {
    const key = `${order.userId}:${order.pair}`;
    const pattern = this.suspiciousPatterns.get(key) || {
      trades: 0,
      volume: 0,
      startTime: Date.now()
    };
    
    pattern.trades++;
    pattern.volume += order.amount * (order.price || 0);
    
    const timeElapsed = Date.now() - pattern.startTime;
    const tradesPerMinute = (pattern.trades / timeElapsed) * 60000;
    
    if (tradesPerMinute > 10) { // More than 10 trades per minute
      return {
        safe: false,
        reason: 'Potential wash trading detected',
        tradesPerMinute,
        totalTrades: pattern.trades
      };
    }
    
    this.suspiciousPatterns.set(key, pattern);
    
    // Clean old patterns
    if (this.suspiciousPatterns.size > 1000) {
      const oldest = Array.from(this.suspiciousPatterns.entries())
        .sort((a, b) => a[1].startTime - b[1].startTime)[0];
      this.suspiciousPatterns.delete(oldest[0]);
    }
    
    return { safe: true };
  }
  
  /**
   * Check if sides form sandwich pattern
   */
  isSandwichPattern(sides) {
    if (sides.length < 3) return false;
    
    // Check for buy-sell-buy or sell-buy-sell
    for (let i = 0; i <= sides.length - 3; i++) {
      if (sides[i] === sides[i + 2] && sides[i] !== sides[i + 1]) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Get recommendation based on issues
   */
  getRecommendation(issues) {
    if (issues.length === 0) return 'proceed';
    
    const severity = issues.reduce((max, issue) => {
      const severities = {
        'timing': 1,
        'priceImpact': 3,
        'sandwichAttack': 4,
        'washTrading': 5
      };
      return Math.max(max, severities[issue.type] || 0);
    }, 0);
    
    if (severity >= 4) return 'reject';
    if (severity >= 2) return 'delay';
    return 'proceed_with_caution';
  }
  
  /**
   * Delay helper
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Trading Engine
 */
export class TradingEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.orderBooks = new Map(); // pair -> OrderBook
    this.mevProtection = new MEVProtection(options.mevProtection);
    this.feeRate = options.feeRate || 0.001; // 0.1% default fee
    
    this.stats = {
      totalTrades: 0,
      totalVolume: 0,
      totalFees: 0
    };
  }
  
  /**
   * Get or create order book for pair
   */
  getOrderBook(pair) {
    if (!this.orderBooks.has(pair)) {
      const orderBook = new OrderBook(pair);
      
      // Forward events
      orderBook.on('trade', trade => {
        this.stats.totalTrades++;
        this.stats.totalVolume += trade.amount * trade.price;
        this.emit('trade', { pair, ...trade });
      });
      
      orderBook.on('order:added', order => {
        this.emit('order:added', { pair, order });
      });
      
      orderBook.on('order:cancelled', order => {
        this.emit('order:cancelled', { pair, order });
      });
      
      this.orderBooks.set(pair, orderBook);
    }
    
    return this.orderBooks.get(pair);
  }
  
  /**
   * Submit order
   */
  async submitOrder(orderParams) {
    const order = new Order(orderParams);
    const orderBook = this.getOrderBook(order.pair);
    
    // MEV protection check
    const mevCheck = await this.mevProtection.checkOrder(order, orderBook);
    
    if (mevCheck.recommendation === 'reject') {
      throw new Error('Order rejected by MEV protection');
    }
    
    // Calculate fees
    order.fees = order.amount * order.price * this.feeRate;
    this.stats.totalFees += order.fees;
    
    // Add to order book
    const result = orderBook.addOrder(order);
    
    return result;
  }
  
  /**
   * Cancel order
   */
  cancelOrder(orderId, pair, userId) {
    const orderBook = this.getOrderBook(pair);
    return orderBook.cancelOrder(orderId, userId);
  }
  
  /**
   * Get market data
   */
  getMarketData(pair) {
    const orderBook = this.getOrderBook(pair);
    
    return {
      pair,
      lastPrice: orderBook.lastPrice,
      depth: orderBook.getDepth(),
      stats: orderBook.getStats(),
      lastUpdate: orderBook.lastUpdateTime
    };
  }
  
  /**
   * Get all markets
   */
  getAllMarkets() {
    const markets = [];
    
    for (const [pair, orderBook] of this.orderBooks) {
      markets.push({
        pair,
        lastPrice: orderBook.lastPrice,
        volume24h: orderBook.stats.volumeLast24h,
        high24h: orderBook.stats.high24h,
        low24h: orderBook.stats.low24h,
        spread: orderBook.getSpread()
      });
    }
    
    return markets;
  }
  
  /**
   * Get engine statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeMarkets: this.orderBooks.size,
      totalOrders: Array.from(this.orderBooks.values())
        .reduce((sum, book) => sum + book.orderMap.size, 0)
    };
  }
}

// Default export
export default {
  // Classes
  Order,
  OrderBook,
  MEVProtection,
  TradingEngine,
  
  // Constants
  OrderType,
  OrderSide,
  OrderStatus
};
