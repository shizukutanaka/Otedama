/**
 * Gossip Protocol for Share Propagation in P2P Mining Pool
 * Efficient share distribution with network congestion avoidance
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import { getLogger } from '../logger.js';

const logger = getLogger('GossipNetwork');

// Gossip message types
export const GossipMessageType = {
  SHARE: 'share',
  SHARE_ACK: 'share_ack',
  HEARTBEAT: 'heartbeat',
  PEER_LIST: 'peer_list',
  ANTI_ENTROPY: 'anti_entropy'
};

// Gossip configuration
const DEFAULT_FANOUT = 6;
const DEFAULT_HOP_LIMIT = 3;
const DEFAULT_HEARTBEAT_INTERVAL = 10000; // 10 seconds
const DEFAULT_ANTI_ENTROPY_INTERVAL = 30000; // 30 seconds

export class GossipNetwork extends EventEmitter {
  constructor(nodeId, options = {}) {
    super();
    this.nodeId = nodeId;
    this.logger = options.logger || logger;
    this.options = {
      fanout: options.fanout || DEFAULT_FANOUT,
      hopLimit: options.hopLimit || DEFAULT_HOP_LIMIT,
      heartbeatInterval: options.heartbeatInterval || DEFAULT_HEARTBEAT_INTERVAL,
      antiEntropyInterval: options.antiEntropyInterval || DEFAULT_ANTI_ENTROPY_INTERVAL,
      messageTimeout: options.messageTimeout || 30000,
      maxMessageCache: options.maxMessageCache || 10000,
      ...options
    };
    
    // Network state
    this.peers = new Map();
    this.messageCache = new Map();
    this.pendingAcks = new Map();
    this.shareHistory = new Map();
    
    // Statistics
    this.stats = {
      messagesReceived: 0,
      messagesSent: 0,
      sharesReceived: 0,
      sharesPropagated: 0,
      duplicatesReceived: 0,
      networkLatency: 0
    };
    
    // Start background processes
    this.startHeartbeat();
    this.startAntiEntropy();
    this.startCleanup();
  }
  
  /**
   * Add peer to gossip network
   */
  addPeer(peerId, peerInfo) {
    this.peers.set(peerId, {
      id: peerId,
      endpoint: peerInfo.endpoint,
      lastSeen: Date.now(),
      reliability: 1.0,
      latency: peerInfo.latency || 0,
      bandwidth: peerInfo.bandwidth || 1000, // Mbps
      loadFactor: 0.0,
      sharesSent: 0,
      sharesReceived: 0,
      ...peerInfo
    });
    
    this.logger.info(`Added peer to gossip network: ${peerId}`);
    this.emit('peer:added', { peerId, peerInfo });
  }
  
  /**
   * Remove peer from gossip network
   */
  removePeer(peerId) {
    this.peers.delete(peerId);
    this.logger.info(`Removed peer from gossip network: ${peerId}`);
    this.emit('peer:removed', { peerId });
  }
  
  /**
   * Propagate share through gossip network
   */
  async propagateShare(share) {
    const shareId = this.generateShareId(share);
    
    // Check if already propagated
    if (this.shareHistory.has(shareId)) {
      return;
    }
    
    // Create gossip message
    const message = {
      id: this.generateMessageId(),
      type: GossipMessageType.SHARE,
      shareId,
      share,
      senderId: this.nodeId,
      timestamp: Date.now(),
      hopCount: 0,
      propagationPath: [this.nodeId]
    };
    
    // Add to share history
    this.shareHistory.set(shareId, {
      share,
      timestamp: Date.now(),
      propagated: true,
      path: [this.nodeId]
    });
    
    // Select peers for propagation
    const selectedPeers = this.selectGossipPeers(message);
    
    // Propagate to selected peers
    const propagationPromises = selectedPeers.map(peer => 
      this.sendGossipMessage(peer.id, message)
    );
    
    await Promise.allSettled(propagationPromises);
    
    this.stats.sharesPropagated++;
    this.emit('share:propagated', { shareId, peers: selectedPeers.length });
  }
  
  /**
   * Handle incoming gossip message
   */
  async handleGossipMessage(senderId, message) {
    this.stats.messagesReceived++;
    
    // Update peer last seen
    const peer = this.peers.get(senderId);
    if (peer) {
      peer.lastSeen = Date.now();
    }
    
    // Check if message already seen
    if (this.messageCache.has(message.id)) {
      this.stats.duplicatesReceived++;
      return;
    }
    
    // Add to message cache
    this.messageCache.set(message.id, {
      message,
      timestamp: Date.now(),
      sender: senderId
    });
    
    // Route message based on type
    switch (message.type) {
      case GossipMessageType.SHARE:
        await this.handleShareMessage(senderId, message);
        break;
        
      case GossipMessageType.SHARE_ACK:
        await this.handleShareAck(senderId, message);
        break;
        
      case GossipMessageType.HEARTBEAT:
        await this.handleHeartbeat(senderId, message);
        break;
        
      case GossipMessageType.PEER_LIST:
        await this.handlePeerList(senderId, message);
        break;
        
      case GossipMessageType.ANTI_ENTROPY:
        await this.handleAntiEntropy(senderId, message);
        break;
    }
  }
  
  /**
   * Handle share message
   */
  async handleShareMessage(senderId, message) {
    const { shareId, share, hopCount, propagationPath } = message;
    
    // Check if share already processed
    if (this.shareHistory.has(shareId)) {
      this.stats.duplicatesReceived++;
      return;
    }
    
    // Add to share history
    this.shareHistory.set(shareId, {
      share,
      timestamp: Date.now(),
      receivedFrom: senderId,
      path: propagationPath
    });
    
    this.stats.sharesReceived++;
    
    // Send acknowledgment
    this.sendGossipMessage(senderId, {
      id: this.generateMessageId(),
      type: GossipMessageType.SHARE_ACK,
      shareId,
      timestamp: Date.now(),
      senderId: this.nodeId
    });
    
    // Continue propagation if within hop limit
    if (hopCount < this.options.hopLimit) {
      await this.continueSharePropagation(message);
    }
    
    this.emit('share:received', { shareId, share, senderId });
  }
  
  /**
   * Continue share propagation
   */
  async continueSharePropagation(originalMessage) {
    const { shareId, share, hopCount, propagationPath } = originalMessage;
    
    // Create new message with updated hop count
    const message = {
      ...originalMessage,
      hopCount: hopCount + 1,
      propagationPath: [...propagationPath, this.nodeId],
      senderId: this.nodeId
    };
    
    // Select peers (excluding those in propagation path)
    const excludePeers = new Set(propagationPath);
    const selectedPeers = this.selectGossipPeers(message, excludePeers);
    
    // Propagate to selected peers
    const propagationPromises = selectedPeers.map(peer => 
      this.sendGossipMessage(peer.id, message)
    );
    
    await Promise.allSettled(propagationPromises);
  }
  
  /**
   * Select peers for gossip propagation
   */
  selectGossipPeers(message, excludePeers = new Set()) {
    const availablePeers = Array.from(this.peers.values())
      .filter(peer => 
        !excludePeers.has(peer.id) && 
        peer.id !== this.nodeId &&
        this.isPeerActive(peer)
      );
    
    if (availablePeers.length === 0) {
      return [];
    }
    
    // Sort peers by selection criteria
    const scoredPeers = availablePeers.map(peer => ({
      ...peer,
      score: this.calculatePeerScore(peer, message)
    }));
    
    scoredPeers.sort((a, b) => b.score - a.score);
    
    // Select top peers with some randomization
    const fanout = Math.min(this.options.fanout, scoredPeers.length);
    const selected = [];
    
    // Always select best 50% of peers
    const topCount = Math.ceil(fanout * 0.5);
    selected.push(...scoredPeers.slice(0, topCount));
    
    // Randomly select remaining peers
    const remaining = scoredPeers.slice(topCount);
    while (selected.length < fanout && remaining.length > 0) {
      const randomIndex = Math.floor(Math.random() * remaining.length);
      selected.push(remaining.splice(randomIndex, 1)[0]);
    }
    
    return selected;
  }
  
  /**
   * Calculate peer selection score
   */
  calculatePeerScore(peer, message) {
    let score = 0;
    
    // Reliability factor (0.4 weight)
    score += peer.reliability * 0.4;
    
    // Latency factor (0.3 weight)
    const latencyScore = Math.max(0, 1 - (peer.latency / 1000));
    score += latencyScore * 0.3;
    
    // Bandwidth factor (0.2 weight)
    const bandwidthScore = Math.min(1, peer.bandwidth / 1000);
    score += bandwidthScore * 0.2;
    
    // Load factor (0.1 weight)
    const loadScore = Math.max(0, 1 - peer.loadFactor);
    score += loadScore * 0.1;
    
    // Add small random factor for diversity
    score += Math.random() * 0.1;
    
    return score;
  }
  
  /**
   * Check if peer is active
   */
  isPeerActive(peer) {
    const timeSinceLastSeen = Date.now() - peer.lastSeen;
    return timeSinceLastSeen < this.options.heartbeatInterval * 3;
  }
  
  /**
   * Send gossip message to peer
   */
  async sendGossipMessage(peerId, message) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      throw new Error(`Peer not found: ${peerId}`);
    }
    
    this.stats.messagesSent++;
    
    try {
      // Simulate network send (in production, use actual network)
      await this.simulateNetworkSend(peer, message);
      
      // Update peer statistics
      peer.sharesSent++;
      peer.reliability = Math.min(1.0, peer.reliability + 0.01);
      
    } catch (error) {
      // Handle send failure
      peer.reliability = Math.max(0.0, peer.reliability - 0.1);
      this.logger.warn(`Failed to send gossip message to ${peerId}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Simulate network send (placeholder)
   */
  async simulateNetworkSend(peer, message) {
    return new Promise((resolve, reject) => {
      // Simulate network delay
      const delay = peer.latency || 10 + Math.random() * 40;
      
      setTimeout(() => {
        // Simulate network failure
        if (Math.random() < 0.05) { // 5% failure rate
          reject(new Error('Network timeout'));
        } else {
          resolve();
        }
      }, delay);
    });
  }
  
  /**
   * Handle share acknowledgment
   */
  async handleShareAck(senderId, message) {
    const { shareId } = message;
    
    // Update peer statistics
    const peer = this.peers.get(senderId);
    if (peer) {
      peer.sharesReceived++;
      peer.reliability = Math.min(1.0, peer.reliability + 0.01);
    }
    
    this.emit('share:ack', { shareId, senderId });
  }
  
  /**
   * Handle heartbeat
   */
  async handleHeartbeat(senderId, message) {
    const peer = this.peers.get(senderId);
    if (peer) {
      peer.lastSeen = Date.now();
      peer.loadFactor = message.loadFactor || 0;
    }
    
    // Send heartbeat response
    this.sendGossipMessage(senderId, {
      id: this.generateMessageId(),
      type: GossipMessageType.HEARTBEAT,
      timestamp: Date.now(),
      senderId: this.nodeId,
      loadFactor: this.calculateLoadFactor()
    });
  }
  
  /**
   * Handle peer list exchange
   */
  async handlePeerList(senderId, message) {
    const { peers } = message;
    
    // Add new peers
    for (const peerInfo of peers) {
      if (!this.peers.has(peerInfo.id) && peerInfo.id !== this.nodeId) {
        this.addPeer(peerInfo.id, peerInfo);
      }
    }
    
    // Send our peer list
    const ourPeers = Array.from(this.peers.values())
      .filter(peer => peer.id !== senderId)
      .slice(0, 10); // Limit to 10 peers
    
    this.sendGossipMessage(senderId, {
      id: this.generateMessageId(),
      type: GossipMessageType.PEER_LIST,
      peers: ourPeers,
      timestamp: Date.now(),
      senderId: this.nodeId
    });
  }
  
  /**
   * Handle anti-entropy
   */
  async handleAntiEntropy(senderId, message) {
    const { shareIds } = message;
    
    // Find shares we have that peer might not have
    const missingShares = [];
    
    for (const [shareId, shareInfo] of this.shareHistory) {
      if (!shareIds.includes(shareId)) {
        missingShares.push({
          shareId,
          share: shareInfo.share,
          timestamp: shareInfo.timestamp
        });
      }
    }
    
    // Send missing shares
    if (missingShares.length > 0) {
      for (const shareInfo of missingShares) {
        this.sendGossipMessage(senderId, {
          id: this.generateMessageId(),
          type: GossipMessageType.SHARE,
          shareId: shareInfo.shareId,
          share: shareInfo.share,
          timestamp: shareInfo.timestamp,
          senderId: this.nodeId,
          hopCount: 0,
          propagationPath: [this.nodeId]
        });
      }
    }
  }
  
  /**
   * Start heartbeat routine
   */
  startHeartbeat() {
    setInterval(() => {
      const activePeers = Array.from(this.peers.values())
        .filter(peer => this.isPeerActive(peer));
      
      // Send heartbeat to random subset of peers
      const heartbeatPeers = activePeers
        .sort(() => 0.5 - Math.random())
        .slice(0, Math.ceil(activePeers.length * 0.3));
      
      for (const peer of heartbeatPeers) {
        this.sendGossipMessage(peer.id, {
          id: this.generateMessageId(),
          type: GossipMessageType.HEARTBEAT,
          timestamp: Date.now(),
          senderId: this.nodeId,
          loadFactor: this.calculateLoadFactor()
        });
      }
      
    }, this.options.heartbeatInterval);
  }
  
  /**
   * Start anti-entropy routine
   */
  startAntiEntropy() {
    setInterval(() => {
      const activePeers = Array.from(this.peers.values())
        .filter(peer => this.isPeerActive(peer));
      
      if (activePeers.length === 0) return;
      
      // Select random peer for anti-entropy
      const randomPeer = activePeers[Math.floor(Math.random() * activePeers.length)];
      
      // Send our share IDs
      const shareIds = Array.from(this.shareHistory.keys());
      
      this.sendGossipMessage(randomPeer.id, {
        id: this.generateMessageId(),
        type: GossipMessageType.ANTI_ENTROPY,
        shareIds,
        timestamp: Date.now(),
        senderId: this.nodeId
      });
      
    }, this.options.antiEntropyInterval);
  }
  
  /**
   * Start cleanup routine
   */
  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      const messageTimeout = this.options.messageTimeout;
      
      // Clean old messages
      for (const [messageId, messageInfo] of this.messageCache) {
        if (now - messageInfo.timestamp > messageTimeout) {
          this.messageCache.delete(messageId);
        }
      }
      
      // Clean old shares
      for (const [shareId, shareInfo] of this.shareHistory) {
        if (now - shareInfo.timestamp > messageTimeout * 2) {
          this.shareHistory.delete(shareId);
        }
      }
      
      // Remove inactive peers
      for (const [peerId, peer] of this.peers) {
        if (now - peer.lastSeen > this.options.heartbeatInterval * 5) {
          this.removePeer(peerId);
        }
      }
      
    }, this.options.heartbeatInterval);
  }
  
  /**
   * Calculate current load factor
   */
  calculateLoadFactor() {
    // Simplified load calculation
    const messageRate = this.stats.messagesReceived / 60; // Per second
    const maxRate = 1000; // Max messages per second
    return Math.min(1.0, messageRate / maxRate);
  }
  
  /**
   * Generate unique IDs
   */
  generateMessageId() {
    return randomBytes(8).toString('hex');
  }
  
  generateShareId(share) {
    return createHash('sha256')
      .update(JSON.stringify(share))
      .digest('hex')
      .substring(0, 16);
  }
  
  /**
   * Get network statistics
   */
  getStats() {
    return {
      ...this.stats,
      activePeers: Array.from(this.peers.values())
        .filter(peer => this.isPeerActive(peer)).length,
      totalPeers: this.peers.size,
      messagesCached: this.messageCache.size,
      sharesInHistory: this.shareHistory.size,
      averageLatency: this.calculateAverageLatency(),
      networkHealth: this.calculateNetworkHealth()
    };
  }
  
  /**
   * Calculate average network latency
   */
  calculateAverageLatency() {
    const activePeers = Array.from(this.peers.values())
      .filter(peer => this.isPeerActive(peer) && peer.latency);
    
    if (activePeers.length === 0) return 0;
    
    const totalLatency = activePeers.reduce((sum, peer) => sum + peer.latency, 0);
    return totalLatency / activePeers.length;
  }
  
  /**
   * Calculate network health score
   */
  calculateNetworkHealth() {
    const activePeers = Array.from(this.peers.values())
      .filter(peer => this.isPeerActive(peer));
    
    if (activePeers.length === 0) return 0;
    
    const avgReliability = activePeers.reduce((sum, peer) => 
      sum + peer.reliability, 0) / activePeers.length;
    
    const connectivityScore = Math.min(1.0, activePeers.length / 10);
    
    return (avgReliability * 0.7) + (connectivityScore * 0.3);
  }
}