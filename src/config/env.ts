/**
 * Environment variable management with validation
 * Following Clean Code principles: type safety, validation, clear errors
 */

import * as dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenv.config();

// Environment variable schema
const envSchema = z.object({
  // Environment
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  DEBUG: z.string().optional(),

  // Blockchain
  BLOCKCHAIN_TYPE: z.enum(['bitcoin', 'ethereum', 'litecoin', 'dogecoin']).default('bitcoin'),
  RPC_URL: z.string().url().default('http://localhost:8332'),
  RPC_USER: z.string().optional(),
  RPC_PASSWORD: z.string().optional(),

  // Pool configuration
  POOL_ADDRESS: z.string().min(1, 'Pool address is required'),
  POOL_FEE: z.coerce.number().min(0).max(100).default(1.0),
  MIN_PAYOUT: z.coerce.number().positive().default(0.001),
  MAX_PAYOUT: z.coerce.number().positive().default(10.0),
  POOL_DIFFICULTY: z.coerce.number().positive().default(1),
  BLOCK_CONFIRMATIONS: z.coerce.number().int().positive().default(6),

  // Network ports
  STRATUM_PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  P2P_PORT: z.coerce.number().int().min(1).max(65535).default(4333),
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9090),

  // Database
  DATABASE_TYPE: z.enum(['sqlite', 'postgresql']).default('sqlite'),
  DATABASE_PATH: z.string().default('./data/pool.db'),
  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().default(5432),
  DB_NAME: z.string().default('otedama'),
  DB_USER: z.string().default('otedama'),
  DB_PASSWORD: z.string().default(''),
  DB_SSL: z.coerce.boolean().default(false),
  DB_POOL_MIN: z.coerce.number().int().default(2),
  DB_POOL_MAX: z.coerce.number().int().default(10),
  DB_TIMEOUT: z.coerce.number().int().default(30000),

  // Redis
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DATABASE: z.coerce.number().int().default(0),
  REDIS_KEY_PREFIX: z.string().default('otedama:'),

  // Security
  JWT_SECRET: z.string().min(32, 'JWT secret must be at least 32 characters'),
  JWT_EXPIRATION: z.string().default('24h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).default(10),
  ENABLE_HTTPS: z.coerce.boolean().default(false),
  TLS_CERT: z.string().optional(),
  TLS_KEY: z.string().optional(),

  // P2P Network
  BOOTSTRAP_NODES: z.string().optional(),
  MAX_PEERS: z.coerce.number().int().default(50),
  ENABLE_MDNS: z.coerce.boolean().default(true),
  ENABLE_DHT: z.coerce.boolean().default(true),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LOG_FORMAT: z.enum(['json', 'simple', 'detailed']).default('detailed'),
  LOG_FILE: z.coerce.boolean().default(true),
  LOG_FILE_PATH: z.string().default('./logs/app.log'),
  LOG_MAX_SIZE: z.string().default('10m'),
  LOG_MAX_FILES: z.string().default('14d'),
  LOG_CONSOLE: z.coerce.boolean().default(true),

  // Monitoring
  MONITORING_ENABLED: z.coerce.boolean().default(true),
  HEALTH_CHECK_INTERVAL: z.coerce.number().int().default(30000),
  ALERTING_ENABLED: z.coerce.boolean().default(false),
  WEBHOOK_URL: z.string().url().optional(),

  // Rate limiting
  MAX_CONNECTIONS_PER_IP: z.coerce.number().int().default(10),
  RATE_LIMIT_WINDOW: z.coerce.number().int().default(60000),
  MAX_SHARES_PER_MINUTE: z.coerce.number().int().default(120),
  MAX_INVALID_SHARES_PER_HOUR: z.coerce.number().int().default(100),
  BAN_DURATION: z.coerce.number().int().default(3600000),

  // Backup
  BACKUP_ENABLED: z.coerce.boolean().default(true),
  BACKUP_DIR: z.string().default('./backups'),
  MAX_BACKUPS: z.coerce.number().int().default(7),
  BACKUP_SCHEDULE: z.string().default('0 0 * * *'),

  // Worker configuration
  WORKERS: z.coerce.number().int().default(0),
  WORKER_TIMEOUT: z.coerce.number().int().default(30000),
  KEEP_ALIVE_TIMEOUT: z.coerce.number().int().default(65000),

  // Performance
  ENABLE_CLUSTERING: z.coerce.boolean().default(true),
  CACHE_TTL: z.coerce.number().int().default(300),
  MAX_CACHE_SIZE: z.coerce.number().int().default(1000),

  // Development
  HOT_RELOAD: z.coerce.boolean().default(false),
  SOURCE_MAPS: z.coerce.boolean().default(true),
  API_DOCS: z.coerce.boolean().default(true),

  // Feature flags
  ENABLE_EXPERIMENTAL: z.coerce.boolean().default(false),
  ENABLE_WEBSOCKET: z.coerce.boolean().default(true),
  ENABLE_GRAPHQL: z.coerce.boolean().default(false),
  ENABLE_MULTI_ALGORITHM: z.coerce.boolean().default(false),
});

