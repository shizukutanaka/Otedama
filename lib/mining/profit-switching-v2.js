// Advanced Profit Switching Algorithm with ML Predictions
// Automatically switches between coins and algorithms for maximum profitability

import EventEmitter from 'events';
import { createLogger } from '../core/logger.js';

const logger = createLogger('profit-switching-v2');

export class AdvancedProfitSwitcher extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      updateInterval: options.updateInterval || 300000, // 5 minutes
      switchThreshold: options.switchThreshold || 0.05, // 5% profit difference
      minMiningTime: options.minMiningTime || 600000, // 10 minutes minimum
      maxSwitchesPerHour: options.maxSwitchesPerHour || 6,
      predictionWindow: options.predictionWindow || 3600000, // 1 hour
      ...options
    };
    
    this.coins = new Map();
    this.algorithms = new Map();
    this.priceHistory = new Map();
    this.difficultyHistory = new Map();
    this.switchHistory = [];
    this.currentCoin = null;
    this.lastSwitch = Date.now();
    this.mlModel = null;
    this.profitCache = new Map();
  }

  async initialize() {
    logger.info('Initializing advanced profit switcher');
    
    // Initialize ML model for price prediction
    await this.initializeMLModel();
    
    // Start monitoring
    this.startMonitoring();
    
    return this;
  }

  async initializeMLModel() {
    // Initialize simple neural network for price prediction
    this.mlModel = {
      weights: {
        price: Array(24).fill(0).map(() => Math.random() * 0.1),
        difficulty: Array(24).fill(0).map(() => Math.random() * 0.1),
        volume: Array(24).fill(0).map(() => Math.random() * 0.1),
        bias: Math.random() * 0.1
      },
      learningRate: 0.001
    };
  }

  registerCoin(coin) {
    const coinData = {
      symbol: coin.symbol,
      name: coin.name,
      algorithm: coin.algorithm,
      blockReward: coin.blockReward,
      blockTime: coin.blockTime,
      exchangeInfo: coin.exchangeInfo || {},
      poolInfo: coin.poolInfo || {},
      enabled: coin.enabled !== false,
      minHashrate: coin.minHashrate || 0,
      ...coin
    };
    
    this.coins.set(coin.symbol, coinData);
    
    if (!this.priceHistory.has(coin.symbol)) {
      this.priceHistory.set(coin.symbol, []);
      this.difficultyHistory.set(coin.symbol, []);
    }
    
    logger.info(`Registered coin: ${coin.symbol} (${coin.algorithm})`);
  }

  registerAlgorithm(algorithm) {
    this.algorithms.set(algorithm.name, {
      name: algorithm.name,
      hashrate: algorithm.hashrate,
      power: algorithm.power || 0,
      efficiency: algorithm.efficiency || 1.0,
      supportedCoins: algorithm.supportedCoins || [],
      ...algorithm
    });
    
    logger.info(`Registered algorithm: ${algorithm.name}`);
  }

  async updateMarketData(symbol, data) {
    const coin = this.coins.get(symbol);
    if (!coin) return;
    
    // Update current data
    coin.price = data.price;
    coin.difficulty = data.difficulty;
    coin.networkHashrate = data.networkHashrate;
    coin.volume24h = data.volume24h;
    coin.priceChange24h = data.priceChange24h;
    
    // Store history
    const history = this.priceHistory.get(symbol);
    history.push({
      timestamp: Date.now(),
      price: data.price,
      volume: data.volume24h
    });
    
    // Keep only last 24 hours
    const cutoff = Date.now() - 86400000;
    const filtered = history.filter(h => h.timestamp > cutoff);
    this.priceHistory.set(symbol, filtered);
    
    // Update difficulty history
    const diffHistory = this.difficultyHistory.get(symbol);
    diffHistory.push({
      timestamp: Date.now(),
      difficulty: data.difficulty,
      networkHashrate: data.networkHashrate
    });
    
    const diffFiltered = diffHistory.filter(h => h.timestamp > cutoff);
    this.difficultyHistory.set(symbol, diffFiltered);
    
    // Invalidate profit cache
    this.profitCache.delete(symbol);
  }

  calculateProfit(symbol, options = {}) {
    // Check cache first
    const cacheKey = `${symbol}-${JSON.stringify(options)}`;
    if (this.profitCache.has(cacheKey)) {
      const cached = this.profitCache.get(cacheKey);
      if (Date.now() - cached.timestamp < 60000) { // 1 minute cache
        return cached.profit;
      }
    }
    
    const coin = this.coins.get(symbol);
    if (!coin || !coin.enabled) return 0;
    
    const algorithm = this.algorithms.get(coin.algorithm);
    if (!algorithm) return 0;
    
    // Get predicted values if enabled
    const usePrediction = options.usePrediction !== false;
    const price = usePrediction ? this.predictPrice(symbol) : coin.price;
    const difficulty = usePrediction ? this.predictDifficulty(symbol) : coin.difficulty;
    
    // Calculate expected coins per day
    const hashrate = options.hashrate || algorithm.hashrate;
    const blockReward = coin.blockReward;
    const blocksPerDay = 86400 / coin.blockTime;
    
    // Network share
    const networkShare = hashrate / coin.networkHashrate;
    const expectedBlocksPerDay = blocksPerDay * networkShare;
    const coinsPerDay = expectedBlocksPerDay * blockReward;
    
    // Revenue
    const revenue = coinsPerDay * price;
    
    // Costs
    const powerCost = (algorithm.power / 1000) * 24 * (options.electricityCost || 0.1);
    const poolFee = revenue * (coin.poolInfo.fee || 0.01);
    
    // Profit
    const profit = revenue - powerCost - poolFee;
    
    // Apply switching cost if different from current
    let adjustedProfit = profit;
    if (this.currentCoin && this.currentCoin !== symbol) {
      const switchingCost = this.calculateSwitchingCost(this.currentCoin, symbol);
      adjustedProfit = profit - switchingCost;
    }
    
    // Cache result
    this.profitCache.set(cacheKey, {
      timestamp: Date.now(),
      profit: adjustedProfit
    });
    
    return adjustedProfit;
  }

  calculateSwitchingCost(fromSymbol, toSymbol) {
    const fromCoin = this.coins.get(fromSymbol);
    const toCoin = this.coins.get(toSymbol);
    
    if (!fromCoin || !toCoin) return 0;
    
    let cost = 0;
    
    // Algorithm switch cost (if different)
    if (fromCoin.algorithm !== toCoin.algorithm) {
      cost += 0.1; // Base switching penalty
      
      // DAG regeneration cost for Ethash-like algorithms
      if (['ethash', 'etchash', 'kawpow'].includes(toCoin.algorithm)) {
        cost += 0.5;
      }
    }
    
    // Lost mining time cost (ramp-up period)
    const rampUpTime = 60; // seconds
    const fromProfit = this.calculateProfit(fromSymbol, { usePrediction: false });
    cost += (fromProfit / 86400) * rampUpTime;
    
    // Pool switching cost (connection, authentication)
    if (fromCoin.poolInfo.url !== toCoin.poolInfo.url) {
      cost += 0.05;
    }
    
    return cost;
  }

  predictPrice(symbol) {
    const history = this.priceHistory.get(symbol);
    if (!history || history.length < 24) {
      const coin = this.coins.get(symbol);
      return coin ? coin.price : 0;
    }
    
    // Simple neural network prediction
    const features = this.extractFeatures(history);
    let prediction = this.mlModel.weights.bias;
    
    for (let i = 0; i < features.length; i++) {
      prediction += features[i] * this.mlModel.weights.price[i];
    }
    
    // Apply sigmoid activation
    prediction = 1 / (1 + Math.exp(-prediction));
    
    // Scale to price range
    const prices = history.map(h => h.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    
    return minPrice + prediction * (maxPrice - minPrice);
  }

  predictDifficulty(symbol) {
    const history = this.difficultyHistory.get(symbol);
    if (!history || history.length < 24) {
      const coin = this.coins.get(symbol);
      return coin ? coin.difficulty : 0;
    }
    
    // Linear regression for difficulty prediction
    const x = history.map((_, i) => i);
    const y = history.map(h => h.difficulty);
    
    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((total, xi, i) => total + xi * y[i], 0);
    const sumX2 = x.reduce((total, xi) => total + xi * xi, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Predict next value
    return intercept + slope * n;
  }

  extractFeatures(history) {
    // Extract features for ML model
    const features = [];
    const hours = 24;
    
    for (let i = 0; i < hours; i++) {
      const idx = Math.floor((history.length / hours) * i);
      if (idx < history.length) {
        features.push(history[idx].price);
      } else {
        features.push(0);
      }
    }
    
    // Normalize features
    const max = Math.max(...features);
    if (max > 0) {
      return features.map(f => f / max);
    }
    
    return features;
  }

  async evaluateSwitching() {
    if (!this.currentCoin) {
      // No current coin, select best
      const best = this.selectBestCoin();
      if (best) {
        await this.switchToCoin(best.symbol);
      }
      return;
    }
    
    // Check if enough time has passed since last switch
    const timeSinceSwitch = Date.now() - this.lastSwitch;
    if (timeSinceSwitch < this.config.minMiningTime) {
      return;
    }
    
    // Check switch frequency limit
    const recentSwitches = this.switchHistory.filter(
      s => Date.now() - s.timestamp < 3600000
    );
    if (recentSwitches.length >= this.config.maxSwitchesPerHour) {
      return;
    }
    
    // Calculate current profit
    const currentProfit = this.calculateProfit(this.currentCoin);
    
    // Find best alternative
    const alternatives = this.getRankedCoins();
    if (alternatives.length === 0) return;
    
    const best = alternatives[0];
    
    // Check if switching is worthwhile
    const profitIncrease = (best.profit - currentProfit) / currentProfit;
    if (profitIncrease > this.config.switchThreshold) {
      logger.info(`Switching from ${this.currentCoin} to ${best.symbol} for ${(profitIncrease * 100).toFixed(2)}% profit increase`);
      await this.switchToCoin(best.symbol);
    }
  }

  selectBestCoin() {
    const ranked = this.getRankedCoins();
    return ranked.length > 0 ? ranked[0] : null;
  }

  getRankedCoins() {
    const profits = [];
    
    for (const [symbol, coin] of this.coins) {
      if (!coin.enabled) continue;
      
      const profit = this.calculateProfit(symbol);
      if (profit > 0) {
        profits.push({
          symbol,
          coin,
          profit,
          algorithm: coin.algorithm
        });
      }
    }
    
    // Sort by profit descending
    profits.sort((a, b) => b.profit - a.profit);
    
    return profits;
  }

  async switchToCoin(symbol) {
    const coin = this.coins.get(symbol);
    if (!coin) {
      logger.error(`Cannot switch to unknown coin: ${symbol}`);
      return;
    }
    
    const previousCoin = this.currentCoin;
    this.currentCoin = symbol;
    this.lastSwitch = Date.now();
    
    // Record switch
    this.switchHistory.push({
      timestamp: Date.now(),
      from: previousCoin,
      to: symbol,
      reason: 'profit'
    });
    
    // Keep only last 24 hours of switch history
    const cutoff = Date.now() - 86400000;
    this.switchHistory = this.switchHistory.filter(s => s.timestamp > cutoff);
    
    // Emit switch event
    this.emit('switch', {
      from: previousCoin,
      to: symbol,
      coin,
      algorithm: coin.algorithm,
      estimatedProfit: this.calculateProfit(symbol, { usePrediction: false })
    });
    
    logger.info(`Switched to mining ${symbol} (${coin.algorithm})`);
  }

  startMonitoring() {
    // Periodic evaluation
    this.evaluationInterval = setInterval(() => {
      this.evaluateSwitching().catch(err => {
        logger.error('Error evaluating switching:', err);
      });
    }, this.config.updateInterval);
    
    // ML model training
    this.trainingInterval = setInterval(() => {
      this.trainMLModel().catch(err => {
        logger.error('Error training ML model:', err);
      });
    }, 3600000); // Train every hour
  }

  async trainMLModel() {
    // Simple online learning for price prediction
    for (const [symbol, history] of this.priceHistory) {
      if (history.length < 48) continue; // Need at least 48 data points
      
      // Create training samples
      for (let i = 24; i < history.length - 1; i++) {
        const features = this.extractFeatures(history.slice(i - 24, i));
        const actual = history[i + 1].price;
        const predicted = this.predictPrice(symbol);
        
        const error = actual - predicted;
        
        // Update weights using gradient descent
        for (let j = 0; j < features.length; j++) {
          this.mlModel.weights.price[j] += this.mlModel.learningRate * error * features[j];
        }
        this.mlModel.weights.bias += this.mlModel.learningRate * error;
      }
    }
  }

  getStatistics() {
    const stats = {
      currentCoin: this.currentCoin,
      uptime: Date.now() - this.lastSwitch,
      switchCount: this.switchHistory.length,
      coins: {}
    };
    
    // Calculate profit statistics for each coin
    for (const [symbol, coin] of this.coins) {
      stats.coins[symbol] = {
        currentProfit: this.calculateProfit(symbol, { usePrediction: false }),
        predictedProfit: this.calculateProfit(symbol, { usePrediction: true }),
        price: coin.price,
        difficulty: coin.difficulty,
        enabled: coin.enabled
      };
    }
    
    // Sort by current profit
    const sorted = Object.entries(stats.coins)
      .sort(([, a], [, b]) => b.currentProfit - a.currentProfit);
    
    stats.ranking = sorted.map(([symbol]) => symbol);
    
    return stats;
  }

  stop() {
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
    }
    if (this.trainingInterval) {
      clearInterval(this.trainingInterval);
    }
  }
}

export default AdvancedProfitSwitcher;