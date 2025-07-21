/**
 * WebSocket Real-time Client
 * Browser-compatible WebSocket client for real-time updates
 */

export class RealtimeDataClient {
    constructor(config = {}) {
        this.config = {
            url: config.url || 'ws://localhost:8081',
            reconnect: config.reconnect !== false,
            reconnectDelay: config.reconnectDelay || 1000,
            maxReconnectDelay: config.maxReconnectDelay || 30000,
            reconnectDecay: config.reconnectDecay || 1.5,
            timeout: config.timeout || 30000,
            debug: config.debug || false,
            ...config
        };
        
        this.ws = null;
        this.subscriptions = new Map();
        this.handlers = new Map();
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.pingTimer = null;
        this.connected = false;
        this.connecting = false;
        
        // Event callbacks
        this.onConnect = null;
        this.onDisconnect = null;
        this.onError = null;
        this.onReconnect = null;
    }

    /**
     * Connect to WebSocket server
     */
    connect() {
        return new Promise((resolve, reject) => {
            if (this.connected || this.connecting) {
                resolve();
                return;
            }
            
            this.connecting = true;
            this.log('Connecting to', this.config.url);
            
            try {
                this.ws = new WebSocket(this.config.url);
                
                // Connection timeout
                const timeout = setTimeout(() => {
                    this.ws.close();
                    reject(new Error('Connection timeout'));
                }, this.config.timeout);
                
                this.ws.onopen = () => {
                    clearTimeout(timeout);
                    this.connected = true;
                    this.connecting = false;
                    this.reconnectAttempts = 0;
                    
                    this.log('Connected');
                    this.startPing();
                    
                    // Resubscribe to channels
                    this.resubscribe();
                    
                    if (this.onConnect) {
                        this.onConnect();
                    }
                    
                    resolve();
                };
                
                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };
                
                this.ws.onclose = (event) => {
                    clearTimeout(timeout);
                    this.handleDisconnect(event);
                };
                
                this.ws.onerror = (error) => {
                    clearTimeout(timeout);
                    this.log('WebSocket error:', error);
                    
                    if (this.onError) {
                        this.onError(error);
                    }
                    
                    if (this.connecting) {
                        this.connecting = false;
                        reject(error);
                    }
                };
                
            } catch (error) {
                this.connecting = false;
                this.log('Connection error:', error);
                reject(error);
            }
        });
    }

    /**
     * Disconnect from server
     */
    disconnect() {
        this.log('Disconnecting');
        
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        
        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }
        
        this.connected = false;
        this.connecting = false;
    }

    /**
     * Handle incoming message
     */
    handleMessage(data) {
        try {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'welcome':
                    this.handleWelcome(message);
                    break;
                    
                case 'update':
                    this.handleUpdate(message);
                    break;
                    
                case 'broadcast':
                    this.handleBroadcast(message);
                    break;
                    
                case 'error':
                    this.handleError(message);
                    break;
                    
                case 'pong':
                    // Ping response
                    break;
                    
                default:
                    this.log('Unknown message type:', message.type);
            }
            
        } catch (error) {
            this.log('Message parse error:', error);
        }
    }

    /**
     * Handle welcome message
     */
    handleWelcome(message) {
        this.clientId = message.clientId;
        this.log('Welcome received, client ID:', this.clientId);
    }

    /**
     * Handle channel update
     */
    handleUpdate(message) {
        const { channel, data } = message;
        
        const handlers = this.handlers.get(channel);
        if (handlers) {
            handlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    console.error('Update handler error:', error);
                }
            });
        }
    }

    /**
     * Handle broadcast message
     */
    handleBroadcast(message) {
        const handlers = this.handlers.get('*');
        if (handlers) {
            handlers.forEach(handler => {
                try {
                    handler(message.data);
                } catch (error) {
                    console.error('Broadcast handler error:', error);
                }
            });
        }
    }

    /**
     * Handle error message
     */
    handleError(message) {
        console.error('Server error:', message.error);
        
        if (this.onError) {
            this.onError(new Error(message.error));
        }
    }

    /**
     * Handle disconnect
     */
    handleDisconnect(event) {
        this.connected = false;
        this.connecting = false;
        
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        
        this.log('Disconnected:', event.code, event.reason);
        
        if (this.onDisconnect) {
            this.onDisconnect(event);
        }
        
        // Attempt reconnection
        if (this.config.reconnect && event.code !== 1000) {
            this.scheduleReconnect();
        }
    }

    /**
     * Schedule reconnection attempt
     */
    scheduleReconnect() {
        if (this.reconnectTimer) {
            return;
        }
        
        const delay = Math.min(
            this.config.reconnectDelay * Math.pow(this.config.reconnectDecay, this.reconnectAttempts),
            this.config.maxReconnectDelay
        );
        
        this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
        
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.reconnectAttempts++;
            
            this.connect()
                .then(() => {
                    if (this.onReconnect) {
                        this.onReconnect();
                    }
                })
                .catch(() => {
                    // Will trigger another reconnect
                });
        }, delay);
    }

    /**
     * Subscribe to channel
     */
    subscribe(channel, handler) {
        if (!handler || typeof handler !== 'function') {
            throw new Error('Handler must be a function');
        }
        
        // Add handler
        if (!this.handlers.has(channel)) {
            this.handlers.set(channel, new Set());
        }
        this.handlers.get(channel).add(handler);
        
        // Track subscription
        if (!this.subscriptions.has(channel)) {
            this.subscriptions.set(channel, 0);
        }
        this.subscriptions.set(channel, this.subscriptions.get(channel) + 1);
        
        // Send subscribe message if connected
        if (this.connected && this.subscriptions.get(channel) === 1) {
            this.send({
                type: 'subscribe',
                channel: channel
            });
        }
        
        // Return unsubscribe function
        return () => {
            this.unsubscribe(channel, handler);
        };
    }

    /**
     * Unsubscribe from channel
     */
    unsubscribe(channel, handler) {
        const handlers = this.handlers.get(channel);
        if (handlers) {
            handlers.delete(handler);
            
            if (handlers.size === 0) {
                this.handlers.delete(channel);
            }
        }
        
        const count = this.subscriptions.get(channel);
        if (count > 0) {
            this.subscriptions.set(channel, count - 1);
            
            if (count === 1) {
                this.subscriptions.delete(channel);
                
                // Send unsubscribe message if connected
                if (this.connected) {
                    this.send({
                        type: 'unsubscribe',
                        channel: channel
                    });
                }
            }
        }
    }

    /**
     * Resubscribe to all channels
     */
    resubscribe() {
        this.subscriptions.forEach((count, channel) => {
            if (count > 0) {
                this.send({
                    type: 'subscribe',
                    channel: channel
                });
            }
        });
    }

    /**
     * Send message to server
     */
    send(message) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('Not connected');
        }
        
        this.ws.send(JSON.stringify(message));
    }

    /**
     * Start ping timer
     */
    startPing() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
        }
        
        this.pingTimer = setInterval(() => {
            if (this.connected) {
                try {
                    this.send({ type: 'ping' });
                } catch (error) {
                    // Connection might be closing
                }
            }
        }, 30000);
    }

    /**
     * Debug logging
     */
    log(...args) {
        if (this.config.debug) {
            console.log('[RealtimeClient]', ...args);
        }
    }

    /**
     * Get connection state
     */
    isConnected() {
        return this.connected;
    }

    /**
     * Get subscribed channels
     */
    getSubscriptions() {
        return Array.from(this.subscriptions.keys());
    }
}

