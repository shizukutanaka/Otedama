/**
 * Advanced Difficulty Calculation and Adjustment
 * Design: Carmack (Performance) + Martin (Clean Architecture) + Pike (Simplicity)
 * 
 * Implements various difficulty adjustment algorithms for mining pools
 */

import { EventEmitter } from 'events';
import { createComponentLogger } from '../logging/simple-logger';

// ===== INTERFACES =====
export interface DifficultyConfig {
  algorithm: 'fixed' | 'vardiff' | 'adaptive' | 'machine-learning';
  initialDifficulty: number;
  minDifficulty: number;
  maxDifficulty: number;
  targetTime: number; // Target time between shares in seconds
  retargetInterval: number; // How often to adjust difficulty in seconds
  variancePercent: number; // Acceptable variance percentage
}

export interface ShareSubmission {
  timestamp: number;
  difficulty: number;
  valid: boolean;
  hashrate?: number;
}

export interface MinerDifficulty {
  minerId: string;
  currentDifficulty: number;
  targetDifficulty: number;
  lastAdjustment: number;
  shareHistory: ShareSubmission[];
  averageTime: number;
  variance: number;
  hashrate: number;
}

export interface DifficultyStats {
  totalMiners: number;
  averageDifficulty: number;
  minDifficulty: number;
  maxDifficulty: number;
  totalHashrate: number;
  adjustmentsMade: number;
}

// ===== BASE DIFFICULTY CALCULATOR =====
abstract class BaseDifficultyCalculator extends EventEmitter {
  protected config: Required<DifficultyConfig>;
  protected logger = createComponentLogger('DifficultyCalculator');
  protected miners = new Map<string, MinerDifficulty>();
  protected stats: DifficultyStats = {
    totalMiners: 0,
    averageDifficulty: 0,
    minDifficulty: Infinity,
    maxDifficulty: 0,
    totalHashrate: 0,
    adjustmentsMade: 0
  };

  constructor(config: DifficultyConfig) {
    super();
    
    this.config = {
      algorithm: config.algorithm,
      initialDifficulty: config.initialDifficulty,
      minDifficulty: config.minDifficulty,
      maxDifficulty: config.maxDifficulty,
      targetTime: config.targetTime,
      retargetInterval: config.retargetInterval,
      variancePercent: config.variancePercent
    };
  }

  abstract calculateNewDifficulty(miner: MinerDifficulty): number;
  
  getMinerDifficulty(minerId: string): number {
    const miner = this.miners.get(minerId);
    return miner?.currentDifficulty || this.config.initialDifficulty;
  }

  submitShare(minerId: string, share: ShareSubmission): void {
    let miner = this.miners.get(minerId);
    
    if (!miner) {
      miner = this.createMiner(minerId);
      this.miners.set(minerId, miner);
    }

    // Add share to history
    miner.shareHistory.push(share);
    
    // Keep only recent shares (last 50)
    if (miner.shareHistory.length > 50) {
      miner.shareHistory.shift();
    }

    // Check if we should adjust difficulty
    const timeSinceLastAdjustment = Date.now() - miner.lastAdjustment;
    if (timeSinceLastAdjustment >= this.config.retargetInterval * 1000) {
      this.adjustDifficulty(minerId);
    }

    this.updateStats();
  }

  protected createMiner(minerId: string): MinerDifficulty {
    return {
      minerId,
      currentDifficulty: this.config.initialDifficulty,
      targetDifficulty: this.config.initialDifficulty,
      lastAdjustment: Date.now(),
      shareHistory: [],
      averageTime: this.config.targetTime,
      variance: 0,
      hashrate: 0
    };
  }

  protected adjustDifficulty(minerId: string): void {
    const miner = this.miners.get(minerId);
    if (!miner || miner.shareHistory.length < 2) return;

    const oldDifficulty = miner.currentDifficulty;
    const newDifficulty = this.calculateNewDifficulty(miner);
    
    if (newDifficulty !== oldDifficulty) {
      miner.currentDifficulty = newDifficulty;
      miner.targetDifficulty = newDifficulty;
      miner.lastAdjustment = Date.now();
      this.stats.adjustmentsMade++;

      this.logger.debug('Adjusted difficulty', {
        minerId,
        oldDifficulty,
        newDifficulty,
        averageTime: miner.averageTime,
        hashrate: miner.hashrate
      });

      this.emit('difficulty:adjusted', {
        minerId,
        oldDifficulty,
        newDifficulty
      });
    }
  }

