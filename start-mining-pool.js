#!/usr/bin/env node

/**
 * Otedama P2P Mining Pool - Integrated Startup Script
 * Launches the complete P2P mining pool with all advanced features
 */

import { IntegratedMiningPoolSystem } from './lib/mining/integrated-pool-system.js';
import { MiningAnalyticsDashboard } from './lib/monitoring/mining-analytics-dashboard.js';
import { FaultToleranceSystem } from './lib/mining/fault-tolerance-system.js';
import { createLogger } from './lib/core/logger.js';
import dotenv from 'dotenv';
import { cpus } from 'os';

// Load environment variables
dotenv.config();

const logger = createLogger('mining-pool-startup');

// Configuration
const config = {
  // Pool identity
  poolName: process.env.POOL_NAME || 'Otedama P2P Mining Pool',
  nodeId: process.env.NODE_ID || generateNodeId(),
  
  // Network configuration
  p2pPort: parseInt(process.env.P2P_PORT) || 3333,
  stratumPort: parseInt(process.env.STRATUM_PORT) || 3334,
  apiPort: parseInt(process.env.API_PORT) || 8080,
  dashboardPort: parseInt(process.env.DASHBOARD_PORT) || 8081,
  
  // Bootstrap nodes (comma-separated)
  bootstrapNodes: process.env.BOOTSTRAP_NODES ? 
    process.env.BOOTSTRAP_NODES.split(',').map(n => {
      const [address, port] = n.trim().split(':');
      return {
        address,
        port: parseInt(port) || 3333,
        id: generateNodeIdFromAddress(address)
      };
    }) : [],
  
  // Consensus configuration
  consensus: {
    byzantineNodes: parseFloat(process.env.BYZANTINE_NODES) || 0.33,
    checkpointInterval: parseInt(process.env.CHECKPOINT_INTERVAL) || 100,
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT) || 5000
  },
  
  // DHT configuration
  dht: {
    k: parseInt(process.env.DHT_K) || 20,
    alpha: parseInt(process.env.DHT_ALPHA) || 3,
    refreshInterval: parseInt(process.env.DHT_REFRESH) || 3600000
  },
  
  // Mining configuration
  mining: {
    algorithm: process.env.MINING_ALGORITHM || 'auto',
    coin: process.env.MINING_COIN || 'auto',
    autoSelectAlgorithm: process.env.AUTO_SELECT_ALGORITHM !== 'false',
    profitSwitching: process.env.PROFIT_SWITCHING !== 'false',
    gpuMining: process.env.GPU_MINING !== 'false',
    cpuMining: process.env.CPU_MINING !== 'false',
    electricityCost: parseFloat(process.env.ELECTRICITY_COST) || 0.1 // $/kWh
  },
  
  // Performance configuration
  performance: {
    workerThreads: parseInt(process.env.WORKER_THREADS) || cpus().length,
    maxConnections: parseInt(process.env.MAX_CONNECTIONS) || 10000,
    shareValidationBatchSize: parseInt(process.env.SHARE_BATCH_SIZE) || 100
  },
  
  // Fault tolerance
  faultTolerance: {
    enabled: process.env.FAULT_TOLERANCE !== 'false',
    minActiveNodes: parseInt(process.env.MIN_ACTIVE_NODES) || 3,
    replicationFactor: parseInt(process.env.REPLICATION_FACTOR) || 3
  },
  
  // Monitoring
  monitoring: {
    enabled: process.env.MONITORING !== 'false',
    metricsRetention: parseInt(process.env.METRICS_RETENTION) || 86400000 // 24 hours
  }
};

// System components
let poolSystem = null;
let dashboard = null;
let faultTolerance = null;

// Graceful shutdown handler
let isShuttingDown = false;

async function startMiningPool() {
  try {
    logger.info('===================================');
    logger.info(`Starting ${config.poolName}`);
    logger.info('===================================');
    logger.info(`Node ID: ${config.nodeId}`);
    logger.info(`P2P Port: ${config.p2pPort}`);
    logger.info(`Stratum Port: ${config.stratumPort}`);
    logger.info(`Dashboard: http://localhost:${config.dashboardPort}`);
    logger.info('-----------------------------------');
    
    // Initialize integrated pool system
    logger.info('Initializing integrated mining pool system...');
    poolSystem = new IntegratedMiningPoolSystem(config);
    await poolSystem.initialize();
    
    // Initialize fault tolerance if enabled
    if (config.faultTolerance.enabled) {
      logger.info('Initializing fault tolerance system...');
      faultTolerance = new FaultToleranceSystem(config.faultTolerance);
      await faultTolerance.initialize(poolSystem);
      
      // Handle critical failures
      faultTolerance.on('critical-failure', (data) => {
        logger.error('CRITICAL FAILURE DETECTED:', data);
        if (data.action === 'system-restart-required') {
          gracefulShutdown('critical-failure');
        }
      });
    }
    
    // Initialize monitoring dashboard if enabled
    if (config.monitoring.enabled) {
      logger.info('Initializing analytics dashboard...');
      dashboard = new MiningAnalyticsDashboard({
        httpPort: config.dashboardPort,
        wsPort: config.dashboardPort + 1,
        metricsRetention: config.monitoring.metricsRetention
      });
      await dashboard.initialize(poolSystem);
    }
    
    // Set up event handlers
    setupEventHandlers();
    
    // Log startup information
    logStartupInfo();
    
    logger.info('===================================');
    logger.info('Mining pool started successfully!');
    logger.info('===================================');
    
    // Start accepting connections
    logger.info('Ready to accept miner connections');
    
  } catch (error) {
    logger.error('Failed to start mining pool:', error);
    process.exit(1);
  }
}

