#!/usr/bin/env node
/**
 * Otedama Mining Pool - Production Startup
 * High-performance P2P mining pool with advanced features
 * 
 * Design:
 * - Carmack: Performance-first architecture
 * - Martin: Clean separation of concerns
 * - Pike: Simple but powerful implementation
 */

import { createLogger, gracefulShutdown, getErrorHandler } from './lib/core/index.js';
import { EnhancedP2PMiningPool } from './lib/mining/enhanced-p2p-mining-pool.js';
import { configManager } from './lib/core/config-manager.js';
import { healthCheckManager } from './lib/core/health-check.js';
import { profiler } from './lib/core/profiler.js';
import { EnhancedZKPSystem } from './lib/zkp/enhanced-zkp-system.js';
import cluster from 'cluster';
import os from 'os';
import { fileURLToPath } from 'url';
import path from 'path';
import { Command } from 'commander';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize logger
const logger = createLogger('OtedamaMain');

// Initialize error handler globally
const errorHandler = getErrorHandler({ global: true });

// Parse command line arguments
const program = new Command();

program
  .name('otedama-pool')
  .description('Otedama - Professional P2P Mining Pool Platform')
  .version('1.0.0')
  .option('-c, --config <file>', 'Configuration file', './otedama.config.js')
  .option('-m, --mode <mode>', 'Pool operating mode (standalone/cluster)', 'cluster')
  .option('-p, --port <port>', 'Stratum port', parseInt, 3333)
  .option('--stratum-v2-port <port>', 'Stratum V2 port', parseInt, 3336)
  .option('--api-port <port>', 'API port', parseInt, 8080)
  .option('--p2p-port <port>', 'P2P federation port', parseInt, 8333)
  .option('-a, --algorithm <algo>', 'Mining algorithm', 'sha256')
  .option('-s, --scheme <scheme>', 'Payment scheme (PPLNS/PPS/PROP/SOLO)', 'PPLNS')
  .option('-f, --fee <fee>', 'Pool fee percentage', parseFloat, 1.0)
  .option('--min-payment <amount>', 'Minimum payment threshold', parseFloat, 0.001)
  .option('--no-p2p', 'Disable P2P federation')
  .option('--no-stratum-v2', 'Disable Stratum V2')
  .option('--no-asic', 'Disable ASIC support')
  .option('--workers <n>', 'Number of worker processes', parseInt)
  .option('--enable-profit-switching', 'Enable profit switching')
  .option('--enable-zkp', 'Enable Zero-Knowledge Proof compliance')
  .option('--zkp-only', 'Require ZKP for all miners')
  .parse();

const options = program.opts();

/**
 * Load and validate configuration
 */
async function loadConfiguration() {
  try {
    // Load config from multiple sources
    await configManager.load({
      files: [
        path.join(__dirname, options.config || 'otedama.config.js'),
        path.join(__dirname, '.env')
      ],
      validate: true
    });
    
    const config = configManager.getAll();
    
    // Override with command line options
    if (options.port) config.stratumPort = options.port;
    if (options.stratumV2Port) config.stratumV2Port = options.stratumV2Port;
    if (options.apiPort) config.apiPort = options.apiPort;
    if (options.p2pPort) config.p2pPort = options.p2pPort;
    if (options.algorithm) config.algorithm = options.algorithm;
    if (options.scheme) config.paymentScheme = options.scheme;
    if (options.fee) config.poolFee = options.fee / 100;
    if (options.minPayment) config.minimumPayment = options.minPayment;
    if (options.workers) config.workers = options.workers;
    if (!options.p2p) config.p2pEnabled = false;
    if (!options.stratumV2) config.stratumV2Enabled = false;
    if (!options.asic) config.enableASICMining = false;
    if (options.enableProfitSwitching) config.enableProfitSwitching = true;
    if (options.enableZkp) config.enableZKP = true;
    if (options.zkpOnly) {
      config.enableZKP = true;
      config.requireZKP = true;
    }
    
    // Validate required fields
    const required = ['poolAddress', 'poolName'];
    for (const field of required) {
      if (!config[field]) {
        throw new Error(`Missing required configuration: ${field}`);
      }
    }
    
    logger.info('Configuration loaded successfully');
    return config;
    
  } catch (error) {
    logger.error('Failed to load configuration', error);
    throw error;
  }
}

/**
 * Start worker process
 */
