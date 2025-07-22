/**
 * Advanced Caching Strategies for Otedama
 * Implements various caching patterns and optimizations
 * 
 * Design principles:
 * - Carmack: Predictive caching, minimal cache misses
 * - Martin: Strategy pattern for different cache behaviors
 * - Pike: Simple and effective caching rules
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

const logger = getLogger('CacheStrategies');

/**
 * Base caching strategy
 */
export class CacheStrategy {
  constructor(cache, options = {}) {
    this.cache = cache;
    this.options = options;
  }
  
  async get(key, options = {}) {
    return this.cache.get(key, options);
  }
  
  async set(key, value, options = {}) {
    return this.cache.set(key, value, options);
  }
  
  async delete(key) {
    return this.cache.delete(key);
  }
}

/**
 * Predictive caching strategy
 * Preloads related data based on access patterns
 */
export class PredictiveCacheStrategy extends CacheStrategy {
  constructor(cache, options = {}) {
    super(cache, options);
    
    this.accessPatterns = new Map();
    this.predictions = new Map();
    this.window = options.window || 300000; // 5 minutes
    this.minConfidence = options.minConfidence || 0.7;
    this.maxPredictions = options.maxPredictions || 10;
  }
  
  async get(key, options = {}) {
    // Record access pattern
    this._recordAccess(key);
    
    // Get the value
    const value = await super.get(key, options);
    
    // Predict and preload next likely keys
    if (value !== null) {
      this._predictAndPreload(key);
    }
    
    return value;
  }
  
  _recordAccess(key) {
    const now = Date.now();
    
    // Get or create pattern for this key
    if (!this.accessPatterns.has(key)) {
      this.accessPatterns.set(key, {
        accesses: [],
        following: new Map()
      });
    }
    
    const pattern = this.accessPatterns.get(key);
    pattern.accesses.push(now);
    
    // Clean old accesses
    pattern.accesses = pattern.accesses.filter(
      time => now - time < this.window
    );
    
    // Update following patterns
    for (const [prevKey, prevPattern] of this.accessPatterns) {
      if (prevKey === key) continue;
      
      const lastAccess = prevPattern.accesses[prevPattern.accesses.length - 1];
      if (lastAccess && now - lastAccess < 1000) { // Within 1 second
        const count = prevPattern.following.get(key) || 0;
        prevPattern.following.set(key, count + 1);
      }
    }
  }
  
  async _predictAndPreload(key) {
    const pattern = this.accessPatterns.get(key);
    if (!pattern || pattern.following.size === 0) return;
    
    // Calculate predictions
    const totalFollows = Array.from(pattern.following.values())
      .reduce((a, b) => a + b, 0);
    
    const predictions = [];
    for (const [followKey, count] of pattern.following) {
      const confidence = count / totalFollows;
      if (confidence >= this.minConfidence) {
        predictions.push({ key: followKey, confidence });
      }
    }
    
    // Sort by confidence
    predictions.sort((a, b) => b.confidence - a.confidence);
    
    // Preload top predictions
    const toPreload = predictions.slice(0, this.maxPredictions);
    
    for (const { key: predictedKey, confidence } of toPreload) {
      // Check if already in cache
      const exists = await this.cache.has(predictedKey);
      if (!exists && this.options.preloader) {
        // Preload in background
        this.options.preloader(predictedKey)
          .then(value => {
            if (value !== undefined) {
              this.cache.set(predictedKey, value, {
                metadata: { preloaded: true, confidence }
              });
            }
          })
          .catch(error => {
            logger.debug('Preload failed', { key: predictedKey, error });
          });
      }
    }
  }
}

/**
 * Adaptive TTL strategy
 * Adjusts TTL based on access frequency
 */
export class AdaptiveTTLStrategy extends CacheStrategy {
  constructor(cache, options = {}) {
    super(cache, options);
    
    this.minTTL = options.minTTL || 60000; // 1 minute
    this.maxTTL = options.maxTTL || 3600000; // 1 hour
    this.accessCounts = new Map();
    this.ttlMultiplier = options.ttlMultiplier || 1.5;
  }
  
  async get(key, options = {}) {
    // Track access
    const count = (this.accessCounts.get(key) || 0) + 1;
    this.accessCounts.set(key, count);
    
    return super.get(key, options);
  }
  
  async set(key, value, options = {}) {
    // Calculate adaptive TTL
    const accessCount = this.accessCounts.get(key) || 0;
    const adaptiveTTL = this._calculateTTL(accessCount);
    
    return super.set(key, value, {
      ...options,
      ttl: options.ttl || adaptiveTTL
    });
  }
  
  _calculateTTL(accessCount) {
    if (accessCount === 0) return this.minTTL;
    
    // Logarithmic scaling
    const ttl = this.minTTL * Math.pow(this.ttlMultiplier, Math.log2(accessCount + 1));
    
    return Math.min(Math.round(ttl), this.maxTTL);
  }
}

