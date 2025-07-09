# Event-Driven Architecture Guide

## Overview

The Otedama Pool uses an event-driven architecture to achieve loose coupling between components, enabling better scalability, maintainability, and extensibility.

## Core Components

### Event Bus

The central message broker that handles event publishing and subscription.

```typescript
import { getEventBus } from '@otedama/events';

const eventBus = getEventBus({
    maxListeners: 100,
    enableLogging: true,
    enableMetrics: true,
    enableReplay: true,
    replayBufferSize: 1000
});
```

### Event Store

Persists events for audit trails, replay, and event sourcing.

```typescript
import { createEventStore } from '@otedama/events';

const eventStore = createEventStore({
    storageType: 'file', // 'memory' | 'file' | 'database'
    storagePath: './data/events',
    maxEventsPerFile: 10000,
    enableSnapshots: true,
    snapshotFrequency: 100
});
```

## Event Types

### Pool Events

- `pool.started` - Pool service started
- `pool.stopped` - Pool service stopped
- `pool.stats.updated` - Pool statistics updated

### Block Events

- `block.found` - New block discovered
- `block.confirmed` - Block confirmed by network
- `block.orphaned` - Block became orphaned

### Share Events

- `share.submitted` - Share submitted by miner
- `share.accepted` - Share accepted as valid
- `share.rejected` - Share rejected as invalid

### Miner Events

- `miner.connected` - Miner connected to pool
- `miner.authenticated` - Miner successfully authenticated
- `miner.disconnected` - Miner disconnected
- `miner.banned` - Miner banned from pool

### Payment Events

- `payment.calculated` - Payment amount calculated
- `payment.queued` - Payment queued for processing
- `payment.sent` - Payment sent to blockchain
- `payment.confirmed` - Payment confirmed on blockchain
- `payment.failed` - Payment failed

## Publishing Events

### Basic Publishing

```typescript
await eventBus.publish(
    'share.accepted',
    {
        shareId: 'share_123',
        minerId: 'miner_456',
        difficulty: 1000000,
        reward: 0.001
    },
    'ShareValidator'
);
```

### With Metadata

```typescript
await eventBus.publish(
    'payment.sent',
    { paymentId: 'pay_123', amount: 0.1, txHash: '0x...' },
    'PaymentService',
    {
        correlationId: 'batch_789',
        userId: 'miner_456',
        priority: EventPriority.HIGH
    }
);
```

## Subscribing to Events

### Basic Subscription

```typescript
const subscriptionId = eventBus.subscribe(
    'share.submitted',
    async (event) => {
        console.log('Share submitted:', event.data);
        // Process share...
    }
);
```

### Advanced Subscription

```typescript
eventBus.subscribe(
    ['share.accepted', 'share.rejected'],
    async (event) => {
        // Handle multiple event types
    },
    {
        name: 'ShareProcessor',
        priority: 5,
        async: true,
        timeout: 30000,
        retryPolicy: {
            maxRetries: 3,
            retryDelay: 1000
        },
        filter: (event) => event.data.difficulty > 1000000
    }
);
```

## Event Handlers

### Creating an Event Handler

```typescript
import { BaseEventHandler } from '@otedama/events';

class BlockFoundHandler extends BaseEventHandler {
    constructor(eventBus: EventBus) {
        super(eventBus, {
            name: 'BlockFoundHandler',
            eventTypes: ['block.found'],
            timeout: 60000
        });
    }

    protected async handle(event: Event): Promise<void> {
        const { height, hash, reward } = event.data;
        
        // Process new block
        await this.distributeReward(reward);
        await this.notifyMiners(height, hash);
    }
}

// Start handler
const handler = new BlockFoundHandler(eventBus);
await handler.start();
```

## Saga Pattern

### Implementing a Saga

```typescript
import { Saga, SagaStep } from '@otedama/events';

class MinerRegistrationSaga extends Saga<{
    address: string;
    email: string;
    workerId?: string;
    userId?: string;
}> {
    protected defineSteps(): SagaStep[] {
        return [
            {
                name: 'validate_address',
                execute: async (data) => {
                    if (!isValidAddress(data.address)) {
                        throw new Error('Invalid address');
                    }
                },
            },
            {
                name: 'create_user',
                execute: async (data) => {
                    const userId = await createUser(data.email);
                    return { userId };
                },
                compensate: async (data) => {
                    if (data.userId) {
                        await deleteUser(data.userId);
                    }
                }
            },
            {
                name: 'register_worker',
                execute: async (data) => {
                    const workerId = await registerWorker(data.userId, data.address);
                    return { workerId };
                },
                compensate: async (data) => {
                    if (data.workerId) {
                        await unregisterWorker(data.workerId);
                    }
                }
            },
            {
                name: 'send_welcome_email',
                execute: async (data) => {
                    await sendEmail(data.email, 'Welcome to Otedama Pool!');
                }
            }
        ];
    }
}

// Execute saga
const saga = new MinerRegistrationSaga('MinerRegistration', eventBus);
await saga.execute({
    address: '0x123...',
    email: 'miner@example.com'
});
```

## Event Sourcing