  protected calculateAverageShareTime(shares: ShareSubmission[]): number {
    if (shares.length < 2) return this.config.targetTime;

    let totalTime = 0;
    for (let i = 1; i < shares.length; i++) {
      totalTime += (shares[i].timestamp - shares[i - 1].timestamp) / 1000;
    }

    return totalTime / (shares.length - 1);
  }

  protected calculateVariance(shares: ShareSubmission[], averageTime: number): number {
    if (shares.length < 2) return 0;

    let sumSquaredDiff = 0;
    for (let i = 1; i < shares.length; i++) {
      const time = (shares[i].timestamp - shares[i - 1].timestamp) / 1000;
      sumSquaredDiff += Math.pow(time - averageTime, 2);
    }

    return Math.sqrt(sumSquaredDiff / (shares.length - 1));
  }

  protected calculateHashrate(difficulty: number, averageTime: number): number {
    // Hashrate = difficulty * 2^32 / averageTime
    return (difficulty * Math.pow(2, 32)) / averageTime;
  }

  protected clampDifficulty(difficulty: number): number {
    return Math.max(
      this.config.minDifficulty,
      Math.min(this.config.maxDifficulty, difficulty)
    );
  }

  protected updateStats(): void {
    let totalDifficulty = 0;
    let totalHashrate = 0;
    let minDiff = Infinity;
    let maxDiff = 0;

    for (const miner of this.miners.values()) {
      totalDifficulty += miner.currentDifficulty;
      totalHashrate += miner.hashrate;
      minDiff = Math.min(minDiff, miner.currentDifficulty);
      maxDiff = Math.max(maxDiff, miner.currentDifficulty);
    }

    this.stats = {
      totalMiners: this.miners.size,
      averageDifficulty: this.miners.size > 0 ? totalDifficulty / this.miners.size : 0,
      minDifficulty: minDiff === Infinity ? 0 : minDiff,
      maxDifficulty: maxDiff,
      totalHashrate,
      adjustmentsMade: this.stats.adjustmentsMade
    };
  }

  getStats(): DifficultyStats {
    return { ...this.stats };
  }

  getMinerInfo(minerId: string): MinerDifficulty | null {
    return this.miners.get(minerId) || null;
  }

  resetMiner(minerId: string): void {
    this.miners.delete(minerId);
    this.updateStats();
  }
}

// ===== FIXED DIFFICULTY =====
export class FixedDifficultyCalculator extends BaseDifficultyCalculator {
  calculateNewDifficulty(miner: MinerDifficulty): number {
    // Fixed difficulty doesn't change
    return this.config.initialDifficulty;
  }
}

// ===== VARIABLE DIFFICULTY (VARDIFF) =====
export class VariableDifficultyCalculator extends BaseDifficultyCalculator {
  calculateNewDifficulty(miner: MinerDifficulty): number {
    const shares = miner.shareHistory;
    if (shares.length < 3) return miner.currentDifficulty;

    // Calculate average time between shares
    const averageTime = this.calculateAverageShareTime(shares);
    miner.averageTime = averageTime;

    // Calculate variance
    miner.variance = this.calculateVariance(shares, averageTime);

    // Update hashrate
    miner.hashrate = this.calculateHashrate(miner.currentDifficulty, averageTime);

    // Calculate adjustment factor
    const ratio = this.config.targetTime / averageTime;
    
    // Apply dampening to prevent wild swings
    const dampening = 0.5;
    const adjustmentFactor = 1 + (ratio - 1) * dampening;

    // Calculate new difficulty
    let newDifficulty = miner.currentDifficulty * adjustmentFactor;

    // Apply variance-based adjustment
    if (miner.variance > averageTime * this.config.variancePercent / 100) {
      // High variance - make smaller adjustments
      const varianceReduction = 0.1;
      newDifficulty = miner.currentDifficulty + 
        (newDifficulty - miner.currentDifficulty) * varianceReduction;
    }

    // Round to nice numbers
    newDifficulty = this.roundToNiceNumber(newDifficulty);

    return this.clampDifficulty(newDifficulty);
  }

