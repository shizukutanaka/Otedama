import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import { EventEmitter } from 'events';
import { getEventStore } from './event-store';
import { getEventDispatcher } from '../sagas/event-dispatcher';

/**
 * Database implementation for share and miner persistence
 * Following Clean Code principles: single responsibility, clear interfaces
 */

export interface ShareRecord {
  id?: number;
  minerId: string;
  minerAddress: string;
  hash: string;
  difficulty: number;
  blockHeight?: number;
  nonce: string;
  timestamp: number;
  valid: boolean;
  rewarded: boolean;
}

export interface MinerRecord {
  id?: number;
  minerId: string;
  address: string;
  workerName?: string;
  lastSeen: number;
  totalShares: number;
  validShares: number;
  invalidShares: number;
  hashrate: number;
  balance: number;
  paidAmount: number;
  createdAt: number;
}

export interface PaymentRecord {
  id?: number;
  minerId: string;
  amount: number;
  txHash?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: number;
  processedAt?: number;
  error?: string;
}

export class PoolDatabase extends EventEmitter {
  private db: Database | null = null;
  private readonly dbPath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private pendingShares: ShareRecord[] = [];

  constructor(dbPath?: string) {
    super();
    this.dbPath = dbPath || path.join(process.cwd(), 'data', 'pool.db');
  }

  async initialize(): Promise<void> {
    // Ensure data directory exists
    const dataDir = path.dirname(this.dbPath);
    const fs = await import('fs/promises');
    await fs.mkdir(dataDir, { recursive: true });

    // Open database
    this.db = await open({
      filename: this.dbPath,
      driver: sqlite3.Database
    });

    // Enable foreign keys and WAL mode for better performance
    await this.db.exec('PRAGMA foreign_keys = ON');
    await this.db.exec('PRAGMA journal_mode = WAL');
    await this.db.exec('PRAGMA synchronous = NORMAL');

    // Create tables
    await this.createTables();
    
    // Initialize the Event Store
    await getEventStore().initialize();

    // Start batch save timer
    this.startBatchSaveTimer();
  }

