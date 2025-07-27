/**
 * Secret Manager for Otedama
 * Secure handling of sensitive configuration and credentials
 * 
 * Design principles:
 * - Martin: Single responsibility - only handles secrets
 * - Pike: Simple and secure by default
 * - Carmack: Fast access with minimal overhead
 */

import { createStructuredLogger } from '../core/structured-logger.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const logger = createStructuredLogger('SecretManager');
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

// Encryption algorithm
const ALGORITHM = 'aes-256-gcm';
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

export class SecretManager {
  constructor(options = {}) {
    this.secretsPath = options.secretsPath || path.join(process.cwd(), '.secrets');
    this.envFile = options.envFile || '.env';
    this.masterKeyEnvVar = options.masterKeyEnvVar || 'OTEDAMA_MASTER_KEY';
    this.autoGenerateMasterKey = options.autoGenerateMasterKey !== false;
    
    // In-memory cache for decrypted secrets
    this.secrets = new Map();
    this.masterKey = null;
    
    // Sensitive patterns to detect
    this.sensitivePatterns = [
      /password/i,
      /secret/i,
      /key/i,
      /token/i,
      /credential/i,
      /private/i,
      /api[-_]?key/i,
      /auth/i,
      /seed/i,
      /mnemonic/i
    ];
  }
  
  /**
   * Initialize secret manager
   */
  async initialize() {
    try {
      // Load or generate master key
      await this.loadMasterKey();
      
      // Create secrets directory if it doesn't exist
      if (!fs.existsSync(this.secretsPath)) {
        fs.mkdirSync(this.secretsPath, { recursive: true, mode: 0o700 });
      }
      
      // Load existing secrets
      await this.loadSecrets();
      
      logger.info('Secret manager initialized');
    } catch (error) {
      logger.error('Failed to initialize secret manager:', error);
      throw error;
    }
  }
  
  /**
   * Load or generate master key
   */
  async loadMasterKey() {
    // Check environment variable
    let masterKey = process.env[this.masterKeyEnvVar];
    
    if (!masterKey && this.autoGenerateMasterKey) {
      // Generate new master key
      masterKey = crypto.randomBytes(KEY_LENGTH).toString('base64');
      
      // Save to .env file
      await this.saveMasterKeyToEnv(masterKey);
      
      logger.warn('Generated new master key. Please backup the .env file!');
    }
    
    if (!masterKey) {
      throw new Error(`Master key not found. Set ${this.masterKeyEnvVar} environment variable.`);
    }
    
    // Derive key from master key
    this.masterKey = crypto.pbkdf2Sync(
      masterKey,
      'otedama-secret-manager',
      ITERATIONS,
      KEY_LENGTH,
      'sha256'
    );
  }
  
  /**
   * Save master key to .env file
   */
  async saveMasterKeyToEnv(masterKey) {
    const envPath = path.join(process.cwd(), this.envFile);
    let envContent = '';
    
    try {
      envContent = await readFile(envPath, 'utf8');
    } catch (error) {
      // File doesn't exist, create it
    }
    
    // Check if master key already exists
    const keyRegex = new RegExp(`^${this.masterKeyEnvVar}=.*$`, 'm');
    if (keyRegex.test(envContent)) {
      // Update existing key
      envContent = envContent.replace(keyRegex, `${this.masterKeyEnvVar}=${masterKey}`);
    } else {
      // Add new key
      envContent += `\n${this.masterKeyEnvVar}=${masterKey}\n`;
    }
    
    await writeFile(envPath, envContent, { mode: 0o600 });
  }
  
