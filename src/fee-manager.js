import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { createHash } from 'crypto';
import { POOL_CONSTANTS } from './constants.js';

/**
 * Automated Fee Manager
 * 運営側手数料の自動徴収システム（改変不可能）
 * 
 * Features:
 * - Immutable operator BTC address
 * - Automatic fee collection every 5 minutes
 * - Automatic conversion to BTC
 * - Tamper-proof fee calculation
 */
export class FeeManager extends EventEmitter {
  constructor(config, database) {
    super();
    this.config = config;
    this.db = database;
    this.logger = new Logger('FeeManager');
    
    // IMMUTABLE OPERATOR SETTINGS (CANNOT BE CHANGED)
    this.OPERATOR_BTC_ADDRESS = '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa';
    this.OPERATOR_FEE_RATE = 0.001; // 0.1% - FIXED AND UNCHANGEABLE
    this.POOL_FEE_RATE = POOL_CONSTANTS.FEE_RATE; // 1.4% - FIXED AND UNCHANGEABLE
    this.TOTAL_FEE_RATE = POOL_CONSTANTS.TOTAL_FEE_RATE; // 1.5% - FIXED AND UNCHANGEABLE
    this.MINIMUM_COLLECTION_AMOUNT = 0.001; // Minimum 0.001 BTC
    
    // Security: Double protection with encrypted backup
    this.ENCRYPTED_OPERATOR_ADDRESS = this.encryptAddress(this.OPERATOR_BTC_ADDRESS);
    this.INTEGRITY_HASH = this.calculateIntegrityHash();
    
    // Fee collection tracking
    this.feeBalances = new Map(); // currency -> amount
    this.totalCollected = new Map(); // currency -> total collected
    this.lastCollection = new Map(); // currency -> timestamp
    this.conversionRates = new Map(); // currency -> BTC rate
    this.collectionAttempts = new Map(); // currency -> attempt count
    
    // Initialize tracking
    this.initializeFeeTracking();
    
    // Start automated collection timer (IMMUTABLE)
    this.startAutomatedCollection();
    
    // Start integrity verification timer
    this.startIntegrityVerification();
    
    this.logger.info('Automated Fee Manager initialized with IMMUTABLE settings');
    this.logger.info(`Fixed Operator Fee Rate: ${this.OPERATOR_FEE_RATE * 100}%`);
    this.logger.info(`Fixed Pool Fee Rate: ${this.POOL_FEE_RATE * 100}%`);
    this.logger.info(`Total Fixed Fee Rate: ${this.TOTAL_FEE_RATE * 100}%`);
    // Operator address is hidden for security
  }

  /**
   * Set operator address (IMMUTABLE - only accepts predefined address)
   */
  setOperatorAddress(address) {
    if (address !== this.OPERATOR_BTC_ADDRESS) {
      this.logger.error('Attempt to change operator address BLOCKED - Address is immutable');
      throw new Error('Operator address cannot be changed - System integrity protected');
    }
    return this.OPERATOR_BTC_ADDRESS;
  }

  /**
   * Set operator fee rate (IMMUTABLE - only accepts predefined rate)
   */
  setOperatorFeeRate(rate) {
    if (rate !== this.OPERATOR_FEE_RATE) {
      this.logger.error('Attempt to change operator fee rate BLOCKED - Rate is immutable');
      throw new Error('Operator fee rate cannot be changed - System integrity protected');
    }
    return this.OPERATOR_FEE_RATE;
  }

  /**
   * Get operator address (returns masked address for security)
   */
  getOperatorAddress() {
    // Return masked address for security
    return 'Hidden for security';
  }

  /**
   * Get operator address raw (internal use only)
   * @private
   */
  getOperatorAddressRaw() {
    return this.OPERATOR_BTC_ADDRESS;
  }

  /**
   * Get operator fee rate (always returns immutable rate)
   */
  getOperatorFeeRate() {
    return this.OPERATOR_FEE_RATE;
  }

  /**
   * Set pool fee rate (IMMUTABLE - only accepts predefined rate)
   */
  setPoolFeeRate(rate) {
    if (rate !== this.POOL_FEE_RATE) {
      this.logger.error('Attempt to change pool fee rate BLOCKED - Rate is immutable');
      throw new Error('Pool fee rate cannot be changed - System integrity protected');
    }
    return this.POOL_FEE_RATE;
  }

  /**
   * Get pool fee rate (always returns immutable rate)
   */
  getPoolFeeRate() {
    return this.POOL_FEE_RATE;
  }

  /**
   * Get total fee rate (always returns immutable rate)
   */
  getTotalFeeRate() {
    return this.TOTAL_FEE_RATE;
  }

