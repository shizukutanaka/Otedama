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
      wallet_address TEXT,
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
      passwordHash TEXT,
      apiKeyHash TEXT,
      twoFactorSecret TEXT,
      lastLogin INTEGER,
      failedLogins INTEGER DEFAULT 0,
      locked INTEGER DEFAULT 0
    )
  `);
  
  // Create indexes for miners - run separately to ensure table exists
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_miners_address ON miners(address)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_miners_wallet ON miners(wallet_address)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_miners_currency ON miners(currency)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_miners_lastSeen ON miners(lastSeen)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_miners_balance ON miners(balance)`).run();
  
  // Shares tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      miner_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      difficulty REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      valid INTEGER DEFAULT 1,
      hash TEXT,
      FOREIGN KEY (miner_id) REFERENCES miners(id)
    )
  `);
  
  // Create indexes for shares
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shares_miner_timestamp ON shares(miner_id, timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shares_status ON shares(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shares_timestamp ON shares(timestamp)`);
  
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
      FOREIGN KEY (minerId) REFERENCES miners(id)
    )
  `);
  
  // Create indexes for sessions
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_expiresAt ON sessions(expiresAt)`);
  
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
      FOREIGN KEY (minerId) REFERENCES miners(id)
    )
  `);
  
  // Create indexes for api_keys
  db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_keyHash ON api_keys(keyHash)`);
  
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
      FOREIGN KEY (minerId) REFERENCES miners(id)
    )
  `);
  
  // Create indexes for transactions
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_minerId ON transactions(minerId)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status)`);
  
  // Pending payouts table (for roadmap compatibility)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      miner_id TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      processed_at INTEGER,
      tx_hash TEXT,
      FOREIGN KEY (miner_id) REFERENCES miners(id)
    )
  `);
  
  // Create indexes for pending_payouts
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payouts_status ON pending_payouts(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_payouts_miner ON pending_payouts(miner_id)`);
  
  // DEX orders table
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      pair_id TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      amount REAL NOT NULL,
      filled REAL DEFAULT 0,
      status TEXT DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    )
  `);
  
  // Create indexes for orders
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_pair_status ON orders(pair_id, status)`);
  
  // DEX trades table
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      price REAL NOT NULL,
      amount REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    )
  `);
  
  // Create indexes for trades
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp)`);
  
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
      UNIQUE(token0, token1)
    )
  `);
  
  // Create indexes for liquidity_pools
  db.exec(`CREATE INDEX IF NOT EXISTS idx_liquidity_pools_tokens ON liquidity_pools(token0, token1)`);
  
  // Liquidity positions
  db.exec(`
    CREATE TABLE IF NOT EXISTS liquidity_positions (
      id TEXT PRIMARY KEY,
      poolId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      shares REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (poolId) REFERENCES liquidity_pools(id)
    )
  `);
  
  // Create indexes for liquidity_positions
  db.exec(`CREATE INDEX IF NOT EXISTS idx_liquidity_positions_poolId ON liquidity_positions(poolId)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_liquidity_positions_providerId ON liquidity_positions(providerId)`);
  
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
      result TEXT
    )
  `);
  
  // Create indexes for audit_logs
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_userId ON audit_logs(userId)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)`);
  
  // Performance logs
  db.exec(`
    CREATE TABLE IF NOT EXISTS performance_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      action TEXT NOT NULL,
      responseTime INTEGER NOT NULL,
      statusCode INTEGER
    )
  `);
  
  // Create indexes for performance_logs
  db.exec(`CREATE INDEX IF NOT EXISTS idx_performance_logs_timestamp ON performance_logs(timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_performance_logs_action ON performance_logs(action)`);
  
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
      failureCount INTEGER DEFAULT 0
    )
  `);
  
  // Create indexes for webhooks
  db.exec(`CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(active)`);
  
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
      error TEXT
    )
  `);
  
  // Create indexes for backup_history
  db.exec(`CREATE INDEX IF NOT EXISTS idx_backup_history_createdAt ON backup_history(createdAt)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_backup_history_status ON backup_history(status)`);
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
    'trades',
    'orders',
    'pending_payouts',
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