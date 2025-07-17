/**
 * Performance Module for Otedama Ver0.6
 * Implements critical performance optimizations
 */

import { createHash } from 'crypto';
import { Worker } from 'worker_threads';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Database connection pool
 */
export class ConnectionPool {
  constructor(dbClass, dbPath, options = {}) {
    this.dbClass = dbClass;
    this.dbPath = dbPath;
    this.options = {
      min: options.min || 2,
      max: options.max || 10,
      idleTimeout: options.idleTimeout || 30000,
      acquireTimeout: options.acquireTimeout || 5000,
      ...options
    };
    
    this.pool = [];
    this.activeConnections = new Map();
    this.waitingQueue = [];
    this.stats = {
      created: 0,
      acquired: 0,
      released: 0,
      destroyed: 0,
      waiting: 0
    };
    
    // Initialize minimum connections
    this.initialize();
  }
  
  async initialize() {
    const promises = [];
    for (let i = 0; i < this.options.min; i++) {
      promises.push(this.createConnection());
    }
    await Promise.all(promises);
  }
  
  createConnection() {
    return new Promise((resolve) => {
      const connection = new this.dbClass(this.dbPath, this.options);
      const wrapped = {
        db: connection,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        inUse: false
      };
      
      this.pool.push(wrapped);
      this.stats.created++;
      resolve(wrapped);
    });
  }
  
  async acquire() {
    const startTime = Date.now();
    
    // Try to find an idle connection
    for (const conn of this.pool) {
      if (!conn.inUse) {
        conn.inUse = true;
        conn.lastUsed = Date.now();
        this.activeConnections.set(conn, Date.now());
        this.stats.acquired++;
        return conn.db;
      }
    }
    
    // Create new connection if under max limit
    if (this.pool.length < this.options.max) {
      const conn = await this.createConnection();
      conn.inUse = true;
      conn.lastUsed = Date.now();
      this.activeConnections.set(conn, Date.now());
      this.stats.acquired++;
      return conn.db;
    }
    
    // Wait for available connection
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waitingQueue.indexOf(waiter);
        if (index > -1) {
          this.waitingQueue.splice(index, 1);
        }
        reject(new Error('Connection acquire timeout'));
      }, this.options.acquireTimeout - (Date.now() - startTime));
      
      const waiter = { resolve, reject, timeout };
      this.waitingQueue.push(waiter);
      this.stats.waiting++;
    });
  }
  
  release(db) {
    for (const [conn, acquireTime] of this.activeConnections) {
      if (conn.db === db) {
        conn.inUse = false;
        conn.lastUsed = Date.now();
        this.activeConnections.delete(conn);
        this.stats.released++;
        
        // Process waiting queue
        if (this.waitingQueue.length > 0) {
          const waiter = this.waitingQueue.shift();
          clearTimeout(waiter.timeout);
          conn.inUse = true;
          this.activeConnections.set(conn, Date.now());
          this.stats.acquired++;
          this.stats.waiting--;
          waiter.resolve(conn.db);
        }
        
        return;
      }
    }
  }
  
  async destroy(db) {
    for (let i = 0; i < this.pool.length; i++) {
      if (this.pool[i].db === db) {
        const conn = this.pool[i];
        this.pool.splice(i, 1);
        this.activeConnections.delete(conn);
        conn.db.close();
        this.stats.destroyed++;
        
        // Maintain minimum connections
        if (this.pool.length < this.options.min) {
          await this.createConnection();
        }
        return;
      }
    }
  }
  
  // Cleanup idle connections
  startIdleCheck() {
    setInterval(() => {
      const now = Date.now();
      const toRemove = [];
      
      for (const conn of this.pool) {
        if (!conn.inUse && 
            this.pool.length > this.options.min &&
            now - conn.lastUsed > this.options.idleTimeout) {
          toRemove.push(conn);
        }
      }
      
      for (const conn of toRemove) {
        this.destroy(conn.db);
      }
    }, this.options.idleTimeout / 2);
  }
  
  getStats() {
    return {
      ...this.stats,
      total: this.pool.length,
      active: this.activeConnections.size,
      idle: this.pool.length - this.activeConnections.size
    };
  }
}

