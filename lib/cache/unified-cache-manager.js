/**
 * Unified Cache Manager for Otedama
 * Consolidates multiple cache implementations into a single, cohesive interface
 * Following Carmack's performance principles and Martin's clean architecture
 */

import { EventEmitter } from 'events';
import { AdvancedCacheManager as CoreCacheManager } from '../core/cache-manager.js';
import { AdvancedCachingSystem } from '../performance/advanced-caching-system.js';
import { EfficientLRUCache } from './efficient-lru-cache.js';
import { getLogger } from '../core/logger.js';

// Re-export enums and constants
export { CacheStrategy, CacheLevel } from '../core/cache-manager.js';
export { CacheTierType, EvictionPolicy } from '../performance/advanced-caching-system.js';

/**
 * Unified Cache Manager
 * Combines the best features of both cache implementations
 */
export class UnifiedCacheManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.logger = getLogger('UnifiedCacheManager');
    this.options = {
      // Default configuration
      defaultTTL: 3600000, // 1 hour
      maxMemorySize: 100 * 1024 * 1024, // 100MB
      enableAdvancedFeatures: false,
      enablePrefetching: false,
      enablePatternAnalysis: false,
      enableMetrics: true,
      useEfficientLRU: options.useEfficientLRU !== false, // Use efficient LRU by default
      ...options
    };
    
    // Initialize primary cache (efficient LRU or core cache manager)
    if (this.options.useEfficientLRU) {
      this.primaryCache = new EfficientLRUCache({
        maxSize: options.maxSize || 10000,
        maxMemoryBytes: this.options.maxMemorySize,
        defaultTTL: this.options.defaultTTL,
        enableMetrics: this.options.enableMetrics,
        ...options
      });
      this.logger.info('Using efficient LRU cache as primary cache');
    } else {
      // Fallback to core cache manager
      this.primaryCache = new CoreCacheManager({
        maxMemorySize: this.options.maxMemorySize,
        defaultTTL: this.options.defaultTTL,
        enableStatistics: this.options.enableMetrics,
        ...options
      });
      this.logger.info('Using core cache manager as primary cache');
    }
    
    // Keep reference to core cache for compatibility
    this.coreCache = this.primaryCache;
    
    // Initialize advanced caching system (optional)
    if (this.options.enableAdvancedFeatures) {
      this.advancedCache = new AdvancedCachingSystem({
        maxSize: this.options.maxMemorySize,
        enablePrefetching: this.options.enablePrefetching,
        enableMetrics: this.options.enableMetrics,
        ...options
      });
      
      this.logger.info('Advanced caching features enabled');
    }
    
    // Forward events from underlying caches
    this.setupEventForwarding();
    
    // Start metrics collection if enabled
    if (this.options.enableMetrics) {
      this.startMetricsCollection();
    }
  }
  
  /**
   * Get value from cache
   */
  async get(key, options = {}) {
    try {
      // Use advanced cache for prefetching or pattern analysis
      if (this.advancedCache && (options.prefetch || this.options.enablePatternAnalysis)) {
        const result = await this.advancedCache.get(key, options);
        if (result !== undefined) {
          this.emit('hit', { key, source: 'advanced' });
          return result;
        }
      }
      
      // Fall back to primary cache
      const result = await this.primaryCache.get(key, options);
      if (result !== undefined) {
        this.emit('hit', { key, source: 'primary' });
        return result;
      }
      
      this.emit('miss', { key });
      return undefined;
      
    } catch (error) {
      this.logger.error('Cache get error:', error);
      this.emit('error', { operation: 'get', key, error });
      return undefined;
    }
  }
  
  /**
   * Set value in cache
   */
  async set(key, value, options = {}) {
    try {
      const ttl = options.ttl || this.options.defaultTTL;
      
      // Set in both caches if advanced features are enabled
      if (this.advancedCache) {
        await this.advancedCache.set(key, value, { ttl, ...options });
      }
      
      // Always set in primary cache
      await this.primaryCache.set(key, value, { ttl, ...options });
      
      this.emit('set', { key, ttl });
      return true;
      
    } catch (error) {
      this.logger.error('Cache set error:', error);
      this.emit('error', { operation: 'set', key, error });
      return false;
    }
  }
  
  /**
   * Delete value from cache
   */
  async delete(key) {
    try {
      let deleted = false;
      
      // Delete from both caches
      if (this.advancedCache) {
        await this.advancedCache.delete(key);
        deleted = true;
      }
      
      deleted = await this.primaryCache.delete(key) || deleted;
      
      if (deleted) {
        this.emit('delete', { key });
      }
      
      return deleted;
      
    } catch (error) {
      this.logger.error('Cache delete error:', error);
      this.emit('error', { operation: 'delete', key, error });
      return false;
    }
  }
  
  /**
   * Clear entire cache
   */
  async clear() {
    try {
      if (this.advancedCache) {
        await this.advancedCache.clear();
      }
      
      await this.primaryCache.clear();
      
      this.emit('clear');
      return true;
      
    } catch (error) {
      this.logger.error('Cache clear error:', error);
      this.emit('error', { operation: 'clear', error });
      return false;
    }
  }
  
  /**
   * Check if key exists
   */
  async has(key) {
    if (this.advancedCache && await this.advancedCache.has(key)) {
      return true;
    }
    
    return this.primaryCache.has(key);
  }
  
  /**
   * Get multiple values
   */
  async mget(keys) {
    const results = {};
    
    // Batch get from appropriate cache
    if (this.advancedCache && this.options.enablePatternAnalysis) {
      // Use advanced cache for pattern analysis
      for (const key of keys) {
        results[key] = await this.advancedCache.get(key);
      }
    } else {
      // Use core cache batch operation
      const values = this.primaryCache.mget ? await this.primaryCache.mget(keys) : {};
      keys.forEach((key, index) => {
        results[key] = values[index];
      });
    }
    
    return results;
  }
  
  /**
   * Set multiple values
   */
  async mset(entries, options = {}) {
    try {
      const ttl = options.ttl || this.options.defaultTTL;
      
      // Convert to array format for core cache
      const keys = [];
      const values = [];
      
      for (const [key, value] of Object.entries(entries)) {
        keys.push(key);
        values.push(value);
      }
      
      // Set in both caches
      if (this.advancedCache) {
        for (const [key, value] of Object.entries(entries)) {
          await this.advancedCache.set(key, value, { ttl });
        }
      }
      
      if (this.primaryCache.mset) { await this.primaryCache.mset(values, { ttl }); }
      
      return true;
      
    } catch (error) {
      this.logger.error('Cache mset error:', error);
      return false;
    }
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    const stats = {
      primary: this.primaryCache.getStats ? this.primaryCache.getStats() : this.primaryCache.getStatistics(),
      advanced: this.advancedCache ? this.advancedCache.getMetrics() : null,
      unified: {
        totalOperations: 0,
        hitRate: 0,
        missRate: 0,
        errorRate: 0
      }
    };
    
    // Calculate unified statistics
    if (stats.core) {
      stats.unified.totalOperations = stats.core.totalOperations;
      stats.unified.hitRate = stats.core.hitRate;
      stats.unified.missRate = stats.core.missRate;
    }
    
    return stats;
  }
  
  /**
   * Optimize cache based on usage patterns
   */
  async optimize() {
    // Optimize core cache
    if (this.primaryCache.optimizeCache) {
      await this.primaryCache.optimizeCache();
    }
    
    // Optimize advanced cache
    if (this.advancedCache && this.advancedCache.analyzePatterns) {
      const patterns = await this.advancedCache.analyzePatterns();
      this.logger.info('Cache access patterns:', patterns);
    }
    
    this.emit('optimized');
  }
  
  /**
   * Setup event forwarding from underlying caches
   */
  setupEventForwarding() {
    // Forward core cache events
    this.primaryCache.on('hit', (data) => this.emit('cache:hit', { ...data, source: 'primary' }));
    this.primaryCache.on('miss', (data) => this.emit('cache:miss', { ...data, source: 'primary' }));
    this.primaryCache.on('evict', (data) => this.emit('cache:evict', { ...data, source: 'primary' }));
    this.primaryCache.on('eviction', (data) => this.emit('cache:evict', { ...data, source: 'primary' }));
    
    // Forward advanced cache events if enabled
    if (this.advancedCache) {
      this.advancedCache.on('prefetch', (data) => this.emit('cache:prefetch', data));
      this.advancedCache.on('pattern', (data) => this.emit('cache:pattern', data));
    }
  }
  
  /**
   * Start metrics collection
   */
  startMetricsCollection() {
    this.metricsInterval = setInterval(() => {
      const stats = this.getStats();
      this.emit('metrics', stats);
    }, 60000); // Every minute
  }
  
  /**
   * Create cache-aside wrapper
   */
  createCacheAside(fetcher, options = {}) {
    return async (key, ...args) => {
      // Try cache first
      const cached = await this.get(key);
      if (cached !== undefined) {
        return cached;
      }
      
      // Fetch and cache
      const value = await fetcher(key, ...args);
      if (value !== undefined) {
        await this.set(key, value, options);
      }
      
      return value;
    };
  }
  
  /**
   * Create memoized function
   */
  memoize(fn, options = {}) {
    const keyGenerator = options.keyGenerator || ((...args) => JSON.stringify(args));
    
    return async (...args) => {
      const key = `memoize:${fn.name}:${keyGenerator(...args)}`;
      
      const cached = await this.get(key);
      if (cached !== undefined) {
        return cached;
      }
      
      const result = await fn(...args);
      await this.set(key, result, options);
      
      return result;
    };
  }
  
  /**
   * Cleanup resources
   */
  async destroy() {
    // Stop metrics collection
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    
    // Destroy underlying caches
    if (this.primaryCache.destroy) {
      await this.primaryCache.destroy();
    } else if (this.primaryCache.shutdown) {
      await this.primaryCache.shutdown();
    }
    
    if (this.advancedCache && this.advancedCache.destroy) {
      await this.advancedCache.destroy();
    }
    
    this.removeAllListeners();
  }
}

/**
 * Factory function for creating domain-specific caches
 */
export function createCache(domain, options = {}) {
  const domainConfigs = {
    pool: {
      defaultTTL: 5000, // 5 seconds for mining pool data
      enableAdvancedFeatures: true,
      enablePrefetching: true
    },
    dex: {
      defaultTTL: 1000, // 1 second for DEX data
      enableAdvancedFeatures: true,
      enablePatternAnalysis: true
    },
    defi: {
      defaultTTL: 10000, // 10 seconds for DeFi data
      enableAdvancedFeatures: true
    },
    api: {
      defaultTTL: 60000, // 1 minute for API responses
      enableAdvancedFeatures: false // Basic caching for API
    },
    session: {
      defaultTTL: 3600000, // 1 hour for sessions
      enableAdvancedFeatures: false
    }
  };
  
  const config = domainConfigs[domain] || {};
  return new UnifiedCacheManager({ ...config, ...options });
}

// Export singleton instance
let defaultCache;

export function getDefaultCache() {
  if (!defaultCache) {
    defaultCache = new UnifiedCacheManager();
  }
  return defaultCache;
}

export default UnifiedCacheManager;