/**
 * Storage Manager - Otedama
 * Central management for all storage components
 */

import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';
import { Database } from './database.js';
import { Cache } from './cache.js';
import { FileStore } from './file-store.js';
import { ShareStore } from './share-store.js';
import { BlockStore } from './block-store.js';

const logger = createLogger('StorageManager');

export class StorageManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      dataDir: options.dataDir || './data',
      dbFile: options.dbFile || 'otedama.db',
      cacheSize: options.cacheSize || 100 * 1024 * 1024, // 100MB
      enablePersistence: options.enablePersistence !== false,
      persistInterval: options.persistInterval || 300000, // 5 minutes
      cleanupInterval: options.cleanupInterval || 3600000 // 1 hour
    };
    
    // Storage components
    this.db = null;
    this.cache = null;
    this.fileStore = null;
    this.shareStore = null;
    this.blockStore = null;
    
    // Timers
    this.persistTimer = null;
    this.cleanupTimer = null;
    
    this.isInitialized = false;
  }
  
  async initialize() {
    if (this.isInitialized) return;
    
    logger.info('Initializing storage manager');
    
    try {
      // Initialize database
      this.db = new Database({
        filename: `${this.config.dataDir}/${this.config.dbFile}`
      });
      await this.db.open();
      await this.db.createTables();
      
      // Initialize cache
      this.cache = new Cache({
        maxSize: this.config.cacheSize
      });
      
      // Initialize file store
      this.fileStore = new FileStore({
        baseDir: this.config.dataDir
      });
      
      // Initialize specialized stores
      this.shareStore = new ShareStore();
      this.blockStore = new BlockStore();
      
      // Load persisted data
      if (this.config.enablePersistence) {
        await this.loadPersistedData();
      }
      
      // Setup event handlers
      this.setupEventHandlers();
      
      // Start timers
      this.startTimers();
      
      this.isInitialized = true;
      logger.info('Storage manager initialized');
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Failed to initialize storage:', error);
      throw error;
    }
  }
  
  async shutdown() {
    if (!this.isInitialized) return;
    
    logger.info('Shutting down storage manager');
    
    // Stop timers
    this.stopTimers();
    
    // Persist data
    if (this.config.enablePersistence) {
      await this.persistData();
    }
    
    // Close database
    if (this.db) {
      await this.db.close();
    }
    
    // Clear stores
    this.cache.clear();
    this.shareStore.clear();
    this.blockStore.clear();
    
    this.isInitialized = false;
    logger.info('Storage manager shut down');
    this.emit('shutdown');
  }
  
  setupEventHandlers() {
    // Share store events
    this.shareStore.on('block:found', async (share) => {
      // Add to block store
      const block = {
        height: share.blockHeight,
        hash: share.blockHash,
        finderId: share.workerId,
        reward: share.blockReward,
        confirmations: 0,
        status: 'pending',
        timestamp: share.timestamp
      };
      
      this.blockStore.add(block);
      
      // Save to database
      await this.db.addBlock(block);
      
      this.emit('block:found', block);
    });
    
    // Block store events
    this.blockStore.on('block:confirmed', async (block) => {
      // Update database
      await this.db.run(
        'UPDATE blocks SET confirmations = ?, status = ? WHERE hash = ?',
        [block.confirmations, block.status, block.hash]
      );
      
      this.emit('block:confirmed', block);
    });
  }
  
  startTimers() {
    // Persistence timer
    if (this.config.enablePersistence) {
      this.persistTimer = setInterval(() => {
        this.persistData().catch(error => {
          logger.error('Persistence error:', error);
        });
      }, this.config.persistInterval);
    }
    
    // Cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch(error => {
        logger.error('Cleanup error:', error);
      });
    }, this.config.cleanupInterval);
  }
  
  stopTimers() {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
  
  async persistData() {
    logger.debug('Persisting data to disk');
    
    try {
      // Persist block store
      const blockData = this.blockStore.export();
      await this.fileStore.write('blocks.json', blockData);
      
      // Persist cache stats
      const cacheStats = this.cache.getStats();
      await this.fileStore.write('cache-stats.json', cacheStats);
      
      logger.debug('Data persisted successfully');
      
    } catch (error) {
      logger.error('Failed to persist data:', error);
      throw error;
    }
  }
  
  async loadPersistedData() {
    logger.debug('Loading persisted data');
    
    try {
      // Load blocks
      const blockData = await this.fileStore.read('blocks.json');
      if (blockData) {
        this.blockStore.import(blockData);
        logger.debug(`Loaded ${blockData.blocks?.length || 0} blocks`);
      }
      
    } catch (error) {
      logger.warn('Failed to load persisted data:', error);
      // Continue anyway - not critical
    }
  }
  
  async cleanup() {
    logger.debug('Running storage cleanup');
    
    // Cleanup cache
    const cacheCleanup = this.cache.cleanup();
    
    // Cleanup share store
    this.shareStore.cleanup();
    
    // Cleanup database
    await this.db.cleanup(7); // Keep 7 days
    
    logger.debug(`Cleanup complete - cache: ${cacheCleanup} items`);
  }
  
  // Public API
  
  async addShare(share) {
    // Add to memory store
    this.shareStore.add(share);
    
    // Add to database
    await this.db.addShare(share);
    
    // Cache worker stats
    const stats = this.shareStore.getWorkerStats(share.workerId);
    this.cache.set(`worker:stats:${share.workerId}`, stats, 60000); // 1 minute
  }
  
  async getWorkerStats(workerId) {
    // Check cache first
    const cached = this.cache.get(`worker:stats:${workerId}`);
    if (cached) return cached;
    
    // Get from share store
    const stats = this.shareStore.getWorkerStats(workerId);
    
    // Get additional data from database
    const miner = await this.db.getMiner(workerId);
    if (miner) {
      stats.balance = miner.balance;
      stats.totalPaid = miner.total_paid;
    }
    
    // Cache result
    this.cache.set(`worker:stats:${workerId}`, stats, 60000);
    
    return stats;
  }
  
  async getPoolStats() {
    // Check cache first
    const cached = this.cache.get('pool:stats');
    if (cached) return cached;
    
    // Combine stats from all sources
    const shareStats = this.shareStore.getPoolStats();
    const blockStats = this.blockStore.getStats();
    const dbStats = await this.db.getPoolStats();
    const cacheStats = this.cache.getStats();
    
    const stats = {
      ...shareStats,
      blocks: blockStats,
      database: dbStats,
      cache: cacheStats
    };
    
    // Cache result
    this.cache.set('pool:stats', stats, 10000); // 10 seconds
    
    return stats;
  }
  
  // Getters for direct access
  
  getDatabase() {
    return this.db;
  }
  
  getCache() {
    return this.cache;
  }
  
  getFileStore() {
    return this.fileStore;
  }
  
  getShareStore() {
    return this.shareStore;
  }
  
  getBlockStore() {
    return this.blockStore;
  }
}

export default StorageManager;
