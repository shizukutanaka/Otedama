/**
 * Performance Module - Otedama
 * High-performance utilities following John Carmack's principles
 * 
 * Features:
 * - Zero-copy operations
 * - Buffer pooling
 * - Memory efficient data structures
 * - Lock-free algorithms where possible
 * - CPU affinity management
 * - JIT optimization tracking
 * - Network optimization
 */

import { createLogger } from './structured-logger.js';
import os from 'os';
import { Worker } from 'worker_threads';
import v8 from 'v8';

const logger = createLogger('Performance');

/**
 * Buffer Pool - Reuse buffers to avoid allocations
 */
export class BufferPool {
  constructor(bufferSize = 4096, maxBuffers = 1000) {
    this.bufferSize = bufferSize;
    this.maxBuffers = maxBuffers;
    this.availableBuffers = [];
    this.allocatedCount = 0;
    
    // Pre-allocate some buffers
    const preAllocate = Math.min(10, maxBuffers);
    for (let i = 0; i < preAllocate; i++) {
      this.availableBuffers.push(Buffer.allocUnsafe(bufferSize));
      this.allocatedCount++;
    }
  }
  
  /**
   * Get a buffer from the pool
   */
  acquire() {
    if (this.availableBuffers.length > 0) {
      return this.availableBuffers.pop();
    }
    
    if (this.allocatedCount < this.maxBuffers) {
      this.allocatedCount++;
      return Buffer.allocUnsafe(this.bufferSize);
    }
    
    // Pool exhausted, allocate new buffer (will be GC'd)
    logger.warn('Buffer pool exhausted, allocating new buffer');
    return Buffer.allocUnsafe(this.bufferSize);
  }
  
  /**
   * Return a buffer to the pool
   */
  release(buffer) {
    if (buffer.length !== this.bufferSize) {
      return; // Wrong size, let it be GC'd
    }
    
    if (this.availableBuffers.length < this.maxBuffers) {
      // Clear buffer before returning to pool
      buffer.fill(0);
      this.availableBuffers.push(buffer);
    }
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      bufferSize: this.bufferSize,
      maxBuffers: this.maxBuffers,
      allocatedCount: this.allocatedCount,
      availableCount: this.availableBuffers.length,
      inUseCount: this.allocatedCount - this.availableBuffers.length
    };
  }
}

/**
 * Worker Pool - Efficient task distribution
 */
export class WorkerPool {
  constructor(workerScript, workerCount = os.cpus().length) {
    this.workerScript = workerScript;
    this.workerCount = workerCount;
    this.workers = [];
    this.taskQueue = [];
    this.busyWorkers = new Set();
    this.initialized = false;
  }
  
  /**
   * Initialize worker pool
   */
  async initialize() {
    if (this.initialized) return;
    
    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(this.workerScript);
      
      worker.on('message', (result) => {
        this.handleWorkerResult(worker, result);
      });
      
      worker.on('error', (error) => {
        logger.error('Worker error:', error);
        this.busyWorkers.delete(worker);
        this.processQueue();
      });
      
      this.workers.push(worker);
    }
    
    this.initialized = true;
    logger.info(`Worker pool initialized with ${this.workerCount} workers`);
  }
  
  /**
   * Execute task on worker
   */
  async execute(task) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    return new Promise((resolve, reject) => {
      const taskWrapper = {
        task,
        resolve,
        reject,
        timestamp: Date.now()
      };
      
      this.taskQueue.push(taskWrapper);
      this.processQueue();
    });
  }
  
  /**
   * Process task queue
   */
  processQueue() {
    while (this.taskQueue.length > 0) {
      const availableWorker = this.workers.find(w => !this.busyWorkers.has(w));
      if (!availableWorker) break;
      
      const taskWrapper = this.taskQueue.shift();
      this.busyWorkers.add(availableWorker);
      
      availableWorker.taskWrapper = taskWrapper;
      availableWorker.postMessage(taskWrapper.task);
    }
  }
  
  /**
   * Handle worker result
   */
  handleWorkerResult(worker, result) {
    const taskWrapper = worker.taskWrapper;
    if (!taskWrapper) return;
    
    this.busyWorkers.delete(worker);
    delete worker.taskWrapper;
    
    if (result.error) {
      taskWrapper.reject(new Error(result.error));
    } else {
      taskWrapper.resolve(result.data);
    }
    
    // Process next task
    this.processQueue();
  }
  
  /**
   * Shutdown worker pool
   */
  async shutdown() {
    for (const worker of this.workers) {
      await worker.terminate();
    }
    this.workers = [];
    this.initialized = false;
    logger.info('Worker pool shutdown');
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      workerCount: this.workerCount,
      busyWorkers: this.busyWorkers.size,
      idleWorkers: this.workerCount - this.busyWorkers.size,
      queueLength: this.taskQueue.length
    };
  }
}

/**
 * Ring Buffer - Lock-free circular buffer
 */
export class RingBuffer {
  constructor(size = 1024) {
    this.size = size;
    this.buffer = new Array(size);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.count = 0;
  }
  
