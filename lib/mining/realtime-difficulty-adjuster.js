/**
 * Real-time Difficulty Adjuster - Otedama
 * Dynamic difficulty adjustment for optimal mining experience
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import * as tf from '@tensorflow/tfjs-node';

const logger = createStructuredLogger('DifficultyAdjuster');

// Adjustment strategies
export const AdjustmentStrategy = {
  VARDIFF: 'vardiff', // Variable difficulty per worker
  GLOBAL: 'global', // Global pool difficulty
  HYBRID: 'hybrid', // Combination of both
  ML_PREDICTIVE: 'ml_predictive', // ML-based prediction
  ADAPTIVE: 'adaptive' // Fully adaptive system
};

// Difficulty targets
export const DifficultyTarget = {
  SHARES_PER_MINUTE: 'shares_per_minute',
  BLOCK_TIME: 'block_time',
  NETWORK_HASHRATE: 'network_hashrate',
  WORKER_COMFORT: 'worker_comfort'
};

export class RealtimeDifficultyAdjuster extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Strategy configuration
      strategy: options.strategy || AdjustmentStrategy.ADAPTIVE,
      target: options.target || DifficultyTarget.SHARES_PER_MINUTE,
      
      // Target parameters
      targetSharesPerMinute: options.targetSharesPerMinute || 10,
      targetBlockTime: options.targetBlockTime || 600, // 10 minutes
      minShares: options.minShares || 5,
      maxShares: options.maxShares || 20,
      
      // Difficulty bounds
      minDifficulty: options.minDifficulty || 1,
      maxDifficulty: options.maxDifficulty || 1e12,
      startDifficulty: options.startDifficulty || 1000,
      
      // Adjustment parameters
      adjustmentInterval: options.adjustmentInterval || 30000, // 30 seconds
      adjustmentFactor: options.adjustmentFactor || 0.2, // 20% max change
      smoothingFactor: options.smoothingFactor || 0.1, // EMA smoothing
      
      // Vardiff settings
      vardiffRetargetTime: options.vardiffRetargetTime || 60000, // 1 minute
      vardiffVariance: options.vardiffVariance || 0.3, // 30% variance allowed
      vardiffMinSamples: options.vardiffMinSamples || 10,
      
      // ML settings
      enableML: options.enableML !== false,
      predictionHorizon: options.predictionHorizon || 300000, // 5 minutes
      mlUpdateInterval: options.mlUpdateInterval || 3600000, // 1 hour
      
      // Performance settings
      enableCaching: options.enableCaching !== false,
      cacheSize: options.cacheSize || 10000,
      
      ...options
    };
    
    // Difficulty state
    this.currentDifficulty = this.options.startDifficulty;
    this.globalDifficulty = this.options.startDifficulty;
    this.networkDifficulty = 1;
    
    // Worker difficulties (vardiff)
    this.workerDifficulties = new Map();
    this.workerStats = new Map();
    this.difficultyHistory = new Map();
    
    // Network stats
    this.networkStats = {
      hashrate: 0,
      blockTime: this.options.targetBlockTime,
      difficulty: 1,
      height: 0
    };
    
    // Pool stats
    this.poolStats = {
      hashrate: 0,
      workers: 0,
      sharesPerMinute: 0,
      avgShareTime: 0
    };
    
    // ML models
    this.models = {
      difficultyPredictor: null,
      hashratePredictor: null,
      shareTimePredictor: null
    };
    
    // Adjustment history
    this.adjustmentHistory = [];
    
    // Statistics
    this.stats = {
      adjustmentCount: 0,
      avgDifficulty: this.options.startDifficulty,
      difficultyChanges: 0,
      targetHitRate: 0,
      predictionAccuracy: 0
    };
    
    // Timers
    this.adjustmentTimer = null;
    this.mlUpdateTimer = null;
  }
  
  /**
   * Initialize difficulty adjuster
   */
  async initialize() {
    logger.info('Initializing difficulty adjuster', {
      strategy: this.options.strategy,
      target: this.options.target
    });
    
    try {
      // Initialize ML models if enabled
      if (this.options.enableML) {
        await this.initializeMLModels();
      }
      
      // Load historical data
      await this.loadHistoricalData();
      
      // Start adjustment cycle
      this.startAdjustmentCycle();
      
      // Start ML updates if enabled
      if (this.options.enableML) {
        this.startMLUpdates();
      }
      
      logger.info('Difficulty adjuster initialized', {
        currentDifficulty: this.currentDifficulty,
        strategy: this.options.strategy
      });
      
      this.emit('initialized', {
        difficulty: this.currentDifficulty
      });
      
    } catch (error) {
      logger.error('Failed to initialize difficulty adjuster', { error: error.message });
      throw error;
    }
  }
  
  /**
   * Update worker share submission
   */
  updateWorkerShare(workerId, share) {
    const now = Date.now();
    
    // Initialize worker stats if needed
    if (!this.workerStats.has(workerId)) {
      this.workerStats.set(workerId, {
        shares: [],
        lastShare: now,
        lastAdjustment: now,
        currentDifficulty: this.options.startDifficulty,
        targetDifficulty: this.options.startDifficulty,
        hashrate: 0,
        variance: 0
      });
      
      this.workerDifficulties.set(workerId, this.options.startDifficulty);
    }
    
    const stats = this.workerStats.get(workerId);
    
    // Record share
    stats.shares.push({
      timestamp: now,
      difficulty: share.difficulty || stats.currentDifficulty,
      valid: share.valid !== false
    });
    
    // Update last share time
    if (stats.lastShare) {
      const timeSinceLastShare = now - stats.lastShare;
      stats.avgShareTime = stats.avgShareTime 
        ? stats.avgShareTime * 0.8 + timeSinceLastShare * 0.2
        : timeSinceLastShare;
    }
    stats.lastShare = now;
    
    // Clean old shares
    const cutoff = now - this.options.vardiffRetargetTime * 2;
    stats.shares = stats.shares.filter(s => s.timestamp > cutoff);
    
    // Update hashrate estimate
    this.updateWorkerHashrate(workerId, stats);
    
    // Check if vardiff adjustment needed
    if (this.shouldAdjustVardiff(workerId, stats)) {
      this.adjustWorkerDifficulty(workerId, stats);
    }
  }
  
  /**
   * Should adjust vardiff
   */
  shouldAdjustVardiff(workerId, stats) {
    const now = Date.now();
    
    // Check time since last adjustment
    if (now - stats.lastAdjustment < this.options.vardiffRetargetTime) {
      return false;
    }
    
    // Need minimum samples
    if (stats.shares.length < this.options.vardiffMinSamples) {
      return false;
    }
    
    // Check if share rate is outside target range
    const recentShares = stats.shares.filter(
      s => s.timestamp > now - 60000
    ).length;
    
    const targetShares = this.options.targetSharesPerMinute;
    const minShares = targetShares * (1 - this.options.vardiffVariance);
    const maxShares = targetShares * (1 + this.options.vardiffVariance);
    
    return recentShares < minShares || recentShares > maxShares;
  }
  
  /**
   * Adjust worker difficulty
   */
  async adjustWorkerDifficulty(workerId, stats) {
    const now = Date.now();
    const recentShares = stats.shares.filter(s => s.timestamp > now - 60000);
    const sharesPerMinute = recentShares.length;
    
    // Calculate adjustment ratio
    const targetShares = this.options.targetSharesPerMinute;
    const ratio = sharesPerMinute / targetShares;
    
    // Calculate new difficulty
    let newDifficulty = stats.currentDifficulty;
    
    if (ratio > 1 + this.options.vardiffVariance) {
      // Too many shares, increase difficulty
      newDifficulty *= Math.min(2, 1 + (ratio - 1) * this.options.adjustmentFactor);
    } else if (ratio < 1 - this.options.vardiffVariance) {
      // Too few shares, decrease difficulty
      newDifficulty *= Math.max(0.5, 1 - (1 - ratio) * this.options.adjustmentFactor);
    }
    
    // Apply ML prediction if enabled
    if (this.options.enableML && this.models.difficultyPredictor) {
      const prediction = await this.predictOptimalDifficulty(workerId, stats);
      // Weight prediction with calculated value
      newDifficulty = newDifficulty * 0.7 + prediction * 0.3;
    }
    
    // Apply bounds
    newDifficulty = Math.max(this.options.minDifficulty, 
                    Math.min(this.options.maxDifficulty, newDifficulty));
    
    // Smooth adjustment
    const smoothedDifficulty = stats.currentDifficulty * (1 - this.options.smoothingFactor) +
                              newDifficulty * this.options.smoothingFactor;
    
    // Update difficulty
    stats.currentDifficulty = smoothedDifficulty;
    stats.targetDifficulty = newDifficulty;
    stats.lastAdjustment = now;
    
    this.workerDifficulties.set(workerId, smoothedDifficulty);
    
    // Record adjustment
    this.recordAdjustment({
      type: 'vardiff',
      workerId,
      oldDifficulty: stats.currentDifficulty,
      newDifficulty: smoothedDifficulty,
      sharesPerMinute,
      targetShares,
      ratio
    });
    
    logger.debug('Adjusted worker difficulty', {
      workerId,
      oldDifficulty: stats.currentDifficulty,
      newDifficulty: smoothedDifficulty,
      sharesPerMinute
    });
    
    this.emit('vardiff:adjusted', {
      workerId,
      difficulty: smoothedDifficulty,
      stats: {
        sharesPerMinute,
        hashrate: stats.hashrate
      }
    });
  }
  
  /**
   * Adjust global difficulty
   */
  async adjustGlobalDifficulty() {
    const strategy = this.options.strategy;
    
    switch (strategy) {
      case AdjustmentStrategy.GLOBAL:
        await this.adjustGlobalBasedOnTarget();
        break;
        
      case AdjustmentStrategy.VARDIFF:
        // Vardiff only, no global adjustment
        break;
        
      case AdjustmentStrategy.HYBRID:
        await this.adjustHybridDifficulty();
        break;
        
      case AdjustmentStrategy.ML_PREDICTIVE:
        await this.adjustMLPredictiveDifficulty();
        break;
        
      case AdjustmentStrategy.ADAPTIVE:
      default:
        await this.adjustAdaptiveDifficulty();
        break;
    }
    
    this.stats.adjustmentCount++;
  }
  
  /**
   * Adjust based on target
   */
  async adjustGlobalBasedOnTarget() {
    let adjustment = 1.0;
    
    switch (this.options.target) {
      case DifficultyTarget.SHARES_PER_MINUTE:
        adjustment = this.calculateShareRateAdjustment();
        break;
        
      case DifficultyTarget.BLOCK_TIME:
        adjustment = this.calculateBlockTimeAdjustment();
        break;
        
      case DifficultyTarget.NETWORK_HASHRATE:
        adjustment = this.calculateNetworkHashrateAdjustment();
        break;
        
      case DifficultyTarget.WORKER_COMFORT:
        adjustment = this.calculateWorkerComfortAdjustment();
        break;
    }
    
    // Apply adjustment
    const oldDifficulty = this.globalDifficulty;
    const newDifficulty = oldDifficulty * adjustment;
    
    // Apply bounds and smoothing
    this.globalDifficulty = Math.max(
      this.options.minDifficulty,
      Math.min(this.options.maxDifficulty,
        oldDifficulty * (1 - this.options.smoothingFactor) +
        newDifficulty * this.options.smoothingFactor
      )
    );
    
    if (Math.abs(adjustment - 1.0) > 0.01) {
      this.recordAdjustment({
        type: 'global',
        oldDifficulty,
        newDifficulty: this.globalDifficulty,
        adjustment,
        target: this.options.target
      });
      
      this.emit('global:adjusted', {
        difficulty: this.globalDifficulty,
        adjustment
      });
    }
  }
  
  /**
   * Adaptive difficulty adjustment
   */
  async adjustAdaptiveDifficulty() {
    // Collect multiple signals
    const signals = {
      shareRate: this.calculateShareRateSignal(),
      blockTime: this.calculateBlockTimeSignal(),
      workerComfort: this.calculateWorkerComfortSignal(),
      networkAlignment: this.calculateNetworkAlignmentSignal(),
      poolPerformance: this.calculatePoolPerformanceSignal()
    };
    
    // Weight signals based on importance
    const weights = {
      shareRate: 0.3,
      blockTime: 0.2,
      workerComfort: 0.2,
      networkAlignment: 0.2,
      poolPerformance: 0.1
    };
    
    // Calculate weighted adjustment
    let weightedAdjustment = 0;
    let totalWeight = 0;
    
    for (const [signal, value] of Object.entries(signals)) {
      if (!isNaN(value)) {
        weightedAdjustment += value * weights[signal];
        totalWeight += weights[signal];
      }
    }
    
    const adjustment = totalWeight > 0 ? 1 + (weightedAdjustment / totalWeight) : 1;
    
    // Apply ML enhancement if available
    let finalAdjustment = adjustment;
    if (this.options.enableML && this.models.difficultyPredictor) {
      const mlAdjustment = await this.predictGlobalAdjustment();
      // Blend ML with calculated adjustment
      finalAdjustment = adjustment * 0.6 + mlAdjustment * 0.4;
    }
    
    // Apply adjustment
    const oldDifficulty = this.globalDifficulty;
    const targetDifficulty = oldDifficulty * finalAdjustment;
    
    // Smooth and bound
    this.globalDifficulty = Math.max(
      this.options.minDifficulty,
      Math.min(this.options.maxDifficulty,
        oldDifficulty * (1 - this.options.smoothingFactor) +
        targetDifficulty * this.options.smoothingFactor
      )
    );
    
    // Update current difficulty
    this.currentDifficulty = this.globalDifficulty;
    
    if (Math.abs(finalAdjustment - 1.0) > 0.01) {
      this.recordAdjustment({
        type: 'adaptive',
        oldDifficulty,
        newDifficulty: this.globalDifficulty,
        adjustment: finalAdjustment,
        signals
      });
      
      logger.info('Adaptive difficulty adjusted', {
        oldDifficulty,
        newDifficulty: this.globalDifficulty,
        adjustment: finalAdjustment,
        signals
      });
      
      this.emit('difficulty:adjusted', {
        difficulty: this.globalDifficulty,
        adjustment: finalAdjustment,
        strategy: 'adaptive'
      });
    }
  }
  
  /**
   * Calculate adjustment signals
   */
  
  calculateShareRateSignal() {
    const currentRate = this.poolStats.sharesPerMinute;
    const targetRate = this.options.targetSharesPerMinute * this.poolStats.workers;
    
    if (currentRate === 0) return 0;
    
    const ratio = targetRate / currentRate;
    // Convert to adjustment factor (-1 to 1)
    return Math.max(-1, Math.min(1, (ratio - 1) * this.options.adjustmentFactor));
  }
  
  calculateBlockTimeSignal() {
    const currentBlockTime = this.networkStats.blockTime;
    const targetBlockTime = this.options.targetBlockTime;
    
    const ratio = targetBlockTime / currentBlockTime;
    return Math.max(-1, Math.min(1, (ratio - 1) * this.options.adjustmentFactor));
  }
  
  calculateWorkerComfortSignal() {
    // Analyze worker difficulty distribution
    const difficulties = Array.from(this.workerDifficulties.values());
    if (difficulties.length === 0) return 0;
    
    const avgDifficulty = difficulties.reduce((a, b) => a + b, 0) / difficulties.length;
    const variance = difficulties.reduce((sum, d) => sum + Math.pow(d - avgDifficulty, 2), 0) / difficulties.length;
    const stdDev = Math.sqrt(variance);
    
    // High variance indicates workers struggling with difficulty
    const comfortScore = 1 - (stdDev / avgDifficulty);
    
    // Convert to adjustment signal
    if (comfortScore < 0.7) {
      return -0.1; // Reduce difficulty
    } else if (comfortScore > 0.9) {
      return 0.1; // Can increase difficulty
    }
    
    return 0;
  }
  
  calculateNetworkAlignmentSignal() {
    // Align with network difficulty changes
    const poolDiffRatio = this.globalDifficulty / this.networkDifficulty;
    const idealRatio = 0.001; // Pool should be 0.1% of network
    
    const deviation = (poolDiffRatio - idealRatio) / idealRatio;
    return Math.max(-0.2, Math.min(0.2, -deviation * 0.1));
  }
  
  calculatePoolPerformanceSignal() {
    // Check if pool is finding blocks at expected rate
    const expectedBlocksPerHour = (this.poolStats.hashrate / this.networkStats.hashrate) * 
                                  (3600 / this.networkStats.blockTime);
    
    // This would need actual block finding history
    const actualBlocksPerHour = 0.8; // Placeholder
    
    const performance = actualBlocksPerHour / Math.max(0.1, expectedBlocksPerHour);
    
    if (performance < 0.8) {
      return -0.05; // Slightly reduce difficulty
    } else if (performance > 1.2) {
      return 0.05; // Slightly increase difficulty
    }
    
    return 0;
  }
  
  /**
   * Initialize ML models
   */
  async initializeMLModels() {
    // Difficulty predictor
    this.models.difficultyPredictor = tf.sequential({
      layers: [
        tf.layers.lstm({
          inputShape: [10, 8], // 10 time steps, 8 features
          units: 32,
          returnSequences: true
        }),
        tf.layers.lstm({
          units: 16,
          returnSequences: false
        }),
        tf.layers.dense({
          units: 8,
          activation: 'relu'
        }),
        tf.layers.dense({
          units: 1,
          activation: 'linear'
        })
      ]
    });
    
    this.models.difficultyPredictor.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'meanSquaredError',
      metrics: ['mae']
    });
    
    // Share time predictor
    this.models.shareTimePredictor = tf.sequential({
      layers: [
        tf.layers.dense({
          inputShape: [12],
          units: 24,
          activation: 'relu'
        }),
        tf.layers.dropout({ rate: 0.2 }),
        tf.layers.dense({
          units: 12,
          activation: 'relu'
        }),
        tf.layers.dense({
          units: 1,
          activation: 'exponential' // Share times are positive
        })
      ]
    });
    
    this.models.shareTimePredictor.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'meanAbsoluteError'
    });
    
    // Load pre-trained weights if available
    await this.loadModelWeights();
  }
  
  /**
   * Predict optimal difficulty for worker
   */
  async predictOptimalDifficulty(workerId, stats) {
    if (!this.models.difficultyPredictor) {
      return stats.currentDifficulty;
    }
    
    try {
      // Prepare time series features
      const features = this.prepareWorkerFeatures(workerId, stats);
      const input = tf.tensor3d([features]);
      
      const prediction = await this.models.difficultyPredictor.predict(input).data();
      input.dispose();
      
      // Scale prediction to difficulty range
      const scaledPrediction = prediction[0] * (this.options.maxDifficulty - this.options.minDifficulty) + 
                              this.options.minDifficulty;
      
      return scaledPrediction;
      
    } catch (error) {
      logger.error('Difficulty prediction failed', { error: error.message });
      return stats.currentDifficulty;
    }
  }
  
  /**
   * Predict global adjustment
   */
  async predictGlobalAdjustment() {
    try {
      const features = this.prepareGlobalFeatures();
      const input = tf.tensor2d([features]);
      
      const prediction = await this.models.difficultyPredictor.predict(input).data();
      input.dispose();
      
      // Convert to adjustment factor (0.5 to 1.5)
      return 0.5 + prediction[0];
      
    } catch (error) {
      logger.error('Global adjustment prediction failed', { error: error.message });
      return 1.0;
    }
  }
  
  /**
   * Prepare features for ML
   */
  prepareWorkerFeatures(workerId, stats) {
    const history = stats.shares.slice(-10);
    const features = [];
    
    for (let i = 0; i < 10; i++) {
      if (i < history.length) {
        const share = history[i];
        const prevShare = i > 0 ? history[i-1] : share;
        
        features.push([
          share.difficulty / this.options.maxDifficulty,
          (share.timestamp - prevShare.timestamp) / 60000, // Minutes between shares
          stats.hashrate / 1e12, // TH/s
          stats.variance,
          stats.shares.length / 100,
          this.poolStats.workers / 1000,
          this.poolStats.hashrate / 1e15, // PH/s
          new Date(share.timestamp).getHours() / 24 // Time of day
        ]);
      } else {
        features.push(new Array(8).fill(0));
      }
    }
    
    return features;
  }
  
  prepareGlobalFeatures() {
    const history = this.adjustmentHistory.slice(-20);
    
    return [
      this.globalDifficulty / this.options.maxDifficulty,
      this.poolStats.sharesPerMinute / 1000,
      this.poolStats.workers / 1000,
      this.poolStats.hashrate / 1e15,
      this.networkStats.hashrate / 1e18,
      this.networkStats.difficulty / 1e12,
      this.networkStats.blockTime / 600,
      this.calculateShareRateSignal(),
      this.calculateWorkerComfortSignal(),
      this.calculateNetworkAlignmentSignal(),
      new Date().getHours() / 24,
      new Date().getDay() / 7
    ];
  }
  
  /**
   * Update worker hashrate
   */
  updateWorkerHashrate(workerId, stats) {
    const recentShares = stats.shares.filter(
      s => s.timestamp > Date.now() - 300000 // Last 5 minutes
    );
    
    if (recentShares.length < 2) return;
    
    const totalDifficulty = recentShares.reduce((sum, s) => sum + s.difficulty, 0);
    const timeSpan = (recentShares[recentShares.length - 1].timestamp - recentShares[0].timestamp) / 1000;
    
    if (timeSpan > 0) {
      // Hashrate = (total difficulty * 2^32) / time
      stats.hashrate = (totalDifficulty * Math.pow(2, 32)) / timeSpan;
    }
  }
  
  /**
   * Record adjustment
   */
  recordAdjustment(adjustment) {
    adjustment.timestamp = Date.now();
    
    this.adjustmentHistory.push(adjustment);
    
    // Limit history size
    if (this.adjustmentHistory.length > 1000) {
      this.adjustmentHistory.shift();
    }
    
    // Update statistics
    this.stats.difficultyChanges++;
    this.updateAverageD}
  
  /**
   * Update pool statistics
   */
  updatePoolStats(stats) {
    Object.assign(this.poolStats, stats);
    
    // Trigger adjustment if needed
    if (this.shouldTriggerAdjustment()) {
      this.adjustGlobalDifficulty();
    }
  }
  
  /**
   * Update network statistics
   */
  updateNetworkStats(stats) {
    Object.assign(this.networkStats, stats);
    
    // Update network difficulty if changed significantly
    if (Math.abs(stats.difficulty - this.networkDifficulty) / this.networkDifficulty > 0.05) {
      this.networkDifficulty = stats.difficulty;
      this.emit('network:updated', stats);
    }
  }
  
  /**
   * Should trigger adjustment
   */
  shouldTriggerAdjustment() {
    // Check various conditions
    const timeSinceLastAdjustment = Date.now() - 
      (this.adjustmentHistory[this.adjustmentHistory.length - 1]?.timestamp || 0);
    
    // Regular interval
    if (timeSinceLastAdjustment > this.options.adjustmentInterval) {
      return true;
    }
    
    // Significant change in conditions
    const shareRateChange = Math.abs(this.calculateShareRateSignal());
    if (shareRateChange > 0.5) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Get difficulty for worker
   */
  getWorkerDifficulty(workerId) {
    if (this.options.strategy === AdjustmentStrategy.GLOBAL) {
      return this.globalDifficulty;
    }
    
    return this.workerDifficulties.get(workerId) || this.options.startDifficulty;
  }
  
  /**
   * Get current difficulty
   */
  getCurrentDifficulty() {
    return this.currentDifficulty;
  }
  
  /**
   * Start adjustment cycle
   */
  startAdjustmentCycle() {
    this.adjustmentTimer = setInterval(() => {
      this.adjustGlobalDifficulty();
    }, this.options.adjustmentInterval);
  }
  
  /**
   * Start ML updates
   */
  startMLUpdates() {
    this.mlUpdateTimer = setInterval(() => {
      this.updateMLModels();
    }, this.options.mlUpdateInterval);
  }
  
  /**
   * Update ML models
   */
  async updateMLModels() {
    // Retrain models with recent data
    // This would be implemented based on collected data
  }
  
  /**
   * Get statistics
   */
  getStatistics() {
    const workerCount = this.workerDifficulties.size;
    const avgWorkerDiff = workerCount > 0 
      ? Array.from(this.workerDifficulties.values()).reduce((a, b) => a + b, 0) / workerCount
      : 0;
    
    return {
      ...this.stats,
      currentDifficulty: this.currentDifficulty,
      globalDifficulty: this.globalDifficulty,
      networkDifficulty: this.networkDifficulty,
      activeWorkers: workerCount,
      avgWorkerDifficulty: avgWorkerDiff,
      adjustmentHistory: this.adjustmentHistory.slice(-10)
    };
  }
  
  /**
   * Shutdown adjuster
   */
  async shutdown() {
    // Stop timers
    if (this.adjustmentTimer) {
      clearInterval(this.adjustmentTimer);
    }
    
    if (this.mlUpdateTimer) {
      clearInterval(this.mlUpdateTimer);
    }
    
    // Save models
    if (this.options.enableML) {
      await this.saveModels();
    }
    
    // Save state
    await this.saveState();
    
    logger.info('Difficulty adjuster shutdown', this.getStatistics());
  }
  
  // Utility methods
  
  async loadHistoricalData() {
    // Load historical difficulty data
  }
  
  async loadModelWeights() {
    // Load pre-trained model weights
  }
  
  async saveModels() {
    // Save ML models
  }
  
  async saveState() {
    // Save current state
  }
  
  calculateShareRateAdjustment() {
    const current = this.poolStats.sharesPerMinute;
    const target = this.options.targetSharesPerMinute * this.poolStats.workers;
    
    if (current === 0) return 1;
    
    const ratio = target / current;
    return Math.max(0.5, Math.min(2, ratio));
  }
  
  calculateBlockTimeAdjustment() {
    const current = this.networkStats.blockTime;
    const target = this.options.targetBlockTime;
    
    const ratio = target / current;
    return Math.max(0.8, Math.min(1.2, ratio));
  }
  
  calculateNetworkHashrateAdjustment() {
    // Adjust based on network hashrate changes
    return 1.0; // Placeholder
  }
  
  calculateWorkerComfortAdjustment() {
    // Analyze worker satisfaction with current difficulty
    const avgShareTime = this.poolStats.avgShareTime || 60;
    const targetShareTime = 60000 / this.options.targetSharesPerMinute;
    
    const ratio = targetShareTime / avgShareTime;
    return Math.max(0.7, Math.min(1.3, ratio));
  }
  
  adjustHybridDifficulty() {
    // Implement hybrid strategy
    this.adjustGlobalBasedOnTarget();
  }
  
  async adjustMLPredictiveDifficulty() {
    if (!this.models.difficultyPredictor) {
      return this.adjustGlobalBasedOnTarget();
    }
    
    const prediction = await this.predictGlobalAdjustment();
    const oldDifficulty = this.globalDifficulty;
    
    this.globalDifficulty = Math.max(
      this.options.minDifficulty,
      Math.min(this.options.maxDifficulty,
        oldDifficulty * prediction
      )
    );
    
    this.currentDifficulty = this.globalDifficulty;
    
    this.emit('difficulty:adjusted', {
      difficulty: this.globalDifficulty,
      strategy: 'ml_predictive',
      prediction
    });
  }
  
  updateAverageDifficulty() {
    const recent = this.adjustmentHistory.slice(-100);
    if (recent.length === 0) return;
    
    const avgDiff = recent.reduce((sum, adj) => sum + (adj.newDifficulty || 0), 0) / recent.length;
    this.stats.avgDifficulty = avgDiff;
  }
}

export default RealtimeDifficultyAdjuster;