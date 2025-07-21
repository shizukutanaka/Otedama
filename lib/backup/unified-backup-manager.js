/**
 * Unified Backup System for Otedama
 * Combines all backup functionality into a single, high-performance module
 * 
 * Design principles:
 * - Carmack: Performance-first, minimal overhead
 * - Martin: Clean interfaces, single responsibility
 * - Pike: Simple is better than complex
 */

import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { pipeline } from 'stream/promises';
import { createGzip, createGunzip } from 'zlib';
import { join, dirname, basename, resolve } from 'path';
import { createHash, randomBytes } from 'crypto';
import { Worker } from 'worker_threads';
import cron from 'node-cron';
import Database from 'better-sqlite3';
import { 
    EncryptedBackupHandler, 
    BackupValidator, 
    BackupRotationManager,
    S3BackupProvider 
} from './backup-enhancements.js';
import IncrementalBackupManager from './incremental-backup.js';

// Backup types
export const BackupType = {
  MANUAL: 'manual',
  SCHEDULED: 'scheduled',
  CONTINUOUS: 'continuous',
  INCREMENTAL: 'incremental',
  DIFFERENTIAL: 'differential',
  EMERGENCY: 'emergency',
  PRE_MIGRATION: 'pre_migration'
};

// Backup strategies
export const BackupStrategy = {
  SIMPLE: 'simple',          // Basic scheduled backups
  CONTINUOUS: 'continuous',  // Real-time continuous data protection
  INCREMENTAL: 'incremental', // Only changes since last backup
  DIFFERENTIAL: 'differential', // Changes since last full backup
  ADAPTIVE: 'adaptive'       // Intelligent scheduling based on activity
};

