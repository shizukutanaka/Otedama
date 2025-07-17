/**
 * Backup and Recovery Module for Otedama
 * Implements automated backup strategies and recovery procedures
 */

import { existsSync, mkdirSync, createReadStream, createWriteStream } from 'fs';
import { promises as fs } from 'fs';
import { resolve, join, basename } from 'path';
import { createGzip, createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';

const execAsync = promisify(spawn);

/**
 * Backup Manager
 */
export class BackupManager {
  constructor(config = {}) {
    this.config = {
      backupDir: config.backupDir || './backups',
      dataDir: config.dataDir || './data',
      dbPath: config.dbPath || './data/otedama.db',
      retention: config.retention || 7, // days
      compression: config.compression !== false,
      encryption: config.encryption || false,
      schedule: config.schedule || '0 2 * * *', // 2 AM daily
      s3: config.s3 || null,
      webhook: config.webhook || null,
      ...config
    };
    
    this.ensureDirectories();
  }
  
  ensureDirectories() {
    if (!existsSync(this.config.backupDir)) {
      mkdirSync(this.config.backupDir, { recursive: true });
    }
  }
  
  /**
   * Create a full backup
   */
  async createBackup(type = 'scheduled') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `otedama-backup-${type}-${timestamp}`;
    const backupPath = join(this.config.backupDir, backupName);
    
    try {
      console.log(`Starting backup: ${backupName}`);
      
      // Create backup directory
      await fs.mkdir(backupPath, { recursive: true });
      
      // Backup database
      await this.backupDatabase(backupPath);
      
      // Backup configuration files
      await this.backupConfig(backupPath);
      
      // Backup additional data
      await this.backupData(backupPath);
      
      // Create metadata
      await this.createMetadata(backupPath, type);
      
      // Compress backup
      let finalPath = backupPath;
      if (this.config.compression) {
        finalPath = await this.compressBackup(backupPath);
        await fs.rm(backupPath, { recursive: true, force: true });
      }
      
      // Encrypt if configured
      if (this.config.encryption) {
        finalPath = await this.encryptBackup(finalPath);
      }
      
      // Upload to S3 if configured
      if (this.config.s3) {
        await this.uploadToS3(finalPath);
      }
      
      // Clean old backups
      await this.cleanOldBackups();
      
      // Send notification
      await this.notifyBackupComplete(backupName, finalPath);
      
      console.log(`Backup completed: ${finalPath}`);
      return { success: true, path: finalPath, name: backupName };
      
    } catch (error) {
      console.error(`Backup failed: ${error.message}`);
      await this.notifyBackupFailed(backupName, error);
      throw error;
    }
  }
  
  /**
   * Backup SQLite database
   */
  async backupDatabase(backupPath) {
    const dbBackupPath = join(backupPath, 'database');
    await fs.mkdir(dbBackupPath, { recursive: true });
    
    // Use SQLite backup API for consistency
    const db = new Database(this.config.dbPath, { readonly: true });
    
    try {
      // Checkpoint WAL to ensure all data is in main database file
      db.pragma('wal_checkpoint(TRUNCATE)');
      
      // Create backup
      const backupDbPath = join(dbBackupPath, 'otedama.db');
      await db.backup(backupDbPath);
      
      // Also backup WAL and SHM files if they exist
      const walPath = `${this.config.dbPath}-wal`;
      const shmPath = `${this.config.dbPath}-shm`;
      
      if (existsSync(walPath)) {
        await fs.copyFile(walPath, join(dbBackupPath, 'otedama.db-wal'));
      }
      
      if (existsSync(shmPath)) {
        await fs.copyFile(shmPath, join(dbBackupPath, 'otedama.db-shm'));
      }
      
      // Export schema and data as SQL for additional safety
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all();
      await fs.writeFile(
        join(dbBackupPath, 'schema.sql'),
        schema.map(s => s.sql).join(';\n\n') + ';'
      );
      
    } finally {
      db.close();
    }
  }
  
  /**
   * Backup configuration files
   */
  async backupConfig(backupPath) {
    const configBackupPath = join(backupPath, 'config');
    await fs.mkdir(configBackupPath, { recursive: true });
    
    const configFiles = [
      'otedama.json',
      'otedama-docker.json',
      'config/security.json',
      '.env',
      'package.json'
    ];
    
    for (const file of configFiles) {
      if (existsSync(file)) {
        const destPath = join(configBackupPath, basename(file));
        await fs.copyFile(file, destPath);
      }
    }
  }
  
  /**
   * Backup additional data
   */
  async backupData(backupPath) {
    const dataBackupPath = join(backupPath, 'data');
    await fs.mkdir(dataBackupPath, { recursive: true });
    
    // Backup logs (last 24 hours only)
    const logsDir = join(this.config.dataDir, '../logs');
    if (existsSync(logsDir)) {
      const cutoff = Date.now() - 86400000; // 24 hours
      const logs = await fs.readdir(logsDir);
      
      for (const log of logs) {
        const logPath = join(logsDir, log);
        const stat = await fs.stat(logPath);
        
        if (stat.mtime.getTime() > cutoff) {
          await fs.copyFile(logPath, join(dataBackupPath, log));
        }
      }
    }
    
    // Backup other important data directories
    const dataDirs = ['wallets', 'keys', 'certificates'];
    for (const dir of dataDirs) {
      const dirPath = join(this.config.dataDir, dir);
      if (existsSync(dirPath)) {
        const destPath = join(dataBackupPath, dir);
        await this.copyDirectory(dirPath, destPath);
      }
    }
  }
  
  /**
   * Create backup metadata
   */
  async createMetadata(backupPath, type) {
    const metadata = {
      version: '1.0',
      created: new Date().toISOString(),
      type,
      application: 'Otedama Mining Pool',
      appVersion: '0.6.1-enhanced',
      platform: process.platform,
      node: process.version,
      checksums: {},
      files: []
    };
    
    // Calculate checksums
    const files = await this.getFilesRecursive(backupPath);
    for (const file of files) {
      const relativePath = file.replace(backupPath + '/', '');
      const checksum = await this.calculateChecksum(file);
      metadata.checksums[relativePath] = checksum;
      metadata.files.push({
        path: relativePath,
        size: (await fs.stat(file)).size,
        checksum
      });
    }
    
    await fs.writeFile(
      join(backupPath, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );
  }
  
  /**
   * Compress backup directory
   */
  async compressBackup(backupPath) {
    const archivePath = `${backupPath}.tar.gz`;
    
    // Use tar command for compression
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', [
        '-czf',
        archivePath,
        '-C',
        this.config.backupDir,
        basename(backupPath)
      ]);
      
      tar.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Tar exited with code ${code}`));
      });
      
      tar.on('error', reject);
    });
    
    return archivePath;
  }
  
  /**
   * Encrypt backup file
   */
  async encryptBackup(backupPath) {
    if (!this.config.encryption.key) {
      throw new Error('Encryption key not provided');
    }
    
    const encryptedPath = `${backupPath}.enc`;
    
    // Use OpenSSL for encryption
    await new Promise((resolve, reject) => {
      const openssl = spawn('openssl', [
        'enc',
        '-aes-256-cbc',
        '-salt',
        '-in', backupPath,
        '-out', encryptedPath,
        '-k', this.config.encryption.key
      ]);
      
      openssl.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`OpenSSL exited with code ${code}`));
      });
      
      openssl.on('error', reject);
    });
    
    // Remove unencrypted file
    await fs.unlink(backupPath);
    
    return encryptedPath;
  }
  
  /**
   * Upload backup to S3
   */
  async uploadToS3(backupPath) {
    const { bucket, region, accessKeyId, secretAccessKey } = this.config.s3;
    
    // Use AWS CLI for upload
    const env = {
      ...process.env,
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
      AWS_DEFAULT_REGION: region
    };
    
    await new Promise((resolve, reject) => {
      const aws = spawn('aws', [
        's3', 'cp',
        backupPath,
        `s3://${bucket}/otedama-backups/${basename(backupPath)}`,
        '--storage-class', 'STANDARD_IA'
      ], { env });
      
      aws.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`AWS CLI exited with code ${code}`));
      });
      
      aws.on('error', reject);
    });
  }
  
  /**
   * Restore from backup
   */
  async restoreBackup(backupPath, options = {}) {
    console.log(`Starting restore from: ${backupPath}`);
    
    try {
      // Decrypt if needed
      if (backupPath.endsWith('.enc')) {
        backupPath = await this.decryptBackup(backupPath);
      }
      
      // Extract if compressed
      let extractPath = backupPath;
      if (backupPath.endsWith('.tar.gz')) {
        extractPath = await this.extractBackup(backupPath);
      }
      
      // Verify metadata
      const metadata = await this.verifyBackup(extractPath);
      
      // Stop services if requested
      if (options.stopServices) {
        await this.stopServices();
      }
      
      // Restore database
      await this.restoreDatabase(extractPath);
      
      // Restore configuration
      await this.restoreConfig(extractPath);
      
      // Restore data
      await this.restoreData(extractPath);
      
      // Start services if stopped
      if (options.stopServices) {
        await this.startServices();
      }
      
      console.log('Restore completed successfully');
      return { success: true, metadata };
      
    } catch (error) {
      console.error(`Restore failed: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Verify backup integrity
   */
  async verifyBackup(backupPath) {
    const metadataPath = join(backupPath, 'metadata.json');
    if (!existsSync(metadataPath)) {
      throw new Error('Backup metadata not found');
    }
    
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    
    // Verify checksums
    for (const [file, expectedChecksum] of Object.entries(metadata.checksums)) {
      if (file === 'metadata.json') continue;
      
      const filePath = join(backupPath, file);
      if (!existsSync(filePath)) {
        throw new Error(`Missing file: ${file}`);
      }
      
      const actualChecksum = await this.calculateChecksum(filePath);
      if (actualChecksum !== expectedChecksum) {
        throw new Error(`Checksum mismatch for ${file}`);
      }
    }
    
    return metadata;
  }
  
  /**
   * Clean old backups
   */
  async cleanOldBackups() {
    const cutoff = Date.now() - (this.config.retention * 86400000);
    const backups = await fs.readdir(this.config.backupDir);
    
    for (const backup of backups) {
      const backupPath = join(this.config.backupDir, backup);
      const stat = await fs.stat(backupPath);
      
      if (stat.mtime.getTime() < cutoff) {
        console.log(`Removing old backup: ${backup}`);
        await fs.rm(backupPath, { recursive: true, force: true });
      }
    }
  }
  
  /**
   * Utility functions
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
  
  async getFilesRecursive(dir, files = []) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.getFilesRecursive(fullPath, files);
      } else {
        files.push(fullPath);
      }
    }
    
    return files;
  }
  
  async calculateChecksum(filePath) {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    
    return hash.digest('hex');
  }
  
  async notifyBackupComplete(name, path) {
    if (this.config.webhook) {
      try {
        await fetch(this.config.webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'backup_complete',
            name,
            path,
            timestamp: new Date().toISOString()
          })
        });
      } catch (error) {
        console.error('Failed to send webhook:', error);
      }
    }
  }
  
  async notifyBackupFailed(name, error) {
    if (this.config.webhook) {
      try {
        await fetch(this.config.webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'backup_failed',
            name,
            error: error.message,
            timestamp: new Date().toISOString()
          })
        });
      } catch (error) {
        console.error('Failed to send webhook:', error);
      }
    }
  }
}

/**
 * Backup scheduler using cron
 */
export class BackupScheduler {
  constructor(backupManager, schedule) {
    this.backupManager = backupManager;
    this.schedule = schedule;
    this.job = null;
  }
  
  start() {
    // Import node-cron dynamically
    import('node-cron').then(({ schedule }) => {
      this.job = schedule(this.schedule, async () => {
        try {
          await this.backupManager.createBackup('scheduled');
        } catch (error) {
          console.error('Scheduled backup failed:', error);
        }
      });
      
      console.log(`Backup scheduler started: ${this.schedule}`);
    });
  }
  
  stop() {
    if (this.job) {
      this.job.stop();
      this.job = null;
      console.log('Backup scheduler stopped');
    }
  }
}

// Export default backup manager
export const backupManager = new BackupManager();
export const backupScheduler = new BackupScheduler(backupManager, '0 2 * * *');