/**
 * Adaptive Memory Pool - Otedama
 * Self-adjusting memory pools for optimal performance
 * 
 * Features:
 * - Dynamic pool sizing based on usage patterns
 * - Memory pressure adaptation
 * - NUMA-aware allocation
 * - Predictive pre-allocation
 * - Garbage collection coordination
 */

import v8 from 'v8';
import { performance } from 'perf_hooks';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('AdaptiveMemoryPool');

/**
 * Usage pattern analyzer
 */
class UsagePatternAnalyzer {
  constructor(windowSize = 1000) {
    this.windowSize = windowSize;
    this.allocations = [];
    this.deallocations = [];
    this.patterns = {
      peakUsage: 0,
      avgUsage: 0,
      burstiness: 0,
      trend: 0,
      seasonality: []
    };
  }
  
  /**
   * Record allocation
   */
  recordAllocation(size, timestamp = Date.now()) {
    this.allocations.push({ size, timestamp });
    
    // Maintain window
    const cutoff = timestamp - this.windowSize * 1000;
    this.allocations = this.allocations.filter(a => a.timestamp > cutoff);
    
    this.updatePatterns();
  }
  
  /**
   * Record deallocation
   */
  recordDeallocation(size, timestamp = Date.now()) {
    this.deallocations.push({ size, timestamp });
    
    // Maintain window
    const cutoff = timestamp - this.windowSize * 1000;
    this.deallocations = this.deallocations.filter(d => d.timestamp > cutoff);
  }
  
  /**
   * Update usage patterns
   */
  updatePatterns() {
    if (this.allocations.length < 10) return;
    
    // Calculate current usage
    const totalAllocated = this.allocations.reduce((sum, a) => sum + a.size, 0);
    const totalDeallocated = this.deallocations.reduce((sum, d) => sum + d.size, 0);
    const currentUsage = totalAllocated - totalDeallocated;
    
    // Update peak
    this.patterns.peakUsage = Math.max(this.patterns.peakUsage, currentUsage);
    
    // Calculate average
    this.patterns.avgUsage = currentUsage;
    
    // Calculate burstiness (coefficient of variation)
    const sizes = this.allocations.map(a => a.size);
    const mean = sizes.reduce((a, b) => a + b) / sizes.length;
    const variance = sizes.reduce((sum, size) => sum + Math.pow(size - mean, 2), 0) / sizes.length;
    this.patterns.burstiness = Math.sqrt(variance) / mean;
    
    // Calculate trend
    this.patterns.trend = this.calculateTrend();
    
    // Detect seasonality
    this.detectSeasonality();
  }
  
  /**
   * Calculate allocation trend
   */
  calculateTrend() {
    const buckets = this.createTimeBuckets(60); // 1-minute buckets
    if (buckets.length < 5) return 0;
    
    // Linear regression on bucket sizes
    const x = buckets.map((_, i) => i);
    const y = buckets.map(b => b.total);
    
    const n = buckets.length;
    const sumX = x.reduce((a, b) => a + b);
    const sumY = y.reduce((a, b) => a + b);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    
    return slope;
  }
  
  /**
   * Create time buckets
   */
  createTimeBuckets(bucketSize) {
    const buckets = [];
    if (this.allocations.length === 0) return buckets;
    
    const startTime = this.allocations[0].timestamp;
    const endTime = this.allocations[this.allocations.length - 1].timestamp;
    
    for (let time = startTime; time <= endTime; time += bucketSize * 1000) {
      const bucket = {
        start: time,
        end: time + bucketSize * 1000,
        count: 0,
        total: 0
      };
      
      for (const alloc of this.allocations) {
        if (alloc.timestamp >= bucket.start && alloc.timestamp < bucket.end) {
          bucket.count++;
          bucket.total += alloc.size;
        }
      }
      
      buckets.push(bucket);
    }
    
    return buckets;
  }
  
