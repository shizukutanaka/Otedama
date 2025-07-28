#!/usr/bin/env node
/**
 * Otedama Mining Pool Startup Script
 * Production-ready mining pool initialization with zero-knowledge authentication
 * 
 * Design principles:
 * - Carmack: Performance-first with minimal allocations
 * - Martin: Clean modular architecture
 * - Pike: Simple and reliable operation
 */

import { createStructuredLogger } from './lib/core/structured-logger.js';
import { EnhancedP2PMiningPool } from './lib/mining/enhanced-p2p-mining-pool.js';
import { SecuritySystem } from './lib/security/unified-security-system.js';
import { ZKPAuthSystem } from './lib/zkp/enhanced-zkp-system.js';
import { UnifiedAPIServer } from './lib/api/unified-api-server.js';
import { PerformanceOptimizer } from './lib/optimization/performance-optimizer.js';
import { UnifiedMonitoringSystem } from './lib/monitoring/unified-monitoring-system.js';
import { FinancialIntegrationSystem } from './lib/financial/financial-integration-system.js';
import { AlgorithmManager } from './lib/mining/algorithms/algorithm-manager-v2.js';
import { POOL_OPERATOR, MINING_ALGORITHMS } from './config/constants.js';
import { gracefulShutdown } from './lib/core/enhanced-error-recovery.js';
import { EnhancedOtedamaApplication } from './lib/core/enhanced-application.js';

const logger = createStructuredLogger('MiningPoolStarter');

/**
 * Production-ready mining pool startup with all integrations
 */
export default async function startMiningPool(config = {}) {
  logger.info('Starting Otedama Mining Pool with production configuration');
  
  try {
    // Validate required configuration
    const poolConfig = validateAndMergeConfig(config);
    
    // Initialize enhanced application with agent system
    const app = new EnhancedOtedamaApplication({
      port: poolConfig.pool.apiPort,
      wsPort: poolConfig.pool.wsPort || 3334,
      agentsEnabled: poolConfig.agents?.enabled !== false,
      monitoringInterval: poolConfig.agents?.monitoring?.interval || 30000,
      healthCheckInterval: poolConfig.agents?.health?.interval || 60000,
      securityInterval: poolConfig.agents?.security?.interval || 45000,
      optimizationInterval: poolConfig.agents?.optimization?.interval || 120000,
      healingInterval: poolConfig.agents?.healing?.interval || 90000,
      scalingInterval: poolConfig.agents?.scaling?.interval || 180000,
      predictiveScaling: poolConfig.agents?.scaling?.predictive !== false,
      cpuThreshold: poolConfig.agents?.monitoring?.cpuThreshold || 80,
      memoryThreshold: poolConfig.agents?.monitoring?.memoryThreshold || 85
    });

    // Initialize and start the enhanced application
    await app.initialize();
    await app.start();
    
    // Initialize core mining components with proper error handling
    const components = await initializeComponents(poolConfig);
    
    // Add the enhanced application to components
    components.app = app;
    
    // Start all services in the correct order
    await startServices(components, poolConfig);
    
    // Setup graceful shutdown
    setupShutdownHandlers(components);
    
    logger.info('Otedama Mining Pool started successfully', {
      algorithm: poolConfig.pool.algorithm,
      coin: poolConfig.pool.coin,
      stratumPort: poolConfig.pool.stratumPort,
      apiPort: poolConfig.pool.apiPort,
      zkpEnabled: poolConfig.zkp.enabled,
      agentsEnabled: poolConfig.agents?.enabled !== false,
      operatorAddress: POOL_OPERATOR.BTC_ADDRESS
    });
    
    return components;
    
  } catch (error) {
    logger.error('Failed to start mining pool', { error: error.message });
    throw error;
  }
}

/**
 * Validate and merge configuration with production defaults
 */
