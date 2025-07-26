/**
 * Ultra Cache System - Otedama
 * High-performance caching with multiple strategies
 * 
 * Features:
 * - Multi-level cache (L1/L2/L3)
 * - LRU, LFU, and ARC algorithms
 * - Write-through and write-back strategies
 * - Cache warming and prefetching
 * - Zero-allocation cache operations
 */

import { createStructuredLogger } from '../core/structured-logger.js';
import { FastHashTable } from '../core/ultra-performance.js';

const logger = createStructuredLogger('UltraCache');

/**
 * High-performance LRU cache
 */
export class LRUCache {
  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
    this.map = new Map();
    this.head = null;
    this.tail = null;
    this.size = 0;
    
    // Pre-allocate node pool
    this.nodePool = [];
    this.preallocateNodes(100);
    
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
  }
  
  /**
   * Pre-allocate nodes for zero allocation
   */
  preallocateNodes(count) {
    for (let i = 0; i < count; i++) {
      this.nodePool.push({
        key: null,
        value: null,
        prev: null,
        next: null
      });
    }
  }
  
  /**
   * Get node from pool
   */
  getNode() {
    return this.nodePool.pop() || {
      key: null,
      value: null,
      prev: null,
      next: null
    };
  }
  
  /**
   * Return node to pool
   */
  releaseNode(node) {
    node.key = null;
    node.value = null;
    node.prev = null;
    node.next = null;
    
    if (this.nodePool.length < 1000) {
      this.nodePool.push(node);
    }
  }
  
  /**
   * Get value from cache
   */
  get(key) {
    const node = this.map.get(key);
    
    if (!node) {
      this.stats.misses++;
      return undefined;
    }
    
    this.stats.hits++;
    
    // Move to head (most recently used)
    this.moveToHead(node);
    
    return node.value;
  }
  
  /**
   * Set value in cache
   */
  set(key, value) {
    let node = this.map.get(key);
    
    if (node) {
      // Update existing
      node.value = value;
      this.moveToHead(node);
    } else {
      // Create new node
      node = this.getNode();
      node.key = key;
      node.value = value;
      
      this.map.set(key, node);
      this.addToHead(node);
      this.size++;
      
      // Evict if necessary
      if (this.size > this.maxSize) {
        this.evictLRU();
      }
    }
  }
  
  /**
   * Move node to head
   */
  moveToHead(node) {
    if (node === this.head) return;
    
    this.removeNode(node);
    this.addToHead(node);
  }
  
  /**
   * Add node to head
   */
  addToHead(node) {
    node.next = this.head;
    node.prev = null;
    
    if (this.head) {
      this.head.prev = node;
    }
    
    this.head = node;
    
    if (!this.tail) {
      this.tail = node;
    }
  }
  
  /**
   * Remove node from list
   */
  removeNode(node) {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }
    
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
  }
  
  /**
   * Evict least recently used
   */
  evictLRU() {
    if (!this.tail) return;
    
    const node = this.tail;
    this.removeNode(node);
    this.map.delete(node.key);
    this.releaseNode(node);
    this.size--;
    this.stats.evictions++;
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      size: this.size,
      hitRate: total > 0 ? this.stats.hits / total : 0
    };
  }
}

/**
 * Adaptive Replacement Cache (ARC)
 */
export class ARCCache {
  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
    
    // Four lists: T1, T2, B1, B2
    this.t1 = new Map(); // Recent cache entries
    this.t2 = new Map(); // Frequent cache entries
    this.b1 = new Map(); // Ghost entries for T1
    this.b2 = new Map(); // Ghost entries for T2
    
