/**
 * PPLNS Payout System
 * 
 * Uncle Bob's Clean Architecture: Single responsibility, testable
 * Pike's Simplicity: Direct PPLNS calculation, no complex schemes
 * Carmack's Performance: Efficient batch processing
 */

import { Share, Miner, Block, Payout } from './entities';
import { ShareRepository, MinerRepository } from './database';

export interface PayoutConfig {
  poolFeePercent: number;
  blockReward: number;
  pplnsWindow: number; // Number of shares to consider
  minimumPayout: number;
  transactionFee: number;
}

export interface PayoutCalculation {
  blockHeight: number;
  totalReward: number;
  poolFee: number;
  minerReward: number;
  payouts: Payout[];
  shareCount: number;
  totalDifficulty: number;
}

export interface MinerStats {
  minerId: string;
  address: string;
  shareCount: number;
  totalDifficulty: number;
  estimatedReward: number;
  percentage: number;
}

/**
 * Pike's simplicity: Pure PPLNS calculation
 */
export class PPLNSCalculator {
  constructor(private config: PayoutConfig) {}

  /**
   * Uncle Bob's testable design: Pure function for calculation
   */
  calculatePayouts(
    block: Block,
    recentShares: Share[],
    miners: Map<string, Miner>
  ): PayoutCalculation {
    // Take only the last N shares
    const pplnsShares = recentShares
      .filter(share => share.isValid)
      .slice(0, this.config.pplnsWindow);

    if (pplnsShares.length === 0) {
      return this.createEmptyPayout(block);
    }

    // Group shares by miner and calculate total difficulty
    const minerShares = new Map<string, { shares: Share[]; totalDifficulty: number }>();
    let totalDifficulty = 0;

    for (const share of pplnsShares) {
      const existing = minerShares.get(share.minerId) || { shares: [], totalDifficulty: 0 };
      existing.shares.push(share);
      existing.totalDifficulty += share.difficulty;
      minerShares.set(share.minerId, existing);
      totalDifficulty += share.difficulty;
    }

    // Calculate pool fee and miner reward
    const poolFee = block.reward * (this.config.poolFeePercent / 100);
    const minerReward = block.reward - poolFee;

    // Calculate individual payouts
    const payouts: Payout[] = [];
    
    for (const [minerId, data] of minerShares) {
      const miner = miners.get(minerId);
      if (!miner) continue;

      const percentage = data.totalDifficulty / totalDifficulty;
      const amount = minerReward * percentage;

      // Only include if above minimum payout
      if (amount >= this.config.minimumPayout) {
        payouts.push({
          minerId: miner.id,
          amount: Math.floor(amount * 100000000) / 100000000, // 8 decimal precision
          blockHeight: block.height,
          timestamp: Date.now()
        });
      }
    }

    return {
      blockHeight: block.height,
      totalReward: block.reward,
      poolFee,
      minerReward,
      payouts,
      shareCount: pplnsShares.length,
      totalDifficulty
    };
  }

  /**
   * Calculate statistics for miners
   */
  calculateMinerStats(
    recentShares: Share[],
    miners: Map<string, Miner>
  ): MinerStats[] {
    const pplnsShares = recentShares
      .filter(share => share.isValid)
      .slice(0, this.config.pplnsWindow);

    const minerStats = new Map<string, { shareCount: number; totalDifficulty: number }>();
    let totalDifficulty = 0;

    for (const share of pplnsShares) {
      const existing = minerStats.get(share.minerId) || { shareCount: 0, totalDifficulty: 0 };
      existing.shareCount++;
      existing.totalDifficulty += share.difficulty;
      minerStats.set(share.minerId, existing);
      totalDifficulty += share.difficulty;
    }

    const stats: MinerStats[] = [];
    const estimatedBlockReward = this.config.blockReward * (1 - this.config.poolFeePercent / 100);

    for (const [minerId, data] of minerStats) {
      const miner = miners.get(minerId);
      if (!miner) continue;

      const percentage = totalDifficulty > 0 ? data.totalDifficulty / totalDifficulty : 0;
      const estimatedReward = estimatedBlockReward * percentage;

      stats.push({
        minerId: miner.id,
        address: miner.address,
        shareCount: data.shareCount,
        totalDifficulty: data.totalDifficulty,
        estimatedReward,
        percentage: percentage * 100
      });
    }

    return stats.sort((a, b) => b.totalDifficulty - a.totalDifficulty);
  }

