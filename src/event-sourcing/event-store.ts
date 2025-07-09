// src/event-sourcing/event-store.ts
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import crypto from 'crypto';

export interface DomainEvent {
  eventId: string;
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  eventVersion: number;
  eventData: any;
  metadata: {
    userId?: string;
    timestamp: number;
    correlationId?: string;
    causationId?: string;
    source: string;
  };
  checksum: string;
}

export interface Snapshot {
  snapshotId: string;
  aggregateId: string;
  aggregateType: string;
  version: number;
  data: any;
  timestamp: number;
  checksum: string;
}

export interface EventStoreOptions {
  snapshotThreshold: number; // Take snapshot every N events
  batchSize: number;
  retention: number; // Days to retain events
}

export interface AggregateRoot {
  id: string;
  version: number;
  uncommittedEvents: DomainEvent[];
  
  markEventsAsCommitted(): void;
  getUncommittedEvents(): DomainEvent[];
  loadFromHistory(events: DomainEvent[]): void;
  applyEvent(event: DomainEvent): void;
}

export class EventStore {
  private logger: Logger;
  private cache: RedisCache;
  private options: EventStoreOptions;
  private eventHandlers: Map<string, ((event: DomainEvent) => Promise<void>)[]> = new Map();

  constructor(
    logger: Logger,
    cache: RedisCache,
    options: EventStoreOptions = {
      snapshotThreshold: 100,
      batchSize: 1000,
      retention: 365
    }
  ) {
    this.logger = logger;
    this.cache = cache;
    this.options = options;
  }

  // Event persistence
  public async saveEvents(
    aggregateId: string,
    events: DomainEvent[],
    expectedVersion: number
  ): Promise<void> {
    if (events.length === 0) return;

    const startTime = Date.now();
    
    try {
      // Check for concurrency conflicts
      const currentVersion = await this.getAggregateVersion(aggregateId);
      if (currentVersion !== expectedVersion) {
        throw new Error(`Concurrency conflict: expected version ${expectedVersion}, got ${currentVersion}`);
      }

      // Add checksums and validate events
      const validatedEvents = events.map(event => ({
        ...event,
        checksum: this.calculateChecksum(event)
      }));

      // Store events atomically
      await this.persistEvents(aggregateId, validatedEvents);
      
      // Update aggregate version
      const newVersion = expectedVersion + events.length;
      await this.updateAggregateVersion(aggregateId, newVersion);

      // Check if snapshot needed
      if (newVersion > 0 && newVersion % this.options.snapshotThreshold === 0) {
        await this.scheduleSnapshot(aggregateId);
      }

      // Publish events to handlers
      await this.publishEvents(validatedEvents);

      const duration = Date.now() - startTime;
      this.logger.info(`Saved ${events.length} events for aggregate ${aggregateId}`, {
        aggregateId,
        eventCount: events.length,
        newVersion,
        duration
      });

    } catch (error) {
      this.logger.error(`Failed to save events for aggregate ${aggregateId}:`, error);
      throw error;
    }
  }

  public async getEvents(
    aggregateId: string,
    fromVersion: number = 0,
    toVersion?: number
  ): Promise<DomainEvent[]> {
    try {
      const cacheKey = `events:${aggregateId}:${fromVersion}:${toVersion || 'latest'}`;
      const cached = await this.cache.get(cacheKey);
      
      if (cached) {
        return JSON.parse(cached);
      }

      const events = await this.loadEventsFromStorage(aggregateId, fromVersion, toVersion);
      
      // Validate checksums
      const validatedEvents = events.filter(event => {
        const expectedChecksum = this.calculateChecksum(event);
        if (event.checksum !== expectedChecksum) {
          this.logger.warn(`Checksum mismatch for event ${event.eventId}`);
          return false;
        }
        return true;
      });

      // Cache for future reads
      await this.cache.set(cacheKey, JSON.stringify(validatedEvents), 300); // 5 minutes

      return validatedEvents;
    } catch (error) {
      this.logger.error(`Failed to get events for aggregate ${aggregateId}:`, error);
      throw error;
    }
  }

  // Aggregate loading with snapshots
  public async loadAggregate<T extends AggregateRoot>(
    aggregateId: string,
    aggregateFactory: () => T
  ): Promise<T> {
    try {
      const aggregate = aggregateFactory();
      aggregate.id = aggregateId;

      // Try to load from snapshot first
      const snapshot = await this.getLatestSnapshot(aggregateId);
      let fromVersion = 0;

      if (snapshot) {
        this.loadAggregateFromSnapshot(aggregate, snapshot);
        fromVersion = snapshot.version + 1;
      }

      // Load events since snapshot
      const events = await this.getEvents(aggregateId, fromVersion);
      aggregate.loadFromHistory(events);

      return aggregate;
    } catch (error) {
      this.logger.error(`Failed to load aggregate ${aggregateId}:`, error);
      throw error;
    }
  }

  public async saveAggregate<T extends AggregateRoot>(aggregate: T): Promise<void> {
    const uncommittedEvents = aggregate.getUncommittedEvents();
    if (uncommittedEvents.length === 0) return;

    await this.saveEvents(aggregate.id, uncommittedEvents, aggregate.version);
    aggregate.markEventsAsCommitted();
  }

