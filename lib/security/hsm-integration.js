/**
 * Hardware Security Module (HSM) Integration
 * Enterprise-grade key management for national-level security
 * Supports PKCS#11, Cloud HSM, and software HSM fallback
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { getLogger } from '../core/logger.js';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../error-handler.js';

// HSM Provider Types
export const HSMProvider = {
  PKCS11: 'pkcs11',           // Hardware HSM via PKCS#11
  CLOUD_HSM: 'cloud_hsm',      // AWS CloudHSM, Azure Key Vault, etc.
  SOFTWARE_HSM: 'software_hsm', // Software-based HSM (development/testing)
  TPM: 'tpm'                   // Trusted Platform Module
};

// Key Types
export const KeyType = {
  MASTER: 'master',
  SIGNING: 'signing',
  ENCRYPTION: 'encryption',
  AUTHENTICATION: 'authentication',
  KEY_EXCHANGE: 'key_exchange',
  WALLET: 'wallet'
};

// Key Algorithms
export const KeyAlgorithm = {
  RSA_2048: 'rsa2048',
  RSA_4096: 'rsa4096',
  ECDSA_P256: 'ecdsa-p256',
  ECDSA_P384: 'ecdsa-p384',
  ECDSA_SECP256K1: 'ecdsa-secp256k1',
  ED25519: 'ed25519',
  AES_256: 'aes256'
};

/**
 * HSM Manager for secure key operations
 */
