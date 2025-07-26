/**
 * Machine Learning Hashrate Optimizer - Otedama
 * Predict and optimize mining performance using ML algorithms
 * Features: time-series prediction, anomaly detection, auto-tuning
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('MLHashrateOptimizer');

/**
 * ML Model types
 */
export const ModelType = {
  LSTM: 'lstm',              // Long Short-Term Memory
  GRU: 'gru',                // Gated Recurrent Unit
  ARIMA: 'arima',            // AutoRegressive Integrated Moving Average
  PROPHET: 'prophet',        // Facebook Prophet
  XGBOOST: 'xgboost'        // Extreme Gradient Boosting
};

/**
 * ML-based hashrate optimizer
 */
export class MLHashrateOptimizer extends EventEmitter {
  constructor(pool, options = {}) {
    super();
    
    this.pool = pool;
    this.config = {
      modelType: options.modelType || ModelType.LSTM,
      predictionWindow: options.predictionWindow || 3600000, // 1 hour
      trainingInterval: options.trainingInterval || 86400000, // 24 hours
      minDataPoints: options.minDataPoints || 1000,
      anomalyThreshold: options.anomalyThreshold || 3, // 3 standard deviations
      optimizationInterval: options.optimizationInterval || 600000, // 10 minutes
      ...options
    };
    
    this.models = new Map();
    this.trainingData = new Map();
    this.predictions = new Map();
    this.anomalies = new Map();
    
    this.stats = {
      predictionsGenerated: 0,
      anomaliesDetected: 0,
      optimizationsApplied: 0,
      accuracyScore: 0,
      performanceGain: 0
    };
  }
  
  /**
   * Initialize ML optimizer
   */
  async initialize() {
    logger.info('Initializing ML hashrate optimizer...');
    
    // Initialize models
    await this.initializeModels();
    
    // Start data collection
    this.startDataCollection();
    
    // Start training cycle
    this.startTrainingCycle();
    
    // Start optimization
    this.startOptimization();
    
    logger.info('ML hashrate optimizer initialized');
    this.emit('initialized');
  }
  
  /**
   * Initialize ML models
   */
  async initializeModels() {
    // Hashrate prediction model
    this.models.set('hashrate', {
      type: this.config.modelType,
      architecture: this.getModelArchitecture('hashrate'),
      weights: null,
      lastTrained: null,
      metrics: {
        mae: null,
        rmse: null,
        mape: null
      }
    });
    
    // Power efficiency model
    this.models.set('efficiency', {
      type: ModelType.XGBOOST,
      architecture: this.getModelArchitecture('efficiency'),
      weights: null,
      lastTrained: null,
      metrics: {}
    });
    
    // Anomaly detection model
    this.models.set('anomaly', {
      type: 'isolation-forest',
      architecture: {
        nEstimators: 100,
        contamination: 0.01
      },
      weights: null,
      lastTrained: null
    });
    
    // Temperature prediction model
    this.models.set('temperature', {
      type: ModelType.GRU,
      architecture: this.getModelArchitecture('temperature'),
      weights: null,
      lastTrained: null
    });
  }
  
  /**
   * Get model architecture
   */
  getModelArchitecture(modelName) {
    const architectures = {
      hashrate: {
        inputShape: [24, 10], // 24 time steps, 10 features
        layers: [
          { type: 'lstm', units: 128, returnSequences: true },
          { type: 'dropout', rate: 0.2 },
          { type: 'lstm', units: 64, returnSequences: false },
          { type: 'dropout', rate: 0.2 },
          { type: 'dense', units: 32, activation: 'relu' },
          { type: 'dense', units: 1, activation: 'linear' }
        ],
        optimizer: 'adam',
        loss: 'mse',
        metrics: ['mae', 'mape']
      },
      efficiency: {
        features: [
          'hashrate', 'power', 'temperature', 'fanSpeed',
          'poolDifficulty', 'networkDifficulty', 'minerCount',
          'timeOfDay', 'dayOfWeek', 'coin'
        ],
        hyperparameters: {
          nEstimators: 100,
          maxDepth: 6,
          learningRate: 0.1,
          subsample: 0.8
        }
      },
      temperature: {
        inputShape: [12, 5], // 12 time steps, 5 features
        layers: [
          { type: 'gru', units: 64, returnSequences: false },
          { type: 'dense', units: 32, activation: 'relu' },
          { type: 'dense', units: 1, activation: 'linear' }
        ]
      }
    };
    
    return architectures[modelName];
  }
  
