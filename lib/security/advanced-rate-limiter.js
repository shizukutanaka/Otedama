/**
 * Advanced Rate Limiting System
 * Multi-strategy rate limiting with intelligent throttling
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const LRU = require('lru-cache');

class AdvancedRateLimiter extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Window types
            windowType: config.windowType || 'sliding', // fixed, sliding, token-bucket
            windowSize: config.windowSize || 60000, // 1 minute
            
            // Global limits
            globalRequestsPerWindow: config.globalRequestsPerWindow || 10000,
            globalBandwidthPerWindow: config.globalBandwidthPerWindow || 100 * 1024 * 1024, // 100MB
            
            // Per-IP limits
            ipRequestsPerWindow: config.ipRequestsPerWindow || 100,
            ipBandwidthPerWindow: config.ipBandwidthPerWindow || 10 * 1024 * 1024, // 10MB
            
            // Per-user limits (authenticated)
            userRequestsPerWindow: config.userRequestsPerWindow || 1000,
            userBandwidthPerWindow: config.userBandwidthPerWindow || 50 * 1024 * 1024, // 50MB
            
            // Endpoint-specific limits
            endpointLimits: config.endpointLimits || {
                '/api/login': { requests: 5, window: 300000 }, // 5 per 5 minutes
                '/api/register': { requests: 3, window: 3600000 }, // 3 per hour
                '/api/submit-share': { requests: 1000, window: 60000 }, // 1000 per minute
                '/api/payout': { requests: 10, window: 86400000 } // 10 per day
            },
            
            // Token bucket settings
            bucketCapacity: config.bucketCapacity || 100,
            refillRate: config.refillRate || 10, // tokens per second
            
            // Adaptive limiting
            enableAdaptiveLimiting: config.enableAdaptiveLimiting !== false,
            cpuThreshold: config.cpuThreshold || 80, // percentage
            memoryThreshold: config.memoryThreshold || 85, // percentage
            
            // Distributed rate limiting
            enableDistributed: config.enableDistributed || false,
            redisClient: config.redisClient || null,
            
            // Response headers
            includeHeaders: config.includeHeaders !== false,
            headerPrefix: config.headerPrefix || 'X-RateLimit-',
            
            // Penalties
            penaltyDuration: config.penaltyDuration || 900000, // 15 minutes
            penaltyMultiplier: config.penaltyMultiplier || 0.5, // 50% reduction
            
            // Cache settings
            cacheSize: config.cacheSize || 10000,
            cacheTTL: config.cacheTTL || 600000, // 10 minutes
            
            ...config
        };
        
        // Initialize stores
        this.stores = {
            fixed: new FixedWindowStore(this.config),
            sliding: new SlidingWindowStore(this.config),
            tokenBucket: new TokenBucketStore(this.config)
        };
        
        // Select active store
        this.store = this.stores[this.config.windowType];
        
        // Penalty tracking
        this.penalties = new Map();
        
        // Cache for fast lookups
        this.cache = new LRU({
            max: this.config.cacheSize,
            ttl: this.config.cacheTTL
        });
        
        // Metrics
        this.metrics = {
            totalRequests: 0,
            blockedRequests: 0,
            penalties: 0,
            adaptiveAdjustments: 0
        };
        
        // Start monitoring
        this.startMonitoring();
    }
    
    /**
     * Check rate limit
     */
    async checkLimit(identifier, options = {}) {
        const {
            type = 'ip', // ip, user, global
            endpoint = null,
            size = 0, // request size in bytes
            cost = 1 // custom cost for weighted limiting
        } = options;
        
        // Check cache first
        const cacheKey = `${type}:${identifier}:${endpoint || 'default'}`;
        const cached = this.cache.get(cacheKey);
        if (cached && cached.blocked) {
            return cached;
        }
        
        // Get limits for this request
        const limits = this.getLimits(type, endpoint);
        
        // Apply penalties if any
        const penalty = this.penalties.get(identifier);
        if (penalty && penalty.until > Date.now()) {
            limits.requests = Math.floor(limits.requests * this.config.penaltyMultiplier);
            limits.bandwidth = Math.floor(limits.bandwidth * this.config.penaltyMultiplier);
        }
        
        // Check with selected store
        const result = await this.store.check(identifier, {
            limits,
            cost,
            size
        });
        
        // Apply adaptive limiting
        if (this.config.enableAdaptiveLimiting) {
            await this.applyAdaptiveLimiting(result, limits);
        }
        
        // Update metrics
        this.metrics.totalRequests++;
        if (!result.allowed) {
            this.metrics.blockedRequests++;
            
            // Apply penalty for repeated violations
            this.applyPenalty(identifier);
        }
        
        // Cache result
        if (!result.allowed) {
            this.cache.set(cacheKey, {
                ...result,
                blocked: true,
                cachedAt: Date.now()
            });
        }
        
        // Add headers if enabled
        if (this.config.includeHeaders) {
            result.headers = this.generateHeaders(result, limits);
        }
        
        // Emit events
        if (!result.allowed) {
            this.emit('rate-limit-exceeded', {
                identifier,
                type,
                endpoint,
                result
            });
        }
        
        return result;
    }
    
    /**
     * Get limits based on type and endpoint
     */
    getLimits(type, endpoint) {
        let limits = {
            requests: this.config.ipRequestsPerWindow,
            bandwidth: this.config.ipBandwidthPerWindow,
            window: this.config.windowSize
        };
        
        // Type-specific limits
        if (type === 'user') {
            limits.requests = this.config.userRequestsPerWindow;
            limits.bandwidth = this.config.userBandwidthPerWindow;
        } else if (type === 'global') {
            limits.requests = this.config.globalRequestsPerWindow;
            limits.bandwidth = this.config.globalBandwidthPerWindow;
        }
        
        // Endpoint-specific limits override
        if (endpoint && this.config.endpointLimits[endpoint]) {
            const endpointLimit = this.config.endpointLimits[endpoint];
            limits.requests = endpointLimit.requests;
            limits.window = endpointLimit.window || limits.window;
            
            if (endpointLimit.bandwidth) {
                limits.bandwidth = endpointLimit.bandwidth;
            }
        }
        
        return limits;
    }
    
    /**
     * Apply adaptive limiting based on system resources
     */
    async applyAdaptiveLimiting(result, limits) {
        const resources = await this.getSystemResources();
        
        let adjustmentFactor = 1;
        
        // Reduce limits if CPU is high
        if (resources.cpu > this.config.cpuThreshold) {
            adjustmentFactor *= (100 - resources.cpu) / 20;
        }
        
        // Reduce limits if memory is high
        if (resources.memory > this.config.memoryThreshold) {
            adjustmentFactor *= (100 - resources.memory) / 15;
        }
        
        if (adjustmentFactor < 1) {
            limits.requests = Math.floor(limits.requests * adjustmentFactor);
            limits.bandwidth = Math.floor(limits.bandwidth * adjustmentFactor);
            
            this.metrics.adaptiveAdjustments++;
            
            this.emit('adaptive-limiting', {
                resources,
                adjustmentFactor,
                newLimits: limits
            });
        }
    }
    
    /**
     * Apply penalty for repeated violations
     */
    applyPenalty(identifier) {
        const existing = this.penalties.get(identifier);
        const violations = existing ? existing.violations + 1 : 1;
        
        this.penalties.set(identifier, {
            violations,
            until: Date.now() + this.config.penaltyDuration * violations
        });
        
        this.metrics.penalties++;
        
        this.emit('penalty-applied', {
            identifier,
            violations,
            duration: this.config.penaltyDuration * violations
        });
    }
    
    /**
     * Generate rate limit headers
     */
    generateHeaders(result, limits) {
        const headers = {};
        const prefix = this.config.headerPrefix;
        
        headers[`${prefix}Limit`] = limits.requests.toString();
        headers[`${prefix}Remaining`] = Math.max(0, result.remaining).toString();
        headers[`${prefix}Reset`] = new Date(result.resetAt).toISOString();
        
        if (!result.allowed) {
            headers[`${prefix}Retry-After`] = Math.ceil((result.resetAt - Date.now()) / 1000).toString();
        }
        
        if (limits.bandwidth) {
            headers[`${prefix}Bandwidth-Limit`] = limits.bandwidth.toString();
            headers[`${prefix}Bandwidth-Remaining`] = Math.max(0, result.bandwidthRemaining || 0).toString();
        }
        
        return headers;
    }
    
    /**
     * Reset limits for identifier
     */
    async reset(identifier) {
        await this.store.reset(identifier);
        this.penalties.delete(identifier);
        this.cache.delete(identifier);
        
        this.emit('limits-reset', { identifier });
    }
    
    /**
     * Get current usage
     */
    async getUsage(identifier) {
        return await this.store.getUsage(identifier);
    }
    
    /**
     * Express middleware
     */
    middleware(options = {}) {
        return async (req, res, next) => {
            // Determine identifier
            let identifier = req.ip || req.connection.remoteAddress;
            let type = 'ip';
            
            // Use user ID if authenticated
            if (options.userIdPath && req[options.userIdPath]) {
                identifier = req[options.userIdPath];
                type = 'user';
            } else if (req.user && req.user.id) {
                identifier = req.user.id;
                type = 'user';
            }
            
            // Custom identifier function
            if (options.keyGenerator) {
                identifier = await options.keyGenerator(req);
            }
            
            // Check rate limit
            const result = await this.checkLimit(identifier, {
                type,
                endpoint: req.path,
                size: parseInt(req.headers['content-length'] || '0'),
                cost: options.cost || 1
            });
            
            // Add headers
            if (result.headers) {
                Object.entries(result.headers).forEach(([key, value]) => {
                    res.setHeader(key, value);
                });
            }
            
            // Block if exceeded
            if (!result.allowed) {
                const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
                
                return res.status(429).json({
                    error: 'Too many requests',
                    message: options.message || 'Rate limit exceeded',
                    retryAfter
                });
            }
            
            next();
        };
    }
    
    /**
     * Get system resources
     */
    async getSystemResources() {
        const os = require('os');
        
        // CPU usage
        const cpus = os.cpus();
        let totalIdle = 0;
        let totalTick = 0;
        
        cpus.forEach(cpu => {
            for (const type in cpu.times) {
                totalTick += cpu.times[type];
            }
            totalIdle += cpu.times.idle;
        });
        
        const cpuUsage = 100 - ~~(100 * totalIdle / totalTick);
        
        // Memory usage
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const memUsage = Math.round((1 - freeMem / totalMem) * 100);
        
        return {
            cpu: cpuUsage,
            memory: memUsage
        };
    }
    
    /**
     * Start monitoring tasks
     */
    startMonitoring() {
        // Clean penalties
        setInterval(() => {
            const now = Date.now();
            for (const [id, penalty] of this.penalties) {
                if (penalty.until < now) {
                    this.penalties.delete(id);
                }
            }
        }, 60000); // Every minute
        
        // Emit metrics
        setInterval(() => {
            this.emit('metrics', this.getMetrics());
        }, 300000); // Every 5 minutes
    }
    
    /**
     * Get metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            hitRate: this.metrics.totalRequests > 0 
                ? ((this.metrics.totalRequests - this.metrics.blockedRequests) / this.metrics.totalRequests * 100).toFixed(2) + '%'
                : '100%',
            cacheSize: this.cache.size,
            penaltiesActive: this.penalties.size
        };
    }
}

/**
 * Fixed Window Store
 */
