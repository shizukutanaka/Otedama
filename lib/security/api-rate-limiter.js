const EventEmitter = require('events');
const crypto = require('crypto');

/**
 * Advanced API Rate Limiter
 * Implements token bucket algorithm with distributed support
 */
class ApiRateLimiter extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            // Default limits
            windowMs: options.windowMs || 60000, // 1 minute
            maxRequests: options.maxRequests || 100,
            
            // Advanced options
            skipSuccessfulRequests: options.skipSuccessfulRequests || false,
            skipFailedRequests: options.skipFailedRequests || false,
            keyGenerator: options.keyGenerator || this.defaultKeyGenerator,
            handler: options.handler || this.defaultHandler,
            
            // Token bucket options
            bucketSize: options.bucketSize || options.maxRequests || 100,
            refillRate: options.refillRate || 10, // tokens per second
            
            // Distributed options
            store: options.store || new MemoryStore(),
            prefix: options.prefix || 'rl:',
            
            // Security options
            trustProxy: options.trustProxy || false,
            blockDuration: options.blockDuration || 3600000, // 1 hour
            maxViolations: options.maxViolations || 5,
            
            // Different limits for different endpoints
            endpoints: options.endpoints || {},
            
            // User-based limits
            userLimits: options.userLimits || {},
            
            // IP whitelist/blacklist
            whitelist: new Set(options.whitelist || []),
            blacklist: new Set(options.blacklist || []),
            
            ...options
        };
        
        this.violations = new Map();
        this.stats = {
            totalRequests: 0,
            blockedRequests: 0,
            allowedRequests: 0,
            violations: 0
        };
        
        this.setupCleanup();
        this.emit('initialized', this.options);
    }
    
    /**
     * Express middleware
     */
    middleware() {
        return async (req, res, next) => {
            try {
                const result = await this.checkLimit(req);
                
                // Set rate limit headers
                res.setHeader('X-RateLimit-Limit', result.limit);
                res.setHeader('X-RateLimit-Remaining', result.remaining);
                res.setHeader('X-RateLimit-Reset', new Date(result.resetTime).toISOString());
                
                if (!result.allowed) {
                    res.setHeader('Retry-After', Math.ceil(result.retryAfter / 1000));
                    return this.options.handler(req, res, result);
                }
                
                // Store result for potential skip logic
                req.rateLimit = result;
                
                // Add response interceptor for skip logic
                if (this.options.skipSuccessfulRequests || this.options.skipFailedRequests) {
                    const originalSend = res.send;
                    res.send = function(...args) {
                        if ((res.statusCode < 400 && req.rateLimit.skipSuccessful) ||
                            (res.statusCode >= 400 && req.rateLimit.skipFailed)) {
                            // Refund the request
                            req.rateLimit.refund();
                        }
                        return originalSend.apply(res, args);
                    };
                }
                
                next();
            } catch (error) {
                this.emit('error', error);
                next(); // Don't block on errors
            }
        };
    }
    
    /**
     * Check rate limit for request
     */
    async checkLimit(req) {
        this.stats.totalRequests++;
        
        // Generate key
        const key = this.options.keyGenerator(req);
        
        // Check whitelist/blacklist
        const ip = this.getIP(req);
        if (this.options.whitelist.has(ip)) {
            this.stats.allowedRequests++;
            return { allowed: true, limit: Infinity, remaining: Infinity };
        }
        
        if (this.options.blacklist.has(ip)) {
            this.stats.blockedRequests++;
            this.recordViolation(key);
            return { 
                allowed: false, 
                limit: 0, 
                remaining: 0,
                reason: 'blacklisted'
            };
        }
        
        // Check if blocked due to violations
        if (this.isBlocked(key)) {
            this.stats.blockedRequests++;
            const blockInfo = this.violations.get(key);
            return {
                allowed: false,
                limit: 0,
                remaining: 0,
                reason: 'blocked',
                retryAfter: blockInfo.blockedUntil - Date.now()
            };
        }
        
        // Get endpoint-specific or user-specific limits
        const limits = this.getLimits(req);
        
        // Get current state from store
        const state = await this.options.store.get(this.options.prefix + key);
        const now = Date.now();
        
        // Initialize or update token bucket
        let bucket;
        if (!state || now - state.lastRefill > this.options.windowMs) {
            // New bucket
            bucket = {
                tokens: limits.bucketSize,
                lastRefill: now
            };
        } else {
            // Refill bucket
            const timePassed = now - state.lastRefill;
            const tokensToAdd = (timePassed / 1000) * limits.refillRate;
            bucket = {
                tokens: Math.min(limits.bucketSize, state.tokens + tokensToAdd),
                lastRefill: now
            };
        }
        
        // Check if request can be allowed
        const allowed = bucket.tokens >= 1;
        
        if (allowed) {
            bucket.tokens -= 1;
            this.stats.allowedRequests++;
        } else {
            this.stats.blockedRequests++;
            this.recordViolation(key);
        }
        
        // Save state
        await this.options.store.set(this.options.prefix + key, bucket, this.options.windowMs);
        
        // Calculate reset time
        const tokensNeeded = limits.bucketSize - bucket.tokens;
        const timeToReset = (tokensNeeded / limits.refillRate) * 1000;
        const resetTime = now + timeToReset;
        
        // Create refund function
        const refund = async () => {
            const currentState = await this.options.store.get(this.options.prefix + key);
            if (currentState) {
                currentState.tokens = Math.min(limits.bucketSize, currentState.tokens + 1);
                await this.options.store.set(this.options.prefix + key, currentState, this.options.windowMs);
            }
        };
        
        return {
            allowed,
            limit: limits.bucketSize,
            remaining: Math.max(0, Math.floor(bucket.tokens)),
            resetTime,
            retryAfter: allowed ? 0 : (1 / limits.refillRate) * 1000,
            key,
            skipSuccessful: this.options.skipSuccessfulRequests,
            skipFailed: this.options.skipFailedRequests,
            refund
        };
    }
    
    /**
     * Get limits for request
     */
    getLimits(req) {
        // Check endpoint-specific limits
        const endpoint = req.path;
        if (this.options.endpoints[endpoint]) {
            return this.options.endpoints[endpoint];
        }
        
        // Check user-specific limits
        if (req.user && this.options.userLimits[req.user.role]) {
            return this.options.userLimits[req.user.role];
        }
        
        // Default limits
        return {
            bucketSize: this.options.bucketSize,
            refillRate: this.options.refillRate
        };
    }
    
    /**
     * Default key generator
     */
    defaultKeyGenerator(req) {
        return this.getIP(req);
    }
    
    /**
     * Get IP address from request
     */
    getIP(req) {
        if (this.options.trustProxy) {
            return req.ip || 
                   req.headers['x-forwarded-for']?.split(',')[0] || 
                   req.headers['x-real-ip'] ||
                   req.connection.remoteAddress;
        }
        return req.connection.remoteAddress;
    }
    
    /**
     * Default rate limit handler
     */
    defaultHandler(req, res, result) {
        res.status(429).json({
            error: 'Too many requests',
            message: `Rate limit exceeded. Try again in ${Math.ceil(result.retryAfter / 1000)} seconds`,
            retryAfter: result.retryAfter,
            limit: result.limit,
            remaining: result.remaining,
            resetTime: new Date(result.resetTime).toISOString()
        });
    }
    
    /**
     * Record violation
     */
    recordViolation(key) {
        const violations = this.violations.get(key) || { count: 0 };
        violations.count++;
        violations.lastViolation = Date.now();
        
        if (violations.count >= this.options.maxViolations) {
            violations.blocked = true;
            violations.blockedUntil = Date.now() + this.options.blockDuration;
            this.emit('blocked', { key, violations: violations.count });
        }
        
        this.violations.set(key, violations);
        this.stats.violations++;
    }
    
    /**
     * Check if key is blocked
     */
    isBlocked(key) {
        const violations = this.violations.get(key);
        if (!violations || !violations.blocked) {
            return false;
        }
        
        if (Date.now() > violations.blockedUntil) {
            // Unblock
            violations.blocked = false;
            violations.count = 0;
            this.violations.set(key, violations);
            return false;
        }
        
        return true;
    }
    
    /**
     * Reset limits for key
     */
    async reset(key) {
        await this.options.store.delete(this.options.prefix + key);
        this.violations.delete(key);
        this.emit('reset', { key });
    }
    
    /**
     * Add IP to whitelist
     */
    whitelist(ip) {
        this.options.whitelist.add(ip);
        this.emit('whitelisted', { ip });
    }
    
    /**
     * Remove IP from whitelist
     */
    unwhitelist(ip) {
        this.options.whitelist.delete(ip);
        this.emit('unwhitelisted', { ip });
    }
    
    /**
     * Add IP to blacklist
     */
    blacklist(ip) {
        this.options.blacklist.add(ip);
        this.emit('blacklisted', { ip });
    }
    
    /**
     * Remove IP from blacklist
     */
    unblacklist(ip) {
        this.options.blacklist.delete(ip);
        this.emit('unblacklisted', { ip });
    }
    
    /**
     * Update endpoint limits
     */
    setEndpointLimits(endpoint, limits) {
        this.options.endpoints[endpoint] = limits;
        this.emit('endpoint-limits-updated', { endpoint, limits });
    }
    
    /**
     * Update user role limits
     */
    setUserLimits(role, limits) {
        this.options.userLimits[role] = limits;
        this.emit('user-limits-updated', { role, limits });
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            blacklistSize: this.options.blacklist.size,
            whitelistSize: this.options.whitelist.size,
            violationsCount: this.violations.size,
            blockedCount: Array.from(this.violations.values()).filter(v => v.blocked).length,
            timestamp: new Date().toISOString()
        };
    }
    
    /**
     * Setup periodic cleanup
     */
    setupCleanup() {
        // Clean up old violations every hour
        setInterval(() => {
            const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
            let cleaned = 0;
            
            for (const [key, violations] of this.violations) {
                if (!violations.blocked && violations.lastViolation < cutoff) {
                    this.violations.delete(key);
                    cleaned++;
                }
            }
            
            if (cleaned > 0) {
                this.emit('cleanup', { cleaned });
            }
        }, 60 * 60 * 1000);
    }
}

