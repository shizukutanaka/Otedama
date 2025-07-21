/**
 * Intelligent Profit Switching and Auto-Tuning System
 * Maximizes mining profitability through AI-driven decisions
 */

import { EventEmitter } from 'events';
import { logger } from '../../core/logger.js';

/**
 * Profit calculation models
 */
export const ProfitModel = {
  SIMPLE: 'simple',           // Basic price * hashrate
  ADVANCED: 'advanced',       // Includes difficulty, fees, power
  PREDICTIVE: 'predictive',   // ML-based future profit prediction
  HOLISTIC: 'holistic'        // Complete cost-benefit analysis
};

/**
 * Switching strategies
 */
export const SwitchingStrategy = {
  AGGRESSIVE: 'aggressive',     // Switch immediately for any profit
  CONSERVATIVE: 'conservative', // Switch only for significant gains
  ADAPTIVE: 'adaptive',        // Adjust based on market conditions
  SCHEDULED: 'scheduled'       // Switch at predetermined times
};

/**
 * Coin profitability data
 */
export class CoinProfitability {
  constructor(data) {
    this.coin = data.coin;
    this.algorithm = data.algorithm;
    this.price = data.price;
    this.difficulty = data.difficulty;
    this.blockReward = data.blockReward;
    this.blockTime = data.blockTime;
    this.marketCap = data.marketCap;
    this.volume24h = data.volume24h;
    this.priceChange24h = data.priceChange24h;
    
    // Network stats
    this.networkHashrate = data.networkHashrate;
    this.poolFee = data.poolFee || 0.01;
    
    // Exchange info
    this.exchanges = data.exchanges || [];
    this.liquidity = data.liquidity || 0;
    
    // Historical data
    this.priceHistory = [];
    this.difficultyHistory = [];
    this.profitHistory = [];
    
    // Predictions
    this.predictions = {
      price: null,
      difficulty: null,
      profit: null
    };
  }
  
  /**
   * Calculate instantaneous profitability
   */
  calculateProfit(hashrate, powerCost = 0, powerConsumption = 0) {
    // Coins per day
    const blocksPerDay = (86400 / this.blockTime);
    const networkShare = hashrate / this.networkHashrate;
    const coinsPerDay = blocksPerDay * this.blockReward * networkShare * (1 - this.poolFee);
    
    // Revenue
    const revenue = coinsPerDay * this.price;
    
    // Costs
    const powerCostPerDay = (powerConsumption / 1000) * 24 * powerCost; // kWh * hours * $/kWh
    
    // Profit
    const profit = revenue - powerCostPerDay;
    
    return {
      revenue,
      powerCost: powerCostPerDay,
      profit,
      profitRatio: revenue > 0 ? profit / revenue : 0,
      coinsPerDay,
      roi: powerCostPerDay > 0 ? profit / powerCostPerDay : Infinity
    };
  }
  
  /**
   * Update historical data
   */
  updateHistory(timestamp) {
    this.priceHistory.push({ timestamp, value: this.price });
    this.difficultyHistory.push({ timestamp, value: this.difficulty });
    
    // Maintain history size
    const maxHistory = 1000;
    if (this.priceHistory.length > maxHistory) {
      this.priceHistory.shift();
      this.difficultyHistory.shift();
      this.profitHistory.shift();
    }
  }
  
  /**
   * Get stability score
   */
  getStabilityScore() {
    if (this.priceHistory.length < 10) return 0.5;
    
    // Calculate price volatility
    const prices = this.priceHistory.slice(-24).map(p => p.value);
    const avgPrice = prices.reduce((a, b) => a + b) / prices.length;
    const variance = prices.reduce((sum, price) => {
      return sum + Math.pow(price - avgPrice, 2);
    }, 0) / prices.length;
    const volatility = Math.sqrt(variance) / avgPrice;
    
    // Calculate difficulty stability
    const difficulties = this.difficultyHistory.slice(-10).map(d => d.value);
    const avgDiff = difficulties.reduce((a, b) => a + b) / difficulties.length;
    const diffVariance = difficulties.reduce((sum, diff) => {
      return sum + Math.pow(diff - avgDiff, 2);
    }, 0) / difficulties.length;
    const diffVolatility = Math.sqrt(diffVariance) / avgDiff;
    
    // Combined stability score (0-1, higher is more stable)
    const priceStability = Math.max(0, 1 - volatility);
    const diffStability = Math.max(0, 1 - diffVolatility);
    
    return (priceStability * 0.7 + diffStability * 0.3);
  }
}

