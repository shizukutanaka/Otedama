import { EventEmitter } from 'events';
import { EnhancedLogger } from '../core/error-handling';

/**
 * Advanced Difficulty Calculation Algorithm
 * Implements various difficulty adjustment strategies used in real mining pools
 * Following John Carmack's principle of efficient algorithms
 */

// ===== Types and Interfaces =====
export interface DifficultyConfig {
  // Base configuration
  algorithm: 'fixed' | 'vardiff' | 'adaptive' | 'hybrid';
  initialDifficulty: number;
  minDifficulty: number;
  maxDifficulty: number;
  
  // Target parameters
  targetShareTime: number; // seconds between shares
  shareTimeWindow: number; // seconds to analyze
  
  // Adjustment parameters
  adjustmentFactor: number; // multiplier for changes
  maxAdjustmentRatio: number; // max change per adjustment
  adjustmentInterval: number; // seconds between adjustments
  
  // Variance reduction
  variancePercent: number; // acceptable variance %
  bufferSize: number; // number of shares to buffer
  
  // Network difficulty tracking
  networkDifficulty?: number;
  poolHashratePercent?: number; // pool's % of network
}

export interface ShareTimeData {
  timestamp: number;
  difficulty: number;
  valid: boolean;
}

export interface MinerDifficulty {
  current: number;
  target: number;
  lastAdjustment: number;
  shareBuffer: ShareTimeData[];
  stats: {
    averageShareTime: number;
    shareTimeVariance: number;
    validShareRate: number;
    estimatedHashrate: number;
  };
}

// ===== Difficulty Adjustment Strategies =====
export abstract class DifficultyStrategy {
  protected logger: EnhancedLogger;
  
  constructor(protected config: DifficultyConfig) {
    this.logger = EnhancedLogger.getInstance();
  }
  
  abstract calculateNewDifficulty(
    minerData: MinerDifficulty,
    networkDifficulty?: number
  ): number;
  
  protected clampDifficulty(difficulty: number): number {
    return Math.max(
      this.config.minDifficulty,
      Math.min(this.config.maxDifficulty, difficulty)
    );
  }
  
  protected calculateStats(shares: ShareTimeData[]): MinerDifficulty['stats'] {
    if (shares.length < 2) {
      return {
        averageShareTime: 0,
        shareTimeVariance: 0,
        validShareRate: 0,
        estimatedHashrate: 0
      };
    }
    
    // Calculate share time intervals
    const intervals: number[] = [];
    for (let i = 1; i < shares.length; i++) {
      intervals.push((shares[i].timestamp - shares[i - 1].timestamp) / 1000);
    }
    
    // Calculate average
    const avgTime = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    
    // Calculate variance
    const variance = intervals.reduce((sum, interval) => {
      return sum + Math.pow(interval - avgTime, 2);
    }, 0) / intervals.length;
    
    // Calculate valid share rate
    const validShares = shares.filter(s => s.valid).length;
    const validRate = validShares / shares.length;
    
    // Estimate hashrate (hashes per second)
    const avgDifficulty = shares.reduce((sum, s) => sum + s.difficulty, 0) / shares.length;
    const hashrate = avgDifficulty * Math.pow(2, 32) / avgTime;
    
    return {
      averageShareTime: avgTime,
      shareTimeVariance: variance,
      validShareRate: validRate,
      estimatedHashrate: hashrate
    };
  }
}

// ===== Fixed Difficulty Strategy =====
export class FixedDifficultyStrategy extends DifficultyStrategy {
  calculateNewDifficulty(minerData: MinerDifficulty): number {
    return this.config.initialDifficulty;
  }
}

// ===== Variable Difficulty (Vardiff) Strategy =====
export class VardiffStrategy extends DifficultyStrategy {
  calculateNewDifficulty(minerData: MinerDifficulty): number {
    const stats = minerData.stats;
    
    if (stats.averageShareTime === 0) {
      return minerData.current;
    }
    
    // Calculate ratio of actual to target share time
    const ratio = this.config.targetShareTime / stats.averageShareTime;
    
    // Apply adjustment with dampening
    let newDifficulty = minerData.current * ratio;
    
    // Limit adjustment speed
    const maxChange = minerData.current * this.config.maxAdjustmentRatio;
    if (Math.abs(newDifficulty - minerData.current) > maxChange) {
      newDifficulty = minerData.current + 
        Math.sign(newDifficulty - minerData.current) * maxChange;
    }
    
    // Apply variance reduction
    if (stats.shareTimeVariance > 0) {
      const cv = Math.sqrt(stats.shareTimeVariance) / stats.averageShareTime;
      if (cv > this.config.variancePercent / 100) {
        // High variance - be more conservative
        newDifficulty = minerData.current + 
          (newDifficulty - minerData.current) * 0.5;
      }
    }
    
    return this.clampDifficulty(newDifficulty);
  }
}

