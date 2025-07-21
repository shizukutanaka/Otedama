/**
 * P2P Configuration for Otedama Mining Pool
 * Centralized configuration for all P2P components
 */

// Default P2P configuration
export const P2PConfig = {
  // Node configuration
  node: {
    nodeId: null, // Auto-generated if not provided
    port: 3333,
    discoveryPort: 3334,
    maxPeers: 50,
    minPeers: 5,
    connectionTimeout: 30000,
    heartbeatInterval: 30000,
    maxConnections: 100
  },

  // Network configuration
  network: {
    enableIPv6: true,
    enableUPnP: true,
    natTraversal: true,
    maxRetries: 3,
    retryDelay: 1000,
    keepAliveInterval: 30000,
    networkTimeout: 10000
  },

  // Stratum V2 configuration
  stratum: {
    port: 3333,
    encryption: true,
    jobNegotiation: true,
    transactionSelection: true,
    noiseProtocol: true,
    maxChannelsPerConnection: 16,
    difficultyAdjustment: true,
    shareTimeout: 30000,
    jobTimeout: 60000
  },

  // Discovery configuration
  discovery: {
    bootstrapNodes: [
      'otedama-node-1.example.com:3334',
      'otedama-node-2.example.com:3334',
      'otedama-node-3.example.com:3334'
    ],
    pingInterval: 30000,
    refreshInterval: 3600000,
    geoAware: true,
    maxPeers: 100,
    kBucketSize: 20,
    alpha: 3
  },

  // Work distribution configuration
  workDistribution: {
    algorithm: 'adaptive', // 'round-robin', 'weighted', 'adaptive'
    difficultyTarget: 0x1d00ffff,
    shareTarget: 0x1e00ffff,
    jobUpdateInterval: 1000,
    maxJobsPerMiner: 10,
    workLifetime: 300000, // 5 minutes
    enablePredictiveDistribution: true
  },

  // Reputation system configuration
  reputation: {
    initialScore: 1000,
    maxScore: 10000,
    minScore: 0,
    decayRate: 0.95,
    validShareReward: 10,
    invalidSharePenalty: 50,
    connectionReward: 5,
    disconnectionPenalty: 20,
    blockReward: 1000,
    pruneThreshold: 100
  },

  // Gossip protocol configuration
  gossip: {
    fanout: 6,
    interval: 2000,
    messageTimeout: 30000,
    maxMessageSize: 1024 * 1024, // 1MB
    enableCompression: true,
    maxHops: 7,
    duplicateFilterSize: 10000
  },

  // Mesh topology configuration
  topology: {
    targetDegree: 6,
    maxDegree: 10,
    minDegree: 3,
    rebalanceInterval: 60000,
    enableSmartRouting: true,
    routingTableSize: 1000,
    geoOptimization: true,
    latencyThreshold: 500 // ms
  },

  // Share verification configuration
  verification: {
    enableParallelVerification: true,
    maxConcurrentVerifications: 10,
    verificationTimeout: 5000,
    enableBatchVerification: true,
    batchSize: 100,
    cacheSize: 10000,
    enablePrevalidation: true
  },

  // Security configuration
  security: {
    enableEncryption: true,
    keyRotationInterval: 3600000, // 1 hour
    maxFailedAttempts: 5,
    banDuration: 300000, // 5 minutes
    enableRateLimiting: true,
    rateLimit: {
      shares: 100, // per minute
      connections: 10, // per minute
      messages: 1000 // per minute
    },
    enableDDoSProtection: true
  },

  // Performance configuration
  performance: {
    enableMetrics: true,
    metricsInterval: 60000,
    enableProfiling: false,
    maxMemoryUsage: 1024 * 1024 * 1024, // 1GB
    enableCaching: true,
    cacheSize: 1000,
    enableLoadBalancing: true,
    loadBalancingStrategy: 'least-connections'
  },

  // Network partition configuration
  partition: {
    detectionThreshold: 0.3, // 30% peer loss triggers detection
    detectionWindow: 30000, // 30 seconds
    minPeersForOperation: 3,
    recoveryStrategy: 'consensus', // 'merge', 'longest_chain', 'highest_work', 'consensus'
    recoveryTimeout: 300000, // 5 minutes
    conflictResolutionTimeout: 60000,
    healthCheckInterval: 10000,
    peerTimeoutThreshold: 60000,
    maxReorgDepth: 100,
    confirmationDepth: 6
  }
};