class FixedWindowStore {
    constructor(config) {
        this.config = config;
        this.windows = new Map();
    }
    
    async check(identifier, options) {
        const now = Date.now();
        const windowStart = Math.floor(now / options.limits.window) * options.limits.window;
        const windowEnd = windowStart + options.limits.window;
        
        const key = `${identifier}:${windowStart}`;
        let window = this.windows.get(key);
        
        if (!window) {
            window = {
                requests: 0,
                bandwidth: 0,
                windowStart,
                windowEnd
            };
            this.windows.set(key, window);
            
            // Clean old windows
            this.cleanup();
        }
        
        // Check limits
        if (window.requests + options.cost > options.limits.requests) {
            return {
                allowed: false,
                remaining: 0,
                resetAt: windowEnd,
                reason: 'requests'
            };
        }
        
        if (options.size && window.bandwidth + options.size > options.limits.bandwidth) {
            return {
                allowed: false,
                remaining: options.limits.requests - window.requests,
                bandwidthRemaining: 0,
                resetAt: windowEnd,
                reason: 'bandwidth'
            };
        }
        
        // Update window
        window.requests += options.cost;
        window.bandwidth += options.size || 0;
        
        return {
            allowed: true,
            remaining: options.limits.requests - window.requests,
            bandwidthRemaining: options.limits.bandwidth - window.bandwidth,
            resetAt: windowEnd
        };
    }
    
