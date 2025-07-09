/**
 * In-Memory Message Queue Adapter
 * For development and testing
 */

import { 
    MessageQueue, 
    Producer, 
    Consumer, 
    Message, 
    MessageEnvelope,
    ProducerConfig,
    ConsumerConfig,
    QueueStats,
    ConsumerLag,
    QueueConfig
} from './message-queue';
import { EventEmitter } from 'events';

interface Topic {
    name: string;
    messages: Message[];
    consumers: Set<MemoryConsumer>;
    stats: {
        publishCount: number;
        consumeCount: number;
        lastPublish?: Date;
        lastConsume?: Date;
    };
}

export class MemoryQueueAdapter extends MessageQueue {
    private topics: Map<string, Topic> = new Map();
    private producers: Set<MemoryProducer> = new Set();
    private consumers: Set<MemoryConsumer> = new Set();

    public async connect(): Promise<void> {
        this.logger.info('Connecting to in-memory message queue');
        this.connected = true;
        this.emit('connected');
    }

    public async disconnect(): Promise<void> {
        this.logger.info('Disconnecting from in-memory message queue');
        
        // Stop all consumers
        for (const consumer of this.consumers) {
            await consumer.stop();
        }
        
        // Close all producers
        for (const producer of this.producers) {
            await producer.close();
        }
        
        this.connected = false;
        this.emit('disconnected');
    }

    public async createProducer(config?: ProducerConfig): Promise<Producer> {
        const producer = new MemoryProducer(this, config);
        this.producers.add(producer);
        return producer;
    }

    public async createConsumer(topics: string[], config: ConsumerConfig): Promise<Consumer> {
        const consumer = new MemoryConsumer(this, topics, config);
        this.consumers.add(consumer);
        
        // Register consumer with topics
        for (const topicName of topics) {
            const topic = this.getTopic(topicName);
            topic.consumers.add(consumer);
        }
        
        return consumer;
    }

    public async createTopic(name: string, options?: any): Promise<void> {
        if (!this.topics.has(name)) {
            this.topics.set(name, {
                name,
                messages: [],
                consumers: new Set(),
                stats: {
                    publishCount: 0,
                    consumeCount: 0
                }
            });
            
            this.logger.info(`Created topic: ${name}`);
        }
    }

    public async deleteTopic(name: string): Promise<void> {
        const topic = this.topics.get(name);
        if (topic) {
            // Stop all consumers for this topic
            for (const consumer of topic.consumers) {
                consumer.removeTopic(name);
            }
            
            this.topics.delete(name);
            this.logger.info(`Deleted topic: ${name}`);
        }
    }

    public async getStats(topicName?: string): Promise<QueueStats> {
        if (topicName) {
            const topic = this.topics.get(topicName);
            if (!topic) {
                throw new Error(`Topic not found: ${topicName}`);
            }
            
            return {
                messages: topic.messages.length,
                consumers: topic.consumers.size,
                publishRate: this.calculateRate(topic.stats.publishCount, topic.stats.lastPublish),
                consumeRate: this.calculateRate(topic.stats.consumeCount, topic.stats.lastConsume)
            };
        }
        
        // Global stats
        let totalMessages = 0;
        let totalConsumers = 0;
        let totalPublishCount = 0;
        let totalConsumeCount = 0;
        
        for (const topic of this.topics.values()) {
            totalMessages += topic.messages.length;
            totalConsumers += topic.consumers.size;
            totalPublishCount += topic.stats.publishCount;
            totalConsumeCount += topic.stats.consumeCount;
        }
        
        return {
            messages: totalMessages,
            consumers: totalConsumers,
            publishRate: totalPublishCount,
            consumeRate: totalConsumeCount
        };
    }

    public getTopic(name: string): Topic {
        let topic = this.topics.get(name);
        if (!topic) {
            topic = {
                name,
                messages: [],
                consumers: new Set(),
                stats: {
                    publishCount: 0,
                    consumeCount: 0
                }
            };
            this.topics.set(name, topic);
        }
        return topic;
    }

    public publishMessage(topicName: string, message: Message): void {
        const topic = this.getTopic(topicName);
        topic.messages.push(message);
        topic.stats.publishCount++;
        topic.stats.lastPublish = new Date();
        
        // Notify consumers
        this.emit(`message:${topicName}`, message);
    }

    public removeConsumer(consumer: MemoryConsumer): void {
        this.consumers.delete(consumer);
        
        for (const topic of this.topics.values()) {
            topic.consumers.delete(consumer);
        }
    }

    public removeProducer(producer: MemoryProducer): void {
        this.producers.delete(producer);
    }

    private calculateRate(count: number, lastTime?: Date): number {
        if (!lastTime) return 0;
        
        const elapsed = Date.now() - lastTime.getTime();
        if (elapsed === 0) return 0;
        
        return (count / elapsed) * 1000; // per second
    }
}

class MemoryProducer extends Producer {
    constructor(
        private queue: MemoryQueueAdapter,
        private config?: ProducerConfig
    ) {
        super();
    }

    public async send<T>(topic: string, value: T, key?: string): Promise<void> {
        const message: Message<T> = {
            id: this.generateId(),
            topic,
            key,
            value,
            timestamp: new Date()
        };
        
        this.queue.publishMessage(topic, message);
        this.logger.debug(`Sent message to ${topic}`, { messageId: message.id });
    }