// Environment-specific configurations
export const EnvironmentConfig = {
  development: {
    node: {
      maxPeers: 10,
      minPeers: 2
    },
    discovery: {
      bootstrapNodes: ['localhost:3334'],
      pingInterval: 10000,
      refreshInterval: 300000 // 5 minutes
    },
    security: {
      enableEncryption: false,
      enableRateLimiting: false
    },
    performance: {
      enableProfiling: true
    },
    partition: {
      detectionThreshold: 0.2, // More sensitive in dev
      detectionWindow: 10000,
      minPeersForOperation: 2
    }
  },

  production: {
    node: {
      maxPeers: 100,
      minPeers: 10
    },
    discovery: {
      bootstrapNodes: [
        'prod-node-1.otedama.com:3334',
        'prod-node-2.otedama.com:3334',
        'prod-node-3.otedama.com:3334'
      ],
      pingInterval: 30000,
      refreshInterval: 3600000
    },
    security: {
      enableEncryption: true,
      enableRateLimiting: true,
      enableDDoSProtection: true
    },
    performance: {
      enableMetrics: true,
      enableProfiling: false
    },
    partition: {
      detectionThreshold: 0.4, // Less sensitive in prod
      detectionWindow: 60000,
      minPeersForOperation: 5,
      recoveryStrategy: 'highest_work'
    }
  },

  test: {
    node: {
      maxPeers: 5,
      minPeers: 1,
      port: 13333,
      discoveryPort: 13334
    },
    discovery: {
      bootstrapNodes: [],
      pingInterval: 5000,
      refreshInterval: 60000
    },
    security: {
      enableEncryption: false,
      enableRateLimiting: false
    },
    performance: {
      enableMetrics: false
    },
    partition: {
      detectionThreshold: 0.1,
      detectionWindow: 5000,
      minPeersForOperation: 1
    }
  }
};

// Mining algorithm configurations
export const MiningAlgorithms = {
  SHA256: {
    name: 'SHA-256',
    difficulty: 0x1d00ffff,
    blockTime: 600000, // 10 minutes
    rewardHalvingInterval: 210000,
    maxSupply: 21000000,
    algorithms: ['sha256d']
  },
  SCRYPT: {
    name: 'Scrypt',
    difficulty: 0x1e0fffff,
    blockTime: 150000, // 2.5 minutes
    rewardHalvingInterval: 840000,
    maxSupply: 84000000,
    algorithms: ['scrypt']
  },
  ETHASH: {
    name: 'Ethash',
    difficulty: 0x1e0fffff,
    blockTime: 15000, // 15 seconds
    rewardHalvingInterval: null,
    maxSupply: null,
    algorithms: ['ethash']
  },
  BLAKE2B: {
    name: 'Blake2b',
    difficulty: 0x1e0fffff,
    blockTime: 300000, // 5 minutes
    rewardHalvingInterval: 500000,
    maxSupply: 21000000,
    algorithms: ['blake2b']
  }
};

// Supported cryptocurrencies
export const SupportedCryptocurrencies = {
  BTC: {
    name: 'Bitcoin',
    symbol: 'BTC',
    algorithm: 'SHA256',
    decimals: 8,
    minPayout: 0.001,
    feePercent: 1.0,
    ports: [3333, 3334]
  },
  LTC: {
    name: 'Litecoin',
    symbol: 'LTC',
    algorithm: 'SCRYPT',
    decimals: 8,
    minPayout: 0.01,
    feePercent: 1.0,
    ports: [3335, 3336]
  },
  ETH: {
    name: 'Ethereum',
    symbol: 'ETH',
    algorithm: 'ETHASH',
    decimals: 18,
    minPayout: 0.01,
    feePercent: 1.0,
    ports: [3337, 3338]
  },
  BCH: {
    name: 'Bitcoin Cash',
    symbol: 'BCH',
    algorithm: 'SHA256',
    decimals: 8,
    minPayout: 0.001,
    feePercent: 1.0,
    ports: [3339, 3340]
  }
};

