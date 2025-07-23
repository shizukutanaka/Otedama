const EventEmitter = require('events');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

class RealTimeAnomalyDetectionSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      windowSize: options.windowSize || 1000, // samples
      updateInterval: options.updateInterval || 1000, // ms
      algorithms: options.algorithms || ['isolation-forest', 'lstm-autoencoder', 'one-class-svm', 'clustering'],
      sensitivity: options.sensitivity || 0.95,
      adaptiveLearning: options.adaptiveLearning !== false,
      multivariate: options.multivariate !== false,
      alertThreshold: options.alertThreshold || 3, // consecutive anomalies
      metrics: options.metrics || [
        'hashrate', 'shareRate', 'latency', 'errorRate', 'blockTime',
        'orphanRate', 'temperature', 'powerUsage', 'networkTraffic'
      ],
      correlationAnalysis: options.correlationAnalysis !== false,
      seasonalDecomposition: options.seasonalDecomposition !== false,
      realTimeVisualization: options.realTimeVisualization !== false
    };
    
    this.dataStreams = new Map();
    this.models = new Map();
    this.anomalyHistory = [];
    this.alertStates = new Map();
    this.correlationMatrix = null;
    this.seasonalPatterns = new Map();
    this.isRunning = false;
  }
  
  async initialize() {
    try {
      // Initialize data streams
      this.initializeDataStreams();
      
      // Load or train models
      await this.initializeModels();
      
      // Start real-time monitoring
      this.startMonitoring();
      
      this.emit('initialized', {
        algorithms: this.config.algorithms,
        metrics: this.config.metrics
      });
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  initializeDataStreams() {
    for (const metric of this.config.metrics) {
      this.dataStreams.set(metric, {
        buffer: [],
        statistics: {
          mean: 0,
          std: 1,
          min: Infinity,
          max: -Infinity,
          trend: 0
        },
        anomalyCount: 0,
        lastAnomaly: null
      });
    }
  }
  
  async initializeModels() {
    for (const algorithm of this.config.algorithms) {
      const model = await this.createModel(algorithm);
      this.models.set(algorithm, model);
    }
  }
  
  async createModel(algorithm) {
    switch (algorithm) {
      case 'isolation-forest':
        return new IsolationForest({
          numTrees: 100,
          sampleSize: 256,
          maxDepth: Math.ceil(Math.log2(256))
        });
        
      case 'lstm-autoencoder':
        return new LSTMAutoencoder({
          inputDim: this.config.metrics.length,
          hiddenDim: 64,
          latentDim: 16,
          sequenceLength: 50
        });
        
      case 'one-class-svm':
        return new OneClassSVM({
          kernel: 'rbf',
          gamma: 0.1,
          nu: 0.05
        });
        
      case 'clustering':
        return new ClusteringAnomalyDetector({
          algorithm: 'dbscan',
          eps: 0.3,
          minPoints: 5
        });
        
      default:
        throw new Error(`Unknown algorithm: ${algorithm}`);
    }
  }
  
  async processDataPoint(metric, value, timestamp = Date.now()) {
    const stream = this.dataStreams.get(metric);
    if (!stream) {
      throw new Error(`Unknown metric: ${metric}`);
    }
    
    // Add to buffer
    stream.buffer.push({ value, timestamp });
    
    // Maintain window size
    if (stream.buffer.length > this.config.windowSize) {
      stream.buffer.shift();
    }
    
    // Update statistics
    this.updateStatistics(stream);
    
    // Check for anomalies
    const anomalyScores = await this.detectAnomalies(metric, value, timestamp);
    
    // Process results
    const isAnomaly = this.evaluateAnomalyScores(anomalyScores);
    
    if (isAnomaly) {
      await this.handleAnomaly(metric, value, timestamp, anomalyScores);
    }
    
    return { metric, value, timestamp, isAnomaly, scores: anomalyScores };
  }
  
  updateStatistics(stream) {
    const values = stream.buffer.map(d => d.value);
    
    if (values.length === 0) return;
    
    // Calculate mean
    stream.statistics.mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    
    // Calculate standard deviation
    const variance = values.reduce((sum, val) => 
      sum + Math.pow(val - stream.statistics.mean, 2), 0) / values.length;
    stream.statistics.std = Math.sqrt(variance);
    
    // Update min/max
    stream.statistics.min = Math.min(...values);
    stream.statistics.max = Math.max(...values);
    
    // Calculate trend (simple linear regression)
    if (values.length > 10) {
      const n = values.length;
      const indices = Array.from({ length: n }, (_, i) => i);
      const sumX = indices.reduce((sum, x) => sum + x, 0);
      const sumY = values.reduce((sum, y) => sum + y, 0);
      const sumXY = indices.reduce((sum, x, i) => sum + x * values[i], 0);
      const sumX2 = indices.reduce((sum, x) => sum + x * x, 0);
      
      stream.statistics.trend = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    }
  }
  
  async detectAnomalies(metric, value, timestamp) {
    const scores = new Map();
    const stream = this.dataStreams.get(metric);
    
    // Get normalized value
    const normalizedValue = this.normalize(value, stream.statistics);
    
    // Run each algorithm
    for (const [algorithm, model] of this.models) {
      try {
        let score;
        
        switch (algorithm) {
          case 'isolation-forest':
            score = await this.detectIsolationForest(model, metric, normalizedValue);
            break;
            
          case 'lstm-autoencoder':
            score = await this.detectLSTMAutoencoder(model, metric, stream);
            break;
            
          case 'one-class-svm':
            score = await this.detectOneClassSVM(model, metric, normalizedValue);
            break;
            
          case 'clustering':
            score = await this.detectClustering(model, metric, stream);
            break;
        }
        
        scores.set(algorithm, score);
      } catch (error) {
        this.emit('warning', {
          algorithm,
          metric,
          error: error.message
        });
      }
    }
    
    // Add statistical anomaly detection
    const statisticalScore = this.detectStatisticalAnomaly(value, stream.statistics);
    scores.set('statistical', statisticalScore);
    
    // Add pattern-based detection
    if (this.config.seasonalDecomposition) {
      const seasonalScore = await this.detectSeasonalAnomaly(metric, value, timestamp);
      scores.set('seasonal', seasonalScore);
    }
    
    return scores;
  }
  
  normalize(value, statistics) {
    if (statistics.std === 0) return 0;
    return (value - statistics.mean) / statistics.std;
  }
  
  async detectIsolationForest(model, metric, value) {
    // Isolation Forest anomaly detection
    const pathLength = model.computePathLength(value);
    const expectedPathLength = model.getExpectedPathLength();
    const anomalyScore = Math.pow(2, -pathLength / expectedPathLength);
    
    return anomalyScore;
  }
  
  async detectLSTMAutoencoder(model, metric, stream) {
    // LSTM Autoencoder reconstruction error
    if (stream.buffer.length < model.sequenceLength) {
      return 0; // Not enough data
    }
    
    const sequence = stream.buffer
      .slice(-model.sequenceLength)
      .map(d => this.normalize(d.value, stream.statistics));
    
    const reconstruction = await model.reconstruct(sequence);
    const error = this.calculateReconstructionError(sequence, reconstruction);
    
    return error;
  }
  
  async detectOneClassSVM(model, metric, value) {
    // One-Class SVM decision function
    const decision = model.decisionFunction([value]);
    const anomalyScore = 1 / (1 + Math.exp(decision)); // Sigmoid transformation
    
    return anomalyScore;
  }
  
  async detectClustering(model, metric, stream) {
    // Clustering-based anomaly detection
    if (stream.buffer.length < 10) {
      return 0; // Not enough data
    }
    
    const recentValues = stream.buffer
      .slice(-10)
      .map(d => this.normalize(d.value, stream.statistics));
    
    const cluster = model.predict(recentValues[recentValues.length - 1]);
    const distance = model.getDistanceToCluster(recentValues[recentValues.length - 1], cluster);
    
    return distance / model.getMaxDistance();
  }
  
  detectStatisticalAnomaly(value, statistics) {
    // Z-score based detection
    const zScore = Math.abs(this.normalize(value, statistics));
    
    // Convert to anomaly score (0-1)
    return 1 - Math.exp(-zScore / 3);
  }
  
  async detectSeasonalAnomaly(metric, value, timestamp) {
    const pattern = this.seasonalPatterns.get(metric);
    if (!pattern) return 0;
    
    // Get expected value based on seasonal pattern
    const expectedValue = pattern.getExpectedValue(timestamp);
    const deviation = Math.abs(value - expectedValue);
    const normalizedDeviation = deviation / pattern.getStandardDeviation();
    
    return 1 - Math.exp(-normalizedDeviation / 2);
  }
  
  evaluateAnomalyScores(scores) {
    // Ensemble voting with weighted average
    const weights = {
      'isolation-forest': 0.25,
      'lstm-autoencoder': 0.3,
      'one-class-svm': 0.2,
      'clustering': 0.15,
      'statistical': 0.05,
      'seasonal': 0.05
    };
    
    let weightedSum = 0;
    let totalWeight = 0;
    
    for (const [algorithm, score] of scores) {
      const weight = weights[algorithm] || 0.1;
      weightedSum += score * weight;
      totalWeight += weight;
    }
    
    const ensembleScore = weightedSum / totalWeight;
    
    // Check if anomaly based on sensitivity threshold
    return ensembleScore > (1 - this.config.sensitivity);
  }
  
  async handleAnomaly(metric, value, timestamp, scores) {
    const stream = this.dataStreams.get(metric);
    stream.anomalyCount++;
    stream.lastAnomaly = { value, timestamp, scores };
    
    // Check alert state
    const alertKey = metric;
    let alertState = this.alertStates.get(alertKey) || { count: 0, firstSeen: null };
    
    alertState.count++;
    if (!alertState.firstSeen) {
      alertState.firstSeen = timestamp;
    }
    
    this.alertStates.set(alertKey, alertState);
    
    // Record anomaly
    const anomaly = {
      id: this.generateAnomalyId(),
      metric,
      value,
      timestamp,
      scores: Object.fromEntries(scores),
      severity: this.calculateSeverity(scores, stream),
      context: await this.gatherContext(metric, timestamp)
    };
    
    this.anomalyHistory.push(anomaly);
    
    // Emit anomaly event
    this.emit('anomaly', anomaly);
    
    // Check for alerts
    if (alertState.count >= this.config.alertThreshold) {
      await this.triggerAlert(metric, alertState, anomaly);
    }
    
    // Correlation analysis
    if (this.config.correlationAnalysis) {
      await this.analyzeCorrelations(anomaly);
    }
    
    // Adaptive learning
    if (this.config.adaptiveLearning) {
      await this.adaptModels(anomaly);
    }
  }
  
  calculateSeverity(scores, stream) {
    const maxScore = Math.max(...scores.values());
    const frequency = stream.anomalyCount / stream.buffer.length;
    
    if (maxScore > 0.9 && frequency > 0.1) return 'critical';
    if (maxScore > 0.8 || frequency > 0.05) return 'high';
    if (maxScore > 0.7 || frequency > 0.02) return 'medium';
    return 'low';
  }
  
  async gatherContext(metric, timestamp) {
    const context = {
      relatedMetrics: {},
      systemState: {},
      recentEvents: []
    };
    
    // Get values of related metrics at the same time
    for (const [otherMetric, stream] of this.dataStreams) {
      if (otherMetric !== metric) {
        const contemporaryData = stream.buffer.find(d => 
          Math.abs(d.timestamp - timestamp) < 1000
        );
        if (contemporaryData) {
          context.relatedMetrics[otherMetric] = contemporaryData.value;
        }
      }
    }
    
    // Get system state
    context.systemState = {
      totalAnomalies: this.anomalyHistory.length,
      activeAlerts: this.alertStates.size,
      uptime: Date.now() - this.startTime
    };
    
    // Get recent events
    context.recentEvents = this.anomalyHistory
      .filter(a => timestamp - a.timestamp < 60000) // Last minute
      .map(a => ({ metric: a.metric, severity: a.severity, timestamp: a.timestamp }));
    
    return context;
  }
  
  async triggerAlert(metric, alertState, anomaly) {
    const alert = {
      id: this.generateAlertId(),
      metric,
      severity: anomaly.severity,
      consecutiveAnomalies: alertState.count,
      duration: Date.now() - alertState.firstSeen,
      anomaly,
      recommendations: await this.generateRecommendations(metric, anomaly)
    };
    
    this.emit('alert', alert);
    
    // Reset alert state
    this.alertStates.delete(metric);
  }
  
  async generateRecommendations(metric, anomaly) {
    const recommendations = [];
    
    switch (metric) {
      case 'hashrate':
        if (anomaly.value < anomaly.context.systemState.averageHashrate * 0.8) {
          recommendations.push({
            action: 'investigate_miners',
            priority: 'high',
            description: 'Check miner connectivity and hardware status'
          });
        }
        break;
        
      case 'errorRate':
        if (anomaly.value > 0.05) {
          recommendations.push({
            action: 'system_diagnostics',
            priority: 'critical',
            description: 'Run system diagnostics and check logs'
          });
        }
        break;
        
      case 'temperature':
        if (anomaly.value > 85) {
          recommendations.push({
            action: 'cooling_check',
            priority: 'critical',
            description: 'Check cooling systems and reduce load if necessary'
          });
        }
        break;
    }
    
    // Add correlation-based recommendations
    if (anomaly.context.correlatedAnomalies) {
      recommendations.push({
        action: 'investigate_correlations',
        priority: 'medium',
        description: `Check related metrics: ${anomaly.context.correlatedAnomalies.join(', ')}`
      });
    }
    
    return recommendations;
  }
  
  async analyzeCorrelations(anomaly) {
    const correlatedAnomalies = [];
    const timeWindow = 5000; // 5 seconds
    
    // Find anomalies in other metrics around the same time
    for (const [metric, stream] of this.dataStreams) {
      if (metric === anomaly.metric) continue;
      
      if (stream.lastAnomaly && 
          Math.abs(stream.lastAnomaly.timestamp - anomaly.timestamp) < timeWindow) {
        correlatedAnomalies.push(metric);
      }
    }
    
    if (correlatedAnomalies.length > 0) {
      anomaly.context.correlatedAnomalies = correlatedAnomalies;
      
      // Update correlation matrix
      await this.updateCorrelationMatrix(anomaly.metric, correlatedAnomalies);
    }
  }
  
  async updateCorrelationMatrix(metric, correlatedMetrics) {
    if (!this.correlationMatrix) {
      this.correlationMatrix = new Map();
    }
    
    for (const correlatedMetric of correlatedMetrics) {
      const key = [metric, correlatedMetric].sort().join('_');
      const current = this.correlationMatrix.get(key) || 0;
      this.correlationMatrix.set(key, current + 1);
    }
  }
  
  async adaptModels(anomaly) {
    // Update models based on feedback
    if (anomaly.severity === 'low' && anomaly.feedback === 'false_positive') {
      // Reduce sensitivity for this pattern
      for (const [algorithm, model] of this.models) {
        if (model.adapt) {
          await model.adapt(anomaly, 'reduce_sensitivity');
        }
      }
    }
  }
  
  startMonitoring() {
    this.isRunning = true;
    this.startTime = Date.now();
    
    // Periodic model updates
    setInterval(() => {
      if (this.config.adaptiveLearning) {
        this.updateModels();
      }
    }, 60000); // Every minute
    
    // Seasonal pattern detection
    if (this.config.seasonalDecomposition) {
      setInterval(() => {
        this.updateSeasonalPatterns();
      }, 3600000); // Every hour
    }
    
    // Cleanup old data
    setInterval(() => {
      this.cleanupOldData();
    }, 300000); // Every 5 minutes
  }
  
  async updateModels() {
    for (const [metric, stream] of this.dataStreams) {
      if (stream.buffer.length < 100) continue;
      
      // Retrain models with recent data
      const trainingData = stream.buffer.map(d => ({
        value: this.normalize(d.value, stream.statistics),
        timestamp: d.timestamp
      }));
      
      for (const [algorithm, model] of this.models) {
        if (model.update) {
          await model.update(trainingData);
        }
      }
    }
  }
  
  async updateSeasonalPatterns() {
    for (const [metric, stream] of this.dataStreams) {
      if (stream.buffer.length < 1000) continue;
      
      const pattern = new SeasonalPattern();
      await pattern.fit(stream.buffer);
      this.seasonalPatterns.set(metric, pattern);
    }
  }
  
  cleanupOldData() {
    // Remove old anomalies
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours
    this.anomalyHistory = this.anomalyHistory.filter(a => a.timestamp > cutoff);
    
    // Clean alert states
    for (const [key, state] of this.alertStates) {
      if (Date.now() - state.firstSeen > 300000) { // 5 minutes
        this.alertStates.delete(key);
      }
    }
  }
  
  calculateReconstructionError(original, reconstruction) {
    let error = 0;
    for (let i = 0; i < original.length; i++) {
      error += Math.pow(original[i] - reconstruction[i], 2);
    }
    return Math.sqrt(error / original.length);
  }
  
  generateAnomalyId() {
    return crypto.randomBytes(8).toString('hex');
  }
  
  generateAlertId() {
    return crypto.randomBytes(8).toString('hex');
  }
  
  // Public API methods
  
  async feedData(metrics) {
    const results = [];
    
    for (const [metric, value] of Object.entries(metrics)) {
      const result = await this.processDataPoint(metric, value);
      results.push(result);
    }
    
    return results;
  }
  
  getAnomalyReport(timeRange = 3600000) { // Last hour by default
    const cutoff = Date.now() - timeRange;
    const recentAnomalies = this.anomalyHistory.filter(a => a.timestamp > cutoff);
    
    const report = {
      totalAnomalies: recentAnomalies.length,
      byMetric: {},
      bySeverity: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0
      },
      correlations: this.getTopCorrelations(),
      recommendations: []
    };
    
    // Count by metric and severity
    for (const anomaly of recentAnomalies) {
      report.byMetric[anomaly.metric] = (report.byMetric[anomaly.metric] || 0) + 1;
      report.bySeverity[anomaly.severity]++;
    }
    
    // Generate recommendations
    if (report.bySeverity.critical > 0) {
      report.recommendations.push({
        priority: 'critical',
        action: 'Immediate investigation required for critical anomalies'
      });
    }
    
    return report;
  }
  
  getTopCorrelations(limit = 5) {
    if (!this.correlationMatrix) return [];
    
    const correlations = Array.from(this.correlationMatrix.entries())
      .map(([key, count]) => {
        const [metric1, metric2] = key.split('_');
        return { metric1, metric2, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
    
    return correlations;
  }
  
  getRealTimeStatus() {
    const status = {
      running: this.isRunning,
      uptime: this.isRunning ? Date.now() - this.startTime : 0,
      metrics: {}
    };
    
    for (const [metric, stream] of this.dataStreams) {
      const current = stream.buffer[stream.buffer.length - 1];
      status.metrics[metric] = {
        currentValue: current ? current.value : null,
        statistics: stream.statistics,
        anomalyCount: stream.anomalyCount,
        lastAnomaly: stream.lastAnomaly
      };
    }
    
    return status;
  }
  
  async provideFeedback(anomalyId, feedback) {
    const anomaly = this.anomalyHistory.find(a => a.id === anomalyId);
    if (!anomaly) {
      throw new Error('Anomaly not found');
    }
    
    anomaly.feedback = feedback;
    
    // Use feedback for adaptive learning
    if (this.config.adaptiveLearning) {
      await this.adaptModels(anomaly);
    }
    
    return { success: true };
  }
}

// Model implementations (simplified)

class IsolationForest {
  constructor(config) {
    this.config = config;
    this.trees = [];
    this.buildForest();
  }
  
  buildForest() {
    // Build isolation trees
    for (let i = 0; i < this.config.numTrees; i++) {
      this.trees.push(new IsolationTree(this.config.maxDepth));
    }
  }
  
  computePathLength(value) {
    const pathLengths = this.trees.map(tree => tree.computePathLength(value));
    return pathLengths.reduce((sum, len) => sum + len, 0) / pathLengths.length;
  }
  
  getExpectedPathLength() {
    return 2 * (Math.log(this.config.sampleSize - 1) + 0.5772156649);
  }
}

class IsolationTree {
  constructor(maxDepth) {
    this.maxDepth = maxDepth;
    this.root = null;
  }
  
  computePathLength(value) {
    // Simplified path length computation
    return Math.random() * this.maxDepth;
  }
}

class LSTMAutoencoder {
  constructor(config) {
    this.config = config;
  }
  
  async reconstruct(sequence) {
    // Simplified reconstruction
    return sequence.map(v => v + (Math.random() - 0.5) * 0.1);
  }
  
  async update(data) {
    // Update model with new data
  }
}

class OneClassSVM {
  constructor(config) {
    this.config = config;
  }
  
  decisionFunction(values) {
    // Simplified decision function
    return Math.random() - 0.5;
  }
}

class ClusteringAnomalyDetector {
  constructor(config) {
    this.config = config;
    this.clusters = [];
  }
  
  predict(value) {
    // Find nearest cluster
    return 0;
  }
  
  getDistanceToCluster(value, cluster) {
    // Calculate distance
    return Math.random();
  }
  
  getMaxDistance() {
    return 1;
  }
}

class SeasonalPattern {
  constructor() {
    this.pattern = [];
    this.period = 0;
    this.std = 1;
  }
  
  async fit(data) {
    // Detect seasonal patterns
    this.period = 24; // Hourly pattern
    this.pattern = new Array(this.period).fill(0);
    this.std = 1;
  }
  
  getExpectedValue(timestamp) {
    const hour = new Date(timestamp).getHours();
    return this.pattern[hour % this.period];
  }
  
  getStandardDeviation() {
    return this.std;
  }
}

module.exports = RealTimeAnomalyDetectionSystem;