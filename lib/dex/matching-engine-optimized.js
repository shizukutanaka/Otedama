/**
 * Optimized Matching Engine for Otedama DEX
 * Following John Carmack's performance principles
 * - Zero allocations in hot path
 * - Cache-friendly data structures
 * - Batch processing for better throughput
 */

import { EventEmitter } from 'events';
import { OrderType, OrderStatus } from './order-book.js';

export const MatchingAlgorithm = {
  PRICE_TIME: 'PRICE_TIME',
  PRO_RATA: 'PRO_RATA',
  PRICE_SIZE_TIME: 'PRICE_SIZE_TIME'
};

// Pre-allocated object pools
const TRADE_POOL_SIZE = 1000;
const ORDER_UPDATE_POOL_SIZE = 2000;

export class OptimizedMatchingEngine extends EventEmitter {
  constructor(orderBook, options = {}) {
    super();
    this.orderBook = orderBook;
    this.algorithm = options.algorithm || MatchingAlgorithm.PRICE_TIME;
    this.minOrderSize = options.minOrderSize || 0.00001;
    this.maxOrderSize = options.maxOrderSize || 1000000;
    this.feeRate = options.feeRate || 0.001;
    
    // Batch processing
    this.batchSize = options.batchSize || 100;
    this.matchQueue = [];
    this.isProcessing = false;
    
    // Object pools
    this.tradePool = [];
    this.orderUpdatePool = [];
    this._initializePools();
    
    // Price level cache for faster matching
    this.priceCache = new Map();
    
    // Performance metrics
    this.metrics = {
      totalTrades: 0,
      totalVolume: 0,
      avgMatchTime: 0,
      lastMatchTime: 0,
      poolHits: 0,
      allocations: 0
    };
    
    // Start batch processor
    this._startBatchProcessor();
  }
  
  _initializePools() {
    // Pre-allocate trade objects
    for (let i = 0; i < TRADE_POOL_SIZE; i++) {
      this.tradePool.push({
        id: '',
        buyOrderId: '',
        sellOrderId: '',
        buyUserId: '',
        sellUserId: '',
        price: 0,
        amount: 0,
        timestamp: 0,
        fee: 0,
        inUse: false
      });
    }
    
    // Pre-allocate order update objects
    for (let i = 0; i < ORDER_UPDATE_POOL_SIZE; i++) {
      this.orderUpdatePool.push({
        orderId: '',
        remainingAmount: 0,
        status: '',
        inUse: false
      });
    }
  }
  
  _getTrade() {
    const trade = this.tradePool.find(t => !t.inUse);
    if (trade) {
      trade.inUse = true;
      this.metrics.poolHits++;
      return trade;
    }
    this.metrics.allocations++;
    return {
      id: '',
      buyOrderId: '',
      sellOrderId: '',
      buyUserId: '',
      sellUserId: '',
      price: 0,
      amount: 0,
      timestamp: 0,
      fee: 0,
      inUse: true
    };
  }
  
  _returnTrade(trade) {
    if (this.tradePool.length < TRADE_POOL_SIZE) {
      trade.inUse = false;
      this.tradePool.push(trade);
    }
  }
  
  _startBatchProcessor() {
    setInterval(() => {
      if (this.matchQueue.length > 0 && !this.isProcessing) {
        this._processBatch();
      }
    }, 10); // Process every 10ms
  }
  
  async matchOrder(order) {
    // Add to queue for batch processing
    return new Promise((resolve, reject) => {
      this.matchQueue.push({ order, resolve, reject });
      
      // Process immediately if queue is full
      if (this.matchQueue.length >= this.batchSize) {
        this._processBatch();
      }
    });
  }
  
  async _processBatch() {
    if (this.isProcessing) return;
    
    this.isProcessing = true;
    const startTime = Date.now();
    
    // Get batch of orders
    const batch = this.matchQueue.splice(0, this.batchSize);
    const results = new Map();
    
    // Sort orders for optimal cache usage
    batch.sort((a, b) => {
      if (a.order.type !== b.order.type) {
        return a.order.type === OrderType.BUY ? -1 : 1;
      }
      return b.order.price - a.order.price;
    });
    
    // Process each order in batch
    for (const { order, resolve, reject } of batch) {
      try {
        const trades = await this._matchSingleOrder(order);
        results.set(order.id, trades);
        resolve(trades);
      } catch (error) {
        reject(error);
      }
    }
    
    // Batch emit trades
    const allTrades = Array.from(results.values()).flat();
    if (allTrades.length > 0) {
      this.emit('trades', allTrades);
    }
    
    // Update metrics
    const matchTime = Date.now() - startTime;
    this.metrics.avgMatchTime = (this.metrics.avgMatchTime + matchTime) / 2;
    this.metrics.lastMatchTime = matchTime;
    
    this.isProcessing = false;
  }
  
