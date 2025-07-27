/**
 * Database Connection Pool - Otedama
 * Optimized connection pooling for high performance
 * 
 * Design principles:
 * - Carmack: Zero-overhead connection management
 * - Martin: Clean pool architecture
 * - Pike: Simple but efficient
 */

import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { createStructuredLogger } from '../core/structured-logger.js';
import { memoryManager } from '../core/memory-manager.js';

const logger = createStructuredLogger('ConnectionPool');

/**
 * Connection states
 */
export const ConnectionState = {
  IDLE: 'idle',
  ACTIVE: 'active',
  STALE: 'stale',
  CLOSING: 'closing'
};

/**
 * Pool configuration defaults
 */
const DEFAULT_CONFIG = {
  min: 2,                    // Minimum connections
  max: 10,                   // Maximum connections
  acquireTimeout: 30000,     // 30 seconds to acquire
  idleTimeout: 60000,        // 1 minute idle timeout
  reapInterval: 30000,       // 30 seconds reap interval
  validateOnBorrow: true,    // Validate before use
  fifo: false,              // LIFO for better cache locality
  pragmas: {                // SQLite optimizations
    journal_mode: 'WAL',
    synchronous: 'NORMAL',
    cache_size: -2000,      // 2MB cache
    mmap_size: 30000000000, // 30GB mmap
    temp_store: 'MEMORY',
    page_size: 4096,
    busy_timeout: 5000,
    analysis_limit: 1000,
    optimize: true
  }
};

/**
 * Database connection wrapper
 */
class PooledConnection {
  constructor(pool, config) {
    this.pool = pool;
    this.config = config;
    this.id = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.state = ConnectionState.IDLE;
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
    this.useCount = 0;
    this.db = null;
    
    this.initialize();
  }
  
  initialize() {
    try {
      this.db = new Database(this.config.filename, this.config.options);
      
      // Apply pragmas
      for (const [pragma, value] of Object.entries(this.config.pragmas)) {
        if (pragma === 'optimize') {
          this.db.pragma('optimize');
        } else {
          this.db.pragma(`${pragma} = ${value}`);
        }
      }
      
      // Prepare common statements
      this.preparedStatements = new Map();
      
      logger.debug('Connection initialized', { id: this.id });
    } catch (error) {
      logger.error('Failed to initialize connection', { id: this.id, error });
      throw error;
    }
  }
  
  validate() {
    if (!this.db) return false;
    
    try {
      // Simple validation query
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }
  
  acquire() {
    this.state = ConnectionState.ACTIVE;
    this.lastUsedAt = Date.now();
    this.useCount++;
  }
  
  release() {
    this.state = ConnectionState.IDLE;
    this.lastUsedAt = Date.now();
  }
  
  isStale() {
    const idleTime = Date.now() - this.lastUsedAt;
    return idleTime > this.pool.config.idleTimeout;
  }
  
  close() {
    if (this.state === ConnectionState.CLOSING) return;
    
    this.state = ConnectionState.CLOSING;
    
    try {
      // Close prepared statements
      for (const stmt of this.preparedStatements.values()) {
        if (stmt && typeof stmt.finalize === 'function') {
          stmt.finalize();
        }
      }
      this.preparedStatements.clear();
      
      // Close database
      if (this.db) {
        this.db.close();
        this.db = null;
      }
      
      logger.debug('Connection closed', { 
        id: this.id, 
        useCount: this.useCount,
        lifetime: Date.now() - this.createdAt
      });
    } catch (error) {
      logger.error('Error closing connection', { id: this.id, error });
    }
  }
  
  /**
   * Prepare and cache statement
   */
  prepare(sql) {
    let stmt = this.preparedStatements.get(sql);
    
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.preparedStatements.set(sql, stmt);
    }
    
    return stmt;
  }
}

/**
 * High-performance connection pool
 */
export class ConnectionPool extends EventEmitter {
  constructor(filename, config = {}) {
    super();
    
    this.filename = filename;
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Pool state
    this.connections = [];
    this.available = [];
    this.pending = [];
    this.isClosing = false;
    
    // Statistics
    this.stats = {
      created: 0,
      acquired: 0,
      released: 0,
      failed: 0,
      timeouts: 0,
      stale: 0
    };
    
    // Initialize pool
    this.initialize();
  }
  
