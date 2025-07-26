/**
 * Profit Switching Algorithm - Otedama
 * Automatically switches between coins for maximum profitability
 * Inspired by NiceHash and other profit-switching pools
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('ProfitSwitching');

/**
 * Coin profitability calculator
 */
export class ProfitabilityCalculator {
  constructor(options = {}) {
    this.config = {
      updateInterval: options.updateInterval || 300000, // 5 minutes
      exchangeRates: options.exchangeRates || {},
      powerCost: options.powerCost || 0.10, // $/kWh
      includeDevFee: options.includeDevFee !== false,
      ...options
    };
    
    this.algorithms = new Map();
    this.coins = new Map();
    this.currentProfitability = new Map();
  }
  
  /**
   * Register algorithm with hashrate and power consumption
   */
  registerAlgorithm(name, specs) {
    this.algorithms.set(name, {
      name,
      hashrate: specs.hashrate,
      powerConsumption: specs.powerConsumption,
      efficiency: specs.hashrate / specs.powerConsumption
    });
  }
  
  /**
   * Register coin with current network stats
   */
  registerCoin(symbol, data) {
    this.coins.set(symbol, {
      symbol,
      algorithm: data.algorithm,
      difficulty: data.difficulty,
      blockReward: data.blockReward,
      blockTime: data.blockTime,
      price: data.price,
      poolFee: data.poolFee || 0.01,
      lastUpdate: Date.now()
    });
  }
  
  /**
   * Calculate profitability for all coins
   */
  calculateProfitability() {
    const profitability = new Map();
    
    for (const [symbol, coin] of this.coins) {
      const algo = this.algorithms.get(coin.algorithm);
      if (!algo) continue;
      
      // Calculate coins per day
      const hashesPerDay = algo.hashrate * 86400;
      const networkHashrate = this.estimateNetworkHashrate(coin);
      const blocksPerDay = 86400 / coin.blockTime;
      const coinsPerDay = (hashesPerDay / networkHashrate) * coin.blockReward * blocksPerDay;
      
      // Calculate revenue
      const grossRevenue = coinsPerDay * coin.price;
      const poolFeeDeduction = grossRevenue * coin.poolFee;
      const netRevenue = grossRevenue - poolFeeDeduction;
      
      // Calculate costs
      const powerCostPerDay = (algo.powerConsumption / 1000) * 24 * this.config.powerCost;
      
      // Calculate profit
      const dailyProfit = netRevenue - powerCostPerDay;
      const profitPerMH = dailyProfit / (algo.hashrate / 1000000);
      
      profitability.set(symbol, {
        coin: symbol,
        algorithm: coin.algorithm,
        dailyRevenue: netRevenue,
        dailyCost: powerCostPerDay,
        dailyProfit,
        profitPerMH,
        profitMargin: (dailyProfit / grossRevenue) * 100,
        roi: dailyProfit > 0 ? (algo.powerConsumption * 1000) / dailyProfit : Infinity
      });
    }
    
    this.currentProfitability = profitability;
    return profitability;
  }
  
  /**
   * Get most profitable coin
   */
  getMostProfitable() {
    let best = null;
    let highestProfit = -Infinity;
    
    for (const [symbol, data] of this.currentProfitability) {
      if (data.dailyProfit > highestProfit) {
        highestProfit = data.dailyProfit;
        best = { symbol, ...data };
      }
    }
    
    return best;
  }
  
  /**
   * Estimate network hashrate from difficulty
   */
  estimateNetworkHashrate(coin) {
    // Simplified estimation - would use actual formulas per coin
    return coin.difficulty * Math.pow(2, 32) / coin.blockTime;
  }
}

/**
 * Profit switching manager
 */
