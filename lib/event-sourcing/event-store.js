/**
 * Event Store for Otedama
 * Event sourcing with CQRS pattern
 * 
 * Design principles:
 * - Carmack: High-performance event streaming
 * - Martin: Clean event sourcing architecture
 * - Pike: Simple event store API
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getLogger } from '../core/logger.js';

const logger = getLogger('EventStore');

/**
 * Event types
 */
export const EventType = {
  // Domain events
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_DELETED: 'USER_DELETED',
  
  MINER_STARTED: 'MINER_STARTED',
  MINER_STOPPED: 'MINER_STOPPED',
  MINER_CONFIGURED: 'MINER_CONFIGURED',
  
  TRANSACTION_CREATED: 'TRANSACTION_CREATED',
  TRANSACTION_COMPLETED: 'TRANSACTION_COMPLETED',
  TRANSACTION_FAILED: 'TRANSACTION_FAILED',
  
  // System events
  SYSTEM_STARTED: 'SYSTEM_STARTED',
  SYSTEM_STOPPED: 'SYSTEM_STOPPED',
  CONFIG_CHANGED: 'CONFIG_CHANGED'
};

/**
 * Event structure
 */
export class Event {
  constructor(data) {
    this.id = data.id || this._generateId();
    this.type = data.type;
    this.aggregateId = data.aggregateId;
    this.aggregateType = data.aggregateType;
    this.version = data.version || 1;
    this.timestamp = data.timestamp || Date.now();
    this.userId = data.userId;
    this.data = data.data || {};
    this.metadata = data.metadata || {};
    this.checksum = data.checksum || this._calculateChecksum();
  }
  
  _generateId() {
    return `evt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  _calculateChecksum() {
    const content = JSON.stringify({
      type: this.type,
      aggregateId: this.aggregateId,
      version: this.version,
      data: this.data
    });
    return createHash('sha256').update(content).digest('hex');
  }
  
  validate() {
    if (!this.type) throw new Error('Event type is required');
    if (!this.aggregateId) throw new Error('Aggregate ID is required');
    if (!this.aggregateType) throw new Error('Aggregate type is required');
    
    const calculatedChecksum = this._calculateChecksum();
    if (this.checksum !== calculatedChecksum) {
      throw new Error('Event checksum validation failed');
    }
  }
  
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      aggregateId: this.aggregateId,
      aggregateType: this.aggregateType,
      version: this.version,
      timestamp: this.timestamp,
      userId: this.userId,
      data: this.data,
      metadata: this.metadata,
      checksum: this.checksum
    };
  }
}

/**
 * Snapshot structure
 */
export class Snapshot {
  constructor(data) {
    this.id = data.id || this._generateId();
    this.aggregateId = data.aggregateId;
    this.aggregateType = data.aggregateType;
    this.version = data.version;
    this.timestamp = data.timestamp || Date.now();
    this.state = data.state;
    this.metadata = data.metadata || {};
  }
  
  _generateId() {
    return `snap-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Event Store
 */
export class EventStore extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Storage
      storageType: options.storageType || 'file', // file, memory, database
      dataDir: options.dataDir || './data/events',
      
      // Snapshots
      snapshotInterval: options.snapshotInterval || 100,
      snapshotRetention: options.snapshotRetention || 5,
      
      // Performance
      batchSize: options.batchSize || 1000,
      cacheSize: options.cacheSize || 10000,
      
      // Consistency
      strongConsistency: options.strongConsistency !== false,
      optimisticConcurrency: options.optimisticConcurrency !== false,
      
      // Retention
      retentionDays: options.retentionDays || 0, // 0 = infinite
      archiveEnabled: options.archiveEnabled || false,
      
      ...options
    };
    
    // Storage
    this.events = new Map(); // aggregateId -> Event[]
    this.snapshots = new Map(); // aggregateId -> Snapshot[]
    this.eventStream = []; // Global event stream
    
    // Indexes
    this.eventsByType = new Map(); // eventType -> Event[]
    this.eventsByTimestamp = new Map(); // timestamp -> Event[]
    
    // Cache
    this.cache = new Map();
    this.cacheKeys = [];
    
    // Metrics
    this.metrics = {
      totalEvents: 0,
      totalSnapshots: 0,
      aggregates: 0,
      cacheHits: 0,
      cacheMisses: 0
    };
    
