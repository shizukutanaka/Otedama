/**
 * Redis-Compatible Caching Layer - Otedama
 * High-performance caching with Redis or in-memory fallback
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import { LRUCache } from '../core/performance.js';

const logger = createLogger('CacheLayer');

/**
 * Cache client interface
 */
class CacheClient {
  async get(key) { throw new Error('Not implemented'); }
  async set(key, value, ttl) { throw new Error('Not implemented'); }
  async del(key) { throw new Error('Not implemented'); }
  async exists(key) { throw new Error('Not implemented'); }
  async expire(key, ttl) { throw new Error('Not implemented'); }
  async ttl(key) { throw new Error('Not implemented'); }
  async mget(keys) { throw new Error('Not implemented'); }
  async mset(keyValues) { throw new Error('Not implemented'); }
  async incr(key) { throw new Error('Not implemented'); }
  async decr(key) { throw new Error('Not implemented'); }
  async hset(key, field, value) { throw new Error('Not implemented'); }
  async hget(key, field) { throw new Error('Not implemented'); }
  async hgetall(key) { throw new Error('Not implemented'); }
  async hdel(key, field) { throw new Error('Not implemented'); }
  async sadd(key, member) { throw new Error('Not implemented'); }
  async srem(key, member) { throw new Error('Not implemented'); }
  async smembers(key) { throw new Error('Not implemented'); }
  async sismember(key, member) { throw new Error('Not implemented'); }
  async zadd(key, score, member) { throw new Error('Not implemented'); }
  async zrange(key, start, stop) { throw new Error('Not implemented'); }
  async zrem(key, member) { throw new Error('Not implemented'); }
  async flushall() { throw new Error('Not implemented'); }
  async ping() { throw new Error('Not implemented'); }
}

/**
 * In-memory cache client (Redis-compatible API)
 */
class InMemoryCacheClient extends CacheClient {
  constructor(options = {}) {
    super();
    
    this.maxSize = options.maxSize || 10000;
    this.defaultTTL = options.defaultTTL || 3600000; // 1 hour
    
    // Different data structures
    this.strings = new Map();
    this.hashes = new Map();
    this.sets = new Map();
    this.sortedSets = new Map();
    this.expires = new Map();
    
    // LRU eviction
    this.lru = new LRUCache(this.maxSize);
    
    // Start cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000); // Every minute
  }
  
  async get(key) {
    this.checkExpired(key);
    const value = this.strings.get(key);
    if (value !== undefined) {
      this.lru.get(key); // Update LRU
    }
    return value || null;
  }
  
  async set(key, value, ttl) {
    this.strings.set(key, String(value));
    this.lru.set(key, true);
    
    if (ttl) {
      this.expires.set(key, Date.now() + ttl * 1000);
    }
    
    this.evictIfNeeded();
    return 'OK';
  }
  
  async del(key) {
    const deleted = this.strings.delete(key) || 
                  this.hashes.delete(key) ||
                  this.sets.delete(key) ||
                  this.sortedSets.delete(key);
    
    this.expires.delete(key);
    this.lru.delete(key);
    
    return deleted ? 1 : 0;
  }
  
  async exists(key) {
    this.checkExpired(key);
    return this.strings.has(key) || 
           this.hashes.has(key) ||
           this.sets.has(key) ||
           this.sortedSets.has(key) ? 1 : 0;
  }
  
  async expire(key, ttl) {
    if (await this.exists(key)) {
      this.expires.set(key, Date.now() + ttl * 1000);
      return 1;
    }
    return 0;
  }
  
  async ttl(key) {
    const expireTime = this.expires.get(key);
    if (!expireTime) return -1;
    
    const ttl = Math.floor((expireTime - Date.now()) / 1000);
    return ttl > 0 ? ttl : -2;
  }
  
  async mget(keys) {
    return Promise.all(keys.map(key => this.get(key)));
  }
  
  async mset(keyValues) {
    for (const [key, value] of Object.entries(keyValues)) {
      await this.set(key, value);
    }
    return 'OK';
  }
  
