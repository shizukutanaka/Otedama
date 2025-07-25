/**
 * Database Migration System - Otedama
 * Schema versioning and migration management
 * 
 * Design: Evolve schemas safely (Martin)
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { DatabaseError } from './errors.js';
import { createLogger } from './logger.js';

const logger = createLogger('Migration');

/**
 * Migration class
 */
export class Migration {
  constructor(version, name, up, down) {
    this.version = version;
    this.name = name;
    this.up = up;
    this.down = down;
    this.checksum = this.calculateChecksum();
    this.timestamp = new Date(parseInt(version)).toISOString();
  }
  
  calculateChecksum() {
    const content = `${this.version}:${this.name}:${this.up.toString()}:${this.down.toString()}`;
    return crypto.createHash('sha256').update(content).digest('hex');
  }
  
  async execute(db, direction = 'up') {
    const fn = direction === 'up' ? this.up : this.down;
    await fn(db);
  }
}

/**
 * Migration manager
 */
export class MigrationManager {
  constructor(db, options = {}) {
    this.db = db;
    this.options = {
      migrationsTable: options.migrationsTable || 'schema_migrations',
      migrationsDir: options.migrationsDir || './migrations',
      validateChecksums: options.validateChecksums !== false,
      ...options
    };
    
    this.migrations = new Map();
  }
  
  /**
   * Initialize migration system
   */
  async initialize() {
    logger.info('Initializing migration system...');
    
    // Create migrations table
    await this.createMigrationsTable();
    
    // Load migrations
    await this.loadMigrations();
    
    logger.info(`Loaded ${this.migrations.size} migrations`);
  }
  
  /**
   * Create migrations table
   */
  async createMigrationsTable() {
    const sql = `
      CREATE TABLE IF NOT EXISTS ${this.options.migrationsTable} (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        execution_time INTEGER
      )
    `;
    
    await this.db.run(sql);
  }
  
  /**
   * Load migrations from directory
   */
  async loadMigrations() {
    try {
      const files = await fs.readdir(this.options.migrationsDir);
      const migrationFiles = files
        .filter(f => f.endsWith('.js'))
        .sort();
      
      for (const file of migrationFiles) {
        await this.loadMigration(file);
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.warn(`Migrations directory not found: ${this.options.migrationsDir}`);
        await fs.mkdir(this.options.migrationsDir, { recursive: true });
      } else {
        throw error;
      }
    }
  }
  
  /**
   * Load single migration file
   */
  async loadMigration(filename) {
    const match = filename.match(/^(\d{14})_(.+)\.js$/);
    if (!match) {
      logger.warn(`Invalid migration filename format: ${filename}`);
      return;
    }
    
    const [, version, name] = match;
    const filepath = path.join(this.options.migrationsDir, filename);
    
    try {
      const module = await import(filepath);
      const migration = new Migration(
        version,
        name,
        module.up,
        module.down
      );
      
      this.migrations.set(version, migration);
    } catch (error) {
      logger.error(`Failed to load migration ${filename}:`, error);
      throw error;
    }
  }
  
  /**
   * Get executed migrations
   */
  async getExecutedMigrations() {
    const sql = `
      SELECT version, name, checksum, executed_at, execution_time
      FROM ${this.options.migrationsTable}
      ORDER BY version
    `;
    
    const rows = await this.db.all(sql);
    return new Map(rows.map(row => [row.version, row]));
  }
  
  /**
   * Get pending migrations
   */
  async getPendingMigrations() {
    const executed = await this.getExecutedMigrations();
    const pending = [];
    
    for (const [version, migration] of this.migrations) {
      if (!executed.has(version)) {
        pending.push(migration);
      }
    }
    
    return pending.sort((a, b) => a.version.localeCompare(b.version));
  }
  
  /**
   * Validate checksums
   */
  async validateChecksums() {
    if (!this.options.validateChecksums) return;
    
    const executed = await this.getExecutedMigrations();
    
    for (const [version, record] of executed) {
      const migration = this.migrations.get(version);
      
      if (!migration) {
        logger.warn(`Migration ${version} exists in database but not in files`);
        continue;
      }
      
      if (migration.checksum !== record.checksum) {
        throw new DatabaseError(
          `Migration ${version} has been modified after execution. ` +
          `Expected checksum: ${record.checksum}, ` +
          `Current checksum: ${migration.checksum}`
        );
      }
    }
  }
  
