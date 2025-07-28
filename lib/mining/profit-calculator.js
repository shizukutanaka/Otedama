/**
 * Real-time Profit Calculator - Otedama
 * Calculates mining profitability based on current market conditions
 * 
 * Design: Rob Pike - Simplicity in interface and calculation
 * Performance: John Carmack - Efficient real-time calculations
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { CryptoUtils } from '../security/crypto-utils.js';

const logger = createStructuredLogger('ProfitCalculator');

/**
 * Coin configurations with current network data
 */
export const CoinConfigs = {
  BTC: {
    algorithm: 'sha256',
    blockReward: 6.25,
    blockTime: 600, // seconds
    unit: 'TH/s'
  },
  ETH: {
    algorithm: 'ethash',
    blockReward: 2.0,
    blockTime: 13,
    unit: 'MH/s'
  },
  LTC: {
    algorithm: 'scrypt',
    blockReward: 12.5,
    blockTime: 150,
    unit: 'MH/s'
  },
  RVN: {
    algorithm: 'kawpow',
    blockReward: 5000,
    blockTime: 60,
    unit: 'MH/s'
  },
  XMR: {
    algorithm: 'randomx',
    blockReward: 0.6,
    blockTime: 120,
    unit: 'KH/s'
  }
};

/**
 * Profit Calculator for real-time mining profitability
 */
