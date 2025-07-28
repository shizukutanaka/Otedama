/**
 * Memory Manager - Otedama
 * Efficient memory management with object pooling
 * 
 * Design: Zero allocations in hot paths (Carmack)
 * Enhanced with advanced leak detection and cache optimization
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from './structured-logger.js';
import v8 from 'v8';

const logger = createStructuredLogger('MemoryManager');

/**
 * Generic object pool for reusable objects
 */
export class ObjectPool {
  constructor(factory, reset, maxSize = 1000) {
    this.factory = factory;
    this.reset = reset;
    this.maxSize = maxSize;
    this.pool = [];
    this.inUse = 0;
    this.created = 0;
    this.stats = {
      hits: 0,
      misses: 0,
      releases: 0
    };
  }
  
  acquire() {
    this.inUse++;
    
    if (this.pool.length > 0) {
      this.stats.hits++;
      return this.pool.pop();
    }
    
    this.stats.misses++;
    this.created++;
    return this.factory();
  }
  
  release(obj) {
    if (!obj) return;
    
    this.inUse--;
    this.stats.releases++;
    
    if (this.pool.length < this.maxSize) {
      this.reset(obj);
      this.pool.push(obj);
    }
  }
  
  clear() {
    this.pool = [];
    this.inUse = 0;
  }
  
  getStats() {
    return {
      poolSize: this.pool.length,
      inUse: this.inUse,
      created: this.created,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0,
      ...this.stats
    };
  }
}

/**
 * Advanced buffer pool with size-based allocation
 */
export class BufferPool extends ObjectPool {
  constructor(bufferSize = 4096, maxBuffers = 100) {
    super(
      () => Buffer.allocUnsafe(bufferSize),
      (buffer) => {
        buffer.fill(0, 0, Math.min(buffer.length, bufferSize));
        return buffer;
      },
      maxBuffers
    );
    this.bufferSize = bufferSize;
    this.allocatedBytes = 0;
    this.maxAllocatedBytes = bufferSize * maxBuffers;
  }
  
  acquire(size) {
    if (size && size > this.bufferSize) {
      // Need larger buffer, don't pool it but track allocation
      this.allocatedBytes += size;
      return Buffer.allocUnsafe(size);
    }
    
    const buffer = super.acquire();
    if (buffer.length === this.bufferSize) {
      this.allocatedBytes += this.bufferSize;
    }
    return buffer;
  }

  release(obj) {
    if (!obj) return;
    
    if (obj.length === this.bufferSize) {
      this.allocatedBytes -= this.bufferSize;
      super.release(obj);
    } else {
      // Large buffer not pooled
      this.allocatedBytes -= obj.length;
    }
  }

  getMemoryUsage() {
    return {
      allocatedBytes: this.allocatedBytes,
      maxAllocatedBytes: this.maxAllocatedBytes,
      utilizationPercent: (this.allocatedBytes / this.maxAllocatedBytes) * 100,
      pooledBuffers: this.pool.length,
      inUseBuffers: this.inUse
    };
  }
}

/**
 * Memory usage monitor
 */
