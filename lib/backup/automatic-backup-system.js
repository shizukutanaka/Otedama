/**
 * Automatic Backup System - Otedama
 * Production-ready backup system with multiple strategies
 * 
 * Design principles:
 * - Carmack: Fast incremental backups
 * - Martin: Clean backup architecture
 * - Pike: Simple restore process
 */

import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { createReadStream, createWriteStream } from 'fs';
import { join, dirname, basename } from 'path';
import { pipeline } from 'stream/promises';
import { createGzip, createGunzip } from 'zlib';
import { createHash } from 'crypto';
import tar from 'tar';
import cron from 'node-cron';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('AutomaticBackupSystem');

/**
 * Backup strategies
 */
export const BackupStrategy = {
  FULL: 'full',
  INCREMENTAL: 'incremental',
  DIFFERENTIAL: 'differential',
  SNAPSHOT: 'snapshot'
};

/**
 * Backup destinations
 */
export const BackupDestination = {
  LOCAL: 'local',
  S3: 's3',
  FTP: 'ftp',
  GOOGLE_CLOUD: 'google_cloud',
  AZURE: 'azure'
};

/**
 * Backup status
 */
export const BackupStatus = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  VERIFYING: 'verifying',
  VERIFIED: 'verified'
};

/**
 * Automatic Backup System
 */
