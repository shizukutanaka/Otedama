/**
 * Data Persistence Manager for Otedama
 * Prevents data loss during network disconnections and system failures
 * 
 * Design principles:
 * - Reliable data persistence (Carmack)
 * - Clean recovery protocols (Martin)
 * - Simple backup strategy (Pike)
 */

import { EventEmitter } from 'events';
import { logger } from '../core/logger.js';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import zlib from 'zlib';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export class DataPersistenceManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Storage settings
            dbPath: config.dbPath || './data/persistence.db',
            backupPath: config.backupPath || './data/backups',
            tempPath: config.tempPath || './data/temp',
            
            // Persistence intervals
            autoSaveInterval: config.autoSaveInterval || 5000, // 5 seconds
            snapshotInterval: config.snapshotInterval || 300000, // 5 minutes
            backupInterval: config.backupInterval || 3600000, // 1 hour
            
            // Retention settings
            maxSnapshots: config.maxSnapshots || 10,
            maxBackups: config.maxBackups || 24,
            maxTempFiles: config.maxTempFiles || 100,
            
            // Recovery settings
            enableAutoRecovery: config.enableAutoRecovery || true,
            recoveryRetries: config.recoveryRetries || 3,
            recoveryDelay: config.recoveryDelay || 1000,
            
            // Encryption settings
            enableEncryption: config.enableEncryption || true,
            encryptionKey: config.encryptionKey || process.env.PERSISTENCE_KEY,
            
            // Performance settings
            compressionLevel: config.compressionLevel || 6,
            batchSize: config.batchSize || 1000,
            maxMemoryCache: config.maxMemoryCache || 100 * 1024 * 1024, // 100MB
            
            // Sync settings
            enableCloudSync: config.enableCloudSync || false,
            syncProvider: config.syncProvider || 'local',
            syncInterval: config.syncInterval || 600000, // 10 minutes
            
            ...config
        };
        
        // Database connections
        this.db = null;
        this.memoryDb = null; // In-memory cache
        
        // Data queues
        this.pendingWrites = new Map(); // dataType -> Map<id, data>
        this.dirtyFlags = new Set(); // Track modified data types
        
        // Recovery state
        this.recoveryMode = false;
        this.lastSnapshot = null;
        this.lastBackup = null;
        
        // Session management
        this.sessions = new Map(); // sessionId -> SessionData
        this.activeConnections = new Map(); // connectionId -> ConnectionData
        
        // Statistics
        this.stats = {
            totalWrites: 0,
            totalReads: 0,
            failedWrites: 0,
            recoveries: 0,
            dataLoss: 0,
            compressionRatio: 0,
            averageWriteTime: 0,
            averageReadTime: 0
        };
        
        // Initialize
        this.initialize();
    }
    
    /**
     * Initialize persistence system
     */
    async initialize() {
        try {
            // Create directories
            await this.createDirectories();
            
            // Initialize databases
            await this.initializeDatabases();
            
            // Recover from previous session
            await this.recoverPreviousSession();
            
            // Start auto-save
            this.startAutoSave();
            
            // Start snapshot system
            this.startSnapshotSystem();
            
            // Start backup system
            this.startBackupSystem();
            
            logger.info('Data persistence manager initialized');
            
            this.emit('initialized');
            
        } catch (error) {
            logger.error('Failed to initialize persistence manager:', error);
            throw error;
        }
    }
    
    /**
     * Create required directories
     */
    async createDirectories() {
        const dirs = [
            this.config.backupPath,
            this.config.tempPath,
            path.dirname(this.config.dbPath)
        ];
        
        for (const dir of dirs) {
            await fs.mkdir(dir, { recursive: true });
        }
    }
    
    /**
     * Initialize database connections
     */
    async initializeDatabases() {
        // Main persistent database
        this.db = new Database(this.config.dbPath);
        
        // Create tables
        this.db.exec(`
            -- User data with versioning
            CREATE TABLE IF NOT EXISTS user_data (
                user_id TEXT NOT NULL,
                data_type TEXT NOT NULL,
                data TEXT NOT NULL,
                version INTEGER DEFAULT 1,
                checksum TEXT NOT NULL,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
                updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
                PRIMARY KEY (user_id, data_type)
            );
            
            -- Session tracking
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                connection_data TEXT,
                last_activity INTEGER,
                state TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            );
            
            -- Transaction log for recovery
            CREATE TABLE IF NOT EXISTS transaction_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                data_type TEXT NOT NULL,
                data TEXT,
                status TEXT DEFAULT 'pending',
                timestamp INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            );
            
            -- Snapshots
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                snapshot_data BLOB NOT NULL,
                checksum TEXT NOT NULL,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            );
            
            -- Recovery points
            CREATE TABLE IF NOT EXISTS recovery_points (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                point_name TEXT NOT NULL,
                point_data TEXT NOT NULL,
                metadata TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            );
            
            -- Create indexes
            CREATE INDEX IF NOT EXISTS idx_user_data_updated ON user_data(updated_at);
            CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity);
            CREATE INDEX IF NOT EXISTS idx_transaction_log_status ON transaction_log(status, timestamp);
        `);
        
        // In-memory cache database
        this.memoryDb = new Database(':memory:');
        this.memoryDb.exec(`
            CREATE TABLE cache (
                key TEXT PRIMARY KEY,
                value TEXT,
                expires INTEGER
            );
        `);
        
        // Prepare statements for performance
        this.prepareStatements();
    }
    
    /**
     * Prepare SQL statements
     */
    prepareStatements() {
        this.statements = {
            // User data operations
            getUserData: this.db.prepare('SELECT * FROM user_data WHERE user_id = ? AND data_type = ?'),
            saveUserData: this.db.prepare(`
                INSERT OR REPLACE INTO user_data (user_id, data_type, data, version, checksum, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `),
            
            // Session operations
            getSession: this.db.prepare('SELECT * FROM sessions WHERE session_id = ?'),
            saveSession: this.db.prepare(`
                INSERT OR REPLACE INTO sessions (session_id, user_id, connection_data, last_activity, state)
                VALUES (?, ?, ?, ?, ?)
            `),
            updateSessionActivity: this.db.prepare('UPDATE sessions SET last_activity = ? WHERE session_id = ?'),
            
            // Transaction log
            logTransaction: this.db.prepare(`
                INSERT INTO transaction_log (user_id, operation, data_type, data, status)
                VALUES (?, ?, ?, ?, ?)
            `),
            getPendingTransactions: this.db.prepare('SELECT * FROM transaction_log WHERE status = ? ORDER BY timestamp'),
            updateTransactionStatus: this.db.prepare('UPDATE transaction_log SET status = ? WHERE id = ?'),
            
            // Cache operations
            getCache: this.memoryDb.prepare('SELECT value FROM cache WHERE key = ? AND expires > ?'),
            setCache: this.memoryDb.prepare('INSERT OR REPLACE INTO cache (key, value, expires) VALUES (?, ?, ?)'),
            clearExpiredCache: this.memoryDb.prepare('DELETE FROM cache WHERE expires < ?')
        };
    }
    
    /**
     * Save user data with automatic versioning and checksums
     */
    async saveUserData(userId, dataType, data) {
        const startTime = Date.now();
        
        try {
            // Add to pending writes
            if (!this.pendingWrites.has(dataType)) {
                this.pendingWrites.set(dataType, new Map());
            }
            this.pendingWrites.get(dataType).set(userId, data);
            this.dirtyFlags.add(dataType);
            
            // Log transaction
            const serializedData = JSON.stringify(data);
            const transactionId = this.statements.logTransaction.run(
                userId,
                'save',
                dataType,
                serializedData,
                'pending'
            ).lastInsertRowid;
            
            // Encrypt if enabled
            const dataToStore = this.config.enableEncryption ? 
                await this.encryptData(serializedData) : serializedData;
            
            // Calculate checksum
            const checksum = this.calculateChecksum(dataToStore);
            
            // Get current version
            const existing = this.statements.getUserData.get(userId, dataType);
            const version = existing ? existing.version + 1 : 1;
            
            // Save to database
            this.statements.saveUserData.run(
                userId,
                dataType,
                dataToStore,
                version,
                checksum,
                Date.now()
            );
            
            // Update transaction status
            this.statements.updateTransactionStatus.run('completed', transactionId);
            
            // Cache in memory
            await this.cacheData(`${userId}:${dataType}`, data);
            
            // Update stats
            this.stats.totalWrites++;
            this.updateAverageWriteTime(Date.now() - startTime);
            
            logger.debug(`Saved ${dataType} data for user ${userId}, version ${version}`);
            
            this.emit('data:saved', {
                userId,
                dataType,
                version,
                timestamp: Date.now()
            });
            
            return { success: true, version, checksum };
            
        } catch (error) {
            this.stats.failedWrites++;
            logger.error(`Failed to save data for ${userId}:${dataType}:`, error);
            
            // Add to recovery queue
            this.addToRecoveryQueue(userId, dataType, data);
            
            throw error;
        }
    }
    
    /**
     * Load user data with automatic recovery
     */
    async loadUserData(userId, dataType) {
        const startTime = Date.now();
        
        try {
            // Check memory cache first
            const cached = await this.getCachedData(`${userId}:${dataType}`);
            if (cached) {
                this.stats.totalReads++;
                return cached;
            }
            
            // Load from database
            const row = this.statements.getUserData.get(userId, dataType);
            if (!row) {
                return null;
            }
            
            // Verify checksum
            const calculatedChecksum = this.calculateChecksum(row.data);
            if (calculatedChecksum !== row.checksum) {
                logger.warn(`Checksum mismatch for ${userId}:${dataType}, attempting recovery`);
                return await this.recoverCorruptedData(userId, dataType);
            }
            
            // Decrypt if needed
            const decryptedData = this.config.enableEncryption ? 
                await this.decryptData(row.data) : row.data;
            
            const data = JSON.parse(decryptedData);
            
            // Cache for future use
            await this.cacheData(`${userId}:${dataType}`, data);
            
            // Update stats
            this.stats.totalReads++;
            this.updateAverageReadTime(Date.now() - startTime);
            
            return data;
            
        } catch (error) {
            logger.error(`Failed to load data for ${userId}:${dataType}:`, error);
            
            // Attempt recovery
            if (this.config.enableAutoRecovery) {
                return await this.recoverUserData(userId, dataType);
            }
            
            throw error;
        }
    }
    
    /**
     * Create session for connection tracking
     */
    async createSession(userId, connectionData = {}) {
        const sessionId = this.generateSessionId();
        
        const session = {
            sessionId,
            userId,
            connectionData: JSON.stringify(connectionData),
            lastActivity: Date.now(),
            state: 'active'
        };
        
        this.statements.saveSession.run(
            session.sessionId,
            session.userId,
            session.connectionData,
            session.lastActivity,
            session.state
        );
        
        this.sessions.set(sessionId, session);
        
        logger.info(`Session created: ${sessionId} for user ${userId}`);
        
        return sessionId;
    }
    
    /**
     * Resume session after disconnection
     */
    async resumeSession(sessionId) {
        // Check memory first
        let session = this.sessions.get(sessionId);
        
        if (!session) {
            // Load from database
            const row = this.statements.getSession.get(sessionId);
            if (!row) {
                throw new Error('Session not found');
            }
            
            session = {
                ...row,
                connectionData: JSON.parse(row.connection_data)
            };
            
            this.sessions.set(sessionId, session);
        }
        
        // Update activity
        session.lastActivity = Date.now();
        session.state = 'active';
        
        this.statements.updateSessionActivity.run(Date.now(), sessionId);
        
        logger.info(`Session resumed: ${sessionId}`);
        
        this.emit('session:resumed', {
            sessionId,
            userId: session.userId,
            timestamp: Date.now()
        });
        
        return session;
    }
    
    /**
     * Create snapshot of all data
     */
    async createSnapshot() {
        try {
            const snapshot = {
                timestamp: Date.now(),
                userData: {},
                sessions: {},
                metadata: {
                    version: 1,
                    stats: this.stats
                }
            };
            
            // Collect all user data
            const userDataRows = this.db.prepare('SELECT * FROM user_data').all();
            for (const row of userDataRows) {
                if (!snapshot.userData[row.user_id]) {
                    snapshot.userData[row.user_id] = {};
                }
                snapshot.userData[row.user_id][row.data_type] = {
                    data: row.data,
                    version: row.version,
                    checksum: row.checksum
                };
            }
            
            // Collect active sessions
            const sessionRows = this.db.prepare('SELECT * FROM sessions WHERE state = ?').all('active');
            for (const row of sessionRows) {
                snapshot.sessions[row.session_id] = row;
            }
            
            // Compress snapshot
            const snapshotData = await gzip(JSON.stringify(snapshot), {
                level: this.config.compressionLevel
            });
            
            const checksum = this.calculateChecksum(snapshotData);
            
            // Save snapshot
            this.db.prepare('INSERT INTO snapshots (snapshot_data, checksum) VALUES (?, ?)').run(
                snapshotData,
                checksum
            );
            
            // Clean old snapshots
            await this.cleanOldSnapshots();
            
            this.lastSnapshot = Date.now();
            
            logger.info('Snapshot created successfully');
            
            this.emit('snapshot:created', {
                size: snapshotData.length,
                checksum,
                timestamp: Date.now()
            });
            
        } catch (error) {
            logger.error('Failed to create snapshot:', error);
            throw error;
        }
    }
    
    /**
     * Recover from snapshot
     */
    async recoverFromSnapshot(snapshotId) {
        try {
            const snapshot = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
            if (!snapshot) {
                throw new Error('Snapshot not found');
            }
            
            // Verify checksum
            const calculatedChecksum = this.calculateChecksum(snapshot.snapshot_data);
            if (calculatedChecksum !== snapshot.checksum) {
                throw new Error('Snapshot corrupted');
            }
            
            // Decompress
            const decompressed = await gunzip(snapshot.snapshot_data);
            const snapshotData = JSON.parse(decompressed.toString());
            
            // Begin transaction
            const restoreTransaction = this.db.transaction(() => {
                // Clear current data
                this.db.prepare('DELETE FROM user_data').run();
                this.db.prepare('DELETE FROM sessions').run();
                
                // Restore user data
                const saveStmt = this.db.prepare(`
                    INSERT INTO user_data (user_id, data_type, data, version, checksum, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                `);
                
                for (const [userId, userData] of Object.entries(snapshotData.userData)) {
                    for (const [dataType, info] of Object.entries(userData)) {
                        saveStmt.run(
                            userId,
                            dataType,
                            info.data,
                            info.version,
                            info.checksum,
                            Date.now()
                        );
                    }
                }
                
                // Restore sessions
                const sessionStmt = this.db.prepare(`
                    INSERT INTO sessions (session_id, user_id, connection_data, last_activity, state)
                    VALUES (?, ?, ?, ?, ?)
                `);
                
                for (const [sessionId, session] of Object.entries(snapshotData.sessions)) {
                    sessionStmt.run(
                        sessionId,
                        session.user_id,
                        session.connection_data,
                        session.last_activity,
                        'recovered'
                    );
                }
            });
            
            restoreTransaction();
            
            // Clear caches
            this.pendingWrites.clear();
            this.dirtyFlags.clear();
            this.sessions.clear();
            
            this.stats.recoveries++;
            
            logger.info(`Recovered from snapshot ${snapshotId}`);
            
            this.emit('snapshot:recovered', {
                snapshotId,
                timestamp: Date.now()
            });
            
        } catch (error) {
            logger.error('Failed to recover from snapshot:', error);
            throw error;
        }
    }
    
    /**
     * Create backup
     */
    async createBackup() {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFile = path.join(this.config.backupPath, `backup-${timestamp}.db`);
            
            // Use SQLite backup API
            await this.db.backup(backupFile);
            
            // Compress backup
            const backupData = await fs.readFile(backupFile);
            const compressed = await gzip(backupData, {
                level: this.config.compressionLevel
            });
            
            const compressedFile = `${backupFile}.gz`;
            await fs.writeFile(compressedFile, compressed);
            
            // Remove uncompressed backup
            await fs.unlink(backupFile);
            
            // Clean old backups
            await this.cleanOldBackups();
            
            this.lastBackup = Date.now();
            
            logger.info(`Backup created: ${compressedFile}`);
            
            this.emit('backup:created', {
                file: compressedFile,
                size: compressed.length,
                timestamp: Date.now()
            });
            
        } catch (error) {
            logger.error('Failed to create backup:', error);
            throw error;
        }
    }
    
    /**
     * Auto-save pending writes
     */
    async autoSave() {
        if (this.pendingWrites.size === 0) return;
        
        const transaction = this.db.transaction(() => {
            for (const [dataType, userData] of this.pendingWrites) {
                for (const [userId, data] of userData) {
                    try {
                        const serializedData = JSON.stringify(data);
                        const dataToStore = this.config.enableEncryption ? 
                            this.encryptDataSync(serializedData) : serializedData;
                        const checksum = this.calculateChecksum(dataToStore);
                        
                        const existing = this.statements.getUserData.get(userId, dataType);
                        const version = existing ? existing.version + 1 : 1;
                        
                        this.statements.saveUserData.run(
                            userId,
                            dataType,
                            dataToStore,
                            version,
                            checksum,
                            Date.now()
                        );
                        
                    } catch (error) {
                        logger.error(`Auto-save failed for ${userId}:${dataType}:`, error);
                    }
                }
            }
        });
        
        try {
            transaction();
            this.pendingWrites.clear();
            this.dirtyFlags.clear();
            
        } catch (error) {
            logger.error('Auto-save transaction failed:', error);
        }
    }
    
    /**
     * Recovery queue for failed operations
     */
    addToRecoveryQueue(userId, dataType, data) {
        const recoveryData = {
            userId,
            dataType,
            data,
            attempts: 0,
            timestamp: Date.now()
        };
        
        // Store in recovery points
        this.db.prepare(`
            INSERT INTO recovery_points (point_name, point_data, metadata)
            VALUES (?, ?, ?)
        `).run(
            `recovery-${userId}-${dataType}`,
            JSON.stringify(data),
            JSON.stringify(recoveryData)
        );
    }
    
    /**
     * Encrypt data
     */
    async encryptData(data) {
        if (!this.config.encryptionKey) {
            throw new Error('Encryption key not configured');
        }
        
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', 
            Buffer.from(this.config.encryptionKey, 'hex'), iv);
        
        let encrypted = cipher.update(data, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        const authTag = cipher.getAuthTag();
        
        return JSON.stringify({
            iv: iv.toString('hex'),
            authTag: authTag.toString('hex'),
            data: encrypted
        });
    }
    
    /**
     * Decrypt data
     */
    async decryptData(encryptedData) {
        const { iv, authTag, data } = JSON.parse(encryptedData);
        
        const decipher = crypto.createDecipheriv('aes-256-gcm',
            Buffer.from(this.config.encryptionKey, 'hex'),
            Buffer.from(iv, 'hex'));
        
        decipher.setAuthTag(Buffer.from(authTag, 'hex'));
        
        let decrypted = decipher.update(data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    }
    
    /**
     * Synchronous encryption for transactions
     */
    encryptDataSync(data) {
        if (!this.config.encryptionKey) return data;
        
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm',
            Buffer.from(this.config.encryptionKey, 'hex'), iv);
        
        let encrypted = cipher.update(data, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        const authTag = cipher.getAuthTag();
        
        return JSON.stringify({
            iv: iv.toString('hex'),
            authTag: authTag.toString('hex'),
            data: encrypted
        });
    }
    
    /**
     * Calculate checksum
     */
    calculateChecksum(data) {
        return crypto.createHash('sha256')
            .update(typeof data === 'string' ? data : JSON.stringify(data))
            .digest('hex');
    }
    
    /**
     * Cache data in memory
     */
    async cacheData(key, value, ttl = 300000) { // 5 minutes default
        const expires = Date.now() + ttl;
        this.statements.setCache.run(key, JSON.stringify(value), expires);
    }
    
    /**
     * Get cached data
     */
    async getCachedData(key) {
        const row = this.statements.getCache.get(key, Date.now());
        return row ? JSON.parse(row.value) : null;
    }
    
    /**
     * Clean old snapshots
     */
    async cleanOldSnapshots() {
        const snapshots = this.db.prepare('SELECT id FROM snapshots ORDER BY created_at DESC').all();
        
        if (snapshots.length > this.config.maxSnapshots) {
            const toDelete = snapshots.slice(this.config.maxSnapshots);
            const deleteStmt = this.db.prepare('DELETE FROM snapshots WHERE id = ?');
            
            for (const snapshot of toDelete) {
                deleteStmt.run(snapshot.id);
            }
            
            logger.info(`Cleaned ${toDelete.length} old snapshots`);
        }
    }
    
    /**
     * Clean old backups
     */
    async cleanOldBackups() {
        const files = await fs.readdir(this.config.backupPath);
        const backupFiles = files
            .filter(f => f.startsWith('backup-') && f.endsWith('.gz'))
            .sort()
            .reverse();
        
        if (backupFiles.length > this.config.maxBackups) {
            const toDelete = backupFiles.slice(this.config.maxBackups);
            
            for (const file of toDelete) {
                await fs.unlink(path.join(this.config.backupPath, file));
            }
            
            logger.info(`Cleaned ${toDelete.length} old backups`);
        }
    }
    
    /**
     * Recover previous session on startup
     */
    async recoverPreviousSession() {
        try {
            // Check for pending transactions
            const pendingTransactions = this.statements.getPendingTransactions.all('pending');
            
            if (pendingTransactions.length > 0) {
                logger.info(`Found ${pendingTransactions.length} pending transactions, recovering...`);
                
                for (const tx of pendingTransactions) {
                    try {
                        // Replay transaction
                        await this.saveUserData(tx.user_id, tx.data_type, JSON.parse(tx.data));
                        this.statements.updateTransactionStatus.run('recovered', tx.id);
                        
                    } catch (error) {
                        logger.error(`Failed to recover transaction ${tx.id}:`, error);
                        this.statements.updateTransactionStatus.run('failed', tx.id);
                    }
                }
            }
            
            // Load active sessions
            const activeSessions = this.db.prepare('SELECT * FROM sessions WHERE state = ?').all('active');
            
            for (const session of activeSessions) {
                this.sessions.set(session.session_id, {
                    ...session,
                    connectionData: JSON.parse(session.connection_data)
                });
            }
            
            logger.info(`Recovered ${activeSessions.length} active sessions`);
            
        } catch (error) {
            logger.error('Failed to recover previous session:', error);
        }
    }
    
    /**
     * Update average write time
     */
    updateAverageWriteTime(time) {
        const total = this.stats.totalWrites;
        this.stats.averageWriteTime = 
            (this.stats.averageWriteTime * (total - 1) + time) / total;
    }
    
    /**
     * Update average read time
     */
    updateAverageReadTime(time) {
        const total = this.stats.totalReads;
        this.stats.averageReadTime = 
            (this.stats.averageReadTime * (total - 1) + time) / total;
    }
    
    /**
     * Start auto-save timer
     */
    startAutoSave() {
        this.autoSaveInterval = setInterval(async () => {
            await this.autoSave();
        }, this.config.autoSaveInterval);
    }
    
    /**
     * Start snapshot system
     */
    startSnapshotSystem() {
        this.snapshotInterval = setInterval(async () => {
            await this.createSnapshot();
        }, this.config.snapshotInterval);
    }
    
    /**
     * Start backup system
     */
    startBackupSystem() {
        this.backupInterval = setInterval(async () => {
            await this.createBackup();
        }, this.config.backupInterval);
    }
    
    /**
     * Clean expired cache entries
     */
    startCacheCleaner() {
        this.cacheCleanerInterval = setInterval(() => {
            this.statements.clearExpiredCache.run(Date.now());
        }, 60000); // Every minute
    }
    
    /**
     * Generate session ID
     */
    generateSessionId() {
        return `SES${Date.now()}${crypto.randomBytes(8).toString('hex')}`;
    }
    
    /**
     * Export user data
     */
    async exportUserData(userId) {
        const userData = {};
        const rows = this.db.prepare('SELECT * FROM user_data WHERE user_id = ?').all(userId);
        
        for (const row of rows) {
            const decryptedData = this.config.enableEncryption ?
                await this.decryptData(row.data) : row.data;
            
            userData[row.data_type] = {
                data: JSON.parse(decryptedData),
                version: row.version,
                updatedAt: row.updated_at
            };
        }
        
        return userData;
    }
    
    /**
     * Import user data
     */
    async importUserData(userId, userData) {
        const transaction = this.db.transaction(async () => {
            for (const [dataType, info] of Object.entries(userData)) {
                await this.saveUserData(userId, dataType, info.data);
            }
        });
        
        await transaction();
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            activeSessions: this.sessions.size,
            pendingWrites: this.pendingWrites.size,
            lastSnapshot: this.lastSnapshot,
            lastBackup: this.lastBackup,
            timestamp: Date.now()
        };
    }
    
    /**
     * Shutdown gracefully
     */
    async shutdown() {
        // Save pending writes
        await this.autoSave();
        
        // Create final snapshot
        await this.createSnapshot();
        
        // Clear intervals
        if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
        if (this.snapshotInterval) clearInterval(this.snapshotInterval);
        if (this.backupInterval) clearInterval(this.backupInterval);
        if (this.cacheCleanerInterval) clearInterval(this.cacheCleanerInterval);
        
        // Close databases
        if (this.db) this.db.close();
        if (this.memoryDb) this.memoryDb.close();
        
        logger.info('Data persistence manager shut down');
    }
}

export default DataPersistenceManager;