/**
 * 環境別設定システム
 * dev/staging/prodの設定管理と環境変数処理
import { DDoSProtectionConfig, ShareThrottlerConfig, SynFloodConfig, defaultSecurityConfig } from './security';
 */

import { DDoSProtectionConfig, ShareThrottlerConfig, SynFloodConfig, defaultSecurityConfig } from './security';
import * as fs from 'fs';
import * as path from 'path';

export type BlockchainType = 'bitcoin' | 'ethereum' | 'litecoin' | 'dogecoin' | 'dummy';

export interface P2PConfig {
  enabled: boolean;
  bootstrapPeers: string[];
  listenAddresses: string[];
}

export interface BlockchainConfig {
  type: BlockchainType;
  rpcUrl: string;
  rpcUser?: string;
  rpcPassword?: string;
}

export type Environment = 'development' | 'staging' | 'production' | 'test';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  poolSize: number;
  timeout: number;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  database: number;
  keyPrefix: string;
  ttl: number;
}

export interface ServerConfig {
  apiPort: number;
  stratumPort: number;
  host: string;
  workers: number;
  timeout: number;
  keepAlive: boolean;
  cors: boolean;
}

export interface SecurityConfig {
  jwtSecret: string;
  jwtExpiration: string;
  bcryptRounds: number;
  enableHttps: boolean;
  tlsCert?: string;
  tlsKey?: string;
  ddosProtection: DDoSProtectionConfig;
  shareThrottler: ShareThrottlerConfig;
  synFlood: SynFloodConfig;
}

export interface PoolConfig {
  address: string;
  fee: number;
  minPayout: number;
  maxPayout: number;
  payoutInterval: number;
  blockConfirmations: number;
  difficulty: number;
  retargetTime: number;
}

export interface ELKConfig {
  enabled: boolean;
  logstashHost: string;
  logstashPort: number;
  elasticsearchUrl: string;
  kibanaUrl: string;
  index: string;
  type: string;
}

export interface LoggingConfig {
  level: 'error' | 'warn' | 'info' | 'debug';
  format: 'json' | 'text';
  file: boolean;
  filePath: string;
  maxSize: string;
  maxFiles: number;
  console: boolean;
  elk: ELKConfig;
}

export interface MonitoringConfig {
  enabled: boolean;
  metricsPort: number;
  healthCheckInterval: number;
  alerting: boolean;
  webhookUrl?: string;
}

export interface AppConfig {
  environment: Environment;
  database: DatabaseConfig;
  redis: RedisConfig;
  server: ServerConfig;
  security: SecurityConfig;
  pool: PoolConfig;
  logging: LoggingConfig;
  monitoring: MonitoringConfig;
  p2p: P2PConfig;
  blockchain: BlockchainConfig;
}

export class ConfigManager {
  private static instance: ConfigManager;
  private config: AppConfig;
  private environment: Environment;

