/**
 * Event Bus - Core Event-Driven Architecture
 * 
 * 設計原則:
 * - Pike: シンプルで明確なイベントシステム
 * - Martin: 疎結合を実現するイベントバス
 * - Carmack: 高速で効率的なイベント配信
 */

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';
import { performance } from 'perf_hooks';

export interface Event {
    id: string;
    type: string;
    source: string;
    timestamp: Date;
    version: string;
    data: any;
    metadata?: EventMetadata;
}

export interface EventMetadata {
    correlationId?: string;
    causationId?: string;
    userId?: string;
    sessionId?: string;
    traceId?: string;
    spanId?: string;
    priority?: EventPriority;
    ttl?: number;
    retryCount?: number;
}

export enum EventPriority {
    LOW = 0,
    NORMAL = 1,
    HIGH = 2,
    CRITICAL = 3
}

export interface EventHandler<T = any> {
    id: string;
    name: string;
    eventType: string | string[];
    handler: (event: Event<T>) => void | Promise<void>;
    filter?: (event: Event<T>) => boolean;
    priority?: number;
    async?: boolean;
    timeout?: number;
    retryPolicy?: RetryPolicy;
}

export interface RetryPolicy {
    maxRetries: number;
    retryDelay: number;
    backoffMultiplier?: number;
    maxRetryDelay?: number;
}

export interface EventSubscription {
    id: string;
    eventType: string;
    handler: EventHandler;
    createdAt: Date;
}

export interface EventBusConfig {
    maxListeners?: number;
    enableLogging?: boolean;
    enableMetrics?: boolean;
    enableReplay?: boolean;
    replayBufferSize?: number;
    defaultTimeout?: number;
    errorHandler?: (error: Error, event: Event) => void;
}

export class EventBus extends EventEmitter {
    private logger = createLogger('EventBus');
    private handlers: Map<string, EventHandler[]> = new Map();
    private subscriptions: Map<string, EventSubscription> = new Map();
    private eventHistory: Event[] = [];
    private metrics = {
        eventsPublished: 0,
        eventsHandled: 0,
        eventsFailed: 0,
        handlerExecutionTime: new Map<string, number[]>()
    };

    constructor(private config: EventBusConfig = {}) {
        super();
        
        this.config = {
            maxListeners: 100,
            enableLogging: true,
            enableMetrics: true,
            enableReplay: false,
            replayBufferSize: 1000,
            defaultTimeout: 30000,
            ...config
        };

        this.setMaxListeners(this.config.maxListeners!);
    }

    /**
     * Publish an event
     */
    public async publish<T = any>(
        type: string,
        data: T,
        source: string,
        metadata?: EventMetadata
    ): Promise<void> {
        const event: Event<T> = {
            id: this.generateEventId(),
            type,
            source,
            timestamp: new Date(),
            version: '1.0',
            data,
            metadata: {
                ...metadata,
                priority: metadata?.priority ?? EventPriority.NORMAL
            }
        };

        if (this.config.enableLogging) {
            this.logger.debug(`Publishing event: ${type}`, {
                eventId: event.id,
                source: event.source
            });
        }

        // Store in history if replay is enabled
        if (this.config.enableReplay) {
            this.addToHistory(event);
        }

        // Update metrics
        this.metrics.eventsPublished++;

        // Process event
        await this.processEvent(event);

        // Emit for legacy compatibility
        this.emit(type, event);
        this.emit('*', event);
    }

    /**
     * Subscribe to events
     */
    public subscribe<T = any>(
        eventType: string | string[],
        handler: (event: Event<T>) => void | Promise<void>,
        options: Partial<EventHandler> = {}
    ): string {
        const eventHandler: EventHandler<T> = {
            id: this.generateHandlerId(),
            name: options.name || 'anonymous',
            eventType,
            handler,
            filter: options.filter,
            priority: options.priority ?? 10,
            async: options.async ?? true,
            timeout: options.timeout ?? this.config.defaultTimeout,
            retryPolicy: options.retryPolicy
        };

        const eventTypes = Array.isArray(eventType) ? eventType : [eventType];

        for (const type of eventTypes) {
            if (!this.handlers.has(type)) {
                this.handlers.set(type, []);
            }

            const handlers = this.handlers.get(type)!;
            handlers.push(eventHandler);

            // Sort by priority (lower number = higher priority)
            handlers.sort((a, b) => (a.priority ?? 10) - (b.priority ?? 10));

            // Create subscription record
            const subscription: EventSubscription = {
                id: eventHandler.id,
                eventType: type,
                handler: eventHandler,
                createdAt: new Date()
            };

            this.subscriptions.set(subscription.id, subscription);
        }

        if (this.config.enableLogging) {
            this.logger.info(`Subscribed to event(s): ${eventTypes.join(', ')}`, {
                handlerId: eventHandler.id,
                handlerName: eventHandler.name
            });
        }

        return eventHandler.id;
    }

