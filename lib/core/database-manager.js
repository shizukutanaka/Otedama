/**
 * Otedama Unified Database Manager
 * 
 * Integrates all database functionality into a single, high-performance module
 * following John Carmack (performance), Robert C. Martin (clean code), 
 * and Rob Pike (simplicity) principles.
 * 
 * Replaces:
 * - database-config.js
 * - database-integrity.js
 * - database-optimizer.js
 * - database-pool-manager.js
 * - database/manager.js
 */

import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { createHash, randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { existsSync, unlinkSync, readdirSync, statSync } from 'fs';
import { copyFile, mkdir } from 'fs/promises';
import { dirname, resolve, join } from 'path';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { QueryOptimizer } from '../performance/query-optimizer.js';
import { ConnectionPoolTuner } from '../performance/connection-pool-tuner.js';

// Constants for optimal performance (Carmack principle)
const DB_CONSTANTS = Object.freeze({
  // Performance optimized values
  DEFAULT_POOL_SIZE: 8,
  MAX_POOL_SIZE: 32,
  CONNECTION_TIMEOUT: 10000,
  QUERY_TIMEOUT: 5000,
  
  // Batch processing
  BATCH_SIZE: 500,
  BATCH_TIMEOUT: 50,
  
  // Cache settings (memory optimized)
  CACHE_SIZE: -64000,           // 64MB negative = KB
  MMAP_SIZE: 268435456,         // 256MB
  
  // WAL settings
  WAL_AUTOCHECKPOINT: 1000,
  CHECKPOINT_INTERVAL: 300000,   // 5 minutes
  
  // Maintenance
  VACUUM_INTERVAL: 86400000,     // 24 hours
  INTEGRITY_CHECK_INTERVAL: 3600000, // 1 hour
  BACKUP_INTERVAL: 3600000,      // 1 hour
  
  // Thresholds
  SLOW_QUERY_THRESHOLD: 100,     // 100ms
  MAX_RETRIES: 3,
  RETRY_DELAY: 100,
  
  // Cleanup
  MAX_BACKUPS: 24,
  IDLE_CONNECTION_TIMEOUT: 600000, // 10 minutes
});

// Optimized database pragmas
const OPTIMAL_PRAGMAS = Object.freeze({
  journal_mode: 'WAL',
  synchronous: 'NORMAL',
  cache_size: DB_CONSTANTS.CACHE_SIZE,
  mmap_size: DB_CONSTANTS.MMAP_SIZE,
  temp_store: 'MEMORY',
  foreign_keys: 'ON',
  wal_autocheckpoint: DB_CONSTANTS.WAL_AUTOCHECKPOINT,
  busy_timeout: 5000,
  optimize: null,
  analysis_limit: 1000,
});

/**
 * Connection wrapper with state management
 */
class PooledConnection {
  constructor(id, dbPath, readonly = false) {
    this.id = id;
    this.dbPath = dbPath;
    this.readonly = readonly;
    this.db = null;
    this.state = 'idle';
    this.lastUsed = Date.now();
    this.useCount = 0;
    this.errorCount = 0;
    this.createdAt = Date.now();
    this.statementCache = new Map();
  }

  async connect() {
    try {
      this.db = new Database(this.dbPath, { 
        readonly: this.readonly,
        timeout: DB_CONSTANTS.CONNECTION_TIMEOUT 
      });
      
      this.applyOptimizations();
      this.validate();
      this.state = 'idle';
      
      return true;
    } catch (error) {
      this.state = 'error';
      this.errorCount++;
      throw error;
    }
  }

  applyOptimizations() {
    // Apply all optimized pragmas
    for (const [pragma, value] of Object.entries(OPTIMAL_PRAGMAS)) {
      try {
        if (value === null) {
          this.db.pragma(pragma);
        } else {
          this.db.pragma(`${pragma} = ${value}`);
        }
      } catch (error) {
        console.warn(`Failed to apply pragma ${pragma}:`, error.message);
      }
    }

    // Read-only specific optimizations
    if (this.readonly) {
      this.db.pragma('query_only = ON');
    }
  }

  validate() {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch (error) {
      this.state = 'error';
      return false;
    }
  }

  acquire() {
    if (this.state !== 'idle') {
      throw new Error(`Connection ${this.id} is not available (state: ${this.state})`);
    }
    
    this.state = 'active';
    this.lastUsed = Date.now();
    this.useCount++;
  }

  release() {
    this.state = 'idle';
    this.lastUsed = Date.now();
  }

  // Prepared statement cache for performance
  getStatement(sql) {
    if (!this.statementCache.has(sql)) {
      this.statementCache.set(sql, this.db.prepare(sql));
    }
    return this.statementCache.get(sql);
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.state = 'closed';
    this.statementCache.clear();
  }

  isHealthy() {
    return this.state === 'idle' && 
           this.errorCount < 5 && 
           this.validate();
  }

  shouldReplace() {
    const age = Date.now() - this.createdAt;
    return this.errorCount > 3 || 
           this.useCount > 10000 || 
           age > 3600000; // 1 hour
  }
}

/**
 * Transaction manager with savepoints
 */
class TransactionManager {
  constructor(connection) {
    this.connection = connection;
    this.active = false;
    this.savepoints = [];
    this.startTime = null;
  }

  begin(isolationLevel = null) {
    if (this.active) {
      throw new Error('Transaction already active');
    }

    try {
      if (isolationLevel) {
        // Validate isolation level to prevent SQL injection
        const validLevels = ['DEFERRED', 'IMMEDIATE', 'EXCLUSIVE'];
        if (!validLevels.includes(isolationLevel.toUpperCase())) {
          throw new Error(`Invalid isolation level: ${isolationLevel}`);
        }
        this.connection.db.prepare(`BEGIN ${isolationLevel}`).run();
      } else {
        this.connection.db.prepare('BEGIN IMMEDIATE').run();
      }
      
      this.active = true;
      this.startTime = Date.now();
      return this;
    } catch (error) {
      throw new Error(`Failed to begin transaction: ${error.message}`);
    }
  }

  savepoint(name) {
    if (!this.active) {
      throw new Error('No active transaction');
    }

    try {
      // Validate savepoint name to prevent SQL injection
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error('Invalid savepoint name: must be alphanumeric with underscores');
      }
      this.connection.db.prepare('SAVEPOINT ?').run(name);
      this.savepoints.push(name);
      return this;
    } catch (error) {
      throw new Error(`Failed to create savepoint: ${error.message}`);
    }
  }

  rollbackTo(name) {
    if (!this.active) {
      throw new Error('No active transaction');
    }

    try {
      // Validate savepoint name to prevent SQL injection
      if (!this.savepoints.includes(name)) {
        throw new Error(`Unknown savepoint: ${name}`);
      }
      this.connection.db.prepare('ROLLBACK TO ?').run(name);
      
      // Remove savepoints after the rollback point
      const index = this.savepoints.indexOf(name);
      if (index !== -1) {
        this.savepoints = this.savepoints.slice(0, index + 1);
      }
      
      return this;
    } catch (error) {
      throw new Error(`Failed to rollback to savepoint: ${error.message}`);
    }
  }

  commit() {
    if (!this.active) {
      throw new Error('No active transaction');
    }

    try {
      this.connection.db.prepare('COMMIT').run();
      this.cleanup();
      return this;
    } catch (error) {
      this.rollback();
      throw new Error(`Failed to commit transaction: ${error.message}`);
    }
  }

  rollback() {
    if (!this.active) {
      throw new Error('No active transaction');
    }

    try {
      this.connection.db.prepare('ROLLBACK').run();
      this.cleanup();
      return this;
    } catch (error) {
      this.cleanup();
      throw new Error(`Failed to rollback transaction: ${error.message}`);
    }
  }

  cleanup() {
    this.active = false;
    this.savepoints = [];
    this.startTime = null;
  }

  getDuration() {
    return this.startTime ? Date.now() - this.startTime : 0;
  }
}

