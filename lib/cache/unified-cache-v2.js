/**
 * Unified Cache System V2
 * Consolidates all caching functionality with advanced features
 */

const { EventEmitter } = require('events');
const { getLogger } = require('../core/logger.js');
const { performance } = require('perf_hooks');
const crypto = require('crypto');
const { LRUCache } = require('lru-cache');

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
 * Enhanced with features from efficient-lru-cache.js
 */
class MemoryCacheProvider extends CacheProvider {
  constructor(options = {}) {
    super(options);
    this.maxSize = options.maxSize || 100 * 1024 * 1024; // 100MB default
    this.maxItems = options.maxItems || 10000;
    this.defaultTTL = options.defaultTTL || 3600000; // 1 hour
    
    // Use lru-cache for better performance
    this.cache = new LRUCache({
      max: this.maxItems,
      maxSize: this.maxSize,
      sizeCalculation: (entry) => entry.size,
      ttl: this.defaultTTL,
      updateAgeOnGet: true,
      dispose: (entry, key, reason) => {
        if (reason === 'evict') {
          this.stats.recordEviction();
        }
      }
    });
    
    // Node pool for memory efficiency (from efficient-lru-cache)
    this.nodePool = [];
    this.maxPoolSize = 100;
  }

  async get(key) {
    const start = performance.now();
    
    const entry = this.cache.get(key);
    if (entry) {
      // Entry is automatically managed by LRUCache
      this.stats.recordHit(performance.now() - start, entry.size);
      return entry.value;
    }
    
    this.stats.recordMiss(performance.now() - start);
    return null;
  }

  async set(key, value, ttl) {
    const serialized = JSON.stringify(value);
    const size = Buffer.byteLength(serialized);
    
    const entry = this._acquireNode();
    entry.value = value;
    entry.size = size;
    entry.ttl = ttl || this.defaultTTL;
    entry.created = Date.now();
    entry.hits = 0;
    entry.lastAccess = Date.now();
    
    // LRUCache handles eviction automatically
    this.cache.set(key, entry, { ttl: entry.ttl, size: entry.size });
    
    this.stats.recordSet(size);
  }
  
  _acquireNode() {
    return this.nodePool.pop() || {};
  }
  
  _releaseNode(node) {
    if (this.nodePool.length < this.maxPoolSize) {
      // Clear node properties
      Object.keys(node).forEach(key => delete node[key]);
      this.nodePool.push(node);
    }
  }

  async delete(key) {
    const entry = this.cache.get(key);
    if (entry) {
      this._releaseNode(entry);
      this.cache.delete(key);
      this.stats.recordDelete();
      return true;
    }
    return false;
  }

  async clear() {
    // Release all nodes to pool
    for (const entry of this.cache.values()) {
      this._releaseNode(entry);
    }
    this.cache.clear();
  }

  async has(key) {
    return this.cache.has(key);
  }

  async size() {
    return this.cache.size;
  }
  
  getMemoryStats() {
    return {
      size: this.cache.size,
      maxSize: this.cache.max,
      calculatedSize: this.cache.calculatedSize,
      nodePoolSize: this.nodePool.length
    };
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
 * Cache entry states (from multi-tier-cache)
 */
const CacheState = {
  FRESH: 'fresh',
  STALE: 'stale',
  EXPIRED: 'expired',
  UPDATING: 'updating'
};

/**
 * Cache strategies (from cache-strategies)
 */
const CacheStrategy = {
  CACHE_ASIDE: 'cache_aside',
  WRITE_THROUGH: 'write_through',
  WRITE_BEHIND: 'write_behind',
  REFRESH_AHEAD: 'refresh_ahead',
  PREDICTIVE: 'predictive',
  ADAPTIVE_TTL: 'adaptive_ttl'
};

/**
 * Unified cache with multiple tiers
 * Enhanced with multi-tier-cache and cache-strategies features
 */
class UnifiedCache extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      tiers: ['memory', 'redis', 'disk'],
      ttl: 3600000, // 1 hour default
      staleTtl: 7200000, // 2 hours default
      compression: true,
      encryption: false,
      namespace: 'default',
      warming: true,
      monitoring: true,
      strategy: CacheStrategy.CACHE_ASIDE,
      // Predictive caching options
      enablePredictive: false,
      predictiveWindow: 300000, // 5 minutes
      minConfidence: 0.7,
      // Adaptive TTL options
      enableAdaptiveTTL: false,
      minTTL: 60000, // 1 minute
      maxTTL: 3600000, // 1 hour
      ttlMultiplier: 1.5,
      ...options
    };
    
