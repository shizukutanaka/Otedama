/**
 * Advanced Data Encryption System
 * Multi-layer encryption for sensitive data protection
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

class AdvancedDataEncryption extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Encryption algorithms
            algorithm: config.algorithm || 'aes-256-gcm',
            keyDerivationAlgorithm: config.keyDerivationAlgorithm || 'pbkdf2',
            hashAlgorithm: config.hashAlgorithm || 'sha512',
            
            // Key management
            masterKeyLength: config.masterKeyLength || 32,
            saltLength: config.saltLength || 32,
            iterations: config.iterations || 100000,
            tagLength: config.tagLength || 16,
            
            // Key rotation
            enableKeyRotation: config.enableKeyRotation !== false,
            keyRotationInterval: config.keyRotationInterval || 2592000000, // 30 days
            maxKeyAge: config.maxKeyAge || 7776000000, // 90 days
            
            // Field-level encryption
            enableFieldEncryption: config.enableFieldEncryption !== false,
            encryptedFields: config.encryptedFields || [
                'password', 'ssn', 'creditCard', 'bankAccount', 
                'privateKey', 'secret', 'apiKey', 'token'
            ],
            
            // Format preservation
            enableFormatPreservation: config.enableFormatPreservation || false,
            
            // Hardware security module
            useHSM: config.useHSM || false,
            hsmConfig: config.hsmConfig || {},
            
            ...config
        };
        
        // Key storage
        this.masterKeys = new Map();
        this.dataKeys = new Map();
        this.keyMetadata = new Map();
        
        // Initialize master key
        this.currentMasterKeyId = null;
        this.initializeMasterKey();
        
        // Start key rotation if enabled
        if (this.config.enableKeyRotation) {
            this.startKeyRotation();
        }
        
        // Metrics
        this.metrics = {
            encryptionOperations: 0,
            decryptionOperations: 0,
            keyRotations: 0,
            errors: 0
        };
    }
    
    /**
     * Initialize master key
     */
    initializeMasterKey() {
        const keyId = this.generateKeyId();
        const masterKey = this.generateMasterKey();
        
        this.masterKeys.set(keyId, {
            key: masterKey,
            createdAt: Date.now(),
            version: 1,
            active: true
        });
        
        this.currentMasterKeyId = keyId;
        this.keyMetadata.set(keyId, {
            algorithm: this.config.algorithm,
            createdAt: Date.now(),
            rotatedFrom: null
        });
        
        this.emit('master-key-created', { keyId });
    }
    
    /**
     * Encrypt data
     */
    async encrypt(data, options = {}) {
        try {
            this.metrics.encryptionOperations++;
            
            // Handle different data types
            const dataToEncrypt = this.prepareDataForEncryption(data);
            
            // Get or generate data key
            const dataKeyInfo = await this.getDataKey(options.keyId);
            
            // Generate IV
            const iv = crypto.randomBytes(16);
            
            // Create cipher
            const cipher = crypto.createCipheriv(
                this.config.algorithm,
                dataKeyInfo.key,
                iv
            );
            
            // Encrypt data
            const encrypted = Buffer.concat([
                cipher.update(dataToEncrypt, 'utf8'),
                cipher.final()
            ]);
            
            // Get auth tag for GCM mode
            let authTag;
            if (this.config.algorithm.includes('gcm')) {
                authTag = cipher.getAuthTag();
            }
            
            // Create encrypted package
            const encryptedPackage = {
                version: 1,
                keyId: dataKeyInfo.keyId,
                algorithm: this.config.algorithm,
                iv: iv.toString('base64'),
                authTag: authTag ? authTag.toString('base64') : null,
                ciphertext: encrypted.toString('base64'),
                timestamp: Date.now()
            };
            
            // Add integrity check
            encryptedPackage.hmac = this.calculateHMAC(encryptedPackage, dataKeyInfo.key);
            
            return encryptedPackage;
            
        } catch (error) {
            this.metrics.errors++;
            this.emit('encryption-error', error);
            throw error;
        }
    }
    
    /**
     * Decrypt data
     */
    async decrypt(encryptedPackage, options = {}) {
        try {
            this.metrics.decryptionOperations++;
            
            // Validate package
            this.validateEncryptedPackage(encryptedPackage);
            
            // Get data key
            const dataKeyInfo = await this.getDataKey(encryptedPackage.keyId);
            
            // Verify integrity
            const calculatedHmac = this.calculateHMAC(
                { ...encryptedPackage, hmac: undefined },
                dataKeyInfo.key
            );
            
            if (calculatedHmac !== encryptedPackage.hmac) {
                throw new Error('Integrity check failed');
            }
            
            // Decode components
            const iv = Buffer.from(encryptedPackage.iv, 'base64');
            const ciphertext = Buffer.from(encryptedPackage.ciphertext, 'base64');
            
            // Create decipher
            const decipher = crypto.createDecipheriv(
                encryptedPackage.algorithm || this.config.algorithm,
                dataKeyInfo.key,
                iv
            );
            
            // Set auth tag for GCM mode
            if (encryptedPackage.authTag && encryptedPackage.algorithm.includes('gcm')) {
                decipher.setAuthTag(Buffer.from(encryptedPackage.authTag, 'base64'));
            }
            
            // Decrypt data
            const decrypted = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final()
            ]);
            
            // Parse decrypted data
            return this.parseDecryptedData(decrypted.toString('utf8'));
            
        } catch (error) {
            this.metrics.errors++;
            this.emit('decryption-error', error);
            throw error;
        }
    }
    
    /**
     * Encrypt object with field-level encryption
     */
    async encryptObject(obj, schema = {}) {
        if (!this.config.enableFieldEncryption) {
            return await this.encrypt(obj);
        }
        
        const encrypted = {};
        
        for (const [key, value] of Object.entries(obj)) {
            // Check if field should be encrypted
            const shouldEncrypt = schema[key]?.encrypt || 
                this.config.encryptedFields.includes(key) ||
                this.isSensitiveField(key);
            
            if (shouldEncrypt && value !== null && value !== undefined) {
                // Encrypt field value
                encrypted[key] = await this.encrypt(value, {
                    fieldName: key,
                    preserveFormat: schema[key]?.preserveFormat
                });
            } else if (typeof value === 'object' && value !== null) {
                // Recursively encrypt nested objects
                encrypted[key] = await this.encryptObject(value, schema[key] || {});
            } else {
                // Keep plain value
                encrypted[key] = value;
            }
        }
        
        return encrypted;
    }
    
    /**
     * Decrypt object with field-level encryption
     */
    async decryptObject(encryptedObj, schema = {}) {
        const decrypted = {};
        
        for (const [key, value] of Object.entries(encryptedObj)) {
            if (this.isEncryptedPackage(value)) {
                // Decrypt field
                decrypted[key] = await this.decrypt(value);
            } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                // Recursively decrypt nested objects
                decrypted[key] = await this.decryptObject(value, schema[key] || {});
            } else {
                // Keep plain value
                decrypted[key] = value;
            }
        }
        
        return decrypted;
    }
    
    /**
     * Format-preserving encryption
     */
    async encryptFormatPreserving(data, format) {
        if (!this.config.enableFormatPreservation) {
            throw new Error('Format preservation not enabled');
        }
        
        // Implementation of FPE algorithms (FF1/FF3)
        // This is a simplified version
        const encrypted = await this.encrypt(data);
        
        // Encode to match original format
        return this.encodeToFormat(encrypted.ciphertext, format, data);
    }
    
    /**
     * Tokenization for sensitive data
     */
    async tokenize(data, options = {}) {
        // Generate token
        const token = this.generateToken(options.format);
        
        // Encrypt and store original data
        const encrypted = await this.encrypt(data);
        
        // Store token mapping
        await this.storeTokenMapping(token, encrypted);
        
        return token;
    }
    
    /**
     * Detokenization
     */
    async detokenize(token) {
        // Retrieve encrypted data
        const encrypted = await this.getTokenMapping(token);
        
        if (!encrypted) {
            throw new Error('Invalid token');
        }
        
        // Decrypt and return original data
        return await this.decrypt(encrypted);
    }
    
    /**
     * Key management methods
     */
    
    async getDataKey(keyId) {
        // Use provided key or generate new one
        if (keyId && this.dataKeys.has(keyId)) {
            return this.dataKeys.get(keyId);
        }
        
        // Generate new data key encrypted with master key
        const dataKey = crypto.randomBytes(this.config.masterKeyLength);
        const newKeyId = this.generateKeyId();
        
        // Encrypt data key with master key
        const masterKeyInfo = this.masterKeys.get(this.currentMasterKeyId);
        const encryptedDataKey = await this.encryptWithMasterKey(dataKey, masterKeyInfo.key);
        
        // Store encrypted data key
        this.dataKeys.set(newKeyId, {
            keyId: newKeyId,
            key: dataKey,
            encryptedKey: encryptedDataKey,
            masterKeyId: this.currentMasterKeyId,
            createdAt: Date.now()
        });
        
        return this.dataKeys.get(newKeyId);
    }
    
    async rotateKeys() {
        this.metrics.keyRotations++;
        
        // Generate new master key
        const newKeyId = this.generateKeyId();
        const newMasterKey = this.generateMasterKey();
        
        // Store new master key
        this.masterKeys.set(newKeyId, {
            key: newMasterKey,
            createdAt: Date.now(),
            version: this.masterKeys.get(this.currentMasterKeyId).version + 1,
            active: true
        });
        
        // Mark old key as inactive
        this.masterKeys.get(this.currentMasterKeyId).active = false;
        
        // Re-encrypt all data keys with new master key
        for (const [keyId, dataKeyInfo] of this.dataKeys) {
            const reencryptedKey = await this.encryptWithMasterKey(
                dataKeyInfo.key,
                newMasterKey
            );
            
            dataKeyInfo.encryptedKey = reencryptedKey;
            dataKeyInfo.masterKeyId = newKeyId;
        }
        
        // Update current master key
        const oldKeyId = this.currentMasterKeyId;
        this.currentMasterKeyId = newKeyId;
        
        this.keyMetadata.set(newKeyId, {
            algorithm: this.config.algorithm,
            createdAt: Date.now(),
            rotatedFrom: oldKeyId
        });
        
        this.emit('key-rotated', {
            oldKeyId,
            newKeyId,
            timestamp: Date.now()
        });
        
        // Clean up old keys
        await this.cleanupOldKeys();
    }
    
    async cleanupOldKeys() {
        const now = Date.now();
        const keysToRemove = [];
        
        for (const [keyId, keyInfo] of this.masterKeys) {
            if (!keyInfo.active && (now - keyInfo.createdAt) > this.config.maxKeyAge) {
                keysToRemove.push(keyId);
            }
        }
        
        // Remove old keys
        for (const keyId of keysToRemove) {
            this.masterKeys.delete(keyId);
            this.keyMetadata.delete(keyId);
            
            // Remove associated data keys
            for (const [dataKeyId, dataKeyInfo] of this.dataKeys) {
                if (dataKeyInfo.masterKeyId === keyId) {
                    this.dataKeys.delete(dataKeyId);
                }
            }
        }
        
        if (keysToRemove.length > 0) {
            this.emit('keys-cleaned', {
                removed: keysToRemove.length,
                timestamp: Date.now()
            });
        }
    }
    
    /**
     * Helper methods
     */
    
    generateKeyId() {
        return crypto.randomBytes(16).toString('hex');
    }
    
    generateMasterKey() {
        if (this.config.useHSM) {
            // Generate key in HSM
            return this.generateHSMKey();
        }
        
        return crypto.randomBytes(this.config.masterKeyLength);
    }
    
    generateToken(format = 'alphanumeric') {
        const chars = {
            numeric: '0123456789',
            alpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
            alphanumeric: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
        };
        
        const charset = chars[format] || chars.alphanumeric;
        const length = 32;
        let token = '';
        
        for (let i = 0; i < length; i++) {
            token += charset[crypto.randomInt(charset.length)];
        }
        
        return token;
    }
    
    async encryptWithMasterKey(data, masterKey) {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', masterKey, iv);
        
        const encrypted = Buffer.concat([
            cipher.update(data),
            cipher.final()
        ]);
        
        return {
            iv: iv.toString('base64'),
            data: encrypted.toString('base64')
        };
    }
    
    calculateHMAC(data, key) {
        const hmac = crypto.createHmac(this.config.hashAlgorithm, key);
        
        // Create consistent string representation
        const dataString = JSON.stringify({
            version: data.version,
            keyId: data.keyId,
            algorithm: data.algorithm,
            iv: data.iv,
            authTag: data.authTag,
            ciphertext: data.ciphertext,
            timestamp: data.timestamp
        });
        
        hmac.update(dataString);
        return hmac.digest('base64');
    }
    
    prepareDataForEncryption(data) {
        if (typeof data === 'string') {
            return Buffer.from(data, 'utf8');
        } else if (Buffer.isBuffer(data)) {
            return data;
        } else {
            return Buffer.from(JSON.stringify(data), 'utf8');
        }
    }
    
    parseDecryptedData(decrypted) {
        try {
            return JSON.parse(decrypted);
        } catch {
            return decrypted;
        }
    }
    
    validateEncryptedPackage(package) {
        const required = ['keyId', 'iv', 'ciphertext', 'hmac'];
        
        for (const field of required) {
            if (!package[field]) {
                throw new Error(`Missing required field: ${field}`);
            }
        }
        
        // Check package age
        if (package.timestamp) {
            const age = Date.now() - package.timestamp;
            if (age > 86400000) { // 24 hours
                console.warn('Encrypted package is older than 24 hours');
            }
        }
    }
    
    isEncryptedPackage(value) {
        return value && 
               typeof value === 'object' && 
               value.keyId && 
               value.ciphertext &&
               value.iv;
    }
    
    isSensitiveField(fieldName) {
        const sensitivePatterns = [
            /password/i,
            /secret/i,
            /key/i,
            /token/i,
            /ssn/i,
            /credit/i,
            /cvv/i,
            /pin/i
        ];
        
        return sensitivePatterns.some(pattern => pattern.test(fieldName));
    }
    
    encodeToFormat(data, format, original) {
        // Simplified format preservation
        if (format === 'creditCard') {
            // Preserve credit card format (e.g., 1234-5678-9012-3456)
            const hash = crypto.createHash('sha256').update(data).digest('hex');
            const nums = hash.replace(/[a-f]/gi, '');
            return original.replace(/\d/g, (match, offset) => nums[offset % nums.length]);
        }
        
        // Default: return base64 encoded
        return data;
    }
    
    /**
     * HSM integration methods (placeholder)
     */
    
    generateHSMKey() {
        // Integration with hardware security module
        console.log('HSM key generation not implemented');
        return crypto.randomBytes(this.config.masterKeyLength);
    }
    
    /**
     * Token storage methods (placeholder)
     */
    
    async storeTokenMapping(token, encrypted) {
        // Store in secure database
        // This is a placeholder - implement actual storage
    }
    
    async getTokenMapping(token) {
        // Retrieve from secure database
        // This is a placeholder - implement actual retrieval
        return null;
    }
    
    /**
     * Start key rotation schedule
     */
    startKeyRotation() {
        setInterval(async () => {
            await this.rotateKeys();
        }, this.config.keyRotationInterval);
        
        // Also rotate if current key is too old
        setInterval(async () => {
            const currentKey = this.masterKeys.get(this.currentMasterKeyId);
            if (currentKey && (Date.now() - currentKey.createdAt) > this.config.maxKeyAge) {
                await this.rotateKeys();
            }
        }, 3600000); // Check every hour
    }
    
    /**
     * Export key metadata for backup
     */
    exportKeyMetadata() {
        const metadata = {
            version: 1,
            exportedAt: Date.now(),
            currentMasterKeyId: this.currentMasterKeyId,
            keys: []
        };
        
        for (const [keyId, info] of this.keyMetadata) {
            metadata.keys.push({
                keyId,
                ...info
            });
        }
        
        return metadata;
    }
    
    /**
     * Get encryption metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            activeMasterKeys: Array.from(this.masterKeys.values()).filter(k => k.active).length,
            totalMasterKeys: this.masterKeys.size,
            dataKeys: this.dataKeys.size,
            keyAge: this.currentMasterKeyId ? 
                Date.now() - this.masterKeys.get(this.currentMasterKeyId).createdAt : 0
        };
    }
}

module.exports = AdvancedDataEncryption;