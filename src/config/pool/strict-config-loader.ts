// Type-safe configuration loader with strict validation
// Ensures all configuration values are properly typed and validated

import * as dotenv from 'dotenv';
import { ICompletePoolConfig } from './config-loader';
import { 
  Result, 
  ok, 
  err, 
  isNumber, 
  isString, 
  isBoolean,
  assertDefined,
  assert
} from '../../types/guards';
import { ConfigurationError, ValidationError } from '../../errors/enhanced-errors';

// Load environment variables
dotenv.config();

/**
 * Environment variable parser with type safety
 */
export class EnvParser {
  private env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  /**
   * Get string value
   */
  getString(key: string, defaultValue?: string): Result<string> {
    const value = this.env[key];
    
    if (value === undefined) {
      if (defaultValue !== undefined) {
        return ok(defaultValue);
      }
      return err(new ConfigurationError(`Missing required environment variable: ${key}`, key));
    }

    if (!isString(value) || value.trim() === '') {
      return err(new ValidationError(`Invalid string value for ${key}`, key, value));
    }

    return ok(value.trim());
  }

  /**
   * Get required string value
   */
  getRequiredString(key: string): Result<string> {
    const result = this.getString(key);
    if (!result.success) {
      return result;
    }
    
    if (result.value === '') {
      return err(new ValidationError(`Empty value for required variable ${key}`, key));
    }
    
    return result;
  }

  /**
   * Get integer value
   */
  getInt(key: string, defaultValue?: number): Result<number> {
    const strResult = this.getString(key);
    
    if (!strResult.success) {
      if (defaultValue !== undefined) {
        return ok(defaultValue);
      }
      return strResult;
    }

    const value = parseInt(strResult.value, 10);
    
    if (!isNumber(value)) {
      return err(new ValidationError(`Invalid integer value for ${key}`, key, strResult.value));
    }

    return ok(value);
  }

  /**
   * Get float value
   */
  getFloat(key: string, defaultValue?: number): Result<number> {
    const strResult = this.getString(key);
    
    if (!strResult.success) {
      if (defaultValue !== undefined) {
        return ok(defaultValue);
      }
      return strResult;
    }

    const value = parseFloat(strResult.value);
    
    if (!isNumber(value)) {
      return err(new ValidationError(`Invalid float value for ${key}`, key, strResult.value));
    }

    return ok(value);
  }

  /**
   * Get boolean value
   */
  getBoolean(key: string, defaultValue?: boolean): Result<boolean> {
    const strResult = this.getString(key);
    
    if (!strResult.success) {
      if (defaultValue !== undefined) {
        return ok(defaultValue);
      }
      return strResult;
    }

    const value = strResult.value.toLowerCase();
    
    if (value === 'true' || value === '1' || value === 'yes' || value === 'on') {
      return ok(true);
    }
    
    if (value === 'false' || value === '0' || value === 'no' || value === 'off') {
      return ok(false);
    }

    return err(new ValidationError(`Invalid boolean value for ${key}`, key, strResult.value));
  }

  /**
   * Get array value
   */
  getArray(key: string, separator: string = ',', defaultValue?: string[]): Result<string[]> {
    const strResult = this.getString(key);
    
    if (!strResult.success) {
      if (defaultValue !== undefined) {
        return ok(defaultValue);
      }
      return strResult;
    }

    if (strResult.value === '') {
      return ok([]);
    }

    const values = strResult.value
      .split(separator)
      .map(v => v.trim())
      .filter(v => v !== '');

    return ok(values);
  }

  /**
   * Get enum value
   */
  getEnum<T extends string>(
    key: string,
    validValues: readonly T[],
    defaultValue?: T
  ): Result<T> {
    const strResult = this.getString(key);
    
    if (!strResult.success) {
      if (defaultValue !== undefined) {
        return ok(defaultValue);
      }
      return strResult;
    }

    const value = strResult.value as T;
    
    if (!validValues.includes(value)) {
      return err(new ValidationError(
        `Invalid enum value for ${key}. Must be one of: ${validValues.join(', ')}`,
        key,
        value
      ));
    }

    return ok(value);
  }

