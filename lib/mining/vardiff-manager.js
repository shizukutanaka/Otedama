/**
 * Variable Difficulty Adjustment Manager (Vardiff)
 * Dynamically adjusts mining difficulty per miner based on hashrate
 * 
 * Features:
 * - Real-time hashrate tracking
 * - Smooth difficulty transitions
 * - Multi-algorithm support
 * - Share rate optimization
 * - Network condition adaptation
 */

const { EventEmitter } = require('events');
const { createLogger } = require('../core/logger');

const logger = createLogger('vardiff');

// Vardiff configuration defaults
const DEFAULT_CONFIG = {
  // Target share rate (shares per minute)
  targetShareRate: 20,
  
  // Variance allowed (±%)
  variancePercent: 30,
  
  // Minimum time between adjustments (seconds)
  adjustmentInterval: 90,
  
  // Maximum adjustment factor per change
  maxAdjustmentFactor: 2,
  
  // Difficulty bounds
  minDifficulty: 8,
  maxDifficulty: 1000000,
  
  // Share window for analysis
  shareWindow: 300, // 5 minutes
  
  // Smoothing factor (0-1, higher = more responsive)
  smoothingFactor: 0.3,
  
  // Algorithm-specific configurations
  algorithms: {
    sha256: {
      minDifficulty: 16,
      maxDifficulty: 10000000,
      targetShareRate: 15
    },
    scrypt: {
      minDifficulty: 8,
      maxDifficulty: 65536,
      targetShareRate: 20
    },
    ethash: {
      minDifficulty: 1000000,
      maxDifficulty: 10000000000,
      targetShareRate: 10
    },
    randomx: {
      minDifficulty: 1000,
      maxDifficulty: 1000000,
      targetShareRate: 25
    }
  }
};

// Difficulty adjustment strategies
const AdjustmentStrategy = {
  LINEAR: 'linear',
  EXPONENTIAL: 'exponential',
  ADAPTIVE: 'adaptive',
  CONSERVATIVE: 'conservative'
};

class MinerStats {
  constructor(minerId, algorithm) {
    this.minerId = minerId;
    this.algorithm = algorithm;
    this.currentDifficulty = DEFAULT_CONFIG.minDifficulty;
    this.shares = [];
    this.lastAdjustment = Date.now();
    this.hashrate = 0;
    this.validShares = 0;
    this.invalidShares = 0;
    this.adjustmentHistory = [];
    this.connectionTime = Date.now();
  }

  addShare(timestamp, difficulty, valid = true) {
    this.shares.push({
      timestamp,
      difficulty,
      valid
    });
    
    if (valid) {
      this.validShares++;
    } else {
      this.invalidShares++;
    }
    
    // Clean old shares
    const cutoff = timestamp - (DEFAULT_CONFIG.shareWindow * 1000);
    this.shares = this.shares.filter(s => s.timestamp > cutoff);
  }

  calculateShareRate() {
    if (this.shares.length === 0) return 0;
    
    const now = Date.now();
    const timeSpan = Math.min(
      now - this.connectionTime,
      DEFAULT_CONFIG.shareWindow * 1000
    );
    
    if (timeSpan === 0) return 0;
    
    // Shares per minute
    return (this.shares.length / timeSpan) * 60000;
  }

  calculateHashrate() {
    const validShares = this.shares.filter(s => s.valid);
    if (validShares.length === 0) return 0;
    
    const totalDifficulty = validShares.reduce((sum, share) => {
      return sum + share.difficulty;
    }, 0);
    
    const timeSpan = this.shares[this.shares.length - 1].timestamp - this.shares[0].timestamp;
    if (timeSpan === 0) return 0;
    
    // Hashes per second (difficulty * 2^32 / time)
    return (totalDifficulty * 4294967296) / (timeSpan / 1000);
  }

  getEfficiency() {
    const total = this.validShares + this.invalidShares;
    if (total === 0) return 1;
    return this.validShares / total;
  }

  recordAdjustment(oldDiff, newDiff, reason) {
    this.adjustmentHistory.push({
      timestamp: Date.now(),
      oldDifficulty: oldDiff,
      newDifficulty: newDiff,
      reason,
      shareRate: this.calculateShareRate(),
      hashrate: this.hashrate
    });
    
    // Keep only recent history
    if (this.adjustmentHistory.length > 50) {
      this.adjustmentHistory.shift();
    }
  }
}

class VardiffManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      ...DEFAULT_CONFIG,
      ...options,
      algorithms: {
        ...DEFAULT_CONFIG.algorithms,
        ...(options.algorithms || {})
      }
    };
    
    this.miners = new Map();
    this.strategy = options.strategy || AdjustmentStrategy.ADAPTIVE;
    this.adjustmentInterval = null;
    
    // Statistics
    this.stats = {
      totalAdjustments: 0,
      adjustmentsByReason: {
        tooFewShares: 0,
        tooManyShares: 0,
        efficiency: 0,
        network: 0
      },
      averageDifficulty: {},
      activeMinersByAlgorithm: {}
    };
    
    // Start adjustment loop
    this.startAdjustmentLoop();
  }

  /**
   * Add or update miner
   */
  addMiner(minerId, algorithm, initialDifficulty = null) {
    if (!this.miners.has(minerId)) {
      const stats = new MinerStats(minerId, algorithm);
      
      // Set initial difficulty
      const algoConfig = this.config.algorithms[algorithm] || {};
      stats.currentDifficulty = initialDifficulty || 
        algoConfig.minDifficulty || 
        this.config.minDifficulty;
      
      this.miners.set(minerId, stats);
      
      logger.info(`Added miner ${minerId} with initial difficulty ${stats.currentDifficulty}`);
      
      this.emit('miner:added', {
        minerId,
        algorithm,
        difficulty: stats.currentDifficulty
      });
    }
    
    return this.miners.get(minerId);
  }

  /**
   * Remove miner
   */
  removeMiner(minerId) {
    const stats = this.miners.get(minerId);
    if (stats) {
      this.miners.delete(minerId);
      
      this.emit('miner:removed', {
        minerId,
        finalDifficulty: stats.currentDifficulty,
        totalShares: stats.validShares
      });
    }
  }

  /**
   * Submit share
   */
  submitShare(minerId, valid = true) {
    const stats = this.miners.get(minerId);
    if (!stats) return;
    
    stats.addShare(Date.now(), stats.currentDifficulty, valid);
    
    // Update hashrate
    stats.hashrate = stats.calculateHashrate();
    
    // Check if immediate adjustment needed
    if (this.shouldAdjustImmediately(stats)) {
      this.adjustDifficulty(stats);
    }
  }

  /**
   * Check if immediate adjustment is needed
   */
  shouldAdjustImmediately(stats) {
    const shareRate = stats.calculateShareRate();
    const targetRate = this.getTargetShareRate(stats.algorithm);
    
    // Emergency adjustment if rate is way off
    const emergencyThreshold = 3; // 300% variance
    const ratioToTarget = shareRate / targetRate;
    
    return ratioToTarget > emergencyThreshold || ratioToTarget < (1 / emergencyThreshold);
  }

  /**
   * Get target share rate for algorithm
   */
  getTargetShareRate(algorithm) {
    const algoConfig = this.config.algorithms[algorithm];
    return algoConfig?.targetShareRate || this.config.targetShareRate;
  }

  /**
   * Adjust difficulty for miner
   */
  adjustDifficulty(stats, forceAdjust = false) {
    const now = Date.now();
    
    // Check adjustment interval
    if (!forceAdjust && (now - stats.lastAdjustment) < (this.config.adjustmentInterval * 1000)) {
      return false;
    }
    
    const shareRate = stats.calculateShareRate();
    const targetRate = this.getTargetShareRate(stats.algorithm);
    const efficiency = stats.getEfficiency();
    
    // Skip if no shares yet
    if (stats.shares.length < 5) {
      return false;
    }
    
    // Calculate new difficulty
    const { newDifficulty, reason } = this.calculateNewDifficulty(
      stats,
      shareRate,
      targetRate,
      efficiency
    );
    
    // Check if adjustment is significant
    const changeFactor = newDifficulty / stats.currentDifficulty;
    if (changeFactor > 0.9 && changeFactor < 1.1 && !forceAdjust) {
      return false; // Less than 10% change, skip
    }
    
    // Apply adjustment
    const oldDifficulty = stats.currentDifficulty;
    stats.currentDifficulty = newDifficulty;
    stats.lastAdjustment = now;
    stats.recordAdjustment(oldDifficulty, newDifficulty, reason);
    
    // Update statistics
    this.stats.totalAdjustments++;
    this.stats.adjustmentsByReason[reason]++;
    
    logger.info(`Adjusted difficulty for ${stats.minerId}: ${oldDifficulty} -> ${newDifficulty} (${reason})`);
    
    this.emit('difficulty:adjusted', {
      minerId: stats.minerId,
      oldDifficulty,
      newDifficulty,
      shareRate,
      targetRate,
      reason
    });
    
    return true;
  }

  /**
   * Calculate new difficulty
   */
  calculateNewDifficulty(stats, shareRate, targetRate, efficiency) {
    let newDifficulty = stats.currentDifficulty;
    let reason = 'unknown';
    
    // Get algorithm limits
    const algoConfig = this.config.algorithms[stats.algorithm] || {};
    const minDiff = algoConfig.minDifficulty || this.config.minDifficulty;
    const maxDiff = algoConfig.maxDifficulty || this.config.maxDifficulty;
    
    // Apply strategy
    switch (this.strategy) {
      case AdjustmentStrategy.LINEAR:
        ({ difficulty: newDifficulty, reason } = this.linearAdjustment(
          stats.currentDifficulty,
          shareRate,
          targetRate
        ));
        break;
        
      case AdjustmentStrategy.EXPONENTIAL:
        ({ difficulty: newDifficulty, reason } = this.exponentialAdjustment(
          stats.currentDifficulty,
          shareRate,
          targetRate
        ));
        break;
        
      case AdjustmentStrategy.ADAPTIVE:
        ({ difficulty: newDifficulty, reason } = this.adaptiveAdjustment(
          stats,
          shareRate,
          targetRate,
          efficiency
        ));
        break;
        
      case AdjustmentStrategy.CONSERVATIVE:
        ({ difficulty: newDifficulty, reason } = this.conservativeAdjustment(
          stats.currentDifficulty,
          shareRate,
          targetRate
        ));
        break;
    }
    
    // Apply smoothing
    if (this.config.smoothingFactor > 0) {
      const smoothed = stats.currentDifficulty + 
        (newDifficulty - stats.currentDifficulty) * this.config.smoothingFactor;
      newDifficulty = smoothed;
    }
    
    // Apply bounds
    newDifficulty = Math.max(minDiff, Math.min(maxDiff, newDifficulty));
    
    // Apply max adjustment factor
    const maxChange = stats.currentDifficulty * this.config.maxAdjustmentFactor;
    const minChange = stats.currentDifficulty / this.config.maxAdjustmentFactor;
    newDifficulty = Math.max(minChange, Math.min(maxChange, newDifficulty));
    
    // Round to reasonable precision
    newDifficulty = this.roundDifficulty(newDifficulty);
    
    return { newDifficulty, reason };
  }

  /**
   * Linear adjustment strategy
   */
  linearAdjustment(currentDiff, shareRate, targetRate) {
    const ratio = targetRate / shareRate;
    const newDifficulty = currentDiff * ratio;
    
    const reason = shareRate > targetRate ? 'tooManyShares' : 'tooFewShares';
    
    return { difficulty: newDifficulty, reason };
  }

  /**
   * Exponential adjustment strategy
   */
  exponentialAdjustment(currentDiff, shareRate, targetRate) {
    const ratio = targetRate / shareRate;
    const adjustment = Math.pow(ratio, 0.5); // Square root for gentler adjustment
    const newDifficulty = currentDiff * adjustment;
    
    const reason = shareRate > targetRate ? 'tooManyShares' : 'tooFewShares';
    
    return { difficulty: newDifficulty, reason };
  }

  /**
   * Adaptive adjustment strategy
   */
  adaptiveAdjustment(stats, shareRate, targetRate, efficiency) {
    let adjustment = 1;
    let reason = 'unknown';
    
    // Base adjustment on share rate
    const shareRatio = targetRate / shareRate;
    
    // Consider efficiency
    if (efficiency < 0.9) {
      // Poor efficiency, might be too high difficulty
      adjustment = shareRatio * 0.9;
      reason = 'efficiency';
    } else {
      // Good efficiency, adjust normally
      adjustment = shareRatio;
      reason = shareRate > targetRate ? 'tooManyShares' : 'tooFewShares';
    }
    
    // Consider hashrate stability
    const recentShares = stats.shares.slice(-10);
    if (recentShares.length >= 10) {
      const timestamps = recentShares.map(s => s.timestamp);
      const intervals = [];
      
      for (let i = 1; i < timestamps.length; i++) {
        intervals.push(timestamps[i] - timestamps[i-1]);
      }
      
      const avgInterval = intervals.reduce((a, b) => a + b) / intervals.length;
      const variance = intervals.reduce((sum, interval) => {
        return sum + Math.pow(interval - avgInterval, 2);
      }, 0) / intervals.length;
      
      const cv = Math.sqrt(variance) / avgInterval; // Coefficient of variation
      
      // High variance means unstable hashrate
      if (cv > 0.5) {
        adjustment *= 0.8; // Be more conservative
        reason = 'network';
      }
    }
    
    const newDifficulty = stats.currentDifficulty * adjustment;
    
    return { difficulty: newDifficulty, reason };
  }

  /**
   * Conservative adjustment strategy
   */
  conservativeAdjustment(currentDiff, shareRate, targetRate) {
    const ratio = targetRate / shareRate;
    let adjustment = 1;
    
    // Only adjust if significantly off target
    const variance = Math.abs(1 - ratio);
    if (variance > this.config.variancePercent / 100) {
      // Gentle adjustment
      adjustment = 1 + (ratio - 1) * 0.25;
    }
    
    const newDifficulty = currentDiff * adjustment;
    const reason = shareRate > targetRate ? 'tooManyShares' : 'tooFewShares';
    
    return { difficulty: newDifficulty, reason };
  }

  /**
   * Round difficulty to reasonable precision
   */
  roundDifficulty(difficulty) {
    if (difficulty < 1) {
      return Math.round(difficulty * 1000) / 1000;
    } else if (difficulty < 100) {
      return Math.round(difficulty * 10) / 10;
    } else if (difficulty < 10000) {
      return Math.round(difficulty);
    } else {
      // Round to nearest power of 2 for large difficulties
      const power = Math.round(Math.log2(difficulty));
      return Math.pow(2, power);
    }
  }

  /**
   * Start periodic adjustment loop
   */
  startAdjustmentLoop() {
    this.adjustmentInterval = setInterval(() => {
      this.performPeriodicAdjustments();
    }, 30000); // Check every 30 seconds
  }

  /**
   * Perform periodic adjustments
   */
  performPeriodicAdjustments() {
    const now = Date.now();
    let adjusted = 0;
    
    for (const [minerId, stats] of this.miners) {
      // Skip if recently adjusted
      if ((now - stats.lastAdjustment) < (this.config.adjustmentInterval * 1000)) {
        continue;
      }
      
      if (this.adjustDifficulty(stats)) {
        adjusted++;
      }
    }
    
    if (adjusted > 0) {
      logger.debug(`Performed ${adjusted} difficulty adjustments`);
    }
    
    // Update statistics
    this.updateStatistics();
  }

  /**
   * Update statistics
   */
  updateStatistics() {
    const difficultyByAlgorithm = {};
    const minersByAlgorithm = {};
    
    for (const [minerId, stats] of this.miners) {
      const algo = stats.algorithm;
      
      if (!difficultyByAlgorithm[algo]) {
        difficultyByAlgorithm[algo] = [];
        minersByAlgorithm[algo] = 0;
      }
      
      difficultyByAlgorithm[algo].push(stats.currentDifficulty);
      minersByAlgorithm[algo]++;
    }
    
    // Calculate averages
    for (const algo in difficultyByAlgorithm) {
      const difficulties = difficultyByAlgorithm[algo];
      const avg = difficulties.reduce((a, b) => a + b, 0) / difficulties.length;
      this.stats.averageDifficulty[algo] = avg;
    }
    
    this.stats.activeMinersByAlgorithm = minersByAlgorithm;
  }

  /**
   * Get miner stats
   */
  getMinerStats(minerId) {
    const stats = this.miners.get(minerId);
    if (!stats) return null;
    
    return {
      minerId,
      algorithm: stats.algorithm,
      currentDifficulty: stats.currentDifficulty,
      shareRate: stats.calculateShareRate(),
      hashrate: stats.hashrate,
      efficiency: stats.getEfficiency(),
      validShares: stats.validShares,
      invalidShares: stats.invalidShares,
      lastAdjustment: stats.lastAdjustment,
      adjustmentHistory: stats.adjustmentHistory
    };
  }

  /**
   * Get overall statistics
   */
  getStatistics() {
    return {
      ...this.stats,
      totalMiners: this.miners.size,
      strategy: this.strategy,
      config: {
        targetShareRate: this.config.targetShareRate,
        adjustmentInterval: this.config.adjustmentInterval,
        minDifficulty: this.config.minDifficulty,
        maxDifficulty: this.config.maxDifficulty
      }
    };
  }

  /**
   * Set adjustment strategy
   */
  setStrategy(strategy) {
    if (!Object.values(AdjustmentStrategy).includes(strategy)) {
      throw new Error(`Invalid strategy: ${strategy}`);
    }
    
    this.strategy = strategy;
    logger.info(`Changed vardiff strategy to: ${strategy}`);
  }

  /**
   * Force difficulty for miner
   */
  forceDifficulty(minerId, difficulty) {
    const stats = this.miners.get(minerId);
    if (!stats) return false;
    
    const oldDifficulty = stats.currentDifficulty;
    stats.currentDifficulty = difficulty;
    stats.lastAdjustment = Date.now();
    stats.recordAdjustment(oldDifficulty, difficulty, 'forced');
    
    this.emit('difficulty:forced', {
      minerId,
      oldDifficulty,
      newDifficulty: difficulty
    });
    
    return true;
  }

  /**
   * Stop vardiff manager
   */
  stop() {
    if (this.adjustmentInterval) {
      clearInterval(this.adjustmentInterval);
      this.adjustmentInterval = null;
    }
    
    this.removeAllListeners();
    this.miners.clear();
  }
}

module.exports = VardiffManager;