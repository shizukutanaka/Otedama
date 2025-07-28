/**
 * P2P Node Discovery for Otedama
 * Implements node discovery and mesh network formation
 * 
 * Design principles:
 * - Carmack: Low-latency peer discovery
 * - Martin: Clean separation of discovery mechanisms
 * - Pike: Simple but effective networking
 */

import { EventEmitter } from 'events';
import dgram from 'dgram';
import net from 'net';
import crypto from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('P2PNodeDiscovery');

/**
 * Node states in the P2P network
 */
export const NodeState = {
  DISCOVERING: 'discovering',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  BANNED: 'banned'
};

/**
 * Peer node representation
 */
export class PeerNode {
  constructor(id, address, port) {
    this.id = id;
    this.address = address;
    this.port = port;
    this.state = NodeState.DISCONNECTED;
    this.lastSeen = Date.now();
    this.latency = 0;
    this.reputation = 100;
    this.version = null;
    this.capabilities = new Set();
    this.sharesSent = 0;
    this.sharesReceived = 0;
    this.blocksFound = 0;
    this.connectionAttempts = 0;
    this.successfulConnections = 0;
  }

  updateLatency(latency) {
    // Exponential moving average
    this.latency = this.latency === 0 ? latency : (this.latency * 0.8 + latency * 0.2);
  }

  updateReputation(delta) {
    this.reputation = Math.max(0, Math.min(100, this.reputation + delta));
  }

  isReliable() {
    return this.reputation > 50 && this.latency < 1000 && this.state === NodeState.CONNECTED;
  }

  serialize() {
    return {
      id: this.id,
      address: this.address,
      port: this.port,
      reputation: this.reputation,
      version: this.version,
      capabilities: Array.from(this.capabilities)
    };
  }
}

/**
 * P2P Node Discovery Service
 */
