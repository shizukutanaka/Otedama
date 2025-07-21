/**
 * AI-Powered Difficulty Prediction and Adjustment
 * Uses machine learning for intelligent difficulty management
 */

import { EventEmitter } from 'events';
import { logger } from '../../core/logger.js';

/**
 * Difficulty adjustment strategies
 */
export const DifficultyStrategy = {
  REACTIVE: 'reactive',         // Traditional reactive adjustment
  PREDICTIVE: 'predictive',     // ML-based prediction
  HYBRID: 'hybrid',             // Combination of both
  AGGRESSIVE: 'aggressive',     // Fast adjustment for volatile conditions
  CONSERVATIVE: 'conservative'  // Slow adjustment for stability
};

/**
 * Neural network for difficulty prediction
 */
export class DifficultyNeuralNetwork {
  constructor(config = {}) {
    this.inputSize = config.inputSize || 10;
    this.hiddenSize = config.hiddenSize || 20;
    this.outputSize = config.outputSize || 1;
    this.learningRate = config.learningRate || 0.001;
    
    // Initialize weights
    this.weights = {
      input: this.initializeWeights(this.inputSize, this.hiddenSize),
      hidden: this.initializeWeights(this.hiddenSize, this.outputSize)
    };
    
    // Training data
    this.trainingData = [];
    this.maxDataPoints = config.maxDataPoints || 10000;
  }
  
  /**
   * Initialize random weights
   */
  initializeWeights(rows, cols) {
    const weights = [];
    for (let i = 0; i < rows; i++) {
      weights[i] = [];
      for (let j = 0; j < cols; j++) {
        weights[i][j] = (Math.random() - 0.5) * 2;
      }
    }
    return weights;
  }
  
  /**
   * Sigmoid activation function
   */
  sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
  }
  
  /**
   * Sigmoid derivative
   */
  sigmoidDerivative(x) {
    return x * (1 - x);
  }
  
  /**
   * Forward propagation
   */
  forward(input) {
    // Input to hidden layer
    const hidden = [];
    for (let i = 0; i < this.hiddenSize; i++) {
      let sum = 0;
      for (let j = 0; j < this.inputSize; j++) {
        sum += input[j] * this.weights.input[j][i];
      }
      hidden[i] = this.sigmoid(sum);
    }
    
    // Hidden to output layer
    let output = 0;
    for (let i = 0; i < this.hiddenSize; i++) {
      output += hidden[i] * this.weights.hidden[i][0];
    }
    output = this.sigmoid(output);
    
    return { hidden, output };
  }
  
  /**
   * Backward propagation
   */
  backward(input, hidden, output, target) {
    // Calculate output error
    const outputError = target - output;
    const outputDelta = outputError * this.sigmoidDerivative(output);
    
    // Calculate hidden layer errors
    const hiddenErrors = [];
    const hiddenDeltas = [];
    
    for (let i = 0; i < this.hiddenSize; i++) {
      hiddenErrors[i] = outputDelta * this.weights.hidden[i][0];
      hiddenDeltas[i] = hiddenErrors[i] * this.sigmoidDerivative(hidden[i]);
    }
    
    // Update hidden to output weights
    for (let i = 0; i < this.hiddenSize; i++) {
      this.weights.hidden[i][0] += this.learningRate * outputDelta * hidden[i];
    }
    
    // Update input to hidden weights
    for (let i = 0; i < this.inputSize; i++) {
      for (let j = 0; j < this.hiddenSize; j++) {
        this.weights.input[i][j] += this.learningRate * hiddenDeltas[j] * input[i];
      }
    }
  }
  
  /**
   * Train the network
   */
  train(input, target) {
    const { hidden, output } = this.forward(input);
    this.backward(input, hidden, output, target);
    
    // Store training data
    this.trainingData.push({ input, target, output });
    if (this.trainingData.length > this.maxDataPoints) {
      this.trainingData.shift();
    }
    
    return output;
  }
  
  /**
   * Predict difficulty
   */
  predict(input) {
    const { output } = this.forward(input);
    return output;
  }
  
  /**
   * Calculate accuracy
   */
  calculateAccuracy() {
    if (this.trainingData.length === 0) return 0;
    
    let totalError = 0;
    for (const data of this.trainingData) {
      totalError += Math.abs(data.target - data.output);
    }
    
    return 1 - (totalError / this.trainingData.length);
  }
}

/**
 * Time series analyzer for pattern detection
 */
