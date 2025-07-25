/**
 * Rate Limiter - Otedama
 * Advanced rate limiting and throttling
 * 
 * Design: Protect resources, be fair (Pike)
 */

import { EventEmitter } from 'events';
import { RateLimitError } from './errors.js';
import { createLogger } from './logger.js';

const logger = createLogger('RateLimiter');

/**
 * Token bucket algorithm implementation
 */
export class TokenBucket {
  constructor(capacity, refillRate) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate; // tokens per second
    this.lastRefill = Date.now();
  }
  
  consume(tokens = 1) {
    this.refill();
    
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    
    return false;
  }
  
  refill() {
    const now = Date.now();
    const timePassed = (now - this.lastRefill) / 1000;
    const tokensToAdd = timePassed * this.refillRate;
    
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
  
  getTokens() {
    this.refill();
    return this.tokens;
  }
  
  reset() {
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }
}

/**
 * Sliding window rate limiter
 */
export class SlidingWindowLimiter {
  constructor(windowSize, limit) {
    this.windowSize = windowSize; // milliseconds
    this.limit = limit;
    this.requests = [];
  }
  
  canMakeRequest() {
    const now = Date.now();
    const windowStart = now - this.windowSize;
    
    // Remove old requests
    this.requests = this.requests.filter(time => time > windowStart);
    
    // Check limit
    if (this.requests.length < this.limit) {
      this.requests.push(now);
      return true;
    }
    
    return false;
  }
  
  getCount() {
    const now = Date.now();
    const windowStart = now - this.windowSize;
    
    this.requests = this.requests.filter(time => time > windowStart);
    return this.requests.length;
  }
  
  reset() {
    this.requests = [];
  }
}

/**
 * Advanced rate limiter with multiple strategies
 */