    public async sendBatch<T>(messages: Array<{
        topic: string;
        value: T;
        key?: string;
        headers?: Record<string, string>;
    }>): Promise<void> {
        for (const msg of messages) {
            const message: Message<T> = {
                id: this.generateId(),
                topic: msg.topic,
                key: msg.key,
                value: msg.value,
                headers: msg.headers,
                timestamp: new Date()
            };
            
            this.queue.publishMessage(msg.topic, message);
        }
        
        this.logger.debug(`Sent batch of ${messages.length} messages`);
    }

    public async close(): Promise<void> {
        this.queue.removeProducer(this);
        this.logger.debug('Producer closed');
    }

    private generateId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
}

class MemoryConsumer extends Consumer {
    private topics: string[];
    private handler?: (message: MessageEnvelope) => Promise<void>;
    private consumerGroup: Map<string, number> = new Map();
    private paused = false;
    private listeners: Map<string, Function> = new Map();

    constructor(
        private queue: MemoryQueueAdapter,
        topics: string[],
        private config: ConsumerConfig
    ) {
        super();
        this.topics = [...topics];
        
        // Initialize consumer group positions
        for (const topic of topics) {
            this.consumerGroup.set(topic, 0);
        }
    }

    public async start(handler: (message: MessageEnvelope) => Promise<void>): Promise<void> {
        if (this.running) {
            throw new Error('Consumer already running');
        }
        
        this.handler = handler;
        this.running = true;
        this.paused = false;
        
        // Start listening to topics
        for (const topic of this.topics) {
            const listener = async (message: Message) => {
                if (!this.paused && this.running) {
                    await this.processMessage(topic, message);
                }
            };
            
            this.listeners.set(topic, listener);
            this.queue.on(`message:${topic}`, listener);
            
            // Process existing messages if fromBeginning
            if (this.config.fromBeginning) {
                await this.processExistingMessages(topic);
            }
        }
        
        this.logger.info(`Consumer started for topics: ${this.topics.join(', ')}`);
    }

    public async stop(): Promise<void> {
        this.running = false;
        
        // Remove listeners
        for (const [topic, listener] of this.listeners.entries()) {
            this.queue.removeListener(`message:${topic}`, listener as any);
        }
        this.listeners.clear();
        
        this.queue.removeConsumer(this);
        this.logger.info('Consumer stopped');
    }

    public async pause(): Promise<void> {
        this.paused = true;
        this.logger.debug('Consumer paused');
    }

    public async resume(): Promise<void> {
        this.paused = false;
        this.logger.debug('Consumer resumed');
        
        // Process any pending messages
        for (const topic of this.topics) {
            await this.processExistingMessages(topic);
        }
    }

    public async seek(topic: string, partition: number, offset: number): Promise<void> {
        this.consumerGroup.set(topic, offset);
        this.logger.debug(`Seeked to offset ${offset} for topic ${topic}`);
    }

    public async getLag(): Promise<ConsumerLag[]> {
        const lags: ConsumerLag[] = [];
        
        for (const topic of this.topics) {
            const topicData = this.queue.getTopic(topic);
            const currentOffset = this.consumerGroup.get(topic) || 0;
            const logEndOffset = topicData.messages.length;
            
            lags.push({
                topic,
                partition: 0,
                currentOffset,
                logEndOffset,
                lag: logEndOffset - currentOffset
            });
        }
        
        return lags;
    }

    public removeTopic(topic: string): void {
        const index = this.topics.indexOf(topic);
        if (index !== -1) {
            this.topics.splice(index, 1);
            this.consumerGroup.delete(topic);
            
            const listener = this.listeners.get(topic);
            if (listener) {
                this.queue.removeListener(`message:${topic}`, listener as any);
                this.listeners.delete(topic);
            }
        }
    }

    private async processMessage(topic: string, message: Message): Promise<void> {
        const currentOffset = this.consumerGroup.get(topic) || 0;
        const topicData = this.queue.getTopic(topic);
        const messageIndex = topicData.messages.indexOf(message);
        
        // Skip if already processed
        if (messageIndex < currentOffset) {
            return;
        }
        
        const envelope: MessageEnvelope = {
            message: { ...message, offset: messageIndex },
            ack: async () => {
                this.consumerGroup.set(topic, messageIndex + 1);
                topicData.stats.consumeCount++;
                topicData.stats.lastConsume = new Date();
                this.logger.debug(`Message acknowledged: ${message.id}`);
            },
            nack: async (requeue?: boolean) => {
                this.logger.debug(`Message rejected: ${message.id}, requeue: ${requeue}`);
                if (requeue) {
                    // In memory queue doesn't move offset
                } else {
                    this.consumerGroup.set(topic, messageIndex + 1);
                }
            }
        };
        
        try {
            await this.handler!(envelope);
            
            // Auto-commit if enabled
            if (this.config.autoCommit !== false) {
                await envelope.ack();
            }
        } catch (error) {
            this.logger.error(`Error processing message: ${error.message}`, {
                messageId: message.id,
                topic
            });
            
            // Don't auto-commit on error
        }
    }

    private async processExistingMessages(topic: string): Promise<void> {
        const topicData = this.queue.getTopic(topic);
        const currentOffset = this.consumerGroup.get(topic) || 0;
        
        // Process messages from current offset
        for (let i = currentOffset; i < topicData.messages.length; i++) {
            if (!this.running || this.paused) break;
            
            const message = topicData.messages[i];
            await this.processMessage(topic, message);
        }
    }
}