export class ProfitCalculator extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      updateInterval: config.updateInterval || 60000, // 1 minute
      priceFeedUrl: config.priceFeedUrl || 'https://api.coingecko.com/api/v3/simple/price',
      electricityCost: config.electricityCost || 0.10, // $/kWh default
      poolFee: config.poolFee || 1.0, // 1% default
      currencies: config.currencies || ['USD', 'EUR', 'JPY', 'CNY'],
      coins: config.coins || Object.keys(CoinConfigs),
      ...config
    };
    
    // State
    this.prices = new Map();
    this.difficulties = new Map();
    this.exchangeRates = new Map();
    this.profitCache = new Map();
    
    // Timers
    this.updateTimer = null;
    this.priceHistory = new Map();
    
    this.initialize();
  }
  
  /**
   * Initialize calculator
   */
  async initialize() {
    try {
      // Set default exchange rates
      this.exchangeRates.set('USD', 1.0);
      
      // Start price updates
      await this.updatePrices();
      await this.updateDifficulties();
      
      // Start periodic updates
      this.startUpdates();
      
      logger.info('Profit calculator initialized', {
        coins: this.config.coins,
        currencies: this.config.currencies
      });
      
    } catch (error) {
      logger.error('Failed to initialize profit calculator:', error);
    }
  }
  
  /**
   * Calculate profit for specific hardware
   */
  calculateProfit(hardware, options = {}) {
    const {
      coin = 'BTC',
      currency = 'USD',
      electricityCost = this.config.electricityCost,
      duration = 24 // hours
    } = options;
    
    // Get coin config
    const coinConfig = CoinConfigs[coin];
    if (!coinConfig) {
      throw new Error(`Unknown coin: ${coin}`);
    }
    
    // Get current price
    const price = this.getPrice(coin, currency);
    if (!price) {
      throw new Error(`No price data for ${coin}/${currency}`);
    }
    
    // Get network difficulty
    const difficulty = this.getDifficulty(coin);
    if (!difficulty) {
      throw new Error(`No difficulty data for ${coin}`);
    }
    
    // Calculate hashrate in standard units
    const hashrate = this.normalizeHashrate(hardware.hashrate, hardware.unit, coinConfig.unit);
    
    // Calculate coins mined per day
    const coinsPerDay = this.calculateCoinsPerDay(
      hashrate,
      difficulty,
      coinConfig.blockReward,
      coinConfig.blockTime
    );
    
    // Calculate revenue
    const grossRevenue = coinsPerDay * price * (duration / 24);
    
    // Calculate costs
    const powerConsumption = hardware.power || 0; // Watts
    const energyUsed = (powerConsumption / 1000) * duration; // kWh
    const electricityCosts = energyUsed * electricityCost;
    
    // Calculate net profit
    const poolFeeAmount = grossRevenue * (this.config.poolFee / 100);
    const netRevenue = grossRevenue - poolFeeAmount;
    const netProfit = netRevenue - electricityCosts;
    
    // Calculate ROI metrics
    const dailyProfit = netProfit * (24 / duration);
    const monthlyProfit = dailyProfit * 30;
    const yearlyProfit = dailyProfit * 365;
    
    // Profitability ratio
    const profitabilityRatio = grossRevenue > 0 ? (netProfit / grossRevenue) : 0;
    
    const result = {
      coin,
      currency,
      price,
      difficulty,
      hashrate: {
        value: hardware.hashrate,
        unit: hardware.unit,
        normalized: hashrate,
        normalizedUnit: coinConfig.unit
      },
      mining: {
        coinsPerDay,
        coinsPerHour: coinsPerDay / 24,
        blocksPerDay: (24 * 3600) / coinConfig.blockTime * (hashrate / difficulty)
      },
      revenue: {
        gross: grossRevenue,
        poolFee: poolFeeAmount,
        net: netRevenue
      },
      costs: {
        electricity: electricityCosts,
        powerConsumption: powerConsumption,
        energyUsed: energyUsed,
        electricityRate: electricityCost
      },
      profit: {
        net: netProfit,
        daily: dailyProfit,
        monthly: monthlyProfit,
        yearly: yearlyProfit,
        profitabilityRatio: profitabilityRatio,
        profitable: netProfit > 0
      },
      efficiency: {
        revenuePerKwh: energyUsed > 0 ? netRevenue / energyUsed : 0,
        profitPerKwh: energyUsed > 0 ? netProfit / energyUsed : 0,
        wattsPerCoin: coinsPerDay > 0 ? (powerConsumption * 24) / coinsPerDay : 0
      },
      timestamp: Date.now()
    };
    
    // Cache result
    const cacheKey = this.getCacheKey(hardware, options);
    this.profitCache.set(cacheKey, result);
    
    return result;
  }
  
  /**
   * Calculate profit for multiple coins
   */
  calculateMultiCoinProfit(hardware, options = {}) {
    const results = [];
    
    for (const coin of this.config.coins) {
      try {
        // Check if hardware supports this coin's algorithm
        const coinConfig = CoinConfigs[coin];
        if (!this.isAlgorithmSupported(hardware, coinConfig.algorithm)) {
          continue;
        }
        
        const profit = this.calculateProfit(hardware, { ...options, coin });
        results.push(profit);
        
      } catch (error) {
        logger.warn(`Failed to calculate profit for ${coin}:`, error.message);
      }
    }
    
    // Sort by profitability
    results.sort((a, b) => b.profit.daily - a.profit.daily);
    
    return results;
  }
  
  /**
   * Find most profitable coin
   */
  findMostProfitable(hardware, options = {}) {
    const results = this.calculateMultiCoinProfit(hardware, options);
    return results.length > 0 ? results[0] : null;
  }
  
  /**
   * Calculate profitability trends
   */
  calculateTrends(coin, duration = 24) {
    const history = this.priceHistory.get(coin) || [];
    if (history.length < 2) {
      return null;
    }
    
    const now = Date.now();
    const cutoff = now - (duration * 3600 * 1000);
    
    // Filter relevant history
    const relevantHistory = history.filter(h => h.timestamp >= cutoff);
    if (relevantHistory.length < 2) {
      return null;
    }
    
    // Calculate price change
    const oldestPrice = relevantHistory[0].price;
    const latestPrice = relevantHistory[relevantHistory.length - 1].price;
    const priceChange = ((latestPrice - oldestPrice) / oldestPrice) * 100;
    
    // Calculate average
    const avgPrice = relevantHistory.reduce((sum, h) => sum + h.price, 0) / relevantHistory.length;
    
    // Calculate volatility
    const variance = relevantHistory.reduce((sum, h) => {
      return sum + Math.pow(h.price - avgPrice, 2);
    }, 0) / relevantHistory.length;
    const volatility = Math.sqrt(variance);
    
    return {
      coin,
      duration,
      priceChange,
      oldestPrice,
      latestPrice,
      avgPrice,
      volatility,
      dataPoints: relevantHistory.length,
      trend: priceChange > 0 ? 'up' : priceChange < 0 ? 'down' : 'stable'
    };
  }
  
  /**
   * Calculate break-even analysis
   */
  calculateBreakEven(hardware, options = {}) {
    const {
      coin = 'BTC',
      currency = 'USD',
      hardwareCost = 0
    } = options;
    
    const dailyProfit = this.calculateProfit(hardware, options).profit.daily;
    
    if (dailyProfit <= 0) {
      return {
        possible: false,
        reason: 'Not profitable at current prices'
      };
    }
    
    const daysToBreakEven = hardwareCost / dailyProfit;
    const breakEvenDate = new Date(Date.now() + (daysToBreakEven * 24 * 3600 * 1000));
    
    return {
      possible: true,
      hardwareCost,
      dailyProfit,
      daysToBreakEven: Math.ceil(daysToBreakEven),
      breakEvenDate,
      monthsToBreakEven: daysToBreakEven / 30,
      yearsToBreakEven: daysToBreakEven / 365
    };
  }
  
  /**
   * Update cryptocurrency prices
   */
  async updatePrices() {
    try {
      // In production, use actual API
      // For now, use mock prices
      const mockPrices = {
        bitcoin: { usd: 65000, eur: 60000, jpy: 9750000, cny: 468000 },
        ethereum: { usd: 3200, eur: 2950, jpy: 480000, cny: 23000 },
        litecoin: { usd: 85, eur: 78, jpy: 12750, cny: 612 },
        ravencoin: { usd: 0.025, eur: 0.023, jpy: 3.75, cny: 0.18 },
        monero: { usd: 160, eur: 147, jpy: 24000, cny: 1152 }
      };
      
      // Map to our coin symbols
      const coinMap = {
        bitcoin: 'BTC',
        ethereum: 'ETH',
        litecoin: 'LTC',
        ravencoin: 'RVN',
        monero: 'XMR'
      };
      
      // Update prices
      for (const [apiName, coinSymbol] of Object.entries(coinMap)) {
        const priceData = mockPrices[apiName];
        if (priceData) {
          for (const [currency, price] of Object.entries(priceData)) {
            const key = `${coinSymbol}_${currency.toUpperCase()}`;
            this.prices.set(key, price);
            
            // Update history
            this.addPriceHistory(coinSymbol, price);
          }
        }
      }
      
      logger.debug('Prices updated', { count: this.prices.size });
      this.emit('prices:updated');
      
    } catch (error) {
      logger.error('Failed to update prices:', error);
    }
  }
  
  /**
   * Update network difficulties
   */
  async updateDifficulties() {
    try {
      // Mock difficulties (in production, get from blockchain APIs)
      const mockDifficulties = {
        BTC: 75500000000000, // 75.5T
        ETH: 12500000000000, // 12.5P  
        LTC: 25000000,
        RVN: 150000,
        XMR: 350000000000
      };
      
      for (const [coin, difficulty] of Object.entries(mockDifficulties)) {
        this.difficulties.set(coin, difficulty);
      }
      
      logger.debug('Difficulties updated', { count: this.difficulties.size });
      this.emit('difficulties:updated');
      
    } catch (error) {
      logger.error('Failed to update difficulties:', error);
    }
  }
  
  /**
   * Calculate coins mined per day
   */
  calculateCoinsPerDay(hashrate, difficulty, blockReward, blockTime) {
    // Standard mining calculation
    const blocksPerDay = (24 * 3600) / blockTime;
    const networkHashrate = difficulty * (Math.pow(2, 32) / blockTime);
    const minerShare = hashrate / networkHashrate;
    
    return blocksPerDay * blockReward * minerShare;
  }
  
  /**
   * Normalize hashrate to standard units
   */
  normalizeHashrate(value, fromUnit, toUnit) {
    const units = {
      'H/s': 1,
      'KH/s': 1000,
      'MH/s': 1000000,
      'GH/s': 1000000000,
      'TH/s': 1000000000000,
      'PH/s': 1000000000000000
    };
    
    const fromMultiplier = units[fromUnit] || 1;
    const toMultiplier = units[toUnit] || 1;
    
    return (value * fromMultiplier) / toMultiplier;
  }
  
  /**
   * Check if hardware supports algorithm
   */
  isAlgorithmSupported(hardware, algorithm) {
    if (!hardware.algorithms) return true; // Assume supported if not specified
    
    return hardware.algorithms.includes(algorithm);
  }
  
  /**
   * Get current price
   */
  getPrice(coin, currency = 'USD') {
    const key = `${coin}_${currency.toUpperCase()}`;
    return this.prices.get(key) || null;
  }
  
  /**
   * Get network difficulty
   */
  getDifficulty(coin) {
    return this.difficulties.get(coin) || null;
  }
  
  /**
   * Add price to history
   */
  addPriceHistory(coin, price) {
    if (!this.priceHistory.has(coin)) {
      this.priceHistory.set(coin, []);
    }
    
    const history = this.priceHistory.get(coin);
    history.push({
      price,
      timestamp: Date.now()
    });
    
    // Keep only last 24 hours
    const cutoff = Date.now() - (24 * 3600 * 1000);
    const filtered = history.filter(h => h.timestamp >= cutoff);
    this.priceHistory.set(coin, filtered);
  }
  
  /**
   * Get cache key
   */
  getCacheKey(hardware, options) {
    return `${hardware.id}_${options.coin}_${options.currency}_${options.electricityCost}`;
  }
  
  /**
   * Start periodic updates
   */
  startUpdates() {
    this.updateTimer = setInterval(async () => {
      await this.updatePrices();
      await this.updateDifficulties();
      
      // Clear old cache entries
      this.clearOldCache();
      
    }, this.config.updateInterval);
  }
  
  /**
   * Clear old cache entries
   */
  clearOldCache() {
    const maxAge = 5 * 60 * 1000; // 5 minutes
    const cutoff = Date.now() - maxAge;
    
    for (const [key, value] of this.profitCache.entries()) {
      if (value.timestamp < cutoff) {
        this.profitCache.delete(key);
      }
    }
  }
  
  /**
   * Export profit data
   */
  exportProfitData() {
    const data = {
      prices: Object.fromEntries(this.prices),
      difficulties: Object.fromEntries(this.difficulties),
      exchangeRates: Object.fromEntries(this.exchangeRates),
      priceHistory: Object.fromEntries(this.priceHistory),
      timestamp: Date.now()
    };
    
    return data;
  }
  
  /**
   * Get statistics
   */
  getStatistics() {
    return {
      priceCount: this.prices.size,
      difficultyCount: this.difficulties.size,
      cacheSize: this.profitCache.size,
      historySize: Array.from(this.priceHistory.values())
        .reduce((sum, h) => sum + h.length, 0),
      lastUpdate: this.lastUpdate || null
    };
  }
  
  /**
   * Shutdown calculator
   */
  shutdown() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    
    this.removeAllListeners();
    logger.info('Profit calculator shutdown');
  }
}

/**
 * Create profit calculator instance
 */
export function createProfitCalculator(config) {
  return new ProfitCalculator(config);
}

export default ProfitCalculator;