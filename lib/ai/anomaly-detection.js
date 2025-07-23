/**
 * AI-Powered Anomaly Detection System
 * Real-time detection of suspicious activities and security threats
 * 
 * Features:
 * - Machine learning models for pattern recognition
 * - Real-time anomaly scoring
 * - Adaptive learning from historical data
 * - Multi-dimensional analysis
 * - Automated threat response
 * - Alert prioritization
 * - False positive reduction
 * - Behavioral profiling
 */

const { EventEmitter } = require('events');
const tf = require('@tensorflow/tfjs-node');
const { createLogger } = require('../core/logger');

const logger = createLogger('anomaly-detection');

// Anomaly types
const AnomalyType = {
  MINING_PATTERN: 'mining_pattern',
  NETWORK_TRAFFIC: 'network_traffic',
  AUTHENTICATION: 'authentication',
  TRANSACTION: 'transaction',
  API_USAGE: 'api_usage',
  RESOURCE_USAGE: 'resource_usage',
  SHARE_VALIDATION: 'share_validation',
  PAYMENT_PATTERN: 'payment_pattern'
};

// Severity levels
const SeverityLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

// Detection models
const DetectionModel = {
  ISOLATION_FOREST: 'isolation_forest',
  AUTOENCODER: 'autoencoder',
  LSTM: 'lstm',
  ONE_CLASS_SVM: 'one_class_svm',
  STATISTICAL: 'statistical'
};

class DataNormalizer {
  constructor() {
    this.stats = new Map();
  }

  fit(data, features) {
    for (const feature of features) {
      const values = data.map(d => d[feature]).filter(v => v !== null && v !== undefined);
      
      if (values.length === 0) continue;
      
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
      const std = Math.sqrt(variance);
      
      this.stats.set(feature, { mean, std, min: Math.min(...values), max: Math.max(...values) });
    }
  }

  transform(data, features) {
    const normalized = [];
    
    for (const item of data) {
      const normalizedItem = {};
      
      for (const feature of features) {
        const value = item[feature];
        if (value === null || value === undefined) {
          normalizedItem[feature] = 0;
          continue;
        }
        
        const stats = this.stats.get(feature);
        if (!stats) {
          normalizedItem[feature] = value;
          continue;
        }
        
        // Z-score normalization
        if (stats.std > 0) {
          normalizedItem[feature] = (value - stats.mean) / stats.std;
        } else {
          normalizedItem[feature] = 0;
        }
      }
      
      normalized.push(normalizedItem);
    }
    
    return normalized;
  }

  inverseTransform(data, features) {
    const denormalized = [];
    
    for (const item of data) {
      const denormalizedItem = {};
      
      for (const feature of features) {
        const value = item[feature];
        const stats = this.stats.get(feature);
        
        if (!stats || stats.std === 0) {
          denormalizedItem[feature] = value;
          continue;
        }
        
        denormalizedItem[feature] = (value * stats.std) + stats.mean;
      }
      
      denormalized.push(denormalizedItem);
    }
    
    return denormalized;
  }
}

class IsolationForest {
  constructor(options = {}) {
    this.numTrees = options.numTrees || 100;
    this.sampleSize = options.sampleSize || 256;
    this.trees = [];
    this.threshold = options.threshold || 0.5;
  }

  async fit(data) {
    this.trees = [];
    
    for (let i = 0; i < this.numTrees; i++) {
      const sample = this.subsample(data, this.sampleSize);
      const tree = await this.buildTree(sample);
      this.trees.push(tree);
    }
  }

  async predict(data) {
    const scores = [];
    
    for (const point of data) {
      let totalPathLength = 0;
      
      for (const tree of this.trees) {
        const pathLength = await this.getPathLength(point, tree);
        totalPathLength += pathLength;
      }
      
      const avgPathLength = totalPathLength / this.trees.length;
      const score = this.anomalyScore(avgPathLength, this.sampleSize);
      scores.push(score);
    }
    
    return scores;
  }