/**
 * Query result caching
 */
export class QueryCache {
  constructor(options = {}) {
    this.cache = new Map();
    this.options = {
      maxSize: options.maxSize || 1000,
      ttl: options.ttl || 60000, // 1 minute default
      checkInterval: options.checkInterval || 30000, // 30 seconds
      ...options
    };
    
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0
    };
    
    // Start cleanup interval
    this.startCleanup();
  }
  
  generateKey(query, params = []) {
    const data = JSON.stringify({ query, params });
    return createHash('sha256').update(data).digest('hex');
  }
  
  get(query, params) {
    const key = this.generateKey(query, params);
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }
    
    this.stats.hits++;
    entry.lastAccess = Date.now();
    entry.accessCount++;
    return entry.data;
  }
  
  set(query, params, data, ttl = this.options.ttl) {
    const key = this.generateKey(query, params);
    
    // Evict if at capacity
    if (this.cache.size >= this.options.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }
    
    this.cache.set(key, {
      data,
      expiry: Date.now() + ttl,
      lastAccess: Date.now(),
      accessCount: 1,
      size: JSON.stringify(data).length
    });
    
    this.stats.sets++;
  }
  
  delete(query, params) {
    const key = this.generateKey(query, params);
    if (this.cache.delete(key)) {
      this.stats.deletes++;
      return true;
    }
    return false;
  }
  
  invalidate(pattern) {
    let count = 0;
    for (const [key, entry] of this.cache) {
      if (pattern.test(key)) {
        this.cache.delete(key);
        count++;
      }
    }
    this.stats.deletes += count;
    return count;
  }
  
  evictLRU() {
    let oldest = null;
    let oldestKey = null;
    
    for (const [key, entry] of this.cache) {
      if (!oldest || entry.lastAccess < oldest.lastAccess) {
        oldest = entry;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }
  }
  
  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      let count = 0;
      
      for (const [key, entry] of this.cache) {
        if (now > entry.expiry) {
          this.cache.delete(key);
          count++;
        }
      }
      
      if (count > 0) {
        this.stats.evictions += count;
      }
    }, this.options.checkInterval);
  }
  
  clear() {
    const size = this.cache.size;
    this.cache.clear();
    this.stats.deletes += size;
  }
  
  getStats() {
    const entries = Array.from(this.cache.values());
    const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
    
    return {
      ...this.stats,
      size: this.cache.size,
      totalSize,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0
    };
  }
}

/**
 * Request batching and coalescing
 */
export class RequestBatcher {
  constructor(options = {}) {
    this.options = {
      maxBatchSize: options.maxBatchSize || 100,
      maxWaitTime: options.maxWaitTime || 10,
      processor: options.processor || null,
      ...options
    };
    
    this.batch = [];
    this.callbacks = new Map();
    this.timer = null;
    this.processing = false;
  }
  
  add(request, callback) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).substr(2, 9);
      
      this.batch.push({ id, request });
      this.callbacks.set(id, { resolve, reject, callback });
      
      if (this.batch.length >= this.options.maxBatchSize) {
        this.processBatch();
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.processBatch(), this.options.maxWaitTime);
      }
    });
  }
  
  async processBatch() {
    if (this.processing || this.batch.length === 0) return;
    
    this.processing = true;
    clearTimeout(this.timer);
    this.timer = null;
    
    const currentBatch = [...this.batch];
    const currentCallbacks = new Map(this.callbacks);
    
    this.batch = [];
    this.callbacks.clear();
    
    try {
      const results = await this.options.processor(currentBatch);
      
      for (let i = 0; i < currentBatch.length; i++) {
        const { id } = currentBatch[i];
        const callback = currentCallbacks.get(id);
        
        if (callback) {
          const result = results[i];
          if (result.error) {
            callback.reject(result.error);
          } else {
            callback.resolve(result.data);
            if (callback.callback) {
              callback.callback(null, result.data);
            }
          }
        }
      }
    } catch (error) {
      for (const callback of currentCallbacks.values()) {
        callback.reject(error);
        if (callback.callback) {
          callback.callback(error);
        }
      }
    } finally {
      this.processing = false;
      
      if (this.batch.length > 0) {
        this.processBatch();
      }
    }
  }
}

