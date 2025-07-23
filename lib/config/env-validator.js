const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/logger');

/**
 * Environment Variable Validator
 * Ensures all required environment variables are present and valid
 */
class EnvValidator {
  constructor(config = {}) {
    this.logger = createLogger('env-validator');
    this.errors = [];
    this.warnings = [];
    
    // Define environment variable schema
    this.schema = {
      // Node environment
      NODE_ENV: {
        type: 'enum',
        values: ['development', 'test', 'staging', 'production'],
        default: 'development',
        description: 'Node environment'
      },
      
      // Server configuration
      PORT: {
        type: 'number',
        min: 1,
        max: 65535,
        default: 3333,
        description: 'Stratum server port'
      },
      
      API_PORT: {
        type: 'number',
        min: 1,
        max: 65535,
        default: 8080,
        description: 'API server port'
      },
      
      P2P_PORT: {
        type: 'number',
        min: 1,
        max: 65535,
        default: 6633,
        description: 'P2P network port'
      },
      
      // Security
      JWT_SECRET: {
        type: 'string',
        required: true,
        minLength: 32,
        sensitive: true,
        description: 'JWT signing secret'
      },
      
      SESSION_SECRET: {
        type: 'string',
        required: true,
        minLength: 32,
        sensitive: true,
        description: 'Session secret'
      },
      
      ENCRYPTION_KEY: {
        type: 'string',
        required: false,
        minLength: 32,
        sensitive: true,
        description: 'Data encryption key'
      },
      
      // Database
      DATABASE_URL: {
        type: 'string',
        required: false,
        default: 'sqlite://./data/otedama.db',
        description: 'Database connection URL'
      },
      
      DATABASE_POOL_MIN: {
        type: 'number',
        min: 1,
        max: 100,
        default: 5,
        description: 'Minimum database pool size'
      },
      
      DATABASE_POOL_MAX: {
        type: 'number',
        min: 1,
        max: 100,
        default: 20,
        description: 'Maximum database pool size'
      },
      
      // Blockchain
      BLOCKCHAIN_URL: {
        type: 'string',
        required: false,
        default: 'http://localhost:8332',
        description: 'Blockchain RPC URL'
      },
      
      BLOCKCHAIN_USER: {
        type: 'string',
        required: false,
        sensitive: true,
        description: 'Blockchain RPC username'
      },
      
      BLOCKCHAIN_PASS: {
        type: 'string',
        required: false,
        sensitive: true,
        description: 'Blockchain RPC password'
      },
      
      // Pool configuration
      POOL_NAME: {
        type: 'string',
        default: 'Otedama Pool',
        maxLength: 100,
        description: 'Pool name'
      },
      
      POOL_FEE: {
        type: 'number',
        min: 0,
        max: 10,
        default: 1,
        description: 'Pool fee percentage'
      },
      
      MIN_PAYOUT: {
        type: 'number',
        min: 0,
        default: 0.001,
        description: 'Minimum payout amount'
      },
      
      PAYOUT_INTERVAL: {
        type: 'number',
        min: 60000,
        default: 3600000,
        description: 'Payout interval in milliseconds'
      },
      
      // Monitoring
      ENABLE_MONITORING: {
        type: 'boolean',
        default: true,
        description: 'Enable monitoring and metrics'
      },
      
      METRICS_PORT: {
        type: 'number',
        min: 1,
        max: 65535,
        default: 9090,
        description: 'Metrics server port'
      },
      
      LOG_LEVEL: {
        type: 'enum',
        values: ['error', 'warn', 'info', 'debug', 'trace'],
        default: 'info',
        description: 'Logging level'
      },
      
      // External services
      REDIS_URL: {
        type: 'string',
        required: false,
        description: 'Redis connection URL'
      },
      
      SMTP_HOST: {
        type: 'string',
        required: false,
        description: 'SMTP server host'
      },
      
      SMTP_PORT: {
        type: 'number',
        min: 1,
        max: 65535,
        default: 587,
        description: 'SMTP server port'
      },
      
      SMTP_USER: {
        type: 'string',
        required: false,
        sensitive: true,
        description: 'SMTP username'
      },
      
      SMTP_PASS: {
        type: 'string',
        required: false,
        sensitive: true,
        description: 'SMTP password'
      },
      
      // Feature flags
      ENABLE_2FA: {
        type: 'boolean',
        default: true,
        description: 'Enable two-factor authentication'
      },
      
      ENABLE_API_KEYS: {
        type: 'boolean',
        default: true,
        description: 'Enable API key authentication'
      },
      
      ENABLE_WEBSOCKET: {
        type: 'boolean',
        default: true,
        description: 'Enable WebSocket support'
      },
      
      ENABLE_COMPRESSION: {
        type: 'boolean',
        default: true,
        description: 'Enable response compression'
      },
      
      // Development
      ENABLE_DEV_TOOLS: {
        type: 'boolean',
        default: false,
        description: 'Enable development tools'
      },
      
      DISABLE_RATE_LIMIT: {
        type: 'boolean',
        default: false,
        description: 'Disable rate limiting (development only)'
      },
      
      // Custom schema extensions
      ...config.customSchema
    };
  }
  
