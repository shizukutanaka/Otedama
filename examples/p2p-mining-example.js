/**
 * P2P Mining Pool Example - Otedama
 * Demonstrates the integrated P2P pool network and unified mining interface
 */

import { createP2PNetwork } from '../lib/mining/p2p-pool-network.js';
import { createMiningManager, MiningAlgorithms } from '../lib/mining/unified-mining-interface.js';
import { createStratumServer } from '../lib/mining/stratum-server.js';
import { createStructuredLogger } from '../lib/core/structured-logger.js';

const logger = createStructuredLogger('P2PMiningExample');

/**
 * Example P2P Mining Pool Node
 */
class P2PMiningNode {
  constructor(config = {}) {
    this.config = {
      nodeId: config.nodeId || 'example-node',
      p2pPort: config.p2pPort || 8888,
      stratumPort: config.stratumPort || 3333,
      ...config
    };
    
    this.p2pNetwork = null;
    this.miningManager = null;
    this.stratumServer = null;
    this.currentJob = null;
  }
  
  async start() {
    logger.info('Starting P2P mining node...');
    
    // Initialize P2P network
    this.p2pNetwork = createP2PNetwork({
      nodeId: this.config.nodeId,
      listenPort: this.config.p2pPort,
      bootstrapPeers: this.config.bootstrapPeers || []
    });
    
    // Initialize mining manager
    this.miningManager = createMiningManager();
    
    // Initialize stratum server
    this.stratumServer = createStratumServer({
      port: this.config.stratumPort
    });
    
    // Setup event handlers
    this.setupEventHandlers();
    
    // Start components
    await this.p2pNetwork.start();
    const hardware = await this.miningManager.initialize();
    await this.stratumServer.start();
    
    logger.info('P2P mining node started successfully', {
      nodeId: this.config.nodeId,
      p2pPort: this.config.p2pPort,
      stratumPort: this.config.stratumPort,
      hardware: hardware.map(h => ({ 
        name: h.name, 
        type: h.type,
        algorithms: h.algorithms 
      }))
    });
    
    // Start example mining job
    this.startExampleMining();
  }
  
  setupEventHandlers() {
    // P2P Network events
    this.p2pNetwork.on('peer:connected', (peer) => {
      logger.info('New peer connected', { 
        peerId: peer.id, 
        address: peer.address 
      });
    });
    
    this.p2pNetwork.on('share:received', async ({ peerId, share }) => {
      logger.info('Share received from network', { peerId, share });
      // Validate and process share
      await this.processNetworkShare(share);
    });
    
    this.p2pNetwork.on('block:found', async ({ peerId, block }) => {
      logger.info('Block found notification from network', { peerId, block });
      // Participate in block validation consensus
    });
    
    this.p2pNetwork.on('consensus:complete', ({ topic, result, votes }) => {
      logger.info('Consensus reached', { topic, result, votes });
    });
    
    // Mining Manager events
    this.miningManager.on('share', async (share) => {
      logger.info('Local share found', share);
      
      // Broadcast to P2P network
      await this.p2pNetwork.broadcast('share_broadcast', share);
      
      // Submit to pool
      await this.submitShare(share);
    });
    
    this.miningManager.on('hashrate', (hashRate) => {
      logger.info(`Total hash rate: ${this.formatHashRate(hashRate)}`);
    });
    
    // Stratum Server events
    this.stratumServer.on('client:connected', (client) => {
      logger.info('Stratum client connected', { 
        clientId: client.id,
        address: client.address 
      });
    });
    
    this.stratumServer.on('share:submitted', async (client, share) => {
      logger.info('Share submitted via stratum', { 
        clientId: client.id,
        share 
      });
      
      // Broadcast to P2P network
      await this.p2pNetwork.broadcast('share_broadcast', {
        ...share,
        source: 'stratum',
        nodeId: this.config.nodeId
      });
    });
  }
  
