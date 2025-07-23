const EventEmitter = require('events');

class AdvancedObjectPool extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Pool configuration
      initialSize: options.initialSize || 10,
      maxSize: options.maxSize || 1000,
      minSize: options.minSize || 5,
      
      // Growth strategy
      growthFactor: options.growthFactor || 2,
      shrinkThreshold: options.shrinkThreshold || 0.25,
      shrinkFactor: options.shrinkFactor || 0.5,
      
      // Timing
      acquireTimeout: options.acquireTimeout || 30000,
      idleTimeout: options.idleTimeout || 300000,
      evictionInterval: options.evictionInterval || 60000,
      
      // Validation
      validateOnAcquire: options.validateOnAcquire !== false,
      validateOnRelease: options.validateOnRelease !== false,
      
      // Factory functions
      factory: options.factory || this.defaultFactory,
      destroyer: options.destroyer || this.defaultDestroyer,
      validator: options.validator || this.defaultValidator,
      resetter: options.resetter || this.defaultResetter
    };
    
    // Pool state
    this.available = [];
    this.inUse = new Map();
    this.waitQueue = [];
    
    // Statistics
    this.stats = {
      created: 0,
      destroyed: 0,
      acquired: 0,
      released: 0,
      validated: 0,
      evicted: 0,
      timeouts: 0,
      errors: 0,
      currentSize: 0,
      peakSize: 0,
      totalWaitTime: 0,
      totalUseTime: 0
    };
    
    // Initialize pool
    this.initialize();
  }
  
  async initialize() {
    this.emit('initializing');
    
    try {
      // Create initial objects
      const promises = [];
      for (let i = 0; i < this.config.initialSize; i++) {
        promises.push(this.createObject());
      }
      
      await Promise.all(promises);
      
      // Start eviction timer
      this.startEvictionTimer();
      
      this.emit('initialized', {
        size: this.available.length
      });
      
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  async createObject() {
    try {
      const obj = await this.config.factory();
      
      const pooledObject = {
        object: obj,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        useCount: 0,
        state: 'available',
        id: this.generateId()
      };
      
      this.available.push(pooledObject);
      this.stats.created++;
      this.stats.currentSize++;
      
      if (this.stats.currentSize > this.stats.peakSize) {
        this.stats.peakSize = this.stats.currentSize;
      }
      
      this.emit('object:created', pooledObject);
      
      return pooledObject;
      
    } catch (error) {
      this.stats.errors++;
      this.emit('error', error);
      throw error;
    }
  }
  
  async acquire() {
    const startTime = Date.now();
    
    try {
      // Try to get available object
      let pooledObject = await this.getAvailableObject();
      
      if (!pooledObject) {
        // No available objects, try to create new one
        if (this.stats.currentSize < this.config.maxSize) {
          pooledObject = await this.createObject();
        } else {
          // Pool is full, wait for available object
          pooledObject = await this.waitForObject();
        }
      }
      
      if (!pooledObject) {
        throw new Error('Failed to acquire object from pool');
      }
      
      // Validate if enabled
      if (this.config.validateOnAcquire) {
        const isValid = await this.validateObject(pooledObject);
        if (!isValid) {
          await this.destroyObject(pooledObject);
          return this.acquire(); // Retry
        }
      }
      
      // Mark as in use
      pooledObject.state = 'inUse';
      pooledObject.lastUsedAt = Date.now();
      pooledObject.useCount++;
      pooledObject.acquiredAt = Date.now();
      
      this.inUse.set(pooledObject.id, pooledObject);
      
      // Update stats
      this.stats.acquired++;
      const waitTime = Date.now() - startTime;
      this.stats.totalWaitTime += waitTime;
      
      this.emit('object:acquired', {
        id: pooledObject.id,
        waitTime
      });
      
      return pooledObject.object;
      
    } catch (error) {
      this.stats.errors++;
      this.emit('error', error);
      throw error;
    }
  }
  
  async release(obj) {
    try {
      // Find pooled object
      let pooledObject = null;
      for (const [id, po] of this.inUse) {
        if (po.object === obj) {
          pooledObject = po;
          break;
        }
      }
      
      if (!pooledObject) {
        throw new Error('Object not found in pool');
      }
      
      // Remove from in-use
      this.inUse.delete(pooledObject.id);
      
      // Validate if enabled
      if (this.config.validateOnRelease) {
        const isValid = await this.validateObject(pooledObject);
        if (!isValid) {
          await this.destroyObject(pooledObject);
          await this.ensureMinimumSize();
          return;
        }
      }
      
      // Reset object
      await this.config.resetter(pooledObject.object);
      
      // Update state
      pooledObject.state = 'available';
      const useTime = Date.now() - pooledObject.acquiredAt;
      this.stats.totalUseTime += useTime;
      
      // Check if pool should shrink
      if (this.shouldShrink()) {
        await this.destroyObject(pooledObject);
      } else {
        // Return to available pool
        this.available.push(pooledObject);
        
        // Notify waiting requests
        if (this.waitQueue.length > 0) {
          const waiter = this.waitQueue.shift();
          waiter.resolve(pooledObject);
        }
      }
      
      this.stats.released++;
      
      this.emit('object:released', {
        id: pooledObject.id,
        useTime
      });
      
    } catch (error) {
      this.stats.errors++;
      this.emit('error', error);
      throw error;
    }
  }
  
  async getAvailableObject() {
    while (this.available.length > 0) {
      const pooledObject = this.available.shift();
      
      // Check if object is still valid
      if (this.isObjectExpired(pooledObject)) {
        await this.destroyObject(pooledObject);
        continue;
      }
      
      return pooledObject;
    }
    
    return null;
  }
  
  async waitForObject() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waitQueue.findIndex(w => w.resolve === resolve);
        if (index !== -1) {
          this.waitQueue.splice(index, 1);
        }
        
        this.stats.timeouts++;
        reject(new Error('Acquire timeout'));
      }, this.config.acquireTimeout);
      
      this.waitQueue.push({
        resolve: (obj) => {
          clearTimeout(timeout);
          resolve(obj);
        },
        reject,
        timeout
      });
    });
  }
  
  async validateObject(pooledObject) {
    try {
      const isValid = await this.config.validator(pooledObject.object);
      this.stats.validated++;
      return isValid;
    } catch (error) {
      return false;
    }
  }
  
  async destroyObject(pooledObject) {
    try {
      await this.config.destroyer(pooledObject.object);
      
      // Remove from available or in-use
      const availableIndex = this.available.indexOf(pooledObject);
      if (availableIndex !== -1) {
        this.available.splice(availableIndex, 1);
      }
      
      this.inUse.delete(pooledObject.id);
      
      this.stats.destroyed++;
      this.stats.currentSize--;
      
      this.emit('object:destroyed', {
        id: pooledObject.id
      });
      
    } catch (error) {
      this.emit('error', error);
    }
  }
  
  isObjectExpired(pooledObject) {
    const idleTime = Date.now() - pooledObject.lastUsedAt;
    return idleTime > this.config.idleTimeout;
  }
  
  shouldShrink() {
    const utilizationRate = this.inUse.size / this.stats.currentSize;
    return utilizationRate < this.config.shrinkThreshold && 
           this.stats.currentSize > this.config.minSize;
  }
  
  async ensureMinimumSize() {
    const deficit = this.config.minSize - this.stats.currentSize;
    
    if (deficit > 0) {
      const promises = [];
      for (let i = 0; i < deficit; i++) {
        promises.push(this.createObject());
      }
      
      await Promise.all(promises);
    }
  }
  
  startEvictionTimer() {
    this.evictionInterval = setInterval(() => {
      this.evictExpiredObjects();
    }, this.config.evictionInterval);
  }
  
  async evictExpiredObjects() {
    const toEvict = [];
    
    for (let i = this.available.length - 1; i >= 0; i--) {
      const pooledObject = this.available[i];
      
      if (this.isObjectExpired(pooledObject)) {
        toEvict.push(pooledObject);
        this.available.splice(i, 1);
      }
    }
    
    for (const pooledObject of toEvict) {
      await this.destroyObject(pooledObject);
      this.stats.evicted++;
    }
    
    // Ensure minimum size
    await this.ensureMinimumSize();
    
    if (toEvict.length > 0) {
      this.emit('eviction:completed', {
        evicted: toEvict.length,
        currentSize: this.stats.currentSize
      });
    }
  }
  
  async grow() {
    const currentSize = this.stats.currentSize;
    const targetSize = Math.min(
      currentSize * this.config.growthFactor,
      this.config.maxSize
    );
    
    const toCreate = Math.floor(targetSize - currentSize);
    
    if (toCreate > 0) {
      const promises = [];
      for (let i = 0; i < toCreate; i++) {
        promises.push(this.createObject());
      }
      
      await Promise.all(promises);
      
      this.emit('pool:grown', {
        previousSize: currentSize,
        newSize: this.stats.currentSize
      });
    }
  }
  
  async shrink() {
    const currentSize = this.stats.currentSize;
    const targetSize = Math.max(
      currentSize * this.config.shrinkFactor,
      this.config.minSize
    );
    
    const toRemove = Math.floor(currentSize - targetSize);
    
    if (toRemove > 0) {
      const removed = [];
      
      for (let i = 0; i < toRemove && this.available.length > 0; i++) {
        const pooledObject = this.available.shift();
        await this.destroyObject(pooledObject);
        removed.push(pooledObject.id);
      }
      
      this.emit('pool:shrunk', {
        previousSize: currentSize,
        newSize: this.stats.currentSize,
        removed
      });
    }
  }
  
  async drain() {
    this.emit('draining');
    
    // Stop eviction timer
    if (this.evictionInterval) {
      clearInterval(this.evictionInterval);
    }
    
    // Reject all waiting requests
    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift();
      waiter.reject(new Error('Pool is draining'));
    }
    
    // Wait for all in-use objects to be released
    while (this.inUse.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Destroy all available objects
    while (this.available.length > 0) {
      const pooledObject = this.available.shift();
      await this.destroyObject(pooledObject);
    }
    
    this.emit('drained');
  }
  
  // Default implementations
  
  defaultFactory() {
    return {};
  }
  
  defaultDestroyer(obj) {
    // No-op
  }
  
  defaultValidator(obj) {
    return true;
  }
  
  defaultResetter(obj) {
    // No-op
  }
  
  generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  // Statistics and monitoring
  
  getStats() {
    const avgWaitTime = this.stats.acquired > 0
      ? this.stats.totalWaitTime / this.stats.acquired
      : 0;
    
    const avgUseTime = this.stats.released > 0
      ? this.stats.totalUseTime / this.stats.released
      : 0;
    
    return {
      ...this.stats,
      available: this.available.length,
      inUse: this.inUse.size,
      waiting: this.waitQueue.length,
      utilizationRate: this.stats.currentSize > 0
        ? this.inUse.size / this.stats.currentSize
        : 0,
      averageWaitTime: avgWaitTime,
      averageUseTime: avgUseTime
    };
  }
  
  getHealthStatus() {
    const stats = this.getStats();
    const issues = [];
    
    // Check utilization
    if (stats.utilizationRate > 0.9) {
      issues.push({
        severity: 'warning',
        message: 'High pool utilization',
        value: stats.utilizationRate
      });
    }
    
    // Check wait queue
    if (stats.waiting > 10) {
      issues.push({
        severity: 'warning',
        message: 'Large wait queue',
        value: stats.waiting
      });
    }
    
    // Check timeouts
    const timeoutRate = stats.timeouts / (stats.acquired || 1);
    if (timeoutRate > 0.05) {
      issues.push({
        severity: 'critical',
        message: 'High timeout rate',
        value: timeoutRate
      });
    }
    
    // Check errors
    const errorRate = stats.errors / (stats.created + stats.acquired || 1);
    if (errorRate > 0.01) {
      issues.push({
        severity: 'warning',
        message: 'Elevated error rate',
        value: errorRate
      });
    }
    
    return {
      healthy: issues.length === 0,
      issues,
      stats
    };
  }
}

