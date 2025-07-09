/**
 * Dynamic difficulty adjustment implementation
 * Following John Carmack's principle: simple, fast, direct
 */

import { EventEmitter } from 'events';

export interface DifficultyConfig {
  targetTime: number;        // Target time between shares (seconds)
  retargetInterval: number;  // How often to adjust (seconds)
  variancePercent: number;   // Allowed variance (%)
  minDifficulty: number;     // Minimum difficulty
  maxDifficulty: number;     // Maximum difficulty
  jumpMultiplier: number;    // Max adjustment factor
}

export interface MinerDifficulty {
  minerId: string;
  difficulty: number;
  lastShare: number;
  shareCount: number;
  shareTimes: number[];
  targetAdjustment: number;
}

export class DifficultyManager extends EventEmitter {
  private miners = new Map<string, MinerDifficulty>();
  private adjustmentTimer?: NodeJS.Timeout;
  
  constructor(private config: DifficultyConfig) {
    super();
    this.startAdjustmentTimer();
  }

  initMiner(minerId: string, initialDifficulty?: number): number {
    const difficulty = initialDifficulty || this.config.minDifficulty;
    
    this.miners.set(minerId, {
      minerId,
      difficulty,
      lastShare: Date.now(),
      shareCount: 0,
      shareTimes: [],
      targetAdjustment: 0
    });

    return difficulty;
  }

  recordShare(minerId: string): void {
    const miner = this.miners.get(minerId);
    if (!miner) return;

    const now = Date.now();
    const timeSinceLastShare = (now - miner.lastShare) / 1000;

    miner.shareCount++;
    miner.lastShare = now;
    miner.shareTimes.push(timeSinceLastShare);

    // Keep only recent share times (last 20)
    if (miner.shareTimes.length > 20) {
      miner.shareTimes.shift();
    }

    // Quick adjustment for significant deviations
    if (miner.shareTimes.length >= 5) {
      const avgTime = this.calculateAverageTime(miner.shareTimes.slice(-5));
      
      if (avgTime < this.config.targetTime * 0.5) {
        // Too fast - increase difficulty immediately
        this.adjustDifficulty(minerId, 2.0);
      } else if (avgTime > this.config.targetTime * 2.0) {
        // Too slow - decrease difficulty immediately
        this.adjustDifficulty(minerId, 0.5);
      }
    }
  }

  private calculateAverageTime(times: number[]): number {
    if (times.length === 0) return this.config.targetTime;
    return times.reduce((sum, time) => sum + time, 0) / times.length;
  }

  private performScheduledAdjustments(): void {
    for (const [minerId, miner] of this.miners) {
      if (miner.shareTimes.length < 3) continue;

      const avgTime = this.calculateAverageTime(miner.shareTimes);
      const variance = Math.abs(avgTime - this.config.targetTime) / this.config.targetTime;

      // Skip if within acceptable variance
      if (variance < this.config.variancePercent / 100) continue;

      // Calculate adjustment factor
      const adjustmentFactor = this.config.targetTime / avgTime;
      const clampedFactor = Math.max(
        1 / this.config.jumpMultiplier,
        Math.min(this.config.jumpMultiplier, adjustmentFactor)
      );

      this.adjustDifficulty(minerId, clampedFactor);
    }
  }

  private adjustDifficulty(minerId: string, factor: number): void {
    const miner = this.miners.get(minerId);
    if (!miner) return;

    const oldDifficulty = miner.difficulty;
    const newDifficulty = Math.max(
      this.config.minDifficulty,
      Math.min(this.config.maxDifficulty, oldDifficulty * factor)
    );

    // Apply damping to prevent oscillation
    const damping = 0.8;
    miner.difficulty = oldDifficulty + (newDifficulty - oldDifficulty) * damping;
    
    // Round to reasonable precision
    miner.difficulty = Math.round(miner.difficulty * 100) / 100;

    if (Math.abs(miner.difficulty - oldDifficulty) > 0.01) {
      this.emit('difficultyAdjusted', {
        minerId,
        oldDifficulty,
        newDifficulty: miner.difficulty,
        factor
      });
    }
  }

  getDifficulty(minerId: string): number {
    const miner = this.miners.get(minerId);
    return miner ? miner.difficulty : this.config.minDifficulty;
  }

  getStats(minerId: string): MinerDifficulty | undefined {
    return this.miners.get(minerId);
  }

  getAllStats(): Map<string, MinerDifficulty> {
    return new Map(this.miners);
  }

  removeMiner(minerId: string): void {
    this.miners.delete(minerId);
  }

  private startAdjustmentTimer(): void {
    this.adjustmentTimer = setInterval(() => {
      this.performScheduledAdjustments();
    }, this.config.retargetInterval * 1000);
  }

  stop(): void {
    if (this.adjustmentTimer) {
      clearInterval(this.adjustmentTimer);
      this.adjustmentTimer = undefined;
    }
  }

  // Vardiff implementation for different algorithms
  static getDefaultConfig(algorithm: string): DifficultyConfig {
    switch (algorithm) {
      case 'sha256d':
        return {
          targetTime: 10,
          retargetInterval: 60,
          variancePercent: 30,
          minDifficulty: 1,
          maxDifficulty: 1000000,
          jumpMultiplier: 4
        };
      
      case 'scrypt':
        return {
          targetTime: 15,
          retargetInterval: 90,
          variancePercent: 25,
          minDifficulty: 0.001,
          maxDifficulty: 65536,
          jumpMultiplier: 2
        };
      
      case 'ethash':
        return {
          targetTime: 5,
          retargetInterval: 30,
          variancePercent: 20,
          minDifficulty: 1000000,
          maxDifficulty: 10000000000,
          jumpMultiplier: 3
        };
      
      default:
        return {
          targetTime: 10,
          retargetInterval: 60,
          variancePercent: 30,
          minDifficulty: 1,
          maxDifficulty: 1000000,
          jumpMultiplier: 4
        };
    }
  }
}

// Network difficulty tracker
export class NetworkDifficultyTracker {
  private history: Array<{ timestamp: number; difficulty: number }> = [];
  private readonly maxHistory = 2016; // Bitcoin's retarget interval

  addDifficulty(difficulty: number): void {
    this.history.push({
      timestamp: Date.now(),
      difficulty
    });

    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  getCurrentDifficulty(): number {
    if (this.history.length === 0) return 1;
    return this.history[this.history.length - 1].difficulty;
  }

  getAverageDifficulty(periods: number): number {
    if (this.history.length === 0) return 1;
    
    const start = Math.max(0, this.history.length - periods);
    const relevantHistory = this.history.slice(start);
    
    const sum = relevantHistory.reduce((acc, item) => acc + item.difficulty, 0);
    return sum / relevantHistory.length;
  }

  getDifficultyChange(periods: number): number {
    if (this.history.length < 2) return 0;
    
    const current = this.getCurrentDifficulty();
    const previous = this.history[Math.max(0, this.history.length - periods)]?.difficulty || current;
    
    return ((current - previous) / previous) * 100;
  }

  estimateNextDifficulty(blockTime: number, targetBlockTime: number): number {
    if (this.history.length < 2) return this.getCurrentDifficulty();
    
    const current = this.getCurrentDifficulty();
    const timeFactor = targetBlockTime / blockTime;
    
    // Bitcoin-style difficulty adjustment with 4x limits
    const adjustmentFactor = Math.max(0.25, Math.min(4, timeFactor));
    
    return current * adjustmentFactor;
  }
}
