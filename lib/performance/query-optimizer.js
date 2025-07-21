/**
 * Query Optimizer for Otedama
 * 
 * Implements advanced query optimization techniques including:
 * - Query plan analysis and optimization
 * - Batch processing for bulk operations
 * - Prepared statement caching
 * - Query result caching with TTL
 * - N+1 query detection and prevention
 * 
 * Following John Carmack's performance principles
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { createHash } from 'crypto';

// Performance constants
const OPTIMIZER_CONSTANTS = Object.freeze({
  SLOW_QUERY_THRESHOLD: 100,      // 100ms
  CACHE_TTL: 60000,               // 1 minute default
  MAX_CACHE_SIZE: 1000,           // Maximum cached queries
  BATCH_SIZE: 500,                // Default batch size
  BATCH_TIMEOUT: 50,              // 50ms batch timeout
  STATEMENT_CACHE_SIZE: 500,      // Prepared statement cache
  EXPLAIN_THRESHOLD: 50,          // Threshold for EXPLAIN analysis
});

/**
 * LRU Cache implementation for query results
 */
class QueryCache {
  constructor(maxSize = OPTIMIZER_CONSTANTS.MAX_CACHE_SIZE) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
  }

  generateKey(sql, params) {
    const hash = createHash('sha256');
    hash.update(sql);
    hash.update(JSON.stringify(params));
    return hash.digest('hex');
  }

  get(sql, params) {
    const key = this.generateKey(sql, params);
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    // Move to end (LRU)
    this.cache.delete(key);
    this.cache.set(key, entry);
    
    this.stats.hits++;
    return entry.data;
  }

  set(sql, params, data, ttl = OPTIMIZER_CONSTANTS.CACHE_TTL) {
    const key = this.generateKey(sql, params);
    
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
      this.stats.evictions++;
    }

    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttl,
      sql,
      params
    });
  }

  invalidate(pattern) {
    let invalidated = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (entry.sql.includes(pattern)) {
        this.cache.delete(key);
        invalidated++;
      }
    }
    
    return invalidated;
  }

  clear() {
    this.cache.clear();
  }

  getStats() {
    const hitRate = this.stats.hits / (this.stats.hits + this.stats.misses) || 0;
    return {
      ...this.stats,
      hitRate: Math.round(hitRate * 100) / 100,
      size: this.cache.size
    };
  }
}

/**
 * Query Plan Analyzer
 */
class QueryPlanAnalyzer {
  constructor(db) {
    this.db = db;
    this.analysisCache = new Map();
  }

  async analyze(sql, params = []) {
    const cacheKey = sql + JSON.stringify(params);
    
    if (this.analysisCache.has(cacheKey)) {
      return this.analysisCache.get(cacheKey);
    }

    try {
      // Run EXPLAIN QUERY PLAN
      const plan = this.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
      
      const analysis = {
        sql,
        plan,
        suggestions: [],
        estimatedCost: 0,
        usesIndex: false,
        fullTableScan: false
      };

      // Analyze the plan
      for (const step of plan) {
        const detail = step.detail.toLowerCase();
        
        if (detail.includes('scan table')) {
          analysis.fullTableScan = true;
          analysis.estimatedCost += 1000;
          
          // Extract table name for suggestions
          const tableMatch = detail.match(/scan table (\w+)/);
          if (tableMatch) {
            analysis.suggestions.push({
              type: 'missing_index',
              table: tableMatch[1],
              message: `Consider adding an index for table ${tableMatch[1]}`
            });
          }
        }
        
        if (detail.includes('using index')) {
          analysis.usesIndex = true;
          analysis.estimatedCost += 10;
        }
        
        if (detail.includes('using covering index')) {
          analysis.estimatedCost += 5;
        }
        
        if (detail.includes('temp b-tree')) {
          analysis.estimatedCost += 500;
          analysis.suggestions.push({
            type: 'temp_btree',
            message: 'Query creates temporary B-tree, consider optimization'
          });
        }
      }

      // Cache the analysis
      this.analysisCache.set(cacheKey, analysis);
      
      // Limit cache size
      if (this.analysisCache.size > 100) {
        const firstKey = this.analysisCache.keys().next().value;
        this.analysisCache.delete(firstKey);
      }

      return analysis;

    } catch (error) {
      return {
        sql,
        error: error.message,
        suggestions: [],
        estimatedCost: Infinity
      };
    }
  }

