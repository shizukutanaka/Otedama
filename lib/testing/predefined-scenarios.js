/**
 * Predefined Load Test Scenarios
 * 
 * Ready-to-use scenarios for testing Otedama Mining Pool and DEX
 * Covering common usage patterns and edge cases
 */

export const MiningPoolScenarios = {
  /**
   * Basic health check scenario
   */
  healthCheck: {
    name: 'Health Check',
    weight: 1,
    users: 10,
    duration: 30000,
    thinkTime: 5000,
    requests: [
      {
        method: 'GET',
        url: '/health',
        assertions: [
          { type: 'status_code', expected: 200 },
          { type: 'body_json', path: 'status', expected: 'healthy' }
        ]
      }
    ]
  },

  /**
   * Pool statistics monitoring
   */
  poolStats: {
    name: 'Pool Statistics',
    weight: 3,
    users: 50,
    duration: 60000,
    thinkTime: 2000,
    requests: [
      {
        method: 'GET',
        url: '/api/stats',
        assertions: [
          { type: 'status_code', expected: 200 },
          { type: 'body_json', path: 'miners', expected: 'number' }
        ],
        extractors: [
          { type: 'json_path', path: 'totalHashrate', name: 'hashrate' }
        ]
      },
      {
        method: 'GET',
        url: '/api/stats?currency=BTC',
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      }
    ]
  },

  /**
   * Price monitoring scenario
   */
  priceMonitoring: {
    name: 'Price Monitoring',
    weight: 2,
    users: 30,
    duration: 45000,
    thinkTime: 3000,
    requests: [
      {
        method: 'GET',
        url: '/api/prices',
        assertions: [
          { type: 'status_code', expected: 200 },
          { type: 'body_contains', expected: 'BTC' }
        ]
      }
    ]
  },

  /**
   * Miner authentication and data retrieval
   */
  minerData: {
    name: 'Miner Data Access',
    weight: 4,
    users: 100,
    duration: 120000,
    thinkTime: 1500,
    variables: {
      apiKey: 'test-api-key-{{timestamp}}',
      minerId: 'miner-{{worker_id}}'
    },
    requests: [
      {
        method: 'GET',
        url: '/api/miner/{{minerId}}',
        headers: {
          'X-API-Key': '{{apiKey}}'
        },
        assertions: [
          { type: 'status_code', expected: 200 }
        ],
        extractors: [
          { type: 'json_path', path: 'id', name: 'actualMinerId' }
        ]
      },
      {
        method: 'GET',
        url: '/api/miner/{{minerId}}/workers',
        headers: {
          'X-API-Key': '{{apiKey}}'
        },
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      },
      {
        method: 'GET',
        url: '/api/miner/{{minerId}}/earnings',
        headers: {
          'X-API-Key': '{{apiKey}}'
        },
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      }
    ]
  },

  /**
   * Payout request scenario
   */
  payoutRequests: {
    name: 'Payout Requests',
    weight: 2,
    users: 20,
    duration: 90000,
    thinkTime: 5000,
    variables: {
      apiKey: 'test-api-key-{{timestamp}}',
      minerId: 'miner-{{worker_id}}'
    },
    requests: [
      {
        method: 'POST',
        url: '/api/payout/request',
        headers: {
          'X-API-Key': '{{apiKey}}',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          minerId: '{{minerId}}',
          amount: 0.001
        }),
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      }
    ]
  }
};

export const DEXScenarios = {
  /**
   * Liquidity pool browsing
   */
  liquidityPools: {
    name: 'Liquidity Pool Browsing',
    weight: 3,
    users: 40,
    duration: 60000,
    thinkTime: 2000,
    requests: [
      {
        method: 'GET',
        url: '/api/dex/pools',
        assertions: [
          { type: 'status_code', expected: 200 }
        ],
        extractors: [
          { type: 'json_path', path: '0.id', name: 'poolId' }
        ]
      },
      {
        method: 'GET',
        url: '/api/dex/pools?token0=BTC',
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      }
    ]
  },

  /**
   * Token swapping
   */
  tokenSwap: {
    name: 'Token Swapping',
    weight: 5,
    users: 75,
    duration: 180000,
    thinkTime: 3000,
    variables: {
      apiKey: 'test-api-key-{{timestamp}}',
      tokenIn: 'BTC',
      tokenOut: 'ETH',
      amount: 0.001
    },
    requests: [
      {
        method: 'GET',
        url: '/api/dex/pools',
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      },
      {
        method: 'POST',
        url: '/api/dex/swap',
        headers: {
          'X-API-Key': '{{apiKey}}',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          tokenIn: '{{tokenIn}}',
          tokenOut: '{{tokenOut}}',
          amountIn: '{{amount}}',
          minAmountOut: 0.0009,
          deadline: '{{timestamp}}'
        }),
        assertions: [
          { type: 'status_code', expected: 200 }
        ],
        extractors: [
          { type: 'json_path', path: 'transactionId', name: 'swapTxId' }
        ]
      }
    ]
  }
};

