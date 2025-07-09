/**
 * Payment system implementation
 * Following Rob Pike's principle: clear, efficient, minimal
 */

import { EventEmitter } from 'events';
import { PoolDatabase, ShareRecord, MinerRecord, PaymentRecord } from '../database/pool-database';
import { BlockchainClient } from '../blockchain/blockchain-client';

export interface PaymentConfig {
  scheme: 'PPLNS' | 'PPS' | 'FPPS' | 'PROP';
  minPayout: number;
  payoutFee: number;
  payoutInterval: number; // seconds
  pplnsWindow?: number; // shares for PPLNS
  blockReward: number;
  poolFee: number; // percentage
}

export interface PendingPayout {
  minerId: string;
  address: string;
  amount: number;
  shares: number;
  lastShareTime: number;
}

export interface PaymentRound {
  roundId: string;
  blockHeight: number;
  blockHash: string;
  blockReward: number;
  poolFee: number;
  totalShares: number;
  totalPaid: number;
  miners: Map<string, number>; // minerId -> amount
  timestamp: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

export abstract class PaymentScheme {
  constructor(
    protected config: PaymentConfig,
    protected database: PoolDatabase
  ) {}

  abstract calculatePayouts(
    blockReward: number,
    shares: ShareRecord[]
  ): Promise<Map<string, number>>;

  abstract getName(): string;
}

// Pay Per Last N Shares
export class PPLNSScheme extends PaymentScheme {
  getName(): string {
    return 'PPLNS';
  }

  async calculatePayouts(
    blockReward: number,
    shares: ShareRecord[]
  ): Promise<Map<string, number>> {
    const payouts = new Map<string, number>();
    
    // Get shares within the PPLNS window
    const windowSize = this.config.pplnsWindow || 100000;
    const validShares = shares
      .filter(share => share.valid)
      .slice(0, windowSize);

    if (validShares.length === 0) {
      return payouts;
    }

    // Calculate total difficulty
    const totalDifficulty = validShares.reduce(
      (sum, share) => sum + share.difficulty,
      0
    );

    // Calculate pool fee
    const poolFeeAmount = blockReward * (this.config.poolFee / 100);
    const distributableReward = blockReward - poolFeeAmount;

    // Calculate payouts
    for (const share of validShares) {
      const minerShare = (share.difficulty / totalDifficulty) * distributableReward;
      const currentPayout = payouts.get(share.minerId) || 0;
      payouts.set(share.minerId, currentPayout + minerShare);
    }

    return payouts;
  }
}

// Pay Per Share
export class PPSScheme extends PaymentScheme {
  getName(): string {
    return 'PPS';
  }

  async calculatePayouts(
    blockReward: number,
    shares: ShareRecord[]
  ): Promise<Map<string, number>> {
    const payouts = new Map<string, number>();
    
    // In PPS, miners are paid immediately for each share
    // based on the expected value
    const networkDifficulty = 1; // This should come from blockchain
    const expectedShareValue = blockReward / networkDifficulty;
    
    for (const share of shares.filter(s => s.valid && !s.rewarded)) {
      const payout = expectedShareValue * share.difficulty;
      const currentPayout = payouts.get(share.minerId) || 0;
      payouts.set(share.minerId, currentPayout + payout);
    }

    return payouts;
  }
}

// Proportional
export class PropScheme extends PaymentScheme {
  getName(): string {
    return 'PROP';
  }

  async calculatePayouts(
    blockReward: number,
    shares: ShareRecord[]
  ): Promise<Map<string, number>> {
    const payouts = new Map<string, number>();
    
    // Get all shares since last block
    const validShares = shares.filter(share => share.valid && !share.rewarded);
    
    if (validShares.length === 0) {
      return payouts;
    }

    // Calculate total shares
    const totalShares = validShares.length;
    
    // Calculate pool fee
    const poolFeeAmount = blockReward * (this.config.poolFee / 100);
    const distributableReward = blockReward - poolFeeAmount;
    
    // Simple proportional: equal payment per share
    const paymentPerShare = distributableReward / totalShares;
    
    for (const share of validShares) {
      const currentPayout = payouts.get(share.minerId) || 0;
      payouts.set(share.minerId, currentPayout + paymentPerShare);
    }

    return payouts;
  }
}

export class PaymentManager extends EventEmitter {
  private scheme: PaymentScheme;
  private paymentTimer?: NodeJS.Timeout;
  private pendingPayouts = new Map<string, PendingPayout>();
  private processingPayment = false;

