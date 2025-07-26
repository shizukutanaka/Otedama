/**
 * Memory Optimizer - Otedama
 * Advanced memory management for ultra-low footprint
 * 
 * Features:
 * - Object pooling with generational collection
 * - Memory pressure monitoring
 * - Automatic garbage collection optimization
 * - Zero-allocation patterns
 */

import v8 from 'v8';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('MemoryOptimizer');

/**
 * Advanced object pool with generational collection
 */
export class GenerationalObjectPool {
  constructor(factory, options = {}) {
    this.factory = factory;
    this.resetFn = options.reset || (() => {});
    this.maxSize = options.maxSize || 10000;
    this.generationSize = options.generationSize || 100;
    
    // Generational pools
    this.youngGen = [];
    this.oldGen = [];
    this.survivorSpace = [];
    
    // Statistics
    this.stats = {
      allocations: 0,
      poolHits: 0,
      promotions: 0,
      collections: 0,
      currentSize: 0
    };
    
    // Pre-warm pool
    this.prewarm(options.prewarmSize || 10);
  }
  
  /**
   * Pre-warm pool with objects
   */
  prewarm(size) {
    for (let i = 0; i < size; i++) {
      this.youngGen.push(this.factory());
      this.stats.currentSize++;
    }
  }
  
  /**
   * Acquire object from pool
   */
  acquire() {
    // Try young generation first
    if (this.youngGen.length > 0) {
      this.stats.poolHits++;
      return this.youngGen.pop();
    }
    
    // Try old generation
    if (this.oldGen.length > 0) {
      this.stats.poolHits++;
      return this.oldGen.pop();
    }
    
    // Allocate new object
    this.stats.allocations++;
    this.stats.currentSize++;
    
    // Trigger collection if needed
    if (this.stats.currentSize > this.maxSize) {
      this.collect();
    }
    
    return this.factory();
  }
  
  /**
   * Release object back to pool
   */
  release(obj) {
    // Reset object state
    this.resetFn(obj);
    
    // Add to young generation
    if (this.youngGen.length < this.generationSize) {
      this.youngGen.push(obj);
    } else {
      // Promote to survivor space
      this.survivorSpace.push(obj);
      this.stats.promotions++;
      
      // Check if survivor space needs promotion
      if (this.survivorSpace.length >= this.generationSize) {
        this.promoteGeneration();
      }
    }
  }
  
  /**
   * Promote survivor objects to old generation
   */
  promoteGeneration() {
    // Move survivors to old generation
    while (this.survivorSpace.length > 0 && 
           this.oldGen.length < this.maxSize / 2) {
      this.oldGen.push(this.survivorSpace.pop());
    }
    
    // Clear remaining survivors if old gen is full
    this.survivorSpace = [];
  }
  
  /**
   * Collect unused objects
   */
  collect() {
    this.stats.collections++;
    
    // Compact generations
    const totalObjects = this.youngGen.length + this.oldGen.length + 
                        this.survivorSpace.length;
    
    if (totalObjects > this.maxSize) {
      // Remove oldest objects from old generation
      const toRemove = totalObjects - this.maxSize;
      this.oldGen.splice(0, toRemove);
      this.stats.currentSize = this.maxSize;
    }
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      ...this.stats,
      youngGenSize: this.youngGen.length,
      oldGenSize: this.oldGen.length,
      survivorSize: this.survivorSpace.length,
      hitRate: this.stats.poolHits / (this.stats.poolHits + this.stats.allocations)
    };
  }
}

/**
 * Memory pressure monitor
 */
export class MemoryPressureMonitor {
  constructor(options = {}) {
    this.thresholds = {
      low: options.lowThreshold || 0.5,  // 50% memory usage
      medium: options.mediumThreshold || 0.7,  // 70% memory usage
      high: options.highThreshold || 0.85  // 85% memory usage
    };
    
    this.callbacks = {
      low: [],
      medium: [],
      high: []
    };
    
    this.interval = options.interval || 5000;  // Check every 5 seconds
    this.monitoring = false;
    this.lastPressure = 'low';
  }
  
  /**
   * Start monitoring memory pressure
   */
  start() {
    if (this.monitoring) return;
    
    this.monitoring = true;
    this.monitorLoop();
    
    logger.info('Memory pressure monitoring started');
  }
  
