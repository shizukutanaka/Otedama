/**
 * Advanced Caching System for Otedama
 * Multi-tier caching with intelligent eviction and prefetching
 */

import { EventEmitter } from 'events';
import { getErrorHandler, OtedamaError, ErrorCategory, safeExecute } from '../core/standardized-error-handler.js';

// Cache tiers
export const CacheTierType = {
  L1: 'l1',     // In-memory, fastest access
  L2: 'l2',     // Compressed in-memory
  L3: 'l3',     // Persistent storage
  REMOTE: 'remote' // Distributed cache
};

// Eviction policies
export const EvictionPolicy = {
  LRU: 'lru',           // Least Recently Used
  LFU: 'lfu',           // Least Frequently Used
  FIFO: 'fifo',         // First In, First Out
  TTL: 'ttl',           // Time To Live
  ADAPTIVE: 'adaptive'   // Adaptive based on access patterns
};

// Cache entry states
export const CacheState = {
  FRESH: 'fresh',
  STALE: 'stale',
  EXPIRED: 'expired',
  LOADING: 'loading',
  ERROR: 'error'
};

export class AdvancedCachingSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Tier configurations
      tiers: {
        l1: {
          maxSize: options.l1MaxSize || 1000,
          maxMemory: options.l1MaxMemory || 100 * 1024 * 1024, // 100MB
          ttl: options.l1TTL || 300000, // 5 minutes
          evictionPolicy: EvictionPolicy.LRU
        },
        l2: {
          maxSize: options.l2MaxSize || 10000,
          maxMemory: options.l2MaxMemory || 500 * 1024 * 1024, // 500MB
          ttl: options.l2TTL || 3600000, // 1 hour
          evictionPolicy: EvictionPolicy.LFU,
          compressionEnabled: true
        },
        l3: {
          maxSize: options.l3MaxSize || 100000,
          maxMemory: options.l3MaxMemory || 2 * 1024 * 1024 * 1024, // 2GB
          ttl: options.l3TTL || 86400000, // 24 hours
          evictionPolicy: EvictionPolicy.ADAPTIVE,
          persistentStorage: true
        }
      },
      
      // Prefetching settings
      prefetchingEnabled: options.prefetchingEnabled !== false,
      prefetchThreshold: options.prefetchThreshold || 0.8,
      maxPrefetchSize: options.maxPrefetchSize || 100,
      
      // Performance settings
      batchSize: options.batchSize || 100,
      compressionThreshold: options.compressionThreshold || 1024,
      
      // Monitoring
      metricsEnabled: options.metricsEnabled !== false,
      metricsInterval: options.metricsInterval || 60000,
      
      ...options
    };
    
    this.tiers = new Map();
    this.metrics = {
      hits: { l1: 0, l2: 0, l3: 0, total: 0 },
      misses: { l1: 0, l2: 0, l3: 0, total: 0 },
      evictions: { l1: 0, l2: 0, l3: 0, total: 0 },
      prefetches: 0,
      compressions: 0,
      decompressions: 0,
      memoryUsage: { l1: 0, l2: 0, l3: 0, total: 0 },
      operations: {
        get: 0,
        set: 0,
        delete: 0,
        clear: 0
      }
    };
    
    this.accessPatterns = new Map();
    this.prefetchQueue = new Set();
    this.timers = new Map();
    this.errorHandler = getErrorHandler();
    
    this.initializeTiers();
    this.startMetricsCollection();
  }
  
  /**
   * Initialize cache tiers
   */
  initializeTiers() {
    for (const [tierName, config] of Object.entries(this.options.tiers)) {
      this.tiers.set(tierName, new CacheTier(tierName, config));
    }
  }
  
  /**
   * Start metrics collection
   */
  startMetricsCollection() {
    if (!this.options.metricsEnabled) return;
    
    const metricsTimer = setInterval(() => {
      this.collectMetrics();
      this.emit('metrics', this.getMetrics());
    }, this.options.metricsInterval);
    
    this.timers.set('metrics', metricsTimer);
  }
  
  /**
   * Get value from cache with tier promotion
   */
  async get(key, options = {}) {
    this.metrics.operations.get++;
    
    try {
      // Check each tier in order
      for (const [tierName, tier] of this.tiers) {
        const entry = await tier.get(key);
        
        if (entry) {
          this.metrics.hits[tierName]++;
          this.metrics.hits.total++;
          
          // Record access pattern
          this.recordAccess(key, tierName);
          
          // Promote to higher tier if beneficial
          if (tierName !== 'l1' && this.shouldPromote(key, tierName)) {
            await this.promote(key, entry, tierName);
          }
          
          // Trigger prefetching if enabled
          if (this.options.prefetchingEnabled) {
            this.triggerPrefetch(key);
          }
          
          return entry.value;
        } else {
          this.metrics.misses[tierName]++;
        }
      }
      
      this.metrics.misses.total++;
      return null;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'cache_get',
        key,
        category: ErrorCategory.CACHE
      });
      return null;
    }
  }
  
  /**
   * Set value in cache with intelligent tier placement
   */
  async set(key, value, options = {}) {
    this.metrics.operations.set++;
    
    try {
      const entry = {
        key,
        value,
        timestamp: Date.now(),
        accessCount: 1,
        lastAccess: Date.now(),
        size: this.calculateSize(value),
        ttl: options.ttl,
        metadata: options.metadata || {}
      };
      
      // Determine optimal tier for initial placement
      const targetTier = this.determineOptimalTier(entry);
      
      // Set in target tier
      await this.tiers.get(targetTier).set(key, entry);
      
      // Record access pattern
      this.recordAccess(key, targetTier);
      
      this.emit('set', { key, tier: targetTier, size: entry.size });
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'cache_set',
        key,
        category: ErrorCategory.CACHE
      });
    }
  }
  
  /**
   * Delete value from all tiers
   */
  async delete(key) {
    this.metrics.operations.delete++;
    
    try {
      let deleted = false;
      
      for (const [tierName, tier] of this.tiers) {
        const result = await tier.delete(key);
        if (result) deleted = true;
      }
      
      // Remove from access patterns
      this.accessPatterns.delete(key);
      this.prefetchQueue.delete(key);
      
      this.emit('delete', { key, deleted });
      return deleted;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'cache_delete',
        key,
        category: ErrorCategory.CACHE
      });
      return false;
    }
  }
  
  /**
   * Clear all tiers
   */
  async clear() {
    this.metrics.operations.clear++;
    
    try {
      for (const [tierName, tier] of this.tiers) {
        await tier.clear();
      }
      
      this.accessPatterns.clear();
      this.prefetchQueue.clear();
      
      this.emit('clear');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'cache_clear',
        category: ErrorCategory.CACHE
      });
    }
  }
  
  /**
   * Determine optimal tier for entry
   */
  determineOptimalTier(entry) {
    const { size, accessCount, metadata } = entry;
    
    // High-frequency, small items go to L1
    if (accessCount > 10 && size < 1024) {
      return 'l1';
    }
    
    // Medium-frequency items go to L2
    if (accessCount > 3 && size < 10240) {
      return 'l2';
    }
    
    // Large or infrequent items go to L3
    return 'l3';
  }
  
  /**
   * Check if entry should be promoted to higher tier
   */
  shouldPromote(key, currentTier) {
    const pattern = this.accessPatterns.get(key);
    if (!pattern) return false;
    
    const recentAccesses = pattern.accesses.slice(-10);
    const accessFrequency = recentAccesses.length / 10;
    
    // Promote if frequently accessed
    if (currentTier === 'l3' && accessFrequency > 0.5) return true;
    if (currentTier === 'l2' && accessFrequency > 0.8) return true;
    
    return false;
  }
  
  /**
   * Promote entry to higher tier
   */
  async promote(key, entry, fromTier) {
    try {
      let targetTier;
      
      if (fromTier === 'l3') targetTier = 'l2';
      else if (fromTier === 'l2') targetTier = 'l1';
      else return; // Already in highest tier
      
      await this.tiers.get(targetTier).set(key, entry);
      
      this.emit('promote', { key, fromTier, targetTier });
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'cache_promote',
        key,
        fromTier,
        category: ErrorCategory.CACHE
      });
    }
  }
  
  /**
   * Record access pattern
   */
  recordAccess(key, tier) {
    if (!this.accessPatterns.has(key)) {
      this.accessPatterns.set(key, {
        accesses: [],
        tiers: new Set(),
        totalAccesses: 0
      });
    }
    
    const pattern = this.accessPatterns.get(key);
    pattern.accesses.push({ timestamp: Date.now(), tier });
    pattern.tiers.add(tier);
    pattern.totalAccesses++;
    
    // Keep only recent accesses
    if (pattern.accesses.length > 100) {
      pattern.accesses.shift();
    }
  }
  
  /**
   * Trigger prefetching based on access patterns
   */
  triggerPrefetch(key) {
    if (this.prefetchQueue.size >= this.options.maxPrefetchSize) return;
    
    const pattern = this.accessPatterns.get(key);
    if (!pattern) return;
    
    // Simple prefetch strategy: prefetch related keys
    const relatedKeys = this.findRelatedKeys(key, pattern);
    
    for (const relatedKey of relatedKeys) {
      if (!this.prefetchQueue.has(relatedKey)) {
        this.prefetchQueue.add(relatedKey);
        this.schedulePrefetch(relatedKey);
      }
    }
  }
  
  /**
   * Find related keys for prefetching
   */
  findRelatedKeys(key, pattern) {
    // Simple implementation: keys with similar access patterns
    const relatedKeys = [];
    
    for (const [otherKey, otherPattern] of this.accessPatterns) {
      if (otherKey === key) continue;
      
      const similarity = this.calculatePatternSimilarity(pattern, otherPattern);
      if (similarity > 0.7) {
        relatedKeys.push(otherKey);
      }
    }
    
    return relatedKeys.slice(0, 5); // Limit to 5 related keys
  }
  
  /**
   * Calculate pattern similarity
   */
  calculatePatternSimilarity(pattern1, pattern2) {
    const tiers1 = Array.from(pattern1.tiers);
    const tiers2 = Array.from(pattern2.tiers);
    
    const intersection = tiers1.filter(tier => tiers2.includes(tier));
    const union = [...new Set([...tiers1, ...tiers2])];
    
    return intersection.length / union.length;
  }
  
  /**
   * Schedule prefetch operation
   */
  schedulePrefetch(key) {
    setTimeout(async () => {
      try {
        // Check if key is already in cache
        const cached = await this.get(key);
        if (!cached) {
          // Emit prefetch request
          this.emit('prefetch', { key });
          this.metrics.prefetches++;
        }
        
        this.prefetchQueue.delete(key);
        
      } catch (error) {
        this.errorHandler.handleError(error, {
          context: 'cache_prefetch',
          key,
          category: ErrorCategory.CACHE
        });
      }
    }, 100);
  }
  
  /**
   * Calculate size of value
   */
  calculateSize(value) {
    if (typeof value === 'string') {
      return value.length * 2; // Approximate UTF-16 size
    } else if (typeof value === 'object') {
      return JSON.stringify(value).length * 2;
    } else {
      return 8; // Approximate size for primitives
    }
  }
  
  /**
   * Collect metrics from all tiers
   */
  collectMetrics() {
    let totalMemory = 0;
    
    for (const [tierName, tier] of this.tiers) {
      const tierMetrics = tier.getMetrics();
      this.metrics.memoryUsage[tierName] = tierMetrics.memoryUsage;
      totalMemory += tierMetrics.memoryUsage;
    }
    
    this.metrics.memoryUsage.total = totalMemory;
  }
  
  /**
   * Get comprehensive metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      hitRatio: {
        l1: this.metrics.hits.l1 / (this.metrics.hits.l1 + this.metrics.misses.l1) || 0,
        l2: this.metrics.hits.l2 / (this.metrics.hits.l2 + this.metrics.misses.l2) || 0,
        l3: this.metrics.hits.l3 / (this.metrics.hits.l3 + this.metrics.misses.l3) || 0,
        total: this.metrics.hits.total / (this.metrics.hits.total + this.metrics.misses.total) || 0
      },
      accessPatterns: this.accessPatterns.size,
      prefetchQueueSize: this.prefetchQueue.size
    };
  }
  
  /**
   * Get cache statistics
   */
  getStatistics() {
    const stats = {
      tiers: {},
      overall: this.getMetrics()
    };
    
    for (const [tierName, tier] of this.tiers) {
      stats.tiers[tierName] = tier.getStatistics();
    }
    
    return stats;
  }
  
  /**
   * Cleanup resources
   */
  cleanup() {
    // Clear all timers
    for (const [name, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    
    // Cleanup tiers
    for (const [tierName, tier] of this.tiers) {
      tier.cleanup();
    }
    
    // Clear data structures
    this.accessPatterns.clear();
    this.prefetchQueue.clear();
    
    // Remove all listeners
    this.removeAllListeners();
  }
}

/**
 * Individual Cache Tier Implementation
 */
class CacheTier {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.storage = new Map();
    this.accessOrder = new Map(); // For LRU
    this.accessCount = new Map(); // For LFU
    this.memoryUsage = 0;
    
    this.setupEvictionTimer();
  }
  
  /**
   * Setup eviction timer
   */
  setupEvictionTimer() {
    if (this.config.ttl) {
      this.evictionTimer = setInterval(() => {
        this.evictExpired();
      }, this.config.ttl / 10);
    }
  }
  
  /**
   * Get entry from tier
   */
  async get(key) {
    const entry = this.storage.get(key);
    
    if (!entry) return null;
    
    // Check TTL
    if (this.isExpired(entry)) {
      this.storage.delete(key);
      this.updateMemoryUsage(-entry.size);
      return null;
    }
    
    // Update access tracking
    this.updateAccessTracking(key);
    
    return entry;
  }
  
  /**
   * Set entry in tier
   */
  async set(key, entry) {
    // Check if we need to evict
    if (this.needsEviction(entry.size)) {
      await this.evict(entry.size);
    }
    
    // Store entry
    this.storage.set(key, entry);
    this.updateMemoryUsage(entry.size);
    this.updateAccessTracking(key);
  }
  
  /**
   * Delete entry from tier
   */
  async delete(key) {
    const entry = this.storage.get(key);
    if (!entry) return false;
    
    this.storage.delete(key);
    this.accessOrder.delete(key);
    this.accessCount.delete(key);
    this.updateMemoryUsage(-entry.size);
    
    return true;
  }
  
  /**
   * Clear all entries
   */
  async clear() {
    this.storage.clear();
    this.accessOrder.clear();
    this.accessCount.clear();
    this.memoryUsage = 0;
  }
  
  /**
   * Check if entry is expired
   */
  isExpired(entry) {
    if (!entry.ttl && !this.config.ttl) return false;
    
    const ttl = entry.ttl || this.config.ttl;
    return Date.now() - entry.timestamp > ttl;
  }
  
  /**
   * Check if eviction is needed
   */
  needsEviction(newEntrySize) {
    return (
      this.storage.size >= this.config.maxSize ||
      this.memoryUsage + newEntrySize > this.config.maxMemory
    );
  }
  
  /**
   * Evict entries based on policy
   */
  async evict(requiredSpace) {
    const evictedKeys = [];
    
    while (this.needsEviction(requiredSpace) && this.storage.size > 0) {
      const keyToEvict = this.selectEvictionCandidate();
      if (!keyToEvict) break;
      
      await this.delete(keyToEvict);
      evictedKeys.push(keyToEvict);
    }
    
    return evictedKeys;
  }
  
  /**
   * Select eviction candidate based on policy
   */
  selectEvictionCandidate() {
    switch (this.config.evictionPolicy) {
      case EvictionPolicy.LRU:
        return this.selectLRUCandidate();
      case EvictionPolicy.LFU:
        return this.selectLFUCandidate();
      case EvictionPolicy.FIFO:
        return this.selectFIFOCandidate();
      case EvictionPolicy.TTL:
        return this.selectTTLCandidate();
      case EvictionPolicy.ADAPTIVE:
        return this.selectAdaptiveCandidate();
      default:
        return this.selectLRUCandidate();
    }
  }
  
  /**
   * Select LRU candidate
   */
  selectLRUCandidate() {
    let oldestKey = null;
    let oldestTime = Infinity;
    
    for (const [key, time] of this.accessOrder) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }
    
    return oldestKey;
  }
  
  /**
   * Select LFU candidate
   */
  selectLFUCandidate() {
    let leastUsedKey = null;
    let leastCount = Infinity;
    
    for (const [key, count] of this.accessCount) {
      if (count < leastCount) {
        leastCount = count;
        leastUsedKey = key;
      }
    }
    
    return leastUsedKey;
  }
  
  /**
   * Select FIFO candidate
   */
  selectFIFOCandidate() {
    return this.storage.keys().next().value;
  }
  
  /**
   * Select TTL candidate
   */
  selectTTLCandidate() {
    let expiredKey = null;
    let earliestExpiry = Infinity;
    
    for (const [key, entry] of this.storage) {
      const expiryTime = entry.timestamp + (entry.ttl || this.config.ttl);
      if (expiryTime < earliestExpiry) {
        earliestExpiry = expiryTime;
        expiredKey = key;
      }
    }
    
    return expiredKey;
  }
  
  /**
   * Select adaptive candidate
   */
  selectAdaptiveCandidate() {
    // Combine LRU and LFU with weights
    const lruCandidate = this.selectLRUCandidate();
    const lfuCandidate = this.selectLFUCandidate();
    
    // Simple adaptive strategy: prefer LFU for high-frequency access patterns
    const avgAccessCount = Array.from(this.accessCount.values()).reduce((a, b) => a + b, 0) / this.accessCount.size;
    
    return avgAccessCount > 5 ? lfuCandidate : lruCandidate;
  }
  
  /**
   * Evict expired entries
   */
  evictExpired() {
    const now = Date.now();
    const expiredKeys = [];
    
    for (const [key, entry] of this.storage) {
      if (this.isExpired(entry)) {
        expiredKeys.push(key);
      }
    }
    
    for (const key of expiredKeys) {
      this.delete(key);
    }
  }
  
  /**
   * Update access tracking
   */
  updateAccessTracking(key) {
    this.accessOrder.set(key, Date.now());
    this.accessCount.set(key, (this.accessCount.get(key) || 0) + 1);
  }
  
  /**
   * Update memory usage
   */
  updateMemoryUsage(delta) {
    this.memoryUsage += delta;
  }
  
  /**
   * Get tier metrics
   */
  getMetrics() {
    return {
      size: this.storage.size,
      memoryUsage: this.memoryUsage,
      maxSize: this.config.maxSize,
      maxMemory: this.config.maxMemory,
      utilizationRatio: this.storage.size / this.config.maxSize,
      memoryUtilizationRatio: this.memoryUsage / this.config.maxMemory
    };
  }
  
  /**
   * Get tier statistics
   */
  getStatistics() {
    return {
      ...this.getMetrics(),
      evictionPolicy: this.config.evictionPolicy,
      ttl: this.config.ttl,
      compressionEnabled: this.config.compressionEnabled,
      persistentStorage: this.config.persistentStorage
    };
  }
  
  /**
   * Cleanup tier resources
   */
  cleanup() {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
    }
    
    this.storage.clear();
    this.accessOrder.clear();
    this.accessCount.clear();
  }
}

export default AdvancedCachingSystem;
