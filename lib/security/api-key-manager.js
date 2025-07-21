/**
 * Enhanced API Key Manager
 * Provides API key generation, rotation, scoping, and validation
 */

import { EventEmitter } from 'events';
import { randomBytes, createHash, scryptSync } from 'crypto';

export class APIKeyManager extends EventEmitter {
    constructor(db, options = {}) {
        super();
        
        this.db = db;
        this.options = {
            // Key configuration
            keyLength: options.keyLength || 32,
            prefixLength: options.prefixLength || 8,
            hashAlgorithm: options.hashAlgorithm || 'sha256',
            
            // Security
            scryptOptions: options.scryptOptions || {
                N: 16384,
                r: 8,
                p: 1,
                keylen: 64
            },
            
            // Rotation
            rotationEnabled: options.rotationEnabled !== false,
            rotationGracePeriod: options.rotationGracePeriod || 86400000, // 24 hours
            maxKeyAge: options.maxKeyAge || 7776000000, // 90 days
            
            // Rate limiting
            defaultRateLimit: options.defaultRateLimit || {
                requests: 1000,
                window: 3600000 // 1 hour
            },
            
            // Permissions
            defaultPermissions: options.defaultPermissions || ['read'],
            availablePermissions: options.availablePermissions || [
                'read',
                'write',
                'delete',
                'admin',
                'mining:read',
                'mining:write',
                'dex:read',
                'dex:trade',
                'defi:read',
                'defi:interact'
            ],
            
            ...options
        };
        
        // Initialize database schema
        this.initializeDatabase();
        
        // Start rotation check
        if (this.options.rotationEnabled) {
            this.startRotationCheck();
        }
        
        // Statistics
        this.stats = {
            created: 0,
            rotated: 0,
            revoked: 0,
            validated: 0,
            failed: 0
        };
    }

    /**
     * Initialize database schema
     */
    initializeDatabase() {
        try {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS api_keys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    key_prefix TEXT NOT NULL,
                    key_hash TEXT NOT NULL,
                    name TEXT,
                    permissions TEXT,
                    scopes TEXT,
                    rate_limit TEXT,
                    ip_whitelist TEXT,
                    status TEXT DEFAULT 'active',
                    last_used_at DATETIME,
                    last_used_ip TEXT,
                    usage_count INTEGER DEFAULT 0,
                    expires_at DATETIME,
                    rotated_from INTEGER,
                    rotation_deadline DATETIME,
                    metadata TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (rotated_from) REFERENCES api_keys(id)
                );
                
                CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
                CREATE INDEX IF NOT EXISTS idx_api_keys_user_status ON api_keys(user_id, status);
                CREATE INDEX IF NOT EXISTS idx_api_keys_expires ON api_keys(expires_at);
                
                CREATE TABLE IF NOT EXISTS api_key_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    api_key_id INTEGER NOT NULL,
                    action TEXT NOT NULL,
                    ip_address TEXT,
                    user_agent TEXT,
                    endpoint TEXT,
                    status_code INTEGER,
                    error_message TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
                );
                
                CREATE INDEX IF NOT EXISTS idx_api_key_logs_key_time ON api_key_logs(api_key_id, created_at);
            `);
        } catch (error) {
            console.error('Failed to initialize API key database:', error);
            throw error;
        }
    }

    /**
     * Generate a new API key
     */
    async generateKey(userId, options = {}) {
        try {
            // Generate random key
            const keyBytes = randomBytes(this.options.keyLength);
            const key = keyBytes.toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=/g, '');
            
            // Extract prefix for quick lookup
            const prefix = key.substring(0, this.options.prefixLength);
            
            // Hash the key for storage
            const salt = randomBytes(32);
            const keyHash = scryptSync(
                key,
                salt,
                this.options.scryptOptions.keylen,
                this.options.scryptOptions
            ).toString('hex') + ':' + salt.toString('hex');
            
            // Prepare permissions and scopes
            const permissions = options.permissions || this.options.defaultPermissions;
            const scopes = options.scopes || [];
            
            // Validate permissions
            for (const perm of permissions) {
                if (!this.options.availablePermissions.includes(perm)) {
                    throw new Error(`Invalid permission: ${perm}`);
                }
            }
            
            // Rate limit
            const rateLimit = options.rateLimit || this.options.defaultRateLimit;
            
            // Calculate expiration
            const expiresAt = options.expiresAt || 
                (options.expiresIn ? new Date(Date.now() + options.expiresIn) : null);
            
            // Insert into database
            const result = this.db.prepare(`
                INSERT INTO api_keys (
                    user_id, key_prefix, key_hash, name, permissions, 
                    scopes, rate_limit, ip_whitelist, expires_at, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                userId,
                prefix,
                keyHash,
                options.name || 'API Key',
                JSON.stringify(permissions),
                JSON.stringify(scopes),
                JSON.stringify(rateLimit),
                JSON.stringify(options.ipWhitelist || []),
                expiresAt,
                JSON.stringify(options.metadata || {})
            );
            
