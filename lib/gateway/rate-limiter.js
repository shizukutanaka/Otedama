/**
 * Rate Limiter for Otedama API Gateway
 * Advanced rate limiting with multiple algorithms
 * 
 * Design principles:
 * - Carmack: High-performance rate limiting
 * - Martin: Clean rate limiter design
 * - Pike: Simple rate limiting API
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { logger } from '../core/logger.js';

/**
 * Rate limiting algorithms
 */
export const RateLimitAlgorithm = {
  FIXED_WINDOW: 'fixed_window',
  SLIDING_WINDOW: 'sliding_window',
  TOKEN_BUCKET: 'token_bucket',
  LEAKY_BUCKET: 'leaky_bucket',
  SLIDING_LOG: 'sliding_log'
};

/**
 * Rate limit store types
 */
export const StoreType = {
  MEMORY: 'memory',
  REDIS: 'redis',
  DISTRIBUTED: 'distributed'
};

/**
 * Base rate limiter
 */
export class RateLimiter extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      algorithm: options.algorithm || RateLimitAlgorithm.SLIDING_WINDOW,
      windowMs: options.windowMs || 60000, // 1 minute
      max: options.max || 100,
      
      // Token bucket specific
      tokensPerInterval: options.tokensPerInterval || options.max,
      interval: options.interval || options.windowMs,
      maxTokens: options.maxTokens || options.max * 2,
      
      // Store configuration
      store: options.store || StoreType.MEMORY,
      storeOptions: options.storeOptions || {},
      
      // Advanced options
      keyGenerator: options.keyGenerator || ((req) => req.ip),
      skipSuccessfulRequests: options.skipSuccessfulRequests || false,
      skipFailedRequests: options.skipFailedRequests || false,
      
      // Headers
      standardHeaders: options.standardHeaders !== false,
      legacyHeaders: options.legacyHeaders !== false,
      
      // Handlers
      onLimitReached: options.onLimitReached,
      
      ...options
    };
    
    // Create store
    this.store = this._createStore();
    
    // Create algorithm implementation
    this.limiter = this._createLimiter();
    
    // Metrics
    this.metrics = {
      totalRequests: 0,
      allowedRequests: 0,
      blockedRequests: 0,
      uniqueKeys: new Set()
    };
  }
  
  /**
   * Check if request is allowed
   */
  async check(key, cost = 1) {
    this.metrics.totalRequests++;
    this.metrics.uniqueKeys.add(key);
    
    const allowed = await this.limiter.check(key, cost);
    
    if (allowed) {
      this.metrics.allowedRequests++;
    } else {
      this.metrics.blockedRequests++;
      
      if (this.options.onLimitReached) {
        this.options.onLimitReached(key);
      }
      
      this.emit('limit:reached', { key, cost });
    }
    
    return allowed;
  }
  
  /**
   * Reset limits for key
   */
  async reset(key) {
    await this.limiter.reset(key);
    this.emit('limit:reset', { key });
  }
  
  /**
   * Get current usage
   */
  async getUsage(key) {
    return this.limiter.getUsage(key);
  }
  
  /**
   * Create store
   */
  _createStore() {
    switch (this.options.store) {
      case StoreType.MEMORY:
        return new MemoryStore(this.options.storeOptions);
        
      case StoreType.REDIS:
        return new RedisStore(this.options.storeOptions);
        
      case StoreType.DISTRIBUTED:
        return new DistributedStore(this.options.storeOptions);
        
      default:
        throw new Error(`Unknown store type: ${this.options.store}`);
    }
  }
  
  /**
   * Create limiter implementation
   */
  _createLimiter() {
    switch (this.options.algorithm) {
      case RateLimitAlgorithm.FIXED_WINDOW:
        return new FixedWindowLimiter(this.options, this.store);
        
      case RateLimitAlgorithm.SLIDING_WINDOW:
        return new SlidingWindowLimiter(this.options, this.store);
        
      case RateLimitAlgorithm.TOKEN_BUCKET:
        return new TokenBucketLimiter(this.options, this.store);
        
      case RateLimitAlgorithm.LEAKY_BUCKET:
        return new LeakyBucketLimiter(this.options, this.store);
        
      case RateLimitAlgorithm.SLIDING_LOG:
        return new SlidingLogLimiter(this.options, this.store);
        
      default:
        throw new Error(`Unknown algorithm: ${this.options.algorithm}`);
    }
  }
  
  /**
   * Get rate limit headers
   */
  getHeaders(usage) {
    const headers = {};
    
    if (this.options.standardHeaders) {
      headers['RateLimit-Limit'] = this.options.max;
      headers['RateLimit-Remaining'] = Math.max(0, this.options.max - usage.count);
      headers['RateLimit-Reset'] = new Date(usage.resetTime).toISOString();
    }
    
    if (this.options.legacyHeaders) {
      headers['X-RateLimit-Limit'] = this.options.max;
      headers['X-RateLimit-Remaining'] = Math.max(0, this.options.max - usage.count);
      headers['X-RateLimit-Reset'] = Math.floor(usage.resetTime / 1000);
    }
    
    return headers;
  }
  
  /**
   * Get metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      uniqueKeys: this.metrics.uniqueKeys.size,
      blockedRate: this.metrics.totalRequests > 0 ?
        (this.metrics.blockedRequests / this.metrics.totalRequests * 100).toFixed(2) + '%' : '0%'
    };
  }
  
  /**
   * Clear all limits
   */
  async clear() {
    await this.store.clear();
    this.metrics = {
      totalRequests: 0,
      allowedRequests: 0,
      blockedRequests: 0,
      uniqueKeys: new Set()
    };
    
    this.emit('limits:cleared');
  }
}

