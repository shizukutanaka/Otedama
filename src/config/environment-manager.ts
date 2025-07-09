// Environment-specific Configuration Management (Item 64: Operations)
// Comprehensive configuration system with validation and environment overrides

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logging/logger';

export type Environment = 'development' | 'staging' | 'production' | 'test';

export interface PoolConfig {
  // Core Pool Settings
  pool: {
    address: string;
    fee: number;
    name: string;
    description: string;
    website: string;
    logo?: string;
    supportEmail: string;
  };
  
  // Network Configuration
  network: {
    stratumPort: number;
    apiPort: number;
    dashboardPort: number;
    metricsPort: number;
    websocketPort?: number;
    enableIPv6: boolean;
    bindAddress: string;
  };
  
  // Bitcoin Node Configuration
  bitcoin: {
    rpcUrl: string;
    rpcUser: string;
    rpcPassword: string;
    rpcTimeout: number;
    rpcRetryCount: number;
    rpcRetryDelay: number;
    network: 'mainnet' | 'testnet' | 'regtest';
    walletName?: string;
    zmqHashBlockUrl?: string;
    zmqRawTxUrl?: string;
  };
  
  // Database Configuration
  database: {
    type: 'sqlite' | 'postgres' | 'mysql';
    sqlite?: {
      filename: string;
      options: Record<string, any>;
    };
    postgres?: {
      host: string;
      port: number;
      database: string;
      username: string;
      password: string;
      ssl: boolean;
      maxConnections: number;
      idleTimeoutMillis: number;
    };
    mysql?: {
      host: string;
      port: number;
      database: string;
      username: string;
      password: string;
      ssl: boolean;
      maxConnections: number;
    };
  };
  
  // Redis Configuration
  redis: {
    enabled: boolean;
    host: string;
    port: number;
    password?: string;
    database: number;
    maxRetries: number;
    retryDelayOnFailover: number;
    enableReadyCheck: boolean;
    lazyConnect: boolean;
    keyPrefix?: string;
  };
  
  // Security Configuration
  security: {
    ssl: {
      enabled: boolean;
      certificatePath?: string;
      privateKeyPath?: string;
      dhParamPath?: string;
      ciphers?: string;
    };
    auth: {
      enabled: boolean;
      tokenExpiry: number;
      refreshTokenExpiry: number;
      jwtSecret: string;
      bcryptRounds: number;
    };
    ddos: {
      enabled: boolean;
      maxConnections: number;
      maxConnectionsPerIP: number;
      rateLimitWindow: number;
      rateLimitMax: number;
      banDuration: number;
    };
    cors: {
      enabled: boolean;
      origins: string[] | '*';
      credentials: boolean;
      optionsSuccessStatus: number;
    };
    headers: {
      enableSecurityHeaders: boolean;
      hsts: {
        enabled: boolean;
        maxAge: number;
        includeSubDomains: boolean;
        preload: boolean;
      };
      csp: string | null;
      frameOptions: string;
    };
  };
  
  // Performance Configuration
  performance: {
    clustering: {
      enabled: boolean;
      workers: number | 'auto';
      respawnDelay: number;
    };
    parallelValidation: {
      enabled: boolean;
      workers: number;
      batchSize: number;
    };
    memoryOptimization: {
      enabled: boolean;
      poolSize: number;
      gcInterval: number;
    };
    cpuAffinity: {
      enabled: boolean;
      stratumCores?: number[];
      validationCores?: number[];
    };
    caching: {
      shareCache: {
        enabled: boolean;
        maxSize: number;
        ttl: number;
      };
      minerCache: {
        enabled: boolean;
        maxSize: number;
        ttl: number;
      };
    };
  };
  
