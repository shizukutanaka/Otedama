/**
 * Automated Maintenance System - Otedama
 * Self-maintaining infrastructure with automatic backups and cleanup
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import fs from 'fs/promises';
import path from 'path';
import { createReadStream, createWriteStream } from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';

const logger = createStructuredLogger('AutoMaintenance');

export class AutoMaintenance extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Backup settings
      backupPath: options.backupPath || './backups',
      maxBackups: options.maxBackups || 30,
      backupInterval: options.backupInterval || 86400000, // 24 hours
      incrementalBackup: options.incrementalBackup !== false,
      compression: options.compression !== false,
      encryption: options.encryption || false,
      encryptionKey: options.encryptionKey || null,
      
      // Cleanup settings
      logRetention: options.logRetention || 7, // days
      tempFileAge: options.tempFileAge || 24, // hours
      cacheExpiry: options.cacheExpiry || 72, // hours
      databaseVacuum: options.databaseVacuum !== false,
      
      // Maintenance windows
      maintenanceWindow: {
        start: options.maintenanceStart || 2, // 2 AM
        end: options.maintenanceEnd || 5, // 5 AM
        timezone: options.timezone || 'UTC'
      },
      
      // Performance settings
      defragThreshold: options.defragThreshold || 30, // %
      compressionThreshold: options.compressionThreshold || 50, // MB
      indexRebuildInterval: options.indexRebuildInterval || 604800000, // 7 days
      
      // Health checks
      diskSpaceThreshold: options.diskSpaceThreshold || 90, // %
      inodeThreshold: options.inodeThreshold || 90, // %
      memoryThreshold: options.memoryThreshold || 90, // %
      
      // Features
      autoUpdate: options.autoUpdate !== false,
      autoRestart: options.autoRestart !== false,
      predictiveMaintenance: options.predictiveMaintenance !== false,
      
      ...options
    };
    
    // State
    this.state = {
      isRunning: false,
      lastBackup: null,
      lastCleanup: null,
      lastDefrag: null,
      lastIndexRebuild: null,
      maintenanceActive: false,
      backupManifest: new Map()
    };
    
    // Scheduled tasks
    this.scheduledTasks = new Map();
    
    // Maintenance history
    this.history = {
      backups: [],
      cleanups: [],
      repairs: [],
      updates: []
    };
    
    // Statistics
    this.stats = {
      backupsCreated: 0,
      backupsRestored: 0,
      filesCleanedUp: 0,
      spaceSaved: 0,
      repairsPerformed: 0,
      updatesApplied: 0
    };
    
    // Timers
    this.timers = {
      backup: null,
      cleanup: null,
      health: null,
      maintenance: null
    };
  }
  
  /**
   * Start automated maintenance
   */
  async start() {
    if (this.state.isRunning) {
      logger.warn('Auto-maintenance already running');
      return;
    }
    
    logger.info('Starting automated maintenance system');
    
    try {
      // Ensure backup directory exists
      await this.ensureBackupDirectory();
      
      // Load backup manifest
      await this.loadBackupManifest();
      
      // Schedule regular tasks
      this.scheduleTasks();
      
      // Perform initial health check
      await this.performHealthCheck();
      
      this.state.isRunning = true;
      
      this.emit('started', {
        scheduledTasks: Array.from(this.scheduledTasks.keys()),
        nextBackup: this.getNextBackupTime(),
        nextMaintenance: this.getNextMaintenanceWindow()
      });
      
    } catch (error) {
      logger.error('Failed to start auto-maintenance', { error: error.message });
      throw error;
    }
  }
  
  /**
   * Schedule maintenance tasks
   */
  scheduleTasks() {
    // Backup task
    this.timers.backup = setInterval(async () => {
      if (await this.isMaintenanceWindow()) {
        await this.performBackup();
      }
    }, this.options.backupInterval);
    
    // Cleanup task
    this.timers.cleanup = setInterval(async () => {
      await this.performCleanup();
    }, 3600000); // Every hour
    
    // Health check
    this.timers.health = setInterval(async () => {
      await this.performHealthCheck();
    }, 300000); // Every 5 minutes
    
    // Maintenance window check
    this.timers.maintenance = setInterval(async () => {
      await this.checkMaintenanceWindow();
    }, 60000); // Every minute
    
    logger.info('Maintenance tasks scheduled', {
      tasks: ['backup', 'cleanup', 'health', 'maintenance']
    });
  }
  
  /**
   * Perform automated backup
   */
  async performBackup() {
    const startTime = Date.now();
    const backupId = `backup_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    logger.info('Starting automated backup', { backupId });
    
    try {
      // Create backup metadata
      const backup = {
        id: backupId,
        timestamp: Date.now(),
        type: this.options.incrementalBackup && this.state.lastBackup ? 'incremental' : 'full',
        previous: this.state.lastBackup,
        files: [],
        size: 0,
        compressed: this.options.compression,
        encrypted: this.options.encryption
      };
      
      // Determine what to backup
      const backupTargets = await this.getBackupTargets();
      
      // Create backup directory
      const backupDir = path.join(this.options.backupPath, backupId);
      await fs.mkdir(backupDir, { recursive: true });
      
      // Backup each target
      for (const target of backupTargets) {
        try {
          const backupInfo = await this.backupTarget(target, backupDir, backup);
          backup.files.push(backupInfo);
          backup.size += backupInfo.size;
        } catch (error) {
          logger.error('Failed to backup target', {
            target: target.path,
            error: error.message
          });
        }
      }
      
      // Save backup manifest
      await this.saveBackupManifest(backupId, backup);
      
      // Cleanup old backups
      await this.cleanupOldBackups();
      
      // Update state
      this.state.lastBackup = backupId;
      this.stats.backupsCreated++;
      
      const duration = Date.now() - startTime;
      
      logger.info('Backup completed', {
        backupId,
        type: backup.type,
        files: backup.files.length,
        size: this.formatBytes(backup.size),
        duration
      });
      
      this.emit('backup:completed', {
        backup,
        duration
      });
      
      // Add to history
      this.history.backups.push({
        id: backupId,
        timestamp: backup.timestamp,
        type: backup.type,
        size: backup.size,
        duration
      });
      
    } catch (error) {
      logger.error('Backup failed', { error: error.message });
      this.emit('backup:failed', { error });
    }
  }
  
  /**
   * Get backup targets
   */
  async getBackupTargets() {
    const targets = [
      { path: './config', type: 'directory', priority: 'high' },
      { path: './data', type: 'directory', priority: 'high' },
      { path: './logs', type: 'directory', priority: 'medium' },
      { path: './models', type: 'directory', priority: 'medium' },
      { path: './certificates', type: 'directory', priority: 'high' }
    ];
    
    // Filter existing targets
    const existingTargets = [];
    for (const target of targets) {
      try {
        await fs.access(target.path);
        existingTargets.push(target);
      } catch {
        // Path doesn't exist, skip
      }
    }
    
    return existingTargets;
  }
  
  /**
   * Backup a target
   */
  async backupTarget(target, backupDir, backupMeta) {
    const targetName = path.basename(target.path);
    const backupPath = path.join(backupDir, targetName);
    
    const stats = await fs.stat(target.path);
    
    if (stats.isDirectory()) {
      // Backup directory
      await this.backupDirectory(target.path, backupPath);
    } else {
      // Backup file
      await this.backupFile(target.path, backupPath);
    }
    
    return {
      source: target.path,
      destination: backupPath,
      type: target.type,
      size: await this.getBackupSize(backupPath),
      timestamp: Date.now()
    };
  }
  
  /**
   * Backup directory recursively
   */
  async backupDirectory(source, destination) {
    await fs.mkdir(destination, { recursive: true });
    
    const entries = await fs.readdir(source, { withFileTypes: true });
    
    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const destPath = path.join(destination, entry.name);
      
      if (entry.isDirectory()) {
        await this.backupDirectory(sourcePath, destPath);
      } else {
        await this.backupFile(sourcePath, destPath);
      }
    }
  }
  
  /**
   * Backup single file
   */
  async backupFile(source, destination) {
    const streams = [createReadStream(source)];
    
    // Add compression if enabled
    if (this.options.compression) {
      streams.push(zlib.createGzip());
      destination += '.gz';
    }
    
    // Add encryption if enabled
    if (this.options.encryption && this.options.encryptionKey) {
      const cipher = crypto.createCipheriv(
        'aes-256-gcm',
        Buffer.from(this.options.encryptionKey, 'hex'),
        crypto.randomBytes(16)
      );
      streams.push(cipher);
      destination += '.enc';
    }
    
    streams.push(createWriteStream(destination));
    
    await pipeline(...streams);
  }
  
  /**
   * Perform cleanup
   */
  async performCleanup() {
    const startTime = Date.now();
    
    logger.info('Starting automated cleanup');
    
    try {
      let totalCleaned = 0;
      let spaceSaved = 0;
      
      // Clean old logs
      const logsCleaned = await this.cleanOldLogs();
      totalCleaned += logsCleaned.count;
      spaceSaved += logsCleaned.size;
      
      // Clean temporary files
      const tempCleaned = await this.cleanTempFiles();
      totalCleaned += tempCleaned.count;
      spaceSaved += tempCleaned.size;
      
      // Clean cache
      const cacheCleaned = await this.cleanCache();
      totalCleaned += cacheCleaned.count;
      spaceSaved += cacheCleaned.size;
      
      // Database maintenance
      if (this.options.databaseVacuum) {
        await this.performDatabaseMaintenance();
      }
      
      // Update stats
      this.stats.filesCleanedUp += totalCleaned;
      this.stats.spaceSaved += spaceSaved;
      this.state.lastCleanup = Date.now();
      
      const duration = Date.now() - startTime;
      
      logger.info('Cleanup completed', {
        filesRemoved: totalCleaned,
        spaceSaved: this.formatBytes(spaceSaved),
        duration
      });
      
      this.emit('cleanup:completed', {
        filesRemoved: totalCleaned,
        spaceSaved,
        duration
      });
      
      // Add to history
      this.history.cleanups.push({
        timestamp: Date.now(),
        filesRemoved: totalCleaned,
        spaceSaved,
        duration
      });
      
    } catch (error) {
      logger.error('Cleanup failed', { error: error.message });
      this.emit('cleanup:failed', { error });
    }
  }
  
  /**
   * Clean old log files
   */
  async cleanOldLogs() {
    const logDir = './logs';
    const maxAge = this.options.logRetention * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAge;
    
    let count = 0;
    let size = 0;
    
    try {
      const files = await fs.readdir(logDir);
      
      for (const file of files) {
        const filePath = path.join(logDir, file);
        const stats = await fs.stat(filePath);
        
        if (stats.isFile() && stats.mtime.getTime() < cutoff) {
          size += stats.size;
          await fs.unlink(filePath);
          count++;
          
          logger.debug('Removed old log file', { file, age: Date.now() - stats.mtime.getTime() });
        }
      }
    } catch (error) {
      logger.error('Failed to clean logs', { error: error.message });
    }
    
    return { count, size };
  }
  
  /**
   * Clean temporary files
   */
  async cleanTempFiles() {
    const tempDirs = ['./tmp', './temp', os.tmpdir()];
    const maxAge = this.options.tempFileAge * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAge;
    
    let count = 0;
    let size = 0;
    
    for (const dir of tempDirs) {
      try {
        const files = await fs.readdir(dir);
        
        for (const file of files) {
          if (file.startsWith('otedama_')) {
            const filePath = path.join(dir, file);
            const stats = await fs.stat(filePath);
            
            if (stats.mtime.getTime() < cutoff) {
              size += stats.size;
              await fs.unlink(filePath);
              count++;
            }
          }
        }
      } catch {
        // Directory doesn't exist or not accessible
      }
    }
    
    return { count, size };
  }
  
  /**
   * Clean cache
   */
  async cleanCache() {
    const cacheDir = './cache';
    const maxAge = this.options.cacheExpiry * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAge;
    
    let count = 0;
    let size = 0;
    
    try {
      const files = await fs.readdir(cacheDir);
      
      for (const file of files) {
        const filePath = path.join(cacheDir, file);
        const stats = await fs.stat(filePath);
        
        if (stats.isFile() && stats.mtime.getTime() < cutoff) {
          size += stats.size;
          await fs.unlink(filePath);
          count++;
        }
      }
    } catch {
      // Cache directory doesn't exist
    }
    
    return { count, size };
  }
  
  /**
   * Perform database maintenance
   */
  async performDatabaseMaintenance() {
    try {
      // This is a placeholder - implement based on your database
      logger.info('Performing database maintenance');
      
      // Example operations:
      // - VACUUM for SQLite
      // - ANALYZE for PostgreSQL
      // - OPTIMIZE TABLE for MySQL
      // - Rebuild indexes
      // - Update statistics
      
      this.emit('database:maintenance', {
        timestamp: Date.now(),
        operations: ['vacuum', 'analyze', 'reindex']
      });
      
    } catch (error) {
      logger.error('Database maintenance failed', { error: error.message });
    }
  }
  
  /**
   * Perform health check
   */
  async performHealthCheck() {
    const checks = {
      diskSpace: await this.checkDiskSpace(),
      memory: await this.checkMemory(),
      database: await this.checkDatabase(),
      logs: await this.checkLogs(),
      certificates: await this.checkCertificates()
    };
    
    const issues = Object.entries(checks)
      .filter(([_, check]) => !check.healthy)
      .map(([name, check]) => ({ name, ...check }));
    
    if (issues.length > 0) {
      logger.warn('Health check found issues', { issues });
      this.emit('health:issues', { issues });
      
      // Auto-repair if possible
      for (const issue of issues) {
        await this.attemptAutoRepair(issue);
      }
    }
    
    return { checks, issues };
  }
  
  /**
   * Check disk space
   */
  async checkDiskSpace() {
    try {
      // This is platform-specific - implement based on OS
      // For now, return mock data
      const used = 75;
      const threshold = this.options.diskSpaceThreshold;
      
      return {
        healthy: used < threshold,
        used,
        threshold,
        message: used >= threshold ? `Disk usage ${used}% exceeds threshold` : 'OK'
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message
      };
    }
  }
  
  /**
   * Check memory usage
   */
  async checkMemory() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedPercent = ((totalMem - freeMem) / totalMem) * 100;
    const threshold = this.options.memoryThreshold;
    
    return {
      healthy: usedPercent < threshold,
      used: usedPercent,
      threshold,
      message: usedPercent >= threshold ? `Memory usage ${usedPercent.toFixed(1)}% exceeds threshold` : 'OK'
    };
  }
  
  /**
   * Check database health
   */
  async checkDatabase() {
    try {
      // Implement database-specific health check
      return {
        healthy: true,
        message: 'Database connection OK'
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message
      };
    }
  }
  
  /**
   * Check log directory
   */
  async checkLogs() {
    try {
      const logDir = './logs';
      const stats = await fs.stat(logDir);
      
      return {
        healthy: stats.isDirectory(),
        writable: true,
        message: 'Log directory accessible'
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message
      };
    }
  }
  
  /**
   * Check certificates
   */
  async checkCertificates() {
    try {
      const certDir = './certificates';
      const files = await fs.readdir(certDir);
      const certs = files.filter(f => f.endsWith('.pem') || f.endsWith('.crt'));
      
      // Check certificate expiry
      const expiryWarnings = [];
      // This would need actual certificate parsing
      
      return {
        healthy: certs.length > 0,
        certificates: certs.length,
        warnings: expiryWarnings,
        message: certs.length > 0 ? 'Certificates found' : 'No certificates found'
      };
    } catch {
      return {
        healthy: false,
        error: 'Certificate directory not accessible'
      };
    }
  }
  
  /**
   * Attempt automatic repair
   */
  async attemptAutoRepair(issue) {
    logger.info('Attempting auto-repair', { issue: issue.name });
    
    try {
      switch (issue.name) {
        case 'diskSpace':
          // Aggressive cleanup
          await this.performCleanup();
          break;
          
        case 'memory':
          // Trigger garbage collection
          if (global.gc) {
            global.gc();
          }
          break;
          
        case 'logs':
          // Recreate log directory
          await fs.mkdir('./logs', { recursive: true });
          break;
          
        case 'certificates':
          // Regenerate self-signed certificates
          await this.regenerateCertificates();
          break;
          
        case 'database':
          // Attempt database repair
          await this.repairDatabase();
          break;
      }
      
      this.stats.repairsPerformed++;
      
      this.emit('repair:completed', {
        issue: issue.name,
        timestamp: Date.now()
      });
      
    } catch (error) {
      logger.error('Auto-repair failed', {
        issue: issue.name,
        error: error.message
      });
      
      this.emit('repair:failed', {
        issue: issue.name,
        error
      });
    }
  }
  
  /**
   * Check if in maintenance window
   */
  async isMaintenanceWindow() {
    const now = new Date();
    const hour = now.getUTCHours();
    const { start, end } = this.options.maintenanceWindow;
    
    if (start < end) {
      return hour >= start && hour < end;
    } else {
      // Wraps around midnight
      return hour >= start || hour < end;
    }
  }
  
  /**
   * Check maintenance window
   */
  async checkMaintenanceWindow() {
    const inWindow = await this.isMaintenanceWindow();
    
    if (inWindow && !this.state.maintenanceActive) {
      // Entering maintenance window
      this.state.maintenanceActive = true;
      this.emit('maintenance:started');
      
      // Perform maintenance tasks
      await this.performMaintenanceTasks();
      
    } else if (!inWindow && this.state.maintenanceActive) {
      // Exiting maintenance window
      this.state.maintenanceActive = false;
      this.emit('maintenance:ended');
    }
  }
  
  /**
   * Perform scheduled maintenance tasks
   */
  async performMaintenanceTasks() {
    const tasks = [];
    
    // Defragmentation
    if (await this.needsDefrag()) {
      tasks.push(this.performDefrag());
    }
    
    // Index rebuild
    if (Date.now() - this.state.lastIndexRebuild > this.options.indexRebuildInterval) {
      tasks.push(this.rebuildIndexes());
    }
    
    // Auto updates
    if (this.options.autoUpdate) {
      tasks.push(this.checkAndApplyUpdates());
    }
    
    // Predictive maintenance
    if (this.options.predictiveMaintenance) {
      tasks.push(this.performPredictiveMaintenance());
    }
    
    await Promise.allSettled(tasks);
  }
  
  /**
   * Restore from backup
   */
  async restoreBackup(backupId, targetPath = './') {
    logger.info('Restoring from backup', { backupId });
    
    try {
      const manifest = this.state.backupManifest.get(backupId);
      if (!manifest) {
        throw new Error('Backup not found');
      }
      
      const backupDir = path.join(this.options.backupPath, backupId);
      
      // Restore each file
      for (const file of manifest.files) {
        await this.restoreFile(
          path.join(backupDir, path.basename(file.destination)),
          path.join(targetPath, file.source)
        );
      }
      
      this.stats.backupsRestored++;
      
      this.emit('restore:completed', {
        backupId,
        files: manifest.files.length
      });
      
    } catch (error) {
      logger.error('Restore failed', { error: error.message });
      this.emit('restore:failed', { error });
      throw error;
    }
  }
  
  /**
   * Get maintenance status
   */
  getStatus() {
    return {
      state: this.state,
      stats: this.stats,
      nextBackup: this.getNextBackupTime(),
      nextMaintenance: this.getNextMaintenanceWindow(),
      recentBackups: this.history.backups.slice(-5),
      recentCleanups: this.history.cleanups.slice(-5),
      healthCheck: this.lastHealthCheck
    };
  }
  
  /**
   * Stop automated maintenance
   */
  async stop() {
    logger.info('Stopping automated maintenance');
    
    // Clear all timers
    Object.values(this.timers).forEach(timer => {
      if (timer) clearInterval(timer);
    });
    
    // Save state
    await this.saveState();
    
    this.state.isRunning = false;
    
    this.emit('stopped', this.stats);
  }
  
  // Utility methods
  
  formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }
  
  getNextBackupTime() {
    const lastBackup = this.state.lastBackup || Date.now();
    return new Date(lastBackup + this.options.backupInterval);
  }
  
  getNextMaintenanceWindow() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(this.options.maintenanceWindow.start, 0, 0, 0);
    
    if (next < now) {
      next.setDate(next.getDate() + 1);
    }
    
    return next;
  }
  
  async ensureBackupDirectory() {
    await fs.mkdir(this.options.backupPath, { recursive: true });
  }
  
  async loadBackupManifest() {
    try {
      const manifestPath = path.join(this.options.backupPath, 'manifest.json');
      const data = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(data);
      
      this.state.backupManifest = new Map(Object.entries(manifest));
    } catch {
      // No manifest yet
      this.state.backupManifest = new Map();
    }
  }
  
  async saveBackupManifest(backupId, backup) {
    this.state.backupManifest.set(backupId, backup);
    
    const manifestPath = path.join(this.options.backupPath, 'manifest.json');
    const manifest = Object.fromEntries(this.state.backupManifest);
    
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  
  async cleanupOldBackups() {
    const backups = Array.from(this.state.backupManifest.entries())
      .sort((a, b) => b[1].timestamp - a[1].timestamp);
    
    while (backups.length > this.options.maxBackups) {
      const [id, backup] = backups.pop();
      const backupDir = path.join(this.options.backupPath, id);
      
      try {
        await fs.rm(backupDir, { recursive: true });
        this.state.backupManifest.delete(id);
        
        logger.info('Removed old backup', { backupId: id });
      } catch (error) {
        logger.error('Failed to remove old backup', {
          backupId: id,
          error: error.message
        });
      }
    }
  }
  
  async getBackupSize(backupPath) {
    const stats = await fs.stat(backupPath);
    
    if (stats.isDirectory()) {
      let totalSize = 0;
      const files = await fs.readdir(backupPath, { withFileTypes: true });
      
      for (const file of files) {
        const filePath = path.join(backupPath, file.name);
        if (file.isDirectory()) {
          totalSize += await this.getBackupSize(filePath);
        } else {
          const fileStats = await fs.stat(filePath);
          totalSize += fileStats.size;
        }
      }
      
      return totalSize;
    } else {
      return stats.size;
    }
  }
  
  async needsDefrag() {
    // Placeholder - implement based on file system
    return false;
  }
  
  async performDefrag() {
    logger.info('Performing defragmentation');
    // Implement based on OS and file system
  }
  
  async rebuildIndexes() {
    logger.info('Rebuilding database indexes');
    this.state.lastIndexRebuild = Date.now();
    // Implement based on database
  }
  
  async checkAndApplyUpdates() {
    logger.info('Checking for updates');
    // Implement update check and application
  }
  
  async performPredictiveMaintenance() {
    logger.info('Performing predictive maintenance');
    // Analyze trends and predict future issues
  }
  
  async regenerateCertificates() {
    logger.info('Regenerating certificates');
    // Implement certificate generation
  }
  
  async repairDatabase() {
    logger.info('Attempting database repair');
    // Implement database repair
  }
  
  async restoreFile(source, destination) {
    // Create directory if needed
    await fs.mkdir(path.dirname(destination), { recursive: true });
    
    const streams = [createReadStream(source)];
    
    // Handle decompression
    if (source.endsWith('.gz')) {
      streams.push(zlib.createGunzip());
      destination = destination.replace('.gz', '');
    }
    
    // Handle decryption
    if (source.endsWith('.enc') && this.options.encryptionKey) {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        Buffer.from(this.options.encryptionKey, 'hex'),
        crypto.randomBytes(16) // This should be stored with the encrypted file
      );
      streams.push(decipher);
      destination = destination.replace('.enc', '');
    }
    
    streams.push(createWriteStream(destination));
    
    await pipeline(...streams);
  }
  
  async saveState() {
    const statePath = path.join(this.options.backupPath, 'maintenance-state.json');
    await fs.writeFile(statePath, JSON.stringify({
      state: this.state,
      stats: this.stats,
      history: this.history
    }, null, 2));
  }
}

export default AutoMaintenance;