export const StressTestScenarios = {
  /**
   * High-frequency trading simulation
   */
  highFrequencyTrading: {
    name: 'High Frequency Trading',
    weight: 10,
    users: 200,
    duration: 300000, // 5 minutes
    thinkTime: 100,   // Very short think time
    variables: {
      apiKey: 'hft-api-key-{{timestamp}}'
    },
    requests: [
      {
        method: 'GET',
        url: '/api/prices',
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      },
      {
        method: 'POST',
        url: '/api/dex/swap',
        headers: {
          'X-API-Key': '{{apiKey}}',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          tokenIn: 'BTC',
          tokenOut: 'ETH',
          amountIn: 0.0001,
          minAmountOut: 0.000001,
          deadline: '{{timestamp}}'
        }),
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      }
    ]
  },

  /**
   * Mining pool overload test
   */
  miningPoolOverload: {
    name: 'Mining Pool Overload',
    weight: 8,
    users: 500,
    duration: 600000, // 10 minutes
    thinkTime: 500,
    variables: {
      minerId: 'stress-miner-{{worker_id}}-{{random}}'
    },
    requests: [
      {
        method: 'GET',
        url: '/api/stats',
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      },
      {
        method: 'GET',
        url: '/api/miner/{{minerId}}',
        headers: {
          'X-API-Key': 'stress-test-key'
        }
      },
      {
        method: 'GET',
        url: '/api/miner/{{minerId}}/workers',
        headers: {
          'X-API-Key': 'stress-test-key'
        }
      }
    ]
  },

  /**
   * Spike load test
   */
  spikeLoad: {
    name: 'Spike Load Test',
    weight: 15,
    users: 1000,
    duration: 120000, // 2 minutes
    thinkTime: 50,    // Very aggressive
    rampUp: 5000,     // Quick ramp up
    requests: [
      {
        method: 'GET',
        url: '/health',
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      },
      {
        method: 'GET',
        url: '/api/stats',
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      }
    ]
  }
};

export const EnduranceTestScenarios = {
  /**
   * Long-running stability test
   */
  stabilityTest: {
    name: '24-Hour Stability Test',
    weight: 5,
    users: 100,
    duration: 86400000, // 24 hours
    thinkTime: 10000,   // 10 seconds between requests
    variables: {
      sessionId: 'stability-{{timestamp}}'
    },
    requests: [
      {
        method: 'GET',
        url: '/health',
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      },
      {
        method: 'GET',
        url: '/api/stats',
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      },
      {
        method: 'GET',
        url: '/api/prices',
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      }
    ]
  },

  /**
   * Memory leak detection
   */
  memoryLeakTest: {
    name: 'Memory Leak Detection',
    weight: 3,
    users: 50,
    duration: 3600000, // 1 hour
    thinkTime: 1000,
    requests: [
      {
        method: 'GET',
        url: '/api/stats?detailed=true',
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      },
      {
        method: 'GET',
        url: '/api/dex/pools',
        assertions: [
          { type: 'status_code', expected: 200 }
        ]
      }
    ]
  }
};

