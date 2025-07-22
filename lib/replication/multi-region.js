/**
 * Multi-Region Data Replication for Otedama
 * Globally distributed data with consistency guarantees
 * 
 * Design principles:
 * - Carmack: Low-latency replication
 * - Martin: Clean replication architecture  
 * - Pike: Simple replication API
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { getLogger } from '../core/logger.js';

const logger = getLogger('MultiRegion');

/**
 * Replication strategies
 */
export const ReplicationStrategy = {
  SYNC: 'sync',                   // Synchronous replication
  ASYNC: 'async',                 // Asynchronous replication
  SEMI_SYNC: 'semi_sync',         // Semi-synchronous (wait for at least one)
  EVENTUAL: 'eventual'            // Eventual consistency
};

/**
 * Consistency models
 */
export const ConsistencyModel = {
  STRONG: 'strong',               // Strong consistency
  EVENTUAL: 'eventual',           // Eventual consistency
  CAUSAL: 'causal',              // Causal consistency
  SESSION: 'session',            // Session consistency
  READ_YOUR_WRITES: 'read_your_writes'  // Read your writes
};

/**
 * Conflict resolution strategies
 */
export const ConflictResolution = {
  LAST_WRITE_WINS: 'last_write_wins',
  FIRST_WRITE_WINS: 'first_write_wins',
  CUSTOM: 'custom',
  MANUAL: 'manual',
  CRDT: 'crdt'  // Conflict-free replicated data types
};

/**
 * Region configuration
 */
export class Region {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.endpoint = config.endpoint;
    this.priority = config.priority || 1;
    this.latency = config.latency || 0;
    this.available = true;
    this.lastSync = null;
    this.metrics = {
      operations: 0,
      failures: 0,
      latency: [],
      bandwidth: 0
    };
  }
  
  updateLatency(value) {
    this.metrics.latency.push(value);
    if (this.metrics.latency.length > 100) {
      this.metrics.latency.shift();
    }
    this.latency = this.metrics.latency.reduce((a, b) => a + b, 0) / this.metrics.latency.length;
  }
}

/**
 * Replication log entry
 */
export class ReplicationLogEntry {
  constructor(data) {
    this.id = data.id || this._generateId();
    this.timestamp = data.timestamp || Date.now();
    this.region = data.region;
    this.operation = data.operation;
    this.key = data.key;
    this.value = data.value;
    this.version = data.version || 1;
    this.checksum = data.checksum || this._calculateChecksum();
    this.dependencies = data.dependencies || [];
  }
  
  _generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  _calculateChecksum() {
    const data = JSON.stringify({
      operation: this.operation,
      key: this.key,
      value: this.value,
      version: this.version
    });
    return createHash('sha256').update(data).digest('hex');
  }
}

/**
 * Vector clock for causality tracking
 */
export class VectorClock {
  constructor(nodeId) {
    this.nodeId = nodeId;
    this.clock = new Map();
  }
  
  increment() {
    const current = this.clock.get(this.nodeId) || 0;
    this.clock.set(this.nodeId, current + 1);
  }
  
  update(otherClock) {
    for (const [nodeId, timestamp] of otherClock.entries()) {
      const current = this.clock.get(nodeId) || 0;
      this.clock.set(nodeId, Math.max(current, timestamp));
    }
  }
  
  happensBefore(other) {
    for (const [nodeId, timestamp] of this.clock) {
      const otherTimestamp = other.clock.get(nodeId) || 0;
      if (timestamp > otherTimestamp) return false;
    }
    return true;
  }
  
  concurrent(other) {
    return !this.happensBefore(other) && !other.happensBefore(this);
  }
  
  toJSON() {
    return Object.fromEntries(this.clock);
  }
}

/**
 * Multi-region replication system
 */
