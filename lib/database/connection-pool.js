/**
 * High-Performance Database Connection Pool
 * Implements connection pooling with prepared statement caching
 */

const Database = require('better-sqlite3');
const EventEmitter = require('events');
const { createLogger } = require('../core/logger');

const logger = createLogger('connection-pool');

class ConnectionPool extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      filename: options.filename || './data/otedama.db',
      minConnections: options.minConnections || 2,
      maxConnections: options.maxConnections || 10,
      acquireTimeout: options.acquireTimeout || 30000,
      idleTimeout: options.idleTimeout || 60000,
      refreshIdle: options.refreshIdle || false,
      readonly: options.readonly || false,
      memory: options.memory || false,
      verbose: options.verbose || null,
      fileMustExist: options.fileMustExist || false,
      wal: options.wal !== false, // Enable WAL mode by default
      synchronous: options.synchronous || 'NORMAL',
      cacheSize: options.cacheSize || 10000,
      mmap: options.mmap || 2147483648, // 2GB
      ...options
    };

    this.connections = [];
    this.available = [];
    this.pending = [];
    this.statements = new Map();
    this.metrics = {
      created: 0,
      destroyed: 0,
      acquired: 0,
      released: 0,
      timeouts: 0,
      errors: 0
    };

    this._initialized = false;
    this._closing = false;
    this._maintenanceInterval = null;
  }

  async initialize() {
    if (this._initialized) {
      return;
    }

    logger.info('Initializing connection pool', {
      minConnections: this.options.minConnections,
      maxConnections: this.options.maxConnections
    });

    // Create initial connections
    const promises = [];
    for (let i = 0; i < this.options.minConnections; i++) {
      promises.push(this._createConnection());
    }

    await Promise.all(promises);

    // Start maintenance interval
    this._maintenanceInterval = setInterval(() => {
      this._performMaintenance();
    }, 30000); // Every 30 seconds

    this._initialized = true;
    logger.info('Connection pool initialized');
  }

  async acquire() {
    if (this._closing) {
      throw new Error('Connection pool is closing');
    }

    const startTime = Date.now();
    const timeout = this.options.acquireTimeout;

    return new Promise((resolve, reject) => {
      const tryAcquire = () => {
        // Check available connections
        if (this.available.length > 0) {
          const connection = this.available.pop();
          connection.lastUsed = Date.now();
          connection.inUse = true;
          this.metrics.acquired++;
          resolve(connection);
          return;
        }

        // Create new connection if under limit
        if (this.connections.length < this.options.maxConnections) {
          this._createConnection()
            .then(connection => {
              connection.inUse = true;
              this.metrics.acquired++;
              resolve(connection);
            })
            .catch(reject);
          return;
        }

        // Check timeout
        if (Date.now() - startTime > timeout) {
          this.metrics.timeouts++;
          reject(new Error(`Connection acquire timeout after ${timeout}ms`));
          return;
        }

        // Add to pending queue
        this.pending.push({ resolve, reject, tryAcquire });
      };

      tryAcquire();
    });
  }

  release(connection) {
    if (!connection || connection.destroyed) {
      return;
    }

    connection.inUse = false;
    connection.lastUsed = Date.now();

    // Check if any pending requests
    if (this.pending.length > 0) {
      const pending = this.pending.shift();
      connection.inUse = true;
      this.metrics.acquired++;
      pending.resolve(connection);
      return;
    }

    // Add back to available pool
    this.available.push(connection);
    this.metrics.released++;
  }

  async execute(sql, params = []) {
    const connection = await this.acquire();
    try {
      return connection.db.prepare(sql).all(...params);
    } finally {
      this.release(connection);
    }
  }

  async get(sql, params = []) {
    const connection = await this.acquire();
    try {
      return connection.db.prepare(sql).get(...params);
    } finally {
      this.release(connection);
    }
  }

  async run(sql, params = []) {
    const connection = await this.acquire();
    try {
      return connection.db.prepare(sql).run(...params);
    } finally {
      this.release(connection);
    }
  }

  async transaction(callback) {
    const connection = await this.acquire();
    try {
      return connection.db.transaction(callback)();
    } finally {
      this.release(connection);
    }
  }

  async prepare(sql) {
    // Check cache
    if (this.statements.has(sql)) {
      return this.statements.get(sql);
    }

    const connection = await this.acquire();
    try {
      const statement = connection.db.prepare(sql);
      
      // Create wrapper that acquires connection for each execution
      const wrappedStatement = {
        run: async (...params) => {
          const conn = await this.acquire();
          try {
            return conn.db.prepare(sql).run(...params);
          } finally {
            this.release(conn);
          }
        },
        get: async (...params) => {
          const conn = await this.acquire();
          try {
            return conn.db.prepare(sql).get(...params);
          } finally {
            this.release(conn);
          }
        },
        all: async (...params) => {
          const conn = await this.acquire();
          try {
            return conn.db.prepare(sql).all(...params);
          } finally {
            this.release(conn);
          }
        },
        iterate: async function* (...params) {
          const conn = await this.acquire();
          try {
            const stmt = conn.db.prepare(sql);
            for (const row of stmt.iterate(...params)) {
              yield row;
            }
          } finally {
            this.release(conn);
          }
        }.bind(this)
      };

      this.statements.set(sql, wrappedStatement);
      return wrappedStatement;
    } finally {
      this.release(connection);
    }
  }

  async _createConnection() {
    try {
      const db = new Database(this.options.filename, {
        readonly: this.options.readonly,
        fileMustExist: this.options.fileMustExist,
        verbose: this.options.verbose
      });

      // Configure database
      if (this.options.wal) {
        db.pragma('journal_mode = WAL');
      }
      db.pragma(`synchronous = ${this.options.synchronous}`);
      db.pragma(`cache_size = ${this.options.cacheSize}`);
      db.pragma(`mmap_size = ${this.options.mmap}`);
      
      // Enable query optimizer
      db.pragma('optimize');

      const connection = {
        id: Date.now() + Math.random(),
        db,
        created: Date.now(),
        lastUsed: Date.now(),
        inUse: false,
        destroyed: false
      };

      this.connections.push(connection);
      this.available.push(connection);
      this.metrics.created++;

      logger.debug('Created new database connection', { id: connection.id });
      return connection;
    } catch (error) {
      this.metrics.errors++;
      logger.error('Error creating connection:', error);
      throw error;
    }
  }

  _destroyConnection(connection) {
    if (connection.destroyed) {
      return;
    }

    try {
      connection.db.close();
      connection.destroyed = true;
      
      // Remove from arrays
      this.connections = this.connections.filter(c => c !== connection);
      this.available = this.available.filter(c => c !== connection);
      
      this.metrics.destroyed++;
      logger.debug('Destroyed database connection', { id: connection.id });
    } catch (error) {
      logger.error('Error destroying connection:', error);
    }
  }

  _performMaintenance() {
    try {
      const now = Date.now();
      const idleTimeout = this.options.idleTimeout;

      // Remove idle connections above minimum
      const idleConnections = this.available.filter(
        conn => now - conn.lastUsed > idleTimeout
      );

      for (const connection of idleConnections) {
        if (this.connections.length > this.options.minConnections) {
          this._destroyConnection(connection);
        } else if (this.options.refreshIdle) {
          // Refresh idle connection
          this._destroyConnection(connection);
          this._createConnection().catch(err => {
            logger.error('Error refreshing connection:', err);
          });
        }
      }

      // Process pending timeouts
      const pendingTimeouts = [];
      for (const pending of this.pending) {
        pending.tryAcquire();
      }

      // Log metrics periodically
      if (Math.random() < 0.1) { // 10% chance
        logger.debug('Connection pool metrics', this.getMetrics());
      }
    } catch (error) {
      logger.error('Error in maintenance:', error);
    }
  }

  getMetrics() {
    return {
      ...this.metrics,
      total: this.connections.length,
      available: this.available.length,
      inUse: this.connections.filter(c => c.inUse).length,
      pending: this.pending.length
    };
  }

  async close() {
    if (this._closing) {
      return;
    }

    this._closing = true;
    logger.info('Closing connection pool');

    // Clear maintenance interval
    if (this._maintenanceInterval) {
      clearInterval(this._maintenanceInterval);
    }

    // Reject pending requests
    for (const pending of this.pending) {
      pending.reject(new Error('Connection pool is closing'));
    }
    this.pending = [];

    // Close all connections
    const promises = this.connections.map(conn => {
      return new Promise(resolve => {
        this._destroyConnection(conn);
        resolve();
      });
    });

    await Promise.all(promises);

    // Clear statement cache
    this.statements.clear();

    logger.info('Connection pool closed');
  }

  // Utility methods for migrations and maintenance

  async vacuum() {
    const connection = await this.acquire();
    try {
      connection.db.pragma('vacuum');
      logger.info('Database vacuumed');
    } finally {
      this.release(connection);
    }
  }

  async analyze() {
    const connection = await this.acquire();
    try {
      connection.db.pragma('analyze');
      logger.info('Database analyzed');
    } finally {
      this.release(connection);
    }
  }

  async checkpoint() {
    if (!this.options.wal) {
      return;
    }

    const connection = await this.acquire();
    try {
      connection.db.pragma('wal_checkpoint(TRUNCATE)');
      logger.info('WAL checkpoint completed');
    } finally {
      this.release(connection);
    }
  }

  async getTableInfo(tableName) {
    const connection = await this.acquire();
    try {
      return connection.db.pragma(`table_info(${tableName})`);
    } finally {
      this.release(connection);
    }
  }

  async getDatabaseInfo() {
    const connection = await this.acquire();
    try {
      return {
        pageCount: connection.db.pragma('page_count')[0].page_count,
        pageSize: connection.db.pragma('page_size')[0].page_size,
        cacheSize: connection.db.pragma('cache_size')[0].cache_size,
        journalMode: connection.db.pragma('journal_mode')[0].journal_mode,
        synchronous: connection.db.pragma('synchronous')[0].synchronous,
        walAutocheckpoint: connection.db.pragma('wal_autocheckpoint')[0].wal_autocheckpoint
      };
    } finally {
      this.release(connection);
    }
  }
}

module.exports = ConnectionPool;