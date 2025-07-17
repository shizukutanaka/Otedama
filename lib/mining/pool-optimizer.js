/**
 * Mining Pool Performance Optimizer for Otedama
 * Implements advanced optimization techniques for high-performance mining
 */

import { EventEmitter } from 'events';
import { WorkerPool } from '../worker-pool.js';
import { MemoryCache } from '../memory-cache.js';

export class PoolOptimizer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      shareValidationWorkers: options.shareValidationWorkers || 4,
      cacheSize: options.cacheSize || 10000,
      batchSize: options.batchSize || 100,
      ...options
    };
    
    // Initialize worker pool for share validation
    this.validationPool = new WorkerPool({
      workerScript: './workers/share-validator.js',
      maxWorkers: this.options.shareValidationWorkers,
      taskTimeout: 5000
    });
    
    // Share validation cache
    this.shareCache = new MemoryCache({
      maxSize: this.options.cacheSize,
      ttl: 300000 // 5 minutes
    });
    
    // Batch processing queue
    this.shareBatch = [];
    this.batchTimer = null;
    
    // Performance metrics
    this.metrics = {
      sharesProcessed: 0,
      sharesCached: 0,
      validationTime: [],
      batchesProcessed: 0
    };
  }
  
  /**
   * Validate share with caching and parallel processing
   */
  async validateShare(job, nonce, hash, difficulty) {
    const cacheKey = `${job.id}:${nonce}:${hash}`;
    
    // Check cache first
    const cached = this.shareCache.get(cacheKey);
    if (cached !== undefined) {
      this.metrics.sharesCached++;
      return cached;
    }
    
    const startTime = Date.now();
    
    try {
      // Validate using worker pool
      const result = await this.validationPool.execute({
        job,
        nonce,
        hash,
        difficulty
      });
      
      // Cache result
      this.shareCache.set(cacheKey, result);
      
      // Update metrics
      this.metrics.sharesProcessed++;
      this.metrics.validationTime.push(Date.now() - startTime);
      
      // Keep only last 1000 timing samples
      if (this.metrics.validationTime.length > 1000) {
        this.metrics.validationTime.shift();
      }
      
      return result;
    } catch (error) {
      this.emit('error', {
        type: 'share_validation',
        error: error.message
      });
      return false;
    }
  }
  
  /**
   * Batch process shares for efficiency
   */
  addShareToBatch(shareData) {
    this.shareBatch.push(shareData);
    
    if (this.shareBatch.length >= this.options.batchSize) {
      this.processBatch();
    } else if (!this.batchTimer) {
      // Process batch after 100ms if not full
      this.batchTimer = setTimeout(() => this.processBatch(), 100);
    }
  }
  
  /**
   * Process batch of shares
   */
  async processBatch() {
    if (this.shareBatch.length === 0) return;
    
    const batch = this.shareBatch.splice(0, this.options.batchSize);
    this.batchTimer = null;
    
    try {
      // Process all shares in parallel
      const results = await Promise.all(
        batch.map(share => this.validateShare(
          share.job,
          share.nonce,
          share.hash,
          share.difficulty
        ))
      );
      
      this.metrics.batchesProcessed++;
      
      this.emit('batch:processed', {
        size: batch.length,
        results
      });
      
      return results;
    } catch (error) {
      this.emit('error', {
        type: 'batch_processing',
        error: error.message
      });
    }
  }
  
  /**
   * Optimize difficulty adjustment using historical data
   */
  optimizeDifficulty(minerStats) {
    const { shares, targetShareRate } = minerStats;
    
    if (shares.length < 20) {
      return minerStats.currentDifficulty;
    }
    
    // Calculate actual share rate
    const timeWindow = Date.now() - shares[0].timestamp;
    const actualShareRate = (shares.length * 60000) / timeWindow; // shares per minute
    
    // Use exponential moving average for smoother adjustments
    const alpha = 0.2; // Smoothing factor
    const rateRatio = targetShareRate / actualShareRate;
    const adjustmentFactor = 1 + (alpha * (rateRatio - 1));
    
    // Apply bounds
    const newDifficulty = minerStats.currentDifficulty * adjustmentFactor;
    const minDiff = minerStats.minDifficulty || 1;
    const maxDiff = minerStats.maxDifficulty || 65536;
    
    return Math.max(minDiff, Math.min(maxDiff, newDifficulty));
  }
  
  /**
   * Get performance metrics
   */
  getMetrics() {
    const avgValidationTime = this.metrics.validationTime.length > 0
      ? this.metrics.validationTime.reduce((a, b) => a + b, 0) / this.metrics.validationTime.length
      : 0;
    
    return {
      sharesProcessed: this.metrics.sharesProcessed,
      sharesCached: this.metrics.sharesCached,
      cacheHitRate: this.metrics.sharesProcessed > 0
        ? (this.metrics.sharesCached / this.metrics.sharesProcessed) * 100
        : 0,
      avgValidationTime,
      batchesProcessed: this.metrics.batchesProcessed,
      workerPoolStats: this.validationPool.getStats()
    };
  }
  
  /**
   * Cleanup resources
   */
  async shutdown() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    
    // Process remaining shares
    await this.processBatch();
    
    // Shutdown worker pool
    await this.validationPool.terminate();
    
    // Clear cache
    this.shareCache.clear();
  }
}

