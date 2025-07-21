/**
 * Advanced Cache Manager for Otedama
 * Multi-layer caching with LRU, TTL, and distributed support
 * 
 * Design principles:
 * - Carmack: Lock-free operations, minimal overhead
 * - Martin: Clean cache interfaces, single responsibility
 * - Pike: Simple but powerful
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';

// Cache strategies
export const CacheStrategy = {
  LRU: 'lru',        // Least Recently Used
  LFU: 'lfu',        // Least Frequently Used
  FIFO: 'fifo',      // First In First Out
  RANDOM: 'random',  // Random eviction
  TTL: 'ttl'         // Time To Live only
};

// Cache levels
export const CacheLevel = {
  L1: 'memory',      // In-memory cache (fastest)
  L2: 'shared',      // Shared memory cache
  L3: 'distributed'  // Distributed cache (Redis/Memcached)
};

/**
 * LRU Node for doubly linked list
 */
class LRUNode {
  constructor(key, value, ttl = 0) {
    this.key = key;
    this.value = value;
    this.prev = null;
    this.next = null;
    this.expires = ttl > 0 ? Date.now() + ttl : 0;
    this.hits = 1;
    this.lastAccess = Date.now();
  }
  
  isExpired() {
    return this.expires > 0 && Date.now() > this.expires;
  }
}

/**
 * LRU Cache implementation
 */
class LRUCache {
  constructor(maxSize = 1000, ttl = 0) {
    this.maxSize = maxSize;
    this.defaultTTL = ttl;
    this.size = 0;
    this.map = new Map();
    
    // Dummy head and tail for easier operations
    this.head = new LRUNode(null, null);
    this.tail = new LRUNode(null, null);
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }
  
  get(key) {
    const node = this.map.get(key);
    
    if (!node) {
      return undefined;
    }
    
    if (node.isExpired()) {
      this.remove(node);
      return undefined;
    }
    
    // Move to front (most recently used)
    this.moveToFront(node);
    node.hits++;
    node.lastAccess = Date.now();
    
    return node.value;
  }
  
  set(key, value, ttl = this.defaultTTL) {
    let node = this.map.get(key);
    
    if (node) {
      // Update existing
      node.value = value;
      node.expires = ttl > 0 ? Date.now() + ttl : 0;
      this.moveToFront(node);
    } else {
      // Add new
      node = new LRUNode(key, value, ttl);
      this.map.set(key, node);
      this.addToFront(node);
      this.size++;
      
      // Evict if necessary
      if (this.size > this.maxSize) {
        this.evictLRU();
      }
    }
  }
  
  has(key) {
    const node = this.map.get(key);
    return node && !node.isExpired();
  }
  
  delete(key) {
    const node = this.map.get(key);
    if (node) {
      this.remove(node);
    }
  }
  
  clear() {
    this.map.clear();
    this.size = 0;
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }
  
  // Internal methods
  addToFront(node) {
    node.prev = this.head;
    node.next = this.head.next;
    this.head.next.prev = node;
    this.head.next = node;
  }
  
  moveToFront(node) {
    this.removeFromList(node);
    this.addToFront(node);
  }
  
  removeFromList(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }
  
  remove(node) {
    this.removeFromList(node);
    this.map.delete(node.key);
    this.size--;
  }
  
  evictLRU() {
    const lru = this.tail.prev;
    if (lru !== this.head) {
      this.remove(lru);
    }
  }
  
  getStats() {
    let totalHits = 0;
    let expiredCount = 0;
    
    for (const node of this.map.values()) {
      totalHits += node.hits;
      if (node.isExpired()) {
        expiredCount++;
      }
    }
    
    return {
      size: this.size,
      maxSize: this.maxSize,
      utilization: (this.size / this.maxSize * 100).toFixed(2) + '%',
      totalHits,
      expiredCount
    };
  }
}

/**
 * Multi-layer cache manager
 */
