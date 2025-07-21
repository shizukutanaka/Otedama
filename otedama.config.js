/**
 * Otedama Configuration File
 * Production-ready settings for enterprise deployment
 */

module.exports = {
  // Pool Configuration
  pool: {
    name: process.env.POOL_NAME || 'Otedama Mining Pool',
    operator: process.env.POOL_OPERATOR || 'Pool Operator',
    fee: parseFloat(process.env.POOL_FEE) || 0.01, // 1% default
    payoutInterval: parseInt(process.env.PAYOUT_INTERVAL) || 3600000, // 1 hour
    minPayout: {
      BTC: parseFloat(process.env.MIN_PAYOUT_BTC) || 0.001,
      ETH: parseFloat(process.env.MIN_PAYOUT_ETH) || 0.01,
      LTC: parseFloat(process.env.MIN_PAYOUT_LTC) || 0.1
    },
    payoutAddress: process.env.POOL_WALLET_ADDRESS
  },
  
  // Mining Configuration
  mining: {
    algorithms: {
      sha256: {
        enabled: process.env.ENABLE_SHA256 !== 'false',
        port: parseInt(process.env.SHA256_PORT) || 3333,
        difficulty: parseInt(process.env.SHA256_DIFFICULTY) || 8192
      },
      scrypt: {
        enabled: process.env.ENABLE_SCRYPT !== 'false',
        port: parseInt(process.env.SCRYPT_PORT) || 3334,
        difficulty: parseInt(process.env.SCRYPT_DIFFICULTY) || 2048
      },
      ethash: {
        enabled: process.env.ENABLE_ETHASH !== 'false',
        port: parseInt(process.env.ETHASH_PORT) || 3335,
        difficulty: parseInt(process.env.ETHASH_DIFFICULTY) || 4000000000
      },
      randomx: {
        enabled: process.env.ENABLE_RANDOMX !== 'false',
        port: parseInt(process.env.RANDOMX_PORT) || 3336,
        difficulty: parseInt(process.env.RANDOMX_DIFFICULTY) || 100000
      }
    },
    
    // Worker settings
    workers: {
      validation: parseInt(process.env.VALIDATION_WORKERS) || 4,
      mining: parseInt(process.env.MINING_WORKERS) || 8
    },
    
    // Connection limits
    maxConnections: parseInt(process.env.MAX_MINER_CONNECTIONS) || 10000,
    connectionTimeout: parseInt(process.env.CONNECTION_TIMEOUT) || 600000 // 10 minutes
  },
  
  // DEX Configuration
  dex: {
    enabled: process.env.ENABLE_DEX !== 'false',
    
    trading: {
      makerFee: parseFloat(process.env.MAKER_FEE) || 0.001, // 0.1%
      takerFee: parseFloat(process.env.TAKER_FEE) || 0.0015, // 0.15%
      minOrderSize: parseFloat(process.env.MIN_ORDER_SIZE) || 0.00001,
      maxOrderSize: parseFloat(process.env.MAX_ORDER_SIZE) || 1000
    },
    
    matching: {
      algorithm: process.env.MATCHING_ALGORITHM || 'PRICE_TIME',
      batchSize: parseInt(process.env.MATCHING_BATCH_SIZE) || 100,
      interval: parseInt(process.env.MATCHING_INTERVAL) || 10 // ms
    },
    
    liquidity: {
      enableAMM: process.env.ENABLE_AMM !== 'false',
      enableOrderBook: process.env.ENABLE_ORDER_BOOK !== 'false'
    }
  },
  
  // DeFi Configuration
  defi: {
    enabled: process.env.ENABLE_DEFI !== 'false',
    
    staking: {
      enabled: process.env.ENABLE_STAKING !== 'false',
      minStake: parseFloat(process.env.MIN_STAKE) || 100,
      apr: parseFloat(process.env.STAKING_APR) || 0.05 // 5%
    },
    
    lending: {
      enabled: process.env.ENABLE_LENDING !== 'false',
      collateralRatio: parseFloat(process.env.COLLATERAL_RATIO) || 1.5
    },
    
    governance: {
      enabled: process.env.ENABLE_GOVERNANCE !== 'false',
      proposalThreshold: parseFloat(process.env.PROPOSAL_THRESHOLD) || 10000,
      votingPeriod: parseInt(process.env.VOTING_PERIOD) || 259200000 // 3 days
    }
  },
  
  // Network Configuration
  network: {
    host: process.env.HOST || '0.0.0.0',
    port: parseInt(process.env.PORT) || 8080,
    apiPort: parseInt(process.env.API_PORT) || 8081,
    wsPort: parseInt(process.env.WS_PORT) || 3334,
    
    ssl: {
      enabled: process.env.ENABLE_SSL === 'true',
      cert: process.env.SSL_CERT_PATH,
      key: process.env.SSL_KEY_PATH
    }
  },
  
  // Database Configuration
  database: {
    client: process.env.DB_CLIENT || 'postgresql',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      user: process.env.DB_USER || 'otedama',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'otedama'
    },
    pool: {
      min: parseInt(process.env.DB_POOL_MIN) || 5,
      max: parseInt(process.env.DB_POOL_MAX) || 20
    }
  },
  
  // Cache Configuration
  cache: {
    redis: {
      enabled: process.env.ENABLE_REDIS !== 'false',
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB) || 0
    },
    
    memory: {
      maxSize: parseInt(process.env.CACHE_MAX_SIZE) || 100 * 1024 * 1024, // 100MB
      ttl: parseInt(process.env.CACHE_TTL) || 3600000 // 1 hour
    }
  },
  
  // Performance Configuration
  performance: {
    // Connection pooling
    connectionPool: {
      minConnections: parseInt(process.env.POOL_MIN_CONNECTIONS) || 5,
      maxConnections: parseInt(process.env.POOL_MAX_CONNECTIONS) || 100,
      acquireTimeout: parseInt(process.env.POOL_ACQUIRE_TIMEOUT) || 30000
    },
    
    // Circuit breaker
    circuitBreaker: {
      enabled: process.env.ENABLE_CIRCUIT_BREAKER !== 'false',
      failureThreshold: parseInt(process.env.CIRCUIT_FAILURE_THRESHOLD) || 5,
      resetTimeout: parseInt(process.env.CIRCUIT_RESET_TIMEOUT) || 60000
    },
    
    // Rate limiting
    rateLimit: {
      enabled: process.env.ENABLE_RATE_LIMIT !== 'false',
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) || 60000, // 1 minute
      max: parseInt(process.env.RATE_LIMIT_MAX) || 100
    }
  },
  
  // Security Configuration
  security: {
    // Authentication
    jwt: {
      secret: process.env.JWT_SECRET || 'change-this-secret-in-production',
      expiresIn: process.env.JWT_EXPIRES_IN || '24h'
    },
    
    // CORS
    cors: {
      enabled: process.env.ENABLE_CORS !== 'false',
      origin: process.env.CORS_ORIGIN || '*',
      credentials: process.env.CORS_CREDENTIALS === 'true'
    },
    
    // DDoS protection
    ddos: {
      enabled: process.env.ENABLE_DDOS_PROTECTION !== 'false',
      burst: parseInt(process.env.DDOS_BURST) || 10,
      limit: parseInt(process.env.DDOS_LIMIT) || 15
    }
  },
  
  // Monitoring Configuration
  monitoring: {
    prometheus: {
      enabled: process.env.ENABLE_PROMETHEUS !== 'false',
      port: parseInt(process.env.PROMETHEUS_PORT) || 9091,
      path: process.env.PROMETHEUS_PATH || '/metrics'
    },
    
    logging: {
      level: process.env.LOG_LEVEL || 'info',
      format: process.env.LOG_FORMAT || 'json',
      file: process.env.LOG_FILE || 'logs/otedama.log',
      maxSize: process.env.LOG_MAX_SIZE || '100m',
      maxFiles: parseInt(process.env.LOG_MAX_FILES) || 10
    }
  },
  
  // Development/Production Mode
  production: process.env.NODE_ENV === 'production',
  debug: process.env.DEBUG === 'true'
};