/**
 * Batch processor for high-throughput operations
 */
class BatchProcessor {
  constructor(dbManager) {
    this.dbManager = dbManager;
    this.batches = new Map(); // table -> operations
    this.timers = new Map();  // table -> timer
    this.options = {
      batchSize: DB_CONSTANTS.BATCH_SIZE,
      batchTimeout: DB_CONSTANTS.BATCH_TIMEOUT
    };
  }

  add(table, operation, sql, params) {
    if (!this.batches.has(table)) {
      this.batches.set(table, []);
    }

    this.batches.get(table).push({ operation, sql, params, timestamp: Date.now() });

    // Set timeout for this table if not already set
    if (!this.timers.has(table)) {
      this.timers.set(table, setTimeout(() => {
        this.flush(table);
      }, this.options.batchTimeout));
    }

    // Flush if batch is full
    if (this.batches.get(table).length >= this.options.batchSize) {
      this.flush(table);
    }
  }

  async flush(table) {
    const batch = this.batches.get(table);
    if (!batch || batch.length === 0) return;

    // Clear batch and timer
    this.batches.delete(table);
    if (this.timers.has(table)) {
      clearTimeout(this.timers.get(table));
      this.timers.delete(table);
    }

    try {
      await this.dbManager.transaction(async (tx) => {
        const grouped = this.groupBySQL(batch);
        
        for (const [sql, operations] of grouped) {
          const stmt = tx.connection.getStatement(sql);
          
          for (const op of operations) {
            try {
              stmt.run(...op.params);
            } catch (error) {
              console.warn(`Batch operation failed for ${table}:`, error.message);
            }
          }
        }
      });

      this.dbManager.emit('batch:completed', { 
        table, 
        operations: batch.length,
        duration: Date.now() - batch[0].timestamp 
      });

    } catch (error) {
      this.dbManager.emit('batch:error', { table, error: error.message });
      
      // Re-queue failed operations
      for (const op of batch) {
        this.add(table, op.operation, op.sql, op.params);
      }
    }
  }

