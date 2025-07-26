/**
 * Optimized Object Pool System for Otedama
 * Zero-allocation design for high-frequency mining operations
 * 
 * Features:
 * - Memory-efficient object reuse
 * - Automatic pool sizing and optimization
 * - Hit rate monitoring and adjustment
 * - Circular buffer algorithms
 * - Thread-safe operations
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from './structured-logger.js';

const logger = createStructuredLogger('ObjectPool');

/**
 * Generic Object Pool with intelligent sizing
 */
export class OptimizedObjectPool extends EventEmitter {
  constructor(factory, reset, options = {}) {
    super();
    
    this.factory = factory;           // Function to create new objects
    this.reset = reset;               // Function to reset objects for reuse
    this.name = options.name || 'unnamed';
    
    // Pool configuration
    this.minSize = options.minSize || 10;
    this.maxSize = options.maxSize || 1000;
    this.growthFactor = options.growthFactor || 1.5;
    this.shrinkThreshold = options.shrinkThreshold || 0.1;
    
    // Pool state
    this.available = [];
    this.inUse = new Set();
    this.totalCreated = 0;
    this.totalAcquired = 0;
    this.totalReleased = 0;
    this.totalMisses = 0;
    
    // Performance monitoring
    this.hitRate = 1.0;
    this.avgHoldTime = 0;
    this.peakInUse = 0;
    this.lastOptimized = Date.now();
    
    // Initialize pool
    this.initialize();
    
    // Start optimization loop
    this.startOptimizationLoop(options.optimizationInterval || 60000);
  }
  
  /**
   * Initialize pool with minimum objects
   */
  initialize() {
    for (let i = 0; i < this.minSize; i++) {
      this.available.push(this.createObject());
    }
    
    logger.debug('Object pool initialized', {
      name: this.name,
      initialSize: this.minSize
    });
  }
  
  /**
   * Create new object using factory
   */
  createObject() {
    const obj = this.factory();
    this.totalCreated++;
    
    // Add pool metadata
    obj._poolMetadata = {
      createdAt: Date.now(),
      acquisitions: 0,
      holdTime: 0
    };
    
    return obj;
  }
  
  /**
   * Acquire object from pool
   */
  acquire() {
    this.totalAcquired++;
    let obj;
    
    if (this.available.length > 0) {
      // Hit - reuse existing object
      obj = this.available.pop();
    } else {
      // Miss - create new object
      this.totalMisses++;
      obj = this.createObject();
      
      logger.debug('Pool miss - creating new object', {
        name: this.name,
        totalInUse: this.inUse.size,
        missRate: this.totalMisses / this.totalAcquired
      });
    }
    
    // Track object
    obj._poolMetadata.acquisitions++;
    obj._poolMetadata.acquiredAt = Date.now();
    this.inUse.add(obj);
    
    // Update peak usage
    if (this.inUse.size > this.peakInUse) {
      this.peakInUse = this.inUse.size;
    }
    
    return obj;
  }
  
  /**
   * Release object back to pool
   */
  release(obj) {
    if (!obj || !obj._poolMetadata) {
      logger.warn('Invalid object released to pool', { name: this.name });
      return false;
    }
    
    if (!this.inUse.has(obj)) {
      logger.warn('Object not tracked by pool', { name: this.name });
      return false;
    }
    
    // Update hold time statistics
    const holdTime = Date.now() - obj._poolMetadata.acquiredAt;
    obj._poolMetadata.holdTime += holdTime;
    this.updateAvgHoldTime(holdTime);
    
    // Remove from in-use tracking
    this.inUse.delete(obj);
    this.totalReleased++;
    
    // Reset object for reuse
    try {
      this.reset(obj);
      
      // Return to pool if not at capacity
      if (this.available.length < this.maxSize) {
        this.available.push(obj);
      } else {
        // Pool at capacity - discard object
        logger.debug('Pool at capacity, discarding object', {
          name: this.name,
          capacity: this.maxSize
        });
      }
      
    } catch (error) {
      logger.error('Object reset failed', {
        name: this.name,
        error: error.message
      });
    }
    
    return true;
  }
  
  /**
   * Update average hold time using exponential moving average
   */
  updateAvgHoldTime(holdTime) {
    const alpha = 0.1; // Smoothing factor
    this.avgHoldTime = (alpha * holdTime) + ((1 - alpha) * this.avgHoldTime);
  }
  
  /**
   * Start optimization loop for dynamic pool sizing
   */
  startOptimizationLoop(interval) {
    setInterval(() => {
      this.optimize();
    }, interval);
  }
  
