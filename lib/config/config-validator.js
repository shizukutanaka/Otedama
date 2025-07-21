/**
 * Configuration Validator for Otedama
 * Validates environment variables and configuration settings
 * Following Rob Pike's simplicity principle
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Configuration schema definition
const configSchema = {
  // Network Ports
  API_PORT: { type: 'number', required: true, min: 1, max: 65535 },
  WS_PORT: { type: 'number', required: true, min: 1, max: 65535 },
  DEX_WS_PORT: { type: 'number', required: true, min: 1, max: 65535 },
  P2P_PORT: { type: 'number', required: true, min: 1, max: 65535 },
  P2P_DISCOVERY_PORT: { type: 'number', required: true, min: 1, max: 65535 },
  
  // Database
  DB_PATH: { type: 'string', required: true },
  DB_READ_POOL_SIZE: { type: 'number', required: true, min: 1, max: 100 },
  DB_WRITE_POOL_SIZE: { type: 'number', required: true, min: 1, max: 50 },
  DB_MAX_CONNECTIONS: { type: 'number', default: 50, min: 10, max: 1000 },
  DB_CONNECTION_TIMEOUT: { type: 'number', default: 30000, min: 5000 },
  DB_ENABLE_WAL: { type: 'boolean', default: true },
  
  // System
  NODE_ENV: { type: 'string', required: true, values: ['development', 'production', 'test'] },
  LOG_LEVEL: { type: 'string', default: 'info', values: ['debug', 'info', 'warn', 'error'] },
  LOG_FILE_PATH: { type: 'string', default: './logs/otedama.log' },
  MAX_WORKERS: { type: 'number', default: 0, min: 0 },
  
  // Security
  CORS_ORIGIN: { type: 'string', default: '*' },
  RATE_LIMIT_WINDOW: { type: 'number', default: 60000, min: 1000 },
  RATE_LIMIT_MAX: { type: 'number', default: 100, min: 1 },
  SESSION_SECRET: { type: 'string', required: true, minLength: 32 },
  JWT_SECRET: { type: 'string', required: true, minLength: 32 },
  JWT_EXPIRY: { type: 'number', default: 86400000, min: 60000 },
  ENABLE_2FA: { type: 'boolean', default: false },
  
  // Performance
  CACHE_MAX_SIZE: { type: 'number', default: 104857600, min: 1048576 },
  CACHE_TTL: { type: 'number', default: 3600000, min: 60000 },
  GC_INTERVAL: { type: 'number', default: 1800000, min: 60000 },
  HTTP_TIMEOUT: { type: 'number', default: 30000, min: 5000 },
  
  // Mining Pool
  POOL_FEE: { type: 'number', required: true, min: 0, max: 0.1 },
  MIN_PAYOUT_BTC: { type: 'number', required: true, min: 0.0001 },
  SHARE_DIFFICULTY: { type: 'number', default: 65536, min: 1 },
  
  // DEX
  DEX_FEE_RATE: { type: 'number', required: true, min: 0, max: 0.01 },
  DEX_MIN_ORDER_BTC: { type: 'number', required: true, min: 0.00001 },
  
  // DeFi
  LIQUIDITY_FEE_RATE: { type: 'number', default: 0.003, min: 0, max: 0.01 },
  FLASH_LOAN_FEE: { type: 'number', default: 0.0009, min: 0, max: 0.01 },
  
  // Backup
  BACKUP_ENABLED: { type: 'boolean', default: true },
  BACKUP_RETENTION_DAYS: { type: 'number', default: 30, min: 1 },
  BACKUP_PATH: { type: 'string', default: './backups' },
  
  // Monitoring
  METRICS_ENABLED: { type: 'boolean', default: true },
  HEALTH_CHECK_INTERVAL: { type: 'number', default: 30000, min: 5000 },
  
  // Feature Flags
  FEATURE_MINING_ENABLED: { type: 'boolean', default: true },
  FEATURE_DEX_ENABLED: { type: 'boolean', default: true },
  FEATURE_DEFI_ENABLED: { type: 'boolean', default: true },
  FEATURE_API_V2_ENABLED: { type: 'boolean', default: true },
  FEATURE_WEBSOCKET_ENABLED: { type: 'boolean', default: true },
  FEATURE_P2P_ENABLED: { type: 'boolean', default: true },
  
  // Maintenance
  MAINTENANCE_MODE: { type: 'boolean', default: false },
  MAINTENANCE_MESSAGE: { type: 'string', default: 'System maintenance in progress' }
};

export class ConfigValidator {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.config = {};
  }

  /**
   * Validate configuration
   */
  validate(env = process.env) {
    this.errors = [];
    this.warnings = [];
    this.config = {};
    
    // Validate each configuration item
    for (const [key, schema] of Object.entries(configSchema)) {
      const value = env[key];
      const validated = this.validateValue(key, value, schema);
      
      if (validated !== undefined) {
        this.config[key] = validated;
      }
    }
    
    // Additional cross-field validations
    this.validateCrossFields();
    
    // Check for unknown environment variables
    this.checkUnknownVariables(env);
    
    return {
      valid: this.errors.length === 0,
      errors: this.errors,
      warnings: this.warnings,
      config: this.config
    };
  }

  /**
   * Validate individual value
   */
  validateValue(key, value, schema) {
    // Check required fields
    if (schema.required && (value === undefined || value === '')) {
      this.errors.push(`${key} is required but not set`);
      return undefined;
    }
    
    // Use default if not set
    if (value === undefined || value === '') {
      return schema.default;
    }
    
    // Type conversion and validation
    let converted;
    switch (schema.type) {
      case 'number':
        converted = Number(value);
        if (isNaN(converted)) {
          this.errors.push(`${key} must be a number, got: ${value}`);
          return undefined;
        }
        if (schema.min !== undefined && converted < schema.min) {
          this.errors.push(`${key} must be >= ${schema.min}, got: ${converted}`);
          return undefined;
        }
        if (schema.max !== undefined && converted > schema.max) {
          this.errors.push(`${key} must be <= ${schema.max}, got: ${converted}`);
          return undefined;
        }
        break;
        
      case 'boolean':
        converted = value === 'true' || value === '1' || value === true;
        break;
        
      case 'string':
        converted = String(value);
        if (schema.minLength && converted.length < schema.minLength) {
          this.errors.push(`${key} must be at least ${schema.minLength} characters long`);
          return undefined;
        }
        if (schema.values && !schema.values.includes(converted)) {
          this.errors.push(`${key} must be one of: ${schema.values.join(', ')}, got: ${converted}`);
          return undefined;
        }
        break;
        
      default:
        converted = value;
    }
    
    return converted;
  }

  /**
   * Validate cross-field dependencies
   */
  validateCrossFields() {
    // Port conflicts
    const ports = [
      this.config.API_PORT,
      this.config.WS_PORT,
      this.config.DEX_WS_PORT,
      this.config.P2P_PORT,
      this.config.P2P_DISCOVERY_PORT
    ].filter(p => p !== undefined);
    
    const uniquePorts = new Set(ports);
    if (uniquePorts.size !== ports.length) {
      this.errors.push('Port conflict detected: All ports must be unique');
    }
    
    // Production-specific checks
    if (this.config.NODE_ENV === 'production') {
      if (this.config.LOG_LEVEL === 'debug') {
        this.warnings.push('Debug logging is enabled in production');
      }
      
      if (this.config.CORS_ORIGIN === '*') {
        this.warnings.push('CORS is set to allow all origins in production');
      }
      
      if (this.config.SESSION_SECRET === 'CHANGE_THIS_TO_RANDOM_STRING_IN_PRODUCTION') {
        this.errors.push('SESSION_SECRET must be changed from default value in production');
      }
      
      if (this.config.JWT_SECRET === 'CHANGE_THIS_TO_RANDOM_STRING_IN_PRODUCTION') {
        this.errors.push('JWT_SECRET must be changed from default value in production');
      }
    }
    
    // Feature dependencies
    if (this.config.FEATURE_DEX_ENABLED && !this.config.FEATURE_WEBSOCKET_ENABLED) {
      this.warnings.push('DEX is enabled but WebSocket is disabled - real-time updates will not work');
    }
    
    if (this.config.FEATURE_DEFI_ENABLED && !this.config.FEATURE_DEX_ENABLED) {
      this.errors.push('DeFi requires DEX to be enabled');
    }
    
    // Resource warnings
    if (this.config.DB_MAX_CONNECTIONS > 100) {
      this.warnings.push('DB_MAX_CONNECTIONS is set very high - ensure your database can handle this');
    }
    
    if (this.config.CACHE_MAX_SIZE > 1073741824) { // 1GB
      this.warnings.push('Cache size is set to use more than 1GB of memory');
    }
  }

  /**
   * Validate security configuration
   */
  validateSecurityConfig() {
    // Check for weak secrets
    const secretKeys = ['JWT_SECRET', 'SESSION_SECRET', 'CSRF_SECRET', 'COOKIE_SECRET', 'PERSISTENCE_KEY'];
    
    for (const key of secretKeys) {
      const value = this.config[key];
      if (!value && configSchema[key]?.required) continue; // Will be caught by required validation
      
      if (value && (value.includes('CHANGE_THIS') || value.includes('your-secret-key-here'))) {
        this.errors.push(`${key} contains default/placeholder value. Generate a secure secret!`);
      }
      
      if (value && value.length < 32) {
        this.warnings.push(`${key} should be at least 32 characters for better security`);
      }
    }
  }
  
  /**
   * Check for unknown environment variables
   */
  checkUnknownVariables(env) {
    const knownPrefix = 'OTEDAMA_';
    const knownKeys = new Set(Object.keys(configSchema));
    
    for (const key of Object.keys(env)) {
      if (key.startsWith(knownPrefix) && !knownKeys.has(key)) {
        this.warnings.push(`Unknown configuration variable: ${key}`);
      }
    }
  }

  /**
   * Load configuration from file
   */
  static loadFromFile(filePath) {
    try {
      const content = readFileSync(resolve(filePath), 'utf8');
      const env = {};
      
      // Parse .env file format
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const [key, ...valueParts] = trimmed.split('=');
          if (key) {
            env[key.trim()] = valueParts.join('=').trim();
          }
        }
      }
      
      return env;
    } catch (error) {
      throw new Error(`Failed to load configuration from ${filePath}: ${error.message}`);
    }
  }

  /**
   * Get validated configuration with defaults
   */
  getConfig() {
    return this.config;
  }

  /**
   * Print validation report
   */
  printReport() {
    if (this.errors.length > 0) {
      console.error('\n❌ Configuration Errors:');
      this.errors.forEach(error => console.error(`  - ${error}`));
    }
    
    if (this.warnings.length > 0) {
      console.warn('\n⚠️  Configuration Warnings:');
      this.warnings.forEach(warning => console.warn(`  - ${warning}`));
    }
    
    if (this.errors.length === 0) {
      console.log('\n✅ Configuration is valid');
    }
    
    return this.errors.length === 0;
  }
  
  /**
   * Generate secure secrets
   */
  static generateSecrets() {
    return {
      JWT_SECRET: randomBytes(32).toString('hex'),
      SESSION_SECRET: randomBytes(32).toString('hex'),
      CSRF_SECRET: randomBytes(32).toString('hex'),
      COOKIE_SECRET: randomBytes(32).toString('hex'),
      PERSISTENCE_KEY: randomBytes(32).toString('hex')
    };
  }
  
  /**
   * Create .env file from .env.example with generated secrets
   */
  static async createEnvFile() {
    try {
      // Check if .env already exists
      try {
        await fs.access('.env');
        console.log('.env file already exists');
        return false;
      } catch {
        // File doesn't exist, continue
      }
      
      // Read .env.example
      const examplePath = resolve('.env.example');
      let content = await fs.readFile(examplePath, 'utf8');
      
      // Generate secrets
      const secrets = ConfigValidator.generateSecrets();
      
      // Replace placeholders
      for (const [key, value] of Object.entries(secrets)) {
        const regex = new RegExp(`${key}=.*`, 'g');
        content = content.replace(regex, `${key}=${value}`);
      }
      
      // Write .env file
      await fs.writeFile('.env', content);
      
      console.log('.env file created with secure secrets');
      console.log('IMPORTANT: Keep these secrets safe and never commit them to version control!');
      
      return true;
      
    } catch (error) {
      console.error('Failed to create .env file:', error);
      return false;
    }
  }
  
  /**
   * Get configuration summary
   */
  getSummary() {
    return {
      environment: this.config.NODE_ENV,
      security: {
        jwtEnabled: !!this.config.JWT_SECRET,
        csrfEnabled: !!this.config.CSRF_SECRET,
        twoFactorEnabled: this.config.ENABLE_2FA,
        wsAuthEnabled: this.config.WS_AUTH_ENABLED
      },
      network: {
        apiPort: this.config.API_PORT,
        wsPort: this.config.WS_PORT,
        dexWsPort: this.config.DEX_WS_PORT,
        dataSyncWsPort: this.config.DATA_SYNC_WS_PORT,
        p2pPort: this.config.P2P_PORT
      },
      features: {
        mining: this.config.FEATURE_MINING_ENABLED,
        dex: this.config.FEATURE_DEX_ENABLED,
        defi: this.config.FEATURE_DEFI_ENABLED,
        p2p: this.config.FEATURE_P2P_ENABLED,
        persistence: this.config.PERSISTENCE_ENABLED
      },
      database: {
        path: this.config.DB_PATH,
        readPool: this.config.DB_READ_POOL_SIZE,
        writePool: this.config.DB_WRITE_POOL_SIZE
      }
    };
  }
}

// Export singleton instance
export const configValidator = new ConfigValidator();

// Export validation function
export function validateConfig(env = process.env) {
  return configValidator.validate(env);
}

// Export async validation with error handling
export async function validateConfigAsync() {
  const validator = new ConfigValidator();
  const result = validator.validate();
  
  if (!result.valid) {
    console.error('Configuration validation failed:');
    result.errors.forEach(error => console.error(`  ✗ ${error}`));
    
    if (result.errors.some(e => e.includes('required but not set'))) {
      console.log('\nRun the following command to create a .env file with secure defaults:');
      console.log('  node -e "import(\'./lib/config/config-validator.js\').then(m => m.ConfigValidator.createEnvFile())"');
    }
    
    process.exit(1);
  }
  
  if (result.warnings.length > 0) {
    console.warn('Configuration warnings:');
    result.warnings.forEach(warning => console.warn(`  ⚠ ${warning}`));
  }
  
  return result.config;
}

// Export schema for documentation
export { configSchema };

export default ConfigValidator;