  constructor(
    private config: PaymentConfig,
    private database: PoolDatabase,
    private blockchainClient: BlockchainClient
  ) {
    super();
    
    // Initialize payment scheme
    switch (config.scheme) {
      case 'PPLNS':
        this.scheme = new PPLNSScheme(config, database);
        break;
      case 'PPS':
        this.scheme = new PPSScheme(config, database);
        break;
      case 'PROP':
        this.scheme = new PropScheme(config, database);
        break;
      default:
        this.scheme = new PPLNSScheme(config, database);
    }

    this.startPaymentTimer();
  }

  async processBlockReward(
    blockHeight: number,
    blockHash: string,
    blockReward: number
  ): Promise<PaymentRound> {
    const roundId = `round_${blockHeight}_${Date.now()}`;
    
    this.emit('paymentRoundStarted', { roundId, blockHeight });

    try {
      // Get shares for payment calculation
      const shares = await this.getSharesForPayment();
      
      // Calculate payouts
      const payouts = await this.scheme.calculatePayouts(blockReward, shares);
      
      // Create payment round
      const round: PaymentRound = {
        roundId,
        blockHeight,
        blockHash,
        blockReward,
        poolFee: this.config.poolFee,
        totalShares: shares.length,
        totalPaid: Array.from(payouts.values()).reduce((sum, amount) => sum + amount, 0),
        miners: payouts,
        timestamp: Date.now(),
        status: 'pending'
      };

      // Update miner balances
      await this.updateMinerBalances(payouts);
      
      // Mark shares as rewarded
      await this.markSharesAsRewarded(shares);

      this.emit('paymentRoundCompleted', round);
      
      return round;
    } catch (error) {
      this.emit('paymentRoundFailed', { roundId, error });
      throw error;
    }
  }

  private async getSharesForPayment(): Promise<ShareRecord[]> {
    if (this.config.scheme === 'PPLNS' && this.config.pplnsWindow) {
      // Get shares within PPLNS window
      const windowTime = Date.now() - (this.config.pplnsWindow * 10 * 1000); // Assume 10s per share
      return this.database.getSharesForPPLNS(windowTime);
    } else {
      // Get all unpaid shares
      return this.database.getSharesForPPLNS(0);
    }
  }

  private async updateMinerBalances(payouts: Map<string, number>): Promise<void> {
    for (const [minerId, amount] of payouts) {
      const miner = await this.database.getMiner(minerId);
      if (miner) {
        miner.balance += amount;
        await this.database.upsertMiner(miner);
        
        // Add to pending payouts
        this.addPendingPayout(minerId, miner.address, amount);
      }
    }
  }

  private async markSharesAsRewarded(shares: ShareRecord[]): Promise<void> {
    // In production, this would be done in a transaction
    for (const share of shares) {
      share.rewarded = true;
      // await this.database.updateShare(share);
    }
  }

  private addPendingPayout(minerId: string, address: string, amount: number): void {
    const existing = this.pendingPayouts.get(minerId);
    
    if (existing) {
      existing.amount += amount;
      existing.lastShareTime = Date.now();
    } else {
      this.pendingPayouts.set(minerId, {
        minerId,
        address,
        amount,
        shares: 0,
        lastShareTime: Date.now()
      });
    }
  }