  groupBySQL(operations) {
    const grouped = new Map();
    
    for (const op of operations) {
      if (!grouped.has(op.sql)) {
        grouped.set(op.sql, []);
      }
      grouped.get(op.sql).push(op);
    }
    
    return grouped;
  }

  async flushAll() {
    const tables = Array.from(this.batches.keys());
    await Promise.all(tables.map(table => this.flush(table)));
  }
}

/**
 * Integrity checker with self-healing capabilities
 */
class IntegrityChecker {
  constructor(dbManager) {
    this.dbManager = dbManager;
    this.checks = new Map();
    this.setupDefaultChecks();
  }

  setupDefaultChecks() {
    // Foreign key integrity
    this.checks.set('foreign_keys', async (db) => {
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      return {
        passed: violations.length === 0,
        issues: violations,
        fixable: true
      };
    });

    // SQLite integrity check
    this.checks.set('sqlite_integrity', async (db) => {
      const result = db.prepare('PRAGMA integrity_check').all();
      const passed = result.length === 1 && result[0].integrity_check === 'ok';
      return {
        passed,
        issues: passed ? [] : result,
        fixable: false
      };
    });

    // Index consistency
    this.checks.set('indexes', async (db) => {
      try {
        const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
        const issues = [];
        
        for (const index of indexes) {
          try {
            db.prepare(`PRAGMA index_info(${index.name})`).all();
          } catch (error) {
            issues.push({ index: index.name, error: error.message });
          }
        }
        
        return {
          passed: issues.length === 0,
          issues,
          fixable: true
        };
      } catch (error) {
        return {
          passed: false,
          issues: [{ error: error.message }],
          fixable: false
        };
      }
    });
  }

  async runCheck(checkName = null) {
    const connection = await this.dbManager.getConnection(true); // readonly
    
    try {
      const results = new Map();
      const checksToRun = checkName ? [checkName] : Array.from(this.checks.keys());
      
      for (const name of checksToRun) {
        if (this.checks.has(name)) {
          try {
            const result = await this.checks.get(name)(connection.db);
            results.set(name, result);
          } catch (error) {
            results.set(name, {
              passed: false,
              issues: [{ error: error.message }],
              fixable: false
            });
          }
        }
      }
      
      return results;
      
    } finally {
      this.dbManager.releaseConnection(connection);
    }
  }

  async autoRepair(checkResults) {
    const writeConnection = await this.dbManager.getConnection(false);
    
    try {
      const repairResults = new Map();
      
      for (const [checkName, result] of checkResults) {
        if (!result.passed && result.fixable) {
          try {
            let repaired = false;
            
            switch (checkName) {
              case 'foreign_keys':
                repaired = await this.repairForeignKeys(writeConnection.db, result.issues);
                break;
              case 'indexes':
                repaired = await this.repairIndexes(writeConnection.db, result.issues);
                break;
            }
            
            repairResults.set(checkName, { success: repaired });
            
          } catch (error) {
            repairResults.set(checkName, { 
              success: false, 
              error: error.message 
            });
          }
        }
      }
      
      return repairResults;
      
    } finally {
      this.dbManager.releaseConnection(writeConnection);
    }
  }

