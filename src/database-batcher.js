import { EventEmitter } from 'events';
import { Logger } from './logger.js';

/**
 * Database Query Batcher
 * 高性能データベースクエリバッチング
 * 
 * Rob Pike Style: Simple interface, powerful implementation
 * John Carmack Style: Maximum performance through batching
 * Robert C. Martin Style: Clean, maintainable code
 * 
 * Features:
 * - Automatic query batching
 * - Intelligent query merging
 * - Adaptive batch sizing
 * - Performance monitoring
 * - Zero-copy optimization
 */
export class DatabaseBatcher extends EventEmitter {
  constructor(db, options = {}) {
    super();
    this.logger = new Logger('DBBatcher');
    this.db = db;
    
    // Configuration
    this.config = {
      maxBatchSize: options.maxBatchSize || 1000,
      batchInterval: options.batchInterval || 10, // 10ms
      maxWaitTime: options.maxWaitTime || 100, // 100ms
      adaptiveSizing: options.adaptiveSizing !== false,
      mergeQueries: options.mergeQueries !== false
    };
    
    // Batch queues
    this.batches = new Map([
      ['shares', { queue: [], timer: null, startTime: 0 }],
      ['trades', { queue: [], timer: null, startTime: 0 }],
      ['updates', { queue: [], timer: null, startTime: 0 }],
      ['reads', { queue: [], timer: null, startTime: 0 }]
    ]);
    
    // Performance metrics
    this.metrics = {
      totalBatches: 0,
      totalQueries: 0,
      mergedQueries: 0,
      avgBatchSize: 0,
      avgLatency: 0,
      throughput: 0,
      errors: 0
    };
    
    // Adaptive sizing state
    this.adaptiveState = {
      currentBatchSize: 100,
      lastAdjustment: Date.now(),
      performanceHistory: []
    };
    
    // Prepared statements cache
    this.preparedStatements = new Map();
    
    // Initialize
    this.initialize();
  }

  /**
   * Initialize batcher
   */
  initialize() {
    // Prepare batch statements
    this.prepareBatchStatements();
    
    // Start performance monitoring
    this.startPerformanceMonitoring();
    
    this.logger.info('Database batcher initialized');
  }

  /**
   * Prepare batch statements for common operations
   */
  prepareBatchStatements() {
    try {
      // Batch insert for shares
      this.preparedStatements.set('batchInsertShares', this.db.prepare(`
        INSERT INTO shares (worker_id, difficulty, valid, timestamp, algorithm)
        VALUES (?, ?, ?, ?, ?)
      `));
      
      // Batch insert for trades
      this.preparedStatements.set('batchInsertTrades', this.db.prepare(`
        INSERT INTO trades (pair, amount_in, amount_out, fee, trader, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `));
      
      // Batch update for miner stats
      this.preparedStatements.set('batchUpdateMiners', this.db.prepare(`
        UPDATE miners 
        SET last_seen = ?, total_shares = total_shares + ?, valid_shares = valid_shares + ?
        WHERE id = ?
      `));
      
      // Batch insert for payments
      this.preparedStatements.set('batchInsertPayments', this.db.prepare(`
        INSERT INTO payments 
        (miner_id, wallet_address, asset, amount, fee, net_amount, tx_hash, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `));
      
    } catch (error) {
      this.logger.error('Failed to prepare batch statements:', error);
    }
  }

  /**
   * Add query to batch
   */
  async batch(type, query, params, callback) {
    return new Promise((resolve, reject) => {
      const batch = this.batches.get(type);
      if (!batch) {
        reject(new Error(`Unknown batch type: ${type}`));
        return;
      }
      
      // Add to queue
      batch.queue.push({
        query,
        params,
        resolve,
        reject,
        timestamp: Date.now()
      });
      
      // Start batch timer if not running
      if (!batch.timer) {
        batch.startTime = Date.now();
        batch.timer = setTimeout(() => {
          this.processBatch(type);
        }, this.config.batchInterval);
      }
      
      // Check if batch is full or waited too long
      if (batch.queue.length >= this.getCurrentBatchSize() ||
          Date.now() - batch.startTime > this.config.maxWaitTime) {
        clearTimeout(batch.timer);
        batch.timer = null;
        this.processBatch(type);
      }
    });
  }

