/**
 * Enhanced Rate Limiting System
 * Multi-layered rate limiting with sliding windows, token buckets, and intelligent throttling
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

const logger = getLogger('EnhancedRateLimiter');

// Rate limiting algorithms
export const RateLimitAlgorithm = {
  SLIDING_WINDOW: 'sliding_window',
  TOKEN_BUCKET: 'token_bucket',
  FIXED_WINDOW: 'fixed_window',
  ADAPTIVE: 'adaptive'
};

// Rate limit types
export const RateLimitType = {
  IP: 'ip',
  USER: 'user',
  ENDPOINT: 'endpoint',
  GLOBAL: 'global'
};

/**
 * Sliding Window Rate Limiter
 * More accurate than fixed window, prevents burst attacks
 */
class SlidingWindowLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.requests = new Map(); // key -> array of timestamps
  }

  async checkLimit(key) {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    
    // Get or create request history
    if (!this.requests.has(key)) {
      this.requests.set(key, []);
    }
    
    const requestTimes = this.requests.get(key);
    
    // Remove old requests outside the window
    while (requestTimes.length > 0 && requestTimes[0] < windowStart) {
      requestTimes.shift();
    }
    
    // Check if limit exceeded
    if (requestTimes.length >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: requestTimes[0] + this.windowMs,
        retryAfter: Math.ceil((requestTimes[0] + this.windowMs - now) / 1000)
      };
    }
    
    // Add current request
    requestTimes.push(now);
    
    return {
      allowed: true,
      remaining: this.limit - requestTimes.length,
      resetTime: now + this.windowMs
    };
  }

  cleanup() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, times] of this.requests) {
      const filtered = times.filter(time => time > cutoff);
      if (filtered.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, filtered);
      }
    }
  }
}

/**
 * Token Bucket Rate Limiter
 * Allows bursts while maintaining average rate
 */
class TokenBucketLimiter {
  constructor(capacity, refillRate, refillPeriod = 1000) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.refillPeriod = refillPeriod;
    this.buckets = new Map(); // key -> { tokens, lastRefill }
  }

  async checkLimit(key, cost = 1) {
    const now = Date.now();
    
    // Get or create bucket
    if (!this.buckets.has(key)) {
      this.buckets.set(key, {
        tokens: this.capacity,
        lastRefill: now
      });
    }
    
    const bucket = this.buckets.get(key);
    
    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = Math.floor((elapsed / this.refillPeriod) * this.refillRate);
    
    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }
    
    // Check if we have enough tokens
    if (bucket.tokens < cost) {
      const timeToRefill = Math.ceil((cost - bucket.tokens) / this.refillRate * this.refillPeriod / 1000);
      return {
        allowed: false,
        remaining: bucket.tokens,
        retryAfter: timeToRefill
      };
    }
    
    // Consume tokens
    bucket.tokens -= cost;
    
    return {
      allowed: true,
      remaining: bucket.tokens
    };
  }

  cleanup() {
    const cutoff = Date.now() - this.refillPeriod * 10; // Keep buckets for 10 refill periods
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) {
        this.buckets.delete(key);
      }
    }
  }
}

/**
 * Adaptive Rate Limiter
 * Adjusts limits based on system load and user behavior
 */
class AdaptiveLimiter {
  constructor(baseLimit, windowMs) {
    this.baseLimit = baseLimit;
    this.windowMs = windowMs;
    this.userProfiles = new Map(); // key -> profile
    this.systemLoad = 0;
  }