  /**
   * Validate all environment variables
   */
  validate() {
    this.errors = [];
    this.warnings = [];
    
    // Check NODE_ENV first
    if (!process.env.NODE_ENV) {
      process.env.NODE_ENV = 'development';
      this.warnings.push('NODE_ENV not set, defaulting to development');
    }
    
    const isProduction = process.env.NODE_ENV === 'production';
    
    // Validate each variable
    for (const [key, schema] of Object.entries(this.schema)) {
      const value = process.env[key];
      
      // Check required
      if (schema.required && !value) {
        this.errors.push(`Required environment variable ${key} is not set`);
        continue;
      }
      
      // Set default if not provided
      if (!value && schema.default !== undefined) {
        process.env[key] = String(schema.default);
        continue;
      }
      
      // Skip validation if not set and not required
      if (!value) {
        continue;
      }
      
      // Validate based on type
      try {
        this.validateValue(key, value, schema);
      } catch (error) {
        this.errors.push(`${key}: ${error.message}`);
      }
      
      // Production-specific checks
      if (isProduction) {
        this.validateProduction(key, value, schema);
      }
    }
    
    // Additional validation
    this.validateRelationships();
    this.validateSecurity();
    
    // Log results
    this.logResults();
    
    // Return validation result
    return {
      valid: this.errors.length === 0,
      errors: this.errors,
      warnings: this.warnings
    };
  }
  
  /**
   * Validate a single value against schema
   */
  validateValue(key, value, schema) {
    switch (schema.type) {
      case 'string':
        this.validateString(key, value, schema);
        break;
        
      case 'number':
        this.validateNumber(key, value, schema);
        break;
        
      case 'boolean':
        this.validateBoolean(key, value, schema);
        break;
        
      case 'enum':
        this.validateEnum(key, value, schema);
        break;
        
      case 'url':
        this.validateUrl(key, value, schema);
        break;
        
      case 'email':
        this.validateEmail(key, value, schema);
        break;
        
      default:
        throw new Error(`Unknown type: ${schema.type}`);
    }
  }
  
