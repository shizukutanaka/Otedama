#!/usr/bin/env node
/**
 * Otedama - High-Performance P2P Mining Pool
 * Main entry point focused on practical mining pool functionality
 * 
 * Design principles:
 * - Carmack: Performance-first architecture with zero-allocation patterns
 * - Martin: Clean modular design with single responsibility
 * - Pike: Simple and effective implementation
 * 
 * Features:
 * - Multi-algorithm support (SHA256, Scrypt, Ethash, RandomX, KawPow)
 * - CPU/GPU/ASIC compatibility
 * - Zero-knowledge proof authentication (replaces KYC)
 * - High-availability P2P architecture
 * - Real-time monitoring and statistics
 * - Stratum V1/V2 protocol support
 */

import { createStructuredLogger } from './lib/core/structured-logger.js';
import { secureConfig } from './lib/core/secure-config.js';
import { validateConstants, POOL_OPERATOR } from './config/constants.js';
import { Command } from 'commander';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

// Initialize logger
const logger = createStructuredLogger('Otedama');

// Parse command line arguments
const program = new Command();

program
  .name('otedama')
  .description('High-Performance P2P Mining Pool with Zero-Knowledge Authentication')
  .option('-m, --mode <mode>', 'Operation mode (pool, miner, benchmark, monitor)', 'pool')
  .option('-c, --config <file>', 'Configuration file', './otedama.config.js')
  .option('--algorithm <algo>', 'Mining algorithm (sha256, scrypt, ethash, randomx, kawpow)', 'sha256')
  .option('--coin <coin>', 'Initial coin to mine', 'BTC')
  .option('--stratum-port <port>', 'Stratum server port', '3333')
  .option('--api-port <port>', 'API server port', '8081')
  .parse();

const options = program.opts();

/**
 * Display banner
 */