export class ProfitSwitchingManager extends EventEmitter {
  constructor(pool, options = {}) {
    super();
    
    this.pool = pool;
    this.config = {
      enabled: options.enabled !== false,
      checkInterval: options.checkInterval || 300000, // 5 minutes
      switchThreshold: options.switchThreshold || 0.05, // 5% improvement required
      minMiningDuration: options.minMiningDuration || 600000, // 10 minutes minimum
      supportedCoins: options.supportedCoins || ['BTC', 'ETH', 'LTC', 'RVN'],
      ...options
    };
    
    this.calculator = new ProfitabilityCalculator(options);
    this.currentCoin = null;
    this.lastSwitch = 0;
    this.switchHistory = [];
    this.updateTimer = null;
    
    this.stats = {
      switches: 0,
      totalProfit: 0,
      avgProfitPerSwitch: 0
    };
  }
  
  /**
   * Initialize profit switching
   */
  async initialize() {
    logger.info('Initializing profit switching manager...');
    
    // Register supported algorithms and their hashrates
    this.registerHardwareProfiles();
    
    // Fetch initial coin data
    await this.updateCoinData();
    
    // Calculate initial profitability
    this.calculator.calculateProfitability();
    
    // Select initial coin
    const best = this.calculator.getMostProfitable();
    if (best) {
      await this.switchToCoin(best.symbol);
    }
    
    // Start monitoring
    this.startMonitoring();
    
    logger.info('Profit switching manager initialized');
    this.emit('initialized');
  }
  
  /**
   * Register hardware profiles
   */
  registerHardwareProfiles() {
    // Example profiles - would be dynamic based on actual hardware
    this.calculator.registerAlgorithm('sha256', {
      hashrate: 100e12, // 100 TH/s
      powerConsumption: 3000 // 3000W
    });
    
    this.calculator.registerAlgorithm('ethash', {
      hashrate: 500e6, // 500 MH/s
      powerConsumption: 1200 // 1200W
    });
    
    this.calculator.registerAlgorithm('scrypt', {
      hashrate: 1e9, // 1 GH/s
      powerConsumption: 1500 // 1500W
    });
    
    this.calculator.registerAlgorithm('kawpow', {
      hashrate: 100e6, // 100 MH/s
      powerConsumption: 800 // 800W
    });
  }
  
  /**
   * Update coin data from various sources
   */
  async updateCoinData() {
    // In production, would fetch from actual APIs
    const mockData = {
      BTC: {
        algorithm: 'sha256',
        difficulty: 37590453655497.09,
        blockReward: 6.25,
        blockTime: 600,
        price: 45000
      },
      ETH: {
        algorithm: 'ethash',
        difficulty: 12500000000000000,
        blockReward: 2,
        blockTime: 13,
        price: 3000
      },
      LTC: {
        algorithm: 'scrypt',
        difficulty: 20000000,
        blockReward: 12.5,
        blockTime: 150,
        price: 150
      },
      RVN: {
        algorithm: 'kawpow',
        difficulty: 100000,
        blockReward: 5000,
        blockTime: 60,
        price: 0.05
      }
    };
    
    for (const [symbol, data] of Object.entries(mockData)) {
      if (this.config.supportedCoins.includes(symbol)) {
        this.calculator.registerCoin(symbol, data);
      }
    }
  }
  
  /**
   * Start profitability monitoring
   */
  startMonitoring() {
    this.updateTimer = setInterval(async () => {
      try {
        await this.checkProfitability();
      } catch (error) {
        logger.error('Profitability check failed:', error);
      }
    }, this.config.checkInterval);
  }
  
  /**
   * Check if switching is profitable
   */
  async checkProfitability() {
    // Update coin data
    await this.updateCoinData();
    
    // Recalculate profitability
    this.calculator.calculateProfitability();
    
    // Get best coin
    const best = this.calculator.getMostProfitable();
    if (!best) return;
    
    // Check if we should switch
    if (this.shouldSwitch(best)) {
      await this.switchToCoin(best.symbol);
    }
  }
  