/**
 * Memory store
 */
class MemoryStore {
  constructor(options = {}) {
    this.data = new Map();
    this.timers = new Map();
    this.ttl = options.ttl || 300000; // 5 minutes
  }
  
  async get(key) {
    return this.data.get(key);
  }
  
  async set(key, value, ttlMs) {
    this.data.set(key, value);
    
    // Set expiration
    const existingTimer = this.timers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    const timer = setTimeout(() => {
      this.data.delete(key);
      this.timers.delete(key);
    }, ttlMs || this.ttl);
    
    this.timers.set(key, timer);
  }
  
  async delete(key) {
    this.data.delete(key);
    
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }
  
  async clear() {
    this.data.clear();
    
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
  
  async increment(key, value = 1) {
    const current = this.data.get(key) || 0;
    const newValue = current + value;
    await this.set(key, newValue);
    return newValue;
  }
}

/**
 * Redis store (mock implementation)
 */
class RedisStore {
  constructor(options = {}) {
    // In production, use actual Redis client
    this.memory = new MemoryStore(options);
  }
  
  async get(key) {
    return this.memory.get(key);
  }
  
  async set(key, value, ttlMs) {
    return this.memory.set(key, value, ttlMs);
  }
  
  async delete(key) {
    return this.memory.delete(key);
  }
  
  async clear() {
    return this.memory.clear();
  }
  
  async increment(key, value = 1) {
    return this.memory.increment(key, value);
  }
}

/**
 * Distributed store (mock implementation)
 */
class DistributedStore {
  constructor(options = {}) {
    this.nodes = options.nodes || 3;
    this.stores = Array(this.nodes).fill(null).map(() => new MemoryStore(options));
  }
  
  _getNode(key) {
    const hash = createHash('sha256').update(key).digest();
    const index = hash.readUInt32BE(0) % this.nodes;
    return this.stores[index];
  }
  
  async get(key) {
    return this._getNode(key).get(key);
  }
  
  async set(key, value, ttlMs) {
    return this._getNode(key).set(key, value, ttlMs);
  }
  
  async delete(key) {
    return this._getNode(key).delete(key);
  }
  
  async clear() {
    await Promise.all(this.stores.map(store => store.clear()));
  }
  
  async increment(key, value = 1) {
    return this._getNode(key).increment(key, value);
  }
}

/**
 * Fixed window limiter
 */
class FixedWindowLimiter {
  constructor(options, store) {
    this.options = options;
    this.store = store;
  }
  
