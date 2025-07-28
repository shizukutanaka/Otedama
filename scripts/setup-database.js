#!/usr/bin/env node

import { program } from 'commander';
import { database } from '../lib/storage/database.js';
import { logger } from '../lib/core/logger.js';
import { default as configData } from '../config/default.json' assert { type: 'json' };
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

/**
 * Database Setup Script for Otedama
 * Creates and initializes the database with all required tables and initial data
 */

program
  .name('setup-database')
  .description('Setup and initialize Otedama database')
  .version('1.0.0')
  .option('-f, --force', 'Force recreate database (will drop existing)')
  .option('-d, --demo-data', 'Insert demo data')
  .option('-b, --backup', 'Backup existing database before setup')
  .option('--path <path>', 'Custom database path', configData.database?.path || './data/otedama.db');

async function ensureDirectories() {
  const dirs = [
    'data',
    'backups',
    'logs',
    'reports',
    'config',
    path.dirname(program.opts().path)
  ];

  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
      logger.info(`Directory ensured: ${dir}`);
    } catch (error) {
      logger.error(`Failed to create directory ${dir}:`, error);
    }
  }
}

async function backupExistingDatabase() {
  const dbPath = program.opts().path;
  
  try {
    await fs.access(dbPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join('backups', `otedama_backup_${timestamp}.db`);
    
    await fs.copyFile(dbPath, backupPath);
    logger.info(`Database backed up to: ${backupPath}`);
    return backupPath;
  } catch (error) {
    logger.info('No existing database to backup');
    return null;
  }
}

async function createTables() {
  const tables = [
    // Users table
    {
      name: 'users',
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username VARCHAR(255) UNIQUE NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          salt VARCHAR(255) NOT NULL,
          role VARCHAR(50) DEFAULT 'user',
          is_active BOOLEAN DEFAULT 1,
          is_verified BOOLEAN DEFAULT 0,
          two_factor_secret VARCHAR(255),
          two_factor_enabled BOOLEAN DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_login TIMESTAMP,
          failed_login_attempts INTEGER DEFAULT 0,
          locked_until TIMESTAMP
        )`
    },
    
    // Miners table
    {
      name: 'miners',
      sql: `
        CREATE TABLE IF NOT EXISTS miners (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          worker_name VARCHAR(255) NOT NULL,
          worker_id VARCHAR(255) UNIQUE NOT NULL,
          hardware_info TEXT,
          location VARCHAR(255),
          is_active BOOLEAN DEFAULT 1,
          last_seen TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(user_id, worker_name)
        )`
    },
    
    // Shares table
    {
      name: 'shares',
      sql: `
        CREATE TABLE IF NOT EXISTS shares (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          miner_id INTEGER NOT NULL,
          job_id VARCHAR(255) NOT NULL,
          difficulty REAL NOT NULL,
          share_difficulty REAL NOT NULL,
          hash VARCHAR(255) NOT NULL,
          is_valid BOOLEAN DEFAULT 1,
          is_block BOOLEAN DEFAULT 0,
          submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          processed_at TIMESTAMP,
          reward_amount REAL DEFAULT 0,
          FOREIGN KEY (miner_id) REFERENCES miners(id) ON DELETE CASCADE,
          INDEX idx_shares_miner (miner_id),
          INDEX idx_shares_time (submitted_at)
        )`
    },
    
    // Blocks table
    {
      name: 'blocks',
      sql: `
        CREATE TABLE IF NOT EXISTS blocks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          block_height INTEGER NOT NULL,
          block_hash VARCHAR(255) UNIQUE NOT NULL,
          previous_hash VARCHAR(255),
          found_by_miner_id INTEGER,
          difficulty REAL NOT NULL,
          reward REAL NOT NULL,
          tx_count INTEGER DEFAULT 0,
          confirmations INTEGER DEFAULT 0,
          status VARCHAR(50) DEFAULT 'pending',
          found_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          confirmed_at TIMESTAMP,
          FOREIGN KEY (found_by_miner_id) REFERENCES miners(id) ON DELETE SET NULL
        )`
    },
    
    // Payouts table
    {
      name: 'payouts',
      sql: `
        CREATE TABLE IF NOT EXISTS payouts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          amount REAL NOT NULL,
          currency VARCHAR(10) NOT NULL,
          address VARCHAR(255) NOT NULL,
          tx_hash VARCHAR(255),
          status VARCHAR(50) DEFAULT 'pending',
          fee REAL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          processed_at TIMESTAMP,
          confirmed_at TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`
    },
    
    // Sessions table
    {
      name: 'sessions',
      sql: `
        CREATE TABLE IF NOT EXISTS sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id VARCHAR(255) UNIQUE NOT NULL,
          user_id INTEGER NOT NULL,
          ip_address VARCHAR(45),
          user_agent TEXT,
          is_active BOOLEAN DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`
    },
    
    // API Keys table
    {
      name: 'api_keys',
      sql: `
        CREATE TABLE IF NOT EXISTS api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          key_hash VARCHAR(255) UNIQUE NOT NULL,
          name VARCHAR(255),
          permissions TEXT,
          last_used TIMESTAMP,
          is_active BOOLEAN DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`
    },
    
    // Pool Statistics table
    {
      name: 'pool_stats',
      sql: `
        CREATE TABLE IF NOT EXISTS pool_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          hashrate REAL NOT NULL,
          active_miners INTEGER DEFAULT 0,
          active_workers INTEGER DEFAULT 0,
          difficulty REAL NOT NULL,
          blocks_found INTEGER DEFAULT 0,
          total_shares BIGINT DEFAULT 0,
          valid_shares BIGINT DEFAULT 0,
          invalid_shares BIGINT DEFAULT 0,
          stale_shares BIGINT DEFAULT 0,
          INDEX idx_stats_time (timestamp)
        )`
    },
    
    // Audit Logs table
    {
      name: 'audit_logs',
      sql: `
        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          action VARCHAR(255) NOT NULL,
          resource_type VARCHAR(100),
          resource_id VARCHAR(255),
          ip_address VARCHAR(45),
          user_agent TEXT,
          details TEXT,
          status VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
          INDEX idx_audit_action (action),
          INDEX idx_audit_time (created_at)
        )`
    },
    
    // ZKP Authentication table
    {
      name: 'zkp_auth',
      sql: `
        CREATE TABLE IF NOT EXISTS zkp_auth (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          public_key TEXT NOT NULL,
          commitment TEXT NOT NULL,
          challenge TEXT,
          response TEXT,
          verified BOOLEAN DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`
    },
    
    // Agent System tables
    {
      name: 'agent_metrics',
      sql: `
        CREATE TABLE IF NOT EXISTS agent_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_name VARCHAR(255) NOT NULL,
          agent_type VARCHAR(100) NOT NULL,
          metric_type VARCHAR(100) NOT NULL,
          metric_value TEXT NOT NULL,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_agent_name (agent_name),
          INDEX idx_agent_time (timestamp)
        )`
    },
    
    {
      name: 'agent_logs',
      sql: `
        CREATE TABLE IF NOT EXISTS agent_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_name VARCHAR(255) NOT NULL,
          log_level VARCHAR(50) NOT NULL,
          message TEXT NOT NULL,
          context TEXT,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_agent_log_name (agent_name),
          INDEX idx_agent_log_time (timestamp),
          INDEX idx_agent_log_level (log_level)
        )`
    }
  ];

  logger.info('Creating database tables...');
  
  for (const table of tables) {
    try {
      await database.run(table.sql);
      logger.info(`✅ Table created: ${table.name}`);
    } catch (error) {
      logger.error(`❌ Failed to create table ${table.name}:`, error);
      throw error;
    }
  }
}

async function createIndexes() {
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
    'CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)',
    'CREATE INDEX IF NOT EXISTS idx_miners_user ON miners(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_miners_worker ON miners(worker_id)',
    'CREATE INDEX IF NOT EXISTS idx_shares_job ON shares(job_id)',
    'CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(block_height)',
    'CREATE INDEX IF NOT EXISTS idx_payouts_user ON payouts(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)'
  ];

  logger.info('Creating indexes...');
  
  for (const indexSql of indexes) {
    try {
      await database.run(indexSql);
      const indexName = indexSql.match(/idx_\w+/)[0];
      logger.info(`✅ Index created: ${indexName}`);
    } catch (error) {
      logger.error(`❌ Failed to create index:`, error);
    }
  }
}

async function insertDemoData() {
  logger.info('Inserting demo data...');
  
  try {
    // Create demo user
    const demoUser = {
      username: 'demo_user',
      email: 'demo@otedama.example',
      password: 'Demo123!@#',
      role: 'user'
    };
    
    const { hash, salt } = await hashPassword(demoUser.password);
    
    const result = await database.run(
      `INSERT INTO users (username, email, password_hash, salt, role, is_active, is_verified) 
       VALUES (?, ?, ?, ?, ?, 1, 1)`,
      [demoUser.username, demoUser.email, hash, salt, demoUser.role]
    );
    
    const userId = result.lastID;
    logger.info(`✅ Demo user created: ${demoUser.username}`);
    
    // Create demo miners
    const miners = [
      { worker_name: 'Demo-Rig-01', hardware: 'RTX 3080 x4' },
      { worker_name: 'Demo-Rig-02', hardware: 'RTX 3090 x2' }
    ];
    
    for (const miner of miners) {
      const workerId = crypto.randomBytes(16).toString('hex');
      await database.run(
        `INSERT INTO miners (user_id, worker_name, worker_id, hardware_info, is_active, last_seen) 
         VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
        [userId, miner.worker_name, workerId, miner.hardware]
      );
      logger.info(`✅ Demo miner created: ${miner.worker_name}`);
    }
    
    // Create initial pool stats
    await database.run(
      `INSERT INTO pool_stats (hashrate, active_miners, active_workers, difficulty, blocks_found) 
       VALUES (?, ?, ?, ?, ?)`,
      [0, 0, 0, 1000000, 0]
    );
    logger.info('✅ Initial pool stats created');
    
  } catch (error) {
    logger.error('Failed to insert demo data:', error);
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 600000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

async function main() {
  try {
    logger.info('🚀 Starting Otedama Database Setup...');
    
    // Parse command line options
    program.parse();
    const options = program.opts();
    
    // Ensure required directories exist
    await ensureDirectories();
    
    // Backup existing database if requested
    if (options.backup) {
      await backupExistingDatabase();
    }
    
    // Force recreate if requested
    if (options.force) {
      try {
        await fs.unlink(options.path);
        logger.info('Existing database removed');
      } catch (error) {
        // Database doesn't exist, that's fine
      }
    }
    
    // Initialize database connection
    await database.initialize({
      path: options.path,
      ...configData.database
    });
    
    // Create tables
    await createTables();
    
    // Create indexes
    await createIndexes();
    
    // Insert demo data if requested
    if (options.demoData) {
      await insertDemoData();
    }
    
    // Verify setup
    const tables = await database.all(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    
    logger.info('✅ Database setup completed successfully!');
    logger.info(`📊 Created ${tables.length} tables:`);
    tables.forEach(table => {
      logger.info(`   - ${table.name}`);
    });
    
    // Create setup confirmation file
    const setupInfo = {
      setupDate: new Date().toISOString(),
      databasePath: options.path,
      tablesCreated: tables.length,
      demoDataInserted: options.demoData || false,
      version: '1.0.0'
    };
    
    await fs.writeFile(
      'data/.database-setup.json',
      JSON.stringify(setupInfo, null, 2)
    );
    
    logger.info('\n📋 Next Steps:');
    logger.info('1. Update .env file with production values');
    logger.info('2. Run database migrations if needed: npm run db:migrate');
    logger.info('3. Set up regular backups: npm run db:backup');
    logger.info('4. Start the application: npm run start:production');
    
  } catch (error) {
    logger.error('❌ Database setup failed:', error);
    process.exit(1);
  } finally {
    await database.close();
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  logger.info('Setup interrupted, cleaning up...');
  await database.close();
  process.exit(0);
});

// Run the setup
main();