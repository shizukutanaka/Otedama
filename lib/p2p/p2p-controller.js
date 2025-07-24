/**
 * P2P Controller for Otedama Mining Pool
 * Orchestrates all P2P components for decentralized pool operation
 */

import { EventEmitter } from 'events';
import { getErrorHandler, OtedamaError, ErrorCategory, safeExecute } from '../core/standardized-error-handler.js';
import { SmartWorkDistributor } from './smart-work-distribution.js';
import { NodeDiscovery } from './node-discovery.js';
import { MeshTopology } from './mesh-topology.js';
import { DistributedShareValidator } from './share-verification.js';
import { ReputationSystem } from './reputation-system.js';
import { GossipNetwork } from './gossip-protocol.js';
import { StratumV2Server } from './stratum-v2.js';
import { NetworkPartitionHandler } from './network-partition-handler.js';
import { getP2PConfig, validateP2PConfig, generateNodeId } from './p2p-config.js';

export class P2PController extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Get environment-specific configuration
    const config = getP2PConfig(options.environment || process.env.NODE_ENV || 'development');
    
    // Merge with user options
    this.options = {
      ...config,
      ...options,
      // Deep merge nested objects
      node: { ...config.node, ...options.node },
      network: { ...config.network, ...options.network },
      stratum: { ...config.stratum, ...options.stratum },
      discovery: { ...config.discovery, ...options.discovery },
      workDistribution: { ...config.workDistribution, ...options.workDistribution },
      reputation: { ...config.reputation, ...options.reputation },
      gossip: { ...config.gossip, ...options.gossip },
      topology: { ...config.topology, ...options.topology },
      verification: { ...config.verification, ...options.verification },
      security: { ...config.security, ...options.security },
      performance: { ...config.performance, ...options.performance }
    };
    
    // Generate node ID if not provided
    if (!this.options.node.nodeId) {
      this.options.node.nodeId = generateNodeId();
    }
    
    // Validate configuration
    const configErrors = validateP2PConfig(this.options);
    if (configErrors.length > 0) {
      throw new OtedamaError(
        `Invalid P2P configuration: ${configErrors.join(', ')}`,
        ErrorCategory.VALIDATION,
        { errors: configErrors }
      );
    }
    
    this.errorHandler = getErrorHandler();
    this.logger = this.errorHandler.logger || console;
    
    // Initialize components with unified configuration
    this.workDistributor = new SmartWorkDistributor({
      ...this.options.workDistribution,
      nodeId: this.options.node.nodeId,
      errorHandler: this.errorHandler
    });
    
    this.nodeDiscovery = new NodeDiscovery({
      ...this.options.discovery,
      nodeId: this.options.node.nodeId,
      port: this.options.node.discoveryPort,
      errorHandler: this.errorHandler
    });
    
    this.meshTopology = new MeshTopology({
      ...this.options.topology,
      nodeId: this.options.node.nodeId,
      maxPeers: this.options.node.maxPeers,
      errorHandler: this.errorHandler,
      useBinaryProtocol: this.options.performance.useBinaryProtocol !== false,
      useEncryption: this.options.security.encryption !== false
    });
    
    this.shareVerification = new DistributedShareValidator(this.options.node.nodeId, {
      ...this.options.verification,
      errorHandler: this.errorHandler
    });
    
    this.reputationSystem = new ReputationSystem({
      ...this.options.reputation,
      errorHandler: this.errorHandler
    });
    
    this.gossipProtocol = new GossipNetwork({
      ...this.options.gossip,
      nodeId: this.options.node.nodeId,
      errorHandler: this.errorHandler
    });
    
    this.stratumV2 = new StratumV2Server({
      ...this.options.stratum,
      port: this.options.node.port,
      errorHandler: this.errorHandler
    });
    
    this.networkPartitionHandler = new NetworkPartitionHandler({
      ...this.options.partition,
      errorHandler: this.errorHandler
    });
    
    // State management with limits
    this.peers = new Map();
    this.miners = new Map();
    this.shares = new Map();
    this.blocks = new Map();
    
    // Security features
    this.messageRateLimits = new Map(); // Track message rates per peer
    this.blacklistedPeers = new Set();
    this.shareCleanupInterval = null;
    this.blockCleanupInterval = null;
    
    // Limits
    this.maxShares = 10000;
    this.maxBlocks = 1000;
    this.shareRetentionTime = 3600000; // 1 hour
    this.blockRetentionTime = 86400000; // 24 hours
    
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
      
      // Initialize network partition handler
      this.networkPartitionHandler.initialize(this);
      
      // Setup event handlers
      this.setupEventHandlers();
      
      // Start background processes
      this.startMetricsCollection();
      this.startPeerManagement();
      this.startConsensusMonitoring();
      
      // Start cleanup tasks
      this.startCleanupTasks();
      
      this.logger.info('P2P Controller initialized with node ID:', this.options.nodeId);
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
    
    // Network partition events
    this.networkPartitionHandler.on('partition:suspected', (event) => this.handlePartitionSuspected(event));
    this.networkPartitionHandler.on('partition:confirmed', (event) => this.handlePartitionConfirmed(event));
    this.networkPartitionHandler.on('recovery:completed', (event) => this.handlePartitionRecovered(event));
    this.networkPartitionHandler.on('reorg:started', (event) => this.handleReorgStarted(event));
  }
  
  // Peer management
  async handlePeerDiscovered(peer) {
    // Validate peer object
    if (!peer || !peer.id || typeof peer.id !== 'string') {
      this.logger.warn('Invalid peer discovered');
      return;
    }
    
    if (this.peers.size >= this.options.maxPeers) {
      return; // Already at max peers
    }
    
    // Verify peer ID format
    if (!this.isValidPeerId(peer.id)) {
      this.logger.warn('Invalid peer ID format:', peer.id);
      return;
    }
    
    // Check reputation
    const reputation = this.reputationSystem.getReputation(peer.id);
    if (reputation < 0.1) {
      this.logger.warn('Ignoring peer with low reputation:', peer.id);
      return;
    }
    
    // Verify peer hasn't been blacklisted
    if (this.isBlacklisted(peer.id)) {
      this.logger.warn('Ignoring blacklisted peer:', peer.id);
      return;
    }
    
    // Attempt connection with timeout
    try {
      await this.meshTopology.connectToPeer(peer);
    } catch (error) {
      this.logger.error('Failed to connect to peer:', peer.id, error.message);
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
    // Validate message structure
    if (!message || typeof message !== 'object') {
      this.logger.warn('Invalid message format received');
      return;
    }
    
    const { type, data, from } = message;
    
    // Validate message fields
    if (!type || typeof type !== 'string' || type.length > 50) {
      this.logger.warn('Invalid message type');
      return;
    }
    
    if (!from || typeof from !== 'string' || from.length > 100) {
      this.logger.warn('Invalid message sender');
      return;
    }
    
    // Verify sender is a known peer
    const peer = this.peers.get(from);
    if (!peer) {
      this.logger.warn('Message from unknown peer:', from);
      return;
    }
    
    // Update peer last seen
    peer.lastSeen = Date.now();
    
    // Rate limit check
    if (!this.checkMessageRateLimit(from)) {
      this.logger.warn('Rate limit exceeded for peer:', from);
      this.reputationSystem.recordNegativeAction(from, 'rate_limit_exceeded');
      return;
    }
    
    const allowedTypes = ['share', 'block', 'work', 'stats', 'sync'];
    if (!allowedTypes.includes(type)) {
      this.logger.warn('Unknown message type:', type);
      return;
    }
    
    try {
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
        
      }
    } catch (error) {
      this.logger.error('Error handling message:', error);
      this.reputationSystem.recordNegativeAction(from, 'invalid_message');
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
    // Validate share object
    if (!share || typeof share !== 'object') {
      this.logger.warn('Invalid share format from peer:', peerId);
      this.reputationSystem.recordNegativeAction(peerId, 'invalid_share');
      return;
    }
    
    // Check share size limit
    const shareSize = JSON.stringify(share).length;
    if (shareSize > 10000) { // 10KB limit
      this.logger.warn('Share too large from peer:', peerId);
      this.reputationSystem.recordNegativeAction(peerId, 'oversized_share');
      return;
    }
    
    // Check shares limit
    if (this.shares.size >= this.maxShares) {
      this.cleanupOldShares();
    }
    
    // Verify share hasn't been seen
    const shareId = this.getShareId(share);
    if (this.shares.has(shareId)) {
      return; // Already processed
    }
    
    try {
      // Verify share with timeout
      const result = await Promise.race([
        this.shareVerification.verifyShare(share),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Verification timeout')), 5000))
      ]);
      
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
    } catch (error) {
      this.logger.error('Share verification error:', error.message);
      this.reputationSystem.recordNegativeAction(peerId, 'verification_error');
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
    // Validate block object
    if (!block || typeof block !== 'object' || !block.share) {
      this.logger.warn('Invalid block format from peer:', peerId);
      this.reputationSystem.recordNegativeAction(peerId, 'invalid_block');
      return;
    }
    
    // Check block size limit
    const blockSize = JSON.stringify(block).length;
    if (blockSize > 50000) { // 50KB limit
      this.logger.warn('Block too large from peer:', peerId);
      this.reputationSystem.recordNegativeAction(peerId, 'oversized_block');
      return;
    }
    
    // Check blocks limit
    if (this.blocks.size >= this.maxBlocks) {
      this.cleanupOldBlocks();
    }
    
    const blockId = this.getBlockId(block.share);
    
    if (this.blocks.has(blockId)) {
      return; // Already have this block
    }
    
    try {
      // Verify block with timeout
      const isValid = await Promise.race([
        this.shareVerification.verifyBlock(block),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Verification timeout')), 10000))
      ]);
      
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
    } catch (error) {
      this.logger.error('Block verification error:', error.message);
      this.reputationSystem.recordNegativeAction(peerId, 'verification_error');
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
          this.logger.info('Removing inactive peer:', peerId);
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
        this.logger.warn('Low consensus health:', this.metrics.consensusHealth);
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
  
  // Partition handling methods
  handlePartitionSuspected(event) {
    this.logger.warn('Network partition suspected:', (event.lossRatio * 100) + '% peer loss');
    
    // Notify miners about potential partition
    this.broadcastToPeers({
      type: 'partition:suspected',
      data: event
    });
  }
  
  handlePartitionConfirmed(event) {
    this.logger.error('Network partition confirmed:', event.partitions, 'partitions detected');
    
    // Update consensus health metric
    this.metrics.consensusHealth = 0.5;
    
    // Notify all connected miners
    for (const [minerId, miner] of this.miners) {
      this.stratumV2.sendToMiner(minerId, {
        type: 'warning',
        message: 'Network partition detected',
        severity: 'high'
      });
    }
    
    this.emit('partition:detected', event);
  }
  
  handlePartitionRecovered(event) {
    this.logger.info('Network partition recovered using', event.strategy, 'strategy');
    
    // Restore consensus health
    this.updateConsensusMetrics();
    
    // Notify miners about recovery
    for (const [minerId, miner] of this.miners) {
      this.stratumV2.sendToMiner(minerId, {
        type: 'info',
        message: 'Network partition resolved'
      });
    }
    
    this.emit('partition:recovered', event);
  }
  
  handleReorgStarted(event) {
    this.logger.warn('Chain reorganization started from height', event.fromHeight);
    
    // Invalidate shares/blocks after reorg height
    for (const [shareId, share] of this.shares) {
      if (share.height >= event.fromHeight) {
        this.shares.delete(shareId);
      }
    }
    
    for (const [blockId, block] of this.blocks) {
      if (block.height >= event.fromHeight) {
        this.blocks.delete(blockId);
      }
    }
    
    // Notify miners about reorg
    this.broadcastToPeers({
      type: 'reorg:started',
      data: event
    });
  }
  
  // Public API
  async getStats() {
    const partitionStats = this.networkPartitionHandler.getStats();
    
    return {
      nodeId: this.options.nodeId,
      peers: this.peers.size,
      miners: this.miners.size,
      shares: this.shares.size,
      blocks: this.blocks.size,
      metrics: this.metrics,
      uptime: Date.now() - this.startTime,
      partition: partitionStats
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
    
    // Stop cleanup tasks
    if (this.shareCleanupInterval) {
      clearInterval(this.shareCleanupInterval);
    }
    if (this.blockCleanupInterval) {
      clearInterval(this.blockCleanupInterval);
    }
    
    // Disconnect from all peers
    for (const peerId of this.peers.keys()) {
      await this.meshTopology.disconnectFromPeer(peerId);
    }
    
    // Stop all components
    await this.nodeDiscovery.stop();
    await this.stratumV2.stop();
    this.networkPartitionHandler.shutdown();
    
    // Clear all maps
    this.peers.clear();
    this.miners.clear();
    this.shares.clear();
    this.blocks.clear();
    this.messageRateLimits.clear();
    
    this.emit('shutdown');
  }
  
  // Security helper methods
  checkMessageRateLimit(peerId) {
    const now = Date.now();
    const limit = 100; // messages per minute
    const window = 60000; // 1 minute
    
    if (!this.messageRateLimits.has(peerId)) {
      this.messageRateLimits.set(peerId, { count: 1, resetTime: now + window });
      return true;
    }
    
    const rateLimit = this.messageRateLimits.get(peerId);
    
    if (now > rateLimit.resetTime) {
      rateLimit.count = 1;
      rateLimit.resetTime = now + window;
      return true;
    }
    
    rateLimit.count++;
    return rateLimit.count <= limit;
  }
  
  isValidPeerId(peerId) {
    // Validate peer ID format (alphanumeric, limited length)
    return /^[a-zA-Z0-9_-]{1,100}$/.test(peerId);
  }
  
  isBlacklisted(peerId) {
    return this.blacklistedPeers.has(peerId);
  }
  
  blacklistPeer(peerId) {
    this.blacklistedPeers.add(peerId);
    this.handlePeerDisconnected(peerId);
  }
  
  startCleanupTasks() {
    // Clean up old shares every 5 minutes
    this.shareCleanupInterval = setInterval(() => {
      this.cleanupOldShares();
    }, 300000);
    
    // Clean up old blocks every hour
    this.blockCleanupInterval = setInterval(() => {
      this.cleanupOldBlocks();
    }, 3600000);
  }
  
  cleanupOldShares() {
    const now = Date.now();
    const cutoff = now - this.shareRetentionTime;
    
    for (const [shareId, share] of this.shares) {
      if (share.timestamp < cutoff) {
        this.shares.delete(shareId);
      }
    }
  }
  
  cleanupOldBlocks() {
    const now = Date.now();
    const cutoff = now - this.blockRetentionTime;
    
    for (const [blockId, block] of this.blocks) {
      if (block.foundAt < cutoff || block.receivedAt < cutoff) {
        this.blocks.delete(blockId);
      }
    }
  }
}