    async reset(identifier) {
        // Remove all windows for identifier
        for (const [key] of this.windows) {
            if (key.startsWith(identifier + ':')) {
                this.windows.delete(key);
            }
        }
    }
    
    async getUsage(identifier) {
        const now = Date.now();
        const usage = {
            requests: 0,
            bandwidth: 0
        };
        
        for (const [key, window] of this.windows) {
            if (key.startsWith(identifier + ':') && window.windowEnd > now) {
                usage.requests += window.requests;
                usage.bandwidth += window.bandwidth;
            }
        }
        
        return usage;
    }
    
    cleanup() {
        const now = Date.now();
        for (const [key, window] of this.windows) {
            if (window.windowEnd < now) {
                this.windows.delete(key);
            }
        }
    }
}

/**
 * Sliding Window Store
 */
class SlidingWindowStore {
    constructor(config) {
        this.config = config;
        this.logs = new Map();
    }
    
    async check(identifier, options) {
        const now = Date.now();
        const windowStart = now - options.limits.window;
        
        // Get or create log
        let log = this.logs.get(identifier);
        if (!log) {
            log = [];
            this.logs.set(identifier, log);
        }
        
        // Remove old entries
        log = log.filter(entry => entry.timestamp > windowStart);
        this.logs.set(identifier, log);
        
        // Calculate current usage
        const usage = log.reduce((acc, entry) => ({
            requests: acc.requests + entry.cost,
            bandwidth: acc.bandwidth + entry.size
        }), { requests: 0, bandwidth: 0 });
        
        // Check limits
        if (usage.requests + options.cost > options.limits.requests) {
            const oldestEntry = log[0];
            const resetAt = oldestEntry ? oldestEntry.timestamp + options.limits.window : now;
            
            return {
                allowed: false,
                remaining: 0,
                resetAt,
                reason: 'requests'
            };
        }
        
        if (options.size && usage.bandwidth + options.size > options.limits.bandwidth) {
            const oldestEntry = log[0];
            const resetAt = oldestEntry ? oldestEntry.timestamp + options.limits.window : now;
            
            return {
                allowed: false,
                remaining: options.limits.requests - usage.requests,
                bandwidthRemaining: 0,
                resetAt,
                reason: 'bandwidth'
            };
        }
        
        // Add new entry
        log.push({
            timestamp: now,
            cost: options.cost,
            size: options.size || 0
        });
        
        return {
            allowed: true,
            remaining: options.limits.requests - usage.requests - options.cost,
            bandwidthRemaining: options.limits.bandwidth - usage.bandwidth - (options.size || 0),
            resetAt: log[0].timestamp + options.limits.window
        };
    }
    