    /**
     * Unsubscribe from events
     */
    public unsubscribe(subscriptionId: string): boolean {
        const subscription = this.subscriptions.get(subscriptionId);
        if (!subscription) {
            return false;
        }

        const eventTypes = Array.isArray(subscription.eventType) 
            ? subscription.eventType 
            : [subscription.eventType];

        for (const type of eventTypes) {
            const handlers = this.handlers.get(type);
            if (handlers) {
                const index = handlers.findIndex(h => h.id === subscriptionId);
                if (index !== -1) {
                    handlers.splice(index, 1);
                }

                if (handlers.length === 0) {
                    this.handlers.delete(type);
                }
            }
        }

        this.subscriptions.delete(subscriptionId);

        if (this.config.enableLogging) {
            this.logger.info(`Unsubscribed from event(s): ${eventTypes.join(', ')}`, {
                handlerId: subscriptionId
            });
        }

        return true;
    }

    /**
     * Get event history
     */
    public getEventHistory(
        filter?: {
            type?: string;
            source?: string;
            since?: Date;
            limit?: number;
        }
    ): Event[] {
        let events = [...this.eventHistory];

        if (filter) {
            if (filter.type) {
                events = events.filter(e => e.type === filter.type);
            }

            if (filter.source) {
                events = events.filter(e => e.source === filter.source);
            }

            if (filter.since) {
                events = events.filter(e => e.timestamp > filter.since!);
            }

            if (filter.limit) {
                events = events.slice(-filter.limit);
            }
        }

        return events;
    }

    /**
     * Replay events
     */
    public async replayEvents(
        filter: {
            type?: string;
            source?: string;
            since?: Date;
            until?: Date;
        },
        speed: number = 1
    ): Promise<void> {
        const events = this.getEventHistory(filter);

        if (filter.until) {
            const until = filter.until.getTime();
            events.filter(e => e.timestamp.getTime() <= until);
        }

        this.logger.info(`Replaying ${events.length} events`);

        for (let i = 0; i < events.length; i++) {
            const event = events[i];
            
            // Calculate delay based on timestamp difference
            if (i > 0 && speed > 0) {
                const delay = (event.timestamp.getTime() - events[i - 1].timestamp.getTime()) / speed;
                await new Promise(resolve => setTimeout(resolve, delay));
            }

            await this.processEvent(event);
        }

        this.logger.info('Event replay completed');
    }

    /**
     * Wait for event
     */
    public async waitForEvent<T = any>(
        eventType: string,
        filter?: (event: Event<T>) => boolean,
        timeout?: number
    ): Promise<Event<T>> {
        return new Promise((resolve, reject) => {
            const timeoutMs = timeout ?? this.config.defaultTimeout!;
            let timeoutId: NodeJS.Timeout;

            const handler = (event: Event<T>) => {
                if (!filter || filter(event)) {
                    clearTimeout(timeoutId);
                    this.off(eventType, handler);
                    resolve(event);
                }
            };

            timeoutId = setTimeout(() => {
                this.off(eventType, handler);
                reject(new Error(`Timeout waiting for event: ${eventType}`));
            }, timeoutMs);

            this.on(eventType, handler);
        });
    }

    /**
     * Get metrics
     */
    public getMetrics(): {
        eventsPublished: number;
        eventsHandled: number;
        eventsFailed: number;
        handlerStats: Array<{
            handlerId: string;
            averageExecutionTime: number;
            totalExecutions: number;
        }>;
        subscriptionCount: number;
        handlerCount: number;
    } {
        const handlerStats = Array.from(this.metrics.handlerExecutionTime.entries())
            .map(([handlerId, times]) => ({
                handlerId,
                averageExecutionTime: times.reduce((a, b) => a + b, 0) / times.length,
                totalExecutions: times.length
            }));

        return {
            eventsPublished: this.metrics.eventsPublished,
            eventsHandled: this.metrics.eventsHandled,
            eventsFailed: this.metrics.eventsFailed,
            handlerStats,
            subscriptionCount: this.subscriptions.size,
            handlerCount: Array.from(this.handlers.values())
                .reduce((sum, handlers) => sum + handlers.length, 0)
        };
    }

    /**
     * Clear all handlers
     */
    public clear(): void {
        this.handlers.clear();
        this.subscriptions.clear();
        this.eventHistory = [];
        this.removeAllListeners();
        
        this.logger.info('Event bus cleared');
    }

    // Private methods

    private async processEvent(event: Event): Promise<void> {
        const handlers = this.getHandlersForEvent(event);

        if (handlers.length === 0) {
            if (this.config.enableLogging) {
                this.logger.debug(`No handlers for event: ${event.type}`);
            }
            return;
        }

        // Execute handlers based on priority
        for (const handler of handlers) {
            try {
                // Check filter
                if (handler.filter && !handler.filter(event)) {
                    continue;
                }

                // Execute handler
                if (handler.async) {
                    this.executeHandlerAsync(handler, event);
                } else {
                    await this.executeHandler(handler, event);
                }

            } catch (error) {
                this.handleError(error, event, handler);
            }
        }
    }

