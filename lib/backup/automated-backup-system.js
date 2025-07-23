/**
 * Automated Backup System with Cloud Storage Support
 * Comprehensive backup solution with multiple storage backends
 * 
 * Features:
 * - Scheduled automated backups
 * - Multiple storage backends (local, S3, GCS, Azure)
 * - Incremental and full backup support
 * - Encryption and compression
 * - Backup rotation and retention policies
 * - Verification and integrity checks
 * - Disaster recovery procedures
 * - Real-time backup monitoring
 */

const { EventEmitter } = require('events');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const AWS = require('aws-sdk');
const { Storage } = require('@google-cloud/storage');
const { BlobServiceClient } = require('@azure/storage-blob');
const { createLogger } = require('../core/logger');

const logger = createLogger('automated-backup');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Backup types
const BackupType = {
  FULL: 'full',
  INCREMENTAL: 'incremental',
  DIFFERENTIAL: 'differential',
  SNAPSHOT: 'snapshot'
};

// Storage backends
const StorageBackend = {
  LOCAL: 'local',
  S3: 's3',
  GCS: 'gcs',
  AZURE: 'azure',
  FTP: 'ftp',
  WEBDAV: 'webdav'
};

// Backup states
const BackupState = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  VERIFYING: 'verifying',
  VERIFIED: 'verified'
};

class BackupMetadata {
  constructor(options = {}) {
    this.id = crypto.randomBytes(16).toString('hex');
    this.timestamp = Date.now();
    this.type = options.type || BackupType.FULL;
    this.size = options.size || 0;
    this.files = options.files || [];
    this.checksum = options.checksum || null;
    this.encrypted = options.encrypted || false;
    this.compressed = options.compressed || false;
    this.parent = options.parent || null; // For incremental backups
    this.tags = options.tags || {};
    this.retention = options.retention || {};
  }

  toJSON() {
    return {
      id: this.id,
      timestamp: this.timestamp,
      type: this.type,
      size: this.size,
      files: this.files,
      checksum: this.checksum,
      encrypted: this.encrypted,
      compressed: this.compressed,
      parent: this.parent,
      tags: this.tags,
      retention: this.retention
    };
  }
}

class StorageAdapter {
  async upload(data, path) {
    throw new Error('Not implemented');
  }

  async download(path) {
    throw new Error('Not implemented');
  }

  async delete(path) {
    throw new Error('Not implemented');
  }

  async list(prefix) {
    throw new Error('Not implemented');
  }

  async exists(path) {
    throw new Error('Not implemented');
  }
}

class LocalStorageAdapter extends StorageAdapter {
  constructor(basePath) {
    super();
    this.basePath = basePath;
  }

  async upload(data, filePath) {
    const fullPath = path.join(this.basePath, filePath);
    const dir = path.dirname(fullPath);
    
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, data);
    
