#!/usr/bin/env node

/**
 * Backup Service - Otedama
 * Automated backup service for production
 */

import { BackupManager } from '../lib/core/backup.js';
import { createStructuredLogger } from '../lib/core/index.js';
import { StorageManager } from '../lib/storage/index.js';
import cron from 'node-cron';

const logger = createStructuredLogger('BackupService');

class BackupService {
  constructor(config = {}) {
    this.config = {
      interval: config.interval || process.env.BACKUP_INTERVAL || '0 2 * * *', // Daily at 2 AM
      maxBackups: config.maxBackups || parseInt(process.env.MAX_BACKUPS) || 7,
      targets: config.targets || (process.env.BACKUP_TARGETS || 'database,config,logs').split(','),
      compress: config.compress !== false,
      encrypt: config.encrypt || false,
      ...config
    };
    
    this.backupManager = new BackupManager({
      backupDir: './backups',
      maxBackups: this.config.maxBackups,
      compress: this.config.compress,
      encryption: this.config.encrypt ? this.getEncryption() : null
    });
    
    this.storage = null;
    this.cronJob = null;
  }
  
  async start() {
    try {
      logger.info('Starting backup service...');
      
      // Initialize backup manager
      await this.backupManager.initialize();
      
      // Initialize storage if database backup is enabled
      if (this.config.targets.includes('database')) {
        this.storage = new StorageManager({
          dataDir: process.env.DATA_DIR || './data',
          dbFile: process.env.DB_FILE || 'otedama.db'
        });
        await this.storage.initialize();
      }
      
      // Schedule backups
      this.scheduleBackups();
      
      // Run initial backup
      await this.performBackup();
      
      logger.info('Backup service started successfully');
      
    } catch (error) {
      logger.error('Failed to start backup service:', error);
      process.exit(1);
    }
  }
  
  scheduleBackups() {
    // Parse cron expression or interval
    let cronExpression;
    
    if (this.config.interval.includes(' ')) {
      // Cron expression
      cronExpression = this.config.interval;
    } else {
      // Interval in milliseconds
      const interval = parseInt(this.config.interval);
      if (isNaN(interval)) {
        throw new Error('Invalid backup interval');
      }
      
      // Convert to cron expression (rough approximation)
      if (interval < 3600000) { // Less than 1 hour
        const minutes = Math.floor(interval / 60000);
        cronExpression = `*/${minutes} * * * *`;
      } else if (interval < 86400000) { // Less than 1 day
        const hours = Math.floor(interval / 3600000);
        cronExpression = `0 */${hours} * * *`;
      } else { // Daily or more
        const days = Math.floor(interval / 86400000);
        cronExpression = `0 2 */${days} * *`;
      }
    }
    
    logger.info(`Scheduling backups with expression: ${cronExpression}`);
    
    this.cronJob = cron.schedule(cronExpression, async () => {
      await this.performBackup();
    });
  }
  
  async performBackup() {
    logger.info('Starting backup...');
    
    const startTime = Date.now();
    const sources = {
      files: [],
      database: null
    };
    
    // Collect backup sources
    for (const target of this.config.targets) {
      switch (target) {
        case 'database':
          if (this.storage) {
            sources.database = this.storage.getDatabase();
          }
          break;
          
        case 'config':
          sources.files.push({
            path: './otedama.config.js',
            name: 'otedama.config.js'
          });
          sources.files.push({
            path: './config',
            name: 'config'
          });
          break;
          
        case 'logs':
          sources.files.push({
            path: './logs',
            name: 'logs'
          });
          break;
          
        default:
          // Custom file/directory
          sources.files.push({
            path: target,
            name: target.split('/').pop()
          });
      }
    }
    
    try {
      // Create backup
      const result = await this.backupManager.createBackup(sources, {
        type: 'scheduled',
        metadata: {
          service: 'backup-service',
          targets: this.config.targets,
          hostname: require('os').hostname(),
          version: process.env.VERSION || '1.0.0'
        }
      });
      
      const duration = Date.now() - startTime;
      
      logger.info('Backup completed successfully', {
        backupId: result.id,
        size: result.metadata.size,
        duration,
        path: result.path
      });
      
      // Send notification if configured
      await this.sendNotification('success', result);
      
    } catch (error) {
      logger.error('Backup failed:', error);
      
      // Send error notification
      await this.sendNotification('failure', { error: error.message });
      
      // Don't throw - let the service continue running
    }
  }
  
  async sendNotification(status, data) {
    // Implement notification logic here (email, webhook, etc.)
    if (process.env.BACKUP_WEBHOOK_URL) {
      try {
        const webhook = {
          status,
          timestamp: new Date().toISOString(),
          hostname: require('os').hostname(),
          ...data
        };
        
        // Send webhook
        // await fetch(process.env.BACKUP_WEBHOOK_URL, {
        //   method: 'POST',
        //   headers: { 'Content-Type': 'application/json' },
        //   body: JSON.stringify(webhook)
        // });
        
      } catch (error) {
        logger.error('Failed to send backup notification:', error);
      }
    }
  }
  
  getEncryption() {
    const key = process.env.BACKUP_ENCRYPTION_KEY;
    if (!key) {
      throw new Error('BACKUP_ENCRYPTION_KEY not set');
    }
    
    return {
      algorithm: 'aes-256-gcm',
      key: Buffer.from(key, 'hex')
    };
  }
  
  async stop() {
    logger.info('Stopping backup service...');
    
    if (this.cronJob) {
      this.cronJob.stop();
    }
    
    if (this.storage) {
      await this.storage.shutdown();
    }
    
    logger.info('Backup service stopped');
  }
  
  // Restore functionality
  async restore(backupId, options = {}) {
    logger.info(`Restoring backup ${backupId}...`);
    
    try {
      const result = await this.backupManager.restoreBackup(backupId, {
        database: this.storage?.getDatabase(),
        databasePath: './data/otedama.db',
        ...options
      });
      
      logger.info('Restore completed successfully', result);
      
    } catch (error) {
      logger.error('Restore failed:', error);
      throw error;
    }
  }
  
  // List backups
  async list() {
    return this.backupManager.listBackups();
  }
}

// Run as standalone service
if (import.meta.url === `file://${process.argv[1]}`) {
  const service = new BackupService();
  
  // Handle shutdown gracefully
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM signal');
    await service.stop();
    process.exit(0);
  });
  
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT signal');
    await service.stop();
    process.exit(0);
  });
  
  // Handle restore command
  if (process.argv[2] === 'restore' && process.argv[3]) {
    service.restore(process.argv[3])
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  } else if (process.argv[2] === 'list') {
    service.list()
      .then(backups => {
        console.table(backups);
        process.exit(0);
      })
      .catch(() => process.exit(1));
  } else {
    // Start backup service
    service.start().catch(error => {
      logger.error('Service startup failed:', error);
      process.exit(1);
    });
  }
}

export default BackupService;