// Variable Difficulty (Vardiff) implementation - Pike style simplicity
import { createComponentLogger, PerfTimer } from '../logging/logger';

export interface VardiffConfig {
  targetTime: number;          // Target seconds between shares (e.g., 10)
  retargetTime: number;        // Seconds between difficulty adjustments (e.g., 90)
  variancePercent: number;     // Acceptable variance percentage (e.g., 30)
  minDiff: number;            // Minimum difficulty (e.g., 64)
  maxDiff: number;            // Maximum difficulty (e.g., 4294967296)
  maxJump: number;            // Maximum difficulty change factor (e.g., 4)
}

export interface MinerDifficultyStats {
  currentDiff: number;
  lastShareTime: number;
  shareCount: number;
  shareTimeSum: number;
  lastRetarget: number;
  history: DifficultyChange[];
}

export interface DifficultyChange {
  timestamp: number;
  oldDiff: number;
  newDiff: number;
  reason: string;
  avgShareTime: number;
}

export class VardiffManager {
  private logger = createComponentLogger('Vardiff');
  private minerStats = new Map<string, MinerDifficultyStats>();
  private config: VardiffConfig;
  
  constructor(config: Partial<VardiffConfig> = {}) {
    this.config = {
      targetTime: 10,           // 10 seconds between shares
      retargetTime: 90,         // Adjust every 90 seconds
      variancePercent: 30,      // 30% variance allowed
      minDiff: 64,              // Minimum difficulty
      maxDiff: 4294967296,      // Maximum difficulty (2^32)
      maxJump: 4,               // Max 4x change per adjustment
      ...config
    };
    
    this.logger.info('Vardiff initialized', this.config);
  }
  
  // Get or create miner stats
  private getMinerStats(minerId: string, initialDiff?: number): MinerDifficultyStats {
    let stats = this.minerStats.get(minerId);
    
    if (!stats) {
      stats = {
        currentDiff: initialDiff || this.config.minDiff,
        lastShareTime: 0,
        shareCount: 0,
        shareTimeSum: 0,
        lastRetarget: Date.now(),
        history: []
      };
      this.minerStats.set(minerId, stats);
      
      this.logger.debug(`New miner ${minerId} with initial difficulty ${stats.currentDiff}`);
    }
    
    return stats;
  }
  
  // Record a share submission
  recordShare(minerId: string, timestamp: number = Date.now()): number {
    const stats = this.getMinerStats(minerId);
    
    // Calculate time since last share
    if (stats.lastShareTime > 0) {
      const timeDiff = (timestamp - stats.lastShareTime) / 1000; // Convert to seconds
      stats.shareTimeSum += timeDiff;
      stats.shareCount++;
    }
    
    stats.lastShareTime = timestamp;
    
    // Check if we should retarget
    const timeSinceRetarget = (timestamp - stats.lastRetarget) / 1000;
    if (timeSinceRetarget >= this.config.retargetTime && stats.shareCount >= 3) {
      this.retargetDifficulty(minerId, stats);
    }
    
    return stats.currentDiff;
  }
  
