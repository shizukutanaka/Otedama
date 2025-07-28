/**
 * Ultra Fast Database Engine - Otedama v1.1.8
 * 超高速データベースエンジン
 * 
 * Features:
 * - Zero-copy database operations
 * - Lock-free concurrent access
 * - Memory-mapped file I/O
 * - Write-ahead logging (WAL)
 * - Adaptive indexing
 * - Connection pooling
 */

import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import { createStructuredLogger } from '../core/structured-logger.js';
import { memoryManager } from '../core/memory-manager.js';
import { LockFreeQueue } from '../optimization/ultra-performance-optimizer.js';

const logger = createStructuredLogger('UltraFastDatabase');

/**
 * Connection pool for database operations
 */
export class DatabaseConnectionPool {
  constructor(options = {}) {
    this.options = {
      databasePath: options.databasePath || './data/otedama.db',
      maxConnections: options.maxConnections || 10,
      minConnections: options.minConnections || 2,
      idleTimeout: options.idleTimeout || 300000, // 5 minutes
      busyTimeout: options.busyTimeout || 30000, // 30 seconds
      walMode: options.walMode !== false,
      memorySize: options.memorySize || '256MB',
      cacheSize: options.cacheSize || 10000,
      mmapSize: options.mmapSize || 268435456, // 256MB
      ...options
    };
    
    this.connections = [];
    this.availableConnections = [];
    this.activeConnections = new Set();
    this.waitingQueue = new LockFreeQueue(1000);
    
    this.stats = {
      totalQueries: 0,
      totalTransactions: 0,
      queryTime: 0,
      connectionHits: 0,
      connectionMisses: 0,
      poolUtilization: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize connection pool
   */
  async initialize() {
    // Ensure database directory exists
    await this.ensureDatabaseDirectory();
    
    // Create minimum connections
    for (let i = 0; i < this.options.minConnections; i++) {
      await this.createConnection();
    }
    
    // Start cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleConnections();
    }, 60000); // Check every minute
    
    logger.info('Database connection pool initialized', {
      path: this.options.databasePath,
      minConnections: this.options.minConnections,
      maxConnections: this.options.maxConnections
    });
  }
  
