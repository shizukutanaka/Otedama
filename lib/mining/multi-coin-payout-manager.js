/**
 * Multi-Coin Payout Manager
 * Handles payouts in multiple cryptocurrencies with auto-conversion to BTC
 * 
 * Features:
 * - Support for native coin and BTC payouts
 * - Automatic BTC conversion with profitable fees
 * - Bulk exchange to minimize costs
 * - Multiple exchange integration
 * - Fee optimization
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { ExternalServiceConverter, ConversionService } from '../integrations/external-service-converter.js';
import { MultiServiceConverter } from '../integrations/multi-service-converter.js';

const logger = createLogger('MultiCoinPayoutManager');

/**
 * Supported payout currencies
 */
export const PayoutCurrency = {
  NATIVE: 'native',     // The coin being mined
  BTC: 'btc',          // Bitcoin
  USDT: 'usdt',        // Tether (stable)
  CUSTOM: 'custom'     // Custom address for specific coin
};

/**
 * Exchange integration types
 */
export const ExchangeType = {
  EXTERNAL_SERVICE: 'external',  // External swap services (primary)
  LIGHTNING: 'lightning',        // Lightning Network (0% fees)
  BINANCE: 'binance',           // Fallback only
  KRAKEN: 'kraken',             // Fallback only
  INTERNAL: 'internal',         // Internal liquidity pool
  DEX: 'dex'                    // Decentralized exchange
};

/**
 * Multi-Coin Payout Manager
 */