    async reset(identifier) {
        this.logs.delete(identifier);
    }
    
    async getUsage(identifier) {
        const log = this.logs.get(identifier) || [];
        return log.reduce((acc, entry) => ({
            requests: acc.requests + entry.cost,
            bandwidth: acc.bandwidth + entry.size
        }), { requests: 0, bandwidth: 0 });
    }
}

/**
 * Token Bucket Store
 */
class TokenBucketStore {
    constructor(config) {
        this.config = config;
        this.buckets = new Map();
    }
    
    async check(identifier, options) {
        const now = Date.now();
        
        let bucket = this.buckets.get(identifier);
        if (!bucket) {
            bucket = {
                tokens: this.config.bucketCapacity,
                lastRefill: now,
                bandwidth: options.limits.bandwidth
            };
            this.buckets.set(identifier, bucket);
        }
        
        // Refill tokens
        const timeSinceRefill = now - bucket.lastRefill;
        const tokensToAdd = (timeSinceRefill / 1000) * this.config.refillRate;
        bucket.tokens = Math.min(this.config.bucketCapacity, bucket.tokens + tokensToAdd);
        bucket.lastRefill = now;
        
        // Check tokens
        if (bucket.tokens < options.cost) {
            const tokensNeeded = options.cost - bucket.tokens;
            const timeToWait = (tokensNeeded / this.config.refillRate) * 1000;
            
            return {
                allowed: false,
                remaining: Math.floor(bucket.tokens),
                resetAt: now + timeToWait,
                reason: 'tokens'
            };
        }
        
        // Check bandwidth
        if (options.size && options.size > bucket.bandwidth) {
            return {
                allowed: false,
                remaining: Math.floor(bucket.tokens),
                bandwidthRemaining: bucket.bandwidth,
                resetAt: now + 1000, // Reset in 1 second
                reason: 'bandwidth'
            };
        }
        
        // Consume tokens
        bucket.tokens -= options.cost;
        bucket.bandwidth -= options.size || 0;
        
        // Reset bandwidth periodically
        if (now - bucket.lastBandwidthReset > 1000) {
            bucket.bandwidth = options.limits.bandwidth;
            bucket.lastBandwidthReset = now;
        }
        
        return {
            allowed: true,
            remaining: Math.floor(bucket.tokens),
            bandwidthRemaining: bucket.bandwidth,
            resetAt: now + ((this.config.bucketCapacity - bucket.tokens) / this.config.refillRate) * 1000
        };
    }
    
    async reset(identifier) {
        this.buckets.delete(identifier);
    }
    
    async getUsage(identifier) {
        const bucket = this.buckets.get(identifier);
        if (!bucket) {
            return { requests: 0, bandwidth: 0 };
        }
        
        return {
            requests: this.config.bucketCapacity - bucket.tokens,
            bandwidth: this.config.globalBandwidthPerWindow - bucket.bandwidth
        };
    }
}

module.exports = AdvancedRateLimiter;