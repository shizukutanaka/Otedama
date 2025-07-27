/**
 * External Service Converter
 * Integrates with low-fee external services for crypto conversion
 * 
 * Services:
 * - BTCPay Server (Lightning Network) - 0% fees
 * - ChangeNOW - 0.5% fees, no KYC
 * - SimpleSwap - No trading fees, instant
 * - CoinPayments - 0.5% fees
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { BulkConversionOptimizer } from '../optimization/bulk-conversion-optimizer.js';

const logger = createLogger('ExternalServiceConverter');

/**
 * Supported conversion services
 */
export const ConversionService = {
  BTCPAY_LIGHTNING: 'btcpay_lightning',    // 0% fees via Lightning
  CHANGENOW: 'changenow',                  // 0.5% fees, no KYC
  SIMPLESWAP: 'simpleswap',                // No trading fees
  COINPAYMENTS: 'coinpayments',            // 0.5% fees
  COINGATE: 'coingate'                     // 1% fees
};

/**
 * Service configurations
 */
const SERVICE_CONFIG = {
  [ConversionService.BTCPAY_LIGHTNING]: {
    name: 'BTCPay Lightning',
    fee: 0,
    instantSwap: true,
    noKYC: true,
    minAmount: 0.00001, // 1000 sats
    maxAmount: 0.1,     // Lightning channel limits
    supportedPairs: ['*:BTC'], // Any to BTC via Lightning
    apiUrl: process.env.BTCPAY_URL || 'http://localhost:23001'
  },
  [ConversionService.CHANGENOW]: {
    name: 'ChangeNOW',
    fee: 0.005, // 0.5%
    instantSwap: true,
    noKYC: true,
    minAmount: 0.001,
    maxAmount: null, // No limit
    supportedCoins: ['BTC', 'ETH', 'LTC', 'BCH', 'DOGE', 'RVN', 'XMR', 'ZEC'],
    apiUrl: 'https://api.changenow.io/v1',
    apiKey: process.env.CHANGENOW_API_KEY
  },
  [ConversionService.SIMPLESWAP]: {
    name: 'SimpleSwap',
    fee: 0, // No trading fees (spread included)
    estimatedSpread: 0.005, // ~0.5% spread
    instantSwap: true,
    noKYC: true,
    minAmount: 0,
    maxAmount: null,
    supportedCoins: ['BTC', 'ETH', 'LTC', 'BCH', 'DOGE', 'RVN', 'XMR', 'ZEC', 'KAS'],
    apiUrl: 'https://api.simpleswap.io',
    apiKey: process.env.SIMPLESWAP_API_KEY
  },
  [ConversionService.COINPAYMENTS]: {
    name: 'CoinPayments',
    fee: 0.005, // 0.5%
    instantSwap: false,
    noKYC: false, // KYC for large amounts
    minAmount: 0.001,
    maxAmount: null,
    supportedCoins: 1300, // Supports 1300+ coins
    apiUrl: 'https://www.coinpayments.net/api.php',
    apiKey: process.env.COINPAYMENTS_API_KEY,
    apiSecret: process.env.COINPAYMENTS_API_SECRET
  }
};

/**
 * External Service Converter
 */
