/**
 * Event Store - Event Persistence and Querying
 * 
 * 設計原則:
 * - Martin: イベントソーシングパターンの実装
 * - Carmack: 効率的なイベント保存と検索
 * - Pike: シンプルなクエリインターフェース
 */

import { Event, EventMetadata } from './event-bus';
import { createLogger } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);

export interface StoredEvent extends Event {
    sequenceNumber: number;
    aggregateId?: string;
    aggregateType?: string;
    committedAt: Date;
}

export interface EventStream {
    aggregateId: string;
    aggregateType: string;
    version: number;
    events: StoredEvent[];
}

export interface EventQuery {
    eventTypes?: string[];
    aggregateId?: string;
    aggregateType?: string;
    since?: Date;
    until?: Date;
    limit?: number;
    offset?: number;
}

export interface EventSnapshot {
    aggregateId: string;
    aggregateType: string;
    version: number;
    data: any;
    createdAt: Date;
}

export interface EventStoreConfig {
    storageType: 'memory' | 'file' | 'database';
    storagePath?: string;
    maxEventsPerFile?: number;
    enableSnapshots?: boolean;
    snapshotFrequency?: number;
    compactionInterval?: number;
}

export abstract class EventStore {
    protected logger = createLogger('EventStore');
    protected sequenceNumber = 0;
    protected snapshots: Map<string, EventSnapshot> = new Map();

    constructor(protected config: EventStoreConfig) {
        this.config = {
            enableSnapshots: true,
            snapshotFrequency: 100,
            compactionInterval: 3600000, // 1 hour
            ...config
        };
    }

    /**
     * Append events to the store
     */
    public abstract appendEvents(events: Event[]): Promise<StoredEvent[]>;

    /**
     * Get events by query
     */
    public abstract getEvents(query: EventQuery): Promise<StoredEvent[]>;

    /**
     * Get event stream for an aggregate
     */
    public abstract getEventStream(
        aggregateId: string,
        aggregateType: string,
        fromVersion?: number
    ): Promise<EventStream>;

    /**
     * Save snapshot
     */
    public async saveSnapshot(snapshot: EventSnapshot): Promise<void> {
        if (!this.config.enableSnapshots) return;

        const key = `${snapshot.aggregateType}:${snapshot.aggregateId}`;
        this.snapshots.set(key, snapshot);

        this.logger.debug('Snapshot saved', {
            aggregateId: snapshot.aggregateId,
            version: snapshot.version
        });
    }

    /**
     * Get snapshot
     */
    public async getSnapshot(
        aggregateId: string,
        aggregateType: string
    ): Promise<EventSnapshot | null> {
        if (!this.config.enableSnapshots) return null;

        const key = `${aggregateType}:${aggregateId}`;
        return this.snapshots.get(key) || null;
    }

    /**
     * Get next sequence number
     */
    protected getNextSequenceNumber(): number {
        return ++this.sequenceNumber;
    }

    /**
     * Create stored event
     */
    protected createStoredEvent(event: Event): StoredEvent {
        return {
            ...event,
            sequenceNumber: this.getNextSequenceNumber(),
            committedAt: new Date()
        };
    }
}

/**
 * In-Memory Event Store
 */
export class InMemoryEventStore extends EventStore {
    private events: StoredEvent[] = [];
    private eventsByAggregate: Map<string, StoredEvent[]> = new Map();

    public async appendEvents(events: Event[]): Promise<StoredEvent[]> {
        const storedEvents: StoredEvent[] = [];

        for (const event of events) {
            const storedEvent = this.createStoredEvent(event);
            this.events.push(storedEvent);
            storedEvents.push(storedEvent);

            // Index by aggregate if available
            if (storedEvent.aggregateId && storedEvent.aggregateType) {
                const key = `${storedEvent.aggregateType}:${storedEvent.aggregateId}`;
                if (!this.eventsByAggregate.has(key)) {
                    this.eventsByAggregate.set(key, []);
                }
                this.eventsByAggregate.get(key)!.push(storedEvent);
            }
        }

        return storedEvents;
    }

    public async getEvents(query: EventQuery): Promise<StoredEvent[]> {
        let events = [...this.events];

        // Apply filters
        if (query.eventTypes && query.eventTypes.length > 0) {
            events = events.filter(e => query.eventTypes!.includes(e.type));
        }

        if (query.aggregateId) {
            events = events.filter(e => e.aggregateId === query.aggregateId);
        }

        if (query.aggregateType) {
            events = events.filter(e => e.aggregateType === query.aggregateType);
        }

        if (query.since) {
            events = events.filter(e => e.timestamp >= query.since!);
        }

        if (query.until) {
            events = events.filter(e => e.timestamp <= query.until!);
        }

        // Apply pagination
        const offset = query.offset || 0;
        const limit = query.limit || events.length;

        return events.slice(offset, offset + limit);
    }

    public async getEventStream(
        aggregateId: string,
        aggregateType: string,
        fromVersion: number = 0
    ): Promise<EventStream> {
        const key = `${aggregateType}:${aggregateId}`;
        const events = this.eventsByAggregate.get(key) || [];
        
        const filteredEvents = events.filter((e, index) => index >= fromVersion);

        return {
            aggregateId,
            aggregateType,
            version: events.length,
            events: filteredEvents
        };
    }
}

/**
 * File-based Event Store
 */