export class AutomaticBackupSystem extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Backup paths
      sourcePaths: config.sourcePaths || ['./data', './config', './logs'],
      backupPath: config.backupPath || './backups',
      tempPath: config.tempPath || './temp/backups',
      
      // Backup settings
      strategy: config.strategy || BackupStrategy.INCREMENTAL,
      destinations: config.destinations || [BackupDestination.LOCAL],
      compression: config.compression !== false,
      encryption: config.encryption || false,
      
      // Schedule
      schedule: config.schedule || '0 2 * * *', // 2 AM daily
      enabled: config.enabled !== false,
      
      // Retention
      retentionDays: config.retentionDays || 30,
      maxBackups: config.maxBackups || 10,
      keepMonthly: config.keepMonthly || 6,
      keepYearly: config.keepYearly || 2,
      
      // Performance
      parallelUploads: config.parallelUploads || 3,
      chunkSize: config.chunkSize || 5 * 1024 * 1024, // 5MB
      
      // Cloud storage
      s3: config.s3 || {
        region: process.env.AWS_REGION || 'us-east-1',
        bucket: process.env.BACKUP_BUCKET || 'otedama-backups',
        prefix: process.env.BACKUP_PREFIX || 'backups/'
      },
      
      ...config
    };
    
    this.backupHistory = [];
    this.currentBackup = null;
    this.lastFullBackup = null;
    this.incrementalIndex = new Map();
    
    this.initialize();
  }
  
  /**
   * Initialize backup system
   */
  async initialize() {
    try {
      // Create backup directories
      await this.createDirectories();
      
      // Load backup history
      await this.loadBackupHistory();
      
      // Initialize cloud storage clients
      await this.initializeCloudStorage();
      
      // Schedule backups
      if (this.config.enabled) {
        this.scheduleBackups();
      }
      
      logger.info('Automatic backup system initialized', {
        strategy: this.config.strategy,
        destinations: this.config.destinations,
        schedule: this.config.schedule
      });
      
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Failed to initialize backup system', { error });
      throw error;
    }
  }
  
  /**
   * Create required directories
   */
  async createDirectories() {
    const dirs = [
      this.config.backupPath,
      this.config.tempPath,
      join(this.config.backupPath, 'full'),
      join(this.config.backupPath, 'incremental'),
      join(this.config.backupPath, 'metadata')
    ];
    
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }
  
  /**
   * Initialize cloud storage
   */
  async initializeCloudStorage() {
    if (this.config.destinations.includes(BackupDestination.S3)) {
      this.s3Client = new S3Client({
        region: this.config.s3.region,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      });
      
      // Test connection
      try {
        await this.s3Client.send(new ListObjectsV2Command({
          Bucket: this.config.s3.bucket,
          Prefix: this.config.s3.prefix,
          MaxKeys: 1
        }));
        logger.info('S3 backup destination configured');
      } catch (error) {
        logger.error('Failed to connect to S3', { error });
        throw error;
      }
    }
  }
  
  /**
   * Schedule automatic backups
   */
  scheduleBackups() {
    this.cronJob = cron.schedule(this.config.schedule, async () => {
      try {
        logger.info('Starting scheduled backup');
        await this.performBackup();
      } catch (error) {
        logger.error('Scheduled backup failed', { error });
        this.emit('backupFailed', { error });
      }
    });
    
    logger.info('Backup schedule activated', { schedule: this.config.schedule });
  }
  
  /**
   * Perform backup
   */
  async performBackup(options = {}) {
    const backupId = this.generateBackupId();
    const strategy = options.strategy || this.config.strategy;
    
    this.currentBackup = {
      id: backupId,
      strategy,
      status: BackupStatus.IN_PROGRESS,
      startTime: Date.now(),
      destinations: options.destinations || this.config.destinations,
      metadata: {
        sourcePaths: this.config.sourcePaths,
        compression: this.config.compression,
        encryption: this.config.encryption
      }
    };
    
    this.emit('backupStarted', this.currentBackup);
    
    try {
      // Create backup based on strategy
      let backupFile;
      switch (strategy) {
        case BackupStrategy.FULL:
          backupFile = await this.createFullBackup(backupId);
          break;
          
        case BackupStrategy.INCREMENTAL:
          backupFile = await this.createIncrementalBackup(backupId);
          break;
          
        case BackupStrategy.DIFFERENTIAL:
          backupFile = await this.createDifferentialBackup(backupId);
          break;
          
        case BackupStrategy.SNAPSHOT:
          backupFile = await this.createSnapshot(backupId);
          break;
          
        default:
          throw new Error(`Unknown backup strategy: ${strategy}`);
      }
      
      // Verify backup
      this.currentBackup.status = BackupStatus.VERIFYING;
      const verified = await this.verifyBackup(backupFile);
      
      if (!verified) {
        throw new Error('Backup verification failed');
      }
      
      // Upload to destinations
      await this.uploadBackup(backupFile, backupId);
      
      // Update backup metadata
      this.currentBackup.status = BackupStatus.COMPLETED;
      this.currentBackup.endTime = Date.now();
      this.currentBackup.duration = this.currentBackup.endTime - this.currentBackup.startTime;
      this.currentBackup.size = (await fs.stat(backupFile)).size;
      this.currentBackup.file = backupFile;
      this.currentBackup.checksum = await this.calculateChecksum(backupFile);
      
      // Save backup history
      this.backupHistory.push(this.currentBackup);
      await this.saveBackupHistory();
      
      // Cleanup old backups
      await this.cleanupOldBackups();
      
      logger.info('Backup completed successfully', {
        id: backupId,
        strategy,
        duration: this.currentBackup.duration,
        size: this.currentBackup.size
      });
      
      this.emit('backupCompleted', this.currentBackup);
      
      return this.currentBackup;
      
    } catch (error) {
      this.currentBackup.status = BackupStatus.FAILED;
      this.currentBackup.error = error.message;
      
      logger.error('Backup failed', {
        id: backupId,
        error
      });
      
      this.emit('backupFailed', { backup: this.currentBackup, error });
      
      throw error;
      
    } finally {
      this.currentBackup = null;
    }
  }
  
  /**
   * Create full backup
   */
  async createFullBackup(backupId) {
    const backupFile = join(this.config.backupPath, 'full', `backup-${backupId}.tar.gz`);
    
    logger.info('Creating full backup', { id: backupId });
    
    // Create tar archive
    await tar.create(
      {
        gzip: this.config.compression,
        file: backupFile,
        cwd: process.cwd(),
        filter: (path) => !this.shouldExclude(path)
      },
      this.config.sourcePaths
    );
    
    // Update last full backup reference
    this.lastFullBackup = {
      id: backupId,
      file: backupFile,
      timestamp: Date.now()
    };
    
    // Reset incremental index
    this.incrementalIndex.clear();
    await this.updateFileIndex();
    
    return backupFile;
  }
  
  /**
   * Create incremental backup
   */
  async createIncrementalBackup(backupId) {
    if (!this.lastFullBackup) {
      logger.info('No full backup found, creating full backup instead');
      return this.createFullBackup(backupId);
    }
    
    const backupFile = join(this.config.backupPath, 'incremental', `backup-${backupId}.tar.gz`);
    const changedFiles = await this.findChangedFiles();
    
    if (changedFiles.length === 0) {
      logger.info('No changes detected, skipping incremental backup');
      throw new Error('No changes to backup');
    }
    
    logger.info('Creating incremental backup', {
      id: backupId,
      changedFiles: changedFiles.length
    });
    
    // Create tar archive with changed files
    await tar.create(
      {
        gzip: this.config.compression,
        file: backupFile,
        cwd: process.cwd()
      },
      changedFiles
    );
    
    // Update file index
    await this.updateFileIndex();
    
    return backupFile;
  }
  
  /**
   * Create differential backup
   */
  async createDifferentialBackup(backupId) {
    if (!this.lastFullBackup) {
      logger.info('No full backup found, creating full backup instead');
      return this.createFullBackup(backupId);
    }
    
    const backupFile = join(this.config.backupPath, 'incremental', `backup-${backupId}-diff.tar.gz`);
    const changedFiles = await this.findChangedFilesSinceFullBackup();
    
    if (changedFiles.length === 0) {
      logger.info('No changes detected since full backup');
      throw new Error('No changes to backup');
    }
    
    logger.info('Creating differential backup', {
      id: backupId,
      changedFiles: changedFiles.length
    });
    
    await tar.create(
      {
        gzip: this.config.compression,
        file: backupFile,
        cwd: process.cwd()
      },
      changedFiles
    );
    
    return backupFile;
  }
  
  /**
   * Create snapshot
   */
  async createSnapshot(backupId) {
    const snapshotDir = join(this.config.tempPath, `snapshot-${backupId}`);
    const backupFile = join(this.config.backupPath, 'full', `snapshot-${backupId}.tar.gz`);
    
    logger.info('Creating snapshot backup', { id: backupId });
    
    // Create snapshot directory
    await fs.mkdir(snapshotDir, { recursive: true });
    
    // Copy all files maintaining structure
    for (const sourcePath of this.config.sourcePaths) {
      await this.copyDirectory(sourcePath, join(snapshotDir, basename(sourcePath)));
    }
    
    // Create tar archive
    await tar.create(
      {
        gzip: this.config.compression,
        file: backupFile,
        cwd: snapshotDir
      },
      ['.']
    );
    
    // Cleanup snapshot directory
    await fs.rm(snapshotDir, { recursive: true });
    
    return backupFile;
  }
  
  /**
   * Find changed files for incremental backup
   */
  async findChangedFiles() {
    const changedFiles = [];
    
    for (const sourcePath of this.config.sourcePaths) {
      const files = await this.getAllFiles(sourcePath);
      
      for (const file of files) {
        const stats = await fs.stat(file);
        const lastBackupTime = this.incrementalIndex.get(file);
        
        if (!lastBackupTime || stats.mtime.getTime() > lastBackupTime) {
          changedFiles.push(file);
        }
      }
    }
    
    return changedFiles;
  }
  
  /**
   * Find changed files since full backup
   */
  async findChangedFilesSinceFullBackup() {
    const changedFiles = [];
    const fullBackupTime = this.lastFullBackup.timestamp;
    
    for (const sourcePath of this.config.sourcePaths) {
      const files = await this.getAllFiles(sourcePath);
      
      for (const file of files) {
        const stats = await fs.stat(file);
        
        if (stats.mtime.getTime() > fullBackupTime) {
          changedFiles.push(file);
        }
      }
    }
    
    return changedFiles;
  }
  
  /**
   * Update file index for incremental backups
   */
  async updateFileIndex() {
    for (const sourcePath of this.config.sourcePaths) {
      const files = await this.getAllFiles(sourcePath);
      
      for (const file of files) {
        const stats = await fs.stat(file);
        this.incrementalIndex.set(file, stats.mtime.getTime());
      }
    }
    
    // Save index
    const indexFile = join(this.config.backupPath, 'metadata', 'file-index.json');
    await fs.writeFile(
      indexFile,
      JSON.stringify(Array.from(this.incrementalIndex.entries()), null, 2)
    );
  }
  
  /**
   * Verify backup integrity
   */
  async verifyBackup(backupFile) {
    try {
      logger.info('Verifying backup', { file: backupFile });
      
      // Test extraction
      const testDir = join(this.config.tempPath, 'verify-' + Date.now());
      await fs.mkdir(testDir, { recursive: true });
      
      await tar.extract({
        file: backupFile,
        cwd: testDir
      });
      
      // Cleanup test directory
      await fs.rm(testDir, { recursive: true });
      
      logger.info('Backup verification successful');
      return true;
      
    } catch (error) {
      logger.error('Backup verification failed', { error });
      return false;
    }
  }
  
  /**
   * Upload backup to destinations
   */
  async uploadBackup(backupFile, backupId) {
    const uploads = [];
    
    for (const destination of this.currentBackup.destinations) {
      switch (destination) {
        case BackupDestination.LOCAL:
          // Already saved locally
          break;
          
        case BackupDestination.S3:
          uploads.push(this.uploadToS3(backupFile, backupId));
          break;
          
        // Add other cloud providers as needed
      }
    }
    
    await Promise.all(uploads);
  }
  
  /**
   * Upload to S3
   */
  async uploadToS3(backupFile, backupId) {
    if (!this.s3Client) {
      throw new Error('S3 client not initialized');
    }
    
    const key = `${this.config.s3.prefix}${backupId}/${basename(backupFile)}`;
    const fileStream = createReadStream(backupFile);
    const stats = await fs.stat(backupFile);
    
    logger.info('Uploading backup to S3', {
      bucket: this.config.s3.bucket,
      key,
      size: stats.size
    });
    
    try {
      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.config.s3.bucket,
        Key: key,
        Body: fileStream,
        ContentLength: stats.size,
        Metadata: {
          backupId,
          strategy: this.currentBackup.strategy,
          timestamp: new Date().toISOString()
        }
      }));
      
      logger.info('S3 upload completed', { key });
      
    } catch (error) {
      logger.error('S3 upload failed', { error });
      throw error;
    }
  }
  
  /**
   * Restore from backup
   */
  async restoreBackup(backupId, options = {}) {
    const backup = this.backupHistory.find(b => b.id === backupId);
    
    if (!backup) {
      throw new Error(`Backup not found: ${backupId}`);
    }
    
    const restoreDir = options.restoreDir || join(this.config.tempPath, 'restore-' + Date.now());
    
    logger.info('Starting restore', {
      backupId,
      strategy: backup.strategy,
      restoreDir
    });
    
    this.emit('restoreStarted', { backupId, restoreDir });
    
    try {
      // Create restore directory
      await fs.mkdir(restoreDir, { recursive: true });
      
      // Restore based on strategy
      if (backup.strategy === BackupStrategy.INCREMENTAL) {
        await this.restoreIncremental(backupId, restoreDir);
      } else {
        await this.restoreFromFile(backup.file, restoreDir);
      }
      
      logger.info('Restore completed', { backupId, restoreDir });
      
      this.emit('restoreCompleted', { backupId, restoreDir });
      
      return restoreDir;
      
    } catch (error) {
      logger.error('Restore failed', { backupId, error });
      this.emit('restoreFailed', { backupId, error });
      throw error;
    }
  }
  
  /**
   * Restore incremental backup
   */
  async restoreIncremental(targetBackupId, restoreDir) {
    // Find all related backups
    const backups = [];
    let currentBackup = this.backupHistory.find(b => b.id === targetBackupId);
    
    // Walk back to find full backup
    while (currentBackup && currentBackup.strategy === BackupStrategy.INCREMENTAL) {
      backups.unshift(currentBackup);
      
      // Find previous backup
      const currentIndex = this.backupHistory.indexOf(currentBackup);
      currentBackup = currentIndex > 0 ? this.backupHistory[currentIndex - 1] : null;
    }
    
    // Add full backup
    if (currentBackup && currentBackup.strategy === BackupStrategy.FULL) {
      backups.unshift(currentBackup);
    } else {
      throw new Error('Full backup not found for incremental restore');
    }
    
    // Restore in order
    for (const backup of backups) {
      logger.info('Restoring backup', { id: backup.id, strategy: backup.strategy });
      await this.restoreFromFile(backup.file, restoreDir);
    }
  }
  
  /**
   * Restore from file
   */
  async restoreFromFile(backupFile, restoreDir) {
    await tar.extract({
      file: backupFile,
      cwd: restoreDir
    });
  }
  
  /**
   * Cleanup old backups
   */
  async cleanupOldBackups() {
    const now = Date.now();
    const cutoffTime = now - (this.config.retentionDays * 24 * 60 * 60 * 1000);
    
    // Group backups by type and date
    const backupsToKeep = new Set();
    const backupsToDelete = [];
    
    // Keep recent backups
    const recentBackups = this.backupHistory
      .filter(b => b.endTime && b.endTime > cutoffTime)
      .slice(-this.config.maxBackups);
    
    recentBackups.forEach(b => backupsToKeep.add(b.id));
    
    // Keep monthly backups
    const monthlyBackups = this.selectMonthlyBackups(this.config.keepMonthly);
    monthlyBackups.forEach(b => backupsToKeep.add(b.id));
    
    // Keep yearly backups
    const yearlyBackups = this.selectYearlyBackups(this.config.keepYearly);
    yearlyBackups.forEach(b => backupsToKeep.add(b.id));
    
    // Identify backups to delete
    for (const backup of this.backupHistory) {
      if (!backupsToKeep.has(backup.id) && backup.file) {
        backupsToDelete.push(backup);
      }
    }
    
    // Delete old backups
    for (const backup of backupsToDelete) {
      try {
        await fs.unlink(backup.file);
        logger.info('Deleted old backup', { id: backup.id });
      } catch (error) {
        logger.error('Failed to delete backup', { id: backup.id, error });
      }
    }
    
    // Update history
    this.backupHistory = this.backupHistory.filter(b => backupsToKeep.has(b.id));
    await this.saveBackupHistory();
    
    logger.info('Backup cleanup completed', {
      deleted: backupsToDelete.length,
      kept: backupsToKeep.size
    });
  }
  
  /**
   * Select monthly backups to keep
   */
  selectMonthlyBackups(count) {
    const monthlyBackups = [];
    const usedMonths = new Set();
    
    // Sort by date descending
    const sorted = [...this.backupHistory]
      .filter(b => b.status === BackupStatus.COMPLETED)
      .sort((a, b) => b.endTime - a.endTime);
    
    for (const backup of sorted) {
      const date = new Date(backup.endTime);
      const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
      
      if (!usedMonths.has(monthKey)) {
        monthlyBackups.push(backup);
        usedMonths.add(monthKey);
        
        if (monthlyBackups.length >= count) {
          break;
        }
      }
    }
    
    return monthlyBackups;
  }
  
  /**
   * Select yearly backups to keep
   */
  selectYearlyBackups(count) {
    const yearlyBackups = [];
    const usedYears = new Set();
    
    const sorted = [...this.backupHistory]
      .filter(b => b.status === BackupStatus.COMPLETED)
      .sort((a, b) => b.endTime - a.endTime);
    
    for (const backup of sorted) {
      const year = new Date(backup.endTime).getFullYear();
      
      if (!usedYears.has(year)) {
        yearlyBackups.push(backup);
        usedYears.add(year);
        
        if (yearlyBackups.length >= count) {
          break;
        }
      }
    }
    
    return yearlyBackups;
  }
  
  /**
   * Load backup history
   */
  async loadBackupHistory() {
    const historyFile = join(this.config.backupPath, 'metadata', 'backup-history.json');
    
    try {
      const data = await fs.readFile(historyFile, 'utf8');
      this.backupHistory = JSON.parse(data);
      
      // Find last full backup
      const lastFull = this.backupHistory
        .filter(b => b.strategy === BackupStrategy.FULL && b.status === BackupStatus.COMPLETED)
        .sort((a, b) => b.endTime - a.endTime)[0];
      
      if (lastFull) {
        this.lastFullBackup = {
          id: lastFull.id,
          file: lastFull.file,
          timestamp: lastFull.endTime
        };
      }
      
      // Load file index
      await this.loadFileIndex();
      
      logger.info('Loaded backup history', { count: this.backupHistory.length });
      
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Failed to load backup history', { error });
      }
      this.backupHistory = [];
    }
  }
  
  /**
   * Save backup history
   */
  async saveBackupHistory() {
    const historyFile = join(this.config.backupPath, 'metadata', 'backup-history.json');
    
    await fs.writeFile(
      historyFile,
      JSON.stringify(this.backupHistory, null, 2)
    );
  }
  
  /**
   * Load file index
   */
  async loadFileIndex() {
    const indexFile = join(this.config.backupPath, 'metadata', 'file-index.json');
    
    try {
      const data = await fs.readFile(indexFile, 'utf8');
      const entries = JSON.parse(data);
      this.incrementalIndex = new Map(entries);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Failed to load file index', { error });
      }
    }
  }
  
  /**
   * Calculate file checksum
   */
  async calculateChecksum(file) {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    
    return hash.digest('hex');
  }
  
  /**
   * Generate backup ID
   */
  generateBackupId() {
    const date = new Date();
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
      String(date.getHours()).padStart(2, '0'),
      String(date.getMinutes()).padStart(2, '0'),
      String(date.getSeconds()).padStart(2, '0'),
      Math.random().toString(36).substr(2, 4)
    ].join('');
  }
  
  /**
   * Check if path should be excluded
   */
  shouldExclude(path) {
    const excludePatterns = [
      /node_modules/,
      /\.git/,
      /\.tmp/,
      /\.cache/,
      new RegExp(this.config.backupPath.replace(/[\\/]/g, '[\\\\/]'))
    ];
    
    return excludePatterns.some(pattern => pattern.test(path));
  }
  
  /**
   * Get all files in directory
   */
  async getAllFiles(dir, files = []) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      
      if (entry.isDirectory() && !this.shouldExclude(fullPath)) {
        await this.getAllFiles(fullPath, files);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
    
    return files;
  }
  
  /**
   * Copy directory
   */
  async copyDirectory(src, dest) {
    await fs.mkdir(dest, { recursive: true });
    
    const entries = await fs.readdir(src, { withFileTypes: true });
    
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      
      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }
  
  /**
   * Get backup statistics
   */
  getStatistics() {
    const stats = {
      totalBackups: this.backupHistory.length,
      successfulBackups: this.backupHistory.filter(b => b.status === BackupStatus.COMPLETED).length,
      failedBackups: this.backupHistory.filter(b => b.status === BackupStatus.FAILED).length,
      totalSize: this.backupHistory.reduce((sum, b) => sum + (b.size || 0), 0),
      lastBackup: this.backupHistory[this.backupHistory.length - 1],
      nextScheduled: this.cronJob?.nextDates(1)[0]
    };
    
    return stats;
  }
  
  /**
   * Manual backup trigger
   */
  async triggerBackup(options = {}) {
    logger.info('Manual backup triggered');
    return this.performBackup(options);
  }
  
  /**
   * Pause scheduled backups
   */
  pauseSchedule() {
    if (this.cronJob) {
      this.cronJob.stop();
      logger.info('Backup schedule paused');
    }
  }
  
  /**
   * Resume scheduled backups
   */
  resumeSchedule() {
    if (this.cronJob) {
      this.cronJob.start();
      logger.info('Backup schedule resumed');
    }
  }
  
  /**
   * Shutdown backup system
   */
  async shutdown() {
    if (this.cronJob) {
      this.cronJob.stop();
    }
    
    logger.info('Backup system shutdown');
    this.emit('shutdown');
  }
}

/**
 * Factory function
 */
export function createBackupSystem(config) {
  return new AutomaticBackupSystem(config);
}

export default AutomaticBackupSystem;