// Configuration validation (Martin's clean architecture with Pike simplicity)
import * as fs from 'fs';
import * as path from 'path';
import { createComponentLogger } from '../logging/logger';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ConfigSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    required?: boolean;
    default?: any;
    min?: number;
    max?: number;
    pattern?: RegExp;
    validator?: (value: any) => boolean | string;
    description?: string;
  };
}

export class ConfigValidator {
  private logger = createComponentLogger('ConfigValidator');
  
  constructor(private schema: ConfigSchema) {}
  
  validate(config: Record<string, any>): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: []
    };
    
    // Check required fields
    for (const [key, schema] of Object.entries(this.schema)) {
      if (schema.required && !(key in config)) {
        result.errors.push(`Missing required field: ${key}`);
        result.valid = false;
        continue;
      }
      
      // Skip optional fields that are not present
      if (!(key in config) && !schema.required) {
        if (schema.default !== undefined) {
          config[key] = schema.default;
        }
        continue;
      }
      
      const value = config[key];
      
      // Type validation
      if (!this.validateType(value, schema.type)) {
        result.errors.push(`Invalid type for ${key}: expected ${schema.type}, got ${typeof value}`);
        result.valid = false;
        continue;
      }
      
      // Range validation for numbers
      if (schema.type === 'number' && typeof value === 'number') {
        if (schema.min !== undefined && value < schema.min) {
          result.errors.push(`${key} must be >= ${schema.min}, got ${value}`);
          result.valid = false;
        }
        if (schema.max !== undefined && value > schema.max) {
          result.errors.push(`${key} must be <= ${schema.max}, got ${value}`);
          result.valid = false;
        }
      }
      
      // Pattern validation for strings
      if (schema.type === 'string' && schema.pattern && typeof value === 'string') {
        if (!schema.pattern.test(value)) {
          result.errors.push(`${key} does not match required pattern: ${schema.pattern}`);
          result.valid = false;
        }
      }
      
      // Custom validator
      if (schema.validator) {
        const validatorResult = schema.validator(value);
        if (validatorResult !== true) {
          const message = typeof validatorResult === 'string' 
            ? validatorResult 
            : `${key} failed custom validation`;
          result.errors.push(message);
          result.valid = false;
        }
      }
    }
    
    // Check for unknown fields
    for (const key of Object.keys(config)) {
      if (!(key in this.schema)) {
        result.warnings.push(`Unknown configuration field: ${key}`);
      }
    }
    
    return result;
  }
  
  private validateType(value: any, expectedType: string): boolean {
    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !isNaN(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      default:
        return false;
    }
  }
}

