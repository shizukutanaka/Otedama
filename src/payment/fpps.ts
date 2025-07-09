/**
 * FPPS (Full Pay Per Share) Implementation
 * Following Carmack/Martin/Pike principles:
 * - PPS + Transaction fee rewards
 * - Fair distribution of all rewards
 * - Comprehensive accounting
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

interface FPPSConfig {
  // Reward calculation
  reward: {
    includeTransactionFees: boolean;
    includeMEV?: boolean; // Maximal Extractable Value
    baseRate?: number; // Base PPS rate
    feeSharePercentage: number; // Percentage of tx fees to share
  };
  
  // Pool fee
  fee: {
    percentage: number;
    transactionFeePercentage?: number; // Different fee for tx rewards
  };
  
  // MEV settings (if applicable)
  mev?: {
    enabled: boolean;
    sharePercentage: number; // How much MEV to share
    minThreshold: number; // Minimum MEV to distribute
  };
  
  // Risk management
  risk: {
    reservePercentage: number; // Reserve fund percentage
    maxExposure: number;
    rebalanceInterval: number;
  };
  
  // Payment settings
  payment: {
    threshold: number;
    interval: number;
    maxBatchSize: number;
  };
  
  // Database
  database: {
    type: 'memory' | 'redis' | 'postgresql';
    connectionString?: string;
  };
}

interface FPPSShare {
  id: string;
  minerId: string;
  workerName?: string;
  difficulty: number;
  timestamp: Date;
  blockHeight: number;
  
  // Value breakdown
  baseValue: number; // PPS component
  feeValue: number; // Transaction fee component
  mevValue?: number; // MEV component
  totalValue: number;
  
  // Payment status
  paid: boolean;
  paymentId?: string;
}

interface BlockReward {
  height: number;
  hash: string;
  timestamp: Date;
  
  // Reward breakdown
  coinbaseReward: number;
  transactionFees: number;
  mevReward?: number;
  totalReward: number;
  
  // Distribution
  distributed: boolean;
  shareCount: number;
}

interface FPPSMinerAccount {
  minerId: string;
  
  // Balances
  balance: {
    base: number; // From block rewards
    fees: number; // From transaction fees
    mev: number; // From MEV
    total: number;
  };
  
  pending: {
    base: number;
    fees: number;
    mev: number;
    total: number;
  };
  
  // Statistics
  totalPaid: number;
  totalShares: number;
  totalDifficulty: number;
  averageHashrate: number;
  
  // Timestamps
  firstShare?: Date;
  lastShare?: Date;
  lastPayment?: Date;
  
  // Payment info
  paymentAddress?: string;
  minimumPayout?: number;
}

interface RewardDistribution {
  blockHeight: number;
  totalShares: number;
  totalDifficulty: number;
  
  // Per-share values
  baseRate: number;
  feeRate: number;
  mevRate: number;
  
  // Miner distributions
  minerDistributions: Map<string, MinerDistribution>;
}

interface MinerDistribution {
  minerId: string;
  shares: number;
  difficulty: number;
  percentage: number;
  
  // Rewards
  baseReward: number;
  feeReward: number;
  mevReward: number;
  totalReward: number;
}

interface ReservePool {
  balance: number;
  deposits: number;
  withdrawals: number;
  lastRebalance: Date;
}

export class FPPSPaymentSystem extends EventEmitter {
  private config: FPPSConfig;
  private shares: Map<string, FPPSShare> = new Map();
  private minerAccounts: Map<string, FPPSMinerAccount> = new Map();
  private blockRewards: Map<number, BlockReward> = new Map();
  private pendingDistributions: Map<number, RewardDistribution> = new Map();
  
  // Rate management
  private currentRates = {
    base: 0,
    fee: 0,
    mev: 0
  };
  
  // Reserve pool for variance
  private reservePool: ReservePool = {
    balance: 0,
    deposits: 0,
    withdrawals: 0,
    lastRebalance: new Date()
  };
  
  // Timers
  private paymentTimer?: NodeJS.Timer;
  private rebalanceTimer?: NodeJS.Timer;

  constructor(config: FPPSConfig) {
    super();
    this.config = config;
    
    // Initialize base rate
    this.currentRates.base = config.reward.baseRate || this.calculateBaseRate();
  }

  /**
   * Initialize FPPS system
   */
  async initialize(): Promise<void> {
    logger.info('Initializing FPPS payment system', {
      includeTransactionFees: this.config.reward.includeTransactionFees,
      includeMEV: this.config.mev?.enabled,
      feeSharePercentage: this.config.reward.feeSharePercentage
    });

    // Load existing data
    if (this.config.database.type !== 'memory') {
      await this.loadFromDatabase();
    }

    // Start timers
    this.startPaymentTimer();
    this.startRebalanceTimer();

    // Calculate initial rates
    await this.updateRates();

    this.emit('initialized');
  }

  /**
   * Submit share with FPPS calculation
   */
  async submitShare(share: {
    minerId: string;
    workerName?: string;
    difficulty: number;
    blockHeight: number;
  }): Promise<FPPSShare> {
    // Calculate share values
    const baseValue = this.calculateBaseValue(share.difficulty);
    const feeValue = this.calculateFeeValue(share.difficulty);
    const mevValue = this.calculateMEVValue(share.difficulty);
    
    const fppsShare: FPPSShare = {
      id: `${share.blockHeight}-${share.minerId}-${Date.now()}`,
      minerId: share.minerId,
      workerName: share.workerName,
      difficulty: share.difficulty,
      timestamp: new Date(),
      blockHeight: share.blockHeight,
      baseValue,
      feeValue,
      mevValue,
      totalValue: baseValue + feeValue + mevValue,
      paid: false
    };

    // Store share
    this.shares.set(fppsShare.id, fppsShare);

    // Update miner account
    this.updateMinerAccount(fppsShare);

    // Check reserve pool health
    this.checkReserveHealth();

    this.emit('share:submitted', fppsShare);

    // Persist if needed
    if (this.config.database.type !== 'memory') {
      await this.persistShare(fppsShare);
    }

    return fppsShare;
  }

  /**
   * Record block found with full reward details
   */
  async recordBlockFound(block: {
    height: number;
    hash: string;
    coinbaseReward: number;
    transactionFees: number;
    mevReward?: number;
  }): Promise<void> {
    const blockReward: BlockReward = {
      height: block.height,
      hash: block.hash,
      timestamp: new Date(),
      coinbaseReward: block.coinbaseReward,
      transactionFees: block.transactionFees,
      mevReward: block.mevReward || 0,
      totalReward: block.coinbaseReward + block.transactionFees + (block.mevReward || 0),
      distributed: false,
      shareCount: 0
    };

    this.blockRewards.set(block.height, blockReward);

    // Update rates based on actual rewards
    await this.updateRatesFromBlock(blockReward);

    // Distribute extra rewards if FPPS
    if (this.config.reward.includeTransactionFees) {
      await this.distributeExtraRewards(blockReward);
    }

    logger.info('Block recorded', {
      height: block.height,
      totalReward: blockReward.totalReward,
      fees: block.transactionFees,
      mev: block.mevReward
    });

    this.emit('block:found', blockReward);
  }

  /**
   * Calculate base PPS value
   */
  private calculateBaseValue(difficulty: number): number {
    const grossValue = difficulty * this.currentRates.base;
    const fee = grossValue * this.config.fee.percentage;
    return grossValue - fee;
  }

  /**
   * Calculate transaction fee value
   */
  private calculateFeeValue(difficulty: number): number {
    if (!this.config.reward.includeTransactionFees) return 0;
    
    const grossValue = difficulty * this.currentRates.fee;
    const fee = grossValue * (this.config.fee.transactionFeePercentage || this.config.fee.percentage);
    return grossValue - fee;
  }

  /**
   * Calculate MEV value
   */
  private calculateMEVValue(difficulty: number): number {
    if (!this.config.mev?.enabled) return 0;
    
    const grossValue = difficulty * this.currentRates.mev;
    const fee = grossValue * this.config.fee.percentage;
    return grossValue - fee;
  }

  /**
   * Update miner account with FPPS values
   */
  private updateMinerAccount(share: FPPSShare): void {
    let account = this.minerAccounts.get(share.minerId);
    
    if (!account) {
      account = {
        minerId: share.minerId,
        balance: { base: 0, fees: 0, mev: 0, total: 0 },
        pending: { base: 0, fees: 0, mev: 0, total: 0 },
        totalPaid: 0,
        totalShares: 0,
        totalDifficulty: 0,
        averageHashrate: 0,
        firstShare: share.timestamp
      };
      this.minerAccounts.set(share.minerId, account);
    }

    // Update pending balances
    account.pending.base += share.baseValue;
    account.pending.fees += share.feeValue;
    account.pending.mev += share.mevValue || 0;
    account.pending.total = account.pending.base + account.pending.fees + account.pending.mev;

    // Update statistics
    account.totalShares++;
    account.totalDifficulty += share.difficulty;
    account.lastShare = share.timestamp;

    // Update average hashrate (30 minute window)
    const recentShares = Array.from(this.shares.values()).filter(
      s => s.minerId === share.minerId &&
           s.timestamp.getTime() > Date.now() - 1800000
    );
    
    const totalDifficulty = recentShares.reduce((sum, s) => sum + s.difficulty, 0);
    account.averageHashrate = (totalDifficulty * Math.pow(2, 32)) / 1800; // H/s
  }

  /**
   * Calculate base rate
   */
  private calculateBaseRate(): number {
    // Standard PPS calculation
    const networkDifficulty = 50000000000000; // Example
    const blockReward = 6.25; // BTC
    const expectedSharesPerBlock = networkDifficulty / Math.pow(2, 32);
    
    return blockReward / expectedSharesPerBlock * (1 - this.config.risk.reservePercentage);
  }

  /**
   * Update rates based on recent blocks
   */
  private async updateRates(): Promise<void> {
    const recentBlocks = Array.from(this.blockRewards.values())
      .filter(b => b.timestamp.getTime() > Date.now() - 86400000) // Last 24 hours
      .sort((a, b) => b.height - a.height)
      .slice(0, 100); // Last 100 blocks

    if (recentBlocks.length === 0) return;

    // Calculate average fees and MEV
    const avgTransactionFees = recentBlocks.reduce((sum, b) => sum + b.transactionFees, 0) / recentBlocks.length;
    const avgMEV = recentBlocks.reduce((sum, b) => sum + (b.mevReward || 0), 0) / recentBlocks.length;
    
    // Calculate expected shares per block
    const networkDifficulty = 50000000000000; // Would get from network
    const expectedSharesPerBlock = networkDifficulty / Math.pow(2, 32);
    
    // Update fee rate
    if (this.config.reward.includeTransactionFees) {
      const feeShare = avgTransactionFees * this.config.reward.feeSharePercentage;
      this.currentRates.fee = feeShare / expectedSharesPerBlock;
    }

    // Update MEV rate
    if (this.config.mev?.enabled && avgMEV > this.config.mev.minThreshold) {
      const mevShare = avgMEV * this.config.mev.sharePercentage;
      this.currentRates.mev = mevShare / expectedSharesPerBlock;
    }

    logger.info('Updated FPPS rates', {
      base: this.currentRates.base,
      fee: this.currentRates.fee,
      mev: this.currentRates.mev
    });

    this.emit('rates:updated', this.currentRates);
  }

  /**
   * Update rates from specific block
   */
  private async updateRatesFromBlock(block: BlockReward): Promise<void> {
    // Add to reserve pool
    const reserveAmount = block.totalReward * this.config.risk.reservePercentage;
    this.reservePool.balance += reserveAmount;
    this.reservePool.deposits += reserveAmount;

    // Trigger rate update
    await this.updateRates();
  }

  /**
   * Distribute extra rewards retrospectively
   */
  private async distributeExtraRewards(block: BlockReward): Promise<void> {
    // Get shares for this block's window
    const windowStart = new Date(block.timestamp.getTime() - 600000); // 10 minutes before
    const windowEnd = block.timestamp;
    
    const relevantShares = Array.from(this.shares.values()).filter(
      share => share.timestamp >= windowStart && 
               share.timestamp <= windowEnd &&
               !share.paid
    );

    if (relevantShares.length === 0) return;

    // Calculate total difficulty
    const totalDifficulty = relevantShares.reduce((sum, s) => sum + s.difficulty, 0);
    
    // Calculate extra rewards to distribute
    const extraFees = block.transactionFees * this.config.reward.feeSharePercentage;
    const extraMEV = (block.mevReward || 0) * (this.config.mev?.sharePercentage || 0);
    const totalExtra = extraFees + extraMEV;

    // Create distribution record
    const distribution: RewardDistribution = {
      blockHeight: block.height,
      totalShares: relevantShares.length,
      totalDifficulty,
      baseRate: 0, // Already paid via PPS
      feeRate: extraFees / totalDifficulty,
      mevRate: extraMEV / totalDifficulty,
      minerDistributions: new Map()
    };

    // Calculate per-miner distributions
    const minerShares = this.groupSharesByMiner(relevantShares);
    
    for (const [minerId, shares] of minerShares) {
      const minerDifficulty = shares.reduce((sum, s) => sum + s.difficulty, 0);
      const percentage = minerDifficulty / totalDifficulty;
      
      const minerDist: MinerDistribution = {
        minerId,
        shares: shares.length,
        difficulty: minerDifficulty,
        percentage,
        baseReward: 0,
        feeReward: extraFees * percentage,
        mevReward: extraMEV * percentage,
        totalReward: (extraFees + extraMEV) * percentage
      };

      distribution.minerDistributions.set(minerId, minerDist);

      // Update miner account
      const account = this.minerAccounts.get(minerId);
      if (account) {
        account.pending.fees += minerDist.feeReward;
        account.pending.mev += minerDist.mevReward;
        account.pending.total = account.pending.base + account.pending.fees + account.pending.mev;
      }
    }

    this.pendingDistributions.set(block.height, distribution);
    block.distributed = true;
    block.shareCount = relevantShares.length;

    logger.info('Distributed extra rewards', {
      blockHeight: block.height,
      totalExtra,
      miners: distribution.minerDistributions.size
    });

    this.emit('rewards:distributed', distribution);
  }

  /**
   * Group shares by miner
   */
  private groupSharesByMiner(shares: FPPSShare[]): Map<string, FPPSShare[]> {
    const grouped = new Map<string, FPPSShare[]>();
    
    for (const share of shares) {
      const minerShares = grouped.get(share.minerId) || [];
      minerShares.push(share);
      grouped.set(share.minerId, minerShares);
    }
    
    return grouped;
  }

  /**
   * Process pending payments
   */
  private async processPendingPayments(): Promise<void> {
    const eligibleMiners = Array.from(this.minerAccounts.values()).filter(
      account => account.pending.total >= this.config.payment.threshold &&
                 account.paymentAddress
    );

    if (eligibleMiners.length === 0) return;

    logger.info('Processing FPPS payments', { miners: eligibleMiners.length });

    // Process in batches
    const batches = this.createPaymentBatches(eligibleMiners);
    
    for (const batch of batches) {
      try {
        await this.processPaymentBatch(batch);
      } catch (err) {
        logger.error('Payment batch failed', { error: err });
      }
    }
  }

  /**
   * Create payment batches
   */
  private createPaymentBatches(miners: FPPSMinerAccount[]): FPPSMinerAccount[][] {
    const batches: FPPSMinerAccount[][] = [];
    
    for (let i = 0; i < miners.length; i += this.config.payment.maxBatchSize) {
      batches.push(miners.slice(i, i + this.config.payment.maxBatchSize));
    }
    
    return batches;
  }

  /**
   * Process payment batch
   */
  private async processPaymentBatch(miners: FPPSMinerAccount[]): Promise<void> {
    const payments = miners.map(miner => ({
      minerId: miner.minerId,
      address: miner.paymentAddress!,
      amount: miner.pending.total,
      breakdown: {
        base: miner.pending.base,
        fees: miner.pending.fees,
        mev: miner.pending.mev
      }
    }));

    // Execute payment
    const txId = await this.executePayments(payments);

    // Update accounts
    for (const miner of miners) {
      // Move pending to balance
      miner.balance.base += miner.pending.base;
      miner.balance.fees += miner.pending.fees;
      miner.balance.mev += miner.pending.mev;
      miner.balance.total = miner.balance.base + miner.balance.fees + miner.balance.mev;

      // Update paid amount
      miner.totalPaid += miner.pending.total;
      miner.lastPayment = new Date();

      // Clear pending
      miner.pending = { base: 0, fees: 0, mev: 0, total: 0 };

      // Mark shares as paid
      this.markSharesPaid(miner.minerId, txId);
    }

    this.emit('payment:completed', {
      txId,
      miners: payments.length,
      total: payments.reduce((sum, p) => sum + p.amount, 0)
    });
  }

  /**
   * Execute payments (placeholder)
   */
  private async executePayments(payments: any[]): Promise<string> {
    // This would integrate with actual payment system
    return `tx-fpps-${Date.now()}`;
  }

  /**
   * Mark shares as paid
   */
  private markSharesPaid(minerId: string, paymentId: string): void {
    for (const share of this.shares.values()) {
      if (share.minerId === minerId && !share.paid) {
        share.paid = true;
        share.paymentId = paymentId;
      }
    }
  }

  /**
   * Check reserve pool health
   */
  private checkReserveHealth(): void {
    const totalPending = Array.from(this.minerAccounts.values())
      .reduce((sum, account) => sum + account.pending.total, 0);
    
    const reserveRatio = this.reservePool.balance / totalPending;
    
    if (reserveRatio < 0.5) {
      this.emit('reserve:low', {
        balance: this.reservePool.balance,
        pending: totalPending,
        ratio: reserveRatio
      });
    }
  }

  /**
   * Rebalance reserve pool
   */
  private async rebalanceReserve(): Promise<void> {
    const metrics = this.calculateMetrics();
    
    // Adjust rates if reserve is unhealthy
    if (metrics.reserveHealth < 0.5) {
      // Reduce rates slightly
      this.currentRates.base *= 0.99;
      this.currentRates.fee *= 0.98;
      this.currentRates.mev *= 0.98;
      
      logger.warn('Reduced rates due to low reserve', {
        reserveHealth: metrics.reserveHealth
      });
    } else if (metrics.reserveHealth > 2.0) {
      // Can increase rates slightly
      this.currentRates.base *= 1.01;
      this.currentRates.fee *= 1.01;
      this.currentRates.mev *= 1.01;
      
      logger.info('Increased rates due to healthy reserve', {
        reserveHealth: metrics.reserveHealth
      });
    }

    this.reservePool.lastRebalance = new Date();
  }

  /**
   * Calculate system metrics
   */
  private calculateMetrics(): any {
    const totalPending = Array.from(this.minerAccounts.values())
      .reduce((sum, account) => sum + account.pending.total, 0);
    
    const totalPaid = Array.from(this.minerAccounts.values())
      .reduce((sum, account) => sum + account.totalPaid, 0);
    
    const totalBlockRewards = Array.from(this.blockRewards.values())
      .reduce((sum, block) => sum + block.totalReward, 0);

    return {
      reserveHealth: this.reservePool.balance / (totalPending || 1),
      profitMargin: totalBlockRewards > 0 ? (totalBlockRewards - totalPaid) / totalBlockRewards : 0,
      pendingPayouts: totalPending,
      reserveBalance: this.reservePool.balance
    };
  }

  /**
   * Start payment timer
   */
  private startPaymentTimer(): void {
    this.paymentTimer = setInterval(() => {
      this.processPendingPayments();
    }, this.config.payment.interval * 1000);
  }

  /**
   * Start rebalance timer
   */
  private startRebalanceTimer(): void {
    this.rebalanceTimer = setInterval(() => {
      this.rebalanceReserve();
    }, this.config.risk.rebalanceInterval * 1000);
  }

  /**
   * Load from database
   */
  private async loadFromDatabase(): Promise<void> {
    // TODO: Implement database loading
    logger.info('Loading FPPS data from database');
  }

  /**
   * Persist share
   */
  private async persistShare(share: FPPSShare): Promise<void> {
    // TODO: Implement database persistence
  }

  /**
   * Set payment address
   */
  setPaymentAddress(minerId: string, address: string, minimumPayout?: number): void {
    const account = this.minerAccounts.get(minerId);
    if (account) {
      account.paymentAddress = address;
      if (minimumPayout !== undefined) {
        account.minimumPayout = minimumPayout;
      }
      this.emit('address:set', { minerId, address });
    }
  }

  /**
   * Get miner account
   */
  getMinerAccount(minerId: string): FPPSMinerAccount | undefined {
    return this.minerAccounts.get(minerId);
  }

  /**
   * Get current rates
   */
  getCurrentRates(): typeof this.currentRates {
    return { ...this.currentRates };
  }

  /**
   * Get statistics
   */
  getStatistics(): any {
    const metrics = this.calculateMetrics();
    const activeMiners = Array.from(this.minerAccounts.values()).filter(
      m => m.lastShare && Date.now() - m.lastShare.getTime() < 600000
    ).length;

    return {
      system: {
        rates: this.currentRates,
        includesFees: this.config.reward.includeTransactionFees,
        includesMEV: this.config.mev?.enabled,
        poolFee: this.config.fee.percentage
      },
      miners: {
        total: this.minerAccounts.size,
        active: activeMiners,
        withBalance: Array.from(this.minerAccounts.values()).filter(
          m => m.pending.total > 0
        ).length
      },
      shares: {
        total: this.shares.size,
        unpaid: Array.from(this.shares.values()).filter(s => !s.paid).length
      },
      blocks: {
        total: this.blockRewards.size,
        distributed: Array.from(this.blockRewards.values()).filter(b => b.distributed).length,
        avgFees: Array.from(this.blockRewards.values())
          .reduce((sum, b) => sum + b.transactionFees, 0) / (this.blockRewards.size || 1),
        avgMEV: Array.from(this.blockRewards.values())
          .reduce((sum, b) => sum + (b.mevReward || 0), 0) / (this.blockRewards.size || 1)
      },
      reserve: {
        balance: this.reservePool.balance,
        deposits: this.reservePool.deposits,
        withdrawals: this.reservePool.withdrawals,
        health: metrics.reserveHealth
      }
    };
  }

  /**
   * Shutdown
   */
  async shutdown(): Promise<void> {
    if (this.paymentTimer) {
      clearInterval(this.paymentTimer);
    }
    
    if (this.rebalanceTimer) {
      clearInterval(this.rebalanceTimer);
    }

    // Process final payments
    await this.processPendingPayments();

    logger.info('FPPS system shutdown complete');
  }
}

// Export types
export { 
  FPPSConfig, 
  FPPSShare, 
  BlockReward, 
  FPPSMinerAccount, 
  RewardDistribution, 
  MinerDistribution 
};