  subsample(data, size) {
    const shuffled = [...data].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(size, data.length));
  }

  async buildTree(data, depth = 0, maxDepth = 10) {
    if (data.length <= 1 || depth >= maxDepth) {
      return { type: 'leaf', size: data.length };
    }
    
    // Random split
    const features = Object.keys(data[0]);
    const splitFeature = features[Math.floor(Math.random() * features.length)];
    const values = data.map(d => d[splitFeature]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    
    if (min === max) {
      return { type: 'leaf', size: data.length };
    }
    
    const splitValue = min + Math.random() * (max - min);
    
    const left = data.filter(d => d[splitFeature] < splitValue);
    const right = data.filter(d => d[splitFeature] >= splitValue);
    
    return {
      type: 'node',
      feature: splitFeature,
      value: splitValue,
      left: await this.buildTree(left, depth + 1, maxDepth),
      right: await this.buildTree(right, depth + 1, maxDepth)
    };
  }

  async getPathLength(point, tree, depth = 0) {
    if (tree.type === 'leaf') {
      return depth + this.c(tree.size);
    }
    
    if (point[tree.feature] < tree.value) {
      return await this.getPathLength(point, tree.left, depth + 1);
    } else {
      return await this.getPathLength(point, tree.right, depth + 1);
    }
  }

  c(n) {
    if (n <= 1) return 0;
    return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1) / n);
  }

  anomalyScore(pathLength, n) {
    return Math.pow(2, -pathLength / this.c(n));
  }
}

class AutoencoderModel {
  constructor(options = {}) {
    this.inputDim = options.inputDim || 10;
    this.encodingDim = options.encodingDim || 3;
    this.epochs = options.epochs || 50;
    this.batchSize = options.batchSize || 32;
    this.threshold = options.threshold || 0.1;
    this.model = null;
  }

  async build() {
    // Encoder
    const encoder = tf.sequential({
      layers: [
        tf.layers.dense({
          inputShape: [this.inputDim],
          units: Math.floor(this.inputDim * 0.75),
          activation: 'relu'
        }),
        tf.layers.dense({
          units: Math.floor(this.inputDim * 0.5),
          activation: 'relu'
        }),
        tf.layers.dense({
          units: this.encodingDim,
          activation: 'relu'
        })
      ]
    });
    
    // Decoder
    const decoder = tf.sequential({
      layers: [
        tf.layers.dense({
          inputShape: [this.encodingDim],
          units: Math.floor(this.inputDim * 0.5),
          activation: 'relu'
        }),
        tf.layers.dense({
          units: Math.floor(this.inputDim * 0.75),
          activation: 'relu'
        }),
        tf.layers.dense({
          units: this.inputDim,
          activation: 'sigmoid'
        })
      ]
    });
    
    // Combined model
    const input = tf.input({ shape: [this.inputDim] });
    const encoded = encoder.apply(input);
    const decoded = decoder.apply(encoded);
    
    this.model = tf.model({ inputs: input, outputs: decoded });
    
    this.model.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'meanSquaredError'
    });
  }

  async fit(data) {
    if (!this.model) {
      await this.build();
    }
    
    const tensor = tf.tensor2d(data);
    
    await this.model.fit(tensor, tensor, {
      epochs: this.epochs,
      batchSize: this.batchSize,
      shuffle: true,
      verbose: 0
    });
    
    tensor.dispose();
  }

  async predict(data) {
    const tensor = tf.tensor2d(data);
    const predictions = this.model.predict(tensor);
    const reconstructionErrors = await this.calculateReconstructionError(tensor, predictions);
    
    tensor.dispose();
    predictions.dispose();
    
    return reconstructionErrors.map(error => error > this.threshold ? 1 : 0);
  }

  async calculateReconstructionError(original, reconstructed) {
    const mse = tf.losses.meanSquaredError(original, reconstructed, 1);
    const errors = await mse.array();
    mse.dispose();
    return errors;
  }
}

class StatisticalDetector {
  constructor(options = {}) {
    this.windowSize = options.windowSize || 100;
    this.zThreshold = options.zThreshold || 3;
    this.iqrMultiplier = options.iqrMultiplier || 1.5;
    this.history = new Map();
  }

  addDataPoint(feature, value) {
    if (!this.history.has(feature)) {
      this.history.set(feature, []);
    }
    
    const history = this.history.get(feature);
    history.push(value);
    
    if (history.length > this.windowSize) {
      history.shift();
    }
  }