  async _matchSingleOrder(order) {
    const trades = [];
    
    // Add order to book first if it's a limit order
    if (order.orderType === 'LIMIT') {
      this.orderBook.addOrder(order);
    }
    
    // Get cached price levels or fetch from order book
    const oppositeType = order.type === OrderType.BUY ? OrderType.SELL : OrderType.BUY;
    const priceLevels = this._getCachedPriceLevels(oppositeType);
    
    // Binary search for matching price level
    let startIdx = 0;
    let endIdx = priceLevels.length - 1;
    
    if (order.type === OrderType.BUY) {
      // For buy orders, find highest sell price <= order price
      while (startIdx <= endIdx) {
        const midIdx = Math.floor((startIdx + endIdx) / 2);
        if (priceLevels[midIdx].price <= order.price) {
          endIdx = midIdx - 1;
        } else {
          startIdx = midIdx + 1;
        }
      }
    } else {
      // For sell orders, find lowest buy price >= order price
      while (startIdx <= endIdx) {
        const midIdx = Math.floor((startIdx + endIdx) / 2);
        if (priceLevels[midIdx].price >= order.price) {
          endIdx = midIdx - 1;
        } else {
          startIdx = midIdx + 1;
        }
      }
    }
    
    // Match against eligible price levels
    for (let i = startIdx; i < priceLevels.length && order.remainingAmount > 0; i++) {
      const priceLevel = priceLevels[i];
      
      for (const oppositeOrder of priceLevel.orders) {
        if (order.remainingAmount <= 0) break;
        
        if (this._canMatchFast(order, oppositeOrder)) {
          const trade = this._executeTradeOptimized(order, oppositeOrder);
          if (trade) {
            trades.push(trade);
            this.metrics.totalTrades++;
            this.metrics.totalVolume += trade.amount * trade.price;
          }
        }
      }
    }
    
    // Update order status
    if (order.remainingAmount <= 0) {
      order.status = OrderStatus.FILLED;
    } else if (order.remainingAmount < order.amount) {
      order.status = OrderStatus.PARTIALLY_FILLED;
    }
    
    return trades;
  }
  
  _getCachedPriceLevels(orderType) {
    const cacheKey = `${orderType}_${Date.now() / 100}`; // Cache for 100ms
    
    if (this.priceCache.has(cacheKey)) {
      return this.priceCache.get(cacheKey);
    }
    
    const orders = orderType === OrderType.BUY 
      ? this.orderBook.buyOrders 
      : this.orderBook.sellOrders;
    
    // Group by price level
    const priceLevelMap = new Map();
    for (const order of orders) {
      if (!priceLevelMap.has(order.price)) {
        priceLevelMap.set(order.price, []);
      }
      priceLevelMap.get(order.price).push(order);
    }
    
    // Convert to sorted array
    const priceLevels = Array.from(priceLevelMap.entries())
      .map(([price, orders]) => ({ price, orders }))
      .sort((a, b) => orderType === OrderType.BUY ? b.price - a.price : a.price - b.price);
    
    // Cache result
    this.priceCache.set(cacheKey, priceLevels);
    
    // Clear old cache entries
    if (this.priceCache.size > 100) {
      const oldestKey = this.priceCache.keys().next().value;
      this.priceCache.delete(oldestKey);
    }
    
    return priceLevels;
  }
  
  _canMatchFast(order, oppositeOrder) {
    // Fast path checks
    if (oppositeOrder.status !== OrderStatus.OPEN) return false;
    if (oppositeOrder.remainingAmount <= 0) return false;
    
    // Price check based on order type
    if (order.type === OrderType.BUY) {
      return order.price >= oppositeOrder.price;
    } else {
      return order.price <= oppositeOrder.price;
    }
  }
  
  _executeTradeOptimized(buyOrder, sellOrder) {
    const matchPrice = sellOrder.timestamp < buyOrder.timestamp 
      ? sellOrder.price 
      : buyOrder.price;
    
    const matchAmount = Math.min(buyOrder.remainingAmount, sellOrder.remainingAmount);
    
    if (matchAmount <= 0) return null;
    
    // Update order amounts (no allocation)
    buyOrder.remainingAmount -= matchAmount;
    sellOrder.remainingAmount -= matchAmount;
    buyOrder.filledAmount += matchAmount;
    sellOrder.filledAmount += matchAmount;
    
    // Get trade object from pool
    const trade = this._getTrade();
    trade.id = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    trade.buyOrderId = buyOrder.id;
    trade.sellOrderId = sellOrder.id;
    trade.buyUserId = buyOrder.userId;
    trade.sellUserId = sellOrder.userId;
    trade.price = matchPrice;
    trade.amount = matchAmount;
    trade.timestamp = Date.now();
    trade.fee = matchAmount * matchPrice * this.feeRate;
    
    return trade;
  }
  
  getMetrics() {
    return {
      ...this.metrics,
      queueLength: this.matchQueue.length,
      cacheSize: this.priceCache.size
    };
  }
}

export default OptimizedMatchingEngine;