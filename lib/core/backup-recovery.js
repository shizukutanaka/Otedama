/**
 * Backup and Recovery System - Otedama
 * Automated state persistence and disaster recovery
 * 
 * Design Principles:
 * - Carmack: Zero-copy snapshots, lock-free operations
 * - Martin: Clean separation of backup strategies
 * - Pike: Simple interface for complex recovery scenarios
 */

import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { promisify } from 'util';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createStructuredLogger } from './structured-logger.js';

const logger = createStructuredLogger('BackupRecovery');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Backup strategies
 */
const BackupStrategy = {
  FULL: 'full',           // Complete state backup
  INCREMENTAL: 'incremental', // Changes since last backup
  DIFFERENTIAL: 'differential', // Changes since last full backup
  CONTINUOUS: 'continuous'     // Real-time replication
};

/**
 * Recovery modes
 */
const RecoveryMode = {
  LATEST: 'latest',       // Restore from most recent backup
  POINT_IN_TIME: 'point_in_time', // Restore to specific time
  SELECTIVE: 'selective'  // Restore specific components
};

/**
 * Backup and Recovery Manager
 */
export class BackupRecovery extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Backup configuration
      backupDir: config.backupDir || './backups',
      strategy: config.strategy || BackupStrategy.INCREMENTAL,
      interval: config.interval || 3600000, // 1 hour
      retention: config.retention || 7 * 24 * 3600000, // 7 days
      compression: config.compression !== false,
      encryption: config.encryption || false,
      encryptionKey: config.encryptionKey || null,
      
      // Performance
      maxConcurrent: config.maxConcurrent || 3,
      chunkSize: config.chunkSize || 64 * 1024 * 1024, // 64MB chunks
      
      // Recovery
      verifyOnBackup: config.verifyOnBackup !== false,
      verifyOnRestore: config.verifyOnRestore !== false,
      
      ...config
    };
    
    // State
    this.backupHistory = [];
    this.activeBackups = new Map();
    this.lastFullBackup = null;
    this.lastBackup = null;
    this.isRecovering = false;
    
    // Backup sources registry
    this.sources = new Map();
    
    // Timers
    this.backupTimer = null;
    
    // Metrics
    this.metrics = {
      backupsCompleted: 0,
      backupsFailed: 0,
      totalBackupSize: 0,
      totalBackupTime: 0,
      recoveriesCompleted: 0,
      recoveriesFailed: 0
    };
    
    this.logger = logger;
  }
  
  /**
   * Start automatic backups
   */
  async start() {
    // Ensure backup directory exists
    await this.ensureBackupDirectory();
    
    // Load backup history
    await this.loadBackupHistory();
    
    // Start backup timer
    if (this.config.interval > 0) {
      this.backupTimer = setInterval(() => {
        this.performBackup().catch(error => {
          this.logger.error('Automatic backup failed:', error);
        });
      }, this.config.interval);
    }
    
    // Perform initial backup
    await this.performBackup();
    
    this.logger.info('Backup system started', {
      strategy: this.config.strategy,
      interval: this.config.interval
    });
  }
  
  /**
   * Stop automatic backups
   */
  stop() {
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
    
    this.logger.info('Backup system stopped');
  }
  
  /**
   * Register backup source
   */
  registerSource(name, source) {
    if (typeof source.getState !== 'function') {
      throw new Error('Source must implement getState() method');
    }
    
    if (typeof source.setState !== 'function') {
      throw new Error('Source must implement setState() method');
    }
    
    this.sources.set(name, source);
    this.logger.info(`Registered backup source: ${name}`);
  }
  
  /**
   * Perform backup
   */
  async performBackup(options = {}) {
    const backupId = this.generateBackupId();
    const startTime = Date.now();
    
    try {
      this.logger.info('Starting backup', { id: backupId, strategy: this.config.strategy });
      
      // Determine backup type
      const strategy = options.strategy || this.config.strategy;
      let backupData;
      
      switch (strategy) {
        case BackupStrategy.FULL:
          backupData = await this.createFullBackup(backupId);
          break;
          
        case BackupStrategy.INCREMENTAL:
          backupData = await this.createIncrementalBackup(backupId);
          break;
          
        case BackupStrategy.DIFFERENTIAL:
          backupData = await this.createDifferentialBackup(backupId);
          break;
          
        default:
          backupData = await this.createFullBackup(backupId);
      }
      
      // Save backup metadata
      const metadata = {
        id: backupId,
        type: strategy,
        timestamp: Date.now(),
        sources: Array.from(this.sources.keys()),
        size: backupData.size,
        checksum: backupData.checksum,
        duration: Date.now() - startTime,
        compressed: this.config.compression,
        encrypted: this.config.encryption,
        parentId: backupData.parentId || null
      };
      
      // Update history
      this.backupHistory.push(metadata);
      this.lastBackup = metadata;
      
      if (strategy === BackupStrategy.FULL) {
        this.lastFullBackup = metadata;
      }
      
      // Save history
      await this.saveBackupHistory();
      
      // Clean old backups
      await this.cleanOldBackups();
      
      // Update metrics
      this.metrics.backupsCompleted++;
      this.metrics.totalBackupSize += metadata.size;
      this.metrics.totalBackupTime += metadata.duration;
      
      this.logger.info('Backup completed', {
        id: backupId,
        duration: metadata.duration,
        size: metadata.size
      });
      
      this.emit('backup:completed', metadata);
      
      return metadata;
      
    } catch (error) {
      this.metrics.backupsFailed++;
      this.logger.error('Backup failed:', error);
      this.emit('backup:failed', { id: backupId, error });
      throw error;
    }
  }
  
  /**
   * Create full backup
   */
  async createFullBackup(backupId) {
    const states = new Map();
    
    // Collect state from all sources
    for (const [name, source] of this.sources) {
      try {
        const state = await source.getState();
        states.set(name, state);
      } catch (error) {
        this.logger.error(`Failed to get state from ${name}:`, error);
        throw error;
      }
    }
    
    // Serialize state
    const stateData = this.serializeState(states);
    
    // Compress if enabled
    let data = stateData;
    if (this.config.compression) {
      data = await gzip(data);
    }
    
    // Encrypt if enabled
    if (this.config.encryption) {
      data = this.encrypt(data);
    }
    
    // Calculate checksum
    const checksum = this.calculateChecksum(data);
    
    // Save to file
    const filename = `backup_${backupId}_full.dat`;
    const filepath = path.join(this.config.backupDir, filename);
    
    await fs.writeFile(filepath, data);
    
    // Verify if enabled
    if (this.config.verifyOnBackup) {
      await this.verifyBackup(filepath, checksum);
    }
    
    return {
      filename,
      size: data.length,
      checksum,
      states: states.size
    };
  }
  
  /**
   * Create incremental backup
   */
  async createIncrementalBackup(backupId) {
    // Need a previous backup for incremental
    if (!this.lastBackup) {
      return await this.createFullBackup(backupId);
    }
    
    const states = new Map();
    const changes = new Map();
    
    // Collect changes from all sources
    for (const [name, source] of this.sources) {
      try {
        const currentState = await source.getState();
        
        // Get previous state
        const previousState = await this.getSourceState(this.lastBackup.id, name);
        
        // Calculate diff
        const diff = this.calculateDiff(previousState, currentState);
        
        if (diff && diff.hasChanges) {
          changes.set(name, diff);
        }
        
        states.set(name, currentState);
      } catch (error) {
        this.logger.error(`Failed to get state from ${name}:`, error);
        throw error;
      }
    }
    
    // If no changes, skip backup
    if (changes.size === 0) {
      this.logger.info('No changes detected, skipping incremental backup');
      return null;
    }
    
    // Serialize changes
    const changeData = this.serializeState(changes);
    
    // Compress if enabled
    let data = changeData;
    if (this.config.compression) {
      data = await gzip(data);
    }
    
    // Encrypt if enabled
    if (this.config.encryption) {
      data = this.encrypt(data);
    }
    
    // Calculate checksum
    const checksum = this.calculateChecksum(data);
    
    // Save to file
    const filename = `backup_${backupId}_incr.dat`;
    const filepath = path.join(this.config.backupDir, filename);
    
    await fs.writeFile(filepath, data);
    
    return {
      filename,
      size: data.length,
      checksum,
      parentId: this.lastBackup.id,
      changes: changes.size
    };
  }
  
  /**
   * Create differential backup
   */
  async createDifferentialBackup(backupId) {
    // Need a full backup for differential
    if (!this.lastFullBackup) {
      return await this.createFullBackup(backupId);
    }
    
    const states = new Map();
    const changes = new Map();
    
    // Collect changes since last full backup
    for (const [name, source] of this.sources) {
      try {
        const currentState = await source.getState();
        
        // Get state from last full backup
        const fullBackupState = await this.getSourceState(this.lastFullBackup.id, name);
        
        // Calculate diff
        const diff = this.calculateDiff(fullBackupState, currentState);
        
        if (diff && diff.hasChanges) {
          changes.set(name, diff);
        }
        
        states.set(name, currentState);
      } catch (error) {
        this.logger.error(`Failed to get state from ${name}:`, error);
        throw error;
      }
    }
    
    // If no changes, skip backup
    if (changes.size === 0) {
      this.logger.info('No changes detected, skipping differential backup');
      return null;
    }
    
    // Serialize changes
    const changeData = this.serializeState(changes);
    
    // Compress and save
    let data = changeData;
    if (this.config.compression) {
      data = await gzip(data);
    }
    
    if (this.config.encryption) {
      data = this.encrypt(data);
    }
    
    const checksum = this.calculateChecksum(data);
    
    const filename = `backup_${backupId}_diff.dat`;
    const filepath = path.join(this.config.backupDir, filename);
    
    await fs.writeFile(filepath, data);
    
    return {
      filename,
      size: data.length,
      checksum,
      parentId: this.lastFullBackup.id,
      changes: changes.size
    };
  }
  
  /**
   * Restore from backup
   */
  async restore(options = {}) {
    if (this.isRecovering) {
      throw new Error('Recovery already in progress');
    }
    
    this.isRecovering = true;
    const startTime = Date.now();
    
    try {
      this.logger.info('Starting recovery', options);
      
      const mode = options.mode || RecoveryMode.LATEST;
      let targetBackup;
      
      // Find target backup
      switch (mode) {
        case RecoveryMode.LATEST:
          targetBackup = this.findLatestBackup();
          break;
          
        case RecoveryMode.POINT_IN_TIME:
          targetBackup = this.findBackupByTime(options.timestamp);
          break;
          
        case RecoveryMode.SELECTIVE:
          targetBackup = this.findBackupById(options.backupId);
          break;
          
        default:
          throw new Error(`Unknown recovery mode: ${mode}`);
      }
      
      if (!targetBackup) {
        throw new Error('No suitable backup found');
      }
      
      // Build restore chain
      const restoreChain = await this.buildRestoreChain(targetBackup);
      
      // Restore state
      const restoredState = await this.restoreFromChain(restoreChain, options);
      
      // Apply state to sources
      for (const [name, state] of restoredState) {
        if (options.sources && !options.sources.includes(name)) {
          continue; // Skip if selective restore
        }
        
        const source = this.sources.get(name);
        if (source) {
          await source.setState(state);
          this.logger.info(`Restored state for ${name}`);
        }
      }
      
      // Update metrics
      this.metrics.recoveriesCompleted++;
      
      const duration = Date.now() - startTime;
      this.logger.info('Recovery completed', {
        backup: targetBackup.id,
        duration,
        sources: restoredState.size
      });
      
      this.emit('recovery:completed', {
        backup: targetBackup,
        duration,
        sources: Array.from(restoredState.keys())
      });
      
      return {
        backup: targetBackup,
        duration,
        sources: restoredState.size
      };
      
    } catch (error) {
      this.metrics.recoveriesFailed++;
      this.logger.error('Recovery failed:', error);
      this.emit('recovery:failed', { error });
      throw error;
      
    } finally {
      this.isRecovering = false;
    }
  }
  
  /**
   * Build restore chain
   */
  async buildRestoreChain(targetBackup) {
    const chain = [];
    let current = targetBackup;
    
    while (current) {
      chain.unshift(current);
      
      if (current.type === BackupStrategy.FULL) {
        break;
      }
      
      // Find parent backup
      if (current.parentId) {
        current = this.backupHistory.find(b => b.id === current.parentId);
      } else {
        break;
      }
    }
    
    return chain;
  }
  
  /**
   * Restore from backup chain
   */
  async restoreFromChain(chain, options) {
    let restoredState = new Map();
    
    for (const backup of chain) {
      const backupData = await this.loadBackup(backup);
      
      if (backup.type === BackupStrategy.FULL) {
        // Full backup - replace entire state
        restoredState = backupData;
      } else {
        // Incremental/differential - apply changes
        for (const [name, changes] of backupData) {
          const currentState = restoredState.get(name) || {};
          const newState = this.applyDiff(currentState, changes);
          restoredState.set(name, newState);
        }
      }
    }
    
    return restoredState;
  }
  
  /**
   * Load backup data
   */
  async loadBackup(backup) {
    const filepath = path.join(this.config.backupDir, backup.filename);
    
    // Read file
    let data = await fs.readFile(filepath);
    
    // Verify checksum if enabled
    if (this.config.verifyOnRestore) {
      const checksum = this.calculateChecksum(data);
      if (checksum !== backup.checksum) {
        throw new Error(`Backup checksum mismatch: ${backup.id}`);
      }
    }
    
    // Decrypt if needed
    if (backup.encrypted) {
      data = this.decrypt(data);
    }
    
    // Decompress if needed
    if (backup.compressed) {
      data = await gunzip(data);
    }
    
    // Deserialize
    return this.deserializeState(data);
  }
  
  /**
   * Get source state from backup
   */
  async getSourceState(backupId, sourceName) {
    const backup = this.backupHistory.find(b => b.id === backupId);
    if (!backup) return null;
    
    const backupData = await this.loadBackup(backup);
    return backupData.get(sourceName);
  }
  
  /**
   * Calculate diff between states
   */
  calculateDiff(oldState, newState) {
    const diff = {
      hasChanges: false,
      added: {},
      modified: {},
      deleted: []
    };
    
    // Check for additions and modifications
    for (const [key, value] of Object.entries(newState)) {
      if (!(key in oldState)) {
        diff.added[key] = value;
        diff.hasChanges = true;
      } else if (JSON.stringify(oldState[key]) !== JSON.stringify(value)) {
        diff.modified[key] = value;
        diff.hasChanges = true;
      }
    }
    
    // Check for deletions
    for (const key in oldState) {
      if (!(key in newState)) {
        diff.deleted.push(key);
        diff.hasChanges = true;
      }
    }
    
    return diff;
  }
  
  /**
   * Apply diff to state
   */
  applyDiff(state, diff) {
    const newState = { ...state };
    
    // Apply additions
    for (const [key, value] of Object.entries(diff.added || {})) {
      newState[key] = value;
    }
    
    // Apply modifications
    for (const [key, value] of Object.entries(diff.modified || {})) {
      newState[key] = value;
    }
    
    // Apply deletions
    for (const key of (diff.deleted || [])) {
      delete newState[key];
    }
    
    return newState;
  }
  
  /**
   * Serialize state data
   */
  serializeState(states) {
    const data = {};
    
    for (const [name, state] of states) {
      data[name] = state;
    }
    
    return Buffer.from(JSON.stringify(data));
  }
  
  /**
   * Deserialize state data
   */
  deserializeState(data) {
    const parsed = JSON.parse(data.toString());
    const states = new Map();
    
    for (const [name, state] of Object.entries(parsed)) {
      states.set(name, state);
    }
    
    return states;
  }
  
  /**
   * Calculate checksum
   */
  calculateChecksum(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }
  
  /**
   * Encrypt data
   */
  encrypt(data) {
    if (!this.config.encryptionKey) {
      throw new Error('Encryption key not configured');
    }
    
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.config.encryptionKey, iv);
    
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    
    // Prepend IV to encrypted data
    return Buffer.concat([iv, encrypted]);
  }
  
  /**
   * Decrypt data
   */
  decrypt(data) {
    if (!this.config.encryptionKey) {
      throw new Error('Encryption key not configured');
    }
    
    // Extract IV from beginning
    const iv = data.slice(0, 16);
    const encrypted = data.slice(16);
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.config.encryptionKey, iv);
    
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }
  
  /**
   * Verify backup integrity
   */
  async verifyBackup(filepath, expectedChecksum) {
    const data = await fs.readFile(filepath);
    const actualChecksum = this.calculateChecksum(data);
    
    if (actualChecksum !== expectedChecksum) {
      throw new Error(`Backup verification failed: ${filepath}`);
    }
  }
  
  /**
   * Clean old backups
   */
  async cleanOldBackups() {
    const now = Date.now();
    const cutoff = now - this.config.retention;
    
    const toDelete = this.backupHistory.filter(backup => {
      // Keep all full backups
      if (backup.type === BackupStrategy.FULL) {
        return false;
      }
      
      return backup.timestamp < cutoff;
    });
    
    for (const backup of toDelete) {
      try {
        const filepath = path.join(this.config.backupDir, backup.filename);
        await fs.unlink(filepath);
        
        // Remove from history
        const index = this.backupHistory.indexOf(backup);
        if (index > -1) {
          this.backupHistory.splice(index, 1);
        }
        
        this.logger.info(`Deleted old backup: ${backup.id}`);
      } catch (error) {
        this.logger.error(`Failed to delete backup ${backup.id}:`, error);
      }
    }
    
    if (toDelete.length > 0) {
      await this.saveBackupHistory();
    }
  }
  
  /**
   * Find latest backup
   */
  findLatestBackup() {
    if (this.backupHistory.length === 0) return null;
    
    return this.backupHistory.reduce((latest, backup) => {
      return backup.timestamp > latest.timestamp ? backup : latest;
    });
  }
  
  /**
   * Find backup by time
   */
  findBackupByTime(timestamp) {
    // Find closest backup before or at timestamp
    return this.backupHistory
      .filter(b => b.timestamp <= timestamp)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
  }
  
  /**
   * Find backup by ID
   */
  findBackupById(id) {
    return this.backupHistory.find(b => b.id === id);
  }
  
  /**
   * Generate backup ID
   */
  generateBackupId() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `${timestamp}_${random}`;
  }
  
  /**
   * Ensure backup directory exists
   */
  async ensureBackupDirectory() {
    try {
      await fs.mkdir(this.config.backupDir, { recursive: true });
    } catch (error) {
      this.logger.error('Failed to create backup directory:', error);
      throw error;
    }
  }
  
  /**
   * Load backup history
   */
  async loadBackupHistory() {
    const historyFile = path.join(this.config.backupDir, 'backup_history.json');
    
    try {
      const data = await fs.readFile(historyFile, 'utf8');
      this.backupHistory = JSON.parse(data);
      
      // Find last backups
      this.lastBackup = this.findLatestBackup();
      this.lastFullBackup = this.backupHistory
        .filter(b => b.type === BackupStrategy.FULL)
        .sort((a, b) => b.timestamp - a.timestamp)[0];
        
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.error('Failed to load backup history:', error);
      }
    }
  }
  
  /**
   * Save backup history
   */
  async saveBackupHistory() {
    const historyFile = path.join(this.config.backupDir, 'backup_history.json');
    
    try {
      await fs.writeFile(
        historyFile,
        JSON.stringify(this.backupHistory, null, 2),
        'utf8'
      );
    } catch (error) {
      this.logger.error('Failed to save backup history:', error);
    }
  }
  
  /**
   * Get backup statistics
   */
  getStats() {
    const avgBackupTime = this.metrics.backupsCompleted > 0
      ? this.metrics.totalBackupTime / this.metrics.backupsCompleted
      : 0;
      
    const avgBackupSize = this.metrics.backupsCompleted > 0
      ? this.metrics.totalBackupSize / this.metrics.backupsCompleted
      : 0;
    
    return {
      ...this.metrics,
      avgBackupTime,
      avgBackupSize,
      totalBackups: this.backupHistory.length,
      lastBackup: this.lastBackup ? new Date(this.lastBackup.timestamp).toISOString() : null,
      nextBackup: this.backupTimer ? new Date(Date.now() + this.config.interval).toISOString() : null
    };
  }
  
  /**
   * List available backups
   */
  listBackups(options = {}) {
    let backups = [...this.backupHistory];
    
    // Filter by type
    if (options.type) {
      backups = backups.filter(b => b.type === options.type);
    }
    
    // Filter by date range
    if (options.startDate) {
      backups = backups.filter(b => b.timestamp >= options.startDate);
    }
    
    if (options.endDate) {
      backups = backups.filter(b => b.timestamp <= options.endDate);
    }
    
    // Sort
    backups.sort((a, b) => b.timestamp - a.timestamp);
    
    // Limit
    if (options.limit) {
      backups = backups.slice(0, options.limit);
    }
    
    return backups;
  }
}

export default BackupRecovery;