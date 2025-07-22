/**
 * Unified Cache System V2
 * Consolidates all caching functionality with advanced features
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { performance } from 'perf_hooks';
import crypto from 'crypto';

const logger = getLogger('UnifiedCacheV2');

/**
 * Cache statistics collector
 */
class CacheStats {
  constructor() {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
      errors: 0,
      bytesRead: 0,
      bytesWritten: 0,
      avgHitTime: 0,
      avgMissTime: 0
    };
    this.hitTimes = [];
    this.missTimes = [];
  }

  recordHit(duration, bytes = 0) {
    this.stats.hits++;
    this.stats.bytesRead += bytes;
    this.hitTimes.push(duration);
    if (this.hitTimes.length > 1000) this.hitTimes.shift();
    this.stats.avgHitTime = this.hitTimes.reduce((a, b) => a + b, 0) / this.hitTimes.length;
  }

  recordMiss(duration) {
    this.stats.misses++;
    this.missTimes.push(duration);
    if (this.missTimes.length > 1000) this.missTimes.shift();
    this.stats.avgMissTime = this.missTimes.reduce((a, b) => a + b, 0) / this.missTimes.length;
  }

  recordSet(bytes = 0) {
    this.stats.sets++;
    this.stats.bytesWritten += bytes;
  }

  recordDelete() {
    this.stats.deletes++;
  }

  recordEviction() {
    this.stats.evictions++;
  }

  recordError() {
    this.stats.errors++;
  }

  getHitRate() {
    const total = this.stats.hits + this.stats.misses;
    return total > 0 ? this.stats.hits / total : 0;
  }

  reset() {
    Object.keys(this.stats).forEach(key => {
      this.stats[key] = 0;
    });
    this.hitTimes = [];
    this.missTimes = [];
  }
}

/**
 * Base cache interface
 */
class CacheProvider {
  constructor(options = {}) {
    this.options = options;
    this.stats = new CacheStats();
  }

  async get(key) {
    throw new Error('get() must be implemented by subclass');
  }

  async set(key, value, ttl) {
    throw new Error('set() must be implemented by subclass');
  }

  async delete(key) {
    throw new Error('delete() must be implemented by subclass');
  }

  async clear() {
    throw new Error('clear() must be implemented by subclass');
  }

  async has(key) {
    throw new Error('has() must be implemented by subclass');
  }

  async size() {
    throw new Error('size() must be implemented by subclass');
  }
}

/**
 * Memory cache provider with LRU eviction
 */
class MemoryCacheProvider extends CacheProvider {
  constructor(options = {}) {
    super(options);
    this.maxSize = options.maxSize || 100 * 1024 * 1024; // 100MB default
    this.maxItems = options.maxItems || 10000;
    this.cache = new Map();
    this.lru = new Map(); // For LRU tracking
    this.currentSize = 0;
  }

  async get(key) {
    const start = performance.now();
    
    if (this.cache.has(key)) {
      const entry = this.cache.get(key);
      
      // Check TTL
      if (entry.ttl && Date.now() > entry.expires) {
        await this.delete(key);
        this.stats.recordMiss(performance.now() - start);
        return null;
      }
      
      // Update LRU
      this.lru.delete(key);
      this.lru.set(key, Date.now());
      
      this.stats.recordHit(performance.now() - start, entry.size);
      return entry.value;
    }
    
    this.stats.recordMiss(performance.now() - start);
    return null;
  }

  async set(key, value, ttl) {
    const serialized = JSON.stringify(value);
    const size = Buffer.byteLength(serialized);
    
    // Evict if necessary
    while ((this.currentSize + size > this.maxSize || this.cache.size >= this.maxItems) && this.cache.size > 0) {
      await this.evictOldest();
    }
    
    const entry = {
      value,
      size,
      ttl,
      expires: ttl ? Date.now() + ttl : null,
      created: Date.now()
    };
    
    this.cache.set(key, entry);
    this.lru.set(key, Date.now());
    this.currentSize += size;
    
    this.stats.recordSet(size);
  }

  async delete(key) {
    if (this.cache.has(key)) {
      const entry = this.cache.get(key);
      this.currentSize -= entry.size;
      this.cache.delete(key);
      this.lru.delete(key);
      this.stats.recordDelete();
      return true;
    }
    return false;
  }

