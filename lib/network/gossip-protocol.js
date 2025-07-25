/**
 * Gossip Protocol - Otedama
 * Efficient message propagation using gossip algorithm
 */

import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';

const logger = createLogger('GossipProtocol');

export class GossipProtocol extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      fanout: options.fanout || 3,
      maxHops: options.maxHops || 5,
      messageTimeout: options.messageTimeout || 60000,
      dedupWindow: options.dedupWindow || 300000
    };
    
    this.seenMessages = new Map();
    this.isRunning = false;
  }
  
  start() {
    this.isRunning = true;
    
    // Start cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 60000);
    
    logger.info('Gossip protocol started');
  }
  
  stop() {
    this.isRunning = false;
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    this.seenMessages.clear();
    
    logger.info('Gossip protocol stopped');
  }
  
  async broadcast(message, peers) {
    if (!this.isRunning) return;
    
    // Generate message ID
    const messageId = this.generateMessageId(message);
    
    // Check if already seen
    if (this.seenMessages.has(messageId)) {
      return;
    }
    
    // Mark as seen
    this.seenMessages.set(messageId, {
      timestamp: Date.now(),
      hops: 0
    });
    
    // Prepare gossip message
    const gossipMessage = {
      id: messageId,
      data: message,
      hops: 0,
      timestamp: Date.now()
    };
    
    // Select random peers
    const selectedPeers = this.selectPeers(peers, this.config.fanout);
    
    // Send to selected peers
    const promises = selectedPeers.map(peer => 
      this.sendToPeer(peer, gossipMessage)
    );
    
    await Promise.allSettled(promises);
    
    logger.debug(`Broadcasted message ${messageId} to ${selectedPeers.length} peers`);
  }
  
  async handleGossip(gossipMessage, fromPeer) {
    if (!this.isRunning) return;
    
    const { id, data, hops } = gossipMessage;
    
    // Check if already seen
    const seen = this.seenMessages.get(id);
    if (seen) {
      return;
    }
    
    // Check max hops
    if (hops >= this.config.maxHops) {
      return;
    }
    
    // Mark as seen
    this.seenMessages.set(id, {
      timestamp: Date.now(),
      hops
    });
    
    // Emit for local processing
    this.emit('message:received', data);
    
    // Forward to other peers
    const nextHops = hops + 1;
    const forwardMessage = {
      ...gossipMessage,
      hops: nextHops
    };
    
    // Get peers excluding sender
    const peers = this.getPeers().filter(p => p.id !== fromPeer.id);
    const selectedPeers = this.selectPeers(peers, this.config.fanout);
    
    // Forward
    for (const peer of selectedPeers) {
      await this.sendToPeer(peer, forwardMessage);
    }
  }
  
  selectPeers(peers, count) {
    if (peers.length <= count) {
      return peers;
    }
    
    // Fisher-Yates shuffle
    const shuffled = [...peers];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    return shuffled.slice(0, count);
  }
  
  generateMessageId(message) {
    const crypto = require('crypto');
    const data = JSON.stringify(message);
    return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
  }
  
  async sendToPeer(peer, message) {
    // This will be implemented by the network layer
    this.emit('gossip:send', { peer, message });
  }
  
  getPeers() {
    // This will be provided by the network layer
    return this.emit('gossip:getPeers') || [];
  }
  
  cleanup() {
    const now = Date.now();
    const timeout = this.config.dedupWindow;
    
    for (const [id, info] of this.seenMessages) {
      if (now - info.timestamp > timeout) {
        this.seenMessages.delete(id);
      }
    }
  }
  
  getStats() {
    return {
      seenMessages: this.seenMessages.size
    };
  }
}

export default GossipProtocol;
