/**
 * Rate Limiting Middleware for API Endpoints
 * Protects against abuse and ensures fair usage
 * 
 * Design principles:
 * - Martin: Single responsibility - only handles rate limiting
 * - Pike: Simple and effective rate limiting
 * - Carmack: Fast with minimal performance impact
 */

import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import { createStructuredLogger } from '../core/structured-logger.js';
import { sqlValidator } from '../security/sql-validator.js';

const logger = createStructuredLogger('RateLimit');

/**
 * Rate limit configurations for different endpoint types
 */
export const rateLimitConfigs = {
  // Authentication endpoints - strict limits
  auth: {
    points: 5, // Number of requests
    duration: 60, // Per 60 seconds
    blockDuration: 300, // Block for 5 minutes if exceeded
    message: 'Too many authentication attempts. Please try again later.'
  },
  
  // Mining submission endpoints - higher limits
  mining: {
    points: 100,
    duration: 60,
    blockDuration: 60,
    message: 'Mining submission rate limit exceeded.'
  },
  
  // General API endpoints
  api: {
    points: 60,
    duration: 60,
    blockDuration: 60,
    message: 'API rate limit exceeded. Please slow down.'
  },
  
  // Stats/monitoring endpoints - very permissive
  stats: {
    points: 300,
    duration: 60,
    blockDuration: 10,
    message: 'Stats API rate limit exceeded.'
  },
  
  // WebSocket connections
  websocket: {
    points: 10,
    duration: 60,
    blockDuration: 300,
    message: 'Too many WebSocket connection attempts.'
  },
  
  // Global rate limit per IP
  global: {
    points: 1000,
    duration: 60,
    blockDuration: 600,
    message: 'Global rate limit exceeded. You are making too many requests.'
  }
};

/**
 * Create rate limiter instance
 */
export function createRateLimiter(config, options = {}) {
  const limiterOptions = {
    points: config.points,
    duration: config.duration,
    blockDuration: config.blockDuration,
    ...options
  };
  
  // Use Redis if available, otherwise fall back to memory
  if (options.redis) {
    return new RateLimiterRedis({
      storeClient: options.redis,
      keyPrefix: options.keyPrefix || 'otedama:rl:',
      ...limiterOptions
    });
  }
  
  return new RateLimiterMemory(limiterOptions);
}

/**
 * Rate limiting middleware factory
 */
export function rateLimitMiddleware(type = 'api', options = {}) {
  const config = rateLimitConfigs[type] || rateLimitConfigs.api;
  const limiter = createRateLimiter(config, options);
  
  return async (req, res, next) => {
    try {
      // Get client identifier (IP address by default)
      const key = getClientKey(req, options);
      
      // Validate key to prevent injection attacks
      const validation = sqlValidator.validate(key, 'identifier');
      if (!validation.valid) {
        logger.warn('Invalid rate limit key', { key, error: validation.error });
        return res.status(400).json({ error: 'Invalid request' });
      }
      
      // Try to consume a point
      await limiter.consume(validation.value);
      
      // Add rate limit headers
      if (options.includeHeaders !== false) {
        res.set({
          'X-RateLimit-Limit': config.points,
          'X-RateLimit-Remaining': res.remainingPoints || config.points - 1,
          'X-RateLimit-Reset': new Date(Date.now() + config.duration * 1000).toISOString()
        });
      }
      
      next();
    } catch (rejRes) {
      // Rate limit exceeded
      if (rejRes instanceof Error) {
        // Actual error occurred
        logger.error('Rate limiter error', rejRes);
        return next();
      }
      
      // Log rate limit violation
      logger.warn('Rate limit exceeded', {
        type,
        key: getClientKey(req, options),
        points: rejRes.points,
        msBeforeNext: rejRes.msBeforeNext
      });
      
      // Set retry headers
      res.set({
        'Retry-After': Math.round(rejRes.msBeforeNext / 1000) || config.blockDuration,
        'X-RateLimit-Limit': config.points,
        'X-RateLimit-Remaining': rejRes.remainingPoints || 0,
        'X-RateLimit-Reset': new Date(Date.now() + rejRes.msBeforeNext).toISOString()
      });
      
      // Send error response
      res.status(429).json({
        error: config.message,
        retryAfter: Math.round(rejRes.msBeforeNext / 1000)
      });
    }
  };
}

/**
 * Get client key for rate limiting
 */
function getClientKey(req, options = {}) {
  // Custom key function
  if (options.keyGenerator) {
    return options.keyGenerator(req);
  }
  
  // Use authenticated user ID if available
  if (options.byUser && req.user && req.user.id) {
    return `user:${req.user.id}`;
  }
  
  // Use session ID if available
  if (options.bySession && req.session && req.session.id) {
    return `session:${req.session.id}`;
  }
  
  // Default to IP address
  const ip = req.ip || 
    req.headers['x-forwarded-for']?.split(',')[0] || 
    req.headers['x-real-ip'] ||
    req.connection.remoteAddress ||
    'unknown';
  
  return `ip:${ip}`;
}

