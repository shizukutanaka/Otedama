/**
 * Cache System Tests
 * Comprehensive testing for advanced caching functionality
 */

import { MemoryCache, LoadingCache } from '../lib/memory-cache.js';

describe('MemoryCache', () => {
    let cache;
    
    beforeEach(() => {
        cache = new MemoryCache({
            maxSize: 1024 * 1024, // 1MB
            ttl: 1000
        });
    });
    
    afterEach(() => {
        cache.destroy();
    });
    
    describe('Basic Operations', () => {
        it('should set and get values', async () => {
            await cache.set('key1', 'value1');
            const value = await cache.get('key1');
            expect(value).toBe('value1');
        });
        
        it('should return null for non-existent keys', async () => {
            const value = await cache.get('nonexistent');
            expect(value).toBeNull();
        });
        
        it('should delete values', async () => {
            await cache.set('key1', 'value1');
            await cache.delete('key1');
            const value = await cache.get('key1');
            expect(value).toBeNull();
        });
        
        it('should clear all values', async () => {
            await cache.set('key1', 'value1');
            await cache.set('key2', 'value2');
            await cache.clear();
            
            const value1 = await cache.get('key1');
            const value2 = await cache.get('key2');
            
            expect(value1).toBeNull();
            expect(value2).toBeNull();
        });
    });
    
    describe('TTL and Expiration', () => {
        it('should expire values after TTL', async () => {
            await cache.set('key1', 'value1', { ttl: 100 });
            
            // Value should exist immediately
            let value = await cache.get('key1');
            expect(value).toBe('value1');
            
            // Wait for expiration
            await new Promise(resolve => setTimeout(resolve, 150));
            
            // Value should be expired
            value = await cache.get('key1');
            expect(value).toBeNull();
        });
        
        it('should cleanup expired values', async () => {
            await cache.set('key1', 'value1', { ttl: 50 });
            await cache.set('key2', 'value2', { ttl: 1000 });
            
            // Wait for cleanup
            await new Promise(resolve => setTimeout(resolve, 200));
            
            const stats = cache.getStats();
            expect(stats.size).toBe(1);
        });
    });
    
    describe('Eviction Policies', () => {
        it('should evict using LRU policy', async () => {
            const lruCache = new AdvancedCache({
                maxItems: 3,
                evictionPolicy: 'lru'
            });
            
            await lruCache.set('key1', 'value1');
            await lruCache.set('key2', 'value2');
            await lruCache.set('key3', 'value3');
            
            // Access key1 to make it recently used
            await lruCache.get('key1');
            
            // Add new item, should evict key2
            await lruCache.set('key4', 'value4');
            
            expect(await lruCache.get('key1')).toBe('value1');
            expect(await lruCache.get('key2')).toBeNull();
            expect(await lruCache.get('key3')).toBe('value3');
            expect(await lruCache.get('key4')).toBe('value4');
            
            lruCache.destroy();
        });
        
        it('should evict using LFU policy', async () => {
            const lfuCache = new AdvancedCache({
                maxItems: 3,
                evictionPolicy: 'lfu'
            });
            
            await lfuCache.set('key1', 'value1');
            await lfuCache.set('key2', 'value2');
            await lfuCache.set('key3', 'value3');
            
            // Access key1 and key3 multiple times
            await lfuCache.get('key1');
            await lfuCache.get('key1');
            await lfuCache.get('key3');
            
            // Add new item, should evict key2
            await lfuCache.set('key4', 'value4');
            
            expect(await lfuCache.get('key1')).toBe('value1');
            expect(await lfuCache.get('key2')).toBeNull();
            
            lfuCache.destroy();
        });
    });
    
    describe('Multi-tier Caching', () => {
        it('should handle tier promotion', async () => {
            await cache.set('key1', 'value1', { tier: 'compressed' });
            
            // Get with promotion
            const value = await cache.get('key1', { promote: true });
            expect(value).toBe('value1');
            
            // Check if promoted to memory tier
            const metadata = cache.metadata.get(cache.hashKey('key1'));
            expect(metadata.tier).toBe('memory');
        });
    });
    
    describe('Compression', () => {
        it('should compress large values', async () => {
            const largeValue = 'x'.repeat(2000);
            await cache.set('key1', largeValue);
            
            const metadata = cache.metadata.get(cache.hashKey('key1'));
            expect(metadata.compressed).toBe(true);
            
            const value = await cache.get('key1');
            expect(value).toBe(largeValue);
        });
    });
    
    describe('Statistics', () => {
        it('should track cache hits and misses', async () => {
            await cache.set('key1', 'value1');
            
            await cache.get('key1'); // hit
            await cache.get('key2'); // miss
            
            const stats = cache.getStats();
            expect(stats.hits).toBe(1);
            expect(stats.misses).toBe(1);
            expect(stats.hitRate).toBe('50.00%');
        });
        
        it('should track operation times', async () => {
            await cache.set('key1', 'value1');
            await cache.get('key1');
            
            const stats = cache.getStats();
            expect(parseFloat(stats.averageGetTime)).toBeGreaterThan(0);
            expect(parseFloat(stats.averageSetTime)).toBeGreaterThan(0);
        });
    });
    
    describe('Batch Operations', () => {
        it('should handle batch get operations', async () => {
            await cache.set('key1', 'value1');
            await cache.set('key2', 'value2');
            await cache.set('key3', 'value3');
            
            const values = await cache.mget(['key1', 'key2', 'key3', 'key4']);
            
            expect(values[0]).toBe('value1');
            expect(values[1]).toBe('value2');
            expect(values[2]).toBe('value3');
            expect(values[3]).toBeNull();
        });
        
        it('should handle batch set operations', async () => {
            const entries = [
                ['key1', 'value1'],
                ['key2', 'value2'],
                ['key3', 'value3']
            ];
            
            await cache.mset(entries);
            
            expect(await cache.get('key1')).toBe('value1');
            expect(await cache.get('key2')).toBe('value2');
            expect(await cache.get('key3')).toBe('value3');
        });
    });
});