/**
 * In-memory store for rate limiting
 */
class MemoryStore {
    constructor() {
        this.data = new Map();
        this.timers = new Map();
    }
    
    async get(key) {
        return this.data.get(key);
    }
    
    async set(key, value, ttl) {
        this.data.set(key, value);
        
        // Clear existing timer
        if (this.timers.has(key)) {
            clearTimeout(this.timers.get(key));
        }
        
        // Set new timer
        const timer = setTimeout(() => {
            this.delete(key);
        }, ttl);
        
        this.timers.set(key, timer);
    }
    
    async delete(key) {
        this.data.delete(key);
        
        if (this.timers.has(key)) {
            clearTimeout(this.timers.get(key));
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
}

/**
 * Redis store for distributed rate limiting
 */
class RedisStore {
    constructor(client, prefix = 'rl:') {
        this.client = client;
        this.prefix = prefix;
    }
    
    async get(key) {
        const data = await this.client.get(this.prefix + key);
        return data ? JSON.parse(data) : null;
    }
    
    async set(key, value, ttl) {
        await this.client.setex(
            this.prefix + key,
            Math.ceil(ttl / 1000),
            JSON.stringify(value)
        );
    }
    
    async delete(key) {
        await this.client.del(this.prefix + key);
    }
    
    async clear() {
        const keys = await this.client.keys(this.prefix + '*');
        if (keys.length > 0) {
            await this.client.del(...keys);
        }
    }
}

/**
 * Create rate limiter with common presets
 */
class RateLimiterPresets {
    static strict() {
        return new ApiRateLimiter({
            windowMs: 60000,
            maxRequests: 10,
            blockDuration: 3600000,
            maxViolations: 3
        });
    }
    
    static standard() {
        return new ApiRateLimiter({
            windowMs: 60000,
            maxRequests: 100,
            blockDuration: 900000,
            maxViolations: 5
        });
    }
    
    static lenient() {
        return new ApiRateLimiter({
            windowMs: 60000,
            maxRequests: 1000,
            blockDuration: 300000,
            maxViolations: 10
        });
    }
    
    static api() {
        return new ApiRateLimiter({
            windowMs: 60000,
            maxRequests: 60,
            skipSuccessfulRequests: true,
            endpoints: {
                '/api/v1/auth/login': { bucketSize: 5, refillRate: 0.1 },
                '/api/v1/auth/register': { bucketSize: 3, refillRate: 0.05 },
                '/api/v1/mining/submit': { bucketSize: 1000, refillRate: 100 }
            },
            userLimits: {
                'premium': { bucketSize: 1000, refillRate: 20 },
                'basic': { bucketSize: 100, refillRate: 10 },
                'free': { bucketSize: 50, refillRate: 5 }
            }
        });
    }
}

module.exports = {
    ApiRateLimiter,
    MemoryStore,
    RedisStore,
    RateLimiterPresets
};