  async incr(key) {
    const value = parseInt(await this.get(key) || '0');
    const newValue = value + 1;
    await this.set(key, newValue);
    return newValue;
  }
  
  async decr(key) {
    const value = parseInt(await this.get(key) || '0');
    const newValue = value - 1;
    await this.set(key, newValue);
    return newValue;
  }
  
  async hset(key, field, value) {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    
    const isNew = !hash.has(field);
    hash.set(field, String(value));
    this.lru.set(key, true);
    
    return isNew ? 1 : 0;
  }
  
  async hget(key, field) {
    this.checkExpired(key);
    const hash = this.hashes.get(key);
    return hash ? (hash.get(field) || null) : null;
  }
  
  async hgetall(key) {
    this.checkExpired(key);
    const hash = this.hashes.get(key);
    if (!hash) return {};
    
    const result = {};
    for (const [field, value] of hash) {
      result[field] = value;
    }
    return result;
  }
  
  async hdel(key, field) {
    const hash = this.hashes.get(key);
    if (!hash) return 0;
    
    const deleted = hash.delete(field);
    if (hash.size === 0) {
      this.hashes.delete(key);
    }
    
    return deleted ? 1 : 0;
  }
  
  async sadd(key, member) {
    let set = this.sets.get(key);
    if (!set) {
      set = new Set();
      this.sets.set(key, set);
    }
    
    const sizeBefore = set.size;
    set.add(String(member));
    this.lru.set(key, true);
    
    return set.size - sizeBefore;
  }
  
  async srem(key, member) {
    const set = this.sets.get(key);
    if (!set) return 0;
    
    const deleted = set.delete(String(member));
    if (set.size === 0) {
      this.sets.delete(key);
    }
    
    return deleted ? 1 : 0;
  }
  
  async smembers(key) {
    this.checkExpired(key);
    const set = this.sets.get(key);
    return set ? Array.from(set) : [];
  }
  
  async sismember(key, member) {
    this.checkExpired(key);
    const set = this.sets.get(key);
    return set && set.has(String(member)) ? 1 : 0;
  }
  
  async zadd(key, score, member) {
    let zset = this.sortedSets.get(key);
    if (!zset) {
      zset = new Map();
      this.sortedSets.set(key, zset);
    }
    
    const isNew = !zset.has(member);
    zset.set(String(member), Number(score));
    this.lru.set(key, true);
    
    return isNew ? 1 : 0;
  }
  
  async zrange(key, start, stop) {
    this.checkExpired(key);
    const zset = this.sortedSets.get(key);
    if (!zset) return [];
    
    // Sort by score
    const sorted = Array.from(zset.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);
    
    // Handle negative indices
    if (stop < 0) stop = sorted.length + stop;
    
    return sorted.slice(start, stop + 1);
  }
  
  async zrem(key, member) {
    const zset = this.sortedSets.get(key);
    if (!zset) return 0;
    
    const deleted = zset.delete(String(member));
    if (zset.size === 0) {
      this.sortedSets.delete(key);
    }
    
    return deleted ? 1 : 0;
  }
  
  async flushall() {
    this.strings.clear();
    this.hashes.clear();
    this.sets.clear();
    this.sortedSets.clear();
    this.expires.clear();
    this.lru.clear();
    return 'OK';
  }
  
  async ping() {
    return 'PONG';
  }
  
  checkExpired(key) {
    const expireTime = this.expires.get(key);
    if (expireTime && Date.now() > expireTime) {
      this.del(key);
      return true;
    }
    return false;
  }
  
  cleanup() {
    const now = Date.now();
    for (const [key, expireTime] of this.expires) {
      if (now > expireTime) {
        this.del(key);
      }
    }
  }
  
  evictIfNeeded() {
    const totalSize = this.strings.size + 
                     this.hashes.size + 
                     this.sets.size + 
                     this.sortedSets.size;
    
    if (totalSize > this.maxSize) {
      // Evict least recently used
      const evicted = this.lru.evict();
      if (evicted) {
        this.del(evicted);
      }
    }
  }
  
  shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }
}

/**
 * Cache Layer with hot data optimization
 */
export class RedisCacheLayer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      type: options.type || 'memory', // 'redis' or 'memory'
      redis: options.redis || {},
      memory: options.memory || {},
      hotDataTTL: options.hotDataTTL || 300, // 5 minutes
      warmDataTTL: options.warmDataTTL || 3600, // 1 hour
      coldDataTTL: options.coldDataTTL || 86400, // 24 hours
      hotDataThreshold: options.hotDataThreshold || 10, // Access count
      compressionThreshold: options.compressionThreshold || 1024, // Bytes
      enableCompression: options.enableCompression !== false,
      ...options
    };
    
    this.client = null;
    this.accessCounts = new Map();
    this.compressionEnabled = this.config.enableCompression;
    
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      compressions: 0,
      decompressions: 0,
      errors: 0
    };
  }
  
  /**
   * Initialize cache layer
   */
  async initialize() {
    logger.info(`Initializing cache layer (type: ${this.config.type})...`);
    
    try {
      if (this.config.type === 'redis') {
        // In production, would use actual Redis client
        logger.warn('Redis client not implemented, falling back to in-memory');
        this.client = new InMemoryCacheClient(this.config.memory);
      } else {
        this.client = new InMemoryCacheClient(this.config.memory);
      }
      
      // Test connection
      await this.client.ping();
      
      logger.info('Cache layer initialized successfully');
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Cache initialization failed:', error);
      throw error;
    }
  }
  
  /**
   * Get value with hot data tracking
   */
  async get(key) {
    try {
      const value = await this.client.get(key);
      
      if (value !== null) {
        this.stats.hits++;
        this.trackAccess(key);
        
        // Decompress if needed
        if (this.isCompressed(value)) {
          return this.decompress(value);
        }
        
        return value;
      }
      
      this.stats.misses++;
      return null;
      
    } catch (error) {
      logger.error(`Cache get error for key ${key}:`, error);
      this.stats.errors++;
      return null;
    }
  }
  
  /**
   * Set value with automatic TTL based on access pattern
   */
  async set(key, value, ttl) {
    try {
      // Determine TTL based on access pattern
      if (!ttl) {
        ttl = this.calculateTTL(key);
      }
      
      // Compress if needed
      let storedValue = value;
      if (this.shouldCompress(value)) {
        storedValue = this.compress(value);
      }
      
      await this.client.set(key, storedValue, ttl);
      this.stats.sets++;
      
      return true;
      
    } catch (error) {
      logger.error(`Cache set error for key ${key}:`, error);
      this.stats.errors++;
      return false;
    }
  }
  
  /**
   * Delete value
   */
  async del(key) {
    try {
      const result = await this.client.del(key);
      this.stats.deletes++;
      this.accessCounts.delete(key);
      return result;
      
    } catch (error) {
      logger.error(`Cache delete error for key ${key}:`, error);
      this.stats.errors++;
      return 0;
    }
  }
  
  /**
   * Get multiple values
   */
  async mget(keys) {
    try {
      const values = await this.client.mget(keys);
      
      // Track access and decompress
      return values.map((value, index) => {
        if (value !== null) {
          this.stats.hits++;
          this.trackAccess(keys[index]);
          
          if (this.isCompressed(value)) {
            return this.decompress(value);
          }
        } else {
          this.stats.misses++;
        }
        
        return value;
      });
      
    } catch (error) {
      logger.error('Cache mget error:', error);
      this.stats.errors++;
      return keys.map(() => null);
    }
  }
  
  /**
   * Set multiple values
   */
  async mset(keyValues) {
    try {
      // Compress values if needed
      const compressed = {};
      for (const [key, value] of Object.entries(keyValues)) {
        compressed[key] = this.shouldCompress(value) 
          ? this.compress(value) 
          : value;
      }
      
      await this.client.mset(compressed);
      this.stats.sets += Object.keys(keyValues).length;
      
      return true;
      
    } catch (error) {
      logger.error('Cache mset error:', error);
      this.stats.errors++;
      return false;
    }
  }
  
  /**
   * Cache miner data (hot data)
   */
  async cacheMinerData(minerId, data) {
    const key = `miner:${minerId}`;
    return this.set(key, JSON.stringify(data), this.config.hotDataTTL);
  }
  
  /**
   * Get miner data
   */
  async getMinerData(minerId) {
    const key = `miner:${minerId}`;
    const data = await this.get(key);
    return data ? JSON.parse(data) : null;
  }
  
  /**
   * Cache share data (warm data)
   */
  async cacheShareData(shareId, data) {
    const key = `share:${shareId}`;
    return this.set(key, JSON.stringify(data), this.config.warmDataTTL);
  }
  
  /**
   * Cache block data (cold data)
   */
  async cacheBlockData(blockHeight, data) {
    const key = `block:${blockHeight}`;
    return this.set(key, JSON.stringify(data), this.config.coldDataTTL);
  }
  
  /**
   * Cache pool stats (hot data)
   */
  async cachePoolStats(stats) {
    return this.set('pool:stats', JSON.stringify(stats), 60); // 1 minute
  }
  
  /**
   * Get pool stats
   */
  async getPoolStats() {
    const data = await this.get('pool:stats');
    return data ? JSON.parse(data) : null;
  }
  
  /**
   * Track access for hot data detection
   */
  trackAccess(key) {
    const count = (this.accessCounts.get(key) || 0) + 1;
    this.accessCounts.set(key, count);
    
    // Promote to hot data if threshold reached
    if (count === this.config.hotDataThreshold) {
      this.promoteToHotData(key);
    }
  }
  
  /**
   * Calculate TTL based on access pattern
   */
  calculateTTL(key) {
    const accessCount = this.accessCounts.get(key) || 0;
    
    if (accessCount >= this.config.hotDataThreshold) {
      return this.config.hotDataTTL;
    } else if (accessCount > 0) {
      return this.config.warmDataTTL;
    } else {
      return this.config.coldDataTTL;
    }
  }
  
  /**
   * Promote key to hot data
   */
  async promoteToHotData(key) {
    // Update TTL for hot data
    await this.client.expire(key, this.config.hotDataTTL);
    
    logger.debug(`Promoted ${key} to hot data`);
    this.emit('hot-data:promoted', key);
  }
  
  /**
   * Check if value should be compressed
   */
  shouldCompress(value) {
    return this.compressionEnabled && 
           typeof value === 'string' && 
           value.length > this.config.compressionThreshold;
  }
  
  /**
   * Compress value
   */
  compress(value) {
    // Simple compression marker - in production would use actual compression
    this.stats.compressions++;
    return `COMPRESSED:${value}`;
  }
  
  /**
   * Decompress value
   */
  decompress(value) {
    this.stats.decompressions++;
    return value.substring(11); // Remove 'COMPRESSED:' prefix
  }
  
  /**
   * Check if value is compressed
   */
  isCompressed(value) {
    return typeof value === 'string' && value.startsWith('COMPRESSED:');
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : 0;
    
    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      hotDataKeys: Array.from(this.accessCounts.entries())
        .filter(([_, count]) => count >= this.config.hotDataThreshold)
        .length
    };
  }
  
  /**
   * Clear all cache
   */
  async flush() {
    await this.client.flushall();
    this.accessCounts.clear();
    logger.info('Cache flushed');
  }
  
  /**
   * Shutdown cache
   */
  async shutdown() {
    logger.info('Shutting down cache layer...');
    
    if (this.client && this.client.shutdown) {
      this.client.shutdown();
    }
    
    this.removeAllListeners();
    logger.info('Cache layer shutdown complete');
  }
}

/**
 * Create cache layer
 */
export function createCacheLayer(options) {
  return new RedisCacheLayer(options);
}

export default {
  RedisCacheLayer,
  InMemoryCacheClient,
  createCacheLayer
};