export class TimeSeriesAnalyzer {
  constructor(windowSize = 100) {
    this.windowSize = windowSize;
    this.data = [];
  }
  
  /**
   * Add data point
   */
  addDataPoint(value, timestamp) {
    this.data.push({ value, timestamp });
    
    // Maintain window size
    if (this.data.length > this.windowSize) {
      this.data.shift();
    }
  }
  
  /**
   * Calculate moving average
   */
  movingAverage(period) {
    if (this.data.length < period) return null;
    
    const slice = this.data.slice(-period);
    const sum = slice.reduce((acc, point) => acc + point.value, 0);
    
    return sum / period;
  }
  
  /**
   * Calculate exponential moving average
   */
  exponentialMovingAverage(period) {
    if (this.data.length === 0) return null;
    
    const multiplier = 2 / (period + 1);
    let ema = this.data[0].value;
    
    for (let i = 1; i < this.data.length; i++) {
      ema = (this.data[i].value - ema) * multiplier + ema;
    }
    
    return ema;
  }
  
  /**
   * Detect trend
   */
  detectTrend() {
    if (this.data.length < 10) return 'insufficient_data';
    
    const ma10 = this.movingAverage(10);
    const ma20 = this.movingAverage(20);
    
    if (!ma10 || !ma20) return 'neutral';
    
    if (ma10 > ma20 * 1.05) return 'uptrend';
    if (ma10 < ma20 * 0.95) return 'downtrend';
    
    return 'neutral';
  }
  
  /**
   * Calculate volatility
   */
  calculateVolatility() {
    if (this.data.length < 2) return 0;
    
    const values = this.data.map(d => d.value);
    const mean = values.reduce((a, b) => a + b) / values.length;
    
    const variance = values.reduce((acc, val) => {
      return acc + Math.pow(val - mean, 2);
    }, 0) / values.length;
    
    return Math.sqrt(variance);
  }
  
  /**
   * Predict next value using linear regression
   */
  predictNext() {
    if (this.data.length < 3) return null;
    
    // Simple linear regression
    const n = this.data.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += this.data[i].value;
      sumXY += i * this.data[i].value;
      sumX2 += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    return intercept + slope * n;
  }
}

/**
 * AI-powered difficulty predictor
 */
