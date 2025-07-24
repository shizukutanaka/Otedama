/**
 * Advanced Connection Pool Manager
 * 高度な接続プール管理システム
 */

const { EventEmitter } = require('events');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');

class ConnectionPoolManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Pool configuration
            minSize: config.minSize || 5,
            maxSize: config.maxSize || 100,
            acquireTimeout: config.acquireTimeout || 5000,
            createTimeout: config.createTimeout || 5000,
            destroyTimeout: config.destroyTimeout || 5000,
            idleTimeout: config.idleTimeout || 30000,
            reapInterval: config.reapInterval || 10000,
            
            // Connection configuration
            keepAlive: config.keepAlive !== false,
            keepAliveInitialDelay: config.keepAliveInitialDelay || 1000,
            noDelay: config.noDelay !== false,
            
            // Retry configuration
            maxRetries: config.maxRetries || 3,
            retryDelay: config.retryDelay || 1000,
            
            // Health check
            enableHealthCheck: config.enableHealthCheck !== false,
            healthCheckInterval: config.healthCheckInterval || 30000,
            
            // Statistics
            enableStatistics: config.enableStatistics !== false,
            statisticsInterval: config.statisticsInterval || 60000,
            
            ...config
        };
        
        // Connection pools by host
        this.pools = new Map();
        
        // Global statistics
        this.globalStats = {
            totalConnections: 0,
            activeConnections: 0,
            idleConnections: 0,
            totalRequests: 0,
            failedRequests: 0,
            avgResponseTime: 0,
            connectionReuse: 0
        };
        
        // Initialize
        this.initialize();
    }
    
    initialize() {
        console.log('接続プールマネージャーを初期化中...');
        
        // Start connection reaper
        this.startConnectionReaper();
        
        // Start health checks
        if (this.config.enableHealthCheck) {
            this.startHealthChecks();
        }
        
        // Start statistics collection
        if (this.config.enableStatistics) {
            this.startStatisticsCollection();
        }
        
        console.log('✓ 接続プールマネージャーの初期化完了');
    }
    
    /**
     * Get or create a connection pool for a specific host
     */
    getPool(host, port, options = {}) {
        const poolKey = `${host}:${port}`;
        
        if (!this.pools.has(poolKey)) {
            const pool = new ConnectionPool({
                host,
                port,
                ...this.config,
                ...options
            });
            
            // Set up event listeners
            pool.on('connection-created', () => {
                this.globalStats.totalConnections++;
            });
            
            pool.on('connection-acquired', () => {
                this.globalStats.activeConnections++;
                this.globalStats.totalRequests++;
            });
            
            pool.on('connection-released', () => {
                this.globalStats.activeConnections--;
                this.globalStats.connectionReuse++;
            });
            
            pool.on('connection-destroyed', () => {
                this.globalStats.totalConnections--;
            });
            
            pool.on('error', (error) => {
                this.globalStats.failedRequests++;
                this.emit('pool-error', { poolKey, error });
            });
            
            this.pools.set(poolKey, pool);
        }
        
        return this.pools.get(poolKey);
    }
    
    /**
     * Acquire a connection from the pool
     */
    async acquire(host, port, options = {}) {
        const pool = this.getPool(host, port, options);
        return await pool.acquire();
    }
    
    /**
     * Release a connection back to the pool
     */
    release(connection) {
        if (connection._pool) {
            connection._pool.release(connection);
        }
    }
    
    /**
     * Destroy a connection
     */
    destroy(connection) {
        if (connection._pool) {
            connection._pool.destroy(connection);
        }
    }
    
    /**
     * Start connection reaper
     */
    startConnectionReaper() {
        setInterval(() => {
            for (const [poolKey, pool] of this.pools) {
                pool.reapIdleConnections();
                
                // Remove empty pools
                if (pool.size === 0 && pool.pending === 0) {
                    pool.shutdown();
                    this.pools.delete(poolKey);
                }
            }
        }, this.config.reapInterval);
    }
    
    /**
     * Start health checks
     */
    startHealthChecks() {
        setInterval(async () => {
            const healthChecks = [];
            
            for (const [poolKey, pool] of this.pools) {
                healthChecks.push(pool.healthCheck());
            }
            
            const results = await Promise.allSettled(healthChecks);
            
            const unhealthyPools = results.filter(r => r.status === 'rejected').length;
            if (unhealthyPools > 0) {
                this.emit('health-check-failed', { 
                    unhealthyPools, 
                    totalPools: this.pools.size 
                });
            }
        }, this.config.healthCheckInterval);
    }
    
    /**
     * Start statistics collection
     */
    startStatisticsCollection() {
        setInterval(() => {
            const poolStats = [];
            
            for (const [poolKey, pool] of this.pools) {
                poolStats.push({
                    pool: poolKey,
                    ...pool.getStatistics()
                });
            }
            
            this.emit('statistics', {
                global: this.globalStats,
                pools: poolStats,
                timestamp: Date.now()
            });
        }, this.config.statisticsInterval);
    }
    
    /**
     * Get global statistics
     */
    getStatistics() {
        const poolStats = [];
        
        for (const [poolKey, pool] of this.pools) {
            poolStats.push({
                pool: poolKey,
                ...pool.getStatistics()
            });
        }
        
        return {
            global: this.globalStats,
            pools: poolStats,
            poolCount: this.pools.size
        };
    }
    
    /**
     * Shutdown all pools
     */
    async shutdown() {
        console.log('接続プールマネージャーをシャットダウン中...');
        
        const shutdownPromises = [];
        
        for (const [poolKey, pool] of this.pools) {
            shutdownPromises.push(pool.shutdown());
        }
        
        await Promise.all(shutdownPromises);
        
        this.pools.clear();
        
        console.log('✓ 接続プールマネージャーのシャットダウン完了');
    }
}