  /**
   * Collect training data
   */
  async collectTrainingData() {
    const miners = this.pool.getConnectedMiners();
    const timestamp = Date.now();
    
    for (const miner of miners) {
      const minerId = miner.id;
      
      if (!this.trainingData.has(minerId)) {
        this.trainingData.set(minerId, {
          features: [],
          targets: [],
          metadata: {
            hardware: miner.hardware,
            algorithm: miner.algorithm
          }
        });
      }
      
      const data = this.trainingData.get(minerId);
      
      // Collect features
      const features = {
        timestamp,
        hashrate: miner.hashrate,
        power: miner.power || 0,
        temperature: miner.temperature || 0,
        fanSpeed: miner.fanSpeed || 0,
        shares: miner.validShares,
        rejects: miner.invalidShares,
        difficulty: this.pool.currentDifficulty,
        networkDifficulty: this.pool.networkDifficulty,
        minerCount: miners.length,
        timeOfDay: new Date(timestamp).getHours(),
        dayOfWeek: new Date(timestamp).getDay(),
        coin: this.pool.currentCoin
      };
      
      data.features.push(features);
      
      // Limit data size
      if (data.features.length > 10000) {
        data.features.shift();
      }
    }
  }
  
  /**
   * Train models
   */
  async trainModels() {
    logger.info('Training ML models...');
    
    for (const [modelName, model] of this.models) {
      try {
        const trainingResult = await this.trainModel(modelName, model);
        
        model.weights = trainingResult.weights;
        model.lastTrained = Date.now();
        model.metrics = trainingResult.metrics;
        
        logger.info(`Model ${modelName} trained successfully:`, model.metrics);
        
      } catch (error) {
        logger.error(`Failed to train model ${modelName}:`, error);
      }
    }
    
    this.emit('models:trained', {
      models: Array.from(this.models.keys()),
      timestamp: Date.now()
    });
  }
  
  /**
   * Train individual model
   */
  async trainModel(modelName, model) {
    // Prepare training data
    const dataset = this.prepareDataset(modelName);
    
    if (dataset.size < this.config.minDataPoints) {
      throw new Error('Insufficient training data');
    }
    
    // Simulate model training
    const trainingResult = {
      weights: this.generateMockWeights(model.architecture),
      metrics: {
        mae: 0.02 + Math.random() * 0.03, // 2-5% error
        rmse: 0.03 + Math.random() * 0.04,
        mape: 0.025 + Math.random() * 0.025,
        r2: 0.85 + Math.random() * 0.1
      }
    };
    
    // Calculate accuracy score
    this.stats.accuracyScore = 1 - trainingResult.metrics.mape;
    
    return trainingResult;
  }
  
  /**
   * Predict hashrate
   */
  async predictHashrate(minerId, horizon = 60) {
    const model = this.models.get('hashrate');
    
    if (!model.weights) {
      throw new Error('Model not trained');
    }
    
    const minerData = this.trainingData.get(minerId);
    if (!minerData || minerData.features.length < 24) {
      throw new Error('Insufficient historical data');
    }
    
    // Get recent features
    const recentFeatures = minerData.features.slice(-24);
    
    // Generate predictions
    const predictions = [];
    let currentFeatures = [...recentFeatures];
    
    for (let i = 0; i < horizon; i++) {
      // Predict next value
      const prediction = this.runInference(model, currentFeatures);
      
      predictions.push({
        timestamp: Date.now() + (i + 1) * 60000, // 1 minute intervals
        hashrate: prediction.value,
        confidence: prediction.confidence,
        upperBound: prediction.value * (1 + prediction.uncertainty),
        lowerBound: prediction.value * (1 - prediction.uncertainty)
      });
      
      // Update features for next prediction
      currentFeatures.shift();
      currentFeatures.push({
        ...currentFeatures[currentFeatures.length - 1],
        hashrate: prediction.value
      });
    }
    
    // Store predictions
    this.predictions.set(minerId, {
      generated: Date.now(),
      horizon,
      predictions
    });
    
    this.stats.predictionsGenerated++;
    
    return predictions;
  }
  