export class AIDifficultyPredictor extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      strategy: config.strategy || DifficultyStrategy.HYBRID,
      targetBlockTime: config.targetBlockTime || 10, // seconds
      adjustmentInterval: config.adjustmentInterval || 10, // blocks
      maxAdjustment: config.maxAdjustment || 0.25, // 25% max change
      minDifficulty: config.minDifficulty || 1,
      maxDifficulty: config.maxDifficulty || Number.MAX_SAFE_INTEGER,
      enableML: config.enableML !== false,
      ...config
    };
    
    // Neural network for prediction
    if (this.config.enableML) {
      this.neuralNetwork = new DifficultyNeuralNetwork({
        inputSize: 10, // Last 10 block times normalized
        hiddenSize: 20,
        outputSize: 1, // Difficulty adjustment factor
        learningRate: 0.001
      });
    }
    
    // Time series analyzers
    this.blockTimeAnalyzer = new TimeSeriesAnalyzer(100);
    this.hashrateAnalyzer = new TimeSeriesAnalyzer(100);
    this.difficultyAnalyzer = new TimeSeriesAnalyzer(100);
    
    // Historical data
    this.blockHistory = [];
    this.maxHistorySize = config.maxHistorySize || 1000;
    
    // Current state
    this.currentDifficulty = config.initialDifficulty || 1000;
    this.networkHashrate = 0;
    
    // Prediction accuracy tracking
    this.predictions = [];
    this.predictionAccuracy = 0;
  }
  
  /**
   * Add block to history
   */
  addBlock(block) {
    const blockData = {
      height: block.height,
      timestamp: block.timestamp,
      difficulty: block.difficulty,
      blockTime: block.blockTime,
      hashrate: this.calculateHashrate(block.difficulty, block.blockTime)
    };
    
    this.blockHistory.push(blockData);
    
    // Maintain history size
    if (this.blockHistory.length > this.maxHistorySize) {
      this.blockHistory.shift();
    }
    
    // Update analyzers
    this.blockTimeAnalyzer.addDataPoint(block.blockTime, block.timestamp);
    this.difficultyAnalyzer.addDataPoint(block.difficulty, block.timestamp);
    this.hashrateAnalyzer.addDataPoint(blockData.hashrate, block.timestamp);
    
    // Update network hashrate estimate
    this.networkHashrate = this.hashrateAnalyzer.exponentialMovingAverage(20) || blockData.hashrate;
    
    // Check if adjustment needed
    if (this.shouldAdjust()) {
      this.performAdjustment();
    }
    
    this.emit('block:added', blockData);
  }
  
  /**
   * Calculate hashrate from difficulty and block time
   */
  calculateHashrate(difficulty, blockTime) {
    return (difficulty * Math.pow(2, 32)) / blockTime;
  }
  
  /**
   * Check if difficulty adjustment is needed
   */
  shouldAdjust() {
    if (this.blockHistory.length < this.config.adjustmentInterval) {
      return false;
    }
    
    const lastBlock = this.blockHistory[this.blockHistory.length - 1];
    const adjustmentBlock = this.blockHistory[this.blockHistory.length - this.config.adjustmentInterval];
    
    return (lastBlock.height - adjustmentBlock.height) >= this.config.adjustmentInterval;
  }
  
  /**
   * Perform difficulty adjustment
   */
  performAdjustment() {
    let newDifficulty;
    
    switch (this.config.strategy) {
      case DifficultyStrategy.REACTIVE:
        newDifficulty = this.reactiveAdjustment();
        break;
        
      case DifficultyStrategy.PREDICTIVE:
        newDifficulty = this.predictiveAdjustment();
        break;
        
      case DifficultyStrategy.HYBRID:
        newDifficulty = this.hybridAdjustment();
        break;
        
      case DifficultyStrategy.AGGRESSIVE:
        newDifficulty = this.aggressiveAdjustment();
        break;
        
      case DifficultyStrategy.CONSERVATIVE:
        newDifficulty = this.conservativeAdjustment();
        break;
        
      default:
        newDifficulty = this.reactiveAdjustment();
    }
    
    // Apply bounds
    newDifficulty = Math.max(this.config.minDifficulty, newDifficulty);
    newDifficulty = Math.min(this.config.maxDifficulty, newDifficulty);
    
    // Track prediction accuracy
    if (this.predictions.length > 0) {
      const lastPrediction = this.predictions[this.predictions.length - 1];
      const accuracy = 1 - Math.abs(lastPrediction.predicted - newDifficulty) / newDifficulty;
      this.predictionAccuracy = accuracy;
    }
    
    // Store prediction
    this.predictions.push({
      timestamp: Date.now(),
      actual: this.currentDifficulty,
      predicted: newDifficulty
    });
    
    // Update difficulty
    const oldDifficulty = this.currentDifficulty;
    this.currentDifficulty = newDifficulty;
    
    logger.info(`Difficulty adjusted: ${oldDifficulty} -> ${newDifficulty} (${this.config.strategy})`);
    
    this.emit('difficulty:adjusted', {
      old: oldDifficulty,
      new: newDifficulty,
      strategy: this.config.strategy,
      accuracy: this.predictionAccuracy
    });
  }
  
  /**
   * Traditional reactive adjustment
   */
  reactiveAdjustment() {
    const recentBlocks = this.blockHistory.slice(-this.config.adjustmentInterval);
    const avgBlockTime = recentBlocks.reduce((sum, b) => sum + b.blockTime, 0) / recentBlocks.length;
    
    const adjustmentFactor = this.config.targetBlockTime / avgBlockTime;
    
    // Apply max adjustment limit
    const clampedFactor = Math.max(
      1 - this.config.maxAdjustment,
      Math.min(1 + this.config.maxAdjustment, adjustmentFactor)
    );
    
    return this.currentDifficulty * clampedFactor;
  }
  
  /**
   * ML-based predictive adjustment
   */
  predictiveAdjustment() {
    if (!this.config.enableML || this.blockHistory.length < 10) {
      return this.reactiveAdjustment();
    }
    
    // Prepare input features
    const recentBlocks = this.blockHistory.slice(-10);
    const input = recentBlocks.map(b => b.blockTime / this.config.targetBlockTime);
    
    // Normalize input
    const maxTime = Math.max(...input);
    const normalizedInput = input.map(t => t / maxTime);
    
    // Predict adjustment factor
    const predictedFactor = this.neuralNetwork.predict(normalizedInput) * 2; // Scale to 0-2 range
    
    // Apply prediction
    const newDifficulty = this.currentDifficulty * predictedFactor;
    
    // Train network with actual result
    const actualFactor = this.config.targetBlockTime / recentBlocks[recentBlocks.length - 1].blockTime;
    this.neuralNetwork.train(normalizedInput, actualFactor / 2); // Normalize to 0-1 range
    
    return newDifficulty;
  }
  
  /**
   * Hybrid adjustment combining reactive and predictive
   */
  hybridAdjustment() {
    const reactiveResult = this.reactiveAdjustment();
    
    if (!this.config.enableML || this.blockHistory.length < 10) {
      return reactiveResult;
    }
    
    const predictiveResult = this.predictiveAdjustment();
    
    // Weight based on prediction accuracy
    const weight = Math.min(0.7, this.predictionAccuracy);
    
    return reactiveResult * (1 - weight) + predictiveResult * weight;
  }
  
  /**
   * Aggressive adjustment for volatile conditions
   */
  aggressiveAdjustment() {
    const trend = this.blockTimeAnalyzer.detectTrend();
    const volatility = this.blockTimeAnalyzer.calculateVolatility();
    
    let adjustmentFactor = this.config.targetBlockTime / 
                          (this.blockTimeAnalyzer.movingAverage(5) || this.config.targetBlockTime);
    
    // Amplify adjustment based on trend
    if (trend === 'uptrend') {
      adjustmentFactor *= 1.2;
    } else if (trend === 'downtrend') {
      adjustmentFactor *= 0.8;
    }
    
    // Further amplify based on volatility
    if (volatility > 5) {
      adjustmentFactor = Math.pow(adjustmentFactor, 1.5);
    }
    
    // Allow larger adjustments
    const maxAdj = this.config.maxAdjustment * 2;
    adjustmentFactor = Math.max(1 - maxAdj, Math.min(1 + maxAdj, adjustmentFactor));
    
    return this.currentDifficulty * adjustmentFactor;
  }
  
  /**
   * Conservative adjustment for stability
   */
  conservativeAdjustment() {
    // Use longer average
    const avgBlockTime = this.blockTimeAnalyzer.movingAverage(50) || this.config.targetBlockTime;
    
    const adjustmentFactor = this.config.targetBlockTime / avgBlockTime;
    
    // Apply smaller max adjustment
    const maxAdj = this.config.maxAdjustment / 2;
    const clampedFactor = Math.max(
      1 - maxAdj,
      Math.min(1 + maxAdj, adjustmentFactor)
    );
    
    // Smooth adjustment
    const smoothingFactor = 0.7;
    const smoothedFactor = 1 + (clampedFactor - 1) * smoothingFactor;
    
    return this.currentDifficulty * smoothedFactor;
  }
  
  /**
   * Get current difficulty
   */
  getCurrentDifficulty() {
    return this.currentDifficulty;
  }
  
  /**
   * Get difficulty prediction
   */
  predictNextDifficulty() {
    const predictions = {
      reactive: this.reactiveAdjustment(),
      trend: this.trendBasedPrediction(),
      ml: this.config.enableML ? this.predictiveAdjustment() : null
    };
    
    // Weighted average
    let sum = 0;
    let weights = 0;
    
    if (predictions.reactive) {
      sum += predictions.reactive * 0.4;
      weights += 0.4;
    }
    
    if (predictions.trend) {
      sum += predictions.trend * 0.3;
      weights += 0.3;
    }
    
    if (predictions.ml) {
      sum += predictions.ml * 0.3;
      weights += 0.3;
    }
    
    return weights > 0 ? sum / weights : this.currentDifficulty;
  }
  
  /**
   * Trend-based prediction
   */
  trendBasedPrediction() {
    const trend = this.difficultyAnalyzer.detectTrend();
    const nextValue = this.difficultyAnalyzer.predictNext();
    
    if (!nextValue) return this.currentDifficulty;
    
    // Apply trend adjustment
    if (trend === 'uptrend') {
      return nextValue * 1.05;
    } else if (trend === 'downtrend') {
      return nextValue * 0.95;
    }
    
    return nextValue;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      currentDifficulty: this.currentDifficulty,
      networkHashrate: this.networkHashrate,
      strategy: this.config.strategy,
      blockTimeAverage: this.blockTimeAnalyzer.movingAverage(10),
      blockTimeTrend: this.blockTimeAnalyzer.detectTrend(),
      volatility: this.blockTimeAnalyzer.calculateVolatility(),
      predictionAccuracy: this.predictionAccuracy,
      mlAccuracy: this.config.enableML ? this.neuralNetwork.calculateAccuracy() : null,
      blocksProcessed: this.blockHistory.length
    };
  }
}

export default AIDifficultyPredictor;