export class P2PNodeDiscovery extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Network configuration
      nodeId: config.nodeId || crypto.randomBytes(32).toString('hex'),
      listenPort: config.listenPort || 30303,
      discoveryPort: config.discoveryPort || 30303,
      maxPeers: config.maxPeers || 100,
      
      // Discovery settings
      bootstrapNodes: config.bootstrapNodes || [],
      discoveryInterval: config.discoveryInterval || 30000, // 30 seconds
      pingInterval: config.pingInterval || 60000, // 1 minute
      cleanupInterval: config.cleanupInterval || 300000, // 5 minutes
      
      // Connection settings
      connectionTimeout: config.connectionTimeout || 10000,
      maxConnectionAttempts: config.maxConnectionAttempts || 3,
      banThreshold: config.banThreshold || -50,
      
      // DHT settings
      bucketSize: config.bucketSize || 16,
      alpha: config.alpha || 3, // Concurrent lookups
      
      ...config
    };
    
    // Peer management
    this.peers = new Map(); // nodeId -> PeerNode
    this.routingTable = new Map(); // distance -> Set of nodeIds
    this.bannedPeers = new Set();
    
    // Network state
    this.udpSocket = null;
    this.tcpServer = null;
    this.isRunning = false;
    
    // Timers
    this.discoveryTimer = null;
    this.pingTimer = null;
    this.cleanupTimer = null;
    
    // Statistics
    this.stats = {
      nodesDiscovered: 0,
      connectionsEstablished: 0,
      connectionsFailed: 0,
      messagesReceived: 0,
      messagesSent: 0
    };
  }

  /**
   * Start node discovery service
   */
  async start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    
    // Start UDP discovery socket
    await this.startDiscoverySocket();
    
    // Start TCP server for peer connections
    await this.startTCPServer();
    
    // Bootstrap with known nodes
    await this.bootstrap();
    
    // Start periodic tasks
    this.startPeriodicTasks();
    
    logger.info('P2P node discovery started', {
      nodeId: this.config.nodeId,
      listenPort: this.config.listenPort,
      discoveryPort: this.config.discoveryPort
    });
    
    this.emit('started');
  }

  /**
   * Stop node discovery service
   */
  async stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    // Stop timers
    this.stopPeriodicTasks();
    
    // Close connections
    for (const peer of this.peers.values()) {
      await this.disconnectPeer(peer.id);
    }
    
    // Close sockets
    if (this.udpSocket) {
      this.udpSocket.close();
      this.udpSocket = null;
    }
    
    if (this.tcpServer) {
      this.tcpServer.close();
      this.tcpServer = null;
    }
    
    logger.info('P2P node discovery stopped');
    this.emit('stopped');
  }

  /**
   * Start UDP discovery socket
   */
  async startDiscoverySocket() {
    return new Promise((resolve, reject) => {
      this.udpSocket = dgram.createSocket('udp4');
      
      this.udpSocket.on('message', (msg, rinfo) => {
        this.handleDiscoveryMessage(msg, rinfo);
      });
      
      this.udpSocket.on('error', (err) => {
        logger.error('UDP socket error', { error: err.message });
        this.emit('error', err);
      });
      
      this.udpSocket.bind(this.config.discoveryPort, () => {
        logger.info('Discovery socket bound', { port: this.config.discoveryPort });
        resolve();
      });
    });
  }

  /**
   * Start TCP server for peer connections
   */
  async startTCPServer() {
    return new Promise((resolve, reject) => {
      this.tcpServer = net.createServer((socket) => {
        this.handleIncomingConnection(socket);
      });
      
      this.tcpServer.on('error', (err) => {
        logger.error('TCP server error', { error: err.message });
        this.emit('error', err);
      });
      
      this.tcpServer.listen(this.config.listenPort, () => {
        logger.info('TCP server listening', { port: this.config.listenPort });
        resolve();
      });
    });
  }

  /**
   * Bootstrap with known nodes
   */
  async bootstrap() {
    for (const nodeUrl of this.config.bootstrapNodes) {
      try {
        const [address, port] = nodeUrl.split(':');
        await this.ping(address, parseInt(port) || this.config.discoveryPort);
        this.stats.nodesDiscovered++;
      } catch (error) {
        logger.warn('Failed to ping bootstrap node', {
          node: nodeUrl,
          error: error.message
        });
      }
    }
    
    // Start discovery if we have peers
    if (this.peers.size > 0) {
      await this.performNodeLookup(this.config.nodeId);
    }
  }

  /**
   * Handle discovery message
   */
  handleDiscoveryMessage(message, rinfo) {
    try {
      const data = JSON.parse(message.toString());
      this.stats.messagesReceived++;
      
      switch (data.type) {
        case 'ping':
          this.handlePing(data, rinfo);
          break;
          
        case 'pong':
          this.handlePong(data, rinfo);
          break;
          
        case 'findNode':
          this.handleFindNode(data, rinfo);
          break;
          
        case 'neighbors':
          this.handleNeighbors(data, rinfo);
          break;
          
        default:
          logger.debug('Unknown discovery message type', { type: data.type });
      }
    } catch (error) {
      logger.debug('Invalid discovery message', { error: error.message });
    }
  }

  /**
   * Send discovery message
   */
  sendDiscoveryMessage(type, data, address, port) {
    const message = JSON.stringify({
      type,
      nodeId: this.config.nodeId,
      timestamp: Date.now(),
      ...data
    });
    
    this.udpSocket.send(message, port, address, (err) => {
      if (err) {
        logger.debug('Failed to send discovery message', {
          type,
          address,
          port,
          error: err.message
        });
      } else {
        this.stats.messagesSent++;
      }
    });
  }

  /**
   * Send ping message
   */
  async ping(address, port) {
    return new Promise((resolve, reject) => {
      const pingId = crypto.randomBytes(16).toString('hex');
      const startTime = Date.now();
      
      // Set timeout
      const timeout = setTimeout(() => {
        reject(new Error('Ping timeout'));
      }, 5000);
      
      // Listen for pong
      const pongHandler = (data, rinfo) => {
        if (data.type === 'pong' && data.pingId === pingId && rinfo.address === address) {
          clearTimeout(timeout);
          const latency = Date.now() - startTime;
          
          // Add or update peer
          this.addPeer(data.nodeId, address, port, latency);
          
          resolve({ nodeId: data.nodeId, latency });
        }
      };
      
      this.once('discovery:pong', pongHandler);
      
      // Send ping
      this.sendDiscoveryMessage('ping', { pingId }, address, port);
    });
  }

  /**
   * Handle ping message
   */
  handlePing(data, rinfo) {
    // Send pong response
    this.sendDiscoveryMessage('pong', {
      pingId: data.pingId,
      version: '1.0.0',
      capabilities: ['mining', 'share-chain']
    }, rinfo.address, rinfo.port);
    
    // Add peer if new
    if (!this.peers.has(data.nodeId) && !this.bannedPeers.has(data.nodeId)) {
      this.addPeer(data.nodeId, rinfo.address, rinfo.port);
    }
  }

  /**
   * Handle pong message
   */
  handlePong(data, rinfo) {
    this.emit('discovery:pong', data, rinfo);
    
    // Update peer info
    const peer = this.peers.get(data.nodeId);
    if (peer) {
      peer.lastSeen = Date.now();
      peer.version = data.version;
      peer.capabilities = new Set(data.capabilities || []);
    }
  }

  /**
   * Perform node lookup (Kademlia-style)
   */
  async performNodeLookup(targetId) {
    const closestNodes = this.findClosestNodes(targetId, this.config.alpha);
    const queried = new Set();
    const discovered = new Map();
    
    // Query closest nodes
    for (const nodeId of closestNodes) {
      if (queried.has(nodeId)) continue;
      queried.add(nodeId);
      
      const peer = this.peers.get(nodeId);
      if (peer && peer.state === NodeState.CONNECTED) {
        this.sendDiscoveryMessage('findNode', { targetId }, peer.address, peer.port);
      }
    }
    
    // Wait for responses
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // TODO: Iterate until no closer nodes found
  }

  /**
   * Handle find node request
   */
  handleFindNode(data, rinfo) {
    const targetId = data.targetId;
    const closestNodes = this.findClosestNodes(targetId, this.config.bucketSize);
    
    // Send neighbors response
    const neighbors = closestNodes.map(nodeId => {
      const peer = this.peers.get(nodeId);
      return peer ? peer.serialize() : null;
    }).filter(Boolean);
    
    this.sendDiscoveryMessage('neighbors', { neighbors }, rinfo.address, rinfo.port);
  }

  /**
   * Handle neighbors response
   */
  handleNeighbors(data, rinfo) {
    for (const neighborData of data.neighbors || []) {
      if (!this.peers.has(neighborData.id) && !this.bannedPeers.has(neighborData.id)) {
        // Ping new neighbors
        this.ping(neighborData.address, neighborData.port).catch(err => {
          logger.debug('Failed to ping neighbor', {
            neighbor: neighborData.id,
            error: err.message
          });
        });
      }
    }
  }

  /**
   * Add or update peer
   */
  addPeer(nodeId, address, port, latency = 0) {
    if (nodeId === this.config.nodeId) return; // Don't add self
    if (this.bannedPeers.has(nodeId)) return; // Don't add banned peers
    
    let peer = this.peers.get(nodeId);
    
    if (!peer) {
      peer = new PeerNode(nodeId, address, port);
      this.peers.set(nodeId, peer);
      
      // Add to routing table
      this.updateRoutingTable(nodeId);
      
      logger.info('New peer discovered', {
        nodeId,
        address,
        port
      });
      
      this.emit('peer:discovered', peer);
    }
    
    peer.lastSeen = Date.now();
    if (latency > 0) {
      peer.updateLatency(latency);
    }
    
    // Try to establish connection if not connected
    if (peer.state === NodeState.DISCONNECTED && this.peers.size < this.config.maxPeers) {
      this.connectToPeer(nodeId);
    }
  }

  /**
   * Connect to peer via TCP
   */
  async connectToPeer(nodeId) {
    const peer = this.peers.get(nodeId);
    if (!peer || peer.state !== NodeState.DISCONNECTED) return;
    
    peer.state = NodeState.CONNECTING;
    peer.connectionAttempts++;
    
    try {
      const socket = await this.createConnection(peer.address, peer.port);
      
      // Send handshake
      const handshake = {
        type: 'handshake',
        nodeId: this.config.nodeId,
        version: '1.0.0',
        capabilities: ['mining', 'share-chain'],
        networkId: this.config.networkId || 'otedama'
      };
      
      socket.write(JSON.stringify(handshake) + '\n');
      
      // Handle connection
      this.handlePeerConnection(socket, peer);
      
      peer.state = NodeState.CONNECTED;
      peer.successfulConnections++;
      this.stats.connectionsEstablished++;
      
      logger.info('Connected to peer', { nodeId });
      this.emit('peer:connected', peer);
      
    } catch (error) {
      peer.state = NodeState.DISCONNECTED;
      this.stats.connectionsFailed++;
      
      logger.debug('Failed to connect to peer', {
        nodeId,
        error: error.message
      });
      
      // Ban peer if too many failures
      if (peer.connectionAttempts >= this.config.maxConnectionAttempts) {
        this.banPeer(nodeId);
      }
    }
  }

  /**
   * Create TCP connection with timeout
   */
  createConnection(address, port) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      }, this.config.connectionTimeout);
      
      socket.connect(port, address, () => {
        clearTimeout(timeout);
        resolve(socket);
      });
      
      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Handle incoming TCP connection
   */
  handleIncomingConnection(socket) {
    let peer = null;
    let buffer = '';
    
    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      
      for (const line of lines) {
        if (!line) continue;
        
        try {
          const message = JSON.parse(line);
          
          // Handle handshake
          if (message.type === 'handshake' && !peer) {
            peer = this.handleHandshake(message, socket);
          } else if (peer) {
            this.handlePeerMessage(message, peer);
          }
        } catch (error) {
          logger.debug('Invalid peer message', { error: error.message });
        }
      }
    });
    
    socket.on('error', (err) => {
      logger.debug('Peer connection error', { error: err.message });
      if (peer) {
        this.disconnectPeer(peer.id);
      }
    });
    
    socket.on('close', () => {
      if (peer) {
        this.disconnectPeer(peer.id);
      }
    });
  }

  /**
   * Handle handshake
   */
  handleHandshake(message, socket) {
    const nodeId = message.nodeId;
    const address = socket.remoteAddress;
    const port = socket.remotePort;
    
    // Validate handshake
    if (!nodeId || message.networkId !== (this.config.networkId || 'otedama')) {
      socket.destroy();
      return null;
    }
    
    // Add or get peer
    this.addPeer(nodeId, address, port);
    const peer = this.peers.get(nodeId);
    
    if (peer) {
      peer.socket = socket;
      peer.state = NodeState.CONNECTED;
      peer.version = message.version;
      peer.capabilities = new Set(message.capabilities || []);
      
      this.handlePeerConnection(socket, peer);
      
      logger.info('Accepted peer connection', { nodeId });
      this.emit('peer:connected', peer);
    }
    
    return peer;
  }

  /**
   * Handle peer connection
   */
  handlePeerConnection(socket, peer) {
    peer.socket = socket;
    
    // Set keepalive
    socket.setKeepAlive(true, 30000);
    
    // Handle messages
    let buffer = '';
    
    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      
      for (const line of lines) {
        if (!line) continue;
        
        try {
          const message = JSON.parse(line);
          this.handlePeerMessage(message, peer);
        } catch (error) {
          logger.debug('Invalid peer message', { error: error.message });
        }
      }
    });
  }

  /**
   * Handle peer message
   */
  handlePeerMessage(message, peer) {
    peer.lastSeen = Date.now();
    this.stats.messagesReceived++;
    
    // Update reputation based on message quality
    if (this.validateMessage(message)) {
      peer.updateReputation(0.1);
    } else {
      peer.updateReputation(-1);
    }
    
    this.emit('peer:message', message, peer);
  }

  /**
   * Send message to peer
   */
  sendToPeer(nodeId, message) {
    const peer = this.peers.get(nodeId);
    if (!peer || !peer.socket || peer.state !== NodeState.CONNECTED) {
      return false;
    }
    
    try {
      peer.socket.write(JSON.stringify(message) + '\n');
      this.stats.messagesSent++;
      return true;
    } catch (error) {
      logger.debug('Failed to send to peer', {
        nodeId,
        error: error.message
      });
      this.disconnectPeer(nodeId);
      return false;
    }
  }

  /**
   * Broadcast message to all connected peers
   */
  broadcast(message, excludeNodeId = null) {
    let sent = 0;
    
    for (const [nodeId, peer] of this.peers) {
      if (nodeId !== excludeNodeId && peer.state === NodeState.CONNECTED) {
        if (this.sendToPeer(nodeId, message)) {
          sent++;
        }
      }
    }
    
    return sent;
  }

  /**
   * Disconnect peer
   */
  async disconnectPeer(nodeId) {
    const peer = this.peers.get(nodeId);
    if (!peer) return;
    
    if (peer.socket) {
      peer.socket.destroy();
      peer.socket = null;
    }
    
    peer.state = NodeState.DISCONNECTED;
    
    logger.info('Disconnected from peer', { nodeId });
    this.emit('peer:disconnected', peer);
  }

  /**
   * Ban peer
   */
  banPeer(nodeId) {
    const peer = this.peers.get(nodeId);
    if (peer) {
      peer.state = NodeState.BANNED;
      this.disconnectPeer(nodeId);
    }
    
    this.bannedPeers.add(nodeId);
    this.peers.delete(nodeId);
    
    logger.warn('Peer banned', { nodeId });
    this.emit('peer:banned', nodeId);
  }

  /**
   * Update routing table (Kademlia-style)
   */
  updateRoutingTable(nodeId) {
    const distance = this.calculateDistance(this.config.nodeId, nodeId);
    const bucket = Math.floor(Math.log2(parseInt(distance, 16) + 1));
    
    if (!this.routingTable.has(bucket)) {
      this.routingTable.set(bucket, new Set());
    }
    
    const bucketNodes = this.routingTable.get(bucket);
    bucketNodes.add(nodeId);
    
    // Limit bucket size
    if (bucketNodes.size > this.config.bucketSize) {
      // Remove least recently seen
      const nodes = Array.from(bucketNodes);
      nodes.sort((a, b) => {
        const peerA = this.peers.get(a);
        const peerB = this.peers.get(b);
        return (peerA?.lastSeen || 0) - (peerB?.lastSeen || 0);
      });
      
      bucketNodes.delete(nodes[0]);
    }
  }

  /**
   * Calculate XOR distance between node IDs
   */
  calculateDistance(id1, id2) {
    const buf1 = Buffer.from(id1, 'hex');
    const buf2 = Buffer.from(id2, 'hex');
    const result = Buffer.alloc(32);
    
    for (let i = 0; i < 32; i++) {
      result[i] = buf1[i] ^ buf2[i];
    }
    
    return result.toString('hex');
  }

  /**
   * Find K closest nodes to target
   */
  findClosestNodes(targetId, k) {
    const allNodes = Array.from(this.peers.keys());
    
    // Sort by distance
    allNodes.sort((a, b) => {
      const distA = this.calculateDistance(targetId, a);
      const distB = this.calculateDistance(targetId, b);
      return distA.localeCompare(distB);
    });
    
    return allNodes.slice(0, k);
  }

  /**
   * Validate message
   */
  validateMessage(message) {
    return message && 
           typeof message === 'object' && 
           message.type && 
           typeof message.type === 'string';
  }

  /**
   * Start periodic tasks
   */
  startPeriodicTasks() {
    // Discovery task
    this.discoveryTimer = setInterval(() => {
      this.performDiscovery();
    }, this.config.discoveryInterval);
    
    // Ping task
    this.pingTimer = setInterval(() => {
      this.pingPeers();
    }, this.config.pingInterval);
    
    // Cleanup task
    this.cleanupTimer = setInterval(() => {
      this.cleanupPeers();
    }, this.config.cleanupInterval);
  }

  /**
   * Stop periodic tasks
   */
  stopPeriodicTasks() {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Perform node discovery
   */
  async performDiscovery() {
    // Only discover if below max peers
    if (this.peers.size >= this.config.maxPeers) return;
    
    // Perform lookup for random node ID
    const randomId = crypto.randomBytes(32).toString('hex');
    await this.performNodeLookup(randomId);
  }

  /**
   * Ping all connected peers
   */
  async pingPeers() {
    for (const [nodeId, peer] of this.peers) {
      if (peer.state === NodeState.CONNECTED) {
        try {
          await this.ping(peer.address, peer.port);
        } catch (error) {
          logger.debug('Ping failed', { nodeId, error: error.message });
          peer.updateReputation(-5);
        }
      }
    }
  }

  /**
   * Clean up inactive peers
   */
  cleanupPeers() {
    const now = Date.now();
    const timeout = 10 * 60 * 1000; // 10 minutes
    
    for (const [nodeId, peer] of this.peers) {
      // Remove inactive peers
      if (now - peer.lastSeen > timeout) {
        this.disconnectPeer(nodeId);
        this.peers.delete(nodeId);
        logger.info('Removed inactive peer', { nodeId });
      }
      
      // Ban peers with bad reputation
      if (peer.reputation <= this.config.banThreshold) {
        this.banPeer(nodeId);
      }
    }
  }

  /**
   * Get connected peers
   */
  getConnectedPeers() {
    return Array.from(this.peers.values()).filter(peer => peer.state === NodeState.CONNECTED);
  }

  /**
   * Get peer by ID
   */
  getPeer(nodeId) {
    return this.peers.get(nodeId);
  }

  /**
   * Get network statistics
   */
  getStats() {
    const connectedPeers = this.getConnectedPeers();
    
    return {
      nodeId: this.config.nodeId,
      totalPeers: this.peers.size,
      connectedPeers: connectedPeers.length,
      bannedPeers: this.bannedPeers.size,
      averageLatency: connectedPeers.reduce((sum, p) => sum + p.latency, 0) / (connectedPeers.length || 1),
      ...this.stats
    };
  }
}

export default P2PNodeDiscovery;