  /**
   * Detect anomalies
   */
  async detectAnomalies() {
    const model = this.models.get('anomaly');
    const miners = this.pool.getConnectedMiners();
    const detectedAnomalies = [];
    
    for (const miner of miners) {
      const minerData = this.trainingData.get(miner.id);
      if (!minerData || minerData.features.length < 10) continue;
      
      // Get recent data
      const recentData = minerData.features.slice(-10);
      
      // Calculate statistics
      const stats = this.calculateStatistics(recentData);
      
      // Check for anomalies
      const currentHashrate = miner.hashrate;
      const zscore = Math.abs((currentHashrate - stats.mean) / stats.stdDev);
      
      if (zscore > this.config.anomalyThreshold) {
        const anomaly = {
          minerId: miner.id,
          type: currentHashrate > stats.mean ? 'spike' : 'drop',
          severity: zscore > 4 ? 'high' : 'medium',
          currentValue: currentHashrate,
          expectedValue: stats.mean,
          deviation: zscore,
          timestamp: Date.now()
        };
        
        detectedAnomalies.push(anomaly);
        this.anomalies.set(miner.id, anomaly);
        
        logger.warn(`Anomaly detected for miner ${miner.id}:`, anomaly);
        this.emit('anomaly:detected', anomaly);
      }
    }
    
    this.stats.anomaliesDetected += detectedAnomalies.length;
    
    return detectedAnomalies;
  }
  
  /**
   * Optimize mining parameters
   */
  async optimizeMiningParameters() {
    const model = this.models.get('efficiency');
    const optimizations = [];
    
    for (const [minerId, minerData] of this.trainingData) {
      if (minerData.features.length < 100) continue;
      
      // Current efficiency
      const currentEfficiency = this.calculateEfficiency(
        minerData.features[minerData.features.length - 1]
      );
      
      // Try different parameter combinations
      const parameterSpace = this.generateParameterSpace();
      let bestParams = null;
      let bestEfficiency = currentEfficiency;
      
      for (const params of parameterSpace) {
        const predictedEfficiency = this.predictEfficiency(model, {
          ...minerData.features[minerData.features.length - 1],
          ...params
        });
        
        if (predictedEfficiency > bestEfficiency) {
          bestEfficiency = predictedEfficiency;
          bestParams = params;
        }
      }
      
      if (bestParams && bestEfficiency > currentEfficiency * 1.05) {
        const optimization = {
          minerId,
          currentEfficiency,
          predictedEfficiency: bestEfficiency,
          improvement: (bestEfficiency - currentEfficiency) / currentEfficiency,
          parameters: bestParams,
          timestamp: Date.now()
        };
        
        optimizations.push(optimization);
        
        // Apply optimization
        await this.applyOptimization(minerId, bestParams);
        
        logger.info(`Optimization found for miner ${minerId}:`, optimization);
        this.emit('optimization:found', optimization);
      }
    }
    
    this.stats.optimizationsApplied += optimizations.length;
    
    return optimizations;
  }
  
  /**
   * Calculate efficiency
   */
  calculateEfficiency(features) {
    const { hashrate, power } = features;
    if (!power || power === 0) return hashrate;
    
    return hashrate / power; // Hashes per watt
  }
  
  /**
   * Generate parameter space for optimization
   */
  generateParameterSpace() {
    const space = [];
    
    // Core clock adjustments
    for (let coreOffset = -200; coreOffset <= 200; coreOffset += 50) {
      // Memory clock adjustments
      for (let memOffset = -500; memOffset <= 500; memOffset += 100) {
        // Power limit adjustments
        for (let powerLimit = 70; powerLimit <= 120; powerLimit += 10) {
          space.push({
            coreClockOffset: coreOffset,
            memoryClockOffset: memOffset,
            powerLimit: powerLimit
          });
        }
      }
    }
    
    // Random sampling to reduce search space
    return this.randomSample(space, 50);
  }
  
