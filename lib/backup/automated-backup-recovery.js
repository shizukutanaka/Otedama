const { EventEmitter } = require('events');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

class AutomatedBackupRecovery extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            backupPath: options.backupPath || './backups',
            schedule: options.schedule || '0 2 * * *', // 2 AM daily
            retention: {
                daily: options.dailyRetention || 7,
                weekly: options.weeklyRetention || 4,
                monthly: options.monthlyRetention || 12
            },
            compression: options.compression !== false,
            encryption: options.encryption !== false,
            encryptionKey: options.encryptionKey || this.generateEncryptionKey(),
            incremental: options.incremental !== false,
            verifyBackups: options.verifyBackups !== false,
            ...options
        };
        
        this.backupJobs = new Map();
        this.backupHistory = [];
        this.isRunning = false;
        
        // Recovery state
        this.recoveryPoints = new Map();
        this.snapshotIndex = new Map();
        
        this.initialize();
    }

    async initialize() {
        // Create backup directory
        await fs.mkdir(this.config.backupPath, { recursive: true });
        
        // Load backup history
        await this.loadBackupHistory();
        
        // Initialize scheduled backups
        this.initializeScheduler();
    }

    async createBackup(type = 'manual', targets = null) {
        const backupId = this.generateBackupId();
        const timestamp = Date.now();
        
        const backup = {
            id: backupId,
            type,
            timestamp,
            status: 'running',
            files: [],
            size: 0,
            duration: 0,
            incremental: false
        };
        
        this.emit('backup:started', backup);
        
        try {
            // Determine what to backup
            const filesToBackup = targets || await this.getBackupTargets();
            
            // Check for incremental backup
            if (this.config.incremental && type === 'scheduled') {
                const lastBackup = this.getLastSuccessfulBackup();
                if (lastBackup) {
                    backup.incremental = true;
                    backup.baseBackup = lastBackup.id;
                }
            }
            
            // Create backup manifest
            const manifest = {
                id: backupId,
                timestamp,
                type,
                incremental: backup.incremental,
                baseBackup: backup.baseBackup,
                files: []
            };
            
            // Backup each file
            for (const file of filesToBackup) {
                const backupResult = await this.backupFile(file, backupId, backup.incremental);
                if (backupResult) {
                    manifest.files.push(backupResult);
                    backup.files.push(backupResult.path);
                    backup.size += backupResult.size;
                }
            }
            
            // Save manifest
            await this.saveManifest(backupId, manifest);
            
            // Verify backup if enabled
            if (this.config.verifyBackups) {
                await this.verifyBackup(backupId, manifest);
            }
            
            backup.status = 'completed';
            backup.duration = Date.now() - timestamp;
            
            // Update history
            this.backupHistory.push(backup);
            await this.saveBackupHistory();
            
            // Clean old backups
            await this.cleanOldBackups();
            
            this.emit('backup:completed', backup);
            
            return backup;
            
        } catch (error) {
            backup.status = 'failed';
            backup.error = error.message;
            backup.duration = Date.now() - timestamp;
            
            this.backupHistory.push(backup);
            this.emit('backup:failed', { backup, error });
            
            throw error;
        }
    }

    async backupFile(filePath, backupId, incremental) {
        try {
            const stats = await fs.stat(filePath);
            
            // Skip if incremental and not modified
            if (incremental) {
                const lastBackup = this.getLastBackupTime(filePath);
                if (lastBackup && stats.mtime <= lastBackup) {
                    return null;
                }
            }
            
            // Read file
            let data = await fs.readFile(filePath);
            
            // Compress if enabled
            if (this.config.compression) {
                data = await gzip(data);
            }
            
            // Encrypt if enabled
            if (this.config.encryption) {
                data = this.encryptData(data);
            }
            
            // Generate backup filename
            const backupFileName = this.generateBackupFileName(filePath, backupId);
            const backupPath = path.join(this.config.backupPath, backupId, backupFileName);
            
            // Create directory
            await fs.mkdir(path.dirname(backupPath), { recursive: true });
            
            // Write backup file
            await fs.writeFile(backupPath, data);
            
            // Calculate checksum
            const checksum = crypto.createHash('sha256').update(data).digest('hex');
            
            return {
                originalPath: filePath,
                backupPath: backupFileName,
                size: data.length,
                originalSize: stats.size,
                checksum,
                mtime: stats.mtime.toISOString(),
                compressed: this.config.compression,
                encrypted: this.config.encryption
            };
            
        } catch (error) {
            this.emit('backup:file-error', { file: filePath, error: error.message });
            return null;
        }
    }

    async restoreBackup(backupId, targetPath = null) {
        const manifest = await this.loadManifest(backupId);
        if (!manifest) {
            throw new Error(`Backup ${backupId} not found`);
        }
        
        const restore = {
            backupId,
            timestamp: Date.now(),
            status: 'running',
            files: [],
            errors: []
        };
        
        this.emit('restore:started', restore);
        
        try {
            // If incremental, restore base backup first
            if (manifest.incremental && manifest.baseBackup) {
                await this.restoreBackup(manifest.baseBackup, targetPath);
            }
            
            // Restore each file
            for (const file of manifest.files) {
                try {
                    await this.restoreFile(file, backupId, targetPath);
                    restore.files.push(file.originalPath);
                } catch (error) {
                    restore.errors.push({
                        file: file.originalPath,
                        error: error.message
                    });
                }
            }
            
            restore.status = 'completed';
            restore.duration = Date.now() - restore.timestamp;
            
            this.emit('restore:completed', restore);
            
            return restore;
            
        } catch (error) {
            restore.status = 'failed';
            restore.error = error.message;
            restore.duration = Date.now() - restore.timestamp;
            
            this.emit('restore:failed', { restore, error });
            
            throw error;
        }
    }

    async restoreFile(fileInfo, backupId, targetPath) {
        const backupPath = path.join(this.config.backupPath, backupId, fileInfo.backupPath);
        
        // Read backup file
        let data = await fs.readFile(backupPath);
        
        // Verify checksum
        const checksum = crypto.createHash('sha256').update(data).digest('hex');
        if (checksum !== fileInfo.checksum) {
            throw new Error('Checksum verification failed');
        }
        
        // Decrypt if needed
        if (fileInfo.encrypted) {
            data = this.decryptData(data);
        }
        
        // Decompress if needed
        if (fileInfo.compressed) {
            data = await gunzip(data);
        }
        
        // Determine restore path
        const restorePath = targetPath ? 
            path.join(targetPath, path.basename(fileInfo.originalPath)) : 
            fileInfo.originalPath;
        
        // Create directory
        await fs.mkdir(path.dirname(restorePath), { recursive: true });
        
        // Write restored file
        await fs.writeFile(restorePath, data);
        
        // Restore original timestamps
        const mtime = new Date(fileInfo.mtime);
        await fs.utimes(restorePath, mtime, mtime);
        
        return restorePath;
    }

    async createSnapshot(name, description = '') {
        const snapshot = {
            id: crypto.randomBytes(16).toString('hex'),
            name,
            description,
            timestamp: Date.now(),
            state: await this.captureSystemState()
        };
        
        // Create backup of current state
        const backup = await this.createBackup('snapshot');
        snapshot.backupId = backup.id;
        
        // Store snapshot
        this.recoveryPoints.set(snapshot.id, snapshot);
        await this.saveSnapshots();
        
        this.emit('snapshot:created', snapshot);
        
        return snapshot;
    }

    async restoreSnapshot(snapshotId) {
        const snapshot = this.recoveryPoints.get(snapshotId);
        if (!snapshot) {
            throw new Error(`Snapshot ${snapshotId} not found`);
        }
        
        this.emit('snapshot:restoring', snapshot);
        
        // Stop services
        await this.stopServices();
        
        try {
            // Restore backup
            await this.restoreBackup(snapshot.backupId);
            
            // Restore system state
            await this.restoreSystemState(snapshot.state);
            
            // Restart services
            await this.startServices();
            
            this.emit('snapshot:restored', snapshot);
            
        } catch (error) {
            this.emit('snapshot:restore-failed', { snapshot, error });
            throw error;
        }
    }

    async verifyBackup(backupId, manifest) {
        const errors = [];
        
        for (const file of manifest.files) {
            try {
                const backupPath = path.join(this.config.backupPath, backupId, file.backupPath);
                const data = await fs.readFile(backupPath);
                
                const checksum = crypto.createHash('sha256').update(data).digest('hex');
                if (checksum !== file.checksum) {
                    errors.push({
                        file: file.originalPath,
                        error: 'Checksum mismatch'
                    });
                }
            } catch (error) {
                errors.push({
                    file: file.originalPath,
                    error: error.message
                });
            }
        }
        
        if (errors.length > 0) {
            throw new Error(`Backup verification failed: ${errors.length} errors`);
        }
        
        return true;
    }

    async cleanOldBackups() {
        const now = Date.now();
        const dailyCutoff = now - (this.config.retention.daily * 24 * 60 * 60 * 1000);
        const weeklyCutoff = now - (this.config.retention.weekly * 7 * 24 * 60 * 60 * 1000);
        const monthlyCutoff = now - (this.config.retention.monthly * 30 * 24 * 60 * 60 * 1000);
        
        const backupsToKeep = new Set();
        const backupsByDate = new Map();
        
        // Group backups by date
        for (const backup of this.backupHistory) {
            if (backup.status !== 'completed') continue;
            
            const date = new Date(backup.timestamp);
            const dateKey = date.toISOString().split('T')[0];
            
            if (!backupsByDate.has(dateKey)) {
                backupsByDate.set(dateKey, []);
            }
            backupsByDate.get(dateKey).push(backup);
        }
        
        // Keep daily backups
        for (const [date, backups] of backupsByDate) {
            const timestamp = new Date(date).getTime();
            if (timestamp > dailyCutoff) {
                backupsToKeep.add(backups[0].id); // Keep first backup of the day
            }
        }
        
        // Keep weekly backups
        const weeklyBackups = this.selectWeeklyBackups(backupsByDate, weeklyCutoff);
        weeklyBackups.forEach(id => backupsToKeep.add(id));
        
        // Keep monthly backups
        const monthlyBackups = this.selectMonthlyBackups(backupsByDate, monthlyCutoff);
        monthlyBackups.forEach(id => backupsToKeep.add(id));
        
        // Delete old backups
        for (const backup of this.backupHistory) {
            if (!backupsToKeep.has(backup.id) && backup.timestamp < monthlyCutoff) {
                await this.deleteBackup(backup.id);
            }
        }
    }

    selectWeeklyBackups(backupsByDate, cutoff) {
        const weekly = [];
        const weeks = new Map();
        
        for (const [date, backups] of backupsByDate) {
            const timestamp = new Date(date).getTime();
            if (timestamp > cutoff) continue;
            
            const week = Math.floor(timestamp / (7 * 24 * 60 * 60 * 1000));
            if (!weeks.has(week)) {
                weeks.set(week, backups[0].id);
            }
        }
        
        return Array.from(weeks.values());
    }

    selectMonthlyBackups(backupsByDate, cutoff) {
        const monthly = [];
        const months = new Map();
        
        for (const [date, backups] of backupsByDate) {
            const timestamp = new Date(date).getTime();
            if (timestamp < cutoff) continue;
            
            const d = new Date(date);
            const month = `${d.getFullYear()}-${d.getMonth()}`;
            if (!months.has(month)) {
                months.set(month, backups[0].id);
            }
        }
        
        return Array.from(months.values());
    }

    async deleteBackup(backupId) {
        try {
            const backupPath = path.join(this.config.backupPath, backupId);
            await fs.rmdir(backupPath, { recursive: true });
            
            // Remove from history
            this.backupHistory = this.backupHistory.filter(b => b.id !== backupId);
            
            this.emit('backup:deleted', { backupId });
        } catch (error) {
            this.emit('backup:delete-error', { backupId, error: error.message });
        }
    }

    encryptData(data) {
        const algorithm = 'aes-256-gcm';
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(algorithm, this.config.encryptionKey, iv);
        
        const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
        const authTag = cipher.getAuthTag();
        
        return Buffer.concat([iv, authTag, encrypted]);
    }

    decryptData(data) {
        const algorithm = 'aes-256-gcm';
        const iv = data.slice(0, 16);
        const authTag = data.slice(16, 32);
        const encrypted = data.slice(32);
        
        const decipher = crypto.createDecipheriv(algorithm, this.config.encryptionKey, iv);
        decipher.setAuthTag(authTag);
        
        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    }

    async getBackupTargets() {
        // Default backup targets
        return [
            './config',
            './data',
            './logs',
            './wallets'
        ].filter(async (path) => {
            try {
                await fs.access(path);
                return true;
            } catch {
                return false;
            }
        });
    }

    async captureSystemState() {
        return {
            processes: this.getRunningProcesses(),
            connections: this.getActiveConnections(),
            config: this.getCurrentConfig()
        };
    }

    async restoreSystemState(state) {
        // Restore configuration
        await this.restoreConfig(state.config);
        
        // Restore connections
        await this.restoreConnections(state.connections);
    }

    initializeScheduler() {
        const CronJob = require('cron').CronJob;
        
        this.scheduler = new CronJob(
            this.config.schedule,
            () => this.createBackup('scheduled'),
            null,
            true
        );
    }

    generateBackupId() {
        const date = new Date().toISOString().replace(/[:.]/g, '-');
        const random = crypto.randomBytes(4).toString('hex');
        return `backup-${date}-${random}`;
    }

    generateBackupFileName(originalPath, backupId) {
        const parsed = path.parse(originalPath);
        const hash = crypto.createHash('md5').update(originalPath).digest('hex').substr(0, 8);
        return `${parsed.name}-${hash}${parsed.ext}`;
    }

    generateEncryptionKey() {
        return crypto.randomBytes(32);
    }

    async saveManifest(backupId, manifest) {
        const manifestPath = path.join(this.config.backupPath, backupId, 'manifest.json');
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    }

    async loadManifest(backupId) {
        try {
            const manifestPath = path.join(this.config.backupPath, backupId, 'manifest.json');
            const data = await fs.readFile(manifestPath, 'utf8');
            return JSON.parse(data);
        } catch {
            return null;
        }
    }

    async saveBackupHistory() {
        const historyPath = path.join(this.config.backupPath, 'history.json');
        await fs.writeFile(historyPath, JSON.stringify(this.backupHistory, null, 2));
    }

    async loadBackupHistory() {
        try {
            const historyPath = path.join(this.config.backupPath, 'history.json');
            const data = await fs.readFile(historyPath, 'utf8');
            this.backupHistory = JSON.parse(data);
        } catch {
            this.backupHistory = [];
        }
    }

    async saveSnapshots() {
        const snapshotsPath = path.join(this.config.backupPath, 'snapshots.json');
        const data = Array.from(this.recoveryPoints.entries());
        await fs.writeFile(snapshotsPath, JSON.stringify(data, null, 2));
    }

    getLastSuccessfulBackup() {
        return this.backupHistory
            .filter(b => b.status === 'completed')
            .sort((a, b) => b.timestamp - a.timestamp)[0];
    }

    getLastBackupTime(filePath) {
        // Find last backup containing this file
        for (const backup of this.backupHistory.reverse()) {
            if (backup.files?.includes(filePath)) {
                return backup.timestamp;
            }
        }
        return null;
    }

    // Placeholder methods
    getRunningProcesses() { return []; }
    getActiveConnections() { return []; }
    getCurrentConfig() { return {}; }
    async stopServices() { }
    async startServices() { }
    async restoreConfig(config) { }
    async restoreConnections(connections) { }

    getStatus() {
        return {
            isRunning: this.isRunning,
            lastBackup: this.getLastSuccessfulBackup(),
            totalBackups: this.backupHistory.length,
            snapshots: this.recoveryPoints.size,
            nextScheduled: this.scheduler?.nextDates()
        };
    }
}

module.exports = AutomatedBackupRecovery;