#!/usr/bin/env node

/**
 * Otedama - P2P Mining Pool Software
 * Simple, efficient, scalable
 */

const { createServer } = require('http');
const express = require('express');
const { program } = require('commander');
const { createLogger } = require('./lib/core/logger');
const { SimpleMiningPool } = require('./lib/core/simple-mining-pool');
const SimpleP2PNetwork = require('./lib/p2p/simple-p2p-network');
const SimpleCPUMiner = require('./lib/mining/simple-cpu-miner');
const ClusterManager = require('./lib/cluster/cluster-manager');
const ShardManager = require('./lib/database/shard-manager');
const { UnifiedCache: CacheManager } = require('./lib/cache');
const HighAvailabilityManager = require('./lib/ha/high-availability');
const { EnterpriseMonitor } = require('./lib/monitoring');
const { StandalonePool } = require('./lib/standalone');

const logger = createLogger('otedama');

// Parse command line arguments
program
  .name('otedama')
  .description('P2P Mining Pool Software')
  .option('-m, --mode <mode>', 'Run mode: pool, miner, standalone, or both', 'standalone')
  .option('-p, --port <port>', 'Stratum port', '3333')
  .option('-a, --api-port <port>', 'API port', '8080')
  .option('-n, --p2p-port <port>', 'P2P port', '6633')
  .option('-s, --seed-nodes <nodes...>', 'Seed nodes for P2P network')
  .option('-w, --wallet <address>', 'Wallet address for mining')
  .option('-o, --pool <address>', 'Pool address for mining', 'localhost:3333')
  .option('-t, --threads <number>', 'Number of CPU threads for mining')
  .option('-c, --config <file>', 'Configuration file')
  .option('-e, --enterprise', 'Enable enterprise features (clustering, HA, monitoring)')
  .option('--cluster-workers <number>', 'Number of cluster workers')
  .option('--ha-nodes <nodes...>', 'High availability peer nodes')
  .option('--shard-count <number>', 'Database shard count', '16')
  .option('--standalone', 'Run as standalone pool (auto-scales from solo to P2P)')
  .option('--blockchain-url <url>', 'Blockchain node URL', 'http://localhost:8332')
  .option('--blockchain-user <user>', 'Blockchain RPC user', 'user')
  .option('--blockchain-pass <pass>', 'Blockchain RPC password', 'pass')
  .option('--coinbase-address <address>', 'Address for block rewards')
  .option('--pool-fee <percent>', 'Pool fee percentage', '1')
  .option('--auto-switch-threshold <number>', 'Number of miners to switch to pool mode', '3')
  .parse();

const options = program.opts();

// Main application
class OtedamaApp {
  constructor(options) {
    this.options = options;
    this.components = {};
  }
  
  async start() {
    logger.info('Starting Otedama...');
    
    try {
      // Initialize enterprise components if enabled
      if (this.options.enterprise) {
        logger.info('Enterprise mode enabled');
        await this.initializeEnterprise();
      }
      
      // Start based on mode
      if (this.options.standalone || this.options.mode === 'standalone') {
        await this.startStandalonePool();
      } else if (this.options.mode === 'pool' || this.options.mode === 'both') {
        await this.startPool();
      }
      
      if (this.options.mode === 'miner' || this.options.mode === 'both') {
        await this.startMiner();
      }
      
      // Setup graceful shutdown
      this.setupShutdown();
      
      logger.info('Otedama started successfully');
      
    } catch (error) {
      logger.error('Failed to start:', error);
      process.exit(1);
    }
  }
  
