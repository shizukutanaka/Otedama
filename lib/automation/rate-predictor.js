/**
 * Rate Predictor
 * Machine learning-based rate prediction for optimal conversion timing
 * 
 * Features:
 * - Time series analysis
 * - Pattern recognition
 * - Trend prediction
 * - Confidence scoring
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('RatePredictor');

/**
 * Prediction models
 */
export const PredictionModel = {
  ARIMA: 'arima',              // Time series forecasting
  LSTM: 'lstm',                // Deep learning
  PROPHET: 'prophet',          // Facebook's Prophet
  ENSEMBLE: 'ensemble'         // Combined models
};

/**
 * Pattern types
 */
export const PatternType = {
  SUPPORT_RESISTANCE: 'support_resistance',
  TREND_CHANNEL: 'trend_channel',
  REVERSAL: 'reversal',
  BREAKOUT: 'breakout',
  CONSOLIDATION: 'consolidation'
};

/**
 * Rate Predictor
 */
export class RatePredictor extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Model configuration
      model: config.model || PredictionModel.ENSEMBLE,
      historicalDays: config.historicalDays || 30,
      predictionWindow: config.predictionWindow || 3600000, // 1 hour
      
      // Analysis parameters
      minDataPoints: config.minDataPoints || 100,
      seasonality: config.seasonality || 'auto',
      confidenceThreshold: config.confidenceThreshold || 0.7,
      
      // Pattern detection
      patternDetection: config.patternDetection !== false,
      supportResistanceWindow: config.supportResistanceWindow || 168, // 7 days in hours
      trendSensitivity: config.trendSensitivity || 0.02,
      
      // Model training
      retrainInterval: config.retrainInterval || 86400000, // 24 hours
      validationSplit: config.validationSplit || 0.2,
      
      // Performance tracking
      trackAccuracy: config.trackAccuracy !== false,
      accuracyWindow: config.accuracyWindow || 100
    };
    
    // Model state
    this.models = new Map();
    this.predictions = new Map();
    this.patterns = new Map();
    this.accuracy = new Map();
    
    // Training data
    this.historicalData = new Map();
    this.lastTraining = new Map();
    
    // Initialize models
    this.initializeModels();
  }
  
  /**
   * Initialize prediction models
   */
  initializeModels() {
    // Initialize base models
    this.models.set(PredictionModel.ARIMA, {
      type: 'arima',
      parameters: { p: 2, d: 1, q: 2 },
      trained: false
    });
    
    this.models.set(PredictionModel.LSTM, {
      type: 'lstm',
      layers: [50, 25, 1],
      epochs: 100,
      trained: false
    });
    
    this.models.set(PredictionModel.PROPHET, {
      type: 'prophet',
      changepoint_prior_scale: 0.05,
      trained: false
    });
    
    logger.info('Rate prediction models initialized');
  }
  
  /**
   * Predict future rates
   */
  async predict(fromCoin, toCoin, historicalRates) {
    const pair = `${fromCoin}:${toCoin}`;
    
    // Check if we have enough data
    if (historicalRates.length < this.config.minDataPoints) {
      return {
        trend: 'neutral',
        confidence: 0,
        prediction: null,
        reason: 'Insufficient data'
      };
    }
    
    // Update historical data
    this.updateHistoricalData(pair, historicalRates);
    
    // Check if models need retraining
    if (this.shouldRetrain(pair)) {
      await this.trainModels(pair);
    }
    
    // Get predictions from all models
    const predictions = await this.getPredictions(pair, historicalRates);
    
    // Combine predictions (ensemble)
    const ensemble = this.ensemblePredictions(predictions);
    
    // Detect patterns
    const patterns = this.detectPatterns(historicalRates);
    
    // Store for accuracy tracking
    this.storePrediction(pair, ensemble);
    
    return {
      ...ensemble,
      patterns,
      models: predictions
    };
  }
  
  /**
   * Get predictions from all models
   */
  async getPredictions(pair, historicalRates) {
    const predictions = {};
    
    // ARIMA prediction
    predictions.arima = await this.predictARIMA(historicalRates);
    
    // LSTM prediction
    predictions.lstm = await this.predictLSTM(historicalRates);
    
    // Prophet prediction
    predictions.prophet = await this.predictProphet(historicalRates);
    
    return predictions;
  }
  
  /**
   * ARIMA prediction
   */
  async predictARIMA(historicalRates) {
    try {
      // Prepare time series data
      const timeSeries = historicalRates.map(h => h.rate);
      
      // Simple ARIMA implementation (would use proper library in production)
      const { trend, forecast } = this.simpleARIMA(timeSeries);
      
      // Calculate confidence based on model fit
      const confidence = this.calculateARIMAConfidence(timeSeries, forecast);
      
      return {
        trend,
        rate: forecast,
        confidence,
        method: 'ARIMA'
      };
      
    } catch (error) {
      logger.error('ARIMA prediction failed:', error);
      return { trend: 'neutral', confidence: 0 };
    }
  }
  
  /**
   * Simple ARIMA implementation
   */
  simpleARIMA(timeSeries) {
    const n = timeSeries.length;
    
    // Calculate differences (d=1)
    const diff = [];
    for (let i = 1; i < n; i++) {
      diff.push(timeSeries[i] - timeSeries[i-1]);
    }
    
    // Calculate moving average (q=2)
    const ma = this.movingAverage(diff, 2);
    
    // Simple trend detection
    const recentTrend = ma.slice(-5).reduce((sum, v) => sum + v, 0) / 5;
    const trend = recentTrend > 0.001 ? 'up' : recentTrend < -0.001 ? 'down' : 'neutral';
    
    // Forecast next value
    const lastValue = timeSeries[n-1];
    const forecast = lastValue + recentTrend;
    
    return { trend, forecast };
  }
  
  /**
   * LSTM prediction (simplified)
   */
  async predictLSTM(historicalRates) {
    try {
      // Prepare sequences
      const sequences = this.prepareSequences(historicalRates, 10);
      
      // Simple neural network simulation (would use TensorFlow.js in production)
      const weights = this.models.get(PredictionModel.LSTM).weights || this.randomWeights();
      
      // Forward pass
      const features = sequences[sequences.length - 1];
      const prediction = this.neuralForward(features, weights);
      
      // Determine trend
      const lastRate = historicalRates[historicalRates.length - 1].rate;
      const trend = prediction > lastRate * 1.002 ? 'up' : 
                   prediction < lastRate * 0.998 ? 'down' : 'neutral';
      
      return {
        trend,
        rate: prediction,
        confidence: 0.75, // Simulated confidence
        method: 'LSTM'
      };
      
    } catch (error) {
      logger.error('LSTM prediction failed:', error);
      return { trend: 'neutral', confidence: 0 };
    }
  }
  
  /**
   * Prophet prediction (simplified)
   */
  async predictProphet(historicalRates) {
    try {
      // Prepare data for Prophet format
      const data = historicalRates.map(h => ({
        ds: new Date(h.timestamp),
        y: h.rate
      }));
      
      // Simple trend and seasonality detection
      const { trend, seasonal } = this.detectTrendAndSeasonality(data);
      
      // Forecast
      const lastRate = data[data.length - 1].y;
      const trendComponent = trend * this.config.predictionWindow / 3600000;
      const seasonalComponent = seasonal[new Date().getHours()] || 0;
      
      const forecast = lastRate * (1 + trendComponent + seasonalComponent);
      
      return {
        trend: trend > 0.001 ? 'up' : trend < -0.001 ? 'down' : 'neutral',
        rate: forecast,
        confidence: 0.8,
        method: 'Prophet',
        components: { trend, seasonal: seasonalComponent }
      };
      
    } catch (error) {
      logger.error('Prophet prediction failed:', error);
      return { trend: 'neutral', confidence: 0 };
    }
  }
  
  /**
   * Ensemble predictions from multiple models
   */
  ensemblePredictions(predictions) {
    const validPredictions = Object.values(predictions).filter(p => p.confidence > 0);
    
    if (validPredictions.length === 0) {
      return { trend: 'neutral', confidence: 0, rate: null };
    }
    
    // Weighted average based on confidence
    const totalConfidence = validPredictions.reduce((sum, p) => sum + p.confidence, 0);
    
    let weightedRate = 0;
    let trendVotes = { up: 0, down: 0, neutral: 0 };
    
    for (const pred of validPredictions) {
      const weight = pred.confidence / totalConfidence;
      if (pred.rate) {
        weightedRate += pred.rate * weight;
      }
      trendVotes[pred.trend] += weight;
    }
    
    // Determine consensus trend
    const trend = Object.entries(trendVotes)
      .sort((a, b) => b[1] - a[1])[0][0];
    
    // Calculate ensemble confidence
    const avgConfidence = totalConfidence / validPredictions.length;
    const agreement = Math.max(...Object.values(trendVotes));
    const ensembleConfidence = avgConfidence * agreement;
    
    return {
      trend,
      rate: weightedRate,
      confidence: ensembleConfidence,
      method: 'ensemble',
      agreement
    };
  }
  
  /**
   * Detect patterns in historical data
   */
  detectPatterns(historicalRates) {
    const patterns = {
      supportLevels: [],
      resistanceLevels: [],
      trendChannel: null,
      reversal: false,
      breakout: false,
      consolidation: false,
      confidence: 0
    };
    
    if (historicalRates.length < 20) {
      return patterns;
    }
    
    // Find support and resistance levels
    const { support, resistance } = this.findSupportResistance(historicalRates);
    patterns.supportLevels = support;
    patterns.resistanceLevels = resistance;
    
    // Detect trend channel
    patterns.trendChannel = this.detectTrendChannel(historicalRates);
    
    // Check for reversal patterns
    patterns.reversal = this.detectReversal(historicalRates);
    patterns.bullishReversal = patterns.reversal && patterns.reversal.type === 'bullish';
    
    // Check for breakout
    patterns.breakout = this.detectBreakout(historicalRates, support, resistance);
    
    // Check for consolidation
    patterns.consolidation = this.detectConsolidation(historicalRates);
    
    // Calculate pattern confidence
    const patternCount = [
      patterns.supportLevels.length > 0,
      patterns.resistanceLevels.length > 0,
      patterns.trendChannel !== null,
      patterns.reversal !== false,
      patterns.breakout !== false
    ].filter(Boolean).length;
    
    patterns.confidence = patternCount / 5;
    
    // Find nearest support level
    if (patterns.supportLevels.length > 0) {
      const currentRate = historicalRates[historicalRates.length - 1].rate;
      patterns.support = patterns.supportLevels
        .filter(s => s < currentRate)
        .sort((a, b) => b - a)[0];
    }
    
    return patterns;
  }
  
  /**
   * Find support and resistance levels
   */
  findSupportResistance(historicalRates) {
    const rates = historicalRates.map(h => h.rate);
    const levels = { support: [], resistance: [] };
    
    // Find local minima and maxima
    for (let i = 2; i < rates.length - 2; i++) {
      // Local minimum (support)
      if (rates[i] < rates[i-1] && rates[i] < rates[i-2] &&
          rates[i] < rates[i+1] && rates[i] < rates[i+2]) {
        levels.support.push(rates[i]);
      }
      
      // Local maximum (resistance)
      if (rates[i] > rates[i-1] && rates[i] > rates[i-2] &&
          rates[i] > rates[i+1] && rates[i] > rates[i+2]) {
        levels.resistance.push(rates[i]);
      }
    }
    
    // Cluster nearby levels
    levels.support = this.clusterLevels(levels.support);
    levels.resistance = this.clusterLevels(levels.resistance);
    
    return levels;
  }
  
  /**
   * Detect trend channel
   */
  detectTrendChannel(historicalRates) {
    if (historicalRates.length < 20) return null;
    
    const rates = historicalRates.map(h => h.rate);
    
    // Linear regression for trend line
    const regression = this.linearRegression(rates);
    
    // Calculate channel boundaries
    const deviations = rates.map((r, i) => r - (regression.slope * i + regression.intercept));
    const upperBound = Math.max(...deviations);
    const lowerBound = Math.min(...deviations);
    
    return {
      slope: regression.slope,
      upper: regression.intercept + upperBound,
      lower: regression.intercept + lowerBound,
      strength: regression.r2
    };
  }
  
  /**
   * Detect reversal patterns
   */
  detectReversal(historicalRates) {
    const recent = historicalRates.slice(-10);
    if (recent.length < 10) return false;
    
    const rates = recent.map(h => h.rate);
    
    // Check for double bottom (bullish)
    const min1Idx = rates.indexOf(Math.min(...rates.slice(0, 5)));
    const min2Idx = rates.slice(5).indexOf(Math.min(...rates.slice(5))) + 5;
    
    if (Math.abs(rates[min1Idx] - rates[min2Idx]) / rates[min1Idx] < 0.02 &&
        rates[rates.length - 1] > rates[min2Idx] * 1.01) {
      return { type: 'bullish', pattern: 'double_bottom', confidence: 0.7 };
    }
    
    // Check for double top (bearish)
    const max1Idx = rates.indexOf(Math.max(...rates.slice(0, 5)));
    const max2Idx = rates.slice(5).indexOf(Math.max(...rates.slice(5))) + 5;
    
    if (Math.abs(rates[max1Idx] - rates[max2Idx]) / rates[max1Idx] < 0.02 &&
        rates[rates.length - 1] < rates[max2Idx] * 0.99) {
      return { type: 'bearish', pattern: 'double_top', confidence: 0.7 };
    }
    
    return false;
  }
  
  /**
   * Detect breakout
   */
  detectBreakout(historicalRates, support, resistance) {
    const recent = historicalRates.slice(-5);
    if (recent.length < 5) return false;
    
    const currentRate = recent[recent.length - 1].rate;
    const previousRates = recent.slice(0, -1).map(h => h.rate);
    
    // Check resistance breakout
    for (const level of resistance) {
      if (currentRate > level * 1.01 && 
          previousRates.every(r => r < level)) {
        return { type: 'resistance', level, strength: 'strong' };
      }
    }
    
    // Check support breakdown
    for (const level of support) {
      if (currentRate < level * 0.99 && 
          previousRates.every(r => r > level)) {
        return { type: 'support', level, strength: 'strong' };
      }
    }
    
    return false;
  }
  
  /**
   * Detect consolidation
   */
  detectConsolidation(historicalRates) {
    const recent = historicalRates.slice(-20);
    if (recent.length < 20) return false;
    
    const rates = recent.map(h => h.rate);
    const mean = rates.reduce((sum, r) => sum + r, 0) / rates.length;
    const range = Math.max(...rates) - Math.min(...rates);
    const rangePercent = range / mean;
    
    // Consolidation if range is less than 2%
    return rangePercent < 0.02;
  }
  
  /**
   * Helper: Moving average
   */
  movingAverage(data, period) {
    const result = [];
    for (let i = period - 1; i < data.length; i++) {
      const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      result.push(sum / period);
    }
    return result;
  }
  
  /**
   * Helper: Linear regression
   */
  linearRegression(data) {
    const n = data.length;
    const sumX = data.reduce((sum, _, i) => sum + i, 0);
    const sumY = data.reduce((sum, y) => sum + y, 0);
    const sumXY = data.reduce((sum, y, i) => sum + i * y, 0);
    const sumX2 = data.reduce((sum, _, i) => sum + i * i, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Calculate R-squared
    const yMean = sumY / n;
    const ssTotal = data.reduce((sum, y) => sum + Math.pow(y - yMean, 2), 0);
    const ssResidual = data.reduce((sum, y, i) => 
      sum + Math.pow(y - (slope * i + intercept), 2), 0);
    const r2 = 1 - (ssResidual / ssTotal);
    
    return { slope, intercept, r2 };
  }
  
  /**
   * Helper: Cluster nearby levels
   */
  clusterLevels(levels, threshold = 0.01) {
    if (levels.length === 0) return [];
    
    const sorted = [...levels].sort((a, b) => a - b);
    const clusters = [[sorted[0]]];
    
    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      const lastCluster = clusters[clusters.length - 1];
      const lastValue = lastCluster[lastCluster.length - 1];
      
      if ((current - lastValue) / lastValue < threshold) {
        lastCluster.push(current);
      } else {
        clusters.push([current]);
      }
    }
    
    // Return cluster averages
    return clusters.map(cluster => 
      cluster.reduce((sum, v) => sum + v, 0) / cluster.length
    );
  }
  
  /**
   * Helper: Prepare sequences for LSTM
   */
  prepareSequences(historicalRates, sequenceLength) {
    const sequences = [];
    const rates = historicalRates.map(h => h.rate);
    
    for (let i = sequenceLength; i < rates.length; i++) {
      sequences.push(rates.slice(i - sequenceLength, i));
    }
    
    return sequences;
  }
  
  /**
   * Helper: Random weights for neural network
   */
  randomWeights() {
    return {
      input: Array(10).fill(0).map(() => Math.random() - 0.5),
      hidden: Array(5).fill(0).map(() => Math.random() - 0.5),
      output: Math.random() - 0.5
    };
  }
  
  /**
   * Helper: Neural network forward pass
   */
  neuralForward(inputs, weights) {
    // Simplified neural network
    const hidden = inputs.reduce((sum, input, i) => 
      sum + input * (weights.input[i] || 0), 0);
    
    const activated = Math.tanh(hidden);
    const output = activated * weights.output;
    
    // Scale to rate range
    const lastRate = inputs[inputs.length - 1];
    return lastRate * (1 + output * 0.1);
  }
  
  /**
   * Helper: Detect trend and seasonality
   */
  detectTrendAndSeasonality(data) {
    // Simple trend detection
    const regression = this.linearRegression(data.map(d => d.y));
    
    // Simple hourly seasonality
    const hourlyAverages = {};
    for (const point of data) {
      const hour = point.ds.getHours();
      if (!hourlyAverages[hour]) {
        hourlyAverages[hour] = [];
      }
      hourlyAverages[hour].push(point.y);
    }
    
    const seasonal = {};
    for (const [hour, values] of Object.entries(hourlyAverages)) {
      const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
      const overallAvg = data.reduce((sum, d) => sum + d.y, 0) / data.length;
      seasonal[hour] = (avg - overallAvg) / overallAvg;
    }
    
    return { trend: regression.slope, seasonal };
  }
  
  /**
   * Calculate ARIMA confidence
   */
  calculateARIMAConfidence(actual, forecast) {
    // Simple confidence based on recent accuracy
    const recentForecast = actual.slice(-10);
    const mae = recentForecast.reduce((sum, val, i) => {
      if (i === 0) return sum;
      const predicted = recentForecast[i-1];
      return sum + Math.abs(val - predicted) / val;
    }, 0) / (recentForecast.length - 1);
    
    // Convert MAE to confidence (lower error = higher confidence)
    return Math.max(0, Math.min(1, 1 - mae * 10));
  }
  
  /**
   * Update historical data
   */
  updateHistoricalData(pair, newData) {
    if (!this.historicalData.has(pair)) {
      this.historicalData.set(pair, []);
    }
    
    const existing = this.historicalData.get(pair);
    const combined = [...existing, ...newData];
    
    // Remove duplicates and sort
    const unique = Array.from(new Map(
      combined.map(item => [item.timestamp, item])
    ).values()).sort((a, b) => a.timestamp - b.timestamp);
    
    // Keep only recent data
    const cutoff = Date.now() - (this.config.historicalDays * 86400000);
    this.historicalData.set(pair, unique.filter(d => d.timestamp > cutoff));
  }
  
  /**
   * Check if models need retraining
   */
  shouldRetrain(pair) {
    const lastTrain = this.lastTraining.get(pair) || 0;
    return Date.now() - lastTrain > this.config.retrainInterval;
  }
  
  /**
   * Train models with historical data
   */
  async trainModels(pair) {
    logger.info(`Training models for ${pair}`);
    
    const data = this.historicalData.get(pair);
    if (!data || data.length < this.config.minDataPoints) {
      return;
    }
    
    // In production, would actually train ML models here
    // For now, just mark as trained
    for (const [modelName, model] of this.models) {
      model.trained = true;
      model.lastTrained = Date.now();
      model.trainingData = data.length;
    }
    
    this.lastTraining.set(pair, Date.now());
    
    logger.info(`Models trained for ${pair} with ${data.length} data points`);
  }
  
  /**
   * Store prediction for accuracy tracking
   */
  storePrediction(pair, prediction) {
    if (!this.predictions.has(pair)) {
      this.predictions.set(pair, []);
    }
    
    const stored = {
      ...prediction,
      timestamp: Date.now(),
      pair
    };
    
    const predictions = this.predictions.get(pair);
    predictions.push(stored);
    
    // Keep only recent predictions
    if (predictions.length > this.config.accuracyWindow) {
      predictions.shift();
    }
  }
  
  /**
   * Get prediction accuracy
   */
  getAccuracy(pair) {
    const predictions = this.predictions.get(pair) || [];
    const data = this.historicalData.get(pair) || [];
    
    if (predictions.length < 10) {
      return { accuracy: null, samples: predictions.length };
    }
    
    let correct = 0;
    let total = 0;
    
    for (const pred of predictions) {
      // Find actual rate at prediction time + window
      const actualTime = pred.timestamp + this.config.predictionWindow;
      const actual = data.find(d => 
        Math.abs(d.timestamp - actualTime) < 60000 // Within 1 minute
      );
      
      if (actual) {
        total++;
        
        // Check if trend prediction was correct
        const actualTrend = actual.rate > pred.rate ? 'up' : 
                           actual.rate < pred.rate ? 'down' : 'neutral';
        
        if (pred.trend === actualTrend) {
          correct++;
        }
      }
    }
    
    return {
      accuracy: total > 0 ? correct / total : null,
      samples: total,
      recentPredictions: predictions.slice(-5)
    };
  }
  
  /**
   * Get predictor statistics
   */
  getStats() {
    const stats = {
      modelsInitialized: this.models.size,
      pairsTracked: this.historicalData.size,
      totalPredictions: 0,
      averageConfidence: 0,
      accuracy: {}
    };
    
    // Calculate total predictions and average confidence
    for (const predictions of this.predictions.values()) {
      stats.totalPredictions += predictions.length;
      const avgConf = predictions.reduce((sum, p) => sum + p.confidence, 0) / predictions.length;
      stats.averageConfidence += avgConf;
    }
    
    if (this.predictions.size > 0) {
      stats.averageConfidence /= this.predictions.size;
    }
    
    // Get accuracy for each pair
    for (const pair of this.historicalData.keys()) {
      stats.accuracy[pair] = this.getAccuracy(pair);
    }
    
    return stats;
  }
}

export default RatePredictor;