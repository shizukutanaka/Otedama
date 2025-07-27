/**
 * Performance Optimization Migration
 * Adds indexes for frequently queried columns
 * 
 * This migration improves query performance for:
 * - Miner lookups
 * - Share validation queries
 * - Block retrieval
 * - Payment processing
 * - Time-based queries
 */

export async function up(db) {
  console.log('Adding performance indexes...');
  
  // Miners table indexes
  // Index for looking up miners by address
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_miners_address 
    ON miners(address);
  `);
  
  // Index for looking up miners by worker name
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_miners_worker 
    ON miners(worker);
  `);
  
  // Composite index for address + worker lookup
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_miners_address_worker 
    ON miners(address, worker);
  `);
  
  // Index for active miners (frequently filtered)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_miners_last_share_time 
    ON miners(last_share_time);
  `);
  
  // Shares table indexes
  // Index for time-based queries (most common)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_shares_timestamp 
    ON shares(timestamp DESC);
  `);
  
  // Index for miner's shares lookup
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_shares_miner_id_timestamp 
    ON shares(miner_id, timestamp DESC);
  `);
  
  // Index for valid shares (for statistics)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_shares_is_valid 
    ON shares(is_valid) 
    WHERE is_valid = 1;
  `);
  
  // Index for block shares
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_shares_is_block 
    ON shares(is_block) 
    WHERE is_block = 1;
  `);
  
  // Composite index for share validation queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_shares_job_nonce 
    ON shares(job_id, nonce);
  `);
  
  // Blocks table indexes
  // Index for hash lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_blocks_hash 
    ON blocks(hash);
  `);
  
  // Index for orphan status
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_blocks_is_orphan 
    ON blocks(is_orphan);
  `);
  
  // Index for unconfirmed blocks
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_blocks_confirmations 
    ON blocks(confirmations) 
    WHERE confirmations < 100;
  `);
  
  // Index for time-based block queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_blocks_timestamp 
    ON blocks(timestamp DESC);
  `);
  
  // Payments table indexes
  // Index for pending payments
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_payments_status 
    ON payments(status) 
    WHERE status = 'pending';
  `);
  
  // Index for miner payment history
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_payments_miner_id_created 
    ON payments(miner_id, created_at DESC);
  `);
  
  // Index for transaction tracking
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_payments_transaction_id 
    ON payments(transaction_id) 
    WHERE transaction_id IS NOT NULL;
  `);
  
  // Settings table index (though small, helps with frequent lookups)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_settings_updated 
    ON settings(updated_at DESC);
  `);
  
  // Create a view for active miners (last 24 hours)
  db.exec(`
    CREATE VIEW IF NOT EXISTS active_miners AS
    SELECT 
      m.*,
      COUNT(s.id) as recent_shares,
      AVG(s.difficulty) as avg_difficulty,
      MAX(s.timestamp) as last_share_timestamp
    FROM miners m
    LEFT JOIN shares s ON m.id = s.miner_id 
      AND s.timestamp > strftime('%s', 'now', '-24 hours')
    WHERE m.last_share_time > strftime('%s', 'now', '-24 hours')
    GROUP BY m.id;
  `);
  
  // Create a materialized view for hourly statistics
  db.exec(`
    CREATE TABLE IF NOT EXISTS hourly_stats (
      hour_timestamp INTEGER PRIMARY KEY,
      total_shares INTEGER,
      valid_shares INTEGER,
      total_difficulty REAL,
      unique_miners INTEGER,
      blocks_found INTEGER
    );
    
    CREATE INDEX IF NOT EXISTS idx_hourly_stats_timestamp 
    ON hourly_stats(hour_timestamp DESC);
  `);
  
  // Analyze tables to update statistics
  db.exec('ANALYZE miners;');
  db.exec('ANALYZE shares;');
  db.exec('ANALYZE blocks;');
  db.exec('ANALYZE payments;');
  
  console.log('Performance indexes added successfully');
}

export async function down(db) {
  console.log('Removing performance indexes...');
  
  // Drop indexes
  const indexes = [
    'idx_miners_address',
    'idx_miners_worker',
    'idx_miners_address_worker',
    'idx_miners_last_share_time',
    'idx_shares_timestamp',
    'idx_shares_miner_id_timestamp',
    'idx_shares_is_valid',
    'idx_shares_is_block',
    'idx_shares_job_nonce',
    'idx_blocks_hash',
    'idx_blocks_is_orphan',
    'idx_blocks_confirmations',
    'idx_blocks_timestamp',
    'idx_payments_status',
    'idx_payments_miner_id_created',
    'idx_payments_transaction_id',
    'idx_settings_updated',
    'idx_hourly_stats_timestamp'
  ];
  
  for (const index of indexes) {
    db.exec(`DROP INDEX IF EXISTS ${index};`);
  }
  
  // Drop views
  db.exec('DROP VIEW IF EXISTS active_miners;');
  db.exec('DROP TABLE IF EXISTS hourly_stats;');
  
  console.log('Performance indexes removed');
}

// Export migration info
export const info = {
  version: '20250127',
  description: 'Add performance indexes for faster queries',
  checksum: 'a1b2c3d4e5f6' // Would be calculated in production
};