const { EventEmitter } = require('events');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');

class IntelligentFailoverManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            maxRetries: options.maxRetries || 3,
            retryDelay: options.retryDelay || 5000,
            healthCheckInterval: options.healthCheckInterval || 30000,
            scoreThreshold: options.scoreThreshold || 0.7,
            switchThreshold: options.switchThreshold || 0.85,
            enablePreemptive: options.enablePreemptive !== false,
            enableLoadBalancing: options.enableLoadBalancing !== false,
            ...options
        };
        
        this.pools = new Map();
        this.activePool = null;
        this.isFailingOver = false;
        
        // Pool health tracking
        this.poolHealth = new Map();
        this.connectionHistory = new Map();
        
        // Metrics
        this.metrics = {
            failovers: 0,
            successfulFailovers: 0,
            preemptiveFailovers: 0,
            totalDowntime: 0,
            lastFailover: null
        };
    }

    addPool(pool) {
        const poolId = this.generatePoolId(pool);
        
        this.pools.set(poolId, {
            id: poolId,
            ...pool,
            priority: pool.priority || 0,
            weight: pool.weight || 1,
            active: false,
            connection: null
        });
        
        this.poolHealth.set(poolId, {
            score: 1.0,
            latency: [],
            uptime: 0,
            failures: 0,
            lastCheck: Date.now(),
            shareAcceptRate: 1.0,
            hashrate: 0
        });
        
        this.connectionHistory.set(poolId, []);
        
        return poolId;
    }

    async start() {
        // Sort pools by priority
        const sortedPools = Array.from(this.pools.values())
            .sort((a, b) => b.priority - a.priority);
        
        // Try to connect to highest priority pool
        for (const pool of sortedPools) {
            if (await this.connectToPool(pool)) {
                this.activePool = pool;
                break;
            }
        }
        
        if (!this.activePool) {
            throw new Error('Failed to connect to any pool');
        }
        
        // Start health monitoring
        this.startHealthMonitoring();
        
        // Start preemptive monitoring if enabled
        if (this.config.enablePreemptive) {
            this.startPreemptiveMonitoring();
        }
        
        this.emit('started', { activePool: this.activePool.id });
    }

    async connectToPool(pool) {
        const startTime = Date.now();
        
        try {
            const connection = await this.createConnection(pool);
            
            // Test connection with authentication
            const authenticated = await this.authenticatePool(connection, pool);
            if (!authenticated) {
                connection.destroy();
                throw new Error('Authentication failed');
            }
            
            // Update pool connection
            pool.connection = connection;
            pool.active = true;
            
            // Setup connection handlers
            this.setupConnectionHandlers(pool, connection);
            
            // Record successful connection
            const latency = Date.now() - startTime;
            this.recordConnectionSuccess(pool.id, latency);
            
            this.emit('pool:connected', { poolId: pool.id, latency });
            return true;
            
        } catch (error) {
            this.recordConnectionFailure(pool.id, error);
            this.emit('pool:connection-failed', { poolId: pool.id, error: error.message });
            return false;
        }
    }

    createConnection(pool) {
        return new Promise((resolve, reject) => {
            const url = new URL(pool.url);
            const port = url.port || (url.protocol === 'stratum+ssl:' ? 3333 : 3333);
            const useTLS = url.protocol === 'stratum+ssl:';
            
            const options = {
                host: url.hostname,
                port: parseInt(port),
                timeout: 10000
            };
            
            const connection = useTLS ? 
                tls.connect(options) : 
                net.createConnection(options);
            
            connection.setTimeout(10000);
            
            connection.on('connect', () => {
                connection.setTimeout(0);
                resolve(connection);
            });
            
            connection.on('timeout', () => {
                connection.destroy();
                reject(new Error('Connection timeout'));
            });
            
            connection.on('error', reject);
        });
    }

    async authenticatePool(connection, pool) {
        return new Promise((resolve) => {
            const authMessage = JSON.stringify({
                id: 1,
                method: 'mining.subscribe',
                params: ['Otedama/1.0']
            }) + '\n';
            
            connection.write(authMessage);
            
            const authTimeout = setTimeout(() => {
                resolve(false);
            }, 5000);
            
            connection.once('data', (data) => {
                clearTimeout(authTimeout);
                try {
                    const response = JSON.parse(data.toString());
                    resolve(response.result !== null);
                } catch {
                    resolve(false);
                }
            });
        });
    }

    setupConnectionHandlers(pool, connection) {
        let dataBuffer = '';
        
        connection.on('data', (data) => {
            dataBuffer += data.toString();
            const lines = dataBuffer.split('\n');
            dataBuffer = lines.pop() || '';
            
            for (const line of lines) {
                if (line.trim()) {
                    this.handlePoolMessage(pool, line);
                }
            }
        });
        
        connection.on('close', () => {
            pool.active = false;
            pool.connection = null;
            this.handlePoolDisconnection(pool);
        });
        
        connection.on('error', (error) => {
            this.emit('pool:error', { poolId: pool.id, error: error.message });
            this.updatePoolHealth(pool.id, -0.1);
        });
    }

    handlePoolMessage(pool, message) {
        try {
            const data = JSON.parse(message);
            
            // Update pool health based on responses
            if (data.method === 'mining.notify') {
                this.updatePoolHealth(pool.id, 0.01);
            } else if (data.id && data.result !== undefined) {
                // Share submission response
                if (data.result === true) {
                    this.recordShareAccepted(pool.id);
                } else {
                    this.recordShareRejected(pool.id);
                }
            }
            
            // Forward message to miners
            this.emit('pool:message', { poolId: pool.id, message: data });
            
        } catch (error) {
            // Invalid message
        }
    }

    async handlePoolDisconnection(pool) {
        if (pool.id === this.activePool?.id && !this.isFailingOver) {
            this.emit('pool:disconnected', { poolId: pool.id });
            await this.performFailover('disconnection');
        }
    }

    async performFailover(reason) {
        if (this.isFailingOver) return;
        
        this.isFailingOver = true;
        const failoverStart = Date.now();
        this.metrics.failovers++;
        
        this.emit('failover:started', { reason, currentPool: this.activePool?.id });
        
        try {
            // Find next best pool
            const nextPool = await this.selectNextPool();
            
            if (!nextPool) {
                throw new Error('No available pools for failover');
            }
            
            // Attempt connection
            const connected = await this.connectToPool(nextPool);
            
            if (!connected) {
                // Try other pools
                for (const pool of this.getPoolsByScore()) {
                    if (pool.id !== nextPool.id && await this.connectToPool(pool)) {
                        nextPool = pool;
                        break;
                    }
                }
            }
            
            if (!nextPool.active) {
                throw new Error('Failed to connect to any pool');
            }
            
            // Switch active pool
            const previousPool = this.activePool;
            this.activePool = nextPool;
            
            // Clean up previous connection
            if (previousPool?.connection) {
                previousPool.connection.destroy();
            }
            
            const downtime = Date.now() - failoverStart;
            this.metrics.totalDowntime += downtime;
            this.metrics.successfulFailovers++;
            this.metrics.lastFailover = Date.now();
            
            this.emit('failover:completed', {
                previousPool: previousPool?.id,
                newPool: nextPool.id,
                downtime,
                reason
            });
            
        } catch (error) {
            this.emit('failover:failed', { error: error.message });
        } finally {
            this.isFailingOver = false;
        }
    }

    async selectNextPool() {
        const availablePools = this.getPoolsByScore()
            .filter(pool => pool.id !== this.activePool?.id);
        
        if (availablePools.length === 0) return null;
        
        // Consider load balancing
        if (this.config.enableLoadBalancing) {
            return this.selectPoolByWeight(availablePools);
        }
        
        // Return highest scoring pool
        return availablePools[0];
    }

    getPoolsByScore() {
        return Array.from(this.pools.values())
            .map(pool => ({
                ...pool,
                score: this.calculatePoolScore(pool.id)
            }))
            .sort((a, b) => b.score - a.score);
    }

    calculatePoolScore(poolId) {
        const health = this.poolHealth.get(poolId);
        if (!health) return 0;
        
        let score = health.score;
        
        // Factor in latency (lower is better)
        const avgLatency = health.latency.length > 0 ?
            health.latency.reduce((a, b) => a + b) / health.latency.length : 0;
        const latencyScore = Math.max(0, 1 - (avgLatency / 1000));
        
        // Factor in share accept rate
        const acceptScore = health.shareAcceptRate;
        
        // Factor in uptime
        const uptimeScore = Math.min(1, health.uptime / 3600000); // 1 hour max
        
        // Factor in priority
        const pool = this.pools.get(poolId);
        const priorityBonus = (pool?.priority || 0) * 0.1;
        
        // Weighted score
        score = (score * 0.3) + 
                (latencyScore * 0.2) + 
                (acceptScore * 0.3) + 
                (uptimeScore * 0.2) + 
                priorityBonus;
        
        return Math.max(0, Math.min(1, score));
    }

    selectPoolByWeight(pools) {
        const totalWeight = pools.reduce((sum, pool) => sum + pool.weight, 0);
        let random = Math.random() * totalWeight;
        
        for (const pool of pools) {
            random -= pool.weight;
            if (random <= 0) return pool;
        }
        
        return pools[0];
    }

    startHealthMonitoring() {
        this.healthCheckInterval = setInterval(async () => {
            for (const pool of this.pools.values()) {
                await this.checkPoolHealth(pool);
            }
            
            // Check if we should preemptively switch pools
            if (this.config.enablePreemptive) {
                this.evaluatePreemptiveFailover();
            }
        }, this.config.healthCheckInterval);
    }

    async checkPoolHealth(pool) {
        if (!pool.connection || !pool.active) {
            // Try to establish connection for monitoring
            if (!this.isFailingOver && pool.id !== this.activePool?.id) {
                await this.connectToPool(pool);
            }
            return;
        }
        
        const startTime = Date.now();
        const testSent = await this.sendHealthCheck(pool);
        
        if (!testSent) {
            this.updatePoolHealth(pool.id, -0.2);
            return;
        }
        
        // Wait for response (handled in message handler)
        setTimeout(() => {
            const health = this.poolHealth.get(pool.id);
            if (health && health.lastCheck < startTime) {
                // No response received
                this.updatePoolHealth(pool.id, -0.1);
            }
        }, 5000);
    }

    async sendHealthCheck(pool) {
        try {
            const message = JSON.stringify({
                id: Date.now(),
                method: 'mining.ping',
                params: []
            }) + '\n';
            
            pool.connection.write(message);
            return true;
        } catch {
            return false;
        }
    }

    startPreemptiveMonitoring() {
        this.preemptiveInterval = setInterval(() => {
            this.evaluatePreemptiveFailover();
        }, 60000); // Every minute
    }

    evaluatePreemptiveFailover() {
        if (!this.activePool || this.isFailingOver) return;
        
        const currentScore = this.calculatePoolScore(this.activePool.id);
        const pools = this.getPoolsByScore();
        
        if (pools.length > 0 && pools[0].id !== this.activePool.id) {
            const bestScore = pools[0].score;
            
            // Switch if significantly better pool available
            if (bestScore > currentScore * this.config.switchThreshold) {
                this.metrics.preemptiveFailovers++;
                this.performFailover('preemptive-optimization');
            }
        }
    }

    updatePoolHealth(poolId, delta) {
        const health = this.poolHealth.get(poolId);
        if (!health) return;
        
        health.score = Math.max(0, Math.min(1, health.score + delta));
        health.lastCheck = Date.now();
        
        // Update uptime
        const pool = this.pools.get(poolId);
        if (pool?.active) {
            health.uptime += Date.now() - health.lastCheck;
        }
    }

    recordConnectionSuccess(poolId, latency) {
        const health = this.poolHealth.get(poolId);
        if (!health) return;
        
        health.latency.push(latency);
        if (health.latency.length > 100) {
            health.latency.shift();
        }
        
        health.failures = 0;
        this.updatePoolHealth(poolId, 0.1);
        
        const history = this.connectionHistory.get(poolId);
        history.push({
            timestamp: Date.now(),
            success: true,
            latency
        });
    }

    recordConnectionFailure(poolId, error) {
        const health = this.poolHealth.get(poolId);
        if (!health) return;
        
        health.failures++;
        this.updatePoolHealth(poolId, -0.2);
        
        const history = this.connectionHistory.get(poolId);
        history.push({
            timestamp: Date.now(),
            success: false,
            error: error.message
        });
    }

    recordShareAccepted(poolId) {
        const health = this.poolHealth.get(poolId);
        if (!health) return;
        
        health.shareAcceptRate = (health.shareAcceptRate * 0.99) + 0.01;
        this.updatePoolHealth(poolId, 0.01);
    }

    recordShareRejected(poolId) {
        const health = this.poolHealth.get(poolId);
        if (!health) return;
        
        health.shareAcceptRate = health.shareAcceptRate * 0.99;
        this.updatePoolHealth(poolId, -0.01);
    }

    sendToActivePool(message) {
        if (!this.activePool?.connection) {
            throw new Error('No active pool connection');
        }
        
        try {
            this.activePool.connection.write(JSON.stringify(message) + '\n');
            return true;
        } catch (error) {
            this.handlePoolDisconnection(this.activePool);
            return false;
        }
    }

    generatePoolId(pool) {
        const url = new URL(pool.url);
        return `${url.hostname}:${url.port || 3333}`;
    }

    getStatus() {
        const pools = Array.from(this.pools.values()).map(pool => ({
            id: pool.id,
            url: pool.url,
            active: pool.active,
            score: this.calculatePoolScore(pool.id),
            health: this.poolHealth.get(pool.id)
        }));
        
        return {
            activePool: this.activePool?.id,
            pools,
            metrics: { ...this.metrics },
            isFailingOver: this.isFailingOver
        };
    }

    stop() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        
        if (this.preemptiveInterval) {
            clearInterval(this.preemptiveInterval);
        }
        
        // Close all connections
        for (const pool of this.pools.values()) {
            if (pool.connection) {
                pool.connection.destroy();
            }
        }
        
        this.emit('stopped');
    }
}

module.exports = IntelligentFailoverManager;