  // Retarget difficulty for a miner
  private retargetDifficulty(minerId: string, stats: MinerDifficultyStats): void {
    const timer = new PerfTimer();
    
    // Calculate average time between shares
    const avgShareTime = stats.shareTimeSum / stats.shareCount;
    
    // Calculate desired adjustment ratio
    const ratio = this.config.targetTime / avgShareTime;
    
    // Apply variance threshold
    const minRatio = 1 - (this.config.variancePercent / 100);
    const maxRatio = 1 + (this.config.variancePercent / 100);
    
    // Check if adjustment is needed
    if (ratio >= minRatio && ratio <= maxRatio) {
      // Within acceptable range, no adjustment needed
      return;
    }
    
    // Calculate new difficulty
    let newDiff = stats.currentDiff * ratio;
    
    // Apply max jump limit
    const maxIncrease = stats.currentDiff * this.config.maxJump;
    const maxDecrease = stats.currentDiff / this.config.maxJump;
    
    if (newDiff > maxIncrease) {
      newDiff = maxIncrease;
    } else if (newDiff < maxDecrease) {
      newDiff = maxDecrease;
    }
    
    // Apply min/max bounds
    newDiff = Math.max(this.config.minDiff, Math.min(this.config.maxDiff, newDiff));
    
    // Round to power of 2 for cleaner difficulty values
    newDiff = this.roundToPowerOfTwo(newDiff);
    
    // Only adjust if significant change
    if (newDiff === stats.currentDiff) {
      return;
    }
    
    // Record the change
    const change: DifficultyChange = {
      timestamp: Date.now(),
      oldDiff: stats.currentDiff,
      newDiff: newDiff,
      reason: ratio < 1 ? 'shares_too_slow' : 'shares_too_fast',
      avgShareTime: avgShareTime
    };
    
    stats.history.push(change);
    
    // Keep only recent history
    if (stats.history.length > 10) {
      stats.history.shift();
    }
    
    // Apply the change
    const oldDiff = stats.currentDiff;
    stats.currentDiff = newDiff;
    stats.lastRetarget = Date.now();
    stats.shareCount = 0;
    stats.shareTimeSum = 0;
    
    this.logger.info(`Difficulty adjusted for ${minerId}`, {
      oldDiff,
      newDiff,
      ratio: ratio.toFixed(2),
      avgShareTime: avgShareTime.toFixed(1),
      reason: change.reason
    });
    
    timer.log(this.logger, 'retarget_difficulty');
  }
  
  // Round to nearest power of two
  private roundToPowerOfTwo(n: number): number {
    const log2 = Math.log2(n);
    const lower = Math.pow(2, Math.floor(log2));
    const upper = Math.pow(2, Math.ceil(log2));
    
    // Choose the closer one
    return (n - lower) < (upper - n) ? lower : upper;
  }
  
  // Get current difficulty for a miner
  getDifficulty(minerId: string, initialDiff?: number): number {
    const stats = this.getMinerStats(minerId, initialDiff);
    return stats.currentDiff;
  }
  
  // Set difficulty manually (for testing or special cases)
  setDifficulty(minerId: string, difficulty: number): void {
    const stats = this.getMinerStats(minerId);
    
    const change: DifficultyChange = {
      timestamp: Date.now(),
      oldDiff: stats.currentDiff,
      newDiff: difficulty,
      reason: 'manual_adjustment',
      avgShareTime: 0
    };
    
    stats.currentDiff = difficulty;
    stats.lastRetarget = Date.now();
    stats.shareCount = 0;
    stats.shareTimeSum = 0;
    stats.history.push(change);
    
    this.logger.info(`Manual difficulty set for ${minerId}: ${difficulty}`);
  }
  
  // Get statistics for a miner
  getMinerStats(minerId: string): MinerDifficultyStats | undefined {
    return this.minerStats.get(minerId);
  }
  
  // Get all miners with their difficulties
  getAllMiners(): Array<{ minerId: string; difficulty: number; lastShare: number }> {
    const miners: Array<{ minerId: string; difficulty: number; lastShare: number }> = [];
    
    for (const [minerId, stats] of this.minerStats) {
      miners.push({
        minerId,
        difficulty: stats.currentDiff,
        lastShare: stats.lastShareTime
      });
    }
    
    return miners;
  }
  
  // Clean up inactive miners
  cleanup(inactiveSeconds: number = 3600): number {
    const now = Date.now();
    const cutoff = now - (inactiveSeconds * 1000);
    let removed = 0;
    
    for (const [minerId, stats] of this.minerStats) {
      if (stats.lastShareTime < cutoff) {
        this.minerStats.delete(minerId);
        removed++;
      }
    }
    
    if (removed > 0) {
      this.logger.info(`Cleaned up ${removed} inactive miners`);
    }
    
    return removed;
  }
  