  /**
   * Detect seasonal patterns
   */
  detectSeasonality() {
    // Simple hourly pattern detection
    const hourlyBuckets = Array(24).fill(0).map(() => ({ count: 0, total: 0 }));
    
    for (const alloc of this.allocations) {
      const hour = new Date(alloc.timestamp).getHours();
      hourlyBuckets[hour].count++;
      hourlyBuckets[hour].total += alloc.size;
    }
    
    this.patterns.seasonality = hourlyBuckets.map(b => 
      b.count > 0 ? b.total / b.count : 0
    );
  }
  
  /**
   * Predict future usage
   */
  predictUsage(futureMinutes = 5) {
    const baseUsage = this.patterns.avgUsage;
    const trendAdjustment = this.patterns.trend * futureMinutes;
    
    // Add seasonal adjustment
    const currentHour = new Date().getHours();
    const targetHour = (currentHour + Math.floor(futureMinutes / 60)) % 24;
    const seasonalFactor = this.patterns.seasonality[targetHour] / 
                          (this.patterns.seasonality[currentHour] || 1);
    
    // Add burst buffer
    const burstBuffer = this.patterns.burstiness * baseUsage;
    
    return Math.max(0, baseUsage + trendAdjustment) * seasonalFactor + burstBuffer;
  }
}

/**
 * NUMA-aware allocator
 */
class NUMAAllocator {
  constructor() {
    this.nodes = this.detectNUMANodes();
    this.currentNode = 0;
  }
  
  /**
   * Detect NUMA nodes (simplified)
   */
  detectNUMANodes() {
    // In production, use libnuma or similar
    const cpuCount = require('os').cpus().length;
    
    // Assume 2 NUMA nodes for >8 CPUs
    if (cpuCount > 8) {
      return [
        { id: 0, cpus: Array(cpuCount / 2).fill(0).map((_, i) => i) },
        { id: 1, cpus: Array(cpuCount / 2).fill(0).map((_, i) => i + cpuCount / 2) }
      ];
    }
    
    // Single NUMA node
    return [{ id: 0, cpus: Array(cpuCount).fill(0).map((_, i) => i) }];
  }
  
  /**
   * Get preferred NUMA node
   */
  getPreferredNode() {
    // Round-robin for now
    const node = this.nodes[this.currentNode];
    this.currentNode = (this.currentNode + 1) % this.nodes.length;
    return node;
  }
  
  /**
   * Allocate on specific NUMA node
   */
  allocate(size, nodeId) {
    // In production, use numa_alloc_onnode
    // For now, just allocate normally
    return Buffer.allocUnsafe(size);
  }
}

/**
 * Adaptive memory pool
 */
export class AdaptiveMemoryPool {
  constructor(objectFactory, options = {}) {
    this.objectFactory = objectFactory;
    this.name = options.name || 'unnamed';
    
    // Pool configuration
    this.minSize = options.minSize || 10;
    this.maxSize = options.maxSize || 10000;
    this.initialSize = options.initialSize || 100;
    
    // Pool storage
    this.available = [];
    this.inUse = new Set();
    this.totalCreated = 0;
    
    // Adaptation parameters
    this.adaptationInterval = options.adaptationInterval || 5000; // 5 seconds
    this.growthFactor = 1.5;
    this.shrinkFactor = 0.8;
    
    // Usage tracking
    this.usageAnalyzer = new UsagePatternAnalyzer();
    this.lastAdaptation = Date.now();
    
    // NUMA support
    this.numaAllocator = new NUMAAllocator();
    
    // Statistics
    this.stats = {
      acquisitions: 0,
      releases: 0,
      hits: 0,
      misses: 0,
      adaptations: 0,
      currentSize: 0
    };
    
    // Initialize pool
    this.initialize();
  }
  
  /**
   * Initialize pool with objects
   */
  initialize() {
    for (let i = 0; i < this.initialSize; i++) {
      this.available.push(this.createObject());
    }
    
    this.stats.currentSize = this.initialSize;
    
    // Start adaptation timer
    this.adaptationTimer = setInterval(() => this.adapt(), this.adaptationInterval);
    
    logger.info(`Adaptive memory pool ${this.name} initialized`, {
      initialSize: this.initialSize,
      minSize: this.minSize,
      maxSize: this.maxSize
    });
  }
  
