/**
 * WebSocket Real-time Server
 * High-performance WebSocket server for real-time updates
 * Following Rob Pike's simplicity principles
 */

import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { createHash } from 'crypto';

export class RealtimeServer extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            port: config.port || 8081,
            heartbeatInterval: config.heartbeatInterval || 30000,
            compression: config.compression !== false,
            maxConnections: config.maxConnections || 10000,
            maxSubscriptionsPerClient: config.maxSubscriptionsPerClient || 100,
            ...config
        };
        
        this.wss = null;
        this.clients = new Map();
        this.channels = new Map();
        this.stats = {
            connections: 0,
            messages: 0,
            broadcasts: 0,
            errors: 0,
            startTime: Date.now()
        };
        
        this.messageHandlers = new Map();
        this.setupDefaultHandlers();
    }

    /**
     * Start WebSocket server
     */
    start() {
        this.wss = new WebSocketServer({
            port: this.config.port,
            perMessageDeflate: this.config.compression,
            maxPayload: 1024 * 1024, // 1MB max message size
            verifyClient: this.verifyClient.bind(this)
        });
        
        this.wss.on('connection', this.handleConnection.bind(this));
        this.wss.on('error', this.handleServerError.bind(this));
        
        // Start heartbeat
        this.heartbeatInterval = setInterval(
            () => this.heartbeat(),
            this.config.heartbeatInterval
        );
        
        console.log(`WebSocket server started on port ${this.config.port}`);
        this.emit('started', { port: this.config.port });
    }

    /**
     * Stop WebSocket server
     */
    stop() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        
        // Close all client connections
        this.clients.forEach((client, id) => {
            client.ws.close(1001, 'Server shutting down');
        });
        
        if (this.wss) {
            this.wss.close(() => {
                console.log('WebSocket server stopped');
                this.emit('stopped');
            });
        }
    }

    /**
     * Verify client connection
     */
    verifyClient(info) {
        // Check max connections
        if (this.clients.size >= this.config.maxConnections) {
            return false;
        }
        
        // Could add IP whitelist/blacklist, rate limiting, etc.
        return true;
    }

    /**
     * Handle new client connection
     */
    handleConnection(ws, request) {
        const clientId = this.generateClientId();
        const client = {
            id: clientId,
            ws: ws,
            ip: request.socket.remoteAddress,
            subscriptions: new Set(),
            isAlive: true,
            connectedAt: Date.now(),
            lastActivity: Date.now()
        };
        
        this.clients.set(clientId, client);
        this.stats.connections++;
        
        // Send welcome message
        this.sendToClient(client, {
            type: 'welcome',
            clientId: clientId,
            timestamp: Date.now(),
            channels: Array.from(this.channels.keys())
        });
        
        // Setup event handlers
        ws.on('message', (data) => this.handleMessage(client, data));
        ws.on('close', () => this.handleDisconnect(client));
        ws.on('error', (error) => this.handleClientError(client, error));
        ws.on('pong', () => this.handlePong(client));
        
        this.emit('connection', { clientId, ip: client.ip });
    }

    /**
     * Handle client message
     */
    async handleMessage(client, data) {
        try {
            const message = JSON.parse(data.toString());
            client.lastActivity = Date.now();
            this.stats.messages++;
            
            // Validate message
            if (!message.type) {
                throw new Error('Invalid message: missing type');
            }
            
            // Get handler
            const handler = this.messageHandlers.get(message.type);
            if (!handler) {
                throw new Error(`Unknown message type: ${message.type}`);
            }
            
            // Process message
            await handler.call(this, client, message);
            
        } catch (error) {
            this.stats.errors++;
            this.sendToClient(client, {
                type: 'error',
                error: error.message,
                timestamp: Date.now()
            });
        }
    }

    /**
     * Handle client disconnect
     */
    handleDisconnect(client) {
        // Unsubscribe from all channels
        client.subscriptions.forEach(channel => {
            this.unsubscribeClient(client, channel);
        });
        
        // Remove client
        this.clients.delete(client.id);
        
        this.emit('disconnect', { 
            clientId: client.id, 
            duration: Date.now() - client.connectedAt 
        });
    }

    /**
     * Handle client error
     */
    handleClientError(client, error) {
        console.error(`Client ${client.id} error:`, error);
        this.stats.errors++;
    }

    /**
     * Handle server error
     */
    handleServerError(error) {
        console.error('WebSocket server error:', error);
        this.emit('error', error);
    }

    /**
     * Handle pong response
     */
    handlePong(client) {
        client.isAlive = true;
    }

    /**
     * Heartbeat to detect dead connections
     */
    heartbeat() {
        this.clients.forEach((client) => {
            if (!client.isAlive) {
                client.ws.terminate();
                return;
            }
            
            client.isAlive = false;
            client.ws.ping();
        });
    }

    /**
     * Setup default message handlers
     */
    setupDefaultHandlers() {
        // Subscribe to channel
        this.addMessageHandler('subscribe', async (client, message) => {
            const { channel } = message;
            
            if (!channel) {
                throw new Error('Channel required');
            }
            
            if (client.subscriptions.size >= this.config.maxSubscriptionsPerClient) {
                throw new Error('Max subscriptions reached');
            }
            
            this.subscribeClient(client, channel);
            
            this.sendToClient(client, {
                type: 'subscribed',
                channel: channel,
                timestamp: Date.now()
            });
        });
        
        // Unsubscribe from channel
        this.addMessageHandler('unsubscribe', async (client, message) => {
            const { channel } = message;
            
            if (!channel) {
                throw new Error('Channel required');
            }
            
            this.unsubscribeClient(client, channel);
            
            this.sendToClient(client, {
                type: 'unsubscribed',
                channel: channel,
                timestamp: Date.now()
            });
        });
        
        // Ping/pong
        this.addMessageHandler('ping', async (client, message) => {
            this.sendToClient(client, {
                type: 'pong',
                timestamp: Date.now()
            });
        });
    }

    /**
     * Add custom message handler
     */
    addMessageHandler(type, handler) {
        this.messageHandlers.set(type, handler);
    }

    /**
     * Subscribe client to channel
     */
    subscribeClient(client, channel) {
        client.subscriptions.add(channel);
        
        if (!this.channels.has(channel)) {
            this.channels.set(channel, new Set());
        }
        
        this.channels.get(channel).add(client.id);
    }

    /**
     * Unsubscribe client from channel
     */
    unsubscribeClient(client, channel) {
        client.subscriptions.delete(channel);
        
        const channelClients = this.channels.get(channel);
        if (channelClients) {
            channelClients.delete(client.id);
            
            if (channelClients.size === 0) {
                this.channels.delete(channel);
            }
        }
    }

    /**
     * Send message to specific client
     */
    sendToClient(client, message) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(message));
        }
    }

    /**
     * Broadcast message to channel
     */
    broadcast(channel, data) {
        const channelClients = this.channels.get(channel);
        if (!channelClients || channelClients.size === 0) {
            return 0;
        }
        
        const message = JSON.stringify({
            type: 'update',
            channel: channel,
            data: data,
            timestamp: Date.now()
        });
        
        let sent = 0;
        channelClients.forEach(clientId => {
            const client = this.clients.get(clientId);
            if (client && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(message);
                sent++;
            }
        });
        
        this.stats.broadcasts++;
        return sent;
    }

    /**
     * Broadcast to all clients
     */
    broadcastAll(data) {
        const message = JSON.stringify({
            type: 'broadcast',
            data: data,
            timestamp: Date.now()
        });
        
        let sent = 0;
        this.clients.forEach(client => {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(message);
                sent++;
            }
        });
        
        return sent;
    }

    /**
     * Get server statistics
     */
    getStats() {
        const uptime = Date.now() - this.stats.startTime;
        
        return {
            ...this.stats,
            uptime: uptime,
            currentConnections: this.clients.size,
            channels: this.channels.size,
            subscriptions: Array.from(this.clients.values())
                .reduce((sum, client) => sum + client.subscriptions.size, 0)
        };
    }

    /**
     * Generate unique client ID
     */
    generateClientId() {
        return createHash('sha256')
            .update(Date.now().toString())
            .update(Math.random().toString())
            .digest('hex')
            .substring(0, 16);
    }
}