  async check(key, cost) {
    const windowKey = this._getWindowKey(key);
    const count = await this.store.get(windowKey) || 0;
    
    if (count + cost > this.options.max) {
      return false;
    }
    
    await this.store.increment(windowKey, cost);
    await this.store.set(windowKey, count + cost, this.options.windowMs);
    
    return true;
  }
  
  async reset(key) {
    const windowKey = this._getWindowKey(key);
    await this.store.delete(windowKey);
  }
  
  async getUsage(key) {
    const windowKey = this._getWindowKey(key);
    const count = await this.store.get(windowKey) || 0;
    const windowStart = Math.floor(Date.now() / this.options.windowMs) * this.options.windowMs;
    
    return {
      count,
      resetTime: windowStart + this.options.windowMs
    };
  }
  
  _getWindowKey(key) {
    const window = Math.floor(Date.now() / this.options.windowMs);
    return `${key}:${window}`;
  }
}

/**
 * Sliding window limiter
 */
class SlidingWindowLimiter {
  constructor(options, store) {
    this.options = options;
    this.store = store;
  }
  
  async check(key, cost) {
    const now = Date.now();
    const windowStart = now - this.options.windowMs;
    
    // Get current and previous window counts
    const currentWindow = Math.floor(now / this.options.windowMs);
    const previousWindow = currentWindow - 1;
    
    const currentKey = `${key}:${currentWindow}`;
    const previousKey = `${key}:${previousWindow}`;
    
    const currentCount = await this.store.get(currentKey) || 0;
    const previousCount = await this.store.get(previousKey) || 0;
    
    // Calculate weighted count
    const previousWindowTime = previousWindow * this.options.windowMs;
    const weight = (windowStart - previousWindowTime) / this.options.windowMs;
    const weightedCount = (previousCount * (1 - weight)) + currentCount;
    
    if (weightedCount + cost > this.options.max) {
      return false;
    }
    
    await this.store.increment(currentKey, cost);
    await this.store.set(currentKey, currentCount + cost, this.options.windowMs * 2);
    
    return true;
  }
  
  async reset(key) {
    const currentWindow = Math.floor(Date.now() / this.options.windowMs);
    const previousWindow = currentWindow - 1;
    
    await this.store.delete(`${key}:${currentWindow}`);
    await this.store.delete(`${key}:${previousWindow}`);
  }
  
  async getUsage(key) {
    const now = Date.now();
    const windowStart = now - this.options.windowMs;
    
    const currentWindow = Math.floor(now / this.options.windowMs);
    const previousWindow = currentWindow - 1;
    
    const currentCount = await this.store.get(`${key}:${currentWindow}`) || 0;
    const previousCount = await this.store.get(`${key}:${previousWindow}`) || 0;
    
    const previousWindowTime = previousWindow * this.options.windowMs;
    const weight = (windowStart - previousWindowTime) / this.options.windowMs;
    const count = Math.floor((previousCount * (1 - weight)) + currentCount);
    
    return {
      count,
      resetTime: (currentWindow + 1) * this.options.windowMs
    };
  }
}

/**
 * Token bucket limiter
 */
class TokenBucketLimiter {
  constructor(options, store) {
    this.options = options;
    this.store = store;
  }
  
  async check(key, cost) {
    const bucket = await this._getBucket(key);
    const now = Date.now();
    
    // Refill tokens
    const timePassed = now - bucket.lastRefill;
    const tokensToAdd = (timePassed / this.options.interval) * this.options.tokensPerInterval;
    bucket.tokens = Math.min(this.options.maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
    
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      await this._saveBucket(key, bucket);
      return true;
    }
    
    await this._saveBucket(key, bucket);
    return false;
  }
  
  async reset(key) {
    await this.store.delete(`${key}:bucket`);
  }
  
  async getUsage(key) {
    const bucket = await this._getBucket(key);
    const now = Date.now();
    
    // Calculate current tokens
    const timePassed = now - bucket.lastRefill;
    const tokensToAdd = (timePassed / this.options.interval) * this.options.tokensPerInterval;
    const currentTokens = Math.min(this.options.maxTokens, bucket.tokens + tokensToAdd);
    
    return {
      count: this.options.maxTokens - Math.floor(currentTokens),
      resetTime: now + ((this.options.maxTokens - currentTokens) / this.options.tokensPerInterval) * this.options.interval
    };
  }
  