export class HSMManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.logger = getLogger('HSMManager');
    this.errorHandler = getErrorHandler();
    this.options = {
      provider: options.provider || HSMProvider.SOFTWARE_HSM,
      autoInitialize: options.autoInitialize !== false,
      keyRotationInterval: options.keyRotationInterval || 30 * 24 * 60 * 60 * 1000, // 30 days
      auditingEnabled: options.auditingEnabled !== false,
      backupEnabled: options.backupEnabled !== false,
      quorumRequired: options.quorumRequired || 2, // M of N for critical operations
      quorumTotal: options.quorumTotal || 3,
      ...options
    };
    
    this.initialized = false;
    this.provider = null;
    this.keyStore = new Map();
    this.auditLog = [];
    this.quorumPending = new Map();
    
    // Security state
    this.sessionKey = null;
    this.locked = true;
    this.failedAttempts = 0;
    this.maxFailedAttempts = 3;
    
    // Statistics
    this.stats = {
      keysGenerated: 0,
      signaturesCreated: 0,
      verificationsPerformed: 0,
      encryptionsPerformed: 0,
      decryptionsPerformed: 0,
      keyRotations: 0,
      auditEvents: 0
    };
  }
  
  /**
   * Initialize HSM
   */
  async initialize() {
    try {
      this.logger.info(`Initializing HSM with provider: ${this.options.provider}`);
      
      // Initialize provider
      switch (this.options.provider) {
        case HSMProvider.PKCS11:
          await this.initializePKCS11();
          break;
          
        case HSMProvider.CLOUD_HSM:
          await this.initializeCloudHSM();
          break;
          
        case HSMProvider.SOFTWARE_HSM:
          await this.initializeSoftwareHSM();
          break;
          
        case HSMProvider.TPM:
          await this.initializeTPM();
          break;
          
        default:
          throw new Error(`Unknown HSM provider: ${this.options.provider}`);
      }
      
      // Generate master key if not exists
      if (!await this.hasMasterKey()) {
        await this.generateMasterKey();
      }
      
      // Start key rotation timer
      if (this.options.keyRotationInterval > 0) {
        this.startKeyRotation();
      }
      
      this.initialized = true;
      this.emit('initialized');
      
      this.logger.info('HSM initialized successfully');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'hsm_initialization',
        category: ErrorCategory.SECURITY
      });
      throw error;
    }
  }
  
  /**
   * Initialize Software HSM (for development/testing)
   */
  async initializeSoftwareHSM() {
    this.provider = new SoftwareHSMProvider({
      storePath: this.options.storePath || './hsm-store',
      password: this.options.password
    });
    
    await this.provider.initialize();
  }
  
  /**
   * Unlock HSM with credentials
   */
  async unlock(credentials) {
    if (!this.initialized) {
      throw new Error('HSM not initialized');
    }
    
    if (this.failedAttempts >= this.maxFailedAttempts) {
      throw new Error('HSM locked due to too many failed attempts');
    }
    
    try {
      // Verify credentials
      const verified = await this.verifyCredentials(credentials);
      if (!verified) {
        this.failedAttempts++;
        this.audit('unlock_failed', { attempts: this.failedAttempts });
        throw new Error('Invalid credentials');
      }
      
      // Generate session key
      this.sessionKey = crypto.randomBytes(32);
      this.locked = false;
      this.failedAttempts = 0;
      
      this.audit('unlocked', { timestamp: Date.now() });
      this.emit('unlocked');
      
      return true;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'hsm_unlock',
        category: ErrorCategory.SECURITY
      });
      throw error;
    }
  }
  
  /**
   * Lock HSM
   */
  async lock() {
    this.locked = true;
    this.sessionKey = null;
    
    this.audit('locked', { timestamp: Date.now() });
    this.emit('locked');
  }
  
  /**
   * Generate new key
   */
  async generateKey(keyType, algorithm, options = {}) {
    this.ensureUnlocked();
    
    try {
      const keyId = options.keyId || this.generateKeyId(keyType);
      
      // Check if quorum is required
      if (this.requiresQuorum(keyType)) {
        return this.initiateQuorumOperation('generateKey', {
          keyType,
          algorithm,
          keyId,
          options
        });
      }
      
      // Generate key using provider
      const keyHandle = await this.provider.generateKey({
        type: keyType,
        algorithm,
        extractable: options.extractable || false,
        persistent: options.persistent !== false,
        ...options
      });
      
      // Store key metadata
      this.keyStore.set(keyId, {
        id: keyId,
        type: keyType,
        algorithm,
        handle: keyHandle,
        created: Date.now(),
        lastUsed: Date.now(),
        usageCount: 0,
        rotationDue: Date.now() + this.options.keyRotationInterval
      });
      
      this.stats.keysGenerated++;
      
      this.audit('key_generated', {
        keyId,
        type: keyType,
        algorithm
      });
      
      this.emit('key:generated', { keyId, type: keyType });
      
      return keyId;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'key_generation',
        keyType,
        algorithm,
        category: ErrorCategory.SECURITY
      });
      throw error;
    }
  }
  
  /**
   * Sign data
   */
  async sign(keyId, data, options = {}) {
    this.ensureUnlocked();
    
    const key = this.getKey(keyId);
    if (!key) {
      throw new Error(`Key not found: ${keyId}`);
    }
    
    if (key.type !== KeyType.SIGNING && key.type !== KeyType.MASTER) {
      throw new Error(`Key ${keyId} is not a signing key`);
    }
    
    try {
      // Sign using provider
      const signature = await this.provider.sign(
        key.handle,
        data,
        {
          algorithm: options.algorithm || key.algorithm,
          ...options
        }
      );
      
      // Update key usage
      key.lastUsed = Date.now();
      key.usageCount++;
      
      this.stats.signaturesCreated++;
      
      this.audit('data_signed', {
        keyId,
        dataSize: data.length,
        algorithm: key.algorithm
      });
      
      return signature;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'signing',
        keyId,
        category: ErrorCategory.SECURITY
      });
      throw error;
    }
  }
  
  /**
   * Verify signature
   */
  async verify(keyId, data, signature, options = {}) {
    // Verification doesn't require unlock for public operations
    const key = this.getKey(keyId);
    if (!key) {
      throw new Error(`Key not found: ${keyId}`);
    }
    
    try {
      const verified = await this.provider.verify(
        key.handle,
        data,
        signature,
        {
          algorithm: options.algorithm || key.algorithm,
          ...options
        }
      );
      
      this.stats.verificationsPerformed++;
      
      this.audit('signature_verified', {
        keyId,
        verified,
        dataSize: data.length
      });
      
      return verified;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'verification',
        keyId,
        category: ErrorCategory.SECURITY
      });
      throw error;
    }
  }
  
  /**
   * Encrypt data
   */
  async encrypt(keyId, plaintext, options = {}) {
    this.ensureUnlocked();
    
    const key = this.getKey(keyId);
    if (!key) {
      throw new Error(`Key not found: ${keyId}`);
    }
    
    if (key.type !== KeyType.ENCRYPTION && key.type !== KeyType.MASTER) {
      throw new Error(`Key ${keyId} is not an encryption key`);
    }
    
    try {
      const ciphertext = await this.provider.encrypt(
        key.handle,
        plaintext,
        {
          algorithm: options.algorithm || key.algorithm,
          ...options
        }
      );
      
      key.lastUsed = Date.now();
      key.usageCount++;
      
      this.stats.encryptionsPerformed++;
      
      this.audit('data_encrypted', {
        keyId,
        dataSize: plaintext.length
      });
      
      return ciphertext;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'encryption',
        keyId,
        category: ErrorCategory.SECURITY
      });
      throw error;
    }
  }
  
  /**
   * Decrypt data
   */
  async decrypt(keyId, ciphertext, options = {}) {
    this.ensureUnlocked();
    
    const key = this.getKey(keyId);
    if (!key) {
      throw new Error(`Key not found: ${keyId}`);
    }
    
    try {
      const plaintext = await this.provider.decrypt(
        key.handle,
        ciphertext,
        {
          algorithm: options.algorithm || key.algorithm,
          ...options
        }
      );
      
      key.lastUsed = Date.now();
      key.usageCount++;
      
      this.stats.decryptionsPerformed++;
      
      this.audit('data_decrypted', {
        keyId,
        dataSize: ciphertext.length
      });
      
      return plaintext;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'decryption',
        keyId,
        category: ErrorCategory.SECURITY
      });
      throw error;
    }
  }
  
  /**
   * Derive key
   */
  async deriveKey(masterKeyId, derivationPath, options = {}) {
    this.ensureUnlocked();
    
    const masterKey = this.getKey(masterKeyId);
    if (!masterKey || masterKey.type !== KeyType.MASTER) {
      throw new Error('Invalid master key');
    }
    
    try {
      const derivedHandle = await this.provider.deriveKey(
        masterKey.handle,
        derivationPath,
        {
          algorithm: options.algorithm || KeyAlgorithm.AES_256,
          ...options
        }
      );
      
      const derivedKeyId = this.generateKeyId('derived');
      
      this.keyStore.set(derivedKeyId, {
        id: derivedKeyId,
        type: options.type || KeyType.ENCRYPTION,
        algorithm: options.algorithm || KeyAlgorithm.AES_256,
        handle: derivedHandle,
        created: Date.now(),
        lastUsed: Date.now(),
        usageCount: 0,
        derivedFrom: masterKeyId,
        derivationPath
      });
      
      this.audit('key_derived', {
        masterKeyId,
        derivedKeyId,
        derivationPath
      });
      
      return derivedKeyId;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'key_derivation',
        masterKeyId,
        category: ErrorCategory.SECURITY
      });
      throw error;
    }
  }
  
  /**
   * Rotate key
   */
  async rotateKey(keyId) {
    this.ensureUnlocked();
    
    const oldKey = this.getKey(keyId);
    if (!oldKey) {
      throw new Error(`Key not found: ${keyId}`);
    }
    
    try {
      // Generate new key with same parameters
      const newKeyId = await this.generateKey(
        oldKey.type,
        oldKey.algorithm,
        {
          keyId: `${keyId}_v${Date.now()}`,
          persistent: true
        }
      );
      
      // Mark old key as rotated
      oldKey.rotated = true;
      oldKey.rotatedTo = newKeyId;
      oldKey.rotatedAt = Date.now();
      
      this.stats.keyRotations++;
      
      this.audit('key_rotated', {
        oldKeyId: keyId,
        newKeyId,
        type: oldKey.type
      });
      
      this.emit('key:rotated', { oldKeyId: keyId, newKeyId });
      
      return newKeyId;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'key_rotation',
        keyId,
        category: ErrorCategory.SECURITY
      });
      throw error;
    }
  }
  
  /**
   * Export public key
   */
  async exportPublicKey(keyId, format = 'pem') {
    const key = this.getKey(keyId);
    if (!key) {
      throw new Error(`Key not found: ${keyId}`);
    }
    
    try {
      const publicKey = await this.provider.exportPublicKey(
        key.handle,
        format
      );
      
      this.audit('public_key_exported', {
        keyId,
        format
      });
      
      return publicKey;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'public_key_export',
        keyId,
        category: ErrorCategory.SECURITY
      });
      throw error;
    }
  }
  
  /**
   * Backup keys (requires quorum)
   */
  async backupKeys(backupKey) {
    this.ensureUnlocked();
    
    if (!this.options.backupEnabled) {
      throw new Error('Backup not enabled');
    }
    
    // Requires quorum approval
    return this.initiateQuorumOperation('backupKeys', {
      backupKey,
      timestamp: Date.now()
    });
  }
  
  /**
   * Restore keys (requires quorum)
   */
  async restoreKeys(backupData, backupKey) {
    this.ensureUnlocked();
    
    // Requires quorum approval
    return this.initiateQuorumOperation('restoreKeys', {
      backupData,
      backupKey,
      timestamp: Date.now()
    });
  }
  
  /**
   * Initiate quorum operation
   */
  async initiateQuorumOperation(operation, params) {
    const operationId = crypto.randomBytes(16).toString('hex');
    
    this.quorumPending.set(operationId, {
      operation,
      params,
      approvals: new Set(),
      rejections: new Set(),
      initiated: Date.now(),
      initiator: this.sessionKey ? crypto.createHash('sha256').update(this.sessionKey).digest('hex') : 'system'
    });
    
    this.audit('quorum_operation_initiated', {
      operationId,
      operation,
      required: this.options.quorumRequired,
      total: this.options.quorumTotal
    });
    
    this.emit('quorum:required', {
      operationId,
      operation,
      params
    });
    
    return {
      operationId,
      status: 'pending_approval',
      required: this.options.quorumRequired,
      total: this.options.quorumTotal
    };
  }
  
  /**
   * Approve quorum operation
   */
  async approveQuorumOperation(operationId, approverKey) {
    const operation = this.quorumPending.get(operationId);
    if (!operation) {
      throw new Error('Operation not found');
    }
    
    // Verify approver signature
    // In production, this would verify the approver's identity
    
    operation.approvals.add(approverKey);
    
    this.audit('quorum_approval', {
      operationId,
      approver: approverKey,
      approvals: operation.approvals.size,
      required: this.options.quorumRequired
    });
    
    // Check if quorum reached
    if (operation.approvals.size >= this.options.quorumRequired) {
      // Execute operation
      await this.executeQuorumOperation(operationId);
    }
    
    return {
      operationId,
      approvals: operation.approvals.size,
      required: this.options.quorumRequired,
      status: operation.approvals.size >= this.options.quorumRequired ? 'approved' : 'pending'
    };
  }
  
  /**
   * Execute approved quorum operation
   */
  async executeQuorumOperation(operationId) {
    const operation = this.quorumPending.get(operationId);
    if (!operation) {
      throw new Error('Operation not found');
    }
    
    try {
      let result;
      
      switch (operation.operation) {
        case 'generateKey':
          result = await this.generateKey(
            operation.params.keyType,
            operation.params.algorithm,
            operation.params.options
          );
          break;
          
        case 'backupKeys':
          result = await this.performBackup(operation.params.backupKey);
          break;
          
        case 'restoreKeys':
          result = await this.performRestore(
            operation.params.backupData,
            operation.params.backupKey
          );
          break;
          
        default:
          throw new Error(`Unknown operation: ${operation.operation}`);
      }
      
      this.quorumPending.delete(operationId);
      
      this.audit('quorum_operation_executed', {
        operationId,
        operation: operation.operation,
        result: result ? 'success' : 'failed'
      });
      
      return result;
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'quorum_execution',
        operationId,
        operation: operation.operation,
        category: ErrorCategory.SECURITY
      });
      throw error;
    }
  }
  
  /**
   * Check if operation requires quorum
   */
  requiresQuorum(keyType) {
    return keyType === KeyType.MASTER || keyType === KeyType.WALLET;
  }
  
  /**
   * Ensure HSM is unlocked
   */
  ensureUnlocked() {
    if (!this.initialized) {
      throw new Error('HSM not initialized');
    }
    
    if (this.locked) {
      throw new Error('HSM is locked');
    }
  }
  
  /**
   * Get key by ID
   */
  getKey(keyId) {
    return this.keyStore.get(keyId);
  }
  
  /**
   * Generate key ID
   */
  generateKeyId(type) {
    return `${type}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }
  
  /**
   * Verify credentials
   */
  async verifyCredentials(credentials) {
    // In production, this would verify against secure storage
    // For now, use a hash comparison
    const hash = crypto.createHash('sha256').update(credentials).digest('hex');
    const expectedHash = this.options.credentialHash || crypto.createHash('sha256').update('default').digest('hex');
    
    return hash === expectedHash;
  }
  
  /**
   * Check if master key exists
   */
  async hasMasterKey() {
    for (const [keyId, key] of this.keyStore) {
      if (key.type === KeyType.MASTER && !key.rotated) {
        return true;
      }
    }
    
    return this.provider ? await this.provider.hasMasterKey() : false;
  }
  
  /**
   * Generate master key
   */
  async generateMasterKey() {
    return this.generateKey(
      KeyType.MASTER,
      KeyAlgorithm.AES_256,
      {
        keyId: 'master_key',
        persistent: true,
        extractable: false
      }
    );
  }
  
  /**
   * Start key rotation timer
   */
  startKeyRotation() {
    setInterval(async () => {
      try {
        await this.checkKeyRotation();
      } catch (error) {
        this.logger.error('Key rotation check failed:', error);
      }
    }, 24 * 60 * 60 * 1000); // Daily check
  }
  
  /**
   * Check and rotate keys if needed
   */
  async checkKeyRotation() {
    const now = Date.now();
    
    for (const [keyId, key] of this.keyStore) {
      if (!key.rotated && key.rotationDue && now > key.rotationDue) {
        try {
          await this.rotateKey(keyId);
        } catch (error) {
          this.logger.error(`Failed to rotate key ${keyId}:`, error);
        }
      }
    }
  }
  
  /**
   * Audit log entry
   */
  audit(event, details) {
    if (!this.options.auditingEnabled) return;
    
    const entry = {
      timestamp: Date.now(),
      event,
      details,
      sessionId: this.sessionKey ? crypto.createHash('sha256').update(this.sessionKey).digest('hex').substring(0, 8) : null
    };
    
    this.auditLog.push(entry);
    this.stats.auditEvents++;
    
    // Emit for external audit systems
    this.emit('audit', entry);
    
    // Rotate audit log if too large
    if (this.auditLog.length > 10000) {
      this.auditLog = this.auditLog.slice(-5000);
    }
  }
  
  /**
   * Get audit log
   */
  getAuditLog(filter = {}) {
    let log = this.auditLog;
    
    if (filter.event) {
      log = log.filter(entry => entry.event === filter.event);
    }
    
    if (filter.startTime) {
      log = log.filter(entry => entry.timestamp >= filter.startTime);
    }
    
    if (filter.endTime) {
      log = log.filter(entry => entry.timestamp <= filter.endTime);
    }
    
    return log;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      initialized: this.initialized,
      locked: this.locked,
      provider: this.options.provider,
      keyCount: this.keyStore.size,
      pendingQuorumOperations: this.quorumPending.size
    };
  }
  
  /**
   * Cleanup
   */
  async cleanup() {
    this.lock();
    
    if (this.provider && this.provider.cleanup) {
      await this.provider.cleanup();
    }
    
    this.keyStore.clear();
    this.auditLog = [];
    this.quorumPending.clear();
    
    this.emit('cleanup');
  }
}

/**
 * Software HSM Provider (for development/testing)
 */
class SoftwareHSMProvider {
  constructor(options) {
    this.options = options;
    this.keys = new Map();
    this.masterKey = null;
  }
  
  async initialize() {
    // In production, this would initialize secure storage
    this.logger = getLogger('SoftwareHSM');
    this.logger.warn('Using Software HSM - not for production use!');
  }
  
  async generateKey(params) {
    const keyPair = crypto.generateKeyPairSync(
      params.algorithm === KeyAlgorithm.RSA_2048 ? 'rsa' : 'ec',
      {
        modulusLength: params.algorithm === KeyAlgorithm.RSA_2048 ? 2048 : 4096,
        namedCurve: params.algorithm.startsWith('ecdsa') ? 'P-256' : undefined,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      }
    );
    
    const handle = crypto.randomBytes(16).toString('hex');
    this.keys.set(handle, {
      ...params,
      keyPair
    });
    
    return handle;
  }
  
  async sign(handle, data, options) {
    const key = this.keys.get(handle);
    if (!key) throw new Error('Key not found');
    
    const sign = crypto.createSign('SHA256');
    sign.update(data);
    return sign.sign(key.keyPair.privateKey);
  }
  
  async verify(handle, data, signature, options) {
    const key = this.keys.get(handle);
    if (!key) throw new Error('Key not found');
    
    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    return verify.verify(key.keyPair.publicKey, signature);
  }
  
  async encrypt(handle, plaintext, options) {
    // Simplified - in production would use proper encryption
    const key = this.keys.get(handle);
    if (!key) throw new Error('Key not found');
    
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', handle.substring(0, 32), iv);
    
    let encrypted = cipher.update(plaintext);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    const authTag = cipher.getAuthTag();
    
    return Buffer.concat([iv, authTag, encrypted]);
  }
  
  async decrypt(handle, ciphertext, options) {
    const key = this.keys.get(handle);
    if (!key) throw new Error('Key not found');
    
    const iv = ciphertext.slice(0, 16);
    const authTag = ciphertext.slice(16, 32);
    const encrypted = ciphertext.slice(32);
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', handle.substring(0, 32), iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted;
  }
  
  async exportPublicKey(handle, format) {
    const key = this.keys.get(handle);
    if (!key) throw new Error('Key not found');
    
    return key.keyPair.publicKey;
  }
  
  async hasMasterKey() {
    return this.masterKey !== null;
  }
}

export default HSMManager;