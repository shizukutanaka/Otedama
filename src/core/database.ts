/**
 * Simple Database Layer
 * 
 * Uncle Bob's Clean Architecture: Repository pattern with interfaces
 * Pike's Simplicity: Direct SQL, no ORM complexity
 * Carmack's Performance: Connection pooling, prepared statements
 */

import { Pool, PoolClient } from 'pg';
import { Share, Miner, Job, Block, Payout } from './entities';

export interface ShareRepository {
  save(share: Share): Promise<void>;
  getByMiner(minerId: string, limit: number): Promise<Share[]>;
  getRecentShares(minutes: number): Promise<Share[]>;
  deleteOld(days: number): Promise<number>;
}

export interface MinerRepository {
  save(miner: Miner): Promise<void>;
  findById(id: string): Promise<Miner | null>;
  updateStats(id: string, hashrate: number, sharesCount: number): Promise<void>;
  getActive(sinceMinutes: number): Promise<Miner[]>;
}

export interface JobRepository {
  save(job: Job): Promise<void>;
  findById(id: string): Promise<Job | null>;
  getCurrent(): Promise<Job | null>;
  deleteOld(hours: number): Promise<number>;
}

export interface BlockRepository {
  save(block: Block): Promise<void>;
  getRecent(limit: number): Promise<Block[]>;
  findByHeight(height: number): Promise<Block | null>;
}

/**
 * Carmack's approach: Direct SQL implementation for performance
 */
export class PostgreSQLShareRepository implements ShareRepository {
  constructor(private readonly pool: Pool) {}

  async save(share: Share): Promise<void> {
    const query = `
      INSERT INTO shares (miner_id, job_id, nonce, timestamp, difficulty, hash, is_valid)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (miner_id, job_id, nonce) DO NOTHING
    `;
    
    await this.pool.query(query, [
      share.minerId,
      share.jobId,
      share.nonce,
      new Date(share.timestamp),
      share.difficulty,
      share.hash,
      share.isValid
    ]);
  }

  async getByMiner(minerId: string, limit: number = 100): Promise<Share[]> {
    const query = `
      SELECT miner_id, job_id, nonce, extract(epoch from timestamp) * 1000 as timestamp, 
             difficulty, hash, is_valid
      FROM shares 
      WHERE miner_id = $1 
      ORDER BY timestamp DESC 
      LIMIT $2
    `;
    
    const result = await this.pool.query(query, [minerId, limit]);
    return result.rows.map(this.mapRowToShare);
  }

  async getRecentShares(minutes: number): Promise<Share[]> {
    const query = `
      SELECT miner_id, job_id, nonce, extract(epoch from timestamp) * 1000 as timestamp,
             difficulty, hash, is_valid
      FROM shares 
      WHERE timestamp > NOW() - INTERVAL '${minutes} minutes'
      ORDER BY timestamp DESC
    `;
    
    const result = await this.pool.query(query);
    return result.rows.map(this.mapRowToShare);
  }

  async deleteOld(days: number): Promise<number> {
    const query = `DELETE FROM shares WHERE timestamp < NOW() - INTERVAL '${days} days'`;
    const result = await this.pool.query(query);
    return result.rowCount || 0;
  }

  private mapRowToShare(row: any): Share {
    return {
      minerId: row.miner_id,
      jobId: row.job_id,
      nonce: row.nonce,
      timestamp: parseInt(row.timestamp),
      difficulty: row.difficulty,
      hash: row.hash,
      isValid: row.is_valid
    };
  }
}

export class PostgreSQLMinerRepository implements MinerRepository {
  constructor(private readonly pool: Pool) {}

  async save(miner: Miner): Promise<void> {
    const query = `
      INSERT INTO miners (id, address, worker, connected_at, hashrate, shares_submitted, shares_accepted, last_activity)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        hashrate = $5,
        shares_submitted = $6,
        shares_accepted = $7,
        last_activity = $8
    `;
    
    await this.pool.query(query, [
      miner.id,
      miner.address,
      miner.worker,
      new Date(miner.connectedAt),
      miner.hashrate,
      miner.sharesSubmitted,
      miner.sharesAccepted,
      new Date(miner.lastActivity)
    ]);
  }

