/**
 * SQLite Connection Pool
 * Optimized database connection pooling for SQLite
 */

const sqlite3 = require('sqlite3').verbose();
const { BasePool } = require('../common/base-pool');

class SQLiteConnectionPool extends BasePool {
  constructor(options = {}) {
    super('SQLiteConnectionPool', {
      // BasePool configuration
      minSize: options.minConnections || 2,
      maxSize: options.maxConnections || 10,
      acquireTimeout: options.acquireTimeout || 30000,
      idleTimeout: options.idleTimeout || 300000,
      evictionInterval: options.evictionInterval || 60000,
      
      // SQLite specific configuration
      filename: options.filename || ':memory:',
      mode: options.mode || sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
      
      // Performance optimizations
      busyTimeout: options.busyTimeout || 5000,
      cacheSize: options.cacheSize || 10000, // Pages
      pageSize: options.pageSize || 4096, // Bytes
      journalMode: options.journalMode || 'WAL',
      synchronous: options.synchronous || 'NORMAL',
      tempStore: options.tempStore || 'MEMORY',
      mmapSize: options.mmapSize || 268435456, // 256MB
      
      // Query optimization
      analyzeOnStart: options.analyzeOnStart !== false,
      vacuumInterval: options.vacuumInterval || 86400000, // 24 hours
      checkpointInterval: options.checkpointInterval || 300000, // 5 minutes
      
      ...options
    });
    
    // Statement cache for prepared statements
    this.statementCache = new Map();
    this.maxStatementCacheSize = options.statementCacheSize || 100;
    
    // Query statistics
    this.queryStats = {
      totalQueries: 0,
      cachedQueries: 0,
      slowQueries: 0,
      errors: 0
    };
  }
  