export class MemoryMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      interval: options.interval || 30000, // 30 seconds
      gcThreshold: options.gcThreshold || 0.8, // 80% memory usage
      warnThreshold: options.warnThreshold || 0.7, // 70% memory usage
      heapSnapshot: options.heapSnapshot || false
    };
    
    this.timer = null;
    this.baseline = null;
    this.history = [];
    this.maxHistory = 100;
    // Initialize circular buffer for better performance
    this.historyCircularBuffer = new CircularBuffer(this.maxHistory);
  }
  
  start() {
    if (this.timer) return;
    
    // Record baseline
    this.baseline = process.memoryUsage();
    
    this.timer = setInterval(() => {
      this.check();
    }, this.config.interval);
    
    logger.info('Memory monitoring started');
  }
  
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    
    logger.info('Memory monitoring stopped');
  }
  
  check() {
    const usage = process.memoryUsage();
    const heapUsedRatio = usage.heapUsed / usage.heapTotal;
    
    // Record history
    const record = {
      timestamp: Date.now(),
      ...usage,
      heapUsedRatio
    };
    
    this.history.push(record);
    this.historyCircularBuffer.push(record);
    
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
    
    // Check thresholds
    if (heapUsedRatio > this.config.gcThreshold) {
      logger.warn('Memory usage critical, forcing garbage collection');
      this.forceGC();
      this.emit('gc:forced', { heapUsedRatio });
    } else if (heapUsedRatio > this.config.warnThreshold) {
      logger.warn(`Memory usage high: ${(heapUsedRatio * 100).toFixed(1)}%`);
      this.emit('memory:warning', { heapUsedRatio, usage });
    }
    
    // Check for memory leaks
    this.checkForLeaks();
    
    this.emit('memory:check', { usage, heapUsedRatio });
  }
  
  checkForLeaks() {
    if (this.history.length < 10) return;
    
    // Enhanced leak detection with multiple strategies
    // Use circular buffer if available for better performance
    const recent = this.historyCircularBuffer ? 
      this.historyCircularBuffer.getRecent(10) : 
      this.history.slice(-10);
    
    // Strategy 1: Consistent memory growth
    const consistentGrowth = this.detectConsistentGrowth(recent);
    
    // Strategy 2: Exponential growth pattern
    const exponentialGrowth = this.detectExponentialGrowth(recent);
    
    // Strategy 3: External memory growth (ArrayBuffers, etc.)
    const externalGrowth = this.detectExternalGrowth(recent);
    
    if (consistentGrowth.detected) {
      logger.warn('Potential memory leak: consistent growth detected', consistentGrowth);
      this.emit('memory:leak', { type: 'consistent', ...consistentGrowth });
    }
    
    if (exponentialGrowth.detected) {
      logger.warn('Potential memory leak: exponential growth detected', exponentialGrowth);
      this.emit('memory:leak', { type: 'exponential', ...exponentialGrowth });
    }
    
    if (externalGrowth.detected) {
      logger.warn('Potential memory leak: external memory growth detected', externalGrowth);
      this.emit('memory:leak', { type: 'external', ...externalGrowth });
    }
  }

  detectConsistentGrowth(samples) {
    const growthCount = samples.slice(1).filter((curr, idx) => 
      curr.heapUsed > samples[idx].heapUsed
    ).length;
    
    const isConsistentGrowth = growthCount >= samples.length * 0.8; // 80% of samples growing
    
    if (isConsistentGrowth) {
      const startMem = samples[0].heapUsed;
      const endMem = samples[samples.length - 1].heapUsed;
      const growthRate = (endMem - startMem) / startMem;
      
      return {
        detected: growthRate > 0.05, // 5% growth threshold
        growthRate,
        startMem,
        endMem,
        samplesGrowing: growthCount
      };
    }
    
    return { detected: false };
  }

  detectExponentialGrowth(samples) {
    if (samples.length < 5) return { detected: false };
    
    // Calculate growth rates between consecutive samples
    const growthRates = [];
    for (let i = 1; i < samples.length; i++) {
      const rate = (samples[i].heapUsed - samples[i-1].heapUsed) / samples[i-1].heapUsed;
      growthRates.push(rate);
    }
    
    // Check if growth rates are increasing (exponential pattern)
    let increasingCount = 0;
    for (let i = 1; i < growthRates.length; i++) {
      if (growthRates[i] > growthRates[i-1]) {
        increasingCount++;
      }
    }
    
    const isExponential = increasingCount >= growthRates.length * 0.7;
    const avgGrowthRate = growthRates.reduce((a, b) => a + b, 0) / growthRates.length;
    
    return {
      detected: isExponential && avgGrowthRate > 0.02, // 2% average growth
      avgGrowthRate,
      maxGrowthRate: Math.max(...growthRates),
      increasingTrend: increasingCount / growthRates.length
    };
  }

  detectExternalGrowth(samples) {
    const firstExternal = samples[0].external || 0;
    const lastExternal = samples[samples.length - 1].external || 0;
    const externalGrowth = lastExternal - firstExternal;
    const externalGrowthRate = firstExternal > 0 ? externalGrowth / firstExternal : 0;
    
    // Check ArrayBuffers if available
    const firstArrayBuffers = samples[0].arrayBuffers || 0;
    const lastArrayBuffers = samples[samples.length - 1].arrayBuffers || 0;
    const arrayBufferGrowth = lastArrayBuffers - firstArrayBuffers;
    
    return {
      detected: externalGrowthRate > 0.1 || arrayBufferGrowth > 50 * 1024 * 1024, // 50MB
      externalGrowth,
      externalGrowthRate,
      arrayBufferGrowth,
      firstExternal,
      lastExternal
    };
  }
  
  forceGC() {
    if (global.gc) {
      global.gc();
      logger.info('Garbage collection completed');
    } else {
      logger.warn('Garbage collection not available. Run with --expose-gc');
    }
  }
  
  getStats() {
    const current = process.memoryUsage();
    const stats = {
      current,
      heapUsedRatio: current.heapUsed / current.heapTotal,
      external: current.external,
      arrayBuffers: current.arrayBuffers || 0
    };
    
    if (this.baseline) {
      stats.growth = {
        heapUsed: current.heapUsed - this.baseline.heapUsed,
        heapTotal: current.heapTotal - this.baseline.heapTotal,
        rss: current.rss - this.baseline.rss
      };
    }
    
    if (this.history.length > 0) {
      const heapUsedValues = this.history.map(h => h.heapUsed);
      stats.trend = {
        min: Math.min(...heapUsedValues),
        max: Math.max(...heapUsedValues),
        avg: heapUsedValues.reduce((a, b) => a + b) / heapUsedValues.length
      };
    }
    
    return stats;
  }
  
  takeHeapSnapshot() {
    if (!this.config.heapSnapshot) return;
    
    try {
      const v8 = require('v8');
      const filename = `heap-${Date.now()}.heapsnapshot`;
      
      v8.writeHeapSnapshot(filename);
      logger.info(`Heap snapshot written to ${filename}`);
      
      return filename;
    } catch (error) {
      logger.error('Failed to take heap snapshot:', error);
      return null;
    }
  }
}

