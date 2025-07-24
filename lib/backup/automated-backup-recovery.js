/**
 * Automated Backup and Recovery System
 * 自動バックアップとリカバリシステム
 */

const { EventEmitter } = require('events');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { createReadStream, createWriteStream } = require('fs');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');
const { Worker } = require('worker_threads');

class AutomatedBackupRecovery extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Backup configuration
            backupDirectory: config.backupDirectory || './backups',
            backupSchedule: config.backupSchedule || '0 2 * * *', // 2 AM daily
            maxBackups: config.maxBackups || 30,
            compressionLevel: config.compressionLevel || 6,
            
            // Data sources
            dataSources: config.dataSources || [
                { type: 'database', path: './data/otedama.db' },
                { type: 'config', path: './config' },
                { type: 'logs', path: './logs', maxAge: 7 }, // 7 days
                { type: 'state', path: './state' }
            ],
            
            // Recovery configuration
            verifyBackups: config.verifyBackups !== false,
            parallelProcessing: config.parallelProcessing !== false,
            maxParallelJobs: config.maxParallelJobs || 4,
            
            // Encryption
            enableEncryption: config.enableEncryption || false,
            encryptionKey: config.encryptionKey || null,
            encryptionAlgorithm: config.encryptionAlgorithm || 'aes-256-gcm',
            
            // Incremental backups
            enableIncremental: config.enableIncremental !== false,
            fullBackupInterval: config.fullBackupInterval || 7, // days
            
            // Remote storage
            remoteStorage: config.remoteStorage || null, // s3, azure, gcs
            remoteConfig: config.remoteConfig || {},
            
            // Monitoring
            enableMonitoring: config.enableMonitoring !== false,
            alertWebhook: config.alertWebhook || null,
            
            // Retention
            retentionDays: config.retentionDays || 30,
            archiveOldBackups: config.archiveOldBackups || false,
            archiveDirectory: config.archiveDirectory || './archives',
            
            ...config
        };
        
        // Backup state
        this.backupState = {
            isRunning: false,
            lastBackup: null,
            lastFullBackup: null,
            backupHistory: [],
            errors: []
        };
        
        // Recovery state
        this.recoveryState = {
            isRunning: false,
            lastRecovery: null,
            recoveryHistory: []
        };
        
        // Worker pool for parallel processing
        this.workers = [];
        
        // Backup metadata
        this.backupMetadata = new Map();
        
        // Initialize
        this.initialize();
    }
    
    async initialize() {
        console.log('自動バックアップ・リカバリシステムを初期化中...');
        
        // Ensure directories exist
        await this.ensureDirectories();
        
        // Load backup metadata
        await this.loadBackupMetadata();
        
        // Initialize worker pool
        if (this.config.parallelProcessing) {
            await this.initializeWorkerPool();
        }
        
        // Setup encryption if enabled
        if (this.config.enableEncryption) {
            this.setupEncryption();
        }
        
        // Schedule automatic backups
        this.scheduleBackups();
        
        // Start monitoring
        if (this.config.enableMonitoring) {
            this.startMonitoring();
        }
        
        console.log('✓ バックアップ・リカバリシステムの初期化完了');
    }
    
    /**
     * Perform backup
     */
    async backup(type = 'scheduled', options = {}) {
        if (this.backupState.isRunning) {
            throw new Error('Backup already in progress');
        }
        
        const backupId = this.generateBackupId();
        const isFullBackup = this.shouldPerformFullBackup();
        
        console.log(`バックアップを開始: ${backupId} (${isFullBackup ? 'フル' : 'インクリメンタル'})`);
        
        this.backupState.isRunning = true;
        const startTime = Date.now();
        
        const backup = {
            id: backupId,
            type,
            isFullBackup,
            startTime,
            status: 'in_progress',
            files: [],
            size: 0,
            errors: []
        };
        
        this.emit('backup-started', { backupId, type, isFullBackup });
        
        try {
            // Create backup directory
            const backupPath = path.join(this.config.backupDirectory, backupId);
            await fs.mkdir(backupPath, { recursive: true });
            
            // Backup each data source
            const backupTasks = this.config.dataSources.map(source => 
                this.backupDataSource(source, backupPath, backup, isFullBackup)
            );
            
            if (this.config.parallelProcessing) {
                // Process in parallel with limit
                await this.processInBatches(backupTasks, this.config.maxParallelJobs);
            } else {
                // Process sequentially
                for (const task of backupTasks) {
                    await task;
                }
            }
            
            // Create backup manifest
            await this.createBackupManifest(backupPath, backup);
            
            // Compress backup if large
            if (backup.size > 10 * 1024 * 1024) { // 10MB
                await this.compressBackup(backupPath, backup);
            }
            
            // Encrypt if enabled
            if (this.config.enableEncryption) {
                await this.encryptBackup(backupPath, backup);
            }
            
            // Upload to remote storage if configured
            if (this.config.remoteStorage) {
                await this.uploadToRemoteStorage(backupPath, backup);
            }
            
            // Verify backup integrity
            if (this.config.verifyBackups) {
                await this.verifyBackup(backupPath, backup);
            }
            
            // Update backup state
            backup.endTime = Date.now();
            backup.duration = backup.endTime - backup.startTime;
            backup.status = 'completed';
            
            this.backupState.lastBackup = backup;
            if (isFullBackup) {
                this.backupState.lastFullBackup = backup;
            }
            
            this.backupState.backupHistory.unshift(backup);
            await this.saveBackupMetadata();
            
            // Cleanup old backups
            await this.cleanupOldBackups();
            
            this.emit('backup-completed', {
                backupId,
                duration: backup.duration,
                size: backup.size,
                fileCount: backup.files.length
            });
            
            console.log(`✓ バックアップ完了: ${backupId}`);
            
            return backup;
            
        } catch (error) {
            backup.status = 'failed';
            backup.error = error.message;
            this.backupState.errors.push({
                backupId,
                error: error.message,
                timestamp: Date.now()
            });
            
            this.emit('backup-failed', { backupId, error: error.message });
            
            throw error;
            
        } finally {
            this.backupState.isRunning = false;
        }
    }
    
    /**
     * Backup data source
     */
    async backupDataSource(source, backupPath, backup, isFullBackup) {
        const sourcePath = path.join(backupPath, source.type);
        await fs.mkdir(sourcePath, { recursive: true });
        
        try {
            switch (source.type) {
                case 'database':
                    await this.backupDatabase(source.path, sourcePath, backup, isFullBackup);
                    break;
                    
                case 'config':
                case 'state':
                    await this.backupDirectory(source.path, sourcePath, backup, isFullBackup);
                    break;
                    
                case 'logs':
                    await this.backupLogs(source.path, sourcePath, backup, source.maxAge);
                    break;
                    
                default:
                    await this.backupGeneric(source, sourcePath, backup, isFullBackup);
            }
        } catch (error) {
            backup.errors.push({
                source: source.type,
                error: error.message
            });
            
            if (!options.continueOnError) {
                throw error;
            }
        }
    }
    
    /**
     * Backup database
     */
    async backupDatabase(dbPath, targetPath, backup, isFullBackup) {
        const dbFile = path.basename(dbPath);
        const targetFile = path.join(targetPath, dbFile);
        
        if (isFullBackup) {
            // Full database backup
            await this.copyFile(dbPath, targetFile);
            
            // Also backup WAL files if they exist
            const walPath = dbPath + '-wal';
            const shmPath = dbPath + '-shm';
            
            try {
                await fs.access(walPath);
                await this.copyFile(walPath, targetFile + '-wal');
            } catch {} // Ignore if not exists
            
            try {
                await fs.access(shmPath);
                await this.copyFile(shmPath, targetFile + '-shm');
            } catch {} // Ignore if not exists
            
        } else {
            // Incremental backup using change detection
            await this.incrementalDatabaseBackup(dbPath, targetPath, backup);
        }
        
        const stats = await fs.stat(targetFile);
        backup.files.push({
            type: 'database',
            path: targetFile,
            size: stats.size
        });
        backup.size += stats.size;
    }
    
    /**
     * Backup directory
     */
    async backupDirectory(sourcePath, targetPath, backup, isFullBackup) {
        const files = await this.walkDirectory(sourcePath);
        
        for (const file of files) {
            const relativePath = path.relative(sourcePath, file);
            const targetFile = path.join(targetPath, relativePath);
            
            // Check if file needs backup
            if (!isFullBackup) {
                const needsBackup = await this.fileNeedsBackup(file, backup.id);
                if (!needsBackup) continue;
            }
            
            // Ensure target directory exists
            await fs.mkdir(path.dirname(targetFile), { recursive: true });
            
            // Copy file
            await this.copyFile(file, targetFile);
            
            const stats = await fs.stat(targetFile);
            backup.files.push({
                type: 'file',
                source: file,
                path: targetFile,
                size: stats.size
            });
            backup.size += stats.size;
        }
    }
    
    /**
     * Backup logs with age filtering
     */
    async backupLogs(logPath, targetPath, backup, maxAge) {
        const cutoffTime = Date.now() - (maxAge * 24 * 60 * 60 * 1000);
        const files = await this.walkDirectory(logPath);
        
        for (const file of files) {
            const stats = await fs.stat(file);
            
            // Skip old files
            if (stats.mtime.getTime() < cutoffTime) continue;
            
            const relativePath = path.relative(logPath, file);
            const targetFile = path.join(targetPath, relativePath);
            
            await fs.mkdir(path.dirname(targetFile), { recursive: true });
            
            // Compress log files
            await this.compressAndCopyFile(file, targetFile + '.gz');
            
            backup.files.push({
                type: 'log',
                source: file,
                path: targetFile + '.gz',
                size: stats.size
            });
            backup.size += stats.size;
        }
    }
    
    /**
     * Recover from backup
     */
    async recover(backupId, options = {}) {
        if (this.recoveryState.isRunning) {
            throw new Error('Recovery already in progress');
        }
        
        console.log(`バックアップからのリカバリを開始: ${backupId}`);
        
        this.recoveryState.isRunning = true;
        const startTime = Date.now();
        
        const recovery = {
            backupId,
            startTime,
            status: 'in_progress',
            restoredFiles: 0,
            errors: []
        };
        
        this.emit('recovery-started', { backupId });
        
        try {
            // Find backup
            const backup = this.backupMetadata.get(backupId);
            if (!backup) {
                throw new Error('Backup not found');
            }
            
            const backupPath = path.join(this.config.backupDirectory, backupId);
            
            // Verify backup before recovery
            if (this.config.verifyBackups) {
                await this.verifyBackup(backupPath, backup);
            }
            
            // Decrypt if encrypted
            if (backup.encrypted) {
                await this.decryptBackup(backupPath, backup);
            }
            
            // Decompress if compressed
            if (backup.compressed) {
                await this.decompressBackup(backupPath, backup);
            }
            
            // Create recovery checkpoint
            if (!options.skipCheckpoint) {
                await this.createRecoveryCheckpoint();
            }
            
            // Restore each data source
            for (const source of this.config.dataSources) {
                await this.restoreDataSource(source, backupPath, recovery, options);
            }
            
            // Verify recovery
            await this.verifyRecovery(recovery);
            
            // Update recovery state
            recovery.endTime = Date.now();
            recovery.duration = recovery.endTime - recovery.startTime;
            recovery.status = 'completed';
            
            this.recoveryState.lastRecovery = recovery;
            this.recoveryState.recoveryHistory.unshift(recovery);
            
            this.emit('recovery-completed', {
                backupId,
                duration: recovery.duration,
                restoredFiles: recovery.restoredFiles
            });
            
            console.log(`✓ リカバリ完了: ${backupId}`);
            
            return recovery;
            
        } catch (error) {
            recovery.status = 'failed';
            recovery.error = error.message;
            
            this.emit('recovery-failed', { backupId, error: error.message });
            
            // Attempt rollback
            if (!options.skipRollback) {
                await this.rollbackRecovery();
            }
            
            throw error;
            
        } finally {
            this.recoveryState.isRunning = false;
        }
    }
    
    /**
     * Restore data source
     */
    async restoreDataSource(source, backupPath, recovery, options) {
        const sourcePath = path.join(backupPath, source.type);
        
        try {
            switch (source.type) {
                case 'database':
                    await this.restoreDatabase(sourcePath, source.path, recovery, options);
                    break;
                    
                case 'config':
                case 'state':
                    await this.restoreDirectory(sourcePath, source.path, recovery, options);
                    break;
                    
                case 'logs':
                    if (!options.skipLogs) {
                        await this.restoreLogs(sourcePath, source.path, recovery, options);
                    }
                    break;
                    
                default:
                    await this.restoreGeneric(source, sourcePath, recovery, options);
            }
        } catch (error) {
            recovery.errors.push({
                source: source.type,
                error: error.message
            });
            
            if (!options.continueOnError) {
                throw error;
            }
        }
    }
    
    /**
     * Create backup manifest
     */
    async createBackupManifest(backupPath, backup) {
        const manifest = {
            version: '1.0',
            backupId: backup.id,
            timestamp: backup.startTime,
            type: backup.type,
            isFullBackup: backup.isFullBackup,
            files: backup.files,
            checksum: await this.calculateBackupChecksum(backup),
            metadata: {
                system: {
                    platform: process.platform,
                    arch: process.arch,
                    nodeVersion: process.version
                },
                pool: {
                    version: require('../../package.json').version
                }
            }
        };
        
        await fs.writeFile(
            path.join(backupPath, 'manifest.json'),
            JSON.stringify(manifest, null, 2)
        );
    }
    
    /**
     * Compress backup
     */
    async compressBackup(backupPath, backup) {
        const archivePath = backupPath + '.tar.gz';
        
        // Use worker thread for compression
        if (this.config.parallelProcessing) {
            await this.compressInWorker(backupPath, archivePath);
        } else {
            await this.compressDirectory(backupPath, archivePath);
        }
        
        // Remove uncompressed directory
        await fs.rm(backupPath, { recursive: true, force: true });
        
        backup.compressed = true;
        backup.compressionRatio = backup.size / (await fs.stat(archivePath)).size;
    }
    
    /**
     * Encrypt backup
     */
    async encryptBackup(backupPath, backup) {
        if (!this.cipher) {
            throw new Error('Encryption not configured');
        }
        
        const files = await this.walkDirectory(backupPath);
        
        for (const file of files) {
            const encryptedFile = file + '.enc';
            
            const readStream = createReadStream(file);
            const writeStream = createWriteStream(encryptedFile);
            
            await pipeline(
                readStream,
                this.cipher,
                writeStream
            );
            
            // Replace original with encrypted
            await fs.unlink(file);
            await fs.rename(encryptedFile, file);
        }
        
        backup.encrypted = true;
    }
    
    /**
     * Verify backup integrity
     */
    async verifyBackup(backupPath, backup) {
        // Load manifest
        const manifestPath = path.join(backupPath, 'manifest.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        
        // Verify checksum
        const currentChecksum = await this.calculateBackupChecksum(backup);
        if (currentChecksum !== manifest.checksum) {
            throw new Error('Backup checksum verification failed');
        }
        
        // Verify file existence
        for (const file of manifest.files) {
            await fs.access(file.path);
        }
        
        backup.verified = true;
    }
    
    /**
     * Calculate backup checksum
     */
    async calculateBackupChecksum(backup) {
        const hash = crypto.createHash('sha256');
        
        for (const file of backup.files) {
            const fileHash = crypto.createHash('sha256');
            const stream = createReadStream(file.path);
            
            for await (const chunk of stream) {
                fileHash.update(chunk);
            }
            
            hash.update(fileHash.digest());
        }
        
        return hash.digest('hex');
    }
    
    /**
     * Cleanup old backups
     */
    async cleanupOldBackups() {
        const cutoffTime = Date.now() - (this.config.retentionDays * 24 * 60 * 60 * 1000);
        const backupsToRemove = [];
        
        for (const [backupId, backup] of this.backupMetadata) {
            if (backup.startTime < cutoffTime) {
                backupsToRemove.push(backupId);
            }
        }
        
        // Keep minimum number of backups
        const totalBackups = this.backupMetadata.size;
        const toKeep = Math.max(3, totalBackups - backupsToRemove.length);
        
        if (toKeep < 3) {
            backupsToRemove.splice(0, 3 - toKeep);
        }
        
        // Remove or archive old backups
        for (const backupId of backupsToRemove) {
            const backupPath = path.join(this.config.backupDirectory, backupId);
            
            if (this.config.archiveOldBackups) {
                const archivePath = path.join(this.config.archiveDirectory, backupId);
                await fs.rename(backupPath, archivePath);
            } else {
                await fs.rm(backupPath, { recursive: true, force: true });
            }
            
            this.backupMetadata.delete(backupId);
        }
        
        await this.saveBackupMetadata();
    }
    
    /**
     * Schedule automatic backups
     */
    scheduleBackups() {
        // Simple cron-like scheduler
        const schedule = this.config.backupSchedule.split(' ');
        const [minute, hour, day, month, dayOfWeek] = schedule;
        
        setInterval(() => {
            const now = new Date();
            
            if (this.matchesSchedule(now, minute, hour, day, month, dayOfWeek)) {
                this.backup('scheduled').catch(error => {
                    console.error('Scheduled backup failed:', error);
                    this.emit('backup-error', { error: error.message });
                });
            }
        }, 60000); // Check every minute
    }
    
    /**
     * Check if time matches schedule
     */
    matchesSchedule(date, minute, hour, day, month, dayOfWeek) {
        const checks = [
            this.matchesField(date.getMinutes(), minute),
            this.matchesField(date.getHours(), hour),
            this.matchesField(date.getDate(), day),
            this.matchesField(date.getMonth() + 1, month),
            this.matchesField(date.getDay(), dayOfWeek)
        ];
        
        return checks.every(check => check);
    }
    
    /**
     * Check if field matches schedule pattern
     */
    matchesField(value, pattern) {
        if (pattern === '*') return true;
        
        if (pattern.includes(',')) {
            return pattern.split(',').includes(String(value));
        }
        
        if (pattern.includes('/')) {
            const [range, step] = pattern.split('/');
            const stepValue = parseInt(step);
            return value % stepValue === 0;
        }
        
        return String(value) === pattern;
    }
    
    /**
     * Initialize worker pool
     */
    async initializeWorkerPool() {
        for (let i = 0; i < this.config.maxParallelJobs; i++) {
            const worker = new Worker(`
                const { parentPort } = require('worker_threads');
                const fs = require('fs');
                const zlib = require('zlib');
                const { pipeline } = require('stream');
                
                parentPort.on('message', async (task) => {
                    try {
                        let result;
                        
                        switch (task.type) {
                            case 'compress':
                                result = await compressFile(task.source, task.target);
                                break;
                                
                            case 'decompress':
                                result = await decompressFile(task.source, task.target);
                                break;
                                
                            case 'encrypt':
                                result = await encryptFile(task.source, task.target, task.key);
                                break;
                                
                            case 'decrypt':
                                result = await decryptFile(task.source, task.target, task.key);
                                break;
                        }
                        
                        parentPort.postMessage({ success: true, result });
                        
                    } catch (error) {
                        parentPort.postMessage({ success: false, error: error.message });
                    }
                });
                
                async function compressFile(source, target) {
                    return new Promise((resolve, reject) => {
                        pipeline(
                            fs.createReadStream(source),
                            zlib.createGzip({ level: 6 }),
                            fs.createWriteStream(target),
                            (err) => err ? reject(err) : resolve()
                        );
                    });
                }
                
                // Other functions...
            `, { eval: true });
            
            this.workers.push(worker);
        }
    }
    
    /**
     * Setup encryption
     */
    setupEncryption() {
        if (!this.config.encryptionKey) {
            throw new Error('Encryption key not provided');
        }
        
        // Create cipher for encryption
        const key = crypto.scryptSync(this.config.encryptionKey, 'salt', 32);
        const iv = crypto.randomBytes(16);
        
        this.cipher = crypto.createCipheriv(this.config.encryptionAlgorithm, key, iv);
        this.decipher = crypto.createDecipheriv(this.config.encryptionAlgorithm, key, iv);
    }
    
    /**
     * Start monitoring
     */
    startMonitoring() {
        setInterval(() => {
            const status = this.getStatus();
            
            // Check for issues
            if (status.lastBackupAge > 86400000) { // 24 hours
                this.sendAlert({
                    type: 'backup_overdue',
                    message: 'No backup performed in last 24 hours',
                    severity: 'warning'
                });
            }
            
            if (status.failureRate > 0.1) { // 10% failure rate
                this.sendAlert({
                    type: 'high_failure_rate',
                    message: `High backup failure rate: ${(status.failureRate * 100).toFixed(1)}%`,
                    severity: 'error'
                });
            }
            
            this.emit('status-update', status);
            
        }, 300000); // Every 5 minutes
    }
    
    /**
     * Send alert
     */
    async sendAlert(alert) {
        this.emit('alert', alert);
        
        if (this.config.alertWebhook) {
            // Send to webhook
            try {
                const response = await fetch(this.config.alertWebhook, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...alert,
                        timestamp: Date.now(),
                        system: 'backup-recovery'
                    })
                });
                
                if (!response.ok) {
                    console.error('Failed to send alert:', response.statusText);
                }
            } catch (error) {
                console.error('Alert webhook error:', error);
            }
        }
    }
    
    /**
     * Helper functions
     */
    
    async walkDirectory(dir) {
        const files = [];
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...await this.walkDirectory(fullPath));
            } else {
                files.push(fullPath);
            }
        }
        
        return files;
    }
    
    async copyFile(source, target) {
        await pipeline(
            createReadStream(source),
            createWriteStream(target)
        );
    }
    
    async compressAndCopyFile(source, target) {
        await pipeline(
            createReadStream(source),
            zlib.createGzip({ level: this.config.compressionLevel }),
            createWriteStream(target)
        );
    }
    
    async fileNeedsBackup(file, backupId) {
        const stats = await fs.stat(file);
        const lastBackup = this.backupState.lastBackup;
        
        if (!lastBackup) return true;
        
        return stats.mtime.getTime() > lastBackup.startTime;
    }
    
    shouldPerformFullBackup() {
        if (!this.config.enableIncremental) return true;
        
        const lastFull = this.backupState.lastFullBackup;
        if (!lastFull) return true;
        
        const daysSinceLastFull = (Date.now() - lastFull.startTime) / (24 * 60 * 60 * 1000);
        return daysSinceLastFull >= this.config.fullBackupInterval;
    }
    
    async processInBatches(tasks, batchSize) {
        const results = [];
        
        for (let i = 0; i < tasks.length; i += batchSize) {
            const batch = tasks.slice(i, i + batchSize);
            const batchResults = await Promise.all(batch);
            results.push(...batchResults);
        }
        
        return results;
    }
    
    generateBackupId() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const random = crypto.randomBytes(4).toString('hex');
        return `backup_${timestamp}_${random}`;
    }
    
    async ensureDirectories() {
        await fs.mkdir(this.config.backupDirectory, { recursive: true });
        if (this.config.archiveOldBackups) {
            await fs.mkdir(this.config.archiveDirectory, { recursive: true });
        }
    }
    
    async loadBackupMetadata() {
        try {
            const metadataPath = path.join(this.config.backupDirectory, 'metadata.json');
            const data = await fs.readFile(metadataPath, 'utf8');
            const metadata = JSON.parse(data);
            
            this.backupMetadata = new Map(Object.entries(metadata.backups));
            this.backupState.backupHistory = metadata.history || [];
            
        } catch (error) {
            // Initialize empty metadata
            this.backupMetadata = new Map();
        }
    }
    
    async saveBackupMetadata() {
        const metadataPath = path.join(this.config.backupDirectory, 'metadata.json');
        const metadata = {
            backups: Object.fromEntries(this.backupMetadata),
            history: this.backupState.backupHistory.slice(0, 100) // Keep last 100
        };
        
        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    }
    
    /**
     * Get system status
     */
    getStatus() {
        const lastBackup = this.backupState.lastBackup;
        const totalBackups = this.backupState.backupHistory.length;
        const failedBackups = this.backupState.backupHistory.filter(b => b.status === 'failed').length;
        
        return {
            isBackupRunning: this.backupState.isRunning,
            isRecoveryRunning: this.recoveryState.isRunning,
            lastBackup: lastBackup ? {
                id: lastBackup.id,
                timestamp: lastBackup.startTime,
                size: lastBackup.size,
                fileCount: lastBackup.files.length,
                duration: lastBackup.duration
            } : null,
            lastBackupAge: lastBackup ? Date.now() - lastBackup.startTime : null,
            totalBackups,
            failedBackups,
            failureRate: totalBackups > 0 ? failedBackups / totalBackups : 0,
            backupCount: this.backupMetadata.size,
            totalSize: Array.from(this.backupMetadata.values())
                .reduce((sum, b) => sum + b.size, 0),
            oldestBackup: this.backupState.backupHistory[this.backupState.backupHistory.length - 1],
            errors: this.backupState.errors.slice(-10) // Last 10 errors
        };
    }
    
    /**
     * Cleanup
     */
    async cleanup() {
        // Terminate workers
        for (const worker of this.workers) {
            await worker.terminate();
        }
        
        this.workers = [];
    }
}

module.exports = AutomatedBackupRecovery;