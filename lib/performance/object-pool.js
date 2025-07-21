/**
 * Object Pool Implementation for Otedama
 * 
 * Provides efficient object reuse to reduce garbage collection pressure:
 * - Generic object pooling with customizable factory and reset functions
 * - Automatic pool size management
 * - Usage statistics and monitoring
 * - Integration with memory profiler
 * 
 * Following simplicity principles (Rob Pike)
 */

import { EventEmitter } from 'events';

/**
 * Generic Object Pool
 */
export class ObjectPool extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.options = {
      name: options.name || 'unnamed',
      factory: options.factory || (() => ({})),
      reset: options.reset || ((obj) => obj),
      validate: options.validate || (() => true),
      maxSize: options.maxSize || 100,
      minSize: options.minSize || 0,
      autoGrow: options.autoGrow !== false,
      growthFactor: options.growthFactor || 2,
      idleTimeout: options.idleTimeout || 600000, // 10 minutes
      ...options
    };
    
    // Pool storage
    this.available = [];
    this.inUse = new Set();
    
    // Statistics
    this.stats = {
      created: 0,
      destroyed: 0,
      acquired: 0,
      released: 0,
      reused: 0,
      validated: 0,
      failed: 0,
      currentSize: 0,
      peakSize: 0
    };
    
    // Initialize minimum pool size
    this.initialize();
  }

  /**
   * Initialize pool with minimum objects
   */
  initialize() {
    for (let i = 0; i < this.options.minSize; i++) {
      try {
        const obj = this.createObject();
        this.available.push({
          object: obj,
          lastUsed: Date.now(),
          useCount: 0
        });
      } catch (error) {
        this.emit('error', {
          operation: 'initialize',
          error: error.message
        });
      }
    }
  }

  /**
   * Acquire object from pool
   */
  acquire() {
    // Try to get from available pool
    let wrapper = null;
    
    while (this.available.length > 0 && !wrapper) {
      const candidate = this.available.pop();
      
      // Validate object
      if (this.options.validate(candidate.object)) {
        wrapper = candidate;
        this.stats.validated++;
      } else {
        // Object failed validation, destroy it
        this.destroyObject(candidate.object);
        this.stats.failed++;
      }
    }
    
    // Create new object if none available
    if (!wrapper) {
      if (this.canGrow()) {
        try {
          const obj = this.createObject();
          wrapper = {
            object: obj,
            lastUsed: Date.now(),
            useCount: 0
          };
          this.stats.created++;
        } catch (error) {
          this.emit('error', {
            operation: 'create',
            error: error.message
          });
          throw error;
        }
      } else {
        throw new Error(`Pool ${this.options.name} is at maximum capacity`);
      }
    } else {
      this.stats.reused++;
    }
    
    // Track usage
    wrapper.useCount++;
    wrapper.lastUsed = Date.now();
    this.inUse.add(wrapper);
    
    this.stats.acquired++;
    this.updateSize();
    
    this.emit('acquire', {
      poolSize: this.size,
      available: this.available.length,
      inUse: this.inUse.size
    });
    
    return wrapper.object;
  }

  /**
   * Release object back to pool
   */
  release(obj) {
    // Find wrapper
    let wrapper = null;
    for (const w of this.inUse) {
      if (w.object === obj) {
        wrapper = w;
        break;
      }
    }
    
    if (!wrapper) {
      this.emit('warning', {
        message: 'Attempted to release object not from this pool'
      });
      return false;
    }
    
    // Remove from in-use set
    this.inUse.delete(wrapper);
    
    // Reset object
    try {
      this.options.reset(obj);
      wrapper.lastUsed = Date.now();
      
      // Return to pool if under max size
      if (this.available.length < this.options.maxSize) {
        this.available.push(wrapper);
      } else {
        // Pool is full, destroy object
        this.destroyObject(obj);
      }
      
      this.stats.released++;
      this.updateSize();
      
      this.emit('release', {
        poolSize: this.size,
        available: this.available.length,
        inUse: this.inUse.size
      });
      
      return true;
      
    } catch (error) {
      // Reset failed, destroy object
      this.destroyObject(obj);
      this.emit('error', {
        operation: 'reset',
        error: error.message
      });
      return false;
    }
  }

  /**
   * Clear pool
   */
  clear() {
    // Destroy all available objects
    for (const wrapper of this.available) {
      this.destroyObject(wrapper.object);
    }
    this.available = [];
    
    // Note: objects in use will be destroyed when released
    
    this.emit('cleared');
  }

  /**
   * Get pool statistics
   */
  getStats() {
    const efficiency = this.stats.acquired > 0 
      ? this.stats.reused / this.stats.acquired 
      : 0;
    
    return {
      ...this.stats,
      efficiency: Math.round(efficiency * 100) / 100,
      available: this.available.length,
      inUse: this.inUse.size,
      totalSize: this.size
    };
  }

  /**
   * Prune idle objects
   */
  prune() {
    const now = Date.now();
    const timeout = this.options.idleTimeout;
    let pruned = 0;
    
    this.available = this.available.filter(wrapper => {
      if (now - wrapper.lastUsed > timeout && this.size > this.options.minSize) {
        this.destroyObject(wrapper.object);
        pruned++;
        return false;
      }
      return true;
    });
    
    if (pruned > 0) {
      this.updateSize();
      this.emit('pruned', { count: pruned });
    }
    
    return pruned;
  }

  /**
   * Resize pool
   */
  resize(newMax, newMin = null) {
    this.options.maxSize = newMax;
    if (newMin !== null) {
      this.options.minSize = newMin;
    }
    
    // Prune if necessary
    while (this.available.length > newMax) {
      const wrapper = this.available.pop();
      this.destroyObject(wrapper.object);
    }
    
    // Grow if necessary
    while (this.size < this.options.minSize) {
      try {
        const obj = this.createObject();
        this.available.push({
          object: obj,
          lastUsed: Date.now(),
          useCount: 0
        });
      } catch (error) {
        break;
      }
    }
    
    this.updateSize();
    this.emit('resized', {
      maxSize: this.options.maxSize,
      minSize: this.options.minSize,
      currentSize: this.size
    });
  }

  // Getters

  get size() {
    return this.available.length + this.inUse.size;
  }

  get name() {
    return this.options.name;
  }

  // Private methods

  createObject() {
    const obj = this.options.factory();
    this.stats.created++;
    this.stats.currentSize++;
    return obj;
  }

  destroyObject(obj) {
    if (this.options.destroy) {
      try {
        this.options.destroy(obj);
      } catch (error) {
        this.emit('error', {
          operation: 'destroy',
          error: error.message
        });
      }
    }
    
    this.stats.destroyed++;
    this.stats.currentSize--;
  }

  canGrow() {
    return this.options.autoGrow && this.size < this.options.maxSize;
  }

  updateSize() {
    this.stats.currentSize = this.size;
    this.stats.peakSize = Math.max(this.stats.peakSize, this.size);
  }
}

