-- Migration: Initial schema
-- Created: 2025-01-07T00:00:00.000Z

-- UP
-- Create basic tables for the mining pool

-- Miners table
CREATE TABLE IF NOT EXISTS miners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    username TEXT,
    password_hash TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP,
    total_shares INTEGER DEFAULT 0,
    valid_shares INTEGER DEFAULT 0,
    invalid_shares INTEGER DEFAULT 0,
    hash_rate REAL DEFAULT 0,
    balance REAL DEFAULT 0,
    total_paid REAL DEFAULT 0,
    minimum_payout REAL DEFAULT 0.01,
    email TEXT,
    is_active BOOLEAN DEFAULT 1,
    INDEX idx_miners_address (address),
    INDEX idx_miners_last_seen (last_seen)
);

-- Shares table
CREATE TABLE IF NOT EXISTS shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    miner_id INTEGER NOT NULL,
    job_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    hash TEXT NOT NULL,
    difficulty REAL NOT NULL,
    share_difficulty REAL NOT NULL,
    is_valid BOOLEAN DEFAULT 1,
    is_block BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (miner_id) REFERENCES miners(id),
    INDEX idx_shares_miner_id (miner_id),
    INDEX idx_shares_created_at (created_at),
    INDEX idx_shares_is_block (is_block)
);

-- Blocks table
CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    height INTEGER NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    previous_hash TEXT,
    miner_id INTEGER NOT NULL,
    share_id INTEGER,
    reward REAL NOT NULL,
    difficulty REAL NOT NULL,
    confirmations INTEGER DEFAULT 0,
    is_orphaned BOOLEAN DEFAULT 0,
    found_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP,
    FOREIGN KEY (miner_id) REFERENCES miners(id),
    FOREIGN KEY (share_id) REFERENCES shares(id),
    INDEX idx_blocks_height (height),
    INDEX idx_blocks_hash (hash),
    INDEX idx_blocks_found_at (found_at)
);

-- Payments table
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    miner_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    fee REAL DEFAULT 0,
    transaction_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP,
    error_message TEXT,
    FOREIGN KEY (miner_id) REFERENCES miners(id),
    INDEX idx_payments_miner_id (miner_id),
    INDEX idx_payments_status (status),
    INDEX idx_payments_created_at (created_at)
);

-- Worker statistics table
CREATE TABLE IF NOT EXISTS worker_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    miner_id INTEGER NOT NULL,
    worker_name TEXT NOT NULL,
    hash_rate REAL DEFAULT 0,
    shares_submitted INTEGER DEFAULT 0,
    shares_accepted INTEGER DEFAULT 0,
    last_share_time TIMESTAMP,
    is_online BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (miner_id) REFERENCES miners(id),
    UNIQUE(miner_id, worker_name),
    INDEX idx_worker_stats_miner_id (miner_id),
    INDEX idx_worker_stats_updated_at (updated_at)
);

-- Pool statistics table
CREATE TABLE IF NOT EXISTS pool_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total_hash_rate REAL DEFAULT 0,
    active_miners INTEGER DEFAULT 0,
    active_workers INTEGER DEFAULT 0,
    total_shares INTEGER DEFAULT 0,
    blocks_found INTEGER DEFAULT 0,
    total_paid REAL DEFAULT 0,
    round_shares INTEGER DEFAULT 0,
    network_difficulty REAL,
    network_hash_rate REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_pool_stats_created_at (created_at)
);

-- Audit log table
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    action TEXT NOT NULL,
    user_id INTEGER,
    ip_address TEXT,
    user_agent TEXT,
    old_values TEXT,
    new_values TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_logs_entity (entity_type, entity_id),
    INDEX idx_audit_logs_created_at (created_at)
);

-- DOWN
-- Drop all tables
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS pool_stats;
DROP TABLE IF EXISTS worker_stats;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS blocks;
DROP TABLE IF EXISTS shares;
DROP TABLE IF EXISTS miners;
