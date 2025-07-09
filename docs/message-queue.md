# Message Queue System Documentation

## Overview

The Otedama Pool message queue system provides a flexible, high-performance messaging infrastructure that supports multiple queue backends (Kafka, RabbitMQ, In-Memory) with a unified API.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Application   │────▶│  Message Queue  │────▶│    Adapters     │
│                 │     │   Abstraction   │     │ Kafka/RabbitMQ  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                                                 │
         ▼                                                 ▼
┌─────────────────┐                             ┌─────────────────┐
│    Producer     │                             │    Consumer     │
│     Batcher     │                             │   Processor     │
└─────────────────┘                             └─────────────────┘
```

## Quick Start

### Basic Setup

```typescript
import { createMessageQueue, TOPICS } from '@otedama/messaging';

// Create message queue instance
const messageQueue = createMessageQueue({
    type: 'kafka', // or 'rabbitmq', 'memory'
    hosts: ['localhost:9092'],
    options: {
        clientId: 'otedama-pool'
    }
});

// Connect to queue
await messageQueue.connect();

// Create producer
const producer = await messageQueue.createProducer({
    acks: 'all',
    compressionType: 'gzip'
});

// Create consumer
const consumer = await messageQueue.createConsumer(
    [TOPICS.SHARES_SUBMITTED],
    {
        groupId: 'share-processors',
        autoCommit: true
    }
);
```

### Publishing Messages

```typescript
// Simple message
await producer.send(TOPICS.SHARES_SUBMITTED, {
    shareId: 'share_123',
    minerId: 'miner_456',
    difficulty: 1000000,
    nonce: '0xabc123'
});

// With key for partitioning
await producer.send(
    TOPICS.MINERS_STATS,
    { hashrate: 125000000, shares: 1250 },
    'miner_456' // key
);

// Batch send
await producer.sendBatch([
    {
        topic: TOPICS.SHARES_ACCEPTED,
        value: { shareId: 'share_1', reward: 0.001 },
        key: 'miner_1'
    },
    {
        topic: TOPICS.SHARES_ACCEPTED,
        value: { shareId: 'share_2', reward: 0.001 },
        key: 'miner_2'
    }
]);
```

### Consuming Messages

```typescript
// Start consumer with handler
await consumer.start(async (envelope) => {
    const { message } = envelope;
    
    try {
        // Process message
        console.log('Processing:', message.value);
        
        // Acknowledge success
        await envelope.ack();
    } catch (error) {
        // Reject and requeue
        await envelope.nack(true);
    }
});
```

## Message Processing Patterns

### Using Message Processor

```typescript
import { MessageProcessor } from '@otedama/messaging';

const processor = new MessageProcessor('share-processor', {
    groupId: 'share-processors',
    concurrency: 10,
    retryAttempts: 3,
    retryDelay: 1000,
    deadLetterTopic: TOPICS.SHARES_REJECTED
});

// Register handlers
processor.on(TOPICS.SHARES_SUBMITTED, async (share, envelope) => {
    // Validate share
    const isValid = await validateShare(share);
    
    if (isValid) {
        await producer.send(TOPICS.SHARES_ACCEPTED, {
            ...share,
            acceptedAt: new Date()
        });
    } else {
        throw new Error('Invalid share');
    }
});

// Start processing
await processor.start(consumer);
```

### Using Message Batcher

```typescript
import { createMessageBatcher } from '@otedama/messaging';

// Create batcher with preset
const batcher = createMessageBatcher(producer, 'high-throughput');

// Add messages - they'll be batched automatically
await batcher.add(TOPICS.MINERS_STATS, {
    minerId: 'miner_1',
    hashrate: 100000000
});

// Messages are sent when:
// 1. Batch size reaches limit
// 2. Max latency is reached
// 3. Manual flush is called

// Manual flush
await batcher.flushAll();

// Get stats
const stats = batcher.getStats();
console.log(`Sent ${stats.messagesSent} messages in ${stats.batchesSent} batches`);
```

### Adaptive Batching

```typescript
// Use adaptive batcher that adjusts parameters based on throughput
const adaptiveBatcher = createMessageBatcher(producer, 'adaptive');