  async repairForeignKeys(db, violations) {
    let repaired = 0;
    
    for (const violation of violations) {
      try {
        // Simple repair: delete orphaned records
        const deleteStmt = db.prepare(`DELETE FROM ${violation.table} WHERE rowid = ?`);
        deleteStmt.run(violation.rowid);
        repaired++;
      } catch (error) {
        console.warn(`Failed to repair FK violation in ${violation.table}:`, error.message);
      }
    }
    
    return repaired > 0;
  }

  async repairIndexes(db, issues) {
    let repaired = 0;
    
    for (const issue of issues) {
      try {
        if (issue.index) {
          db.prepare(`REINDEX ${issue.index}`).run();
          repaired++;
        }
      } catch (error) {
        console.warn(`Failed to repair index ${issue.index}:`, error.message);
      }
    }
    
    return repaired > 0;
  }
}

/**
 * Main Database Manager - Clean Architecture (Martin principle)
 */
export class DatabaseManager extends EventEmitter {
  constructor(dbPath, options = {}) {
    super();

    this.dbPath = resolve(dbPath);
    this.options = {
      poolSize: options.poolSize || DB_CONSTANTS.DEFAULT_POOL_SIZE,
      maxConnections: options.maxConnections || DB_CONSTANTS.MAX_POOL_SIZE,
      enableBackup: options.enableBackup !== false,
      enableIntegrityCheck: options.enableIntegrityCheck !== false,
      enableBatching: options.enableBatching !== false,
      backupDir: options.backupDir || resolve(dirname(this.dbPath), 'backups'),
      ...options
    };

    // Core components
    this.readPool = [];
    this.writePool = [];
    this.availableReads = [];
    this.availableWrites = [];
    this.waitQueue = [];

    // Managers
    this.batchProcessor = new BatchProcessor(this);
    this.integrityChecker = new IntegrityChecker(this);
    this.queryOptimizer = null; // Will be initialized after connections are created

    // State
    this.initialized = false;
    this.connectionCounter = 0;

    // Metrics (Pike principle - simple tracking)
    this.metrics = {
      queries: 0,
      transactions: 0,
      errors: 0,
      slowQueries: 0,
      avgQueryTime: 0,
      backups: 0,
      integrityChecks: 0
    };

    // Intervals
    this.intervals = {
      backup: null,
      integrity: null,
      checkpoint: null,
      vacuum: null,
      cleanup: null
    };
  }

  async initialize() {
    if (this.initialized) return;

    // Ensure database directory exists
    const dbDir = dirname(this.dbPath);
    if (!existsSync(dbDir)) {
      await mkdir(dbDir, { recursive: true });
    }

    // Create connection pools
    await this.createConnections();

    // Setup backup directory
    if (this.options.enableBackup) {
      if (!existsSync(this.options.backupDir)) {
        await mkdir(this.options.backupDir, { recursive: true });
      }
    }

    // Initialize query optimizer with a write connection
    if (this.writePool.length > 0) {
      this.queryOptimizer = new QueryOptimizer(this.writePool[0].db, {
        enableCache: this.options.enableQueryCache !== false,
        enableBatching: this.options.enableBatching,
        enableAnalysis: this.options.enableQueryAnalysis !== false,
        slowQueryThreshold: this.options.slowQueryThreshold || DB_CONSTANTS.SLOW_QUERY_THRESHOLD
      });
      
      // Listen to optimizer events
      this.queryOptimizer.on('slow:query', (data) => {
        this.emit('query:slow', data);
      });
      
      this.queryOptimizer.on('cache:hit', (data) => {
        this.emit('cache:hit', data);
      });
    }

    // Initialize connection pool tuner
    if (this.options.enablePoolTuning !== false) {
      this.poolTuner = new ConnectionPoolTuner({
        minConnections: this.options.minPoolSize || 2,
        maxConnections: this.options.maxPoolSize || DB_CONSTANTS.MAX_POOL_SIZE,
        targetUtilization: this.options.targetUtilization || 0.7,
        checkInterval: this.options.poolTuneInterval || 30000,
        idleTimeout: this.options.connectionIdleTimeout || 300000
      });

      // Register pools for tuning
      this.poolTuner.registerPool('read', {
        acquire: () => this.acquireRead(),
        release: (conn) => this.releaseConnection(conn, true),
        size: this.readPool.length,
        available: this.availableReads.length,
        setSize: async (size) => this.resizePool('read', size),
        getAllConnections: () => this.readPool
      });

      this.poolTuner.registerPool('write', {
        acquire: () => this.acquireWrite(),
        release: (conn) => this.releaseConnection(conn, false),
        size: this.writePool.length,
        available: this.availableWrites.length,
        setSize: async (size) => this.resizePool('write', size),
        getAllConnections: () => this.writePool
      });

      // Listen to tuning events
      this.poolTuner.on('tuning', (data) => {
        this.emit('pool:tuning', data);
      });

      this.poolTuner.on('metrics', (data) => {
        this.emit('pool:metrics', data);
      });

      // Start tuning
      this.poolTuner.start();
    }

    // Start maintenance tasks
    this.startMaintenance();

    this.initialized = true;
    this.emit('initialized', {
      readConnections: this.readPool.length,
      writeConnections: this.writePool.length,
      optimizerEnabled: !!this.queryOptimizer
    });
  }

