/**
 * High-Performance Cache Manager for Otedama
 * 
 * Design principles:
 * - Carmack: Zero-copy operations, minimal allocations
 * - Martin: Clear cache invalidation strategies
 * - Pike: Simple but efficient caching
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('CacheManager');

// Cache strategies
export const CacheStrategy = {
  LRU: 'lru',           // Least Recently Used
  LFU: 'lfu',           // Least Frequently Used
  TTL: 'ttl',           // Time To Live
  ADAPTIVE: 'adaptive'  // Adaptive based on access patterns
};

/**
 * Memory-efficient cache entry
 */
class CacheEntry {
  constructor(key, value, ttl = 0) {
    this.key = key;
    this.value = value;
    this.hits = 0;
    this.lastAccess = Date.now();
    this.createdAt = Date.now();
    this.expiresAt = ttl > 0 ? Date.now() + ttl : 0;
    this.size = this.calculateSize(value);
  }
  
  calculateSize(value) {
    if (Buffer.isBuffer(value)) {
      return value.length;
    } else if (typeof value === 'string') {
      return value.length * 2; // UTF-16
    } else if (typeof value === 'object') {
      return JSON.stringify(value).length * 2;
    } else {
      return 8; // Number or boolean
    }
  }
  
  access() {
    this.hits++;
    this.lastAccess = Date.now();
  }
  
  isExpired() {
    return this.expiresAt > 0 && Date.now() > this.expiresAt;
  }
  
  getScore(strategy) {
    switch (strategy) {
      case CacheStrategy.LRU:
        return this.lastAccess;
      case CacheStrategy.LFU:
        return this.hits;
      case CacheStrategy.ADAPTIVE:
        // Combine recency and frequency
        const age = Date.now() - this.createdAt;
        const recencyScore = 1 / (Date.now() - this.lastAccess + 1);
        const frequencyScore = this.hits / (age / 1000 + 1);
        return recencyScore * 0.7 + frequencyScore * 0.3;
      default:
        return this.lastAccess;
    }
  }
}

/**
 * High-performance cache manager
 */