export class CacheManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // L1 Cache (Memory)
      l1: {
        enabled: options.l1?.enabled !== false,
        maxSize: options.l1?.maxSize || 10000,
        ttl: options.l1?.ttl || 300000, // 5 minutes
        strategy: options.l1?.strategy || CacheStrategy.LRU
      },
      
      // L2 Cache (Shared Memory)
      l2: {
        enabled: options.l2?.enabled || false,
        maxSize: options.l2?.maxSize || 100000,
        ttl: options.l2?.ttl || 3600000, // 1 hour
        strategy: options.l2?.strategy || CacheStrategy.LRU
      },
      
      // L3 Cache (Distributed)
      l3: {
        enabled: options.l3?.enabled || false,
        client: options.l3?.client, // Redis/Memcached client
        ttl: options.l3?.ttl || 86400000, // 24 hours
        prefix: options.l3?.prefix || 'otedama:'
      },
      
      // General settings
      namespace: options.namespace || 'default',
      compression: options.compression || false,
      serialization: options.serialization || 'json',
      
      // Stats
      enableStats: options.enableStats !== false,
      statsInterval: options.statsInterval || 60000 // 1 minute
    };
    
    // Initialize caches
    this.caches = new Map();
    
    if (this.config.l1.enabled) {
      this.caches.set(CacheLevel.L1, new LRUCache(
        this.config.l1.maxSize,
        this.config.l1.ttl
      ));
    }
    
    if (this.config.l2.enabled) {
      // Shared memory cache would go here
      // For now, use another LRU cache
      this.caches.set(CacheLevel.L2, new LRUCache(
        this.config.l2.maxSize,
        this.config.l2.ttl
      ));
    }
    
    // Statistics
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
      errors: 0
    };
    
    // Start stats collection
    if (this.config.enableStats) {
      this.statsTimer = setInterval(() => this.collectStats(), this.config.statsInterval);
    }
  }
  
  /**
   * Generate cache key
   */
  generateKey(key, namespace = this.config.namespace) {
    if (typeof key === 'object') {
      key = JSON.stringify(key);
    }
    return `${namespace}:${key}`;
  }
  
  /**
   * Get value from cache
   */
  async get(key, options = {}) {
    const cacheKey = this.generateKey(key, options.namespace);
    
    // Try L1 first
    if (this.caches.has(CacheLevel.L1)) {
      const value = this.caches.get(CacheLevel.L1).get(cacheKey);
      if (value !== undefined) {
        this.stats.hits++;
        this.emit('hit', { level: CacheLevel.L1, key: cacheKey });
        return this.deserialize(value);
      }
    }
    
    // Try L2
    if (this.caches.has(CacheLevel.L2)) {
      const value = this.caches.get(CacheLevel.L2).get(cacheKey);
      if (value !== undefined) {
        this.stats.hits++;
        this.emit('hit', { level: CacheLevel.L2, key: cacheKey });
        
        // Promote to L1
        if (this.caches.has(CacheLevel.L1)) {
          this.caches.get(CacheLevel.L1).set(cacheKey, value);
        }
        
        return this.deserialize(value);
      }
    }
    
    // Try L3
    if (this.config.l3.enabled && this.config.l3.client) {
      try {
        const value = await this.getFromDistributed(cacheKey);
        if (value !== undefined) {
          this.stats.hits++;
          this.emit('hit', { level: CacheLevel.L3, key: cacheKey });
          
          // Promote to L1 and L2
          const deserialized = this.deserialize(value);
          this.promoteToUpperLayers(cacheKey, value);
          
          return deserialized;
        }
      } catch (error) {
        this.stats.errors++;
        this.emit('error', { level: CacheLevel.L3, key: cacheKey, error });
      }
    }
    
    this.stats.misses++;
    this.emit('miss', { key: cacheKey });
    return undefined;
  }
  
  /**
   * Set value in cache
   */
  async set(key, value, options = {}) {
    const cacheKey = this.generateKey(key, options.namespace);
    const ttl = options.ttl || this.config.l1.ttl;
    const serialized = this.serialize(value);
    
    this.stats.sets++;
    
    // Set in L1
    if (this.caches.has(CacheLevel.L1)) {
      this.caches.get(CacheLevel.L1).set(cacheKey, serialized, ttl);
    }
    
    // Set in L2
    if (this.caches.has(CacheLevel.L2)) {
      this.caches.get(CacheLevel.L2).set(cacheKey, serialized, ttl);
    }
    
    // Set in L3
    if (this.config.l3.enabled && this.config.l3.client) {
      try {
        await this.setInDistributed(cacheKey, serialized, ttl);
      } catch (error) {
        this.stats.errors++;
        this.emit('error', { level: CacheLevel.L3, key: cacheKey, error });
      }
    }
    
    this.emit('set', { key: cacheKey, ttl });
  }
  
  /**
   * Delete value from cache
   */
  async delete(key, options = {}) {
    const cacheKey = this.generateKey(key, options.namespace);
    
    this.stats.deletes++;
    
    // Delete from all levels
    if (this.caches.has(CacheLevel.L1)) {
      this.caches.get(CacheLevel.L1).delete(cacheKey);
    }
    
    if (this.caches.has(CacheLevel.L2)) {
      this.caches.get(CacheLevel.L2).delete(cacheKey);
    }
    
    if (this.config.l3.enabled && this.config.l3.client) {
      try {
        await this.deleteFromDistributed(cacheKey);
      } catch (error) {
        this.stats.errors++;
        this.emit('error', { level: CacheLevel.L3, key: cacheKey, error });
      }
    }
    
    this.emit('delete', { key: cacheKey });
  }
  
  /**
   * Clear entire cache
   */
  async clear(options = {}) {
    const namespace = options.namespace || this.config.namespace;
    
    // Clear memory caches
    for (const cache of this.caches.values()) {
      if (cache.clear) {
        cache.clear();
      }
    }
    
    // Clear distributed cache
    if (this.config.l3.enabled && this.config.l3.client) {
      try {
        await this.clearDistributed(namespace);
      } catch (error) {
        this.stats.errors++;
        this.emit('error', { level: CacheLevel.L3, error });
      }
    }
    
    this.emit('clear', { namespace });
  }
  
  /**
   * Get or set with loader function
   */
  async getOrSet(key, loader, options = {}) {
    // Try to get from cache
    const cached = await this.get(key, options);
    if (cached !== undefined) {
      return cached;
    }
    
    // Load value
    const value = await loader();
    
    // Store in cache
    await this.set(key, value, options);
    
    return value;
  }
  
  /**
   * Memoize function
   */
  memoize(fn, options = {}) {
    const namespace = options.namespace || fn.name || 'memoized';
    
    return async (...args) => {
      const key = options.keyGenerator ? 
        options.keyGenerator(...args) : 
        createHash('md5').update(JSON.stringify(args)).digest('hex');
      
      return this.getOrSet(
        key,
        () => fn(...args),
        { ...options, namespace }
      );
    };
  }
  
  /**
   * Wrap function with cache-aside pattern
   */
  wrap(fn, keyGenerator, options = {}) {
    return async (...args) => {
      const key = keyGenerator(...args);
      
      // Try cache first
      const cached = await this.get(key, options);
      if (cached !== undefined) {
        return cached;
      }
      
      // Execute function
      const result = await fn(...args);
      
      // Cache result
      await this.set(key, result, options);
      
      return result;
    };
  }
  
  /**
   * Batch get
   */
  async mget(keys, options = {}) {
    const results = {};
    
    for (const key of keys) {
      results[key] = await this.get(key, options);
    }
    
    return results;
  }
  
  /**
   * Batch set
   */
  async mset(entries, options = {}) {
    const promises = [];
    
    for (const [key, value] of Object.entries(entries)) {
      promises.push(this.set(key, value, options));
    }
    
    await Promise.all(promises);
  }
  
  /**
   * Serialization
   */
  serialize(value) {
    switch (this.config.serialization) {
      case 'json':
        return JSON.stringify(value);
      case 'buffer':
        return Buffer.from(JSON.stringify(value));
      default:
        return value;
    }
  }
  
  deserialize(value) {
    switch (this.config.serialization) {
      case 'json':
        return JSON.parse(value);
      case 'buffer':
        return JSON.parse(value.toString());
      default:
        return value;
    }
  }
  
  /**
   * Distributed cache operations
   */
  async getFromDistributed(key) {
    const client = this.config.l3.client;
    const fullKey = this.config.l3.prefix + key;
    
    if (client.get) {
      // Redis-like client
      return await client.get(fullKey);
    } else if (client.get) {
      // Memcached-like client
      return await new Promise((resolve, reject) => {
        client.get(fullKey, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });
    }
  }
  
  async setInDistributed(key, value, ttl) {
    const client = this.config.l3.client;
    const fullKey = this.config.l3.prefix + key;
    const ttlSeconds = Math.floor(ttl / 1000);
    
    if (client.setex) {
      // Redis-like client
      return await client.setex(fullKey, ttlSeconds, value);
    } else if (client.set) {
      // Memcached-like client
      return await new Promise((resolve, reject) => {
        client.set(fullKey, value, ttlSeconds, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
  
  async deleteFromDistributed(key) {
    const client = this.config.l3.client;
    const fullKey = this.config.l3.prefix + key;
    
    if (client.del) {
      // Redis-like client
      return await client.del(fullKey);
    } else if (client.delete) {
      // Memcached-like client
      return await new Promise((resolve, reject) => {
        client.delete(fullKey, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
  
  async clearDistributed(namespace) {
    const client = this.config.l3.client;
    const pattern = `${this.config.l3.prefix}${namespace}:*`;
    
    if (client.keys && client.del) {
      // Redis-like client
      const keys = await client.keys(pattern);
      if (keys.length > 0) {
        await client.del(...keys);
      }
    }
    // Memcached doesn't support pattern-based deletion
  }
  
  /**
   * Promote value to upper cache layers
   */
  promoteToUpperLayers(key, value) {
    if (this.caches.has(CacheLevel.L1)) {
      this.caches.get(CacheLevel.L1).set(key, value);
    }
    
    if (this.caches.has(CacheLevel.L2)) {
      this.caches.get(CacheLevel.L2).set(key, value);
    }
  }
  
  /**
   * Collect statistics
   */
  collectStats() {
    const stats = {
      ...this.stats,
      hitRate: this.stats.hits + this.stats.misses > 0 ?
        (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2) + '%' : '0%',
      layers: {}
    };
    
    // Get stats from each layer
    for (const [level, cache] of this.caches) {
      if (cache.getStats) {
        stats.layers[level] = cache.getStats();
      }
    }
    
    this.emit('stats', stats);
    return stats;
  }
  
  /**
   * Get current statistics
   */
  getStats() {
    return this.collectStats();
  }
  
  /**
   * Shutdown cache manager
   */
  shutdown() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
    }
    
    this.caches.clear();
    this.emit('shutdown');
  }
}

// Cache decorators for class methods
export function cacheable(options = {}) {
  return function(target, propertyKey, descriptor) {
    const originalMethod = descriptor.value;
    const cacheManager = options.cacheManager || globalCacheManager;
    
    descriptor.value = async function(...args) {
      const key = options.keyGenerator ?
        options.keyGenerator.call(this, ...args) :
        `${target.constructor.name}:${propertyKey}:${JSON.stringify(args)}`;
      
      return cacheManager.getOrSet(
        key,
        () => originalMethod.apply(this, args),
        options
      );
    };
    
    return descriptor;
  };
}

// Global cache manager instance
export const globalCacheManager = new CacheManager({
  l1: {
    maxSize: 10000,
    ttl: 300000 // 5 minutes
  }
});

// Factory function
export function createCacheManager(options) {
  return new CacheManager(options);
}

// Pre-configured cache instances for different domains
export const CacheFactory = {
  createPoolCache() {
    return new CacheManager({
      namespace: 'pool',
      maxSize: 256 * 1024 * 1024, // 256MB
      ttl: 300000, // 5 minutes
      strategy: CacheStrategy.LRU,
      l1: {
        enabled: true,
        maxSize: 100 * 1024 * 1024 // 100MB
      },
      l2: {
        enabled: true,
        maxSize: 156 * 1024 * 1024 // 156MB
      }
    });
  },
  
  createDexCache() {
    return new CacheManager({
      namespace: 'dex',
      maxSize: 128 * 1024 * 1024, // 128MB
      ttl: 60000, // 1 minute
      strategy: CacheStrategy.LRU,
      l1: {
        enabled: true,
        maxSize: 64 * 1024 * 1024 // 64MB
      },
      l2: {
        enabled: true,
        maxSize: 64 * 1024 * 1024 // 64MB
      }
    });
  },
  
  createDefiCache() {
    return new CacheManager({
      namespace: 'defi',
      maxSize: 64 * 1024 * 1024, // 64MB
      ttl: 180000, // 3 minutes
      strategy: CacheStrategy.LRU,
      l1: {
        enabled: true,
        maxSize: 32 * 1024 * 1024 // 32MB
      },
      l2: {
        enabled: true,
        maxSize: 32 * 1024 * 1024 // 32MB
      }
    });
  },
  
  createApiCache() {
    return new CacheManager({
      namespace: 'api',
      maxSize: 32 * 1024 * 1024, // 32MB
      ttl: 30000, // 30 seconds
      strategy: CacheStrategy.LRU,
      l1: {
        enabled: true,
        maxSize: 20 * 1024 * 1024 // 20MB
      },
      l2: {
        enabled: true,
        maxSize: 12 * 1024 * 1024 // 12MB
      }
    });
  }
};

// MemoryCache class for backward compatibility
export class MemoryCache extends CacheManager {
  constructor(options = {}) {
    super({
      ...options,
      l1: { enabled: true, maxSize: options.maxSize || 50 * 1024 * 1024 },
      l2: { enabled: false },
      l3: { enabled: false }
    });
  }
}

// Default export
export default CacheManager;
