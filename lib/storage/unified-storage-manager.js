/**
 * Unified Storage Manager - Otedama
 * Consolidated storage system with caching and persistence
 * 
 * Design Principles:
 * - Carmack: High-performance data access with minimal overhead
 * - Martin: Clean storage abstraction with separation of concerns
 * - Pike: Simple but powerful storage interface for complex requirements
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

const logger = createStructuredLogger('UnifiedStorageManager');

/**
 * Storage types
 */
const STORAGE_TYPES = {
  MEMORY: 'memory',
  FILE: 'file',
  DATABASE: 'database',
  CACHE: 'cache'
};

/**
 * Data types
 */
const DATA_TYPES = {
  SHARES: 'shares',
  BLOCKS: 'blocks',
  MINERS: 'miners',
  WORKERS: 'workers',
  PAYMENTS: 'payments',
  STATS: 'stats',
  CONFIG: 'config',
  LOGS: 'logs'
};

/**
 * In-memory cache
 */
class MemoryCache {
  constructor(config = {}) {
    this.config = {
      maxSize: config.maxSize || 100 * 1024 * 1024, // 100MB
      ttl: config.ttl || 3600000, // 1 hour
      cleanupInterval: config.cleanupInterval || 300000 // 5 minutes
    };
    
    this.data = new Map();
    this.metadata = new Map();
    this.currentSize = 0;
    
    // Start cleanup
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
  }
  
  /**
   * Store data in cache
   */
  set(key, value, ttl = null) {
    const serialized = JSON.stringify(value);
    const size = Buffer.byteLength(serialized, 'utf8');
    
    // Check size limit
    if (size > this.config.maxSize) {
      return false;
    }
    
    // Remove old entry if exists
    if (this.data.has(key)) {
      const oldSize = this.metadata.get(key).size;
      this.currentSize -= oldSize;
    }
    
    // Make space if needed
    while (this.currentSize + size > this.config.maxSize) {
      this.evictLRU();
    }
    
    // Store data
    this.data.set(key, serialized);
    this.metadata.set(key, {
      size,
      timestamp: Date.now(),
      ttl: ttl || this.config.ttl,
      accessCount: 0
    });
    
    this.currentSize += size;
    return true;
  }
  
  /**
   * Get data from cache
   */
  get(key) {
    if (!this.data.has(key)) {
      return null;
    }
    
    const metadata = this.metadata.get(key);
    
    // Check TTL
    if (Date.now() - metadata.timestamp > metadata.ttl) {
      this.delete(key);
      return null;
    }
    
    // Update access info
    metadata.accessCount++;
    metadata.lastAccess = Date.now();
    
    try {
      return JSON.parse(this.data.get(key));
    } catch (error) {
      this.delete(key);
      return null;
    }
  }
  
  /**
   * Delete from cache
   */
  delete(key) {
    if (!this.data.has(key)) {
      return false;
    }
    
    const metadata = this.metadata.get(key);
    this.currentSize -= metadata.size;
    
    this.data.delete(key);
    this.metadata.delete(key);
    
    return true;
  }
  
  /**
   * Check if key exists
   */
  has(key) {
    return this.data.has(key) && this.get(key) !== null;
  }
  
  /**
   * Evict least recently used entry
   */
  evictLRU() {
    let oldestKey = null;
    let oldestTime = Date.now();
    
    for (const [key, metadata] of this.metadata) {
      const accessTime = metadata.lastAccess || metadata.timestamp;
      if (accessTime < oldestTime) {
        oldestTime = accessTime;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.delete(oldestKey);
    }
  }
  
  /**
   * Clean up expired entries
   */
  cleanup() {
    const now = Date.now();
    const toDelete = [];
    
    for (const [key, metadata] of this.metadata) {
      if (now - metadata.timestamp > metadata.ttl) {
        toDelete.push(key);
      }
    }
    
    for (const key of toDelete) {
      this.delete(key);
    }
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    return {
      entries: this.data.size,
      currentSize: this.currentSize,
      maxSize: this.config.maxSize,
      utilization: (this.currentSize / this.config.maxSize) * 100
    };
  }
  
  /**
   * Clear cache
   */
  clear() {
    this.data.clear();
    this.metadata.clear();
    this.currentSize = 0;
  }
  
  /**
   * Shutdown cache
   */
  shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.clear();
  }
}

/**
 * File storage handler
 */
class FileStorage {
  constructor(config = {}) {
    this.config = {
      dataDir: config.dataDir || './data',
      compression: config.compression !== false,
      backup: config.backup !== false,
      backupRetention: config.backupRetention || 7 // days
    };
    
    this.dataDir = this.config.dataDir;
    this.locks = new Map();
  }
  
