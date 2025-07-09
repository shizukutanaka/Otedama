/**
 * WebSocket API Client SDK
 * 
 * 設計原則（Rob Pike風）:
 * - シンプルで使いやすいインターフェース
 * - 自動再接続とエラーハンドリング
 * - TypeScript型安全性
 */

import { EventEmitter } from 'events';

export interface WebSocketClientConfig {
    url: string;
    token?: string;
    autoReconnect?: boolean;
    reconnectInterval?: number;
    maxReconnectAttempts?: number;
    heartbeatInterval?: number;
    enableCompression?: boolean;
    debug?: boolean;
}

export interface SubscriptionOptions {
    channel: string;
    filters?: Array<{
        field: string;
        operator: 'equals' | 'contains' | 'greater_than' | 'less_than';
        value: any;
    }>;
}

export type MessageHandler = (data: any) => void;
export type ErrorHandler = (error: Error) => void;

export class OtedamaWebSocketClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private config: Required<WebSocketClientConfig>;
    private subscriptions: Map<string, string> = new Map();
    private messageHandlers: Map<string, MessageHandler[]> = new Map();
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private isAuthenticated = false;
    private messageQueue: any[] = [];

    constructor(config: WebSocketClientConfig) {
        super();
        
        this.config = {
            url: config.url,
            token: config.token || '',
            autoReconnect: config.autoReconnect ?? true,
            reconnectInterval: config.reconnectInterval ?? 5000,
            maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
            heartbeatInterval: config.heartbeatInterval ?? 30000,
            enableCompression: config.enableCompression ?? true,
            debug: config.debug ?? false
        };
    }

    /**
     * Connect to WebSocket server
     */
    public async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.config.url);
                
                this.ws.onopen = () => {
                    this.log('Connected to WebSocket server');
                    this.reconnectAttempts = 0;
                    this.emit('connected');
                    
                    // Authenticate if token provided
                    if (this.config.token) {
                        this.authenticate();
                    }
                    
                    // Start heartbeat
                    this.startHeartbeat();
                    
                    // Process queued messages
                    this.processMessageQueue();
                    
                    resolve();
                };

                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                this.ws.onerror = (error) => {
                    this.log('WebSocket error:', error);
                    this.emit('error', error);
                };

                this.ws.onclose = (event) => {
                    this.log('WebSocket closed:', event.code, event.reason);
                    this.cleanup();
                    this.emit('disconnected', { code: event.code, reason: event.reason });
                    
                    // Auto reconnect if enabled
                    if (this.config.autoReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
                        this.scheduleReconnect();
                    }
                };

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Disconnect from WebSocket server
     */
    public disconnect(): void {
        this.config.autoReconnect = false;
        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
        }
        this.cleanup();
    }

    /**
     * Authenticate with token
     */
    public async authenticate(token?: string): Promise<void> {
        if (token) {
            this.config.token = token;
        }

        return new Promise((resolve, reject) => {
            const authHandler = (message: any) => {
                if (message.type === 'auth_success') {
                    this.isAuthenticated = true;
                    this.emit('authenticated', message.data);
                    resolve();
                } else if (message.type === 'auth_error') {
                    reject(new Error(message.error || 'Authentication failed'));
                }
            };

            this.once('message', authHandler);

            this.send({
                type: 'auth',
                data: { token: this.config.token }
            });

            // Timeout
            setTimeout(() => {
                this.removeListener('message', authHandler);
                reject(new Error('Authentication timeout'));
            }, 10000);
        });
    }

    /**
     * Subscribe to channel
     */
    public async subscribe(options: SubscriptionOptions): Promise<string> {
        return new Promise((resolve, reject) => {
            const subscribeHandler = (message: any) => {
                if (message.type === 'subscription_success' && message.data.channel === options.channel) {
                    const subscriptionId = message.data.subscriptionId;
                    this.subscriptions.set(options.channel, subscriptionId);
                    this.emit('subscribed', { channel: options.channel, subscriptionId });
                    resolve(subscriptionId);
                } else if (message.type === 'subscription_error') {
                    reject(new Error(message.error || 'Subscription failed'));
                }
            };

            this.once('message', subscribeHandler);

            this.send({
                type: 'subscribe',
                data: options
            });

            // Timeout
            setTimeout(() => {
                this.removeListener('message', subscribeHandler);
                reject(new Error('Subscription timeout'));
            }, 10000);
        });
    }

    /**
     * Unsubscribe from channel
     */
    public async unsubscribe(channel: string): Promise<void> {
        const subscriptionId = this.subscriptions.get(channel);
        if (!subscriptionId) {
            throw new Error(`Not subscribed to channel: ${channel}`);
        }

        this.send({
            type: 'unsubscribe',
            data: { subscriptionId, channel }
        });

        this.subscriptions.delete(channel);
        this.messageHandlers.delete(channel);
        this.emit('unsubscribed', { channel });
    }

    /**
     * Add message handler for channel
     */
    public on(channel: string, handler: MessageHandler): this {
        if (!this.messageHandlers.has(channel)) {
            this.messageHandlers.set(channel, []);
        }
        this.messageHandlers.get(channel)!.push(handler);
        return this;
    }

    /**
     * Remove message handler
     */
    public off(channel: string, handler?: MessageHandler): this {
        if (!handler) {
            this.messageHandlers.delete(channel);
        } else {
            const handlers = this.messageHandlers.get(channel);
            if (handlers) {
                const index = handlers.indexOf(handler);
                if (index !== -1) {
                    handlers.splice(index, 1);
                }
            }
        }
        return this;
    }

    /**
     * Send custom message
     */
    public send(message: any): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                id: this.generateId(),
                timestamp: new Date().toISOString(),
                ...message
            }));
        } else {
            // Queue message if not connected
            this.messageQueue.push(message);
        }
    }

    /**
     * Check if connected
     */
    public isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * Get connection state
     */
    public getState(): {
        connected: boolean;
        authenticated: boolean;
        subscriptions: string[];
        reconnectAttempts: number;
    } {
        return {
            connected: this.isConnected(),
            authenticated: this.isAuthenticated,
            subscriptions: Array.from(this.subscriptions.keys()),
            reconnectAttempts: this.reconnectAttempts
        };
    }

    // Private methods

    private handleMessage(data: string): void {
        try {
            const message = JSON.parse(data);
            this.log('Received message:', message.type);
            
            // Emit raw message event
            this.emit('message', message);

            // Handle specific message types
            switch (message.type) {
                case 'ping':
                    this.send({ type: 'pong', data: { messageId: message.id } });
                    break;
                    
                case 'event':
                    this.handleEventMessage(message);
                    break;
                    
                case 'error':
                    this.emit('error', new Error(message.error));
                    break;
                    
                case 'rate_limit':
                    this.emit('rateLimit', message.data);
                    break;
            }

        } catch (error) {
            this.log('Error parsing message:', error);
            this.emit('error', error);
        }
    }

    private handleEventMessage(message: any): void {
        if (message.data && message.data.channel) {
            const channel = message.data.channel;
            const handlers = this.messageHandlers.get(channel);
            
            if (handlers) {
                handlers.forEach(handler => {
                    try {
                        handler(message.data.payload);
                    } catch (error) {
                        this.emit('error', error);
                    }
                });
            }
            
            // Emit channel-specific event
            this.emit(`channel:${channel}`, message.data.payload);
        }

        // Handle batch messages
        if (message.data && message.data.type === 'batch') {
            this.handleBatchMessage(message.data);
        }
    }

    private async handleBatchMessage(data: any): Promise<void> {
        try {
            let payload = data.payload;
            
            // Decompress if needed
            if (data.compressed) {
                // In browser environment, would need different decompression
                this.log('Compressed batch message received');
            }
            
            const batch = JSON.parse(payload);
            if (batch.messages && Array.isArray(batch.messages)) {
                batch.messages.forEach((msg: any) => this.handleMessage(JSON.stringify(msg)));
            }
        } catch (error) {
            this.emit('error', error);
        }
    }

    private startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            if (this.isConnected()) {
                this.send({ type: 'ping' });
            }
        }, this.config.heartbeatInterval);
    }

    private scheduleReconnect(): void {
        this.reconnectAttempts++;
        this.log(`Scheduling reconnect attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts}`);
        
        this.reconnectTimer = setTimeout(() => {
            this.emit('reconnecting', { attempt: this.reconnectAttempts });
            this.connect().catch(error => {
                this.log('Reconnect failed:', error);
            });
        }, this.config.reconnectInterval);
    }

    private processMessageQueue(): void {
        while (this.messageQueue.length > 0 && this.isConnected()) {
            const message = this.messageQueue.shift();
            this.send(message);
        }
    }

    private cleanup(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        this.isAuthenticated = false;
        this.ws = null;
    }

    private generateId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private log(...args: any[]): void {
        if (this.config.debug) {
            console.log('[OtedamaWS]', ...args);
        }
    }
}