  async initializeEnterprise() {
    // Initialize shard manager for database scaling
    this.components.shardManager = new ShardManager({
      shardCount: parseInt(this.options.shardCount),
      dataDir: './data/shards'
    });
    await this.components.shardManager.initialize();
    
    // Initialize cache manager
    this.components.cacheManager = new CacheManager({
      maxMemory: 1024 * 1024 * 1024, // 1GB
      ttl: 3600
    });
    
    // Initialize high availability
    if (this.options.haNodes && this.options.haNodes.length > 0) {
      const haNodes = this.options.haNodes.map(node => {
        const [host, port] = node.split(':');
        return { id: node, host, port: parseInt(port) || 5556 };
      });
      
      this.components.haManager = new HighAvailabilityManager({
        nodes: haNodes,
        dataPort: 5556
      });
      await this.components.haManager.start();
    }
    
    // Initialize enterprise monitoring
    this.components.monitor = new EnterpriseMonitor({
      metricsInterval: 10000,
      alertThresholds: {
        cpuUsage: 80,
        memoryUsage: 85,
        errorRate: 5
      }
    });
    await this.components.monitor.start();
  }
  
  async startPool() {
    logger.info('Starting mining pool...');
    
    if (this.options.enterprise && this.options.clusterWorkers) {
      // Use cluster manager for enterprise mode
      this.components.cluster = new ClusterManager({
        workers: parseInt(this.options.clusterWorkers),
        port: parseInt(this.options.port),
        host: '0.0.0.0',
        peers: this.options.haNodes ? this.options.haNodes.map(node => {
          const [host, port] = node.split(':');
          return { host, port: parseInt(port) || 3333 };
        }) : []
      });
      
      await this.components.cluster.start();
      
      // Cluster manager handles pool internally
    } else {
      // Standard single-instance pool
      this.components.pool = new SimpleMiningPool({
        port: parseInt(this.options.port),
        difficulty: 16,
        payoutInterval: 3600000,
        minPayout: 0.001,
        fee: 0.01
      });
      
      await this.components.pool.start();
    }
    
    // Create P2P network
    this.components.p2p = new SimpleP2PNetwork({
      port: parseInt(this.options.p2pPort),
      seedNodes: this.options.seedNodes || [],
      maxPeers: 50
    });
    
    // Create API server
    this.components.api = express();
    this.setupAPI();
    
    // Start components
    await this.components.p2p.start();
    
    this.components.apiServer = createServer(this.components.api);
    this.components.apiServer.listen(this.options.apiPort, () => {
      logger.info(`API server listening on port ${this.options.apiPort}`);
    });
    
    // Connect pool and P2P
    if (this.components.pool) {
      this.connectPoolToP2P();
    }
  }
  
  async startStandalonePool() {
    logger.info('Starting standalone pool (auto-scales from solo to P2P)...');
    
    // Validate required options
    if (!this.options.coinbaseAddress) {
      throw new Error('Coinbase address required for standalone pool (use --coinbase-address)');
    }
    
    // Create standalone pool
    this.components.standalonePool = new StandalonePool({
      // Pool identity
      poolName: 'Otedama Standalone Pool',
      
      // Network settings
      stratumPort: parseInt(this.options.port),
      p2pPort: parseInt(this.options.p2pPort),
      
      // Blockchain settings
      blockchainUrl: this.options.blockchainUrl,
      blockchainUser: this.options.blockchainUser,
      blockchainPass: this.options.blockchainPass,
      coinbaseAddress: this.options.coinbaseAddress,
      
      // Pool settings
      poolFee: parseFloat(this.options.poolFee) / 100,
      autoSwitchThreshold: parseInt(this.options.autoSwitchThreshold),
      
      // Enable solo mining by default
      soloMiningEnabled: true,
      minPeers: 0 // Start in solo mode
    });
    
    // Setup event handlers
    this.components.standalonePool.on('mode:changed', ({ mode, nodes }) => {
      logger.info(`Pool mode changed to ${mode} (${nodes} nodes)`);
    });
    
    this.components.standalonePool.on('block:found', (block) => {
      logger.info(`Block found! Height: ${block.height}, Hash: ${block.hash}`);
    });
    
    this.components.standalonePool.on('miner:connected', (miner) => {
      logger.info(`Miner connected: ${miner.address}`);
    });
    
    this.components.standalonePool.on('peer:connected', (peer) => {
      logger.info(`Peer pool connected: ${peer.address}:${peer.port}`);
    });
    
    // Initialize standalone pool
    await this.components.standalonePool.initialize();
    
    // Create API server
    this.components.api = express();
    this.setupStandaloneAPI();
    
    this.components.apiServer = createServer(this.components.api);
    this.components.apiServer.listen(this.options.apiPort, () => {
      logger.info(`API server listening on port ${this.options.apiPort}`);
    });
    
    logger.info('Standalone pool started successfully');
    logger.info(`Stratum port: ${this.options.port}`);
    logger.info(`P2P port: ${this.options.p2pPort}`);
    logger.info(`Mode: ${this.components.standalonePool.mode}`);
  }
  