  /**
   * Monitor loop
   */
  async monitorLoop() {
    while (this.monitoring) {
      const pressure = this.checkPressure();
      
      if (pressure !== this.lastPressure) {
        this.handlePressureChange(pressure);
        this.lastPressure = pressure;
      }
      
      await new Promise(resolve => setTimeout(resolve, this.interval));
    }
  }
  
  /**
   * Check current memory pressure
   */
  checkPressure() {
    const stats = v8.getHeapStatistics();
    const usage = stats.used_heap_size / stats.heap_size_limit;
    
    if (usage >= this.thresholds.high) {
      return 'high';
    } else if (usage >= this.thresholds.medium) {
      return 'medium';
    } else {
      return 'low';
    }
  }
  
  /**
   * Handle pressure change
   */
  handlePressureChange(pressure) {
    logger.info('Memory pressure changed', { 
      from: this.lastPressure, 
      to: pressure 
    });
    
    // Call registered callbacks
    const callbacks = this.callbacks[pressure] || [];
    for (const callback of callbacks) {
      try {
        callback(pressure);
      } catch (error) {
        logger.error('Pressure callback error', error);
      }
    }
  }
  
  /**
   * Register pressure callback
   */
  on(pressure, callback) {
    if (this.callbacks[pressure]) {
      this.callbacks[pressure].push(callback);
    }
  }
  
  /**
   * Stop monitoring
   */
  stop() {
    this.monitoring = false;
    logger.info('Memory pressure monitoring stopped');
  }
}

/**
 * Garbage collection optimizer
 */
export class GCOptimizer {
  constructor() {
    this.stats = {
      majorGCs: 0,
      minorGCs: 0,
      incrementalMarkings: 0,
      lastGCTime: 0
    };
    
    // GC flags for optimization
    this.gcFlags = v8.GCProfiler ? v8.GCProfiler.GC_FLAGS : {};
  }
  
  /**
   * Force optimized garbage collection
   */
  forceGC(type = 'minor') {
    const startTime = Date.now();
    
    if (global.gc) {
      if (type === 'major') {
        // Full GC
        global.gc(true);
        this.stats.majorGCs++;
      } else {
        // Minor GC
        global.gc(false);
        this.stats.minorGCs++;
      }
      
      this.stats.lastGCTime = Date.now() - startTime;
      
      logger.debug('Garbage collection completed', {
        type,
        duration: this.stats.lastGCTime
      });
    }
  }
  
  /**
   * Optimize heap for performance
   */
  optimizeHeap() {
    // Get current heap statistics
    const before = v8.getHeapStatistics();
    
    // Compact heap
    if (v8.setFlagsFromString) {
      v8.setFlagsFromString('--compact_on_every_full_gc');
    }
    
    // Force major GC
    this.forceGC('major');
    
    // Get after statistics
    const after = v8.getHeapStatistics();
    
    const freed = before.used_heap_size - after.used_heap_size;
    
    logger.info('Heap optimization completed', {
      freedBytes: freed,
      freedMB: (freed / 1024 / 1024).toFixed(2)
    });
    
    return {
      before,
      after,
      freed
    };
  }
  
  /**
   * Get GC statistics
   */
  getStats() {
    const heapStats = v8.getHeapStatistics();
    
    return {
      ...this.stats,
      heap: {
        total: heapStats.total_heap_size,
        used: heapStats.used_heap_size,
        limit: heapStats.heap_size_limit,
        usage: (heapStats.used_heap_size / heapStats.heap_size_limit * 100).toFixed(2) + '%'
      }
    };
  }
}

/**
 * Memory-efficient buffer allocator
 */
export class BufferAllocator {
  constructor(options = {}) {
    this.pools = new Map();  // Size -> Pool
    this.maxPoolSize = options.maxPoolSize || 100;
    this.stats = {
      allocations: 0,
      poolHits: 0,
      totalAllocated: 0
    };
  }
  
  /**
   * Allocate buffer from pool
   */
  allocate(size) {
    // Round up to nearest power of 2
    const poolSize = this.roundUpPowerOf2(size);
    
    if (!this.pools.has(poolSize)) {
      this.pools.set(poolSize, []);
    }
    
    const pool = this.pools.get(poolSize);
    
    if (pool.length > 0) {
      this.stats.poolHits++;
      const buffer = pool.pop();
      buffer.fill(0);  // Clear buffer
      return buffer.slice(0, size);  // Return exact size
    }
    
    // Allocate new buffer
    this.stats.allocations++;
    this.stats.totalAllocated += poolSize;
    
    return Buffer.allocUnsafe(size);
  }
  
