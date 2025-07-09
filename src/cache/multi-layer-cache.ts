/**
 * Comprehensive Cache System
 * Following Carmack/Martin/Pike principles:
 * - Multi-layer caching with clear hierarchies
 * - Simple and predictable behavior
 * - Performance-focused implementation
 */

import Redis from 'ioredis';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';

interface CacheOptions {
  redis?: Redis;
  memoryMaxSize?: number; // Max memory cache size in bytes
  memoryMaxItems?: number; // Max number of items in memory
  defaultTTL?: number; // Default TTL in seconds
  namespace?: string; // Cache key namespace
  compression?: boolean; // Enable compression for large values
  stats?: boolean; // Enable statistics collection
}

interface CacheEntry<T> {
  value: T;
  expires: number;
  size: number;
  compressed?: boolean;
  hits?: number;
  lastAccess?: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  evictions: number;
  memorySize: number;
  itemCount: number;
  hitRate: number;
}

export class MultiLayerCache extends EventEmitter {
  private options: Required<CacheOptions>;
  private memoryCache: Map<string, CacheEntry<any>> = new Map();
  private memorySizeBytes = 0;
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    evictions: 0,
    memorySize: 0,
    itemCount: 0,
    hitRate: 0
  };
  private cleanupInterval?: NodeJS.Timer;

  constructor(options: CacheOptions = {}) {
    super();
    
    this.options = {
      redis: options.redis || new Redis(),
      memoryMaxSize: 100 * 1024 * 1024, // 100MB default
      memoryMaxItems: 10000,
      defaultTTL: 3600, // 1 hour default
      namespace: 'cache',
      compression: true,
      stats: true,
      ...options
    };
    
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Every minute
  }

  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    const fullKey = this.makeKey(key);
    
    // Check memory cache first
    const memoryResult = this.getFromMemory<T>(fullKey);
    if (memoryResult !== null) {
      if (this.options.stats) this.stats.hits++;
      this.updateHitRate();
      return memoryResult;
    }
    
    // Check Redis
    const redisResult = await this.getFromRedis<T>(fullKey);
    if (redisResult !== null) {
      // Promote to memory cache
      await this.setInMemory(fullKey, redisResult, this.options.defaultTTL);
      if (this.options.stats) this.stats.hits++;
      this.updateHitRate();
      return redisResult;
    }
    
    if (this.options.stats) this.stats.misses++;
    this.updateHitRate();
    return null;
  }

  /**
   * Set value in cache
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const fullKey = this.makeKey(key);
    const ttlSeconds = ttl || this.options.defaultTTL;
    
    // Set in both layers
    await Promise.all([
      this.setInMemory(fullKey, value, ttlSeconds),
      this.setInRedis(fullKey, value, ttlSeconds)
    ]);
    
    if (this.options.stats) this.stats.sets++;
    this.emit('set', key, value);
  }

  /**
   * Delete from cache
   */
  async del(key: string): Promise<void> {
    const fullKey = this.makeKey(key);
    
    // Delete from both layers
    this.deleteFromMemory(fullKey);
    await this.options.redis.del(fullKey);
    
    if (this.options.stats) this.stats.deletes++;
    this.emit('delete', key);
  }

  /**
   * Clear entire cache
   */
  async clear(): Promise<void> {
    // Clear memory
    this.memoryCache.clear();
    this.memorySizeBytes = 0;
    
    // Clear Redis (namespace only)
    const keys = await this.options.redis.keys(`${this.options.namespace}:*`);
    if (keys.length > 0) {
      await this.options.redis.del(...keys);
    }
    
    this.emit('clear');
  }

  /**
   * Get multiple values
   */
  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    const results: (T | null)[] = [];
    const missingKeys: { key: string; index: number }[] = [];
    
    // Check memory cache first
    for (let i = 0; i < keys.length; i++) {
      const fullKey = this.makeKey(keys[i]);
      const memoryResult = this.getFromMemory<T>(fullKey);
      
      if (memoryResult !== null) {
        results[i] = memoryResult;
        if (this.options.stats) this.stats.hits++;
      } else {
        missingKeys.push({ key: fullKey, index: i });
        results[i] = null;
      }
    }
    
    // Fetch missing from Redis
    if (missingKeys.length > 0) {
      const redisKeys = missingKeys.map(m => m.key);
      const redisResults = await this.options.redis.mget(...redisKeys);
      
      for (let i = 0; i < missingKeys.length; i++) {
        const redisValue = redisResults[i];
        if (redisValue) {
          try {
            const parsed = JSON.parse(redisValue);
            results[missingKeys[i].index] = parsed;
            // Promote to memory
            await this.setInMemory(missingKeys[i].key, parsed, this.options.defaultTTL);
            if (this.options.stats) this.stats.hits++;
          } catch {
            if (this.options.stats) this.stats.misses++;
          }
        } else {
          if (this.options.stats) this.stats.misses++;
        }
      }
    }
    
    this.updateHitRate();
    return results;
  }

  /**
   * Set multiple values
   */
  async mset(items: Array<{ key: string; value: any; ttl?: number }>): Promise<void> {
    const promises: Promise<void>[] = [];
    
    for (const item of items) {
      promises.push(this.set(item.key, item.value, item.ttl));
    }
    
    await Promise.all(promises);
  }

  /**
   * Cache function result
   */
  async cached<T>(
    key: string,
    fn: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    // Try to get from cache
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }
    
    // Execute function
    const result = await fn();
    
    // Cache result
    await this.set(key, result, ttl);
    
    return result;
  }

  /**
   * Invalidate by pattern
   */
  async invalidatePattern(pattern: string): Promise<number> {
    let count = 0;
    
    // Clear from memory
    for (const key of this.memoryCache.keys()) {
      if (this.matchPattern(key, pattern)) {
        this.deleteFromMemory(key);
        count++;
      }
    }
    
    // Clear from Redis
    const redisPattern = this.makeKey(pattern);
    const keys = await this.options.redis.keys(redisPattern);
    if (keys.length > 0) {
      await this.options.redis.del(...keys);
      count += keys.length;
    }
    
    return count;
  }

  /**
   * Get from memory cache
   */
  private getFromMemory<T>(key: string): T | null {
    const entry = this.memoryCache.get(key);
    
    if (!entry) {
      return null;
    }
    
    // Check expiration
    if (entry.expires < Date.now()) {
      this.deleteFromMemory(key);
      return null;
    }
    
    // Update stats
    if (entry.hits !== undefined) entry.hits++;
    entry.lastAccess = Date.now();
    
    return entry.value;
  }

  /**
   * Set in memory cache
   */
  private async setInMemory<T>(key: string, value: T, ttl: number): Promise<void> {
    const size = this.estimateSize(value);
    
    // Check if we need to evict
    while (
      (this.memorySizeBytes + size > this.options.memoryMaxSize ||
       this.memoryCache.size >= this.options.memoryMaxItems) &&
      this.memoryCache.size > 0
    ) {
      this.evictLRU();
    }
    
    // Compress if needed
    let storedValue = value;
    let compressed = false;
    
    if (this.options.compression && size > 1024) { // Compress if > 1KB
      try {
        storedValue = await this.compress(value);
        compressed = true;
      } catch {
        // Use uncompressed on error
      }
    }
    
    const entry: CacheEntry<T> = {
      value: storedValue,
      expires: Date.now() + (ttl * 1000),
      size,
      compressed,
      hits: 0,
      lastAccess: Date.now()
    };
    
    this.memoryCache.set(key, entry);
    this.memorySizeBytes += size;
    
    if (this.options.stats) {
      this.stats.memorySize = this.memorySizeBytes;
      this.stats.itemCount = this.memoryCache.size;
    }
  }

  /**
   * Delete from memory cache
   */
  private deleteFromMemory(key: string): void {
    const entry = this.memoryCache.get(key);
    if (entry) {
      this.memorySizeBytes -= entry.size;
      this.memoryCache.delete(key);
      
      if (this.options.stats) {
        this.stats.memorySize = this.memorySizeBytes;
        this.stats.itemCount = this.memoryCache.size;
      }
    }
  }

  /**
   * Get from Redis
   */
  private async getFromRedis<T>(key: string): Promise<T | null> {
    try {
      const value = await this.options.redis.get(key);
      if (!value) return null;
      
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  /**
   * Set in Redis
   */
  private async setInRedis<T>(key: string, value: T, ttl: number): Promise<void> {
    const serialized = JSON.stringify(value);
    await this.options.redis.setex(key, ttl, serialized);
  }

  /**
   * Evict least recently used item
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;
    
    for (const [key, entry] of this.memoryCache.entries()) {
      const lastAccess = entry.lastAccess || 0;
      if (lastAccess < oldestAccess) {
        oldestAccess = lastAccess;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.deleteFromMemory(oldestKey);
      if (this.options.stats) this.stats.evictions++;
      this.emit('evict', oldestKey);
    }
  }

  /**
   * Clean up expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.expires < now) {
        keysToDelete.push(key);
      }
    }
    
    for (const key of keysToDelete) {
      this.deleteFromMemory(key);
    }
  }

  /**
   * Estimate size of value
   */
  private estimateSize(value: any): number {
    if (typeof value === 'string') {
      return value.length * 2; // Rough estimate for UTF-16
    }
    
    try {
      return JSON.stringify(value).length * 2;
    } catch {
      return 1024; // Default size
    }
  }

  /**
   * Compress value
   */
  private async compress(value: any): Promise<any> {
    const zlib = require('zlib');
    const input = JSON.stringify(value);
    const compressed = await promisify(zlib.gzip)(input);
    return compressed.toString('base64');
  }

  /**
   * Decompress value
   */
  private async decompress(value: string): Promise<any> {
    const zlib = require('zlib');
    const buffer = Buffer.from(value, 'base64');
    const decompressed = await promisify(zlib.gunzip)(buffer);
    return JSON.parse(decompressed.toString());
  }

  /**
   * Match pattern
   */
  private matchPattern(key: string, pattern: string): boolean {
    const regex = pattern
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    
    return new RegExp(`^${regex}$`).test(key);
  }

  /**
   * Make full cache key
   */
  private makeKey(key: string): string {
    return `${this.options.namespace}:${key}`;
  }

  /**
   * Update hit rate
   */
  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Destroy cache
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.memoryCache.clear();
    this.memorySizeBytes = 0;
  }
}

