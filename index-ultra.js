#!/usr/bin/env node
/**
 * Otedama Ultra - Ultra-High-Performance P2P Mining Pool
 * Main entry point with all performance optimizations enabled
 * 
 * Design principles:
 * - Carmack: Zero-copy, lock-free, kernel bypass for maximum performance
 * - Martin: Clean modular design with proper separation
 * - Pike: Simple interface despite complex internals
 */

import { createStructuredLogger } from './lib/core/structured-logger.js';
import { configManager } from './lib/core/config-manager.js';
import { UltraPerformancePool } from './lib/mining/ultra-performance-pool.js';
import { createZKPAuthRoutes, ZKPAuthWebSocket } from './lib/api/zkp-auth-api.js';
import { metrics, systemMetrics } from './lib/monitoring/realtime-metrics.js';
import { Command } from 'commander';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

// Initialize logger
const logger = createStructuredLogger('OtedamaUltra');

// Display startup banner
function displayBanner() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                              OTEDAMA ULTRA                                 ║
║          National-Scale Professional Mining Platform                       ║
║                                                                           ║
║  Performance:  Zero-Copy | Lock-Free | Kernel Bypass | SIMD              ║
║  Security:     Zero-Knowledge Proof Authentication (No KYC)              ║
║  Scale:        1M+ Connections | 10M+ Shares/sec | 99.999% Uptime       ║
║                                                                          ║
║  Architecture: Carmack Performance • Martin Clean Code • Pike Simple     ║
╚═══════════════════════════════════════════════════════════════════════════╝
`);
}

// Parse command line arguments
const program = new Command();

program
  .name('otedama-ultra')
  .description('Ultra-High-Performance P2P Mining Pool with Zero-Knowledge Authentication')
  .option('-m, --mode <mode>', 'Operation mode (pool, benchmark, monitor)', 'pool')
  .option('-c, --config <file>', 'Configuration file', './config/production.json')
  .option('--host <host>', 'Host to bind', '0.0.0.0')
  .option('--stratum-port <port>', 'Stratum server port', '3333')
  .option('--api-port <port>', 'API server port', '8080')
  .option('--workers <num>', 'Number of worker threads', String(os.cpus().length))
  .option('--kernel-bypass', 'Enable kernel bypass networking', true)
  .option('--simd', 'Enable SIMD acceleration', true)
  .option('--zkp', 'Enable Zero-Knowledge Proof auth', true)
  .option('--benchmark', 'Run performance benchmark')
  .option('--setup', 'Run interactive setup')
  .parse();

const options = program.opts();

/**
 * Start the Ultra Performance Pool
 */
async function startPool() {
  logger.info('Starting Otedama Ultra Pool', {
    version: '1.0.0',
    mode: options.mode,
    workers: options.workers,
    features: {
      kernelBypass: options.kernelBypass,
      simd: options.simd,
      zkp: options.zkp
    }
  });
  
  // Load configuration
  const config = await configManager.loadConfig(options.config);
  
  // Create pool instance
  const pool = new UltraPerformancePool({
    name: config.pool?.name || 'Otedama Ultra Pool',
    host: options.host,
    port: parseInt(options.stratumPort),
    maxConnections: config.pool?.maxConnections || 1000000,
    workerThreads: parseInt(options.workers),
    useKernelBypass: options.kernelBypass,
    useSIMD: options.simd,
    useZKAuth: options.zkp,
    ...config.pool
  });
  
  // Start the pool
  await pool.start();
  
  // Start API server
  await startAPIServer(pool, parseInt(options.apiPort));
  
  // Start monitoring
  startMonitoring(pool);
  
  logger.info('Otedama Ultra Pool is running', {
    stratum: `stratum+tcp://${options.host}:${options.stratumPort}`,
    api: `http://${options.host}:${options.apiPort}`,
    dashboard: `http://${options.host}:${options.apiPort}/dashboard`
  });
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down gracefully...');
    await pool.shutdown();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    logger.info('Shutting down gracefully...');
    await pool.shutdown();
    process.exit(0);
  });
}

