/**
 * Difficulty Adjustment Algorithm - Otedama
 * Dynamic difficulty adjustment for optimal mining performance
 * 
 * Design Principles:
 * - Carmack: Fast, lock-free adjustment calculations
 * - Martin: Clean separation of adjustment strategies
 * - Pike: Simple interface for complex algorithms
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('DifficultyAdjuster');

/**
 * Adjustment strategies
 */
const STRATEGIES = {
  STANDARD: 'standard',      // Target time based
  VARIANCE: 'variance',      // Variance reduction
  PREDICTIVE: 'predictive',  // Machine learning based
  HYBRID: 'hybrid'          // Combination of strategies
};

/**
 * Difficulty bounds
 */
const BOUNDS = {
  MIN_DIFFICULTY: 1,
  MAX_DIFFICULTY: 2 ** 256,
  MIN_ADJUSTMENT_FACTOR: 0.1,    // 10x decrease max
  MAX_ADJUSTMENT_FACTOR: 10,     // 10x increase max
  ADJUSTMENT_DAMPING: 0.25       // Smooth adjustments
};

/**
 * Difficulty Adjuster
 */
export class DifficultyAdjuster extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Target settings
      targetShareTime: config.targetShareTime || 30, // seconds
      targetBlockTime: config.targetBlockTime || 600, // 10 minutes
      
      // Adjustment settings
      strategy: config.strategy || STRATEGIES.HYBRID,
      adjustmentInterval: config.adjustmentInterval || 60000, // 1 minute
      historyWindow: config.historyWindow || 3600000, // 1 hour
      
      // Bounds
      minDifficulty: config.minDifficulty || BOUNDS.MIN_DIFFICULTY,
      maxDifficulty: config.maxDifficulty || BOUNDS.MAX_DIFFICULTY,
      
      // Performance
      smoothingFactor: config.smoothingFactor || 0.8,
      outlierThreshold: config.outlierThreshold || 3, // standard deviations
      
      ...config
    };
    
    // State
    this.currentDifficulty = this.config.minDifficulty;
    this.adjustmentHistory = [];
    this.shareHistory = new Map(); // minerId -> share times
    this.blockHistory = [];
    
    // Statistics
    this.stats = {
      adjustments: 0,
      totalShares: 0,
      totalBlocks: 0,
      averageShareTime: 0,
      averageBlockTime: 0
    };
    
    // Timers
    this.adjustmentTimer = null;
    
    this.logger = logger;
  }
  
  /**
   * Start automatic difficulty adjustment
   */
  start() {
    if (this.adjustmentTimer) return;
    
    this.adjustmentTimer = setInterval(() => {
      this.performAdjustment();
    }, this.config.adjustmentInterval);
    
    this.logger.info('Difficulty adjustment started', {
      strategy: this.config.strategy,
      interval: this.config.adjustmentInterval
    });
  }
  
  /**
   * Stop automatic difficulty adjustment
   */
  stop() {
    if (this.adjustmentTimer) {
      clearInterval(this.adjustmentTimer);
      this.adjustmentTimer = null;
    }
    
    this.logger.info('Difficulty adjustment stopped');
  }
  
  /**
   * Record share submission
   */
  recordShare(minerId, timestamp, difficulty) {
    if (!this.shareHistory.has(minerId)) {
      this.shareHistory.set(minerId, []);
    }
    
    const history = this.shareHistory.get(minerId);
    history.push({ timestamp, difficulty });
    
    // Keep only recent history
    const cutoff = Date.now() - this.config.historyWindow;
    const filtered = history.filter(s => s.timestamp > cutoff);
    this.shareHistory.set(minerId, filtered);
    
    this.stats.totalShares++;
  }
  
  /**
   * Record block found
   */
  recordBlock(timestamp, difficulty, shares) {
    this.blockHistory.push({
      timestamp,
      difficulty,
      shares,
      effort: shares / difficulty
    });
    
    // Keep only recent history
    const cutoff = Date.now() - this.config.historyWindow * 24; // 24 hours for blocks
    this.blockHistory = this.blockHistory.filter(b => b.timestamp > cutoff);
    
    this.stats.totalBlocks++;
  }
  
  /**
   * Perform difficulty adjustment
   */
  performAdjustment() {
    const startTime = Date.now();
    
    try {
      let newDifficulty;
      
      // Choose adjustment strategy
      switch (this.config.strategy) {
        case STRATEGIES.STANDARD:
          newDifficulty = this.standardAdjustment();
          break;
          
        case STRATEGIES.VARIANCE:
          newDifficulty = this.varianceAdjustment();
          break;
          
        case STRATEGIES.PREDICTIVE:
          newDifficulty = this.predictiveAdjustment();
          break;
          
        case STRATEGIES.HYBRID:
          newDifficulty = this.hybridAdjustment();
          break;
          
        default:
          newDifficulty = this.standardAdjustment();
      }
      
      // Apply bounds
      newDifficulty = this.applyBounds(newDifficulty);
      
      // Check if adjustment is needed
      const changeRatio = newDifficulty / this.currentDifficulty;
      const significantChange = changeRatio < 0.95 || changeRatio > 1.05;
      
      if (significantChange) {
        const oldDifficulty = this.currentDifficulty;
        this.currentDifficulty = newDifficulty;
        
        // Record adjustment
        this.adjustmentHistory.push({
          timestamp: Date.now(),
          oldDifficulty,
          newDifficulty,
          changeRatio,
          strategy: this.config.strategy
        });
        
        this.stats.adjustments++;
        
        this.logger.info('Difficulty adjusted', {
          old: oldDifficulty,
          new: newDifficulty,
          change: `${((changeRatio - 1) * 100).toFixed(2)}%`,
          duration: Date.now() - startTime
        });
        
        this.emit('adjusted', {
          oldDifficulty,
          newDifficulty,
          changeRatio
        });
      }
      
    } catch (error) {
      this.logger.error('Difficulty adjustment failed:', error);
    }
  }
  
  /**
   * Standard time-based adjustment
   */
  standardAdjustment() {
    const shareStats = this.calculateShareStats();
    
    if (shareStats.count < 10) {
      return this.currentDifficulty; // Not enough data
    }
    
    const targetTime = this.config.targetShareTime * 1000; // Convert to ms
    const actualTime = shareStats.averageTime;
    
    // Calculate adjustment factor
    let adjustmentFactor = targetTime / actualTime;
    
    // Apply damping to prevent oscillation
    adjustmentFactor = 1 + (adjustmentFactor - 1) * BOUNDS.ADJUSTMENT_DAMPING;
    
    return this.currentDifficulty * adjustmentFactor;
  }
  
  /**
   * Variance reduction adjustment
   */
  varianceAdjustment() {
    const shareStats = this.calculateShareStats();
    
    if (shareStats.count < 30) {
      return this.standardAdjustment(); // Fall back to standard
    }
    
    const targetTime = this.config.targetShareTime * 1000;
    const cv = shareStats.stdDev / shareStats.averageTime; // Coefficient of variation
    
    // High variance means we need more aggressive adjustment
    const varianceMultiplier = 1 + Math.min(cv, 1);
    
    // Base adjustment
    let adjustmentFactor = targetTime / shareStats.averageTime;
    
    // Apply variance-based modification
    if (adjustmentFactor > 1) {
      // Increasing difficulty - be more aggressive with high variance
      adjustmentFactor = 1 + (adjustmentFactor - 1) * varianceMultiplier;
    } else {
      // Decreasing difficulty - be more conservative with high variance
      adjustmentFactor = 1 - (1 - adjustmentFactor) / varianceMultiplier;
    }
    
    // Apply damping
    adjustmentFactor = 1 + (adjustmentFactor - 1) * BOUNDS.ADJUSTMENT_DAMPING;
    
    return this.currentDifficulty * adjustmentFactor;
  }
  
  /**
   * Predictive adjustment using trends
   */
  predictiveAdjustment() {
    const shareStats = this.calculateShareStats();
    const trend = this.calculateTrend();
    
    if (shareStats.count < 50 || !trend) {
      return this.varianceAdjustment(); // Fall back
    }
    
    const targetTime = this.config.targetShareTime * 1000;
    
    // Predict future share time based on trend
    const predictedTime = shareStats.averageTime + trend * this.config.adjustmentInterval;
    
    // Adjust based on prediction
    let adjustmentFactor = targetTime / predictedTime;
    
    // Be more aggressive with predictions
    adjustmentFactor = 1 + (adjustmentFactor - 1) * 0.5;
    
    return this.currentDifficulty * adjustmentFactor;
  }
  
  /**
   * Hybrid adjustment combining multiple strategies
   */
  hybridAdjustment() {
    const shareStats = this.calculateShareStats();
    
    if (shareStats.count < 10) {
      return this.currentDifficulty;
    }
    
    // Get adjustments from different strategies
    const standardDiff = this.standardAdjustment();
    const varianceDiff = this.varianceAdjustment();
    const predictiveDiff = this.predictiveAdjustment();
    
    // Weight based on data quality
    const dataQuality = Math.min(shareStats.count / 100, 1);
    
    const weights = {
      standard: 0.5 * (1 - dataQuality * 0.3),
      variance: 0.3 + dataQuality * 0.1,
      predictive: 0.2 * dataQuality
    };
    
    // Weighted average
    const weightedDiff = 
      standardDiff * weights.standard +
      varianceDiff * weights.variance +
      predictiveDiff * weights.predictive;
    
    return weightedDiff;
  }
  
  /**
   * Calculate share statistics
   */
  calculateShareStats() {
    const now = Date.now();
    const cutoff = now - this.config.historyWindow;
    const allShares = [];
    
    // Collect all recent shares
    for (const [minerId, shares] of this.shareHistory) {
      const recentShares = shares.filter(s => s.timestamp > cutoff);
      allShares.push(...recentShares);
    }
    
    // Sort by timestamp
    allShares.sort((a, b) => a.timestamp - b.timestamp);
    
    if (allShares.length < 2) {
      return { count: 0, averageTime: 0, stdDev: 0 };
    }
    
    // Calculate time between shares
    const shareTimes = [];
    for (let i = 1; i < allShares.length; i++) {
      const timeDiff = allShares[i].timestamp - allShares[i-1].timestamp;
      shareTimes.push(timeDiff);
    }
    
    // Remove outliers
    const filtered = this.removeOutliers(shareTimes);
    
    // Calculate statistics
    const sum = filtered.reduce((a, b) => a + b, 0);
    const average = sum / filtered.length;
    
    const variance = filtered.reduce((acc, time) => {
      return acc + Math.pow(time - average, 2);
    }, 0) / filtered.length;
    
    const stdDev = Math.sqrt(variance);
    
    this.stats.averageShareTime = average / 1000; // Convert to seconds
    
    return {
      count: filtered.length,
      averageTime: average,
      stdDev
    };
  }
  
  /**
   * Calculate trend in share times
   */
  calculateTrend() {
    const shareStats = [];
    const windowSize = 300000; // 5 minute windows
    const windows = Math.floor(this.config.historyWindow / windowSize);
    
    for (let i = 0; i < windows; i++) {
      const windowStart = Date.now() - (i + 1) * windowSize;
      const windowEnd = windowStart + windowSize;
      
      const windowShares = [];
      for (const [minerId, shares] of this.shareHistory) {
        const inWindow = shares.filter(s => 
          s.timestamp >= windowStart && s.timestamp < windowEnd
        );
        windowShares.push(...inWindow);
      }
      
      if (windowShares.length >= 5) {
        shareStats.unshift({
          time: windowStart + windowSize / 2,
          avgShareTime: this.calculateWindowAverage(windowShares)
        });
      }
    }
    
    if (shareStats.length < 3) return null;
    
    // Simple linear regression
    const n = shareStats.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    
    for (let i = 0; i < n; i++) {
      const x = i;
      const y = shareStats[i].avgShareTime;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    
    return slope;
  }
  
  /**
   * Calculate average share time in window
   */
  calculateWindowAverage(shares) {
    if (shares.length < 2) return 0;
    
    shares.sort((a, b) => a.timestamp - b.timestamp);
    
    const times = [];
    for (let i = 1; i < shares.length; i++) {
      times.push(shares[i].timestamp - shares[i-1].timestamp);
    }
    
    return times.reduce((a, b) => a + b, 0) / times.length;
  }
  
  /**
   * Remove statistical outliers
   */
  removeOutliers(data) {
    if (data.length < 4) return data;
    
    const sorted = [...data].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(data.length * 0.25)];
    const q3 = sorted[Math.floor(data.length * 0.75)];
    const iqr = q3 - q1;
    
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;
    
    return data.filter(x => x >= lowerBound && x <= upperBound);
  }
  
  /**
   * Apply difficulty bounds
   */
  applyBounds(difficulty) {
    // Apply min/max bounds
    difficulty = Math.max(this.config.minDifficulty, difficulty);
    difficulty = Math.min(this.config.maxDifficulty, difficulty);
    
    // Apply adjustment factor limits
    const maxChange = this.currentDifficulty * BOUNDS.MAX_ADJUSTMENT_FACTOR;
    const minChange = this.currentDifficulty * BOUNDS.MIN_ADJUSTMENT_FACTOR;
    
    difficulty = Math.max(minChange, difficulty);
    difficulty = Math.min(maxChange, difficulty);
    
    // Apply smoothing
    const smoothed = this.currentDifficulty * this.config.smoothingFactor +
                    difficulty * (1 - this.config.smoothingFactor);
    
    return Math.round(smoothed);
  }
  
  /**
   * Get difficulty for specific miner
   */
  getMinerDifficulty(minerId) {
    const minerShares = this.shareHistory.get(minerId) || [];
    const recentShares = minerShares.filter(s => 
      s.timestamp > Date.now() - 300000 // Last 5 minutes
    );
    
    if (recentShares.length < 3) {
      return this.currentDifficulty;
    }
    
    // Calculate miner-specific average time
    const times = [];
    for (let i = 1; i < recentShares.length; i++) {
      times.push(recentShares[i].timestamp - recentShares[i-1].timestamp);
    }
    
    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const targetTime = this.config.targetShareTime * 1000;
    
    // Adjust difficulty for this miner
    let minerDifficulty = this.currentDifficulty * (targetTime / avgTime);
    
    // Apply bounds (more lenient for individual miners)
    minerDifficulty = Math.max(this.currentDifficulty * 0.1, minerDifficulty);
    minerDifficulty = Math.min(this.currentDifficulty * 10, minerDifficulty);
    
    return Math.round(minerDifficulty);
  }
  
  /**
   * Get adjustment statistics
   */
  getStats() {
    const recentAdjustments = this.adjustmentHistory.slice(-10);
    
    return {
      currentDifficulty: this.currentDifficulty,
      strategy: this.config.strategy,
      totalAdjustments: this.stats.adjustments,
      totalShares: this.stats.totalShares,
      totalBlocks: this.stats.totalBlocks,
      averageShareTime: this.stats.averageShareTime,
      targetShareTime: this.config.targetShareTime,
      recentAdjustments: recentAdjustments.map(a => ({
        timestamp: new Date(a.timestamp).toISOString(),
        change: `${((a.changeRatio - 1) * 100).toFixed(2)}%`,
        newDifficulty: a.newDifficulty
      })),
      minerCount: this.shareHistory.size
    };
  }
  
  /**
   * Reset difficulty to default
   */
  reset() {
    this.currentDifficulty = this.config.minDifficulty;
    this.adjustmentHistory = [];
    this.shareHistory.clear();
    this.blockHistory = [];
    
    this.logger.info('Difficulty reset to minimum');
    this.emit('reset', { difficulty: this.currentDifficulty });
  }
}

export default DifficultyAdjuster;