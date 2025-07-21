/**
 * Distributed Rate Limiter for Otedama
 * Provides scalable rate limiting across multiple instances
 * 
 * Design principles:
 * - Carmack: Lock-free algorithms for high performance
 * - Martin: Clean separation of storage backends
 * - Pike: Simple, reliable distributed coordination
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import { getLogger } from '../core/logger.js';

/**
 * Distributed Rate Limiter with multiple backend support
 */
export class DistributedRateLimiter extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.logger = getLogger('DistributedRateLimit');
    
    this.options = {
      // Backend: 'redis', 'inmemory', 'hybrid'
      backend: options.backend || 'hybrid',
      
      // Redis configuration
      redis: {
        host: options.redis?.host || 'localhost',
        port: options.redis?.port || 6379,
        password: options.redis?.password,
        keyPrefix: options.redis?.keyPrefix || 'ratelimit:',
        enableOfflineQueue: false,
        retryStrategy: (times) => Math.min(times * 50, 2000),
        ...options.redis
      },
      
      // Rate limit defaults
      defaultLimits: {
        requests: options.defaultLimits?.requests || 100,
        window: options.defaultLimits?.window || 60000, // 1 minute
        burst: options.defaultLimits?.burst || 20
      },
      
      // Endpoint-specific limits
      endpointLimits: {
        '/api/auth/login': { requests: 5, window: 60000 },
        '/api/auth/register': { requests: 3, window: 300000 },
        '/api/mining/submit': { requests: 1000, window: 60000 },
        '/api/dex/order': { requests: 50, window: 60000 },
        ...options.endpointLimits
      },
      
      // User tier limits
      tierLimits: {
        free: { multiplier: 1 },
        pro: { multiplier: 10 },
        enterprise: { multiplier: 100 },
        ...options.tierLimits
      },
      
      // Sync configuration for distributed mode
      syncInterval: options.syncInterval || 5000,
      syncBatchSize: options.syncBatchSize || 100,
      
      // Local cache for hybrid mode
      localCacheTTL: options.localCacheTTL || 1000,
      localCacheSize: options.localCacheSize || 10000,
      
      // Sliding window configuration
      slidingWindow: options.slidingWindow !== false,
      precision: options.precision || 10, // Window subdivisions
      
      ...options
    };
    
    // Initialize backend
    this.initializeBackend();
    
    // Local state for hybrid mode
    this.localCache = new Map();
    this.pendingSync = new Map();
    
    // Statistics
    this.stats = {
      hits: 0,
      misses: 0,
      blocked: 0,
      errors: 0,
      syncOperations: 0,
      cacheHits: 0,
      cacheMisses: 0
    };
    
    // Start sync if needed
    if (this.options.backend === 'hybrid') {
      this.startSync();
    }
  }
  
  /**
   * Initialize the selected backend
   */
  initializeBackend() {
    switch (this.options.backend) {
      case 'redis':
        this.initializeRedis();
        break;
        
      case 'inmemory':
        this.storage = new Map();
        break;
        
      case 'hybrid':
        this.initializeRedis();
        this.storage = new Map();
        break;
        
      default:
        throw new Error(`Unknown backend: ${this.options.backend}`);
    }
  }
  
  /**
   * Initialize Redis connection
   */
  initializeRedis() {
    this.redis = new Redis(this.options.redis);
    
    this.redis.on('connect', () => {
      this.logger.info('Connected to Redis for rate limiting');
      this.emit('redis:connected');
    });
    
    this.redis.on('error', (error) => {
      this.logger.error('Redis error:', error);
      this.emit('redis:error', error);
      this.stats.errors++;
    });
    
    this.redis.on('close', () => {
      this.logger.warn('Redis connection closed');
      this.emit('redis:disconnected');
    });
  }
  
  /**
   * Check rate limit for a request
   */
  async checkLimit(identifier, endpoint = null, options = {}) {
    try {
      const key = this.generateKey(identifier, endpoint);
      const limits = this.getLimits(identifier, endpoint, options);
      
      // Check local cache first in hybrid mode
      if (this.options.backend === 'hybrid') {
        const cached = this.checkLocalCache(key, limits);
        if (cached !== null) {
          this.stats.cacheHits++;
          return cached;
        }
        this.stats.cacheMisses++;
      }
      
      // Check main storage
      const result = await this.checkStorage(key, limits);
      
      // Update local cache in hybrid mode
      if (this.options.backend === 'hybrid') {
        this.updateLocalCache(key, result);
      }
      
      // Update statistics
      if (result.allowed) {
        this.stats.hits++;
      } else {
        this.stats.blocked++;
        this.emit('rate_limit_exceeded', { identifier, endpoint, limits });
      }
      
      return result;
      
    } catch (error) {
      this.logger.error('Rate limit check failed:', error);
      this.stats.errors++;
      
      // Fail open on errors
      return {
        allowed: true,
        remaining: 0,
        resetTime: Date.now() + 60000,
        error: true
      };
    }
  }
  
  /**
   * Check local cache (hybrid mode)
   */
  checkLocalCache(key, limits) {
    const cached = this.localCache.get(key);
    if (!cached) return null;
    
    const now = Date.now();
    if (now - cached.timestamp > this.options.localCacheTTL) {
      this.localCache.delete(key);
      return null;
    }
    
    // Estimate based on cached data
    const elapsed = now - cached.windowStart;
    const windowProgress = elapsed / limits.window;
    const estimatedCount = cached.count + (cached.rate * windowProgress);
    
    if (estimatedCount >= limits.requests) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: cached.windowStart + limits.window
      };
    }
    
    return null; // Uncertain, check main storage
  }
  
  /**
   * Update local cache (hybrid mode)
   */
  updateLocalCache(key, result) {
    if (this.localCache.size >= this.options.localCacheSize) {
      // Evict oldest entries
      const toEvict = Math.floor(this.options.localCacheSize * 0.1);
      const entries = Array.from(this.localCache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      entries.slice(0, toEvict).forEach(([k]) => this.localCache.delete(k));
    }
    
    this.localCache.set(key, {
      ...result,
      timestamp: Date.now()
    });
  }
  
  /**
   * Check rate limit in storage backend
   */
  async checkStorage(key, limits) {
    switch (this.options.backend) {
      case 'redis':
      case 'hybrid':
        return await this.checkRedis(key, limits);
        
      case 'inmemory':
        return this.checkInMemory(key, limits);
        
      default:
        throw new Error(`Unknown backend: ${this.options.backend}`);
    }
  }
  
  /**
   * Check rate limit using Redis
   */
  async checkRedis(key, limits) {
    const now = Date.now();
    const window = limits.window;
    
    if (this.options.slidingWindow) {
      // Sliding window with Redis sorted sets
      const windowStart = now - window;
      const member = `${now}:${Math.random()}`;
      
      // Lua script for atomic sliding window
      const luaScript = `
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local window = tonumber(ARGV[2])
        local limit = tonumber(ARGV[3])
        local member = ARGV[4]
        local windowStart = now - window
        
        -- Remove old entries
        redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)
        
        -- Count current entries
        local count = redis.call('ZCARD', key)
        
        if count < limit then
          -- Add new entry
          redis.call('ZADD', key, now, member)
          redis.call('EXPIRE', key, math.ceil(window / 1000))
          return {1, limit - count - 1, 0}
        else
          -- Get oldest entry for reset time
          local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
          local resetTime = oldest[2] and (oldest[2] + window) or (now + window)
          return {0, 0, resetTime}
        end
      `;
      
      const result = await this.redis.eval(
        luaScript,
        1,
        key,
        now,
        window,
        limits.requests,
        member
      );
      
      return {
        allowed: result[0] === 1,
        remaining: result[1],
        resetTime: result[2] || (now + window)
      };
      
    } else {
      // Fixed window with Redis strings
      const windowId = Math.floor(now / window);
      const windowKey = `${key}:${windowId}`;
      
      // Lua script for atomic fixed window
      const luaScript = `
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local window = tonumber(ARGV[2])
        local current = redis.call('GET', key)
        current = current and tonumber(current) or 0
        
        if current < limit then
          redis.call('INCR', key)
          redis.call('EXPIRE', key, math.ceil(window / 1000))
          return {1, limit - current - 1}
        else
          return {0, 0}
        end
      `;
      
      const result = await this.redis.eval(
        luaScript,
        1,
        windowKey,
        limits.requests,
        window
      );
      
      return {
        allowed: result[0] === 1,
        remaining: result[1],
        resetTime: (windowId + 1) * window
      };
    }
  }
  
  /**
   * Check rate limit in memory
   */
  checkInMemory(key, limits) {
    const now = Date.now();
    const record = this.storage.get(key) || { requests: [], windowStart: now };
    
    if (this.options.slidingWindow) {
      // Sliding window in memory
      const windowStart = now - limits.window;
      record.requests = record.requests.filter(time => time > windowStart);
      
      if (record.requests.length < limits.requests) {
        record.requests.push(now);
        this.storage.set(key, record);
        
        return {
          allowed: true,
          remaining: limits.requests - record.requests.length,
          resetTime: record.requests[0] + limits.window
        };
      } else {
        return {
          allowed: false,
          remaining: 0,
          resetTime: record.requests[0] + limits.window
        };
      }
    } else {
      // Fixed window in memory
      if (now - record.windowStart > limits.window) {
        record.windowStart = now;
        record.count = 0;
      }
      
      if ((record.count || 0) < limits.requests) {
        record.count = (record.count || 0) + 1;
        this.storage.set(key, record);
        
        return {
          allowed: true,
          remaining: limits.requests - record.count,
          resetTime: record.windowStart + limits.window
        };
      } else {
        return {
          allowed: false,
          remaining: 0,
          resetTime: record.windowStart + limits.window
        };
      }
    }
  }
  
  /**
   * Generate storage key
   */
  generateKey(identifier, endpoint) {
    const parts = [this.options.redis.keyPrefix];
    
    if (typeof identifier === 'object') {
      if (identifier.userId) parts.push(`user:${identifier.userId}`);
      else if (identifier.ip) parts.push(`ip:${identifier.ip}`);
      else if (identifier.apiKey) parts.push(`key:${createHash('sha256').update(identifier.apiKey).digest('hex').substring(0, 16)}`);
    } else {
      parts.push(`id:${identifier}`);
    }
    
    if (endpoint) {
      parts.push(`endpoint:${endpoint.replace(/[^a-zA-Z0-9]/g, '_')}`);
    }
    
    return parts.join(':');
  }
  
  /**
   * Get applicable limits
   */
  getLimits(identifier, endpoint, options) {
    let limits = { ...this.options.defaultLimits };
    
    // Apply endpoint-specific limits
    if (endpoint && this.options.endpointLimits[endpoint]) {
      limits = { ...limits, ...this.options.endpointLimits[endpoint] };
    }
    
    // Apply user tier multipliers
    if (options.tier && this.options.tierLimits[options.tier]) {
      const tierConfig = this.options.tierLimits[options.tier];
      limits.requests = Math.floor(limits.requests * (tierConfig.multiplier || 1));
    }
    
    // Apply custom limits
    if (options.customLimits) {
      limits = { ...limits, ...options.customLimits };
    }
    
    return limits;
  }
  
  /**
   * Start synchronization for hybrid mode
   */
  startSync() {
    this.syncInterval = setInterval(() => {
      this.syncToRedis();
    }, this.options.syncInterval);
  }
  
  /**
   * Sync local changes to Redis
   */
  async syncToRedis() {
    if (this.pendingSync.size === 0) return;
    
    const batch = [];
    const processed = [];
    
    for (const [key, data] of this.pendingSync) {
      batch.push({ key, data });
      processed.push(key);
      
      if (batch.length >= this.options.syncBatchSize) break;
    }
    
    try {
      // Sync to Redis using pipeline
      const pipeline = this.redis.pipeline();
      
      for (const { key, data } of batch) {
        if (this.options.slidingWindow) {
          for (const timestamp of data.requests) {
            pipeline.zadd(key, timestamp, `${timestamp}:${Math.random()}`);
          }
          pipeline.expire(key, Math.ceil(this.options.defaultLimits.window / 1000));
        } else {
          pipeline.incrby(key, data.count);
          pipeline.expire(key, Math.ceil(this.options.defaultLimits.window / 1000));
        }
      }
      
      await pipeline.exec();
      
      // Clear processed items
      processed.forEach(key => this.pendingSync.delete(key));
      
      this.stats.syncOperations++;
      
    } catch (error) {
      this.logger.error('Sync to Redis failed:', error);
      this.stats.errors++;
    }
  }
  
  /**
   * Reset rate limit for identifier
   */
  async reset(identifier, endpoint = null) {
    const key = this.generateKey(identifier, endpoint);
    
    try {
      switch (this.options.backend) {
        case 'redis':
          await this.redis.del(key);
          break;
          
        case 'inmemory':
          this.storage.delete(key);
          break;
          
        case 'hybrid':
          await this.redis.del(key);
          this.storage.delete(key);
          this.localCache.delete(key);
          this.pendingSync.delete(key);
          break;
      }
      
      this.emit('rate_limit_reset', { identifier, endpoint });
      
    } catch (error) {
      this.logger.error('Rate limit reset failed:', error);
      throw error;
    }
  }
  
  /**
   * Get current usage for identifier
   */
  async getUsage(identifier, endpoint = null) {
    const key = this.generateKey(identifier, endpoint);
    const limits = this.getLimits(identifier, endpoint);
    
    try {
      const result = await this.checkStorage(key, limits);
      return {
        used: limits.requests - result.remaining,
        limit: limits.requests,
        remaining: result.remaining,
        resetTime: result.resetTime,
        window: limits.window
      };
      
    } catch (error) {
      this.logger.error('Get usage failed:', error);
      return null;
    }
  }
  
  /**
   * Express middleware factory
   */
  middleware(options = {}) {
    return async (req, res, next) => {
      // Determine identifier
      const identifier = options.keyGenerator ? 
        options.keyGenerator(req) : 
        {
          ip: req.ip || req.connection.remoteAddress,
          userId: req.user?.id,
          apiKey: req.headers['x-api-key']
        };
      
      // Determine endpoint
      const endpoint = options.endpoint || req.path;
      
      // Get tier from user or request
      const tier = req.user?.tier || options.defaultTier || 'free';
      
      // Check rate limit
      const result = await this.checkLimit(identifier, endpoint, { tier });
      
      // Set headers
      res.setHeader('X-RateLimit-Limit', result.limit || this.options.defaultLimits.requests);
      res.setHeader('X-RateLimit-Remaining', result.remaining || 0);
      res.setHeader('X-RateLimit-Reset', new Date(result.resetTime).toISOString());
      
      if (!result.allowed) {
        res.setHeader('Retry-After', Math.ceil((result.resetTime - Date.now()) / 1000));
        
        return res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded',
          retryAfter: result.resetTime
        });
      }
      
      next();
    };
  }
  
  /**
   * Get statistics
   */
  getStats() {
    const hitRate = this.stats.hits / (this.stats.hits + this.stats.blocked) || 0;
    const cacheHitRate = this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses) || 0;
    
    return {
      ...this.stats,
      hitRate: (hitRate * 100).toFixed(2) + '%',
      cacheHitRate: (cacheHitRate * 100).toFixed(2) + '%',
      localCacheSize: this.localCache?.size || 0,
      pendingSyncSize: this.pendingSync?.size || 0
    };
  }
  
  /**
   * Shutdown and cleanup
   */
  async shutdown() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      
      // Final sync
      if (this.pendingSync.size > 0) {
        await this.syncToRedis();
      }
    }
    
    if (this.redis) {
      await this.redis.quit();
    }
    
    this.removeAllListeners();
  }
}

/**
 * Create distributed rate limiter with default configuration
 */
export function createDistributedRateLimiter(options = {}) {
  return new DistributedRateLimiter(options);
}

export default DistributedRateLimiter;