  /**
   * Create new object
   */
  createObject() {
    this.totalCreated++;
    const obj = this.objectFactory();
    
    // Track object metadata
    obj._poolMetadata = {
      createdAt: Date.now(),
      lastUsed: Date.now(),
      useCount: 0,
      numaNode: this.numaAllocator.getPreferredNode().id
    };
    
    return obj;
  }
  
  /**
   * Acquire object from pool
   */
  acquire() {
    this.stats.acquisitions++;
    
    let obj;
    
    if (this.available.length > 0) {
      // Get from pool
      obj = this.available.pop();
      this.stats.hits++;
    } else {
      // Create new if under limit
      if (this.totalCreated < this.maxSize) {
        obj = this.createObject();
        this.stats.misses++;
      } else {
        // Pool exhausted
        logger.warn(`Memory pool ${this.name} exhausted`);
        return null;
      }
    }
    
    // Update metadata
    obj._poolMetadata.lastUsed = Date.now();
    obj._poolMetadata.useCount++;
    
    this.inUse.add(obj);
    this.usageAnalyzer.recordAllocation(1);
    
    return obj;
  }
  
  /**
   * Release object back to pool
   */
  release(obj) {
    if (!this.inUse.has(obj)) {
      logger.warn(`Attempting to release object not from pool ${this.name}`);
      return;
    }
    
    this.stats.releases++;
    this.inUse.delete(obj);
    
    // Reset object state if needed
    if (obj.reset && typeof obj.reset === 'function') {
      obj.reset();
    }
    
    // Add back to available pool
    this.available.push(obj);
    this.usageAnalyzer.recordDeallocation(1);
  }
  
  /**
   * Adapt pool size based on usage
   */
  adapt() {
    const now = Date.now();
    if (now - this.lastAdaptation < this.adaptationInterval) return;
    
    this.stats.adaptations++;
    this.lastAdaptation = now;
    
    // Get current usage metrics
    const usage = {
      current: this.inUse.size,
      available: this.available.length,
      total: this.inUse.size + this.available.length,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses)
    };
    
    // Get predicted usage
    const predictedUsage = this.usageAnalyzer.predictUsage(5);
    
    // Get memory pressure
    const memoryPressure = this.getMemoryPressure();
    
    // Determine target size
    let targetSize = Math.ceil(predictedUsage * 1.2); // 20% buffer
    
    // Adjust for memory pressure
    if (memoryPressure > 0.8) {
      targetSize = Math.min(targetSize, usage.current * 1.1);
    }
    
    // Clamp to limits
    targetSize = Math.max(this.minSize, Math.min(this.maxSize, targetSize));
    
    // Grow or shrink
    if (targetSize > usage.total) {
      this.grow(targetSize - usage.total);
    } else if (targetSize < usage.total && usage.available > targetSize * 0.5) {
      this.shrink(usage.total - targetSize);
    }
    
