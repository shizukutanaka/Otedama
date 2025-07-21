/**
 * High-Performance LRU Cache for Otedama
 * Optimized for speed, memory efficiency, and concurrent access
 * 
 * Design principles:
 * - Carmack: Maximum performance, minimal overhead
 * - Martin: Clean interface, single responsibility
 * - Pike: Simple but powerful API
 * 
 * Features:
 * - O(1) get/set/delete operations
 * - Memory-aware eviction
 * - Concurrent safety
 * - Detailed metrics and statistics
 * - TTL support with efficient cleanup
 * - Memory pool for nodes to reduce GC pressure
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';

/**
 * Fast doubly-linked list node with memory efficiency optimizations
 */
class FastLRUNode {
  constructor() {
    this.key = null;
    this.value = null;
    this.prev = null;
    this.next = null;
    this.expires = 0;
    this.hits = 0;
    this.createdAt = 0;
    this.lastAccess = 0;
    this.size = 0; // Memory size estimate
  }
  
  /**
   * Initialize node (used from memory pool)
   */
  init(key, value, ttl = 0) {
    this.key = key;
    this.value = value;
    this.expires = ttl > 0 ? Date.now() + ttl : 0;
    this.hits = 1;
    this.createdAt = Date.now();
    this.lastAccess = this.createdAt;
    this.size = this._calculateSize(key, value);
    return this;
  }
  
  /**
   * Reset node for memory pool reuse
   */
  reset() {
    this.key = null;
    this.value = null;
    this.prev = null;
    this.next = null;
    this.expires = 0;
    this.hits = 0;
    this.createdAt = 0;
    this.lastAccess = 0;
    this.size = 0;
  }
  
  /**
   * Check if node is expired
   */
  isExpired(now = Date.now()) {
    return this.expires > 0 && now > this.expires;
  }
  
  /**
   * Update access statistics
   */
  touch(now = Date.now()) {
    this.hits++;
    this.lastAccess = now;
  }
  
  /**
   * Estimate memory size of key-value pair
   */
  _calculateSize(key, value) {
    let size = 64; // Base node overhead
    
    // Add key size
    if (typeof key === 'string') {
      size += key.length * 2; // UTF-16
    } else if (typeof key === 'number') {
      size += 8;
    } else {
      size += 32; // Estimate for objects
    }
    
    // Add value size
    if (typeof value === 'string') {
      size += value.length * 2; // UTF-16
    } else if (typeof value === 'number') {
      size += 8;
    } else if (typeof value === 'boolean') {
      size += 4;
    } else if (Buffer.isBuffer(value)) {
      size += value.length;
    } else if (value && typeof value === 'object') {
      try {
        size += JSON.stringify(value).length * 2;
      } catch {
        size += 1024; // Fallback estimate
      }
    } else {
      size += 32; // Default estimate
    }
    
    return size;
  }
}

/**
 * Memory pool for LRU nodes to reduce GC pressure
 */
class NodePool {
  constructor(initialSize = 100) {
    this.pool = [];
    this.maxSize = initialSize * 10; // Allow pool to grow
    
    // Pre-allocate initial nodes
    for (let i = 0; i < initialSize; i++) {
      this.pool.push(new FastLRUNode());
    }
  }
  
  /**
   * Get a node from the pool
   */
  acquire() {
    return this.pool.length > 0 ? this.pool.pop() : new FastLRUNode();
  }
  
  /**
   * Return a node to the pool
   */
  release(node) {
    if (this.pool.length < this.maxSize) {
      node.reset();
      this.pool.push(node);
    }
    // Otherwise let it be garbage collected
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      pooled: this.pool.length,
      maxSize: this.maxSize
    };
  }
}

/**
 * High-performance LRU Cache with advanced features
 */
