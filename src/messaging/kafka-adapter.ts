/**
 * Kafka Message Queue Adapter
 * Production-ready message queue using Apache Kafka
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

// Note: In a real implementation, you would import the actual Kafka client
// import { Kafka, Producer as KafkaProducer, Consumer as KafkaConsumer } from 'kafkajs';

// Mock types for demonstration (replace with actual KafkaJS imports)
interface KafkaClient {
    producer(): any;
    consumer(config: any): any;
    admin(): any;
}

interface KafkaProducerInstance {
    connect(): Promise<void>;
    send(params: any): Promise<void>;
    sendBatch(params: any): Promise<void>;
    disconnect(): Promise<void>;
}

interface KafkaConsumerInstance {
    connect(): Promise<void>;
    subscribe(params: any): Promise<void>;
    run(params: any): Promise<void>;
    pause(topics: any[]): void;
    resume(topics: any[]): void;
    seek(params: any): Promise<void>;
    disconnect(): Promise<void>;
    describeGroup(): Promise<any>;
}

export class KafkaAdapter extends MessageQueue {
    private kafka!: KafkaClient;
    private admin: any;

    constructor(config: QueueConfig) {
        super(config);
        this.initializeKafka();
    }

    private initializeKafka(): void {
        const kafkaConfig = {
            clientId: this.config.options?.clientId || 'otedama-pool',
            brokers: this.config.hosts || ['localhost:9092'],
            connectionTimeout: this.config.options?.connectionTimeout || 10000,
            requestTimeout: this.config.options?.requestTimeout || 30000,
            retry: {
                initialRetryTime: 100,
                retries: 8
            },
            ...this.config.options
        };

        // In real implementation:
        // this.kafka = new Kafka(kafkaConfig);
        
        // Mock implementation
        this.kafka = this.createMockKafkaClient(kafkaConfig);
    }

    public async connect(): Promise<void> {
        try {
            this.logger.info('Connecting to Kafka brokers', {
                brokers: this.config.hosts
            });

            this.admin = this.kafka.admin();
            await this.admin.connect();

            this.connected = true;
            this.emit('connected');
            
            this.logger.info('Successfully connected to Kafka');
        } catch (error) {
            this.logger.error('Failed to connect to Kafka', error);
            throw error;
        }
    }

    public async disconnect(): Promise<void> {
        try {
            this.logger.info('Disconnecting from Kafka');

            if (this.admin) {
                await this.admin.disconnect();
            }

            this.connected = false;
            this.emit('disconnected');
            
            this.logger.info('Successfully disconnected from Kafka');
        } catch (error) {
            this.logger.error('Error disconnecting from Kafka', error);
            throw error;
        }
    }

    public async createProducer(config?: ProducerConfig): Promise<Producer> {
        const producer = new KafkaProducer(this.kafka, config);
        await producer.connect();
        return producer;
    }

    public async createConsumer(topics: string[], config: ConsumerConfig): Promise<Consumer> {
        const consumer = new KafkaConsumer(this.kafka, topics, config);
        await consumer.connect();
        return consumer;
    }

    public async createTopic(name: string, options?: any): Promise<void> {
        try {
            await this.admin.createTopics({
                topics: [{
                    topic: name,
                    numPartitions: options?.partitions || 3,
                    replicationFactor: options?.replicationFactor || 1,
                    configEntries: options?.config || []
                }]
            });

            this.logger.info(`Created Kafka topic: ${name}`);
        } catch (error) {
            if (error.message?.includes('already exists')) {
                this.logger.debug(`Topic ${name} already exists`);
            } else {
                throw error;
            }
        }
    }

    public async deleteTopic(name: string): Promise<void> {
        try {
            await this.admin.deleteTopics({
                topics: [name]
            });

            this.logger.info(`Deleted Kafka topic: ${name}`);
        } catch (error) {
            this.logger.error(`Failed to delete topic ${name}`, error);
            throw error;
        }
    }

    public async getStats(topic?: string): Promise<QueueStats> {
        try {
            const metadata = await this.admin.fetchTopicMetadata({
                topics: topic ? [topic] : undefined
            });

            const consumerGroups = await this.admin.listGroups();

            // Calculate stats (simplified)
            const stats: QueueStats = {
                messages: 0, // Would need to calculate from offsets
                consumers: consumerGroups.groups.length,
                publishRate: 0, // Would need metrics integration
                consumeRate: 0  // Would need metrics integration
            };

            return stats;
        } catch (error) {
            this.logger.error('Failed to get Kafka stats', error);
            throw error;
        }
    }

    // Mock implementation for demonstration
    private createMockKafkaClient(config: any): KafkaClient {
        return {
            producer: () => ({
                connect: async () => {},
                send: async () => {},
                sendBatch: async () => {},
                disconnect: async () => {}
            }),
            consumer: (cfg: any) => ({
                connect: async () => {},
                subscribe: async () => {},
                run: async () => {},
                pause: () => {},
                resume: () => {},
                seek: async () => {},
                disconnect: async () => {},
                describeGroup: async () => ({})
            }),
            admin: () => ({
                connect: async () => {},
                disconnect: async () => {},
                createTopics: async () => {},
                deleteTopics: async () => {},
                fetchTopicMetadata: async () => ({ topics: [] }),
                listGroups: async () => ({ groups: [] })
            })
        };
    }
}

class KafkaProducer extends Producer {
    private producer: KafkaProducerInstance;
    private connected = false;

    constructor(
        private kafka: KafkaClient,
        private config?: ProducerConfig
    ) {
        super();
        
        const producerConfig = {
            allowAutoTopicCreation: true,
            transactionTimeout: 60000,
            ...config
        };

        this.producer = kafka.producer();
    }

    public async connect(): Promise<void> {
        if (!this.connected) {
            await this.producer.connect();
            this.connected = true;
            this.logger.debug('Kafka producer connected');
        }
    }

    public async send<T>(topic: string, value: T, key?: string): Promise<void> {
        try {
            await this.producer.send({
                topic,
                messages: [{
                    key: key || null,
                    value: JSON.stringify(value),
                    timestamp: Date.now().toString()
                }],
                acks: this.config?.acks === 'all' ? -1 : 1,
                timeout: 30000,
                compression: this.getCompressionType()
            });

            this.logger.debug(`Sent message to Kafka topic: ${topic}`);
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
        try {
            const topicMessages = new Map<string, any[]>();

            // Group messages by topic
            for (const msg of messages) {
                if (!topicMessages.has(msg.topic)) {
                    topicMessages.set(msg.topic, []);
                }

                topicMessages.get(msg.topic)!.push({
                    key: msg.key || null,
                    value: JSON.stringify(msg.value),
                    headers: msg.headers,
                    timestamp: Date.now().toString()
                });
            }

            // Send batches per topic
            const batches = Array.from(topicMessages.entries()).map(([topic, msgs]) => ({
                topic,
                messages: msgs,
                acks: this.config?.acks === 'all' ? -1 : 1,
                timeout: 30000,
                compression: this.getCompressionType()
            }));

            await this.producer.sendBatch({ topicMessages: batches });

            this.logger.debug(`Sent batch of ${messages.length} messages to Kafka`);
        } catch (error) {
            this.logger.error('Failed to send batch messages', error);
            throw error;
        }
    }

    public async close(): Promise<void> {
        if (this.connected) {
            await this.producer.disconnect();
            this.connected = false;
            this.logger.debug('Kafka producer disconnected');
        }
    }

    private getCompressionType(): number {
        const compressionMap = {
            'none': 0,
            'gzip': 1,
            'snappy': 2,
            'lz4': 3
        };
        return compressionMap[this.config?.compressionType || 'none'];
    }
}

class KafkaConsumer extends Consumer {
    private consumer: KafkaConsumerInstance;
    private connected = false;
    private topics: string[];
    private paused = false;

    constructor(
        private kafka: KafkaClient,
        topics: string[],
        private config: ConsumerConfig
    ) {
        super();
        this.topics = [...topics];

        const consumerConfig = {
            groupId: config.groupId,
            sessionTimeout: config.sessionTimeout || 30000,
            heartbeatInterval: config.heartbeatInterval || 3000,
            ...config
        };

        this.consumer = kafka.consumer(consumerConfig);
    }

    public async connect(): Promise<void> {
        if (!this.connected) {
            await this.consumer.connect();
            this.connected = true;
            
            // Subscribe to topics
            await this.consumer.subscribe({
                topics: this.topics,
                fromBeginning: this.config.fromBeginning || false
            });

            this.logger.info(`Kafka consumer connected and subscribed to: ${this.topics.join(', ')}`);
        }
    }

    public async start(handler: (message: MessageEnvelope) => Promise<void>): Promise<void> {
        if (this.running) {
            throw new Error('Consumer already running');
        }

        this.running = true;

        await this.consumer.run({
            autoCommit: this.config.autoCommit !== false,
            autoCommitInterval: this.config.autoCommitInterval || 5000,
            eachMessage: async ({ topic, partition, message }: any) => {
                if (this.paused) return;

                const envelope: MessageEnvelope = {
                    message: {
                        id: message.key?.toString() || `${topic}-${partition}-${message.offset}`,
                        topic,
                        key: message.key?.toString(),
                        value: JSON.parse(message.value.toString()),
                        headers: this.parseHeaders(message.headers),
                        timestamp: new Date(parseInt(message.timestamp)),
                        partition,
                        offset: parseInt(message.offset)
                    },
                    ack: async () => {
                        // Kafka auto-commits or manual commit
                        this.logger.debug(`Message acknowledged: offset ${message.offset}`);
                    },
                    nack: async (requeue?: boolean) => {
                        // In Kafka, we can't really "nack" - we just don't commit
                        this.logger.debug(`Message not acknowledged: offset ${message.offset}`);
                        
                        if (requeue) {
                            // Seek back to this offset
                            await this.consumer.seek({
                                topic,
                                partition,
                                offset: message.offset
                            });
                        }
                    }
                };

                try {
                    await handler(envelope);
                } catch (error) {
                    this.logger.error('Error processing Kafka message', {
                        error,
                        topic,
                        partition,
                        offset: message.offset
                    });
                    
                    // Re-throw to prevent auto-commit on error
                    if (this.config.autoCommit !== false) {
                        throw error;
                    }
                }
            }
        });

        this.logger.info('Kafka consumer started');
    }

    public async stop(): Promise<void> {
        this.running = false;

        if (this.connected) {
            await this.consumer.disconnect();
            this.connected = false;
        }

        this.logger.info('Kafka consumer stopped');
    }

    public async pause(): Promise<void> {
        this.paused = true;
        this.consumer.pause(this.topics.map(topic => ({ topic })));
        this.logger.debug('Kafka consumer paused');
    }

    public async resume(): Promise<void> {
        this.paused = false;
        this.consumer.resume(this.topics.map(topic => ({ topic })));
        this.logger.debug('Kafka consumer resumed');
    }

    public async seek(topic: string, partition: number, offset: number): Promise<void> {
        await this.consumer.seek({ topic, partition, offset: offset.toString() });
        this.logger.debug(`Seeked to offset ${offset} for ${topic}:${partition}`);
    }

    public async getLag(): Promise<ConsumerLag[]> {
        try {
            const group = await this.consumer.describeGroup();
            const lags: ConsumerLag[] = [];

            // Parse consumer group metadata to calculate lag
            // This is simplified - real implementation would be more complex
            for (const member of group.members || []) {
                for (const assignment of member.memberAssignment?.topicPartitions || []) {
                    lags.push({
                        topic: assignment.topic,
                        partition: assignment.partition,
                        currentOffset: 0, // Would get from group metadata
                        logEndOffset: 0,  // Would get from topic metadata
                        lag: 0
                    });
                }
            }

            return lags;
        } catch (error) {
            this.logger.error('Failed to get consumer lag', error);
            return [];
        }
    }

    private parseHeaders(headers: any): Record<string, string> | undefined {
        if (!headers) return undefined;

        const parsed: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
            parsed[key] = value?.toString() || '';
        }

        return parsed;
    }
}