/**
 * Machine learning profit predictor
 */
export class ProfitPredictor {
  constructor() {
    this.models = new Map();
    this.features = [
      'price', 'difficulty', 'volume', 'marketCap',
      'priceChange24h', 'dayOfWeek', 'hourOfDay'
    ];
  }
  
  /**
   * Train model for specific coin
   */
  trainModel(coin, historicalData) {
    // Simplified linear regression model
    const model = {
      weights: new Array(this.features.length).fill(0),
      bias: 0,
      trained: false
    };
    
    if (historicalData.length < 100) {
      logger.warn(`Insufficient data for training ${coin} model`);
      return;
    }
    
    // Extract features and labels
    const X = [];
    const y = [];
    
    for (let i = 1; i < historicalData.length; i++) {
      const features = this.extractFeatures(historicalData[i]);
      const label = historicalData[i].profit;
      
      X.push(features);
      y.push(label);
    }
    
    // Simple gradient descent
    const learningRate = 0.001;
    const epochs = 100;
    
    for (let epoch = 0; epoch < epochs; epoch++) {
      let totalError = 0;
      
      for (let i = 0; i < X.length; i++) {
        // Forward pass
        let prediction = model.bias;
        for (let j = 0; j < this.features.length; j++) {
          prediction += model.weights[j] * X[i][j];
        }
        
        // Calculate error
        const error = y[i] - prediction;
        totalError += Math.abs(error);
        
        // Backward pass
        model.bias += learningRate * error;
        for (let j = 0; j < this.features.length; j++) {
          model.weights[j] += learningRate * error * X[i][j];
        }
      }
      
      // Log training progress
      if (epoch % 10 === 0) {
        logger.debug(`Training ${coin} - Epoch ${epoch}, Error: ${totalError / X.length}`);
      }
    }
    
    model.trained = true;
    this.models.set(coin, model);
  }
  
  /**
   * Extract features from data point
   */
  extractFeatures(data) {
    const date = new Date(data.timestamp);
    
    return [
      data.price / 1000,                    // Normalized price
      Math.log10(data.difficulty),          // Log difficulty
      data.volume / 1e9,                    // Normalized volume
      data.marketCap / 1e12,                // Normalized market cap
      data.priceChange24h / 100,            // Percentage as decimal
      date.getDay() / 7,                    // Day of week normalized
      date.getHours() / 24                  // Hour of day normalized
    ];
  }
  
  /**
   * Predict future profitability
   */
  predict(coin, currentData, hoursAhead = 24) {
    const model = this.models.get(coin);
    if (!model || !model.trained) {
      return null;
    }
    
    const features = this.extractFeatures(currentData);
    
    // Simple linear prediction
    let prediction = model.bias;
    for (let i = 0; i < features.length; i++) {
      prediction += model.weights[i] * features[i];
    }
    
    // Adjust for time ahead
    const decayFactor = Math.exp(-hoursAhead / 168); // Weekly decay
    prediction *= decayFactor;
    
    return Math.max(0, prediction);
  }
}

/**
 * Intelligent profit switching system
 */