/**
 * Weak reference manager for automatic cleanup
 */
export class WeakReferenceManager {
  constructor() {
    this.registry = new FinalizationRegistry((key) => {
      logger.debug(`Object with key ${key} was garbage collected`);
      this.onCleanup(key);
    });
    
    this.weakRefs = new Map();
    this.cleanupCallbacks = new Map();
  }
  
  register(key, object, cleanupCallback = null) {
    const ref = new WeakRef(object);
    this.weakRefs.set(key, ref);
    
    if (cleanupCallback) {
      this.cleanupCallbacks.set(key, cleanupCallback);
    }
    
    this.registry.register(object, key);
  }
  
  get(key) {
    const ref = this.weakRefs.get(key);
    if (!ref) return null;
    
    const obj = ref.deref();
    if (!obj) {
      // Object was garbage collected
      this.weakRefs.delete(key);
      return null;
    }
    
    return obj;
  }
  
  onCleanup(key) {
    this.weakRefs.delete(key);
    
    const callback = this.cleanupCallbacks.get(key);
    if (callback) {
      try {
        callback();
      } catch (error) {
        logger.error('Cleanup callback failed:', error);
        // Emit error event for monitoring
        if (this.memoryManager) {
          this.memoryManager.emit('cleanup:error', { key, error });
        }
      } finally {
        this.cleanupCallbacks.delete(key);
      }
    }
  }
  
  clear() {
    this.weakRefs.clear();
    this.cleanupCallbacks.clear();
  }
}

/**
 * Memory-efficient data structures
 */
export class CircularBuffer {
  constructor(size) {
    this.size = size;
    this.buffer = new Array(size);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
  
  getRecent(n) {
    if (n > this.count) n = this.count;
    const result = [];
    let index = (this.head + this.count - n) % this.size;
    
    for (let i = 0; i < n; i++) {
      result.push(this.buffer[index]);
      index = (index + 1) % this.size;
    }
    
    return result;
  }
  
  push(item) {
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.size;
    
    if (this.count < this.size) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.size;
    }
  }
  
  pop() {
    if (this.count === 0) return null;
    
    const item = this.buffer[this.head];
    this.head = (this.head + 1) % this.size;
    this.count--;
    
    return item;
  }
  
  toArray() {
    const result = [];
    let idx = this.head;
    
    for (let i = 0; i < this.count; i++) {
      result.push(this.buffer[idx]);
      idx = (idx + 1) % this.size;
    }
    
    return result;
  }
  
  clear() {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    this.buffer.fill(undefined);
  }
}

/**
 * Central memory manager with ultra-performance GC optimization
 */