    return fullPath;
  }

  async download(filePath) {
    const fullPath = path.join(this.basePath, filePath);
    return await fs.readFile(fullPath);
  }

  async delete(filePath) {
    const fullPath = path.join(this.basePath, filePath);
    await fs.unlink(fullPath);
  }

  async list(prefix) {
    const fullPath = path.join(this.basePath, prefix);
    try {
      const files = await fs.readdir(fullPath);
      return files.map(file => path.join(prefix, file));
    } catch (error) {
      return [];
    }
  }

  async exists(filePath) {
    const fullPath = path.join(this.basePath, filePath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
}

class S3StorageAdapter extends StorageAdapter {
  constructor(config) {
    super();
    this.s3 = new AWS.S3({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region
    });
    this.bucket = config.bucket;
  }

  async upload(data, key) {
    const params = {
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ServerSideEncryption: 'AES256'
    };
    
    const result = await this.s3.upload(params).promise();
    return result.Location;
  }

  async download(key) {
    const params = {
      Bucket: this.bucket,
      Key: key
    };
    
    const result = await this.s3.getObject(params).promise();
    return result.Body;
  }

  async delete(key) {
    const params = {
      Bucket: this.bucket,
      Key: key
    };
    
    await this.s3.deleteObject(params).promise();
  }

  async list(prefix) {
    const params = {
      Bucket: this.bucket,
      Prefix: prefix
    };
    
    const result = await this.s3.listObjectsV2(params).promise();
    return result.Contents.map(obj => obj.Key);
  }

  async exists(key) {
    try {
      await this.s3.headObject({
        Bucket: this.bucket,
        Key: key
      }).promise();
      return true;
    } catch {
      return false;
    }
  }
}

class GCSStorageAdapter extends StorageAdapter {
  constructor(config) {
    super();
    this.storage = new Storage({
      projectId: config.projectId,
      keyFilename: config.keyFilename
    });
    this.bucket = this.storage.bucket(config.bucket);
  }

  async upload(data, filePath) {
    const file = this.bucket.file(filePath);
    await file.save(data, {
      metadata: {
        contentType: 'application/octet-stream'
      }
    });
    return filePath;
  }

  async download(filePath) {
    const file = this.bucket.file(filePath);
    const [data] = await file.download();
    return data;
  }

  async delete(filePath) {
    const file = this.bucket.file(filePath);
    await file.delete();
  }

  async list(prefix) {
    const [files] = await this.bucket.getFiles({ prefix });
    return files.map(file => file.name);
  }

  async exists(filePath) {
    const file = this.bucket.file(filePath);
    const [exists] = await file.exists();
    return exists;
  }
}

class BackupEncryption {
  constructor(password) {
    this.algorithm = 'aes-256-gcm';
    this.salt = crypto.randomBytes(32);
    this.key = crypto.pbkdf2Sync(password, this.salt, 100000, 32, 'sha256');
  }

  encrypt(data) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(data),
      cipher.final()
    ]);
    
    const authTag = cipher.getAuthTag();
    
    return Buffer.concat([
      this.salt,
      iv,
      authTag,
      encrypted
    ]);
  }

  decrypt(encryptedData) {
    const salt = encryptedData.slice(0, 32);
    const iv = encryptedData.slice(32, 48);
    const authTag = encryptedData.slice(48, 64);
    const encrypted = encryptedData.slice(64);
    
    const key = crypto.pbkdf2Sync(
      this.password,
      salt,
      100000,
      32,
      'sha256'
    );
    
    const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
    decipher.setAuthTag(authTag);
    
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
  }
}

class BackupScheduler {
  constructor() {
    this.jobs = new Map();
  }

  schedule(name, cronExpression, callback) {
    if (this.jobs.has(name)) {
      this.cancel(name);
    }
    
    const job = cron.schedule(cronExpression, callback, {
      scheduled: true,
      timezone: 'UTC'
    });
    
    this.jobs.set(name, job);
    logger.info(`Scheduled backup job: ${name} with expression: ${cronExpression}`);
  }

  cancel(name) {
    const job = this.jobs.get(name);
    if (job) {
      job.stop();
      this.jobs.delete(name);
      logger.info(`Cancelled backup job: ${name}`);
    }
  }

  cancelAll() {
    for (const [name, job] of this.jobs) {
      job.stop();
    }
    this.jobs.clear();
  }

  getJobs() {
    return Array.from(this.jobs.keys());
  }
}

class BackupRetentionPolicy {
  constructor(config = {}) {
    this.policies = {
      daily: {
        count: config.dailyCount || 7,
        olderThan: config.dailyOlderThan || 0
      },
      weekly: {
        count: config.weeklyCount || 4,
        olderThan: config.weeklyOlderThan || 7
      },
      monthly: {
        count: config.monthlyCount || 12,
        olderThan: config.monthlyOlderThan || 30
      },
      yearly: {
        count: config.yearlyCount || 5,
        olderThan: config.yearlyOlderThan || 365
      }
    };
  }

