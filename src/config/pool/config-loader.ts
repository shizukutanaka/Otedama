// Pool configuration management module
// Following Rob Pike's principle: "Configuration should be simple and straightforward"

import * as dotenv from 'dotenv';
import { IPoolConfig } from '../../interfaces';

// Load environment variables
dotenv.config();

/**
 * Pool configuration with type safety and validation
 */
export interface ICompletePoolConfig extends IPoolConfig {
  // Network settings
  additionalPorts: number[];
  wsPort: number;
  apiPort: number;
  dashboardPort: number;
  metricsPort: number;
  
  // Redis settings
  redisEnabled: boolean;
  redisUrl: string;
  
  // Feature flags
  enableBackups: boolean;
  enableGeographic: boolean;
  enableSmartPool: boolean;
  enableWebSocket: boolean;
  enableMobileAPI: boolean;
  enableMergeMining: boolean;
  enableStratumV2: boolean;
  enableBinaryProtocol: boolean;
  
  // Performance settings
  enableCPUAffinity: boolean;
  enableMemoryAlignment: boolean;
  
  // Payment settings
  paymentInterval: number;
  minPayout: number;
  feePercent: number;
  
  // Security settings
  enableIPWhitelist: boolean;
  ipWhitelist: string[];
  
  // Backup settings
  backupInterval: number;
  backupDir: string;
  
  // Algorithm settings
  algorithms: string[];
  defaultAlgorithm: string;
  
  // Auto-scaling settings
  autoScalingEnabled: boolean;
  cloudProvider?: 'aws' | 'local';
  minInstances?: number;
  maxInstances?: number;
  targetCpuUtilization?: number;
  targetMemoryUtilization?: number;
  
  // Event streaming settings
  eventStreamingBackend: 'local' | 'kafka';
  kafkaBrokers?: string[];
  kafkaClientId?: string;
  kafkaSsl?: boolean;
  kafkaSaslUsername?: string;
  kafkaSaslPassword?: string;
  
  // Alert settings
  discordWebhook?: string;
  telegramToken?: string;
  telegramChatId?: string;
  
  // AWS settings (if using AWS)
  awsRegion?: string;
  awsAutoScalingGroup?: string;
  awsInstanceType?: string;
}

/**
 * Configuration loader with validation
 */
export class ConfigLoader {
  static load(): ICompletePoolConfig {
    const config: ICompletePoolConfig = {
      // Core settings
      poolAddress: process.env.POOL_ADDRESS || '',
      rpcUrl: process.env.RPC_URL || 'http://localhost:8332',
      rpcUser: process.env.RPC_USER || 'user',
      rpcPassword: process.env.RPC_PASSWORD || 'password',
      
      // Network settings
      stratumPort: parseInt(process.env.STRATUM_PORT || '3333'),
      additionalPorts: (process.env.ADDITIONAL_PORTS || '3334,3335')
        .split(',')
        .filter(p => p.trim())
        .map(p => parseInt(p)),
      wsPort: parseInt(process.env.WS_PORT || '8080'),
      apiPort: parseInt(process.env.API_PORT || '4000'),
      dashboardPort: parseInt(process.env.DASHBOARD_PORT || '8081'),
      metricsPort: parseInt(process.env.METRICS_PORT || '9090'),
      
      // Redis settings
      redisEnabled: process.env.REDIS_ENABLED === 'true',
      redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
      
      // Feature flags
      enableBackups: process.env.BACKUP_ENABLED !== 'false',
      enableGeographic: process.env.GEOGRAPHIC_ENABLED === 'true',
      enableSmartPool: process.env.SMART_POOL_ENABLED === 'true',
      enableWebSocket: process.env.WEBSOCKET_ENABLED !== 'false',
      enableMobileAPI: process.env.MOBILE_API_ENABLED !== 'false',
      enableMergeMining: process.env.MERGE_MINING_ENABLED === 'true',
      enableStratumV2: process.env.STRATUM_V2_ENABLED === 'true',
      enableBinaryProtocol: process.env.BINARY_PROTOCOL_ENABLED === 'true',
      
      // Performance settings
      enableCPUAffinity: process.env.CPU_AFFINITY_ENABLED === 'true',
      enableMemoryAlignment: process.env.MEMORY_ALIGNMENT_ENABLED === 'true',
      
      // Payment settings
      paymentInterval: parseInt(process.env.PAYMENT_INTERVAL || '3600'),
      minPayout: parseFloat(process.env.MIN_PAYOUT || '0.001'),
      feePercent: parseFloat(process.env.POOL_FEE_PERCENT || '1'),
      
      // Security settings
      enableIPWhitelist: process.env.IP_WHITELIST_ENABLED === 'true',
      ipWhitelist: (process.env.IP_WHITELIST || '')
        .split(',')
        .filter(ip => ip.trim()),
      
      // Backup settings
      backupInterval: parseInt(process.env.BACKUP_INTERVAL_HOURS || '24') * 3600 * 1000,
      backupDir: process.env.BACKUP_DIR || './backups',
      
      // Algorithm settings
      algorithms: (process.env.SUPPORTED_ALGORITHMS || 'sha256')
        .split(',')
        .filter(a => a.trim()),
      defaultAlgorithm: process.env.DEFAULT_ALGORITHM || 'sha256',
      
      // Auto-scaling settings
      autoScalingEnabled: process.env.AUTO_SCALING_ENABLED === 'true',
      cloudProvider: process.env.CLOUD_PROVIDER as 'aws' | 'local' || 'local',
      minInstances: parseInt(process.env.MIN_INSTANCES || '1'),
      maxInstances: parseInt(process.env.MAX_INSTANCES || '10'),
      targetCpuUtilization: parseInt(process.env.TARGET_CPU || '70'),
      targetMemoryUtilization: parseInt(process.env.TARGET_MEMORY || '80'),
      
      // Event streaming settings
      eventStreamingBackend: process.env.EVENT_STREAMING_BACKEND as 'local' | 'kafka' || 'local',
      kafkaBrokers: process.env.KAFKA_BROKERS?.split(',').filter(b => b.trim()),
      kafkaClientId: process.env.KAFKA_CLIENT_ID || 'otedama-pool',
      kafkaSsl: process.env.KAFKA_SSL === 'true',
      kafkaSaslUsername: process.env.KAFKA_SASL_USERNAME,
      kafkaSaslPassword: process.env.KAFKA_SASL_PASSWORD,
      
      // Alert settings
      discordWebhook: process.env.DISCORD_WEBHOOK,
      telegramToken: process.env.TELEGRAM_TOKEN,
      telegramChatId: process.env.TELEGRAM_CHAT_ID,
      
      // AWS settings
      awsRegion: process.env.AWS_REGION || 'us-east-1',
      awsAutoScalingGroup: process.env.AWS_AUTO_SCALING_GROUP,
      awsInstanceType: process.env.AWS_INSTANCE_TYPE || 't3.medium',
    };
    
    return config;
  }
  
