/**
 * Simple Database Layer - SQLite for persistence
 * Design: Simple, Fast, Reliable (Pike + Carmack approach)
 */

import * as sqlite3 from 'sqlite3';
import { Database, open } from 'sqlite';
import * as path from 'path';
import * as fs from 'fs';

interface ShareRecord {
  id?: number;
  minerId: string;
  nonce: string;
  timestamp: number;
  difficulty: number;
  valid: boolean;
  blockHeight?: number;
}

interface MinerRecord {
  id: string;
  address: string;
  totalShares: number;
  validShares: number;
  lastActivity: number;
  totalPaid: number;
}

interface PoolStats {
  totalMiners: number;
  activeMiners: number;
  totalShares: number;
  validShares: number;
  blocksFound: number;
  totalPaid: number;
}

class SimpleDatabase {
  private db: Database | null = null;
  private dataDir: string;
  private dbPath: string;
  
  constructor(dataDir: string = './data') {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'pool.db');
    
    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }
  
  async connect(): Promise<void> {
    try {
      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database
      });
      
      // Enable WAL mode for better performance
      await this.db.exec('PRAGMA journal_mode = WAL');
      await this.db.exec('PRAGMA synchronous = NORMAL');
      await this.db.exec('PRAGMA cache_size = 1000');
      await this.db.exec('PRAGMA temp_store = MEMORY');
      
      await this.createTables();
      console.log('Database connected:', this.dbPath);
    } catch (error) {
      console.error('Database connection failed:', error);
      throw error;
    }
  }
  
  private async createTables(): Promise<void> {
    if (!this.db) throw new Error('Database not connected');
    
    // Shares table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        minerId TEXT NOT NULL,
        nonce TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        difficulty REAL NOT NULL,
        valid INTEGER NOT NULL,
        blockHeight INTEGER
      )
    `);
    
    // Miners table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS miners (
        id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        totalShares INTEGER DEFAULT 0,
        validShares INTEGER DEFAULT 0,
        lastActivity INTEGER NOT NULL,
        totalPaid REAL DEFAULT 0
      )
    `);
    
    // Pool statistics table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS pool_stats (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        totalMiners INTEGER DEFAULT 0,
        activeMiners INTEGER DEFAULT 0,
        totalShares INTEGER DEFAULT 0,
        validShares INTEGER DEFAULT 0,
        blocksFound INTEGER DEFAULT 0,
        totalPaid REAL DEFAULT 0,
        lastUpdated INTEGER NOT NULL
      )
    `);
    
    // Create indexes for performance
    await this.db.exec('CREATE INDEX IF NOT EXISTS idx_shares_miner ON shares(minerId)');
    await this.db.exec('CREATE INDEX IF NOT EXISTS idx_shares_timestamp ON shares(timestamp)');
    await this.db.exec('CREATE INDEX IF NOT EXISTS idx_shares_valid ON shares(valid)');
    await this.db.exec('CREATE INDEX IF NOT EXISTS idx_miners_activity ON miners(lastActivity)');
    
    // Initialize pool stats if not exists
    await this.db.exec(`
      INSERT OR IGNORE INTO pool_stats (id, lastUpdated) 
      VALUES (1, ${Date.now()})
    `);
  }
  
  async saveShare(share: ShareRecord): Promise<void> {
    if (!this.db) throw new Error('Database not connected');
    
    try {
      await this.db.run(`
        INSERT INTO shares (minerId, nonce, timestamp, difficulty, valid, blockHeight)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        share.minerId,
        share.nonce,
        share.timestamp,
        share.difficulty,
        share.valid ? 1 : 0,
        share.blockHeight
      ]);
      
      // Update miner statistics
      await this.updateMinerStats(share.minerId, share.valid, share.timestamp);
      
    } catch (error) {
      console.error('Failed to save share:', error);
      throw error;
    }
  }
  
  private async updateMinerStats(minerId: string, valid: boolean, timestamp: number): Promise<void> {
    if (!this.db) throw new Error('Database not connected');
    
    // Upsert miner record
    await this.db.run(`
      INSERT INTO miners (id, address, totalShares, validShares, lastActivity)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        totalShares = totalShares + 1,
        validShares = validShares + ?,
        lastActivity = ?
    `, [
      minerId,
      minerId, // Use minerId as address for now
      valid ? 1 : 0,
      timestamp,
      valid ? 1 : 0,
      timestamp
    ]);
  }
  
  async getMiner(minerId: string): Promise<MinerRecord | null> {
    if (!this.db) throw new Error('Database not connected');
    
    const row = await this.db.get(
      'SELECT * FROM miners WHERE id = ?',
      [minerId]
    );
    
    return row || null;
  }
  
  async getActiveMiners(since: number = Date.now() - 300000): Promise<MinerRecord[]> {
    if (!this.db) throw new Error('Database not connected');
    
    return await this.db.all(
      'SELECT * FROM miners WHERE lastActivity > ? ORDER BY validShares DESC',
      [since]
    );
  }
  
  async getRecentShares(minerId: string, hours: number = 24): Promise<ShareRecord[]> {
    if (!this.db) throw new Error('Database not connected');
    
    const since = Date.now() - (hours * 60 * 60 * 1000);
    return await this.db.all(
      'SELECT * FROM shares WHERE minerId = ? AND timestamp > ? ORDER BY timestamp DESC',
      [minerId, since]
    );
  }
  
  async getPoolStats(): Promise<PoolStats> {
    if (!this.db) throw new Error('Database not connected');
    
    // Calculate current stats
    const totalMiners = await this.db.get('SELECT COUNT(*) as count FROM miners');
    const activeMiners = await this.db.get(
      'SELECT COUNT(*) as count FROM miners WHERE lastActivity > ?',
      [Date.now() - 300000]
    );
    const totalShares = await this.db.get('SELECT COUNT(*) as count FROM shares');
    const validShares = await this.db.get('SELECT COUNT(*) as count FROM shares WHERE valid = 1');
    const blocksFound = await this.db.get('SELECT COUNT(*) as count FROM shares WHERE blockHeight IS NOT NULL');
    const totalPaid = await this.db.get('SELECT SUM(totalPaid) as total FROM miners');
    
    const stats: PoolStats = {
      totalMiners: totalMiners?.count || 0,
      activeMiners: activeMiners?.count || 0,
      totalShares: totalShares?.count || 0,
      validShares: validShares?.count || 0,
      blocksFound: blocksFound?.count || 0,
      totalPaid: totalPaid?.total || 0
    };
    
    // Update cached stats
    await this.db.run(`
      UPDATE pool_stats SET
        totalMiners = ?,
        activeMiners = ?,
        totalShares = ?,
        validShares = ?,
        blocksFound = ?,
        totalPaid = ?,
        lastUpdated = ?
      WHERE id = 1
    `, [
      stats.totalMiners,
      stats.activeMiners,
      stats.totalShares,
      stats.validShares,
      stats.blocksFound,
      stats.totalPaid,
      Date.now()
    ]);
    
    return stats;
  }
  
  async recordPayment(minerId: string, amount: number): Promise<void> {
    if (!this.db) throw new Error('Database not connected');
    
    await this.db.run(`
      UPDATE miners SET totalPaid = totalPaid + ? WHERE id = ?
    `, [amount, minerId]);
  }
  
  async cleanup(): Promise<void> {
    if (!this.db) throw new Error('Database not connected');
    
    // Remove shares older than 30 days
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    await this.db.run('DELETE FROM shares WHERE timestamp < ?', [thirtyDaysAgo]);
    
    // Remove inactive miners (no activity for 7 days)
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    await this.db.run('DELETE FROM miners WHERE lastActivity < ? AND validShares = 0', [sevenDaysAgo]);
    
    // Vacuum database
    await this.db.exec('VACUUM');
    
    console.log('Database cleanup completed');
  }
  
  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      console.log('Database connection closed');
    }
  }
  
  // Performance optimization: batch operations
  async saveSharesBatch(shares: ShareRecord[]): Promise<void> {
    if (!this.db) throw new Error('Database not connected');
    
    try {
      await this.db.exec('BEGIN TRANSACTION');
      
      const stmt = await this.db.prepare(`
        INSERT INTO shares (minerId, nonce, timestamp, difficulty, valid, blockHeight)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      for (const share of shares) {
        await stmt.run([
          share.minerId,
          share.nonce,
          share.timestamp,
          share.difficulty,
          share.valid ? 1 : 0,
          share.blockHeight
        ]);
      }
      
      await stmt.finalize();
      await this.db.exec('COMMIT');
      
      console.log(`Saved ${shares.length} shares in batch`);
    } catch (error) {
      await this.db.exec('ROLLBACK');
      console.error('Batch share save failed:', error);
      throw error;
    }
  }
}

// Singleton instance
let instance: SimpleDatabase | null = null;

export function getDatabase(dataDir?: string): SimpleDatabase {
  if (!instance) {
    instance = new SimpleDatabase(dataDir);
  }
  return instance;
}

export { SimpleDatabase, ShareRecord, MinerRecord, PoolStats };
