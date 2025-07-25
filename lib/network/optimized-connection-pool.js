/**
 * Optimized Connection Pool
 * High-performance connection pooling with multiplexing
 * 
 * Features:
 * - Connection multiplexing
 * - Warm connection pool
 * - Connection health monitoring
 * - Automatic reconnection
 * - Request pipelining
 */

import { EventEmitter } from 'events';
import net from 'net';
import tls from 'tls';
import { createLogger } from '../core/logger.js';

const logger = createLogger('ConnectionPool');

/**
 * Connection states
 */
const ConnectionState = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  READY: 'ready',
  BUSY: 'busy',
  CLOSING: 'closing',
  CLOSED: 'closed',
  ERROR: 'error'
};

/**
 * Pooled Connection
 */
class PooledConnection extends EventEmitter {
  constructor(id, options) {
    super();
    
    this.id = id;
    this.options = options;
    this.state = ConnectionState.IDLE;
    this.socket = null;
    
    // Statistics
    this.stats = {
      created: Date.now(),
      requests: 0,
      errors: 0,
      bytesRead: 0,
      bytesWritten: 0,
      lastUsed: 0
    };
    
    // Request queue for pipelining
    this.requestQueue = [];
    this.activeRequests = 0;
    this.maxPipelinedRequests = options.maxPipelinedRequests || 10;
    
    // Health check
    this.lastHealthCheck = 0;
    this.consecutiveErrors = 0;
  }
  
  /**
   * Connect to server
   */
  async connect() {
    if (this.state !== ConnectionState.IDLE && this.state !== ConnectionState.ERROR) {
      return;
    }
    
    this.state = ConnectionState.CONNECTING;
    
    return new Promise((resolve, reject) => {
      const connectOptions = {
        host: this.options.host,
        port: this.options.port,
        ...this.options.socketOptions
      };
      
      // Create socket (TLS or regular)
      this.socket = this.options.tls ? 
        tls.connect(connectOptions) : 
        net.connect(connectOptions);
      
      // Set socket options
      this.socket.setNoDelay(true);
      this.socket.setKeepAlive(true, 30000);
      
      // Timeout
      const timeout = setTimeout(() => {
        this.socket.destroy();
        reject(new Error('Connection timeout'));
      }, this.options.connectTimeout || 5000);
      
      // Connection established
      this.socket.once('connect', () => {
        clearTimeout(timeout);
        this.state = ConnectionState.READY;
        this.consecutiveErrors = 0;
        
        this.setupSocketHandlers();
        resolve();
      });
      
      // Connection error
      this.socket.once('error', (error) => {
        clearTimeout(timeout);
        this.state = ConnectionState.ERROR;
        this.consecutiveErrors++;
        reject(error);
      });
    });
  }
  
  /**
   * Setup socket event handlers
   */
  setupSocketHandlers() {
    this.socket.on('data', (data) => {
      this.stats.bytesRead += data.length;
      this.emit('data', data);
    });
    
    this.socket.on('error', (error) => {
      this.stats.errors++;
      this.consecutiveErrors++;
      this.handleError(error);
    });
    
    this.socket.on('close', () => {
      this.state = ConnectionState.CLOSED;
      this.emit('close');
    });
    
    this.socket.on('timeout', () => {
      this.handleError(new Error('Socket timeout'));
    });
  }
  
  /**
   * Send request with pipelining support
   */
  async sendRequest(data) {
    if (this.state !== ConnectionState.READY) {
      throw new Error(`Connection not ready: ${this.state}`);
    }
    
    return new Promise((resolve, reject) => {
      const request = {
        data,
        resolve,
        reject,
        timestamp: Date.now()
      };
      
      // Add to queue
      this.requestQueue.push(request);
      
      // Process queue if not at capacity
      if (this.activeRequests < this.maxPipelinedRequests) {
        this.processRequestQueue();
      }
    });
  }
  
  /**
   * Process request queue
   */
  processRequestQueue() {
    while (this.requestQueue.length > 0 && 
           this.activeRequests < this.maxPipelinedRequests &&
           this.state === ConnectionState.READY) {
      
      const request = this.requestQueue.shift();
      this.activeRequests++;
      
      // Send data
      this.socket.write(request.data, (error) => {
        if (error) {
          this.activeRequests--;
          request.reject(error);
        } else {
          this.stats.bytesWritten += request.data.length;
          this.stats.requests++;
          this.stats.lastUsed = Date.now();
          
          // For simplicity, resolve immediately
          // In production, would match responses
          this.activeRequests--;
          request.resolve();
          
          // Process next request
          if (this.requestQueue.length > 0) {
            setImmediate(() => this.processRequestQueue());
          }
        }
      });
    }
  }
  
