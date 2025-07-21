/**
 * Database Optimization and Sharding System
 * Advanced database management with sharding, optimization, and monitoring
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { logger } from '../core/logger.js';

/**
 * Database sharding coordinator
 */
export class ShardingCoordinator extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      shardingStrategy: 'hash', // hash, range, directory, consistent-hash
      shards: [],
      defaultShard: 'shard_01',
      virtualNodes: 150, // For consistent hashing
      replicationFactor: 2,
      autoRebalancing: true,
      migrationBatchSize: 1000,
      ...options
    };
    
    this.shards = new Map();
    this.shardRing = []; // For consistent hashing
    this.routingTable = new Map();
    this.migrationTasks = new Map();
    
    this.initializeShards();
    this.buildShardRing();
    
    if (this.options.autoRebalancing) {
      this.startRebalancing();
    }
  }

  /**
   * Initialize database shards
   */
  initializeShards() {
    for (const shardConfig of this.options.shards) {
      const shard = new DatabaseShard({
        id: shardConfig.id,
        name: shardConfig.name,
        host: shardConfig.host,
        port: shardConfig.port,
        database: shardConfig.database,
        weight: shardConfig.weight || 1,
        readReplicas: shardConfig.readReplicas || [],
        ...shardConfig.options
      });
      
      this.shards.set(shardConfig.id, shard);
      
      // Setup event forwarding
      shard.on('query', (data) => this.emit('shard-query', { shardId: shardConfig.id, ...data }));
      shard.on('error', (error) => this.emit('shard-error', { shardId: shardConfig.id, error }));
    }
    
    logger.info(`Initialized ${this.shards.size} database shards`);
  }

  /**
   * Build consistent hash ring for routing
   */
  buildShardRing() {
    this.shardRing = [];
    
    for (const [shardId, shard] of this.shards) {
      const weight = shard.options.weight || 1;
      const virtualNodes = this.options.virtualNodes * weight;
      
      for (let i = 0; i < virtualNodes; i++) {
        const hash = this.hashFunction(`${shardId}:${i}`);
        this.shardRing.push({
          hash,
          shardId,
          virtualNode: i
        });
      }
    }
    
    // Sort by hash value
    this.shardRing.sort((a, b) => a.hash - b.hash);
    
    this.emit('ring-built', { 
      nodes: this.shardRing.length,
      shards: this.shards.size 
    });
  }

  /**
   * Route query to appropriate shard
   */
  async routeQuery(query, shardKey = null) {
    const shardId = this.getShardForKey(shardKey || query.table);
    const shard = this.shards.get(shardId);
    
    if (!shard) {
      throw new Error(`Shard ${shardId} not found`);
    }
    
    // Route to read replica for read queries
    if (this.isReadQuery(query) && shard.readReplicas.length > 0) {
      return await shard.queryReadReplica(query);
    }
    
    return await shard.query(query);
  }

  /**
   * Get shard ID for a given key
   */
  getShardForKey(key) {
    if (!key) return this.options.defaultShard;
    
    switch (this.options.shardingStrategy) {
      case 'hash':
        return this.hashSharding(key);
      
      case 'range':
        return this.rangeSharding(key);
      
      case 'directory':
        return this.directorySharding(key);
      
      case 'consistent-hash':
        return this.consistentHashSharding(key);
      
      default:
        return this.options.defaultShard;
    }
  }

  /**
   * Hash-based sharding
   */
  hashSharding(key) {
    const hash = this.hashFunction(key);
    const shardIndex = hash % this.shards.size;
    return Array.from(this.shards.keys())[shardIndex];
  }

  /**
   * Range-based sharding
   */
  rangeSharding(key) {
    // Simple alphabetical range partitioning
    const firstChar = key.toString().charAt(0).toLowerCase();
    const charCode = firstChar.charCodeAt(0);
    
    if (charCode <= 105) return 'shard_01'; // a-i
    if (charCode <= 114) return 'shard_02'; // j-r
    return 'shard_03'; // s-z
  }

  /**
   * Directory-based sharding
   */
  directorySharding(key) {
    // Check routing table first
    const routedShard = this.routingTable.get(key);
    if (routedShard) {
      return routedShard;
    }
    
    // Default fallback
    return this.hashSharding(key);
  }

  /**
   * Consistent hashing
   */
  consistentHashSharding(key) {
    const keyHash = this.hashFunction(key);
    
    // Find the first node with hash >= keyHash
    for (const node of this.shardRing) {
      if (node.hash >= keyHash) {
        return node.shardId;
      }
    }
    
    // Wrap around to first node
    return this.shardRing[0]?.shardId || this.options.defaultShard;
  }

  /**
   * Hash function
   */
  hashFunction(input) {
    return crypto.createHash('sha256')
      .update(input.toString())
      .digest('hex')
      .split('')
      .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  }

  /**
   * Check if query is read-only
   */
  isReadQuery(query) {
    const sql = query.sql?.toLowerCase() || '';
    return sql.startsWith('select') || 
           sql.includes('show') || 
           sql.includes('describe') ||
           sql.includes('explain');
  }

  /**
   * Execute distributed transaction
   */
  async distributedTransaction(operations) {
    const transactionId = crypto.randomBytes(16).toString('hex');
    const participants = new Map();
    
    try {
      // Phase 1: Prepare all participants
      for (const operation of operations) {
        const shardId = this.getShardForKey(operation.shardKey);
        const shard = this.shards.get(shardId);
        
        if (!participants.has(shardId)) {
          participants.set(shardId, shard);
        }
        
        await shard.prepare(transactionId, operation);
      }
      
      // Phase 2: Commit all participants
      const commitPromises = [];
      for (const [shardId, shard] of participants) {
        commitPromises.push(shard.commit(transactionId));
      }
      
      await Promise.all(commitPromises);
      
      this.emit('transaction-committed', { 
        transactionId, 
        participants: Array.from(participants.keys()) 
      });
      
      return { success: true, transactionId };
      
    } catch (error) {
      // Rollback all participants
      const rollbackPromises = [];
      for (const [shardId, shard] of participants) {
        rollbackPromises.push(
          shard.rollback(transactionId).catch(rollbackError => {
            logger.error(`Rollback failed for shard ${shardId}:`, rollbackError);
          })
        );
      }
      
      await Promise.all(rollbackPromises);
      
      this.emit('transaction-failed', { 
        transactionId, 
        error: error.message,
        participants: Array.from(participants.keys())
      });
      
      throw error;
    }
  }

  /**
   * Start rebalancing process
   */
  startRebalancing() {
    setInterval(() => {
      this.analyzeShardDistribution();
    }, 300000); // Every 5 minutes
  }

  /**
   * Analyze shard distribution
   */
  async analyzeShardDistribution() {
    const distribution = {};
    let totalRecords = 0;
    
    for (const [shardId, shard] of this.shards) {
      const stats = await shard.getStats();
      distribution[shardId] = {
        records: stats.recordCount,
        size: stats.dataSize,
        load: stats.queryLoad
      };
      totalRecords += stats.recordCount;
    }
    
    // Calculate imbalance
    const avgRecords = totalRecords / this.shards.size;
    const imbalanceThreshold = 0.3; // 30% imbalance threshold
    
    for (const [shardId, stats] of Object.entries(distribution)) {
      const imbalance = Math.abs(stats.records - avgRecords) / avgRecords;
      
      if (imbalance > imbalanceThreshold) {
        logger.warn(`Shard ${shardId} imbalance detected: ${(imbalance * 100).toFixed(1)}%`);
        
        if (this.options.autoRebalancing) {
          await this.rebalanceShard(shardId, distribution);
        }
      }
    }
    
    this.emit('distribution-analyzed', distribution);
  }

  /**
   * Rebalance specific shard
   */
  async rebalanceShard(shardId, distribution) {
    const migrationId = crypto.randomBytes(8).toString('hex');
    
    try {
      // Find target shard with lowest load
      const targetShardId = Object.entries(distribution)
        .filter(([id]) => id !== shardId)
        .sort((a, b) => a[1].records - b[1].records)[0][0];
      
      const migrationTask = {
        id: migrationId,
        sourceShardId: shardId,
        targetShardId,
        status: 'running',
        startTime: Date.now(),
        recordsMigrated: 0
      };
      
      this.migrationTasks.set(migrationId, migrationTask);
      
      // Start migration
      await this.migrateShard(shardId, targetShardId, migrationTask);
      
      migrationTask.status = 'completed';
      migrationTask.endTime = Date.now();
      
      this.emit('rebalancing-completed', migrationTask);
      
    } catch (error) {
      logger.error(`Rebalancing failed for shard ${shardId}:`, error);
      
      const task = this.migrationTasks.get(migrationId);
      if (task) {
        task.status = 'failed';
        task.error = error.message;
      }
      
      this.emit('rebalancing-failed', { migrationId, error: error.message });
    }
  }

  /**
   * Migrate data between shards
   */
  async migrateShard(sourceShardId, targetShardId, migrationTask) {
    const sourceShard = this.shards.get(sourceShardId);
    const targetShard = this.shards.get(targetShardId);
    
    if (!sourceShard || !targetShard) {
      throw new Error('Invalid shard configuration');
    }
    
    let offset = 0;
    const batchSize = this.options.migrationBatchSize;
    
    while (true) {
      const batch = await sourceShard.getBatch(offset, batchSize);
      
      if (batch.length === 0) break;
      
      // Insert into target shard
      await targetShard.insertBatch(batch);
      
      // Update routing table
      for (const record of batch) {
        this.routingTable.set(record.key, targetShardId);
      }
      
      migrationTask.recordsMigrated += batch.length;
      offset += batchSize;
      
      // Small delay to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    // Clean up old data (mark for deletion)
    await sourceShard.markForDeletion(migrationTask.recordsMigrated);
  }

  /**
   * Add new shard
   */
  async addShard(shardConfig) {
    const shard = new DatabaseShard(shardConfig);
    this.shards.set(shardConfig.id, shard);
    
    // Rebuild hash ring
    this.buildShardRing();
    
    // Trigger rebalancing
    if (this.options.autoRebalancing) {
      setTimeout(() => this.analyzeShardDistribution(), 5000);
    }
    
    this.emit('shard-added', shardConfig);
    
    return shard;
  }

  /**
   * Remove shard
   */
  async removeShard(shardId) {
    const shard = this.shards.get(shardId);
    if (!shard) return;
    
    // Migrate all data to other shards
    const stats = await shard.getStats();
    if (stats.recordCount > 0) {
      // Find target shards for migration
      const targetShards = Array.from(this.shards.keys())
        .filter(id => id !== shardId);
      
      if (targetShards.length === 0) {
        throw new Error('Cannot remove last shard');
      }
      
      // Distribute data evenly among remaining shards
      const recordsPerShard = Math.ceil(stats.recordCount / targetShards.length);
      let currentOffset = 0;
      
      for (const targetShardId of targetShards) {
        const batch = await shard.getBatch(currentOffset, recordsPerShard);
        if (batch.length > 0) {
          const targetShard = this.shards.get(targetShardId);
          await targetShard.insertBatch(batch);
          currentOffset += batch.length;
        }
      }
    }
    
    // Close connections and remove
    await shard.close();
    this.shards.delete(shardId);
    
    // Rebuild hash ring
    this.buildShardRing();
    
    this.emit('shard-removed', { shardId, migratedRecords: stats.recordCount });
  }

  /**
   * Get sharding status
   */
  getStatus() {
    const shardStatus = {};
    
    for (const [shardId, shard] of this.shards) {
      shardStatus[shardId] = {
        id: shardId,
        status: shard.isConnected() ? 'connected' : 'disconnected',
        readReplicas: shard.readReplicas.length,
        virtualNodes: this.shardRing.filter(n => n.shardId === shardId).length
      };
    }
    
    return {
      strategy: this.options.shardingStrategy,
      totalShards: this.shards.size,
      virtualNodes: this.shardRing.length,
      activeMigrations: Array.from(this.migrationTasks.values())
        .filter(t => t.status === 'running').length,
      shards: shardStatus
    };
  }
}

