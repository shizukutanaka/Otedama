/**
 * Event System Exports
 * Unified interface for event-driven architecture
 */

// Event Bus
export {
    EventBus,
    Event,
    EventMetadata,
    EventPriority,
    EventHandler,
    EventSubscription,
    EventBusConfig,
    getEventBus,
    EVENT_TYPES,
    EventType
} from './event-bus';

// Event Store
export {
    EventStore,
    StoredEvent,
    EventStream,
    EventQuery,
    EventSnapshot,
    EventStoreConfig,
    InMemoryEventStore,
    FileEventStore,
    createEventStore
} from './event-store';

// Domain Events
export {
    DomainEvent,
    AggregateRoot,
    // Pool Events
    PoolStartedEvent,
    PoolStoppedEvent,
    PoolConfigUpdatedEvent,
    // Block Events
    BlockFoundEvent,
    BlockConfirmedEvent,
    BlockOrphanedEvent,
    // Share Events
    ShareSubmittedEvent,
    ShareAcceptedEvent,
    ShareRejectedEvent,
    // Miner Events
    MinerConnectedEvent,
    MinerAuthenticatedEvent,
    MinerDisconnectedEvent,
    MinerBannedEvent,
    // Payment Events
    PaymentCalculatedEvent,
    PaymentQueuedEvent,
    PaymentSentEvent,
    PaymentConfirmedEvent,
    PaymentFailedEvent,
    // Aggregates
    MinerAggregate
} from './domain-events';

// Event Handlers and Saga
export {
    BaseEventHandler,
    EventHandlerConfig,
    Saga,
    SagaStep,
    SagaContext,
    PaymentProcessingSaga,
    ShareValidationHandler
} from './event-handlers';

// Utility functions
export function createEventDrivenSystem(config?: {
    eventBusConfig?: EventBusConfig;
    eventStoreConfig?: EventStoreConfig;
}): {
    eventBus: EventBus;
    eventStore: EventStore;
} {
    const eventBus = getEventBus(config?.eventBusConfig);
    const eventStore = createEventStore(config?.eventStoreConfig || {
        storageType: 'memory'
    });

    return { eventBus, eventStore };
}

// Event type definitions for type safety
export interface PoolEventPayloads {
    'pool.started': {
        poolId: string;
        startTime: Date;
        config: any;
    };
    'pool.stopped': {
        poolId: string;
        stopTime: Date;
        reason: string;
    };
    'pool.stats.updated': {
        hashrate: number;
        miners: number;
        workers: number;
        difficulty: number;
    };
}

export interface BlockEventPayloads {
    'block.found': {
        height: number;
        hash: string;
        reward: number;
        foundBy: string;
    };
    'block.confirmed': {
        height: number;
        hash: string;
        confirmations: number;
    };
    'block.orphaned': {
        height: number;
        hash: string;
        reason: string;
    };
}

export interface ShareEventPayloads {
    'share.submitted': {
        shareId: string;
        minerId: string;
        workerId: string;
        difficulty: number;
    };
    'share.accepted': {
        shareId: string;
        minerId: string;
        reward: number;
    };
    'share.rejected': {
        shareId: string;
        minerId: string;
        reason: string;
    };
}

export interface MinerEventPayloads {
    'miner.connected': {
        minerId: string;
        address: string;
        ipAddress: string;
    };
    'miner.authenticated': {
        minerId: string;
        address: string;
        permissions: string[];
    };
    'miner.disconnected': {
        minerId: string;
        reason: string;
        duration: number;
    };
    'miner.banned': {
        minerId: string;
        reason: string;
        duration?: number;
    };
}

export interface PaymentEventPayloads {
    'payment.calculated': {
        paymentId: string;
        minerId: string;
        amount: number;
    };
    'payment.queued': {
        paymentId: string;
        minerId: string;
        address: string;
        amount: number;
    };
    'payment.sent': {
        paymentId: string;
        txHash: string;
        amount: number;
    };
    'payment.confirmed': {
        paymentId: string;
        txHash: string;
        confirmations: number;
    };
    'payment.failed': {
        paymentId: string;
        reason: string;
        willRetry: boolean;
    };
}

// Combined event payload types
export type EventPayloads = 
    PoolEventPayloads & 
    BlockEventPayloads & 
    ShareEventPayloads & 
    MinerEventPayloads & 
    PaymentEventPayloads;

// Type-safe event emitter
export interface TypedEventBus {
    publish<K extends keyof EventPayloads>(
        type: K,
        data: EventPayloads[K],
        source: string,
        metadata?: EventMetadata
    ): Promise<void>;
    
    subscribe<K extends keyof EventPayloads>(
        eventType: K,
        handler: (event: Event<EventPayloads[K]>) => void | Promise<void>,
        options?: Partial<EventHandler>
    ): string;
}

// Create typed event bus wrapper
export function createTypedEventBus(eventBus: EventBus): TypedEventBus {
    return {
        publish: (type, data, source, metadata) => 
            eventBus.publish(type, data, source, metadata),
        subscribe: (eventType, handler, options) => 
            eventBus.subscribe(eventType, handler, options)
    };
}