// It automatically adjusts:
// - Batch size based on latency
// - Max latency based on throughput
// - Optimizes for best performance
```

## Topic Definitions

### Share Processing Topics

- `shares.submitted` - New shares submitted by miners
- `shares.validated` - Shares that passed initial validation
- `shares.accepted` - Valid shares accepted by the pool
- `shares.rejected` - Invalid shares rejected

### Block Processing Topics

- `blocks.found` - New blocks discovered by the pool
- `blocks.confirmed` - Blocks confirmed by the network
- `blocks.orphaned` - Blocks that became orphaned

### Payment Processing Topics

- `payments.calculated` - Payment amounts calculated
- `payments.queued` - Payments ready for processing
- `payments.processing` - Payments being processed
- `payments.sent` - Payments sent to blockchain
- `payments.confirmed` - Payments confirmed on chain
- `payments.failed` - Failed payment attempts

## Advanced Features

### Circuit Breaker Pattern

```typescript
const processor = new MessageProcessor('payment-processor', {
    groupId: 'payment-processors',
    circuitBreaker: {
        threshold: 5,        // 5 failures
        timeout: 60000,      // 1 minute
        resetTimeout: 300000 // 5 minutes
    }
});
```

### Message Deduplication

```typescript
const deduplicator = new MessageDeduplicator();

processor.on(TOPICS.PAYMENTS_SENT, async (payment, envelope) => {
    // Check for duplicate
    if (await deduplicator.isDuplicate(payment.id)) {
        await envelope.ack(); // Skip duplicate
        return;
    }
    
    // Process payment
    await processPayment(payment);
    
    // Mark as processed
    await deduplicator.markProcessed(payment.id, 3600000); // 1 hour TTL
});
```

### Priority Messages

```typescript
// Send high-priority message
await producer.send(TOPICS.SYSTEM_ALERTS, {
    level: 'critical',
    message: 'Pool hashrate dropped below threshold',
    priority: 0 // 0 = highest priority
});
```

### Saga Pattern for Distributed Transactions

```typescript
import { PaymentSaga } from '@otedama/messaging/sagas';

const paymentSaga = new PaymentSaga({
    name: 'payment-processing',
    timeout: 300000, // 5 minutes
    compensationStrategy: 'sequential'
});

// Execute payment saga
try {
    await paymentSaga.execute({
        minerId: 'miner_123',
        amount: 0.1,
        address: '0xabc...'
    });
} catch (error) {
    // Saga automatically compensated
    console.error('Payment failed:', error);
}
```

## Monitoring and Metrics

### Queue Statistics

```typescript
// Get queue stats
const stats = await messageQueue.getStats(TOPICS.SHARES_SUBMITTED);
console.log(`Queue depth: ${stats.messages}`);
console.log(`Active consumers: ${stats.consumers}`);
console.log(`Publish rate: ${stats.publishRate}/s`);
console.log(`Consume rate: ${stats.consumeRate}/s`);
```

### Consumer Lag

```typescript
// Check consumer lag
const lag = await consumer.getLag();
for (const topicLag of lag) {
    console.log(`Topic: ${topicLag.topic}`);
    console.log(`Current offset: ${topicLag.currentOffset}`);
    console.log(`End offset: ${topicLag.logEndOffset}`);
    console.log(`Lag: ${topicLag.lag} messages`);
}
```

### Message Processor Stats

```typescript
// Monitor processor performance
const processorStats = processor.getStats();
console.log(`Processing: ${processorStats.processing}`);
console.log(`Error counts:`, processorStats.errorCounts);

// Listen to events
processor.on('message:processed', ({ message }) => {
    metrics.recordSuccess(message.topic);
});

processor.on('message:failed', ({ message, error }) => {
    metrics.recordError(message.topic, error);
});
```

## Error Handling

### Retry Strategies

```typescript
const processor = new MessageProcessor('share-processor', {
    retryAttempts: 3,
    retryDelay: 1000, // Base delay
    retryStrategy: {
        maxRetries: 5,
        retryDelays: [1000, 2000, 4000, 8000, 16000], // Exponential backoff
        retryCondition: (error) => {
            // Only retry on specific errors
            return error.code === 'NETWORK_ERROR';
        },
        onRetryExhausted: (error, message) => {
            // Send to dead letter queue
            logger.error('Max retries exceeded:', error);
        }
    }
});
```

### Dead Letter Queue

```typescript
// Configure DLQ
const processor = new MessageProcessor('payment-processor', {
    deadLetterTopic: 'payments.dlq',
    errorHandler: async (error, envelope) => {
        // Custom error handling
        await notifyOps(error, envelope.message);
    }
});

