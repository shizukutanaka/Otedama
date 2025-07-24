/**
 * Database Connection Pool
 * High-performance database connection management with auto-scaling
 */

const EventEmitter = require('events');
const { performance } = require('perf_hooks');

class DatabaseConnectionPool extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Pool settings
      minConnections: options.minConnections || 5,
      maxConnections: options.maxConnections || 20,
      acquireTimeout: options.acquireTimeout || 30000,
      idleTimeout: options.idleTimeout || 600000, // 10 minutes
      
      // Connection settings
      database: options.database || {},
      
      // Performance settings
      connectionRetries: options.connectionRetries || 3,
      retryDelay: options.retryDelay || 1000,
      healthCheckInterval: options.healthCheckInterval || 60000,
      
      // Monitoring
      enableMetrics: options.enableMetrics !== false,
      metricsInterval: options.metricsInterval || 30000,
      
      ...options
    };
    
    // Connection pool state
    this.connections = {
      available: [],
      busy: new Map(),
      total: 0,
      creating: 0
    };
    
    // Queue for connection requests
    this.requestQueue = [];
    
    // Metrics
    this.metrics = {
      totalConnections: 0,
      activeConnections: 0,
      queuedRequests: 0,
      totalQueries: 0,
      avgQueryTime: 0,
      connectionErrors: 0,
      poolHits: 0,
      poolMisses: 0,
      connectionsCreated: 0,
      connectionsDestroyed: 0
    };
    
    // Performance tracking
    this.queryTimes = [];
    this.connectionTimes = [];
    
    this.initialized = false;
  }
  
  /**
   * Initialize the connection pool
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      // Create initial connections
      await this.createInitialConnections();
      
      // Start background tasks
      this.startHealthCheck();
      this.startMetricsCollection();
      this.startConnectionManager();
      
      this.initialized = true;
      this.emit('initialized');
      
      console.log(`Database connection pool initialized with ${this.connections.total} connections`);
      
    } catch (error) {
      console.error('Failed to initialize connection pool:', error);
      throw error;
    }
  }
  
  /**
   * Create initial pool connections
   */
  async createInitialConnections() {
    const promises = [];
    
    for (let i = 0; i < this.config.minConnections; i++) {
      promises.push(this.createConnection());
    }
    
    await Promise.all(promises);
  }
  
  /**
   * Create a new database connection
   */
  async createConnection() {
    const startTime = performance.now();
    this.connections.creating++;
    
    try {
      let connection;
      
      // Create connection based on database type
      if (this.config.database.type === 'postgresql') {
        connection = await this.createPostgreSQLConnection();
      } else if (this.config.database.type === 'sqlite') {
        connection = await this.createSQLiteConnection();
      } else if (this.config.database.type === 'mysql') {
        connection = await this.createMySQLConnection();
      } else {
        throw new Error(`Unsupported database type: ${this.config.database.type}`);
      }\n      \n      // Setup connection metadata\n      connection.id = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;\n      connection.createdAt = Date.now();\n      connection.lastUsed = Date.now();\n      connection.queryCount = 0;\n      connection.totalQueryTime = 0;\n      connection.healthy = true;\n      \n      // Setup connection event handlers\n      this.setupConnectionHandlers(connection);\n      \n      // Add to available pool\n      this.connections.available.push(connection);\n      this.connections.total++;\n      this.connections.creating--;\n      \n      // Update metrics\n      this.metrics.connectionsCreated++;\n      this.metrics.totalConnections = this.connections.total;\n      \n      const connectionTime = performance.now() - startTime;\n      this.connectionTimes.push(connectionTime);\n      \n      this.emit('connection:created', { connectionId: connection.id, time: connectionTime });\n      \n      return connection;\n      \n    } catch (error) {\n      this.connections.creating--;\n      this.metrics.connectionErrors++;\n      \n      console.error('Failed to create database connection:', error);\n      throw error;\n    }\n  }\n  \n  /**\n   * Create PostgreSQL connection\n   */\n  async createPostgreSQLConnection() {\n    const { Client } = require('pg');\n    \n    const client = new Client({\n      host: this.config.database.host,\n      port: this.config.database.port || 5432,\n      database: this.config.database.database,\n      user: this.config.database.user,\n      password: this.config.database.password,\n      ssl: this.config.database.ssl,\n      connectionTimeoutMillis: this.config.acquireTimeout,\n      idleTimeoutMillis: this.config.idleTimeout,\n      query_timeout: 30000,\n      statement_timeout: 30000\n    });\n    \n    await client.connect();\n    \n    // Enhance client with pool-specific methods\n    client.query = this.wrapQueryMethod(client.query.bind(client));\n    client.poolRelease = () => this.releaseConnection(client);\n    \n    return client;\n  }\n  \n  /**\n   * Create SQLite connection\n   */\n  async createSQLiteConnection() {\n    const Database = require('better-sqlite3');\n    \n    const db = new Database(this.config.database.filename || ':memory:', {\n      readonly: this.config.database.readonly || false,\n      fileMustExist: this.config.database.fileMustExist || false,\n      timeout: this.config.acquireTimeout,\n      verbose: this.config.database.verbose ? console.log : null\n    });\n    \n    // Configure SQLite for performance\n    db.pragma('journal_mode = WAL');\n    db.pragma('synchronous = NORMAL');\n    db.pragma('cache_size = 10000');\n    db.pragma('temp_store = MEMORY');\n    \n    // Enhance with pool-specific methods\n    db.query = this.wrapQueryMethod(db.prepare.bind(db));\n    db.poolRelease = () => this.releaseConnection(db);\n    \n    return db;\n  }\n  \n  /**\n   * Create MySQL connection\n   */\n  async createMySQLConnection() {\n    const mysql = require('mysql2/promise');\n    \n    const connection = await mysql.createConnection({\n      host: this.config.database.host,\n      port: this.config.database.port || 3306,\n      user: this.config.database.user,\n      password: this.config.database.password,\n      database: this.config.database.database,\n      ssl: this.config.database.ssl,\n      connectTimeout: this.config.acquireTimeout,\n      acquireTimeout: this.config.acquireTimeout,\n      timeout: 30000\n    });\n    \n    // Enhance with pool-specific methods\n    connection.query = this.wrapQueryMethod(connection.query.bind(connection));\n    connection.poolRelease = () => this.releaseConnection(connection);\n    \n    return connection;\n  }\n  \n  /**\n   * Wrap query method for performance tracking\n   */\n  wrapQueryMethod(originalQuery) {\n    return async (...args) => {\n      const startTime = performance.now();\n      this.metrics.totalQueries++;\n      \n      try {\n        const result = await originalQuery(...args);\n        \n        const queryTime = performance.now() - startTime;\n        this.queryTimes.push(queryTime);\n        \n        // Update average query time\n        this.metrics.avgQueryTime = \n          ((this.metrics.avgQueryTime * (this.metrics.totalQueries - 1)) + queryTime) / \n          this.metrics.totalQueries;\n        \n        return result;\n        \n      } catch (error) {\n        const queryTime = performance.now() - startTime;\n        this.queryTimes.push(queryTime);\n        throw error;\n      }\n    };\n  }\n  \n  /**\n   * Setup connection event handlers\n   */\n  setupConnectionHandlers(connection) {\n    if (connection.on) {\n      connection.on('error', (error) => {\n        console.error(`Connection ${connection.id} error:`, error);\n        connection.healthy = false;\n        this.removeConnection(connection);\n      });\n      \n      connection.on('end', () => {\n        console.log(`Connection ${connection.id} ended`);\n        this.removeConnection(connection);\n      });\n    }\n  }\n  \n  /**\n   * Acquire connection from pool\n   */\n  async acquireConnection() {\n    return new Promise((resolve, reject) => {\n      const request = {\n        resolve,\n        reject,\n        requestedAt: Date.now(),\n        timeout: setTimeout(() => {\n          reject(new Error('Connection acquire timeout'));\n        }, this.config.acquireTimeout)\n      };\n      \n      // Try to get available connection immediately\n      const connection = this.getAvailableConnection();\n      if (connection) {\n        clearTimeout(request.timeout);\n        resolve(connection);\n        return;\n      }\n      \n      // Queue the request\n      this.requestQueue.push(request);\n      this.metrics.queuedRequests++;\n      \n      // Try to create new connection if possible\n      this.tryCreateConnection();\n    });\n  }\n  \n  /**\n   * Get available connection from pool\n   */\n  getAvailableConnection() {\n    // Check for available healthy connections\n    for (let i = this.connections.available.length - 1; i >= 0; i--) {\n      const connection = this.connections.available[i];\n      \n      if (connection.healthy) {\n        // Remove from available pool\n        this.connections.available.splice(i, 1);\n        \n        // Add to busy pool\n        this.connections.busy.set(connection.id, {\n          connection,\n          acquiredAt: Date.now()\n        });\n        \n        // Update connection metadata\n        connection.lastUsed = Date.now();\n        \n        // Update metrics\n        this.metrics.poolHits++;\n        this.metrics.activeConnections = this.connections.busy.size;\n        \n        return connection;\n      } else {\n        // Remove unhealthy connection\n        this.connections.available.splice(i, 1);\n        this.removeConnection(connection);\n      }\n    }\n    \n    this.metrics.poolMisses++;\n    return null;\n  }\n  \n  /**\n   * Try to create new connection if needed\n   */\n  async tryCreateConnection() {\n    if (this.connections.total + this.connections.creating < this.config.maxConnections) {\n      try {\n        await this.createConnection();\n        this.processQueue();\n      } catch (error) {\n        console.error('Failed to create connection for queue:', error);\n      }\n    }\n  }\n  \n  /**\n   * Process queued connection requests\n   */\n  processQueue() {\n    while (this.requestQueue.length > 0 && this.connections.available.length > 0) {\n      const request = this.requestQueue.shift();\n      this.metrics.queuedRequests--;\n      \n      const connection = this.getAvailableConnection();\n      if (connection) {\n        clearTimeout(request.timeout);\n        request.resolve(connection);\n      } else {\n        // Put request back at front of queue\n        this.requestQueue.unshift(request);\n        break;\n      }\n    }\n  }\n  \n  /**\n   * Release connection back to pool\n   */\n  releaseConnection(connection) {\n    // Remove from busy pool\n    const busyInfo = this.connections.busy.get(connection.id);\n    if (busyInfo) {\n      this.connections.busy.delete(connection.id);\n      \n      // Update connection stats\n      const usageTime = Date.now() - busyInfo.acquiredAt;\n      connection.totalQueryTime += usageTime;\n      connection.queryCount++;\n    }\n    \n    // Check if connection is still healthy\n    if (connection.healthy) {\n      // Return to available pool\n      this.connections.available.push(connection);\n      \n      // Process any queued requests\n      this.processQueue();\n      \n    } else {\n      // Remove unhealthy connection\n      this.removeConnection(connection);\n    }\n    \n    // Update metrics\n    this.metrics.activeConnections = this.connections.busy.size;\n  }\n  \n  /**\n   * Remove connection from pool\n   */\n  removeConnection(connection) {\n    try {\n      // Close connection\n      if (connection.end) {\n        connection.end();\n      } else if (connection.close) {\n        connection.close();\n      }\n      \n      // Remove from all pools\n      const availableIndex = this.connections.available.indexOf(connection);\n      if (availableIndex !== -1) {\n        this.connections.available.splice(availableIndex, 1);\n      }\n      \n      this.connections.busy.delete(connection.id);\n      this.connections.total--;\n      \n      // Update metrics\n      this.metrics.connectionsDestroyed++;\n      this.metrics.totalConnections = this.connections.total;\n      this.metrics.activeConnections = this.connections.busy.size;\n      \n      this.emit('connection:removed', { connectionId: connection.id });\n      \n      // Ensure minimum connections\n      if (this.connections.total < this.config.minConnections) {\n        this.createConnection().catch(error => {\n          console.error('Failed to replace removed connection:', error);\n        });\n      }\n      \n    } catch (error) {\n      console.error('Error removing connection:', error);\n    }\n  }\n  \n  /**\n   * Execute query with automatic connection management\n   */\n  async query(sql, params = []) {\n    const connection = await this.acquireConnection();\n    \n    try {\n      const result = await connection.query(sql, params);\n      return result;\n      \n    } finally {\n      this.releaseConnection(connection);\n    }\n  }\n  \n  /**\n   * Execute transaction with automatic connection management\n   */\n  async transaction(callback) {\n    const connection = await this.acquireConnection();\n    \n    try {\n      // Begin transaction\n      await connection.query('BEGIN');\n      \n      // Execute callback with connection\n      const result = await callback(connection);\n      \n      // Commit transaction\n      await connection.query('COMMIT');\n      \n      return result;\n      \n    } catch (error) {\n      // Rollback on error\n      try {\n        await connection.query('ROLLBACK');\n      } catch (rollbackError) {\n        console.error('Rollback failed:', rollbackError);\n      }\n      \n      throw error;\n      \n    } finally {\n      this.releaseConnection(connection);\n    }\n  }\n  \n  /**\n   * Start health check process\n   */\n  startHealthCheck() {\n    setInterval(async () => {\n      await this.performHealthCheck();\n    }, this.config.healthCheckInterval);\n  }\n  \n  /**\n   * Perform health check on all connections\n   */\n  async performHealthCheck() {\n    const healthChecks = [];\n    \n    // Check available connections\n    for (const connection of this.connections.available) {\n      healthChecks.push(this.checkConnectionHealth(connection));\n    }\n    \n    // Check busy connections (if idle too long)\n    const now = Date.now();\n    for (const [id, busyInfo] of this.connections.busy) {\n      if (now - busyInfo.acquiredAt > this.config.idleTimeout) {\n        healthChecks.push(this.checkConnectionHealth(busyInfo.connection));\n      }\n    }\n    \n    await Promise.allSettled(healthChecks);\n  }\n  \n  /**\n   * Check individual connection health\n   */\n  async checkConnectionHealth(connection) {\n    try {\n      // Simple ping query\n      await connection.query('SELECT 1');\n      connection.healthy = true;\n      \n    } catch (error) {\n      console.warn(`Connection ${connection.id} failed health check:`, error.message);\n      connection.healthy = false;\n    }\n  }\n  \n  /**\n   * Start connection manager for cleanup and optimization\n   */\n  startConnectionManager() {\n    setInterval(() => {\n      this.cleanupIdleConnections();\n      this.optimizePool();\n    }, 60000); // Every minute\n  }\n  \n  /**\n   * Cleanup idle connections\n   */\n  cleanupIdleConnections() {\n    const now = Date.now();\n    const connectionsToRemove = [];\n    \n    // Find idle connections to remove\n    for (const connection of this.connections.available) {\n      if (now - connection.lastUsed > this.config.idleTimeout &&\n          this.connections.total > this.config.minConnections) {\n        connectionsToRemove.push(connection);\n      }\n    }\n    \n    // Remove idle connections\n    for (const connection of connectionsToRemove) {\n      this.removeConnection(connection);\n    }\n  }\n  \n  /**\n   * Optimize pool based on usage patterns\n   */\n  optimizePool() {\n    const queuedRequests = this.requestQueue.length;\n    const busyConnections = this.connections.busy.size;\n    const availableConnections = this.connections.available.length;\n    \n    // Auto-scale up if needed\n    if (queuedRequests > 0 && this.connections.total < this.config.maxConnections) {\n      const connectionsToCreate = Math.min(\n        queuedRequests,\n        this.config.maxConnections - this.connections.total\n      );\n      \n      for (let i = 0; i < connectionsToCreate; i++) {\n        this.createConnection().catch(error => {\n          console.error('Auto-scale connection creation failed:', error);\n        });\n      }\n    }\n  }\n  \n  /**\n   * Start metrics collection\n   */\n  startMetricsCollection() {\n    if (!this.config.enableMetrics) return;\n    \n    setInterval(() => {\n      this.updateMetrics();\n      this.emit('metrics', this.getMetrics());\n    }, this.config.metricsInterval);\n  }\n  \n  /**\n   * Update metrics\n   */\n  updateMetrics() {\n    this.metrics.totalConnections = this.connections.total;\n    this.metrics.activeConnections = this.connections.busy.size;\n    this.metrics.queuedRequests = this.requestQueue.length;\n    \n    // Calculate query time percentiles\n    if (this.queryTimes.length > 0) {\n      const sorted = this.queryTimes.sort((a, b) => a - b);\n      const len = sorted.length;\n      \n      this.metrics.p95QueryTime = sorted[Math.floor(len * 0.95)];\n      this.metrics.p99QueryTime = sorted[Math.floor(len * 0.99)];\n      \n      // Keep only recent query times\n      this.queryTimes = sorted.slice(-1000);\n    }\n  }\n  \n  /**\n   * Get current metrics\n   */\n  getMetrics() {\n    return {\n      ...this.metrics,\n      poolUtilization: this.connections.total > 0 ? \n        this.connections.busy.size / this.connections.total : 0,\n      queuedRequests: this.requestQueue.length,\n      availableConnections: this.connections.available.length,\n      avgConnectionAge: this.getAverageConnectionAge()\n    };\n  }\n  \n  /**\n   * Get average connection age\n   */\n  getAverageConnectionAge() {\n    const now = Date.now();\n    let totalAge = 0;\n    let count = 0;\n    \n    for (const connection of this.connections.available) {\n      totalAge += now - connection.createdAt;\n      count++;\n    }\n    \n    for (const busyInfo of this.connections.busy.values()) {\n      totalAge += now - busyInfo.connection.createdAt;\n      count++;\n    }\n    \n    return count > 0 ? totalAge / count : 0;\n  }\n  \n  /**\n   * Get pool status\n   */\n  getStatus() {\n    return {\n      initialized: this.initialized,\n      total: this.connections.total,\n      available: this.connections.available.length,\n      busy: this.connections.busy.size,\n      creating: this.connections.creating,\n      queued: this.requestQueue.length,\n      metrics: this.getMetrics()\n    };\n  }\n  \n  /**\n   * Shutdown the connection pool\n   */\n  async shutdown() {\n    console.log('Shutting down database connection pool...');\n    \n    // Reject all queued requests\n    for (const request of this.requestQueue) {\n      clearTimeout(request.timeout);\n      request.reject(new Error('Connection pool shutting down'));\n    }\n    this.requestQueue = [];\n    \n    // Close all connections\n    const allConnections = [\n      ...this.connections.available,\n      ...Array.from(this.connections.busy.values()).map(info => info.connection)\n    ];\n    \n    await Promise.all(allConnections.map(connection => {\n      return new Promise((resolve) => {\n        try {\n          if (connection.end) {\n            connection.end(() => resolve());\n          } else if (connection.close) {\n            connection.close();\n            resolve();\n          } else {\n            resolve();\n          }\n        } catch (error) {\n          console.error('Error closing connection:', error);\n          resolve();\n        }\n      });\n    }));\n    \n    // Clear pools\n    this.connections.available = [];\n    this.connections.busy.clear();\n    this.connections.total = 0;\n    \n    this.initialized = false;\n    this.emit('shutdown');\n  }\n}\n\nmodule.exports = DatabaseConnectionPool;"