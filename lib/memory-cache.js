/**
 * Memory Cache Manager for Otedama
 * High-performance in-memory caching with LRU eviction
 */

import { EventEmitter } from 'events';
import { Logger } from './logger.js';

export class MemoryCache extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || new Logger('MemoryCache');
    this.options = {
      maxSize: options.maxSize || 100 * 1024 * 1024, // 100MB default
      maxItems: options.maxItems || 10000,
      ttl: options.ttl || 3600000, // 1 hour default
      checkPeriod: options.checkPeriod || 60000, // 1 minute
      ...options
    };
    
    // Cache storage
    this.cache = new Map();
    this.accessOrder = new Map(); // For LRU tracking
    this.sizeMap = new Map(); // Track size of each entry
    
    // Statistics
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
      currentSize: 0,
      currentItems: 0
    };
    
    // Start cleanup timer
    this.startCleanup();
  }
  
  /**
   * Get value from cache
   */
  get(key) {
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    
    // Check if expired
    if (entry.expires && Date.now() > entry.expires) {
      this.delete(key);
      this.stats.misses++;
      return null;
    }
    
    // Update access time for LRU
    this.accessOrder.set(key, Date.now());
    
    this.stats.hits++;
    this.emit('hit', { key, size: entry.size });
    
    return entry.value;
  }
  
  /**
   * Set value in cache
   */
  set(key, value, options = {}) {
    const ttl = options.ttl || this.options.ttl;
    const size = this.calculateSize(value);
    
    // Check if would exceed max size
    if (size > this.options.maxSize) {
      this.logger.warn(`Cache entry too large: ${key} (${size} bytes)`);
      return false;
    }
    
    // Evict if necessary
    while (this.stats.currentSize + size > this.options.maxSize || 
           this.stats.currentItems >= this.options.maxItems) {
      if (!this.evictLRU()) break;
    }
    
    // Store entry
    const entry = {
      value,
      size,
      created: Date.now(),
      expires: ttl > 0 ? Date.now() + ttl : null
    };
    
    // Update existing entry
    if (this.cache.has(key)) {
      const oldSize = this.sizeMap.get(key) || 0;
      this.stats.currentSize -= oldSize;
    } else {
      this.stats.currentItems++;
    }
    
    this.cache.set(key, entry);
    this.sizeMap.set(key, size);
    this.accessOrder.set(key, Date.now());
    
    this.stats.currentSize += size;
    this.stats.sets++;
    
    this.emit('set', { key, size, ttl });
    
    return true;
  }
  
  /**
   * Delete value from cache
   */
  delete(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    this.cache.delete(key);
    this.accessOrder.delete(key);
    
    const size = this.sizeMap.get(key) || 0;
    this.sizeMap.delete(key);
    
    this.stats.currentSize -= size;
    this.stats.currentItems--;
    this.stats.deletes++;
    
    this.emit('delete', { key, size });
    
    return true;
  }
  
  /**
   * Clear all cache entries
   */
  clear() {
    const previousItems = this.stats.currentItems;
    const previousSize = this.stats.currentSize;
    
    this.cache.clear();
    this.accessOrder.clear();
    this.sizeMap.clear();
    
    this.stats.currentSize = 0;
    this.stats.currentItems = 0;
    
    this.emit('clear', { items: previousItems, size: previousSize });
  }
  
  /**
   * Check if key exists
   */
  has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    // Check if expired
    if (entry.expires && Date.now() > entry.expires) {
      this.delete(key);
      return false;
    }
    
    return true;
  }
  
  /**
   * Get multiple values
   */
  mget(keys) {
    const results = {};
    
    for (const key of keys) {
      const value = this.get(key);
      if (value !== null) {
        results[key] = value;
      }
    }
    
    return results;
  }
  
  /**
   * Set multiple values
   */
  mset(entries, options = {}) {
    const results = {};
    
    for (const [key, value] of Object.entries(entries)) {
      results[key] = this.set(key, value, options);
    }
    
    return results;
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? this.stats.hits / (this.stats.hits + this.stats.misses)
      : 0;
    
    return {
      ...this.stats,
      hitRate,
      utilizationSize: this.stats.currentSize / this.options.maxSize,
      utilizationItems: this.stats.currentItems / this.options.maxItems
    };
  }
  
  /**
   * Calculate size of value
   */
  calculateSize(value) {
    if (typeof value === 'string') {
      return value.length * 2; // Approximate UTF-16 size
    } else if (typeof value === 'number') {
      return 8;
    } else if (typeof value === 'boolean') {
      return 4;
    } else if (value === null || value === undefined) {
      return 0;
    } else if (Buffer.isBuffer(value)) {
      return value.length;
    } else {
      // For objects/arrays, use JSON stringify as approximation
      try {
        return JSON.stringify(value).length * 2;
      } catch (e) {
        return 1024; // Default size for non-serializable objects
      }
    }
  }
  
  /**
   * Evict least recently used entry
   */
  evictLRU() {
    let oldestKey = null;
    let oldestTime = Infinity;
    
    for (const [key, time] of this.accessOrder) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.delete(oldestKey);
      this.stats.evictions++;
      this.emit('evict', { key: oldestKey });
      return true;
    }
    
    return false;
  }
  
  /**
   * Start periodic cleanup
   */
  startCleanup() {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.options.checkPeriod);
  }
  
  /**
   * Clean up expired entries
   */
  cleanup() {
    const now = Date.now();
    const keysToDelete = [];
    
    for (const [key, entry] of this.cache) {
      if (entry.expires && now > entry.expires) {
        keysToDelete.push(key);
      }
    }
    
    for (const key of keysToDelete) {
      this.delete(key);
    }
    
    if (keysToDelete.length > 0) {
      this.logger.debug(`Cleaned up ${keysToDelete.length} expired entries`);
      this.emit('cleanup', { expired: keysToDelete.length });
    }
  }
  
  /**
   * Stop cleanup timer
   */
  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
  
  /**
   * Destroy cache
   */
  destroy() {
    this.stopCleanup();
    this.clear();
    this.removeAllListeners();
  }
}