export class FileEventStore extends EventStore {
    private currentFile: string;
    private currentFileEventCount = 0;
    private indexCache: Map<string, string[]> = new Map();

    constructor(config: EventStoreConfig) {
        super(config);
        if (!config.storagePath) {
            throw new Error('Storage path is required for FileEventStore');
        }
        this.currentFile = this.generateFileName();
    }

    public async initialize(): Promise<void> {
        // Create storage directory if it doesn't exist
        try {
            await mkdir(this.config.storagePath!, { recursive: true });
        } catch (error) {
            // Directory might already exist
        }

        // Load index
        await this.loadIndex();
    }

    public async appendEvents(events: Event[]): Promise<StoredEvent[]> {
        const storedEvents: StoredEvent[] = [];

        for (const event of events) {
            const storedEvent = this.createStoredEvent(event);
            await this.writeEvent(storedEvent);
            storedEvents.push(storedEvent);
        }

        return storedEvents;
    }

    public async getEvents(query: EventQuery): Promise<StoredEvent[]> {
        const allEvents: StoredEvent[] = [];
        const files = await this.getEventFiles();

        for (const file of files) {
            const events = await this.readEventsFromFile(file);
            allEvents.push(...events);
        }

        // Apply query filters
        return this.filterEvents(allEvents, query);
    }

    public async getEventStream(
        aggregateId: string,
        aggregateType: string,
        fromVersion: number = 0
    ): Promise<EventStream> {
        const key = `${aggregateType}:${aggregateId}`;
        const files = this.indexCache.get(key) || [];
        const events: StoredEvent[] = [];

        for (const file of files) {
            const fileEvents = await this.readEventsFromFile(file);
            const aggregateEvents = fileEvents.filter(
                e => e.aggregateId === aggregateId && e.aggregateType === aggregateType
            );
            events.push(...aggregateEvents);
        }

        const filteredEvents = events.slice(fromVersion);

        return {
            aggregateId,
            aggregateType,
            version: events.length,
            events: filteredEvents
        };
    }

    private async writeEvent(event: StoredEvent): Promise<void> {
        const filePath = path.join(this.config.storagePath!, this.currentFile);
        const line = JSON.stringify(event) + '\n';

        await writeFile(filePath, line, { flag: 'a' });
        this.currentFileEventCount++;

        // Update index
        if (event.aggregateId && event.aggregateType) {
            const key = `${event.aggregateType}:${event.aggregateId}`;
            if (!this.indexCache.has(key)) {
                this.indexCache.set(key, []);
            }
            const files = this.indexCache.get(key)!;
            if (!files.includes(this.currentFile)) {
                files.push(this.currentFile);
            }
        }

        // Check if we need to rotate file
        if (this.currentFileEventCount >= (this.config.maxEventsPerFile || 10000)) {
            this.currentFile = this.generateFileName();
            this.currentFileEventCount = 0;
        }
    }

    private async readEventsFromFile(fileName: string): Promise<StoredEvent[]> {
        const filePath = path.join(this.config.storagePath!, fileName);
        const content = await readFile(filePath, 'utf8');
        const lines = content.trim().split('\n');
        
        return lines
            .filter(line => line.trim())
            .map(line => JSON.parse(line) as StoredEvent);
    }

    private async getEventFiles(): Promise<string[]> {
        const files = await readdir(this.config.storagePath!);
        return files
            .filter(f => f.endsWith('.events'))
            .sort();
    }

    private filterEvents(events: StoredEvent[], query: EventQuery): StoredEvent[] {
        let filtered = [...events];

        if (query.eventTypes && query.eventTypes.length > 0) {
            filtered = filtered.filter(e => query.eventTypes!.includes(e.type));
        }

        if (query.aggregateId) {
            filtered = filtered.filter(e => e.aggregateId === query.aggregateId);
        }

        if (query.aggregateType) {
            filtered = filtered.filter(e => e.aggregateType === query.aggregateType);
        }

        if (query.since) {
            filtered = filtered.filter(e => new Date(e.timestamp) >= query.since!);
        }

        if (query.until) {
            filtered = filtered.filter(e => new Date(e.timestamp) <= query.until!);
        }

        const offset = query.offset || 0;
        const limit = query.limit || filtered.length;

        return filtered.slice(offset, offset + limit);
    }

    private async loadIndex(): Promise<void> {
        const files = await this.getEventFiles();
        
        for (const file of files) {
            const events = await this.readEventsFromFile(file);
            
            for (const event of events) {
                if (event.aggregateId && event.aggregateType) {
                    const key = `${event.aggregateType}:${event.aggregateId}`;
                    if (!this.indexCache.has(key)) {
                        this.indexCache.set(key, []);
                    }
                    const fileList = this.indexCache.get(key)!;
                    if (!fileList.includes(file)) {
                        fileList.push(file);
                    }
                }
            }
        }
    }

    private generateFileName(): string {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        return `events-${timestamp}.events`;
    }
}

/**
 * Event Store Factory
 */
export function createEventStore(config: EventStoreConfig): EventStore {
    switch (config.storageType) {
        case 'memory':
            return new InMemoryEventStore(config);
        case 'file':
            return new FileEventStore(config);
        case 'database':
            // Would implement database event store
            throw new Error('Database event store not implemented yet');
        default:
            throw new Error(`Unknown storage type: ${config.storageType}`);
    }
}