export class MultiCoinPayoutManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Fee structure (ultra-competitive with external services)
      poolFee: config.poolFee || 0.01,        // 1% pool fee
      soloFee: config.soloFee || 0.005,      // 0.5% solo fee
      conversionFee: config.conversionFee || 0.002, // 0.2% conversion fee (reduced!)
      
      // Exchange settings
      primaryExchange: config.primaryExchange || ExchangeType.EXTERNAL_SERVICE,
      fallbackExchange: config.fallbackExchange || ExchangeType.LIGHTNING,
      useExternalServices: config.useExternalServices !== false,
      
      // Payout settings
      minPayoutNative: config.minPayoutNative || 0.001,
      minPayoutBTC: config.minPayoutBTC || 0.0001,
      payoutBatchSize: config.payoutBatchSize || 100,
      
      // Conversion settings
      autoConvertThreshold: config.autoConvertThreshold || 0.01, // Min amount for conversion
      bulkConvertInterval: config.bulkConvertInterval || 3600000, // 1 hour
      maxSlippage: config.maxSlippage || 0.01, // 1% max slippage
      
      // Supported coins
      supportedCoins: config.supportedCoins || [
        'BTC', 'ETH', 'LTC', 'BCH', 'DOGE', 'RVN', 'ERG', 'KAS', 'ZEC', 'XMR'
      ],
      
      // Bulk optimization
      bulkOptimizationEnabled: config.bulkOptimizationEnabled !== false
    };
    
    // State
    this.minerPayoutSettings = new Map();
    this.pendingPayouts = new Map();
    this.conversionQueue = new Map();
    this.exchangeRates = new Map();
    
    // Statistics
    this.stats = {
      totalPayouts: 0,
      totalConverted: 0,
      totalFees: 0,
      conversionSavings: 0
    };
    
    // Initialize exchange connections
    this.exchanges = new Map();
    this.externalConverter = null;
    this.multiServiceConverter = null;
    this.initializeExchanges();
    
    // Initialize external service converter
    if (this.config.useExternalServices) {
      this.initializeExternalServices();
    }
    
    // Start periodic tasks
    this.startPeriodicTasks();
  }
  
  /**
   * Initialize exchange connections
   */
  initializeExchanges() {
    // External services (primary)
    this.exchanges.set(ExchangeType.EXTERNAL_SERVICE, {
      name: 'External Services',
      tradingFee: 0, // Handled by service
      withdrawalFees: {} // No withdrawal fees
    });
    
    this.exchanges.set(ExchangeType.LIGHTNING, {
      name: 'Lightning Network',
      tradingFee: 0, // 0% fees!
      withdrawalFees: {
        BTC: 0 // No fees for Lightning
      }
    });
    
    // Traditional exchanges (fallback only)
    this.exchanges.set(ExchangeType.BINANCE, {
      name: 'Binance',
      tradingFee: 0.001, // 0.1%
      withdrawalFees: {
        BTC: 0.0005,
        ETH: 0.005,
        LTC: 0.001
      }
    });
    
    this.exchanges.set(ExchangeType.KRAKEN, {
      name: 'Kraken',
      tradingFee: 0.0016, // 0.16%
      withdrawalFees: {
        BTC: 0.00015,
        ETH: 0.0035,
        LTC: 0.002
      }
    });
  }
  
  /**
   * Initialize external services
   */
  initializeExternalServices() {
    // Initialize multi-service converter for redundancy
    this.multiServiceConverter = new MultiServiceConverter({
      services: [
        { id: ConversionService.BTCPAY_LIGHTNING, priority: 1, weight: 0.4 },
        { id: ConversionService.SIMPLESWAP, priority: 1, weight: 0.3 },
        { id: ConversionService.CHANGENOW, priority: 1, weight: 0.3 },
        { id: ConversionService.COINPAYMENTS, priority: 2, weight: 0.5 }
      ],
      parallelQueries: true,
      maxParallelRequests: 3,
      loadBalancing: 'weighted',
      rateComparison: true,
      alwaysUseBestRate: true,
      autoFailover: true
    });
    
    // Keep single converter for compatibility
    this.externalConverter = new ExternalServiceConverter({
      primaryService: ConversionService.BTCPAY_LIGHTNING,
      fallbackServices: [
        ConversionService.CHANGENOW,
        ConversionService.SIMPLESWAP
      ],
      maxAcceptableFee: 0.01,
      preferNoKYC: true,
      lightningEnabled: true,
      bulkOptimizationEnabled: this.config.bulkOptimizationEnabled
    });
    
    // Handle external service events
    this.externalConverter.on('stats:updated', (stats) => {
      logger.info('External service stats:', stats);
      this.emit('external:stats', stats);
    });
    
    // Handle multi-service events
    this.multiServiceConverter.on('service:failure', (data) => {
      logger.warn('Service failure:', data);
      this.emit('service:failure', data);
    });
    
    this.multiServiceConverter.on('failover:success', (data) => {
      logger.info('Failover successful:', data);
      this.emit('failover:success', data);
    });
  }
  
  /**
   * Set miner payout preferences
   */
  setMinerPayoutPreferences(minerId, preferences) {
    const settings = {
      minerId,
      payoutCurrency: preferences.currency || PayoutCurrency.NATIVE,
      payoutAddress: preferences.address,
      customAddresses: preferences.customAddresses || {}, // { BTC: 'addr1', ETH: 'addr2' }
      autoConvert: preferences.autoConvert !== false,
      minPayout: preferences.minPayout || this.getMinPayout(preferences.currency),
      instantPayout: preferences.instantPayout || false,
      preferredExchange: preferences.exchange || this.config.primaryExchange
    };
    
    // Validate addresses
    if (!this.validateAddress(settings.payoutAddress, settings.payoutCurrency)) {
      throw new Error('Invalid payout address');
    }
    
    this.minerPayoutSettings.set(minerId, settings);
    
    logger.info(`Payout preferences set for miner ${minerId}:`, {
      currency: settings.payoutCurrency,
      autoConvert: settings.autoConvert
    });
    
    this.emit('preferences:updated', { minerId, settings });
    
    return settings;
  }
  
  /**
   * Process miner earnings
   */
  async processMinerEarnings(minerId, amount, coinType, isSolo = false) {
    const settings = this.minerPayoutSettings.get(minerId);
    if (!settings) {
      throw new Error('Miner payout settings not found');
    }
    
    // Calculate fees
    const baseFee = isSolo ? this.config.soloFee : this.config.poolFee;
    const feeAmount = amount * baseFee;
    let netAmount = amount - feeAmount;
    
    // Determine payout currency and conversion needs
    const needsConversion = settings.payoutCurrency === PayoutCurrency.BTC && coinType !== 'BTC';
    
    if (needsConversion && settings.autoConvert) {
      // Add to conversion queue
      this.addToConversionQueue(minerId, netAmount, coinType);
    } else {
      // Add to pending payouts
      this.addToPendingPayouts(minerId, netAmount, 
        settings.payoutCurrency === PayoutCurrency.NATIVE ? coinType : settings.payoutCurrency);
    }
    
    // Update statistics
    this.stats.totalFees += feeAmount;
    
    this.emit('earnings:processed', {
      minerId,
      amount,
      feeAmount,
      netAmount,
      coinType,
      payoutCurrency: settings.payoutCurrency,
      needsConversion
    });
  }
  
  /**
   * Add to conversion queue
   */
  addToConversionQueue(minerId, amount, fromCoin) {
    const key = `${minerId}:${fromCoin}`;
    const current = this.conversionQueue.get(key) || { amount: 0, fromCoin, toCoin: 'BTC' };
    current.amount += amount;
    this.conversionQueue.set(key, current);
    
    // Check if immediate conversion is needed
    if (current.amount >= this.config.autoConvertThreshold) {
      this.triggerConversion(minerId, fromCoin);
    }
  }
  
  /**
   * Add to pending payouts
   */
  addToPendingPayouts(minerId, amount, coin) {
    const key = `${minerId}:${coin}`;
    const current = this.pendingPayouts.get(key) || { amount: 0, coin };
    current.amount += amount;
    this.pendingPayouts.set(key, current);
    
    // Check if payout threshold reached
    const settings = this.minerPayoutSettings.get(minerId);
    if (current.amount >= settings.minPayout) {
      this.triggerPayout(minerId, coin);
    }
  }
  
  /**
   * Trigger conversion for a miner
   */
  async triggerConversion(minerId, fromCoin) {
    const key = `${minerId}:${fromCoin}`;
    const conversion = this.conversionQueue.get(key);
    if (!conversion || conversion.amount === 0) return;
    
    try {
      // Get best exchange rate
      const exchangeRate = await this.getBestExchangeRate(fromCoin, 'BTC');
      
      // Calculate conversion
      const btcAmount = conversion.amount * exchangeRate.rate;
      const conversionFee = conversion.amount * this.config.conversionFee;
      const exchangeFee = btcAmount * exchangeRate.fee;
      const totalFees = conversionFee + exchangeFee;
      const netBtcAmount = btcAmount - totalFees;
      
      // Ensure profitable conversion
      if (netBtcAmount <= 0) {
        logger.warn('Conversion would result in loss, skipping');
        return;
      }
      
      // Execute conversion via external service
      logger.info(`Converting ${conversion.amount} ${fromCoin} to ${netBtcAmount} BTC for miner ${minerId}`);
      
      // Use multi-service converter for better reliability
      if (this.multiServiceConverter && this.config.useExternalServices) {
        const settings = this.minerPayoutSettings.get(minerId);
        const result = await this.multiServiceConverter.convert({
          fromCoin,
          toCoin: 'BTC',
          amount: conversion.amount,
          address: settings.payoutAddress,
          userId: minerId,
          allowBatching: true
        });
        
        if (result.status === 'queued') {
          logger.info(`Conversion queued for batch processing: ${result.id}`);
          return;
        }
      }
      
      // Add to BTC payouts
      this.addToPendingPayouts(minerId, netBtcAmount, 'BTC');
      
      // Clear conversion queue
      this.conversionQueue.delete(key);
      
      // Update statistics
      this.stats.totalConverted += conversion.amount;
      this.stats.conversionSavings += (exchangeRate.competitorFee - exchangeRate.fee) * btcAmount;
      
      this.emit('conversion:completed', {
        minerId,
        fromCoin,
        toCoin: 'BTC',
        fromAmount: conversion.amount,
        toAmount: netBtcAmount,
        rate: exchangeRate.rate,
        fees: totalFees
      });
      
    } catch (error) {
      logger.error('Conversion failed:', error);
      this.emit('conversion:failed', { minerId, fromCoin, error: error.message });
    }
  }
  
  /**
   * Get best exchange rate
   */
  async getBestExchangeRate(fromCoin, toCoin) {
    // First try multi-service converter for best rates
    if (this.multiServiceConverter && this.config.useExternalServices) {
      try {
        // Get rates from all available services
        const allRates = await this.externalConverter.getAllServiceRates(fromCoin, toCoin, 1);
        
        if (allRates && allRates.length > 0) {
          // Sort by effective rate
          allRates.sort((a, b) => b.effectiveRate - a.effectiveRate);
          const bestRate = allRates[0];
          
          logger.info(`Best rate found: ${bestRate.service} @ ${bestRate.rate}`);
          
          return {
            exchange: ExchangeType.EXTERNAL_SERVICE,
            rate: bestRate.rate,
            fee: bestRate.fee || 0,
            totalCost: bestRate.fee || 0,
            service: bestRate.service,
            instant: bestRate.instant,
            noKYC: bestRate.noKYC,
            competitorFee: 0.025, // Average competitor fee (2.5%)
            alternativeServices: allRates.slice(1) // Backup options
          };
        }
      } catch (error) {
        logger.error('Multi-service rate fetch failed:', error);
      }
    }
    
    // Fallback to traditional exchanges
    const rates = [];
    
    for (const [exchangeType, exchange] of this.exchanges) {
      if (exchangeType === ExchangeType.EXTERNAL_SERVICE) continue;
      
      try {
        const rate = await this.fetchExchangeRate(exchangeType, fromCoin, toCoin);
        rates.push({
          exchange: exchangeType,
          rate: rate,
          fee: exchange.tradingFee,
          totalCost: exchange.tradingFee + (exchange.withdrawalFees[toCoin] || 0)
        });
      } catch (error) {
        logger.error(`Failed to get rate from ${exchangeType}:`, error);
      }
    }
    
    // Sort by best effective rate (after fees)
    rates.sort((a, b) => {
      const aEffective = a.rate * (1 - a.totalCost);
      const bEffective = b.rate * (1 - b.totalCost);
      return bEffective - aEffective;
    });
    
    const bestRate = rates[0] || {
      exchange: ExchangeType.BINANCE,
      rate: 0,
      fee: 0.001,
      totalCost: 0.001
    };
    
    bestRate.competitorFee = 0.025; // Average competitor fee (2.5%)
    
    return bestRate;
  }
  
  /**
   * Fetch exchange rate (mock implementation)
   */
  async fetchExchangeRate(exchange, fromCoin, toCoin) {
    // Mock rates - in production, use real API
    const mockRates = {
      'ETH:BTC': 0.065,
      'LTC:BTC': 0.0015,
      'BCH:BTC': 0.0045,
      'DOGE:BTC': 0.0000025,
      'RVN:BTC': 0.0000012
    };
    
    return mockRates[`${fromCoin}:${toCoin}`] || 0.001;
  }
  
  /**
   * Trigger payout for a miner
   */
  async triggerPayout(minerId, coin) {
    const key = `${minerId}:${coin}`;
    const payout = this.pendingPayouts.get(key);
    if (!payout || payout.amount === 0) return;
    
    const settings = this.minerPayoutSettings.get(minerId);
    if (!settings) return;
    
    try {
      // Determine payout address
      let payoutAddress = settings.payoutAddress;
      if (settings.customAddresses[coin]) {
        payoutAddress = settings.customAddresses[coin];
      }
      
      // Create payout transaction
      const transaction = {
        id: crypto.randomBytes(16).toString('hex'),
        minerId,
        coin,
        amount: payout.amount,
        address: payoutAddress,
        timestamp: Date.now(),
        status: 'pending'
      };
      
      // Execute payout (simulated)
      logger.info(`Processing payout: ${payout.amount} ${coin} to ${payoutAddress}`);
      
      // Clear pending payout
      this.pendingPayouts.delete(key);
      
      // Update statistics
      this.stats.totalPayouts++;
      
      this.emit('payout:processed', transaction);
      
      return transaction;
      
    } catch (error) {
      logger.error('Payout failed:', error);
      this.emit('payout:failed', { minerId, coin, error: error.message });
    }
  }
  
  /**
   * Bulk convert accumulated coins
   */
  async bulkConvert() {
    const conversions = Array.from(this.conversionQueue.entries())
      .filter(([_, conv]) => conv.amount >= this.config.autoConvertThreshold);
    
    if (conversions.length === 0) return;
    
    logger.info(`Starting bulk conversion for ${conversions.length} entries`);
    
    // Group by coin type for better rates
    const byCoin = new Map();
    for (const [key, conversion] of conversions) {
      if (!byCoin.has(conversion.fromCoin)) {
        byCoin.set(conversion.fromCoin, []);
      }
      byCoin.get(conversion.fromCoin).push({ key, ...conversion });
    }
    
    // Process each coin type
    for (const [coin, conversions] of byCoin) {
      const totalAmount = conversions.reduce((sum, c) => sum + c.amount, 0);
      
      try {
        // Get bulk rate (usually better)
        const rate = await this.getBestExchangeRate(coin, 'BTC');
        const bulkDiscount = totalAmount > 1 ? 0.0001 : 0; // 0.01% bulk discount
        rate.fee = Math.max(0.0005, rate.fee - bulkDiscount); // Min 0.05% fee
        
        logger.info(`Bulk converting ${totalAmount} ${coin} at rate ${rate.rate}`);
        
        // Process individual conversions
        for (const conversion of conversions) {
          const [minerId] = conversion.key.split(':');
          await this.triggerConversion(minerId, coin);
        }
        
      } catch (error) {
        logger.error(`Bulk conversion failed for ${coin}:`, error);
      }
    }
  }
  
  /**
   * Validate cryptocurrency address
   */
  validateAddress(address, currency) {
    if (!address) return false;
    
    // Basic validation patterns
    const patterns = {
      BTC: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/,
      ETH: /^0x[a-fA-F0-9]{40}$/,
      LTC: /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$/,
      BCH: /^[13][a-km-zA-HJ-NP-Z1-9]{33}$|^bitcoincash:[a-z0-9]{42}$/,
      DOGE: /^D[a-km-zA-HJ-NP-Z1-9]{33}$/
    };
    
    const pattern = patterns[currency] || patterns.BTC;
    return pattern.test(address);
  }
  
  /**
   * Get minimum payout for currency
   */
  getMinPayout(currency) {
    if (currency === PayoutCurrency.BTC) {
      return this.config.minPayoutBTC;
    }
    return this.config.minPayoutNative;
  }
  
  /**
   * Start periodic tasks
   */
  startPeriodicTasks() {
    // Bulk conversion timer
    setInterval(() => {
      this.bulkConvert().catch(error => {
        logger.error('Bulk conversion error:', error);
      });
    }, this.config.bulkConvertInterval);
    
    // Exchange rate update timer
    setInterval(() => {
      this.updateExchangeRates().catch(error => {
        logger.error('Rate update error:', error);
      });
    }, 300000); // 5 minutes
  }
  
  /**
   * Update exchange rates
   */
  async updateExchangeRates() {
    for (const coin of this.config.supportedCoins) {
      if (coin === 'BTC') continue;
      
      try {
        const rate = await this.getBestExchangeRate(coin, 'BTC');
        this.exchangeRates.set(`${coin}:BTC`, rate);
      } catch (error) {
        logger.error(`Failed to update rate for ${coin}:`, error);
      }
    }
    
    this.emit('rates:updated', Object.fromEntries(this.exchangeRates));
  }
  
  /**
   * Get payout statistics
   */
  getStats() {
    const pendingByCoins = {};
    for (const [key, payout] of this.pendingPayouts) {
      if (!pendingByCoins[payout.coin]) {
        pendingByCoins[payout.coin] = 0;
      }
      pendingByCoins[payout.coin] += payout.amount;
    }
    
    // Get bulk optimization stats if available
    const bulkStats = this.externalConverter?.getStats()?.bulkOptimization || {};
    
    // Get multi-service stats if available
    const multiServiceStats = this.multiServiceConverter?.getStats() || {};
    
    return {
      ...this.stats,
      pendingPayouts: pendingByCoins,
      conversionQueue: this.conversionQueue.size,
      currentRates: Object.fromEntries(this.exchangeRates),
      totalFeeRate: `${((this.config.poolFee + this.config.conversionFee) * 100).toFixed(1)}%`,
      competitiveSavings: `${(this.stats.conversionSavings / Math.max(1, this.stats.totalConverted) * 100).toFixed(2)}%`,
      bulkOptimization: bulkStats,
      multiService: multiServiceStats
    };
  }
}

export default MultiCoinPayoutManager;