/**
 * Worker thread pool for CPU-intensive tasks
 */
export class WorkerPool {
  constructor(workerScript, options = {}) {
    this.workerScript = workerScript;
    this.options = {
      min: options.min || 2,
      max: options.max || cpus().length,
      idleTimeout: options.idleTimeout || 60000,
      taskTimeout: options.taskTimeout || 30000,
      ...options
    };
    
    this.workers = [];
    this.idleWorkers = [];
    this.taskQueue = [];
    this.stats = {
      created: 0,
      tasks: 0,
      completed: 0,
      failed: 0,
      timeouts: 0
    };
    
    this.initialize();
  }
  
  initialize() {
    for (let i = 0; i < this.options.min; i++) {
      this.createWorker();
    }
  }
  
  createWorker() {
    const worker = new Worker(this.workerScript);
    const workerInfo = {
      worker,
      busy: false,
      lastUsed: Date.now(),
      createdAt: Date.now(),
      taskCount: 0
    };
    
    worker.on('message', (result) => {
      const task = workerInfo.currentTask;
      if (task) {
        clearTimeout(task.timeout);
        task.resolve(result);
        this.stats.completed++;
      }
      
      workerInfo.busy = false;
      workerInfo.currentTask = null;
      workerInfo.lastUsed = Date.now();
      workerInfo.taskCount++;
      
      this.idleWorkers.push(workerInfo);
      this.processQueue();
    });
    
    worker.on('error', (error) => {
      const task = workerInfo.currentTask;
      if (task) {
        clearTimeout(task.timeout);
        task.reject(error);
        this.stats.failed++;
      }
      
      this.removeWorker(workerInfo);
      
      if (this.workers.length < this.options.min) {
        this.createWorker();
      }
    });
    
    this.workers.push(workerInfo);
    this.idleWorkers.push(workerInfo);
    this.stats.created++;
  }
  
  async execute(data) {
    return new Promise((resolve, reject) => {
      const task = {
        data,
        resolve,
        reject,
        timeout: setTimeout(() => {
          reject(new Error('Task timeout'));
          this.stats.timeouts++;
        }, this.options.taskTimeout)
      };
      
      this.taskQueue.push(task);
      this.stats.tasks++;
      this.processQueue();
    });
  }
  
  processQueue() {
    while (this.taskQueue.length > 0 && this.idleWorkers.length > 0) {
      const task = this.taskQueue.shift();
      const workerInfo = this.idleWorkers.shift();
      
      workerInfo.busy = true;
      workerInfo.currentTask = task;
      workerInfo.worker.postMessage(task.data);
    }
    
    // Create new worker if needed and under limit
    if (this.taskQueue.length > 0 && 
        this.workers.length < this.options.max &&
        this.idleWorkers.length === 0) {
      this.createWorker();
    }
  }
  
  removeWorker(workerInfo) {
    const index = this.workers.indexOf(workerInfo);
    if (index > -1) {
      this.workers.splice(index, 1);
    }
    
    const idleIndex = this.idleWorkers.indexOf(workerInfo);
    if (idleIndex > -1) {
      this.idleWorkers.splice(idleIndex, 1);
    }
    
    workerInfo.worker.terminate();
  }
  