/**
 * Connection pool for managing miner connections efficiently
 */
export class ConnectionPool {
  constructor(options = {}) {
    this.options = {
      maxConnections: options.maxConnections || 10000,
      connectionTimeout: options.connectionTimeout || 300000, // 5 minutes
      pingInterval: options.pingInterval || 30000, // 30 seconds
      ...options
    };
    
    this.connections = new Map();
    this.connectionStats = new Map();
    
    // Start ping interval
    this.pingTimer = setInterval(() => this.pingConnections(), this.options.pingInterval);
  }
  
  /**
   * Add connection to pool
   */
  addConnection(minerKey, connection) {
    if (this.connections.size >= this.options.maxConnections) {
      // Remove oldest inactive connection
      this.removeInactiveConnection();
    }
    
    this.connections.set(minerKey, {
      connection,
      lastActivity: Date.now(),
      pingFailures: 0
    });
    
    // Initialize stats
    if (!this.connectionStats.has(minerKey)) {
      this.connectionStats.set(minerKey, {
        connected: Date.now(),
        bytesReceived: 0,
        bytesSent: 0,
        messagesReceived: 0,
        messagesSent: 0
      });
    }
  }
  
  /**
   * Update connection activity
   */
  updateActivity(minerKey, bytesReceived = 0, bytesSent = 0) {
    const conn = this.connections.get(minerKey);
    if (conn) {
      conn.lastActivity = Date.now();
      conn.pingFailures = 0;
    }
    
    const stats = this.connectionStats.get(minerKey);
    if (stats) {
      stats.bytesReceived += bytesReceived;
      stats.bytesSent += bytesSent;
      stats.messagesReceived += bytesReceived > 0 ? 1 : 0;
      stats.messagesSent += bytesSent > 0 ? 1 : 0;
    }
  }
  
  /**
   * Ping all connections
   */
  pingConnections() {
    const now = Date.now();
    
    for (const [minerKey, conn] of this.connections) {
      if (now - conn.lastActivity > this.options.connectionTimeout) {
        // Connection timeout
        this.removeConnection(minerKey, 'timeout');
      } else {
        // Send ping
        try {
          conn.connection.ping();
        } catch (error) {
          conn.pingFailures++;
          if (conn.pingFailures > 3) {
            this.removeConnection(minerKey, 'ping_failure');
          }
        }
      }
    }
  }
  
  /**
   * Remove connection
   */
  removeConnection(minerKey, reason) {
    const conn = this.connections.get(minerKey);
    if (conn) {
      try {
        conn.connection.close();
      } catch (error) {
        // Ignore close errors
      }
      this.connections.delete(minerKey);
    }
  }
  
  /**
   * Remove oldest inactive connection
   */
  removeInactiveConnection() {
    let oldestKey = null;
    let oldestTime = Date.now();
    
    for (const [key, conn] of this.connections) {
      if (conn.lastActivity < oldestTime) {
        oldestTime = conn.lastActivity;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.removeConnection(oldestKey, 'max_connections');
    }
  }
  
  /**
   * Get connection statistics
   */
  getStats() {
    const stats = {
      totalConnections: this.connections.size,
      activeConnections: 0,
      totalBytesReceived: 0,
      totalBytesSent: 0
    };
    
    const now = Date.now();
    
    for (const [minerKey, conn] of this.connections) {
      if (now - conn.lastActivity < 60000) {
        stats.activeConnections++;
      }
    }
    
    for (const connStats of this.connectionStats.values()) {
      stats.totalBytesReceived += connStats.bytesReceived;
      stats.totalBytesSent += connStats.bytesSent;
    }
    
    return stats;
  }
  
  /**
   * Cleanup
   */
  shutdown() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
    }
    
    // Close all connections
    for (const minerKey of this.connections.keys()) {
      this.removeConnection(minerKey, 'shutdown');
    }
  }
}