  /**
   * Check connection health
   */
  async checkHealth() {
    if (this.state !== ConnectionState.READY) {
      return false;
    }
    
    try {
      // Simple write test
      await new Promise((resolve, reject) => {
        this.socket.write('PING\r\n', (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      
      this.lastHealthCheck = Date.now();
      return true;
      
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Handle connection error
   */
  handleError(error) {
    logger.error(`Connection ${this.id} error:`, error);
    this.state = ConnectionState.ERROR;
    
    // Reject all pending requests
    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();
      request.reject(error);
    }
    
    this.emit('error', error);
  }
  
  /**
   * Close connection
   */
  close() {
    if (this.state === ConnectionState.CLOSED || 
        this.state === ConnectionState.CLOSING) {
      return;
    }
    
    this.state = ConnectionState.CLOSING;
    
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
    }
    
    this.state = ConnectionState.CLOSED;
  }
  
  /**
   * Check if connection is healthy
   */
  isHealthy() {
    return this.state === ConnectionState.READY && 
           this.consecutiveErrors < 3 &&
           (Date.now() - this.stats.lastUsed) < 60000; // Used in last minute
  }
  
  /**
   * Get connection statistics
   */
  getStats() {
    return {
      ...this.stats,
      state: this.state,
      uptime: Date.now() - this.stats.created,
      queueLength: this.requestQueue.length,
      activeRequests: this.activeRequests
    };
  }
}

/**
 * Optimized Connection Pool
 */
export class OptimizedConnectionPool extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      host: options.host || 'localhost',
      port: options.port || 80,
      tls: options.tls || false,
      minConnections: options.minConnections || 5,
      maxConnections: options.maxConnections || 50,
      acquireTimeout: options.acquireTimeout || 5000,
      idleTimeout: options.idleTimeout || 60000,
      healthCheckInterval: options.healthCheckInterval || 30000,
      warmupConnections: options.warmupConnections !== false,
      ...options
    };
    
    this.connections = new Map();
    this.availableConnections = [];
    this.waitingRequests = [];
    
    this.stats = {
      created: 0,
      destroyed: 0,
      acquired: 0,
      released: 0,
      timeouts: 0,
      errors: 0
    };
    
    this.healthCheckTimer = null;
    this.initialized = false;
  }
  
  /**
   * Initialize connection pool
   */
  async initialize() {
    logger.info(`Initializing connection pool for ${this.options.host}:${this.options.port}`);
    
    // Create minimum connections
    const promises = [];
    for (let i = 0; i < this.options.minConnections; i++) {
      promises.push(this.createConnection());
    }
    
    await Promise.allSettled(promises);
    
    // Start health checks
    this.startHealthChecks();
    
    // Warmup connections if enabled
    if (this.options.warmupConnections) {
      this.warmupConnections();
    }
    
    this.initialized = true;
    logger.info(`Connection pool initialized with ${this.connections.size} connections`);
  }
  
  /**
   * Create new connection
   */
  async createConnection() {
    const id = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const connection = new PooledConnection(id, this.options);
    
    try {
      await connection.connect();
      
      this.connections.set(id, connection);
      this.availableConnections.push(connection);
      this.stats.created++;
      
      // Setup event handlers
      connection.on('error', () => this.handleConnectionError(connection));
      connection.on('close', () => this.handleConnectionClose(connection));
      
      logger.debug(`Created connection ${id}`);
      return connection;
      
    } catch (error) {
      logger.error(`Failed to create connection:`, error);
      this.stats.errors++;
      throw error;
    }
  }
  
  /**
   * Acquire connection from pool
   */
  async acquire() {
    this.stats.acquired++;
    
    // Try to get available connection
    let connection = this.getAvailableConnection();
    
    if (connection) {
      return connection;
    }
    
    // Create new connection if under limit
    if (this.connections.size < this.options.maxConnections) {
      try {
        connection = await this.createConnection();
        this.availableConnections.pop(); // Remove from available
        return connection;
      } catch (error) {
        // Fall through to wait
      }
    }
    
    // Wait for connection to become available
    return this.waitForConnection();
  }
  
  /**
   * Get available connection
   */
  getAvailableConnection() {
    while (this.availableConnections.length > 0) {
      const connection = this.availableConnections.pop();
      
      if (connection.isHealthy()) {
        return connection;
      } else {
        // Destroy unhealthy connection
        this.destroyConnection(connection);
      }
    }
    
    return null;
  }
  
  /**
   * Wait for connection to become available
   */
  waitForConnection() {
    return new Promise((resolve, reject) => {
      const request = {
        resolve,
        reject,
        timestamp: Date.now()
      };
      
      // Timeout
      const timeout = setTimeout(() => {
        const index = this.waitingRequests.indexOf(request);
        if (index !== -1) {
          this.waitingRequests.splice(index, 1);
          this.stats.timeouts++;
          reject(new Error('Connection acquire timeout'));
        }
      }, this.options.acquireTimeout);
      
      request.timeout = timeout;
      this.waitingRequests.push(request);
    });
  }
  
  /**
   * Release connection back to pool
   */
  release(connection) {
    this.stats.released++;
    
    // Check if connection is still healthy
    if (!connection.isHealthy()) {
      this.destroyConnection(connection);
      this.ensureMinimumConnections();
      return;
    }
    
    // Check for waiting requests
    if (this.waitingRequests.length > 0) {
      const request = this.waitingRequests.shift();
      clearTimeout(request.timeout);
      request.resolve(connection);
      return;
    }
    
    // Add back to available pool
    this.availableConnections.push(connection);
    
    // Destroy if over minimum and idle
    if (this.connections.size > this.options.minConnections) {
      setTimeout(() => {
        if (this.availableConnections.includes(connection) &&
            Date.now() - connection.stats.lastUsed > this.options.idleTimeout) {
          this.destroyConnection(connection);
        }
      }, this.options.idleTimeout);
    }
  }
  
  /**
   * Destroy connection
   */
  destroyConnection(connection) {
    connection.close();
    this.connections.delete(connection.id);
    
    const index = this.availableConnections.indexOf(connection);
    if (index !== -1) {
      this.availableConnections.splice(index, 1);
    }
    
    this.stats.destroyed++;
    logger.debug(`Destroyed connection ${connection.id}`);
  }
  
  /**
   * Handle connection error
   */
  handleConnectionError(connection) {
    logger.error(`Connection ${connection.id} error`);
    this.destroyConnection(connection);
    this.ensureMinimumConnections();
  }
  
  /**
   * Handle connection close
   */
  handleConnectionClose(connection) {
    this.destroyConnection(connection);
    this.ensureMinimumConnections();
  }
  
  /**
   * Ensure minimum connections
   */
  async ensureMinimumConnections() {
    const deficit = this.options.minConnections - this.connections.size;
    
    if (deficit > 0) {
      const promises = [];
      for (let i = 0; i < deficit; i++) {
        promises.push(this.createConnection().catch(() => {}));
      }
      await Promise.allSettled(promises);
    }
  }
  
  /**
   * Warmup connections
   */
  async warmupConnections() {
    logger.info('Warming up connections...');
    
    const promises = [];
    for (const connection of this.connections.values()) {
      promises.push(connection.checkHealth());
    }
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Start health checks
   */
  startHealthChecks() {
    this.healthCheckTimer = setInterval(async () => {
      for (const connection of this.connections.values()) {
        if (Date.now() - connection.lastHealthCheck > this.options.healthCheckInterval) {
          const healthy = await connection.checkHealth();
          if (!healthy && this.availableConnections.includes(connection)) {
            this.destroyConnection(connection);
          }
        }
      }
      
      // Ensure minimum connections
      await this.ensureMinimumConnections();
      
    }, this.options.healthCheckInterval);
  }
  
  /**
   * Execute request with connection from pool
   */
  async execute(requestFn) {
    const connection = await this.acquire();
    
    try {
      const result = await requestFn(connection);
      this.release(connection);
      return result;
      
    } catch (error) {
      // Destroy connection on error
      this.destroyConnection(connection);
      this.ensureMinimumConnections();
      throw error;
    }
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    const connectionStats = Array.from(this.connections.values())
      .map(conn => conn.getStats());
    
    return {
      poolStats: this.stats,
      connections: {
        total: this.connections.size,
        available: this.availableConnections.length,
        busy: this.connections.size - this.availableConnections.length,
        waiting: this.waitingRequests.length
      },
      connectionDetails: connectionStats
    };
  }
  
  /**
   * Drain pool (graceful shutdown)
   */
  async drain() {
    logger.info('Draining connection pool...');
    
    // Stop health checks
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    
    // Reject waiting requests
    while (this.waitingRequests.length > 0) {
      const request = this.waitingRequests.shift();
      clearTimeout(request.timeout);
      request.reject(new Error('Pool draining'));
    }
    
    // Close all connections
    const promises = [];
    for (const connection of this.connections.values()) {
      promises.push(new Promise(resolve => {
        connection.close();
        resolve();
      }));
    }
    
    await Promise.all(promises);
    
    this.connections.clear();
    this.availableConnections = [];
    
    logger.info('Connection pool drained');
  }
}

export default OptimizedConnectionPool;