  async startMiner() {
    logger.info('Starting miner...');
    
    if (!this.options.wallet) {
      throw new Error('Wallet address required for mining');
    }
    
    // Create miner
    this.components.miner = new SimpleCPUMiner({
      pool: this.options.pool,
      wallet: this.options.wallet,
      threads: this.options.threads ? parseInt(this.options.threads) : undefined,
      algorithm: 'sha256'
    });
    
    await this.components.miner.start();
  }
  
  setupAPI() {
    const app = this.components.api;
    
    // Middleware
    app.use(express.json());
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      next();
    });
    
    // Routes
    app.get('/api/stats', (req, res) => {
      const poolStats = this.components.pool ? this.components.pool.getStats() : 
                       this.components.cluster ? this.components.cluster.getStats() : {};
      const p2pStats = this.components.p2p ? this.components.p2p.getStats() : {};
      const minerStats = this.components.miner ? this.components.miner.getStats() : {};
      
      const stats = {
        pool: poolStats,
        p2p: p2pStats,
        miner: minerStats,
        uptime: Math.floor((Date.now() - this.startTime) / 1000)
      };
      
      // Add enterprise stats if available
      if (this.options.enterprise) {
        stats.enterprise = {
          monitoring: this.components.monitor ? this.components.monitor.getCurrentMetrics() : null,
          cache: this.components.cacheManager ? this.components.cacheManager.getStats() : null,
          ha: this.components.haManager ? this.components.haManager.getClusterStatus() : null,
          database: this.components.shardManager ? { shards: this.options.shardCount } : null
        };
      }
      
      res.json(stats);
    });
    
    app.get('/api/miners', (req, res) => {
      if (!this.components.pool) {
        return res.status(503).json({ error: 'Pool not running' });
      }
      
      const miners = [];
      for (const [id, miner] of this.components.pool.miners) {
        miners.push({
          id: id,
          address: miner.address,
          hashrate: miner.hashrate,
          shares: miner.shares,
          difficulty: miner.difficulty
        });
      }
      
      res.json({ miners });
    });
    
    app.get('/api/health', (req, res) => {
      const health = {
        status: 'ok',
        version: 'Otedama',
        mode: this.options.enterprise ? 'enterprise' : 'standard'
      };
      
      if (this.options.enterprise && this.components.monitor) {
        health.monitoring = this.components.monitor.healthStatus;
      }
      
      res.json(health);
    });
    
    // Enterprise endpoints
    if (this.options.enterprise) {
      app.get('/api/enterprise/report', async (req, res) => {
        if (!this.components.monitor) {
          return res.status(503).json({ error: 'Monitoring not available' });
        }
        
        const type = req.query.type || 'daily';
        const report = await this.components.monitor.generateReport(type);
        res.json(report);
      });
      
      app.get('/api/enterprise/alerts', (req, res) => {
        if (!this.components.monitor) {
          return res.status(503).json({ error: 'Monitoring not available' });
        }
        
        res.json({ alerts: this.components.monitor.alerts });
      });
      
      app.get('/api/enterprise/cache/stats', (req, res) => {
        if (!this.components.cacheManager) {
          return res.status(503).json({ error: 'Cache not available' });
        }
        
        res.json(this.components.cacheManager.getStats());
      });
    }
    
    // Error handling
    app.use((err, req, res, next) => {
      logger.error('API error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
  }
  
  setupStandaloneAPI() {
    const app = this.components.api;
    
    // Middleware
    app.use(express.json());
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      next();
    });
    
    // Routes
    app.get('/api/stats', (req, res) => {
      const stats = this.components.standalonePool.getStats();
      res.json(stats);
    });
    
    app.get('/api/shares', (req, res) => {
      const summary = this.components.standalonePool.shareChain.getSummary();
      res.json(summary);
    });
    
    app.get('/api/rewards', async (req, res) => {
      const rewards = await this.components.standalonePool.rewardDistributor.calculateRewards();
      res.json(rewards);
    });
    
    app.get('/api/miner/:address', (req, res) => {
      const { address } = req.params;
      const balance = this.components.standalonePool.rewardDistributor.getMinerBalance(address);
      const stats = this.components.standalonePool.shareChain.getMinerStats(address);
      
      res.json({ balance, stats });
    });
    
    app.get('/api/blocks', (req, res) => {
      const blocks = this.components.standalonePool.shareChain.blocks;
      res.json({ blocks });
    });
    
    app.get('/api/peers', (req, res) => {
      const peers = this.components.standalonePool.discovery ? 
        this.components.standalonePool.discovery.getConnectedPeers() : [];
      res.json({ peers });
    });
    
    app.get('/api/health', (req, res) => {
      const pool = this.components.standalonePool;
      res.json({
        status: 'ok',
        version: 'Otedama Standalone',
        mode: pool.mode,
        blockchain: pool.blockchain.connected,
        miners: pool.miners.size,
        peers: pool.peers.size,
        uptime: process.uptime()
      });
    });
    
    // WebSocket endpoint for real-time updates
    app.get('/api/ws', (req, res) => {
      res.json({ 
        message: 'WebSocket endpoint',
        url: `ws://localhost:${this.options.apiPort}/ws`
      });
    });
    
    // Error handling
    app.use((err, req, res, next) => {
      logger.error('API error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
  }
  
  connectPoolToP2P() {
    // Share new blocks via P2P
    this.components.pool.on('block-found', (block) => {
      this.components.p2p.broadcast({
        type: 'block',
        data: block
      });
    });
    
    // Share pool stats
    this.components.p2p.registerHandler('getPoolStats', (peer, message) => {
      this.components.p2p.sendToPeer(peer, {
        type: 'poolStats',
        data: this.components.pool.getStats()
      });
    });
  }
  
  setupShutdown() {
    const shutdown = async () => {
      logger.info('Shutting down...');
      
      try {
        // Stop miner
        if (this.components.miner) {
          await this.components.miner.stop();
        }
        
        // Stop pool or cluster
        if (this.components.pool) {
          await this.components.pool.stop();
        }
        
        if (this.components.cluster) {
          // Cluster manager will handle worker shutdown
          // No explicit stop method needed
        }
        
        // Stop standalone pool
        if (this.components.standalonePool) {
          await this.components.standalonePool.shutdown();
        }
        
        // Stop P2P network
        if (this.components.p2p) {
          await this.components.p2p.stop();
        }
        
        // Stop API server
        if (this.components.apiServer) {
          this.components.apiServer.close();
        }
        
        // Stop enterprise components
        if (this.options.enterprise) {
          if (this.components.monitor) {
            await this.components.monitor.stop();
          }
          
          if (this.components.haManager) {
            await this.components.haManager.stop();
          }
          
          if (this.components.cacheManager) {
            this.components.cacheManager.close();
          }
          
          if (this.components.shardManager) {
            await this.components.shardManager.close();
          }
        }
        
        logger.info('Shutdown complete');
        process.exit(0);
        
      } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

// Start application
const app = new OtedamaApp(options);
app.startTime = Date.now();
app.start().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});