    this.providers = new Map();
    this.warmer = new CacheWarmer(this);
    this.middleware = [];
    
    // Multi-tier cache features
    this.pendingGets = new Map();
    this.pendingWrites = new Map();
    this.writeQueue = [];
    this.refreshQueue = [];
    
    // Predictive caching (from cache-strategies)
    if (this.options.enablePredictive) {
      this.accessPatterns = new Map();
      this.predictions = new Map();
    }
    
    // Adaptive TTL (from cache-strategies)
    if (this.options.enableAdaptiveTTL) {
      this.accessCounts = new Map();
    }
    
    this.initializeProviders();
    this.startMonitoring();
    this.startBackgroundWorkers();
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
   * Enhanced with multi-tier and predictive features
   */
  async get(key, options = {}) {
    const fullKey = this.makeKey(key);
    
    // Check if already fetching (from multi-tier-cache)
    if (this.pendingGets.has(fullKey)) {
      return this.pendingGets.get(fullKey);
    }
    
    // Create promise for concurrent requests
    const getPromise = this._get(fullKey, key, options);
    this.pendingGets.set(fullKey, getPromise);
    
    try {
      const result = await getPromise;
      return result;
    } finally {
      this.pendingGets.delete(fullKey);
    }
  }
  
  async _get(fullKey, originalKey, options) {
    // Track access for warming and predictive caching
    if (this.options.warming) {
      this.warmer.trackAccess(fullKey);
    }
    
    // Track for predictive caching
    if (this.options.enablePredictive) {
      this._recordAccess(originalKey);
    }
    
    // Track for adaptive TTL
    if (this.options.enableAdaptiveTTL) {
      const count = (this.accessCounts.get(originalKey) || 0) + 1;
      this.accessCounts.set(originalKey, count);
    }
    
    // Try each tier in order
    for (const [tierName, provider] of this.providers) {
      try {
        const value = await provider.get(fullKey);
        
        if (value !== null) {
          // Check if stale-while-revalidate is allowed
          const entry = await this._getEntry(fullKey, tierName);
          if (entry && entry.isStale && entry.isStale() && options.allowStale !== false) {
            // Return stale value and refresh in background
            this._scheduleRefresh(originalKey, entry);
          }
          
          // Promote to higher tiers
          await this.promote(fullKey, value, tierName);
          
          // Apply middleware
          const processed = await this.applyMiddleware('get', value, { key: originalKey, tier: tierName });
          
          this.emit('hit', { key: originalKey, tier: tierName });
          
          // Predictive preloading
          if (this.options.enablePredictive && value !== null) {
            this._predictAndPreload(originalKey);
          }
          
          return processed;
        }
      } catch (error) {
        logger.error(`Cache get error in ${tierName}:`, error);
      }
    }
    
    this.emit('miss', { key: originalKey });
    
    // Auto-load if loader provided
    if (options.loader) {
      const value = await options.loader();
      if (value !== undefined) {
        await this.set(originalKey, value, options.ttl);
      }
      return value;
    }
    
    return null;
  }

  /**
   * Set value in cache
   * Enhanced with caching strategies
   */
  async set(key, value, options = {}) {
    const fullKey = this.makeKey(key);
    let ttl = options.ttl || this.options.ttl;
    
    // Calculate adaptive TTL if enabled
    if (this.options.enableAdaptiveTTL && !options.ttl) {
      const accessCount = this.accessCounts.get(key) || 0;
      ttl = this._calculateAdaptiveTTL(accessCount);
    }
    
    // Apply middleware
    const processed = await this.applyMiddleware('set', value, { key });
    
    // Apply caching strategy
    switch (this.options.strategy) {
      case CacheStrategy.WRITE_THROUGH:
        await this._writeThrough(fullKey, processed, ttl);
        break;
        
      case CacheStrategy.WRITE_BEHIND:
        await this._writeBehind(fullKey, processed, ttl);
        break;
        
      default:
        await this._writeCacheAside(fullKey, processed, ttl);
    }
    
    this.emit('set', { key, ttl });
  }
  
  async _writeCacheAside(fullKey, value, ttl) {
    // Write to memory tier immediately
    const memoryProvider = this.providers.get('memory');
    if (memoryProvider) {
      await memoryProvider.set(fullKey, value, ttl);
    }
    
    // Schedule writes to other tiers
    this._scheduleWrite(fullKey, value, ttl);
  }
  
