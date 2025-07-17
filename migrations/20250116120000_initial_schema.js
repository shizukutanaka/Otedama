/**
 * Migration: Initial Schema
 * Version: 20250116120000
 * Created: 2025-01-16T12:00:00.000Z
 */

export const version = '20250116120000';
export const name = 'Initial Schema';

/**
 * Run the migration
 */
export function up(db) {
  // Core miners table with enhanced fields
  db.exec(`
    CREATE TABLE IF NOT EXISTS miners (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      currency TEXT NOT NULL,
      algorithm TEXT NOT NULL,
      created INTEGER NOT NULL,
      lastSeen INTEGER,
      totalShares INTEGER DEFAULT 0,
      validShares INTEGER DEFAULT 0,
      balance REAL DEFAULT 0,
      btcBalance REAL DEFAULT 0,
      paid REAL DEFAULT 0,
      hashrate REAL DEFAULT 0,
      -- Security fields
      passwordHash TEXT,
      apiKeyHash TEXT,
      twoFactorSecret TEXT,
      lastLogin INTEGER,
      failedLogins INTEGER DEFAULT 0,
      locked INTEGER DEFAULT 0,
      -- Indexes
      INDEX idx_address (address),
      INDEX idx_currency (currency),
      INDEX idx_lastSeen (lastSeen),
      INDEX idx_balance (balance)
    )
  `);
  
  // Shares tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      minerId TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      difficulty REAL NOT NULL,
      valid INTEGER DEFAULT 1,
      hash TEXT,
      -- Indexes
      INDEX idx_minerId (minerId),
      INDEX idx_timestamp (timestamp),
      FOREIGN KEY (minerId) REFERENCES miners(id)
    )
  `);
  
  // Sessions table for authentication
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      minerId TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL,
      lastActivity INTEGER NOT NULL,
      ipAddress TEXT,
      userAgent TEXT,
      -- Indexes
      INDEX idx_token (token),
      INDEX idx_expiresAt (expiresAt),
      FOREIGN KEY (minerId) REFERENCES miners(id)
    )
  `);
  
  // API keys table
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      minerId TEXT NOT NULL,
      keyHash TEXT NOT NULL UNIQUE,
      name TEXT,
      permissions TEXT DEFAULT 'read',
      createdAt INTEGER NOT NULL,
      lastUsed INTEGER,
      expiresAt INTEGER,
      -- Indexes
      INDEX idx_keyHash (keyHash),
      FOREIGN KEY (minerId) REFERENCES miners(id)
    )
  `);
  
  // Transactions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      minerId TEXT NOT NULL,
      type TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL,
      btcAmount REAL NOT NULL,
      fee REAL DEFAULT 0,
      conversionFee REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      hash TEXT,
      timestamp INTEGER NOT NULL,
      -- Indexes
      INDEX idx_minerId_tx (minerId),
      INDEX idx_timestamp_tx (timestamp),
      INDEX idx_status (status),
      FOREIGN KEY (minerId) REFERENCES miners(id)
    )
  `);
  
  // DEX liquidity pools
  db.exec(`
    CREATE TABLE IF NOT EXISTS liquidity_pools (
      id TEXT PRIMARY KEY,
      token0 TEXT NOT NULL,
      token1 TEXT NOT NULL,
      reserve0 REAL NOT NULL,
      reserve1 REAL NOT NULL,
      totalShares REAL NOT NULL,
      fee REAL DEFAULT 0.003,
      -- Indexes
      INDEX idx_tokens (token0, token1),
      UNIQUE(token0, token1)
    )
  `);
  
  // Liquidity positions
  db.exec(`
    CREATE TABLE IF NOT EXISTS liquidity_positions (
      id TEXT PRIMARY KEY,
      poolId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      shares REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      -- Indexes
      INDEX idx_poolId (poolId),
      INDEX idx_providerId (providerId),
      FOREIGN KEY (poolId) REFERENCES liquidity_pools(id)
    )
  `);
  
  // System configuration
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updatedAt INTEGER
    )
  `);
  
  // IP filters
  db.exec(`
    CREATE TABLE IF NOT EXISTS ip_filters (
      ip TEXT PRIMARY KEY,
      type TEXT NOT NULL, -- 'whitelist' or 'blacklist'
      reason TEXT,
      addedAt INTEGER NOT NULL,
      expiresAt INTEGER
    )
  `);
  
  // Audit logs
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      userId TEXT,
      ip TEXT,
      action TEXT NOT NULL,
      resource TEXT,
      details TEXT,
      result TEXT,
      INDEX idx_timestamp (timestamp),
      INDEX idx_userId (userId),
      INDEX idx_action (action)
    )
  `);
  
  // Performance logs
  db.exec(`
    CREATE TABLE IF NOT EXISTS performance_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      action TEXT NOT NULL,
      responseTime INTEGER NOT NULL,
      statusCode INTEGER,
      INDEX idx_timestamp_perf (timestamp),
      INDEX idx_action_perf (action)
    )
  `);
  
  // Webhook configurations
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      events TEXT NOT NULL, -- JSON array of events
      secret TEXT,
      active INTEGER DEFAULT 1,
      createdAt INTEGER NOT NULL,
      lastTriggered INTEGER,
      failureCount INTEGER DEFAULT 0,
      INDEX idx_active (active)
    )
  `);
  
  // Backup history
  db.exec(`
    CREATE TABLE IF NOT EXISTS backup_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      path TEXT,
      size INTEGER,
      status TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      completedAt INTEGER,
      error TEXT,
      INDEX idx_createdAt (createdAt),
      INDEX idx_status_backup (status)
    )
  `);
}

/**
 * Rollback the migration
 */
export function down(db) {
  // Drop all tables in reverse order
  const tables = [
    'backup_history',
    'webhooks',
    'performance_logs',
    'audit_logs',
    'ip_filters',
    'system_config',
    'liquidity_positions',
    'liquidity_pools',
    'transactions',
    'api_keys',
    'sessions',
    'shares',
    'miners'
  ];
  
  for (const table of tables) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}