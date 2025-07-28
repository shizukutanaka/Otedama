/**
 * Optimized Share Propagation System for Otedama P2P Pool
 * High-performance share broadcasting with intelligent routing
 * 
 * Design principles:
 * - Carmack: Zero-copy message passing, lock-free queues
 * - Martin: Clean separation of propagation strategies
 * - Pike: Simple but efficient broadcast algorithms
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import crypto from 'crypto';

const logger = createStructuredLogger('OptimizedSharePropagation');

/**
 * Propagation strategies
 */
const PROPAGATION_STRATEGIES = {
  FLOOD: 'flood',              // Broadcast to all peers
  GOSSIP: 'gossip',            // Probabilistic propagation
  STRUCTURED: 'structured',     // DHT-based routing
  HYBRID: 'hybrid',            // Combination of strategies
  ADAPTIVE: 'adaptive'         // Strategy changes based on network conditions
};

/**
 * Message types
 */
const MESSAGE_TYPES = {
  SHARE: 'share',
  SHARE_BATCH: 'share_batch',
  BLOCK: 'block',
  WORK_TEMPLATE: 'work_template',
  PEER_ANNOUNCEMENT: 'peer_announcement',
  NETWORK_STATE: 'network_state'
};

/**
 * Optimized message buffer with zero-copy semantics
 */
class MessageBuffer {
  constructor(maxSize = 1000000) { // 1MB default
    this.buffer = Buffer.allocUnsafe(maxSize);
    this.writePosition = 0;
    this.readPosition = 0;
    this.messageCount = 0;
  }
  
  /**
   * Write message to buffer with zero-copy
   */
  write(message) {
    const messageBuffer = Buffer.from(JSON.stringify(message));
    const headerBuffer = Buffer.allocUnsafe(4);
    headerBuffer.writeUInt32BE(messageBuffer.length, 0);
    
    if (this.writePosition + 4 + messageBuffer.length > this.buffer.length) {
      return false; // Buffer full
    }
    
    // Write header
    headerBuffer.copy(this.buffer, this.writePosition);
    this.writePosition += 4;
    
    // Write message
    messageBuffer.copy(this.buffer, this.writePosition);
    this.writePosition += messageBuffer.length;
    
    this.messageCount++;
    return true;
  }
  
  /**
   * Read message from buffer with zero-copy
   */
  read() {
    if (this.readPosition >= this.writePosition) {
      return null; // No messages
    }
    
    // Read header
    const messageLength = this.buffer.readUInt32BE(this.readPosition);
    this.readPosition += 4;
    
    // Read message
    const messageBuffer = this.buffer.slice(
      this.readPosition,
      this.readPosition + messageLength
    );
    this.readPosition += messageLength;
    
    this.messageCount--;
    
    return JSON.parse(messageBuffer.toString());
  }
  
  /**
   * Reset buffer
   */
  reset() {
    this.writePosition = 0;
    this.readPosition = 0;
    this.messageCount = 0;
  }
  
  /**
   * Get buffer utilization
   */
  getUtilization() {
    return this.writePosition / this.buffer.length;
  }
}

/**
 * Bloom filter for duplicate detection
 */
class ShareBloomFilter {
  constructor(size = 1000000, hashFunctions = 3) {
    this.size = size;
    this.hashFunctions = hashFunctions;
    this.bitArray = new Uint8Array(Math.ceil(size / 8));
    this.count = 0;
  }
  
  /**
   * Add share to bloom filter
   */
  add(shareHash) {
    for (let i = 0; i < this.hashFunctions; i++) {
      const hash = this._hash(shareHash, i);
      const index = hash % this.size;
      const byteIndex = Math.floor(index / 8);
      const bitIndex = index % 8;
      this.bitArray[byteIndex] |= (1 << bitIndex);
    }
    this.count++;
  }
  
  /**
   * Check if share might exist
   */
  mightContain(shareHash) {
    for (let i = 0; i < this.hashFunctions; i++) {
      const hash = this._hash(shareHash, i);
      const index = hash % this.size;
      const byteIndex = Math.floor(index / 8);
      const bitIndex = index % 8;
      
      if (!(this.bitArray[byteIndex] & (1 << bitIndex))) {
        return false;
      }
    }
    return true;
  }
  