/**
 * Dynamic rate limiting based on user behavior
 */
export class DynamicRateLimiter {
  constructor(options = {}) {
    this.baseConfig = options.baseConfig || rateLimitConfigs.api;
    this.redis = options.redis;
    this.trustScore = new Map(); // User trust scores
    this.badActors = new Set(); // Known bad actors
    
    // Behavior thresholds
    this.thresholds = {
      suspiciousPatterns: 5, // Number of suspicious requests
      errorRate: 0.5, // Error rate threshold
      burstThreshold: 20, // Requests in 10 seconds
      ...options.thresholds
    };
    
    // Initialize limiter with base config
    this.limiter = createRateLimiter(this.baseConfig, { redis: this.redis });
  }
  
  /**
   * Get adjusted rate limit for a client
   */
  getAdjustedLimit(clientKey) {
    // Check if bad actor
    if (this.badActors.has(clientKey)) {
      return {
        points: Math.floor(this.baseConfig.points * 0.1), // 10% of normal
        duration: this.baseConfig.duration,
        blockDuration: this.baseConfig.blockDuration * 10 // 10x block time
      };
    }
    
    // Get trust score
    const trust = this.trustScore.get(clientKey) || 1.0;
    
    // Adjust limits based on trust
    return {
      points: Math.floor(this.baseConfig.points * trust),
      duration: this.baseConfig.duration,
      blockDuration: Math.floor(this.baseConfig.blockDuration / trust)
    };
  }
  
  /**
   * Update client behavior metrics
   */
  async updateBehavior(clientKey, request, response) {
    // Track error rate
    if (response.statusCode >= 400) {
      await this.incrementErrorCount(clientKey);
    }
    
    // Track burst behavior
    await this.trackBurst(clientKey);
    
    // Check for suspicious patterns
    if (this.isSuspiciousRequest(request)) {
      await this.incrementSuspiciousCount(clientKey);
    }
    
    // Update trust score
    await this.updateTrustScore(clientKey);
  }
  
  /**
   * Check if request looks suspicious
   */
  isSuspiciousRequest(request) {
    const suspicious = [
      // SQL injection attempts
      /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION)\b)/i,
      // Path traversal
      /\.\.\//,
      // Script injection
      /<script/i,
      // Command injection
      /[;&|`$]/
    ];
    
    const url = request.url || '';
    const body = JSON.stringify(request.body || {});
    
    return suspicious.some(pattern => 
      pattern.test(url) || pattern.test(body)
    );
  }
  
  /**
   * Middleware for dynamic rate limiting
   */
  middleware() {
    return async (req, res, next) => {
      const clientKey = getClientKey(req);
      const adjustedConfig = this.getAdjustedLimit(clientKey);
      
      // Create adjusted limiter
      const limiter = createRateLimiter(adjustedConfig, { redis: this.redis });
      
      try {
        await limiter.consume(clientKey);
        
        // Track behavior after response
        res.on('finish', () => {
          this.updateBehavior(clientKey, req, res);
        });
        
        next();
      } catch (rejRes) {
        // Rate limit exceeded
        logger.warn('Dynamic rate limit exceeded', {
          clientKey,
          trust: this.trustScore.get(clientKey) || 1.0,
          config: adjustedConfig
        });
        
        res.status(429).json({
          error: 'Rate limit exceeded',
          retryAfter: Math.round(rejRes.msBeforeNext / 1000)
        });
      }
    };
  }
  
  // Helper methods (simplified implementations)
  async incrementErrorCount(clientKey) {
    // Implementation would track error counts
  }
  
  async trackBurst(clientKey) {
    // Implementation would track burst patterns
  }
  
  async incrementSuspiciousCount(clientKey) {
    // Implementation would track suspicious behavior
  }
  
  async updateTrustScore(clientKey) {
    // Implementation would calculate and update trust scores
  }
}

/**
 * Create rate limit configuration for Express app
 */
export function configureRateLimiting(app, options = {}) {
  // Global rate limit
  app.use(rateLimitMiddleware('global', options));
  
  // Specific endpoint rate limits
  app.use('/api/auth', rateLimitMiddleware('auth', options));
  app.use('/api/mining', rateLimitMiddleware('mining', options));
  app.use('/api/stats', rateLimitMiddleware('stats', options));
  app.use('/api', rateLimitMiddleware('api', options));
  
  // WebSocket rate limit (if using Socket.IO)
  if (options.io) {
    options.io.use((socket, next) => {
      const req = socket.request;
      rateLimitMiddleware('websocket', options)(req, {
        status: (code) => {
          if (code === 429) {
            next(new Error('Rate limit exceeded'));
          }
        },
        set: () => {},
        json: () => {}
      }, next);
    });
  }
  
  logger.info('Rate limiting configured', {
    endpoints: Object.keys(rateLimitConfigs)
  });
}

export default {
  rateLimitMiddleware,
  configureRateLimiting,
  DynamicRateLimiter,
  rateLimitConfigs
};