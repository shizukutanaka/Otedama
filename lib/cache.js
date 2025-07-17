/**
 * Advanced Caching System for Otedama
 * High-performance multi-tier caching with intelligent eviction
 * Following John Carmack's performance principles
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { performance } from 'perf_hooks';

/**
 * Cache storage backends
 */
export const CacheBackend = {
  MEMORY: 'memory',
  REDIS: 'redis',
  FILE: 'file',
  HYBRID: 'hybrid'
};

/**
 * Cache eviction policies
 */
export const EvictionPolicy = {
  LRU: 'lru',      // Least Recently Used
  LFU: 'lfu',      // Least Frequently Used
  FIFO: 'fifo',    // First In First Out
  TTL: 'ttl'       // Time To Live based
};

/**
 * Memory cache implementation
 */
class MemoryCache {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 100 * 1024 * 1024; // 100MB
    this.maxItems = options.maxItems || 10000;
    this.evictionPolicy = options.evictionPolicy || EvictionPolicy.LRU;
    
    this.cache = new Map();
    this.metadata = new Map();
    this.size = 0;
    
    // LRU tracking
    this.accessOrder = [];
    
    // LFU tracking
    this.frequencies = new Map();
  }
  
  get(key) {
    if (!this.cache.has(key)) {
      return null;
    }
    
    const item = this.cache.get(key);
    const meta = this.metadata.get(key);
    
    // Check TTL
    if (meta.ttl && Date.now() > meta.expires) {
      this.delete(key);
      return null;
    }
    
    // Update access tracking
    this.updateAccess(key);
    
    return item.value;
  }
  
  set(key, value, options = {}) {
    const size = this.calculateSize(value);
    
    // Check if we need to evict
    while (this.size + size > this.maxSize || this.cache.size >= this.maxItems) {
      this.evict();
    }
    
    // Store item
    this.cache.set(key, { value, size });
    
    // Store metadata
    const meta = {
      created: Date.now(),
      accessed: Date.now(),
      size,
      ttl: options.ttl,
      expires: options.ttl ? Date.now() + options.ttl : null
    };
    
    this.metadata.set(key, meta);
    this.size += size;
    
    // Initialize access tracking
    this.updateAccess(key);
  }
  
  delete(key) {
    if (!this.cache.has(key)) {
      return false;
    }
    
    const item = this.cache.get(key);
    this.size -= item.size;
    
    this.cache.delete(key);
    this.metadata.delete(key);
    this.frequencies.delete(key);
    
    // Remove from access order
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    
    return true;
  }
  
  clear() {
    this.cache.clear();
    this.metadata.clear();
    this.frequencies.clear();
    this.accessOrder = [];
    this.size = 0;
  }
  
  updateAccess(key) {
    const meta = this.metadata.get(key);
    if (meta) {
      meta.accessed = Date.now();
    }
    
    // Update LRU order
    if (this.evictionPolicy === EvictionPolicy.LRU) {
      const index = this.accessOrder.indexOf(key);
      if (index > -1) {
        this.accessOrder.splice(index, 1);
      }
      this.accessOrder.push(key);
    }
    
    // Update LFU frequency
    if (this.evictionPolicy === EvictionPolicy.LFU) {
      const freq = this.frequencies.get(key) || 0;
      this.frequencies.set(key, freq + 1);
    }
  }
  
  evict() {
    let keyToEvict;
    
    switch (this.evictionPolicy) {
      case EvictionPolicy.LRU:
        keyToEvict = this.accessOrder[0];
        break;
        
      case EvictionPolicy.LFU:
        keyToEvict = this.findLFU();
        break;
        
      case EvictionPolicy.FIFO:
        keyToEvict = this.findOldest();
        break;
        
      case EvictionPolicy.TTL:
        keyToEvict = this.findExpired() || this.findOldest();
        break;
        
      default:
        keyToEvict = this.cache.keys().next().value;
    }
    
    if (keyToEvict) {
      this.delete(keyToEvict);
    }
  }
  
  findLFU() {
    let minFreq = Infinity;
    let lfuKey = null;
    
    for (const [key, freq] of this.frequencies) {
      if (freq < minFreq) {
        minFreq = freq;
        lfuKey = key;
      }
    }
    
    return lfuKey;
  }
  
  findOldest() {
    let oldest = Infinity;
    let oldestKey = null;
    
    for (const [key, meta] of this.metadata) {
      if (meta.created < oldest) {
        oldest = meta.created;
        oldestKey = key;
      }
    }
    
    return oldestKey;
  }
  
  findExpired() {
    const now = Date.now();
    
    for (const [key, meta] of this.metadata) {
      if (meta.expires && meta.expires < now) {
        return key;
      }
    }
    
    return null;
  }
  
  calculateSize(value) {
    // Rough estimation of object size
    if (typeof value === 'string') {
      return value.length * 2; // 2 bytes per char
    } else if (Buffer.isBuffer(value)) {
      return value.length;
    } else {
      return JSON.stringify(value).length * 2;
    }
  }
  
  getStats() {
    return {
      items: this.cache.size,
      size: this.size,
      maxSize: this.maxSize,
      utilization: (this.size / this.maxSize) * 100
    };
  }
}