  // Get vardiff statistics
  getStats(): {
    totalMiners: number;
    difficultyDistribution: Record<number, number>;
    averageDifficulty: number;
    recentAdjustments: number;
  } {
    const diffCounts: Record<number, number> = {};
    let totalDiff = 0;
    let recentAdjustments = 0;
    const oneHourAgo = Date.now() - 3600000;
    
    for (const stats of this.minerStats.values()) {
      // Count difficulties
      if (!diffCounts[stats.currentDiff]) {
        diffCounts[stats.currentDiff] = 0;
      }
      diffCounts[stats.currentDiff]++;
      
      totalDiff += stats.currentDiff;
      
      // Count recent adjustments
      for (const change of stats.history) {
        if (change.timestamp > oneHourAgo) {
          recentAdjustments++;
        }
      }
    }
    
    return {
      totalMiners: this.minerStats.size,
      difficultyDistribution: diffCounts,
      averageDifficulty: this.minerStats.size > 0 ? totalDiff / this.minerStats.size : 0,
      recentAdjustments
    };
  }
  
  // Export/import for persistence
  export(): Record<string, MinerDifficultyStats> {
    const data: Record<string, MinerDifficultyStats> = {};
    
    for (const [minerId, stats] of this.minerStats) {
      data[minerId] = { ...stats };
    }
    
    return data;
  }
  
  import(data: Record<string, MinerDifficultyStats>): void {
    this.minerStats.clear();
    
    for (const [minerId, stats] of Object.entries(data)) {
      this.minerStats.set(minerId, stats);
    }
    
    this.logger.info(`Imported vardiff data for ${this.minerStats.size} miners`);
  }
}

// Difficulty calculation utilities
export class DifficultyCalculator {
  // Bitcoin difficulty 1 target
  private static readonly DIFF1_TARGET = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
  
  // Convert difficulty to target
  static difficultyToTarget(difficulty: number): bigint {
    return this.DIFF1_TARGET / BigInt(Math.floor(difficulty));
  }
  
  // Convert target to difficulty
  static targetToDifficulty(target: bigint): number {
    return Number(this.DIFF1_TARGET / target);
  }
  
  // Check if hash meets difficulty
  static hashMeetsDifficulty(hash: string, difficulty: number): boolean {
    const hashBigInt = BigInt('0x' + hash);
    const target = this.difficultyToTarget(difficulty);
    return hashBigInt <= target;
  }
  
  // Calculate network difficulty from bits
  static bitsToNetworkDifficulty(bits: string): number {
    const bitsNum = parseInt(bits, 16);
    const exponent = bitsNum >> 24;
    const mantissa = bitsNum & 0xFFFFFF;
    
    const target = BigInt(mantissa) * (BigInt(2) ** BigInt(8 * (exponent - 3)));
    return this.targetToDifficulty(target);
  }
  
  // Estimate hashrate from shares
  static estimateHashrate(shares: number, difficulty: number, seconds: number): number {
    if (seconds <= 0) return 0;
    
    // Hashrate = (shares * difficulty * 2^32) / time
    const hashrate = (shares * difficulty * 4294967296) / seconds;
    return hashrate;
  }
  
  // Format hashrate for display
  static formatHashrate(hashrate: number): string {
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
    let unitIndex = 0;
    
    while (hashrate >= 1000 && unitIndex < units.length - 1) {
      hashrate /= 1000;
      unitIndex++;
    }
    
    return `${hashrate.toFixed(2)} ${units[unitIndex]}`;
  }
}

// Difficulty adjustment strategies
export enum VardiffStrategy {
  CLASSIC = 'classic',      // Traditional vardiff
  AGGRESSIVE = 'aggressive', // Faster adjustments
  STABLE = 'stable',        // Slower, more stable adjustments
  CUSTOM = 'custom'         // Custom configuration
}

export function getVardiffConfig(strategy: VardiffStrategy): Partial<VardiffConfig> {
  switch (strategy) {
    case VardiffStrategy.CLASSIC:
      return {
        targetTime: 10,
        retargetTime: 90,
        variancePercent: 30,
        maxJump: 4
      };
      
    case VardiffStrategy.AGGRESSIVE:
      return {
        targetTime: 5,
        retargetTime: 30,
        variancePercent: 20,
        maxJump: 8
      };
      
    case VardiffStrategy.STABLE:
      return {
        targetTime: 15,
        retargetTime: 180,
        variancePercent: 40,
        maxJump: 2
      };
      
    default:
      return {};
  }
}