function setupEventHandlers() {
  // Pool system events
  poolSystem.on('miner-connected', (data) => {
    logger.info(`Miner connected: ${data.worker} (${data.minerId})`);
  });
  
  poolSystem.on('miner-disconnected', (data) => {
    logger.info(`Miner disconnected: ${data.worker} (${data.minerId})`);
  });
  
  poolSystem.on('block-found', (data) => {
    logger.info('🎉 BLOCK FOUND! 🎉');
    logger.info(`Height: ${data.height}`);
    logger.info(`Hash: ${data.hash}`);
    logger.info(`Finder: ${data.finder}`);
    logger.info(`Coin: ${data.coin}`);
  });
  
  poolSystem.on('algorithm-switch', (data) => {
    logger.info(`Algorithm switched to ${data.algorithm} (${data.coin})`);
  });
  
  // Fault tolerance events
  if (faultTolerance) {
    faultTolerance.on('failover-start', (data) => {
      logger.warn(`Failover started for ${data.service}`);
    });
    
    faultTolerance.on('service-recovered', (data) => {
      logger.info(`Service recovered: ${data.service} (attempts: ${data.attempts})`);
    });
    
    faultTolerance.on('node-failed', (data) => {
      logger.warn(`Node failed: ${data.nodeId}`);
    });
  }
  
  // Process events
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    gracefulShutdown('uncaught-exception');
  });
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  });
}

function logStartupInfo() {
  const stats = poolSystem.getPoolStatistics();
  
  logger.info('-----------------------------------');
  logger.info('Pool Configuration:');
  logger.info(`- Algorithm: ${stats.pool.algorithm || 'auto'}`);
  logger.info(`- Coin: ${stats.pool.coin || 'auto'}`);
  logger.info(`- Profit Switching: ${config.mining.profitSwitching ? 'enabled' : 'disabled'}`);
  logger.info(`- GPU Mining: ${config.mining.gpuMining ? 'enabled' : 'disabled'}`);
  logger.info(`- CPU Mining: ${config.mining.cpuMining ? 'enabled' : 'disabled'}`);
  logger.info('-----------------------------------');
  logger.info('Network Status:');
  logger.info(`- P2P Nodes: ${stats.network.p2pNodes}`);
  logger.info(`- Consensus View: ${stats.network.consensusView}`);
  logger.info(`- Bootstrap Nodes: ${config.bootstrapNodes.length}`);
  logger.info('-----------------------------------');
  
  if (config.mining.profitSwitching && poolSystem.profitSwitcher) {
    const profitStats = poolSystem.profitSwitcher.getStatistics();
    logger.info('Profit Switching Status:');
    logger.info(`- Current Coin: ${profitStats.currentCoin || 'none'}`);
    logger.info(`- Coins Registered: ${Object.keys(profitStats.coins).length}`);
    logger.info(`- Switch Count: ${profitStats.switchCount}`);
    logger.info('-----------------------------------');
  }
}

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  logger.info(`\nReceived ${signal}, starting graceful shutdown...`);
  
  try {
    // Log final statistics
    if (poolSystem) {
      const stats = poolSystem.getPoolStatistics();
      logger.info('Final Pool Statistics:');
      logger.info(`- Total Miners: ${stats.stats.totalMiners}`);
      logger.info(`- Total Shares: ${stats.stats.totalShares}`);
      logger.info(`- Total Blocks: ${stats.stats.totalBlocks}`);
      logger.info(`- Total Hashrate: ${formatHashrate(stats.stats.totalHashrate)}`);
    }
    
    // Shutdown components in order
    if (dashboard) {
      logger.info('Shutting down analytics dashboard...');
      await dashboard.shutdown();
    }
    
    if (faultTolerance) {
      logger.info('Shutting down fault tolerance system...');
      await faultTolerance.shutdown();
    }
    
    if (poolSystem) {
      logger.info('Shutting down pool system...');
      await poolSystem.shutdown();
    }
    
    logger.info('Graceful shutdown complete');
    process.exit(0);
    
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
}

function generateNodeId() {
  return require('crypto').randomBytes(32).toString('hex');
}

function generateNodeIdFromAddress(address) {
  return require('crypto')
    .createHash('sha256')
    .update(address)
    .digest();
}

function formatHashrate(hashrate) {
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  let unitIndex = 0;
  
  while (hashrate >= 1000 && unitIndex < units.length - 1) {
    hashrate /= 1000;
    unitIndex++;
  }
  
  return `${hashrate.toFixed(2)} ${units[unitIndex]}`;
}

// Display startup banner
function displayBanner() {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║                   OTEDAMA P2P MINING POOL                 ║
║                                                           ║
║           Enterprise-Grade Distributed Mining             ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);
}

// Main execution
displayBanner();
startMiningPool().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});