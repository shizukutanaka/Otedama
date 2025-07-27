/**
 * Memory Efficient Cache for Otedama
 * Optimized cache with automatic memory management
 * 
 * Design principles:
 * - Carmack: Zero-allocation patterns, minimal memory overhead
 * - Martin: Clean cache interface
 * - Pike: Simple but effective caching
 */

import { createStructuredLogger } from './structured-logger.js';
import { performance } from 'perf_hooks';

const logger = createStructuredLogger('MemoryEfficientCache');

// Cache replacement policies
export const ReplacementPolicy = {
  LRU: 'lru',      // Least Recently Used
  LFU: 'lfu',      // Least Frequently Used  
  FIFO: 'fifo',    // First In First Out
  LIFO: 'lifo'     // Last In First Out
};

export class MemoryEfficientCache {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 10000;
    this.maxMemory = options.maxMemory || 100 * 1024 * 1024; // 100MB default
    this.ttl = options.ttl || 0; // 0 = no expiry
    this.policy = options.policy || ReplacementPolicy.LRU;
    
    // Pre-allocated storage
    this.keys = new Array(this.maxSize);
    this.values = new Array(this.maxSize);
    this.metadata = new Array(this.maxSize);
    this.size = 0;
    this.memoryUsed = 0;
    
    // Index map for O(1) lookups
    this.indexMap = new Map();
    
