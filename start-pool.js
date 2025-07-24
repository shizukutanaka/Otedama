#!/usr/bin/env node

/**
 * Otedama Mining Pool Startup Script
 * Production-ready entry point for the enhanced pool manager
 */

const EnhancedPoolManager = require('./lib/pool/pool-manager-enhanced');
const { createLogger } = require('./lib/core/logger');
const verifyFeeIntegrity = require('./scripts/verify-fee-integrity');
const fs = require('fs').promises;
const path = require('path');
const { program } = require('commander');

const logger = createLogger('pool-startup');

// Parse command line arguments
program
  .version('1.0.0')
  .option('-c, --config <path>', 'Path to configuration file', './config/pool-manager-config.json')
  .option('-p, --port <port>', 'Stratum server port')
  .option('-d, --database <url>', 'Database connection URL')
  .option('--testnet', 'Use testnet')
  .option('--verbose', 'Verbose logging')
  .parse(process.argv);

const options = program.opts();

/**
 * Load configuration
 */
async function loadConfig() {
  try {
    const configPath = path.resolve(options.config);
    const configData = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configData);
    
    // Override with command line options
    if (options.port) {
      config.pool.stratum.port = parseInt(options.port);
    }
    
    if (options.testnet) {
      config.pool.blockchain.network = 'testnet';
    }
    
    if (options.verbose) {
      config.development.verboseLogging = true;
    }
    
    return config;
  } catch (error) {
    logger.error('Failed to load configuration:', error);
    throw error;
  }
}

/**
 * Validate configuration
 */
function validateConfig(config) {
  const required = [
    'pool.name',
    'pool.stratum.port',
    'pool.blockchain.node.host',
    'pool.database.host',
    'pool.wallet.encryptionKey'
  ];
  
  for (const path of required) {
    const value = path.split('.').reduce((obj, key) => obj?.[key], config);
    if (!value) {
      throw new Error(`Missing required configuration: ${path}`);
    }
  }
  
  // Check for default values that should be changed
  if (config.pool.wallet.encryptionKey === 'CHANGE_THIS_TO_SECURE_KEY') {
    throw new Error('Please set a secure wallet encryption key in the configuration');
  }
  
  if (config.pool.database.password === 'CHANGE_THIS_PASSWORD') {
    throw new Error('Please set a secure database password in the configuration');
  }
}

/**
 * Start the pool
 */
async function startPool() {
  try {
    logger.info('Starting Otedama Mining Pool...');
    
    // Verify fee integrity before starting
    logger.info('Verifying fee configuration integrity...');
    const integrityPassed = await verifyFeeIntegrity();
    
    if (!integrityPassed) {
      logger.error('CRITICAL: Fee configuration integrity check failed!');
      logger.error('The pool cannot start with tampered fee configuration.');
      process.exit(1);
    }
    
    logger.info('✅ Fee configuration integrity verified');
    
    // Load configuration
    const config = await loadConfig();
    
    // Validate configuration
    validateConfig(config);
    
    // Create pool manager instance
    const poolManager = new EnhancedPoolManager({
      poolName: config.pool.name,
      poolUrl: config.pool.url,
      
      // Stratum settings
      stratumPort: config.pool.stratum.port,
      stratumHost: config.pool.stratum.host,
      maxMiners: config.pool.stratum.maxConnections,
      
      // Blockchain settings
      coin: config.pool.blockchain.coin,
      network: config.pool.blockchain.network,
      blockchainNode: `http://${config.pool.blockchain.node.host}:${config.pool.blockchain.node.port}`,
      rpcUser: config.pool.blockchain.node.user,
      rpcPassword: config.pool.blockchain.node.password,
      
      // Payment settings
      paymentScheme: config.pool.payment.scheme,
      pplnsWindow: config.pool.payment.window,
      pplnsWindowType: config.pool.payment.windowType,
      poolFee: config.pool.payment.poolFee,
      minimumPayment: config.pool.payment.minimumPayout,
      
      // Security settings
      ddosProtection: config.pool.security.ddosProtection,
      banDuration: config.pool.security.banDuration,
      
      // Performance settings
      shareValidationWorkers: config.pool.performance.shareValidationWorkers,
      vardiffEnabled: config.pool.performance.vardiff.enabled,
      vardiffTarget: config.pool.performance.vardiff.targetTime,
      
      // Database settings
      database: config.pool.database,
      
      // Wallet settings
      walletEncryptionKey: config.pool.wallet.encryptionKey,
      hotWalletMax: config.pool.wallet.hotWalletMax,
      coldWalletAddress: config.pool.wallet.coldWalletAddress,
      
      // Monitoring settings
      statsInterval: config.pool.monitoring.statsInterval,
      healthCheckInterval: config.pool.monitoring.healthCheckInterval,
      
      // Auto-scaling
      autoScaling: config.pool.autoScaling.enabled,
      scaleUpThreshold: config.pool.autoScaling.scaleUpThreshold,
      scaleDownThreshold: config.pool.autoScaling.scaleDownThreshold
    });
    
    // Set up event handlers
    poolManager.on('initialized', () => {
      logger.info('Pool manager initialized successfully');
    });
    
    poolManager.on('miner-connected', (miner) => {
      logger.info(`Miner connected: ${miner.address || miner.id}`);
    });
    
    poolManager.on('block-found', (block) => {
      logger.info(`🎉 BLOCK FOUND! Height: ${block.height}, Miner: ${block.miner.address}`);
    });
    
    poolManager.on('block-confirmed', (block) => {
      logger.info(`✅ Block confirmed: ${block.height}`);
    });
    
    poolManager.on('stats', (stats) => {
      if (config.development.verboseLogging) {
        logger.info('Pool statistics:', stats);
      }
    });
    
    poolManager.on('health-degraded', (health) => {
      logger.error('Pool health degraded:', health);
    });
    
    poolManager.on('alert', (alert) => {
      logger.warn(`Alert: ${alert.type} - ${alert.message}`);
    });
    
    // Initialize the pool
    await poolManager.initialize();
    
    // Log startup information
    logger.info('=====================================');
    logger.info(`Pool: ${config.pool.name}`);
    logger.info(`Stratum: ${config.pool.stratum.host}:${config.pool.stratum.port}`);
    logger.info(`Network: ${config.pool.blockchain.network}`);
    logger.info(`Payment: ${config.pool.payment.scheme}`);
    logger.info(`Pool Fee: ${config.pool.payment.poolFee * 100}%`);
    logger.info('=====================================');
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Shutting down pool...');
      await poolManager.shutdown();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      logger.info('Shutting down pool...');
      await poolManager.shutdown();
      process.exit(0);
    });
    
    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error);
      process.exit(1);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });
    
  } catch (error) {
    logger.error('Failed to start pool:', error);
    process.exit(1);
  }
}

// Start the pool
startPool();