            // Update stats
            this.stats.created++;
            
            // Emit event
            this.emit('key:created', {
                keyId: result.lastInsertRowid,
                userId,
                name: options.name,
                permissions
            });
            
            // Return key info (only time the full key is available)
            return {
                id: result.lastInsertRowid,
                key: `otdm_${key}`, // Add identifier prefix
                prefix,
                name: options.name || 'API Key',
                permissions,
                scopes,
                expiresAt,
                createdAt: new Date()
            };
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    /**
     * Validate an API key
     */
    async validateKey(key, options = {}) {
        try {
            // Extract key without prefix
            const cleanKey = key.replace(/^otdm_/, '');
            const prefix = cleanKey.substring(0, this.options.prefixLength);
            
            // Find potential matches by prefix
            const candidates = this.db.prepare(`
                SELECT * FROM api_keys 
                WHERE key_prefix = ? AND status = 'active'
            `).all(prefix);
            
            if (candidates.length === 0) {
                this.stats.failed++;
                return null;
            }
            
            // Verify key hash
            let validKey = null;
            for (const candidate of candidates) {
                const [hash, salt] = candidate.key_hash.split(':');
                const testHash = scryptSync(
                    cleanKey,
                    Buffer.from(salt, 'hex'),
                    this.options.scryptOptions.keylen,
                    this.options.scryptOptions
                ).toString('hex');
                
                if (hash === testHash) {
                    validKey = candidate;
                    break;
                }
            }
            
            if (!validKey) {
                this.stats.failed++;
                await this.logAccess(null, 'validation_failed', options);
                return null;
            }
            
            // Check expiration
            if (validKey.expires_at && new Date(validKey.expires_at) < new Date()) {
                this.stats.failed++;
                await this.logAccess(validKey.id, 'expired', options);
                return null;
            }
            
            // Check rotation deadline
            if (validKey.rotation_deadline && new Date(validKey.rotation_deadline) < new Date()) {
                this.stats.failed++;
                await this.logAccess(validKey.id, 'rotation_required', options);
                return null;
            }
            
            // Check IP whitelist
            if (options.ipAddress && validKey.ip_whitelist) {
                const whitelist = JSON.parse(validKey.ip_whitelist);
                if (whitelist.length > 0 && !whitelist.includes(options.ipAddress)) {
                    this.stats.failed++;
                    await this.logAccess(validKey.id, 'ip_not_whitelisted', options);
                    return null;
                }
            }
            
            // Update usage stats
            this.db.prepare(`
                UPDATE api_keys 
                SET last_used_at = CURRENT_TIMESTAMP,
                    last_used_ip = ?,
                    usage_count = usage_count + 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(options.ipAddress || null, validKey.id);
            
            // Log successful access
            await this.logAccess(validKey.id, 'validated', options);
            
            // Update stats
            this.stats.validated++;
            
            // Return key info
            return {
                id: validKey.id,
                userId: validKey.user_id,
                name: validKey.name,
                permissions: JSON.parse(validKey.permissions),
                scopes: JSON.parse(validKey.scopes),
                rateLimit: JSON.parse(validKey.rate_limit),
                metadata: JSON.parse(validKey.metadata || '{}')
            };
            
        } catch (error) {
            this.emit('error', error);
            this.stats.failed++;
            return null;
        }
    }

    /**
     * Rotate an API key
     */
    async rotateKey(keyId, userId) {
        try {
            // Get existing key
            const oldKey = this.db.prepare(`
                SELECT * FROM api_keys 
                WHERE id = ? AND user_id = ? AND status = 'active'
            `).get(keyId, userId);
            
            if (!oldKey) {
                throw new Error('API key not found or not active');
            }
            
            // Generate new key
            const newKey = await this.generateKey(userId, {
                name: oldKey.name + ' (Rotated)',
                permissions: JSON.parse(oldKey.permissions),
                scopes: JSON.parse(oldKey.scopes),
                rateLimit: JSON.parse(oldKey.rate_limit),
                ipWhitelist: JSON.parse(oldKey.ip_whitelist),
                metadata: {
                    ...JSON.parse(oldKey.metadata || '{}'),
                    rotatedFrom: keyId,
                    rotatedAt: new Date().toISOString()
                }
            });
            
            // Update old key with rotation info
            const rotationDeadline = new Date(Date.now() + this.options.rotationGracePeriod);
            
            this.db.prepare(`
                UPDATE api_keys 
                SET status = 'rotating',
                    rotation_deadline = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(rotationDeadline.toISOString(), keyId);
            
            // Update new key to reference old key
            this.db.prepare(`
                UPDATE api_keys 
                SET rotated_from = ?
                WHERE id = ?
            `).run(keyId, newKey.id);
            
            // Update stats
            this.stats.rotated++;
            
            // Emit event
            this.emit('key:rotated', {
                oldKeyId: keyId,
                newKeyId: newKey.id,
                userId,
                rotationDeadline
            });
            
            return {
                ...newKey,
                rotationDeadline,
                oldKeyId: keyId
            };
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    /**
     * Revoke an API key
     */
    async revokeKey(keyId, userId, reason = 'User requested') {
        try {
            const result = this.db.prepare(`
                UPDATE api_keys 
                SET status = 'revoked',
                    metadata = json_set(metadata, '$.revokedAt', ?, '$.revokedReason', ?),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND user_id = ? AND status IN ('active', 'rotating')
            `).run(
                new Date().toISOString(),
                reason,
                keyId,
                userId
            );
            
            if (result.changes === 0) {
                throw new Error('API key not found or already revoked');
            }
            
            // Update stats
            this.stats.revoked++;
            
            // Emit event
            this.emit('key:revoked', { keyId, userId, reason });
            
            return true;
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    /**
     * List API keys for a user
     */
    async listKeys(userId, options = {}) {
        try {
            const { includeRevoked = false, includeExpired = false } = options;
            
            let query = `
                SELECT id, key_prefix, name, permissions, scopes, 
                       rate_limit, status, last_used_at, usage_count,
                       expires_at, created_at
                FROM api_keys 
                WHERE user_id = ?
            `;
            
            const conditions = [];
            if (!includeRevoked) {
                conditions.push("status != 'revoked'");
            }
            if (!includeExpired) {
                conditions.push("(expires_at IS NULL OR expires_at > datetime('now'))");
            }
            
            if (conditions.length > 0) {
                query += ' AND ' + conditions.join(' AND ');
            }
            
            query += ' ORDER BY created_at DESC';
            
            const keys = this.db.prepare(query).all(userId);
            
            return keys.map(key => ({
                ...key,
                permissions: JSON.parse(key.permissions),
                scopes: JSON.parse(key.scopes),
                rateLimit: JSON.parse(key.rate_limit)
            }));
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    /**
     * Update API key permissions
     */
    async updateKeyPermissions(keyId, userId, permissions) {
        try {
            // Validate permissions
            for (const perm of permissions) {
                if (!this.options.availablePermissions.includes(perm)) {
                    throw new Error(`Invalid permission: ${perm}`);
                }
            }
            
            const result = this.db.prepare(`
                UPDATE api_keys 
                SET permissions = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND user_id = ? AND status = 'active'
            `).run(JSON.stringify(permissions), keyId, userId);
            
            if (result.changes === 0) {
                throw new Error('API key not found or not active');
            }
            
            // Log the change
            await this.logAccess(keyId, 'permissions_updated', {
                newPermissions: permissions
            });
            
            // Emit event
            this.emit('key:permissions_updated', { keyId, userId, permissions });
            
            return true;
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    /**
     * Update API key rate limit
     */
    async updateKeyRateLimit(keyId, userId, rateLimit) {
        try {
            const result = this.db.prepare(`
                UPDATE api_keys 
                SET rate_limit = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND user_id = ? AND status = 'active'
            `).run(JSON.stringify(rateLimit), keyId, userId);
            
            if (result.changes === 0) {
                throw new Error('API key not found or not active');
            }
            
            // Emit event
            this.emit('key:rate_limit_updated', { keyId, userId, rateLimit });
            
            return true;
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    /**
     * Get API key usage statistics
     */
    async getKeyStats(keyId, userId, period = '24h') {
        try {
            const key = this.db.prepare(`
                SELECT * FROM api_keys 
                WHERE id = ? AND user_id = ?
            `).get(keyId, userId);
            
            if (!key) {
                throw new Error('API key not found');
            }
            
            // Calculate time range
            const now = new Date();
            let since;
            switch (period) {
                case '1h':
                    since = new Date(now - 3600000);
                    break;
                case '24h':
                    since = new Date(now - 86400000);
                    break;
                case '7d':
                    since = new Date(now - 604800000);
                    break;
                case '30d':
                    since = new Date(now - 2592000000);
                    break;
                default:
                    since = new Date(now - 86400000);
            }
            
            // Get usage logs
            const logs = this.db.prepare(`
                SELECT action, status_code, COUNT(*) as count
                FROM api_key_logs
                WHERE api_key_id = ? AND created_at >= ?
                GROUP BY action, status_code
            `).all(keyId, since.toISOString());
            
            // Get endpoint usage
            const endpoints = this.db.prepare(`
                SELECT endpoint, COUNT(*) as count
                FROM api_key_logs
                WHERE api_key_id = ? AND created_at >= ? AND endpoint IS NOT NULL
                GROUP BY endpoint
                ORDER BY count DESC
                LIMIT 10
            `).all(keyId, since.toISOString());
            
            return {
                key: {
                    id: key.id,
                    name: key.name,
                    status: key.status,
                    created: key.created_at,
                    lastUsed: key.last_used_at,
                    totalUsage: key.usage_count
                },
                period,
                logs: logs.reduce((acc, log) => {
                    acc[log.action] = (acc[log.action] || 0) + log.count;
                    return acc;
                }, {}),
                endpoints,
                successRate: this.calculateSuccessRate(logs)
            };
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    /**
     * Log API key access
     */
    async logAccess(keyId, action, options = {}) {
        try {
            if (!keyId) return;
            
            this.db.prepare(`
                INSERT INTO api_key_logs (
                    api_key_id, action, ip_address, user_agent, 
                    endpoint, status_code, error_message
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                keyId,
                action,
                options.ipAddress || null,
                options.userAgent || null,
                options.endpoint || null,
                options.statusCode || null,
                options.errorMessage || null
            );
            
        } catch (error) {
            // Don't throw on logging errors
            console.error('Failed to log API key access:', error);
        }
    }

    /**
     * Calculate success rate from logs
     */
    calculateSuccessRate(logs) {
        let success = 0;
        let total = 0;
        
        for (const log of logs) {
            if (log.status_code && log.status_code >= 200 && log.status_code < 300) {
                success += log.count;
            }
            total += log.count;
        }
        
        return total > 0 ? (success / total * 100).toFixed(2) : 0;
    }

    /**
     * Check for keys that need rotation
     */
    async checkRotation() {
        try {
            const oldKeys = this.db.prepare(`
                SELECT id, user_id, name, created_at
                FROM api_keys
                WHERE status = 'active'
                    AND created_at < datetime('now', '-' || ? || ' seconds')
            `).all(Math.floor(this.options.maxKeyAge / 1000));
            
            for (const key of oldKeys) {
                this.emit('key:rotation_needed', {
                    keyId: key.id,
                    userId: key.user_id,
                    name: key.name,
                    age: Date.now() - new Date(key.created_at).getTime()
                });
            }
            
            // Clean up expired rotating keys
            const expired = this.db.prepare(`
                UPDATE api_keys
                SET status = 'expired'
                WHERE status = 'rotating'
                    AND rotation_deadline < datetime('now')
            `).run();
            
            if (expired.changes > 0) {
                this.emit('keys:rotation_expired', { count: expired.changes });
            }
            
        } catch (error) {
            this.emit('error', error);
        }
    }

    /**
     * Start rotation check interval
     */
    startRotationCheck() {
        // Check every hour
        this.rotationInterval = setInterval(() => {
            this.checkRotation();
        }, 3600000);
        
        // Initial check
        this.checkRotation();
    }

    /**
     * Get statistics
     */
    getStats() {
        return { ...this.stats };
    }

    /**
     * Middleware for Express
     */
    middleware(options = {}) {
        return async (req, res, next) => {
            // Get API key from header or query
            const apiKey = req.headers['x-api-key'] || 
                          req.headers['authorization']?.replace('Bearer ', '') ||
                          req.query.api_key;
            
            if (!apiKey) {
                return next();
            }
            
            // Validate key
            const keyInfo = await this.validateKey(apiKey, {
                ipAddress: req.ip || req.socket?.remoteAddress,
                userAgent: req.headers['user-agent'],
                endpoint: req.path
            });
            
            if (!keyInfo) {
                return res.status(401).json({
                    error: 'Invalid or expired API key'
                });
            }
            
            // Check permissions if required
            if (options.requirePermission) {
                const hasPermission = keyInfo.permissions.includes(options.requirePermission) ||
                                    keyInfo.permissions.includes('admin');
                
                if (!hasPermission) {
                    await this.logAccess(keyInfo.id, 'permission_denied', {
                        endpoint: req.path,
                        requiredPermission: options.requirePermission
                    });
                    
                    return res.status(403).json({
                        error: 'Insufficient permissions'
                    });
                }
            }
            
            // Add key info to request
            req.apiKey = keyInfo;
            req.userId = keyInfo.userId;
            
            // Log successful access
            res.on('finish', () => {
                this.logAccess(keyInfo.id, 'request', {
                    endpoint: req.path,
                    statusCode: res.statusCode,
                    ipAddress: req.ip,
                    userAgent: req.headers['user-agent']
                });
            });
            
            next();
        };
    }

    /**
     * Shutdown
     */
    shutdown() {
        if (this.rotationInterval) {
            clearInterval(this.rotationInterval);
        }
        
        this.removeAllListeners();
    }
}

export default APIKeyManager;