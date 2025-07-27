/**
 * DEX Configuration for Otedama
 * Centralized configuration for all DEX components
 */

// Default DEX configuration
export const DexConfig = {
  // Trading configuration
  trading: {
    feeRate: 0.001, // 0.1%
    minOrderSize: 0.00001,
    maxOrderSize: 1000000,
    maxOrdersPerUser: 100,
    orderExpirationTime: 86400000, // 24 hours
    maxPriceDeviation: 0.1, // 10% max price deviation
    tickSize: 0.00000001, // Minimum price increment
    lotSize: 0.00001, // Minimum amount increment
    enableMarketOrders: true,
    enableStopOrders: true,
    enableIcebergOrders: true,
    enableMarginTrading: false
  },

  // Order book configuration
  orderBook: {
    maxDepth: 1000, // Maximum orders per side
    priceAggregationLevels: 50,
    enableRealTimeUpdates: true,
    snapshotInterval: 10000, // 10 seconds
    maxPricePoints: 10000,
    enableCompression: true,
    enableCaching: true,
    cacheSize: 1000
  },

  // Matching engine configuration
  matching: {
    algorithm: 'PRICE_TIME', // PRICE_TIME, PRO_RATA, PRICE_SIZE_TIME
    maxMatchesPerOrder: 100,
    matchingTimeout: 5000, // 5 seconds
    enableBatchMatching: true,
    batchSize: 100,
    batchTimeout: 10, // 10ms
    enableParallelMatching: true,
    maxConcurrentMatches: 10
  },

  // Liquidity pool configuration
  liquidityPool: {
    enableAMM: true,
    fee: 0.003, // 0.3% swap fee
    minLiquidity: 1000,
    maxSlippage: 0.05, // 5%
    enableConcentratedLiquidity: true,
    enableDynamicFees: true,
    feeRange: [0.001, 0.01], // 0.1% - 1%
    enableMEVProtection: true,
    maxBlocksDelay: 2
  },

  // Risk management
  risk: {
    maxPositionSize: 10000,
    maxDrawdown: 0.2, // 20%
    enableCircuitBreaker: true,
    circuitBreakerThreshold: 0.1, // 10% price movement
    enableAutoDelisting: true,
    minDailyVolume: 1000,
    maxVolatility: 0.5, // 50%
    enableRiskScoring: true
  },

  // Performance configuration
  performance: {
    enableMetrics: true,
    metricsInterval: 60000, // 1 minute
    enableProfiling: false,
    maxMemoryUsage: 512 * 1024 * 1024, // 512MB
    enableOptimizations: true,
    cacheSize: 10000,
    enablePrecomputation: true,
    enableIndexing: true
  },

  // Security configuration
  security: {
    enableRateLimiting: true,
    rateLimit: {
      orders: 100, // per minute
      cancellations: 200, // per minute
      queries: 1000 // per minute
    },
    enableWhitelist: false,
    enableBlacklist: true,
    enableZKP: true,
    enableAML: false,
    maxFailedAttempts: 5,
    banDuration: 300000, // 5 minutes
    enableEncryption: true,
    enableSignatureVerification: true
  }
};

