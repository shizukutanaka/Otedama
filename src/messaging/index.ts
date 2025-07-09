/**
 * Messaging System Exports
 * Unified interface for message queue implementations
 */

// Core abstractions
export {
    MessageQueue,
    Producer,
    Consumer,
    Message,
    MessageEnvelope,
    ProducerConfig,
    ConsumerConfig,
    QueueConfig,
    QueueStats,
    ConsumerLag,
    createMessageQueue,
    createMessage,
    TOPICS
} from './message-queue';

// Message type definitions
export {
    ShareSubmittedMessage,
    BlockFoundMessage,
    PaymentCalculatedMessage,
    MinerStatsMessage
} from './message-queue';

// Adapters
export { MemoryQueueAdapter } from './memory-queue-adapter';
export { KafkaAdapter } from './kafka-adapter';
export { RabbitMQAdapter } from './rabbitmq-adapter';

// High-level message processing patterns
export { MessageProcessor } from './message-processor';
export { MessageBatcher } from './message-batcher';

// Re-export for convenience
export type { QueueType } from './types';
