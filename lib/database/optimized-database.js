/**
 * Optimized Database Manager
 * High-performance database interface with connection pooling
 */

const SQLiteConnectionPool = require('./sqlite-connection-pool');
const { createLogger } = require('../core/logger');
const crypto = require('crypto');

const logger = createLogger('optimized-db');

class OptimizedDatabase {
  constructor(options = {}) {
    this.options = {
      poolSize: options.poolSize || 10,
      statementCacheSize: options.statementCacheSize || 100,
      queryTimeout: options.queryTimeout || 30000,
      slowQueryThreshold: options.slowQueryThreshold || 1000,
      enableQueryLogging: options.enableQueryLogging || false,
      ...options
    };

    this.pool = new SQLiteConnectionPool({
      filename: options.filename,
      minConnections: Math.floor(this.options.poolSize / 2),
      maxConnections: this.options.poolSize,
      ...options
    });

    this.queryStats = new Map();
    this.preparedStatements = new Map();
    this._initialized = false;
  }

  async initialize() {
    if (this._initialized) {
      return;
    }

    logger.info('Initializing optimized database');
    
    await this.pool.initialize();
    await this._createTables();
    await this._createIndexes();
    await this._optimizeDatabase();

    this._initialized = true;
    logger.info('Optimized database initialized');
  }
  
  // Database helper methods
  async _run(sql, params = []) {
    const db = await this.pool.acquire();
    try {
      return await db.runAsync(sql, params);
    } finally {
      await this.pool.release(db);
    }
  }
  
  async _get(sql, params = []) {
    const db = await this.pool.acquire();
    try {
      return await db.getAsync(sql, params);
    } finally {
      await this.pool.release(db);
    }
  }
  
  async _all(sql, params = []) {
    const db = await this.pool.acquire();
    try {
      return await db.allAsync(sql, params);
    } finally {
      await this.pool.release(db);
    }
  }
  
  async _exec(sql) {
    const db = await this.pool.acquire();
    try {
      return await db.execAsync(sql);
    } finally {
      await this.pool.release(db);
    }
  }

  async _createTables() {
    const tables = [
      // Miners table with optimized structure
      `CREATE TABLE IF NOT EXISTS miners (
        id TEXT PRIMARY KEY,
        address TEXT UNIQUE NOT NULL,
        worker_name TEXT,
        hashrate REAL DEFAULT 0,
        shares_valid INTEGER DEFAULT 0,
        shares_invalid INTEGER DEFAULT 0,
        last_share_time INTEGER,
        difficulty REAL DEFAULT 0,
        connected_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        metadata TEXT
      )`,

      // Shares table with partitioning-ready structure
      `CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        miner_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        hash TEXT NOT NULL,
        difficulty REAL NOT NULL,
        is_valid INTEGER DEFAULT 1,
        is_block INTEGER DEFAULT 0,
        timestamp INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        FOREIGN KEY (miner_id) REFERENCES miners(id) ON DELETE CASCADE
      )`,

      // Blocks table
      `CREATE TABLE IF NOT EXISTS blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        height INTEGER UNIQUE NOT NULL,
        hash TEXT UNIQUE NOT NULL,
        previous_hash TEXT,
        miner_id TEXT NOT NULL,
        reward REAL NOT NULL,
        confirmations INTEGER DEFAULT 0,
        found_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        confirmed_at INTEGER,
        metadata TEXT,
        FOREIGN KEY (miner_id) REFERENCES miners(id)
      )`,

      // Payments table
      `CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        miner_id TEXT NOT NULL,
        amount REAL NOT NULL,
        fee REAL DEFAULT 0,
        transaction_id TEXT,
        status TEXT DEFAULT 'pending',
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        processed_at INTEGER,
        metadata TEXT,
        FOREIGN KEY (miner_id) REFERENCES miners(id) ON DELETE CASCADE
      )`,

      // Balance tracking
      `CREATE TABLE IF NOT EXISTS balances (
        miner_id TEXT PRIMARY KEY,
        confirmed REAL DEFAULT 0,
        pending REAL DEFAULT 0,
        paid REAL DEFAULT 0,
        last_payment INTEGER,
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        FOREIGN KEY (miner_id) REFERENCES miners(id) ON DELETE CASCADE
      )`,

      // Jobs table for stratum
      `CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        block_template TEXT NOT NULL,
        difficulty REAL NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        expires_at INTEGER
      )`,

      // Performance metrics table
      `CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_type TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        value REAL NOT NULL,
        tags TEXT,
        timestamp INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )`
    ];

    for (const sql of tables) {
      await this._run(sql);
    }
  }

