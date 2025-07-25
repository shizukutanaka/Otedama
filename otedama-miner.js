#!/usr/bin/env node

/**
 * Otedama Miner - Mining Client
 * Standalone mining software for CPU/GPU/ASIC
 */

import { MiningClient } from './lib/mining/mining-client.js';
import { createLogger } from './lib/core/logger.js';
import { Command } from 'commander';
import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import os from 'os';

// Load environment variables
dotenv.config();

const logger = createLogger('OtedamaMiner');

// Parse command line arguments
const program = new Command();

program
  .name('otedama-miner')
  .description('Otedama - High-performance cryptocurrency miner')
  .version('1.0.0')
  .option('-o, --url <url>', 'Pool URL', process.env.POOL_URL || 'stratum+tcp://localhost:3333')
  .option('-u, --user <user>', 'Pool username (wallet.worker)', process.env.POOL_USER || 'wallet.worker')
  .option('-p, --password <pass>', 'Pool password', process.env.POOL_PASSWORD || 'x')
  .option('-a, --algorithm <algo>', 'Mining algorithm', process.env.ALGORITHM || 'sha256')
  .option('-t, --threads <n>', 'Number of CPU threads', parseInt, os.cpus().length)
  .option('--cpu', 'Enable CPU mining', true)
  .option('--no-cpu', 'Disable CPU mining')
  .option('--gpu', 'Enable GPU mining', true)
  .option('--no-gpu', 'Disable GPU mining')
  .option('--asic', 'Enable ASIC mining', false)
  .option('-i, --intensity <n>', 'GPU intensity (1-25)', parseInt, 20)
  .option('--temp-limit <n>', 'Temperature limit (Celsius)', parseInt, 85)
  .option('--auto-tune', 'Enable auto-tuning', true)
  .option('--no-auto-tune', 'Disable auto-tuning')
  .option('--config <file>', 'Configuration file')
  .parse();

const options = program.opts();

// Load config file if specified
let config = {};
if (options.config) {
  try {
    config = JSON.parse(await fs.readFile(options.config, 'utf8'));
  } catch (error) {
    logger.error(`Failed to load config file: ${error.message}`);
  }
}

// Merge options
config = {
  ...config,
  poolUrl: options.url,
  poolUser: options.user,
  poolPassword: options.password,
  algorithm: options.algorithm,
  threads: options.threads,
  cpuEnabled: options.cpu,
  gpuEnabled: options.gpu,
  asicEnabled: options.asic,
  intensity: options.intensity,
  temperatureLimit: options.tempLimit,
  autoTune: options.autoTune
};

// Miner instance
let miner = null;

// Graceful shutdown
let isShuttingDown = false;

/**
 * Display banner
 */
function displayBanner() {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║                    OTEDAMA MINER                          ║
║              High-Performance Mining Software             ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);
}

/**
 * Start mining
 */
async function startMining() {
  try {
    displayBanner();
    
    logger.info('Starting Otedama Miner...');
    logger.info('=========================');
    logger.info(`Pool: ${config.poolUrl}`);
    logger.info(`User: ${config.poolUser}`);
    logger.info(`Algorithm: ${config.algorithm}`);
    logger.info(`CPU Mining: ${config.cpuEnabled ? `Enabled (${config.threads} threads)` : 'Disabled'}`);
    logger.info(`GPU Mining: ${config.gpuEnabled ? 'Enabled' : 'Disabled'}`);
    logger.info(`ASIC Mining: ${config.asicEnabled ? 'Enabled' : 'Disabled'}`);
    logger.info('=========================');
    
    // Create miner instance
    miner = new MiningClient(config);
    
    // Setup event handlers
    setupEventHandlers();
    
    // Initialize miner
    await miner.initialize();
    
    // Start mining
    await miner.start();
    
    logger.info('Mining started successfully!');
    logger.info('Press Ctrl+C to stop');
    
  } catch (error) {
    logger.error('Failed to start mining:', error);
    process.exit(1);
  }
}

/**
 * Setup event handlers
 */
function setupEventHandlers() {
  // Miner events
  miner.on('share', (share) => {
    logger.info(`Share found! Difficulty: ${share.difficulty.toFixed(2)}`);
  });
  
  miner.on('error', (error) => {
    logger.error('Mining error:', error);
  });
  
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

/**
 * Graceful shutdown
 */
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  logger.info(`\nReceived ${signal}, shutting down gracefully...`);
  
  try {
    if (miner) {
      await miner.stop();
    }
    
    logger.info('Shutdown complete');
    process.exit(0);
    
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Display help examples
program.on('--help', () => {
  console.log('');
  console.log('Examples:');
  console.log('  $ otedama-miner -o stratum+tcp://pool.example.com:3333 -u wallet.worker');
  console.log('  $ otedama-miner -a ethash --gpu --no-cpu -i 22');
  console.log('  $ otedama-miner --config miner.json');
});

// Start mining
startMining().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});