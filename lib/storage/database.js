/**
 * Database - Otedama
 * Simple, efficient database layer using SQLite
 */

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../core/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger('Database');

export class Database {
  constructor(options = {}) {
    this.config = {
      filename: options.filename || path.join(process.cwd(), 'data', 'otedama.db'),
      mode: options.mode || sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
      ...options
    };
    
    this.db = null;
    this.isOpen = false;
  }
  
  async open() {
    if (this.isOpen) return;
    
    try {
      this.db = await open({
        filename: this.config.filename,
        driver: sqlite3.Database,
        mode: this.config.mode
      });
      
      // Enable WAL mode for better concurrency
      await this.db.exec('PRAGMA journal_mode = WAL');
      await this.db.exec('PRAGMA synchronous = NORMAL');
      
      this.isOpen = true;
      logger.info(`Database opened: ${this.config.filename}`);
      
    } catch (error) {
      logger.error('Failed to open database:', error);
      throw error;
    }
  }
  
  async close() {
    if (!this.isOpen) return;
    
    try {
      await this.db.close();
      this.isOpen = false;
      logger.info('Database closed');
      
    } catch (error) {
      logger.error('Failed to close database:', error);
      throw error;
    }
  }
  
  // Core operations
  
  async run(sql, params = {}) {
    await this.ensureOpen();
    return this.db.run(sql, params);
  }
  
  async get(sql, params = {}) {
    await this.ensureOpen();
    return this.db.get(sql, params);
  }
  
  async all(sql, params = {}) {
    await this.ensureOpen();
    return this.db.all(sql, params);
  }
  
  async exec(sql) {
    await this.ensureOpen();
    return this.db.exec(sql);
  }
  
  // Transaction support
  
  async transaction(callback) {
    await this.ensureOpen();
    
    await this.db.run('BEGIN TRANSACTION');
    
    try {
      const result = await callback(this);
      await this.db.run('COMMIT');
      return result;
      
    } catch (error) {
      await this.db.run('ROLLBACK');
      throw error;
    }
  }
  
  // Schema management
  
  async createTables() {
    await this.ensureOpen();
    
    // Shares table
    await this.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        worker_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        difficulty REAL NOT NULL,
        share_diff REAL NOT NULL,
        block_diff REAL NOT NULL,
        block_height INTEGER,
        reward REAL,
        is_valid BOOLEAN DEFAULT 1,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        
        INDEX idx_shares_worker (worker_id),
        INDEX idx_shares_timestamp (timestamp)
      )
    `);
    
    // Miners table
    await this.exec(`
      CREATE TABLE IF NOT EXISTS miners (
        id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        worker TEXT,
        hashrate REAL DEFAULT 0,
        shares_valid INTEGER DEFAULT 0,
        shares_invalid INTEGER DEFAULT 0,
        last_share INTEGER,
        balance REAL DEFAULT 0,
        total_paid REAL DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        
        INDEX idx_miners_address (address)
      )
    `);
    
    // Blocks table
    await this.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        height INTEGER PRIMARY KEY,
        hash TEXT NOT NULL,
        finder_id TEXT NOT NULL,
        reward REAL NOT NULL,
        confirmations INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        
        FOREIGN KEY (finder_id) REFERENCES miners(id)
      )
    `);
    
    // Payments table
    await this.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        miner_id TEXT NOT NULL,
        amount REAL NOT NULL,
        tx_hash TEXT,
        status TEXT DEFAULT 'pending',
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        
        FOREIGN KEY (miner_id) REFERENCES miners(id),
        INDEX idx_payments_miner (miner_id),
        INDEX idx_payments_status (status)
      )
    `);
    
    logger.info('Database tables created');
  }
  
  // Helper methods
  
  async ensureOpen() {
    if (!this.isOpen) {
      await this.open();
    }
  }
  
  // Mining pool specific queries
  
  async addShare(share) {
    const sql = `
      INSERT INTO shares (
        worker_id, job_id, difficulty, share_diff, 
        block_diff, block_height, reward, is_valid
      ) VALUES (
        $worker_id, $job_id, $difficulty, $share_diff,
        $block_diff, $block_height, $reward, $is_valid
      )
    `;
    
    return this.run(sql, {
      $worker_id: share.workerId,
      $job_id: share.jobId,
      $difficulty: share.difficulty,
      $share_diff: share.shareDiff,
      $block_diff: share.blockDiff,
      $block_height: share.blockHeight,
      $reward: share.reward || 0,
      $is_valid: share.isValid ? 1 : 0
    });
  }
  
  async getShares(workerId, since) {
    const sql = `
      SELECT * FROM shares 
      WHERE worker_id = ? AND timestamp >= ?
      ORDER BY timestamp DESC
    `;
    
    return this.all(sql, [workerId, since]);
  }
  
  async getMiner(address) {
    const sql = 'SELECT * FROM miners WHERE address = ?';
    return this.get(sql, [address]);
  }
  
  async updateMiner(minerId, updates) {
    const fields = Object.keys(updates).map(key => `${key} = $${key}`).join(', ');
    const sql = `UPDATE miners SET ${fields} WHERE id = $id`;
    
    const params = { $id: minerId };
    for (const [key, value] of Object.entries(updates)) {
      params[`$${key}`] = value;
    }
    
    return this.run(sql, params);
  }
  
  async addBlock(block) {
    const sql = `
      INSERT INTO blocks (height, hash, finder_id, reward)
      VALUES ($height, $hash, $finder_id, $reward)
    `;
    
    return this.run(sql, {
      $height: block.height,
      $hash: block.hash,
      $finder_id: block.finderId,
      $reward: block.reward
    });
  }
  
  async getPendingPayments() {
    const sql = `
      SELECT p.*, m.address 
      FROM payments p
      JOIN miners m ON p.miner_id = m.id
      WHERE p.status = 'pending'
      ORDER BY p.timestamp ASC
    `;
    
    return this.all(sql);
  }
  
  async getPoolStats() {
    const stats = await this.get(`
      SELECT 
        COUNT(DISTINCT worker_id) as total_workers,
        COUNT(*) as total_shares,
        SUM(CASE WHEN is_valid = 1 THEN 1 ELSE 0 END) as valid_shares,
        AVG(difficulty) as avg_difficulty
      FROM shares
      WHERE timestamp >= strftime('%s', 'now') - 3600
    `);
    
    const blocks = await this.get(`
      SELECT COUNT(*) as total_blocks
      FROM blocks
      WHERE status = 'confirmed'
    `);
    
    return { ...stats, ...blocks };
  }
  
  // Cleanup old data
  
  async cleanup(daysToKeep = 7) {
    const cutoff = Math.floor(Date.now() / 1000) - (daysToKeep * 24 * 60 * 60);
    
    await this.transaction(async () => {
      // Delete old shares
      await this.run('DELETE FROM shares WHERE timestamp < ?', [cutoff]);
      
      // Delete old payments
      await this.run(
        'DELETE FROM payments WHERE timestamp < ? AND status = ?',
        [cutoff, 'completed']
      );
      
      // Vacuum to reclaim space
      await this.exec('VACUUM');
    });
    
    logger.info(`Cleaned up data older than ${daysToKeep} days`);
  }
}

export default Database;
