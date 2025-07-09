import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';

/**
 * Unified Configuration System
 * Philosophy: Single source of truth for all configuration (Pike)
 * Performance: Validated at startup, cached in memory (Carmack)
 * Clean: Type-safe with Zod validation (Martin)
 */

// Configuration schemas with strict validation
const DatabaseConfigSchema = z.object({
  type: z.enum(['sqlite', 'postgresql']).default('sqlite'),
  path: z.string().default('./data/pool.db'),
  host: z.string().optional(),
  port: z.number().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  database: z.string().optional(),
  connectionLimit: z.number().default(10),
  acquireTimeout: z.number().default(60000),
  timeout: z.number().default(60000),
  ssl: z.boolean().default(false),
  schema: z.string().default('public')
});

const LoggingConfigSchema = z.object({
  level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  format: z.enum(['json', 'text']).default('json'),
  file: z.object({
    enabled: z.boolean().default(true),
    path: z.string().default('./logs'),
    maxSize: z.string().default('10m'),
    maxFiles: z.string().default('10'),
    datePattern: z.string().default('YYYY-MM-DD')
  }).default({}),
  console: z.object({
    enabled: z.boolean().default(true),
    colorize: z.boolean().default(true)
  }).default({})
});

const SecurityConfigSchema = z.object({
  rateLimit: z.object({
    windowMs: z.number().default(900000), // 15 minutes
    maxRequests: z.number().default(100),
    skipSuccessfulRequests: z.boolean().default(false)
  }).default({}),
  cors: z.object({
    enabled: z.boolean().default(true),
    origins: z.array(z.string()).default(['*']),
    credentials: z.boolean().default(false)
  }).default({}),
  jwt: z.object({
    secret: z.string().optional(),
    expiresIn: z.string().default('24h')
  }).default({}),
  tls: z.object({
    enabled: z.boolean().default(false),
    certPath: z.string().optional(),
    keyPath: z.string().optional(),
    caPath: z.string().optional()
  }).default({}),
  ddos: z.object({
    burst: z.number().default(10),
    limit: z.number().default(15),
    maxconnections: z.number().default(50),
    errdelay: z.number().default(500)
  }).default({})
});

const P2PConfigSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().default(9000),
  bootstrap: z.array(z.string()).default([]),
  maxPeers: z.number().default(50),
  minPeers: z.number().default(3),
  protocols: z.array(z.string()).default(['/otedama/1.0.0']),
  dht: z.object({
    enabled: z.boolean().default(true),
    kBucketSize: z.number().default(20)
  }).default({}),
  discovery: z.object({
    mdns: z.boolean().default(true),
    bootstrap: z.boolean().default(true),
    dht: z.boolean().default(true)
  }).default({})
});

const PoolConfigSchema = z.object({
  name: z.string().default('Otedama Pool'),
  port: z.number().default(3333),
  difficulty: z.object({
    initial: z.number().default(1),
    retarget: z.number().default(15),
    min: z.number().default(0.1),
    max: z.number().default(1000000)
  }).default({}),
  coinbase: z.object({
    address: z.string(),
    message: z.string().default('Mined by Otedama'),
    fee: z.number().default(0.01)
  }),
  algorithms: z.array(z.string()).default(['sha256d']),
  payouts: z.object({
    method: z.enum(['PPLNS', 'PPS', 'FPPS']).default('PPLNS'),
    interval: z.number().default(300), // 5 minutes
    threshold: z.number().default(0.001),
    fee: z.number().default(0.01)
  }).default({}),
  shareChain: z.object({
    enabled: z.boolean().default(true),
    interval: z.number().default(30),
    blockTime: z.number().default(600)
  }).default({})
});

const MetricsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().default(9090),
  prefix: z.string().default('otedama_'),
  interval: z.number().default(15000),
  prometheus: z.object({
    enabled: z.boolean().default(true),
    endpoint: z.string().default('/metrics')
  }).default({}),
  jaeger: z.object({
    enabled: z.boolean().default(false),
    endpoint: z.string().default('http://localhost:14268/api/traces'),
    serviceName: z.string().default('otedama-pool')
  }).default({})
});

const ServiceMeshConfigSchema = z.object({
  enabled: z.boolean().default(false),
  type: z.enum(['istio', 'linkerd', 'consul']).default('istio'),
  namespace: z.string().default('default'),
  discovery: z.object({
    enabled: z.boolean().default(true),
    interval: z.number().default(30000)
  }).default({})
});

const ConfigSchema = z.object({
  database: DatabaseConfigSchema,
  logging: LoggingConfigSchema,
  security: SecurityConfigSchema,
  p2p: P2PConfigSchema,
  pool: PoolConfigSchema,
  metrics: MetricsConfigSchema,
  serviceMesh: ServiceMeshConfigSchema,
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  clusterMode: z.boolean().default(false)
});

type Config = z.infer<typeof ConfigSchema>;