  suggestIndexes(tableStats) {
    const suggestions = [];
    
    // Analyze frequently queried columns
    for (const [table, stats] of Object.entries(tableStats)) {
      for (const [column, count] of Object.entries(stats.columns)) {
        if (count > 100 && !stats.indexes?.includes(column)) {
          suggestions.push({
            table,
            column,
            type: 'btree',
            reason: `Column ${column} is frequently queried (${count} times)`
          });
        }
      }
      
      // Suggest composite indexes for common combinations
      if (stats.combinations) {
        for (const [combo, count] of Object.entries(stats.combinations)) {
          if (count > 50) {
            suggestions.push({
              table,
              columns: combo.split(','),
              type: 'composite',
              reason: `Columns ${combo} are frequently queried together`
            });
          }
        }
      }
    }
    
    return suggestions;
  }
}

/**
 * Batch Query Processor
 */
class BatchQueryProcessor {
  constructor(db) {
    this.db = db;
    this.batches = new Map();
    this.timers = new Map();
    this.stats = {
      processed: 0,
      failed: 0,
      avgBatchSize: 0
    };
  }

  add(operation, sql, params, callback) {
    const key = `${operation}:${sql}`;
    
    if (!this.batches.has(key)) {
      this.batches.set(key, {
        operation,
        sql,
        items: [],
        callbacks: []
      });
    }

    const batch = this.batches.get(key);
    batch.items.push(params);
    batch.callbacks.push(callback);

    // Set timer for batch execution
    if (!this.timers.has(key)) {
      this.timers.set(key, setTimeout(() => {
        this.flush(key);
      }, OPTIMIZER_CONSTANTS.BATCH_TIMEOUT));
    }

    // Flush if batch is full
    if (batch.items.length >= OPTIMIZER_CONSTANTS.BATCH_SIZE) {
      this.flush(key);
    }
  }

  async flush(key) {
    const batch = this.batches.get(key);
    if (!batch || batch.items.length === 0) return;

    // Clear batch and timer
    this.batches.delete(key);
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }

    try {
      const results = await this.executeBatch(batch);
      
      // Call callbacks with results
      batch.callbacks.forEach((callback, index) => {
        callback(null, results[index]);
      });

      // Update stats
      this.stats.processed += batch.items.length;
      this.updateAvgBatchSize(batch.items.length);

    } catch (error) {
      // Call callbacks with error
      batch.callbacks.forEach(callback => {
        callback(error);
      });

      this.stats.failed += batch.items.length;
    }
  }

  async executeBatch(batch) {
    const { operation, sql, items } = batch;

    return new Promise((resolve, reject) => {
      try {
        const results = [];
        
        this.db.transaction(() => {
          const stmt = this.db.prepare(sql);
          
          for (const params of items) {
            let result;
            
            switch (operation) {
              case 'run':
                result = stmt.run(...params);
                break;
              case 'get':
                result = stmt.get(...params);
                break;
              case 'all':
                result = stmt.all(...params);
                break;
              default:
                throw new Error(`Unknown operation: ${operation}`);
            }
            
            results.push(result);
          }
        })();

        resolve(results);
      } catch (error) {
        reject(error);
      }
    });
  }

  updateAvgBatchSize(size) {
    const alpha = 0.1;
    this.stats.avgBatchSize = alpha * size + (1 - alpha) * this.stats.avgBatchSize;
  }

  async flushAll() {
    const keys = Array.from(this.batches.keys());
    await Promise.all(keys.map(key => this.flush(key)));
  }

  getStats() {
    return {
      ...this.stats,
      pending: this.batches.size,
      avgBatchSize: Math.round(this.stats.avgBatchSize)
    };
  }
}

/**
 * Main Query Optimizer
 */
