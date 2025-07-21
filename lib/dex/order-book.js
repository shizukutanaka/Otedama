/**
 * Order Book Implementation for Otedama DEX
 * Manages buy and sell orders with efficient matching
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { getErrorHandler, OtedamaError, ErrorCategory, safeExecute } from '../error-handler.js';
import { getDexConfig, validateDexConfig, getTradingPairConfig } from './dex-config.js';

// Order types
export const OrderType = {
  BUY: 'BUY',
  SELL: 'SELL',
  LIMIT: 'LIMIT',
  MARKET: 'MARKET',
  STOP: 'STOP',
  STOP_LIMIT: 'STOP_LIMIT',
  ICEBERG: 'ICEBERG'
};

// Order status
export const OrderStatus = {
  OPEN: 'OPEN',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  REJECTED: 'REJECTED'
};

export class Order {
  constructor(params) {
    this.id = params.id || crypto.randomUUID();
    this.type = params.type;
    this.side = params.side || params.type; // BUY or SELL
    this.price = params.price;
    this.amount = params.amount;
    this.filledAmount = params.filledAmount || 0;
    this.remainingAmount = params.amount;
    this.userId = params.userId;
    this.status = params.status || OrderStatus.OPEN;
    this.timestamp = params.timestamp || Date.now();
    this.expiresAt = params.expiresAt;
    this.metadata = params.metadata || {};
  }

  get isFilled() {
    return this.filledAmount >= this.amount;
  }

  get isPartiallyFilled() {
    return this.filledAmount > 0 && this.filledAmount < this.amount;
  }

  fill(amount) {
    const fillAmount = Math.min(amount, this.remainingAmount);
    this.filledAmount += fillAmount;
    this.remainingAmount -= fillAmount;
    
    if (this.isFilled) {
      this.status = OrderStatus.FILLED;
    } else if (this.isPartiallyFilled) {
      this.status = OrderStatus.PARTIALLY_FILLED;
    }
    
    return fillAmount;
  }

  cancel() {
    if (this.status === OrderStatus.OPEN || this.status === OrderStatus.PARTIALLY_FILLED) {
      this.status = OrderStatus.CANCELLED;
      return true;
    }
    return false;
  }
}

export class OrderBook extends EventEmitter {
  constructor(baseCurrency, quoteCurrency, options = {}) {
    super();
    
    // Get configuration
    const config = getDexConfig(options.environment || process.env.NODE_ENV || 'development');
    const symbol = `${baseCurrency}/${quoteCurrency}`;
    
    try {
      const pairConfig = getTradingPairConfig(symbol);
      this.pairConfig = pairConfig;
    } catch (error) {
      // Use default configuration if pair not found
      this.pairConfig = {
        baseCurrency,
        quoteCurrency,
        tickSize: 0.00000001,
        lotSize: 0.00001,
        minOrderSize: config.trading.minOrderSize,
        maxOrderSize: config.trading.maxOrderSize,
        feeRate: config.trading.feeRate,
        enabled: true
      };
    }
    
    // Merge with user options
    this.options = {
      ...config.orderBook,
      ...options
    };
    
    // Validate configuration
    const configErrors = validateDexConfig(config);
    if (configErrors.length > 0) {
      throw new OtedamaError(
        `Invalid DEX configuration: ${configErrors.join(', ')}`,
        ErrorCategory.VALIDATION,
        { errors: configErrors }
      );
    }
    
    this.baseCurrency = baseCurrency;
    this.quoteCurrency = quoteCurrency;
    this.symbol = symbol;
    this.errorHandler = getErrorHandler();
    
    // Order storage with optimized data structures
    this.buyOrders = [];  // Sorted by price descending, then by timestamp
    this.sellOrders = []; // Sorted by price ascending, then by timestamp
    this.orderMap = new Map(); // For O(1) order lookup
    this.userOrders = new Map(); // User ID -> Order IDs
    this.pricePoints = new Map(); // Price -> Orders at that price
    this.ordersByPrice = new Map(); // Optimized price-based lookup
    
    // Trading state
    this.lastTradePrice = null;
    this.lastUpdateTime = Date.now();
    this.spread = 0;
    this.midPrice = 0;
    
    // Performance metrics
    this.metrics = {
      totalOrders: 0,
      activeOrders: 0,
      totalTrades: 0,
      totalVolume: 0,
      avgSpread: 0,
      depth: { bids: 0, asks: 0 },
      updateLatency: 0
    };
    
    // Caching for performance
    this.snapshotCache = null;
    this.lastSnapshotTime = 0;
    
    // Initialize optimization features
    this.initializeOptimizations();
  }

  /**
   * Initialize optimization features
   */
  initializeOptimizations() {
    // Start periodic cleanup of expired orders
    if (this.options.enableCaching) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupExpiredOrders();
      }, 60000); // Every minute
    }
    
    // Start periodic metrics update
    if (this.options.enableMetrics) {
      this.metricsInterval = setInterval(() => {
        this.updateMetrics();
      }, 10000); // Every 10 seconds
    }
    
    // Start periodic snapshot updates
    if (this.options.enableRealTimeUpdates) {
      this.snapshotInterval = setInterval(() => {
        this.updateSnapshot();
      }, this.options.snapshotInterval);
    }
  }

  /**
   * Add a new order to the book
   */
  addOrder(params) {
    const order = new Order(params);
    
    // Validate order
    if (!this.validateOrder(order)) {
      throw new Error('Invalid order parameters');
    }
    
    // Add to order map
    this.orderMap.set(order.id, order);
    
    // Add to user orders
    if (!this.userOrders.has(order.userId)) {
      this.userOrders.set(order.userId, new Set());
    }
    this.userOrders.get(order.userId).add(order.id);
    
    // Add to appropriate side
    if (order.type === OrderType.BUY) {
      this.insertBuyOrder(order);
    } else {
      this.insertSellOrder(order);
    }
    
    // Update price points
    this.updatePricePoint(order);
    
    // Emit event
    this.emit('orderAdded', order);
    this.lastUpdateTime = Date.now();
    
    return order;
  }

  /**
   * Insert buy order in sorted position
   */
  insertBuyOrder(order) {
    // Binary search for insertion point
    let left = 0;
    let right = this.buyOrders.length;
    
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.buyOrders[mid].price > order.price) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    
    this.buyOrders.splice(left, 0, order);
  }

  /**
   * Insert sell order in sorted position
   */
  insertSellOrder(order) {
    // Binary search for insertion point
    let left = 0;
    let right = this.sellOrders.length;
    
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.sellOrders[mid].price < order.price) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    
    this.sellOrders.splice(left, 0, order);
  }

  /**
   * Update price point tracking
   */
  updatePricePoint(order) {
    if (!this.pricePoints.has(order.price)) {
      this.pricePoints.set(order.price, new Set());
    }
    this.pricePoints.get(order.price).add(order.id);
  }

  /**
   * Cancel an order
   */
  cancelOrder(orderId) {
    const order = this.orderMap.get(orderId);
    if (!order) {
      return false;
    }
    
    if (order.cancel()) {
      // Remove from order book
      if (order.type === OrderType.BUY) {
        const index = this.buyOrders.findIndex(o => o.id === orderId);
        if (index !== -1) {
          this.buyOrders.splice(index, 1);
        }
      } else {
        const index = this.sellOrders.findIndex(o => o.id === orderId);
        if (index !== -1) {
          this.sellOrders.splice(index, 1);
        }
      }
      
      // Clean up price point
      const priceOrders = this.pricePoints.get(order.price);
      if (priceOrders) {
        priceOrders.delete(orderId);
        if (priceOrders.size === 0) {
          this.pricePoints.delete(order.price);
        }
      }
      
      // Emit event
      this.emit('orderCancelled', order);
      this.lastUpdateTime = Date.now();
      
      return true;
    }
    
    return false;
  }

  /**
   * Get order by ID
   */
  getOrder(orderId) {
    return this.orderMap.get(orderId);
  }

  /**
   * Get orders for a user
   */
  getUserOrders(userId, status = null) {
    const orderIds = this.userOrders.get(userId);
    if (!orderIds) {
      return [];
    }
    
    const orders = Array.from(orderIds)
      .map(id => this.orderMap.get(id))
      .filter(order => order && (!status || order.status === status));
    
    return orders;
  }

  /**
   * Get best bid (highest buy price)
   */
  getBestBid() {
    return this.buyOrders.length > 0 ? this.buyOrders[0] : null;
  }

  /**
   * Get best ask (lowest sell price)
   */
  getBestAsk() {
    return this.sellOrders.length > 0 ? this.sellOrders[0] : null;
  }

  /**
   * Get spread
   */
  getSpread() {
    const bestBid = this.getBestBid();
    const bestAsk = this.getBestAsk();
    
    if (!bestBid || !bestAsk) {
      return null;
    }
    
    return {
      absolute: bestAsk.price - bestBid.price,
      percentage: ((bestAsk.price - bestBid.price) / bestAsk.price) * 100
    };
  }

  /**
   * Get market depth
   */
  getDepth(levels = 10) {
    const depth = {
      bids: [],
      asks: [],
      timestamp: Date.now()
    };
    
    // Aggregate bids by price level
    const bidLevels = new Map();
    for (const order of this.buyOrders) {
      if (!bidLevels.has(order.price)) {
        bidLevels.set(order.price, { price: order.price, amount: 0, count: 0 });
      }
      const level = bidLevels.get(order.price);
      level.amount += order.remainingAmount;
      level.count++;
      
      if (bidLevels.size >= levels) break;
    }
    
    // Aggregate asks by price level
    const askLevels = new Map();
    for (const order of this.sellOrders) {
      if (!askLevels.has(order.price)) {
        askLevels.set(order.price, { price: order.price, amount: 0, count: 0 });
      }
      const level = askLevels.get(order.price);
      level.amount += order.remainingAmount;
      level.count++;
      
      if (askLevels.size >= levels) break;
    }
    
    depth.bids = Array.from(bidLevels.values());
    depth.asks = Array.from(askLevels.values());
    
    return depth;
  }

  /**
   * Validate order parameters
   */
  validateOrder(order) {
    try {
      // Basic validation
      if (!order.type || !order.userId) {
        return false;
      }
      
      // Validate order type
      if (!Object.values(OrderType).includes(order.type)) {
        return false;
      }
      
      // Market orders don't need price validation
      if (order.type === OrderType.MARKET) {
        return order.amount > 0 && order.amount >= this.pairConfig.minOrderSize;
      }
      
      // Validate price and amount
      if (!order.price || !order.amount) {
        return false;
      }
      
      if (order.price <= 0 || order.amount <= 0) {
        return false;
      }
      
      // Validate minimum order size
      if (order.amount < this.pairConfig.minOrderSize) {
        return false;
      }
      
      // Validate maximum order size
      if (order.amount > this.pairConfig.maxOrderSize) {
        return false;
      }
      
      // Validate tick size (price precision)
      if (order.price % this.pairConfig.tickSize !== 0) {
        return false;
      }
      
      // Validate lot size (amount precision)
      if (order.amount % this.pairConfig.lotSize !== 0) {
        return false;
      }
      
      // Check user order limits
      const userOrderCount = this.userOrders.get(order.userId)?.size || 0;
      if (userOrderCount >= this.options.maxOrdersPerUser) {
        return false;
      }
      
      return true;
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'order-book',
        category: ErrorCategory.VALIDATION,
        orderId: order.id
      });
      return false;
    }
  }

  /**
   * Get order book statistics
   */
  getStats() {
    return {
      buyOrders: this.buyOrders.length,
      sellOrders: this.sellOrders.length,
      totalOrders: this.orderMap.size,
      bestBid: this.getBestBid()?.price,
      bestAsk: this.getBestAsk()?.price,
      spread: this.getSpread(),
      lastTradePrice: this.lastTradePrice,
      lastUpdateTime: this.lastUpdateTime,
      pricePoints: this.pricePoints.size
    };
  }

  /**
   * Clean up expired orders
   */
  cleanupExpiredOrders() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [orderId, order] of this.orderMap) {
      if (order.expiresAt && order.expiresAt < now && order.status === OrderStatus.OPEN) {
        order.status = OrderStatus.EXPIRED;
        this.cancelOrder(orderId);
        cleaned++;
      }
    }
    
    return cleaned;
  }
}