  private constructor() {
    this.environment = this.detectEnvironment();
    this.config = this.loadConfiguration();
    this.validateConfiguration();
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * 環境検出
   */
  private detectEnvironment(): Environment {
        const env = (process.env['NODE_ENV'] || 'development').toLowerCase();
    
    if (!['development', 'staging', 'production', 'test'].includes(env)) {
      console.warn(`[Config] Unknown environment '${env}', defaulting to 'development'`);
      return 'development';
    }
    
    return env as Environment;
  }

  /**
   * 設定読み込み
   */
  private loadConfiguration(): AppConfig {
    // デフォルト設定
    const defaultConfig = this.getDefaultConfig();
    
    // 環境別設定ファイル読み込み
    const envConfig = this.loadEnvironmentConfig();
    
    // 環境変数でオーバーライド
    const envVarConfig = this.loadEnvironmentVariables();
    
    // 設定をマージ（優先度: 環境変数 > 環境別ファイル > デフォルト）
    const config = this.mergeConfigs(defaultConfig, envConfig, envVarConfig);
    
    console.log(`[Config] Loaded configuration for environment: ${this.environment}`);
    return config;
  }

  /**
   * デフォルト設定
   */
  private getDefaultConfig(): AppConfig {
    return {
      environment: this.environment,
      
      database: {
        host: 'localhost',
        port: 5432,
        database: 'otedama',
        username: 'otedama',
        password: 'password',
        ssl: false,
        poolSize: 10,
        timeout: 30000
      },
      
      redis: {
        host: 'localhost',
        port: 6379,
        database: 0,
        keyPrefix: 'otedama:',
        ttl: 3600
      },
      
      server: {
        apiPort: 3000,
        stratumPort: 3333,
        host: '0.0.0.0',
        workers: 1,
        timeout: 30000,
        keepAlive: true,
        cors: true
      },
      
      security: {
        jwtSecret: 'your-super-secret-key-change-me',
        jwtExpiration: '1h',
        bcryptRounds: 10,
        enableHttps: false,
        ...defaultSecurityConfig,
      },
      
      pool: {
        address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
        fee: 2.0,
        minPayout: 0.001,
        maxPayout: 10.0,
        payoutInterval: 3600000, // 1時間
        blockConfirmations: 6,
        difficulty: 1,
        retargetTime: 600000 // 10分
      },
      
      logging: {
        level: 'info',
        format: 'text',
        file: true,
        filePath: './logs/app.log',
        maxSize: '10m',
        maxFiles: 5,
        console: true,
        elk: {
          enabled: false,
          logstashHost: 'logstash',
          logstashPort: 5000,
          elasticsearchUrl: 'http://otedama-elasticsearch-es-http:9200',
          kibanaUrl: 'http://otedama-kibana-kb-http:5601',
          index: 'otedama-pool-logs',
          type: 'pool-log'
        }
      },
      
      monitoring: {
        enabled: true,
        metricsPort: 9090,
        healthCheckInterval: 30000,
        alerting: false
      },

      p2p: {
        enabled: true,
        bootstrapPeers: [],
        listenAddresses: ['/ip4/0.0.0.0/tcp/0']
      },

      blockchain: {
        type: 'dummy',
        rpcUrl: 'http://127.0.0.1:18443',
        rpcUser: 'user',
        rpcPassword: 'password'
      }
    };
  }

  /**
   * 環境別設定ファイル読み込み
   */
  private loadEnvironmentConfig(): Partial<AppConfig> {
    const configPaths = [
      path.join(process.cwd(), 'config', `${this.environment}.json`),
      path.join(process.cwd(), `config.${this.environment}.json`),
      path.join(__dirname, '..', '..', 'config', `${this.environment}.json`)
    ];

    for (const configPath of configPaths) {
      try {
        if (fs.existsSync(configPath)) {
          const configData = fs.readFileSync(configPath, 'utf8');
          const config = JSON.parse(configData);
          console.log(`[Config] Loaded environment config from: ${configPath}`);
          return config;
        }
      } catch (error) {
        console.warn(`[Config] Failed to load config from ${configPath}:`, error);
      }
    }

    console.log(`[Config] No environment config file found for: ${this.environment}`);
    return {};
  }

  /**
   * 環境変数から設定読み込み
   */
    private loadEnvironmentVariables(): Partial<AppConfig> {
    const envConfig: any = {};

    // データベース
    if (process.env['DATABASE_URL']) {
      const url = new URL(process.env['DATABASE_URL']);
      envConfig.database = {
        host: url.hostname,
        port: parseInt(url.port) || 5432,
        database: url.pathname.slice(1),
        username: url.username,
        password: url.password,
        ssl: url.searchParams.get('sslmode') === 'require'
      };
    } else {
      envConfig.database = {};
      if (process.env['DB_HOST']) envConfig.database.host = process.env['DB_HOST'];
      if (process.env['DB_PORT']) envConfig.database.port = parseInt(process.env['DB_PORT']);
      if (process.env['DB_NAME']) envConfig.database.database = process.env['DB_NAME'];
      if (process.env['DB_USER']) envConfig.database.username = process.env['DB_USER'];
      if (process.env['DB_PASSWORD']) envConfig.database.password = process.env['DB_PASSWORD'];
      if (process.env['DB_SSL']) envConfig.database.ssl = process.env['DB_SSL'] === 'true';
    }

    // Redis
    if (process.env['REDIS_URL']) {
      const url = new URL(process.env['REDIS_URL']);
      envConfig.redis = {
        host: url.hostname,
        port: parseInt(url.port) || 6379,
        password: url.password || undefined,
        database: parseInt(url.pathname.slice(1)) || 0
      };
    } else {
      envConfig.redis = {};
      if (process.env['REDIS_HOST']) envConfig.redis.host = process.env['REDIS_HOST'];
      if (process.env['REDIS_PORT']) envConfig.redis.port = parseInt(process.env['REDIS_PORT']);
      if (process.env['REDIS_PASSWORD']) envConfig.redis.password = process.env['REDIS_PASSWORD'];
    }

    // サーバー
    envConfig.server = {};
    if (process.env['PORT']) envConfig.server.apiPort = parseInt(process.env['PORT']);
    if (process.env['API_PORT']) envConfig.server.apiPort = parseInt(process.env['API_PORT']);
    if (process.env['STRATUM_PORT']) envConfig.server.stratumPort = parseInt(process.env['STRATUM_PORT']);
    if (process.env['HOST']) envConfig.server.host = process.env['HOST'];
    if (process.env['WORKERS']) envConfig.server.workers = parseInt(process.env['WORKERS']);

    // セキュリティ
    envConfig.security = {};
    if (process.env['JWT_SECRET']) envConfig.security.jwtSecret = process.env['JWT_SECRET'];
    if (process.env['JWT_EXPIRATION']) envConfig.security.jwtExpiration = process.env['JWT_EXPIRATION'];
    if (process.env['BCRYPT_ROUNDS']) envConfig.security.bcryptRounds = parseInt(process.env['BCRYPT_ROUNDS']);
    if (process.env['ENABLE_HTTPS']) envConfig.security.enableHttps = process.env['ENABLE_HTTPS'] === 'true';
    if (process.env['TLS_CERT']) envConfig.security.tlsCert = process.env['TLS_CERT'];
    if (process.env['TLS_KEY']) envConfig.security.tlsKey = process.env['TLS_KEY'];

    // プール
    envConfig.pool = {};
    if (process.env['POOL_ADDRESS']) envConfig.pool.address = process.env['POOL_ADDRESS'];
    if (process.env['POOL_FEE']) envConfig.pool.fee = parseFloat(process.env['POOL_FEE']);
    if (process.env['MIN_PAYOUT']) envConfig.pool.minPayout = parseFloat(process.env['MIN_PAYOUT']);
    if (process.env['MAX_PAYOUT']) envConfig.pool.maxPayout = parseFloat(process.env['MAX_PAYOUT']);

    // ログ
    envConfig.logging = {};
    if (process.env['LOG_LEVEL']) envConfig.logging.level = process.env['LOG_LEVEL'] as any;
    if (process.env['LOG_FORMAT']) envConfig.logging.format = process.env['LOG_FORMAT'] as any;
    if (process.env['LOG_FILE']) envConfig.logging.file = process.env['LOG_FILE'] === 'true';
    
    // ELK設定
    envConfig.logging.elk = {};
    if (process.env['ELK_ENABLED']) envConfig.logging.elk.enabled = process.env['ELK_ENABLED'] === 'true';
    if (process.env['LOGSTASH_HOST']) envConfig.logging.elk.logstashHost = process.env['LOGSTASH_HOST'];
    if (process.env['LOGSTASH_PORT']) envConfig.logging.elk.logstashPort = parseInt(process.env['LOGSTASH_PORT']);
    if (process.env['ELASTICSEARCH_URL']) envConfig.logging.elk.elasticsearchUrl = process.env['ELASTICSEARCH_URL'];
    if (process.env['KIBANA_URL']) envConfig.logging.elk.kibanaUrl = process.env['KIBANA_URL'];
    if (process.env['ELK_INDEX']) envConfig.logging.elk.index = process.env['ELK_INDEX'];
    if (process.env['ELK_TYPE']) envConfig.logging.elk.type = process.env['ELK_TYPE'];

    // 監視
    envConfig.monitoring = {};
    if (process.env['MONITORING_ENABLED']) envConfig.monitoring.enabled = process.env['MONITORING_ENABLED'] === 'true';
    if (process.env['METRICS_PORT']) envConfig.monitoring.metricsPort = parseInt(process.env['METRICS_PORT']);
    if (process.env['WEBHOOK_URL']) envConfig.monitoring.webhookUrl = process.env['WEBHOOK_URL'];

    // P2P
    envConfig.p2p = {};
    if (process.env['P2P_ENABLED']) envConfig.p2p.enabled = process.env['P2P_ENABLED'] === 'true';
    if (process.env['P2P_BOOTSTRAP_PEERS']) envConfig.p2p.bootstrapPeers = process.env['P2P_BOOTSTRAP_PEERS'].split(',');

    // Blockchain
    envConfig.blockchain = {};
    if (process.env['BLOCKCHAIN_TYPE']) envConfig.blockchain.type = process.env['BLOCKCHAIN_TYPE'] as any;
    if (process.env['RPC_URL']) envConfig.blockchain.rpcUrl = process.env['RPC_URL'];
    if (process.env['RPC_USER']) envConfig.blockchain.rpcUser = process.env['RPC_USER'];
    if (process.env['RPC_PASSWORD']) envConfig.blockchain.rpcPassword = process.env['RPC_PASSWORD'];

    return envConfig;
  }

  /**
   * 設定をマージ
   */
  private mergeConfigs(...configs: Partial<AppConfig>[]): AppConfig {
    const result: any = {};
    
    for (const config of configs) {
      for (const [key, value] of Object.entries(config)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          result[key] = { ...result[key], ...value };
        } else if (value !== undefined) {
          result[key] = value;
        }
      }
    }
    
    return result as AppConfig;
  }