export class EfficientLRUCache extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      maxSize: options.maxSize || 1000,
      maxMemoryBytes: options.maxMemoryBytes || 50 * 1024 * 1024, // 50MB
      defaultTTL: options.defaultTTL || 0,
      enableMetrics: options.enableMetrics !== false,
      enableTTL: options.enableTTL !== false,
      cleanupInterval: options.cleanupInterval || 60000, // 1 minute
      memoryCheckInterval: options.memoryCheckInterval || 30000, // 30 seconds
      evictionBatchSize: options.evictionBatchSize || 10,
      ...options
    };
    
    // Core data structures
    this.cache = new Map();
    this.size = 0;
    this.memoryUsage = 0;
    
    // Create sentinel nodes for doubly-linked list
    this.head = new FastLRUNode();
    this.tail = new FastLRUNode();
    this.head.next = this.tail;
    this.tail.prev = this.head;
    
    // Memory pool for efficient node management
    this.nodePool = new NodePool(Math.min(this.options.maxSize, 1000));
    
    // Performance metrics
    this.metrics = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
      expired: 0,
      memoryEvictions: 0,
      totalHits: 0,
      avgResponseTime: 0,
      peakMemoryUsage: 0,
      peakSize: 0
    };
    
    // TTL cleanup management
    this.ttlCleanupTimer = null;
    this.memoryCheckTimer = null;
    
    // Performance monitoring
    this.responseTimes = [];
    this.maxResponseTimeSamples = 1000;
    
    if (this.options.enableTTL) {
      this.startTTLCleanup();
    }
    
    this.startMemoryMonitoring();
    
    // Bind methods for performance
    this.get = this.get.bind(this);
    this.set = this.set.bind(this);
    this.delete = this.delete.bind(this);
  }
  
  /**
   * Get value from cache - O(1) operation
   */
  get(key, options = {}) {
    const startTime = this.options.enableMetrics ? performance.now() : 0;
    
    try {
      const node = this.cache.get(key);
      
      if (!node) {
        this.metrics.misses++;
        this.emit('miss', { key });
        return undefined;
      }
      
      // Check expiration
      if (this.options.enableTTL && node.isExpired()) {
        this._removeNode(node);
        this.metrics.misses++;
        this.metrics.expired++;
        this.emit('expired', { key });
        return undefined;
      }
      
      // Update access info
      node.touch();
      this._moveToHead(node);
      
      this.metrics.hits++;
      this.metrics.totalHits++;
      
      this.emit('hit', { key, hits: node.hits });
      
      return node.value;
      
    } finally {
      if (startTime > 0) {
        const duration = performance.now() - startTime;
        this._recordResponseTime(duration);
      }
    }
  }
  
  /**
   * Set value in cache - O(1) operation
   */
  set(key, value, options = {}) {
    const startTime = this.options.enableMetrics ? performance.now() : 0;
    const ttl = options.ttl || this.options.defaultTTL;
    
    try {
      let node = this.cache.get(key);
      
      if (node) {
        // Update existing node
        const oldSize = node.size;
        node.init(key, value, ttl);
        this.memoryUsage = this.memoryUsage - oldSize + node.size;
        this._moveToHead(node);
      } else {
        // Create new node
        node = this.nodePool.acquire().init(key, value, ttl);
        this.cache.set(key, node);
        this._addToHead(node);
        this.size++;
        this.memoryUsage += node.size;
        
        // Check if we need to evict
        this._checkEviction();
      }
      
      this.metrics.sets++;
      this._updatePeakStats();
      
      this.emit('set', { key, size: node.size, ttl });
      
      return true;
      
    } finally {
      if (startTime > 0) {
        const duration = performance.now() - startTime;
        this._recordResponseTime(duration);
      }
    }
  }
  
  /**
   * Delete value from cache - O(1) operation
   */
  delete(key) {
    const node = this.cache.get(key);
    if (!node) {
      return false;
    }
    
    this._removeNode(node);
    this.metrics.deletes++;
    this.emit('delete', { key });
    
    return true;
  }
  
  /**
   * Check if key exists in cache
   */
  has(key) {
    const node = this.cache.get(key);
    if (!node) return false;
    
    if (this.options.enableTTL && node.isExpired()) {
      this._removeNode(node);
      this.metrics.expired++;
      return false;
    }
    
    return true;
  }
  
  /**
   * Get multiple values at once
   */
  mget(keys) {
    const results = {};
    for (const key of keys) {
      const value = this.get(key);
      if (value !== undefined) {
        results[key] = value;
      }
    }
    return results;
  }
  
  /**
   * Set multiple values at once
   */
  mset(entries, options = {}) {
    const results = {};
    for (const [key, value] of Object.entries(entries)) {
      results[key] = this.set(key, value, options);
    }
    return results;
  }
  
  /**
   * Clear all entries
   */
  clear() {
    // Return all nodes to pool
    for (const node of this.cache.values()) {
      this.nodePool.release(node);
    }
    
    this.cache.clear();
    this.size = 0;
    this.memoryUsage = 0;
    
    // Reset sentinel nodes
    this.head.next = this.tail;
    this.tail.prev = this.head;
    
    this.emit('clear');
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    const hitRate = this.metrics.hits + this.metrics.misses > 0 
      ? this.metrics.hits / (this.metrics.hits + this.metrics.misses) 
      : 0;
      
    return {
      ...this.metrics,
      size: this.size,
      maxSize: this.options.maxSize,
      memoryUsage: this.memoryUsage,
      maxMemoryBytes: this.options.maxMemoryBytes,
      hitRate: hitRate,
      memoryUtilization: this.memoryUsage / this.options.maxMemoryBytes,
      sizeUtilization: this.size / this.options.maxSize,
      nodePool: this.nodePool.getStats(),
      avgResponseTime: this.metrics.avgResponseTime
    };
  }
  
  /**
   * Get memory usage breakdown
   */
  getMemoryStats() {
    let totalNodes = 0;
    let totalKeys = 0;
    let totalValues = 0;
    let expired = 0;
    const now = Date.now();
    
    for (const node of this.cache.values()) {
      totalNodes += 64; // Base node size
      totalKeys += node.key ? node.key.length * 2 : 0;
      totalValues += node.size - 64 - (node.key ? node.key.length * 2 : 0);
      
      if (node.isExpired(now)) {
        expired++;
      }
    }
    
    return {
      totalMemory: this.memoryUsage,
      nodeOverhead: totalNodes,
      keyMemory: totalKeys,
      valueMemory: totalValues,
      expired,
      efficiency: totalValues / this.memoryUsage
    };
  }
  
  /**
   * Force cleanup of expired entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    // Traverse from tail (least recently used) for efficiency
    let current = this.tail.prev;
    while (current !== this.head) {
      const prev = current.prev;
      
      if (current.isExpired(now)) {
        this._removeNode(current);
        cleaned++;
        this.metrics.expired++;
      }
      
      current = prev;
    }
    
    if (cleaned > 0) {
      this.emit('cleanup', { cleaned });
    }
    
    return cleaned;
  }
  
  /**
   * Get keys sorted by access patterns
   */
  keys(sortBy = 'access') {
    const keys = [];
    let current = this.head.next;
    
    while (current !== this.tail) {
      keys.push(current.key);
      current = current.next;
    }
    
    if (sortBy === 'hits') {
      const nodes = Array.from(this.cache.values());
      nodes.sort((a, b) => b.hits - a.hits);
      return nodes.map(node => node.key);
    }
    
    return keys; // Already sorted by access (most recent first)
  }
  
  /**
   * Shutdown cache and cleanup timers
   */
  shutdown() {
    if (this.ttlCleanupTimer) {
      clearInterval(this.ttlCleanupTimer);
      this.ttlCleanupTimer = null;
    }
    
    if (this.memoryCheckTimer) {
      clearInterval(this.memoryCheckTimer);
      this.memoryCheckTimer = null;
    }
    
    this.clear();
    this.removeAllListeners();
    
    this.emit('shutdown');
  }
  
  // Private methods
  
  /**
   * Add node to head of doubly-linked list
   */
  _addToHead(node) {
    node.prev = this.head;
    node.next = this.head.next;
    this.head.next.prev = node;
    this.head.next = node;
  }
  
  /**
   * Remove node from doubly-linked list
   */
  _removeFromList(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }
  
  /**
   * Move existing node to head
   */
  _moveToHead(node) {
    this._removeFromList(node);
    this._addToHead(node);
  }
  
  /**
   * Remove node completely from cache
   */
  _removeNode(node) {
    this.cache.delete(node.key);
    this._removeFromList(node);
    this.memoryUsage -= node.size;
    this.size--;
    this.nodePool.release(node);
  }
  
  /**
   * Check if eviction is needed and perform it
   */
  _checkEviction() {
    // Size-based eviction
    if (this.size > this.options.maxSize) {
      this._evictLRU();
    }
    
    // Memory-based eviction
    if (this.memoryUsage > this.options.maxMemoryBytes) {
      this._evictByMemory();
    }
  }
  
  /**
   * Evict least recently used entries
   */
  _evictLRU() {
    const batchSize = Math.min(this.options.evictionBatchSize, this.size);
    let evicted = 0;
    
    for (let i = 0; i < batchSize && this.size > 0; i++) {
      const lru = this.tail.prev;
      if (lru !== this.head) {
        this._removeNode(lru);
        evicted++;
        this.metrics.evictions++;
      }
    }
    
    if (evicted > 0) {
      this.emit('eviction', { type: 'lru', count: evicted });
    }
  }
  
  /**
   * Evict entries to free memory
   */
  _evictByMemory() {
    let evicted = 0;
    
    // Evict until memory usage is under limit
    while (this.memoryUsage > this.options.maxMemoryBytes && this.size > 0) {
      const lru = this.tail.prev;
      if (lru !== this.head) {
        this._removeNode(lru);
        evicted++;
        this.metrics.memoryEvictions++;
      } else {
        break;
      }
    }
    
    if (evicted > 0) {
      this.emit('eviction', { type: 'memory', count: evicted });
    }
  }
  
  /**
   * Update peak statistics
   */
  _updatePeakStats() {
    if (this.memoryUsage > this.metrics.peakMemoryUsage) {
      this.metrics.peakMemoryUsage = this.memoryUsage;
    }
    if (this.size > this.metrics.peakSize) {
      this.metrics.peakSize = this.size;
    }
  }
  
  /**
   * Record response time for performance monitoring
   */
  _recordResponseTime(duration) {
    this.responseTimes.push(duration);
    
    // Keep only recent samples
    if (this.responseTimes.length > this.maxResponseTimeSamples) {
      this.responseTimes.shift();
    }
    
    // Update average
    this.metrics.avgResponseTime = 
      this.responseTimes.reduce((sum, time) => sum + time, 0) / this.responseTimes.length;
  }
  
  /**
   * Start TTL cleanup timer
   */
  startTTLCleanup() {
    if (this.ttlCleanupTimer) return;
    
    this.ttlCleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.options.cleanupInterval);
  }
  
  /**
   * Start memory monitoring
   */
  startMemoryMonitoring() {
    if (this.memoryCheckTimer) return;
    
    this.memoryCheckTimer = setInterval(() => {
      if (this.memoryUsage > this.options.maxMemoryBytes * 0.9) {
        this._evictByMemory();
      }
    }, this.options.memoryCheckInterval);
  }
}