  // Monitoring Configuration
  monitoring: {
    enabled: boolean;
    prometheus: {
      enabled: boolean;
      port: number;
      path: string;
      collectDefaultMetrics: boolean;
    };
    grafana: {
      enabled: boolean;
      dashboardUrl?: string;
    };
    alerts: {
      enabled: boolean;
      discord?: {
        webhookUrl: string;
        username: string;
        avatarUrl?: string;
      };
      telegram?: {
        botToken: string;
        chatId: string;
      };
      email?: {
        smtp: {
          host: string;
          port: number;
          secure: boolean;
          user: string;
          password: string;
        };
        from: string;
        to: string[];
      };
    };
    logging: {
      level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
      format: 'json' | 'text';
      outputs: Array<{
        type: 'file' | 'console' | 'elasticsearch' | 'logstash';
        config: Record<string, any>;
      }>;
      aggregation: {
        enabled: boolean;
        bufferSize: number;
        flushInterval: number;
      };
    };
  };
  
  // Features Configuration
  features: {
    websocket: {
      enabled: boolean;
      heartbeatInterval: number;
      maxConnections: number;
    };
    stratum: {
      version: 'v1' | 'v2';
      difficultyAdjustment: {
        enabled: boolean;
        interval: number;
        targetTime: number;
        retargetAlgorithm: 'simple' | 'kimoto' | 'dgw';
      };
      subscriptionTimeout: number;
      jobTimeout: number;
    };
    payments: {
      enabled: boolean;
      method: 'pplns' | 'pps' | 'prop';
      interval: number;
      minimumPayout: number;
      transactionFee: number;
      batchSize: number;
      confirmations: number;
    };
    backup: {
      enabled: boolean;
      interval: number;
      retention: number;
      compression: boolean;
      encryption: {
        enabled: boolean;
        algorithm: string;
        key?: string;
      };
      storage: {
        local: {
          enabled: boolean;
          path: string;
        };
        s3: {
          enabled: boolean;
          bucket: string;
          region: string;
          accessKeyId?: string;
          secretAccessKey?: string;
        };
      };
    };
  };
  
  // Development Configuration
  development?: {
    mockBitcoinNode: boolean;
    enableDebugRoutes: boolean;
    hotReload: boolean;
    verboseLogging: boolean;
    skipAuthentication: boolean;
  };
}

export interface ConfigValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Environment-aware Configuration Manager
 * Loads and validates configuration with environment-specific overrides
 */
export class ConfigurationManager {
  private logger = new Logger('ConfigManager');
  private config?: PoolConfig;
  private environment: Environment;
  private configPath: string;
  
  constructor(environment?: Environment, configPath?: string) {
    this.environment = environment || this.detectEnvironment();
    this.configPath = configPath || this.getDefaultConfigPath();
  }
  
  /**
   * Load configuration for current environment
   */
  async loadConfiguration(): Promise<PoolConfig> {
    try {
      // Load base configuration
      const baseConfig = await this.loadBaseConfig();
      
      // Load environment-specific overrides
      const envConfig = await this.loadEnvironmentConfig();
      
      // Merge configurations
      this.config = this.mergeConfigs(baseConfig, envConfig);
      
      // Load environment variables overrides
      this.applyEnvironmentVariables();
      
      // Validate configuration
      const validation = this.validateConfiguration();
      if (!validation.isValid) {
        throw new Error(`Configuration validation failed: ${validation.errors.join(', ')}`);
      }
      
      // Log warnings
      if (validation.warnings.length > 0) {
        validation.warnings.forEach(warning => this.logger.warn(warning));
      }
      
      this.logger.info('Configuration loaded successfully', {
        environment: this.environment,
        features: this.getEnabledFeatures()
      });
      
      return this.config;
      
    } catch (error) {
      this.logger.error('Failed to load configuration:', error as Error);
      throw error;
    }
  }
  
  /**
   * Get current configuration
   */
  getConfiguration(): PoolConfig {
    if (!this.config) {
      throw new Error('Configuration not loaded. Call loadConfiguration() first.');
    }
    return this.config;
  }
  
  /**
   * Get configuration for specific section
   */
  getSection<T extends keyof PoolConfig>(section: T): PoolConfig[T] {
    return this.getConfiguration()[section];
  }
  