  async createConnections() {
    const promises = [];

    // Create read connections
    for (let i = 0; i < this.options.poolSize; i++) {
      promises.push(this.createConnection(true));
    }

    // Create write connections (fewer needed)
    const writePoolSize = Math.max(2, Math.floor(this.options.poolSize / 2));
    for (let i = 0; i < writePoolSize; i++) {
      promises.push(this.createConnection(false));
    }

    await Promise.allSettled(promises);

    if (this.readPool.length === 0 || this.writePool.length === 0) {
      throw new Error('Failed to create minimum required database connections');
    }
  }

  async createConnection(readonly = true) {
    const id = `${readonly ? 'r' : 'w'}-${++this.connectionCounter}`;
    const connection = new PooledConnection(id, this.dbPath, readonly);

    try {
      await connection.connect();

      if (readonly) {
        this.readPool.push(connection);
        this.availableReads.push(connection);
      } else {
        this.writePool.push(connection);
        this.availableWrites.push(connection);
      }

      this.emit('connection:created', { id, readonly });
      return connection;

    } catch (error) {
      this.emit('connection:error', { id, error: error.message });
      throw error;
    }
  }

  async getConnection(readonly = true) {
    const pool = readonly ? this.availableReads : this.availableWrites;
    
    // Find available connection
    let connection = pool.find(conn => conn.state === 'idle' && conn.isHealthy());
    
    if (connection) {
      connection.acquire();
      const index = pool.indexOf(connection);
      pool.splice(index, 1);
      return connection;
    }

    // Wait for available connection with timeout handling
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waitQueue.findIndex(w => w.resolve === resolve);
        if (index !== -1) {
          this.waitQueue.splice(index, 1);
          reject(new Error(`Connection acquisition timeout after ${DB_CONSTANTS.CONNECTION_TIMEOUT}ms`));
        }
      }, DB_CONSTANTS.CONNECTION_TIMEOUT);

      const waiter = { readonly, resolve, reject, timeout, timestamp: Date.now() };
      this.waitQueue.push(waiter);
      
      // Emit warning if queue is getting long
      if (this.waitQueue.length > 10) {
        this.emit('pool:queue_warning', { 
          queueLength: this.waitQueue.length,
          readonly 
        });
      }
    });
  }

  releaseConnection(connection) {
    if (!connection) return;

    connection.release();

    // Process wait queue first (FIFO with timeout consideration)
    let waiterIndex = -1;
    let shortestWait = Infinity;
    const now = Date.now();
    
    for (let i = 0; i < this.waitQueue.length; i++) {
      const waiter = this.waitQueue[i];
      if (waiter.readonly === connection.readonly) {
        const waitTime = now - waiter.timestamp;
        if (waitTime < shortestWait) {
          shortestWait = waitTime;
          waiterIndex = i;
        }
      }
    }
    
    if (waiterIndex !== -1) {
      const waiter = this.waitQueue.splice(waiterIndex, 1)[0];
      clearTimeout(waiter.timeout);
      connection.acquire();
      waiter.resolve(connection);
      return;
    }

    // Return to available pool
    if (connection.readonly) {
      this.availableReads.push(connection);
    } else {
      this.availableWrites.push(connection);
    }

    // Replace if needed
    if (connection.shouldReplace()) {
      this.replaceConnection(connection);
    }
  }

  async replaceConnection(oldConnection) {
    try {
      const newConnection = await this.createConnection(oldConnection.readonly);
      
      // Remove old connection from pools
      const pool = oldConnection.readonly ? this.readPool : this.writePool;
      const availablePool = oldConnection.readonly ? this.availableReads : this.availableWrites;
      
      const poolIndex = pool.indexOf(oldConnection);
      const availableIndex = availablePool.indexOf(oldConnection);
      
      if (poolIndex !== -1) pool.splice(poolIndex, 1);
      if (availableIndex !== -1) availablePool.splice(availableIndex, 1);
      
      oldConnection.close();
      
      this.emit('connection:replaced', {
        oldId: oldConnection.id,
        newId: newConnection.id
      });
      
    } catch (error) {
      this.emit('connection:replacement_failed', {
        oldId: oldConnection.id,
        error: error.message
      });
    }
  }

  // Simple query interface (Pike principle)
  async query(sql, params = [], options = {}) {
    // Use query optimizer if available
    if (this.queryOptimizer && this.options.enableQueryOptimizer !== false) {
      return this.queryOptimizer.query(sql, params, options);
    }
    
    // Fallback to direct execution
    const startTime = performance.now();
    const readonly = this.isReadQuery(sql);
    
    try {
      // Use batching for write operations if enabled
      if (!readonly && this.options.enableBatching && this.canBatch(sql)) {
        const table = this.extractTableName(sql);
        this.batchProcessor.add(table, 'query', sql, params);
        return { batched: true };
      }

      const connection = await this.getConnection(readonly);
      
      try {
        const stmt = connection.getStatement(sql);
        const result = readonly ? stmt.all(...params) : stmt.run(...params);
        
        const duration = performance.now() - startTime;
        this.updateMetrics(duration, readonly);
        
        return result;
        
      } finally {
        this.releaseConnection(connection);
      }
      
    } catch (error) {
      this.metrics.errors++;
      this.emit('query:error', { sql: sql.substring(0, 100), error: error.message });
      throw error;
    }
  }

  async get(sql, params = []) {
    const connection = await this.getConnection(true);
    
    try {
      const stmt = connection.getStatement(sql);
      return stmt.get(...params);
    } finally {
      this.releaseConnection(connection);
    }
  }

  async all(sql, params = []) {
    const connection = await this.getConnection(true);
    
    try {
      const stmt = connection.getStatement(sql);
      return stmt.all(...params);
    } finally {
      this.releaseConnection(connection);
    }
  }

  async run(sql, params = []) {
    return this.query(sql, params, { readonly: false });
  }

  // Transaction support
  async transaction(callback, options = {}) {
    const connection = await this.getConnection(false);
    const transaction = new TransactionManager(connection);
    
    try {
      transaction.begin(options.isolationLevel);
      
      const txContext = {
        connection,
        query: (sql, params) => {
          const stmt = connection.getStatement(sql);
          return stmt.run(...params);
        },
        get: (sql, params) => {
          const stmt = connection.getStatement(sql);
          return stmt.get(...params);
        },
        all: (sql, params) => {
          const stmt = connection.getStatement(sql);
          return stmt.all(...params);
        },
        savepoint: (name) => transaction.savepoint(name),
        rollbackTo: (name) => transaction.rollbackTo(name)
      };
      
      const result = await callback(txContext);
      transaction.commit();
      
      this.metrics.transactions++;
      return result;
      
    } catch (error) {
      transaction.rollback();
      throw error;
      
    } finally {
      this.releaseConnection(connection);
    }
  }

  // Pool management methods
  async resizePool(type, targetSize) {
    const pool = type === 'read' ? this.readPool : this.writePool;
    const available = type === 'read' ? this.availableReads : this.availableWrites;
    const currentSize = pool.length;

    if (targetSize === currentSize) return;

    if (targetSize > currentSize) {
      // Scale up
      const promises = [];
      for (let i = currentSize; i < targetSize; i++) {
        promises.push(this.createConnection(type === 'read'));
      }
      await Promise.allSettled(promises);
    } else {
      // Scale down
      const toRemove = currentSize - targetSize;
      let removed = 0;

      // Remove idle connections first
      for (let i = available.length - 1; i >= 0 && removed < toRemove; i--) {
        const conn = available[i];
        if (conn.state === 'idle') {
          available.splice(i, 1);
          const poolIndex = pool.indexOf(conn);
          if (poolIndex !== -1) {
            pool.splice(poolIndex, 1);
          }
          await conn.close();
          removed++;
        }
      }

      // Force remove if needed (not recommended)
      while (removed < toRemove && pool.length > targetSize) {
        const conn = pool.pop();
        const availIndex = available.indexOf(conn);
        if (availIndex !== -1) {
          available.splice(availIndex, 1);
        }
        await conn.close();
        removed++;
      }
    }

    this.emit('pool:resized', {
      type,
      previousSize: currentSize,
      newSize: pool.length,
      targetSize
    });
  }

  // Utility methods
  isReadQuery(sql) {
    const normalizedSql = sql.trim().toLowerCase();
    return normalizedSql.startsWith('select') || 
           normalizedSql.startsWith('pragma') ||
           normalizedSql.startsWith('explain');
  }

  canBatch(sql) {
    const normalizedSql = sql.trim().toLowerCase();
    return normalizedSql.startsWith('insert') || 
           normalizedSql.startsWith('update');
  }

  extractTableName(sql) {
    // Whitelist of allowed table names for security
    const ALLOWED_TABLES = new Set([
      'users', 'sessions', 'api_keys', 'orders', 'trades', 'blocks',
      'transactions', 'miners', 'shares', 'wallets', 'balances',
      'user_sessions', 'login_attempts', 'password_resets',
      'mining_shares', 'dex_orders', 'dex_trades'
    ]);
    
    const match = sql.match(/(?:insert into|update|delete from)\s+(\w+)/i);
    const tableName = match ? match[1] : 'unknown';
    
    // Validate against whitelist to prevent SQL injection
    if (tableName !== 'unknown' && !ALLOWED_TABLES.has(tableName)) {
      throw new Error(`Invalid table name: ${tableName}`);
    }
    
    return tableName;
  }

  updateMetrics(duration, readonly) {
    this.metrics.queries++;
    
    // Update average query time
    const alpha = 0.1;
    this.metrics.avgQueryTime = alpha * duration + (1 - alpha) * this.metrics.avgQueryTime;
    
    // Track slow queries
    if (duration > DB_CONSTANTS.SLOW_QUERY_THRESHOLD) {
      this.metrics.slowQueries++;
      this.emit('query:slow', { duration });
    }
  }

  // Maintenance operations
  startMaintenance() {
    // Backup interval
    if (this.options.enableBackup) {
      this.intervals.backup = setInterval(() => {
        this.createBackup().catch(error => {
          this.emit('backup:error', error);
        });
      }, DB_CONSTANTS.BACKUP_INTERVAL);
    }

    // Integrity check interval
    if (this.options.enableIntegrityCheck) {
      this.intervals.integrity = setInterval(() => {
        this.runIntegrityCheck().catch(error => {
          this.emit('integrity:error', error);
        });
      }, DB_CONSTANTS.INTEGRITY_CHECK_INTERVAL);
    }

    // Checkpoint interval
    this.intervals.checkpoint = setInterval(() => {
      this.checkpoint().catch(error => {
        this.emit('checkpoint:error', error);
      });
    }, DB_CONSTANTS.CHECKPOINT_INTERVAL);

    // Vacuum interval
    this.intervals.vacuum = setInterval(() => {
      this.vacuum().catch(error => {
        this.emit('vacuum:error', error);
      });
    }, DB_CONSTANTS.VACUUM_INTERVAL);

    // Connection cleanup
    this.intervals.cleanup = setInterval(() => {
      this.cleanupConnections();
    }, DB_CONSTANTS.IDLE_CONNECTION_TIMEOUT);
  }

  async createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(this.options.backupDir, `otedama-${timestamp}.db`);
    
    const connection = await this.getConnection(true);
    
    try {
      // Checkpoint WAL before backup
      connection.db.pragma('wal_checkpoint(RESTART)');
      
      // Copy database file asynchronously to avoid blocking
      await copyFile(this.dbPath, backupPath);
      
      this.metrics.backups++;
      this.emit('backup:created', { path: backupPath });
      
      // Cleanup old backups
      await this.cleanupBackups();
      
      return backupPath;
      
    } finally {
      this.releaseConnection(connection);
    }
  }

  async cleanupBackups() {
    try {
      const files = readdirSync(this.options.backupDir)
        .filter(file => file.startsWith('otedama-') && file.endsWith('.db'))
        .map(file => ({
          name: file,
          path: join(this.options.backupDir, file),
          mtime: statSync(join(this.options.backupDir, file)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime); // Sort by newest first

      // Remove old backups
      if (files.length > DB_CONSTANTS.MAX_BACKUPS) {
        const toDelete = files.slice(DB_CONSTANTS.MAX_BACKUPS);
        for (const file of toDelete) {
          unlinkSync(file.path);
        }
        
        this.emit('backup:cleanup', { deleted: toDelete.length });
      }
      
    } catch (error) {
      this.emit('backup:cleanup_error', error);
    }
  }

  async runIntegrityCheck() {
    const results = await this.integrityChecker.runCheck();
    const hasIssues = Array.from(results.values()).some(result => !result.passed);
    
    if (hasIssues) {
      this.emit('integrity:issues', results);
      
      // Auto-repair if enabled
      const repairResults = await this.integrityChecker.autoRepair(results);
      this.emit('integrity:repair', repairResults);
    }
    
    this.metrics.integrityChecks++;
    this.emit('integrity:check', { results, hasIssues });
    
    return results;
  }

  async checkpoint() {
    const connection = await this.getConnection(false);
    
    try {
      connection.db.pragma('wal_checkpoint(RESTART)');
      this.emit('checkpoint:completed');
    } finally {
      this.releaseConnection(connection);
    }
  }

  async vacuum() {
    const connection = await this.getConnection(false);
    
    try {
      connection.db.prepare('VACUUM').run();
      this.emit('vacuum:completed');
    } finally {
      this.releaseConnection(connection);
    }
  }

  cleanupConnections() {
    const now = Date.now();
    
    // Check for idle connections that should be replaced
    const allConnections = [...this.readPool, ...this.writePool];
    
    for (const connection of allConnections) {
      if (connection.state === 'idle' && 
          (now - connection.lastUsed) > DB_CONSTANTS.IDLE_CONNECTION_TIMEOUT) {
        
        if (connection.shouldReplace()) {
          this.replaceConnection(connection);
        }
      }
    }
  }

  // Statistics and monitoring
  getStats() {
    const stats = {
      metrics: { ...this.metrics },
      pools: {
        read: {
          total: this.readPool.length,
          available: this.availableReads.length,
          active: this.readPool.length - this.availableReads.length
        },
        write: {
          total: this.writePool.length,
          available: this.availableWrites.length,
          active: this.writePool.length - this.availableWrites.length
        }
      },
      queued: this.waitQueue.length,
      batches: {
        pending: this.batchProcessor.batches.size,
        operations: Array.from(this.batchProcessor.batches.values())
          .reduce((sum, batch) => sum + batch.length, 0)
      }
    };
    
    // Include optimizer stats if available
    if (this.queryOptimizer) {
      stats.optimizer = this.queryOptimizer.getStats();
    }
    
    return stats;
  }

  async healthCheck() {
    try {
      const result = await this.get('SELECT 1 as health');
      return result && result.health === 1;
    } catch (error) {
      return false;
    }
  }

  // Graceful shutdown
  async shutdown() {
    // Stop maintenance intervals
    Object.values(this.intervals).forEach(interval => {
      if (interval) clearInterval(interval);
    });

    // Stop pool tuner
    if (this.poolTuner) {
      this.poolTuner.stop();
    }

    // Cleanup query optimizer
    if (this.queryOptimizer) {
      await this.queryOptimizer.cleanup();
    }

    // Flush all batches
    await this.batchProcessor.flushAll();

    // Close all connections
    const allConnections = [...this.readPool, ...this.writePool];
    allConnections.forEach(connection => connection.close());

    // Clear pools
    this.readPool.length = 0;
    this.writePool.length = 0;
    this.availableReads.length = 0;
    this.availableWrites.length = 0;

    // Reject pending requests
    this.waitQueue.forEach(waiter => {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('Database shutting down'));
    });
    this.waitQueue.length = 0;

    this.initialized = false;
    this.emit('shutdown');
  }
}

export { QueryOptimizer } from '../performance/query-optimizer.js';
export default DatabaseManager;