export const ErrorTestScenarios = {
  /**
   * Authentication failure handling
   */
  authFailures: {
    name: 'Authentication Failures',
    weight: 2,
    users: 25,
    duration: 60000,
    thinkTime: 2000,
    requests: [
      {
        method: 'GET',
        url: '/api/miner/invalid-miner-id',
        headers: {
          'X-API-Key': 'invalid-key'
        },
        assertions: [
          { type: 'status_code', expected: 401 }
        ]
      },
      {
        method: 'POST',
        url: '/api/payout/request',
        headers: {
          'X-API-Key': 'invalid-key',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          minerId: 'invalid-miner',
          amount: 0.001
        }),
        assertions: [
          { type: 'status_code', expected: 401 }
        ]
      }
    ]
  },

  /**
   * Rate limit testing
   */
  rateLimitTest: {
    name: 'Rate Limit Testing',
    weight: 3,
    users: 10,
    duration: 30000,
    thinkTime: 100, // Very fast requests to trigger rate limiting
    requests: [
      {
        method: 'GET',
        url: '/api/stats',
        assertions: [
          // Accept both success and rate limit responses
          { type: 'status_code', expected: [200, 429] }
        ]
      }
    ]
  },

  /**
   * Invalid input handling
   */
  invalidInputs: {
    name: 'Invalid Input Handling',
    weight: 2,
    users: 15,
    duration: 45000,
    thinkTime: 3000,
    requests: [
      {
        method: 'POST',
        url: '/api/dex/swap',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          tokenIn: 'INVALID_TOKEN',
          tokenOut: 'ANOTHER_INVALID',
          amountIn: -1,
          minAmountOut: 'not_a_number'
        }),
        assertions: [
          { type: 'status_code', expected: 400 }
        ]
      },
      {
        method: 'GET',
        url: '/api/miner/', // Empty miner ID
        assertions: [
          { type: 'status_code', expected: 404 }
        ]
      }
    ]
  }
};

/**
 * Get all predefined scenarios
 */
export function getAllScenarios() {
  return {
    ...MiningPoolScenarios,
    ...DEXScenarios,
    ...StressTestScenarios,
    ...EnduranceTestScenarios,
    ...ErrorTestScenarios
  };
}

/**
 * Get scenarios by category
 */
export function getScenariosByCategory(category) {
  switch (category.toLowerCase()) {
    case 'mining':
    case 'pool':
      return MiningPoolScenarios;
    case 'dex':
    case 'trading':
      return DEXScenarios;
    case 'stress':
      return StressTestScenarios;
    case 'endurance':
    case 'stability':
      return EnduranceTestScenarios;
    case 'error':
    case 'negative':
      return ErrorTestScenarios;
    default:
      return getAllScenarios();
  }
}

/**
 * Create a balanced test suite
 */
export function createBalancedTestSuite(options = {}) {
  const {
    includeMining = true,
    includeDEX = true,
    includeStress = false,
    includeEndurance = false,
    includeError = true,
    duration = 300000, // 5 minutes
    users = 100
  } = options;
  
  const scenarios = {};
  
  if (includeMining) {
    scenarios.healthCheck = MiningPoolScenarios.healthCheck;
    scenarios.poolStats = MiningPoolScenarios.poolStats;
    scenarios.minerData = MiningPoolScenarios.minerData;
  }
  
  if (includeDEX) {
    scenarios.liquidityPools = DEXScenarios.liquidityPools;
    scenarios.tokenSwap = DEXScenarios.tokenSwap;
  }
  
  if (includeStress) {
    scenarios.spikeLoad = StressTestScenarios.spikeLoad;
  }
  
  if (includeEndurance) {
    scenarios.stabilityTest = {
      ...EnduranceTestScenarios.stabilityTest,
      duration // Override with shorter duration for testing
    };
  }
  
  if (includeError) {
    scenarios.authFailures = ErrorTestScenarios.authFailures;
    scenarios.invalidInputs = ErrorTestScenarios.invalidInputs;
  }
  
  // Adjust user counts proportionally
  const totalWeight = Object.values(scenarios).reduce((sum, s) => sum + s.weight, 0);
  Object.values(scenarios).forEach(scenario => {
    scenario.users = Math.ceil((scenario.weight / totalWeight) * users);
    scenario.duration = duration;
  });
  
  return scenarios;
}

export default {
  MiningPoolScenarios,
  DEXScenarios,
  StressTestScenarios,
  EnduranceTestScenarios,
  ErrorTestScenarios,
  getAllScenarios,
  getScenariosByCategory,
  createBalancedTestSuite
};