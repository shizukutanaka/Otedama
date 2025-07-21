/**
 * Backup System Enhancements
 * 
 * Additional features for the unified backup manager
 * Following performance and simplicity principles
 */

import { EventEmitter } from 'events';
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';

const scryptAsync = promisify(scrypt);

/**
 * Encrypted backup handler
 */
export class EncryptedBackupHandler {
    constructor(options = {}) {
        this.algorithm = options.algorithm || 'aes-256-gcm';
        this.password = options.password || process.env.BACKUP_ENCRYPTION_KEY;
        this.saltLength = 32;
        this.ivLength = 16;
        this.tagLength = 16;
        this.keyDerivationIterations = 100000;
    }
    
    /**
     * Derive encryption key from password
     */
    async deriveKey(password, salt) {
        const key = await scryptAsync(password, salt, 32);
        return key;
    }
    
    /**
     * Create encryption stream
     */
    createEncryptStream(password) {
        const salt = randomBytes(this.saltLength);
        const iv = randomBytes(this.ivLength);
        
        let cipher;
        let key;
        
        const transform = new Transform({
            async transform(chunk, encoding, callback) {
                try {
                    if (!cipher) {
                        // Initialize cipher on first chunk
                        key = await this.deriveKey(password, salt);
                        cipher = createCipheriv(this.algorithm, key, iv);
                        
                        // Write header: salt + iv
                        this.push(salt);
                        this.push(iv);
                    }
                    
                    const encrypted = cipher.update(chunk);
                    callback(null, encrypted);
                } catch (error) {
                    callback(error);
                }
            },
            
            flush(callback) {
                try {
                    const final = cipher.final();
                    this.push(final);
                    
                    // Append auth tag for GCM
                    if (this.algorithm.includes('gcm')) {
                        const tag = cipher.getAuthTag();
                        this.push(tag);
                    }
                    
                    callback();
                } catch (error) {
                    callback(error);
                }
            }
        });
        
        return transform;
    }
    
    /**
     * Create decryption stream
     */
    createDecryptStream(password) {
        let salt;
        let iv;
        let key;
        let decipher;
        let headerRead = false;
        let authTag;
        
        const transform = new Transform({
            async transform(chunk, encoding, callback) {
                try {
                    let data = chunk;
                    
                    if (!headerRead) {
                        // Read header
                        if (!salt) {
                            salt = data.slice(0, this.saltLength);
                            data = data.slice(this.saltLength);
                        }
                        
                        if (!iv && data.length >= this.ivLength) {
                            iv = data.slice(0, this.ivLength);
                            data = data.slice(this.ivLength);
                            headerRead = true;
                            
                            // Initialize decipher
                            key = await this.deriveKey(password, salt);
                            decipher = createDecipheriv(this.algorithm, key, iv);
                        }
                        
                        if (!headerRead || data.length === 0) {
                            callback();
                            return;
                        }
                    }
                    
                    // Keep last 16 bytes for auth tag
                    if (this.algorithm.includes('gcm')) {
                        if (authTag) {
                            // Process previous data
                            const decrypted = decipher.update(authTag.slice(0, -this.tagLength));
                            this.push(decrypted);
                        }
                        authTag = data;
                        callback();
                    } else {
                        const decrypted = decipher.update(data);
                        callback(null, decrypted);
                    }
                } catch (error) {
                    callback(error);
                }
            },
            
            flush(callback) {
                try {
                    if (this.algorithm.includes('gcm') && authTag) {
                        const tag = authTag.slice(-this.tagLength);
                        const lastData = authTag.slice(0, -this.tagLength);
                        
                        decipher.setAuthTag(tag);
                        if (lastData.length > 0) {
                            this.push(decipher.update(lastData));
                        }
                    }
                    
                    const final = decipher.final();
                    this.push(final);
                    callback();
                } catch (error) {
                    callback(error);
                }
            }
        });
        
        return transform;
    }
}

/**
 * Cloud backup provider interface
 */
