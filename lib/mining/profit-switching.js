/**
 * Simple Profit Switching System
 * Switches between algorithms based on profitability
 */

const { EventEmitter } = require('events');
const { createLogger } = require('../core/logger');
const axios = require('axios');

const logger = createLogger('profit-switching');

// Supported coins and their algorithms
const SUPPORTED_COINS = {
  BTC: { algorithm: 'sha256', api: 'bitcoin' },
  LTC: { algorithm: 'scrypt', api: 'litecoin' },
  ETH: { algorithm: 'ethash', api: 'ethereum' },
  ETC: { algorithm: 'ethash', api: 'ethereum-classic' },
  RVN: { algorithm: 'kawpow', api: 'ravencoin' },
  XMR: { algorithm: 'randomx', api: 'monero' },
  DOGE: { algorithm: 'scrypt', api: 'dogecoin' }
};

class ProfitSwitcher extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enabled: options.enabled !== false,
      checkInterval: options.checkInterval || 300000, // 5 minutes
      switchThreshold: options.switchThreshold || 1.05, // Switch if 5% more profitable
      cooldownPeriod: options.cooldownPeriod || 600000, // 10 minutes between switches
      apiKey: options.apiKey || null,
      powerCost: options.powerCost || 0.10, // $/kWh
      ...options
    };
    
    this.currentCoin = options.defaultCoin || 'BTC';
    this.currentAlgorithm = SUPPORTED_COINS[this.currentCoin].algorithm;
    this.lastSwitch = 0;
    this.profitData = new Map();
    this.checkInterval = null;
    
    logger.info('Profit switcher initialized', {
      enabled: this.options.enabled,
      currentCoin: this.currentCoin,
      supportedCoins: Object.keys(SUPPORTED_COINS)
    });
  }
  
  /**
   * Start profit monitoring
   */
  async start() {
    if (!this.options.enabled) {
      logger.info('Profit switching is disabled');
      return;
    }
    
    // Initial check
    await this.checkProfitability();
    
    // Set up periodic checks
    this.checkInterval = setInterval(() => {
      this.checkProfitability().catch(err => {
        logger.error('Profitability check failed:', err);
      });
    }, this.options.checkInterval);
    
    logger.info('Profit switcher started');
  }
  
  /**
   * Stop profit monitoring
   */
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    logger.info('Profit switcher stopped');
  }
  
  /**
   * Check profitability of all supported coins
   */
  async checkProfitability() {
    try {
      // Fetch current prices
      const prices = await this.fetchPrices();
      
      // Fetch network difficulty
      const difficulties = await this.fetchDifficulties();
      
      // Calculate profitability for each coin
      const profitabilities = new Map();
      
      for (const [coin, config] of Object.entries(SUPPORTED_COINS)) {
        const price = prices[coin] || 0;
        const difficulty = difficulties[coin] || 1;
        
        // Simple profitability calculation (revenue per hash)
        const profitability = this.calculateProfitability(coin, price, difficulty);
        profitabilities.set(coin, profitability);
        
        this.profitData.set(coin, {
          price,
          difficulty,
          profitability,
          timestamp: Date.now()
        });
      }
      
      // Find most profitable coin
      let bestCoin = this.currentCoin;
      let bestProfit = profitabilities.get(this.currentCoin);
      
      for (const [coin, profit] of profitabilities) {
        if (profit > bestProfit * this.options.switchThreshold) {
          bestCoin = coin;
          bestProfit = profit;
        }
      }
      
      // Switch if necessary
      if (bestCoin !== this.currentCoin && this.canSwitch()) {
        await this.switchToCoin(bestCoin);
      }
      
      // Emit profitability update
      this.emit('profitability-update', {
        current: this.currentCoin,
        profitabilities: Object.fromEntries(profitabilities),
        best: bestCoin,
        timestamp: Date.now()
      });
      
    } catch (error) {
      logger.error('Failed to check profitability:', error);
      this.emit('error', error);
    }
  }
  
  /**
   * Calculate profitability for a coin
   */
  calculateProfitability(coin, price, difficulty) {
    // Get coin-specific parameters
    const blockReward = this.getBlockReward(coin);
    const blockTime = this.getBlockTime(coin);
    
    // Calculate expected revenue per hash
    const revenuePerHash = (blockReward * price) / (difficulty * blockTime);
    
    // Subtract power costs (simplified)
    const powerCostPerHash = this.options.powerCost * 0.000001; // Approximate
    
    return revenuePerHash - powerCostPerHash;
  }
  
  /**
   * Get block reward for a coin
   */
  getBlockReward(coin) {
    const rewards = {
      BTC: 6.25,
      LTC: 12.5,
      ETH: 2,
      ETC: 3.2,
      RVN: 5000,
      XMR: 0.6,
      DOGE: 10000
    };
    
    return rewards[coin] || 1;
  }
  
  /**
   * Get block time for a coin (seconds)
   */
  getBlockTime(coin) {
    const times = {
      BTC: 600,
      LTC: 150,
      ETH: 13,
      ETC: 13,
      RVN: 60,
      XMR: 120,
      DOGE: 60
    };
    
    return times[coin] || 60;
  }
  
  /**
   * Fetch current prices
   */
  async fetchPrices() {
    try {
      // Use CoinGecko API (free tier)
      const coins = Object.values(SUPPORTED_COINS).map(c => c.api).join(',');
      const response = await axios.get(
        `https://api.coingecko.com/api/v3/simple/price?ids=${coins}&vs_currencies=usd`
      );
      
      // Map API names back to coin symbols
      const prices = {};
      for (const [coin, config] of Object.entries(SUPPORTED_COINS)) {
        prices[coin] = response.data[config.api]?.usd || 0;
      }
      
      return prices;
      
    } catch (error) {
      logger.error('Failed to fetch prices:', error);
      return {};
    }
  }
  
  /**
   * Fetch network difficulties (simplified)
   */
  async fetchDifficulties() {
    // In a real implementation, this would fetch from blockchain explorers
    // For now, return static values
    return {
      BTC: 50000000000000,
      LTC: 20000000,
      ETH: 15000000000000,
      ETC: 3000000000000,
      RVN: 100000,
      XMR: 300000000000,
      DOGE: 10000000
    };
  }
  
  /**
   * Check if we can switch (cooldown period)
   */
  canSwitch() {
    return Date.now() - this.lastSwitch > this.options.cooldownPeriod;
  }
  
  /**
   * Switch to a different coin
   */
  async switchToCoin(coin) {
    const oldCoin = this.currentCoin;
    const newAlgorithm = SUPPORTED_COINS[coin].algorithm;
    
    logger.info(`Switching from ${oldCoin} to ${coin}`);
    
    // Update current coin
    this.currentCoin = coin;
    this.currentAlgorithm = newAlgorithm;
    this.lastSwitch = Date.now();
    
    // Emit switch event
    this.emit('coin-switch', {
      from: oldCoin,
      to: coin,
      algorithm: newAlgorithm,
      timestamp: Date.now()
    });
    
    logger.info('Coin switch completed', {
      coin,
      algorithm: newAlgorithm
    });
  }
  
  /**
   * Get current profitability data
   */
  getProfitabilityData() {
    const data = {};
    
    for (const [coin, info] of this.profitData) {
      data[coin] = {
        ...info,
        isCurrent: coin === this.currentCoin
      };
    }
    
    return data;
  }
  
  /**
   * Manually switch to a coin
   */
  manualSwitch(coin) {
    if (!SUPPORTED_COINS[coin]) {
      throw new Error(`Unsupported coin: ${coin}`);
    }
    
    this.switchToCoin(coin);
  }
  
  /**
   * Get supported coins
   */
  getSupportedCoins() {
    return Object.keys(SUPPORTED_COINS);
  }
  
  /**
   * Get current status
   */
  getStatus() {
    return {
      enabled: this.options.enabled,
      currentCoin: this.currentCoin,
      currentAlgorithm: this.currentAlgorithm,
      lastSwitch: this.lastSwitch,
      profitData: this.getProfitabilityData(),
      supportedCoins: this.getSupportedCoins()
    };
  }
}

module.exports = ProfitSwitcher;