// Specialized pool implementations

class BufferPool extends AdvancedObjectPool {
  constructor(bufferSize, options = {}) {
    super({
      ...options,
      factory: () => Buffer.allocUnsafe(bufferSize),
      resetter: (buffer) => buffer.fill(0),
      validator: (buffer) => buffer.length === bufferSize
    });
    
    this.bufferSize = bufferSize;
  }
}

class ConnectionPool extends AdvancedObjectPool {
  constructor(connectionFactory, options = {}) {
    super({
      ...options,
      factory: connectionFactory,
      destroyer: async (conn) => {
        if (conn && typeof conn.close === 'function') {
          await conn.close();
        }
      },
      validator: async (conn) => {
        if (!conn) return false;
        if (typeof conn.ping === 'function') {
          try {
            await conn.ping();
            return true;
          } catch {
            return false;
          }
        }
        return true;
      },
      resetter: async (conn) => {
        if (conn && typeof conn.reset === 'function') {
          await conn.reset();
        }
      }
    });
  }
}

class WorkerPool extends AdvancedObjectPool {
  constructor(workerScript, options = {}) {
    const { Worker } = require('worker_threads');
    
    super({
      ...options,
      factory: () => new Worker(workerScript),
      destroyer: async (worker) => {
        await worker.terminate();
      },
      validator: (worker) => {
        return worker && !worker.threadId === -1;
      },
      resetter: async (worker) => {
        // Send reset message to worker
        worker.postMessage({ type: 'reset' });
      }
    });
    
    this.workerScript = workerScript;
  }
  
