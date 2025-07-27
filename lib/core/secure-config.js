/**
 * Secure Configuration Manager
 * Integrates configuration management with secret management
 * 
 * Design principles:
 * - Martin: Separation of configuration and secrets
 * - Pike: Simple and secure configuration access
 * - Carmack: Fast configuration resolution
 */

import { configManager } from './config-manager.js';
import { secretManager } from '../security/secret-manager.js';
import { createStructuredLogger } from './structured-logger.js';

const logger = createStructuredLogger('SecureConfig');

export class SecureConfigManager {
  constructor() {
    this.initialized = false;
  }
  
  /**
   * Initialize secure configuration
   */
  async initialize(options = {}) {
    if (this.initialized) return;
    
    try {
      // Initialize secret manager first
      await secretManager.initialize();
      
      // Load configuration
      await configManager.load(options);
      
      // Process configuration to identify and store secrets
      const config = configManager.getAll();
      const processedConfig = await this.processConfigForSecrets(config);
      
      // Update configuration with secret references
      configManager.setAll(processedConfig);
      
      this.initialized = true;
      logger.info('Secure configuration initialized');
    } catch (error) {
      logger.error('Failed to initialize secure configuration:', error);
      throw error;
    }
  }
  
  /**
   * Process configuration to identify and store secrets
   */
  async processConfigForSecrets(config, prefix = '') {
    const processed = {};
    
    for (const [key, value] of Object.entries(config)) {
      const fullKey = prefix ? `${prefix}_${key}` : key;
      
      if (value === null || value === undefined) {
        processed[key] = value;
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        // Recursively process nested objects
        processed[key] = await this.processConfigForSecrets(value, fullKey);
      } else if (this.isSecret(key, value)) {
        // Store as secret and replace with reference
        await secretManager.setSecret(fullKey, value);
        processed[key] = `SECRET:${fullKey}`;
        logger.debug(`Stored secret: ${fullKey}`);
      } else {
        processed[key] = value;
      }
    }
    
    return processed;
  }
  
  /**
   * Check if a configuration value should be treated as a secret
   */
  isSecret(key, value) {
    // Check if key name indicates a secret
    if (secretManager.isSensitive(key)) {
      return true;
    }
    
    // Check if value looks like a secret
    if (typeof value === 'string') {
      // Long random-looking strings
      if (value.length > 20 && /^[a-zA-Z0-9+/=_-]+$/.test(value)) {
        return true;
      }
      
      // JWT tokens
      if (value.startsWith('eyJ')) {
        return true;
      }
      
      // API keys with common prefixes
      if (/^(sk_|pk_|api_|key_|token_)/i.test(value)) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Get configuration with resolved secrets
   */
  get(path, defaultValue) {
    const value = configManager.get(path, defaultValue);
    return this.resolveValue(value);
  }
  
  /**
   * Get all configuration with resolved secrets
   */
  getAll() {
    const config = configManager.getAll();
    return this.resolveConfig(config);
  }
  
  /**
   * Resolve configuration values
   */
  resolveConfig(config) {
    const resolved = {};
    
    for (const [key, value] of Object.entries(config)) {
      resolved[key] = this.resolveValue(value);
    }
    
    return resolved;
  }
  
  /**
   * Resolve a single value
   */
  resolveValue(value) {
    if (value === null || value === undefined) {
      return value;
    }
    
    if (typeof value === 'object' && !Array.isArray(value)) {
      // Recursively resolve nested objects
      return this.resolveConfig(value);
    }
    
    if (typeof value === 'string' && value.startsWith('SECRET:')) {
      // Resolve secret reference
      const secretKey = value.substring(7);
      return secretManager.getSecret(secretKey);
    }
    
    return value;
  }
  
  /**
   * Set a configuration value (with automatic secret detection)
   */
  async set(path, value) {
    if (this.isSecret(path, value)) {
      // Store as secret
      const secretKey = path.replace(/\./g, '_');
      await secretManager.setSecret(secretKey, value);
      configManager.set(path, `SECRET:${secretKey}`);
    } else {
      configManager.set(path, value);
    }
  }
  
  /**
   * Generate and store a new secret
   */
  async generateSecret(name, options = {}) {
    const {
      type = 'hex',
      length = 32,
      save = true
    } = options;
    
    const secret = secretManager.generateSecureRandom(type, length);
    
    if (save) {
      await secretManager.setSecret(name, secret);
    }
    
    return secret;
  }
  
  /**
   * Get database connection string with password resolved
   */
  getDatabaseUrl() {
    const dbConfig = this.get('database', {});
    
    if (dbConfig.url) {
      return dbConfig.url;
    }
    
    // Build connection string
    const {
      host = 'localhost',
      port = 5432,
      database = 'otedama',
      username = 'otedama',
      password = ''
    } = dbConfig;
    
    return `postgres://${username}:${password}@${host}:${port}/${database}`;
  }
  
  /**
   * Get Redis connection options with password resolved
   */
  getRedisOptions() {
    const redisConfig = this.get('redis', {});
    
    return {
      host: redisConfig.host || 'localhost',
      port: redisConfig.port || 6379,
      password: redisConfig.password, // Automatically resolved from secrets
      db: redisConfig.db || 0,
      keyPrefix: redisConfig.keyPrefix || 'otedama:',
      ...redisConfig.options
    };
  }
  
  /**
   * Validate all required secrets are present
   */
  validateSecrets(required = []) {
    const missing = [];
    
    for (const secretName of required) {
      if (!secretManager.getSecret(secretName)) {
        missing.push(secretName);
      }
    }
    
    if (missing.length > 0) {
      throw new Error(`Missing required secrets: ${missing.join(', ')}`);
    }
    
    return true;
  }
  
  /**
   * Export configuration (with secrets masked)
   */
  exportConfig(options = {}) {
    const { maskSecrets = true } = options;
    const config = configManager.getAll();
    
    if (maskSecrets) {
      return this.maskSecrets(config);
    }
    
    return config;
  }
  
  /**
   * Mask secret values in configuration
   */
  maskSecrets(config) {
    const masked = {};
    
    for (const [key, value] of Object.entries(config)) {
      if (value === null || value === undefined) {
        masked[key] = value;
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        masked[key] = this.maskSecrets(value);
      } else if (typeof value === 'string' && value.startsWith('SECRET:')) {
        masked[key] = '***REDACTED***';
      } else {
        masked[key] = value;
      }
    }
    
    return masked;
  }
  
  /**
   * Shutdown and cleanup
   */
  async shutdown() {
    await secretManager.shutdown();
    this.initialized = false;
  }
}

// Singleton instance
export const secureConfig = new SecureConfigManager();

export default SecureConfigManager;