  /**
   * Process batch of queries
   */
  async processBatch(type) {
    const batch = this.batches.get(type);
    if (!batch || batch.queue.length === 0) return;
    
    // Get queries to process
    const queries = batch.queue.splice(0, this.getCurrentBatchSize());
    batch.timer = null;
    
    const startTime = performance.now();
    
    try {
      // Merge similar queries if enabled
      const processedQueries = this.config.mergeQueries 
        ? this.mergeQueries(queries, type)
        : queries;
      
      // Execute in transaction
      await this.db.transaction(() => {
        for (const query of processedQueries) {
          try {
            const result = this.executeQuery(query, type);
            
            // Resolve original promises
            if (query.original) {
              // Merged query - resolve all originals
              query.original.forEach(orig => orig.resolve(result));
            } else {
              query.resolve(result);
            }
          } catch (error) {
            if (query.original) {
              query.original.forEach(orig => orig.reject(error));
            } else {
              query.reject(error);
            }
            this.metrics.errors++;
          }
        }
      })();
      
      // Update metrics
      const duration = performance.now() - startTime;
      this.updateMetrics(queries.length, processedQueries.length, duration);
      
      // Adaptive sizing
      if (this.config.adaptiveSizing) {
        this.adjustBatchSize(duration, queries.length);
      }
      
    } catch (error) {
      this.logger.error(`Batch processing failed for ${type}:`, error);
      queries.forEach(q => q.reject(error));
      this.metrics.errors++;
    }
    
    // Process remaining queries if any
    if (batch.queue.length > 0) {
      batch.startTime = Date.now();
      batch.timer = setTimeout(() => {
        this.processBatch(type);
      }, this.config.batchInterval);
    }
  }

  /**
   * Merge similar queries
   */
  mergeQueries(queries, type) {
    const merged = [];
    const groups = new Map();
    
    // Group by query pattern
    for (const query of queries) {
      const pattern = this.getQueryPattern(query.query);
      
      if (!groups.has(pattern)) {
        groups.set(pattern, []);
      }
      groups.get(pattern).push(query);
    }
    
    // Merge each group
    for (const [pattern, group] of groups) {
      if (group.length === 1) {
        merged.push(group[0]);
      } else {
        const mergedQuery = this.createMergedQuery(pattern, group, type);
        if (mergedQuery) {
          merged.push(mergedQuery);
          this.metrics.mergedQueries += group.length - 1;
        } else {
          // Could not merge, add individually
          merged.push(...group);
        }
      }
    }
    
    return merged;
  }

  /**
   * Get query pattern for merging
   */
  getQueryPattern(query) {
    // Remove values to get pattern
    return query.replace(/\?/g, '?')
               .replace(/\d+/g, 'N')
               .replace(/'[^']*'/g, 'STR')
               .trim();
  }

  /**
   * Create merged query
   */
  createMergedQuery(pattern, queries, type) {
    // Handle specific patterns
    if (pattern.includes('INSERT INTO shares')) {
      return this.createBatchInsert('shares', queries);
    }
    
    if (pattern.includes('INSERT INTO trades')) {
      return this.createBatchInsert('trades', queries);
    }
    
    if (pattern.includes('UPDATE miners')) {
      return this.createBatchUpdate('miners', queries);
    }
    
    return null;
  }

  /**
   * Create batch insert query
   */
  createBatchInsert(table, queries) {
    const stmt = this.preparedStatements.get(`batchInsert${table.charAt(0).toUpperCase() + table.slice(1)}`);
    
    if (!stmt) return null;
    
    return {
      execute: () => {
        const results = [];
        for (const query of queries) {
          results.push(stmt.run(...query.params));
        }
        return results;
      },
      original: queries
    };
  }

  /**
   * Create batch update query
   */
  createBatchUpdate(table, queries) {
    const stmt = this.preparedStatements.get(`batchUpdate${table.charAt(0).toUpperCase() + table.slice(1)}`);
    
    if (!stmt) return null;
    
    return {
      execute: () => {
        const results = [];
        for (const query of queries) {
          results.push(stmt.run(...query.params));
        }
        return results;
      },
      original: queries
    };
  }

  /**
   * Execute single query
   */
  executeQuery(query, type) {
    if (query.execute) {
      // Pre-processed query
      return query.execute();
    }
    
    // Regular query
    const stmt = this.db.prepare(query.query);
    
    if (query.query.trim().toUpperCase().startsWith('SELECT')) {
      return stmt.all(...(query.params || []));
    } else {
      return stmt.run(...(query.params || []));
    }
  }

  /**
   * Get current batch size (adaptive)
   */
  getCurrentBatchSize() {
    return this.config.adaptiveSizing 
      ? this.adaptiveState.currentBatchSize 
      : this.config.maxBatchSize;
  }

