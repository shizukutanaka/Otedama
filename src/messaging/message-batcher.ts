/**
 * Message Batcher - Efficient batch processing of messages
 * 
 * 設計原則:
 * - Carmack: 高効率なバッチ処理
 * - Pike: シンプルなバッチング戦略
 * - Martin: 明確な責任分離
 */

import { Producer, Message } from './message-queue';
import { createLogger } from '../utils/logger';
import { EventEmitter } from 'events';

export interface BatchConfig {
    maxBatchSize: number;
    maxLatency: number; // milliseconds
    maxBytes?: number;
    compressionThreshold?: number;
}

export interface BatchMessage<T = any> {
    topic: string;
    value: T;
    key?: string;
    headers?: Record<string, string>;
    timestamp?: Date;
}

export interface BatchStats {
    batchesSent: number;
    messagesSent: number;
    bytessSent: number;
    averageBatchSize: number;
    averageLatency: number;
}

export class MessageBatcher extends EventEmitter {
    private logger = createLogger('MessageBatcher');
    private batches: Map<string, BatchMessage[]> = new Map();
    private timers: Map<string, NodeJS.Timeout> = new Map();
    private stats = {
        batchesSent: 0,
        messagesSent: 0,
        bytesSent: 0,
        totalLatency: 0
    };
    private batchStartTimes: Map<string, number> = new Map();

    constructor(
        private producer: Producer,
        private config: BatchConfig
    ) {
        super();
        
        this.config = {
            maxBatchSize: 100,
            maxLatency: 1000,
            maxBytes: 1048576, // 1MB
            compressionThreshold: 1024,
            ...config
        };
    }

    /**
     * Add a message to the batch
     */
    public async add<T>(
        topic: string,
        value: T,
        options?: {
            key?: string;
            headers?: Record<string, string>;
        }
    ): Promise<void> {
        const message: BatchMessage<T> = {
            topic,
            value,
            key: options?.key,
            headers: options?.headers,
            timestamp: new Date()
        };

        // Get or create batch for this topic
        if (!this.batches.has(topic)) {
            this.batches.set(topic, []);
            this.batchStartTimes.set(topic, Date.now());
            this.startTimer(topic);
        }

        const batch = this.batches.get(topic)!;
        batch.push(message);

        // Check if we should flush
        if (this.shouldFlush(topic, batch)) {
            await this.flush(topic);
        }
    }

    /**
     * Add multiple messages
     */
    public async addBatch<T>(messages: BatchMessage<T>[]): Promise<void> {
        // Group by topic
        const byTopic = new Map<string, BatchMessage<T>[]>();
        
        for (const message of messages) {
            if (!byTopic.has(message.topic)) {
                byTopic.set(message.topic, []);
            }
            byTopic.get(message.topic)!.push(message);
        }

        // Add to batches
        for (const [topic, topicMessages] of byTopic.entries()) {
            for (const message of topicMessages) {
                await this.add(message.topic, message.value, {
                    key: message.key,
                    headers: message.headers
                });
            }
        }
    }

    /**
     * Flush all batches
     */
    public async flushAll(): Promise<void> {
        const topics = Array.from(this.batches.keys());
        
        await Promise.all(
            topics.map(topic => this.flush(topic))
        );
    }

    /**
     * Flush a specific topic
     */
    public async flush(topic: string): Promise<void> {
        const batch = this.batches.get(topic);
        if (!batch || batch.length === 0) {
            return;
        }

        // Clear timer
        this.clearTimer(topic);

        // Remove batch
        this.batches.delete(topic);
        const startTime = this.batchStartTimes.get(topic) || Date.now();
        this.batchStartTimes.delete(topic);

        try {
            // Send batch
            await this.sendBatch(batch);

            // Update stats
            const latency = Date.now() - startTime;
            this.stats.batchesSent++;
            this.stats.messagesSent += batch.length;
            this.stats.bytesSent += this.calculateBatchSize(batch);
            this.stats.totalLatency += latency;

            this.emit('batch:sent', {
                topic,
                size: batch.length,
                latency,
                bytes: this.calculateBatchSize(batch)
            });

            this.logger.debug(`Sent batch of ${batch.length} messages to ${topic}`);

        } catch (error) {
            this.logger.error(`Failed to send batch to ${topic}`, error);
            
            this.emit('batch:error', {
                topic,
                size: batch.length,
                error
            });

            // Re-add messages to batch for retry
            if (!this.batches.has(topic)) {
                this.batches.set(topic, []);
                this.batchStartTimes.set(topic, Date.now());
                this.startTimer(topic);
            }
            this.batches.get(topic)!.push(...batch);
            
            throw error;
        }
    }

    /**
     * Get batcher statistics
     */
    public getStats(): BatchStats {
        const avgBatchSize = this.stats.batchesSent > 0 
            ? this.stats.messagesSent / this.stats.batchesSent 
            : 0;
            
        const avgLatency = this.stats.batchesSent > 0
            ? this.stats.totalLatency / this.stats.batchesSent
            : 0;

        return {
            batchesSent: this.stats.batchesSent,
            messagesSent: this.stats.messagesSent,
            bytessSent: this.stats.bytesSent,
            averageBatchSize: avgBatchSize,
            averageLatency: avgLatency
        };
    }

    /**
     * Get current batch sizes
     */
    public getBatchSizes(): Record<string, number> {
        const sizes: Record<string, number> = {};
        
        for (const [topic, batch] of this.batches.entries()) {
            sizes[topic] = batch.length;
        }
        
        return sizes;
    }