  /**
   * Run migrations up to target version
   */
  async migrate(targetVersion = null) {
    await this.validateChecksums();
    
    const pending = await this.getPendingMigrations();
    
    if (pending.length === 0) {
      logger.info('No pending migrations');
      return { executed: 0 };
    }
    
    logger.info(`Running ${pending.length} pending migrations...`);
    
    let executed = 0;
    
    for (const migration of pending) {
      if (targetVersion && migration.version > targetVersion) {
        break;
      }
      
      await this.runMigration(migration, 'up');
      executed++;
    }
    
    logger.info(`Successfully executed ${executed} migrations`);
    
    return { executed };
  }
  
  /**
   * Rollback migrations
   */
  async rollback(steps = 1) {
    await this.validateChecksums();
    
    const executed = await this.getExecutedMigrations();
    const versions = Array.from(executed.keys()).sort().reverse();
    
    if (versions.length === 0) {
      logger.info('No migrations to rollback');
      return { rolledback: 0 };
    }
    
    const toRollback = versions.slice(0, steps);
    logger.info(`Rolling back ${toRollback.length} migrations...`);
    
    let rolledback = 0;
    
    for (const version of toRollback) {
      const migration = this.migrations.get(version);
      
      if (!migration) {
        throw new DatabaseError(
          `Cannot rollback migration ${version}: migration file not found`
        );
      }
      
      await this.runMigration(migration, 'down');
      rolledback++;
    }
    
    logger.info(`Successfully rolled back ${rolledback} migrations`);
    
    return { rolledback };
  }
  
  /**
   * Run single migration
   */
  async runMigration(migration, direction) {
    const start = Date.now();
    
    logger.info(`${direction === 'up' ? 'Applying' : 'Rolling back'} migration ${migration.version}: ${migration.name}`);
    
    // Start transaction
    await this.db.run('BEGIN TRANSACTION');
    
    try {
      // Execute migration
      await migration.execute(this.db, direction);
      
      // Record execution
      if (direction === 'up') {
        await this.recordMigration(migration, Date.now() - start);
      } else {
        await this.removeMigration(migration.version);
      }
      
      // Commit
      await this.db.run('COMMIT');
      
      logger.info(`Migration ${migration.version} ${direction === 'up' ? 'applied' : 'rolled back'} successfully`);
      
    } catch (error) {
      // Rollback transaction
      await this.db.run('ROLLBACK');
      
      logger.error(`Migration ${migration.version} failed:`, error);
      throw new DatabaseError(
        `Migration ${migration.version} failed: ${error.message}`
      );
    }
  }
  
  /**
   * Record migration execution
   */
  async recordMigration(migration, executionTime) {
    const sql = `
      INSERT INTO ${this.options.migrationsTable} 
      (version, name, checksum, execution_time)
      VALUES (?, ?, ?, ?)
    `;
    
    await this.db.run(sql, [
      migration.version,
      migration.name,
      migration.checksum,
      executionTime
    ]);
  }
  
  /**
   * Remove migration record
   */
  async removeMigration(version) {
    const sql = `
      DELETE FROM ${this.options.migrationsTable}
      WHERE version = ?
    `;
    
    await this.db.run(sql, [version]);
  }
  
  /**
   * Create new migration file
   */
  async createMigration(name) {
    const version = new Date().toISOString()
      .replace(/[^\d]/g, '')
      .substring(0, 14);
    
    const filename = `${version}_${name.toLowerCase().replace(/\s+/g, '_')}.js`;
    const filepath = path.join(this.options.migrationsDir, filename);
    
    const template = `/**
 * Migration: ${name}
 * Version: ${version}
 */

/**
 * Run the migration
 */
export async function up(db) {
  // TODO: Implement migration
  
  // Example: Create table
  // await db.run(\`
  //   CREATE TABLE example (
  //     id INTEGER PRIMARY KEY AUTOINCREMENT,
  //     name TEXT NOT NULL,
  //     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  //   )
  // \`);
}

/**
 * Reverse the migration
 */
export async function down(db) {
  // TODO: Implement rollback
  
  // Example: Drop table
  // await db.run('DROP TABLE IF EXISTS example');
}
`;
    
    await fs.writeFile(filepath, template, 'utf8');
    
    logger.info(`Created migration: ${filepath}`);
    
    return { version, name, filepath };
  }
  