  detectAnomaly(feature, value) {
    const history = this.history.get(feature);
    if (!history || history.length < 10) {
      return { isAnomaly: false, score: 0 };
    }
    
    // Z-score method
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const variance = history.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / history.length;
    const std = Math.sqrt(variance);
    
    if (std === 0) {
      return { isAnomaly: value !== mean, score: value !== mean ? 1 : 0 };
    }
    
    const zScore = Math.abs((value - mean) / std);
    
    // IQR method
    const sorted = [...history].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    
    const lowerBound = q1 - (this.iqrMultiplier * iqr);
    const upperBound = q3 + (this.iqrMultiplier * iqr);
    
    const isOutlierZ = zScore > this.zThreshold;
    const isOutlierIQR = value < lowerBound || value > upperBound;
    
    return {
      isAnomaly: isOutlierZ || isOutlierIQR,
      score: Math.min(zScore / this.zThreshold, 1),
      method: isOutlierZ ? 'z-score' : isOutlierIQR ? 'iqr' : 'none'
    };
  }

  getStatistics(feature) {
    const history = this.history.get(feature);
    if (!history || history.length === 0) {
      return null;
    }
    
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const sorted = [...history].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    
    return { mean, median, min, max, count: history.length };
  }
}

class BehavioralProfile {
  constructor(entityId, type) {
    this.entityId = entityId;
    this.type = type;
    this.features = new Map();
    this.anomalyHistory = [];
    this.trustScore = 1.0;
    this.lastUpdated = Date.now();
  }

  updateFeature(feature, value) {
    if (!this.features.has(feature)) {
      this.features.set(feature, {
        values: [],
        mean: 0,
        std: 0,
        min: Infinity,
        max: -Infinity
      });
    }
    
    const featureData = this.features.get(feature);
    featureData.values.push(value);
    
    // Keep only recent values
    if (featureData.values.length > 1000) {
      featureData.values.shift();
    }
    
    // Update statistics
    this.updateStatistics(feature);
    this.lastUpdated = Date.now();
  }

  updateStatistics(feature) {
    const featureData = this.features.get(feature);
    const values = featureData.values;
    
    if (values.length === 0) return;
    
    featureData.mean = values.reduce((a, b) => a + b, 0) / values.length;
    featureData.min = Math.min(...values);
    featureData.max = Math.max(...values);
    
    const variance = values.reduce((sum, val) => 
      sum + Math.pow(val - featureData.mean, 2), 0
    ) / values.length;
    
    featureData.std = Math.sqrt(variance);
  }

  recordAnomaly(anomaly) {
    this.anomalyHistory.push({
      timestamp: Date.now(),
      ...anomaly
    });
    
    // Keep only recent anomalies
    const cutoff = Date.now() - 86400000; // 24 hours
    this.anomalyHistory = this.anomalyHistory.filter(a => a.timestamp > cutoff);
    
    // Update trust score
    this.updateTrustScore();
  }

  updateTrustScore() {
    // Decay factor based on anomaly frequency
    const recentAnomalies = this.anomalyHistory.filter(a => 
      Date.now() - a.timestamp < 3600000 // Last hour
    ).length;
    
    const decay = Math.exp(-recentAnomalies * 0.1);
    this.trustScore = Math.max(0.1, Math.min(1.0, this.trustScore * decay));
    
    // Slowly recover trust over time
    const timeSinceLastAnomaly = this.anomalyHistory.length > 0
      ? Date.now() - this.anomalyHistory[this.anomalyHistory.length - 1].timestamp
      : Infinity;
      
    if (timeSinceLastAnomaly > 3600000) { // 1 hour
      this.trustScore = Math.min(1.0, this.trustScore * 1.01);
    }
  }

  getDeviationScore(feature, value) {
    const featureData = this.features.get(feature);
    if (!featureData || featureData.values.length < 10) {
      return 0;
    }
    
    if (featureData.std === 0) {
      return value !== featureData.mean ? 1 : 0;
    }
    
    const zScore = Math.abs((value - featureData.mean) / featureData.std);
    return Math.min(zScore / 3, 1); // Normalize to [0, 1]
  }

