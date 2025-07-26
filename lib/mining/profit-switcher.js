/**
 * Profit Switching Engine - Otedama
 * Automatically switches between algorithms/coins for maximum profitability
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import fetch from 'node-fetch';

const logger = createStructuredLogger('ProfitSwitcher');

// Supported algorithms and their coins
const ALGORITHM_COINS = {
  sha256: ['BTC', 'BCH', 'BSV'],
  scrypt: ['LTC', 'DOGE'],
  ethash: ['ETC'],
  randomx: ['XMR'],
  kawpow: ['RVN'],
  x11: ['DASH'],
  equihash: ['ZEC', 'ZEN', 'BTG'],
  cryptonight: ['XMR', 'AEON']
};

export class ProfitSwitcher extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      updateInterval: options.updateInterval || 300000, // 5 minutes
      switchThreshold: options.switchThreshold || 1.05, // 5% improvement required
      minSwitchInterval: options.minSwitchInterval || 600000, // 10 minutes minimum between switches
      priceSources: options.priceSources || ['coingecko', 'cryptocompare'],
      difficulty: options.difficulty || 'network', // 'network' or 'pool'
      powerCost: options.powerCost || 0.10, // $/kWh
      includeFees: options.includeFees !== false,
      ...options
    };
    
    // Current state
    this.currentAlgorithm = null;
    this.currentCoin = null;
    this.lastSwitch = 0;
    
    // Profitability data
    this.profitability = new Map();
    this.prices = new Map();
    this.difficulties = new Map();
    this.blockRewards = new Map();
    
    // Hardware profiles
    this.hardwareProfiles = new Map();
    
    // Statistics
    this.stats = {
      switches: 0,
      profitImprovement: 0,
      lastUpdate: null,
      errors: 0
    };
    
    // Update timer
    this.updateTimer = null;
    
    // Initialize default hardware profiles
    this.initializeHardwareProfiles();
  }
  
  /**
   * Initialize default hardware profiles
   */
  initializeHardwareProfiles() {
    // Example profiles - should be customized based on actual hardware
    this.hardwareProfiles.set('default', {
      sha256: { hashrate: 100e12, power: 3250 }, // 100 TH/s, 3250W
      scrypt: { hashrate: 1e9, power: 1500 }, // 1 GH/s, 1500W
      ethash: { hashrate: 500e6, power: 750 }, // 500 MH/s, 750W
      randomx: { hashrate: 10000, power: 180 }, // 10 KH/s, 180W
      kawpow: { hashrate: 30e6, power: 300 }, // 30 MH/s, 300W
      x11: { hashrate: 20e9, power: 400 }, // 20 GH/s, 400W
      equihash: { hashrate: 1000, power: 300 }, // 1000 Sol/s, 300W
      cryptonight: { hashrate: 2000, power: 150 } // 2 KH/s, 150W
    });
  }
  
  /**
   * Set hardware profile
   */
  setHardwareProfile(name, profile) {
    this.hardwareProfiles.set(name, profile);
    logger.info('Hardware profile set', { name, algorithms: Object.keys(profile) });
  }
  
  /**
   * Start profit switching
   */
  async start(initialAlgorithm = 'sha256', initialCoin = 'BTC') {
    this.currentAlgorithm = initialAlgorithm;
    this.currentCoin = initialCoin;
    
    // Initial update
    await this.updateProfitability();
    
    // Start periodic updates
    this.updateTimer = setInterval(async () => {
      await this.updateProfitability();
      await this.evaluateSwitch();
    }, this.options.updateInterval);
    
    logger.info('Profit switcher started', {
      algorithm: initialAlgorithm,
      coin: initialCoin,
      updateInterval: this.options.updateInterval
    });
  }
  
  /**
   * Stop profit switching
   */
  stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    
    logger.info('Profit switcher stopped');
  }
  
  /**
   * Update profitability data
   */
  async updateProfitability() {
    try {
      // Update prices
      await this.updatePrices();
      
      // Update network difficulties
      await this.updateDifficulties();
      
      // Update block rewards
      await this.updateBlockRewards();
      
      // Calculate profitability for each algorithm/coin
      await this.calculateProfitability();
      
      this.stats.lastUpdate = Date.now();
      
      this.emit('profitability:updated', {
        timestamp: this.stats.lastUpdate,
        profitability: this.getProfitabilityReport()
      });
      
    } catch (error) {
      logger.error('Failed to update profitability', { error: error.message });
      this.stats.errors++;
    }
  }
  
  /**
   * Update cryptocurrency prices
   */
  async updatePrices() {
    const coins = new Set();
    for (const coinList of Object.values(ALGORITHM_COINS)) {
      coinList.forEach(coin => coins.add(coin));
    }
    
    // Fetch from multiple sources and average
    const pricePromises = this.options.priceSources.map(source => 
      this.fetchPricesFromSource(source, Array.from(coins))
    );
    
    const results = await Promise.allSettled(pricePromises);
    const successfulResults = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);
    
    // Average prices from successful sources
    for (const coin of coins) {
      const prices = successfulResults
        .map(result => result[coin])
        .filter(price => price > 0);
      
      if (prices.length > 0) {
        const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
        this.prices.set(coin, avgPrice);
      }
    }
    
    logger.debug('Prices updated', {
      coins: this.prices.size,
      sources: successfulResults.length
    });
  }
  
  /**
   * Fetch prices from a specific source
   */
  async fetchPricesFromSource(source, coins) {
    const prices = {};
    
    switch (source) {
      case 'coingecko':
        // Simulated API call - replace with actual implementation
        const cgIds = {
          BTC: 'bitcoin',
          ETH: 'ethereum',
          LTC: 'litecoin',
          XMR: 'monero',
          RVN: 'ravencoin',
          DASH: 'dash',
          ZEC: 'zcash',
          DOGE: 'dogecoin',
          BCH: 'bitcoin-cash',
          BSV: 'bitcoin-sv',
          ETC: 'ethereum-classic',
          ZEN: 'horizen',
          BTG: 'bitcoin-gold',
          AEON: 'aeon'
        };
        
        // In production, make actual API call
        // const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
        
        // Simulated prices for now
        for (const coin of coins) {
          prices[coin] = this.getSimulatedPrice(coin);
        }
        break;
        
      case 'cryptocompare':
        // Similar implementation for CryptoCompare
        for (const coin of coins) {
          prices[coin] = this.getSimulatedPrice(coin) * (0.98 + Math.random() * 0.04);
        }
        break;
    }
    
    return prices;
  }
  
  /**
   * Get simulated price (for testing)
   */
  getSimulatedPrice(coin) {
    const basePrices = {
      BTC: 45000,
      ETH: 3000,
      LTC: 150,
      XMR: 250,
      RVN: 0.05,
      DASH: 100,
      ZEC: 150,
      DOGE: 0.15,
      BCH: 500,
      BSV: 100,
      ETC: 30,
      ZEN: 40,
      BTG: 30,
      AEON: 0.5
    };
    
    return basePrices[coin] || 1;
  }
  
  /**
   * Update network difficulties
   */
  async updateDifficulties() {
    // In production, fetch from blockchain APIs or pool data
    // For now, use simulated values
    
    this.difficulties.set('BTC', 35e12);
    this.difficulties.set('LTC', 15e6);
    this.difficulties.set('ETH', 14e15);
    this.difficulties.set('XMR', 300e9);
    this.difficulties.set('RVN', 100e9);
    this.difficulties.set('DASH', 200e6);
    this.difficulties.set('ZEC', 70e6);
    this.difficulties.set('DOGE', 7e6);
    this.difficulties.set('BCH', 200e9);
    this.difficulties.set('BSV', 100e9);
    this.difficulties.set('ETC', 3e15);
    this.difficulties.set('ZEN', 30e6);
    this.difficulties.set('BTG', 2e6);
    this.difficulties.set('AEON', 100e6);
  }
  
  /**
   * Update block rewards
   */
  async updateBlockRewards() {
    // In production, calculate based on block height and coin rules
    // For now, use current approximate values
    
    this.blockRewards.set('BTC', 6.25);
    this.blockRewards.set('LTC', 12.5);
    this.blockRewards.set('ETH', 2);
    this.blockRewards.set('XMR', 0.6);
    this.blockRewards.set('RVN', 5000);
    this.blockRewards.set('DASH', 1.55);
    this.blockRewards.set('ZEC', 3.125);
    this.blockRewards.set('DOGE', 10000);
    this.blockRewards.set('BCH', 6.25);
    this.blockRewards.set('BSV', 6.25);
    this.blockRewards.set('ETC', 2.56);
    this.blockRewards.set('ZEN', 3.75);
    this.blockRewards.set('BTG', 6.25);
    this.blockRewards.set('AEON', 2.5);
  }
  
  /**
   * Calculate profitability for all algorithms/coins
   */
  async calculateProfitability() {
    const profile = this.hardwareProfiles.get('default');
    
    for (const [algorithm, coins] of Object.entries(ALGORITHM_COINS)) {
      for (const coin of coins) {
        const price = this.prices.get(coin) || 0;
        const difficulty = this.difficulties.get(coin) || 1;
        const blockReward = this.blockRewards.get(coin) || 0;
        const hardware = profile[algorithm] || { hashrate: 0, power: 0 };
        
        if (price === 0 || hardware.hashrate === 0) continue;
        
        // Calculate daily revenue
        const dailyRevenue = this.calculateDailyRevenue(
          algorithm,
          coin,
          hardware.hashrate,
          difficulty,
          blockReward,
          price
        );
        
        // Calculate daily costs
        const dailyCost = (hardware.power / 1000) * 24 * this.options.powerCost;
        
        // Calculate profit
        const dailyProfit = dailyRevenue - dailyCost;
        const profitRatio = dailyRevenue > 0 ? dailyProfit / dailyRevenue : 0;
        
        this.profitability.set(`${algorithm}:${coin}`, {
          algorithm,
          coin,
          revenue: dailyRevenue,
          cost: dailyCost,
          profit: dailyProfit,
          profitRatio,
          hashrate: hardware.hashrate,
          power: hardware.power,
          efficiency: dailyProfit / (hardware.power / 1000) // $/kW
        });
      }
    }
  }
  
  /**
   * Calculate daily revenue for a specific algorithm/coin
   */
  calculateDailyRevenue(algorithm, coin, hashrate, difficulty, blockReward, price) {
    let dailyCoins = 0;
    
    switch (algorithm) {
      case 'sha256':
      case 'scrypt':
      case 'x11':
        // Bitcoin-like calculation
        const hashesPerDay = hashrate * 86400;
        const networkHashesPerBlock = difficulty * Math.pow(2, 32);
        const blocksPerDay = hashesPerDay / networkHashesPerBlock;
        dailyCoins = blocksPerDay * blockReward;
        break;
        
      case 'ethash':
        // Ethereum-like calculation
        const blockTime = 13; // seconds
        const blocksPerDayEth = 86400 / blockTime;
        const networkHashrate = difficulty / blockTime;
        const minerShare = hashrate / networkHashrate;
        dailyCoins = blocksPerDayEth * blockReward * minerShare;
        break;
        
      case 'randomx':
      case 'cryptonight':
        // Monero-like calculation
        const blockTimeXMR = 120; // seconds
        const blocksPerDayXMR = 86400 / blockTimeXMR;
        const minerShareXMR = hashrate / (difficulty / blockTimeXMR);
        dailyCoins = blocksPerDayXMR * blockReward * minerShareXMR;
        break;
        
      case 'kawpow':
      case 'equihash':
        // Similar to SHA256 but with different scaling
        const hashesPerDayAlt = hashrate * 86400;
        const networkHashesPerBlockAlt = difficulty * Math.pow(2, 32);
        const blocksPerDayAlt = hashesPerDayAlt / networkHashesPerBlockAlt;
        dailyCoins = blocksPerDayAlt * blockReward;
        break;
    }
    
    // Include pool fees if enabled
    if (this.options.includeFees) {
      dailyCoins *= 0.99; // 1% pool fee
    }
    
    return dailyCoins * price;
  }
  
  /**
   * Evaluate if we should switch algorithm/coin
   */
  async evaluateSwitch() {
    // Check if enough time has passed since last switch
    if (Date.now() - this.lastSwitch < this.options.minSwitchInterval) {
      return;
    }
    
    // Find most profitable option
    let bestOption = null;
    let bestProfit = -Infinity;
    
    for (const [key, data] of this.profitability) {
      if (data.profit > bestProfit) {
        bestProfit = data.profit;
        bestOption = data;
      }
    }
    
    if (!bestOption) return;
    
    // Get current profitability
    const currentKey = `${this.currentAlgorithm}:${this.currentCoin}`;
    const currentData = this.profitability.get(currentKey);
    
    if (!currentData) return;
    
    // Check if switch is worth it
    const improvementRatio = bestProfit / currentData.profit;
    
    if (improvementRatio >= this.options.switchThreshold) {
      // Switch to new algorithm/coin
      await this.switchTo(bestOption.algorithm, bestOption.coin, {
        previousProfit: currentData.profit,
        newProfit: bestProfit,
        improvement: ((improvementRatio - 1) * 100).toFixed(2) + '%'
      });
    }
  }
  
  /**
   * Switch to new algorithm/coin
   */
  async switchTo(algorithm, coin, reason = {}) {
    const previous = {
      algorithm: this.currentAlgorithm,
      coin: this.currentCoin
    };
    
    this.currentAlgorithm = algorithm;
    this.currentCoin = coin;
    this.lastSwitch = Date.now();
    this.stats.switches++;
    
    if (reason.improvement) {
      this.stats.profitImprovement += parseFloat(reason.improvement);
    }
    
    logger.info('Switching algorithm/coin', {
      from: `${previous.algorithm}:${previous.coin}`,
      to: `${algorithm}:${coin}`,
      reason
    });
    
    this.emit('switch', {
      previous,
      current: { algorithm, coin },
      reason,
      timestamp: this.lastSwitch
    });
  }
  
  /**
   * Get profitability report
   */
  getProfitabilityReport() {
    const report = [];
    
    for (const [key, data] of this.profitability) {
      report.push({
        ...data,
        current: key === `${this.currentAlgorithm}:${this.currentCoin}`
      });
    }
    
    // Sort by profit descending
    report.sort((a, b) => b.profit - a.profit);
    
    return report;
  }
  
  /**
   * Get current status
   */
  getStatus() {
    const currentKey = `${this.currentAlgorithm}:${this.currentCoin}`;
    const currentData = this.profitability.get(currentKey);
    
    return {
      current: {
        algorithm: this.currentAlgorithm,
        coin: this.currentCoin,
        profitability: currentData
      },
      lastSwitch: this.lastSwitch,
      lastUpdate: this.stats.lastUpdate,
      stats: this.stats,
      top5: this.getProfitabilityReport().slice(0, 5)
    };
  }
}

export default ProfitSwitcher;