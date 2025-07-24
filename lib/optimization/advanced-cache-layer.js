/**
 * Advanced Multi-Tier Caching System
 * 高度な多層キャッシングシステム
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const LRU = require('lru-cache');

class AdvancedCacheLayer extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Cache tiers configuration
            tiers: config.tiers || [
                {
                    name: 'l1-hot',
                    type: 'memory',
                    maxSize: 100 * 1024 * 1024, // 100MB
                    maxAge: 60000, // 1 minute
                    updateAgeOnGet: true
                },
                {
                    name: 'l2-warm',
                    type: 'memory',
                    maxSize: 500 * 1024 * 1024, // 500MB
                    maxAge: 300000, // 5 minutes
                    updateAgeOnGet: false
                },
                {
                    name: 'l3-cold',
                    type: 'redis',
                    maxSize: 2 * 1024 * 1024 * 1024, // 2GB
                    maxAge: 3600000, // 1 hour
                    connection: config.redisConnection
                }
            ],
            
            // Cache policies
            evictionPolicy: config.evictionPolicy || 'lru',
            compressionThreshold: config.compressionThreshold || 1024, // 1KB
            enableCompression: config.enableCompression !== false,
            
            // Performance options
            enableStatistics: config.enableStatistics !== false,
            enableWarmup: config.enableWarmup !== false,
            warmupKeys: config.warmupKeys || [],
            
            // Invalidation
            enableBroadcastInvalidation: config.enableBroadcastInvalidation || false,
            invalidationChannel: config.invalidationChannel || 'cache-invalidation',
            
            // Adaptive caching
            enableAdaptiveCaching: config.enableAdaptiveCaching !== false,
            adaptiveInterval: config.adaptiveInterval || 60000, // 1 minute
            
            ...config
        };
        
        // Cache tiers
        this.tiers = [];
        
        // Cache statistics
        this.stats = {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0,
            evictions: 0,
            promotions: 0,
            demotions: 0,
            compressions: 0,
            decompressions: 0
        };
        
        // Hit rate tracking
        this.hitRateWindow = [];
        this.accessPatterns = new Map();
        
        // Initialize
        this.initialize();
    }
    
    async initialize() {
        console.log('高度なキャッシュレイヤーを初期化中...');
        
        // Initialize cache tiers
        await this.initializeTiers();
        
        // Setup invalidation broadcasting
        if (this.config.enableBroadcastInvalidation) {
            await this.setupInvalidationBroadcast();
        }
        
        // Start adaptive caching
        if (this.config.enableAdaptiveCaching) {
            this.startAdaptiveCaching();
        }
        
        // Perform cache warmup
        if (this.config.enableWarmup) {
            await this.performWarmup();
        }
        
        console.log('✓ キャッシュレイヤーの初期化完了');
    }
    
    /**
     * Initialize cache tiers
     */
    async initializeTiers() {
        for (const tierConfig of this.config.tiers) {
            const tier = await this.createTier(tierConfig);
            this.tiers.push(tier);
        }
    }
    
    /**
     * Create a cache tier
     */
    async createTier(config) {
        let cache;
        
        switch (config.type) {
            case 'memory':
                cache = new MemoryCacheTier(config);
                break;
                
            case 'redis':
                cache = new RedisCacheTier(config);
                await cache.connect();
                break;
                
            case 'disk':
                cache = new DiskCacheTier(config);
                break;
                
            default:
                throw new Error(`Unknown cache tier type: ${config.type}`);
        }
        
        // Setup event handlers
        cache.on('eviction', (key) => {
            this.stats.evictions++;
            this.handleEviction(key, cache);
        });
        
        return cache;
    }
    
    /**
     * Get value from cache
     */
    async get(key, options = {}) {
        const startTime = Date.now();
        const hashedKey = this.hashKey(key);
        
        // Track access pattern
        this.trackAccess(hashedKey);
        
        // Search through tiers
        for (let i = 0; i < this.tiers.length; i++) {
            const tier = this.tiers[i];
            
            try {
                const value = await tier.get(hashedKey);
                
                if (value !== undefined && value !== null) {
                    // Cache hit
                    this.stats.hits++;
                    this.updateHitRate(true);
                    
                    // Decompress if needed
                    const decompressed = await this.decompress(value);
                    
                    // Promote to higher tier if accessed frequently
                    if (i > 0 && this.shouldPromote(hashedKey)) {
                        await this.promote(hashedKey, decompressed, i);
                    }
                    
                    this.emit('cache-hit', {
                        key,
                        tier: tier.name,
                        latency: Date.now() - startTime
                    });
                    
                    return decompressed;
                }
            } catch (error) {
                console.error(`キャッシュ読み取りエラー (${tier.name}):`, error);
            }
        }
        
        // Cache miss
        this.stats.misses++;
        this.updateHitRate(false);
        
        this.emit('cache-miss', {
            key,
            latency: Date.now() - startTime
        });
        
        return null;
    }
    
    /**
     * Set value in cache
     */
    async set(key, value, options = {}) {
        const startTime = Date.now();
        const hashedKey = this.hashKey(key);
        
        this.stats.sets++;
        
        // Compress if needed
        const compressed = await this.compress(value);
        const size = this.getSize(compressed);
        
        // Determine which tier to use based on value characteristics
        const tierIndex = this.selectTier(size, options);
        const tier = this.tiers[tierIndex];
        
        try {
            await tier.set(hashedKey, compressed, options);
            
            // Broadcast invalidation if enabled
            if (this.config.enableBroadcastInvalidation) {
                await this.broadcastInvalidation(key);
            }
            
            this.emit('cache-set', {
                key,
                tier: tier.name,
                size,
                latency: Date.now() - startTime
            });
            
        } catch (error) {
            console.error(`キャッシュ書き込みエラー (${tier.name}):`, error);
            
            // Try next tier
            if (tierIndex < this.tiers.length - 1) {
                await this.tiers[tierIndex + 1].set(hashedKey, compressed, options);
            }
        }
    }
    
    /**
     * Delete value from cache
     */
    async delete(key) {
        const hashedKey = this.hashKey(key);
        this.stats.deletes++;
        
        // Delete from all tiers
        const promises = this.tiers.map(tier => 
            tier.delete(hashedKey).catch(err => 
                console.error(`削除エラー (${tier.name}):`, err)
            )
        );
        
        await Promise.all(promises);
        
        // Broadcast invalidation
        if (this.config.enableBroadcastInvalidation) {
            await this.broadcastInvalidation(key);
        }
        
        this.emit('cache-delete', { key });
    }
    
    /**
     * Clear all caches
     */
    async clear() {
        const promises = this.tiers.map(tier => 
            tier.clear().catch(err => 
                console.error(`クリアエラー (${tier.name}):`, err)
            )
        );
        
        await Promise.all(promises);
        
        // Reset statistics
        this.resetStatistics();
        
        this.emit('cache-cleared');
    }
    
    /**
     * Hash key for consistent distribution
     */
    hashKey(key) {
        if (typeof key === 'string') {
            return key;
        }
        
        return crypto
            .createHash('sha256')
            .update(JSON.stringify(key))
            .digest('hex');
    }
    
    /**
     * Compress value if needed
     */
    async compress(value) {
        const serialized = JSON.stringify(value);
        
        if (!this.config.enableCompression || 
            serialized.length < this.config.compressionThreshold) {
            return { compressed: false, data: serialized };
        }
        
        const zlib = require('zlib');
        const compressed = await new Promise((resolve, reject) => {
            zlib.gzip(Buffer.from(serialized), (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        
        this.stats.compressions++;
        
        return {
            compressed: true,
            data: compressed.toString('base64')
        };
    }
    
    /**
     * Decompress value if needed
     */
    async decompress(value) {
        if (!value.compressed) {
            return JSON.parse(value.data);
        }
        
        const zlib = require('zlib');
        const decompressed = await new Promise((resolve, reject) => {
            zlib.gunzip(Buffer.from(value.data, 'base64'), (err, result) => {
                if (err) reject(err);
                else resolve(result.toString());
            });
        });
        
        this.stats.decompressions++;
        
        return JSON.parse(decompressed);
    }
    
    /**
     * Get size of value
     */
    getSize(value) {
        const str = JSON.stringify(value);
        return Buffer.byteLength(str);
    }
    
    /**
     * Select appropriate tier for value
     */
    selectTier(size, options) {
        // Priority override
        if (options.tier !== undefined) {
            return Math.min(options.tier, this.tiers.length - 1);
        }
        
        // Hot data goes to L1
        if (options.hot || size < 1024) {
            return 0;
        }
        
        // Large data goes to lower tiers
        if (size > 1024 * 1024) { // 1MB
            return Math.min(2, this.tiers.length - 1);
        }
        
        // Default to L2
        return Math.min(1, this.tiers.length - 1);
    }
    
    /**
     * Track access patterns
     */
    trackAccess(key) {
        const now = Date.now();
        
        if (!this.accessPatterns.has(key)) {
            this.accessPatterns.set(key, {
                count: 0,
                firstAccess: now,
                lastAccess: now,
                accessTimes: []
            });
        }
        
        const pattern = this.accessPatterns.get(key);
        pattern.count++;
        pattern.lastAccess = now;
        pattern.accessTimes.push(now);
        
        // Keep only recent accesses
        if (pattern.accessTimes.length > 100) {
            pattern.accessTimes.shift();
        }
    }
    
    /**
     * Determine if key should be promoted
     */
    shouldPromote(key) {
        const pattern = this.accessPatterns.get(key);
        if (!pattern) return false;
        
        // Promote if accessed frequently
        const recentAccesses = pattern.accessTimes.filter(
            time => Date.now() - time < 60000 // Last minute
        ).length;
        
        return recentAccesses >= 5;
    }
    
    /**
     * Promote value to higher tier
     */
    async promote(key, value, currentTier) {
        if (currentTier === 0) return;
        
        const targetTier = currentTier - 1;
        
        try {
            await this.tiers[targetTier].set(key, value);
            this.stats.promotions++;
            
            this.emit('cache-promotion', {
                key,
                from: this.tiers[currentTier].name,
                to: this.tiers[targetTier].name
            });
        } catch (error) {
            console.error('プロモーションエラー:', error);
        }
    }
    
    /**
     * Handle eviction from a tier
     */
    async handleEviction(key, tier) {
        const tierIndex = this.tiers.indexOf(tier);
        
        // Try to demote to lower tier
        if (tierIndex < this.tiers.length - 1) {
            try {
                const value = await tier.get(key);
                if (value) {
                    await this.tiers[tierIndex + 1].set(key, value);
                    this.stats.demotions++;
                    
                    this.emit('cache-demotion', {
                        key,
                        from: tier.name,
                        to: this.tiers[tierIndex + 1].name
                    });
                }
            } catch (error) {
                console.error('デモーションエラー:', error);
            }
        }
    }
    
    /**
     * Update hit rate tracking
     */
    updateHitRate(hit) {
        const now = Date.now();
        
        this.hitRateWindow.push({ time: now, hit });
        
        // Keep only recent data (last 5 minutes)
        const cutoff = now - 300000;
        this.hitRateWindow = this.hitRateWindow.filter(
            entry => entry.time > cutoff
        );
    }
    
    /**
     * Calculate current hit rate
     */
    getHitRate() {
        if (this.hitRateWindow.length === 0) return 0;
        
        const hits = this.hitRateWindow.filter(entry => entry.hit).length;
        return (hits / this.hitRateWindow.length) * 100;
    }
    
    /**
     * Start adaptive caching
     */
    startAdaptiveCaching() {
        setInterval(() => {
            this.adaptCacheParameters();
        }, this.config.adaptiveInterval);
    }
    
    /**
     * Adapt cache parameters based on usage patterns
     */
    adaptCacheParameters() {
        const hitRate = this.getHitRate();
        
        // Adjust tier sizes based on hit rate
        if (hitRate < 50) {
            // Low hit rate - increase L1 cache size
            const l1 = this.tiers[0];
            if (l1 && l1.adjustSize) {
                l1.adjustSize(1.2); // Increase by 20%
            }
        } else if (hitRate > 90) {
            // High hit rate - can reduce cache size
            const l1 = this.tiers[0];
            if (l1 && l1.adjustSize) {
                l1.adjustSize(0.9); // Decrease by 10%
            }
        }
        
        // Clean up stale access patterns
        const cutoff = Date.now() - 3600000; // 1 hour
        for (const [key, pattern] of this.accessPatterns) {
            if (pattern.lastAccess < cutoff) {
                this.accessPatterns.delete(key);
            }
        }
    }
    
    /**
     * Setup invalidation broadcast
     */
    async setupInvalidationBroadcast() {
        // This would connect to Redis pub/sub or similar
        // Placeholder for now
        console.log('無効化ブロードキャストを設定中...');
    }
    
    /**
     * Broadcast cache invalidation
     */
    async broadcastInvalidation(key) {
        // Broadcast to other instances
        // Placeholder for now
        this.emit('invalidation-broadcast', { key });
    }
    
    /**
     * Perform cache warmup
     */
    async performWarmup() {
        console.log('キャッシュウォームアップを実行中...');
        
        for (const key of this.config.warmupKeys) {
            try {
                // Simulate cache miss to trigger data loading
                await this.get(key);
            } catch (error) {
                console.error(`ウォームアップエラー (${key}):`, error);
            }
        }
        
        console.log('✓ キャッシュウォームアップ完了');
    }
    
    /**
     * Get cache statistics
     */
    getStatistics() {
        const tierStats = this.tiers.map(tier => ({
            name: tier.name,
            type: tier.type,
            size: tier.getSize(),
            count: tier.getCount(),
            maxSize: tier.maxSize
        }));
        
        return {
            global: {
                ...this.stats,
                hitRate: this.getHitRate(),
                totalSize: tierStats.reduce((sum, tier) => sum + tier.size, 0)
            },
            tiers: tierStats,
            accessPatterns: this.accessPatterns.size
        };
    }
    
    /**
     * Reset statistics
     */
    resetStatistics() {
        this.stats = {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0,
            evictions: 0,
            promotions: 0,
            demotions: 0,
            compressions: 0,
            decompressions: 0
        };
        
        this.hitRateWindow = [];
    }
    
    /**
     * Cleanup
     */
    async cleanup() {
        // Disconnect from external caches
        for (const tier of this.tiers) {
            if (tier.disconnect) {
                await tier.disconnect();
            }
        }
        
        this.tiers = [];
        this.accessPatterns.clear();
        this.hitRateWindow = [];
    }
}

/**
 * Memory Cache Tier
 */
class MemoryCacheTier extends EventEmitter {
    constructor(config) {
        super();
        
        this.name = config.name;
        this.type = 'memory';
        this.maxSize = config.maxSize;
        
        this.cache = new LRU({
            max: config.maxSize,
            maxSize: config.maxSize,
            sizeCalculation: (value) => {
                return Buffer.byteLength(JSON.stringify(value));
            },
            ttl: config.maxAge,
            updateAgeOnGet: config.updateAgeOnGet,
            dispose: (value, key) => {
                this.emit('eviction', key);
            }
        });
    }
    
    async get(key) {
        return this.cache.get(key);
    }
    
    async set(key, value, options = {}) {
        const ttl = options.ttl || undefined;
        this.cache.set(key, value, { ttl });
    }
    
    async delete(key) {
        this.cache.delete(key);
    }
    
    async clear() {
        this.cache.clear();
    }
    
    getSize() {
        return this.cache.calculatedSize || 0;
    }
    
    getCount() {
        return this.cache.size;
    }
    
    adjustSize(factor) {
        const newSize = Math.floor(this.maxSize * factor);
        this.cache.max = newSize;
        this.maxSize = newSize;
    }
}

/**
 * Redis Cache Tier (placeholder)
 */
class RedisCacheTier extends EventEmitter {
    constructor(config) {
        super();
        
        this.name = config.name;
        this.type = 'redis';
        this.maxSize = config.maxSize;
        this.connection = config.connection;
        this.client = null;
    }
    
    async connect() {
        // Would connect to Redis here
        console.log(`Redis接続をシミュレート中 (${this.name})`);
    }
    
    async get(key) {
        // Placeholder
        return null;
    }
    
    async set(key, value, options = {}) {
        // Placeholder
    }
    
    async delete(key) {
        // Placeholder
    }
    
    async clear() {
        // Placeholder
    }
    
    async disconnect() {
        // Placeholder
    }
    
    getSize() {
        return 0;
    }
    
    getCount() {
        return 0;
    }
}

/**
 * Disk Cache Tier (placeholder)
 */
class DiskCacheTier extends EventEmitter {
    constructor(config) {
        super();
        
        this.name = config.name;
        this.type = 'disk';
        this.maxSize = config.maxSize;
        this.directory = config.directory || './cache';
    }
    
    async get(key) {
        // Placeholder
        return null;
    }
    
    async set(key, value, options = {}) {
        // Placeholder
    }
    
    async delete(key) {
        // Placeholder
    }
    
    async clear() {
        // Placeholder
    }
    
    getSize() {
        return 0;
    }
    
    getCount() {
        return 0;
    }
}

module.exports = AdvancedCacheLayer;