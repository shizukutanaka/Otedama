/**
 * Multi-tier Caching System for Otedama
 * Implements L1 (memory), L2 (Redis), and L3 (disk) caching
 * 
 * Design principles:
 * - Carmack: Fastest possible cache hits, minimal latency
 * - Martin: Clean cache hierarchy
 * - Pike: Simple and predictable caching behavior
 */

import { EventEmitter } from 'events';
import { LRUCache } from 'lru-cache';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getLogger } from '../core/logger.js';

const logger = getLogger('MultiTierCache');

// Cache entry states
export const CacheState = {
  FRESH: 'fresh',
  STALE: 'stale',
  EXPIRED: 'expired',
  UPDATING: 'updating'
};

// Cache strategies
export const CacheStrategy = {
  CACHE_ASIDE: 'cache_aside',      // Load on miss
  WRITE_THROUGH: 'write_through',  // Write to cache and backend
  WRITE_BEHIND: 'write_behind',    // Write to cache, async to backend
  REFRESH_AHEAD: 'refresh_ahead'   // Proactive refresh before expiry
};

/**
 * Cache entry wrapper
 */
class CacheEntry {
  constructor(key, value, options = {}) {
    this.key = key;
    this.value = value;
    this.createdAt = Date.now();
    this.lastAccessed = Date.now();
    this.accessCount = 0;
    
    this.ttl = options.ttl || 3600000; // 1 hour default
    this.staleTtl = options.staleTtl || this.ttl * 2;
    this.tags = new Set(options.tags || []);
    this.metadata = options.metadata || {};
  }
  
  isExpired() {
    return Date.now() - this.createdAt > this.ttl;
  }
  
  isStale() {
    return this.isExpired() && 
           Date.now() - this.createdAt <= this.staleTtl;
  }
  
  access() {
    this.lastAccessed = Date.now();
    this.accessCount++;
  }
  
  getState() {
    if (Date.now() - this.createdAt > this.staleTtl) {
      return CacheState.EXPIRED;
    } else if (this.isExpired()) {
      return CacheState.STALE;
    }
    return CacheState.FRESH;
  }
  
  serialize() {
    return {
      key: this.key,
      value: this.value,
      createdAt: this.createdAt,
      lastAccessed: this.lastAccessed,
      accessCount: this.accessCount,
      ttl: this.ttl,
      staleTtl: this.staleTtl,
      tags: Array.from(this.tags),
      metadata: this.metadata
    };
  }
  
  static deserialize(data) {
    const entry = new CacheEntry(data.key, data.value, {
      ttl: data.ttl,
      staleTtl: data.staleTtl,
      tags: data.tags,
      metadata: data.metadata
    });
    
    entry.createdAt = data.createdAt;
    entry.lastAccessed = data.lastAccessed;
    entry.accessCount = data.accessCount;
    
    return entry;
  }
}

/**
 * Multi-tier cache implementation
 */
