/**
 * Simple P2P Network
 * Lightweight peer-to-peer networking for mining pool
 */

const { EventEmitter } = require('events');
const net = require('net');
const crypto = require('crypto');
const { createLogger } = require('../core/logger');

const logger = createLogger('simple-p2p-network');

class SimpleP2PNetwork extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      port: config.port || 6633,
      maxPeers: config.maxPeers || 50,
      seedNodes: config.seedNodes || [],
      nodeId: config.nodeId || crypto.randomBytes(20).toString('hex'),
      ...config
    };
    
    this.peers = new Map();
    this.server = null;
    this.messageHandlers = new Map();
    
    // Register default message handlers
    this.registerHandler('ping', this.handlePing.bind(this));
    this.registerHandler('pong', this.handlePong.bind(this));
    this.registerHandler('peers', this.handlePeers.bind(this));
    this.registerHandler('getPeers', this.handleGetPeers.bind(this));
  }
  
  /**
   * Start P2P network
   */
  async start() {
    // Start server
    this.server = net.createServer(this.handleConnection.bind(this));
    
    this.server.listen(this.config.port, () => {
      logger.info(`P2P server listening on port ${this.config.port}`);
      this.emit('started', { port: this.config.port, nodeId: this.config.nodeId });
    });
    
    this.server.on('error', (err) => {
      logger.error('Server error:', err);
      this.emit('error', err);
    });
    
    // Connect to seed nodes
    for (const seedNode of this.config.seedNodes) {
      this.connectToPeer(seedNode);
    }
    
    // Start maintenance tasks
    this.startMaintenance();
  }
  
  /**
   * Handle incoming connection
   */
  handleConnection(socket) {
    const peerId = crypto.randomBytes(20).toString('hex');
    
    const peer = {
      id: peerId,
      socket: socket,
      address: `${socket.remoteAddress}:${socket.remotePort}`,
      connected: true,
      lastSeen: Date.now()
    };
    
    this.peers.set(peerId, peer);
    
    socket.on('data', (data) => {
      this.handlePeerData(peer, data);
    });
    
    socket.on('close', () => {
      this.peers.delete(peerId);
      this.emit('peer-disconnected', { peerId });
    });
    
    socket.on('error', (err) => {
      logger.debug(`Peer ${peerId} error:`, err.message);
    });
    
    // Send handshake
    this.sendToPeer(peer, {
      type: 'handshake',
      nodeId: this.config.nodeId,
      version: '1.0.0'
    });
    
    this.emit('peer-connected', { peerId, address: peer.address });
  }
  
  /**
   * Connect to a peer
   */
  connectToPeer(address) {
    if (this.peers.size >= this.config.maxPeers) {
      return;
    }
    
    const [host, port] = address.split(':');
    const socket = net.connect(parseInt(port), host, () => {
      const peerId = crypto.randomBytes(20).toString('hex');
      
      const peer = {
        id: peerId,
        socket: socket,
        address: address,
        connected: true,
        lastSeen: Date.now()
      };
      
      this.peers.set(peerId, peer);
      
      socket.on('data', (data) => {
        this.handlePeerData(peer, data);
      });
      
      socket.on('close', () => {
        this.peers.delete(peerId);
      });
      
      socket.on('error', (err) => {
        logger.debug(`Failed to connect to ${address}:`, err.message);
      });
      
      // Send handshake
      this.sendToPeer(peer, {
        type: 'handshake',
        nodeId: this.config.nodeId,
        version: '1.0.0'
      });
      
      logger.info(`Connected to peer ${address}`);
    });
  }
  
  /**
   * Handle data from peer
   */
  handlePeerData(peer, data) {
    try {
      const messages = data.toString().trim().split('\n');
      
      for (const message of messages) {
        if (!message) continue;
        
        const json = JSON.parse(message);
        
        if (json.type === 'handshake') {
          peer.nodeId = json.nodeId;
          peer.version = json.version;
          
          // Request peer list
          this.sendToPeer(peer, { type: 'getPeers' });
        } else {
          const handler = this.messageHandlers.get(json.type);
          if (handler) {
            handler(peer, json);
          } else {
            logger.debug('Unknown message type:', json.type);
          }
        }
        
        peer.lastSeen = Date.now();
      }
    } catch (err) {
      logger.debug('Parse error:', err.message);
    }
  }
  
  /**
   * Send message to peer
   */
  sendToPeer(peer, message) {
    if (peer.socket && peer.connected) {
      peer.socket.write(JSON.stringify(message) + '\n');
    }
  }
  
  /**
   * Broadcast message to all peers
   */
  broadcast(message, excludePeer = null) {
    for (const [peerId, peer] of this.peers) {
      if (excludePeer && peerId === excludePeer.id) continue;
      this.sendToPeer(peer, message);
    }
  }
  
  /**
   * Register message handler
   */
  registerHandler(type, handler) {
    this.messageHandlers.set(type, handler);
  }
  
  /**
   * Default message handlers
   */
  handlePing(peer, message) {
    this.sendToPeer(peer, { type: 'pong', timestamp: Date.now() });
  }
  
  handlePong(peer, message) {
    peer.latency = Date.now() - message.timestamp;
  }
  
  handleGetPeers(peer, message) {
    const peerList = Array.from(this.peers.values())
      .filter(p => p.connected && p.id !== peer.id)
      .map(p => p.address)
      .slice(0, 10);
    
    this.sendToPeer(peer, { type: 'peers', peers: peerList });
  }
  
  handlePeers(peer, message) {
    for (const address of message.peers) {
      if (!this.isPeerConnected(address)) {
        this.connectToPeer(address);
      }
    }
  }
  
  /**
   * Check if peer is connected
   */
  isPeerConnected(address) {
    for (const [id, peer] of this.peers) {
      if (peer.address === address) {
        return true;
      }
    }
    return false;
  }
  
  /**
   * Start maintenance tasks
   */
  startMaintenance() {
    // Ping peers every 30 seconds
    setInterval(() => {
      for (const [id, peer] of this.peers) {
        this.sendToPeer(peer, { type: 'ping', timestamp: Date.now() });
      }
    }, 30000);
    
    // Remove inactive peers
    setInterval(() => {
      const now = Date.now();
      for (const [id, peer] of this.peers) {
        if (now - peer.lastSeen > 120000) { // 2 minutes
          logger.info(`Removing inactive peer ${id}`);
          peer.socket.destroy();
          this.peers.delete(id);
        }
      }
    }, 60000);
    
    // Try to maintain minimum peers
    setInterval(() => {
      if (this.peers.size < 5) {
        this.broadcast({ type: 'getPeers' });
      }
    }, 10000);
  }
  
  /**
   * Get network statistics
   */
  getStats() {
    return {
      nodeId: this.config.nodeId,
      peers: this.peers.size,
      maxPeers: this.config.maxPeers,
      connections: Array.from(this.peers.values()).map(p => ({
        id: p.id,
        address: p.address,
        connected: p.connected,
        latency: p.latency || null
      }))
    };
  }
  
  /**
   * Stop P2P network
   */
  async stop() {
    // Close all peer connections
    for (const [id, peer] of this.peers) {
      if (peer.socket) {
        peer.socket.destroy();
      }
    }
    
    // Close server
    if (this.server) {
      this.server.close();
    }
    
    this.emit('stopped');
  }
}

/**
 * Create simple P2P network instance
 */
function createSimpleP2PNetwork(config) {
  return new SimpleP2PNetwork(config);
}

module.exports = SimpleP2PNetwork;