  async execute(task) {
    const worker = await this.acquire();
    
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Worker timeout'));
        }, task.timeout || 30000);
        
        worker.once('message', (result) => {
          clearTimeout(timeout);
          resolve(result);
        });
        
        worker.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        
        worker.postMessage(task);
      });
    } finally {
      await this.release(worker);
    }
  }
}

// Global pool registry
class PoolRegistry {
  constructor() {
    this.pools = new Map();
  }
  
  register(name, pool) {
    if (this.pools.has(name)) {
      throw new Error(`Pool ${name} already registered`);
    }
    
    this.pools.set(name, pool);
  }
  
  get(name) {
    const pool = this.pools.get(name);
    if (!pool) {
      throw new Error(`Pool ${name} not found`);
    }
    
    return pool;
  }
  
  async drainAll() {
    const promises = [];
    
    for (const [name, pool] of this.pools) {
      promises.push(pool.drain());
    }
    
    await Promise.all(promises);
  }
  
  getAllStats() {
    const stats = {};
    
    for (const [name, pool] of this.pools) {
      stats[name] = pool.getStats();
    }
    
    return stats;
  }
}

const globalRegistry = new PoolRegistry();

module.exports = {
  AdvancedObjectPool,
  BufferPool,
  ConnectionPool,
  WorkerPool,
  PoolRegistry,
  globalRegistry
};