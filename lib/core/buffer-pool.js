/**
 * Buffer Pool Manager - Otedama
 * Efficient buffer reuse to minimize GC pressure
 */

import { createStructuredLogger } from './structured-logger.js';

const logger = createStructuredLogger('BufferPool');

export class BufferPool {
  constructor(options = {}) {
    this.options = {
      bufferSize: options.bufferSize || 4096,
      initialPoolSize: options.initialPoolSize || 100,
      maxPoolSize: options.maxPoolSize || 10000,
      growthFactor: options.growthFactor || 2,
      shrinkThreshold: options.shrinkThreshold || 0.25,
      shrinkInterval: options.shrinkInterval || 60000, // 1 minute
      ...options
    };
    
    // Pool storage
    this.available = [];
    this.inUse = new Set();
    
    // Statistics
    this.stats = {
      created: 0,
      acquired: 0,
      released: 0,
      reused: 0,
      currentSize: 0,
      peakSize: 0,
      shrinkCount: 0
    };
    
    // Initialize pool
    this.initialize();
    
    // Start shrink timer
    this.shrinkTimer = setInterval(() => this.shrink(), this.options.shrinkInterval);
  }
  
  /**
   * Initialize buffer pool
   */
  initialize() {
    for (let i = 0; i < this.options.initialPoolSize; i++) {
      this.available.push(this.createBuffer());
    }
    
    logger.info('Buffer pool initialized', {
      initialSize: this.options.initialPoolSize,
      bufferSize: this.options.bufferSize
    });
  }
  
  /**
   * Create a new buffer
   */
  createBuffer() {
    const buffer = Buffer.allocUnsafe(this.options.bufferSize);
    // Clear buffer immediately to prevent data leaks
    buffer.fill(0);
    this.stats.created++;
    this.stats.currentSize++;
    
    if (this.stats.currentSize > this.stats.peakSize) {
      this.stats.peakSize = this.stats.currentSize;
    }
    
    return buffer;
  }
  
  /**
   * Acquire a buffer from pool
   */
  acquire() {
    this.stats.acquired++;
    
    let buffer;
    
    if (this.available.length > 0) {
      // Reuse from pool
      buffer = this.available.pop();
      this.stats.reused++;
    } else if (this.stats.currentSize < this.options.maxPoolSize) {
      // Create new buffer
      buffer = this.createBuffer();
    } else {
      // Pool exhausted, create temporary buffer (will be GC'd)
      logger.warn('Buffer pool exhausted, creating temporary buffer');
      buffer = Buffer.allocUnsafe(this.options.bufferSize);
      // Clear temporary buffer
      buffer.fill(0);
    }
    
    // Track in-use buffers
    this.inUse.add(buffer);
    
    // Clear buffer for security
    buffer.fill(0);
    
    return buffer;
  }
  
  /**
   * Release buffer back to pool
   */
  release(buffer) {
    if (!Buffer.isBuffer(buffer)) {
      logger.error('Invalid buffer released to pool');
      return;
    }
    
    this.stats.released++;
    
    // Remove from in-use set
    this.inUse.delete(buffer);
    
    // Check if buffer belongs to pool
    if (buffer.length !== this.options.bufferSize) {
      // Non-standard size, let it be GC'd
      return;
    }
    
    // Check pool size
    if (this.available.length < this.options.maxPoolSize) {
      // Clear buffer before returning to pool
      buffer.fill(0);
      this.available.push(buffer);
    } else {
      // Pool is full, let buffer be GC'd
      this.stats.currentSize--;
    }
  }
  
  /**
   * Shrink pool if underutilized
   */
  shrink() {
    const utilization = this.inUse.size / this.stats.currentSize;
    
    if (utilization < this.options.shrinkThreshold && this.available.length > this.options.initialPoolSize) {
      const shrinkCount = Math.floor(this.available.length / 2);
      
      for (let i = 0; i < shrinkCount; i++) {
        this.available.pop();
        this.stats.currentSize--;
      }
      
      this.stats.shrinkCount++;
      
      logger.info('Buffer pool shrunk', {
        removed: shrinkCount,
        newSize: this.stats.currentSize,
        utilization: (utilization * 100).toFixed(2) + '%'
      });
    }
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      ...this.stats,
      available: this.available.length,
      inUse: this.inUse.size,
      utilization: ((this.inUse.size / this.stats.currentSize) * 100).toFixed(2) + '%',
      reuseRate: ((this.stats.reused / this.stats.acquired) * 100).toFixed(2) + '%'
    };
  }
  
  /**
   * Clear pool
   */
  clear() {
    this.available = [];
    this.inUse.clear();
    this.stats.currentSize = 0;
  }
  
  /**
   * Shutdown pool
   */
  shutdown() {
    if (this.shrinkTimer) {
      clearInterval(this.shrinkTimer);
    }
    
    this.clear();
    
    logger.info('Buffer pool shutdown', this.getStats());
  }
}

/**
 * Create a shared buffer pool instance
 */
export const sharedBufferPool = new BufferPool({
  bufferSize: 4096,
  initialPoolSize: 100,
  maxPoolSize: 10000
});

/**
 * Convenience functions
 */
export function acquireBuffer(size) {
  if (size && size !== sharedBufferPool.options.bufferSize) {
    // Non-standard size, create custom pool or allocate directly
    const buffer = Buffer.allocUnsafe(size);
    // Clear buffer for security
    buffer.fill(0);
    return buffer;
  }
  return sharedBufferPool.acquire();
}

export function releaseBuffer(buffer) {
  if (buffer.length === sharedBufferPool.options.bufferSize) {
    sharedBufferPool.release(buffer);
  }
  // Otherwise, let GC handle it
}

export default BufferPool;