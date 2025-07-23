/**
 * Multi-Coin Profit Switching Engine
 * Automatically switches mining to the most profitable coin
 * 
 * Features:
 * - Real-time profitability calculation
 * - Exchange rate monitoring
 * - Network difficulty tracking
 * - Smooth switching with minimal downtime
 * - Historical profitability analysis
 * - Fee consideration
 */

const { EventEmitter } = require('events');
const axios = require('axios');
const { createLogger } = require('../core/logger');

const logger = createLogger('profit-switching');

// Supported coins configuration
const COIN_CONFIG = {
  BTC: {
    algorithm: 'sha256',
    blockTime: 600,
    blockReward: 6.25,
    api: {
      difficulty: 'https://blockchain.info/q/getdifficulty',
      price: 'coingecko'
    }
  },
  BCH: {
    algorithm: 'sha256',
    blockTime: 600,
    blockReward: 6.25,
    api: {
      difficulty: 'https://api.blockchair.com/bitcoin-cash/stats',
      price: 'coingecko'
    }
  },
  LTC: {
    algorithm: 'scrypt',
    blockTime: 150,
    blockReward: 12.5,
    api: {
      difficulty: 'https://api.blockchair.com/litecoin/stats',
      price: 'coingecko'
    }
  },
  ETH: {
    algorithm: 'ethash',
    blockTime: 13,
    blockReward: 2,
    api: {
      difficulty: 'https://api.etherscan.io/api',
      price: 'coingecko'
    }
  },
  RVN: {
    algorithm: 'kawpow',
    blockTime: 60,
    blockReward: 5000,
    api: {
      difficulty: 'https://api.ravencoin.org/api/getdifficulty',
      price: 'coingecko'
    }
  },
  ERG: {
    algorithm: 'autolykos',
    blockTime: 120,
    blockReward: 66,
    api: {
      difficulty: 'https://api.ergoplatform.com/api/v1/stats',
      price: 'coingecko'
    }
  }
};

// Exchange APIs
const EXCHANGE_APIS = {
  coingecko: {
    url: 'https://api.coingecko.com/api/v3/simple/price',
    rateLimit: 50, // requests per minute
    lastCall: 0
  },
  binance: {
    url: 'https://api.binance.com/api/v3/ticker/price',
    rateLimit: 1200,
    lastCall: 0
  },
  kraken: {
    url: 'https://api.kraken.com/0/public/Ticker',
    rateLimit: 60,
    lastCall: 0
  }
};