/**
 * Database shard implementation
 */
export class DatabaseShard extends EventEmitter {
  constructor(options) {
    super();
    
    this.options = {
      id: options.id,
      name: options.name,
      host: options.host,
      port: options.port,
      database: options.database,
      weight: options.weight || 1,
      maxConnections: options.maxConnections || 100,
      readReplicas: options.readReplicas || [],
      ...options
    };
    
    this.connections = {
      write: null,
      read: [],
      readIndex: 0
    };
    
    this.queryQueue = [];
    this.stats = {
      queriesExecuted: 0,
      queryErrors: 0,
      avgResponseTime: 0,
      recordCount: 0,
      dataSize: 0,
      connectionCount: 0
    };
    
    this.prepared = new Map(); // For 2PC transactions
    
    this.initializeConnections();
  }

  /**
   * Initialize database connections
   */
  async initializeConnections() {
    try {
      // Initialize write connection
      this.connections.write = await this.createConnection({
        host: this.options.host,
        port: this.options.port,
        database: this.options.database,
        type: 'write'
      });
      
      // Initialize read replica connections
      for (const replica of this.options.readReplicas) {
        const readConn = await this.createConnection({
          host: replica.host,
          port: replica.port,
          database: replica.database,
          type: 'read'
        });
        
        this.connections.read.push(readConn);
      }
      
      this.emit('connected', {
        shardId: this.options.id,
        writeConnections: 1,
        readConnections: this.connections.read.length
      });
      
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Create database connection
   */
  async createConnection(config) {
    // In production, use actual database driver
    const connection = {
      id: crypto.randomBytes(8).toString('hex'),
      config,
      connected: true,
      lastUsed: Date.now(),
      queries: 0
    };
    
    this.stats.connectionCount++;
    
    return connection;
  }

  /**
   * Execute query
   */
  async query(queryObj) {
    const startTime = Date.now();
    
    try {
      const connection = this.connections.write;
      
      if (!connection || !connection.connected) {
        throw new Error(`Shard ${this.options.id} not connected`);
      }
      
      // Simulate query execution
      const result = await this.executeQuery(connection, queryObj);
      
      const responseTime = Date.now() - startTime;
      this.updateStats(responseTime, true);
      
      this.emit('query', {
        query: queryObj.sql || queryObj.operation,
        responseTime,
        success: true
      });
      
      return result;
      
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.updateStats(responseTime, false);
      
      this.emit('query', {
        query: queryObj.sql || queryObj.operation,
        responseTime,
        success: false,
        error: error.message
      });
      
      throw error;
    }
  }

  /**
   * Execute query on read replica
   */
  async queryReadReplica(queryObj) {
    if (this.connections.read.length === 0) {
      return this.query(queryObj);
    }
    
    const connection = this.connections.read[this.connections.readIndex];
    this.connections.readIndex = (this.connections.readIndex + 1) % this.connections.read.length;
    
    const startTime = Date.now();
    
    try {
      const result = await this.executeQuery(connection, queryObj);
      
      const responseTime = Date.now() - startTime;
      this.updateStats(responseTime, true);
      
      return result;
      
    } catch (error) {
      // Fallback to write connection
      logger.warn(`Read replica query failed, falling back to write connection: ${error.message}`);
      return this.query(queryObj);
    }
  }

  /**
   * Execute query implementation
   */
  async executeQuery(connection, queryObj) {
    // Simulate database query
    const delay = Math.random() * 50 + 10; // 10-60ms
    await new Promise(resolve => setTimeout(resolve, delay));
    
    connection.queries++;
    connection.lastUsed = Date.now();
    
    // Simulate different query types
    if (queryObj.sql) {
      const sql = queryObj.sql.toLowerCase();
      
      if (sql.includes('select')) {
        return {
          rows: Array.from({ length: Math.floor(Math.random() * 100) }, (_, i) => ({
            id: i + 1,
            data: `record_${i + 1}`
          })),
          rowCount: Math.floor(Math.random() * 100)
        };
      } else if (sql.includes('insert')) {
        this.stats.recordCount++;
        return { insertId: Math.floor(Math.random() * 10000), affectedRows: 1 };
      } else if (sql.includes('update')) {
        return { affectedRows: Math.floor(Math.random() * 10) };
      } else if (sql.includes('delete')) {
        const affected = Math.floor(Math.random() * 5);
        this.stats.recordCount -= affected;
        return { affectedRows: affected };
      }
    }
    
    return { success: true };
  }

  /**
   * Prepare transaction (2PC)
   */
  async prepare(transactionId, operation) {
    this.prepared.set(transactionId, {
      operation,
      timestamp: Date.now(),
      status: 'prepared'
    });
    
    // Simulate preparation
    await new Promise(resolve => setTimeout(resolve, 10));
    
    return { prepared: true };
  }

  /**
   * Commit transaction
   */
  async commit(transactionId) {
    const preparedOp = this.prepared.get(transactionId);
    if (!preparedOp) {
      throw new Error(`Transaction ${transactionId} not prepared`);
    }
    
    try {
      // Execute the prepared operation
      const result = await this.executeQuery(this.connections.write, preparedOp.operation);
      
      this.prepared.delete(transactionId);
      
      return result;
      
    } catch (error) {
      this.prepared.delete(transactionId);
      throw error;
    }
  }

  /**
   * Rollback transaction
   */
  async rollback(transactionId) {
    this.prepared.delete(transactionId);
    return { rolled_back: true };
  }

  /**
   * Get batch of records for migration
   */
  async getBatch(offset, limit) {
    const query = {
      sql: `SELECT * FROM main_table LIMIT ${limit} OFFSET ${offset}`,
      type: 'select'
    };
    
    const result = await this.query(query);
    return result.rows || [];
  }

  /**
   * Insert batch of records
   */
  async insertBatch(records) {
    for (const record of records) {
      const query = {
        sql: `INSERT INTO main_table VALUES (${Object.values(record).map(v => `'${v}'`).join(', ')})`,
        type: 'insert'
      };
      
      await this.query(query);
    }
    
    return { inserted: records.length };
  }

  /**
   * Mark records for deletion
   */
  async markForDeletion(count) {
    // In production, implement soft delete or cleanup mechanism
    return { marked: count };
  }

  /**
   * Update query statistics
   */
  updateStats(responseTime, success) {
    this.stats.queriesExecuted++;
    
    if (!success) {
      this.stats.queryErrors++;
    }
    
    // Update average response time
    const totalTime = this.stats.avgResponseTime * (this.stats.queriesExecuted - 1) + responseTime;
    this.stats.avgResponseTime = totalTime / this.stats.queriesExecuted;
  }

  /**
   * Get shard statistics
   */
  async getStats() {
    // Simulate getting actual database stats
    this.stats.dataSize = this.stats.recordCount * 1024; // Rough estimate
    this.stats.queryLoad = this.stats.queriesExecuted / Math.max(1, (Date.now() - this.startTime) / 60000);
    
    return { ...this.stats };
  }

  /**
   * Check if shard is connected
   */
  isConnected() {
    return this.connections.write && this.connections.write.connected;
  }

  /**
   * Close shard connections
   */
  async close() {
    if (this.connections.write) {
      this.connections.write.connected = false;
    }
    
    for (const readConn of this.connections.read) {
      readConn.connected = false;
    }
    
    this.emit('disconnected', { shardId: this.options.id });
  }
}

/**
 * Query optimizer
 */
export class QueryOptimizer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      cacheSize: 1000,
      cacheExpiry: 300000, // 5 minutes
      indexHints: true,
      queryAnalysis: true,
      slowQueryThreshold: 1000, // 1 second
      ...options
    };
    