/**
 * Individual connection pool implementation
 */
class ConnectionPool extends EventEmitter {
    constructor(config) {
        super();
        
        this.config = config;
        this.host = config.host;
        this.port = config.port;
        this.secure = config.secure || false;
        
        // Connection tracking
        this.available = [];
        this.inUse = new Set();
        this.pending = 0;
        
        // Statistics
        this.stats = {
            created: 0,
            destroyed: 0,
            acquired: 0,
            released: 0,
            timeouts: 0,
            errors: 0,
            avgAcquireTime: 0
        };
        
        // Initialize minimum connections
        this.initializePool();
    }
    
    async initializePool() {
        const promises = [];
        
        for (let i = 0; i < this.config.minSize; i++) {
            promises.push(this.createConnection());
        }
        
        try {
            const connections = await Promise.all(promises);
            connections.forEach(conn => {
                if (conn) this.available.push(conn);
            });
        } catch (error) {
            console.error(`プール初期化エラー (${this.host}:${this.port}):`, error);
        }
    }
    
    /**
     * Acquire a connection from the pool
     */
    async acquire() {
        const startTime = Date.now();
        
        // Try to get an available connection
        while (this.available.length > 0) {
            const connection = this.available.shift();
            
            if (this.isConnectionAlive(connection)) {
                this.inUse.add(connection);
                this.stats.acquired++;
                
                const acquireTime = Date.now() - startTime;
                this.updateAvgAcquireTime(acquireTime);
                
                this.emit('connection-acquired', connection);
                return connection;
            } else {
                // Connection is dead, destroy it
                this.destroyConnection(connection);
            }
        }
        
        // No available connections, create new one if under limit
        if (this.size < this.config.maxSize) {
            this.pending++;
            
            try {
                const connection = await this.createConnection();
                this.pending--;
                
                if (connection) {
                    this.inUse.add(connection);
                    this.stats.acquired++;
                    
                    const acquireTime = Date.now() - startTime;
                    this.updateAvgAcquireTime(acquireTime);
                    
                    this.emit('connection-acquired', connection);
                    return connection;
                }
            } catch (error) {
                this.pending--;
                this.stats.errors++;
                throw error;
            }
        }
        
        // Pool is at capacity, wait for a connection
        return await this.waitForConnection(startTime);
    }
    