// Channel types for type safety
export const Channels = {
    POOL_STATS: 'pool.stats',
    POOL_BLOCKS: 'pool.blocks',
    POOL_SHARES: 'pool.shares',
    POOL_PAYOUTS: 'pool.payouts',
    MINER_STATS: 'miner.stats',
    MINER_WORKERS: 'miner.workers',
    SYSTEM_ALERTS: 'system.alerts',
    SYSTEM_STATUS: 'system.status'
} as const;

// Helper function for creating typed client
export function createOtedamaWebSocketClient(config: WebSocketClientConfig): OtedamaWebSocketClient {
    return new OtedamaWebSocketClient(config);
}

// Example usage
/*
const client = createOtedamaWebSocketClient({
    url: 'ws://localhost:3001',
    token: 'your-jwt-token',
    debug: true
});

// Connect
await client.connect();

// Subscribe to pool stats
await client.subscribe({
    channel: Channels.POOL_STATS,
    filters: [
        {
            field: 'hashrate',
            operator: 'greater_than',
            value: 1000000
        }
    ]
});

// Handle pool stats updates
client.on(Channels.POOL_STATS, (stats) => {
    console.log('Pool stats update:', stats);
});

// Subscribe to miner-specific stats
await client.subscribe({
    channel: Channels.MINER_STATS,
    filters: [
        {
            field: 'minerId',
            operator: 'equals',
            value: 'your-miner-id'
        }
    ]
});

// Handle errors
client.on('error', (error) => {
    console.error('WebSocket error:', error);
});

// Handle reconnection
client.on('reconnecting', ({ attempt }) => {
    console.log(`Reconnecting... attempt ${attempt}`);
});
*/