  async initialize() {
    // Create minimum connections
    for (let i = 0; i < this.config.min; i++) {
      try {
        const conn = this.createConnection();
        this.connections.push(conn);
        this.available.push(conn);
      } catch (error) {
        logger.error('Failed to create initial connection', error);
      }
    }
    
    // Start reaper
    this.startReaper();
    
    logger.info('Connection pool initialized', {
      min: this.config.min,
      max: this.config.max,
      current: this.connections.length
    });
  }
  
  /**
   * Create new connection
   */
  createConnection() {
    const conn = new PooledConnection(this, {
      filename: this.filename,
      options: this.config.options || {},
      pragmas: this.config.pragmas
    });
    
    this.stats.created++;
    this.emit('connection:created', conn.id);
    
    return conn;
  }
  
  /**
   * Acquire connection from pool
   */
  async acquire() {
    if (this.isClosing) {
      throw new Error('Pool is closing');
    }
    
    // Try to get available connection
    let conn = this.getAvailableConnection();
    
    if (conn) {
      return this.prepareConnection(conn);
    }
    
    // Create new if under limit
    if (this.connections.length < this.config.max) {
      try {
        conn = this.createConnection();
        this.connections.push(conn);
        return this.prepareConnection(conn);
      } catch (error) {
        this.stats.failed++;
        throw error;
      }
    }
    
    // Wait for available connection
    return this.waitForConnection();
  }
  
  /**
   * Get available connection
   */
  getAvailableConnection() {
    // Use LIFO for better cache locality (unless FIFO configured)
    const conn = this.config.fifo 
      ? this.available.shift()
      : this.available.pop();
    
    if (!conn) return null;
    
    // Validate if configured
    if (this.config.validateOnBorrow && !conn.validate()) {
      logger.warn('Connection validation failed', { id: conn.id });
      this.removeConnection(conn);
      return this.getAvailableConnection();
    }
    
    return conn;
  }
  
  /**
   * Prepare connection for use
   */
  prepareConnection(conn) {
    conn.acquire();
    this.stats.acquired++;
    this.emit('connection:acquired', conn.id);
    
    // Wrap database methods
    const wrapper = {
      _conn: conn,
      _released: false,
      
      // Delegate database methods
      prepare: (sql) => conn.prepare(sql),
      exec: (sql) => conn.db.exec(sql),
      transaction: (fn) => conn.db.transaction(fn),
      
      // Release connection back to pool
      release: () => {
        if (wrapper._released) return;
        wrapper._released = true;
        this.release(conn);
      },
      
      // Auto-release on GC
      [Symbol.dispose]: () => {
        if (!wrapper._released) {
          wrapper.release();
        }
      }
    };
    
    // Proxy all database methods
    return new Proxy(wrapper, {
      get(target, prop) {
        if (prop in target) {
          return target[prop];
        }
        
        // Check if connection was released
        if (target._released) {
          throw new Error('Connection already released');
        }
        
        // Delegate to database
        const db = target._conn.db;
        const value = db[prop];
        
        if (typeof value === 'function') {
          return value.bind(db);
        }
        
        return value;
      }
    });
  }
  
  /**
   * Wait for available connection
   */
  waitForConnection() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.indexOf(promise);
        if (index !== -1) {
          this.pending.splice(index, 1);
        }
        