function displayBanner() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║                              OTEDAMA                                      ║
║                                                                           ║
║          National-Scale Professional Mining Platform                      ║
║                                                                           ║
║     Architecture: Carmack Performance • Martin Clean Code • Pike Simple  ║
║                                                                           ║
║     Features: Multi-Algorithm • CPU/GPU/ASIC • ZKP Auth • National Scale ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
  `);
}

/**
 * Main application
 */
async function main() {
  try {
    displayBanner();
    
    // Load secure configuration
    await secureConfig.initialize({
      files: [
        path.join(__dirname, options.config),
        path.join(__dirname, '.env')
      ],
      validate: true
    });
    
    const config = secureConfig.getAll();
    
    // Validate immutable constants
    try {
      validateConstants();
      logger.info(`Pool operator BTC address: ${POOL_OPERATOR.BTC_ADDRESS}`);
    } catch (error) {
      logger.error('FATAL: Constants validation failed:', error);
      process.exit(1);
    }
    
    logger.info('Starting Otedama v1.1.3...', {
      mode: options.mode,
      algorithm: options.algorithm,
      coin: options.coin,
      stratumPort: options.stratumPort,
      apiPort: options.apiPort,
      nodeEnv: process.env.NODE_ENV
    });
    
    // Start based on mode
    switch (options.mode) {
      case 'pool':
        await startMiningPool(config);
        break;
        
      case 'miner':
        await startMiner(config);
        break;
        
      case 'benchmark':
        await runBenchmark();
        break;
        
      case 'monitor':
        await startMonitor(config);
        break;
        
      default:
        logger.error(`Unknown mode: ${options.mode}`);
        process.exit(1);
    }
    
  } catch (error) {
    logger.error('Fatal error:', error);
    process.exit(1);
  }
}

/**
 * Start mining pool
 */
async function startMiningPool(config) {
  // Merge CLI options with config
  const poolConfig = {
    ...config,
    pool: {
      ...config.pool,
      algorithm: options.algorithm,
      coin: options.coin,
      stratumPort: parseInt(options.stratumPort) || 3333,
      apiPort: parseInt(options.apiPort) || 8081
    },
    zkp: {
      enabled: true, // Zero-knowledge proofs always enabled
      ...config.zkp
    }
  };
  
  const { default: startPool } = await import('./start-mining-pool.js');
  await startPool(poolConfig);
}

/**
 * Start miner
 */
async function startMiner(config) {
  const { default: startMiner } = await import('./otedama-miner.js');
  await startMiner(config);
}

/**
 * Run benchmark
 */
async function runBenchmark() {
  const { default: runBenchmark } = await import('./scripts/performance-benchmark.js');
  await runBenchmark();
}

/**
 * Start monitor
 */
async function startMonitor(config) {
  const { default: startMonitor } = await import('./scripts/monitor.js');
  await startMonitor(config);
}

// Enhanced process signal handling with graceful shutdown
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  
  isShuttingDown = true;
  logger.info(`Received ${signal}, initiating graceful shutdown...`);
  
  try {
    // Import and cleanup object pools
    const { miningPools } = await import('./lib/core/optimized-object-pool.js');
    logger.info('Cleaning up object pools...');
    miningPools.clearAll();
    
    // Import and shutdown error recovery
    const { errorRecovery } = await import('./lib/core/enhanced-error-recovery.js');
    logger.info('Shutting down error recovery system...');
    errorRecovery.shutdown();
    
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', async (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  
  // Use enhanced error recovery for unhandled rejections
  try {
    const { errorRecovery } = await import('./lib/core/enhanced-error-recovery.js');
    const { OtedamaError, ErrorCategory } = await import('./lib/core/error-handler-unified.js');
    
    const error = new OtedamaError('Unhandled Promise Rejection', {
      category: ErrorCategory.SYSTEM,
      context: { reason: reason?.toString(), promise: promise?.toString() }
    });
    
    await errorRecovery.handleError(error, 'unhandled-rejection');
  } catch (recoveryError) {
    logger.error('Failed to handle unhandled rejection:', recoveryError);
  }
});

process.on('uncaughtException', async (error) => {
  logger.error('Uncaught Exception:', error);
  
  try {
    const { errorRecovery } = await import('./lib/core/enhanced-error-recovery.js');
    const { OtedamaError, ErrorCategory } = await import('./lib/core/error-handler-unified.js');
    
    const otedamaError = new OtedamaError('Uncaught Exception', {
      category: ErrorCategory.SYSTEM,
      context: { 
        message: error.message,
        stack: error.stack,
        name: error.name
      }
    });
    
    const result = await errorRecovery.handleError(otedamaError, 'uncaught-exception');
    
    if (!result.recovered) {
      logger.error('Failed to recover from uncaught exception, exiting...');
      process.exit(1);
    }
  } catch (recoveryError) {
    logger.error('Failed to handle uncaught exception:', recoveryError);
    process.exit(1);
  }
});

// Show help
program.on('--help', () => {
  console.log('');
  console.log('Examples:');
  console.log('  $ otedama                       # Start mining pool (default)');
  console.log('  $ otedama --mode pool           # Start mining pool');
  console.log('  $ otedama --mode miner          # Start miner client');
  console.log('  $ otedama --mode benchmark      # Run performance benchmark');
  console.log('  $ otedama --mode monitor        # Start monitoring dashboard');
  console.log('  $ otedama --algorithm scrypt    # Use Scrypt algorithm');
  console.log('  $ otedama --coin LTC            # Mine Litecoin');
  console.log('  $ otedama --stratum-port 4444   # Custom stratum port');
  console.log('');
  console.log('Environment Variables:');
  console.log('  POOL_NAME               Pool name');
  console.log('  POOL_ADDRESS            Pool wallet address');
  console.log('  BITCOIN_RPC_URL         Bitcoin RPC URL');
  console.log('  BITCOIN_RPC_USER        Bitcoin RPC username');
  console.log('  BITCOIN_RPC_PASSWORD    Bitcoin RPC password');
  console.log('  STRATUM_PORT            Default stratum port');
  console.log('  API_PORT                Default API port');
  console.log('  ZKP_ENABLED             Enable ZKP authentication (true/false)');
  console.log('');
  console.log('For more information, see README.md');
});

// Run application
main().catch(error => {
  console.error('Failed to start Otedama:', error);
  process.exit(1);
});
