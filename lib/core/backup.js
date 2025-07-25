/**
 * Backup & Restore System - Otedama
 * Automated backup and disaster recovery
 * 
 * Design: Data is precious, protect it (Pike)
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import { promisify } from 'util';
import { StorageError } from './errors.js';
import { createLogger } from './logger.js';

const logger = createLogger('Backup');

/**
 * Backup metadata
 */
export class BackupMetadata {
  constructor(data = {}) {
    this.version = data.version || '1.0';
    this.timestamp = data.timestamp || new Date().toISOString();
    this.type = data.type || 'full';
    this.compressed = data.compressed !== false;
    this.encrypted = data.encrypted || false;
    this.checksum = data.checksum || null;
    this.size = data.size || 0;
    this.files = data.files || [];
    this.database = data.database || null;
    this.custom = data.custom || {};
  }
  
  toJSON() {
    return {
      version: this.version,
      timestamp: this.timestamp,
      type: this.type,
      compressed: this.compressed,
      encrypted: this.encrypted,
      checksum: this.checksum,
      size: this.size,
      files: this.files,
      database: this.database,
      custom: this.custom
    };
  }
  
  static fromJSON(json) {
    return new BackupMetadata(json);
  }
}

/**
 * Backup manager
 */
export class BackupManager {
  constructor(options = {}) {
    this.options = {
      backupDir: options.backupDir || './backups',
      maxBackups: options.maxBackups || 10,
      compress: options.compress !== false,
      encryption: options.encryption || null, // { algorithm: 'aes-256-gcm', key: Buffer }
      schedule: options.schedule || null, // cron expression
      ...options
    };
    
    this.scheduleTimer = null;
  }
  
  /**
   * Initialize backup system
   */
  async initialize() {
    logger.info('Initializing backup system...');
    
    // Create backup directory
    await fs.mkdir(this.options.backupDir, { recursive: true });
    
    // Start scheduled backups if configured
    if (this.options.schedule) {
      this.startSchedule();
    }
    
    logger.info('Backup system initialized');
  }
  
  /**
   * Create backup
   */
  async createBackup(sources, options = {}) {
    const startTime = Date.now();
    const backupId = this.generateBackupId();
    const backupDir = path.join(this.options.backupDir, backupId);
    
    logger.info(`Creating backup ${backupId}...`);
    
    try {
      // Create backup directory
      await fs.mkdir(backupDir, { recursive: true });
      
      // Backup metadata
      const metadata = new BackupMetadata({
        type: options.type || 'full',
        compressed: options.compress !== false && this.options.compress,
        encrypted: !!this.options.encryption,
        custom: options.metadata || {}
      });
      
      // Backup files
      if (sources.files && sources.files.length > 0) {
        await this.backupFiles(sources.files, backupDir, metadata);
      }
      
      // Backup database
      if (sources.database) {
        await this.backupDatabase(sources.database, backupDir, metadata);
      }
      
      // Create archive if requested
      let archivePath = null;
      if (options.archive !== false) {
        archivePath = await this.createArchive(backupDir, metadata);
        
        // Remove temporary directory
        await fs.rm(backupDir, { recursive: true, force: true });
      }
      
      // Calculate size
      if (archivePath) {
        const stat = await fs.stat(archivePath);
        metadata.size = stat.size;
      }
      
      // Save metadata
      const metadataPath = archivePath 
        ? archivePath.replace(/\.(tar\.gz|zip)$/, '.json')
        : path.join(backupDir, 'metadata.json');
      
      await fs.writeFile(
        metadataPath,
        JSON.stringify(metadata.toJSON(), null, 2)
      );
      
      // Cleanup old backups
      await this.cleanupOldBackups();
      
      const duration = Date.now() - startTime;
      logger.info(`Backup ${backupId} created successfully in ${duration}ms`);
      
      return {
        id: backupId,
        path: archivePath || backupDir,
        metadata,
        duration
      };
      
    } catch (error) {
      logger.error(`Backup ${backupId} failed:`, error);
      
      // Cleanup on failure
      try {
        await fs.rm(backupDir, { recursive: true, force: true });
      } catch (cleanupError) {
        logger.error(`Failed to cleanup backup directory ${backupDir}:`, cleanupError);
      }
      
      throw new StorageError(`Backup failed: ${error.message}`);
    }
  }
  
