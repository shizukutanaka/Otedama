/**
 * Smart Profit Switching
 * AI-powered algorithm switching based on real-time profitability analysis
 */

import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';
import axios from 'axios';

const logger = createLogger('smart-profit-switching');

class SmartProfitSwitching extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      updateInterval: options.updateInterval || 300000, // 5 minutes
      switchThreshold: options.switchThreshold || 1.05, // 5% improvement required
      minSwitchInterval: options.minSwitchInterval || 900000, // 15 minutes
      apiEndpoints: options.apiEndpoints || {
        whattomine: 'https://whattomine.com/coins.json',
        minerstat: 'https://api.minerstat.com/v2/coins',
        cryptocompare: 'https://min-api.cryptocompare.com/data/mining/calculator/index'
      },
      supportedAlgorithms: options.supportedAlgorithms || [
        'SHA256', 'Scrypt', 'Ethash', 'RandomX', 'Kawpow', 
        'Autolykos', 'Blake3', 'Octopus', 'ProgPow'
      ],
      powerCost: options.powerCost || 0.10, // $/kWh
      hardware: options.hardware || {},
      aiModel: options.aiModel || 'profit-predictor-v2',
      ...options
    };
    
    this.currentAlgorithm = null;
    this.profitabilityData = new Map();
    this.historicalData = [];
    this.lastSwitch = 0;
    this.updateTimer = null;
    this.aiPredictor = null;
  }
  
  /**
   * Initialize smart profit switching
   */
  async initialize() {
    try {
      // Load AI model
      await this.loadAIModel();
      
      // Fetch initial profitability data
      await this.updateProfitabilityData();
      
      // Start monitoring
      this.startMonitoring();
      
      logger.info('Smart profit switching initialized');
      this.emit('initialized');
      
      return true;
    } catch (error) {
      logger.error('Failed to initialize profit switching:', error);
      throw error;
    }
  }
  
  /**
   * Get current most profitable algorithm
   */
  async getMostProfitableAlgorithm() {
    const profitability = await this.calculateProfitability();
    
    // Sort by profit
    const sorted = Array.from(profitability.entries())
      .sort((a, b) => b[1].netProfit - a[1].netProfit);
    
    if (sorted.length === 0) {
      return null;
    }
    
    const [algorithm, data] = sorted[0];
    
    // Check if switching is worth it
    if (this.currentAlgorithm) {
      const currentProfit = profitability.get(this.currentAlgorithm);
      const improvement = data.netProfit / currentProfit.netProfit;
      
      if (improvement < this.options.switchThreshold) {
        logger.debug(`Staying on ${this.currentAlgorithm} (improvement only ${((improvement - 1) * 100).toFixed(2)}%)`);
        return this.currentAlgorithm;
      }
      
      // Check minimum switch interval
      const timeSinceSwitch = Date.now() - this.lastSwitch;
      if (timeSinceSwitch < this.options.minSwitchInterval) {
        logger.debug('Too soon to switch algorithms');
        return this.currentAlgorithm;
      }
    }
    
    return algorithm;
  }
  
  /**
   * Calculate profitability for all algorithms
   */
  async calculateProfitability() {
    const profitability = new Map();
    
    for (const algorithm of this.options.supportedAlgorithms) {
      try {
        const data = await this.calculateAlgorithmProfitability(algorithm);
        profitability.set(algorithm, data);
      } catch (error) {
        logger.error(`Failed to calculate profitability for ${algorithm}:`, error);
      }
    }
    
    // Apply AI predictions
    if (this.aiPredictor) {
      await this.applyAIPredictions(profitability);
    }
    
    return profitability;
  }
  
  /**
   * Calculate profitability for specific algorithm
   */
  async calculateAlgorithmProfitability(algorithm) {
    const marketData = this.profitabilityData.get(algorithm) || {};
    const hardware = this.getHardwareForAlgorithm(algorithm);
    
    if (!hardware || !marketData.difficulty) {
      return {
        revenue: 0,
        powerCost: 0,
        netProfit: 0,
        coins: []
      };
    }
    
    // Calculate hashrate
    const hashrate = hardware.hashrate || 0;
    const power = hardware.power || 0;
    
    // Get coin data
    const coins = await this.getCoinsForAlgorithm(algorithm);
    const profitableCoins = [];
    
    for (const coin of coins) {
      const blockReward = coin.blockReward || 0;
      const blockTime = coin.blockTime || 600;
      const price = coin.price || 0;
      const difficulty = coin.difficulty || marketData.difficulty;
      
      // Calculate expected coins per day
      const blocksPerDay = 86400 / blockTime;
      const networkHashrate = difficulty * Math.pow(2, 32) / blockTime;
      const minerShare = hashrate / networkHashrate;
      const coinsPerDay = minerShare * blockReward * blocksPerDay;
      
      // Calculate revenue
      const dailyRevenue = coinsPerDay * price;
      
      // Calculate power cost
      const dailyPowerCost = (power / 1000) * 24 * this.options.powerCost;
      
      // Calculate net profit
      const netProfit = dailyRevenue - dailyPowerCost;
      
      profitableCoins.push({
        coin: coin.symbol,
        coinsPerDay,
        revenue: dailyRevenue,
        powerCost: dailyPowerCost,
        netProfit,
        price
      });
    }
    
    // Sort by profit
    profitableCoins.sort((a, b) => b.netProfit - a.netProfit);
    
    // Calculate totals
    const bestCoin = profitableCoins[0] || {};
    
    return {
      algorithm,
      hashrate,
      power,
      revenue: bestCoin.revenue || 0,
      powerCost: bestCoin.powerCost || 0,
      netProfit: bestCoin.netProfit || 0,
      bestCoin: bestCoin.coin,
      coins: profitableCoins.slice(0, 5) // Top 5 coins
    };
  }
  
  /**
   * Switch to new algorithm
   */
  async switchAlgorithm(newAlgorithm) {
    if (newAlgorithm === this.currentAlgorithm) {
      return;
    }
    
    const oldAlgorithm = this.currentAlgorithm;
    
    logger.info(`Switching from ${oldAlgorithm || 'none'} to ${newAlgorithm}`);
    
    this.emit('switching', {
      from: oldAlgorithm,
      to: newAlgorithm,
      timestamp: Date.now()
    });
    
    try {
      // Stop current mining
      if (oldAlgorithm) {
        await this.stopMining(oldAlgorithm);
      }
      
      // Start new mining
      await this.startMining(newAlgorithm);
      
      this.currentAlgorithm = newAlgorithm;
      this.lastSwitch = Date.now();
      
      // Record switch
      this.recordSwitch({
        from: oldAlgorithm,
        to: newAlgorithm,
        reason: 'profitability',
        profitData: this.profitabilityData.get(newAlgorithm)
      });
      
      this.emit('switched', {
        algorithm: newAlgorithm,
        timestamp: Date.now()
      });
      
      logger.info(`Successfully switched to ${newAlgorithm}`);
    } catch (error) {
      logger.error(`Failed to switch to ${newAlgorithm}:`, error);
      
      // Try to restore previous algorithm
      if (oldAlgorithm) {
        try {
          await this.startMining(oldAlgorithm);
          this.currentAlgorithm = oldAlgorithm;
        } catch (restoreError) {
          logger.error('Failed to restore previous algorithm:', restoreError);
        }
      }
      
      throw error;
    }
  }
  
  /**
   * Update profitability data from APIs
   */
  async updateProfitabilityData() {
    const updates = [];
    
    // Fetch from multiple sources
    updates.push(this.fetchWhatToMine());
    updates.push(this.fetchMinerstat());
    updates.push(this.fetchCryptoCompare());
    
    await Promise.allSettled(updates);
    
    // Merge and validate data
    this.mergeProfitabilityData();
    
    // Store historical data
    this.storeHistoricalData();
    
    logger.debug('Updated profitability data');
    this.emit('data-updated', Array.from(this.profitabilityData.entries()));
  }
  
  /**
   * Fetch data from WhatToMine
   */
  async fetchWhatToMine() {
    try {
      const response = await axios.get(this.options.apiEndpoints.whattomine, {
        timeout: 10000
      });
      
      const coins = response.data.coins || {};
      
      for (const [coinName, coinData] of Object.entries(coins)) {
        const algorithm = this.normalizeAlgorithm(coinData.algorithm);
        if (!this.options.supportedAlgorithms.includes(algorithm)) {
          continue;
        }
        
        if (!this.profitabilityData.has(algorithm)) {
          this.profitabilityData.set(algorithm, {
            coins: [],
            difficulty: 0,
            lastUpdate: Date.now()
          });
        }
        
        const data = this.profitabilityData.get(algorithm);
        data.coins.push({
          name: coinName,
          symbol: coinData.tag,
          difficulty: parseFloat(coinData.difficulty),
          blockReward: parseFloat(coinData.block_reward),
          blockTime: parseFloat(coinData.block_time),
          price: parseFloat(coinData.exchange_rate)
        });
      }
    } catch (error) {
      logger.error('Failed to fetch WhatToMine data:', error);
    }
  }
  
  /**
   * Fetch data from Minerstat
   */
  async fetchMinerstat() {
    try {
      const response = await axios.get(this.options.apiEndpoints.minerstat, {
        timeout: 10000
      });
      
      // Process minerstat data
      // ... implementation
    } catch (error) {
      logger.error('Failed to fetch Minerstat data:', error);
    }
  }
  
  /**
   * Fetch data from CryptoCompare
   */
  async fetchCryptoCompare() {
    try {
      const response = await axios.get(this.options.apiEndpoints.cryptocompare, {
        timeout: 10000
      });
      
      // Process CryptoCompare data
      // ... implementation
    } catch (error) {
      logger.error('Failed to fetch CryptoCompare data:', error);
    }
  }
  
  /**
   * Load AI model for predictions
   */
  async loadAIModel() {
    try {
      // In a real implementation, this would load a TensorFlow.js or similar model
      // For now, we'll use a simple prediction algorithm
      this.aiPredictor = {
        predict: (data) => this.simplePrediction(data)
      };
      
      logger.info('AI predictor loaded');
    } catch (error) {
      logger.warn('Failed to load AI model, using basic predictions:', error);
    }
  }
  
  /**
   * Apply AI predictions to profitability data
   */
  async applyAIPredictions(profitability) {
    if (!this.aiPredictor) return;
    
    for (const [algorithm, data] of profitability) {
      try {
        const prediction = await this.aiPredictor.predict({
          algorithm,
          historicalData: this.getHistoricalData(algorithm),
          currentData: data,
          marketTrends: this.getMarketTrends()
        });
        
        // Adjust profitability based on prediction
        data.aiAdjustedProfit = data.netProfit * prediction.profitMultiplier;
        data.aiConfidence = prediction.confidence;
        data.aiRecommendation = prediction.recommendation;
      } catch (error) {
        logger.error(`AI prediction failed for ${algorithm}:`, error);
      }
    }
  }
  
  /**
   * Simple prediction algorithm
   */
  simplePrediction(data) {
    const historical = data.historicalData || [];
    if (historical.length < 10) {
      return {
        profitMultiplier: 1.0,
        confidence: 0.5,
        recommendation: 'insufficient_data'
      };
    }
    
    // Calculate trend
    const recent = historical.slice(-10);
    const older = historical.slice(-20, -10);
    
    const recentAvg = recent.reduce((sum, d) => sum + d.netProfit, 0) / recent.length;
    const olderAvg = older.reduce((sum, d) => sum + d.netProfit, 0) / older.length;
    
    const trend = recentAvg / olderAvg;
    
    // Calculate volatility
    const profits = recent.map(d => d.netProfit);
    const mean = profits.reduce((a, b) => a + b) / profits.length;
    const variance = profits.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / profits.length;
    const volatility = Math.sqrt(variance) / mean;
    
    // Make prediction
    let profitMultiplier = 1.0;
    let confidence = 0.7;
    let recommendation = 'hold';
    
    if (trend > 1.1 && volatility < 0.2) {
      profitMultiplier = 1.1;
      confidence = 0.8;
      recommendation = 'switch';
    } else if (trend < 0.9 && volatility < 0.2) {
      profitMultiplier = 0.9;
      confidence = 0.8;
      recommendation = 'avoid';
    } else if (volatility > 0.4) {
      confidence = 0.4;
      recommendation = 'high_risk';
    }
    
    return {
      profitMultiplier,
      confidence,
      recommendation
    };
  }
  
  /**
   * Get hardware configuration for algorithm
   */
  getHardwareForAlgorithm(algorithm) {
    return this.options.hardware[algorithm] || this.options.hardware.default || null;
  }
  
  /**
   * Get coins that use specific algorithm
   */
  async getCoinsForAlgorithm(algorithm) {
    const data = this.profitabilityData.get(algorithm);
    return data ? data.coins : [];
  }
  
  /**
   * Start mining with specific algorithm
   */
  async startMining(algorithm) {
    // This would interface with the actual mining software
    this.emit('start-mining', { algorithm });
  }
  
  /**
   * Stop mining with specific algorithm
   */
  async stopMining(algorithm) {
    // This would interface with the actual mining software
    this.emit('stop-mining', { algorithm });
  }
  
  /**
   * Start monitoring profitability
   */
  startMonitoring() {
    // Initial check
    this.checkProfitability();
    
    // Set up interval
    this.updateTimer = setInterval(async () => {
      await this.updateProfitabilityData();
      await this.checkProfitability();
    }, this.options.updateInterval);
  }
  
  /**
   * Check and switch if needed
   */
  async checkProfitability() {
    try {
      const mostProfitable = await this.getMostProfitableAlgorithm();
      
      if (mostProfitable && mostProfitable !== this.currentAlgorithm) {
        await this.switchAlgorithm(mostProfitable);
      }
    } catch (error) {
      logger.error('Error checking profitability:', error);
    }
  }
  
  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }
  
  /**
   * Record algorithm switch
   */
  recordSwitch(switchData) {
    this.historicalData.push({
      timestamp: Date.now(),
      type: 'switch',
      ...switchData
    });
    
    // Keep last 1000 records
    if (this.historicalData.length > 1000) {
      this.historicalData = this.historicalData.slice(-1000);
    }
  }
  
  /**
   * Store historical profitability data
   */
  storeHistoricalData() {
    const snapshot = {};
    
    for (const [algorithm, data] of this.profitabilityData) {
      const bestCoin = data.coins.sort((a, b) => b.price - a.price)[0];
      snapshot[algorithm] = {
        difficulty: data.difficulty,
        bestCoin: bestCoin ? bestCoin.symbol : null,
        price: bestCoin ? bestCoin.price : 0,
        netProfit: bestCoin ? this.calculateNetProfit(algorithm, bestCoin) : 0
      };
    }
    
    this.historicalData.push({
      timestamp: Date.now(),
      type: 'snapshot',
      data: snapshot
    });
  }
  
  /**
   * Get historical data for algorithm
   */
  getHistoricalData(algorithm) {
    return this.historicalData
      .filter(h => h.type === 'snapshot' && h.data[algorithm])
      .map(h => ({
        timestamp: h.timestamp,
        ...h.data[algorithm]
      }));
  }
  
  /**
   * Get market trends
   */
  getMarketTrends() {
    // Analyze historical data for trends
    const trends = {
      overall: 'stable',
      volatility: 'normal',
      recommendation: 'continue'
    };
    
    // Simple trend analysis
    const recent = this.historicalData.slice(-24); // Last 24 snapshots
    if (recent.length < 2) return trends;
    
    // Calculate overall market movement
    // ... implementation
    
    return trends;
  }
  
  /**
   * Normalize algorithm names
   */
  normalizeAlgorithm(algorithm) {
    const normalized = algorithm.toLowerCase().replace(/[-_\s]/g, '');
    
    const mapping = {
      'sha256': 'SHA256',
      'scrypt': 'Scrypt',
      'ethash': 'Ethash',
      'daggerhashimoto': 'Ethash',
      'randomx': 'RandomX',
      'kawpow': 'Kawpow',
      'autolykos': 'Autolykos',
      'autolykos2': 'Autolykos',
      'blake3': 'Blake3',
      'octopus': 'Octopus',
      'progpow': 'ProgPow'
    };
    
    return mapping[normalized] || algorithm;
  }
  
  /**
   * Calculate net profit for coin
   */
  calculateNetProfit(algorithm, coin) {
    const hardware = this.getHardwareForAlgorithm(algorithm);
    if (!hardware) return 0;
    
    const powerCost = (hardware.power / 1000) * 24 * this.options.powerCost;
    const revenue = coin.price * (hardware.hashrate / coin.difficulty) * 86400;
    
    return revenue - powerCost;
  }
  
  /**
   * Merge profitability data from multiple sources
   */
  mergeProfitabilityData() {
    // Remove duplicates and average values
    for (const [algorithm, data] of this.profitabilityData) {
      const uniqueCoins = new Map();
      
      for (const coin of data.coins) {
        const key = coin.symbol || coin.name;
        if (!uniqueCoins.has(key)) {
          uniqueCoins.set(key, coin);
        } else {
          // Average the values
          const existing = uniqueCoins.get(key);
          existing.price = (existing.price + coin.price) / 2;
          existing.difficulty = (existing.difficulty + coin.difficulty) / 2;
        }
      }
      
      data.coins = Array.from(uniqueCoins.values());
    }
  }
  
  /**
   * Get current status
   */
  getStatus() {
    const profitability = Array.from(this.profitabilityData.entries()).map(([algo, data]) => ({
      algorithm: algo,
      coins: data.coins.length,
      lastUpdate: data.lastUpdate
    }));
    
    return {
      currentAlgorithm: this.currentAlgorithm,
      lastSwitch: this.lastSwitch,
      monitoring: !!this.updateTimer,
      algorithms: profitability,
      historicalRecords: this.historicalData.length
    };
  }
}

export default SmartProfitSwitching;