// Process DLQ messages
const dlqProcessor = new MessageProcessor('dlq-processor', {
    groupId: 'dlq-processors'
});

dlqProcessor.on('payments.dlq', async (message) => {
    // Manual intervention or retry logic
    await handleFailedPayment(message);
});
```

## Performance Tuning

### Kafka Configuration

```typescript
const kafkaQueue = createMessageQueue({
    type: 'kafka',
    hosts: ['kafka1:9092', 'kafka2:9092', 'kafka3:9092'],
    options: {
        clientId: 'otedama-pool',
        connectionTimeout: 10000,
        requestTimeout: 30000,
        retry: {
            initialRetryTime: 100,
            retries: 8
        },
        // Producer optimization
        producer: {
            allowAutoTopicCreation: false,
            transactionTimeout: 60000,
            maxInFlightRequests: 5,
            idempotent: true
        },
        // Consumer optimization
        consumer: {
            sessionTimeout: 30000,
            rebalanceTimeout: 60000,
            heartbeatInterval: 3000,
            maxBytesPerPartition: 1048576,
            maxWaitTimeInMs: 500
        }
    }
});
```

### RabbitMQ Configuration

```typescript
const rabbitQueue = createMessageQueue({
    type: 'rabbitmq',
    connectionString: 'amqp://user:pass@rabbitmq:5672',
    options: {
        // Connection options
        heartbeatInterval: 30,
        connectionTimeout: 10000,
        
        // Channel options
        channelMax: 100,
        
        // Queue options
        queueArguments: {
            'x-message-ttl': 3600000, // 1 hour TTL
            'x-max-length': 1000000,   // Max 1M messages
            'x-overflow': 'drop-head'  // Drop oldest when full
        }
    }
});
```

### Batch Processing Optimization

```typescript
// Optimize for throughput
const highThroughputBatcher = new MessageBatcher(producer, {
    maxBatchSize: 1000,
    maxLatency: 1000,
    maxBytes: 5242880, // 5MB
    compressionThreshold: 1024 // Compress if > 1KB
});

// Optimize for low latency
const lowLatencyBatcher = new MessageBatcher(producer, {
    maxBatchSize: 10,
    maxLatency: 10,
    maxBytes: 65536 // 64KB
});
```

## Best Practices

1. **Message Design**
   - Keep messages small and focused
   - Use message schemas for validation
   - Include correlation IDs for tracing
   - Version your message formats

2. **Error Handling**
   - Always handle errors gracefully
   - Use dead letter queues for failed messages
   - Implement circuit breakers for external dependencies
   - Log errors with context

3. **Performance**
   - Batch messages when possible
   - Use compression for large payloads
   - Monitor consumer lag
   - Scale consumers based on load

4. **Reliability**
   - Use acknowledgments appropriately
   - Implement idempotent processing
   - Handle duplicate messages
   - Use transactions when needed

5. **Monitoring**
   - Track message processing metrics
   - Alert on consumer lag
   - Monitor error rates
   - Use distributed tracing

## Troubleshooting

### Consumer Not Receiving Messages

1. Check consumer group ID
2. Verify topic subscriptions
3. Check consumer lag
4. Review consumer logs

### High Message Latency

1. Check batch configuration
2. Monitor network latency
3. Review compression settings
4. Scale consumers

### Message Loss

1. Verify producer acknowledgment settings
2. Check consumer commit strategy
3. Review error handling
4. Enable message persistence

### Memory Issues

1. Limit consumer prefetch
2. Use streaming for large messages
3. Monitor heap usage
4. Implement backpressure

## Migration Guide

### From Direct Event Emitters

```typescript
// Before
eventEmitter.on('share-submitted', (share) => {
    processShare(share);
});

// After
const consumer = await messageQueue.createConsumer(
    [TOPICS.SHARES_SUBMITTED],
    { groupId: 'share-processors' }
);

await consumer.start(async (envelope) => {
    await processShare(envelope.message.value);
    await envelope.ack();
});
```

### From Synchronous to Asynchronous

```typescript
// Before
function processPayment(payment) {
    validatePayment(payment);
    sendToBlockchain(payment);
    updateDatabase(payment);
}

// After
async function processPayment(payment) {
    // Validate
    await producer.send(TOPICS.PAYMENTS_QUEUED, payment);
    
    // Each step is a separate consumer
    // Allows for scaling and fault tolerance
}
```