export class QueryOptimizer extends EventEmitter {
  constructor(db, options = {}) {
    super();

    this.db = db;
    this.options = {
      enableCache: options.enableCache !== false,
      enableBatching: options.enableBatching !== false,
      enableAnalysis: options.enableAnalysis !== false,
      slowQueryThreshold: options.slowQueryThreshold || OPTIMIZER_CONSTANTS.SLOW_QUERY_THRESHOLD,
      ...options
    };

    // Components
    this.cache = new QueryCache(options.cacheSize);
    this.analyzer = new QueryPlanAnalyzer(db);
    this.batchProcessor = new BatchQueryProcessor(db);
    
    // Statement cache
    this.statementCache = new Map();
    
    // Query statistics
    this.queryStats = new Map();
    
    // Slow query log
    this.slowQueries = [];
    
    // Performance metrics
    this.metrics = {
      totalQueries: 0,
      cachedQueries: 0,
      batchedQueries: 0,
      slowQueries: 0,
      avgQueryTime: 0
    };
  }

  /**
   * Prepare and cache a statement
   */
  prepare(sql) {
    if (!this.statementCache.has(sql)) {
      const stmt = this.db.prepare(sql);
      
      // Limit cache size
      if (this.statementCache.size >= OPTIMIZER_CONSTANTS.STATEMENT_CACHE_SIZE) {
        const firstKey = this.statementCache.keys().next().value;
        this.statementCache.delete(firstKey);
      }
      
      this.statementCache.set(sql, stmt);
    }
    
    return this.statementCache.get(sql);
  }

  /**
   * Execute an optimized query
   */
  async query(sql, params = [], options = {}) {
    const startTime = performance.now();
    const operation = this.detectOperation(sql);
    
    try {
      // Check cache for read operations
      if (this.options.enableCache && operation === 'all') {
        const cached = this.cache.get(sql, params);
        if (cached !== null) {
          this.metrics.cachedQueries++;
          this.emit('cache:hit', { sql });
          return cached;
        }
      }

      // Use batching for eligible operations
      if (this.options.enableBatching && options.batch && this.canBatch(sql)) {
        return new Promise((resolve, reject) => {
          this.batchProcessor.add(operation, sql, params, (error, result) => {
            if (error) reject(error);
            else resolve(result);
          });
          this.metrics.batchedQueries++;
        });
      }

      // Execute query
      const stmt = this.prepare(sql);
      let result;
      
      switch (operation) {
        case 'run':
          result = stmt.run(...params);
          break;
        case 'get':
          result = stmt.get(...params);
          break;
        case 'all':
          result = stmt.all(...params);
          break;
        default:
          throw new Error(`Unknown operation for SQL: ${sql}`);
      }

      // Cache result if applicable
      if (this.options.enableCache && operation === 'all' && result) {
        this.cache.set(sql, params, result, options.cacheTTL);
      }

      // Record query time
      const duration = performance.now() - startTime;
      this.recordQueryStats(sql, params, duration);

      return result;

    } catch (error) {
      this.emit('query:error', { sql, error: error.message });
      throw error;
    }
  }

