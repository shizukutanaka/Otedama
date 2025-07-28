/**
 * P2P Pool Manager for Otedama
 * Integrates all P2P mining pool components
 * 
 * Design principles:
 * - Carmack: Zero-overhead integration
 * - Martin: Clean component orchestration
 * - Pike: Simple unified interface
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { ShareChain } from './share-chain.js';
import { P2PNodeDiscovery } from './p2p-node-discovery.js';
import { DecentralizedStratumProxy } from './decentralized-stratum-proxy.js';
import { WorkDistributionCoordinator } from './work-distribution-coordinator.js';
import { BlockchainRPCClient, BlockchainType } from '../blockchain/blockchain-rpc-client.js';

const logger = createStructuredLogger('P2PPoolManager');

/**
 * Pool configuration defaults
 */
const DEFAULT_CONFIG = {
  // Pool identity
  poolName: 'Otedama P2P Pool',
  poolAddress: null, // Required
  poolFee: 0.01, // 1%
  
  // Network configuration
  p2pPort: 30303,
  stratumPort: 3333,
  rpcPort: 8332,
  
  // Blockchain configuration
  blockchain: BlockchainType.BITCOIN,
  blockchainHost: 'localhost',
  blockchainPort: 8332,
  blockchainUsername: '',
  blockchainPassword: '',
  
  // Share chain configuration
  shareWindow: 2160, // ~6 hours of shares at 10s/share
  targetShareTime: 10, // 10 seconds per share
  
  // P2P network configuration
  maxPeers: 100,
  bootstrapNodes: [],
  
  // Stratum configuration
  initialDifficulty: 1,
  minDifficulty: 0.001,
  maxDifficulty: 1000000
};

/**
 * P2P Pool Manager
 */
