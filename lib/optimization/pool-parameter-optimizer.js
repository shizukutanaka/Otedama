/**
 * Pool Parameter Optimizer - Otedama
 * Automatically optimizes pool parameters for maximum efficiency
 * 
 * Design Principles:
 * - Carmack: Real-time optimization with minimal overhead
 * - Martin: Clean separation of optimization domains
 * - Pike: Simple feedback loops for complex systems
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('PoolParameterOptimizer');

/**
 * Optimization targets
 */
const OPTIMIZATION_TARGETS = {
  HASHRATE: 'hashrate',              // Maximize pool hashrate
  EFFICIENCY: 'efficiency',          // Maximize share acceptance rate
  STABILITY: 'stability',            // Minimize miner churn
  PROFITABILITY: 'profitability',    // Maximize pool profit
  LATENCY: 'latency',               // Minimize share latency
  FAIRNESS: 'fairness'              // Ensure fair reward distribution
};

/**
 * Adjustable parameters
 */
const POOL_PARAMETERS = {
  // Difficulty parameters
  DIFFICULTY_TARGET: 'difficulty_target',
  DIFFICULTY_ADJUSTMENT_INTERVAL: 'difficulty_adjustment_interval',
  DIFFICULTY_ADJUSTMENT_FACTOR: 'difficulty_adjustment_factor',
  VARDIFF_MIN: 'vardiff_min',
  VARDIFF_MAX: 'vardiff_max',
  
  // Share parameters
  SHARE_TIME_TARGET: 'share_time_target',
  SHARE_TIMEOUT: 'share_timeout',
  MAX_SHARE_RATE: 'max_share_rate',
  
  // Connection parameters
  MAX_CONNECTIONS: 'max_connections',
  CONNECTION_TIMEOUT: 'connection_timeout',
  IDLE_TIMEOUT: 'idle_timeout',
  
  // Payment parameters
  MIN_PAYMENT: 'min_payment',
  PAYMENT_INTERVAL: 'payment_interval',
  POOL_FEE: 'pool_fee',
  
  // Performance parameters
  WORKER_THREADS: 'worker_threads',
  CACHE_SIZE: 'cache_size',
  BUFFER_SIZE: 'buffer_size'
};

/**
 * Parameter constraints
 */
const PARAMETER_CONSTRAINTS = {
  [POOL_PARAMETERS.DIFFICULTY_TARGET]: { min: 1, max: 1000000, step: 1 },
  [POOL_PARAMETERS.DIFFICULTY_ADJUSTMENT_INTERVAL]: { min: 10000, max: 300000, step: 10000 },
  [POOL_PARAMETERS.DIFFICULTY_ADJUSTMENT_FACTOR]: { min: 0.1, max: 2.0, step: 0.1 },
  [POOL_PARAMETERS.VARDIFF_MIN]: { min: 1, max: 10000, step: 1 },
  [POOL_PARAMETERS.VARDIFF_MAX]: { min: 10000, max: 10000000, step: 1000 },
  [POOL_PARAMETERS.SHARE_TIME_TARGET]: { min: 5, max: 60, step: 5 },
  [POOL_PARAMETERS.SHARE_TIMEOUT]: { min: 60000, max: 600000, step: 60000 },
  [POOL_PARAMETERS.MAX_SHARE_RATE]: { min: 1, max: 100, step: 1 },
  [POOL_PARAMETERS.MAX_CONNECTIONS]: { min: 100, max: 100000, step: 100 },
  [POOL_PARAMETERS.CONNECTION_TIMEOUT]: { min: 10000, max: 300000, step: 10000 },
  [POOL_PARAMETERS.IDLE_TIMEOUT]: { min: 30000, max: 3600000, step: 30000 },
  [POOL_PARAMETERS.MIN_PAYMENT]: { min: 0.0001, max: 1, step: 0.0001 },
  [POOL_PARAMETERS.PAYMENT_INTERVAL]: { min: 600000, max: 86400000, step: 600000 },
  [POOL_PARAMETERS.POOL_FEE]: { min: 0, max: 0.05, step: 0.001 },
  [POOL_PARAMETERS.WORKER_THREADS]: { min: 1, max: 64, step: 1 },
  [POOL_PARAMETERS.CACHE_SIZE]: { min: 1000, max: 1000000, step: 1000 },
  [POOL_PARAMETERS.BUFFER_SIZE]: { min: 100, max: 10000, step: 100 }
};

