/**
 * Performance Optimization Module for Otedama
 * Provides optimization strategies and implementations
 * 
 * Design principles:
 * - Carmack: Aggressive optimization, cache-friendly
 * - Martin: Clean optimization patterns
 * - Pike: Simple and measurable optimizations
 */

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { logger } from '../core/logger.js';

/**
 * Memory pool for object reuse
 */
export class ObjectPool {
  constructor(factory, reset, options = {}) {
    this.factory = factory;
    this.reset = reset;
    this.pool = [];
    this.inUse = new Set();
    
    this.options = {
      initialSize: options.initialSize || 10,
      maxSize: options.maxSize || 1000,
      growthFactor: options.growthFactor || 2,
      shrinkThreshold: options.shrinkThreshold || 0.25,
      ...options
    };
    
    // Metrics
    this.metrics = {
      created: 0,
      acquired: 0,
      released: 0,
      reused: 0
    };
    
    // Pre-populate pool
    this._grow(this.options.initialSize);
  }
  
  acquire() {
    if (this.pool.length === 0) {
      this._grow(Math.min(
        this.inUse.size * this.options.growthFactor,
        this.options.maxSize - this.inUse.size
      ));
    }
    
    let obj = this.pool.pop();
    if (!obj) {
      obj = this.factory();
      this.metrics.created++;
    } else {
      this.metrics.reused++;
    }
    
    this.inUse.add(obj);
    this.metrics.acquired++;
    
    return obj;
  }
  
  release(obj) {
    if (!this.inUse.has(obj)) return;
    
    this.inUse.delete(obj);
    this.reset(obj);
    
    if (this.pool.length < this.options.maxSize) {
      this.pool.push(obj);
    }
    
    this.metrics.released++;
    
    // Shrink pool if usage is low
    if (this.pool.length > this.options.initialSize &&
        this.inUse.size < this.pool.length * this.options.shrinkThreshold) {
      this._shrink();
    }
  }
  
  _grow(count) {
    for (let i = 0; i < count; i++) {
      if (this.pool.length + this.inUse.size >= this.options.maxSize) break;
      this.pool.push(this.factory());
      this.metrics.created++;
    }
  }
  
  _shrink() {
    const targetSize = Math.max(
      this.options.initialSize,
      this.inUse.size * (1 / this.options.shrinkThreshold)
    );
    
    while (this.pool.length > targetSize) {
      this.pool.pop();
    }
  }
  
  clear() {
    this.pool = [];
    this.inUse.clear();
  }
  
  getMetrics() {
    return {
      ...this.metrics,
      poolSize: this.pool.length,
      inUse: this.inUse.size,
      total: this.pool.length + this.inUse.size,
      reuseRate: this.metrics.acquired > 0 ? 
        (this.metrics.reused / this.metrics.acquired * 100).toFixed(2) + '%' : '0%'
    };
  }
}

/**
 * String interning for memory optimization
 */
export class StringInterner {
  constructor(options = {}) {
    this.strings = new Map();
    this.options = {
      maxSize: options.maxSize || 10000,
      cleanupThreshold: options.cleanupThreshold || 0.9,
      ...options
    };
    
    this.metrics = {
      interned: 0,
      hits: 0,
      misses: 0,
      cleanups: 0
    };
  }
  
  intern(str) {
    if (typeof str !== 'string') return str;
    
    let interned = this.strings.get(str);
    if (interned) {
      this.metrics.hits++;
      return interned;
    }
    
    this.metrics.misses++;
    
    // Check size limit
    if (this.strings.size >= this.options.maxSize * this.options.cleanupThreshold) {
      this._cleanup();
    }
    
    this.strings.set(str, str);
    this.metrics.interned++;
    
    return str;
  }
  
  _cleanup() {
    // Remove least recently used strings
    const targetSize = Math.floor(this.options.maxSize * 0.5);
    const entries = Array.from(this.strings.entries());
    
    // Keep most recently added (simple LRU approximation)
    this.strings = new Map(entries.slice(-targetSize));
    this.metrics.cleanups++;
  }
  
