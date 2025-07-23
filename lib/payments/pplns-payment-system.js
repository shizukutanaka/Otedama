/**
 * PPLNS (Pay Per Last N Shares) Payment System
 * Fair and efficient payment distribution for mining pools
 */

const EventEmitter = require('events');
const { createLogger } = require('../core/logger');
const OptimizedDatabase = require('../database/optimized-database');

const logger = createLogger('pplns-payment');

class PPLNSPaymentSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // PPLNS window configuration
      windowType: options.windowType || 'time', // 'time' or 'shares'
      windowDuration: options.windowDuration || 3600000, // 1 hour in ms (for time-based)
      windowShares: options.windowShares || 1000000, // Number of shares (for share-based)
      
      // Payment configuration
      poolFee: options.poolFee || 0.01, // 1% pool fee
      minPayout: options.minPayout || 0.001, // Minimum payout amount
      paymentInterval: options.paymentInterval || 3600000, // 1 hour
      confirmations: options.confirmations || 100, // Block confirmations required
      
      // Transaction fees
      txFeeReserve: options.txFeeReserve || 0.0001, // Reserve for transaction fees
      txFeePerOutput: options.txFeePerOutput || 0.00001, // Fee per output
      maxOutputsPerTx: options.maxOutputsPerTx || 100, // Max outputs per transaction
      
      // Performance
      batchSize: options.batchSize || 100, // Payment batch size
      cacheExpiry: options.cacheExpiry || 300000, // 5 minutes
      
      ...options
    };

    this.db = options.database || new OptimizedDatabase(options);
    this.shareCache = new Map();
    this.pendingPayments = new Map();
    this.lastPaymentRun = 0;
    this.isProcessing = false;
    
    this._paymentInterval = null;
  }

  async initialize() {
    logger.info('Initializing PPLNS payment system', {
      windowType: this.options.windowType,
      windowDuration: this.options.windowDuration,
      poolFee: this.options.poolFee
    });

    if (!this.db._initialized) {
      await this.db.initialize();
    }

    // Create payment credits table
    await this.db.pool.run(`
      CREATE TABLE IF NOT EXISTS payment_credits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        miner_id TEXT NOT NULL,
        block_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        shares INTEGER NOT NULL,
        difficulty REAL NOT NULL,
        percentage REAL NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        FOREIGN KEY (miner_id) REFERENCES miners(id),
        FOREIGN KEY (block_id) REFERENCES blocks(id)
      )
    `);

    // Add payment_processed column to blocks table if not exists
    await this.db.pool.run(`
      ALTER TABLE blocks ADD COLUMN payment_processed INTEGER DEFAULT 0
    `).catch(() => {}); // Ignore if column already exists

    await this.db.pool.run(`
      ALTER TABLE blocks ADD COLUMN payment_processed_at INTEGER
    `).catch(() => {}); // Ignore if column already exists

    // Start payment processing interval
    this._paymentInterval = setInterval(() => {
      this.processPayments().catch(err => {
        logger.error('Payment processing error:', err);
      });
    }, this.options.paymentInterval);

    logger.info('PPLNS payment system initialized');
  }

  /**
   * Calculate rewards for a found block using PPLNS
   * @param {Object} block - Block information
   * @returns {Object} Reward distribution
   */
  async calculateBlockRewards(block) {
    const startTime = Date.now();
    
    try {
      logger.info('Calculating PPLNS rewards for block', {
        height: block.height,
        reward: block.reward,
        hash: block.hash
      });

      // Get shares in the PPLNS window
      const shares = await this._getSharesInWindow(block.found_at || Date.now());
      
      if (shares.length === 0) {
        logger.warn('No shares found in PPLNS window');
        return { distributions: [], totalShares: 0 };
      }

      // Calculate total difficulty
      const totalDifficulty = shares.reduce((sum, share) => sum + share.difficulty, 0);
      
      // Calculate pool fee
      const poolFeeAmount = block.reward * this.options.poolFee;
      const distributableReward = block.reward - poolFeeAmount;

      // Calculate reward per share
      const distributions = new Map();
      
      for (const share of shares) {
        const minerReward = (share.difficulty / totalDifficulty) * distributableReward;
        
        if (distributions.has(share.miner_id)) {
          distributions.get(share.miner_id).reward += minerReward;
          distributions.get(share.miner_id).shares += 1;
          distributions.get(share.miner_id).difficulty += share.difficulty;
        } else {
          distributions.set(share.miner_id, {
            minerId: share.miner_id,
            address: share.miner_address,
            reward: minerReward,
            shares: 1,
            difficulty: share.difficulty,
            percentage: (share.difficulty / totalDifficulty) * 100
          });
        }
      }

      // Convert to array and filter minimum payouts
      const finalDistributions = Array.from(distributions.values())
        .filter(dist => dist.reward >= this.options.minPayout)
        .sort((a, b) => b.reward - a.reward);

      // Log statistics
      const stats = {
        blockHeight: block.height,
        totalShares: shares.length,
        totalDifficulty,
        uniqueMiners: distributions.size,
        distributableReward,
        poolFee: poolFeeAmount,
        calculationTime: Date.now() - startTime
      };

      logger.info('PPLNS calculation completed', stats);
      this.emit('rewards:calculated', { block, distributions: finalDistributions, stats });

      return {
        distributions: finalDistributions,
        stats
      };
    } catch (error) {
      logger.error('Error calculating PPLNS rewards:', error);
      throw error;
    }
  }

  /**
   * Process pending payments
   */
  async processPayments() {
    if (this.isProcessing) {
      logger.debug('Payment processing already in progress');
      return;
    }

    this.isProcessing = true;
    const startTime = Date.now();

    try {
      logger.info('Starting payment processing');

      // Get confirmed blocks that haven't been paid
      const unpaidBlocks = await this._getUnpaidBlocks();
      
      if (unpaidBlocks.length === 0) {
        logger.debug('No unpaid blocks to process');
        this.isProcessing = false;
        return;
      }

      // Process each block
      for (const block of unpaidBlocks) {
        await this._processBlockPayment(block);
      }

      // Process pending balance payments
      await this._processPendingPayments();

      const duration = Date.now() - startTime;
      logger.info('Payment processing completed', {
        blocksProcessed: unpaidBlocks.length,
        duration
      });

      this.lastPaymentRun = Date.now();
      this.emit('payments:processed', { 
        blocks: unpaidBlocks.length,
        duration 
      });

    } catch (error) {
      logger.error('Error processing payments:', error);
      this.emit('payments:error', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process payment for a single block
   */
  async _processBlockPayment(block) {
    try {
      // Calculate rewards
      const { distributions, stats } = await this.calculateBlockRewards(block);
      
      if (distributions.length === 0) {
        logger.warn('No distributions for block', { height: block.height });
        return;
      }

      // Record distributions in database
      await this.db.transaction(async () => {
        for (const dist of distributions) {
          // Update miner balance
          await this.db.updateBalance(dist.minerId, dist.reward, 0);
          
          // Record the credit
          await this.db.pool.run(`
            INSERT INTO payment_credits (
              miner_id, block_id, amount, shares, difficulty, percentage
            ) VALUES (?, ?, ?, ?, ?, ?)
          `, [
            dist.minerId,
            block.id,
            dist.reward,
            dist.shares,
            dist.difficulty,
            dist.percentage
          ]);
        }

        // Mark block as paid
        await this.db.pool.run(
          'UPDATE blocks SET payment_processed = 1, payment_processed_at = ? WHERE id = ?',
          [Date.now(), block.id]
        );
      });

      logger.info('Block payment recorded', {
        blockHeight: block.height,
        distributions: distributions.length,
        totalAmount: distributions.reduce((sum, d) => sum + d.reward, 0)
      });

      this.emit('block:paid', { block, distributions, stats });

    } catch (error) {
      logger.error('Error processing block payment:', error);
      throw error;
    }
  }

  /**
   * Process pending balance payments
   */
  async _processPendingPayments() {
    try {
      // Get miners with balance above minimum payout
      const eligibleMiners = await this.db.pool.execute(`
        SELECT 
          m.id, m.address, b.confirmed as balance
        FROM miners m
        JOIN balances b ON m.id = b.miner_id
        WHERE b.confirmed >= ?
        ORDER BY b.confirmed DESC
        LIMIT ?
      `, [this.options.minPayout, this.options.batchSize]);

      if (eligibleMiners.length === 0) {
        logger.debug('No miners eligible for payment');
        return;
      }

      // Group payments for batch processing
      const paymentBatch = [];
      let totalAmount = 0;
      let estimatedFee = this.options.txFeeReserve;

      for (const miner of eligibleMiners) {
        // Calculate payment amount after fees
        const grossAmount = miner.balance;
        const txFee = this.options.txFeePerOutput;
        const netAmount = grossAmount - txFee;

        if (netAmount <= 0) {
          continue;
        }

        paymentBatch.push({
          minerId: miner.id,
          address: miner.address,
          amount: netAmount,
          fee: txFee
        });

        totalAmount += netAmount;
        estimatedFee += txFee;

        // Check batch size
        if (paymentBatch.length >= this.options.maxOutputsPerTx) {
          await this._executepaymentBatch(paymentBatch, estimatedFee);
          paymentBatch.length = 0;
          totalAmount = 0;
          estimatedFee = this.options.txFeeReserve;
        }
      }

      // Process remaining batch
      if (paymentBatch.length > 0) {
        await this._executepaymentBatch(paymentBatch, estimatedFee);
      }

    } catch (error) {
      logger.error('Error processing pending payments:', error);
      throw error;
    }
  }

  /**
   * Execute a batch of payments
   */
  async _executepaymentBatch(batch, estimatedFee) {
    try {
      logger.info('Executing payment batch', {
        recipients: batch.length,
        totalAmount: batch.reduce((sum, p) => sum + p.amount, 0),
        estimatedFee
      });

      // Create payment records
      const paymentIds = [];
      
      await this.db.transaction(async () => {
        for (const payment of batch) {
          const result = await this.db.createPayment(
            payment.minerId,
            payment.amount,
            payment.fee
          );
          paymentIds.push(result.lastID);
          
          // Update balance (deduct payment)
          await this.db.updateBalance(payment.minerId, -payment.amount - payment.fee, 0);
        }
      });

      // Here you would integrate with actual blockchain payment
      // For now, we'll simulate successful payment
      const transactionId = this._generateTransactionId();
      
      // Mark payments as completed
      await this.db.transaction(async () => {
        for (const paymentId of paymentIds) {
          await this.db.processPayment(paymentId, transactionId);
        }
      });

      logger.info('Payment batch completed', {
        transactionId,
        payments: batch.length
      });

      this.emit('payments:sent', {
        transactionId,
        payments: batch,
        totalAmount: batch.reduce((sum, p) => sum + p.amount, 0)
      });

    } catch (error) {
      logger.error('Error executing payment batch:', error);
      
      // Mark payments as failed
      await this.db.pool.run(
        'UPDATE payments SET status = "failed" WHERE status = "pending" AND miner_id IN (' +
        batch.map(() => '?').join(',') + ')',
        batch.map(p => p.minerId)
      );
      
      throw error;
    }
  }

  /**
   * Get shares within the PPLNS window
   */
  async _getSharesInWindow(referenceTime) {
    const cacheKey = `shares_${Math.floor(referenceTime / this.options.cacheExpiry)}`;
    
    // Check cache
    if (this.shareCache.has(cacheKey)) {
      return this.shareCache.get(cacheKey);
    }

    let shares;
    
    if (this.options.windowType === 'time') {
      // Time-based window
      shares = await this.db.getSharesWindow(this.options.windowDuration);
    } else {
      // Share-based window
      shares = await this.db.pool.execute(`
        SELECT 
          s.*,
          m.address as miner_address
        FROM shares s
        JOIN miners m ON s.miner_id = m.id
        WHERE s.is_valid = 1
        ORDER BY s.timestamp DESC
        LIMIT ?
      `, [this.options.windowShares]);
    }

    // Cache results
    this.shareCache.set(cacheKey, shares);
    
    // Clear old cache entries
    if (this.shareCache.size > 10) {
      const oldestKey = this.shareCache.keys().next().value;
      this.shareCache.delete(oldestKey);
    }

    return shares;
  }

  /**
   * Get unpaid blocks
   */
  async _getUnpaidBlocks() {
    return this.db.pool.execute(`
      SELECT * FROM blocks
      WHERE confirmations >= ? 
        AND (payment_processed IS NULL OR payment_processed = 0)
      ORDER BY height ASC
    `, [this.options.confirmations]);
  }

  /**
   * Generate a mock transaction ID
   */
  _generateTransactionId() {
    return require('crypto').randomBytes(32).toString('hex');
  }

  /**
   * Get payment statistics
   */
  async getPaymentStats() {
    const [totalPaid, pendingPayments, last24h] = await Promise.all([
      this.db.pool.get('SELECT SUM(amount) as total FROM payments WHERE status = "completed"'),
      this.db.pool.get('SELECT COUNT(*) as count, SUM(amount) as total FROM payments WHERE status = "pending"'),
      this.db.pool.get(`
        SELECT COUNT(*) as count, SUM(amount) as total 
        FROM payments 
        WHERE status = "completed" AND processed_at > ?
      `, [Date.now() - 86400000])
    ]);

    return {
      totalPaid: totalPaid?.total || 0,
      pendingCount: pendingPayments?.count || 0,
      pendingAmount: pendingPayments?.total || 0,
      last24hCount: last24h?.count || 0,
      last24hAmount: last24h?.total || 0,
      lastPaymentRun: this.lastPaymentRun,
      isProcessing: this.isProcessing
    };
  }

  /**
   * Get miner payment history
   */
  async getMinerPayments(minerId, limit = 50) {
    return this.db.pool.execute(`
      SELECT * FROM payments
      WHERE miner_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `, [minerId, limit]);
  }

  /**
   * Manual payment trigger
   */
  async triggerPayment(minerId) {
    const miner = await this.db.pool.get(`
      SELECT m.*, b.confirmed as balance
      FROM miners m
      JOIN balances b ON m.id = b.miner_id
      WHERE m.id = ?
    `, [minerId]);

    if (!miner) {
      throw new Error('Miner not found');
    }

    if (miner.balance < this.options.minPayout) {
      throw new Error(`Balance below minimum payout: ${miner.balance} < ${this.options.minPayout}`);
    }

    await this._executepaymentBatch([{
      minerId: miner.id,
      address: miner.address,
      amount: miner.balance - this.options.txFeePerOutput,
      fee: this.options.txFeePerOutput
    }], this.options.txFeeReserve + this.options.txFeePerOutput);

    return { success: true, amount: miner.balance };
  }

  /**
   * Stop payment processing
   */
  async stop() {
    if (this._paymentInterval) {
      clearInterval(this._paymentInterval);
      this._paymentInterval = null;
    }

    // Wait for current processing to complete
    while (this.isProcessing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.info('PPLNS payment system stopped');
  }
}

module.exports = PPLNSPaymentSystem;