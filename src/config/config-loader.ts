/**
 * Configuration File Management System
 * Design: Carmack (Performance) + Martin (Clean Architecture) + Pike (Simplicity)
 * 
 * JSON/YAML configuration with validation and hot-reload
 */

import { EventEmitter } from 'events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { watch, FSWatcher } from 'chokidar';
import { join, dirname } from 'path';
import { homedir } from 'os';
import * as dotenv from 'dotenv';
import { createComponentLogger } from '../logging/simple-logger';

// ===== INTERFACES =====
export interface ConfigSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    required?: boolean;
    default?: any;
    validator?: (value: any) => boolean;
    description?: string;
    env?: string; // Environment variable name
    transform?: (value: any) => any;
  };
}

export interface ConfigOptions {
  configPath?: string;
  schemaPath?: string;
  envPath?: string;
  watchForChanges?: boolean;
  mergeWithEnv?: boolean;
  createIfNotExists?: boolean;
  validateOnLoad?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: string[];
}

export interface ValidationError {
  path: string;
  message: string;
  value?: any;
}

// ===== CONFIG LOADER =====
export class ConfigLoader extends EventEmitter {
  private config: any = {};
  private schema?: ConfigSchema;
  private options: Required<ConfigOptions>;
  private logger = createComponentLogger('ConfigLoader');
  private watcher?: FSWatcher;

  constructor(options: ConfigOptions = {}) {
    super();
    
    this.options = {
      configPath: options.configPath || './config/config.json',
      schemaPath: options.schemaPath,
      envPath: options.envPath || '.env',
      watchForChanges: options.watchForChanges || false,
      mergeWithEnv: options.mergeWithEnv !== false,
      createIfNotExists: options.createIfNotExists || false,
      validateOnLoad: options.validateOnLoad !== false
    };
  }

  async load(): Promise<any> {
    try {
      // Load environment variables first
      if (this.options.mergeWithEnv) {
        this.loadEnvFile();
      }

      // Load schema if provided
      if (this.options.schemaPath) {
        this.schema = this.loadSchema();
      }

      // Check if config file exists
      if (!existsSync(this.options.configPath)) {
        if (this.options.createIfNotExists && this.schema) {
          this.createDefaultConfig();
        } else {
          throw new Error(`Config file not found: ${this.options.configPath}`);
        }
      }

      // Load config file
      const configContent = readFileSync(this.options.configPath, 'utf8');
      const fileExtension = this.options.configPath.split('.').pop()?.toLowerCase();

      if (fileExtension === 'json') {
        this.config = JSON.parse(configContent);
      } else if (fileExtension === 'yaml' || fileExtension === 'yml') {
        // Simple YAML parser (in production, use a proper YAML library)
        this.config = this.parseSimpleYaml(configContent);
      } else {
        throw new Error(`Unsupported config file format: ${fileExtension}`);
      }

      // Merge with environment variables
      if (this.options.mergeWithEnv && this.schema) {
        this.mergeWithEnvironment();
      }

      // Apply transformations
      if (this.schema) {
        this.applyTransformations();
      }

      // Validate if required
      if (this.options.validateOnLoad && this.schema) {
        const validation = this.validate();
        if (!validation.valid) {
          throw new Error(`Config validation failed: ${JSON.stringify(validation.errors)}`);
        }
      }

      // Set up file watching
      if (this.options.watchForChanges) {
        this.setupWatcher();
      }

      this.logger.info('Configuration loaded successfully', {
        configPath: this.options.configPath
      });

      this.emit('loaded', this.config);
      return this.config;

    } catch (error) {
      this.logger.error('Failed to load configuration', error as Error);
      throw error;
    }
  }

  private loadEnvFile(): void {
    if (existsSync(this.options.envPath)) {
      dotenv.config({ path: this.options.envPath });
      this.logger.debug('Environment file loaded', { path: this.options.envPath });
    }
  }

  private loadSchema(): ConfigSchema {
    if (!this.options.schemaPath) {
      throw new Error('Schema path not provided');
    }

    if (!existsSync(this.options.schemaPath)) {
      throw new Error(`Schema file not found: ${this.options.schemaPath}`);
    }

    const schemaContent = readFileSync(this.options.schemaPath, 'utf8');
    return JSON.parse(schemaContent);
  }