export class MemoryManager {
  constructor() {
    this.pools = new Map();
    this.monitor = new MemoryMonitor();
    this.weakRefs = new WeakReferenceManager();
    
    // Enhanced buffer pools with adaptive sizing
    this.bufferPool = new BufferPool(4096, 1000);
    this.smallBufferPool = new BufferPool(256, 2000);
    this.mediumBufferPool = new BufferPool(1024, 1500);
    this.largeBufferPool = new BufferPool(65536, 100);
    this.hugeBufferPool = new BufferPool(1048576, 20); // 1MB buffers
    
    // GC optimization features
    this.gcOptimizer = new GCOptimizer();
    this.memoryPressureDetector = new MemoryPressureDetector();
    this.objectPoolManager = new ObjectPoolManager();
    
    // Performance counters
    this.stats = {
      totalAllocations: 0,
      totalDeallocations: 0,
      gcTriggered: 0,
      memoryPressureEvents: 0,
      poolHitRatio: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize memory manager with GC optimization
   */
  initialize() {
    // Start GC optimizer
    this.gcOptimizer.initialize();
    
    // Start memory pressure monitoring
    this.memoryPressureDetector.start();
    
    // Setup event handlers
    this.memoryPressureDetector.on('pressure:high', () => {
      this.handleMemoryPressure();
    });
    
    this.gcOptimizer.on('gc:recommended', (type) => {
      this.triggerOptimizedGC(type);
    });
    
    logger.info('Enhanced memory manager initialized with GC optimization');
  }
  
  /**
   * Handle memory pressure events
   */
  handleMemoryPressure() {
    this.stats.memoryPressureEvents++;
    
    // Aggressive cleanup
    this.aggressiveCleanup();
    
    // Trigger incremental GC
    this.triggerOptimizedGC('incremental');
    
    logger.warn('Memory pressure detected, performing aggressive cleanup');
  }
  
  /**
   * Trigger optimized garbage collection
   */
  triggerOptimizedGC(type = 'incremental') {
    if (global.gc) {
      this.stats.gcTriggered++;
      
      switch (type) {
        case 'incremental':
          // Multiple small GC cycles
          for (let i = 0; i < 3; i++) {
            global.gc();
            // Yield to event loop
            if (i < 2) setImmediate(() => {});
          }
          break;
        case 'full':
          global.gc();
          break;
        case 'minor':
          // In real implementation, use V8's GC API for minor GC
          global.gc();
          break;
      }
      
      logger.debug(`Triggered ${type} GC`);
    }
  }
  
  /**
   * Aggressive cleanup during memory pressure
   */
  aggressiveCleanup() {
    // Clear buffer pools partially
    this.bufferPool.clear();
    this.smallBufferPool.shrink(0.5);
    this.mediumBufferPool.shrink(0.5);
    this.largeBufferPool.shrink(0.3);
    
    // Clean object pools
    this.objectPoolManager.aggressiveCleanup();
    
    // Clear weak references
    this.weakRefs.cleanup();
  }
  
  createPool(name, factory, reset, maxSize) {
    const pool = new ObjectPool(factory, reset, maxSize);
    this.pools.set(name, pool);
    return pool;
  }
  
  getPool(name) {
    return this.pools.get(name);
  }
  
  getBuffer(size = 4096) {
    if (size <= 256) {
      return this.smallBufferPool.acquire();
    } else if (size <= 4096) {
      return this.bufferPool.acquire();
    } else if (size <= 65536) {
      return this.largeBufferPool.acquire();
    } else {
      // Don't pool very large buffers
      return Buffer.allocUnsafe(size);
    }
  }
  
  releaseBuffer(buffer) {
    if (!buffer) return;
    
    const size = buffer.length;
    
    if (size <= 256) {
      this.smallBufferPool.release(buffer);
    } else if (size <= 4096) {
      this.bufferPool.release(buffer);
    } else if (size <= 65536) {
      this.largeBufferPool.release(buffer);
    }
    // Large buffers are not pooled
  }
  
  startMonitoring() {
    this.monitor.start();
  }
  
  stopMonitoring() {
    this.monitor.stop();
  }
  
  getStats() {
    const stats = {
      memory: this.monitor.getStats(),
      pools: {}
    };
    
    // Add pool stats
    for (const [name, pool] of this.pools) {
      stats.pools[name] = pool.getStats();
    }
    
    stats.pools.buffer = this.bufferPool.getStats();
    stats.pools.smallBuffer = this.smallBufferPool.getStats();
    stats.pools.largeBuffer = this.largeBufferPool.getStats();
    
    return stats;
  }
  
  cleanup() {
    // Clear all pools
    for (const pool of this.pools.values()) {
      pool.clear();
    }
    
    this.bufferPool.clear();
    this.smallBufferPool.clear();
    this.largeBufferPool.clear();
    
    // Clear weak references
    this.weakRefs.clear();
    
    // Force GC if available
    this.monitor.forceGC();
  }
}

// Singleton instance
export const memoryManager = new MemoryManager();

export default {
  ObjectPool,
  BufferPool,
  MemoryMonitor,
  WeakReferenceManager,
  CircularBuffer,
  MemoryManager,
  memoryManager
};