/**
 * Specialized servers for different data types
 */

export class MiningStatsServer extends RealtimeServer {
    constructor(config = {}) {
        super(config);
        
        this.channels = new Map([
            ['pool:stats', new Set()],
            ['pool:blocks', new Set()],
            ['pool:payments', new Set()],
            ['miner:stats', new Set()],
            ['miner:shares', new Set()],
            ['network:difficulty', new Set()],
            ['network:hashrate', new Set()]
        ]);
    }
    
    /**
     * Broadcast pool statistics
     */
    broadcastPoolStats(stats) {
        this.broadcast('pool:stats', {
            hashrate: stats.hashrate,
            miners: stats.miners,
            workers: stats.workers,
            shares: stats.shares,
            blocks: stats.blocks,
            efficiency: stats.efficiency,
            uptime: stats.uptime
        });
    }
    
    /**
     * Broadcast block found
     */
    broadcastBlockFound(block) {
        this.broadcast('pool:blocks', {
            height: block.height,
            hash: block.hash,
            finder: block.finder,
            reward: block.reward,
            timestamp: block.timestamp
        });
    }
    
    /**
     * Broadcast miner statistics
     */
    broadcastMinerStats(minerId, stats) {
        this.broadcast(`miner:${minerId}`, {
            hashrate: stats.hashrate,
            shares: stats.shares,
            lastShare: stats.lastShare,
            balance: stats.balance,
            workers: stats.workers
        });
    }
}

