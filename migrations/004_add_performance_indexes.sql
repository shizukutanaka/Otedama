-- Migration: Add Critical Performance Indexes
-- Description: Adds missing composite and partial indexes for query optimization
-- Author: Otedama Team
-- Date: 2025-07-21

-- ============================================
-- Composite Indexes for Complex Queries
-- ============================================

-- Transactions table composite indexes
CREATE INDEX IF NOT EXISTS idx_transactions_user_currency_status_timestamp 
  ON transactions(user_id, currency, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_user_status_created 
  ON transactions(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_currency_status_amount 
  ON transactions(currency, status, amount);

-- Partial index for pending transactions (frequently queried)
CREATE INDEX IF NOT EXISTS idx_transactions_pending 
  ON transactions(user_id, created_at DESC) 
  WHERE status = 'pending';

-- Orders table composite indexes
CREATE INDEX IF NOT EXISTS idx_orders_user_pair_status_created 
  ON orders(user_id, pair, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_pair_side_price_status 
  ON orders(pair, side, price, status) 
  WHERE status IN ('open', 'partial');

CREATE INDEX IF NOT EXISTS idx_orders_user_status_updated 
  ON orders(user_id, status, updated_at DESC);

-- Partial index for active orders
CREATE INDEX IF NOT EXISTS idx_orders_active 
  ON orders(pair, side, price, created_at) 
  WHERE status IN ('open', 'partial');

-- Mining sessions composite indexes
CREATE INDEX IF NOT EXISTS idx_mining_sessions_user_active 
  ON mining_sessions(user_id, algorithm, start_time DESC) 
  WHERE end_time IS NULL;

CREATE INDEX IF NOT EXISTS idx_mining_sessions_user_algorithm_time 
  ON mining_sessions(user_id, algorithm, start_time DESC);

CREATE INDEX IF NOT EXISTS idx_mining_sessions_worker_active 
  ON mining_sessions(worker_name, start_time DESC) 
  WHERE end_time IS NULL;

-- ============================================
-- Specialized Indexes for Specific Queries
-- ============================================

-- API rate limiting queries
CREATE INDEX IF NOT EXISTS idx_api_keys_user_active 
  ON api_keys(user_id, created_at DESC) 
  WHERE is_active = 1;

-- Session management queries
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active 
  ON user_sessions(user_id, last_activity DESC) 
  WHERE expires_at > datetime('now');

CREATE INDEX IF NOT EXISTS idx_user_sessions_token_active 
  ON user_sessions(session_token) 
  WHERE expires_at > datetime('now');

-- Audit log queries
CREATE INDEX IF NOT EXISTS idx_audit_log_user_time 
  ON audit_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_resource_time 
  ON audit_log(resource, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_action_time 
  ON audit_log(action, created_at DESC);

-- ============================================
-- DEX and Trading Specific Indexes
-- ============================================

-- Liquidity pools indexes
CREATE INDEX IF NOT EXISTS idx_liquidity_pools_pair_reserves 
  ON liquidity_pools(pair, reserve0, reserve1);

CREATE INDEX IF NOT EXISTS idx_liquidity_pools_total_supply 
  ON liquidity_pools(total_supply DESC);

-- Trade history indexes (if table exists)
CREATE INDEX IF NOT EXISTS idx_trades_pair_time 
  ON trades(pair, executed_at DESC);

CREATE INDEX IF NOT EXISTS idx_trades_user_time 
  ON trades(user_id, executed_at DESC);

-- ============================================
-- Wallet and Balance Indexes
-- ============================================

-- Wallet balance queries
CREATE INDEX IF NOT EXISTS idx_wallets_user_currency_balance 
  ON wallets(user_id, currency, balance DESC);

CREATE INDEX IF NOT EXISTS idx_wallets_currency_balance 
  ON wallets(currency, balance DESC) 
  WHERE balance > 0;

-- ============================================
-- Mining Pool Specific Indexes
-- ============================================

-- Share submission queries
CREATE INDEX IF NOT EXISTS idx_shares_user_time 
  ON mining_shares(user_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_shares_worker_time 
  ON mining_shares(worker_name, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_shares_user_valid_time 
  ON mining_shares(user_id, submitted_at DESC) 
  WHERE is_valid = 1;

-- Block discovery queries
CREATE INDEX IF NOT EXISTS idx_blocks_height_hash 
  ON blocks(height DESC, hash);

CREATE INDEX IF NOT EXISTS idx_blocks_found_by_time 
  ON blocks(found_by, found_at DESC);

-- ============================================
-- Security and Authentication Indexes
-- ============================================

-- Login attempt tracking
CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier_time 
  ON login_attempts(identifier, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time 
  ON login_attempts(ip_address, attempted_at DESC);

-- Password reset tracking
CREATE INDEX IF NOT EXISTS idx_password_resets_user_time 
  ON password_resets(user_id, created_at DESC) 
  WHERE used_at IS NULL;

-- ============================================
-- Notification and Event Indexes
-- ============================================

-- Event tracking (if table exists)
CREATE INDEX IF NOT EXISTS idx_events_user_type_time 
  ON events(user_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_type_time 
  ON events(event_type, created_at DESC);

-- ============================================
-- Performance and Monitoring Indexes
-- ============================================

-- System metrics queries
CREATE INDEX IF NOT EXISTS idx_system_metrics_name_time 
  ON system_metrics(metric_name, created_at DESC);

-- Request logs (if table exists)
CREATE INDEX IF NOT EXISTS idx_request_logs_endpoint_time 
  ON request_logs(endpoint, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_request_logs_user_time 
  ON request_logs(user_id, timestamp DESC) 
  WHERE user_id IS NOT NULL;

-- ============================================
-- Analyze Tables for Query Optimization
-- ============================================

-- Update SQLite's internal statistics
ANALYZE users;
ANALYZE transactions;
ANALYZE orders;
ANALYZE mining_sessions;
ANALYZE mining_shares;
ANALYZE wallets;
ANALYZE user_sessions;
ANALYZE api_keys;
ANALYZE audit_log;
ANALYZE liquidity_pools;

-- ============================================
-- Migration Metadata
-- ============================================

-- Record migration completion
INSERT INTO migration_metadata (version, name, description, applied_at)
VALUES ('004', 'add_performance_indexes', 'Added critical performance indexes for query optimization', datetime('now'));