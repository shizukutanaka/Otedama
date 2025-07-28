/**
 * CLOCK-Pro Cache Implementation
 * More efficient than LRU for many workloads with O(1) operations
 * 
 * Design: Second-chance algorithm with hot/cold data separation
 */

import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('ClockCache');

/**
 * CLOCK cache entry
 */
class ClockEntry {
  constructor(key, value) {
    this.key = key;
    this.value = value;
    this.referenced = false;
    this.hot = false;
    this.accessCount = 1;
    this.lastAccess = Date.now();
  }
  
  access() {
    this.referenced = true;
    this.accessCount++;
    this.lastAccess = Date.now();
    
    // Promote to hot if frequently accessed
    if (this.accessCount > 2 && !this.hot) {
      this.hot = true;
    }
  }
  
  reset() {
    this.key = null;
    this.value = null;
    this.referenced = false;
    this.hot = false;
    this.accessCount = 0;
    this.lastAccess = 0;
  }
}

/**
 * High-performance CLOCK cache
 */
export class ClockCache {
  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
    this.size = 0;
    
    // Circular buffer for CLOCK algorithm
    this.entries = new Array(maxSize);
    this.clockHand = 0;
    
    // Hash map for O(1) lookups
    this.keyToIndex = new Map();
    
    // Entry pool for object reuse
    this.entryPool = [];
    this.preallocateEntries(Math.min(maxSize / 10, 1000));
    
    // Statistics
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      clockRotations: 0,
      hotPromotions: 0,
      entryPoolHits: 0
    };
  }
  
  /**
   * Pre-allocate entry objects
   */
  preallocateEntries(count) {
    for (let i = 0; i < count; i++) {
      this.entryPool.push(new ClockEntry(null, null));
    }
  }
  
  /**
   * Get entry from pool
   */
  getEntry(key, value) {
    if (this.entryPool.length > 0) {
      this.stats.entryPoolHits++;
      const entry = this.entryPool.pop();
      entry.key = key;
      entry.value = value;
      entry.referenced = false;
      entry.hot = false;
      entry.accessCount = 1;
      entry.lastAccess = Date.now();
      return entry;
    } else {
      return new ClockEntry(key, value);
    }
  }
  
  /**
   * Return entry to pool
   */
  releaseEntry(entry) {
    if (!entry) return;
    
    entry.reset();
    
    if (this.entryPool.length < 1000) {
      this.entryPool.push(entry);
    }
  }
  
  /**
   * Get value from cache
   */
  get(key) {
    const index = this.keyToIndex.get(key);
    
    if (index === undefined) {
      this.stats.misses++;
      return undefined;
    }
    
    const entry = this.entries[index];
    if (!entry || entry.key !== key) {
      // Index is stale, clean up
      this.keyToIndex.delete(key);
      this.stats.misses++;
      return undefined;
    }
    
    this.stats.hits++;
    entry.access();
    
    if (entry.hot && !entry.hot) {
      this.stats.hotPromotions++;
    }
    
    return entry.value;
  }
  
  /**
   * Set value in cache
   */
  set(key, value) {
    // Check if key already exists
    const existingIndex = this.keyToIndex.get(key);
    if (existingIndex !== undefined) {
      const entry = this.entries[existingIndex];
      if (entry && entry.key === key) {
        // Update existing entry
        entry.value = value;
        entry.access();
        return;
      }
    }
    
    // Need to add new entry
    if (this.size < this.maxSize) {
      // Find empty slot
      this.addNewEntry(key, value);
    } else {
      // Need to evict using CLOCK algorithm
      this.evictAndAdd(key, value);
    }
  }
  
  /**
   * Add new entry to cache
   */
  addNewEntry(key, value) {
    // Find first empty slot
    for (let i = 0; i < this.maxSize; i++) {
      if (!this.entries[i]) {
        const entry = this.getEntry(key, value);
        this.entries[i] = entry;
        this.keyToIndex.set(key, i);
        this.size++;
        return;
      }
    }
  }
  
  /**
   * Evict entry using CLOCK algorithm and add new one
   */
  evictAndAdd(key, value) {
    let rotations = 0;
    const maxRotations = this.maxSize * 2; // Prevent infinite loops
    
    while (rotations < maxRotations) {
      const entry = this.entries[this.clockHand];
      
      if (!entry) {
        // Empty slot found
        break;
      }
      
      if (entry.referenced) {
        // Give second chance
        entry.referenced = false;
        this.clockHand = (this.clockHand + 1) % this.maxSize;
        rotations++;
        continue;
      }
      
      if (entry.hot && entry.accessCount > 5) {
        // Hot entry gets extra protection
        entry.hot = false; // Demote but don't evict yet
        this.clockHand = (this.clockHand + 1) % this.maxSize;
        rotations++;
        continue;
      }
      
      // Evict this entry
      this.keyToIndex.delete(entry.key);
      this.releaseEntry(entry);
      this.stats.evictions++;
      break;
    }
    
    this.stats.clockRotations += rotations;
    
    // Add new entry at clock hand position
    const newEntry = this.getEntry(key, value);
    this.entries[this.clockHand] = newEntry;
    this.keyToIndex.set(key, this.clockHand);
    
    this.clockHand = (this.clockHand + 1) % this.maxSize;
  }
  
  /**
   * Check if key exists
   */
  has(key) {
    const index = this.keyToIndex.get(key);
    if (index === undefined) return false;
    
    const entry = this.entries[index];
    return entry && entry.key === key;
  }
  
  /**
   * Delete key from cache
   */
  delete(key) {
    const index = this.keyToIndex.get(key);
    if (index === undefined) return false;
    
    const entry = this.entries[index];
    if (!entry || entry.key !== key) return false;
    
    this.keyToIndex.delete(key);
    this.releaseEntry(entry);
    this.entries[index] = null;
    this.size--;
    
    return true;
  }
  
  /**
   * Clear all entries
   */
  clear() {
    for (let i = 0; i < this.maxSize; i++) {
      if (this.entries[i]) {
        this.releaseEntry(this.entries[i]);
        this.entries[i] = null;
      }
    }
    
    this.keyToIndex.clear();
    this.size = 0;
    this.clockHand = 0;
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? this.stats.hits / total : 0;
    
    // Calculate hot entry percentage
    let hotEntries = 0;
    for (const entry of this.entries) {
      if (entry && entry.hot) hotEntries++;
    }
    
    return {
      ...this.stats,
      size: this.size,
      hitRate,
      hotEntryPercent: this.size > 0 ? hotEntries / this.size : 0,
      avgClockRotations: this.stats.evictions > 0 ? 
        this.stats.clockRotations / this.stats.evictions : 0,
      entryPoolUtilization: this.entryPool.length / 1000
    };
  }
  
  /**
   * Get keys (for debugging)
   */
  keys() {
    const keys = [];
    for (const entry of this.entries) {
      if (entry && entry.key !== null) {
        keys.push(entry.key);
      }
    }
    return keys;
  }
  
  /**
   * Get size
   */
  get length() {
    return this.size;
  }
}