  async checkLimit(key, context = {}) {
    const now = Date.now();
    
    // Get or create user profile
    if (!this.userProfiles.has(key)) {
      this.userProfiles.set(key, {
        requests: [],
        trustScore: 50, // Start with neutral trust
        violations: 0,
        lastActivity: now
      });
    }
    
    const profile = this.userProfiles.get(key);
    
    // Calculate adaptive limit based on trust score and system load
    const trustMultiplier = profile.trustScore / 50; // 0.5 to 2.0
    const loadMultiplier = Math.max(0.1, 1 - this.systemLoad); // Reduce limit under high load
    const adaptiveLimit = Math.floor(this.baseLimit * trustMultiplier * loadMultiplier);
    
    // Use sliding window for request tracking
    const windowStart = now - this.windowMs;
    profile.requests = profile.requests.filter(time => time > windowStart);
    
    // Check limit
    if (profile.requests.length >= adaptiveLimit) {
      // Penalize repeated violations
      profile.violations++;
      profile.trustScore = Math.max(10, profile.trustScore - 5);
      
      return {
        allowed: false,
        remaining: 0,
        adaptiveLimit,
        trustScore: profile.trustScore,
        retryAfter: Math.ceil((profile.requests[0] + this.windowMs - now) / 1000)
      };
    }
    
    // Add request and update profile
    profile.requests.push(now);
    profile.lastActivity = now;
    
    // Improve trust score for good behavior
    if (profile.violations === 0 && profile.requests.length < adaptiveLimit * 0.5) {
      profile.trustScore = Math.min(100, profile.trustScore + 0.1);
    }
    
    return {
      allowed: true,
      remaining: adaptiveLimit - profile.requests.length,
      adaptiveLimit,
      trustScore: profile.trustScore
    };
  }

  updateSystemLoad(load) {
    this.systemLoad = Math.max(0, Math.min(1, load));
  }

  cleanup() {
    const cutoff = Date.now() - this.windowMs * 2;
    for (const [key, profile] of this.userProfiles) {
      if (profile.lastActivity < cutoff) {
        this.userProfiles.delete(key);
      }
    }
  }
}

/**
 * Enhanced Rate Limiter with multiple strategies
 */