function validateAndMergeConfig(config) {
  const defaultConfig = {
    pool: {
      name: 'Otedama Mining Pool',
      algorithm: 'sha256',
      coin: 'BTC',
      stratumPort: 3333,
      apiPort: 8081,
      fee: 0.01, // 1%
      minPayout: 0.001,
      paymentScheme: 'PPLNS',
      operatorAddress: POOL_OPERATOR.BTC_ADDRESS,
      maxMiners: 1000000,
      maxConnections: 10000000
    },
    
    zkp: {
      enabled: true,
      requireAuth: false, // Allow anonymous mining
      complianceMode: 'minimal' // Minimal compliance for privacy
    },
    
    security: {
      rateLimiting: true,
      ddosProtection: true,
      antiSybil: true,
      ipWhitelist: [],
      maxFailedAttempts: 10
    },
    
    performance: {
      workers: require('os').cpus().length * 2,
      enableOptimizations: true,
      memoryLimit: '8GB',
      enableSIMD: true,
      zeroAllocMode: true
    },
    
    monitoring: {
      enabled: true,
      metricsInterval: 5000,
      alerting: true,
      prometheus: true
    },
    
    agents: {
      enabled: true,
      monitoring: {
        interval: 30000,
        cpuThreshold: 80,
        memoryThreshold: 85
      },
      health: {
        interval: 60000
      },
      security: {
        interval: 45000
      },
      optimization: {
        interval: 120000
      },
      healing: {
        interval: 90000
      },
      scaling: {
        interval: 180000,
        predictive: true
      }
    },
    
    financial: {
      autoBTCConversion: true,
      taxCompliance: true,
      multiExchange: true,
      dexIntegration: true
    },
    
    network: {
      p2p: true,
      maxPeers: 100,
      discovery: true,
      nat: true
    }
  };
  
  // Deep merge configuration
  const mergedConfig = mergeDeep(defaultConfig, config);
  
  // Validate critical settings
  if (!MINING_ALGORITHMS[mergedConfig.pool.algorithm]) {
    throw new Error(`Unsupported mining algorithm: ${mergedConfig.pool.algorithm}`);
  }
  
  if (mergedConfig.pool.stratumPort < 1024 || mergedConfig.pool.stratumPort > 65535) {
    throw new Error('Invalid stratum port range');
  }
  
  if (mergedConfig.pool.fee < 0 || mergedConfig.pool.fee > 1) {
    throw new Error('Pool fee must be between 0 and 1 (0-100%)');
  }
  
  return mergedConfig;
}

/**
 * Initialize all system components
 */
async function initializeComponents(config) {
  logger.info('Initializing mining pool components');
  
  const components = {};
  
  try {
    // 1. Performance optimizer - must be first
    components.performanceOptimizer = new PerformanceOptimizer({
      ...config.performance,
      enableSIMD: true,
      zeroAllocMode: true,
      adaptiveMemory: true
    });
    await components.performanceOptimizer.initialize();
    logger.info('Performance optimizer initialized');
    
    // 2. Security system with ZKP
    components.zkpAuth = new ZKPAuthSystem({
      ...config.zkp,
      operatorAddress: POOL_OPERATOR.BTC_ADDRESS,
      enableCompliance: true
    });
    await components.zkpAuth.initialize();
    logger.info('ZKP authentication system initialized');
    
    components.security = new SecuritySystem({
      ...config.security,
      zkpIntegration: components.zkpAuth,
      operatorProtection: true
    });
    await components.security.initialize();
    logger.info('Security system initialized');
    
    // 3. Algorithm manager
    components.algorithmManager = new AlgorithmManager({
      algorithm: config.pool.algorithm,
      enableOptimizations: true,
      simdAcceleration: true,
      multiThreaded: true
    });
    await components.algorithmManager.initialize();
    logger.info('Algorithm manager initialized');
    
    // 4. Financial integration system
    components.financial = new FinancialIntegrationSystem({
      ...config.financial,
      operatorBtcAddress: POOL_OPERATOR.BTC_ADDRESS,
      autoConversion: true,
      taxCompliance: true
    });
    await components.financial.initialize();
    logger.info('Financial integration system initialized');
    
    // 5. Core mining pool
    components.miningPool = new EnhancedP2PMiningPool({
      ...config.pool,
      algorithmManager: components.algorithmManager,
      security: components.security,
      zkpAuth: components.zkpAuth,
      financial: components.financial,
      performanceOptimizer: components.performanceOptimizer
    });
    await components.miningPool.initialize();
    logger.info('Enhanced P2P mining pool initialized');
    
    // 6. Monitoring system
    components.monitoring = new UnifiedMonitoringSystem({
      ...config.monitoring,
      miningPool: components.miningPool,
      security: components.security,
      financial: components.financial
    });
    await components.monitoring.initialize();
    logger.info('Monitoring system initialized');
    
    // 7. API server (last)
    components.apiServer = new UnifiedAPIServer({
      port: config.pool.apiPort,
      miningPool: components.miningPool,
      zkpAuth: components.zkpAuth,
      monitoring: components.monitoring,
      financial: components.financial,
      security: components.security
    });
    await components.apiServer.initialize();
    logger.info('API server initialized');
    
    return components;
    
  } catch (error) {
    logger.error('Component initialization failed', { error: error.message });
    await cleanupComponents(components);
    throw error;
  }
}