/**
 * Factory function for creating optimized LRU caches
 */
export function createLRUCache(options = {}) {
  return new EfficientLRUCache(options);
}

/**
 * Create domain-specific cache instances with optimized defaults
 */
export const LRUCacheFactory = {
  // High-frequency DEX cache
  createDexCache: (options = {}) => createLRUCache({
    maxSize: 10000,
    maxMemoryBytes: 64 * 1024 * 1024, // 64MB
    defaultTTL: 30000, // 30 seconds
    cleanupInterval: 10000, // 10 seconds
    evictionBatchSize: 20,
    ...options
  }),
  
  // Mining pool cache
  createPoolCache: (options = {}) => createLRUCache({
    maxSize: 5000,
    maxMemoryBytes: 32 * 1024 * 1024, // 32MB
    defaultTTL: 60000, // 1 minute
    cleanupInterval: 30000, // 30 seconds
    evictionBatchSize: 10,
    ...options
  }),
  
  // API response cache
  createApiCache: (options = {}) => createLRUCache({
    maxSize: 2000,
    maxMemoryBytes: 16 * 1024 * 1024, // 16MB
    defaultTTL: 300000, // 5 minutes
    cleanupInterval: 60000, // 1 minute
    evictionBatchSize: 5,
    ...options
  }),
  
  // Session cache
  createSessionCache: (options = {}) => createLRUCache({
    maxSize: 10000,
    maxMemoryBytes: 10 * 1024 * 1024, // 10MB
    defaultTTL: 1800000, // 30 minutes
    cleanupInterval: 120000, // 2 minutes
    evictionBatchSize: 25,
    ...options
  }),
  
  // General purpose cache
  createGeneralCache: (options = {}) => createLRUCache(options)
};

export default EfficientLRUCache;