export class EnhancedRateLimiter extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      algorithm: options.algorithm || RateLimitAlgorithm.SLIDING_WINDOW,
      cleanupInterval: options.cleanupInterval || 60000, // 1 minute
      enableSystemLoadTracking: options.enableSystemLoadTracking !== false,
      ...options
    };
    
    // Rate limit configurations
    this.limits = new Map(); // limitName -> limiter instance
    this.globalStats = new Map(); // type -> stats
    
    // System monitoring
    this.systemLoad = 0;
    this.cpuUsage = 0;
    this.memoryUsage = 0;
    
    // Start cleanup and monitoring
    this.startCleanup();
    if (this.options.enableSystemLoadTracking) {
      this.startSystemMonitoring();
    }
  }

  /**
   * Add a rate limit configuration
   */
  addLimit(name, config) {
    const {
      type = RateLimitType.IP,
      algorithm = this.options.algorithm,
      limit,
      windowMs = 60000,
      capacity,
      refillRate,
      refillPeriod
    } = config;

    let limiter;
    
    switch (algorithm) {
      case RateLimitAlgorithm.SLIDING_WINDOW:
        limiter = new SlidingWindowLimiter(limit, windowMs);
        break;
        
      case RateLimitAlgorithm.TOKEN_BUCKET:
        limiter = new TokenBucketLimiter(
          capacity || limit,
          refillRate || limit,
          refillPeriod
        );
        break;
        
      case RateLimitAlgorithm.ADAPTIVE:
        limiter = new AdaptiveLimiter(limit, windowMs);
        break;
        
      default:
        limiter = new SlidingWindowLimiter(limit, windowMs);
    }
    
    this.limits.set(name, {
      limiter,
      type,
      algorithm,
      config: { ...config }
    });
    
    // Initialize stats
    this.globalStats.set(name, {
      requests: 0,
      allowed: 0,
      denied: 0,
      lastReset: Date.now()
    });
    
    logger.info(`Added rate limit: ${name} (${algorithm}, ${limit}/${windowMs}ms)`);
  }

  /**
   * Check rate limit
   */
  async checkLimit(limitName, key, context = {}) {
    const limitConfig = this.limits.get(limitName);
    if (!limitConfig) {
      logger.warn(`Rate limit not found: ${limitName}`);
      return { allowed: true, remaining: Infinity };
    }

    const { limiter, type, algorithm } = limitConfig;
    const stats = this.globalStats.get(limitName);
    
    // Generate key based on type
    const rateLimitKey = this.generateKey(type, key, limitName);
    
    // Update system load for adaptive limiters
    if (algorithm === RateLimitAlgorithm.ADAPTIVE && limiter.updateSystemLoad) {
      limiter.updateSystemLoad(this.systemLoad);
    }
    
    // Check the limit
    const result = await limiter.checkLimit(rateLimitKey, context.cost || 1);
    
    // Update statistics
    stats.requests++;
    if (result.allowed) {
      stats.allowed++;
    } else {
      stats.denied++;
      
      // Emit rate limit exceeded event
      this.emit('limit:exceeded', {
        limitName,
        key: rateLimitKey,
        algorithm,
        result,
        context
      });
      
      logger.warn(`Rate limit exceeded: ${limitName} for ${rateLimitKey}`);
    }
    
    return {
      ...result,
      limitName,
      algorithm,
      key: rateLimitKey
    };
  }

  /**
   * Check multiple rate limits
   */
  async checkMultipleLimits(limitNames, key, context = {}) {
    const results = [];
    let allowed = true;
    let minRemaining = Infinity;
    let maxRetryAfter = 0;
    
    for (const limitName of limitNames) {
      const result = await this.checkLimit(limitName, key, context);
      results.push(result);
      
      if (!result.allowed) {
        allowed = false;
        maxRetryAfter = Math.max(maxRetryAfter, result.retryAfter || 0);
      }
      
      if (result.remaining < minRemaining) {
        minRemaining = result.remaining;
      }
    }
    
    return {
      allowed,
      remaining: minRemaining === Infinity ? 0 : minRemaining,
      retryAfter: maxRetryAfter,
      results,
      limitNames
    };
  }

  /**
   * Get rate limit status for debugging
   */
  async getStatus(limitName, key) {
    const limitConfig = this.limits.get(limitName);
    if (!limitConfig) {
      return null;
    }

    const rateLimitKey = this.generateKey(limitConfig.type, key, limitName);
    const result = await limitConfig.limiter.checkLimit(rateLimitKey, 0); // Check without consuming
    
    return {
      limitName,
      key: rateLimitKey,
      algorithm: limitConfig.algorithm,
      config: limitConfig.config,
      status: result,
      stats: this.globalStats.get(limitName)
    };
  }

  /**
   * Reset rate limit for a key
   */
  resetLimit(limitName, key) {
    const limitConfig = this.limits.get(limitName);
    if (!limitConfig) {
      return false;
    }

    const rateLimitKey = this.generateKey(limitConfig.type, key, limitName);
    const { limiter } = limitConfig;
    
    // Reset based on algorithm
    if (limiter.requests && limiter.requests.has(rateLimitKey)) {
      limiter.requests.delete(rateLimitKey);
    }
    
    if (limiter.buckets && limiter.buckets.has(rateLimitKey)) {
      const bucket = limiter.buckets.get(rateLimitKey);
      bucket.tokens = limiter.capacity;
      bucket.lastRefill = Date.now();
    }
    
    if (limiter.userProfiles && limiter.userProfiles.has(rateLimitKey)) {
      const profile = limiter.userProfiles.get(rateLimitKey);
      profile.requests = [];
      profile.violations = 0;
      profile.trustScore = Math.max(profile.trustScore, 50);
    }
    
    logger.info(`Reset rate limit: ${limitName} for ${rateLimitKey}`);
    return true;
  }

  /**
   * Get global statistics
   */
  getGlobalStats() {
    const stats = {};
    
    for (const [limitName, limitStats] of this.globalStats) {
      const successRate = limitStats.requests > 0 ? 
        (limitStats.allowed / limitStats.requests) * 100 : 100;
      
      stats[limitName] = {
        ...limitStats,
        successRate: successRate.toFixed(2),
        uptime: Date.now() - limitStats.lastReset
      };
    }
    
    return {
      limits: stats,
      system: {
        load: this.systemLoad,
        cpuUsage: this.cpuUsage,
        memoryUsage: this.memoryUsage
      },
      totalLimits: this.limits.size
    };
  }

  /**
   * Generate rate limit key based on type
   */
  generateKey(type, key, limitName) {
    switch (type) {
      case RateLimitType.IP:
        return `ip:${key}`;
      case RateLimitType.USER:
        return `user:${key}`;
      case RateLimitType.ENDPOINT:
        return `endpoint:${limitName}:${key}`;
      case RateLimitType.GLOBAL:
        return `global:${limitName}`;
      default:
        return `custom:${type}:${key}`;
    }
  }

  /**
   * Start cleanup process
   */
  startCleanup() {
    this.cleanupInterval = setInterval(() => {
      for (const [name, { limiter }] of this.limits) {
        if (limiter.cleanup) {
          limiter.cleanup();
        }
      }
      
      // Emit cleanup event
      this.emit('cleanup:completed', {
        timestamp: Date.now(),
        limitsProcessed: this.limits.size
      });
      
    }, this.options.cleanupInterval);
  }

  /**
   * Start system load monitoring
   */
  startSystemMonitoring() {
    this.monitoringInterval = setInterval(() => {
      try {
        // Monitor CPU usage
        const cpuUsage = process.cpuUsage();
        this.cpuUsage = (cpuUsage.user + cpuUsage.system) / 1000000; // Convert to seconds
        
        // Monitor memory usage
        const memUsage = process.memoryUsage();
        this.memoryUsage = memUsage.heapUsed / memUsage.heapTotal;
        
        // Calculate system load (simple heuristic)
        this.systemLoad = Math.max(this.cpuUsage / 100, this.memoryUsage);
        
        // Update adaptive limiters
        for (const [name, { limiter, algorithm }] of this.limits) {
          if (algorithm === RateLimitAlgorithm.ADAPTIVE && limiter.updateSystemLoad) {
            limiter.updateSystemLoad(this.systemLoad);
          }
        }
        
        this.emit('system:monitored', {
          load: this.systemLoad,
          cpu: this.cpuUsage,
          memory: this.memoryUsage
        });
        
      } catch (error) {
        logger.error('System monitoring error:', error);
      }
    }, 5000); // Every 5 seconds
  }

  /**
   * Stop the rate limiter
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    this.limits.clear();
    this.globalStats.clear();
    
    this.emit('stopped');
    logger.info('Enhanced rate limiter stopped');
  }
}

// Create singleton instance
let rateLimiterInstance = null;

/**
 * Get or create rate limiter instance
 */
