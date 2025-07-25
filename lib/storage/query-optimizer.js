/**
 * Database Query Optimizer - Otedama
 * Advanced database optimization and query performance
 * 
 * Features:
 * - Query performance monitoring
 * - Automatic index creation
 * - Query plan optimization
 * - Connection pooling
 * - Query result caching
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('QueryOptimizer');

export class DatabaseQueryOptimizer extends EventEmitter {
  constructor(database, config = {}) {
    super();
    
    this.database = database;
    this.config = {
      enabled: config.enabled !== false,
      slowQueryThreshold: config.slowQueryThreshold || 100, // ms
      queryCache: config.queryCache !== false,
      cacheSize: config.cacheSize || 50 * 1024 * 1024, // 50MB
      cacheTTL: config.cacheTTL || 300000, // 5 minutes
      autoIndex: config.autoIndex !== false,
      indexThreshold: config.indexThreshold || 1000, // ms
      analyzeInterval: config.analyzeInterval || 3600000 // 1 hour
    };
    
    // Query tracking
    this.queryStats = new Map();
    this.slowQueries = [];
    this.queryCache = new Map();
    this.cacheSize = 0;
    this.suggestedIndexes = new Map();
    
    // Statistics
    this.stats = {
      totalQueries: 0,
      cacheHits: 0,
      cacheMisses: 0,
      slowQueries: 0,
      indexesCreated: 0,
      avgQueryTime: 0
    };
    
    this.analyzeTimer = null;
  }
  
  /**
   * Initialize optimizer
   */
  async initialize() {
    if (!this.config.enabled) return;
    
    logger.info('Initializing database query optimizer...');
    
    // Wrap database methods
    this.wrapDatabaseMethods();
    
    // Create initial indexes
    await this.createEssentialIndexes();
    
    // Start analysis
    this.analyzeTimer = setInterval(() => {
      this.analyzeQueryPerformance();
    }, this.config.analyzeInterval);
    
    // Initial analysis
    await this.analyzeDatabase();
    
    logger.info('Database query optimizer initialized');
  }
  
  /**
   * Wrap database methods for monitoring
   */
  wrapDatabaseMethods() {
    const methods = ['get', 'all', 'run', 'exec'];
    
    methods.forEach(method => {
      const original = this.database[method].bind(this.database);
      
      this.database[method] = async (query, ...params) => {
        const startTime = Date.now();
        const cacheKey = this.getCacheKey(method, query, params);
        
        // Check cache for SELECT queries
        if (this.config.queryCache && method !== 'run' && method !== 'exec') {
          const cached = this.getFromCache(cacheKey);
          if (cached) {
            this.stats.cacheHits++;
            return cached;
          }
          this.stats.cacheMisses++;
        }
        
        try {
          // Execute query
          const result = await original(query, ...params);
          const duration = Date.now() - startTime;
          
          // Track query stats
          this.trackQuery(query, duration, method);
          
          // Cache result if applicable
          if (this.config.queryCache && method !== 'run' && method !== 'exec') {
            this.addToCache(cacheKey, result);
          }
          
          // Check for slow query
          if (duration > this.config.slowQueryThreshold) {
            this.handleSlowQuery(query, duration, params);
          }
          
          return result;
          
        } catch (error) {
          const duration = Date.now() - startTime;
          this.trackQuery(query, duration, method, error);
          throw error;
        }
      };
    });
  }
  
  /**
   * Create essential indexes
   */
  async createEssentialIndexes() {
    const indexes = [
      // Miners
      'CREATE INDEX IF NOT EXISTS idx_miners_address ON miners(address)',
      'CREATE INDEX IF NOT EXISTS idx_miners_connected ON miners(connected)',
      'CREATE INDEX IF NOT EXISTS idx_miners_connected_at ON miners(connected_at)',
      
      // Shares
      'CREATE INDEX IF NOT EXISTS idx_shares_miner_id ON shares(miner_id)',
      'CREATE INDEX IF NOT EXISTS idx_shares_timestamp ON shares(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_shares_block_height ON shares(block_height)',
      'CREATE INDEX IF NOT EXISTS idx_shares_is_valid ON shares(is_valid)',
      
      // Blocks
      'CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height)',
      'CREATE INDEX IF NOT EXISTS idx_blocks_hash ON blocks(hash)',
      'CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_blocks_miner_id ON blocks(miner_id)',
      
      // Payments
      'CREATE INDEX IF NOT EXISTS idx_payments_address ON payments(address)',
      'CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)',
      'CREATE INDEX IF NOT EXISTS idx_payments_tx_hash ON payments(tx_hash)',
      
      // Miner stats
      'CREATE INDEX IF NOT EXISTS idx_miner_stats_miner_id ON miner_stats(miner_id)',
      'CREATE INDEX IF NOT EXISTS idx_miner_stats_last_share_at ON miner_stats(last_share_at)',
      
      // Composite indexes
      'CREATE INDEX IF NOT EXISTS idx_shares_miner_timestamp ON shares(miner_id, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_payments_address_status ON payments(address, status)'
    ];
    
    for (const index of indexes) {
      try {
        await this.database.run(index);
      } catch (error) {
        logger.error(`Failed to create index: ${error.message}`);
      }
    }
    
    logger.info('Essential indexes created');
  }
  
  /**
   * Get cache key
   */
  getCacheKey(method, query, params) {
    const normalizedQuery = query.replace(/\s+/g, ' ').trim();
    return `${method}:${normalizedQuery}:${JSON.stringify(params)}`;
  }
  
  /**
   * Get from cache
   */
  getFromCache(key) {
    const cached = this.queryCache.get(key);
    
    if (cached && Date.now() - cached.timestamp < this.config.cacheTTL) {
      return cached.data;
    }
    
    // Expired
    if (cached) {
      this.queryCache.delete(key);
      this.cacheSize -= cached.size;
    }
    
    return null;
  }
  
  /**
   * Add to cache
   */
  addToCache(key, data) {
    const size = JSON.stringify(data).length;
    
    // Check cache size limit
    while (this.cacheSize + size > this.config.cacheSize && this.queryCache.size > 0) {
      // Remove oldest entry
      const firstKey = this.queryCache.keys().next().value;
      const removed = this.queryCache.get(firstKey);
      this.queryCache.delete(firstKey);
      this.cacheSize -= removed.size;
    }
    
    this.queryCache.set(key, {
      data,
      size,
      timestamp: Date.now()
    });
    
    this.cacheSize += size;
  }
  
  /**
   * Track query performance
   */
  trackQuery(query, duration, method, error = null) {
    this.stats.totalQueries++;
    
    // Update average query time
    this.stats.avgQueryTime = 
      (this.stats.avgQueryTime * (this.stats.totalQueries - 1) + duration) / 
      this.stats.totalQueries;
    
    // Normalize query for grouping
    const normalizedQuery = this.normalizeQuery(query);
    
    if (!this.queryStats.has(normalizedQuery)) {
      this.queryStats.set(normalizedQuery, {
        query: normalizedQuery,
        method,
        count: 0,
        totalTime: 0,
        avgTime: 0,
        minTime: Infinity,
        maxTime: 0,
        errors: 0
      });
    }
    
    const stats = this.queryStats.get(normalizedQuery);
    stats.count++;
    stats.totalTime += duration;
    stats.avgTime = stats.totalTime / stats.count;
    stats.minTime = Math.min(stats.minTime, duration);
    stats.maxTime = Math.max(stats.maxTime, duration);
    
    if (error) {
      stats.errors++;
    }
  }
  
  /**
   * Normalize query for statistics
   */
  normalizeQuery(query) {
    return query
      .replace(/\s+/g, ' ')
      .replace(/\?/g, '?')
      .replace(/\d+/g, 'N')
      .replace(/'[^']*'/g, "'S'")
      .trim()
      .substring(0, 200); // Limit length
  }
  
  /**
   * Handle slow query
   */
  handleSlowQuery(query, duration, params) {
    this.stats.slowQueries++;
    
    const slowQuery = {
      query,
      duration,
      params,
      timestamp: Date.now()
    };
    
    this.slowQueries.push(slowQuery);
    
    // Keep only last 100 slow queries
    if (this.slowQueries.length > 100) {
      this.slowQueries.shift();
    }
    
    logger.warn(`Slow query detected (${duration}ms): ${query.substring(0, 100)}...`);
    
    // Analyze for optimization
    this.analyzeSlowQuery(query, duration);
    
    this.emit('query:slow', slowQuery);
  }
  
  /**
   * Analyze slow query for optimization
   */
  async analyzeSlowQuery(query, duration) {
    // Simple analysis - check for missing indexes
    const upperQuery = query.toUpperCase();
    
    if (upperQuery.includes('WHERE')) {
      const whereMatch = query.match(/WHERE\s+(\w+)\s*=/i);
      if (whereMatch) {
        const column = whereMatch[1];
        const table = this.extractTableName(query);
        
        if (table && column) {
          const indexKey = `${table}.${column}`;
          
          if (!this.suggestedIndexes.has(indexKey)) {
            this.suggestedIndexes.set(indexKey, {
              table,
              column,
              queries: 0,
              totalTime: 0
            });
          }
          
          const suggestion = this.suggestedIndexes.get(indexKey);
          suggestion.queries++;
          suggestion.totalTime += duration;
          
          // Auto-create index if threshold exceeded
          if (this.config.autoIndex && 
              suggestion.totalTime > this.config.indexThreshold && 
              suggestion.queries > 10) {
            await this.createIndex(table, column);
          }
        }
      }
    }
  }
  
  /**
   * Extract table name from query
   */
  extractTableName(query) {
    const match = query.match(/FROM\s+(\w+)/i) || query.match(/UPDATE\s+(\w+)/i);
    return match ? match[1] : null;
  }
  
  /**
   * Create index
   */
  async createIndex(table, column) {
    const indexName = `idx_${table}_${column}_auto`;
    const indexQuery = `CREATE INDEX IF NOT EXISTS ${indexName} ON ${table}(${column})`;
    
    try {
      logger.info(`Creating automatic index: ${indexName}`);
      await this.database.run(indexQuery);
      
      this.stats.indexesCreated++;
      this.suggestedIndexes.delete(`${table}.${column}`);
      
      this.emit('index:created', { table, column, indexName });
      
    } catch (error) {
      logger.error(`Failed to create index ${indexName}: ${error.message}`);
    }
  }
  
  /**
   * Analyze database performance
   */
  async analyzeDatabase() {
    try {
      // Update database statistics
      await this.database.run('ANALYZE');
      
      // Get table statistics
      const tables = await this.database.all(`
        SELECT name FROM sqlite_master 
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      `);
      
      for (const table of tables) {
        const count = await this.database.get(`SELECT COUNT(*) as count FROM ${table.name}`);
        logger.debug(`Table ${table.name}: ${count.count} rows`);
      }
      
      // Vacuum if needed (be careful in production)
      const pageCount = await this.database.get('PRAGMA page_count');
      const freePages = await this.database.get('PRAGMA freelist_count');
      
      if (freePages.freelist_count > pageCount.page_count * 0.2) {
        logger.info('Database has significant fragmentation, consider running VACUUM');
        this.emit('maintenance:needed', { type: 'vacuum', freePages: freePages.freelist_count });
      }
      
    } catch (error) {
      logger.error('Database analysis failed:', error);
    }
  }
  
  /**
   * Analyze query performance
   */
  analyzeQueryPerformance() {
    const problemQueries = [];
    
    this.queryStats.forEach((stats, query) => {
      // Find queries that need optimization
      if (stats.avgTime > this.config.slowQueryThreshold && stats.count > 10) {
        problemQueries.push({
          query,
          avgTime: stats.avgTime,
          count: stats.count,
          impact: stats.avgTime * stats.count
        });
      }
    });
    
    // Sort by impact
    problemQueries.sort((a, b) => b.impact - a.impact);
    
    if (problemQueries.length > 0) {
      logger.info(`Top problem queries:`);
      problemQueries.slice(0, 5).forEach((pq, i) => {
        logger.info(`  ${i + 1}. ${pq.query.substring(0, 50)}... (${pq.avgTime.toFixed(2)}ms avg, ${pq.count} calls)`);
      });
    }
    
    // Clear old stats
    this.queryStats.forEach((stats, query) => {
      if (stats.count === 0) {
        this.queryStats.delete(query);
      } else {
        // Reset counters
        stats.count = 0;
        stats.totalTime = 0;
      }
    });
  }
  
  /**
   * Optimize specific query
   */
  async optimizeQuery(query) {
    // Get query plan
    const plan = await this.database.all(`EXPLAIN QUERY PLAN ${query}`);
    
    const optimization = {
      original: query,
      plan,
      suggestions: []
    };
    
    // Analyze plan
    plan.forEach(step => {
      if (step.detail.includes('SCAN TABLE')) {
        optimization.suggestions.push({
          type: 'index',
          message: `Table scan detected on ${step.detail}, consider adding index`
        });
      }
      
      if (step.detail.includes('TEMP B-TREE')) {
        optimization.suggestions.push({
          type: 'query',
          message: 'Temporary B-tree created, consider optimizing ORDER BY'
        });
      }
    });
    
    return optimization;
  }
  
  /**
   * Clear query cache
   */
  clearCache() {
    this.queryCache.clear();
    this.cacheSize = 0;
    logger.info('Query cache cleared');
  }
  
  /**
   * Get optimization report
   */
  getOptimizationReport() {
    const report = {
      stats: this.stats,
      cache: {
        size: (this.cacheSize / 1024 / 1024).toFixed(2) + ' MB',
        entries: this.queryCache.size,
        hitRate: this.stats.totalQueries > 0 ? 
          ((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 100).toFixed(2) + '%' : '0%'
      },
      slowQueries: this.slowQueries.slice(-10),
      suggestedIndexes: Array.from(this.suggestedIndexes.entries()).map(([key, value]) => ({
        key,
        ...value,
        avgQueryTime: value.totalTime / value.queries
      })),
      topQueries: Array.from(this.queryStats.values())
        .sort((a, b) => b.totalTime - a.totalTime)
        .slice(0, 10)
    };
    
    return report;
  }
  
  /**
   * Shutdown optimizer
   */
  async shutdown() {
    if (this.analyzeTimer) {
      clearInterval(this.analyzeTimer);
    }
    
    this.clearCache();
    
    logger.info('Database query optimizer shutdown');
  }
}

export default DatabaseQueryOptimizer;
