-- PostgreSQL initialization script for Otedama P2P Mining Pool
-- This script sets up the initial database schema and configurations

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- Create custom types
CREATE TYPE mining_algorithm AS ENUM ('sha256', 'ethash', 'randomx', 'scrypt', 'kawpow', 'autolykos2');
CREATE TYPE worker_status AS ENUM ('active', 'inactive', 'banned');
CREATE TYPE payment_status AS ENUM ('pending', 'processing', 'completed', 'failed');
CREATE TYPE merger_status AS ENUM ('proposed', 'negotiating', 'approved', 'rejected', 'completed', 'cancelled');

-- Create main tables
CREATE TABLE IF NOT EXISTS miners (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    address VARCHAR(255) NOT NULL UNIQUE,
    email VARCHAR(255),
    password_hash VARCHAR(255),
    payment_threshold DECIMAL(20, 8) DEFAULT 0.001,
    auto_payout BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP WITH TIME ZONE,
    total_shares BIGINT DEFAULT 0,
    valid_shares BIGINT DEFAULT 0,
    invalid_shares BIGINT DEFAULT 0,
    stale_shares BIGINT DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    INDEX idx_miners_address (address),
    INDEX idx_miners_last_seen (last_seen)
);

CREATE TABLE IF NOT EXISTS workers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    miner_id UUID NOT NULL REFERENCES miners(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    status worker_status DEFAULT 'active',
    hashrate BIGINT DEFAULT 0,
    difficulty BIGINT DEFAULT 1,
    algorithm mining_algorithm NOT NULL,
    ip_address INET,
    user_agent VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_share TIMESTAMP WITH TIME ZONE,
    total_shares BIGINT DEFAULT 0,
    valid_shares BIGINT DEFAULT 0,
    invalid_shares BIGINT DEFAULT 0,
    stale_shares BIGINT DEFAULT 0,
    UNIQUE(miner_id, name),
    INDEX idx_workers_miner (miner_id),
    INDEX idx_workers_status (status),
    INDEX idx_workers_last_share (last_share)
);

CREATE TABLE IF NOT EXISTS shares (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    difficulty BIGINT NOT NULL,
    share_difficulty BIGINT NOT NULL,
    block_height BIGINT NOT NULL,
    hash VARCHAR(255) NOT NULL,
    is_valid BOOLEAN DEFAULT true,
    is_block BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_shares_worker (worker_id),
    INDEX idx_shares_created (created_at),
    INDEX idx_shares_block (is_block)
);

CREATE TABLE IF NOT EXISTS blocks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    height BIGINT NOT NULL,
    hash VARCHAR(255) NOT NULL UNIQUE,
    algorithm mining_algorithm NOT NULL,
    difficulty BIGINT NOT NULL,
    reward DECIMAL(20, 8) NOT NULL,
    finder_id UUID REFERENCES miners(id),
    is_orphan BOOLEAN DEFAULT false,
    is_confirmed BOOLEAN DEFAULT false,
    confirmations INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP WITH TIME ZONE,
    INDEX idx_blocks_height (height),
    INDEX idx_blocks_algorithm (algorithm),
    INDEX idx_blocks_confirmed (is_confirmed)
);

CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    miner_id UUID NOT NULL REFERENCES miners(id) ON DELETE CASCADE,
    amount DECIMAL(20, 8) NOT NULL,
    fee DECIMAL(20, 8) DEFAULT 0,
    currency VARCHAR(10) NOT NULL,
    tx_hash VARCHAR(255),
    status payment_status DEFAULT 'pending',
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE,
    INDEX idx_payments_miner (miner_id),
    INDEX idx_payments_status (status),
    INDEX idx_payments_created (created_at)
);

CREATE TABLE IF NOT EXISTS earnings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    miner_id UUID NOT NULL REFERENCES miners(id) ON DELETE CASCADE,
    block_id UUID NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    amount DECIMAL(20, 8) NOT NULL,
    shares BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_earnings_miner (miner_id),
    INDEX idx_earnings_block (block_id)
);

CREATE TABLE IF NOT EXISTS statistics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    algorithm mining_algorithm NOT NULL,
    period VARCHAR(20) NOT NULL, -- '5min', '1hour', '1day', '1week'
    hashrate BIGINT NOT NULL,
    difficulty BIGINT NOT NULL,
    active_workers INT NOT NULL,
    active_miners INT NOT NULL,
    total_shares BIGINT NOT NULL,
    valid_shares BIGINT NOT NULL,
    blocks_found INT DEFAULT 0,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_statistics_algorithm (algorithm),
    INDEX idx_statistics_period (period),
    INDEX idx_statistics_timestamp (timestamp)
);

