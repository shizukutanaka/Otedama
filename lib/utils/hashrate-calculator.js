/**
 * Unified Hashrate Calculator
 * Central utility for all hashrate calculations to avoid code duplication
 */

const { performance } = require('perf_hooks');

class HashrateCalculator {
  constructor() {
    // Constants for hashrate calculation
    this.HASH_CONSTANTS = {
      SHA256_DIFFICULTY_MULTIPLIER: 4294967296, // 2^32
      SCRYPT_DIFFICULTY_MULTIPLIER: 65536,
      ETHASH_DIFFICULTY_MULTIPLIER: 1000000,
      WINDOW_SIZES: {
        INSTANT: 60000,      // 1 minute
        SHORT: 300000,       // 5 minutes
        MEDIUM: 900000,      // 15 minutes
        LONG: 3600000,       // 1 hour
        DAILY: 86400000      // 24 hours
      }
    };
    
    // Cache for recent calculations
    this.cache = new Map();
    this.cacheTimeout = 5000; // 5 seconds
  }
  
  /**
   * Calculate hashrate based on shares and difficulty
   * @param {Object} params - Calculation parameters
   * @param {number} params.shares - Number of valid shares
   * @param {number} params.difficulty - Current difficulty
   * @param {number} params.timeWindow - Time window in milliseconds
   * @param {string} params.algorithm - Mining algorithm (sha256, scrypt, etc)
   * @returns {number} Hashrate in hashes per second
   */
  calculate({ shares, difficulty, timeWindow, algorithm = 'sha256' }) {
    // Input validation
    if (!shares || shares < 0) return 0;
    if (!difficulty || difficulty <= 0) return 0;
    if (!timeWindow || timeWindow <= 0) return 0;
    
    // Check cache
    const cacheKey = `${shares}:${difficulty}:${timeWindow}:${algorithm}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.value;
    }
    
    // Get algorithm-specific multiplier
    const multiplier = this.getMultiplier(algorithm);
    
    // Calculate hashrate
    const sharesPerSecond = shares / (timeWindow / 1000);
    const hashrate = Math.floor(sharesPerSecond * difficulty * multiplier);
    
    // Cache result
    this.cache.set(cacheKey, {
      value: hashrate,
      timestamp: Date.now()
    });
    
    // Clean old cache entries
    this.cleanCache();
    
    return hashrate;
  }
  
  /**
   * Calculate hashrate from miner statistics
   * @param {Object} minerStats - Miner statistics object
   * @returns {number} Hashrate in hashes per second
   */
  calculateFromMinerStats(minerStats) {
    if (!minerStats) return 0;
    
    const now = Date.now();
    const timeDiff = now - (minerStats.startTime || now);
    
    if (timeDiff <= 0) return 0;
    
    return this.calculate({
      shares: minerStats.validShares || 0,
      difficulty: minerStats.difficulty || 1,
      timeWindow: timeDiff,
      algorithm: minerStats.algorithm || 'sha256'
    });
  }
  
  /**
   * Calculate average hashrate over multiple time windows
   * @param {Array} shareHistory - Array of share submissions with timestamps
   * @param {number} difficulty - Current difficulty
   * @param {string} algorithm - Mining algorithm
   * @returns {Object} Hashrates for different time windows
   */
  calculateAverages(shareHistory, difficulty, algorithm = 'sha256') {
    if (!Array.isArray(shareHistory) || shareHistory.length === 0) {
      return {
        instant: 0,
        short: 0,
        medium: 0,
        long: 0,
        daily: 0
      };
    }
    
    const now = Date.now();
    const result = {};
    
    // Calculate for each window size
    for (const [windowName, windowSize] of Object.entries(this.HASH_CONSTANTS.WINDOW_SIZES)) {
      const cutoff = now - windowSize;
      const recentShares = shareHistory.filter(share => share.timestamp > cutoff);
      
      result[windowName] = this.calculate({
        shares: recentShares.length,
        difficulty,
        timeWindow: Math.min(windowSize, now - (shareHistory[0]?.timestamp || now)),
        algorithm
      });
    }
    
    return result;
  }
  
  /**
   * Calculate hashrate stability (variance)
   * @param {Array} hashrateHistory - Array of hashrate measurements
   * @returns {number} Stability score (0-1, where 1 is most stable)
   */
  calculateStability(hashrateHistory) {
    if (!Array.isArray(hashrateHistory) || hashrateHistory.length < 2) {
      return 1; // Assume stable if not enough data
    }
    
    // Calculate mean
    const mean = hashrateHistory.reduce((sum, h) => sum + h, 0) / hashrateHistory.length;
    
    if (mean === 0) return 0;
    
    // Calculate variance
    const variance = hashrateHistory.reduce((sum, h) => sum + Math.pow(h - mean, 2), 0) / hashrateHistory.length;
    
    // Calculate coefficient of variation
    const cv = Math.sqrt(variance) / mean;
    
    // Convert to stability score (inverse of CV, capped at 1)
    return Math.max(0, Math.min(1, 1 - cv));
  }
  
  /**
   * Estimate earnings based on hashrate
   * @param {Object} params - Earning calculation parameters
   * @returns {Object} Estimated earnings
   */
  estimateEarnings({ hashrate, difficulty, blockReward, poolFee = 0.01, networkHashrate }) {
    if (!hashrate || hashrate <= 0) {
      return {
        hourly: 0,
        daily: 0,
        weekly: 0,
        monthly: 0
      };
    }
    
    // Calculate share of network hashrate
    const shareOfNetwork = networkHashrate > 0 ? hashrate / networkHashrate : 0;
    
    // Estimate blocks per day
    const blocksPerDay = 144; // For Bitcoin, adjust for other coins
    
    // Calculate daily earnings
    const dailyEarnings = shareOfNetwork * blocksPerDay * blockReward * (1 - poolFee);
    
    return {
      hourly: dailyEarnings / 24,
      daily: dailyEarnings,
      weekly: dailyEarnings * 7,
      monthly: dailyEarnings * 30
    };
  }
  
  /**
   * Get algorithm-specific difficulty multiplier
   * @param {string} algorithm - Mining algorithm
   * @returns {number} Multiplier value
   */
  getMultiplier(algorithm) {
    switch (algorithm.toLowerCase()) {
      case 'sha256':
        return this.HASH_CONSTANTS.SHA256_DIFFICULTY_MULTIPLIER;
      case 'scrypt':
        return this.HASH_CONSTANTS.SCRYPT_DIFFICULTY_MULTIPLIER;
      case 'ethash':
        return this.HASH_CONSTANTS.ETHASH_DIFFICULTY_MULTIPLIER;
      default:
        return this.HASH_CONSTANTS.SHA256_DIFFICULTY_MULTIPLIER;
    }
  }
  
  /**
   * Convert hashrate to human-readable format
   * @param {number} hashrate - Hashrate in H/s
   * @returns {string} Formatted hashrate string
   */
  formatHashrate(hashrate) {
    if (!hashrate || hashrate < 0) return '0 H/s';
    
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
    let unitIndex = 0;
    let value = hashrate;
    
    while (value >= 1000 && unitIndex < units.length - 1) {
      value /= 1000;
      unitIndex++;
    }
    
    return `${value.toFixed(2)} ${units[unitIndex]}`;
  }
  
  /**
   * Clean expired cache entries
   */
  cleanCache() {
    if (this.cache.size > 1000) { // Limit cache size
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (now - entry.timestamp > this.cacheTimeout) {
          this.cache.delete(key);
        }
      }
    }
  }
  
  /**
   * Calculate network difficulty from hashrate
   * @param {number} networkHashrate - Network hashrate in H/s
   * @param {number} blockTime - Target block time in seconds
   * @returns {number} Estimated network difficulty
   */
  calculateDifficulty(networkHashrate, blockTime = 600) {
    if (!networkHashrate || networkHashrate <= 0) return 1;
    
    // Difficulty = hashrate * block_time / 2^32
    return (networkHashrate * blockTime) / this.HASH_CONSTANTS.SHA256_DIFFICULTY_MULTIPLIER;
  }
}

// Export singleton instance
module.exports = new HashrateCalculator();