export class P2PPoolManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Validate required configuration
    if (!this.config.poolAddress) {
      throw new Error('Pool address is required');
    }
    
    // Components
    this.shareChain = null;
    this.nodeDiscovery = null;
    this.stratumProxy = null;
    this.workCoordinator = null;
    this.blockchainRPC = null;
    
    // State
    this.initialized = false;
    this.running = false;
    this.startTime = null;
    
    // Statistics
    this.stats = {
      uptime: 0,
      totalMiners: 0,
      totalShares: 0,
      blocksFound: 0,
      totalPaid: 0,
      poolHashrate: 0
    };
    
    // Intervals
    this.statsInterval = null;
    this.healthCheckInterval = null;
  }

  /**
   * Initialize all components
   */
  async initialize() {
    if (this.initialized) {
      throw new Error('Pool manager already initialized');
    }
    
    try {
      logger.info('Initializing P2P pool manager...');
      
      // Initialize blockchain RPC
      await this.initializeBlockchainRPC();
      
      // Initialize share chain
      await this.initializeShareChain();
      
      // Initialize P2P network
      await this.initializeP2PNetwork();
      
      // Initialize stratum proxy
      await this.initializeStratumProxy();
      
      // Initialize work coordinator
      await this.initializeWorkCoordinator();
      
      // Setup event handlers
      this.setupEventHandlers();
      
      this.initialized = true;
      
      logger.info('P2P pool manager initialized successfully', {
        poolName: this.config.poolName,
        blockchain: this.config.blockchain,
        p2pPort: this.config.p2pPort,
        stratumPort: this.config.stratumPort
      });
      
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Failed to initialize P2P pool manager', { error: error.message });
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Initialize blockchain RPC client
   */
  async initializeBlockchainRPC() {
    logger.info('Initializing blockchain RPC client...');
    
    this.blockchainRPC = new BlockchainRPCClient({
      blockchain: this.config.blockchain,
      host: this.config.blockchainHost,
      port: this.config.blockchainPort,
      username: this.config.blockchainUsername,
      password: this.config.blockchainPassword,
      wallet: this.config.poolAddress
    });
    
    // Connect to blockchain
    const connected = await this.blockchainRPC.connect();
    if (!connected) {
      throw new Error('Failed to connect to blockchain RPC');
    }
    
    logger.info('Blockchain RPC client initialized');
  }

  /**
   * Initialize share chain
   */
  async initializeShareChain() {
    logger.info('Initializing share chain...');
    
    this.shareChain = new ShareChain({
      targetBlockTime: this.config.targetShareTime * 1000,
      shareWindow: this.config.shareWindow,
      minDifficulty: 1000,
      maxDifficulty: 1000000000,
      difficultyAdjustmentInterval: 20
    });
    
    await this.shareChain.initialize();
    
    logger.info('Share chain initialized', {
      height: this.shareChain.currentHeight,
      difficulty: this.shareChain.currentDifficulty
    });
  }

  /**
   * Initialize P2P network discovery
   */
  async initializeP2PNetwork() {
    logger.info('Initializing P2P network...');
    
    this.nodeDiscovery = new P2PNodeDiscovery({
      nodeId: this.generateNodeId(),
      listenPort: this.config.p2pPort,
      discoveryPort: this.config.p2pPort,
      maxPeers: this.config.maxPeers,
      bootstrapNodes: this.config.bootstrapNodes
    });
    
    await this.nodeDiscovery.start();
    
    logger.info('P2P network initialized', {
      nodeId: this.nodeDiscovery.config.nodeId,
      port: this.config.p2pPort
    });
  }

  /**
   * Initialize stratum proxy
   */
  async initializeStratumProxy() {
    logger.info('Initializing stratum proxy...');
    
    this.stratumProxy = new DecentralizedStratumProxy({
      port: this.config.stratumPort,
      algorithm: this.getAlgorithmForBlockchain(),
      initialDifficulty: this.config.initialDifficulty,
      minDifficulty: this.config.minDifficulty,
      maxDifficulty: this.config.maxDifficulty,
      poolAddress: this.config.poolAddress,
      poolFee: this.config.poolFee,
      shareChain: this.shareChain,
      p2pNetwork: this.nodeDiscovery
    });
    
    await this.stratumProxy.start();
    
    logger.info('Stratum proxy initialized', {
      port: this.config.stratumPort,
      algorithm: this.stratumProxy.config.algorithm
    });
  }

  /**
   * Initialize work distribution coordinator
   */
  async initializeWorkCoordinator() {
    logger.info('Initializing work coordinator...');
    
    this.workCoordinator = new WorkDistributionCoordinator({
      templateRefreshInterval: 30000,
      poolAddress: this.config.poolAddress,
      poolFee: this.config.poolFee
    });
    
    await this.workCoordinator.initialize({
      shareChain: this.shareChain,
      nodeDiscovery: this.nodeDiscovery,
      stratumProxy: this.stratumProxy,
      blockchainRPC: this.blockchainRPC
    });
    
    logger.info('Work coordinator initialized');
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    // Share chain events
    this.shareChain.on('block', (block) => {
      this.handleShareChainBlock(block);
    });
    
    this.shareChain.on('share', (share) => {
      this.stats.totalShares++;
    });
    
    // Node discovery events
    this.nodeDiscovery.on('peer:connected', (peer) => {
      logger.info('New peer connected', { peerId: peer.id });
      this.emit('peer:connected', peer);
    });
    
    this.nodeDiscovery.on('peer:disconnected', (peer) => {
      logger.info('Peer disconnected', { peerId: peer.id });
      this.emit('peer:disconnected', peer);
    });
    
    // Stratum proxy events
    this.stratumProxy.on('client:connected', (client) => {
      this.stats.totalMiners++;
      this.emit('miner:connected', client);
    });
    
    this.stratumProxy.on('client:disconnected', (client) => {
      this.stats.totalMiners = Math.max(0, this.stats.totalMiners - 1);
      this.emit('miner:disconnected', client);
    });
    
    this.stratumProxy.on('share:accepted', (share) => {
      this.emit('share:accepted', share);
    });
    
    // Work coordinator events
    this.workCoordinator.on('block:accepted', ({ block, shareBlock }) => {
      this.stats.blocksFound++;
      logger.info('Block accepted by network!', {
        height: block.template.height,
        hash: block.hash,
        reward: block.template.coinbasevalue
      });
      this.emit('block:found', { block, shareBlock });
    });
    
    this.workCoordinator.on('block:rejected', ({ block, reason }) => {
      logger.warn('Block rejected by network', {
        height: block.template.height,
        reason
      });
      this.emit('block:orphaned', { block, reason });
    });
    
    // Blockchain RPC events
    this.blockchainRPC.on('newBlock', ({ height }) => {
      logger.info('New blockchain block detected', { height });
      this.emit('blockchain:newblock', { height });
    });
  }

  /**
   * Start the P2P pool
   */
  async start() {
    if (!this.initialized) {
      await this.initialize();
    }
    
    if (this.running) {
      throw new Error('Pool already running');
    }
    
    logger.info('Starting P2P pool...');
    
    this.running = true;
    this.startTime = Date.now();
    
    // Start periodic tasks
    this.startPeriodicTasks();
    
    logger.info('P2P pool started successfully', {
      poolName: this.config.poolName,
      poolAddress: this.config.poolAddress,
      blockchain: this.config.blockchain
    });
    
    this.emit('started');
  }

  /**
   * Stop the P2P pool
   */
  async stop() {
    if (!this.running) return;
    
    logger.info('Stopping P2P pool...');
    
    this.running = false;
    
    // Stop periodic tasks
    this.stopPeriodicTasks();
    
    // Shutdown components
    await this.cleanup();
    
    logger.info('P2P pool stopped');
    this.emit('stopped');
  }

  /**
   * Start periodic tasks
   */
  startPeriodicTasks() {
    // Update statistics every 5 seconds
    this.statsInterval = setInterval(() => {
      this.updateStatistics();
    }, 5000);
    
    // Health check every minute
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, 60000);
  }

  /**
   * Stop periodic tasks
   */
  stopPeriodicTasks() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Update pool statistics
   */
  updateStatistics() {
    if (!this.running) return;
    
    // Update uptime
    this.stats.uptime = Date.now() - this.startTime;
    
    // Get component stats
    const shareChainStats = this.shareChain.getStats();
    const networkStats = this.nodeDiscovery.getStats();
    const stratumStats = this.stratumProxy.getStats();
    const workStats = this.workCoordinator.getStats();
    
    // Calculate pool hashrate
    this.stats.poolHashrate = stratumStats.totalHashrate || 0;
    
    // Update miner count
    this.stats.totalMiners = stratumStats.activeClients || 0;
    
    const fullStats = {
      pool: {
        name: this.config.poolName,
        blockchain: this.config.blockchain,
        fee: this.config.poolFee,
        ...this.stats
      },
      shareChain: shareChainStats,
      network: networkStats,
      stratum: stratumStats,
      work: workStats
    };
    
    this.emit('stats:updated', fullStats);
  }

  /**
   * Perform health check
   */
  async performHealthCheck() {
    const health = {
      timestamp: Date.now(),
      healthy: true,
      components: {}
    };
    
    // Check blockchain RPC
    try {
      const height = await this.blockchainRPC.getBlockCount();
      health.components.blockchain = {
        healthy: true,
        height
      };
    } catch (error) {
      health.components.blockchain = {
        healthy: false,
        error: error.message
      };
      health.healthy = false;
    }
    
    // Check share chain
    health.components.shareChain = {
      healthy: true,
      height: this.shareChain.currentHeight,
      difficulty: this.shareChain.currentDifficulty
    };
    
    // Check P2P network
    const peers = this.nodeDiscovery.getConnectedPeers();
    health.components.network = {
      healthy: peers.length > 0,
      connectedPeers: peers.length,
      totalPeers: this.nodeDiscovery.peers.size
    };
    
    // Check stratum
    health.components.stratum = {
      healthy: this.stratumProxy.server !== null,
      activeMiners: this.stratumProxy.clients.size
    };
    
    if (!health.healthy) {
      logger.warn('Health check failed', health);
    }
    
    this.emit('health:check', health);
  }

  /**
   * Handle share chain block
   */
  handleShareChainBlock(block) {
    logger.info('New share chain block', {
      height: block.height,
      hash: block.hash,
      shares: block.shares.length
    });
    
    // Broadcast to P2P network
    const message = {
      type: 'sharechain:block',
      block: block.serialize()
    };
    
    this.nodeDiscovery.broadcast(message);
  }

  /**
   * Get algorithm for blockchain
   */
  getAlgorithmForBlockchain() {
    const algorithmMap = {
      [BlockchainType.BITCOIN]: 'sha256',
      [BlockchainType.LITECOIN]: 'scrypt',
      [BlockchainType.ETHEREUM]: 'ethash',
      [BlockchainType.MONERO]: 'randomx',
      [BlockchainType.RAVENCOIN]: 'kawpow',
      [BlockchainType.ERGO]: 'autolykos2',
      [BlockchainType.KASPA]: 'kheavyhash',
      [BlockchainType.FLUX]: 'equihash125_4',
      [BlockchainType.CONFLUX]: 'octopus',
      [BlockchainType.BEAM]: 'beamhash'
    };
    
    return algorithmMap[this.config.blockchain] || 'sha256';
  }

  /**
   * Generate unique node ID
   */
  generateNodeId() {
    const crypto = require('crypto');
    return crypto.createHash('sha256')
      .update(this.config.poolName)
      .update(this.config.poolAddress)
      .update(Date.now().toString())
      .digest('hex');
  }

  /**
   * Get pool information
   */
  getPoolInfo() {
    return {
      name: this.config.poolName,
      blockchain: this.config.blockchain,
      algorithm: this.getAlgorithmForBlockchain(),
      fee: this.config.poolFee,
      minPayment: 0.001,
      paymentScheme: 'PPLNS',
      shareWindow: this.config.shareWindow,
      targetShareTime: this.config.targetShareTime,
      ports: {
        stratum: this.config.stratumPort,
        p2p: this.config.p2pPort
      },
      stats: this.stats,
      nodes: this.nodeDiscovery.getConnectedPeers().length,
      uptime: this.running ? Date.now() - this.startTime : 0
    };
  }

  /**
   * Get miner statistics
   */
  getMinerStats(minerId) {
    // Get stats from various components
    const shareStats = this.shareChain.getMinerShares(minerId);
    const expectedPayout = this.shareChain.getExpectedPayout(
      minerId, 
      BigInt(this.blockchainRPC.lastBlockHeight * 625000000) // Example reward
    );
    
    return {
      shares: shareStats.length,
      expectedPayout: expectedPayout.toString(),
      lastShare: shareStats[shareStats.length - 1]?.timestamp || 0
    };
  }

  /**
   * Cleanup components
   */
  async cleanup() {
    logger.info('Cleaning up P2P pool components...');
    
    try {
      if (this.workCoordinator) {
        await this.workCoordinator.shutdown();
      }
      
      if (this.stratumProxy) {
        await this.stratumProxy.stop();
      }
      
      if (this.nodeDiscovery) {
        await this.nodeDiscovery.stop();
      }
      
      if (this.blockchainRPC) {
        this.blockchainRPC.disconnect();
      }
      
    } catch (error) {
      logger.error('Error during cleanup', { error: error.message });
    }
  }
}

export default P2PPoolManager;