export class MultiRegionReplication extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Local region configuration
      localRegion: options.localRegion || 'us-east-1',
      
      // Replication settings
      strategy: options.strategy || ReplicationStrategy.ASYNC,
      consistency: options.consistency || ConsistencyModel.EVENTUAL,
      conflictResolution: options.conflictResolution || ConflictResolution.LAST_WRITE_WINS,
      
      // Performance settings
      batchSize: options.batchSize || 100,
      batchInterval: options.batchInterval || 1000,
      compressionEnabled: options.compressionEnabled !== false,
      
      // Reliability settings
      retryAttempts: options.retryAttempts || 3,
      retryDelay: options.retryDelay || 1000,
      timeoutMs: options.timeoutMs || 30000,
      
      // Consistency settings
      quorum: options.quorum || 'majority',  // majority, all, one
      readPreference: options.readPreference || 'nearest',  // primary, secondary, nearest
      
      // Monitoring
      healthCheckInterval: options.healthCheckInterval || 30000,
      
      ...options
    };
    
    // State
    this.regions = new Map();
    this.replicationLog = [];
    this.pendingOperations = new Map();
    this.vectorClock = new VectorClock(this.options.localRegion);
    
    // Batch processing
    this.batch = [];
    this.batchTimer = null;
    
    // Metrics
    this.metrics = {
      totalOperations: 0,
      successfulReplications: 0,
      failedReplications: 0,
      conflicts: 0,
      averageLatency: 0
    };
  }
  
  /**
   * Initialize replication system
   */
  async initialize() {
    logger.info('Initializing multi-region replication');
    
    // Start health monitoring
    this._startHealthMonitoring();
    
    // Start batch processing
    this._startBatchProcessing();
    
    this.emit('initialized');
  }
  
  /**
   * Add region
   */
  addRegion(config) {
    const region = new Region(config);
    this.regions.set(region.id, region);
    
    logger.info(`Added region: ${region.name} (${region.id})`);
    
    this.emit('region:added', region);
  }
  
  /**
   * Remove region
   */
  removeRegion(regionId) {
    const region = this.regions.get(regionId);
    if (!region) return;
    
    this.regions.delete(regionId);
    
    logger.info(`Removed region: ${region.name} (${region.id})`);
    
    this.emit('region:removed', region);
  }
  
  /**
   * Write operation
   */
  async write(key, value, options = {}) {
    const operation = {
      type: 'write',
      key,
      value,
      timestamp: Date.now(),
      region: this.options.localRegion,
      version: await this._getNextVersion(key),
      vectorClock: this.vectorClock.toJSON()
    };
    
    // Increment vector clock
    this.vectorClock.increment();
    
    // Create log entry
    const logEntry = new ReplicationLogEntry({
      ...operation,
      operation: operation.type
    });
    
    // Add to replication log
    this.replicationLog.push(logEntry);
    
    // Replicate based on strategy
    switch (this.options.strategy) {
      case ReplicationStrategy.SYNC:
        await this._replicateSync(logEntry);
        break;
        
      case ReplicationStrategy.SEMI_SYNC:
        await this._replicateSemiSync(logEntry);
        break;
        
      case ReplicationStrategy.ASYNC:
        this._replicateAsync(logEntry);
        break;
        
      case ReplicationStrategy.EVENTUAL:
        this._addToBatch(logEntry);
        break;
    }
    
    this.metrics.totalOperations++;
    
    this.emit('write', { key, value, version: operation.version });
    
    return {
      success: true,
      version: operation.version,
      timestamp: operation.timestamp
    };
  }
  
  /**
   * Read operation
   */
  async read(key, options = {}) {
    const readPreference = options.readPreference || this.options.readPreference;
    const consistency = options.consistency || this.options.consistency;
    
    let value = null;
    let version = null;
    let region = null;
    
    switch (readPreference) {
      case 'primary':
        ({ value, version } = await this._readFromPrimary(key));
        region = this.options.localRegion;
        break;
        
      case 'secondary':
        ({ value, version, region } = await this._readFromSecondary(key));
        break;
        
      case 'nearest':
        ({ value, version, region } = await this._readFromNearest(key));
        break;
    }
    
    // Ensure consistency
    if (consistency === ConsistencyModel.STRONG) {
      await this._ensureConsistency(key, version);
    }
    
    this.emit('read', { key, value, version, region });
    
    return { value, version, region };
  }
  
  /**
   * Delete operation
   */
  async delete(key, options = {}) {
    return this.write(key, null, { ...options, operation: 'delete' });
  }
  
  /**
   * Synchronous replication
   */
  async _replicateSync(logEntry) {
    const regions = this._getActiveRegions();
    
    const promises = regions.map(region => 
      this._replicateToRegion(region, logEntry)
    );
    
    const results = await Promise.all(promises);
    
    if (results.every(r => r.success)) {
      this.metrics.successfulReplications++;
    } else {
      this.metrics.failedReplications++;
      throw new Error('Synchronous replication failed');
    }
  }
  
  /**
   * Semi-synchronous replication
   */
  async _replicateSemiSync(logEntry) {
    const regions = this._getActiveRegions();
    const quorum = this._calculateQuorum(regions.length);
    
    const promises = regions.map(region => 
      this._replicateToRegion(region, logEntry)
        .catch(() => ({ success: false }))
    );
    
    const results = await Promise.all(promises);
    const successful = results.filter(r => r.success).length;
    
    if (successful >= quorum) {
      this.metrics.successfulReplications++;
    } else {
      this.metrics.failedReplications++;
      throw new Error('Semi-synchronous replication failed to reach quorum');
    }
  }
  
  /**
   * Asynchronous replication
   */
  _replicateAsync(logEntry) {
    const regions = this._getActiveRegions();
    
    for (const region of regions) {
      this._replicateToRegion(region, logEntry)
        .then(() => this.metrics.successfulReplications++)
        .catch(error => {
          this.metrics.failedReplications++;
          logger.error(`Async replication to ${region.id} failed:`, error);
          
          // Add to retry queue
          this._addToRetryQueue(region, logEntry);
        });
    }
  }
  
  /**
   * Replicate to specific region
   */
  async _replicateToRegion(region, logEntry, attempt = 1) {
    const startTime = Date.now();
    
    try {
      // Simulate network call
      const response = await this._sendToRegion(region, {
        type: 'replicate',
        entry: logEntry
      });
      
      // Update metrics
      const latency = Date.now() - startTime;
      region.updateLatency(latency);
      region.metrics.operations++;
      region.lastSync = Date.now();
      
      return { success: true, latency };
      
    } catch (error) {
      region.metrics.failures++;
      
      if (attempt < this.options.retryAttempts) {
        await new Promise(resolve => 
          setTimeout(resolve, this.options.retryDelay * attempt)
        );
        return this._replicateToRegion(region, logEntry, attempt + 1);
      }
      
      throw error;
    }
  }
  
  /**
   * Send data to region
   */
  async _sendToRegion(region, data) {
    // In production, this would make actual network calls
    // For demo, simulate network latency
    await new Promise(resolve => 
      setTimeout(resolve, region.latency || 50)
    );
    
    // Simulate occasional failures
    if (Math.random() < 0.05) {
      throw new Error('Network error');
    }
    
    return { success: true };
  }
  
  /**
   * Handle incoming replication
   */
  async handleIncomingReplication(entry) {
    logger.debug(`Received replication entry: ${entry.id}`);
    
    // Update vector clock
    if (entry.vectorClock) {
      const incomingClock = new VectorClock(entry.region);
      incomingClock.clock = new Map(Object.entries(entry.vectorClock));
      this.vectorClock.update(incomingClock.clock);
    }
    
    // Check for conflicts
    const conflict = await this._detectConflict(entry);
    
    if (conflict) {
      this.metrics.conflicts++;
      const resolved = await this._resolveConflict(conflict, entry);
      
      if (!resolved) {
        this.emit('conflict:unresolved', { conflict, entry });
        return { success: false, reason: 'conflict' };
      }
    }
    
    // Apply operation
    await this._applyOperation(entry);
    
    // Add to replication log
    this.replicationLog.push(entry);
    
    this.emit('replication:received', entry);
    
    return { success: true };
  }
  
  /**
   * Detect conflicts
   */
  async _detectConflict(entry) {
    const existing = this.replicationLog
      .filter(e => e.key === entry.key)
      .sort((a, b) => b.version - a.version)[0];
    
    if (!existing) return null;
    
    // Check if vector clocks are concurrent
    const existingClock = new VectorClock(existing.region);
    existingClock.clock = new Map(Object.entries(existing.vectorClock || {}));
    
    const incomingClock = new VectorClock(entry.region);
    incomingClock.clock = new Map(Object.entries(entry.vectorClock || {}));
    
    if (existingClock.concurrent(incomingClock)) {
      return {
        type: 'concurrent_write',
        existing,
        incoming: entry
      };
    }
    
    // Check version conflict
    if (existing.version >= entry.version && existing.timestamp !== entry.timestamp) {
      return {
        type: 'version_conflict',
        existing,
        incoming: entry
      };
    }
    
    return null;
  }
  
  /**
   * Resolve conflicts
   */
  async _resolveConflict(conflict, entry) {
    switch (this.options.conflictResolution) {
      case ConflictResolution.LAST_WRITE_WINS:
        return entry.timestamp > conflict.existing.timestamp;
        
      case ConflictResolution.FIRST_WRITE_WINS:
        return entry.timestamp < conflict.existing.timestamp;
        
      case ConflictResolution.CUSTOM:
        if (this.options.conflictResolver) {
          return this.options.conflictResolver(conflict, entry);
        }
        return false;
        
      case ConflictResolution.MANUAL:
        this.emit('conflict:manual', { conflict, entry });
        return false;
        
      case ConflictResolution.CRDT:
        return this._resolveCRDT(conflict, entry);
        
      default:
        return false;
    }
  }
  
  /**
   * Resolve using CRDT
   */
  _resolveCRDT(conflict, entry) {
    // Simple CRDT example: merge sets
    if (typeof conflict.existing.value === 'object' && 
        typeof entry.value === 'object') {
      // Merge operation
      const merged = {
        ...conflict.existing.value,
        ...entry.value
      };
      
      entry.value = merged;
      return true;
    }
    
    // Fall back to last write wins
    return entry.timestamp > conflict.existing.timestamp;
  }
  
  /**
   * Apply operation
   */
  async _applyOperation(entry) {
    // In production, this would update the actual data store
    logger.debug(`Applied operation: ${entry.operation} on ${entry.key}`);
  }
  
  /**
   * Get active regions
   */
  _getActiveRegions() {
    return Array.from(this.regions.values())
      .filter(region => region.available && region.id !== this.options.localRegion);
  }
  
  /**
   * Calculate quorum
   */
  _calculateQuorum(regionCount) {
    switch (this.options.quorum) {
      case 'all':
        return regionCount;
      case 'majority':
        return Math.floor(regionCount / 2) + 1;
      case 'one':
        return 1;
      default:
        return parseInt(this.options.quorum) || 1;
    }
  }
  
  /**
   * Get next version
   */
  async _getNextVersion(key) {
    const existing = this.replicationLog
      .filter(e => e.key === key)
      .sort((a, b) => b.version - a.version)[0];
    
    return existing ? existing.version + 1 : 1;
  }
  
  /**
   * Read from primary
   */
  async _readFromPrimary(key) {
    // In production, read from local data store
    const entry = this.replicationLog
      .filter(e => e.key === key && e.region === this.options.localRegion)
      .sort((a, b) => b.version - a.version)[0];
    
    return {
      value: entry?.value || null,
      version: entry?.version || 0
    };
  }
  
  /**
   * Read from secondary
   */
  async _readFromSecondary(key) {
    const regions = this._getActiveRegions();
    if (regions.length === 0) {
      return this._readFromPrimary(key);
    }
    
    // Read from random secondary
    const region = regions[Math.floor(Math.random() * regions.length)];
    
    try {
      const response = await this._sendToRegion(region, {
        type: 'read',
        key
      });
      
      return {
        value: response.value,
        version: response.version,
        region: region.id
      };
    } catch (error) {
      // Fall back to primary
      const primary = await this._readFromPrimary(key);
      return { ...primary, region: this.options.localRegion };
    }
  }
  
  /**
   * Read from nearest region
   */
  async _readFromNearest(key) {
    const regions = Array.from(this.regions.values())
      .filter(r => r.available)
      .sort((a, b) => a.latency - b.latency);
    
    if (regions.length === 0) {
      return this._readFromPrimary(key);
    }
    
    const nearestRegion = regions[0];
    
    if (nearestRegion.id === this.options.localRegion) {
      const result = await this._readFromPrimary(key);
      return { ...result, region: this.options.localRegion };
    }
    
    return this._readFromSecondary(key);
  }
  
  /**
   * Ensure consistency
   */
  async _ensureConsistency(key, version) {
    const regions = this._getActiveRegions();
    
    const promises = regions.map(region =>
      this._sendToRegion(region, {
        type: 'version_check',
        key,
        version
      })
    );
    
    const results = await Promise.all(promises);
    
    // Check if all regions have the same version
    const consistent = results.every(r => r.version === version);
    
    if (!consistent) {
      // Trigger sync
      await this._syncKey(key);
    }
  }
  
  /**
   * Sync specific key
   */
  async _syncKey(key) {
    logger.info(`Syncing key across regions: ${key}`);
    
    // Get latest version
    const latest = this.replicationLog
      .filter(e => e.key === key)
      .sort((a, b) => b.version - a.version)[0];
    
    if (!latest) return;
    
    // Replicate to all regions
    await this._replicateSync(latest);
  }
  
  /**
   * Batch processing
   */
  _startBatchProcessing() {
    this.batchTimer = setInterval(() => {
      if (this.batch.length > 0) {
        this._processBatch();
      }
    }, this.options.batchInterval);
  }
  
  _addToBatch(entry) {
    this.batch.push(entry);
    
    if (this.batch.length >= this.options.batchSize) {
      this._processBatch();
    }
  }
  
  async _processBatch() {
    const entries = this.batch.splice(0, this.options.batchSize);
    if (entries.length === 0) return;
    
    logger.debug(`Processing batch of ${entries.length} entries`);
    
    const regions = this._getActiveRegions();
    
    for (const region of regions) {
      try {
        await this._sendToRegion(region, {
          type: 'batch',
          entries
        });
        
        this.metrics.successfulReplications += entries.length;
      } catch (error) {
        this.metrics.failedReplications += entries.length;
        
        // Add to retry queue
        for (const entry of entries) {
          this._addToRetryQueue(region, entry);
        }
      }
    }
  }
  
  /**
   * Retry queue management
   */
  _addToRetryQueue(region, entry) {
    const key = `${region.id}:${entry.id}`;
    
    if (!this.pendingOperations.has(key)) {
      this.pendingOperations.set(key, {
        region,
        entry,
        attempts: 0,
        nextRetry: Date.now() + this.options.retryDelay
      });
    }
  }
  
  /**
   * Health monitoring
   */
  _startHealthMonitoring() {
    setInterval(() => {
      this._checkRegionHealth();
    }, this.options.healthCheckInterval);
  }
  
  async _checkRegionHealth() {
    for (const region of this.regions.values()) {
      if (region.id === this.options.localRegion) continue;
      
      try {
        const startTime = Date.now();
        
        await this._sendToRegion(region, { type: 'ping' });
        
        region.available = true;
        region.updateLatency(Date.now() - startTime);
        
      } catch (error) {
        region.available = false;
        
        logger.warn(`Region ${region.id} is unavailable`);
        
        this.emit('region:unavailable', region);
      }
    }
  }
  
  /**
   * Get replication status
   */
  getStatus() {
    const regionStatus = {};
    
    for (const [id, region] of this.regions) {
      regionStatus[id] = {
        name: region.name,
        available: region.available,
        latency: Math.round(region.latency),
        lastSync: region.lastSync,
        metrics: region.metrics
      };
    }
    
    return {
      localRegion: this.options.localRegion,
      strategy: this.options.strategy,
      consistency: this.options.consistency,
      regions: regionStatus,
      pendingOperations: this.pendingOperations.size,
      batchSize: this.batch.length,
      metrics: this.metrics
    };
  }
  
  /**
   * Get replication lag
   */
  getReplicationLag() {
    const lags = {};
    
    for (const [id, region] of this.regions) {
      if (region.lastSync) {
        lags[id] = Date.now() - region.lastSync;
      }
    }
    
    return lags;
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    logger.info('Shutting down multi-region replication');
    
    // Process remaining batch
    if (this.batch.length > 0) {
      await this._processBatch();
    }
    
    // Clear timers
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
    }
    
    this.emit('shutdown');
  }
}

export default MultiRegionReplication;