// ===== Adaptive Difficulty Strategy =====
export class AdaptiveDifficultyStrategy extends DifficultyStrategy {
  private readonly WEIGHT_RECENT = 0.7;
  private readonly WEIGHT_HISTORICAL = 0.3;
  
  calculateNewDifficulty(
    minerData: MinerDifficulty,
    networkDifficulty?: number
  ): number {
    const stats = minerData.stats;
    
    // Base calculation using vardiff approach
    const vardiffResult = new VardiffStrategy(this.config)
      .calculateNewDifficulty(minerData);
    
    // Adjust based on network difficulty if available
    let adaptiveResult = vardiffResult;
    
    if (networkDifficulty && this.config.poolHashratePercent) {
      // Calculate expected shares per block
      const expectedSharesPerBlock = 1 / this.config.poolHashratePercent;
      
      // Adjust difficulty to maintain reasonable share rate
      const networkRatio = networkDifficulty / minerData.current;
      if (networkRatio > expectedSharesPerBlock * 10) {
        // Miner difficulty is too low relative to network
        adaptiveResult *= 1.5;
      } else if (networkRatio < expectedSharesPerBlock / 10) {
        // Miner difficulty is too high relative to network
        adaptiveResult *= 0.75;
      }
    }
    
    // Consider hashrate stability
    if (minerData.shareBuffer.length >= this.config.bufferSize) {
      const recentShares = minerData.shareBuffer.slice(-10);
      const historicalShares = minerData.shareBuffer.slice(0, -10);
      
      const recentStats = this.calculateStats(recentShares);
      const historicalStats = this.calculateStats(historicalShares);
      
      // Weighted average of recent and historical hashrates
      const weightedHashrate = 
        recentStats.estimatedHashrate * this.WEIGHT_RECENT +
        historicalStats.estimatedHashrate * this.WEIGHT_HISTORICAL;
      
      // Adjust difficulty based on hashrate trend
      const hashrateTrend = recentStats.estimatedHashrate / 
        (historicalStats.estimatedHashrate || 1);
      
      if (hashrateTrend > 1.2) {
        // Hashrate increasing - increase difficulty faster
        adaptiveResult *= 1.1;
      } else if (hashrateTrend < 0.8) {
        // Hashrate decreasing - decrease difficulty faster
        adaptiveResult *= 0.9;
      }
    }
    
    return this.clampDifficulty(adaptiveResult);
  }
}

// ===== Hybrid Difficulty Strategy =====
export class HybridDifficultyStrategy extends DifficultyStrategy {
  private strategies: Map<string, DifficultyStrategy>;
  
  constructor(config: DifficultyConfig) {
    super(config);
    
    this.strategies = new Map([
      ['vardiff', new VardiffStrategy(config)],
      ['adaptive', new AdaptiveDifficultyStrategy(config)]
    ]);
  }
  
  calculateNewDifficulty(
    minerData: MinerDifficulty,
    networkDifficulty?: number
  ): number {
    const results: number[] = [];
    
    // Get results from all strategies
    this.strategies.forEach((strategy, name) => {
      const result = strategy.calculateNewDifficulty(minerData, networkDifficulty);
      results.push(result);
    });
    
    // Use median of results for stability
    results.sort((a, b) => a - b);
    const median = results[Math.floor(results.length / 2)];
    
    // Apply additional smoothing
    const smoothed = minerData.current * 0.3 + median * 0.7;
    
    return this.clampDifficulty(smoothed);
  }
}

// ===== Difficulty Manager =====
export class DifficultyManager extends EventEmitter {
  private miners = new Map<string, MinerDifficulty>();
  private strategy: DifficultyStrategy;
  private adjustmentTimer?: NodeJS.Timeout;
  private logger: EnhancedLogger;
  
  constructor(private config: DifficultyConfig) {
    super();
    this.logger = EnhancedLogger.getInstance();
    this.strategy = this.createStrategy();
    this.startAdjustmentTimer();
  }
  
