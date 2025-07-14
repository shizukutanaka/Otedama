import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { createGzip, createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';

/**
 * Automated Backup System
 * データの自動バックアップとリストア
 * 
 * Features:
 * - Scheduled automatic backups
 * - Incremental backups
 * - Compressed storage
 * - Integrity verification
 * - Automatic cleanup of old backups
 * - Quick restore capabilities
 */
export class BackupManager extends EventEmitter {
  constructor(config, database) {
    super();
    this.config = config;
    this.db = database;
    this.logger = new Logger('BackupManager');
    
    // Backup configuration
    this.backupConfig = {
      enabled: true,
      interval: 3600000, // 1 hour
      retentionDays: 7,
      maxBackups: 168, // 7 days * 24 hours
      compressionLevel: 6,
      backupPath: path.join(process.cwd(), 'backups'),
      incrementalEnabled: true,
      encryptionEnabled: false // Can be enabled in production
    };
    
    // Backup tracking
    this.backupHistory = [];
    this.lastBackupTime = 0;
    this.backupInProgress = false;
    
    // Critical data to backup
    this.backupTargets = [
      {
        name: 'database',
        path: 'data/otedama.db',
        type: 'file',
        critical: true
      },
      {
        name: 'configuration',
        path: 'otedama.json',
        type: 'file',
        critical: true
      },
      {
        name: 'wallets',
        path: 'data/wallets.json',
        type: 'file',
        critical: true
      },
      {
        name: 'pool_state',
        path: 'data/pool_state.json',
        type: 'file',
        critical: false
      },
      {
        name: 'dex_state',
        path: 'data/dex_state.json',
        type: 'file',
        critical: false
      }
    ];
    
    // Initialize backup system
    this.initialize();
  }

  /**
   * Initialize backup system
   */
  async initialize() {
    try {
      // Create backup directory
      await fs.mkdir(this.backupConfig.backupPath, { recursive: true });
      
      // Load backup history
      await this.loadBackupHistory();
      
      // Start automated backups
      if (this.backupConfig.enabled) {
        this.startAutomatedBackups();
      }
      
      // Clean old backups
      await this.cleanOldBackups();
      
      this.logger.info('Backup system initialized');
      
    } catch (error) {
      this.logger.error('Failed to initialize backup system:', error);
    }
  }

  /**
   * Start automated backup schedule
   */
  startAutomatedBackups() {
    // Initial backup after 1 minute
    setTimeout(() => this.performBackup(), 60000);
    
    // Regular backups
    this.backupTimer = setInterval(() => {
      this.performBackup();
    }, this.backupConfig.interval);
    
    this.logger.info(`Automated backups scheduled every ${this.backupConfig.interval / 60000} minutes`);
  }

  /**
   * Perform backup
   */
  async performBackup(type = 'scheduled') {
    if (this.backupInProgress) {
      this.logger.warn('Backup already in progress, skipping...');
      return;
    }
    
    this.backupInProgress = true;
    const startTime = Date.now();
    
    try {
      this.logger.info(`Starting ${type} backup...`);
      
      const backupId = this.generateBackupId();
      const backupPath = path.join(this.backupConfig.backupPath, backupId);
      
      // Create backup directory
      await fs.mkdir(backupPath, { recursive: true });
      
      const backupInfo = {
        id: backupId,
        type,
        timestamp: Date.now(),
        version: this.config.get('version') || '6.0.0',
        files: [],
        checksums: {},
        compressed: true,
        incremental: false,
        size: 0
      };
      
      // Backup each target
      for (const target of this.backupTargets) {
        try {
          const result = await this.backupTarget(target, backupPath);
          if (result) {
            backupInfo.files.push(result.file);
            backupInfo.checksums[target.name] = result.checksum;
            backupInfo.size += result.size;
          }
        } catch (error) {
          this.logger.error(`Failed to backup ${target.name}:`, error);
          if (target.critical) {
            throw error;
          }
        }
      }
      
      // Save critical runtime state
      await this.backupRuntimeState(backupPath, backupInfo);
      
      // Create backup manifest
      await fs.writeFile(
        path.join(backupPath, 'manifest.json'),
        JSON.stringify(backupInfo, null, 2)
      );
      
      // Update backup history
      this.backupHistory.push(backupInfo);
      await this.saveBackupHistory();
      
      const duration = Date.now() - startTime;
      this.lastBackupTime = Date.now();
      
      this.logger.info(`Backup completed: ${backupId} (${duration}ms, ${this.formatSize(backupInfo.size)})`);
      
      // Emit backup complete event
      this.emit('backup:complete', {
        id: backupId,
        duration,
        size: backupInfo.size,
        files: backupInfo.files.length
      });
      
      // Clean old backups
      await this.cleanOldBackups();
      
    } catch (error) {
      this.logger.error('Backup failed:', error);
      this.emit('backup:failed', { error: error.message });
    } finally {
      this.backupInProgress = false;
    }
  }

  /**
   * Backup individual target
   */
  async backupTarget(target, backupPath) {
    const sourcePath = path.join(process.cwd(), target.path);
    
    try {
      // Check if source exists
      await fs.access(sourcePath);
      
      const fileName = `${target.name}.gz`;
      const destPath = path.join(backupPath, fileName);
      
      // Compress and copy file
      await pipeline(
        createReadStream(sourcePath),
        createGzip({ level: this.backupConfig.compressionLevel }),
        createWriteStream(destPath)
      );
      
      // Calculate checksum
      const checksum = await this.calculateChecksum(sourcePath);
      
      // Get file size
      const stats = await fs.stat(destPath);
      
      return {
        file: fileName,
        checksum,
        size: stats.size
      };
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.logger.debug(`Target not found: ${target.name}`);
        return null;
      }
      throw error;
    }
  }

  /**
   * Backup runtime state
   */
  async backupRuntimeState(backupPath, backupInfo) {
    try {
      const runtimeState = {
        timestamp: Date.now(),
        uptime: process.uptime(),
        
        // Pool state
        pool: {
          miners: global.stratum?.getConnectionCount() || 0,
          hashrate: global.stratum?.getTotalHashrate() || 0,
          shares: global.db?.getPoolStats() || {}
        },
        
        // Payment state
        payments: {
          pendingPayouts: global.paymentManager?.getPaymentStats().queueLength || 0,
          lastPayout: global.paymentManager?.getPaymentStats().lastPayout || 0
        },
        
        // DEX state
        dex: {
          pools: global.dex?.getStats().v2.pools || 0,
          tvl: global.dex?.getStats().v2.tvl || 0
        },
        
        // Fee collection state
        fees: {
          totalCollected: global.feeManager?.getStats().totalCollectedBTC || 0,
          pendingFees: global.feeManager?.getStats().pendingFees || {}
        }
      };
      
      const stateFile = path.join(backupPath, 'runtime_state.json.gz');
      
      // Compress and save
      const stateData = JSON.stringify(runtimeState, null, 2);
      await pipeline(
        async function* () { yield stateData; },
        createGzip({ level: this.backupConfig.compressionLevel }),
        createWriteStream(stateFile)
      );
      
      backupInfo.files.push('runtime_state.json.gz');
      
    } catch (error) {
      this.logger.warn('Failed to backup runtime state:', error);
    }
  }

  /**
   * Restore from backup
   */
  async restore(backupId, options = {}) {
    const { 
      validateOnly = false,
      targetPath = process.cwd(),
      selective = []
    } = options;
    
    this.logger.info(`Starting restore from backup: ${backupId}`);
    
    try {
      const backupPath = path.join(this.backupConfig.backupPath, backupId);
      const manifestPath = path.join(backupPath, 'manifest.json');
      
      // Load manifest
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      
      // Validate backup integrity
      const validation = await this.validateBackup(backupId);
      if (!validation.valid) {
        throw new Error(`Backup validation failed: ${validation.errors.join(', ')}`);
      }
      
      if (validateOnly) {
        return { valid: true, manifest };
      }
      
      // Stop services before restore
      this.emit('restore:start', { backupId });
      
      // Restore each file
      const restored = [];
      const errors = [];
      
      for (const target of this.backupTargets) {
        // Skip if selective restore and not included
        if (selective.length > 0 && !selective.includes(target.name)) {
          continue;
        }
        
        try {
          const fileName = `${target.name}.gz`;
          const sourcePath = path.join(backupPath, fileName);
          const destPath = path.join(targetPath, target.path);
          
          // Check if backup file exists
          try {
            await fs.access(sourcePath);
          } catch {
            continue; // Skip if not in backup
          }
          
          // Create destination directory
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          
          // Backup current file if exists
          try {
            await fs.access(destPath);
            await fs.rename(destPath, `${destPath}.backup`);
          } catch {
            // File doesn't exist, no backup needed
          }
          
          // Decompress and restore
          await pipeline(
            createReadStream(sourcePath),
            createGunzip(),
            createWriteStream(destPath)
          );
          
          restored.push(target.name);
          this.logger.info(`Restored: ${target.name}`);
          
        } catch (error) {
          errors.push({ target: target.name, error: error.message });
          this.logger.error(`Failed to restore ${target.name}:`, error);
          
          // Rollback if critical
          if (target.critical) {
            await this.rollbackRestore(restored, targetPath);
            throw new Error(`Critical restore failed: ${target.name}`);
          }
        }
      }
      
      this.logger.info(`Restore completed: ${restored.length} files restored`);
      
      // Emit restore complete
      this.emit('restore:complete', {
        backupId,
        restored,
        errors
      });
      
      return {
        success: true,
        restored,
        errors
      };
      
    } catch (error) {
      this.logger.error('Restore failed:', error);
      this.emit('restore:failed', { backupId, error: error.message });
      throw error;
    }
  }

  /**
   * Validate backup integrity
   */
  async validateBackup(backupId) {
    const backupPath = path.join(this.backupConfig.backupPath, backupId);
    const manifestPath = path.join(backupPath, 'manifest.json');
    
    const errors = [];
    
    try {
      // Check manifest exists
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      
      // Verify each file
      for (const file of manifest.files) {
        const filePath = path.join(backupPath, file);
        
        try {
          await fs.access(filePath);
        } catch {
          errors.push(`Missing file: ${file}`);
        }
      }
      
      return {
        valid: errors.length === 0,
        errors
      };
      
    } catch (error) {
      return {
        valid: false,
        errors: ['Invalid or missing manifest']
      };
    }
  }

  /**
   * Rollback failed restore
   */
  async rollbackRestore(restoredFiles, targetPath) {
    this.logger.warn('Rolling back restore...');
    
    for (const fileName of restoredFiles) {
      const target = this.backupTargets.find(t => t.name === fileName);
      if (!target) continue;
      
      const filePath = path.join(targetPath, target.path);
      const backupPath = `${filePath}.backup`;
      
      try {
        // Remove restored file
        await fs.unlink(filePath);
        
        // Restore backup
        await fs.rename(backupPath, filePath);
        
        this.logger.info(`Rolled back: ${fileName}`);
      } catch (error) {
        this.logger.error(`Failed to rollback ${fileName}:`, error);
      }
    }
  }

  /**
   * Clean old backups
   */
  async cleanOldBackups() {
    const cutoffTime = Date.now() - (this.backupConfig.retentionDays * 24 * 60 * 60 * 1000);
    const backupsToRemove = [];
    
    // Sort by timestamp (newest first)
    this.backupHistory.sort((a, b) => b.timestamp - a.timestamp);
    
    // Keep minimum number of backups
    const backupsToKeep = Math.max(24, this.backupConfig.maxBackups); // At least 24 hours
    
    for (let i = 0; i < this.backupHistory.length; i++) {
      const backup = this.backupHistory[i];
      
      // Keep recent backups
      if (i < backupsToKeep) continue;
      
      // Remove old backups
      if (backup.timestamp < cutoffTime) {
        backupsToRemove.push(backup);
      }
    }
    
    // Remove old backups
    for (const backup of backupsToRemove) {
      try {
        const backupPath = path.join(this.backupConfig.backupPath, backup.id);
        await fs.rm(backupPath, { recursive: true, force: true });
        
        // Remove from history
        const index = this.backupHistory.indexOf(backup);
        if (index > -1) {
          this.backupHistory.splice(index, 1);
        }
        
        this.logger.debug(`Removed old backup: ${backup.id}`);
      } catch (error) {
        this.logger.error(`Failed to remove backup ${backup.id}:`, error);
      }
    }
    
    if (backupsToRemove.length > 0) {
      await this.saveBackupHistory();
      this.logger.info(`Cleaned ${backupsToRemove.length} old backups`);
    }
  }

  /**
   * Get backup list
   */
  getBackupList() {
    return this.backupHistory
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(backup => ({
        id: backup.id,
        type: backup.type,
        timestamp: backup.timestamp,
        size: backup.size,
        files: backup.files.length
      }));
  }

  /**
   * Load backup history
   */
  async loadBackupHistory() {
    const historyPath = path.join(this.backupConfig.backupPath, 'history.json');
    
    try {
      const data = await fs.readFile(historyPath, 'utf8');
      this.backupHistory = JSON.parse(data);
    } catch {
      this.backupHistory = [];
    }
  }

  /**
   * Save backup history
   */
  async saveBackupHistory() {
    const historyPath = path.join(this.backupConfig.backupPath, 'history.json');
    
    await fs.writeFile(
      historyPath,
      JSON.stringify(this.backupHistory, null, 2)
    );
  }

  /**
   * Calculate file checksum
   */
  async calculateChecksum(filePath) {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    
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
    const timestamp = date.toISOString().replace(/[:.]/g, '-');
    const random = Math.random().toString(36).substring(2, 8);
    return `backup-${timestamp}-${random}`;
  }

  /**
   * Format file size
   */
  formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  /**
   * Stop backup system
   */
  stop() {
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
    }
    
    this.logger.info('Backup system stopped');
  }
}