export class CacheManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      maxSize: options.maxSize || 100 * 1024 * 1024, // 100MB
      maxEntries: options.maxEntries || 10000,
      strategy: options.strategy || CacheStrategy.ADAPTIVE,
      ttl: options.ttl || 3600000, // 1 hour default
      checkInterval: options.checkInterval || 60000, // 1 minute
      enableCompression: options.enableCompression || false,
      enableSharding: options.enableSharding || false,
      shardCount: options.shardCount || 16,
      warmupRatio: options.warmupRatio || 0.8
    };
    
    // Initialize shards for better concurrency
    if (this.options.enableSharding) {
      this.shards = new Array(this.options.shardCount);
      for (let i = 0; i < this.options.shardCount; i++) {
        this.shards[i] = new Map();
      }
    } else {
      this.cache = new Map();
    }
    
    // Statistics
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      currentSize: 0,
      currentEntries: 0
    };
    
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), this.options.checkInterval);
  }
  
  /**
   * Get shard for key
   */
  getShard(key) {
    if (!this.options.enableSharding) {
      return this.cache;
    }
    
    // Simple hash distribution
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    const shardIndex = Math.abs(hash) % this.options.shardCount;
    return this.shards[shardIndex];
  }
  
  /**
   * Set cache entry
   */
  set(key, value, ttl = this.options.ttl) {
    const shard = this.getShard(key);
    
    // Check if we need to evict
    if (this.stats.currentEntries >= this.options.maxEntries ||
        this.stats.currentSize >= this.options.maxSize) {
      this.evict();
    }
    
    // Remove old entry if exists
    const oldEntry = shard.get(key);
    if (oldEntry) {
      this.stats.currentSize -= oldEntry.size;
      this.stats.currentEntries--;
    }
    
    // Create new entry
    const entry = new CacheEntry(key, value, ttl);
    shard.set(key, entry);
    
    this.stats.currentSize += entry.size;
    this.stats.currentEntries++;
    
    this.emit('set', { key, size: entry.size });
    
    return true;
  }
  
  /**
   * Get cache entry
   */
  get(key) {
    const shard = this.getShard(key);
    const entry = shard.get(key);
    
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    
    if (entry.isExpired()) {
      this.delete(key);
      this.stats.misses++;
      return null;
    }
    
    entry.access();
    this.stats.hits++;
    
    return entry.value;
  }
  
  /**
   * Check if key exists
   */
  has(key) {
    const shard = this.getShard(key);
    const entry = shard.get(key);
    
    if (!entry || entry.isExpired()) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Delete cache entry
   */
  delete(key) {
    const shard = this.getShard(key);
    const entry = shard.get(key);
    
    if (entry) {
      shard.delete(key);
      this.stats.currentSize -= entry.size;
      this.stats.currentEntries--;
      
      this.emit('delete', { key });
      return true;
    }
    
    return false;
  }
  
  /**
   * Clear all cache
   */
  clear() {
    if (this.options.enableSharding) {
      for (const shard of this.shards) {
        shard.clear();
      }
    } else {
      this.cache.clear();
    }
    
    this.stats.currentSize = 0;
    this.stats.currentEntries = 0;
    
    this.emit('clear');
  }
  
  /**
   * Evict entries based on strategy
   */
  evict() {
    const targetSize = this.options.maxSize * this.options.warmupRatio;
    const targetEntries = this.options.maxEntries * this.options.warmupRatio;
    
    // Collect all entries
    const entries = [];
    
    if (this.options.enableSharding) {
      for (const shard of this.shards) {
        for (const entry of shard.values()) {
          entries.push(entry);
        }
      }
    } else {
      for (const entry of this.cache.values()) {
        entries.push(entry);
      }
    }
    
    // Sort by score
    entries.sort((a, b) => {
      const scoreA = a.getScore(this.options.strategy);
      const scoreB = b.getScore(this.options.strategy);
      return this.options.strategy === CacheStrategy.LFU ? 
        scoreA - scoreB : scoreB - scoreA;
    });
    
    // Evict until we reach target
    let evicted = 0;
    while ((this.stats.currentSize > targetSize || 
            this.stats.currentEntries > targetEntries) && 
           evicted < entries.length) {
      const entry = entries[evicted];
      this.delete(entry.key);
      evicted++;
      this.stats.evictions++;
    }
    
    logger.debug(`Evicted ${evicted} entries`);
  }
  
  /**
   * Cleanup expired entries
   */
  cleanup() {
    let cleaned = 0;
    
    const processEntry = (entry, shard) => {
      if (entry.isExpired()) {
        shard.delete(entry.key);
        this.stats.currentSize -= entry.size;
        this.stats.currentEntries--;
        cleaned++;
      }
    };
    
    if (this.options.enableSharding) {
      for (const shard of this.shards) {
        for (const entry of shard.values()) {
          processEntry(entry, shard);
        }
      }
    } else {
      for (const entry of this.cache.values()) {
        processEntry(entry, this.cache);
      }
    }
    
    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} expired entries`);
    }
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0 ?
      this.stats.hits / (this.stats.hits + this.stats.misses) : 0;
    
    return {
      ...this.stats,
      hitRate: (hitRate * 100).toFixed(2) + '%',
      sizeUtilization: ((this.stats.currentSize / this.options.maxSize) * 100).toFixed(2) + '%',
      entryUtilization: ((this.stats.currentEntries / this.options.maxEntries) * 100).toFixed(2) + '%'
    };
  }
  
  /**
   * Warm up cache with data
   */
  async warmup(data) {
    logger.info('Warming up cache...');
    
    let loaded = 0;
    for (const [key, value] of Object.entries(data)) {
      this.set(key, value);
      loaded++;
    }
    
    logger.info(`Cache warmed up with ${loaded} entries`);
  }
  
  /**
   * Create multi-level cache
   */
  static createMultiLevel(levels) {
    return new MultiLevelCache(levels);
  }
  
  /**
   * Destroy cache
   */
  destroy() {
    clearInterval(this.cleanupInterval);
    this.clear();
    this.removeAllListeners();
  }
}

/**
 * Multi-level cache implementation
 */
export class MultiLevelCache extends EventEmitter {
  constructor(levels = []) {
    super();
    
    this.levels = levels;
    this.stats = {
      hits: new Array(levels.length).fill(0),
      misses: 0
    };
  }
  
  async get(key) {
    for (let i = 0; i < this.levels.length; i++) {
      const value = await this.levels[i].get(key);
      
      if (value !== null) {
        this.stats.hits[i]++;
        
        // Promote to higher levels
        for (let j = 0; j < i; j++) {
          await this.levels[j].set(key, value);
        }
        
        return value;
      }
    }
    
    this.stats.misses++;
    return null;
  }
  
  async set(key, value, ttl) {
    // Set in all levels
    const promises = this.levels.map(level => level.set(key, value, ttl));
    await Promise.all(promises);
  }
  
  async delete(key) {
    // Delete from all levels
    const promises = this.levels.map(level => level.delete(key));
    await Promise.all(promises);
  }
  
  getStats() {
    return {
      levels: this.levels.map((level, i) => ({
        level: i,
        hits: this.stats.hits[i],
        stats: level.getStats()
      })),
      totalMisses: this.stats.misses
    };
  }
}

export default CacheManager;