export class DexDataServer extends RealtimeServer {
    constructor(config = {}) {
        super(config);
        
        this.channels = new Map([
            ['dex:orderbook', new Set()],
            ['dex:trades', new Set()],
            ['dex:tickers', new Set()],
            ['dex:candles', new Set()],
            ['dex:depth', new Set()],
            ['defi:pools', new Set()],
            ['defi:farming', new Set()]
        ]);
    }
    
    /**
     * Broadcast order book updates
     */
    broadcastOrderBook(pair, orderbook) {
        this.broadcast(`dex:orderbook:${pair}`, {
            pair: pair,
            bids: orderbook.bids,
            asks: orderbook.asks,
            spread: orderbook.spread,
            timestamp: Date.now()
        });
    }
    
    /**
     * Broadcast trade execution
     */
    broadcastTrade(trade) {
        this.broadcast(`dex:trades:${trade.pair}`, {
            id: trade.id,
            pair: trade.pair,
            price: trade.price,
            amount: trade.amount,
            side: trade.side,
            timestamp: trade.timestamp
        });
    }
    
    /**
     * Broadcast ticker updates
     */
    broadcastTicker(pair, ticker) {
        this.broadcast(`dex:ticker:${pair}`, {
            pair: pair,
            last: ticker.last,
            bid: ticker.bid,
            ask: ticker.ask,
            high24h: ticker.high24h,
            low24h: ticker.low24h,
            volume24h: ticker.volume24h,
            change24h: ticker.change24h
        });
    }
    
    /**
     * Broadcast DeFi pool updates
     */
    broadcastPoolUpdate(poolId, data) {
        this.broadcast(`defi:pool:${poolId}`, {
            poolId: poolId,
            liquidity: data.liquidity,
            volume24h: data.volume24h,
            fees24h: data.fees24h,
            apy: data.apy,
            reserves: data.reserves
        });
    }
}

/**
 * WebSocket client for testing and external connections
 */
export class RealtimeClient extends EventEmitter {
    constructor(url, options = {}) {
        super();
        
        this.url = url;
        this.options = options;
        this.ws = null;
        this.subscriptions = new Set();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
        this.reconnectDelay = options.reconnectDelay || 1000;
    }
    
    connect() {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.url, this.options);
                
                this.ws.on('open', () => {
                    this.reconnectAttempts = 0;
                    this.emit('connected');
                    resolve();
                });
                
                this.ws.on('message', (data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        this.emit('message', message);
                        
                        if (message.type === 'update') {
                            this.emit(`update:${message.channel}`, message.data);
                        }
                    } catch (error) {
                        this.emit('error', error);
                    }
                });
                
                this.ws.on('close', () => {
                    this.emit('disconnected');
                    this.attemptReconnect();
                });
                
                this.ws.on('error', (error) => {
                    this.emit('error', error);
                    reject(error);
                });
                
            } catch (error) {
                reject(error);
            }
        });
    }
    
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
    
    subscribe(channel) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('Not connected');
        }
        
        this.subscriptions.add(channel);
        this.ws.send(JSON.stringify({
            type: 'subscribe',
            channel: channel
        }));
    }
    
    unsubscribe(channel) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('Not connected');
        }
        
        this.subscriptions.delete(channel);
        this.ws.send(JSON.stringify({
            type: 'unsubscribe',
            channel: channel
        }));
    }
    
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.emit('reconnectFailed');
            return;
        }
        
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        
        setTimeout(() => {
            this.connect()
                .then(() => {
                    // Resubscribe to channels
                    this.subscriptions.forEach(channel => {
                        this.subscribe(channel);
                    });
                })
                .catch(() => {
                    // Will trigger another reconnect attempt
                });
        }, delay);
    }
}

export default RealtimeServer;