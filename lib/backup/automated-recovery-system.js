/**
 * Automated Recovery System for Otedama
 * Intelligent disaster recovery with zero-downtime restoration
 * 
 * Design:
 * - Carmack: Fast recovery with minimal downtime
 * - Martin: Clean recovery architecture
 * - Pike: Simple recovery process
 */

import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { createReadStream, createWriteStream } from 'fs';
import { join, dirname, basename } from 'path';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { createHash } from 'crypto';
import tar from 'tar';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createStructuredLogger } from '../core/structured-logger.js';
import { AutomaticBackupSystem } from './automatic-backup-system.js';

const logger = createStructuredLogger('AutomatedRecoverySystem');

/**
 * Recovery modes
 */
export const RecoveryMode = {
  FULL: 'full',           // Complete system restore
  PARTIAL: 'partial',     // Selective restore
  ROLLBACK: 'rollback',   // Rollback to previous state
  FAILOVER: 'failover',   // Switch to backup system
  REPAIR: 'repair'        // Fix corrupted data
};

/**
 * Recovery status
 */
export const RecoveryStatus = {
  IDLE: 'idle',
  ANALYZING: 'analyzing',
  PREPARING: 'preparing',
  RECOVERING: 'recovering',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

/**
 * Recovery point types
 */
export const RecoveryPointType = {
  AUTOMATIC: 'automatic',  // Scheduled backup
  MANUAL: 'manual',        // User-triggered backup
  CHECKPOINT: 'checkpoint', // System checkpoint
  SNAPSHOT: 'snapshot'     // Volume snapshot
};

export class AutomatedRecoverySystem extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Recovery settings
      recoveryPath: config.recoveryPath || './recovery',
      tempPath: config.tempPath || './temp/recovery',
      backupPath: config.backupPath || './backups',
      
      // Recovery options
      autoRecovery: config.autoRecovery !== false,
      verifyAfterRecovery: config.verifyAfterRecovery !== false,
      preserveCurrentData: config.preserveCurrentData || true,
      parallelRestore: config.parallelRestore || 4,
      
      // Health check settings
      healthCheckInterval: config.healthCheckInterval || 60000, // 1 minute
      healthCheckRetries: config.healthCheckRetries || 3,
      recoveryThreshold: config.recoveryThreshold || {
        corruption: 0.05,  // 5% corruption triggers recovery
        missing: 0.10,     // 10% missing data triggers recovery
        errors: 100        // 100 errors trigger recovery
      },
      
      // Recovery points
      maxRecoveryPoints: config.maxRecoveryPoints || 10,
      recoveryPointInterval: config.recoveryPointInterval || 3600000, // 1 hour
      
      // Cloud settings (inherit from backup system)
      s3: config.s3 || {
        region: process.env.AWS_REGION || 'us-east-1',
        bucket: process.env.BACKUP_BUCKET || 'otedama-backups',
        prefix: process.env.BACKUP_PREFIX || 'backups/'
      },
      
      ...config
    };
    
    // State management
    this.status = RecoveryStatus.IDLE;
    this.recoveryPoints = [];
    this.activeRecovery = null;
    this.healthStatus = {
      healthy: true,
      lastCheck: null,
      issues: []
    };
    
    // Cloud clients
    this.s3Client = null;
    
    // Statistics
    this.stats = {
      totalRecoveries: 0,
      successfulRecoveries: 0,
      failedRecoveries: 0,
      lastRecoveryTime: null,
      averageRecoveryTime: 0
    };
    
    // Recovery queue
    this.recoveryQueue = [];
    
    // Health check timer
    this.healthCheckTimer = null;
  }
  
  /**
   * Initialize recovery system
   */
  async initialize() {
    logger.info('Initializing automated recovery system');
    
    // Create necessary directories
    await this.createDirectories();
    
    // Initialize cloud clients if needed
    if (this.config.s3) {
      this.s3Client = new S3Client({
        region: this.config.s3.region
      });
    }
    
    // Load recovery points
    await this.loadRecoveryPoints();
    
    // Start health monitoring
    if (this.config.autoRecovery) {
      this.startHealthMonitoring();
    }
    
    logger.info('Recovery system initialized', {
      recoveryPoints: this.recoveryPoints.length,
      autoRecovery: this.config.autoRecovery
    });
    
    this.emit('initialized');
  }
  
  /**
   * Create necessary directories
   */
  async createDirectories() {
    const dirs = [
      this.config.recoveryPath,
      this.config.tempPath,
      join(this.config.recoveryPath, 'points'),
      join(this.config.recoveryPath, 'logs')
    ];
    
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }
  
  /**
   * Load recovery points
   */
  async loadRecoveryPoints() {
    try {
      const metadataPath = join(this.config.recoveryPath, 'recovery-points.json');
      const data = await fs.readFile(metadataPath, 'utf8');
      this.recoveryPoints = JSON.parse(data);
      
      // Sort by timestamp
      this.recoveryPoints.sort((a, b) => b.timestamp - a.timestamp);
      
      logger.info(`Loaded ${this.recoveryPoints.length} recovery points`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Failed to load recovery points:', error);
      }
      this.recoveryPoints = [];
    }
  }
  
  /**
   * Save recovery points
   */
  async saveRecoveryPoints() {
    const metadataPath = join(this.config.recoveryPath, 'recovery-points.json');
    await fs.writeFile(
      metadataPath,
      JSON.stringify(this.recoveryPoints, null, 2)
    );
  }
  
  /**
   * Create recovery point
   */
  async createRecoveryPoint(options = {}) {
    const point = {
      id: this.generateRecoveryPointId(),
      timestamp: Date.now(),
      type: options.type || RecoveryPointType.MANUAL,
      description: options.description || 'Manual recovery point',
      metadata: {
        system: await this.getSystemMetadata(),
        ...options.metadata
      },
      location: null,
      size: 0,
      checksum: null
    };
    
    logger.info('Creating recovery point', { id: point.id, type: point.type });
    
    try {
      // Create backup using backup system
      const backupSystem = new AutomaticBackupSystem(this.config);
      const backup = await backupSystem.createBackup({
        strategy: 'snapshot',
        tag: `recovery-${point.id}`
      });
      
      point.location = backup.path;
      point.size = backup.size;
      point.checksum = backup.checksum;
      
      // Add to recovery points
      this.recoveryPoints.unshift(point);
      
      // Maintain limit
      if (this.recoveryPoints.length > this.config.maxRecoveryPoints) {
        const removed = this.recoveryPoints.pop();
        await this.deleteRecoveryPoint(removed.id);
      }
      
      // Save metadata
      await this.saveRecoveryPoints();
      
      logger.info('Recovery point created', { id: point.id });
      this.emit('recoveryPoint:created', point);
      
      return point;
    } catch (error) {
      logger.error('Failed to create recovery point:', error);
      throw error;
    }
  }
  
  /**
   * Start health monitoring
   */
  startHealthMonitoring() {
    this.healthCheckTimer = setInterval(async () => {
      await this.performHealthCheck();
    }, this.config.healthCheckInterval);
    
    // Initial check
    setTimeout(() => this.performHealthCheck(), 1000);
  }
  
  /**
   * Perform health check
   */
  async performHealthCheck() {
    const startTime = Date.now();
    const issues = [];
    
    try {
      // Check data integrity
      const integrityCheck = await this.checkDataIntegrity();
      if (!integrityCheck.healthy) {
        issues.push({
          type: 'data_integrity',
          severity: 'critical',
          details: integrityCheck.issues
        });
      }
      
      // Check system resources
      const resourceCheck = await this.checkSystemResources();
      if (!resourceCheck.healthy) {
        issues.push({
          type: 'system_resources',
          severity: 'warning',
          details: resourceCheck.issues
        });
      }
      
      // Check service availability
      const serviceCheck = await this.checkServiceAvailability();
      if (!serviceCheck.healthy) {
        issues.push({
          type: 'service_availability',
          severity: 'error',
          details: serviceCheck.issues
        });
      }
      
      // Update health status
      this.healthStatus = {
        healthy: issues.length === 0,
        lastCheck: Date.now(),
        issues,
        checkDuration: Date.now() - startTime
      };
      
      // Trigger auto-recovery if needed
      if (!this.healthStatus.healthy && this.config.autoRecovery) {
        await this.evaluateAutoRecovery(issues);
      }
      
      this.emit('healthCheck:completed', this.healthStatus);
      
    } catch (error) {
      logger.error('Health check failed:', error);
      this.healthStatus.healthy = false;
      this.healthStatus.issues.push({
        type: 'health_check_error',
        severity: 'critical',
        details: error.message
      });
    }
  }
  
  /**
   * Check data integrity
   */
  async checkDataIntegrity() {
    const issues = [];
    let corruptedFiles = 0;
    let missingFiles = 0;
    let totalFiles = 0;
    
    try {
      // Check critical data files
      const criticalPaths = [
        join(this.config.backupPath, '..', 'data', 'otedama.db'),
        join(this.config.backupPath, '..', 'config', 'otedama.config.js')
      ];
      
      for (const path of criticalPaths) {
        totalFiles++;
        try {
          const stats = await fs.stat(path);
          
          // Basic integrity check (could be enhanced with checksums)
          if (stats.size === 0) {
            corruptedFiles++;
            issues.push(`Empty file: ${path}`);
          }
        } catch (error) {
          if (error.code === 'ENOENT') {
            missingFiles++;
            issues.push(`Missing file: ${path}`);
          } else {
            corruptedFiles++;
            issues.push(`Cannot access: ${path}`);
          }
        }
      }
      
      // Calculate corruption/missing ratios
      const corruptionRatio = corruptedFiles / totalFiles;
      const missingRatio = missingFiles / totalFiles;
      
      const healthy = 
        corruptionRatio < this.config.recoveryThreshold.corruption &&
        missingRatio < this.config.recoveryThreshold.missing;
      
      return {
        healthy,
        issues,
        stats: {
          totalFiles,
          corruptedFiles,
          missingFiles,
          corruptionRatio,
          missingRatio
        }
      };
      
    } catch (error) {
      logger.error('Data integrity check failed:', error);
      return {
        healthy: false,
        issues: [error.message]
      };
    }
  }
  
  /**
   * Check system resources
   */
  async checkSystemResources() {
    const issues = [];
    
    try {
      // Check disk space
      const diskSpace = await this.getDiskSpace();
      if (diskSpace.percentUsed > 90) {
        issues.push(`Low disk space: ${diskSpace.percentUsed}% used`);
      }
      
      // Check memory usage
      const memUsage = process.memoryUsage();
      const totalMem = require('os').totalmem();
      const memPercent = (memUsage.rss / totalMem) * 100;
      
      if (memPercent > 85) {
        issues.push(`High memory usage: ${memPercent.toFixed(1)}%`);
      }
      
      return {
        healthy: issues.length === 0,
        issues
      };
      
    } catch (error) {
      return {
        healthy: false,
        issues: [error.message]
      };
    }
  }
  
  /**
   * Check service availability
   */
  async checkServiceAvailability() {
    const issues = [];
    
    try {
      // Check database connection
      // This would be implemented based on your database setup
      
      // Check API responsiveness
      // This would check if the API server is responding
      
      return {
        healthy: issues.length === 0,
        issues
      };
      
    } catch (error) {
      return {
        healthy: false,
        issues: [error.message]
      };
    }
  }
  
  /**
   * Evaluate if auto-recovery should be triggered
   */
  async evaluateAutoRecovery(issues) {
    // Don't trigger if recovery is already in progress
    if (this.status !== RecoveryStatus.IDLE) {
      return;
    }
    
    // Check severity of issues
    const criticalIssues = issues.filter(i => i.severity === 'critical');
    
    if (criticalIssues.length > 0) {
      logger.warn('Critical issues detected, initiating auto-recovery', {
        issues: criticalIssues
      });
      
      // Find best recovery point
      const recoveryPoint = this.findBestRecoveryPoint();
      
      if (recoveryPoint) {
        await this.initiateRecovery({
          mode: RecoveryMode.PARTIAL,
          recoveryPointId: recoveryPoint.id,
          reason: 'Auto-recovery due to critical issues',
          issues: criticalIssues
        });
      } else {
        logger.error('No suitable recovery point found for auto-recovery');
      }
    }
  }
  
  /**
   * Find best recovery point for auto-recovery
   */
  findBestRecoveryPoint() {
    // Find most recent healthy recovery point
    return this.recoveryPoints.find(point => {
      // Check if recovery point is recent (within 24 hours)
      const age = Date.now() - point.timestamp;
      return age < 86400000 && point.metadata.system?.healthy;
    });
  }
  
  /**
   * Initiate recovery
   */
  async initiateRecovery(options) {
    if (this.status !== RecoveryStatus.IDLE) {
      throw new Error('Recovery already in progress');
    }
    
    const recovery = {
      id: this.generateRecoveryId(),
      mode: options.mode || RecoveryMode.FULL,
      recoveryPointId: options.recoveryPointId,
      startTime: Date.now(),
      status: RecoveryStatus.PREPARING,
      reason: options.reason || 'Manual recovery',
      options
    };
    
    this.activeRecovery = recovery;
    this.status = RecoveryStatus.PREPARING;
    
    logger.info('Initiating recovery', {
      id: recovery.id,
      mode: recovery.mode,
      recoveryPointId: recovery.recoveryPointId
    });
    
    this.emit('recovery:started', recovery);
    
    try {
      // Prepare recovery
      await this.prepareRecovery(recovery);
      
      // Perform recovery
      await this.performRecovery(recovery);
      
      // Verify recovery
      if (this.config.verifyAfterRecovery) {
        await this.verifyRecovery(recovery);
      }
      
      // Complete recovery
      recovery.endTime = Date.now();
      recovery.duration = recovery.endTime - recovery.startTime;
      recovery.status = RecoveryStatus.COMPLETED;
      
      this.stats.totalRecoveries++;
      this.stats.successfulRecoveries++;
      this.stats.lastRecoveryTime = recovery.duration;
      this.updateAverageRecoveryTime(recovery.duration);
      
      logger.info('Recovery completed', {
        id: recovery.id,
        duration: recovery.duration
      });
      
      this.emit('recovery:completed', recovery);
      
    } catch (error) {
      recovery.error = error.message;
      recovery.status = RecoveryStatus.FAILED;
      
      this.stats.totalRecoveries++;
      this.stats.failedRecoveries++;
      
      logger.error('Recovery failed', {
        id: recovery.id,
        error: error.message
      });
      
      this.emit('recovery:failed', recovery);
      
      throw error;
      
    } finally {
      this.status = RecoveryStatus.IDLE;
      this.activeRecovery = null;
    }
    
    return recovery;
  }
  
  /**
   * Prepare recovery
   */
  async prepareRecovery(recovery) {
    this.status = RecoveryStatus.PREPARING;
    
    // Find recovery point
    const recoveryPoint = this.recoveryPoints.find(
      p => p.id === recovery.recoveryPointId
    );
    
    if (!recoveryPoint) {
      throw new Error('Recovery point not found');
    }
    
    recovery.recoveryPoint = recoveryPoint;
    
    // Create recovery workspace
    const workspacePath = join(this.config.tempPath, recovery.id);
    await fs.mkdir(workspacePath, { recursive: true });
    recovery.workspacePath = workspacePath;
    
    // Preserve current data if configured
    if (this.config.preserveCurrentData) {
      await this.preserveCurrentData(recovery);
    }
    
    logger.info('Recovery prepared', { id: recovery.id });
  }
  
  /**
   * Perform recovery
   */
  async performRecovery(recovery) {
    this.status = RecoveryStatus.RECOVERING;
    
    const { recoveryPoint, workspacePath } = recovery;
    
    try {
      // Download/extract backup
      logger.info('Extracting backup', { location: recoveryPoint.location });
      
      if (recoveryPoint.location.startsWith('s3://')) {
        await this.recoverFromS3(recoveryPoint, workspacePath);
      } else {
        await this.recoverFromLocal(recoveryPoint, workspacePath);
      }
      
      // Apply recovery based on mode
      switch (recovery.mode) {
        case RecoveryMode.FULL:
          await this.performFullRecovery(recovery);
          break;
          
        case RecoveryMode.PARTIAL:
          await this.performPartialRecovery(recovery);
          break;
          
        case RecoveryMode.ROLLBACK:
          await this.performRollback(recovery);
          break;
          
        case RecoveryMode.REPAIR:
          await this.performRepair(recovery);
          break;
          
        default:
          throw new Error(`Unknown recovery mode: ${recovery.mode}`);
      }
      
      logger.info('Recovery performed', { id: recovery.id });
      
    } catch (error) {
      logger.error('Recovery failed:', error);
      throw error;
    }
  }
  
  /**
   * Recover from S3
   */
  async recoverFromS3(recoveryPoint, workspacePath) {
    const key = recoveryPoint.location.replace('s3://', '');
    const backupPath = join(workspacePath, 'backup.tar.gz');
    
    // Download from S3
    const command = new GetObjectCommand({
      Bucket: this.config.s3.bucket,
      Key: key
    });
    
    const response = await this.s3Client.send(command);
    const writeStream = createWriteStream(backupPath);
    
    await pipeline(response.Body, writeStream);
    
    // Extract
    await tar.extract({
      file: backupPath,
      cwd: workspacePath,
      gzip: true
    });
    
    // Clean up
    await fs.unlink(backupPath);
  }
  
  /**
   * Recover from local backup
   */
  async recoverFromLocal(recoveryPoint, workspacePath) {
    await tar.extract({
      file: recoveryPoint.location,
      cwd: workspacePath,
      gzip: true
    });
  }
  
  /**
   * Perform full recovery
   */
  async performFullRecovery(recovery) {
    const { workspacePath } = recovery;
    const sourcePaths = this.config.sourcePaths || ['data', 'config'];
    
    // Stop services before recovery
    this.emit('recovery:stopping-services');
    await this.stopServices();
    
    try {
      // Replace all data
      for (const sourcePath of sourcePaths) {
        const backupPath = join(workspacePath, sourcePath);
        const targetPath = join(process.cwd(), sourcePath);
        
        // Remove existing
        await fs.rm(targetPath, { recursive: true, force: true });
        
        // Copy from backup
        await this.copyDirectory(backupPath, targetPath);
      }
      
      // Restart services
      this.emit('recovery:starting-services');
      await this.startServices();
      
    } catch (error) {
      // Attempt to restore from preserved data
      if (this.config.preserveCurrentData) {
        await this.restoreFromPreserved(recovery);
      }
      throw error;
    }
  }
  
  /**
   * Perform partial recovery
   */
  async performPartialRecovery(recovery) {
    const { workspacePath, options } = recovery;
    const targets = options.targets || ['data/otedama.db'];
    
    for (const target of targets) {
      const backupPath = join(workspacePath, target);
      const targetPath = join(process.cwd(), target);
      
      // Backup current file
      const backupCurrentPath = `${targetPath}.recovery-backup`;
      await fs.copyFile(targetPath, backupCurrentPath);
      
      try {
        // Replace with backup
        await fs.copyFile(backupPath, targetPath);
      } catch (error) {
        // Restore original on failure
        await fs.copyFile(backupCurrentPath, targetPath);
        throw error;
      }
      
      // Clean up backup
      await fs.unlink(backupCurrentPath);
    }
  }
  
  /**
   * Verify recovery
   */
  async verifyRecovery(recovery) {
    this.status = RecoveryStatus.VERIFYING;
    
    logger.info('Verifying recovery', { id: recovery.id });
    
    // Perform health check
    await this.performHealthCheck();
    
    if (!this.healthStatus.healthy) {
      throw new Error('Recovery verification failed: System not healthy');
    }
    
    // Verify data integrity
    const integrityCheck = await this.checkDataIntegrity();
    if (!integrityCheck.healthy) {
      throw new Error('Recovery verification failed: Data integrity issues');
    }
    
    logger.info('Recovery verified', { id: recovery.id });
  }
  
  /**
   * Get recovery points
   */
  getRecoveryPoints(options = {}) {
    let points = [...this.recoveryPoints];
    
    // Filter by type
    if (options.type) {
      points = points.filter(p => p.type === options.type);
    }
    
    // Filter by age
    if (options.maxAge) {
      const cutoff = Date.now() - options.maxAge;
      points = points.filter(p => p.timestamp > cutoff);
    }
    
    // Limit results
    if (options.limit) {
      points = points.slice(0, options.limit);
    }
    
    return points;
  }
  
  /**
   * Delete recovery point
   */
  async deleteRecoveryPoint(id) {
    const index = this.recoveryPoints.findIndex(p => p.id === id);
    if (index === -1) return;
    
    const point = this.recoveryPoints[index];
    
    // Delete backup file
    if (point.location) {
      try {
        if (point.location.startsWith('s3://')) {
          // Delete from S3
          const key = point.location.replace('s3://', '');
          await this.s3Client.send(new DeleteObjectCommand({
            Bucket: this.config.s3.bucket,
            Key: key
          }));
        } else {
          // Delete local file
          await fs.unlink(point.location);
        }
      } catch (error) {
        logger.error('Failed to delete backup file:', error);
      }
    }
    
    // Remove from list
    this.recoveryPoints.splice(index, 1);
    await this.saveRecoveryPoints();
    
    logger.info('Recovery point deleted', { id });
  }
  
  /**
   * Get system metadata
   */
  async getSystemMetadata() {
    return {
      timestamp: Date.now(),
      version: process.env.npm_package_version || 'unknown',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      healthy: this.healthStatus.healthy,
      uptime: process.uptime()
    };
  }
  
  /**
   * Get disk space
   */
  async getDiskSpace() {
    // This is a simplified implementation
    // In production, use a proper disk space library
    const stats = await fs.statfs(process.cwd());
    const total = stats.blocks * stats.bsize;
    const free = stats.bfree * stats.bsize;
    const used = total - free;
    const percentUsed = (used / total) * 100;
    
    return {
      total,
      free,
      used,
      percentUsed
    };
  }
  
  /**
   * Copy directory recursively
   */
  async copyDirectory(source, target) {
    await fs.mkdir(target, { recursive: true });
    
    const entries = await fs.readdir(source, { withFileTypes: true });
    
    for (const entry of entries) {
      const sourcePath = join(source, entry.name);
      const targetPath = join(target, entry.name);
      
      if (entry.isDirectory()) {
        await this.copyDirectory(sourcePath, targetPath);
      } else {
        await fs.copyFile(sourcePath, targetPath);
      }
    }
  }
  
  /**
   * Preserve current data
   */
  async preserveCurrentData(recovery) {
    const preservePath = join(recovery.workspacePath, 'preserved');
    await fs.mkdir(preservePath, { recursive: true });
    
    const sourcePaths = this.config.sourcePaths || ['data', 'config'];
    
    for (const sourcePath of sourcePaths) {
      const currentPath = join(process.cwd(), sourcePath);
      const targetPath = join(preservePath, sourcePath);
      
      try {
        await this.copyDirectory(currentPath, targetPath);
      } catch (error) {
        logger.warn('Failed to preserve data:', error);
      }
    }
    
    recovery.preservedDataPath = preservePath;
  }
  
  /**
   * Restore from preserved data
   */
  async restoreFromPreserved(recovery) {
    if (!recovery.preservedDataPath) return;
    
    logger.info('Restoring from preserved data');
    
    const sourcePaths = this.config.sourcePaths || ['data', 'config'];
    
    for (const sourcePath of sourcePaths) {
      const preservedPath = join(recovery.preservedDataPath, sourcePath);
      const targetPath = join(process.cwd(), sourcePath);
      
      await fs.rm(targetPath, { recursive: true, force: true });
      await this.copyDirectory(preservedPath, targetPath);
    }
  }
  
  /**
   * Stop services (to be implemented by application)
   */
  async stopServices() {
    this.emit('services:stop');
    // Application should handle this event
  }
  
  /**
   * Start services (to be implemented by application)
   */
  async startServices() {
    this.emit('services:start');
    // Application should handle this event
  }
  
  /**
   * Generate recovery ID
   */
  generateRecoveryId() {
    return `recovery-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Generate recovery point ID
   */
  generateRecoveryPointId() {
    return `rp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Update average recovery time
   */
  updateAverageRecoveryTime(duration) {
    const total = this.stats.averageRecoveryTime * (this.stats.successfulRecoveries - 1);
    this.stats.averageRecoveryTime = (total + duration) / this.stats.successfulRecoveries;
  }
  
  /**
   * Get recovery status
   */
  getStatus() {
    return {
      status: this.status,
      activeRecovery: this.activeRecovery,
      healthStatus: this.healthStatus,
      recoveryPoints: this.recoveryPoints.length,
      stats: this.stats
    };
  }
  
  /**
   * Shutdown recovery system
   */
  async shutdown() {
    logger.info('Shutting down recovery system');
    
    // Stop health monitoring
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    
    // Clean up temp files
    try {
      await fs.rm(this.config.tempPath, { recursive: true, force: true });
    } catch (error) {
      logger.warn('Failed to clean temp files:', error);
    }
    
    this.emit('shutdown');
  }
}

export default AutomatedRecoverySystem;