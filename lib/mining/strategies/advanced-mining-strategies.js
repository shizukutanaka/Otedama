// Advanced Mining Strategies for Otedama Pool
// Implements sophisticated mining approaches including hybrid solo/pool, anti-hopping, and more

import EventEmitter from 'events';
import { createLogger } from '../../core/logger.js';
import crypto from 'crypto';

const logger = createLogger('advanced-mining-strategies');

// Strategy types
export const MiningStrategy = {
  PURE_POOL: 'pure_pool',              // Traditional pool mining
  PURE_SOLO: 'pure_solo',              // Solo mining only
  HYBRID_ADAPTIVE: 'hybrid_adaptive',   // Dynamically switch between solo/pool
  SCORE_BASED: 'score_based',          // Score-based reward system
  LUCK_BASED: 'luck_based',            // Luck-adjusted payouts
  PERFORMANCE_WEIGHTED: 'performance_weighted', // Weight by miner performance
  TIME_WEIGHTED: 'time_weighted'       // Anti-hopping time weighting
};

// Anti-hopping window configurations
const HOPPING_WINDOWS = {
  AGGRESSIVE: 3600,      // 1 hour
  MODERATE: 14400,       // 4 hours
  RELAXED: 86400,        // 24 hours
  DISABLED: 0
};

export class AdvancedMiningStrategyManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      strategy: options.strategy || MiningStrategy.HYBRID_ADAPTIVE,
      antiHoppingWindow: options.antiHoppingWindow || HOPPING_WINDOWS.MODERATE,
      hybridThreshold: options.hybridThreshold || 0.01, // 1% of network hashrate
      scoreDecayRate: options.scoreDecayRate || 0.95,
      minPayoutThreshold: options.minPayoutThreshold || 0.001,
      performanceWindow: options.performanceWindow || 86400000, // 24 hours
      luckCalculationBlocks: options.luckCalculationBlocks || 100,
      ...options
    };
    
    // Strategy state
    this.miners = new Map();
    this.shares = new Map();
    this.blocks = new Map();
    this.networkStats = {
      difficulty: 0,
      hashrate: 0,
      blockTime: 600, // 10 minutes default
      lastBlockTime: Date.now()
    };
    
    // Performance tracking
    this.performanceMetrics = new Map();
    
    // Solo mining candidates
    this.soloMiningCandidates = new Set();
    
    // Initialize strategy
    this.initializeStrategy();
  }

  initializeStrategy() {
    logger.info(`Initializing ${this.config.strategy} mining strategy`);
    
    // Set up strategy-specific handlers
    switch (this.config.strategy) {
      case MiningStrategy.HYBRID_ADAPTIVE:
        this.initializeHybridStrategy();
        break;
      case MiningStrategy.SCORE_BASED:
        this.initializeScoreStrategy();
        break;
      case MiningStrategy.TIME_WEIGHTED:
        this.initializeTimeWeightedStrategy();
        break;
      case MiningStrategy.LUCK_BASED:
        this.initializeLuckBasedStrategy();
        break;
      case MiningStrategy.PERFORMANCE_WEIGHTED:
        this.initializePerformanceStrategy();
        break;
    }
    
    // Start periodic evaluations
    this.startPeriodicEvaluation();
  }

  // Hybrid Adaptive Strategy
  initializeHybridStrategy() {
    this.hybridEvaluator = setInterval(() => {
      this.evaluateHybridCandidates();
    }, 60000); // Every minute
  }

  evaluateHybridCandidates() {
    const poolHashrate = this.calculatePoolHashrate();
    const thresholdHashrate = this.networkStats.hashrate * this.config.hybridThreshold;
    
    for (const [minerId, miner] of this.miners) {
      const minerHashrate = this.getMinerHashrate(minerId);
      const minerEfficiency = this.calculateMinerEfficiency(minerId);
      
      // High hashrate miners with good efficiency can solo mine
      if (minerHashrate > thresholdHashrate && minerEfficiency > 0.95) {
        if (!this.soloMiningCandidates.has(minerId)) {
          this.soloMiningCandidates.add(minerId);
          this.emit('strategy-change', {
            minerId,
            from: 'pool',
            to: 'solo',
            reason: 'high_hashrate_efficiency'
          });
          logger.info(`Miner ${minerId} promoted to solo mining`);
        }
      } else if (this.soloMiningCandidates.has(minerId)) {
        // Demote back to pool if conditions no longer met
        this.soloMiningCandidates.delete(minerId);
        this.emit('strategy-change', {
          minerId,
          from: 'solo',
          to: 'pool',
          reason: 'conditions_not_met'
        });
        logger.info(`Miner ${minerId} demoted to pool mining`);
      }
    }
  }

  // Score-based Strategy
  initializeScoreStrategy() {
    this.scoreCalculator = setInterval(() => {
      this.updateMinerScores();
    }, 10000); // Every 10 seconds
  }

  updateMinerScores() {
    for (const [minerId, miner] of this.miners) {
      const currentScore = miner.score || 0;
      const shareValue = this.calculateShareValue(minerId);
      const timeWeight = this.calculateTimeWeight(miner.joinedAt);
      
      // Update score with decay
      miner.score = (currentScore * this.config.scoreDecayRate) + (shareValue * timeWeight);
      
      // Store score history
      if (!miner.scoreHistory) miner.scoreHistory = [];
      miner.scoreHistory.push({
        timestamp: Date.now(),
        score: miner.score
      });
      
      // Keep only recent history
      if (miner.scoreHistory.length > 1000) {
        miner.scoreHistory = miner.scoreHistory.slice(-500);
      }
    }
  }

  // Time-weighted Anti-hopping Strategy
  initializeTimeWeightedStrategy() {
    this.timeWeightCalculator = {
      calculate: (joinTime) => {
        const timeInPool = Date.now() - joinTime;
        const window = this.config.antiHoppingWindow * 1000; // Convert to ms
        
        if (window === 0) return 1; // Disabled
        
        // Exponential growth up to full weight
        const weight = 1 - Math.exp(-timeInPool / window);
        return Math.max(0.1, weight); // Minimum 10% weight
      }
    };
  }

  // Luck-based Strategy
  initializeLuckBasedStrategy() {
    this.luckCalculator = {
      poolLuck: 1.0,
      minerLuck: new Map(),
      
      updatePoolLuck: () => {
        const recentBlocks = this.getRecentBlocks(this.config.luckCalculationBlocks);
        if (recentBlocks.length === 0) return;
        
        const expectedTime = this.networkStats.blockTime * 1000;
        const actualTimes = [];
        
        for (let i = 1; i < recentBlocks.length; i++) {
          actualTimes.push(recentBlocks[i].timestamp - recentBlocks[i-1].timestamp);
        }
        
        if (actualTimes.length > 0) {
          const avgActualTime = actualTimes.reduce((a, b) => a + b) / actualTimes.length;
          this.luckCalculator.poolLuck = expectedTime / avgActualTime;
        }
      },
      
      updateMinerLuck: (minerId) => {
        const miner = this.miners.get(minerId);
        if (!miner) return;
        
        const expectedShares = this.calculateExpectedShares(minerId);
        const actualShares = miner.sharesSubmitted || 0;
        
        const luck = actualShares / Math.max(1, expectedShares);
        this.luckCalculator.minerLuck.set(minerId, luck);
      }
    };
    
    // Update luck periodically
    setInterval(() => {
      this.luckCalculator.updatePoolLuck();
      for (const minerId of this.miners.keys()) {
        this.luckCalculator.updateMinerLuck(minerId);
      }
    }, 60000);
  }

  // Performance-weighted Strategy
  initializePerformanceStrategy() {
    this.performanceAnalyzer = {
      metrics: new Map(),
      
      updateMetrics: (minerId) => {
        const miner = this.miners.get(minerId);
        if (!miner) return;
        
        const metrics = {
          efficiency: this.calculateMinerEfficiency(minerId),
          stability: this.calculateHashrateStability(minerId),
          uptime: this.calculateUptime(minerId),
          responseTime: this.calculateAverageResponseTime(minerId),
          errorRate: this.calculateErrorRate(minerId)
        };
        
        // Calculate composite performance score
        const weights = {
          efficiency: 0.3,
          stability: 0.2,
          uptime: 0.2,
          responseTime: 0.15,
          errorRate: 0.15
        };
        
        const performanceScore = Object.entries(metrics).reduce((score, [metric, value]) => {
          return score + (value * weights[metric]);
        }, 0);
        
        this.performanceAnalyzer.metrics.set(minerId, {
          ...metrics,
          composite: performanceScore,
          timestamp: Date.now()
        });
      }
    };
  }

  // Share submission with strategy application
  async submitShare(minerId, share) {
    const miner = this.miners.get(minerId);
    if (!miner) {
      throw new Error('Miner not found');
    }
    
    // Record share submission
    share.timestamp = Date.now();
    share.strategy = this.config.strategy;
    
    // Apply strategy-specific logic
    let shareValue = 1;
    let reward = 0;
    
    switch (this.config.strategy) {
      case MiningStrategy.HYBRID_ADAPTIVE:
        if (this.soloMiningCandidates.has(minerId)) {
          // Solo mining - full block reward if found
          share.isSolo = true;
          if (this.isBlockShare(share)) {
            reward = this.calculateBlockReward();
          }
        } else {
          // Pool mining - proportional reward
          shareValue = this.calculateShareValue(minerId);
        }
        break;
        
      case MiningStrategy.SCORE_BASED:
        shareValue = (miner.score || 1) * this.calculateShareDifficulty(share);
        break;
        
      case MiningStrategy.TIME_WEIGHTED:
        const timeWeight = this.timeWeightCalculator.calculate(miner.joinedAt);
        shareValue = timeWeight * this.calculateShareDifficulty(share);
        break;
        
      case MiningStrategy.LUCK_BASED:
        const minerLuck = this.luckCalculator.minerLuck.get(minerId) || 1;
        const poolLuck = this.luckCalculator.poolLuck;
        shareValue = this.calculateShareDifficulty(share) * (minerLuck / poolLuck);
        break;
        
      case MiningStrategy.PERFORMANCE_WEIGHTED:
        const performance = this.performanceAnalyzer.metrics.get(minerId);
        const perfMultiplier = performance ? performance.composite : 1;
        shareValue = this.calculateShareDifficulty(share) * perfMultiplier;
        break;
    }
    
    // Record share with calculated value
    if (!this.shares.has(minerId)) {
      this.shares.set(minerId, []);
    }
    
    this.shares.get(minerId).push({
      ...share,
      value: shareValue,
      reward: reward
    });
    
    // Update miner statistics
    miner.sharesSubmitted = (miner.sharesSubmitted || 0) + 1;
    miner.totalShareValue = (miner.totalShareValue || 0) + shareValue;
    miner.lastShareTime = Date.now();
    
    // Emit share event
    this.emit('share-submitted', {
      minerId,
      share,
      value: shareValue,
      reward: reward
    });
    
    return { accepted: true, value: shareValue, reward: reward };
  }

  // Advanced reward calculation
  calculateRewards(blockReward) {
    const rewards = new Map();
    const totalValue = this.calculateTotalShareValue();
    
    if (totalValue === 0) return rewards;
    
    // Apply strategy-specific reward distribution
    switch (this.config.strategy) {
      case MiningStrategy.HYBRID_ADAPTIVE:
        // Pool miners share the block reward proportionally
        for (const [minerId, miner] of this.miners) {
          if (!this.soloMiningCandidates.has(minerId)) {
            const minerValue = miner.totalShareValue || 0;
            const minerShare = (minerValue / totalValue) * blockReward * 0.99; // 1% pool fee
            rewards.set(minerId, minerShare);
          }
        }
        break;
        
      case MiningStrategy.SCORE_BASED:
        // Distribute based on accumulated scores
        const totalScore = Array.from(this.miners.values())
          .reduce((sum, miner) => sum + (miner.score || 0), 0);
          
        for (const [minerId, miner] of this.miners) {
          const minerReward = (miner.score / totalScore) * blockReward * 0.99;
          rewards.set(minerId, minerReward);
        }
        break;
        
      case MiningStrategy.TIME_WEIGHTED:
        // Apply time weights to prevent hopping
        for (const [minerId, miner] of this.miners) {
          const timeWeight = this.timeWeightCalculator.calculate(miner.joinedAt);
          const weightedValue = (miner.totalShareValue || 0) * timeWeight;
          const minerReward = (weightedValue / totalValue) * blockReward * 0.99;
          rewards.set(minerId, minerReward);
        }
        break;
        
      case MiningStrategy.LUCK_BASED:
        // Adjust rewards based on luck
        for (const [minerId, miner] of this.miners) {
          const minerLuck = this.luckCalculator.minerLuck.get(minerId) || 1;
          const adjustedValue = (miner.totalShareValue || 0) / minerLuck;
          const minerReward = (adjustedValue / totalValue) * blockReward * 0.99;
          rewards.set(minerId, minerReward);
        }
        break;
        
      case MiningStrategy.PERFORMANCE_WEIGHTED:
        // Weight by performance metrics
        let weightedTotal = 0;
        const weightedValues = new Map();
        
        for (const [minerId, miner] of this.miners) {
          const performance = this.performanceAnalyzer.metrics.get(minerId);
          const perfMultiplier = performance ? performance.composite : 1;
          const weightedValue = (miner.totalShareValue || 0) * perfMultiplier;
          weightedValues.set(minerId, weightedValue);
          weightedTotal += weightedValue;
        }
        
        for (const [minerId, weightedValue] of weightedValues) {
          const minerReward = (weightedValue / weightedTotal) * blockReward * 0.99;
          rewards.set(minerId, minerReward);
        }
        break;
    }
    
    return rewards;
  }

  // Miner management
  addMiner(minerId, minerInfo = {}) {
    const miner = {
      id: minerId,
      joinedAt: Date.now(),
      hashrate: 0,
      sharesSubmitted: 0,
      sharesAccepted: 0,
      sharesRejected: 0,
      totalShareValue: 0,
      score: 0,
      lastShareTime: 0,
      ...minerInfo
    };
    
    this.miners.set(minerId, miner);
    
    // Initialize performance tracking
    if (this.config.strategy === MiningStrategy.PERFORMANCE_WEIGHTED) {
      this.performanceAnalyzer.updateMetrics(minerId);
    }
    
    this.emit('miner-joined', { minerId, strategy: this.config.strategy });
  }

  removeMiner(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return;
    
    // Calculate final payout if any
    const pendingReward = this.calculatePendingReward(minerId);
    if (pendingReward > this.config.minPayoutThreshold) {
      this.emit('payout-required', { minerId, amount: pendingReward });
    }
    
    // Clean up
    this.miners.delete(minerId);
    this.shares.delete(minerId);
    this.soloMiningCandidates.delete(minerId);
    this.performanceMetrics.delete(minerId);
    
    this.emit('miner-left', { minerId });
  }

  // Helper methods
  calculateShareValue(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return 0;
    
    const shares = this.shares.get(minerId) || [];
    const recentShares = shares.filter(s => 
      s.timestamp > Date.now() - this.config.performanceWindow
    );
    
    return recentShares.reduce((sum, share) => sum + this.calculateShareDifficulty(share), 0);
  }

  calculateShareDifficulty(share) {
    // Convert hex difficulty to numerical value
    const diff = BigInt('0x' + share.difficulty);
    const baseDiff = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
    return Number(baseDiff) / Number(diff);
  }

  calculateTimeWeight(joinTime) {
    const timeInPool = Date.now() - joinTime;
    const window = this.config.antiHoppingWindow * 1000;
    
    if (window === 0) return 1;
    return Math.min(1, timeInPool / window);
  }

  calculateMinerEfficiency(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner || miner.sharesSubmitted === 0) return 0;
    
    return miner.sharesAccepted / miner.sharesSubmitted;
  }

  calculateHashrateStability(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner || !miner.hashrateHistory) return 0;
    
    const recentHistory = miner.hashrateHistory.slice(-20);
    if (recentHistory.length < 2) return 1;
    
    const avg = recentHistory.reduce((sum, h) => sum + h, 0) / recentHistory.length;
    const variance = recentHistory.reduce((sum, h) => sum + Math.pow(h - avg, 2), 0) / recentHistory.length;
    const stdDev = Math.sqrt(variance);
    
    // Return stability score (inverse of coefficient of variation)
    return avg > 0 ? 1 - (stdDev / avg) : 0;
  }

  calculateUptime(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return 0;
    
    const totalTime = Date.now() - miner.joinedAt;
    const downtime = miner.downtimeTotal || 0;
    
    return (totalTime - downtime) / totalTime;
  }

  calculateAverageResponseTime(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner || !miner.responseTimes) return 1;
    
    const recent = miner.responseTimes.slice(-100);
    if (recent.length === 0) return 1;
    
    const avg = recent.reduce((sum, t) => sum + t, 0) / recent.length;
    // Normalize to 0-1 scale (lower is better)
    return Math.max(0, 1 - (avg / 1000)); // Assume 1s is bad
  }

  calculateErrorRate(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return 1;
    
    const totalRequests = miner.totalRequests || 1;
    const errors = miner.errorCount || 0;
    
    return 1 - (errors / totalRequests); // Higher is better
  }

  getMinerHashrate(minerId) {
    const miner = this.miners.get(minerId);
    return miner ? miner.hashrate : 0;
  }

  calculatePoolHashrate() {
    let total = 0;
    for (const miner of this.miners.values()) {
      total += miner.hashrate || 0;
    }
    return total;
  }

  calculateTotalShareValue() {
    let total = 0;
    for (const miner of this.miners.values()) {
      total += miner.totalShareValue || 0;
    }
    return total;
  }

  calculateExpectedShares(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return 0;
    
    const timeInPool = Date.now() - miner.joinedAt;
    const expectedSharesPerHour = (miner.hashrate / this.networkStats.difficulty) * 3600;
    
    return expectedSharesPerHour * (timeInPool / 3600000);
  }

  calculatePendingReward(minerId) {
    // This would integrate with the actual payout system
    const miner = this.miners.get(minerId);
    if (!miner) return 0;
    
    return miner.pendingReward || 0;
  }

  isBlockShare(share) {
    const shareDiff = BigInt('0x' + share.difficulty);
    const networkDiff = BigInt('0x' + this.networkStats.difficulty.toString(16));
    return shareDiff >= networkDiff;
  }

  calculateBlockReward() {
    // This would get the actual block reward for the current coin
    return 6.25; // BTC example
  }

  getRecentBlocks(count) {
    const blocks = Array.from(this.blocks.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, count);
    return blocks;
  }

  updateNetworkStats(stats) {
    this.networkStats = {
      ...this.networkStats,
      ...stats
    };
  }

  // Periodic evaluation
  startPeriodicEvaluation() {
    setInterval(() => {
      this.evaluateStrategies();
      this.cleanupOldData();
    }, 300000); // Every 5 minutes
  }

  evaluateStrategies() {
    // Emit strategy performance metrics
    const metrics = {
      strategy: this.config.strategy,
      poolHashrate: this.calculatePoolHashrate(),
      totalMiners: this.miners.size,
      soloMiners: this.soloMiningCandidates.size,
      averageEfficiency: this.calculateAverageEfficiency(),
      timestamp: Date.now()
    };
    
    this.emit('strategy-metrics', metrics);
  }

  calculateAverageEfficiency() {
    if (this.miners.size === 0) return 0;
    
    let totalEfficiency = 0;
    for (const minerId of this.miners.keys()) {
      totalEfficiency += this.calculateMinerEfficiency(minerId);
    }
    
    return totalEfficiency / this.miners.size;
  }

  cleanupOldData() {
    const cutoff = Date.now() - 86400000; // 24 hours
    
    // Clean up old shares
    for (const [minerId, shares] of this.shares) {
      const recentShares = shares.filter(s => s.timestamp > cutoff);
      if (recentShares.length !== shares.length) {
        this.shares.set(minerId, recentShares);
      }
    }
    
    // Clean up old performance metrics
    for (const [minerId, miner] of this.miners) {
      if (miner.scoreHistory) {
        miner.scoreHistory = miner.scoreHistory.filter(s => s.timestamp > cutoff);
      }
      if (miner.hashrateHistory) {
        miner.hashrateHistory = miner.hashrateHistory.filter(h => h.timestamp > cutoff);
      }
    }
  }

  // Get strategy statistics
  getStatistics() {
    const stats = {
      strategy: this.config.strategy,
      miners: {
        total: this.miners.size,
        solo: this.soloMiningCandidates.size,
        pool: this.miners.size - this.soloMiningCandidates.size
      },
      performance: {
        averageEfficiency: this.calculateAverageEfficiency(),
        poolHashrate: this.calculatePoolHashrate(),
        totalShareValue: this.calculateTotalShareValue()
      },
      strategies: {}
    };
    
    // Add strategy-specific stats
    switch (this.config.strategy) {
      case MiningStrategy.SCORE_BASED:
        const scores = Array.from(this.miners.values()).map(m => m.score || 0);
        stats.strategies.scoreDistribution = {
          min: Math.min(...scores),
          max: Math.max(...scores),
          average: scores.reduce((a, b) => a + b, 0) / scores.length
        };
        break;
        
      case MiningStrategy.LUCK_BASED:
        stats.strategies.luck = {
          pool: this.luckCalculator.poolLuck,
          miners: Object.fromEntries(this.luckCalculator.minerLuck)
        };
        break;
        
      case MiningStrategy.PERFORMANCE_WEIGHTED:
        const performances = Array.from(this.performanceAnalyzer.metrics.values());
        stats.strategies.performance = {
          count: performances.length,
          averageComposite: performances.reduce((sum, p) => sum + p.composite, 0) / performances.length
        };
        break;
    }
    
    return stats;
  }

  shutdown() {
    // Clean up intervals
    if (this.hybridEvaluator) clearInterval(this.hybridEvaluator);
    if (this.scoreCalculator) clearInterval(this.scoreCalculator);
    
    // Save state for recovery
    this.emit('shutdown', {
      miners: Array.from(this.miners.entries()),
      shares: Array.from(this.shares.entries())
    });
  }
}

export default AdvancedMiningStrategyManager;