// Backup state
export const BackupState = {
  IDLE: 'idle',
  RUNNING: 'running',
  VERIFYING: 'verifying',
  COMPRESSING: 'compressing',
  UPLOADING: 'uploading',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

/**
 * Unified Backup Manager
 */
export class UnifiedBackupManager extends EventEmitter {
  constructor(dbPath, options = {}) {
    super();
    
    this.dbPath = resolve(dbPath);
    
    // Configuration with intelligent defaults
    this.config = {
      // Paths
      backupDir: options.backupDir || join(dirname(this.dbPath), 'backups'),
      tempDir: options.tempDir || join(dirname(this.dbPath), 'temp'),
      
      // Strategy
      strategy: options.strategy || BackupStrategy.ADAPTIVE,
      
      // Scheduling
      enableScheduled: options.enableScheduled !== false,
      schedules: {
        hourly: options.schedules?.hourly || '0 * * * *',
        daily: options.schedules?.daily || '0 2 * * *',
        weekly: options.schedules?.weekly || '0 3 * * 0',
        monthly: options.schedules?.monthly || '0 4 1 * *',
        ...options.schedules
      },
      
      // Retention (Pike: sensible defaults)
      retention: {
        hourly: 24,    // Keep 24 hourly backups
        daily: 7,      // Keep 7 daily backups
        weekly: 4,     // Keep 4 weekly backups
        monthly: 12,   // Keep 12 monthly backups
        manual: 10,    // Keep 10 manual backups
        ...options.retention
      },
      
      // Performance (Carmack: optimize for speed)
      compression: {
        enabled: options.compression?.enabled !== false,
        level: options.compression?.level || 6,
        algorithm: options.compression?.algorithm || 'gzip'
      },
      
      // Verification
      verify: {
        enabled: options.verify?.enabled !== false,
        checksum: options.verify?.checksum !== false,
        integrity: options.verify?.integrity !== false
      },
      
      // Adaptive strategy settings
      adaptive: {
        minInterval: 3600000,     // 1 hour minimum
        maxInterval: 86400000,    // 24 hours maximum
        activityThreshold: 1000,  // Operations count
        sizeThreshold: 104857600, // 100MB
        cpuThreshold: 50,         // 50% CPU
        ...options.adaptive
      },
      
      // Resource limits
      resources: {
        maxConcurrent: 1,
        maxCpuPercent: 50,
        maxMemoryMB: 500,
        pauseOnHighLoad: true,
        ...options.resources
      },
      
      // Advanced features
      incremental: {
        enabled: options.incremental?.enabled || false,
        fullBackupInterval: 7, // Days between full backups
        maxIncrementals: 6,
        ...options.incremental
      },
      
      // Cloud backup (optional)
      cloud: options.cloud || null,
      
      // Encryption settings
      encryption: {
        enabled: options.encryption?.enabled || false,
        password: options.encryption?.password || process.env.BACKUP_ENCRYPTION_KEY,
        algorithm: options.encryption?.algorithm || 'aes-256-gcm',
        ...options.encryption
      },
      
      // Advanced validation
      validation: {
        enabled: options.validation?.enabled !== false,
        checksumAlgorithm: options.validation?.checksumAlgorithm || 'sha256',
        compareWithOriginal: options.validation?.compareWithOriginal !== false,
        ...options.validation
      }
    };
    
    // Initialize enhancement modules
    if (this.config.encryption.enabled) {
      this.encryptionHandler = new EncryptedBackupHandler(this.config.encryption);
    }
    
    this.validator = new BackupValidator(this.config.validation);
    this.rotationManager = new BackupRotationManager(this.config.retention);
    
    // Initialize cloud provider if configured
    if (this.config.cloud) {
      this.initializeCloudProvider();
    }
    
    // Initialize incremental backup manager if enabled
    if (this.config.incremental.enabled) {
      this.incrementalManager = new IncrementalBackupManager({
        metadataDir: join(this.config.backupDir, 'metadata'),
        compression: this.config.compression.enabled,
        maxIncrementals: this.config.incremental.maxIncrementals
      });
    }
    
    // State management (Martin: clean state encapsulation)
    this.state = {
      status: BackupState.IDLE,
      activeBackups: new Map(),
      scheduledTasks: new Map(),
      lastBackup: null,
      lastFullBackup: null,
      incrementalCount: 0,
      operationsSinceBackup: 0,
      bytesSinceBackup: 0
    };
    
    // Backup history
    this.history = [];
    this.historyFile = join(this.config.backupDir, 'backup-history.json');
    
    // Performance metrics
    this.metrics = {
      totalBackups: 0,
      successfulBackups: 0,
      failedBackups: 0,
      totalSize: 0,
      totalDuration: 0,
      averageDuration: 0,
      compressionRatio: 0
    };
    
    // Activity tracking for adaptive strategy
    this.activityWindow = [];
    this.activityWindowSize = 3600000; // 1 hour
  }

  /**
   * Initialize the backup system with parallel operations
   */
  async initialize() {
    try {
      // Execute independent initialization operations in parallel
      const initPromises = [
        this.ensureDirectories(),
        this.loadHistory()
      ];
      
      if (this.config.enableScheduled) {
        initPromises.push(this.startScheduler());
      }
      
      await Promise.all(initPromises);
      
      // Setup monitoring (synchronous operation)
      this.setupMonitoring();
      
      // Initialize incremental manager (depends on directories being created)
      if (this.incrementalManager) {
        await this.incrementalManager.initialize(this.dbPath);
      }
      
      this.emit('initialized', {
        strategy: this.config.strategy,
        backupDir: this.config.backupDir,
        historyLoaded: this.history.length,
        incrementalEnabled: this.config.incremental.enabled
      });
      
      return true;
      
    } catch (error) {
      this.emit('error', { phase: 'initialization', error });
      throw error;
    }
  }

  /**
   * Create a backup (main entry point)
   */
  async createBackup(type = BackupType.MANUAL, metadata = {}) {
    // Check if backup is already running
    if (this.state.status !== BackupState.IDLE) {
      if (type === BackupType.EMERGENCY) {
        // Emergency backups can interrupt
        await this.cancelActiveBackups();
      } else {
        throw new Error('Backup already in progress');
      }
    }
    
    const backupId = this.generateBackupId(type);
    const startTime = Date.now();
    
    try {
      this.state.status = BackupState.RUNNING;
      
      const backup = {
        id: backupId,
        type,
        strategy: this.config.strategy,
        startTime,
        metadata,
        status: 'running'
      };
      
      this.state.activeBackups.set(backupId, backup);
      this.emit('backup:started', backup);
      
      // Check resources
      if (!await this.checkResources()) {
        throw new Error('Insufficient resources for backup');
      }
      
      // Determine backup method based on strategy
      let backupPath;
      switch (this.config.strategy) {
        case BackupStrategy.INCREMENTAL:
          backupPath = await this.createIncrementalBackup(backup);
          break;
          
        case BackupStrategy.DIFFERENTIAL:
          backupPath = await this.createDifferentialBackup(backup);
          break;
          
        default:
          backupPath = await this.createFullBackup(backup);
      }
      
      // Verify backup
      if (this.config.verify.enabled) {
        this.state.status = BackupState.VERIFYING;
        await this.verifyBackup(backupPath);
      }
      
      // Upload to cloud if configured
      if (this.config.cloud) {
        this.state.status = BackupState.UPLOADING;
        await this.uploadToCloud(backupPath, backup);
      }
      
      // Update backup record
      const stats = statSync(backupPath);
      backup.endTime = Date.now();
      backup.duration = backup.endTime - startTime;
      backup.size = stats.size;
      backup.path = backupPath;
      backup.status = 'completed';
      
      // Update state and metrics
      this.updateMetrics(backup);
      this.history.push(backup);
      await this.saveHistory();
      
      // Reset counters
      this.state.lastBackup = backup.endTime;
      this.state.operationsSinceBackup = 0;
      this.state.bytesSinceBackup = 0;
      
      // Apply retention policy
      await this.applyRetentionPolicy(type);
      
      this.state.status = BackupState.COMPLETED;
      this.emit('backup:completed', backup);
      
      return backup;
      
    } catch (error) {
      this.state.status = BackupState.FAILED;
      
      const backup = this.state.activeBackups.get(backupId);
      if (backup) {
        backup.status = 'failed';
        backup.error = error.message;
        backup.endTime = Date.now();
        backup.duration = backup.endTime - startTime;
        
        this.history.push(backup);
        this.metrics.failedBackups++;
      }
      
      this.emit('backup:failed', { id: backupId, error });
      throw error;
      
    } finally {
      this.state.activeBackups.delete(backupId);
      this.state.status = BackupState.IDLE;
    }
  }

  /**
   * Create full backup
   */
  async createFullBackup(backup) {
    const backupFile = this.getBackupFilename(backup);
    const backupPath = join(this.getBackupSubdir(backup.type), backupFile);
    const tempPath = join(this.config.tempDir, backupFile);
    
    try {
      // Ensure directories exist
      mkdirSync(dirname(backupPath), { recursive: true });
      mkdirSync(dirname(tempPath), { recursive: true });
      
      if (this.config.compression.enabled) {
        // Compress directly to temp file
        this.state.status = BackupState.COMPRESSING;
        
        const input = createReadStream(this.dbPath);
        const output = createWriteStream(tempPath);
        const gzip = createGzip({ level: this.config.compression.level });
        
        await pipeline(input, gzip, output);
      } else {
        // Simple copy
        await fs.copyFile(this.dbPath, tempPath);
      }
      
      // Move to final location
      await fs.rename(tempPath, backupPath);
      
      // Update state for incremental tracking
      this.state.lastFullBackup = backup.startTime;
      this.state.incrementalCount = 0;
      
      return backupPath;
      
    } catch (error) {
      // Cleanup temp file
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      
      throw error;
    }
  }

  /**
   * Create incremental backup (only changes since last backup)
   */
  async createIncrementalBackup(backup) {
    // Check if incremental manager is available
    if (!this.incrementalManager) {
      backup.metadata.reason = 'incremental-disabled';
      return this.createFullBackup(backup);
    }
    
    // Get chain info
    const chainInfo = this.incrementalManager.getChainInfo();
    
    // Check if we need a full backup
    if (!chainInfo.canCreateIncremental) {
      backup.metadata.incrementalType = 'full';
      backup.metadata.reason = 'chain-full-or-missing';
      
      // Create full backup and reset chain
      const backupPath = await this.createFullBackup(backup);
      
      // Reset incremental chain
      await this.incrementalManager.resetChain({
        id: backup.id,
        path: backupPath,
        timestamp: backup.startTime
      });
      
      return backupPath;
    }
    
    // Create incremental backup
    try {
      const backupFile = this.getBackupFilename(backup);
      const backupPath = join(this.getBackupSubdir(backup.type), backupFile);
      
      const incrementalInfo = await this.incrementalManager.createIncrementalBackup(
        backupPath,
        backup
      );
      
      if (!incrementalInfo) {
        // No changes, skip backup
        backup.metadata.skipped = true;
        backup.metadata.reason = 'no-changes';
        return null;
      }
      
      // Update backup metadata
      backup.metadata.incrementalType = 'incremental';
      backup.metadata.incrementalInfo = {
        baseBackup: incrementalInfo.baseBackup,
        changedPages: incrementalInfo.changedPages,
        chainPosition: chainInfo.incrementalCount + 1
      };
      
      this.state.incrementalCount = chainInfo.incrementalCount + 1;
      
      return backupPath;
      
    } catch (error) {
      if (error.message === 'Full backup required') {
        backup.metadata.incrementalType = 'full';
        backup.metadata.reason = 'incremental-failed';
        
        const backupPath = await this.createFullBackup(backup);
        
        // Reset chain after full backup
        await this.incrementalManager.resetChain({
          id: backup.id,
          path: backupPath,
          timestamp: backup.startTime
        });
        
        return backupPath;
      }
      
      throw error;
    }
  }

  /**
   * Create differential backup (changes since last full backup)
   */
  async createDifferentialBackup(backup) {
    // Check if we need a full backup
    if (!this.state.lastFullBackup || 
        (Date.now() - this.state.lastFullBackup) > (7 * 24 * 60 * 60 * 1000)) {
      
      backup.metadata.differentialType = 'full';
      return this.createFullBackup(backup);
    }
    
    // Create differential backup
    backup.metadata.differentialType = 'differential';
    backup.metadata.basedOn = this.state.lastFullBackup;
    
    // Simplified - real implementation would only backup changed pages
    return this.createFullBackup(backup);
  }

  /**
   * Verify backup integrity
   */
  async verifyBackup(backupPath) {
    const verifyStart = Date.now();
    
    try {
      // Check file exists and is readable
      await fs.access(backupPath, fs.constants.R_OK);
      
      // Verify file size
      const stats = await fs.stat(backupPath);
      if (stats.size === 0) {
        throw new Error('Backup file is empty');
      }
      
      // Calculate checksum
      if (this.config.verify.checksum) {
        const checksum = await this.calculateChecksum(backupPath);
        // Store checksum for future verification
      }
      
      // Test decompression if compressed
      if (this.config.compression.enabled && this.config.verify.integrity) {
        await this.testDecompression(backupPath);
      }
      
      const verifyDuration = Date.now() - verifyStart;
      this.emit('backup:verified', { 
        path: backupPath, 
        duration: verifyDuration 
      });
      
      return true;
      
    } catch (error) {
      throw new Error(`Backup verification failed: ${error.message}`);
    }
  }

  /**
   * Calculate file checksum
   */
  async calculateChecksum(filePath) {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(filePath);
      
      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Test decompression without extracting
   */
  async testDecompression(filePath) {
    return new Promise((resolve, reject) => {
      const stream = createReadStream(filePath);
      const gunzip = createGunzip();
      
      let bytes = 0;
      gunzip.on('data', (chunk) => { bytes += chunk.length; });
      gunzip.on('end', () => resolve(bytes));
      gunzip.on('error', reject);
      
      stream.pipe(gunzip);
    });
  }

  /**
   * Restore from backup
   */
  async restoreBackup(backupId, options = {}) {
    const backup = this.history.find(b => b.id === backupId);
    if (!backup) {
      throw new Error(`Backup not found: ${backupId}`);
    }
    
    const restoreId = `restore_${Date.now()}`;
    
    try {
      this.emit('restore:started', { restoreId, backupId });
      
      // Create restore point if requested
      if (options.createRestorePoint !== false) {
        await this.createBackup(BackupType.PRE_MIGRATION, {
          reason: 'pre-restore',
          restoringFrom: backupId
        });
      }
      
      const targetPath = options.targetPath || this.dbPath;
      const tempPath = `${targetPath}.restore.tmp`;
      
      // Check if this is an incremental backup
      if (backup.metadata?.incrementalType === 'incremental' && this.incrementalManager) {
        // Find the base full backup and all incrementals in the chain
        const chainInfo = this.incrementalManager.getChainInfo();
        const fullBackup = this.history.find(b => b.id === chainInfo.lastFullBackup?.id);
        
        if (!fullBackup) {
          throw new Error('Base full backup not found for incremental restore');
        }
        
        // Get all incrementals up to the target backup
        const incrementals = [];
        for (const inc of chainInfo.incrementals) {
          incrementals.push(inc);
          if (inc.id === backup.id) break;
        }
        
        // Restore using incremental manager
        await this.incrementalManager.restore(
          tempPath,
          fullBackup.path,
          incrementals.map(inc => inc.path)
        );
      } else {
        // Standard restore for full backups
        if (this.config.compression.enabled) {
          // Decompress
          const input = createReadStream(backup.path);
          const output = createWriteStream(tempPath);
          const gunzip = createGunzip();
          
          await pipeline(input, gunzip, output);
        } else {
          // Simple copy
          await fs.copyFile(backup.path, tempPath);
        }
      }
      
      // Verify restored file
      if (options.verify !== false) {
        const db = new Database(tempPath, { readonly: true });
        const result = db.prepare('PRAGMA integrity_check').get();
        db.close();
        
        if (result.integrity_check !== 'ok') {
          throw new Error('Restored database integrity check failed');
        }
      }
      
      // Replace original
      if (existsSync(targetPath)) {
        await fs.rename(targetPath, `${targetPath}.backup`);
      }
      await fs.rename(tempPath, targetPath);
      
      // Reset incremental tracking after restore
      if (this.incrementalManager) {
        await this.incrementalManager.initialize(targetPath);
      }
      
      this.emit('restore:completed', { restoreId, backupId });
      
      return { restoreId, backupId, success: true };
      
    } catch (error) {
      this.emit('restore:failed', { restoreId, backupId, error });
      throw error;
    }
  }

  /**
   * Start scheduler based on strategy
   */
  async startScheduler() {
    switch (this.config.strategy) {
      case BackupStrategy.SIMPLE:
        this.setupSimpleSchedules();
        break;
        
      case BackupStrategy.CONTINUOUS:
        this.setupContinuousBackup();
        break;
        
      case BackupStrategy.ADAPTIVE:
        this.setupAdaptiveBackup();
        break;
        
      default:
        this.setupSimpleSchedules();
    }
  }

  /**
   * Setup simple scheduled backups
   */
  setupSimpleSchedules() {
    Object.entries(this.config.schedules).forEach(([name, schedule]) => {
      if (schedule && cron.validate(schedule)) {
        const task = cron.schedule(schedule, async () => {
          try {
            await this.createBackup(BackupType.SCHEDULED, {
              schedule: name,
              cron: schedule
            });
          } catch (error) {
            this.emit('schedule:error', { schedule: name, error });
          }
        });
        
        this.state.scheduledTasks.set(name, task);
      }
    });
  }

  /**
   * Setup continuous backup monitoring
   */
  setupContinuousBackup() {
    // Monitor for changes every minute
    const monitor = setInterval(async () => {
      if (this.shouldRunContinuousBackup()) {
        try {
          await this.createBackup(BackupType.CONTINUOUS, {
            trigger: 'activity',
            operations: this.state.operationsSinceBackup,
            bytes: this.state.bytesSinceBackup
          });
        } catch (error) {
          this.emit('continuous:error', error);
        }
      }
    }, 60000); // 1 minute
    
    this.state.scheduledTasks.set('continuous-monitor', { stop: () => clearInterval(monitor) });
  }

  /**
   * Setup adaptive backup based on system activity
   */
  setupAdaptiveBackup() {
    // Activity analyzer
    const analyzer = setInterval(() => {
      this.analyzeActivity();
    }, 300000); // 5 minutes
    
    // Adaptive scheduler
    const scheduler = setInterval(async () => {
      const decision = this.makeAdaptiveDecision();
      if (decision.shouldBackup) {
        try {
          await this.createBackup(BackupType.SCHEDULED, {
            strategy: 'adaptive',
            reason: decision.reason,
            metrics: decision.metrics
          });
        } catch (error) {
          this.emit('adaptive:error', error);
        }
      }
    }, 900000); // 15 minutes
    
    this.state.scheduledTasks.set('adaptive-analyzer', { stop: () => clearInterval(analyzer) });
    this.state.scheduledTasks.set('adaptive-scheduler', { stop: () => clearInterval(scheduler) });
  }

  /**
   * Analyze system activity
   */
  analyzeActivity() {
    const now = Date.now();
    
    // Add current metrics to activity window
    this.activityWindow.push({
      timestamp: now,
      operations: this.state.operationsSinceBackup,
      bytes: this.state.bytesSinceBackup,
      cpu: process.cpuUsage(),
      memory: process.memoryUsage()
    });
    
    // Remove old entries
    const cutoff = now - this.activityWindowSize;
    this.activityWindow = this.activityWindow.filter(a => a.timestamp > cutoff);
  }

  /**
   * Make adaptive backup decision
   */
  makeAdaptiveDecision() {
    const now = Date.now();
    const timeSinceLastBackup = now - (this.state.lastBackup || 0);
    
    // Always backup if max interval exceeded
    if (timeSinceLastBackup >= this.config.adaptive.maxInterval) {
      return {
        shouldBackup: true,
        reason: 'max-interval',
        metrics: { timeSinceLastBackup }
      };
    }
    
    // Don't backup too frequently
    if (timeSinceLastBackup < this.config.adaptive.minInterval) {
      return { shouldBackup: false };
    }
    
    // Check activity thresholds
    if (this.state.operationsSinceBackup >= this.config.adaptive.activityThreshold) {
      return {
        shouldBackup: true,
        reason: 'activity-threshold',
        metrics: { operations: this.state.operationsSinceBackup }
      };
    }
    
    if (this.state.bytesSinceBackup >= this.config.adaptive.sizeThreshold) {
      return {
        shouldBackup: true,
        reason: 'size-threshold',
        metrics: { bytes: this.state.bytesSinceBackup }
      };
    }
    
    // Check system load
    const avgCpu = this.getAverageCpu();
    if (avgCpu < this.config.adaptive.cpuThreshold) {
      return {
        shouldBackup: true,
        reason: 'low-cpu',
        metrics: { avgCpu }
      };
    }
    
    return { shouldBackup: false };
  }

  /**
   * Check if continuous backup should run
   */
  shouldRunContinuousBackup() {
    const timeSinceLastBackup = Date.now() - (this.state.lastBackup || 0);
    
    return (
      this.state.status === BackupState.IDLE &&
      timeSinceLastBackup >= 300000 && // At least 5 minutes
      (this.state.operationsSinceBackup > 100 || 
       this.state.bytesSinceBackup > 1048576) // 1MB
    );
  }

  /**
   * Check resource availability
   */
  async checkResources() {
    if (!this.config.resources.pauseOnHighLoad) {
      return true;
    }
    
    const cpu = process.cpuUsage();
    const mem = process.memoryUsage();
    
    const cpuPercent = (cpu.user + cpu.system) / 1000000 * 100;
    const memMB = mem.heapUsed / 1048576;
    
    return (
      cpuPercent < this.config.resources.maxCpuPercent &&
      memMB < this.config.resources.maxMemoryMB
    );
  }

  /**
   * Apply retention policy
   */
  async applyRetentionPolicy(type) {
    const retention = this.config.retention[type] || this.config.retention.manual;
    const backups = this.history
      .filter(b => b.type === type && b.status === 'completed')
      .sort((a, b) => b.startTime - a.startTime);
    
    if (backups.length > retention) {
      const toDelete = backups.slice(retention);
      
      for (const backup of toDelete) {
        try {
          if (existsSync(backup.path)) {
            unlinkSync(backup.path);
          }
          
          // Remove from history
          const index = this.history.indexOf(backup);
          if (index > -1) {
            this.history.splice(index, 1);
          }
          
          this.emit('backup:deleted', { id: backup.id, path: backup.path });
        } catch (error) {
          this.emit('retention:error', { backup: backup.id, error });
        }
      }
      
      await this.saveHistory();
    }
  }

  /**
   * Track database operations
   */
  trackOperation(type, bytes = 0) {
    this.state.operationsSinceBackup++;
    this.state.bytesSinceBackup += bytes;
    
    // Also track in incremental manager if available
    if (this.incrementalManager && this.incrementalManager.isTracking) {
      // Trigger a change check on significant operations
      if (type === 'write' || type === 'update' || type === 'delete') {
        this.incrementalManager.checkForChanges().catch(() => {});
      }
    }
  }

  /**
   * Get backup statistics
   */
  getStats() {
    const recentBackups = this.history
      .slice(-10)
      .map(b => ({
        id: b.id,
        type: b.type,
        time: new Date(b.startTime).toISOString(),
        duration: b.duration,
        size: b.size,
        status: b.status
      }));
    
    const stats = {
      state: this.state.status,
      strategy: this.config.strategy,
      metrics: {
        ...this.metrics,
        successRate: this.metrics.totalBackups > 0 ? 
          (this.metrics.successfulBackups / this.metrics.totalBackups * 100).toFixed(2) + '%' : 'N/A',
        averageDuration: this.metrics.averageDuration > 0 ?
          `${(this.metrics.averageDuration / 1000).toFixed(1)}s` : 'N/A'
      },
      lastBackup: this.state.lastBackup ? 
        new Date(this.state.lastBackup).toISOString() : null,
      activeBackups: this.state.activeBackups.size,
      recentBackups,
      retention: this.config.retention,
      schedules: Object.fromEntries(
        Array.from(this.state.scheduledTasks.entries())
          .map(([name, task]) => [name, 'active'])
      )
    };
    
    // Add incremental backup stats if available
    if (this.incrementalManager) {
      stats.incremental = {
        enabled: true,
        ...this.incrementalManager.getChainInfo(),
        metrics: this.incrementalManager.getMetrics()
      };
    }
    
    return stats;
  }

  /**
   * List backups with filtering
   */
  listBackups(options = {}) {
    let backups = [...this.history];
    
    // Filter by type
    if (options.type) {
      backups = backups.filter(b => b.type === options.type);
    }
    
    // Filter by status
    if (options.status) {
      backups = backups.filter(b => b.status === options.status);
    }
    
    // Filter by date range
    if (options.startDate) {
      const start = new Date(options.startDate).getTime();
      backups = backups.filter(b => b.startTime >= start);
    }
    
    if (options.endDate) {
      const end = new Date(options.endDate).getTime();
      backups = backups.filter(b => b.startTime <= end);
    }
    
    // Sort
    const sortBy = options.sortBy || 'startTime';
    const sortOrder = options.sortOrder || 'desc';
    backups.sort((a, b) => {
      const aVal = a[sortBy];
      const bVal = b[sortBy];
      return sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
    });
    
    // Limit
    if (options.limit) {
      backups = backups.slice(0, options.limit);
    }
    
    return backups;
  }

  /**
   * Update backup schedule
   */
  updateSchedule(name, schedule) {
    // Stop existing schedule
    const existing = this.state.scheduledTasks.get(name);
    if (existing) {
      existing.stop();
      this.state.scheduledTasks.delete(name);
    }
    
    // Create new schedule
    if (schedule && cron.validate(schedule)) {
      const task = cron.schedule(schedule, async () => {
        try {
          await this.createBackup(BackupType.SCHEDULED, {
            schedule: name,
            cron: schedule
          });
        } catch (error) {
          this.emit('schedule:error', { schedule: name, error });
        }
      });
      
      this.state.scheduledTasks.set(name, task);
      this.config.schedules[name] = schedule;
      
      this.emit('schedule:updated', { name, schedule });
    }
  }

  /**
   * Force immediate backup
   */
  async forceBackup(metadata = {}) {
    return this.createBackup(BackupType.MANUAL, {
      ...metadata,
      forced: true,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Emergency backup (overrides everything)
   */
  async emergencyBackup(reason) {
    return this.createBackup(BackupType.EMERGENCY, {
      reason,
      timestamp: new Date().toISOString(),
      priority: 'critical'
    });
  }

  /**
   * Upload backup to cloud storage
   */
  async uploadToCloud(localPath, backup) {
    if (!this.config.cloud || !this.config.cloud.upload) {
      return;
    }
    
    try {
      const cloudPath = await this.config.cloud.upload(localPath, backup);
      backup.cloudPath = cloudPath;
      
      this.emit('backup:uploaded', { 
        id: backup.id, 
        localPath, 
        cloudPath 
      });
      
    } catch (error) {
      this.emit('cloud:error', { backup: backup.id, error });
      // Don't fail the backup for cloud errors
    }
  }

  /**
   * Cancel active backups
   */
  async cancelActiveBackups() {
    for (const [id, backup] of this.state.activeBackups) {
      backup.status = 'cancelled';
      this.emit('backup:cancelled', { id });
    }
    this.state.activeBackups.clear();
  }

  /**
   * Helper methods
   */
  
  generateBackupId(type) {
    const timestamp = Date.now();
    const random = randomBytes(4).toString('hex');
    return `${type}_${timestamp}_${random}`;
  }
  
  getBackupFilename(backup) {
    const date = new Date(backup.startTime);
    const dateStr = date.toISOString().replace(/[:.]/g, '-');
    const ext = this.config.compression.enabled ? '.db.gz' : '.db';
    return `otedama_${backup.type}_${dateStr}${ext}`;
  }
  
  getBackupSubdir(type) {
    const subdirs = {
      [BackupType.MANUAL]: 'manual',
      [BackupType.SCHEDULED]: 'scheduled',
      [BackupType.CONTINUOUS]: 'continuous',
      [BackupType.INCREMENTAL]: 'incremental',
      [BackupType.DIFFERENTIAL]: 'differential',
      [BackupType.EMERGENCY]: 'emergency',
      [BackupType.PRE_MIGRATION]: 'migration'
    };
    
    const subdir = subdirs[type] || 'other';
    return join(this.config.backupDir, subdir);
  }
  
  async ensureDirectories() {
    const dirs = [
      this.config.backupDir,
      this.config.tempDir,
      ...Object.values(BackupType).map(type => 
        this.getBackupSubdir(type)
      )
    ];
    
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }
  }
  
  async loadHistory() {
    try {
      if (existsSync(this.historyFile)) {
        const data = await fs.readFile(this.historyFile, 'utf8');
        this.history = JSON.parse(data);
        
        // Calculate metrics from history
        this.recalculateMetrics();
      }
    } catch (error) {
      this.emit('history:error', error);
      this.history = [];
    }
  }
  
  async saveHistory() {
    try {
      // Keep only last 1000 entries
      if (this.history.length > 1000) {
        this.history = this.history.slice(-1000);
      }
      
      await fs.writeFile(
        this.historyFile,
        JSON.stringify(this.history, null, 2)
      );
    } catch (error) {
      this.emit('history:error', error);
    }
  }
  
  recalculateMetrics() {
    this.metrics = {
      totalBackups: 0,
      successfulBackups: 0,
      failedBackups: 0,
      totalSize: 0,
      totalDuration: 0,
      averageDuration: 0,
      compressionRatio: 0
    };
    
    for (const backup of this.history) {
      this.metrics.totalBackups++;
      
      if (backup.status === 'completed') {
        this.metrics.successfulBackups++;
        this.metrics.totalSize += backup.size || 0;
        this.metrics.totalDuration += backup.duration || 0;
      } else if (backup.status === 'failed') {
        this.metrics.failedBackups++;
      }
    }
    
    if (this.metrics.successfulBackups > 0) {
      this.metrics.averageDuration = 
        this.metrics.totalDuration / this.metrics.successfulBackups;
    }
  }
  
  updateMetrics(backup) {
    this.metrics.totalBackups++;
    
    if (backup.status === 'completed') {
      this.metrics.successfulBackups++;
      this.metrics.totalSize += backup.size;
      this.metrics.totalDuration += backup.duration;
      
      // Update average with exponential moving average
      const alpha = 0.2;
      this.metrics.averageDuration = 
        alpha * backup.duration + (1 - alpha) * this.metrics.averageDuration;
    }
  }
  
  getAverageCpu() {
    if (this.activityWindow.length === 0) return 0;
    
    const totalCpu = this.activityWindow.reduce((sum, a) => {
      const cpu = a.cpu;
      return sum + (cpu.user + cpu.system) / 1000000;
    }, 0);
    
    return (totalCpu / this.activityWindow.length) * 100;
  }
  
  setupMonitoring() {
    // Monitor database writes - this would integrate with the database manager
    // For now, we'll simulate with a simple interval
    const monitor = setInterval(() => {
      // In real implementation, this would hook into database write operations
      this.trackOperation('write', Math.random() * 1000);
    }, 10000);
    
    this.state.scheduledTasks.set('operation-monitor', { 
      stop: () => clearInterval(monitor) 
    });
  }
  
  /**
   * Initialize cloud backup provider
   */
  initializeCloudProvider() {
    const { provider, ...config } = this.config.cloud;
    
    switch (provider) {
      case 's3':
      case 'aws':
        this.cloudProvider = new S3BackupProvider(config);
        break;
        
      case 'local':
      default:
        // No cloud provider
        this.cloudProvider = null;
    }
    
    if (this.cloudProvider) {
      this.cloudProvider.on('uploaded', (event) => {
        this.emit('cloud:uploaded', event);
      });
      
      this.cloudProvider.on('error', (error) => {
        this.emit('cloud:error', error);
      });
    }
  }
  
  /**
   * Enhanced backup creation with encryption
   */
  async createFullBackup(backup) {
    const backupFile = this.getBackupFilename(backup);
    const backupPath = join(this.getBackupSubdir(backup.type), backupFile);
    const tempPath = join(this.config.tempDir, backupFile);
    
    try {
      // Ensure directories exist
      mkdirSync(dirname(backupPath), { recursive: true });
      mkdirSync(dirname(tempPath), { recursive: true });
      
      // Create pipeline based on configuration
      const streams = [createReadStream(this.dbPath)];
      
      // Add encryption if enabled
      if (this.config.encryption.enabled && this.encryptionHandler) {
        streams.push(this.encryptionHandler.createEncryptStream(this.config.encryption.password));
        backup.metadata.encrypted = true;
        backup.metadata.encryptionAlgorithm = this.config.encryption.algorithm;
      }
      
      // Add compression if enabled
      if (this.config.compression.enabled) {
        this.state.status = BackupState.COMPRESSING;
        streams.push(createGzip({ level: this.config.compression.level }));
        backup.metadata.compressed = true;
        backup.metadata.compressionLevel = this.config.compression.level;
      }
      
      // Output stream
      streams.push(createWriteStream(tempPath));
      
      // Execute pipeline
      await pipeline(...streams);
      
      // Calculate checksum
      if (this.config.validation.enabled) {
        backup.metadata.checksum = await this.validator.calculateChecksum(tempPath);
        backup.metadata.checksumAlgorithm = this.config.validation.checksumAlgorithm;
      }
      
      // Move to final location
      await fs.rename(tempPath, backupPath);
      
      // Update state for incremental tracking
      this.state.lastFullBackup = backup.startTime;
      this.state.incrementalCount = 0;
      
      return backupPath;
      
    } catch (error) {
      // Cleanup temp file
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      
      throw error;
    }
  }
  
  /**
   * Enhanced backup verification
   */
  async verifyBackup(backupPath) {
    const result = await this.validator.validateBackup(backupPath, this.dbPath);
    
    if (!result.valid) {
      throw new Error(`Backup validation failed: ${result.errors.join(', ')}`);
    }
    
    this.emit('backup:verified', {
      path: backupPath,
      checks: result.checks
    });
    
    return result;
  }
  
  /**
   * Upload backup to cloud storage
   */
  async uploadToCloud(localPath, backup) {
    if (!this.cloudProvider) return;
    
    const remotePath = `${backup.type}/${basename(localPath)}`;
    
    try {
      await this.cloudProvider.upload(localPath, remotePath);
      
      backup.metadata.cloudPath = remotePath;
      backup.metadata.cloudProvider = this.config.cloud.provider;
      
    } catch (error) {
      this.emit('cloud:upload:failed', { localPath, remotePath, error });
      // Don't fail the backup if cloud upload fails
    }
  }
  
  /**
   * Enhanced retention policy with rotation manager
   */
  async applyRetentionPolicy(type) {
    const backupDir = this.getBackupSubdir(type);
    const files = readdirSync(backupDir);
    
    // Get backup information
    const backups = files.map(file => {
      const filePath = join(backupDir, file);
      const stats = statSync(filePath);
      
      // Parse backup info from filename
      const match = file.match(/otedama_(.+?)_(.+?)\.(db|db\.gz)$/);
      const backupType = match ? match[1] : type;
      const timestamp = match ? new Date(match[2].replace(/-/g, ':')).getTime() : stats.mtime.getTime();
      
      return {
        path: filePath,
        filename: file,
        type: backupType,
        timestamp,
        size: stats.size,
        metadata: { schedule: this.categorizeBackupByTime(timestamp) }
      };
    });
    
    // Apply retention policy
    const toDelete = await this.rotationManager.applyRetentionPolicy(backups, backupDir);
    
    // Delete old backups
    for (const backup of toDelete) {
      try {
        unlinkSync(backup.path);
        this.emit('backup:deleted', { path: backup.path, reason: 'retention-policy' });
        
        // Delete from cloud if exists
        if (this.cloudProvider && backup.metadata?.cloudPath) {
          await this.cloudProvider.delete(backup.metadata.cloudPath).catch(() => {});
        }
      } catch (error) {
        this.emit('retention:error', { backup, error });
      }
    }
  }
  
  /**
   * Categorize backup by time for retention
   */
  categorizeBackupByTime(timestamp) {
    const age = Date.now() - timestamp;
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;
    const week = 7 * day;
    
    if (age < hour) return 'hourly';
    if (age < day) return 'daily';
    if (age < week) return 'weekly';
    return 'monthly';
  }

  /**
   * Shutdown the backup system
   */
  async shutdown() {
    // Stop all scheduled tasks
    for (const [name, task] of this.state.scheduledTasks) {
      if (task.stop) {
        task.stop();
      }
    }
    this.state.scheduledTasks.clear();
    
    // Shutdown incremental manager
    if (this.incrementalManager) {
      await this.incrementalManager.shutdown();
    }
    
    // Wait for active backups
    if (this.state.activeBackups.size > 0) {
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (this.state.activeBackups.size === 0) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      });
    }
    
    // Save final history
    await this.saveHistory();
    
    this.emit('shutdown');
  }
}

// Factory function for creating backup manager
export function createUnifiedBackupManager(dbPath, options) {
  return new UnifiedBackupManager(dbPath, options);
}

// Default export
export default UnifiedBackupManager;