describe('CacheFactory', () => {
    it('should create pool cache with correct configuration', () => {
        const poolCache = CacheFactory.createPoolCache();
        expect(poolCache.config.maxMemorySize).toBe(1024 * 1024 * 256);
        expect(poolCache.config.ttl).toBe(300000);
        expect(poolCache.config.evictionPolicy).toBe('lru');
        poolCache.destroy();
    });
    
    it('should create DEX cache with correct configuration', () => {
        const dexCache = CacheFactory.createDexCache();
        expect(dexCache.config.maxMemorySize).toBe(1024 * 1024 * 128);
        expect(dexCache.config.ttl).toBe(60000);
        expect(dexCache.config.evictionPolicy).toBe('lfu');
        dexCache.destroy();
    });
});

describe('CacheMiddleware', () => {
    let middleware;
    let req, res, next;
    
    beforeEach(() => {
        middleware = new CacheMiddleware({
            ttl: 1000
        });
        
        req = {
            method: 'GET',
            path: '/api/test',
            headers: {},
            query: {}
        };
        
        res = {
            statusCode: 200,
            headers: {},
            setHeader: function(name, value) {
                this.headers[name] = value;
            },
            get: function(name) {
                return this.headers[name];
            },
            status: function(code) {
                this.statusCode = code;
                return this;
            },
            send: function(body) {
                this.body = body;
                return this;
            },
            json: function(obj) {
                this.setHeader('Content-Type', 'application/json');
                return this.send(JSON.stringify(obj));
            }
        };
        
        next = () => {};
    });
    
    afterEach(() => {
        middleware.destroy();
    });
    
    it('should cache successful responses', async () => {
        const handler = middleware.middleware();
        
        // First request - cache miss
        await new Promise(resolve => {
            next = () => {
                res.send('test response');
                resolve();
            };
            handler(req, res, next);
        });
        
        expect(res.headers['X-Cache']).toBe('MISS');
        
        // Second request - cache hit
        const newRes = { ...res, headers: {}, setHeader: res.setHeader, get: res.get };
        await handler(req, newRes, next);
        
        expect(newRes.headers['X-Cache']).toBe('HIT');
        expect(newRes.body).toBe('test response');
    });
    
    it('should not cache non-GET requests', async () => {
        req.method = 'POST';
        const handler = middleware.middleware();
        
        await new Promise(resolve => {
            next = resolve;
            handler(req, res, next);
        });
        
        expect(res.headers['X-Cache']).toBeUndefined();
    });
    
    it('should respect cache-control headers', async () => {
        req.headers['cache-control'] = 'no-cache';
        const handler = middleware.middleware();
        
        await new Promise(resolve => {
            next = resolve;
            handler(req, res, next);
        });
        
        expect(res.headers['X-Cache']).toBeUndefined();
    });
    
    it('should handle cache invalidation', async () => {
        await middleware.cache.set('test-key', { body: 'cached' });
        
        const invalidated = await middleware.invalidate('test-*');
        expect(invalidated).toHaveLength(1);
        
        const value = await middleware.cache.get('test-key');
        expect(value).toBeNull();
    });
});