  async _createIndexes() {
    const indexes = [
      // Miners indexes
      'CREATE INDEX IF NOT EXISTS idx_miners_updated_at ON miners(updated_at)',
      'CREATE INDEX IF NOT EXISTS idx_miners_hashrate ON miners(hashrate DESC)',
      
      // Shares indexes
      'CREATE INDEX IF NOT EXISTS idx_shares_miner_id ON shares(miner_id)',
      'CREATE INDEX IF NOT EXISTS idx_shares_timestamp ON shares(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_shares_is_block ON shares(is_block) WHERE is_block = 1',
      
      // Blocks indexes
      'CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height)',
      'CREATE INDEX IF NOT EXISTS idx_blocks_miner_id ON blocks(miner_id)',
      'CREATE INDEX IF NOT EXISTS idx_blocks_found_at ON blocks(found_at)',
      
      // Payments indexes
      'CREATE INDEX IF NOT EXISTS idx_payments_miner_id ON payments(miner_id)',
      'CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)',
      'CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at)',
      
      // Metrics indexes
      'CREATE INDEX IF NOT EXISTS idx_metrics_type_name_timestamp ON metrics(metric_type, metric_name, timestamp)'
    ];

    for (const sql of indexes) {
      await this._run(sql);
    }
  }

  async _optimizeDatabase() {
    // Run optimization commands
    await this._exec('ANALYZE');
    
    // Set optimal pragmas are already set in connection pool
    logger.info('Database optimization completed');
  }

  // Miner operations

  async getMiner(address) {
    const sql = 'SELECT * FROM miners WHERE address = ?';
    return this._timedQuery(() => this._get(sql, [address]), 'getMiner');
  }

  async createMiner(address, workerName = null) {
    const id = this._generateId('miner');
    const sql = `
      INSERT INTO miners (id, address, worker_name) 
      VALUES (?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        worker_name = excluded.worker_name,
        updated_at = strftime('%s', 'now') * 1000
    `;
    
    await this._timedQuery(
      () => this._run(sql, [id, address, workerName]),
      'createMiner'
    );
    
    // Initialize balance
    await this._run(
      'INSERT OR IGNORE INTO balances (miner_id) VALUES (?)',
      [id]
    );
    
    return id;
  }

  async updateMinerStats(minerId, stats) {
    const sql = `
      UPDATE miners SET
        hashrate = ?,
        shares_valid = shares_valid + ?,
        shares_invalid = shares_invalid + ?,
        last_share_time = ?,
        difficulty = ?,
        updated_at = strftime('%s', 'now') * 1000
      WHERE id = ?
    `;
    
    return this._timedQuery(
      () => this._run(sql, [
        stats.hashrate || 0,
        stats.validShares || 0,
        stats.invalidShares || 0,
        stats.lastShareTime || Date.now(),
        stats.difficulty || 0,
        minerId
      ]),
      'updateMinerStats'
    );
  }

  async getTopMiners(limit = 10) {
    const sql = `
      SELECT m.*, b.confirmed, b.pending
      FROM miners m
      LEFT JOIN balances b ON m.id = b.miner_id
      ORDER BY m.hashrate DESC
      LIMIT ?
    `;
    
    return this._timedQuery(
      () => this._all(sql, [limit]),
      'getTopMiners'
    );
  }

  // Share operations

