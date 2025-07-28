/**
 * Multi-Currency Automatic Exchange System - Otedama
 * Automatically exchanges mined cryptocurrencies to preferred currencies
 * 
 * Design: Robert C. Martin - Clean financial transaction handling
 * Performance: John Carmack - Fast execution for time-sensitive trades
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { CryptoUtils } from '../security/crypto-utils.js';
import { AuditLogger, AuditEventType } from '../core/audit-logger.js';

const logger = createStructuredLogger('AutoExchanger');

/**
 * Exchange strategies
 */
export const ExchangeStrategy = {
  IMMEDIATE: 'immediate',          // Exchange as soon as threshold reached
  SCHEDULED: 'scheduled',          // Exchange at specific times
  PRICE_TRIGGERED: 'price_triggered', // Exchange when price conditions met
  ACCUMULATE: 'accumulate',        // Accumulate then exchange in bulk
  SMART: 'smart'                   // AI-based optimal timing
};

/**
 * Supported exchanges (mockup)
 */
export const SupportedExchange = {
  INTERNAL: 'internal',            // Internal exchange for testing
  BINANCE: 'binance',
  COINBASE: 'coinbase',
  KRAKEN: 'kraken',
  UNISWAP: 'uniswap'
};

/**
 * Order types
 */
export const OrderType = {
  MARKET: 'market',
  LIMIT: 'limit',
  STOP_LOSS: 'stop_loss',
  TAKE_PROFIT: 'take_profit'
};

/**
 * Multi-Currency Auto Exchanger
 */
