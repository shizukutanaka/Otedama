/**
 * Unified Rate Limiting System - Otedama
 * High-performance rate limiting with multiple strategies
 * 
 * Design principles:
 * - Carmack: Zero-overhead rate limiting
 * - Martin: Clean rate limiting architecture
 * - Pike: Simple but effective
 */

import { RateLimiterMemory, RateLimiterRedis, RateLimiterCluster } from 'rate-limiter-flexible';
import { createStructuredLogger } from '../core/structured-logger.js';
import { memoryManager } from '../core/memory-manager.js';
import Redis from 'ioredis';

const logger = createStructuredLogger('RateLimitUnified');

/**
 * Rate limit strategies
 */
export const RateLimitStrategy = {
  MEMORY: 'memory',
  REDIS: 'redis',
  CLUSTER: 'cluster',
  ADAPTIVE: 'adaptive'
};

/**
 * Rate limit tiers
 */
export const RateLimitTier = {
  FREE: {
    points: 100,
    duration: 60, // per minute
    blockDuration: 300 // 5 minutes
  },
  BASIC: {
    points: 1000,
    duration: 60,
    blockDuration: 60
  },
  PRO: {
    points: 10000,
    duration: 60,
    blockDuration: 30
  },
  ENTERPRISE: {
    points: 100000,
    duration: 60,
    blockDuration: 10
  }
};

/**
 * Unified Rate Limiter
 */
export class UnifiedRateLimiter {
  constructor(config = {}) {
    this.config = {
      strategy: config.strategy || RateLimitStrategy.MEMORY,
      keyPrefix: config.keyPrefix || 'otedama_rl',
      redis: config.redis,
      defaultTier: config.defaultTier || RateLimitTier.FREE,
      enableBruteForce: config.enableBruteForce !== false,
      enableAdaptive: config.enableAdaptive || false,
      ...config
    };
    
    this.limiters = new Map();
    this.bruteForceMap = new Map();
    
    this.initialize();
  }
  
  initialize() {
    // Initialize rate limiters for each tier
    Object.entries(RateLimitTier).forEach(([tier, config]) => {
      this.limiters.set(tier, this.createLimiter(config));
    });
    
    // Initialize brute force protection
    if (this.config.enableBruteForce) {
      this.bruteForceProtection = this.createLimiter({
        points: 5,
        duration: 900, // 15 minutes
        blockDuration: 3600 // 1 hour
      });
    }
    
    // Start cleanup interval
    this.startCleanup();
    
    logger.info('Unified rate limiter initialized', {
      strategy: this.config.strategy,
      tiers: Object.keys(RateLimitTier).length
    });
  }
  
  /**
   * Create rate limiter instance
   */
  createLimiter(options) {
    const config = {
      keyPrefix: `${this.config.keyPrefix}:${options.tier || 'default'}`,
      points: options.points,
      duration: options.duration,
      blockDuration: options.blockDuration,
      execEvenly: true
    };
    
    switch (this.config.strategy) {
      case RateLimitStrategy.REDIS:
        if (!this.config.redis) {
          throw new Error('Redis configuration required for Redis strategy');
        }
        const redisClient = new Redis(this.config.redis);
        return new RateLimiterRedis({
          ...config,
          storeClient: redisClient
        });
        
      case RateLimitStrategy.CLUSTER:
        return new RateLimiterCluster({
          ...config,
          timeoutMs: 3000
        });
        
      case RateLimitStrategy.MEMORY:
      default:
        return new RateLimiterMemory(config);
    }
  }
  
  /**
   * Check rate limit
   */
  async checkLimit(key, tier = 'FREE', points = 1) {
    try {
      const limiter = this.limiters.get(tier);
      if (!limiter) {
        throw new Error(`Unknown tier: ${tier}`);
      }
      
      // Check adaptive limits
      if (this.config.enableAdaptive) {
        const adaptivePoints = await this.getAdaptivePoints(key, tier, points);
        if (adaptivePoints !== points) {
          points = adaptivePoints;
        }
      }
      
      // Consume points
      const result = await limiter.consume(key, points);
      
      return {
        allowed: true,
        remaining: result.remainingPoints,
        reset: new Date(result.msBeforeNext),
        limit: limiter.points
      };
      
    } catch (error) {
      if (error.remainingPoints !== undefined) {
        // Rate limit exceeded
        return {
          allowed: false,
          remaining: error.remainingPoints,
          reset: new Date(Date.now() + error.msBeforeNext),
          limit: error.points,
          retryAfter: error.msBeforeNext
        };
      }
      
      // Other error
      logger.error('Rate limit check failed', { error, key, tier });
      throw error;
    }
  }
  
