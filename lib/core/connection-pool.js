/**
 * Thread-Safe Connection Pool for Otedama
 * Prevents race conditions with proper mutex protection
 * 
 * Design principles:
 * - Carmack: Lock-free algorithms where possible, minimal contention
 * - Martin: Clean synchronization boundaries
 * - Pike: Simple mutex primitives, no deadlocks
 */

import { EventEmitter } from 'events';
import net from 'net';
import tls from 'tls';
import { Mutex, Semaphore } from 'async-mutex';
import { logger } from './logger.js';

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
 * Thread-safe connection pool implementation
 */
export class ConnectionPool extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Connection settings
      host: options.host || 'localhost',
      port: options.port || 3333,
      ssl: options.ssl || false,
      
      // Pool settings
      minConnections: options.minConnections || 5,
      maxConnections: options.maxConnections || 100,
      acquireTimeout: options.acquireTimeout || 30000,
      idleTimeout: options.idleTimeout || 300000,
      maxConnectionAge: options.maxConnectionAge || 3600000,
      
      // Behavior settings
      retryAttempts: options.retryAttempts || 3,
      retryDelay: options.retryDelay || 1000,
      healthCheckInterval: options.healthCheckInterval || 60000,
      
      // Performance settings
      tcpNoDelay: options.tcpNoDelay !== false,
      keepAlive: options.keepAlive !== false,
      keepAliveDelay: options.keepAliveDelay || 60000,
      
      // Thread safety settings
      fairness: options.fairness !== false, // Fair scheduling
      maxWaitQueueSize: options.maxWaitQueueSize || 1000,
      
      ...options
    };
    
    // Thread-safe pool state
    this.poolMutex = new Mutex();
    this.connections = new Map();
    this.availableConnections = [];
    this.waitQueue = [];
    this.connectionCounter = 0;
    
    // Semaphore for connection limit
    this.connectionSemaphore = new Semaphore(this.options.maxConnections);
    
    // Metrics (atomic operations)
    this.metrics = {
      connectionsCreated: 0,
      connectionsDestroyed: 0,
      connectionsActive: 0,
      connectionsFailed: 0,
      requestsQueued: 0,
      requestsServed: 0,
      requestsTimeout: 0,
      avgWaitTime: 0,
      poolUtilization: 0
    };
    
    // Start background tasks
    this._startHealthCheck();
    this._startMaintenanceTask();
    
    // Initialize pool
    this._initialize();
  }
  
  /**
   * Initialize pool (backward compatibility)
   */
  async _initialize() {
    return this.initialize();
  }
  
  /**
   * Initialize connection pool with minimum connections
   */
  async initialize() {
    logger.info(`Initializing connection pool with ${this.options.minConnections} connections`);
    
    const promises = [];
    for (let i = 0; i < this.options.minConnections; i++) {
      promises.push(this._createConnectionSafe().catch(err => {
        logger.error(`Failed to create initial connection: ${err.message}`);
      }));
    }
    
    await Promise.all(promises);
    logger.info(`Connection pool initialized with ${this.connections.size} connections`);
  }
  
  /**
   * Thread-safe connection creation
   */
  async _createConnectionSafe() {
    // Acquire semaphore permit
    const [permitValue, permitRelease] = await this.connectionSemaphore.acquire();
    
    try {
      const socket = await this._connect();
      
      // Acquire pool mutex for state modification
      const release = await this.poolMutex.acquire();
      try {
        const id = `conn_${++this.connectionCounter}`;
        const connection = new Connection(id, socket);
        
        // Configure socket
        if (this.options.tcpNoDelay) {
          socket.setNoDelay(true);
        }
        
        if (this.options.keepAlive) {
          socket.setKeepAlive(true, this.options.keepAliveDelay);
        }
        
        // Setup error handling
        socket.on('error', async (error) => {
          logger.error(`Connection ${id} error: ${error.message}`);
          await this._removeConnectionSafe(connection);
        });
        
        socket.on('close', async () => {
          await this._removeConnectionSafe(connection);
        });
        
        // Add to pool
        await connection.setState(PoolState.READY);
        this.connections.set(id, connection);
        this.availableConnections.push(connection);
        
        // Update metrics atomically
        this._incrementMetric('connectionsCreated');
        
        this.emit('connectionCreated', connection);
        
        return connection;
      } finally {
        release();
      }
    } catch (error) {
      // Release permit on error
      permitRelease();
      this._incrementMetric('connectionsFailed');
      logger.error(`Failed to create connection: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Connect to server
   */
  async _connect() {
    return new Promise((resolve, reject) => {
      const connectOptions = {
        host: this.options.host,
        port: this.options.port
      };
      
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);
      
      const onConnect = () => {
        clearTimeout(timeout);
        socket.removeListener('error', onError);
        resolve(socket);
      };
      
      const onError = (error) => {
        clearTimeout(timeout);
        socket.removeListener('connect', onConnect);
        reject(error);
      };
      
      let socket;
      if (this.options.ssl) {
        socket = tls.connect(connectOptions, onConnect);
      } else {
        socket = net.connect(connectOptions, onConnect);
      }
      
      socket.once('error', onError);
    });
  }
  
  /**
   * Thread-safe connection acquisition
   */
  async acquire(tags = []) {
    const startTime = Date.now();
    const timeoutHandle = setTimeout(() => {
      this._incrementMetric('requestsTimeout');
    }, this.options.acquireTimeout);
    
    try {
      // Try to get available connection with mutex protection
      let connection = await this._getAvailableConnectionSafe(tags);
      
      if (connection) {
        clearTimeout(timeoutHandle);
        await connection.setState(PoolState.BUSY);
        connection.lastUsedAt = Date.now();
        connection.useCount++;
        this._incrementMetric('requestsServed');
        this._updateAvgWaitTime(Date.now() - startTime);
        return connection;
      }
      
      // Try to create new connection if under limit
      if (await this._canCreateConnection()) {
        try {
          connection = await this._createConnectionSafe();
          await connection.setState(PoolState.BUSY);
          connection.useCount++;
          clearTimeout(timeoutHandle);
          this._incrementMetric('requestsServed');
          return connection;
        } catch (error) {
          // Fall through to waiting
        }
      }
      
      // Wait for available connection
      return await this._waitForConnectionSafe(tags, timeoutHandle);
      
    } catch (error) {
      clearTimeout(timeoutHandle);
      throw error;
    }
  }
  
  /**
   * Thread-safe check if can create connection
   */
  async _canCreateConnection() {
    const release = await this.poolMutex.acquire();
    try {
      return this.connections.size < this.options.maxConnections;
    } finally {
      release();
    }
  }
  
  /**
   * Thread-safe get available connection
   */
  async _getAvailableConnectionSafe(tags) {
    const release = await this.poolMutex.acquire();
    try {
      // First try to find connection with matching tags
      if (tags.length > 0) {
        for (let i = this.availableConnections.length - 1; i >= 0; i--) {
          const conn = this.availableConnections[i];
          if (await conn.isHealthy() && tags.every(tag => conn.tags.has(tag))) {
            this.availableConnections.splice(i, 1);
            return conn;
          }
        }
      }
      
      // Then try any available connection
      while (this.availableConnections.length > 0) {
        const conn = this.availableConnections.pop();
        if (await conn.isHealthy()) {
          return conn;
        } else {
          // Schedule for removal outside mutex
          setImmediate(() => this._removeConnectionSafe(conn));
        }
      }
      
      return null;
    } finally {
      release();
    }
  }
  
  /**
   * Thread-safe wait for connection
   */
  async _waitForConnectionSafe(tags, timeoutHandle) {
    return new Promise(async (resolve, reject) => {
      const request = {
        resolve,
        reject,
        tags,
        timestamp: Date.now(),
        timeoutHandle
      };
      
      // Check queue size limit
      const release = await this.poolMutex.acquire();
      try {
        if (this.waitQueue.length >= this.options.maxWaitQueueSize) {
          release();
          reject(new Error('Connection pool wait queue is full'));
          return;
        }
        
        this.waitQueue.push(request);
        this._incrementMetric('requestsQueued');
      } finally {
        release();
      }
      
      // Setup timeout
      const timeout = setTimeout(async () => {
        const release = await this.poolMutex.acquire();
        try {
          const index = this.waitQueue.indexOf(request);
          if (index !== -1) {
            this.waitQueue.splice(index, 1);
            reject(new Error('Connection acquire timeout'));
          }
        } finally {
          release();
        }
      }, this.options.acquireTimeout);
      
      request.cleanupTimeout = timeout;
    });
  }
  
  /**
   * Thread-safe connection release
   */
  async release(connection) {
    if (!connection) return;
    
    const release = await this.poolMutex.acquire();
    try {
      // Update connection state
      await connection.setState(PoolState.IDLE);
      connection.lastUsedAt = Date.now();
      
      // Check if connection is still healthy
      if (!await connection.isHealthy() || connection.isExpired(this.options.maxConnectionAge)) {
        // Schedule for removal
        setImmediate(() => this._removeConnectionSafe(connection));
        return;
      }
      
      // Check for waiting requests
      if (this.waitQueue.length > 0) {
        const request = this.waitQueue.shift();
        clearTimeout(request.cleanupTimeout);
        clearTimeout(request.timeoutHandle);
        
        await connection.setState(PoolState.BUSY);
        connection.useCount++;
        this._incrementMetric('requestsServed');
        this._updateAvgWaitTime(Date.now() - request.timestamp);
        
        request.resolve(connection);
      } else {
        // Return to available pool
        this.availableConnections.push(connection);
      }
    } finally {
      release();
    }
  }
  
  /**
   * Destroy a connection (public API)
   */
  async destroy(connection) {
    return this._removeConnectionSafe(connection);
  }
  
  /**
   * Thread-safe connection removal
   */
  async _removeConnectionSafe(connection) {
    const release = await this.poolMutex.acquire();
    try {
      const removed = this.connections.delete(connection.id);
      if (!removed) return;
      
      // Remove from available connections
      const index = this.availableConnections.indexOf(connection);
      if (index !== -1) {
        this.availableConnections.splice(index, 1);
      }
      
      // Close socket
      if (connection.socket) {
        connection.socket.destroy();
      }
      
      this._incrementMetric('connectionsDestroyed');
      
      // Release semaphore permit
      this.connectionSemaphore.release();
      
      this.emit('connectionDestroyed', connection);
      
      // Create replacement if below minimum
      if (this.connections.size < this.options.minConnections) {
        setImmediate(() => this._createConnectionSafe().catch(err => {
          logger.error(`Failed to create replacement connection: ${err.message}`);
        }));
      }
    } finally {
      release();
    }
  }
  
  /**
   * Thread-safe metric increment
   */
  _incrementMetric(name, value = 1) {
    // Using atomic operations would be better, but JS doesn't have them
    // This is safe enough for metrics
    this.metrics[name] += value;
  }
  
  /**
   * Update average wait time
   */
  _updateAvgWaitTime(waitTime) {
    const alpha = 0.1; // Exponential moving average factor
    this.metrics.avgWaitTime = alpha * waitTime + (1 - alpha) * this.metrics.avgWaitTime;
  }
  
  /**
   * Start health check task
   */
  _startHealthCheck() {
    this.healthCheckInterval = setInterval(async () => {
      const release = await this.poolMutex.acquire();
      try {
        const unhealthyConnections = [];
        
        for (const conn of this.connections.values()) {
          if (!await conn.isHealthy()) {
            unhealthyConnections.push(conn);
          }
        }
        
        release();
        
        // Remove unhealthy connections
        for (const conn of unhealthyConnections) {
          await this._removeConnectionSafe(conn);
        }
        
        // Update metrics
        this.metrics.connectionsActive = this.connections.size - this.availableConnections.length;
        this.metrics.poolUtilization = this.connections.size > 0 ? 
          (this.metrics.connectionsActive / this.connections.size) : 0;
          
      } catch (error) {
        release();
        logger.error(`Health check error: ${error.message}`);
      }
    }, this.options.healthCheckInterval);
  }
  
  /**
   * Start maintenance task
   */
  _startMaintenanceTask() {
    this.maintenanceInterval = setInterval(async () => {
      const release = await this.poolMutex.acquire();
      try {
        const now = Date.now();
        const toRemove = [];
        
        // Remove idle connections above minimum
        if (this.connections.size > this.options.minConnections) {
          for (const conn of this.availableConnections) {
            if (conn.isIdle(this.options.idleTimeout)) {
              toRemove.push(conn);
              if (this.connections.size - toRemove.length <= this.options.minConnections) {
                break;
              }
            }
          }
        }
        
        release();
        
        // Remove idle connections
        for (const conn of toRemove) {
          await this._removeConnectionSafe(conn);
        }
        
      } catch (error) {
        release();
        logger.error(`Maintenance task error: ${error.message}`);
      }
    }, 60000); // Every minute
  }
  
  /**
   * Get pool statistics
   */
  async getStats() {
    const release = await this.poolMutex.acquire();
    try {
      return {
        ...this.metrics,
        totalConnections: this.connections.size,
        availableConnections: this.availableConnections.length,
        waitingRequests: this.waitQueue.length
      };
    } finally {
      release();
    }
  }
  
  /**
   * Drain and close all connections
   */
  async close() {
    logger.info('Closing connection pool');
    
    // Stop background tasks
    clearInterval(this.healthCheckInterval);
    clearInterval(this.maintenanceInterval);
    
    // Reject waiting requests
    const release = await this.poolMutex.acquire();
    try {
      for (const request of this.waitQueue) {
        clearTimeout(request.cleanupTimeout);
        request.reject(new Error('Connection pool is closing'));
      }
      this.waitQueue = [];
      
      // Close all connections
      const connections = Array.from(this.connections.values());
      release();
      
      await Promise.all(connections.map(conn => this._removeConnectionSafe(conn)));
      
    } catch (error) {
      release();
      logger.error(`Error closing pool: ${error.message}`);
    }
    
    this.emit('closed');
  }
  
  /**
   * Get pool metrics (alias for getStats for backward compatibility)
   */
  async getMetrics() {
    return this.getStats();
  }
  
  /**
   * Shutdown pool (alias for close for backward compatibility)
   */
  async shutdown() {
    return this.close();
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