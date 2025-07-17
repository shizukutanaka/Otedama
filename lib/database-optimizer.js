/**
 * Database Optimizer for Otedama
 * Query optimization and connection pooling
 */

import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { MemoryCache } from './memory-cache.js';

export class DatabaseOptimizer extends EventEmitter {
  constructor(dbPath, options = {}) {
    super();
    this.logger = options.logger || new Logger('DatabaseOptimizer');
    this.options = {
      poolSize: options.poolSize || 5,
      queryTimeout: options.queryTimeout || 30000,
      cacheSize: options.cacheSize || 50 * 1024 * 1024, // 50MB
      cacheTTL: options.cacheTTL || 300000, // 5 minutes
      enableQueryCache: options.enableQueryCache !== false,
      enablePreparedStatements: options.enablePreparedStatements !== false,
      ...options
    };
    
    // Connection pool
    this.pool = [];
    this.availableConnections = [];
    this.activeConnections = new Map();
    
    // Query cache
    if (this.options.enableQueryCache) {
      this.queryCache = new MemoryCache({
        maxSize: this.options.cacheSize,
        ttl: this.options.cacheTTL
      });
    }
    
    // Prepared statements cache
    this.preparedStatements = new Map();
    
    // Performance metrics
    this.metrics = {
      queries: 0,
      cacheHits: 0,
      cacheMisses: 0,
      avgQueryTime: 0,
      slowQueries: 0,
      errors: 0
    };
    
    // Initialize pool
    this.initializePool(dbPath);
  }
  
  initializePool(dbPath) {
    for (let i = 0; i < this.options.poolSize; i++) {
      const db = new Database(dbPath);
      
      // Configure for performance
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('cache_size = 10000');
      db.pragma('temp_store = MEMORY');
      db.pragma('mmap_size = 30000000000');
      
      const connection = {
        id: i,
        db,
        inUse: false,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        queries: 0
      };
      
      this.pool.push(connection);
      this.availableConnections.push(connection);
    }
    
    this.logger.info(`Database pool initialized with ${this.options.poolSize} connections`);
  }
  
  /**
   * Get connection from pool
   */
  async getConnection() {
    if (this.availableConnections.length === 0) {
      // Wait for available connection
      await this.waitForConnection();
    }
    
    const connection = this.availableConnections.shift();
    connection.inUse = true;
    connection.lastUsed = Date.now();
    
    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.activeConnections.set(connectionId, connection);
    
    return { connectionId, db: connection.db };
  }
  
  /**
   * Release connection back to pool
   */
  releaseConnection(connectionId) {
    const connection = this.activeConnections.get(connectionId);
    if (!connection) return;
    
    connection.inUse = false;
    this.availableConnections.push(connection);
    this.activeConnections.delete(connectionId);
  }
  