/**
 * Probabilistic cache invalidation
 * Uses probabilistic data structures for efficient invalidation
 */
export class ProbabilisticInvalidationStrategy extends CacheStrategy {
  constructor(cache, options = {}) {
    super(cache, options);
    
    this.bloomFilters = new Map();
    this.filterSize = options.filterSize || 10000;
    this.hashFunctions = options.hashFunctions || 3;
  }
  
  async set(key, value, options = {}) {
    await super.set(key, value, options);
    
    // Add to bloom filters for tags
    if (options.tags) {
      for (const tag of options.tags) {
        this._addToBloomFilter(tag, key);
      }
    }
  }
  
  async invalidateByTag(tag) {
    const filter = this.bloomFilters.get(tag);
    if (!filter) return 0;
    
    // Get all cache keys and check against bloom filter
    const keysToCheck = [];
    
    // This is a simplified approach - in production you'd iterate
    // through cache keys more efficiently
    for (const key of await this.cache.keys()) {
      if (this._mightContain(filter, key)) {
        keysToCheck.push(key);
      }
    }
    
    // Parallelize cache entry verification and deletion for better performance
    const deletePromises = keysToCheck.map(async (key) => {
      const entry = await this.cache.getEntry(key);
      if (entry && entry.tags && entry.tags.includes(tag)) {
        await this.cache.delete(key);
        return 1;
      }
      return 0;
    });

    const results = await Promise.all(deletePromises);
    const deleted = results.reduce((sum, count) => sum + count, 0);
    
    // Clear bloom filter
    this.bloomFilters.delete(tag);
    
    return deleted;
  }
  
  _addToBloomFilter(tag, key) {
    if (!this.bloomFilters.has(tag)) {
      this.bloomFilters.set(tag, new BloomFilter(
        this.filterSize,
        this.hashFunctions
      ));
    }
    
    this.bloomFilters.get(tag).add(key);
  }
  
  _mightContain(filter, key) {
    return filter.mightContain(key);
  }
}

/**
 * Simple Bloom Filter implementation
 */
class BloomFilter {
  constructor(size, hashFunctions) {
    this.size = size;
    this.hashFunctions = hashFunctions;
    this.bits = new Uint8Array(Math.ceil(size / 8));
  }
  
  add(item) {
    for (let i = 0; i < this.hashFunctions; i++) {
      const hash = this._hash(item, i);
      const index = hash % this.size;
      const byteIndex = Math.floor(index / 8);
      const bitIndex = index % 8;
      this.bits[byteIndex] |= (1 << bitIndex);
    }
  }
  
  mightContain(item) {
    for (let i = 0; i < this.hashFunctions; i++) {
      const hash = this._hash(item, i);
      const index = hash % this.size;
      const byteIndex = Math.floor(index / 8);
      const bitIndex = index % 8;
      
      if ((this.bits[byteIndex] & (1 << bitIndex)) === 0) {
        return false;
      }
    }
    return true;
  }
  
  _hash(item, seed) {
    // Simple hash function - in production use murmur3 or similar
    let hash = seed;
    const str = String(item);
    
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    return Math.abs(hash);
  }
}

/**
 * Geo-distributed cache strategy
 * Manages cache across multiple regions
 */
export class GeoDistributedCacheStrategy extends CacheStrategy {
  constructor(caches, options = {}) {
    super(null, options);
    
    this.caches = caches; // Map of region -> cache
    this.localRegion = options.localRegion || 'default';
    this.replicationFactor = options.replicationFactor || 2;
    this.consistencyLevel = options.consistencyLevel || 'eventual';
  }
  
  async get(key, options = {}) {
    const region = options.region || this.localRegion;
    
    // Try local region first
    const localCache = this.caches.get(region);
    if (localCache) {
      const value = await localCache.get(key, options);
      if (value !== null) return value;
    }
    
    // Try other regions
    for (const [otherRegion, cache] of this.caches) {
      if (otherRegion === region) continue;
      
      const value = await cache.get(key, options);
      if (value !== null) {
        // Replicate to local region
        if (localCache) {
          await localCache.set(key, value, options);
        }
        return value;
      }
    }
    
    return null;
  }
  
  async set(key, value, options = {}) {
    const region = options.region || this.localRegion;
    const replicas = this._selectReplicas(region);
    
    if (this.consistencyLevel === 'strong') {
      // Write to all replicas synchronously
      await Promise.all(
        replicas.map(cache => cache.set(key, value, options))
      );
    } else {
      // Write to local, replicate async
      const localCache = this.caches.get(region);
      if (localCache) {
        await localCache.set(key, value, options);
      }
      
      // Async replication
      for (const cache of replicas) {
        if (cache !== localCache) {
          cache.set(key, value, options).catch(error => {
            logger.error('Replication failed', { region, error });
          });
        }
      }
    }
  }
  
