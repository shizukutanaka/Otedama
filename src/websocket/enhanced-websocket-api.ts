/**
 * Enhanced WebSocket API - Advanced Real-time Features
 * 
 * 設計原則（John Carmack風）:
 * - 低レイテンシーを最優先
 * - メッセージキューで信頼性確保
 * - 効率的なメモリ使用
 */

import { WebSocketAPI, WebSocketMessage, WebSocketClient, EventChannel } from './websocket-api';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';
import * as zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export interface MessageQueueItem {
    id: string;
    priority: number;
    message: WebSocketMessage;
    timestamp: Date;
    retries: number;
    maxRetries: number;
}

export interface MessageHistory {
    channel: string;
    messages: WebSocketMessage[];
    maxSize: number;
    ttl: number; // Time to live in seconds
}

export interface ReconnectionData {
    clientId: string;
    userId?: string;
    subscriptions: string[];
    lastMessageId?: string;
    disconnectedAt: Date;
}

export interface BatchMessage {
    messages: WebSocketMessage[];
    compressed: boolean;
    timestamp: Date;
}

export interface CustomEventHandler {
    event: string;
    handler: (client: WebSocketClient, data: any) => Promise<void>;
    requiresAuth: boolean;
}

export class EnhancedWebSocketAPI extends EventEmitter {
    private baseAPI: WebSocketAPI;
    private logger = createLogger('EnhancedWebSocketAPI');
    
    // Message queue for reliable delivery
    private messageQueue: Map<string, MessageQueueItem[]> = new Map();
    private queueProcessor: NodeJS.Timeout | null = null;
    
    // Message history for replay
    private messageHistory: Map<string, MessageHistory> = new Map();
    private historyCleanupInterval: NodeJS.Timeout | null = null;
    
    // Reconnection support
    private reconnectionData: Map<string, ReconnectionData> = new Map();
    private reconnectionTTL = 300000; // 5 minutes
    
    // Custom event handlers
    private customHandlers: Map<string, CustomEventHandler> = new Map();
    
    // Configuration
    private config = {
        enableCompression: true,
        compressionThreshold: 1024, // bytes
        messageHistorySize: 100,
        messageHistoryTTL: 3600, // 1 hour
        queueProcessInterval: 100, // ms
        maxQueueSize: 10000,
        enableMessageDeduplication: true,
        batchMessageMaxSize: 50,
        priorityLevels: {
            CRITICAL: 0,
            HIGH: 1,
            NORMAL: 2,
            LOW: 3
        }
    };

    constructor(baseAPI: WebSocketAPI) {
        super();
        this.baseAPI = baseAPI;
        this.initialize();
    }

    private initialize(): void {
        // Set up message queue processor
        this.queueProcessor = setInterval(() => {
            this.processMessageQueue();
        }, this.config.queueProcessInterval);

        // Set up history cleanup
        this.historyCleanupInterval = setInterval(() => {
            this.cleanupMessageHistory();
        }, 60000); // Every minute

        // Listen to base API events
        this.baseAPI.on('clientDisconnected', ({ client }) => {
            this.handleClientDisconnection(client);
        });

        this.baseAPI.on('clientAuthenticated', (client) => {
            this.handleClientReconnection(client);
        });
    }

    /**
     * Send message with priority and retry logic
     */
    public async sendWithPriority(
        clientId: string,
        message: WebSocketMessage,
        priority: number = this.config.priorityLevels.NORMAL,
        maxRetries: number = 3
    ): Promise<void> {
        const queueItem: MessageQueueItem = {
            id: `${clientId}:${message.id}`,
            priority,
            message,
            timestamp: new Date(),
            retries: 0,
            maxRetries
        };

        // Add to client's queue
        if (!this.messageQueue.has(clientId)) {
            this.messageQueue.set(clientId, []);
        }

        const queue = this.messageQueue.get(clientId)!;
        
        // Insert based on priority
        const insertIndex = queue.findIndex(item => item.priority > priority);
        if (insertIndex === -1) {
            queue.push(queueItem);
        } else {
            queue.splice(insertIndex, 0, queueItem);
        }

        // Enforce queue size limit
        if (queue.length > this.config.maxQueueSize) {
            queue.splice(this.config.maxQueueSize);
        }
    }

