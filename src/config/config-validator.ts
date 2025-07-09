/**
 * Configuration validation and management
 * Following Clean Code principles: fail fast, clear errors
 */

import * as fs from 'fs';
import * as path from 'path';
import { ConfigurationError, ValidationError } from '../errors/pool-errors';

export interface PoolConfiguration {
  // Server settings
  server: {
    stratumPort: number;
    apiPort?: number;
    p2pPort: number;
    host?: string;
  };

  // Blockchain settings
  blockchain: {
    type: 'bitcoin' | 'ethereum' | 'litecoin' | 'dogecoin';
    rpcUrl: string;
    rpcUser?: string;
    rpcPassword?: string;
    testnet?: boolean;
  };

  // Pool settings
  pool: {
    address: string;
    fee: number;
    minPayout: number;
    payoutFee: number;
    paymentScheme: 'PPLNS' | 'PPS' | 'FPPS' | 'PROP';
    pplnsWindow?: number;
    payoutInterval: number;
  };

  // Mining settings
  mining: {
    algorithm: string;
    startDifficulty: number;
    minDifficulty: number;
    maxDifficulty: number;
    targetTime: number;
    variancePercent: number;
    retargetInterval: number;
  };

  // P2P settings
  p2p: {
    enabled: boolean;
    bootstrapNodes?: string[];
    maxPeers: number;
    announceAddress?: string;
  };

  // Security settings
  security: {
    requireAuth: boolean;
    allowAnonymous: boolean;
    ssl?: {
      enabled: boolean;
      certPath?: string;
      keyPath?: string;
    };
    rateLimit: {
      enabled: boolean;
      profile: 'small' | 'medium' | 'large' | 'custom';
      custom?: any;
    };
  };

  // Database settings
  database: {
    type: 'sqlite' | 'postgresql' | 'mysql';
    path?: string;
    connectionString?: string;
    pool?: {
      min: number;
      max: number;
    };
  };

  // Logging settings
  logging: {
    level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
    console: boolean;
    file: boolean;
    filePath?: string;
    maxFileSize?: number;
    maxFiles?: number;
  };

  // Monitoring settings
  monitoring: {
    enabled: boolean;
    metricsPort?: number;
    healthCheckInterval?: number;
  };
}

export class ConfigValidator {
  private errors: string[] = [];
  private warnings: string[] = [];

  validate(config: any): PoolConfiguration {
    this.errors = [];
    this.warnings = [];

    // Validate and transform config
    const validated: PoolConfiguration = {
      server: this.validateServer(config.server),
      blockchain: this.validateBlockchain(config.blockchain),
      pool: this.validatePool(config.pool),
      mining: this.validateMining(config.mining),
      p2p: this.validateP2P(config.p2p),
      security: this.validateSecurity(config.security),
      database: this.validateDatabase(config.database),
      logging: this.validateLogging(config.logging),
      monitoring: this.validateMonitoring(config.monitoring)
    };

    // Check for errors
    if (this.errors.length > 0) {
      throw new ConfigurationError(
        `Configuration validation failed:\n${this.errors.join('\n')}`,
        'validation',
        { errors: this.errors, warnings: this.warnings }
      );
    }

    // Log warnings
    if (this.warnings.length > 0) {
      console.warn('Configuration warnings:', this.warnings);
    }

    return validated;
  }

  private validateServer(server: any): PoolConfiguration['server'] {
    if (!server) {
      this.errors.push('Server configuration is required');
      return { stratumPort: 3333, p2pPort: 4333 };
    }

    const validated = {
      stratumPort: this.validatePort(server.stratumPort, 'stratumPort', 3333),
      apiPort: server.apiPort ? this.validatePort(server.apiPort, 'apiPort') : undefined,
      p2pPort: this.validatePort(server.p2pPort, 'p2pPort', 4333),
      host: server.host || '0.0.0.0'
    };

    // Check for port conflicts
    const ports = [validated.stratumPort, validated.p2pPort];
    if (validated.apiPort) ports.push(validated.apiPort);
    
    const uniquePorts = new Set(ports);
    if (uniquePorts.size !== ports.length) {
      this.errors.push('Server ports must be unique');
    }

    return validated;
  }