    this.p = 0; // Target size for T1
    
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
  }
  
  /**
   * Get value from cache
   */
  get(key) {
    // Case 1: Hit in T1 or T2
    if (this.t1.has(key)) {
      this.stats.hits++;
      const value = this.t1.get(key);
      this.t1.delete(key);
      this.t2.set(key, value);
      return value;
    }
    
    if (this.t2.has(key)) {
      this.stats.hits++;
      return this.t2.get(key);
    }
    
    this.stats.misses++;
    return undefined;
  }
  
  /**
   * Set value in cache
   */
  set(key, value) {
    // Case 1: Already in cache
    if (this.t1.has(key) || this.t2.has(key)) {
      this.get(key); // Promote
      if (this.t2.has(key)) {
        this.t2.set(key, value);
      } else {
        this.t1.set(key, value);
      }
      return;
    }
    
    // Case 2: In ghost list B1
    if (this.b1.has(key)) {
      // Adapt p
      const delta = this.b1.size >= this.b2.size ? 1 : this.b2.size / this.b1.size;
      this.p = Math.min(this.p + delta, this.maxSize);
      
      this.replace(key, this.p);
      this.b1.delete(key);
      this.t2.set(key, value);
      return;
    }
    
    // Case 3: In ghost list B2
    if (this.b2.has(key)) {
      // Adapt p
      const delta = this.b2.size >= this.b1.size ? 1 : this.b1.size / this.b2.size;
      this.p = Math.max(this.p - delta, 0);
      
      this.replace(key, this.p);
      this.b2.delete(key);
      this.t2.set(key, value);
      return;
    }
    
    // Case 4: Not in cache
    const cacheSize = this.t1.size + this.t2.size;
    
    if (cacheSize >= this.maxSize) {
      // Cache full
      if (this.t1.size < this.maxSize) {
        this.replace(key, this.p);
      } else {
        // T1 is full, evict from T1
        const lru = this.t1.keys().next().value;
        this.t1.delete(lru);
        this.b1.set(lru, null);
        this.stats.evictions++;
      }
    }
    
    // Add to T1
    this.t1.set(key, value);
    
    // Maintain ghost list sizes
    this.maintainGhostLists();
  }
  
  /**
   * Replace entry based on p
   */
  replace(key, p) {
    const t1Size = this.t1.size;
    
    if (t1Size > 0 && (t1Size > p || (this.b2.has(key) && t1Size === p))) {
      // Evict from T1
      const lru = this.t1.keys().next().value;
      this.t1.delete(lru);
      this.b1.set(lru, null);
    } else {
      // Evict from T2
      const lru = this.t2.keys().next().value;
      this.t2.delete(lru);
      this.b2.set(lru, null);
    }
    
    this.stats.evictions++;
  }
  
  /**
   * Maintain ghost list sizes
   */
  maintainGhostLists() {
    const totalGhost = this.b1.size + this.b2.size;
    
    if (totalGhost > this.maxSize) {
      if (this.b1.size > Math.max(0, this.p)) {
        const lru = this.b1.keys().next().value;
        this.b1.delete(lru);
      } else {
        const lru = this.b2.keys().next().value;
        this.b2.delete(lru);
      }
    }
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      t1Size: this.t1.size,
      t2Size: this.t2.size,
      b1Size: this.b1.size,
      b2Size: this.b2.size,
      p: this.p,
      hitRate: total > 0 ? this.stats.hits / total : 0
    };
  }
}

/**
 * Multi-level cache system
 */
export class MultiLevelCache {
  constructor(config = {}) {
    // L1: Ultra-fast in-memory cache
    this.l1 = new LRUCache(config.l1Size || 1000);
    
    // L2: Larger in-memory cache
    this.l2 = new ARCCache(config.l2Size || 10000);
    
    // L3: Disk-based cache (simulated)
    this.l3 = new Map(); // In production, use persistent storage
    this.l3MaxSize = config.l3Size || 100000;
    
    this.stats = {
      l1Hits: 0,
      l2Hits: 0,
      l3Hits: 0,
      misses: 0
    };
  }
  
  /**
   * Get value from multi-level cache
   */
  async get(key) {
    // Check L1
    let value = this.l1.get(key);
    if (value !== undefined) {
      this.stats.l1Hits++;
      return value;
    }
    
    // Check L2
    value = this.l2.get(key);
    if (value !== undefined) {
      this.stats.l2Hits++;
      // Promote to L1
      this.l1.set(key, value);
      return value;
    }
    
    // Check L3
    if (this.l3.has(key)) {
      value = this.l3.get(key);
      this.stats.l3Hits++;
      // Promote to L2 and L1
      this.l2.set(key, value);
      this.l1.set(key, value);
      return value;
    }
    
    this.stats.misses++;
    return undefined;
  }
  
  /**
   * Set value in multi-level cache
   */
  async set(key, value) {
    // Write to all levels
    this.l1.set(key, value);
    this.l2.set(key, value);
    
    // Write to L3 with eviction
    if (this.l3.size >= this.l3MaxSize) {
      // Simple FIFO eviction for L3
      const firstKey = this.l3.keys().next().value;
      this.l3.delete(firstKey);
    }
    this.l3.set(key, value);
  }
  
  /**
   * Prefetch data into cache
   */
  async prefetch(keys) {
    const results = [];
    
    for (const key of keys) {
      const value = await this.get(key);
      if (value === undefined) {
        // Simulate loading from source
        const loaded = await this.loadFromSource(key);
        if (loaded !== undefined) {
          await this.set(key, loaded);
          results.push({ key, value: loaded });
        }
      } else {
        results.push({ key, value });
      }
    }
    
    return results;
  }
  