/**
 * Specialized caches for different use cases
 */

// Share cache with automatic aggregation
export class ShareCache extends MultiLayerCache {
  constructor(redis: Redis) {
    super({
      redis,
      namespace: 'shares',
      defaultTTL: 300, // 5 minutes
      memoryMaxSize: 50 * 1024 * 1024 // 50MB
    });
  }

  async addShare(minerId: string, share: any): Promise<void> {
    const key = `miner:${minerId}:shares`;
    const shares = await this.get<any[]>(key) || [];
    shares.push(share);
    
    // Keep last 1000 shares
    if (shares.length > 1000) {
      shares.shift();
    }
    
    await this.set(key, shares, 600); // 10 minutes
  }

  async getRecentShares(minerId: string, count: number = 100): Promise<any[]> {
    const shares = await this.get<any[]>(`miner:${minerId}:shares`) || [];
    return shares.slice(-count);
  }
}

// Miner stats cache with automatic calculation
export class MinerStatsCache extends MultiLayerCache {
  constructor(redis: Redis) {
    super({
      redis,
      namespace: 'miner_stats',
      defaultTTL: 60, // 1 minute
      memoryMaxSize: 100 * 1024 * 1024 // 100MB
    });
  }

  async getHashrate(minerId: string): Promise<number> {
    return await this.cached(`${minerId}:hashrate`, async () => {
      // Calculate hashrate from shares
      const shares = await this.get<any[]>(`${minerId}:recent_shares`) || [];
      return this.calculateHashrate(shares);
    }, 30);
  }

