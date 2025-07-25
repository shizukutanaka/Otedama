#!/usr/bin/env node
/**
 * Otedama - High-Performance P2P Mining Pool Platform
 * Main entry point
 * 
 * Design principles:
 * - Carmack: Performance-first architecture
 * - Martin: Clean modular design
 * - Pike: Simple and effective
 */

import { createStructuredLogger } from './lib/core/structured-logger.js';
import { configManager } from './lib/core/config-manager.js';
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
  .description('High-Performance P2P Mining Pool Platform')
  .version('1.0.0')
  .option('-m, --mode <mode>', 'Operation mode', 'pool')
  .option('-c, --config <file>', 'Configuration file', './otedama.config.js')
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
║              High-Performance P2P Mining Pool Platform                    ║
║                                                                           ║
║     Built with the principles of Carmack, Martin, and Pike               ║
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
    
    // Load configuration
    await configManager.load({
      files: [
        path.join(__dirname, options.config),
        path.join(__dirname, '.env')
      ],
      validate: true
    });
    
    const config = configManager.getAll();
    
    logger.info('Starting Otedama...', {
      mode: options.mode,
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
  const { default: startPool } = await import('./start-mining-pool.js');
  await startPool(config);
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

// Handle process signals
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Show help
program.on('--help', () => {
  console.log('');
  console.log('Examples:');
  console.log('  $ otedama                    # Start mining pool (default)');
  console.log('  $ otedama --mode pool        # Start mining pool');
  console.log('  $ otedama --mode miner       # Start miner');
  console.log('  $ otedama --mode benchmark   # Run performance benchmark');
  console.log('  $ otedama --mode monitor     # Start monitoring dashboard');
  console.log('');
  console.log('Environment Variables:');
  console.log('  POOL_NAME               Pool name');
  console.log('  POOL_ADDRESS            Pool wallet address');
  console.log('  BITCOIN_RPC_URL         Bitcoin RPC URL');
  console.log('  BITCOIN_RPC_USER        Bitcoin RPC username');
  console.log('  BITCOIN_RPC_PASSWORD    Bitcoin RPC password');
  console.log('');
  console.log('For more information, see README.md');
});

// Run application
main().catch(error => {
  console.error('Failed to start Otedama:', error);
  process.exit(1);
});
