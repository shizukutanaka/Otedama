/**
 * Base Order Book Implementation
 * Consolidates common functionality shared across all order book implementations
 * 
 * Design principles:
 * - Carmack: Efficient data structures for high-performance trading
 * - Martin: Clean interface with extensible architecture
 * - Pike: Simple, reliable order management
 */

import { EventEmitter } from 'events';
import { BigNumber } from 'ethers';
import { OrderType, OrderSide, OrderStatus, OrderUtils, validateOrder } from '../utils/order-validation.js';
import { calculateSpread, PriceFormatter } from '../utils/price-calculations.js';

/**
 * Base Order class used across all order book implementations
 */
export class Order {
  constructor(params) {
    this.id = params.id || OrderUtils.generateOrderId();
    this.userId = params.userId;
    this.symbol = params.symbol;
    this.side = params.side;
    this.type = params.type;
    this.amount = BigNumber.from(params.amount);
    this.price = params.price ? BigNumber.from(params.price) : null;
    this.stopPrice = params.stopPrice ? BigNumber.from(params.stopPrice) : null;
    this.filledAmount = BigNumber.from(0);
    this.status = OrderStatus.PENDING;
    this.createdAt = params.createdAt || Date.now();
    this.updatedAt = Date.now();
    this.timeInForce = params.timeInForce || 'GTC'; // Good Till Cancel
    this.metadata = params.metadata || {};
  }
  
  /**
   * Fill order with specified amount
   */
  fill(amount, price) {
    const fillAmount = BigNumber.from(amount);
    const fillPrice = BigNumber.from(price);
    
    if (fillAmount.lte(0)) {
      throw new Error('Fill amount must be positive');
    }
    
    const remainingAmount = this.getRemainingAmount();
    if (fillAmount.gt(remainingAmount)) {
      throw new Error('Fill amount exceeds remaining order amount');
    }
    
    this.filledAmount = this.filledAmount.add(fillAmount);
    this.updatedAt = Date.now();
    
    // Update status
    if (this.filledAmount.gte(this.amount)) {
      this.status = OrderStatus.FILLED;
    } else if (this.filledAmount.gt(0)) {
      this.status = OrderStatus.PARTIALLY_FILLED;
    }
    
    return {
      orderId: this.id,
      fillAmount,
      fillPrice,
      remainingAmount: this.getRemainingAmount(),
      isFilled: this.isFilled()
    };
  }
  
  /**
   * Cancel order
   */
  cancel() {
    if (this.status === OrderStatus.FILLED) {
      throw new Error('Cannot cancel filled order');
    }
    
    this.status = OrderStatus.CANCELLED;
    this.updatedAt = Date.now();
  }
  
  /**
   * Check if order is completely filled
   */
  isFilled() {
    return this.status === OrderStatus.FILLED || this.filledAmount.gte(this.amount);
  }
  
  /**
   * Check if order is partially filled
   */
  isPartiallyFilled() {
    return this.filledAmount.gt(0) && this.filledAmount.lt(this.amount);
  }
  
  /**
   * Get remaining amount to fill
   */
  getRemainingAmount() {
    return this.amount.sub(this.filledAmount);
  }
  
  /**
   * Check if order can match with another order
   */
  canMatchWith(otherOrder) {
    if (this.side === otherOrder.side) return false;
    if (this.symbol !== otherOrder.symbol) return false;
    if (!this.price || !otherOrder.price) return false;
    
    if (this.side === OrderSide.BUY) {
      return this.price.gte(otherOrder.price);
    } else {
      return this.price.lte(otherOrder.price);
    }
  }
  
  /**
   * Convert order to plain object
   */
  toJSON() {
    return {
      id: this.id,
      userId: this.userId,
      symbol: this.symbol,
      side: this.side,
      type: this.type,
      amount: this.amount.toString(),
      price: this.price ? this.price.toString() : null,
      stopPrice: this.stopPrice ? this.stopPrice.toString() : null,
      filledAmount: this.filledAmount.toString(),
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      timeInForce: this.timeInForce,
      metadata: this.metadata
    };
  }
}

/**
 * Base Order Book class with common functionality
 */
export class BaseOrderBook extends EventEmitter {
  constructor(symbol, options = {}) {
    super();
    
    this.symbol = symbol;
    this.options = {
      maxOrders: options.maxOrders || 10000,
      maxPriceLevels: options.maxPriceLevels || 1000,
      enableStatistics: options.enableStatistics !== false,
      enableEvents: options.enableEvents !== false,
      ...options
    };
    
    // Subclasses should initialize these data structures
    this.bids = null;
    this.asks = null;
    this.orders = new Map();
    
    // Shared statistics
    this.stats = {
      totalOrders: 0,
      activeOrders: 0,
      totalVolume: BigNumber.from(0),
      totalTrades: 0,
      bestBid: null,
      bestAsk: null,
      spread: null,
      lastPrice: null,
      lastTradeTime: null,
      createdAt: Date.now()
    };
    
    // Order tracking
    this.ordersByUser = new Map();
    this.priceIndex = new Map(); // price -> orders at that price
    
    this.lastUpdateTime = Date.now();
  }
  
  /**
   * Add order to the book (to be implemented by subclasses)
   */
  addOrder(orderParams) {
    throw new Error('addOrder must be implemented by subclass');
  }
  
  /**
   * Remove order from the book (to be implemented by subclasses)
   */
  removeOrder(orderId) {
    throw new Error('removeOrder must be implemented by subclass');
  }
  
  /**
   * Get best bid (highest buy price)
   */
  getBestBid() {
    throw new Error('getBestBid must be implemented by subclass');
  }
  
  /**
   * Get best ask (lowest sell price)
   */
  getBestAsk() {
    throw new Error('getBestAsk must be implemented by subclass');
  }
  