  /**
   * Hash function for bloom filter
   */
  _hash(value, seed) {
    const hash = crypto.createHash('sha256');
    hash.update(value + seed);
    const digest = hash.digest();
    return digest.readUInt32BE(0);
  }
  
  /**
   * Clear bloom filter
   */
  clear() {
    this.bitArray.fill(0);
    this.count = 0;
  }
  
  /**
   * Get false positive probability
   */
  getFalsePositiveProbability() {
    const m = this.size;
    const k = this.hashFunctions;
    const n = this.count;
    return Math.pow((1 - Math.exp(-k * n / m)), k);
  }
}

/**
 * Peer connection with optimized messaging
 */
class OptimizedPeerConnection {
  constructor(peerId, socket) {
    this.peerId = peerId;
    this.socket = socket;
    this.sendBuffer = new MessageBuffer();
    this.receiveBuffer = new MessageBuffer();
    this.lastSeen = Date.now();
    this.latency = 0;
    this.bandwidth = 0;
    this.messagesSent = 0;
    this.messagesReceived = 0;
    this.bytesSent = 0;
    this.bytesReceived = 0;
    
    // Quality metrics
    this.qualityScore = 1.0;
    this.propagationSpeed = 1.0;
    this.reliability = 1.0;
  }
  
  /**
   * Send message with buffering
   */
  sendMessage(message) {
    const success = this.sendBuffer.write(message);
    if (!success) {
      // Buffer full, flush immediately
      this.flush();
      return this.sendBuffer.write(message);
    }
    return true;
  }
  
  /**
   * Flush send buffer
   */
  flush() {
    const messages = [];
    let message;
    
    while ((message = this.sendBuffer.read()) !== null) {
      messages.push(message);
    }
    
    if (messages.length === 0) return;
    
    // Send batch
    const batch = {
      type: MESSAGE_TYPES.SHARE_BATCH,
      messages,
      timestamp: Date.now()
    };
    
    const data = JSON.stringify(batch);
    this.socket.write(data);
    
    this.messagesSent += messages.length;
    this.bytesSent += data.length;
    
    this.sendBuffer.reset();
  }
  
  /**
   * Update quality metrics
   */
  updateQuality(success, latency) {
    const alpha = 0.1; // Smoothing factor
    
    if (success) {
      this.reliability = this.reliability * (1 - alpha) + alpha;
    } else {
      this.reliability = this.reliability * (1 - alpha);
    }
    
    if (latency > 0) {
      this.latency = this.latency * (1 - alpha) + latency * alpha;
      this.propagationSpeed = 1000 / (this.latency + 1); // Messages per second potential
    }
    
    // Overall quality score
    this.qualityScore = this.reliability * this.propagationSpeed;
  }
  
  /**
   * Check if connection is healthy
   */
  isHealthy() {
    return (Date.now() - this.lastSeen) < 30000 && this.reliability > 0.5;
  }
}

/**
 * Optimized Share Propagation System
 */
