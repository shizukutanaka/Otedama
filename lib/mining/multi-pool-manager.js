const { EventEmitter } = require('events');
const net = require('net');
const tls = require('tls');

class MultiPoolManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            maxPools: options.maxPools || 10,
            switchingStrategy: options.switchingStrategy || 'profit',
            minProfitDifference: options.minProfitDifference || 0.05,
            reconnectDelay: options.reconnectDelay || 5000,
            healthCheckInterval: options.healthCheckInterval || 30000,
            shareValidationTimeout: options.shareValidationTimeout || 5000,
            ...options
        };
        
        this.pools = new Map();
        this.activePool = null;
        this.miners = new Map();
        
        // Performance tracking
        this.poolStats = new Map();
        this.profitHistory = new Map();
        
        // Share routing
        this.pendingShares = new Map();
        this.shareRouter = new Map();
        
        this.isRunning = false;
    }

    addPool(poolConfig) {
        const poolId = this.generatePoolId(poolConfig);
        
        const pool = {
            id: poolId,
            ...poolConfig,
            priority: poolConfig.priority || 0,
            connection: null,
            status: 'disconnected',
            difficulty: null,
            extraNonce1: null,
            extraNonce2Size: null,
            authorized: false
        };
        
        this.pools.set(poolId, pool);
        
        // Initialize stats
        this.poolStats.set(poolId, {
            connected: 0,
            disconnected: 0,
            shares: { submitted: 0, accepted: 0, rejected: 0 },
            hashrate: 0,
            latency: [],
            profitability: 0,
            lastUpdate: Date.now()
        });
        
        return poolId;
    }

    async start() {
        this.isRunning = true;
        
        // Connect to all pools
        await this.connectAllPools();
        
        // Select best pool
        this.selectBestPool();
        
        // Start monitoring
        this.startHealthMonitoring();
        this.startProfitabilityTracking();
        
        this.emit('started');
    }

    async connectAllPools() {
        const connectPromises = [];
        
        for (const [poolId, pool] of this.pools) {
            connectPromises.push(this.connectToPool(poolId));
        }
        
        await Promise.allSettled(connectPromises);
    }

    async connectToPool(poolId) {
        const pool = this.pools.get(poolId);
        if (!pool || pool.status === 'connected') return;
        
        pool.status = 'connecting';
        
        try {
            const connection = await this.createPoolConnection(pool);
            pool.connection = connection;
            
            // Setup handlers
            this.setupPoolHandlers(poolId, connection);
            
            // Subscribe
            await this.subscribeToPool(poolId);
            
            // Authorize
            await this.authorizePool(poolId);
            
            pool.status = 'connected';
            pool.authorized = true;
            
            const stats = this.poolStats.get(poolId);
            stats.connected++;
            
            this.emit('pool:connected', { poolId });
            
        } catch (error) {
            pool.status = 'error';
            pool.error = error.message;
            
            const stats = this.poolStats.get(poolId);
            stats.disconnected++;
            
            this.emit('pool:error', { poolId, error });
            
            // Schedule reconnect
            setTimeout(() => this.connectToPool(poolId), this.config.reconnectDelay);
        }
    }

    createPoolConnection(pool) {
        return new Promise((resolve, reject) => {
            const url = new URL(pool.url);
            const useTLS = url.protocol === 'stratum+ssl:';
            
            const options = {
                host: url.hostname,
                port: parseInt(url.port) || 3333
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

    setupPoolHandlers(poolId, connection) {
        let buffer = '';
        
        connection.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
                if (line.trim()) {
                    this.handlePoolMessage(poolId, line);
                }
            }
        });
        
        connection.on('close', () => {
            this.handlePoolDisconnection(poolId);
        });
        
        connection.on('error', (error) => {
            this.emit('pool:error', { poolId, error });
        });
    }

    handlePoolMessage(poolId, message) {
        try {
            const data = JSON.parse(message);
            const pool = this.pools.get(poolId);
            
            if (data.id !== null && data.id !== undefined) {
                // Response to our request
                this.handlePoolResponse(poolId, data);
            } else if (data.method) {
                // Notification from pool
                switch (data.method) {
                    case 'mining.notify':
                        this.handleMiningNotify(poolId, data.params);
                        break;
                        
                    case 'mining.set_difficulty':
                        this.handleSetDifficulty(poolId, data.params);
                        break;
                        
                    case 'mining.set_extranonce':
                        this.handleSetExtranonce(poolId, data.params);
                        break;
                        
                    case 'client.reconnect':
                        this.handleReconnectRequest(poolId, data.params);
                        break;
                }
            }
        } catch (error) {
            this.emit('pool:parse-error', { poolId, error });
        }
    }

    handlePoolResponse(poolId, response) {
        // Handle subscribe response
        if (response.id === 1) {
            const pool = this.pools.get(poolId);
            if (response.result) {
                pool.extraNonce1 = response.result[1];
                pool.extraNonce2Size = response.result[2];
                this.emit('pool:subscribed', { poolId });
            }
        }
        
        // Handle authorize response
        else if (response.id === 2) {
            if (response.result === true) {
                this.emit('pool:authorized', { poolId });
            } else {
                this.emit('pool:auth-failed', { poolId });
            }
        }
        
        // Handle share submission response
        else if (response.id >= 1000) {
            this.handleShareResponse(poolId, response);
        }
    }

    handleMiningNotify(poolId, params) {
        const pool = this.pools.get(poolId);
        
        const job = {
            id: params[0],
            prevHash: params[1],
            coinbase1: params[2],
            coinbase2: params[3],
            merkleBranches: params[4],
            version: params[5],
            nbits: params[6],
            ntime: params[7],
            clean: params[8]
        };
        
        pool.currentJob = job;
        
        // If this is the active pool, broadcast to miners
        if (poolId === this.activePool) {
            this.broadcastJobToMiners(job, poolId);
        }
    }

    handleSetDifficulty(poolId, params) {
        const pool = this.pools.get(poolId);
        pool.difficulty = params[0];
        
        this.emit('pool:difficulty', { poolId, difficulty: pool.difficulty });
    }

    handleShareResponse(poolId, response) {
        const shareId = response.id;
        const pendingShare = this.pendingShares.get(shareId);
        
        if (!pendingShare) return;
        
        const stats = this.poolStats.get(poolId);
        
        if (response.result === true) {
            stats.shares.accepted++;
            this.emit('share:accepted', { poolId, share: pendingShare });
        } else {
            stats.shares.rejected++;
            this.emit('share:rejected', { 
                poolId, 
                share: pendingShare, 
                reason: response.error 
            });
        }
        
        this.pendingShares.delete(shareId);
        
        // Update profitability
        this.updatePoolProfitability(poolId);
    }

    async subscribeToPool(poolId) {
        const pool = this.pools.get(poolId);
        if (!pool.connection) throw new Error('Not connected');
        
        const subscribeMsg = JSON.stringify({
            id: 1,
            method: 'mining.subscribe',
            params: ['Otedama/1.0']
        }) + '\n';
        
        pool.connection.write(subscribeMsg);
        
        // Wait for response
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Subscribe timeout'));
            }, 5000);
            
            this.once('pool:subscribed', (event) => {
                if (event.poolId === poolId) {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });
    }

    async authorizePool(poolId) {
        const pool = this.pools.get(poolId);
        if (!pool.connection) throw new Error('Not connected');
        
        const authMsg = JSON.stringify({
            id: 2,
            method: 'mining.authorize',
            params: [pool.username, pool.password || 'x']
        }) + '\n';
        
        pool.connection.write(authMsg);
        
        // Wait for response
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Authorization timeout'));
            }, 5000);
            
            this.once('pool:authorized', (event) => {
                if (event.poolId === poolId) {
                    clearTimeout(timeout);
                    resolve();
                }
            });
            
            this.once('pool:auth-failed', (event) => {
                if (event.poolId === poolId) {
                    clearTimeout(timeout);
                    reject(new Error('Authorization failed'));
                }
            });
        });
    }

    selectBestPool() {
        let bestPool = null;
        let bestScore = -1;
        
        for (const [poolId, pool] of this.pools) {
            if (pool.status !== 'connected' || !pool.authorized) continue;
            
            const score = this.calculatePoolScore(poolId);
            if (score > bestScore) {
                bestScore = score;
                bestPool = poolId;
            }
        }
        
        if (bestPool && bestPool !== this.activePool) {
            this.switchToPool(bestPool);
        }
    }

    calculatePoolScore(poolId) {
        const pool = this.pools.get(poolId);
        const stats = this.poolStats.get(poolId);
        
        let score = pool.priority * 0.2;
        
        // Share acceptance rate
        const totalShares = stats.shares.submitted || 1;
        const acceptRate = stats.shares.accepted / totalShares;
        score += acceptRate * 0.3;
        
        // Latency
        const avgLatency = stats.latency.length > 0 ?
            stats.latency.reduce((a, b) => a + b) / stats.latency.length : 0;
        const latencyScore = Math.max(0, 1 - (avgLatency / 1000));
        score += latencyScore * 0.2;
        
        // Profitability
        score += stats.profitability * 0.3;
        
        return score;
    }

    switchToPool(poolId) {
        const previousPool = this.activePool;
        this.activePool = poolId;
        
        const pool = this.pools.get(poolId);
        
        // Send current job to all miners
        if (pool.currentJob) {
            this.broadcastJobToMiners(pool.currentJob, poolId);
        }
        
        this.emit('pool:switched', { 
            from: previousPool, 
            to: poolId 
        });
    }

    broadcastJobToMiners(job, poolId) {
        const pool = this.pools.get(poolId);
        
        for (const [minerId, miner] of this.miners) {
            const minerJob = {
                ...job,
                extraNonce1: pool.extraNonce1,
                extraNonce2Size: pool.extraNonce2Size,
                poolId: poolId
            };
            
            miner.sendJob(minerJob);
        }
    }

    submitShare(minerId, share) {
        const miner = this.miners.get(minerId);
        if (!miner) return;
        
        // Route share to appropriate pool
        const poolId = share.poolId || this.activePool;
        const pool = this.pools.get(poolId);
        
        if (!pool || pool.status !== 'connected') {
            // Try alternate pool
            poolId = this.findAlternatePool(poolId);
            if (!poolId) {
                this.emit('share:no-pool', { minerId, share });
                return;
            }
        }
        
        // Generate share ID
        const shareId = this.generateShareId();
        
        // Track pending share
        this.pendingShares.set(shareId, {
            minerId,
            share,
            poolId,
            timestamp: Date.now()
        });
        
        // Submit to pool
        const submitMsg = JSON.stringify({
            id: shareId,
            method: 'mining.submit',
            params: [
                pool.username,
                share.jobId,
                share.extraNonce2,
                share.ntime,
                share.nonce
            ]
        }) + '\n';
        
        pool.connection.write(submitMsg);
        
        const stats = this.poolStats.get(poolId);
        stats.shares.submitted++;
        
        // Timeout handling
        setTimeout(() => {
            if (this.pendingShares.has(shareId)) {
                this.pendingShares.delete(shareId);
                stats.shares.rejected++;
                this.emit('share:timeout', { poolId, share });
            }
        }, this.config.shareValidationTimeout);
    }

    findAlternatePool(excludePoolId) {
        for (const [poolId, pool] of this.pools) {
            if (poolId !== excludePoolId && 
                pool.status === 'connected' && 
                pool.authorized) {
                return poolId;
            }
        }
        return null;
    }

    addMiner(minerId, minerInterface) {
        this.miners.set(minerId, minerInterface);
        
        // Send current job if available
        if (this.activePool) {
            const pool = this.pools.get(this.activePool);
            if (pool && pool.currentJob) {
                this.broadcastJobToMiners(pool.currentJob, this.activePool);
            }
        }
        
        this.emit('miner:added', { minerId });
    }

    removeMiner(minerId) {
        this.miners.delete(minerId);
        this.emit('miner:removed', { minerId });
    }

    startHealthMonitoring() {
        this.healthInterval = setInterval(() => {
            for (const [poolId, pool] of this.pools) {
                if (pool.status === 'connected') {
                    this.checkPoolHealth(poolId);
                }
            }
            
            // Re-evaluate best pool
            this.selectBestPool();
        }, this.config.healthCheckInterval);
    }

    async checkPoolHealth(poolId) {
        const pool = this.pools.get(poolId);
        const stats = this.poolStats.get(poolId);
        
        // Measure latency
        const start = Date.now();
        
        try {
            // Send ping
            const pingMsg = JSON.stringify({
                id: 999,
                method: 'mining.ping',
                params: []
            }) + '\n';
            
            pool.connection.write(pingMsg);
            
            // Latency will be calculated on response
            
        } catch (error) {
            this.handlePoolDisconnection(poolId);
        }
    }

    startProfitabilityTracking() {
        this.profitInterval = setInterval(async () => {
            for (const [poolId, pool] of this.pools) {
                if (pool.status === 'connected') {
                    await this.updatePoolProfitability(poolId);
                }
            }
            
            // Check if should switch pools
            if (this.config.switchingStrategy === 'profit') {
                this.evaluateProfitSwitch();
            }
        }, 60000); // Every minute
    }

    async updatePoolProfitability(poolId) {
        const stats = this.poolStats.get(poolId);
        const pool = this.pools.get(poolId);
        
        // Calculate profitability based on various factors
        const acceptRate = stats.shares.accepted / (stats.shares.submitted || 1);
        const difficulty = pool.difficulty || 1;
        
        // Simplified profitability calculation
        const profitability = acceptRate / difficulty;
        
        stats.profitability = profitability;
        
        // Track history
        if (!this.profitHistory.has(poolId)) {
            this.profitHistory.set(poolId, []);
        }
        
        const history = this.profitHistory.get(poolId);
        history.push({
            timestamp: Date.now(),
            profitability
        });
        
        // Keep only last hour
        const cutoff = Date.now() - 3600000;
        this.profitHistory.set(poolId, 
            history.filter(h => h.timestamp > cutoff)
        );
    }

    evaluateProfitSwitch() {
        if (!this.activePool) return;
        
        const currentStats = this.poolStats.get(this.activePool);
        const currentProfit = currentStats.profitability;
        
        for (const [poolId, pool] of this.pools) {
            if (poolId === this.activePool) continue;
            if (pool.status !== 'connected') continue;
            
            const stats = this.poolStats.get(poolId);
            const profitDiff = (stats.profitability - currentProfit) / currentProfit;
            
            if (profitDiff > this.config.minProfitDifference) {
                this.switchToPool(poolId);
                break;
            }
        }
    }

    handlePoolDisconnection(poolId) {
        const pool = this.pools.get(poolId);
        pool.status = 'disconnected';
        pool.authorized = false;
        
        const stats = this.poolStats.get(poolId);
        stats.disconnected++;
        
        this.emit('pool:disconnected', { poolId });
        
        // If active pool, switch to another
        if (poolId === this.activePool) {
            this.selectBestPool();
        }
        
        // Schedule reconnect
        setTimeout(() => this.connectToPool(poolId), this.config.reconnectDelay);
    }

    generatePoolId(config) {
        const url = new URL(config.url);
        return `${url.hostname}:${url.port || 3333}`;
    }

    generateShareId() {
        return 1000 + Math.floor(Math.random() * 1000000);
    }

    getStatus() {
        const status = {
            activePool: this.activePool,
            pools: [],
            totalHashrate: 0
        };
        
        for (const [poolId, pool] of this.pools) {
            const stats = this.poolStats.get(poolId);
            status.pools.push({
                id: poolId,
                url: pool.url,
                status: pool.status,
                difficulty: pool.difficulty,
                stats: {
                    shares: stats.shares,
                    profitability: stats.profitability,
                    latency: stats.latency.length > 0 ?
                        stats.latency.reduce((a, b) => a + b) / stats.latency.length : 0
                }
            });
        }
        
        return status;
    }

    async stop() {
        this.isRunning = false;
        
        // Clear intervals
        if (this.healthInterval) clearInterval(this.healthInterval);
        if (this.profitInterval) clearInterval(this.profitInterval);
        
        // Disconnect all pools
        for (const [poolId, pool] of this.pools) {
            if (pool.connection) {
                pool.connection.destroy();
            }
        }
        
        this.emit('stopped');
    }
}

module.exports = MultiPoolManager;