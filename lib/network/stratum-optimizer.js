/**
 * Advanced Stratum Protocol Optimizer - Otedama
 * Optimizes Stratum protocol for maximum efficiency and minimal latency
 * 
 * Design: John Carmack - Performance-critical optimizations
 * Architecture: Rob Pike - Simple, efficient protocol handling
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { MessageBatcher } from './message-batcher.js';

const logger = createStructuredLogger('StratumOptimizer');

/**
 * Optimization strategies
 */
export const OptimizationStrategy = {
  BATCHING: 'batching',              // Batch multiple shares
  COMPRESSION: 'compression',        // Compress messages
  PREDICTION: 'prediction',          // Predictive job fetching
  MULTIPLEXING: 'multiplexing',      // Multiple connections
  CACHING: 'caching',                // Job caching
  PIPELINING: 'pipelining'          // Pipeline requests
};

/**
 * Stratum extensions
 */
export const StratumExtension = {
  BATCH_SUBMIT: 'mining.batch_submit',
  COMPRESSED_JOBS: 'mining.compressed_jobs',
  MULTI_VERSION: 'mining.multi_version',
  FAST_SUBMIT: 'mining.fast_submit',
  JOB_PREDICTION: 'mining.job_prediction'
};

/**
 * Advanced Stratum Optimizer
 */