export class UnifiedConfig {
  private config: Config | null = null;
  private readonly configPaths = [
    './config/pool.json',
    './config/config.json',
    './pool.config.json',
    './config.json'
  ];

  constructor(private customPath?: string) {}

  public async load(): Promise<void> {
    try {
      const rawConfig = await this.loadConfigFile();
      const envConfig = this.loadEnvironmentConfig();
      
      // Merge configurations: file < environment
      const mergedConfig = this.mergeConfig(rawConfig, envConfig);
      
      // Validate configuration
      this.config = ConfigSchema.parse(mergedConfig);
      
      // Validate required fields
      this.validateRequiredFields();
      
    } catch (error) {
      throw new Error(`Configuration loading failed: ${error.message}`);
    }
  }

  private async loadConfigFile(): Promise<Partial<Config>> {
    const paths = this.customPath ? [this.customPath] : this.configPaths;
    
    for (const configPath of paths) {
      try {
        const content = await fs.readFile(configPath, 'utf-8');
        return JSON.parse(content);
      } catch (error) {
        // Try next path
        continue;
      }
    }
    
    // No config file found, use defaults
    return {};
  }

  private loadEnvironmentConfig(): Partial<Config> {
    return {
      nodeEnv: (process.env.NODE_ENV as any) || 'development',
      clusterMode: process.env.CLUSTER_MODE === 'true',
      database: {
        type: (process.env.DB_TYPE as any) || 'sqlite',
        path: process.env.DB_PATH || './data/pool.db',
        host: process.env.DB_HOST,
        port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : undefined,
        username: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
      },
      logging: {
        level: (process.env.LOG_LEVEL as any) || 'info'
      },
      security: {
        jwt: {
          secret: process.env.JWT_SECRET
        }
      },
      pool: {
        port: process.env.POOL_PORT ? parseInt(process.env.POOL_PORT) : 3333,
        coinbase: {
          address: process.env.COINBASE_ADDRESS || ''
        }
      },
      p2p: {
        port: process.env.P2P_PORT ? parseInt(process.env.P2P_PORT) : 9000
      },
      metrics: {
        port: process.env.METRICS_PORT ? parseInt(process.env.METRICS_PORT) : 9090
      }
    };
  }

  private mergeConfig(fileConfig: any, envConfig: any): any {
    return this.deepMerge(fileConfig, envConfig);
  }

  private deepMerge(target: any, source: any): any {
    const result = { ...target };
    
    for (const key in source) {
      if (source[key] !== undefined) {
        if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
          result[key] = this.deepMerge(result[key] || {}, source[key]);
        } else {
          result[key] = source[key];
        }
      }
    }
    
    return result;
  }

  private validateRequiredFields(): void {
    if (!this.config) {
      throw new Error('Configuration not loaded');
    }
    
    if (!this.config.pool.coinbase.address) {
      throw new Error('Coinbase address is required (COINBASE_ADDRESS environment variable)');
    }
    
    if (!this.config.security.jwt.secret) {
      // Generate a warning, use default for development
      if (this.config.nodeEnv === 'production') {
        throw new Error('JWT secret is required in production (JWT_SECRET environment variable)');
      } else {
        this.config.security.jwt.secret = 'development-secret-change-in-production';
      }
    }
  }

  // Getters with type safety
  public get database(): Config['database'] {
    this.ensureLoaded();
    return this.config!.database;
  }

  public get logging(): Config['logging'] {
    this.ensureLoaded();
    return this.config!.logging;
  }

  public get security(): Config['security'] {
    this.ensureLoaded();
    return this.config!.security;
  }

  public get p2p(): Config['p2p'] {
    this.ensureLoaded();
    return this.config!.p2p;
  }

  public get pool(): Config['pool'] {
    this.ensureLoaded();
    return this.config!.pool;
  }

  public get metrics(): Config['metrics'] {
    this.ensureLoaded();
    return this.config!.metrics;
  }

  public get serviceMesh(): Config['serviceMesh'] {
    this.ensureLoaded();
    return this.config!.serviceMesh;
  }

  public get nodeEnv(): Config['nodeEnv'] {
    this.ensureLoaded();
    return this.config!.nodeEnv;
  }

  public get clusterMode(): Config['clusterMode'] {
    this.ensureLoaded();
    return this.config!.clusterMode;
  }

  public get all(): Config {
    this.ensureLoaded();
    return this.config!;
  }

  private ensureLoaded(): void {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call load() first.');
    }
  }

  // Development helper
  public async createDefaultConfigFile(path: string = './config/pool.json'): Promise<void> {
    const defaultConfig: Partial<Config> = {
      pool: {
        name: 'Otedama Development Pool',
        coinbase: {
          address: 'bc1qexample...',
          message: 'Mined by Otedama Development Pool'
        }
      },
      security: {
        jwt: {
          secret: 'change-this-in-production'
        }
      }
    };

    await fs.mkdir(path.split('/').slice(0, -1).join('/'), { recursive: true });
    await fs.writeFile(path, JSON.stringify(defaultConfig, null, 2));
  }
}

export type { Config };