export class MultiTierCache extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // L1 Memory cache
      l1: {
        enabled: options.l1?.enabled !== false,
        maxSize: options.l1?.maxSize || 1000,
        maxMemory: options.l1?.maxMemory || 100 * 1024 * 1024, // 100MB
        ttl: options.l1?.ttl || 300000, // 5 minutes
        ...options.l1
      },
      
      // L2 Redis cache
      l2: {
        enabled: options.l2?.enabled || false,
        client: options.l2?.client,
        prefix: options.l2?.prefix || 'otedama:cache:',
        ttl: options.l2?.ttl || 3600000, // 1 hour
        ...options.l2
      },
      
      // L3 Disk cache
      l3: {
        enabled: options.l3?.enabled || false,
        directory: options.l3?.directory || './cache',
        maxSize: options.l3?.maxSize || 1024 * 1024 * 1024, // 1GB
        ttl: options.l3?.ttl || 86400000, // 24 hours
        ...options.l3
      },
      
      // General options
      strategy: options.strategy || CacheStrategy.CACHE_ASIDE,
      compression: options.compression || false,
      encryption: options.encryption || false,
      keyHasher: options.keyHasher || this._defaultKeyHasher,
      
      ...options
    };
    
    // Initialize tiers
    this._initializeL1();
    this._initializeL2();
    this._initializeL3();
    
    // Pending operations
    this.pendingGets = new Map();
    this.pendingWrites = new Map();
    
    // Background tasks
    this.refreshQueue = [];
    this.writeQueue = [];
    
    // Metrics
    this.metrics = {
      hits: { l1: 0, l2: 0, l3: 0 },
      misses: 0,
      writes: { l1: 0, l2: 0, l3: 0 },
      evictions: { l1: 0, l2: 0, l3: 0 },
      errors: { l1: 0, l2: 0, l3: 0 }
    };
    
    // Start background workers
    this._startBackgroundWorkers();
  }
  
  /**
   * Initialize L1 memory cache
   */
  _initializeL1() {
    if (!this.options.l1.enabled) return;
    
    this.l1Cache = new LRUCache({
      max: this.options.l1.maxSize,
      maxSize: this.options.l1.maxMemory,
      sizeCalculation: (entry) => {
        const size = JSON.stringify(entry.serialize()).length;
        return size;
      },
      dispose: (entry, key, reason) => {
        if (reason === 'evict') {
          this.metrics.evictions.l1++;
          this._promoteToLowerTier(entry);
        }
      },
      ttl: this.options.l1.ttl,
      updateAgeOnGet: true,
      updateAgeOnHas: false
    });
  }
  
  /**
   * Initialize L2 Redis cache
   */
  _initializeL2() {
    if (!this.options.l2.enabled || !this.options.l2.client) return;
    
    this.l2Client = this.options.l2.client;
  }
  
  /**
   * Initialize L3 disk cache
   */
  async _initializeL3() {
    if (!this.options.l3.enabled) return;
    
    // Create cache directory
    await fs.mkdir(this.options.l3.directory, { recursive: true });
    
    // Load cache index
    this.l3Index = new Map();
    await this._loadL3Index();
  }
  
  /**
   * Get value from cache
   */
  async get(key, options = {}) {
    const hashedKey = this.options.keyHasher(key);
    
    // Check if already fetching
    if (this.pendingGets.has(hashedKey)) {
      return this.pendingGets.get(hashedKey);
    }
    
    // Create promise for concurrent requests
    const getPromise = this._get(hashedKey, key, options);
    this.pendingGets.set(hashedKey, getPromise);
    
    try {
      const result = await getPromise;
      return result;
    } finally {
      this.pendingGets.delete(hashedKey);
    }
  }
  
  async _get(hashedKey, originalKey, options) {
    // Check L1
    if (this.l1Cache) {
      const l1Entry = this.l1Cache.get(hashedKey);
      if (l1Entry) {
        l1Entry.access();
        this.metrics.hits.l1++;
        
        const state = l1Entry.getState();
        
        if (state === CacheState.FRESH) {
          this.emit('hit', { tier: 'l1', key: originalKey });
          return l1Entry.value;
        } else if (state === CacheState.STALE && options.allowStale !== false) {
          // Return stale value and refresh in background
          this._scheduleRefresh(originalKey, l1Entry);
          return l1Entry.value;
        }
      }
    }
    
    // Check L2
    if (this.l2Client) {
      try {
        const l2Data = await this.l2Client.get(this.options.l2.prefix + hashedKey);
        if (l2Data) {
          const l2Entry = CacheEntry.deserialize(JSON.parse(l2Data));
          l2Entry.access();
          this.metrics.hits.l2++;
          
          // Promote to L1
          if (this.l1Cache) {
            this.l1Cache.set(hashedKey, l2Entry);
          }
          
          const state = l2Entry.getState();
          if (state === CacheState.FRESH || 
              (state === CacheState.STALE && options.allowStale !== false)) {
            this.emit('hit', { tier: 'l2', key: originalKey });
            return l2Entry.value;
          }
        }
      } catch (error) {
        this.metrics.errors.l2++;
        logger.error('L2 cache error', error);
      }
    }
    
    // Check L3
    if (this.l3Index) {
      try {
        const l3Path = this.l3Index.get(hashedKey);
        if (l3Path) {
          const l3Data = await fs.readFile(l3Path, 'utf8');
          const l3Entry = CacheEntry.deserialize(JSON.parse(l3Data));
          l3Entry.access();
          this.metrics.hits.l3++;
          
          // Promote to higher tiers
          await this._promoteTo(l3Entry, 2);
          
          const state = l3Entry.getState();
          if (state === CacheState.FRESH || 
              (state === CacheState.STALE && options.allowStale !== false)) {
            this.emit('hit', { tier: 'l3', key: originalKey });
            return l3Entry.value;
          }
        }
      } catch (error) {
        this.metrics.errors.l3++;
        logger.error('L3 cache error', error);
      }
    }
    
    // Cache miss
    this.metrics.misses++;
    this.emit('miss', { key: originalKey });
    
    // Load data if loader provided
    if (options.loader) {
      const value = await options.loader(originalKey);
      
      if (value !== undefined) {
        await this.set(originalKey, value, options);
      }
      
      return value;
    }
    
    return null;
  }
  
  /**
   * Set value in cache
   */
  async set(key, value, options = {}) {
    const hashedKey = this.options.keyHasher(key);
    
    const entry = new CacheEntry(key, value, {
      ttl: options.ttl || this.options.l1.ttl,
      staleTtl: options.staleTtl,
      tags: options.tags,
      metadata: options.metadata
    });
    
    // Apply caching strategy
    switch (this.options.strategy) {
      case CacheStrategy.WRITE_THROUGH:
        await this._writeThrough(hashedKey, entry);
        break;
        
      case CacheStrategy.WRITE_BEHIND:
        await this._writeBehind(hashedKey, entry);
        break;
        
      default:
        await this._writeCacheAside(hashedKey, entry);
    }
    
    this.emit('set', { key, ttl: entry.ttl });
  }
  
  async _writeCacheAside(hashedKey, entry) {
    // Write to L1 immediately
    if (this.l1Cache) {
      this.l1Cache.set(hashedKey, entry);
      this.metrics.writes.l1++;
    }
    
    // Async write to lower tiers
    this._scheduleWrite(hashedKey, entry);
  }
  
  async _writeThrough(hashedKey, entry) {
    const writes = [];
    
    // Write to all tiers simultaneously
    if (this.l1Cache) {
      this.l1Cache.set(hashedKey, entry);
      this.metrics.writes.l1++;
    }
    
    if (this.l2Client) {
      writes.push(this._writeToL2(hashedKey, entry));
    }
    
    if (this.l3Index) {
      writes.push(this._writeToL3(hashedKey, entry));
    }
    
    await Promise.all(writes);
  }
  
  async _writeBehind(hashedKey, entry) {
    // Write to L1 immediately
    if (this.l1Cache) {
      this.l1Cache.set(hashedKey, entry);
      this.metrics.writes.l1++;
    }
    
    // Queue writes to lower tiers
    this.writeQueue.push({ hashedKey, entry, timestamp: Date.now() });
  }
  
  /**
   * Delete from cache
   */
  async delete(key, options = {}) {
    const hashedKey = this.options.keyHasher(key);
    
    const deletes = [];
    
    // Delete from all tiers
    if (this.l1Cache) {
      this.l1Cache.delete(hashedKey);
    }
    
    if (this.l2Client) {
      deletes.push(
        this.l2Client.del(this.options.l2.prefix + hashedKey)
          .catch(error => {
            this.metrics.errors.l2++;
            logger.error('L2 delete error', error);
          })
      );
    }
    
    if (this.l3Index) {
      const path = this.l3Index.get(hashedKey);
      if (path) {
        this.l3Index.delete(hashedKey);
        deletes.push(
          fs.unlink(path).catch(error => {
            this.metrics.errors.l3++;
            logger.error('L3 delete error', error);
          })
        );
      }
    }
    
    await Promise.all(deletes);
    
    this.emit('delete', { key });
  }
  
  /**
   * Delete by tags
   */
  async deleteByTags(tags) {
    const toDelete = [];
    
    // Find entries with matching tags
    if (this.l1Cache) {
      for (const [key, entry] of this.l1Cache.entries()) {
        if (tags.some(tag => entry.tags.has(tag))) {
          toDelete.push(entry.key);
        }
      }
    }
    
    // Delete all matching entries
    await Promise.all(toDelete.map(key => this.delete(key)));
    
    return toDelete.length;
  }
  
  /**
   * Clear entire cache
   */
  async clear() {
    if (this.l1Cache) {
      this.l1Cache.clear();
    }
    
    if (this.l2Client) {
      // Clear by pattern
      const pattern = `${this.options.l2.prefix}*`;
      const keys = await this.l2Client.keys(pattern);
      if (keys.length > 0) {
        await this.l2Client.del(...keys);
      }
    }
    
    if (this.l3Index) {
      // Delete all files
      for (const [key, path] of this.l3Index) {
        await fs.unlink(path).catch(() => {});
      }
      this.l3Index.clear();
    }
    
    this.emit('clear');
  }
  
  /**
   * Write to L2 cache
   */
  async _writeToL2(hashedKey, entry) {
    try {
      const data = JSON.stringify(entry.serialize());
      const ttlSeconds = Math.ceil(entry.staleTtl / 1000);
      
      await this.l2Client.setex(
        this.options.l2.prefix + hashedKey,
        ttlSeconds,
        data
      );
      
      this.metrics.writes.l2++;
    } catch (error) {
      this.metrics.errors.l2++;
      throw error;
    }
  }
  
  /**
   * Write to L3 cache
   */
  async _writeToL3(hashedKey, entry) {
    try {
      const filename = `${hashedKey}.cache`;
      const filepath = join(this.options.l3.directory, filename);
      const data = JSON.stringify(entry.serialize());
      
      await fs.writeFile(filepath, data);
      this.l3Index.set(hashedKey, filepath);
      
      this.metrics.writes.l3++;
      
      // Check disk usage
      await this._checkL3Size();
    } catch (error) {
      this.metrics.errors.l3++;
      throw error;
    }
  }
  
  /**
   * Promote entry to higher tiers
   */
  async _promoteTo(entry, maxTier) {
    const hashedKey = this.options.keyHasher(entry.key);
    
    if (maxTier >= 1 && this.l1Cache) {
      this.l1Cache.set(hashedKey, entry);
    }
    
    if (maxTier >= 2 && this.l2Client) {
      await this._writeToL2(hashedKey, entry).catch(() => {});
    }
  }
  
  /**
   * Promote to lower tier when evicted
   */
  async _promoteToLowerTier(entry) {
    const hashedKey = this.options.keyHasher(entry.key);
    
    // Try L2 first
    if (this.l2Client) {
      await this._writeToL2(hashedKey, entry).catch(() => {});
    } else if (this.l3Index) {
      // Fallback to L3
      await this._writeToL3(hashedKey, entry).catch(() => {});
    }
  }
  
  /**
   * Schedule background refresh
   */
  _scheduleRefresh(key, entry) {
    if (this.options.strategy === CacheStrategy.REFRESH_AHEAD) {
      this.refreshQueue.push({
        key,
        entry,
        scheduledAt: Date.now()
      });
    }
  }
  
  /**
   * Schedule background write
   */
  _scheduleWrite(hashedKey, entry) {
    this.writeQueue.push({
      hashedKey,
      entry,
      timestamp: Date.now()
    });
  }
  
  /**
   * Background workers
   */
  _startBackgroundWorkers() {
    // Write queue processor
    setInterval(() => {
      this._processWriteQueue();
    }, 1000);
    
    // Refresh queue processor
    if (this.options.strategy === CacheStrategy.REFRESH_AHEAD) {
      setInterval(() => {
        this._processRefreshQueue();
      }, 5000);
    }
    
    // L3 cleanup
    if (this.l3Index) {
      setInterval(() => {
        this._cleanupL3();
      }, 3600000); // 1 hour
    }
  }
  
  async _processWriteQueue() {
    const batch = this.writeQueue.splice(0, 10);
    
    for (const { hashedKey, entry } of batch) {
      // Write to L2
      if (this.l2Client) {
        await this._writeToL2(hashedKey, entry).catch(() => {});
      }
      
      // Write to L3 if large or important
      if (this.l3Index && 
          (entry.accessCount > 10 || JSON.stringify(entry.value).length > 10000)) {
        await this._writeToL3(hashedKey, entry).catch(() => {});
      }
    }
  }
  
  async _processRefreshQueue() {
    const now = Date.now();
    const toRefresh = [];
    
    // Find entries that need refresh
    this.refreshQueue = this.refreshQueue.filter(item => {
      if (now - item.scheduledAt > 60000) { // 1 minute timeout
        return false;
      }
      
      const timeUntilExpiry = (item.entry.createdAt + item.entry.ttl) - now;
      if (timeUntilExpiry < item.entry.ttl * 0.2) { // 20% of TTL remaining
        toRefresh.push(item);
        return false;
      }
      
      return true;
    });
    
    // Refresh entries
    for (const item of toRefresh) {
      this.emit('refresh', { key: item.key });
    }
  }
  
  /**
   * L3 maintenance
   */
  async _checkL3Size() {
    // Simple size check - in production use proper disk quota management
    const files = await fs.readdir(this.options.l3.directory);
    if (files.length > 10000) { // Arbitrary limit
      await this._cleanupL3();
    }
  }
  
  async _cleanupL3() {
    const files = await fs.readdir(this.options.l3.directory);
    const stats = [];
    
    for (const file of files) {
      const path = join(this.options.l3.directory, file);
      try {
        const stat = await fs.stat(path);
        stats.push({ file, path, mtime: stat.mtime, size: stat.size });
      } catch (error) {
        // File might have been deleted
      }
    }
    
    // Sort by last modified time
    stats.sort((a, b) => a.mtime - b.mtime);
    
    // Delete oldest files
    const toDelete = stats.slice(0, Math.floor(stats.length * 0.2)); // Delete 20%
    
    for (const { file, path } of toDelete) {
      const hashedKey = file.replace('.cache', '');
      this.l3Index.delete(hashedKey);
      await fs.unlink(path).catch(() => {});
      this.metrics.evictions.l3++;
    }
  }
  
  async _loadL3Index() {
    try {
      const files = await fs.readdir(this.options.l3.directory);
      
      for (const file of files) {
        if (file.endsWith('.cache')) {
          const hashedKey = file.replace('.cache', '');
          const path = join(this.options.l3.directory, file);
          this.l3Index.set(hashedKey, path);
        }
      }
    } catch (error) {
      logger.error('Failed to load L3 index', error);
    }
  }
  
  /**
   * Default key hasher
   */
  _defaultKeyHasher(key) {
    if (typeof key === 'string') {
      return key;
    }
    return createHash('sha256').update(JSON.stringify(key)).digest('hex');
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    const stats = {
      metrics: this.metrics,
      hitRate: this._calculateHitRate(),
      tiers: {}
    };
    
    if (this.l1Cache) {
      stats.tiers.l1 = {
        size: this.l1Cache.size,
        maxSize: this.l1Cache.max,
        calculatedSize: this.l1Cache.calculatedSize
      };
    }
    
    if (this.l3Index) {
      stats.tiers.l3 = {
        files: this.l3Index.size
      };
    }
    
    stats.queues = {
      writes: this.writeQueue.length,
      refreshes: this.refreshQueue.length
    };
    
    return stats;
  }
  
  _calculateHitRate() {
    const totalHits = Object.values(this.metrics.hits).reduce((a, b) => a + b, 0);
    const totalRequests = totalHits + this.metrics.misses;
    
    if (totalRequests === 0) return 0;
    
    return ((totalHits / totalRequests) * 100).toFixed(2) + '%';
  }
}

export default MultiTierCache;