export class CloudBackupProvider extends EventEmitter {
    constructor(options = {}) {
        super();
        this.provider = options.provider || 'local';
        this.config = options.config || {};
    }
    
    async upload(localPath, remotePath) {
        throw new Error('upload() must be implemented by provider');
    }
    
    async download(remotePath, localPath) {
        throw new Error('download() must be implemented by provider');
    }
    
    async list(prefix) {
        throw new Error('list() must be implemented by provider');
    }
    
    async delete(remotePath) {
        throw new Error('delete() must be implemented by provider');
    }
}

/**
 * S3-compatible cloud backup provider
 */
export class S3BackupProvider extends CloudBackupProvider {
    constructor(options = {}) {
        super(options);
        
        this.client = new S3Client({
            region: options.region || 'us-east-1',
            endpoint: options.endpoint,
            credentials: {
                accessKeyId: options.accessKeyId || process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: options.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY
            }
        });
        
        this.bucket = options.bucket || process.env.BACKUP_S3_BUCKET;
        this.prefix = options.prefix || 'otedama-backups/';
    }
    
    async upload(localPath, remotePath) {
        const key = this.prefix + remotePath;
        const stream = createReadStream(localPath);
        
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: stream,
            ServerSideEncryption: 'AES256',
            StorageClass: 'STANDARD_IA',
            Metadata: {
                'backup-time': new Date().toISOString(),
                'backup-system': 'otedama'
            }
        });
        
        const response = await this.client.send(command);
        
        this.emit('uploaded', {
            localPath,
            remotePath: key,
            etag: response.ETag,
            versionId: response.VersionId
        });
        
        return response;
    }
    
    async download(remotePath, localPath) {
        const key = this.prefix + remotePath;
        
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: key
        });
        
        const response = await this.client.send(command);
        const output = createWriteStream(localPath);
        
        await pipeline(response.Body, output);
        
        this.emit('downloaded', {
            remotePath: key,
            localPath,
            size: response.ContentLength
        });
        
        return { size: response.ContentLength };
    }
    
    async list(prefix = '') {
        const command = new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: this.prefix + prefix,
            MaxKeys: 1000
        });
        
        const response = await this.client.send(command);
        
        return (response.Contents || []).map(obj => ({
            key: obj.Key.replace(this.prefix, ''),
            size: obj.Size,
            lastModified: obj.LastModified,
            etag: obj.ETag
        }));
    }
    
    async delete(remotePath) {
        const key = this.prefix + remotePath;
        
        const command = new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: key
        });
        
        await this.client.send(command);
        
        this.emit('deleted', { remotePath: key });
    }
}

/**
 * Backup validation and integrity checker
 */
export class BackupValidator {
    constructor(options = {}) {
        this.checksumAlgorithm = options.checksumAlgorithm || 'sha256';
        this.integrityChecks = options.integrityChecks || ['tables', 'indexes', 'foreign_keys'];
    }
    