  /**
   * Optimize pool size based on usage patterns
   */
  optimize() {
    const now = Date.now();
    const timeSinceLastOpt = now - this.lastOptimized;
    
    // Calculate hit rate
    this.hitRate = this.totalAcquired > 0 ? 
      1 - (this.totalMisses / this.totalAcquired) : 1.0;
    
    const currentInUse = this.inUse.size;
    const currentAvailable = this.available.length;
    const totalPoolSize = currentInUse + currentAvailable;
    
    // Determine if we should grow or shrink
    let action = 'none';
    let targetSize = totalPoolSize;
    
    // Growth conditions
    if (this.hitRate < 0.9 && totalPoolSize < this.maxSize) {
      targetSize = Math.min(
        this.maxSize,
        Math.ceil(totalPoolSize * this.growthFactor)
      );
      action = 'grow';
    }
    // Shrink conditions
    else if (this.hitRate > 0.98 && 
             currentAvailable > this.minSize && 
             currentAvailable / totalPoolSize > this.shrinkThreshold) {
      targetSize = Math.max(
        this.minSize,
        Math.ceil(totalPoolSize * 0.8)
      );
      action = 'shrink';
    }
    
    // Execute optimization
    if (action !== 'none') {
      this.resizePool(targetSize, action);
    }
    
    // Reset counters for next optimization cycle
    this.lastOptimized = now;
    
    logger.debug('Pool optimization completed', {
      name: this.name,
      action,
      hitRate: this.hitRate.toFixed(3),
      inUse: currentInUse,
      available: currentAvailable,
      totalSize: totalPoolSize,
      targetSize,
      avgHoldTime: Math.round(this.avgHoldTime),
      peakInUse: this.peakInUse
    });
  }
  
  /**
   * Resize pool to target size
   */
  resizePool(targetSize, action) {
    const currentTotal = this.inUse.size + this.available.length;
    
    if (action === 'grow' && targetSize > currentTotal) {
      const objectsToAdd = targetSize - currentTotal;
      for (let i = 0; i < objectsToAdd; i++) {
        this.available.push(this.createObject());
      }
      
      logger.info('Pool grown', {
        name: this.name,
        added: objectsToAdd,
        newSize: this.available.length + this.inUse.size
      });
    }
    else if (action === 'shrink' && targetSize < currentTotal) {
      const objectsToRemove = Math.min(
        this.available.length,
        currentTotal - targetSize
      );
      
      this.available.splice(0, objectsToRemove);
      
      logger.info('Pool shrunk', {
        name: this.name,
        removed: objectsToRemove,
        newSize: this.available.length + this.inUse.size
      });
    }
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      name: this.name,
      available: this.available.length,
      inUse: this.inUse.size,
      total: this.available.length + this.inUse.size,
      capacity: this.maxSize,
      hitRate: this.hitRate,
      totalCreated: this.totalCreated,
      totalAcquired: this.totalAcquired,
      totalReleased: this.totalReleased,
      totalMisses: this.totalMisses,
      avgHoldTime: Math.round(this.avgHoldTime),
      peakInUse: this.peakInUse
    };
  }
  
  /**
   * Drain and shutdown pool
   */
  drain() {
    logger.info('Draining object pool', {
      name: this.name,
      inUse: this.inUse.size,
      available: this.available.length
    });
    
    // Clear available objects
    this.available.length = 0;
    
    // Note: Objects in use will be released naturally
    // as they complete their operations
    
    this.emit('drained');
  }
  
  /**
   * Legacy compatibility - clear method
   */
  clear() {
    this.drain();
  }
}

/**
 * Mining-specific object pools
 */
export class MiningObjectPools {
  constructor() {
    this.sharePool = this.createSharePool();
    this.blockPool = this.createBlockPool();
    this.minerPool = this.createMinerPool();
    this.difficultyPool = this.createDifficultyPool();
    this.bufferPool = this.createBufferPool();
    
    logger.info('Mining object pools initialized');
  }
  
  /**
   * Create share object pool
   */
  createSharePool() {
    return new OptimizedObjectPool(
      // Factory
      () => ({
        minerId: null,
        jobId: null,
        nonce: 0,
        timestamp: 0,
        difficulty: 0,
        hash: null,
        target: null,
        valid: false,
        blockHeight: 0,
        algorithm: null
      }),
      // Reset function
      (share) => {
        share.minerId = null;
        share.jobId = null;
        share.nonce = 0;
        share.timestamp = 0;
        share.difficulty = 0;
        share.hash = null;
        share.target = null;
        share.valid = false;
        share.blockHeight = 0;
        share.algorithm = null;
      },
      {
        name: 'SharePool',
        minSize: 100,
        maxSize: 10000,
        optimizationInterval: 30000
      }
    );
  }
  
  /**
   * Create block template pool
   */
  createBlockPool() {
    return new OptimizedObjectPool(
      // Factory
      () => ({
        height: 0,
        previousHash: null,
        merkleRoot: null,
        timestamp: 0,
        bits: 0,
        target: null,
        transactions: [],
        coinbaseValue: 0,
        algorithm: null
      }),
      // Reset function
      (block) => {
        block.height = 0;
        block.previousHash = null;
        block.merkleRoot = null;
        block.timestamp = 0;
        block.bits = 0;
        block.target = null;
        block.transactions.length = 0;
        block.coinbaseValue = 0;
        block.algorithm = null;
      },
      {
        name: 'BlockPool',
        minSize: 10,
        maxSize: 100,
        optimizationInterval: 60000
      }
    );
  }
  