  private async createTables(): Promise<void> {
    // Miners table
    await this.db!.exec(`
      CREATE TABLE IF NOT EXISTS miners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        miner_id TEXT UNIQUE NOT NULL,
        address TEXT NOT NULL,
        worker_name TEXT,
        last_seen INTEGER NOT NULL,
        total_shares INTEGER DEFAULT 0,
        valid_shares INTEGER DEFAULT 0,
        invalid_shares INTEGER DEFAULT 0,
        hashrate REAL DEFAULT 0,
        balance REAL DEFAULT 0,
        paid_amount REAL DEFAULT 0,
        created_at INTEGER NOT NULL,
        INDEX idx_miners_address (address),
        INDEX idx_miners_last_seen (last_seen)
      )
    `);

    // Shares table
    await this.db!.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        miner_id TEXT NOT NULL,
        miner_address TEXT NOT NULL,
        hash TEXT NOT NULL,
        difficulty REAL NOT NULL,
        block_height INTEGER,
        nonce TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        valid INTEGER NOT NULL,
        rewarded INTEGER DEFAULT 0,
        INDEX idx_shares_miner (miner_id),
        INDEX idx_shares_timestamp (timestamp),
        INDEX idx_shares_valid (valid),
        INDEX idx_shares_rewarded (rewarded)
      )
    `);

    // Payments table
    await this.db!.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        miner_id TEXT NOT NULL,
        amount REAL NOT NULL,
        tx_hash TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        processed_at INTEGER,
        error TEXT,
        INDEX idx_payments_miner (miner_id),
        INDEX idx_payments_status (status),
        INDEX idx_payments_created (created_at)
      )
    `);

    // Blocks table
    await this.db!.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        height INTEGER UNIQUE NOT NULL,
        hash TEXT NOT NULL,
        difficulty REAL NOT NULL,
        reward REAL NOT NULL,
        finder_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        confirmed INTEGER DEFAULT 0,
        INDEX idx_blocks_height (height),
        INDEX idx_blocks_finder (finder_id),
        INDEX idx_blocks_confirmed (confirmed)
      )
    `);

    // Statistics table
    await this.db!.exec(`
      CREATE TABLE IF NOT EXISTS pool_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        hashrate REAL NOT NULL,
        miners_online INTEGER NOT NULL,
        difficulty REAL NOT NULL,
        blocks_found INTEGER NOT NULL,
        total_paid REAL NOT NULL,
        INDEX idx_stats_timestamp (timestamp)
      )
    `);
  }

  // Miner operations
  // Miner operations
  async upsertMiner(miner: MinerRecord): Promise<void> {
    // Event Sourcing: First, record the event
    const eventStore = getEventStore();
    const currentVersion = await eventStore.getCurrentVersion(miner.minerId);
    const event = await eventStore.appendEvent(
      miner.minerId,
      'MinerUpserted',
      miner, // The payload is the full miner record
      currentVersion
    );
    getEventDispatcher().dispatch(event);

    // For now, we still update the read model (the miners table) directly.
    // In a full CQRS system, this would be handled by a separate projector.

    const query = `
      INSERT INTO miners (
        miner_id, address, worker_name, last_seen, total_shares,
        valid_shares, invalid_shares, hashrate, balance, paid_amount, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(miner_id) DO UPDATE SET
        address = excluded.address,
        worker_name = excluded.worker_name,
        last_seen = excluded.last_seen,
        total_shares = excluded.total_shares,
        valid_shares = excluded.valid_shares,
        invalid_shares = excluded.invalid_shares,
        hashrate = excluded.hashrate,
        balance = excluded.balance,
        paid_amount = excluded.paid_amount
    `;

    await this.db!.run(query, [
      miner.minerId,
      miner.address,
      miner.workerName,
      miner.lastSeen,
      miner.totalShares,
      miner.validShares,
      miner.invalidShares,
      miner.hashrate,
      miner.balance,
      miner.paidAmount,
      miner.createdAt || Date.now()
    ]);
  }

  async getMiner(minerId: string): Promise<MinerRecord | null> {
    const row = await this.db!.get(
      'SELECT * FROM miners WHERE miner_id = ?',
      minerId
    );

    if (!row) return null;

    return this.rowToMiner(row);
  }

  async getMinerFromEvents(minerId: string): Promise<MinerRecord | null> {
    const eventStore = getEventStore();
    const events = await eventStore.getEventsForStream(minerId);

    if (events.length === 0) {
      return null;
    }

    // Replay events to reconstruct the state
    let minerState: Partial<MinerRecord> = {};

    for (const event of events) {
      switch (event.eventType) {
        case 'MinerUpserted':
          minerState = { ...minerState, ...event.payload };
          break;
        case 'ShareSubmitted':
          minerState.totalShares = (minerState.totalShares || 0) + 1;
          if (event.payload.valid) {
            minerState.validShares = (minerState.validShares || 0) + 1;
          } else {
            minerState.invalidShares = (minerState.invalidShares || 0) + 1;
          }
          minerState.lastSeen = event.payload.timestamp;
          break;
        // Other miner-related events would be handled here
      }
    }

    return minerState as MinerRecord;
  }

  async getActiveMiners(since: number): Promise<MinerRecord[]> {
    const rows = await this.db!.all(
      'SELECT * FROM miners WHERE last_seen > ? ORDER BY hashrate DESC',
      since
    );

    return rows.map(row => this.rowToMiner(row));
  }

  // Share operations with batching
  async addShare(share: ShareRecord): Promise<void> {
    // Event Sourcing: Record the share submission event immediately.
    const eventStore = getEventStore();
    // The stream for shares will be the miner's ID.
    const currentVersion = await eventStore.getCurrentVersion(share.minerId);
    const event = await eventStore.appendEvent(
      share.minerId, 
      'ShareSubmitted',
      share, // The payload is the full share record
      currentVersion
    );
    getEventDispatcher().dispatch(event);

    // The existing batching mechanism now only serves to update the read model.

    this.pendingShares.push(share);
    
    // Force save if too many pending shares
    if (this.pendingShares.length >= 100) {
      await this.flushShares();
    }
  }

  private async flushShares(): Promise<void> {
    if (this.pendingShares.length === 0) return;

    const shares = [...this.pendingShares];
    this.pendingShares = [];

    const query = `
      INSERT INTO shares (
        miner_id, miner_address, hash, difficulty, block_height,
        nonce, timestamp, valid, rewarded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const stmt = await this.db!.prepare(query);
    
    try {
      await this.db!.run('BEGIN TRANSACTION');
      
      for (const share of shares) {
        await stmt.run([
          share.minerId,
          share.minerAddress,
          share.hash,
          share.difficulty,
          share.blockHeight,
          share.nonce,
          share.timestamp,
          share.valid ? 1 : 0,
          share.rewarded ? 1 : 0
        ]);
      }
      
      await this.db!.run('COMMIT');
      this.emit('sharesFlushed', shares.length);
    } catch (error) {
      await this.db!.run('ROLLBACK');
      throw error;
    } finally {
      await stmt.finalize();
    }
  }

  async getRecentShares(minerId: string, limit: number = 100): Promise<ShareRecord[]> {
    const rows = await this.db!.all(
      'SELECT * FROM shares WHERE miner_id = ? ORDER BY timestamp DESC LIMIT ?',
      [minerId, limit]
    );

    return rows.map(row => this.rowToShare(row));
  }

  async getSharesForPPLNS(window: number): Promise<ShareRecord[]> {
    const since = Date.now() - window;
    const rows = await this.db!.all(
      'SELECT * FROM shares WHERE timestamp > ? AND valid = 1 AND rewarded = 0 ORDER BY timestamp DESC',
      since
    );

    return rows.map(row => this.rowToShare(row));
  }

  // Payment operations
  async createPayment(payment: PaymentRecord): Promise<number> {
    const result = await this.db!.run(
      `INSERT INTO payments (miner_id, amount, status, created_at)
       VALUES (?, ?, ?, ?)`,
      [payment.minerId, payment.amount, payment.status, payment.createdAt]
    );

    const paymentId = result.lastID!;

    // Event Sourcing: Record the payment creation event.
    const eventStore = getEventStore();
    // The stream ID is the unique payment ID.
    const event = await eventStore.appendEvent(
      `payment-${paymentId}`,
      'PaymentCreated',
      { ...payment, id: paymentId },
      0 // Initial version is 0
    );
    getEventDispatcher().dispatch(event);

    return paymentId;
  }

  async updatePayment(id: number, update: Partial<PaymentRecord>): Promise<void> {
    // Event Sourcing: Record the payment update event.
    const eventStore = getEventStore();
    const streamId = `payment-${id}`;
    const currentVersion = await eventStore.getCurrentVersion(streamId);

    let eventType = 'PaymentUpdated'; // Default event type
    if (update.status) {
      switch (update.status) {
        case 'processing': eventType = 'PaymentProcessing'; break;
        case 'completed': eventType = 'PaymentCompleted'; break;
        case 'failed': eventType = 'PaymentFailed'; break;
      }
    }

    const event = await eventStore.appendEvent(
      streamId,
      eventType,
      update, // The payload is the update object itself
      currentVersion
    );
    getEventDispatcher().dispatch(event);

    // Continue to update the read model directly.

    const fields: string[] = [];
    const values: any[] = [];

    if (update.txHash !== undefined) {
      fields.push('tx_hash = ?');
      values.push(update.txHash);
    }
    if (update.status !== undefined) {
      fields.push('status = ?');
      values.push(update.status);
    }
    if (update.processedAt !== undefined) {
      fields.push('processed_at = ?');
      values.push(update.processedAt);
    }
    if (update.error !== undefined) {
      fields.push('error = ?');
      values.push(update.error);
    }

    if (fields.length === 0) return;

    values.push(id);
    await this.db!.run(
      `UPDATE payments SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
  }

  async getPendingPayments(): Promise<PaymentRecord[]> {
    const rows = await this.db!.all(
      'SELECT * FROM payments WHERE status = ? ORDER BY created_at',
      'pending'
    );

    return rows.map(row => this.rowToPayment(row));
  }

  // Statistics
  async savePoolStats(stats: {
    hashrate: number;
    minersOnline: number;
    difficulty: number;
    blocksFound: number;
    totalPaid: number;
  }): Promise<void> {
    await this.db!.run(
      `INSERT INTO pool_stats (timestamp, hashrate, miners_online, difficulty, blocks_found, total_paid)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [Date.now(), stats.hashrate, stats.minersOnline, stats.difficulty, stats.blocksFound, stats.totalPaid]
    );
  }

  async getPoolStats(since: number): Promise<any[]> {
    return await this.db!.all(
      'SELECT * FROM pool_stats WHERE timestamp > ? ORDER BY timestamp',
      since
    );
  }

  // Utility methods
  private startBatchSaveTimer(): void {
    this.saveTimer = setInterval(async () => {
      try {
        await this.flushShares();
      } catch (error) {
        this.emit('error', error);
      }
    }, 5000); // Flush every 5 seconds
  }

  async close(): Promise<void> {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
    }

    await this.flushShares();

    if (this.db) {
      await this.db.close();
    }

    // Close the event store connection
    await getEventStore().close();
  }

  // Row conversion helpers
  private rowToMiner(row: any): MinerRecord {
    return {
      id: row.id,
      minerId: row.miner_id,
      address: row.address,
      workerName: row.worker_name,
      lastSeen: row.last_seen,
      totalShares: row.total_shares,
      validShares: row.valid_shares,
      invalidShares: row.invalid_shares,
      hashrate: row.hashrate,
      balance: row.balance,
      paidAmount: row.paid_amount,
      createdAt: row.created_at
    };
  }

  private rowToShare(row: any): ShareRecord {
    return {
      id: row.id,
      minerId: row.miner_id,
      minerAddress: row.miner_address,
      hash: row.hash,
      difficulty: row.difficulty,
      blockHeight: row.block_height,
      nonce: row.nonce,
      timestamp: row.timestamp,
      valid: row.valid === 1,
      rewarded: row.rewarded === 1
    };
  }

  private rowToPayment(row: any): PaymentRecord {
    return {
      id: row.id,
      minerId: row.miner_id,
      amount: row.amount,
      txHash: row.tx_hash,
      status: row.status,
      createdAt: row.created_at,
      processedAt: row.processed_at,
      error: row.error
    };
  }
}

// Singleton instance
let poolDatabase: PoolDatabase | null = null;

export function getPoolDatabase(): PoolDatabase {
  if (!poolDatabase) {
    poolDatabase = new PoolDatabase();
  }
  return poolDatabase;
}