  clear() {
    this.strings.clear();
  }
  
  getMetrics() {
    return {
      ...this.metrics,
      size: this.strings.size,
      hitRate: (this.metrics.hits + this.metrics.misses) > 0 ?
        (this.metrics.hits / (this.metrics.hits + this.metrics.misses) * 100).toFixed(2) + '%' : '0%'
    };
  }
}

/**
 * Batch processor for efficient bulk operations
 */
export class BatchProcessor extends EventEmitter {
  constructor(processor, options = {}) {
    super();
    
    this.processor = processor;
    this.options = {
      batchSize: options.batchSize || 100,
      flushInterval: options.flushInterval || 100,
      maxWaitTime: options.maxWaitTime || 1000,
      parallel: options.parallel || false,
      ...options
    };
    
    this.queue = [];
    this.processing = false;
    this.flushTimer = null;
    this.oldestItemTime = null;
    
    this.metrics = {
      itemsProcessed: 0,
      batchesProcessed: 0,
      errors: 0,
      avgBatchSize: 0
    };
  }
  
  add(item) {
    this.queue.push(item);
    
    if (!this.oldestItemTime) {
      this.oldestItemTime = Date.now();
    }
    
    // Process immediately if batch is full
    if (this.queue.length >= this.options.batchSize) {
      this._processBatch();
    } else {
      // Schedule flush
      this._scheduleFlush();
    }
  }
  
  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    
    await this._processBatch();
  }
  
  _scheduleFlush() {
    if (this.flushTimer) return;
    
    const timeElapsed = this.oldestItemTime ? Date.now() - this.oldestItemTime : 0;
    const remainingTime = Math.max(0, 
      Math.min(this.options.flushInterval, this.options.maxWaitTime - timeElapsed)
    );
    
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this._processBatch();
    }, remainingTime);
  }
  
  async _processBatch() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    const batch = this.queue.splice(0, this.options.batchSize);
    this.oldestItemTime = this.queue.length > 0 ? Date.now() : null;
    
    try {
      const startTime = Date.now();
      
      if (this.options.parallel) {
        await Promise.all(batch.map(item => this.processor(item)));
      } else {
        await this.processor(batch);
      }
      
      const duration = Date.now() - startTime;
      
      // Update metrics
      this.metrics.itemsProcessed += batch.length;
      this.metrics.batchesProcessed++;
      this.metrics.avgBatchSize = 
        (this.metrics.avgBatchSize * (this.metrics.batchesProcessed - 1) + batch.length) / 
        this.metrics.batchesProcessed;
      
      this.emit('batch:processed', {
        size: batch.length,
        duration,
        itemsPerSecond: (batch.length / duration * 1000).toFixed(2)
      });
      
    } catch (error) {
      this.metrics.errors++;
      this.emit('batch:error', { error, batch });
      
      // Re-queue failed items if retry is enabled
      if (this.options.retry) {
        this.queue.unshift(...batch);
      }
    } finally {
      this.processing = false;
      
      // Process next batch if queue is not empty
      if (this.queue.length > 0) {
        setImmediate(() => this._processBatch());
      }
    }
  }
  
  getMetrics() {
    return {
      ...this.metrics,
      queueSize: this.queue.length,
      processing: this.processing
    };
  }
}

/**
 * Lazy initialization wrapper
 */
export class LazyInitializer {
  constructor(factory, options = {}) {
    this.factory = factory;
    this.options = {
      timeout: options.timeout || 5000,
      retry: options.retry || 3,
      cache: options.cache !== false,
      ...options
    };
    
    this.instance = null;
    this.initializing = null;
    this.initialized = false;
    this.attempts = 0;
  }
  
  async get() {
    if (this.initialized && this.options.cache) {
      return this.instance;
    }
    
    if (this.initializing) {
      return this.initializing;
    }
    
    this.initializing = this._initialize();
    
    try {
      this.instance = await this.initializing;
      this.initialized = true;
      return this.instance;
    } finally {
      this.initializing = null;
    }
  }
  
