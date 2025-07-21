/**
 * Shared Matching Engine Utilities
 * Consolidates duplicate matching logic across different DEX implementations
 * 
 * Design principles:
 * - Carmack: Efficient matching algorithms with minimal branching
 * - Martin: Clean separation of matching strategies
 * - Pike: Simple, reliable trade execution
 */

import { BigNumber } from 'ethers';
import { OrderSide, OrderType, OrderStatus } from './order-validation.js';
import { calculateTradingFee } from './price-calculations.js';

/**
 * Matching strategies enumeration
 */
export const MatchingStrategy = {
  PRICE_TIME: 'price_time',    // Price priority, then time priority
  PRO_RATA: 'pro_rata',        // Proportional allocation
  SIZE_TIME: 'size_time',      // Size priority, then time priority
  FIFO: 'fifo',                // First in, first out
  LIFO: 'lifo'                 // Last in, first out
};

/**
 * Trade execution result structure
 */
export class TradeExecution {
  constructor(params) {
    this.id = params.id || `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.symbol = params.symbol;
    this.buyOrderId = params.buyOrderId;
    this.sellOrderId = params.sellOrderId;
    this.buyUserId = params.buyUserId;
    this.sellUserId = params.sellUserId;
    this.amount = BigNumber.from(params.amount);
    this.price = BigNumber.from(params.price);
    this.buyerFee = params.buyerFee ? BigNumber.from(params.buyerFee) : BigNumber.from(0);
    this.sellerFee = params.sellerFee ? BigNumber.from(params.sellerFee) : BigNumber.from(0);
    this.timestamp = params.timestamp || Date.now();
    this.isMaker = params.isMaker || false; // Which side was the maker
  }
  
  /**
   * Get trade value (amount * price)
   */
  getValue() {
    return this.amount.mul(this.price);
  }
  
  /**
   * Get total fees
   */
  getTotalFees() {
    return this.buyerFee.add(this.sellerFee);
  }
  
  /**
   * Convert to JSON
   */
  toJSON() {
    return {
      id: this.id,
      symbol: this.symbol,
      buyOrderId: this.buyOrderId,
      sellOrderId: this.sellOrderId,
      buyUserId: this.buyUserId,
      sellUserId: this.sellUserId,
      amount: this.amount.toString(),
      price: this.price.toString(),
      buyerFee: this.buyerFee.toString(),
      sellerFee: this.sellerFee.toString(),
      timestamp: this.timestamp,
      isMaker: this.isMaker
    };
  }
}

/**
 * Object pool for trade executions to reduce garbage collection
 */
export class TradePool {
  constructor(initialSize = 1000) {
    this.pool = [];
    this.used = new Set();
    
    // Pre-allocate trade objects
    for (let i = 0; i < initialSize; i++) {
      this.pool.push({});
    }
  }
  
  /**
   * Get trade object from pool
   */
  getTrade(params) {
    let trade;
    
    if (this.pool.length > 0) {
      trade = this.pool.pop();
      // Reset and populate
      Object.assign(trade, new TradeExecution(params));
    } else {
      trade = new TradeExecution(params);
    }
    
    this.used.add(trade);
    return trade;
  }
  
  /**
   * Return trade object to pool
   */
  returnTrade(trade) {
    if (this.used.has(trade)) {
      this.used.delete(trade);
      
      // Clear properties but keep the object
      Object.keys(trade).forEach(key => {
        delete trade[key];
      });
      
      this.pool.push(trade);
    }
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      available: this.pool.length,
      used: this.used.size,
      total: this.pool.length + this.used.size
    };
  }
}

/**
 * Base matching engine with common functionality
 */
export class BaseMatchingEngine {
  constructor(options = {}) {
    this.options = {
      strategy: options.strategy || MatchingStrategy.PRICE_TIME,
      feeConfig: {
        makerFee: options.makerFee || 0.001,  // 0.1%
        takerFee: options.takerFee || 0.002,  // 0.2%
        ...options.feeConfig
      },
      useObjectPool: options.useObjectPool !== false,
      maxTradesPerMatch: options.maxTradesPerMatch || 100,
      ...options
    };
    
    // Object pool for trade executions
    this.tradePool = this.options.useObjectPool ? new TradePool() : null;
    
    // Execution statistics
    this.stats = {
      totalMatches: 0,
      totalTrades: 0,
      totalVolume: BigNumber.from(0),
      totalFees: BigNumber.from(0),
      avgMatchTime: 0,
      lastMatchTime: null
    };
  }
  
  /**
   * Match orders using configured strategy
   */
  matchOrders(incomingOrder, orderBook) {
    const startTime = process.hrtime.bigint();
    
    const matches = this.findMatches(incomingOrder, orderBook);
    const executions = this.executeMatches(matches, incomingOrder);
    
    const endTime = process.hrtime.bigint();
    const matchTime = Number(endTime - startTime) / 1_000_000; // Convert to milliseconds
    
    this.updateStats(executions, matchTime);
    
    return {
      executions,
      remainingOrder: incomingOrder.getRemainingAmount().gt(0) ? incomingOrder : null,
      matchTime
    };
  }
  
  /**
   * Find matching orders based on strategy
   */
  findMatches(incomingOrder, orderBook) {
    const oppositeOrders = this.getOppositeOrders(incomingOrder, orderBook);
    
    switch (this.options.strategy) {
      case MatchingStrategy.PRICE_TIME:
        return this.findPriceTimeMatches(incomingOrder, oppositeOrders);
        
      case MatchingStrategy.PRO_RATA:
        return this.findProRataMatches(incomingOrder, oppositeOrders);
        
      case MatchingStrategy.SIZE_TIME:
        return this.findSizeTimeMatches(incomingOrder, oppositeOrders);
        
      case MatchingStrategy.FIFO:
        return this.findFIFOMatches(incomingOrder, oppositeOrders);
        
      case MatchingStrategy.LIFO:
        return this.findLIFOMatches(incomingOrder, oppositeOrders);
        
      default:
        return this.findPriceTimeMatches(incomingOrder, oppositeOrders);
    }
  }
  
  /**
   * Get orders from opposite side of the book
   */
  getOppositeOrders(incomingOrder, orderBook) {
    if (incomingOrder.side === OrderSide.BUY) {
      return orderBook.getAskOrders();
    } else {
      return orderBook.getBidOrders();
    }
  }
  
  /**
   * Price-time priority matching
   */
  findPriceTimeMatches(incomingOrder, oppositeOrders) {
    const matches = [];
    let remainingAmount = incomingOrder.getRemainingAmount();
    
    // Sort by price (best price first), then by time
    const sortedOrders = this.sortOrdersByPriceTime(oppositeOrders, incomingOrder.side);
    
    for (const order of sortedOrders) {
      if (remainingAmount.isZero()) break;
      
      if (this.canMatch(incomingOrder, order)) {
        const matchAmount = BigNumber.min(remainingAmount, order.getRemainingAmount());
        
        matches.push({
          makerOrder: order,
          takerOrder: incomingOrder,
          amount: matchAmount,
          price: order.price // Maker price
        });
        
        remainingAmount = remainingAmount.sub(matchAmount);
      }
    }
    
    return matches;
  }
  
  /**
   * Pro-rata matching (proportional allocation)
   */
  findProRataMatches(incomingOrder, oppositeOrders) {
    const matches = [];
    let remainingAmount = incomingOrder.getRemainingAmount();
    
    // Get all orders at best price that can match
    const matchableOrders = oppositeOrders.filter(order => this.canMatch(incomingOrder, order));
    if (matchableOrders.length === 0) return matches;
    
    const bestPrice = this.getBestPrice(matchableOrders, incomingOrder.side);
    const ordersAtBestPrice = matchableOrders.filter(order => order.price.eq(bestPrice));
    
    // Calculate total available amount at best price
    const totalAvailable = ordersAtBestPrice
      .reduce((sum, order) => sum.add(order.getRemainingAmount()), BigNumber.from(0));
    
    // Allocate proportionally
    for (const order of ordersAtBestPrice) {
      if (remainingAmount.isZero()) break;
      
      const orderShare = order.getRemainingAmount().mul(10000).div(totalAvailable); // Basis points
      const allocatedAmount = remainingAmount.mul(orderShare).div(10000);
      const matchAmount = BigNumber.min(allocatedAmount, order.getRemainingAmount());
      
      if (matchAmount.gt(0)) {
        matches.push({
          makerOrder: order,
          takerOrder: incomingOrder,
          amount: matchAmount,
          price: order.price
        });
        
        remainingAmount = remainingAmount.sub(matchAmount);
      }
    }
    
    return matches;
  }
  
  /**
   * Size-time priority matching
   */
  findSizeTimeMatches(incomingOrder, oppositeOrders) {
    const matches = [];
    let remainingAmount = incomingOrder.getRemainingAmount();
    
    // Sort by size (largest first), then by time
    const sortedOrders = oppositeOrders
      .filter(order => this.canMatch(incomingOrder, order))
      .sort((a, b) => {
        const sizeCompare = b.getRemainingAmount().sub(a.getRemainingAmount()).toNumber();
        if (sizeCompare !== 0) return sizeCompare;
        return a.createdAt - b.createdAt; // Earlier time first
      });
    
    for (const order of sortedOrders) {
      if (remainingAmount.isZero()) break;
      
      const matchAmount = BigNumber.min(remainingAmount, order.getRemainingAmount());
      
      matches.push({
        makerOrder: order,
        takerOrder: incomingOrder,
        amount: matchAmount,
        price: order.price
      });
      
      remainingAmount = remainingAmount.sub(matchAmount);
    }
    
    return matches;
  }
  
  /**
   * FIFO matching (First In, First Out)
   */
  findFIFOMatches(incomingOrder, oppositeOrders) {
    const matches = [];
    let remainingAmount = incomingOrder.getRemainingAmount();
    
    // Sort by creation time (earliest first)
    const sortedOrders = oppositeOrders
      .filter(order => this.canMatch(incomingOrder, order))
      .sort((a, b) => a.createdAt - b.createdAt);
    
    for (const order of sortedOrders) {
      if (remainingAmount.isZero()) break;
      
      const matchAmount = BigNumber.min(remainingAmount, order.getRemainingAmount());
      
      matches.push({
        makerOrder: order,
        takerOrder: incomingOrder,
        amount: matchAmount,
        price: order.price
      });
      
      remainingAmount = remainingAmount.sub(matchAmount);
    }
    
    return matches;
  }
  
  /**
   * LIFO matching (Last In, First Out)
   */
  findLIFOMatches(incomingOrder, oppositeOrders) {
    const matches = [];
    let remainingAmount = incomingOrder.getRemainingAmount();
    
    // Sort by creation time (latest first)
    const sortedOrders = oppositeOrders
      .filter(order => this.canMatch(incomingOrder, order))
      .sort((a, b) => b.createdAt - a.createdAt);
    
    for (const order of sortedOrders) {
      if (remainingAmount.isZero()) break;
      
      const matchAmount = BigNumber.min(remainingAmount, order.getRemainingAmount());
      
      matches.push({
        makerOrder: order,
        takerOrder: incomingOrder,
        amount: matchAmount,
        price: order.price
      });
      
      remainingAmount = remainingAmount.sub(matchAmount);
    }
    
    return matches;
  }
  
  /**
   * Execute matched trades
   */
  executeMatches(matches, incomingOrder) {
    const executions = [];
    
    for (const match of matches) {
      const execution = this.executeTrade(match);
      executions.push(execution);
      
      // Fill the orders
      match.makerOrder.fill(match.amount, match.price);
      match.takerOrder.fill(match.amount, match.price);
    }
    
    return executions;
  }
  
  /**
   * Execute a single trade
   */
  executeTrade(match) {
    const { makerOrder, takerOrder, amount, price } = match;
    
    // Calculate fees
    const makerFee = calculateTradingFee(amount.mul(price), this.options.feeConfig.makerFee);
    const takerFee = calculateTradingFee(amount.mul(price), this.options.feeConfig.takerFee);
    
    const executionParams = {
      symbol: makerOrder.symbol,
      buyOrderId: makerOrder.side === OrderSide.BUY ? makerOrder.id : takerOrder.id,
      sellOrderId: makerOrder.side === OrderSide.SELL ? makerOrder.id : takerOrder.id,
      buyUserId: makerOrder.side === OrderSide.BUY ? makerOrder.userId : takerOrder.userId,
      sellUserId: makerOrder.side === OrderSide.SELL ? makerOrder.userId : takerOrder.userId,
      amount: amount,
      price: price,
      buyerFee: makerOrder.side === OrderSide.BUY ? makerFee : takerFee,
      sellerFee: makerOrder.side === OrderSide.SELL ? makerFee : takerFee,
      isMaker: makerOrder.side
    };
    
    // Use object pool if available
    if (this.tradePool) {
      return this.tradePool.getTrade(executionParams);
    } else {
      return new TradeExecution(executionParams);
    }
  }
  
  /**
   * Check if two orders can match
   */
  canMatch(order1, order2) {
    // Same side orders cannot match
    if (order1.side === order2.side) return false;
    
    // Different symbols cannot match
    if (order1.symbol !== order2.symbol) return false;
    
    // Market orders always match
    if (order1.type === OrderType.MARKET || order2.type === OrderType.MARKET) {
      return true;
    }
    
    // For limit orders, check price crossing
    if (order1.side === OrderSide.BUY) {
      return order1.price.gte(order2.price);
    } else {
      return order1.price.lte(order2.price);
    }
  }
  
  /**
   * Sort orders by price-time priority
   */
  sortOrdersByPriceTime(orders, incomingSide) {
    return orders.sort((a, b) => {
      // Price priority
      const priceCompare = incomingSide === OrderSide.BUY 
        ? a.price.sub(b.price).toNumber()  // Best ask (lowest price) first
        : b.price.sub(a.price).toNumber(); // Best bid (highest price) first
      
      if (priceCompare !== 0) return priceCompare;
      
      // Time priority (earlier time first)
      return a.createdAt - b.createdAt;
    });
  }
  
  /**
   * Get best price from a list of orders
   */
  getBestPrice(orders, incomingSide) {
    if (orders.length === 0) return null;
    
    return orders.reduce((best, order) => {
      if (!best) return order.price;
      
      if (incomingSide === OrderSide.BUY) {
        // For buy orders, best sell price is lowest
        return order.price.lt(best) ? order.price : best;
      } else {
        // For sell orders, best buy price is highest
        return order.price.gt(best) ? order.price : best;
      }
    }, null);
  }
  
  /**
   * Update matching statistics
   */
  updateStats(executions, matchTime) {
    this.stats.totalMatches++;
    this.stats.totalTrades += executions.length;
    this.stats.lastMatchTime = Date.now();
    
    // Update average match time
    this.stats.avgMatchTime = (
      this.stats.avgMatchTime * (this.stats.totalMatches - 1) + matchTime
    ) / this.stats.totalMatches;
    
    // Update volume and fees
    for (const execution of executions) {
      this.stats.totalVolume = this.stats.totalVolume.add(execution.getValue());
      this.stats.totalFees = this.stats.totalFees.add(execution.getTotalFees());
    }
  }
  
  /**
   * Get matching statistics
   */
  getStats() {
    return {
      ...this.stats,
      totalVolume: this.stats.totalVolume.toString(),
      totalFees: this.stats.totalFees.toString(),
      tradePoolStats: this.tradePool ? this.tradePool.getStats() : null
    };
  }
  
  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalMatches: 0,
      totalTrades: 0,
      totalVolume: BigNumber.from(0),
      totalFees: BigNumber.from(0),
      avgMatchTime: 0,
      lastMatchTime: null
    };
  }
}

export default {
  MatchingStrategy,
  TradeExecution,
  TradePool,
  BaseMatchingEngine
};