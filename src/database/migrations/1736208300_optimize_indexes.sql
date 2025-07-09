-- Migration: Optimize indexes
-- Created: 2025-01-07T00:05:00.000Z

-- UP
-- Add optimized indexes for query performance

-- Composite indexes for common queries
CREATE INDEX idx_shares_miner_created ON shares(miner_id, created_at DESC);
CREATE INDEX idx_shares_valid_created ON shares(is_valid, created_at DESC) WHERE is_valid = 1;
CREATE INDEX idx_shares_block_created ON shares(is_block, created_at DESC) WHERE is_block = 1;

-- Optimize miner lookups
CREATE INDEX idx_miners_active_balance ON miners(is_active, balance) WHERE is_active = 1;
CREATE INDEX idx_miners_active_lastseen ON miners(is_active, last_seen DESC) WHERE is_active = 1;

-- Payment processing optimization
CREATE INDEX idx_payments_pending ON payments(status, created_at) WHERE status = 'pending';
CREATE INDEX idx_payments_miner_status ON payments(miner_id, status, created_at DESC);

-- Worker statistics optimization
CREATE INDEX idx_worker_online ON worker_stats(is_online, updated_at DESC) WHERE is_online = 1;
CREATE INDEX idx_worker_miner_online ON worker_stats(miner_id, is_online, updated_at DESC);

-- Pool statistics time-series optimization
CREATE INDEX idx_pool_stats_hourly ON pool_stats(
    strftime('%Y-%m-%d %H:00:00', created_at),
    created_at DESC
);

-- Audit log search optimization
CREATE INDEX idx_audit_action_time ON audit_logs(action, created_at DESC);
CREATE INDEX idx_audit_ip_time ON audit_logs(ip_address, created_at DESC);

-- Full-text search preparation (SQLite FTS5)
CREATE VIRTUAL TABLE IF NOT EXISTS audit_logs_fts USING fts5(
    entity_type,
    action,
    old_values,
    new_values,
    content=audit_logs,
    content_rowid=id
);

-- Trigger to keep FTS index updated
CREATE TRIGGER IF NOT EXISTS audit_logs_fts_insert
AFTER INSERT ON audit_logs
BEGIN
    INSERT INTO audit_logs_fts(rowid, entity_type, action, old_values, new_values)
    VALUES (new.id, new.entity_type, new.action, new.old_values, new.new_values);
END;

CREATE TRIGGER IF NOT EXISTS audit_logs_fts_update
AFTER UPDATE ON audit_logs
BEGIN
    UPDATE audit_logs_fts
    SET entity_type = new.entity_type,
        action = new.action,
        old_values = new.old_values,
        new_values = new.new_values
    WHERE rowid = new.id;
END;

CREATE TRIGGER IF NOT EXISTS audit_logs_fts_delete
AFTER DELETE ON audit_logs
BEGIN
    DELETE FROM audit_logs_fts WHERE rowid = old.id;
END;

-- DOWN
-- Remove all optimization indexes
DROP INDEX IF EXISTS idx_shares_miner_created;
DROP INDEX IF EXISTS idx_shares_valid_created;
DROP INDEX IF EXISTS idx_shares_block_created;
DROP INDEX IF EXISTS idx_miners_active_balance;
DROP INDEX IF EXISTS idx_miners_active_lastseen;
DROP INDEX IF EXISTS idx_payments_pending;
DROP INDEX IF EXISTS idx_payments_miner_status;
DROP INDEX IF EXISTS idx_worker_online;
DROP INDEX IF EXISTS idx_worker_miner_online;
DROP INDEX IF EXISTS idx_pool_stats_hourly;
DROP INDEX IF EXISTS idx_audit_action_time;
DROP INDEX IF EXISTS idx_audit_ip_time;

-- Remove FTS
DROP TRIGGER IF EXISTS audit_logs_fts_delete;
DROP TRIGGER IF EXISTS audit_logs_fts_update;
DROP TRIGGER IF EXISTS audit_logs_fts_insert;
DROP TABLE IF EXISTS audit_logs_fts;
