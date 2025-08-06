-- Create fee distributions table
CREATE TABLE IF NOT EXISTS fee_distributions (
    id SERIAL PRIMARY KEY,
    currency VARCHAR(10) NOT NULL,
    block_height BIGINT NOT NULL,
    total_fees TEXT NOT NULL, -- Store as string for big integers
    operator_fee TEXT NOT NULL,
    development_fee TEXT NOT NULL,
    reserve_fee TEXT NOT NULL,
    tx_id VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    
    INDEX idx_fee_dist_currency (currency),
    INDEX idx_fee_dist_status (status),
    INDEX idx_fee_dist_created (created_at)
);

-- Add pool fee configuration to currency_configs
ALTER TABLE currency_configs 
ADD COLUMN IF NOT EXISTS operator_address VARCHAR(100),
ADD COLUMN IF NOT EXISTS pool_fee_address VARCHAR(100);

-- Create fee accumulation tracking
CREATE TABLE IF NOT EXISTS fee_accumulations (
    id SERIAL PRIMARY KEY,
    currency VARCHAR(10) NOT NULL,
    block_height BIGINT NOT NULL,
    block_reward BIGINT NOT NULL,
    pool_fee BIGINT NOT NULL,
    tx_fees BIGINT DEFAULT 0,
    distributed BOOLEAN DEFAULT FALSE,
    distribution_id BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_fee_acc_currency (currency),
    INDEX idx_fee_acc_distributed (distributed),
    INDEX idx_fee_acc_created (created_at),
    FOREIGN KEY (distribution_id) REFERENCES fee_distributions(id)
);

-- Function to track fee accumulation
CREATE OR REPLACE FUNCTION track_fee_accumulation() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'confirmed' THEN
        -- Get pool fee percentage (default 2%)
        DECLARE pool_fee_percent DOUBLE PRECISION;
        SELECT COALESCE(pool_fee_percent, 2.0) INTO pool_fee_percent
        FROM currency_configs
        WHERE currency = NEW.currency;
        
        -- Calculate pool fee
        INSERT INTO fee_accumulations (
            currency, block_height, block_reward, pool_fee
        ) VALUES (
            NEW.currency,
            NEW.height,
            NEW.reward,
            (NEW.reward * pool_fee_percent / 100)::BIGINT
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for fee accumulation
CREATE TRIGGER track_fee_accumulation_trigger
AFTER INSERT OR UPDATE ON blocks
FOR EACH ROW
EXECUTE FUNCTION track_fee_accumulation();

-- Add view for fee distribution summary
CREATE OR REPLACE VIEW fee_distribution_summary AS
SELECT 
    fd.currency,
    COUNT(*) as distribution_count,
    SUM(CAST(fd.total_fees AS BIGINT)) as total_distributed,
    SUM(CAST(fd.operator_fee AS BIGINT)) as total_operator_fees,
    SUM(CAST(fd.development_fee AS BIGINT)) as total_development_fees,
    SUM(CAST(fd.reserve_fee AS BIGINT)) as total_reserve_fees,
    MAX(fd.created_at) as last_distribution
FROM fee_distributions fd
WHERE fd.status = 'completed'
GROUP BY fd.currency;

-- Add view for pending fee accumulations
CREATE OR REPLACE VIEW pending_fee_accumulations AS
SELECT 
    fa.currency,
    COUNT(*) as block_count,
    SUM(fa.pool_fee) as total_pending_fees,
    MIN(fa.created_at) as oldest_block,
    MAX(fa.block_height) as latest_block
FROM fee_accumulations fa
WHERE fa.distributed = FALSE
GROUP BY fa.currency;