import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { createHash } from 'crypto';
import { POOL_CONSTANTS } from './constants.js';

/**
 * Automated Payment Manager
 * マイニング報酬の自動支払いシステム
 * 
 * Features:
 * - Automatic hourly payout processing
 * - Multi-currency support
 * - Configurable minimum payout thresholds
 * - Automatic fee deduction
 * - Transaction tracking and verification
 */
export class PaymentManager extends EventEmitter {
  constructor(config, database, feeManager) {
    super();
    this.config = config;
    this.db = database;
    this.feeManager = feeManager;
    this.logger = new Logger('PaymentManager');
    
    // Payment configuration
    this.minPayouts = this.config.get('pool.minPayout') || {
      BTC: 0.001,
      RVN: 100,
      XMR: 0.1,
      ETC: 1,
      LTC: 0.1,
      DOGE: 100
    };
    
    // Payment tracking
    this.pendingPayments = new Map();
    this.processedPayments = new Map();
    this.minerBalances = new Map();
    this.paymentQueue = [];
    this.lastPayoutTime = new Map();
    
    // Payment statistics
    this.totalPaidOut = new Map();
    this.paymentCount = new Map();
    this.failedPayments = new Map();
    
    // Initialize payment system
    this.initializePaymentSystem();
    
    // Start automated payment processing
    this.startAutomatedPayments();
    
    this.logger.info('Automated Payment Manager initialized');
  }

