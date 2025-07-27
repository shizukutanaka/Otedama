/**
 * Solo Mining Example - Otedama
 * 
 * This example demonstrates how to run solo mining alongside a mining pool.
 * You can allocate a portion of your resources to solo mining while still
 * participating in the pool for more consistent rewards.
 */

import { createMiningPoolManager } from '../lib/mining/pool-manager.js';
import { createLogger } from '../lib/core/logger.js';

const logger = createLogger('SoloMiningExample');

async function runSoloMiningWithPool() {
  logger.info('Starting Otedama with solo mining enabled...');
  
  // Create pool manager with solo mining configuration
  const poolManager = createMiningPoolManager({
    // Basic pool configuration
    poolName: 'Otedama Solo+Pool Mining',
    algorithm: 'sha256',
    paymentScheme: 'PPLNS',
    poolFee: 0.01,
    
    // Network settings
    stratumPort: 3333,
    apiPort: 8080,
    
    // Blockchain RPC (required for both pool and solo)
    blockchainRPC: {
      bitcoin: {
        enabled: true,
        rpcUrl: process.env.BITCOIN_RPC_URL || 'http://localhost:8332',
        rpcUser: process.env.BITCOIN_RPC_USER || 'bitcoinrpc',
        rpcPassword: process.env.BITCOIN_RPC_PASSWORD || 'yourpassword'
      }
    },
    
    // Pool wallet address
    poolAddress: process.env.POOL_ADDRESS || 'bc1qpool...',
    
    // Enable solo mining
    enableSoloMining: true,
    soloMining: {
      enabled: true,
      // Your personal wallet address for solo mining rewards
      coinbaseAddress: process.env.SOLO_COINBASE_ADDRESS || 'bc1qyouraddress...',
      
      // Resource allocation
      shareAllocationRatio: 0.3, // 30% of resources for solo mining
      threads: 2, // Number of CPU threads for solo mining
      
      // Solo mining settings
      blockUpdateInterval: 15000, // Check for new blocks every 15 seconds
    },
    
    // Hardware settings
    enableCPUMining: true,
    enableGPUMining: true,
    enableASICMining: true,
    
    // Performance settings
    workerProcesses: 4,
    maxConnections: 10000
  });
  
  // Handle events
  poolManager.on('initialized', () => {
    logger.info('Pool and solo mining initialized');
  });
  
  poolManager.on('block:found', (block) => {
    logger.info('Pool block found!', {
      height: block.height,
      hash: block.hash,
      reward: block.reward
    });
  });
  
  poolManager.on('solo:block:found', (block) => {
    logger.info('🎉 SOLO BLOCK FOUND! 🎉', {
      height: block.height,
      hash: block.hash,
      reward: block.reward
    });
  });
  
  poolManager.on('miner:connected', (miner) => {
    logger.info(`Miner connected: ${miner.address}`);
  });
  
  // Start the pool and solo mining
  await poolManager.start();
  
  // Log statistics periodically
  setInterval(() => {
    const stats = poolManager.getStats();
    
    logger.info('=== Pool Statistics ===');
    logger.info(`Total Miners: ${stats.totalMiners}`);
    logger.info(`Pool Hashrate: ${formatHashrate(stats.totalHashrate)}`);
    logger.info(`Pool Blocks Found: ${stats.blocksFound}`);
    
    if (stats.soloMining) {
      logger.info('=== Solo Mining Statistics ===');
      logger.info(`Solo Hashrate: ${formatHashrate(stats.soloMining.hashrate)}`);
      logger.info(`Solo Blocks Found: ${stats.soloMining.blocksFound}`);
      logger.info(`Shares Processed: ${stats.soloMining.sharesProcessed}`);
      logger.info(`Est. Time to Block: ${formatDuration(stats.soloMining.estimatedTimeToBlock)}`);
    }
    
    logger.info('=======================');
  }, 60000); // Every minute
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    await poolManager.stop();
    process.exit(0);
  });
}

function formatHashrate(hashrate) {
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  let unitIndex = 0;
  let value = hashrate;
  
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex++;
  }
  
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function formatDuration(seconds) {
  if (!isFinite(seconds)) return 'N/A';
  
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else {
    return `${minutes}m`;
  }
}

// Configuration tips
logger.info('Solo Mining Configuration Tips:');
logger.info('');
logger.info('1. Resource Allocation:');
logger.info('   - shareAllocationRatio: 0.3 means 30% for solo, 70% for pool');
logger.info('   - Adjust based on your risk preference');
logger.info('   - Higher ratio = more solo mining, less consistent rewards');
logger.info('');
logger.info('2. Hardware Allocation:');
logger.info('   - CPU threads are split between pool and solo');
logger.info('   - GPUs can be dedicated to either pool or solo');
logger.info('   - ASICs typically stay on pool for efficiency');
logger.info('');
logger.info('3. Blockchain Connection:');
logger.info('   - Solo mining requires direct blockchain RPC access');
logger.info('   - Ensure your Bitcoin node is fully synced');
logger.info('   - Use a local node for best performance');
logger.info('');
logger.info('4. Coinbase Address:');
logger.info('   - Must be a valid Bitcoin address you control');
logger.info('   - Solo block rewards go directly to this address');
logger.info('   - Different from pool payout address');
logger.info('');

// Example environment variables
logger.info('Example environment variables:');
logger.info('export BITCOIN_RPC_URL=http://localhost:8332');
logger.info('export BITCOIN_RPC_USER=bitcoinrpc');
logger.info('export BITCOIN_RPC_PASSWORD=yourpassword');
logger.info('export POOL_ADDRESS=bc1qpool...');
logger.info('export SOLO_COINBASE_ADDRESS=bc1qyouraddress...');
logger.info('');

// Run the example
runSoloMiningWithPool().catch(error => {
  logger.error('Failed to start solo mining:', error);
  process.exit(1);
});