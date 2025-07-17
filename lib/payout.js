/**
 * Payout System for Otedama Mining Pool
 * Handles BTC-only payouts with two options:
 * 1. Direct payout: Mined currency - 1.8% pool fee (in BTC)
 * 2. Auto-convert: Convert to BTC with 2% conversion fee
 */

import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import Database from 'better-sqlite3';

export const PayoutMode = {
  DIRECT: 'direct',      // Pay in mined currency minus 1.8% BTC fee
  CONVERT: 'convert'     // Convert to BTC minus 2% fee
};

export const FeeStructure = {
  POOL_FEE_DIRECT: 0.018,    // 1.8% pool fee for direct payout
  CONVERSION_FEE: 0.02       // 2% total fee for BTC conversion
};

export class PayoutManager extends EventEmitter {
  constructor(db, options = {}) {
    super();
    this.db = db;
    this.logger = options.logger || new Logger();
    this.options = {
      minimumPayout: options.minimumPayout || 0.001, // 0.001 BTC minimum
      payoutInterval: options.payoutInterval || 3600000, // 1 hour
      exchangeRateUpdateInterval: options.exchangeRateUpdateInterval || 300000, // 5 minutes
      ...options
    };
    
    this.exchangeRates = new Map();
    this.pendingPayouts = new Map();
    
    this.initializeDatabase();
    this.startPayoutScheduler();
    this.startExchangeRateUpdater();
  }
  
