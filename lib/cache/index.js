/**
 * Cache Module - Unified Export
 * Provides a consistent caching interface across Otedama
 * Maintains backward compatibility while using the unified cache manager
 */

const { UnifiedCache, CacheMiddleware } = require('./unified-cache-v2');
const { EfficientLRUCache, LRUCacheFactory, createLRUCache } = require('./efficient-lru-cache');
const { CacheStrategies } = require('./cache-strategies');
const MultiTierCache = require('./multi-tier-cache');

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
function createCache(namespace, options = {}) {
  return new UnifiedCache({
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
  createPoolCache: (options = {}) => createCache('pool', { ttl: CacheTTL.SHORT, ...options }),
  
  // DEX cache with very short TTL and pattern analysis
  createDexCache: (options = {}) => createCache('dex', { ttl: CacheTTL.VERY_SHORT, ...options }),
  
  // DeFi cache with medium TTL
  createDefiCache: (options = {}) => createCache('defi', { ttl: CacheTTL.MEDIUM, ...options }),
  
  // API response cache with configurable TTL
  createApiCache: (options = {}) => createCache('api', { ttl: CacheTTL.MEDIUM, ...options }),
  
  // Session cache with long TTL
  createSessionCache: (options = {}) => createCache('session', { ttl: CacheTTL.LONG, ...options }),
  
  // Generic cache with custom options
  createCustomCache: (options = {}) => new UnifiedCache(options),
  
  // Direct LRU cache instances for maximum performance
  createHighPerformanceDexCache: (options = {}) => LRUCacheFactory.createDexCache(options),
  createHighPerformancePoolCache: (options = {}) => LRUCacheFactory.createPoolCache(options),
  createHighPerformanceApiCache: (options = {}) => LRUCacheFactory.createApiCache(options),
  createHighPerformanceSessionCache: (options = {}) => LRUCacheFactory.createSessionCache(options)
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
  EfficientLRUCache,
  LRUCacheFactory,
  createLRUCache,
  MultiTierCache,
  CacheMiddleware,
  CacheStrategies,
  
  // Constants
  CacheKeys,
  CacheTTL,
  
  // Functions
  createCache,
  cacheMiddleware,
  
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