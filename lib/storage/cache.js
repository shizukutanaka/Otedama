/**
 * Cache - Otedama
 * Simple, high-performance in-memory cache with LRU eviction
 */

import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';

const logger = createLogger('Cache');

export class Cache extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.maxSize = options.maxSize || 100 * 1024 * 1024; // 100MB
    this.maxItems = options.maxItems || 10000;
    this.defaultTTL = options.defaultTTL || 3600000; // 1 hour
    
    this.cache = new Map();
    this.size = 0;
    this.hits = 0;
    this.misses = 0;
  }
  
  get(key) {
    const item = this.cache.get(key);
    
    if (!item) {
      this.misses++;
      return null;
    }
    
    // Check expiration
    if (item.expires && Date.now() > item.expires) {
      this.delete(key);
      this.misses++;
      return null;
    }
    
    // Move to end (LRU)
    this.cache.delete(key);
    this.cache.set(key, item);
    
    this.hits++;
    return item.value;
  }
  
  set(key, value, ttl = this.defaultTTL) {
    // Calculate size
    const size = this.estimateSize(value);
    
    // Check if we need to evict
    while ((this.size + size > this.maxSize || this.cache.size >= this.maxItems) && this.cache.size > 0) {
      this.evictOldest();
    }
    
    // Remove existing if present
    if (this.cache.has(key)) {
      this.delete(key);
    }
    
    // Add new item
    const item = {
      value,
      size,
      expires: ttl > 0 ? Date.now() + ttl : null,
      created: Date.now()
    };
    
    this.cache.set(key, item);
    this.size += size;
    
    this.emit('set', { key, size });
    
    return true;
  }
  
  delete(key) {
    const item = this.cache.get(key);
    if (!item) return false;
    
    this.cache.delete(key);
    this.size -= item.size;
    
    this.emit('delete', { key });
    
    return true;
  }
  
  has(key) {
    const item = this.cache.get(key);
    if (!item) return false;
    
    // Check expiration
    if (item.expires && Date.now() > item.expires) {
      this.delete(key);
      return false;
    }
    
    return true;
  }
  
  clear() {
    this.cache.clear();
    this.size = 0;
    this.hits = 0;
    this.misses = 0;
    
    this.emit('clear');
  }
  
  // Batch operations
  
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
  
  mset(entries, ttl = this.defaultTTL) {
    const results = {};
    for (const [key, value] of Object.entries(entries)) {
      results[key] = this.set(key, value, ttl);
    }
    return results;
  }
  
  // Helper methods
  
  evictOldest() {
    const firstKey = this.cache.keys().next().value;
    if (firstKey !== undefined) {
      this.delete(firstKey);
    }
  }
  
  estimateSize(value) {
    // Simple size estimation
    if (typeof value === 'string') {
      return value.length * 2; // 2 bytes per char (UTF-16)
    } else if (Buffer.isBuffer(value)) {
      return value.length;
    } else if (typeof value === 'object') {
      return JSON.stringify(value).length * 2;
    } else {
      return 8; // Default for numbers, booleans
    }
  }
  
  // Cleanup expired entries
  
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, item] of this.cache) {
      if (item.expires && now > item.expires) {
        this.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} expired entries`);
    }
    
    return cleaned;
  }
  
  // Statistics
  
  getStats() {
    const hitRate = this.hits + this.misses > 0 
      ? this.hits / (this.hits + this.misses) 
      : 0;
    
    return {
      items: this.cache.size,
      size: this.size,
      maxSize: this.maxSize,
      maxItems: this.maxItems,
      hits: this.hits,
      misses: this.misses,
      hitRate,
      utilization: this.size / this.maxSize
    };
  }
  
  // Pattern-based operations
  
  keys(pattern) {
    if (!pattern) {
      return Array.from(this.cache.keys());
    }
    
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    const keys = [];
    
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        keys.push(key);
      }
    }
    
    return keys;
  }
  
  deletePattern(pattern) {
    const keys = this.keys(pattern);
    let deleted = 0;
    
    for (const key of keys) {
      if (this.delete(key)) {
        deleted++;
      }
    }
    
    return deleted;
  }
}

// Factory functions for specialized caches

export function createCache(options = {}) {
  return new Cache(options);
}

export function createShareCache() {
  return new Cache({
    maxItems: 100000,
    defaultTTL: 300000 // 5 minutes
  });
}

export function createJobCache() {
  return new Cache({
    maxItems: 1000,
    defaultTTL: 60000 // 1 minute
  });
}

export function createMinerCache() {
  return new Cache({
    maxItems: 10000,
    defaultTTL: 600000 // 10 minutes
  });
}

export default Cache;
