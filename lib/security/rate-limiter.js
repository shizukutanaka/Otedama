/**
 * Advanced Rate Limiter
 * Token bucket algorithm with sliding window and distributed support
 */

import { EventEmitter } from 'events';
import { LRUCache } from 'lru-cache';

export class RateLimiter extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Default limits
      windowMs: options.windowMs || 60000, // 1 minute
      max: options.max || 100, // requests per window
      
      // Token bucket config
      bucketSize: options.bucketSize || 10,
      refillRate: options.refillRate || 1, // tokens per second
      
      // Advanced options
      skipSuccessfulRequests: options.skipSuccessfulRequests || false,
      skipFailedRequests: options.skipFailedRequests || false,
      
      // Key generator
      keyGenerator: options.keyGenerator || ((req) => {
        return req.ip || 
               req.headers['x-forwarded-for']?.split(',')[0] || 
               req.headers['x-real-ip'] || 
               req.connection?.remoteAddress ||
               'unknown';
      }),
      
      // Response handling
      standardHeaders: options.standardHeaders !== false,
      legacyHeaders: options.legacyHeaders !== false,
      
      // Store configuration
      store: options.store || 'memory',
      redis: options.redis || null,
      
      // Handler functions
      handler: options.handler || this.defaultHandler.bind(this),
      onLimitReached: options.onLimitReached || null
    };
    
    // Initialize store
    this.initializeStore();
    
    // Metrics
    this.metrics = {
      totalRequests: 0,
      limitedRequests: 0,
      successfulRequests: 0,
      failedRequests: 0
    };
  }

  async initialize() {
    if (this.config.store === 'redis' && this.config.redis) {
      // Initialize Redis connection
      this.emit('store:redis:connected');
    }
    
    this.emit('initialized');
  }

  initializeStore() {
    if (this.config.store === 'memory') {
      this.store = new LRUCache({
        max: 10000,
        ttl: this.config.windowMs
      });
    } else if (this.config.store === 'redis') {
      // Redis store will be initialized in initialize()
      this.store = null;
    }
  }

  async consume(key, tokens = 1) {
    this.metrics.totalRequests++;
    
    if (this.config.store === 'memory') {
      return this.consumeFromMemory(key, tokens);
    } else if (this.config.store === 'redis') {
      return this.consumeFromRedis(key, tokens);
    }
  }

  consumeFromMemory(key, tokens) {
    const now = Date.now();
    let bucket = this.store.get(key);
    
    if (!bucket) {
      bucket = {
        tokens: this.config.bucketSize,
        lastRefill: now,
        requests: []
      };
    }
    
    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    const refillAmount = (elapsed / 1000) * this.config.refillRate;
    bucket.tokens = Math.min(this.config.bucketSize, bucket.tokens + refillAmount);
    bucket.lastRefill = now;
    
    // Clean old requests (sliding window)
    bucket.requests = bucket.requests.filter(timestamp => 
      now - timestamp < this.config.windowMs
    );
    
    // Check sliding window limit
    if (bucket.requests.length >= this.config.max) {
      this.metrics.limitedRequests++;
      return {
        allowed: false,
        remaining: 0,
        resetAt: bucket.requests[0] + this.config.windowMs,
        retryAfter: Math.ceil((bucket.requests[0] + this.config.windowMs - now) / 1000)
      };
    }
    
    // Check token bucket
    if (bucket.tokens < tokens) {
      this.metrics.limitedRequests++;
      const retryAfter = Math.ceil((tokens - bucket.tokens) / this.config.refillRate);
      return {
        allowed: false,
        remaining: Math.floor(bucket.tokens),
        resetAt: now + (retryAfter * 1000),
        retryAfter
      };
    }
    
    // Consume tokens
    bucket.tokens -= tokens;
    bucket.requests.push(now);
    
    // Store updated bucket
    this.store.set(key, bucket);
    
    this.metrics.successfulRequests++;
    
    return {
      allowed: true,
      remaining: Math.max(0, this.config.max - bucket.requests.length),
      resetAt: bucket.requests[0] + this.config.windowMs,
      retryAfter: 0
    };
  }

  async consumeFromRedis(key, tokens) {
    // Redis implementation would go here
    // For now, fallback to memory
    return this.consumeFromMemory(key, tokens);
  }

  middleware(options = {}) {
    const config = { ...this.config, ...options };
    
    return async (req, res, next) => {
      const key = config.keyGenerator(req);
      const result = await this.consume(key);
      
      // Add headers
      if (config.standardHeaders) {
        res.setHeader('RateLimit-Limit', config.max);
        res.setHeader('RateLimit-Remaining', result.remaining);
        res.setHeader('RateLimit-Reset', new Date(result.resetAt).toISOString());
      }
      
      if (config.legacyHeaders) {
        res.setHeader('X-RateLimit-Limit', config.max);
        res.setHeader('X-RateLimit-Remaining', result.remaining);
        res.setHeader('X-RateLimit-Reset', new Date(result.resetAt).toISOString());
      }
      
      if (!result.allowed) {
        res.setHeader('Retry-After', result.retryAfter);
        
        if (config.onLimitReached) {
          config.onLimitReached(req, res, result);
        }
        
        return config.handler(req, res, next, result);
      }
      
      // Track response status for conditional limiting
      if (config.skipSuccessfulRequests || config.skipFailedRequests) {
        const originalSend = res.send;
        res.send = function(...args) {
          const shouldRefund = 
            (config.skipSuccessfulRequests && res.statusCode < 400) ||
            (config.skipFailedRequests && res.statusCode >= 400);
          
          if (shouldRefund) {
            // Refund the token
            const bucket = this.store.get(key);
            if (bucket) {
              bucket.tokens = Math.min(config.bucketSize, bucket.tokens + 1);
              bucket.requests.pop();
              this.store.set(key, bucket);
            }
          }
          
          return originalSend.apply(res, args);
        }.bind(this);
      }
      
      next();
    };
  }

  defaultHandler(req, res, next, result) {
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded',
      retryAfter: result.retryAfter,
      resetAt: new Date(result.resetAt).toISOString()
    });
  }

  reset(key) {
    if (this.config.store === 'memory') {
      this.store.delete(key);
    }
  }

  resetAll() {
    if (this.config.store === 'memory') {
      this.store.clear();
    }
    
    this.metrics = {
      totalRequests: 0,
      limitedRequests: 0,
      successfulRequests: 0,
      failedRequests: 0
    };
  }

  getMetrics() {
    return {
      ...this.metrics,
      hitRate: this.metrics.totalRequests > 0 
        ? (this.metrics.successfulRequests / this.metrics.totalRequests) 
        : 0,
      limitRate: this.metrics.totalRequests > 0
        ? (this.metrics.limitedRequests / this.metrics.totalRequests)
        : 0
    };
  }

  async shutdown() {
    if (this.config.store === 'redis' && this.redis) {
      // Close Redis connection
      await this.redis.quit();
    }
    
    this.store?.clear();
    this.emit('shutdown');
  }
}

// Factory function
export function createRateLimiter(options) {
  return new RateLimiter(options);
}

// Preset configurations
export const RateLimiterPresets = {
  strict: {
    windowMs: 60000,
    max: 10,
    bucketSize: 5,
    refillRate: 0.5
  },
  standard: {
    windowMs: 60000,
    max: 100,
    bucketSize: 10,
    refillRate: 1
  },
  relaxed: {
    windowMs: 60000,
    max: 1000,
    bucketSize: 50,
    refillRate: 5
  },
  api: {
    windowMs: 3600000, // 1 hour
    max: 1000,
    bucketSize: 100,
    refillRate: 10,
    skipSuccessfulRequests: true
  }
};

export default RateLimiter;