async function startWorker(config) {
  const workerId = cluster.worker?.id || 0;
  logger.info(`Starting worker ${workerId}`);
  
  try {
    // Initialize ZKP system if enabled
    let zkpSystem = null;
    if (config.enableZKP) {
      zkpSystem = new EnhancedZKPSystem({
        dbFile: path.join(__dirname, 'data/zkp-enhanced.db'),
        ...config.zkp
      });
      await zkpSystem.initialize();
      logger.info('Zero-Knowledge Proof system initialized');
    }
    
    // Create enhanced mining pool
    const pool = new EnhancedP2PMiningPool({
      ...config,
      workerId,
      mode: options.mode,
      zkpSystem
    });
    
    // Setup health checks
    healthCheckManager.register('pool', async () => {
      const info = pool.getPoolInfo();
      return {
        healthy: pool.initialized,
        details: info
      };
    });
    
    // Setup profiling
    if (config.profiling) {
      profiler.start();
      pool.on('share:accepted', () => {
        profiler.mark('share_accepted');
      });
    }
    
    // Initialize pool
    await pool.initialize();
    
    logger.info(`Worker ${workerId} started successfully`);
    
    // Setup graceful shutdown
    gracefulShutdown(async () => {
      logger.info(`Worker ${workerId} shutting down...`);
      await pool.shutdown();
      
      if (zkpSystem) {
        await zkpSystem.shutdown();
      }
      
      if (config.profiling) {
        const report = profiler.getReport();
        logger.info('Performance report', report);
      }
    });
    
    return pool;
    
  } catch (error) {
    logger.error(`Worker ${workerId} failed to start`, error);
    throw error;
  }
}

/**
 * Start master process
 */
async function startMaster(config) {
  logger.info('Starting Otedama Mining Pool (Master)');
  
  const numWorkers = config.workers || os.cpus().length;
  
  // Fork workers
  for (let i = 0; i < numWorkers; i++) {
    cluster.fork();
  }
  
  // Handle worker events
  cluster.on('exit', (worker, code, signal) => {
    logger.error(`Worker ${worker.process.pid} died (${signal || code})`);
    
    // Restart worker
    if (config.autoRestart !== false) {
      logger.info('Starting replacement worker...');
      cluster.fork();
    }
  });
  
  cluster.on('online', (worker) => {
    logger.info(`Worker ${worker.process.pid} is online`);
  });
  
  // Setup master health check
  healthCheckManager.register('master', async () => {
    const workers = Object.values(cluster.workers || {});
    return {
      healthy: workers.length > 0,
      details: {
        workers: workers.length,
        targetWorkers: numWorkers
      }
    };
  });
  
  // Start health check server
  if (config.healthCheckPort) {
    const { createServer } = await import('http');
    const server = createServer(async (req, res) => {
      if (req.url === '/health') {
        const health = await healthCheckManager.check();
        res.statusCode = health.healthy ? 200 : 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(health));
      } else {
        res.statusCode = 404;
        res.end('Not Found');
      }
    });
    
    server.listen(config.healthCheckPort, () => {
      logger.info(`Health check server listening on port ${config.healthCheckPort}`);
    });
  }
  
  // Setup graceful shutdown
  gracefulShutdown(async () => {
    logger.info('Master process shutting down...');
    
    // Disconnect workers
    for (const worker of Object.values(cluster.workers || {})) {
      worker.disconnect();
    }
  });
}

/**
 * Display startup banner
 */
function displayBanner() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║                           OTEDAMA MINING POOL                             ║
║                                                                           ║
║                    Professional P2P Mining Platform                       ║
║                     High Performance • Reliable • Secure                  ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
  `);
}

/**
 * Display help
 */
program.on('--help', () => {
  console.log('');
  console.log('Examples:');
  console.log('  $ node start-mining-pool.js');
  console.log('  $ node start-mining-pool.js --mode standalone');
  console.log('  $ node start-mining-pool.js --mode cluster --workers 4');
  console.log('  $ node start-mining-pool.js --algorithm scrypt --scheme PPS');
  console.log('  $ node start-mining-pool.js --config ./custom-pool.json');
  console.log('  $ node start-mining-pool.js --enable-profit-switching');
  console.log('');
  console.log('Environment Variables:');
  console.log('  POOL_NAME               Pool name');
  console.log('  POOL_ADDRESS            Pool wallet address');
  console.log('  BITCOIN_RPC_URL         Bitcoin RPC URL');
  console.log('  BITCOIN_RPC_USER        Bitcoin RPC username');
  console.log('  BITCOIN_RPC_PASSWORD    Bitcoin RPC password');
  console.log('');
  console.log('ZKP Options:');
  console.log('  --enable-zkp            Enable Zero-Knowledge Proof compliance');
  console.log('  --zkp-only              Require ZKP verification for all miners');
});

/**
 * Main entry point
 */
async function main() {
  try {
    displayBanner();
    
    // Load configuration
    const config = await loadConfiguration();
    
    // Determine mode
    const mode = options.mode || config.mode || 'cluster';
    
    if (mode === 'cluster' && cluster.isMaster) {
      // Master process
      await startMaster(config);
    } else if (mode === 'standalone' || cluster.isWorker) {
      // Worker process or standalone
      await startWorker(config);
    } else {
      throw new Error(`Invalid mode: ${mode}`);
    }
    
  } catch (error) {
    logger.error('Fatal error during startup', error);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason, promise });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', error);
  process.exit(1);
});

// Start the application
main().catch((error) => {
  console.error('Failed to start Otedama:', error);
  process.exit(1);
});
