/**
 * Simple Configuration Manager
 * Design: Rob Pike (Simple) + Robert C. Martin (Clean)
 */

import * as fs from 'fs';
import * as path from 'path';
import { createComponentLogger } from '../logging/simple-logger';

interface PoolConfig {
  // Core settings
  port: number;
  difficulty: number;
  poolAddress: string;
  fee: number;
  
  // Database
  dataDir: string;
  
  // Bitcoin RPC
  rpcUrl: string;
  rpcUser: string;
  rpcPassword: string;
  
  // Logging
  logDir: string;
  logLevel: string;
  
  // Performance
  maxConnections: number;
  shareTimeout: number;
  cleanupInterval: number;
  
  // Metrics
  metricsEnabled: boolean;
  metricsPort: number;
  
  // Security
  enableTLS: boolean;
  tlsCert?: string;
  tlsKey?: string;
  rateLimitEnabled: boolean;
  rateLimitRequests: number;
  rateLimitWindow: number;
}

interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

class SimpleConfig {
  private config: PoolConfig;
  private configFile: string;
  private logger = createComponentLogger('Config');
  
  constructor(configFile: string = './config/pool.json') {
    this.configFile = configFile;
    this.config = this.loadConfig();
    this.validateConfig();
  }
  
  private loadConfig(): PoolConfig {
    // Default configuration
    const defaults: PoolConfig = {
      // Core
      port: 3333,
      difficulty: 1,
      poolAddress: '',
      fee: 1.0,
      
      // Database
      dataDir: './data',
      
      // Bitcoin RPC
      rpcUrl: 'http://localhost:8332',
      rpcUser: '',
      rpcPassword: '',
      
      // Logging
      logDir: './logs',
      logLevel: 'INFO',
      
      // Performance
      maxConnections: 500,
      shareTimeout: 30000,
      cleanupInterval: 300000,
      
      // Metrics
      metricsEnabled: true,
      metricsPort: 9090,
      
      // Security
      enableTLS: false,
      rateLimitEnabled: true,
      rateLimitRequests: 100,
      rateLimitWindow: 60000
    };
    
    try {
      // Try to load from file first
      let fileConfig: Partial<PoolConfig> = {};
      
      if (fs.existsSync(this.configFile)) {
        const configData = fs.readFileSync(this.configFile, 'utf8');
        fileConfig = JSON.parse(configData);
        this.logger.info('Loaded config from file', { file: this.configFile });
      } else {
        this.logger.warn('Config file not found, using defaults', { file: this.configFile });
      }
      
      // Override with environment variables
      const envConfig = this.loadFromEnv();
      
      // Merge: defaults < file < environment
      const config = {
        ...defaults,
        ...fileConfig,
        ...envConfig
      };
      
      return config;
      
    } catch (error) {
      this.logger.error('Failed to load config, using defaults', error as Error);
      return defaults;
    }
  }
  
  private loadFromEnv(): Partial<PoolConfig> {
    const config: Partial<PoolConfig> = {};
    
    // Core settings
    if (process.env.POOL_PORT) config.port = parseInt(process.env.POOL_PORT);
    if (process.env.POOL_DIFFICULTY) config.difficulty = parseInt(process.env.POOL_DIFFICULTY);
    if (process.env.POOL_ADDRESS) config.poolAddress = process.env.POOL_ADDRESS;
    if (process.env.POOL_FEE) config.fee = parseFloat(process.env.POOL_FEE);
    
    // Database
    if (process.env.DATA_DIR) config.dataDir = process.env.DATA_DIR;
    
    // Bitcoin RPC
    if (process.env.RPC_URL) config.rpcUrl = process.env.RPC_URL;
    if (process.env.RPC_USER) config.rpcUser = process.env.RPC_USER;
    if (process.env.RPC_PASSWORD) config.rpcPassword = process.env.RPC_PASSWORD;
    
    // Logging
    if (process.env.LOG_DIR) config.logDir = process.env.LOG_DIR;
    if (process.env.LOG_LEVEL) config.logLevel = process.env.LOG_LEVEL;
    
    // Performance
    if (process.env.MAX_CONNECTIONS) config.maxConnections = parseInt(process.env.MAX_CONNECTIONS);
    if (process.env.SHARE_TIMEOUT) config.shareTimeout = parseInt(process.env.SHARE_TIMEOUT);
    if (process.env.CLEANUP_INTERVAL) config.cleanupInterval = parseInt(process.env.CLEANUP_INTERVAL);
    
    // Metrics
    if (process.env.METRICS_ENABLED) config.metricsEnabled = process.env.METRICS_ENABLED === 'true';
    if (process.env.METRICS_PORT) config.metricsPort = parseInt(process.env.METRICS_PORT);
    
    // Security
    if (process.env.ENABLE_TLS) config.enableTLS = process.env.ENABLE_TLS === 'true';
    if (process.env.TLS_CERT) config.tlsCert = process.env.TLS_CERT;
    if (process.env.TLS_KEY) config.tlsKey = process.env.TLS_KEY;
    if (process.env.RATE_LIMIT_ENABLED) config.rateLimitEnabled = process.env.RATE_LIMIT_ENABLED === 'true';
    if (process.env.RATE_LIMIT_REQUESTS) config.rateLimitRequests = parseInt(process.env.RATE_LIMIT_REQUESTS);
    if (process.env.RATE_LIMIT_WINDOW) config.rateLimitWindow = parseInt(process.env.RATE_LIMIT_WINDOW);
    
    return config;
  }
  