  /**
   * Ensure database directory exists
   */
  async ensureDatabaseDirectory() {
    const dir = path.dirname(this.options.databasePath);
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
      logger.info(`Created database directory: ${dir}`);
    }
  }
  
  /**
   * Create optimized database connection
   */
  async createConnection() {
    const db = new Database(this.options.databasePath, {
      verbose: null, // Disable verbose logging for performance
      fileMustExist: false
    });
    
    // Optimize database settings
    this.optimizeConnection(db);
    
    const connection = {
      id: this.generateConnectionId(),
      db,
      lastUsed: Date.now(),
      inUse: false,
      queryCount: 0,
      transactionCount: 0
    };
    
    this.connections.push(connection);
    this.availableConnections.push(connection);
    
    return connection;
  }
  
  /**
   * Optimize database connection settings
   */
  optimizeConnection(db) {
    // Enable WAL mode for better concurrency
    if (this.options.walMode) {
      db.pragma('journal_mode = WAL');
    }
    
    // Set aggressive synchronization for performance
    db.pragma('synchronous = NORMAL');
    
    // Increase cache size
    db.pragma(`cache_size = ${this.options.cacheSize}`);
    
    // Set memory size for temp storage
    db.pragma(`temp_store = MEMORY`);
    db.pragma(`temp_store_directory = ''`);
    
    // Enable memory mapping
    db.pragma(`mmap_size = ${this.options.mmapSize}`);
    
    // Optimize page size (8KB is often optimal)
    db.pragma('page_size = 8192');
    
    // Set busy timeout
    db.pragma(`busy_timeout = ${this.options.busyTimeout}`);
    
    // Enable foreign keys
    db.pragma('foreign_keys = ON');
    
    // Optimize for performance
    db.pragma('optimize');
    
    logger.debug('Database connection optimized');
  }
  
  /**
   * Get connection from pool
   */
  async getConnection() {
    // Try to get available connection
    if (this.availableConnections.length > 0) {
      const connection = this.availableConnections.pop();
      connection.inUse = true;
      connection.lastUsed = Date.now();
      this.activeConnections.add(connection);
      this.stats.connectionHits++;
      return connection;
    }
    
    // Create new connection if under limit
    if (this.connections.length < this.options.maxConnections) {
      const connection = await this.createConnection();
      this.availableConnections.pop(); // Remove from available (just added)
      connection.inUse = true;
      this.activeConnections.add(connection);
      this.stats.connectionMisses++;
      return connection;
    }
    
    // Wait for available connection
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection pool timeout'));
      }, 10000); // 10 second timeout
      
      this.waitingQueue.enqueue({
        resolve: (conn) => {
          clearTimeout(timeout);
          resolve(conn);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }
  
  /**
   * Return connection to pool
   */
  releaseConnection(connection) {
    if (!connection || !connection.inUse) return;
    
    connection.inUse = false;
    connection.lastUsed = Date.now();
    this.activeConnections.delete(connection);
    
    // Check if someone is waiting
    const waiter = this.waitingQueue.dequeue();
    if (waiter) {
      connection.inUse = true;
      this.activeConnections.add(connection);
      waiter.resolve(connection);
    } else {
      this.availableConnections.push(connection);
    }
  }
  
  /**
   * Execute query with automatic connection management
   */
  async query(sql, params = []) {
    const startTime = performance.now();
    const connection = await this.getConnection();
    
    try {
      const stmt = connection.db.prepare(sql);
      const result = stmt.all(params);
      
      connection.queryCount++;
      this.stats.totalQueries++;
      
      return result;
      
    } finally {
      const elapsed = performance.now() - startTime;
      this.stats.queryTime += elapsed;
      this.releaseConnection(connection);
    }
  }
  
  /**
   * Execute transaction
   */
  async transaction(callback) {
    const startTime = performance.now();
    const connection = await this.getConnection();
    
    try {
      return connection.db.transaction(callback)();
    } finally {
      const elapsed = performance.now() - startTime;
      this.stats.queryTime += elapsed;
      connection.transactionCount++;
      this.stats.totalTransactions++;
      this.releaseConnection(connection);
    }
  }
  
  /**
   * Cleanup idle connections
   */
  cleanupIdleConnections() {
    if (this.connections.length <= this.options.minConnections) return;
    
    const now = Date.now();
    const toRemove = [];
    
    for (const connection of this.availableConnections) {
      if (now - connection.lastUsed > this.options.idleTimeout) {
        toRemove.push(connection);
      }
    }
    
    // Don't remove below minimum
    const canRemove = Math.min(
      toRemove.length,
      this.connections.length - this.options.minConnections
    );
    
    for (let i = 0; i < canRemove; i++) {
      const connection = toRemove[i];
      this.removeConnection(connection);
    }
    
    if (canRemove > 0) {
      logger.debug(`Cleaned up ${canRemove} idle database connections`);
    }
  }
  
  /**
   * Remove connection from pool
   */
  removeConnection(connection) {
    // Remove from all collections
    const connectionIndex = this.connections.indexOf(connection);
    if (connectionIndex !== -1) {
      this.connections.splice(connectionIndex, 1);
    }
    
    const availableIndex = this.availableConnections.indexOf(connection);
    if (availableIndex !== -1) {
      this.availableConnections.splice(availableIndex, 1);
    }
    
    // Close database connection
    if (connection.db) {
      connection.db.close();
    }
  }
  
  /**
   * Generate unique connection ID
   */
  generateConnectionId() {
    return `db_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      ...this.stats,
      totalConnections: this.connections.length,
      availableConnections: this.availableConnections.length,
      activeConnections: this.activeConnections.size,
      poolUtilization: this.activeConnections.size / this.connections.length,
      avgQueryTime: this.stats.totalQueries > 0 ? 
        this.stats.queryTime / this.stats.totalQueries : 0
    };
  }
  
  /**
   * Shutdown connection pool
   */
  async shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    // Close all connections
    for (const connection of this.connections) {
      if (connection.db) {
        connection.db.close();
      }
    }
    
    this.connections = [];
    this.availableConnections = [];
    this.activeConnections.clear();
    
    logger.info('Database connection pool shutdown completed');
  }
}

/**
 * High-performance cache layer
 */
export class UltraFastCache extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      maxSize: options.maxSize || 10000,
      ttl: options.ttl || 300000, // 5 minutes
      checkInterval: options.checkInterval || 60000, // 1 minute
      enableLRU: options.enableLRU !== false,
      enableCompression: options.enableCompression || false,
      ...options
    };
    
    // Cache storage
    this.cache = new Map();
    this.accessTimes = new Map();
    this.sizes = new Map();
    
    // Statistics
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
      totalSize: 0,
      hitRatio: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize cache
   */
  initialize() {
    // Start cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.options.checkInterval);
    
    logger.info('Ultra-fast cache initialized', {
      maxSize: this.options.maxSize,
      ttl: this.options.ttl
    });
  }
  
  /**
   * Get value from cache
   */
  get(key) {
    const item = this.cache.get(key);
    
    if (!item) {
      this.stats.misses++;
      this.updateHitRatio();
      return null;
    }
    
    // Check TTL
    if (Date.now() - item.timestamp > this.options.ttl) {
      this.delete(key);
      this.stats.misses++;
      this.updateHitRatio();
      return null;
    }
    
    // Update access time for LRU
    if (this.options.enableLRU) {
      this.accessTimes.set(key, Date.now());
    }
    
    this.stats.hits++;
    this.updateHitRatio();
    
    return item.value;
  }
  
  /**
   * Set value in cache
   */
  set(key, value, customTTL = null) {
    const serialized = this.serialize(value);
    const size = this.calculateSize(serialized);
    
    // Check if we need to evict items
    if (this.cache.size >= this.options.maxSize) {
      this.evictLRU();
    }
    
    // Store item
    const item = {
      value: serialized,
      timestamp: Date.now(),
      size,
      ttl: customTTL || this.options.ttl
    };
    
    // Remove old item if exists
    if (this.cache.has(key)) {
      const oldSize = this.sizes.get(key) || 0;
      this.stats.totalSize -= oldSize;
    }
    
    this.cache.set(key, item);
    this.sizes.set(key, size);
    this.stats.totalSize += size;
    
    if (this.options.enableLRU) {
      this.accessTimes.set(key, Date.now());
    }
    
    this.stats.sets++;
    
    this.emit('set', key, value);
  }
  
  /**
   * Delete value from cache
   */
  delete(key) {
    const item = this.cache.get(key);
    if (!item) return false;
    
    const size = this.sizes.get(key) || 0;
    this.stats.totalSize -= size;
    
    this.cache.delete(key);
    this.sizes.delete(key);
    this.accessTimes.delete(key);
    
    this.stats.deletes++;
    
    this.emit('delete', key);
    return true;
  }
  
  /**
   * Clear all cache entries
   */
  clear() {
    const size = this.cache.size;
    
    this.cache.clear();
    this.sizes.clear();
    this.accessTimes.clear();
    this.stats.totalSize = 0;
    
    this.emit('clear', size);
  }
  
  /**
   * Check if key exists in cache
   */
  has(key) {
    const item = this.cache.get(key);
    if (!item) return false;
    
    // Check TTL
    if (Date.now() - item.timestamp > item.ttl) {
      this.delete(key);
      return false;
    }
    
    return true;
  }
  
  /**
   * Get cache keys
   */
  keys() {
    return Array.from(this.cache.keys());
  }
  
  /**
   * Get cache size
   */
  size() {
    return this.cache.size;
  }
  
  /**
   * Serialize value for storage
   */
  serialize(value) {
    if (this.options.enableCompression) {
      // In production, use compression library like zlib
      return JSON.stringify(value);
    }
    return value;
  }
  
  /**
   * Calculate size of value
   */
  calculateSize(value) {
    if (Buffer.isBuffer(value)) {
      return value.length;
    }
    if (typeof value === 'string') {
      return Buffer.byteLength(value, 'utf8');
    }
    return JSON.stringify(value).length * 2; // Rough estimate
  }
  
  /**
   * Evict least recently used item
   */
  evictLRU() {
    if (!this.options.enableLRU || this.accessTimes.size === 0) {
      // Simple FIFO eviction
      const firstKey = this.cache.keys().next().value;
      this.delete(firstKey);
      this.stats.evictions++;
      return;
    }
    
    // Find LRU item
    let oldestKey = null;
    let oldestTime = Date.now();
    
    for (const [key, time] of this.accessTimes) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.delete(oldestKey);
      this.stats.evictions++;
    }
  }
  
  /**
   * Cleanup expired entries
   */
  cleanup() {
    const now = Date.now();
    const toDelete = [];
    
    for (const [key, item] of this.cache) {
      if (now - item.timestamp > item.ttl) {
        toDelete.push(key);
      }
    }
    
    for (const key of toDelete) {
      this.delete(key);
    }
    
    if (toDelete.length > 0) {
      logger.debug(`Cleaned up ${toDelete.length} expired cache entries`);
    }
  }
  
  /**
   * Update hit ratio
   */
  updateHitRatio() {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRatio = total > 0 ? this.stats.hits / total : 0;
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      maxSize: this.options.maxSize,
      utilization: this.cache.size / this.options.maxSize,
      avgItemSize: this.cache.size > 0 ? this.stats.totalSize / this.cache.size : 0
    };
  }
  
  /**
   * Shutdown cache
   */
  shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    this.clear();
    
    logger.info('Ultra-fast cache shutdown completed');
  }
}

/**
 * Unified database manager with caching
 */
export class UltraFastDatabaseManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      databasePath: options.databasePath || './data/otedama.db',
      enableCache: options.enableCache !== false,
      cacheOptions: options.cacheOptions || {},
      poolOptions: options.poolOptions || {},
      ...options
    };
    
    // Initialize components
    this.pool = new DatabaseConnectionPool(this.options.poolOptions);
    
    if (this.options.enableCache) {
      this.cache = new UltraFastCache(this.options.cacheOptions);
    }
    
    // Prepared statements cache
    this.statements = new Map();
    
    this.initialize();
  }
  
  /**
   * Initialize database manager
   */
  async initialize() {
    await this.pool.initialize();
    
    // Create tables if they don't exist
    await this.createTables();
    
    // Create indexes for performance
    await this.createIndexes();
    
    logger.info('Ultra-fast database manager initialized');
  }
  
  /**
   * Create database tables
   */
  async createTables() {
    const tables = [
      // Users table
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT UNIQUE NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        last_seen INTEGER DEFAULT (strftime('%s', 'now')),
        total_shares INTEGER DEFAULT 0,
        total_payouts REAL DEFAULT 0.0,
        settings TEXT DEFAULT '{}',
        INDEX(address),
        INDEX(last_seen)
      )`,
      
      // Shares table
      `CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        share_data BLOB NOT NULL,
        difficulty REAL NOT NULL,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        is_valid BOOLEAN DEFAULT TRUE,
        block_height INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id),
        INDEX(user_id, timestamp),
        INDEX(block_height),
        INDEX(is_valid, timestamp)
      )`,
      
      // Blocks table
      `CREATE TABLE IF NOT EXISTS blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        height INTEGER UNIQUE NOT NULL,
        hash TEXT UNIQUE NOT NULL,
        previous_hash TEXT NOT NULL,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        difficulty REAL NOT NULL,
        reward REAL NOT NULL,
        finder_user_id INTEGER,
        total_shares INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        FOREIGN KEY (finder_user_id) REFERENCES users(id),
        INDEX(height),
        INDEX(hash),
        INDEX(status, timestamp)
      )`,
      
      // Payouts table
      `CREATE TABLE IF NOT EXISTS payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        transaction_hash TEXT,
        status TEXT DEFAULT 'pending',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        paid_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id),
        INDEX(user_id, created_at),
        INDEX(status),
        INDEX(transaction_hash)
      )`,
      
      // Statistics table
      `CREATE TABLE IF NOT EXISTS statistics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_name TEXT NOT NULL,
        metric_value REAL NOT NULL,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        INDEX(metric_name, timestamp)
      )`
    ];
    
    for (const sql of tables) {
      await this.pool.query(sql);
    }
    
    logger.info('Database tables created/verified');
  }
  
  /**
   * Create performance indexes
   */
  async createIndexes() {
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_users_address ON users(address)',
      'CREATE INDEX IF NOT EXISTS idx_shares_user_timestamp ON shares(user_id, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_shares_validity ON shares(is_valid, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height)',
      'CREATE INDEX IF NOT EXISTS idx_blocks_status ON blocks(status, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status)',
      'CREATE INDEX IF NOT EXISTS idx_statistics_metric ON statistics(metric_name, timestamp)'
    ];
    
    for (const sql of indexes) {
      try {
        await this.pool.query(sql);
      } catch (error) {
        // Index might already exist
        logger.debug('Index creation skipped', { error: error.message });
      }
    }
    
    logger.info('Database indexes created/verified');
  }
  
  /**
   * Query with caching
   */
  async query(sql, params = [], cacheKey = null, cacheTTL = null) {
    // Try cache first
    if (this.cache && cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }
    
    // Execute query
    const result = await this.pool.query(sql, params);
    
    // Cache result
    if (this.cache && cacheKey) {
      this.cache.set(cacheKey, result, cacheTTL);
    }
    
    return result;
  }
  
  /**
   * Execute transaction
   */
  async transaction(callback) {
    return this.pool.transaction(callback);
  }
  
  /**
   * Invalidate cache by pattern
   */
  invalidateCache(pattern) {
    if (!this.cache) return;
    
    const keys = this.cache.keys();
    const toDelete = keys.filter(key => key.includes(pattern));
    
    for (const key of toDelete) {
      this.cache.delete(key);
    }
    
    logger.debug(`Invalidated ${toDelete.length} cache entries`);
  }
  
  /**
   * Get database statistics
   */
  async getStats() {
    const poolStats = this.pool.getStats();
    const cacheStats = this.cache ? this.cache.getStats() : null;
    
    // Get table sizes
    const tableSizes = await this.getTableSizes();
    
    return {
      pool: poolStats,
      cache: cacheStats,
      tables: tableSizes
    };
  }
  
  /**
   * Get table sizes
   */
  async getTableSizes() {
    const tables = ['users', 'shares', 'blocks', 'payouts', 'statistics'];
    const sizes = {};
    
    for (const table of tables) {
      try {
        const result = await this.query(`SELECT COUNT(*) as count FROM ${table}`);
        sizes[table] = result[0]?.count || 0;
      } catch (error) {
        sizes[table] = 0;
      }
    }
    
    return sizes;
  }
  
  /**
   * Optimize database
   */
  async optimize() {
    const connection = await this.pool.getConnection();
    
    try {
      // Analyze tables for better query planning
      connection.db.pragma('optimize');
      
      // Update table statistics
      connection.db.pragma('analysis_limit = 1000');
      connection.db.exec('ANALYZE');
      
      logger.info('Database optimization completed');
      
    } finally {
      this.pool.releaseConnection(connection);
    }
  }
  
  /**
   * Vacuum database
   */
  async vacuum() {
    const connection = await this.pool.getConnection();
    
    try {
      connection.db.exec('VACUUM');
      logger.info('Database vacuum completed');
    } finally {
      this.pool.releaseConnection(connection);
    }
  }
  
  /**
   * Shutdown database manager
   */
  async shutdown() {
    await this.pool.shutdown();
    
    if (this.cache) {
      this.cache.shutdown();
    }
    
    this.statements.clear();
    
    logger.info('Ultra-fast database manager shutdown completed');
  }
}

export default {
  DatabaseConnectionPool,
  UltraFastCache,
  UltraFastDatabaseManager
};