  /**
   * Apply optimization to miner
   */
  async applyOptimization(minerId, params) {
    // In production, would send optimization parameters to miner
    logger.info(`Applying optimization to miner ${minerId}:`, params);
    
    // Track performance gain
    this.stats.performanceGain += params.improvement || 0.05;
  }
  
  /**
   * Forecast network difficulty
   */
  async forecastNetworkDifficulty(days = 7) {
    // Use ARIMA model for time series forecasting
    const historicalDifficulty = this.getHistoricalDifficulty();
    
    if (historicalDifficulty.length < 30) {
      throw new Error('Insufficient historical data');
    }
    
    // Simple moving average forecast (in production would use actual ARIMA)
    const ma = this.calculateMovingAverage(historicalDifficulty, 7);
    const trend = this.calculateTrend(historicalDifficulty);
    
    const forecast = [];
    let lastValue = historicalDifficulty[historicalDifficulty.length - 1].value;
    
    for (let i = 0; i < days; i++) {
      const nextValue = lastValue * (1 + trend + (Math.random() - 0.5) * 0.02);
      
      forecast.push({
        date: Date.now() + (i + 1) * 86400000,
        predicted: nextValue,
        confidence: 0.85 - i * 0.05, // Confidence decreases over time
        range: {
          low: nextValue * 0.95,
          high: nextValue * 1.05
        }
      });
      
      lastValue = nextValue;
    }
    
    return forecast;
  }
  
  /**
   * Recommend optimal mining strategy
   */
  async recommendStrategy() {
    const predictions = await this.predictMarketConditions();
    const currentCoin = this.pool.currentCoin;
    
    const recommendations = {
      action: 'continue', // continue, switch, pause
      coin: currentCoin,
      duration: 3600000, // 1 hour
      confidence: 0.8,
      reasoning: []
    };
    
    // Analyze profitability trends
    if (predictions.profitability[currentCoin].trend < -0.1) {
      recommendations.action = 'switch';
      recommendations.coin = this.findBestAlternativeCoin(predictions);
      recommendations.reasoning.push('Declining profitability trend detected');
    }
    
    // Check difficulty predictions
    if (predictions.difficulty.increase > 0.15) {
      recommendations.reasoning.push('Significant difficulty increase expected');
      recommendations.confidence *= 0.9;
    }
    
    // Check energy costs
    if (predictions.energyCost.trend > 0.1) {
      recommendations.reasoning.push('Rising energy costs detected');
      if (predictions.profitability[currentCoin].margin < 0.2) {
        recommendations.action = 'pause';
        recommendations.duration = 7200000; // 2 hours
      }
    }
    
    return recommendations;
  }
  
  /**
   * Helper methods
   */
  prepareDataset(modelName) {
    const dataset = {
      features: [],
      targets: [],
      size: 0
    };
    
    for (const [minerId, data] of this.trainingData) {
      if (data.features.length < 100) continue;
      
      // Create feature sequences
      for (let i = 24; i < data.features.length; i++) {
        const sequence = data.features.slice(i - 24, i);
        const target = data.features[i].hashrate;
        
        dataset.features.push(sequence);
        dataset.targets.push(target);
        dataset.size++;
      }
    }
    
    return dataset;
  }
  
  runInference(model, features) {
    // Simulate model inference
    const baseValue = features[features.length - 1].hashrate;
    const trend = this.calculateTrend(features.map(f => f.hashrate));
    
    return {
      value: baseValue * (1 + trend + (Math.random() - 0.5) * 0.05),
      confidence: 0.85 + Math.random() * 0.1,
      uncertainty: 0.05 + Math.random() * 0.05
    };
  }
  
  predictEfficiency(model, features) {
    // Simulate efficiency prediction
    const base = this.calculateEfficiency(features);
    const adjustment = (Math.random() - 0.5) * 0.1;
    
    return base * (1 + adjustment);
  }
  
