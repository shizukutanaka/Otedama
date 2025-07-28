/**
 * Thread-Safe Connection Pool for Otedama
 * Prevents race conditions with proper mutex protection
 * 
 * Design principles:
 * - Carmack: Lock-free algorithms where possible, minimal contention
 * - Martin: Clean synchronization boundaries
 * - Pike: Simple mutex primitives, no deadlocks
 */

import net from 'net';
import tls from 'tls';
import { Mutex } from 'async-mutex';
import { BasePool } from '../common/base-pool.js';

export const PoolState = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  READY: 'ready',
  BUSY: 'busy',
  ERROR: 'error',
  CLOSED: 'closed'
};

/**
 * Thread-safe connection wrapper
 */
export class Connection {
  constructor(id, socket) {
    this.id = id;
    this.socket = socket;
    this._state = PoolState.IDLE;
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
    this.useCount = 0;
    this.currentRequest = null;
    this.tags = new Set();
    this.mutex = new Mutex(); // Per-connection mutex
  }
  
  get state() {
    return this._state;
  }
  
  async setState(newState) {
    const release = await this.mutex.acquire();
    try {
      this._state = newState;
    } finally {
      release();
    }
  }
  
  async isHealthy() {
    const release = await this.mutex.acquire();
    try {
      return this.socket && 
             !this.socket.destroyed && 
             this.socket.readyState === 'open' &&
             this._state !== PoolState.ERROR;
    } finally {
      release();
    }
  }
  
  isExpired(maxAge) {
    return Date.now() - this.createdAt > maxAge;
  }
  
  isIdle(idleTimeout) {
    return this._state === PoolState.IDLE && 
           Date.now() - this.lastUsedAt > idleTimeout;
  }
}

/**
 * Thread-safe connection pool implementation extending BasePool
 */
export class ConnectionPool extends BasePool {
  constructor(options = {}) {
    super('ConnectionPool', {
      // Map pool options to BasePool configuration
      minSize: options.minConnections || 5,
      maxSize: options.maxConnections || 100,
      acquireTimeout: options.acquireTimeout || 30000,
      idleTimeout: options.idleTimeout || 300000,
      createTimeout: 10000,
      createRetries: options.retryAttempts || 3,
      retryDelay: options.retryDelay || 1000,
      
      // Connection specific options
      host: options.host || 'localhost',
      port: options.port || 3333,
      ssl: options.ssl || false,
      maxConnectionAge: options.maxConnectionAge || 3600000,
      
      // Performance settings
      tcpNoDelay: options.tcpNoDelay !== false,
      keepAlive: options.keepAlive !== false,
      keepAliveDelay: options.keepAliveDelay || 60000,
      
      // Thread safety settings
      fairness: options.fairness !== false,
      maxWaitQueueSize: options.maxWaitQueueSize || 1000,
      
      ...options
    });
    
    // Thread-safe connection state
    this.connectionMutex = new Mutex();
    this.connectionCounter = 0;
    this.connectionWrappers = new Map(); // Maps resources to Connection wrappers
    
    // Connection-specific metrics (extending base metrics)
    this.connectionMetrics = {
      connectionsActive: 0,
      connectionsFailed: 0,
      requestsQueued: 0,
      requestsServed: 0,
      requestsTimeout: 0,
      avgWaitTime: 0
    };
  }
  
  /**
   * Create a socket connection resource
   */
  async onCreateResource() {
    const socket = await this._connect();
    
    // Create connection wrapper
    const release = await this.connectionMutex.acquire();
    try {
      const id = `conn_${++this.connectionCounter}`;
      const connection = new Connection(id, socket);
      
      // Configure socket
      if (this.config.tcpNoDelay) {
        socket.setNoDelay(true);
      }
      
      if (this.config.keepAlive) {
        socket.setKeepAlive(true, this.config.keepAliveDelay);
      }
      
      // Setup error handling
      socket.on('error', async (error) => {
        this.logger.error(`Connection ${id} error: ${error.message}`);
        await connection.setState(PoolState.ERROR);
        // BasePool will handle removal through validation
      });
      
      socket.on('close', async () => {
        await connection.setState(PoolState.CLOSED);
        // BasePool will handle removal through validation
      });
      
      await connection.setState(PoolState.READY);
      this.connectionWrappers.set(socket, connection);
      
      this.emit('connectionCreated', connection);
      
      return socket; // Return the socket as the resource
    } finally {
      release();
    }
  }
  