  async clear() {
    this.cache.clear();
    this.lru.clear();
    this.currentSize = 0;
  }

  async has(key) {
    if (this.cache.has(key)) {
      const entry = this.cache.get(key);
      if (entry.ttl && Date.now() > entry.expires) {
        await this.delete(key);
        return false;
      }
      return true;
    }
    return false;
  }

  async size() {
    return this.cache.size;
  }

  async evictOldest() {
    const oldestKey = this.lru.keys().next().value;
    if (oldestKey) {
      await this.delete(oldestKey);
      this.stats.recordEviction();
    }
  }
}

/**
 * Redis cache provider
 */
class RedisCacheProvider extends CacheProvider {
  constructor(redis, options = {}) {
    super(options);
    this.redis = redis;
    this.prefix = options.prefix || 'cache:';
  }

  async get(key) {
    const start = performance.now();
    
    try {
      const value = await this.redis.get(this.prefix + key);
      if (value) {
        this.stats.recordHit(performance.now() - start, Buffer.byteLength(value));
        return JSON.parse(value);
      }
      this.stats.recordMiss(performance.now() - start);
      return null;
    } catch (error) {
      this.stats.recordError();
      throw error;
    }
  }

  async set(key, value, ttl) {
    try {
      const serialized = JSON.stringify(value);
      const size = Buffer.byteLength(serialized);
      
      if (ttl) {
        await this.redis.setex(this.prefix + key, Math.floor(ttl / 1000), serialized);
      } else {
        await this.redis.set(this.prefix + key, serialized);
      }
      
      this.stats.recordSet(size);
    } catch (error) {
      this.stats.recordError();
      throw error;
    }
  }

  async delete(key) {
    try {
      const result = await this.redis.del(this.prefix + key);
      if (result) {
        this.stats.recordDelete();
      }
      return result > 0;
    } catch (error) {
      this.stats.recordError();
      throw error;
    }
  }

  async clear() {
    try {
      const keys = await this.redis.keys(this.prefix + '*');
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (error) {
      this.stats.recordError();
      throw error;
    }
  }

  async has(key) {
    try {
      return await this.redis.exists(this.prefix + key) > 0;
    } catch (error) {
      this.stats.recordError();
      throw error;
    }
  }

  async size() {
    try {
      const keys = await this.redis.keys(this.prefix + '*');
      return keys.length;
    } catch (error) {
      this.stats.recordError();
      throw error;
    }
  }
}

/**
 * Disk cache provider
 */
class DiskCacheProvider extends CacheProvider {
  constructor(fs, path, options = {}) {
    super(options);
    this.fs = fs;
    this.basePath = path;
    this.maxSize = options.maxSize || 1024 * 1024 * 1024; // 1GB default
    this.index = new Map(); // In-memory index
    this.initializeIndex();
  }

  async initializeIndex() {
    try {
      const indexPath = `${this.basePath}/cache.index`;
      if (await this.fs.exists(indexPath)) {
        const data = await this.fs.readFile(indexPath, 'utf8');
        this.index = new Map(JSON.parse(data));
      }
    } catch (error) {
      logger.error('Failed to load cache index:', error);
    }
  }

  async saveIndex() {
    try {
      const indexPath = `${this.basePath}/cache.index`;
      await this.fs.writeFile(indexPath, JSON.stringify([...this.index]));
    } catch (error) {
      logger.error('Failed to save cache index:', error);
    }
  }

  getFilePath(key) {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    const dir = hash.substring(0, 2);
    const file = hash.substring(2);
    return `${this.basePath}/${dir}/${file}`;
  }

  async get(key) {
    const start = performance.now();
    
    try {
      const metadata = this.index.get(key);
      if (!metadata) {
        this.stats.recordMiss(performance.now() - start);
        return null;
      }
      
      // Check TTL
      if (metadata.expires && Date.now() > metadata.expires) {
        await this.delete(key);
        this.stats.recordMiss(performance.now() - start);
        return null;
      }
      
      const filePath = this.getFilePath(key);
      const data = await this.fs.readFile(filePath, 'utf8');
      
      this.stats.recordHit(performance.now() - start, metadata.size);
      return JSON.parse(data);
    } catch (error) {
      this.stats.recordError();
      this.stats.recordMiss(performance.now() - start);
      return null;
    }
  }