  /**
   * Simulate loading from source
   */
  async loadFromSource(key) {
    // In production, load from database or API
    return undefined;
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    const total = this.stats.l1Hits + this.stats.l2Hits + 
                 this.stats.l3Hits + this.stats.misses;
    
    return {
      ...this.stats,
      l1Stats: this.l1.getStats(),
      l2Stats: this.l2.getStats(),
      l3Size: this.l3.size,
      overallHitRate: total > 0 ? 
        (this.stats.l1Hits + this.stats.l2Hits + this.stats.l3Hits) / total : 0
    };
  }
}

/**
 * Cache warming strategies
 */
export class CacheWarmer {
  constructor(cache) {
    this.cache = cache;
    this.patterns = new Map(); // Access patterns
    this.predictions = [];
  }
  
  /**
   * Record access pattern
   */
  recordAccess(key, timestamp = Date.now()) {
    if (!this.patterns.has(key)) {
      this.patterns.set(key, []);
    }
    
    const accesses = this.patterns.get(key);
    accesses.push(timestamp);
    
    // Keep only recent accesses
    if (accesses.length > 100) {
      accesses.shift();
    }
    
    // Update predictions
    this.updatePredictions();
  }
  
  /**
   * Update access predictions
   */
  updatePredictions() {
    this.predictions = [];
    
    for (const [key, accesses] of this.patterns) {
      if (accesses.length < 2) continue;
      
      // Calculate access frequency
      const intervals = [];
      for (let i = 1; i < accesses.length; i++) {
        intervals.push(accesses[i] - accesses[i-1]);
      }
      
      const avgInterval = intervals.reduce((a, b) => a + b) / intervals.length;
      const lastAccess = accesses[accesses.length - 1];
      const nextAccess = lastAccess + avgInterval;
      
      this.predictions.push({
        key,
        predictedTime: nextAccess,
        confidence: 1 / (intervals.length > 0 ? 
          Math.sqrt(intervals.reduce((sum, i) => sum + Math.pow(i - avgInterval, 2)) / intervals.length) : 1)
      });
    }
    
    // Sort by predicted time
    this.predictions.sort((a, b) => a.predictedTime - b.predictedTime);
  }
  
  /**
   * Warm cache based on predictions
   */
  async warmCache(lookahead = 60000) { // 1 minute lookahead
    const now = Date.now();
    const warmKeys = [];
    
    for (const prediction of this.predictions) {
      if (prediction.predictedTime <= now + lookahead && 
          prediction.confidence > 0.5) {
        warmKeys.push(prediction.key);
      }
    }
    
    // Prefetch predicted keys
    if (warmKeys.length > 0) {
      await this.cache.prefetch(warmKeys);
      logger.info('Cache warmed', { keys: warmKeys.length });
    }
  }
}

/**
 * Write-back cache with batching
 */
export class WriteBackCache {
  constructor(cache, writer, options = {}) {
    this.cache = cache;
    this.writer = writer;
    this.dirtyKeys = new Set();
    this.writeBuffer = new Map();
    
    this.batchSize = options.batchSize || 100;
    this.flushInterval = options.flushInterval || 5000; // 5 seconds
    
    // Start flush timer
    this.startFlushTimer();
  }
  
  /**
   * Get value from cache
   */
  async get(key) {
    // Check write buffer first
    if (this.writeBuffer.has(key)) {
      return this.writeBuffer.get(key);
    }
    
    return this.cache.get(key);
  }
  
  /**
   * Set value with write-back
   */
  async set(key, value) {
    // Update cache immediately
    await this.cache.set(key, value);
    
    // Mark as dirty
    this.dirtyKeys.add(key);
    this.writeBuffer.set(key, value);
    
    // Flush if buffer is full
    if (this.writeBuffer.size >= this.batchSize) {
      await this.flush();
    }
  }
  
  /**
   * Start flush timer
   */
  startFlushTimer() {
    this.flushTimer = setInterval(() => {
      if (this.writeBuffer.size > 0) {
        this.flush().catch(error => {
          logger.error('Write-back flush error', error);
        });
      }
    }, this.flushInterval);
  }
  
  /**
   * Flush dirty entries
   */
  async flush() {
    if (this.writeBuffer.size === 0) return;
    
    const entries = Array.from(this.writeBuffer.entries());
    this.writeBuffer.clear();
    this.dirtyKeys.clear();
    
    try {
      await this.writer(entries);
      logger.debug('Write-back flush completed', { count: entries.length });
    } catch (error) {
      // Re-add to buffer on error
      for (const [key, value] of entries) {
        this.writeBuffer.set(key, value);
        this.dirtyKeys.add(key);
      }
      throw error;
    }
  }
  
  /**
   * Stop write-back cache
   */
  async stop() {
    clearInterval(this.flushTimer);
    await this.flush();
  }
}

export default {
  LRUCache,
  ARCCache,
  MultiLevelCache,
  CacheWarmer,
  WriteBackCache
};