  async startExampleMining() {
    // Create example mining job
    this.currentJob = {
      id: 'job_' + Date.now(),
      header: Buffer.alloc(80).toString('hex'), // Block header
      target: '0000ffff00000000000000000000000000000000000000000000000000000000',
      difficulty: 16,
      algorithm: 'sha256d',
      height: 700000
    };
    
    // Start mining on available hardware
    const algorithm = MiningAlgorithms.SHA256;
    await this.miningManager.startMining(algorithm, this.currentJob);
    
    logger.info('Mining started', {
      jobId: this.currentJob.id,
      algorithm: algorithm.name,
      difficulty: this.currentJob.difficulty
    });
    
    // Broadcast job to P2P network
    await this.p2pNetwork.broadcast('job_update', this.currentJob);
    
    // Send job to stratum clients
    this.stratumServer.broadcast({
      id: null,
      method: 'mining.notify',
      params: [
        this.currentJob.id,
        this.currentJob.header,
        this.currentJob.target,
        true // clean jobs
      ]
    });
  }
  
  async processNetworkShare(share) {
    // Validate share
    if (!this.validateShare(share)) {
      logger.warn('Invalid share from network', share);
      return;
    }
    
    // Record share for reward distribution
    // In production, this would update a database
    logger.info('Recording valid network share', {
      nodeId: share.nodeId,
      jobId: share.jobId
    });
  }
  
  async submitShare(share) {
    // Check if share meets network difficulty
    if (this.checkNetworkDifficulty(share)) {
      logger.info('BLOCK FOUND!', share);
      
      // Start consensus for block validation
      await this.p2pNetwork.startConsensus('block_validation', {
        share,
        nodeId: this.config.nodeId,
        timestamp: Date.now()
      });
    }
  }
  
  validateShare(share) {
    // Implement share validation
    return share && share.jobId && share.nonce && share.hash;
  }
  
  checkNetworkDifficulty(share) {
    // Check if share meets network difficulty
    // This is simplified - implement actual difficulty checking
    return Math.random() < 0.0001; // Simulate rare block finding
  }
  
  formatHashRate(hashRate) {
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
    let unitIndex = 0;
    
    while (hashRate >= 1000 && unitIndex < units.length - 1) {
      hashRate /= 1000;
      unitIndex++;
    }
    
    return `${hashRate.toFixed(2)} ${units[unitIndex]}`;
  }
  
  async getStats() {
    return {
      node: {
        id: this.config.nodeId,
        uptime: process.uptime()
      },
      p2p: this.p2pNetwork.getStats(),
      mining: this.miningManager.getStats(),
      stratum: {
        clients: this.stratumServer.getClientCount(),
        shares: this.stratumServer.getTotalShares()
      }
    };
  }
  
  async stop() {
    logger.info('Stopping P2P mining node...');
    
    await this.miningManager.stopMining();
    await this.stratumServer.stop();
    await this.p2pNetwork.stop();
    
    logger.info('P2P mining node stopped');
  }
}

/**
 * Run example
 */
async function runExample() {
  // Create first node
  const node1 = new P2PMiningNode({
    nodeId: 'node-1',
    p2pPort: 8888,
    stratumPort: 3333
  });
  
  await node1.start();
  
  // Create second node that connects to first
  const node2 = new P2PMiningNode({
    nodeId: 'node-2', 
    p2pPort: 8889,
    stratumPort: 3334,
    bootstrapPeers: ['localhost:8888']
  });
  
  await node2.start();
  
  // Display stats periodically
  const statsInterval = setInterval(async () => {
    console.log('\n=== Node 1 Stats ===');
    console.log(JSON.stringify(await node1.getStats(), null, 2));
    
    console.log('\n=== Node 2 Stats ===');
    console.log(JSON.stringify(await node2.getStats(), null, 2));
  }, 10000);
  
  // Run for 1 minute
  setTimeout(async () => {
    clearInterval(statsInterval);
    await node1.stop();
    await node2.stop();
    process.exit(0);
  }, 60000);
}

// Handle errors
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection:', error);
  process.exit(1);
});

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runExample().catch(console.error);
}

export { P2PMiningNode };