export function getRateLimiter(options = {}) {
  if (!rateLimiterInstance) {
    rateLimiterInstance = new EnhancedRateLimiter(options);
    
    // Set up common rate limits
    rateLimiterInstance.addLimit('api:general', {
      type: RateLimitType.IP,
      algorithm: RateLimitAlgorithm.SLIDING_WINDOW,
      limit: 100,
      windowMs: 60000 // 100 requests per minute
    });
    
    rateLimiterInstance.addLimit('auth:login', {
      type: RateLimitType.IP,
      algorithm: RateLimitAlgorithm.TOKEN_BUCKET,
      capacity: 10,
      refillRate: 1,
      refillPeriod: 60000 // 1 token per minute, max 10
    });
    
    rateLimiterInstance.addLimit('trading:orders', {
      type: RateLimitType.USER,
      algorithm: RateLimitAlgorithm.ADAPTIVE,
      limit: 50,
      windowMs: 60000 // Adaptive based on user trust
    });
    
    rateLimiterInstance.addLimit('mining:shares', {
      type: RateLimitType.IP,
      algorithm: RateLimitAlgorithm.TOKEN_BUCKET,
      capacity: 1000,
      refillRate: 100,
      refillPeriod: 1000 // High throughput for mining
    });
  }
  
  return rateLimiterInstance;
}

export default EnhancedRateLimiter;