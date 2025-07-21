/**
 * Mining Proxy Server
 * Allows miners to connect through a proxy for better connectivity and management
 */

import { EventEmitter } from 'events';
import { createServer as createTCPServer } from 'net';
import { createServer as createTLSServer } from 'tls';
import { WebSocketServer } from 'ws';
import { getLogger } from '../../core/logger.js';

// Proxy modes
export const ProxyMode = {
    TRANSPARENT: 'transparent',    // Pass-through proxy
    AGGREGATING: 'aggregating',    // Combines multiple miners
    LOAD_BALANCING: 'load_balancing', // Distributes across pools
    FAILOVER: 'failover'          // Automatic failover
};

// Connection protocols
export const Protocol = {
    STRATUM_V1: 'stratum',
    STRATUM_V2: 'stratum2',
    GETWORK: 'getwork',
    GETBLOCKTEMPLATE: 'gbt'
};

export class MiningProxy extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.logger = getLogger('MiningProxy');
        this.options = {
            mode: options.mode || ProxyMode.TRANSPARENT,
            listenPort: options.listenPort || 3333,
            listenHost: options.listenHost || '0.0.0.0',
            upstreamPools: options.upstreamPools || [],
            protocol: options.protocol || Protocol.STRATUM_V1,
            enableTLS: options.enableTLS || false,
            tlsOptions: options.tlsOptions || {},
            enableWebSocket: options.enableWebSocket || false,
            wsPort: options.wsPort || 3334,
            maxConnectionsPerIP: options.maxConnectionsPerIP || 10,
            shareValidation: options.shareValidation !== false,
            difficultyAdjustment: options.difficultyAdjustment !== false,
            statsInterval: options.statsInterval || 60000, // 1 minute
            reconnectInterval: options.reconnectInterval || 5000,
            shareSubmitTimeout: options.shareSubmitTimeout || 5000,
            ...options
        };
        
        // Servers
        this.tcpServer = null;
        this.tlsServer = null;
        this.wsServer = null;
        
        // Connections
        this.minerConnections = new Map();
        this.poolConnections = new Map();
        this.connectionsByIP = new Map();
        
        // Upstream pools
        this.pools = [];
        this.activePoolIndex = 0;
        this.poolStats = new Map();
        
        // Share tracking
        this.pendingShares = new Map();
        this.shareIdCounter = 0;
        
        // Statistics
        this.stats = {
            minersConnected: 0,
            totalMiners: 0,
            sharesSubmitted: 0,
            sharesAccepted: 0,
            sharesRejected: 0,
            hashrate: 0,
            uptime: Date.now(),
            poolStats: {}
        };
        
        // Difficulty management
        this.difficultyManager = new DifficultyManager(options);
        
        // Load balancer
        this.loadBalancer = new LoadBalancer(this.options.mode);
        
        // Initialize pools
        this.initializePools();
    }
    
    /**
     * Initialize upstream pools
     */
    initializePools() {
        this.options.upstreamPools.forEach((poolConfig, index) => {
            const pool = {
                id: index,
                name: poolConfig.name || `Pool ${index}`,
                host: poolConfig.host,
                port: poolConfig.port,
                protocol: poolConfig.protocol || this.options.protocol,
                username: poolConfig.username,
                password: poolConfig.password,
                priority: poolConfig.priority || index,
                weight: poolConfig.weight || 1,
                maxConnections: poolConfig.maxConnections || 100,
                enabled: poolConfig.enabled !== false,
                connection: null,
                connected: false,
                stats: {
                    sharesSubmitted: 0,
                    sharesAccepted: 0,
                    sharesRejected: 0,
                    lastShareTime: null,
                    hashrate: 0,
                    miners: 0
                }
            };
            
            this.pools.push(pool);
            this.poolStats.set(pool.id, pool.stats);
        });
        
        // Sort pools by priority
        this.pools.sort((a, b) => a.priority - b.priority);
    }
    
    /**
     * Start the proxy server
     */
    async start() {
        // Start TCP server
        if (!this.options.enableTLS || this.options.enableWebSocket) {
            await this.startTCPServer();
        }
        
        // Start TLS server
        if (this.options.enableTLS) {
            await this.startTLSServer();
        }
        
        // Start WebSocket server
        if (this.options.enableWebSocket) {
            await this.startWebSocketServer();
        }
        
        // Connect to upstream pools
        await this.connectToPools();
        
        // Start statistics collection
        this.startStatsCollection();
        
        this.logger.info(`Mining proxy started in ${this.options.mode} mode`);
        this.emit('started');
    }
    
    /**
     * Start TCP server
     */
    async startTCPServer() {
        return new Promise((resolve, reject) => {
            this.tcpServer = createTCPServer();
            
            this.tcpServer.on('connection', (socket) => {
                this.handleMinerConnection(socket, 'tcp');
            });
            
            this.tcpServer.on('error', (error) => {
                this.logger.error('TCP server error:', error);
                reject(error);
            });
            
            this.tcpServer.listen(this.options.listenPort, this.options.listenHost, () => {
                this.logger.info(`TCP server listening on ${this.options.listenHost}:${this.options.listenPort}`);
                resolve();
            });
        });
    }
    
    /**
     * Handle miner connection
     */
    handleMinerConnection(socket, type) {
        const minerIP = socket.remoteAddress;
        const minerId = this.generateMinerId();
        
        // Check connection limit
        if (!this.checkConnectionLimit(minerIP)) {
            this.logger.warn(`Connection limit exceeded for ${minerIP}`);
            socket.destroy();
            return;
        }
        
        // Create miner connection object
        const miner = {
            id: minerId,
            socket,
            type,
            ip: minerIP,
            connected: true,
            authorized: false,
            username: null,
            workerName: null,
            poolConnection: null,
            difficulty: 1,
            extraNonce1: this.generateExtraNonce1(),
            stats: {
                sharesSubmitted: 0,
                sharesAccepted: 0,
                sharesRejected: 0,
                hashrate: 0,
                lastShareTime: null
            },
            created: Date.now(),
            lastActivity: Date.now()
        };
        
        this.minerConnections.set(minerId, miner);
        this.stats.minersConnected++;
        this.stats.totalMiners++;
        
        // Update IP tracking
        const ipConnections = this.connectionsByIP.get(minerIP) || new Set();
        ipConnections.add(minerId);
        this.connectionsByIP.set(minerIP, ipConnections);
        
        // Setup socket handlers
        socket.on('data', (data) => {
            this.handleMinerData(miner, data);
        });
        
        socket.on('close', () => {
            this.handleMinerDisconnection(miner);
        });
        
        socket.on('error', (error) => {
            this.logger.error(`Miner ${minerId} socket error:`, error);
            this.handleMinerDisconnection(miner);
        });
        
        // Set socket options
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30000);
        
        this.emit('miner:connected', {
            minerId,
            ip: minerIP,
            type
        });
    }
    
    /**
     * Handle miner data
     */
    handleMinerData(miner, data) {
        try {
            miner.lastActivity = Date.now();
            
            // Parse JSON-RPC messages
            const messages = this.parseMessages(data);
            
            for (const message of messages) {
                this.handleMinerMessage(miner, message);
            }
        } catch (error) {
            this.logger.error(`Error handling miner ${miner.id} data:`, error);
            this.sendErrorToMiner(miner, -1, 'Invalid message format');
        }
    }
    
    /**
     * Handle miner message
     */
    async handleMinerMessage(miner, message) {
        const { id, method, params } = message;
        
        switch (method) {
            case 'mining.subscribe':
                await this.handleMiningSubscribe(miner, id, params);
                break;
                
            case 'mining.authorize':
                await this.handleMiningAuthorize(miner, id, params);
                break;
                
            case 'mining.submit':
                await this.handleMiningSubmit(miner, id, params);
                break;
                
            case 'mining.get_transactions':
                await this.handleGetTransactions(miner, id, params);
                break;
                
            case 'mining.extranonce.subscribe':
                await this.handleExtranonceSubscribe(miner, id, params);
                break;
                
            default:
                // Forward unknown methods to pool
                if (miner.poolConnection) {
                    this.forwardToPool(miner, message);
                } else {
                    this.sendErrorToMiner(miner, id, 'Not connected to pool');
                }
        }
    }
    
    /**
     * Handle mining.subscribe
     */
    async handleMiningSubscribe(miner, messageId, params) {
        // Select pool based on mode
        const pool = await this.selectPool(miner);
        
        if (!pool || !pool.connected) {
            this.sendErrorToMiner(miner, messageId, 'No pools available');
            return;
        }
        
        // Associate miner with pool
        miner.poolConnection = pool;
        pool.stats.miners++;
        
        // Send subscription response
        const response = {
            id: messageId,
            result: [
                [['mining.notify', this.generateSubscriptionId()], miner.extraNonce1, 4],
                miner.extraNonce1,
                4 // ExtraNonce2 size
            ],
            error: null
        };
        
        this.sendToMiner(miner, response);
        
        // Request current job from pool
        this.requestJobFromPool(pool, miner);
    }
    
    /**
     * Handle mining.authorize
     */
    async handleMiningAuthorize(miner, messageId, params) {
        const [username, password] = params;
        
        miner.username = username;
        miner.workerName = username.split('.')[1] || 'default';
        miner.authorized = true;
        
        // Send authorization response
        this.sendToMiner(miner, {
            id: messageId,
            result: true,
            error: null
        });
        
        // Set initial difficulty
        if (this.options.difficultyAdjustment) {
            const difficulty = this.difficultyManager.getInitialDifficulty(miner);
            this.sendMiningSetDifficulty(miner, difficulty);
        }
        
        this.emit('miner:authorized', {
            minerId: miner.id,
            username: miner.username
        });
    }
    
    /**
     * Handle mining.submit
     */
    async handleMiningSubmit(miner, messageId, params) {
        const [workerName, jobId, extraNonce2, ntime, nonce] = params;
        
        if (!miner.authorized || !miner.poolConnection) {
            this.sendErrorToMiner(miner, messageId, 'Not authorized');
            return;
        }
        
        // Track share
        const shareId = ++this.shareIdCounter;
        const share = {
            id: shareId,
            minerId: miner.id,
            poolId: miner.poolConnection.id,
            jobId,
            extraNonce2,
            ntime,
            nonce,
            submitted: Date.now(),
            messageId
        };
        
        this.pendingShares.set(shareId, share);
        miner.stats.sharesSubmitted++;
        this.stats.sharesSubmitted++;
        
        // Validate share if enabled
        if (this.options.shareValidation) {
            const isValid = await this.validateShare(share, miner);
            if (!isValid) {
                this.handleShareResponse(shareId, false, 'Invalid share');
                return;
            }
        }
        
        // Forward to pool with tracking
        const poolMessage = {
            id: shareId, // Use our share ID for tracking
            method: 'mining.submit',
            params: [miner.username, jobId, extraNonce2, ntime, nonce]
        };
        
        this.sendToPool(miner.poolConnection, poolMessage);
        
        // Set timeout for share response
        setTimeout(() => {
            if (this.pendingShares.has(shareId)) {
                this.handleShareResponse(shareId, false, 'Share timeout');
            }
        }, this.options.shareSubmitTimeout);
    }
    
    /**
     * Handle share response from pool
     */
    handleShareResponse(shareId, accepted, reason = null) {
        const share = this.pendingShares.get(shareId);
        if (!share) return;
        
        this.pendingShares.delete(shareId);
        
        const miner = this.minerConnections.get(share.minerId);
        if (!miner) return;
        
        if (accepted) {
            miner.stats.sharesAccepted++;
            this.stats.sharesAccepted++;
            miner.stats.lastShareTime = Date.now();
            
            // Adjust difficulty if needed
            if (this.options.difficultyAdjustment) {
                const newDifficulty = this.difficultyManager.adjustDifficulty(miner);
                if (newDifficulty !== miner.difficulty) {
                    this.sendMiningSetDifficulty(miner, newDifficulty);
                }
            }
        } else {
            miner.stats.sharesRejected++;
            this.stats.sharesRejected++;
        }
        
        // Send response to miner
        this.sendToMiner(miner, {
            id: share.messageId,
            result: accepted,
            error: accepted ? null : [21, reason || 'Share rejected', null]
        });
        
        this.emit('share:processed', {
            minerId: miner.id,
            shareId,
            accepted,
            reason
        });
    }
    
    /**
     * Connect to upstream pools
     */
    async connectToPools() {
        const connectPromises = this.pools
            .filter(pool => pool.enabled)
            .map(pool => this.connectToPool(pool));
        
        await Promise.allSettled(connectPromises);
    }
    
    /**
     * Connect to individual pool
     */
    async connectToPool(pool) {
        try {
            const socket = new net.Socket();
            
            await new Promise((resolve, reject) => {
                socket.connect(pool.port, pool.host, () => {
                    pool.connection = socket;
                    pool.connected = true;
                    this.poolConnections.set(pool.id, socket);
                    
                    this.logger.info(`Connected to pool ${pool.name} at ${pool.host}:${pool.port}`);
                    resolve();
                });
                
                socket.on('error', (error) => {
                    this.logger.error(`Pool ${pool.name} connection error:`, error);
                    pool.connected = false;
                    reject(error);
                });
                
                socket.on('close', () => {
                    pool.connected = false;
                    this.handlePoolDisconnection(pool);
                });
                
                socket.on('data', (data) => {
                    this.handlePoolData(pool, data);
                });
            });
            
            // Authenticate with pool if needed
            if (pool.protocol === Protocol.STRATUM_V1) {
                await this.authenticateWithPool(pool);
            }
            
        } catch (error) {
            this.logger.error(`Failed to connect to pool ${pool.name}:`, error);
            pool.connected = false;
            
            // Schedule reconnection
            setTimeout(() => {
                if (pool.enabled) {
                    this.connectToPool(pool);
                }
            }, this.options.reconnectInterval);
        }
    }
    
    /**
     * Select pool based on proxy mode
     */
    async selectPool(miner) {
        switch (this.options.mode) {
            case ProxyMode.TRANSPARENT:
            case ProxyMode.AGGREGATING:
                // Use first available pool
                return this.pools.find(p => p.connected && p.enabled);
                
            case ProxyMode.LOAD_BALANCING:
                // Select based on load balancer algorithm
                return this.loadBalancer.selectPool(this.pools, miner);
                
            case ProxyMode.FAILOVER:
                // Use highest priority connected pool
                return this.pools.find(p => p.connected && p.enabled);
                
            default:
                return this.pools[0];
        }
    }
    
    /**
     * Send mining.set_difficulty
     */
    sendMiningSetDifficulty(miner, difficulty) {
        miner.difficulty = difficulty;
        
        this.sendToMiner(miner, {
            id: null,
            method: 'mining.set_difficulty',
            params: [difficulty]
        });
    }
    
    /**
     * Send to miner
     */
    sendToMiner(miner, message) {
        try {
            const data = JSON.stringify(message) + '\n';
            miner.socket.write(data);
        } catch (error) {
            this.logger.error(`Error sending to miner ${miner.id}:`, error);
            this.handleMinerDisconnection(miner);
        }
    }
    
    /**
     * Get proxy statistics
     */
    getStats() {
        const poolStats = {};
        
        for (const pool of this.pools) {
            poolStats[pool.name] = {
                connected: pool.connected,
                miners: pool.stats.miners,
                sharesSubmitted: pool.stats.sharesSubmitted,
                sharesAccepted: pool.stats.sharesAccepted,
                sharesRejected: pool.stats.sharesRejected,
                hashrate: pool.stats.hashrate
            };
        }
        
        return {
            ...this.stats,
            poolStats,
            uptime: Date.now() - this.stats.uptime,
            efficiency: this.stats.sharesSubmitted > 0 
                ? (this.stats.sharesAccepted / this.stats.sharesSubmitted * 100).toFixed(2) + '%'
                : '0%'
        };
    }
    
    /**
     * Shutdown proxy
     */
    async shutdown() {
        this.logger.info('Shutting down mining proxy...');
        
        // Close miner connections
        for (const miner of this.minerConnections.values()) {
            miner.socket.end();
        }
        
        // Close pool connections
        for (const pool of this.pools) {
            if (pool.connection) {
                pool.connection.end();
            }
        }
        
        // Close servers
        const closePromises = [];
        
        if (this.tcpServer) {
            closePromises.push(new Promise(resolve => this.tcpServer.close(resolve)));
        }
        
        if (this.tlsServer) {
            closePromises.push(new Promise(resolve => this.tlsServer.close(resolve)));
        }
        
        if (this.wsServer) {
            closePromises.push(new Promise(resolve => this.wsServer.close(resolve)));
        }
        
        await Promise.all(closePromises);
        
        this.logger.info('Mining proxy shut down');
        this.emit('shutdown');
    }
}

