/**
 * PPLNS (Pay Per Last N Shares) Implementation
 * Following Carmack/Martin/Pike principles:
 * - Fair share distribution
 * - Efficient share tracking
 * - Protection against pool hopping
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

interface PPLNSConfig {
  // N value - number of shares to consider
  n: number | 'dynamic';
  
  // Time window (if using time-based N)
  timeWindow?: number; // seconds
  
  // Share scoring
  scoring: {
    method: 'linear' | 'exponential' | 'score';
    decay?: number; // For exponential scoring
  };
  
  // Pool hopping protection
  protection: {
    enabled: boolean;
    minTime: number; // Minimum time before full rewards
    rampUpTime: number; // Time to reach full share value
  };
  
  // Database
  database: {
    type: 'memory' | 'redis' | 'postgresql';
    connectionString?: string;
  };
}

interface Share {
  id: string;
  minerId: string;
  workerName?: string;
  difficulty: number;
  timestamp: Date;
  blockHeight: number;
  score?: number;
  valid: boolean;
}

interface MinerStats {
  minerId: string;
  shares: number;
  score: number;
  lastShare: Date;
  joinedAt: Date;
  totalDifficulty: number;
}

interface Round {
  id: string;
  blockHeight: number;
  blockHash?: string;
  startTime: Date;
  endTime?: Date;
  totalShares: number;
  totalScore: number;
  totalDifficulty: number;
  reward?: number;
  status: 'active' | 'pending' | 'paid' | 'orphaned';
}

interface PayoutCalculation {
  round: Round;
  miners: Map<string, MinerPayout>;
  totalPayout: number;
  poolFee: number;
  timestamp: Date;
}

interface MinerPayout {
  minerId: string;
  shares: number;
  score: number;
  percentage: number;
  amount: number;
  bonus?: number;
}

export class PPLNSPaymentSystem extends EventEmitter {
  private config: PPLNSConfig;
  private shares: Share[] = [];
  private currentRound?: Round;
  private rounds: Map<string, Round> = new Map();
  private minerStats: Map<string, MinerStats> = new Map();
  private lastNShares: Share[] = [];
  
  // Dynamic N calculation
  private dynamicN: number = 0;
  private averageBlockTime: number = 600; // 10 minutes default

  constructor(config: PPLNSConfig) {
    super();
    this.config = config;
    
    // Initialize dynamic N if needed
    if (config.n === 'dynamic') {
      this.calculateDynamicN();
    }
  }

  /**
   * Initialize PPLNS system
   */
  async initialize(): Promise<void> {
    logger.info('Initializing PPLNS payment system', {
      n: this.config.n,
      scoring: this.config.scoring.method,
      protection: this.config.protection.enabled
    });

    // Load existing shares from database
    if (this.config.database.type !== 'memory') {
      await this.loadSharesFromDatabase();
    }

    // Start share cleanup
    this.startShareCleanup();

    this.emit('initialized');
  }

  /**
   * Submit share
   */
  async submitShare(share: Omit<Share, 'id' | 'score'>): Promise<void> {
    // Generate share ID
    const fullShare: Share = {
      ...share,
      id: `${share.blockHeight}-${share.minerId}-${Date.now()}`,
      score: this.calculateShareScore(share)
    };

    // Add to shares
    this.shares.push(fullShare);
    
    // Update miner stats
    this.updateMinerStats(fullShare);
    
    // Update last N shares
    this.updateLastNShares();

    // Persist if not using memory
    if (this.config.database.type !== 'memory') {
      await this.persistShare(fullShare);
    }

    this.emit('share:submitted', fullShare);
  }

  /**
   * Start new round
   */
  startNewRound(blockHeight: number): void {
    // End current round if exists
    if (this.currentRound) {
      this.endRound();
    }

    this.currentRound = {
      id: `round-${blockHeight}`,
      blockHeight,
      startTime: new Date(),
      totalShares: 0,
      totalScore: 0,
      totalDifficulty: 0,
      status: 'active'
    };

    this.rounds.set(this.currentRound.id, this.currentRound);
    
    logger.info('Started new round', {
      roundId: this.currentRound.id,
      blockHeight
    });

    this.emit('round:started', this.currentRound);
  }

  /**
   * End current round
   */
  endRound(): void {
    if (!this.currentRound) return;

    this.currentRound.endTime = new Date();
    this.currentRound.status = 'pending';

    logger.info('Ended round', {
      roundId: this.currentRound.id,
      totalShares: this.currentRound.totalShares
    });

    this.emit('round:ended', this.currentRound);
    this.currentRound = undefined;
  }

  /**
   * Calculate payouts for a block
   */
  async calculatePayouts(
    blockHeight: number,
    blockReward: number,
    poolFee: number = 0.01
  ): Promise<PayoutCalculation> {
    const round = Array.from(this.rounds.values()).find(
      r => r.blockHeight === blockHeight
    );

    if (!round) {
      throw new Error(`Round not found for block ${blockHeight}`);
    }

    // Get relevant shares
    const relevantShares = this.getRelevantShares(round);
    
    logger.info('Calculating payouts', {
      roundId: round.id,
      blockReward,
      relevantShares: relevantShares.length,
      poolFee
    });

    // Calculate total score
    const totalScore = relevantShares.reduce((sum, share) => sum + (share.score || 0), 0);
    
    // Calculate pool fee
    const poolFeeAmount = blockReward * poolFee;
    const distributableReward = blockReward - poolFeeAmount;

    // Calculate miner payouts
    const minerPayouts = new Map<string, MinerPayout>();
    const minerShares = this.groupSharesByMiner(relevantShares);

    for (const [minerId, shares] of minerShares) {
      const minerScore = shares.reduce((sum, share) => sum + (share.score || 0), 0);
      const percentage = minerScore / totalScore;
      const amount = distributableReward * percentage;
      
      // Apply pool hopping protection
      const bonus = this.calculateLoyaltyBonus(minerId, shares);
      
      minerPayouts.set(minerId, {
        minerId,
        shares: shares.length,
        score: minerScore,
        percentage,
        amount,
        bonus
      });
    }

    const calculation: PayoutCalculation = {
      round,
      miners: minerPayouts,
      totalPayout: distributableReward,
      poolFee: poolFeeAmount,
      timestamp: new Date()
    };

    // Update round
    round.reward = blockReward;
    round.status = 'paid';

    this.emit('payouts:calculated', calculation);
    return calculation;
  }

  /**
   * Get relevant shares for PPLNS calculation
   */
  private getRelevantShares(round: Round): Share[] {
    const n = this.config.n === 'dynamic' ? this.dynamicN : this.config.n;
    
    if (this.config.timeWindow) {
      // Time-based window
      const cutoffTime = new Date(round.endTime || Date.now());
      cutoffTime.setSeconds(cutoffTime.getSeconds() - this.config.timeWindow);
      
      return this.shares.filter(share => 
        share.timestamp >= cutoffTime &&
        share.timestamp <= (round.endTime || new Date()) &&
        share.valid
      );
    } else {
      // Last N shares
      return this.lastNShares.filter(share => share.valid);
    }
  }

  /**
   * Calculate share score
   */
  private calculateShareScore(share: Omit<Share, 'score'>): number {
    let score = share.difficulty;

    switch (this.config.scoring.method) {
      case 'linear':
        // Score equals difficulty
        break;
        
      case 'exponential':
        // Newer shares worth more
        const age = Date.now() - share.timestamp.getTime();
        const decay = this.config.scoring.decay || 0.0001;
        score *= Math.exp(-decay * age / 1000);
        break;
        
      case 'score':
        // Custom scoring (e.g., based on share difficulty and timing)
        const miner = this.minerStats.get(share.minerId);
        if (miner) {
          const loyaltyFactor = this.calculateLoyaltyFactor(miner);
          score *= loyaltyFactor;
        }
        break;
    }

    // Apply pool hopping protection
    if (this.config.protection.enabled) {
      const miner = this.minerStats.get(share.minerId);
      if (miner) {
        const timeInPool = share.timestamp.getTime() - miner.joinedAt.getTime();
        const rampUpFactor = Math.min(1, timeInPool / (this.config.protection.rampUpTime * 1000));
        score *= rampUpFactor;
      }
    }

    return score;
  }

  /**
   * Calculate loyalty factor for miner
   */
  private calculateLoyaltyFactor(miner: MinerStats): number {
    const timeInPool = Date.now() - miner.joinedAt.getTime();
    const minTime = this.config.protection.minTime * 1000;
    
    if (timeInPool < minTime) {
      return 0.5; // 50% penalty for new miners
    }
    
    // Gradually increase to 100% over ramp-up time
    const rampUpTime = this.config.protection.rampUpTime * 1000;
    return 0.5 + 0.5 * Math.min(1, (timeInPool - minTime) / rampUpTime);
  }

  /**
   * Calculate loyalty bonus
   */
  private calculateLoyaltyBonus(minerId: string, shares: Share[]): number {
    if (!this.config.protection.enabled) return 0;

    const miner = this.minerStats.get(minerId);
    if (!miner) return 0;

    const timeInPool = Date.now() - miner.joinedAt.getTime();
    const loyaltyDays = timeInPool / (24 * 60 * 60 * 1000);
    
    // 1% bonus per week, max 10%
    const bonusPercentage = Math.min(0.1, loyaltyDays / 7 * 0.01);
    
    const baseAmount = shares.reduce((sum, share) => sum + share.difficulty, 0);
    return baseAmount * bonusPercentage;
  }

  /**
   * Update miner statistics
   */
  private updateMinerStats(share: Share): void {
    let stats = this.minerStats.get(share.minerId);
    
    if (!stats) {
      stats = {
        minerId: share.minerId,
        shares: 0,
        score: 0,
        lastShare: share.timestamp,
        joinedAt: share.timestamp,
        totalDifficulty: 0
      };
      this.minerStats.set(share.minerId, stats);
    }

    stats.shares++;
    stats.score += share.score || 0;
    stats.lastShare = share.timestamp;
    stats.totalDifficulty += share.difficulty;

    // Update round stats
    if (this.currentRound) {
      this.currentRound.totalShares++;
      this.currentRound.totalScore += share.score || 0;
      this.currentRound.totalDifficulty += share.difficulty;
    }
  }

  /**
   * Update last N shares
   */
  private updateLastNShares(): void {
    const n = this.config.n === 'dynamic' ? this.dynamicN : this.config.n;
    
    // Get all valid shares sorted by timestamp
    const validShares = this.shares
      .filter(s => s.valid)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    
    // Keep only last N
    this.lastNShares = validShares.slice(0, n);
  }

  /**
   * Calculate dynamic N value
   */
  private calculateDynamicN(): void {
    // N = average shares per block * multiplier
    const sharesPerSecond = 100; // Estimate based on pool hash rate
    const multiplier = 2; // Include 2x expected shares for variance
    
    this.dynamicN = Math.floor(this.averageBlockTime * sharesPerSecond * multiplier);
    
    logger.info('Calculated dynamic N', {
      n: this.dynamicN,
      averageBlockTime: this.averageBlockTime
    });
  }

  /**
   * Group shares by miner
   */
  private groupSharesByMiner(shares: Share[]): Map<string, Share[]> {
    const grouped = new Map<string, Share[]>();
    
    for (const share of shares) {
      const minerShares = grouped.get(share.minerId) || [];
      minerShares.push(share);
      grouped.set(share.minerId, minerShares);
    }
    
    return grouped;
  }

  /**
   * Start share cleanup
   */
  private startShareCleanup(): void {
    setInterval(() => {
      const cutoffTime = new Date();
      cutoffTime.setHours(cutoffTime.getHours() - 24); // Keep 24 hours
      
      const oldCount = this.shares.length;
      this.shares = this.shares.filter(share => 
        share.timestamp > cutoffTime
      );
      
      const removed = oldCount - this.shares.length;
      if (removed > 0) {
        logger.debug('Cleaned up old shares', { removed });
      }
    }, 3600000); // Every hour
  }

  /**
   * Load shares from database
   */
  private async loadSharesFromDatabase(): Promise<void> {
    // Implementation depends on database type
    logger.info('Loading shares from database');
    // TODO: Implement database loading
  }

  /**
   * Persist share to database
   */
  private async persistShare(share: Share): Promise<void> {
    // Implementation depends on database type
    // TODO: Implement database persistence
  }

  /**
   * Get miner statistics
   */
  getMinerStats(minerId: string): MinerStats | undefined {
    return this.minerStats.get(minerId);
  }

  /**
   * Get all miner statistics
   */
  getAllMinerStats(): MinerStats[] {
    return Array.from(this.minerStats.values());
  }

  /**
   * Get round information
   */
  getRound(roundId: string): Round | undefined {
    return this.rounds.get(roundId);
  }

  /**
   * Get recent rounds
   */
  getRecentRounds(limit: number = 10): Round[] {
    return Array.from(this.rounds.values())
      .sort((a, b) => b.blockHeight - a.blockHeight)
      .slice(0, limit);
  }

  /**
   * Get system statistics
   */
  getStatistics(): any {
    const activeMiners = Array.from(this.minerStats.values()).filter(
      m => Date.now() - m.lastShare.getTime() < 600000 // Active in last 10 minutes
    );

    return {
      system: {
        n: this.config.n === 'dynamic' ? this.dynamicN : this.config.n,
        scoring: this.config.scoring.method,
        protection: this.config.protection.enabled
      },
      shares: {
        total: this.shares.length,
        lastN: this.lastNShares.length,
        valid: this.shares.filter(s => s.valid).length
      },
      miners: {
        total: this.minerStats.size,
        active: activeMiners.length
      },
      rounds: {
        total: this.rounds.size,
        active: this.currentRound ? 1 : 0,
        pending: Array.from(this.rounds.values()).filter(r => r.status === 'pending').length
      }
    };
  }
}

// Export types
export { PPLNSConfig, Share, MinerStats, Round, PayoutCalculation, MinerPayout };
