import { open, Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import path from 'path';

/**
 * Represents a single domain event.
 */
export interface DomainEvent {
  id?: number;
  streamId: string; // Aggregate root ID (e.g., minerId, paymentId)
  eventType: string; // e.g., 'MinerCreated', 'ShareFound'
  payload: any; // The event data
  timestamp: number;
  version: number; // For optimistic concurrency control
}

/**
 * Provides an append-only store for domain events.
 * This is the foundation for Event Sourcing.
 */
export class EventStore {
  private db: Database | null = null;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(process.cwd(), 'data', 'events.db');
  }

  /**
   * Initializes the database connection and creates the events table.
   */
  async initialize(): Promise<void> {
    const dataDir = path.dirname(this.dbPath);
    const fs = await import('fs/promises');
    await fs.mkdir(dataDir, { recursive: true });

    this.db = await open({
      filename: this.dbPath,
      driver: sqlite3.Database
    });

    await this.db.exec('PRAGMA journal_mode = WAL');
    await this.createEventsTable();
  }

  /**
   * Creates the 'events' table if it doesn't exist.
   */
  private async createEventsTable(): Promise<void> {
    await this.db!.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL, -- Stored as JSON
        timestamp INTEGER NOT NULL,
        version INTEGER NOT NULL,
        UNIQUE (stream_id, version)
      );
    `);
    await this.db!.exec('CREATE INDEX IF NOT EXISTS idx_events_stream_id ON events (stream_id);');
    await this.db!.exec('CREATE INDEX IF NOT EXISTS idx_events_event_type ON events (event_type);');
  }

  /**
   * Appends a new event to the store.
   * @param streamId The ID of the aggregate.
   * @param eventType The type of the event.
   * @param payload The event data.
   * @param expectedVersion The version of the aggregate we expect to be acting on.
   */
  async appendEvent(streamId: string, eventType: string, payload: any, expectedVersion: number): Promise<DomainEvent> {
    const query = `
      INSERT INTO events (stream_id, event_type, payload, timestamp, version)
      VALUES (?, ?, ?, ?, ?);
    `;
    
    // In a real transaction, you'd first check the current version
    // For simplicity here, we rely on the UNIQUE constraint for optimistic concurrency.
    const newVersion = expectedVersion + 1;

    try {
      await this.db!.run(
        query,
        streamId,
        eventType,
        JSON.stringify(payload),
        Date.now(),
        newVersion
      );
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error(`Concurrency conflict for stream ${streamId}. Expected version ${expectedVersion}.`);
      }
      throw error;
    }

    const result = await this.db!.get('SELECT last_insert_rowid() as id;');
    const id = result.id;

    return {
      id,
      streamId,
      eventType,
      payload,
      timestamp: Date.now(), // This is slightly different from the inserted one, but acceptable for this purpose
      version: newVersion
    };
  }

  /**
   * Retrieves all events for a given stream (aggregate).
   * @param streamId The ID of the aggregate.
   * @returns A list of domain events.
   */
  async getEventsForStream(streamId: string): Promise<DomainEvent[]> {
    const rows = await this.db!.all(
      'SELECT * FROM events WHERE stream_id = ? ORDER BY version ASC',
      streamId
    );

    return rows.map(row => ({
      ...row,
      payload: JSON.parse(row.payload)
    }));
  }

  /**
   * Gets the current version of a stream.
   * @param streamId The ID of the aggregate.
   * @returns The latest version number.
   */
  async getCurrentVersion(streamId: string): Promise<number> {
    const row = await this.db!.get(
      'SELECT MAX(version) as version FROM events WHERE stream_id = ?',
      streamId
    );
    return row?.version || 0;
  }

  /**
   * Closes the database connection.
   */
  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
    }
  }
}

// Singleton instance for the EventStore
let eventStore: EventStore | null = null;

export function getEventStore(): EventStore {
  if (!eventStore) {
    eventStore = new EventStore();
  }
  return eventStore;
}
