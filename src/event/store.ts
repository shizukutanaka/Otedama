import { Event, EventType } from './types';
import { logger } from '../logging/logger';
import { PoolEvent } from './types';
import { v4 as uuidv4 } from 'uuid';

export class EventStore {
  private events: Map<string, Event[]>;
  private snapshotInterval: number;
  private snapshotStore: Map<string, any>;

  constructor(snapshotInterval: number = 1000) {
    this.events = new Map();
    this.snapshotInterval = snapshotInterval;
    this.snapshotStore = new Map();
    this.setupSnapshotCleanup();
  }

  public async append(event: Event): Promise<void> {
    const stream = event.streamId;
    
    if (!this.events.has(stream)) {
      this.events.set(stream, []);
    }

    event.id = uuidv4();
    event.timestamp = new Date().toISOString();
    
    const streamEvents = this.events.get(stream);
    if (streamEvents) {
      streamEvents.push(event);
      logger.debug(`Appended event to stream ${stream}: ${event.type}`);
      
      // Check if snapshot should be taken
      if (streamEvents.length % this.snapshotInterval === 0) {
        this.takeSnapshot(stream, streamEvents);
      }
    }
  }

  public async getEvents(streamId: string): Promise<Event[]> {
    return this.events.get(streamId) || [];
  }

  public async getEventsByType(type: EventType): Promise<Event[]> {
    const allEvents: Event[] = [];
    this.events.forEach((events) => {
      events.forEach((event) => {
        if (event.type === type) {
          allEvents.push(event);
        }
      });
    });
    return allEvents;
  }

  public async getSnapshot(streamId: string): Promise<any> {
    return this.snapshotStore.get(streamId);
  }

  private takeSnapshot(streamId: string, events: Event[]): void {
    const snapshot = events.reduce((state, event) => {
      // Implementation depends on your domain model
      // This is a placeholder
      return state;
    }, {});
    
    this.snapshotStore.set(streamId, snapshot);
    logger.debug(`Created snapshot for stream ${streamId}`);
  }

  private setupSnapshotCleanup(): void {
    setInterval(() => {
      // Cleanup old snapshots
      this.snapshotStore.forEach((snapshot, streamId) => {
        // Implementation depends on your requirements
        // This is a placeholder
      });
    }, 3600000); // Every hour
  }

  public async replayEvents(): Promise<void> {
    // Implementation depends on your domain model
    // This is a placeholder
    logger.info('Replaying events...');
  }

  public async projectEvents(): Promise<void> {
    // Implementation depends on your read models
    // This is a placeholder
    logger.info('Projecting events...');
  }
}
