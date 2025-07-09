// Database operations performance tests
// Testing SQLite performance for mining pool operations

import { perfTest } from './performance-test-framework';
import * as sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Database performance tests
 */
export class DatabasePerformance {
  private db!: Database;
  private testDbPath: string;
  
  constructor() {
    this.testDbPath = path.join(process.cwd(), 'test-perf.db');
  }

  /**
   * Initialize test database
   */
  async initialize(): Promise<void> {
    // Remove existing test database
    try {
      await fs.unlink(this.testDbPath);
    } catch {
      // Ignore if doesn't exist
    }

    // Open database
    this.db = await open({
      filename: this.testDbPath,
      driver: sqlite3.Database
    });

    // Enable optimizations
    await this.db.exec('PRAGMA journal_mode = WAL');
    await this.db.exec('PRAGMA synchronous = NORMAL');
    await this.db.exec('PRAGMA cache_size = 10000');
    await this.db.exec('PRAGMA temp_store = MEMORY');

    // Create tables
    await this.createTables();
    
    // Insert test data
    await this.insertTestData();
  }

  /**
   * Create tables
   */
  private async createTables(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE miners (
        id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_share_at INTEGER,
        total_shares INTEGER DEFAULT 0,
        valid_shares INTEGER DEFAULT 0,
        invalid_shares INTEGER DEFAULT 0
      );

      CREATE TABLE shares (
        id TEXT PRIMARY KEY,
        miner_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        difficulty REAL NOT NULL,
        timestamp INTEGER NOT NULL,
        is_valid INTEGER NOT NULL,
        FOREIGN KEY (miner_id) REFERENCES miners(id)
      );

      CREATE TABLE blocks (
        height INTEGER PRIMARY KEY,
        hash TEXT NOT NULL,
        miner_id TEXT NOT NULL,
        reward REAL NOT NULL,
        timestamp INTEGER NOT NULL,
        confirmations INTEGER DEFAULT 0,
        FOREIGN KEY (miner_id) REFERENCES miners(id)
      );

      -- Indexes
      CREATE INDEX idx_shares_miner_id ON shares(miner_id);
      CREATE INDEX idx_shares_timestamp ON shares(timestamp);
      CREATE INDEX idx_shares_miner_timestamp ON shares(miner_id, timestamp);
      CREATE INDEX idx_miners_address ON miners(address);
      CREATE INDEX idx_blocks_miner_id ON blocks(miner_id);
    `);
  }

  /**
   * Insert test data
   */
  private async insertTestData(): Promise<void> {
    // Insert miners
    const minerStmt = await this.db.prepare(
      'INSERT INTO miners (id, address, created_at) VALUES (?, ?, ?)'
    );

    for (let i = 0; i < 1000; i++) {
      await minerStmt.run(
        `miner-${i}`,
        `1Address${i.toString().padStart(34, '0')}`,
        Date.now() - Math.random() * 86400000 * 30 // Last 30 days
      );
    }
    await minerStmt.finalize();

    // Insert shares
    const shareStmt = await this.db.prepare(
      'INSERT INTO shares (id, miner_id, job_id, difficulty, timestamp, is_valid) VALUES (?, ?, ?, ?, ?, ?)'
    );

    for (let i = 0; i < 10000; i++) {
      await shareStmt.run(
        `share-${i}`,
        `miner-${Math.floor(Math.random() * 1000)}`,
        `job-${Math.floor(Math.random() * 100)}`,
        Math.pow(2, 10 + Math.random() * 5),
        Date.now() - Math.random() * 3600000, // Last hour
        Math.random() > 0.02 ? 1 : 0 // 98% valid
      );
    }
    await shareStmt.finalize();
  }

  /**
   * Test single share insertion
   */
  async testShareInsertion(): Promise<void> {
    const stmt = await this.db.prepare(
      'INSERT INTO shares (id, miner_id, job_id, difficulty, timestamp, is_valid) VALUES (?, ?, ?, ?, ?, ?)'
    );

    let shareId = 100000;

    await perfTest.run(async () => {
      await stmt.run(
        `share-${shareId++}`,
        `miner-${Math.floor(Math.random() * 1000)}`,
        `job-${Math.floor(Math.random() * 100)}`,
        Math.pow(2, 10 + Math.random() * 5),
        Date.now(),
        1
      );
    }, {
      name: 'Single Share Insert',
      iterations: 1000,
      warmupIterations: 100,
      async: true
    });

    await stmt.finalize();
  }

  /**
   * Test batch share insertion
   */
  async testBatchShareInsertion(): Promise<void> {
    let shareId = 200000;

    await perfTest.run(async () => {
      await this.db.run('BEGIN');
      
      const stmt = await this.db.prepare(
        'INSERT INTO shares (id, miner_id, job_id, difficulty, timestamp, is_valid) VALUES (?, ?, ?, ?, ?, ?)'
      );

      for (let i = 0; i < 100; i++) {
        await stmt.run(
          `share-${shareId++}`,
          `miner-${Math.floor(Math.random() * 1000)}`,
          `job-${Math.floor(Math.random() * 100)}`,
          Math.pow(2, 10 + Math.random() * 5),
          Date.now(),
          1
        );
      }

      await stmt.finalize();
      await this.db.run('COMMIT');
    }, {
      name: 'Batch Share Insert (100 shares)',
      iterations: 10,
      warmupIterations: 2,
      async: true
    });
  }

  /**
   * Test miner stats query
   */
  async testMinerStatsQuery(): Promise<void> {
    const query = `
      SELECT 
        m.id,
        m.address,
        COUNT(s.id) as share_count,
        SUM(CASE WHEN s.is_valid = 1 THEN 1 ELSE 0 END) as valid_shares,
        SUM(s.difficulty) as total_difficulty,
        MAX(s.timestamp) as last_share
      FROM miners m
      LEFT JOIN shares s ON m.id = s.miner_id
      WHERE s.timestamp > ?
      GROUP BY m.id
      HAVING share_count > 0
      ORDER BY total_difficulty DESC
      LIMIT 10
    `;

    await perfTest.run(async () => {
      const oneHourAgo = Date.now() - 3600000;
      await this.db.all(query, oneHourAgo);
    }, {
      name: 'Top Miners Query',
      iterations: 100,
      warmupIterations: 10,
      async: true
    });
  }

  /**
   * Test share retrieval
   */
  async testShareRetrieval(): Promise<void> {
    await perfTest.run(async () => {
      const minerId = `miner-${Math.floor(Math.random() * 1000)}`;
      await this.db.all(
        'SELECT * FROM shares WHERE miner_id = ? ORDER BY timestamp DESC LIMIT 100',
        minerId
      );
    }, {
      name: 'Get Miner Shares',
      iterations: 100,
      warmupIterations: 10,
      async: true
    });
  }

  /**
   * Test unpaid shares query
   */
  async testUnpaidSharesQuery(): Promise<void> {
    await perfTest.run(async () => {
      await this.db.all(`
        SELECT 
          miner_id,
          SUM(difficulty) as total_difficulty,
          COUNT(*) as share_count
        FROM shares
        WHERE is_valid = 1
        GROUP BY miner_id
        HAVING total_difficulty > 1000
      `);
    }, {
      name: 'Unpaid Shares Query',
      iterations: 50,
      warmupIterations: 5,
      async: true
    });
  }

  /**
   * Compare indexed vs non-indexed queries
   */
  async compareIndexedQueries(): Promise<void> {
    // Drop index temporarily
    await this.db.exec('DROP INDEX IF EXISTS idx_shares_timestamp_test');
    
    // Non-indexed query
    const nonIndexedQuery = async () => {
      const oneHourAgo = Date.now() - 3600000;
      await this.db.all(
        'SELECT * FROM shares WHERE timestamp > ?',
        oneHourAgo
      );
    };

    // Create index
    await this.db.exec('CREATE INDEX idx_shares_timestamp_test ON shares(timestamp)');
    
    // Indexed query
    const indexedQuery = async () => {
      const oneHourAgo = Date.now() - 3600000;
      await this.db.all(
        'SELECT * FROM shares WHERE timestamp > ?',
        oneHourAgo
      );
    };

    const result = await perfTest.compare(
      'Indexed vs Non-indexed Query',
      nonIndexedQuery,
      indexedQuery,
      {
        iterations: 20,
        warmupIterations: 5,
        async: true
      }
    );

    console.log(`\nIndex impact: ${result.comparison.winner} is ${result.comparison.speedup.toFixed(2)}x faster`);
    
    // Cleanup
    await this.db.exec('DROP INDEX idx_shares_timestamp_test');
  }

  /**
   * Run all database performance tests
   */
  async runAll(): Promise<void> {
    await this.initialize();

    await perfTest.suite('Database Performance', [
      { name: 'Single Insert', fn: () => this.testShareInsertion() },
      { name: 'Batch Insert', fn: () => this.testBatchShareInsertion() },
      { name: 'Miner Stats', fn: () => this.testMinerStatsQuery() },
      { name: 'Share Retrieval', fn: () => this.testShareRetrieval() },
      { name: 'Unpaid Shares', fn: () => this.testUnpaidSharesQuery() },
      { name: 'Index Comparison', fn: () => this.compareIndexedQueries() }
    ]);

    await this.cleanup();
  }

  /**
   * Cleanup test database
   */
  async cleanup(): Promise<void> {
    await this.db.close();
    await fs.unlink(this.testDbPath);
  }
}

// Run tests if executed directly
if (require.main === module) {
  const test = new DatabasePerformance();
  test.runAll().catch(console.error);
}
