/**
 * Consolidated DEX System for Otedama
 * 
 * This module provides a unified interface to all DEX functionality,
 * consolidating multiple engine implementations into one coherent solution.
 * 
 * Design principles:
 * - Carmack: High-performance order matching with minimal overhead
 * - Martin: Clean separation of concerns and interfaces
 * - Pike: Simple and powerful API
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { getLogger } from '../core/logger.js';
import { inc, observe, set } from '../monitoring/index.js';
import { getValidator, CommonSchemas } from '../validation/comprehensive-validator.js';
import { getCryptoUtils } from '../crypto/crypto-utils.js';
import { getErrorHandler, ErrorUtils, ErrorCategory } from '../core/standardized-error-handler.js';

// Import the best components from various implementations
import { DEXEngineV2 } from './engine-v2.js';
import { ZeroCopyOrderBook } from './zero-copy-order-book.js';
import { LockFreeOrderBook } from './lock-free-order-book.js';
import { BatchMatchingEngine } from './batch-matching-engine.js';
import { AMMEngine } from './amm-engine.js';
import { AdvancedOrderManager } from './advanced-orders.js';
import { LiquidityAggregator } from './liquidity-aggregator.js';
import { CrossChainBridge } from './cross-chain-bridge.js';
import { MEVProtection } from './mev-protection.js';
import { FlashLoanManager } from './flash-loan-manager.js';
import { OptimizedOrderBook } from './optimized-order-book.js';

// Unified order types (single source of truth)
export const OrderType = {
  // Basic order types
  MARKET: 'market',
  LIMIT: 'limit',
  STOP: 'stop',
  STOP_LIMIT: 'stop_limit',
  
  // Advanced order types
  ICEBERG: 'iceberg',
  TWAP: 'twap',
  VWAP: 'vwap',
  TRAILING_STOP: 'trailing_stop',
  ONE_CANCELS_OTHER: 'oco',
  FILL_OR_KILL: 'fok',
  IMMEDIATE_OR_CANCEL: 'ioc',
  GOOD_TILL_TIME: 'gtt',
  GOOD_TILL_DATE: 'gtd',
  BRACKET: 'bracket',
  PEGGED: 'pegged',
  CONDITIONAL: 'conditional'
};

// Unified order side
export const OrderSide = {
  BUY: 'buy',
  SELL: 'sell'
};

// Unified order status
export const OrderStatus = {
  PENDING: 'pending',
  OPEN: 'open',
  PARTIAL: 'partial',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  REJECTED: 'rejected',
  SUSPENDED: 'suspended'
};

// Performance modes for order book
export const PerformanceMode = {
  STANDARD: 'standard',      // Balanced performance
  ZERO_COPY: 'zero_copy',    // Maximum throughput
  LOCK_FREE: 'lock_free',    // Maximum concurrency
  BATCH: 'batch'             // Batch processing mode
};

// Liquidity sources
export const LiquiditySource = {
  ORDER_BOOK: 'order_book',
  AMM_POOL: 'amm_pool',
  CROSS_CHAIN: 'cross_chain',
  AGGREGATED: 'aggregated'
};

/**
 * Consolidated DEX Engine
 * Combines the best features from all DEX implementations
 */
