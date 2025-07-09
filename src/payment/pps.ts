/**
 * PPS (Pay Per Share) Implementation
 * Following Carmack/Martin/Pike principles:
 * - Immediate payment per share
 * - Risk management for pool operator
 * - Predictable miner income
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

interface PPSConfig {
  // Base reward calculation
  reward: {
    method: 'fixed' | 'dynamic' | 'market';
    baseRate?: number; // BTC per share difficulty 1
    updateInterval?: number; // For dynamic/market pricing
  };
  
  // Pool fee
  fee: {
    percentage: number; // Pool fee percentage
    minimum?: number; // Minimum fee amount
  };
  
  // Risk management
  risk: {
    buffer: number; // Buffer percentage for variance
    maxExposure: number; // Maximum risk exposure
    rebalanceThreshold: number; // When to rebalance rates
  };
  
  // Payment settings
  payment: {
    threshold: number; // Minimum payout
    interval: number; // Payment interval (seconds)
    batch: boolean; // Batch payments
  };
  
  // Database
  database: {
    type: 'memory' | 'redis' | 'postgresql';
    connectionString?: string;
  };
}

interface ShareRecord {
  id: string;
  minerId: string;
  workerName?: string;
  difficulty: number;
  timestamp: Date;
  value: number; // Share value in BTC
  paid: boolean;
  paymentId?: string;
  blockHeight: number;
}

interface MinerAccount {
  minerId: string;
  balance: number;
  pendingBalance: number;
  totalPaid: number;
  totalShares: number;
  totalDifficulty: number;
  lastShare?: Date;
  lastPayment?: Date;
  paymentAddress?: string;
}

interface PaymentBatch {
  id: string;
  timestamp: Date;
  miners: PaymentRecord[];
  totalAmount: number;
  txId?: string;
  status: 'pending' | 'processing' | 'confirmed' | 'failed';
}

interface PaymentRecord {
  minerId: string;
  amount: number;
  shares: number;
  address: string;
}

interface RiskMetrics {
  expectedValue: number;
  actualValue: number;
  variance: number;
  exposure: number;
  bufferHealth: number;
}

export class PPSPaymentSystem extends EventEmitter {
  private config: PPSConfig;
  private shareRecords: Map<string, ShareRecord> = new Map();
  private minerAccounts: Map<string, MinerAccount> = new Map();
  private paymentBatches: Map<string, PaymentBatch> = new Map();
  
  // Rate management
  private currentRate: number;
  private rateHistory: { timestamp: Date; rate: number }[] = [];
  
  // Risk tracking
  private totalUnpaidValue: number = 0;
  private totalPaidOut: number = 0;
  private blockRewards: number[] = [];
  
  // Payment processing
  private paymentTimer?: NodeJS.Timer;
  private isProcessingPayments: boolean = false;

  constructor(config: PPSConfig) {
    super();
    this.config = config;
    this.currentRate = config.reward.baseRate || this.calculateInitialRate();
  }

  /**
   * Initialize PPS system
   */
  async initialize(): Promise<void> {
    logger.info('Initializing PPS payment system', {
      rewardMethod: this.config.reward.method,
      poolFee: this.config.fee.percentage,
      paymentThreshold: this.config.payment.threshold
    });

    // Load existing data
    if (this.config.database.type !== 'memory') {
      await this.loadFromDatabase();
    }

    // Start rate updates if dynamic
    if (this.config.reward.method !== 'fixed') {
      this.startRateUpdates();
    }

    // Start payment processing
    this.startPaymentProcessing();

    // Start risk monitoring
    this.startRiskMonitoring();

    this.emit('initialized');
  }

  /**
   * Submit share and calculate immediate payment
   */
  async submitShare(share: {
    minerId: string;
    workerName?: string;
    difficulty: number;
    blockHeight: number;
  }): Promise<ShareRecord> {
    // Calculate share value
    const shareValue = this.calculateShareValue(share.difficulty);
    
    // Create share record
    const record: ShareRecord = {
      id: `${share.blockHeight}-${share.minerId}-${Date.now()}`,
      minerId: share.minerId,
      workerName: share.workerName,
      difficulty: share.difficulty,
      timestamp: new Date(),
      value: shareValue,
      paid: false,
      blockHeight: share.blockHeight
    };

    // Store share record
    this.shareRecords.set(record.id, record);

    // Update miner account
    this.updateMinerAccount(share.minerId, shareValue, share.difficulty);

    // Update risk metrics
    this.totalUnpaidValue += shareValue;

    // Check if rate adjustment needed
    if (this.shouldAdjustRate()) {
      await this.adjustRate();
    }

    this.emit('share:submitted', record);
    
    // Persist if not using memory
    if (this.config.database.type !== 'memory') {
      await this.persistShareRecord(record);
    }

    return record;
  }

  /**
   * Calculate share value based on difficulty
   */
  private calculateShareValue(difficulty: number): number {
    // Base value = difficulty * rate * (1 - pool fee)
    const grossValue = difficulty * this.currentRate;
    const feeAmount = Math.max(
      grossValue * this.config.fee.percentage,
      this.config.fee.minimum || 0
    );
    
    return grossValue - feeAmount;
  }

  /**
   * Update miner account
   */
  private updateMinerAccount(minerId: string, value: number, difficulty: number): void {
    let account = this.minerAccounts.get(minerId);
    
    if (!account) {
      account = {
        minerId,
        balance: 0,
        pendingBalance: 0,
        totalPaid: 0,
        totalShares: 0,
        totalDifficulty: 0
      };
      this.minerAccounts.set(minerId, account);
    }

    account.pendingBalance += value;
    account.totalShares++;
    account.totalDifficulty += difficulty;
    account.lastShare = new Date();
  }

  /**
   * Process pending payments
   */
  private async processPendingPayments(): Promise<void> {
    if (this.isProcessingPayments) return;
    
    this.isProcessingPayments = true;
    
    try {
      // Get miners with sufficient balance
      const eligibleMiners = Array.from(this.minerAccounts.values()).filter(
        account => account.pendingBalance >= this.config.payment.threshold &&
                   account.paymentAddress
      );

      if (eligibleMiners.length === 0) {
        return;
      }

      logger.info('Processing payments', { miners: eligibleMiners.length });

      if (this.config.payment.batch) {
        await this.processBatchPayment(eligibleMiners);
      } else {
        await this.processIndividualPayments(eligibleMiners);
      }

    } catch (err) {
      logger.error('Payment processing failed', { error: err });
      this.emit('payment:error', err);
    } finally {
      this.isProcessingPayments = false;
    }
  }

  /**
   * Process batch payment
   */
  private async processBatchPayment(miners: MinerAccount[]): Promise<void> {
    const paymentRecords: PaymentRecord[] = [];
    let totalAmount = 0;
    
    // Prepare payment records
    for (const miner of miners) {
      const amount = miner.pendingBalance;
      paymentRecords.push({
        minerId: miner.minerId,
        amount,
        shares: this.getUnpaidShareCount(miner.minerId),
        address: miner.paymentAddress!
      });
      totalAmount += amount;
    }

    // Create batch
    const batch: PaymentBatch = {
      id: `batch-${Date.now()}`,
      timestamp: new Date(),
      miners: paymentRecords,
      totalAmount,
      status: 'pending'
    };

    this.paymentBatches.set(batch.id, batch);

    // Execute payment
    try {
      batch.status = 'processing';
      const txId = await this.executePayment(batch);
      batch.txId = txId;
      batch.status = 'confirmed';

      // Update miner accounts
      for (const record of paymentRecords) {
        const miner = this.minerAccounts.get(record.minerId)!;
        miner.balance += miner.pendingBalance;
        miner.pendingBalance = 0;
        miner.totalPaid += record.amount;
        miner.lastPayment = new Date();
        
        // Mark shares as paid
        this.markSharesPaid(record.minerId, batch.id);
      }

      // Update metrics
      this.totalPaidOut += totalAmount;
      this.totalUnpaidValue -= totalAmount;

      this.emit('payment:completed', batch);
      
    } catch (err) {
      batch.status = 'failed';
      logger.error('Batch payment failed', { batchId: batch.id, error: err });
      throw err;
    }
  }

  /**
   * Process individual payments
   */
  private async processIndividualPayments(miners: MinerAccount[]): Promise<void> {
    for (const miner of miners) {
      try {
        await this.processIndividualPayment(miner);
      } catch (err) {
        logger.error('Individual payment failed', {
          minerId: miner.minerId,
          error: err
        });
      }
    }
  }

  /**
   * Process individual payment
   */
  private async processIndividualPayment(miner: MinerAccount): Promise<void> {
    const amount = miner.pendingBalance;
    const shares = this.getUnpaidShareCount(miner.minerId);
    
    const payment: PaymentRecord = {
      minerId: miner.minerId,
      amount,
      shares,
      address: miner.paymentAddress!
    };

    // Execute payment
    const txId = await this.executeIndividualPayment(payment);
    
    // Update account
    miner.balance += miner.pendingBalance;
    miner.pendingBalance = 0;
    miner.totalPaid += amount;
    miner.lastPayment = new Date();
    
    // Mark shares as paid
    this.markSharesPaid(miner.minerId, txId);
    
    // Update metrics
    this.totalPaidOut += amount;
    this.totalUnpaidValue -= amount;

    this.emit('payment:individual', {
      minerId: miner.minerId,
      amount,
      txId
    });
  }

  /**
   * Calculate initial rate
   */
  private calculateInitialRate(): number {
    // Calculate based on network difficulty and block reward
    const networkDifficulty = 50000000000000; // Example
    const blockReward = 6.25; // BTC
    const expectedSharesPerBlock = networkDifficulty / (2 ** 32);
    
    // Base rate = block reward / expected shares * (1 - buffer)
    const baseRate = blockReward / expectedSharesPerBlock;
    return baseRate * (1 - this.config.risk.buffer);
  }

  /**
   * Should adjust rate based on risk metrics
   */
  private shouldAdjustRate(): boolean {
    const metrics = this.calculateRiskMetrics();
    
    return metrics.variance > this.config.risk.rebalanceThreshold ||
           metrics.exposure > this.config.risk.maxExposure ||
           metrics.bufferHealth < 0.5;
  }

  /**
   * Adjust payment rate
   */
  private async adjustRate(): Promise<void> {
    const metrics = this.calculateRiskMetrics();
    const oldRate = this.currentRate;
    
    // Calculate adjustment factor
    let adjustmentFactor = 1.0;
    
    if (metrics.exposure > this.config.risk.maxExposure) {
      // Reduce rate if exposure too high
      adjustmentFactor = 0.95;
    } else if (metrics.bufferHealth < 0.5) {
      // Reduce rate if buffer unhealthy
      adjustmentFactor = 0.98;
    } else if (metrics.variance < -this.config.risk.rebalanceThreshold) {
      // Increase rate if we're too conservative
      adjustmentFactor = 1.02;
    }

    this.currentRate *= adjustmentFactor;
    
    // Record rate change
    this.rateHistory.push({
      timestamp: new Date(),
      rate: this.currentRate
    });

    logger.info('Adjusted PPS rate', {
      oldRate,
      newRate: this.currentRate,
      factor: adjustmentFactor,
      metrics
    });

    this.emit('rate:adjusted', {
      oldRate,
      newRate: this.currentRate,
      reason: 'risk_rebalance'
    });
  }

  /**
   * Calculate risk metrics
   */
  private calculateRiskMetrics(): RiskMetrics {
    // Calculate expected vs actual
    const expectedRewards = this.totalPaidOut / (1 - this.config.fee.percentage);
    const actualRewards = this.blockRewards.reduce((sum, r) => sum + r, 0);
    
    const variance = actualRewards > 0 
      ? (actualRewards - expectedRewards) / expectedRewards
      : 0;
    
    const exposure = this.totalUnpaidValue / (this.currentRate * 1000000); // In expected blocks
    const bufferHealth = actualRewards > expectedRewards 
      ? 1.0 
      : expectedRewards > 0 ? actualRewards / expectedRewards : 0;

    return {
      expectedValue: expectedRewards,
      actualValue: actualRewards,
      variance,
      exposure,
      bufferHealth
    };
  }

  /**
   * Record block reward
   */
  recordBlockReward(reward: number): void {
    this.blockRewards.push(reward);
    
    // Keep last 100 blocks
    if (this.blockRewards.length > 100) {
      this.blockRewards.shift();
    }

    // Check if rate adjustment needed
    if (this.shouldAdjustRate()) {
      this.adjustRate();
    }
  }

  /**
   * Get unpaid share count
   */
  private getUnpaidShareCount(minerId: string): number {
    return Array.from(this.shareRecords.values()).filter(
      share => share.minerId === minerId && !share.paid
    ).length;
  }

  /**
   * Mark shares as paid
   */
  private markSharesPaid(minerId: string, paymentId: string): void {
    for (const [id, share] of this.shareRecords) {
      if (share.minerId === minerId && !share.paid) {
        share.paid = true;
        share.paymentId = paymentId;
      }
    }
  }

  /**
   * Execute payment (placeholder)
   */
  private async executePayment(batch: PaymentBatch): Promise<string> {
    // This would integrate with actual payment system
    logger.info('Executing batch payment', {
      batchId: batch.id,
      totalAmount: batch.totalAmount,
      miners: batch.miners.length
    });
    
    // Simulate payment
    return `tx-${batch.id}`;
  }

  /**
   * Execute individual payment (placeholder)
   */
  private async executeIndividualPayment(payment: PaymentRecord): Promise<string> {
    // This would integrate with actual payment system
    logger.info('Executing individual payment', {
      minerId: payment.minerId,
      amount: payment.amount
    });
    
    // Simulate payment
    return `tx-${payment.minerId}-${Date.now()}`;
  }

  /**
   * Start rate updates
   */
  private startRateUpdates(): void {
    if (!this.config.reward.updateInterval) return;

    setInterval(async () => {
      if (this.config.reward.method === 'dynamic') {
        await this.updateDynamicRate();
      } else if (this.config.reward.method === 'market') {
        await this.updateMarketRate();
      }
    }, this.config.reward.updateInterval);
  }

  /**
   * Update dynamic rate based on pool performance
   */
  private async updateDynamicRate(): Promise<void> {
    const metrics = this.calculateRiskMetrics();
    
    // Adjust based on pool luck and risk
    if (metrics.bufferHealth > 0.8 && metrics.variance > 0.1) {
      // Good luck, can increase rate slightly
      this.currentRate *= 1.01;
    } else if (metrics.bufferHealth < 0.6) {
      // Bad luck, reduce rate
      this.currentRate *= 0.99;
    }

    this.emit('rate:updated', {
      rate: this.currentRate,
      method: 'dynamic'
    });
  }

  /**
   * Update market-based rate
   */
  private async updateMarketRate(): Promise<void> {
    // This would fetch current market conditions
    // For now, simulate with small random changes
    const change = (Math.random() - 0.5) * 0.02; // ±2%
    this.currentRate *= (1 + change);

    this.emit('rate:updated', {
      rate: this.currentRate,
      method: 'market'
    });
  }

  /**
   * Start payment processing timer
   */
  private startPaymentProcessing(): void {
    this.paymentTimer = setInterval(() => {
      this.processPendingPayments();
    }, this.config.payment.interval * 1000);
  }

  /**
   * Start risk monitoring
   */
  private startRiskMonitoring(): void {
    setInterval(() => {
      const metrics = this.calculateRiskMetrics();
      
      if (metrics.exposure > this.config.risk.maxExposure * 0.8) {
        this.emit('risk:warning', {
          type: 'high_exposure',
          metrics
        });
      }
      
      if (metrics.bufferHealth < 0.3) {
        this.emit('risk:warning', {
          type: 'low_buffer',
          metrics
        });
      }
    }, 60000); // Every minute
  }

  /**
   * Load from database
   */
  private async loadFromDatabase(): Promise<void> {
    // TODO: Implement database loading
    logger.info('Loading PPS data from database');
  }

  /**
   * Persist share record
   */
  private async persistShareRecord(record: ShareRecord): Promise<void> {
    // TODO: Implement database persistence
  }

  /**
   * Set miner payment address
   */
  setPaymentAddress(minerId: string, address: string): void {
    const account = this.minerAccounts.get(minerId);
    if (account) {
      account.paymentAddress = address;
      this.emit('address:updated', { minerId, address });
    }
  }

  /**
   * Get miner account
   */
  getMinerAccount(minerId: string): MinerAccount | undefined {
    return this.minerAccounts.get(minerId);
  }

  /**
   * Get current rate
   */
  getCurrentRate(): number {
    return this.currentRate;
  }

  /**
   * Get risk metrics
   */
  getRiskMetrics(): RiskMetrics {
    return this.calculateRiskMetrics();
  }

  /**
   * Get statistics
   */
  getStatistics(): any {
    const totalMiners = this.minerAccounts.size;
    const activeMiners = Array.from(this.minerAccounts.values()).filter(
      m => m.lastShare && Date.now() - m.lastShare.getTime() < 600000
    ).length;

    return {
      system: {
        currentRate: this.currentRate,
        rewardMethod: this.config.reward.method,
        poolFee: this.config.fee.percentage,
        paymentThreshold: this.config.payment.threshold
      },
      miners: {
        total: totalMiners,
        active: activeMiners,
        withBalance: Array.from(this.minerAccounts.values()).filter(
          m => m.pendingBalance > 0
        ).length
      },
      shares: {
        total: this.shareRecords.size,
        unpaid: Array.from(this.shareRecords.values()).filter(s => !s.paid).length
      },
      payments: {
        totalPaid: this.totalPaidOut,
        totalUnpaid: this.totalUnpaidValue,
        batches: this.paymentBatches.size
      },
      risk: this.calculateRiskMetrics()
    };
  }

  /**
   * Shutdown
   */
  async shutdown(): Promise<void> {
    if (this.paymentTimer) {
      clearInterval(this.paymentTimer);
    }

    // Process final payments
    await this.processPendingPayments();

    logger.info('PPS system shutdown complete');
  }
}

// Export types
export { PPSConfig, ShareRecord, MinerAccount, PaymentBatch, PaymentRecord, RiskMetrics };