    // Subscribers
    this.projections = new Map();
    this.eventHandlers = new Map();
  }
  
  /**
   * Initialize event store
   */
  async initialize() {
    logger.info('Initializing event store');
    
    // Create storage directory
    if (this.options.storageType === 'file') {
      await mkdir(this.options.dataDir, { recursive: true });
      await mkdir(join(this.options.dataDir, 'events'), { recursive: true });
      await mkdir(join(this.options.dataDir, 'snapshots'), { recursive: true });
    }
    
    // Load existing events
    await this._loadEvents();
    
    // Start background tasks
    this._startMaintenanceTasks();
    
    this.emit('initialized');
  }
  
  /**
   * Append event
   */
  async append(eventData) {
    const event = new Event(eventData);
    
    // Validate event
    event.validate();
    
    // Check optimistic concurrency
    if (this.options.optimisticConcurrency) {
      const currentVersion = await this.getAggregateVersion(event.aggregateId);
      if (event.version !== currentVersion + 1) {
        throw new Error(`Concurrency conflict: expected version ${currentVersion + 1}, got ${event.version}`);
      }
    }
    
    // Store event
    await this._storeEvent(event);
    
    // Update indexes
    this._updateIndexes(event);
    
    // Update metrics
    this.metrics.totalEvents++;
    
    // Emit event
    this.emit('event:appended', event);
    
    // Process projections
    await this._processProjections(event);
    
    // Check if snapshot needed
    await this._checkSnapshot(event);
    
    return event;
  }
  
  /**
   * Append multiple events
   */
  async appendBatch(events) {
    const results = [];
    
    // Group by aggregate for consistency
    const eventsByAggregate = new Map();
    for (const eventData of events) {
      const event = new Event(eventData);
      const aggregateId = event.aggregateId;
      
      if (!eventsByAggregate.has(aggregateId)) {
        eventsByAggregate.set(aggregateId, []);
      }
      eventsByAggregate.get(aggregateId).push(event);
    }
    
    // Process each aggregate's events
    for (const [aggregateId, aggregateEvents] of eventsByAggregate) {
      // Sort by version
      aggregateEvents.sort((a, b) => a.version - b.version);
      
      // Append events
      for (const event of aggregateEvents) {
        const result = await this.append(event);
        results.push(result);
      }
    }
    
    return results;
  }
  
  /**
   * Get events for aggregate
   */
  async getEvents(aggregateId, fromVersion = 0, toVersion = null) {
    // Check cache
    const cacheKey = `events:${aggregateId}:${fromVersion}:${toVersion}`;
    if (this.cache.has(cacheKey)) {
      this.metrics.cacheHits++;
      return this.cache.get(cacheKey);
    }
    
    this.metrics.cacheMisses++;
    
    // Get events
    const events = this.events.get(aggregateId) || [];
    let filtered = events.filter(e => e.version > fromVersion);
    
    if (toVersion !== null) {
      filtered = filtered.filter(e => e.version <= toVersion);
    }
    
    // Update cache
    this._addToCache(cacheKey, filtered);
    
    return filtered;
  }
  
  /**
   * Get events by type
   */
  async getEventsByType(eventType, options = {}) {
    const {
      fromTimestamp = 0,
      toTimestamp = Date.now(),
      limit = 1000,
      offset = 0
    } = options;
    
    const events = this.eventsByType.get(eventType) || [];
    
    return events
      .filter(e => e.timestamp >= fromTimestamp && e.timestamp <= toTimestamp)
      .slice(offset, offset + limit);
  }
  
  /**
   * Get aggregate version
   */
  async getAggregateVersion(aggregateId) {
    const events = this.events.get(aggregateId) || [];
    if (events.length === 0) return 0;
    
    return Math.max(...events.map(e => e.version));
  }
  
  /**
   * Get aggregate state
   */
  async getAggregateState(aggregateId, version = null) {
    // Try to get from snapshot
    const snapshot = await this._getLatestSnapshot(aggregateId, version);
    let state = snapshot ? snapshot.state : null;
    let fromVersion = snapshot ? snapshot.version : 0;
    
    // Apply events from snapshot
    const events = await this.getEvents(aggregateId, fromVersion, version);
    
    for (const event of events) {
      state = await this._applyEvent(state, event);
    }
    
    return state;
  }
  
  /**
   * Create snapshot
   */
  async createSnapshot(aggregateId, aggregateType, state, version) {
    const snapshot = new Snapshot({
      aggregateId,
      aggregateType,
      version,
      state
    });
    
    // Store snapshot
    await this._storeSnapshot(snapshot);
    
    // Clean old snapshots
    await this._cleanOldSnapshots(aggregateId);
    
    this.metrics.totalSnapshots++;
    
    this.emit('snapshot:created', snapshot);
    
    return snapshot;
  }
  
  /**
   * Subscribe to events
   */
  subscribe(eventType, handler) {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, []);
    }
    
    this.eventHandlers.get(eventType).push(handler);
    
    return () => {
      const handlers = this.eventHandlers.get(eventType);
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    };
  }
  
  /**
   * Register projection
   */
  registerProjection(projection) {
    this.projections.set(projection.name, projection);
    
    logger.info(`Registered projection: ${projection.name}`);
    
    // Rebuild projection if needed
    if (projection.rebuild) {
      this._rebuildProjection(projection);
    }
  }
  
  /**
   * Query projection
   */
  async queryProjection(projectionName, query) {
    const projection = this.projections.get(projectionName);
    if (!projection) {
      throw new Error(`Projection not found: ${projectionName}`);
    }
    
    return projection.query(query);
  }
  
  /**
   * Store event
   */
  async _storeEvent(event) {
    // Add to aggregate events
    if (!this.events.has(event.aggregateId)) {
      this.events.set(event.aggregateId, []);
      this.metrics.aggregates++;
    }
    
    this.events.get(event.aggregateId).push(event);
    
    // Add to global stream
    this.eventStream.push(event);
    
    // Persist if file storage
    if (this.options.storageType === 'file') {
      await this._persistEvent(event);
    }
  }
  
  /**
   * Store snapshot
   */
  async _storeSnapshot(snapshot) {
    if (!this.snapshots.has(snapshot.aggregateId)) {
      this.snapshots.set(snapshot.aggregateId, []);
    }
    
    this.snapshots.get(snapshot.aggregateId).push(snapshot);
    
    // Persist if file storage
    if (this.options.storageType === 'file') {
      await this._persistSnapshot(snapshot);
    }
  }
  
  /**
   * Update indexes
   */
  _updateIndexes(event) {
    // By type
    if (!this.eventsByType.has(event.type)) {
      this.eventsByType.set(event.type, []);
    }
    this.eventsByType.get(event.type).push(event);
    
    // By timestamp (bucketed by hour)
    const hourBucket = Math.floor(event.timestamp / 3600000) * 3600000;
    if (!this.eventsByTimestamp.has(hourBucket)) {
      this.eventsByTimestamp.set(hourBucket, []);
    }
    this.eventsByTimestamp.get(hourBucket).push(event);
  }
  
  /**
   * Process projections
   */
  async _processProjections(event) {
    for (const projection of this.projections.values()) {
      if (projection.handles(event.type)) {
        try {
          await projection.handle(event);
        } catch (error) {
          logger.error(`Projection ${projection.name} failed:`, error);
        }
      }
    }
    
    // Process event handlers
    const handlers = this.eventHandlers.get(event.type) || [];
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (error) {
        logger.error(`Event handler failed for ${event.type}:`, error);
      }
    }
  }
  
  /**
   * Check if snapshot needed
   */
  async _checkSnapshot(event) {
    if (event.version % this.options.snapshotInterval === 0) {
      const state = await this.getAggregateState(event.aggregateId, event.version);
      await this.createSnapshot(
        event.aggregateId,
        event.aggregateType,
        state,
        event.version
      );
    }
  }
  
  /**
   * Get latest snapshot
   */
  async _getLatestSnapshot(aggregateId, maxVersion = null) {
    const snapshots = this.snapshots.get(aggregateId) || [];
    
    let filtered = snapshots;
    if (maxVersion !== null) {
      filtered = snapshots.filter(s => s.version <= maxVersion);
    }
    
    if (filtered.length === 0) return null;
    
    return filtered.reduce((latest, snapshot) => 
      snapshot.version > latest.version ? snapshot : latest
    );
  }
  
  /**
   * Apply event to state
   */
  async _applyEvent(state, event) {
    // This would be implemented by specific aggregates
    // For demo, just merge event data
    return {
      ...state,
      ...event.data,
      version: event.version,
      lastModified: event.timestamp
    };
  }
  
  /**
   * Clean old snapshots
   */
  async _cleanOldSnapshots(aggregateId) {
    const snapshots = this.snapshots.get(aggregateId) || [];
    
    if (snapshots.length > this.options.snapshotRetention) {
      // Keep only recent snapshots
      const sorted = snapshots.sort((a, b) => b.version - a.version);
      const toKeep = sorted.slice(0, this.options.snapshotRetention);
      this.snapshots.set(aggregateId, toKeep);
      
      // Delete old snapshot files
      if (this.options.storageType === 'file') {
        const toDelete = sorted.slice(this.options.snapshotRetention);
        for (const snapshot of toDelete) {
          await this._deleteSnapshotFile(snapshot);
        }
      }
    }
  }
  
  /**
   * Rebuild projection
   */
  async _rebuildProjection(projection) {
    logger.info(`Rebuilding projection: ${projection.name}`);
    
    // Reset projection state
    await projection.reset();
    
    // Replay all events
    for (const event of this.eventStream) {
      if (projection.handles(event.type)) {
        await projection.handle(event);
      }
    }
    
    logger.info(`Projection rebuilt: ${projection.name}`);
  }
  
  /**
   * Cache management
   */
  _addToCache(key, value) {
    this.cache.set(key, value);
    this.cacheKeys.push(key);
    
    // Evict old entries if cache full
    if (this.cacheKeys.length > this.options.cacheSize) {
      const oldKey = this.cacheKeys.shift();
      this.cache.delete(oldKey);
    }
  }
  
  /**
   * File persistence
   */
  async _persistEvent(event) {
    const filename = `${event.aggregateId}-${event.version}.json`;
    const filepath = join(this.options.dataDir, 'events', filename);
    
    await writeFile(filepath, JSON.stringify(event.toJSON(), null, 2));
  }
  
  async _persistSnapshot(snapshot) {
    const filename = `${snapshot.aggregateId}-${snapshot.version}-snapshot.json`;
    const filepath = join(this.options.dataDir, 'snapshots', filename);
    
    await writeFile(filepath, JSON.stringify(snapshot, null, 2));
  }
  
  async _deleteSnapshotFile(snapshot) {
    const filename = `${snapshot.aggregateId}-${snapshot.version}-snapshot.json`;
    const filepath = join(this.options.dataDir, 'snapshots', filename);
    
    try {
      await unlink(filepath);
    } catch (error) {
      // Ignore if file doesn't exist
    }
  }
  
  async _loadEvents() {
    if (this.options.storageType !== 'file') return;
    
    // Load events from disk
    // Implementation would scan event files and load them
    logger.info('Loading events from disk');
  }
  
  /**
   * Maintenance tasks
   */
  _startMaintenanceTasks() {
    // Archive old events
    if (this.options.archiveEnabled && this.options.retentionDays > 0) {
      setInterval(() => {
        this._archiveOldEvents();
      }, 86400000); // Daily
    }
    
    // Compact event store
    setInterval(() => {
      this._compactEventStore();
    }, 3600000); // Hourly
  }
  
  async _archiveOldEvents() {
    const cutoffTime = Date.now() - (this.options.retentionDays * 86400000);
    
    // Archive events older than retention period
    logger.info(`Archiving events older than ${new Date(cutoffTime).toISOString()}`);
    
    // Implementation would move old events to archive storage
  }
  
  _compactEventStore() {
    // Remove empty entries
    for (const [aggregateId, events] of this.events) {
      if (events.length === 0) {
        this.events.delete(aggregateId);
        this.metrics.aggregates--;
      }
    }
    
    // Clean up old timestamp buckets
    const cutoffTime = Date.now() - 86400000; // 24 hours
    for (const [bucket, events] of this.eventsByTimestamp) {
      if (bucket < cutoffTime && events.length === 0) {
        this.eventsByTimestamp.delete(bucket);
      }
    }
  }
  
  /**
   * Get store statistics
   */
  getStatistics() {
    return {
      ...this.metrics,
      projections: this.projections.size,
      eventTypes: this.eventsByType.size,
      cacheSize: this.cache.size,
      cacheHitRate: this.metrics.cacheHits > 0 ?
        (this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses) * 100).toFixed(2) + '%' : '0%'
    };
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    logger.info('Shutting down event store');
    
    // Clear caches
    this.cache.clear();
    
    this.emit('shutdown');
  }
}

export default EventStore;