  private validateBlockchain(blockchain: any): PoolConfiguration['blockchain'] {
    if (!blockchain) {
      this.errors.push('Blockchain configuration is required');
      return { type: 'bitcoin', rpcUrl: '' };
    }

    const validTypes = ['bitcoin', 'ethereum', 'litecoin', 'dogecoin'];
    if (!validTypes.includes(blockchain.type)) {
      this.errors.push(`Invalid blockchain type. Must be one of: ${validTypes.join(', ')}`);
    }

    if (!blockchain.rpcUrl) {
      this.errors.push('Blockchain RPC URL is required');
    } else if (!this.isValidUrl(blockchain.rpcUrl)) {
      this.errors.push('Invalid RPC URL format');
    }

    // Warn about missing auth for Bitcoin-based chains
    if (['bitcoin', 'litecoin', 'dogecoin'].includes(blockchain.type)) {
      if (!blockchain.rpcUser || !blockchain.rpcPassword) {
        this.warnings.push('RPC authentication recommended for Bitcoin-based chains');
      }
    }

    return {
      type: blockchain.type || 'bitcoin',
      rpcUrl: blockchain.rpcUrl || '',
      rpcUser: blockchain.rpcUser,
      rpcPassword: blockchain.rpcPassword,
      testnet: blockchain.testnet || false
    };
  }

  private validatePool(pool: any): PoolConfiguration['pool'] {
    if (!pool) {
      this.errors.push('Pool configuration is required');
      return {
        address: '',
        fee: 1,
        minPayout: 0.01,
        payoutFee: 0.0001,
        paymentScheme: 'PPLNS',
        payoutInterval: 3600
      };
    }

    if (!pool.address) {
      this.errors.push('Pool wallet address is required');
    } else if (!this.isValidAddress(pool.address)) {
      this.warnings.push('Pool address format may be invalid');
    }

    const fee = this.validateNumber(pool.fee, 'pool.fee', 0, 100, 1);
    if (fee > 5) {
      this.warnings.push('Pool fee is higher than typical (>5%)');
    }

    const validSchemes = ['PPLNS', 'PPS', 'FPPS', 'PROP'];
    if (pool.paymentScheme && !validSchemes.includes(pool.paymentScheme)) {
      this.errors.push(`Invalid payment scheme. Must be one of: ${validSchemes.join(', ')}`);
    }

    const validated = {
      address: pool.address || '',
      fee: fee,
      minPayout: this.validateNumber(pool.minPayout, 'pool.minPayout', 0, 1000, 0.01),
      payoutFee: this.validateNumber(pool.payoutFee, 'pool.payoutFee', 0, 1, 0.0001),
      paymentScheme: pool.paymentScheme || 'PPLNS',
      pplnsWindow: pool.pplnsWindow,
      payoutInterval: this.validateNumber(pool.payoutInterval, 'pool.payoutInterval', 60, 86400, 3600)
    };

    if (validated.paymentScheme === 'PPLNS' && !validated.pplnsWindow) {
      validated.pplnsWindow = 100000; // Default PPLNS window
    }

    return validated as PoolConfiguration['pool'];
  }

  private validateMining(mining: any): PoolConfiguration['mining'] {
    const defaults = {
      algorithm: 'sha256d',
      startDifficulty: 1,
      minDifficulty: 0.001,
      maxDifficulty: 1000000,
      targetTime: 10,
      variancePercent: 30,
      retargetInterval: 60
    };

    if (!mining) {
      this.warnings.push('Using default mining configuration');
      return defaults;
    }

    const validated = {
      algorithm: mining.algorithm || defaults.algorithm,
      startDifficulty: this.validateNumber(
        mining.startDifficulty, 'mining.startDifficulty',
        0.00001, 1000000, defaults.startDifficulty
      ),
      minDifficulty: this.validateNumber(
        mining.minDifficulty, 'mining.minDifficulty',
        0.00001, 1000, defaults.minDifficulty
      ),
      maxDifficulty: this.validateNumber(
        mining.maxDifficulty, 'mining.maxDifficulty',
        1, 10000000000, defaults.maxDifficulty
      ),
      targetTime: this.validateNumber(
        mining.targetTime, 'mining.targetTime',
        1, 300, defaults.targetTime
      ),
      variancePercent: this.validateNumber(
        mining.variancePercent, 'mining.variancePercent',
        5, 90, defaults.variancePercent
      ),
      retargetInterval: this.validateNumber(
        mining.retargetInterval, 'mining.retargetInterval',
        10, 3600, defaults.retargetInterval
      )
    };

    if (validated.minDifficulty >= validated.maxDifficulty) {
      this.errors.push('Mining min difficulty must be less than max difficulty');
    }

    return validated;
  }

  private validateP2P(p2p: any): PoolConfiguration['p2p'] {
    const defaults = {
      enabled: false,
      maxPeers: 50
    };

    if (!p2p) {
      return defaults;
    }

    const validated = {
      enabled: p2p.enabled || false,
      bootstrapNodes: p2p.bootstrapNodes,
      maxPeers: this.validateNumber(p2p.maxPeers, 'p2p.maxPeers', 1, 1000, 50),
      announceAddress: p2p.announceAddress
    };

    if (validated.enabled && (!validated.bootstrapNodes || validated.bootstrapNodes.length === 0)) {
      this.warnings.push('P2P enabled but no bootstrap nodes configured');
    }

    return validated;
  }

