import Database from 'better-sqlite3';
import { Logger } from './logger.js';
import { DB_SCHEMAS, TIME_CONSTANTS } from './constants.js';
import DatabaseBatcher from './database-batcher.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * High-Performance Database System
 * 高性能データベースシステム
 * 
 * Features:
 * - SQLite with WAL mode for concurrent access
 * - Prepared statements for performance
 * - Automatic backup and recovery
 * - Connection pooling simulation
 * - Transaction management
 * - Database optimization and maintenance
 * - Memory-mapped I/O for large datasets
 */
export class OtedamaDB {
  constructor(options = {}) {
    this.logger = new Logger('Database');
    this.options = {
      filename: options.filename || 'data/otedama.db',
      memory: options.memory || false,
      readonly: options.readonly || false,
      timeout: options.timeout || 5000,
      verbose: options.verbose || false,
      backup: options.backup !== false,
      backupInterval: options.backupInterval || TIME_CONSTANTS.hour,
      maxBackups: options.maxBackups || 24,
      pragmas: {
        journal_mode: 'WAL',
        synchronous: 'NORMAL',
        cache_size: 10000,
        temp_store: 'MEMORY',
        mmap_size: 268435456, // 256MB
        ...options.pragmas
      }
    };

    this.db = null;
    this.statements = new Map();
    this.transactions = new Map();
    this.backupTimer = null;
    this.maintenanceTimer = null;
    this.batcher = null;
    
    // Statistics
    this.stats = {
      queries: 0,
      transactions: 0,
      errors: 0,
      lastBackup: 0,
      lastMaintenance: 0,
      dbSize: 0,
      connections: 0
    };

    this.initialize();
  }

  /**
   * Initialize database
   */
  async initialize() {
    try {
      // Create data directory if needed
      const dataDir = path.dirname(this.options.filename);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Open database connection
      this.db = new Database(this.options.filename, {
        memory: this.options.memory,
        readonly: this.options.readonly,
        timeout: this.options.timeout,
        verbose: this.options.verbose ? this.logger.debug.bind(this.logger) : null
      });

      // Set pragmas for performance
      this.setPragmas();

      // Create tables
      this.createTables();

      // Prepare common statements
      this.prepareStatements();

      // Initialize batcher for performance
      this.batcher = new DatabaseBatcher(this.db, {
        maxBatchSize: 1000,
        batchInterval: 10,
        maxWaitTime: 100,
        adaptiveSizing: true,
        mergeQueries: true
      });

      // Start automated tasks
      this.startAutomatedTasks();

      // Update initial stats
      this.updateStats();

      this.logger.info('Database initialized successfully');

    } catch (error) {
      this.logger.error('Failed to initialize database:', error);
      throw error;
    }
  }

  /**
   * Set database pragmas for optimization
   */
  setPragmas() {
    try {
      for (const [pragma, value] of Object.entries(this.options.pragmas)) {
        this.db.pragma(`${pragma} = ${value}`);
        this.logger.debug(`Set pragma ${pragma} = ${value}`);
      }
    } catch (error) {
      this.logger.error('Failed to set pragmas:', error);
      throw error;
    }
  }