  /**
   * Encrypt data
   */
  encrypt(data) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    
    // Derive key from master key and salt
    const key = crypto.pbkdf2Sync(this.masterKey, salt, ITERATIONS, KEY_LENGTH, 'sha256');
    
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(data), 'utf8'),
      cipher.final()
    ]);
    
    const tag = cipher.getAuthTag();
    
    // Combine salt, iv, tag, and encrypted data
    return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
  }
  
  /**
   * Decrypt data
   */
  decrypt(encryptedData) {
    const buffer = Buffer.from(encryptedData, 'base64');
    
    // Extract components
    const salt = buffer.slice(0, SALT_LENGTH);
    const iv = buffer.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = buffer.slice(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const encrypted = buffer.slice(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    
    // Derive key from master key and salt
    const key = crypto.pbkdf2Sync(this.masterKey, salt, ITERATIONS, KEY_LENGTH, 'sha256');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    
    return JSON.parse(decrypted.toString('utf8'));
  }
  
  /**
   * Set a secret
   */
  async setSecret(name, value) {
    // Store in memory
    this.secrets.set(name, value);
    
    // Save encrypted to disk
    await this.saveSecrets();
    
    logger.info(`Secret set: ${name}`);
  }
  
  /**
   * Get a secret
   */
  getSecret(name, defaultValue = null) {
    return this.secrets.get(name) || defaultValue;
  }
  
  /**
   * Remove a secret
   */
  async removeSecret(name) {
    this.secrets.delete(name);
    await this.saveSecrets();
    logger.info(`Secret removed: ${name}`);
  }
  
  /**
   * Load secrets from disk
   */
  async loadSecrets() {
    const secretsFile = path.join(this.secretsPath, 'secrets.enc');
    
    try {
      const encryptedData = await readFile(secretsFile, 'utf8');
      const decrypted = this.decrypt(encryptedData);
      
      // Load into memory
      for (const [key, value] of Object.entries(decrypted)) {
        this.secrets.set(key, value);
      }
      
      logger.info(`Loaded ${this.secrets.size} secrets`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist yet
        logger.info('No existing secrets file found');
      } else {
        logger.error('Failed to load secrets:', error);
        throw error;
      }
    }
  }
  
  /**
   * Save secrets to disk
   */
  async saveSecrets() {
    const secretsFile = path.join(this.secretsPath, 'secrets.enc');
    
    // Convert to object
    const secretsObj = {};
    for (const [key, value] of this.secrets) {
      secretsObj[key] = value;
    }
    
    // Encrypt and save
    const encrypted = this.encrypt(secretsObj);
    await writeFile(secretsFile, encrypted, { mode: 0o600 });
  }
  
  /**
   * Load configuration with automatic secret detection
   */
  async loadConfig(config) {
    const processedConfig = {};
    
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'object' && value !== null) {
        // Recursively process nested objects
        processedConfig[key] = await this.loadConfig(value);
      } else if (this.isSensitive(key)) {
        // This looks like a secret, store it securely
        const secretKey = `config_${key}`;
        await this.setSecret(secretKey, value);
        processedConfig[key] = `SECRET:${secretKey}`;
      } else {
        processedConfig[key] = value;
      }
    }
    
    return processedConfig;
  }
  
  /**
   * Resolve configuration with secrets
   */
  resolveConfig(config) {
    const resolvedConfig = {};
    
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'object' && value !== null) {
        // Recursively resolve nested objects
        resolvedConfig[key] = this.resolveConfig(value);
      } else if (typeof value === 'string' && value.startsWith('SECRET:')) {
        // Resolve secret reference
        const secretKey = value.substring(7);
        resolvedConfig[key] = this.getSecret(secretKey);
      } else {
        resolvedConfig[key] = value;
      }
    }
    
    return resolvedConfig;
  }
  
  /**
   * Check if a key name appears to be sensitive
   */
  isSensitive(key) {
    return this.sensitivePatterns.some(pattern => pattern.test(key));
  }
  
  /**
   * Generate secure random values
   */
  generateSecureRandom(type = 'hex', length = 32) {
    const bytes = crypto.randomBytes(length);
    
    switch (type) {
      case 'hex':
        return bytes.toString('hex');
      case 'base64':
        return bytes.toString('base64');
      case 'alphanumeric':
        return bytes.toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, length);
      default:
        return bytes;
    }
  }
  
  /**
   * Clear all secrets from memory
   */
  clearMemory() {
    this.secrets.clear();
    if (this.masterKey) {
      crypto.randomFillSync(this.masterKey);
      this.masterKey = null;
    }
  }
  
  /**
   * Shutdown and clear sensitive data
   */
  async shutdown() {
    logger.info('Shutting down secret manager...');
    this.clearMemory();
  }
}

// Singleton instance
export const secretManager = new SecretManager();

export default SecretManager;