  /**
   * Run multiple queries in a transaction
   */
  async transaction(callback) {
    const context = {
      query: (sql, params) => this.query(sql, params),
      prepare: (sql) => this.prepare(sql),
      run: (sql, params) => this.prepare(sql).run(...params),
      get: (sql, params) => this.prepare(sql).get(...params),
      all: (sql, params) => this.prepare(sql).all(...params)
    };

    return new Promise((resolve, reject) => {
      try {
        this.db.transaction(async () => {
          const result = await callback(context);
          resolve(result);
        })();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Analyze query performance
   */
  async analyzeQuery(sql, params = []) {
    if (!this.options.enableAnalysis) {
      return null;
    }

    const analysis = await this.analyzer.analyze(sql, params);
    
    // Log slow queries
    if (analysis.estimatedCost > OPTIMIZER_CONSTANTS.EXPLAIN_THRESHOLD) {
      this.slowQueries.push({
        sql,
        params,
        analysis,
        timestamp: Date.now()
      });
      
      // Keep only recent slow queries
      if (this.slowQueries.length > 100) {
        this.slowQueries.shift();
      }
      
      this.emit('slow:query', { sql, analysis });
    }

    return analysis;
  }

  /**
   * Get optimization suggestions
   */
  getSuggestions() {
    const tableStats = {};
    
    // Analyze query patterns
    for (const [sql, stats] of this.queryStats.entries()) {
      const tables = this.extractTables(sql);
      const columns = this.extractColumns(sql);
      
      for (const table of tables) {
        if (!tableStats[table]) {
          tableStats[table] = { queries: 0, columns: {}, combinations: {} };
        }
        
        tableStats[table].queries += stats.count;
        
        for (const column of columns) {
          if (!tableStats[table].columns[column]) {
            tableStats[table].columns[column] = 0;
          }
          tableStats[table].columns[column] += stats.count;
        }
        
        // Track column combinations
        if (columns.length > 1) {
          const combo = columns.sort().join(',');
          if (!tableStats[table].combinations[combo]) {
            tableStats[table].combinations[combo] = 0;
          }
          tableStats[table].combinations[combo] += stats.count;
        }
      }
    }

    return this.analyzer.suggestIndexes(tableStats);
  }

  /**
   * Invalidate cache entries
   */
  invalidateCache(pattern) {
    if (!this.options.enableCache) return 0;
    
    const invalidated = this.cache.invalidate(pattern);
    this.emit('cache:invalidate', { pattern, count: invalidated });
    
    return invalidated;
  }

  /**
   * Get optimizer statistics
   */
  getStats() {
    return {
      metrics: { ...this.metrics },
      cache: this.cache.getStats(),
      batch: this.batchProcessor.getStats(),
      statementCache: this.statementCache.size,
      slowQueries: this.slowQueries.length,
      queryPatterns: this.queryStats.size
    };
  }

  /**
   * Reset optimizer state
   */
  reset() {
    this.cache.clear();
    this.statementCache.clear();
    this.queryStats.clear();
    this.slowQueries = [];
    this.metrics = {
      totalQueries: 0,
      cachedQueries: 0,
      batchedQueries: 0,
      slowQueries: 0,
      avgQueryTime: 0
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    await this.batchProcessor.flushAll();
    this.reset();
  }

  // Helper methods

  detectOperation(sql) {
    const normalized = sql.trim().toLowerCase();
    if (normalized.startsWith('select')) return 'all';
    if (normalized.startsWith('insert') || 
        normalized.startsWith('update') || 
        normalized.startsWith('delete')) return 'run';
    return 'get';
  }

  canBatch(sql) {
    const normalized = sql.trim().toLowerCase();
    return normalized.startsWith('insert') || 
           normalized.startsWith('update') ||
           normalized.startsWith('delete');
  }

  extractTables(sql) {
    const tables = new Set();
    const patterns = [
      /from\s+(\w+)/gi,
      /join\s+(\w+)/gi,
      /into\s+(\w+)/gi,
      /update\s+(\w+)/gi
    ];
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(sql)) !== null) {
        tables.add(match[1].toLowerCase());
      }
    }
    
    return Array.from(tables);
  }

  extractColumns(sql) {
    const columns = new Set();
    const patterns = [
      /where\s+(\w+)\s*=/gi,
      /and\s+(\w+)\s*=/gi,
      /or\s+(\w+)\s*=/gi,
      /order\s+by\s+(\w+)/gi
    ];
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(sql)) !== null) {
        columns.add(match[1].toLowerCase());
      }
    }
    
    return Array.from(columns);
  }

  recordQueryStats(sql, params, duration) {
    // Update metrics
    this.metrics.totalQueries++;
    const alpha = 0.1;
    this.metrics.avgQueryTime = alpha * duration + (1 - alpha) * this.metrics.avgQueryTime;

    if (duration > this.options.slowQueryThreshold) {
      this.metrics.slowQueries++;
    }

    // Update query stats
    const key = sql.replace(/\s+/g, ' ').trim();
    if (!this.queryStats.has(key)) {
      this.queryStats.set(key, {
        count: 0,
        totalTime: 0,
        avgTime: 0,
        maxTime: 0
      });
    }

    const stats = this.queryStats.get(key);
    stats.count++;
    stats.totalTime += duration;
    stats.avgTime = stats.totalTime / stats.count;
    stats.maxTime = Math.max(stats.maxTime, duration);
  }
}

export default QueryOptimizer;