/**
 * Start API server with ZKP authentication
 */
async function startAPIServer(pool, port) {
  const app = express();
  const server = createServer(app);
  const io = new SocketIOServer(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });
  
  // Middleware
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));
  
  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      stats: pool.getStats()
    });
  });
  
  // ZKP authentication routes
  app.use('/api/zkp', createZKPAuthRoutes());
  
  // Pool stats API
  app.get('/api/stats', (req, res) => {
    res.json({
      success: true,
      stats: pool.getStats(),
      system: {
        cpu: process.cpuUsage(),
        memory: process.memoryUsage(),
        uptime: process.uptime()
      }
    });
  });
  
  // Metrics endpoint
  app.get('/api/metrics', (req, res) => {
    res.json(metrics.getSnapshot());
  });
  
  // Serve ZKP demo
  app.get('/demo', (req, res) => {
    res.sendFile(path.join(__dirname, 'examples/zkp-auth-demo.html'));
  });
  
  // Serve client library
  app.get('/lib/client/zkp-auth-client.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'lib/client/zkp-auth-client.js'));
  });
  
  // WebSocket for real-time updates
  const zkpWS = new ZKPAuthWebSocket(io);
  
  io.on('connection', (socket) => {
    logger.info('WebSocket client connected', { id: socket.id });
    
    // Send stats every 5 seconds
    const statsInterval = setInterval(() => {
      socket.emit('stats', pool.getStats());
    }, 5000);
    
    socket.on('disconnect', () => {
      clearInterval(statsInterval);
      logger.info('WebSocket client disconnected', { id: socket.id });
    });
  });
  
  // Listen on events from pool
  pool.on('stats', (stats) => {
    io.emit('pool:stats', stats);
  });
  
  pool.on('block:found', (block) => {
    io.emit('pool:block', block);
  });
  
  return new Promise((resolve) => {
    server.listen(port, () => {
      logger.info(`API server listening on port ${port}`);
      resolve(server);
    });
  });
}

/**
 * Start monitoring
 */
function startMonitoring(pool) {
  // Log stats every minute
  setInterval(() => {
    const stats = pool.getStats();
    logger.info('Pool statistics', {
      miners: stats.miners,
      hashrate: (stats.hashrate / 1e12).toFixed(2) + ' TH/s',
      shares: stats.shares,
      efficiency: stats.efficiency.toFixed(2) + '%',
      blocks: stats.blocks
    });
  }, 60000);
  
  // Monitor system metrics
  metrics.on('metrics', (data) => {
    // Could send to external monitoring system
    if (data.histograms.eventloop?.p99 > 100) {
      logger.warn('High event loop latency detected', {
        p99: data.histograms.eventloop.p99
      });
    }
  });
}

/**
 * Run performance benchmark
 */
async function runBenchmark() {
  logger.info('Running performance benchmark...');
  
  const { spawn } = await import('child_process');
  
  const benchmark = spawn('node', [
    path.join(__dirname, 'test/performance-benchmark.js')
  ], {
    stdio: 'inherit'
  });
  
  benchmark.on('close', (code) => {
    process.exit(code);
  });
}

/**
 * Run interactive setup
 */
async function runSetup() {
  const { spawn } = await import('child_process');
  
  const setup = spawn('node', [
    path.join(__dirname, 'setup.js')
  ], {
    stdio: 'inherit'
  });
  
  setup.on('close', (code) => {
    process.exit(code);
  });
}

/**
 * Main entry point
 */
async function main() {
  displayBanner();
  
  try {
    if (options.benchmark) {
      await runBenchmark();
    } else if (options.setup) {
      await runSetup();
    } else if (options.mode === 'pool') {
      await startPool();
    } else if (options.mode === 'benchmark') {
      await runBenchmark();
    } else if (options.mode === 'monitor') {
      logger.info('Monitor mode - use the web dashboard or API');
      process.exit(0);
    } else {
      logger.error(`Unknown mode: ${options.mode}`);
      process.exit(1);
    }
  } catch (error) {
    logger.error('Failed to start', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// Start the application
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});