    this.queryCache = new Map();
    this.executionPlans = new Map();
    this.indexSuggestions = new Map();
    this.slowQueries = [];
  }

  /**
   * Optimize query
   */
  optimizeQuery(query) {
    const optimized = { ...query };
    
    // Check cache first
    const cacheKey = this.getCacheKey(query);
    if (this.queryCache.has(cacheKey)) {
      const cached = this.queryCache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.options.cacheExpiry) {
        this.emit('cache-hit', { query: query.sql });
        return cached.plan;
      }
    }
    
    // Apply optimizations
    optimized.sql = this.optimizeSQL(query.sql);
    
    if (this.options.indexHints) {
      optimized.hints = this.generateIndexHints(query);
    }
    
    // Cache optimized query
    this.queryCache.set(cacheKey, {
      plan: optimized,
      timestamp: Date.now(),
      hitCount: 0
    });
    
    this.emit('query-optimized', { 
      original: query.sql, 
      optimized: optimized.sql 
    });
    
    return optimized;
  }

  /**
   * Optimize SQL statement
   */
  optimizeSQL(sql) {
    let optimized = sql;
    
    // Remove unnecessary whitespace
    optimized = optimized.replace(/\s+/g, ' ').trim();
    
    // Optimize WHERE clauses
    optimized = this.optimizeWhereClause(optimized);
    
    // Optimize JOINs
    optimized = this.optimizeJoins(optimized);
    
    // Add LIMIT if missing for potentially large result sets
    if (optimized.toLowerCase().includes('select') && 
        !optimized.toLowerCase().includes('limit') &&
        !optimized.toLowerCase().includes('count(')) {
      optimized += ' LIMIT 1000';
    }
    
    return optimized;
  }

  /**
   * Optimize WHERE clause
   */
  optimizeWhereClause(sql) {
    // Move most selective conditions first
    // This is a simplified implementation
    return sql.replace(
      /WHERE (.+?) AND (.+?)(?=\s+ORDER|\s+GROUP|\s+LIMIT|$)/gi,
      (match, cond1, cond2) => {
        // Prioritize equality conditions
        if (cond1.includes('=') && !cond2.includes('=')) {
          return `WHERE ${cond1} AND ${cond2}`;
        } else if (!cond1.includes('=') && cond2.includes('=')) {
          return `WHERE ${cond2} AND ${cond1}`;
        }
        return match;
      }
    );
  }

  /**
   * Optimize JOIN operations
   */
  optimizeJoins(sql) {
    // Convert implicit JOINs to explicit JOINs
    return sql.replace(
      /FROM\s+(\w+)\s*,\s*(\w+)\s+WHERE\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/gi,
      'FROM $1 JOIN $2 ON $3.$4 = $5.$6'
    );
  }

  /**
   * Generate index hints
   */
  generateIndexHints(query) {
    const hints = [];
    const sql = query.sql.toLowerCase();
    
    // Suggest index for WHERE clauses
    const whereMatch = sql.match(/where\s+(\w+)\s*[=<>]/);
    if (whereMatch) {
      hints.push({
        type: 'USE_INDEX',
        column: whereMatch[1],
        suggestion: `CREATE INDEX idx_${whereMatch[1]} ON table_name (${whereMatch[1]})`
      });
    }
    
    // Suggest index for ORDER BY
    const orderMatch = sql.match(/order\s+by\s+(\w+)/);
    if (orderMatch) {
      hints.push({
        type: 'USE_INDEX',
        column: orderMatch[1],
        suggestion: `CREATE INDEX idx_${orderMatch[1]}_order ON table_name (${orderMatch[1]})`
      });
    }
    
    return hints;
  }

  /**
   * Analyze query execution
   */
  analyzeExecution(query, result, responseTime) {
    const analysis = {
      query: query.sql,
      responseTime,
      rowsExamined: result.rowsExamined || 0,
      rowsReturned: result.rowCount || 0,
      cacheHit: result.fromCache || false,
      efficiency: this.calculateEfficiency(result),
      timestamp: Date.now()
    };
    
    // Track slow queries
    if (responseTime > this.options.slowQueryThreshold) {
      this.slowQueries.push(analysis);
      
      // Keep only recent slow queries
      if (this.slowQueries.length > 100) {
        this.slowQueries.shift();
      }
      
      this.emit('slow-query', analysis);
    }
    
    // Generate optimization suggestions
    const suggestions = this.generateSuggestions(analysis);
    if (suggestions.length > 0) {
      this.emit('optimization-suggestions', {
        query: query.sql,
        suggestions
      });
    }
    
    return analysis;
  }

  /**
   * Calculate query efficiency
   */
  calculateEfficiency(result) {
    if (!result.rowsExamined || result.rowsExamined === 0) {
      return 1.0;
    }
    
    const efficiency = (result.rowCount || 0) / result.rowsExamined;
    return Math.min(1.0, Math.max(0.0, efficiency));
  }

  /**
   * Generate optimization suggestions
   */
  generateSuggestions(analysis) {
    const suggestions = [];
    
    // Low efficiency suggestion
    if (analysis.efficiency < 0.1) {
      suggestions.push({
        type: 'LOW_EFFICIENCY',
        message: 'Query examines many more rows than returned. Consider adding indexes or refining WHERE clause.',
        priority: 'high'
      });
    }
    
    // Slow query suggestion
    if (analysis.responseTime > this.options.slowQueryThreshold) {
      suggestions.push({
        type: 'SLOW_QUERY',
        message: 'Query execution time exceeds threshold. Consider optimization.',
        priority: 'medium'
      });
    }
    
    // Full table scan suggestion
    if (analysis.rowsExamined > 10000) {
      suggestions.push({
        type: 'FULL_SCAN',
        message: 'Potential full table scan detected. Add appropriate indexes.',
        priority: 'high'
      });
    }
    
    return suggestions;
  }

  /**
   * Get cache key for query
   */
  getCacheKey(query) {
    const normalized = query.sql.toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/'/g, '"')
      .trim();
    
    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  /**
   * Get optimization statistics
   */
  getStats() {
    return {
      cachedQueries: this.queryCache.size,
      slowQueries: this.slowQueries.length,
      totalOptimizations: Array.from(this.queryCache.values())
        .reduce((sum, cached) => sum + cached.hitCount, 0),
      avgSlowQueryTime: this.slowQueries.length > 0
        ? this.slowQueries.reduce((sum, q) => sum + q.responseTime, 0) / this.slowQueries.length
        : 0
    };
  }
}