  private validateSecurity(security: any): PoolConfiguration['security'] {
    const defaults = {
      requireAuth: false,
      allowAnonymous: true,
      rateLimit: {
        enabled: true,
        profile: 'medium' as const
      }
    };

    if (!security) {
      this.warnings.push('Using default security configuration');
      return defaults;
    }

    const validated: PoolConfiguration['security'] = {
      requireAuth: security.requireAuth || false,
      allowAnonymous: security.allowAnonymous !== false,
      rateLimit: {
        enabled: security.rateLimit?.enabled !== false,
        profile: security.rateLimit?.profile || 'medium',
        custom: security.rateLimit?.custom
      }
    };

    // Validate SSL if enabled
    if (security.ssl?.enabled) {
      if (!security.ssl.certPath || !security.ssl.keyPath) {
        this.errors.push('SSL cert and key paths required when SSL is enabled');
      } else {
        if (!fs.existsSync(security.ssl.certPath)) {
          this.errors.push(`SSL certificate file not found: ${security.ssl.certPath}`);
        }
        if (!fs.existsSync(security.ssl.keyPath)) {
          this.errors.push(`SSL key file not found: ${security.ssl.keyPath}`);
        }
      }
      
      validated.ssl = {
        enabled: true,
        certPath: security.ssl.certPath,
        keyPath: security.ssl.keyPath
      };
    }

    // Validate auth settings
    if (validated.requireAuth && validated.allowAnonymous) {
      this.warnings.push('Auth required but anonymous mining allowed - this may not be intended');
    }

    return validated;
  }

  private validateDatabase(database: any): PoolConfiguration['database'] {
    const defaults = {
      type: 'sqlite' as const,
      path: path.join(process.cwd(), 'data', 'pool.db')
    };

    if (!database) {
      return defaults;
    }

    const validTypes = ['sqlite', 'postgresql', 'mysql'];
    if (!validTypes.includes(database.type)) {
      this.errors.push(`Invalid database type. Must be one of: ${validTypes.join(', ')}`);
    }

    const validated: PoolConfiguration['database'] = {
      type: database.type || 'sqlite'
    };

    if (validated.type === 'sqlite') {
      validated.path = database.path || defaults.path;
    } else {
      if (!database.connectionString) {
        this.errors.push(`Database connection string required for ${validated.type}`);
      }
      validated.connectionString = database.connectionString;
      
      if (database.pool) {
        validated.pool = {
          min: this.validateNumber(database.pool.min, 'database.pool.min', 1, 100, 2),
          max: this.validateNumber(database.pool.max, 'database.pool.max', 1, 100, 10)
        };
        
        if (validated.pool.min > validated.pool.max) {
          this.errors.push('Database pool min must be less than or equal to max');
        }
      }
    }

    return validated;
  }

  private validateLogging(logging: any): PoolConfiguration['logging'] {
    const defaults = {
      level: 'info' as const,
      console: true,
      file: true,
      filePath: path.join(process.cwd(), 'logs', 'pool.log'),
      maxFileSize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5
    };

    if (!logging) {
      return defaults;
    }

    const validLevels = ['error', 'warn', 'info', 'debug', 'trace'];
    if (logging.level && !validLevels.includes(logging.level)) {
      this.errors.push(`Invalid log level. Must be one of: ${validLevels.join(', ')}`);
    }

    return {
      level: logging.level || defaults.level,
      console: logging.console !== false,
      file: logging.file !== false,
      filePath: logging.filePath || defaults.filePath,
      maxFileSize: this.validateNumber(
        logging.maxFileSize, 'logging.maxFileSize',
        1024 * 1024, 1024 * 1024 * 1024, defaults.maxFileSize
      ),
      maxFiles: this.validateNumber(
        logging.maxFiles, 'logging.maxFiles',
        1, 100, defaults.maxFiles
      )
    };
  }

  private validateMonitoring(monitoring: any): PoolConfiguration['monitoring'] {
    const defaults = {
      enabled: true,
      metricsPort: 9090,
      healthCheckInterval: 30000
    };

    if (!monitoring) {
      return defaults;
    }

    return {
      enabled: monitoring.enabled !== false,
      metricsPort: monitoring.metricsPort ? 
        this.validatePort(monitoring.metricsPort, 'monitoring.metricsPort') : 
        defaults.metricsPort,
      healthCheckInterval: this.validateNumber(
        monitoring.healthCheckInterval, 'monitoring.healthCheckInterval',
        1000, 300000, defaults.healthCheckInterval
      )
    };
  }