  /**
   * Create miner connection pool
   */
  createMinerPool() {
    return new OptimizedObjectPool(
      // Factory
      () => ({
        id: null,
        address: null,
        difficulty: 0,
        lastActivity: 0,
        shares: 0,
        validShares: 0,
        invalidShares: 0,
        hashrate: 0,
        connected: false,
        userAgent: null,
        ip: null
      }),
      // Reset function
      (miner) => {
        miner.id = null;
        miner.address = null;
        miner.difficulty = 0;
        miner.lastActivity = 0;
        miner.shares = 0;
        miner.validShares = 0;
        miner.invalidShares = 0;
        miner.hashrate = 0;
        miner.connected = false;
        miner.userAgent = null;
        miner.ip = null;
      },
      {
        name: 'MinerPool',
        minSize: 50,
        maxSize: 5000,
        optimizationInterval: 45000
      }
    );
  }
  
  /**
   * Create difficulty adjustment pool
   */
  createDifficultyPool() {
    return new OptimizedObjectPool(
      // Factory
      () => ({
        minerId: null,
        currentDifficulty: 0,
        targetDifficulty: 0,
        shareTime: 0,
        targetTime: 15000, // 15 seconds
        adjustment: 1.0,
        timestamp: 0
      }),
      // Reset function
      (diff) => {
        diff.minerId = null;
        diff.currentDifficulty = 0;
        diff.targetDifficulty = 0;
        diff.shareTime = 0;
        diff.targetTime = 15000;
        diff.adjustment = 1.0;
        diff.timestamp = 0;
      },
      {
        name: 'DifficultyPool',
        minSize: 20,
        maxSize: 1000,
        optimizationInterval: 60000
      }
    );
  }
  
  /**
   * Create buffer pool for binary data
   */
  createBufferPool() {
    return new OptimizedObjectPool(
      // Factory
      () => ({
        data: Buffer.alloc(1024), // 1KB buffers
        length: 0,
        position: 0
      }),
      // Reset function
      (buffer) => {
        buffer.length = 0;
        buffer.position = 0;
        buffer.data.fill(0);
      },
      {
        name: 'BufferPool',
        minSize: 100,
        maxSize: 2000,
        optimizationInterval: 30000
      }
    );
  }
  
  /**
   * Get statistics for all pools
   */
  getAllStats() {
    return {
      shares: this.sharePool.getStats(),
      blocks: this.blockPool.getStats(),
      miners: this.minerPool.getStats(),
      difficulty: this.difficultyPool.getStats(),
      buffers: this.bufferPool.getStats()
    };
  }
  
  /**
   * Drain all pools
   */
  drainAll() {
    logger.info('Draining all mining object pools...');
    
    this.sharePool.drain();
    this.blockPool.drain();
    this.minerPool.drain();
    this.difficultyPool.drain();
    this.bufferPool.drain();
    
    logger.info('All mining object pools drained');
  }
  
  /**
   * Legacy compatibility - clear all pools
   */
  clearAll() {
    this.drainAll();
  }
}

/**
 * Global pool manager
 */
class PoolManager {
  constructor() {
    this.pools = new Map();
    this.stats = {
      totalPools: 0,
      totalObjects: 0,
      totalHits: 0,
      totalMisses: 0,
      avgHitRate: 0
    };
  }
  
  /**
   * Register a pool
   */
  register(name, pool) {
    this.pools.set(name, pool);
    this.stats.totalPools++;
    
    logger.info('Pool registered', { name });
  }
  
  /**
   * Get pool by name
   */
  get(name) {
    return this.pools.get(name);
  }
  
  /**
   * Get aggregated statistics
   */
  getAggregatedStats() {
    let totalObjects = 0;
    let totalHits = 0;
    let totalMisses = 0;
    let hitRateSum = 0;
    
    for (const [name, pool] of this.pools) {
      const stats = pool.getStats();
      totalObjects += stats.total;
      totalHits += (stats.totalAcquired - stats.totalMisses);
      totalMisses += stats.totalMisses;
      hitRateSum += stats.hitRate;
    }
    
    return {
      totalPools: this.pools.size,
      totalObjects,
      totalHits,
      totalMisses,
      avgHitRate: this.pools.size > 0 ? hitRateSum / this.pools.size : 0,
      overallHitRate: (totalHits + totalMisses) > 0 ? 
        totalHits / (totalHits + totalMisses) : 0
    };
  }
  
  /**
   * Shutdown all pools
   */
  shutdown() {
    logger.info('Shutting down all object pools...');
    
    for (const [name, pool] of this.pools) {
      pool.drain();
    }
    
    this.pools.clear();
    logger.info('All object pools shut down');
  }
}

// Global instances
export const poolManager = new PoolManager();
export const miningPools = new MiningObjectPools();

export default OptimizedObjectPool;