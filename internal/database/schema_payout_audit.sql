-- Comprehensive payout audit system schema
-- This schema provides complete audit trails for all payout operations

-- Payout audit log table
CREATE TABLE IF NOT EXISTS payout_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payout_id INTEGER NOT NULL,
    action VARCHAR(50) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    operator_id INTEGER,
    ip_address VARCHAR(45),
    user_agent TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (payout_id) REFERENCES payouts(id)
);

-- Operator fee tracking
CREATE TABLE IF NOT EXISTS operator_fees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    currency VARCHAR(10) NOT NULL,
    fee_percentage DECIMAL(5,4) NOT NULL,
    total_fees DECIMAL(20,8) DEFAULT 0,
    total_payouts DECIMAL(20,8) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Payout batch tracking
CREATE TABLE IF NOT EXISTS payout_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id VARCHAR(64) NOT NULL UNIQUE,
    currency VARCHAR(10) NOT NULL,
    total_amount DECIMAL(20,8) NOT NULL,
    total_fees DECIMAL(20,8) NOT NULL,
    operator_fee DECIMAL(20,8) NOT NULL,
    miner_count INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    completed_at DATETIME
);

-- Batch payout relationship
CREATE TABLE IF NOT EXISTS batch_payouts (
    batch_id VARCHAR(64) NOT NULL,
    payout_id INTEGER NOT NULL,
    PRIMARY KEY (batch_id, payout_id),
    FOREIGN KEY (batch_id) REFERENCES payout_batches(batch_id),
    FOREIGN KEY (payout_id) REFERENCES payouts(id)
);

-- Wallet validation log
CREATE TABLE IF NOT EXISTS wallet_validation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id INTEGER NOT NULL,
    wallet_address VARCHAR(255) NOT NULL,
    currency VARCHAR(10) NOT NULL,
    validation_result BOOLEAN NOT NULL,
    validation_error TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (worker_id) REFERENCES workers(id)
);

-- Transaction confirmation tracking
CREATE TABLE IF NOT EXISTS transaction_confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id VARCHAR(255) NOT NULL,
    currency VARCHAR(10) NOT NULL,
    confirmations INTEGER NOT NULL,
    required_confirmations INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL,
    last_check DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmed_at DATETIME,
    FOREIGN KEY (tx_id) REFERENCES payouts(tx_id)
);

-- Operator compensation tracking
CREATE TABLE IF NOT EXISTS operator_compensation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id VARCHAR(64) NOT NULL,
    currency VARCHAR(10) NOT NULL,
    amount DECIMAL(20,8) NOT NULL,
    wallet_address VARCHAR(255) NOT NULL,
    tx_id VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    FOREIGN KEY (batch_id) REFERENCES payout_batches(batch_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_payout_audit_payout_id ON payout_audit(payout_id);
CREATE INDEX IF NOT EXISTS idx_payout_audit_timestamp ON payout_audit(timestamp);
CREATE INDEX IF NOT EXISTS idx_payout_batches_status ON payout_batches(status);
CREATE INDEX IF NOT EXISTS idx_payout_batches_currency ON payout_batches(currency);
CREATE INDEX IF NOT EXISTS idx_wallet_validation_worker ON wallet_validation_log(worker_id);
CREATE INDEX IF NOT EXISTS idx_transaction_confirmations_tx ON transaction_confirmations(tx_id);
CREATE INDEX IF NOT EXISTS idx_operator_compensation_batch ON operator_compensation(batch_id);

-- Views for reporting
CREATE VIEW IF NOT EXISTS payout_summary AS
SELECT 
    p.id,
    p.worker_id,
    w.name as worker_name,
    p.amount,
    p.tx_id,
    p.status,
    p.created_at,
    w.wallet_address,
    CASE 
        WHEN p.status = 'completed' THEN 'Paid'
        WHEN p.status = 'pending' THEN 'Pending'
        WHEN p.status = 'failed' THEN 'Failed'
        ELSE p.status
    END as display_status
FROM payouts p
JOIN workers w ON p.worker_id = w.id;

CREATE VIEW IF NOT EXISTS operator_revenue AS
SELECT 
    pb.currency,
    SUM(pb.operator_fee) as total_operator_fees,
    COUNT(*) as total_batches,
    AVG(pb.operator_fee) as avg_fee_per_batch,
    SUM(pb.total_amount) as total_payout_volume,
    pb.created_at
FROM payout_batches pb
WHERE pb.status = 'completed'
GROUP BY pb.currency;

CREATE VIEW IF NOT EXISTS miner_payout_history AS
SELECT 
    w.name as worker_name,
    w.wallet_address,
    p.amount,
    p.tx_id,
    p.status,
    p.created_at,
    CASE 
        WHEN p.status = 'completed' THEN 'Paid'
        ELSE 'Pending'
    END as payment_status
FROM payouts p
JOIN workers w ON p.worker_id = w.id
ORDER BY p.created_at DESC;