export class ExternalServiceConverter extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      primaryService: config.primaryService || ConversionService.BTCPAY_LIGHTNING,
      fallbackServices: config.fallbackServices || [
        ConversionService.CHANGENOW,
        ConversionService.SIMPLESWAP
      ],
      maxRetries: config.maxRetries || 3,
      timeout: config.timeout || 30000,
      
      // Fee optimization
      maxAcceptableFee: config.maxAcceptableFee || 0.01, // 1% max
      preferNoKYC: config.preferNoKYC !== false,
      
      // Lightning Network settings
      lightningEnabled: config.lightningEnabled !== false,
      lightningNodeUrl: config.lightningNodeUrl || process.env.LIGHTNING_NODE_URL,
      
      // Caching
      rateCacheTime: config.rateCacheTime || 60000, // 1 minute
      
      // Bulk optimization
      bulkOptimizationEnabled: config.bulkOptimizationEnabled !== false
    };
    
    // Service instances
    this.services = new Map();
    this.rateCache = new Map();
    
    // Statistics
    this.stats = {
      conversions: 0,
      totalVolume: 0,
      totalFeesSaved: 0,
      serviceUsage: {}
    };
    
    // Initialize services
    this.initializeServices();
    
    // Initialize bulk optimizer if enabled
    if (this.config.bulkOptimizationEnabled) {
      this.bulkOptimizer = new BulkConversionOptimizer({
        batchingEnabled: true,
        preferredServices: [this.config.primaryService, ...this.config.fallbackServices]
      });
      this.bulkOptimizer.start();
    }
  }
  
  /**
   * Initialize external services
   */
  initializeServices() {
    // Initialize BTCPay Lightning if enabled
    if (this.config.lightningEnabled) {
      this.services.set(ConversionService.BTCPAY_LIGHTNING, {
        ...SERVICE_CONFIG[ConversionService.BTCPAY_LIGHTNING],
        initialized: true,
        executeBulkConversion: this.createBulkConversionHandler(ConversionService.BTCPAY_LIGHTNING)
      });
    }
    
    // Initialize swap services
    for (const service of Object.keys(SERVICE_CONFIG)) {
      if (SERVICE_CONFIG[service].apiKey || service === ConversionService.BTCPAY_LIGHTNING) {
        this.services.set(service, {
          ...SERVICE_CONFIG[service],
          initialized: true,
          executeBulkConversion: this.createBulkConversionHandler(service)
        });
      }
    }
    
    logger.info(`Initialized ${this.services.size} conversion services`);
  }
  
  /**
   * Get best conversion rate
   */
  async getBestConversionRate(fromCoin, toCoin, amount) {
    const cacheKey = `${fromCoin}:${toCoin}:${amount}`;
    const cached = this.rateCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.config.rateCacheTime) {
      return cached.rate;
    }
    
    const rates = [];
    
    // Check each service
    for (const [serviceId, service] of this.services) {
      try {
        const rate = await this.getServiceRate(serviceId, fromCoin, toCoin, amount);
        if (rate) {
          rates.push({
            service: serviceId,
            ...rate
          });
        }
      } catch (error) {
        logger.error(`Failed to get rate from ${serviceId}:`, error);
      }
    }
    
    // Sort by effective rate (after fees)
    rates.sort((a, b) => b.effectiveRate - a.effectiveRate);
    
    const bestRate = rates[0];
    if (bestRate) {
      this.rateCache.set(cacheKey, {
        rate: bestRate,
        timestamp: Date.now()
      });
    }
    
    return bestRate;
  }
  
  /**
   * Get rate from specific service
   */
  async getServiceRate(serviceId, fromCoin, toCoin, amount) {
    const service = this.services.get(serviceId);
    if (!service) return null;
    
    switch (serviceId) {
      case ConversionService.BTCPAY_LIGHTNING:
        return this.getBTCPayRate(fromCoin, toCoin, amount);
        
      case ConversionService.CHANGENOW:
        return this.getChangeNowRate(fromCoin, toCoin, amount);
        
      case ConversionService.SIMPLESWAP:
        return this.getSimpleSwapRate(fromCoin, toCoin, amount);
        
      case ConversionService.COINPAYMENTS:
        return this.getCoinPaymentsRate(fromCoin, toCoin, amount);
        
      default:
        return null;
    }
  }
  
  /**
   * Get BTCPay Lightning rate (for BTC conversions)
   */
  async getBTCPayRate(fromCoin, toCoin, amount) {
    if (toCoin !== 'BTC' || amount > SERVICE_CONFIG[ConversionService.BTCPAY_LIGHTNING].maxAmount) {
      return null;
    }
    
    // Lightning Network has virtually no fees
    const marketRate = await this.getMarketRate(fromCoin, 'BTC');
    
    return {
      rate: marketRate,
      fee: 0,
      effectiveRate: marketRate,
      estimatedAmount: amount * marketRate,
      instant: true,
      noKYC: true
    };
  }
  
  /**
   * Get ChangeNOW rate
   */
  async getChangeNowRate(fromCoin, toCoin, amount) {
    try {
      const response = await fetch(
        `${SERVICE_CONFIG[ConversionService.CHANGENOW].apiUrl}/exchange-amount/${amount}/${fromCoin}_${toCoin}?api_key=${SERVICE_CONFIG[ConversionService.CHANGENOW].apiKey}`
      );
      
      const data = await response.json();
      
      return {
        rate: data.rate || 0,
        fee: SERVICE_CONFIG[ConversionService.CHANGENOW].fee,
        effectiveRate: (data.rate || 0) * (1 - SERVICE_CONFIG[ConversionService.CHANGENOW].fee),
        estimatedAmount: data.estimatedAmount || 0,
        instant: true,
        noKYC: true
      };
    } catch (error) {
      logger.error('ChangeNOW rate error:', error);
      return null;
    }
  }
  
  /**
   * Get SimpleSwap rate
   */
  async getSimpleSwapRate(fromCoin, toCoin, amount) {
    try {
      const response = await fetch(
        `${SERVICE_CONFIG[ConversionService.SIMPLESWAP].apiUrl}/get_exchange_rate?api_key=${SERVICE_CONFIG[ConversionService.SIMPLESWAP].apiKey}&fixed=false&currency_from=${fromCoin}&currency_to=${toCoin}`
      );
      
      const data = await response.json();
      
      return {
        rate: parseFloat(data) || 0,
        fee: 0, // No explicit fee
        spread: SERVICE_CONFIG[ConversionService.SIMPLESWAP].estimatedSpread,
        effectiveRate: (parseFloat(data) || 0) * (1 - SERVICE_CONFIG[ConversionService.SIMPLESWAP].estimatedSpread),
        estimatedAmount: amount * (parseFloat(data) || 0),
        instant: true,
        noKYC: true
      };
    } catch (error) {
      logger.error('SimpleSwap rate error:', error);
      return null;
    }
  }
  
  /**
   * Get CoinPayments rate
   */
  async getCoinPaymentsRate(fromCoin, toCoin, amount) {
    // CoinPayments uses HMAC authentication
    const cmd = 'rates';
    const params = { short: 1 };
    
    try {
      const response = await this.coinPaymentsAPI(cmd, params);
      
      if (response && response[fromCoin] && response[toCoin]) {
        const fromRate = response[fromCoin].rate_btc;
        const toRate = response[toCoin].rate_btc;
        const rate = fromRate / toRate;
        
        return {
          rate: rate,
          fee: SERVICE_CONFIG[ConversionService.COINPAYMENTS].fee,
          effectiveRate: rate * (1 - SERVICE_CONFIG[ConversionService.COINPAYMENTS].fee),
          estimatedAmount: amount * rate * (1 - SERVICE_CONFIG[ConversionService.COINPAYMENTS].fee),
          instant: false,
          noKYC: false
        };
      }
    } catch (error) {
      logger.error('CoinPayments rate error:', error);
    }
    
    return null;
  }
  
  /**
   * Convert currency with automatic service selection
   */
  async convert(params) {
    const { fromCoin, toCoin, amount, address, preferredService, userId, allowBatching = true } = params;
    
    logger.info(`Converting ${amount} ${fromCoin} to ${toCoin}`, {
      address,
      preferredService,
      userId,
      allowBatching
    });
    
    // Check if should use bulk optimizer
    if (this.config.bulkOptimizationEnabled && allowBatching && !preferredService) {
      const minBatchSize = this.bulkOptimizer?.config.minBatchSize[fromCoin] || 50;
      
      // For smaller amounts, add to bulk queue
      if (amount < minBatchSize * 0.8) {
        return await this.bulkOptimizer.addConversion({
          fromCoin,
          toCoin,
          amount,
          address,
          userId,
          priority: false
        });
      }
    }
    
    // Otherwise, execute immediately
    return await this.executeConversion(fromCoin, toCoin, amount, address, preferredService);
  }
  
  /**
   * Get all available service rates
   */
  async getAllServiceRates(fromCoin, toCoin, amount) {
    const rates = [];
    const promises = [];
    
    // Query all services in parallel
    for (const [serviceId, service] of this.services) {
      if (!service.initialized) continue;
      
      promises.push(
        this.getServiceRate(serviceId, fromCoin, toCoin, amount)
          .then(rate => {
            if (rate) {
              rates.push({ service: serviceId, ...rate });
            }
          })
          .catch(error => {
            logger.debug(`Failed to get rate from ${serviceId}:`, error.message);
          })
      );
    }
    
    // Wait for all with timeout
    await Promise.race([
      Promise.allSettled(promises),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
    
    return rates;
  }
  
  /**
   * Execute conversion
   */
  async executeConversion(fromCoin, toCoin, amount, recipientAddress, preferredService = null) {
    // Get best rate
    const bestRate = preferredService 
      ? await this.getServiceRate(preferredService, fromCoin, toCoin, amount)
      : await this.getBestConversionRate(fromCoin, toCoin, amount);
    if (!bestRate) {
      throw new Error('No conversion service available');
    }
    
    logger.info(`Converting ${amount} ${fromCoin} to ${toCoin} via ${bestRate.service}`);
    
    try {
      let result;
      
      switch (bestRate.service) {
        case ConversionService.BTCPAY_LIGHTNING:
          result = await this.executeLightningConversion(fromCoin, amount, recipientAddress);
          break;
          
        case ConversionService.CHANGENOW:
          result = await this.executeChangeNowConversion(fromCoin, toCoin, amount, recipientAddress);
          break;
          
        case ConversionService.SIMPLESWAP:
          result = await this.executeSimpleSwapConversion(fromCoin, toCoin, amount, recipientAddress);
          break;
          
        case ConversionService.COINPAYMENTS:
          result = await this.executeCoinPaymentsConversion(fromCoin, toCoin, amount, recipientAddress);
          break;
          
        default:
          throw new Error('Service not implemented');
      }
      
      // Update statistics
      this.updateStatistics(bestRate.service, amount, bestRate.fee);
      
      return {
        ...result,
        service: bestRate.service,
        rate: bestRate.rate,
        fee: bestRate.fee
      };
      
    } catch (error) {
      logger.error('Conversion execution failed:', error);
      
      // Try fallback service
      if (this.config.fallbackServices.length > 0) {
        logger.info('Trying fallback service...');
        return this.executeFallbackConversion(fromCoin, toCoin, amount, recipientAddress);
      }
      
      throw error;
    }
  }
  
  /**
   * Execute Lightning Network conversion
   */
  async executeLightningConversion(fromCoin, amount, recipientAddress) {
    // Create Lightning invoice
    const invoice = await this.createLightningInvoice(amount, recipientAddress);
    
    return {
      success: true,
      transactionId: invoice.payment_hash,
      invoice: invoice.payment_request,
      estimatedTime: 'instant',
      type: 'lightning'
    };
  }
  
  /**
   * Execute ChangeNOW conversion
   */
  async executeChangeNowConversion(fromCoin, toCoin, amount, recipientAddress) {
    const params = {
      from: fromCoin.toLowerCase(),
      to: toCoin.toLowerCase(),
      amount: amount,
      address: recipientAddress,
      flow: 'standard'
    };
    
    const response = await fetch(
      `${SERVICE_CONFIG[ConversionService.CHANGENOW].apiUrl}/transactions/${SERVICE_CONFIG[ConversionService.CHANGENOW].apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      }
    );
    
    const data = await response.json();
    
    return {
      success: true,
      transactionId: data.id,
      payinAddress: data.payinAddress,
      payoutAddress: data.payoutAddress,
      estimatedTime: '10-30 minutes',
      type: 'swap'
    };
  }
  
  /**
   * Execute SimpleSwap conversion
   */
  async executeSimpleSwapConversion(fromCoin, toCoin, amount, recipientAddress) {
    const params = {
      fixed: false,
      currency_from: fromCoin.toLowerCase(),
      currency_to: toCoin.toLowerCase(),
      amount: amount,
      address_to: recipientAddress,
      api_key: SERVICE_CONFIG[ConversionService.SIMPLESWAP].apiKey
    };
    
    const response = await fetch(
      `${SERVICE_CONFIG[ConversionService.SIMPLESWAP].apiUrl}/create_exchange`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      }
    );
    
    const data = await response.json();
    
    return {
      success: true,
      transactionId: data.id,
      payinAddress: data.address_from,
      payoutAddress: data.address_to,
      estimatedTime: '5-30 minutes',
      type: 'swap'
    };
  }
  
  /**
   * Execute fallback conversion
   */
  async executeFallbackConversion(fromCoin, toCoin, amount, recipientAddress) {
    for (const serviceId of this.config.fallbackServices) {
      try {
        const rate = await this.getServiceRate(serviceId, fromCoin, toCoin, amount);
        if (rate && rate.fee <= this.config.maxAcceptableFee) {
          logger.info(`Using fallback service: ${serviceId}`);
          
          // Recursively call with specific service
          const originalPrimary = this.config.primaryService;
          this.config.primaryService = serviceId;
          const result = await this.executeConversion(fromCoin, toCoin, amount, recipientAddress);
          this.config.primaryService = originalPrimary;
          
          return result;
        }
      } catch (error) {
        logger.error(`Fallback service ${serviceId} failed:`, error);
      }
    }
    
    throw new Error('All conversion services failed');
  }
  
  /**
   * Get market rate (fallback)
   */
  async getMarketRate(fromCoin, toCoin) {
    // Use CoinGecko or similar for market rates
    try {
      const response = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${fromCoin.toLowerCase()}&vs_currencies=${toCoin.toLowerCase()}`
      );
      const data = await response.json();
      return data[fromCoin.toLowerCase()]?.[toCoin.toLowerCase()] || 0;
    } catch (error) {
      logger.error('Market rate fetch failed:', error);
      return 0;
    }
  }
  
  /**
   * Create Lightning invoice
   */
  async createLightningInvoice(amount, description) {
    // BTCPay Server API call
    const response = await fetch(`${SERVICE_CONFIG[ConversionService.BTCPAY_LIGHTNING].apiUrl}/api/v1/invoices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BTCPAY_API_KEY}`
      },
      body: JSON.stringify({
        amount: amount,
        currency: 'BTC',
        description: description || 'Otedama Pool Payout'
      })
    });
    
    return response.json();
  }
  
  /**
   * CoinPayments API helper
   */
  async coinPaymentsAPI(cmd, params = {}) {
    const paramString = new URLSearchParams({ 
      ...params, 
      version: 1, 
      cmd: cmd,
      key: SERVICE_CONFIG[ConversionService.COINPAYMENTS].apiKey
    }).toString();
    
    const hmac = crypto.createHmac('sha512', SERVICE_CONFIG[ConversionService.COINPAYMENTS].apiSecret);
    hmac.update(paramString);
    
    const response = await fetch(SERVICE_CONFIG[ConversionService.COINPAYMENTS].apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'HMAC': hmac.digest('hex')
      },
      body: paramString
    });
    
    const data = await response.json();
    return data.result;
  }
  
  /**
   * Update statistics
   */
  updateStatistics(service, amount, fee) {
    this.stats.conversions++;
    this.stats.totalVolume += amount;
    
    // Calculate fee savings vs traditional exchange (2.5% average)
    const traditionalFee = amount * 0.025;
    const actualFee = amount * fee;
    this.stats.totalFeesSaved += (traditionalFee - actualFee);
    
    // Track service usage
    if (!this.stats.serviceUsage[service]) {
      this.stats.serviceUsage[service] = 0;
    }
    this.stats.serviceUsage[service]++;
    
    this.emit('stats:updated', this.stats);
  }
  
  /**
   * Create bulk conversion handler for service
   */
  createBulkConversionHandler(serviceId) {
    return async (params) => {
      const { fromCoin, toCoin, amount, addresses } = params;
      
      switch (serviceId) {
        case ConversionService.SIMPLESWAP:
          return await this.executeBulkSimpleSwap(params);
          
        case ConversionService.CHANGENOW:
          return await this.executeBulkChangeNOW(params);
          
        case ConversionService.COINPAYMENTS:
          return await this.executeBulkCoinPayments(params);
          
        default:
          // Fallback to individual conversions
          const results = [];
          for (const addr of addresses) {
            const result = await this.executeConversion(
              fromCoin,
              toCoin,
              addr.amount,
              addr.address,
              serviceId
            );
            results.push(result);
          }
          return {
            success: true,
            transactions: results,
            fee: amount * (this.services.get(serviceId)?.fee || 0)
          };
      }
    };
  }
  
  /**
   * Execute bulk conversion with SimpleSwap
   */
  async executeBulkSimpleSwap(params) {
    const { fromCoin, toCoin, amount, addresses } = params;
    
    try {
      // SimpleSwap supports bulk via multiple outputs
      const response = await fetch(
        `${SERVICE_CONFIG[ConversionService.SIMPLESWAP].apiUrl}/create_exchange`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            fixed: false,
            currency_from: fromCoin.toLowerCase(),
            currency_to: toCoin.toLowerCase(),
            amount: amount,
            api_key: SERVICE_CONFIG[ConversionService.SIMPLESWAP].apiKey,
            multiple_outputs: addresses.map(a => ({
              address: a.address,
              amount: a.amount
            }))
          })
        }
      );
      
      const data = await response.json();
      
      return {
        success: true,
        exchangeId: data.id,
        depositAddress: data.address_from,
        fee: amount * 0.005, // 0.5% spread
        transactions: addresses.map((a, i) => ({
          address: a.address,
          amount: a.amount,
          txId: `simpleswap_bulk_${data.id}_${i}`
        }))
      };
      
    } catch (error) {
      logger.error('SimpleSwap bulk conversion failed:', error);
      throw error;
    }
  }
  
  /**
   * Execute bulk conversion with ChangeNOW
   */
  async executeBulkChangeNOW(params) {
    const { fromCoin, toCoin, amount, addresses } = params;
    
    try {
      // ChangeNOW bulk API
      const response = await fetch(
        `${SERVICE_CONFIG[ConversionService.CHANGENOW].apiUrl}/v2/exchanges/bulk`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-changenow-api-key': SERVICE_CONFIG[ConversionService.CHANGENOW].apiKey
          },
          body: JSON.stringify({
            fromCurrency: fromCoin.toLowerCase(),
            toCurrency: toCoin.toLowerCase(),
            fromAmount: amount,
            flow: 'standard',
            type: 'direct',
            payouts: addresses.map(a => ({
              address: a.address,
              amount: a.amount,
              extraId: a.userId
            }))
          })
        }
      );
      
      const data = await response.json();
      
      return {
        success: true,
        exchangeId: data.id,
        depositAddress: data.payinAddress,
        fee: amount * 0.005, // 0.5% fee
        transactions: data.payouts?.map(p => ({
          address: p.address,
          amount: p.amount,
          txId: p.id
        })) || []
      };
      
    } catch (error) {
      logger.error('ChangeNOW bulk conversion failed:', error);
      throw error;
    }
  }
  
  /**
   * Execute bulk conversion with CoinPayments
   */
  async executeBulkCoinPayments(params) {
    const { fromCoin, toCoin, amount, addresses } = params;
    
    try {
      // CoinPayments mass withdrawal API
      const withdrawals = addresses.map(a => ({
        currency: toCoin,
        amount: a.amount,
        address: a.address,
        auto_confirm: 1
      }));
      
      const hmac = this.generateCoinPaymentsHMAC('create_mass_withdrawal', { wd: JSON.stringify(withdrawals) });
      
      const response = await fetch(SERVICE_CONFIG[ConversionService.COINPAYMENTS].apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'HMAC': hmac
        },
        body: new URLSearchParams({
          version: 1,
          cmd: 'create_mass_withdrawal',
          key: SERVICE_CONFIG[ConversionService.COINPAYMENTS].apiKey,
          format: 'json',
          wd: JSON.stringify(withdrawals)
        })
      });
      
      const data = await response.json();
      
      return {
        success: true,
        batchId: data.result?.batch_id,
        fee: amount * 0.005, // 0.5% fee
        transactions: Object.entries(data.result?.wd || {}).map(([id, tx]) => ({
          address: tx.address,
          amount: tx.amount,
          txId: id,
          status: tx.status
        }))
      };
      
    } catch (error) {
      logger.error('CoinPayments bulk conversion failed:', error);
      throw error;
    }
  }
  
  /**
   * Generate CoinPayments HMAC
   */
  generateCoinPaymentsHMAC(cmd, params = {}) {
    const paramString = new URLSearchParams({ 
      ...params, 
      version: 1, 
      cmd: cmd,
      key: SERVICE_CONFIG[ConversionService.COINPAYMENTS].apiKey
    }).toString();
    
    const hmac = crypto.createHmac('sha512', SERVICE_CONFIG[ConversionService.COINPAYMENTS].apiSecret);
    hmac.update(paramString);
    
    return hmac.digest('hex');
  }
  
  /**
   * Get conversion statistics
   */
  getStats() {
    const bulkStats = this.bulkOptimizer?.getStats() || {};
    
    return {
      ...this.stats,
      averageFeeRate: this.stats.totalVolume > 0 
        ? ((this.stats.totalVolume - this.stats.totalFeesSaved) / this.stats.totalVolume)
        : 0,
      servicesAvailable: this.services.size,
      primaryService: SERVICE_CONFIG[this.config.primaryService]?.name,
      bulkOptimization: {
        enabled: this.config.bulkOptimizationEnabled,
        ...bulkStats
      }
    };
  }
}

export default ExternalServiceConverter;