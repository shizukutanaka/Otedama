/**
 * Configuration Manager - Otedama
 * Flexible configuration with validation and hot reload
 * 
 * Design: Convention over configuration (Pike)
 */

import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import { ConfigurationError, ValidationError } from './errors.js';
import { validator, Schema, Rules, Sanitizers } from './validator.js';
import { createLogger } from './logger.js';

const logger = createLogger('ConfigManager');

/**
 * Configuration schema definitions
 */
const ConfigSchemas = {
  // Pool configuration
  pool: new Schema({
    name: {
      type: 'string',
      required: false,
      default: 'Otedama Pool',
      sanitize: Sanitizers.trim
    },
    fee: {
      type: 'number',
      required: false,
      default: 0.01,
      validate: [
        (v) => v >= 0 && v <= 0.1 || 'Pool fee must be between 0 and 10%'
      ]
    },
    minPayment: {
      type: 'number',
      required: false,
      default: 0.001,
      validate: [
        (v) => v > 0 || 'Minimum payment must be positive'
      ]
    },
    paymentInterval: {
      type: 'number',
      required: false,
      default: 3600000, // 1 hour
      validate: [
        (v) => v >= 60000 || 'Payment interval must be at least 1 minute'
      ],
      sanitize: Sanitizers.toInt
    }
  }),
  
  // Network configuration
  network: new Schema({
    stratumPort: {
      type: 'number',
      required: false,
      default: 3333,
      validate: [Rules.isPort],
      sanitize: Sanitizers.toInt
    },
    stratumV2Port: {
      type: 'number',
      required: false,
      default: 3336,
      validate: [Rules.isPort],
      sanitize: Sanitizers.toInt
    },
    apiPort: {
      type: 'number',
      required: false,
      default: 8080,
      validate: [Rules.isPort],
      sanitize: Sanitizers.toInt
    },
    p2pPort: {
      type: 'number',
      required: false,
      default: 8333,
      validate: [Rules.isPort],
      sanitize: Sanitizers.toInt
    },
    maxConnections: {
      type: 'number',
      required: false,
      default: 10000,
      validate: [
        (v) => v > 0 && v <= 100000 || 'Max connections must be between 1 and 100000'
      ],
      sanitize: Sanitizers.toInt
    }
  }),
  
  // Storage configuration
  storage: new Schema({
    dataDir: {
      type: 'string',
      required: false,
      default: './data',
      sanitize: [Sanitizers.trim, Sanitizers.sanitizePath]
    },
    dbFile: {
      type: 'string',
      required: false,
      default: 'otedama.db',
      sanitize: Sanitizers.sanitizeFilename
    },
    cacheSize: {
      type: 'number',
      required: false,
      default: 100 * 1024 * 1024, // 100MB
      validate: [
        (v) => v >= 1024 * 1024 || 'Cache size must be at least 1MB'
      ],
      sanitize: Sanitizers.toInt
    }
  }),
  
  // Security configuration
  security: new Schema({
    enableDDoSProtection: {
      type: 'boolean',
      required: false,
      default: true
    },
    enableBanList: {
      type: 'boolean',
      required: false,
      default: true
    },
    banDuration: {
      type: 'number',
      required: false,
      default: 3600000, // 1 hour
      sanitize: Sanitizers.toInt
    },
    maxRequestsPerMinute: {
      type: 'number',
      required: false,
      default: 100,
      validate: [
        (v) => v > 0 || 'Max requests must be positive'
      ],
      sanitize: Sanitizers.toInt
    }
  }),
  
  // Mining configuration
  mining: new Schema({
    algorithm: {
      type: 'string',
      required: false,
      default: 'sha256',
      validate: [
        (v) => ['sha256', 'scrypt', 'ethash', 'randomx'].includes(v) || 'Invalid algorithm'
      ],
      sanitize: Sanitizers.toLowerCase
    },
    difficulty: {
      type: 'number',
      required: false,
      default: 1,
      validate: [Rules.isDifficulty]
    },
    shareTimeout: {
      type: 'number',
      required: false,
      default: 300000, // 5 minutes
      sanitize: Sanitizers.toInt
    }
  })
};