  private createStrategy(): DifficultyStrategy {
    switch (this.config.algorithm) {
      case 'fixed':
        return new FixedDifficultyStrategy(this.config);
      case 'vardiff':
        return new VardiffStrategy(this.config);
      case 'adaptive':
        return new AdaptiveDifficultyStrategy(this.config);
      case 'hybrid':
        return new HybridDifficultyStrategy(this.config);
      default:
        throw new Error(`Unknown difficulty algorithm: ${this.config.algorithm}`);
    }
  }
  
  private startAdjustmentTimer(): void {
    if (this.config.algorithm === 'fixed') return;
    
    this.adjustmentTimer = setInterval(() => {
      this.adjustAllMiners();
    }, this.config.adjustmentInterval * 1000);
  }
  
  // Initialize miner with starting difficulty
  initializeMiner(minerId: string): number {
    const minerData: MinerDifficulty = {
      current: this.config.initialDifficulty,
      target: this.config.initialDifficulty,
      lastAdjustment: Date.now(),
      shareBuffer: [],
      stats: {
        averageShareTime: 0,
        shareTimeVariance: 0,
        validShareRate: 0,
        estimatedHashrate: 0
      }
    };
    
    this.miners.set(minerId, minerData);
    
    this.logger.info('Initialized miner difficulty', {
      minerId,
      difficulty: minerData.current
    });
    
    return minerData.current;
  }
  
  // Record a share submission
  recordShare(minerId: string, valid: boolean): void {
    const minerData = this.miners.get(minerId);
    if (!minerData) return;
    
    const shareData: ShareTimeData = {
      timestamp: Date.now(),
      difficulty: minerData.current,
      valid
    };
    
    minerData.shareBuffer.push(shareData);
    
    // Limit buffer size
    if (minerData.shareBuffer.length > this.config.bufferSize) {
      minerData.shareBuffer.shift();
    }
    
    // Update stats
    minerData.stats = this.strategy.calculateStats(minerData.shareBuffer);
    
    // Check if immediate adjustment needed (for responsive algorithms)
    if (this.shouldAdjustImmediately(minerData)) {
      this.adjustMinerDifficulty(minerId);
    }
  }
  
  private shouldAdjustImmediately(minerData: MinerDifficulty): boolean {
    if (this.config.algorithm === 'fixed') return false;
    
    const timeSinceAdjustment = Date.now() - minerData.lastAdjustment;
    if (timeSinceAdjustment < 10000) return false; // Min 10 seconds
    
    // Check if share time is way off target
    const ratio = minerData.stats.averageShareTime / this.config.targetShareTime;
    return ratio < 0.1 || ratio > 10;
  }
  
  // Adjust difficulty for a specific miner
  adjustMinerDifficulty(minerId: string, networkDifficulty?: number): number {
    const minerData = this.miners.get(minerId);
    if (!minerData) {
      return this.initializeMiner(minerId);
    }
    
    if (minerData.shareBuffer.length < 5) {
      // Not enough data yet
      return minerData.current;
    }
    
    const oldDifficulty = minerData.current;
    const newDifficulty = this.strategy.calculateNewDifficulty(
      minerData,
      networkDifficulty || this.config.networkDifficulty
    );
    
    if (Math.abs(newDifficulty - oldDifficulty) / oldDifficulty > 0.01) {
      // Significant change (>1%)
      minerData.target = newDifficulty;
      minerData.current = newDifficulty;
      minerData.lastAdjustment = Date.now();
      
      this.logger.info('Adjusted miner difficulty', {
        minerId,
        oldDifficulty,
        newDifficulty,
        stats: minerData.stats
      });
      
      this.emit('difficultyAdjusted', {
        minerId,
        oldDifficulty,
        newDifficulty,
        stats: minerData.stats
      });
    }
    
    return minerData.current;
  }
  
  // Adjust all miners
  private adjustAllMiners(): void {
    const networkDifficulty = this.config.networkDifficulty;
    
    this.miners.forEach((minerData, minerId) => {
      this.adjustMinerDifficulty(minerId, networkDifficulty);
    });
  }
  
  // Get current difficulty for miner
  getMinerDifficulty(minerId: string): number {
    const minerData = this.miners.get(minerId);
    return minerData ? minerData.current : this.config.initialDifficulty;
  }
  
  // Get miner statistics
  getMinerStats(minerId: string): MinerDifficulty['stats'] | null {
    const minerData = this.miners.get(minerId);
    return minerData ? minerData.stats : null;
  }
  