    /**
     * Wait for an available connection
     */
    async waitForConnection(startTime) {
        const timeout = this.config.acquireTimeout;
        const checkInterval = 50;
        
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                clearInterval(intervalId);
                this.stats.timeouts++;
                reject(new Error('Connection acquire timeout'));
            }, timeout);
            
            const intervalId = setInterval(() => {
                if (this.available.length > 0) {
                    clearTimeout(timeoutId);
                    clearInterval(intervalId);
                    
                    const connection = this.available.shift();
                    this.inUse.add(connection);
                    this.stats.acquired++;
                    
                    const acquireTime = Date.now() - startTime;
                    this.updateAvgAcquireTime(acquireTime);
                    
                    this.emit('connection-acquired', connection);
                    resolve(connection);
                }
            }, checkInterval);
        });
    }
    
    /**
     * Release a connection back to the pool
     */
    release(connection) {
        if (!this.inUse.has(connection)) {
            return;
        }
        
        this.inUse.delete(connection);
        
        if (this.isConnectionAlive(connection)) {
            // Reset connection state
            this.resetConnection(connection);
            
            // Mark last used time
            connection._lastUsed = Date.now();
            
            this.available.push(connection);
            this.stats.released++;
            
            this.emit('connection-released', connection);
        } else {
            // Connection is dead, destroy it
            this.destroyConnection(connection);
        }
    }
    
    /**
     * Destroy a connection
     */
    destroy(connection) {
        this.inUse.delete(connection);
        this.destroyConnection(connection);
    }
    
    /**
     * Create a new connection
     */
    async createConnection() {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Connection creation timeout'));
            }, this.config.createTimeout);
            
            const options = {
                host: this.host,
                port: this.port,
                ...this.getConnectionOptions()
            };
            
            const connection = this.secure ? 
                tls.connect(options) : 
                net.connect(options);
            
            connection._pool = this;
            connection._createdAt = Date.now();
            connection._lastUsed = Date.now();
            
            connection.once('connect', () => {
                clearTimeout(timeoutId);
                
                // Configure connection
                this.configureConnection(connection);
                
                this.stats.created++;
                this.emit('connection-created', connection);
                
                resolve(connection);
            });
            
            connection.once('error', (error) => {
                clearTimeout(timeoutId);
                this.stats.errors++;
                reject(error);
            });
        });
    }
    
    /**
     * Get connection options
     */
    getConnectionOptions() {
        const options = {};
        
        if (this.config.keepAlive) {
            options.keepAlive = true;
            options.keepAliveInitialDelay = this.config.keepAliveInitialDelay;
        }
        
        if (this.config.noDelay) {
            options.noDelay = true;
        }
        
        if (this.secure && this.config.tlsOptions) {
            Object.assign(options, this.config.tlsOptions);
        }
        
        return options;
    }
    
    /**
     * Configure a connection
     */
    configureConnection(connection) {
        // Set socket options
        if (connection.setKeepAlive) {
            connection.setKeepAlive(
                this.config.keepAlive, 
                this.config.keepAliveInitialDelay
            );
        }
        
        if (connection.setNoDelay) {
            connection.setNoDelay(this.config.noDelay);
        }
        
        // Add error handling
        connection.on('error', (error) => {
            console.error(`接続エラー (${this.host}:${this.port}):`, error);
            this.destroy(connection);
        });
        
        connection.on('close', () => {
            this.destroy(connection);
        });
        
        connection.on('timeout', () => {
            console.warn(`接続タイムアウト (${this.host}:${this.port})`);
            this.destroy(connection);
        });
    }
    
    /**
     * Reset connection state
     */
    resetConnection(connection) {
        // Clear any pending data
        if (connection.readable && !connection.readableEnded) {
            connection.read();
        }
        
        // Remove all listeners except core ones
        const events = connection.eventNames();
        events.forEach(event => {
            if (!['error', 'close', 'timeout'].includes(event)) {
                connection.removeAllListeners(event);
            }
        });
    }
    
    /**
     * Check if connection is alive
     */
    isConnectionAlive(connection) {
        return connection && 
               !connection.destroyed && 
               connection.readable && 
               connection.writable;
    }
    
    /**
     * Destroy a connection
     */
    destroyConnection(connection) {
        if (!connection.destroyed) {
            connection.destroy();
        }
        
        this.stats.destroyed++;
        this.emit('connection-destroyed', connection);
    }
    
    /**
     * Reap idle connections
     */
    reapIdleConnections() {
        const now = Date.now();
        const idleTimeout = this.config.idleTimeout;
        
        // Check available connections
        this.available = this.available.filter(connection => {
            if (now - connection._lastUsed > idleTimeout) {
                this.destroyConnection(connection);
                return false;
            }
            return true;
        });
        
        // Ensure minimum pool size
        const currentSize = this.size;
        if (currentSize < this.config.minSize) {
            const needed = this.config.minSize - currentSize;
            for (let i = 0; i < needed; i++) {
                this.createConnection()
                    .then(conn => {
                        if (conn) this.available.push(conn);
                    })
                    .catch(error => {
                        console.error('アイドル接続の補充エラー:', error);
                    });
            }
        }
    }
    
    /**
     * Perform health check
     */
    async healthCheck() {
        const testConnection = await this.acquire();
        
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.destroy(testConnection);
                reject(new Error('Health check timeout'));
            }, 5000);
            
            // Simple ping test
            testConnection.write('PING\r\n', (error) => {
                clearTimeout(timeoutId);
                
                if (error) {
                    this.destroy(testConnection);
                    reject(error);
                } else {
                    this.release(testConnection);
                    resolve(true);
                }
            });
        });
    }
    
    /**
     * Update average acquire time
     */
    updateAvgAcquireTime(acquireTime) {
        const total = this.stats.acquired;
        this.stats.avgAcquireTime = 
            (this.stats.avgAcquireTime * (total - 1) + acquireTime) / total;
    }
    
    /**
     * Get pool statistics
     */
    getStatistics() {
        return {
            size: this.size,
            available: this.available.length,
            inUse: this.inUse.size,
            pending: this.pending,
            ...this.stats
        };
    }
    
    /**
     * Get current pool size
     */
    get size() {
        return this.available.length + this.inUse.size;
    }
    
    /**
     * Shutdown the pool
     */
    async shutdown() {
        // Destroy all available connections
        while (this.available.length > 0) {
            const connection = this.available.shift();
            this.destroyConnection(connection);
        }
        
        // Wait for in-use connections with timeout
        const shutdownTimeout = this.config.destroyTimeout;
        const startTime = Date.now();
        
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                if (this.inUse.size === 0 || Date.now() - startTime > shutdownTimeout) {
                    clearInterval(checkInterval);
                    
                    // Force destroy remaining connections
                    for (const connection of this.inUse) {
                        this.destroyConnection(connection);
                    }
                    
                    this.inUse.clear();
                    resolve();
                }
            }, 100);
        });
    }
}

module.exports = ConnectionPoolManager;