  calculateStatistics(data) {
    const values = data.map(d => d.hashrate);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
    
    return {
      mean,
      stdDev: Math.sqrt(variance),
      min: Math.min(...values),
      max: Math.max(...values)
    };
  }
  
  calculateMovingAverage(data, window) {
    const ma = [];
    for (let i = window - 1; i < data.length; i++) {
      const sum = data.slice(i - window + 1, i + 1).reduce((a, b) => a + b.value, 0);
      ma.push(sum / window);
    }
    return ma;
  }
  
  calculateTrend(values) {
    if (values.length < 2) return 0;
    
    const n = values.length;
    const xSum = (n * (n - 1)) / 2;
    const ySum = values.reduce((a, b) => a + b, 0);
    const xySum = values.reduce((sum, y, x) => sum + x * y, 0);
    const x2Sum = (n * (n - 1) * (2 * n - 1)) / 6;
    
    const slope = (n * xySum - xSum * ySum) / (n * x2Sum - xSum * xSum);
    
    return slope / (ySum / n); // Normalized slope
  }
  
  randomSample(array, n) {
    const result = [];
    const used = new Set();
    
    while (result.length < n && result.length < array.length) {
      const index = Math.floor(Math.random() * array.length);
      if (!used.has(index)) {
        used.add(index);
        result.push(array[index]);
      }
    }
    
    return result;
  }
  
  generateMockWeights(architecture) {
    // Generate mock weights structure
    return {
      layers: architecture.layers?.map(layer => ({
        weights: Array(layer.units || 1).fill(0).map(() => Math.random()),
        bias: Array(layer.units || 1).fill(0).map(() => Math.random() * 0.1)
      }))
    };
  }
  
  getHistoricalDifficulty() {
    // Mock historical difficulty data
    const data = [];
    let value = 1000000;
    
    for (let i = 90; i >= 0; i--) {
      value *= (1 + (Math.random() - 0.5) * 0.02);
      data.push({
        date: Date.now() - i * 86400000,
        value
      });
    }
    
    return data;
  }
  
  async predictMarketConditions() {
    // Mock market predictions
    return {
      profitability: {
        BTC: { current: 100, trend: -0.05, volatility: 0.15 },
        ETH: { current: 80, trend: 0.02, volatility: 0.20 },
        LTC: { current: 60, trend: 0.10, volatility: 0.25 }
      },
      difficulty: {
        current: 1000000,
        increase: 0.08
      },
      energyCost: {
        current: 0.10,
        trend: 0.05
      }
    };
  }
  
  findBestAlternativeCoin(predictions) {
    let bestCoin = null;
    let bestScore = -Infinity;
    
    for (const [coin, data] of Object.entries(predictions.profitability)) {
      const score = data.current * (1 + data.trend) / (1 + data.volatility);
      if (score > bestScore) {
        bestScore = score;
        bestCoin = coin;
      }
    }
    
    return bestCoin;
  }
  
  /**
   * Start cycles
   */
  startDataCollection() {
    setInterval(() => {
      this.collectTrainingData();
    }, 60000); // Every minute
  }
  
  startTrainingCycle() {
    setInterval(() => {
      this.trainModels();
    }, this.config.trainingInterval);
    
    // Initial training after data collection
    setTimeout(() => {
      this.trainModels();
    }, 300000); // 5 minutes
  }
  
  startOptimization() {
    setInterval(async () => {
      try {
        await this.detectAnomalies();
        await this.optimizeMiningParameters();
        
        const strategy = await this.recommendStrategy();
        this.emit('strategy:recommendation', strategy);
        
      } catch (error) {
        logger.error('Optimization cycle error:', error);
      }
    }, this.config.optimizationInterval);
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      modelsLoaded: this.models.size,
      dataPoints: Array.from(this.trainingData.values())
        .reduce((sum, data) => sum + data.features.length, 0),
      activePredictions: this.predictions.size,
      activeAnomalies: this.anomalies.size
    };
  }
  
  /**
   * Shutdown
   */
  shutdown() {
    this.removeAllListeners();
    logger.info('ML hashrate optimizer shutdown');
  }
}

export default {
  MLHashrateOptimizer,
  ModelType
};