  /**
   * Initialize file storage
   */
  async initialize() {
    // Create data directory
    await this.ensureDirectory(this.dataDir);
    
    // Create subdirectories for different data types
    for (const type of Object.values(DATA_TYPES)) {
      await this.ensureDirectory(path.join(this.dataDir, type));
    }
  }
  
  /**
   * Ensure directory exists
   */
  async ensureDirectory(dir) {
    try {
      await fs.access(dir);
    } catch (error) {
      await fs.mkdir(dir, { recursive: true });
    }
  }
  
  /**
   * Store data to file
   */
  async store(type, key, data) {
    const filePath = this.getFilePath(type, key);
    const lockKey = filePath;
    
    // Acquire lock
    await this.acquireLock(lockKey);
    
    try {
      // Backup existing file
      if (this.config.backup) {
        await this.backupFile(filePath);
      }
      
      // Prepare data
      const payload = {
        key,
        data,
        timestamp: Date.now(),
        version: 1
      };
      
      let content = JSON.stringify(payload, null, 2);
      
      // Compress if enabled
      if (this.config.compression) {
        // In production, would use compression library
        content = content;
      }
      
      // Write to file
      await fs.writeFile(filePath, content, 'utf8');
      
      return true;
      
    } finally {
      this.releaseLock(lockKey);
    }
  }
  