  /**
   * String validation
   */
  validateString(key, value, schema) {
    if (typeof value !== 'string') {
      throw new Error('Must be a string');
    }
    
    if (schema.minLength && value.length < schema.minLength) {
      throw new Error(`Must be at least ${schema.minLength} characters`);
    }
    
    if (schema.maxLength && value.length > schema.maxLength) {
      throw new Error(`Must be at most ${schema.maxLength} characters`);
    }
    
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new Error(`Does not match required pattern`);
    }
  }
  
  /**
   * Number validation
   */
  validateNumber(key, value, schema) {
    const num = Number(value);
    
    if (isNaN(num)) {
      throw new Error('Must be a number');
    }
    
    if (schema.min !== undefined && num < schema.min) {
      throw new Error(`Must be at least ${schema.min}`);
    }
    
    if (schema.max !== undefined && num > schema.max) {
      throw new Error(`Must be at most ${schema.max}`);
    }
    
    // Update environment variable with parsed number
    process.env[key] = String(num);
  }
  
  /**
   * Boolean validation
   */
  validateBoolean(key, value, schema) {
    const validBooleans = ['true', 'false', '1', '0', 'yes', 'no'];
    const lowerValue = value.toLowerCase();
    
    if (!validBooleans.includes(lowerValue)) {
      throw new Error('Must be a boolean (true/false, 1/0, yes/no)');
    }
    
    // Normalize to true/false
    const boolValue = ['true', '1', 'yes'].includes(lowerValue);
    process.env[key] = String(boolValue);
  }
  
  /**
   * Enum validation
   */
  validateEnum(key, value, schema) {
    if (!schema.values.includes(value)) {
      throw new Error(`Must be one of: ${schema.values.join(', ')}`);
    }
  }
  
  /**
   * URL validation
   */
  validateUrl(key, value, schema) {
    try {
      new URL(value);
    } catch (error) {
      throw new Error('Must be a valid URL');
    }
  }
  
  /**
   * Email validation
   */
  validateEmail(key, value, schema) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(value)) {
      throw new Error('Must be a valid email address');
    }
  }
  
  /**
   * Production-specific validation
   */
  validateProduction(key, value, schema) {
    // Ensure sensitive values are strong in production
    if (schema.sensitive && schema.minLength) {
      if (value.length < schema.minLength) {
        this.errors.push(`${key} is too short for production (minimum ${schema.minLength} characters)`);
      }
    }
    
    // Warn about default values in production
    if (schema.sensitive && value === String(schema.default)) {
      this.warnings.push(`${key} is using default value in production`);
    }
    
    // Ensure security features are enabled
    if (key === 'ENABLE_2FA' && value === 'false') {
      this.warnings.push('Two-factor authentication is disabled in production');
    }
    
    if (key === 'DISABLE_RATE_LIMIT' && value === 'true') {
      this.errors.push('Rate limiting cannot be disabled in production');
    }
    
    if (key === 'ENABLE_DEV_TOOLS' && value === 'true') {
      this.errors.push('Development tools cannot be enabled in production');
    }
  }
  
  /**
   * Validate relationships between variables
   */
  validateRelationships() {
    // Database pool size validation
    const poolMin = Number(process.env.DATABASE_POOL_MIN || 5);
    const poolMax = Number(process.env.DATABASE_POOL_MAX || 20);
    
    if (poolMin > poolMax) {
      this.errors.push('DATABASE_POOL_MIN cannot be greater than DATABASE_POOL_MAX');
    }
    
    // SMTP configuration
    if (process.env.SMTP_HOST && (!process.env.SMTP_USER || !process.env.SMTP_PASS)) {
      this.warnings.push('SMTP_HOST is set but SMTP_USER or SMTP_PASS is missing');
    }
    
    // Blockchain configuration
    if (process.env.BLOCKCHAIN_URL && (!process.env.BLOCKCHAIN_USER || !process.env.BLOCKCHAIN_PASS)) {
      this.warnings.push('BLOCKCHAIN_URL is set but credentials are missing');
    }
    
    // Redis configuration
    if (process.env.REDIS_URL) {
      try {
        new URL(process.env.REDIS_URL);
      } catch (error) {
        this.errors.push('REDIS_URL is not a valid URL');
      }
    }
  }
  
  /**
   * Validate security configuration
   */
  validateSecurity() {
    const isProduction = process.env.NODE_ENV === 'production';
    
    // Check for secure secrets
    const secrets = ['JWT_SECRET', 'SESSION_SECRET', 'ENCRYPTION_KEY'];
    
    for (const secret of secrets) {
      const value = process.env[secret];
      if (!value) continue;
      
      // Check for common weak secrets
      const weakSecrets = ['secret', 'password', '123456', 'admin', 'default'];
      if (weakSecrets.some(weak => value.toLowerCase().includes(weak))) {
        this.errors.push(`${secret} contains a weak value`);
      }
      
      // Check entropy (basic check)
      if (value.length < 32) {
        this.warnings.push(`${secret} should be at least 32 characters for better security`);
      }
      
      // Check for repeated characters
      const uniqueChars = new Set(value).size;
      if (uniqueChars < value.length / 2) {
        this.warnings.push(`${secret} has low entropy (too many repeated characters)`);
      }
    }
    
    // Ensure HTTPS in production
    if (isProduction) {
      const urls = ['BLOCKCHAIN_URL', 'REDIS_URL'];
      for (const urlKey of urls) {
        const url = process.env[urlKey];
        if (url && url.startsWith('http://') && !url.includes('localhost')) {
          this.warnings.push(`${urlKey} should use HTTPS in production`);
        }
      }
    }
  }
  
  /**
   * Log validation results
   */
  logResults() {
    if (this.errors.length > 0) {
      this.logger.error('Environment validation failed:');
      this.errors.forEach(error => this.logger.error(`  ❌ ${error}`));
    }
    
    if (this.warnings.length > 0) {
      this.logger.warn('Environment validation warnings:');
      this.warnings.forEach(warning => this.logger.warn(`  ⚠️  ${warning}`));
    }
    
    if (this.errors.length === 0 && this.warnings.length === 0) {
      this.logger.info('✅ Environment validation passed');
    }
  }
  
  /**
   * Generate .env.example file
   */
  generateExample() {
    const lines = ['# Otedama Environment Configuration'];
    lines.push('# Copy this file to .env and update the values\n');
    
    // Group variables by category
    const categories = {
      'Node Environment': ['NODE_ENV'],
      'Server Configuration': ['PORT', 'API_PORT', 'P2P_PORT'],
      'Security': ['JWT_SECRET', 'SESSION_SECRET', 'ENCRYPTION_KEY'],
      'Database': ['DATABASE_URL', 'DATABASE_POOL_MIN', 'DATABASE_POOL_MAX'],
      'Blockchain': ['BLOCKCHAIN_URL', 'BLOCKCHAIN_USER', 'BLOCKCHAIN_PASS'],
      'Pool Configuration': ['POOL_NAME', 'POOL_FEE', 'MIN_PAYOUT', 'PAYOUT_INTERVAL'],
      'Monitoring': ['ENABLE_MONITORING', 'METRICS_PORT', 'LOG_LEVEL'],
      'External Services': ['REDIS_URL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'],
      'Feature Flags': ['ENABLE_2FA', 'ENABLE_API_KEYS', 'ENABLE_WEBSOCKET', 'ENABLE_COMPRESSION'],
      'Development': ['ENABLE_DEV_TOOLS', 'DISABLE_RATE_LIMIT']
    };
    
    for (const [category, keys] of Object.entries(categories)) {
      lines.push(`\n# ${category}`);
      lines.push('#' + '='.repeat(50));
      
      for (const key of keys) {
        const schema = this.schema[key];
        if (!schema) continue;
        
        // Add description
        lines.push(`\n# ${schema.description}`);
        
        // Add type and constraints
        const constraints = [];
        if (schema.required) constraints.push('Required');
        if (schema.type) constraints.push(`Type: ${schema.type}`);
        if (schema.values) constraints.push(`Values: ${schema.values.join(', ')}`);
        if (schema.min !== undefined) constraints.push(`Min: ${schema.min}`);
        if (schema.max !== undefined) constraints.push(`Max: ${schema.max}`);
        if (schema.minLength) constraints.push(`Min length: ${schema.minLength}`);
        
        if (constraints.length > 0) {
          lines.push(`# ${constraints.join(', ')}`);
        }
        
        // Add the variable
        if (schema.sensitive) {
          lines.push(`${key}=your-${key.toLowerCase().replace(/_/g, '-')}-here`);
        } else if (schema.default !== undefined) {
          lines.push(`${key}=${schema.default}`);
        } else {
          lines.push(`# ${key}=`);
        }
      }
    }
    
    // Write to file
    const content = lines.join('\n');
    const filepath = path.join(process.cwd(), '.env.example');
    
    fs.writeFileSync(filepath, content);
    this.logger.info(`Generated .env.example at ${filepath}`);
    
    return content;
  }
  
  /**
   * Load environment from .env file
   */
  loadEnvFile(filepath = '.env') {
    try {
      const envPath = path.resolve(process.cwd(), filepath);
      
      if (!fs.existsSync(envPath)) {
        this.warnings.push(`Environment file ${filepath} not found`);
        return false;
      }
      
      // Simple .env parser
      const content = fs.readFileSync(envPath, 'utf-8');
      const lines = content.split('\n');
      
      for (const line of lines) {
        // Skip comments and empty lines
        if (line.trim().startsWith('#') || line.trim() === '') {
          continue;
        }
        
        // Parse key=value
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          const value = match[2].trim();
          
          // Only set if not already set
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
      
      this.logger.info(`Loaded environment from ${filepath}`);
      return true;
      
    } catch (error) {
      this.errors.push(`Failed to load ${filepath}: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Get configuration object from environment
   */
  getConfig() {
    const config = {};
    
    for (const [key, schema] of Object.entries(this.schema)) {
      const value = process.env[key];
      
      if (value !== undefined) {
        // Convert to appropriate type
        let parsedValue = value;
        
        switch (schema.type) {
          case 'number':
            parsedValue = Number(value);
            break;
          case 'boolean':
            parsedValue = ['true', '1', 'yes'].includes(value.toLowerCase());
            break;
        }
        
        // Create nested object structure
        const parts = key.toLowerCase().split('_');
        let current = config;
        
        for (let i = 0; i < parts.length - 1; i++) {
          if (!current[parts[i]]) {
            current[parts[i]] = {};
          }
          current = current[parts[i]];
        }
        
        current[parts[parts.length - 1]] = parsedValue;
      }
    }
    
    return config;
  }
  
  /**
   * Mask sensitive values for logging
   */
  getMaskedEnv() {
    const masked = {};
    
    for (const [key, schema] of Object.entries(this.schema)) {
      const value = process.env[key];
      
      if (value !== undefined) {
        if (schema.sensitive) {
          // Show first and last few characters
          if (value.length > 8) {
            masked[key] = value.slice(0, 3) + '*'.repeat(6) + value.slice(-3);
          } else {
            masked[key] = '*'.repeat(value.length);
          }
        } else {
          masked[key] = value;
        }
      }
    }
    
    return masked;
  }
}

// Export singleton instance
const envValidator = new EnvValidator();

module.exports = {
  EnvValidator,
  envValidator,
  validate: () => envValidator.validate(),
  loadEnvFile: (filepath) => envValidator.loadEnvFile(filepath),
  generateExample: () => envValidator.generateExample(),
  getConfig: () => envValidator.getConfig(),
  getMaskedEnv: () => envValidator.getMaskedEnv()
};