  async _getBucket(key) {
    const bucketKey = `${key}:bucket`;
    const bucket = await this.store.get(bucketKey);
    
    if (!bucket) {
      return {
        tokens: this.options.maxTokens,
        lastRefill: Date.now()
      };
    }
    
    return bucket;
  }
  
  async _saveBucket(key, bucket) {
    const bucketKey = `${key}:bucket`;
    await this.store.set(bucketKey, bucket, this.options.windowMs * 2);
  }
}

/**
 * Leaky bucket limiter
 */
class LeakyBucketLimiter {
  constructor(options, store) {
    this.options = options;
    this.store = store;
    this.leakRate = options.max / options.windowMs; // requests per ms
  }
  
  async check(key, cost) {
    const bucket = await this._getBucket(key);
    const now = Date.now();
    
    // Leak requests
    const timePassed = now - bucket.lastLeak;
    const leaked = timePassed * this.leakRate;
    bucket.count = Math.max(0, bucket.count - leaked);
    bucket.lastLeak = now;
    
    if (bucket.count + cost <= this.options.max) {
      bucket.count += cost;
      await this._saveBucket(key, bucket);
      return true;
    }
    
    await this._saveBucket(key, bucket);
    return false;
  }
  
  async reset(key) {
    await this.store.delete(`${key}:leaky`);
  }
  
  async getUsage(key) {
    const bucket = await this._getBucket(key);
    const now = Date.now();
    
    // Calculate current count
    const timePassed = now - bucket.lastLeak;
    const leaked = timePassed * this.leakRate;
    const currentCount = Math.max(0, bucket.count - leaked);
    
    return {
      count: Math.floor(currentCount),
      resetTime: now + (currentCount / this.leakRate)
    };
  }
  
  async _getBucket(key) {
    const bucketKey = `${key}:leaky`;
    const bucket = await this.store.get(bucketKey);
    
    if (!bucket) {
      return {
        count: 0,
        lastLeak: Date.now()
      };
    }
    
    return bucket;
  }
  
  async _saveBucket(key, bucket) {
    const bucketKey = `${key}:leaky`;
    await this.store.set(bucketKey, bucket, this.options.windowMs * 2);
  }
}

/**
 * Sliding log limiter
 */
class SlidingLogLimiter {
  constructor(options, store) {
    this.options = options;
    this.store = store;
  }
  
  async check(key, cost) {
    const now = Date.now();
    const windowStart = now - this.options.windowMs;
    
    // Get log entries
    let log = await this._getLog(key);
    
    // Remove old entries
    log = log.filter(entry => entry.timestamp > windowStart);
    
    // Check if adding new entries would exceed limit
    const totalCost = log.reduce((sum, entry) => sum + entry.cost, 0) + cost;
    
    if (totalCost > this.options.max) {
      await this._saveLog(key, log);
      return false;
    }
    
    // Add new entry
    log.push({ timestamp: now, cost });
    await this._saveLog(key, log);
    
    return true;
  }
  
  async reset(key) {
    await this.store.delete(`${key}:log`);
  }
  
  async getUsage(key) {
    const now = Date.now();
    const windowStart = now - this.options.windowMs;
    
    let log = await this._getLog(key);
    log = log.filter(entry => entry.timestamp > windowStart);
    
    const count = log.reduce((sum, entry) => sum + entry.cost, 0);
    const oldestEntry = log.length > 0 ? log[0].timestamp : now;
    
    return {
      count,
      resetTime: oldestEntry + this.options.windowMs
    };
  }
  
  async _getLog(key) {
    const logKey = `${key}:log`;
    return await this.store.get(logKey) || [];
  }
  
  async _saveLog(key, log) {
    const logKey = `${key}:log`;
    await this.store.set(logKey, log, this.options.windowMs);
  }
}

export default RateLimiter;