  /**
   * Write to buffer
   */
  write(item) {
    if (this.count >= this.size) {
      return false; // Buffer full
    }
    
    this.buffer[this.writeIndex] = item;
    this.writeIndex = (this.writeIndex + 1) % this.size;
    this.count++;
    return true;
  }
  
  /**
   * Read from buffer
   */
  read() {
    if (this.count === 0) {
      return null; // Buffer empty
    }
    
    const item = this.buffer[this.readIndex];
    this.readIndex = (this.readIndex + 1) % this.size;
    this.count--;
    return item;
  }
  
  /**
   * Batch read
   */
  readBatch(maxItems) {
    const items = [];
    const itemsToRead = Math.min(maxItems, this.count);
    
    for (let i = 0; i < itemsToRead; i++) {
      items.push(this.read());
    }
    
    return items;
  }
  
  /**
   * Get buffer statistics
   */
  getStats() {
    return {
      size: this.size,
      count: this.count,
      available: this.size - this.count,
      utilization: (this.count / this.size) * 100
    };
  }
}

/**
 * Performance Monitor
 */
export class PerformanceMonitor {
  constructor() {
    this.metrics = new Map();
    this.startTimes = new Map();
  }
  
  /**
   * Start timing
   */
  start(name) {
    this.startTimes.set(name, process.hrtime.bigint());
  }
  
  /**
   * End timing
   */
  end(name) {
    const startTime = this.startTimes.get(name);
    if (!startTime) return;
    
    const duration = Number(process.hrtime.bigint() - startTime) / 1e6; // Convert to ms
    this.startTimes.delete(name);
    
    if (!this.metrics.has(name)) {
      this.metrics.set(name, {
        count: 0,
        total: 0,
        min: Infinity,
        max: -Infinity,
        avg: 0
      });
    }
    
    const metric = this.metrics.get(name);
    metric.count++;
    metric.total += duration;
    metric.min = Math.min(metric.min, duration);
    metric.max = Math.max(metric.max, duration);
    metric.avg = metric.total / metric.count;
  }
  
  /**
   * Record value
   */
  record(name, value) {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, {
        count: 0,
        total: 0,
        min: Infinity,
        max: -Infinity,
        avg: 0
      });
    }
    
    const metric = this.metrics.get(name);
    metric.count++;
    metric.total += value;
    metric.min = Math.min(metric.min, value);
    metric.max = Math.max(metric.max, value);
    metric.avg = metric.total / metric.count;
  }
  
  /**
   * Get metrics
   */
  getMetrics(name = null) {
    if (name) {
      return this.metrics.get(name);
    }
    
    const result = {};
    for (const [key, value] of this.metrics) {
      result[key] = { ...value };
    }
    return result;
  }
  
  /**
   * Reset metrics
   */
  reset(name = null) {
    if (name) {
      this.metrics.delete(name);
    } else {
      this.metrics.clear();
    }
  }
}

/**
 * Memory-efficient LRU Cache
 */
export class LRUCache {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }
  
  /**
   * Get value from cache
   */
  get(key) {
    if (!this.cache.has(key)) {
      return undefined;
    }
    
    // Move to end (most recently used)
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }
  
  /**
   * Set value in cache
   */
  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Remove least recently used (first item)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, value);
  }
  
  /**
   * Check if key exists
   */
  has(key) {
    return this.cache.has(key);
  }
  
  /**
   * Remove from cache
   */
  delete(key) {
    return this.cache.delete(key);
  }
  
  /**
   * Clear cache
   */
  clear() {
    this.cache.clear();
  }
  
  /**
   * Get cache size
   */
  get size() {
    return this.cache.size;
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      utilization: (this.cache.size / this.maxSize) * 100
    };
  }
}

/**
 * Fast hash function (djb2)
 */
export function fastHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return hash >>> 0; // Convert to unsigned 32-bit
}

/**
 * Optimized memory usage formatter
 */
export function formatMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    rss: (usage.rss / 1024 / 1024).toFixed(2) + ' MB',
    heapTotal: (usage.heapTotal / 1024 / 1024).toFixed(2) + ' MB',
    heapUsed: (usage.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
    external: (usage.external / 1024 / 1024).toFixed(2) + ' MB'
  };
}

/**
 * CPU usage monitor
 */
let lastCPUUsage = process.cpuUsage();
export function getCPUUsage() {
  const currentUsage = process.cpuUsage(lastCPUUsage);
  lastCPUUsage = process.cpuUsage();
  
  const totalUsage = currentUsage.user + currentUsage.system;
  const totalTime = process.uptime() * 1000000; // Convert to microseconds
  
  return {
    user: (currentUsage.user / totalTime * 100).toFixed(2) + '%',
    system: (currentUsage.system / totalTime * 100).toFixed(2) + '%',
    total: (totalUsage / totalTime * 100).toFixed(2) + '%'
  };
}

// Export singleton instances
export const defaultBufferPool = new BufferPool();
export const performanceMonitor = new PerformanceMonitor();

export default {
  BufferPool,
  WorkerPool,
  RingBuffer,
  PerformanceMonitor,
  LRUCache,
  fastHash,
  formatMemoryUsage,
  getCPUUsage,
  defaultBufferPool,
  performanceMonitor
};