/**
 * Cache Manager
 */
export class CacheManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      backend: options.backend || CacheBackend.MEMORY,
      defaultTTL: options.defaultTTL || 3600000, // 1 hour
      namespace: options.namespace || 'otedama',
      compression: options.compression !== false,
      ...options
    };
    
    this.logger = options.logger || new Logger();
    this.caches = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0
    };
    
    // Initialize backend
    this.initializeBackend();
  }
  
  initializeBackend() {
    switch (this.options.backend) {
      case CacheBackend.MEMORY:
        this.backend = new MemoryCache(this.options);
        break;
        
      case CacheBackend.REDIS:
        // TODO: Implement Redis backend
        this.logger.warn('Redis backend not implemented, falling back to memory');
        this.backend = new MemoryCache(this.options);
        break;
        
      case CacheBackend.FILE:
        // TODO: Implement file backend
        this.logger.warn('File backend not implemented, falling back to memory');
        this.backend = new MemoryCache(this.options);
        break;
        
      case CacheBackend.HYBRID:
        // TODO: Implement hybrid backend
        this.logger.warn('Hybrid backend not implemented, falling back to memory');
        this.backend = new MemoryCache(this.options);
        break;
        
      default:
        this.backend = new MemoryCache(this.options);
    }
  }
  
  /**
   * Get cached value
   */
  async get(key, options = {}) {
    const fullKey = this.makeKey(key, options.namespace);
    const startTime = Date.now();
    
    try {
      const value = await this.backend.get(fullKey);
      
      if (value !== null) {
        this.stats.hits++;
        this.emit('hit', { key, duration: Date.now() - startTime });
        
        // Decompress if needed
        if (this.options.compression && value._compressed) {
          return await this.decompress(value.data);
        }
        
        return value;
      }
      
      this.stats.misses++;
      this.emit('miss', { key, duration: Date.now() - startTime });
      
      // Call loader function if provided
      if (options.loader) {
        return await this.loadAndCache(key, options);
      }
      
      return null;
    } catch (error) {
      this.logger.error('Cache get error', { key, error });
      return null;
    }
  }
  
  /**
   * Set cached value
   */
  async set(key, value, options = {}) {
    const fullKey = this.makeKey(key, options.namespace);
    const ttl = options.ttl || this.options.defaultTTL;
    
    try {
      // Compress if needed
      let storedValue = value;
      if (this.options.compression && this.shouldCompress(value)) {
        storedValue = {
          _compressed: true,
          data: await this.compress(value)
        };
      }
      
      await this.backend.set(fullKey, storedValue, { ttl });
      
      this.stats.sets++;
      this.emit('set', { key, ttl });
      
      return true;
    } catch (error) {
      this.logger.error('Cache set error', { key, error });
      return false;
    }
  }
  
  /**
   * Delete cached value
   */
  async delete(key, options = {}) {
    const fullKey = this.makeKey(key, options.namespace);
    
    try {
      const result = await this.backend.delete(fullKey);
      
      if (result) {
        this.stats.deletes++;
        this.emit('delete', { key });
      }
      
      return result;
    } catch (error) {
      this.logger.error('Cache delete error', { key, error });
      return false;
    }
  }
  
  /**
   * Clear cache
   */
  async clear(namespace = null) {
    try {
      if (namespace) {
        // Clear specific namespace
        const prefix = this.makeKey('', namespace);
        // TODO: Implement namespace clearing
      } else {
        // Clear all
        await this.backend.clear();
      }
      
      this.emit('clear', { namespace });
      return true;
    } catch (error) {
      this.logger.error('Cache clear error', { error });
      return false;
    }
  }
  
  /**
   * Get or load value
   */
  async getOrLoad(key, loader, options = {}) {
    const value = await this.get(key, options);
    
    if (value !== null) {
      return value;
    }
    
    return await this.loadAndCache(key, { ...options, loader });
  }
  
  /**
   * Load and cache value
   */
  async loadAndCache(key, options) {
    const loader = options.loader;
    
    if (!loader) {
      throw new Error('Loader function required');
    }
    
    try {
      // Prevent cache stampede
      const lockKey = `${key}:lock`;
      const locked = await this.acquireLock(lockKey, options.lockTimeout || 5000);
      
      if (!locked) {
        // Wait for other process to load
        await this.waitForUnlock(lockKey, options.lockTimeout || 5000);
        return await this.get(key, { ...options, loader: null });
      }
      
      // Load value
      const value = await loader();
      
      // Cache value
      if (value !== undefined && value !== null) {
        await this.set(key, value, options);
      }
      
      // Release lock
      await this.releaseLock(lockKey);
      
      return value;
    } catch (error) {
      this.logger.error('Load and cache error', { key, error });
      throw error;
    }
  }
  
  /**
   * Cache decorator
   */
  cached(fn, options = {}) {
    return async (...args) => {
      const key = options.key || this.generateKey(fn.name, args);
      
      return await this.getOrLoad(key, () => fn(...args), options);
    };
  }
  
  /**
   * Invalidate cache by pattern
   */
  async invalidate(pattern, options = {}) {
    const regex = new RegExp(pattern);
    let invalidated = 0;
    
    // TODO: Implement pattern matching for different backends
    if (this.backend instanceof MemoryCache) {
      for (const key of this.backend.cache.keys()) {
        if (regex.test(key)) {
          await this.delete(key);
          invalidated++;
        }
      }
    }
    
    this.emit('invalidate', { pattern, count: invalidated });
    return invalidated;
  }
  
  /**
   * Warm cache
   */
  async warm(items) {
    const results = [];
    
    for (const item of items) {
      try {
        const { key, loader, options = {} } = item;
        const value = await loader();
        
        if (value !== undefined && value !== null) {
          await this.set(key, value, options);
          results.push({ key, success: true });
        } else {
          results.push({ key, success: false, reason: 'No value' });
        }
      } catch (error) {
        results.push({ key: item.key, success: false, error });
      }
    }
    
    this.emit('warm', { count: results.length });
    return results;
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    const hitRate = this.stats.hits / (this.stats.hits + this.stats.misses) || 0;
    
    return {
      ...this.stats,
      hitRate: hitRate * 100,
      backend: this.backend.getStats ? this.backend.getStats() : {}
    };
  }
  
  /**
   * Create cache group
   */
  group(name, options = {}) {
    if (!this.caches.has(name)) {
      const cache = new CacheGroup(this, name, options);
      this.caches.set(name, cache);
    }
    
    return this.caches.get(name);
  }
  
  /**
   * Make cache key
   */
  makeKey(key, namespace = null) {
    const ns = namespace || this.options.namespace;
    return ns ? `${ns}:${key}` : key;
  }
  
  /**
   * Generate cache key
   */
  generateKey(prefix, args) {
    const hash = createHash('sha256');
    hash.update(prefix);
    hash.update(JSON.stringify(args));
    return hash.digest('hex').substring(0, 16);
  }
  
  /**
   * Check if value should be compressed
   */
  shouldCompress(value) {
    if (typeof value === 'string' && value.length > 1024) {
      return true;
    }
    
    if (Buffer.isBuffer(value) && value.length > 1024) {
      return true;
    }
    
    if (typeof value === 'object') {
      const size = JSON.stringify(value).length;
      return size > 1024;
    }
    
    return false;
  }
  
  /**
   * Compress value
   */
  async compress(value) {
    // TODO: Implement compression
    return value;
  }
  
  /**
   * Decompress value
   */
  async decompress(value) {
    // TODO: Implement decompression
    return value;
  }
  
  /**
   * Acquire lock
   */
  async acquireLock(key, timeout) {
    const lockValue = Date.now() + timeout;
    
    // Try to set lock
    const existing = await this.backend.get(key);
    
    if (existing && existing > Date.now()) {
      return false; // Lock held by another process
    }
    
    await this.backend.set(key, lockValue, { ttl: timeout });
    return true;
  }
  
  /**
   * Release lock
   */
  async releaseLock(key) {
    await this.backend.delete(key);
  }
  
  /**
   * Wait for unlock
   */
  async waitForUnlock(key, timeout) {
    const start = Date.now();
    const checkInterval = 100;
    
    while (Date.now() - start < timeout) {
      const lock = await this.backend.get(key);
      
      if (!lock || lock < Date.now()) {
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    throw new Error('Lock wait timeout');
  }
  
  /**
   * Cleanup
   */
  async cleanup() {
    // Clear expired items
    if (this.backend instanceof MemoryCache) {
      const now = Date.now();
      const keysToDelete = [];
      
      for (const [key, meta] of this.backend.metadata) {
        if (meta.expires && meta.expires < now) {
          keysToDelete.push(key);
        }
      }
      
      for (const key of keysToDelete) {
        await this.backend.delete(key);
      }
    }
    
    this.emit('cleanup', { removed: keysToDelete?.length || 0 });
  }
}

/**
 * Cache Group
 */
class CacheGroup {
  constructor(manager, name, options = {}) {
    this.manager = manager;
    this.name = name;
    this.options = options;
  }
  
  async get(key, options = {}) {
    return await this.manager.get(key, {
      ...options,
      namespace: `${this.name}:${options.namespace || ''}`
    });
  }
  
  async set(key, value, options = {}) {
    return await this.manager.set(key, value, {
      ...this.options,
      ...options,
      namespace: `${this.name}:${options.namespace || ''}`
    });
  }
  
  async delete(key, options = {}) {
    return await this.manager.delete(key, {
      ...options,
      namespace: `${this.name}:${options.namespace || ''}`
    });
  }
  
  async clear() {
    return await this.manager.clear(this.name);
  }
  
  async invalidate(pattern) {
    return await this.manager.invalidate(`${this.name}:${pattern}`);
  }
}

// Create singleton instance
let cacheInstance;

// Pre-configured cache instances for different domains
export const CacheFactory = {
  createPoolCache() {
    return new CacheManager({
      namespace: 'pool',
      maxSize: 256 * 1024 * 1024, // 256MB
      ttl: 300000, // 5 minutes
      evictionPolicy: EvictionPolicy.LRU
    });
  },
  
  createDexCache() {
    return new CacheManager({
      namespace: 'dex',
      maxSize: 128 * 1024 * 1024, // 128MB
      ttl: 60000, // 1 minute
      evictionPolicy: EvictionPolicy.LRU
    });
  },
  
  createDefiCache() {
    return new CacheManager({
      namespace: 'defi',
      maxSize: 64 * 1024 * 1024, // 64MB
      ttl: 180000, // 3 minutes
      evictionPolicy: EvictionPolicy.LRU
    });
  },
  
  createApiCache() {
    return new CacheManager({
      namespace: 'api',
      maxSize: 32 * 1024 * 1024, // 32MB
      ttl: 30000, // 30 seconds
      evictionPolicy: EvictionPolicy.LRU
    });
  }
};

// Singleton instances
let cacheInstance;
export function createCache(options) {
  if (!cacheInstance) {
    cacheInstance = new CacheManager(options);
  }
  return cacheInstance;
}

export function getCache() {
  if (!cacheInstance) {
    throw new Error('Cache not initialized');
  }
  return cacheInstance;
}

// Cache middleware for HTTP requests
export class CacheMiddleware {
  constructor(cache, options = {}) {
    this.cache = cache;
    this.options = {
      ttl: options.ttl || 60000,
      keyGenerator: options.keyGenerator || this.defaultKeyGenerator,
      shouldCache: options.shouldCache || this.defaultShouldCache,
      ...options
    };
  }
  
  defaultKeyGenerator(req) {
    return createHash('sha256')
      .update(req.method + req.url + JSON.stringify(req.headers))
      .digest('hex');
  }
  
  defaultShouldCache(req) {
    return req.method === 'GET' && !req.url.includes('realtime');
  }
  
  middleware() {
    return async (req, res, next) => {
      if (!this.options.shouldCache(req)) {
        return next();
      }
      
      const key = this.options.keyGenerator(req);
      const cached = await this.cache.get(key);
      
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('Content-Type', cached.contentType);
        return res.end(cached.data);
      }
      
      const originalEnd = res.end;
      res.end = (data) => {
        if (res.statusCode === 200) {
          this.cache.set(key, {
            data,
            contentType: res.getHeader('Content-Type') || 'application/json'
          }, { ttl: this.options.ttl });
        }
        originalEnd.call(res, data);
      };
      
      next();
    };
  }
}

// Decorator for caching methods
export function cacheable(options = {}) {
  return function(target, propertyKey, descriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function(...args) {
      const cache = getCache();
      const key = options.key || cache.generateKey(`${target.constructor.name}.${propertyKey}`, args);
      
      return await cache.getOrLoad(key, () => originalMethod.apply(this, args), options);
    };
    
    return descriptor;
  };
}