/**
 * Database connection pool
 */
export class ConnectionPool extends EventEmitter {
  constructor(config) {
    super();
    
    this.config = {
      min: 5,
      max: 20,
      idleTimeout: 30000,
      acquireTimeout: 10000,
      ...config
    };
    
    this.connections = [];
    this.available = [];
    this.pending = [];
    this.stats = {
      created: 0,
      destroyed: 0,
      acquired: 0,
      released: 0,
      timeouts: 0
    };
    
    this.initialize();
  }

  /**
   * Initialize connection pool
   */
  async initialize() {
    // Create minimum connections
    for (let i = 0; i < this.config.min; i++) {
      await this.createConnection();
    }
    
    // Start cleanup timer
    setInterval(() => {
      this.cleanup();
    }, 60000); // Every minute
    
    this.emit('initialized', {
      min: this.config.min,
      max: this.config.max,
      created: this.stats.created
    });
  }

  /**
   * Create new connection
   */
  async createConnection() {
    const connection = {
      id: crypto.randomBytes(8).toString('hex'),
      created: Date.now(),
      lastUsed: Date.now(),
      inUse: false,
      queries: 0
    };
    
    this.connections.push(connection);
    this.available.push(connection);
    this.stats.created++;
    
    this.emit('connection-created', { id: connection.id });
    
    return connection;
  }