    /**
     * Close the batcher
     */
    public async close(): Promise<void> {
        // Clear all timers
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();

        // Flush remaining batches
        await this.flushAll();

        this.logger.info('Message batcher closed', this.getStats());
    }

    private shouldFlush(topic: string, batch: BatchMessage[]): boolean {
        // Check batch size
        if (batch.length >= this.config.maxBatchSize) {
            return true;
        }

        // Check batch bytes
        if (this.config.maxBytes) {
            const bytes = this.calculateBatchSize(batch);
            if (bytes >= this.config.maxBytes) {
                return true;
            }
        }

        return false;
    }

    private startTimer(topic: string): void {
        const timer = setTimeout(async () => {
            await this.flush(topic);
        }, this.config.maxLatency);

        this.timers.set(topic, timer);
    }

    private clearTimer(topic: string): void {
        const timer = this.timers.get(topic);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(topic);
        }
    }

    private async sendBatch(batch: BatchMessage[]): Promise<void> {
        const messages = batch.map(msg => ({
            topic: msg.topic,
            value: msg.value,
            key: msg.key,
            headers: {
                ...msg.headers,
                'x-batch-size': batch.length.toString(),
                'x-batch-timestamp': new Date().toISOString()
            }
        }));

        await this.producer.sendBatch(messages);
    }

    private calculateBatchSize(batch: BatchMessage[]): number {
        let size = 0;
        
        for (const message of batch) {
            size += JSON.stringify(message.value).length;
            if (message.key) {
                size += message.key.length;
            }
            if (message.headers) {
                size += JSON.stringify(message.headers).length;
            }
        }
        
        return size;
    }
}

/**
 * Adaptive Message Batcher
 * Automatically adjusts batch size and latency based on throughput
 */
export class AdaptiveMessageBatcher extends MessageBatcher {
    private throughputHistory: number[] = [];
    private latencyHistory: number[] = [];
    private adjustmentInterval?: NodeJS.Timeout;

    constructor(
        producer: Producer,
        config: BatchConfig,
        private adaptiveConfig = {
            adjustmentInterval: 10000, // 10 seconds
            targetLatency: 100, // milliseconds
            minBatchSize: 10,
            maxBatchSize: 1000
        }
    ) {
        super(producer, config);
        this.startAdaptation();
    }

    private startAdaptation(): void {
        this.adjustmentInterval = setInterval(() => {
            this.adjustBatchingParameters();
        }, this.adaptiveConfig.adjustmentInterval);
    }

    private adjustBatchingParameters(): void {
        const stats = this.getStats();
        
        // Record current metrics
        if (stats.batchesSent > 0) {
            const throughput = stats.messagesSent / (this.adaptiveConfig.adjustmentInterval / 1000);
            this.throughputHistory.push(throughput);
            this.latencyHistory.push(stats.averageLatency);

            // Keep only recent history
            if (this.throughputHistory.length > 10) {
                this.throughputHistory.shift();
                this.latencyHistory.shift();
            }

            // Calculate trends
            const avgThroughput = this.average(this.throughputHistory);
            const avgLatency = this.average(this.latencyHistory);

            // Adjust batch size
            if (avgLatency > this.adaptiveConfig.targetLatency * 1.5) {
                // Latency too high, reduce batch size
                this.config.maxBatchSize = Math.max(
                    this.adaptiveConfig.minBatchSize,
                    Math.floor(this.config.maxBatchSize * 0.8)
                );
            } else if (avgLatency < this.adaptiveConfig.targetLatency * 0.5) {
                // Latency low, can increase batch size
                this.config.maxBatchSize = Math.min(
                    this.adaptiveConfig.maxBatchSize,
                    Math.floor(this.config.maxBatchSize * 1.2)
                );
            }

            // Adjust max latency
            if (avgThroughput < 100) {
                // Low throughput, can afford higher latency
                this.config.maxLatency = Math.min(5000, this.config.maxLatency * 1.1);
            } else if (avgThroughput > 1000) {
                // High throughput, reduce latency
                this.config.maxLatency = Math.max(10, this.config.maxLatency * 0.9);
            }

            this.logger.debug('Adjusted batching parameters', {
                maxBatchSize: this.config.maxBatchSize,
                maxLatency: this.config.maxLatency,
                avgThroughput,
                avgLatency
            });

            this.emit('parameters:adjusted', {
                maxBatchSize: this.config.maxBatchSize,
                maxLatency: this.config.maxLatency,
                metrics: {
                    throughput: avgThroughput,
                    latency: avgLatency
                }
            });
        }
    }

    private average(values: number[]): number {
        if (values.length === 0) return 0;
        return values.reduce((a, b) => a + b, 0) / values.length;
    }

    public async close(): Promise<void> {
        if (this.adjustmentInterval) {
            clearInterval(this.adjustmentInterval);
        }
        await super.close();
    }
}

/**
 * Helper function to create a batcher with common configurations
 */
export function createMessageBatcher(
    producer: Producer,
    preset: 'low-latency' | 'high-throughput' | 'balanced' | 'adaptive' = 'balanced'
): MessageBatcher {
    const configs = {
        'low-latency': {
            maxBatchSize: 10,
            maxLatency: 10,
            maxBytes: 65536 // 64KB
        },
        'high-throughput': {
            maxBatchSize: 1000,
            maxLatency: 1000,
            maxBytes: 5242880 // 5MB
        },
        'balanced': {
            maxBatchSize: 100,
            maxLatency: 100,
            maxBytes: 1048576 // 1MB
        }
    };

    if (preset === 'adaptive') {
        return new AdaptiveMessageBatcher(producer, configs.balanced);
    }

    return new MessageBatcher(producer, configs[preset]);
}