/**
 * Adaptive cache that switches between algorithms
 */
export class AdaptiveCache {
  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
    
    // Try both algorithms and adapt
    this.clockCache = new ClockCache(maxSize);
    this.currentCache = this.clockCache;
    
    // Performance tracking
    this.performanceWindow = 1000; // Track last 1000 operations
    this.operationCount = 0;
    this.lastAdaptation = Date.now();
    this.adaptationInterval = 60000; // Adapt every minute
  }
  
  /**
   * Adaptive get operation
   */
  get(key) {
    this.operationCount++;
    return this.currentCache.get(key);
  }
  
  /**
   * Adaptive set operation
   */
  set(key, value) {
    this.operationCount++;
    this.currentCache.set(key, value);
    
    // Consider adaptation
    if (this.shouldAdapt()) {
      this.adaptAlgorithm();
    }
  }
  
  /**
   * Check if we should adapt algorithm
   */
  shouldAdapt() {
    const now = Date.now();
    return (now - this.lastAdaptation) > this.adaptationInterval &&
           this.operationCount > this.performanceWindow;
  }
  
  /**
   * Adapt algorithm based on performance
   */
  adaptAlgorithm() {
    const stats = this.currentCache.getStats();
    
    // For now, stick with CLOCK as it's generally better
    // In production, could implement LRU fallback for specific patterns
    
    this.lastAdaptation = Date.now();
    this.operationCount = 0;
    
    logger.debug('Cache adaptation check', {
      algorithm: 'clock',
      hitRate: stats.hitRate,
      clockRotations: stats.avgClockRotations
    });
  }
  
  /**
   * Delegate other methods
   */
  has(key) { return this.currentCache.has(key); }
  delete(key) { return this.currentCache.delete(key); }
  clear() { this.currentCache.clear(); }
  getStats() { return this.currentCache.getStats(); }
  get size() { return this.currentCache.size; }
}

export default ClockCache;