  /**
   * Get migration status
   */
  async getStatus() {
    const executed = await this.getExecutedMigrations();
    const pending = await this.getPendingMigrations();
    
    return {
      executed: Array.from(executed.values()).map(m => ({
        version: m.version,
        name: m.name,
        executedAt: m.executed_at,
        executionTime: m.execution_time
      })),
      pending: pending.map(m => ({
        version: m.version,
        name: m.name
      })),
      current: executed.size > 0 
        ? Array.from(executed.keys()).sort().pop()
        : null
    };
  }
}

/**
 * Built-in migrations for Otedama
 */
export const builtinMigrations = [
  new Migration(
    '20240101000000',
    'create_miners_table',
    async (db) => {
      await db.run(`
        CREATE TABLE miners (
          id TEXT PRIMARY KEY,
          address TEXT NOT NULL,
          worker TEXT DEFAULT 'default',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_seen DATETIME,
          total_shares INTEGER DEFAULT 0,
          valid_shares INTEGER DEFAULT 0,
          invalid_shares INTEGER DEFAULT 0,
          balance INTEGER DEFAULT 0,
          paid_amount INTEGER DEFAULT 0
        )
      `);
      
      await db.run('CREATE INDEX idx_miners_address ON miners(address)');
      await db.run('CREATE INDEX idx_miners_last_seen ON miners(last_seen)');
    },
    async (db) => {
      await db.run('DROP TABLE IF EXISTS miners');
    }
  ),
  
  new Migration(
    '20240101000001',
    'create_shares_table',
    async (db) => {
      await db.run(`
        CREATE TABLE shares (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          miner_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          share_diff REAL NOT NULL,
          block_diff REAL NOT NULL,
          is_valid BOOLEAN DEFAULT 1,
          is_block BOOLEAN DEFAULT 0,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (miner_id) REFERENCES miners(id)
        )
      `);
      
      await db.run('CREATE INDEX idx_shares_miner ON shares(miner_id)');
      await db.run('CREATE INDEX idx_shares_timestamp ON shares(timestamp)');
      await db.run('CREATE INDEX idx_shares_is_block ON shares(is_block)');
    },
    async (db) => {
      await db.run('DROP TABLE IF EXISTS shares');
    }
  ),
  
  new Migration(
    '20240101000002',
    'create_blocks_table',
    async (db) => {
      await db.run(`
        CREATE TABLE blocks (
          height INTEGER PRIMARY KEY,
          hash TEXT NOT NULL UNIQUE,
          finder_id TEXT NOT NULL,
          reward INTEGER NOT NULL,
          fee INTEGER DEFAULT 0,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          confirmed BOOLEAN DEFAULT 0,
          FOREIGN KEY (finder_id) REFERENCES miners(id)
        )
      `);
      
      await db.run('CREATE INDEX idx_blocks_hash ON blocks(hash)');
      await db.run('CREATE INDEX idx_blocks_finder ON blocks(finder_id)');
    },
    async (db) => {
      await db.run('DROP TABLE IF EXISTS blocks');
    }
  ),
  
  new Migration(
    '20240101000003',
    'create_payments_table',
    async (db) => {
      await db.run(`
        CREATE TABLE payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          miner_id TEXT NOT NULL,
          amount INTEGER NOT NULL,
          transaction_id TEXT,
          status TEXT DEFAULT 'pending',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          completed_at DATETIME,
          FOREIGN KEY (miner_id) REFERENCES miners(id)
        )
      `);
      
      await db.run('CREATE INDEX idx_payments_miner ON payments(miner_id)');
      await db.run('CREATE INDEX idx_payments_status ON payments(status)');
    },
    async (db) => {
      await db.run('DROP TABLE IF EXISTS payments');
    }
  )
];

export default {
  Migration,
  MigrationManager,
  builtinMigrations
};
