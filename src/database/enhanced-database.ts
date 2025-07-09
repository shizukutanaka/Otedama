import { EventEmitter } from 'events';
import * as sqlite3 from 'sqlite3';
import { Client, Pool } from 'pg';
import { EnhancedLogger, DatabaseError } from '../core/error-handling';

/**
 * Enhanced Database System with PostgreSQL and SQLite support
 * Following Robert C. Martin's clean architecture principles
 * Implements proper connection pooling, transactions, and migrations
 */

// ===== Database Types and Interfaces =====
export interface DatabaseConfig {
  type: 'sqlite' | 'postgresql';
  // SQLite config
  filename?: string;
  // PostgreSQL config
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  // Common config
  poolSize?: number;
  connectionTimeout?: number;
  idleTimeout?: number;
}

export interface ShareRecord {
  id?: number;
  minerId: string;
  minerAddress: string;
  workerName?: string;
  hash: string;
  difficulty: number;
  shareDifficulty?: number;
  blockHeight: number;
  nonce: string;
  timestamp: number;
  valid: boolean;
  rewarded: boolean;
  blockHash?: string;
  extraNonce?: string;
  mixHash?: string;
}

export interface MinerRecord {
  id?: number;
  minerId: string;
  address: string;
  workerName?: string;
  email?: string;
  passwordHash?: string;
  lastSeen: number;
  totalShares: number;
  validShares: number;
  invalidShares: number;
  hashrate: number;
  balance: number;
  paidAmount: number;
  createdAt: number;
  updatedAt?: number;
  settings?: Record<string, any>;
}

export interface BlockRecord {
  id?: number;
  hash: string;
  height: number;
  timestamp: number;
  difficulty: number;
  reward: number;
  foundBy: string;
  confirmed: boolean;
  orphaned: boolean;
  transactionCount?: number;
  coinbaseHash?: string;
  createdAt: number;
}

export interface PaymentRecord {
  id?: number;
  txid: string;
  minerId: string;
  address: string;
  amount: number;
  fee?: number;
  timestamp: number;
  confirmed: boolean;
  blockHeight?: number;
  batchId?: string;
  createdAt: number;
}

// ===== Abstract Database Interface =====
export abstract class Database extends EventEmitter {
  protected logger: EnhancedLogger;
  protected connected = false;
  
  constructor(protected config: DatabaseConfig) {
    super();
    this.logger = EnhancedLogger.getInstance();
  }
  
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract beginTransaction(): Promise<any>;
  abstract commitTransaction(tx: any): Promise<void>;
  abstract rollbackTransaction(tx: any): Promise<void>;
  
  // Share operations
  abstract addShare(share: ShareRecord): Promise<number>;
  abstract addShareBatch(shares: ShareRecord[]): Promise<number[]>;
  abstract getShare(id: number): Promise<ShareRecord | null>;
  abstract getRecentShares(minerId: string, limit: number): Promise<ShareRecord[]>;
  abstract getSharesInRange(startTime: number, endTime: number): Promise<ShareRecord[]>;
  abstract markSharesRewarded(shareIds: number[]): Promise<void>;
  
  // Miner operations
  abstract upsertMiner(miner: MinerRecord): Promise<number>;
  abstract getMiner(minerId: string): Promise<MinerRecord | null>;
  abstract getMinerByAddress(address: string): Promise<MinerRecord | null>;
  abstract getActiveMiners(since: number): Promise<MinerRecord[]>;
  abstract updateMinerStats(minerId: string, stats: Partial<MinerRecord>): Promise<void>;
  abstract updateMinerBalance(minerId: string, amount: number): Promise<void>;
  
  // Block operations
  abstract addBlock(block: BlockRecord): Promise<number>;
  abstract getBlock(hash: string): Promise<BlockRecord | null>;
  abstract getRecentBlocks(limit: number): Promise<BlockRecord[]>;
  abstract markBlockOrphaned(hash: string): Promise<void>;
  abstract markBlockConfirmed(hash: string): Promise<void>;
  
  // Payment operations
  abstract addPayment(payment: PaymentRecord): Promise<number>;
  abstract addPaymentBatch(payments: PaymentRecord[]): Promise<number[]>;
  abstract getPayment(id: number): Promise<PaymentRecord | null>;
  abstract getMinerPayments(minerId: string, limit: number): Promise<PaymentRecord[]>;
  abstract getPendingPayments(): Promise<PaymentRecord[]>;
  abstract markPaymentConfirmed(txid: string): Promise<void>;
  
  // Stats operations
  abstract getPoolStats(windowHours: number): Promise<any>;
  abstract getMinerStats(minerId: string, windowHours: number): Promise<any>;
  
  // Cleanup operations
  abstract cleanOldShares(olderThan: number): Promise<number>;
  abstract cleanOldLogs(olderThan: number): Promise<number>;
}

// ===== SQLite Implementation =====
export class SQLiteDatabase extends Database {
  private db: sqlite3.Database | null = null;
  
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const filename = this.config.filename || './data/pool.db';
      
