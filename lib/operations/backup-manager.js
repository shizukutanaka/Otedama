const { EventEmitter } = require('events');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Backup and Disaster Recovery Manager
 * Automated backups with encryption and redundancy
 */
class BackupManager extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            // Backup settings
            backupDir: config.backupDir || './backups',
            tempDir: config.tempDir || './temp',
            
            // Schedule
            schedule: {
                full: config.schedule?.full || '0 2 * * *', // 2 AM daily
                incremental: config.schedule?.incremental || '0 * * * *', // Every hour
                snapshot: config.schedule?.snapshot || '*/15 * * * *' // Every 15 minutes
            },
            
            // Retention policies
            retention: {
                full: config.retention?.full || 30, // 30 days
                incremental: config.retention?.incremental || 7, // 7 days
                snapshot: config.retention?.snapshot || 1 // 1 day
            },
            
            // Backup targets
            targets: {
                database: config.targets?.database !== false,
                files: config.targets?.files !== false,
                config: config.targets?.config !== false,
                logs: config.targets?.logs !== false,
                state: config.targets?.state !== false
            },
            
            // Encryption
            encryption: {
                enabled: config.encryption?.enabled !== false,
                algorithm: config.encryption?.algorithm || 'aes-256-gcm',
                key: config.encryption?.key || null
            },
            
            // Compression
            compression: {
                enabled: config.compression?.enabled !== false,
                level: config.compression?.level || 6
            },
            
            // Redundancy
            redundancy: {
                enabled: config.redundancy?.enabled || false,
                locations: config.redundancy?.locations || []
            },
            
            // Verification
            verification: {
                enabled: config.verification?.enabled !== false,
                checksum: config.verification?.checksum || 'sha256'
            },
            
            ...config
        };
        
        // Backup state
        this.backupState = {
            lastFull: null,
            lastIncremental: null,
            lastSnapshot: null,
            inProgress: false,
            history: []
        };
        
        // Initialize encryption key
        if (this.config.encryption.enabled && !this.config.encryption.key) {
            this.config.encryption.key = crypto.randomBytes(32);
            console.warn('Generated backup encryption key:', this.config.encryption.key.toString('hex'));
        }
        
        // Ensure directories exist
        this.initializeDirectories();
    }
    
    // Initialize directories
    async initializeDirectories() {
        try {
            await fs.mkdir(this.config.backupDir, { recursive: true });
            await fs.mkdir(this.config.tempDir, { recursive: true });
            
            for (const location of this.config.redundancy.locations) {
                await fs.mkdir(location, { recursive: true });
            }
        } catch (error) {
            this.emit('error', { operation: 'initialize', error });
        }
    }
    
    // Perform full backup
    async performFullBackup() {
        if (this.backupState.inProgress) {
            throw new Error('Backup already in progress');
        }
        
        this.backupState.inProgress = true;
        const startTime = Date.now();
        const backupId = this.generateBackupId('full');
        
        this.emit('backup-start', { type: 'full', id: backupId });
        
        try {
            const manifest = {
                id: backupId,
                type: 'full',
                timestamp: startTime,
                items: []
            };
            
            // Backup database
            if (this.config.targets.database) {
                const dbBackup = await this.backupDatabase(backupId);
                manifest.items.push(dbBackup);
            }
            
            // Backup files
            if (this.config.targets.files) {
                const filesBackup = await this.backupFiles(backupId);
                manifest.items.push(...filesBackup);
            }
            
            // Backup configuration
            if (this.config.targets.config) {
                const configBackup = await this.backupConfig(backupId);
                manifest.items.push(configBackup);
            }
            
            // Backup logs
            if (this.config.targets.logs) {
                const logsBackup = await this.backupLogs(backupId);
                manifest.items.push(logsBackup);
            }
            
            // Backup state
            if (this.config.targets.state) {
                const stateBackup = await this.backupState(backupId);
                manifest.items.push(stateBackup);
            }
            
            // Save manifest
            await this.saveManifest(backupId, manifest);
            
            // Verify backup
            if (this.config.verification.enabled) {
                await this.verifyBackup(backupId, manifest);
            }
            
            // Copy to redundant locations
            if (this.config.redundancy.enabled) {
                await this.replicateBackup(backupId);
            }
            
            // Update state
            this.backupState.lastFull = {
                id: backupId,
                timestamp: startTime,
                duration: Date.now() - startTime,
                size: await this.calculateBackupSize(backupId),
                items: manifest.items.length
            };
            
            this.recordBackupHistory('full', backupId, true);
            
            this.emit('backup-complete', {
                type: 'full',
                id: backupId,
                duration: Date.now() - startTime
            });
            
            // Clean old backups
            await this.cleanOldBackups('full');
            
        } catch (error) {
            this.recordBackupHistory('full', backupId, false, error.message);
            this.emit('backup-error', { type: 'full', id: backupId, error });
            throw error;
        } finally {
            this.backupState.inProgress = false;
        }
    }
    
    // Perform incremental backup
    async performIncrementalBackup() {
        if (!this.backupState.lastFull) {
            return this.performFullBackup();
        }
        
        if (this.backupState.inProgress) {
            throw new Error('Backup already in progress');
        }
        
        this.backupState.inProgress = true;
        const startTime = Date.now();
        const backupId = this.generateBackupId('incremental');
        
        this.emit('backup-start', { type: 'incremental', id: backupId });
        
        try {
            const manifest = {
                id: backupId,
                type: 'incremental',
                baseBackup: this.backupState.lastFull.id,
                timestamp: startTime,
                items: []
            };
            
            // Get changes since last backup
            const lastBackupTime = this.backupState.lastIncremental?.timestamp || 
                                 this.backupState.lastFull.timestamp;
            
            // Backup changed database records
            if (this.config.targets.database) {
                const dbChanges = await this.backupDatabaseChanges(backupId, lastBackupTime);
                if (dbChanges) manifest.items.push(dbChanges);
            }
            
            // Backup changed files
            if (this.config.targets.files) {
                const fileChanges = await this.backupChangedFiles(backupId, lastBackupTime);
                manifest.items.push(...fileChanges);
            }
            
            // Save manifest
            await this.saveManifest(backupId, manifest);
            
            // Update state
            this.backupState.lastIncremental = {
                id: backupId,
                timestamp: startTime,
                duration: Date.now() - startTime,
                size: await this.calculateBackupSize(backupId),
                items: manifest.items.length
            };
            
            this.recordBackupHistory('incremental', backupId, true);
            
            this.emit('backup-complete', {
                type: 'incremental',
                id: backupId,
                duration: Date.now() - startTime
            });
            
            await this.cleanOldBackups('incremental');
            
        } catch (error) {
            this.recordBackupHistory('incremental', backupId, false, error.message);
            this.emit('backup-error', { type: 'incremental', id: backupId, error });
            throw error;
        } finally {
            this.backupState.inProgress = false;
        }
    }
    
    // Backup database
    async backupDatabase(backupId) {
        if (!this.config.database) {
            return null;
        }
        
        const filename = `database-${Date.now()}.sql`;
        const tempPath = path.join(this.config.tempDir, filename);
        const backupPath = path.join(this.config.backupDir, backupId, filename);
        
        try {
            // Export database
            await this.exportDatabase(tempPath);
            
            // Process file (compress/encrypt)
            await this.processBackupFile(tempPath, backupPath);
            
            // Clean temp file
            await fs.unlink(tempPath);
            
            return {
                type: 'database',
                filename: filename,
                size: (await fs.stat(backupPath)).size,
                checksum: await this.calculateChecksum(backupPath)
            };
            
        } catch (error) {
            throw new Error(`Database backup failed: ${error.message}`);
        }
    }
    
    // Export database
    async exportDatabase(outputPath) {
        // Implementation depends on database type
        if (this.config.database.type === 'mysql') {
            const { exec } = require('child_process').promises;
            const cmd = `mysqldump -h ${this.config.database.host} ` +
                       `-u ${this.config.database.user} ` +
                       `-p${this.config.database.password} ` +
                       `${this.config.database.database} > ${outputPath}`;
            
            await exec(cmd);
        } else if (this.config.database.type === 'sqlite') {
            await fs.copyFile(this.config.database.path, outputPath);
        }
    }
    
    // Backup files
    async backupFiles(backupId) {
        const items = [];
        const filesToBackup = this.config.filePaths || ['./data', './config'];
        
        for (const filePath of filesToBackup) {
            try {
                const stat = await fs.stat(filePath);
                
                if (stat.isDirectory()) {
                    const archiveName = `${path.basename(filePath)}-${Date.now()}.tar.gz`;
                    const backupPath = path.join(this.config.backupDir, backupId, archiveName);
                    
                    await this.archiveDirectory(filePath, backupPath);
                    
                    items.push({
                        type: 'directory',
                        source: filePath,
                        filename: archiveName,
                        size: (await fs.stat(backupPath)).size,
                        checksum: await this.calculateChecksum(backupPath)
                    });
                } else {
                    const filename = `${path.basename(filePath)}-${Date.now()}`;
                    const backupPath = path.join(this.config.backupDir, backupId, filename);
                    
                    await this.processBackupFile(filePath, backupPath);
                    
                    items.push({
                        type: 'file',
                        source: filePath,
                        filename: filename,
                        size: (await fs.stat(backupPath)).size,
                        checksum: await this.calculateChecksum(backupPath)
                    });
                }
            } catch (error) {
                this.emit('backup-warning', {
                    message: `Failed to backup ${filePath}: ${error.message}`
                });
            }
        }
        
        return items;
    }
    
    // Process backup file (compress and encrypt)
    async processBackupFile(sourcePath, destPath) {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        
        let data = await fs.readFile(sourcePath);
        
        // Compress
        if (this.config.compression.enabled) {
            data = await gzip(data, { level: this.config.compression.level });
        }
        
        // Encrypt
        if (this.config.encryption.enabled) {
            data = await this.encryptData(data);
        }
        
        await fs.writeFile(destPath, data);
    }
    
    // Encrypt data
    async encryptData(data) {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(
            this.config.encryption.algorithm,
            this.config.encryption.key,
            iv
        );
        
        const encrypted = Buffer.concat([
            cipher.update(data),
            cipher.final()
        ]);
        
        let result = Buffer.concat([iv, encrypted]);
        
        if (this.config.encryption.algorithm.includes('gcm')) {
            const tag = cipher.getAuthTag();
            result = Buffer.concat([result, tag]);
        }
        
        return result;
    }
    
    // Decrypt data
    async decryptData(data) {
        const iv = data.slice(0, 16);
        let encrypted = data.slice(16);
        let authTag;
        
        if (this.config.encryption.algorithm.includes('gcm')) {
            authTag = encrypted.slice(-16);
            encrypted = encrypted.slice(0, -16);
        }
        
        const decipher = crypto.createDecipheriv(
            this.config.encryption.algorithm,
            this.config.encryption.key,
            iv
        );
        
        if (authTag) {
            decipher.setAuthTag(authTag);
        }
        
        return Buffer.concat([
            decipher.update(encrypted),
            decipher.final()
        ]);
    }
    
    // Restore from backup
    async restoreBackup(backupId, options = {}) {
        this.emit('restore-start', { id: backupId });
        
        try {
            // Load manifest
            const manifest = await this.loadManifest(backupId);
            
            // Verify backup integrity
            if (this.config.verification.enabled && !options.skipVerification) {
                await this.verifyBackup(backupId, manifest);
            }
            
            // Restore in order
            for (const item of manifest.items) {
                await this.restoreItem(backupId, item, options);
            }
            
            this.emit('restore-complete', { id: backupId });
            
        } catch (error) {
            this.emit('restore-error', { id: backupId, error });
            throw error;
        }
    }
    
    // Restore single item
    async restoreItem(backupId, item, options) {
        const backupPath = path.join(this.config.backupDir, backupId, item.filename);
        
        // Read and decrypt/decompress
        let data = await fs.readFile(backupPath);
        
        if (this.config.encryption.enabled) {
            data = await this.decryptData(data);
        }
        
        if (this.config.compression.enabled) {
            data = await gunzip(data);
        }
        
        // Restore based on type
        switch (item.type) {
            case 'database':
                await this.restoreDatabase(data, options);
                break;
            case 'file':
                await this.restoreFile(item.source, data, options);
                break;
            case 'directory':
                await this.restoreDirectory(item.source, data, options);
                break;
        }
    }
    
    // Verify backup integrity
    async verifyBackup(backupId, manifest) {
        for (const item of manifest.items) {
            const backupPath = path.join(this.config.backupDir, backupId, item.filename);
            const checksum = await this.calculateChecksum(backupPath);
            
            if (checksum !== item.checksum) {
                throw new Error(`Checksum mismatch for ${item.filename}`);
            }
        }
    }
    
    // Calculate checksum
    async calculateChecksum(filePath) {
        const hash = crypto.createHash(this.config.verification.checksum);
        const stream = require('fs').createReadStream(filePath);
        
        return new Promise((resolve, reject) => {
            stream.on('data', data => hash.update(data));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', reject);
        });
    }
    
    // Generate backup ID
    generateBackupId(type) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        return `${type}-${timestamp}`;
    }
    
    // Save manifest
    async saveManifest(backupId, manifest) {
        const manifestPath = path.join(this.config.backupDir, backupId, 'manifest.json');
        await fs.mkdir(path.dirname(manifestPath), { recursive: true });
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    }
    
    // Load manifest
    async loadManifest(backupId) {
        const manifestPath = path.join(this.config.backupDir, backupId, 'manifest.json');
        const data = await fs.readFile(manifestPath, 'utf8');
        return JSON.parse(data);
    }
    
    // Clean old backups
    async cleanOldBackups(type) {
        const retention = this.config.retention[type];
        const cutoff = Date.now() - (retention * 24 * 60 * 60 * 1000);
        
        try {
            const backups = await fs.readdir(this.config.backupDir);
            
            for (const backup of backups) {
                if (!backup.startsWith(type)) continue;
                
                const backupPath = path.join(this.config.backupDir, backup);
                const stat = await fs.stat(backupPath);
                
                if (stat.mtime.getTime() < cutoff) {
                    await fs.rm(backupPath, { recursive: true });
                    this.emit('backup-cleaned', { id: backup, type });
                }
            }
        } catch (error) {
            this.emit('cleanup-error', error);
        }
    }
    
    // Record backup history
    recordBackupHistory(type, id, success, error = null) {
        this.backupState.history.push({
            type,
            id,
            timestamp: Date.now(),
            success,
            error
        });
        
        // Keep only last 1000 entries
        if (this.backupState.history.length > 1000) {
            this.backupState.history = this.backupState.history.slice(-1000);
        }
    }
    
    // Get backup status
    getBackupStatus() {
        return {
            inProgress: this.backupState.inProgress,
            lastFull: this.backupState.lastFull,
            lastIncremental: this.backupState.lastIncremental,
            lastSnapshot: this.backupState.lastSnapshot,
            recentHistory: this.backupState.history.slice(-10),
            nextScheduled: this.getNextScheduledBackup()
        };
    }
    
    // Get next scheduled backup
    getNextScheduledBackup() {
        // Would use cron parser to calculate next run times
        return {
            full: new Date(Date.now() + 86400000), // Next day
            incremental: new Date(Date.now() + 3600000), // Next hour
            snapshot: new Date(Date.now() + 900000) // Next 15 minutes
        };
    }
    
    // Calculate backup size
    async calculateBackupSize(backupId) {
        const backupPath = path.join(this.config.backupDir, backupId);
        let totalSize = 0;
        
        const files = await fs.readdir(backupPath);
        for (const file of files) {
            const stat = await fs.stat(path.join(backupPath, file));
            totalSize += stat.size;
        }
        
        return totalSize;
    }
    
    // Archive directory
    async archiveDirectory(sourcePath, destPath) {
        // Would use tar or similar to create archive
        // Simplified version using zip
        const archiver = require('archiver');
        const output = require('fs').createWriteStream(destPath);
        const archive = archiver('tar', { gzip: true });
        
        return new Promise((resolve, reject) => {
            output.on('close', resolve);
            archive.on('error', reject);
            
            archive.pipe(output);
            archive.directory(sourcePath, false);
            archive.finalize();
        });
    }
    
    // Replicate backup to redundant locations
    async replicateBackup(backupId) {
        const backupPath = path.join(this.config.backupDir, backupId);
        
        for (const location of this.config.redundancy.locations) {
            try {
                const destPath = path.join(location, backupId);
                await this.copyDirectory(backupPath, destPath);
                
                this.emit('backup-replicated', {
                    id: backupId,
                    location
                });
            } catch (error) {
                this.emit('replication-error', {
                    id: backupId,
                    location,
                    error
                });
            }
        }
    }
    
    // Copy directory recursively
    async copyDirectory(source, dest) {
        await fs.mkdir(dest, { recursive: true });
        const entries = await fs.readdir(source, { withFileTypes: true });
        
        for (const entry of entries) {
            const srcPath = path.join(source, entry.name);
            const destPath = path.join(dest, entry.name);
            
            if (entry.isDirectory()) {
                await this.copyDirectory(srcPath, destPath);
            } else {
                await fs.copyFile(srcPath, destPath);
            }
        }
    }
}

module.exports = BackupManager;