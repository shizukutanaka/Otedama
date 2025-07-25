/**
 * Otedama Pool Configuration
 * Production-ready configuration following Carmack, Martin, and Pike principles
 */

export default {
  // Pool identification
  poolName: process.env.POOL_NAME || 'Otedama Mining Pool',
  poolAddress: process.env.POOL_ADDRESS || null, // Required
  
  // Network configuration
  stratumPort: parseInt(process.env.STRATUM_PORT) || 3333,
  stratumV2Port: parseInt(process.env.STRATUM_V2_PORT) || 3336,
  apiPort: parseInt(process.env.API_PORT) || 8080,
  p2pPort: parseInt(process.env.P2P_PORT) || 33333,
  healthCheckPort: parseInt(process.env.HEALTH_CHECK_PORT) || 9090,
  
  // Blockchain connection
  bitcoin: {
    rpcUrl: process.env.BITCOIN_RPC_URL || 'http://localhost:8332',
    rpcUser: process.env.BITCOIN_RPC_USER || 'bitcoinrpc',
    rpcPassword: process.env.BITCOIN_RPC_PASSWORD || null, // Required
    network: process.env.BITCOIN_NETWORK || 'mainnet'
  },
  
  // Pool economics
  poolFee: parseFloat(process.env.POOL_FEE) || 0.01, // 1%
  paymentScheme: process.env.PAYMENT_SCHEME || 'PPLNS',
  minimumPayment: parseFloat(process.env.MIN_PAYMENT) || 0.001,
  paymentInterval: 3600000, // 1 hour
  
  // Mining configuration
  algorithm: 'sha256',
  shareTargetTime: parseInt(process.env.SHARE_TARGET_TIME) || 10000, // 10 seconds
  pplnsWindow: parseInt(process.env.PPLNS_WINDOW) || 100000,
  
  // Performance tuning
  workers: parseInt(process.env.WORKERS) || 0, // 0 = auto (CPU cores)
  maxConnections: parseInt(process.env.MAX_CONNECTIONS) || 10000,
  connectionTimeout: 300000, // 5 minutes
  
  // Features
  enableProfitSwitching: process.env.ENABLE_PROFIT_SWITCHING === 'true',
  enableASICMining: process.env.ENABLE_ASIC_MINING !== 'false',
  enableP2PFederation: process.env.ENABLE_P2P_FEDERATION !== 'false',
  enableStratumV2: process.env.ENABLE_STRATUM_V2 !== 'false',
  enableZKP: process.env.ENABLE_ZKP === 'true',
  requireZKP: process.env.REQUIRE_ZKP === 'true',
  
  // Security
  security: {
    rateLimiting: true,
    ddosProtection: true,
    maxSharesPerSecond: 100,
    banThreshold: 50, // Invalid shares before ban
    banDuration: 600000, // 10 minutes
    jwtSecret: process.env.JWT_SECRET || 'change_this_secret',
    apiKey: process.env.API_KEY || null
  },
  
  // Zero-Knowledge Proof Configuration
  zkp: {
    enabled: process.env.ENABLE_ZKP === 'true',
    required: process.env.REQUIRE_ZKP === 'true',
    proofExpiry: 86400000, // 24 hours
    minAge: 18,
    restrictedCountries: ['KP', 'IR', 'CU', 'SY'],
    dailyLimit: 10000, // USD equivalent
    monthlyLimit: 100000,
    dbFile: './data/zkp-enhanced.db'
  },
  
  // Database
  database: {
    path: process.env.DATABASE_PATH || './data/pool.db',
    walMode: true,
    cacheSize: 64000, // 64MB
    pageSize: 32768 // 32KB
  },
  
  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || './logs/pool.log',
    maxSize: 100 * 1024 * 1024, // 100MB
    maxFiles: 10,
    console: true
  },
  
  // Monitoring
  monitoring: {
    prometheusPort: parseInt(process.env.PROMETHEUS_PORT) || 9090,
    grafanaPort: parseInt(process.env.GRAFANA_PORT) || 3000,
    collectInterval: 10000 // 10 seconds
  },
  
  // P2P Federation
  p2p: {
    maxPeers: 50,
    seedPeers: [],
    announceInterval: 300000, // 5 minutes
    syncInterval: 60000 // 1 minute
  },
  
  // Advanced options
  advanced: {
    // Memory optimization
    memoryOptimization: true,
    bufferPoolSize: 1000,
    objectPoolSize: 10000,
    
    // Network optimization
    tcpNoDelay: true,
    socketBufferSize: 1048576, // 1MB
    
    // Share validation
    shareValidationWorkers: 4,
    shareValidationBatchSize: 1000,
    
    // Cache configuration
    cacheSize: 100000,
    cacheTTL: 60000 // 1 minute
  }
};
