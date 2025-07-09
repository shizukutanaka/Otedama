/**
 * Share Persistence Layer
 * Design: Carmack (Performance) + Martin (Clean Architecture) + Pike (Simplicity)
 * 
 * Supports SQLite and PostgreSQL for share storage and retrieval
 */

import { EventEmitter } from 'events';
import sqlite3 from 'sqlite3';
import { Client as PgClient } from 'pg';
import { createComponentLogger } from '../logging/simple-logger';

// ===== INTERFACES =====
export interface DatabaseConfig {
  type: 'sqlite' | 'postgresql';
  connectionString?: string; // For PostgreSQL
  filename?: string; // For SQLite
  poolSize?: number;
  idleTimeout?: number;
}

export interface Share {
  id?: number;
  minerId: string;
  workerName?: string;
  jobId: string;
  nonce: string;
  extraNonce?: string;
  difficulty: number;
  shareDifficulty: number;
  hash: string;
  timestamp: number;
  valid: boolean;
  blockHeight?: number;
  blockHash?: string;
  reward?: number;
}

export interface MinerStats {
  minerId: string;
  totalShares: number;
  validShares: number;
  invalidShares: number;
  totalDifficulty: number;
  averageHashrate: number;
  lastShareTime: number;
  blocksFound: number;
  totalRewards: number;
}

export interface PoolStats {
  totalShares: number;
  validShares: number;
  invalidShares: number;
  totalMiners: number;
  activeMiners: number;
  poolHashrate: number;
  blocksFound: number;
  totalRewards: number;
  lastBlockTime?: number;
}

// ===== BASE DATABASE CLASS =====
abstract class BaseDatabase extends EventEmitter {
  protected logger = createComponentLogger('ShareDatabase');
  protected initialized = false;

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract insertShare(share: Share): Promise<number>;
  abstract getShare(id: number): Promise<Share | null>;
  abstract getSharesByMiner(minerId: string, limit?: number, offset?: number): Promise<Share[]>;
  abstract getSharesByTimeRange(startTime: number, endTime: number): Promise<Share[]>;
  abstract getLastNShares(n: number): Promise<Share[]>;
  abstract updateShareValidity(id: number, valid: boolean): Promise<void>;
  abstract deleteOldShares(beforeTime: number): Promise<number>;
  abstract getMinerStats(minerId: string): Promise<MinerStats | null>;
  abstract getTopMiners(limit: number): Promise<MinerStats[]>;
  abstract getPoolStats(): Promise<PoolStats>;
  abstract beginTransaction(): Promise<void>;
  abstract commitTransaction(): Promise<void>;
  abstract rollbackTransaction(): Promise<void>;
}

// ===== SQLITE IMPLEMENTATION =====
export class SQLiteShareDatabase extends BaseDatabase {
  private db?: sqlite3.Database;
  private filename: string;