  /**
   * Acquire connection from pool
   */
  async acquire() {
    return new Promise(async (resolve, reject) => {
      // Check if connection is available
      if (this.available.length > 0) {
        const connection = this.available.pop();
        connection.inUse = true;
        connection.lastUsed = Date.now();
        this.stats.acquired++;
        
        resolve(connection);
        return;
      }
      
      // Create new connection if under limit
      if (this.connections.length < this.config.max) {
        try {
          const connection = await this.createConnection();
          connection.inUse = true;
          this.stats.acquired++;
          
          resolve(connection);
          return;
        } catch (error) {
          reject(error);
          return;
        }
      }
      
      // Queue request
      const timeout = setTimeout(() => {
        const index = this.pending.findIndex(p => p.resolve === resolve);
        if (index !== -1) {
          this.pending.splice(index, 1);
        }
        
        this.stats.timeouts++;
        reject(new Error('Connection acquisition timeout'));
      }, this.config.acquireTimeout);
      
      this.pending.push({ resolve, reject, timeout });
    });
  }

  /**
   * Release connection back to pool
   */
  release(connection) {
    if (!connection || !connection.inUse) {
      return;
    }
    
    connection.inUse = false;
    connection.lastUsed = Date.now();
    
    // Serve pending request if any
    if (this.pending.length > 0) {
      const pending = this.pending.shift();
      clearTimeout(pending.timeout);
      
      connection.inUse = true;
      this.stats.acquired++;
      
      pending.resolve(connection);
    } else {
      this.available.push(connection);
    }
    
    this.stats.released++;
    this.emit('connection-released', { id: connection.id });
  }

