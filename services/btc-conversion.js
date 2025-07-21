/**
 * BTC Conversion Service for Otedama
 * Automatic conversion of mined currencies to BTC
 * Following Rob Pike's simplicity principles
 */

import { EventEmitter } from 'events';
import { getErrorHandler, OtedamaError, ErrorCategory, safeExecute } from '../lib/error-handler.js';
import { CacheFactory } from '../lib/core/cache-manager.js';

export class BTCConversionService extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enabled: options.enabled !== false,
      autoConvert: options.autoConvert !== false,
      updateInterval: options.updateInterval || 60000, // 1 minute
      conversionFee: options.conversionFee || 0.005, // 0.5%
      minConversionAmount: options.minConversionAmount || {
        ETH: 0.001,
        RVN: 10,
        XMR: 0.01,
        LTC: 0.01,
        ETC: 0.01,
        DOGE: 100,
        ZEC: 0.001,
        DASH: 0.001,
        ERGO: 1,
        FLUX: 1,
        KAS: 100,
        ALPH: 1
      },
      exchangeApis: options.exchangeApis || [
        'binance',
        'kraken',
        'coinbase'
      ],
      retryAttempts: options.retryAttempts || 3,
      retryDelay: options.retryDelay || 1000,
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.cache = CacheFactory.createApiCache();
    
    // Exchange rates storage
    this.exchangeRates = new Map();
    this.lastUpdate = null;
    this.updateTimer = null;
    
    // Conversion queue
    this.conversionQueue = [];
    this.processing = false;
    
    // Statistics
    this.stats = {
      conversions: 0,
      totalConverted: {},
      totalBTC: 0,
      feesCollected: 0,
      errors: 0
    };
    
    if (this.options.enabled) {
      this.start();
    }
  }
  
  /**
   * Start the conversion service
   */
  async start() {
    // Update rates immediately
    await this.updateExchangeRates();
    
    // Schedule periodic updates
    this.updateTimer = setInterval(() => {
      this.updateExchangeRates().catch(error => {
        this.errorHandler.handleError(error, {
          service: 'btc-conversion',
          category: ErrorCategory.EXTERNAL_SERVICE
        });
      });
    }, this.options.updateInterval);
    
    // Start processing queue
    this.startQueueProcessor();
    
    this.emit('started');
  }
  
  /**
   * Stop the conversion service
   */
  stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    
    this.emit('stopped');
  }
  
  /**
   * Update exchange rates from multiple sources
   */
  async updateExchangeRates() {
    const rates = new Map();
    const errors = [];
    
    // Fetch rates from each exchange
    for (const exchange of this.options.exchangeApis) {
      try {
        const exchangeRates = await this.fetchExchangeRates(exchange);
        
        // Merge rates, averaging across exchanges
        for (const [currency, rate] of exchangeRates) {
          if (!rates.has(currency)) {
            rates.set(currency, []);
          }
          rates.get(currency).push(rate);
        }
      } catch (error) {
        errors.push({ exchange, error: error.message });
      }
    }
    
    // Calculate average rates
    const finalRates = new Map();
    for (const [currency, rateArray] of rates) {
      const avgRate = rateArray.reduce((sum, rate) => sum + rate, 0) / rateArray.length;
      finalRates.set(currency, avgRate);
    }
    
    // Validate rates
    if (finalRates.size === 0) {
      throw new OtedamaError(
        'Failed to fetch exchange rates from all sources',
        ErrorCategory.EXTERNAL_SERVICE,
        { errors }
      );
    }
    
    // Update stored rates
    this.exchangeRates = finalRates;
    this.lastUpdate = Date.now();
    
    // Cache rates
    await this.cache.set('btc-rates', Object.fromEntries(finalRates), {
      ttl: this.options.updateInterval
    });
    
    this.emit('rates-updated', {
      rates: Object.fromEntries(finalRates),
      sources: rates.size,
      errors
    });
    
    return finalRates;
  }
  
  /**
   * Fetch rates from specific exchange
   */
  async fetchExchangeRates(exchange) {
    const cacheKey = `rates-${exchange}`;
    const cached = await this.cache.get(cacheKey);
    
    if (cached) {
      return new Map(Object.entries(cached));
    }
    
    let rates;
    
    switch (exchange) {
      case 'binance':
        rates = await this.fetchBinanceRates();
        break;
      case 'kraken':
        rates = await this.fetchKrakenRates();
        break;
      case 'coinbase':
        rates = await this.fetchCoinbaseRates();
        break;
      default:
        throw new Error(`Unknown exchange: ${exchange}`);
    }
    
    // Cache exchange-specific rates
    await this.cache.set(cacheKey, Object.fromEntries(rates), {
      ttl: 300000 // 5 minutes
    });
    
    return rates;
  }
  
  /**
   * Fetch Binance exchange rates
   */
  async fetchBinanceRates() {
    // Simulated rates for now - in production, use actual API
    const rates = new Map();
    
    // Simulated exchange rates (BTC per unit)
    rates.set('ETH', 0.065);
    rates.set('LTC', 0.00215);
    rates.set('XMR', 0.0035);
    rates.set('DOGE', 0.0000025);
    rates.set('ZEC', 0.0008);
    rates.set('DASH', 0.0007);
    
    return rates;
  }
  
  /**
   * Fetch Kraken exchange rates
   */
  async fetchKrakenRates() {
    // Simulated rates for now
    const rates = new Map();
    
    rates.set('ETH', 0.0648);
    rates.set('LTC', 0.00213);
    rates.set('XMR', 0.00348);
    rates.set('DOGE', 0.00000248);
    rates.set('ZEC', 0.00079);
    rates.set('DASH', 0.00069);
    
    return rates;
  }
  
  /**
   * Fetch Coinbase exchange rates
   */
  async fetchCoinbaseRates() {
    // Simulated rates for now
    const rates = new Map();
    
    rates.set('ETH', 0.0652);
    rates.set('LTC', 0.00217);
    rates.set('DOGE', 0.00000252);
    rates.set('ZEC', 0.00081);
    rates.set('DASH', 0.00071);
    
    return rates;
  }
  
  /**
   * Get current BTC rate for a currency
   */
  getBTCRate(currency) {
    if (currency === 'BTC') return 1;
    
    const rate = this.exchangeRates.get(currency);
    if (!rate) {
      throw new OtedamaError(
        `No exchange rate available for ${currency}`,
        ErrorCategory.VALIDATION
      );
    }
    
    return rate;
  }
  
  /**
   * Calculate BTC value
   */
  calculateBTCValue(amount, currency) {
    const rate = this.getBTCRate(currency);
    return amount * rate;
  }
  
  /**
   * Calculate conversion with fee
   */
  calculateConversion(amount, currency) {
    const btcValue = this.calculateBTCValue(amount, currency);
    const fee = btcValue * this.options.conversionFee;
    const netBTC = btcValue - fee;
    
    return {
      currency,
      amount,
      rate: this.getBTCRate(currency),
      btcValue,
      fee,
      netBTC,
      timestamp: Date.now()
    };
  }
  
  /**
   * Queue conversion request
   */
  async queueConversion(userId, amount, currency, metadata = {}) {
    // Validate minimum amount
    const minAmount = this.options.minConversionAmount[currency];
    if (minAmount && amount < minAmount) {
      throw new OtedamaError(
        `Amount below minimum for ${currency}: ${amount} < ${minAmount}`,
        ErrorCategory.VALIDATION
      );
    }
    
    const conversion = {
      id: `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      userId,
      amount,
      currency,
      metadata,
      status: 'pending',
      createdAt: Date.now()
    };
    
    this.conversionQueue.push(conversion);
    this.emit('conversion-queued', conversion);
    
    // Process queue if not already processing
    if (!this.processing) {
      this.processQueue();
    }
    
    return conversion.id;
  }
  
  /**
   * Start queue processor
   */
  startQueueProcessor() {
    setInterval(() => {
      if (!this.processing && this.conversionQueue.length > 0) {
        this.processQueue();
      }
    }, 5000); // Check every 5 seconds
  }
  
  /**
   * Process conversion queue
   */
  async processQueue() {
    if (this.processing || this.conversionQueue.length === 0) {
      return;
    }
    
    this.processing = true;
    
    try {
      // Process in batches
      const batchSize = 10;
      const batch = this.conversionQueue.splice(0, batchSize);
      
      for (const conversion of batch) {
        await this.processConversion(conversion);
      }
    } finally {
      this.processing = false;
    }
  }
  
  /**
   * Process single conversion
   */
  async processConversion(conversion) {
    try {
      // Calculate conversion
      const result = this.calculateConversion(
        conversion.amount,
        conversion.currency
      );
      
      // Update conversion record
      conversion.status = 'completed';
      conversion.result = result;
      conversion.completedAt = Date.now();
      
      // Update statistics
      this.stats.conversions++;
      this.stats.totalBTC += result.netBTC;
      this.stats.feesCollected += result.fee;
      
      if (!this.stats.totalConverted[conversion.currency]) {
        this.stats.totalConverted[conversion.currency] = 0;
      }
      this.stats.totalConverted[conversion.currency] += conversion.amount;
      
      this.emit('conversion-completed', {
        conversion,
        result
      });
      
      return result;
      
    } catch (error) {
      conversion.status = 'failed';
      conversion.error = error.message;
      conversion.failedAt = Date.now();
      
      this.stats.errors++;
      
      this.emit('conversion-failed', {
        conversion,
        error
      });
      
      throw error;
    }
  }
  
  /**
   * Get conversion history
   */
  async getConversionHistory(userId, options = {}) {
    const {
      limit = 100,
      offset = 0,
      currency = null,
      status = null,
      startDate = null,
      endDate = null
    } = options;
    
    // This would query from database in production
    // For now, return empty array
    return [];
  }
  
  /**
   * Get conversion statistics
   */
  getStats() {
    const avgRate = {};
    for (const [currency, rate] of this.exchangeRates) {
      avgRate[currency] = rate;
    }
    
    return {
      ...this.stats,
      currentRates: avgRate,
      lastUpdate: this.lastUpdate,
      queueLength: this.conversionQueue.length,
      processing: this.processing
    };
  }
  
  /**
   * Estimate conversion
   */
  estimateConversion(amount, currency) {
    try {
      return this.calculateConversion(amount, currency);
    } catch (error) {
      return {
        error: error.message,
        currency,
        amount
      };
    }
  }
  
  /**
   * Batch estimate conversions
   */
  batchEstimate(conversions) {
    return conversions.map(({ amount, currency }) => 
      this.estimateConversion(amount, currency)
    );
  }
}

// Singleton instance
let conversionService = null;

export function getBTCConversionService(options) {
  if (!conversionService) {
    conversionService = new BTCConversionService(options);
  }
  return conversionService;
}

export default BTCConversionService;
