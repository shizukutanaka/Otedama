import { EventEmitter } from 'events';
import { Logger } from './logger.js';

/**
 * Advanced Cache Manager with Memory Optimization
 * 高度なキャッシュマネージャー（メモリ最適化）
 * 
 * John Carmack Style: Ultra-optimized memory management
 * Rob Pike Style: Simple, concurrent-safe design
 * Robert C. Martin Style: Clean, extensible architecture
 * 
 * Features:
 * - LRU (Least Recently Used) eviction
 * - Multi-tier caching (memory, weak references)
 * - Automatic memory pressure response
 * - TTL (Time To Live) support
 * - Size-aware caching
 * - Compression for large values
 * - Cache warming and preloading
 * - Performance monitoring
 */
export class AdvancedCacheManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = new Logger('Cache');
    
    // Configuration
    this.config = {
      maxSize: options.maxSize || 1000,
      maxMemoryMB: options.maxMemoryMB || 100,
      defaultTTL: options.defaultTTL || 300000, // 5 minutes
      enableCompression: options.enableCompression !== false,
      compressionThreshold: options.compressionThreshold || 10240, // 10KB
      evictionPolicy: options.evictionPolicy || 'lru',
      enableMemoryPressure: options.enableMemoryPressure !== false,
      memoryCheckInterval: options.memoryCheckInterval || 30000 // 30 seconds
    };
    
    // Main cache with LRU
    this.cache = new Map();
    this.accessOrder = new Map(); // For LRU tracking
    this.weakCache = new WeakMap(); // For object references
    
    // Memory tracking
    this.memoryUsage = 0;
    this.maxMemoryBytes = this.config.maxMemoryMB * 1024 * 1024;
    
    // Statistics
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      compressions: 0,
      memoryPressureEvents: 0,
      totalSets: 0,
      totalGets: 0,
      avgGetTime: 0,
      avgSetTime: 0
    };
    
    // Performance tracking
    this.performanceHistory = [];
    
    // Timers
    this.timers = new Map();
    
    this.initialize();
  }

  /**
   * Initialize cache manager
   */
  initialize() {
    // Start periodic cleanup
    this.timers.set('cleanup', setInterval(() => {
      this.cleanup();
    }, 60000)); // 1 minute
    
    // Start memory monitoring
    if (this.config.enableMemoryPressure) {
      this.timers.set('memory', setInterval(() => {
        this.checkMemoryPressure();
      }, this.config.memoryCheckInterval));
    }
    
    // Start performance monitoring
    this.timers.set('performance', setInterval(() => {
      this.updatePerformanceMetrics();
    }, 5000)); // 5 seconds
    
    this.logger.info('Advanced cache manager initialized');
  }

  /**
   * Set value in cache
   */
  async set(key, value, options = {}) {
    const startTime = performance.now();
    
    try {
      const ttl = options.ttl || this.config.defaultTTL;
      const priority = options.priority || 1;
      const compress = options.compress !== false;
      
      // Prepare cache entry
      let cacheValue = value;
      let compressed = false;
      let size = this.estimateSize(value);
      
      // Compress if needed
      if (compress && this.config.enableCompression && size > this.config.compressionThreshold) {
        cacheValue = await this.compress(value);
        compressed = true;
        size = this.estimateSize(cacheValue);
        this.stats.compressions++;
      }
      
      // Check memory limit
      if (this.memoryUsage + size > this.maxMemoryBytes) {
        await this.makeSpace(size);
      }
      
      // Create cache entry
      const entry = {
        value: cacheValue,
        size,
        compressed,
        expires: ttl > 0 ? Date.now() + ttl : 0,
        priority,
        accessCount: 0,
        lastAccess: Date.now(),
        created: Date.now()
      };
      
      // Remove old entry if exists
      if (this.cache.has(key)) {
        const oldEntry = this.cache.get(key);
        this.memoryUsage -= oldEntry.size;
      }
      
      // Add to cache
      this.cache.set(key, entry);
      this.accessOrder.set(key, Date.now());
      this.memoryUsage += size;
      
      // Update stats
      this.stats.totalSets++;
      const setTime = performance.now() - startTime;
      this.updateAvgSetTime(setTime);
      
      // Emit event
      this.emit('set', { key, size, compressed });
      
      return true;
      
    } catch (error) {
      this.logger.error(`Error setting cache key ${key}:`, error);
      return false;
    }
  }

  /**
   * Get value from cache
   */
  async get(key) {
    const startTime = performance.now();
    
    try {
      const entry = this.cache.get(key);
      
      if (!entry) {
        this.stats.misses++;
        this.stats.totalGets++;
        return null;
      }
      
      // Check expiration
      if (entry.expires > 0 && Date.now() > entry.expires) {
        this.delete(key);
        this.stats.misses++;
        this.stats.totalGets++;
        return null;
      }
      
      // Update access info
      entry.accessCount++;
      entry.lastAccess = Date.now();
      this.accessOrder.set(key, Date.now());
      
      // Decompress if needed
      let value = entry.value;
      if (entry.compressed) {
        value = await this.decompress(value);
      }
      
      // Update stats
      this.stats.hits++;
      this.stats.totalGets++;
      const getTime = performance.now() - startTime;
      this.updateAvgGetTime(getTime);
      
      return value;
      
    } catch (error) {
      this.logger.error(`Error getting cache key ${key}:`, error);
      this.stats.misses++;
      this.stats.totalGets++;
      return null;
    }
  }

  /**
   * Delete key from cache
   */
  delete(key) {
    const entry = this.cache.get(key);
    if (entry) {
      this.memoryUsage -= entry.size;
      this.cache.delete(key);
      this.accessOrder.delete(key);
      return true;
    }
    return false;
  }

  /**
   * Clear entire cache
   */
  clear() {
    this.cache.clear();
    this.accessOrder.clear();
    this.memoryUsage = 0;
    this.emit('cleared');
  }

  /**
   * Set object in weak cache
   */
  setWeak(obj, value) {
    if (typeof obj === 'object' && obj !== null) {
      this.weakCache.set(obj, value);
      return true;
    }
    return false;
  }

  /**
   * Get object from weak cache
   */
  getWeak(obj) {
    return this.weakCache.get(obj);
  }

  /**
   * Make space for new entry
   */
  async makeSpace(requiredSize) {
    const entries = Array.from(this.cache.entries());
    
    // Sort by eviction policy
    if (this.config.evictionPolicy === 'lru') {
      entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    } else if (this.config.evictionPolicy === 'lfu') {
      entries.sort((a, b) => a[1].accessCount - b[1].accessCount);
    } else if (this.config.evictionPolicy === 'priority') {
      entries.sort((a, b) => a[1].priority - b[1].priority);
    }
    
    // Evict entries until we have enough space
    let freedSpace = 0;
    const toEvict = [];
    
    for (const [key, entry] of entries) {
      if (freedSpace >= requiredSize) break;
      toEvict.push(key);
      freedSpace += entry.size;
    }
    
    // Perform evictions
    for (const key of toEvict) {
      this.delete(key);
      this.stats.evictions++;
    }
    
    if (toEvict.length > 0) {
      this.logger.debug(`Evicted ${toEvict.length} entries to free ${freedSpace} bytes`);
      this.emit('eviction', { count: toEvict.length, freedSpace });
    }
  }

  /**
   * Cleanup expired entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of this.cache) {
      if (entry.expires > 0 && now > entry.expires) {
        this.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired entries`);
      this.emit('cleanup', { cleaned });
    }
  }

  /**
   * Check memory pressure
   */
  checkMemoryPressure() {
    const memInfo = process.memoryUsage();
    const heapUsedPercent = memInfo.heapUsed / memInfo.heapTotal;
    
    if (heapUsedPercent > 0.85) {
      this.logger.warn('High memory pressure detected');
      this.stats.memoryPressureEvents++;
      
      // Aggressive cleanup
      this.reduceMemoryUsage();
      
      this.emit('memoryPressure', {
        heapUsedPercent,
        cacheMemoryUsage: this.memoryUsage
      });
    }
  }

  /**
   * Reduce memory usage aggressively
   */
  reduceMemoryUsage() {
    // Remove 20% of least recently used entries
    const targetReduction = Math.floor(this.cache.size * 0.2);
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    
    for (let i = 0; i < targetReduction && i < entries.length; i++) {
      this.delete(entries[i][0]);
    }
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
  }

  /**
   * Compress value
   */
  async compress(value) {
    try {
      const { gzip } = await import('zlib');
      const { promisify } = await import('util');
      const gzipAsync = promisify(gzip);
      
      const json = JSON.stringify(value);
      const compressed = await gzipAsync(json);
      
      return {
        _compressed: true,
        data: compressed.toString('base64')
      };
    } catch (error) {
      this.logger.warn('Compression failed:', error);
      return value;
    }
  }

  /**
   * Decompress value
   */
  async decompress(value) {
    if (!value._compressed) return value;
    
    try {
      const { gunzip } = await import('zlib');
      const { promisify } = await import('util');
      const gunzipAsync = promisify(gunzip);
      
      const buffer = Buffer.from(value.data, 'base64');
      const decompressed = await gunzipAsync(buffer);
      
      return JSON.parse(decompressed.toString());
    } catch (error) {
      this.logger.warn('Decompression failed:', error);
      return value;
    }
  }

  /**
   * Estimate size of value
   */
  estimateSize(value) {
    if (typeof value === 'string') {
      return value.length * 2; // 2 bytes per char (UTF-16)
    }
    
    if (Buffer.isBuffer(value)) {
      return value.length;
    }
    
    // For objects, estimate via JSON
    try {
      return JSON.stringify(value).length * 2;
    } catch (error) {
      return 1024; // Default 1KB
    }
  }

  /**
   * Update average get time
   */
  updateAvgGetTime(time) {
    const alpha = 0.1; // Exponential smoothing
    this.stats.avgGetTime = this.stats.avgGetTime * (1 - alpha) + time * alpha;
  }

  /**
   * Update average set time
   */
  updateAvgSetTime(time) {
    const alpha = 0.1;
    this.stats.avgSetTime = this.stats.avgSetTime * (1 - alpha) + time * alpha;
  }

  /**
   * Update performance metrics
   */
  updatePerformanceMetrics() {
    const metrics = {
      timestamp: Date.now(),
      hitRate: this.getHitRate(),
      memoryUsage: this.memoryUsage,
      cacheSize: this.cache.size,
      avgGetTime: this.stats.avgGetTime,
      avgSetTime: this.stats.avgSetTime
    };
    
    this.performanceHistory.push(metrics);
    
    // Keep only last hour
    const oneHourAgo = Date.now() - 3600000;
    this.performanceHistory = this.performanceHistory.filter(
      m => m.timestamp > oneHourAgo
    );
    
    this.emit('metrics', metrics);
  }

  /**
   * Get hit rate
   */
  getHitRate() {
    const total = this.stats.hits + this.stats.misses;
    return total > 0 ? (this.stats.hits / total) : 0;
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      memoryUsageMB: (this.memoryUsage / 1024 / 1024).toFixed(2),
      hitRate: (this.getHitRate() * 100).toFixed(2) + '%',
      avgGetTimeMs: this.stats.avgGetTime.toFixed(2),
      avgSetTimeMs: this.stats.avgSetTime.toFixed(2)
    };
  }

  /**
   * Get performance report
   */
  getPerformanceReport() {
    return {
      current: this.getStats(),
      history: this.performanceHistory,
      topKeys: this.getTopKeys(),
      memoryDistribution: this.getMemoryDistribution()
    };
  }

  /**
   * Get most frequently accessed keys
   */
  getTopKeys(limit = 10) {
    return Array.from(this.cache.entries())
      .sort((a, b) => b[1].accessCount - a[1].accessCount)
      .slice(0, limit)
      .map(([key, entry]) => ({
        key,
        accessCount: entry.accessCount,
        size: entry.size,
        compressed: entry.compressed
      }));
  }

  /**
   * Get memory distribution
   */
  getMemoryDistribution() {
    const distribution = {
      small: 0,  // < 1KB
      medium: 0, // 1KB - 10KB
      large: 0,  // 10KB - 100KB
      huge: 0    // > 100KB
    };
    
    for (const entry of this.cache.values()) {
      if (entry.size < 1024) distribution.small++;
      else if (entry.size < 10240) distribution.medium++;
      else if (entry.size < 102400) distribution.large++;
      else distribution.huge++;
    }
    
    return distribution;
  }

  /**
   * Preload cache with data
   */
  async preload(entries) {
    const results = [];
    
    for (const { key, value, options } of entries) {
      try {
        await this.set(key, value, options);
        results.push({ key, success: true });
      } catch (error) {
        results.push({ key, success: false, error: error.message });
      }
    }
    
    return results;
  }

  /**
   * Export cache data
   */
  export() {
    const data = [];
    
    for (const [key, entry] of this.cache) {
      if (entry.expires === 0 || entry.expires > Date.now()) {
        data.push({
          key,
          value: entry.value,
          compressed: entry.compressed,
          expires: entry.expires,
          priority: entry.priority
        });
      }
    }
    
    return data;
  }

  /**
   * Import cache data
   */
  async import(data) {
    const results = await this.preload(
      data.map(item => ({
        key: item.key,
        value: item.value,
        options: {
          ttl: item.expires ? item.expires - Date.now() : 0,
          priority: item.priority,
          compress: false // Already compressed if needed
        }
      }))
    );
    
    return results;
  }

  /**
   * Stop cache manager
   */
  destroy() {
    // Clear all timers
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    
    // Clear cache
    this.clear();
    
    this.logger.info('Cache manager destroyed');
  }
}

// Singleton instance
export const advancedCache = new AdvancedCacheManager({
  maxSize: 1000,
  maxMemoryMB: 100,
  defaultTTL: 300000,
  enableCompression: true,
  evictionPolicy: 'lru'
});

// For backward compatibility
export class CacheManager extends AdvancedCacheManager {
  constructor(maxSize = 1000, ttl = 300000) {
    super({
      maxSize,
      defaultTTL: ttl,
      enableCompression: false // Disable by default for compatibility
    });
  }
}

export const globalCache = new CacheManager();