  /**
   * Check brute force protection
   */
  async checkBruteForce(key) {
    if (!this.config.enableBruteForce) {
      return { allowed: true };
    }
    
    try {
      await this.bruteForceProtection.consume(key);
      return { allowed: true };
    } catch (error) {
      return {
        allowed: false,
        retryAfter: error.msBeforeNext,
        message: 'Too many failed attempts'
      };
    }
  }
  
  /**
   * Reset rate limit
   */
  async reset(key, tier = 'FREE') {
    const limiter = this.limiters.get(tier);
    if (!limiter) {
      throw new Error(`Unknown tier: ${tier}`);
    }
    
    await limiter.delete(key);
    logger.info('Rate limit reset', { key, tier });
  }
  
  /**
   * Get current status
   */
  async getStatus(key, tier = 'FREE') {
    const limiter = this.limiters.get(tier);
    if (!limiter) {
      throw new Error(`Unknown tier: ${tier}`);
    }
    
    try {
      const result = await limiter.get(key);
      if (!result) {
        return {
          consumed: 0,
          remaining: limiter.points,
          limit: limiter.points
        };
      }
      
      return {
        consumed: result.consumedPoints,
        remaining: result.remainingPoints,
        limit: limiter.points,
        reset: new Date(result.msBeforeNext)
      };
    } catch (error) {
      logger.error('Failed to get rate limit status', { error, key, tier });
      throw error;
    }
  }
  
  /**
   * Create Express middleware
   */
  middleware(options = {}) {
    const tier = options.tier || 'FREE';
    const keyGenerator = options.keyGenerator || ((req) => req.ip);
    const points = options.points || 1;
    
    return async (req, res, next) => {
      try {
        const key = keyGenerator(req);
        const result = await this.checkLimit(key, tier, points);
        
        // Set rate limit headers
        res.setHeader('X-RateLimit-Limit', result.limit);
        res.setHeader('X-RateLimit-Remaining', result.remaining);
        res.setHeader('X-RateLimit-Reset', result.reset.toISOString());
        
        if (!result.allowed) {
          res.setHeader('Retry-After', Math.round(result.retryAfter / 1000));
          return res.status(429).json({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded',
            retryAfter: result.retryAfter
          });
        }
        
        next();
      } catch (error) {
        logger.error('Rate limit middleware error', { error });
        next(error);
      }
    };
  }
  
  /**
   * Get adaptive points based on behavior
   */
  async getAdaptivePoints(key, tier, requestedPoints) {
    // Simple adaptive logic - can be enhanced with ML
    const history = await this.getStatus(key, tier);
    
    // Good behavior - reduce cost
    if (history.consumed < history.limit * 0.5) {
      return Math.max(1, requestedPoints * 0.8);
    }
    
    // Near limit - increase cost
    if (history.consumed > history.limit * 0.9) {
      return requestedPoints * 1.5;
    }
    
    return requestedPoints;
  }
  
  /**
   * Start cleanup interval
   */
  startCleanup() {
    this.cleanupInterval = setInterval(() => {
      // Clean up old entries in memory strategy
      if (this.config.strategy === RateLimitStrategy.MEMORY) {
        // Memory cleanup is handled by rate-limiter-flexible
      }
      
      // Log statistics
      const stats = this.getStatistics();
      logger.debug('Rate limiter statistics', stats);
    }, 60000); // Every minute
  }
  
  /**
   * Get statistics
   */
  getStatistics() {
    return {
      strategy: this.config.strategy,
      tiers: Object.keys(RateLimitTier).length,
      memoryUsage: memoryManager.getMemoryUsage()
    };
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    clearInterval(this.cleanupInterval);
    
    // Close Redis connections if used
    if (this.config.strategy === RateLimitStrategy.REDIS) {
      for (const limiter of this.limiters.values()) {
        if (limiter.client && limiter.client.disconnect) {
          await limiter.client.disconnect();
        }
      }
    }
    
    logger.info('Rate limiter shutdown');
  }
}

/**
 * Factory function
 */
export function createRateLimiter(config) {
  return new UnifiedRateLimiter(config);
}

export default UnifiedRateLimiter;