  /**
   * Determine if switching is worthwhile
   */
  shouldSwitch(newCoin) {
    // Don't switch if disabled
    if (!this.config.enabled) return false;
    
    // Don't switch to same coin
    if (newCoin.symbol === this.currentCoin) return false;
    
    // Check minimum mining duration
    if (Date.now() - this.lastSwitch < this.config.minMiningDuration) {
      return false;
    }
    
    // Get current coin profitability
    const currentProfit = this.currentCoin 
      ? this.calculator.currentProfitability.get(this.currentCoin)
      : null;
    
    if (!currentProfit) return true;
    
    // Calculate improvement
    const improvement = (newCoin.dailyProfit - currentProfit.dailyProfit) / currentProfit.dailyProfit;
    
    // Check if improvement exceeds threshold
    return improvement > this.config.switchThreshold;
  }
  
  /**
   * Switch to new coin
   */
  async switchToCoin(symbol) {
    logger.info(`Switching from ${this.currentCoin || 'none'} to ${symbol}`);
    
    const previousCoin = this.currentCoin;
    const switchTime = Date.now();
    
    // Update pool configuration
    await this.updatePoolConfig(symbol);
    
    // Record switch
    this.currentCoin = symbol;
    this.lastSwitch = switchTime;
    this.stats.switches++;
    
    // Add to history
    this.switchHistory.push({
      from: previousCoin,
      to: symbol,
      timestamp: switchTime,
      profitability: this.calculator.currentProfitability.get(symbol)
    });
    
    // Emit event
    this.emit('coin:switched', {
      from: previousCoin,
      to: symbol,
      profitability: this.calculator.currentProfitability.get(symbol)
    });
  }
  
  /**
   * Update pool configuration for new coin
   */
  async updatePoolConfig(symbol) {
    const coin = this.coins.get(symbol);
    if (!coin) return;
    
    // Update pool settings
    if (this.pool.updateCoinConfig) {
      await this.pool.updateCoinConfig({
        coin: symbol,
        algorithm: coin.algorithm,
        difficulty: coin.difficulty,
        blockReward: coin.blockReward
      });
    }
    
    // Notify miners of switch
    if (this.pool.broadcast) {
      this.pool.broadcast({
        type: 'coin_switch',
        coin: symbol,
        algorithm: coin.algorithm
      });
    }
  }
  
  /**
   * Get profitability report
   */
  getProfitabilityReport() {
    const profitability = Array.from(this.calculator.currentProfitability.values())
      .sort((a, b) => b.dailyProfit - a.dailyProfit);
    
    return {
      current: this.currentCoin,
      lastUpdate: Date.now(),
      coins: profitability,
      recommendation: profitability[0]?.coin || null
    };
  }
  
  /**
   * Get switching statistics
   */
  getStats() {
    const totalSwitches = this.switchHistory.length;
    const last24h = this.switchHistory.filter(s => 
      Date.now() - s.timestamp < 86400000
    ).length;
    
    return {
      ...this.stats,
      currentCoin: this.currentCoin,
      totalSwitches,
      switchesLast24h: last24h,
      lastSwitch: this.lastSwitch,
      timeSinceSwitch: Date.now() - this.lastSwitch
    };
  }
  
  /**
   * Manual coin selection
   */
  async selectCoin(symbol) {
    if (!this.config.supportedCoins.includes(symbol)) {
      throw new Error(`Coin ${symbol} not supported`);
    }
    
    this.config.enabled = false; // Disable auto-switching
    await this.switchToCoin(symbol);
  }
  
  /**
   * Enable/disable auto switching
   */
  setAutoSwitching(enabled) {
    this.config.enabled = enabled;
    logger.info(`Auto-switching ${enabled ? 'enabled' : 'disabled'}`);
  }
  
  /**
   * Shutdown
   */
  shutdown() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
    
    this.removeAllListeners();
    logger.info('Profit switching manager shutdown');
  }
}

export default {
  ProfitabilityCalculator,
  ProfitSwitchingManager
};