  async recordShare(minerId, jobId, nonce, hash, difficulty, isValid = true) {
    const sql = `
      INSERT INTO shares (miner_id, job_id, nonce, hash, difficulty, is_valid)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    
    return this._timedQuery(
      () => this._run(sql, [minerId, jobId, nonce, hash, difficulty, isValid ? 1 : 0]),
      'recordShare'
    );
  }

  async getRecentShares(minerId, hours = 24) {
    const since = Date.now() - (hours * 3600 * 1000);
    const sql = `
      SELECT * FROM shares
      WHERE miner_id = ? AND timestamp > ?
      ORDER BY timestamp DESC
    `;
    
    return this._timedQuery(
      () => this._all(sql, [minerId, since]),
      'getRecentShares'
    );
  }

  async getSharesWindow(windowSize = 3600000) { // 1 hour default
    const since = Date.now() - windowSize;
    const sql = `
      SELECT 
        s.*,
        m.address as miner_address
      FROM shares s
      JOIN miners m ON s.miner_id = m.id
      WHERE s.timestamp > ? AND s.is_valid = 1
      ORDER BY s.timestamp DESC
    `;
    
    return this._timedQuery(
      () => this._all(sql, [since]),
      'getSharesWindow'
    );
  }

  // Block operations

  async recordBlock(height, hash, previousHash, minerId, reward) {
    const sql = `
      INSERT INTO blocks (height, hash, previous_hash, miner_id, reward)
      VALUES (?, ?, ?, ?, ?)
    `;
    
    const result = await this._timedQuery(
      () => this._run(sql, [height, hash, previousHash, minerId, reward]),
      'recordBlock'
    );
    
    // Update share if it was a block
    await this._run(
      'UPDATE shares SET is_block = 1 WHERE hash = ?',
      [hash]
    );
    
    return result;
  }

  async updateBlockConfirmations(blockId, confirmations) {
    const sql = `
      UPDATE blocks SET
        confirmations = ?,
        confirmed_at = CASE 
          WHEN confirmations >= 100 AND confirmed_at IS NULL 
          THEN strftime('%s', 'now') * 1000 
          ELSE confirmed_at 
        END
      WHERE id = ?
    `;
    
    return this._timedQuery(
      () => this._run(sql, [confirmations, blockId]),
      'updateBlockConfirmations'
    );
  }

  // Payment operations

  async createPayment(minerId, amount, fee = 0) {
    const sql = `
      INSERT INTO payments (miner_id, amount, fee)
      VALUES (?, ?, ?)
    `;
    
    return this._timedQuery(
      () => this._run(sql, [minerId, amount, fee]),
      'createPayment'
    );
  }

  async processPayment(paymentId, transactionId) {
    const sql = `
      UPDATE payments SET
        status = 'completed',
        transaction_id = ?,
        processed_at = strftime('%s', 'now') * 1000
      WHERE id = ?
    `;
    
    return this._timedQuery(
      () => this._run(sql, [transactionId, paymentId]),
      'processPayment'
    );
  }

  async getPendingPayments(limit = 100) {
    const sql = `
      SELECT p.*, m.address
      FROM payments p
      JOIN miners m ON p.miner_id = m.id
      WHERE p.status = 'pending'
      ORDER BY p.created_at ASC
      LIMIT ?
    `;
    
    return this._timedQuery(
      () => this._all(sql, [limit]),
      'getPendingPayments'
    );
  }

  // Balance operations

  async updateBalance(minerId, confirmed = 0, pending = 0) {
    const sql = `
      INSERT INTO balances (miner_id, confirmed, pending)
      VALUES (?, ?, ?)
      ON CONFLICT(miner_id) DO UPDATE SET
        confirmed = confirmed + excluded.confirmed,
        pending = pending + excluded.pending,
        updated_at = strftime('%s', 'now') * 1000
    `;
    
    return this._timedQuery(
      () => this._run(sql, [minerId, confirmed, pending]),
      'updateBalance'
    );
  }

  async getBalance(minerId) {
    const sql = 'SELECT * FROM balances WHERE miner_id = ?';
    return this._timedQuery(
      () => this._get(sql, [minerId]),
      'getBalance'
    );
  }

  // Metrics operations

  async recordMetric(type, name, value, tags = null) {
    const sql = `
      INSERT INTO metrics (metric_type, metric_name, value, tags)
      VALUES (?, ?, ?, ?)
    `;
    
    const tagsJson = tags ? JSON.stringify(tags) : null;
    return this._run(sql, [type, name, value, tagsJson]);
  }

  async getMetrics(type, name, since, until = Date.now()) {
    const sql = `
      SELECT * FROM metrics
      WHERE metric_type = ? AND metric_name = ?
        AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `;
    
    return this._timedQuery(
      () => this._all(sql, [type, name, since, until]),
      'getMetrics'
    );
  }

  // Transaction support

  async transaction(callback) {
    const db = await this.pool.acquire();
    try {
      return await db.transaction(async () => {
        // Create wrapper that uses the same connection
        const txWrapper = {
          run: (sql, params) => db.runAsync(sql, params),
          get: (sql, params) => db.getAsync(sql, params),
          all: (sql, params) => db.allAsync(sql, params)
        };
        
        // Temporarily replace methods to use transaction connection
        const originalRun = this._run;
        const originalGet = this._get;
        const originalAll = this._all;
        
        this._run = txWrapper.run;
        this._get = txWrapper.get;
        this._all = txWrapper.all;
        
        try {
          return await callback();
        } finally {
          // Restore original methods
          this._run = originalRun;
          this._get = originalGet;
          this._all = originalAll;
        }
      });
    } finally {
      await this.pool.release(db);
    }
  }

  // Utility methods

  async vacuum() {
    logger.info('Starting database vacuum');
    await this.pool.performVacuum();
  }

  async checkpoint() {
    await this.pool.performCheckpoint();
  }

  async getStats() {
    const [miners, shares, blocks, payments] = await Promise.all([
      this._get('SELECT COUNT(*) as count FROM miners'),
      this._get('SELECT COUNT(*) as count FROM shares WHERE timestamp > ?', [Date.now() - 86400000]),
      this._get('SELECT COUNT(*) as count FROM blocks'),
      this._get('SELECT COUNT(*) as count, SUM(amount) as total FROM payments WHERE status = "completed"')
    ]);

    return {
      totalMiners: miners.count,
      sharesLast24h: shares.count,
      totalBlocks: blocks.count,
      totalPayments: payments.count,
      totalPaid: payments.total || 0,
      poolMetrics: await this.pool.getStats(),
      queryStats: this.getQueryStats()
    };
  }

  async cleanup(daysToKeep = 7) {
    const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    
    const results = await this.transaction(async () => {
      const shares = await this._run(
        'DELETE FROM shares WHERE timestamp < ?',
        [cutoff]
      );
      
      const metrics = await this._run(
        'DELETE FROM metrics WHERE timestamp < ?',
        [cutoff]
      );
      
      return { shares: shares.changes, metrics: metrics.changes };
    });
    
    logger.info('Database cleanup completed', results);
    return results;
  }

  // Private methods

  _generateId(prefix) {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(8).toString('hex');
    return `${prefix}_${timestamp}_${random}`;
  }

  async _timedQuery(queryFn, queryName) {
    const start = Date.now();
    
    try {
      const result = await queryFn();
      const duration = Date.now() - start;
      
      // Update stats
      if (!this.queryStats.has(queryName)) {
        this.queryStats.set(queryName, {
          count: 0,
          totalTime: 0,
          avgTime: 0,
          minTime: Infinity,
          maxTime: 0
        });
      }
      
      const stats = this.queryStats.get(queryName);
      stats.count++;
      stats.totalTime += duration;
      stats.avgTime = stats.totalTime / stats.count;
      stats.minTime = Math.min(stats.minTime, duration);
      stats.maxTime = Math.max(stats.maxTime, duration);
      
      // Log slow queries
      if (duration > this.options.slowQueryThreshold) {
        logger.warn('Slow query detected', {
          query: queryName,
          duration,
          threshold: this.options.slowQueryThreshold
        });
      }
      
      if (this.options.enableQueryLogging) {
        logger.debug('Query executed', { query: queryName, duration });
      }
      
      return result;
    } catch (error) {
      logger.error('Query error', { query: queryName, error: error.message });
      throw error;
    }
  }

  getQueryStats() {
    const stats = {};
    for (const [name, data] of this.queryStats) {
      stats[name] = { ...data };
    }
    return stats;
  }

  async close() {
    await this.pool.close();
    logger.info('Optimized database closed');
  }
}

module.exports = OptimizedDatabase;