  private roundToNiceNumber(difficulty: number): number {
    if (difficulty < 1) {
      return Math.round(difficulty * 1000) / 1000;
    } else if (difficulty < 10) {
      return Math.round(difficulty * 10) / 10;
    } else if (difficulty < 100) {
      return Math.round(difficulty);
    } else if (difficulty < 1000) {
      return Math.round(difficulty / 10) * 10;
    } else if (difficulty < 10000) {
      return Math.round(difficulty / 100) * 100;
    } else {
      return Math.round(difficulty / 1000) * 1000;
    }
  }
}

// ===== ADAPTIVE DIFFICULTY =====
export class AdaptiveDifficultyCalculator extends BaseDifficultyCalculator {
  private networkDifficulty: number = 1;
  private blockTime: number = 600; // 10 minutes for Bitcoin

  setNetworkDifficulty(difficulty: number): void {
    this.networkDifficulty = difficulty;
  }

  calculateNewDifficulty(miner: MinerDifficulty): number {
    const shares = miner.shareHistory;
    if (shares.length < 5) return miner.currentDifficulty;

    // Calculate average time and hashrate
    const averageTime = this.calculateAverageShareTime(shares);
    miner.averageTime = averageTime;
    miner.hashrate = this.calculateHashrate(miner.currentDifficulty, averageTime);

    // Consider valid share ratio
    const validShares = shares.filter(s => s.valid).length;
    const validRatio = validShares / shares.length;

    // Base adjustment on target time
    let newDifficulty = miner.currentDifficulty * (this.config.targetTime / averageTime);

    // Adjust based on valid share ratio
    if (validRatio < 0.95) {
      // Too many invalid shares, reduce difficulty
      newDifficulty *= 0.9;
    } else if (validRatio > 0.99) {
      // Very few invalid shares, can increase difficulty more aggressively
      newDifficulty *= 1.1;
    }

    // Consider network difficulty for pool efficiency
    const poolEfficiency = this.calculatePoolEfficiency(miner.currentDifficulty);
    if (poolEfficiency < 0.01) {
      // Difficulty too low compared to network
      newDifficulty = Math.max(newDifficulty, this.networkDifficulty * 0.001);
    }

    // Apply smart rounding based on magnitude
    newDifficulty = this.smartRound(newDifficulty);

    return this.clampDifficulty(newDifficulty);
  }

  private calculatePoolEfficiency(minerDifficulty: number): number {
    return minerDifficulty / this.networkDifficulty;
  }

  private smartRound(difficulty: number): number {
    const magnitude = Math.floor(Math.log10(difficulty));
    const roundTo = Math.pow(10, Math.max(0, magnitude - 2));
    return Math.round(difficulty / roundTo) * roundTo;
  }
}

// ===== MACHINE LEARNING DIFFICULTY =====
export class MachineLearningDifficultyCalculator extends BaseDifficultyCalculator {
  private model: any = null; // Placeholder for ML model
  private trainingData: any[] = [];

  calculateNewDifficulty(miner: MinerDifficulty): number {
    const shares = miner.shareHistory;
    if (shares.length < 10) {
      // Fall back to vardiff for insufficient data
      return this.vardiffFallback(miner);
    }

    // Prepare features for prediction
    const features = this.extractFeatures(miner);

    // Predict optimal difficulty (simplified - in reality would use trained model)
    const prediction = this.predict(features);

    // Validate and clamp prediction
    let newDifficulty = prediction;

    // Sanity check - don't change too drastically
    const maxChange = 2.0; // Maximum 2x change
    const minChange = 0.5; // Minimum 0.5x change
    const ratio = newDifficulty / miner.currentDifficulty;

    if (ratio > maxChange) {
      newDifficulty = miner.currentDifficulty * maxChange;
    } else if (ratio < minChange) {
      newDifficulty = miner.currentDifficulty * minChange;
    }

    // Store training data for model updates
    this.collectTrainingData(miner, newDifficulty);

    return this.clampDifficulty(newDifficulty);
  }

  private vardiffFallback(miner: MinerDifficulty): number {
    const averageTime = this.calculateAverageShareTime(miner.shareHistory);
    const ratio = this.config.targetTime / averageTime;
    const newDifficulty = miner.currentDifficulty * ratio;
    return this.clampDifficulty(newDifficulty);
  }