export class AutoExchanger extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      strategy: config.strategy || ExchangeStrategy.SMART,
      defaultExchange: config.defaultExchange || SupportedExchange.INTERNAL,
      minExchangeAmount: config.minExchangeAmount || 0.001,
      maxSlippage: config.maxSlippage || 2, // 2% max slippage
      priceCheckInterval: config.priceCheckInterval || 60000, // 1 minute
      retryAttempts: config.retryAttempts || 3,
      retryDelay: config.retryDelay || 5000,
      enabledExchanges: config.enabledExchanges || [SupportedExchange.INTERNAL],
      ...config
    };
    
    // Audit logger
    this.auditLogger = config.auditLogger;
    
    // Exchange configurations
    this.exchangeConfigs = new Map();
    this.exchangeClients = new Map();
    
    // User preferences
    this.userPreferences = new Map();
    
    // Pending exchanges
    this.pendingExchanges = new Map();
    this.exchangeQueue = [];
    
    // Price data
    this.priceData = new Map();
    this.priceHistory = new Map();
    
    // Statistics
    this.stats = {
      totalExchanges: 0,
      successfulExchanges: 0,
      failedExchanges: 0,
      totalVolumeExchanged: new Map(),
      totalFeesP
aid: 0,
      averageSlippage: 0,
      profitLoss: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize exchanger
   */
  async initialize() {
    // Initialize exchange clients
    for (const exchange of this.config.enabledExchanges) {
      await this.initializeExchange(exchange);
    }
    
    // Start price monitoring
    this.startPriceMonitoring();
    
    // Start exchange processor
    this.startExchangeProcessor();
    
    logger.info('Auto exchanger initialized', {
      strategy: this.config.strategy,
      exchanges: this.config.enabledExchanges
    });
  }
  
  /**
   * Set user exchange preferences
   */
  setUserPreferences(userId, preferences) {
    const validatedPrefs = {
      userId,
      targetCurrency: preferences.targetCurrency || 'USDT',
      exchangeStrategy: preferences.exchangeStrategy || this.config.strategy,
      minAmount: preferences.minAmount || this.config.minExchangeAmount,
      maxSlippage: preferences.maxSlippage || this.config.maxSlippage,
      preferredExchanges: preferences.preferredExchanges || this.config.enabledExchanges,
      autoExchangeEnabled: preferences.autoExchangeEnabled !== false,
      priceAlerts: preferences.priceAlerts || [],
      addresses: preferences.addresses || {},
      limits: {
        daily: preferences.limits?.daily || null,
        monthly: preferences.limits?.monthly || null
      }
    };
    
    this.userPreferences.set(userId, validatedPrefs);
    
    logger.info('User preferences set', {
      userId,
      targetCurrency: validatedPrefs.targetCurrency
    });
    
    // Audit log
    if (this.auditLogger) {
      this.auditLogger.logEvent({
        type: AuditEventType.CONFIG_CHANGED,
        userId,
        resource: 'exchange_preferences',
        data: { preferences: validatedPrefs }
      });
    }
    
    return validatedPrefs;
  }
  
  /**
   * Queue automatic exchange
   */
  async queueExchange(userId, sourceCurrency, amount, options = {}) {
    const preferences = this.userPreferences.get(userId);
    if (!preferences || !preferences.autoExchangeEnabled) {
      logger.debug('Auto exchange not enabled for user', { userId });
      return null;
    }
    
    // Check minimum amount
    if (amount < preferences.minAmount) {
      logger.debug('Amount below minimum threshold', {
        userId,
        amount,
        minimum: preferences.minAmount
      });
      return null;
    }
    
    // Check daily/monthly limits
    if (!this.checkUserLimits(userId, amount, sourceCurrency)) {
      logger.warn('User exchange limits exceeded', { userId });
      return null;
    }
    
    const exchangeRequest = {
      id: this.generateExchangeId(),
      userId,
      sourceCurrency,
      targetCurrency: preferences.targetCurrency,
      amount,
      strategy: options.strategy || preferences.exchangeStrategy,
      maxSlippage: options.maxSlippage || preferences.maxSlippage,
      preferredExchanges: options.exchanges || preferences.preferredExchanges,
      priority: options.priority || 'normal',
      status: 'pending',
      createdAt: Date.now(),
      metadata: options.metadata || {}
    };
    
    // Add to queue based on strategy
    if (exchangeRequest.strategy === ExchangeStrategy.IMMEDIATE) {
      // Process immediately
      this.processExchange(exchangeRequest);
    } else {
      // Add to queue for processing
      this.exchangeQueue.push(exchangeRequest);
      this.pendingExchanges.set(exchangeRequest.id, exchangeRequest);
    }
    
    logger.info('Exchange queued', {
      id: exchangeRequest.id,
      userId,
      pair: `${sourceCurrency}/${exchangeRequest.targetCurrency}`,
      amount
    });
    
    this.emit('exchange:queued', exchangeRequest);
    
    return exchangeRequest.id;
  }
  
  /**
   * Process exchange request
   */
  async processExchange(request) {
    logger.info('Processing exchange', {
      id: request.id,
      pair: `${request.sourceCurrency}/${request.targetCurrency}`
    });
    
    try {
      // Update status
      request.status = 'processing';
      request.startedAt = Date.now();
      
      // Get best exchange route
      const route = await this.findBestRoute(request);
      
      if (!route) {
        throw new Error('No viable exchange route found');
      }
      
      logger.debug('Best route found', {
        exchange: route.exchange,
        expectedRate: route.rate,
        estimatedFees: route.fees
      });
      
      // Execute exchange
      const result = await this.executeExchange(request, route);
      
      // Update request
      request.status = 'completed';
      request.completedAt = Date.now();
      request.result = result;
      
      // Update statistics
      this.updateStatistics(request, result);
      
      // Audit log
      if (this.auditLogger) {
        this.auditLogger.logEvent({
          type: AuditEventType.PAYMENT_COMPLETED,
          userId: request.userId,
          resource: 'exchange',
          data: {
            exchangeId: request.id,
            pair: `${request.sourceCurrency}/${request.targetCurrency}`,
            amount: request.amount,
            result
          }
        });
      }
      
      logger.info('Exchange completed', {
        id: request.id,
        received: result.received,
        fees: result.fees
      });
      
      this.emit('exchange:completed', {
        request,
        result
      });
      
      return result;
      
    } catch (error) {
      logger.error('Exchange failed', {
        id: request.id,
        error: error.message
      });
      
      request.status = 'failed';
      request.error = error.message;
      request.failedAt = Date.now();
      
      this.stats.failedExchanges++;
      
      // Audit log
      if (this.auditLogger) {
        this.auditLogger.logEvent({
          type: AuditEventType.PAYMENT_FAILED,
          userId: request.userId,
          resource: 'exchange',
          data: {
            exchangeId: request.id,
            error: error.message
          }
        });
      }
      
      this.emit('exchange:failed', {
        request,
        error
      });
      
      throw error;
      
    } finally {
      // Remove from pending
      this.pendingExchanges.delete(request.id);
    }
  }
  
  /**
   * Find best exchange route
   */
  async findBestRoute(request) {
    const routes = [];
    
    // Check each available exchange
    for (const exchangeName of request.preferredExchanges) {
      if (!this.exchangeClients.has(exchangeName)) {
        continue;
      }
      
      try {
        const exchange = this.exchangeClients.get(exchangeName);
        const quote = await this.getExchangeQuote(
          exchange,
          request.sourceCurrency,
          request.targetCurrency,
          request.amount
        );
        
        if (quote && quote.rate > 0) {
          routes.push({
            exchange: exchangeName,
            rate: quote.rate,
            fees: quote.fees || 0,
            slippage: quote.slippage || 0,
            estimatedReceived: quote.estimatedReceived,
            score: this.calculateRouteScore(quote, request)
          });
        }
        
      } catch (error) {
        logger.warn(`Failed to get quote from ${exchangeName}:`, error.message);
      }
    }
    
    if (routes.length === 0) {
      return null;
    }
    
    // Sort by score (higher is better)
    routes.sort((a, b) => b.score - a.score);
    
    // Check if best route meets slippage requirements
    const bestRoute = routes[0];
    if (bestRoute.slippage > request.maxSlippage) {
      logger.warn('Best route exceeds max slippage', {
        slippage: bestRoute.slippage,
        maxSlippage: request.maxSlippage
      });
      return null;
    }
    
    return bestRoute;
  }
  
  /**
   * Calculate route score
   */
  calculateRouteScore(quote, request) {
    let score = 100;
    
    // Rate score (higher rate is better)
    const marketRate = this.getMarketRate(request.sourceCurrency, request.targetCurrency);
    const rateRatio = quote.rate / marketRate;
    score *= rateRatio;
    
    // Fee penalty
    const feePenalty = quote.fees / request.amount;
    score *= (1 - feePenalty);
    
    // Slippage penalty
    const slippagePenalty = quote.slippage / 100;
    score *= (1 - slippagePenalty);
    
    // Exchange reliability bonus
    const reliability = this.getExchangeReliability(quote.exchange);
    score *= (0.8 + reliability * 0.2);
    
    return score;
  }
  
  /**
   * Execute exchange
   */
  async executeExchange(request, route) {
    const exchange = this.exchangeClients.get(route.exchange);
    
    // Create order
    const order = {
      pair: `${request.sourceCurrency}/${request.targetCurrency}`,
      side: 'sell',
      type: OrderType.MARKET,
      amount: request.amount,
      clientOrderId: request.id
    };
    
    logger.debug('Placing order', {
      exchange: route.exchange,
      order
    });
    
    // Execute with retries
    let attempt = 0;
    let lastError = null;
    
    while (attempt < this.config.retryAttempts) {
      try {
        // Place order
        const orderResult = await this.placeOrder(exchange, order);
        
        // Wait for order completion
        const filledOrder = await this.waitForOrderCompletion(
          exchange,
          orderResult.orderId,
          30000 // 30 second timeout
        );
        
        // Calculate actual results
        const result = {
          orderId: filledOrder.orderId,
          exchange: route.exchange,
          executedAmount: filledOrder.executedAmount,
          received: filledOrder.received,
          rate: filledOrder.received / filledOrder.executedAmount,
          fees: filledOrder.fees,
          slippage: this.calculateSlippage(route.rate, filledOrder.received / filledOrder.executedAmount),
          timestamp: filledOrder.timestamp
        };
        
        return result;
        
      } catch (error) {
        lastError = error;
        attempt++;
        
        if (attempt < this.config.retryAttempts) {
          logger.warn(`Exchange attempt ${attempt} failed, retrying...`, {
            error: error.message
          });
          await this.delay(this.config.retryDelay);
        }
      }
    }
    
    throw lastError || new Error('Exchange failed after all retries');
  }
  
  /**
   * Get exchange quote
   */
  async getExchangeQuote(exchange, sourceCurrency, targetCurrency, amount) {
    // Mock implementation - in production, call actual exchange API
    const pair = `${sourceCurrency}/${targetCurrency}`;
    const marketRate = this.getMarketRate(sourceCurrency, targetCurrency);
    
    if (!marketRate) {
      return null;
    }
    
    // Simulate exchange quote
    const fees = amount * 0.001; // 0.1% fee
    const slippage = Math.random() * 1; // 0-1% slippage
    const effectiveRate = marketRate * (1 - slippage / 100);
    const estimatedReceived = (amount - fees) * effectiveRate;
    
    return {
      pair,
      rate: effectiveRate,
      fees,
      slippage,
      estimatedReceived,
      timestamp: Date.now()
    };
  }
  
  /**
   * Place order on exchange
   */
  async placeOrder(exchange, order) {
    // Mock implementation
    const orderId = `ord_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Simulate order placement
    await this.delay(100);
    
    return {
      orderId,
      status: 'open',
      createdAt: Date.now()
    };
  }
  
  /**
   * Wait for order completion
   */
  async waitForOrderCompletion(exchange, orderId, timeout) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      // Mock order status check
      await this.delay(1000);
      
      // Simulate order completion
      if (Math.random() > 0.1) { // 90% success rate
        return {
          orderId,
          status: 'filled',
          executedAmount: 1.0, // Mock
          received: 65000, // Mock USDT received for 1 BTC
          fees: 65, // Mock fees
          timestamp: Date.now()
        };
      }
    }
    
    throw new Error('Order timeout');
  }
  
  /**
   * Initialize exchange
   */
  async initializeExchange(exchangeName) {
    // Mock exchange client initialization
    const client = {
      name: exchangeName,
      connected: true,
      supportedPairs: this.getMockSupportedPairs()
    };
    
    this.exchangeClients.set(exchangeName, client);
    
    logger.info(`Exchange ${exchangeName} initialized`);
  }
  
  /**
   * Start price monitoring
   */
  startPriceMonitoring() {
    this.priceUpdateInterval = setInterval(() => {
      this.updatePrices();
    }, this.config.priceCheckInterval);
    
    // Initial price update
    this.updatePrices();
  }
  
  /**
   * Update prices
   */
  async updatePrices() {
    // Mock price updates
    const mockPrices = {
      'BTC/USDT': 65000 + (Math.random() - 0.5) * 1000,
      'ETH/USDT': 3200 + (Math.random() - 0.5) * 50,
      'LTC/USDT': 85 + (Math.random() - 0.5) * 2,
      'XMR/USDT': 160 + (Math.random() - 0.5) * 5,
      'RVN/USDT': 0.025 + (Math.random() - 0.5) * 0.001
    };
    
    for (const [pair, price] of Object.entries(mockPrices)) {
      this.priceData.set(pair, {
        price,
        timestamp: Date.now()
      });
      
      // Add to history
      if (!this.priceHistory.has(pair)) {
        this.priceHistory.set(pair, []);
      }
      
      const history = this.priceHistory.get(pair);
      history.push({ price, timestamp: Date.now() });
      
      // Keep only last 24 hours
      const cutoff = Date.now() - 86400000;
      this.priceHistory.set(pair, history.filter(h => h.timestamp > cutoff));
    }
    
    // Check price alerts
    this.checkPriceAlerts();
  }
  
  /**
   * Start exchange processor
   */
  startExchangeProcessor() {
    setInterval(() => {
      this.processQueuedExchanges();
    }, 10000); // Process every 10 seconds
  }
  
  /**
   * Process queued exchanges
   */
  async processQueuedExchanges() {
    if (this.exchangeQueue.length === 0) return;
    
    const now = Date.now();
    const toProcess = [];
    
    // Check each queued exchange
    for (let i = this.exchangeQueue.length - 1; i >= 0; i--) {
      const request = this.exchangeQueue[i];
      
      if (this.shouldProcessExchange(request, now)) {
        toProcess.push(request);
        this.exchangeQueue.splice(i, 1);
      }
    }
    
    // Process selected exchanges
    for (const request of toProcess) {
      try {
        await this.processExchange(request);
      } catch (error) {
        logger.error('Failed to process queued exchange:', error);
      }
    }
  }
  
  /**
   * Check if exchange should be processed
   */
  shouldProcessExchange(request, now) {
    const preferences = this.userPreferences.get(request.userId);
    
    switch (request.strategy) {
      case ExchangeStrategy.SCHEDULED:
        // Check if scheduled time reached
        return request.scheduledTime && now >= request.scheduledTime;
        
      case ExchangeStrategy.PRICE_TRIGGERED:
        // Check price conditions
        return this.checkPriceConditions(request);
        
      case ExchangeStrategy.ACCUMULATE:
        // Check if accumulation target reached
        return this.checkAccumulationTarget(request);
        
      case ExchangeStrategy.SMART:
        // Use smart algorithm
        return this.smartExchangeDecision(request);
        
      default:
        return true;
    }
  }
  
  /**
   * Check price conditions
   */
  checkPriceConditions(request) {
    const pair = `${request.sourceCurrency}/${request.targetCurrency}`;
    const currentPrice = this.priceData.get(pair);
    
    if (!currentPrice) return false;
    
    // Check if price meets conditions
    if (request.metadata.minPrice && currentPrice.price < request.metadata.minPrice) {
      return false;
    }
    
    if (request.metadata.maxPrice && currentPrice.price > request.metadata.maxPrice) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Check accumulation target
   */
  checkAccumulationTarget(request) {
    const userTotal = this.getUserAccumulation(request.userId, request.sourceCurrency);
    return userTotal >= (request.metadata.accumulationTarget || 1.0);
  }
  
  /**
   * Smart exchange decision
   */
  smartExchangeDecision(request) {
    const pair = `${request.sourceCurrency}/${request.targetCurrency}`;
    const priceHistory = this.priceHistory.get(pair);
    
    if (!priceHistory || priceHistory.length < 10) {
      return false; // Not enough data
    }
    
    // Simple momentum strategy
    const recent = priceHistory.slice(-10);
    const avgPrice = recent.reduce((sum, h) => sum + h.price, 0) / recent.length;
    const currentPrice = recent[recent.length - 1].price;
    
    // Exchange if price is above average (uptrend)
    return currentPrice > avgPrice * 1.01; // 1% above average
  }
  
  /**
   * Check price alerts
   */
  checkPriceAlerts() {
    for (const [userId, preferences] of this.userPreferences) {
      if (!preferences.priceAlerts) continue;
      
      for (const alert of preferences.priceAlerts) {
        const currentPrice = this.priceData.get(alert.pair);
        
        if (!currentPrice) continue;
        
        let triggered = false;
        
        if (alert.type === 'above' && currentPrice.price > alert.price) {
          triggered = true;
        } else if (alert.type === 'below' && currentPrice.price < alert.price) {
          triggered = true;
        }
        
        if (triggered && !alert.triggered) {
          alert.triggered = true;
          
          this.emit('price:alert', {
            userId,
            alert,
            currentPrice: currentPrice.price
          });
        } else if (!triggered && alert.triggered) {
          alert.triggered = false;
        }
      }
    }
  }
  
  /**
   * Check user limits
   */
  checkUserLimits(userId, amount, currency) {
    const preferences = this.userPreferences.get(userId);
    if (!preferences || !preferences.limits) return true;
    
    // Get user's exchange history
    const userHistory = this.getUserExchangeHistory(userId);
    const now = Date.now();
    
    // Check daily limit
    if (preferences.limits.daily) {
      const dailyTotal = userHistory
        .filter(h => now - h.timestamp < 86400000) // 24 hours
        .reduce((sum, h) => sum + h.amount, 0);
      
      if (dailyTotal + amount > preferences.limits.daily) {
        return false;
      }
    }
    
    // Check monthly limit
    if (preferences.limits.monthly) {
      const monthlyTotal = userHistory
        .filter(h => now - h.timestamp < 2592000000) // 30 days
        .reduce((sum, h) => sum + h.amount, 0);
      
      if (monthlyTotal + amount > preferences.limits.monthly) {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Get user exchange history
   */
  getUserExchangeHistory(userId) {
    // In production, query from database
    // For now, return empty array
    return [];
  }
  
  /**
   * Get user accumulation
   */
  getUserAccumulation(userId, currency) {
    // In production, query from database
    // For now, return mock value
    return Math.random() * 2;
  }
  
  /**
   * Get market rate
   */
  getMarketRate(source, target) {
    const pair = `${source}/${target}`;
    const priceData = this.priceData.get(pair);
    
    return priceData ? priceData.price : null;
  }
  
  /**
   * Get exchange reliability
   */
  getExchangeReliability(exchangeName) {
    // In production, track actual reliability
    // For now, return mock value
    const reliabilityMap = {
      [SupportedExchange.INTERNAL]: 1.0,
      [SupportedExchange.BINANCE]: 0.95,
      [SupportedExchange.COINBASE]: 0.93,
      [SupportedExchange.KRAKEN]: 0.92,
      [SupportedExchange.UNISWAP]: 0.85
    };
    
    return reliabilityMap[exchangeName] || 0.8;
  }
  
  /**
   * Calculate slippage
   */
  calculateSlippage(expectedRate, actualRate) {
    return Math.abs((expectedRate - actualRate) / expectedRate) * 100;
  }
  
  /**
   * Update statistics
   */
  updateStatistics(request, result) {
    this.stats.totalExchanges++;
    this.stats.successfulExchanges++;
    
    // Update volume
    const currentVolume = this.stats.totalVolumeExchanged.get(request.sourceCurrency) || 0;
    this.stats.totalVolumeExchanged.set(request.sourceCurrency, currentVolume + request.amount);
    
    // Update fees
    this.stats.totalFeesPaid += result.fees;
    
    // Update average slippage
    this.stats.averageSlippage = 
      (this.stats.averageSlippage * (this.stats.successfulExchanges - 1) + result.slippage) / 
      this.stats.successfulExchanges;
    
    // Calculate profit/loss
    const expectedValue = request.amount * this.getMarketRate(request.sourceCurrency, request.targetCurrency);
    const actualValue = result.received;
    this.stats.profitLoss += (actualValue - expectedValue);
  }
  
  /**
   * Get mock supported pairs
   */
  getMockSupportedPairs() {
    return [
      'BTC/USDT', 'ETH/USDT', 'LTC/USDT', 
      'XMR/USDT', 'RVN/USDT', 'BTC/ETH'
    ];
  }
  
  /**
   * Generate exchange ID
   */
  generateExchangeId() {
    return `exc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Delay helper
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Get exchange status
   */
  getExchangeStatus(exchangeId) {
    const pending = this.pendingExchanges.get(exchangeId);
    return pending || null;
  }
  
  /**
   * Cancel exchange
   */
  async cancelExchange(exchangeId) {
    const exchange = this.pendingExchanges.get(exchangeId);
    
    if (!exchange || exchange.status !== 'pending') {
      throw new Error('Exchange cannot be cancelled');
    }
    
    // Remove from queue
    const queueIndex = this.exchangeQueue.findIndex(e => e.id === exchangeId);
    if (queueIndex >= 0) {
      this.exchangeQueue.splice(queueIndex, 1);
    }
    
    // Update status
    exchange.status = 'cancelled';
    exchange.cancelledAt = Date.now();
    
    this.pendingExchanges.delete(exchangeId);
    
    logger.info('Exchange cancelled', { exchangeId });
    
    return true;
  }
  
  /**
   * Get statistics
   */
  getStatistics() {
    return {
      ...this.stats,
      totalVolumeExchanged: Object.fromEntries(this.stats.totalVolumeExchanged),
      successRate: this.stats.totalExchanges > 0 
        ? (this.stats.successfulExchanges / this.stats.totalExchanges * 100).toFixed(2)
        : 0,
      pendingExchanges: this.exchangeQueue.length,
      activeExchanges: this.exchangeClients.size,
      currentPrices: Object.fromEntries(
        Array.from(this.priceData.entries()).map(([pair, data]) => [pair, data.price])
      )
    };
  }
  
  /**
   * Export configuration
   */
  exportConfiguration() {
    return {
      config: this.config,
      userPreferences: Object.fromEntries(this.userPreferences),
      timestamp: Date.now()
    };
  }
  
  /**
   * Import configuration
   */
  importConfiguration(data) {
    if (data.userPreferences) {
      for (const [userId, prefs] of Object.entries(data.userPreferences)) {
        this.userPreferences.set(userId, prefs);
      }
    }
    
    logger.info('Configuration imported');
  }
  
  /**
   * Shutdown exchanger
   */
  async shutdown() {
    // Stop intervals
    if (this.priceUpdateInterval) {
      clearInterval(this.priceUpdateInterval);
    }
    
    // Process remaining urgent exchanges
    const urgentExchanges = this.exchangeQueue.filter(e => e.priority === 'high');
    for (const exchange of urgentExchanges) {
      try {
        await this.processExchange(exchange);
      } catch (error) {
        logger.error('Failed to process urgent exchange on shutdown:', error);
      }
    }
    
    // Clear queues
    this.exchangeQueue = [];
    this.pendingExchanges.clear();
    
    this.removeAllListeners();
    logger.info('Auto exchanger shutdown');
  }
}

/**
 * Create auto exchanger
 */
export function createAutoExchanger(config) {
  return new AutoExchanger(config);
}

export default AutoExchanger;