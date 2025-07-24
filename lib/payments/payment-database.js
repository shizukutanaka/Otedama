/**
 * Payment Database Manager
 * Handles all database operations for the payment system
 */

const { Pool } = require('pg');
const { createLogger } = require('../core/logger');
const BigNumber = require('bignumber.js');

const logger = createLogger('payment-database');

class PaymentDatabase {
  constructor(options = {}) {
    this.options = {
      host: options.host || 'localhost',
      port: options.port || 5432,
      database: options.database || 'otedama_pool',
      user: options.user || 'otedama',
      password: options.password,
      max: options.max || 20,
      idleTimeoutMillis: options.idleTimeoutMillis || 30000,
      connectionTimeoutMillis: options.connectionTimeoutMillis || 2000,
      ...options
    };
    
    this.pool = null;
  }
  
  /**
   * Initialize database connection
   */
  async initialize() {
    try {
      // Create connection pool
      this.pool = new Pool(this.options);
      
      // Test connection
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      
      // Create tables if not exist
      await this.createTables();
      
      // Create indexes
      await this.createIndexes();
      
      logger.info('Payment database initialized');
      return true;
    } catch (error) {
      logger.error('Failed to initialize database:', error);
      throw error;
    }
  }
  
  /**
   * Create required tables
   */
  async createTables() {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Miner balances table
      await client.query(`
        CREATE TABLE IF NOT EXISTS miner_balances (
          address VARCHAR(64) PRIMARY KEY,
          balance DECIMAL(20, 8) NOT NULL DEFAULT 0,
          total_earned DECIMAL(20, 8) NOT NULL DEFAULT 0,
          total_paid DECIMAL(20, 8) NOT NULL DEFAULT 0,
          last_share TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Shares table
      await client.query(`
        CREATE TABLE IF NOT EXISTS shares (
          id SERIAL PRIMARY KEY,
          miner_address VARCHAR(64) NOT NULL,
          job_id VARCHAR(64) NOT NULL,
          difficulty BIGINT NOT NULL,
          share_diff DECIMAL(20, 8),
          block_height INTEGER,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_shares_miner (miner_address),
          INDEX idx_shares_timestamp (timestamp)
        )
      `);
      
      // Blocks table
      await client.query(`
        CREATE TABLE IF NOT EXISTS blocks (
          height INTEGER PRIMARY KEY,
          hash VARCHAR(64) NOT NULL UNIQUE,
          reward DECIMAL(20, 8) NOT NULL,
          finder_address VARCHAR(64),
          confirmations INTEGER DEFAULT 0,
          status VARCHAR(20) DEFAULT 'pending',
          found_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          confirmed_at TIMESTAMP,
          INDEX idx_blocks_status (status)
        )
      `);
      
      // Payments table
      await client.query(`
        CREATE TABLE IF NOT EXISTS payments (
          id SERIAL PRIMARY KEY,
          txid VARCHAR(64),
          address VARCHAR(64) NOT NULL,
          amount DECIMAL(20, 8) NOT NULL,
          fee DECIMAL(20, 8),
          status VARCHAR(20) DEFAULT 'pending',
          confirmations INTEGER DEFAULT 0,
          error TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          sent_at TIMESTAMP,
          confirmed_at TIMESTAMP,
          INDEX idx_payments_address (address),
          INDEX idx_payments_status (status),
          INDEX idx_payments_txid (txid)
        )
      `);
      
      // Payment batches table
      await client.query(`
        CREATE TABLE IF NOT EXISTS payment_batches (
          id SERIAL PRIMARY KEY,
          txid VARCHAR(64) UNIQUE,
          payment_count INTEGER NOT NULL,
          total_amount DECIMAL(20, 8) NOT NULL,
          total_fee DECIMAL(20, 8) NOT NULL,
          status VARCHAR(20) DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          broadcast_at TIMESTAMP,
          confirmed_at TIMESTAMP
        )
      `);
      
      // Distributions table
      await client.query(`
        CREATE TABLE IF NOT EXISTS distributions (
          id SERIAL PRIMARY KEY,
          block_height INTEGER NOT NULL,
          miner_address VARCHAR(64) NOT NULL,
          amount DECIMAL(20, 8) NOT NULL,
          shares INTEGER,
          percentage DECIMAL(5, 2),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_distributions_block (block_height),
          INDEX idx_distributions_miner (miner_address)
        )
      `);
      
      // Miner statistics table
      await client.query(`
        CREATE TABLE IF NOT EXISTS miner_stats (
          address VARCHAR(64) PRIMARY KEY,
          total_shares BIGINT DEFAULT 0,
          valid_shares BIGINT DEFAULT 0,
          invalid_shares BIGINT DEFAULT 0,
          blocks_found INTEGER DEFAULT 0,
          last_share_time TIMESTAMP,
          hash_rate DECIMAL(20, 2),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Audit log table
      await client.query(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id SERIAL PRIMARY KEY,
          event_type VARCHAR(50) NOT NULL,
          address VARCHAR(64),
          amount DECIMAL(20, 8),
          details JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_audit_type (event_type),
          INDEX idx_audit_address (address)
        )
      `);
      
      await client.query('COMMIT');
      logger.info('Database tables created');
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Create indexes for performance
   */
  async createIndexes() {
    const client = await this.pool.connect();
    
    try {
      // Additional indexes for performance
      const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_shares_block_height ON shares(block_height) WHERE block_height IS NOT NULL',
        'CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at)',
        'CREATE INDEX IF NOT EXISTS idx_distributions_created_at ON distributions(created_at)',
        'CREATE INDEX IF NOT EXISTS idx_balances_updated_at ON miner_balances(updated_at)',
        'CREATE INDEX IF NOT EXISTS idx_shares_composite ON shares(miner_address, timestamp DESC)'
      ];
      
      for (const index of indexes) {
        await client.query(index);
      }
      
      logger.info('Database indexes created');
      
    } catch (error) {
      logger.error('Failed to create indexes:', error);
    } finally {
      client.release();
    }
  }
  
  /**
   * Get miner balance
   */
  async getMinerBalance(address) {
    const query = `
      SELECT balance, total_earned, total_paid, last_share
      FROM miner_balances
      WHERE address = $1
    `;
    
    const result = await this.pool.query(query, [address]);
    
    if (result.rows.length === 0) {
      return {
        balance: '0',
        totalEarned: '0',
        totalPaid: '0',
        lastShare: null
      };
    }
    
    const row = result.rows[0];
    return {
      balance: row.balance,
      totalEarned: row.total_earned,
      totalPaid: row.total_paid,
      lastShare: row.last_share
    };
  }
  
  /**
   * Update miner balance
   */
  async updateMinerBalance(address, amount, operation = 'add') {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      if (operation === 'add') {
        await client.query(`
          INSERT INTO miner_balances (address, balance, total_earned)
          VALUES ($1, $2, $2)
          ON CONFLICT (address) DO UPDATE
          SET balance = miner_balances.balance + $2,
              total_earned = miner_balances.total_earned + $2,
              updated_at = CURRENT_TIMESTAMP
        `, [address, amount]);
      } else if (operation === 'subtract') {
        await client.query(`
          UPDATE miner_balances
          SET balance = GREATEST(balance - $2, 0),
              total_paid = total_paid + $2,
              updated_at = CURRENT_TIMESTAMP
          WHERE address = $1
        `, [address, amount]);
      }
      
      await client.query('COMMIT');
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Record share
   */
  async recordShare(share) {
    const query = `
      INSERT INTO shares (miner_address, job_id, difficulty, share_diff, block_height)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `;
    
    const result = await this.pool.query(query, [
      share.minerAddress,
      share.jobId,
      share.difficulty,
      share.shareDiff,
      share.blockHeight
    ]);
    
    // Update last share time
    await this.pool.query(`
      UPDATE miner_balances
      SET last_share = CURRENT_TIMESTAMP
      WHERE address = $1
    `, [share.minerAddress]);
    
    return result.rows[0].id;
  }
  
  /**
   * Record block
   */
  async recordBlock(block) {
    const query = `
      INSERT INTO blocks (height, hash, reward, finder_address)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (height) DO NOTHING
    `;
    
    await this.pool.query(query, [
      block.height,
      block.hash,
      block.reward,
      block.finderAddress
    ]);
  }
  
  /**
   * Update block status
   */
  async updateBlockStatus(height, status, confirmations) {
    const query = `
      UPDATE blocks
      SET status = $2,
          confirmations = $3,
          confirmed_at = CASE WHEN $2 = 'confirmed' THEN CURRENT_TIMESTAMP ELSE confirmed_at END
      WHERE height = $1
    `;
    
    await this.pool.query(query, [height, status, confirmations]);
  }
  
  /**
   * Get pending blocks
   */
  async getPendingBlocks() {
    const query = `
      SELECT height, hash, reward, confirmations
      FROM blocks
      WHERE status = 'pending'
      ORDER BY height DESC
    `;
    
    const result = await this.pool.query(query);
    return result.rows;
  }
  
  /**
   * Record distribution
   */
  async recordDistribution(distributions, blockHeight) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      for (const dist of distributions) {
        await client.query(`
          INSERT INTO distributions (block_height, miner_address, amount, shares, percentage)
          VALUES ($1, $2, $3, $4, $5)
        `, [blockHeight, dist.address, dist.amount, dist.shares, dist.percentage]);
      }
      
      await client.query('COMMIT');
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Record payment
   */
  async recordPayment(payment) {
    const query = `
      INSERT INTO payments (address, amount, status)
      VALUES ($1, $2, $3)
      RETURNING id
    `;
    
    const result = await this.pool.query(query, [
      payment.address,
      payment.amount,
      payment.status || 'pending'
    ]);
    
    return result.rows[0].id;
  }
  
  /**
   * Record payment batch
   */
  async recordPaymentBatch(payments, txid, totalFee) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Calculate total amount
      const totalAmount = payments.reduce((sum, p) => 
        sum.plus(p.amount), new BigNumber(0)).toFixed(8);
      
      // Insert batch record
      const batchResult = await client.query(`
        INSERT INTO payment_batches (txid, payment_count, total_amount, total_fee, status, broadcast_at)
        VALUES ($1, $2, $3, $4, 'broadcast', CURRENT_TIMESTAMP)
        RETURNING id
      `, [txid, payments.length, totalAmount, totalFee]);
      
      const batchId = batchResult.rows[0].id;
      
      // Update individual payments
      for (const payment of payments) {
        await client.query(`
          UPDATE payments
          SET txid = $2,
              status = 'broadcast',
              sent_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [payment.id, txid]);
      }
      
      await client.query('COMMIT');
      
      return batchId;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Get shares in window
   */
  async getSharesInWindow(windowType, windowSize) {
    let query;
    
    if (windowType === 'shares') {
      query = `
        SELECT miner_address as address, difficulty, timestamp
        FROM shares
        ORDER BY id DESC
        LIMIT $1
      `;
      
      const result = await this.pool.query(query, [windowSize]);
      return result.rows;
      
    } else {
      // Time-based window
      query = `
        SELECT miner_address as address, difficulty, timestamp
        FROM shares
        WHERE timestamp >= NOW() - INTERVAL '%s seconds'
        ORDER BY timestamp DESC
      `;
      
      const result = await this.pool.query(query.replace('%s', windowSize / 1000));
      return result.rows;
    }
  }
  
  /**
   * Get round shares
   */
  async getRoundShares(lastBlockHeight) {
    const query = `
      SELECT miner_address as address, difficulty
      FROM shares
      WHERE block_height > $1 OR block_height IS NULL
    `;
    
    const result = await this.pool.query(query, [lastBlockHeight || 0]);
    return result.rows;
  }
  
  /**
   * Get pending payments
   */
  async getPendingPayments() {
    const query = `
      SELECT id, address, amount, created_at
      FROM payments
      WHERE status = 'pending'
      ORDER BY created_at ASC
    `;
    
    const result = await this.pool.query(query);
    return result.rows;
  }
  
  /**
   * Update payment status
   */
  async updatePaymentStatus(paymentId, status, txid = null) {
    const query = `
      UPDATE payments
      SET status = $2,
          txid = $3,
          confirmed_at = CASE WHEN $2 = 'confirmed' THEN CURRENT_TIMESTAMP ELSE confirmed_at END
      WHERE id = $1
    `;
    
    await this.pool.query(query, [paymentId, status, txid]);
  }
  
  /**
   * Get miner statistics
   */
  async getMinerStats(address) {
    const query = `
      SELECT 
        total_shares,
        valid_shares,
        invalid_shares,
        blocks_found,
        hash_rate,
        last_share_time
      FROM miner_stats
      WHERE address = $1
    `;
    
    const result = await this.pool.query(query, [address]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return result.rows[0];
  }
  
  /**
   * Update miner statistics
   */
  async updateMinerStats(address, stats) {
    const query = `
      INSERT INTO miner_stats (address, total_shares, valid_shares, hash_rate, last_share_time)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT (address) DO UPDATE
      SET total_shares = miner_stats.total_shares + $2,
          valid_shares = miner_stats.valid_shares + $3,
          hash_rate = $4,
          last_share_time = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
    `;
    
    await this.pool.query(query, [
      address,
      stats.shares || 1,
      stats.validShares || 1,
      stats.hashRate || 0
    ]);
  }
  
  /**
   * Record audit log entry
   */
  async recordAudit(eventType, address, amount, details) {
    const query = `
      INSERT INTO audit_log (event_type, address, amount, details)
      VALUES ($1, $2, $3, $4)
    `;
    
    await this.pool.query(query, [eventType, address, amount, JSON.stringify(details)]);
  }
  
  /**
   * Get payment history
   */
  async getPaymentHistory(address, limit = 100) {
    const query = `
      SELECT 
        id,
        txid,
        amount,
        fee,
        status,
        created_at,
        sent_at,
        confirmed_at
      FROM payments
      WHERE address = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;
    
    const result = await this.pool.query(query, [address, limit]);
    return result.rows;
  }
  
  /**
   * Get pool statistics
   */
  async getPoolStats() {
    const client = await this.pool.connect();
    
    try {
      const stats = {};
      
      // Total miners
      const minersResult = await client.query(`
        SELECT COUNT(DISTINCT address) as count
        FROM miner_balances
        WHERE balance > 0
      `);
      stats.activeMiners = parseInt(minersResult.rows[0].count);
      
      // Total hash rate
      const hashRateResult = await client.query(`
        SELECT SUM(hash_rate) as total
        FROM miner_stats
        WHERE last_share_time > NOW() - INTERVAL '5 minutes'
      `);
      stats.totalHashRate = parseFloat(hashRateResult.rows[0].total || 0);
      
      // Total paid
      const paidResult = await client.query(`
        SELECT SUM(amount) as total
        FROM payments
        WHERE status = 'confirmed'
      `);
      stats.totalPaid = paidResult.rows[0].total || '0';
      
      // Pending payments
      const pendingResult = await client.query(`
        SELECT COUNT(*) as count, SUM(amount) as total
        FROM payments
        WHERE status = 'pending'
      `);
      stats.pendingPayments = parseInt(pendingResult.rows[0].count);
      stats.pendingAmount = pendingResult.rows[0].total || '0';
      
      // Blocks found
      const blocksResult = await client.query(`
        SELECT COUNT(*) as total, COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as confirmed
        FROM blocks
      `);
      stats.totalBlocks = parseInt(blocksResult.rows[0].total);
      stats.confirmedBlocks = parseInt(blocksResult.rows[0].confirmed);
      
      return stats;
      
    } finally {
      client.release();
    }
  }
  
  /**
   * Clean old data
   */
  async cleanOldData(daysToKeep = 90) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Clean old shares
      await client.query(`
        DELETE FROM shares
        WHERE timestamp < NOW() - INTERVAL '%s days'
      `.replace('%s', daysToKeep));
      
      // Clean old audit logs
      await client.query(`
        DELETE FROM audit_log
        WHERE created_at < NOW() - INTERVAL '%s days'
      `.replace('%s', daysToKeep * 2));
      
      await client.query('COMMIT');
      
      logger.info('Cleaned old data from database');
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to clean old data:', error);
    } finally {
      client.release();
    }
  }
  
  /**
   * Close database connection
   */
  async close() {
    if (this.pool) {
      await this.pool.end();
      logger.info('Database connection closed');
    }
  }
}

module.exports = PaymentDatabase;