  /**
   * Backup files
   */
  async backupFiles(files, backupDir, metadata) {
    const filesDir = path.join(backupDir, 'files');
    await fs.mkdir(filesDir, { recursive: true });
    
    for (const file of files) {
      const source = typeof file === 'string' ? file : file.path;
      const dest = typeof file === 'string' 
        ? path.join(filesDir, path.basename(file))
        : path.join(filesDir, file.name || path.basename(file.path));
      
      try {
        await fs.copyFile(source, dest);
        
        metadata.files.push({
          source,
          name: path.basename(dest),
          size: (await fs.stat(dest)).size
        });
        
      } catch (error) {
        logger.warn(`Failed to backup file ${source}:`, error.message);
      }
    }
  }
  
  /**
   * Backup database
   */
  async backupDatabase(db, backupDir, metadata) {
    const dbBackupPath = path.join(backupDir, 'database.db');
    
    // Use SQLite backup API
    await db.backup(dbBackupPath);
    
    const stat = await fs.stat(dbBackupPath);
    
    metadata.database = {
      type: 'sqlite',
      size: stat.size,
      tables: await this.getDatabaseTables(db)
    };
  }
  
  /**
   * Get database tables
   */
  async getDatabaseTables(db) {
    const tables = await db.all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    );
    
    const tableInfo = [];
    
    for (const table of tables) {
      const count = await db.get(
        `SELECT COUNT(*) as count FROM ${table.name}`
      );
      
      tableInfo.push({
        name: table.name,
        rows: count.count
      });
    }
    