    /**
     * Send batch of messages
     */
    public async sendBatch(
        clientId: string,
        messages: WebSocketMessage[],
        compress: boolean = true
    ): Promise<void> {
        const client = this.getClient(clientId);
        if (!client) {
            throw new Error(`Client ${clientId} not found`);
        }

        // Split into chunks if necessary
        const chunks = this.chunkMessages(messages, this.config.batchMessageMaxSize);

        for (const chunk of chunks) {
            const batchMessage: BatchMessage = {
                messages: chunk,
                compressed: false,
                timestamp: new Date()
            };

            let payload = JSON.stringify(batchMessage);

            // Compress if enabled and beneficial
            if (compress && this.config.enableCompression && payload.length > this.config.compressionThreshold) {
                const compressed = await gzip(payload);
                if (compressed.length < payload.length) {
                    payload = compressed.toString('base64');
                    batchMessage.compressed = true;
                }
            }

            const message: WebSocketMessage = {
                id: `batch-${Date.now()}`,
                type: 'event',
                timestamp: new Date(),
                data: {
                    type: 'batch',
                    payload,
                    compressed: batchMessage.compressed
                }
            };

            await this.sendWithPriority(clientId, message, this.config.priorityLevels.HIGH);
        }
    }

    /**
     * Broadcast with history recording
     */
    public broadcastWithHistory(
        channel: EventChannel,
        data: any,
        recordHistory: boolean = true
    ): void {
        const message: WebSocketMessage = {
            id: `${Date.now()}-${Math.random()}`,
            type: 'event',
            timestamp: new Date(),
            data: {
                channel,
                payload: data
            }
        };

        // Record in history if enabled
        if (recordHistory) {
            this.addToHistory(channel, message);
        }

        // Broadcast via base API
        this.baseAPI.broadcast(channel, data);
    }

    /**
     * Get message history for a channel
     */
    public getHistory(
        channel: string,
        limit: number = 50,
        since?: Date
    ): WebSocketMessage[] {
        const history = this.messageHistory.get(channel);
        if (!history) {
            return [];
        }

        let messages = history.messages;

        // Filter by timestamp if provided
        if (since) {
            messages = messages.filter(msg => msg.timestamp > since);
        }

        // Return limited results
        return messages.slice(-limit);
    }

    /**
     * Register custom event handler
     */
    public registerHandler(
        event: string,
        handler: (client: WebSocketClient, data: any) => Promise<void>,
        requiresAuth: boolean = true
    ): void {
        this.customHandlers.set(event, {
            event,
            handler,
            requiresAuth
        });

        this.logger.info(`Registered custom handler for event: ${event}`);
    }

    /**
     * Handle custom event
     */
    public async handleCustomEvent(
        client: WebSocketClient,
        event: string,
        data: any
    ): Promise<void> {
        const handler = this.customHandlers.get(event);
        if (!handler) {
            throw new Error(`No handler registered for event: ${event}`);
        }

        if (handler.requiresAuth && !client.isAuthenticated) {
            throw new Error('Authentication required for this event');
        }

        try {
            await handler.handler(client, data);
        } catch (error) {
            this.logger.error(`Error handling custom event ${event}:`, error);
            throw error;
        }
    }

    /**
     * Enable message replay for reconnecting clients
     */
    public async replayMessages(
        clientId: string,
        channels: string[],
        since: Date
    ): Promise<void> {
        const client = this.getClient(clientId);
        if (!client) {
            throw new Error(`Client ${clientId} not found`);
        }

        const allMessages: WebSocketMessage[] = [];

        for (const channel of channels) {
            const history = this.getHistory(channel, 100, since);
            allMessages.push(...history);
        }

        // Sort by timestamp
        allMessages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        // Send as batch
        if (allMessages.length > 0) {
            await this.sendBatch(clientId, allMessages);
        }
    }

    /**
     * Get connection statistics
     */
    public getEnhancedStats(): any {
        const baseStats = this.baseAPI.getStats();
        
        const queueStats = {
            totalQueued: 0,
            byPriority: {} as Record<number, number>
        };

        for (const queue of this.messageQueue.values()) {
            queueStats.totalQueued += queue.length;
            for (const item of queue) {
                queueStats.byPriority[item.priority] = 
                    (queueStats.byPriority[item.priority] || 0) + 1;
            }
        }

        const historyStats = {
            channels: this.messageHistory.size,
            totalMessages: Array.from(this.messageHistory.values())
                .reduce((sum, h) => sum + h.messages.length, 0)
        };

        return {
            ...baseStats,
            queue: queueStats,
            history: historyStats,
            reconnections: this.reconnectionData.size,
            customHandlers: this.customHandlers.size
        };
    }

