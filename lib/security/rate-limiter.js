/**
 * Advanced Rate Limiting System for Otedama
 * 
 * Design principles:
 * - Carmack: Minimal overhead, fast lookups
 * - Martin: Clean interfaces, testable
 * - Pike: Simple but powerful
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';

// Rate limit strategies
export const RateLimitStrategy = {
  FIXED_WINDOW: 'fixed_window',
  SLIDING_WINDOW: 'sliding_window',
  TOKEN_BUCKET: 'token_bucket',
  LEAKY_BUCKET: 'leaky_bucket'
};

// Rate limit levels
export const RateLimitLevel = {
  GLOBAL: 'global',
  IP: 'ip',
  USER: 'user',
  API_KEY: 'api_key',
  ENDPOINT: 'endpoint'
};

/**
 * Token Bucket implementation for smooth rate limiting
 */
class TokenBucket {
  constructor(capacity, refillRate) {
    this.capacity = capacity;
    this.refillRate = refillRate; // tokens per second
    this.tokens = capacity;
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
    return Math.floor(this.tokens);
  }

  getWaitTime(tokens = 1) {
    this.refill();
    
    if (this.tokens >= tokens) {
      return 0;
    }
    
    const tokensNeeded = tokens - this.tokens;
    return Math.ceil((tokensNeeded / this.refillRate) * 1000);
  }
}

/**
 * Sliding Window Log implementation for accurate rate limiting
 */
class SlidingWindowLog {
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.requests = [];
  }

  record() {
    const now = Date.now();
    this.cleanup(now);
    
    if (this.requests.length >= this.maxRequests) {
      return false;
    }
    
    this.requests.push(now);
    return true;
  }

  cleanup(now) {
    const cutoff = now - this.windowMs;
    this.requests = this.requests.filter(time => time > cutoff);
  }

  getRemaining() {
    this.cleanup(Date.now());
    return Math.max(0, this.maxRequests - this.requests.length);
  }

  getResetTime() {
    if (this.requests.length === 0) {
      return Date.now() + this.windowMs;
    }
    
    return this.requests[0] + this.windowMs;
  }
}

/**
 * Advanced Rate Limiter with multiple strategies
 */