  private validateConfig(): ConfigValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Required fields
    if (!this.config.poolAddress) {
      errors.push('Pool address is required');
    }
    
    if (!this.config.rpcUser || !this.config.rpcPassword) {
      errors.push('Bitcoin RPC credentials are required');
    }
    
    // Range validations
    if (this.config.port < 1 || this.config.port > 65535) {
      errors.push('Port must be between 1 and 65535');
    }
    
    if (this.config.difficulty < 1) {
      errors.push('Difficulty must be at least 1');
    }
    
    if (this.config.fee < 0 || this.config.fee > 100) {
      errors.push('Fee must be between 0 and 100 percent');
    }
    
    if (this.config.maxConnections < 1) {
      errors.push('Max connections must be at least 1');
    }
    
    // Warnings
    if (this.config.fee > 5) {
      warnings.push('Pool fee is unusually high (>5%)');
    }
    
    if (!this.config.enableTLS) {
      warnings.push('TLS is disabled - consider enabling for production');
    }
    
    if (this.config.maxConnections > 1000) {
      warnings.push('Max connections is very high - ensure system can handle the load');
    }
    
    // File/directory validations
    try {
      if (!fs.existsSync(this.config.dataDir)) {
        fs.mkdirSync(this.config.dataDir, { recursive: true });
        this.logger.info('Created data directory', { dir: this.config.dataDir });
      }
    } catch (error) {
      errors.push(`Cannot create data directory: ${this.config.dataDir}`);
    }
    
    try {
      if (!fs.existsSync(this.config.logDir)) {
        fs.mkdirSync(this.config.logDir, { recursive: true });
        this.logger.info('Created log directory', { dir: this.config.logDir });
      }
    } catch (error) {
      errors.push(`Cannot create log directory: ${this.config.logDir}`);
    }
    
    // TLS certificate validation
    if (this.config.enableTLS) {
      if (!this.config.tlsCert || !this.config.tlsKey) {
        errors.push('TLS enabled but certificate or key file not specified');
      } else {
        if (!fs.existsSync(this.config.tlsCert)) {
          errors.push(`TLS certificate file not found: ${this.config.tlsCert}`);
        }
        if (!fs.existsSync(this.config.tlsKey)) {
          errors.push(`TLS key file not found: ${this.config.tlsKey}`);
        }
      }
    }
    
    const result: ConfigValidationResult = {
      valid: errors.length === 0,
      errors,
      warnings
    };
    
    // Log validation results
    if (errors.length > 0) {
      this.logger.error('Configuration validation failed', undefined, { errors });
    }
    
    if (warnings.length > 0) {
      this.logger.warn('Configuration warnings', { warnings });
    }
    
    if (result.valid) {
      this.logger.info('Configuration validation passed');
    }
    
    return result;
  }
  
  // Get configuration values
  get(): PoolConfig {
    return { ...this.config };
  }
  
  // Get specific config value
  getValue<K extends keyof PoolConfig>(key: K): PoolConfig[K] {
    return this.config[key];
  }
  
  // Update configuration (runtime)
  update(updates: Partial<PoolConfig>): void {
    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...updates };
    
    const validation = this.validateConfig();
    if (!validation.valid) {
      // Rollback if validation fails
      this.config = oldConfig;
      throw new Error(`Configuration update failed: ${validation.errors.join(', ')}`);
    }
    
    this.logger.info('Configuration updated', { updates });
  }
  
  // Save current configuration to file
  save(): void {
    try {
      const configDir = path.dirname(this.configFile);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      
      const configData = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(this.configFile, configData, 'utf8');
      
      this.logger.info('Configuration saved', { file: this.configFile });
    } catch (error) {
      this.logger.error('Failed to save configuration', error as Error);
      throw error;
    }
  }
  
  // Reload configuration from file and environment
  reload(): void {
    this.logger.info('Reloading configuration...');
    const oldConfig = { ...this.config };
    
    try {
      this.config = this.loadConfig();
      const validation = this.validateConfig();
      
      if (!validation.valid) {
        this.config = oldConfig;
        throw new Error(`Configuration reload failed: ${validation.errors.join(', ')}`);
      }
      
      this.logger.info('Configuration reloaded successfully');
    } catch (error) {
      this.config = oldConfig;
      this.logger.error('Failed to reload configuration', error as Error);
      throw error;
    }
  }
  
  // Generate example configuration file
  static generateExample(outputPath: string): void {
    const exampleConfig: PoolConfig = {
      port: 3333,
      difficulty: 1,
      poolAddress: 'bc1qexampleaddress',
      fee: 1.0,
      dataDir: './data',
      rpcUrl: 'http://localhost:8332',
      rpcUser: 'bitcoinrpc',
      rpcPassword: 'changeme',
      logDir: './logs',
      logLevel: 'INFO',
      maxConnections: 500,
      shareTimeout: 30000,
      cleanupInterval: 300000,
      metricsEnabled: true,
      metricsPort: 9090,
      enableTLS: false,
      rateLimitEnabled: true,
      rateLimitRequests: 100,
      rateLimitWindow: 60000
    };
    
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const configData = JSON.stringify(exampleConfig, null, 2);
    fs.writeFileSync(outputPath, configData, 'utf8');
    
    console.log(`Example configuration generated: ${outputPath}`);
  }
}

// Singleton instance
let instance: SimpleConfig | null = null;

export function getConfig(configFile?: string): SimpleConfig {
  if (!instance) {
    instance = new SimpleConfig(configFile);
  }
  return instance;
}

export { SimpleConfig, PoolConfig, ConfigValidationResult };