  // Snapshot management
  public async saveSnapshot(snapshot: Snapshot): Promise<void> {
    try {
      snapshot.checksum = this.calculateSnapshotChecksum(snapshot);
      
      const key = `snapshot:${snapshot.aggregateId}:${snapshot.version}`;
      await this.cache.set(key, JSON.stringify(snapshot), 86400 * 7); // 7 days

      // Update latest snapshot pointer
      const latestKey = `snapshot:latest:${snapshot.aggregateId}`;
      await this.cache.set(latestKey, JSON.stringify(snapshot), 86400 * 7);

      this.logger.debug(`Snapshot saved for aggregate ${snapshot.aggregateId} at version ${snapshot.version}`);
    } catch (error) {
      this.logger.error(`Failed to save snapshot:`, error);
      throw error;
    }
  }

  public async getLatestSnapshot(aggregateId: string): Promise<Snapshot | null> {
    try {
      const key = `snapshot:latest:${aggregateId}`;
      const cached = await this.cache.get(key);
      
      if (!cached) return null;

      const snapshot = JSON.parse(cached) as Snapshot;
      
      // Validate checksum
      const expectedChecksum = this.calculateSnapshotChecksum(snapshot);
      if (snapshot.checksum !== expectedChecksum) {
        this.logger.warn(`Snapshot checksum mismatch for aggregate ${aggregateId}`);
        return null;
      }

      return snapshot;
    } catch (error) {
      this.logger.error(`Failed to get latest snapshot for ${aggregateId}:`, error);
      return null;
    }
  }