// Pool configuration schema
export const poolConfigSchema: ConfigSchema = {
  STRATUM_PORT: {
    type: 'number',
    required: true,
    min: 1,
    max: 65535,
    default: 3333,
    description: 'Stratum server port'
  },
  RPC_URL: {
    type: 'string',
    required: true,
    pattern: /^https?:\/\/.+/,
    description: 'Bitcoin RPC URL'
  },
  RPC_USER: {
    type: 'string',
    required: true,
    description: 'Bitcoin RPC username'
  },
  RPC_PASSWORD: {
    type: 'string',
    required: true,
    description: 'Bitcoin RPC password'
  },
  POOL_ADDRESS: {
    type: 'string',
    required: true,
    validator: (value: string) => {
      // Basic Bitcoin address validation
      if (/^1[a-zA-Z0-9]{25,34}$/.test(value)) return true;
      if (/^3[a-zA-Z0-9]{25,34}$/.test(value)) return true;
      if (/^bc1[a-z0-9]{39,59}$/.test(value)) return true;
      return 'Invalid Bitcoin address format';
    },
    description: 'Pool Bitcoin address for coinbase'
  },
  POOL_FEE: {
    type: 'number',
    required: false,
    min: 0,
    max: 100,
    default: 1,
    description: 'Pool fee percentage'
  },
  DATA_DIR: {
    type: 'string',
    required: false,
    default: './data',
    description: 'Data directory path'
  },
  LOG_LEVEL: {
    type: 'string',
    required: false,
    default: 'INFO',
    pattern: /^(ERROR|WARN|INFO|DEBUG|TRACE)$/,
    description: 'Logging level'
  },
  LOG_DIR: {
    type: 'string',
    required: false,
    default: './logs',
    description: 'Log directory path'
  },
  LOG_CONSOLE: {
    type: 'boolean',
    required: false,
    default: true,
    description: 'Enable console logging'
  },
  // Security settings
  MAX_CONNECTIONS: {
    type: 'number',
    required: false,
    min: 1,
    max: 100000,
    default: 1000,
    description: 'Maximum total connections'
  },
  MAX_CONNECTIONS_PER_IP: {
    type: 'number',
    required: false,
    min: 1,
    max: 100,
    default: 10,
    description: 'Maximum connections per IP'
  },
  RATE_LIMIT_REQUESTS_PER_MINUTE: {
    type: 'number',
    required: false,
    min: 1,
    max: 10000,
    default: 600,
    description: 'Request rate limit per minute'
  },
  // TLS settings
  TLS_ENABLED: {
    type: 'boolean',
    required: false,
    default: false,
    description: 'Enable TLS/SSL'
  },
  TLS_CERT_PATH: {
    type: 'string',
    required: false,
    validator: (value: string) => {
      // Only validate if TLS is enabled
      if (process.env.TLS_ENABLED === 'true' && !value) {
        return 'TLS_CERT_PATH required when TLS is enabled';
      }
      if (value && !fs.existsSync(value)) {
        return `Certificate file not found: ${value}`;
      }
      return true;
    },
    description: 'TLS certificate path'
  },
  TLS_KEY_PATH: {
    type: 'string',
    required: false,
    validator: (value: string) => {
      // Only validate if TLS is enabled
      if (process.env.TLS_ENABLED === 'true' && !value) {
        return 'TLS_KEY_PATH required when TLS is enabled';
      }
      if (value && !fs.existsSync(value)) {
        return `Key file not found: ${value}`;
      }
      return true;
    },
    description: 'TLS private key path'
  },
  // Dashboard settings
  DASHBOARD_ENABLED: {
    type: 'boolean',
    required: false,
    default: true,
    description: 'Enable web dashboard'
  },
  DASHBOARD_PORT: {
    type: 'number',
    required: false,
    min: 1,
    max: 65535,
    default: 8080,
    description: 'Dashboard HTTP port'
  },
  DASHBOARD_WS_PORT: {
    type: 'number',
    required: false,
    min: 1,
    max: 65535,
    default: 8081,
    description: 'Dashboard WebSocket port'
  },
  // Database settings
  DB_TYPE: {
    type: 'string',
    required: false,
    default: 'sqlite',
    pattern: /^(sqlite|file)$/,
    description: 'Database type'
  },
  // Backup settings
  BACKUP_ENABLED: {
    type: 'boolean',
    required: false,
    default: true,
    description: 'Enable automatic backups'
  },
  BACKUP_INTERVAL_HOURS: {
    type: 'number',
    required: false,
    min: 1,
    max: 168, // 1 week
    default: 24,
    description: 'Backup interval in hours'
  },
  BACKUP_MAX_FILES: {
    type: 'number',
    required: false,
    min: 1,
    max: 100,
    default: 7,
    description: 'Maximum backup files to keep'
  }
};

// Validate environment variables
export function validateEnvironment(): ValidationResult {
  const logger = createComponentLogger('ConfigValidation');
  const validator = new ConfigValidator(poolConfigSchema);
  
  // Convert process.env to proper types
  const config: Record<string, any> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key in poolConfigSchema) {
      const schema = poolConfigSchema[key];
      
      // Type conversion
      if (schema.type === 'number' && value !== undefined) {
        config[key] = parseFloat(value);
      } else if (schema.type === 'boolean' && value !== undefined) {
        config[key] = value.toLowerCase() === 'true';
      } else {
        config[key] = value;
      }
    }
  }
  
  const result = validator.validate(config);
  
  // Log validation results
  if (!result.valid) {
    logger.error('Configuration validation failed', undefined, { errors: result.errors });
  }
  
  if (result.warnings.length > 0) {
    logger.warn('Configuration warnings', { warnings: result.warnings });
  }
  
  return result;
}