  /**
   * Release buffer back to pool
   */
  release(buffer) {
    const poolSize = this.roundUpPowerOf2(buffer.length);
    
    if (!this.pools.has(poolSize)) {
      this.pools.set(poolSize, []);
    }
    
    const pool = this.pools.get(poolSize);
    
    if (pool.length < this.maxPoolSize) {
      // Expand buffer to pool size if needed
      if (buffer.length < poolSize) {
        const expanded = Buffer.allocUnsafe(poolSize);
        buffer.copy(expanded);
        buffer = expanded;
      }
      
      pool.push(buffer);
    }
  }
  
  /**
   * Round up to nearest power of 2
   */
  roundUpPowerOf2(n) {
    n--;
    n |= n >> 1;
    n |= n >> 2;
    n |= n >> 4;
    n |= n >> 8;
    n |= n >> 16;
    n++;
    return n;
  }
  
  /**
   * Clear all pools
   */
  clear() {
    for (const pool of this.pools.values()) {
      pool.length = 0;
    }
    this.pools.clear();
  }
  
  /**
   * Get allocator statistics
   */
  getStats() {
    const poolStats = [];
    for (const [size, pool] of this.pools.entries()) {
      poolStats.push({
        size,
        count: pool.length,
        memory: size * pool.length
      });
    }
    
    return {
      ...this.stats,
      pools: poolStats,
      hitRate: this.stats.poolHits / (this.stats.poolHits + this.stats.allocations)
    };
  }
}

/**
 * Main memory optimizer
 */
export class MemoryOptimizer {
  constructor() {
    this.pools = new Map();
    this.pressureMonitor = new MemoryPressureMonitor();
    this.gcOptimizer = new GCOptimizer();
    this.bufferAllocator = new BufferAllocator();
    
    // Register pressure handlers
    this.setupPressureHandlers();
  }
  
  /**
   * Setup pressure handlers
   */
  setupPressureHandlers() {
    // Low pressure - normal operation
    this.pressureMonitor.on('low', () => {
      logger.debug('Low memory pressure - normal operation');
    });
    
    // Medium pressure - start releasing resources
    this.pressureMonitor.on('medium', () => {
      logger.warn('Medium memory pressure - releasing resources');
      this.releasePooledObjects(0.25);  // Release 25% of pooled objects
    });
    
    // High pressure - aggressive cleanup
    this.pressureMonitor.on('high', () => {
      logger.error('High memory pressure - aggressive cleanup');
      this.releasePooledObjects(0.5);  // Release 50% of pooled objects
      this.gcOptimizer.forceGC('major');
      this.bufferAllocator.clear();
    });
  }
  
  /**
   * Create or get object pool
   */
  getPool(name, factory, options) {
    if (!this.pools.has(name)) {
      this.pools.set(name, new GenerationalObjectPool(factory, options));
    }
    return this.pools.get(name);
  }
  
  /**
   * Release percentage of pooled objects
   */
  releasePooledObjects(percentage) {
    for (const [name, pool] of this.pools.entries()) {
      const stats = pool.getStats();
      const toRelease = Math.floor(stats.currentSize * percentage);
      
      // Simulate releasing by clearing generations
      pool.youngGen.splice(0, Math.floor(pool.youngGen.length * percentage));
      pool.oldGen.splice(0, Math.floor(pool.oldGen.length * percentage));
      
      logger.info(`Released ${toRelease} objects from pool ${name}`);
    }
  }
  
  /**
   * Start memory optimization
   */
  start() {
    this.pressureMonitor.start();
    logger.info('Memory optimizer started');
  }
  
  /**
   * Stop memory optimization
   */
  stop() {
    this.pressureMonitor.stop();
    logger.info('Memory optimizer stopped');
  }
  
  /**
   * Get optimizer statistics
   */
  getStats() {
    const poolStats = {};
    for (const [name, pool] of this.pools.entries()) {
      poolStats[name] = pool.getStats();
    }
    
    return {
      pools: poolStats,
      gc: this.gcOptimizer.getStats(),
      buffers: this.bufferAllocator.getStats(),
      pressure: this.pressureMonitor.lastPressure
    };
  }
}

export default MemoryOptimizer;