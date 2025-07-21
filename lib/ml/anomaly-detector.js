/**
 * Machine Learning-Based Anomaly Detection
 * 
 * Advanced anomaly detection using statistical methods, isolation forest,
 * and temporal pattern analysis for mining and trading operations
 */

import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../error-handler.js';

export class AnomalyDetector extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Detection parameters
      windowSize: options.windowSize || 100,
      threshold: options.threshold || 2.5,
      minSamples: options.minSamples || 20,
      contamination: options.contamination || 0.1,
      
      // Algorithm configuration
      enableStatisticalDetection: options.enableStatisticalDetection !== false,
      enableIsolationForest: options.enableIsolationForest !== false,
      enableTemporalAnalysis: options.enableTemporalAnalysis !== false,
      enableClusteringDetection: options.enableClusteringDetection !== false,
      
      // Model parameters
      maxTrees: options.maxTrees || 100,
      maxDepth: options.maxDepth || 8,
      subsampleSize: options.subsampleSize || 256,
      
      // Performance settings
      enableRealTimeDetection: options.enableRealTimeDetection !== false,
      batchSize: options.batchSize || 1000,
      updateInterval: options.updateInterval || 60000, // 1 minute
      
      // Feature engineering
      enableFeatureExtraction: options.enableFeatureExtraction !== false,
      temporalFeatures: options.temporalFeatures || ['moving_avg', 'volatility', 'trend'],
      statisticalFeatures: options.statisticalFeatures || ['zscore', 'iqr', 'mad'],
      
      // Storage and persistence
      modelDirectory: options.modelDirectory || './models/anomaly',
      enableModelPersistence: options.enableModelPersistence !== false,
      
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.isRunning = false;
    
    // Data storage
    this.timeSeries = new Map(); // metric_name -> array of values
    this.features = new Map(); // metric_name -> feature vectors
    this.models = new Map(); // metric_name -> trained models
    this.anomalies = new Map(); // metric_name -> detected anomalies
    
    // Algorithm implementations
    this.algorithms = {
      statistical: new StatisticalDetector(this.options),
      isolation_forest: new IsolationForest(this.options),
      temporal: new TemporalAnalyzer(this.options),
      clustering: new ClusteringDetector(this.options)
    };
    
    // Detection state
    this.state = {
      totalDetections: 0,
      confirmedAnomalies: 0,
      falsePositives: 0,
      lastUpdate: null,
      processedSamples: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize anomaly detector
   */
  async initialize() {
    try {
      await this.ensureDirectories();
      await this.loadModels();
      
      this.emit('initialized');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'anomaly-detector',
        category: ErrorCategory.INITIALIZATION
      });
    }
  }
  
  /**
   * Start anomaly detection
   */
  async start() {
    if (this.isRunning) {
      throw new OtedamaError('Anomaly detector already running', ErrorCategory.OPERATION);
    }
    
    console.log('🤖 Starting ML anomaly detection...');
    this.isRunning = true;
    
    // Start detection loops
    if (this.options.enableRealTimeDetection) {
      this.startRealTimeDetection();
    }
    
    this.startModelUpdater();
    
    this.emit('started');
    console.log('✅ Anomaly detection started successfully');
  }
  
  /**
   * Stop anomaly detection
   */
  async stop() {
    if (!this.isRunning) return;
    
    console.log('🛑 Stopping anomaly detection...');
    this.isRunning = false;
    
    // Save models
    if (this.options.enableModelPersistence) {
      await this.saveModels();
    }
    
    // Clear timers
    if (this.detectionTimer) clearInterval(this.detectionTimer);
    if (this.updateTimer) clearInterval(this.updateTimer);
    
    this.emit('stopped');
    console.log('✅ Anomaly detection stopped');
  }
  
  /**
   * Add data point for analysis
   */
  addDataPoint(metric, value, timestamp = Date.now(), metadata = {}) {
    if (!this.timeSeries.has(metric)) {
      this.timeSeries.set(metric, []);
    }
    
    const series = this.timeSeries.get(metric);
    series.push({
      value,
      timestamp,
      metadata
    });
    
    // Maintain window size
    if (series.length > this.options.windowSize * 2) {
      series.splice(0, series.length - this.options.windowSize);
    }
    
    this.state.processedSamples++;
    
    // Real-time detection
    if (this.options.enableRealTimeDetection && series.length >= this.options.minSamples) {
      this.detectAnomaliesRealTime(metric, value, timestamp);
    }
    
    this.emit('data:added', { metric, value, timestamp });
  }
  
  /**
   * Detect anomalies in real-time
   */
  async detectAnomaliesRealTime(metric, value, timestamp) {
    const series = this.timeSeries.get(metric);
    if (!series || series.length < this.options.minSamples) return;
    
    const startTime = performance.now();
    const anomalies = [];
    
    // Extract features for current point
    const features = await this.extractFeatures(metric, series.slice(-1)[0]);
    
    // Run detection algorithms
    for (const [algorithmName, algorithm] of Object.entries(this.algorithms)) {
      if (this.isAlgorithmEnabled(algorithmName)) {
        try {
          const result = await algorithm.detect(features, series);
          if (result.isAnomaly) {
            anomalies.push({
              algorithm: algorithmName,
              confidence: result.confidence,
              score: result.score,
              explanation: result.explanation
            });
          }
        } catch (error) {
          console.error(`Algorithm ${algorithmName} failed:`, error.message);
        }
      }
    }
    
    // Ensemble decision
    if (anomalies.length > 0) {
      const anomaly = this.combineDetections(anomalies, {
        metric,
        value,
        timestamp,
        features,
        detectionTime: performance.now() - startTime
      });
      
      await this.processAnomaly(anomaly);
    }
  }
  
  /**
   * Batch detect anomalies
   */
  async detectAnomaliesBatch(metric, timeRange = null) {
    const series = this.timeSeries.get(metric);
    if (!series || series.length < this.options.minSamples) {
      return [];
    }
    
    let dataPoints = series;
    if (timeRange) {
      dataPoints = series.filter(
        point => point.timestamp >= timeRange.start && point.timestamp <= timeRange.end
      );
    }
    
    const anomalies = [];
    
    // Extract features for all points
    const allFeatures = await this.extractFeaturesAll(metric, dataPoints);
    
    // Run batch detection
    for (const [algorithmName, algorithm] of Object.entries(this.algorithms)) {
      if (this.isAlgorithmEnabled(algorithmName)) {
        try {
          const results = await algorithm.detectBatch(allFeatures, dataPoints);
          
          for (let i = 0; i < results.length; i++) {
            if (results[i].isAnomaly) {
              anomalies.push({
                index: i,
                point: dataPoints[i],
                algorithm: algorithmName,
                confidence: results[i].confidence,
                score: results[i].score,
                explanation: results[i].explanation
              });
            }
          }
        } catch (error) {
          console.error(`Batch detection failed for ${algorithmName}:`, error.message);
        }
      }
    }
    
    // Group anomalies by data point
    const groupedAnomalies = this.groupAnomaliesByPoint(anomalies);
    
    return groupedAnomalies.map(group => this.combineDetections(group.anomalies, {
      metric,
      value: group.point.value,
      timestamp: group.point.timestamp,
      index: group.index
    }));
  }
  
  /**
   * Train models for specific metric
   */
  async trainModel(metric) {
    const series = this.timeSeries.get(metric);
    if (!series || series.length < this.options.minSamples * 2) {
      throw new Error(`Insufficient data for training: ${series?.length || 0} samples`);
    }
    
    console.log(`🎓 Training anomaly detection model for ${metric}...`);
    
    // Extract features for training
    const features = await this.extractFeaturesAll(metric, series);
    
    // Train each algorithm
    const models = {};
    for (const [algorithmName, algorithm] of Object.entries(this.algorithms)) {
      if (this.isAlgorithmEnabled(algorithmName)) {
        try {
          const model = await algorithm.train(features, series);
          models[algorithmName] = model;
          console.log(`✅ Trained ${algorithmName} model for ${metric}`);
        } catch (error) {
          console.error(`Failed to train ${algorithmName} for ${metric}:`, error.message);
        }
      }
    }
    
    this.models.set(metric, models);
    this.emit('model:trained', { metric, algorithms: Object.keys(models) });
    
    return models;
  }
  
  /**
   * Extract features from data points
   */
  async extractFeatures(metric, dataPoint) {
    const series = this.timeSeries.get(metric) || [];
    const features = {};
    
    if (this.options.enableFeatureExtraction) {
      // Statistical features
      for (const feature of this.options.statisticalFeatures) {
        features[feature] = this.calculateStatisticalFeature(feature, dataPoint, series);
      }
      
      // Temporal features
      for (const feature of this.options.temporalFeatures) {
        features[feature] = this.calculateTemporalFeature(feature, dataPoint, series);
      }
    }
    
    // Raw value
    features.value = dataPoint.value;
    features.timestamp = dataPoint.timestamp;
    
    return features;
  }
  
  /**
   * Extract features for all data points
   */
  async extractFeaturesAll(metric, dataPoints) {
    const allFeatures = [];
    
    for (let i = 0; i < dataPoints.length; i++) {
      const contextSeries = dataPoints.slice(0, i + 1);
      const features = await this.extractFeaturesWithContext(metric, dataPoints[i], contextSeries);
      allFeatures.push(features);
    }
    
    return allFeatures;
  }
  
  /**
   * Extract features with historical context
   */
  async extractFeaturesWithContext(metric, dataPoint, contextSeries) {
    const features = {};
    
    // Statistical features
    features.zscore = this.calculateZScore(dataPoint.value, contextSeries);
    features.iqr_position = this.calculateIQRPosition(dataPoint.value, contextSeries);
    features.mad_score = this.calculateMADScore(dataPoint.value, contextSeries);
    
    // Temporal features
    features.moving_avg_ratio = this.calculateMovingAverageRatio(dataPoint, contextSeries);
    features.volatility = this.calculateVolatility(contextSeries);
    features.trend = this.calculateTrend(contextSeries);
    
    // Time-based features
    const date = new Date(dataPoint.timestamp);
    features.hour_of_day = date.getHours() / 23;
    features.day_of_week = date.getDay() / 6;
    features.month = date.getMonth() / 11;
    
    return features;
  }
  
  /**
   * Calculate statistical features
   */
  calculateStatisticalFeature(feature, dataPoint, series) {
    const values = series.map(p => p.value);
    
    switch (feature) {
      case 'zscore':
        return this.calculateZScore(dataPoint.value, series);
      case 'iqr':
        return this.calculateIQRPosition(dataPoint.value, series);
      case 'mad':
        return this.calculateMADScore(dataPoint.value, series);
      default:
        return 0;
    }
  }
  
  /**
   * Calculate temporal features
   */
  calculateTemporalFeature(feature, dataPoint, series) {
    switch (feature) {
      case 'moving_avg':
        return this.calculateMovingAverageRatio(dataPoint, series);
      case 'volatility':
        return this.calculateVolatility(series);
      case 'trend':
        return this.calculateTrend(series);
      default:
        return 0;
    }
  }
  
  /**
   * Statistical calculations
   */
  calculateZScore(value, series) {
    if (series.length < 2) return 0;
    
    const values = series.map(p => p.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    
    return stdDev === 0 ? 0 : (value - mean) / stdDev;
  }
  
  calculateIQRPosition(value, series) {
    if (series.length < 4) return 0;
    
    const values = series.map(p => p.value).sort((a, b) => a - b);
    const q1 = values[Math.floor(values.length * 0.25)];
    const q3 = values[Math.floor(values.length * 0.75)];
    const iqr = q3 - q1;
    
    if (iqr === 0) return 0;
    
    if (value < q1) return (q1 - value) / iqr;
    if (value > q3) return (value - q3) / iqr;
    return 0;
  }
  
  calculateMADScore(value, series) {
    if (series.length < 2) return 0;
    
    const values = series.map(p => p.value);
    const median = this.calculateMedian(values);
    const deviations = values.map(v => Math.abs(v - median));
    const mad = this.calculateMedian(deviations);
    
    return mad === 0 ? 0 : Math.abs(value - median) / mad;
  }
  
  calculateMovingAverageRatio(dataPoint, series) {
    if (series.length < 5) return 1;
    
    const recent = series.slice(-5);
    const avg = recent.reduce((sum, p) => sum + p.value, 0) / recent.length;
    
    return avg === 0 ? 1 : dataPoint.value / avg;
  }
  
  calculateVolatility(series) {
    if (series.length < 2) return 0;
    
    const values = series.map(p => p.value);
    const returns = [];
    
    for (let i = 1; i < values.length; i++) {
      if (values[i - 1] !== 0) {
        returns.push((values[i] - values[i - 1]) / values[i - 1]);
      }
    }
    
    if (returns.length === 0) return 0;
    
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / returns.length;
    
    return Math.sqrt(variance);
  }
  
  calculateTrend(series) {
    if (series.length < 3) return 0;
    
    const values = series.map(p => p.value);
    const x = values.map((_, i) => i);
    const n = values.length;
    
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * values[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    
    return isNaN(slope) ? 0 : slope;
  }
  
  calculateMedian(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    } else {
      return sorted[mid];
    }
  }
  
  /**
   * Combine multiple detection results
   */
  combineDetections(detections, baseInfo) {
    if (detections.length === 0) return null;
    
    // Calculate ensemble confidence
    const avgConfidence = detections.reduce((sum, d) => sum + d.confidence, 0) / detections.length;
    const maxScore = Math.max(...detections.map(d => d.score));
    
    // Weight by algorithm reliability
    const weights = {
      statistical: 0.8,
      isolation_forest: 0.9,
      temporal: 0.7,
      clustering: 0.6
    };
    
    let weightedConfidence = 0;
    let totalWeight = 0;
    
    for (const detection of detections) {
      const weight = weights[detection.algorithm] || 0.5;
      weightedConfidence += detection.confidence * weight;
      totalWeight += weight;
    }
    
    const finalConfidence = totalWeight > 0 ? weightedConfidence / totalWeight : avgConfidence;
    
    return {
      ...baseInfo,
      isAnomaly: true,
      confidence: finalConfidence,
      score: maxScore,
      severity: this.calculateSeverity(finalConfidence, maxScore),
      algorithms: detections.map(d => d.algorithm),
      explanations: detections.map(d => d.explanation),
      detectionCount: detections.length
    };
  }
  
  calculateSeverity(confidence, score) {
    if (confidence > 0.9 && score > 3) return 'critical';
    if (confidence > 0.8 && score > 2.5) return 'high';
    if (confidence > 0.6 && score > 2) return 'medium';
    return 'low';
  }
  
  groupAnomaliesByPoint(anomalies) {
    const groups = new Map();
    
    for (const anomaly of anomalies) {
      const key = anomaly.index;
      if (!groups.has(key)) {
        groups.set(key, {
          index: key,
          point: anomaly.point,
          anomalies: []
        });
      }
      groups.get(key).anomalies.push(anomaly);
    }
    
    return Array.from(groups.values());
  }
  
  /**
   * Process detected anomaly
   */
  async processAnomaly(anomaly) {
    if (!this.anomalies.has(anomaly.metric)) {
      this.anomalies.set(anomaly.metric, []);
    }
    
    const metricAnomalies = this.anomalies.get(anomaly.metric);
    metricAnomalies.push(anomaly);
    
    // Keep only recent anomalies
    if (metricAnomalies.length > 1000) {
      metricAnomalies.splice(0, metricAnomalies.length - 1000);
    }
    
    this.state.totalDetections++;
    
    console.log(`🚨 Anomaly detected in ${anomaly.metric}: confidence ${(anomaly.confidence * 100).toFixed(1)}%, severity ${anomaly.severity}`);
    
    this.emit('anomaly:detected', anomaly);
  }
  
  /**
   * Start real-time detection
   */
  startRealTimeDetection() {
    this.detectionTimer = setInterval(() => {
      // Real-time detection is triggered by addDataPoint
      // This timer is for periodic cleanup and maintenance
      this.cleanupOldData();
    }, 60000); // Every minute
  }
  
  /**
   * Start model updater
   */
  startModelUpdater() {
    this.updateTimer = setInterval(async () => {
      if (this.isRunning) {
        await this.updateModels();
      }
    }, this.options.updateInterval);
  }
  
  /**
   * Update models with new data
   */
  async updateModels() {
    for (const metric of this.timeSeries.keys()) {
      const series = this.timeSeries.get(metric);
      if (series.length >= this.options.minSamples * 2) {
        try {
          await this.trainModel(metric);
        } catch (error) {
          console.error(`Failed to update model for ${metric}:`, error.message);
        }
      }
    }
    
    this.state.lastUpdate = Date.now();
  }
  
  /**
   * Utility methods
   */
  isAlgorithmEnabled(algorithmName) {
    const enabledMap = {
      statistical: this.options.enableStatisticalDetection,
      isolation_forest: this.options.enableIsolationForest,
      temporal: this.options.enableTemporalAnalysis,
      clustering: this.options.enableClusteringDetection
    };
    
    return enabledMap[algorithmName] !== false;
  }
  
  cleanupOldData() {
    const cutoffTime = Date.now() - (24 * 3600 * 1000); // 24 hours
    
    for (const [metric, series] of this.timeSeries.entries()) {
      const filtered = series.filter(point => point.timestamp > cutoffTime);
      this.timeSeries.set(metric, filtered);
    }
    
    for (const [metric, anomalies] of this.anomalies.entries()) {
      const filtered = anomalies.filter(anomaly => anomaly.timestamp > cutoffTime);
      this.anomalies.set(metric, filtered);
    }
  }
  
  async ensureDirectories() {
    await mkdir(this.options.modelDirectory, { recursive: true });
  }
  
  async loadModels() {
    try {
      const modelsFile = join(this.options.modelDirectory, 'models.json');
      const content = await readFile(modelsFile, 'utf8');
      const savedModels = JSON.parse(content);
      
      for (const [metric, models] of Object.entries(savedModels)) {
        this.models.set(metric, models);
      }
      
      console.log(`🤖 Loaded ${this.models.size} anomaly detection models`);
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
  
  /**
   * Get detector status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      state: this.state,
      metrics: this.timeSeries.size,
      models: this.models.size,
      totalAnomalies: Array.from(this.anomalies.values()).reduce((sum, arr) => sum + arr.length, 0),
      algorithms: Object.keys(this.algorithms).filter(name => this.isAlgorithmEnabled(name))
    };
  }
  
  /**
   * Get anomalies for specific metric
   */
  getAnomalies(metric, limit = 100) {
    const anomalies = this.anomalies.get(metric) || [];
    return anomalies.slice(-limit).reverse();
  }
  
  /**
   * Get all recent anomalies
   */
  getAllAnomalies(limit = 100) {
    const allAnomalies = [];
    
    for (const anomalies of this.anomalies.values()) {
      allAnomalies.push(...anomalies);
    }
    
    return allAnomalies
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }
}

/**
 * Simple Statistical Detector
 */
class StatisticalDetector {
  constructor(options) {
    this.options = options;
  }
  
  async detect(features, series) {
    const zscore = Math.abs(features.zscore || 0);
    const isAnomaly = zscore > this.options.threshold;
    
    return {
      isAnomaly,
      confidence: Math.min(1, zscore / this.options.threshold),
      score: zscore,
      explanation: `Z-score: ${zscore.toFixed(2)}`
    };
  }
  
  async detectBatch(allFeatures, dataPoints) {
    return allFeatures.map(features => this.detect(features, null));
  }
  
  async train(features, series) {
    const values = series.map(p => p.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    
    return {
      algorithm: 'statistical',
      mean,
      variance,
      threshold: this.options.threshold,
      trained: Date.now()
    };
  }
}

/**
 * Simple Isolation Forest Implementation
 */
class IsolationForest {
  constructor(options) {
    this.options = options;
    this.trees = [];
  }
  
  async detect(features, series) {
    // Simplified isolation forest detection
    const featureValues = Object.values(features).filter(v => typeof v === 'number');
    const score = this.calculateIsolationScore(featureValues);
    const isAnomaly = score > 0.6; // Threshold for isolation
    
    return {
      isAnomaly,
      confidence: score,
      score: score * 10,
      explanation: `Isolation score: ${score.toFixed(3)}`
    };
  }
  
  calculateIsolationScore(features) {
    // Simplified scoring - in production use proper isolation forest
    const normalized = features.map(f => Math.abs(f));
    const maxFeature = Math.max(...normalized);
    return Math.min(1, maxFeature / 5);
  }
  
  async detectBatch(allFeatures, dataPoints) {
    return allFeatures.map(features => this.detect(features, null));
  }
  
  async train(features, series) {
    return {
      algorithm: 'isolation_forest',
      trees: this.options.maxTrees,
      trained: Date.now()
    };
  }
}

/**
 * Simple Temporal Analyzer
 */
class TemporalAnalyzer {
  constructor(options) {
    this.options = options;
  }
  
  async detect(features, series) {
    const volatility = features.volatility || 0;
    const trend = Math.abs(features.trend || 0);
    
    const temporalScore = volatility * 2 + trend;
    const isAnomaly = temporalScore > 1.5;
    
    return {
      isAnomaly,
      confidence: Math.min(1, temporalScore / 2),
      score: temporalScore,
      explanation: `Temporal anomaly: volatility ${volatility.toFixed(3)}, trend ${trend.toFixed(3)}`
    };
  }
  
  async detectBatch(allFeatures, dataPoints) {
    return allFeatures.map(features => this.detect(features, null));
  }
  
  async train(features, series) {
    return {
      algorithm: 'temporal',
      trained: Date.now()
    };
  }
}

/**
 * Simple Clustering Detector
 */
class ClusteringDetector {
  constructor(options) {
    this.options = options;
  }
  
  async detect(features, series) {
    // Simplified clustering detection
    const featureValues = Object.values(features).filter(v => typeof v === 'number');
    const distance = this.calculateDistance(featureValues);
    const isAnomaly = distance > 3;
    
    return {
      isAnomaly,
      confidence: Math.min(1, distance / 5),
      score: distance,
      explanation: `Cluster distance: ${distance.toFixed(3)}`
    };
  }
  
  calculateDistance(features) {
    // Simplified distance calculation
    const magnitude = Math.sqrt(features.reduce((sum, f) => sum + f * f, 0));
    return magnitude;
  }
  
  async detectBatch(allFeatures, dataPoints) {
    return allFeatures.map(features => this.detect(features, null));
  }
  
  async train(features, series) {
    return {
      algorithm: 'clustering',
      trained: Date.now()
    };
  }
}

export default AnomalyDetector;