export class ConsolidatedDEXEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.logger = getLogger('ConsolidatedDEXEngine');
    this.validator = getValidator({
      enableSecurityValidation: true,
      enableTimingSafeComparison: true
    });
    this.crypto = getCryptoUtils();
    
    this.options = {
      // Performance settings
      performanceMode: options.performanceMode || PerformanceMode.STANDARD,
      batchSize: options.batchSize || 100,
      maxOrdersPerUser: options.maxOrdersPerUser || 100,
      
      // Features
      enableAdvancedOrders: options.enableAdvancedOrders !== false,
      enableLiquidityAggregation: options.enableLiquidityAggregation !== false,
      enableCrossChain: options.enableCrossChain !== false,
      enableMEVProtection: options.enableMEVProtection !== false,
      enableFlashLoans: options.enableFlashLoans !== false,
      
      // Fees
      makerFee: options.makerFee || 0.001, // 0.1%
      takerFee: options.takerFee || 0.002, // 0.2%
      flashLoanFee: options.flashLoanFee || 0.0009, // 0.09%
      
      ...options
    };
    
    // Core components
    this.orderBooks = new Map(); // pair -> OrderBook
    this.matchingEngine = null;
    this.advancedOrderManager = null;
    this.liquidityAggregator = null;
    this.crossChainBridge = null;
    this.mevProtection = null;
    this.flashLoanManager = null;
    
    // State
    this.initialized = false;
    this.tradingPairs = new Map();
    this.users = new Map();
    
    // Statistics
    this.stats = {
      totalOrders: 0,
      totalTrades: 0,
      totalVolume: 0,
      totalFees: 0,
      avgMatchTime: 0,
      peakOrdersPerSecond: 0
    };
  }

  /**
   * Initialize the DEX engine
   */
  async initialize() {
    if (this.initialized) return;
    
    this.logger.info('Initializing Consolidated DEX Engine...');
    
    // Initialize order books for all trading pairs
    this.orderBooks = new Map();
    
    // Initialize matching engine based on performance mode
    switch (this.options.performanceMode) {
      case PerformanceMode.ZERO_COPY:
        this.OrderBookClass = ZeroCopyOrderBook;
        break;
      case PerformanceMode.LOCK_FREE:
        this.OrderBookClass = LockFreeOrderBook;
        break;
      case PerformanceMode.BATCH:
        this.matchingEngine = new BatchMatchingEngine({
          batchSize: this.options.batchSize
        });
        this.OrderBookClass = OptimizedOrderBook;
        break;
      default:
        // Use optimized order book for standard mode
        this.OrderBookClass = OptimizedOrderBook;
    }
    
    // Initialize advanced components if enabled
    if (this.options.enableAdvancedOrders) {
      this.advancedOrderManager = new AdvancedOrderManager();
      await this.advancedOrderManager.initialize();
    }
    
    if (this.options.enableLiquidityAggregation) {
      this.liquidityAggregator = new LiquidityAggregator({
        enableCaching: true,
        cacheTimeout: 1000
      });
    }
    
    if (this.options.enableCrossChain) {
      this.crossChainBridge = new CrossChainBridge();
      await this.crossChainBridge.initialize();
    }
    
    if (this.options.enableMEVProtection) {
      this.mevProtection = new MEVProtection({
        delayWindow: 1000,
        commitRevealEnabled: true
      });
    }
    
    if (this.options.enableFlashLoans) {
      this.flashLoanManager = new FlashLoanManager({
        maxLoanAmount: 1000000,
        fee: this.options.flashLoanFee
      });
    }
    
    // Initialize default trading pairs
    this.initializeTradingPairs();
    
    this.initialized = true;
    this.emit('initialized');
    
    this.logger.info('DEX Engine initialized successfully');
  }

  /**
   * Initialize trading pairs
   */
  initializeTradingPairs() {
    const pairs = [
      { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', tickSize: 0.01, minOrderSize: 0.00001 },
      { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', tickSize: 0.01, minOrderSize: 0.001 },
      { symbol: 'ETH/BTC', base: 'ETH', quote: 'BTC', tickSize: 0.000001, minOrderSize: 0.001 },
      { symbol: 'BNB/USDT', base: 'BNB', quote: 'USDT', tickSize: 0.01, minOrderSize: 0.01 },
      { symbol: 'SOL/USDT', base: 'SOL', quote: 'USDT', tickSize: 0.01, minOrderSize: 0.1 },
      { symbol: 'MATIC/USDT', base: 'MATIC', quote: 'USDT', tickSize: 0.0001, minOrderSize: 1 }
    ];
    
    for (const pair of pairs) {
      this.addTradingPair(pair);
    }
  }

  /**
   * Add a trading pair
   */
  addTradingPair(config) {
    const { symbol, base, quote, tickSize, minOrderSize } = config;
    
    this.tradingPairs.set(symbol, {
      symbol,
      base,
      quote,
      tickSize,
      minOrderSize,
      active: true,
      volume24h: 0,
      high24h: 0,
      low24h: 0,
      lastPrice: 0
    });

    // Create optimized order book for this pair
    const orderBook = new this.OrderBookClass(symbol, {
      tickSize,
      minOrderSize,
      maxPriceLevels: this.options.maxPriceLevels || 1000
    });
    
    this.orderBooks.set(symbol, orderBook);
    
    this.emit('trading_pair:added', { symbol, base, quote });
  }

  /**
   * Get order book for a trading pair
   */
  getOrderBook(symbol) {
    return this.orderBooks.get(symbol);
  }

  /**
   * Place an order - now using optimized order book
   */
  async placeOrder(params) {
    const startTime = performance.now();
    
    try {
      // Comprehensive validation using the new validator
      const validationResult = this.validator.validateObject(params, {
        ...CommonSchemas.order,
        userId: { type: 'string', required: true, minLength: 1 }
      });
      
      if (validationResult.hasErrors()) {
        const firstError = validationResult.getFirstError();
        throw ErrorUtils.validation(`Order validation failed: ${firstError.message}`, {
          field: firstError.field,
          value: firstError.value,
          validationErrors: validationResult.getAllErrors()
        });
      }
      
      // Apply MEV protection if enabled
      if (this.mevProtection && params.type === OrderType.MARKET) {
        await this.mevProtection.protectOrder(params);
      }
      
      // Generate order ID
      const orderId = this.generateOrderId();
      
      // Get order book for this trading pair
      const orderBook = this.getOrderBook(params.symbol);
      if (!orderBook) {
        throw ErrorUtils.validation(`Trading pair ${params.symbol} not found`, {
          symbol: params.symbol,
          availablePairs: Array.from(this.tradingPairs.keys())
        });
      }
      
      // Create order object
      const order = {
        id: orderId,
        userId: params.userId,
        symbol: params.symbol,
        type: params.type,
        side: params.side,
        price: params.price || 0,
        quantity: params.quantity,
        filledQuantity: 0,
        remainingQuantity: params.quantity,
        status: OrderStatus.PENDING,
        timestamp: Date.now(),
        ...params
      };
      
      // Handle advanced orders
      if (this.advancedOrderManager && this.isAdvancedOrder(order.type)) {
        const result = await this.advancedOrderManager.addOrder(order);
        inc('dex_advanced_orders_total', { type: order.type });
        return result;
      }
      
      // Process order using optimized order book
      let result;
      if (this.options.performanceMode === PerformanceMode.BATCH) {
        // Add to batch processing engine
        result = await this.matchingEngine.addOrder(order);
      } else {
        // Use optimized order book for direct matching
        if (order.type === OrderType.MARKET || order.type === OrderType.LIMIT) {
          // Try to match against existing orders
          const matchResult = orderBook.matchOrder(order);
          
          if (matchResult.matches.length > 0) {
            // Process trades
            for (const match of matchResult.matches) {
              this.processTrade(match);
            }
            
            // Update order status
            order.filledQuantity = order.quantity - matchResult.remainingQuantity;
            order.remainingQuantity = matchResult.remainingQuantity;
            order.status = matchResult.fullyMatched ? OrderStatus.FILLED : 
                          order.filledQuantity > 0 ? OrderStatus.PARTIAL : OrderStatus.OPEN;
          }
          
          // Add remaining quantity to book if it's a limit order and not fully matched
          if (order.type === OrderType.LIMIT && order.remainingQuantity > 0) {
            orderBook.addOrder(order);
            order.status = order.filledQuantity > 0 ? OrderStatus.PARTIAL : OrderStatus.OPEN;
          }
          
          result = {
            order,
            matches: matchResult.matches,
            status: order.status
          };
        } else {
          // For other order types, use existing logic
          result = await this.matchOrder(order, orderBook);
        }
      }
      
      // Update statistics
      this.stats.totalOrders++;
      inc('dex_orders_total', { 
        symbol: order.symbol, 
        type: order.type, 
        side: order.side 
      });
      
      const matchTime = performance.now() - startTime;
      observe('dex_order_processing_time', {}, matchTime / 1000);
      
      this.emit('order:placed', result);
      
      return result;
      
    } catch (error) {
      this.logger.error('Order placement failed:', error);
      inc('dex_orders_failed_total', { reason: 'processing_error' });
      throw error;
    }
  }

  /**
   * Process a trade match
   */
  processTrade(match) {
    // Update trading pair statistics
    const pair = this.tradingPairs.get(match.symbol);
    if (pair) {
      pair.lastPrice = match.price;
      pair.volume24h += match.quantity;
      
      if (match.price > pair.high24h || pair.high24h === 0) {
        pair.high24h = match.price;
      }
      if (match.price < pair.low24h || pair.low24h === 0) {
        pair.low24h = match.price;
      }
    }
    
    // Update global statistics
    this.stats.totalTrades++;
    this.stats.totalVolume += match.quantity * match.price;
    
    // Emit trade event
    this.emit('trade', {
      id: match.matchId,
      symbol: match.symbol,
      price: match.price,
      quantity: match.quantity,
      timestamp: match.timestamp,
      buyerId: match.takerOrder.side === 'buy' ? match.takerOrder.userId : match.makerOrder.userId,
      sellerId: match.takerOrder.side === 'sell' ? match.takerOrder.userId : match.makerOrder.userId
    });
    
    // Record metrics
    inc('dex_trades_total', { symbol: match.symbol });
    observe('dex_trade_size', { symbol: match.symbol }, match.quantity);
    observe('dex_trade_value', { symbol: match.symbol }, match.quantity * match.price);
  }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId, userId) {
    try {
      // Find order across all order books using optimized method
      for (const [symbol, orderBook] of this.orderBooks) {
        const order = orderBook.getOrder(orderId);
        if (order && order.userId === userId) {
          // Use optimized order book removal - O(log n)
          const removedOrder = orderBook.removeOrder(orderId);
          
          if (removedOrder) {
            // Update order status
            removedOrder.status = OrderStatus.CANCELLED;
            removedOrder.cancelledAt = Date.now();
            
            inc('dex_orders_cancelled_total', { symbol });
            this.emit('order:cancelled', { orderId, symbol });
            
            return { success: true, order: removedOrder };
          }
        }
      }
      
      // Check advanced orders
      if (this.advancedOrderManager) {
        const result = await this.advancedOrderManager.cancelOrder(orderId);
        if (result.success) {
          return result;
        }
      }
      
      throw ErrorUtils.validation('Order not found', { orderId, userId });
      
    } catch (error) {
      this.logger.error('Order cancellation failed:', error);
      throw error;
    }
  }

  /**
   * Get order book for a symbol
   */
  getOrderBook(symbol, depth = 20) {
    const orderBook = this.orderBooks.get(symbol);
    if (!orderBook) {
      throw ErrorUtils.validation(`Trading pair ${symbol} not found`, {
        symbol,
        availablePairs: Array.from(this.tradingPairs.keys())
      });
    }
    
    // Handle different order book implementations
    if (orderBook.getDepth) {
      // Zero-copy or lock-free order book
      return orderBook.getDepth(depth);
    }
    
    // Standard order book
    const bids = [];
    const asks = [];
    
    // Convert bids map to array and sort
    for (const [price, level] of orderBook.bids) {
      bids.push({
        price: parseFloat(price),
        quantity: level.totalQuantity,
        orders: level.orders.length
      });
    }
    bids.sort((a, b) => b.price - a.price).slice(0, depth);
    
    // Convert asks map to array and sort
    for (const [price, level] of orderBook.asks) {
      asks.push({
        price: parseFloat(price),
        quantity: level.totalQuantity,
        orders: level.orders.length
      });
    }
    asks.sort((a, b) => a.price - b.price).slice(0, depth);
    
    return {
      symbol,
      bids: bids.slice(0, depth),
      asks: asks.slice(0, depth),
      timestamp: Date.now()
    };
  }

  /**
   * Get best bid and ask
   */
  getBestBidAsk(symbol) {
    const orderBook = this.orderBooks.get(symbol);
    if (!orderBook) {
      throw ErrorUtils.validation(`Trading pair ${symbol} not found`, {
        symbol,
        availablePairs: Array.from(this.tradingPairs.keys())
      });
    }
    
    if (orderBook.getBestBidAsk) {
      return orderBook.getBestBidAsk();
    }
    
    // Find best bid (highest price)
    let bestBid = null;
    for (const [price, level] of orderBook.bids) {
      if (!bestBid || parseFloat(price) > bestBid.price) {
        bestBid = { price: parseFloat(price), quantity: level.totalQuantity };
      }
    }
    
    // Find best ask (lowest price)
    let bestAsk = null;
    for (const [price, level] of orderBook.asks) {
      if (!bestAsk || parseFloat(price) < bestAsk.price) {
        bestAsk = { price: parseFloat(price), quantity: level.totalQuantity };
      }
    }
    
    return { bid: bestBid, ask: bestAsk, spread: bestAsk && bestBid ? bestAsk.price - bestBid.price : null };
  }

  /**
   * Get aggregated liquidity
   */
  async getAggregatedLiquidity(symbol, side, quantity) {
    if (!this.liquidityAggregator) {
      throw ErrorUtils.validation('Liquidity aggregation not enabled', {
        feature: 'liquidityAggregation',
        enabled: this.options.enableLiquidityAggregation
      });
    }
    
    return this.liquidityAggregator.findBestRoute({
      symbol,
      side,
      quantity,
      sources: [LiquiditySource.ORDER_BOOK, LiquiditySource.AMM_POOL]
    });
  }

  /**
   * Execute a flash loan
   */
  async executeFlashLoan(params) {
    if (!this.flashLoanManager) {
      throw ErrorUtils.validation('Flash loans not enabled', {
        feature: 'flashLoans',
        enabled: this.options.enableFlashLoans
      });
    }
    
    return this.flashLoanManager.executeLoan({
      asset: params.asset,
      amount: params.amount,
      callback: params.callback,
      data: params.data
    });
  }

  /**
   * Match an order against the order book
   */
  async matchOrder(order, orderBook) {
    const trades = [];
    const { symbol, side, type, price, quantity } = order;
    
    // Get opposite side of order book
    const oppositeSide = side === OrderSide.BUY ? orderBook.asks : orderBook.bids;
    
    // Market order - match at any price
    if (type === OrderType.MARKET) {
      let remainingQty = quantity;
      
      // Sort price levels (ascending for asks, descending for bids)
      const priceLevels = Array.from(oppositeSide.entries())
        .sort((a, b) => side === OrderSide.BUY ? a[0] - b[0] : b[0] - a[0]);
      
      for (const [levelPrice, level] of priceLevels) {
        if (remainingQty <= 0) break;
        
        for (const oppositeOrder of level.orders) {
          if (remainingQty <= 0) break;
          
          const matchQty = Math.min(remainingQty, oppositeOrder.remainingQuantity);
          
          // Create trade
          const trade = {
            id: this.generateTradeId(),
            symbol,
            price: parseFloat(levelPrice),
            quantity: matchQty,
            buyOrderId: side === OrderSide.BUY ? order.id : oppositeOrder.id,
            sellOrderId: side === OrderSide.SELL ? order.id : oppositeOrder.id,
            buyerId: side === OrderSide.BUY ? order.userId : oppositeOrder.userId,
            sellerId: side === OrderSide.SELL ? order.userId : oppositeOrder.userId,
            timestamp: Date.now()
          };
          
          trades.push(trade);
          
          // Update quantities
          remainingQty -= matchQty;
          oppositeOrder.remainingQuantity -= matchQty;
          oppositeOrder.filledQuantity += matchQty;
          
          // Update opposite order status
          if (oppositeOrder.remainingQuantity === 0) {
            oppositeOrder.status = OrderStatus.FILLED;
          } else {
            oppositeOrder.status = OrderStatus.PARTIAL;
          }
        }
        
        // Remove filled orders from level
        level.orders = level.orders.filter(o => o.remainingQuantity > 0);
        level.totalQuantity = level.orders.reduce((sum, o) => sum + o.remainingQuantity, 0);
      }
      
      // Update order
      order.filledQuantity = quantity - remainingQty;
      order.remainingQuantity = remainingQty;
      order.status = remainingQty === 0 ? OrderStatus.FILLED : 
                     remainingQty < quantity ? OrderStatus.PARTIAL : 
                     OrderStatus.OPEN;
    }
    
    // Limit order - add to book if not fully matched
    else if (type === OrderType.LIMIT) {
      // Try to match first
      let remainingQty = quantity;
      
      for (const [levelPrice, level] of oppositeSide) {
        const numPrice = parseFloat(levelPrice);
        
        // Check if price matches
        if ((side === OrderSide.BUY && numPrice > price) ||
            (side === OrderSide.SELL && numPrice < price)) {
          break;
        }
        
        for (const oppositeOrder of level.orders) {
          if (remainingQty <= 0) break;
          
          const matchQty = Math.min(remainingQty, oppositeOrder.remainingQuantity);
          
          // Create trade
          const trade = {
            id: this.generateTradeId(),
            symbol,
            price: numPrice,
            quantity: matchQty,
            buyOrderId: side === OrderSide.BUY ? order.id : oppositeOrder.id,
            sellOrderId: side === OrderSide.SELL ? order.id : oppositeOrder.id,
            buyerId: side === OrderSide.BUY ? order.userId : oppositeOrder.userId,
            sellerId: side === OrderSide.SELL ? order.userId : oppositeOrder.userId,
            timestamp: Date.now()
          };
          
          trades.push(trade);
          
          // Update quantities
          remainingQty -= matchQty;
          oppositeOrder.remainingQuantity -= matchQty;
          oppositeOrder.filledQuantity += matchQty;
          
          // Update opposite order status
          if (oppositeOrder.remainingQuantity === 0) {
            oppositeOrder.status = OrderStatus.FILLED;
          } else {
            oppositeOrder.status = OrderStatus.PARTIAL;
          }
        }
      }
      
      // Add remaining to order book
      if (remainingQty > 0) {
        const orderSide = side === OrderSide.BUY ? orderBook.bids : orderBook.asks;
        const priceStr = price.toString();
        
        if (!orderSide.has(priceStr)) {
          orderSide.set(priceStr, {
            orders: [],
            totalQuantity: 0
          });
        }
        
        const level = orderSide.get(priceStr);
        order.remainingQuantity = remainingQty;
        order.filledQuantity = quantity - remainingQty;
        order.status = order.filledQuantity > 0 ? OrderStatus.PARTIAL : OrderStatus.OPEN;
        
        level.orders.push(order);
        level.totalQuantity += remainingQty;
        
        // Add to order lookup
        orderBook.orders.set(order.id, order);
      } else {
        order.status = OrderStatus.FILLED;
        order.filledQuantity = quantity;
        order.remainingQuantity = 0;
      }
    }
    
    // Process trades
    for (const trade of trades) {
      await this.processTrade(trade);
    }
    
    // Update statistics
    if (trades.length > 0) {
      const totalVolume = trades.reduce((sum, t) => sum + (t.price * t.quantity), 0);
      this.stats.totalTrades += trades.length;
      this.stats.totalVolume += totalVolume;
      
      set('dex_volume_total', { symbol }, this.stats.totalVolume);
      inc('dex_trades_total', { symbol }, trades.length);
    }
    
    return {
      order,
      trades,
      status: order.status
    };
  }

  /**
   * Process a trade
   */
  async processTrade(trade) {
    // Calculate fees
    const buyerFee = trade.quantity * trade.price * this.options.takerFee;
    const sellerFee = trade.quantity * trade.price * this.options.makerFee;
    
    trade.buyerFee = buyerFee;
    trade.sellerFee = sellerFee;
    
    // Update trading pair stats
    const pair = this.tradingPairs.get(trade.symbol);
    if (pair) {
      pair.lastPrice = trade.price;
      pair.volume24h += trade.quantity * trade.price;
      
      if (!pair.high24h || trade.price > pair.high24h) {
        pair.high24h = trade.price;
      }
      if (!pair.low24h || trade.price < pair.low24h) {
        pair.low24h = trade.price;
      }
    }
    
    // Emit trade event
    this.emit('trade', trade);
    
    // Record metrics
    observe('dex_trade_size', { symbol: trade.symbol }, trade.quantity);
    observe('dex_trade_value', { symbol: trade.symbol }, trade.quantity * trade.price);
    
    this.stats.totalFees += buyerFee + sellerFee;
  }

  /**
   * Validate order parameters
   */
  validateOrder(params) {
    const { userId, symbol, type, side, price, quantity } = params;
    
    // Check required fields
    if (!userId || !symbol || !type || !side || !quantity) {
      return { valid: false, error: 'Missing required fields' };
    }
    
    // Check trading pair exists
    const pair = this.tradingPairs.get(symbol);
    if (!pair || !pair.active) {
      return { valid: false, error: 'Invalid or inactive trading pair' };
    }
    
    // Validate order type
    if (!Object.values(OrderType).includes(type)) {
      return { valid: false, error: 'Invalid order type' };
    }
    
    // Validate side
    if (!Object.values(OrderSide).includes(side)) {
      return { valid: false, error: 'Invalid order side' };
    }
    
    // Validate quantity
    if (quantity <= 0 || quantity < pair.minOrderSize) {
      return { valid: false, error: 'Invalid order quantity' };
    }
    
    // Validate price for limit orders
    if (type === OrderType.LIMIT && (!price || price <= 0)) {
      return { valid: false, error: 'Invalid price for limit order' };
    }
    
    // Check user order limit
    const userOrders = this.getUserActiveOrders(userId);
    if (userOrders.length >= this.options.maxOrdersPerUser) {
      return { valid: false, error: 'Maximum orders per user exceeded' };
    }
    
    return { valid: true };
  }

  /**
   * Get user's active orders
   */
  getUserActiveOrders(userId) {
    const orders = [];
    
    for (const orderBook of this.orderBooks.values()) {
      if (orderBook.orders) {
        for (const order of orderBook.orders.values()) {
          if (order.userId === userId && 
              [OrderStatus.OPEN, OrderStatus.PARTIAL].includes(order.status)) {
            orders.push(order);
          }
        }
      }
    }
    
    return orders;
  }

  /**
   * Check if order type is advanced
   */
  isAdvancedOrder(type) {
    return [
      OrderType.ICEBERG,
      OrderType.TWAP,
      OrderType.VWAP,
      OrderType.TRAILING_STOP,
      OrderType.ONE_CANCELS_OTHER,
      OrderType.BRACKET,
      OrderType.CONDITIONAL
    ].includes(type);
  }

  /**
   * Generate order ID
   */
  generateOrderId() {
    return `O${Date.now()}${this.crypto.randomBytes(4, 'hex').toUpperCase()}`;
  }

  /**
   * Generate trade ID
   */
  generateTradeId() {
    return `T${Date.now()}${this.crypto.randomBytes(4, 'hex').toUpperCase()}`;
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      tradingPairs: this.tradingPairs.size,
      activeOrders: this.getActiveOrderCount(),
      orderBooks: this.orderBooks.size
    };
  }

  /**
   * Get active order count
   */
  getActiveOrderCount() {
    let count = 0;
    
    for (const orderBook of this.orderBooks.values()) {
      if (orderBook.orders) {
        for (const order of orderBook.orders.values()) {
          if ([OrderStatus.OPEN, OrderStatus.PARTIAL].includes(order.status)) {
            count++;
          }
        }
      }
    }
    
    return count;
  }

  /**
   * Shutdown the engine
   */
  async shutdown() {
    this.logger.info('Shutting down DEX engine...');
    
    // Stop components
    if (this.advancedOrderManager) {
      await this.advancedOrderManager.stop();
    }
    
    if (this.crossChainBridge) {
      await this.crossChainBridge.stop();
    }
    
    if (this.matchingEngine) {
      await this.matchingEngine.stop();
    }
    
    // Clear data
    this.orderBooks.clear();
    this.tradingPairs.clear();
    this.users.clear();
    
    this.initialized = false;
    this.emit('shutdown');
  }
}

// Create singleton instance
let dexInstance = null;

/**
 * Get or create DEX instance
 */
export function getDEX(options = {}) {
  if (!dexInstance) {
    dexInstance = new ConsolidatedDEXEngine(options);
    
    // Auto-initialize if not disabled
    if (options.autoInitialize !== false) {
      dexInstance.initialize().catch(error => {
        console.error('Failed to initialize DEX:', error);
      });
    }
  }
  
  return dexInstance;
}

// Convenience exports
export const dex = getDEX();

// Direct method exports for compatibility
export const placeOrder = (params) => dex.placeOrder(params);
export const cancelOrder = (orderId, userId) => dex.cancelOrder(orderId, userId);
export const getOrderBook = (symbol, depth) => dex.getOrderBook(symbol, depth);
export const getBestBidAsk = (symbol) => dex.getBestBidAsk(symbol);

// Re-export commonly used classes
export { 
  AMMEngine,
  CrossChainBridge,
  FlashLoanManager,
  MEVProtection
};

// Default export
export default ConsolidatedDEXEngine;