  /**
   * 設定検証
   */
  private validateConfiguration(): void {
    const errors: string[] = [];

    // 必須設定チェック
    if (!this.config.database.host) {
      errors.push('Database host is required');
    }

    if (!this.config.pool.address) {
      errors.push('Pool address is required');
    }

    if (this.config.environment === 'production') {
      if (this.config.security.jwtSecret === 'your-secret-key-change-in-production') {
        errors.push('JWT secret must be changed in production');
      }
      
      if (!this.config.security.enableHttps) {
        console.warn('[Config] HTTPS is disabled in production environment');
      }
    }

    // ポート競合チェック
    if (this.config.server.apiPort === this.config.server.stratumPort) {
      errors.push('API port and Stratum port cannot be the same');
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }

    console.log('[Config] Configuration validation passed');
  }

  /**
   * 設定取得
   */
  public get(): AppConfig {
    return { ...this.config }; // 不変性のためコピーを返す
  }

  /**
   * 特定セクションの設定取得
   */
  public getDatabase(): DatabaseConfig {
    return { ...this.config.database };
  }

  public getRedis(): RedisConfig {
    return { ...this.config.redis };
  }

  public getServer(): ServerConfig {
    return { ...this.config.server };
  }

  public getSecurity(): SecurityConfig {
    return { ...this.config.security };
  }