  private createEmptyPayout(block: Block): PayoutCalculation {
    const poolFee = block.reward * (this.config.poolFeePercent / 100);
    
    return {
      blockHeight: block.height,
      totalReward: block.reward,
      poolFee,
      minerReward: block.reward - poolFee,
      payouts: [],
      shareCount: 0,
      totalDifficulty: 0
    };
  }
}

/**
 * Carmack's performance: Efficient payout processing
 */
export class PayoutProcessor {
  private calculator: PPLNSCalculator;
  private pendingPayouts = new Map<string, number>(); // miner -> amount

  constructor(
    private config: PayoutConfig,
    private shareRepo: ShareRepository,
    private minerRepo: MinerRepository
  ) {
    this.calculator = new PPLNSCalculator(config);
  }

  /**
   * Process payout for a found block
   */
  async processBlockPayout(block: Block): Promise<PayoutCalculation> {
    // Get recent shares for PPLNS calculation
    const recentShares = await this.shareRepo.getRecentShares(60); // Last 60 minutes
    
    // Get miner information
    const activeMiners = await this.minerRepo.getActive(120); // Last 2 hours
    const minerMap = new Map(activeMiners.map(m => [m.id, m]));

    // Calculate payouts
    const calculation = this.calculator.calculatePayouts(block, recentShares, minerMap);

    // Add to pending payouts
    for (const payout of calculation.payouts) {
      const existing = this.pendingPayouts.get(payout.minerId) || 0;
      this.pendingPayouts.set(payout.minerId, existing + payout.amount);
    }

    return calculation;
  }

  /**
   * Process pending payouts (called periodically)
   */
  async processPendingPayouts(): Promise<{
    processed: Payout[];
    remaining: Map<string, number>;
  }> {
    const processed: Payout[] = [];
    const remaining = new Map<string, number>();

    for (const [minerId, amount] of this.pendingPayouts) {
      if (amount >= this.config.minimumPayout) {
        // Process payout
        const payout: Payout = {
          minerId,
          amount: amount - this.config.transactionFee,
          blockHeight: 0, // Will be set when actually sent
          timestamp: Date.now()
        };

        processed.push(payout);
        
        // Remove from pending
        this.pendingPayouts.delete(minerId);
      } else {
        // Keep in pending
        remaining.set(minerId, amount);
      }
    }

    this.pendingPayouts = remaining;
    return { processed, remaining };
  }

  /**
   * Get current statistics
   */
  async getCurrentStats(): Promise<{
    miners: MinerStats[];
    pendingPayouts: Map<string, number>;
    totalPending: number;
  }> {
    const recentShares = await this.shareRepo.getRecentShares(60);
    const activeMiners = await this.minerRepo.getActive(120);
    const minerMap = new Map(activeMiners.map(m => [m.id, m]));

    const miners = this.calculator.calculateMinerStats(recentShares, minerMap);
    const totalPending = Array.from(this.pendingPayouts.values())
      .reduce((sum, amount) => sum + amount, 0);

    return {
      miners,
      pendingPayouts: new Map(this.pendingPayouts),
      totalPending
    };
  }

  /**
   * Get payout statistics for a specific miner
   */
  async getMinerPayoutInfo(minerId: string): Promise<{
    currentPosition: MinerStats | null;
    pendingAmount: number;
    estimatedTime: string;
  }> {
    const stats = await this.getCurrentStats();
    const minerStats = stats.miners.find(m => m.minerId === minerId);
    const pendingAmount = this.pendingPayouts.get(minerId) || 0;

    let estimatedTime = 'Unknown';
    if (minerStats && minerStats.percentage > 0) {
      // Rough estimate based on current share rate
      const remainingAmount = this.config.minimumPayout - pendingAmount;
      if (remainingAmount > 0) {
        const estimatedBlocks = remainingAmount / minerStats.estimatedReward;
        const estimatedMinutes = estimatedBlocks * 10; // Assume 10 min blocks
        estimatedTime = `${Math.ceil(estimatedMinutes)} minutes`;
      } else {
        estimatedTime = 'Next payout batch';
      }
    }

    return {
      currentPosition: minerStats || null,
      pendingAmount,
      estimatedTime
    };
  }

  /**
   * Uncle Bob's testability: Get configuration
   */
  getConfig(): PayoutConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<PayoutConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.calculator = new PPLNSCalculator(this.config);
  }
}

/**
 * Pike's simplicity: Factory function
 */
export function createPayoutProcessor(
  config: PayoutConfig,
  shareRepo: ShareRepository,
  minerRepo: MinerRepository
): PayoutProcessor {
  return new PayoutProcessor(config, shareRepo, minerRepo);
}

export default PayoutProcessor;