export class RateLimiter extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Default limits
      requestsPerSecond: options.requestsPerSecond || 10,
      requestsPerMinute: options.requestsPerMinute || 100,
      requestsPerHour: options.requestsPerHour || 1000,
      
      // Burst handling
      burstCapacity: options.burstCapacity || 20,
      
      // Strategy
      strategy: options.strategy || 'token-bucket', // 'token-bucket', 'sliding-window', 'fixed-window'
      
      // Storage
      storage: options.storage || 'memory', // 'memory', 'redis'
      
      // Behavior
      blockDuration: options.blockDuration || 60000, // 1 minute
      whiteList: options.whiteList || [],
      blackList: options.blackList || [],
      
      ...options
    };
    
    // Limiters by key
    this.limiters = new Map();
    this.blocked = new Map();
    
    // Stats
    this.stats = {
      allowed: 0,
      blocked: 0,
      throttled: 0
    };
    
    // Cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 60000); // Every minute
  }
  
  /**
   * Check if request is allowed
   */
  async check(key, cost = 1) {
    // Check whitelist
    if (this.options.whiteList.includes(key)) {
      this.stats.allowed++;
      return { allowed: true, remaining: Infinity };
    }
    
    // Check blacklist
    if (this.options.blackList.includes(key)) {
      this.stats.blocked++;
      throw new RateLimitError('Blacklisted');
    }
    
    // Check if blocked
    const blockInfo = this.blocked.get(key);
    if (blockInfo && Date.now() < blockInfo.until) {
      this.stats.blocked++;
      throw new RateLimitError(`Blocked until ${new Date(blockInfo.until).toISOString()}`);
    }
    
    // Get or create limiter
    const limiter = this.getLimiter(key);
    
    // Check rate limit
    const allowed = await this.checkLimit(limiter, cost);
    
    if (allowed) {
      this.stats.allowed++;
      
      return {
        allowed: true,
        remaining: this.getRemaining(limiter),
        resetAt: this.getResetTime(limiter)
      };
    } else {
      this.stats.throttled++;
      
      // Check if should block
      const violations = this.incrementViolations(key);
      
      if (violations >= 3) { // Block after 3 violations
        this.block(key);
        throw new RateLimitError('Too many violations, blocked');
      }
      
      throw new RateLimitError('Rate limit exceeded');
    }
  }
  
  /**
   * Get or create limiter for key
   */
  getLimiter(key) {
    if (!this.limiters.has(key)) {
      let limiter;
      
      switch (this.options.strategy) {
        case 'token-bucket':
          limiter = new TokenBucket(
            this.options.burstCapacity,
            this.options.requestsPerSecond
          );
          break;
          
        case 'sliding-window':
          limiter = new SlidingWindowLimiter(
            60000, // 1 minute window
            this.options.requestsPerMinute
          );
          break;
          
        default:
          throw new Error(`Unknown strategy: ${this.options.strategy}`);
      }
      
      this.limiters.set(key, {
        limiter,
        violations: 0,
        lastRequest: Date.now()
      });
    }
    
    return this.limiters.get(key);
  }
  
  /**
   * Check limit based on strategy
   */
  async checkLimit(limiterInfo, cost) {
    const { limiter } = limiterInfo;
    
    if (limiter instanceof TokenBucket) {
      return limiter.consume(cost);
    } else if (limiter instanceof SlidingWindowLimiter) {
      return limiter.canMakeRequest();
    }
    
    return false;
  }
  
  /**
   * Get remaining capacity
   */
  getRemaining(limiterInfo) {
    const { limiter } = limiterInfo;
    
    if (limiter instanceof TokenBucket) {
      return Math.floor(limiter.getTokens());
    } else if (limiter instanceof SlidingWindowLimiter) {
      return Math.max(0, limiter.limit - limiter.getCount());
    }
    
    return 0;
  }
  
  /**
   * Get reset time
   */
  getResetTime(limiterInfo) {
    if (limiterInfo.limiter instanceof TokenBucket) {
      // Tokens refill continuously
      return null;
    } else if (limiterInfo.limiter instanceof SlidingWindowLimiter) {
      // Window slides continuously
      return new Date(Date.now() + limiterInfo.limiter.windowSize);
    }
    
    return null;
  }
  
  /**
   * Increment violations
   */
  incrementViolations(key) {
    const limiterInfo = this.limiters.get(key);
    if (limiterInfo) {
      limiterInfo.violations++;
      return limiterInfo.violations;
    }
    return 0;
  }
  
  /**
   * Block a key
   */
  block(key, duration = this.options.blockDuration) {
    const until = Date.now() + duration;
    
    this.blocked.set(key, {
      since: Date.now(),
      until,
      reason: 'Rate limit violations'
    });
    
    logger.warn(`Blocked ${key} until ${new Date(until).toISOString()}`);
    
    this.emit('blocked', { key, until });
  }
  
  /**
   * Unblock a key
   */
  unblock(key) {
    const wasBlocked = this.blocked.delete(key);
    
    if (wasBlocked) {
      logger.info(`Unblocked ${key}`);
      this.emit('unblocked', { key });
    }
    
    return wasBlocked;
  }
  
  /**
   * Reset limiter for key
   */
  reset(key) {
    const limiterInfo = this.limiters.get(key);
    
    if (limiterInfo) {
      limiterInfo.violations = 0;
      
      if (limiterInfo.limiter instanceof TokenBucket) {
        limiterInfo.limiter.reset();
      } else if (limiterInfo.limiter instanceof SlidingWindowLimiter) {
        limiterInfo.limiter.reset();
      }
    }
    
    this.unblock(key);
  }
  
  /**
   * Cleanup old entries
   */
  cleanup() {
    const now = Date.now();
    const inactiveThreshold = 3600000; // 1 hour
    
    // Clean up inactive limiters
    for (const [key, info] of this.limiters) {
      if (now - info.lastRequest > inactiveThreshold) {
        this.limiters.delete(key);
      }
    }
    
    // Clean up expired blocks
    for (const [key, blockInfo] of this.blocked) {
      if (now > blockInfo.until) {
        this.unblock(key);
      }
    }
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeLimiters: this.limiters.size,
      blockedKeys: this.blocked.size,
      limits: {
        perSecond: this.options.requestsPerSecond,
        perMinute: this.options.requestsPerMinute,
        perHour: this.options.requestsPerHour
      }
    };
  }
  
  /**
   * Express middleware
   */
  middleware(keyExtractor = (req) => req.ip) {
    return async (req, res, next) => {
      const key = keyExtractor(req);
      
      try {
        const result = await this.check(key);
        
        // Set rate limit headers
        res.setHeader('X-RateLimit-Limit', this.options.requestsPerMinute);
        res.setHeader('X-RateLimit-Remaining', result.remaining);
        
        if (result.resetAt) {
          res.setHeader('X-RateLimit-Reset', Math.floor(result.resetAt.getTime() / 1000));
        }
        
        next();
      } catch (error) {
        if (error instanceof RateLimitError) {
          res.status(429).json({
            error: {
              message: error.message,
              code: 'RATE_LIMIT_EXCEEDED'
            }
          });
        } else {
          next(error);
        }
      }
    };
  }
  
  /**
   * Stop the rate limiter
   */
  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

/**
 * Distributed rate limiter using Redis
 */
export class DistributedRateLimiter extends RateLimiter {
  constructor(redisClient, options = {}) {
    super(options);
    this.redis = redisClient;
  }
  
  async checkLimit(key, cost) {
    const script = `
      local key = KEYS[1]
      local limit = tonumber(ARGV[1])
      local window = tonumber(ARGV[2])
      local cost = tonumber(ARGV[3])
      local now = tonumber(ARGV[4])
      
      local current = redis.call('GET', key)
      if current == false then
        current = 0
      else
        current = tonumber(current)
      end
      
      if current + cost <= limit then
        redis.call('INCRBY', key, cost)
        redis.call('EXPIRE', key, window)
        return 1
      else
        return 0
      end
    `;
    
    const result = await this.redis.eval(
      script,
      1,
      key,
      this.options.requestsPerMinute,
      60, // 1 minute window
      cost,
      Date.now()
    );
    
    return result === 1;
  }
}

// Singleton instance
export const rateLimiter = new RateLimiter();

export default {
  TokenBucket,
  SlidingWindowLimiter,
  RateLimiter,
  DistributedRateLimiter,
  rateLimiter
};
