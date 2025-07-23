/**
 * Cache Module - Unified Export
 * Provides a consistent caching interface across Otedama
 * Maintains backward compatibility while using the unified cache manager
 */

const { 
  UnifiedCache, 
  CacheMiddleware, 
  CacheState,
  CacheStrategy,
  createCache,
  createPredictiveCache,
  createAdaptiveTTLCache,
  createMultiTierCache,
  createHighPerformanceCache
} = require('./unified-cache-v2');

// Create default cache instance
const defaultCache = new UnifiedCache({
  ttl: 3600000, // 1 hour
  namespace: 'default'
});

// Cache key prefixes for different domains
const CacheKeys = {
  MINING: 'mining:',
  DEX: 'dex:',
  DEFI: 'defi:',
  USER: 'user:',
  SESSION: 'session:',
  API: 'api:',
  SYSTEM: 'system:'
};

// Default TTL values (in milliseconds)
const CacheTTL = {
  VERY_SHORT: 1000,      // 1 second
  SHORT: 5000,           // 5 seconds
  MEDIUM: 60000,         // 1 minute
  LONG: 3600000,         // 1 hour
  VERY_LONG: 86400000,   // 24 hours
  PERMANENT: 0           // No expiration
};

/**
 * Create cache with options
 */
function createNamespacedCache(namespace, options = {}) {
  return createCache({
    namespace,
    ...options
  });
}

/**
 * Cache middleware for Express
 */
function cacheMiddleware(options = {}) {
  const cache = options.cache || defaultCache;
  const keyGenerator = options.keyGenerator || ((req) => `api:${req.method}:${req.originalUrl}`);
  const ttl = options.ttl || CacheTTL.MEDIUM;
  const condition = options.condition || (() => true);
  
  return async (req, res, next) => {
    // Skip caching if condition not met
    if (!condition(req)) {
      return next();
    }
    
    const key = keyGenerator(req);
    
    // Try to get from cache
    const cached = await cache.get(key);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }
    
    // Store original json method
    const originalJson = res.json;
    
    // Override json method to cache response
    res.json = function(data) {
      res.setHeader('X-Cache', 'MISS');
      
      // Cache successful responses only
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cache.set(key, data, ttl).catch(err => {
          console.error('Cache set error:', err);
        });
      }
      
      // Call original json method
      return originalJson.call(this, data);
    };
    
    next();
  };
}

/**
 * Create domain-specific cache instances
 */
const CacheFactory = {
  // Mining pool cache with short TTL and prefetching
  createPoolCache: (options = {}) => createNamespacedCache('pool', { 
    ttl: CacheTTL.SHORT, 
    enablePredictive: true,
    strategy: CacheStrategy.REFRESH_AHEAD,
    ...options 
  }),
  
  // DEX cache with very short TTL and pattern analysis
  createDexCache: (options = {}) => createNamespacedCache('dex', { 
    ttl: CacheTTL.VERY_SHORT,
    enableAdaptiveTTL: true,
    minTTL: CacheTTL.VERY_SHORT,
    maxTTL: CacheTTL.MEDIUM,
    ...options 
  }),
  
  // DeFi cache with medium TTL
  createDefiCache: (options = {}) => createNamespacedCache('defi', { 
    ttl: CacheTTL.MEDIUM,
    strategy: CacheStrategy.WRITE_THROUGH,
    ...options 
  }),
  
  // API response cache with configurable TTL
  createApiCache: (options = {}) => createNamespacedCache('api', { 
    ttl: CacheTTL.MEDIUM,
    enablePredictive: true,
    ...options 
  }),
  
  // Session cache with long TTL
  createSessionCache: (options = {}) => createNamespacedCache('session', { 
    ttl: CacheTTL.LONG,
    strategy: CacheStrategy.WRITE_THROUGH,
    ...options 
  }),
  
  // Generic cache with custom options
  createCustomCache: (options = {}) => createCache(options),
  
  // High performance caches using optimized settings
  createHighPerformanceDexCache: (options = {}) => createHighPerformanceCache({
    namespace: 'dex',
    maxSize: 64 * 1024 * 1024, // 64MB
    maxItems: 10000,
    defaultTTL: 30000, // 30 seconds
    ...options
  }),
  
  createHighPerformancePoolCache: (options = {}) => createHighPerformanceCache({
    namespace: 'pool',
    maxSize: 32 * 1024 * 1024, // 32MB
    maxItems: 5000,
    defaultTTL: 60000, // 1 minute
    ...options
  }),
  
  createHighPerformanceApiCache: (options = {}) => createHighPerformanceCache({
    namespace: 'api',
    maxSize: 16 * 1024 * 1024, // 16MB
    maxItems: 2000,
    defaultTTL: 300000, // 5 minutes
    ...options
  }),
  
  createHighPerformanceSessionCache: (options = {}) => createHighPerformanceCache({
    namespace: 'session',
    maxSize: 10 * 1024 * 1024, // 10MB
    maxItems: 10000,
    defaultTTL: 1800000, // 30 minutes
    ...options
  }),
  
  // Specialized caches
  createPredictiveCache: (options = {}) => createPredictiveCache(options),
  createAdaptiveTTLCache: (options = {}) => createAdaptiveTTLCache(options),
  createMultiTierCache: (options = {}) => createMultiTierCache(options)
};

/**
 * Cache utilities
 */
const CacheUtils = {
  /**
   * Generate cache key with prefix
   */
  generateKey: (prefix, ...parts) => {
    return prefix + parts.join(':');
  },
  
  /**
   * Parse cache key
   */
  parseKey: (key) => {
    const parts = key.split(':');
    return {
      prefix: parts[0] + ':',
      parts: parts.slice(1)
    };
  },
  
  /**
   * Create cache key from request
   */
  requestKey: (req) => {
    const { method, path, query } = req;
    const queryStr = query ? JSON.stringify(query) : '';
    return `api:${method}:${path}:${queryStr}`;
  },
  
  /**
   * Batch cache operations
   */
  batchGet: async (cache, keys) => {
    const results = await cache.mget(keys);
    return results;
  },
  
  batchSet: async (cache, entries, ttl) => {
    return cache.mset(entries, ttl);
  },
  
  /**
   * Cache warming utility
   */
  warmCache: async (cache, dataFetcher, keys, ttl) => {
    const data = await dataFetcher(keys);
    const entries = {};
    
    keys.forEach((key, index) => {
      if (data[index] !== undefined) {
        entries[key] = data[index];
      }
    });
    
    return cache.mset(entries, ttl);
  }
};

module.exports = {
  // Main classes
  CacheManager: UnifiedCache, // Backward compatibility alias
  UnifiedCache,
  UnifiedCacheManager: UnifiedCache, // Backward compatibility alias
  MultiLayerCache: UnifiedCache, // Backward compatibility alias
  CacheMiddleware,
  
  // Constants
  CacheKeys,
  CacheTTL,
  CacheState,
  CacheStrategy,
  
  // Functions
  createCache,
  createNamespacedCache,
  cacheMiddleware,
  createPredictiveCache,
  createAdaptiveTTLCache,
  createMultiTierCache,
  createHighPerformanceCache,
  
  // Factories and utils
  CacheFactory,
  CacheUtils,
  
  // Default instance
  cache: defaultCache,
  getDefaultCache: () => defaultCache,
  
  // Convenience methods from default cache
  get: (key) => defaultCache.get(key),
  set: (key, value, ttl) => defaultCache.set(key, value, ttl),
  has: (key) => defaultCache.has(key),
  delete: (key) => defaultCache.delete(key),
  clear: () => defaultCache.clear(),
  
  // Default export
  default: defaultCache
};