  /**
   * Initialize payment system and database tables
   */
  initializePaymentSystem() {
    try {
      // Create miners table
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS miners (
          id TEXT PRIMARY KEY,
          wallet_address TEXT NOT NULL,
          currency TEXT NOT NULL,
          balance REAL DEFAULT 0,
          total_paid REAL DEFAULT 0,
          last_payout INTEGER DEFAULT 0,
          first_seen INTEGER DEFAULT ${Date.now()},
          last_seen INTEGER DEFAULT ${Date.now()},
          share_count INTEGER DEFAULT 0,
          valid_shares INTEGER DEFAULT 0
        )
      `).run();

      // Create payments table
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          miner_id TEXT NOT NULL,
          wallet_address TEXT NOT NULL,
          currency TEXT NOT NULL,
          amount REAL NOT NULL,
          fee REAL DEFAULT 0,
          net_amount REAL NOT NULL,
          tx_hash TEXT,
          status TEXT DEFAULT 'pending',
          created_timestamp INTEGER NOT NULL,
          processed_timestamp INTEGER,
          confirmed_timestamp INTEGER,
          FOREIGN KEY (miner_id) REFERENCES miners (id)
        )
      `).run();

      // Create payment queue table
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS payment_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          miner_id TEXT NOT NULL,
          wallet_address TEXT NOT NULL,
          currency TEXT NOT NULL,
          amount REAL NOT NULL,
          priority INTEGER DEFAULT 0,
          created_timestamp INTEGER NOT NULL,
          scheduled_timestamp INTEGER,
          FOREIGN KEY (miner_id) REFERENCES miners (id)
        )
      `).run();

      // Load existing miner balances
      this.loadMinerBalances();
      
      this.logger.info('Payment system database initialized');
    } catch (error) {
      this.logger.error('Failed to initialize payment system:', error);
    }
  }

  /**
   * Load existing miner balances from database
   */
  loadMinerBalances() {
    try {
      const miners = this.db.prepare('SELECT * FROM miners').all();
      
      for (const miner of miners) {
        const key = `${miner.id}:${miner.currency}`;
        this.minerBalances.set(key, {
          balance: miner.balance * 1e8, // Convert to satoshi
          walletAddress: miner.wallet_address,
          currency: miner.currency,
          totalPaid: miner.total_paid * 1e8,
          lastPayout: miner.last_payout,
          shareCount: miner.share_count,
          validShares: miner.valid_shares
        });
      }

      // Load pending payments from queue
      const queuedPayments = this.db.prepare('SELECT * FROM payment_queue ORDER BY priority DESC, created_timestamp ASC').all();
      this.paymentQueue = queuedPayments;

      this.logger.info(`Loaded ${miners.length} miners and ${queuedPayments.length} queued payments`);
    } catch (error) {
      this.logger.error('Failed to load miner balances:', error);
    }
  }

  /**
   * Start automated payment processing
   */
  startAutomatedPayments() {
    // Process payments every hour
    this.paymentTimer = setInterval(() => {
      this.processAutomaticPayouts();
    }, 3600000); // 1 hour

    // Process payment queue every 5 minutes
    this.queueTimer = setInterval(() => {
      this.processPaymentQueue();
    }, 300000); // 5 minutes

    // Update miner statistics every 10 minutes
    this.statsTimer = setInterval(() => {
      this.updateMinerStatistics();
    }, 600000); // 10 minutes

    // Initial processing
    setTimeout(() => {
      this.processPaymentQueue();
    }, 30000); // 30 seconds after startup

    this.logger.info('Automated payment processing started');
  }

  /**
   * Credit miner with mining reward
   */
  async creditMiner(minerId, walletAddress, amount, currency) {
    try {
      const key = `${minerId}:${currency}`;
      const currentBalance = this.minerBalances.get(key) || {
        balance: 0,
        walletAddress,
        currency,
        totalPaid: 0,
        lastPayout: 0,
        shareCount: 0,
        validShares: 0
      };

      // Update balance
      currentBalance.balance += amount;
      currentBalance.validShares += 1;
      currentBalance.walletAddress = walletAddress; // Update in case it changed
      
      this.minerBalances.set(key, currentBalance);

      // Update database
      this.updateMinerInDatabase(minerId, walletAddress, currency, currentBalance);

      // Check if payout threshold reached
      const minPayout = this.minPayouts[currency] * 1e8; // Convert to satoshi
      if (currentBalance.balance >= minPayout) {
        this.queuePayment(minerId, walletAddress, currency, currentBalance.balance);
      }

      // Emit event
      this.emit('miner:credited', {
        minerId,
        walletAddress,
        currency,
        amount,
        newBalance: currentBalance.balance,
        timestamp: Date.now()
      });

      this.logger.debug(`Credited ${amount / 1e8} ${currency} to miner ${minerId} (balance: ${currentBalance.balance / 1e8})`);

    } catch (error) {
      this.logger.error('Error crediting miner:', error);
    }
  }

  /**
   * Queue payment for processing
   */
  queuePayment(minerId, walletAddress, currency, amount, priority = 0) {
    try {
      const payment = {
        miner_id: minerId,
        wallet_address: walletAddress,
        currency,
        amount: amount / 1e8, // Convert to decimal
        priority,
        created_timestamp: Date.now(),
        scheduled_timestamp: Date.now() + 300000 // Schedule for 5 minutes from now
      };

      // Add to queue
      this.paymentQueue.push(payment);

      // Add to database
      const stmt = this.db.prepare(`
        INSERT INTO payment_queue 
        (miner_id, wallet_address, currency, amount, priority, created_timestamp, scheduled_timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      
      stmt.run(
        payment.miner_id,
        payment.wallet_address,
        payment.currency,
        payment.amount,
        payment.priority,
        payment.created_timestamp,
        payment.scheduled_timestamp
      );

      this.logger.info(`Queued payment: ${payment.amount} ${currency} to ${walletAddress}`);

      // Emit event
      this.emit('payment:queued', payment);

    } catch (error) {
      this.logger.error('Error queuing payment:', error);
    }
  }

  /**
   * Process automatic payouts (called every hour)
   */
  async processAutomaticPayouts() {
    this.logger.info('Processing automatic payouts...');

    try {
      let processedCount = 0;
      let totalAmount = 0;

      // Process all miners with sufficient balance
      for (const [key, minerData] of this.minerBalances) {
        const [minerId, currency] = key.split(':');
        const minPayout = this.minPayouts[currency] * 1e8;

        if (minerData.balance >= minPayout) {
          // Check if enough time has passed since last payout (prevent spam)
          const timeSinceLastPayout = Date.now() - minerData.lastPayout;
          const minPayoutInterval = 3600000; // 1 hour minimum

          if (timeSinceLastPayout >= minPayoutInterval) {
            this.queuePayment(
              minerId,
              minerData.walletAddress,
              currency,
              minerData.balance,
              1 // High priority for automatic payouts
            );
            processedCount++;
            totalAmount += minerData.balance / 1e8;
          }
        }
      }

      this.logger.info(`Automatic payout processing complete: ${processedCount} payments queued, total: ${totalAmount.toFixed(8)}`);

      // Emit event
      this.emit('payouts:processed', {
        count: processedCount,
        totalAmount,
        timestamp: Date.now()
      });

    } catch (error) {
      this.logger.error('Error processing automatic payouts:', error);
    }
  }

  /**
   * Process payment queue
   */
  async processPaymentQueue() {
    if (this.paymentQueue.length === 0) return;

    this.logger.debug(`Processing payment queue: ${this.paymentQueue.length} payments`);

    try {
      // Sort by priority and timestamp
      this.paymentQueue.sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.created_timestamp - b.created_timestamp;
      });

      const now = Date.now();
      let processedCount = 0;

      // Process up to 10 payments per batch
      for (let i = 0; i < Math.min(this.paymentQueue.length, 10); i++) {
        const payment = this.paymentQueue[i];

        // Check if payment is scheduled for processing
        if (payment.scheduled_timestamp > now) continue;

        const success = await this.processPayment(payment);
        
        if (success) {
          // Remove from queue
          this.paymentQueue.splice(i, 1);
          i--; // Adjust index after removal

          // Remove from database queue
          this.db.prepare('DELETE FROM payment_queue WHERE id = ?').run(payment.id);

          processedCount++;
        } else {
          // Reschedule for later (exponential backoff)
          payment.scheduled_timestamp = now + Math.pow(2, payment.retry_count || 0) * 300000;
          payment.retry_count = (payment.retry_count || 0) + 1;

          // Limit retry attempts
          if (payment.retry_count > 5) {
            this.logger.error(`Payment failed after 5 attempts: ${payment.miner_id} ${payment.amount} ${payment.currency}`);
            this.paymentQueue.splice(i, 1);
            i--;
            this.db.prepare('DELETE FROM payment_queue WHERE id = ?').run(payment.id);
          }
        }
      }

      if (processedCount > 0) {
        this.logger.info(`Processed ${processedCount} payments from queue`);
      }

    } catch (error) {
      this.logger.error('Error processing payment queue:', error);
    }
  }

  /**
   * Process individual payment
   */
  async processPayment(payment) {
    try {
      const key = `${payment.miner_id}:${payment.currency}`;
      const minerData = this.minerBalances.get(key);

      if (!minerData || minerData.balance < payment.amount * 1e8) {
        this.logger.warn(`Insufficient balance for payment: ${payment.miner_id} ${payment.amount} ${payment.currency}`);
        return false;
      }

      // Calculate fees (IMMUTABLE)
      const poolFee = 0.0; // 0% - POOL FEE REMOVED
      const operatorFee = this.feeManager.getOperatorFeeRate(); // 1.5% FIXED
      const totalFeeRate = operatorFee; // 1.5% FIXED (OPERATOR FEE ONLY)
      
      const feeAmount = Math.floor(payment.amount * 1e8 * totalFeeRate);
      const netAmount = (payment.amount * 1e8) - feeAmount;

      // Generate transaction hash (in production, this would be actual blockchain tx)
      const txHash = this.generateTransactionHash(payment.wallet_address, netAmount, payment.currency);

      // Update miner balance
      minerData.balance -= payment.amount * 1e8;
      minerData.totalPaid += netAmount;
      minerData.lastPayout = Date.now();

      // Record payment in database
      const stmt = this.db.prepare(`
        INSERT INTO payments 
        (miner_id, wallet_address, currency, amount, fee, net_amount, tx_hash, status, created_timestamp, processed_timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        payment.miner_id,
        payment.wallet_address,
        payment.currency,
        payment.amount,
        feeAmount / 1e8,
        netAmount / 1e8,
        txHash,
        'completed',
        payment.created_timestamp,
        Date.now()
      );

      // Update miner in database
      this.updateMinerInDatabase(payment.miner_id, payment.wallet_address, payment.currency, minerData);

      this.logger.info(`Payment processed: ${netAmount / 1e8} ${payment.currency} to ${payment.wallet_address} (tx: ${txHash})`);

      // Emit event
      this.emit('payment:processed', {
        minerId: payment.miner_id,
        walletAddress: payment.wallet_address,
        currency: payment.currency,
        amount: payment.amount,
        fee: feeAmount / 1e8,
        netAmount: netAmount / 1e8,
        txHash,
        timestamp: Date.now()
      });

      return true;

    } catch (error) {
      this.logger.error('Error processing payment:', error);
      return false;
    }
  }

  /**
   * Update miner record in database
   */
  updateMinerInDatabase(minerId, walletAddress, currency, minerData) {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO miners 
        (id, wallet_address, currency, balance, total_paid, last_payout, last_seen, share_count, valid_shares)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        minerId,
        walletAddress,
        currency,
        minerData.balance / 1e8,
        minerData.totalPaid / 1e8,
        minerData.lastPayout,
        Date.now(),
        minerData.shareCount,
        minerData.validShares
      );
    } catch (error) {
      this.logger.error('Failed to update miner in database:', error);
    }
  }

  /**
   * Update miner statistics
   */
  updateMinerStatistics() {
    try {
      // Update statistics for active miners
      for (const [key, minerData] of this.minerBalances) {
        const [minerId, currency] = key.split(':');
        
        // Update last seen timestamp
        this.db.prepare('UPDATE miners SET last_seen = ? WHERE id = ? AND currency = ?')
          .run(Date.now(), minerId, currency);
      }

      this.logger.debug('Miner statistics updated');
    } catch (error) {
      this.logger.error('Error updating miner statistics:', error);
    }
  }

  /**
   * Generate transaction hash
   */
  generateTransactionHash(address, amount, currency) {
    const data = `${address}:${amount}:${currency}:${Date.now()}:${Math.random()}`;
    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * Distribute block reward to all active miners
   */
  async distributeBlockReward(block) {
    try {
      const blockReward = block.reward || 1000000000; // 10 coins default
      const activeMiners = new Map();

      // Get active miners (those with recent shares)
      const recentThreshold = Date.now() - 3600000; // 1 hour
      
      for (const [key, minerData] of this.minerBalances) {
        if (minerData.lastSeen && minerData.lastSeen > recentThreshold && minerData.validShares > 0) {
          activeMiners.set(key, minerData);
        }
      }

      if (activeMiners.size === 0) {
        this.logger.warn('No active miners for block reward distribution');
        return;
      }

      // Calculate total shares
      let totalShares = 0;
      for (const minerData of activeMiners.values()) {
        totalShares += minerData.validShares;
      }

      // Distribute reward proportionally
      for (const [key, minerData] of activeMiners) {
        const [minerId, currency] = key.split(':');
        const minerShare = (minerData.validShares / totalShares) * blockReward;
        
        await this.creditMiner(minerId, minerData.walletAddress, Math.floor(minerShare), currency);
      }

      this.logger.info(`Block reward distributed: ${blockReward / 1e8} to ${activeMiners.size} miners`);

      // Emit event
      this.emit('block:distributed', {
        blockHash: block.hash,
        reward: blockReward,
        minerCount: activeMiners.size,
        timestamp: Date.now()
      });

    } catch (error) {
      this.logger.error('Error distributing block reward:', error);
    }
  }

  /**
   * Get payment statistics
   */
  getPaymentStats() {
    try {
      // Get total payments from database
      const totalPayments = this.db.prepare(`
        SELECT currency, COUNT(*) as count, SUM(net_amount) as total 
        FROM payments 
        WHERE status = 'completed' 
        GROUP BY currency
      `).all();

      // Get pending balances
      const pendingBalances = {};
      for (const [key, minerData] of this.minerBalances) {
        const [minerId, currency] = key.split(':');
        if (!pendingBalances[currency]) pendingBalances[currency] = 0;
        pendingBalances[currency] += minerData.balance / 1e8;
      }

      // Get recent payments
      const recentPayments = this.db.prepare(`
        SELECT * FROM payments 
        WHERE status = 'completed' 
        ORDER BY processed_timestamp DESC 
        LIMIT 10
      `).all();

      return {
        totalPayments: totalPayments.reduce((acc, p) => {
          acc[p.currency] = {
            count: p.count,
            total: p.total
          };
          return acc;
        }, {}),
        pendingBalances,
        queueLength: this.paymentQueue.length,
        activeMiners: this.minerBalances.size,
        recentPayments,
        lastPayout: Math.max(...Array.from(this.minerBalances.values()).map(m => m.lastPayout || 0)),
        automaticPayouts: true,
        payoutInterval: '1 hour'
      };
    } catch (error) {
      this.logger.error('Error getting payment stats:', error);
      return {};
    }
  }

  /**
   * Get miner information
   */
  getMinerInfo(minerId, currency) {
    const key = `${minerId}:${currency}`;
    const minerData = this.minerBalances.get(key);
    
    if (!minerData) return null;

    return {
      id: minerId,
      walletAddress: minerData.walletAddress,
      currency,
      balance: minerData.balance / 1e8,
      totalPaid: minerData.totalPaid / 1e8,
      shareCount: minerData.shareCount,
      validShares: minerData.validShares,
      lastPayout: minerData.lastPayout,
      efficiency: minerData.shareCount > 0 ? (minerData.validShares / minerData.shareCount * 100).toFixed(2) : '0.00'
    };
  }

  /**
   * Stop automated payment processing
   */
  stop() {
    if (this.paymentTimer) {
      clearInterval(this.paymentTimer);
      this.paymentTimer = null;
    }
    
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
    
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    
    this.logger.info('Automated payment processing stopped');
  }
}
