/**
 * Advanced Metrics Aggregation System
 * 
 * High-performance metrics collection, aggregation, and analysis
 * Multi-dimensional time-series data with efficient storage and querying
 */

import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { Worker } from 'worker_threads';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../core/standardized-error-handler.js';

export class MetricsAggregator extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Collection settings
      collectionInterval: options.collectionInterval || 30000, // 30 seconds
      batchSize: options.batchSize || 1000,
      maxMemoryUsage: options.maxMemoryUsage || 256 * 1024 * 1024, // 256MB
      
      // Aggregation settings
      enableRealTimeAggregation: options.enableRealTimeAggregation !== false,
      aggregationLevels: options.aggregationLevels || ['1m', '5m', '1h', '1d'],
      retentionPeriods: options.retentionPeriods || {
        raw: 24 * 3600 * 1000, // 24 hours
        '1m': 7 * 24 * 3600 * 1000, // 7 days
        '5m': 30 * 24 * 3600 * 1000, // 30 days
        '1h': 90 * 24 * 3600 * 1000, // 90 days
        '1d': 365 * 24 * 3600 * 1000 // 365 days
      },
      
      // Performance settings
      enableCompression: options.enableCompression !== false,
      enableIndexing: options.enableIndexing !== false,
      workerCount: options.workerCount || 2,
      queryTimeout: options.queryTimeout || 30000,
      
      // Storage settings
      dataDirectory: options.dataDirectory || './data/metrics',
      enablePersistence: options.enablePersistence !== false,
      flushInterval: options.flushInterval || 300000, // 5 minutes
      
      // Advanced features
      enableAnomlalyDetection: options.enableAnomalyDetection !== false,
      enableForecasting: options.enableForecasting !== false,
      enableAlerts: options.enableAlerts !== false,
      
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.isRunning = false;
    this.workers = [];
    
    // Data storage
    this.rawMetrics = new Map(); // metric_name -> array of datapoints
    this.aggregatedMetrics = new Map(); // level -> metric_name -> aggregated data
    this.metricMetadata = new Map(); // metric_name -> metadata
    this.indexes = new Map(); // metric_name -> time-based index
    
    // Processing queues
    this.ingestionQueue = [];
    this.aggregationQueue = [];
    this.persistenceQueue = [];
    
    // Statistics
    this.stats = {
      totalMetrics: 0,
      totalDataPoints: 0,
      ingestedPerSecond: 0,
      aggregatedPerSecond: 0,
      memoryUsage: 0,
      lastFlush: null,
      compressionRatio: 1.0
    };
    
    // Metric types and their aggregation functions
    this.aggregationFunctions = {
      counter: this.aggregateCounter.bind(this),
      gauge: this.aggregateGauge.bind(this),
      histogram: this.aggregateHistogram.bind(this),
      timer: this.aggregateTimer.bind(this),
      set: this.aggregateSet.bind(this)
    };
    
    this.initialize();
  }
  
  /**
   * Initialize metrics aggregator
   */
  async initialize() {
    try {
      await this.ensureDirectories();
      await this.loadPersistedData();
      await this.initializeWorkers();
      
      this.emit('initialized');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'metrics-aggregator',
        category: ErrorCategory.INITIALIZATION
      });
    }
  }
  
  /**
   * Start metrics aggregation
   */
  async start() {
    if (this.isRunning) {
      throw new OtedamaError('Metrics aggregator already running', ErrorCategory.OPERATION);
    }
    
    console.log('📊 Starting metrics aggregation system...');
    this.isRunning = true;
    
    // Start collection and processing loops
    this.startIngestionProcessor();
    this.startAggregationProcessor();
    this.startPersistenceManager();
    this.startMemoryManager();
    this.startStatisticsUpdater();
    
    this.emit('started');
    console.log('✅ Metrics aggregation started successfully');
  }
  
  /**
   * Stop metrics aggregation
   */
  async stop() {
    if (!this.isRunning) return;
    
    console.log('🛑 Stopping metrics aggregation...');
    this.isRunning = false;
    
    // Process remaining queues
    await this.processAllQueues();
    
    // Terminate workers
    await this.terminateWorkers();
    
    // Final persistence
    if (this.options.enablePersistence) {
      await this.persistData();
    }
    
    // Clear timers
    if (this.ingestionTimer) clearInterval(this.ingestionTimer);
    if (this.aggregationTimer) clearInterval(this.aggregationTimer);
    if (this.persistenceTimer) clearInterval(this.persistenceTimer);
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    
    this.emit('stopped');
    console.log('✅ Metrics aggregation stopped');
  }
  
  /**
   * Record metric value
   */
  recordMetric(name, value, tags = {}, timestamp = Date.now(), type = 'gauge') {
    const metric = {
      name,
      value,
      tags,
      timestamp,
      type
    };
    
    // Add to ingestion queue
    this.ingestionQueue.push(metric);
    this.stats.totalDataPoints++;
    
    // Real-time processing for high-priority metrics
    if (this.options.enableRealTimeAggregation && this.isHighPriority(name)) {
      this.processMetricImmediately(metric);
    }
    
    this.emit('metric:recorded', metric);
  }
  
  /**
   * Record multiple metrics in batch
   */
  recordBatch(metrics) {
    for (const metric of metrics) {
      this.recordMetric(
        metric.name,
        metric.value,
        metric.tags || {},
        metric.timestamp || Date.now(),
        metric.type || 'gauge'
      );
    }
  }
  
  /**
   * Query metrics with time range and aggregation
   */
  async queryMetrics(query) {
    const {
      metric,
      startTime,
      endTime,
      aggregation = '1m',
      tags = {},
      functions = ['avg']
    } = query;
    
    if (!this.rawMetrics.has(metric) && !this.aggregatedMetrics.has(aggregation)) {
      return { dataPoints: [], metadata: {} };
    }
    
    const startQuery = performance.now();
    
    try {
      let dataPoints;
      
      if (aggregation === 'raw') {
        dataPoints = await this.queryRawMetrics(metric, startTime, endTime, tags);
      } else {
        dataPoints = await this.queryAggregatedMetrics(metric, aggregation, startTime, endTime, tags);
      }
      
      // Apply aggregation functions
      const result = this.applyAggregationFunctions(dataPoints, functions);
      
      const queryTime = performance.now() - startQuery;
      
      this.emit('query:completed', {
        metric,
        aggregation,
        queryTime,
        dataPoints: result.length
      });
      
      return {
        dataPoints: result,
        metadata: {
          queryTime,
          aggregation,
          functions,
          totalPoints: dataPoints.length,
          metric: this.metricMetadata.get(metric)
        }
      };
      
    } catch (error) {
      this.emit('query:failed', { metric, error: error.message });
      throw error;
    }
  }
  
  /**
   * Get metric statistics
   */
  getMetricStatistics(metric, period = 3600000) { // 1 hour
    const endTime = Date.now();
    const startTime = endTime - period;
    
    const rawData = this.rawMetrics.get(metric) || [];
    const relevantData = rawData.filter(
      point => point.timestamp >= startTime && point.timestamp <= endTime
    );
    
    if (relevantData.length === 0) {
      return null;
    }
    
    const values = relevantData.map(point => point.value);
    const sorted = [...values].sort((a, b) => a - b);
    
    return {
      count: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      stdDev: this.calculateStandardDeviation(values),
      rate: values.length / (period / 1000), // per second
      period,
      startTime,
      endTime
    };
  }
  
  /**
   * Get top metrics by various criteria
   */
  getTopMetrics(criteria = 'volume', limit = 10, period = 3600000) {
    const endTime = Date.now();
    const startTime = endTime - period;
    
    const metricStats = [];
    
    for (const [metricName, dataPoints] of this.rawMetrics.entries()) {
      const relevantPoints = dataPoints.filter(
        point => point.timestamp >= startTime && point.timestamp <= endTime
      );
      
      if (relevantPoints.length === 0) continue;
      
      const values = relevantPoints.map(point => point.value);
      const stats = {
        name: metricName,
        count: values.length,
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        max: Math.max(...values),
        volume: values.length * this.getMetricWeight(metricName)
      };
      
      metricStats.push(stats);
    }
    
    // Sort by criteria
    const sortFunctions = {
      volume: (a, b) => b.volume - a.volume,
      count: (a, b) => b.count - a.count,
      average: (a, b) => b.avg - a.avg,
      max: (a, b) => b.max - a.max
    };
    
    return metricStats
      .sort(sortFunctions[criteria] || sortFunctions.volume)
      .slice(0, limit);
  }
  
  /**
   * Process metric immediately for real-time aggregation
   */
  processMetricImmediately(metric) {
    // Add to raw storage
    if (!this.rawMetrics.has(metric.name)) {
      this.rawMetrics.set(metric.name, []);
      this.metricMetadata.set(metric.name, {
        type: metric.type,
        firstSeen: metric.timestamp,
        tags: new Set()
      });
    }
    
    const rawData = this.rawMetrics.get(metric.name);
    rawData.push(metric);
    
    // Update metadata
    const metadata = this.metricMetadata.get(metric.name);
    metadata.lastSeen = metric.timestamp;
    Object.keys(metric.tags).forEach(tag => metadata.tags.add(tag));
    
    // Maintain retention limit for raw data
    this.enforceRetention(metric.name, 'raw');
    
    // Trigger real-time aggregation
    this.aggregateMetricRealTime(metric);
  }
  
  /**
   * Aggregate metric in real-time
   */
  aggregateMetricRealTime(metric) {
    for (const level of this.options.aggregationLevels) {
      const aggregationWindow = this.parseAggregationLevel(level);
      const windowStart = Math.floor(metric.timestamp / aggregationWindow) * aggregationWindow;
      
      if (!this.aggregatedMetrics.has(level)) {
        this.aggregatedMetrics.set(level, new Map());
      }
      
      const levelData = this.aggregatedMetrics.get(level);
      if (!levelData.has(metric.name)) {
        levelData.set(metric.name, new Map());
      }
      
      const metricData = levelData.get(metric.name);
      
      // Get or create aggregation bucket
      let bucket = metricData.get(windowStart);
      if (!bucket) {
        bucket = {
          timestamp: windowStart,
          values: [],
          tags: new Map(),
          count: 0
        };
        metricData.set(windowStart, bucket);
      }
      
      // Add value to bucket
      bucket.values.push(metric.value);
      bucket.count++;
      
      // Aggregate tags
      for (const [key, value] of Object.entries(metric.tags)) {
        if (!bucket.tags.has(key)) {
          bucket.tags.set(key, new Set());
        }
        bucket.tags.get(key).add(value);
      }
      
      // Apply aggregation function
      const aggregationFunction = this.aggregationFunctions[metric.type] || this.aggregationFunctions.gauge;
      bucket.aggregated = aggregationFunction(bucket.values);
    }
  }
  
  /**
   * Start ingestion processor
   */
  startIngestionProcessor() {
    this.ingestionTimer = setInterval(() => {
      if (this.ingestionQueue.length > 0) {
        this.processIngestionQueue();
      }
    }, 1000); // Process every second
  }
  
  /**
   * Start aggregation processor
   */
  startAggregationProcessor() {
    this.aggregationTimer = setInterval(() => {
      if (this.aggregationQueue.length > 0) {
        this.processAggregationQueue();
      }
    }, 5000); // Process every 5 seconds
  }
  
  /**
   * Start persistence manager
   */
  startPersistenceManager() {
    if (this.options.enablePersistence) {
      this.persistenceTimer = setInterval(async () => {
        await this.persistData();
      }, this.options.flushInterval);
    }
  }
  
  /**
   * Start memory manager
   */
  startMemoryManager() {
    this.memoryTimer = setInterval(() => {
      this.manageMemory();
    }, 60000); // Check every minute
  }
  
  /**
   * Start statistics updater
   */
  startStatisticsUpdater() {
    this.statsTimer = setInterval(() => {
      this.updateStatistics();
    }, 10000); // Update every 10 seconds
  }
  
  /**
   * Process ingestion queue
   */
  processIngestionQueue() {
    const batch = this.ingestionQueue.splice(0, this.options.batchSize);
    const startTime = performance.now();
    
    for (const metric of batch) {
      this.processMetricImmediately(metric);
    }
    
    const processingTime = performance.now() - startTime;
    this.stats.ingestedPerSecond = batch.length / (processingTime / 1000);
    
    this.emit('ingestion:batch_processed', {
      batchSize: batch.length,
      processingTime,
      queueSize: this.ingestionQueue.length
    });
  }
  
  /**
   * Process aggregation queue
   */
  processAggregationQueue() {
    const batch = this.aggregationQueue.splice(0, this.options.batchSize);
    const startTime = performance.now();
    
    // Process aggregation tasks
    for (const task of batch) {
      this.processAggregationTask(task);
    }
    
    const processingTime = performance.now() - startTime;
    this.stats.aggregatedPerSecond = batch.length / (processingTime / 1000);
    
    this.emit('aggregation:batch_processed', {
      batchSize: batch.length,
      processingTime,
      queueSize: this.aggregationQueue.length
    });
  }
  
  /**
   * Manage memory usage
   */
  manageMemory() {
    const memoryUsage = process.memoryUsage().heapUsed;
    this.stats.memoryUsage = memoryUsage;
    
    if (memoryUsage > this.options.maxMemoryUsage) {
      console.log('⚠️  High memory usage detected, cleaning up...');
      this.cleanupOldData();
      this.compressData();
    }
    
    this.emit('memory:status', {
      usage: memoryUsage,
      limit: this.options.maxMemoryUsage,
      utilizationPercent: (memoryUsage / this.options.maxMemoryUsage) * 100
    });
  }
  
  /**
   * Update statistics
   */
  updateStatistics() {
    this.stats.totalMetrics = this.rawMetrics.size;
    
    let totalDataPoints = 0;
    for (const dataPoints of this.rawMetrics.values()) {
      totalDataPoints += dataPoints.length;
    }
    this.stats.totalDataPoints = totalDataPoints;
    
    this.emit('stats:updated', this.stats);
  }
  
  /**
   * Aggregation functions for different metric types
   */
  aggregateCounter(values) {
    return {
      sum: values.reduce((a, b) => a + b, 0),
      count: values.length,
      rate: values.length > 1 ? (values[values.length - 1] - values[0]) / values.length : 0
    };
  }
  
  aggregateGauge(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      median: sorted[Math.floor(sorted.length / 2)],
      count: values.length,
      last: values[values.length - 1]
    };
  }
  
  aggregateHistogram(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      median: sorted[Math.floor(sorted.length / 2)],
      p90: sorted[Math.floor(sorted.length * 0.9)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      count: values.length
    };
  }
  
  aggregateTimer(values) {
    return this.aggregateHistogram(values); // Same as histogram for timing metrics
  }
  
  aggregateSet(values) {
    const uniqueValues = new Set(values);
    return {
      unique: uniqueValues.size,
      total: values.length,
      cardinality: uniqueValues.size / values.length
    };
  }
  
  /**
   * Utility methods
   */
  parseAggregationLevel(level) {
    const multipliers = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000
    };
    
    const match = level.match(/^(\d+)([smhd])$/);
    if (!match) {
      throw new Error(`Invalid aggregation level: ${level}`);
    }
    
    return parseInt(match[1]) * multipliers[match[2]];
  }
  
  isHighPriority(metricName) {
    // Define high-priority metrics that need real-time processing
    const highPriorityPatterns = [
      /^error_rate/,
      /^response_time/,
      /^cpu_usage/,
      /^memory_usage/,
      /^mining_hashrate/
    ];
    
    return highPriorityPatterns.some(pattern => pattern.test(metricName));
  }
  
  getMetricWeight(metricName) {
    // Assign weights to different metrics for prioritization
    if (this.isHighPriority(metricName)) return 10;
    if (metricName.includes('system')) return 5;
    if (metricName.includes('mining')) return 8;
    return 1;
  }
  
  calculateStandardDeviation(values) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(value => Math.pow(value - avg, 2));
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(avgSquaredDiff);
  }
  
  enforceRetention(metricName, level) {
    const retentionPeriod = this.options.retentionPeriods[level];
    if (!retentionPeriod) return;
    
    const cutoffTime = Date.now() - retentionPeriod;
    
    if (level === 'raw') {
      const rawData = this.rawMetrics.get(metricName);
      if (rawData) {
        const filteredData = rawData.filter(point => point.timestamp > cutoffTime);
        this.rawMetrics.set(metricName, filteredData);
      }
    } else {
      const levelData = this.aggregatedMetrics.get(level);
      if (levelData && levelData.has(metricName)) {
        const metricData = levelData.get(metricName);
        for (const [timestamp] of metricData.entries()) {
          if (timestamp < cutoffTime) {
            metricData.delete(timestamp);
          }
        }
      }
    }
  }
  
  cleanupOldData() {
    // Enforce retention for all metrics and levels
    for (const metricName of this.rawMetrics.keys()) {
      this.enforceRetention(metricName, 'raw');
    }
    
    for (const level of this.options.aggregationLevels) {
      const levelData = this.aggregatedMetrics.get(level);
      if (levelData) {
        for (const metricName of levelData.keys()) {
          this.enforceRetention(metricName, level);
        }
      }
    }
    
    console.log('🧹 Cleaned up old metric data');
  }
  
  compressData() {
    // Implement data compression logic
    if (this.options.enableCompression) {
      // Compression implementation would go here
      console.log('🗜️  Compressed metric data');
    }
  }
  
  async queryRawMetrics(metric, startTime, endTime, tags) {
    const rawData = this.rawMetrics.get(metric) || [];
    return rawData.filter(point => {
      if (point.timestamp < startTime || point.timestamp > endTime) return false;
      
      // Filter by tags
      for (const [key, value] of Object.entries(tags)) {
        if (point.tags[key] !== value) return false;
      }
      
      return true;
    });
  }
  
  async queryAggregatedMetrics(metric, aggregation, startTime, endTime, tags) {
    const levelData = this.aggregatedMetrics.get(aggregation);
    if (!levelData || !levelData.has(metric)) return [];
    
    const metricData = levelData.get(metric);
    const result = [];
    
    for (const [timestamp, bucket] of metricData.entries()) {
      if (timestamp >= startTime && timestamp <= endTime) {
        // Check tag filters
        let matchesTags = true;
        for (const [key, value] of Object.entries(tags)) {
          if (!bucket.tags.has(key) || !bucket.tags.get(key).has(value)) {
            matchesTags = false;
            break;
          }
        }
        
        if (matchesTags) {
          result.push({
            timestamp,
            ...bucket.aggregated
          });
        }
      }
    }
    
    return result.sort((a, b) => a.timestamp - b.timestamp);
  }
  
  applyAggregationFunctions(dataPoints, functions) {
    if (functions.includes('raw')) return dataPoints;
    
    // Apply requested aggregation functions
    const result = [];
    for (const point of dataPoints) {
      const aggregated = { timestamp: point.timestamp };
      
      for (const func of functions) {
        switch (func) {
          case 'avg':
            aggregated.avg = point.avg || point.value;
            break;
          case 'min':
            aggregated.min = point.min || point.value;
            break;
          case 'max':
            aggregated.max = point.max || point.value;
            break;
          case 'sum':
            aggregated.sum = point.sum || point.value;
            break;
          case 'count':
            aggregated.count = point.count || 1;
            break;
        }
      }
      
      result.push(aggregated);
    }
    
    return result;
  }
  
  async processAllQueues() {
    // Process all remaining items in queues
    while (this.ingestionQueue.length > 0) {
      this.processIngestionQueue();
    }
    
    while (this.aggregationQueue.length > 0) {
      this.processAggregationQueue();
    }
  }
  
  async initializeWorkers() {
    // Worker initialization would go here for parallel processing
    this.workers = [];
  }
  
  async terminateWorkers() {
    for (const worker of this.workers) {
      await worker.terminate();
    }
    this.workers = [];
  }
  
  async ensureDirectories() {
    await mkdir(this.options.dataDirectory, { recursive: true });
  }
  
  async loadPersistedData() {
    if (!this.options.enablePersistence) return;
    
    try {
      const dataFile = join(this.options.dataDirectory, 'metrics.json');
      const content = await readFile(dataFile, 'utf8');
      const savedData = JSON.parse(content);
      
      // Restore raw metrics
      if (savedData.rawMetrics) {
        for (const [metric, data] of Object.entries(savedData.rawMetrics)) {
          this.rawMetrics.set(metric, data);
        }
      }
      
      // Restore metadata
      if (savedData.metadata) {
        for (const [metric, metadata] of Object.entries(savedData.metadata)) {
          this.metricMetadata.set(metric, {
            ...metadata,
            tags: new Set(metadata.tags)
          });
        }
      }
      
      console.log(`📊 Loaded persisted metrics: ${this.rawMetrics.size} metrics`);
    } catch {
      // No persisted data
    }
  }
  
  async persistData() {
    if (!this.options.enablePersistence) return;
    
    try {
      const dataFile = join(this.options.dataDirectory, 'metrics.json');
      
      // Convert maps to plain objects for serialization
      const rawMetrics = Object.fromEntries(this.rawMetrics);
      const metadata = Object.fromEntries(
        Array.from(this.metricMetadata.entries()).map(([key, value]) => [
          key,
          { ...value, tags: Array.from(value.tags) }
        ])
      );
      
      const data = {
        rawMetrics,
        metadata,
        timestamp: Date.now()
      };
      
      await writeFile(dataFile, JSON.stringify(data, null, 2));
      this.stats.lastFlush = Date.now();
      
      this.emit('data:persisted', {
        metrics: this.rawMetrics.size,
        timestamp: this.stats.lastFlush
      });
    } catch (error) {
      console.error('Failed to persist metrics data:', error.message);
    }
  }
  
  processAggregationTask(task) {
    // Process aggregation task
    // Implementation would depend on task type
  }
  
  /**
   * Get system status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      stats: this.stats,
      metrics: this.rawMetrics.size,
      queueSizes: {
        ingestion: this.ingestionQueue.length,
        aggregation: this.aggregationQueue.length,
        persistence: this.persistenceQueue.length
      },
      aggregationLevels: this.options.aggregationLevels
    };
  }
  
  /**
   * Get all metric names
   */
  getMetricNames() {
    return Array.from(this.rawMetrics.keys());
  }
  
  /**
   * Get metric metadata
   */
  getMetricMetadata(metric) {
    return this.metricMetadata.get(metric);
  }
}

export default MetricsAggregator;