  // Event handlers registration
  public registerEventHandler(
    eventType: string,
    handler: (event: DomainEvent) => Promise<void>
  ): void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, []);
    }
    
    this.eventHandlers.get(eventType)!.push(handler);
    this.logger.info(`Event handler registered for: ${eventType}`);
  }

  // Event projection and read models
  public async projectEvents(
    eventTypes: string[],
    fromTimestamp: number = 0,
    handler: (event: DomainEvent) => Promise<void>
  ): Promise<void> {
    try {
      const events = await this.getAllEventsByTypes(eventTypes, fromTimestamp);
      
      for (const event of events) {
        await handler(event);
      }

      this.logger.info(`Projected ${events.length} events of types: ${eventTypes.join(', ')}`);
    } catch (error) {
      this.logger.error('Event projection failed:', error);
      throw error;
    }
  }

  // Event replay functionality
  public async replayEvents(
    aggregateId: string,
    fromVersion: number = 0,
    replayHandler: (event: DomainEvent) => Promise<void>
  ): Promise<void> {
    try {
      const events = await this.getEvents(aggregateId, fromVersion);
      
      for (const event of events) {
        await replayHandler(event);
      }

      this.logger.info(`Replayed ${events.length} events for aggregate ${aggregateId}`);
    } catch (error) {
      this.logger.error(`Event replay failed for aggregate ${aggregateId}:`, error);
      throw error;
    }
  }

  // Audit and compliance
  public async getEventHistory(
    aggregateId: string,
    userId?: string,
    fromDate?: Date,
    toDate?: Date
  ): Promise<DomainEvent[]> {
    const events = await this.getEvents(aggregateId);
    
    return events.filter(event => {
      if (userId && event.metadata.userId !== userId) return false;
      if (fromDate && event.metadata.timestamp < fromDate.getTime()) return false;
      if (toDate && event.metadata.timestamp > toDate.getTime()) return false;
      return true;
    });
  }

  public async getAuditTrail(
    aggregateId: string,
    detailed: boolean = false
  ): Promise<any[]> {
    const events = await this.getEvents(aggregateId);
    
    return events.map(event => ({
      timestamp: new Date(event.metadata.timestamp),
      eventType: event.eventType,
      userId: event.metadata.userId,
      correlationId: event.metadata.correlationId,
      source: event.metadata.source,
      ...(detailed && { eventData: event.eventData })
    }));
  }

  // Private helper methods
  private async persistEvents(aggregateId: string, events: DomainEvent[]): Promise<void> {
    // In a real implementation, this would use a database transaction
    for (const event of events) {
      const key = `event:${aggregateId}:${event.eventVersion}`;
      await this.cache.set(key, JSON.stringify(event), 86400 * this.options.retention);
    }

    // Update event stream
    const streamKey = `stream:${aggregateId}`;
    const eventIds = events.map(e => e.eventId);
    await this.cache.set(streamKey, JSON.stringify(eventIds), 86400 * this.options.retention);
  }

  private async loadEventsFromStorage(
    aggregateId: string,
    fromVersion: number,
    toVersion?: number
  ): Promise<DomainEvent[]> {
    const events: DomainEvent[] = [];
    const maxVersion = toVersion || await this.getAggregateVersion(aggregateId);

    for (let version = fromVersion; version <= maxVersion; version++) {
      const key = `event:${aggregateId}:${version}`;
      const eventData = await this.cache.get(key);
      
      if (eventData) {
        events.push(JSON.parse(eventData));
      }
    }

    return events.sort((a, b) => a.eventVersion - b.eventVersion);
  }

  private async getAggregateVersion(aggregateId: string): Promise<number> {
    const key = `version:${aggregateId}`;
    const version = await this.cache.get(key);
    return version ? parseInt(version) : 0;
  }

  private async updateAggregateVersion(aggregateId: string, version: number): Promise<void> {
    const key = `version:${aggregateId}`;
    await this.cache.set(key, version.toString(), 86400 * this.options.retention);
  }

  private async getAllEventsByTypes(eventTypes: string[], fromTimestamp: number): Promise<DomainEvent[]> {
    // Simplified implementation - in production, would use proper indexing
    const allEvents: DomainEvent[] = [];
    
    // This is a simplified approach - real implementation would have better indexing
    const keys = await this.cache.keys('event:*');
    
    for (const key of keys) {
      const eventData = await this.cache.get(key);
      if (eventData) {
        const event = JSON.parse(eventData) as DomainEvent;
        if (eventTypes.includes(event.eventType) && 
            event.metadata.timestamp >= fromTimestamp) {
          allEvents.push(event);
        }
      }
    }

    return allEvents.sort((a, b) => a.metadata.timestamp - b.metadata.timestamp);
  }

  private async publishEvents(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      const handlers = this.eventHandlers.get(event.eventType) || [];
      
      const promises = handlers.map(async (handler) => {
        try {
          await handler(event);
        } catch (error) {
          this.logger.error(`Event handler failed for ${event.eventType}:`, error);
        }
      });

      await Promise.allSettled(promises);
    }
  }

  private async scheduleSnapshot(aggregateId: string): Promise<void> {
    // In production, this would be handled by a background job
    setImmediate(async () => {
      try {
        const aggregate = await this.loadAggregate(aggregateId, () => ({} as any));
        
        const snapshot: Snapshot = {
          snapshotId: crypto.randomUUID(),
          aggregateId,
          aggregateType: 'Miner', // Would be dynamic in real implementation
          version: aggregate.version,
          data: aggregate,
          timestamp: Date.now(),
          checksum: ''
        };

        await this.saveSnapshot(snapshot);
      } catch (error) {
        this.logger.error(`Failed to create snapshot for ${aggregateId}:`, error);
      }
    });
  }

  private loadAggregateFromSnapshot<T extends AggregateRoot>(
    aggregate: T,
    snapshot: Snapshot
  ): void {
    Object.assign(aggregate, snapshot.data);
    aggregate.version = snapshot.version;
  }

  private calculateChecksum(event: DomainEvent): string {
    const data = {
      eventId: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      eventData: event.eventData,
      timestamp: event.metadata.timestamp
    };
    
    return crypto.createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
  }

  private calculateSnapshotChecksum(snapshot: Snapshot): string {
    const data = {
      snapshotId: snapshot.snapshotId,
      aggregateId: snapshot.aggregateId,
      version: snapshot.version,
      data: snapshot.data,
      timestamp: snapshot.timestamp
    };
    
    return crypto.createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
  }

  // Maintenance operations
  public async cleanupOldEvents(retentionDays: number = this.options.retention): Promise<number> {
    const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    let cleanedCount = 0;

    try {
      const keys = await this.cache.keys('event:*');
      
      for (const key of keys) {
        const eventData = await this.cache.get(key);
        if (eventData) {
          const event = JSON.parse(eventData) as DomainEvent;
          if (event.metadata.timestamp < cutoffTime) {
            await this.cache.del(key);
            cleanedCount++;
          }
        }
      }

      this.logger.info(`Cleaned up ${cleanedCount} old events`);
      return cleanedCount;
    } catch (error) {
      this.logger.error('Event cleanup failed:', error);
      throw error;
    }
  }

  public async getEventStoreStats(): Promise<{
    totalEvents: number;
    totalAggregates: number;
    totalSnapshots: number;
    oldestEvent: Date | null;
    newestEvent: Date | null;
  }> {
    try {
      const eventKeys = await this.cache.keys('event:*');
      const versionKeys = await this.cache.keys('version:*');
      const snapshotKeys = await this.cache.keys('snapshot:*');

      let oldestTimestamp = Infinity;
      let newestTimestamp = 0;

      for (const key of eventKeys) {
        const eventData = await this.cache.get(key);
        if (eventData) {
          const event = JSON.parse(eventData) as DomainEvent;
          oldestTimestamp = Math.min(oldestTimestamp, event.metadata.timestamp);
          newestTimestamp = Math.max(newestTimestamp, event.metadata.timestamp);
        }
      }

      return {
        totalEvents: eventKeys.length,
        totalAggregates: versionKeys.length,
        totalSnapshots: snapshotKeys.length,
        oldestEvent: oldestTimestamp === Infinity ? null : new Date(oldestTimestamp),
        newestEvent: newestTimestamp === 0 ? null : new Date(newestTimestamp)
      };
    } catch (error) {
      this.logger.error('Failed to get event store stats:', error);
      throw error;
    }
  }
}