    return tableInfo;
  }
  
  /**
   * Create archive
   */
  async createArchive(backupDir, metadata) {
    const archiveName = `${path.basename(backupDir)}.tar.gz`;
    const archivePath = path.join(this.options.backupDir, archiveName);
    
    // Create tar archive
    const tar = require('tar');
    
    await tar.create({
      gzip: metadata.compressed,
      file: archivePath,
      cwd: this.options.backupDir,
      filter: (path) => !path.endsWith('.tar.gz')
    }, [path.basename(backupDir)]);
    
    // Encrypt if configured
    if (this.options.encryption) {
      const encryptedPath = `${archivePath}.enc`;
      await this.encryptFile(archivePath, encryptedPath);
      
      // Remove unencrypted archive
      await fs.unlink(archivePath);
      
      return encryptedPath;
    }
    
    // Calculate checksum
    metadata.checksum = await this.calculateChecksum(archivePath);
    
    return archivePath;
  }
  
  /**
   * Restore backup
   */
  async restoreBackup(backupId, options = {}) {
    const startTime = Date.now();
    
    logger.info(`Restoring backup ${backupId}...`);
    
    try {
      // Find backup
      const backup = await this.findBackup(backupId);
      if (!backup) {
        throw new StorageError(`Backup ${backupId} not found`);
      }
      
      // Load metadata
      const metadata = await this.loadMetadata(backup.path);
      
      // Verify checksum
      if (metadata.checksum && options.verifyChecksum !== false) {
        await this.verifyChecksum(backup.path, metadata.checksum);
      }
      
      // Extract archive
      const extractDir = await this.extractArchive(backup.path, metadata);
      
      // Restore files
      if (metadata.files.length > 0 && options.restoreFiles !== false) {
        await this.restoreFiles(extractDir, metadata, options);
      }
      
      // Restore database
      if (metadata.database && options.restoreDatabase !== false) {
        await this.restoreDatabase(extractDir, metadata, options);
      }
      
      // Cleanup
      await fs.rm(extractDir, { recursive: true, force: true });
      
      const duration = Date.now() - startTime;
      logger.info(`Backup ${backupId} restored successfully in ${duration}ms`);
      
      return {
        id: backupId,
        metadata,
        duration
      };
      
    } catch (error) {
      logger.error(`Restore of backup ${backupId} failed:`, error);
      throw new StorageError(`Restore failed: ${error.message}`);
    }
  }
  
  /**
   * Find backup
   */
  async findBackup(backupId) {
    const files = await fs.readdir(this.options.backupDir);
    
    for (const file of files) {
      if (file.includes(backupId)) {
        return {
          id: backupId,
          path: path.join(this.options.backupDir, file)
        };
      }
    }
    
    return null;
  }
  
  /**
   * Load metadata
   */
  async loadMetadata(backupPath) {
    let metadataPath;
    
    if (backupPath.endsWith('.json')) {
      metadataPath = backupPath;
    } else {
      metadataPath = backupPath.replace(/\.(tar\.gz|zip|enc)$/, '.json');
    }
    
    const data = await fs.readFile(metadataPath, 'utf8');
    return BackupMetadata.fromJSON(JSON.parse(data));
  }
  
  /**
   * Extract archive
   */
  async extractArchive(archivePath, metadata) {
    const extractDir = path.join(
      this.options.backupDir,
      `restore-${Date.now()}`
    );
    
    await fs.mkdir(extractDir, { recursive: true });
    
    let actualPath = archivePath;
    
    // Decrypt if needed
    if (metadata.encrypted) {
      const decryptedPath = path.join(extractDir, 'backup.tar.gz');
      await this.decryptFile(archivePath, decryptedPath);
      actualPath = decryptedPath;
    }
    
    // Extract tar
    const tar = require('tar');
    
    await tar.extract({
      file: actualPath,
      cwd: extractDir
    });
    
    // Find extracted directory
    const dirs = await fs.readdir(extractDir);
    const backupDir = dirs.find(d => d.startsWith('backup-'));
    
    return path.join(extractDir, backupDir);
  }
  
  /**
   * Restore files
   */
  async restoreFiles(extractDir, metadata, options) {
    const filesDir = path.join(extractDir, 'files');
    const targetDir = options.targetDir || './restored-files';
    
    await fs.mkdir(targetDir, { recursive: true });
    
    for (const file of metadata.files) {
      const source = path.join(filesDir, file.name);
      const dest = path.join(targetDir, file.name);
      
      try {
        await fs.copyFile(source, dest);
        logger.info(`Restored file: ${file.name}`);
      } catch (error) {
        logger.warn(`Failed to restore file ${file.name}:`, error.message);
      }
    }
  }
  
  /**
   * Restore database
   */
  async restoreDatabase(extractDir, metadata, options) {
    if (!options.database) {
      throw new StorageError('Database connection required for restore');
    }
    
    const dbBackupPath = path.join(extractDir, 'database.db');
    
    // Close existing connections
    await options.database.close();
    
    // Copy database file
    const dbPath = options.databasePath || './data/otedama.db';
    
    // Backup current database
    const currentBackup = `${dbPath}.backup-${Date.now()}`;
    try {
      await fs.copyFile(dbPath, currentBackup);
    } catch (backupError) {
      logger.warn(`Failed to create backup of current database:`, backupError);
      // Continue with restore, but warn user
    }
    
    // Restore database
    await fs.copyFile(dbBackupPath, dbPath);
    
    logger.info('Database restored successfully');
  }
  
  /**
   * List backups
   */
  async listBackups() {
    const files = await fs.readdir(this.options.backupDir);
    const backups = [];
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const metadataPath = path.join(this.options.backupDir, file);
          const data = await fs.readFile(metadataPath, 'utf8');
          const metadata = BackupMetadata.fromJSON(JSON.parse(data));
          
          backups.push({
            id: file.replace('.json', '').replace(/\.(tar\.gz|zip|enc)$/, ''),
            timestamp: metadata.timestamp,
            type: metadata.type,
            size: metadata.size,
            compressed: metadata.compressed,
            encrypted: metadata.encrypted
          });
        } catch (metadataError) {
          logger.warn(`Failed to read metadata for backup ${file}:`, metadataError);
          // Skip this backup file and continue with others
        }
      }
    }
    
    return backups.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }
  
  /**
   * Cleanup old backups
   */
  async cleanupOldBackups() {
    const backups = await this.listBackups();
    
    if (backups.length <= this.options.maxBackups) {
      return;
    }
    
    const toDelete = backups.slice(this.options.maxBackups);
    
    for (const backup of toDelete) {
      try {
        // Find all related files
        const files = await fs.readdir(this.options.backupDir);
        const relatedFiles = files.filter(f => f.includes(backup.id));
        
        for (const file of relatedFiles) {
          await fs.unlink(path.join(this.options.backupDir, file));
        }
        
        logger.info(`Deleted old backup: ${backup.id}`);
      } catch (error) {
        logger.warn(`Failed to delete backup ${backup.id}:`, error.message);
      }
    }
  }
  
  /**
   * Generate backup ID
   */
  generateBackupId() {
    const timestamp = new Date().toISOString()
      .replace(/[^\d]/g, '')
      .substring(0, 14);
    
    const random = crypto.randomBytes(4).toString('hex');
    
    return `backup-${timestamp}-${random}`;
  }
  
  /**
   * Calculate checksum
   */
  async calculateChecksum(filePath) {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    
    return hash.digest('hex');
  }
  
  /**
   * Verify checksum
   */
  async verifyChecksum(filePath, expectedChecksum) {
    const actualChecksum = await this.calculateChecksum(filePath);
    
    if (actualChecksum !== expectedChecksum) {
      throw new StorageError(
        `Checksum verification failed. ` +
        `Expected: ${expectedChecksum}, ` +
        `Actual: ${actualChecksum}`
      );
    }
  }
  
  /**
   * Encrypt file
   */
  async encryptFile(inputPath, outputPath) {
    if (!this.options.encryption) {
      throw new StorageError('Encryption not configured');
    }
    
    const { algorithm, key } = this.options.encryption;
    const iv = crypto.randomBytes(16);
    
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    const input = createReadStream(inputPath);
    const output = createWriteStream(outputPath);
    
    // Write IV at the beginning
    output.write(iv);
    
    await pipeline(input, cipher, output);
  }
  
  /**
   * Decrypt file
   */
  async decryptFile(inputPath, outputPath) {
    if (!this.options.encryption) {
      throw new StorageError('Encryption not configured');
    }
    
    const { algorithm, key } = this.options.encryption;
    
    // Read IV from file
    const fd = await fs.open(inputPath, 'r');
    const iv = Buffer.alloc(16);
    await fd.read(iv, 0, 16, 0);
    await fd.close();
    
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    const input = createReadStream(inputPath, { start: 16 });
    const output = createWriteStream(outputPath);
    
    await pipeline(input, decipher, output);
  }
  
  /**
   * Start scheduled backups
   */
  startSchedule() {
    // Simple interval-based scheduling
    const interval = this.parseSchedule(this.options.schedule);
    
    this.scheduleTimer = setInterval(async () => {
      try {
        logger.info('Running scheduled backup...');
        
        await this.createBackup({
          database: true,
          files: this.options.scheduledFiles || []
        }, {
          type: 'scheduled',
          metadata: { scheduled: true }
        });
        
      } catch (error) {
        logger.error('Scheduled backup failed:', error);
      }
    }, interval);
    
    logger.info(`Scheduled backups enabled: ${this.options.schedule}`);
  }
  
  /**
   * Stop scheduled backups
   */
  stopSchedule() {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
      logger.info('Scheduled backups disabled');
    }
  }
  
  /**
   * Parse schedule expression
   */
  parseSchedule(schedule) {
    // Simple parsing for now
    const match = schedule.match(/^every (\d+) (hours?|days?)$/i);
    
    if (!match) {
      throw new Error('Invalid schedule format');
    }
    
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    
    if (unit.startsWith('hour')) {
      return value * 60 * 60 * 1000;
    } else if (unit.startsWith('day')) {
      return value * 24 * 60 * 60 * 1000;
    }
    
    throw new Error('Invalid schedule unit');
  }
}

export default {
  BackupMetadata,
  BackupManager
};
