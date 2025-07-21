/**
 * DEX Trading Pair Implementation
 * Manages individual trading pairs with liquidity pools
 */

import { EventEmitter } from 'events';
import { OrderBook } from './order-book.js';
import { MatchingEngine } from './matching-engine.js';

export class DexPair extends EventEmitter {
  constructor(baseCurrency, quoteCurrency, options = {}) {
    super();
    
    this.baseCurrency = baseCurrency;
    this.quoteCurrency = quoteCurrency;
    this.symbol = `${baseCurrency}/${quoteCurrency}`;
    
    // Initialize order book
    this.orderBook = new OrderBook(baseCurrency, quoteCurrency);
    
    // Initialize matching engine
    this.matchingEngine = new MatchingEngine(this.orderBook, {
      algorithm: options.matchingAlgorithm,
      feeRate: options.feeRate || 0.001,
      minOrderSize: options.minOrderSize || 0.00001,
      maxOrderSize: options.maxOrderSize || 1000000
    });
    
    // Liquidity pool for AMM
    this.liquidityPool = {
      baseReserve: options.initialBaseReserve || 0,
      quoteReserve: options.initialQuoteReserve || 0,
      totalShares: 0,
      providers: new Map(), // address -> shares
      k: 0 // Constant product
    };
    
    // Trading statistics
    this.stats = {
      volume24h: 0,
      high24h: 0,
      low24h: Infinity,
      lastPrice: 0,
      priceChange24h: 0,
      trades24h: 0,
      openInterest: 0
    };
    
    // Price history
    this.priceHistory = [];
    this.volumeHistory = [];
    
    // Setup event listeners
    this.setupEventListeners();
    
    // Start periodic tasks
    this.startPeriodicTasks();
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Forward events from order book and matching engine
    this.orderBook.on('orderAdded', (order) => {
      this.emit('orderAdded', { pair: this.symbol, order });
    });
    
    this.orderBook.on('orderCancelled', (order) => {
      this.emit('orderCancelled', { pair: this.symbol, order });
    });
    
    this.matchingEngine.on('trade', (trade) => {
      this.updateStats(trade);
      this.emit('trade', { pair: this.symbol, trade });
    });
  }

  /**
   * Start periodic tasks
   */
  startPeriodicTasks() {
    // Update 24h stats every minute
    this.statsInterval = setInterval(() => {
      this.update24hStats();
    }, 60000);
    
    // Clean up expired orders every 5 minutes
    this.cleanupInterval = setInterval(() => {
      const cleaned = this.orderBook.cleanupExpiredOrders();
      if (cleaned > 0) {
        this.emit('ordersExpired', { pair: this.symbol, count: cleaned });
      }
    }, 300000);
  }

  /**
   * Place an order
   */
  async placeOrder(orderParams) {
    // Validate order parameters
    if (!this.validateOrderParams(orderParams)) {
      throw new Error('Invalid order parameters');
    }
    
    // Add pair information
    orderParams.pair = this.symbol;
    orderParams.baseCurrency = this.baseCurrency;
    orderParams.quoteCurrency = this.quoteCurrency;
    
    // Match order
    const trades = await this.matchingEngine.matchOrder(orderParams);
    
    return {
      order: orderParams,
      trades,
      filled: orderParams.filledAmount,
      remaining: orderParams.remainingAmount
    };
  }

  /**
   * Cancel an order
   */
  cancelOrder(orderId, userId) {
    const order = this.orderBook.getOrder(orderId);
    
    if (!order) {
      throw new Error('Order not found');
    }
    
    if (order.userId !== userId) {
      throw new Error('Unauthorized to cancel this order');
    }
    
    return this.orderBook.cancelOrder(orderId);
  }

  /**
   * Add liquidity to AMM pool
   */
  addLiquidity(baseAmount, quoteAmount, providerId) {
    if (baseAmount <= 0 || quoteAmount <= 0) {
      throw new Error('Invalid liquidity amounts');
    }
    
    const pool = this.liquidityPool;
    let shares;
    
    if (pool.totalShares === 0) {
      // First liquidity provider
      shares = Math.sqrt(baseAmount * quoteAmount);
      pool.k = baseAmount * quoteAmount;
    } else {
      // Calculate shares based on current pool ratio
      const baseShare = (baseAmount / pool.baseReserve) * pool.totalShares;
      const quoteShare = (quoteAmount / pool.quoteReserve) * pool.totalShares;
      shares = Math.min(baseShare, quoteShare);
    }
    
    // Update pool
    pool.baseReserve += baseAmount;
    pool.quoteReserve += quoteAmount;
    pool.totalShares += shares;
    
    // Update provider shares
    const currentShares = pool.providers.get(providerId) || 0;
    pool.providers.set(providerId, currentShares + shares);
    
    // Update constant
    pool.k = pool.baseReserve * pool.quoteReserve;
    
    this.emit('liquidityAdded', {
      pair: this.symbol,
      providerId,
      baseAmount,
      quoteAmount,
      shares
    });
    
    return { shares, poolShare: shares / pool.totalShares };
  }