    logger.debug(`Pool ${this.name} adapted`, {
      currentSize: usage.total,
      targetSize,
      predictedUsage,
      memoryPressure
    });
  }
  
  /**
   * Grow pool
   */
  grow(count) {
    const toAdd = Math.min(count, this.maxSize - this.totalCreated);
    
    for (let i = 0; i < toAdd; i++) {
      this.available.push(this.createObject());
    }
    
    this.stats.currentSize += toAdd;
    
    logger.info(`Pool ${this.name} grew by ${toAdd} objects`);
  }
  
  /**
   * Shrink pool
   */
  shrink(count) {
    const toRemove = Math.min(count, this.available.length);
    
    // Remove oldest objects first
    const removed = this.available
      .sort((a, b) => a._poolMetadata.lastUsed - b._poolMetadata.lastUsed)
      .splice(0, toRemove);
    
    this.stats.currentSize -= removed.length;
    this.totalCreated -= removed.length;
    
    // Allow GC to collect
    removed.forEach(obj => {
      delete obj._poolMetadata;
    });
    
    logger.info(`Pool ${this.name} shrunk by ${removed.length} objects`);
  }
  
  /**
   * Get memory pressure
   */
  getMemoryPressure() {
    const heapStats = v8.getHeapStatistics();
    return heapStats.used_heap_size / heapStats.heap_size_limit;
  }
  
  /**
   * Pre-warm pool based on predictions
   */
  async prewarm() {
    const predictedUsage = this.usageAnalyzer.predictUsage(1);
    const currentTotal = this.inUse.size + this.available.length;
    
    if (predictedUsage > currentTotal) {
      this.grow(Math.ceil(predictedUsage - currentTotal));
    }
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    const usage = {
      inUse: this.inUse.size,
      available: this.available.length,
      total: this.inUse.size + this.available.length
    };
    
    return {
      ...this.stats,
      ...usage,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses || 1),
      utilization: usage.inUse / usage.total,
      patterns: this.usageAnalyzer.patterns
    };
  }
  
  /**
   * Clear pool
   */
  clear() {
    // Clear in-use tracking
    this.inUse.clear();
    
    // Clear available objects
    this.available = [];
    
    this.totalCreated = 0;
    this.stats.currentSize = 0;
    
    logger.info(`Pool ${this.name} cleared`);
  }
  
  /**
   * Destroy pool
   */
  destroy() {
    if (this.adaptationTimer) {
      clearInterval(this.adaptationTimer);
    }
    
    this.clear();
    
    logger.info(`Pool ${this.name} destroyed`);
  }
}

/**
 * Pool manager for multiple pools
 */
export class MemoryPoolManager {
  constructor() {
    this.pools = new Map();
    this.globalStats = {
      totalObjects: 0,
      totalMemory: 0,
      gcCount: 0,
      lastGC: 0
    };
    
    // Monitor GC
    this.setupGCMonitoring();
  }
  
  /**
   * Create or get pool
   */
  getPool(name, factory, options) {
    if (!this.pools.has(name)) {
      const pool = new AdaptiveMemoryPool(factory, { ...options, name });
      this.pools.set(name, pool);
    }
    
    return this.pools.get(name);
  }
  
  /**
   * Setup GC monitoring
   */
  setupGCMonitoring() {
    if (global.gc) {
      const originalGC = global.gc;
      
      global.gc = (...args) => {
        this.globalStats.gcCount++;
        this.globalStats.lastGC = Date.now();
        
        // Notify pools of GC
        for (const pool of this.pools.values()) {
          pool.adapt();
        }
        
        return originalGC.apply(this, args);
      };
    }
  }
  
  /**
   * Get global statistics
   */
  getGlobalStats() {
    let totalObjects = 0;
    let totalInUse = 0;
    const poolStats = {};
    
    for (const [name, pool] of this.pools) {
      const stats = pool.getStats();
      poolStats[name] = stats;
      totalObjects += stats.total;
      totalInUse += stats.inUse;
    }
    
    const heapStats = v8.getHeapStatistics();
    
    return {
      ...this.globalStats,
      pools: poolStats,
      totalObjects,
      totalInUse,
      heap: {
        used: heapStats.used_heap_size,
        total: heapStats.total_heap_size,
        limit: heapStats.heap_size_limit,
        pressure: heapStats.used_heap_size / heapStats.heap_size_limit
      }
    };
  }
  
  /**
   * Optimize all pools
   */
  optimizeAll() {
    const startTime = performance.now();
    
    for (const pool of this.pools.values()) {
      pool.adapt();
    }
    
    const duration = performance.now() - startTime;
    
    logger.info('Global pool optimization completed', {
      pools: this.pools.size,
      duration: duration.toFixed(2)
    });
  }
  
  /**
   * Clear all pools
   */
  clearAll() {
    for (const pool of this.pools.values()) {
      pool.clear();
    }
  }
  
  /**
   * Destroy all pools
   */
  destroyAll() {
    for (const pool of this.pools.values()) {
      pool.destroy();
    }
    
    this.pools.clear();
  }
}

// Global pool manager instance
export const globalPoolManager = new MemoryPoolManager();

export default {
  AdaptiveMemoryPool,
  MemoryPoolManager,
  globalPoolManager
};