  // Update network difficulty
  updateNetworkDifficulty(difficulty: number): void {
    this.config.networkDifficulty = difficulty;
    
    this.logger.info('Updated network difficulty', { difficulty });
    
    // Trigger adjustment for all miners
    if (this.config.algorithm === 'adaptive' || this.config.algorithm === 'hybrid') {
      this.adjustAllMiners();
    }
  }
  
  // Clean up inactive miners
  cleanupInactiveMiners(inactiveThreshold: number = 3600000): void {
    const now = Date.now();
    const toRemove: string[] = [];
    
    this.miners.forEach((minerData, minerId) => {
      const lastShareTime = minerData.shareBuffer.length > 0 ?
        minerData.shareBuffer[minerData.shareBuffer.length - 1].timestamp : 0;
      
      if (now - lastShareTime > inactiveThreshold) {
        toRemove.push(minerId);
      }
    });
    
    toRemove.forEach(minerId => {
      this.miners.delete(minerId);
      this.logger.info('Removed inactive miner', { minerId });
    });
  }
  
  // Get pool-wide statistics
  getPoolStats() {
    const stats = {
      totalMiners: this.miners.size,
      averageDifficulty: 0,
      totalHashrate: 0,
      difficultyDistribution: new Map<number, number>()
    };
    
    this.miners.forEach(minerData => {
      stats.averageDifficulty += minerData.current;
      stats.totalHashrate += minerData.stats.estimatedHashrate;
      
      const diffBucket = Math.floor(Math.log2(minerData.current));
      stats.difficultyDistribution.set(
        diffBucket,
        (stats.difficultyDistribution.get(diffBucket) || 0) + 1
      );
    });
    
    if (stats.totalMiners > 0) {
      stats.averageDifficulty /= stats.totalMiners;
    }
    
    return stats;
  }
  
  // Stop the manager
  stop(): void {
    if (this.adjustmentTimer) {
      clearInterval(this.adjustmentTimer);
      this.adjustmentTimer = undefined;
    }
  }
}

// ===== Difficulty Utilities =====
export class DifficultyUtils {
  // Convert difficulty to target (hex string)
  static difficultyToTarget(difficulty: number): string {
    const maxTarget = BigInt('0xFFFF0000000000000000000000000000000000000000000000000000');
    const target = maxTarget / BigInt(Math.floor(difficulty));
    return '0x' + target.toString(16).padStart(64, '0');
  }
  
  // Convert target to difficulty
  static targetToDifficulty(target: string): number {
    const maxTarget = BigInt('0xFFFF0000000000000000000000000000000000000000000000000000');
    const targetBigInt = BigInt(target);
    return Number(maxTarget / targetBigInt);
  }
  
  // Calculate difficulty from hashrate and block time
  static hashrateToDifficulty(hashrate: number, blockTime: number): number {
    return (hashrate * blockTime) / Math.pow(2, 32);
  }
  
  // Calculate hashrate from difficulty and block time
  static difficultyToHashrate(difficulty: number, blockTime: number): number {
    return (difficulty * Math.pow(2, 32)) / blockTime;
  }
  
  // Calculate probability of finding a block
  static blockProbability(
    minerHashrate: number,
    networkHashrate: number,
    blockTime: number
  ): number {
    return 1 - Math.exp(-(minerHashrate / networkHashrate) * blockTime);
  }
  
  // Calculate expected time to find a block
  static expectedBlockTime(
    minerHashrate: number,
    networkDifficulty: number
  ): number {
    const networkHashrate = this.difficultyToHashrate(networkDifficulty, 1);
    return networkHashrate / minerHashrate;
  }
  
  // Format difficulty for display
  static formatDifficulty(difficulty: number): string {
    if (difficulty < 1000) {
      return difficulty.toFixed(2);
    } else if (difficulty < 1000000) {
      return (difficulty / 1000).toFixed(2) + 'K';
    } else if (difficulty < 1000000000) {
      return (difficulty / 1000000).toFixed(2) + 'M';
    } else if (difficulty < 1000000000000) {
      return (difficulty / 1000000000).toFixed(2) + 'G';
    } else {
      return (difficulty / 1000000000000).toFixed(2) + 'T';
    }
  }
  
  // Format hashrate for display
  static formatHashrate(hashrate: number): string {
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
    let unitIndex = 0;
    let value = hashrate;
    
    while (value >= 1000 && unitIndex < units.length - 1) {
      value /= 1000;
      unitIndex++;
    }
    
    return value.toFixed(2) + ' ' + units[unitIndex];
  }
}