class ProfitabilityCalculator {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 60000; // 1 minute
  }

  /**
   * Calculate profitability for a coin
   */
  calculateProfitability(coin, networkDifficulty, price, hashrate, powerCost = 0) {
    const config = COIN_CONFIG[coin];
    if (!config) return null;
    
    // Calculate expected blocks per day
    const dailyBlocks = (86400 / config.blockTime) * (hashrate / networkDifficulty);
    
    // Calculate daily revenue
    const dailyCoins = dailyBlocks * config.blockReward;
    const dailyRevenue = dailyCoins * price;
    
    // Calculate power cost (if provided)
    const dailyPowerCost = powerCost * 24; // kWh * hours
    
    // Net profit
    const dailyProfit = dailyRevenue - dailyPowerCost;
    
    return {
      coin,
      algorithm: config.algorithm,
      difficulty: networkDifficulty,
      price,
      hashrate,
      dailyBlocks,
      dailyCoins,
      dailyRevenue,
      dailyPowerCost,
      dailyProfit,
      profitPerMH: dailyProfit / (hashrate / 1000000),
      calculatedAt: Date.now()
    };
  }

  /**
   * Get profitability from cache or calculate
   */
  getProfitability(coin, networkDifficulty, price, hashrate, powerCost) {
    const cacheKey = `${coin}:${hashrate}:${powerCost}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && (Date.now() - cached.calculatedAt) < this.cacheTimeout) {
      return cached;
    }
    
    const profitability = this.calculateProfitability(
      coin,
      networkDifficulty,
      price,
      hashrate,
      powerCost
    );
    
    this.cache.set(cacheKey, profitability);
    return profitability;
  }

  /**
   * Compare profitabilities
   */
  compareProfitabilities(profitabilities) {
    return profitabilities.sort((a, b) => b.dailyProfit - a.dailyProfit);
  }
}

class MarketDataFetcher {
  constructor() {
    this.priceCache = new Map();
    this.difficultyCache = new Map();
    this.cacheTimeout = 300000; // 5 minutes
  }

  /**
   * Fetch current price for a coin
   */
  async fetchPrice(coin, currency = 'usd') {
    const cacheKey = `${coin}:${currency}`;
    const cached = this.priceCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
      return cached.price;
    }
    
    try {
      // Try CoinGecko first
      const price = await this.fetchFromCoinGecko(coin, currency);
      
      this.priceCache.set(cacheKey, {
        price,
        timestamp: Date.now()
      });
      
      return price;
    } catch (error) {
      logger.error(`Failed to fetch price for ${coin}:`, error);
      
      // Return cached price if available
      if (cached) {
        return cached.price;
      }
      
      throw error;
    }
  }

  async fetchFromCoinGecko(coin, currency) {
    const coinIds = {
      BTC: 'bitcoin',
      BCH: 'bitcoin-cash',
      LTC: 'litecoin',
      ETH: 'ethereum',
      RVN: 'ravencoin',
      ERG: 'ergo'
    };
    
    const coinId = coinIds[coin];
    if (!coinId) {
      throw new Error(`Unknown coin: ${coin}`);
    }
    
    // Rate limiting
    const api = EXCHANGE_APIS.coingecko;
    const now = Date.now();
    const timeSinceLastCall = now - api.lastCall;
    const minInterval = 60000 / api.rateLimit;
    
    if (timeSinceLastCall < minInterval) {
      await new Promise(resolve => setTimeout(resolve, minInterval - timeSinceLastCall));
    }
    
    api.lastCall = Date.now();
    
    const response = await axios.get(api.url, {
      params: {
        ids: coinId,
        vs_currencies: currency
      }
    });
    
    return response.data[coinId][currency];
  }

  /**
   * Fetch network difficulty
   */
  async fetchDifficulty(coin) {
    const cached = this.difficultyCache.get(coin);
    
    if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
      return cached.difficulty;
    }
    
    try {
      const config = COIN_CONFIG[coin];
      let difficulty;
      
      switch (coin) {
        case 'BTC':
          const btcResponse = await axios.get(config.api.difficulty);
          difficulty = parseFloat(btcResponse.data);
          break;
          
        case 'ETH':
          // ETH uses different difficulty format
          const ethResponse = await axios.get(config.api.difficulty, {
            params: {
              module: 'proxy',
              action: 'eth_blockNumber'
            }
          });
          // Convert to difficulty (simplified)
          difficulty = parseInt(ethResponse.data.result, 16) * 1000000;
          break;
          
        case 'RVN':
          const rvnResponse = await axios.get(config.api.difficulty);
          difficulty = rvnResponse.data;
          break;
          
        default:
          // Generic API call
          const response = await axios.get(config.api.difficulty);
          difficulty = response.data.difficulty || response.data.data.difficulty;
      }
      
      this.difficultyCache.set(coin, {
        difficulty,
        timestamp: Date.now()
      });
      
      return difficulty;
    } catch (error) {
      logger.error(`Failed to fetch difficulty for ${coin}:`, error);
      
      // Return cached if available
      if (cached) {
        return cached.difficulty;
      }
      
      throw error;
    }
  }
}

class ProfitSwitchingEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      enabled: options.enabled !== false,
      checkInterval: options.checkInterval || 300000, // 5 minutes
      switchThreshold: options.switchThreshold || 0.05, // 5% improvement required
      minSwitchInterval: options.minSwitchInterval || 3600000, // 1 hour minimum between switches
      supportedCoins: options.supportedCoins || Object.keys(COIN_CONFIG),
      powerCost: options.powerCost || 0.10, // $/kWh
      powerUsage: options.powerUsage || 1.5, // kW
      hashrates: options.hashrates || {}, // Algorithm -> hashrate mapping
      fees: options.fees || {}, // Coin -> fee mapping
      ...options
    };
    
    this.calculator = new ProfitabilityCalculator();
    this.marketData = new MarketDataFetcher();
    
    this.currentCoin = options.defaultCoin || 'RVN';
    this.lastSwitch = Date.now();
    this.checkInterval = null;
    
    this.profitabilityHistory = [];
    this.switchHistory = [];
    
    // Statistics
    this.stats = {
      totalSwitches: 0,
      profitabilityChecks: 0,
      successfulSwitches: 0,
      failedSwitches: 0,
      totalProfit: 0
    };
  }

  /**
   * Start profit switching
   */
  async start() {
    if (!this.config.enabled) {
      logger.info('Profit switching is disabled');
      return;
    }
    
    logger.info('Starting profit switching engine...');
    
    // Initial profitability check
    await this.checkProfitability();
    
    // Start periodic checks
    this.checkInterval = setInterval(async () => {
      await this.checkProfitability();
    }, this.config.checkInterval);
    
    this.emit('started');
  }

  /**
   * Check profitability and switch if needed
   */
  async checkProfitability() {
    try {
      this.stats.profitabilityChecks++;
      
      const profitabilities = await this.calculateAllProfitabilities();
      
      // Sort by profitability
      const sorted = this.calculator.compareProfitabilities(profitabilities);
      
      // Store history
      this.profitabilityHistory.push({
        timestamp: Date.now(),
        profitabilities: sorted,
        currentCoin: this.currentCoin
      });
      
      // Keep only last 24 hours
      const cutoff = Date.now() - 86400000;
      this.profitabilityHistory = this.profitabilityHistory.filter(h => h.timestamp > cutoff);
      
      // Check if we should switch
      const mostProfitable = sorted[0];
      const currentProfitability = sorted.find(p => p.coin === this.currentCoin);
      
      if (this.shouldSwitch(mostProfitable, currentProfitability)) {
        await this.switchToCoin(mostProfitable.coin);
      }
      
      // Emit update
      this.emit('profitability:update', {
        current: currentProfitability,
        best: mostProfitable,
        all: sorted
      });
      
    } catch (error) {
      logger.error('Profitability check failed:', error);
      this.emit('error', error);
    }
  }

  /**
   * Calculate profitability for all supported coins
   */
  async calculateAllProfitabilities() {
    const profitabilities = [];
    
    for (const coin of this.config.supportedCoins) {
      try {
        const config = COIN_CONFIG[coin];
        const algorithm = config.algorithm;
        const hashrate = this.config.hashrates[algorithm] || 0;
        
        if (hashrate === 0) {
          logger.debug(`No hashrate configured for ${algorithm}, skipping ${coin}`);
          continue;
        }
        
        // Fetch market data
        const [price, difficulty] = await Promise.all([
          this.marketData.fetchPrice(coin),
          this.marketData.fetchDifficulty(coin)
        ]);
        
        // Calculate power cost
        const dailyPowerCost = this.config.powerUsage * this.config.powerCost * 24;
        
        // Calculate profitability
        let profitability = this.calculator.getProfitability(
          coin,
          difficulty,
          price,
          hashrate,
          dailyPowerCost
        );
        
        // Apply pool fees
        const poolFee = this.config.fees[coin] || 0.01; // 1% default
        profitability.dailyProfit *= (1 - poolFee);
        profitability.poolFee = poolFee;
        
        profitabilities.push(profitability);
        
      } catch (error) {
        logger.error(`Failed to calculate profitability for ${coin}:`, error);
      }
    }
    
    return profitabilities;
  }

  /**
   * Determine if we should switch coins
   */
  shouldSwitch(bestCoin, currentCoin) {
    if (!currentCoin || !bestCoin) return false;
    
    // Don't switch to the same coin
    if (bestCoin.coin === this.currentCoin) return false;
    
    // Check minimum switch interval
    const timeSinceLastSwitch = Date.now() - this.lastSwitch;
    if (timeSinceLastSwitch < this.config.minSwitchInterval) {
      logger.debug('Too soon to switch again');
      return false;
    }
    
    // Calculate improvement percentage
    const improvement = (bestCoin.dailyProfit - currentCoin.dailyProfit) / currentCoin.dailyProfit;
    
    logger.info(`Profit comparison: ${bestCoin.coin} would be ${(improvement * 100).toFixed(2)}% more profitable than ${this.currentCoin}`);
    
    // Check if improvement is above threshold
    return improvement > this.config.switchThreshold;
  }

  /**
   * Switch to a different coin
   */
  async switchToCoin(coin) {
    logger.info(`Switching from ${this.currentCoin} to ${coin}...`);
    
    try {
      this.stats.totalSwitches++;
      
      // Emit pre-switch event
      this.emit('switch:start', {
        from: this.currentCoin,
        to: coin,
        reason: 'profitability'
      });
      
      // Perform the switch
      const switchStart = Date.now();
      
      // Stop current mining
      await this.stopMining(this.currentCoin);
      
      // Update coin
      const previousCoin = this.currentCoin;
      this.currentCoin = coin;
      this.lastSwitch = Date.now();
      
      // Start new mining
      await this.startMining(coin);
      
      const switchDuration = Date.now() - switchStart;
      
      // Record switch
      this.switchHistory.push({
        timestamp: Date.now(),
        from: previousCoin,
        to: coin,
        duration: switchDuration,
        success: true
      });
      
      this.stats.successfulSwitches++;
      
      // Emit completion
      this.emit('switch:complete', {
        from: previousCoin,
        to: coin,
        duration: switchDuration
      });
      
      logger.info(`Successfully switched to ${coin} in ${switchDuration}ms`);
      
    } catch (error) {
      this.stats.failedSwitches++;
      
      logger.error(`Failed to switch to ${coin}:`, error);
      
      // Record failed switch
      this.switchHistory.push({
        timestamp: Date.now(),
        from: this.currentCoin,
        to: coin,
        duration: 0,
        success: false,
        error: error.message
      });
      
      this.emit('switch:failed', {
        from: this.currentCoin,
        to: coin,
        error
      });
      
      throw error;
    }
  }

  /**
   * Stop mining current coin
   */
  async stopMining(coin) {
    // This would integrate with your mining pool to stop mining
    // For now, just emit an event
    this.emit('mining:stop', { coin });
    
    // Simulate stopping time
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  /**
   * Start mining new coin
   */
  async startMining(coin) {
    // This would integrate with your mining pool to start mining
    // For now, just emit an event
    this.emit('mining:start', { coin });
    
    // Simulate starting time
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  /**
   * Get current status
   */
  getStatus() {
    const currentProfitability = this.profitabilityHistory.length > 0
      ? this.profitabilityHistory[this.profitabilityHistory.length - 1]
      : null;
    
    return {
      enabled: this.config.enabled,
      currentCoin: this.currentCoin,
      lastSwitch: this.lastSwitch,
      timeSinceLastSwitch: Date.now() - this.lastSwitch,
      currentProfitability: currentProfitability?.profitabilities.find(p => p.coin === this.currentCoin),
      bestCoin: currentProfitability?.profitabilities[0],
      stats: this.stats,
      recentSwitches: this.switchHistory.slice(-10)
    };
  }

  /**
   * Get profitability history
   */
  getProfitabilityHistory(duration = 86400000) { // 24 hours default
    const cutoff = Date.now() - duration;
    return this.profitabilityHistory.filter(h => h.timestamp > cutoff);
  }

  /**
   * Get profitability trends
   */
  getProfitabilityTrends() {
    const trends = {};
    
    for (const coin of this.config.supportedCoins) {
      const history = this.profitabilityHistory.map(h => {
        const prof = h.profitabilities.find(p => p.coin === coin);
        return {
          timestamp: h.timestamp,
          profit: prof?.dailyProfit || 0
        };
      });
      
      if (history.length < 2) {
        trends[coin] = { trend: 'unknown', change: 0 };
        continue;
      }
      
      // Calculate trend
      const recent = history.slice(-6); // Last 30 minutes
      const older = history.slice(-12, -6); // Previous 30 minutes
      
      const recentAvg = recent.reduce((sum, h) => sum + h.profit, 0) / recent.length;
      const olderAvg = older.reduce((sum, h) => sum + h.profit, 0) / older.length;
      
      const change = ((recentAvg - olderAvg) / olderAvg) * 100;
      
      trends[coin] = {
        trend: change > 0 ? 'up' : change < 0 ? 'down' : 'stable',
        change: change.toFixed(2)
      };
    }
    
    return trends;
  }

  /**
   * Force switch to specific coin
   */
  async forceSwitchTo(coin) {
    if (!this.config.supportedCoins.includes(coin)) {
      throw new Error(`Unsupported coin: ${coin}`);
    }
    
    if (coin === this.currentCoin) {
      throw new Error(`Already mining ${coin}`);
    }
    
    await this.switchToCoin(coin);
  }

  /**
   * Update configuration
   */
  updateConfig(config) {
    this.config = { ...this.config, ...config };
    
    // Restart if needed
    if (config.enabled !== undefined || config.checkInterval !== undefined) {
      this.stop();
      this.start();
    }
  }

  /**
   * Stop profit switching
   */
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    this.emit('stopped');
    logger.info('Profit switching engine stopped');
  }
}

module.exports = ProfitSwitchingEngine;