  async set(key, value, ttl) {
    try {
      const serialized = JSON.stringify(value);
      const size = Buffer.byteLength(serialized);
      const filePath = this.getFilePath(key);
      
      // Ensure directory exists
      const dir = filePath.substring(0, filePath.lastIndexOf('/'));
      await this.fs.mkdir(dir, { recursive: true });
      
      // Write file
      await this.fs.writeFile(filePath, serialized);
      
      // Update index
      this.index.set(key, {
        size,
        expires: ttl ? Date.now() + ttl : null,
        created: Date.now()
      });
      
      await this.saveIndex();
      this.stats.recordSet(size);
    } catch (error) {
      this.stats.recordError();
      throw error;
    }
  }

  async delete(key) {
    try {
      const metadata = this.index.get(key);
      if (!metadata) return false;
      
      const filePath = this.getFilePath(key);
      await this.fs.unlink(filePath);
      
      this.index.delete(key);
      await this.saveIndex();
      
      this.stats.recordDelete();
      return true;
    } catch (error) {
      this.stats.recordError();
      return false;
    }
  }

  async clear() {
    try {
      await this.fs.rmdir(this.basePath, { recursive: true });
      await this.fs.mkdir(this.basePath, { recursive: true });
      this.index.clear();
      await this.saveIndex();
    } catch (error) {
      this.stats.recordError();
      throw error;
    }
  }

  async has(key) {
    const metadata = this.index.get(key);
    if (!metadata) return false;
    
    if (metadata.expires && Date.now() > metadata.expires) {
      await this.delete(key);
      return false;
    }
    
    return true;
  }

  async size() {
    return this.index.size;
  }
}

/**
 * Cache warming strategies
 */
class CacheWarmer {
  constructor(cache) {
    this.cache = cache;
    this.patterns = new Map();
    this.predictions = new Map();
  }

  /**
   * Track access patterns
   */
  trackAccess(key) {
    const now = Date.now();
    
    if (!this.patterns.has(key)) {
      this.patterns.set(key, {
        count: 0,
        lastAccess: now,
        intervals: []
      });
    }
    
    const pattern = this.patterns.get(key);
    
    if (pattern.lastAccess) {
      pattern.intervals.push(now - pattern.lastAccess);
      if (pattern.intervals.length > 10) {
        pattern.intervals.shift();
      }
    }
    
    pattern.count++;
    pattern.lastAccess = now;
  }

  /**
   * Predict next access time
   */
  predictNextAccess(key) {
    const pattern = this.patterns.get(key);
    if (!pattern || pattern.intervals.length < 3) {
      return null;
    }
    
    // Simple moving average
    const avgInterval = pattern.intervals.reduce((a, b) => a + b, 0) / pattern.intervals.length;
    return pattern.lastAccess + avgInterval;
  }

  /**
   * Warm cache based on predictions
   */
  async warm(loader) {
    const now = Date.now();
    const keysToWarm = [];
    
    for (const [key, pattern] of this.patterns) {
      const nextAccess = this.predictNextAccess(key);
      
      if (nextAccess && nextAccess - now < 60000) { // Within next minute
        keysToWarm.push(key);
      }
    }
    
    // Warm in parallel
    await Promise.all(keysToWarm.map(async key => {
      try {
        const value = await loader(key);
        if (value !== undefined) {
          await this.cache.set(key, value);
        }
      } catch (error) {
        logger.error(`Failed to warm cache for key ${key}:`, error);
      }
    }));
    
    return keysToWarm.length;
  }

  /**
   * Clean up old patterns
   */
  cleanup() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    for (const [key, pattern] of this.patterns) {
      if (now - pattern.lastAccess > maxAge) {
        this.patterns.delete(key);
      }
    }
  }
}

/**
 * Unified cache with multiple tiers
 */