/**
 * Configuration manager
 */
export class ConfigManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      configFile: options.configFile || 'otedama.config.js',
      envPrefix: options.envPrefix || 'OTEDAMA_',
      watchChanges: options.watchChanges !== false,
      validateOnLoad: options.validateOnLoad !== false
    };
    
    this.config = {};
    this.defaults = this.buildDefaults();
    this.watchers = new Map();
    this.overrides = {};
  }
  
  /**
   * Load configuration from all sources
   */
  async load() {
    logger.info('Loading configuration...');
    
    try {
      // 1. Start with defaults
      this.config = JSON.parse(JSON.stringify(this.defaults));
      
      // 2. Load from config file
      await this.loadFromFile();
      
      // 3. Load from environment variables
      this.loadFromEnv();
      
      // 4. Apply overrides
      this.applyOverrides();
      
      // 5. Validate if enabled
      if (this.options.validateOnLoad) {
        this.validate();
      }
      
      // 6. Start watching if enabled
      if (this.options.watchChanges) {
        await this.startWatching();
      }
      
      logger.info('Configuration loaded successfully');
      this.emit('loaded', this.config);
      
    } catch (error) {
      logger.error('Failed to load configuration:', error);
      throw new ConfigurationError(`Configuration loading failed: ${error.message}`);
    }
  }
  
  /**
   * Build default configuration
   */
  buildDefaults() {
    const defaults = {};
    
    for (const [section, schema] of Object.entries(ConfigSchemas)) {
      defaults[section] = {};
      
      for (const [key, rules] of Object.entries(schema.definition)) {
        if (rules.default !== undefined) {
          defaults[section][key] = rules.default;
        }
      }
    }
    
    return defaults;
  }
  
  /**
   * Load from configuration file
   */
  async loadFromFile() {
    try {
      const configPath = path.resolve(this.options.configFile);
      const stat = await fs.stat(configPath);
      
      if (stat.isFile()) {
        logger.info(`Loading config from ${configPath}`);
        
        // Clear module cache for hot reload
        delete require.cache[configPath];
        
        // Import config file
        const { default: fileConfig } = await import(configPath);
        
        // Merge with existing config
        this.deepMerge(this.config, fileConfig);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn(`Failed to load config file: ${error.message}`);
      }
    }
  }
  
  /**
   * Load from environment variables
   */
  loadFromEnv() {
    const prefix = this.options.envPrefix;
    
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith(prefix)) continue;
      
      // Convert OTEDAMA_POOL_NAME to pool.name
      const configPath = key
        .substring(prefix.length)
        .toLowerCase()
        .split('_');
      
      if (configPath.length < 2) continue;
      
      const section = configPath[0];
      const property = configPath.slice(1).join('_');
      
      // Ensure section exists
      if (!this.config[section]) {
        this.config[section] = {};
      }
      
      // Parse value
      let parsedValue = value;
      
      // Try to parse as JSON
      try {
        parsedValue = JSON.parse(value);
      } catch {
        // Not JSON, keep as string
        
        // Convert string booleans
        if (value === 'true') parsedValue = true;
        else if (value === 'false') parsedValue = false;
        
        // Convert string numbers
        else if (/^\d+$/.test(value)) parsedValue = parseInt(value, 10);
        else if (/^\d+\.\d+$/.test(value)) parsedValue = parseFloat(value);
      }
      
      this.config[section][property] = parsedValue;
    }
  }
  
  /**
   * Apply manual overrides
   */
  applyOverrides() {
    this.deepMerge(this.config, this.overrides);
  }
  
  /**
   * Validate configuration
   */
  validate() {
    const errors = [];
    
    for (const [section, schema] of Object.entries(ConfigSchemas)) {
      if (!this.config[section]) continue;
      
      try {
        const validated = schema.validate(this.config[section]);
        this.config[section] = validated;
      } catch (error) {
        if (error instanceof ValidationError) {
          errors.push({
            section,
            errors: error.field || error.message
          });
        } else {
          throw error;
        }
      }
    }
    
    if (errors.length > 0) {
      throw new ConfigurationError('Configuration validation failed', errors);
    }
  }
  
  /**
   * Start watching configuration file
   */
  async startWatching() {
    if (!this.options.watchChanges) return;
    
    try {
      const configPath = path.resolve(this.options.configFile);
      
      // Use fs.watch for file changes
      const watcher = fs.watch(configPath, async (eventType) => {
        if (eventType === 'change') {
          logger.info('Configuration file changed, reloading...');
          
          try {
            await this.reload();
          } catch (error) {
            logger.error('Failed to reload configuration:', error);
            this.emit('reload:error', error);
          }
        }
      });
      
      this.watchers.set(configPath, watcher);
      logger.info('Watching configuration file for changes');
      
    } catch (error) {
      logger.warn('Failed to watch configuration file:', error.message);
    }
  }
  
  /**
   * Stop watching
   */
  stopWatching() {
    for (const [path, watcher] of this.watchers) {
      watcher.close();
      logger.info(`Stopped watching ${path}`);
    }
    
    this.watchers.clear();
  }
  
  /**
   * Reload configuration
   */
  async reload() {
    const oldConfig = JSON.parse(JSON.stringify(this.config));
    
    try {
      await this.load();
      
      // Check what changed
      const changes = this.findChanges(oldConfig, this.config);
      
      if (changes.length > 0) {
        logger.info(`Configuration reloaded with ${changes.length} changes`);
        this.emit('changed', { changes, oldConfig, newConfig: this.config });
      }
      
    } catch (error) {
      // Restore old config on error
      this.config = oldConfig;
      throw error;
    }
  }
  
  /**
   * Get configuration value
   */
  get(path, defaultValue) {
    const parts = path.split('.');
    let value = this.config;
    
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        return defaultValue;
      }
    }
    
    return value;
  }
  
  /**
   * Set configuration value
   */
  set(path, value) {
    const parts = path.split('.');
    const property = parts.pop();
    
    let target = this.overrides;
    
    for (const part of parts) {
      if (!target[part] || typeof target[part] !== 'object') {
        target[part] = {};
      }
      target = target[part];
    }
    
    target[property] = value;
    
    // Re-apply overrides
    this.applyOverrides();
    
    this.emit('set', { path, value });
  }
  
  /**
   * Get all configuration
   */
  getAll() {
    return JSON.parse(JSON.stringify(this.config));
  }
  
  /**
   * Deep merge objects
   */
  deepMerge(target, source) {
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key]) target[key] = {};
        this.deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
    
    return target;
  }
  
  /**
   * Find changes between configurations
   */
  findChanges(oldConfig, newConfig, path = '') {
    const changes = [];
    
    // Check all keys in new config
    for (const key in newConfig) {
      const currentPath = path ? `${path}.${key}` : key;
      
      if (!(key in oldConfig)) {
        changes.push({
          type: 'added',
          path: currentPath,
          value: newConfig[key]
        });
      } else if (typeof newConfig[key] === 'object' && !Array.isArray(newConfig[key])) {
        changes.push(...this.findChanges(oldConfig[key], newConfig[key], currentPath));
      } else if (oldConfig[key] !== newConfig[key]) {
        changes.push({
          type: 'modified',
          path: currentPath,
          oldValue: oldConfig[key],
          newValue: newConfig[key]
        });
      }
    }
    
    // Check for removed keys
    for (const key in oldConfig) {
      if (!(key in newConfig)) {
        const currentPath = path ? `${path}.${key}` : key;
        changes.push({
          type: 'removed',
          path: currentPath,
          value: oldConfig[key]
        });
      }
    }
    
    return changes;
  }
  
  /**
   * Export configuration
   */
  async export(filePath) {
    const config = this.getAll();
    const content = `/**
 * Otedama Configuration
 * Generated: ${new Date().toISOString()}
 */

export default ${JSON.stringify(config, null, 2)};
`;
    
    await fs.writeFile(filePath, content, 'utf8');
    logger.info(`Configuration exported to ${filePath}`);
  }
}

// Singleton instance
export const configManager = new ConfigManager();

export default {
  ConfigManager,
  configManager,
  ConfigSchemas
};
