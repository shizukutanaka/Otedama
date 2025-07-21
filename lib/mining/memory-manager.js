/**
 * Memory Manager for Mining Operations
 * Prevents memory leaks and optimizes resource usage
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

const logger = getLogger('MiningMemoryManager');

/**
 * Mining Memory Manager
 * Handles memory cleanup, garbage collection hints, and resource tracking
 */
export class MiningMemoryManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      gcInterval: options.gcInterval || 300000, // 5 minutes
      maxMinerAge: options.maxMinerAge || 3600000, // 1 hour
      maxConnectionsPerIP: options.maxConnectionsPerIP || 10,
      cleanupInterval: options.cleanupInterval || 60000, // 1 minute
      memoryThreshold: options.memoryThreshold || 1024 * 1024 * 1024, // 1GB
      ...options
    };
    
    // Resource tracking
    this.miners = new Map();
    this.connections = new Map();
    this.ipConnections = new Map();
    this.shareHistory = new Map();
    this.workerPool = new Map();
    
    // Cleanup timers
    this.timers = {
      gc: null,
      cleanup: null,
      monitoring: null
    };
    
    // Memory metrics
    this.metrics = {
      totalMiners: 0,
      totalConnections: 0,
      memoryUsage: 0,
      gcCount: 0,
      cleanupCount: 0
    };
    
    this.startTime = Date.now();
    this.isRunning = false;
  }

  /**
   * Start memory management
   */
  start() {
    if (this.isRunning) return;
    
    logger.info('Starting mining memory manager');
    
    // Periodic garbage collection
    this.timers.gc = setInterval(() => {
      this.forceGarbageCollection();
    }, this.config.gcInterval);
    
    // Resource cleanup
    this.timers.cleanup = setInterval(() => {
      this.cleanupResources();
    }, this.config.cleanupInterval);
    
    // Memory monitoring
    this.timers.monitoring = setInterval(() => {
      this.monitorMemoryUsage();
    }, 30000); // Every 30 seconds
    
    this.isRunning = true;
    this.emit('started');
  }

  /**
   * Stop memory management
   */
  stop() {
    if (!this.isRunning) return;
    
    logger.info('Stopping mining memory manager');
    
    // Clear all timers
    Object.values(this.timers).forEach(timer => {
      if (timer) clearInterval(timer);
    });
    
    // Final cleanup
    this.cleanupAll();
    
    this.isRunning = false;
    this.emit('stopped');
  }

  /**
   * Register a miner with memory tracking
   */
  registerMiner(minerId, minerData) {
    const miner = {
      id: minerId,
      ...minerData,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      memoryFootprint: this.estimateMinerMemoryUsage(minerData)
    };
    
    this.miners.set(minerId, miner);
    this.metrics.totalMiners++;
    
    // Initialize share history with size limit
    this.shareHistory.set(minerId, {
      shares: [],
      maxSize: 1000, // Limit shares per miner
      lastCleanup: Date.now()
    });
    
    this.emit('miner:registered', { minerId, memoryFootprint: miner.memoryFootprint });
    
    return miner;
  }

  /**
   * Unregister a miner and cleanup resources
   */
  unregisterMiner(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return false;
    
    // Cleanup share history
    this.shareHistory.delete(minerId);
    
    // Remove from connections tracking
    if (miner.ipAddress) {
      this.decrementIPConnection(miner.ipAddress);
    }
    
    // Remove miner
    this.miners.delete(minerId);
    this.metrics.totalMiners--;
    
    this.emit('miner:unregistered', { minerId, memoryFootprint: miner.memoryFootprint });
    
    // Trigger GC hint if many miners removed
    if (this.metrics.totalMiners % 100 === 0) {
      this.scheduleGarbageCollection();
    }
    
    return true;
  }

  /**
   * Register a connection with tracking
   */
  registerConnection(connectionId, connectionData) {
    const connection = {
      id: connectionId,
      ...connectionData,
      createdAt: Date.now(),
      lastActivity: Date.now()
    };
    
    this.connections.set(connectionId, connection);
    this.metrics.totalConnections++;
    
    // Track connections per IP
    if (connectionData.ipAddress) {
      this.incrementIPConnection(connectionData.ipAddress);
    }
    
    this.emit('connection:registered', { connectionId });
    
    return connection;
  }

  /**
   * Unregister a connection
   */
  unregisterConnection(connectionId) {
    const connection = this.connections.get(connectionId);
    if (!connection) return false;
    
    // Decrement IP connection count
    if (connection.ipAddress) {
      this.decrementIPConnection(connection.ipAddress);
    }
    
    this.connections.delete(connectionId);
    this.metrics.totalConnections--;
    
    this.emit('connection:unregistered', { connectionId });
    
    return true;
  }

  /**
   * Add share to history with memory management
   */
  addShare(minerId, shareData) {
    const history = this.shareHistory.get(minerId);
    if (!history) return false;
    
    const share = {
      ...shareData,
      timestamp: Date.now()
    };
    
    history.shares.push(share);
    
    // Maintain share history size
    if (history.shares.length > history.maxSize) {
      const excess = history.shares.length - history.maxSize;
      history.shares.splice(0, excess); // Remove oldest shares
    }
    
    // Periodic cleanup of old shares
    const now = Date.now();
    if (now - history.lastCleanup > 300000) { // 5 minutes
      this.cleanupOldShares(minerId);
      history.lastCleanup = now;
    }
    
    return true;
  }

  /**
   * Cleanup old shares to prevent memory bloat
   */
  cleanupOldShares(minerId) {
    const history = this.shareHistory.get(minerId);
    if (!history) return;
    
    const cutoff = Date.now() - 600000; // 10 minutes
    const originalLength = history.shares.length;
    
    history.shares = history.shares.filter(share => share.timestamp > cutoff);
    
    const removed = originalLength - history.shares.length;
    if (removed > 0) {
      logger.debug(`Cleaned up ${removed} old shares for miner ${minerId}`);
    }
  }

  /**
   * Increment IP connection count
   */
  incrementIPConnection(ipAddress) {
    const count = this.ipConnections.get(ipAddress) || 0;
    this.ipConnections.set(ipAddress, count + 1);
  }

  /**
   * Decrement IP connection count
   */
  decrementIPConnection(ipAddress) {
    const count = this.ipConnections.get(ipAddress) || 0;
    if (count <= 1) {
      this.ipConnections.delete(ipAddress);
    } else {
      this.ipConnections.set(ipAddress, count - 1);
    }
  }

  /**
   * Clean up stale resources
   */
  cleanupResources() {
    const now = Date.now();
    let cleaned = 0;
    
    // Clean up inactive miners
    for (const [minerId, miner] of this.miners) {
      if (now - miner.lastActivity > this.config.maxMinerAge) {
        this.unregisterMiner(minerId);
        cleaned++;
      }
    }
    
    // Clean up stale connections
    for (const [connectionId, connection] of this.connections) {
      if (now - connection.lastActivity > this.config.maxMinerAge) {
        this.unregisterConnection(connectionId);
        cleaned++;
      }
    }
    
    // Clean up empty IP entries
    for (const [ip, count] of this.ipConnections) {
      if (count <= 0) {
        this.ipConnections.delete(ip);
      }
    }
    
    // Clean up all share histories
    for (const minerId of this.shareHistory.keys()) {
      this.cleanupOldShares(minerId);
    }
    
    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} stale resources`);
      this.metrics.cleanupCount++;
      
      // Trigger GC after cleanup
      this.scheduleGarbageCollection();
    }
  }

  /**
   * Force garbage collection (Node.js specific)
   */
  forceGarbageCollection() {
    try {
      if (global.gc) {
        global.gc();
        this.metrics.gcCount++;
        logger.debug('Forced garbage collection');
      } else {
        logger.debug('Garbage collection not available (use --expose-gc flag)');
      }
    } catch (error) {
      logger.warn('Failed to force garbage collection:', error.message);
    }
  }

  /**
   * Schedule garbage collection for next tick
   */
  scheduleGarbageCollection() {
    process.nextTick(() => {
      this.forceGarbageCollection();
    });
  }

  /**
   * Monitor memory usage and take action if needed
   */
  monitorMemoryUsage() {
    const usage = process.memoryUsage();
    this.metrics.memoryUsage = usage.heapUsed;
    
    const memoryMB = usage.heapUsed / (1024 * 1024);
    
    // Log memory stats
    logger.debug(`Memory usage: ${memoryMB.toFixed(1)}MB heap, ${this.miners.size} miners, ${this.connections.size} connections`);
    
    // Take action if memory usage is high
    if (usage.heapUsed > this.config.memoryThreshold) {
      logger.warn(`High memory usage detected: ${memoryMB.toFixed(1)}MB`);
      
      // Aggressive cleanup
      this.aggressiveCleanup();
      
      // Force GC
      this.forceGarbageCollection();
      
      this.emit('memory:high', { usage, memoryMB });
    }
    
    this.emit('memory:stats', { usage, miners: this.miners.size, connections: this.connections.size });
  }

  /**
   * Aggressive cleanup when memory is high
   */
  aggressiveCleanup() {
    logger.info('Performing aggressive cleanup due to high memory usage');
    
    const now = Date.now();
    let cleaned = 0;
    
    // Remove miners with old activity (shorter threshold)
    const shortThreshold = this.config.maxMinerAge / 2;
    
    for (const [minerId, miner] of this.miners) {
      if (now - miner.lastActivity > shortThreshold) {
        this.unregisterMiner(minerId);
        cleaned++;
      }
    }
    
    // Reduce share history size
    for (const [minerId, history] of this.shareHistory) {
      if (history.shares.length > 500) {
        const excess = history.shares.length - 500;
        history.shares.splice(0, excess);
        cleaned++;
      }
    }
    
    logger.info(`Aggressive cleanup removed ${cleaned} resources`);
  }

  /**
   * Clean up all resources
   */
  cleanupAll() {
    logger.info('Cleaning up all mining resources');
    
    this.miners.clear();
    this.connections.clear();
    this.ipConnections.clear();
    this.shareHistory.clear();
    this.workerPool.clear();
    
    this.metrics.totalMiners = 0;
    this.metrics.totalConnections = 0;
    
    // Force final GC
    this.scheduleGarbageCollection();
    
    logger.info('All mining resources cleaned up');
  }

  /**
   * Estimate memory usage for a miner
   */
  estimateMinerMemoryUsage(minerData) {
    // Rough estimate based on miner data
    let size = 1024; // Base size
    
    if (minerData.shareHistory) {
      size += minerData.shareHistory.length * 256; // 256 bytes per share estimate
    }
    
    if (minerData.connectionData) {
      size += 512; // Connection overhead
    }
    
    return size;
  }

  /**
   * Update miner activity
   */
  updateMinerActivity(minerId) {
    const miner = this.miners.get(minerId);
    if (miner) {
      miner.lastActivity = Date.now();
    }
  }

  /**
   * Update connection activity
   */
  updateConnectionActivity(connectionId) {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.lastActivity = Date.now();
    }
  }

  /**
   * Check if IP has exceeded connection limit
   */
  isIPLimitExceeded(ipAddress) {
    const count = this.ipConnections.get(ipAddress) || 0;
    return count >= this.config.maxConnectionsPerIP;
  }

  /**
   * Get memory statistics
   */
  getStats() {
    const usage = process.memoryUsage();
    
    return {
      ...this.metrics,
      currentMemoryUsage: usage.heapUsed,
      currentMemoryUsageMB: usage.heapUsed / (1024 * 1024),
      uptime: Date.now() - this.startTime,
      isRunning: this.isRunning,
      resources: {
        miners: this.miners.size,
        connections: this.connections.size,
        ipConnections: this.ipConnections.size,
        shareHistories: this.shareHistory.size,
        workers: this.workerPool.size
      }
    };
  }
}

// Create singleton instance
let memoryManagerInstance = null;

/**
 * Get or create memory manager instance
 */
export function getMiningMemoryManager(options = {}) {
  if (!memoryManagerInstance) {
    memoryManagerInstance = new MiningMemoryManager(options);
  }
  
  return memoryManagerInstance;
}

export default MiningMemoryManager;