  async findById(id: string): Promise<Miner | null> {
    const query = `
      SELECT id, address, worker, extract(epoch from connected_at) * 1000 as connected_at,
             hashrate, shares_submitted, shares_accepted, extract(epoch from last_activity) * 1000 as last_activity
      FROM miners 
      WHERE id = $1
    `;
    
    const result = await this.pool.query(query, [id]);
    if (result.rows.length === 0) return null;
    
    return this.mapRowToMiner(result.rows[0]);
  }

  async updateStats(id: string, hashrate: number, sharesCount: number): Promise<void> {
    const query = `
      UPDATE miners 
      SET hashrate = $2, shares_submitted = shares_submitted + $3, last_activity = NOW()
      WHERE id = $1
    `;
    
    await this.pool.query(query, [id, hashrate, sharesCount]);
  }

  async getActive(sinceMinutes: number): Promise<Miner[]> {
    const query = `
      SELECT id, address, worker, extract(epoch from connected_at) * 1000 as connected_at,
             hashrate, shares_submitted, shares_accepted, extract(epoch from last_activity) * 1000 as last_activity
      FROM miners 
      WHERE last_activity > NOW() - INTERVAL '${sinceMinutes} minutes'
      ORDER BY last_activity DESC
    `;
    
    const result = await this.pool.query(query);
    return result.rows.map(this.mapRowToMiner);
  }

  private mapRowToMiner(row: any): Miner {
    return {
      id: row.id,
      address: row.address,
      worker: row.worker,
      connectedAt: parseInt(row.connected_at),
      hashrate: row.hashrate,
      sharesSubmitted: row.shares_submitted,
      sharesAccepted: row.shares_accepted,
      lastActivity: parseInt(row.last_activity)
    };
  }
}

/**
 * Pike's simplicity: Database factory without complex DI
 */
export class DatabaseConnection {
  private pool: Pool;
  private shareRepo: ShareRepository;
  private minerRepo: MinerRepository;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 20, // Carmack's optimization: Connection pooling
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    this.shareRepo = new PostgreSQLShareRepository(this.pool);
    this.minerRepo = new PostgreSQLMinerRepository(this.pool);
  }

  get shares(): ShareRepository {
    return this.shareRepo;
  }

  get miners(): MinerRepository {
    return this.minerRepo;
  }

  async initialize(): Promise<void> {
    await this.createTables();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Uncle Bob's approach: Database migrations
   */
  private async createTables(): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      // Shares table
      await client.query(`
        CREATE TABLE IF NOT EXISTS shares (
          id SERIAL PRIMARY KEY,
          miner_id VARCHAR(255) NOT NULL,
          job_id VARCHAR(255) NOT NULL,
          nonce BIGINT NOT NULL,
          timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
          difficulty NUMERIC NOT NULL,
          hash VARCHAR(64) NOT NULL,
          is_valid BOOLEAN NOT NULL DEFAULT FALSE,
          UNIQUE(miner_id, job_id, nonce)
        )
      `);

      // Miners table
      await client.query(`
        CREATE TABLE IF NOT EXISTS miners (
          id VARCHAR(255) PRIMARY KEY,
          address VARCHAR(255) NOT NULL,
          worker VARCHAR(255) NOT NULL DEFAULT 'default',
          connected_at TIMESTAMP NOT NULL DEFAULT NOW(),
          hashrate BIGINT NOT NULL DEFAULT 0,
          shares_submitted INTEGER NOT NULL DEFAULT 0,
          shares_accepted INTEGER NOT NULL DEFAULT 0,
          last_activity TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      // Indexes for performance
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_shares_miner_timestamp ON shares(miner_id, timestamp DESC)
      `);
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_shares_timestamp ON shares(timestamp)
      `);
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_miners_last_activity ON miners(last_activity)
      `);

    } finally {
      client.release();
    }
  }

  /**
   * Carmack's approach: Direct query execution for complex operations
   */
  async query(text: string, params?: any[]): Promise<any> {
    return this.pool.query(text, params);
  }

  /**
   * Transaction support for atomic operations
   */
  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export default DatabaseConnection;