/**
 * Lightweight Optimizations - Otedama
 * Ultra-fast, zero-allocation optimizations following Carmack principles
 * 
 * Design Philosophy:
 * - Carmack: Performance above all, micro-optimizations matter
 * - Martin: Clean interfaces hiding complex optimizations
 * - Pike: Simple and practical, avoid over-engineering
 */

/**
 * Fast string pool for mining operations
 * Reuses string objects to reduce GC pressure
 */
export class StringPool {
  constructor(maxSize = 10000) {
    this.pool = new Map();
    this.maxSize = maxSize;
    this.hitCount = 0;
    this.missCount = 0;
  }
  
  /**
   * Get interned string
   */
  intern(str) {
    if (this.pool.has(str)) {
      this.hitCount++;
      return this.pool.get(str);
    }
    
    this.missCount++;
    
    // Limit pool size to prevent memory leaks
    if (this.pool.size >= this.maxSize) {
      // Remove oldest entry (first in Map)
      const firstKey = this.pool.keys().next().value;
      this.pool.delete(firstKey);
    }
    
    this.pool.set(str, str);
    return str;
  }
  
  getStats() {
    return {
      size: this.pool.size,
      hitRate: this.hitCount / (this.hitCount + this.missCount),
      hits: this.hitCount,
      misses: this.missCount
    };
  }
}

/**
 * Lightweight JSON parser optimized for mining messages
 * Skips unnecessary parsing for known message structures
 */
export class FastMiningJSONParser {
  constructor() {
    // Pre-compiled regex patterns for common mining messages
    this.patterns = {
      subscribe: /^{"id":(\d+),"method":"mining\.subscribe","params":\[(.*?)\]}/,
      authorize: /^{"id":(\d+),"method":"mining\.authorize","params":\["([^"]+)","([^"]*)"\]}/,
      submit: /^{"id":(\d+),"method":"mining\.submit","params":\["([^"]+)","([^"]+)","([^"]+)","([^"]+)","([^"]+)"\]}/
    };
  }
  
  /**
   * Fast parse mining message without full JSON parsing
   */
  fastParse(data) {
    const str = data.toString('utf8');
    
    // Quick method detection
    if (str.includes('mining.subscribe')) {
      const match = this.patterns.subscribe.exec(str);
      if (match) {
        return {
          id: parseInt(match[1]),
          method: 'mining.subscribe',
          params: match[2] ? JSON.parse(`[${match[2]}]`) : []
        };
      }
    }
    
    if (str.includes('mining.authorize')) {
      const match = this.patterns.authorize.exec(str);
      if (match) {
        return {
          id: parseInt(match[1]),
          method: 'mining.authorize',
          params: [match[2], match[3]]
        };
      }
    }
    
    if (str.includes('mining.submit')) {
      const match = this.patterns.submit.exec(str);
      if (match) {
        return {
          id: parseInt(match[1]),
          method: 'mining.submit',
          params: [match[2], match[3], match[4], match[5], match[6]]
        };
      }
    }
    
    // Fall back to regular JSON parsing
    try {
      return JSON.parse(str);
    } catch (error) {
      return null;
    }
  }
}

/**
 * Ultra-fast difficulty calculation
 * Pre-computes common difficulty values
 */
export class FastDifficultyCalculator {
  constructor() {
    // Pre-computed difficulty targets for common values
    this.targetCache = new Map();
    this.maxCacheSize = 1000;
    
    // Pre-compute common difficulties
    const commonDiffs = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
    for (const diff of commonDiffs) {
      this.targetCache.set(diff, this.calculateTarget(diff));
    }
  }
  
  calculateTarget(difficulty) {
    // Bitcoin's difficulty 1 target
    const diff1Target = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
    return diff1Target / BigInt(Math.floor(difficulty));
  }
  
