/**
 * Enterprise-grade Connection Pool for Otedama
 * Following design principles:
 * - Carmack: Zero-allocation in hot paths, minimal overhead
 * - Martin: Clean interfaces, single responsibility
 * - Pike: Simple but powerful
 */

import { EventEmitter } from 'events';
import net from 'net';
import tls from 'tls';
import { logger } from './logger.js';

export const PoolState = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  READY: 'ready',
  BUSY: 'busy',
  ERROR: 'error',
  CLOSED: 'closed'
};

export class Connection {
  constructor(id, socket) {
    this.id = id;
    this.socket = socket;
    this.state = PoolState.IDLE;
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
    this.useCount = 0;
    this.currentRequest = null;
    this.tags = new Set();
  }
  
  isHealthy() {
    return this.socket && 
           !this.socket.destroyed && 
           this.socket.readyState === 'open' &&
           this.state !== PoolState.ERROR;
  }
  
  isExpired(maxAge) {
    return Date.now() - this.createdAt > maxAge;
  }
  
  isIdle(idleTimeout) {
    return this.state === PoolState.IDLE && 
           Date.now() - this.lastUsedAt > idleTimeout;
  }
}

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
      
      ...options
    };
    
    // Pool state
    this.connections = new Map();
    this.availableConnections = [];
    this.waitingRequests = [];
    this.connectionCounter = 0;
    
    // Metrics
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
    
    // Health check timer
    this.healthCheckTimer = null;
    
    // Initialize pool
    this._initialize();
  }
  
  async _initialize() {
    // Create minimum connections
    const promises = [];
    for (let i = 0; i < this.options.minConnections; i++) {
      promises.push(this._createConnection());
    }
    
    await Promise.allSettled(promises);
    
    // Start health check
    this._startHealthCheck();
    
    logger.info(`Connection pool initialized with ${this.connections.size} connections`);
  }
  
  async _createConnection() {
    const id = `conn_${++this.connectionCounter}`;
    
    try {
      const socket = await this._connect();
      const connection = new Connection(id, socket);
      
      // Configure socket
      if (this.options.tcpNoDelay) {
        socket.setNoDelay(true);
      }
      
      if (this.options.keepAlive) {
        socket.setKeepAlive(true, this.options.keepAliveDelay);
      }
      
      // Set up event handlers
      socket.on('error', (error) => {
        this._handleConnectionError(connection, error);
      });
      
      socket.on('close', () => {
        this._removeConnection(connection);
      });
      
      socket.on('timeout', () => {
        this._handleConnectionTimeout(connection);
      });
      
      // Add to pool
      connection.state = PoolState.READY;
      this.connections.set(id, connection);
      this.availableConnections.push(connection);
      
      this.metrics.connectionsCreated++;
      this.emit('connectionCreated', connection);
      
      return connection;
    } catch (error) {
      this.metrics.connectionsFailed++;
      logger.error(`Failed to create connection: ${error.message}`);
      throw error;
    }
  }
  
  async _connect() {
    return new Promise((resolve, reject) => {
      const connectOptions = {
        host: this.options.host,
        port: this.options.port
      };
      
      const onConnect = () => {
        socket.removeListener('error', onError);
        resolve(socket);
      };
      
      const onError = (error) => {
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
  
  async acquire(tags = []) {
    const startTime = Date.now();
    
    // Try to get available connection
    let connection = this._getAvailableConnection(tags);
    
    if (connection) {
      connection.state = PoolState.BUSY;
      connection.lastUsedAt = Date.now();
      connection.useCount++;
      this.metrics.requestsServed++;
      this._updateMetrics(Date.now() - startTime);
      return connection;
    }
    
    // Create new connection if under limit
    if (this.connections.size < this.options.maxConnections) {
      try {
        connection = await this._createConnection();
        connection.state = PoolState.BUSY;
        connection.useCount++;
        this.metrics.requestsServed++;
        return connection;
      } catch (error) {
        // Fall through to waiting
      }
    }
    
    // Wait for available connection
    return this._waitForConnection(tags);
  }
  
  _getAvailableConnection(tags) {
    // First try to find connection with matching tags
    if (tags.length > 0) {
      for (let i = this.availableConnections.length - 1; i >= 0; i--) {
        const conn = this.availableConnections[i];
        if (conn.isHealthy() && tags.every(tag => conn.tags.has(tag))) {
          this.availableConnections.splice(i, 1);
          return conn;
        }
      }
    }
    
    // Then try any available connection
    while (this.availableConnections.length > 0) {
      const conn = this.availableConnections.pop();
      if (conn.isHealthy()) {
        return conn;
      } else {
        this._removeConnection(conn);
      }
    }
    
    return null;
  }
  
  async _waitForConnection(tags) {
    return new Promise((resolve, reject) => {
      const request = {
        resolve,
        reject,
        tags,
        timestamp: Date.now(),
        timer: setTimeout(() => {
          this._timeoutRequest(request);
        }, this.options.acquireTimeout)
      };
      
      this.waitingRequests.push(request);
      this.metrics.requestsQueued++;
    });
  }
  
  release(connection) {
    if (!connection || !this.connections.has(connection.id)) {
      return;
    }
    
    // Clear any tags
    connection.tags.clear();
    
    // Check if connection is still healthy
    if (!connection.isHealthy() || connection.isExpired(this.options.maxConnectionAge)) {
      this._removeConnection(connection);
      return;
    }
    
    // Check for waiting requests
    if (this.waitingRequests.length > 0) {
      const request = this.waitingRequests.shift();
      clearTimeout(request.timer);
      connection.state = PoolState.BUSY;
      connection.lastUsedAt = Date.now();
      connection.useCount++;
      request.resolve(connection);
      this._updateMetrics(Date.now() - request.timestamp);
      return;
    }
    
    // Return to available pool
    connection.state = PoolState.READY;
    this.availableConnections.push(connection);
  }
  
  async destroy(connection) {
    this._removeConnection(connection);
  }
  
  _removeConnection(connection) {
    if (!this.connections.has(connection.id)) {
      return;
    }
    
    this.connections.delete(connection.id);
    
    // Remove from available pool
    const index = this.availableConnections.indexOf(connection);
    if (index >= 0) {
      this.availableConnections.splice(index, 1);
    }
    
    // Close socket
    if (connection.socket) {
      connection.socket.destroy();
    }
    
    connection.state = PoolState.CLOSED;
    this.metrics.connectionsDestroyed++;
    
    this.emit('connectionDestroyed', connection);
    
    // Maintain minimum connections
    if (this.connections.size < this.options.minConnections) {
      this._createConnection().catch(() => {});
    }
  }
  
  _handleConnectionError(connection, error) {
    logger.error(`Connection ${connection.id} error: ${error.message}`);
    connection.state = PoolState.ERROR;
    this._removeConnection(connection);
  }
  
  _handleConnectionTimeout(connection) {
    logger.warn(`Connection ${connection.id} timeout`);
    this._removeConnection(connection);
  }
  
  _timeoutRequest(request) {
    const index = this.waitingRequests.indexOf(request);
    if (index >= 0) {
      this.waitingRequests.splice(index, 1);
      this.metrics.requestsTimeout++;
      request.reject(new Error('Connection acquire timeout'));
    }
  }
  
  _startHealthCheck() {
    this.healthCheckTimer = setInterval(() => {
      this._performHealthCheck();
    }, this.options.healthCheckInterval);
  }
  
  _performHealthCheck() {
    // Remove unhealthy connections
    for (const connection of this.connections.values()) {
      if (!connection.isHealthy() || 
          connection.isExpired(this.options.maxConnectionAge) ||
          connection.isIdle(this.options.idleTimeout)) {
        this._removeConnection(connection);
      }
    }
    
    // Update metrics
    this.metrics.connectionsActive = Array.from(this.connections.values())
      .filter(c => c.state === PoolState.BUSY).length;
    
    this.metrics.poolUtilization = this.connections.size > 0 
      ? this.metrics.connectionsActive / this.connections.size 
      : 0;
  }
  
  _updateMetrics(waitTime) {
    const alpha = 0.1; // Exponential moving average factor
    this.metrics.avgWaitTime = this.metrics.avgWaitTime * (1 - alpha) + waitTime * alpha;
  }
  
  async shutdown() {
    // Stop health check
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    
    // Reject waiting requests
    for (const request of this.waitingRequests) {
      clearTimeout(request.timer);
      request.reject(new Error('Pool shutting down'));
    }
    this.waitingRequests = [];
    
    // Close all connections
    const promises = [];
    for (const connection of this.connections.values()) {
      promises.push(new Promise(resolve => {
        connection.socket.end(() => resolve());
      }));
    }
    
    await Promise.allSettled(promises);
    this.connections.clear();
    this.availableConnections = [];
    
    logger.info('Connection pool shut down');
  }
  
  getMetrics() {
    return {
      ...this.metrics,
      poolSize: this.connections.size,
      availableConnections: this.availableConnections.length,
      waitingRequests: this.waitingRequests.length
    };
  }
}

export default ConnectionPool;