  /**
   * Connect to server
   */
  async _connect() {
    return new Promise((resolve, reject) => {
      const connectOptions = {
        host: this.config.host,
        port: this.config.port
      };
      
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, this.config.createTimeout);
      
      const onConnect = () => {
        clearTimeout(timeout);
        socket.removeListener('error', onError);
        resolve(socket);
      };
      
      const onError = (error) => {
        clearTimeout(timeout);
        socket.removeListener('connect', onConnect);
        this.connectionMetrics.connectionsFailed++;
        reject(error);
      };
      
      let socket;
      if (this.config.ssl) {
        socket = tls.connect(connectOptions, onConnect);
      } else {
        socket = net.connect(connectOptions, onConnect);
      }
      
      socket.once('error', onError);
    });
  }
  
  /**
   * Destroy a socket connection
   */
  async onDestroyResource(socket) {
    const connection = this.connectionWrappers.get(socket);
    if (!connection) return;
    
    if (socket && !socket.destroyed) {
      socket.destroy();
    }
    
    this.connectionWrappers.delete(socket);
    this.emit('connectionDestroyed', connection);
  }
  
  /**
   * Validate a socket connection
   */
  async onValidateResource(socket) {
    const connection = this.connectionWrappers.get(socket);
    if (!connection) return false;
    
    // Check if connection is healthy
    const isHealthy = await connection.isHealthy();
    
    // Check if connection is expired
    if (isHealthy && connection.isExpired(this.config.maxConnectionAge)) {
      return false;
    }
    
    return isHealthy;
  }
  
  /**
   * Thread-safe acquire with tag support
   */
  async acquire(tags = []) {
    const startTime = Date.now();
    
    try {
      // Get socket from base pool
      const socket = await super.acquire();
      const connection = this.connectionWrappers.get(socket);
      
      if (connection) {
        await connection.setState(PoolState.BUSY);
        connection.lastUsedAt = Date.now();
        connection.useCount++;
        
        // Add tags if provided
        if (tags.length > 0) {
          tags.forEach(tag => connection.tags.add(tag));
        }
        
        this.connectionMetrics.requestsServed++;
        this._updateAvgWaitTime(Date.now() - startTime);
      }
      
      return connection;
      
    } catch (error) {
      if (error.message.includes('timeout')) {
        this.connectionMetrics.requestsTimeout++;
      }
      throw error;
    }
  }
  
  /**
   * Thread-safe release
   */
  async release(connection) {
    if (!connection || !connection.socket) return;
    
    await connection.setState(PoolState.IDLE);
    connection.lastUsedAt = Date.now();
    
    // Release the socket back to base pool
    await super.release(connection.socket);
  }
  
  /**
   * Destroy a connection (public API)
   */
  async destroy(connection) {
    if (!connection || !connection.socket) return;
    await this.destroyResource(connection.socket);
  }
  
  /**
   * Update average wait time
   */
  _updateAvgWaitTime(waitTime) {
    const alpha = 0.1; // Exponential moving average factor
    this.connectionMetrics.avgWaitTime = 
      alpha * waitTime + (1 - alpha) * this.connectionMetrics.avgWaitTime;
  }
  
  /**
   * Get pool statistics
   */
  async getStats() {
    const baseStats = await this.getPoolStats();
    
    // Calculate active connections
    const release = await this.connectionMutex.acquire();
    try {
      let activeCount = 0;
      for (const connection of this.connectionWrappers.values()) {
        if (connection.state === PoolState.BUSY) {
          activeCount++;
        }
      }
      this.connectionMetrics.connectionsActive = activeCount;
    } finally {
      release();
    }
    
    return {
      ...baseStats,
      ...this.connectionMetrics,
      totalConnections: this.connectionWrappers.size,
      poolUtilization: this.connectionWrappers.size > 0 ? 
        (this.connectionMetrics.connectionsActive / this.connectionWrappers.size) : 0
    };
  }
  
  /**
   * Custom health check
   */
  async onHealthCheck() {
    const stats = await this.getStats();
    
    return {
      connections: {
        total: stats.totalConnections,
        active: stats.connectionsActive,
        available: stats.availableSize,
        waiting: stats.waitingCount
      },
      performance: {
        avgWaitTime: stats.avgWaitTime,
        utilization: stats.poolUtilization
      }
    };
  }
  
  /**
   * Get pool metrics (alias for getStats for backward compatibility)
   */
  async getMetrics() {
    return this.getStats();
  }
  
  /**
   * Shutdown pool (alias for shutdown for backward compatibility)
   */
  async close() {
    return this.shutdown();
  }
}

/**
 * Create thread-safe connection pool
 */
export function createConnectionPool(options) {
  return new ConnectionPool(options);
}

// Alias for backward compatibility
export const ThreadSafeConnectionPool = ConnectionPool;
export function createThreadSafeConnectionPool(options) {
  return new ConnectionPool(options);
}

export default ConnectionPool;