// Check system requirements
export function checkSystemRequirements(): ValidationResult {
  const logger = createComponentLogger('SystemCheck');
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: []
  };
  
  // Check Node.js version
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.split('.')[0].substring(1));
  
  if (majorVersion < 18) {
    result.errors.push(`Node.js version ${nodeVersion} is not supported. Requires >= 18.0.0`);
    result.valid = false;
  }
  
  // Check available memory
  const totalMemory = require('os').totalmem();
  const minMemory = 512 * 1024 * 1024; // 512 MB
  
  if (totalMemory < minMemory) {
    result.warnings.push(`Low system memory: ${Math.round(totalMemory / 1024 / 1024)} MB`);
  }
  
  // Check disk space for data directory
  const dataDir = process.env.DATA_DIR || './data';
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    // Write test file to check permissions
    const testFile = path.join(dataDir, '.test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
  } catch (error) {
    result.errors.push(`Cannot write to data directory: ${dataDir}`);
    result.valid = false;
  }
  
  // Check if ports are available
  const ports = [
    parseInt(process.env.STRATUM_PORT || '3333'),
    parseInt(process.env.DASHBOARD_PORT || '8080'),
    parseInt(process.env.DASHBOARD_WS_PORT || '8081')
  ];
  
  // Port checking would require trying to bind to them
  // For now, just warn about common ports
  for (const port of ports) {
    if (port < 1024) {
      result.warnings.push(`Port ${port} requires root/admin privileges`);
    }
  }
  
  return result;
}

// Load and validate configuration file
export async function loadConfigFile(filePath: string): Promise<Record<string, any>> {
  const logger = createComponentLogger('ConfigLoader');
  
  try {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      logger.warn(`Configuration file not found: ${filePath}`);
      return {};
    }
    
    // Read file
    const content = await fs.promises.readFile(filePath, 'utf8');
    
    // Parse based on extension
    const ext = path.extname(filePath).toLowerCase();
    let config: Record<string, any>;
    
    if (ext === '.json') {
      config = JSON.parse(content);
    } else if (ext === '.env') {
      // Parse .env format
      config = {};
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        
        const [key, ...valueParts] = trimmed.split('=');
        if (key) {
          config[key.trim()] = valueParts.join('=').trim();
        }
      }
    } else {
      throw new Error(`Unsupported config file format: ${ext}`);
    }
    
    return config;
  } catch (error) {
    logger.error(`Failed to load config file: ${filePath}`, error as Error);
    return {};
  }
}

// Merge configurations with priority
export function mergeConfigs(...configs: Record<string, any>[]): Record<string, any> {
  const merged: Record<string, any> = {};
  
  for (const config of configs) {
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined && value !== '') {
        merged[key] = value;
      }
    }
  }
  
  return merged;
}

// Generate example configuration
export function generateExampleConfig(): string {
  const lines: string[] = [
    '# Otedama Light Pool Configuration',
    '# Generated example configuration file',
    ''
  ];
  
  for (const [key, schema] of Object.entries(poolConfigSchema)) {
    if (schema.description) {
      lines.push(`# ${schema.description}`);
    }
    
    if (schema.required) {
      lines.push('# Required');
    }
    
    if (schema.min !== undefined || schema.max !== undefined) {
      const range = [];
      if (schema.min !== undefined) range.push(`min: ${schema.min}`);
      if (schema.max !== undefined) range.push(`max: ${schema.max}`);
      lines.push(`# Range: ${range.join(', ')}`);
    }
    
    const value = schema.default !== undefined ? schema.default : '';
    lines.push(`${key}=${value}`);
    lines.push('');
  }
  
  return lines.join('\n');
}