  /**
   * Detect current environment
   */
  private detectEnvironment(): Environment {
    const env = process.env.NODE_ENV?.toLowerCase();
    
    switch (env) {
      case 'development':
      case 'dev':
        return 'development';
      case 'staging':
      case 'stage':
        return 'staging';
      case 'production':
      case 'prod':
        return 'production';
      case 'test':
        return 'test';
      default:
        this.logger.warn(`Unknown environment '${env}', defaulting to development`);
        return 'development';
    }
  }
  
  /**
   * Get default configuration path
   */
  private getDefaultConfigPath(): string {
    return path.join(process.cwd(), 'config');
  }
  
  /**
   * Load base configuration
   */
  private async loadBaseConfig(): Promise<PoolConfig> {
    const configFile = path.join(this.configPath, 'base.json');
    
    if (!fs.existsSync(configFile)) {
      this.logger.warn(`Base config file not found: ${configFile}, using defaults`);
      return this.getDefaultConfiguration();
    }
    
    try {
      const content = fs.readFileSync(configFile, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      this.logger.error(`Failed to parse base config: ${error}`);
      return this.getDefaultConfiguration();
    }
  }
  
  /**
   * Load environment-specific configuration
   */
  private async loadEnvironmentConfig(): Promise<Partial<PoolConfig>> {
    const configFile = path.join(this.configPath, `${this.environment}.json`);
    
    if (!fs.existsSync(configFile)) {
      this.logger.debug(`Environment config file not found: ${configFile}`);
      return {};
    }
    
    try {
      const content = fs.readFileSync(configFile, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      this.logger.error(`Failed to parse environment config: ${error}`);
      return {};
    }
  }
  
  /**
   * Get default configuration
   */
  private getDefaultConfiguration(): PoolConfig {
    return {
      pool: {
        address: process.env.POOL_ADDRESS || '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
        fee: parseFloat(process.env.POOL_FEE || '1.0'),
        name: process.env.POOL_NAME || 'Otedama Pool',
        description: 'A professional Bitcoin mining pool',
        website: 'https://otedama-pool.com',
        supportEmail: 'support@otedama-pool.com'
      },
      
      network: {
        stratumPort: parseInt(process.env.STRATUM_PORT || '3333'),
        apiPort: parseInt(process.env.API_PORT || '8080'),
        dashboardPort: parseInt(process.env.DASHBOARD_PORT || '8081'),
        metricsPort: parseInt(process.env.METRICS_PORT || '9090'),
        enableIPv6: process.env.ENABLE_IPV6 === 'true',
        bindAddress: process.env.BIND_ADDRESS || '0.0.0.0'
      },
      
      bitcoin: {
        rpcUrl: process.env.RPC_URL || 'http://localhost:8332',
        rpcUser: process.env.RPC_USER || 'bitcoin',
        rpcPassword: process.env.RPC_PASSWORD || 'password',
        rpcTimeout: parseInt(process.env.RPC_TIMEOUT || '30000'),
        rpcRetryCount: parseInt(process.env.RPC_RETRY_COUNT || '3'),
        rpcRetryDelay: parseInt(process.env.RPC_RETRY_DELAY || '1000'),
        network: (process.env.BITCOIN_NETWORK as any) || 'mainnet'
      },
      
      database: {
        type: (process.env.DB_TYPE as any) || 'sqlite',
        sqlite: {
          filename: process.env.SQLITE_FILENAME || 'pool.db',
          options: {}
        }
      },
      
      redis: {
        enabled: process.env.REDIS_ENABLED === 'true',
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        database: parseInt(process.env.REDIS_DATABASE || '0'),
        maxRetries: parseInt(process.env.REDIS_MAX_RETRIES || '3'),
        retryDelayOnFailover: parseInt(process.env.REDIS_RETRY_DELAY || '100'),
        enableReadyCheck: true,
        lazyConnect: true
      },
      
      security: {
        ssl: {
          enabled: process.env.SSL_ENABLED === 'true'
        },
        auth: {
          enabled: process.env.AUTH_ENABLED !== 'false',
          tokenExpiry: parseInt(process.env.TOKEN_EXPIRY || '3600'),
          refreshTokenExpiry: parseInt(process.env.REFRESH_TOKEN_EXPIRY || '86400'),
          jwtSecret: process.env.JWT_SECRET || 'change-me-in-production',
          bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12')
        },
        ddos: {
          enabled: process.env.DDOS_PROTECTION !== 'false',
          maxConnections: parseInt(process.env.MAX_CONNECTIONS || '10000'),
          maxConnectionsPerIP: parseInt(process.env.MAX_CONNECTIONS_PER_IP || '100'),
          rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'),
          rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100'),
          banDuration: parseInt(process.env.BAN_DURATION || '300000')
        },
        cors: {
          enabled: process.env.CORS_ENABLED !== 'false',
          origins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : '*',
          credentials: process.env.CORS_CREDENTIALS === 'true',
          optionsSuccessStatus: 200
        },
        headers: {
          enableSecurityHeaders: process.env.SECURITY_HEADERS_ENABLED !== 'false',
          hsts: {
            enabled: process.env.HSTS_ENABLED === 'true',
            maxAge: parseInt(process.env.HSTS_MAX_AGE || '31536000'),
            includeSubDomains: process.env.HSTS_INCLUDE_SUBDOMAINS === 'true',
            preload: process.env.HSTS_PRELOAD === 'true'
          },
          csp: process.env.CSP_POLICY || null,
          frameOptions: process.env.FRAME_OPTIONS || 'DENY'
        }
      },
      
      performance: {
        clustering: {
          enabled: process.env.CLUSTERING_ENABLED === 'true',
          workers: process.env.CLUSTER_WORKERS === 'auto' ? 'auto' : parseInt(process.env.CLUSTER_WORKERS || '1'),
          respawnDelay: parseInt(process.env.CLUSTER_RESPAWN_DELAY || '5000')
        },
        parallelValidation: {
          enabled: process.env.PARALLEL_VALIDATION_ENABLED === 'true',
          workers: parseInt(process.env.PARALLEL_WORKERS || '4'),
          batchSize: parseInt(process.env.VALIDATION_BATCH_SIZE || '100')
        },
        memoryOptimization: {
          enabled: process.env.MEMORY_OPTIMIZATION_ENABLED === 'true',
          poolSize: parseInt(process.env.MEMORY_POOL_SIZE || '10000'),
          gcInterval: parseInt(process.env.GC_INTERVAL || '60000')
        },
        cpuAffinity: {
          enabled: process.env.CPU_AFFINITY_ENABLED === 'true'
        },
        caching: {
          shareCache: {
            enabled: process.env.SHARE_CACHE_ENABLED === 'true',
            maxSize: parseInt(process.env.SHARE_CACHE_SIZE || '100000'),
            ttl: parseInt(process.env.SHARE_CACHE_TTL || '3600000')
          },
          minerCache: {
            enabled: process.env.MINER_CACHE_ENABLED === 'true',
            maxSize: parseInt(process.env.MINER_CACHE_SIZE || '10000'),
            ttl: parseInt(process.env.MINER_CACHE_TTL || '300000')
          }
        }
      },
      
      monitoring: {
        enabled: process.env.MONITORING_ENABLED !== 'false',
        prometheus: {
          enabled: process.env.PROMETHEUS_ENABLED === 'true',
          port: parseInt(process.env.PROMETHEUS_PORT || '9090'),
          path: process.env.PROMETHEUS_PATH || '/metrics',
          collectDefaultMetrics: process.env.PROMETHEUS_DEFAULT_METRICS !== 'false'
        },
        grafana: {
          enabled: process.env.GRAFANA_ENABLED === 'true'
        },
        alerts: {
          enabled: process.env.ALERTS_ENABLED === 'true'
        },
        logging: {
          level: (process.env.LOG_LEVEL as any) || 'info',
          format: (process.env.LOG_FORMAT as any) || 'json',
          outputs: [
            {
              type: 'console',
              config: {}
            }
          ],
          aggregation: {
            enabled: process.env.LOG_AGGREGATION_ENABLED === 'true',
            bufferSize: parseInt(process.env.LOG_BUFFER_SIZE || '1000'),
            flushInterval: parseInt(process.env.LOG_FLUSH_INTERVAL || '5000')
          }
        }
      },
      
      features: {
        websocket: {
          enabled: process.env.WEBSOCKET_ENABLED === 'true',
          heartbeatInterval: parseInt(process.env.WEBSOCKET_HEARTBEAT || '30000'),
          maxConnections: parseInt(process.env.WEBSOCKET_MAX_CONNECTIONS || '1000')
        },
        stratum: {
          version: (process.env.STRATUM_VERSION as any) || 'v1',
          difficultyAdjustment: {
            enabled: process.env.DIFFICULTY_ADJUSTMENT_ENABLED !== 'false',
            interval: parseInt(process.env.DIFFICULTY_ADJUSTMENT_INTERVAL || '60000'),
            targetTime: parseInt(process.env.DIFFICULTY_TARGET_TIME || '30000'),
            retargetAlgorithm: (process.env.RETARGET_ALGORITHM as any) || 'simple'
          },
          subscriptionTimeout: parseInt(process.env.STRATUM_SUBSCRIPTION_TIMEOUT || '60000'),
          jobTimeout: parseInt(process.env.STRATUM_JOB_TIMEOUT || '120000')
        },
        payments: {
          enabled: process.env.PAYMENTS_ENABLED === 'true',
          method: (process.env.PAYMENT_METHOD as any) || 'pplns',
          interval: parseInt(process.env.PAYMENT_INTERVAL || '3600000'),
          minimumPayout: parseFloat(process.env.MINIMUM_PAYOUT || '0.001'),
          transactionFee: parseFloat(process.env.TRANSACTION_FEE || '0.0001'),
          batchSize: parseInt(process.env.PAYMENT_BATCH_SIZE || '50'),
          confirmations: parseInt(process.env.PAYMENT_CONFIRMATIONS || '6')
        },
        backup: {
          enabled: process.env.BACKUP_ENABLED === 'true',
          interval: parseInt(process.env.BACKUP_INTERVAL || '86400000'),
          retention: parseInt(process.env.BACKUP_RETENTION || '2592000000'),
          compression: process.env.BACKUP_COMPRESSION !== 'false',
          encryption: {
            enabled: process.env.BACKUP_ENCRYPTION_ENABLED === 'true',
            algorithm: process.env.BACKUP_ENCRYPTION_ALGORITHM || 'aes-256-gcm'
          },
          storage: {
            local: {
              enabled: process.env.BACKUP_LOCAL_ENABLED !== 'false',
              path: process.env.BACKUP_LOCAL_PATH || './backups'
            },
            s3: {
              enabled: process.env.BACKUP_S3_ENABLED === 'true',
              bucket: process.env.BACKUP_S3_BUCKET || '',
              region: process.env.BACKUP_S3_REGION || 'us-east-1'
            }
          }
        }
      }
    };
  }
  
  /**
   * Merge configurations with deep merge
   */
  private mergeConfigs(base: PoolConfig, override: Partial<PoolConfig>): PoolConfig {
    return this.deepMerge(base, override);
  }
  
  /**
   * Deep merge objects
   */
  private deepMerge(target: any, source: any): any {
    const result = { ...target };
    
    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          result[key] = this.deepMerge(target[key] || {}, source[key]);
        } else {
          result[key] = source[key];
        }
      }
    }
    