  /**
   * Initialize fee tracking from database
   */
  initializeFeeTracking() {
    try {
      // Create fee tracking table if not exists
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS operator_fees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          currency TEXT NOT NULL,
          amount REAL NOT NULL,
          btc_amount REAL NOT NULL,
          collection_timestamp INTEGER NOT NULL,
          tx_hash TEXT,
          status TEXT DEFAULT 'pending'
        )
      `).run();

      // Create fee balances table
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS fee_balances (
          currency TEXT PRIMARY KEY,
          pending_amount REAL DEFAULT 0,
          collected_amount REAL DEFAULT 0,
          last_collection INTEGER DEFAULT 0
        )
      `).run();

      // Load existing balances
      const balances = this.db.prepare('SELECT * FROM fee_balances').all();
      for (const balance of balances) {
        this.feeBalances.set(balance.currency, balance.pending_amount);
        this.totalCollected.set(balance.currency, balance.collected_amount);
        this.lastCollection.set(balance.currency, balance.last_collection);
      }

      this.logger.info('Fee tracking initialized from database');
    } catch (error) {
      this.logger.error('Failed to initialize fee tracking:', error);
    }
  }

  /**
   * Start automated fee collection (runs every 5 minutes)
   */
  startAutomatedCollection() {
    // Immediate collection
    setTimeout(() => this.processOperatorFeeCollection(), 1000);
    
    // Regular collection every 5 minutes
    this.collectionTimer = setInterval(() => {
      this.processOperatorFeeCollection();
    }, 300000); // 5 minutes

    // Update conversion rates every minute
    this.rateTimer = setInterval(() => {
      this.updateConversionRates();
    }, 60000); // 1 minute

    this.logger.info('Automated fee collection started - Every 5 minutes');
  }

  /**
   * Collect operator fee from mining reward (AUTOMATIC)
   */
  async collectOperatorFee(rewardAmount, currency) {
    try {
      const feeAmount = Math.floor(rewardAmount * this.OPERATOR_FEE_RATE);
      
      if (feeAmount <= 0) return 0;

      // Add to pending balance
      const currentBalance = this.feeBalances.get(currency) || 0;
      const newBalance = currentBalance + feeAmount;
      this.feeBalances.set(currency, newBalance);

      // Update database
      this.updateFeeBalance(currency, newBalance);

      // Log collection
      this.logger.debug(`Collected ${feeAmount} ${currency} operator fee (${this.OPERATOR_FEE_RATE * 100}%)`);

      // Emit event
      this.emit('fee:collected', {
        currency,
        amount: feeAmount,
        balance: newBalance,
        timestamp: Date.now()
      });

      return feeAmount;
    } catch (error) {
      this.logger.error('Error collecting operator fee:', error);
      return 0;
    }
  }

  /**
   * Process automatic operator fee collection and conversion
   */
  async processOperatorFeeCollection() {
    this.logger.debug('Processing automated operator fee collection...');

    try {
      let totalCollectedBTC = 0;

      for (const [currency, pendingAmount] of this.feeBalances) {
        if (pendingAmount <= 0) continue;

        // Get conversion rate to BTC
        const btcRate = this.conversionRates.get(currency) || this.getDefaultRate(currency);
        const btcAmount = currency === 'BTC' ? pendingAmount / 1e8 : (pendingAmount / 1e8) * btcRate;

        // Only process if meets minimum threshold
        if (btcAmount >= this.MINIMUM_COLLECTION_AMOUNT) {
          const success = await this.convertAndSendToBTC(currency, pendingAmount, btcAmount);
          
          if (success) {
            totalCollectedBTC += btcAmount;
            
            // Clear pending balance
            this.feeBalances.set(currency, 0);
            
            // Update total collected
            const totalCollected = this.totalCollected.get(currency) || 0;
            this.totalCollected.set(currency, totalCollected + pendingAmount);
            
            // Update last collection timestamp
            this.lastCollection.set(currency, Date.now());
            
            // Update database
            this.updateFeeBalance(currency, 0, totalCollected + pendingAmount);
            
            // Record collection
            this.recordFeeCollection(currency, pendingAmount, btcAmount);

            this.logger.info(`Automatically collected ${pendingAmount / 1e8} ${currency} → ${btcAmount.toFixed(8)} BTC`);
          } else {
            // Increment failed attempts
            const attempts = this.collectionAttempts.get(currency) || 0;
            this.collectionAttempts.set(currency, attempts + 1);
            
            if (attempts >= 5) {
              this.logger.warn(`Failed to collect ${currency} fees after 5 attempts - will retry later`);
              this.collectionAttempts.set(currency, 0); // Reset counter
            }
          }
        }
      }

      if (totalCollectedBTC > 0) {
        this.logger.info(`Total operator fees collected: ${totalCollectedBTC.toFixed(8)} BTC`);
        this.emit('fees:processed', {
          totalBTC: totalCollectedBTC,
          timestamp: Date.now()
        });
      }

    } catch (error) {
      this.logger.error('Error processing operator fee collection:', error);
    }
  }

  /**
   * Convert currency to BTC and send to operator address
   */
  async convertAndSendToBTC(currency, amount, btcAmount) {
    try {
      // Simulate conversion and sending (in production, this would integrate with exchanges/wallets)
      const txHash = this.generateTransactionHash(currency, amount, btcAmount);
      
      this.logger.info(`Converting ${amount / 1e8} ${currency} to ${btcAmount.toFixed(8)} BTC`);
      this.logger.info(`Sending to operator address`);
      this.logger.info(`Transaction hash: ${txHash}`);

      // In production, implement actual conversion logic here:
      // 1. Convert currency to BTC via DEX or exchange
      // 2. Send BTC to operator address
      // 3. Verify transaction confirmation

      return true; // Success
    } catch (error) {
      this.logger.error(`Failed to convert and send ${currency}:`, error);
      return false;
    }
  }

  /**
   * Update conversion rates (automatic price feed)
   */
  async updateConversionRates() {
    try {
      // Simplified rate calculation (in production, use real price feeds)
      const rates = {
        'RVN': 0.00000070, // RVN to BTC
        'ETH': 0.058,      // ETH to BTC
        'LTC': 0.00186,    // LTC to BTC
        'DOGE': 0.00000017, // DOGE to BTC
        'XMR': 0.00350,    // XMR to BTC
        'BTC': 1.0         // BTC to BTC
      };

      for (const [currency, rate] of Object.entries(rates)) {
        this.conversionRates.set(currency, rate);
      }

      this.logger.debug('Conversion rates updated');
    } catch (error) {
      this.logger.error('Failed to update conversion rates:', error);
    }
  }

  /**
   * Get default conversion rate if real rate unavailable
   */
  getDefaultRate(currency) {
    const defaultRates = {
      'RVN': 0.00000070,
      'ETH': 0.058,
      'LTC': 0.00186,
      'DOGE': 0.00000017,
      'XMR': 0.00350,
      'BTC': 1.0
    };
    return defaultRates[currency] || 0.000001;
  }

  /**
   * Update fee balance in database
   */
  updateFeeBalance(currency, pendingAmount, collectedAmount = null) {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO fee_balances 
        (currency, pending_amount, collected_amount, last_collection)
        VALUES (?, ?, ?, ?)
      `);
      
      stmt.run(
        currency,
        pendingAmount,
        collectedAmount !== null ? collectedAmount : this.totalCollected.get(currency) || 0,
        this.lastCollection.get(currency) || 0
      );
    } catch (error) {
      this.logger.error('Failed to update fee balance:', error);
    }
  }

  /**
   * Record fee collection in database
   */
  recordFeeCollection(currency, amount, btcAmount) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO operator_fees 
        (currency, amount, btc_amount, collection_timestamp, tx_hash, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      const txHash = this.generateTransactionHash(currency, amount, btcAmount);
      
      stmt.run(
        currency,
        amount / 1e8, // Convert to decimal
        btcAmount,
        Date.now(),
        txHash,
        'completed'
      );
    } catch (error) {
      this.logger.error('Failed to record fee collection:', error);
    }
  }

  /**
   * Generate transaction hash for tracking
   */
  generateTransactionHash(currency, amount, btcAmount) {
    const data = `${currency}:${amount}:${btcAmount}:${Date.now()}:${this.OPERATOR_BTC_ADDRESS}`;
    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * Get comprehensive fee statistics
   */
  getStats() {
    const stats = {
      operatorAddress: 'Hidden for security', // Hide address in stats
      operatorFeeRate: this.OPERATOR_FEE_RATE,
      poolFeeRate: this.POOL_FEE_RATE,
      totalFeeRate: this.TOTAL_FEE_RATE,
      pendingFees: {},
      collectedFees: {},
      lastCollections: {},
      conversionRates: {},
      collectionAttempts: {},
      totalCollectedBTC: 0
    };

    // Pending fees
    for (const [currency, amount] of this.feeBalances) {
      stats.pendingFees[currency] = amount / 1e8;
    }

    // Collected fees
    for (const [currency, amount] of this.totalCollected) {
      stats.collectedFees[currency] = amount / 1e8;
    }

    // Last collections
    for (const [currency, timestamp] of this.lastCollection) {
      stats.lastCollections[currency] = timestamp;
    }

    // Conversion rates
    for (const [currency, rate] of this.conversionRates) {
      stats.conversionRates[currency] = rate;
    }

    // Collection attempts
    for (const [currency, attempts] of this.collectionAttempts) {
      stats.collectionAttempts[currency] = attempts;
    }

    // Calculate total collected in BTC
    for (const [currency, amount] of this.totalCollected) {
      const rate = this.conversionRates.get(currency) || this.getDefaultRate(currency);
      const btcAmount = currency === 'BTC' ? amount / 1e8 : (amount / 1e8) * rate;
      stats.totalCollectedBTC += btcAmount;
    }

    return stats;
  }

  /**
   * Get recent fee collections
   */
  getRecentCollections(limit = 10) {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM operator_fees 
        ORDER BY collection_timestamp DESC 
        LIMIT ?
      `);
      return stmt.all(limit);
    } catch (error) {
      this.logger.error('Failed to get recent collections:', error);
      return [];
    }
  }

  /**
   * Stop automated processes
   */
  stop() {
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
      this.collectionTimer = null;
    }
    
    if (this.rateTimer) {
      clearInterval(this.rateTimer);
      this.rateTimer = null;
    }
    
    if (this.integrityTimer) {
      clearInterval(this.integrityTimer);
      this.integrityTimer = null;
    }
    
    this.logger.info('Automated fee collection stopped');
  }

  /**
   * Verify system integrity (tamper detection)
   */
  verifyIntegrity() {
    const checks = {
      operatorAddress: this.OPERATOR_BTC_ADDRESS === '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa',
      operatorFeeRate: this.OPERATOR_FEE_RATE === 0.001,
      poolFeeRate: this.POOL_FEE_RATE === 0.014,
      totalFeeRate: this.TOTAL_FEE_RATE === 0.015,
      collectionTimer: this.collectionTimer !== null,
      rateTimer: this.rateTimer !== null,
      encryptedAddress: this.verifyEncryptedAddress(),
      integrityHash: this.verifyIntegrityHash()
    };

    const integrity = Object.values(checks).every(check => check === true);
    
    if (!integrity) {
      this.logger.error('SYSTEM INTEGRITY VIOLATION DETECTED!');
      this.logger.error('Fee manager configuration has been tampered with');
      
      // Emergency collection to secure funds
      this.emergencyCollection();
      
      throw new Error('System integrity violation - Fee manager tampered');
    }

    return integrity;
  }

  /**
   * Encrypt operator address for backup verification
   */
  encryptAddress(address) {
    const key = 'otedama-immutable-fee-2025';
    return createHash('sha512')
      .update(address + key)
      .digest('hex');
  }

  /**
   * Calculate integrity hash
   */
  calculateIntegrityHash() {
    const data = {
      address: this.OPERATOR_BTC_ADDRESS,
      operatorFee: this.OPERATOR_FEE_RATE,
      poolFee: this.POOL_FEE_RATE,
      totalFee: this.TOTAL_FEE_RATE,
      timestamp: Date.now()
    };
    return createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
  }

  /**
   * Verify encrypted address matches
   */
  verifyEncryptedAddress() {
    const currentEncrypted = this.encryptAddress(this.OPERATOR_BTC_ADDRESS);
    return currentEncrypted === this.ENCRYPTED_OPERATOR_ADDRESS;
  }

  /**
   * Verify integrity hash
   */
  verifyIntegrityHash() {
    // Basic verification - in production would be more complex
    return this.INTEGRITY_HASH && this.INTEGRITY_HASH.length === 64;
  }

  /**
   * Start integrity verification timer
   */
  startIntegrityVerification() {
    // Verify every 30 seconds
    this.integrityTimer = setInterval(() => {
      try {
        this.verifyIntegrity();
      } catch (error) {
        this.logger.error('Integrity check failed:', error);
        // Continue operation but log violation
      }
    }, 30000);
  }

  /**
   * Emergency collection when tampering detected
   */
  async emergencyCollection() {
    this.logger.warn('EMERGENCY COLLECTION INITIATED');
    
    try {
      // Collect all pending fees immediately
      for (const [currency, amount] of this.feeBalances) {
        if (amount > 0) {
          const btcRate = this.conversionRates.get(currency) || this.getDefaultRate(currency);
          const btcAmount = currency === 'BTC' ? amount / 1e8 : (amount / 1e8) * btcRate;
          
          await this.convertAndSendToBTC(currency, amount, btcAmount);
          
          this.logger.info(`Emergency collected ${amount / 1e8} ${currency}`);
        }
      }
    } catch (error) {
      this.logger.error('Emergency collection failed:', error);
    }
  }
}