// Environment-specific configurations
export const EnvironmentConfig = {
  development: {
    trading: {
      feeRate: 0.0001, // Lower fees for testing
      minOrderSize: 0.001,
      maxOrderSize: 10000,
      orderExpirationTime: 3600000 // 1 hour
    },
    orderBook: {
      maxDepth: 100,
      snapshotInterval: 60000 // 1 minute
    },
    matching: {
      enableBatchMatching: false,
      enableParallelMatching: false
    },
    liquidityPool: {
      minLiquidity: 100,
      enableMEVProtection: false
    },
    security: {
      enableRateLimiting: false,
      enableKYC: false
    },
    performance: {
      enableProfiling: true
    }
  },

  production: {
    trading: {
      feeRate: 0.001,
      minOrderSize: 0.00001,
      maxOrderSize: 1000000,
      orderExpirationTime: 86400000 // 24 hours
    },
    orderBook: {
      maxDepth: 1000,
      snapshotInterval: 1000 // 1 second
    },
    matching: {
      enableBatchMatching: true,
      enableParallelMatching: true,
      maxConcurrentMatches: 20
    },
    liquidityPool: {
      minLiquidity: 10000,
      enableMEVProtection: true
    },
    security: {
      enableRateLimiting: true,
      enableZKP: true,
      enableAML: true
    },
    performance: {
      enableMetrics: true,
      enableProfiling: false
    }
  },

  test: {
    trading: {
      feeRate: 0,
      minOrderSize: 0.01,
      maxOrderSize: 1000,
      orderExpirationTime: 60000 // 1 minute
    },
    orderBook: {
      maxDepth: 50,
      snapshotInterval: 10000 // 10 seconds
    },
    matching: {
      enableBatchMatching: false,
      enableParallelMatching: false
    },
    liquidityPool: {
      minLiquidity: 10,
      enableMEVProtection: false
    },
    security: {
      enableRateLimiting: false,
      enableKYC: false
    },
    performance: {
      enableMetrics: false
    }
  }
};

// Supported trading pairs
export const SupportedPairs = {
  'BTC/USD': {
    baseCurrency: 'BTC',
    quoteCurrency: 'USD',
    tickSize: 0.01,
    lotSize: 0.00001,
    minOrderSize: 0.00001,
    maxOrderSize: 100,
    feeRate: 0.001,
    enabled: true
  },
  'ETH/USD': {
    baseCurrency: 'ETH',
    quoteCurrency: 'USD',
    tickSize: 0.01,
    lotSize: 0.0001,
    minOrderSize: 0.0001,
    maxOrderSize: 1000,
    feeRate: 0.001,
    enabled: true
  },
  'LTC/USD': {
    baseCurrency: 'LTC',
    quoteCurrency: 'USD',
    tickSize: 0.01,
    lotSize: 0.001,
    minOrderSize: 0.001,
    maxOrderSize: 1000,
    feeRate: 0.0015,
    enabled: true
  },
  'BTC/ETH': {
    baseCurrency: 'BTC',
    quoteCurrency: 'ETH',
    tickSize: 0.0001,
    lotSize: 0.00001,
    minOrderSize: 0.00001,
    maxOrderSize: 10,
    feeRate: 0.001,
    enabled: true
  }
};

// AMM curve types
export const AMMCurveTypes = {
  CONSTANT_PRODUCT: 'constant_product', // x * y = k
  CONSTANT_SUM: 'constant_sum', // x + y = k
  STABLE_SWAP: 'stable_swap', // For stable coins
  CONCENTRATED_LIQUIDITY: 'concentrated_liquidity', // Uniswap V3 style
  WEIGHTED: 'weighted' // Balancer style
};

// Price feed configuration
export const PriceFeedConfig = {
  sources: [
    'binance',
    'coinbase',
    'kraken',
    'huobi',
    'bitstamp'
  ],
  updateInterval: 1000, // 1 second
  maxAge: 10000, // 10 seconds
  enableFailover: true,
  weightedAverage: true,
  outlierDetection: true,
  maxDeviation: 0.05 // 5%
};

// Performance thresholds
export const PerformanceThresholds = {
  orderBook: {
    updateLatency: {
      excellent: 1, // ms
      good: 5,
      fair: 20,
      poor: 100
    },
    depth: {
      excellent: 1000,
      good: 500,
      fair: 100,
      poor: 50
    }
  },
  
  matching: {
    latency: {
      excellent: 5, // ms
      good: 20,
      fair: 100,
      poor: 500
    },
    throughput: {
      excellent: 10000, // trades/second
      good: 1000,
      fair: 100,
      poor: 10
    }
  },
  
  liquidity: {
    depth: {
      excellent: 1000000, // USD
      good: 100000,
      fair: 10000,
      poor: 1000
    },
    spread: {
      excellent: 0.001, // 0.1%
      good: 0.005,
      fair: 0.01,
      poor: 0.05
    }
  }
};