// Difficulty Manager
class DifficultyManager {
    constructor(options) {
        this.targetShareTime = options.targetShareTime || 30000; // 30 seconds
        this.minDifficulty = options.minDifficulty || 1;
        this.maxDifficulty = options.maxDifficulty || 65536;
    }
    
    getInitialDifficulty(miner) {
        // Could be based on miner's reported hashrate or historical data
        return 16; // Start with reasonable difficulty
    }
    
    adjustDifficulty(miner) {
        if (!miner.stats.lastShareTime) {
            return miner.difficulty;
        }
        
        const timeSinceLastShare = Date.now() - miner.stats.lastShareTime;
        const targetTime = this.targetShareTime;
        
        let newDifficulty = miner.difficulty;
        
        if (timeSinceLastShare < targetTime * 0.5) {
            // Too fast, increase difficulty
            newDifficulty = Math.min(miner.difficulty * 2, this.maxDifficulty);
        } else if (timeSinceLastShare > targetTime * 2) {
            // Too slow, decrease difficulty
            newDifficulty = Math.max(miner.difficulty / 2, this.minDifficulty);
        }
        
        return Math.floor(newDifficulty);
    }
}

// Load Balancer
class LoadBalancer {
    constructor(mode) {
        this.mode = mode;
        this.roundRobinIndex = 0;
    }
    
    selectPool(pools, miner) {
        const availablePools = pools.filter(p => p.connected && p.enabled);
        
        if (availablePools.length === 0) {
            return null;
        }
        
        switch (this.mode) {
            case ProxyMode.LOAD_BALANCING:
                // Weighted round-robin
                return this.weightedRoundRobin(availablePools);
                
            default:
                // Simple round-robin
                const pool = availablePools[this.roundRobinIndex % availablePools.length];
                this.roundRobinIndex++;
                return pool;
        }
    }
    
    weightedRoundRobin(pools) {
        // Calculate total weight
        const totalWeight = pools.reduce((sum, pool) => sum + pool.weight, 0);
        
        // Random selection based on weight
        let random = Math.random() * totalWeight;
        
        for (const pool of pools) {
            random -= pool.weight;
            if (random <= 0) {
                return pool;
            }
        }
        
        return pools[0];
    }
}

export default MiningProxy;