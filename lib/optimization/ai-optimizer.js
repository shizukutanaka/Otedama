/**
 * AI-Powered Performance Optimizer - Otedama
 * Machine learning-based optimization for mining operations
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import * as tf from '@tensorflow/tfjs-node';

const logger = createStructuredLogger('AIOptimizer');

export class AIOptimizer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Model parameters
      modelPath: options.modelPath || './models/optimizer',
      inputFeatures: options.inputFeatures || 20,
      hiddenLayers: options.hiddenLayers || [128, 64, 32],
      outputActions: options.outputActions || 10,
      
      // Training parameters
      learningRate: options.learningRate || 0.001,
      batchSize: options.batchSize || 32,
      epochs: options.epochs || 100,
      trainInterval: options.trainInterval || 3600000, // 1 hour
      
      // Optimization targets
      targets: {
        hashrate: options.targetHashrate || 'maximize',
        power: options.targetPower || 'minimize',
        temperature: options.targetTemperature || 85, // °C
        efficiency: options.targetEfficiency || 'maximize',
        profitability: options.targetProfitability || 'maximize'
      },
      
      // Features
      enableRL: options.enableRL !== false, // Reinforcement Learning
      enableAnomalyDetection: options.enableAnomalyDetection !== false,
      enablePrediction: options.enablePrediction !== false,
      
      ...options
    };
    
    // Models
    this.models = {
      optimizer: null,
      anomalyDetector: null,
      predictor: null
    };
    
    // State
    this.state = {
      isTraining: false,
      modelVersion: 0,
      lastOptimization: null,
      trainingData: [],
      replayBuffer: []
    };
    
    // Metrics history
    this.history = {
      hashrate: [],
      power: [],
      temperature: [],
      efficiency: [],
      profitability: [],
      actions: []
    };
    
    // Optimization results
    this.optimizations = {
      frequency: { current: 1200, optimal: 1200 }, // MHz
      voltage: { current: 750, optimal: 750 }, // mV
      fanSpeed: { current: 80, optimal: 80 }, // %
      memoryFreq: { current: 1750, optimal: 1750 }, // MHz
      powerLimit: { current: 250, optimal: 250 }, // W
      intensity: { current: 20, optimal: 20 },
      threads: { current: 4, optimal: 4 },
      workSize: { current: 256, optimal: 256 }
    };
    
    // Statistics
    this.stats = {
      optimizationCount: 0,
      improvementRate: 0,
      anomaliesDetected: 0,
      predictionsAccuracy: 0,
      totalReward: 0
    };
  }
  
  /**
   * Initialize AI models
   */
  async initialize() {
    logger.info('Initializing AI optimizer');
    
    try {
      // Load or create models
      if (this.options.modelPath && await this.modelExists()) {
        await this.loadModels();
      } else {
        await this.createModels();
      }
      
      // Start training loop if enabled
      if (this.options.enableRL) {
        this.startTrainingLoop();
      }
      
      logger.info('AI optimizer initialized', {
        models: Object.keys(this.models).filter(k => this.models[k] !== null)
      });
      
    } catch (error) {
      logger.error('Failed to initialize AI optimizer', { error: error.message });
      throw error;
    }
  }
  
  /**
   * Create neural network models
   */
  async createModels() {
    // Main optimization model (Deep Q-Network for RL)
    this.models.optimizer = tf.sequential({
      layers: [
        tf.layers.dense({
          inputShape: [this.options.inputFeatures],
          units: this.options.hiddenLayers[0],
          activation: 'relu',
          kernelInitializer: 'heNormal'
        }),
        tf.layers.dropout({ rate: 0.2 }),
        tf.layers.dense({
          units: this.options.hiddenLayers[1],
          activation: 'relu',
          kernelInitializer: 'heNormal'
        }),
        tf.layers.dropout({ rate: 0.2 }),
        tf.layers.dense({
          units: this.options.hiddenLayers[2],
          activation: 'relu',
          kernelInitializer: 'heNormal'
        }),
        tf.layers.dense({
          units: this.options.outputActions,
          activation: 'linear'
        })
      ]
    });
    
    this.models.optimizer.compile({
      optimizer: tf.train.adam(this.options.learningRate),
      loss: 'meanSquaredError',
      metrics: ['mse']
    });
    
    // Anomaly detection model (Autoencoder)
    if (this.options.enableAnomalyDetection) {
      const encoder = tf.sequential({
        layers: [
          tf.layers.dense({
            inputShape: [this.options.inputFeatures],
            units: 32,
            activation: 'relu'
          }),
          tf.layers.dense({
            units: 16,
            activation: 'relu'
          }),
          tf.layers.dense({
            units: 8,
            activation: 'relu'
          })
        ]
      });
      
      const decoder = tf.sequential({
        layers: [
          tf.layers.dense({
            inputShape: [8],
            units: 16,
            activation: 'relu'
          }),
          tf.layers.dense({
            units: 32,
            activation: 'relu'
          }),
          tf.layers.dense({
            units: this.options.inputFeatures,
            activation: 'sigmoid'
          })
        ]
      });
      
      this.models.anomalyDetector = tf.sequential({
        layers: [...encoder.layers, ...decoder.layers]
      });
      
      this.models.anomalyDetector.compile({
        optimizer: tf.train.adam(0.001),
        loss: 'meanSquaredError'
      });
    }
    
    // Prediction model (LSTM for time series)
    if (this.options.enablePrediction) {
      this.models.predictor = tf.sequential({
        layers: [
          tf.layers.lstm({
            inputShape: [10, this.options.inputFeatures],
            units: 64,
            returnSequences: true
          }),
          tf.layers.lstm({
            units: 32,
            returnSequences: false
          }),
          tf.layers.dense({
            units: 16,
            activation: 'relu'
          }),
          tf.layers.dense({
            units: 5, // Predict 5 key metrics
            activation: 'linear'
          })
        ]
      });
      
      this.models.predictor.compile({
        optimizer: tf.train.adam(0.001),
        loss: 'meanSquaredError'
      });
    }
  }
  
  /**
   * Optimize mining parameters
   */
  async optimize(currentMetrics) {
    const startTime = Date.now();
    
    try {
      // Prepare input features
      const features = this.prepareFeatures(currentMetrics);
      
      // Get optimization actions
      const actions = await this.getOptimalActions(features);
      
      // Convert actions to parameter adjustments
      const adjustments = this.actionsToAdjustments(actions);
      
      // Apply safety constraints
      const safeAdjustments = this.applySafetyConstraints(adjustments, currentMetrics);
      
      // Update optimization state
      this.updateOptimizations(safeAdjustments);
      
      // Record for training
      if (this.options.enableRL) {
        this.recordExperience(features, actions, currentMetrics);
      }
      
      // Detect anomalies
      if (this.options.enableAnomalyDetection) {
        const isAnomaly = await this.detectAnomaly(features);
        if (isAnomaly) {
          this.handleAnomaly(currentMetrics);
        }
      }
      
      // Make predictions
      if (this.options.enablePrediction) {
        const predictions = await this.predictFuture(features);
        this.emit('predictions', predictions);
      }
      
      this.stats.optimizationCount++;
      this.state.lastOptimization = Date.now();
      
      const duration = Date.now() - startTime;
      
      logger.info('Optimization completed', {
        duration,
        adjustments: safeAdjustments,
        metrics: currentMetrics
      });
      
      this.emit('optimized', {
        adjustments: safeAdjustments,
        metrics: currentMetrics,
        duration
      });
      
      return safeAdjustments;
      
    } catch (error) {
      logger.error('Optimization failed', { error: error.message });
      return this.getDefaultAdjustments();
    }
  }
  
  /**
   * Prepare input features for models
   */
  prepareFeatures(metrics) {
    const features = [
      // Performance metrics
      metrics.hashrate / 1e12, // TH/s normalized
      metrics.power / 1000, // kW normalized
      metrics.temperature / 100, // Normalized temperature
      metrics.efficiency || (metrics.hashrate / metrics.power),
      metrics.rejectRate || 0,
      
      // Hardware metrics
      metrics.gpuUsage / 100 || 0,
      metrics.memoryUsage / 100 || 0,
      metrics.fanSpeed / 100 || 0,
      metrics.coreFreq / 2000 || 0,
      metrics.memFreq / 2000 || 0,
      
      // Environmental metrics
      metrics.ambientTemp / 50 || 0,
      metrics.powerCost || 0.1,
      metrics.difficulty / 1e15 || 0,
      
      // Time-based features
      new Date().getHours() / 24,
      new Date().getDay() / 7,
      Math.sin(Date.now() / 86400000 * 2 * Math.PI), // Daily cycle
      Math.cos(Date.now() / 86400000 * 2 * Math.PI),
      
      // Current settings
      this.optimizations.frequency.current / 2000,
      this.optimizations.voltage.current / 1000,
      this.optimizations.powerLimit.current / 500
    ];
    
    // Ensure we have exactly the expected number of features
    return features.slice(0, this.options.inputFeatures);
  }
  
  /**
   * Get optimal actions from model
   */
  async getOptimalActions(features) {
    const input = tf.tensor2d([features]);
    
    try {
      const predictions = await this.models.optimizer.predict(input);
      const actions = await predictions.data();
      
      input.dispose();
      predictions.dispose();
      
      return Array.from(actions);
      
    } catch (error) {
      logger.error('Model prediction failed', { error: error.message });
      input.dispose();
      return new Array(this.options.outputActions).fill(0);
    }
  }
  
  /**
   * Convert model actions to parameter adjustments
   */
  actionsToAdjustments(actions) {
    // Map neural network outputs to actual adjustments
    return {
      frequency: {
        adjust: actions[0] * 100, // -100 to +100 MHz
        confidence: Math.abs(actions[0])
      },
      voltage: {
        adjust: actions[1] * 50, // -50 to +50 mV
        confidence: Math.abs(actions[1])
      },
      fanSpeed: {
        adjust: actions[2] * 20, // -20 to +20 %
        confidence: Math.abs(actions[2])
      },
      memoryFreq: {
        adjust: actions[3] * 100, // -100 to +100 MHz
        confidence: Math.abs(actions[3])
      },
      powerLimit: {
        adjust: actions[4] * 50, // -50 to +50 W
        confidence: Math.abs(actions[4])
      },
      intensity: {
        adjust: Math.round(actions[5] * 2), // -2 to +2
        confidence: Math.abs(actions[5])
      },
      threads: {
        adjust: Math.round(actions[6] * 2), // -2 to +2
        confidence: Math.abs(actions[6])
      },
      workSize: {
        adjust: Math.round(actions[7] * 64), // -64 to +64
        confidence: Math.abs(actions[7])
      }
    };
  }
  
  /**
   * Apply safety constraints to adjustments
   */
  applySafetyConstraints(adjustments, metrics) {
    const safe = {};
    
    // Frequency constraints
    const maxFreq = 1500;
    const minFreq = 800;
    safe.frequency = Math.max(minFreq, Math.min(maxFreq, 
      this.optimizations.frequency.current + adjustments.frequency.adjust
    ));
    
    // Voltage constraints (prevent damage)
    const maxVoltage = 850;
    const minVoltage = 650;
    safe.voltage = Math.max(minVoltage, Math.min(maxVoltage,
      this.optimizations.voltage.current + adjustments.voltage.adjust
    ));
    
    // Temperature-based constraints
    if (metrics.temperature > 80) {
      safe.fanSpeed = Math.min(100, this.optimizations.fanSpeed.current + 10);
      safe.powerLimit = Math.max(150, this.optimizations.powerLimit.current - 20);
    } else {
      safe.fanSpeed = Math.max(40, Math.min(100,
        this.optimizations.fanSpeed.current + adjustments.fanSpeed.adjust
      ));
      safe.powerLimit = Math.max(100, Math.min(300,
        this.optimizations.powerLimit.current + adjustments.powerLimit.adjust
      ));
    }
    
    // Memory frequency constraints
    safe.memoryFreq = Math.max(1500, Math.min(2000,
      this.optimizations.memoryFreq.current + adjustments.memoryFreq.adjust
    ));
    
    // Mining parameter constraints
    safe.intensity = Math.max(8, Math.min(25,
      this.optimizations.intensity.current + adjustments.intensity.adjust
    ));
    
    safe.threads = Math.max(1, Math.min(16,
      this.optimizations.threads.current + adjustments.threads.adjust
    ));
    
    safe.workSize = Math.max(64, Math.min(512,
      this.optimizations.workSize.current + adjustments.workSize.adjust
    ));
    
    return safe;
  }
  
  /**
   * Update current optimizations
   */
  updateOptimizations(adjustments) {
    Object.keys(adjustments).forEach(key => {
      if (this.optimizations[key]) {
        this.optimizations[key].current = adjustments[key];
        this.optimizations[key].optimal = adjustments[key];
      }
    });
  }
  
  /**
   * Record experience for reinforcement learning
   */
  recordExperience(state, action, metrics) {
    // Calculate reward based on multiple objectives
    const reward = this.calculateReward(metrics);
    
    // Add to replay buffer
    this.state.replayBuffer.push({
      state,
      action,
      reward,
      nextState: null, // Will be filled on next step
      timestamp: Date.now()
    });
    
    // Update previous experience with next state
    if (this.state.replayBuffer.length > 1) {
      const prevExp = this.state.replayBuffer[this.state.replayBuffer.length - 2];
      prevExp.nextState = state;
    }
    
    // Limit buffer size
    if (this.state.replayBuffer.length > 10000) {
      this.state.replayBuffer.shift();
    }
    
    this.stats.totalReward += reward;
  }
  
  /**
   * Calculate reward for reinforcement learning
   */
  calculateReward(metrics) {
    let reward = 0;
    
    // Hashrate reward (maximize)
    const hashrateNorm = metrics.hashrate / 1e12; // TH/s
    reward += hashrateNorm * 10;
    
    // Efficiency reward (maximize)
    const efficiency = metrics.hashrate / metrics.power;
    reward += efficiency / 1e9 * 5;
    
    // Temperature penalty (minimize)
    if (metrics.temperature > 75) {
      reward -= (metrics.temperature - 75) * 2;
    }
    
    // Power penalty (minimize if above target)
    const targetPower = 250;
    if (metrics.power > targetPower) {
      reward -= (metrics.power - targetPower) / 10;
    }
    
    // Reject rate penalty
    reward -= metrics.rejectRate * 100;
    
    // Profitability bonus
    if (metrics.profitability) {
      reward += metrics.profitability * 20;
    }
    
    return reward;
  }
  
  /**
   * Detect anomalies in metrics
   */
  async detectAnomaly(features) {
    if (!this.models.anomalyDetector) return false;
    
    try {
      const input = tf.tensor2d([features]);
      const reconstruction = await this.models.anomalyDetector.predict(input);
      const reconstructionData = await reconstruction.data();
      
      // Calculate reconstruction error
      const error = features.reduce((sum, val, idx) => {
        return sum + Math.pow(val - reconstructionData[idx], 2);
      }, 0) / features.length;
      
      input.dispose();
      reconstruction.dispose();
      
      // Threshold for anomaly detection
      const threshold = 0.1;
      const isAnomaly = error > threshold;
      
      if (isAnomaly) {
        this.stats.anomaliesDetected++;
        logger.warn('Anomaly detected', { error, features });
      }
      
      return isAnomaly;
      
    } catch (error) {
      logger.error('Anomaly detection failed', { error: error.message });
      return false;
    }
  }
  
  /**
   * Handle detected anomaly
   */
  handleAnomaly(metrics) {
    // Revert to safe settings
    const safeSettings = {
      frequency: 1200,
      voltage: 750,
      fanSpeed: 80,
      powerLimit: 200,
      intensity: 18
    };
    
    this.updateOptimizations(safeSettings);
    
    this.emit('anomaly', {
      metrics,
      action: 'reverted_to_safe',
      settings: safeSettings
    });
  }
  
  /**
   * Predict future metrics
   */
  async predictFuture(currentFeatures) {
    if (!this.models.predictor) return null;
    
    try {
      // Get last 10 time steps
      const sequence = this.getFeatureSequence(10);
      const input = tf.tensor3d([sequence]);
      
      const predictions = await this.models.predictor.predict(input);
      const predictionData = await predictions.data();
      
      input.dispose();
      predictions.dispose();
      
      return {
        hashrate: predictionData[0] * 1e12,
        power: predictionData[1] * 1000,
        temperature: predictionData[2] * 100,
        efficiency: predictionData[3],
        profitability: predictionData[4],
        timestamp: Date.now() + 3600000 // 1 hour ahead
      };
      
    } catch (error) {
      logger.error('Prediction failed', { error: error.message });
      return null;
    }
  }
  
  /**
   * Get feature sequence for LSTM
   */
  getFeatureSequence(length) {
    const sequence = [];
    const historyLength = this.state.trainingData.length;
    
    for (let i = 0; i < length; i++) {
      if (i < historyLength) {
        sequence.push(this.state.trainingData[historyLength - length + i]);
      } else {
        // Pad with zeros if not enough history
        sequence.push(new Array(this.options.inputFeatures).fill(0));
      }
    }
    
    return sequence;
  }
  
  /**
   * Train models with collected data
   */
  async train() {
    if (this.state.isTraining || this.state.replayBuffer.length < this.options.batchSize) {
      return;
    }
    
    this.state.isTraining = true;
    
    try {
      // Sample batch from replay buffer
      const batch = this.sampleBatch(this.options.batchSize);
      
      // Prepare training data
      const states = batch.map(exp => exp.state);
      const targets = [];
      
      for (const exp of batch) {
        const targetValues = await this.calculateTargets(exp);
        targets.push(targetValues);
      }
      
      // Train the model
      const xs = tf.tensor2d(states);
      const ys = tf.tensor2d(targets);
      
      const history = await this.models.optimizer.fit(xs, ys, {
        epochs: 1,
        batchSize: this.options.batchSize,
        shuffle: true,
        verbose: 0
      });
      
      xs.dispose();
      ys.dispose();
      
      this.state.modelVersion++;
      
      logger.info('Model trained', {
        loss: history.history.loss[0],
        version: this.state.modelVersion,
        bufferSize: this.state.replayBuffer.length
      });
      
    } catch (error) {
      logger.error('Training failed', { error: error.message });
    } finally {
      this.state.isTraining = false;
    }
  }
  
  /**
   * Calculate Q-learning targets
   */
  async calculateTargets(experience) {
    const currentQ = await this.getOptimalActions(experience.state);
    const targets = [...currentQ];
    
    if (experience.nextState) {
      const nextQ = await this.getOptimalActions(experience.nextState);
      const maxNextQ = Math.max(...nextQ);
      
      // Q-learning update rule
      const gamma = 0.95; // Discount factor
      const alpha = 0.1; // Learning rate
      
      for (let i = 0; i < targets.length; i++) {
        targets[i] = currentQ[i] + alpha * (experience.reward + gamma * maxNextQ - currentQ[i]);
      }
    }
    
    return targets;
  }
  
  /**
   * Sample batch from replay buffer
   */
  sampleBatch(size) {
    const batch = [];
    const indices = new Set();
    
    while (batch.length < size && batch.length < this.state.replayBuffer.length) {
      const idx = Math.floor(Math.random() * this.state.replayBuffer.length);
      if (!indices.has(idx)) {
        indices.add(idx);
        batch.push(this.state.replayBuffer[idx]);
      }
    }
    
    return batch;
  }
  
  /**
   * Start training loop
   */
  startTrainingLoop() {
    this.trainingInterval = setInterval(() => {
      this.train();
    }, this.options.trainInterval);
  }
  
  /**
   * Get optimization recommendations
   */
  getRecommendations(metrics) {
    const recommendations = [];
    
    // Temperature-based recommendations
    if (metrics.temperature > 85) {
      recommendations.push({
        type: 'critical',
        metric: 'temperature',
        message: 'Temperature too high, reduce power or increase cooling',
        action: { powerLimit: -50, fanSpeed: 100 }
      });
    }
    
    // Efficiency recommendations
    const efficiency = metrics.hashrate / metrics.power;
    const targetEfficiency = 50e9; // 50 GH/W
    
    if (efficiency < targetEfficiency) {
      recommendations.push({
        type: 'optimization',
        metric: 'efficiency',
        message: 'Low efficiency detected, consider undervolting',
        action: { voltage: -25, frequency: -50 }
      });
    }
    
    // Profitability recommendations
    if (metrics.profitability < 0) {
      recommendations.push({
        type: 'warning',
        metric: 'profitability',
        message: 'Mining at a loss, consider switching algorithm or reducing power',
        action: { switchAlgorithm: true }
      });
    }
    
    return recommendations;
  }
  
  /**
   * Get default adjustments
   */
  getDefaultAdjustments() {
    return {
      frequency: 1200,
      voltage: 750,
      fanSpeed: 70,
      memoryFreq: 1750,
      powerLimit: 250,
      intensity: 20,
      threads: 4,
      workSize: 256
    };
  }
  
  /**
   * Save models to disk
   */
  async saveModels() {
    try {
      for (const [name, model] of Object.entries(this.models)) {
        if (model) {
          await model.save(`file://${this.options.modelPath}/${name}`);
        }
      }
      
      logger.info('Models saved', {
        path: this.options.modelPath,
        version: this.state.modelVersion
      });
      
    } catch (error) {
      logger.error('Failed to save models', { error: error.message });
    }
  }
  
  /**
   * Load models from disk
   */
  async loadModels() {
    try {
      this.models.optimizer = await tf.loadLayersModel(
        `file://${this.options.modelPath}/optimizer/model.json`
      );
      
      if (this.options.enableAnomalyDetection) {
        this.models.anomalyDetector = await tf.loadLayersModel(
          `file://${this.options.modelPath}/anomalyDetector/model.json`
        );
      }
      
      if (this.options.enablePrediction) {
        this.models.predictor = await tf.loadLayersModel(
          `file://${this.options.modelPath}/predictor/model.json`
        );
      }
      
      logger.info('Models loaded', {
        path: this.options.modelPath,
        models: Object.keys(this.models).filter(k => this.models[k] !== null)
      });
      
    } catch (error) {
      logger.warn('Failed to load models, creating new ones', { error: error.message });
      await this.createModels();
    }
  }
  
  /**
   * Check if model exists
   */
  async modelExists() {
    // Simple check - in production use proper file system checks
    return false;
  }
  
  /**
   * Get status
   */
  getStatus() {
    return {
      models: {
        optimizer: this.models.optimizer !== null,
        anomalyDetector: this.models.anomalyDetector !== null,
        predictor: this.models.predictor !== null
      },
      state: this.state,
      optimizations: this.optimizations,
      stats: this.stats,
      recommendations: this.getRecommendations(this.optimizations)
    };
  }
  
  /**
   * Shutdown AI optimizer
   */
  async shutdown() {
    if (this.trainingInterval) {
      clearInterval(this.trainingInterval);
    }
    
    // Save models before shutdown
    await this.saveModels();
    
    // Dispose TensorFlow resources
    for (const model of Object.values(this.models)) {
      if (model) {
        model.dispose();
      }
    }
    
    logger.info('AI optimizer shutdown', this.stats);
  }
}

export default AIOptimizer;