/**
 * Get configuration for the current environment
 */
export function getDexConfig(env = process.env.NODE_ENV || 'development') {
  const baseConfig = JSON.parse(JSON.stringify(DexConfig));
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
 * Validate DEX configuration
 */
export function validateDexConfig(config) {
  const errors = [];
  
  // Validate trading configuration
  if (!config.trading) {
    errors.push('trading configuration is required');
  } else {
    if (config.trading.feeRate < 0 || config.trading.feeRate > 1) {
      errors.push('feeRate must be between 0 and 1');
    }
    if (config.trading.minOrderSize <= 0) {
      errors.push('minOrderSize must be greater than 0');
    }
    if (config.trading.maxOrderSize <= config.trading.minOrderSize) {
      errors.push('maxOrderSize must be greater than minOrderSize');
    }
  }
  
  // Validate order book configuration
  if (!config.orderBook) {
    errors.push('orderBook configuration is required');
  } else {
    if (config.orderBook.maxDepth <= 0) {
      errors.push('maxDepth must be greater than 0');
    }
  }
  
  // Validate matching configuration
  if (!config.matching) {
    errors.push('matching configuration is required');
  } else {
    const validAlgorithms = ['PRICE_TIME', 'PRO_RATA', 'PRICE_SIZE_TIME'];
    if (!validAlgorithms.includes(config.matching.algorithm)) {
      errors.push(`algorithm must be one of: ${validAlgorithms.join(', ')}`);
    }
  }
  
  return errors;
}

/**
 * Get trading pair configuration
 */
export function getTradingPairConfig(symbol) {
  const pairConfig = SupportedPairs[symbol];
  if (!pairConfig) {
    throw new Error(`Unsupported trading pair: ${symbol}`);
  }
  
  if (!pairConfig.enabled) {
    throw new Error(`Trading pair ${symbol} is disabled`);
  }
  
  return pairConfig;
}

/**
 * Validate trading pair symbol
 */
export function validateTradingPair(symbol) {
  const pairConfig = SupportedPairs[symbol];
  return pairConfig && pairConfig.enabled;
}

/**
 * Get AMM curve configuration
 */
export function getAMMCurveConfig(curveType) {
  const validCurves = Object.values(AMMCurveTypes);
  if (!validCurves.includes(curveType)) {
    throw new Error(`Invalid AMM curve type: ${curveType}`);
  }
  
  return {
    type: curveType,
    ...getAMMCurveParams(curveType)
  };
}

/**
 * Get AMM curve parameters
 */
function getAMMCurveParams(curveType) {
  switch (curveType) {
    case AMMCurveTypes.CONSTANT_PRODUCT:
      return {
        fee: 0.003,
        minimumLiquidity: 1000
      };
    case AMMCurveTypes.STABLE_SWAP:
      return {
        fee: 0.0004,
        amplificationParameter: 100,
        minimumLiquidity: 10000
      };
    case AMMCurveTypes.CONCENTRATED_LIQUIDITY:
      return {
        fee: 0.0005,
        tickSpacing: 60,
        minimumLiquidity: 1000
      };
    case AMMCurveTypes.WEIGHTED:
      return {
        fee: 0.002,
        weights: [0.5, 0.5],
        minimumLiquidity: 1000
      };
    default:
      return {};
  }
}

export default {
  DexConfig,
  EnvironmentConfig,
  SupportedPairs,
  AMMCurveTypes,
  PriceFeedConfig,
  PerformanceThresholds,
  getDexConfig,
  validateDexConfig,
  getTradingPairConfig,
  validateTradingPair,
  getAMMCurveConfig
};