  async _writeThrough(fullKey, value, ttl) {
    // Write to all tiers simultaneously
    const writes = [];
    
    for (const [tierName, provider] of this.providers) {
      writes.push(
        provider.set(fullKey, value, ttl)
          .catch(error => {
            logger.error(`Cache set error in ${tierName}:`, error);
          })
      );
    }
    
    await Promise.all(writes);
  }
  
  async _writeBehind(fullKey, value, ttl) {
    // Write to memory immediately
    const memoryProvider = this.providers.get('memory');
    if (memoryProvider) {
      await memoryProvider.set(fullKey, value, ttl);
    }
    
    // Queue writes to other tiers
    this.writeQueue.push({ fullKey, value, ttl, timestamp: Date.now() });
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
   * Enhanced with additional metrics
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
      },
      queues: {
        writes: this.writeQueue.length,
        refreshes: this.refreshQueue.length,
        pendingGets: this.pendingGets.size
      }
    };
    
    // Memory provider special stats
    const memoryProvider = this.providers.get('memory');
    if (memoryProvider && memoryProvider.getMemoryStats) {
      stats.providers.memory = {
        ...memoryProvider.stats.stats,
        ...memoryProvider.getMemoryStats()
      };
    }
    
    for (const [name, provider] of this.providers) {
      if (!stats.providers[name]) {
        stats.providers[name] = { ...provider.stats.stats };
      }
      stats.providers[name].hitRate = provider.stats.getHitRate();
      
      // Aggregate
      Object.keys(provider.stats.stats).forEach(key => {
        if (typeof provider.stats.stats[key] === 'number') {
          stats.overall[key] += provider.stats.stats[key];
        }
      });
    }
    
    stats.overall.hitRate = stats.overall.hits / (stats.overall.hits + stats.overall.misses) || 0;
    
    // Add strategy info
    stats.strategy = this.options.strategy;
    stats.features = {
      predictive: this.options.enablePredictive,
      adaptiveTTL: this.options.enableAdaptiveTTL,
      warming: this.options.warming
    };
    
    return stats;
  }

  /**
   * Warm cache
   */
  async warm(loader) {
    if (!this.options.warming) return 0;
    
    return await this.warmer.warm(loader);
  }
  
  /**
   * Background workers (from multi-tier-cache)
   */
  startBackgroundWorkers() {
    // Write queue processor
    setInterval(() => {
      this._processWriteQueue();
    }, 1000);
    
    // Refresh queue processor
    if (this.options.strategy === CacheStrategy.REFRESH_AHEAD) {
      setInterval(() => {
        this._processRefreshQueue();
      }, 5000);
    }
  }
  
  async _processWriteQueue() {
    const batch = this.writeQueue.splice(0, 10);
    
    for (const { fullKey, value, ttl } of batch) {
      // Write to non-memory tiers
      for (const [tierName, provider] of this.providers) {
        if (tierName !== 'memory') {
          await provider.set(fullKey, value, ttl).catch(error => {
            logger.error(`Background write error in ${tierName}:`, error);
          });
        }
      }
    }
  }
  
  async _processRefreshQueue() {
    const now = Date.now();
    const toRefresh = [];
    
    this.refreshQueue = this.refreshQueue.filter(item => {
      if (now - item.scheduledAt > 60000) { // 1 minute timeout
        return false;
      }
      
      const timeUntilExpiry = (item.entry.createdAt + item.entry.ttl) - now;
      if (timeUntilExpiry < item.entry.ttl * 0.2) { // 20% of TTL remaining
        toRefresh.push(item);
        return false;
      }
      
      return true;
    });
    
    for (const item of toRefresh) {
      this.emit('refresh', { key: item.key });
    }
  }
  
  _scheduleWrite(fullKey, value, ttl) {
    this.writeQueue.push({
      fullKey,
      value,
      ttl,
      timestamp: Date.now()
    });
  }
  
  _scheduleRefresh(key, entry) {
    if (this.options.strategy === CacheStrategy.REFRESH_AHEAD) {
      this.refreshQueue.push({
        key,
        entry,
        scheduledAt: Date.now()
      });
    }
  }
  
  /**
   * Predictive caching methods (from cache-strategies)
   */
  _recordAccess(key) {
    if (!this.options.enablePredictive) return;
    
    const now = Date.now();
    
    if (!this.accessPatterns.has(key)) {
      this.accessPatterns.set(key, {
        accesses: [],
        following: new Map()
      });
    }
    
    const pattern = this.accessPatterns.get(key);
    pattern.accesses.push(now);
    
    // Clean old accesses
    pattern.accesses = pattern.accesses.filter(
      time => now - time < this.options.predictiveWindow
    );
    
    // Update following patterns
    for (const [prevKey, prevPattern] of this.accessPatterns) {
      if (prevKey === key) continue;
      
      const lastAccess = prevPattern.accesses[prevPattern.accesses.length - 1];
      if (lastAccess && now - lastAccess < 1000) { // Within 1 second
        const count = prevPattern.following.get(key) || 0;
        prevPattern.following.set(key, count + 1);
      }
    }
  }
  
  async _predictAndPreload(key) {
    if (!this.options.enablePredictive) return;
    
    const pattern = this.accessPatterns.get(key);
    if (!pattern || pattern.following.size === 0) return;
    
    // Calculate predictions
    const totalFollows = Array.from(pattern.following.values())
      .reduce((a, b) => a + b, 0);
    
    const predictions = [];
    for (const [followKey, count] of pattern.following) {
      const confidence = count / totalFollows;
      if (confidence >= this.options.minConfidence) {
        predictions.push({ key: followKey, confidence });
      }
    }
    
    // Sort by confidence
    predictions.sort((a, b) => b.confidence - a.confidence);
    
    // Preload top predictions
    const toPreload = predictions.slice(0, 10);
    
    for (const { key: predictedKey, confidence } of toPreload) {
      const exists = await this.has(predictedKey);
      if (!exists && this.options.preloader) {
        // Preload in background
        this.options.preloader(predictedKey)
          .then(value => {
            if (value !== undefined) {
              this.set(predictedKey, value, {
                metadata: { preloaded: true, confidence }
              });
            }
          })
          .catch(error => {
            logger.debug('Preload failed', { key: predictedKey, error });
          });
      }
    }
  }
  
  /**
   * Adaptive TTL calculation (from cache-strategies)
   */
  _calculateAdaptiveTTL(accessCount) {
    if (!this.options.enableAdaptiveTTL) return this.options.ttl;
    
    if (accessCount === 0) return this.options.minTTL;
    
    // Logarithmic scaling
    const ttl = this.options.minTTL * Math.pow(this.options.ttlMultiplier, Math.log2(accessCount + 1));
    
    return Math.min(Math.round(ttl), this.options.maxTTL);
  }
  
  async _getEntry(fullKey, tierName) {
    // Helper to get raw entry for stale checking
    const provider = this.providers.get(tierName);
    if (!provider || !provider.cache) return null;
    
    if (tierName === 'memory') {
      return provider.cache.get(fullKey);
    }
    
    return null;
  }
  
  /**
   * Check if key exists (enhanced)
   */
  async has(key) {
    const fullKey = this.makeKey(key);
    
    for (const [tierName, provider] of this.providers) {
      try {
        if (await provider.has(fullKey)) {
          return true;
        }
      } catch (error) {
        logger.error(`Cache has error in ${tierName}:`, error);
      }
    }
    
    return false;
  }
}

