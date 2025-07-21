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

  // Order class functionality now provided by shared base/base-order-book.js
}

/**
 * Standard Order Book using shared base class and utilities
 * Extends BaseOrderBook to eliminate code duplication
 */
export class OrderBook extends BaseOrderBook {
  constructor(baseCurrency, quoteCurrency, options = {}) {
    const symbol = `${baseCurrency}/${quoteCurrency}`;
    super(symbol, options);
    
    // Get configuration for compatibility with existing code
    const config = getDexConfig(options.environment || process.env.NODE_ENV || 'development');
    
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
    
    // Validate configuration
    const configErrors = validateDexConfig(config);
    if (configErrors.length > 0) {
      throw new OtedamaError(
        `Invalid DEX configuration: ${configErrors.join(', ')}`,
        ErrorCategory.VALIDATION,
        { errors: configErrors }
      );
    }
    
    // Store additional properties for compatibility
    this.baseCurrency = baseCurrency;
    this.quoteCurrency = quoteCurrency;
    this.errorHandler = getErrorHandler();
    
    // Initialize data structures (using arrays for this standard implementation)
    this.buyOrders = [];  // Sorted by price descending, then by timestamp
    this.sellOrders = []; // Sorted by price ascending, then by timestamp
    this.bids = this.buyOrders; // Alias for base class compatibility
    this.asks = this.sellOrders; // Alias for base class compatibility
    
    // Additional optimized lookups
    this.pricePoints = new Map(); // Price -> Orders at that price
    this.ordersByPrice = new Map(); // Optimized price-based lookup
    
    // Initialize matching engine with shared utilities
    this.matchingEngine = new BaseMatchingEngine({
      strategy: MatchingStrategy.PRICE_TIME,
      feeConfig: {
        makerFee: this.pairConfig.feeRate * 0.5, // Maker gets discount
        takerFee: this.pairConfig.feeRate
      },
      useObjectPool: true
    });
    
    // Trading state (keeping for compatibility)
    this.lastTradePrice = null;
    this.spread = 0;
    this.midPrice = 0;
    
    // Backward compatibility metrics (stats now in base class)
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
  /**
   * Add order implementation (overrides base class)
   * Now uses shared validation and base class functionality
   */
  addOrder(params) {
    // Create order using shared base class functionality
    const order = this.createOrder(params);
    
    // Store in order map (base class handles orders Map)
    this.orders.set(order.id, order);
    this.trackOrderByUser(order);
    
    // Add to appropriate side using existing optimized insertion
    if (order.side === OrderSide.BUY) {
      this.insertBuyOrder(order);
    } else {
      this.insertSellOrder(order);
    }
    
    // Update price points tracking
    this.updatePricePoint(order);
    
    // Update statistics using base class
    this.stats.totalOrders++;
    this.updateStats();
    
    // Emit event if enabled
    if (this.options.enableEvents) {
      this.emit('orderAdded', order);
    }
    
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
   * Remove order implementation (overrides base class)
   */
  removeOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) {
      return false;
    }
    
    // Remove from appropriate order array
    if (order.side === OrderSide.BUY) {
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
    
    // Clean up price point tracking
    const priceOrders = this.pricePoints.get(order.price);
    if (priceOrders) {
      priceOrders.delete(orderId);
      if (priceOrders.size === 0) {
        this.pricePoints.delete(order.price);
      }
    }
    
    // Remove from base class maps
    this.orders.delete(orderId);
    this.untrackOrderByUser(order);
    
    return true;
  }

  /**
   * Get best bid implementation (required by base class)
   */
  getBestBid() {
    return this.buyOrders.length > 0 ? this.buyOrders[0].price : null;
  }
  
  /**
   * Get best ask implementation (required by base class)
   */
  getBestAsk() {
    return this.sellOrders.length > 0 ? this.sellOrders[0].price : null;
  }
  
  /**
   * Clear data structures implementation (required by base class)
   */
  clearDataStructures() {
    this.buyOrders.length = 0;
    this.sellOrders.length = 0;
    this.pricePoints.clear();
    this.ordersByPrice.clear();
  }
  
  /**
   * Get bid orders for matching engine
   */
  getBidOrders() {
    return this.buyOrders;
  }
  
  /**
   * Get ask orders for matching engine
   */
  getAskOrders() {
    return this.sellOrders;
  }
  
  /**
   * Process order with matching using shared matching engine
   * This demonstrates how code duplication has been eliminated
   */
  processOrder(params) {
    // Add order to book
    const incomingOrder = this.addOrder(params);
    
    // Attempt to match using shared matching engine
    const matchResult = this.matchingEngine.matchOrders(incomingOrder, this);
    
    // Process trade executions
    for (const execution of matchResult.executions) {
      this.recordTrade(execution);
      
      // Emit trade event for compatibility
      if (this.options.enableEvents) {
        this.emit('trade', execution);
      }
    }
    
    // Update legacy metrics for backward compatibility
    this.metrics.totalTrades += matchResult.executions.length;
    this.metrics.totalVolume += matchResult.executions.reduce(
      (sum, trade) => sum + parseFloat(trade.getValue().toString()), 0
    );
    
    // If order was not fully matched, it remains in the book
    return {
      order: incomingOrder,
      executions: matchResult.executions,
      remainingOrder: matchResult.remainingOrder,
      matchTime: matchResult.matchTime
    };
  }
  
  /**
   * Get order book depth using base class functionality
   */
  getDepth(levels = 10) {
    const depth = {
      symbol: this.symbol,
      bids: [],
      asks: [],
      timestamp: Date.now()
    };
    
    // Aggregate bid levels
    let bidIndex = 0;
    let currentBidPrice = null;
    let currentBidAmount = 0;
    
    for (const order of this.buyOrders) {
      if (bidIndex >= levels) break;
      
      if (currentBidPrice === null || !order.price.eq(currentBidPrice)) {
        if (currentBidPrice !== null) {
          depth.bids.push({
            price: currentBidPrice.toString(),
            amount: currentBidAmount.toString(),
            orders: 1
          });
          bidIndex++;
        }
        currentBidPrice = order.price;
        currentBidAmount = order.getRemainingAmount();
      } else {
        currentBidAmount = currentBidAmount.add(order.getRemainingAmount());
      }
    }
    
    // Add final bid level
    if (currentBidPrice !== null && bidIndex < levels) {
      depth.bids.push({
        price: currentBidPrice.toString(),
        amount: currentBidAmount.toString(),
        orders: 1
      });
    }
    
    // Aggregate ask levels
    let askIndex = 0;
    let currentAskPrice = null;
    let currentAskAmount = 0;
    
    for (const order of this.sellOrders) {
      if (askIndex >= levels) break;
      
      if (currentAskPrice === null || !order.price.eq(currentAskPrice)) {
        if (currentAskPrice !== null) {
          depth.asks.push({
            price: currentAskPrice.toString(),
            amount: currentAskAmount.toString(),
            orders: 1
          });
          askIndex++;
        }
        currentAskPrice = order.price;
        currentAskAmount = order.getRemainingAmount();
      } else {
        currentAskAmount = currentAskAmount.add(order.getRemainingAmount());
      }
    }
    
    // Add final ask level
    if (currentAskPrice !== null && askIndex < levels) {
      depth.asks.push({
        price: currentAskPrice.toString(),
        amount: currentAskAmount.toString(),
        orders: 1
      });
    }
    
    return depth;
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
  /**
   * Custom validation for this order book implementation
   * Extends base class validation with pair-specific rules
   */
  validateOrder(orderParams) {
    try {
      // Use shared validation from base class first
      super.validateOrder(orderParams);
      
      // Additional pair-specific validation
      const order = typeof orderParams.amount === 'string' ? orderParams : {
        ...orderParams,
        amount: orderParams.amount?.toString(),
        price: orderParams.price?.toString()
      };
      
      // Validate minimum order size
      if (parseFloat(order.amount) < this.pairConfig.minOrderSize) {
        throw new Error(`Order amount below minimum: ${this.pairConfig.minOrderSize}`);
      }
      
      // Validate maximum order size
      if (parseFloat(order.amount) > this.pairConfig.maxOrderSize) {
        throw new Error(`Order amount exceeds maximum: ${this.pairConfig.maxOrderSize}`);
      }
      
      // Validate tick size (price precision) for limit orders
      if (order.price && order.type === OrderType.LIMIT) {
        const price = parseFloat(order.price);
        if (price % this.pairConfig.tickSize !== 0) {
          throw new Error(`Price must be multiple of tick size: ${this.pairConfig.tickSize}`);
        }
      }
      
      // Validate lot size (amount precision)
      if (parseFloat(order.amount) % this.pairConfig.lotSize !== 0) {
        throw new Error(`Amount must be multiple of lot size: ${this.pairConfig.lotSize}`);
      }
      
      // Check user order limits
      const userOrders = this.getOrdersByUser(order.userId);
      if (userOrders.length >= (this.options.maxOrdersPerUser || 100)) {
        throw new Error('User order limit exceeded');
      }
      
      return true;
      
    } catch (error) {
      this.errorHandler?.handleError(error, {
        service: 'order-book',
        category: ErrorCategory.VALIDATION,
        orderId: orderParams.id
      });
      throw error;
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