  private calculateHashrate(shares: any[]): number {
    if (shares.length === 0) return 0;
    
    const timeWindow = 600; // 10 minutes
    const now = Date.now() / 1000;
    const recentShares = shares.filter(s => (now - s.timestamp) < timeWindow);
    
    if (recentShares.length === 0) return 0;
    
    const totalDifficulty = recentShares.reduce((sum, s) => sum + s.difficulty, 0);
    return (totalDifficulty * Math.pow(2, 32)) / timeWindow;
  }
}

// Block template cache
export class BlockTemplateCache extends MultiLayerCache {
  constructor(redis: Redis) {
    super({
      redis,
      namespace: 'block_templates',
      defaultTTL: 30, // 30 seconds
      memoryMaxSize: 10 * 1024 * 1024 // 10MB
    });
  }

  async getTemplate(): Promise<any> {
    return await this.cached('current_template', async () => {
      // Fetch from blockchain
      return this.fetchBlockTemplate();
    }, 30);
  }

  private async fetchBlockTemplate(): Promise<any> {
    // Implementation would fetch from blockchain
    throw new Error('Not implemented');
  }
}

// API response cache
export class APICache extends MultiLayerCache {
  constructor(redis: Redis) {
    super({
      redis,
      namespace: 'api',
      defaultTTL: 60,
      memoryMaxSize: 50 * 1024 * 1024
    });
  }

  middleware() {
    return async (req: any, res: any, next: any) => {
      // Skip non-GET requests
      if (req.method !== 'GET') {
        return next();
      }
      
      // Generate cache key
      const key = `${req.path}:${JSON.stringify(req.query)}`;
      
      // Try to get from cache
      const cached = await this.get(key);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }
      
      // Capture response
      const originalJson = res.json;
      res.json = (data: any) => {
        res.setHeader('X-Cache', 'MISS');
        
        // Cache successful responses
        if (res.statusCode === 200) {
          this.set(key, data, 60).catch(() => {
            // Ignore cache errors
          });
        }
        
        return originalJson.call(res, data);
      };
      
      next();
    };
  }
}

// Export utilities
export const promisify = (fn: Function) => {
  return (...args: any[]) => {
    return new Promise((resolve, reject) => {
      fn(...args, (err: any, result: any) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  };
};