  async _initialize() {
    while (this.attempts < this.options.retry) {
      try {
        this.attempts++;
        
        const promise = this.factory();
        const timeout = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Initialization timeout')), this.options.timeout)
        );
        
        return await Promise.race([promise, timeout]);
      } catch (error) {
        if (this.attempts >= this.options.retry) {
          throw error;
        }
        
        // Exponential backoff
        await new Promise(resolve => 
          setTimeout(resolve, Math.pow(2, this.attempts) * 100)
        );
      }
    }
  }
  
  reset() {
    this.instance = null;
    this.initialized = false;
    this.attempts = 0;
  }
}

/**
 * Memoization decorator
 */
export function memoize(fn, options = {}) {
  const cache = new Map();
  const maxSize = options.maxSize || 1000;
  const ttl = options.ttl || 0;
  const keyGenerator = options.keyGenerator || ((...args) => JSON.stringify(args));
  
  const metrics = {
    hits: 0,
    misses: 0,
    evictions: 0
  };
  
  const memoized = function(...args) {
    const key = keyGenerator(...args);
    const cached = cache.get(key);
    
    if (cached) {
      if (!ttl || Date.now() - cached.timestamp < ttl) {
        metrics.hits++;
        return cached.value;
      }
      cache.delete(key);
    }
    
    metrics.misses++;
    
    const result = fn.apply(this, args);
    
    // Handle promises
    if (result && typeof result.then === 'function') {
      return result.then(value => {
        _addToCache(key, value);
        return value;
      });
    }
    
    _addToCache(key, result);
    return result;
  };
  
  function _addToCache(key, value) {
    // Evict oldest if at capacity
    if (cache.size >= maxSize) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
      metrics.evictions++;
    }
    
    cache.set(key, {
      value,
      timestamp: Date.now()
    });
  }
  
  memoized.clear = () => cache.clear();
  memoized.getMetrics = () => ({
    ...metrics,
    size: cache.size,
    hitRate: (metrics.hits + metrics.misses) > 0 ?
      (metrics.hits / (metrics.hits + metrics.misses) * 100).toFixed(2) + '%' : '0%'
  });
  
  return memoized;
}

/**
 * Debounce with leading and trailing options
 */
export function debounce(fn, wait, options = {}) {
  let timeout = null;
  let lastCallTime = null;
  let lastResult = null;
  
  const leading = options.leading || false;
  const trailing = options.trailing !== false;
  const maxWait = options.maxWait || 0;
  
  function debounced(...args) {
    const now = Date.now();
    
    if (!lastCallTime && !leading) {
      lastCallTime = now;
    }
    
    const remainingWait = wait - (now - lastCallTime);
    const overdue = maxWait && (now - lastCallTime) >= maxWait;
    
    if (remainingWait <= 0 || overdue) {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      lastCallTime = now;
      lastResult = fn.apply(this, args);
      return lastResult;
    }
    
    if (!timeout && trailing) {
      timeout = setTimeout(() => {
        lastCallTime = leading ? Date.now() : null;
        timeout = null;
        lastResult = fn.apply(this, args);
      }, remainingWait);
    }
    
    return lastResult;
  }
  
  debounced.cancel = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    lastCallTime = null;
  };
  
  debounced.flush = (...args) => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    lastCallTime = Date.now();
    lastResult = fn.apply(this, args);
    return lastResult;
  };
  
  return debounced;
}

/**
 * Worker thread pool for CPU-intensive tasks
 */
export class WorkerPool extends EventEmitter {
  constructor(workerScript, options = {}) {
    super();
    
    this.workerScript = workerScript;
    this.options = {
      minWorkers: options.minWorkers || 2,
      maxWorkers: options.maxWorkers || 4,
      idleTimeout: options.idleTimeout || 60000,
      taskTimeout: options.taskTimeout || 30000,
      ...options
    };
    
    this.workers = [];
    this.idleWorkers = [];
    this.taskQueue = [];
    this.activeJobs = new Map();
    
    this.metrics = {
      tasksProcessed: 0,
      tasksFailed: 0,
      averageTaskTime: 0
    };
    
    // Initialize minimum workers
    this._initializeWorkers();
  }
  