export class UnifiedCache extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      tiers: ['memory', 'redis', 'disk'],
      ttl: 3600000, // 1 hour default
      compression: true,
      encryption: false,
      namespace: 'default',
      warming: true,
      monitoring: true,
      ...options
    };
    
    this.providers = new Map();
    this.warmer = new CacheWarmer(this);
    this.middleware = [];
    
    this.initializeProviders();
    this.startMonitoring();
  }

  /**
   * Initialize cache providers
   */
  initializeProviders() {
    const { tiers } = this.options;
    
    if (tiers.includes('memory')) {
      this.providers.set('memory', new MemoryCacheProvider({
        maxSize: this.options.memoryMaxSize,
        maxItems: this.options.memoryMaxItems
      }));
    }
    
    if (tiers.includes('redis') && this.options.redis) {
      this.providers.set('redis', new RedisCacheProvider(this.options.redis, {
        prefix: `${this.options.namespace}:`
      }));
    }
    
    if (tiers.includes('disk') && this.options.diskPath) {
      this.providers.set('disk', new DiskCacheProvider(
        this.options.fs || require('fs/promises'),
        this.options.diskPath,
        {
          maxSize: this.options.diskMaxSize
        }
      ));
    }
  }

  /**
   * Start monitoring
   */
  startMonitoring() {
    if (!this.options.monitoring) return;
    
    setInterval(() => {
      const stats = this.getStats();
      this.emit('stats', stats);
      
      // Log if hit rate is low
      if (stats.hitRate < 0.5) {
        logger.warn(`Cache hit rate low: ${(stats.hitRate * 100).toFixed(2)}%`);
      }
    }, 60000); // Every minute
    
    // Periodic cleanup
    setInterval(() => {
      this.warmer.cleanup();
    }, 3600000); // Every hour
  }

  /**
   * Get value from cache
   */
  async get(key, options = {}) {
    const fullKey = this.makeKey(key);
    
    // Track access for warming
    if (this.options.warming) {
      this.warmer.trackAccess(fullKey);
    }
    
    // Try each tier in order
    for (const [tierName, provider] of this.providers) {
      try {
        const value = await provider.get(fullKey);
        
        if (value !== null) {
          // Promote to higher tiers
          await this.promote(fullKey, value, tierName);
          
          // Apply middleware
          const processed = await this.applyMiddleware('get', value, { key, tier: tierName });
          
          this.emit('hit', { key, tier: tierName });
          return processed;
        }
      } catch (error) {
        logger.error(`Cache get error in ${tierName}:`, error);
      }
    }
    
    this.emit('miss', { key });
    
    // Auto-load if loader provided
    if (options.loader) {
      const value = await options.loader();
      if (value !== undefined) {
        await this.set(key, value, options.ttl);
      }
      return value;
    }
    
    return null;
  }

  /**
   * Set value in cache
   */
  async set(key, value, ttl = this.options.ttl) {
    const fullKey = this.makeKey(key);
    
    // Apply middleware
    const processed = await this.applyMiddleware('set', value, { key });
    
    // Write to all tiers in parallel
    const writes = [];
    
    for (const [tierName, provider] of this.providers) {
      writes.push(
        provider.set(fullKey, processed, ttl)
          .catch(error => {
            logger.error(`Cache set error in ${tierName}:`, error);
          })
      );
    }
    
    await Promise.all(writes);
    
    this.emit('set', { key, ttl });
  }

  /**
   * Delete from cache
   */
  async delete(key) {
    const fullKey = this.makeKey(key);
    
    // Delete from all tiers
    const deletes = [];
    
    for (const [tierName, provider] of this.providers) {
      deletes.push(
        provider.delete(fullKey)
          .catch(error => {
            logger.error(`Cache delete error in ${tierName}:`, error);
          })
      );
    }
    
    await Promise.all(deletes);
    
    this.emit('delete', { key });
  }

  /**
   * Clear all caches
   */
  async clear(pattern) {
    if (pattern) {
      // Clear by pattern
      const keys = await this.keys(pattern);
      await Promise.all(keys.map(key => this.delete(key)));
    } else {
      // Clear everything
      const clears = [];
      
      for (const [tierName, provider] of this.providers) {
        clears.push(
          provider.clear()
            .catch(error => {
              logger.error(`Cache clear error in ${tierName}:`, error);
            })
        );
      }
      
      await Promise.all(clears);
    }
    
    this.emit('clear');
  }

  /**
   * Get cache keys
   */
  async keys(pattern) {
    const allKeys = new Set();
    
    for (const [tierName, provider] of this.providers) {
      try {
        if (provider.keys) {
          const keys = await provider.keys(pattern);
          keys.forEach(key => allKeys.add(key));
        }
      } catch (error) {
        logger.error(`Cache keys error in ${tierName}:`, error);
      }
    }
    
    return Array.from(allKeys);
  }

  /**
   * Get multiple values
   */
  async mget(keys) {
    const results = {};
    
    await Promise.all(keys.map(async key => {
      results[key] = await this.get(key);
    }));
    
    return results;
  }

  /**
   * Set multiple values
   */
  async mset(entries, ttl) {
    await Promise.all(
      Object.entries(entries).map(([key, value]) => 
        this.set(key, value, ttl)
      )
    );
  }

  /**
   * Promote value to higher tiers
   */
  async promote(key, value, currentTier) {
    const tiers = Array.from(this.providers.keys());
    const currentIndex = tiers.indexOf(currentTier);
    
    if (currentIndex > 0) {
      // Promote to all higher tiers
      for (let i = 0; i < currentIndex; i++) {
        const provider = this.providers.get(tiers[i]);
        try {
          await provider.set(key, value, this.options.ttl);
        } catch (error) {
          logger.error(`Failed to promote to ${tiers[i]}:`, error);
        }
      }
    }
  }

  /**
   * Make full cache key
   */
  makeKey(key) {
    return `${this.options.namespace}:${key}`;
  }

  /**
   * Add middleware
   */
  use(middleware) {
    this.middleware.push(middleware);
  }

  /**
   * Apply middleware
   */
  async applyMiddleware(operation, value, context) {
    let result = value;
    
    for (const mw of this.middleware) {
      if (mw[operation]) {
        result = await mw[operation](result, context);
      }
    }
    
    return result;
  }

  /**
   * Get statistics
   */
  getStats() {
    const stats = {
      providers: {},
      overall: {
        hits: 0,
        misses: 0,
        sets: 0,
        deletes: 0,
        evictions: 0,
        errors: 0,
        hitRate: 0
      }
    };
    
    for (const [name, provider] of this.providers) {
      stats.providers[name] = { ...provider.stats.stats };
      stats.providers[name].hitRate = provider.stats.getHitRate();
      
      // Aggregate
      Object.keys(provider.stats.stats).forEach(key => {
        if (typeof provider.stats.stats[key] === 'number') {
          stats.overall[key] += provider.stats.stats[key];
        }
      });
    }
    
    stats.overall.hitRate = stats.overall.hits / (stats.overall.hits + stats.overall.misses) || 0;
    
    return stats;
  }

  /**
   * Warm cache
   */
  async warm(loader) {
    if (!this.options.warming) return 0;
    
    return await this.warmer.warm(loader);
  }
}