// Type for validated environment variables
export type EnvConfig = z.infer<typeof envSchema>;

// Validation result
let validatedEnv: EnvConfig | null = null;

/**
 * Validate and parse environment variables
 */
export function validateEnv(): EnvConfig {
  if (validatedEnv) {
    return validatedEnv;
  }

  try {
    validatedEnv = envSchema.parse(process.env);
    return validatedEnv;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Invalid environment variables:');
      error.errors.forEach((err) => {
        console.error(`  - ${err.path.join('.')}: ${err.message}`);
      });
      console.error('\nPlease check your .env file and ensure all required variables are set correctly.');
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Get validated environment configuration
 */
export function getEnvConfig(): EnvConfig {
  if (!validatedEnv) {
    return validateEnv();
  }
  return validatedEnv;
}

/**
 * Check if running in production
 */
export function isProduction(): boolean {
  const env = getEnvConfig();
  return env.NODE_ENV === 'production';
}

/**
 * Check if running in development
 */
export function isDevelopment(): boolean {
  const env = getEnvConfig();
  return env.NODE_ENV === 'development';
}

/**
 * Check if running in test
 */
export function isTest(): boolean {
  const env = getEnvConfig();
  return env.NODE_ENV === 'test';
}

/**
 * Get database connection URL
 */
export function getDatabaseUrl(): string {
  const env = getEnvConfig();
  
  if (env.DATABASE_TYPE === 'sqlite') {
    return `sqlite://${env.DATABASE_PATH}`;
  }
  
  if (env.DATABASE_URL) {
    return env.DATABASE_URL;
  }
  
  // Construct PostgreSQL URL
  const auth = env.DB_PASSWORD ? `${env.DB_USER}:${env.DB_PASSWORD}` : env.DB_USER;
  const ssl = env.DB_SSL ? '?sslmode=require' : '';
  return `postgresql://${auth}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}${ssl}`;
}

/**
 * Get Redis connection URL
 */
export function getRedisUrl(): string {
  const env = getEnvConfig();
  
  if (env.REDIS_URL) {
    return env.REDIS_URL;
  }
  
  const auth = env.REDIS_PASSWORD ? `:${env.REDIS_PASSWORD}@` : '';
  return `redis://${auth}${env.REDIS_HOST}:${env.REDIS_PORT}/${env.REDIS_DATABASE}`;
}

/**
 * Get bootstrap nodes as array
 */
export function getBootstrapNodes(): string[] {
  const env = getEnvConfig();
  
  if (!env.BOOTSTRAP_NODES) {
    return [];
  }
  
  return env.BOOTSTRAP_NODES.split(',').map(node => node.trim()).filter(Boolean);
}

/**
 * Environment configuration helper
 */
export const env = {
  get config(): EnvConfig {
    return getEnvConfig();
  },
  
  get isDev(): boolean {
    return isDevelopment();
  },
  
  get isProd(): boolean {
    return isProduction();
  },
  
  get isTest(): boolean {
    return isTest();
  },
  
  get databaseUrl(): string {
    return getDatabaseUrl();
  },
  
  get redisUrl(): string {
    return getRedisUrl();
  },
  
  get bootstrapNodes(): string[] {
    return getBootstrapNodes();
  },
  
  /**
   * Require environment variable or throw
   */
  require(key: keyof EnvConfig): any {
    const value = this.config[key];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Required environment variable ${key} is not set`);
    }
    return value;
  }
};

// Export validated config on import
export const config = getEnvConfig();

// Default export
export default env;