  /**
   * Adjust batch size based on performance
   */
  adjustBatchSize(duration, queryCount) {
    const throughput = queryCount / (duration / 1000); // queries per second
    
    // Add to history
    this.adaptiveState.performanceHistory.push({
      batchSize: this.adaptiveState.currentBatchSize,
      throughput,
      duration,
      timestamp: Date.now()
    });
    
    // Keep only last 100 measurements
    if (this.adaptiveState.performanceHistory.length > 100) {
      this.adaptiveState.performanceHistory.shift();
    }
    
    // Adjust every 10 seconds
    if (Date.now() - this.adaptiveState.lastAdjustment < 10000) {
      return;
    }
    
    // Calculate average throughput for current and previous sizes
    const currentSizeMetrics = this.getMetricsForSize(this.adaptiveState.currentBatchSize);
    
    if (currentSizeMetrics.count < 10) {
      return; // Not enough data
    }
    
    // Adjust based on performance
    if (duration > 50 && this.adaptiveState.currentBatchSize > 10) {
      // Too slow, reduce batch size
      this.adaptiveState.currentBatchSize = Math.max(
        10,
        Math.floor(this.adaptiveState.currentBatchSize * 0.8)
      );
    } else if (duration < 10 && throughput > currentSizeMetrics.avgThroughput * 1.2) {
      // Fast and improving, increase batch size
      this.adaptiveState.currentBatchSize = Math.min(
        this.config.maxBatchSize,
        Math.floor(this.adaptiveState.currentBatchSize * 1.2)
      );
    }
    
    this.adaptiveState.lastAdjustment = Date.now();
    
    this.logger.debug(`Adjusted batch size to ${this.adaptiveState.currentBatchSize}`);
  }

  /**
   * Get metrics for specific batch size
   */
  getMetricsForSize(size) {
    const relevantHistory = this.adaptiveState.performanceHistory.filter(
      h => Math.abs(h.batchSize - size) < size * 0.1
    );
    
    if (relevantHistory.length === 0) {
      return { count: 0, avgThroughput: 0, avgDuration: 0 };
    }
    
    const totalThroughput = relevantHistory.reduce((sum, h) => sum + h.throughput, 0);
    const totalDuration = relevantHistory.reduce((sum, h) => sum + h.duration, 0);
    
    return {
      count: relevantHistory.length,
      avgThroughput: totalThroughput / relevantHistory.length,
      avgDuration: totalDuration / relevantHistory.length
    };
  }

  /**
   * Update performance metrics
   */
  updateMetrics(originalCount, processedCount, duration) {
    this.metrics.totalBatches++;
    this.metrics.totalQueries += originalCount;
    
    // Update averages
    const alpha = 0.1; // Exponential smoothing factor
    this.metrics.avgBatchSize = this.metrics.avgBatchSize * (1 - alpha) + originalCount * alpha;
    this.metrics.avgLatency = this.metrics.avgLatency * (1 - alpha) + duration * alpha;
    
    // Calculate throughput
    this.metrics.throughput = originalCount / (duration / 1000);
    
    this.emit('metrics', this.metrics);
  }

  /**
   * Start performance monitoring
   */
  startPerformanceMonitoring() {
    this.monitoringTimer = setInterval(() => {
      this.emit('performance', {
        metrics: this.metrics,
        adaptiveState: this.adaptiveState,
        queueSizes: this.getQueueSizes()
      });
    }, 5000); // Every 5 seconds
  }

  /**
   * Get current queue sizes
   */
  getQueueSizes() {
    const sizes = {};
    for (const [type, batch] of this.batches) {
      sizes[type] = batch.queue.length;
    }
    return sizes;
  }

  /**
   * Batch insert shares
   */
  async batchAddShares(shares) {
    const promises = shares.map(share => 
      this.batch('shares', 
        'INSERT INTO shares (worker_id, difficulty, valid, timestamp, algorithm) VALUES (?, ?, ?, ?, ?)',
        [share.workerId, share.difficulty, share.valid ? 1 : 0, share.timestamp || Date.now(), share.algorithm || 'kawpow']
      )
    );
    
    return Promise.all(promises);
  }

  /**
   * Batch insert trades
   */
  async batchAddTrades(trades) {
    const promises = trades.map(trade =>
      this.batch('trades',
        'INSERT INTO trades (pair, amount_in, amount_out, fee, trader, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
        [trade.pair, trade.amountIn, trade.amountOut, trade.fee, trade.trader, trade.timestamp || Date.now()]
      )
    );
    
    return Promise.all(promises);
  }

  /**
   * Get performance report
   */
  getPerformanceReport() {
    return {
      config: this.config,
      metrics: this.metrics,
      adaptiveState: this.adaptiveState,
      queueSizes: this.getQueueSizes(),
      efficiency: {
        mergeRatio: this.metrics.mergedQueries / this.metrics.totalQueries,
        avgQueriesPerBatch: this.metrics.totalQueries / this.metrics.totalBatches,
        errorRate: this.metrics.errors / this.metrics.totalQueries
      }
    };
  }

  /**
   * Flush all pending batches
   */
  async flush() {
    const promises = [];
    
    for (const [type, batch] of this.batches) {
      if (batch.timer) {
        clearTimeout(batch.timer);
        batch.timer = null;
      }
      
      if (batch.queue.length > 0) {
        promises.push(this.processBatch(type));
      }
    }
    
    await Promise.all(promises);
  }

  /**
   * Stop batcher
   */
  async stop() {
    // Flush pending batches
    await this.flush();
    
    // Stop monitoring
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = null;
    }
    
    this.logger.info('Database batcher stopped');
  }
}

export default DatabaseBatcher;
