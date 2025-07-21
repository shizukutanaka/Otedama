/**
 * Cache Module - Unified Export
 * Provides a consistent caching interface across Otedama
 * Maintains backward compatibility while using the unified cache manager
 */

// Import and export the unified cache manager as the primary implementation
export { UnifiedCacheManager as CacheManager } from './unified-cache-manager.js';
export { UnifiedCacheManager as MultiLayerCache } from './unified-cache-manager.js'; // Backward compatibility alias

// Re-export all cache utilities and types
export * from './unified-cache-manager.js';

// Import the unified implementation
import { UnifiedCacheManager, createCache, getDefaultCache } from './unified-cache-manager.js';

// Export cache strategies and levels for backward compatibility
export { CacheStrategy, CacheLevel } from '../core/cache-manager.js';
export { CacheTierType, EvictionPolicy } from '../performance/advanced-caching-system.js';

// Cache key prefixes for different domains
export const CacheKeys = {
  MINING: 'mining:',
  DEX: 'dex:',
  DEFI: 'defi:',
  USER: 'user:',
  SESSION: 'session:',
  API: 'api:',
  SYSTEM: 'system:'
};

// Default TTL values (in milliseconds)
export const CacheTTL = {
  VERY_SHORT: 1000,      // 1 second
  SHORT: 5000,           // 5 seconds
  MEDIUM: 60000,         // 1 minute
  LONG: 3600000,         // 1 hour
  VERY_LONG: 86400000,   // 24 hours
  PERMANENT: 0           // No expiration
};

/**
 * Cache middleware for Express
 */
export function cacheMiddleware(options = {}) {
  const cache = options.cache || getDefaultCache();
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
        cache.set(key, data, { ttl }).catch(err => {
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
export const CacheFactory = {
  // Mining pool cache with short TTL and prefetching
  createPoolCache: (options = {}) => createCache('pool', options),
  
  // DEX cache with very short TTL and pattern analysis
  createDexCache: (options = {}) => createCache('dex', options),
  
  // DeFi cache with medium TTL
  createDefiCache: (options = {}) => createCache('defi', options),
  
  // API response cache with configurable TTL
  createApiCache: (options = {}) => createCache('api', options),
  
  // Session cache with long TTL
  createSessionCache: (options = {}) => createCache('session', options),
  
  // Generic cache with custom options
  createCustomCache: (options = {}) => new UnifiedCacheManager(options)
};

/**
 * Cache utilities
 */
export const CacheUtils = {
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
    return cache.mset(entries, { ttl });
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
    
    return cache.mset(entries, { ttl });
  }
};

// Export default cache instance
export default getDefaultCache();