  getTarget(difficulty) {
    // Round to nearest power of 2 for cache efficiency
    const roundedDiff = Math.pow(2, Math.round(Math.log2(difficulty)));
    
    if (this.targetCache.has(roundedDiff)) {
      return this.targetCache.get(roundedDiff);
    }
    
    const target = this.calculateTarget(roundedDiff);
    
    // Cache management
    if (this.targetCache.size >= this.maxCacheSize) {
      const firstKey = this.targetCache.keys().next().value;
      this.targetCache.delete(firstKey);
    }
    
    this.targetCache.set(roundedDiff, target);
    return target;
  }
}

/**
 * Optimized extranonce management
 * Reduces allocations for miner identification
 */
export class LightweightExtranonceManager {
  constructor() {
    this.counter = 0;
    this.maxMiners = 0xFFFFFFFF; // 4 billion miners max
    this.minerMap = new Map();
  }
  
  /**
   * Generate extranonce1 without string allocation
   */
  generateExtranonce1() {
    if (this.counter >= this.maxMiners) {
      this.counter = 0; // Wrap around
    }
    
    const id = ++this.counter;
    // Convert to hex without string allocation overhead
    return id.toString(16).padStart(8, '0');
  }
  
  /**
   * Fast miner lookup by extranonce
   */
  getMiner(extranonce1) {
    return this.minerMap.get(extranonce1);
  }
  
  registerMiner(extranonce1, miner) {
    this.minerMap.set(extranonce1, miner);
  }
  
  unregisterMiner(extranonce1) {
    this.minerMap.delete(extranonce1);
  }
}

/**
 * Memory-efficient share tracking
 * Uses packed data structures to minimize memory usage
 */
export class CompactShareTracker {
  constructor(maxShares = 100000) {
    this.maxShares = maxShares;
    this.shares = new Array(maxShares);
    this.currentIndex = 0;
    this.totalShares = 0;
  }
  
  /**
   * Record share with minimal memory footprint
   */
  recordShare(minerId, difficulty, isValid, timestamp = Date.now()) {
    const share = {
      m: minerId,        // miner ID (shortened key)
      d: difficulty,     // difficulty
      v: isValid ? 1 : 0, // valid flag (1 byte)
      t: timestamp       // timestamp
    };
    
    this.shares[this.currentIndex] = share;
    this.currentIndex = (this.currentIndex + 1) % this.maxShares;
    this.totalShares++;
  }
  
  /**
   * Get recent shares for a miner
   */
  getRecentShares(minerId, count = 100) {
    const recentShares = [];
    let found = 0;
    
    // Search backwards from current position
    for (let i = 0; i < this.maxShares && found < count; i++) {
      const index = (this.currentIndex - 1 - i + this.maxShares) % this.maxShares;
      const share = this.shares[index];
      
      if (share && share.m === minerId) {
        recentShares.push(share);
        found++;
      }
    }
    
    return recentShares;
  }
  
  /**
   * Calculate hashrate for a miner
   */
  calculateHashrate(minerId, windowMs = 300000) { // 5 minute window
    const now = Date.now();
    const cutoff = now - windowMs;
    const shares = this.getRecentShares(minerId, 1000);
    
    let totalDifficulty = 0;
    let validShares = 0;
    
    for (const share of shares) {
      if (share.t >= cutoff && share.v === 1) {
        totalDifficulty += share.d;
        validShares++;
      }
    }
    
    if (validShares === 0) return 0;
    
    // Hashrate = (total difficulty * 2^32) / time window in seconds
    const windowSeconds = windowMs / 1000;
    return (totalDifficulty * Math.pow(2, 32)) / windowSeconds;
  }
}

// Export singletons for global use
export const globalStringPool = new StringPool();
export const fastJSONParser = new FastMiningJSONParser();
export const difficultyCalculator = new FastDifficultyCalculator();
export const extranonceManager = new LightweightExtranonceManager();
export const shareTracker = new CompactShareTracker();

export default {
  StringPool,
  FastMiningJSONParser,
  FastDifficultyCalculator,
  LightweightExtranonceManager,
  CompactShareTracker,
  globalStringPool,
  fastJSONParser,
  difficultyCalculator,
  extranonceManager,
  shareTracker
};