export class AdvancedRateLimiter extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      strategy: options.strategy || RateLimitStrategy.TOKEN_BUCKET,
      
      // Default limits
      global: {
        enabled: options.global?.enabled !== false,
        requests: options.global?.requests || 10000,
        window: options.global?.window || 60000, // 1 minute
        burst: options.global?.burst || 100
      },
      
      perIP: {
        enabled: options.perIP?.enabled !== false,
        requests: options.perIP?.requests || 100,
        window: options.perIP?.window || 60000,
        burst: options.perIP?.burst || 20
      },
      
      perUser: {
        enabled: options.perUser?.enabled !== false,
        requests: options.perUser?.requests || 1000,
        window: options.perUser?.window || 60000,
        burst: options.perUser?.burst || 50
      },
      
      perApiKey: {
        enabled: options.perApiKey?.enabled !== false,
        requests: options.perApiKey?.requests || 5000,
        window: options.perApiKey?.window || 60000,
        burst: options.perApiKey?.burst || 100
      },
      
      // Endpoint-specific limits
      endpoints: options.endpoints || {},
      
      // Advanced options
      trustProxy: options.trustProxy || false,
      ipWhitelist: new Set(options.ipWhitelist || []),
      userWhitelist: new Set(options.userWhitelist || []),
      
      // Response headers
      includeHeaders: options.includeHeaders !== false,
      headerPrefix: options.headerPrefix || 'X-RateLimit-',
      
      // Storage
      maxCacheSize: options.maxCacheSize || 10000,
      cleanupInterval: options.cleanupInterval || 60000, // 1 minute
      
      // Penalties
      penalties: {
        enabled: options.penalties?.enabled || false,
        threshold: options.penalties?.threshold || 0.9, // 90% of limit
        multiplier: options.penalties?.multiplier || 2,
        duration: options.penalties?.duration || 300000 // 5 minutes
      }
    };
    
    // Storage
    this.limiters = new Map();
    this.violations = new Map();
    this.penalties = new Map();
    
    // Statistics
    this.stats = {
      requests: 0,
      allowed: 0,
      blocked: 0,
      violations: 0,
      whitelisted: 0
    };
    
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), this.config.cleanupInterval);
  }

  /**
   * Check if request should be rate limited
   */
  async checkLimit(context) {
    this.stats.requests++;
    
    // Extract identifiers
    const identifiers = this.extractIdentifiers(context);
    
    // Check whitelist
    if (this.isWhitelisted(identifiers)) {
      this.stats.whitelisted++;
      return this.createAllowedResponse(identifiers);
    }
    
    // Check global limit
    if (this.config.global.enabled) {
      const globalResult = this.checkLimiter('global', 'global', this.config.global);
      if (!globalResult.allowed) {
        return this.createBlockedResponse(globalResult, 'global');
      }
    }
    
    // Check IP limit
    if (this.config.perIP.enabled && identifiers.ip) {
      const ipConfig = this.getPenalizedConfig(identifiers.ip, this.config.perIP);
      const ipResult = this.checkLimiter('ip', identifiers.ip, ipConfig);
      if (!ipResult.allowed) {
        return this.createBlockedResponse(ipResult, 'ip');
      }
    }
    
    // Check user limit
    if (this.config.perUser.enabled && identifiers.userId) {
      const userConfig = this.getPenalizedConfig(identifiers.userId, this.config.perUser);
      const userResult = this.checkLimiter('user', identifiers.userId, userConfig);
      if (!userResult.allowed) {
        return this.createBlockedResponse(userResult, 'user');
      }
    }
    
    // Check API key limit
    if (this.config.perApiKey.enabled && identifiers.apiKey) {
      const apiKeyResult = this.checkLimiter('apikey', identifiers.apiKey, this.config.perApiKey);
      if (!apiKeyResult.allowed) {
        return this.createBlockedResponse(apiKeyResult, 'apikey');
      }
    }
    
    // Check endpoint-specific limit
    if (identifiers.endpoint && this.config.endpoints[identifiers.endpoint]) {
      const endpointConfig = this.config.endpoints[identifiers.endpoint];
      const endpointResult = this.checkLimiter('endpoint', identifiers.endpoint, endpointConfig);
      if (!endpointResult.allowed) {
        return this.createBlockedResponse(endpointResult, 'endpoint');
      }
    }
    
    this.stats.allowed++;
    return this.createAllowedResponse(identifiers);
  }

  /**
   * Check specific limiter
   */
  checkLimiter(type, key, config) {
    const limiterKey = `${type}:${key}`;
    let limiter = this.limiters.get(limiterKey);
    
    if (!limiter) {
      limiter = this.createLimiter(config);
      this.limiters.set(limiterKey, limiter);
    }
    
    let allowed;
    let remaining;
    let resetTime;
    
    switch (this.config.strategy) {
      case RateLimitStrategy.TOKEN_BUCKET:
        allowed = limiter.consume();
        remaining = limiter.getTokens();
        resetTime = Date.now() + limiter.getWaitTime();
        break;
        
      case RateLimitStrategy.SLIDING_WINDOW:
        allowed = limiter.record();
        remaining = limiter.getRemaining();
        resetTime = limiter.getResetTime();
        break;
        
      default:
        // Fixed window (simple counter)
        if (!limiter.window || Date.now() > limiter.window) {
          limiter.count = 0;
          limiter.window = Date.now() + config.window;
        }
        
        allowed = limiter.count < config.requests;
        if (allowed) {
          limiter.count++;
        }
        
        remaining = Math.max(0, config.requests - limiter.count);
        resetTime = limiter.window;
    }
    
    // Check for violations and apply penalties
    if (!allowed && this.config.penalties.enabled) {
      this.recordViolation(key);
    }
    
    return {
      allowed,
      remaining,
      resetTime,
      limit: config.requests
    };
  }

  /**
   * Create limiter based on strategy
   */
  createLimiter(config) {
    switch (this.config.strategy) {
      case RateLimitStrategy.TOKEN_BUCKET:
        const refillRate = config.requests / (config.window / 1000);
        return new TokenBucket(config.burst || config.requests, refillRate);
        
      case RateLimitStrategy.SLIDING_WINDOW:
        return new SlidingWindowLog(config.window, config.requests);
        
      default:
        // Fixed window
        return {
          count: 0,
          window: Date.now() + config.window
        };
    }
  }

  /**
   * Extract identifiers from request context
   */
  extractIdentifiers(context) {
    const identifiers = {
      ip: this.extractIP(context),
      userId: context.userId || context.user?.id,
      apiKey: context.apiKey,
      endpoint: context.endpoint || context.path
    };
    
    // Hash sensitive data
    if (identifiers.apiKey) {
      identifiers.apiKey = createHash('sha256').update(identifiers.apiKey).digest('hex');
    }
    
    return identifiers;
  }

  /**
   * Extract IP address with proxy support
   */
  extractIP(context) {
    if (!context.req) return context.ip;
    
    const req = context.req;
    
    if (this.config.trustProxy) {
      // Check various proxy headers
      return req.headers['x-forwarded-for']?.split(',')[0].trim() ||
             req.headers['x-real-ip'] ||
             req.headers['cf-connecting-ip'] || // Cloudflare
             req.connection?.remoteAddress ||
             req.socket?.remoteAddress;
    }
    
    return req.connection?.remoteAddress || req.socket?.remoteAddress || context.ip;
  }

  /**
   * Check if request is whitelisted
   */
  isWhitelisted(identifiers) {
    return (identifiers.ip && this.config.ipWhitelist.has(identifiers.ip)) ||
           (identifiers.userId && this.config.userWhitelist.has(identifiers.userId));
  }

  /**
   * Get penalized configuration
   */
  getPenalizedConfig(identifier, baseConfig) {
    const penalty = this.penalties.get(identifier);
    
    if (!penalty || Date.now() > penalty.expires) {
      return baseConfig;
    }
    
    return {
      ...baseConfig,
      requests: Math.floor(baseConfig.requests / penalty.multiplier),
      burst: Math.floor((baseConfig.burst || baseConfig.requests) / penalty.multiplier)
    };
  }

  /**
   * Record violation and apply penalties
   */
  recordViolation(identifier) {
    const violations = (this.violations.get(identifier) || 0) + 1;
    this.violations.set(identifier, violations);
    this.stats.violations++;
    
    // Apply penalty after multiple violations
    if (violations >= 3) {
      this.penalties.set(identifier, {
        multiplier: this.config.penalties.multiplier,
        expires: Date.now() + this.config.penalties.duration,
        violations
      });
      
      this.emit('penalty', {
        identifier,
        violations,
        duration: this.config.penalties.duration
      });
    }
    
    this.emit('violation', {
      identifier,
      violations
    });
  }

  /**
   * Create allowed response
   */
  createAllowedResponse(identifiers) {
    const response = {
      allowed: true,
      identifiers
    };
    
    if (this.config.includeHeaders) {
      response.headers = this.createHeaders(true);
    }
    
    return response;
  }

  /**
   * Create blocked response
   */
  createBlockedResponse(result, type) {
    this.stats.blocked++;
    
    const response = {
      allowed: false,
      reason: `Rate limit exceeded for ${type}`,
      retryAfter: Math.ceil((result.resetTime - Date.now()) / 1000),
      type
    };
    
    if (this.config.includeHeaders) {
      response.headers = this.createHeaders(false, result);
    }
    
    this.emit('limited', {
      type,
      ...result
    });
    
    return response;
  }

  /**
   * Create rate limit headers
   */
  createHeaders(allowed, result = {}) {
    const prefix = this.config.headerPrefix;
    const headers = {};
    
    if (result.limit !== undefined) {
      headers[`${prefix}Limit`] = result.limit;
    }
    
    if (result.remaining !== undefined) {
      headers[`${prefix}Remaining`] = Math.max(0, result.remaining);
    }
    
    if (result.resetTime) {
      headers[`${prefix}Reset`] = Math.floor(result.resetTime / 1000);
    }
    
    if (!allowed) {
      headers['Retry-After'] = Math.ceil((result.resetTime - Date.now()) / 1000);
    }
    
    return headers;
  }

  /**
   * Apply rate limit headers to response
   */
  applyHeaders(res, headers) {
    if (!headers) return;
    
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
  }

  /**
   * Express/Connect middleware
   */
  middleware() {
    return async (req, res, next) => {
      const context = {
        req,
        ip: this.extractIP({ req }),
        userId: req.user?.id,
        apiKey: req.headers['x-api-key'],
        endpoint: req.path
      };
      
      const result = await this.checkLimit(context);
      
      if (result.headers) {
        this.applyHeaders(res, result.headers);
      }
      
      if (result.allowed) {
        next();
      } else {
        res.status(429).json({
          error: 'Too Many Requests',
          message: result.reason,
          retryAfter: result.retryAfter
        });
      }
    };
  }

  /**
   * Reset limits for identifier
   */
  reset(type, identifier) {
    const limiterKey = `${type}:${identifier}`;
    this.limiters.delete(limiterKey);
    this.violations.delete(identifier);
    this.penalties.delete(identifier);
    
    this.emit('reset', { type, identifier });
  }

  /**
   * Get current limits for identifier
   */
  getLimits(context) {
    const identifiers = this.extractIdentifiers(context);
    const limits = {};
    
    // Check each applicable limit
    if (this.config.global.enabled) {
      const result = this.checkLimiter('global', 'global', this.config.global);
      limits.global = result;
    }
    
    if (this.config.perIP.enabled && identifiers.ip) {
      const config = this.getPenalizedConfig(identifiers.ip, this.config.perIP);
      const result = this.checkLimiter('ip', identifiers.ip, config);
      limits.ip = result;
    }
    
    if (this.config.perUser.enabled && identifiers.userId) {
      const config = this.getPenalizedConfig(identifiers.userId, this.config.perUser);
      const result = this.checkLimiter('user', identifiers.userId, config);
      limits.user = result;
    }
    
    if (this.config.perApiKey.enabled && identifiers.apiKey) {
      const result = this.checkLimiter('apikey', identifiers.apiKey, this.config.perApiKey);
      limits.apiKey = result;
    }
    
    if (identifiers.endpoint && this.config.endpoints[identifiers.endpoint]) {
      const config = this.config.endpoints[identifiers.endpoint];
      const result = this.checkLimiter('endpoint', identifiers.endpoint, config);
      limits.endpoint = result;
    }
    
    return limits;
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      limiters: this.limiters.size,
      violations: this.violations.size,
      penalties: this.penalties.size,
      successRate: this.stats.requests > 0 ? 
        (this.stats.allowed / this.stats.requests * 100).toFixed(2) + '%' : '0%'
    };
  }

  /**
   * Cleanup old entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    // Clean up limiters
    if (this.limiters.size > this.config.maxCacheSize) {
      const entries = Array.from(this.limiters.entries());
      const toRemove = entries.slice(0, entries.length - this.config.maxCacheSize);
      
      for (const [key] of toRemove) {
        this.limiters.delete(key);
        cleaned++;
      }
    }
    
    // Clean up expired penalties
    for (const [identifier, penalty] of this.penalties) {
      if (now > penalty.expires) {
        this.penalties.delete(identifier);
        cleaned++;
      }
    }
    
    // Clean up old violations
    if (this.violations.size > 1000) {
      const entries = Array.from(this.violations.entries());
      const toRemove = entries.slice(0, entries.length - 1000);
      
      for (const [key] of toRemove) {
        this.violations.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.emit('cleanup', { cleaned });
    }
  }

  /**
   * Shutdown the rate limiter
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.limiters.clear();
    this.violations.clear();
    this.penalties.clear();
    
    this.emit('shutdown');
  }
}

/**
 * Factory function for creating rate limiter
 */
export function createRateLimiter(options) {
  return new AdvancedRateLimiter(options);
}

// Default export
export default AdvancedRateLimiter;
