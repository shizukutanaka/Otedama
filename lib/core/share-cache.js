/**
 * Share Validation Cache - Otedama
 * High-performance caching for share validation
 * 
 * Design Principles:
 * - Carmack: LRU cache with minimal allocation
 * - Martin: Clean separation of caching and validation
 * - Pike: Simple interface for complex caching logic
 */

import { createStructuredLogger } from './structured-logger.js';
import crypto from 'crypto';

const logger = createStructuredLogger('ShareCache');

/**
 * High-performance LRU cache implementation
 */
class LRUCache {
  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.accessOrder = [];
    this.hits = 0;
    this.misses = 0;
  }
  
  get(key) {
    if (this.cache.has(key)) {
      this.hits++;
      // Move to end (most recently used)
      const index = this.accessOrder.indexOf(key);
      if (index > -1) {
        this.accessOrder.splice(index, 1);
      }
      this.accessOrder.push(key);
      return this.cache.get(key);
    }
    
    this.misses++;
    return null;
  }
  
  set(key, value) {
    // Remove if exists
    if (this.cache.has(key)) {
      const index = this.accessOrder.indexOf(key);
      if (index > -1) {
        this.accessOrder.splice(index, 1);
      }
    }
    
    // Add to cache
    this.cache.set(key, value);
    this.accessOrder.push(key);
    
    // Evict oldest if over size limit
    while (this.cache.size > this.maxSize) {
      const oldest = this.accessOrder.shift();
      this.cache.delete(oldest);
    }
  }
  
  clear() {
    this.cache.clear();
    this.accessOrder = [];
    this.hits = 0;
    this.misses = 0;
  }
  
  getStats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? (this.hits / total) * 100 : 0
    };
  }
}

/**
 * Share validation cache
 */
export class ShareCache {
  constructor(config = {}) {
    this.config = {
      // Cache sizes
      sharesCacheSize: config.sharesCacheSize || 50000,
      blocksCacheSize: config.blocksCacheSize || 1000,
      difficultyTargetsCacheSize: config.difficultyTargetsCacheSize || 1000,
      
      // TTL settings (milliseconds)
      shareTTL: config.shareTTL || 60000, // 1 minute
      blockTTL: config.blockTTL || 300000, // 5 minutes
      targetTTL: config.targetTTL || 3600000, // 1 hour
      
      // Duplicate window
      duplicateWindow: config.duplicateWindow || 300000, // 5 minutes
      
      // Performance settings
      cleanupInterval: config.cleanupInterval || 60000, // 1 minute
      
      ...config
    };
    
    // Caches
    this.sharesCache = new LRUCache(this.config.sharesCacheSize);
    this.blocksCache = new LRUCache(this.config.blocksCacheSize);
    this.targetsCache = new LRUCache(this.config.difficultyTargetsCacheSize);
    
    // Duplicate detection
    this.recentShares = new Map(); // hash -> timestamp
    this.duplicateCount = 0;
    
    // Statistics
    this.stats = {
      totalShares: 0,
      cachedValidations: 0,
      duplicatesDetected: 0,
      cacheCleanups: 0
    };
    
    // Cleanup timer
    this.cleanupTimer = null;
    
    this.logger = logger;
  }
  
  /**
   * Start cache cleanup timer
   */
  start() {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
    
    this.logger.info('Share cache started', {
      sharesCacheSize: this.config.sharesCacheSize,
      duplicateWindow: this.config.duplicateWindow
    });
  }
  