  async execute(data) {
    return new Promise((resolve, reject) => {
      const job = {
        id: Math.random().toString(36).substr(2, 9),
        data,
        resolve,
        reject,
        startTime: Date.now()
      };
      
      this.taskQueue.push(job);
      this._processQueue();
    });
  }
  
  _initializeWorkers() {
    for (let i = 0; i < this.options.minWorkers; i++) {
      this._createWorker();
    }
  }
  
  _createWorker() {
    const worker = new Worker(this.workerScript);
    const workerId = this.workers.length;
    
    worker.on('message', (result) => {
      const job = this.activeJobs.get(workerId);
      if (!job) return;
      
      this.activeJobs.delete(workerId);
      this.idleWorkers.push(workerId);
      
      // Update metrics
      const duration = Date.now() - job.startTime;
      this.metrics.tasksProcessed++;
      this.metrics.averageTaskTime = 
        (this.metrics.averageTaskTime * (this.metrics.tasksProcessed - 1) + duration) / 
        this.metrics.tasksProcessed;
      
      if (result.error) {
        this.metrics.tasksFailed++;
        job.reject(new Error(result.error));
      } else {
        job.resolve(result.data);
      }
      
      this._processQueue();
      this._checkIdleWorkers();
    });
    
    worker.on('error', (error) => {
      const job = this.activeJobs.get(workerId);
      if (job) {
        this.activeJobs.delete(workerId);
        this.metrics.tasksFailed++;
        job.reject(error);
      }
      
      // Replace failed worker
      this.workers[workerId] = null;
      this._createWorker();
    });
    
    this.workers.push(worker);
    this.idleWorkers.push(workerId);
  }
  
  _processQueue() {
    while (this.taskQueue.length > 0 && this.idleWorkers.length > 0) {
      const job = this.taskQueue.shift();
      const workerId = this.idleWorkers.shift();
      const worker = this.workers[workerId];
      
      this.activeJobs.set(workerId, job);
      
      // Set timeout
      job.timeout = setTimeout(() => {
        if (this.activeJobs.has(workerId)) {
          this.activeJobs.delete(workerId);
          this.metrics.tasksFailed++;
          job.reject(new Error('Task timeout'));
          
          // Terminate and replace worker
          worker.terminate();
          this.workers[workerId] = null;
          this._createWorker();
        }
      }, this.options.taskTimeout);
      
      worker.postMessage(job.data);
    }
    
    // Scale up if needed
    if (this.taskQueue.length > 0 && 
        this.workers.length < this.options.maxWorkers) {
      this._createWorker();
    }
  }
  
  _checkIdleWorkers() {
    // Scale down if too many idle workers
    if (this.idleWorkers.length > this.options.minWorkers) {
      setTimeout(() => {
        if (this.idleWorkers.length > this.options.minWorkers) {
          const workerId = this.idleWorkers.pop();
          const worker = this.workers[workerId];
          if (worker) {
            worker.terminate();
            this.workers[workerId] = null;
          }
        }
      }, this.options.idleTimeout);
    }
  }
  
  async terminate() {
    // Clear pending tasks
    for (const job of this.taskQueue) {
      job.reject(new Error('Worker pool terminated'));
    }
    this.taskQueue = [];
    
    // Terminate all workers
    await Promise.all(
      this.workers.map(worker => 
        worker ? worker.terminate() : Promise.resolve()
      )
    );
    
    this.workers = [];
    this.idleWorkers = [];
    this.activeJobs.clear();
  }
  
  getMetrics() {
    return {
      ...this.metrics,
      activeWorkers: this.workers.filter(w => w).length,
      idleWorkers: this.idleWorkers.length,
      queuedTasks: this.taskQueue.length,
      activeTasks: this.activeJobs.size
    };
  }
}

export default {
  ObjectPool,
  StringInterner,
  BatchProcessor,
  LazyInitializer,
  WorkerPool,
  memoize,
  debounce
};