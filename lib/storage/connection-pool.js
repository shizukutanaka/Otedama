/**
 * Database Connection Pool - Otedama
 * High-performance connection pooling for scalability
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import path from 'path';

const logger = createLogger('ConnectionPool');

/**
 * Connection Pool Manager
 */
export class ConnectionPoolManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      minConnections: options.minConnections || 2,
      maxConnections: options.maxConnections || 10,
      acquireTimeout: options.acquireTimeout || 30000,
      idleTimeout: options.idleTimeout || 60000,
      connectionTestInterval: options.connectionTestInterval || 30000,
      enableWAL: options.enableWAL !== false,
      enableVacuum: options.enableVacuum !== false,
      vacuumInterval: options.vacuumInterval || 86400000, // 24 hours
      ...options
    };
    
    this.connections = [];
    this.availableConnections = [];
    this.activeConnections = new Map();
    this.waitingQueue = [];
    this.initialized = false;
    
    this.stats = {
      connectionsCreated: 0,
      connectionsDestroyed: 0,
      acquisitions: 0,
      releases: 0,
      timeouts: 0,
      errors: 0,
      avgAcquireTime: 0,
      peakConnections: 0
    };
    
    // Timers
    this.idleCheckInterval = null;
    this.testInterval = null;
    this.vacuumTimer = null;
  }
  
  /**
   * Initialize connection pool
   */
  async initialize() {
    logger.info('Initializing connection pool...');
    
    try {
      // Ensure database directory exists
      const dbDir = path.dirname(this.config.databasePath);
      await fs.mkdir(dbDir, { recursive: true });
      
      // Create initial connections
      for (let i = 0; i < this.config.minConnections; i++) {
        await this.createConnection();
      }
      
      // Start maintenance tasks
      this.startIdleCheck();
      this.startConnectionTest();
      
      if (this.config.enableVacuum) {
        this.startVacuumTimer();
      }
      
      this.initialized = true;
      logger.info(`Connection pool initialized with ${this.connections.length} connections`);
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Connection pool initialization failed:', error);
      throw error;
    }
  }
  
  /**
   * Create new connection
   */
  async createConnection() {
    try {
      const connection = new Database(this.config.databasePath, {
        verbose: this.config.debug ? logger.debug : null,
        fileMustExist: false
      });
      
      // Configure connection
      this.configureConnection(connection);
      
      const connectionWrapper = {
        id: this.generateConnectionId(),
        db: connection,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        inUse: false,
        queryCount: 0,
        errorCount: 0
      };
      
      this.connections.push(connectionWrapper);
      this.availableConnections.push(connectionWrapper);
      this.stats.connectionsCreated++;
      
      logger.debug(`Created connection ${connectionWrapper.id}`);
      this.emit('connection:created', connectionWrapper.id);
      
      return connectionWrapper;
      
    } catch (error) {
      logger.error('Failed to create connection:', error);
      this.stats.errors++;
      throw error;
    }
  }
  
  /**
   * Configure database connection
   */
  configureConnection(db) {
    // Enable WAL mode for better concurrency
    if (this.config.enableWAL) {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
    }
    
    // Performance optimizations
    db.pragma('cache_size = -64000'); // 64MB cache
    db.pragma('mmap_size = 268435456'); // 256MB memory map
    db.pragma('temp_store = MEMORY');
    db.pragma('page_size = 4096');
    
    // Security settings
    db.pragma('secure_delete = ON');
    
    // Set busy timeout
    db.pragma(`busy_timeout = ${this.config.acquireTimeout}`);
  }
  
  /**
   * Acquire connection from pool
   */
  async acquire() {
    const startTime = Date.now();
    
    return new Promise((resolve, reject) => {
      const tryAcquire = () => {
        // Check for available connection
        const connection = this.availableConnections.shift();
        
        if (connection) {
          // Mark as in use
          connection.inUse = true;
          connection.lastUsedAt = Date.now();
          this.activeConnections.set(connection.id, connection);
          
          // Update stats
          this.stats.acquisitions++;
          this.updateAcquireTime(Date.now() - startTime);
          this.updatePeakConnections();
          
          logger.debug(`Acquired connection ${connection.id}`);
          resolve(connection);
          
        } else if (this.connections.length < this.config.maxConnections) {
          // Create new connection if under limit
          this.createConnection()
            .then(newConnection => {
              newConnection.inUse = true;
              this.availableConnections.shift(); // Remove from available
              this.activeConnections.set(newConnection.id, newConnection);
              
              this.stats.acquisitions++;
              this.updateAcquireTime(Date.now() - startTime);
              this.updatePeakConnections();
              
              resolve(newConnection);
            })
            .catch(reject);
            
        } else {
          // Queue request
          const timeoutId = setTimeout(() => {
            const index = this.waitingQueue.indexOf(request);
            if (index > -1) {
              this.waitingQueue.splice(index, 1);
              this.stats.timeouts++;
              reject(new Error('Connection acquire timeout'));
            }
          }, this.config.acquireTimeout);
          
          const request = { resolve, reject, timeoutId };
          this.waitingQueue.push(request);
        }
      };
      
      tryAcquire();
    });
  }
  
  /**
   * Release connection back to pool
   */
  release(connection) {
    if (!connection || !this.activeConnections.has(connection.id)) {
      logger.warn('Attempted to release invalid connection');
      return;
    }
    
    // Clear connection state
    connection.inUse = false;
    connection.lastUsedAt = Date.now();
    
    // Remove from active
    this.activeConnections.delete(connection.id);
    
    // Check if there are waiting requests
    if (this.waitingQueue.length > 0) {
      const request = this.waitingQueue.shift();
      clearTimeout(request.timeoutId);
      
      // Give connection to waiting request
      connection.inUse = true;
      this.activeConnections.set(connection.id, connection);
      request.resolve(connection);
      
    } else {
      // Return to available pool
      this.availableConnections.push(connection);
    }
    
    this.stats.releases++;
    logger.debug(`Released connection ${connection.id}`);
  }
  
  /**
   * Execute query with automatic connection management
   */
  async execute(fn) {
    const connection = await this.acquire();
    
    try {
      connection.queryCount++;
      return await fn(connection.db);
      
    } catch (error) {
      connection.errorCount++;
      throw error;
      
    } finally {
      this.release(connection);
    }
  }
  
  /**
   * Execute transaction with automatic connection management
   */
  async transaction(fn) {
    const connection = await this.acquire();
    
    try {
      connection.queryCount++;
      const transaction = connection.db.transaction(fn);
      return transaction();
      
    } catch (error) {
      connection.errorCount++;
      throw error;
      
    } finally {
      this.release(connection);
    }
  }
  
  /**
   * Prepare statement across all connections
   */
  prepareStatement(sql) {
    const statements = new Map();
    
    for (const connection of this.connections) {
      try {
        statements.set(connection.id, connection.db.prepare(sql));
      } catch (error) {
        logger.error(`Failed to prepare statement on connection ${connection.id}:`, error);
      }
    }
    
    return {
      run: async (...params) => {
        return this.execute(db => {
          const stmt = db.prepare(sql);
          return stmt.run(...params);
        });
      },
      
      get: async (...params) => {
        return this.execute(db => {
          const stmt = db.prepare(sql);
          return stmt.get(...params);
        });
      },
      
      all: async (...params) => {
        return this.execute(db => {
          const stmt = db.prepare(sql);
          return stmt.all(...params);
        });
      }
    };
  }
  
  /**
   * Start idle connection check
   */
  startIdleCheck() {
    this.idleCheckInterval = setInterval(() => {
      const now = Date.now();
      
      // Check for idle connections
      for (let i = this.availableConnections.length - 1; i >= 0; i--) {
        const connection = this.availableConnections[i];
        
        if (now - connection.lastUsedAt > this.config.idleTimeout &&
            this.connections.length > this.config.minConnections) {
          // Remove idle connection
          this.destroyConnection(connection);
        }
      }
    }, this.config.idleTimeout / 2);
  }
  
  /**
   * Start connection health test
   */
  startConnectionTest() {
    this.testInterval = setInterval(() => {
      for (const connection of this.availableConnections) {
        try {
          // Simple health check
          connection.db.prepare('SELECT 1').get();
          
        } catch (error) {
          logger.error(`Connection ${connection.id} health check failed:`, error);
          this.destroyConnection(connection);
        }
      }
    }, this.config.connectionTestInterval);
  }
  
  /**
   * Start vacuum timer
   */
  startVacuumTimer() {
    this.vacuumTimer = setInterval(async () => {
      try {
        await this.vacuum();
      } catch (error) {
        logger.error('Vacuum failed:', error);
      }
    }, this.config.vacuumInterval);
    
    // Run initial vacuum after 10 seconds
    setTimeout(() => this.vacuum(), 10000);
  }
  
  /**
   * Vacuum database
   */
  async vacuum() {
    logger.info('Starting database vacuum...');
    
    // Get dedicated connection for vacuum
    const connection = await this.acquire();
    
    try {
      // Run vacuum
      connection.db.prepare('VACUUM').run();
      
      // Analyze for query optimization
      connection.db.prepare('ANALYZE').run();
      
      logger.info('Database vacuum completed');
      this.emit('vacuum:completed');
      
    } catch (error) {
      logger.error('Vacuum failed:', error);
      this.stats.errors++;
      throw error;
      
    } finally {
      this.release(connection);
    }
  }
  
  /**
   * Destroy connection
   */
  destroyConnection(connection) {
    try {
      // Remove from pools
      const availableIndex = this.availableConnections.indexOf(connection);
      if (availableIndex > -1) {
        this.availableConnections.splice(availableIndex, 1);
      }
      
      const connectionIndex = this.connections.indexOf(connection);
      if (connectionIndex > -1) {
        this.connections.splice(connectionIndex, 1);
      }
      
      // Close database
      connection.db.close();
      
      this.stats.connectionsDestroyed++;
      logger.debug(`Destroyed connection ${connection.id}`);
      this.emit('connection:destroyed', connection.id);
      
    } catch (error) {
      logger.error(`Failed to destroy connection ${connection.id}:`, error);
      this.stats.errors++;
    }
  }
  
  /**
   * Generate connection ID
   */
  generateConnectionId() {
    return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Update average acquire time
   */
  updateAcquireTime(duration) {
    const total = this.stats.acquisitions;
    this.stats.avgAcquireTime = 
      (this.stats.avgAcquireTime * (total - 1) + duration) / total;
  }
  
  /**
   * Update peak connections
   */
  updatePeakConnections() {
    const active = this.activeConnections.size;
    if (active > this.stats.peakConnections) {
      this.stats.peakConnections = active;
    }
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      ...this.stats,
      totalConnections: this.connections.length,
      activeConnections: this.activeConnections.size,
      availableConnections: this.availableConnections.length,
      waitingRequests: this.waitingQueue.length,
      connectionHealth: this.getConnectionHealth()
    };
  }
  
  /**
   * Get connection health metrics
   */
  getConnectionHealth() {
    const health = [];
    
    for (const connection of this.connections) {
      health.push({
        id: connection.id,
        inUse: connection.inUse,
        queryCount: connection.queryCount,
        errorCount: connection.errorCount,
        errorRate: connection.queryCount > 0 
          ? (connection.errorCount / connection.queryCount * 100).toFixed(2)
          : 0,
        idleTime: Date.now() - connection.lastUsedAt,
        age: Date.now() - connection.createdAt
      });
    }
    
    return health;
  }
  
  /**
   * Drain pool (graceful shutdown)
   */
  async drain() {
    logger.info('Draining connection pool...');
    
    // Stop accepting new requests
    this.initialized = false;
    
    // Clear timers
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
    }
    if (this.testInterval) {
      clearInterval(this.testInterval);
    }
    if (this.vacuumTimer) {
      clearInterval(this.vacuumTimer);
    }
    
    // Wait for active connections to be released
    const timeout = Date.now() + this.config.acquireTimeout;
    while (this.activeConnections.size > 0 && Date.now() < timeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Force close remaining active connections
    for (const connection of this.activeConnections.values()) {
      logger.warn(`Force closing active connection ${connection.id}`);
      this.destroyConnection(connection);
    }
    
    // Close all connections
    for (const connection of this.connections) {
      try {
        connection.db.close();
      } catch (error) {
        logger.error(`Error closing connection ${connection.id}:`, error);
      }
    }
    
    this.connections = [];
    this.availableConnections = [];
    this.activeConnections.clear();
    this.waitingQueue = [];
    
    logger.info('Connection pool drained');
    this.emit('drained');
  }
  
  /**
   * Shutdown pool
   */
  async shutdown() {
    await this.drain();
    this.removeAllListeners();
  }
}

/**
 * Connection pool singleton instance
 */
let poolInstance = null;

/**
 * Get or create connection pool
 */
export function getConnectionPool(options) {
  if (!poolInstance) {
    poolInstance = new ConnectionPoolManager(options);
  }
  return poolInstance;
}

/**
 * Create new connection pool
 */
export function createConnectionPool(options) {
  return new ConnectionPoolManager(options);
}

export default {
  ConnectionPoolManager,
  getConnectionPool,
  createConnectionPool
};