  public getPool(): PoolConfig {
    return { ...this.config.pool };
  }

  public getLogging(): LoggingConfig {
    return { ...this.config.logging };
  }

  public getMonitoring(): MonitoringConfig {
    return { ...this.config.monitoring };
  }

  /**
   * 環境取得
   */
  public getEnvironment(): Environment {
    return this.environment;
  }

  /**
   * 開発環境チェック
   */
  public isDevelopment(): boolean {
    return this.environment === 'development';
  }

  /**
   * 本番環境チェック
   */
  public isProduction(): boolean {
    return this.environment === 'production';
  }

  /**
   * テスト環境チェック
   */
  public isTest(): boolean {
    return this.environment === 'test';
  }

  /**
   * 設定の安全な表示（秘密情報をマスク）
   */
  public getSafeConfig(): any {
    const safeConfig = JSON.parse(JSON.stringify(this.config));
    
    // 秘密情報をマスク
    if (safeConfig.database?.password) {
      safeConfig.database.password = '***';
    }
    if (safeConfig.redis?.password) {
      safeConfig.redis.password = '***';
    }
    if (safeConfig.security?.jwtSecret) {
      safeConfig.security.jwtSecret = '***';
    }
    
    return safeConfig;
  }

  /**
   * 設定を環境変数として出力（デバッグ用）
   */
  public exportAsEnvVars(): string[] {
    const envVars: string[] = [];
    
    envVars.push(`NODE_ENV=${this.config.environment}`);
    envVars.push(`DB_HOST=${this.config.database.host}`);
    envVars.push(`DB_PORT=${this.config.database.port}`);
    envVars.push(`DB_NAME=${this.config.database.database}`);
    envVars.push(`API_PORT=${this.config.server.apiPort}`);
    envVars.push(`STRATUM_PORT=${this.config.server.stratumPort}`);
    envVars.push(`POOL_ADDRESS=${this.config.pool.address}`);
    envVars.push(`POOL_FEE=${this.config.pool.fee}`);
    envVars.push(`LOG_LEVEL=${this.config.logging.level}`);
    
    return envVars;
  }
}

// シングルトンインスタンス
export const config = ConfigManager.getInstance();

export default ConfigManager;