/**
 * Migration: Performance Optimization Indexes
 * Version: 20250120120000
 * Created: 2025-01-20T12:00:00.000Z
 * 
 * Adds additional indexes for query performance optimization
 */

export const version = '20250120120000';
export const name = 'Performance Optimization Indexes';

/**
 * Run the migration - Add performance indexes
 */
export function up(db) {
  // Composite indexes for common query patterns
  
  // Miners table - Frequently queried combinations
  db.exec(`CREATE INDEX IF NOT EXISTS idx_miners_currency_lastseen ON miners(currency, lastSeen DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_miners_address_currency ON miners(address, currency)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_miners_algorithm_lastseen ON miners(algorithm, lastSeen DESC)`);
  
  // Shares table - Performance critical queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shares_miner_status_timestamp ON shares(miner_id, status, timestamp DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shares_valid_timestamp ON shares(valid, timestamp DESC) WHERE valid = 1`);
  
  // Transactions table - Financial queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_minerId_status_timestamp ON transactions(minerId, status, timestamp DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_currency_status ON transactions(currency, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_type_timestamp ON transactions(type, timestamp DESC)`);
  
  // Sessions table - Auth performance
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_minerId_expiresAt ON sessions(minerId, expiresAt)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_lastActivity ON sessions(lastActivity DESC)`);
  
  // Orders table (DEX) - Trading performance
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_pair_side_status ON orders(pair_id, side, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC) WHERE status = 'open'`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_price_amount ON orders(price, amount) WHERE status = 'open'`);
  
  // Trades table - Historical queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_order_timestamp ON trades(order_id, timestamp DESC)`);
  
  // Liquidity positions - Provider queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_liquidity_positions_provider_pool ON liquidity_positions(providerId, poolId)`);
  
  // Audit logs - Security queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_ip_timestamp ON audit_logs(ip, timestamp DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_action ON audit_logs(resource, action)`);
  
  // Performance logs - Monitoring queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_performance_logs_action_timestamp ON performance_logs(action, timestamp DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_performance_logs_responseTime ON performance_logs(responseTime) WHERE responseTime > 100`);
  
  // Backup history - Maintenance queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_backup_history_type_status ON backup_history(type, status)`);
  
  // Add table statistics update
  db.exec(`ANALYZE`);
}

/**
 * Rollback the migration - Remove performance indexes
 */
export function down(db) {
  // Drop all performance optimization indexes
  const indexes = [
    'idx_miners_currency_lastseen',
    'idx_miners_address_currency',
    'idx_miners_algorithm_lastseen',
    'idx_shares_miner_status_timestamp',
    'idx_shares_valid_timestamp',
    'idx_transactions_minerId_status_timestamp',
    'idx_transactions_currency_status',
    'idx_transactions_type_timestamp',
    'idx_sessions_minerId_expiresAt',
    'idx_sessions_lastActivity',
    'idx_orders_pair_side_status',
    'idx_orders_status_created',
    'idx_orders_price_amount',
    'idx_trades_order_timestamp',
    'idx_liquidity_positions_provider_pool',
    'idx_audit_logs_ip_timestamp',
    'idx_audit_logs_resource_action',
    'idx_performance_logs_action_timestamp',
    'idx_performance_logs_responseTime',
    'idx_backup_history_type_status'
  ];
  
  for (const index of indexes) {
    db.exec(`DROP INDEX IF EXISTS ${index}`);
  }
}