/**
 * Start all services in the correct order
 */
async function startServices(components, config) {
  logger.info('Starting mining pool services');
  
  try {
    // Start services in dependency order
    await components.performanceOptimizer.start();
    await components.security.start();
    await components.zkpAuth.start();
    await components.algorithmManager.start();
    await components.financial.start();
    await components.miningPool.start();
    await components.monitoring.start();
    await components.apiServer.start();
    
    // Display startup information
    displayStartupInfo(config, components);
    
  } catch (error) {
    logger.error('Service startup failed', { error: error.message });
    await stopServices(components);
    throw error;
  }
}

/**
 * Display startup information
 */
function displayStartupInfo(config, components) {
  const info = {
    poolName: config.pool.name,
    algorithm: config.pool.algorithm,
    coin: config.pool.coin,
    stratumPort: config.pool.stratumPort,
    apiPort: config.pool.apiPort,
    operatorAddress: POOL_OPERATOR.BTC_ADDRESS,
    zkpEnabled: config.zkp.enabled,
    maxMiners: config.pool.maxMiners.toLocaleString(),
    performance: {
      workers: config.performance.workers,
      simdEnabled: config.performance.enableSIMD,
      zeroAllocMode: config.performance.zeroAllocMode
    }
  };
  
  console.log('\n' + '='.repeat(80));
  console.log('🚀 OTEDAMA MINING POOL SUCCESSFULLY STARTED');
  console.log('='.repeat(80));
  console.log(`Pool Name: ${info.poolName}`);
  console.log(`Algorithm: ${info.algorithm.toUpperCase()}`);
  console.log(`Coin: ${info.coin}`);
  console.log(`Stratum: stratum+tcp://localhost:${info.stratumPort}`);
  console.log(`API: http://localhost:${info.apiPort}`);
  console.log(`Operator: ${info.operatorAddress}`);
  console.log(`ZKP Auth: ${info.zkpEnabled ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Max Miners: ${info.maxMiners}`);
  console.log(`Workers: ${info.performance.workers}`);
  console.log(`SIMD: ${info.performance.simdEnabled ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Zero-Alloc: ${info.performance.zeroAllocMode ? 'ENABLED' : 'DISABLED'}`);
  console.log('='.repeat(80));
  console.log('🎯 Ready for miners! Connect using your wallet address as username.');
  console.log('💡 Zero-Knowledge Proof authentication provides privacy without KYC.');
  console.log('📊 Real-time monitoring available at the API endpoint.');
  console.log('='.repeat(80) + '\n');
}

/**
 * Setup graceful shutdown handlers
 */
function setupShutdownHandlers(components) {
  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    
    try {
      await stopServices(components);
      await cleanupComponents(components);
      
      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', { error: error.message });
      process.exit(1);
    }
  };
  
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Promise Rejection', { reason, promise });
  });
  
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', { error: error.message });
    shutdown('UNCAUGHT_EXCEPTION');
  });
}

/**
 * Stop all services in reverse order
 */
async function stopServices(components) {
  const stopOrder = ['apiServer', 'monitoring', 'miningPool', 'financial', 'algorithmManager', 'zkpAuth', 'security', 'performanceOptimizer', 'app'];
  
  for (const componentName of stopOrder) {
    if (components[componentName]?.stop) {
      try {
        await components[componentName].stop();
        logger.info(`${componentName} stopped`);
      } catch (error) {
        logger.error(`Error stopping ${componentName}`, { error: error.message });
      }
    }
  }
}

/**
 * Clean up all components
 */
async function cleanupComponents(components) {
  for (const [name, component] of Object.entries(components)) {
    if (component?.cleanup) {
      try {
        await component.cleanup();
      } catch (error) {
        logger.error(`Error cleaning up ${name}`, { error: error.message });
      }
    }
  }
}

/**
 * Deep merge utility function
 */
function mergeDeep(target, source) {
  const result = { ...target };
  
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = mergeDeep(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  
  return result;
}