export class IntelligentProfitSwitcher extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      model: options.model || ProfitModel.HOLISTIC,
      strategy: options.strategy || SwitchingStrategy.ADAPTIVE,
      updateInterval: options.updateInterval || 60000, // 1 minute
      switchThreshold: options.switchThreshold || 0.05, // 5% improvement
      minSwitchInterval: options.minSwitchInterval || 300000, // 5 minutes
      powerCost: options.powerCost || 0.10, // $/kWh
      includeFees: options.includeFees !== false,
      ...options
    };
    
    // Supported coins
    this.coins = new Map();
    this.currentCoin = null;
    this.lastSwitch = 0;
    
    // ML predictor
    this.predictor = new ProfitPredictor();
    
    // Auto-tuning parameters
    this.tuningParams = {
      hashrate: 0,
      powerConsumption: 0,
      efficiency: 1.0,
      overclock: {
        core: 0,
        memory: 0,
        powerLimit: 100
      }
    };
    
    // Statistics
    this.stats = {
      switches: 0,
      totalProfit: 0,
      avgSwitchGain: 0,
      predictions: {
        total: 0,
        correct: 0,
        accuracy: 0
      }
    };
    
    // Market data sources
    this.dataSources = [];
    
    this.isRunning = false;
    this.updateTimer = null;
  }
  
  /**
   * Add coin to switcher
   */
  addCoin(coinData) {
    const coin = new CoinProfitability(coinData);
    this.coins.set(coin.coin, coin);
    
    logger.info(`Added coin for profit switching: ${coin.coin}`);
    
    this.emit('coin:added', coin);
  }
  
  /**
   * Remove coin
   */
  removeCoin(coinSymbol) {
    if (this.currentCoin?.coin === coinSymbol) {
      logger.warn('Cannot remove currently mined coin');
      return false;
    }
    
    this.coins.delete(coinSymbol);
    this.emit('coin:removed', coinSymbol);
    
    return true;
  }
  
  /**
   * Start profit switching
   */
  async start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    
    logger.info('Starting intelligent profit switcher');
    
    // Initial profitability calculation
    await this.updateProfitability();
    
    // Select initial coin
    this.selectBestCoin();
    
    // Start periodic updates
    this.updateTimer = setInterval(async () => {
      await this.updateProfitability();
      this.evaluateSwitch();
    }, this.options.updateInterval);
    
    this.emit('started');
  }
  
  /**
   * Update profitability data
   */
  async updateProfitability() {
    const updatePromises = [];
    
    for (const coin of this.coins.values()) {
      updatePromises.push(this.updateCoinData(coin));
    }
    
    await Promise.all(updatePromises);
    
    // Train ML models if enough data
    for (const coin of this.coins.values()) {
      if (coin.priceHistory.length >= 100) {
        this.predictor.trainModel(coin.coin, coin.profitHistory);
      }
    }
  }
  
  /**
   * Update single coin data
   */
  async updateCoinData(coin) {
    try {
      // Fetch latest market data
      const marketData = await this.fetchMarketData(coin.coin);
      
      // Update coin data
      coin.price = marketData.price;
      coin.difficulty = marketData.difficulty;
      coin.networkHashrate = marketData.networkHashrate;
      coin.volume24h = marketData.volume24h;
      coin.priceChange24h = marketData.priceChange24h;
      
      // Update history
      const timestamp = Date.now();
      coin.updateHistory(timestamp);
      
      // Calculate current profitability
      const profit = coin.calculateProfit(
        this.tuningParams.hashrate,
        this.options.powerCost,
        this.tuningParams.powerConsumption
      );
      
      coin.profitHistory.push({
        timestamp,
        profit: profit.profit,
        revenue: profit.revenue,
        cost: profit.powerCost
      });
      
      // Get predictions if model trained
      if (this.options.model === ProfitModel.PREDICTIVE) {
        coin.predictions.profit = this.predictor.predict(coin.coin, {
          ...marketData,
          timestamp
        });
      }
      
    } catch (error) {
      logger.error(`Failed to update ${coin.coin} data: ${error.message}`);
    }
  }
  
  /**
   * Fetch market data (mock implementation)
   */
  async fetchMarketData(coinSymbol) {
    // In real implementation, would fetch from exchanges/APIs
    return {
      price: Math.random() * 1000 + 100,
      difficulty: Math.random() * 1e12 + 1e11,
      networkHashrate: Math.random() * 1e18 + 1e17,
      volume24h: Math.random() * 1e9 + 1e8,
      priceChange24h: (Math.random() - 0.5) * 20
    };
  }
  
  /**
   * Select best coin to mine
   */
  selectBestCoin() {
    let bestCoin = null;
    let bestScore = -Infinity;
    
    for (const coin of this.coins.values()) {
      const score = this.calculateCoinScore(coin);
      
      if (score > bestScore) {
        bestScore = score;
        bestCoin = coin;
      }
    }
    
    if (bestCoin && bestCoin !== this.currentCoin) {
      this.switchToCoin(bestCoin);
    }
    
    return bestCoin;
  }
  
  /**
   * Calculate coin score based on model
   */
  calculateCoinScore(coin) {
    const profit = coin.calculateProfit(
      this.tuningParams.hashrate,
      this.options.powerCost,
      this.tuningParams.powerConsumption
    );
    
    let score = profit.profit;
    
    switch (this.options.model) {
      case ProfitModel.SIMPLE:
        // Just use profit
        break;
        
      case ProfitModel.ADVANCED:
        // Include fees and stability
        if (this.options.includeFees) {
          score *= (1 - coin.poolFee);
        }
        score *= coin.getStabilityScore();
        break;
        
      case ProfitModel.PREDICTIVE:
        // Use predicted future profit
        if (coin.predictions.profit !== null) {
          score = coin.predictions.profit;
        }
        break;
        
      case ProfitModel.HOLISTIC:
        // Complete analysis
        const stability = coin.getStabilityScore();
        const liquidity = Math.log10(coin.liquidity + 1) / 10;
        const trend = coin.priceChange24h > 0 ? 1.1 : 0.9;
        
        score = profit.profit * stability * liquidity * trend;
        
        // Penalize frequent switching
        if (coin === this.currentCoin) {
          score *= 1.05; // 5% bonus for current coin
        }
        break;
    }
    
    return score;
  }
  
  /**
   * Evaluate if switch is beneficial
   */
  evaluateSwitch() {
    if (!this.currentCoin) {
      this.selectBestCoin();
      return;
    }
    
    // Check minimum switch interval
    if (Date.now() - this.lastSwitch < this.options.minSwitchInterval) {
      return;
    }
    
    const currentScore = this.calculateCoinScore(this.currentCoin);
    let shouldSwitch = false;
    let targetCoin = null;
    
    switch (this.options.strategy) {
      case SwitchingStrategy.AGGRESSIVE:
        // Switch for any improvement
        targetCoin = this.selectBestCoin();
        if (targetCoin !== this.currentCoin) {
          shouldSwitch = true;
        }
        break;
        
      case SwitchingStrategy.CONSERVATIVE:
        // Switch only for significant improvement
        for (const coin of this.coins.values()) {
          if (coin === this.currentCoin) continue;
          
          const score = this.calculateCoinScore(coin);
          if (score > currentScore * (1 + this.options.switchThreshold * 2)) {
            shouldSwitch = true;
            targetCoin = coin;
            break;
          }
        }
        break;
        
      case SwitchingStrategy.ADAPTIVE:
        // Adjust threshold based on market conditions
        const marketVolatility = this.calculateMarketVolatility();
        const adaptiveThreshold = this.options.switchThreshold * (1 + marketVolatility);
        
        for (const coin of this.coins.values()) {
          if (coin === this.currentCoin) continue;
          
          const score = this.calculateCoinScore(coin);
          if (score > currentScore * (1 + adaptiveThreshold)) {
            shouldSwitch = true;
            targetCoin = coin;
            break;
          }
        }
        break;
        
      case SwitchingStrategy.SCHEDULED:
        // Switch at predetermined times
        const hour = new Date().getHours();
        if ([0, 6, 12, 18].includes(hour)) {
          targetCoin = this.selectBestCoin();
          if (targetCoin !== this.currentCoin) {
            shouldSwitch = true;
          }
        }
        break;
    }
    
    if (shouldSwitch && targetCoin) {
      const gain = this.calculateCoinScore(targetCoin) - currentScore;
      
      logger.info(`Switching opportunity detected: ${this.currentCoin.coin} -> ${targetCoin.coin} (+${gain.toFixed(2)})`);
      
      this.switchToCoin(targetCoin);
    }
  }
  
  /**
   * Calculate market volatility
   */
  calculateMarketVolatility() {
    let totalVolatility = 0;
    let count = 0;
    
    for (const coin of this.coins.values()) {
      const volatility = 1 - coin.getStabilityScore();
      totalVolatility += volatility;
      count++;
    }
    
    return count > 0 ? totalVolatility / count : 0;
  }
  
  /**
   * Switch to new coin
   */
  switchToCoin(coin) {
    const oldCoin = this.currentCoin;
    this.currentCoin = coin;
    this.lastSwitch = Date.now();
    this.stats.switches++;
    
    // Auto-tune for new coin
    this.autoTuneForCoin(coin);
    
    logger.info(`Switched mining to ${coin.coin}`);
    
    this.emit('coin:switched', {
      from: oldCoin,
      to: coin,
      reason: 'profitability'
    });
  }
  
  /**
   * Auto-tune hardware for specific coin
   */
  autoTuneForCoin(coin) {
    // Algorithm-specific tuning
    const tuningProfiles = {
      'SHA256': {
        overclock: { core: 100, memory: -200, powerLimit: 100 }
      },
      'Ethash': {
        overclock: { core: -200, memory: 1000, powerLimit: 80 }
      },
      'RandomX': {
        overclock: { core: 0, memory: 0, powerLimit: 90 }
      },
      'Scrypt': {
        overclock: { core: 50, memory: 500, powerLimit: 95 }
      }
    };
    
    const profile = tuningProfiles[coin.algorithm] || {
      overclock: { core: 0, memory: 0, powerLimit: 100 }
    };
    
    // Apply tuning
    this.tuningParams.overclock = profile.overclock;
    
    // Adjust efficiency based on algorithm
    if (coin.algorithm === 'Ethash') {
      this.tuningParams.efficiency = 0.95; // Memory-bound
    } else if (coin.algorithm === 'SHA256') {
      this.tuningParams.efficiency = 0.98; // Compute-bound
    } else {
      this.tuningParams.efficiency = 0.93; // General
    }
    
    logger.info(`Auto-tuned for ${coin.algorithm}: ${JSON.stringify(profile.overclock)}`);
    
    this.emit('hardware:tuned', {
      coin: coin.coin,
      algorithm: coin.algorithm,
      tuning: this.tuningParams
    });
  }
  
  /**
   * Set hardware parameters
   */
  setHardwareParams(params) {
    Object.assign(this.tuningParams, params);
    
    // Recalculate profitability with new params
    this.updateProfitability();
  }
  
  /**
   * Get profitability ranking
   */
  getProfitabilityRanking() {
    const ranking = [];
    
    for (const coin of this.coins.values()) {
      const profit = coin.calculateProfit(
        this.tuningParams.hashrate,
        this.options.powerCost,
        this.tuningParams.powerConsumption
      );
      
      ranking.push({
        coin: coin.coin,
        algorithm: coin.algorithm,
        price: coin.price,
        difficulty: coin.difficulty,
        profit: profit.profit,
        revenue: profit.revenue,
        score: this.calculateCoinScore(coin),
        stability: coin.getStabilityScore(),
        isCurrent: coin === this.currentCoin
      });
    }
    
    return ranking.sort((a, b) => b.score - a.score);
  }
  
  /**
   * Get statistics
   */
  getStats() {
    const ranking = this.getProfitabilityRanking();
    const currentProfit = this.currentCoin ? 
      ranking.find(r => r.coin === this.currentCoin.coin)?.profit || 0 : 0;
    
    return {
      ...this.stats,
      currentCoin: this.currentCoin?.coin,
      currentProfit,
      model: this.options.model,
      strategy: this.options.strategy,
      marketVolatility: this.calculateMarketVolatility(),
      ranking,
      hardware: this.tuningParams,
      lastSwitch: this.lastSwitch
    };
  }
  
  /**
   * Stop profit switching
   */
  stop() {
    this.isRunning = false;
    
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    
    logger.info('Profit switcher stopped');
    
    this.emit('stopped');
  }
}

export default IntelligentProfitSwitcher;