CREATE TABLE IF NOT EXISTS federation_peers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    node_id VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    url VARCHAR(255) NOT NULL,
    public_key TEXT NOT NULL,
    trust_score DECIMAL(3, 2) DEFAULT 0.5,
    is_active BOOLEAN DEFAULT true,
    last_seen TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_federation_active (is_active),
    INDEX idx_federation_trust (trust_score)
);

CREATE TABLE IF NOT EXISTS mergers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    initiator_pool_id VARCHAR(255) NOT NULL,
    target_pool_id VARCHAR(255) NOT NULL,
    status merger_status DEFAULT 'proposed',
    terms JSONB NOT NULL,
    due_diligence_data JSONB,
    user_consent_required BOOLEAN DEFAULT true,
    user_consent_percentage DECIMAL(5, 2) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,
    INDEX idx_mergers_status (status),
    INDEX idx_mergers_created (created_at)
);

-- Create indexes for performance
CREATE INDEX idx_shares_time_range ON shares (created_at, worker_id);
CREATE INDEX idx_workers_hashrate ON workers (hashrate DESC);
CREATE INDEX idx_miners_earnings ON earnings (miner_id, created_at DESC);
CREATE INDEX idx_blocks_recent ON blocks (created_at DESC) WHERE is_confirmed = true;

-- Create functions for automatic timestamp updates
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply update triggers
CREATE TRIGGER update_miners_updated_at BEFORE UPDATE ON miners
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_workers_updated_at BEFORE UPDATE ON workers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_federation_peers_updated_at BEFORE UPDATE ON federation_peers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_mergers_updated_at BEFORE UPDATE ON mergers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create materialized views for performance
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_miner_stats AS
SELECT 
    m.id,
    m.address,
    COUNT(DISTINCT w.id) as worker_count,
    SUM(w.hashrate) as total_hashrate,
    SUM(w.valid_shares) as total_valid_shares,
    SUM(w.invalid_shares) as total_invalid_shares,
    MAX(w.last_share) as last_activity,
    COALESCE(SUM(e.amount), 0) as total_earned,
    COALESCE(SUM(p.amount), 0) as total_paid
FROM miners m
LEFT JOIN workers w ON m.id = w.miner_id AND w.status = 'active'
LEFT JOIN earnings e ON m.id = e.miner_id
LEFT JOIN payments p ON m.id = p.miner_id AND p.status = 'completed'
GROUP BY m.id, m.address;

CREATE INDEX idx_mv_miner_stats_address ON mv_miner_stats (address);
CREATE INDEX idx_mv_miner_stats_hashrate ON mv_miner_stats (total_hashrate DESC);

-- Create performance optimization configurations
ALTER SYSTEM SET shared_buffers = '1GB';
ALTER SYSTEM SET effective_cache_size = '3GB';
ALTER SYSTEM SET maintenance_work_mem = '256MB';
ALTER SYSTEM SET checkpoint_completion_target = '0.9';
ALTER SYSTEM SET wal_buffers = '16MB';
ALTER SYSTEM SET default_statistics_target = '100';
ALTER SYSTEM SET random_page_cost = '1.1';
ALTER SYSTEM SET effective_io_concurrency = '200';
ALTER SYSTEM SET work_mem = '16MB';
ALTER SYSTEM SET min_wal_size = '1GB';
ALTER SYSTEM SET max_wal_size = '4GB';

-- Enable query performance tracking
ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';
ALTER SYSTEM SET pg_stat_statements.track = 'all';

-- Create read-only user for monitoring
CREATE USER otedama_readonly WITH PASSWORD 'readonly_password_change_me';
GRANT CONNECT ON DATABASE otedama TO otedama_readonly;
GRANT USAGE ON SCHEMA public TO otedama_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO otedama_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO otedama_readonly;

-- Initial data
INSERT INTO statistics (algorithm, period, hashrate, difficulty, active_workers, active_miners, total_shares, valid_shares, timestamp)
VALUES 
    ('sha256', '5min', 0, 1, 0, 0, 0, 0, CURRENT_TIMESTAMP),
    ('ethash', '5min', 0, 1, 0, 0, 0, 0, CURRENT_TIMESTAMP),
    ('randomx', '5min', 0, 1, 0, 0, 0, 0, CURRENT_TIMESTAMP),
    ('scrypt', '5min', 0, 1, 0, 0, 0, 0, CURRENT_TIMESTAMP),
    ('kawpow', '5min', 0, 1, 0, 0, 0, 0, CURRENT_TIMESTAMP),
    ('autolykos2', '5min', 0, 1, 0, 0, 0, 0, CURRENT_TIMESTAMP);

-- Vacuum and analyze for initial optimization
VACUUM ANALYZE;