/**
 * Cache middleware
 */
const CacheMiddleware = {
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

module.exports = {
  UnifiedCache,
  CacheMiddleware,
  CacheStats,
  CacheProvider,
  MemoryCacheProvider,
  RedisCacheProvider,
  DiskCacheProvider,
  CacheWarmer,
  CacheState,
  CacheStrategy,
  
  // Factory functions for creating specialized caches
  createCache: (options = {}) => new UnifiedCache(options),
  
  createPredictiveCache: (options = {}) => new UnifiedCache({
    ...options,
    enablePredictive: true,
    strategy: CacheStrategy.PREDICTIVE
  }),
  
  createAdaptiveTTLCache: (options = {}) => new UnifiedCache({
    ...options,
    enableAdaptiveTTL: true
  }),
  
  createMultiTierCache: (options = {}) => new UnifiedCache({
    ...options,
    strategy: CacheStrategy.WRITE_THROUGH,
    tiers: ['memory', 'redis', 'disk']
  }),
  
  createHighPerformanceCache: (options = {}) => new UnifiedCache({
    ...options,
    tiers: ['memory'],
    strategy: CacheStrategy.CACHE_ASIDE,
    memoryMaxSize: options.maxSize || 100 * 1024 * 1024,
    memoryMaxItems: options.maxItems || 10000
  })
};