  private createDefaultConfig(): void {
    const defaultConfig: any = {};

    // Generate default config from schema
    for (const [key, schema] of Object.entries(this.schema!)) {
      if (schema.default !== undefined) {
        this.setNestedValue(defaultConfig, key, schema.default);
      }
    }

    // Ensure directory exists
    const configDir = dirname(this.options.configPath);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    // Write default config
    const fileExtension = this.options.configPath.split('.').pop()?.toLowerCase();
    let content: string;

    if (fileExtension === 'json') {
      content = JSON.stringify(defaultConfig, null, 2);
    } else if (fileExtension === 'yaml' || fileExtension === 'yml') {
      content = this.toSimpleYaml(defaultConfig);
    } else {
      content = JSON.stringify(defaultConfig, null, 2);
    }

    writeFileSync(this.options.configPath, content, 'utf8');
    
    this.logger.info('Created default configuration file', {
      path: this.options.configPath
    });
  }

  private mergeWithEnvironment(): void {
    for (const [key, schema] of Object.entries(this.schema!)) {
      if (schema.env && process.env[schema.env]) {
        const envValue = this.parseEnvValue(process.env[schema.env]!, schema.type);
        this.setNestedValue(this.config, key, envValue);
      }
    }
  }

  private applyTransformations(): void {
    for (const [key, schema] of Object.entries(this.schema!)) {
      if (schema.transform) {
        const currentValue = this.getNestedValue(this.config, key);
        if (currentValue !== undefined) {
          const transformedValue = schema.transform(currentValue);
          this.setNestedValue(this.config, key, transformedValue);
        }
      }
    }
  }

  private parseEnvValue(value: string, type: string): any {
    switch (type) {
      case 'number':
        return parseFloat(value);
      case 'boolean':
        return value.toLowerCase() === 'true';
      case 'array':
        return value.split(',').map(v => v.trim());
      case 'object':
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      default:
        return value;
    }
  }

  private setupWatcher(): void {
    this.watcher = watch(this.options.configPath, {
      persistent: true,
      ignoreInitial: true
    });

    this.watcher.on('change', async () => {
      this.logger.info('Configuration file changed, reloading...');
      
      try {
        await this.load();
        this.emit('reloaded', this.config);
      } catch (error) {
        this.logger.error('Failed to reload configuration', error as Error);
        this.emit('reload:error', error);
      }
    });
  }

  validate(): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: string[] = [];

    if (!this.schema) {
      return { valid: true, errors, warnings };
    }

    for (const [key, schema] of Object.entries(this.schema)) {
      const value = this.getNestedValue(this.config, key);

      // Check required fields
      if (schema.required && value === undefined) {
        errors.push({
          path: key,
          message: `Required field missing`
        });
        continue;
      }

      // Skip validation if value is undefined and not required
      if (value === undefined) {
        continue;
      }

      // Type validation
      if (!this.validateType(value, schema.type)) {
        errors.push({
          path: key,
          message: `Expected type ${schema.type}, got ${typeof value}`,
          value
        });
      }

      // Custom validation
      if (schema.validator && !schema.validator(value)) {
        errors.push({
          path: key,
          message: `Custom validation failed`,
          value
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  private validateType(value: any, type: string): boolean {
    switch (type) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !isNaN(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'array':
        return Array.isArray(value);
      default:
        return false;
    }
  }

  get<T = any>(key: string, defaultValue?: T): T {
    const value = this.getNestedValue(this.config, key);
    return value !== undefined ? value : defaultValue;
  }

  set(key: string, value: any): void {
    this.setNestedValue(this.config, key, value);
    this.emit('changed', { key, value });
  }

  private getNestedValue(obj: any, path: string): any {
    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return undefined;
      }
    }

    return current;
  }

  private setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current) || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }

    current[keys[keys.length - 1]] = value;
  }

  private parseSimpleYaml(content: string): any {
    // Very basic YAML parser - in production use a proper library like js-yaml
    const result: any = {};
    const lines = content.split('\n');
    const stack: any[] = [result];
    const indentStack: number[] = [0];

    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith('#')) continue;

      const indent = line.length - line.trimStart().length;
      const trimmed = line.trim();

      // Handle key-value pairs
      if (trimmed.includes(':')) {
        const [key, ...valueParts] = trimmed.split(':');
        const value = valueParts.join(':').trim();

        // Adjust stack based on indentation
        while (indentStack.length > 1 && indent <= indentStack[indentStack.length - 1]) {
          stack.pop();
          indentStack.pop();
        }

        const current = stack[stack.length - 1];

        if (value) {
          // Simple value
          current[key.trim()] = this.parseYamlValue(value);
        } else {
          // Object
          current[key.trim()] = {};
          stack.push(current[key.trim()]);
          indentStack.push(indent);
        }
      }
    }

    return result;
  }

  private parseYamlValue(value: string): any {
    // Remove quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }

    // Boolean
    if (value === 'true') return true;
    if (value === 'false') return false;

    // Number
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      return parseFloat(value);
    }

    // Array (simple comma-separated)
    if (value.startsWith('[') && value.endsWith(']')) {
      return value.slice(1, -1).split(',').map(v => this.parseYamlValue(v.trim()));
    }

    return value;
  }

  private toSimpleYaml(obj: any, indent: number = 0): string {
    let result = '';
    const spaces = '  '.repeat(indent);

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result += `${spaces}${key}:\n`;
        result += this.toSimpleYaml(value, indent + 1);
      } else if (Array.isArray(value)) {
        result += `${spaces}${key}: [${value.join(', ')}]\n`;
      } else {
        result += `${spaces}${key}: ${value}\n`;
      }
    }

    return result;
  }

  async save(): Promise<void> {
    try {
      const fileExtension = this.options.configPath.split('.').pop()?.toLowerCase();
      let content: string;

      if (fileExtension === 'json') {
        content = JSON.stringify(this.config, null, 2);
      } else if (fileExtension === 'yaml' || fileExtension === 'yml') {
        content = this.toSimpleYaml(this.config);
      } else {
        content = JSON.stringify(this.config, null, 2);
      }

      writeFileSync(this.options.configPath, content, 'utf8');
      
      this.logger.info('Configuration saved', {
        path: this.options.configPath
      });

      this.emit('saved', this.config);
    } catch (error) {
      this.logger.error('Failed to save configuration', error as Error);
      throw error;
    }
  }

  getAll(): any {
    return { ...this.config };
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }
}

// ===== CONFIG MANAGER =====
export class ConfigManager extends EventEmitter {
  private configs = new Map<string, ConfigLoader>();
  private logger = createComponentLogger('ConfigManager');

  async loadConfig(name: string, options: ConfigOptions): Promise<any> {
    const loader = new ConfigLoader(options);
    const config = await loader.load();
    
    this.configs.set(name, loader);
    
    // Forward events
    loader.on('reloaded', (config) => {
      this.emit('config:reloaded', { name, config });
    });

    loader.on('changed', (data) => {
      this.emit('config:changed', { name, ...data });
    });

    this.logger.info('Configuration loaded', { name });
    return config;
  }

  get(name: string, key?: string, defaultValue?: any): any {
    const loader = this.configs.get(name);
    if (!loader) {
      throw new Error(`Configuration '${name}' not found`);
    }

    if (key) {
      return loader.get(key, defaultValue);
    }

    return loader.getAll();
  }

  set(name: string, key: string, value: any): void {
    const loader = this.configs.get(name);
    if (!loader) {
      throw new Error(`Configuration '${name}' not found`);
    }

    loader.set(key, value);
  }

  async save(name: string): Promise<void> {
    const loader = this.configs.get(name);
    if (!loader) {
      throw new Error(`Configuration '${name}' not found`);
    }

    await loader.save();
  }

  async saveAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    
    for (const [name, loader] of this.configs) {
      promises.push(loader.save());
    }

    await Promise.all(promises);
  }

  validate(name: string): ValidationResult {
    const loader = this.configs.get(name);
    if (!loader) {
      throw new Error(`Configuration '${name}' not found`);
    }

    return loader.validate();
  }

  stopAll(): void {
    for (const loader of this.configs.values()) {
      loader.stop();
    }
    
    this.configs.clear();
  }
}