  // Helper methods
  private validatePort(port: any, name: string, defaultValue?: number): number {
    const parsed = parseInt(port);
    
    if (isNaN(parsed)) {
      if (defaultValue !== undefined) {
        this.warnings.push(`Invalid ${name}, using default: ${defaultValue}`);
        return defaultValue;
      }
      this.errors.push(`${name} must be a valid port number`);
      return 3333;
    }

    if (parsed < 1 || parsed > 65535) {
      this.errors.push(`${name} must be between 1 and 65535`);
      return defaultValue || 3333;
    }

    return parsed;
  }

  private validateNumber(
    value: any,
    name: string,
    min: number,
    max: number,
    defaultValue: number
  ): number {
    const parsed = parseFloat(value);

    if (isNaN(parsed)) {
      this.warnings.push(`Invalid ${name}, using default: ${defaultValue}`);
      return defaultValue;
    }

    if (parsed < min || parsed > max) {
      this.warnings.push(`${name} should be between ${min} and ${max}, got ${parsed}`);
      return Math.max(min, Math.min(max, parsed));
    }

    return parsed;
  }

  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  private isValidAddress(address: string): boolean {
    // Basic validation - in production, use proper validation for each coin
    return /^[a-zA-Z0-9]{20,}$/.test(address);
  }
}

// Configuration loader
export class ConfigLoader {
  static async load(configPath?: string): Promise<PoolConfiguration> {
    const validator = new ConfigValidator();

    // Load from file if provided
    if (configPath) {
      if (!fs.existsSync(configPath)) {
        throw new ConfigurationError(`Configuration file not found: ${configPath}`);
      }

      const configText = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configText);
      return validator.validate(config);
    }

    // Load from environment variables
    const config = this.loadFromEnv();
    return validator.validate(config);
  }

  private static loadFromEnv(): any {
    return {
      server: {
        stratumPort: process.env.STRATUM_PORT,
        apiPort: process.env.API_PORT,
        p2pPort: process.env.P2P_PORT,
        host: process.env.SERVER_HOST
      },
      blockchain: {
        type: process.env.BLOCKCHAIN_TYPE,
        rpcUrl: process.env.RPC_URL,
        rpcUser: process.env.RPC_USER,
        rpcPassword: process.env.RPC_PASSWORD,
        testnet: process.env.TESTNET === 'true'
      },
      pool: {
        address: process.env.POOL_ADDRESS,
        fee: process.env.POOL_FEE,
        minPayout: process.env.MIN_PAYOUT,
        payoutFee: process.env.PAYOUT_FEE,
        paymentScheme: process.env.PAYMENT_SCHEME,
        pplnsWindow: process.env.PPLNS_WINDOW,
        payoutInterval: process.env.PAYOUT_INTERVAL
      },
      mining: {
        algorithm: process.env.MINING_ALGORITHM,
        startDifficulty: process.env.START_DIFFICULTY,
        minDifficulty: process.env.MIN_DIFFICULTY,
        maxDifficulty: process.env.MAX_DIFFICULTY,
        targetTime: process.env.TARGET_TIME,
        variancePercent: process.env.VARIANCE_PERCENT,
        retargetInterval: process.env.RETARGET_INTERVAL
      },
      p2p: {
        enabled: process.env.P2P_ENABLED === 'true',
        bootstrapNodes: process.env.BOOTSTRAP_NODES?.split(','),
        maxPeers: process.env.MAX_PEERS,
        announceAddress: process.env.ANNOUNCE_ADDRESS
      },
      security: {
        requireAuth: process.env.REQUIRE_AUTH === 'true',
        allowAnonymous: process.env.ALLOW_ANONYMOUS !== 'false',
        ssl: process.env.SSL_ENABLED === 'true' ? {
          enabled: true,
          certPath: process.env.SSL_CERT_PATH,
          keyPath: process.env.SSL_KEY_PATH
        } : undefined,
        rateLimit: {
          enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
          profile: process.env.RATE_LIMIT_PROFILE as any
        }
      },
      database: {
        type: process.env.DATABASE_TYPE,
        path: process.env.DATABASE_PATH,
        connectionString: process.env.DATABASE_URL
      },
      logging: {
        level: process.env.LOG_LEVEL,
        console: process.env.LOG_CONSOLE !== 'false',
        file: process.env.LOG_FILE !== 'false',
        filePath: process.env.LOG_FILE_PATH
      },
      monitoring: {
        enabled: process.env.MONITORING_ENABLED !== 'false',
        metricsPort: process.env.METRICS_PORT,
        healthCheckInterval: process.env.HEALTH_CHECK_INTERVAL
      }
    };
  }
}
