/**
 * RabbitMQ Message Queue Adapter
 * AMQP-based message queue implementation
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

// Note: In a real implementation, you would import the actual AMQP client
// import * as amqp from 'amqplib';

// Mock types for demonstration
interface AMQPConnection {
    createChannel(): Promise<AMQPChannel>;
    close(): Promise<void>;
}

interface AMQPChannel {
    assertExchange(exchange: string, type: string, options?: any): Promise<void>;
    assertQueue(queue: string, options?: any): Promise<{ queue: string; messageCount: number; consumerCount: number }>;
    bindQueue(queue: string, exchange: string, pattern: string): Promise<void>;
    publish(exchange: string, routingKey: string, content: Buffer, options?: any): boolean;
    sendToQueue(queue: string, content: Buffer, options?: any): boolean;
    consume(queue: string, callback: (msg: any) => void, options?: any): Promise<{ consumerTag: string }>;
    ack(message: any): void;
    nack(message: any, allUpTo?: boolean, requeue?: boolean): void;
    cancel(consumerTag: string): Promise<void>;
    close(): Promise<void>;
    prefetch(count: number): Promise<void>;
}

interface AMQPMessage {
    content: Buffer;
    fields: {
        deliveryTag: number;
        redelivered: boolean;
        exchange: string;
        routingKey: string;
    };
    properties: {
        headers?: any;
        timestamp?: number;
        messageId?: string;
    };
}

export class RabbitMQAdapter extends MessageQueue {
    private connection?: AMQPConnection;
    private managementChannel?: AMQPChannel;

    public async connect(): Promise<void> {
        try {
            const url = this.config.connectionString || 
                `amqp://${this.config.hosts?.[0] || 'localhost:5672'}`;

            this.logger.info('Connecting to RabbitMQ', { url });

            // In real implementation:
            // this.connection = await amqp.connect(url, this.config.options);
            
            // Mock implementation
            this.connection = await this.createMockConnection();
            this.managementChannel = await this.connection.createChannel();

            this.connected = true;
            this.emit('connected');
            
            this.logger.info('Successfully connected to RabbitMQ');
        } catch (error) {
            this.logger.error('Failed to connect to RabbitMQ', error);
            throw error;
        }
    }

    public async disconnect(): Promise<void> {
        try {
            this.logger.info('Disconnecting from RabbitMQ');

            if (this.managementChannel) {
                await this.managementChannel.close();
            }

            if (this.connection) {
                await this.connection.close();
            }

            this.connected = false;
            this.emit('disconnected');
            
            this.logger.info('Successfully disconnected from RabbitMQ');
        } catch (error) {
            this.logger.error('Error disconnecting from RabbitMQ', error);
            throw error;
        }
    }

    public async createProducer(config?: ProducerConfig): Promise<Producer> {
        if (!this.connection) {
            throw new Error('Not connected to RabbitMQ');
        }

        const producer = new RabbitMQProducer(this.connection, config);
        await producer.connect();
        return producer;
    }

    public async createConsumer(topics: string[], config: ConsumerConfig): Promise<Consumer> {
        if (!this.connection) {
            throw new Error('Not connected to RabbitMQ');
        }

        const consumer = new RabbitMQConsumer(this.connection, topics, config);
        await consumer.connect();
        return consumer;
    }

    public async createTopic(name: string, options?: any): Promise<void> {
        if (!this.managementChannel) {
            throw new Error('Management channel not available');
        }

        try {
            // In RabbitMQ, we create exchanges and queues
            const exchangeType = options?.type || 'topic';
            const durable = options?.durable !== false;

            // Create exchange
            await this.managementChannel.assertExchange(name, exchangeType, {
                durable,
                autoDelete: options?.autoDelete || false
            });

            // Create default queue for the topic
            await this.managementChannel.assertQueue(name, {
                durable,
                exclusive: false,
                autoDelete: options?.autoDelete || false,
                arguments: options?.arguments
            });

            // Bind queue to exchange
            await this.managementChannel.bindQueue(name, name, '#');

            this.logger.info(`Created RabbitMQ topic (exchange + queue): ${name}`);
        } catch (error) {
            this.logger.error(`Failed to create topic ${name}`, error);
            throw error;
        }
    }

    public async deleteTopic(name: string): Promise<void> {
        // In RabbitMQ, we would delete exchanges and queues
        // This is a simplified implementation
        this.logger.warn('Topic deletion not implemented for RabbitMQ adapter');
    }

    public async getStats(topic?: string): Promise<QueueStats> {
        if (!this.managementChannel) {
            throw new Error('Management channel not available');
        }

        try {
            if (topic) {
                const queueInfo = await this.managementChannel.assertQueue(topic, { passive: true });
                
                return {
                    messages: queueInfo.messageCount,
                    consumers: queueInfo.consumerCount,
                    publishRate: 0, // Would need RabbitMQ management API
                    consumeRate: 0  // Would need RabbitMQ management API
                };
            }

            // Global stats would require management API
            return {
                messages: 0,
                consumers: 0,
                publishRate: 0,
                consumeRate: 0
            };
        } catch (error) {
            this.logger.error('Failed to get RabbitMQ stats', error);
            throw error;
        }
    }

    // Mock implementation
    private async createMockConnection(): Promise<AMQPConnection> {
        return {
            createChannel: async () => ({
                assertExchange: async () => {},
                assertQueue: async () => ({ queue: '', messageCount: 0, consumerCount: 0 }),
                bindQueue: async () => {},
                publish: () => true,
                sendToQueue: () => true,
                consume: async () => ({ consumerTag: 'mock-tag' }),
                ack: () => {},
                nack: () => {},
                cancel: async () => {},
                close: async () => {},
                prefetch: async () => {}
            }),
            close: async () => {}
        };
    }
}

class RabbitMQProducer extends Producer {
    private channel?: AMQPChannel;

    constructor(
        private connection: AMQPConnection,
        private config?: ProducerConfig
    ) {
        super();
    }

    public async connect(): Promise<void> {
        this.channel = await this.connection.createChannel();
        this.logger.debug('RabbitMQ producer channel created');
    }

    public async send<T>(topic: string, value: T, key?: string): Promise<void> {
        if (!this.channel) {
            throw new Error('Producer not connected');
        }

        try {
            const message = Buffer.from(JSON.stringify(value));
            const options = {
                persistent: true,
                messageId: this.generateId(),
                timestamp: Date.now(),
                headers: {
                    'x-message-key': key
                }
            };

            // Try to publish to exchange first, fallback to direct queue
            const published = this.channel.publish(topic, key || '', message, options) ||
                            this.channel.sendToQueue(topic, message, options);

            if (!published) {
                throw new Error('Failed to publish message - channel buffer full');
            }

            this.logger.debug(`Sent message to RabbitMQ topic/queue: ${topic}`);
        } catch (error) {
            this.logger.error(`Failed to send message to ${topic}`, error);
            throw error;
        }
    }

    public async sendBatch<T>(messages: Array<{
        topic: string;
        value: T;
        key?: string;
        headers?: Record<string, string>;
    }>): Promise<void> {
        if (!this.channel) {
            throw new Error('Producer not connected');
        }

        try {
            for (const msg of messages) {
                const message = Buffer.from(JSON.stringify(msg.value));
                const options = {
                    persistent: true,
                    messageId: this.generateId(),
                    timestamp: Date.now(),
                    headers: {
                        ...msg.headers,
                        'x-message-key': msg.key
                    }
                };

                const published = this.channel.publish(msg.topic, msg.key || '', message, options) ||
                                this.channel.sendToQueue(msg.topic, message, options);

                if (!published) {
                    throw new Error(`Failed to publish message to ${msg.topic}`);
                }
            }

            this.logger.debug(`Sent batch of ${messages.length} messages to RabbitMQ`);
        } catch (error) {
            this.logger.error('Failed to send batch messages', error);
            throw error;
        }
    }

    public async close(): Promise<void> {
        if (this.channel) {
            await this.channel.close();
            this.channel = undefined;
            this.logger.debug('RabbitMQ producer channel closed');
        }
    }

    private generateId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
}

class RabbitMQConsumer extends Consumer {
    private channel?: AMQPChannel;
    private consumerTags: Map<string, string> = new Map();
    private topics: string[];

    constructor(
        private connection: AMQPConnection,
        topics: string[],
        private config: ConsumerConfig
    ) {
        super();
        this.topics = [...topics];
    }

    public async connect(): Promise<void> {
        this.channel = await this.connection.createChannel();
        
        // Set QoS
        const prefetch = this.config.maxBatchSize || 10;
        await this.channel.prefetch(prefetch);

        // Create queues for consumer group
        for (const topic of this.topics) {
            const queueName = `${topic}.${this.config.groupId}`;
            
            // Assert queue
            await this.channel.assertQueue(queueName, {
                durable: true,
                exclusive: false,
                autoDelete: false
            });

            // Bind to exchange if it exists
            try {
                await this.channel.bindQueue(queueName, topic, '#');
            } catch (error) {
                // Exchange might not exist, that's okay
            }
        }

        this.logger.info(`RabbitMQ consumer connected for topics: ${this.topics.join(', ')}`);
    }

    public async start(handler: (message: MessageEnvelope) => Promise<void>): Promise<void> {
        if (!this.channel) {
            throw new Error('Consumer not connected');
        }

        if (this.running) {
            throw new Error('Consumer already running');
        }

        this.running = true;

        for (const topic of this.topics) {
            const queueName = `${topic}.${this.config.groupId}`;
            
            const { consumerTag } = await this.channel.consume(
                queueName,
                async (msg: AMQPMessage | null) => {
                    if (!msg || !this.running) return;

                    const envelope: MessageEnvelope = {
                        message: {
                            id: msg.properties.messageId || this.generateId(),
                            topic,
                            key: msg.properties.headers?.['x-message-key'],
                            value: JSON.parse(msg.content.toString()),
                            headers: msg.properties.headers,
                            timestamp: msg.properties.timestamp 
                                ? new Date(msg.properties.timestamp) 
                                : new Date(),
                            partition: 0, // RabbitMQ doesn't have partitions
                            offset: msg.fields.deliveryTag
                        },
                        ack: async () => {
                            if (this.channel) {
                                this.channel.ack(msg);
                                this.logger.debug(`Message acknowledged: ${msg.properties.messageId}`);
                            }
                        },
                        nack: async (requeue = true) => {
                            if (this.channel) {
                                this.channel.nack(msg, false, requeue);
                                this.logger.debug(`Message rejected: ${msg.properties.messageId}, requeue: ${requeue}`);
                            }
                        },
                        retryCount: msg.fields.redelivered ? 1 : 0
                    };

                    try {
                        await handler(envelope);
                        
                        // Auto-ack if enabled
                        if (this.config.autoCommit !== false) {
                            await envelope.ack();
                        }
                    } catch (error) {
                        this.logger.error('Error processing RabbitMQ message', {
                            error,
                            messageId: envelope.message.id
                        });

                        // Auto-nack on error if auto-commit is enabled
                        if (this.config.autoCommit !== false) {
                            await envelope.nack(true);
                        }
                    }
                },
                {
                    noAck: false,
                    exclusive: false,
                    arguments: this.config.options?.consumerArgs
                }
            );

            this.consumerTags.set(topic, consumerTag);
        }

        this.logger.info('RabbitMQ consumer started');
    }

    public async stop(): Promise<void> {
        this.running = false;

        if (this.channel) {
            // Cancel all consumers
            for (const [topic, tag] of this.consumerTags.entries()) {
                await this.channel.cancel(tag);
                this.logger.debug(`Cancelled consumer for topic: ${topic}`);
            }

            await this.channel.close();
            this.channel = undefined;
        }

        this.consumerTags.clear();
        this.logger.info('RabbitMQ consumer stopped');
    }

    public async pause(): Promise<void> {
        // RabbitMQ doesn't have native pause/resume
        // We would need to cancel and recreate consumers
        this.logger.warn('Pause not implemented for RabbitMQ - use stop/start instead');
    }

    public async resume(): Promise<void> {
        this.logger.warn('Resume not implemented for RabbitMQ - use stop/start instead');
    }

    public async seek(topic: string, partition: number, offset: number): Promise<void> {
        // RabbitMQ doesn't support seeking to specific offsets
        this.logger.warn('Seek not supported in RabbitMQ');
    }

    public async getLag(): Promise<ConsumerLag[]> {
        if (!this.channel) {
            return [];
        }

        const lags: ConsumerLag[] = [];

        try {
            for (const topic of this.topics) {
                const queueName = `${topic}.${this.config.groupId}`;
                const queueInfo = await this.channel.assertQueue(queueName, { passive: true });

                lags.push({
                    topic,
                    partition: 0,
                    currentOffset: 0, // Not applicable in RabbitMQ
                    logEndOffset: queueInfo.messageCount,
                    lag: queueInfo.messageCount
                });
            }
        } catch (error) {
            this.logger.error('Failed to get consumer lag', error);
        }

        return lags;
    }

    private generateId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
}