    /**
     * Process message queue
     */
    private async processMessageQueue(): Promise<void> {
        for (const [clientId, queue] of this.messageQueue.entries()) {
            if (queue.length === 0) continue;

            const client = this.getClient(clientId);
            if (!client) {
                // Client disconnected, save messages for reconnection
                continue;
            }

            // Process messages in priority order
            while (queue.length > 0) {
                const item = queue[0];
                
                try {
                    // Send message
                    await this.sendMessageToClient(client, item.message);
                    
                    // Remove from queue on success
                    queue.shift();
                } catch (error) {
                    // Retry logic
                    item.retries++;
                    
                    if (item.retries >= item.maxRetries) {
                        this.logger.error(`Failed to deliver message after ${item.maxRetries} retries`, {
                            clientId,
                            messageId: item.message.id
                        });
                        queue.shift(); // Remove failed message
                        
                        this.emit('messageDeliveryFailed', {
                            clientId,
                            message: item.message,
                            error
                        });
                    }
                    
                    break; // Try again in next cycle
                }
            }
        }
    }

    /**
     * Add message to history
     */
    private addToHistory(channel: string, message: WebSocketMessage): void {
        if (!this.messageHistory.has(channel)) {
            this.messageHistory.set(channel, {
                channel,
                messages: [],
                maxSize: this.config.messageHistorySize,
                ttl: this.config.messageHistoryTTL
            });
        }

        const history = this.messageHistory.get(channel)!;
        history.messages.push(message);

        // Enforce size limit
        if (history.messages.length > history.maxSize) {
            history.messages = history.messages.slice(-history.maxSize);
        }
    }

    /**
     * Clean up old messages from history
     */
    private cleanupMessageHistory(): void {
        const now = Date.now();

        for (const [channel, history] of this.messageHistory.entries()) {
            // Remove messages older than TTL
            history.messages = history.messages.filter(msg => {
                const age = now - msg.timestamp.getTime();
                return age < history.ttl * 1000;
            });

            // Remove empty histories
            if (history.messages.length === 0) {
                this.messageHistory.delete(channel);
            }
        }
    }

    /**
     * Handle client disconnection
     */
    private handleClientDisconnection(client: WebSocketClient): void {
        if (client.isAuthenticated && client.userId) {
            // Save reconnection data
            this.reconnectionData.set(client.userId, {
                clientId: client.id,
                userId: client.userId,
                subscriptions: Array.from(client.subscriptions),
                disconnectedAt: new Date()
            });

            // Clean up old reconnection data
            setTimeout(() => {
                this.reconnectionData.delete(client.userId!);
            }, this.reconnectionTTL);
        }

        // Clean up message queue
        this.messageQueue.delete(client.id);
    }

    /**
     * Handle client reconnection
     */
    private async handleClientReconnection(client: WebSocketClient): Promise<void> {
        if (!client.userId) return;

        const reconnData = this.reconnectionData.get(client.userId);
        if (!reconnData) return;

        this.logger.info(`Client ${client.id} reconnected as ${client.userId}`);

        // Restore subscriptions
        for (const subscriptionId of reconnData.subscriptions) {
            // Re-subscribe logic would go here
        }

        // Replay missed messages
        const channels = this.getSubscribedChannels(client);
        if (channels.length > 0) {
            await this.replayMessages(
                client.id,
                channels,
                reconnData.disconnectedAt
            );
        }

        // Clean up reconnection data
        this.reconnectionData.delete(client.userId);
    }

    /**
     * Helper methods
     */
    private getClient(clientId: string): WebSocketClient | undefined {
        return this.baseAPI.getConnectedClients()
            .find(client => client.id === clientId);
    }

    private async sendMessageToClient(
        client: WebSocketClient,
        message: WebSocketMessage
    ): Promise<void> {
        // This would need to be implemented in the base API
        // For now, we'll use a workaround
        return new Promise((resolve, reject) => {
            try {
                // @ts-ignore - Accessing private method
                this.baseAPI.sendMessage(client, message);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    }

    private getSubscribedChannels(client: WebSocketClient): string[] {
        // Extract channels from client subscriptions
        // This would need proper implementation based on subscription structure
        return [];
    }

    private chunkMessages(messages: WebSocketMessage[], chunkSize: number): WebSocketMessage[][] {
        const chunks: WebSocketMessage[][] = [];
        for (let i = 0; i < messages.length; i += chunkSize) {
            chunks.push(messages.slice(i, i + chunkSize));
        }
        return chunks;
    }

    /**
     * Cleanup
     */
    public async stop(): Promise<void> {
        if (this.queueProcessor) {
            clearInterval(this.queueProcessor);
            this.queueProcessor = null;
        }

        if (this.historyCleanupInterval) {
            clearInterval(this.historyCleanupInterval);
            this.historyCleanupInterval = null;
        }

        this.messageQueue.clear();
        this.messageHistory.clear();
        this.reconnectionData.clear();
        this.customHandlers.clear();

        this.logger.info('Enhanced WebSocket API stopped');
    }
}

// Export priority levels for external use
export const MessagePriority = {
    CRITICAL: 0,
    HIGH: 1,
    NORMAL: 2,
    LOW: 3
} as const;
