/**
 * P2P Controller for Otedama Mining Pool
 * Orchestrates all P2P components for decentralized pool operation
 */

import { EventEmitter } from 'events';
import { Logger } from '../logger.js';
import { SmartWorkDistributor } from './smart-work-distribution.js';
import { NodeDiscovery } from './node-discovery.js';
import { MeshTopology } from './mesh-topology.js';
import { ShareVerification } from './share-verification.js';
import { ReputationSystem } from './reputation-system.js';
import { GossipProtocol } from './gossip-protocol.js';
import { StratumV2 } from './stratum-v2.js';

export class P2PController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || new Logger('P2PController');
    this.options = {
      nodeId: options.nodeId || this.generateNodeId(),
      port: options.port || 3333,
      discoveryPort: options.discoveryPort || 3334,
      maxPeers: options.maxPeers || 50,
      minPeers: options.minPeers || 5,
      ...options
    };
    
    // Initialize components
    this.workDistributor = new SmartWorkDistributor({
      logger: this.logger,
      ...options.workDistribution
    });
    
    this.nodeDiscovery = new NodeDiscovery({
      nodeId: this.options.nodeId,
      port: this.options.discoveryPort,
      logger: this.logger,
      ...options.discovery
    });
    
    this.meshTopology = new MeshTopology({
      nodeId: this.options.nodeId,
      maxPeers: this.options.maxPeers,
      logger: this.logger,
      ...options.topology
    });
    
    this.shareVerification = new ShareVerification({
      logger: this.logger,
      ...options.verification
    });
    
    this.reputationSystem = new ReputationSystem({
      logger: this.logger,
      ...options.reputation
    });
    
    this.gossipProtocol = new GossipProtocol({
      nodeId: this.options.nodeId,
      logger: this.logger,
      ...options.gossip
    });
    
    this.stratumV2 = new StratumV2({
      port: this.options.port,
      logger: this.logger,
      ...options.stratum
    });
    
    // State management
    this.peers = new Map();
    this.miners = new Map();
    this.shares = new Map();
    this.blocks = new Map();
    
    // Performance metrics
    this.metrics = {
      totalHashrate: 0,
      activeMiners: 0,
      connectedPeers: 0,
      sharesPerSecond: 0,
      blocksFound: 0,
      networkLatency: 0,
      consensusHealth: 1.0
    };
    
    this.initialize();
  }
  
  async initialize() {
    try {
      // Start node discovery
      await this.nodeDiscovery.start();
      
      // Initialize mesh topology
      await this.meshTopology.initialize();
      
      // Start Stratum V2 server
      await this.stratumV2.start();
      
      // Setup event handlers
      this.setupEventHandlers();
      
      // Start background processes
      this.startMetricsCollection();
      this.startPeerManagement();
      this.startConsensusMonitoring();
      
      this.logger.info(`P2P Controller initialized with node ID: ${this.options.nodeId}`);
      this.emit('initialized', { nodeId: this.options.nodeId });
      
    } catch (error) {
      this.logger.error('Failed to initialize P2P Controller:', error);
      throw error;
    }
  }
  
  setupEventHandlers() {
    // Node discovery events
    this.nodeDiscovery.on('peer:discovered', (peer) => this.handlePeerDiscovered(peer));
    this.nodeDiscovery.on('peer:lost', (peerId) => this.handlePeerLost(peerId));
    
    // Mesh topology events
    this.meshTopology.on('peer:connected', (peer) => this.handlePeerConnected(peer));
    this.meshTopology.on('peer:disconnected', (peerId) => this.handlePeerDisconnected(peerId));
    this.meshTopology.on('message:received', (msg) => this.handleMessage(msg));
    
    // Work distribution events
    this.workDistributor.on('work:assigned', (work) => this.handleWorkAssigned(work));
    this.workDistributor.on('share:submitted', (share) => this.handleShareSubmitted(share));
    
    // Share verification events
    this.shareVerification.on('share:valid', (share) => this.handleValidShare(share));
    this.shareVerification.on('share:invalid', (share) => this.handleInvalidShare(share));
    this.shareVerification.on('block:found', (block) => this.handleBlockFound(block));
    
    // Reputation events
    this.reputationSystem.on('reputation:updated', (update) => this.handleReputationUpdate(update));
    
    // Gossip protocol events
    this.gossipProtocol.on('gossip:received', (gossip) => this.handleGossip(gossip));
    
    // Stratum V2 events
    this.stratumV2.on('miner:connected', (miner) => this.handleMinerConnected(miner));
    this.stratumV2.on('miner:disconnected', (minerId) => this.handleMinerDisconnected(minerId));
  }
  
  // Peer management
  async handlePeerDiscovered(peer) {
    if (this.peers.size >= this.options.maxPeers) {
      return; // Already at max peers
    }
    
    // Check reputation
    const reputation = this.reputationSystem.getReputation(peer.id);
    if (reputation < 0.1) {
      this.logger.warn(`Ignoring peer with low reputation: ${peer.id}`);
      return;
    }
    
    // Attempt connection
    try {
      await this.meshTopology.connectToPeer(peer);
    } catch (error) {
      this.logger.error(`Failed to connect to peer ${peer.id}:`, error);
    }
  }
  
  handlePeerLost(peerId) {
    this.peers.delete(peerId);
    this.emit('peer:removed', { peerId });
  }
  
  handlePeerConnected(peer) {
    this.peers.set(peer.id, {
      ...peer,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      sharedBlocks: 0,
      sharedShares: 0
    });
    
    // Share current state
    this.syncWithPeer(peer.id);
    
    this.metrics.connectedPeers = this.peers.size;
    this.emit('peer:added', { peer });
  }
  
  handlePeerDisconnected(peerId) {
    this.peers.delete(peerId);
    this.metrics.connectedPeers = this.peers.size;
    
    // Check minimum peers
    if (this.peers.size < this.options.minPeers) {
      this.nodeDiscovery.requestMorePeers();
    }
  }
  
  // Message handling
  async handleMessage(message) {
    const { type, data, from } = message;
    
    // Update peer last seen
    const peer = this.peers.get(from);
    if (peer) {
      peer.lastSeen = Date.now();
    }
    
    switch (type) {
      case 'share':
        await this.handlePeerShare(data, from);
        break;
        
      case 'block':
        await this.handlePeerBlock(data, from);
        break;
        
      case 'work':
        await this.handlePeerWork(data, from);
        break;
        
      case 'stats':
        await this.handlePeerStats(data, from);
        break;
        
      case 'sync':
        await this.handleSyncRequest(data, from);
        break;
        
      default:
        this.logger.warn(`Unknown message type: ${type}`);
    }
  }
  
  // Miner management
  async handleMinerConnected(miner) {
    // Register with work distributor
    const profile = this.workDistributor.registerMiner(miner.id, {
      type: miner.hardware,
      hashrates: miner.hashrates,
      capabilities: miner.algorithms,
      location: miner.location,
      bandwidth: miner.bandwidth
    });
    
    this.miners.set(miner.id, {
      ...miner,
      profile,
      connectedAt: Date.now(),
      shares: 0,
      blocks: 0
    });
    
    this.metrics.activeMiners = this.miners.size;
    
    // Broadcast to peers
    this.broadcastToPeers({
      type: 'miner:joined',
      data: { minerId: miner.id, algorithms: miner.algorithms }
    });
    
    this.emit('miner:registered', { miner });
  }
  
  handleMinerDisconnected(minerId) {
    this.miners.delete(minerId);
    this.metrics.activeMiners = this.miners.size;
    
    // Broadcast to peers
    this.broadcastToPeers({
      type: 'miner:left',
      data: { minerId }
    });
  }
  
  // Work management
  async assignWork(minerId, preferences = {}) {
    try {
      const work = await this.workDistributor.assignWork(minerId, preferences);
      
      // Record work assignment
      this.recordWorkAssignment(minerId, work);
      
      // Share with peers for redundancy
      this.shareWorkWithPeers(work);
      
      return work;
    } catch (error) {
      this.logger.error(`Failed to assign work to ${minerId}:`, error);
      throw error;
    }
  }
  
  handleWorkAssigned(work) {
    // Update metrics
    this.updateHashrateMetrics();
  }
  
  // Share handling
  async handleShareSubmitted(shareData) {
    const { minerId, share } = shareData;
    
    try {
      // Verify share locally
      const result = await this.shareVerification.verifyShare(share);
      
      if (result.valid) {
        // Update miner stats
        const miner = this.miners.get(minerId);
        if (miner) {
          miner.shares++;
        }
        
        // Propagate to network
        await this.propagateShare(share);
        
        // Check if it's a block
        if (result.isBlock) {
          await this.handleBlockFound({
            share,
            minerId,
            timestamp: Date.now()
          });
        }
      }
      
      return result;
    } catch (error) {
      this.logger.error('Share verification error:', error);
      return { valid: false, error: error.message };
    }
  }
  
  async handlePeerShare(share, peerId) {
    // Verify share hasn't been seen
    const shareId = this.getShareId(share);
    if (this.shares.has(shareId)) {
      return; // Already processed
    }
    
    // Verify share
    const result = await this.shareVerification.verifyShare(share);
    
    if (result.valid) {
      this.shares.set(shareId, {
        ...share,
        receivedFrom: peerId,
        timestamp: Date.now()
      });
      
      // Update peer stats
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.sharedShares++;
      }
      
      // Propagate to other peers
      this.propagateShare(share, peerId);
      
      // Update reputation
      this.reputationSystem.recordPositiveAction(peerId, 'valid_share');
    } else {
      // Invalid share from peer
      this.reputationSystem.recordNegativeAction(peerId, 'invalid_share');
    }
  }
  
  // Block handling
  async handleBlockFound(blockData) {
    const { share, minerId } = blockData;
    
    // Record block
    const blockId = this.getBlockId(share);
    this.blocks.set(blockId, {
      ...blockData,
      foundAt: Date.now(),
      propagated: false
    });
    
    // Update miner stats
    const miner = this.miners.get(minerId);
    if (miner) {
      miner.blocks++;
    }
    
    // Update metrics
    this.metrics.blocksFound++;
    
    // Broadcast to network
    await this.broadcastBlock(blockData);
    
    // Trigger payout calculation
    this.emit('block:found', blockData);
  }
  
  async handlePeerBlock(block, peerId) {
    const blockId = this.getBlockId(block.share);
    
    if (this.blocks.has(blockId)) {
      return; // Already have this block
    }
    
    // Verify block
    const isValid = await this.shareVerification.verifyBlock(block);
    
    if (isValid) {
      this.blocks.set(blockId, {
        ...block,
        receivedFrom: peerId,
        receivedAt: Date.now()
      });
      
      // Update peer stats
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.sharedBlocks++;
      }
      
      // Propagate to other peers
      this.propagateBlock(block, peerId);
      
      // Update reputation
      this.reputationSystem.recordPositiveAction(peerId, 'valid_block');
      
      // Emit event
      this.emit('block:received', block);
    } else {
      // Invalid block from peer
      this.reputationSystem.recordNegativeAction(peerId, 'invalid_block');
    }
  }
  
  // Network synchronization
  async syncWithPeer(peerId) {
    const syncData = {
      miners: this.miners.size,
      shares: this.shares.size,
      blocks: Array.from(this.blocks.keys()).slice(-10),
      metrics: this.metrics
    };
    
    await this.meshTopology.sendToPeer(peerId, {
      type: 'sync',
      data: syncData
    });
  }
  
  async handleSyncRequest(data, peerId) {
    // Process sync data
    if (data.blocks) {
      for (const blockId of data.blocks) {
        if (!this.blocks.has(blockId)) {
          // Request full block data
          await this.meshTopology.sendToPeer(peerId, {
            type: 'block:request',
            data: { blockId }
          });
        }
      }
    }
    
    // Send our sync data
    await this.syncWithPeer(peerId);
  }
  
  // Broadcasting
  async broadcastToPeers(message, excludePeer = null) {
    const peers = Array.from(this.peers.keys())
      .filter(peerId => peerId !== excludePeer);
    
    await this.gossipProtocol.broadcast(message, peers);
  }
  
  async propagateShare(share, excludePeer = null) {
    await this.broadcastToPeers({
      type: 'share',
      data: share
    }, excludePeer);
  }
  
  async broadcastBlock(block) {
    await this.broadcastToPeers({
      type: 'block',
      data: block
    });
  }
  
  async propagateBlock(block, excludePeer = null) {
    await this.broadcastToPeers({
      type: 'block',
      data: block
    }, excludePeer);
  }
  
  // Metrics and monitoring
  startMetricsCollection() {
    setInterval(() => {
      this.updateHashrateMetrics();
      this.updateNetworkMetrics();
      this.updateConsensusMetrics();
      
      this.emit('metrics:updated', this.metrics);
    }, 5000); // Every 5 seconds
  }
  
  updateHashrateMetrics() {
    let totalHashrate = 0;
    
    for (const [minerId, miner] of this.miners) {
      const profile = miner.profile;
      if (profile && profile.hashrates) {
        Object.values(profile.hashrates).forEach(hashrate => {
          totalHashrate += hashrate;
        });
      }
    }
    
    this.metrics.totalHashrate = totalHashrate;
  }
  
  updateNetworkMetrics() {
    // Calculate average latency
    let totalLatency = 0;
    let count = 0;
    
    for (const [peerId, peer] of this.peers) {
      if (peer.latency) {
        totalLatency += peer.latency;
        count++;
      }
    }
    
    this.metrics.networkLatency = count > 0 ? totalLatency / count : 0;
    
    // Calculate shares per second
    const recentShares = Array.from(this.shares.values())
      .filter(share => Date.now() - share.timestamp < 60000);
    
    this.metrics.sharesPerSecond = recentShares.length / 60;
  }
  
  updateConsensusMetrics() {
    // Simple consensus health based on peer agreement
    const activePeers = Array.from(this.peers.values())
      .filter(peer => Date.now() - peer.lastSeen < 30000);
    
    if (activePeers.length === 0) {
      this.metrics.consensusHealth = 0;
      return;
    }
    
    // Check block agreement
    const recentBlocks = Array.from(this.blocks.values())
      .filter(block => Date.now() - block.foundAt < 600000); // Last 10 minutes
    
    let agreementScore = 1.0;
    
    for (const block of recentBlocks) {
      const confirmations = activePeers.filter(peer => 
        peer.sharedBlocks > 0
      ).length;
      
      const confirmationRatio = confirmations / activePeers.length;
      agreementScore *= confirmationRatio;
    }
    
    this.metrics.consensusHealth = agreementScore;
  }
  
  // Peer management
  startPeerManagement() {
    setInterval(() => {
      // Remove inactive peers
      const now = Date.now();
      const timeout = 300000; // 5 minutes
      
      for (const [peerId, peer] of this.peers) {
        if (now - peer.lastSeen > timeout) {
          this.logger.info(`Removing inactive peer: ${peerId}`);
          this.handlePeerDisconnected(peerId);
        }
      }
      
      // Ensure minimum peers
      if (this.peers.size < this.options.minPeers) {
        this.nodeDiscovery.discoverPeers();
      }
      
    }, 60000); // Every minute
  }
  
  // Consensus monitoring
  startConsensusMonitoring() {
    setInterval(() => {
      if (this.metrics.consensusHealth < 0.5) {
        this.logger.warn(`Low consensus health: ${this.metrics.consensusHealth}`);
        this.emit('consensus:unhealthy', {
          health: this.metrics.consensusHealth,
          peers: this.peers.size
        });
      }
    }, 30000); // Every 30 seconds
  }
  
  // Helper methods
  generateNodeId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
  
  getShareId(share) {
    return `${share.jobId}-${share.nonce}-${share.timestamp}`;
  }
  
  getBlockId(share) {
    return share.hash;
  }
  
  recordWorkAssignment(minerId, work) {
    // Implementation for recording work assignments
  }
  
  shareWorkWithPeers(work) {
    // Implementation for sharing work with peers
  }
  
  handlePeerWork(work, peerId) {
    // Implementation for handling work from peers
  }
  
  handlePeerStats(stats, peerId) {
    // Implementation for handling stats from peers
  }
  
  handleValidShare(share) {
    // Implementation for handling valid shares
  }
  
  handleInvalidShare(share) {
    // Implementation for handling invalid shares
  }
  
  handleReputationUpdate(update) {
    // Implementation for handling reputation updates
  }
  
  handleGossip(gossip) {
    // Implementation for handling gossip messages
  }
  
  // Public API
  async getStats() {
    return {
      nodeId: this.options.nodeId,
      peers: this.peers.size,
      miners: this.miners.size,
      shares: this.shares.size,
      blocks: this.blocks.size,
      metrics: this.metrics,
      uptime: Date.now() - this.startTime
    };
  }
  
  async getPeers() {
    return Array.from(this.peers.values()).map(peer => ({
      id: peer.id,
      address: peer.address,
      connectedAt: peer.connectedAt,
      lastSeen: peer.lastSeen,
      reputation: this.reputationSystem.getReputation(peer.id)
    }));
  }
  
  async shutdown() {
    this.logger.info('Shutting down P2P Controller...');
    
    // Disconnect from all peers
    for (const peerId of this.peers.keys()) {
      await this.meshTopology.disconnectFromPeer(peerId);
    }
    
    // Stop all components
    await this.nodeDiscovery.stop();
    await this.stratumV2.stop();
    
    this.emit('shutdown');
  }
}