/**
 * Cache middleware
 */
export const CacheMiddleware = {
  /**
   * Compression middleware
   */
  compression: (zlib) => ({
    async set(value, context) {
      if (typeof value === 'object') {
        const json = JSON.stringify(value);
        const compressed = await zlib.gzip(json);
        return {
          _compressed: true,
          data: compressed.toString('base64')
        };
      }
      return value;
    },
    
    async get(value, context) {
      if (value && value._compressed) {
        const buffer = Buffer.from(value.data, 'base64');
        const decompressed = await zlib.gunzip(buffer);
        return JSON.parse(decompressed.toString());
      }
      return value;
    }
  }),

  /**
   * Encryption middleware
   */
  encryption: (crypto, key) => ({
    async set(value, context) {
      if (typeof value === 'object') {
        const json = JSON.stringify(value);
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        
        let encrypted = cipher.update(json, 'utf8');
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        
        return {
          _encrypted: true,
          data: encrypted.toString('base64'),
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64')
        };
      }
      return value;
    },
    
    async get(value, context) {
      if (value && value._encrypted) {
        const decipher = crypto.createDecipheriv(
          'aes-256-gcm',
          key,
          Buffer.from(value.iv, 'base64')
        );
        
        decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
        
        let decrypted = decipher.update(Buffer.from(value.data, 'base64'));
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        
        return JSON.parse(decrypted.toString());
      }
      return value;
    }
  }),

  /**
   * Validation middleware
   */
  validation: (schema) => ({
    async set(value, context) {
      // Validate before caching
      const { error } = schema.validate(value);
      if (error) {
        throw new Error(`Validation error: ${error.message}`);
      }
      return value;
    }
  })
};

export default UnifiedCache;