  static validate(config: ICompletePoolConfig): void {
    // Required fields
    if (!config.poolAddress) {
      throw new Error('POOL_ADDRESS is required in .env file');
    }
    
    // Redis validation
    if (config.redisEnabled && !config.redisUrl) {
      throw new Error('REDIS_URL is required when Redis is enabled');
    }
    
    // Port validation
    const ports = [
      config.stratumPort,
      ...config.additionalPorts,
      config.wsPort,
      config.apiPort,
      config.dashboardPort,
      config.metricsPort
    ];
    
    const uniquePorts = new Set(ports);
    if (uniquePorts.size !== ports.length) {
      throw new Error('Duplicate ports detected in configuration');
    }
    
    // Payment validation
    if (config.paymentInterval < 60) {
      throw new Error('Payment interval must be at least 60 seconds');
    }
    
    if (config.minPayout <= 0) {
      throw new Error('Minimum payout must be greater than 0');
    }
    
    if (config.feePercent < 0 || config.feePercent > 100) {
      throw new Error('Fee percent must be between 0 and 100');
    }
    
    // Algorithm validation
    if (config.algorithms.length === 0) {
      throw new Error('At least one algorithm must be supported');
    }
    
    if (!config.algorithms.includes(config.defaultAlgorithm)) {
      throw new Error('Default algorithm must be in the list of supported algorithms');
    }
    
    // Auto-scaling validation
    if (config.autoScalingEnabled) {
      if (config.cloudProvider === 'aws' && !config.awsAutoScalingGroup) {
        throw new Error('AWS_AUTO_SCALING_GROUP is required when using AWS auto-scaling');
      }
      
      if (config.minInstances! > config.maxInstances!) {
        throw new Error('Min instances cannot be greater than max instances');
      }
    }
    
    // Event streaming validation
    if (config.eventStreamingBackend === 'kafka') {
      if (!config.kafkaBrokers || config.kafkaBrokers.length === 0) {
        throw new Error('KAFKA_BROKERS is required when using Kafka backend');
      }
      
      if (config.kafkaSaslUsername && !config.kafkaSaslPassword) {
        throw new Error('KAFKA_SASL_PASSWORD is required when KAFKA_SASL_USERNAME is set');
      }
    }
  }
  
  /**
   * Get environment-specific configuration
   */
  static getEnvironment(): 'development' | 'staging' | 'production' {
    const env = process.env.NODE_ENV || 'development';
    
    if (!['development', 'staging', 'production'].includes(env)) {
      throw new Error(`Invalid NODE_ENV: ${env}`);
    }
    
    return env as 'development' | 'staging' | 'production';
  }
  
  /**
   * Load and validate configuration
   */
  static loadAndValidate(): ICompletePoolConfig {
    const config = ConfigLoader.load();
    ConfigLoader.validate(config);
    return config;
  }
}

/**
 * Configuration with environment-specific overrides
 */
export class EnvironmentConfig {
  static getOverrides(env: 'development' | 'staging' | 'production'): Partial<ICompletePoolConfig> {
    switch (env) {
      case 'development':
        return {
          enableBackups: false,
          enableIPWhitelist: false,
          paymentInterval: 300, // 5 minutes for testing
          minPayout: 0.0001, // Lower for testing
        };
      
      case 'staging':
        return {
          paymentInterval: 1800, // 30 minutes
          minPayout: 0.0005,
        };
      
      case 'production':
        return {
          enableBackups: true,
          enableIPWhitelist: true,
          paymentInterval: 3600, // 1 hour
          minPayout: 0.001,
        };
      
      default:
        return {};
    }
  }
  
  static apply(config: ICompletePoolConfig): ICompletePoolConfig {
    const env = ConfigLoader.getEnvironment();
    const overrides = EnvironmentConfig.getOverrides(env);
    
    return {
      ...config,
      ...overrides
    };
  }
}

// Export configuration instance
export const poolConfig = EnvironmentConfig.apply(ConfigLoader.loadAndValidate());