    return result;
  }
  
  /**
   * Apply environment variable overrides
   */
  private applyEnvironmentVariables(): void {
    if (!this.config) return;
    
    // Apply specific environment variable overrides
    // This is already done in getDefaultConfiguration, but can be extended
  }
  
  /**
   * Validate configuration
   */
  private validateConfiguration(): ConfigValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    if (!this.config) {
      errors.push('Configuration is null or undefined');
      return { isValid: false, errors, warnings };
    }
    
    // Validate pool address
    if (!this.config.pool.address || !this.isValidBitcoinAddress(this.config.pool.address)) {
      errors.push('Invalid or missing pool Bitcoin address');
    }
    
    // Validate fee
    if (this.config.pool.fee < 0 || this.config.pool.fee > 10) {
      errors.push('Pool fee must be between 0 and 10 percent');
    }
    
    // Validate ports
    const ports = [
      this.config.network.stratumPort,
      this.config.network.apiPort,
      this.config.network.dashboardPort,
      this.config.network.metricsPort
    ];
    
    for (const port of ports) {
      if (port < 1 || port > 65535) {
        errors.push(`Invalid port number: ${port}`);
      }
    }
    
    // Check for port conflicts
    const uniquePorts = new Set(ports);
    if (uniquePorts.size !== ports.length) {
      errors.push('Port conflicts detected');
    }
    
    // Validate JWT secret in production
    if (this.environment === 'production' && this.config.security.auth.jwtSecret === 'change-me-in-production') {
      errors.push('JWT secret must be changed in production');
    }
    
    // Validate SSL configuration in production
    if (this.environment === 'production' && !this.config.security.ssl.enabled) {
      warnings.push('SSL should be enabled in production');
    }
    
    // Validate database configuration
    if (this.config.database.type === 'postgres' && !this.config.database.postgres) {
      errors.push('PostgreSQL configuration is required when database type is postgres');
    }
    
    // Validate Redis configuration
    if (this.config.redis.enabled && !this.config.redis.host) {
      errors.push('Redis host is required when Redis is enabled');
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
  
  /**
   * Validate Bitcoin address format
   */
  private isValidBitcoinAddress(address: string): boolean {
    // Basic Bitcoin address validation
    const p2pkhRegex = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
    const bech32Regex = /^bc1[a-z0-9]{39,59}$/;
    
    return p2pkhRegex.test(address) || bech32Regex.test(address);
  }
  
  /**
   * Get list of enabled features
   */
  private getEnabledFeatures(): string[] {
    if (!this.config) return [];
    
    const features: string[] = [];
    
    if (this.config.features.websocket.enabled) features.push('websocket');
    if (this.config.features.payments.enabled) features.push('payments');
    if (this.config.features.backup.enabled) features.push('backup');
    if (this.config.performance.parallelValidation.enabled) features.push('parallel_validation');
    if (this.config.security.ddos.enabled) features.push('ddos_protection');
    if (this.config.redis.enabled) features.push('redis');
    if (this.config.monitoring.prometheus.enabled) features.push('prometheus');
    
    return features;
  }
  
  /**
   * Watch for configuration changes
   */
  watchConfiguration(callback: (config: PoolConfig) => void): void {
    const configFile = path.join(this.configPath, `${this.environment}.json`);
    
    if (fs.existsSync(configFile)) {
      fs.watchFile(configFile, { interval: 1000 }, async () => {
        try {
          this.logger.info('Configuration file changed, reloading...');
          const newConfig = await this.loadConfiguration();
          callback(newConfig);
        } catch (error) {
          this.logger.error('Failed to reload configuration:', error as Error);
        }
      });
    }
  }
  
  /**
   * Export configuration to file
   */
  async exportConfiguration(outputPath: string): Promise<void> {
    if (!this.config) {
      throw new Error('No configuration loaded');
    }
    
    const configJson = JSON.stringify(this.config, null, 2);
    fs.writeFileSync(outputPath, configJson, 'utf8');
    
    this.logger.info(`Configuration exported to: ${outputPath}`);
  }
}

/**
 * Factory function for creating configuration manager
 */
export function createConfigurationManager(environment?: Environment, configPath?: string): ConfigurationManager {
  return new ConfigurationManager(environment, configPath);
}

/**
 * Global configuration instance
 */
export let globalConfig: ConfigurationManager;

/**
 * Initialize global configuration
 */
export async function initializeGlobalConfig(environment?: Environment, configPath?: string): Promise<PoolConfig> {
  globalConfig = createConfigurationManager(environment, configPath);
  return await globalConfig.loadConfiguration();
}

/**
 * Get global configuration
 */
export function getGlobalConfig(): PoolConfig {
  if (!globalConfig) {
    throw new Error('Global configuration not initialized. Call initializeGlobalConfig() first.');
  }
  return globalConfig.getConfiguration();
}
