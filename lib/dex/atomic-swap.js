/**
 * Atomic Swap Engine for Otedama DEX
 * Implements cross-chain atomic swaps for trustless trading
 * Following John Carmack's performance and simplicity principles
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import { getErrorHandler, OtedamaError, ErrorCategory, safeExecute } from '../core/standardized-error-handler.js';
import { CacheFactory } from '../core/cache-manager.js';

// Swap states
export const SwapState = {
  INITIATED: 'initiated',
  PARTICIPANT_READY: 'participant_ready',
  REDEEMED: 'redeemed',
  REFUNDED: 'refunded',
  EXPIRED: 'expired'
};

// Supported chains
export const SupportedChains = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  LTC: 'litecoin',
  XMR: 'monero',
  RVN: 'ravencoin'
};

// Chain configurations
const ChainConfig = {
  [SupportedChains.BTC]: {
    lockTime: 48, // hours
    confirmations: 3,
    scriptType: 'HTLC_P2SH'
  },
  [SupportedChains.ETH]: {
    lockTime: 24, // hours
    confirmations: 12,
    scriptType: 'HTLC_CONTRACT'
  },
  [SupportedChains.LTC]: {
    lockTime: 24, // hours
    confirmations: 6,
    scriptType: 'HTLC_P2SH'
  },
  [SupportedChains.XMR]: {
    lockTime: 72, // hours (longer for privacy coins)
    confirmations: 10,
    scriptType: 'HTLC_MULTISIG'
  },
  [SupportedChains.RVN]: {
    lockTime: 24, // hours
    confirmations: 60,
    scriptType: 'HTLC_P2SH'
  }
};

export class AtomicSwapEngine extends EventEmitter {
  constructor(db, options = {}) {
    super();
    
    this.db = db;
    this.options = {
      minSwapAmount: options.minSwapAmount || {
        BTC: 0.0001,
        ETH: 0.01,
        LTC: 0.1,
        XMR: 0.1,
        RVN: 100
      },
      maxSwapAmount: options.maxSwapAmount || {
        BTC: 1,
        ETH: 50,
        LTC: 100,
        XMR: 100,
        RVN: 100000
      },
      feeRate: options.feeRate || 0.002, // 0.2%
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.cache = CacheFactory.createDexCache();
    
    // Active swaps tracking
    this.activeSwaps = new Map();
    this.pendingSwaps = new Map();
    
    // Statistics
    this.stats = {
      totalSwaps: 0,
      completedSwaps: 0,
      refundedSwaps: 0,
      totalVolume: {},
      feesCollected: {}
    };
    
    this.initializeDatabase();
    this.startMonitoring();
  }
  
  /**
   * Initialize database tables
   */
  initializeDatabase() {
    // Atomic swaps table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS atomic_swaps (
        id TEXT PRIMARY KEY,
        initiator_address TEXT NOT NULL,
        participant_address TEXT,
        initiator_amount REAL NOT NULL,
        initiator_currency TEXT NOT NULL,
        participant_amount REAL NOT NULL,
        participant_currency TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        secret TEXT,
        initiator_lock_time INTEGER NOT NULL,
        participant_lock_time INTEGER NOT NULL,
        state TEXT NOT NULL,
        initiator_tx_hash TEXT,
        participant_tx_hash TEXT,
        redeem_tx_hash TEXT,
        refund_tx_hash TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
      
      CREATE INDEX IF NOT EXISTS idx_swaps_state ON atomic_swaps(state);
      CREATE INDEX IF NOT EXISTS idx_swaps_initiator ON atomic_swaps(initiator_address);
      CREATE INDEX IF NOT EXISTS idx_swaps_participant ON atomic_swaps(participant_address);
    `);
    
    // Swap events table for audit trail
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS swap_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        swap_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_data TEXT,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (swap_id) REFERENCES atomic_swaps(id)
      );
    `);
  }
  
  /**
   * Initiate atomic swap
   */
  async initiateSwap(params) {
    const {
      initiatorAddress,
      initiatorAmount,
      initiatorCurrency,
      participantAmount,
      participantCurrency,
      participantAddress = null
    } = params;
    
    // Validate parameters
    this.validateSwapParams(params);
    
    // Generate swap ID and secret
    const swapId = this.generateSwapId();
    const secret = randomBytes(32);
    const secretHash = createHash('sha256').update(secret).digest('hex');
    
    // Calculate lock times
    const now = Date.now();
    const initiatorLockTime = now + (ChainConfig[initiatorCurrency].lockTime * 3600000);
    const participantLockTime = now + (ChainConfig[participantCurrency].lockTime * 3600000 / 2); // Half time for participant
    
    // Create swap record
    const swap = {
      id: swapId,
      initiatorAddress,
      participantAddress,
      initiatorAmount,
      initiatorCurrency,
      participantAmount,
      participantCurrency,
      secretHash,
      secret: secret.toString('hex'),
      initiatorLockTime,
      participantLockTime,
      state: SwapState.INITIATED,
      createdAt: now
    };
    
    // Store in database
    const stmt = this.db.prepare(`
      INSERT INTO atomic_swaps (
        id, initiator_address, participant_address,
        initiator_amount, initiator_currency,
        participant_amount, participant_currency,
        secret_hash, secret,
        initiator_lock_time, participant_lock_time,
        state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      swap.id,
      swap.initiatorAddress,
      swap.participantAddress,
      swap.initiatorAmount,
      swap.initiatorCurrency,
      swap.participantAmount,
      swap.participantCurrency,
      swap.secretHash,
      swap.secret,
      swap.initiatorLockTime,
      swap.participantLockTime,
      swap.state
    );
    
    // Track active swap
    this.activeSwaps.set(swapId, swap);
    
    // Log event
    this.logSwapEvent(swapId, 'INITIATED', swap);
    
    // Emit event
    this.emit('swap:initiated', swap);
    
    // Return swap details (without secret for participant)
    return {
      swapId,
      secretHash,
      initiatorLockTime,
      participantLockTime,
      contractDetails: this.generateContractDetails(swap)
    };
  }
  
  /**
   * Participate in swap
   */
  async participateInSwap(swapId, participantAddress) {
    const swap = await this.getSwap(swapId);
    
    if (!swap) {
      throw new OtedamaError('Swap not found', ErrorCategory.NOT_FOUND);
    }
    
    if (swap.state !== SwapState.INITIATED) {
      throw new OtedamaError(
        `Invalid swap state: ${swap.state}`,
        ErrorCategory.VALIDATION
      );
    }
    
    if (swap.participantAddress && swap.participantAddress !== participantAddress) {
      throw new OtedamaError(
        'Swap already has a different participant',
        ErrorCategory.VALIDATION
      );
    }
    
    // Update swap
    const stmt = this.db.prepare(`
      UPDATE atomic_swaps
      SET participant_address = ?,
          state = ?,
          updated_at = strftime('%s', 'now')
      WHERE id = ?
    `);
    
    stmt.run(participantAddress, SwapState.PARTICIPANT_READY, swapId);
    
    swap.participantAddress = participantAddress;
    swap.state = SwapState.PARTICIPANT_READY;
    
    // Log event
    this.logSwapEvent(swapId, 'PARTICIPANT_JOINED', { participantAddress });
    
    // Emit event
    this.emit('swap:participant_ready', swap);
    
    return {
      contractDetails: this.generateContractDetails(swap, true)
    };
  }
  
  /**
   * Redeem swap
   */
  async redeemSwap(swapId, secret, redeemTxHash) {
    const swap = await this.getSwap(swapId);
    
    if (!swap) {
      throw new OtedamaError('Swap not found', ErrorCategory.NOT_FOUND);
    }
    
    if (swap.state !== SwapState.PARTICIPANT_READY) {
      throw new OtedamaError(
        `Cannot redeem swap in state: ${swap.state}`,
        ErrorCategory.VALIDATION
      );
    }
    
    // Verify secret
    const secretHash = createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex');
    if (secretHash !== swap.secretHash) {
      throw new OtedamaError('Invalid secret', ErrorCategory.VALIDATION);
    }
    
    // Check if not expired
    if (Date.now() > swap.initiatorLockTime) {
      throw new OtedamaError('Swap has expired', ErrorCategory.VALIDATION);
    }
    
    // Update swap
    const stmt = this.db.prepare(`
      UPDATE atomic_swaps
      SET state = ?,
          redeem_tx_hash = ?,
          updated_at = strftime('%s', 'now')
      WHERE id = ?
    `);
    
    stmt.run(SwapState.REDEEMED, redeemTxHash, swapId);
    
    swap.state = SwapState.REDEEMED;
    swap.redeemTxHash = redeemTxHash;
    
    // Update statistics
    this.stats.completedSwaps++;
    this.updateVolumeStats(swap);
    
    // Remove from active swaps
    this.activeSwaps.delete(swapId);
    
    // Log event
    this.logSwapEvent(swapId, 'REDEEMED', { secret, redeemTxHash });
    
    // Emit event
    this.emit('swap:redeemed', swap);
    
    return { success: true, secret };
  }
  
  /**
   * Refund swap
   */
  async refundSwap(swapId, refundTxHash) {
    const swap = await this.getSwap(swapId);
    
    if (!swap) {
      throw new OtedamaError('Swap not found', ErrorCategory.NOT_FOUND);
    }
    
    // Check if expired
    const now = Date.now();
    const isInitiatorRefund = now > swap.initiatorLockTime;
    const isParticipantRefund = now > swap.participantLockTime;
    
    if (!isInitiatorRefund && !isParticipantRefund) {
      throw new OtedamaError('Swap has not expired yet', ErrorCategory.VALIDATION);
    }
    
    // Update swap
    const stmt = this.db.prepare(`
      UPDATE atomic_swaps
      SET state = ?,
          refund_tx_hash = ?,
          updated_at = strftime('%s', 'now')
      WHERE id = ?
    `);
    
    stmt.run(SwapState.REFUNDED, refundTxHash, swapId);
    
    swap.state = SwapState.REFUNDED;
    swap.refundTxHash = refundTxHash;
    
    // Update statistics
    this.stats.refundedSwaps++;
    
    // Remove from active swaps
    this.activeSwaps.delete(swapId);
    
    // Log event
    this.logSwapEvent(swapId, 'REFUNDED', { refundTxHash });
    
    // Emit event
    this.emit('swap:refunded', swap);
    
    return { success: true };
  }
  
  /**
   * Get swap details
   */
  async getSwap(swapId) {
    // Check cache first
    const cached = await this.cache.get(`swap:${swapId}`);
    if (cached) {
      return cached;
    }
    
    // Query database
    const stmt = this.db.prepare(`
      SELECT * FROM atomic_swaps WHERE id = ?
    `);
    
    const swap = stmt.get(swapId);
    
    if (swap) {
      // Cache for 1 minute
      await this.cache.set(`swap:${swapId}`, swap, { ttl: 60000 });
    }
    
    return swap;
  }
  
  /**
   * List user swaps
   */
  async getUserSwaps(address, options = {}) {
    const {
      state = null,
      limit = 50,
      offset = 0
    } = options;
    
    let query = `
      SELECT * FROM atomic_swaps
      WHERE (initiator_address = ? OR participant_address = ?)
    `;
    
    const params = [address, address];
    
    if (state) {
      query += ' AND state = ?';
      params.push(state);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const stmt = this.db.prepare(query);
    return stmt.all(...params);
  }
  
  /**
   * Generate contract details
   */
  generateContractDetails(swap, forParticipant = false) {
    const details = {
      swapId: swap.id,
      secretHash: swap.secretHash,
      initiator: {
        address: swap.initiatorAddress,
        amount: swap.initiatorAmount,
        currency: swap.initiatorCurrency,
        lockTime: swap.initiatorLockTime,
        script: this.generateHTLCScript(
          swap.secretHash,
          swap.initiatorAddress,
          swap.participantAddress || 'PARTICIPANT_ADDRESS',
          swap.initiatorLockTime,
          swap.initiatorCurrency
        )
      },
      participant: {
        address: swap.participantAddress || 'PARTICIPANT_ADDRESS',
        amount: swap.participantAmount,
        currency: swap.participantCurrency,
        lockTime: swap.participantLockTime,
        script: this.generateHTLCScript(
          swap.secretHash,
          swap.participantAddress || 'PARTICIPANT_ADDRESS',
          swap.initiatorAddress,
          swap.participantLockTime,
          swap.participantCurrency
        )
      }
    };
    
    // Don't include secret for participant
    if (!forParticipant && swap.secret) {
      details.secret = swap.secret;
    }
    
    return details;
  }
  
  /**
   * Generate HTLC script
   */
  generateHTLCScript(secretHash, recipientAddress, refundAddress, lockTime, currency) {
    const config = ChainConfig[currency];
    
    switch (config.scriptType) {
      case 'HTLC_P2SH':
        return this.generateP2SHScript(secretHash, recipientAddress, refundAddress, lockTime);
      
      case 'HTLC_CONTRACT':
        return this.generateSmartContract(secretHash, recipientAddress, refundAddress, lockTime);
      
      case 'HTLC_MULTISIG':
        return this.generateMultisigScript(secretHash, recipientAddress, refundAddress, lockTime);
      
      default:
        throw new Error(`Unsupported script type: ${config.scriptType}`);
    }
  }
  
  /**
   * Generate P2SH HTLC script
   */
  generateP2SHScript(secretHash, recipientAddress, refundAddress, lockTime) {
    // Simplified P2SH script representation
    return {
      type: 'P2SH',
      redeemScript: `
        OP_IF
          OP_SHA256 <${secretHash}> OP_EQUALVERIFY
          OP_DUP OP_HASH160 <${recipientAddress}> OP_EQUALVERIFY OP_CHECKSIG
        OP_ELSE
          <${lockTime}> OP_CHECKLOCKTIMEVERIFY OP_DROP
          OP_DUP OP_HASH160 <${refundAddress}> OP_EQUALVERIFY OP_CHECKSIG
        OP_ENDIF
      `.trim()
    };
  }
  
  /**
   * Generate smart contract for Ethereum-like chains
   */
  generateSmartContract(secretHash, recipientAddress, refundAddress, lockTime) {
    return {
      type: 'SMART_CONTRACT',
      contract: {
        secretHash,
        recipient: recipientAddress,
        refundAddress,
        lockTime,
        function: 'HTLC'
      }
    };
  }
  
  /**
   * Generate multisig script for privacy coins
   */
  generateMultisigScript(secretHash, recipientAddress, refundAddress, lockTime) {
    return {
      type: 'MULTISIG',
      participants: [recipientAddress, refundAddress],
      threshold: 1,
      timelock: lockTime,
      secretHash
    };
  }
  
  /**
   * Validate swap parameters
   */
  validateSwapParams(params) {
    const {
      initiatorAmount,
      initiatorCurrency,
      participantAmount,
      participantCurrency
    } = params;
    
    // Check supported currencies
    if (!SupportedChains[initiatorCurrency]) {
      throw new OtedamaError(
        `Unsupported initiator currency: ${initiatorCurrency}`,
        ErrorCategory.VALIDATION
      );
    }
    
    if (!SupportedChains[participantCurrency]) {
      throw new OtedamaError(
        `Unsupported participant currency: ${participantCurrency}`,
        ErrorCategory.VALIDATION
      );
    }
    
    // Check amounts
    const minInitiator = this.options.minSwapAmount[initiatorCurrency];
    const maxInitiator = this.options.maxSwapAmount[initiatorCurrency];
    
    if (initiatorAmount < minInitiator) {
      throw new OtedamaError(
        `Initiator amount below minimum: ${initiatorAmount} < ${minInitiator}`,
        ErrorCategory.VALIDATION
      );
    }
    
    if (initiatorAmount > maxInitiator) {
      throw new OtedamaError(
        `Initiator amount above maximum: ${initiatorAmount} > ${maxInitiator}`,
        ErrorCategory.VALIDATION
      );
    }
    
    const minParticipant = this.options.minSwapAmount[participantCurrency];
    const maxParticipant = this.options.maxSwapAmount[participantCurrency];
    
    if (participantAmount < minParticipant) {
      throw new OtedamaError(
        `Participant amount below minimum: ${participantAmount} < ${minParticipant}`,
        ErrorCategory.VALIDATION
      );
    }
    
    if (participantAmount > maxParticipant) {
      throw new OtedamaError(
        `Participant amount above maximum: ${participantAmount} > ${maxParticipant}`,
        ErrorCategory.VALIDATION
      );
    }
  }
  
  /**
   * Generate swap ID
   */
  generateSwapId() {
    return `swap_${Date.now()}_${randomBytes(8).toString('hex')}`;
  }
  
  /**
   * Log swap event
   */
  logSwapEvent(swapId, eventType, eventData = {}) {
    const stmt = this.db.prepare(`
      INSERT INTO swap_events (swap_id, event_type, event_data)
      VALUES (?, ?, ?)
    `);
    
    stmt.run(swapId, eventType, JSON.stringify(eventData));
  }
  
  /**
   * Update volume statistics
   */
  updateVolumeStats(swap) {
    if (!this.stats.totalVolume[swap.initiatorCurrency]) {
      this.stats.totalVolume[swap.initiatorCurrency] = 0;
    }
    this.stats.totalVolume[swap.initiatorCurrency] += swap.initiatorAmount;
    
    if (!this.stats.totalVolume[swap.participantCurrency]) {
      this.stats.totalVolume[swap.participantCurrency] = 0;
    }
    this.stats.totalVolume[swap.participantCurrency] += swap.participantAmount;
    
    // Calculate fees
    const initiatorFee = swap.initiatorAmount * this.options.feeRate;
    const participantFee = swap.participantAmount * this.options.feeRate;
    
    if (!this.stats.feesCollected[swap.initiatorCurrency]) {
      this.stats.feesCollected[swap.initiatorCurrency] = 0;
    }
    this.stats.feesCollected[swap.initiatorCurrency] += initiatorFee;
    
    if (!this.stats.feesCollected[swap.participantCurrency]) {
      this.stats.feesCollected[swap.participantCurrency] = 0;
    }
    this.stats.feesCollected[swap.participantCurrency] += participantFee;
    
    this.stats.totalSwaps++;
  }
  
  /**
   * Start monitoring for expired swaps
   */
  startMonitoring() {
    // Check for expired swaps every minute
    this.monitoringInterval = setInterval(() => {
      this.checkExpiredSwaps();
    }, 60000);
  }
  
  /**
   * Check and handle expired swaps
   */
  async checkExpiredSwaps() {
    const now = Date.now();
    
    // Find expired swaps
    const stmt = this.db.prepare(`
      SELECT * FROM atomic_swaps
      WHERE state IN (?, ?)
      AND (initiator_lock_time < ? OR participant_lock_time < ?)
    `);
    
    const expiredSwaps = stmt.all(
      SwapState.INITIATED,
      SwapState.PARTICIPANT_READY,
      now,
      now
    );
    
    for (const swap of expiredSwaps) {
      // Update state to expired
      const updateStmt = this.db.prepare(`
        UPDATE atomic_swaps
        SET state = ?,
            updated_at = strftime('%s', 'now')
        WHERE id = ?
      `);
      
      updateStmt.run(SwapState.EXPIRED, swap.id);
      
      // Remove from active swaps
      this.activeSwaps.delete(swap.id);
      
      // Log event
      this.logSwapEvent(swap.id, 'EXPIRED', { expiredAt: now });
      
      // Emit event
      this.emit('swap:expired', swap);
    }
  }
  
  /**
   * Get swap statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeSwaps: this.activeSwaps.size,
      successRate: this.stats.totalSwaps > 0
        ? (this.stats.completedSwaps / this.stats.totalSwaps) * 100
        : 0
    };
  }
  
  /**
   * Shutdown
   */
  shutdown() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
  }
}

export default AtomicSwapEngine;
