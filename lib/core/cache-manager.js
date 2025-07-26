/**
 * Optimized Cache Manager
 * Lightweight multi-tier caching with minimal dependencies
 * 
 * Design: Memory-efficient caching (Carmack/Pike principles)
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from './structured-logger.js';

const logger = createStructuredLogger('CacheManager');

/**
 * Simple LRU Cache implementation
 */
class SimpleLRU {
  constructor(maxSize = 1000, ttl = 300000) {
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.cache = new Map();
    this.timers = new Map();
  }
  
  get(key) {
    const item = this.cache.get(key);
    if (!item) return undefined;
    
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, item);
    
    return item.value;
  }
  
  set(key, value, ttl = this.ttl) {
    // Remove oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      this.delete(firstKey);
    }
    
    // Clear existing timer
    this.clearTimer(key);
    
    // Set new value
    this.cache.set(key, { value, timestamp: Date.now() });
    
    // Set expiration timer
    if (ttl > 0) {
      const timer = setTimeout(() => this.delete(key), ttl);
      this.timers.set(key, timer);
    }
  }
  
  delete(key) {
    this.clearTimer(key);
    return this.cache.delete(key);
  }
  
  has(key) {
    return this.cache.has(key);
  }
  
  clear() {
    for (const [key] of this.timers) {
      this.clearTimer(key);
    }
    this.cache.clear();
  }
  
  clearTimer(key) {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }
  
  get size() {
    return this.cache.size;
  }
  
  purgeStale() {
    const now = Date.now();
    const staleKeys = [];
    
    for (const [key, item] of this.cache) {
      if (now - item.timestamp > this.ttl) {
        staleKeys.push(key);
      }
    }
    
    for (const key of staleKeys) {
      this.delete(key);
    }
  }
}

/**
 * Optimized Cache Manager
 */
export class CacheManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      maxSize: options.maxSize || 5000,        // Reduced from 10000
      ttl: options.ttl || 180000,              // 3 minutes (reduced from 5)
      enableMetrics: options.enableMetrics !== false,
      metricsInterval: options.metricsInterval || 60000,  // 1 minute
      ...options
    };
    
    // Single-tier memory cache (removed Redis for lightweight operation)
    this.cache = new SimpleLRU(this.config.maxSize, this.config.ttl);
    
    // Lightweight metrics
    this.metrics = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      hitRate: 0
    };
    
    this.initialized = false;
  }
  
  /**
   * Initialize cache manager
   */
  async initialize() {
    if (this.initialized) return;
    
    // Start metrics collection
    if (this.config.enableMetrics) {
      this.metricsTimer = setInterval(() => {
        this.updateMetrics();
      }, this.config.metricsInterval);
    }
    
    // Periodic stale cleanup
    this.cleanupTimer = setInterval(() => {
      this.cache.purgeStale();
    }, 60000); // Every minute
    
    this.initialized = true;
    logger.info('Optimized cache manager initialized');
  }
  
  /**
   * Get value from cache
   */
  async get(key) {
    const value = this.cache.get(key);
    
    if (value !== undefined) {
      this.metrics.hits++;
      return value;
    }
    
    this.metrics.misses++;
    return undefined;
  }
  
  /**
   * Set value in cache
   */
  async set(key, value, options = {}) {
    const ttl = options.ttl || this.config.ttl;
    this.cache.set(key, value, ttl);
    this.metrics.sets++;
    return true;
  }
  
  /**
   * Delete value from cache
   */
  async delete(key) {
    const deleted = this.cache.delete(key);
    if (deleted) {
      this.metrics.deletes++;
    }
    return deleted;
  }
  
  /**
   * Check if key exists
   */
  async has(key) {
    return this.cache.has(key);
  }
  
  /**
   * Get multiple values
   */
  async mget(keys) {
    const results = new Map();
    
    for (const key of keys) {
      const value = this.cache.get(key);
      if (value !== undefined) {
        results.set(key, value);
        this.metrics.hits++;
      } else {
        this.metrics.misses++;
      }
    }
    
    return results;
  }
  
  /**
   * Set multiple values
   */
  async mset(entries, options = {}) {
    for (const [key, value] of entries) {
      await this.set(key, value, options);
    }
    return true;
  }
  
  /**
   * Clear cache
   */
  async clear() {
    this.cache.clear();
    return true;
  }
  
  /**
   * Update metrics
   */
  updateMetrics() {
    const total = this.metrics.hits + this.metrics.misses;
    this.metrics.hitRate = total > 0 ? this.metrics.hits / total : 0;
    
    this.emit('metrics', this.getMetrics());
  }
  
  /**
   * Get metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      size: this.cache.size,
      maxSize: this.config.maxSize,
      memoryUsage: process.memoryUsage().heapUsed
    };
  }
  
  /**
   * Get status
   */
  getStatus() {
    return {
      initialized: this.initialized,
      size: this.cache.size,
      maxSize: this.config.maxSize,
      ttl: this.config.ttl,
      metrics: this.getMetrics()
    };
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
    }
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    this.cache.clear();
    this.initialized = false;
    
    logger.info('Cache manager shut down');
  }
}

// Singleton instance
export const cacheManager = new CacheManager();

export default CacheManager;