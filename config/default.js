/**
 * Otedama Configuration
 * Central configuration for all components
 */

module.exports = {
  // Server Configuration
  server: {
    stratumPort: process.env.STRATUM_PORT || 3333,
    apiPort: process.env.API_PORT || 8080,
    p2pPort: process.env.P2P_PORT || 6633,
    wsPort: process.env.WS_PORT || 8081
  },
  
  // Mining Pool Configuration
  mining: {
    difficulty: {
      initial: 16,
      minimum: 1,
      maximum: 4294967296,
      retargetInterval: 300, // 5 minutes
      variancePercent: 30
    },
    
    rewards: {
      blockReward: 6.25,
      poolFee: 0.01, // 1%
      minPayout: 0.001,
      payoutInterval: 3600000 // 1 hour
    },
    
    algorithms: [
      'sha256',
      'scrypt',
      'ethash',
      'randomx',
      'kawpow',
      'equihash'
    ]
  },
  
  // DEX Configuration
  dex: {
    fees: {
      maker: 0.001, // 0.1%
      taker: 0.002, // 0.2%
      flashLoan: 0.0009 // 0.09%
    },
    
    orderBook: {
      maxDepth: 1000,
      maxOrdersPerUser: 100,
      minOrderSize: 0.00001
    },
    
    tradingPairs: [
      { base: 'BTC', quote: 'USDT', tickSize: 0.01 },
      { base: 'ETH', quote: 'USDT', tickSize: 0.01 },
      { base: 'ETH', quote: 'BTC', tickSize: 0.000001 },
      { base: 'BNB', quote: 'USDT', tickSize: 0.01 },
      { base: 'SOL', quote: 'USDT', tickSize: 0.01 },
      { base: 'MATIC', quote: 'USDT', tickSize: 0.0001 }
    ],
    
    features: {
      advancedOrders: true,
      liquidityAggregation: true,
      mevProtection: true,
      flashLoans: true
    }
  },
  
  // DeFi Configuration
  defi: {
    yieldFarming: {
      baseAPY: 0.05, // 5%
      maxAPY: 2.0, // 200%
      compoundFrequency: 86400, // Daily
      minStake: 0.001,
      lockBonuses: {
        0: 0,
        30: 0.1,
        90: 0.25,
        180: 0.5,
        365: 1.0
      }
    },
    
    lending: {
      baseRate: 0.02, // 2%
      maxLTV: 0.75, // 75%
      liquidationThreshold: 0.85, // 85%
      liquidationPenalty: 0.1, // 10%
      minLoan: 100,
      originationFee: 0.005 // 0.5%
    },
    
    staking: {
      baseReward: 0.08, // 8% APY
      slashPenalty: 0.05, // 5%
      minStake: 32,
      unstakeDelay: 604800, // 7 days
      validatorCommission: 0.1 // 10%
    }
  },
  
  // Security Configuration
  security: {
    tls: {
      enabled: process.env.TLS_ENABLED === 'true',
      certPath: process.env.TLS_CERT_PATH || './certs/cert.pem',
      keyPath: process.env.TLS_KEY_PATH || './certs/key.pem'
    },
    
    rateLimit: {
      windowMs: 60000, // 1 minute
      maxRequests: 100,
      tradingMaxRequests: 30,
      miningMaxRequests: 100
    },
    
    authentication: {
      jwtSecret: (() => {
        const secret = process.env.JWT_SECRET;
        if (!secret || secret.length < 32) {
          throw new Error('JWT_SECRET environment variable must be set with a secure value of at least 32 characters');
        }
        return secret;
      })(),
      jwtExpiry: '24h',
      enable2FA: true,
      sessionTimeout: 3600000 // 1 hour
    }
  },
  
  // Database Configuration
  database: {
    type: process.env.DB_TYPE || 'sqlite',
    sqlite: {
      filename: process.env.DB_PATH || './data/otedama.db'
    },
    postgres: {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'otedama',
      user: process.env.DB_USER || 'otedama',
      password: process.env.DB_PASSWORD || 'password'
    },
    sharding: {
      enabled: false,
      shardCount: 16
    }
  },
  
  // P2P Network Configuration
  p2p: {
    maxPeers: 50,
    seedNodes: process.env.SEED_NODES ? process.env.SEED_NODES.split(',') : [],
    gossipInterval: 30000, // 30 seconds
    heartbeatInterval: 10000, // 10 seconds
    connectionTimeout: 30000 // 30 seconds
  },
  
  // Blockchain Configuration
  blockchain: {
    url: process.env.BLOCKCHAIN_URL || 'http://localhost:8332',
    user: process.env.BLOCKCHAIN_USER || 'user',
    password: process.env.BLOCKCHAIN_PASS || 'pass',
    network: process.env.BLOCKCHAIN_NETWORK || 'mainnet',
    confirmations: 6
  },
  
  // Monitoring Configuration
  monitoring: {
    enabled: true,
    metricsInterval: 10000, // 10 seconds
    alerting: {
      enabled: true,
      thresholds: {
        cpuUsage: 80,
        memoryUsage: 85,
        errorRate: 5,
        responseTime: 1000
      }
    },
    prometheus: {
      enabled: false,
      port: 9090
    }
  },
  
  // Performance Configuration
  performance: {
    caching: {
      enabled: true,
      maxMemory: 1073741824, // 1GB
      ttl: 3600 // 1 hour
    },
    
    optimization: {
      enableZeroCopy: true,
      enableSIMD: true,
      workerThreads: 8,
      cpuAffinity: true
    },
    
    scaling: {
      autoScale: true,
      minWorkers: 2,
      maxWorkers: 16,
      scaleUpThreshold: 0.8,
      scaleDownThreshold: 0.3
    }
  },
  
  // Feature Flags
  features: {
    enableMining: true,
    enableDEX: true,
    enableDeFi: true,
    enableEnterprise: false,
    enableAnalytics: true,
    enableMobileAPI: true,
    enableWebhooks: true
  }
};