  /**
   * Create database tables
   */
  createTables() {
    try {
      const transaction = this.db.transaction(() => {
        // Core tables
        this.db.exec(DB_SCHEMAS.shares);
        this.db.exec(DB_SCHEMAS.miners);
        this.db.exec(DB_SCHEMAS.trades);
        this.db.exec(DB_SCHEMAS.proposals);

        // Mining-specific tables
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS blocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hash TEXT UNIQUE NOT NULL,
            height INTEGER NOT NULL,
            algorithm TEXT NOT NULL,
            difficulty REAL NOT NULL,
            reward REAL NOT NULL,
            miner_id TEXT,
            timestamp INTEGER NOT NULL,
            confirmed INTEGER DEFAULT 0
          )
        `);

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS pool_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            total_shares INTEGER DEFAULT 0,
            valid_shares INTEGER DEFAULT 0,
            rejected_shares INTEGER DEFAULT 0,
            stale_shares INTEGER DEFAULT 0,
            total_hashrate REAL DEFAULT 0,
            active_miners INTEGER DEFAULT 0,
            blocks_found INTEGER DEFAULT 0,
            timestamp INTEGER NOT NULL
          )
        `);

        // DEX tables
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS dex_pools (
            id TEXT PRIMARY KEY,
            token0 TEXT NOT NULL,
            token1 TEXT NOT NULL,
            reserve0 TEXT NOT NULL,
            reserve1 TEXT NOT NULL,
            total_supply TEXT NOT NULL,
            fee REAL NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `);

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS dex_positions (
            id TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            pool_id TEXT NOT NULL,
            liquidity TEXT NOT NULL,
            token0_owed TEXT DEFAULT '0',
            token1_owed TEXT DEFAULT '0',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (pool_id) REFERENCES dex_pools (id)
          )
        `);

        // Lending tables
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS lending_markets (
            asset TEXT PRIMARY KEY,
            total_supply TEXT DEFAULT '0',
            total_borrows TEXT DEFAULT '0',
            total_reserves TEXT DEFAULT '0',
            supply_rate TEXT DEFAULT '0',
            borrow_rate TEXT DEFAULT '0',
            utilization_rate TEXT DEFAULT '0',
            collateral_factor TEXT NOT NULL,
            liquidation_threshold TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `);

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS lending_positions (
            id TEXT PRIMARY KEY,
            user TEXT NOT NULL,
            asset TEXT NOT NULL,
            supplied TEXT DEFAULT '0',
            borrowed TEXT DEFAULT '0',
            collateral_enabled INTEGER DEFAULT 1,
            health_factor TEXT DEFAULT '0',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `);

        // Bridge tables
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS bridge_transfers (
            id TEXT PRIMARY KEY,
            from_chain TEXT NOT NULL,
            to_chain TEXT NOT NULL,
            asset TEXT NOT NULL,
            amount TEXT NOT NULL,
            recipient TEXT NOT NULL,
            sender TEXT NOT NULL,
            status TEXT NOT NULL,
            fee TEXT DEFAULT '0',
            tx_hash_source TEXT,
            tx_hash_destination TEXT,
            created_at INTEGER NOT NULL,
            completed_at INTEGER
          )
        `);

        // Governance tables - already included in DB_SCHEMAS.proposals

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS governance_votes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            proposal_id TEXT NOT NULL,
            voter TEXT NOT NULL,
            support INTEGER NOT NULL,
            voting_power TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            UNIQUE(proposal_id, voter)
          )
        `);

        // Fee collection tables
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS fee_collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            asset TEXT NOT NULL,
            amount TEXT NOT NULL,
            btc_amount TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            tx_hash TEXT,
            timestamp INTEGER NOT NULL
          )
        `);

        // Payment tables
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            miner_id TEXT NOT NULL,
            wallet_address TEXT NOT NULL,
            asset TEXT NOT NULL,
            amount TEXT NOT NULL,
            fee TEXT DEFAULT '0',
            net_amount TEXT NOT NULL,
            tx_hash TEXT,
            status TEXT DEFAULT 'pending',
            created_at INTEGER NOT NULL,
            processed_at INTEGER
          )
        `);

        // Create indexes for performance
        this.createIndexes();
      });

      transaction();
      this.logger.info('Database tables created successfully');

    } catch (error) {
      this.logger.error('Failed to create tables:', error);
      throw error;
    }
  }

  /**
   * Create database indexes
   */
  createIndexes() {
    const indexes = [
      // Shares indexes
      'CREATE INDEX IF NOT EXISTS idx_shares_worker_id ON shares(worker_id)',
      'CREATE INDEX IF NOT EXISTS idx_shares_timestamp ON shares(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_shares_valid ON shares(valid)',

      // Miners indexes
      'CREATE INDEX IF NOT EXISTS idx_miners_wallet ON miners(wallet_address)',
      'CREATE INDEX IF NOT EXISTS idx_miners_currency ON miners(currency)',
      'CREATE INDEX IF NOT EXISTS idx_miners_last_seen ON miners(last_seen)',

      // Trades indexes
      'CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades(pair)',
      'CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_trades_trader ON trades(trader)',

      // Blocks indexes
      'CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height)',
      'CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_blocks_miner ON blocks(miner_id)',

      // DEX indexes
      'CREATE INDEX IF NOT EXISTS idx_dex_pools_tokens ON dex_pools(token0, token1)',
      'CREATE INDEX IF NOT EXISTS idx_dex_positions_owner ON dex_positions(owner)',
      'CREATE INDEX IF NOT EXISTS idx_dex_positions_pool ON dex_positions(pool_id)',

      // Lending indexes
      'CREATE INDEX IF NOT EXISTS idx_lending_positions_user ON lending_positions(user)',
      'CREATE INDEX IF NOT EXISTS idx_lending_positions_asset ON lending_positions(asset)',

      // Bridge indexes
      'CREATE INDEX IF NOT EXISTS idx_bridge_transfers_status ON bridge_transfers(status)',
      'CREATE INDEX IF NOT EXISTS idx_bridge_transfers_chains ON bridge_transfers(from_chain, to_chain)',

      // Governance indexes
      'CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status)',
      'CREATE INDEX IF NOT EXISTS idx_proposals_proposer ON proposals(proposer)',
      'CREATE INDEX IF NOT EXISTS idx_votes_proposal ON governance_votes(proposal_id)',
      'CREATE INDEX IF NOT EXISTS idx_votes_voter ON governance_votes(voter)',

      // Fee and payment indexes
      'CREATE INDEX IF NOT EXISTS idx_fee_collections_asset ON fee_collections(asset)',
      'CREATE INDEX IF NOT EXISTS idx_fee_collections_status ON fee_collections(status)',
      'CREATE INDEX IF NOT EXISTS idx_payments_miner ON payments(miner_id)',
      'CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)'
    ];

    for (const indexSQL of indexes) {
      try {
        this.db.exec(indexSQL);
      } catch (error) {
        this.logger.warn(`Failed to create index: ${indexSQL}`, error);
      }
    }
  }

  /**
   * Prepare commonly used statements
   */
  prepareStatements() {
    try {
      // Shares statements
      this.statements.set('addShare', this.db.prepare(`
        INSERT INTO shares (worker_id, difficulty, valid, timestamp, algorithm)
        VALUES (?, ?, ?, ?, ?)
      `));

      this.statements.set('getSharesByWorker', this.db.prepare(`
        SELECT * FROM shares 
        WHERE worker_id = ? 
        ORDER BY timestamp DESC 
        LIMIT ?
      `));

      // Miners statements
      this.statements.set('upsertMiner', this.db.prepare(`
        INSERT OR REPLACE INTO miners 
        (id, wallet_address, currency, first_seen, last_seen, total_shares, valid_shares, total_paid)
        VALUES (?, ?, ?, COALESCE((SELECT first_seen FROM miners WHERE id = ?), ?), ?, 
                COALESCE((SELECT total_shares FROM miners WHERE id = ?), 0) + 1,
                COALESCE((SELECT valid_shares FROM miners WHERE id = ?), 0) + ?,
                COALESCE((SELECT total_paid FROM miners WHERE id = ?), 0))
      `));

      this.statements.set('getMiner', this.db.prepare(`
        SELECT * FROM miners WHERE id = ?
      `));

      // Pool stats statements
      this.statements.set('updatePoolStats', this.db.prepare(`
        INSERT OR REPLACE INTO pool_stats 
        (id, total_shares, valid_shares, rejected_shares, stale_shares, 
         total_hashrate, active_miners, blocks_found, timestamp)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      `));

      this.statements.set('getPoolStats', this.db.prepare(`
        SELECT * FROM pool_stats WHERE id = 1
      `));

      // DEX statements
      this.statements.set('upsertDEXPool', this.db.prepare(`
        INSERT OR REPLACE INTO dex_pools 
        (id, token0, token1, reserve0, reserve1, total_supply, fee, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 
                COALESCE((SELECT created_at FROM dex_pools WHERE id = ?), ?), ?)
      `));

      this.statements.set('getDEXPool', this.db.prepare(`
        SELECT * FROM dex_pools WHERE id = ?
      `));

      // Trades statements
      this.statements.set('addTrade', this.db.prepare(`
        INSERT INTO trades (pair, amount_in, amount_out, fee, trader, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `));

      // Lending statements
      this.statements.set('upsertLendingMarket', this.db.prepare(`
        INSERT OR REPLACE INTO lending_markets 
        (asset, total_supply, total_borrows, total_reserves, supply_rate, borrow_rate,
         utilization_rate, collateral_factor, liquidation_threshold, 
         created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 
                COALESCE((SELECT created_at FROM lending_markets WHERE asset = ?), ?), ?)
      `));

      // Bridge statements
      this.statements.set('addBridgeTransfer', this.db.prepare(`
        INSERT INTO bridge_transfers 
        (id, from_chain, to_chain, asset, amount, recipient, sender, status, fee, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `));

      this.statements.set('updateBridgeTransfer', this.db.prepare(`
        UPDATE bridge_transfers 
        SET status = ?, tx_hash_destination = ?, completed_at = ?
        WHERE id = ?
      `));

      // Governance statements
      this.statements.set('addProposal', this.db.prepare(`
        INSERT INTO proposals 
        (id, proposer, title, description, status, created_at, voting_ends_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `));

      this.statements.set('addVote', this.db.prepare(`
        INSERT OR REPLACE INTO governance_votes 
        (proposal_id, voter, support, voting_power, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `));

      // Payment statements
      this.statements.set('addPayment', this.db.prepare(`
        INSERT INTO payments 
        (miner_id, wallet_address, asset, amount, fee, net_amount, tx_hash, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `));

      this.logger.info('Prepared statements created successfully');

    } catch (error) {
      this.logger.error('Failed to prepare statements:', error);
      throw error;
    }
  }

  /**
   * Start automated database tasks
   */
  startAutomatedTasks() {
    // Start backup timer
    if (this.options.backup) {
      this.backupTimer = setInterval(() => {
        this.createBackup();
      }, this.options.backupInterval);
    }

    // Start maintenance timer
    this.maintenanceTimer = setInterval(() => {
      this.performMaintenance();
    }, TIME_CONSTANTS.day); // Daily maintenance

    this.logger.info('Automated database tasks started');
  }

  /**
   * Add mining share (with batching)
   */
  async addShare(workerId, difficulty, valid, algorithm = 'kawpow') {
    try {
      // Use batcher for better performance
      if (this.batcher) {
        return await this.batcher.batch('shares',
          'INSERT INTO shares (worker_id, difficulty, valid, timestamp, algorithm) VALUES (?, ?, ?, ?, ?)',
          [workerId, difficulty, valid ? 1 : 0, Date.now(), algorithm]
        );
      }
      
      // Fallback to direct execution
      const stmt = this.statements.get('addShare');
      const result = stmt.run(workerId, difficulty, valid ? 1 : 0, Date.now(), algorithm);
      this.stats.queries++;
      return result;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Failed to add share:', error);
      throw error;
    }
  }

  /**
   * Update or insert miner
   */
  upsertMiner(minerId, walletAddress, currency, validShare = 0) {
    try {
      const stmt = this.statements.get('upsertMiner');
      const now = Date.now();
      const result = stmt.run(
        minerId, walletAddress, currency, 
        minerId, now, // first_seen lookup and value
        now, // last_seen
        minerId, // total_shares lookup
        minerId, validShare, // valid_shares lookup and increment
        minerId // total_paid lookup
      );
      this.stats.queries++;
      return result;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Failed to upsert miner:', error);
      throw error;
    }
  }

  /**
   * Get pool statistics
   */
  getPoolStats() {
    try {
      const stmt = this.statements.get('getPoolStats');
      const result = stmt.get();
      this.stats.queries++;
      
      return result || {
        total: 0,
        valid: 0,
        rejected: 0,
        stale: 0,
        hashrate: 0,
        miners: 0,
        blocks: 0
      };
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Failed to get pool stats:', error);
      return {
        total: 0,
        valid: 0,
        rejected: 0,
        stale: 0,
        hashrate: 0,
        miners: 0,
        blocks: 0
      };
    }
  }

  /**
   * Update pool statistics
   */
  updatePoolStats(stats) {
    try {
      const stmt = this.statements.get('updatePoolStats');
      const result = stmt.run(
        stats.total || 0,
        stats.valid || 0,
        stats.rejected || 0,
        stats.stale || 0,
        stats.hashrate || 0,
        stats.miners || 0,
        stats.blocks || 0,
        Date.now()
      );
      this.stats.queries++;
      return result;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Failed to update pool stats:', error);
      throw error;
    }
  }

  /**
   * Add trade record (with batching)
   */
  async addTrade(pair, amountIn, amountOut, fee, trader = null) {
    try {
      // Use batcher for better performance
      if (this.batcher) {
        return await this.batcher.batch('trades',
          'INSERT INTO trades (pair, amount_in, amount_out, fee, trader, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
          [pair, amountIn, amountOut, fee, trader, Date.now()]
        );
      }
      
      // Fallback to direct execution
      const stmt = this.statements.get('addTrade');
      const result = stmt.run(pair, amountIn, amountOut, fee, trader, Date.now());
      this.stats.queries++;
      return result;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Failed to add trade:', error);
      throw error;
    }
  }

  /**
   * Execute transaction
   */
  transaction(fn) {
    try {
      const transactionId = Date.now().toString();
      this.transactions.set(transactionId, Date.now());
      
      const transaction = this.db.transaction(fn);
      const result = transaction();
      
      this.transactions.delete(transactionId);
      this.stats.transactions++;
      
      return result;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Transaction failed:', error);
      throw error;
    }
  }

  /**
   * Execute raw SQL query
   */
  exec(sql, params = []) {
    try {
      let result;
      
      if (params.length > 0) {
        const stmt = this.db.prepare(sql);
        result = stmt.all(...params);
      } else {
        result = this.db.exec(sql);
      }
      
      this.stats.queries++;
      return result;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Query execution failed:', error);
      throw error;
    }
  }

  /**
   * Prepare and cache statement
   */
  prepare(sql) {
    try {
      const hash = require('crypto').createHash('md5').update(sql).digest('hex');
      
      if (!this.statements.has(hash)) {
        this.statements.set(hash, this.db.prepare(sql));
      }
      
      return this.statements.get(hash);
    } catch (error) {
      this.logger.error('Failed to prepare statement:', error);
      throw error;
    }
  }

  /**
   * Create database backup
   */
  async createBackup() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = path.join(path.dirname(this.options.filename), 'backups');
      
      // Create backup directory
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      
      const backupFile = path.join(backupDir, `otedama-${timestamp}.db`);
      
      // Use SQLite backup API
      await this.db.backup(backupFile);
      
      // Cleanup old backups
      this.cleanupOldBackups(backupDir);
      
      this.stats.lastBackup = Date.now();
      this.logger.info(`Database backup created: ${backupFile}`);
      
      return backupFile;
    } catch (error) {
      this.logger.error('Failed to create backup:', error);
      throw error;
    }
  }

  /**
   * Cleanup old backup files
   */
  cleanupOldBackups(backupDir) {
    try {
      const files = fs.readdirSync(backupDir)
        .filter(file => file.endsWith('.db'))
        .map(file => ({
          name: file,
          path: path.join(backupDir, file),
          mtime: fs.statSync(path.join(backupDir, file)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);

      // Keep only the most recent backups
      if (files.length > this.options.maxBackups) {
        const filesToRemove = files.slice(this.options.maxBackups);
        
        for (const file of filesToRemove) {
          fs.unlinkSync(file.path);
          this.logger.debug(`Removed old backup: ${file.name}`);
        }
      }
    } catch (error) {
      this.logger.warn('Failed to cleanup old backups:', error);
    }
  }

  /**
   * Perform database maintenance
   */
  performMaintenance() {
    try {
      this.logger.info('Starting database maintenance...');
      
      // Analyze tables for query optimization
      this.db.exec('ANALYZE');
      
      // Vacuum database to reclaim space
      this.db.exec('VACUUM');
      
      // Rebuild indexes
      this.db.exec('REINDEX');
      
      // Update statistics
      this.updateStats();
      
      this.stats.lastMaintenance = Date.now();
      this.logger.info('Database maintenance completed');
      
    } catch (error) {
      this.logger.error('Database maintenance failed:', error);
    }
  }

  /**
   * Update database statistics
   */
  updateStats() {
    try {
      // Get database file size
      if (!this.options.memory && fs.existsSync(this.options.filename)) {
        const stats = fs.statSync(this.options.filename);
        this.stats.dbSize = stats.size;
      }
      
      // Update connection count (simplified for SQLite)
      this.stats.connections = 1;
      
    } catch (error) {
      this.logger.warn('Failed to update stats:', error);
    }
  }

  /**
   * Get database statistics
   */
  getStats() {
    this.updateStats();
    
    return {
      ...this.stats,
      tables: this.getTableInfo(),
      pragmas: this.getPragmaInfo(),
      activeTransactions: this.transactions.size,
      preparedStatements: this.statements.size
    };
  }

  /**
   * Get table information
   */
  getTableInfo() {
    try {
      const tables = this.db.prepare(`
        SELECT name, sql FROM sqlite_master 
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      `).all();
      
      const tableInfo = {};
      
      for (const table of tables) {
        try {
          const count = this.db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
          tableInfo[table.name] = {
            rowCount: count.count,
            sql: table.sql
          };
        } catch (error) {
          tableInfo[table.name] = { rowCount: 0, error: error.message };
        }
      }
      
      return tableInfo;
    } catch (error) {
      this.logger.warn('Failed to get table info:', error);
      return {};
    }
  }

  /**
   * Get pragma information
   */
  getPragmaInfo() {
    try {
      const pragmas = {};
      const pragmaQueries = [
        'journal_mode',
        'synchronous',
        'cache_size',
        'temp_store',
        'mmap_size',
        'page_size',
        'page_count'
      ];
      
      for (const pragma of pragmaQueries) {
        try {
          const result = this.db.pragma(pragma);
          pragmas[pragma] = result;
        } catch (error) {
          pragmas[pragma] = 'error';
        }
      }
      
      return pragmas;
    } catch (error) {
      this.logger.warn('Failed to get pragma info:', error);
      return {};
    }
  }

  /**
   * Optimize database performance
   */
  optimize() {
    try {
      this.logger.info('Optimizing database...');
      
      // Analyze query patterns and create missing indexes
      this.analyzeQueryPatterns();
      
      // Optimize pragma settings
      this.optimizePragmas();
      
      // Clean up old data
      this.cleanupOldData();
      
      this.logger.info('Database optimization completed');
      
    } catch (error) {
      this.logger.error('Database optimization failed:', error);
    }
  }

  /**
   * Analyze query patterns (simplified)
   */
  analyzeQueryPatterns() {
    // In a real implementation, this would analyze query logs
    // and suggest/create indexes for common query patterns
    this.logger.debug('Analyzing query patterns...');
  }

  /**
   * Optimize pragma settings
   */
  optimizePragmas() {
    try {
      // Adjust cache size based on available memory
      const totalMemory = require('os').totalmem();
      const cacheSize = Math.floor(totalMemory / (1024 * 1024 * 4)); // 1/4 of RAM in KB
      
      this.db.pragma(`cache_size = ${Math.min(cacheSize, 100000)}`);
      
    } catch (error) {
      this.logger.warn('Failed to optimize pragmas:', error);
    }
  }

  /**
   * Clean up old data
   */
  cleanupOldData() {
    try {
      const cutoff = Date.now() - (30 * TIME_CONSTANTS.day); // 30 days
      
      // Clean up old shares (keep last 30 days)
      const deletedShares = this.db.prepare(`
        DELETE FROM shares WHERE timestamp < ?
      `).run(cutoff);
      
      if (deletedShares.changes > 0) {
        this.logger.info(`Cleaned up ${deletedShares.changes} old shares`);
      }
      
      // Clean up old trades
      const deletedTrades = this.db.prepare(`
        DELETE FROM trades WHERE timestamp < ?
      `).run(cutoff);
      
      if (deletedTrades.changes > 0) {
        this.logger.info(`Cleaned up ${deletedTrades.changes} old trades`);
      }
      
    } catch (error) {
      this.logger.warn('Failed to cleanup old data:', error);
    }
  }

  /**
   * Check database integrity
   */
  checkIntegrity() {
    try {
      const result = this.db.pragma('integrity_check');
      const isOk = result.length === 1 && result[0].integrity_check === 'ok';
      
      if (!isOk) {
        this.logger.error('Database integrity check failed:', result);
      }
      
      return isOk;
    } catch (error) {
      this.logger.error('Database integrity check error:', error);
      return false;
    }
  }

  /**
   * Batch add shares for performance
   */
  async batchAddShares(shares) {
    if (this.batcher) {
      return await this.batcher.batchAddShares(shares);
    }
    
    // Fallback to individual inserts
    const results = [];
    for (const share of shares) {
      results.push(await this.addShare(
        share.workerId,
        share.difficulty,
        share.valid,
        share.algorithm
      ));
    }
    return results;
  }

  /**
   * Batch add trades for performance
   */
  async batchAddTrades(trades) {
    if (this.batcher) {
      return await this.batcher.batchAddTrades(trades);
    }
    
    // Fallback to individual inserts
    const results = [];
    for (const trade of trades) {
      results.push(await this.addTrade(
        trade.pair,
        trade.amountIn,
        trade.amountOut,
        trade.fee,
        trade.trader
      ));
    }
    return results;
  }

  /**
   * Get batcher performance report
   */
  getBatcherReport() {
    if (this.batcher) {
      return this.batcher.getPerformanceReport();
    }
    return null;
  }

  /**
   * Close database connection
   */
  async close() {
    try {
      // Stop batcher
      if (this.batcher) {
        await this.batcher.stop();
        this.batcher = null;
      }
      
      // Stop timers
      if (this.backupTimer) {
        clearInterval(this.backupTimer);
        this.backupTimer = null;
      }
      
      if (this.maintenanceTimer) {
        clearInterval(this.maintenanceTimer);
        this.maintenanceTimer = null;
      }
      
      // Close database
      if (this.db) {
        this.db.close();
        this.db = null;
      }
      
      this.logger.info('Database connection closed');
      
    } catch (error) {
      this.logger.error('Failed to close database:', error);
    }
  }
}

export default OtedamaDB;
