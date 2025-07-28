#!/usr/bin/env node

/**
 * Start script for Otedama P2P Mining Pool
 * 
 * Usage: node scripts/start-p2p-pool.js [config-file]
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { P2PPoolManager } from '../lib/p2p/p2p-pool-manager.js';
import { createStructuredLogger } from '../lib/core/structured-logger.js';

const logger = createStructuredLogger('P2PPoolStarter');

/**
 * Load configuration
 */
async function loadConfig(configPath) {
  try {
    const data = await readFile(configPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    logger.error('Failed to load configuration', {
      path: configPath,
      error: error.message
    });
    throw error;
  }
}

/**
 * Start P2P pool
 */
async function startPool() {
  try {
    // Get config file path from command line or use default
    const configPath = process.argv[2] || resolve('config/p2p-pool.json');
    
    logger.info('Loading configuration...', { path: configPath });
    const config = await loadConfig(configPath);
    
    // Validate required configuration
    if (!config.poolAddress) {
      throw new Error('Pool address is required in configuration');
    }
    
    // Create pool manager
    logger.info('Creating P2P pool manager...');
    const poolManager = new P2PPoolManager(config);
    
    // Setup event handlers
    poolManager.on('initialized', () => {
      logger.info('P2P pool initialized successfully');
    });
    
    poolManager.on('started', () => {
      logger.info('P2P pool started successfully');
      printPoolInfo(poolManager);
    });
    
    poolManager.on('miner:connected', (client) => {
      logger.info('New miner connected', { 
        clientId: client.id,
        worker: client.workerName 
      });
    });
    
    poolManager.on('block:found', ({ block, shareBlock }) => {
      logger.info('*** BLOCK FOUND! ***', {
        height: block.template.height,
        hash: block.hash,
        value: block.template.coinbasevalue
      });
    });
    
    poolManager.on('stats:updated', (stats) => {
      // Log stats periodically
      if (Date.now() % 60000 < 5000) { // Every minute
        logger.info('Pool statistics', {
          miners: stats.pool.totalMiners,
          hashrate: formatHashrate(stats.pool.poolHashrate),
          shares: stats.pool.totalShares,
          blocks: stats.pool.blocksFound,
          peers: stats.network.connectedPeers
        });
      }
    });
    
    poolManager.on('error', (error) => {
      logger.error('Pool error', { error: error.message });
    });
    
    // Handle shutdown gracefully
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await poolManager.stop();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await poolManager.stop();
      process.exit(0);
    });
    
    // Start the pool
    logger.info('Starting P2P pool...');
    await poolManager.start();
    
  } catch (error) {
    logger.error('Failed to start P2P pool', { error: error.message });
    console.error(error);
    process.exit(1);
  }
}

/**
 * Print pool information
 */
function printPoolInfo(poolManager) {
  const info = poolManager.getPoolInfo();
  
  console.log('\n' + '='.repeat(60));
  console.log('Otedama P2P Mining Pool Started');
  console.log('='.repeat(60));
  console.log(`Pool Name:       ${info.name}`);
  console.log(`Blockchain:      ${info.blockchain}`);
  console.log(`Algorithm:       ${info.algorithm}`);
  console.log(`Pool Fee:        ${info.fee * 100}%`);
  console.log(`Payment Scheme:  ${info.paymentScheme}`);
  console.log(`Share Window:    ${info.shareWindow} shares`);
  console.log('');
  console.log('Connection Information:');
  console.log(`Stratum Port:    ${info.ports.stratum}`);
  console.log(`P2P Port:        ${info.ports.p2p}`);
  console.log('');
  console.log('Mining Software Connection:');
  console.log(`stratum+tcp://YOUR_WALLET_ADDRESS@localhost:${info.ports.stratum}`);
  console.log('='.repeat(60) + '\n');
}

/**
 * Format hashrate for display
 */
function formatHashrate(hashrate) {
  if (hashrate > 1e15) return (hashrate / 1e15).toFixed(2) + ' PH/s';
  if (hashrate > 1e12) return (hashrate / 1e12).toFixed(2) + ' TH/s';
  if (hashrate > 1e9) return (hashrate / 1e9).toFixed(2) + ' GH/s';
  if (hashrate > 1e6) return (hashrate / 1e6).toFixed(2) + ' MH/s';
  if (hashrate > 1e3) return (hashrate / 1e3).toFixed(2) + ' KH/s';
  return hashrate.toFixed(2) + ' H/s';
}

// Start the pool
startPool();