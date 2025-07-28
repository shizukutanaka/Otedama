const { EventEmitter } = require('events');
const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;

class ConnectionPoolManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            maxConnections: options.maxConnections || 100,
            minConnections: options.minConnections || 10,
            connectionTimeout: options.connectionTimeout || 30000,
            idleTimeout: options.idleTimeout || 60000,
            keepAlive: options.keepAlive !== false,
            keepAliveInitialDelay: options.keepAliveInitialDelay || 30000,
            retryAttempts: options.retryAttempts || 3,
            retryDelay: options.retryDelay || 1000,
            ...options
        };
        
        this.pools = new Map();
        this.pendingRequests = new Map();
        this.connectionStats = new Map();
        this.dnsCache = new Map();
        
        this.isRunning = false;
    }

    async initialize() {
        this.startHealthCheck();
        this.startIdleConnectionCleanup();
        this.isRunning = true;
        
        this.emit('initialized');
    }

    async createPool(name, config) {
        const pool = {
            name,
            config: { ...this.config, ...config },
            connections: [],
            availableConnections: [],
            activeConnections: new Set(),
            stats: {
                created: 0,
                destroyed: 0,
                errors: 0,
                requests: 0,
                avgResponseTime: 0
            }
        };
        
        this.pools.set(name, pool);
        
        // Create initial connections
        const promises = [];
        for (let i = 0; i < pool.config.minConnections; i++) {
            promises.push(this.createConnection(pool));
        }
        
        await Promise.allSettled(promises);
        
        this.emit('pool:created', { name, config: pool.config });
        
        return pool;
    }

    async createConnection(pool) {
        const { host, port, ssl } = pool.config;
        
        try {
            // DNS lookup with caching
            const address = await this.resolveHost(host);
            
            const options = {
                host: address,
                port,
                keepAlive: this.config.keepAlive,
                keepAliveInitialDelay: this.config.keepAliveInitialDelay,
                timeout: this.config.connectionTimeout
            };
            
            const connection = ssl ? 
                await this.createTLSConnection(options, pool.config.tlsOptions) : 
                await this.createTCPConnection(options);
            
            const connectionWrapper = {
                id: `${pool.name}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                connection,
                pool: pool.name,
                createdAt: Date.now(),
                lastUsed: Date.now(),
                requestCount: 0,
                errors: 0,
                state: 'idle'
            };
            
            this.setupConnectionHandlers(connectionWrapper, pool);
            
            pool.connections.push(connectionWrapper);
            pool.availableConnections.push(connectionWrapper);
            pool.stats.created++;
            
            this.emit('connection:created', { pool: pool.name, id: connectionWrapper.id });
            
            return connectionWrapper;
            
        } catch (error) {
            pool.stats.errors++;
            this.emit('connection:error', { pool: pool.name, error });
            throw error;
        }
    }

    async resolveHost(host) {
        // Check cache first
        const cached = this.dnsCache.get(host);
        if (cached && cached.expires > Date.now()) {
            return cached.address;
        }
        
        try {
            const addresses = await dns.resolve4(host);
            const address = addresses[0];
            
            // Cache for 5 minutes
            this.dnsCache.set(host, {
                address,
                expires: Date.now() + 300000
            });
            
            return address;
        } catch (error) {
            // Fallback to host if DNS fails
            return host;
        }
    }

    createTCPConnection(options) {
        return new Promise((resolve, reject) => {
            const connection = net.createConnection(options);
            
            connection.once('connect', () => resolve(connection));
            connection.once('error', reject);
            connection.once('timeout', () => reject(new Error('Connection timeout')));
        });
    }

    createTLSConnection(options, tlsOptions = {}) {
        return new Promise((resolve, reject) => {
            const connection = tls.connect({
                ...options,
                ...tlsOptions,
                rejectUnauthorized: tlsOptions.rejectUnauthorized !== false
            });
            
            connection.once('secureConnect', () => resolve(connection));
            connection.once('error', reject);
            connection.once('timeout', () => reject(new Error('Connection timeout')));
        });
    }

    setupConnectionHandlers(wrapper, pool) {
        const { connection } = wrapper;
        
        connection.on('error', (error) => {
            wrapper.errors++;
            wrapper.state = 'error';
            this.handleConnectionError(wrapper, pool, error);
        });
        
        connection.on('close', () => {
            wrapper.state = 'closed';
            this.removeConnection(wrapper, pool);
        });
        
        connection.on('timeout', () => {
            wrapper.state = 'timeout';
            this.handleConnectionTimeout(wrapper, pool);
        });
        
        // Custom protocol handling
        if (pool.config.protocol) {
            this.setupProtocolHandlers(wrapper, pool);
        }
    }

    setupProtocolHandlers(wrapper, pool) {
        const { connection } = wrapper;
        const { protocol } = pool.config;
        
        if (protocol === 'http') {
            // HTTP keep-alive handling
            let parser = null;
            connection.on('data', (data) => {
                if (!parser) return;
                parser.execute(data);
            });
        } else if (protocol === 'stratum') {
            // Stratum protocol handling
            let buffer = '';
            connection.on('data', (data) => {
                buffer += data.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                
                lines.forEach(line => {
                    if (line.trim()) {
                        this.emit('stratum:message', { 
                            pool: pool.name, 
                            connection: wrapper.id, 
                            message: line 
                        });
                    }
                });
            });
        }
    }

    async getConnection(poolName) {
        const pool = this.pools.get(poolName);
        if (!pool) {
            throw new Error(`Pool ${poolName} not found`);
        }
        
        pool.stats.requests++;
        
        // Try to get available connection
        let connection = this.getAvailableConnection(pool);
        
        if (!connection) {
            // Create new connection if under limit
            if (pool.connections.length < pool.config.maxConnections) {
                try {
                    connection = await this.createConnection(pool);
                } catch (error) {
                    // Try again with existing connections
                    connection = await this.waitForConnection(pool);
                }
            } else {
                // Wait for connection to become available
                connection = await this.waitForConnection(pool);
            }
        }
        
        if (!connection) {
            throw new Error('No connections available');
        }
        
        // Mark as active
        connection.state = 'active';
        connection.lastUsed = Date.now();
        connection.requestCount++;
        pool.activeConnections.add(connection);
        
        // Remove from available
        const index = pool.availableConnections.indexOf(connection);
        if (index > -1) {
            pool.availableConnections.splice(index, 1);
        }
        
        return connection;
    }

    getAvailableConnection(pool) {
        // Get the least recently used connection
        const available = pool.availableConnections
            .filter(conn => conn.state === 'idle' && conn.connection.writable)
            .sort((a, b) => a.lastUsed - b.lastUsed);
        
        return available[0] || null;
    }

    async waitForConnection(pool, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('Timeout waiting for connection'));
            }, timeout);
            
            const checkInterval = setInterval(() => {
                const connection = this.getAvailableConnection(pool);
                if (connection) {
                    clearInterval(checkInterval);
                    clearTimeout(timeoutId);
                    resolve(connection);
                }
            }, 100);
            
            // Store pending request
            const pending = { resolve, reject, checkInterval, timeoutId };
            if (!this.pendingRequests.has(pool.name)) {
                this.pendingRequests.set(pool.name, []);
            }
            this.pendingRequests.get(pool.name).push(pending);
        });
    }

    releaseConnection(connection) {
        const pool = this.pools.get(connection.pool);
        if (!pool) return;
        
        // Remove from active
        pool.activeConnections.delete(connection);
        
        // Check if connection is still healthy
        if (connection.state === 'active' && 
            connection.connection.writable && 
            !connection.connection.destroyed) {
            
            connection.state = 'idle';
            connection.lastUsed = Date.now();
            pool.availableConnections.push(connection);
            
            // Process pending requests
            this.processPendingRequests(pool);
        } else {
            // Remove unhealthy connection
            this.removeConnection(connection, pool);
        }
    }

    processPendingRequests(pool) {
        const pending = this.pendingRequests.get(pool.name);
        if (!pending || pending.length === 0) return;
        
        const connection = this.getAvailableConnection(pool);
        if (connection) {
            const request = pending.shift();
            clearInterval(request.checkInterval);
            clearTimeout(request.timeoutId);
            request.resolve(connection);
        }
    }

    removeConnection(wrapper, pool) {
        // Remove from all arrays
        const index = pool.connections.indexOf(wrapper);
        if (index > -1) {
            pool.connections.splice(index, 1);
        }
        
        const availIndex = pool.availableConnections.indexOf(wrapper);
        if (availIndex > -1) {
            pool.availableConnections.splice(availIndex, 1);
        }
        
        pool.activeConnections.delete(wrapper);
        
        // Close connection
        if (wrapper.connection && !wrapper.connection.destroyed) {
            wrapper.connection.destroy();
        }
        
        pool.stats.destroyed++;
        
        this.emit('connection:removed', { pool: pool.name, id: wrapper.id });
        
        // Create replacement if needed
        if (pool.connections.length < pool.config.minConnections) {
            this.createConnection(pool).catch(error => {
                this.emit('connection:replace-error', { pool: pool.name, error });
            });
        }
    }

    handleConnectionError(wrapper, pool, error) {
        this.emit('connection:error', { 
            pool: pool.name, 
            connection: wrapper.id, 
            error 
        });
        
        // Remove failed connection
        this.removeConnection(wrapper, pool);
    }

    handleConnectionTimeout(wrapper, pool) {
        this.emit('connection:timeout', { 
            pool: pool.name, 
            connection: wrapper.id 
        });
        
        // Remove timed out connection
        this.removeConnection(wrapper, pool);
    }

    async execute(poolName, callback) {
        let connection = null;
        let retries = 0;
        
        while (retries < this.config.retryAttempts) {
            try {
                connection = await this.getConnection(poolName);
                const startTime = Date.now();
                
                const result = await callback(connection.connection);
                
                const responseTime = Date.now() - startTime;
                this.updateStats(poolName, responseTime);
                
                return result;
                
            } catch (error) {
                retries++;
                
                if (connection) {
                    connection.errors++;
                }
                
                if (retries >= this.config.retryAttempts) {
                    throw error;
                }
                
                await new Promise(resolve => 
                    setTimeout(resolve, this.config.retryDelay * retries)
                );
                
            } finally {
                if (connection) {
                    this.releaseConnection(connection);
                }
            }
        }
    }

    updateStats(poolName, responseTime) {
        const pool = this.pools.get(poolName);
        if (!pool) return;
        
        const stats = pool.stats;
        stats.avgResponseTime = 
            (stats.avgResponseTime * (stats.requests - 1) + responseTime) / stats.requests;
        
        if (!this.connectionStats.has(poolName)) {
            this.connectionStats.set(poolName, {
                responseTime: [],
                errorRate: [],
                throughput: []
            });
        }
        
        const poolStats = this.connectionStats.get(poolName);
        poolStats.responseTime.push({ timestamp: Date.now(), value: responseTime });
        
        // Keep only last hour
        const cutoff = Date.now() - 3600000;
        poolStats.responseTime = poolStats.responseTime.filter(s => s.timestamp > cutoff);
    }

    startHealthCheck() {
        this.healthInterval = setInterval(() => {
            for (const [name, pool] of this.pools) {
                this.checkPoolHealth(pool);
            }
        }, 30000); // Every 30 seconds
    }

    async checkPoolHealth(pool) {
        const unhealthy = [];
        
        for (const connection of pool.connections) {
            if (!connection.connection.writable || connection.connection.destroyed) {
                unhealthy.push(connection);
            } else if (pool.config.healthCheck) {
                // Custom health check
                try {
                    const healthy = await pool.config.healthCheck(connection.connection);
                    if (!healthy) {
                        unhealthy.push(connection);
                    }
                } catch (error) {
                    unhealthy.push(connection);
                }
            }
        }
        
        // Remove unhealthy connections
        for (const connection of unhealthy) {
            this.removeConnection(connection, pool);
        }
        
        // Ensure minimum connections
        while (pool.connections.length < pool.config.minConnections) {
            try {
                await this.createConnection(pool);
            } catch (error) {
                this.emit('pool:health-error', { pool: pool.name, error });
                break;
            }
        }
    }

    startIdleConnectionCleanup() {
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            
            for (const [name, pool] of this.pools) {
                const toRemove = [];
                
                for (const connection of pool.availableConnections) {
                    if (connection.state === 'idle' && 
                        now - connection.lastUsed > this.config.idleTimeout &&
                        pool.connections.length > pool.config.minConnections) {
                        toRemove.push(connection);
                    }
                }
                
                for (const connection of toRemove) {
                    this.removeConnection(connection, pool);
                }
            }
        }, 60000); // Every minute
    }

    getPoolStats(poolName) {
        const pool = this.pools.get(poolName);
        if (!pool) return null;
        
        return {
            name: poolName,
            connections: {
                total: pool.connections.length,
                active: pool.activeConnections.size,
                available: pool.availableConnections.length,
                min: pool.config.minConnections,
                max: pool.config.maxConnections
            },
            stats: pool.stats,
            health: {
                healthy: pool.connections.filter(c => c.state === 'idle' || c.state === 'active').length,
                errors: pool.connections.filter(c => c.errors > 0).length
            }
        };
    }

    async destroy() {
        this.isRunning = false;
        
        if (this.healthInterval) clearInterval(this.healthInterval);
        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        
        // Close all connections
        for (const [name, pool] of this.pools) {
            for (const connection of pool.connections) {
                if (connection.connection && !connection.connection.destroyed) {
                    connection.connection.destroy();
                }
            }
        }
        
        this.pools.clear();
        this.pendingRequests.clear();
        
        this.emit('destroyed');
    }
}

module.exports = ConnectionPoolManager;