  /**
   * Stop cache cleanup timer
   */
  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    this.logger.info('Share cache stopped');
  }
  
  /**
   * Cache share validation result
   */
  cacheShareValidation(shareData, result) {
    const key = this.generateShareKey(shareData);
    
    const cacheEntry = {
      result,
      timestamp: Date.now(),
      difficulty: shareData.difficulty,
      algorithm: shareData.algorithm
    };
    
    this.sharesCache.set(key, cacheEntry);
    this.stats.totalShares++;
    
    // Track for duplicate detection
    const shareHash = this.generateShareHash(shareData);
    this.recentShares.set(shareHash, Date.now());
  }
  
  /**
   * Get cached share validation
   */
  getCachedValidation(shareData) {
    const key = this.generateShareKey(shareData);
    const cached = this.sharesCache.get(key);
    
    if (!cached) return null;
    
    // Check if cache entry is still valid
    const age = Date.now() - cached.timestamp;
    if (age > this.config.shareTTL) {
      return null;
    }
    
    // Verify difficulty hasn't changed
    if (cached.difficulty !== shareData.difficulty) {
      return null;
    }
    
    this.stats.cachedValidations++;
    return cached.result;
  }
  
  /**
   * Check if share is duplicate
   */
  isDuplicateShare(shareData) {
    const shareHash = this.generateShareHash(shareData);
    const lastSubmission = this.recentShares.get(shareHash);
    
    if (!lastSubmission) return false;
    
    const timeSinceSubmission = Date.now() - lastSubmission;
    if (timeSinceSubmission < this.config.duplicateWindow) {
      this.duplicateCount++;
      this.stats.duplicatesDetected++;
      return true;
    }
    
    return false;
  }
  
  /**
   * Cache block candidate
   */
  cacheBlockCandidate(blockData) {
    const key = this.generateBlockKey(blockData);
    
    const cacheEntry = {
      ...blockData,
      timestamp: Date.now()
    };
    
    this.blocksCache.set(key, cacheEntry);
    
    this.logger.info('Block candidate cached', {
      hash: blockData.hash,
      height: blockData.height
    });
  }
  
  /**
   * Get cached block candidate
   */
  getCachedBlock(hash) {
    const cached = this.blocksCache.get(hash);
    
    if (!cached) return null;
    
    // Check if cache entry is still valid
    const age = Date.now() - cached.timestamp;
    if (age > this.config.blockTTL) {
      return null;
    }
    
    return cached;
  }
  
  /**
   * Cache difficulty target calculation
   */
  cacheDifficultyTarget(difficulty, algorithm, target) {
    const key = `${algorithm}:${difficulty}`;
    
    const cacheEntry = {
      target,
      timestamp: Date.now()
    };
    
    this.targetsCache.set(key, cacheEntry);
  }
  
  /**
   * Get cached difficulty target
   */
  getCachedTarget(difficulty, algorithm) {
    const key = `${algorithm}:${difficulty}`;
    const cached = this.targetsCache.get(key);
    
    if (!cached) return null;
    
    // Check if cache entry is still valid
    const age = Date.now() - cached.timestamp;
    if (age > this.config.targetTTL) {
      return null;
    }
    
    return cached.target;
  }
  
  /**
   * Generate share cache key
   */
  generateShareKey(shareData) {
    // Create deterministic key from share data
    return `${shareData.jobId}:${shareData.nonce}:${shareData.extraNonce1}:${shareData.extraNonce2}`;
  }
  
  /**
   * Generate share hash for duplicate detection
   */
  generateShareHash(shareData) {
    const data = `${shareData.minerId}:${shareData.jobId}:${shareData.nonce}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }
  
  /**
   * Generate block cache key
   */
  generateBlockKey(blockData) {
    return blockData.hash;
  }
  
  /**
   * Clean up expired entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    // Clean recent shares
    for (const [hash, timestamp] of this.recentShares) {
      if (now - timestamp > this.config.duplicateWindow) {
        this.recentShares.delete(hash);
        cleaned++;
      }
    }
    
    this.stats.cacheCleanups++;
    
    if (cleaned > 0) {
      this.logger.debug('Cache cleanup completed', {
        entriesCleaned: cleaned,
        recentSharesSize: this.recentShares.size
      });
    }
  }
  
  /**
   * Clear all caches
   */
  clearAll() {
    this.sharesCache.clear();
    this.blocksCache.clear();
    this.targetsCache.clear();
    this.recentShares.clear();
    
    this.logger.info('All caches cleared');
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    return {
      shares: {
        ...this.sharesCache.getStats(),
        totalProcessed: this.stats.totalShares,
        cachedValidations: this.stats.cachedValidations,
        cacheEfficiency: this.stats.totalShares > 0 ? 
          (this.stats.cachedValidations / this.stats.totalShares) * 100 : 0
      },
      blocks: this.blocksCache.getStats(),
      targets: this.targetsCache.getStats(),
      duplicates: {
        detected: this.stats.duplicatesDetected,
        recentSharesTracked: this.recentShares.size
      },
      cleanups: this.stats.cacheCleanups
    };
  }
  
  /**
   * Optimize cache sizes based on usage patterns
   */
  optimizeCacheSizes() {
    const sharesStats = this.sharesCache.getStats();
    const blocksStats = this.blocksCache.getStats();
    
    // Adjust cache sizes based on hit rates
    if (sharesStats.hitRate < 50 && this.sharesCache.size === this.config.sharesCacheSize) {
      // Cache is full but hit rate is low - might need bigger cache
      this.logger.info('Low share cache hit rate detected', {
        hitRate: sharesStats.hitRate,
        currentSize: this.config.sharesCacheSize
      });
    }
    
    if (blocksStats.hitRate > 90 && this.blocksCache.size < this.config.blocksCacheSize * 0.5) {
      // Very high hit rate with small cache - could reduce size
      this.logger.info('High block cache efficiency detected', {
        hitRate: blocksStats.hitRate,
        utilization: (this.blocksCache.size / this.config.blocksCacheSize) * 100
      });
    }
  }
  
  /**
   * Export cache metrics for monitoring
   */
  exportMetrics() {
    const stats = this.getStats();
    
    return {
      sharesCacheHitRate: stats.shares.hitRate,
      sharesCacheSize: stats.shares.size,
      sharesCacheUtilization: (stats.shares.size / this.config.sharesCacheSize) * 100,
      blocksCacheHitRate: stats.blocks.hitRate,
      targetsCacheHitRate: stats.targets.hitRate,
      duplicatesDetected: stats.duplicates.detected,
      totalSharesProcessed: stats.shares.totalProcessed,
      cacheEfficiency: stats.shares.cacheEfficiency
    };
  }
}

/**
 * Create a global share cache instance
 */
let globalShareCache = null;

export function getShareCache(config) {
  if (!globalShareCache) {
    globalShareCache = new ShareCache(config);
    globalShareCache.start();
  }
  return globalShareCache;
}

export default ShareCache;