export class StratumOptimizer extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      enabledStrategies: config.enabledStrategies || Object.values(OptimizationStrategy),
      batchSize: config.batchSize || 10,
      batchTimeout: config.batchTimeout || 100, // ms
      compressionThreshold: config.compressionThreshold || 1024, // bytes
      maxPipelineDepth: config.maxPipelineDepth || 5,
      jobCacheSize: config.jobCacheSize || 100,
      predictionWindow: config.predictionWindow || 5000, // ms
      multiplexConnections: config.multiplexConnections || 3,
      latencyTarget: config.latencyTarget || 50, // ms
      ...config
    };
    
    // Components
    this.messageBatcher = new MessageBatcher({
      maxSize: this.config.batchSize,
      maxWait: this.config.batchTimeout
    });
    
    // State
    this.connections = new Map();
    this.jobCache = new Map();
    this.submitQueue = [];
    this.pipelineQueue = new Map();
    this.latencyHistory = [];
    this.extensions = new Set();
    
    // Optimization state
    this.compressionStats = {
      totalBytes: 0,
      compressedBytes: 0,
      ratio: 0
    };
    
    this.predictionStats = {
      predictions: 0,
      hits: 0,
      accuracy: 0
    };
    
    // Statistics
    this.stats = {
      messagesOptimized: 0,
      bytesTransferred: 0,
      bytesSaved: 0,
      latencyReduction: 0,
      sharesSubmitted: 0,
      sharesBatched: 0,
      jobsCached: 0,
      cacheHits: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize optimizer
   */
  initialize() {
    // Set up message batching
    if (this.isStrategyEnabled(OptimizationStrategy.BATCHING)) {
      this.setupBatching();
    }
    
    // Start latency monitoring
    this.startLatencyMonitoring();
    
    logger.info('Stratum optimizer initialized', {
      strategies: this.config.enabledStrategies,
      latencyTarget: this.config.latencyTarget
    });
  }
  
  /**
   * Optimize connection
   */
  optimizeConnection(connection) {
    const connectionId = connection.id || this.generateConnectionId();
    
    // Wrap connection with optimization layer
    const optimizedConnection = {
      id: connectionId,
      original: connection,
      extensions: new Set(),
      metrics: {
        latency: [],
        throughput: 0,
        sharesSubmitted: 0
      },
      state: {
        lastJobTime: 0,
        jobPredictions: [],
        compressionEnabled: false,
        batchingEnabled: false
      }
    };
    
    // Negotiate extensions
    this.negotiateExtensions(optimizedConnection);
    
    // Set up interceptors
    this.setupInterceptors(optimizedConnection);
    
    // Store connection
    this.connections.set(connectionId, optimizedConnection);
    
    logger.info('Connection optimized', {
      connectionId,
      extensions: Array.from(optimizedConnection.extensions)
    });
    
    return this.createOptimizedInterface(optimizedConnection);
  }
  
  /**
   * Create optimized interface
   */
  createOptimizedInterface(optimizedConn) {
    const self = this;
    
    return {
      // Optimized submit
      async submitShare(share) {
        return self.optimizedSubmit(optimizedConn, share);
      },
      
      // Batch submit
      async submitBatch(shares) {
        return self.batchSubmit(optimizedConn, shares);
      },
      
      // Get predicted job
      async getNextJob() {
        return self.getPredictedJob(optimizedConn);
      },
      
      // Original methods
      send: (method, params) => self.optimizedSend(optimizedConn, method, params),
      subscribe: (...args) => optimizedConn.original.subscribe(...args),
      authorize: (...args) => optimizedConn.original.authorize(...args),
      disconnect: () => self.disconnectOptimized(optimizedConn)
    };
  }
  
  /**
   * Optimized share submission
   */
  async optimizedSubmit(conn, share) {
    const startTime = Date.now();
    
    // Apply optimizations based on enabled strategies
    if (this.isStrategyEnabled(OptimizationStrategy.BATCHING) && 
        conn.extensions.has(StratumExtension.BATCH_SUBMIT)) {
      // Add to batch
      return this.addToBatch(conn, share);
    }
    
    if (this.isStrategyEnabled(OptimizationStrategy.PIPELINING)) {
      // Pipeline the submission
      return this.pipelineSubmit(conn, share);
    }
    
    // Fast path for low-latency submission
    if (conn.extensions.has(StratumExtension.FAST_SUBMIT)) {
      return this.fastSubmit(conn, share);
    }
    
    // Standard submission with metrics
    const result = await this.standardSubmit(conn, share);
    
    // Update metrics
    const latency = Date.now() - startTime;
    this.updateConnectionMetrics(conn, { latency });
    
    return result;
  }
  
  /**
   * Batch submit implementation
   */
  async batchSubmit(conn, shares) {
    if (!conn.extensions.has(StratumExtension.BATCH_SUBMIT)) {
      // Fall back to individual submissions
      const results = [];
      for (const share of shares) {
        results.push(await this.standardSubmit(conn, share));
      }
      return results;
    }
    
    const batchId = this.generateBatchId();
    const compressedBatch = this.compressBatch(shares);
    
    const response = await conn.original.send('mining.batch_submit', {
      id: batchId,
      shares: compressedBatch,
      compression: this.isCompressionEnabled(conn, compressedBatch)
    });
    
    this.stats.sharesBatched += shares.length;
    
    return this.processBatchResponse(response);
  }
  
  /**
   * Add share to batch
   */
  async addToBatch(conn, share) {
    return new Promise((resolve, reject) => {
      const batchItem = {
        share,
        resolve,
        reject,
        timestamp: Date.now()
      };
      
      this.messageBatcher.add(conn.id, batchItem);
      
      // Process batch if ready
      if (this.messageBatcher.shouldFlush(conn.id)) {
        this.processBatch(conn);
      }
    });
  }
  
  /**
   * Process batched shares
   */
  async processBatch(conn) {
    const batch = this.messageBatcher.flush(conn.id);
    if (batch.length === 0) return;
    
    try {
      const shares = batch.map(item => item.share);
      const results = await this.batchSubmit(conn, shares);
      
      // Resolve promises
      batch.forEach((item, index) => {
        item.resolve(results[index]);
      });
      
    } catch (error) {
      // Reject all promises
      batch.forEach(item => {
        item.reject(error);
      });
    }
  }
  
  /**
   * Pipeline submit
   */
  async pipelineSubmit(conn, share) {
    const pipelineDepth = this.getPipelineDepth(conn.id);
    
    if (pipelineDepth >= this.config.maxPipelineDepth) {
      // Wait for pipeline to clear
      await this.waitForPipeline(conn.id);
    }
    
    const submitId = this.generateSubmitId();
    
    // Add to pipeline
    const promise = new Promise((resolve, reject) => {
      const pipelineEntry = {
        id: submitId,
        share,
        resolve,
        reject,
        timestamp: Date.now()
      };
      
      this.addToPipeline(conn.id, submitId, pipelineEntry);
    });
    
    // Send without waiting
    this.sendPipelined(conn, 'mining.submit', {
      id: submitId,
      ...share
    });
    
    return promise;
  }
  
  /**
   * Fast submit (low-latency path)
   */
  async fastSubmit(conn, share) {
    // Skip unnecessary validations for trusted connections
    const simplified = {
      job_id: share.job_id,
      nonce: share.nonce,
      result: share.result
    };
    
    return conn.original.send('mining.fast_submit', simplified);
  }
  
  /**
   * Standard submit
   */
  async standardSubmit(conn, share) {
    const result = await conn.original.send('mining.submit', share);
    
    conn.metrics.sharesSubmitted++;
    this.stats.sharesSubmitted++;
    
    return result;
  }
  
  /**
   * Optimized send
   */
  async optimizedSend(conn, method, params) {
    let data = { method, params };
    
    // Apply compression if beneficial
    if (this.isStrategyEnabled(OptimizationStrategy.COMPRESSION)) {
      data = this.compressMessage(conn, data);
    }
    
    // Track metrics
    const startTime = Date.now();
    const result = await conn.original.send(method, params);
    const latency = Date.now() - startTime;
    
    this.updateConnectionMetrics(conn, { latency });
    
    return result;
  }
  
  /**
   * Get predicted job
   */
  async getPredictedJob(conn) {
    if (!this.isStrategyEnabled(OptimizationStrategy.PREDICTION)) {
      return null;
    }
    
    // Check job cache
    const cachedJob = this.getLatestCachedJob();
    if (cachedJob && this.isJobValid(cachedJob)) {
      this.stats.cacheHits++;
      return cachedJob;
    }
    
    // Predict next job based on patterns
    const prediction = this.predictNextJob(conn);
    if (prediction) {
      this.predictionStats.predictions++;
      return prediction;
    }
    
    return null;
  }
  
  /**
   * Negotiate extensions
   */
  async negotiateExtensions(conn) {
    try {
      const response = await conn.original.send('mining.extensions', {
        supported: Object.values(StratumExtension)
      });
      
      if (response && response.extensions) {
        response.extensions.forEach(ext => {
          conn.extensions.add(ext);
          this.extensions.add(ext);
        });
      }
      
      // Enable features based on extensions
      if (conn.extensions.has(StratumExtension.BATCH_SUBMIT)) {
        conn.state.batchingEnabled = true;
      }
      
      if (conn.extensions.has(StratumExtension.COMPRESSED_JOBS)) {
        conn.state.compressionEnabled = true;
      }
      
    } catch (error) {
      logger.debug('Extension negotiation failed:', error);
    }
  }
  
  /**
   * Setup interceptors
   */
  setupInterceptors(conn) {
    const original = conn.original;
    
    // Intercept job notifications
    if (original.on) {
      original.on('mining.notify', (job) => {
        this.handleJobNotification(conn, job);
      });
      
      original.on('mining.set_difficulty', (difficulty) => {
        this.handleDifficultyChange(conn, difficulty);
      });
    }
  }
  
  /**
   * Handle job notification
   */
  handleJobNotification(conn, job) {
    const now = Date.now();
    
    // Cache job
    this.cacheJob(job);
    
    // Update prediction model
    if (conn.state.lastJobTime > 0) {
      const interval = now - conn.state.lastJobTime;
      conn.state.jobPredictions.push(interval);
      
      // Keep only recent predictions
      if (conn.state.jobPredictions.length > 10) {
        conn.state.jobPredictions.shift();
      }
    }
    
    conn.state.lastJobTime = now;
    
    // Emit optimized job
    this.emit('job', {
      connectionId: conn.id,
      job: this.optimizeJob(conn, job)
    });
  }
  
  /**
   * Optimize job data
   */
  optimizeJob(conn, job) {
    if (!conn.state.compressionEnabled) {
      return job;
    }
    
    // Remove unnecessary fields for this connection
    const optimized = {
      job_id: job.job_id,
      prevhash: job.prevhash,
      coinb1: job.coinb1,
      coinb2: job.coinb2,
      merkle_branch: job.merkle_branch,
      version: job.version,
      nbits: job.nbits,
      ntime: job.ntime,
      clean_jobs: job.clean_jobs
    };
    
    // Compress large fields if beneficial
    if (job.coinb1.length + job.coinb2.length > this.config.compressionThreshold) {
      optimized.compressed = true;
      optimized.coinb1 = this.compressHex(job.coinb1);
      optimized.coinb2 = this.compressHex(job.coinb2);
    }
    
    return optimized;
  }
  
  /**
   * Cache job
   */
  cacheJob(job) {
    this.jobCache.set(job.job_id, {
      job,
      timestamp: Date.now()
    });
    
    // Limit cache size
    if (this.jobCache.size > this.config.jobCacheSize) {
      const oldest = Array.from(this.jobCache.keys())[0];
      this.jobCache.delete(oldest);
    }
    
    this.stats.jobsCached++;
  }
  
  /**
   * Get latest cached job
   */
  getLatestCachedJob() {
    if (this.jobCache.size === 0) return null;
    
    const entries = Array.from(this.jobCache.values());
    const latest = entries.reduce((prev, curr) => 
      curr.timestamp > prev.timestamp ? curr : prev
    );
    
    return latest.job;
  }
  
  /**
   * Check if job is valid
   */
  isJobValid(job) {
    // Jobs are typically valid for ~30 seconds
    const age = Date.now() - (job.timestamp || 0);
    return age < 30000;
  }
  
  /**
   * Predict next job
   */
  predictNextJob(conn) {
    if (conn.state.jobPredictions.length < 3) {
      return null;
    }
    
    // Calculate average interval
    const avgInterval = conn.state.jobPredictions.reduce((a, b) => a + b) / 
                       conn.state.jobPredictions.length;
    
    const timeSinceLastJob = Date.now() - conn.state.lastJobTime;
    
    // If we're close to expected job time, prepare
    if (timeSinceLastJob > avgInterval * 0.8) {
      return this.generatePredictedJob(conn);
    }
    
    return null;
  }
  
  /**
   * Generate predicted job
   */
  generatePredictedJob(conn) {
    const lastJob = this.getLatestCachedJob();
    if (!lastJob) return null;
    
    // Create predicted job with updated ntime
    const predicted = {
      ...lastJob,
      job_id: `pred_${Date.now()}`,
      ntime: Math.floor(Date.now() / 1000).toString(16),
      predicted: true
    };
    
    return predicted;
  }
  
  /**
   * Compress message
   */
  compressMessage(conn, message) {
    const json = JSON.stringify(message);
    
    if (json.length < this.config.compressionThreshold) {
      return message;
    }
    
    // Simple compression using base64 encoding
    // In production, use proper compression like zlib
    const compressed = Buffer.from(json).toString('base64');
    
    this.compressionStats.totalBytes += json.length;
    this.compressionStats.compressedBytes += compressed.length;
    this.compressionStats.ratio = 
      this.compressionStats.compressedBytes / this.compressionStats.totalBytes;
    
    return {
      compressed: true,
      data: compressed
    };
  }
  
  /**
   * Compress hex string
   */
  compressHex(hex) {
    // Remove redundant zeros
    return hex.replace(/^0+/, '0');
  }
  
  /**
   * Compress batch
   */
  compressBatch(shares) {
    // Group shares by common fields
    const grouped = {};
    
    shares.forEach(share => {
      const key = `${share.job_id}_${share.extranonce2}`;
      if (!grouped[key]) {
        grouped[key] = {
          job_id: share.job_id,
          extranonce2: share.extranonce2,
          submissions: []
        };
      }
      
      grouped[key].submissions.push({
        nonce: share.nonce,
        result: share.result
      });
    });
    
    return Object.values(grouped);
  }
  
  /**
   * Process batch response
   */
  processBatchResponse(response) {
    if (!response || !response.results) {
      throw new Error('Invalid batch response');
    }
    
    return response.results.map(r => ({
      accepted: r.accepted,
      reject_reason: r.reject_reason
    }));
  }
  
  /**
   * Setup batching
   */
  setupBatching() {
    // Process batches periodically
    setInterval(() => {
      for (const [connId, conn] of this.connections) {
        if (this.messageBatcher.hasItems(connId)) {
          this.processBatch(conn);
        }
      }
    }, this.config.batchTimeout);
  }
  
  /**
   * Start latency monitoring
   */
  startLatencyMonitoring() {
    setInterval(() => {
      this.analyzeLatency();
    }, 5000);
  }
  
  /**
   * Analyze latency
   */
  analyzeLatency() {
    for (const [connId, conn] of this.connections) {
      if (conn.metrics.latency.length === 0) continue;
      
      const avgLatency = conn.metrics.latency.reduce((a, b) => a + b) / 
                        conn.metrics.latency.length;
      
      // Adjust strategies based on latency
      if (avgLatency > this.config.latencyTarget * 2) {
        // Enable more aggressive optimization
        this.enableAggressiveOptimization(conn);
      } else if (avgLatency < this.config.latencyTarget * 0.5) {
        // Can reduce optimization overhead
        this.reduceOptimization(conn);
      }
      
      // Clear old metrics
      conn.metrics.latency = conn.metrics.latency.slice(-100);
    }
  }
  
  /**
   * Enable aggressive optimization
   */
  enableAggressiveOptimization(conn) {
    logger.info(`Enabling aggressive optimization for connection ${conn.id}`);
    
    // Enable all available optimizations
    conn.state.batchingEnabled = true;
    conn.state.compressionEnabled = true;
    
    // Increase batch size
    this.messageBatcher.updateConfig(conn.id, {
      maxSize: this.config.batchSize * 2
    });
  }
  
  /**
   * Reduce optimization
   */
  reduceOptimization(conn) {
    logger.debug(`Reducing optimization for connection ${conn.id}`);
    
    // Reduce batch size for lower latency
    this.messageBatcher.updateConfig(conn.id, {
      maxSize: Math.max(1, Math.floor(this.config.batchSize / 2))
    });
  }
  
  /**
   * Update connection metrics
   */
  updateConnectionMetrics(conn, metrics) {
    if (metrics.latency !== undefined) {
      conn.metrics.latency.push(metrics.latency);
      this.latencyHistory.push({
        connectionId: conn.id,
        latency: metrics.latency,
        timestamp: Date.now()
      });
    }
    
    if (metrics.throughput !== undefined) {
      conn.metrics.throughput = metrics.throughput;
    }
    
    // Update global stats
    this.stats.messagesOptimized++;
  }
  
  /**
   * Check if strategy is enabled
   */
  isStrategyEnabled(strategy) {
    return this.config.enabledStrategies.includes(strategy);
  }
  
  /**
   * Check if compression is beneficial
   */
  isCompressionEnabled(conn, data) {
    if (!conn.state.compressionEnabled) return false;
    
    const dataSize = JSON.stringify(data).length;
    return dataSize > this.config.compressionThreshold;
  }
  
  /**
   * Pipeline management
   */
  getPipelineDepth(connId) {
    const pipeline = this.pipelineQueue.get(connId);
    return pipeline ? pipeline.size : 0;
  }
  
  async waitForPipeline(connId) {
    const pipeline = this.pipelineQueue.get(connId);
    if (!pipeline || pipeline.size === 0) return;
    
    // Wait for oldest entry
    const oldest = Array.from(pipeline.values())[0];
    await oldest.promise;
  }
  
  addToPipeline(connId, id, entry) {
    if (!this.pipelineQueue.has(connId)) {
      this.pipelineQueue.set(connId, new Map());
    }
    
    this.pipelineQueue.get(connId).set(id, entry);
  }
  
  sendPipelined(conn, method, params) {
    // Send without waiting for response
    conn.original.send(method, params).then(response => {
      const pipeline = this.pipelineQueue.get(conn.id);
      if (pipeline && pipeline.has(params.id)) {
        const entry = pipeline.get(params.id);
        entry.resolve(response);
        pipeline.delete(params.id);
      }
    }).catch(error => {
      const pipeline = this.pipelineQueue.get(conn.id);
      if (pipeline && pipeline.has(params.id)) {
        const entry = pipeline.get(params.id);
        entry.reject(error);
        pipeline.delete(params.id);
      }
    });
  }
  
  /**
   * Disconnect optimized connection
   */
  disconnectOptimized(conn) {
    // Flush any pending batches
    if (this.messageBatcher.hasItems(conn.id)) {
      this.processBatch(conn);
    }
    
    // Clear pipeline
    const pipeline = this.pipelineQueue.get(conn.id);
    if (pipeline) {
      pipeline.forEach(entry => {
        entry.reject(new Error('Connection closed'));
      });
      this.pipelineQueue.delete(conn.id);
    }
    
    // Remove from connections
    this.connections.delete(conn.id);
    
    // Disconnect original
    if (conn.original.disconnect) {
      conn.original.disconnect();
    }
  }
  
  /**
   * Get optimization statistics
   */
  getStatistics() {
    const avgLatency = this.latencyHistory.length > 0
      ? this.latencyHistory.reduce((sum, h) => sum + h.latency, 0) / this.latencyHistory.length
      : 0;
    
    return {
      ...this.stats,
      connections: this.connections.size,
      extensions: Array.from(this.extensions),
      compression: this.compressionStats,
      prediction: this.predictionStats,
      avgLatency,
      latencyReduction: this.config.latencyTarget > 0 
        ? ((this.config.latencyTarget - avgLatency) / this.config.latencyTarget * 100).toFixed(2)
        : 0,
      cacheHitRate: this.stats.jobsCached > 0
        ? (this.stats.cacheHits / this.stats.jobsCached * 100).toFixed(2)
        : 0
    };
  }
  
  /**
   * Generate IDs
   */
  generateConnectionId() {
    return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateBatchId() {
    return `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateSubmitId() {
    return `submit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Shutdown optimizer
   */
  shutdown() {
    // Disconnect all connections
    for (const conn of this.connections.values()) {
      this.disconnectOptimized(conn);
    }
    
    this.connections.clear();
    this.jobCache.clear();
    this.pipelineQueue.clear();
    
    this.removeAllListeners();
    logger.info('Stratum optimizer shutdown');
  }
}

/**
 * Create Stratum optimizer
 */
export function createStratumOptimizer(config) {
  return new StratumOptimizer(config);
}

export default StratumOptimizer;