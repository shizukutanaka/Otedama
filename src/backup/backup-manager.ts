/**
 * Backup system implementation
 * Following principles: reliable, automated, recoverable
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createGzip, createGunzip } from 'zlib';
import { EventEmitter } from 'events';
import { Logger } from '../logging/logger';
import { PoolDatabase } from '../database/pool-database';

export interface BackupConfig {
  backupDir: string;
  maxBackups: number;
  compressionLevel?: number;
  encryptionKey?: string;
  schedule?: {
    interval: number; // milliseconds
    fullBackupInterval?: number; // milliseconds
  };
  includeRedis?: boolean;
  includeLogs?: boolean;
}

export interface BackupMetadata {
  id: string;
  timestamp: Date;
  type: 'full' | 'incremental';
  size: number;
  compressed: boolean;
  encrypted: boolean;
  files: string[];
  checksum: string;
  version: string;
}

export interface RestoreOptions {
  targetPath?: string;
  skipValidation?: boolean;
  overwrite?: boolean;
}

export class BackupManager extends EventEmitter {
  private logger: Logger;
  private backupTimer?: NodeJS.Timeout;
  private lastFullBackup?: Date;
  private isBackingUp = false;

  constructor(
    private config: BackupConfig,
    private database: PoolDatabase
  ) {
    super();
    this.logger = Logger.getInstance('BackupManager');
    this.initialize();
  }

  private async initialize(): Promise<void> {
    // Ensure backup directory exists
    await fs.mkdir(this.config.backupDir, { recursive: true });
    
    // Start scheduled backups if configured
    if (this.config.schedule) {
      this.startScheduledBackups();
    }
  }

  async createBackup(type: 'full' | 'incremental' = 'full'): Promise<BackupMetadata> {
    if (this.isBackingUp) {
      throw new Error('Backup already in progress');
    }

    this.isBackingUp = true;
    const backupId = this.generateBackupId();
    const backupPath = path.join(this.config.backupDir, backupId);

    try {
      this.logger.info(`Starting ${type} backup`, { backupId });
      this.emit('backupStarted', { backupId, type });

      // Create temporary directory for backup
      await fs.mkdir(backupPath, { recursive: true });

      const files: string[] = [];

      // Backup database
      const dbBackupFile = await this.backupDatabase(backupPath);
      files.push(dbBackupFile);

      // Backup configuration
      const configBackupFile = await this.backupConfiguration(backupPath);
      files.push(configBackupFile);

      // Backup Redis if configured
      if (this.config.includeRedis) {
        const redisBackupFile = await this.backupRedis(backupPath);
        if (redisBackupFile) files.push(redisBackupFile);
      }

      // Backup logs if configured
      if (this.config.includeLogs) {
        const logBackupFiles = await this.backupLogs(backupPath);
        files.push(...logBackupFiles);
      }

      // Create archive
      const archivePath = await this.createArchive(backupPath, backupId);

      // Calculate checksum
      const checksum = await this.calculateChecksum(archivePath);

      // Get file size
      const stats = await fs.stat(archivePath);

      // Create metadata
      const metadata: BackupMetadata = {
        id: backupId,
        timestamp: new Date(),
        type,
        size: stats.size,
        compressed: true,
        encrypted: !!this.config.encryptionKey,
        files,
        checksum,
        version: '1.0.0'
      };

      // Save metadata
      await this.saveMetadata(metadata);

      // Clean up temporary directory
      await fs.rm(backupPath, { recursive: true, force: true });

      // Clean up old backups
      await this.cleanupOldBackups();

      this.logger.info(`Backup completed successfully`, { 
        backupId, 
        size: stats.size,
        files: files.length 
      });
      
      this.emit('backupCompleted', metadata);

      if (type === 'full') {
        this.lastFullBackup = new Date();
      }

      return metadata;
    } catch (error) {
      this.logger.error('Backup failed', error, { backupId });
      this.emit('backupFailed', { backupId, error });
      
      // Clean up on failure
      try {
        await fs.rm(backupPath, { recursive: true, force: true });
        await fs.unlink(`${backupPath}.tar.gz`).catch(() => {});
      } catch {}
      
      throw error;
    } finally {
      this.isBackingUp = false;
    }
  }

  async restoreBackup(backupId: string, options: RestoreOptions = {}): Promise<void> {
    this.logger.info('Starting restore', { backupId, options });
    this.emit('restoreStarted', { backupId });

    try {
      // Load metadata
      const metadata = await this.loadMetadata(backupId);
      if (!metadata) {
        throw new Error(`Backup metadata not found: ${backupId}`);
      }

      // Verify backup file exists
      const archivePath = path.join(this.config.backupDir, `${backupId}.tar.gz`);
      await fs.access(archivePath);

      // Validate checksum
      if (!options.skipValidation) {
        const currentChecksum = await this.calculateChecksum(archivePath);
        if (currentChecksum !== metadata.checksum) {
          throw new Error('Backup checksum validation failed');
        }
      }

      // Extract archive
      const extractPath = options.targetPath || path.join(this.config.backupDir, `restore_${backupId}`);
      await fs.mkdir(extractPath, { recursive: true });
      await this.extractArchive(archivePath, extractPath);

      // Restore database
      await this.restoreDatabase(extractPath, options);

      // Restore configuration
      await this.restoreConfiguration(extractPath, options);

      // Restore Redis if included
      if (metadata.files.some(f => f.includes('redis'))) {
        await this.restoreRedis(extractPath, options);
      }

      // Clean up extraction directory
      await fs.rm(extractPath, { recursive: true, force: true });

      this.logger.info('Restore completed successfully', { backupId });
      this.emit('restoreCompleted', { backupId });
    } catch (error) {
      this.logger.error('Restore failed', error, { backupId });
      this.emit('restoreFailed', { backupId, error });
      throw error;
    }
  }

  async listBackups(): Promise<BackupMetadata[]> {
    const files = await fs.readdir(this.config.backupDir);
    const metadataFiles = files.filter(f => f.endsWith('.meta.json'));
    
    const backups: BackupMetadata[] = [];
    
    for (const file of metadataFiles) {
      try {
        const content = await fs.readFile(
          path.join(this.config.backupDir, file),
          'utf8'
        );
        const metadata = JSON.parse(content);
        backups.push(metadata);
      } catch (error) {
        this.logger.warn('Failed to read backup metadata', { file, error });
      }
    }

    // Sort by timestamp descending
    return backups.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  async deleteBackup(backupId: string): Promise<void> {
    const archivePath = path.join(this.config.backupDir, `${backupId}.tar.gz`);
    const metadataPath = path.join(this.config.backupDir, `${backupId}.meta.json`);

    await Promise.all([
      fs.unlink(archivePath).catch(() => {}),
      fs.unlink(metadataPath).catch(() => {})
    ]);

    this.logger.info('Backup deleted', { backupId });
  }

  // Private methods
  private async backupDatabase(backupPath: string): Promise<string> {
    const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'pool.db');
    const backupFile = path.join(backupPath, 'database.db');
    
    // For SQLite, simply copy the file
    await fs.copyFile(dbPath, backupFile);
    
    return 'database.db';
  }

  private async backupConfiguration(backupPath: string): Promise<string> {
    const configDir = path.join(process.cwd(), 'config');
    const backupConfigDir = path.join(backupPath, 'config');
    
    await fs.mkdir(backupConfigDir, { recursive: true });
    
    // Copy all config files
    const configFiles = await fs.readdir(configDir);
    for (const file of configFiles) {
      if (file.endsWith('.json') || file.endsWith('.yaml')) {
        await fs.copyFile(
          path.join(configDir, file),
          path.join(backupConfigDir, file)
        );
      }
    }
    
    // Also backup .env file (excluding sensitive data)
    const envPath = path.join(process.cwd(), '.env');
    try {
      const envContent = await fs.readFile(envPath, 'utf8');
      const sanitizedEnv = this.sanitizeEnvFile(envContent);
      await fs.writeFile(
        path.join(backupPath, '.env.backup'),
        sanitizedEnv
      );
    } catch {}
    
    return 'config';
  }

  private sanitizeEnvFile(content: string): string {
    const lines = content.split('\n');
    const sensitiveKeys = ['PASSWORD', 'SECRET', 'KEY', 'TOKEN'];
    
    return lines.map(line => {
      const [key, value] = line.split('=');
      if (key && sensitiveKeys.some(k => key.includes(k))) {
        return `${key}=<REDACTED>`;
      }
      return line;
    }).join('\n');
  }

  private async backupRedis(backupPath: string): Promise<string | null> {
    // This would require Redis BGSAVE command
    // For now, return null
    return null;
  }

  private async backupLogs(backupPath: string): Promise<string[]> {
    const logsDir = path.join(process.cwd(), 'logs');
    const backupLogsDir = path.join(backupPath, 'logs');
    
    try {
      await fs.mkdir(backupLogsDir, { recursive: true });
      
      const logFiles = await fs.readdir(logsDir);
      const backedUpFiles: string[] = [];
      
      for (const file of logFiles) {
        if (file.endsWith('.log')) {
          await fs.copyFile(
            path.join(logsDir, file),
            path.join(backupLogsDir, file)
          );
          backedUpFiles.push(`logs/${file}`);
        }
      }
      
      return backedUpFiles;
    } catch {
      return [];
    }
  }

  private async createArchive(sourcePath: string, backupId: string): Promise<string> {
    const archivePath = path.join(this.config.backupDir, `${backupId}.tar.gz`);
    const tar = await import('tar');
    
    await tar.create(
      {
        gzip: {
          level: this.config.compressionLevel || 6
        },
        file: archivePath,
        cwd: sourcePath
      },
      ['.']
    );

    // Encrypt if configured
    if (this.config.encryptionKey) {
      await this.encryptFile(archivePath);
    }

    return archivePath;
  }

  private async extractArchive(archivePath: string, targetPath: string): Promise<void> {
    // Decrypt if needed
    if (this.config.encryptionKey) {
      await this.decryptFile(archivePath);
    }

    const tar = await import('tar');
    await tar.extract({
      file: archivePath,
      cwd: targetPath
    });
  }

  private async encryptFile(filePath: string): Promise<void> {
    const algorithm = 'aes-256-gcm';
    const key = crypto.scryptSync(this.config.encryptionKey!, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);

    const input = createReadStream(filePath);
    const output = createWriteStream(`${filePath}.enc`);

    // Write IV and auth tag to the beginning of the file
    output.write(iv);

    await pipeline(input, cipher, output);

    const authTag = cipher.getAuthTag();
    await fs.appendFile(`${filePath}.enc`, authTag);

    // Replace original with encrypted
    await fs.unlink(filePath);
    await fs.rename(`${filePath}.enc`, filePath);
  }

  private async decryptFile(filePath: string): Promise<void> {
    // Implementation would decrypt the file
    // For now, this is a placeholder
  }

  private async calculateChecksum(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    
    return hash.digest('hex');
  }

  private async saveMetadata(metadata: BackupMetadata): Promise<void> {
    const metadataPath = path.join(
      this.config.backupDir,
      `${metadata.id}.meta.json`
    );
    
    await fs.writeFile(
      metadataPath,
      JSON.stringify(metadata, null, 2)
    );
  }

  private async loadMetadata(backupId: string): Promise<BackupMetadata | null> {
    try {
      const metadataPath = path.join(
        this.config.backupDir,
        `${backupId}.meta.json`
      );
      
      const content = await fs.readFile(metadataPath, 'utf8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private async restoreDatabase(extractPath: string, options: RestoreOptions): Promise<void> {
    const dbBackupPath = path.join(extractPath, 'database.db');
    const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'pool.db');

    if (!options.overwrite) {
      // Create backup of current database
      const backupPath = `${dbPath}.backup.${Date.now()}`;
      await fs.copyFile(dbPath, backupPath).catch(() => {});
    }

    await fs.copyFile(dbBackupPath, dbPath);
  }

  private async restoreConfiguration(extractPath: string, options: RestoreOptions): Promise<void> {
    // Restore config files
    const configBackupDir = path.join(extractPath, 'config');
    const configDir = path.join(process.cwd(), 'config');

    try {
      const files = await fs.readdir(configBackupDir);
      for (const file of files) {
        await fs.copyFile(
          path.join(configBackupDir, file),
          path.join(configDir, file)
        );
      }
    } catch {}
  }

  private async restoreRedis(extractPath: string, options: RestoreOptions): Promise<void> {
    // Redis restore would be implemented here
  }

  private async cleanupOldBackups(): Promise<void> {
    const backups = await this.listBackups();
    
    if (backups.length > this.config.maxBackups) {
      // Keep the most recent backups
      const toDelete = backups.slice(this.config.maxBackups);
      
      for (const backup of toDelete) {
        await this.deleteBackup(backup.id);
      }
      
      this.logger.info('Cleaned up old backups', { deleted: toDelete.length });
    }
  }

  private generateBackupId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const random = crypto.randomBytes(4).toString('hex');
    return `backup_${timestamp}_${random}`;
  }

  private startScheduledBackups(): void {
    const { interval, fullBackupInterval } = this.config.schedule!;

    this.backupTimer = setInterval(async () => {
      try {
        const shouldDoFullBackup = !this.lastFullBackup || 
          (fullBackupInterval && 
           Date.now() - this.lastFullBackup.getTime() >= fullBackupInterval);

        const type = shouldDoFullBackup ? 'full' : 'incremental';
        await this.createBackup(type);
      } catch (error) {
        this.logger.error('Scheduled backup failed', error);
      }
    }, interval);
  }

  stop(): void {
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = undefined;
    }
  }
}

// Backup verification utility
export class BackupVerifier {
  static async verify(backupPath: string, metadata: BackupMetadata): Promise<boolean> {
    try {
      // Verify file exists
      await fs.access(backupPath);

      // Verify size
      const stats = await fs.stat(backupPath);
      if (stats.size !== metadata.size) {
        return false;
      }

      // Verify checksum
      const checksum = await this.calculateChecksum(backupPath);
      return checksum === metadata.checksum;
    } catch {
      return false;
    }
  }

  private static async calculateChecksum(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    
    return hash.digest('hex');
  }
}