        this.stats.timeouts++;
        reject(new Error('Connection acquire timeout'));
      }, this.config.acquireTimeout);
      
      const promise = { resolve, reject, timer };
      this.pending.push(promise);
    });
  }
  
  /**
   * Release connection back to pool
   */
  release(conn) {
    conn.release();
    this.stats.released++;
    this.emit('connection:released', conn.id);
    
    // Check if pending requests
    if (this.pending.length > 0) {
      const { resolve, timer } = this.pending.shift();
      clearTimeout(timer);
      resolve(this.prepareConnection(conn));
      return;
    }
    
    // Add back to available pool
    if (this.config.fifo) {
      this.available.push(conn);
    } else {
      this.available.unshift(conn);
    }
  }
  
  /**
   * Remove connection from pool
   */
  removeConnection(conn) {
    const index = this.connections.indexOf(conn);
    if (index !== -1) {
      this.connections.splice(index, 1);
    }
    
    const availIndex = this.available.indexOf(conn);
    if (availIndex !== -1) {
      this.available.splice(availIndex, 1);
    }
    
    conn.close();
    this.emit('connection:removed', conn.id);
  }
  
  /**
   * Start connection reaper
   */
  startReaper() {
    this.reaperInterval = setInterval(() => {
      this.reapStaleConnections();
    }, this.config.reapInterval);
  }
  
  /**
   * Reap stale connections
   */
  reapStaleConnections() {
    const stale = [];
    const minConnections = this.config.min;
    
    // Find stale connections
    for (let i = this.available.length - 1; i >= 0; i--) {
      const conn = this.available[i];
      
      if (conn.isStale() && this.connections.length > minConnections) {
        stale.push(conn);
        this.available.splice(i, 1);
      }
    }
    
    // Remove stale connections
    for (const conn of stale) {
      this.removeConnection(conn);
      this.stats.stale++;
    }
    
    if (stale.length > 0) {
      logger.debug('Reaped stale connections', { count: stale.length });
    }
  }
  
  /**
   * Execute query with automatic connection management
   */
  async execute(sql, params = []) {
    const conn = await this.acquire();
    
    try {
      const stmt = conn.prepare(sql);
      const result = params.length > 0 
        ? stmt.all(...params)
        : stmt.all();
      
      return result;
    } finally {
      conn.release();
    }
  }
  
  /**
   * Run query that modifies data
   */
  async run(sql, params = []) {
    const conn = await this.acquire();
    
    try {
      const stmt = conn.prepare(sql);
      const result = params.length > 0
        ? stmt.run(...params)
        : stmt.run();
      
      return result;
    } finally {
      conn.release();
    }
  }
  
  /**
   * Get single row
   */
  async get(sql, params = []) {
    const conn = await this.acquire();
    
    try {
      const stmt = conn.prepare(sql);
      const result = params.length > 0
        ? stmt.get(...params)
        : stmt.get();
      
      return result;
    } finally {
      conn.release();
    }
  }
  
  /**
   * Execute transaction
   */
  async transaction(fn) {
    const conn = await this.acquire();
    
    try {
      const result = await conn.transaction(fn)();
      return result;
    } finally {
      conn.release();
    }
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      ...this.stats,
      total: this.connections.length,
      active: this.connections.length - this.available.length,
      available: this.available.length,
      pending: this.pending.length
    };
  }
  
  /**
   * Close pool
   */
  async close() {
    this.isClosing = true;
    
    // Clear reaper
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
    }
    
    // Reject pending requests
    for (const { reject, timer } of this.pending) {
      clearTimeout(timer);
      reject(new Error('Pool is closing'));
    }
    this.pending = [];
    
    // Close all connections
    const closePromises = this.connections.map(conn => {
      return new Promise(resolve => {
        conn.close();
        resolve();
      });
    });
    
    await Promise.all(closePromises);
    
    this.connections = [];
    this.available = [];
    
    logger.info('Connection pool closed', this.stats);
    this.emit('closed');
  }
}

/**
 * Connection pool factory
 */
export function createConnectionPool(filename, config) {
  return new ConnectionPool(filename, config);
}

/**
 * Global connection pool manager
 */
class ConnectionPoolManager {
  constructor() {
    this.pools = new Map();
  }
  
  /**
   * Get or create pool
   */
  getPool(name, filename, config) {
    let pool = this.pools.get(name);
    
    if (!pool) {
      pool = createConnectionPool(filename, config);
      this.pools.set(name, pool);
    }
    
    return pool;
  }
  
  /**
   * Close all pools
   */
  async closeAll() {
    const promises = [];
    
    for (const [name, pool] of this.pools) {
      promises.push(pool.close());
    }
    
    await Promise.all(promises);
    this.pools.clear();
  }
}

// Export singleton manager
export const poolManager = new ConnectionPoolManager();

export default ConnectionPool;