export class OptimizedSharePropagation extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      strategy: config.strategy || PROPAGATION_STRATEGIES.ADAPTIVE,
      maxPeers: config.maxPeers || 100,
      gossipFactor: config.gossipFactor || 0.6,
      batchSize: config.batchSize || 100,
      batchInterval: config.batchInterval || 10, // 10ms
      bloomFilterSize: config.bloomFilterSize || 1000000,
      dedupWindow: config.dedupWindow || 300000, // 5 minutes
      adaptiveThreshold: config.adaptiveThreshold || 0.8,
      ...config
    };
    
    // Network state
    this.peers = new Map(); // peerId -> OptimizedPeerConnection
    this.bloomFilter = new ShareBloomFilter(this.config.bloomFilterSize);
    this.recentShares = new Map(); // shareHash -> timestamp
    
    // Routing table for structured propagation
    this.routingTable = new Map(); // prefix -> Set of peerIds
    
    // Performance metrics
    this.metrics = {
      sharesProcessed: 0,
      sharesPropagated: 0,
      duplicatesFiltered: 0,
      messagesBatched: 0,
      averageLatency: 0,
      networkUtilization: 0
    };
    
    // Batch processing
    this.batchQueue = [];
    this.batchInterval = null;
    
    this.logger = logger;
  }
  
  /**
   * Initialize propagation system
   */
  async initialize() {
    // Start batch processing
    this.startBatchProcessing();
    
    // Start metrics collection
    this.startMetricsCollection();
    
    // Start bloom filter rotation
    this.startBloomFilterRotation();
    
    this.logger.info('Optimized share propagation initialized', {
      strategy: this.config.strategy,
      maxPeers: this.config.maxPeers
    });
  }
  
  /**
   * Add peer connection
   */
  addPeer(peerId, socket) {
    const peer = new OptimizedPeerConnection(peerId, socket);
    this.peers.set(peerId, peer);
    
    // Update routing table
    this.updateRoutingTable(peerId);
    
    this.emit('peer:added', { peerId });
  }
  
  /**
   * Remove peer connection
   */
  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    this.peers.delete(peerId);
    
    // Update routing table
    this.removeFromRoutingTable(peerId);
    
    this.emit('peer:removed', { peerId });
  }
  
  /**
   * Propagate share to network
   */
  async propagateShare(share) {
    const shareHash = this.calculateShareHash(share);
    
    // Check bloom filter for duplicates
    if (this.bloomFilter.mightContain(shareHash)) {
      // Check exact match
      if (this.recentShares.has(shareHash)) {
        this.metrics.duplicatesFiltered++;
        return { propagated: false, reason: 'duplicate' };
      }
    }
    
    // Add to bloom filter and recent shares
    this.bloomFilter.add(shareHash);
    this.recentShares.set(shareHash, Date.now());
    
    // Add to batch queue
    this.batchQueue.push({
      type: MESSAGE_TYPES.SHARE,
      share,
      hash: shareHash,
      timestamp: Date.now()
    });
    
    this.metrics.sharesProcessed++;
    
    return { propagated: true, hash: shareHash };
  }
  
  /**
   * Process batch queue
   */
  processBatchQueue() {
    if (this.batchQueue.length === 0) return;
    
    const batch = this.batchQueue.splice(0, this.config.batchSize);
    
    // Select propagation strategy
    const strategy = this.selectStrategy();
    
    switch (strategy) {
      case PROPAGATION_STRATEGIES.FLOOD:
        this.floodPropagate(batch);
        break;
        
      case PROPAGATION_STRATEGIES.GOSSIP:
        this.gossipPropagate(batch);
        break;
        
      case PROPAGATION_STRATEGIES.STRUCTURED:
        this.structuredPropagate(batch);
        break;
        
      case PROPAGATION_STRATEGIES.HYBRID:
        this.hybridPropagate(batch);
        break;
        
      case PROPAGATION_STRATEGIES.ADAPTIVE:
        this.adaptivePropagate(batch);
        break;
    }
    
    this.metrics.messagesB JennyBatched += batch.length;
  }
  
  /**
   * Flood propagation - send to all peers
   */
  floodPropagate(messages) {
    const healthyPeers = this.getHealthyPeers();
    
    for (const peer of healthyPeers) {
      for (const message of messages) {
        peer.sendMessage(message);
      }
      peer.flush();
    }
    
    this.metrics.sharesPropagated += messages.length * healthyPeers.length;
  }
  
  /**
   * Gossip propagation - probabilistic forwarding
   */
  gossipPropagate(messages) {
    const healthyPeers = this.getHealthyPeers();
    const selectedCount = Math.ceil(healthyPeers.length * this.config.gossipFactor);
    
    // Select random subset of peers
    const selectedPeers = this.selectRandomPeers(healthyPeers, selectedCount);
    
    for (const peer of selectedPeers) {
      for (const message of messages) {
        peer.sendMessage(message);
      }
      peer.flush();
    }
    
    this.metrics.sharesPropagated += messages.length * selectedPeers.length;
  }
  
  /**
   * Structured propagation - DHT-based routing
   */
  structuredPropagate(messages) {
    for (const message of messages) {
      const targetPeers = this.findRoutingPeers(message.hash);
      
      for (const peer of targetPeers) {
        peer.sendMessage(message);
        peer.flush();
      }
      
      this.metrics.sharesPropagated += targetPeers.length;
    }
  }
  
  /**
   * Hybrid propagation - combination of strategies
   */
  hybridPropagate(messages) {
    // Critical messages (blocks) use flood
    const criticalMessages = messages.filter(m => m.type === MESSAGE_TYPES.BLOCK);
    const regularMessages = messages.filter(m => m.type !== MESSAGE_TYPES.BLOCK);
    
    if (criticalMessages.length > 0) {
      this.floodPropagate(criticalMessages);
    }
    
    if (regularMessages.length > 0) {
      this.gossipPropagate(regularMessages);
    }
  }
  
  /**
   * Adaptive propagation - adjust strategy based on network conditions
   */
  adaptivePropagate(messages) {
    const networkHealth = this.calculateNetworkHealth();
    
    if (networkHealth < this.config.adaptiveThreshold) {
      // Network is congested, use gossip
      this.gossipPropagate(messages);
    } else {
      // Network is healthy, use flood for speed
      this.floodPropagate(messages);
    }
  }
  
  /**
   * Select propagation strategy
   */
  selectStrategy() {
    if (this.config.strategy === PROPAGATION_STRATEGIES.ADAPTIVE) {
      const networkHealth = this.calculateNetworkHealth();
      
      if (networkHealth < 0.5) {
        return PROPAGATION_STRATEGIES.GOSSIP;
      } else if (networkHealth < 0.8) {
        return PROPAGATION_STRATEGIES.HYBRID;
      } else {
        return PROPAGATION_STRATEGIES.FLOOD;
      }
    }
    
    return this.config.strategy;
  }
  
  /**
   * Calculate network health score
   */
  calculateNetworkHealth() {
    const peers = Array.from(this.peers.values());
    if (peers.length === 0) return 0;
    
    let totalHealth = 0;
    
    for (const peer of peers) {
      totalHealth += peer.qualityScore;
    }
    
    return totalHealth / peers.length;
  }
  
  /**
   * Get healthy peers
   */
  getHealthyPeers() {
    return Array.from(this.peers.values()).filter(peer => peer.isHealthy());
  }
  
  /**
   * Select random peers
   */
  selectRandomPeers(peers, count) {
    const shuffled = [...peers].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }
  
  /**
   * Find routing peers for structured propagation
   */
  findRoutingPeers(hash) {
    const prefix = hash.substring(0, 4);
    const peerIds = this.routingTable.get(prefix) || new Set();
    
    const peers = [];
    for (const peerId of peerIds) {
      const peer = this.peers.get(peerId);
      if (peer && peer.isHealthy()) {
        peers.push(peer);
      }
    }
    
    // If not enough peers in routing table, fall back to random selection
    if (peers.length < 3) {
      const additionalPeers = this.selectRandomPeers(
        this.getHealthyPeers().filter(p => !peers.includes(p)),
        3 - peers.length
      );
      peers.push(...additionalPeers);
    }
    
    return peers;
  }
  
  /**
   * Update routing table
   */
  updateRoutingTable(peerId) {
    // Simple prefix-based routing
    const peerHash = crypto.createHash('sha256').update(peerId).digest('hex');
    const prefix = peerHash.substring(0, 4);
    
    if (!this.routingTable.has(prefix)) {
      this.routingTable.set(prefix, new Set());
    }
    
    this.routingTable.get(prefix).add(peerId);
  }
  
  /**
   * Remove from routing table
   */
  removeFromRoutingTable(peerId) {
    for (const [prefix, peerIds] of this.routingTable) {
      peerIds.delete(peerId);
      if (peerIds.size === 0) {
        this.routingTable.delete(prefix);
      }
    }
  }
  
  /**
   * Calculate share hash
   */
  calculateShareHash(share) {
    const data = `${share.height}${share.nonce}${share.hash}${share.minerId}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }
  
  /**
   * Start batch processing
   */
  startBatchProcessing() {
    this.batchInterval = setInterval(() => {
      this.processBatchQueue();
    }, this.config.batchInterval);
  }
  
  /**
   * Start metrics collection
   */
  startMetricsCollection() {
    this.metricsInterval = setInterval(() => {
      this.updateMetrics();
    }, 5000); // Every 5 seconds
  }
  
  /**
   * Update metrics
   */
  updateMetrics() {
    const peers = Array.from(this.peers.values());
    
    // Calculate average latency
    let totalLatency = 0;
    let latencyCount = 0;
    
    for (const peer of peers) {
      if (peer.latency > 0) {
        totalLatency += peer.latency;
        latencyCount++;
      }
    }
    
    this.metrics.averageLatency = latencyCount > 0 ? totalLatency / latencyCount : 0;
    
    // Calculate network utilization
    let totalBandwidth = 0;
    let totalUsed = 0;
    
    for (const peer of peers) {
      const bandwidth = peer.bandwidth || 1000000; // 1MB/s default
      const used = (peer.bytesSent + peer.bytesReceived) / 5; // Per second
      
      totalBandwidth += bandwidth;
      totalUsed += used;
    }
    
    this.metrics.networkUtilization = totalBandwidth > 0 ? totalUsed / totalBandwidth : 0;
    
    // Reset per-interval counters
    for (const peer of peers) {
      peer.bytesSent = 0;
      peer.bytesReceived = 0;
    }
  }
  
  /**
   * Start bloom filter rotation
   */
  startBloomFilterRotation() {
    this.bloomRotationInterval = setInterval(() => {
      this.rotateBloomFilter();
    }, this.config.dedupWindow);
  }
  
  /**
   * Rotate bloom filter
   */
  rotateBloomFilter() {
    // Clean old shares from recent shares map
    const cutoff = Date.now() - this.config.dedupWindow;
    
    for (const [hash, timestamp] of this.recentShares) {
      if (timestamp < cutoff) {
        this.recentShares.delete(hash);
      }
    }
    
    // Clear bloom filter if false positive rate is too high
    if (this.bloomFilter.getFalsePositiveProbability() > 0.1) {
      this.bloomFilter.clear();
      
      // Re-add recent shares
      for (const hash of this.recentShares.keys()) {
        this.bloomFilter.add(hash);
      }
    }
  }
  
  /**
   * Get propagation statistics
   */
  getStats() {
    const peerStats = [];
    
    for (const [peerId, peer] of this.peers) {
      peerStats.push({
        peerId,
        healthy: peer.isHealthy(),
        latency: peer.latency,
        reliability: peer.reliability,
        qualityScore: peer.qualityScore,
        messagesSent: peer.messagesSent,
        messagesReceived: peer.messagesReceived
      });
    }
    
    return {
      peers: {
        total: this.peers.size,
        healthy: this.getHealthyPeers().length,
        stats: peerStats
      },
      propagation: {
        strategy: this.selectStrategy(),
        ...this.metrics
      },
      deduplication: {
        bloomFilterSize: this.config.bloomFilterSize,
        falsePositiveRate: this.bloomFilter.getFalsePositiveProbability(),
        recentShares: this.recentShares.size
      },
      routing: {
        prefixes: this.routingTable.size,
        totalEntries: Array.from(this.routingTable.values())
          .reduce((sum, set) => sum + set.size, 0)
      }
    };
  }
  
  /**
   * Shutdown propagation system
   */
  async shutdown() {
    // Stop intervals
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
    }
    
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    
    if (this.bloomRotationInterval) {
      clearInterval(this.bloomRotationInterval);
    }
    
    // Flush all peer buffers
    for (const peer of this.peers.values()) {
      peer.flush();
    }
    
    this.peers.clear();
    this.routingTable.clear();
    this.recentShares.clear();
    
    this.logger.info('Optimized share propagation shutdown');
  }
}

// Export constants
export {
  PROPAGATION_STRATEGIES,
  MESSAGE_TYPES
};

export default OptimizedSharePropagation;