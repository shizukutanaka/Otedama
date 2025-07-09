/**
 * Event Driven System - Decoupled Event Architecture
 * 
 * Design Philosophy:
 * - Carmack: Fast event processing, minimal overhead
 * - Martin: Clear event boundaries, loose coupling
 * - Pike: Simple event model, predictable flow
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { UnifiedLogger } from '../logging/unified-logger';
import { UnifiedMetrics } from '../metrics/unified-metrics';

export interface DomainEvent {
  id: string;
  type: string;
  aggregateId: string;
  aggregateType: string;
  version: number;
  timestamp: Date;
  data: any;
  metadata?: Record<string, any>;
  correlationId?: string;
  causationId?: string;
}

export interface EventHandler<T = any> {
  eventType: string;
  handle(event: DomainEvent<T>): Promise<void> | void;
  priority?: number;
  retry?: RetryPolicy;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export interface EventSubscription {
  id: string;
  eventType: string;
  handler: EventHandler;
  isActive: boolean;
  createdAt: Date;
  lastTriggered?: Date;
  successCount: number;
  errorCount: number;
}

export interface EventStore {
  append(events: DomainEvent[]): Promise<void>;
  getEvents(aggregateId: string, fromVersion?: number): Promise<DomainEvent[]>;
  getEventsByType(eventType: string, limit?: number): Promise<DomainEvent[]>;
  getAllEvents(fromTimestamp?: Date, limit?: number): Promise<DomainEvent[]>;
}

export interface EventProjection {
  name: string;
  eventTypes: string[];
  project(event: DomainEvent): Promise<void>;
  rebuild?(): Promise<void>;
}

export class InMemoryEventStore implements EventStore {
  private events: Map<string, DomainEvent[]> = new Map();
  private allEvents: DomainEvent[] = [];

  public async append(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      const aggregateEvents = this.events.get(event.aggregateId) || [];
      aggregateEvents.push(event);
      this.events.set(event.aggregateId, aggregateEvents);
      this.allEvents.push(event);
    }
  }

  public async getEvents(aggregateId: string, fromVersion = 0): Promise<DomainEvent[]> {
    const events = this.events.get(aggregateId) || [];
    return events.filter(e => e.version >= fromVersion);
  }

  public async getEventsByType(eventType: string, limit = 100): Promise<DomainEvent[]> {
    return this.allEvents
      .filter(e => e.type === eventType)
      .slice(-limit);
  }

  public async getAllEvents(fromTimestamp?: Date, limit = 100): Promise<DomainEvent[]> {
    let filtered = this.allEvents;
    
    if (fromTimestamp) {
      filtered = filtered.filter(e => e.timestamp >= fromTimestamp);
    }
    
    return filtered.slice(-limit);
  }
}

export class EventBus extends EventEmitter {
  private subscriptions: Map<string, EventSubscription[]> = new Map();
  private projections: Map<string, EventProjection> = new Map();
  private eventStore: EventStore;
  private isProcessing = false;
  private eventQueue: DomainEvent[] = [];
  private processingInterval: NodeJS.Timeout | null = null;

  constructor(
    private logger: UnifiedLogger,
    private metrics: UnifiedMetrics,
    eventStore?: EventStore,
    private config = {
      batchSize: 10,
      processingIntervalMs: 100,
      enableRetries: true,
      defaultRetryPolicy: {
        maxAttempts: 3,
        backoffMs: 1000,
        maxBackoffMs: 30000
      }
    }
  ) {
    super();
    this.eventStore = eventStore || new InMemoryEventStore();
    this.startProcessing();
  }

  public async start(): Promise<void> {
    this.logger.info('Starting Event Bus...');
    this.logger.info('Event Bus started');
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping Event Bus...');
    
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    // Process remaining events
    await this.processEventQueue();

    this.logger.info('Event Bus stopped');
  }

  // Event publishing
  public async publish(event: DomainEvent): Promise<void> {
    await this.publishBatch([event]);
  }

  public async publishBatch(events: DomainEvent[]): Promise<void> {
    // Store events
    await this.eventStore.append(events);

    // Add to processing queue
    this.eventQueue.push(...events);

    // Update metrics
    this.metrics?.incrementCounter('events_published_total', events.length);

    this.logger.debug(`Published ${events.length} events to queue`);
  }

  // Event subscription
  public subscribe<T = any>(eventType: string, handler: EventHandler<T>): string {
    const subscription: EventSubscription = {
      id: uuidv4(),
      eventType,
      handler: handler as EventHandler,
      isActive: true,
      createdAt: new Date(),
      successCount: 0,
      errorCount: 0
    };

    const typeSubscriptions = this.subscriptions.get(eventType) || [];
    typeSubscriptions.push(subscription);
    
    // Sort by priority (higher priority first)
    typeSubscriptions.sort((a, b) => (b.handler.priority || 0) - (a.handler.priority || 0));
    
    this.subscriptions.set(eventType, typeSubscriptions);

    this.logger.info(`Subscribed to event type: ${eventType}`, { subscriptionId: subscription.id });
    return subscription.id;
  }

  public unsubscribe(subscriptionId: string): boolean {
    for (const [eventType, subscriptions] of this.subscriptions.entries()) {
      const index = subscriptions.findIndex(s => s.id === subscriptionId);
      if (index >= 0) {
        subscriptions.splice(index, 1);
        this.logger.info(`Unsubscribed from event type: ${eventType}`, { subscriptionId });
        return true;
      }
    }
    return false;
  }

  public activateSubscription(subscriptionId: string): boolean {
    return this.setSubscriptionStatus(subscriptionId, true);
  }

  public deactivateSubscription(subscriptionId: string): boolean {
    return this.setSubscriptionStatus(subscriptionId, false);
  }

  // Projections
  public addProjection(projection: EventProjection): void {
    this.projections.set(projection.name, projection);
    
    // Subscribe to relevant event types
    for (const eventType of projection.eventTypes) {
      this.subscribe(eventType, {
        eventType,
        handle: async (event) => {
          try {
            await projection.project(event);
          } catch (error) {
            this.logger.error(`Error in projection ${projection.name} for event ${event.type}:`, error);
          }
        },
        priority: -100 // Lower priority than regular handlers
      });
    }

    this.logger.info(`Added projection: ${projection.name}`);
  }

  public removeProjection(name: string): boolean {
    const removed = this.projections.delete(name);
    if (removed) {
      this.logger.info(`Removed projection: ${name}`);
    }
    return removed;
  }

  public async rebuildProjection(name: string): Promise<void> {
    const projection = this.projections.get(name);
    if (!projection || !projection.rebuild) {
      throw new Error(`Projection ${name} not found or does not support rebuild`);
    }

    this.logger.info(`Rebuilding projection: ${name}`);
    await projection.rebuild();
    this.logger.info(`Projection rebuilt: ${name}`);
  }

  // Event store access
  public async getEvents(aggregateId: string, fromVersion?: number): Promise<DomainEvent[]> {
    return await this.eventStore.getEvents(aggregateId, fromVersion);
  }

  public async getEventsByType(eventType: string, limit?: number): Promise<DomainEvent[]> {
    return await this.eventStore.getEventsByType(eventType, limit);
  }

  public async getAllEvents(fromTimestamp?: Date, limit?: number): Promise<DomainEvent[]> {
    return await this.eventStore.getAllEvents(fromTimestamp, limit);
  }

  // Statistics
  public getSubscriptionStats(): Record<string, {
    activeSubscriptions: number;
    totalSubscriptions: number;
    successCount: number;
    errorCount: number;
  }> {
    const stats: Record<string, any> = {};

    for (const [eventType, subscriptions] of this.subscriptions.entries()) {
      stats[eventType] = {
        activeSubscriptions: subscriptions.filter(s => s.isActive).length,
        totalSubscriptions: subscriptions.length,
        successCount: subscriptions.reduce((sum, s) => sum + s.successCount, 0),
        errorCount: subscriptions.reduce((sum, s) => sum + s.errorCount, 0)
      };
    }

    return stats;
  }

  public getEventStats(): {
    queueSize: number;
    processedEvents: number;
    failedEvents: number;
    projectionCount: number;
  } {
    return {
      queueSize: this.eventQueue.length,
      processedEvents: 0, // Would need to track this
      failedEvents: 0, // Would need to track this
      projectionCount: this.projections.size
    };
  }

  private startProcessing(): void {
    this.processingInterval = setInterval(async () => {
      if (!this.isProcessing && this.eventQueue.length > 0) {
        await this.processEventQueue();
      }
    }, this.config.processingIntervalMs);
  }

  private async processEventQueue(): Promise<void> {
    if (this.isProcessing || this.eventQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      const batch = this.eventQueue.splice(0, this.config.batchSize);
      await Promise.all(batch.map(event => this.processEvent(event)));
    } catch (error) {
      this.logger.error('Error processing event queue:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  private async processEvent(event: DomainEvent): Promise<void> {
    const subscriptions = this.subscriptions.get(event.type) || [];
    const activeSubscriptions = subscriptions.filter(s => s.isActive);

    if (activeSubscriptions.length === 0) {
      return;
    }

    this.logger.debug(`Processing event ${event.type} for ${activeSubscriptions.length} handlers`);

    const promises = activeSubscriptions.map(subscription => 
      this.executeHandler(event, subscription)
    );

    await Promise.allSettled(promises);

    // Emit for external listeners
    this.emit('eventProcessed', event);
    this.metrics?.incrementCounter('events_processed_total');
  }

  private async executeHandler(event: DomainEvent, subscription: EventSubscription): Promise<void> {
    const startTime = Date.now();

    try {
      await subscription.handler.handle(event);
      
      subscription.successCount++;
      subscription.lastTriggered = new Date();
      
      const duration = Date.now() - startTime;
      this.metrics?.recordHistogram('event_handler_duration_ms', duration, {
        eventType: event.type,
        handlerType: subscription.handler.constructor.name
      });

    } catch (error) {
      subscription.errorCount++;
      
      this.logger.error(`Handler failed for event ${event.type}:`, {
        subscriptionId: subscription.id,
        error: error instanceof Error ? error.message : String(error)
      });

      // Retry logic
      if (this.config.enableRetries && subscription.handler.retry) {
        await this.retryHandler(event, subscription, error);
      }

      this.metrics?.incrementCounter('event_handler_errors_total', {
        eventType: event.type,
        handlerType: subscription.handler.constructor.name
      });
    }
  }

  private async retryHandler(event: DomainEvent, subscription: EventSubscription, originalError: any): Promise<void> {
    const retryPolicy = subscription.handler.retry || this.config.defaultRetryPolicy;
    
    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
      const delay = Math.min(
        retryPolicy.backoffMs * Math.pow(2, attempt - 1),
        retryPolicy.maxBackoffMs
      );

      this.logger.debug(`Retrying handler for event ${event.type}, attempt ${attempt}/${retryPolicy.maxAttempts}`);

      await new Promise(resolve => setTimeout(resolve, delay));

      try {
        await subscription.handler.handle(event);
        subscription.successCount++;
        this.logger.info(`Handler retry succeeded for event ${event.type} on attempt ${attempt}`);
        return;
      } catch (retryError) {
        if (attempt === retryPolicy.maxAttempts) {
          this.logger.error(`Handler retry failed permanently for event ${event.type}:`, {
            attempts: retryPolicy.maxAttempts,
            originalError: originalError instanceof Error ? originalError.message : String(originalError),
            finalError: retryError instanceof Error ? retryError.message : String(retryError)
          });
        }
      }
    }
  }

  private setSubscriptionStatus(subscriptionId: string, isActive: boolean): boolean {
    for (const subscriptions of this.subscriptions.values()) {
      const subscription = subscriptions.find(s => s.id === subscriptionId);
      if (subscription) {
        subscription.isActive = isActive;
        return true;
      }
    }
    return false;
  }
}

// Event Factory and Utilities
export class EventFactory {
  public static createEvent(
    type: string,
    aggregateId: string,
    aggregateType: string,
    data: any,
    options: {
      version?: number;
      metadata?: Record<string, any>;
      correlationId?: string;
      causationId?: string;
    } = {}
  ): DomainEvent {
    return {
      id: uuidv4(),
      type,
      aggregateId,
      aggregateType,
      version: options.version || 1,
      timestamp: new Date(),
      data,
      metadata: options.metadata,
      correlationId: options.correlationId,
      causationId: options.causationId
    };
  }

  // Mining-specific events
  public static createBlockFoundEvent(blockData: any, minerId: string): DomainEvent {
    return this.createEvent('BlockFound', blockData.hash, 'Block', blockData, {
      metadata: { minerId, reward: blockData.reward }
    });
  }

  public static createShareSubmittedEvent(shareData: any, minerId: string): DomainEvent {
    return this.createEvent('ShareSubmitted', shareData.id, 'Share', shareData, {
      metadata: { minerId, difficulty: shareData.difficulty }
    });
  }

  public static createPayoutProcessedEvent(payoutData: any, minerId: string): DomainEvent {
    return this.createEvent('PayoutProcessed', payoutData.id, 'Payout', payoutData, {
      metadata: { minerId, amount: payoutData.amount }
    });
  }

  public static createMinerConnectedEvent(minerData: any): DomainEvent {
    return this.createEvent('MinerConnected', minerData.id, 'Miner', minerData, {
      metadata: { ip: minerData.ip, userAgent: minerData.userAgent }
    });
  }

  public static createMinerDisconnectedEvent(minerData: any): DomainEvent {
    return this.createEvent('MinerDisconnected', minerData.id, 'Miner', minerData, {
      metadata: { duration: minerData.sessionDuration }
    });
  }
}

// Common Event Handlers
export class LoggingEventHandler implements EventHandler {
  constructor(
    public eventType: string,
    private logger: UnifiedLogger,
    public priority = 0
  ) {}

  public handle(event: DomainEvent): void {
    this.logger.info(`Event: ${event.type}`, {
      eventId: event.id,
      aggregateId: event.aggregateId,
      aggregateType: event.aggregateType,
      timestamp: event.timestamp
    });
  }
}

export class MetricsEventHandler implements EventHandler {
  constructor(
    public eventType: string,
    private metrics: UnifiedMetrics,
    public priority = 0
  ) {}

  public handle(event: DomainEvent): void {
    this.metrics.incrementCounter('domain_events_total', {
      eventType: event.type,
      aggregateType: event.aggregateType
    });
  }
}

// Common Projections
export class MinerStatsProjection implements EventProjection {
  public name = 'MinerStats';
  public eventTypes = ['ShareSubmitted', 'MinerConnected', 'MinerDisconnected', 'BlockFound'];
  
  private stats: Map<string, any> = new Map();

  constructor(private logger: UnifiedLogger) {}

  public async project(event: DomainEvent): Promise<void> {
    const minerId = event.metadata?.minerId || event.aggregateId;
    
    switch (event.type) {
      case 'ShareSubmitted':
        this.updateShareStats(minerId, event.data);
        break;
      case 'MinerConnected':
        this.updateConnectionStats(minerId, event.data, true);
        break;
      case 'MinerDisconnected':
        this.updateConnectionStats(minerId, event.data, false);
        break;
      case 'BlockFound':
        this.updateBlockStats(minerId, event.data);
        break;
    }
  }

  public async rebuild(): Promise<void> {
    this.stats.clear();
    this.logger.info('MinerStats projection rebuilt');
  }

  public getStats(minerId: string): any {
    return this.stats.get(minerId);
  }

  public getAllStats(): Map<string, any> {
    return new Map(this.stats);
  }

  private updateShareStats(minerId: string, shareData: any): void {
    const stats = this.stats.get(minerId) || { shares: 0, difficulty: 0 };
    stats.shares++;
    stats.difficulty += shareData.difficulty || 0;
    stats.lastShare = new Date();
    this.stats.set(minerId, stats);
  }

  private updateConnectionStats(minerId: string, minerData: any, connected: boolean): void {
    const stats = this.stats.get(minerId) || {};
    if (connected) {
      stats.lastConnected = new Date();
      stats.isConnected = true;
    } else {
      stats.isConnected = false;
      stats.sessionDuration = minerData.sessionDuration || 0;
    }
    this.stats.set(minerId, stats);
  }

  private updateBlockStats(minerId: string, blockData: any): void {
    const stats = this.stats.get(minerId) || { blocksFound: 0 };
    stats.blocksFound++;
    stats.lastBlock = new Date();
    stats.lastBlockReward = blockData.reward;
    this.stats.set(minerId, stats);
  }
}