/**
 * Optimization state
 */
class OptimizationState {
  constructor(parameters) {
    this.parameters = { ...parameters };
    this.metrics = {
      hashrate: 0,
      efficiency: 0,
      stability: 0,
      profitability: 0,
      latency: 0,
      fairness: 0
    };
    this.score = 0;
    this.timestamp = Date.now();
  }
  
  updateMetrics(metrics) {
    Object.assign(this.metrics, metrics);
    this.calculateScore();
  }
  
  calculateScore() {
    // Weighted score calculation
    const weights = {
      hashrate: 0.3,
      efficiency: 0.25,
      stability: 0.15,
      profitability: 0.15,
      latency: 0.1,
      fairness: 0.05
    };
    
    this.score = Object.entries(this.metrics).reduce((sum, [key, value]) => {
      return sum + (value * (weights[key] || 0));
    }, 0);
  }
}

/**
 * Pool Parameter Optimizer
 */
export class PoolParameterOptimizer extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Optimization settings
      optimizationTarget: config.optimizationTarget || OPTIMIZATION_TARGETS.EFFICIENCY,
      optimizationInterval: config.optimizationInterval || 300000, // 5 minutes
      evaluationPeriod: config.evaluationPeriod || 600000, // 10 minutes
      
      // Algorithm settings
      algorithm: config.algorithm || 'gradient_descent',
      learningRate: config.learningRate || 0.01,
      explorationRate: config.explorationRate || 0.1,
      
      // Constraints
      maxAdjustmentPercent: config.maxAdjustmentPercent || 0.1, // 10% max change
      stabilityThreshold: config.stabilityThreshold || 0.9,
      
      // History
      historySize: config.historySize || 100,
      
      ...config
    };
    
    // Current parameters
    this.currentParameters = this.initializeParameters(config.initialParameters);
    
    // Optimization state
    this.currentState = new OptimizationState(this.currentParameters);
    this.stateHistory = [];
    this.bestState = null;
    
    // Metrics collection
    this.metricsBuffer = [];
    this.lastOptimization = Date.now();
    
    // Components
    this.pool = null;
    this.metricsCollector = null;
    
    // Optimization status
    this.isOptimizing = false;
    this.optimizationCount = 0;
    
    this.logger = logger;
  }
  
  /**
   * Initialize parameters with defaults
   */
  initializeParameters(initial = {}) {
    const defaults = {
      [POOL_PARAMETERS.DIFFICULTY_TARGET]: 1024,
      [POOL_PARAMETERS.DIFFICULTY_ADJUSTMENT_INTERVAL]: 60000,
      [POOL_PARAMETERS.DIFFICULTY_ADJUSTMENT_FACTOR]: 0.25,
      [POOL_PARAMETERS.VARDIFF_MIN]: 8,
      [POOL_PARAMETERS.VARDIFF_MAX]: 1000000,
      [POOL_PARAMETERS.SHARE_TIME_TARGET]: 30,
      [POOL_PARAMETERS.SHARE_TIMEOUT]: 300000,
      [POOL_PARAMETERS.MAX_SHARE_RATE]: 10,
      [POOL_PARAMETERS.MAX_CONNECTIONS]: 10000,
      [POOL_PARAMETERS.CONNECTION_TIMEOUT]: 60000,
      [POOL_PARAMETERS.IDLE_TIMEOUT]: 300000,
      [POOL_PARAMETERS.MIN_PAYMENT]: 0.001,
      [POOL_PARAMETERS.PAYMENT_INTERVAL]: 3600000,
      [POOL_PARAMETERS.POOL_FEE]: 0.01,
      [POOL_PARAMETERS.WORKER_THREADS]: require('os').cpus().length,
      [POOL_PARAMETERS.CACHE_SIZE]: 50000,
      [POOL_PARAMETERS.BUFFER_SIZE]: 1000
    };
    
    return { ...defaults, ...initial };
  }
  
  /**
   * Start optimization
   */
  start(pool, metricsCollector) {
    this.pool = pool;
    this.metricsCollector = metricsCollector;
    
    // Apply initial parameters
    this.applyParameters(this.currentParameters);
    
    // Start optimization loop
    this.optimizationInterval = setInterval(() => {
      this.optimize();
    }, this.config.optimizationInterval);
    
    // Start metrics collection
    this.metricsInterval = setInterval(() => {
      this.collectMetrics();
    }, 10000); // Every 10 seconds
    
    this.logger.info('Pool parameter optimizer started', {
      target: this.config.optimizationTarget,
      algorithm: this.config.algorithm
    });
  }
  
  /**
   * Stop optimization
   */
  stop() {
    if (this.optimizationInterval) {
      clearInterval(this.optimizationInterval);
      this.optimizationInterval = null;
    }
    
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
    
    this.logger.info('Pool parameter optimizer stopped');
  }
  
  /**
   * Collect current metrics
   */
  collectMetrics() {
    if (!this.pool || !this.metricsCollector) return;
    
    const metrics = {
      timestamp: Date.now(),
      hashrate: this.pool.metrics.hashrate,
      miners: this.pool.metrics.minerCount,
      shares: this.pool.metrics.shareCount,
      efficiency: this.calculateEfficiency(),
      stability: this.calculateStability(),
      profitability: this.calculateProfitability(),
      latency: this.calculateLatency(),
      fairness: this.calculateFairness()
    };
    
    this.metricsBuffer.push(metrics);
    
    // Keep buffer size limited
    if (this.metricsBuffer.length > 100) {
      this.metricsBuffer.shift();
    }
  }
  
  /**
   * Perform optimization
   */
  async optimize() {
    if (this.isOptimizing) return;
    
    this.isOptimizing = true;
    const startTime = Date.now();
    
    try {
      // Evaluate current state
      const evaluation = this.evaluateCurrentState();
      this.currentState.updateMetrics(evaluation);
      
      // Store in history
      this.stateHistory.push({ ...this.currentState });
      if (this.stateHistory.length > this.config.historySize) {
        this.stateHistory.shift();
      }
      
      // Update best state
      if (!this.bestState || this.currentState.score > this.bestState.score) {
        this.bestState = { ...this.currentState };
      }
      
      // Decide if optimization is needed
      if (this.shouldOptimize(evaluation)) {
        // Generate new parameters
        const newParameters = this.generateNewParameters();
        
        // Validate parameters
        if (this.validateParameters(newParameters)) {
          // Apply new parameters
          await this.applyParameters(newParameters);
          
          // Update state
          this.currentParameters = newParameters;
          this.currentState = new OptimizationState(newParameters);
          
          this.logger.info('Parameters optimized', {
            changes: this.getParameterChanges(this.currentParameters, newParameters),
            score: this.currentState.score
          });
        }
      }
      
      this.optimizationCount++;
      this.lastOptimization = Date.now();
      
      const duration = Date.now() - startTime;
      this.emit('optimization:completed', {
        duration,
        parameters: this.currentParameters,
        metrics: evaluation
      });
      
    } catch (error) {
      this.logger.error('Optimization failed:', error);
      this.emit('optimization:failed', { error });
      
    } finally {
      this.isOptimizing = false;
    }
  }
  
  /**
   * Evaluate current state
   */
  evaluateCurrentState() {
    if (this.metricsBuffer.length === 0) {
      return this.currentState.metrics;
    }
    
    // Average metrics over evaluation period
    const recentMetrics = this.metricsBuffer.slice(-30); // Last 5 minutes
    
    const avgMetrics = {
      hashrate: this.average(recentMetrics.map(m => m.hashrate)),
      efficiency: this.average(recentMetrics.map(m => m.efficiency)),
      stability: this.average(recentMetrics.map(m => m.stability)),
      profitability: this.average(recentMetrics.map(m => m.profitability)),
      latency: this.average(recentMetrics.map(m => m.latency)),
      fairness: this.average(recentMetrics.map(m => m.fairness))
    };
    
    // Normalize metrics to 0-1 range
    return {
      hashrate: this.normalizeHashrate(avgMetrics.hashrate),
      efficiency: avgMetrics.efficiency,
      stability: avgMetrics.stability,
      profitability: this.normalizeProfitability(avgMetrics.profitability),
      latency: this.normalizeLatency(avgMetrics.latency),
      fairness: avgMetrics.fairness
    };
  }
  
  /**
   * Check if optimization should be performed
   */
  shouldOptimize(metrics) {
    // Don't optimize if system is unstable
    if (metrics.stability < this.config.stabilityThreshold) {
      return false;
    }
    
    // Check if current performance is below target
    switch (this.config.optimizationTarget) {
      case OPTIMIZATION_TARGETS.HASHRATE:
        return metrics.hashrate < 0.9;
        
      case OPTIMIZATION_TARGETS.EFFICIENCY:
        return metrics.efficiency < 0.95;
        
      case OPTIMIZATION_TARGETS.PROFITABILITY:
        return metrics.profitability < 0.9;
        
      case OPTIMIZATION_TARGETS.LATENCY:
        return metrics.latency < 0.9;
        
      default:
        return this.currentState.score < 0.85;
    }
  }
  
  /**
   * Generate new parameters
   */
  generateNewParameters() {
    switch (this.config.algorithm) {
      case 'gradient_descent':
        return this.gradientDescentOptimization();
        
      case 'simulated_annealing':
        return this.simulatedAnnealingOptimization();
        
      case 'genetic':
        return this.geneticOptimization();
        
      default:
        return this.randomOptimization();
    }
  }
  
  /**
   * Gradient descent optimization
   */
  gradientDescentOptimization() {
    const newParams = { ...this.currentParameters };
    const gradients = this.estimateGradients();
    
    for (const [param, gradient] of Object.entries(gradients)) {
      const constraint = PARAMETER_CONSTRAINTS[param];
      if (!constraint) continue;
      
      // Update parameter
      let newValue = this.currentParameters[param] + gradient * this.config.learningRate;
      
      // Apply constraints
      newValue = Math.max(constraint.min, Math.min(constraint.max, newValue));
      
      // Quantize to step size
      newValue = Math.round(newValue / constraint.step) * constraint.step;
      
      newParams[param] = newValue;
    }
    
    return newParams;
  }
  
  /**
   * Estimate gradients for parameters
   */
  estimateGradients() {
    const gradients = {};
    
    // Analyze historical performance
    if (this.stateHistory.length < 2) {
      return gradients;
    }
    
    // Simple finite difference approximation
    const recent = this.stateHistory.slice(-10);
    
    for (const param of Object.keys(this.currentParameters)) {
      let gradient = 0;
      let samples = 0;
      
      for (let i = 1; i < recent.length; i++) {
        const prev = recent[i - 1];
        const curr = recent[i];
        
        const paramChange = curr.parameters[param] - prev.parameters[param];
        const scoreChange = curr.score - prev.score;
        
        if (Math.abs(paramChange) > 0.0001) {
          gradient += scoreChange / paramChange;
          samples++;
        }
      }
      
      gradients[param] = samples > 0 ? gradient / samples : 0;
    }
    
    return gradients;
  }
  
  /**
   * Simulated annealing optimization
   */
  simulatedAnnealingOptimization() {
    const temperature = this.calculateTemperature();
    const newParams = { ...this.currentParameters };
    
    // Randomly perturb parameters
    for (const param of Object.keys(newParams)) {
      if (Math.random() < 0.3) { // 30% chance to modify each parameter
        const constraint = PARAMETER_CONSTRAINTS[param];
        if (!constraint) continue;
        
        const range = constraint.max - constraint.min;
        const maxChange = range * this.config.maxAdjustmentPercent * temperature;
        const change = (Math.random() - 0.5) * 2 * maxChange;
        
        let newValue = newParams[param] + change;
        newValue = Math.max(constraint.min, Math.min(constraint.max, newValue));
        newValue = Math.round(newValue / constraint.step) * constraint.step;
        
        newParams[param] = newValue;
      }
    }
    
    return newParams;
  }
  
  /**
   * Random optimization (exploration)
   */
  randomOptimization() {
    const newParams = { ...this.currentParameters };
    
    // Randomly adjust one parameter
    const params = Object.keys(PARAMETER_CONSTRAINTS);
    const targetParam = params[Math.floor(Math.random() * params.length)];
    const constraint = PARAMETER_CONSTRAINTS[targetParam];
    
    if (this.currentParameters[targetParam] !== undefined) {
      const currentValue = this.currentParameters[targetParam];
      const range = constraint.max - constraint.min;
      const maxChange = range * this.config.maxAdjustmentPercent;
      
      let newValue = currentValue + (Math.random() - 0.5) * 2 * maxChange;
      newValue = Math.max(constraint.min, Math.min(constraint.max, newValue));
      newValue = Math.round(newValue / constraint.step) * constraint.step;
      
      newParams[targetParam] = newValue;
    }
    
    return newParams;
  }
  
  /**
   * Genetic optimization
   */
  geneticOptimization() {
    if (this.stateHistory.length < 10) {
      return this.randomOptimization();
    }
    
    // Select best performing states
    const sorted = [...this.stateHistory].sort((a, b) => b.score - a.score);
    const parents = sorted.slice(0, 5);
    
    // Crossover and mutation
    const newParams = { ...this.currentParameters };
    
    for (const param of Object.keys(newParams)) {
      // Crossover: take weighted average of best performers
      let sum = 0;
      let weightSum = 0;
      
      for (const parent of parents) {
        const weight = parent.score;
        sum += parent.parameters[param] * weight;
        weightSum += weight;
      }
      
      if (weightSum > 0) {
        newParams[param] = sum / weightSum;
        
        // Mutation
        if (Math.random() < this.config.explorationRate) {
          const constraint = PARAMETER_CONSTRAINTS[param];
          if (constraint) {
            const mutationSize = (constraint.max - constraint.min) * 0.05;
            newParams[param] += (Math.random() - 0.5) * 2 * mutationSize;
            newParams[param] = Math.max(constraint.min, Math.min(constraint.max, newParams[param]));
            newParams[param] = Math.round(newParams[param] / constraint.step) * constraint.step;
          }
        }
      }
    }
    
    return newParams;
  }
  
  /**
   * Validate parameters
   */
  validateParameters(parameters) {
    for (const [param, value] of Object.entries(parameters)) {
      const constraint = PARAMETER_CONSTRAINTS[param];
      if (constraint) {
        if (value < constraint.min || value > constraint.max) {
          this.logger.warn('Parameter out of bounds', { param, value, constraint });
          return false;
        }
      }
    }
    
    // Additional validation rules
    if (parameters[POOL_PARAMETERS.VARDIFF_MIN] >= parameters[POOL_PARAMETERS.VARDIFF_MAX]) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Apply parameters to pool
   */
  async applyParameters(parameters) {
    if (!this.pool) return;
    
    const changes = [];
    
    // Apply each parameter
    for (const [param, value] of Object.entries(parameters)) {
      const oldValue = this.pool.config[param];
      if (oldValue !== value) {
        changes.push({ param, oldValue, newValue: value });
        
        // Apply parameter based on type
        switch (param) {
          case POOL_PARAMETERS.DIFFICULTY_TARGET:
          case POOL_PARAMETERS.VARDIFF_MIN:
          case POOL_PARAMETERS.VARDIFF_MAX:
            if (this.pool.difficultyAdjuster) {
              this.pool.difficultyAdjuster.config[param] = value;
            }
            break;
            
          case POOL_PARAMETERS.WORKER_THREADS:
            // Would need to restart worker pool
            this.pool.config[param] = value;
            break;
            
          default:
            this.pool.config[param] = value;
        }
      }
    }
    
    if (changes.length > 0) {
      this.emit('parameters:changed', { changes });
    }
  }
  
  /**
   * Calculate metrics
   */
  
  calculateEfficiency() {
    if (!this.pool) return 0.5;
    
    const totalShares = this.pool.metrics.totalShares || 1;
    const validShares = this.pool.metrics.validShares || 0;
    
    return validShares / totalShares;
  }
  
  calculateStability() {
    if (this.metricsBuffer.length < 10) return 0.5;
    
    // Calculate variance in miner count
    const minerCounts = this.metricsBuffer.slice(-30).map(m => m.miners);
    const avgMiners = this.average(minerCounts);
    const variance = this.variance(minerCounts);
    const cv = avgMiners > 0 ? Math.sqrt(variance) / avgMiners : 1;
    
    return Math.max(0, 1 - cv);
  }
  
  calculateProfitability() {
    if (!this.pool) return 0.5;
    
    // Simplified profitability based on hashrate and efficiency
    const hashrate = this.pool.metrics.hashrate || 0;
    const efficiency = this.calculateEfficiency();
    const fee = this.currentParameters[POOL_PARAMETERS.POOL_FEE] || 0.01;
    
    return efficiency * (1 - fee);
  }
  
  calculateLatency() {
    if (!this.metricsCollector) return 0.5;
    
    // Get average share processing time
    const avgLatency = this.metricsCollector.metrics.latency?.getAverage(300) || 100;
    
    // Normalize (lower is better)
    return Math.max(0, 1 - (avgLatency / 1000)); // Assume 1000ms is bad
  }
  
  calculateFairness() {
    // Calculate Gini coefficient or similar fairness metric
    // Simplified version: check variance in miner shares
    return 0.9; // Placeholder
  }
  
  /**
   * Normalization helpers
   */
  
  normalizeHashrate(hashrate) {
    // Normalize to 0-1 based on expected range
    const maxExpected = 1e15; // 1 PH/s
    return Math.min(1, hashrate / maxExpected);
  }
  
  normalizeProfitability(profitability) {
    // Already 0-1
    return profitability;
  }
  
  normalizeLatency(latency) {
    // Already normalized in calculation
    return latency;
  }
  
  /**
   * Utility methods
   */
  
  average(values) {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
  
  variance(values) {
    if (values.length === 0) return 0;
    const avg = this.average(values);
    return values.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / values.length;
  }
  
  calculateTemperature() {
    // Simulated annealing temperature
    const progress = this.optimizationCount / 1000;
    return Math.max(0.1, 1 - progress);
  }
  
  getParameterChanges(oldParams, newParams) {
    const changes = {};
    
    for (const param of Object.keys(newParams)) {
      if (oldParams[param] !== newParams[param]) {
        changes[param] = {
          old: oldParams[param],
          new: newParams[param],
          change: ((newParams[param] - oldParams[param]) / oldParams[param] * 100).toFixed(2) + '%'
        };
      }
    }
    
    return changes;
  }
  
  /**
   * Get optimization status
   */
  getStatus() {
    return {
      isOptimizing: this.isOptimizing,
      optimizationCount: this.optimizationCount,
      lastOptimization: this.lastOptimization,
      currentScore: this.currentState.score,
      bestScore: this.bestState?.score || 0,
      currentParameters: this.currentParameters,
      metrics: this.currentState.metrics,
      target: this.config.optimizationTarget,
      algorithm: this.config.algorithm
    };
  }
  
  /**
   * Get optimization history
   */
  getHistory() {
    return this.stateHistory.map(state => ({
      timestamp: state.timestamp,
      score: state.score,
      metrics: state.metrics,
      parameters: state.parameters
    }));
  }
  
  /**
   * Export best parameters
   */
  exportBestParameters() {
    if (!this.bestState) return null;
    
    return {
      parameters: this.bestState.parameters,
      score: this.bestState.score,
      metrics: this.bestState.metrics,
      timestamp: this.bestState.timestamp
    };
  }
  
  /**
   * Import parameters
   */
  importParameters(parameters) {
    if (this.validateParameters(parameters)) {
      this.currentParameters = { ...parameters };
      this.applyParameters(this.currentParameters);
      this.currentState = new OptimizationState(this.currentParameters);
      
      this.logger.info('Parameters imported successfully');
      return true;
    }
    
    return false;
  }
}

// Export constants
export {
  OPTIMIZATION_TARGETS,
  POOL_PARAMETERS,
  PARAMETER_CONSTRAINTS
};

export default PoolParameterOptimizer;