  /**
   * Shared order validation logic
   */
  validateOrder(orderParams) {
    const validation = validateOrder(orderParams);
    if (!validation.isValid) {
      throw new Error(`Order validation failed: ${validation.errors.map(e => e.message).join(', ')}`);
    }
  }
  
  /**
   * Create and validate order object
   */
  createOrder(orderParams) {
    this.validateOrder(orderParams);
    return new Order(orderParams);
  }
  
  /**
   * Track order by user
   */
  trackOrderByUser(order) {
    if (!this.ordersByUser.has(order.userId)) {
      this.ordersByUser.set(order.userId, new Set());
    }
    this.ordersByUser.get(order.userId).add(order.id);
  }
  
  /**
   * Untrack order by user
   */
  untrackOrderByUser(order) {
    const userOrders = this.ordersByUser.get(order.userId);
    if (userOrders) {
      userOrders.delete(order.id);
      if (userOrders.size === 0) {
        this.ordersByUser.delete(order.userId);
      }
    }
  }
  
  /**
   * Get orders by user
   */
  getOrdersByUser(userId) {
    const orderIds = this.ordersByUser.get(userId);
    if (!orderIds) return [];
    
    return Array.from(orderIds)
      .map(id => this.orders.get(id))
      .filter(order => order); // Filter out any undefined orders
  }
  
  /**
   * Update statistics after order operations
   */
  updateStats() {
    if (!this.options.enableStatistics) return;
    
    this.stats.activeOrders = this.orders.size;
    this.stats.bestBid = this.getBestBid();
    this.stats.bestAsk = this.getBestAsk();
    
    if (this.stats.bestBid && this.stats.bestAsk) {
      this.stats.spread = calculateSpread(this.stats.bestBid, this.stats.bestAsk);
    }
    
    this.lastUpdateTime = Date.now();
  }
  
  /**
   * Record trade execution
   */
  recordTrade(trade) {
    if (!this.options.enableStatistics) return;
    
    this.stats.totalTrades++;
    this.stats.totalVolume = this.stats.totalVolume.add(trade.amount);
    this.stats.lastPrice = trade.price;
    this.stats.lastTradeTime = Date.now();
    
    if (this.options.enableEvents) {
      this.emit('trade', trade);
    }
  }
  
  /**
   * Get order book depth
   */
  getDepth(levels = 10) {
    const depth = {
      symbol: this.symbol,
      bids: [],
      asks: [],
      timestamp: Date.now()
    };
    
    // To be implemented by subclasses based on their data structure
    return depth;
  }
  
  /**
   * Get order book statistics
   */
  getStats() {
    return {
      ...this.stats,
      spread: this.stats.spread ? PriceFormatter.formatPercentage(this.stats.spread) : null,
      lastPrice: this.stats.lastPrice ? this.stats.lastPrice.toString() : null,
      totalVolume: this.stats.totalVolume.toString(),
      uptime: Date.now() - this.stats.createdAt,
      lastUpdate: this.lastUpdateTime
    };
  }
  
  /**
   * Get order by ID
   */
  getOrder(orderId) {
    return this.orders.get(orderId);
  }
  
  /**
   * Cancel order
   */
  cancelOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }
    
    order.cancel();
    this.removeOrder(orderId);
    
    if (this.options.enableEvents) {
      this.emit('orderCancelled', order);
    }
    
    return order;
  }
  
  /**
   * Cancel all orders for a user
   */
  cancelAllOrdersForUser(userId) {
    const userOrders = this.getOrdersByUser(userId);
    const cancelledOrders = [];
    
    for (const order of userOrders) {
      try {
        this.cancelOrder(order.id);
        cancelledOrders.push(order);
      } catch (error) {
        console.error(`Failed to cancel order ${order.id}:`, error.message);
      }
    }
    
    return cancelledOrders;
  }
  
  /**
   * Get price levels summary
   */
  getPriceLevels() {
    return {
      bidLevels: this.getBidLevels(),
      askLevels: this.getAskLevels(),
      timestamp: Date.now()
    };
  }
  
  /**
   * Get bid levels (to be implemented by subclasses)
   */
  getBidLevels() {
    return [];
  }
  
  /**
   * Get ask levels (to be implemented by subclasses)
   */
  getAskLevels() {
    return [];
  }
  
  /**
   * Clear all orders
   */
  clear() {
    this.orders.clear();
    this.ordersByUser.clear();
    this.priceIndex.clear();
    
    // Subclasses should clear their specific data structures
    this.clearDataStructures();
    
    this.updateStats();
    
    if (this.options.enableEvents) {
      this.emit('cleared');
    }
  }
  
  /**
   * Clear implementation-specific data structures (to be implemented by subclasses)
   */
  clearDataStructures() {
    // To be implemented by subclasses
  }
  
  /**
   * Shutdown order book
   */
  shutdown() {
    this.clear();
    this.removeAllListeners();
    
    if (this.options.enableEvents) {
      this.emit('shutdown');
    }
  }
  
  /**
   * Export order book state
   */
  exportState() {
    return {
      symbol: this.symbol,
      options: this.options,
      orders: Array.from(this.orders.values()).map(order => order.toJSON()),
      stats: this.getStats(),
      timestamp: Date.now()
    };
  }
  
  /**
   * Import order book state
   */
  importState(state) {
    this.clear();
    
    if (state.symbol !== this.symbol) {
      throw new Error('State symbol does not match order book symbol');
    }
    
    // Restore orders
    for (const orderData of state.orders) {
      const order = new Order(orderData);
      this.addOrder(order);
    }
    
    this.updateStats();
  }
}

export default {
  Order,
  BaseOrderBook,
  OrderType,
  OrderSide,
  OrderStatus,
  OrderUtils
};