  private extractFeatures(miner: MinerDifficulty): number[] {
    const shares = miner.shareHistory;
    const recentShares = shares.slice(-10);

    // Feature extraction
    const features = [
      miner.currentDifficulty,
      miner.averageTime,
      miner.variance,
      miner.hashrate,
      recentShares.filter(s => s.valid).length / recentShares.length, // Valid ratio
      this.calculateTrend(shares.map(s => s.timestamp)), // Time trend
      this.getTimeOfDay(), // Time of day (mining patterns)
      this.getDayOfWeek(), // Day of week
      shares.length // Number of shares
    ];

    return features;
  }

  private predict(features: number[]): number {
    // Simplified prediction - in reality would use trained neural network
    // For now, use a weighted combination of features
    const weights = [0.5, -0.3, -0.1, 0.2, 0.1, 0.05, 0.02, 0.01, 0.02];
    
    let prediction = this.config.initialDifficulty;
    for (let i = 0; i < features.length; i++) {
      prediction += features[i] * weights[i];
    }

    return Math.max(1, prediction);
  }

  private calculateTrend(timestamps: number[]): number {
    if (timestamps.length < 2) return 0;

    // Simple linear regression
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    const n = timestamps.length;

    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += timestamps[i];
      sumXY += i * timestamps[i];
      sumX2 += i * i;
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return slope;
  }

  private getTimeOfDay(): number {
    const hour = new Date().getHours();
    return hour / 24; // Normalize to 0-1
  }

  private getDayOfWeek(): number {
    const day = new Date().getDay();
    return day / 7; // Normalize to 0-1
  }

  private collectTrainingData(miner: MinerDifficulty, newDifficulty: number): void {
    const features = this.extractFeatures(miner);
    const label = newDifficulty;

    this.trainingData.push({
      features,
      label,
      timestamp: Date.now(),
      minerId: miner.minerId
    });

    // Keep only recent training data (last 10000 samples)
    if (this.trainingData.length > 10000) {
      this.trainingData.shift();
    }
  }

  async trainModel(): Promise<void> {
    // Placeholder for model training
    this.logger.info('Training ML model with data points', {
      dataPoints: this.trainingData.length
    });

    // In reality, would train a neural network here
    // For example, using TensorFlow.js or sending to a Python service
  }
}

// ===== DIFFICULTY MANAGER =====
export class DifficultyManager extends EventEmitter {
  private calculator: BaseDifficultyCalculator;
  private logger = createComponentLogger('DifficultyManager');

  constructor(config: DifficultyConfig) {
    super();

    // Create appropriate calculator based on algorithm
    switch (config.algorithm) {
      case 'fixed':
        this.calculator = new FixedDifficultyCalculator(config);
        break;
      case 'vardiff':
        this.calculator = new VariableDifficultyCalculator(config);
        break;
      case 'adaptive':
        this.calculator = new AdaptiveDifficultyCalculator(config);
        break;
      case 'machine-learning':
        this.calculator = new MachineLearningDifficultyCalculator(config);
        break;
      default:
        throw new Error(`Unknown difficulty algorithm: ${config.algorithm}`);
    }

    // Forward events
    this.calculator.on('difficulty:adjusted', (data) => {
      this.emit('difficulty:adjusted', data);
    });

    this.logger.info('Difficulty manager initialized', {
      algorithm: config.algorithm,
      initialDifficulty: config.initialDifficulty,
      targetTime: config.targetTime
    });
  }

  submitShare(minerId: string, share: ShareSubmission): void {
    this.calculator.submitShare(minerId, share);
  }

  getDifficulty(minerId: string): number {
    return this.calculator.getMinerDifficulty(minerId);
  }

  getMinerInfo(minerId: string): MinerDifficulty | null {
    return this.calculator.getMinerInfo(minerId);
  }

  getStats(): DifficultyStats {
    return this.calculator.getStats();
  }

  setNetworkDifficulty(difficulty: number): void {
    if (this.calculator instanceof AdaptiveDifficultyCalculator) {
      this.calculator.setNetworkDifficulty(difficulty);
    }
  }

  async trainModel(): Promise<void> {
    if (this.calculator instanceof MachineLearningDifficultyCalculator) {
      await this.calculator.trainModel();
    }
  }

  resetMiner(minerId: string): void {
    this.calculator.resetMiner(minerId);
    this.logger.info('Reset miner difficulty', { minerId });
  }
}