  // Cleanup idle workers
  startIdleCheck() {
    setInterval(() => {
      const now = Date.now();
      const toRemove = [];
      
      for (const workerInfo of this.idleWorkers) {
        if (this.workers.length > this.options.min &&
            now - workerInfo.lastUsed > this.options.idleTimeout) {
          toRemove.push(workerInfo);
        }
      }
      
      for (const workerInfo of toRemove) {
        this.removeWorker(workerInfo);
      }
    }, this.options.idleTimeout / 2);
  }
  
  terminate() {
    for (const workerInfo of this.workers) {
      workerInfo.worker.terminate();
    }
    this.workers = [];
    this.idleWorkers = [];
    this.taskQueue = [];
  }
  
  getStats() {
    return {
      ...this.stats,
      workers: this.workers.length,
      idle: this.idleWorkers.length,
      busy: this.workers.length - this.idleWorkers.length,
      queued: this.taskQueue.length
    };
  }
}

/**
 * Response compression middleware
 */
export async function compress(data, encoding = 'gzip') {
  if (encoding === 'gzip') {
    return await gzipAsync(data);
  }
  return data;
}

export async function decompress(data, encoding = 'gzip') {
  if (encoding === 'gzip') {
    return await gunzipAsync(data);
  }
  return data;
}

/**
 * Memory pool for efficient allocation
 */
export class MemoryPool {
  constructor(options = {}) {
    this.options = {
      blockSize: options.blockSize || 4096,
      maxBlocks: options.maxBlocks || 1000,
      ...options
    };
    
    this.freeBlocks = [];
    this.usedBlocks = new Map();
    this.stats = {
      allocated: 0,
      freed: 0,
      reused: 0
    };
    
    this.initialize();
  }
  
  initialize() {
    for (let i = 0; i < this.options.maxBlocks; i++) {
      this.freeBlocks.push(Buffer.allocUnsafe(this.options.blockSize));
    }
  }
  
  allocate(size) {
    if (size > this.options.blockSize) {
      return Buffer.allocUnsafe(size);
    }
    
    if (this.freeBlocks.length > 0) {
      const block = this.freeBlocks.pop();
      const id = Math.random().toString(36).substr(2, 9);
      this.usedBlocks.set(id, block);
      this.stats.reused++;
      return { id, buffer: block.slice(0, size) };
    }
    
    this.stats.allocated++;
    return { id: null, buffer: Buffer.allocUnsafe(size) };
  }
  
  free(id) {
    if (!id) return;
    
    const block = this.usedBlocks.get(id);
    if (block) {
      this.usedBlocks.delete(id);
      this.freeBlocks.push(block);
      this.stats.freed++;
    }
  }
  
  getStats() {
    return {
      ...this.stats,
      free: this.freeBlocks.length,
      used: this.usedBlocks.size,
      total: this.freeBlocks.length + this.usedBlocks.size
    };
  }
}

/**
 * Lazy loading wrapper
 */
export class LazyLoader {
  constructor(loader, options = {}) {
    this.loader = loader;
    this.options = {
      cache: options.cache !== false,
      ttl: options.ttl || 300000, // 5 minutes
      ...options
    };
    
    this.data = null;
    this.loading = false;
    this.loadPromise = null;
    this.lastLoad = 0;
  }
  
  async get() {
    const now = Date.now();
    
    // Return cached data if valid
    if (this.data && this.options.cache && 
        now - this.lastLoad < this.options.ttl) {
      return this.data;
    }
    
    // If already loading, wait for current load
    if (this.loading) {
      return await this.loadPromise;
    }
    
    // Start new load
    this.loading = true;
    this.loadPromise = this.loader();
    
    try {
      this.data = await this.loadPromise;
      this.lastLoad = now;
      return this.data;
    } finally {
      this.loading = false;
      this.loadPromise = null;
    }
  }
  
  invalidate() {
    this.data = null;
    this.lastLoad = 0;
  }
}