// Performance thresholds
export const PerformanceThresholds = {
  network: {
    latency: {
      excellent: 50, // ms
      good: 100,
      fair: 200,
      poor: 500
    },
    throughput: {
      excellent: 1000, // shares/second
      good: 500,
      fair: 100,
      poor: 50
    }
  },
  
  mining: {
    hashrate: {
      excellent: 1000000000, // H/s (1 GH/s)
      good: 100000000,      // 100 MH/s
      fair: 10000000,       // 10 MH/s
      poor: 1000000         // 1 MH/s
    },
    efficiency: {
      excellent: 0.95,
      good: 0.85,
      fair: 0.75,
      poor: 0.65
    }
  },

  system: {
    memory: {
      excellent: 100 * 1024 * 1024, // 100 MB
      good: 500 * 1024 * 1024,      // 500 MB
      fair: 1024 * 1024 * 1024,     // 1 GB
      poor: 2048 * 1024 * 1024      // 2 GB
    },
    cpu: {
      excellent: 20, // %
      good: 40,
      fair: 60,
      poor: 80
    }
  }
};

/**
 * Get configuration for the current environment
 */
export function getP2PConfig(env = process.env.NODE_ENV || 'development') {
  const baseConfig = JSON.parse(JSON.stringify(P2PConfig));
  const envConfig = EnvironmentConfig[env] || EnvironmentConfig.development;
  
  return mergeDeep(baseConfig, envConfig);
}

/**
 * Deep merge utility function
 */
function mergeDeep(target, source) {
  const output = { ...target };
  
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      output[key] = mergeDeep(output[key] || {}, source[key]);
    } else {
      output[key] = source[key];
    }
  }
  
  return output;
}

/**
 * Validate P2P configuration
 */
export function validateP2PConfig(config) {
  const errors = [];
  
  // Validate node configuration
  if (!config.node) {
    errors.push('node configuration is required');
  } else {
    if (config.node.port < 1024 || config.node.port > 65535) {
      errors.push('node port must be between 1024 and 65535');
    }
    if (config.node.maxPeers < config.node.minPeers) {
      errors.push('maxPeers must be greater than minPeers');
    }
  }
  
  // Validate stratum configuration
  if (!config.stratum) {
    errors.push('stratum configuration is required');
  } else {
    if (config.stratum.maxChannelsPerConnection < 1) {
      errors.push('maxChannelsPerConnection must be at least 1');
    }
  }
  
  // Validate discovery configuration
  if (!config.discovery) {
    errors.push('discovery configuration is required');
  } else {
    if (!Array.isArray(config.discovery.bootstrapNodes)) {
      errors.push('bootstrapNodes must be an array');
    }
  }
  
  return errors;
}

/**
 * Generate a unique node ID
 */
export function generateNodeId() {
  const { createHash, randomBytes } = require('crypto');
  return createHash('sha1').update(randomBytes(20)).digest('hex');
}

/**
 * Get mining algorithm configuration
 */
export function getMiningAlgorithmConfig(symbol) {
  const crypto = SupportedCryptocurrencies[symbol];
  if (!crypto) {
    throw new Error(`Unsupported cryptocurrency: ${symbol}`);
  }
  
  const algorithm = MiningAlgorithms[crypto.algorithm];
  if (!algorithm) {
    throw new Error(`Unsupported algorithm: ${crypto.algorithm}`);
  }
  
  return {
    ...algorithm,
    cryptocurrency: crypto
  };
}

export default {
  P2PConfig,
  EnvironmentConfig,
  MiningAlgorithms,
  SupportedCryptocurrencies,
  PerformanceThresholds,
  getP2PConfig,
  validateP2PConfig,
  generateNodeId,
  getMiningAlgorithmConfig
};