/**
 * Specialized cache for different data types
 */
export class TypedCache extends MemoryCache {
  constructor(options = {}) {
    super(options);
    this.serializers = new Map();
    this.deserializers = new Map();
    
    // Register default types
    this.registerType('json', JSON.stringify, JSON.parse);
    this.registerType('buffer', (v) => v, (v) => v);
    this.registerType('bigint', (v) => v.toString(), (v) => BigInt(v));
  }
  
  registerType(type, serializer, deserializer) {
    this.serializers.set(type, serializer);
    this.deserializers.set(type, deserializer);
  }
  
  setTyped(key, value, type = 'json', options = {}) {
    const serializer = this.serializers.get(type);
    if (!serializer) {
      throw new Error(`Unknown type: ${type}`);
    }
    
    const serialized = serializer(value);
    return this.set(key, { type, data: serialized }, options);
  }
  
  getTyped(key) {
    const entry = this.get(key);
    if (!entry) return null;
    
    const { type, data } = entry;
    const deserializer = this.deserializers.get(type);
    
    if (!deserializer) {
      this.logger.warn(`Unknown type in cache: ${type}`);
      return data;
    }
    
    try {
      return deserializer(data);
    } catch (error) {
      this.logger.error(`Failed to deserialize cache entry: ${key}`, error);
      return null;
    }
  }
}

/**
 * Cache with automatic loading
 */
export class LoadingCache extends MemoryCache {
  constructor(loader, options = {}) {
    super(options);
    this.loader = loader;
    this.loading = new Map(); // Track in-flight loads
  }
  
  async getOrLoad(key, loaderOptions) {
    // Check cache first
    const cached = this.get(key);
    if (cached !== null) return cached;
    
    // Check if already loading
    if (this.loading.has(key)) {
      return this.loading.get(key);
    }
    
    // Load value
    const loadPromise = this.loadValue(key, loaderOptions);
    this.loading.set(key, loadPromise);
    
    try {
      const value = await loadPromise;
      this.set(key, value);
      return value;
    } finally {
      this.loading.delete(key);
    }
  }
  
  async loadValue(key, options) {
    try {
      return await this.loader(key, options);
    } catch (error) {
      this.logger.error(`Failed to load value for key: ${key}`, error);
      throw error;
    }
  }
  
  async refresh(key, loaderOptions) {
    this.delete(key);
    return this.getOrLoad(key, loaderOptions);
  }
}