  /**
   * Cleanup idle connections
   */
  cleanup() {
    const now = Date.now();
    const toRemove = [];
    
    // Find idle connections to remove (keep minimum)
    for (const connection of this.available) {
      if (this.connections.length <= this.config.min) break;
      
      if (now - connection.lastUsed > this.config.idleTimeout) {
        toRemove.push(connection);
      }
    }
    
    // Remove idle connections
    for (const connection of toRemove) {
      this.destroyConnection(connection);
    }
    
    if (toRemove.length > 0) {
      this.emit('cleanup', { removed: toRemove.length });
    }
  }

  /**
   * Destroy connection
   */
  destroyConnection(connection) {
    // Remove from all arrays
    const connIndex = this.connections.findIndex(c => c.id === connection.id);
    if (connIndex !== -1) {
      this.connections.splice(connIndex, 1);
    }
    
    const availIndex = this.available.findIndex(c => c.id === connection.id);
    if (availIndex !== -1) {
      this.available.splice(availIndex, 1);
    }
    
    this.stats.destroyed++;
    this.emit('connection-destroyed', { id: connection.id });
  }

  /**
   * Get pool status
   */
  getStatus() {
    return {
      total: this.connections.length,
      available: this.available.length,
      inUse: this.connections.filter(c => c.inUse).length,
      pending: this.pending.length,
      config: this.config,
      stats: this.stats
    };
  }

  /**
   * Close pool
   */
  async close() {
    // Cancel all pending requests
    for (const pending of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Pool is closing'));
    }
    this.pending = [];
    
    // Close all connections
    const toDestroy = [...this.connections];
    for (const connection of toDestroy) {
      this.destroyConnection(connection);
    }
    
    this.emit('closed');
  }
}

export default {
  ShardingCoordinator,
  DatabaseShard,
  QueryOptimizer,
  ConnectionPool
};