    /**
     * Validate backup file integrity
     */
    async validateBackup(backupPath, originalDbPath) {
        const results = {
            valid: true,
            checks: {},
            errors: []
        };
        
        try {
            // 1. File existence check
            const { existsSync, statSync } = await import('fs');
            if (!existsSync(backupPath)) {
                results.valid = false;
                results.errors.push('Backup file does not exist');
                return results;
            }
            
            const stats = statSync(backupPath);
            results.checks.fileSize = stats.size;
            
            // 2. Database integrity check
            const Database = (await import('better-sqlite3')).default;
            const db = new Database(backupPath, { readonly: true });
            
            try {
                // Basic integrity check
                const integrityResult = db.prepare('PRAGMA integrity_check').get();
                results.checks.integrity = integrityResult.integrity_check === 'ok';
                if (!results.checks.integrity) {
                    results.valid = false;
                    results.errors.push('Database integrity check failed');
                }
                
                // Table count check
                const tableCount = db.prepare(
                    "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'"
                ).get();
                results.checks.tableCount = tableCount.count;
                
                // Index count check
                const indexCount = db.prepare(
                    "SELECT COUNT(*) as count FROM sqlite_master WHERE type='index'"
                ).get();
                results.checks.indexCount = indexCount.count;
                
                // Row counts for important tables
                const importantTables = ['users', 'transactions', 'orders', 'mining_sessions'];
                results.checks.rowCounts = {};
                
                for (const table of importantTables) {
                    try {
                        const count = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
                        results.checks.rowCounts[table] = count.count;
                    } catch (e) {
                        // Table might not exist
                        results.checks.rowCounts[table] = 0;
                    }
                }
                
            } finally {
                db.close();
            }
            
            // 3. Compare with original if provided
            if (originalDbPath && existsSync(originalDbPath)) {
                const originalDb = new Database(originalDbPath, { readonly: true });
                
                try {
                    // Compare schema
                    const backupSchema = db.prepare(
                        "SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name"
                    ).all();
                    const originalSchema = originalDb.prepare(
                        "SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name"
                    ).all();
                    
                    results.checks.schemaMatch = 
                        JSON.stringify(backupSchema) === JSON.stringify(originalSchema);
                    
                    if (!results.checks.schemaMatch) {
                        results.errors.push('Schema mismatch between backup and original');
                    }
                    
                } finally {
                    originalDb.close();
                }
            }
            
        } catch (error) {
            results.valid = false;
            results.errors.push(`Validation error: ${error.message}`);
        }
        
        return results;
    }
    
    /**
     * Calculate checksum of backup file
     */
    async calculateChecksum(filePath) {
        const { createHash } = await import('crypto');
        const { createReadStream } = await import('fs');
        
        return new Promise((resolve, reject) => {
            const hash = createHash(this.checksumAlgorithm);
            const stream = createReadStream(filePath);
            
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', reject);
        });
    }
}

/**
 * Backup rotation and cleanup manager
 */
export class BackupRotationManager {
    constructor(options = {}) {
        this.retention = options.retention || {};
        this.minFreeSpace = options.minFreeSpace || 1024 * 1024 * 1024; // 1GB
    }
    
    /**
     * Apply retention policy
     */
    async applyRetentionPolicy(backups, backupDir) {
        const toDelete = [];
        const categorized = this.categorizeBackups(backups);
        
        // Apply retention for each category
        for (const [category, categoryBackups] of Object.entries(categorized)) {
            const retentionCount = this.retention[category] || 10;
            
            if (categoryBackups.length > retentionCount) {
                // Sort by date, newest first
                categoryBackups.sort((a, b) => b.timestamp - a.timestamp);
                
                // Mark excess backups for deletion
                const excess = categoryBackups.slice(retentionCount);
                toDelete.push(...excess);
            }
        }
        
        // Check free space
        const { statfsSync } = await import('fs');
        const stats = statfsSync(backupDir);
        const freeSpace = stats.bavail * stats.bsize;
        
        if (freeSpace < this.minFreeSpace) {
            // Delete oldest backups until we have enough space
            const allBackups = [...backups].sort((a, b) => a.timestamp - b.timestamp);
            
            let spaceToFree = this.minFreeSpace - freeSpace;
            for (const backup of allBackups) {
                if (toDelete.includes(backup)) continue;
                
                toDelete.push(backup);
                spaceToFree -= backup.size || 0;
                
                if (spaceToFree <= 0) break;
            }
        }
        
        return toDelete;
    }
    
    /**
     * Categorize backups by type
     */
    categorizeBackups(backups) {
        const categories = {};
        
        for (const backup of backups) {
            const category = backup.metadata?.schedule || backup.type || 'manual';
            if (!categories[category]) {
                categories[category] = [];
            }
            categories[category].push(backup);
        }
        
        return categories;
    }
}

export default {
    EncryptedBackupHandler,
    CloudBackupProvider,
    S3BackupProvider,
    BackupValidator,
    BackupRotationManager
};