  async delete(key) {
    // Delete from all regions
    const deletes = [];
    
    for (const cache of this.caches.values()) {
      deletes.push(cache.delete(key));
    }
    
    if (this.consistencyLevel === 'strong') {
      await Promise.all(deletes);
    } else {
      // Delete from local, async from others
      const localCache = this.caches.get(this.localRegion);
      if (localCache) {
        await localCache.delete(key);
      }
    }
  }
  
  _selectReplicas(primaryRegion) {
    const replicas = [];
    const allCaches = Array.from(this.caches.entries());
    
    // Add primary region
    const primaryCache = this.caches.get(primaryRegion);
    if (primaryCache) {
      replicas.push(primaryCache);
    }
    
    // Add additional replicas
    const otherCaches = allCaches
      .filter(([region]) => region !== primaryRegion)
      .map(([_, cache]) => cache);
    
    // Simple selection - in production use geography/latency aware selection
    const additionalReplicas = otherCaches
      .slice(0, this.replicationFactor - 1);
    
    replicas.push(...additionalReplicas);
    
    return replicas;
  }
}

/**
 * Smart eviction strategy
 * Uses ML-like scoring for eviction decisions
 */
export class SmartEvictionStrategy extends CacheStrategy {
  constructor(cache, options = {}) {
    super(cache, options);
    
    this.weights = {
      recency: options.recencyWeight || 0.4,
      frequency: options.frequencyWeight || 0.3,
      size: options.sizeWeight || 0.2,
      cost: options.costWeight || 0.1
    };
    
    this.accessHistory = new Map();
    this.costEstimates = new Map();
  }
  
  async get(key, options = {}) {
    const startTime = Date.now();
    const value = await super.get(key, options);
    const cost = Date.now() - startTime;
    
    // Update access history
    if (!this.accessHistory.has(key)) {
      this.accessHistory.set(key, {
        count: 0,
        lastAccess: 0,
        totalCost: 0
      });
    }
    
    const history = this.accessHistory.get(key);
    history.count++;
    history.lastAccess = Date.now();
    history.totalCost += cost;
    
    return value;
  }
  
  async evictLRU(count) {
    const entries = await this.cache.entries();
    const scored = [];
    
    for (const [key, entry] of entries) {
      const score = this._calculateEvictionScore(key, entry);
      scored.push({ key, score });
    }
    
    // Sort by score (lower = more likely to evict)
    scored.sort((a, b) => a.score - b.score);
    
    // Evict lowest scoring entries
    const toEvict = scored.slice(0, count);
    
    for (const { key } of toEvict) {
      await this.cache.delete(key);
    }
    
    return toEvict.length;
  }
  
  _calculateEvictionScore(key, entry) {
    const now = Date.now();
    const history = this.accessHistory.get(key) || {
      count: 0,
      lastAccess: entry.createdAt,
      totalCost: 0
    };
    
    // Recency score (exponential decay)
    const age = now - history.lastAccess;
    const recencyScore = Math.exp(-age / 3600000); // 1 hour half-life
    
    // Frequency score (logarithmic)
    const frequencyScore = Math.log2(history.count + 1) / 10;
    
    // Size score (inverse, smaller is better)
    const size = JSON.stringify(entry.value).length;
    const sizeScore = 1 / (1 + size / 1000);
    
    // Cost score (average regeneration cost)
    const avgCost = history.count > 0 ? 
      history.totalCost / history.count : 100;
    const costScore = Math.min(avgCost / 1000, 1);
    
    // Weighted combination
    return (
      this.weights.recency * recencyScore +
      this.weights.frequency * frequencyScore +
      this.weights.size * sizeScore +
      this.weights.cost * costScore
    );
  }
}

/**
 * Create a cache with a specific strategy
 */
export function createCacheWithStrategy(baseCache, strategyType, options = {}) {
  switch (strategyType) {
    case 'predictive':
      return new PredictiveCacheStrategy(baseCache, options);
      
    case 'adaptiveTTL':
      return new AdaptiveTTLStrategy(baseCache, options);
      
    case 'probabilistic':
      return new ProbabilisticInvalidationStrategy(baseCache, options);
      
    case 'geodistributed':
      return new GeoDistributedCacheStrategy(baseCache, options);
      
    case 'smartEviction':
      return new SmartEvictionStrategy(baseCache, options);
      
    default:
      return baseCache;
  }
}

export default {
  CacheStrategy,
  PredictiveCacheStrategy,
  AdaptiveTTLStrategy,
  ProbabilisticInvalidationStrategy,
  GeoDistributedCacheStrategy,
  SmartEvictionStrategy,
  createCacheWithStrategy
};