  async processPendingPayouts(): Promise<void> {
    if (this.processingPayment) return;
    this.processingPayment = true;

    try {
      const payoutBatch: Array<{ address: string; amount: number }> = [];
      const processedMinerIds: string[] = [];

      // Collect payouts that meet minimum threshold
      for (const [minerId, payout] of this.pendingPayouts) {
        if (payout.amount >= this.config.minPayout) {
          const netAmount = payout.amount - this.config.payoutFee;
          if (netAmount > 0) {
            payoutBatch.push({
              address: payout.address,
              amount: netAmount
            });
            processedMinerIds.push(minerId);
          }
        }
      }

      if (payoutBatch.length === 0) {
        return;
      }

      this.emit('payoutBatchStarted', { count: payoutBatch.length });

      // Create payment records
      const paymentIds: number[] = [];
      for (let i = 0; i < payoutBatch.length; i++) {
        const payment: PaymentRecord = {
          minerId: processedMinerIds[i],
          amount: payoutBatch[i].amount,
          status: 'pending',
          createdAt: Date.now()
        };
        
        const paymentId = await this.database.createPayment(payment);
        paymentIds.push(paymentId);
      }

      // Process actual blockchain transactions
      // This is where you would call the blockchain client to send transactions
      // For now, we'll simulate it
      
      for (let i = 0; i < payoutBatch.length; i++) {
        try {
          // const txHash = await this.blockchainClient.sendTransaction(
          //   payoutBatch[i].address,
          //   payoutBatch[i].amount
          // );
          
          const txHash = 'simulated_tx_' + Math.random().toString(36);
          
          // Update payment record
          await this.database.updatePayment(paymentIds[i], {
            txHash,
            status: 'completed',
            processedAt: Date.now()
          });

          // Update miner balance
          const miner = await this.database.getMiner(processedMinerIds[i]);
          if (miner) {
            miner.balance -= payoutBatch[i].amount + this.config.payoutFee;
            miner.paidAmount += payoutBatch[i].amount;
            await this.database.upsertMiner(miner);
          }

          // Remove from pending
          this.pendingPayouts.delete(processedMinerIds[i]);

          this.emit('payoutCompleted', {
            minerId: processedMinerIds[i],
            amount: payoutBatch[i].amount,
            txHash
          });
        } catch (error) {
          // Update payment record with error
          await this.database.updatePayment(paymentIds[i], {
            status: 'failed',
            error: error instanceof Error ? error.message : 'Unknown error'
          });

          this.emit('payoutFailed', {
            minerId: processedMinerIds[i],
            amount: payoutBatch[i].amount,
            error
          });
        }
      }

      this.emit('payoutBatchCompleted', { 
        processed: payoutBatch.length,
        totalAmount: payoutBatch.reduce((sum, p) => sum + p.amount, 0)
      });
    } finally {
      this.processingPayment = false;
    }
  }

  private startPaymentTimer(): void {
    if (this.config.scheme === 'PPS') {
      // PPS requires more frequent payouts
      this.paymentTimer = setInterval(() => {
        this.processPendingPayouts();
      }, Math.min(this.config.payoutInterval * 1000, 300000)); // Max 5 minutes
    } else {
      // Other schemes can have longer intervals
      this.paymentTimer = setInterval(() => {
        this.processPendingPayouts();
      }, this.config.payoutInterval * 1000);
    }
  }

  getMinerBalance(minerId: string): number {
    const pending = this.pendingPayouts.get(minerId);
    return pending ? pending.amount : 0;
  }

  getPaymentStats() {
    const pendingPayouts = Array.from(this.pendingPayouts.values());
    
    return {
      scheme: this.scheme.getName(),
      pendingPayouts: pendingPayouts.length,
      pendingAmount: pendingPayouts.reduce((sum, p) => sum + p.amount, 0),
      minPayout: this.config.minPayout,
      payoutFee: this.config.payoutFee,
      poolFee: this.config.poolFee
    };
  }

  stop(): void {
    if (this.paymentTimer) {
      clearInterval(this.paymentTimer);
      this.paymentTimer = undefined;
    }
  }
}