      this.db = new sqlite3.Database(filename, (err) => {
        if (err) {
          reject(new DatabaseError('Failed to connect to SQLite', { 
            additionalData: { error: err.message } 
          }));
        } else {
          this.connected = true;
          this.logger.info('Connected to SQLite database', { filename });
          this.initializeTables().then(resolve).catch(reject);
        }
      });
    });
  }
  
  private async initializeTables(): Promise<void> {
    const queries = [
      // Shares table
      `CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        miner_id TEXT NOT NULL,
        miner_address TEXT NOT NULL,
        worker_name TEXT,
        hash TEXT NOT NULL,
        difficulty REAL NOT NULL,
        share_difficulty REAL,
        block_height INTEGER NOT NULL,
        nonce TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        valid BOOLEAN NOT NULL,
        rewarded BOOLEAN DEFAULT FALSE,
        block_hash TEXT,
        extra_nonce TEXT,
        mix_hash TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        INDEX idx_miner_timestamp (miner_id, timestamp),
        INDEX idx_timestamp (timestamp),
        INDEX idx_rewarded (rewarded),
        INDEX idx_block_height (block_height)
      )`,
      
      // Miners table
      `CREATE TABLE IF NOT EXISTS miners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        miner_id TEXT UNIQUE NOT NULL,
        address TEXT NOT NULL,
        worker_name TEXT,
        email TEXT,
        password_hash TEXT,
        last_seen INTEGER NOT NULL,
        total_shares INTEGER DEFAULT 0,
        valid_shares INTEGER DEFAULT 0,
        invalid_shares INTEGER DEFAULT 0,
        hashrate REAL DEFAULT 0,
        balance REAL DEFAULT 0,
        paid_amount REAL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        settings TEXT,
        INDEX idx_address (address),
        INDEX idx_last_seen (last_seen)
      )`,
      
      // Blocks table
      `CREATE TABLE IF NOT EXISTS blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT UNIQUE NOT NULL,
        height INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        difficulty REAL NOT NULL,
        reward REAL NOT NULL,
        found_by TEXT NOT NULL,
        confirmed BOOLEAN DEFAULT FALSE,
        orphaned BOOLEAN DEFAULT FALSE,
        transaction_count INTEGER,
        coinbase_hash TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        INDEX idx_height (height),
        INDEX idx_timestamp (timestamp),
        INDEX idx_confirmed (confirmed)
      )`,
      
      // Payments table
      `CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        txid TEXT UNIQUE NOT NULL,
        miner_id TEXT NOT NULL,
        address TEXT NOT NULL,
        amount REAL NOT NULL,
        fee REAL,
        timestamp INTEGER NOT NULL,
        confirmed BOOLEAN DEFAULT FALSE,
        block_height INTEGER,
        batch_id TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        INDEX idx_miner_id (miner_id),
        INDEX idx_timestamp (timestamp),
        INDEX idx_confirmed (confirmed),
        INDEX idx_batch (batch_id)
      )`
    ];
    
    for (const query of queries) {
      await this.run(query);
    }
  }
  
  private run(sql: string, params: any[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db!.run(sql, params, (err) => {
        if (err) {
          reject(new DatabaseError('SQLite query failed', { 
            additionalData: { sql, error: err.message } 
          }));
        } else {
          resolve();
        }
      });
    });
  }
  
  private get<T>(sql: string, params: any[] = []): Promise<T | null> {
    return new Promise((resolve, reject) => {
      this.db!.get(sql, params, (err, row) => {
        if (err) {
          reject(new DatabaseError('SQLite query failed', { 
            additionalData: { sql, error: err.message } 
          }));
        } else {
          resolve(row as T || null);
        }
      });
    });
  }
  
  private all<T>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db!.all(sql, params, (err, rows) => {
        if (err) {
          reject(new DatabaseError('SQLite query failed', { 
            additionalData: { sql, error: err.message } 
          }));
        } else {
          resolve(rows as T[]);
        }
      });
    });
  }
  
  async disconnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) {
            reject(new DatabaseError('Failed to disconnect from SQLite', { 
              additionalData: { error: err.message } 
            }));
          } else {
            this.connected = false;
            this.db = null;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
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
  
  // Share operations
  async addShare(share: ShareRecord): Promise<number> {
    const sql = `
      INSERT INTO shares (
        miner_id, miner_address, worker_name, hash, difficulty, 
        share_difficulty, block_height, nonce, timestamp, valid, 
        rewarded, block_hash, extra_nonce, mix_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    await this.run(sql, [
      share.minerId, share.minerAddress, share.workerName, share.hash,
      share.difficulty, share.shareDifficulty, share.blockHeight,
      share.nonce, share.timestamp, share.valid ? 1 : 0,
      share.rewarded ? 1 : 0, share.blockHash, share.extraNonce, share.mixHash
    ]);
    
    const result = await this.get<{ id: number }>('SELECT last_insert_rowid() as id');
    return result!.id;
  }
  
  async addShareBatch(shares: ShareRecord[]): Promise<number[]> {
    const ids: number[] = [];
    await this.beginTransaction();
    
    try {
      for (const share of shares) {
        const id = await this.addShare(share);
        ids.push(id);
      }
      await this.commitTransaction();
      return ids;
    } catch (error) {
      await this.rollbackTransaction();
      throw error;
    }
  }
  
  async getShare(id: number): Promise<ShareRecord | null> {
    const sql = 'SELECT * FROM shares WHERE id = ?';
    return this.get<ShareRecord>(sql, [id]);
  }
  
  async getRecentShares(minerId: string, limit: number): Promise<ShareRecord[]> {
    const sql = `
      SELECT * FROM shares 
      WHERE miner_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `;
    return this.all<ShareRecord>(sql, [minerId, limit]);
  }
  
  async getSharesInRange(startTime: number, endTime: number): Promise<ShareRecord[]> {
    const sql = `
      SELECT * FROM shares 
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp DESC
    `;
    return this.all<ShareRecord>(sql, [startTime, endTime]);
  }
  
  async markSharesRewarded(shareIds: number[]): Promise<void> {
    const placeholders = shareIds.map(() => '?').join(',');
    const sql = `UPDATE shares SET rewarded = 1 WHERE id IN (${placeholders})`;
    await this.run(sql, shareIds);
  }
  
  // Miner operations
  async upsertMiner(miner: MinerRecord): Promise<number> {
    const sql = `
      INSERT INTO miners (
        miner_id, address, worker_name, email, password_hash,
        last_seen, total_shares, valid_shares, invalid_shares,
        hashrate, balance, paid_amount, created_at, settings
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(miner_id) DO UPDATE SET
        address = excluded.address,
        worker_name = excluded.worker_name,
        email = excluded.email,
        password_hash = excluded.password_hash,
        last_seen = excluded.last_seen,
        total_shares = excluded.total_shares,
        valid_shares = excluded.valid_shares,
        invalid_shares = excluded.invalid_shares,
        hashrate = excluded.hashrate,
        balance = excluded.balance,
        paid_amount = excluded.paid_amount,
        updated_at = strftime('%s', 'now') * 1000,
        settings = excluded.settings
    `;
    
    await this.run(sql, [
      miner.minerId, miner.address, miner.workerName, miner.email,
      miner.passwordHash, miner.lastSeen, miner.totalShares,
      miner.validShares, miner.invalidShares, miner.hashrate,
      miner.balance, miner.paidAmount, miner.createdAt,
      miner.settings ? JSON.stringify(miner.settings) : null
    ]);
    
    const result = await this.get<{ id: number }>('SELECT last_insert_rowid() as id');
    return result!.id;
  }
  
  async getMiner(minerId: string): Promise<MinerRecord | null> {
    const sql = 'SELECT * FROM miners WHERE miner_id = ?';
    const miner = await this.get<any>(sql, [minerId]);
    
    if (miner && miner.settings) {
      miner.settings = JSON.parse(miner.settings);
    }
    
    return miner;
  }
  
  async getMinerByAddress(address: string): Promise<MinerRecord | null> {
    const sql = 'SELECT * FROM miners WHERE address = ?';
    const miner = await this.get<any>(sql, [address]);
    
    if (miner && miner.settings) {
      miner.settings = JSON.parse(miner.settings);
    }
    
    return miner;
  }
  
  async getActiveMiners(since: number): Promise<MinerRecord[]> {
    const sql = 'SELECT * FROM miners WHERE last_seen > ? ORDER BY hashrate DESC';
    const miners = await this.all<any>(sql, [since]);
    
    return miners.map(miner => {
      if (miner.settings) {
        miner.settings = JSON.parse(miner.settings);
      }
      return miner;
    });
  }
  
  async updateMinerStats(minerId: string, stats: Partial<MinerRecord>): Promise<void> {
    const fields = Object.keys(stats)
      .filter(k => k !== 'minerId' && k !== 'id')
      .map(k => `${k} = ?`);
    
    if (fields.length === 0) return;
    
    const values = Object.keys(stats)
      .filter(k => k !== 'minerId' && k !== 'id')
      .map(k => (stats as any)[k]);
    
    const sql = `
      UPDATE miners 
      SET ${fields.join(', ')}, updated_at = strftime('%s', 'now') * 1000
      WHERE miner_id = ?
    `;
    
    await this.run(sql, [...values, minerId]);
  }
  
  async updateMinerBalance(minerId: string, amount: number): Promise<void> {
    const sql = `
      UPDATE miners 
      SET balance = balance + ?, updated_at = strftime('%s', 'now') * 1000
      WHERE miner_id = ?
    `;
    await this.run(sql, [amount, minerId]);
  }
  
  // Block operations
  async addBlock(block: BlockRecord): Promise<number> {
    const sql = `
      INSERT INTO blocks (
        hash, height, timestamp, difficulty, reward,
        found_by, confirmed, orphaned, transaction_count, coinbase_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    await this.run(sql, [
      block.hash, block.height, block.timestamp, block.difficulty,
      block.reward, block.foundBy, block.confirmed ? 1 : 0,
      block.orphaned ? 1 : 0, block.transactionCount, block.coinbaseHash
    ]);
    
    const result = await this.get<{ id: number }>('SELECT last_insert_rowid() as id');
    return result!.id;
  }
  
  async getBlock(hash: string): Promise<BlockRecord | null> {
    const sql = 'SELECT * FROM blocks WHERE hash = ?';
    return this.get<BlockRecord>(sql, [hash]);
  }
  
  async getRecentBlocks(limit: number): Promise<BlockRecord[]> {
    const sql = 'SELECT * FROM blocks ORDER BY height DESC LIMIT ?';
    return this.all<BlockRecord>(sql, [limit]);
  }
  
  async markBlockOrphaned(hash: string): Promise<void> {
    const sql = 'UPDATE blocks SET orphaned = 1 WHERE hash = ?';
    await this.run(sql, [hash]);
  }
  
  async markBlockConfirmed(hash: string): Promise<void> {
    const sql = 'UPDATE blocks SET confirmed = 1 WHERE hash = ?';
    await this.run(sql, [hash]);
  }
  
  // Payment operations
  async addPayment(payment: PaymentRecord): Promise<number> {
    const sql = `
      INSERT INTO payments (
        txid, miner_id, address, amount, fee,
        timestamp, confirmed, block_height, batch_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    await this.run(sql, [
      payment.txid, payment.minerId, payment.address, payment.amount,
      payment.fee, payment.timestamp, payment.confirmed ? 1 : 0,
      payment.blockHeight, payment.batchId
    ]);
    
    const result = await this.get<{ id: number }>('SELECT last_insert_rowid() as id');
    return result!.id;
  }
  
  async addPaymentBatch(payments: PaymentRecord[]): Promise<number[]> {
    const ids: number[] = [];
    await this.beginTransaction();
    
    try {
      for (const payment of payments) {
        const id = await this.addPayment(payment);
        ids.push(id);
      }
      await this.commitTransaction();
      return ids;
    } catch (error) {
      await this.rollbackTransaction();
      throw error;
    }
  }
  
  async getPayment(id: number): Promise<PaymentRecord | null> {
    const sql = 'SELECT * FROM payments WHERE id = ?';
    return this.get<PaymentRecord>(sql, [id]);
  }
  
  async getMinerPayments(minerId: string, limit: number): Promise<PaymentRecord[]> {
    const sql = `
      SELECT * FROM payments 
      WHERE miner_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `;
    return this.all<PaymentRecord>(sql, [minerId, limit]);
  }
  
  async getPendingPayments(): Promise<PaymentRecord[]> {
    const sql = 'SELECT * FROM payments WHERE confirmed = 0 ORDER BY timestamp';
    return this.all<PaymentRecord>(sql);
  }
  
  async markPaymentConfirmed(txid: string): Promise<void> {
    const sql = 'UPDATE payments SET confirmed = 1 WHERE txid = ?';
    await this.run(sql, [txid]);
  }
  
  // Stats operations
  async getPoolStats(windowHours: number): Promise<any> {
    const since = Date.now() - (windowHours * 3600 * 1000);
    
    const [shares, blocks, miners, payments] = await Promise.all([
      this.get<any>(`
        SELECT 
          COUNT(*) as total_shares,
          SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END) as valid_shares,
          SUM(CASE WHEN valid = 0 THEN 1 ELSE 0 END) as invalid_shares,
          AVG(difficulty) as avg_difficulty
        FROM shares WHERE timestamp > ?
      `, [since]),
      
      this.get<any>(`
        SELECT 
          COUNT(*) as total_blocks,
          SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) as confirmed_blocks,
          SUM(CASE WHEN orphaned = 1 THEN 1 ELSE 0 END) as orphaned_blocks,
          SUM(reward) as total_reward
        FROM blocks WHERE timestamp > ?
      `, [since]),
      
      this.get<any>(`
        SELECT 
          COUNT(*) as active_miners,
          SUM(hashrate) as total_hashrate,
          AVG(hashrate) as avg_hashrate
        FROM miners WHERE last_seen > ?
      `, [since]),
      
      this.get<any>(`
        SELECT 
          COUNT(*) as total_payments,
          SUM(amount) as total_paid,
          AVG(amount) as avg_payment
        FROM payments WHERE timestamp > ?
      `, [since])
    ]);
    
    return { shares, blocks, miners, payments };
  }
  
  async getMinerStats(minerId: string, windowHours: number): Promise<any> {
    const since = Date.now() - (windowHours * 3600 * 1000);
    
    const [shares, payments, blocks] = await Promise.all([
      this.get<any>(`
        SELECT 
          COUNT(*) as total_shares,
          SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END) as valid_shares,
          SUM(CASE WHEN valid = 0 THEN 1 ELSE 0 END) as invalid_shares,
          AVG(difficulty) as avg_difficulty
        FROM shares WHERE miner_id = ? AND timestamp > ?
      `, [minerId, since]),
      
      this.get<any>(`
        SELECT 
          COUNT(*) as total_payments,
          SUM(amount) as total_paid,
          MAX(timestamp) as last_payment
        FROM payments WHERE miner_id = ? AND timestamp > ?
      `, [minerId, since]),
      
      this.get<any>(`
        SELECT COUNT(*) as blocks_found
        FROM blocks WHERE found_by = ? AND timestamp > ?
      `, [minerId, since])
    ]);
    
    return { shares, payments, blocks };
  }
  
  // Cleanup operations
  async cleanOldShares(olderThan: number): Promise<number> {
    const sql = 'DELETE FROM shares WHERE timestamp < ? AND rewarded = 1';
    await this.run(sql, [olderThan]);
    
    const result = await this.get<{ changes: number }>('SELECT changes() as changes');
    return result!.changes;
  }
  
  async cleanOldLogs(olderThan: number): Promise<number> {
    // SQLite doesn't have logs table by default
    return 0;
  }
}

// ===== PostgreSQL Implementation =====
export class PostgreSQLDatabase extends Database {
  private pool: Pool | null = null;
  
  async connect(): Promise<void> {
    this.pool = new Pool({
      host: this.config.host || 'localhost',
      port: this.config.port || 5432,
      user: this.config.user || 'pooluser',
      password: this.config.password,
      database: this.config.database || 'miningpool',
      max: this.config.poolSize || 20,
      idleTimeoutMillis: this.config.idleTimeout || 30000,
      connectionTimeoutMillis: this.config.connectionTimeout || 2000,
    });
    
    try {
      await this.pool.query('SELECT NOW()');
      this.connected = true;
      this.logger.info('Connected to PostgreSQL database');
      await this.initializeTables();
    } catch (error) {
      throw new DatabaseError('Failed to connect to PostgreSQL', { 
        additionalData: { error } 
      });
    }
  }
  
  private async initializeTables(): Promise<void> {
    const queries = [
      // Shares table
      `CREATE TABLE IF NOT EXISTS shares (
        id SERIAL PRIMARY KEY,
        miner_id VARCHAR(255) NOT NULL,
        miner_address VARCHAR(255) NOT NULL,
        worker_name VARCHAR(255),
        hash VARCHAR(255) NOT NULL,
        difficulty DOUBLE PRECISION NOT NULL,
        share_difficulty DOUBLE PRECISION,
        block_height INTEGER NOT NULL,
        nonce VARCHAR(255) NOT NULL,
        timestamp BIGINT NOT NULL,
        valid BOOLEAN NOT NULL,
        rewarded BOOLEAN DEFAULT FALSE,
        block_hash VARCHAR(255),
        extra_nonce VARCHAR(255),
        mix_hash VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      
      // Indexes for shares
      `CREATE INDEX IF NOT EXISTS idx_shares_miner_timestamp ON shares(miner_id, timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_shares_timestamp ON shares(timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_shares_rewarded ON shares(rewarded)`,
      `CREATE INDEX IF NOT EXISTS idx_shares_block_height ON shares(block_height)`,
      
      // Miners table
      `CREATE TABLE IF NOT EXISTS miners (
        id SERIAL PRIMARY KEY,
        miner_id VARCHAR(255) UNIQUE NOT NULL,
        address VARCHAR(255) NOT NULL,
        worker_name VARCHAR(255),
        email VARCHAR(255),
        password_hash VARCHAR(255),
        last_seen BIGINT NOT NULL,
        total_shares INTEGER DEFAULT 0,
        valid_shares INTEGER DEFAULT 0,
        invalid_shares INTEGER DEFAULT 0,
        hashrate DOUBLE PRECISION DEFAULT 0,
        balance DOUBLE PRECISION DEFAULT 0,
        paid_amount DOUBLE PRECISION DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT,
        settings JSONB
      )`,
      
      // Indexes for miners
      `CREATE INDEX IF NOT EXISTS idx_miners_address ON miners(address)`,
      `CREATE INDEX IF NOT EXISTS idx_miners_last_seen ON miners(last_seen)`,
      
      // Blocks table
      `CREATE TABLE IF NOT EXISTS blocks (
        id SERIAL PRIMARY KEY,
        hash VARCHAR(255) UNIQUE NOT NULL,
        height INTEGER NOT NULL,
        timestamp BIGINT NOT NULL,
        difficulty DOUBLE PRECISION NOT NULL,
        reward DOUBLE PRECISION NOT NULL,
        found_by VARCHAR(255) NOT NULL,
        confirmed BOOLEAN DEFAULT FALSE,
        orphaned BOOLEAN DEFAULT FALSE,
        transaction_count INTEGER,
        coinbase_hash VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      
      // Indexes for blocks
      `CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height)`,
      `CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_blocks_confirmed ON blocks(confirmed)`,
      
      // Payments table
      `CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        txid VARCHAR(255) UNIQUE NOT NULL,
        miner_id VARCHAR(255) NOT NULL,
        address VARCHAR(255) NOT NULL,
        amount DOUBLE PRECISION NOT NULL,
        fee DOUBLE PRECISION,
        timestamp BIGINT NOT NULL,
        confirmed BOOLEAN DEFAULT FALSE,
        block_height INTEGER,
        batch_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      
      // Indexes for payments
      `CREATE INDEX IF NOT EXISTS idx_payments_miner_id ON payments(miner_id)`,
      `CREATE INDEX IF NOT EXISTS idx_payments_timestamp ON payments(timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_payments_confirmed ON payments(confirmed)`,
      `CREATE INDEX IF NOT EXISTS idx_payments_batch ON payments(batch_id)`
    ];
    
    for (const query of queries) {
      await this.pool!.query(query);
    }
  }
  
  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.connected = false;
      this.pool = null;
    }
  }
  
  async beginTransaction(): Promise<Client> {
    const client = await this.pool!.connect();
    await client.query('BEGIN');
    return client;
  }
  
  async commitTransaction(tx: Client): Promise<void> {
    await tx.query('COMMIT');
    tx.release();
  }
  
  async rollbackTransaction(tx: Client): Promise<void> {
    await tx.query('ROLLBACK');
    tx.release();
  }
  
  // Share operations
  async addShare(share: ShareRecord): Promise<number> {
    const query = `
      INSERT INTO shares (
        miner_id, miner_address, worker_name, hash, difficulty, 
        share_difficulty, block_height, nonce, timestamp, valid, 
        rewarded, block_hash, extra_nonce, mix_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id
    `;
    
    const result = await this.pool!.query(query, [
      share.minerId, share.minerAddress, share.workerName, share.hash,
      share.difficulty, share.shareDifficulty, share.blockHeight,
      share.nonce, share.timestamp, share.valid,
      share.rewarded, share.blockHash, share.extraNonce, share.mixHash
    ]);
    
    return result.rows[0].id;
  }
  
  async addShareBatch(shares: ShareRecord[]): Promise<number[]> {
    const client = await this.beginTransaction();
    const ids: number[] = [];
    
    try {
      for (const share of shares) {
        const query = `
          INSERT INTO shares (
            miner_id, miner_address, worker_name, hash, difficulty, 
            share_difficulty, block_height, nonce, timestamp, valid, 
            rewarded, block_hash, extra_nonce, mix_hash
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          RETURNING id
        `;
        
        const result = await client.query(query, [
          share.minerId, share.minerAddress, share.workerName, share.hash,
          share.difficulty, share.shareDifficulty, share.blockHeight,
          share.nonce, share.timestamp, share.valid,
          share.rewarded, share.blockHash, share.extraNonce, share.mixHash
        ]);
        
        ids.push(result.rows[0].id);
      }
      
      await this.commitTransaction(client);
      return ids;
    } catch (error) {
      await this.rollbackTransaction(client);
      throw error;
    }
  }
  
  async getShare(id: number): Promise<ShareRecord | null> {
    const query = 'SELECT * FROM shares WHERE id = $1';
    const result = await this.pool!.query(query, [id]);
    return result.rows[0] || null;
  }
  
  async getRecentShares(minerId: string, limit: number): Promise<ShareRecord[]> {
    const query = `
      SELECT * FROM shares 
      WHERE miner_id = $1 
      ORDER BY timestamp DESC 
      LIMIT $2
    `;
    const result = await this.pool!.query(query, [minerId, limit]);
    return result.rows;
  }
  
  async getSharesInRange(startTime: number, endTime: number): Promise<ShareRecord[]> {
    const query = `
      SELECT * FROM shares 
      WHERE timestamp >= $1 AND timestamp <= $2
      ORDER BY timestamp DESC
    `;
    const result = await this.pool!.query(query, [startTime, endTime]);
    return result.rows;
  }
  
  async markSharesRewarded(shareIds: number[]): Promise<void> {
    const query = `UPDATE shares SET rewarded = TRUE WHERE id = ANY($1)`;
    await this.pool!.query(query, [shareIds]);
  }
  
  // Miner operations
  async upsertMiner(miner: MinerRecord): Promise<number> {
    const query = `
      INSERT INTO miners (
        miner_id, address, worker_name, email, password_hash,
        last_seen, total_shares, valid_shares, invalid_shares,
        hashrate, balance, paid_amount, created_at, settings
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (miner_id) DO UPDATE SET
        address = EXCLUDED.address,
        worker_name = EXCLUDED.worker_name,
        email = EXCLUDED.email,
        password_hash = EXCLUDED.password_hash,
        last_seen = EXCLUDED.last_seen,
        total_shares = EXCLUDED.total_shares,
        valid_shares = EXCLUDED.valid_shares,
        invalid_shares = EXCLUDED.invalid_shares,
        hashrate = EXCLUDED.hashrate,
        balance = EXCLUDED.balance,
        paid_amount = EXCLUDED.paid_amount,
        updated_at = EXTRACT(EPOCH FROM NOW()) * 1000,
        settings = EXCLUDED.settings
      RETURNING id
    `;
    
    const result = await this.pool!.query(query, [
      miner.minerId, miner.address, miner.workerName, miner.email,
      miner.passwordHash, miner.lastSeen, miner.totalShares,
      miner.validShares, miner.invalidShares, miner.hashrate,
      miner.balance, miner.paidAmount, miner.createdAt,
      miner.settings || null
    ]);
    
    return result.rows[0].id;
  }
  
  async getMiner(minerId: string): Promise<MinerRecord | null> {
    const query = 'SELECT * FROM miners WHERE miner_id = $1';
    const result = await this.pool!.query(query, [minerId]);
    return result.rows[0] || null;
  }
  
  async getMinerByAddress(address: string): Promise<MinerRecord | null> {
    const query = 'SELECT * FROM miners WHERE address = $1';
    const result = await this.pool!.query(query, [address]);
    return result.rows[0] || null;
  }
  
  async getActiveMiners(since: number): Promise<MinerRecord[]> {
    const query = 'SELECT * FROM miners WHERE last_seen > $1 ORDER BY hashrate DESC';
    const result = await this.pool!.query(query, [since]);
    return result.rows;
  }
  
  async updateMinerStats(minerId: string, stats: Partial<MinerRecord>): Promise<void> {
    const fields = Object.keys(stats)
      .filter(k => k !== 'minerId' && k !== 'id')
      .map((k, i) => `${k} = $${i + 2}`);
    
    if (fields.length === 0) return;
    
    const values = Object.keys(stats)
      .filter(k => k !== 'minerId' && k !== 'id')
      .map(k => (stats as any)[k]);
    
    const query = `
      UPDATE miners 
      SET ${fields.join(', ')}, updated_at = EXTRACT(EPOCH FROM NOW()) * 1000
      WHERE miner_id = $1
    `;
    
    await this.pool!.query(query, [minerId, ...values]);
  }
  
  async updateMinerBalance(minerId: string, amount: number): Promise<void> {
    const query = `
      UPDATE miners 
      SET balance = balance + $2, updated_at = EXTRACT(EPOCH FROM NOW()) * 1000
      WHERE miner_id = $1
    `;
    await this.pool!.query(query, [minerId, amount]);
  }
  
  // Block operations
  async addBlock(block: BlockRecord): Promise<number> {
    const query = `
      INSERT INTO blocks (
        hash, height, timestamp, difficulty, reward,
        found_by, confirmed, orphaned, transaction_count, coinbase_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `;
    
    const result = await this.pool!.query(query, [
      block.hash, block.height, block.timestamp, block.difficulty,
      block.reward, block.foundBy, block.confirmed,
      block.orphaned, block.transactionCount, block.coinbaseHash
    ]);
    
    return result.rows[0].id;
  }
  
  async getBlock(hash: string): Promise<BlockRecord | null> {
    const query = 'SELECT * FROM blocks WHERE hash = $1';
    const result = await this.pool!.query(query, [hash]);
    return result.rows[0] || null;
  }
  
  async getRecentBlocks(limit: number): Promise<BlockRecord[]> {
    const query = 'SELECT * FROM blocks ORDER BY height DESC LIMIT $1';
    const result = await this.pool!.query(query, [limit]);
    return result.rows;
  }
  
  async markBlockOrphaned(hash: string): Promise<void> {
    const query = 'UPDATE blocks SET orphaned = TRUE WHERE hash = $1';
    await this.pool!.query(query, [hash]);
  }
  
  async markBlockConfirmed(hash: string): Promise<void> {
    const query = 'UPDATE blocks SET confirmed = TRUE WHERE hash = $1';
    await this.pool!.query(query, [hash]);
  }
  
  // Payment operations
  async addPayment(payment: PaymentRecord): Promise<number> {
    const query = `
      INSERT INTO payments (
        txid, miner_id, address, amount, fee,
        timestamp, confirmed, block_height, batch_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `;
    
    const result = await this.pool!.query(query, [
      payment.txid, payment.minerId, payment.address, payment.amount,
      payment.fee, payment.timestamp, payment.confirmed,
      payment.blockHeight, payment.batchId
    ]);
    
    return result.rows[0].id;
  }
  
  async addPaymentBatch(payments: PaymentRecord[]): Promise<number[]> {
    const client = await this.beginTransaction();
    const ids: number[] = [];
    
    try {
      for (const payment of payments) {
        const query = `
          INSERT INTO payments (
            txid, miner_id, address, amount, fee,
            timestamp, confirmed, block_height, batch_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id
        `;
        
        const result = await client.query(query, [
          payment.txid, payment.minerId, payment.address, payment.amount,
          payment.fee, payment.timestamp, payment.confirmed,
          payment.blockHeight, payment.batchId
        ]);
        
        ids.push(result.rows[0].id);
      }
      
      await this.commitTransaction(client);
      return ids;
    } catch (error) {
      await this.rollbackTransaction(client);
      throw error;
    }
  }
  
  async getPayment(id: number): Promise<PaymentRecord | null> {
    const query = 'SELECT * FROM payments WHERE id = $1';
    const result = await this.pool!.query(query, [id]);
    return result.rows[0] || null;
  }
  
  async getMinerPayments(minerId: string, limit: number): Promise<PaymentRecord[]> {
    const query = `
      SELECT * FROM payments 
      WHERE miner_id = $1 
      ORDER BY timestamp DESC 
      LIMIT $2
    `;
    const result = await this.pool!.query(query, [minerId, limit]);
    return result.rows;
  }
  
  async getPendingPayments(): Promise<PaymentRecord[]> {
    const query = 'SELECT * FROM payments WHERE confirmed = FALSE ORDER BY timestamp';
    const result = await this.pool!.query(query);
    return result.rows;
  }
  
  async markPaymentConfirmed(txid: string): Promise<void> {
    const query = 'UPDATE payments SET confirmed = TRUE WHERE txid = $1';
    await this.pool!.query(query, [txid]);
  }
  
  // Stats operations
  async getPoolStats(windowHours: number): Promise<any> {
    const since = Date.now() - (windowHours * 3600 * 1000);
    
    const queries = {
      shares: `
        SELECT 
          COUNT(*) as total_shares,
          SUM(CASE WHEN valid = TRUE THEN 1 ELSE 0 END) as valid_shares,
          SUM(CASE WHEN valid = FALSE THEN 1 ELSE 0 END) as invalid_shares,
          AVG(difficulty) as avg_difficulty
        FROM shares WHERE timestamp > $1
      `,
      blocks: `
        SELECT 
          COUNT(*) as total_blocks,
          SUM(CASE WHEN confirmed = TRUE THEN 1 ELSE 0 END) as confirmed_blocks,
          SUM(CASE WHEN orphaned = TRUE THEN 1 ELSE 0 END) as orphaned_blocks,
          SUM(reward) as total_reward
        FROM blocks WHERE timestamp > $1
      `,
      miners: `
        SELECT 
          COUNT(*) as active_miners,
          SUM(hashrate) as total_hashrate,
          AVG(hashrate) as avg_hashrate
        FROM miners WHERE last_seen > $1
      `,
      payments: `
        SELECT 
          COUNT(*) as total_payments,
          SUM(amount) as total_paid,
          AVG(amount) as avg_payment
        FROM payments WHERE timestamp > $1
      `
    };
    
    const [shares, blocks, miners, payments] = await Promise.all([
      this.pool!.query(queries.shares, [since]),
      this.pool!.query(queries.blocks, [since]),
      this.pool!.query(queries.miners, [since]),
      this.pool!.query(queries.payments, [since])
    ]);
    
    return {
      shares: shares.rows[0],
      blocks: blocks.rows[0],
      miners: miners.rows[0],
      payments: payments.rows[0]
    };
  }
  
  async getMinerStats(minerId: string, windowHours: number): Promise<any> {
    const since = Date.now() - (windowHours * 3600 * 1000);
    
    const queries = {
      shares: `
        SELECT 
          COUNT(*) as total_shares,
          SUM(CASE WHEN valid = TRUE THEN 1 ELSE 0 END) as valid_shares,
          SUM(CASE WHEN valid = FALSE THEN 1 ELSE 0 END) as invalid_shares,
          AVG(difficulty) as avg_difficulty
        FROM shares WHERE miner_id = $1 AND timestamp > $2
      `,
      payments: `
        SELECT 
          COUNT(*) as total_payments,
          SUM(amount) as total_paid,
          MAX(timestamp) as last_payment
        FROM payments WHERE miner_id = $1 AND timestamp > $2
      `,
      blocks: `
        SELECT COUNT(*) as blocks_found
        FROM blocks WHERE found_by = $1 AND timestamp > $2
      `
    };
    
    const [shares, payments, blocks] = await Promise.all([
      this.pool!.query(queries.shares, [minerId, since]),
      this.pool!.query(queries.payments, [minerId, since]),
      this.pool!.query(queries.blocks, [minerId, since])
    ]);
    
    return {
      shares: shares.rows[0],
      payments: payments.rows[0],
      blocks: blocks.rows[0]
    };
  }
  
  // Cleanup operations
  async cleanOldShares(olderThan: number): Promise<number> {
    const query = 'DELETE FROM shares WHERE timestamp < $1 AND rewarded = TRUE';
    const result = await this.pool!.query(query, [olderThan]);
    return result.rowCount;
  }
  
  async cleanOldLogs(olderThan: number): Promise<number> {
    // PostgreSQL doesn't have logs table by default
    return 0;
  }
}

// ===== Database Factory =====
export class DatabaseFactory {
  static create(config: DatabaseConfig): Database {
    switch (config.type) {
      case 'sqlite':
        return new SQLiteDatabase(config);
      case 'postgresql':
        return new PostgreSQLDatabase(config);
      default:
        throw new Error(`Unsupported database type: ${config.type}`);
    }
  }
}