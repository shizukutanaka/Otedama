/**
 * Simple P2P Network
 * Lightweight peer-to-peer networking for mining pool
 */

const { EventEmitter } = require('events');
const net = require('net');
const crypto = require('crypto');
const { createLogger } = require('../core/logger');
const tls = require('tls');
const fs = require('fs');

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
    this.messageRateLimits = new Map();
    this.blacklistedIPs = new Set();
    
    // Security limits
    this.maxMessageSize = 100000; // 100KB
    this.maxMessagesPerMinute = 100;
    this.maxPeerConnections = 3; // Max connections from same IP
    
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
    // Check if IP is blacklisted
    const remoteIP = socket.remoteAddress;
    if (this.blacklistedIPs.has(remoteIP)) {
      logger.warn('Rejected connection from blacklisted IP:', remoteIP);
      socket.destroy();
      return;
    }
    
    // Check connection limit per IP
    const connectionsFromIP = Array.from(this.peers.values())
      .filter(p => p.address.startsWith(remoteIP)).length;
    
    if (connectionsFromIP >= this.maxPeerConnections) {
      logger.warn('Too many connections from IP:', remoteIP);
      socket.destroy();
      return;
    }
    
    const peerId = crypto.randomBytes(20).toString('hex');
    
    const peer = {
      id: peerId,
      socket: socket,
      address: `${socket.remoteAddress}:${socket.remotePort}`,
      connected: true,
      lastSeen: Date.now(),
      authenticated: false,
      buffer: Buffer.alloc(0)
    };
    
    this.peers.set(peerId, peer);
    
    socket.on('data', (data) => {
      // Accumulate data in buffer
      peer.buffer = Buffer.concat([peer.buffer, data]);
      
      // Check buffer size limit
      if (peer.buffer.length > this.maxMessageSize) {
        logger.warn('Peer buffer overflow, disconnecting:', peerId);
        this.blacklistIP(remoteIP);
        socket.destroy();
        return;
      }
      
      this.handlePeerData(peer);
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
  handlePeerData(peer) {
    try {
      // Check rate limit
      if (!this.checkRateLimit(peer.id)) {
        logger.warn('Rate limit exceeded for peer:', peer.id);
        this.blacklistIP(peer.address.split(':')[0]);
        peer.socket.destroy();
        return;
      }
      
      // Process complete messages from buffer
      let newlineIndex;
      while ((newlineIndex = peer.buffer.indexOf(0x0a)) !== -1) { // 0x0a = \n
        const messageBuffer = peer.buffer.slice(0, newlineIndex);
        peer.buffer = peer.buffer.slice(newlineIndex + 1);
        
        if (messageBuffer.length === 0) continue;
        
        // Parse message with size limit
        const messageStr = messageBuffer.toString('utf8');
        if (messageStr.length > this.maxMessageSize) {
          logger.warn('Message too large from peer:', peer.id);
          continue;
        }
        
        let json;
        try {
          json = JSON.parse(messageStr);
        } catch (parseErr) {
          logger.warn('Invalid JSON from peer:', peer.id);
          continue;
        }
        
        // Validate message structure
        if (!json || typeof json !== 'object' || !json.type) {
          logger.warn('Invalid message structure from peer:', peer.id);
          continue;
        }
        
        if (json.type === 'handshake') {
          // Validate handshake
          if (!this.validateHandshake(json)) {
            logger.warn('Invalid handshake from peer:', peer.id);
            peer.socket.destroy();
            return;
          }
          
          peer.nodeId = json.nodeId;
          peer.version = json.version;
          peer.authenticated = true;
          
          // Request peer list
          this.sendToPeer(peer, { type: 'getPeers' });
        } else if (peer.authenticated) {
          const handler = this.messageHandlers.get(json.type);
          if (handler) {
            handler(peer, json);
          } else {
            logger.debug('Unknown message type:', json.type);
          }
        } else {
          logger.warn('Unauthenticated message from peer:', peer.id);
          peer.socket.destroy();
          return;
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
    if (peer.socket && peer.connected && peer.authenticated) {
      try {
        const data = JSON.stringify(message) + '\n';
        if (data.length > this.maxMessageSize) {
          logger.warn('Attempting to send oversized message');
          return;
        }
        peer.socket.write(data);
      } catch (err) {
        logger.error('Error sending to peer:', err);
      }
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
    // Rate limit peer list requests
    const lastRequest = peer.lastPeerRequest || 0;
    if (Date.now() - lastRequest < 30000) { // 30 seconds
      return;
    }
    peer.lastPeerRequest = Date.now();
    
    const peerList = Array.from(this.peers.values())
      .filter(p => p.connected && p.authenticated && p.id !== peer.id)
      .map(p => p.address)
      .slice(0, 10);
    
    this.sendToPeer(peer, { type: 'peers', peers: peerList });
  }
  
  handlePeers(peer, message) {
    // Validate peers list
    if (!Array.isArray(message.peers) || message.peers.length > 50) {
      return;
    }
    
    for (const address of message.peers.slice(0, 10)) {
      // Validate address format
      if (!this.isValidAddress(address)) {
        continue;
      }
      
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

  // Security helper methods
  checkRateLimit(peerId) {
    const now = Date.now();
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
    return rateLimit.count <= this.maxMessagesPerMinute;
  }
  
  validateHandshake(handshake) {
    return handshake.nodeId && 
           typeof handshake.nodeId === 'string' &&
           handshake.nodeId.length === 40 &&
           /^[a-f0-9]{40}$/.test(handshake.nodeId) &&
           handshake.version &&
           typeof handshake.version === 'string';
  }
  
  isValidAddress(address) {
    const parts = address.split(':');
    if (parts.length !== 2) return false;
    
    const [host, port] = parts;
    const portNum = parseInt(port);
    
    return /^[0-9.]+$/.test(host) && 
           portNum > 0 && 
           portNum < 65536;
  }
  
  blacklistIP(ip) {
    this.blacklistedIPs.add(ip);
    
    // Disconnect all peers from this IP
    for (const [id, peer] of this.peers) {
      if (peer.address.startsWith(ip)) {
        peer.socket.destroy();
        this.peers.delete(id);
      }
    }
  }
}

module.exports = SimpleP2PNetwork;