  /**
   * Remove liquidity from AMM pool
   */
  removeLiquidity(shares, providerId) {
    const pool = this.liquidityPool;
    const providerShares = pool.providers.get(providerId) || 0;
    
    if (shares > providerShares) {
      throw new Error('Insufficient shares');
    }
    
    const shareRatio = shares / pool.totalShares;
    const baseAmount = pool.baseReserve * shareRatio;
    const quoteAmount = pool.quoteReserve * shareRatio;
    
    // Update pool
    pool.baseReserve -= baseAmount;
    pool.quoteReserve -= quoteAmount;
    pool.totalShares -= shares;
    
    // Update provider shares
    pool.providers.set(providerId, providerShares - shares);
    
    // Update constant
    pool.k = pool.baseReserve * pool.quoteReserve;
    
    this.emit('liquidityRemoved', {
      pair: this.symbol,
      providerId,
      baseAmount,
      quoteAmount,
      shares
    });
    
    return { baseAmount, quoteAmount };
  }

  /**
   * Get AMM quote for swap
   */
  getAMMQuote(inputAmount, inputCurrency) {
    const pool = this.liquidityPool;
    
    if (pool.baseReserve === 0 || pool.quoteReserve === 0) {
      return null; // No liquidity
    }
    
    const isBaseInput = inputCurrency === this.baseCurrency;
    const inputReserve = isBaseInput ? pool.baseReserve : pool.quoteReserve;
    const outputReserve = isBaseInput ? pool.quoteReserve : pool.baseReserve;
    
    // Calculate output using constant product formula
    // (x + dx) * (y - dy) = k
    // dy = y - k/(x + dx)
    const outputAmount = outputReserve - (pool.k / (inputReserve + inputAmount));
    
    // Calculate price impact
    const spotPrice = outputReserve / inputReserve;
    const executionPrice = outputAmount / inputAmount;
    const priceImpact = Math.abs((executionPrice - spotPrice) / spotPrice) * 100;
    
    return {
      inputAmount,
      outputAmount,
      executionPrice,
      priceImpact,
      fee: inputAmount * this.matchingEngine.feeRate
    };
  }

  /**
   * Get market depth
   */
  getMarketDepth(levels = 20) {
    return this.orderBook.getDepth(levels);
  }

  /**
   * Get order book snapshot
   */
  getOrderBookSnapshot() {
    return {
      symbol: this.symbol,
      bids: this.orderBook.buyOrders.slice(0, 50).map(o => ({
        price: o.price,
        amount: o.remainingAmount,
        total: o.price * o.remainingAmount
      })),
      asks: this.orderBook.sellOrders.slice(0, 50).map(o => ({
        price: o.price,
        amount: o.remainingAmount,
        total: o.price * o.remainingAmount
      })),
      timestamp: Date.now()
    };
  }

  /**
   * Update trading statistics
   */
  updateStats(trade) {
    const now = Date.now();
    
    // Update last price
    this.stats.lastPrice = trade.price;
    
    // Update 24h high/low
    if (trade.price > this.stats.high24h || this.stats.high24h === 0) {
      this.stats.high24h = trade.price;
    }
    if (trade.price < this.stats.low24h) {
      this.stats.low24h = trade.price;
    }
    
    // Add to price history
    this.priceHistory.push({
      price: trade.price,
      volume: trade.amount,
      timestamp: now
    });
    
    // Keep only last 24h of history
    const cutoff = now - 24 * 60 * 60 * 1000;
    this.priceHistory = this.priceHistory.filter(p => p.timestamp > cutoff);
  }

  /**
   * Update 24h statistics
   */
  update24hStats() {
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    
    // Calculate 24h volume
    this.stats.volume24h = this.priceHistory
      .filter(p => p.timestamp > cutoff)
      .reduce((sum, p) => sum + p.volume * p.price, 0);
    
    // Calculate 24h trades
    this.stats.trades24h = this.priceHistory.filter(p => p.timestamp > cutoff).length;
    
    // Calculate price change
    const oldestPrice = this.priceHistory.find(p => p.timestamp > cutoff)?.price;
    if (oldestPrice && this.stats.lastPrice) {
      this.stats.priceChange24h = ((this.stats.lastPrice - oldestPrice) / oldestPrice) * 100;
    }
    
    // Calculate open interest
    this.stats.openInterest = 
      this.orderBook.buyOrders.reduce((sum, o) => sum + o.remainingAmount * o.price, 0) +
      this.orderBook.sellOrders.reduce((sum, o) => sum + o.remainingAmount * o.price, 0);
  }

  /**
   * Validate order parameters
   */
  validateOrderParams(params) {
    if (!params.type || !params.amount || !params.userId) {
      return false;
    }
    
    if (params.amount < this.matchingEngine.minOrderSize || 
        params.amount > this.matchingEngine.maxOrderSize) {
      return false;
    }
    
    if (params.orderType === 'LIMIT' && !params.price) {
      return false;
    }
    
    return true;
  }

  /**
   * Get pair information
   */
  getInfo() {
    return {
      symbol: this.symbol,
      baseCurrency: this.baseCurrency,
      quoteCurrency: this.quoteCurrency,
      stats: this.stats,
      orderBook: this.orderBook.getStats(),
      liquidityPool: {
        baseReserve: this.liquidityPool.baseReserve,
        quoteReserve: this.liquidityPool.quoteReserve,
        totalShares: this.liquidityPool.totalShares,
        price: this.liquidityPool.quoteReserve / this.liquidityPool.baseReserve
      },
      fees: {
        taker: this.matchingEngine.feeRate,
        maker: this.matchingEngine.feeRate * 0.5 // 50% discount for makers
      }
    };
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.removeAllListeners();
  }
}