    private getHandlersForEvent(event: Event): EventHandler[] {
        const handlers: EventHandler[] = [];

        // Get specific handlers
        const specificHandlers = this.handlers.get(event.type) || [];
        handlers.push(...specificHandlers);

        // Get wildcard handlers
        const wildcardHandlers = this.handlers.get('*') || [];
        handlers.push(...wildcardHandlers);

        // Sort by priority
        return handlers.sort((a, b) => (a.priority ?? 10) - (b.priority ?? 10));
    }

    private async executeHandler(
        handler: EventHandler,
        event: Event,
        retryCount: number = 0
    ): Promise<void> {
        const startTime = performance.now();

        try {
            // Create timeout promise
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Handler timeout')), handler.timeout!);
            });

            // Execute handler with timeout
            await Promise.race([
                handler.handler(event),
                timeoutPromise
            ]);

            // Update metrics
            this.recordHandlerExecution(handler.id, performance.now() - startTime);
            this.metrics.eventsHandled++;

        } catch (error) {
            // Retry logic
            if (handler.retryPolicy && retryCount < handler.retryPolicy.maxRetries) {
                const delay = this.calculateRetryDelay(handler.retryPolicy, retryCount);
                
                this.logger.warn(`Retrying handler ${handler.name} after ${delay}ms`, {
                    eventType: event.type,
                    retryCount: retryCount + 1,
                    error: error.message
                });

                await new Promise(resolve => setTimeout(resolve, delay));
                await this.executeHandler(handler, event, retryCount + 1);
            } else {
                throw error;
            }
        }
    }

    private executeHandlerAsync(handler: EventHandler, event: Event): void {
        this.executeHandler(handler, event).catch(error => {
            this.handleError(error, event, handler);
        });
    }

    private calculateRetryDelay(policy: RetryPolicy, retryCount: number): number {
        const baseDelay = policy.retryDelay;
        const multiplier = policy.backoffMultiplier ?? 2;
        const maxDelay = policy.maxRetryDelay ?? 60000;

        const delay = baseDelay * Math.pow(multiplier, retryCount);
        return Math.min(delay, maxDelay);
    }

    private handleError(error: any, event: Event, handler: EventHandler): void {
        this.metrics.eventsFailed++;

        this.logger.error(`Error in event handler: ${handler.name}`, {
            eventType: event.type,
            eventId: event.id,
            handlerId: handler.id,
            error: error.message,
            stack: error.stack
        });

        if (this.config.errorHandler) {
            try {
                this.config.errorHandler(error, event);
            } catch (err) {
                this.logger.error('Error in error handler', err);
            }
        }

        this.emit('error', {
            error,
            event,
            handler
        });
    }

    private addToHistory(event: Event): void {
        this.eventHistory.push(event);

        // Maintain buffer size
        if (this.eventHistory.length > this.config.replayBufferSize!) {
            this.eventHistory.shift();
        }
    }

    private recordHandlerExecution(handlerId: string, executionTime: number): void {
        if (!this.config.enableMetrics) return;

        if (!this.metrics.handlerExecutionTime.has(handlerId)) {
            this.metrics.handlerExecutionTime.set(handlerId, []);
        }

        const times = this.metrics.handlerExecutionTime.get(handlerId)!;
        times.push(executionTime);

        // Keep only last 100 execution times
        if (times.length > 100) {
            times.shift();
        }
    }

    private generateEventId(): string {
        return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    private generateHandlerId(): string {
        return `hdl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}

// Singleton instance
let eventBusInstance: EventBus | null = null;

export function getEventBus(config?: EventBusConfig): EventBus {
    if (!eventBusInstance) {
        eventBusInstance = new EventBus(config);
    }
    return eventBusInstance;
}

// Type-safe event types
export const EVENT_TYPES = {
    // Pool events
    POOL_STARTED: 'pool.started',
    POOL_STOPPED: 'pool.stopped',
    POOL_STATS_UPDATED: 'pool.stats.updated',
    
    // Block events
    BLOCK_FOUND: 'block.found',
    BLOCK_CONFIRMED: 'block.confirmed',
    BLOCK_ORPHANED: 'block.orphaned',
    
    // Share events
    SHARE_SUBMITTED: 'share.submitted',
    SHARE_ACCEPTED: 'share.accepted',
    SHARE_REJECTED: 'share.rejected',
    
    // Miner events
    MINER_CONNECTED: 'miner.connected',
    MINER_DISCONNECTED: 'miner.disconnected',
    MINER_AUTHENTICATED: 'miner.authenticated',
    MINER_BANNED: 'miner.banned',
    
    // Payment events
    PAYMENT_PENDING: 'payment.pending',
    PAYMENT_SENT: 'payment.sent',
    PAYMENT_CONFIRMED: 'payment.confirmed',
    PAYMENT_FAILED: 'payment.failed',
    
    // System events
    CONFIG_CHANGED: 'config.changed',
    ERROR_OCCURRED: 'error.occurred',
    HEALTH_CHECK: 'health.check'
} as const;

// Type helpers
export type EventType = typeof EVENT_TYPES[keyof typeof EVENT_TYPES];