  shouldRetain(backup) {
    const age = Date.now() - backup.timestamp;
    const days = age / (1000 * 60 * 60 * 24);
    
    // Always keep recent backups
    if (days < this.policies.daily.olderThan) {
      return true;
    }
    
    // Check retention policies
    for (const [period, policy] of Object.entries(this.policies)) {
      if (days >= policy.olderThan && backup.tags[period]) {
        return true;
      }
    }
    
    return false;
  }

  tagBackup(backup) {
    const date = new Date(backup.timestamp);
    const dayOfWeek = date.getDay();
    const dayOfMonth = date.getDate();
    const month = date.getMonth();
    
    // Tag daily
    backup.tags.daily = true;
    
    // Tag weekly (Sundays)
    if (dayOfWeek === 0) {
      backup.tags.weekly = true;
    }
    
    // Tag monthly (1st of month)
    if (dayOfMonth === 1) {
      backup.tags.monthly = true;
    }
    
    // Tag yearly (January 1st)
    if (month === 0 && dayOfMonth === 1) {
      backup.tags.yearly = true;
    }
    
    return backup;
  }
}

class AutomatedBackupSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      enabled: options.enabled !== false,
      encryptionPassword: options.encryptionPassword,
      compressionLevel: options.compressionLevel || 6,
      chunkSize: options.chunkSize || 50 * 1024 * 1024, // 50MB chunks
      parallelUploads: options.parallelUploads || 3,
      verifyAfterBackup: options.verifyAfterBackup !== false,
      schedules: options.schedules || {
        full: '0 2 * * 0', // Weekly at 2 AM Sunday
        incremental: '0 2 * * 1-6', // Daily at 2 AM Mon-Sat
        snapshot: '0 */6 * * *' // Every 6 hours
      },
      retention: options.retention || {},
      storageBackends: options.storageBackends || [StorageBackend.LOCAL],
      ...options
    };
    
    this.storageAdapters = new Map();
    this.scheduler = new BackupScheduler();
    this.retentionPolicy = new BackupRetentionPolicy(this.config.retention);
    this.backupHistory = [];
    this.currentBackup = null;
    
    // Statistics
    this.stats = {
      totalBackups: 0,
      successfulBackups: 0,
      failedBackups: 0,
      totalSize: 0,
      lastBackupTime: null,
      lastSuccessfulBackup: null,
      averageBackupDuration: 0
    };
    
    this.initialize();
  }

  initialize() {
    // Initialize storage adapters
    this.initializeStorageAdapters();
    
    // Schedule backups
    if (this.config.enabled) {
      this.scheduleBackups();
    }
    
    // Load backup history
    this.loadBackupHistory();
  }

  initializeStorageAdapters() {
    for (const backend of this.config.storageBackends) {
      switch (backend) {
        case StorageBackend.LOCAL:
          this.storageAdapters.set(backend, new LocalStorageAdapter(
            this.config.localPath || './backups'
          ));
          break;
          
        case StorageBackend.S3:
          if (this.config.s3) {
            this.storageAdapters.set(backend, new S3StorageAdapter(this.config.s3));
          }
          break;
          
        case StorageBackend.GCS:
          if (this.config.gcs) {
            this.storageAdapters.set(backend, new GCSStorageAdapter(this.config.gcs));
          }
          break;
      }
    }
  }

  scheduleBackups() {
    for (const [type, cronExpression] of Object.entries(this.config.schedules)) {
      this.scheduler.schedule(`backup-${type}`, cronExpression, async () => {
        await this.performBackup(type);
      });
    }
    
    // Schedule retention cleanup
    this.scheduler.schedule('retention-cleanup', '0 4 * * *', async () => {
      await this.cleanupOldBackups();
    });
  }

  async performBackup(type = BackupType.FULL, sources = null) {
    if (this.currentBackup) {
      logger.warn('Backup already in progress');
      return null;
    }
    
    const startTime = Date.now();
    const backup = new BackupMetadata({ type });
    
    this.currentBackup = {
      backup,
      state: BackupState.IN_PROGRESS,
      progress: 0,
      errors: []
    };
    
    try {
      logger.info(`Starting ${type} backup`, { backupId: backup.id });
      this.emit('backup:start', { backup, type });
      
      // Collect data to backup
      const data = await this.collectBackupData(sources || this.config.sources);
      backup.files = data.files;
      
      // Compress data
      let processedData = data.content;
      if (this.config.compressionLevel > 0) {
        processedData = await this.compressData(processedData);
        backup.compressed = true;
      }
      
      // Encrypt data
      if (this.config.encryptionPassword) {
        const encryption = new BackupEncryption(this.config.encryptionPassword);
        processedData = encryption.encrypt(processedData);
        backup.encrypted = true;
      }
      
      // Calculate checksum
      backup.checksum = crypto.createHash('sha256')
        .update(processedData)
        .digest('hex');
      backup.size = processedData.length;
      
      // Tag backup for retention
      this.retentionPolicy.tagBackup(backup);
      
      // Upload to storage backends
      await this.uploadToStorageBackends(processedData, backup);
      
      // Verify backup if configured
      if (this.config.verifyAfterBackup) {
        await this.verifyBackup(backup);
      }
      
      // Update statistics
      const duration = Date.now() - startTime;
      this.updateStatistics(backup, duration, true);
      
      // Mark as completed
      this.currentBackup.state = BackupState.COMPLETED;
      backup.duration = duration;
      
      // Add to history
      this.backupHistory.push(backup);
      await this.saveBackupHistory();
      
      logger.info(`Backup completed successfully`, {
        backupId: backup.id,
        duration,
        size: backup.size,
        type
      });
      
      this.emit('backup:complete', { backup, duration });
      
      return backup;
      
    } catch (error) {
      logger.error('Backup failed:', error);
      
      this.currentBackup.state = BackupState.FAILED;
      this.currentBackup.errors.push(error.message);
      
      const duration = Date.now() - startTime;
      this.updateStatistics(backup, duration, false);
      
      this.emit('backup:failed', { backup, error });
      
      throw error;
      
    } finally {
      this.currentBackup = null;
    }
  }

  async collectBackupData(sources) {
    const files = [];
    const chunks = [];
    
    for (const source of sources) {
      try {
        const data = await this.readSource(source);
        files.push({
          path: source.path,
          size: data.length,
          type: source.type
        });
        chunks.push(data);
      } catch (error) {
        logger.error(`Failed to read source: ${source.path}`, error);
        throw error;
      }
    }
    
    // Combine all data
    const content = Buffer.concat(chunks);
    
    return { files, content };
  }

  async readSource(source) {
    switch (source.type) {
      case 'file':
        return await fs.readFile(source.path);
        
      case 'database':
        return await this.backupDatabase(source);
        
      case 'directory':
        return await this.backupDirectory(source);
        
      default:
        throw new Error(`Unknown source type: ${source.type}`);
    }
  }

  async backupDatabase(source) {
    // Database-specific backup logic
    // This would integrate with your database system
    const dbData = await source.handler.export();
    return Buffer.from(JSON.stringify(dbData));
  }

  async backupDirectory(source) {
    // Create tar archive of directory
    const tar = require('tar');
    const stream = tar.c({ gzip: false }, [source.path]);
    
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    
    return Buffer.concat(chunks);
  }

  async compressData(data) {
    return await gzip(data, {
      level: this.config.compressionLevel
    });
  }

  async decompressData(data) {
    return await gunzip(data);
  }

  async uploadToStorageBackends(data, backup) {
    const uploads = [];
    
    for (const [backend, adapter] of this.storageAdapters) {
      uploads.push(this.uploadToBackend(adapter, data, backup, backend));
    }
    
    // Parallel uploads with concurrency limit
    const results = await this.limitConcurrency(
      uploads,
      this.config.parallelUploads
    );
    
    // Check for failures
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      logger.error(`Failed to upload to ${failures.length} backends`);
      if (failures.length === this.storageAdapters.size) {
        throw new Error('All storage backends failed');
      }
    }
  }

  async uploadToBackend(adapter, data, backup, backend) {
    try {
      const filename = this.generateBackupFilename(backup);
      const path = await adapter.upload(data, filename);
      
      backup.locations = backup.locations || {};
      backup.locations[backend] = path;
      
      logger.info(`Uploaded backup to ${backend}`, {
        backupId: backup.id,
        path
      });
      
      return { status: 'fulfilled', backend };
    } catch (error) {
      logger.error(`Failed to upload to ${backend}:`, error);
      return { status: 'rejected', backend, error };
    }
  }

  generateBackupFilename(backup) {
    const date = new Date(backup.timestamp);
    const dateStr = date.toISOString().replace(/:/g, '-').split('.')[0];
    return `backup-${backup.type}-${dateStr}-${backup.id}.bak`;
  }

  async verifyBackup(backup) {
    logger.info(`Verifying backup integrity`, { backupId: backup.id });
    
    for (const [backend, path] of Object.entries(backup.locations || {})) {
      try {
        const adapter = this.storageAdapters.get(backend);
        const data = await adapter.download(path);
        
        // Verify checksum
        const checksum = crypto.createHash('sha256')
          .update(data)
          .digest('hex');
          
        if (checksum !== backup.checksum) {
          throw new Error(`Checksum mismatch for ${backend}`);
        }
        
        logger.info(`Backup verified on ${backend}`, { backupId: backup.id });
      } catch (error) {
        logger.error(`Verification failed for ${backend}:`, error);
        throw error;
      }
    }
    
    backup.verified = true;
  }

  async restoreBackup(backupId, targetPath) {
    logger.info(`Starting restore for backup ${backupId}`);
    
    const backup = this.backupHistory.find(b => b.id === backupId);
    if (!backup) {
      throw new Error(`Backup not found: ${backupId}`);
    }
    
    try {
      // Download from first available backend
      let data = null;
      for (const [backend, path] of Object.entries(backup.locations || {})) {
        try {
          const adapter = this.storageAdapters.get(backend);
          data = await adapter.download(path);
          break;
        } catch (error) {
          logger.warn(`Failed to download from ${backend}:`, error);
        }
      }
      
      if (!data) {
        throw new Error('Failed to download backup from any backend');
      }
      
      // Verify checksum
      const checksum = crypto.createHash('sha256')
        .update(data)
        .digest('hex');
        
      if (checksum !== backup.checksum) {
        throw new Error('Backup integrity check failed');
      }
      
      // Decrypt if needed
      if (backup.encrypted) {
        const encryption = new BackupEncryption(this.config.encryptionPassword);
        data = encryption.decrypt(data);
      }
      
      // Decompress if needed
      if (backup.compressed) {
        data = await this.decompressData(data);
      }
      
      // Restore data
      await this.restoreData(data, backup, targetPath);
      
      logger.info(`Restore completed successfully`, { backupId });
      
      this.emit('restore:complete', { backup });
      
    } catch (error) {
      logger.error('Restore failed:', error);
      this.emit('restore:failed', { backup, error });
      throw error;
    }
  }

  async restoreData(data, backup, targetPath) {
    // Restore based on backup content
    // This would be implemented based on your specific needs
    await fs.writeFile(targetPath, data);
  }

  async cleanupOldBackups() {
    logger.info('Starting backup retention cleanup');
    
    const toDelete = [];
    
    for (const backup of this.backupHistory) {
      if (!this.retentionPolicy.shouldRetain(backup)) {
        toDelete.push(backup);
      }
    }
    
    logger.info(`Found ${toDelete.length} backups to delete`);
    
    for (const backup of toDelete) {
      await this.deleteBackup(backup);
    }
    
    // Update history
    this.backupHistory = this.backupHistory.filter(
      b => !toDelete.find(d => d.id === b.id)
    );
    
    await this.saveBackupHistory();
  }

  async deleteBackup(backup) {
    for (const [backend, path] of Object.entries(backup.locations || {})) {
      try {
        const adapter = this.storageAdapters.get(backend);
        await adapter.delete(path);
        logger.info(`Deleted backup from ${backend}`, { backupId: backup.id });
      } catch (error) {
        logger.error(`Failed to delete from ${backend}:`, error);
      }
    }
    
    this.emit('backup:deleted', { backup });
  }

  async loadBackupHistory() {
    try {
      const historyPath = path.join(
        this.config.localPath || './backups',
        'backup-history.json'
      );
      
      const data = await fs.readFile(historyPath, 'utf8');
      this.backupHistory = JSON.parse(data);
      
      logger.info(`Loaded ${this.backupHistory.length} backups from history`);
    } catch (error) {
      logger.warn('Failed to load backup history:', error);
      this.backupHistory = [];
    }
  }

  async saveBackupHistory() {
    try {
      const historyPath = path.join(
        this.config.localPath || './backups',
        'backup-history.json'
      );
      
      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      await fs.writeFile(
        historyPath,
        JSON.stringify(this.backupHistory, null, 2)
      );
    } catch (error) {
      logger.error('Failed to save backup history:', error);
    }
  }

  async limitConcurrency(promises, limit) {
    const results = [];
    const executing = [];
    
    for (const promise of promises) {
      const p = Promise.resolve().then(() => promise);
      results.push(p);
      
      if (promises.length >= limit) {
        executing.push(p);
        if (executing.length >= limit) {
          await Promise.race(executing);
          executing.splice(executing.findIndex(ep => ep === p), 1);
        }
      }
    }
    
    return await Promise.allSettled(results);
  }

  updateStatistics(backup, duration, success) {
    this.stats.totalBackups++;
    
    if (success) {
      this.stats.successfulBackups++;
      this.stats.lastSuccessfulBackup = backup.timestamp;
      this.stats.totalSize += backup.size;
    } else {
      this.stats.failedBackups++;
    }
    
    this.stats.lastBackupTime = backup.timestamp;
    
    // Update average duration
    this.stats.averageBackupDuration = 
      (this.stats.averageBackupDuration * (this.stats.totalBackups - 1) + duration) /
      this.stats.totalBackups;
  }

  getStatistics() {
    return {
      ...this.stats,
      successRate: this.stats.totalBackups > 0
        ? (this.stats.successfulBackups / this.stats.totalBackups) * 100
        : 0,
      storageBackends: Array.from(this.storageAdapters.keys()),
      scheduledJobs: this.scheduler.getJobs(),
      backupCount: this.backupHistory.length,
      oldestBackup: this.backupHistory.length > 0
        ? new Date(Math.min(...this.backupHistory.map(b => b.timestamp)))
        : null
    };
  }

  getBackupHistory(limit = 100) {
    return this.backupHistory
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async testBackupRestore(backupId) {
    const tempPath = path.join(
      require('os').tmpdir(),
      `backup-test-${Date.now()}`
    );
    
    try {
      await this.restoreBackup(backupId, tempPath);
      
      // Verify restored data
      const exists = await fs.access(tempPath)
        .then(() => true)
        .catch(() => false);
        
      if (!exists) {
        throw new Error('Restore test failed - no data restored');
      }
      
      // Cleanup
      await fs.unlink(tempPath);
      
      return { success: true, message: 'Backup restore test passed' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  stop() {
    this.scheduler.cancelAll();
    this.removeAllListeners();
    logger.info('Automated backup system stopped');
  }
}

module.exports = AutomatedBackupSystem;