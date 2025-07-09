/**
 * Message Queue Abstraction Layer
 * 
 * 設計原則:
 * - Pike: シンプルで統一されたインターフェース
 * - Martin: アダプターパターンで実装を切り替え可能
 * - Carmack: 高スループット、低レイテンシー
 */

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';

export interface Message<T = any> {
    id: string;
    topic: string;
    key?: string;
    value: T;
    headers?: Record<string, string>;
    timestamp: Date;
    partition?: number;
    offset?: number;
}

export interface MessageEnvelope<T = any> {
    message: Message<T>;
    ack: () => Promise<void>;
    nack: (requeue?: boolean) => Promise<void>;
    retryCount?: number;
}

export interface ProducerConfig {
    clientId?: string;
    acks?: 'all' | 'leader' | 'none';
    retries?: number;
    batchSize?: number;
    linger?: number;
    compressionType?: 'none' | 'gzip' | 'snappy' | 'lz4';
}

export interface ConsumerConfig {
    groupId: string;
    clientId?: string;
    autoCommit?: boolean;
    autoCommitInterval?: number;
    fromBeginning?: boolean;
    maxBatchSize?: number;
    sessionTimeout?: number;
    heartbeatInterval?: number;
}

export interface QueueConfig {
    type: 'rabbitmq' | 'kafka' | 'memory';
    connectionString?: string;
    hosts?: string[];
    options?: Record<string, any>;
}

export abstract class MessageQueue extends EventEmitter {
    protected logger = createLogger('MessageQueue');
    protected connected = false;

    constructor(protected config: QueueConfig) {
        super();
    }

    /**
     * Connect to message queue
     */
    public abstract connect(): Promise<void>;

    /**
     * Disconnect from message queue
     */
    public abstract disconnect(): Promise<void>;

    /**
     * Create a producer
     */
    public abstract createProducer(config?: ProducerConfig): Promise<Producer>;

    /**
     * Create a consumer
     */
    public abstract createConsumer(topics: string[], config: ConsumerConfig): Promise<Consumer>;

    /**
     * Create a topic/queue
     */
    public abstract createTopic(name: string, options?: any): Promise<void>;

    /**
     * Delete a topic/queue
     */
    public abstract deleteTopic(name: string): Promise<void>;

    /**
     * Get queue/topic stats
     */
    public abstract getStats(topic?: string): Promise<QueueStats>;

    /**
     * Check if connected
     */
    public isConnected(): boolean {
        return this.connected;
    }
}

export abstract class Producer {
    protected logger = createLogger('Producer');

    /**
     * Send a single message
     */
    public abstract send<T>(topic: string, message: T, key?: string): Promise<void>;

    /**
     * Send multiple messages
     */
    public abstract sendBatch<T>(messages: Array<{
        topic: string;
        value: T;
        key?: string;
        headers?: Record<string, string>;
    }>): Promise<void>;

    /**
     * Close producer
     */
    public abstract close(): Promise<void>;
}

export abstract class Consumer {
    protected logger = createLogger('Consumer');
    protected running = false;

    /**
     * Start consuming messages
     */
    public abstract start(handler: (message: MessageEnvelope) => Promise<void>): Promise<void>;

    /**
     * Stop consuming messages
     */
    public abstract stop(): Promise<void>;

    /**
     * Pause consumption
     */
    public abstract pause(): Promise<void>;

    /**
     * Resume consumption
     */
    public abstract resume(): Promise<void>;

    /**
     * Seek to specific offset/position
     */
    public abstract seek(topic: string, partition: number, offset: number): Promise<void>;

    /**
     * Get consumer lag
     */
    public abstract getLag(): Promise<ConsumerLag[]>;

    /**
     * Check if running
     */
    public isRunning(): boolean {
        return this.running;
    }
}

export interface QueueStats {
    messages: number;
    consumers: number;
    publishRate: number;
    consumeRate: number;
    lag?: number;
}

export interface ConsumerLag {
    topic: string;
    partition: number;
    currentOffset: number;
    logEndOffset: number;
    lag: number;
}

// Factory function
export function createMessageQueue(config: QueueConfig): MessageQueue {
    switch (config.type) {
        case 'rabbitmq':
            const { RabbitMQAdapter } = require('./rabbitmq-adapter');
            return new RabbitMQAdapter(config);
        case 'kafka':
            const { KafkaAdapter } = require('./kafka-adapter');
            return new KafkaAdapter(config);
        case 'memory':
            const { MemoryQueueAdapter } = require('./memory-queue-adapter');
            return new MemoryQueueAdapter(config);
        default:
            throw new Error(`Unknown message queue type: ${config.type}`);
    }
}

// Helper functions
export function createMessage<T>(
    topic: string,
    value: T,
    options?: {
        key?: string;
        headers?: Record<string, string>;
        partition?: number;
    }
): Message<T> {
    return {
        id: generateMessageId(),
        topic,
        value,
        key: options?.key,
        headers: options?.headers,
        partition: options?.partition,
        timestamp: new Date()
    };
}

function generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Topic definitions for the mining pool
export const TOPICS = {
    // Share processing
    SHARES_SUBMITTED: 'shares.submitted',
    SHARES_VALIDATED: 'shares.validated',
    SHARES_ACCEPTED: 'shares.accepted',
    SHARES_REJECTED: 'shares.rejected',
    
    // Block processing
    BLOCKS_FOUND: 'blocks.found',
    BLOCKS_CONFIRMED: 'blocks.confirmed',
    BLOCKS_ORPHANED: 'blocks.orphaned',
    
    // Payment processing
    PAYMENTS_CALCULATED: 'payments.calculated',
    PAYMENTS_QUEUED: 'payments.queued',
    PAYMENTS_PROCESSING: 'payments.processing',
    PAYMENTS_SENT: 'payments.sent',
    PAYMENTS_CONFIRMED: 'payments.confirmed',
    PAYMENTS_FAILED: 'payments.failed',
    
    // Miner events
    MINERS_CONNECTED: 'miners.connected',
    MINERS_DISCONNECTED: 'miners.disconnected',
    MINERS_STATS: 'miners.stats',
    
    // System events
    SYSTEM_HEALTH: 'system.health',
    SYSTEM_ALERTS: 'system.alerts',
    SYSTEM_METRICS: 'system.metrics'
} as const;

// Message schemas for type safety
export interface ShareSubmittedMessage {
    shareId: string;
    minerId: string;
    workerId: string;
    jobId: string;
    nonce: string;
    extraNonce: string;
    difficulty: number;
    timestamp: Date;
}

export interface BlockFoundMessage {
    height: number;
    hash: string;
    previousHash: string;
    difficulty: number;
    nonce: number;
    timestamp: Date;
    foundBy: string;
    reward: number;
}

export interface PaymentCalculatedMessage {
    paymentId: string;
    blockHeight: number;
    miners: Array<{
        minerId: string;
        address: string;
        shares: number;
        amount: number;
    }>;
    totalAmount: number;
    timestamp: Date;
}

export interface MinerStatsMessage {
    minerId: string;
    hashrate: number;
    shares: {
        accepted: number;
        rejected: number;
        stale: number;
    };
    workers: number;
    lastShareTime: Date;
    uptime: number;
}