  constructor(filename: string = './data/shares.db') {
    super();
    this.filename = filename;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.filename, (err) => {
        if (err) {
          this.logger.error('Failed to connect to SQLite', err);
          reject(err);
        } else {
          this.logger.info('Connected to SQLite database', { filename: this.filename });
          this.initialize().then(resolve).catch(reject);
        }
      });
    });
  }

  private async initialize(): Promise<void> {
    const queries = [
      // Shares table
      `CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        miner_id TEXT NOT NULL,
        worker_name TEXT,
        job_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        extra_nonce TEXT,
        difficulty REAL NOT NULL,
        share_difficulty REAL NOT NULL,
        hash TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        valid INTEGER NOT NULL DEFAULT 1,
        block_height INTEGER,
        block_hash TEXT,
        reward REAL,
        INDEX idx_miner_id (miner_id),
        INDEX idx_timestamp (timestamp),
        INDEX idx_valid (valid)
      )`,

      // Miners table for stats
      `CREATE TABLE IF NOT EXISTS miners (
        miner_id TEXT PRIMARY KEY,
        total_shares INTEGER DEFAULT 0,
        valid_shares INTEGER DEFAULT 0,
        invalid_shares INTEGER DEFAULT 0,
        total_difficulty REAL DEFAULT 0,
        blocks_found INTEGER DEFAULT 0,
        total_rewards REAL DEFAULT 0,
        last_share_time INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )`,

      // Blocks table
      `CREATE TABLE IF NOT EXISTS blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        height INTEGER NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        miner_id TEXT NOT NULL,
        difficulty REAL NOT NULL,
        reward REAL NOT NULL,
        timestamp INTEGER NOT NULL,
        confirmed INTEGER DEFAULT 0
      )`,

      // Create indexes
      `CREATE INDEX IF NOT EXISTS idx_shares_miner_time ON shares(miner_id, timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_shares_job ON shares(job_id)`,
      `CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height)`,
      `CREATE INDEX IF NOT EXISTS idx_blocks_miner ON blocks(miner_id)`
    ];

    for (const query of queries) {
      await this.run(query);
    }

    this.initialized = true;
    this.emit('initialized');
  }

  private run(sql: string, params: any[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db!.run(sql, params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private get<T>(sql: string, params: any[] = []): Promise<T | null> {
    return new Promise((resolve, reject) => {
      this.db!.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row as T || null);
      });
    });
  }

  private all<T>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db!.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows as T[]);
      });
    });
  }

  async insertShare(share: Share): Promise<number> {
    const sql = `
      INSERT INTO shares (
        miner_id, worker_name, job_id, nonce, extra_nonce,
        difficulty, share_difficulty, hash, timestamp, valid,
        block_height, block_hash, reward
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      share.minerId,
      share.workerName || null,
      share.jobId,
      share.nonce,
      share.extraNonce || null,
      share.difficulty,
      share.shareDifficulty,
      share.hash,
      share.timestamp,
      share.valid ? 1 : 0,
      share.blockHeight || null,
      share.blockHash || null,
      share.reward || null
    ];

    await this.run(sql, params);

    // Update miner stats
    await this.updateMinerStats(share);

    // Get the inserted ID
    const result = await this.get<{ id: number }>('SELECT last_insert_rowid() as id');
    return result!.id;
  }

  private async updateMinerStats(share: Share): Promise<void> {
    const sql = `
      INSERT INTO miners (miner_id, total_shares, valid_shares, invalid_shares, 
                         total_difficulty, last_share_time)
      VALUES (?, 1, ?, 0, ?, ?)
      ON CONFLICT(miner_id) DO UPDATE SET
        total_shares = total_shares + 1,
        valid_shares = valid_shares + ?,
        invalid_shares = invalid_shares + ?,
        total_difficulty = total_difficulty + ?,
        last_share_time = ?
    `;

    const validIncrement = share.valid ? 1 : 0;
    const invalidIncrement = share.valid ? 0 : 1;

    await this.run(sql, [
      share.minerId,
      validIncrement,
      share.difficulty,
      share.timestamp,
      validIncrement,
      invalidIncrement,
      share.difficulty,
      share.timestamp
    ]);
  }

  async getShare(id: number): Promise<Share | null> {
    const sql = 'SELECT * FROM shares WHERE id = ?';
    const row = await this.get<any>(sql, [id]);
    return row ? this.rowToShare(row) : null;
  }

  async getSharesByMiner(minerId: string, limit: number = 100, offset: number = 0): Promise<Share[]> {
    const sql = `
      SELECT * FROM shares 
      WHERE miner_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ? OFFSET ?
    `;
    const rows = await this.all<any>(sql, [minerId, limit, offset]);
    return rows.map(row => this.rowToShare(row));
  }

  async getSharesByTimeRange(startTime: number, endTime: number): Promise<Share[]> {
    const sql = `
      SELECT * FROM shares 
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp DESC
    `;
    const rows = await this.all<any>(sql, [startTime, endTime]);
    return rows.map(row => this.rowToShare(row));
  }

  async getLastNShares(n: number): Promise<Share[]> {
    const sql = `
      SELECT * FROM shares 
      ORDER BY timestamp DESC 
      LIMIT ?
    `;
    const rows = await this.all<any>(sql, [n]);
    return rows.map(row => this.rowToShare(row));
  }

  async updateShareValidity(id: number, valid: boolean): Promise<void> {
    const sql = 'UPDATE shares SET valid = ? WHERE id = ?';
    await this.run(sql, [valid ? 1 : 0, id]);
  }

  async deleteOldShares(beforeTime: number): Promise<number> {
    const countResult = await this.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM shares WHERE timestamp < ?',
      [beforeTime]
    );
    
    await this.run('DELETE FROM shares WHERE timestamp < ?', [beforeTime]);
    
    return countResult?.count || 0;
  }

  async getMinerStats(minerId: string): Promise<MinerStats | null> {
    const sql = `
      SELECT 
        m.*,
        (SELECT AVG(difficulty) FROM shares 
         WHERE miner_id = ? AND timestamp > ? AND valid = 1) as avg_difficulty
      FROM miners m
      WHERE m.miner_id = ?
    `;
    
    const windowTime = Date.now() - (3600 * 1000); // Last hour
    const row = await this.get<any>(sql, [minerId, windowTime, minerId]);
    
    if (!row) return null;

    return {
      minerId: row.miner_id,
      totalShares: row.total_shares,
      validShares: row.valid_shares,
      invalidShares: row.invalid_shares,
      totalDifficulty: row.total_difficulty,
      averageHashrate: this.calculateHashrate(row.avg_difficulty || 0),
      lastShareTime: row.last_share_time,
      blocksFound: row.blocks_found,
      totalRewards: row.total_rewards
    };
  }

  async getTopMiners(limit: number): Promise<MinerStats[]> {
    const sql = `
      SELECT 
        m.*,
        (SELECT AVG(difficulty) FROM shares 
         WHERE miner_id = m.miner_id AND timestamp > ? AND valid = 1) as avg_difficulty
      FROM miners m
      WHERE m.last_share_time > ?
      ORDER BY m.total_difficulty DESC
      LIMIT ?
    `;
    
    const windowTime = Date.now() - (24 * 3600 * 1000); // Last 24 hours
    const rows = await this.all<any>(sql, [windowTime, windowTime, limit]);
    
    return rows.map(row => ({
      minerId: row.miner_id,
      totalShares: row.total_shares,
      validShares: row.valid_shares,
      invalidShares: row.invalid_shares,
      totalDifficulty: row.total_difficulty,
      averageHashrate: this.calculateHashrate(row.avg_difficulty || 0),
      lastShareTime: row.last_share_time,
      blocksFound: row.blocks_found,
      totalRewards: row.total_rewards
    }));
  }

  async getPoolStats(): Promise<PoolStats> {
    const [shareStats, minerStats, blockStats] = await Promise.all([
      this.get<any>(`
        SELECT 
          COUNT(*) as total_shares,
          SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END) as valid_shares,
          SUM(CASE WHEN valid = 0 THEN 1 ELSE 0 END) as invalid_shares,
          AVG(CASE WHEN timestamp > ? THEN difficulty ELSE NULL END) as avg_difficulty
        FROM shares
      `, [Date.now() - (3600 * 1000)]),
      
      this.get<any>(`
        SELECT 
          COUNT(*) as total_miners,
          COUNT(CASE WHEN last_share_time > ? THEN 1 ELSE NULL END) as active_miners
        FROM miners
      `, [Date.now() - (600 * 1000)]), // Active in last 10 minutes
      
      this.get<any>(`
        SELECT 
          COUNT(*) as blocks_found,
          SUM(reward) as total_rewards,
          MAX(timestamp) as last_block_time
        FROM blocks
        WHERE confirmed = 1
      `)
    ]);

    return {
      totalShares: shareStats?.total_shares || 0,
      validShares: shareStats?.valid_shares || 0,
      invalidShares: shareStats?.invalid_shares || 0,
      totalMiners: minerStats?.total_miners || 0,
      activeMiners: minerStats?.active_miners || 0,
      poolHashrate: this.calculateHashrate(shareStats?.avg_difficulty || 0) * (minerStats?.active_miners || 0),
      blocksFound: blockStats?.blocks_found || 0,
      totalRewards: blockStats?.total_rewards || 0,
      lastBlockTime: blockStats?.last_block_time
    };
  }

  async beginTransaction(): Promise<void> {
    await this.run('BEGIN TRANSACTION');
  }

  async commitTransaction(): Promise<void> {
    await this.run('COMMIT');
  }

  async rollbackTransaction(): Promise<void> {
    await this.run('ROLLBACK');
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) {
            this.logger.error('Error closing SQLite database', err);
            reject(err);
          } else {
            this.logger.info('SQLite database closed');
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  private rowToShare(row: any): Share {
    return {
      id: row.id,
      minerId: row.miner_id,
      workerName: row.worker_name,
      jobId: row.job_id,
      nonce: row.nonce,
      extraNonce: row.extra_nonce,
      difficulty: row.difficulty,
      shareDifficulty: row.share_difficulty,
      hash: row.hash,
      timestamp: row.timestamp,
      valid: row.valid === 1,
      blockHeight: row.block_height,
      blockHash: row.block_hash,
      reward: row.reward
    };
  }

  private calculateHashrate(avgDifficulty: number): number {
    // Assuming 1 share per second average
    return avgDifficulty * Math.pow(2, 32);
  }
}

// ===== POSTGRESQL IMPLEMENTATION =====
export class PostgreSQLShareDatabase extends BaseDatabase {
  private client?: PgClient;
  private config: any;

  constructor(connectionString: string) {
    super();
    this.config = { connectionString };
  }

  async connect(): Promise<void> {
    try {
      this.client = new PgClient(this.config);
      await this.client.connect();
      this.logger.info('Connected to PostgreSQL database');
      await this.initialize();
    } catch (error) {
      this.logger.error('Failed to connect to PostgreSQL', error as Error);
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    const queries = [
      // Enable extensions
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"',
      
      // Shares table
      `CREATE TABLE IF NOT EXISTS shares (
        id SERIAL PRIMARY KEY,
        miner_id VARCHAR(255) NOT NULL,
        worker_name VARCHAR(255),
        job_id VARCHAR(255) NOT NULL,
        nonce VARCHAR(255) NOT NULL,
        extra_nonce VARCHAR(255),
        difficulty DOUBLE PRECISION NOT NULL,
        share_difficulty DOUBLE PRECISION NOT NULL,
        hash VARCHAR(255) NOT NULL,
        timestamp BIGINT NOT NULL,
        valid BOOLEAN NOT NULL DEFAULT true,
        block_height INTEGER,
        block_hash VARCHAR(255),
        reward DOUBLE PRECISION,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      // Indexes
      'CREATE INDEX IF NOT EXISTS idx_shares_miner_id ON shares(miner_id)',
      'CREATE INDEX IF NOT EXISTS idx_shares_timestamp ON shares(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_shares_valid ON shares(valid)',
      'CREATE INDEX IF NOT EXISTS idx_shares_miner_time ON shares(miner_id, timestamp)',

      // Miners table
      `CREATE TABLE IF NOT EXISTS miners (
        miner_id VARCHAR(255) PRIMARY KEY,
        total_shares BIGINT DEFAULT 0,
        valid_shares BIGINT DEFAULT 0,
        invalid_shares BIGINT DEFAULT 0,
        total_difficulty DOUBLE PRECISION DEFAULT 0,
        blocks_found INTEGER DEFAULT 0,
        total_rewards DOUBLE PRECISION DEFAULT 0,
        last_share_time BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      // Blocks table
      `CREATE TABLE IF NOT EXISTS blocks (
        id SERIAL PRIMARY KEY,
        height INTEGER NOT NULL,
        hash VARCHAR(255) NOT NULL UNIQUE,
        miner_id VARCHAR(255) NOT NULL,
        difficulty DOUBLE PRECISION NOT NULL,
        reward DOUBLE PRECISION NOT NULL,
        timestamp BIGINT NOT NULL,
        confirmed BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,

      // Indexes for blocks
      'CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height)',
      'CREATE INDEX IF NOT EXISTS idx_blocks_miner_id ON blocks(miner_id)'
    ];

    for (const query of queries) {
      await this.client!.query(query);
    }

    this.initialized = true;
    this.emit('initialized');
  }

  async insertShare(share: Share): Promise<number> {
    const query = `
      INSERT INTO shares (
        miner_id, worker_name, job_id, nonce, extra_nonce,
        difficulty, share_difficulty, hash, timestamp, valid,
        block_height, block_hash, reward
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id
    `;

    const values = [
      share.minerId,
      share.workerName || null,
      share.jobId,
      share.nonce,
      share.extraNonce || null,
      share.difficulty,
      share.shareDifficulty,
      share.hash,
      share.timestamp,
      share.valid,
      share.blockHeight || null,
      share.blockHash || null,
      share.reward || null
    ];

    const result = await this.client!.query(query, values);
    
    // Update miner stats
    await this.updateMinerStats(share);

    return result.rows[0].id;
  }

  private async updateMinerStats(share: Share): Promise<void> {
    const query = `
      INSERT INTO miners (miner_id, total_shares, valid_shares, invalid_shares, 
                         total_difficulty, last_share_time)
      VALUES ($1, 1, $2, $3, $4, $5)
      ON CONFLICT(miner_id) DO UPDATE SET
        total_shares = miners.total_shares + 1,
        valid_shares = miners.valid_shares + $2,
        invalid_shares = miners.invalid_shares + $3,
        total_difficulty = miners.total_difficulty + $4,
        last_share_time = $5
    `;

    const values = [
      share.minerId,
      share.valid ? 1 : 0,
      share.valid ? 0 : 1,
      share.difficulty,
      share.timestamp
    ];

    await this.client!.query(query, values);
  }

  async getShare(id: number): Promise<Share | null> {
    const query = 'SELECT * FROM shares WHERE id = $1';
    const result = await this.client!.query(query, [id]);
    return result.rows[0] ? this.rowToShare(result.rows[0]) : null;
  }

  async getSharesByMiner(minerId: string, limit: number = 100, offset: number = 0): Promise<Share[]> {
    const query = `
      SELECT * FROM shares 
      WHERE miner_id = $1 
      ORDER BY timestamp DESC 
      LIMIT $2 OFFSET $3
    `;
    const result = await this.client!.query(query, [minerId, limit, offset]);
    return result.rows.map(row => this.rowToShare(row));
  }

  async getSharesByTimeRange(startTime: number, endTime: number): Promise<Share[]> {
    const query = `
      SELECT * FROM shares 
      WHERE timestamp >= $1 AND timestamp <= $2
      ORDER BY timestamp DESC
    `;
    const result = await this.client!.query(query, [startTime, endTime]);
    return result.rows.map(row => this.rowToShare(row));
  }

  async getLastNShares(n: number): Promise<Share[]> {
    const query = `
      SELECT * FROM shares 
      ORDER BY timestamp DESC 
      LIMIT $1
    `;
    const result = await this.client!.query(query, [n]);
    return result.rows.map(row => this.rowToShare(row));
  }

  async updateShareValidity(id: number, valid: boolean): Promise<void> {
    const query = 'UPDATE shares SET valid = $1 WHERE id = $2';
    await this.client!.query(query, [valid, id]);
  }

  async deleteOldShares(beforeTime: number): Promise<number> {
    const query = 'DELETE FROM shares WHERE timestamp < $1 RETURNING id';
    const result = await this.client!.query(query, [beforeTime]);
    return result.rowCount;
  }

  async getMinerStats(minerId: string): Promise<MinerStats | null> {
    const query = `
      SELECT 
        m.*,
        (SELECT AVG(difficulty) FROM shares 
         WHERE miner_id = $1 AND timestamp > $2 AND valid = true) as avg_difficulty
      FROM miners m
      WHERE m.miner_id = $1
    `;
    
    const windowTime = Date.now() - (3600 * 1000); // Last hour
    const result = await this.client!.query(query, [minerId, windowTime]);
    
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      minerId: row.miner_id,
      totalShares: parseInt(row.total_shares),
      validShares: parseInt(row.valid_shares),
      invalidShares: parseInt(row.invalid_shares),
      totalDifficulty: parseFloat(row.total_difficulty),
      averageHashrate: this.calculateHashrate(parseFloat(row.avg_difficulty || 0)),
      lastShareTime: parseInt(row.last_share_time),
      blocksFound: parseInt(row.blocks_found),
      totalRewards: parseFloat(row.total_rewards)
    };
  }

  async getTopMiners(limit: number): Promise<MinerStats[]> {
    const query = `
      SELECT 
        m.*,
        (SELECT AVG(difficulty) FROM shares 
         WHERE miner_id = m.miner_id AND timestamp > $1 AND valid = true) as avg_difficulty
      FROM miners m
      WHERE m.last_share_time > $1
      ORDER BY m.total_difficulty DESC
      LIMIT $2
    `;
    
    const windowTime = Date.now() - (24 * 3600 * 1000); // Last 24 hours
    const result = await this.client!.query(query, [windowTime, limit]);
    
    return result.rows.map(row => ({
      minerId: row.miner_id,
      totalShares: parseInt(row.total_shares),
      validShares: parseInt(row.valid_shares),
      invalidShares: parseInt(row.invalid_shares),
      totalDifficulty: parseFloat(row.total_difficulty),
      averageHashrate: this.calculateHashrate(parseFloat(row.avg_difficulty || 0)),
      lastShareTime: parseInt(row.last_share_time),
      blocksFound: parseInt(row.blocks_found),
      totalRewards: parseFloat(row.total_rewards)
    }));
  }

  async getPoolStats(): Promise<PoolStats> {
    const queries = [
      `SELECT 
        COUNT(*) as total_shares,
        SUM(CASE WHEN valid = true THEN 1 ELSE 0 END) as valid_shares,
        SUM(CASE WHEN valid = false THEN 1 ELSE 0 END) as invalid_shares,
        AVG(CASE WHEN timestamp > $1 THEN difficulty ELSE NULL END) as avg_difficulty
      FROM shares`,
      
      `SELECT 
        COUNT(*) as total_miners,
        COUNT(CASE WHEN last_share_time > $1 THEN 1 ELSE NULL END) as active_miners
      FROM miners`,
      
      `SELECT 
        COUNT(*) as blocks_found,
        SUM(reward) as total_rewards,
        MAX(timestamp) as last_block_time
      FROM blocks
      WHERE confirmed = true`
    ];

    const windowTime = Date.now() - (3600 * 1000);
    const activeWindowTime = Date.now() - (600 * 1000);

    const [shareResult, minerResult, blockResult] = await Promise.all([
      this.client!.query(queries[0], [windowTime]),
      this.client!.query(queries[1], [activeWindowTime]),
      this.client!.query(queries[2])
    ]);

    const shareStats = shareResult.rows[0];
    const minerStats = minerResult.rows[0];
    const blockStats = blockResult.rows[0];

    return {
      totalShares: parseInt(shareStats?.total_shares || 0),
      validShares: parseInt(shareStats?.valid_shares || 0),
      invalidShares: parseInt(shareStats?.invalid_shares || 0),
      totalMiners: parseInt(minerStats?.total_miners || 0),
      activeMiners: parseInt(minerStats?.active_miners || 0),
      poolHashrate: this.calculateHashrate(parseFloat(shareStats?.avg_difficulty || 0)) * parseInt(minerStats?.active_miners || 0),
      blocksFound: parseInt(blockStats?.blocks_found || 0),
      totalRewards: parseFloat(blockStats?.total_rewards || 0),
      lastBlockTime: blockStats?.last_block_time ? parseInt(blockStats.last_block_time) : undefined
    };
  }

  async beginTransaction(): Promise<void> {
    await this.client!.query('BEGIN');
  }

  async commitTransaction(): Promise<void> {
    await this.client!.query('COMMIT');
  }

  async rollbackTransaction(): Promise<void> {
    await this.client!.query('ROLLBACK');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.logger.info('PostgreSQL connection closed');
    }
  }

  private rowToShare(row: any): Share {
    return {
      id: row.id,
      minerId: row.miner_id,
      workerName: row.worker_name,
      jobId: row.job_id,
      nonce: row.nonce,
      extraNonce: row.extra_nonce,
      difficulty: parseFloat(row.difficulty),
      shareDifficulty: parseFloat(row.share_difficulty),
      hash: row.hash,
      timestamp: parseInt(row.timestamp),
      valid: row.valid,
      blockHeight: row.block_height,
      blockHash: row.block_hash,
      reward: row.reward ? parseFloat(row.reward) : undefined
    };
  }

  private calculateHashrate(avgDifficulty: number): number {
    // Assuming 1 share per second average
    return avgDifficulty * Math.pow(2, 32);
  }
}

// ===== DATABASE FACTORY =====
export class ShareDatabaseFactory {
  static create(config: DatabaseConfig): BaseDatabase {
    switch (config.type) {
      case 'sqlite':
        return new SQLiteShareDatabase(config.filename);
      case 'postgresql':
        if (!config.connectionString) {
          throw new Error('PostgreSQL requires connectionString');
        }
        return new PostgreSQLShareDatabase(config.connectionString);
      default:
        throw new Error(`Unsupported database type: ${config.type}`);
    }
  }
}