/**
 * Specialized Buffer Pool
 */
export class BufferPool extends ObjectPool {
  constructor(bufferSize, options = {}) {
    super({
      name: options.name || `buffer-${bufferSize}`,
      factory: () => Buffer.allocUnsafe(bufferSize),
      reset: (buffer) => buffer.fill(0),
      validate: (buffer) => buffer.length === bufferSize,
      ...options
    });
    
    this.bufferSize = bufferSize;
  }
}

/**
 * Specialized Array Pool
 */
export class ArrayPool extends ObjectPool {
  constructor(options = {}) {
    super({
      name: options.name || 'array',
      factory: () => [],
      reset: (arr) => { arr.length = 0; return arr; },
      validate: (arr) => Array.isArray(arr),
      ...options
    });
  }
}

/**
 * Specialized Map Pool
 */
export class MapPool extends ObjectPool {
  constructor(options = {}) {
    super({
      name: options.name || 'map',
      factory: () => new Map(),
      reset: (map) => { map.clear(); return map; },
      validate: (map) => map instanceof Map,
      ...options
    });
  }
}

/**
 * Specialized Set Pool
 */
export class SetPool extends ObjectPool {
  constructor(options = {}) {
    super({
      name: options.name || 'set',
      factory: () => new Set(),
      reset: (set) => { set.clear(); return set; },
      validate: (set) => set instanceof Set,
      ...options
    });
  }
}

/**
 * Pool Manager - Manages multiple pools
 */
export class PoolManager extends EventEmitter {
  constructor() {
    super();
    this.pools = new Map();
    this.stats = {
      totalAcquired: 0,
      totalReleased: 0,
      totalCreated: 0,
      totalDestroyed: 0
    };
    
    // Periodic maintenance
    this.maintenanceInterval = setInterval(() => {
      this.performMaintenance();
    }, 60000); // Every minute
  }

  /**
   * Register a pool
   */
  register(pool) {
    const name = pool.name;
    
    if (this.pools.has(name)) {
      throw new Error(`Pool ${name} already registered`);
    }
    
    this.pools.set(name, pool);
    
    // Forward events
    pool.on('acquire', () => this.stats.totalAcquired++);
    pool.on('release', () => this.stats.totalReleased++);
    pool.on('error', (error) => this.emit('pool:error', { pool: name, ...error }));
    
    this.emit('pool:registered', { name });
  }

  /**
   * Get pool by name
   */
  getPool(name) {
    return this.pools.get(name);
  }

  /**
   * Create and register a pool
   */
  createPool(name, options) {
    const pool = new ObjectPool({ name, ...options });
    this.register(pool);
    return pool;
  }

  /**
   * Create specialized pools
   */
  createBufferPool(name, size, options) {
    const pool = new BufferPool(size, { name, ...options });
    this.register(pool);
    return pool;
  }

  createArrayPool(name, options) {
    const pool = new ArrayPool({ name, ...options });
    this.register(pool);
    return pool;
  }

  createMapPool(name, options) {
    const pool = new MapPool({ name, ...options });
    this.register(pool);
    return pool;
  }

  createSetPool(name, options) {
    const pool = new SetPool({ name, ...options });
    this.register(pool);
    return pool;
  }

  /**
   * Get all pool statistics
   */
  getStats() {
    const poolStats = {};
    
    for (const [name, pool] of this.pools.entries()) {
      poolStats[name] = pool.getStats();
    }
    
    return {
      global: this.stats,
      pools: poolStats,
      summary: {
        totalPools: this.pools.size,
        totalObjects: Array.from(this.pools.values())
          .reduce((sum, pool) => sum + pool.size, 0),
        totalAvailable: Array.from(this.pools.values())
          .reduce((sum, pool) => sum + pool.available.length, 0),
        totalInUse: Array.from(this.pools.values())
          .reduce((sum, pool) => sum + pool.inUse.size, 0)
      }
    };
  }

  /**
   * Perform maintenance on all pools
   */
  performMaintenance() {
    let totalPruned = 0;
    
    for (const [name, pool] of this.pools.entries()) {
      const pruned = pool.prune();
      totalPruned += pruned;
    }
    
    if (totalPruned > 0) {
      this.emit('maintenance', { pruned: totalPruned });
    }
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
   * Cleanup
   */
  cleanup() {
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
    }
    
    this.clearAll();
    this.pools.clear();
    this.removeAllListeners();
  }
}

// Default pool manager instance
export const defaultPoolManager = new PoolManager();

export default ObjectPool;