  /**
   * Load data from file
   */
  async load(type, key) {
    const filePath = this.getFilePath(type, key);
    
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const payload = JSON.parse(content);
      
      return payload.data;
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null; // File not found
      }
      throw error;
    }
  }
  
  /**
   * Delete data file
   */
  async delete(type, key) {
    const filePath = this.getFilePath(type, key);
    
    try {
      await fs.unlink(filePath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false; // File not found
      }
      throw error;
    }
  }
  
  /**
   * List files of type
   */
  async list(type) {
    const dir = path.join(this.dataDir, type);
    
    try {
      const files = await fs.readdir(dir);
      return files
        .filter(file => file.endsWith('.json'))
        .map(file => file.replace('.json', ''));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
  
  /**
   * Get file path for key
   */
  getFilePath(type, key) {
    const safeKey = key.replace(/[^a-zA-Z0-9-_]/g, '_');
    return path.join(this.dataDir, type, `${safeKey}.json`);
  }
  
  /**
   * Backup file
   */
  async backupFile(filePath) {
    try {
      await fs.access(filePath);
      const backupPath = `${filePath}.backup.${Date.now()}`;
      await fs.copyFile(filePath, backupPath);
      
      // Clean old backups
      await this.cleanupBackups(path.dirname(filePath));
      
    } catch (error) {
      // Ignore if file doesn't exist
    }
  }
  
  /**
   * Clean up old backup files
   */
  async cleanupBackups(dir) {
    try {
      const files = await fs.readdir(dir);
      const backupFiles = files
        .filter(file => file.includes('.backup.'))
        .map(file => ({
          name: file,
          path: path.join(dir, file),
          timestamp: parseInt(file.split('.backup.')[1]) || 0
        }))
        .sort((a, b) => b.timestamp - a.timestamp);
      
      const cutoff = Date.now() - (this.config.backupRetention * 24 * 60 * 60 * 1000);
      
      for (const backup of backupFiles) {
        if (backup.timestamp < cutoff) {
          await fs.unlink(backup.path);
        }
      }
      
    } catch (error) {
      // Ignore cleanup errors
    }
  }
  
  /**
   * Acquire file lock
   */
  async acquireLock(key) {
    while (this.locks.has(key)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.locks.set(key, Date.now());
  }
  
  /**
   * Release file lock
   */
  releaseLock(key) {
    this.locks.delete(key);
  }
}

/**
 * Database abstraction
 */
class DatabaseStorage {
  constructor(config = {}) {
    this.config = {
      type: config.type || 'sqlite',
      connectionString: config.connectionString,
      poolSize: config.poolSize || 10,
      timeout: config.timeout || 30000,
      retryAttempts: config.retryAttempts || 3
    };
    
    this.connection = null;
    this.tables = new Map();
  }
  
  /**
   * Initialize database
   */
  async initialize() {
    // In production, would initialize actual database connection
    this.connection = {
      connected: true,
      type: this.config.type
    };
    
    // Create tables for different data types
    for (const type of Object.values(DATA_TYPES)) {
      await this.createTable(type);
    }
  }
  
  /**
   * Create table for data type
   */
  async createTable(type) {
    // In production, would execute actual SQL
    this.tables.set(type, {
      name: type,
      created: Date.now(),
      schema: {
        id: 'primary key',
        key: 'text',
        data: 'json',
        timestamp: 'datetime',
        version: 'integer'
      }
    });
  }
  
  /**
   * Store data in database
   */
  async store(type, key, data) {
    if (!this.connection) {
      throw new Error('Database not initialized');
    }
    
    // In production, would execute actual SQL INSERT/UPDATE
    return true;
  }
  
  /**
   * Load data from database
   */
  async load(type, key) {
    if (!this.connection) {
      throw new Error('Database not initialized');
    }
    
    // In production, would execute actual SQL SELECT
    return null;
  }
  
  /**
   * Delete data from database
   */
  async delete(type, key) {
    if (!this.connection) {
      throw new Error('Database not initialized');
    }
    
    // In production, would execute actual SQL DELETE
    return true;
  }
  
  /**
   * Query data with filters
   */
  async query(type, filters = {}) {
    if (!this.connection) {
      throw new Error('Database not initialized');
    }
    
    // In production, would execute actual SQL SELECT with WHERE
    return [];
  }
}

/**
 * Unified Storage Manager
 */
export class UnifiedStorageManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Storage configuration
      primaryStorage: config.primaryStorage || STORAGE_TYPES.FILE,
      enableCache: config.enableCache !== false,
      enableDatabase: config.enableDatabase || false,
      
      // Cache settings
      cacheSize: config.cacheSize || 100 * 1024 * 1024, // 100MB
      cacheTTL: config.cacheTTL || 3600000, // 1 hour
      
      // File storage settings
      dataDir: config.dataDir || './data',
      enableBackups: config.enableBackups !== false,
      
      // Database settings
      databaseType: config.databaseType || 'sqlite',
      connectionString: config.connectionString,
      
      // Performance settings
      batchSize: config.batchSize || 1000,
      flushInterval: config.flushInterval || 30000, // 30 seconds
      
      // Persistence settings
      persistenceEnabled: config.persistenceEnabled !== false,
      persistenceInterval: config.persistenceInterval || 300000, // 5 minutes
      
      ...config
    };
    
    // Storage components
    this.cache = new MemoryCache({
      maxSize: this.config.cacheSize,
      ttl: this.config.cacheTTL
    });
    
    this.fileStorage = new FileStorage({
      dataDir: this.config.dataDir,
      backup: this.config.enableBackups
    });
    
    this.database = this.config.enableDatabase 
      ? new DatabaseStorage({
          type: this.config.databaseType,
          connectionString: this.config.connectionString
        })
      : null;
    
    // State
    this.initialized = false;
    this.pendingWrites = new Map();
    
    // Statistics
    this.stats = {
      reads: 0,
      writes: 0,
      cacheHits: 0,
      cacheMisses: 0,
      errors: 0
    };
    
    this.logger = logger;
    
    // Start background tasks
    this.startBackgroundTasks();
  }
  
  /**
   * Initialize storage manager
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      // Initialize file storage
      await this.fileStorage.initialize();
      
      // Initialize database if enabled
      if (this.database) {
        await this.database.initialize();
      }
      
      this.initialized = true;
      
      this.logger.info('Unified storage manager initialized', {
        primaryStorage: this.config.primaryStorage,
        cacheEnabled: this.config.enableCache,
        databaseEnabled: this.config.enableDatabase
      });
      
    } catch (error) {
      this.logger.error('Storage initialization failed', { error: error.message });
      throw error;
    }
  }
  
  /**
   * Store data
   */
  async store(type, key, data, options = {}) {
    if (!this.initialized) {
      throw new Error('Storage manager not initialized');
    }
    
    this.stats.writes++;
    
    try {
      // Store in cache
      if (this.config.enableCache && !options.skipCache) {
        this.cache.set(`${type}:${key}`, data, options.ttl);
      }
      
      // Store in primary storage
      if (this.config.primaryStorage === STORAGE_TYPES.FILE) {
        await this.fileStorage.store(type, key, data);
      } else if (this.config.primaryStorage === STORAGE_TYPES.DATABASE && this.database) {
        await this.database.store(type, key, data);
      }
      
      // Store in secondary storage if different
      if (this.database && this.config.primaryStorage !== STORAGE_TYPES.DATABASE) {
        // Queue for background write
        this.queueWrite(type, key, data);
      }
      
      this.emit('stored', { type, key, size: JSON.stringify(data).length });
      
      return true;
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Store operation failed', {
        type,
        key,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Load data
   */
  async load(type, key, options = {}) {
    if (!this.initialized) {
      throw new Error('Storage manager not initialized');
    }
    
    this.stats.reads++;
    
    try {
      // Try cache first
      if (this.config.enableCache && !options.skipCache) {
        const cached = this.cache.get(`${type}:${key}`);
        if (cached !== null) {
          this.stats.cacheHits++;
          return cached;
        }
        this.stats.cacheMisses++;
      }
      
      let data = null;
      
      // Try primary storage
      if (this.config.primaryStorage === STORAGE_TYPES.FILE) {
        data = await this.fileStorage.load(type, key);
      } else if (this.config.primaryStorage === STORAGE_TYPES.DATABASE && this.database) {
        data = await this.database.load(type, key);
      }
      
      // Try secondary storage if not found
      if (data === null && this.database && this.config.primaryStorage !== STORAGE_TYPES.DATABASE) {
        data = await this.database.load(type, key);
      }
      
      // Cache if found
      if (data !== null && this.config.enableCache && !options.skipCache) {
        this.cache.set(`${type}:${key}`, data, options.ttl);
      }
      
      return data;
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Load operation failed', {
        type,
        key,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Delete data
   */
  async delete(type, key) {
    if (!this.initialized) {
      throw new Error('Storage manager not initialized');
    }
    
    try {
      // Remove from cache
      if (this.config.enableCache) {
        this.cache.delete(`${type}:${key}`);
      }
      
      // Remove from primary storage
      if (this.config.primaryStorage === STORAGE_TYPES.FILE) {
        await this.fileStorage.delete(type, key);
      } else if (this.config.primaryStorage === STORAGE_TYPES.DATABASE && this.database) {
        await this.database.delete(type, key);
      }
      
      // Remove from secondary storage
      if (this.database && this.config.primaryStorage !== STORAGE_TYPES.DATABASE) {
        await this.database.delete(type, key);
      }
      
      this.emit('deleted', { type, key });
      
      return true;
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Delete operation failed', {
        type,
        key,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * List items of type
   */
  async list(type, options = {}) {
    if (!this.initialized) {
      throw new Error('Storage manager not initialized');
    }
    
    try {
      if (this.config.primaryStorage === STORAGE_TYPES.FILE) {
        return await this.fileStorage.list(type);
      } else if (this.config.primaryStorage === STORAGE_TYPES.DATABASE && this.database) {
        return await this.database.query(type, options.filters);
      }
      
      return [];
      
    } catch (error) {
      this.stats.errors++;
      this.logger.error('List operation failed', {
        type,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Queue background write
   */
  queueWrite(type, key, data) {
    const writeKey = `${type}:${key}`;
    this.pendingWrites.set(writeKey, {
      type,
      key,
      data,
      timestamp: Date.now()
    });
  }
  
  /**
   * Process pending writes
   */
  async processPendingWrites() {
    if (this.pendingWrites.size === 0) return;
    
    const writes = Array.from(this.pendingWrites.values());
    this.pendingWrites.clear();
    
    for (const write of writes) {
      try {
        if (this.database) {
          await this.database.store(write.type, write.key, write.data);
        }
      } catch (error) {
        this.logger.error('Background write failed', {
          type: write.type,
          key: write.key,
          error: error.message
        });
      }
    }
  }
  
  /**
   * Start background tasks
   */
  startBackgroundTasks() {
    // Periodic flush of pending writes
    if (this.config.flushInterval > 0) {
      this.flushTimer = setInterval(() => {
        this.processPendingWrites();
      }, this.config.flushInterval);
    }
    
    // Periodic persistence
    if (this.config.persistenceEnabled && this.config.persistenceInterval > 0) {
      this.persistenceTimer = setInterval(() => {
        this.persistCache();
      }, this.config.persistenceInterval);
    }
  }
  
  /**
   * Persist cache to storage
   */
  async persistCache() {
    try {
      const cacheStats = this.cache.getStats();
      this.logger.debug('Cache persistence', cacheStats);
      
      // In production, might persist hot cache entries to storage
      
    } catch (error) {
      this.logger.error('Cache persistence failed', { error: error.message });
    }
  }
  
  /**
   * Get storage statistics
   */
  getStats() {
    return {
      ...this.stats,
      cache: this.cache.getStats(),
      pendingWrites: this.pendingWrites.size,
      initialized: this.initialized
    };
  }
  
  /**
   * Clear all data
   */
  async clear() {
    if (this.config.enableCache) {
      this.cache.clear();
    }
    
    this.pendingWrites.clear();
    
    this.emit('cleared');
  }
  
  /**
   * Shutdown storage manager
   */
  async shutdown() {
    // Stop timers
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    
    if (this.persistenceTimer) {
      clearInterval(this.persistenceTimer);
    }
    
    // Process pending writes
    await this.processPendingWrites();
    
    // Shutdown components
    this.cache.shutdown();
    
    this.initialized = false;
    this.logger.info('Storage manager shutdown');
  }
}

// Export constants
export {
  STORAGE_TYPES,
  DATA_TYPES
};

export default UnifiedStorageManager;