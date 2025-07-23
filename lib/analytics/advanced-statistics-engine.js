const EventEmitter = require('events');
const crypto = require('crypto');

class AdvancedStatisticsEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Analysis settings
      analysisInterval: options.analysisInterval || 60000, // 1 minute
      dataRetentionDays: options.dataRetentionDays || 90,
      
      // Statistical methods
      enablePredictiveAnalytics: options.enablePredictiveAnalytics !== false,
      enableAnomalyDetection: options.enableAnomalyDetection !== false,
      enablePatternRecognition: options.enablePatternRecognition !== false,
      enableCorrelationAnalysis: options.enableCorrelationAnalysis !== false,
      
      // Machine learning
      enableML: options.enableML !== false,
      mlModelUpdateInterval: options.mlModelUpdateInterval || 3600000, // 1 hour
      
      // Thresholds
      anomalyThreshold: options.anomalyThreshold || 3, // 3 standard deviations
      confidenceLevel: options.confidenceLevel || 0.95,
      
      // Performance
      maxDataPoints: options.maxDataPoints || 1000000,
      compressionEnabled: options.compressionEnabled !== false
    };
    
    // Data storage
    this.timeSeries = new Map();
    this.aggregatedData = new Map();
    this.predictions = new Map();
    this.anomalies = [];
    this.patterns = new Map();
    
    // ML models
    this.models = {
      hashratePrediction: null,
      profitabilityForecast: null,
      anomalyDetector: null,
      patternClassifier: null
    };
    
    // Statistics cache
    this.statsCache = new Map();
    this.correlationMatrix = null;
    
    // Initialize components
    this.initializeDataStructures();
  }
  
  async initialize() {
    this.emit('initializing');
    
    try {
      // Load historical data
      await this.loadHistoricalData();
      
      // Initialize ML models
      if (this.config.enableML) {
        await this.initializeMLModels();
      }
      
      // Start analysis cycles
      this.startAnalysisCycles();
      
      this.emit('initialized');
      
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  initializeDataStructures() {
    // Time series categories
    const categories = [
      'hashrate',
      'difficulty',
      'shares',
      'blocks',
      'earnings',
      'workers',
      'efficiency',
      'temperature',
      'power',
      'latency',
      'errors',
      'uptime'
    ];
    
    for (const category of categories) {
      this.timeSeries.set(category, {
        data: [],
        metadata: {
          unit: this.getUnitForCategory(category),
          aggregationMethod: this.getAggregationMethod(category)
        }
      });
    }
  }
  
  // Data Collection
  
  async recordMetric(category, value, timestamp = Date.now(), metadata = {}) {
    const series = this.timeSeries.get(category);
    if (!series) {
      throw new Error(`Unknown metric category: ${category}`);
    }
    
    // Add data point
    const dataPoint = {
      timestamp,
      value,
      metadata
    };
    
    series.data.push(dataPoint);
    
    // Maintain data limit
    if (series.data.length > this.config.maxDataPoints) {
      // Compress old data
      if (this.config.compressionEnabled) {
        await this.compressOldData(category);
      } else {
        series.data.shift();
      }
    }
    
    // Real-time analysis
    if (this.config.enableAnomalyDetection) {
      await this.detectAnomaly(category, value, timestamp);
    }
    
    // Clear cache for this category
    this.statsCache.delete(category);
    
    this.emit('metric:recorded', { category, value, timestamp });
  }
  
  async recordBatch(metrics) {
    const timestamp = Date.now();
    
    for (const { category, value, metadata } of metrics) {
      await this.recordMetric(category, value, timestamp, metadata);
    }
  }
  
  // Statistical Analysis
  
  getBasicStats(category, timeRange = null) {
    const cacheKey = `${category}:${timeRange?.start}:${timeRange?.end}`;
    
    // Check cache
    if (this.statsCache.has(cacheKey)) {
      return this.statsCache.get(cacheKey);
    }
    
    const series = this.timeSeries.get(category);
    if (!series) {
      throw new Error(`Unknown metric category: ${category}`);
    }
    
    // Filter by time range
    let data = series.data;
    if (timeRange) {
      data = data.filter(d => 
        d.timestamp >= timeRange.start && d.timestamp <= timeRange.end
      );
    }
    
    if (data.length === 0) {
      return null;
    }
    
    const values = data.map(d => d.value);
    
    // Calculate statistics
    const stats = {
      count: values.length,
      sum: values.reduce((a, b) => a + b, 0),
      mean: 0,
      median: 0,
      mode: 0,
      min: Math.min(...values),
      max: Math.max(...values),
      range: 0,
      variance: 0,
      stdDev: 0,
      skewness: 0,
      kurtosis: 0,
      percentiles: {}
    };
    
    stats.mean = stats.sum / stats.count;
    stats.range = stats.max - stats.min;
    
    // Sort for median and percentiles
    const sorted = [...values].sort((a, b) => a - b);
    
    // Median
    const mid = Math.floor(sorted.length / 2);
    stats.median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
    
    // Mode
    const frequency = {};
    let maxFreq = 0;
    for (const val of values) {
      frequency[val] = (frequency[val] || 0) + 1;
      if (frequency[val] > maxFreq) {
        maxFreq = frequency[val];
        stats.mode = val;
      }
    }
    
    // Variance and standard deviation
    const squaredDiffs = values.map(v => Math.pow(v - stats.mean, 2));
    stats.variance = squaredDiffs.reduce((a, b) => a + b, 0) / stats.count;
    stats.stdDev = Math.sqrt(stats.variance);
    
    // Percentiles
    const percentiles = [10, 25, 50, 75, 90, 95, 99];
    for (const p of percentiles) {
      const index = Math.ceil((p / 100) * sorted.length) - 1;
      stats.percentiles[p] = sorted[index];
    }
    
    // Skewness (Fisher's method)
    if (stats.stdDev > 0) {
      const cubedDiffs = values.map(v => Math.pow((v - stats.mean) / stats.stdDev, 3));
      stats.skewness = cubedDiffs.reduce((a, b) => a + b, 0) / stats.count;
    }
    
    // Kurtosis (excess kurtosis)
    if (stats.stdDev > 0) {
      const fourthDiffs = values.map(v => Math.pow((v - stats.mean) / stats.stdDev, 4));
      stats.kurtosis = (fourthDiffs.reduce((a, b) => a + b, 0) / stats.count) - 3;
    }
    
    // Cache result
    this.statsCache.set(cacheKey, stats);
    
    return stats;
  }
  
  // Time Series Analysis
  
  async analyzeTimeSeries(category, options = {}) {
    const series = this.timeSeries.get(category);
    if (!series || series.data.length < 2) {
      return null;
    }
    
    const analysis = {
      trend: await this.calculateTrend(series.data),
      seasonality: await this.detectSeasonality(series.data),
      autocorrelation: await this.calculateAutocorrelation(series.data),
      changePoints: await this.detectChangePoints(series.data),
      forecast: null
    };
    
    // Forecast if enabled
    if (this.config.enablePredictiveAnalytics) {
      analysis.forecast = await this.forecastTimeSeries(category, options.forecastPeriods || 24);
    }
    
    return analysis;
  }
  
  async calculateTrend(data) {
    if (data.length < 2) return null;
    
    // Simple linear regression
    const n = data.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    const startTime = data[0].timestamp;
    
    for (let i = 0; i < n; i++) {
      const x = (data[i].timestamp - startTime) / 3600000; // Hours from start
      const y = data[i].value;
      
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Calculate R-squared
    const yMean = sumY / n;
    let ssTotal = 0, ssResidual = 0;
    
    for (let i = 0; i < n; i++) {
      const x = (data[i].timestamp - startTime) / 3600000;
      const y = data[i].value;
      const yPred = slope * x + intercept;
      
      ssTotal += Math.pow(y - yMean, 2);
      ssResidual += Math.pow(y - yPred, 2);
    }
    
    const rSquared = 1 - (ssResidual / ssTotal);
    
    return {
      slope,
      intercept,
      rSquared,
      direction: slope > 0 ? 'increasing' : slope < 0 ? 'decreasing' : 'stable',
      strength: Math.abs(rSquared)
    };
  }
  
  async detectSeasonality(data) {
    if (data.length < 48) return null; // Need at least 2 days of hourly data
    
    // FFT-based seasonality detection
    const values = data.map(d => d.value);
    const fft = this.computeFFT(values);
    
    // Find dominant frequencies
    const frequencies = [];
    const threshold = Math.max(...fft.magnitude) * 0.1;
    
    for (let i = 1; i < fft.magnitude.length / 2; i++) {
      if (fft.magnitude[i] > threshold) {
        const period = fft.magnitude.length / i;
        frequencies.push({
          frequency: i,
          period,
          strength: fft.magnitude[i]
        });
      }
    }
    
    // Sort by strength
    frequencies.sort((a, b) => b.strength - a.strength);
    
    return {
      detected: frequencies.length > 0,
      patterns: frequencies.slice(0, 3), // Top 3 patterns
      primaryPeriod: frequencies[0]?.period || null
    };
  }
  
  async calculateAutocorrelation(data, maxLag = 24) {
    const values = data.map(d => d.value);
    const n = values.length;
    
    if (n < maxLag + 1) return null;
    
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
    
    const correlations = [];
    
    for (let lag = 1; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < n - lag; i++) {
        sum += (values[i] - mean) * (values[i + lag] - mean);
      }
      
      const correlation = sum / ((n - lag) * variance);
      correlations.push({
        lag,
        correlation,
        significant: Math.abs(correlation) > 2 / Math.sqrt(n)
      });
    }
    
    return correlations;
  }
  
  async detectChangePoints(data) {
    if (data.length < 10) return [];
    
    const changePoints = [];
    const windowSize = Math.min(20, Math.floor(data.length / 5));
    
    for (let i = windowSize; i < data.length - windowSize; i++) {
      const before = data.slice(i - windowSize, i).map(d => d.value);
      const after = data.slice(i, i + windowSize).map(d => d.value);
      
      // Calculate means
      const meanBefore = before.reduce((a, b) => a + b, 0) / before.length;
      const meanAfter = after.reduce((a, b) => a + b, 0) / after.length;
      
      // Calculate pooled standard deviation
      const varBefore = before.reduce((sum, v) => sum + Math.pow(v - meanBefore, 2), 0) / before.length;
      const varAfter = after.reduce((sum, v) => sum + Math.pow(v - meanAfter, 2), 0) / after.length;
      const pooledStd = Math.sqrt((varBefore + varAfter) / 2);
      
      // T-statistic
      const tStat = Math.abs(meanAfter - meanBefore) / (pooledStd * Math.sqrt(2 / windowSize));
      
      // Threshold based on t-distribution
      const threshold = 2.576; // 99% confidence
      
      if (tStat > threshold) {
        changePoints.push({
          index: i,
          timestamp: data[i].timestamp,
          beforeMean: meanBefore,
          afterMean: meanAfter,
          changePercent: ((meanAfter - meanBefore) / meanBefore) * 100,
          confidence: Math.min(0.99, tStat / threshold)
        });
      }
    }
    
    return changePoints;
  }
  
  // Predictive Analytics
  
  async forecastTimeSeries(category, periods = 24) {
    const series = this.timeSeries.get(category);
    if (!series || series.data.length < 24) {
      return null;
    }
    
    // Use different methods based on data characteristics
    const analysis = await this.analyzeTimeSeries(category);
    
    let forecast;
    
    if (analysis.seasonality?.detected) {
      // Use seasonal decomposition
      forecast = await this.seasonalForecast(series.data, periods);
    } else if (analysis.trend?.strength > 0.7) {
      // Use trend-based forecast
      forecast = await this.trendForecast(series.data, periods, analysis.trend);
    } else {
      // Use ARIMA-like model
      forecast = await this.arimaForecast(series.data, periods);
    }
    
    // Add confidence intervals
    forecast = this.addConfidenceIntervals(forecast, series.data);
    
    // Store prediction
    this.predictions.set(category, {
      timestamp: Date.now(),
      forecast,
      method: forecast.method,
      accuracy: await this.evaluateForecastAccuracy(category)
    });
    
    return forecast;
  }
  
  async seasonalForecast(data, periods) {
    // Decompose time series
    const decomposition = await this.decomposeTimeSeries(data);
    
    const lastTimestamp = data[data.length - 1].timestamp;
    const interval = this.estimateInterval(data);
    
    const forecast = {
      method: 'seasonal',
      values: []
    };
    
    for (let i = 1; i <= periods; i++) {
      const timestamp = lastTimestamp + (i * interval);
      
      // Project trend
      const trendValue = decomposition.trend.slope * i + decomposition.trend.last;
      
      // Add seasonal component
      const seasonalIndex = i % decomposition.seasonal.period;
      const seasonalValue = decomposition.seasonal.pattern[seasonalIndex] || 0;
      
      forecast.values.push({
        timestamp,
        value: trendValue + seasonalValue,
        components: {
          trend: trendValue,
          seasonal: seasonalValue
        }
      });
    }
    
    return forecast;
  }
  
  async trendForecast(data, periods, trend) {
    const lastTimestamp = data[data.length - 1].timestamp;
    const interval = this.estimateInterval(data);
    const startTime = data[0].timestamp;
    
    const forecast = {
      method: 'trend',
      values: []
    };
    
    for (let i = 1; i <= periods; i++) {
      const timestamp = lastTimestamp + (i * interval);
      const x = (timestamp - startTime) / 3600000; // Hours from start
      const value = trend.slope * x + trend.intercept;
      
      forecast.values.push({
        timestamp,
        value: Math.max(0, value) // Ensure non-negative
      });
    }
    
    return forecast;
  }
  
  async arimaForecast(data, periods) {
    // Simplified ARIMA(1,1,1) implementation
    const values = data.map(d => d.value);
    const differences = [];
    
    // First differencing
    for (let i = 1; i < values.length; i++) {
      differences.push(values[i] - values[i - 1]);
    }
    
    // Calculate AR and MA parameters
    const mean = differences.reduce((a, b) => a + b, 0) / differences.length;
    const ar1 = this.calculateAR1(differences, mean);
    const ma1 = this.calculateMA1(differences, mean);
    
    const lastTimestamp = data[data.length - 1].timestamp;
    const interval = this.estimateInterval(data);
    
    const forecast = {
      method: 'arima',
      values: []
    };
    
    let lastValue = values[values.length - 1];
    let lastDiff = differences[differences.length - 1];
    let lastError = 0;
    
    for (let i = 1; i <= periods; i++) {
      // Forecast difference
      const forecastDiff = mean + ar1 * (lastDiff - mean) + ma1 * lastError;
      
      // Integrate to get value
      const value = lastValue + forecastDiff;
      
      forecast.values.push({
        timestamp: lastTimestamp + (i * interval),
        value: Math.max(0, value)
      });
      
      lastValue = value;
      lastDiff = forecastDiff;
      lastError = 0; // Assume perfect forecast
    }
    
    return forecast;
  }
  
  // Anomaly Detection
  
  async detectAnomaly(category, value, timestamp) {
    const stats = this.getBasicStats(category);
    if (!stats || stats.count < 30) return false;
    
    // Z-score method
    const zScore = Math.abs((value - stats.mean) / stats.stdDev);
    
    if (zScore > this.config.anomalyThreshold) {
      const anomaly = {
        id: crypto.randomBytes(16).toString('hex'),
        category,
        timestamp,
        value,
        expected: stats.mean,
        deviation: zScore,
        type: value > stats.mean ? 'spike' : 'drop',
        severity: this.calculateAnomalySeverity(zScore)
      };
      
      // Check for contextual anomalies
      anomaly.context = await this.analyzeAnomalyContext(category, timestamp);
      
      this.anomalies.push(anomaly);
      
      // Maintain anomaly list size
      if (this.anomalies.length > 1000) {
        this.anomalies.shift();
      }
      
      this.emit('anomaly:detected', anomaly);
      
      return true;
    }
    
    return false;
  }
  
  calculateAnomalySeverity(zScore) {
    if (zScore > 5) return 'critical';
    if (zScore > 4) return 'high';
    if (zScore > 3) return 'medium';
    return 'low';
  }
  
  async analyzeAnomalyContext(category, timestamp) {
    const context = {
      correlatedAnomalies: [],
      possibleCauses: []
    };
    
    // Check for anomalies in correlated metrics
    const correlations = await this.getCorrelatedMetrics(category);
    
    for (const { metric, correlation } of correlations) {
      const recentAnomalies = this.anomalies.filter(a => 
        a.category === metric &&
        Math.abs(a.timestamp - timestamp) < 300000 // Within 5 minutes
      );
      
      if (recentAnomalies.length > 0) {
        context.correlatedAnomalies.push({
          metric,
          correlation,
          anomalies: recentAnomalies
        });
      }
    }
    
    // Analyze possible causes
    if (category === 'hashrate' && context.correlatedAnomalies.some(a => a.metric === 'temperature')) {
      context.possibleCauses.push('Temperature-related throttling');
    }
    
    if (category === 'shares' && context.correlatedAnomalies.some(a => a.metric === 'latency')) {
      context.possibleCauses.push('Network connectivity issues');
    }
    
    return context;
  }
  
  // Pattern Recognition
  
  async detectPatterns(category, options = {}) {
    const series = this.timeSeries.get(category);
    if (!series || series.data.length < 100) {
      return null;
    }
    
    const patterns = {
      recurring: await this.findRecurringPatterns(series.data),
      trends: await this.identifyTrendPatterns(series.data),
      cycles: await this.detectCyclicalPatterns(series.data)
    };
    
    // Store patterns
    this.patterns.set(category, {
      timestamp: Date.now(),
      patterns
    });
    
    return patterns;
  }
  
  async findRecurringPatterns(data, minLength = 10, maxLength = 50) {
    const patterns = [];
    const values = data.map(d => d.value);
    
    // Normalize values
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length);
    const normalized = values.map(v => (v - mean) / stdDev);
    
    // Sliding window pattern matching
    for (let length = minLength; length <= maxLength && length < normalized.length / 2; length++) {
      for (let i = 0; i < normalized.length - length * 2; i++) {
        const pattern = normalized.slice(i, i + length);
        
        // Search for similar patterns
        const matches = [];
        for (let j = i + length; j < normalized.length - length; j++) {
          const candidate = normalized.slice(j, j + length);
          const similarity = this.calculatePatternSimilarity(pattern, candidate);
          
          if (similarity > 0.8) {
            matches.push({
              index: j,
              timestamp: data[j].timestamp,
              similarity
            });
          }
        }
        
        if (matches.length >= 2) {
          patterns.push({
            startIndex: i,
            length,
            pattern: pattern.map((v, idx) => ({
              relativeIndex: idx,
              normalizedValue: v,
              originalValue: values[i + idx]
            })),
            occurrences: matches.length + 1,
            averageInterval: this.calculateAverageInterval(matches)
          });
          
          // Skip ahead to avoid overlapping patterns
          i += length - 1;
        }
      }
    }
    
    // Sort by frequency and length
    patterns.sort((a, b) => b.occurrences * b.length - a.occurrences * a.length);
    
    return patterns.slice(0, 5); // Top 5 patterns
  }
  
  calculatePatternSimilarity(pattern1, pattern2) {
    if (pattern1.length !== pattern2.length) return 0;
    
    // Pearson correlation
    const n = pattern1.length;
    const mean1 = pattern1.reduce((a, b) => a + b, 0) / n;
    const mean2 = pattern2.reduce((a, b) => a + b, 0) / n;
    
    let num = 0, den1 = 0, den2 = 0;
    
    for (let i = 0; i < n; i++) {
      const diff1 = pattern1[i] - mean1;
      const diff2 = pattern2[i] - mean2;
      
      num += diff1 * diff2;
      den1 += diff1 * diff1;
      den2 += diff2 * diff2;
    }
    
    if (den1 === 0 || den2 === 0) return 0;
    
    return num / (Math.sqrt(den1) * Math.sqrt(den2));
  }
  
  // Correlation Analysis
  
  async calculateCorrelationMatrix() {
    const metrics = Array.from(this.timeSeries.keys());
    const matrix = {};
    
    for (const metric1 of metrics) {
      matrix[metric1] = {};
      
      for (const metric2 of metrics) {
        if (metric1 === metric2) {
          matrix[metric1][metric2] = 1;
        } else {
          const correlation = await this.calculateCorrelation(metric1, metric2);
          matrix[metric1][metric2] = correlation;
        }
      }
    }
    
    this.correlationMatrix = matrix;
    
    return matrix;
  }
  
  async calculateCorrelation(category1, category2) {
    const series1 = this.timeSeries.get(category1);
    const series2 = this.timeSeries.get(category2);
    
    if (!series1 || !series2) return 0;
    
    // Align timestamps
    const aligned = this.alignTimeSeries(series1.data, series2.data);
    
    if (aligned.length < 10) return 0;
    
    const values1 = aligned.map(d => d.value1);
    const values2 = aligned.map(d => d.value2);
    
    // Calculate Pearson correlation
    const n = values1.length;
    const mean1 = values1.reduce((a, b) => a + b, 0) / n;
    const mean2 = values2.reduce((a, b) => a + b, 0) / n;
    
    let num = 0, den1 = 0, den2 = 0;
    
    for (let i = 0; i < n; i++) {
      const diff1 = values1[i] - mean1;
      const diff2 = values2[i] - mean2;
      
      num += diff1 * diff2;
      den1 += diff1 * diff1;
      den2 += diff2 * diff2;
    }
    
    if (den1 === 0 || den2 === 0) return 0;
    
    return num / (Math.sqrt(den1) * Math.sqrt(den2));
  }
  
  async getCorrelatedMetrics(category, threshold = 0.5) {
    if (!this.correlationMatrix) {
      await this.calculateCorrelationMatrix();
    }
    
    const correlations = [];
    const categoryCorrelations = this.correlationMatrix[category] || {};
    
    for (const [metric, correlation] of Object.entries(categoryCorrelations)) {
      if (metric !== category && Math.abs(correlation) > threshold) {
        correlations.push({
          metric,
          correlation,
          strength: Math.abs(correlation) > 0.8 ? 'strong' : 'moderate'
        });
      }
    }
    
    // Sort by absolute correlation
    correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
    
    return correlations;
  }
  
  // Machine Learning Models
  
  async initializeMLModels() {
    // In a real implementation, these would be actual ML models
    // For demo, we'll use simplified statistical models
    
    this.models.hashratePrediction = {
      type: 'regression',
      features: ['difficulty', 'temperature', 'workers'],
      weights: null,
      lastTrained: 0
    };
    
    this.models.profitabilityForecast = {
      type: 'timeseries',
      features: ['hashrate', 'difficulty', 'price'],
      weights: null,
      lastTrained: 0
    };
    
    this.models.anomalyDetector = {
      type: 'isolation_forest',
      features: ['hashrate', 'shares', 'temperature', 'errors'],
      threshold: null,
      lastTrained: 0
    };
    
    this.models.patternClassifier = {
      type: 'clustering',
      features: ['hashrate', 'efficiency', 'temperature'],
      clusters: null,
      lastTrained: 0
    };
    
    // Initial training
    await this.trainModels();
  }
  
  async trainModels() {
    for (const [name, model] of Object.entries(this.models)) {
      if (Date.now() - model.lastTrained > this.config.mlModelUpdateInterval) {
        await this.trainModel(name, model);
      }
    }
  }
  
  async trainModel(name, model) {
    // Prepare training data
    const trainingData = await this.prepareTrainingData(model.features);
    
    if (trainingData.length < 100) {
      return; // Not enough data
    }
    
    switch (model.type) {
      case 'regression':
        model.weights = await this.trainRegressionModel(trainingData, model.features);
        break;
        
      case 'timeseries':
        model.weights = await this.trainTimeSeriesModel(trainingData, model.features);
        break;
        
      case 'isolation_forest':
        model.threshold = await this.trainAnomalyModel(trainingData);
        break;
        
      case 'clustering':
        model.clusters = await this.trainClusteringModel(trainingData);
        break;
    }
    
    model.lastTrained = Date.now();
    
    this.emit('model:trained', { name, model });
  }
  
  async prepareTrainingData(features) {
    const data = [];
    const minLength = Math.min(...features.map(f => 
      this.timeSeries.get(f)?.data.length || 0
    ));
    
    if (minLength === 0) return data;
    
    // Align all features by timestamp
    for (let i = 0; i < minLength; i++) {
      const sample = {
        timestamp: this.timeSeries.get(features[0]).data[i].timestamp
      };
      
      for (const feature of features) {
        sample[feature] = this.timeSeries.get(feature).data[i].value;
      }
      
      data.push(sample);
    }
    
    return data;
  }
  
  // Reporting
  
  async generateReport(options = {}) {
    const report = {
      generatedAt: Date.now(),
      period: options.period || { start: Date.now() - 86400000, end: Date.now() },
      summary: {},
      insights: [],
      predictions: {},
      anomalies: [],
      recommendations: []
    };
    
    // Summary statistics
    for (const [category, series] of this.timeSeries) {
      const stats = this.getBasicStats(category, report.period);
      if (stats) {
        report.summary[category] = {
          current: series.data[series.data.length - 1]?.value || 0,
          stats,
          trend: (await this.analyzeTimeSeries(category))?.trend
        };
      }
    }
    
    // Key insights
    report.insights = await this.generateInsights(report.summary);
    
    // Predictions
    for (const category of ['hashrate', 'earnings', 'difficulty']) {
      const forecast = await this.forecastTimeSeries(category, 24);
      if (forecast) {
        report.predictions[category] = forecast;
      }
    }
    
    // Recent anomalies
    report.anomalies = this.anomalies
      .filter(a => a.timestamp > report.period.start)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10);
    
    // Recommendations
    report.recommendations = await this.generateRecommendations(report);
    
    return report;
  }
  
  async generateInsights(summary) {
    const insights = [];
    
    // Hashrate insights
    if (summary.hashrate) {
      const trend = summary.hashrate.trend;
      if (trend && trend.direction === 'decreasing' && trend.strength > 0.7) {
        insights.push({
          type: 'warning',
          category: 'hashrate',
          message: `Hashrate has been declining at ${Math.abs(trend.slope).toFixed(2)} GH/s per hour`,
          severity: 'medium'
        });
      }
    }
    
    // Efficiency insights
    if (summary.efficiency && summary.power) {
      const efficiency = summary.efficiency.stats.mean;
      const optimalEfficiency = 0.95;
      
      if (efficiency < optimalEfficiency) {
        insights.push({
          type: 'optimization',
          category: 'efficiency',
          message: `Mining efficiency is ${((optimalEfficiency - efficiency) * 100).toFixed(1)}% below optimal`,
          severity: 'low'
        });
      }
    }
    
    // Correlation insights
    const correlations = await this.getCorrelatedMetrics('hashrate', 0.7);
    for (const { metric, correlation } of correlations) {
      insights.push({
        type: 'correlation',
        category: 'analysis',
        message: `Strong ${correlation > 0 ? 'positive' : 'negative'} correlation between hashrate and ${metric}`,
        severity: 'info'
      });
    }
    
    return insights;
  }
  
  async generateRecommendations(report) {
    const recommendations = [];
    
    // Based on anomalies
    const errorAnomalies = report.anomalies.filter(a => a.category === 'errors');
    if (errorAnomalies.length > 3) {
      recommendations.push({
        priority: 'high',
        category: 'stability',
        action: 'Investigate recurring errors',
        reason: `${errorAnomalies.length} error anomalies detected in the past 24 hours`,
        impact: 'Potential hashrate loss and instability'
      });
    }
    
    // Based on predictions
    if (report.predictions.hashrate) {
      const forecast = report.predictions.hashrate.values;
      const currentHashrate = report.summary.hashrate.current;
      const futureHashrate = forecast[forecast.length - 1].value;
      
      if (futureHashrate < currentHashrate * 0.9) {
        recommendations.push({
          priority: 'medium',
          category: 'performance',
          action: 'Prepare for hashrate decline',
          reason: `Hashrate predicted to drop ${((1 - futureHashrate/currentHashrate) * 100).toFixed(1)}% in next 24 hours`,
          impact: 'Reduced mining rewards'
        });
      }
    }
    
    // Based on efficiency
    if (report.summary.efficiency) {
      const efficiency = report.summary.efficiency.stats.mean;
      if (efficiency < 0.9) {
        recommendations.push({
          priority: 'medium',
          category: 'optimization',
          action: 'Optimize mining settings',
          reason: `Current efficiency ${(efficiency * 100).toFixed(1)}% is below optimal`,
          impact: 'Increased power costs and reduced profitability'
        });
      }
    }
    
    return recommendations;
  }
  
  // Utility Methods
  
  getUnitForCategory(category) {
    const units = {
      hashrate: 'GH/s',
      difficulty: 'T',
      shares: 'shares/min',
      blocks: 'blocks',
      earnings: 'BTC',
      workers: 'count',
      efficiency: 'ratio',
      temperature: '°C',
      power: 'W',
      latency: 'ms',
      errors: 'count/min',
      uptime: '%'
    };
    
    return units[category] || 'units';
  }
  
  getAggregationMethod(category) {
    const methods = {
      hashrate: 'average',
      difficulty: 'last',
      shares: 'sum',
      blocks: 'sum',
      earnings: 'sum',
      workers: 'average',
      efficiency: 'average',
      temperature: 'average',
      power: 'average',
      latency: 'average',
      errors: 'sum',
      uptime: 'average'
    };
    
    return methods[category] || 'average';
  }
  
  estimateInterval(data) {
    if (data.length < 2) return 3600000; // Default 1 hour
    
    const intervals = [];
    for (let i = 1; i < Math.min(10, data.length); i++) {
      intervals.push(data[i].timestamp - data[i - 1].timestamp);
    }
    
    // Return median interval
    intervals.sort((a, b) => a - b);
    return intervals[Math.floor(intervals.length / 2)];
  }
  
  alignTimeSeries(data1, data2) {
    const aligned = [];
    let i = 0, j = 0;
    
    while (i < data1.length && j < data2.length) {
      const diff = data1[i].timestamp - data2[j].timestamp;
      
      if (Math.abs(diff) < 60000) { // Within 1 minute
        aligned.push({
          timestamp: data1[i].timestamp,
          value1: data1[i].value,
          value2: data2[j].value
        });
        i++;
        j++;
      } else if (diff < 0) {
        i++;
      } else {
        j++;
      }
    }
    
    return aligned;
  }
  
  async compressOldData(category) {
    const series = this.timeSeries.get(category);
    if (!series) return;
    
    const cutoff = Date.now() - (this.config.dataRetentionDays * 86400000);
    const toCompress = [];
    const toKeep = [];
    
    for (const point of series.data) {
      if (point.timestamp < cutoff) {
        toCompress.push(point);
      } else {
        toKeep.push(point);
      }
    }
    
    if (toCompress.length > 0) {
      // Aggregate old data
      const aggregated = await this.aggregateData(toCompress, series.metadata.aggregationMethod);
      
      // Store aggregated data
      if (!this.aggregatedData.has(category)) {
        this.aggregatedData.set(category, []);
      }
      
      this.aggregatedData.get(category).push(aggregated);
      
      // Update series with only recent data
      series.data = toKeep;
    }
  }
  
  async aggregateData(data, method) {
    const values = data.map(d => d.value);
    let aggregatedValue;
    
    switch (method) {
      case 'sum':
        aggregatedValue = values.reduce((a, b) => a + b, 0);
        break;
      case 'average':
        aggregatedValue = values.reduce((a, b) => a + b, 0) / values.length;
        break;
      case 'last':
        aggregatedValue = values[values.length - 1];
        break;
      case 'max':
        aggregatedValue = Math.max(...values);
        break;
      case 'min':
        aggregatedValue = Math.min(...values);
        break;
      default:
        aggregatedValue = values.reduce((a, b) => a + b, 0) / values.length;
    }
    
    return {
      startTime: data[0].timestamp,
      endTime: data[data.length - 1].timestamp,
      value: aggregatedValue,
      count: data.length,
      method
    };
  }
  
  // FFT implementation for frequency analysis
  computeFFT(signal) {
    const N = signal.length;
    const magnitude = new Array(N);
    const phase = new Array(N);
    
    // Simple DFT for demo (would use FFT library in production)
    for (let k = 0; k < N; k++) {
      let sumReal = 0;
      let sumImag = 0;
      
      for (let n = 0; n < N; n++) {
        const angle = -2 * Math.PI * k * n / N;
        sumReal += signal[n] * Math.cos(angle);
        sumImag += signal[n] * Math.sin(angle);
      }
      
      magnitude[k] = Math.sqrt(sumReal * sumReal + sumImag * sumImag);
      phase[k] = Math.atan2(sumImag, sumReal);
    }
    
    return { magnitude, phase };
  }
  
  calculateAR1(differences, mean) {
    let numerator = 0;
    let denominator = 0;
    
    for (let i = 1; i < differences.length; i++) {
      numerator += (differences[i] - mean) * (differences[i - 1] - mean);
      denominator += Math.pow(differences[i - 1] - mean, 2);
    }
    
    return denominator > 0 ? numerator / denominator : 0;
  }
  
  calculateMA1(differences, mean) {
    // Simplified MA(1) estimation
    return 0.1; // Would use proper estimation in production
  }
  
  decomposeTimeSeries(data) {
    // Simplified decomposition
    const trend = this.calculateTrend(data);
    
    // Remove trend
    const detrended = data.map((d, i) => ({
      ...d,
      value: d.value - (trend.slope * i + trend.intercept)
    }));
    
    // Find seasonal pattern (simplified)
    const seasonalPeriod = 24; // Assume daily pattern
    const seasonal = {
      period: seasonalPeriod,
      pattern: new Array(seasonalPeriod).fill(0)
    };
    
    // Calculate average for each period position
    for (let i = 0; i < detrended.length; i++) {
      const position = i % seasonalPeriod;
      seasonal.pattern[position] += detrended[i].value;
    }
    
    // Normalize
    for (let i = 0; i < seasonalPeriod; i++) {
      seasonal.pattern[i] /= Math.floor(detrended.length / seasonalPeriod);
    }
    
    return {
      trend: {
        ...trend,
        last: trend.slope * (data.length - 1) + trend.intercept
      },
      seasonal
    };
  }
  
  identifyTrendPatterns(data) {
    // Identify different types of trends
    const patterns = [];
    
    // Linear trend
    const linearTrend = this.calculateTrend(data);
    if (linearTrend.rSquared > 0.8) {
      patterns.push({
        type: 'linear',
        ...linearTrend
      });
    }
    
    // Exponential trend (log transform)
    const logValues = data.map(d => ({ ...d, value: Math.log(d.value + 1) }));
    const expTrend = this.calculateTrend(logValues);
    if (expTrend.rSquared > 0.8) {
      patterns.push({
        type: 'exponential',
        growthRate: Math.exp(expTrend.slope) - 1,
        rSquared: expTrend.rSquared
      });
    }
    
    return patterns;
  }
  
  detectCyclicalPatterns(data) {
    // Detect cycles using autocorrelation
    const autocorr = this.calculateAutocorrelation(data, Math.min(100, data.length / 2));
    
    const cycles = [];
    let lastPeak = 0;
    
    for (const { lag, correlation, significant } of autocorr) {
      if (significant && correlation > 0.5 && lag > lastPeak + 5) {
        cycles.push({
          period: lag,
          strength: correlation,
          confidence: correlation > 0.7 ? 'high' : 'medium'
        });
        lastPeak = lag;
      }
    }
    
    return cycles;
  }
  
  addConfidenceIntervals(forecast, historicalData) {
    // Calculate prediction intervals based on historical variance
    const errors = [];
    
    // If we have previous forecasts, calculate actual errors
    // For now, estimate based on historical variance
    const values = historicalData.map(d => d.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    
    // Add confidence intervals
    forecast.values = forecast.values.map((point, index) => ({
      ...point,
      confidence: {
        lower95: point.value - 1.96 * stdDev * Math.sqrt(1 + index / 10),
        upper95: point.value + 1.96 * stdDev * Math.sqrt(1 + index / 10),
        lower80: point.value - 1.28 * stdDev * Math.sqrt(1 + index / 10),
        upper80: point.value + 1.28 * stdDev * Math.sqrt(1 + index / 10)
      }
    }));
    
    return forecast;
  }
  
  calculateAverageInterval(matches) {
    if (matches.length < 2) return null;
    
    const intervals = [];
    for (let i = 1; i < matches.length; i++) {
      intervals.push(matches[i].timestamp - matches[i - 1].timestamp);
    }
    
    return intervals.reduce((a, b) => a + b, 0) / intervals.length;
  }
  
  async evaluateForecastAccuracy(category) {
    // Compare previous forecasts with actual values
    const previousPrediction = this.predictions.get(category);
    if (!previousPrediction) return null;
    
    const series = this.timeSeries.get(category);
    if (!series) return null;
    
    const accuracy = {
      mape: 0, // Mean Absolute Percentage Error
      rmse: 0, // Root Mean Square Error
      mae: 0   // Mean Absolute Error
    };
    
    let count = 0;
    
    for (const forecast of previousPrediction.forecast.values) {
      const actual = series.data.find(d => 
        Math.abs(d.timestamp - forecast.timestamp) < 60000
      );
      
      if (actual) {
        const error = actual.value - forecast.value;
        accuracy.mae += Math.abs(error);
        accuracy.rmse += error * error;
        accuracy.mape += Math.abs(error / actual.value);
        count++;
      }
    }
    
    if (count > 0) {
      accuracy.mae /= count;
      accuracy.rmse = Math.sqrt(accuracy.rmse / count);
      accuracy.mape = (accuracy.mape / count) * 100;
    }
    
    return accuracy;
  }
  
  async trainRegressionModel(data, features) {
    // Simple linear regression for demo
    // In production, would use proper ML library
    
    const weights = {};
    
    // Calculate weights for each feature
    for (const feature of features) {
      const values = data.map(d => d[feature]);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
      
      weights[feature] = {
        coefficient: 1 / (variance + 1), // Simplified
        intercept: mean
      };
    }
    
    return weights;
  }
  
  async trainTimeSeriesModel(data, features) {
    // Simplified time series model
    return {
      method: 'exponential_smoothing',
      alpha: 0.3,
      beta: 0.1,
      gamma: 0.1
    };
  }
  
  async trainAnomalyModel(data) {
    // Calculate threshold based on data distribution
    const allValues = [];
    
    for (const sample of data) {
      const vector = Object.values(sample).filter(v => typeof v === 'number');
      const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      allValues.push(magnitude);
    }
    
    const mean = allValues.reduce((a, b) => a + b, 0) / allValues.length;
    const stdDev = Math.sqrt(allValues.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / allValues.length);
    
    return mean + 3 * stdDev; // 3-sigma threshold
  }
  
  async trainClusteringModel(data) {
    // Simple k-means for demo
    const k = 5; // Number of clusters
    const clusters = [];
    
    // Initialize random centroids
    for (let i = 0; i < k; i++) {
      const randomIndex = Math.floor(Math.random() * data.length);
      clusters.push({
        id: i,
        centroid: { ...data[randomIndex] },
        members: []
      });
    }
    
    return clusters;
  }
  
  // Analysis cycles
  
  startAnalysisCycles() {
    this.analysisInterval = setInterval(() => {
      this.performPeriodicAnalysis();
    }, this.config.analysisInterval);
    
    if (this.config.enableML) {
      this.mlInterval = setInterval(() => {
        this.trainModels();
      }, this.config.mlModelUpdateInterval);
    }
  }
  
  async performPeriodicAnalysis() {
    try {
      // Update correlation matrix
      await this.calculateCorrelationMatrix();
      
      // Detect patterns in key metrics
      for (const metric of ['hashrate', 'efficiency', 'earnings']) {
        await this.detectPatterns(metric);
      }
      
      // Generate forecasts
      for (const metric of ['hashrate', 'difficulty', 'earnings']) {
        await this.forecastTimeSeries(metric);
      }
      
      this.emit('analysis:completed', {
        timestamp: Date.now(),
        metrics: this.timeSeries.size,
        anomalies: this.anomalies.length,
        patterns: this.patterns.size
      });
      
    } catch (error) {
      this.emit('error', error);
    }
  }
  
  // Data persistence
  
  async loadHistoricalData() {
    // This would load from database
    // For demo, we'll generate some sample data
    
    const now = Date.now();
    const categories = ['hashrate', 'shares', 'temperature', 'power', 'efficiency'];
    
    for (const category of categories) {
      for (let i = 0; i < 1000; i++) {
        const timestamp = now - (i * 60000); // 1 minute intervals
        let value;
        
        switch (category) {
          case 'hashrate':
            value = 100 + Math.sin(i / 100) * 20 + Math.random() * 10;
            break;
          case 'shares':
            value = 50 + Math.random() * 20;
            break;
          case 'temperature':
            value = 65 + Math.sin(i / 50) * 10 + Math.random() * 5;
            break;
          case 'power':
            value = 1000 + Math.sin(i / 100) * 100 + Math.random() * 50;
            break;
          case 'efficiency':
            value = 0.9 + Math.sin(i / 200) * 0.05 + Math.random() * 0.02;
            break;
        }
        
        await this.recordMetric(category, value, timestamp);
      }
    }
  }
  
  // API Methods
  
  async getMetricData(category, timeRange = null, aggregation = null) {
    const series = this.timeSeries.get(category);
    if (!series) {
      throw new Error(`Unknown metric category: ${category}`);
    }
    
    let data = series.data;
    
    // Filter by time range
    if (timeRange) {
      data = data.filter(d => 
        d.timestamp >= timeRange.start && d.timestamp <= timeRange.end
      );
    }
    
    // Apply aggregation
    if (aggregation) {
      data = await this.aggregateTimeSeries(data, aggregation);
    }
    
    return {
      category,
      unit: series.metadata.unit,
      data
    };
  }
  
  async aggregateTimeSeries(data, aggregation) {
    const { interval, method } = aggregation;
    const aggregated = [];
    
    if (data.length === 0) return aggregated;
    
    let currentBucket = {
      startTime: Math.floor(data[0].timestamp / interval) * interval,
      values: []
    };
    
    for (const point of data) {
      const bucketTime = Math.floor(point.timestamp / interval) * interval;
      
      if (bucketTime !== currentBucket.startTime) {
        // Process current bucket
        if (currentBucket.values.length > 0) {
          aggregated.push({
            timestamp: currentBucket.startTime + interval / 2,
            value: this.aggregateValues(currentBucket.values, method),
            count: currentBucket.values.length
          });
        }
        
        // Start new bucket
        currentBucket = {
          startTime: bucketTime,
          values: [point.value]
        };
      } else {
        currentBucket.values.push(point.value);
      }
    }
    
    // Process last bucket
    if (currentBucket.values.length > 0) {
      aggregated.push({
        timestamp: currentBucket.startTime + interval / 2,
        value: this.aggregateValues(currentBucket.values, method),
        count: currentBucket.values.length
      });
    }
    
    return aggregated;
  }
  
  aggregateValues(values, method) {
    switch (method) {
      case 'sum':
        return values.reduce((a, b) => a + b, 0);
      case 'average':
      case 'mean':
        return values.reduce((a, b) => a + b, 0) / values.length;
      case 'min':
        return Math.min(...values);
      case 'max':
        return Math.max(...values);
      case 'median':
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
      default:
        return values.reduce((a, b) => a + b, 0) / values.length;
    }
  }
  
  getAnomalies(options = {}) {
    let anomalies = [...this.anomalies];
    
    if (options.category) {
      anomalies = anomalies.filter(a => a.category === options.category);
    }
    
    if (options.severity) {
      anomalies = anomalies.filter(a => a.severity === options.severity);
    }
    
    if (options.timeRange) {
      anomalies = anomalies.filter(a => 
        a.timestamp >= options.timeRange.start && 
        a.timestamp <= options.timeRange.end
      );
    }
    
    // Sort by timestamp descending
    anomalies.sort((a, b) => b.timestamp - a.timestamp);
    
    if (options.limit) {
      anomalies = anomalies.slice(0, options.limit);
    }
    
    return anomalies;
  }
  
  getPatterns(category) {
    return this.patterns.get(category) || null;
  }
  
  getPredictions(category) {
    return this.predictions.get(category) || null;
  }
  
  getCorrelationMatrix() {
    return this.correlationMatrix || null;
  }
  
  // Cleanup
  
  stop() {
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
    }
    
    if (this.mlInterval) {
      clearInterval(this.mlInterval);
    }
    
    this.emit('stopped');
  }
}

module.exports = AdvancedStatisticsEngine;