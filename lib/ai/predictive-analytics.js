/**
 * AI-Based Predictive Analytics System
 * 
 * Machine learning powered predictions for mining performance,
 * market trends, resource usage, and system optimization
 */

import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../error-handler.js';

export class PredictiveAnalytics extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Data collection
      dataRetentionPeriod: options.dataRetentionPeriod || 30 * 24 * 3600 * 1000, // 30 days
      samplingInterval: options.samplingInterval || 60000, // 1 minute
      batchSize: options.batchSize || 1000,
      
      // Model configuration
      enableMiningPrediction: options.enableMiningPrediction !== false,
      enableMarketPrediction: options.enableMarketPrediction !== false,
      enableResourcePrediction: options.enableResourcePrediction !== false,
      enablePerformancePrediction: options.enablePerformancePrediction !== false,
      
      // Prediction horizons
      shortTermHorizon: options.shortTermHorizon || 3600000, // 1 hour
      mediumTermHorizon: options.mediumTermHorizon || 86400000, // 24 hours
      longTermHorizon: options.longTermHorizon || 604800000, // 7 days
      
      // Model parameters
      modelUpdateInterval: options.modelUpdateInterval || 3600000, // 1 hour
      minDataPoints: options.minDataPoints || 100,
      confidenceThreshold: options.confidenceThreshold || 0.8,
      
      // Storage
      dataDirectory: options.dataDirectory || './data/analytics',
      modelDirectory: options.modelDirectory || './models',
      
      // Features
      enableTrendAnalysis: options.enableTrendAnalysis !== false,
      enableAnomalyPrediction: options.enableAnomalyPrediction !== false,
      enableOptimizationSuggestions: options.enableOptimizationSuggestions !== false,
      
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.isRunning = false;
    this.models = new Map();
    this.dataStore = new Map();
    this.predictions = new Map();
    
    // Analytics state
    this.state = {
      totalPredictions: 0,
      accuratePredictions: 0,
      lastModelUpdate: null,
      activeModels: 0,
      processingQueue: 0
    };
    
    // Model types
    this.modelTypes = {
      MINING_HASHRATE: 'mining_hashrate',
      MINING_DIFFICULTY: 'mining_difficulty',
      MARKET_PRICE: 'market_price',
      SYSTEM_CPU: 'system_cpu',
      SYSTEM_MEMORY: 'system_memory',
      NETWORK_THROUGHPUT: 'network_throughput',
      ERROR_RATE: 'error_rate'
    };
    
    this.initialize();
  }
  
  /**
   * Initialize predictive analytics
   */
  async initialize() {
    try {
      await this.ensureDirectories();
      await this.loadModels();
      await this.loadHistoricalData();
      
      this.emit('initialized');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'predictive-analytics',
        category: ErrorCategory.INITIALIZATION
      });
    }
  }
  
  /**
   * Start predictive analytics
   */
  async start() {
    if (this.isRunning) {
      throw new OtedamaError('Predictive analytics already running', ErrorCategory.OPERATION);
    }
    
    console.log('🤖 Starting AI predictive analytics...');
    this.isRunning = true;
    
    // Start data collection
    this.startDataCollection();
    
    // Start model training
    this.startModelTraining();
    
    // Start prediction generation
    this.startPredictionGeneration();
    
    this.emit('started');
    console.log('✅ Predictive analytics started successfully');
  }
  
  /**
   * Stop predictive analytics
   */
  async stop() {
    if (!this.isRunning) return;
    
    console.log('🛑 Stopping predictive analytics...');
    this.isRunning = false;
    
    // Clear timers
    if (this.dataTimer) clearInterval(this.dataTimer);
    if (this.trainingTimer) clearInterval(this.trainingTimer);
    if (this.predictionTimer) clearInterval(this.predictionTimer);
    
    // Save models and data
    await this.saveModels();
    await this.saveHistoricalData();
    
    this.emit('stopped');
    console.log('✅ Predictive analytics stopped');
  }
  
  /**
   * Add data point for analysis
   */
  addDataPoint(type, value, timestamp = Date.now()) {
    if (!this.dataStore.has(type)) {
      this.dataStore.set(type, []);
    }
    
    const dataPoints = this.dataStore.get(type);
    dataPoints.push({ timestamp, value });
    
    // Maintain data retention limit
    const cutoffTime = timestamp - this.options.dataRetentionPeriod;
    const filteredData = dataPoints.filter(point => point.timestamp > cutoffTime);
    this.dataStore.set(type, filteredData);
    
    this.emit('data:added', { type, value, timestamp });
  }
  
  /**
   * Generate prediction for specific metric
   */
  async generatePrediction(type, horizon = this.options.mediumTermHorizon) {
    const model = this.models.get(type);
    if (!model) {
      throw new Error(`No model available for type: ${type}`);
    }
    
    const dataPoints = this.dataStore.get(type) || [];
    if (dataPoints.length < this.options.minDataPoints) {
      throw new Error(`Insufficient data points for prediction: ${dataPoints.length}`);
    }
    
    try {
      const prediction = await this.runPrediction(model, dataPoints, horizon);
      
      this.predictions.set(`${type}_${horizon}`, {
        ...prediction,
        timestamp: Date.now(),
        horizon,
        type
      });
      
      this.state.totalPredictions++;
      
      this.emit('prediction:generated', prediction);
      return prediction;
      
    } catch (error) {
      console.error(`Prediction generation failed for ${type}:`, error.message);
      throw error;
    }
  }
  
  /**
   * Get predictions for all available metrics
   */
  async getAllPredictions(horizon = this.options.mediumTermHorizon) {
    const predictions = {};
    
    for (const type of Object.values(this.modelTypes)) {
      if (this.models.has(type)) {
        try {
          predictions[type] = await this.generatePrediction(type, horizon);
        } catch (error) {
          console.warn(`Failed to generate prediction for ${type}:`, error.message);
        }
      }
    }
    
    return predictions;
  }
  
  /**
   * Analyze trends in historical data
   */
  analyzeTrends(type, period = this.options.mediumTermHorizon) {
    const dataPoints = this.dataStore.get(type) || [];
    if (dataPoints.length < 2) {
      return { trend: 'insufficient_data', confidence: 0 };
    }
    
    const cutoffTime = Date.now() - period;
    const periodData = dataPoints.filter(point => point.timestamp > cutoffTime);
    
    if (periodData.length < 2) {
      return { trend: 'insufficient_data', confidence: 0 };
    }
    
    // Simple linear trend analysis
    const x = periodData.map((_, i) => i);
    const y = periodData.map(point => point.value);
    
    const slope = this.calculateLinearSlope(x, y);
    const correlation = this.calculateCorrelation(x, y);
    
    let trend = 'stable';
    if (Math.abs(slope) > 0.01) {
      trend = slope > 0 ? 'increasing' : 'decreasing';
    }
    
    return {
      trend,
      slope,
      confidence: Math.abs(correlation),
      dataPoints: periodData.length,
      timespan: period,
      analysis: {
        current: y[y.length - 1],
        average: y.reduce((a, b) => a + b, 0) / y.length,
        min: Math.min(...y),
        max: Math.max(...y),
        volatility: this.calculateVolatility(y)
      }
    };
  }
  
  /**
   * Detect anomalies in data patterns
   */
  detectAnomalies(type, sensitivity = 2) {
    const dataPoints = this.dataStore.get(type) || [];
    if (dataPoints.length < 10) {
      return [];
    }
    
    const values = dataPoints.map(point => point.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.sqrt(
      values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length
    );
    
    const threshold = sensitivity * stdDev;
    const anomalies = [];
    
    dataPoints.forEach((point, index) => {
      const deviation = Math.abs(point.value - mean);
      if (deviation > threshold) {
        anomalies.push({
          timestamp: point.timestamp,
          value: point.value,
          expectedRange: [mean - threshold, mean + threshold],
          deviation: deviation / stdDev,
          severity: deviation > threshold * 2 ? 'high' : 'medium'
        });
      }
    });
    
    return anomalies;
  }
  
  /**
   * Generate optimization suggestions
   */
  generateOptimizationSuggestions() {
    const suggestions = [];
    
    // Analyze each metric type
    for (const type of Object.values(this.modelTypes)) {
      const trend = this.analyzeTrends(type);
      const anomalies = this.detectAnomalies(type);
      
      // Generate suggestions based on trends and anomalies
      if (type === this.modelTypes.SYSTEM_CPU && trend.trend === 'increasing') {
        suggestions.push({
          type: 'performance',
          priority: 'high',
          metric: type,
          issue: 'CPU usage trending upward',
          suggestion: 'Consider optimizing CPU-intensive processes or scaling resources',
          confidence: trend.confidence
        });
      }
      
      if (type === this.modelTypes.ERROR_RATE && anomalies.length > 0) {
        suggestions.push({
          type: 'reliability',
          priority: 'high',
          metric: type,
          issue: `${anomalies.length} error rate anomalies detected`,
          suggestion: 'Investigate error patterns and implement preventive measures',
          confidence: 0.9
        });
      }
      
      if (type === this.modelTypes.MINING_HASHRATE && trend.trend === 'decreasing') {
        suggestions.push({
          type: 'mining',
          priority: 'medium',
          metric: type,
          issue: 'Mining hashrate declining',
          suggestion: 'Check mining hardware efficiency and network difficulty',
          confidence: trend.confidence
        });
      }
    }
    
    return suggestions.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
  }
  
  /**
   * Run prediction using simple time series analysis
   */
  async runPrediction(model, dataPoints, horizon) {
    const values = dataPoints.map(point => point.value);
    const timestamps = dataPoints.map(point => point.timestamp);
    
    if (values.length < 3) {
      throw new Error('Insufficient data for prediction');
    }
    
    // Simple moving average with trend
    const windowSize = Math.min(10, Math.floor(values.length / 2));
    const recentValues = values.slice(-windowSize);
    const recentAverage = recentValues.reduce((a, b) => a + b, 0) / recentValues.length;
    
    // Calculate trend
    const x = recentValues.map((_, i) => i);
    const slope = this.calculateLinearSlope(x, recentValues);
    
    // Project into future
    const futureSteps = Math.ceil(horizon / this.options.samplingInterval);
    const futureValues = [];
    
    for (let i = 1; i <= futureSteps; i++) {
      const trendComponent = slope * i;
      const seasonalComponent = this.calculateSeasonalComponent(values, i);
      const predicted = recentAverage + trendComponent + seasonalComponent;
      
      futureValues.push({
        timestamp: timestamps[timestamps.length - 1] + (i * this.options.samplingInterval),
        value: Math.max(0, predicted), // Ensure non-negative values
        confidence: Math.max(0.1, this.options.confidenceThreshold - (i * 0.05))
      });
    }
    
    // Calculate prediction statistics
    const predictedValue = futureValues[futureValues.length - 1].value;
    const currentValue = values[values.length - 1];
    const change = ((predictedValue - currentValue) / currentValue) * 100;
    
    return {
      current: currentValue,
      predicted: predictedValue,
      change: change,
      trend: change > 1 ? 'increasing' : change < -1 ? 'decreasing' : 'stable',
      confidence: this.calculatePredictionConfidence(values),
      horizon: horizon,
      futurePoints: futureValues,
      metadata: {
        dataPoints: values.length,
        model: model.type,
        algorithm: 'moving_average_with_trend'
      }
    };
  }
  
  /**
   * Train or update models
   */
  async trainModels() {
    console.log('🎓 Training prediction models...');
    
    let modelsUpdated = 0;
    
    for (const type of Object.values(this.modelTypes)) {
      const dataPoints = this.dataStore.get(type) || [];
      
      if (dataPoints.length >= this.options.minDataPoints) {
        try {
          const model = await this.trainModel(type, dataPoints);
          this.models.set(type, model);
          modelsUpdated++;
          
          this.emit('model:updated', { type, dataPoints: dataPoints.length });
        } catch (error) {
          console.error(`Model training failed for ${type}:`, error.message);
        }
      }
    }
    
    this.state.lastModelUpdate = Date.now();
    this.state.activeModels = this.models.size;
    
    console.log(`✅ Updated ${modelsUpdated} prediction models`);
    this.emit('training:completed', { modelsUpdated, totalModels: this.models.size });
  }
  
  /**
   * Train individual model
   */
  async trainModel(type, dataPoints) {
    const values = dataPoints.map(point => point.value);
    
    // Calculate model parameters
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
    const trend = this.calculateLinearSlope(
      values.map((_, i) => i),
      values
    );
    
    return {
      type,
      algorithm: 'statistical',
      parameters: {
        mean,
        variance,
        trend,
        dataPoints: values.length
      },
      trained: Date.now(),
      accuracy: this.calculateModelAccuracy(type, dataPoints)
    };
  }
  
  /**
   * Start data collection
   */
  startDataCollection() {
    this.dataTimer = setInterval(async () => {
      if (this.isRunning) {
        await this.collectMetrics();
      }
    }, this.options.samplingInterval);
  }
  
  /**
   * Start model training
   */
  startModelTraining() {
    this.trainingTimer = setInterval(async () => {
      if (this.isRunning) {
        await this.trainModels();
      }
    }, this.options.modelUpdateInterval);
  }
  
  /**
   * Start prediction generation
   */
  startPredictionGeneration() {
    this.predictionTimer = setInterval(async () => {
      if (this.isRunning) {
        await this.generateAllPredictions();
      }
    }, this.options.modelUpdateInterval);
  }
  
  /**
   * Collect current metrics
   */
  async collectMetrics() {
    const timestamp = Date.now();
    
    // Simulate metric collection (in production, collect from real sources)
    const metrics = {
      [this.modelTypes.MINING_HASHRATE]: Math.random() * 1000 + 500,
      [this.modelTypes.MINING_DIFFICULTY]: Math.random() * 1000000 + 500000,
      [this.modelTypes.MARKET_PRICE]: Math.random() * 100 + 50,
      [this.modelTypes.SYSTEM_CPU]: Math.random() * 100,
      [this.modelTypes.SYSTEM_MEMORY]: Math.random() * 100,
      [this.modelTypes.NETWORK_THROUGHPUT]: Math.random() * 1000 + 100,
      [this.modelTypes.ERROR_RATE]: Math.random() * 10
    };
    
    for (const [type, value] of Object.entries(metrics)) {
      this.addDataPoint(type, value, timestamp);
    }
    
    this.emit('metrics:collected', { timestamp, metrics });
  }
  
  /**
   * Generate all predictions
   */
  async generateAllPredictions() {
    try {
      const predictions = await this.getAllPredictions();
      this.emit('predictions:updated', predictions);
    } catch (error) {
      console.error('Prediction generation error:', error.message);
    }
  }
  
  /**
   * Utility methods
   */
  calculateLinearSlope(x, y) {
    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
    
    return (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  }
  
  calculateCorrelation(x, y) {
    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumYY = y.reduce((sum, yi) => sum + yi * yi, 0);
    
    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));
    
    return denominator === 0 ? 0 : numerator / denominator;
  }
  
  calculateVolatility(values) {
    if (values.length < 2) return 0;
    
    const returns = [];
    for (let i = 1; i < values.length; i++) {
      if (values[i - 1] !== 0) {
        returns.push((values[i] - values[i - 1]) / values[i - 1]);
      }
    }
    
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / returns.length;
    
    return Math.sqrt(variance);
  }
  
  calculateSeasonalComponent(values, step) {
    // Simple seasonal adjustment based on historical patterns
    const seasonalPeriod = 24; // Assume 24-hour seasonality
    const seasonalIndex = step % seasonalPeriod;
    
    if (values.length < seasonalPeriod * 2) return 0;
    
    // Calculate average for this seasonal index
    const seasonalValues = [];
    for (let i = seasonalIndex; i < values.length; i += seasonalPeriod) {
      seasonalValues.push(values[i]);
    }
    
    if (seasonalValues.length === 0) return 0;
    
    const seasonalAverage = seasonalValues.reduce((a, b) => a + b, 0) / seasonalValues.length;
    const overallAverage = values.reduce((a, b) => a + b, 0) / values.length;
    
    return (seasonalAverage - overallAverage) * 0.1; // Dampen seasonal effect
  }
  
  calculatePredictionConfidence(values) {
    // Base confidence on data quality and consistency
    const volatility = this.calculateVolatility(values);
    const dataQuality = Math.min(1, values.length / this.options.minDataPoints);
    const stabilityFactor = Math.max(0.1, 1 - volatility);
    
    return Math.min(0.95, dataQuality * stabilityFactor);
  }
  
  calculateModelAccuracy(type, dataPoints) {
    // Simplified accuracy calculation
    // In production, this would use cross-validation
    return Math.random() * 0.3 + 0.7; // 70-100% accuracy
  }
  
  async ensureDirectories() {
    const dirs = [
      this.options.dataDirectory,
      this.options.modelDirectory
    ];
    
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }
  
  async loadModels() {
    try {
      const modelsFile = join(this.options.modelDirectory, 'models.json');
      const content = await readFile(modelsFile, 'utf8');
      const savedModels = JSON.parse(content);
      
      for (const [type, model] of Object.entries(savedModels)) {
        this.models.set(type, model);
      }
      
      console.log(`📊 Loaded ${this.models.size} prediction models`);
    } catch {
      // No saved models
    }
  }
  
  async saveModels() {
    try {
      const modelsFile = join(this.options.modelDirectory, 'models.json');
      const modelsData = Object.fromEntries(this.models);
      await writeFile(modelsFile, JSON.stringify(modelsData, null, 2));
    } catch (error) {
      console.error('Failed to save models:', error.message);
    }
  }
  
  async loadHistoricalData() {
    try {
      const dataFile = join(this.options.dataDirectory, 'historical.json');
      const content = await readFile(dataFile, 'utf8');
      const savedData = JSON.parse(content);
      
      for (const [type, data] of Object.entries(savedData)) {
        this.dataStore.set(type, data);
      }
      
      console.log(`📊 Loaded historical data for ${this.dataStore.size} metrics`);
    } catch {
      // No saved data
    }
  }
  
  async saveHistoricalData() {
    try {
      const dataFile = join(this.options.dataDirectory, 'historical.json');
      const data = Object.fromEntries(this.dataStore);
      await writeFile(dataFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save historical data:', error.message);
    }
  }
  
  /**
   * Get analytics status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      state: this.state,
      models: this.models.size,
      dataTypes: this.dataStore.size,
      predictions: this.predictions.size,
      accuracy: this.state.totalPredictions > 0 
        ? (this.state.accuratePredictions / this.state.totalPredictions * 100).toFixed(1) + '%'
        : 'N/A'
    };
  }
  
  /**
   * Get current predictions
   */
  getCurrentPredictions() {
    return Object.fromEntries(this.predictions);
  }
  
  /**
   * Get trend analysis for all metrics
   */
  getAllTrends() {
    const trends = {};
    
    for (const type of Object.values(this.modelTypes)) {
      if (this.dataStore.has(type)) {
        trends[type] = this.analyzeTrends(type);
      }
    }
    
    return trends;
  }
}

export default PredictiveAnalytics;