### Using Aggregates

```typescript
import { MinerAggregate } from '@otedama/events';

// Create new miner
const miner = MinerAggregate.create('miner_123', '0xabc...');

// Perform actions
miner.connect('0xabc...', '192.168.1.1', 'cgminer/4.0', '4.0');
miner.submitShare('share_1', 'worker_1', 'job_1', 'nonce_1', 1000000);
miner.acceptShare('share_1', 'worker_1', 1000000, 0.001);

// Get uncommitted events
const events = miner.getUncommittedEvents();

// Save events to store
await eventStore.appendEvents(events);

// Mark events as committed
miner.markEventsAsCommitted();

// Rebuild from events
const minerId = 'miner_123';
const eventStream = await eventStore.getEventStream(minerId, 'MinerAggregate');
const rebuiltMiner = new MinerAggregate(minerId);
rebuiltMiner.loadFromHistory(eventStream.events);
```

## Event Replay

### Replaying Historical Events

```typescript
// Replay all events from a specific time
await eventBus.replayEvents({
    since: new Date('2024-01-01'),
    type: 'share.accepted'
}, 1); // Speed: 1 = real-time, 2 = 2x speed

// Get event history
const history = eventBus.getEventHistory({
    type: 'block.found',
    since: new Date(Date.now() - 86400000), // Last 24 hours
    limit: 100
});
```

## Best Practices

### 1. Event Naming

- Use dot notation: `domain.entity.action`
- Be specific: `payment.bitcoin.sent` not just `payment.sent`
- Use past tense: `share.accepted` not `share.accept`

### 2. Event Data

- Keep events immutable
- Include all necessary data for replay
- Don't include sensitive information
- Version your event schemas

### 3. Error Handling

```typescript
eventBus.subscribe('payment.process', async (event) => {
    try {
        await processPayment(event.data);
    } catch (error) {
        // Don't throw - publish error event instead
        await eventBus.publish('payment.failed', {
            paymentId: event.data.paymentId,
            error: error.message
        }, 'PaymentProcessor');
    }
});
```

### 4. Testing

```typescript
describe('ShareValidation', () => {
    it('should accept valid shares', async () => {
        const events: Event[] = [];
        
        // Capture events
        eventBus.subscribe('share.accepted', (event) => {
            events.push(event);
        });

        // Publish test event
        await eventBus.publish('share.submitted', {
            shareId: 'test_1',
            minerId: 'miner_1',
            difficulty: 1000000
        }, 'Test');

        // Wait for processing
        await eventBus.waitForEvent('share.accepted', 
            (e) => e.data.shareId === 'test_1',
            1000
        );

        expect(events).toHaveLength(1);
        expect(events[0].data.shareId).toBe('test_1');
    });
});
```

## Performance Monitoring

```typescript
// Get event bus metrics
const metrics = eventBus.getMetrics();
console.log('Events published:', metrics.eventsPublished);
console.log('Events handled:', metrics.eventsHandled);
console.log('Events failed:', metrics.eventsFailed);

// Handler performance
metrics.handlerStats.forEach(stat => {
    console.log(`Handler ${stat.handlerId}:`);
    console.log(`  Average execution time: ${stat.averageExecutionTime}ms`);
    console.log(`  Total executions: ${stat.totalExecutions}`);
});
```

## Integration with Pool Components

### Stratum Server Integration

```typescript
stratumServer.on('client.share', async (client, share) => {
    await eventBus.publish('share.submitted', {
        shareId: generateId(),
        minerId: client.minerId,
        workerId: client.workerId,
        jobId: share.jobId,
        nonce: share.nonce,
        difficulty: share.difficulty
    }, 'StratumServer');
});
```

### Payment System Integration

```typescript
// Listen for blocks found
eventBus.subscribe('block.confirmed', async (event) => {
    const { height, reward } = event.data;
    
    // Calculate payments
    const payments = await calculatePayments(height, reward);
    
    // Publish payment events
    for (const payment of payments) {
        await eventBus.publish('payment.calculated', payment, 'PaymentCalculator');
    }
});
```

### WebSocket API Integration

```typescript
// Forward events to WebSocket clients
eventBus.subscribe('pool.stats.updated', (event) => {
    wsServer.broadcast('pool.stats', event.data);
});

eventBus.subscribe('block.found', (event) => {
    wsServer.broadcast('pool.blocks', event.data);
});
```

## Troubleshooting

### Debug Logging

```typescript
// Enable debug logging
process.env.DEBUG = 'EventBus:*,EventHandler:*,Saga:*';
```

### Event Tracing

```typescript
// Add trace metadata
await eventBus.publish('share.submitted', data, 'ShareProcessor', {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    correlationId: batchId
});
```

### Performance Issues

1. Check handler execution times in metrics
2. Use async handlers for I/O operations
3. Implement proper indexing in event store
4. Consider event batching for high-volume events
5. Use event filtering to reduce processing

## Security Considerations

1. Validate all event data
2. Don't expose internal IDs in events
3. Use encryption for sensitive event data
4. Implement access control for event subscriptions
5. Audit all administrative events