  /**
   * Wait for available connection
   */
  async waitForConnection() {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.availableConnections.length > 0) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }
  
  /**
   * Execute query with optimization
   */
  async query(sql, params = [], options = {}) {
    const startTime = performance.now();
    let result;
    let connectionId;
    
    try {
      // Check cache first
      if (this.options.enableQueryCache && options.cache !== false) {
        const cacheKey = this.getCacheKey(sql, params);
        const cached = this.queryCache?.get(cacheKey);
        
        if (cached) {
          this.metrics.cacheHits++;
          return cached;
        }
        
        this.metrics.cacheMisses++;
      }
      
      // Get connection
      const { connectionId: connId, db } = await this.getConnection();
      connectionId = connId;
      
      // Use prepared statement if enabled
      if (this.options.enablePreparedStatements) {
        result = this.executePrepared(db, sql, params);
      } else {
        result = db.prepare(sql).all(...params);
      }
      
      // Cache result
      if (this.options.enableQueryCache && options.cache !== false) {
        const cacheKey = this.getCacheKey(sql, params);
        this.queryCache?.set(cacheKey, result, {
          ttl: options.cacheTTL || this.options.cacheTTL
        });
      }
      
      // Update metrics
      const duration = performance.now() - startTime;
      this.updateMetrics(duration);
      
      if (duration > 1000) {
        this.metrics.slowQueries++;
        this.logger.warn(`Slow query detected (${duration}ms): ${sql.substring(0, 100)}`);
      }
      
      return result;
      
    } catch (error) {
      this.metrics.errors++;
      this.logger.error('Query error:', error);
      throw error;
    } finally {
      if (connectionId) {
        this.releaseConnection(connectionId);
      }
    }
  }
  
  /**
   * Execute query returning single row
   */
  async get(sql, params = [], options = {}) {
    const results = await this.query(sql, params, options);
    return results[0] || null;
  }
  
  /**
   * Execute write operation
   */
  async run(sql, params = [], options = {}) {
    let connectionId;
    
    try {
      const { connectionId: connId, db } = await this.getConnection();
      connectionId = connId;
      
      const stmt = db.prepare(sql);
      const info = stmt.run(...params);
      
      // Invalidate related cache
      if (this.options.enableQueryCache) {
        this.invalidateCache(sql);
      }
      
      return info;
      
    } finally {
      if (connectionId) {
        this.releaseConnection(connectionId);
      }
    }
  }
  
  /**
   * Execute transaction
   */
  async transaction(callback) {
    let connectionId;
    
    try {
      const { connectionId: connId, db } = await this.getConnection();
      connectionId = connId;
      
      const result = db.transaction(callback)();
      
      // Clear cache after transaction
      if (this.options.enableQueryCache) {
        this.queryCache?.clear();
      }
      
      return result;
      
    } finally {
      if (connectionId) {
        this.releaseConnection(connectionId);
      }
    }
  }
  
  /**
   * Batch insert optimization
   */
  async batchInsert(table, columns, values, options = {}) {
    const batchSize = options.batchSize || 1000;
    const placeholders = columns.map(() => '?').join(',');
    const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`;
    
    let connectionId;
    
    try {
      const { connectionId: connId, db } = await this.getConnection();
      connectionId = connId;
      
      const stmt = db.prepare(sql);
      const insertMany = db.transaction((batch) => {
        for (const row of batch) {
          stmt.run(...row);
        }
      });
      
      // Process in batches
      for (let i = 0; i < values.length; i += batchSize) {
        const batch = values.slice(i, i + batchSize);
        insertMany(batch);
      }
      
      // Clear cache
      if (this.options.enableQueryCache) {
        this.invalidateTableCache(table);
      }
      
      return values.length;
      
    } finally {
      if (connectionId) {
        this.releaseConnection(connectionId);
      }
    }
  }
  
  /**
   * Execute prepared statement
   */
  executePrepared(db, sql, params) {
    let stmt = this.preparedStatements.get(sql);
    
    if (!stmt) {
      stmt = db.prepare(sql);
      this.preparedStatements.set(sql, stmt);
    }
    
    return stmt.all(...params);
  }
  
  /**
   * Get cache key for query
   */
  getCacheKey(sql, params) {
    return `${sql}::${JSON.stringify(params)}`;
  }
  
  /**
   * Invalidate cache entries
   */
  invalidateCache(sql) {
    if (!this.queryCache) return;
    
    // Extract table name from SQL
    const tableMatch = sql.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i);
    if (tableMatch) {
      this.invalidateTableCache(tableMatch[1]);
    }
  }
  
  /**
   * Invalidate all cache entries for a table
   */
  invalidateTableCache(table) {
    if (!this.queryCache) return;
    
    // Simple approach: clear all cache
    // In production, would track which queries touch which tables
    this.queryCache.clear();
  }
  
  /**
   * Update performance metrics
   */
  updateMetrics(duration) {
    this.metrics.queries++;
    this.metrics.avgQueryTime = 
      (this.metrics.avgQueryTime * (this.metrics.queries - 1) + duration) / 
      this.metrics.queries;
  }
  
  /**
   * Optimize database
   */
  async optimize() {
    let connectionId;
    
    try {
      const { connectionId: connId, db } = await this.getConnection();
      connectionId = connId;
      
      // Run optimization commands
      db.exec('VACUUM');
      db.exec('ANALYZE');
      
      this.logger.info('Database optimization completed');
      
    } finally {
      if (connectionId) {
        this.releaseConnection(connectionId);
      }
    }
  }
  
  /**
   * Get database statistics
   */
  async getStats() {
    let connectionId;
    
    try {
      const { connectionId: connId, db } = await this.getConnection();
      connectionId = connId;
      
      const stats = {
        pageCount: db.pragma('page_count')[0].page_count,
        pageSize: db.pragma('page_size')[0].page_size,
        cacheSize: db.pragma('cache_size')[0].cache_size,
        walCheckpoint: db.pragma('wal_checkpoint(TRUNCATE)')[0],
        performance: this.metrics,
        pool: {
          total: this.pool.length,
          available: this.availableConnections.length,
          active: this.activeConnections.size
        }
      };
      
      if (this.queryCache) {
        stats.cache = this.queryCache.getStats();
      }
      
      return stats;
      
    } finally {
      if (connectionId) {
        this.releaseConnection(connectionId);
      }
    }
  }
  
  /**
   * Close all connections
   */
  close() {
    // Close all connections
    for (const connection of this.pool) {
      connection.db.close();
    }
    
    // Clear caches
    this.preparedStatements.clear();
    this.queryCache?.destroy();
    
    this.logger.info('Database connections closed');
  }
}

/**
 * Query builder for complex queries
 */
export class QueryBuilder {
  constructor(table) {
    this.table = table;
    this.selectColumns = ['*'];
    this.whereConditions = [];
    this.joinClauses = [];
    this.orderByColumns = [];
    this.groupByColumns = [];
    this.havingConditions = [];
    this.limitValue = null;
    this.offsetValue = null;
    this.params = [];
  }
  
  select(...columns) {
    this.selectColumns = columns.length > 0 ? columns : ['*'];
    return this;
  }
  
  where(column, operator, value) {
    if (value === undefined) {
      value = operator;
      operator = '=';
    }
    
    this.whereConditions.push(`${column} ${operator} ?`);
    this.params.push(value);
    return this;
  }
  
  whereIn(column, values) {
    const placeholders = values.map(() => '?').join(',');
    this.whereConditions.push(`${column} IN (${placeholders})`);
    this.params.push(...values);
    return this;
  }
  
  join(table, on) {
    this.joinClauses.push(`JOIN ${table} ON ${on}`);
    return this;
  }
  
  leftJoin(table, on) {
    this.joinClauses.push(`LEFT JOIN ${table} ON ${on}`);
    return this;
  }
  
  orderBy(column, direction = 'ASC') {
    this.orderByColumns.push(`${column} ${direction}`);
    return this;
  }
  
  groupBy(...columns) {
    this.groupByColumns.push(...columns);
    return this;
  }
  
  having(condition) {
    this.havingConditions.push(condition);
    return this;
  }
  
  limit(value) {
    this.limitValue = value;
    return this;
  }
  
  offset(value) {
    this.offsetValue = value;
    return this;
  }
  
  build() {
    let sql = `SELECT ${this.selectColumns.join(', ')} FROM ${this.table}`;
    
    // Add joins
    if (this.joinClauses.length > 0) {
      sql += ' ' + this.joinClauses.join(' ');
    }
    
    // Add where
    if (this.whereConditions.length > 0) {
      sql += ' WHERE ' + this.whereConditions.join(' AND ');
    }
    
    // Add group by
    if (this.groupByColumns.length > 0) {
      sql += ' GROUP BY ' + this.groupByColumns.join(', ');
    }
    
    // Add having
    if (this.havingConditions.length > 0) {
      sql += ' HAVING ' + this.havingConditions.join(' AND ');
    }
    
    // Add order by
    if (this.orderByColumns.length > 0) {
      sql += ' ORDER BY ' + this.orderByColumns.join(', ');
    }
    
    // Add limit/offset
    if (this.limitValue !== null) {
      sql += ` LIMIT ${this.limitValue}`;
    }
    
    if (this.offsetValue !== null) {
      sql += ` OFFSET ${this.offsetValue}`;
    }
    
    return { sql, params: this.params };
  }
}