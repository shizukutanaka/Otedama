-- Add currency support to existing tables

-- Add currency to shares table
ALTER TABLE shares ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'BTC';
ALTER TABLE shares ADD COLUMN IF NOT EXISTS algorithm VARCHAR(50);
ALTER TABLE shares ADD COLUMN IF NOT EXISTS paid BOOLEAN DEFAULT FALSE;

-- Add index for currency queries
CREATE INDEX IF NOT EXISTS idx_shares_currency ON shares(currency);
CREATE INDEX IF NOT EXISTS idx_shares_currency_created ON shares(currency, created_at);
CREATE INDEX IF NOT EXISTS idx_shares_worker_currency ON shares(worker_id, currency);

-- Add currency to blocks table
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'BTC';
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS processed BOOLEAN DEFAULT FALSE;

-- Add index for currency queries
CREATE INDEX IF NOT EXISTS idx_blocks_currency ON blocks(currency);
CREATE INDEX IF NOT EXISTS idx_blocks_currency_status ON blocks(currency, status);
CREATE INDEX IF NOT EXISTS idx_blocks_currency_processed ON blocks(currency, processed);

-- Add currency to workers table
ALTER TABLE workers ADD COLUMN IF NOT EXISTS currencies TEXT; -- JSON array of enabled currencies

-- Update payouts table (already has currency field)
-- Add index for currency queries
CREATE INDEX IF NOT EXISTS idx_payouts_currency ON payouts(currency);
CREATE INDEX IF NOT EXISTS idx_payouts_currency_status ON payouts(currency, status);
CREATE INDEX IF NOT EXISTS idx_payouts_worker_currency ON payouts(worker_id, currency);

-- Create currency stats table
CREATE TABLE IF NOT EXISTS currency_stats (
    id SERIAL PRIMARY KEY,
    currency VARCHAR(10) NOT NULL,
    total_hashrate DOUBLE PRECISION DEFAULT 0,
    active_workers INTEGER DEFAULT 0,
    blocks_found INTEGER DEFAULT 0,
    total_paid BIGINT DEFAULT 0,
    last_block_time TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(currency)
);

-- Create exchange rates table
CREATE TABLE IF NOT EXISTS exchange_rates (
    id SERIAL PRIMARY KEY,
    currency VARCHAR(10) NOT NULL,
    rate_usd DOUBLE PRECISION NOT NULL,
    rate_btc DOUBLE PRECISION,
    source VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_rates_currency_created (currency, created_at)
);

-- Create currency configuration table
CREATE TABLE IF NOT EXISTS currency_configs (
    id SERIAL PRIMARY KEY,
    currency VARCHAR(10) NOT NULL UNIQUE,
    enabled BOOLEAN DEFAULT TRUE,
    min_payout BIGINT NOT NULL,
    payout_fee BIGINT NOT NULL,
    pool_fee_percent DOUBLE PRECISION DEFAULT 2.0,
    confirmations INTEGER DEFAULT 100,
    payout_interval INTEGER DEFAULT 3600, -- seconds
    extra_config TEXT, -- JSON for algorithm-specific config
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default currency configurations
INSERT INTO currency_configs (currency, min_payout, payout_fee, confirmations) VALUES 
    ('BTC', 10000000, 10000, 100),      -- 0.1 BTC min, 0.0001 BTC fee
    ('LTC', 10000000, 10000, 6),        -- 0.1 LTC min, 0.0001 LTC fee
    ('ETH', 100000000000000000, 1000000000000000, 12), -- 0.1 ETH min, 0.001 ETH fee
    ('BCH', 10000000, 1000, 6),         -- 0.1 BCH min, 0.00001 BCH fee
    ('XMR', 100000000000, 1000000000, 10) -- 0.1 XMR min, 0.001 XMR fee
ON CONFLICT (currency) DO NOTHING;

-- Add functions for currency statistics

-- Function to update currency stats
CREATE OR REPLACE FUNCTION update_currency_stats() RETURNS TRIGGER AS $$
BEGIN
    -- Update stats when blocks are found
    IF TG_TABLE_NAME = 'blocks' AND NEW.status = 'confirmed' THEN
        INSERT INTO currency_stats (currency, blocks_found, last_block_time)
        VALUES (NEW.currency, 1, NEW.timestamp)
        ON CONFLICT (currency) DO UPDATE SET
            blocks_found = currency_stats.blocks_found + 1,
            last_block_time = NEW.timestamp,
            updated_at = CURRENT_TIMESTAMP;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for updating currency stats
CREATE TRIGGER update_currency_stats_trigger
AFTER INSERT OR UPDATE ON blocks
FOR EACH ROW
EXECUTE FUNCTION update_currency_stats();

-- Add view for multi-currency pool stats
CREATE OR REPLACE VIEW pool_stats_by_currency AS
SELECT 
    c.currency,
    c.enabled,
    COALESCE(cs.total_hashrate, 0) as hashrate,
    COALESCE(cs.active_workers, 0) as workers,
    COALESCE(cs.blocks_found, 0) as blocks_24h,
    COALESCE(cs.total_paid, 0) as total_paid,
    cs.last_block_time,
    COALESCE(er.rate_usd, 0) as exchange_rate_usd
FROM currency_configs c
LEFT JOIN currency_stats cs ON c.currency = cs.currency
LEFT JOIN (
    SELECT DISTINCT ON (currency) currency, rate_usd 
    FROM exchange_rates 
    ORDER BY currency, created_at DESC
) er ON c.currency = er.currency
WHERE c.enabled = TRUE;