  /**
   * Get port number with validation
   */
  getPort(key: string, defaultValue?: number): Result<number> {
    const result = this.getInt(key, defaultValue);
    
    if (!result.success) {
      return result;
    }

    if (result.value < 1 || result.value > 65535) {
      return err(new ValidationError(
        `Invalid port number for ${key}. Must be between 1 and 65535`,
        key,
        result.value
      ));
    }

    return result;
  }

  /**
   * Get URL with validation
   */
  getUrl(key: string, defaultValue?: string): Result<string> {
    const result = this.getString(key, defaultValue);
    
    if (!result.success) {
      return result;
    }

    try {
      new URL(result.value);
      return result;
    } catch {
      return err(new ValidationError(`Invalid URL for ${key}`, key, result.value));
    }
  }
}

/**
 * Strict configuration loader
 */
export class StrictConfigLoader {
  private parser: EnvParser;
  private errors: Error[] = [];

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.parser = new EnvParser(env);
  }

  /**
   * Load configuration with strict validation
   */
  load(): Result<ICompletePoolConfig> {
    const config: Partial<ICompletePoolConfig> = {};
    
    // Core settings
    this.setOrError(config, 'poolAddress', this.parser.getRequiredString('POOL_ADDRESS'));
    this.setOrError(config, 'rpcUrl', this.parser.getUrl('RPC_URL', 'http://localhost:8332'));
    this.setOrError(config, 'rpcUser', this.parser.getString('RPC_USER', 'user'));
    this.setOrError(config, 'rpcPassword', this.parser.getString('RPC_PASSWORD', 'password'));
    
    // Network settings
    this.setOrError(config, 'stratumPort', this.parser.getPort('STRATUM_PORT', 3333));
    this.setOrError(config, 'additionalPorts', this.parsePortArray('ADDITIONAL_PORTS', '3334,3335'));
    this.setOrError(config, 'wsPort', this.parser.getPort('WS_PORT', 8080));
    this.setOrError(config, 'apiPort', this.parser.getPort('API_PORT', 4000));
    this.setOrError(config, 'dashboardPort', this.parser.getPort('DASHBOARD_PORT', 8081));
    this.setOrError(config, 'metricsPort', this.parser.getPort('METRICS_PORT', 9090));
    
    // Redis settings
    this.setOrError(config, 'redisEnabled', this.parser.getBoolean('REDIS_ENABLED', false));
    this.setOrError(config, 'redisUrl', this.parser.getUrl('REDIS_URL', 'redis://localhost:6379'));
    
    // Feature flags
    this.setOrError(config, 'enableBackups', this.parser.getBoolean('BACKUP_ENABLED', true));
    this.setOrError(config, 'enableGeographic', this.parser.getBoolean('GEOGRAPHIC_ENABLED', false));
    this.setOrError(config, 'enableSmartPool', this.parser.getBoolean('SMART_POOL_ENABLED', false));
    this.setOrError(config, 'enableWebSocket', this.parser.getBoolean('WEBSOCKET_ENABLED', true));
    this.setOrError(config, 'enableMobileAPI', this.parser.getBoolean('MOBILE_API_ENABLED', true));
    this.setOrError(config, 'enableMergeMining', this.parser.getBoolean('MERGE_MINING_ENABLED', false));
    this.setOrError(config, 'enableStratumV2', this.parser.getBoolean('STRATUM_V2_ENABLED', false));
    this.setOrError(config, 'enableBinaryProtocol', this.parser.getBoolean('BINARY_PROTOCOL_ENABLED', false));
    
    // Performance settings
    this.setOrError(config, 'enableCPUAffinity', this.parser.getBoolean('CPU_AFFINITY_ENABLED', false));
    this.setOrError(config, 'enableMemoryAlignment', this.parser.getBoolean('MEMORY_ALIGNMENT_ENABLED', false));
    
    // Payment settings
    this.setOrError(config, 'paymentInterval', this.parsePaymentInterval());
    this.setOrError(config, 'minPayout', this.parseMinPayout());
    this.setOrError(config, 'feePercent', this.parseFeePercent());
    
    // Security settings
    this.setOrError(config, 'enableIPWhitelist', this.parser.getBoolean('IP_WHITELIST_ENABLED', false));
    this.setOrError(config, 'ipWhitelist', this.parseIPWhitelist());
    
    // Backup settings
    this.setOrError(config, 'backupInterval', this.parseBackupInterval());
    this.setOrError(config, 'backupDir', this.parser.getString('BACKUP_DIR', './backups'));
    
    // Algorithm settings
    this.setOrError(config, 'algorithms', this.parseAlgorithms());
    this.setOrError(config, 'defaultAlgorithm', this.parser.getString('DEFAULT_ALGORITHM', 'sha256'));
    
    // Auto-scaling settings
    this.setOrError(config, 'autoScalingEnabled', this.parser.getBoolean('AUTO_SCALING_ENABLED', false));
    this.setOrError(config, 'cloudProvider', this.parser.getEnum('CLOUD_PROVIDER', ['aws', 'local'] as const, 'local'));
    this.setOrError(config, 'minInstances', this.parser.getInt('MIN_INSTANCES', 1));
    this.setOrError(config, 'maxInstances', this.parser.getInt('MAX_INSTANCES', 10));
    this.setOrError(config, 'targetCpuUtilization', this.parser.getInt('TARGET_CPU', 70));
    this.setOrError(config, 'targetMemoryUtilization', this.parser.getInt('TARGET_MEMORY', 80));
    
    // Event streaming settings
    this.setOrError(config, 'eventStreamingBackend', this.parser.getEnum('EVENT_STREAMING_BACKEND', ['local', 'kafka'] as const, 'local'));
    this.setOrError(config, 'kafkaBrokers', this.parser.getArray('KAFKA_BROKERS'));
    this.setOrError(config, 'kafkaClientId', this.parser.getString('KAFKA_CLIENT_ID', 'otedama-pool'));
    this.setOrError(config, 'kafkaSsl', this.parser.getBoolean('KAFKA_SSL', false));
    this.setOrError(config, 'kafkaSaslUsername', this.parser.getString('KAFKA_SASL_USERNAME'));
    this.setOrError(config, 'kafkaSaslPassword', this.parser.getString('KAFKA_SASL_PASSWORD'));
    
    // Alert settings
    this.setOrError(config, 'discordWebhook', this.parser.getString('DISCORD_WEBHOOK'));
    this.setOrError(config, 'telegramToken', this.parser.getString('TELEGRAM_TOKEN'));
    this.setOrError(config, 'telegramChatId', this.parser.getString('TELEGRAM_CHAT_ID'));
    
    // AWS settings
    this.setOrError(config, 'awsRegion', this.parser.getString('AWS_REGION', 'us-east-1'));
    this.setOrError(config, 'awsAutoScalingGroup', this.parser.getString('AWS_AUTO_SCALING_GROUP'));
    this.setOrError(config, 'awsInstanceType', this.parser.getString('AWS_INSTANCE_TYPE', 't3.medium'));
    
    // Check for errors
    if (this.errors.length > 0) {
      return err(new ConfigurationError(
        `Configuration validation failed with ${this.errors.length} errors`,
        undefined,
        undefined,
        { errors: this.errors.map(e => e.message) }
      ));
    }
    
    // Validate complete configuration
    const validationResult = this.validateConfig(config as ICompletePoolConfig);
    if (!validationResult.success) {
      return validationResult;
    }
    
    return ok(config as ICompletePoolConfig);
  }

  /**
   * Set value or collect error
   */
  private setOrError<K extends keyof ICompletePoolConfig>(
    config: Partial<ICompletePoolConfig>,
    key: K,
    result: Result<ICompletePoolConfig[K]>
  ): void {
    if (result.success) {
      config[key] = result.value;
    } else {
      this.errors.push(result.error);
    }
  }

  /**
   * Parse port array
   */
  private parsePortArray(key: string, defaultValue: string): Result<number[]> {
    const arrayResult = this.parser.getArray(key, ',', defaultValue.split(','));
    
    if (!arrayResult.success) {
      return arrayResult;
    }

    const ports: number[] = [];
    
    for (const portStr of arrayResult.value) {
      const port = parseInt(portStr, 10);
      
      if (!isNumber(port) || port < 1 || port > 65535) {
        return err(new ValidationError(
          `Invalid port number in ${key}: ${portStr}`,
          key,
          portStr
        ));
      }
      
      ports.push(port);
    }

    return ok(ports);
  }

  /**
   * Parse payment interval
   */
  private parsePaymentInterval(): Result<number> {
    const result = this.parser.getInt('PAYMENT_INTERVAL', 3600);
    
    if (!result.success) {
      return result;
    }

    if (result.value < 60) {
      return err(new ValidationError(
        'Payment interval must be at least 60 seconds',
        'PAYMENT_INTERVAL',
        result.value
      ));
    }

    return result;
  }

  /**
   * Parse minimum payout
   */
  private parseMinPayout(): Result<number> {
    const result = this.parser.getFloat('MIN_PAYOUT', 0.001);
    
    if (!result.success) {
      return result;
    }

    if (result.value <= 0) {
      return err(new ValidationError(
        'Minimum payout must be greater than 0',
        'MIN_PAYOUT',
        result.value
      ));
    }

    return result;
  }

  /**
   * Parse fee percent
   */
  private parseFeePercent(): Result<number> {
    const result = this.parser.getFloat('POOL_FEE_PERCENT', 1);
    
    if (!result.success) {
      return result;
    }

    if (result.value < 0 || result.value > 100) {
      return err(new ValidationError(
        'Fee percent must be between 0 and 100',
        'POOL_FEE_PERCENT',
        result.value
      ));
    }

    return result;
  }

  /**
   * Parse IP whitelist
   */
  private parseIPWhitelist(): Result<string[]> {
    const result = this.parser.getArray('IP_WHITELIST', ',', []);
    
    if (!result.success) {
      return result;
    }

    // Basic IP validation
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    
    for (const ip of result.value) {
      if (!ipRegex.test(ip)) {
        return err(new ValidationError(
          `Invalid IP address in whitelist: ${ip}`,
          'IP_WHITELIST',
          ip
        ));
      }
    }

    return result;
  }

  /**
   * Parse backup interval
   */
  private parseBackupInterval(): Result<number> {
    const hoursResult = this.parser.getInt('BACKUP_INTERVAL_HOURS', 24);
    
    if (!hoursResult.success) {
      return hoursResult;
    }

    if (hoursResult.value < 1) {
      return err(new ValidationError(
        'Backup interval must be at least 1 hour',
        'BACKUP_INTERVAL_HOURS',
        hoursResult.value
      ));
    }

    return ok(hoursResult.value * 3600 * 1000); // Convert to milliseconds
  }

  /**
   * Parse supported algorithms
   */
  private parseAlgorithms(): Result<string[]> {
    const result = this.parser.getArray('SUPPORTED_ALGORITHMS', ',', ['sha256']);
    
    if (!result.success) {
      return result;
    }

    if (result.value.length === 0) {
      return err(new ValidationError(
        'At least one algorithm must be supported',
        'SUPPORTED_ALGORITHMS',
        result.value
      ));
    }

    return result;
  }

  /**
   * Validate complete configuration
   */
  private validateConfig(config: ICompletePoolConfig): Result<ICompletePoolConfig> {
    // Check port conflicts
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
      return err(new ConfigurationError('Duplicate ports detected in configuration'));
    }

    // Validate algorithm configuration
    if (!config.algorithms.includes(config.defaultAlgorithm)) {
      return err(new ConfigurationError(
        'Default algorithm must be in the list of supported algorithms',
        'defaultAlgorithm',
        config.defaultAlgorithm
      ));
    }

    // Validate auto-scaling configuration
    if (config.autoScalingEnabled) {
      if (config.minInstances > config.maxInstances) {
        return err(new ConfigurationError('Min instances cannot be greater than max instances'));
      }

      if (config.cloudProvider === 'aws' && !config.awsAutoScalingGroup) {
        return err(new ConfigurationError('AWS_AUTO_SCALING_GROUP is required when using AWS auto-scaling'));
      }
    }

    // Validate event streaming configuration
    if (config.eventStreamingBackend === 'kafka') {
      if (!config.kafkaBrokers || config.kafkaBrokers.length === 0) {
        return err(new ConfigurationError('KAFKA_BROKERS is required when using Kafka backend'));
      }

      if (config.kafkaSaslUsername && !config.kafkaSaslPassword) {
        return err(new ConfigurationError('KAFKA_SASL_PASSWORD is required when KAFKA_SASL_USERNAME is set'));
      }
    }

    return ok(config);
  }
}

/**
 * Load configuration with strict type checking
 */
export function loadStrictConfig(): Result<ICompletePoolConfig> {
  const loader = new StrictConfigLoader();
  return loader.load();
}