    // Stats
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      memoryEvictions: 0
    };
    
    // Memory monitoring
    this.startMemoryMonitoring();
  }
  
  /**
   * Get value from cache
   */
  get(key) {
    const index = this.indexMap.get(key);
    
    if (index === undefined) {
      this.stats.misses++;
      return undefined;
    }
    
    const metadata = this.metadata[index];
    
    // Check expiry
    if (this.ttl > 0 && Date.now() - metadata.created > this.ttl) {
      this.delete(key);
      this.stats.misses++;
      return undefined;
    }
    
    // Update access metadata
    metadata.lastAccess = Date.now();
    metadata.accessCount++;
    
    // Move to front for LRU
    if (this.policy === ReplacementPolicy.LRU && index > 0) {
      this.moveToFront(index);
    }
    
    this.stats.hits++;
    return this.values[index];
  }
  
  /**
   * Set value in cache
   */
  set(key, value) {
    // Check if key exists
    let index = this.indexMap.get(key);
    
    if (index !== undefined) {
      // Update existing entry
      this.memoryUsed -= this.getSize(this.values[index]);
      this.values[index] = value;
      this.memoryUsed += this.getSize(value);
      this.metadata[index].updated = Date.now();
      
      if (this.policy === ReplacementPolicy.LRU) {
        this.moveToFront(index);
      }
      
      return true;
    }
    
    // Check capacity
    if (this.size >= this.maxSize) {
      this.evict();
    }
    
    // Check memory limit
    const valueSize = this.getSize(value);
    while (this.memoryUsed + valueSize > this.maxMemory && this.size > 0) {
      this.evictLargest();
      this.stats.memoryEvictions++;
    }
    
    // Add new entry
    index = this.size;
    this.keys[index] = key;
    this.values[index] = value;
    this.metadata[index] = {
      created: Date.now(),
      updated: Date.now(),
      lastAccess: Date.now(),
      accessCount: 1,
      size: valueSize
    };
    
    this.indexMap.set(key, index);
    this.size++;
    this.memoryUsed += valueSize;
    
    return true;
  }
  
  /**
   * Delete from cache
   */
  delete(key) {
    const index = this.indexMap.get(key);
    
    if (index === undefined) {
      return false;
    }
    
    // Update memory usage
    this.memoryUsed -= this.metadata[index].size;
    
    // Remove from index map
    this.indexMap.delete(key);
    
    // Move last element to this position
    if (index < this.size - 1) {
      const lastIndex = this.size - 1;
      this.keys[index] = this.keys[lastIndex];
      this.values[index] = this.values[lastIndex];
      this.metadata[index] = this.metadata[lastIndex];
      
      // Update index map
      this.indexMap.set(this.keys[index], index);
    }
    
    // Clear last position
    this.size--;
    this.keys[this.size] = undefined;
    this.values[this.size] = undefined;
    this.metadata[this.size] = undefined;
    
    return true;
  }
  
  /**
   * Clear cache
   */
  clear() {
    // Clear arrays efficiently
    for (let i = 0; i < this.size; i++) {
      this.keys[i] = undefined;
      this.values[i] = undefined;
      this.metadata[i] = undefined;
    }
    
    this.indexMap.clear();
    this.size = 0;
    this.memoryUsed = 0;
  }
  
  /**
   * Move element to front (for LRU)
   */
  moveToFront(index) {
    if (index === 0) return;
    
    // Save element
    const key = this.keys[index];
    const value = this.values[index];
    const metadata = this.metadata[index];
    
    // Shift elements
    for (let i = index; i > 0; i--) {
      this.keys[i] = this.keys[i - 1];
      this.values[i] = this.values[i - 1];
      this.metadata[i] = this.metadata[i - 1];
      
      // Update index map
      this.indexMap.set(this.keys[i], i);
    }
    
    // Place at front
    this.keys[0] = key;
    this.values[0] = value;
    this.metadata[0] = metadata;
    this.indexMap.set(key, 0);
  }
  
  /**
   * Evict based on policy
   */
  evict() {
    let evictIndex = -1;
    
    switch (this.policy) {
      case ReplacementPolicy.LRU:
        // Last element is least recently used
        evictIndex = this.size - 1;
        break;
        
      case ReplacementPolicy.LFU:
        // Find least frequently used
        evictIndex = this.findLFU();
        break;
        
      case ReplacementPolicy.FIFO:
        // Last element is oldest
        evictIndex = this.size - 1;
        break;
        
      case ReplacementPolicy.LIFO:
        // First element is newest
        evictIndex = 0;
        break;
    }
    
    if (evictIndex >= 0) {
      const key = this.keys[evictIndex];
      this.delete(key);
      this.stats.evictions++;
    }
  }
  
  /**
   * Find least frequently used index
   */
  findLFU() {
    let minIndex = 0;
    let minCount = this.metadata[0].accessCount;
    
    for (let i = 1; i < this.size; i++) {
      if (this.metadata[i].accessCount < minCount) {
        minCount = this.metadata[i].accessCount;
        minIndex = i;
      }
    }
    
    return minIndex;
  }
  
  /**
   * Evict largest item
   */
  evictLargest() {
    let maxIndex = 0;
    let maxSize = this.metadata[0].size;
    
    for (let i = 1; i < this.size; i++) {
      if (this.metadata[i].size > maxSize) {
        maxSize = this.metadata[i].size;
        maxIndex = i;
      }
    }
    
    const key = this.keys[maxIndex];
    this.delete(key);
  }
  
  /**
   * Get approximate size of value
   */
  getSize(value) {
    if (value === null || value === undefined) return 0;
    
    const type = typeof value;
    
    if (type === 'string') {
      return value.length * 2; // 2 bytes per char (UTF-16)
    }
    
    if (type === 'number') {
      return 8; // 64-bit number
    }
    
    if (type === 'boolean') {
      return 1;
    }
    
    if (value instanceof Buffer) {
      return value.length;
    }
    
    if (value instanceof ArrayBuffer) {
      return value.byteLength;
    }
    
    // For objects, estimate based on JSON
    try {
      return JSON.stringify(value).length * 2;
    } catch {
      return 1024; // Default estimate
    }
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
      hitRate: (hitRate * 100).toFixed(2) + '%',
      size: this.size,
      maxSize: this.maxSize,
      memoryUsed: this.memoryUsed,
      maxMemory: this.maxMemory,
      memoryUsage: ((this.memoryUsed / this.maxMemory) * 100).toFixed(2) + '%'
    };
  }
  
  /**
   * Start memory monitoring
   */
  startMemoryMonitoring() {
    // Periodically check memory pressure
    this.memoryMonitor = setInterval(() => {
      const memInfo = process.memoryUsage();
      const heapUsed = memInfo.heapUsed;
      const heapTotal = memInfo.heapTotal;
      
      // If heap is over 80% full, reduce cache size
      if (heapUsed / heapTotal > 0.8) {
        const targetSize = Math.floor(this.size * 0.8);
        while (this.size > targetSize) {
          this.evict();
        }
        logger.warn('Memory pressure detected, reduced cache size', {
          from: this.size,
          to: targetSize
        });
      }
    }, 30000); // Check every 30 seconds
  }
  
  /**
   * Stop memory monitoring
   */
  stopMemoryMonitoring() {
    if (this.memoryMonitor) {
      clearInterval(this.memoryMonitor);
      this.memoryMonitor = null;
    }
  }
  
  /**
   * Iterate over cache entries
   */
  *entries() {
    for (let i = 0; i < this.size; i++) {
      yield [this.keys[i], this.values[i]];
    }
  }
  
  /**
   * Get all keys
   */
  keys() {
    return this.keys.slice(0, this.size);
  }
  
  /**
   * Get all values
   */
  values() {
    return this.values.slice(0, this.size);
  }
  
  /**
   * Check if key exists
   */
  has(key) {
    return this.indexMap.has(key);
  }
  
  /**
   * Get cache size
   */
  get length() {
    return this.size;
  }
}

// Singleton instance for global cache
export const globalCache = new MemoryEfficientCache({
  maxSize: 50000,
  maxMemory: 500 * 1024 * 1024, // 500MB
  policy: ReplacementPolicy.LRU
});

export default MemoryEfficientCache;