  toJSON() {
    const features = {};
    for (const [key, data] of this.features) {
      features[key] = {
        mean: data.mean,
        std: data.std,
        min: data.min,
        max: data.max,
        count: data.values.length
      };
    }
    
    return {
      entityId: this.entityId,
      type: this.type,
      features,
      trustScore: this.trustScore,
      anomalyCount: this.anomalyHistory.length,
      lastUpdated: this.lastUpdated
    };
  }
}

class AnomalyDetectionSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      enabled: options.enabled !== false,
      models: options.models || [DetectionModel.STATISTICAL, DetectionModel.ISOLATION_FOREST],
      updateInterval: options.updateInterval || 60000, // 1 minute
      trainingInterval: options.trainingInterval || 3600000, // 1 hour
      anomalyThreshold: options.anomalyThreshold || 0.7,
      alertThreshold: options.alertThreshold || 0.8,
      maxProfiles: options.maxProfiles || 10000,
      features: options.features || {
        mining: ['hashrate', 'shareRate', 'invalidRate', 'difficulty'],
        network: ['requestRate', 'bandwidth', 'latency', 'errorRate'],
        auth: ['loginAttempts', 'failedLogins', 'sessionDuration', 'ipChanges'],
        transaction: ['amount', 'frequency', 'gasPrice', 'slippage']
      },
      ...options
    };
    
    this.models = new Map();
    this.profiles = new Map();
    this.normalizer = new DataNormalizer();
    this.trainingData = [];
    this.detectionStats = {
      totalDetections: 0,
      anomaliesDetected: 0,
      falsePositives: 0,
      truePositives: 0,
      alertsGenerated: 0
    };
    
    this.initialize();
  }

  async initialize() {
    // Initialize models
    for (const modelType of this.config.models) {
      await this.initializeModel(modelType);
    }
    
    // Start periodic updates
    if (this.config.enabled) {
      this.startPeriodicUpdates();
    }
    
    logger.info('Anomaly detection system initialized', {
      models: this.config.models,
      features: Object.keys(this.config.features)
    });
  }

  async initializeModel(modelType) {
    switch (modelType) {
      case DetectionModel.ISOLATION_FOREST:
        this.models.set(modelType, new IsolationForest({
          numTrees: 100,
          sampleSize: 256
        }));
        break;
        
      case DetectionModel.AUTOENCODER:
        const inputDim = Object.values(this.config.features).flat().length;
        this.models.set(modelType, new AutoencoderModel({
          inputDim,
          encodingDim: Math.max(3, Math.floor(inputDim / 3))
        }));
        break;
        
      case DetectionModel.STATISTICAL:
        this.models.set(modelType, new StatisticalDetector({
          windowSize: 100,
          zThreshold: 3
        }));
        break;
    }
  }

  startPeriodicUpdates() {
    // Detection interval
    this.detectionInterval = setInterval(() => {
      this.performDetection();
    }, this.config.updateInterval);
    
    // Training interval
    this.trainingInterval = setInterval(() => {
      this.trainModels();
    }, this.config.trainingInterval);
  }

  async detect(entityId, type, data) {
    // Get or create profile
    const profileKey = `${type}:${entityId}`;
    if (!this.profiles.has(profileKey)) {
      this.profiles.set(profileKey, new BehavioralProfile(entityId, type));
    }
    
    const profile = this.profiles.get(profileKey);
    
    // Update profile with new data
    for (const [feature, value] of Object.entries(data)) {
      profile.updateFeature(feature, value);
    }
    
    // Prepare features for detection
    const features = this.config.features[type] || [];
    const featureVector = features.map(f => data[f] || 0);
    
    // Run detection models
    const anomalyScores = await this.runDetectionModels(type, featureVector, data);
    
    // Calculate combined score
    const combinedScore = this.calculateCombinedScore(anomalyScores);
    
    // Check for anomaly
    const isAnomaly = combinedScore > this.config.anomalyThreshold;
    const severity = this.calculateSeverity(combinedScore, profile.trustScore);
    
    if (isAnomaly) {
      const anomaly = {
        entityId,
        type,
        score: combinedScore,
        severity,
        data,
        models: anomalyScores,
        timestamp: Date.now()
      };
      
      profile.recordAnomaly(anomaly);
      this.handleAnomaly(anomaly, profile);
    }
    
    // Store for training
    this.addTrainingData(type, data, isAnomaly);
    
    return {
      isAnomaly,
      score: combinedScore,
      severity,
      trustScore: profile.trustScore
    };
  }

  async runDetectionModels(type, featureVector, rawData) {
    const scores = new Map();
    
    for (const [modelType, model] of this.models) {
      try {
        let score = 0;
        
        switch (modelType) {
          case DetectionModel.ISOLATION_FOREST:
            const isoScores = await model.predict([featureVector]);
            score = isoScores[0];
            break;
            
          case DetectionModel.AUTOENCODER:
            if (model.model) {
              const aeScores = await model.predict([featureVector]);
              score = aeScores[0];
            }
            break;
            
          case DetectionModel.STATISTICAL:
            const features = this.config.features[type] || [];
            let totalScore = 0;
            let count = 0;
            
            for (const feature of features) {
              if (rawData[feature] !== undefined) {
                const result = model.detectAnomaly(feature, rawData[feature]);
                totalScore += result.score;
                count++;
                model.addDataPoint(feature, rawData[feature]);
              }
            }
            
            score = count > 0 ? totalScore / count : 0;
            break;
        }
        
        scores.set(modelType, score);
      } catch (error) {
        logger.error(`Model ${modelType} detection failed:`, error);
      }
    }
    
    return scores;
  }

  calculateCombinedScore(modelScores) {
    if (modelScores.size === 0) return 0;
    
    // Weighted average with emphasis on agreement
    let totalScore = 0;
    let totalWeight = 0;
    
    for (const [model, score] of modelScores) {
      const weight = this.getModelWeight(model);
      totalScore += score * weight;
      totalWeight += weight;
    }
    
    const avgScore = totalWeight > 0 ? totalScore / totalWeight : 0;
    
    // Agreement bonus - if multiple models agree, increase confidence
    const scores = Array.from(modelScores.values());
    const variance = this.calculateVariance(scores);
    const agreementBonus = variance < 0.1 ? 0.1 : 0;
    
    return Math.min(1, avgScore + agreementBonus);
  }

  getModelWeight(modelType) {
    // Weights can be adjusted based on model performance
    const weights = {
      [DetectionModel.ISOLATION_FOREST]: 0.3,
      [DetectionModel.AUTOENCODER]: 0.4,
      [DetectionModel.STATISTICAL]: 0.2,
      [DetectionModel.LSTM]: 0.35,
      [DetectionModel.ONE_CLASS_SVM]: 0.25
    };
    
    return weights[modelType] || 0.2;
  }

  calculateVariance(values) {
    if (values.length === 0) return 0;
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  }

  calculateSeverity(anomalyScore, trustScore) {
    const severityScore = anomalyScore * (2 - trustScore);
    
    if (severityScore >= 0.9) return SeverityLevel.CRITICAL;
    if (severityScore >= 0.7) return SeverityLevel.HIGH;
    if (severityScore >= 0.5) return SeverityLevel.MEDIUM;
    return SeverityLevel.LOW;
  }

  handleAnomaly(anomaly, profile) {
    this.detectionStats.anomaliesDetected++;
    
    logger.warn('Anomaly detected', {
      entityId: anomaly.entityId,
      type: anomaly.type,
      score: anomaly.score,
      severity: anomaly.severity
    });
    
    // Emit anomaly event
    this.emit('anomaly:detected', anomaly);
    
    // Generate alert if threshold exceeded
    if (anomaly.score > this.config.alertThreshold) {
      this.generateAlert(anomaly, profile);
    }
    
    // Take automated action for critical anomalies
    if (anomaly.severity === SeverityLevel.CRITICAL) {
      this.takeAutomatedAction(anomaly, profile);
    }
  }

  generateAlert(anomaly, profile) {
    this.detectionStats.alertsGenerated++;
    
    const alert = {
      id: crypto.randomBytes(16).toString('hex'),
      anomaly,
      profile: profile.toJSON(),
      timestamp: Date.now(),
      actions: this.suggestActions(anomaly)
    };
    
    logger.error('Security alert generated', alert);
    this.emit('alert:generated', alert);
  }

  suggestActions(anomaly) {
    const actions = [];
    
    switch (anomaly.type) {
      case AnomalyType.MINING_PATTERN:
        actions.push('Review mining statistics');
        actions.push('Check for potential mining attacks');
        actions.push('Verify miner identity');
        break;
        
      case AnomalyType.AUTHENTICATION:
        actions.push('Review authentication logs');
        actions.push('Check for brute force attempts');
        actions.push('Consider temporary IP ban');
        break;
        
      case AnomalyType.TRANSACTION:
        actions.push('Review transaction details');
        actions.push('Check for unusual patterns');
        actions.push('Verify fund sources');
        break;
        
      case AnomalyType.API_USAGE:
        actions.push('Review API access logs');
        actions.push('Check rate limiting');
        actions.push('Verify API key usage');
        break;
    }
    
    return actions;
  }

  takeAutomatedAction(anomaly, profile) {
    logger.info('Taking automated action for critical anomaly', {
      entityId: anomaly.entityId,
      type: anomaly.type
    });
    
    // Emit action event for other systems to handle
    this.emit('action:required', {
      anomaly,
      profile: profile.toJSON(),
      suggestedActions: this.suggestActions(anomaly)
    });
  }

  addTrainingData(type, data, isAnomaly) {
    this.trainingData.push({
      type,
      data,
      isAnomaly,
      timestamp: Date.now()
    });
    
    // Keep only recent data
    const cutoff = Date.now() - 86400000 * 7; // 7 days
    this.trainingData = this.trainingData.filter(d => d.timestamp > cutoff);
  }

  async trainModels() {
    logger.info('Starting model training');
    
    for (const type of Object.keys(this.config.features)) {
      const typeData = this.trainingData.filter(d => d.type === type && !d.isAnomaly);
      
      if (typeData.length < 100) {
        logger.debug(`Insufficient training data for ${type}`);
        continue;
      }
      
      const features = this.config.features[type];
      const trainingVectors = typeData.map(d => 
        features.map(f => d.data[f] || 0)
      );
      
      // Normalize data
      this.normalizer.fit(trainingVectors, features);
      const normalized = this.normalizer.transform(trainingVectors, features);
      
      // Train each model
      for (const [modelType, model] of this.models) {
        try {
          if (model.fit) {
            await model.fit(normalized);
            logger.info(`Trained ${modelType} model for ${type}`);
          }
        } catch (error) {
          logger.error(`Failed to train ${modelType}:`, error);
        }
      }
    }
  }

  getStatistics() {
    const profileStats = {};
    for (const [key, profile] of this.profiles) {
      profileStats[key] = profile.toJSON();
    }
    
    return {
      ...this.detectionStats,
      models: Array.from(this.models.keys()),
      profiles: this.profiles.size,
      trainingDataSize: this.trainingData.length,
      detectionRate: this.detectionStats.totalDetections > 0
        ? this.detectionStats.anomaliesDetected / this.detectionStats.totalDetections
        : 0,
      topAnomalousEntities: this.getTopAnomalousEntities()
    };
  }

  getTopAnomalousEntities(limit = 10) {
    const entities = Array.from(this.profiles.entries())
      .map(([key, profile]) => ({
        key,
        entityId: profile.entityId,
        type: profile.type,
        anomalyCount: profile.anomalyHistory.length,
        trustScore: profile.trustScore
      }))
      .sort((a, b) => b.anomalyCount - a.anomalyCount)
      .slice(0, limit);
      
    return entities;
  }

  getProfile(entityId, type) {
    const profileKey = `${type}:${entityId}`;
    return this.profiles.get(profileKey);
  }

  clearProfile(entityId, type) {
    const profileKey = `${type}:${entityId}`;
    this.profiles.delete(profileKey);
  }

  stop() {
    if (this.detectionInterval) {
      clearInterval(this.detectionInterval);
    }
    
    if (this.trainingInterval) {
      clearInterval(this.trainingInterval);
    }
    
    this.removeAllListeners();
    logger.info('Anomaly detection system stopped');
  }
}

module.exports = {
  AnomalyDetectionSystem,
  AnomalyType,
  SeverityLevel,
  DetectionModel
};