/**
 * Specialized clients for different data types
 */

export class MiningDataClient extends RealtimeDataClient {
    constructor(config = {}) {
        super(config);
        
        this.poolStats = null;
        this.minerStats = new Map();
    }
    
    /**
     * Subscribe to pool statistics
     */
    subscribePoolStats(callback) {
        return this.subscribe('pool:stats', (data) => {
            this.poolStats = data;
            callback(data);
        });
    }
    
    /**
     * Subscribe to block notifications
     */
    subscribeBlocks(callback) {
        return this.subscribe('pool:blocks', callback);
    }
    
    /**
     * Subscribe to miner statistics
     */
    subscribeMinerStats(minerId, callback) {
        return this.subscribe(`miner:${minerId}`, (data) => {
            this.minerStats.set(minerId, data);
            callback(data);
        });
    }
    
    /**
     * Get current pool statistics
     */
    getPoolStats() {
        return this.poolStats;
    }
    
    /**
     * Get miner statistics
     */
    getMinerStats(minerId) {
        return this.minerStats.get(minerId);
    }
}

export class TradingDataClient extends RealtimeDataClient {
    constructor(config = {}) {
        super(config);
        
        this.orderBooks = new Map();
        this.tickers = new Map();
        this.trades = new Map();
    }
    
    /**
     * Subscribe to order book updates
     */
    subscribeOrderBook(pair, callback) {
        return this.subscribe(`dex:orderbook:${pair}`, (data) => {
            this.orderBooks.set(pair, data);
            callback(data);
        });
    }
    
    /**
     * Subscribe to trade feed
     */
    subscribeTrades(pair, callback) {
        return this.subscribe(`dex:trades:${pair}`, (trade) => {
            if (!this.trades.has(pair)) {
                this.trades.set(pair, []);
            }
            
            const trades = this.trades.get(pair);
            trades.push(trade);
            
            // Keep last 100 trades
            if (trades.length > 100) {
                trades.shift();
            }
            
            callback(trade);
        });
    }
    
    /**
     * Subscribe to ticker updates
     */
    subscribeTicker(pair, callback) {
        return this.subscribe(`dex:ticker:${pair}`, (data) => {
            this.tickers.set(pair, data);
            callback(data);
        });
    }
    
    /**
     * Subscribe to all market data for a pair
     */
    subscribeMarket(pair, callbacks) {
        const unsubscribes = [];
        
        if (callbacks.orderbook) {
            unsubscribes.push(this.subscribeOrderBook(pair, callbacks.orderbook));
        }
        
        if (callbacks.trades) {
            unsubscribes.push(this.subscribeTrades(pair, callbacks.trades));
        }
        
        if (callbacks.ticker) {
            unsubscribes.push(this.subscribeTicker(pair, callbacks.ticker));
        }
        
        // Return combined unsubscribe function
        return () => {
            unsubscribes.forEach(unsub => unsub());
        };
    }
    
    /**
     * Get current order book
     */
    getOrderBook(pair) {
        return this.orderBooks.get(pair);
    }
    
    /**
     * Get recent trades
     */
    getTrades(pair) {
        return this.trades.get(pair) || [];
    }
    
    /**
     * Get current ticker
     */
    getTicker(pair) {
        return this.tickers.get(pair);
    }
}

export default RealtimeDataClient;