// ===== DEFAULT SCHEMAS =====
export const DEFAULT_POOL_SCHEMA: ConfigSchema = {
  'pool.name': {
    type: 'string',
    required: true,
    default: 'Otedama Pool',
    description: 'Name of the mining pool'
  },
  'pool.host': {
    type: 'string',
    required: true,
    default: '0.0.0.0',
    env: 'POOL_HOST',
    description: 'Pool listening host'
  },
  'pool.port': {
    type: 'number',
    required: true,
    default: 3333,
    env: 'POOL_PORT',
    transform: (value) => parseInt(value),
    description: 'Pool listening port'
  },
  'pool.difficulty.initial': {
    type: 'number',
    default: 1000,
    description: 'Initial mining difficulty'
  },
  'pool.difficulty.minimum': {
    type: 'number',
    default: 100,
    description: 'Minimum allowed difficulty'
  },
  'pool.difficulty.maximum': {
    type: 'number',
    default: 1000000,
    description: 'Maximum allowed difficulty'
  },
  'pool.payment.scheme': {
    type: 'string',
    default: 'pplns',
    validator: (value) => ['pplns', 'pps', 'fpps', 'prop', 'solo'].includes(value),
    description: 'Payment scheme'
  },
  'pool.payment.fee': {
    type: 'number',
    default: 1,
    validator: (value) => value >= 0 && value <= 100,
    description: 'Pool fee percentage'
  },
  'pool.payment.minPayout': {
    type: 'number',
    default: 0.001,
    description: 'Minimum payout amount'
  },
  'blockchain.type': {
    type: 'string',
    required: true,
    default: 'bitcoin',
    env: 'BLOCKCHAIN_TYPE',
    description: 'Blockchain type'
  },
  'blockchain.rpc.url': {
    type: 'string',
    required: true,
    default: 'http://localhost:8332',
    env: 'RPC_URL',
    description: 'Blockchain RPC URL'
  },
  'blockchain.rpc.user': {
    type: 'string',
    env: 'RPC_USER',
    description: 'RPC username'
  },
  'blockchain.rpc.password': {
    type: 'string',
    env: 'RPC_PASSWORD',
    description: 'RPC password'
  },
  'database.type': {
    type: 'string',
    default: 'sqlite',
    validator: (value) => ['sqlite', 'postgresql'].includes(value),
    description: 'Database type'
  },
  'database.connectionString': {
    type: 'string',
    env: 'DATABASE_URL',
    description: 'Database connection string'
  },
  'redis.enabled': {
    type: 'boolean',
    default: false,
    description: 'Enable Redis caching'
  },
  'redis.host': {
    type: 'string',
    default: 'localhost',
    env: 'REDIS_HOST',
    description: 'Redis host'
  },
  'redis.port': {
    type: 'number',
    default: 6379,
    env: 'REDIS_PORT',
    transform: (value) => parseInt(value),
    description: 'Redis port'
  },
  'p2p.enabled': {
    type: 'boolean',
    default: true,
    description: 'Enable P2P network'
  },
  'p2p.port': {
    type: 'number',
    default: 8333,
    description: 'P2P listening port'
  },
  'p2p.bootstrapNodes': {
    type: 'array',
    default: [],
    env: 'P2P_BOOTSTRAP_NODES',
    transform: (value) => typeof value === 'string' ? value.split(',') : value,
    description: 'P2P bootstrap nodes'
  },
  'logging.level': {
    type: 'string',
    default: 'info',
    env: 'LOG_LEVEL',
    validator: (value) => ['debug', 'info', 'warn', 'error'].includes(value),
    description: 'Logging level'
  },
  'monitoring.enabled': {
    type: 'boolean',
    default: true,
    description: 'Enable monitoring'
  },
  'monitoring.port': {
    type: 'number',
    default: 9090,
    description: 'Monitoring metrics port'
  }
};

// ===== UTILITY FUNCTIONS =====
export function createDefaultConfig(
  schema: ConfigSchema,
  outputPath: string,
  format: 'json' | 'yaml' = 'json'
): void {
  const config: any = {};

  for (const [key, schemaItem] of Object.entries(schema)) {
    if (schemaItem.default !== undefined) {
      const keys = key.split('.');
      let current = config;

      for (let i = 0; i < keys.length - 1; i++) {
        if (!(keys[i] in current)) {
          current[keys[i]] = {};
        }
        current = current[keys[i]];
      }

      current[keys[keys.length - 1]] = schemaItem.default;
    }
  }

  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let content: string;
  if (format === 'json') {
    content = JSON.stringify(config, null, 2);
  } else {
    // Use the simple YAML serializer
    const loader = new ConfigLoader();
    content = (loader as any).toSimpleYaml(config);
  }

  writeFileSync(outputPath, content, 'utf8');
}

export function loadConfigFromFile(path: string, schema?: ConfigSchema): any {
  const loader = new ConfigLoader({
    configPath: path,
    validateOnLoad: !!schema
  });

  if (schema) {
    (loader as any).schema = schema;
  }

  return loader.load();
}