  /**
   * Create a new SQLite connection
   */
  async onCreateResource() {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(this.config.filename, this.config.mode, async (err) => {
        if (err) {
          this.logger.error('Failed to create database connection:', err);
          reject(err);
          return;
        }
        
        try {
          // Apply performance optimizations
          await this.optimizeConnection(db);
          
          // Wrap database with enhanced methods
          const enhancedDb = this.enhanceDatabase(db);
          
          this.logger.debug('Created new database connection');
          resolve(enhancedDb);
        } catch (error) {
          db.close();
          reject(error);
        }
      });
    });
  }
  
  /**
   * Destroy a database connection
   */
  async onDestroyResource(db) {
    return new Promise((resolve) => {
      // Clear any cached statements for this connection
      this.clearStatementsForConnection(db);
      
      db.close((err) => {
        if (err) {
          this.logger.error('Error closing database connection:', err);
        }
        resolve();
      });
    });
  }
  
  /**
   * Validate a database connection
   */
  async onValidateResource(db) {
    return new Promise((resolve) => {
      db.get('SELECT 1', (err) => {
        resolve(!err);
      });
    });
  }
  
  /**
   * Initialize the pool
   */
  async onInitialize() {
    // Start maintenance tasks
    this.startTimer('vacuum', () => this.performVacuum(), this.config.vacuumInterval);
    this.startTimer('checkpoint', () => this.performCheckpoint(), this.config.checkpointInterval);
    
    // Perform initial analysis if enabled
    if (this.config.analyzeOnStart) {
      setTimeout(() => this.analyze(), 5000); // Delay to allow pool to fill
    }
  }
  
  /**
   * Apply performance optimizations to a connection
   */
  async optimizeConnection(db) {
    const pragmas = [
      `PRAGMA busy_timeout = ${this.config.busyTimeout}`,
      `PRAGMA cache_size = ${this.config.cacheSize}`,
      `PRAGMA page_size = ${this.config.pageSize}`,
      `PRAGMA journal_mode = ${this.config.journalMode}`,
      `PRAGMA synchronous = ${this.config.synchronous}`,
      `PRAGMA temp_store = ${this.config.tempStore}`,
      `PRAGMA mmap_size = ${this.config.mmapSize}`,
      'PRAGMA foreign_keys = ON',
      'PRAGMA recursive_triggers = ON'
    ];
    
    for (const pragma of pragmas) {
      await this.runAsync(db, pragma);
    }
  }
  
  /**
   * Enhance database with additional methods
   */
  enhanceDatabase(db) {
    const pool = this;
    
    // Add async versions of methods
    db.runAsync = function(sql, params = []) {
      return pool.runAsync(this, sql, params);
    };
    
    db.getAsync = function(sql, params = []) {
      return pool.getAsync(this, sql, params);
    };
    
    db.allAsync = function(sql, params = []) {
      return pool.allAsync(this, sql, params);
    };
    
    db.execAsync = function(sql) {
      return pool.execAsync(this, sql);
    };
    
    // Add prepared statement support
    db.prepare = function(sql) {
      return pool.prepareStatement(this, sql);
    };
    
    // Add transaction support
    db.transaction = function(callback) {
      return pool.transaction(this, callback);
    };
    
    return db;
  }
  
  /**
   * Run a query (INSERT, UPDATE, DELETE)
   */
  async runAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      db.run(sql, params, function(err) {
        const duration = Date.now() - startTime;
        
        if (err) {
          this.queryStats.errors++;
          reject(err);
        } else {
          this.queryStats.totalQueries++;
          if (duration > 1000) this.queryStats.slowQueries++;
          
          resolve({
            lastID: this.lastID,
            changes: this.changes
          });
        }
      });
    });
  }
  
  /**
   * Get a single row
   */
  async getAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) {
          this.queryStats.errors++;
          reject(err);
        } else {
          this.queryStats.totalQueries++;
          resolve(row);
        }
      });
    });
  }
  
  /**
   * Get all rows
   */
  async allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) {
          this.queryStats.errors++;
          reject(err);
        } else {
          this.queryStats.totalQueries++;
          resolve(rows);
        }
      });
    });
  }
  
  /**
   * Execute SQL (for DDL statements)
   */
  async execAsync(db, sql) {
    return new Promise((resolve, reject) => {
      db.exec(sql, (err) => {
        if (err) {
          this.queryStats.errors++;
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
  
  /**
   * Prepare a statement (with caching)
   */
  prepareStatement(db, sql) {
    const cacheKey = `${db.filename}:${sql}`;
    
    // Check cache
    if (this.statementCache.has(cacheKey)) {
      this.queryStats.cachedQueries++;
      return this.statementCache.get(cacheKey);
    }
    
    // Create new statement
    const stmt = db.prepare(sql);
    
    // Cache it
    if (this.statementCache.size >= this.maxStatementCacheSize) {
      // Evict oldest statement
      const firstKey = this.statementCache.keys().next().value;
      const oldStmt = this.statementCache.get(firstKey);
      oldStmt.finalize();
      this.statementCache.delete(firstKey);
    }
    
    this.statementCache.set(cacheKey, stmt);
    return stmt;
  }
  
  /**
   * Execute a transaction
   */
  async transaction(db, callback) {
    await this.runAsync(db, 'BEGIN TRANSACTION');
    
    try {
      const result = await callback(db);
      await this.runAsync(db, 'COMMIT');
      return result;
    } catch (error) {
      await this.runAsync(db, 'ROLLBACK');
      throw error;
    }
  }
  
  /**
   * Clear statements for a specific connection
   */
  clearStatementsForConnection(db) {
    const prefix = `${db.filename}:`;
    
    for (const [key, stmt] of this.statementCache.entries()) {
      if (key.startsWith(prefix)) {
        stmt.finalize();
        this.statementCache.delete(key);
      }
    }
  }
  
  /**
   * Perform database analysis
   */
  async analyze() {
    const db = await this.acquire();
    try {
      await this.execAsync(db, 'ANALYZE');
      this.logger.info('Database analysis completed');
    } catch (error) {
      this.logger.error('Database analysis failed:', error);
    } finally {
      await this.release(db);
    }
  }
  
  /**
   * Perform database vacuum
   */
  async performVacuum() {
    const db = await this.acquire();
    try {
      await this.execAsync(db, 'VACUUM');
      this.logger.info('Database vacuum completed');
    } catch (error) {
      this.logger.error('Database vacuum failed:', error);
    } finally {
      await this.release(db);
    }
  }
  
  /**
   * Perform WAL checkpoint
   */
  async performCheckpoint() {
    const db = await this.acquire();
    try {
      await this.execAsync(db, 'PRAGMA wal_checkpoint(TRUNCATE)');
      this.logger.debug('WAL checkpoint completed');
    } catch (error) {
      this.logger.error('WAL checkpoint failed:', error);
    } finally {
      await this.release(db);
    }
  }
  
  /**
   * Get pool statistics
   */
  async getStats() {
    const baseStats = await super.getStats();
    
    return {
      ...baseStats,
      database: {
        ...this.queryStats,
        statementCacheSize: this.statementCache.size,
        cacheHitRate: this.queryStats.totalQueries > 0 
          ? this.queryStats.cachedQueries / this.queryStats.totalQueries 
          : 0,
        errorRate: this.queryStats.totalQueries > 0
          ? this.queryStats.errors / this.queryStats.totalQueries
          : 0
      }
    };
  }
  
  /**
   * Cleanup on shutdown
   */
  async onShutdown() {
    // Finalize all cached statements
    for (const stmt of this.statementCache.values()) {
      stmt.finalize();
    }
    this.statementCache.clear();
  }
}

module.exports = SQLiteConnectionPool;