  initializeDatabase() {
    // Miner preferences table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS miner_preferences (
        wallet_address TEXT PRIMARY KEY,
        payout_mode TEXT DEFAULT 'convert',
        minimum_payout REAL DEFAULT 0.001,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    
    // Pending payouts table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_address TEXT NOT NULL,
        currency TEXT NOT NULL,
        amount REAL NOT NULL,
        btc_value REAL NOT NULL,
        pool_fee_btc REAL NOT NULL,
        conversion_fee_btc REAL DEFAULT 0,
        net_amount REAL NOT NULL,
        net_currency TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        processed_at INTEGER,
        tx_hash TEXT,
        FOREIGN KEY (wallet_address) REFERENCES miners(wallet_address)
      )
    `);
    
    // Exchange rates table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS exchange_rates (
        currency TEXT PRIMARY KEY,
        btc_rate REAL NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    
    // Payout history table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payout_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_address TEXT NOT NULL,
        original_currency TEXT NOT NULL,
        original_amount REAL NOT NULL,
        payout_currency TEXT NOT NULL,
        payout_amount REAL NOT NULL,
        pool_fee_btc REAL NOT NULL,
        conversion_fee_btc REAL DEFAULT 0,
        btc_rate REAL,
        tx_hash TEXT,
        status TEXT DEFAULT 'completed',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        confirmed_at INTEGER
      )
    `);
  }
  
  /**
   * Set miner payout preference
   */
  setMinerPreference(walletAddress, mode, minimumPayout = null) {
    if (!Object.values(PayoutMode).includes(mode)) {
      throw new Error(`Invalid payout mode: ${mode}`);
    }
    
    const stmt = this.db.prepare(`
      INSERT INTO miner_preferences (wallet_address, payout_mode, minimum_payout)
      VALUES (?, ?, ?)
      ON CONFLICT(wallet_address) DO UPDATE SET
        payout_mode = excluded.payout_mode,
        minimum_payout = excluded.minimum_payout,
        updated_at = strftime('%s', 'now')
    `);
    
    stmt.run(
      walletAddress,
      mode,
      minimumPayout || this.options.minimumPayout
    );
    
    this.emit('preference:updated', { walletAddress, mode, minimumPayout });
    this.logger.info(`Updated payout preference for ${walletAddress}: ${mode}`);
  }
  
  /**
   * Get miner payout preference
   */
  getMinerPreference(walletAddress) {
    const stmt = this.db.prepare(`
      SELECT * FROM miner_preferences WHERE wallet_address = ?
    `);
    
    const preference = stmt.get(walletAddress);
    
    if (!preference) {
      // Return default preference
      return {
        wallet_address: walletAddress,
        payout_mode: PayoutMode.CONVERT,
        minimum_payout: this.options.minimumPayout
      };
    }
    
    return preference;
  }
  
  /**
   * Add mining reward to pending payouts
   */
  async addMiningReward(walletAddress, currency, amount) {
    const preference = this.getMinerPreference(walletAddress);
    const btcRate = await this.getExchangeRate(currency);
    const btcValue = amount * btcRate;
    
    let poolFeeBtc, conversionFeeBtc, netAmount, netCurrency;
    
    if (preference.payout_mode === PayoutMode.DIRECT) {
      // Direct payout: deduct 1.8% pool fee in BTC
      poolFeeBtc = btcValue * FeeStructure.POOL_FEE_DIRECT;
      conversionFeeBtc = 0;
      netAmount = amount; // Pay full amount in original currency
      netCurrency = currency;
    } else {
      // Convert to BTC: 2% total fee
      poolFeeBtc = btcValue * FeeStructure.CONVERSION_FEE;
      conversionFeeBtc = 0; // Included in pool fee for simplicity
      netAmount = btcValue - poolFeeBtc;
      netCurrency = 'BTC';
    }
    
    const stmt = this.db.prepare(`
      INSERT INTO pending_payouts (
        wallet_address, currency, amount, btc_value,
        pool_fee_btc, conversion_fee_btc, net_amount, net_currency
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      walletAddress,
      currency,
      amount,
      btcValue,
      poolFeeBtc,
      conversionFeeBtc,
      netAmount,
      netCurrency
    );
    
    this.emit('reward:added', {
      walletAddress,
      currency,
      amount,
      btcValue,
      netAmount,
      netCurrency
    });
    
    this.logger.info(`Added mining reward for ${walletAddress}: ${amount} ${currency}`);
  }
  
  /**
   * Process pending payouts
   */
  async processPendingPayouts() {
    const stmt = this.db.prepare(`
      SELECT 
        wallet_address,
        net_currency,
        SUM(net_amount) as total_amount,
        SUM(pool_fee_btc) as total_pool_fee,
        GROUP_CONCAT(id) as payout_ids
      FROM pending_payouts
      WHERE status = 'pending'
      GROUP BY wallet_address, net_currency
      HAVING total_amount >= ?
    `);
    
    const payouts = stmt.all(this.options.minimumPayout);
    
    for (const payout of payouts) {
      try {
        await this.processPayout(payout);
      } catch (error) {
        this.logger.error(`Failed to process payout for ${payout.wallet_address}`, error);
      }
    }
  }
  
  /**
   * Process individual payout
   */
  async processPayout(payout) {
    const { wallet_address, net_currency, total_amount, payout_ids } = payout;
    
    // In production, this would interact with actual blockchain
    // For now, we'll simulate the transaction
    const txHash = this.generateMockTxHash();
    
    this.logger.info(`Processing payout: ${total_amount} ${net_currency} to ${wallet_address}`);
    
    // Update pending payouts
    const updateStmt = this.db.prepare(`
      UPDATE pending_payouts
      SET status = 'processing', 
          processed_at = strftime('%s', 'now'),
          tx_hash = ?
      WHERE id IN (${payout_ids})
    `);
    
    updateStmt.run(txHash);
    
    // Record in history
    const ids = payout_ids.split(',').map(id => parseInt(id));
    for (const id of ids) {
      await this.recordPayoutHistory(id, txHash);
    }
    
    // Simulate blockchain confirmation
    setTimeout(() => {
      this.confirmPayout(txHash);
    }, 5000);
    
    this.emit('payout:sent', {
      walletAddress: wallet_address,
      amount: total_amount,
      currency: net_currency,
      txHash
    });
  }
  
  /**
   * Record payout in history
   */
  async recordPayoutHistory(payoutId, txHash) {
    const payout = this.db.prepare(`
      SELECT * FROM pending_payouts WHERE id = ?
    `).get(payoutId);
    
    if (!payout) return;
    
    const stmt = this.db.prepare(`
      INSERT INTO payout_history (
        wallet_address, original_currency, original_amount,
        payout_currency, payout_amount, pool_fee_btc,
        conversion_fee_btc, btc_rate, tx_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      payout.wallet_address,
      payout.currency,
      payout.amount,
      payout.net_currency,
      payout.net_amount,
      payout.pool_fee_btc,
      payout.conversion_fee_btc,
      payout.amount > 0 ? payout.btc_value / payout.amount : 0,
      txHash
    );
  }
  
  /**
   * Confirm payout
   */
  confirmPayout(txHash) {
    const updateStmt = this.db.prepare(`
      UPDATE pending_payouts
      SET status = 'completed'
      WHERE tx_hash = ?
    `);
    
    updateStmt.run(txHash);
    
    const historyStmt = this.db.prepare(`
      UPDATE payout_history
      SET confirmed_at = strftime('%s', 'now')
      WHERE tx_hash = ?
    `);
    
    historyStmt.run(txHash);
    
    this.emit('payout:confirmed', { txHash });
    this.logger.info(`Payout confirmed: ${txHash}`);
  }
  
  /**
   * Get pending balance for miner
   */
  getPendingBalance(walletAddress) {
    const stmt = this.db.prepare(`
      SELECT 
        net_currency as currency,
        SUM(net_amount) as balance
      FROM pending_payouts
      WHERE wallet_address = ? AND status = 'pending'
      GROUP BY net_currency
    `);
    
    return stmt.all(walletAddress);
  }
  
  /**
   * Get payout history for miner
   */
  getPayoutHistory(walletAddress, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM payout_history
      WHERE wallet_address = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    
    return stmt.all(walletAddress, limit);
  }
  
  /**
   * Get pool statistics
   */
  getPoolStats() {
    const stats = {
      totalPayouts: 0,
      totalFeesCollected: 0,
      payoutsByMode: {
        direct: 0,
        convert: 0
      }
    };
    
    // Total payouts
    const payoutStmt = this.db.prepare(`
      SELECT 
        COUNT(*) as count,
        SUM(payout_amount) as total,
        SUM(pool_fee_btc) as fees
      FROM payout_history
      WHERE status = 'completed'
    `);
    
    const payoutStats = payoutStmt.get();
    stats.totalPayouts = payoutStats.total || 0;
    stats.totalFeesCollected = payoutStats.fees || 0;
    
    // Payouts by mode
    const modeStmt = this.db.prepare(`
      SELECT 
        CASE 
          WHEN original_currency = payout_currency THEN 'direct'
          ELSE 'convert'
        END as mode,
        COUNT(*) as count
      FROM payout_history
      GROUP BY mode
    `);
    
    const modeStats = modeStmt.all();
    for (const row of modeStats) {
      stats.payoutsByMode[row.mode] = row.count;
    }
    
    return stats;
  }
  
  /**
   * Update exchange rates
   */
  async updateExchangeRates() {
    // In production, this would fetch from real exchange APIs
    // For now, we'll use mock rates
    const mockRates = {
      'ETH': 0.054,    // 1 ETH = 0.054 BTC
      'LTC': 0.0025,   // 1 LTC = 0.0025 BTC
      'DOGE': 0.0000025, // 1 DOGE = 0.0000025 BTC
      'BTC': 1.0       // 1 BTC = 1 BTC
    };
    
    for (const [currency, rate] of Object.entries(mockRates)) {
      this.exchangeRates.set(currency, rate);
      
      const stmt = this.db.prepare(`
        INSERT INTO exchange_rates (currency, btc_rate)
        VALUES (?, ?)
        ON CONFLICT(currency) DO UPDATE SET
          btc_rate = excluded.btc_rate,
          updated_at = strftime('%s', 'now')
      `);
      
      stmt.run(currency, rate);
    }
    
    this.emit('rates:updated', mockRates);
  }
  
  /**
   * Get exchange rate for currency
   */
  async getExchangeRate(currency) {
    if (currency === 'BTC') return 1.0;
    
    // Try memory cache first
    if (this.exchangeRates.has(currency)) {
      return this.exchangeRates.get(currency);
    }
    
    // Try database
    const stmt = this.db.prepare(`
      SELECT btc_rate FROM exchange_rates WHERE currency = ?
    `);
    
    const row = stmt.get(currency);
    if (row) {
      this.exchangeRates.set(currency, row.btc_rate);
      return row.btc_rate;
    }
    
    // Update rates and try again
    await this.updateExchangeRates();
    return this.exchangeRates.get(currency) || 0;
  }
  
  /**
   * Start payout scheduler
   */
  startPayoutScheduler() {
    setInterval(() => {
      this.processPendingPayouts().catch(error => {
        this.logger.error('Payout processing failed', error);
      });
    }, this.options.payoutInterval);
    
    this.logger.info('Payout scheduler started');
  }
  
  /**
   * Start exchange rate updater
   */
  startExchangeRateUpdater() {
    // Initial update
    this.updateExchangeRates();
    
    // Schedule updates
    setInterval(() => {
      this.updateExchangeRates().catch(error => {
        this.logger.error('Exchange rate update failed', error);
      });
    }, this.options.exchangeRateUpdateInterval);
    
    this.logger.info('Exchange rate updater started');
  }
  
  /**
   * Generate mock transaction hash
   */
  generateMockTxHash() {
    return '0x' + Array.from({ length: 64 }, () => 
      Math.floor(Math.random() * 16).toString(16)
    ).join('');
  }
  
  /**
   * Calculate estimated payout
   */
  async calculateEstimatedPayout(walletAddress, currency, amount) {
    const preference = this.getMinerPreference(walletAddress);
    const btcRate = await this.getExchangeRate(currency);
    const btcValue = amount * btcRate;
    
    if (preference.payout_mode === PayoutMode.DIRECT) {
      return {
        mode: 'direct',
        currency: currency,
        grossAmount: amount,
        poolFeeBtc: btcValue * FeeStructure.POOL_FEE_DIRECT,
        netAmount: amount,
        netCurrency: currency
      };
    } else {
      const poolFee = btcValue * FeeStructure.CONVERSION_FEE;
      return {
        mode: 'convert',
        currency: 'BTC',
        grossAmount: btcValue,
        poolFeeBtc: poolFee,
        netAmount: btcValue - poolFee,
        netCurrency: 'BTC'
      };
    }
  }
}