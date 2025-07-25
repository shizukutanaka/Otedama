/**
 * Peer Discovery - Otedama
 * Automatic peer discovery mechanisms
 */

import { EventEmitter } from 'events';
import dgram from 'dgram';
import { createLogger } from '../core/logger.js';

const logger = createLogger('PeerDiscovery');

export class PeerDiscovery extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      port: options.port || 8334,
      multicastAddress: options.multicastAddress || '239.255.255.250',
      broadcastInterval: options.broadcastInterval || 30000,
      discoveryTimeout: options.discoveryTimeout || 5000
    };
    
    this.socket = null;
    this.isRunning = false;
    this.discoveredPeers = new Map();
  }
  
  async start() {
    if (this.isRunning) return;
    
    logger.info('Starting peer discovery');
    
    // Create UDP socket
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    
    // Setup socket handlers
    this.socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
    this.socket.on('error', (err) => logger.error('Discovery socket error:', err));
    
    // Bind socket
    await new Promise((resolve, reject) => {
      this.socket.bind(this.config.port, () => {
        this.socket.addMembership(this.config.multicastAddress);
        resolve();
      });
    });
    
    this.isRunning = true;
    
    // Start broadcasting
    this.startBroadcasting();
    
    logger.info('Peer discovery started');
  }
  
  async stop() {
    if (!this.isRunning) return;
    
    logger.info('Stopping peer discovery');
    
    this.isRunning = false;
    
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
    }
    
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    
    logger.info('Peer discovery stopped');
  }
  
  startBroadcasting() {
    const broadcast = () => {
      if (!this.isRunning) return;
      
      const message = JSON.stringify({
        type: 'otedama-peer',
        port: this.config.port,
        timestamp: Date.now()
      });
      
      this.socket.send(
        message,
        0,
        message.length,
        this.config.port,
        this.config.multicastAddress
      );
    };
    
    // Initial broadcast
    broadcast();
    
    // Schedule periodic broadcasts
    this.broadcastTimer = setInterval(broadcast, this.config.broadcastInterval);
  }
  
  handleMessage(msg, rinfo) {
    try {
      const data = JSON.parse(msg.toString());
      
      if (data.type !== 'otedama-peer') return;
      
      const peerId = `${rinfo.address}:${data.port}`;
      
      // Skip if already discovered recently
      const existing = this.discoveredPeers.get(peerId);
      if (existing && Date.now() - existing.timestamp < 60000) return;
      
      const peerInfo = {
        id: peerId,
        address: rinfo.address,
        port: data.port,
        timestamp: Date.now()
      };
      
      this.discoveredPeers.set(peerId, peerInfo);
      
      logger.debug(`Discovered peer: ${peerId}`);
      this.emit('peer:discovered', peerInfo);
      
    } catch (error) {
      // Ignore invalid messages
    }
  }
  
  getDiscoveredPeers() {
    const now = Date.now();
    const peers = [];
    
    // Clean up old peers
    for (const [id, peer] of this.discoveredPeers) {
      if (now - peer.timestamp < 300000) { // 5 minutes
        peers.push(peer);
      } else {
        this.discoveredPeers.delete(id);
      }
    }
    
    return peers;
  }
}

export default PeerDiscovery;
