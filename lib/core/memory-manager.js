/**
 * Memory Manager - Otedama
 * Efficient memory management with object pooling
 * 
 * Design: Zero allocations in hot paths (Carmack)
 * Enhanced with advanced leak detection and cache optimization
 */

import { EventEmitter } from 'events';
import { createLogger } from './structured-logger.js';
import v8 from 'v8';

const logger = createLogger('MemoryManager');

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
 * Buffer pool for network operations
 */
export class BufferPool extends ObjectPool {
  constructor(bufferSize = 4096, maxBuffers = 100) {
    super(
      () => Buffer.allocUnsafe(bufferSize),
      (buffer) => buffer.fill(0),
      maxBuffers
    );
    this.bufferSize = bufferSize;
  }
  
  acquire(size) {
    if (size && size > this.bufferSize) {
      // Need larger buffer, don't pool it
      return Buffer.allocUnsafe(size);
    }
    return super.acquire();
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
    this.history.push({
      timestamp: Date.now(),
      ...usage,
      heapUsedRatio
    });
    
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
    
    // Simple leak detection: consistent memory growth
    const recent = this.history.slice(-10);
    const growth = recent.every((curr, idx) => {
      if (idx === 0) return true;
      return curr.heapUsed > recent[idx - 1].heapUsed;
    });
    
    if (growth) {
      const startMem = recent[0].heapUsed;
      const endMem = recent[recent.length - 1].heapUsed;
      const growthRate = (endMem - startMem) / startMem;
      
      if (growthRate > 0.1) { // 10% growth
        logger.warn('Potential memory leak detected');
        this.emit('memory:leak', { growthRate, startMem, endMem });
      }
    }
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
      callback();
      this.cleanupCallbacks.delete(key);
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
 * Central memory manager
 */
export class MemoryManager {
  constructor() {
    this.pools = new Map();
    this.monitor = new MemoryMonitor();
    this.weakRefs = new WeakReferenceManager();
    
    // Default pools
    this.bufferPool = new BufferPool();
    this.smallBufferPool = new BufferPool(256, 1000);
    this.largeBufferPool = new BufferPool(65536, 10);
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
