/**
 * Storage Module - Otedama
 * Unified storage layer with high performance
 * 
 * Features:
 * - SQLite with WAL mode for better concurrency
 * - LRU memory cache
 * - Specialized stores for shares and blocks
 * - Automatic data cleanup
 * - Batch operations support
 */

import { createLogger } from '../core/logger.js';
import { LRUCache } from '../core/performance.js';
import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { getConnectionPool } from './connection-pool.js';

const logger = createLogger('Storage');

/**
 * Storage Manager - Central storage coordination
 */
export class StorageManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.dataDir = options.dataDir || './data';
    this.dbPath = path.join(this.dataDir, options.dbFile || 'otedama.db');
    this.cacheSize = options.cacheSize || 10000;
    this.enableWAL = options.enableWAL !== false;
    this.enableVacuum = options.enableVacuum !== false;
    this.vacuumInterval = options.vacuumInterval || 86400000; // 24 hours
    this.useConnectionPool = options.useConnectionPool !== false;
    
    // Components
    this.db = null;
    this.connectionPool = null;
    this.cache = new LRUCache(this.cacheSize);
    this.shareStore = null;
    this.blockStore = null;
    
    // Statistics
    this.stats = {
      dbQueries: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalWrites: 0,
      totalReads: 0
    };
    
    // Timers
    this.vacuumTimer = null;
  }
  
  /**
   * Initialize storage
   */
  async initialize() {
    logger.info('Initializing storage manager...');
    
    // Create data directory
    await fs.mkdir(this.dataDir, { recursive: true });
    
    // Initialize database
    await this.initializeDatabase();
    
    // Initialize specialized stores
    this.shareStore = new ShareStore(this);
    this.blockStore = new BlockStore(this);
    
    await this.shareStore.initialize();
    await this.blockStore.initialize();
    
    // Start maintenance
    if (this.enableVacuum) {
      this.startVacuumTimer();
    }
    
    logger.info('Storage manager initialized');
    this.emit('initialized');
  }
  
  /**
   * Initialize database
   */
  async initializeDatabase() {
    try {
      if (this.useConnectionPool) {
        // Use connection pool for better scalability
        this.connectionPool = getConnectionPool({
          databasePath: this.dbPath,
          minConnections: 2,
          maxConnections: 10,
          enableWAL: this.enableWAL,
          enableVacuum: false, // Handled by storage manager
          debug: process.env.DEBUG_SQL
        });
        
        await this.connectionPool.initialize();
        
        // Get a connection for table creation
        await this.connectionPool.execute(db => {
          this.createTablesOnConnection(db);
        });
        
        // Prepare statements using pool
        this.preparePoolStatements();
      } else {
        // Single connection mode (backward compatibility)
        this.db = new Database(this.dbPath, {
          verbose: process.env.DEBUG_SQL ? logger.debug : null
        });
        
        // Enable WAL mode for better concurrency
        if (this.enableWAL) {
          this.db.pragma('journal_mode = WAL');
          this.db.pragma('synchronous = NORMAL');
        }
        
        // Performance optimizations
        this.db.pragma('cache_size = -64000'); // 64MB cache
        this.db.pragma('mmap_size = 268435456'); // 256MB memory map
        this.db.pragma('temp_store = MEMORY');
        
        // Create tables
        this.createTables();
        
        // Prepare common statements
        this.prepareStatements();
      }
      
      logger.info('Database initialized');
      
    } catch (error) {
      logger.error('Database initialization failed:', error);
      throw error;
    }
  }
  
  /**
   * Create tables on connection
   */
  createTablesOnConnection(db) {
    // Miners table
    db.exec(`
      CREATE TABLE IF NOT EXISTS miners (
        id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        worker TEXT,
        ip TEXT,
        shares_submitted INTEGER DEFAULT 0,
        shares_valid INTEGER DEFAULT 0,
        shares_invalid INTEGER DEFAULT 0,
        total_difficulty REAL DEFAULT 0,
        last_share_time INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_miners_address ON miners(address);
      CREATE INDEX IF NOT EXISTS idx_miners_last_share ON miners(last_share_time);
    `);
    
    // Shares table
    db.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        miner_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        difficulty REAL NOT NULL,
        actual_difficulty REAL,
        is_valid INTEGER DEFAULT 1,
        is_block INTEGER DEFAULT 0,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (miner_id) REFERENCES miners(id)
      );
      CREATE INDEX IF NOT EXISTS idx_shares_miner ON shares(miner_id);
      CREATE INDEX IF NOT EXISTS idx_shares_timestamp ON shares(timestamp);
      CREATE INDEX IF NOT EXISTS idx_shares_block ON shares(is_block);
    `);
    
    // Blocks table
    db.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        height INTEGER PRIMARY KEY,
        hash TEXT UNIQUE NOT NULL,
        miner_id TEXT NOT NULL,
        difficulty REAL NOT NULL,
        reward REAL NOT NULL,
        timestamp INTEGER NOT NULL,
        confirmations INTEGER DEFAULT 0,
        is_orphan INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (miner_id) REFERENCES miners(id)
      );
      CREATE INDEX IF NOT EXISTS idx_blocks_hash ON blocks(hash);
      CREATE INDEX IF NOT EXISTS idx_blocks_miner ON blocks(miner_id);
      CREATE INDEX IF NOT EXISTS idx_blocks_orphan ON blocks(is_orphan);
    `);
    
    // Payments table
    db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        miner_id TEXT NOT NULL,
        amount REAL NOT NULL,
        tx_hash TEXT,
        status TEXT DEFAULT 'pending',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        processed_at INTEGER,
        FOREIGN KEY (miner_id) REFERENCES miners(id)
      );
      CREATE INDEX IF NOT EXISTS idx_payments_miner ON payments(miner_id);
      CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    `);
    
    // Settings table
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
    `);
  }
  
  /**
   * Create database tables (for single connection mode)
   */
  createTables() {
    this.createTablesOnConnection(this.db);
  }
  
  /**
   * Prepare statements for pool mode
   */
  preparePoolStatements() {
    this.statements = {
      // Miner operations
      getMiner: this.connectionPool.prepareStatement('SELECT * FROM miners WHERE id = ?'),
      insertMiner: this.connectionPool.prepareStatement(`
        INSERT INTO miners (id, address, worker, ip)
        VALUES (?, ?, ?, ?)
      `),
      updateMinerStats: this.connectionPool.prepareStatement(`
        UPDATE miners SET
          shares_submitted = shares_submitted + ?,
          shares_valid = shares_valid + ?,
          shares_invalid = shares_invalid + ?,
          total_difficulty = total_difficulty + ?,
          last_share_time = ?,
          updated_at = strftime('%s', 'now')
        WHERE id = ?
      `),
      
      // Share operations
      insertShare: this.connectionPool.prepareStatement(`
        INSERT INTO shares (miner_id, job_id, nonce, difficulty, actual_difficulty, is_valid, is_block)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      getRecentShares: this.connectionPool.prepareStatement(`
        SELECT * FROM shares
        WHERE timestamp > ?
        ORDER BY timestamp DESC
        LIMIT ?
      `),
      
      // Block operations
      insertBlock: this.connectionPool.prepareStatement(`
        INSERT INTO blocks (height, hash, miner_id, difficulty, reward, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      updateBlockConfirmations: this.connectionPool.prepareStatement(`
        UPDATE blocks SET confirmations = ? WHERE height = ?
      `),
      
      // Payment operations
      insertPayment: this.connectionPool.prepareStatement(`
        INSERT INTO payments (miner_id, amount)
        VALUES (?, ?, ?)
      `),
      getPendingPayments: this.connectionPool.prepareStatement(`
        SELECT * FROM payments WHERE status = 'pending'
      `),
      
      // Settings operations
      getSetting: this.connectionPool.prepareStatement('SELECT value FROM settings WHERE key = ?'),
      setSetting: this.connectionPool.prepareStatement(`
        INSERT OR REPLACE INTO settings (key, value, updated_at)
        VALUES (?, ?, strftime('%s', 'now'))
      `)
    };
  }
  
  /**
   * Prepare common statements
   */
  prepareStatements() {
    this.statements = {
      // Miner operations
      getMiner: this.db.prepare('SELECT * FROM miners WHERE id = ?'),
      insertMiner: this.db.prepare(`
        INSERT INTO miners (id, address, worker, ip)
        VALUES (?, ?, ?, ?)
      `),
      updateMinerStats: this.db.prepare(`
        UPDATE miners SET
          shares_submitted = shares_submitted + ?,
          shares_valid = shares_valid + ?,
          shares_invalid = shares_invalid + ?,
          total_difficulty = total_difficulty + ?,
          last_share_time = ?,
          updated_at = strftime('%s', 'now')
        WHERE id = ?
      `),
      
      // Share operations
      insertShare: this.db.prepare(`
        INSERT INTO shares (miner_id, job_id, nonce, difficulty, actual_difficulty, is_valid, is_block)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      getRecentShares: this.db.prepare(`
        SELECT * FROM shares
        WHERE timestamp > ?
        ORDER BY timestamp DESC
        LIMIT ?
      `),
      
      // Block operations
      insertBlock: this.db.prepare(`
        INSERT INTO blocks (height, hash, miner_id, difficulty, reward, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      updateBlockConfirmations: this.db.prepare(`
        UPDATE blocks SET confirmations = ? WHERE height = ?
      `),
      
      // Payment operations
      insertPayment: this.db.prepare(`
        INSERT INTO payments (miner_id, amount)
        VALUES (?, ?)
      `),
      getPendingPayments: this.db.prepare(`
        SELECT * FROM payments WHERE status = 'pending'
      `),
      
      // Settings operations
      getSetting: this.db.prepare('SELECT value FROM settings WHERE key = ?'),
      setSetting: this.db.prepare(`
        INSERT OR REPLACE INTO settings (key, value, updated_at)
        VALUES (?, ?, strftime('%s', 'now'))
      `)
    };
  }
  
  /**
   * Get from cache or database
   */
  async get(key, fetchFn) {
    this.stats.totalReads++;
    
    // Check cache
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.stats.cacheHits++;
      return cached;
    }
    
    this.stats.cacheMisses++;
    
    // Fetch from database
    const value = await fetchFn();
    
    // Store in cache
    if (value !== null && value !== undefined) {
      this.cache.set(key, value);
    }
    
    return value;
  }
  
  /**
   * Set in cache and database
   */
  async set(key, value, storeFn) {
    this.stats.totalWrites++;
    
    // Store in database
    await storeFn(value);
    
    // Update cache
    this.cache.set(key, value);
  }
  
  /**
   * Delete from cache and database
   */
  async delete(key, deleteFn) {
    // Delete from database
    await deleteFn();
    
    // Remove from cache
    this.cache.delete(key);
  }
  
  /**
   * Execute database query
   */
  async execute(fn) {
    this.stats.dbQueries++;
    
    if (this.connectionPool) {
      return this.connectionPool.execute(fn);
    } else {
      return fn(this.db);
    }
  }
  
  /**
   * Transaction wrapper
   */
  async transaction(fn) {
    if (this.connectionPool) {
      return this.connectionPool.transaction(fn);
    } else {
      return this.db.transaction(fn)();
    }
  }
  
  /**
   * Start vacuum timer
   */
  startVacuumTimer() {
    this.vacuumTimer = setInterval(() => {
      this.vacuum();
    }, this.vacuumInterval);
    
    // Run initial vacuum
    setTimeout(() => this.vacuum(), 10000);
  }
  
  /**
   * Vacuum database
   */
  async vacuum() {
    try {
      logger.info('Starting database vacuum...');
      
      await this.execute(async (db) => {
        // Clean old shares (keep 7 days)
        const cutoff = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
        const deleted = db.prepare('DELETE FROM shares WHERE timestamp < ?').run(cutoff);
        
        logger.info(`Deleted ${deleted.changes} old shares`);
        
        // Vacuum
        db.prepare('VACUUM').run();
      });
      
      logger.info('Database vacuum completed');
      this.emit('vacuum:completed');
      
    } catch (error) {
      logger.error('Vacuum failed:', error);
    }
  }
  
  /**
   * Get storage statistics
   */
  async getStats() {
    const dbStats = await this.execute((db) => {
      return db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM miners) as miners,
          (SELECT COUNT(*) FROM shares) as shares,
          (SELECT COUNT(*) FROM blocks) as blocks,
          (SELECT COUNT(*) FROM payments) as payments
      `).get();
    });
    
    const cacheStats = this.cache.getStats();
    
    // Add connection pool stats if using pool
    const poolStats = this.connectionPool ? this.connectionPool.getStats() : null;
    
    return {
      ...this.stats,
      database: dbStats,
      cache: cacheStats,
      cacheHitRate: this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses) * 100,
      connectionPool: poolStats
    };
  }
  
  /**
   * Shutdown storage
   */
  async shutdown() {
    logger.info('Shutting down storage manager...');
    
    // Stop vacuum timer
    if (this.vacuumTimer) {
      clearInterval(this.vacuumTimer);
      this.vacuumTimer = null;
    }
    
    // Shutdown connection pool or close database
    if (this.connectionPool) {
      await this.connectionPool.shutdown();
      this.connectionPool = null;
    } else if (this.db) {
      this.db.close();
      this.db = null;
    }
    
    logger.info('Storage manager shutdown complete');
    this.emit('shutdown');
  }
}

/**
 * Share Store - Specialized storage for shares
 */
export class ShareStore {
  constructor(storageManager) {
    this.storage = storageManager;
    this.recentShares = new RingBuffer(10000);
    this.shareWindow = 7200000; // 2 hours for PPLNS
  }
  
  async initialize() {
    // Load recent shares into memory
    const cutoff = Math.floor((Date.now() - this.shareWindow) / 1000);
    const shares = await this.storage.statements.getRecentShares.all(cutoff, 10000);
    
    for (const share of shares) {
      this.recentShares.write(share);
    }
    
    logger.info(`Loaded ${shares.length} recent shares`);
  }
  
  /**
   * Add share
   */
  async addShare(share) {
    // Store in database
    const result = await this.storage.statements.insertShare.run(
      share.minerId,
      share.jobId,
      share.nonce,
      share.difficulty,
      share.actualDifficulty || null,
      share.isValid ? 1 : 0,
      share.isBlock ? 1 : 0
    );
    
    // Add to recent shares
    const shareRecord = {
      id: result.lastInsertRowid,
      ...share,
      timestamp: Date.now()
    };
    
    this.recentShares.write(shareRecord);
    
    return shareRecord;
  }
  
  /**
   * Get shares for PPLNS calculation
   */
  getSharesForPPLNS() {
    const cutoff = Date.now() - this.shareWindow;
    const shares = [];
    
    // Get from ring buffer
    const allShares = this.recentShares.readAll();
    for (const share of allShares) {
      if (share.timestamp > cutoff && share.isValid) {
        shares.push(share);
      }
    }
    
    return shares;
  }
  
  /**
   * Get miner shares
   */
  async getMinerShares(minerId, since) {
    const cutoff = Math.floor(since / 1000);
    return this.storage.execute((db) => {
      return db.prepare(`
        SELECT * FROM shares
        WHERE miner_id = ? AND timestamp > ?
        ORDER BY timestamp DESC
      `).all(minerId, cutoff);
    });
  }
}

/**
 * Block Store - Specialized storage for blocks
 */
export class BlockStore {
  constructor(storageManager) {
    this.storage = storageManager;
    this.recentBlocks = [];
    this.maxRecentBlocks = 100;
  }
  
  async initialize() {
    // Load recent blocks
    const blocks = await this.storage.execute((db) => {
      return db.prepare(`
        SELECT * FROM blocks
        WHERE is_orphan = 0
        ORDER BY height DESC
        LIMIT ?
      `).all(this.maxRecentBlocks);
    });
    
    this.recentBlocks = blocks.reverse();
    logger.info(`Loaded ${blocks.length} recent blocks`);
  }
  
  /**
   * Add block
   */
  async addBlock(block) {
    // Store in database
    await this.storage.statements.insertBlock.run(
      block.height,
      block.hash,
      block.minerId,
      block.difficulty,
      block.reward,
      block.timestamp
    );
    
    // Update recent blocks
    this.recentBlocks.push(block);
    if (this.recentBlocks.length > this.maxRecentBlocks) {
      this.recentBlocks.shift();
    }
    
    // Invalidate cache
    this.storage.cache.delete(`block:${block.height}`);
    this.storage.cache.delete(`block:${block.hash}`);
    
    return block;
  }
  
  /**
   * Get block by height
   */
  async getBlockByHeight(height) {
    return this.storage.get(`block:${height}`, async () => {
      return this.storage.execute((db) => {
        return db.prepare(
          'SELECT * FROM blocks WHERE height = ?'
        ).get(height);
      });
    });
  }
  
  /**
   * Get block by hash
   */
  async getBlockByHash(hash) {
    return this.storage.get(`block:${hash}`, async () => {
      return this.storage.execute((db) => {
        return db.prepare(
          'SELECT * FROM blocks WHERE hash = ?'
        ).get(hash);
      });
    });
  }
  
  /**
   * Update block confirmations
   */
  async updateConfirmations(height, confirmations) {
    await this.storage.statements.updateBlockConfirmations.run(confirmations, height);
    
    // Invalidate cache
    this.storage.cache.delete(`block:${height}`);
  }
  
  /**
   * Mark block as orphan
   */
  async markOrphan(height) {
    await this.storage.execute((db) => {
      db.prepare(
        'UPDATE blocks SET is_orphan = 1 WHERE height = ?'
      ).run(height);
    });
    
    // Remove from recent blocks
    this.recentBlocks = this.recentBlocks.filter(b => b.height !== height);
    
    // Invalidate cache
    this.storage.cache.delete(`block:${height}`);
  }
  
  /**
   * Get recent blocks
   */
  getRecentBlocks(limit = 10) {
    return this.recentBlocks.slice(-limit);
  }
}

/**
 * Ring Buffer for recent data
 */
class RingBuffer {
  constructor(size) {
    this.size = size;
    this.buffer = new Array(size);
    this.writeIndex = 0;
    this.count = 0;
  }
  
  write(item) {
    this.buffer[this.writeIndex] = item;
    this.writeIndex = (this.writeIndex + 1) % this.size;
    if (this.count < this.size) this.count++;
  }
  
  readAll() {
    if (this.count === 0) return [];
    
    const result = [];
    const startIndex = this.count < this.size ? 0 : this.writeIndex;
    
    for (let i = 0; i < this.count; i++) {
      const index = (startIndex + i) % this.size;
      if (this.buffer[index]) {
        result.push(this.buffer[index]);
      }
    }
    
    return result;
  }
}

/**
 * Create storage manager instance
 */
export function createStorageManager(options) {
  return new StorageManager(options);
}

// Re-export blockchain integration
// Blockchain integration moved to separate module

export default {
  StorageManager,
  ShareStore,
  BlockStore,
  createStorageManager
};
