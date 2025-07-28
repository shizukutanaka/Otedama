/**
 * Advanced Peer Discovery System for Otedama P2P Pool
 * Implements multiple discovery mechanisms for robust peer finding
 * 
 * Design principles:
 * - Carmack: Fast peer discovery with minimal overhead
 * - Martin: Clean separation of discovery mechanisms
 * - Pike: Simple but effective peer management
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import crypto from 'crypto';
import dgram from 'dgram';
import net from 'net';

const logger = createStructuredLogger('AdvancedPeerDiscovery');

/**
 * Discovery mechanisms
 */
const DISCOVERY_MECHANISMS = {
  DHT: 'dht',                    // Distributed Hash Table
  MDNS: 'mdns',                  // Multicast DNS for LAN
  BOOTSTRAP: 'bootstrap',        // Bootstrap nodes
  GOSSIP: 'gossip',              // Peer exchange protocol
  TRACKER: 'tracker',            // Central tracker (optional)
  STUN: 'stun'                   // STUN for NAT traversal
};

/**
 * Peer states
 */
const PEER_STATES = {
  DISCOVERED: 'discovered',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  AUTHENTICATED: 'authenticated',
  ACTIVE: 'active',
  DISCONNECTING: 'disconnecting',
  DISCONNECTED: 'disconnected'
};

/**
 * Kademlia DHT implementation for peer discovery
 */
class KademliaDHT {
  constructor(nodeId, port) {
    this.nodeId = nodeId;
    this.port = port;
    this.buckets = new Array(256).fill(null).map(() => []);
    this.store = new Map();
    this.socket = dgram.createSocket('udp4');
  }
  
  /**
   * Calculate XOR distance between two node IDs
   */
  distance(id1, id2) {
    const buf1 = Buffer.from(id1, 'hex');
    const buf2 = Buffer.from(id2, 'hex');
    const result = Buffer.alloc(32);
    
    for (let i = 0; i < 32; i++) {
      result[i] = buf1[i] ^ buf2[i];
    }
    
    return result;
  }
  
  /**
   * Find bucket index for a node ID
   */
  getBucketIndex(nodeId) {
    const dist = this.distance(this.nodeId, nodeId);
    
    for (let i = 0; i < 256; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = 7 - (i % 8);
      
      if (dist[byteIndex] & (1 << bitIndex)) {
        return 255 - i;
      }
    }
    
    return 0;
  }
  
  /**
   * Add node to routing table
   */
  addNode(nodeInfo) {
    const bucketIndex = this.getBucketIndex(nodeInfo.id);
    const bucket = this.buckets[bucketIndex];
    
    // Check if node already exists
    const existingIndex = bucket.findIndex(n => n.id === nodeInfo.id);
    
    if (existingIndex >= 0) {
      // Move to end (most recently seen)
      bucket.splice(existingIndex, 1);
      bucket.push(nodeInfo);
    } else if (bucket.length < 20) { // K=20 for Kademlia
      bucket.push(nodeInfo);
    } else {
      // Bucket full, ping oldest node
      this.pingNode(bucket[0]);
    }
  }
  
  /**
   * Find K closest nodes to target ID
   */
  findClosestNodes(targetId, k = 20) {
    const allNodes = [];
    
    for (const bucket of this.buckets) {
      allNodes.push(...bucket);
    }
    
    // Sort by distance to target
    allNodes.sort((a, b) => {
      const distA = this.distance(a.id, targetId);
      const distB = this.distance(b.id, targetId);
      return Buffer.compare(distA, distB);
    });
    
    return allNodes.slice(0, k);
  }
  
  /**
   * Perform iterative find node
   */
  async iterativeFindNode(targetId) {
    const queried = new Set();
    const active = new Set();
    const results = new Map();
    
    // Start with closest known nodes
    const initial = this.findClosestNodes(targetId);
    for (const node of initial) {
      active.add(node.id);
      results.set(node.id, node);
    }
    
    while (active.size > 0) {
      const promises = [];
      
      for (const nodeId of active) {
        if (queried.has(nodeId)) continue;
        
        const node = results.get(nodeId);
        promises.push(this.sendFindNode(node, targetId));
        queried.add(nodeId);
      }
      
      active.clear();
      
      const responses = await Promise.allSettled(promises);
      
      for (const response of responses) {
        if (response.status === 'fulfilled' && response.value) {
          for (const node of response.value.nodes) {
            if (!results.has(node.id)) {
              results.set(node.id, node);
              active.add(node.id);
            }
          }
        }
      }
    }
    
    return Array.from(results.values());
  }
  
  /**
   * Send FIND_NODE RPC
   */
  async sendFindNode(node, targetId) {
    const message = {
      type: 'FIND_NODE',
      sender: this.nodeId,
      target: targetId,
      nonce: crypto.randomBytes(16).toString('hex')
    };
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 2000);
      
      this.socket.send(JSON.stringify(message), node.port, node.ip, (err) => {
        if (err) {
          clearTimeout(timeout);
          resolve(null);
        }
      });
      
      // Store callback for response
      this.pendingRequests.set(message.nonce, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
  }
  
  /**
   * Ping node to check if alive
   */
  async pingNode(node) {
    const message = {
      type: 'PING',
      sender: this.nodeId,
      nonce: crypto.randomBytes(16).toString('hex')
    };
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 1000);
      
      this.socket.send(JSON.stringify(message), node.port, node.ip, (err) => {
        if (err) {
          clearTimeout(timeout);
          resolve(false);
        }
      });
      
      this.pendingRequests.set(message.nonce, () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }
}

/**
 * Peer information and connection state
 */
class PeerInfo {
  constructor(id, address, port) {
    this.id = id;
    this.address = address;
    this.port = port;
    this.state = PEER_STATES.DISCOVERED;
    this.discoveredAt = Date.now();
    this.lastSeen = Date.now();
    this.connectionAttempts = 0;
    this.successfulConnections = 0;
    this.reputation = 100;
    
    // Connection quality metrics
    this.latency = 0;
    this.packetLoss = 0;
    this.bandwidth = 0;
    
    // P2P pool specific
    this.shareChainHeight = 0;
    this.poolVersion = null;
    this.capabilities = new Set();
    
    // NAT information
    this.natType = 'unknown';
    this.publicAddress = null;
    this.publicPort = null;
  }
  
  /**
   * Update peer quality metrics
   */
  updateQuality(latency, success) {
    const alpha = 0.1;
    
    if (latency > 0) {
      this.latency = this.latency * (1 - alpha) + latency * alpha;
    }
    
    if (success) {
      this.reputation = Math.min(100, this.reputation + 1);
      this.packetLoss = this.packetLoss * (1 - alpha);
    } else {
      this.reputation = Math.max(0, this.reputation - 5);
      this.packetLoss = this.packetLoss * (1 - alpha) + alpha;
    }
    
    this.lastSeen = Date.now();
  }
  
  /**
   * Calculate peer score for selection
   */
  getScore() {
    const age = Date.now() - this.discoveredAt;
    const freshness = Date.now() - this.lastSeen;
    
    // Combine multiple factors
    const reputationScore = this.reputation / 100;
    const latencyScore = 1 / (1 + this.latency / 1000);
    const lossScore = 1 - this.packetLoss;
    const freshnessScore = 1 / (1 + freshness / 60000);
    
    return reputationScore * 0.4 + 
           latencyScore * 0.3 + 
           lossScore * 0.2 + 
           freshnessScore * 0.1;
  }
  
  /**
   * Check if peer is healthy
   */
  isHealthy() {
    const stale = (Date.now() - this.lastSeen) > 300000; // 5 minutes
    const unreliable = this.packetLoss > 0.5;
    const badReputation = this.reputation < 20;
    
    return !stale && !unreliable && !badReputation;
  }
}

/**
 * Advanced Peer Discovery System
 */
export class AdvancedPeerDiscovery extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      nodeId: config.nodeId || crypto.randomBytes(32).toString('hex'),
      listenPort: config.listenPort || 30303,
      
      // Discovery mechanisms
      mechanisms: config.mechanisms || [
        DISCOVERY_MECHANISMS.DHT,
        DISCOVERY_MECHANISMS.BOOTSTRAP,
        DISCOVERY_MECHANISMS.GOSSIP
      ],
      
      // Bootstrap nodes
      bootstrapNodes: config.bootstrapNodes || [],
      
      // Discovery intervals
      dhtInterval: config.dhtInterval || 30000,
      gossipInterval: config.gossipInterval || 10000,
      healthCheckInterval: config.healthCheckInterval || 60000,
      
      // Peer limits
      maxPeers: config.maxPeers || 100,
      minPeers: config.minPeers || 10,
      targetPeers: config.targetPeers || 50,
      
      // Connection parameters
      connectionTimeout: config.connectionTimeout || 5000,
      maxConnectionAttempts: config.maxConnectionAttempts || 3,
      
      // NAT traversal
      enableSTUN: config.enableSTUN || true,
      stunServers: config.stunServers || [
        'stun.l.google.com:19302',
        'stun1.l.google.com:19302'
      ],
      
      ...config
    };
    
    // Peer management
    this.peers = new Map(); // peerId -> PeerInfo
    this.connections = new Map(); // peerId -> socket
    
    // Discovery mechanisms
    this.dht = null;
    this.discoverySocket = null;
    this.server = null;
    
    // Statistics
    this.stats = {
      peersDiscovered: 0,
      connectionAttempts: 0,
      successfulConnections: 0,
      failedConnections: 0,
      messagesSent: 0,
      messagesReceived: 0
    };
    
    this.logger = logger;
  }
  
  /**
   * Initialize discovery system
   */
  async initialize() {
    // Initialize DHT if enabled
    if (this.config.mechanisms.includes(DISCOVERY_MECHANISMS.DHT)) {
      this.dht = new KademliaDHT(this.config.nodeId, this.config.listenPort);
      this.dht.pendingRequests = new Map();
      
      // Setup DHT message handling
      this.dht.socket.on('message', (msg, rinfo) => {
        this.handleDHTMessage(msg, rinfo);
      });
      
      await new Promise((resolve) => {
        this.dht.socket.bind(this.config.listenPort, resolve);
      });
    }
    
    // Initialize TCP server for peer connections
    this.server = net.createServer((socket) => {
      this.handleIncomingConnection(socket);
    });
    
    await new Promise((resolve) => {
      this.server.listen(this.config.listenPort, resolve);
    });
    
    // Bootstrap network
    await this.bootstrapNetwork();
    
    // Start discovery processes
    this.startDiscoveryProcesses();
    
    // Start health monitoring
    this.startHealthMonitoring();
    
    this.logger.info('Advanced peer discovery initialized', {
      nodeId: this.config.nodeId,
      mechanisms: this.config.mechanisms,
      port: this.config.listenPort
    });
  }
  
  /**
   * Bootstrap network connection
   */
  async bootstrapNetwork() {
    if (!this.config.mechanisms.includes(DISCOVERY_MECHANISMS.BOOTSTRAP)) {
      return;
    }
    
    const promises = [];
    
    for (const node of this.config.bootstrapNodes) {
      const [address, port] = node.split(':');
      promises.push(this.connectToPeer(address, parseInt(port)));
    }
    
    const results = await Promise.allSettled(promises);
    
    const successful = results.filter(r => r.status === 'fulfilled').length;
    this.logger.info('Bootstrap completed', {
      attempted: this.config.bootstrapNodes.length,
      successful
    });
  }
  
  /**
   * Connect to peer
   */
  async connectToPeer(address, port, peerId = null) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      }, this.config.connectionTimeout);
      
      socket.connect(port, address, () => {
        clearTimeout(timeout);
        
        // Send handshake
        const handshake = {
          type: 'HANDSHAKE',
          nodeId: this.config.nodeId,
          version: '1.0.0',
          capabilities: ['sharechain', 'stratum', 'p2p'],
          timestamp: Date.now()
        };
        
        socket.write(JSON.stringify(handshake) + '\n');
      });
      
      socket.on('data', (data) => {
        // Handle handshake response
        try {
          const response = JSON.parse(data.toString());
          if (response.type === 'HANDSHAKE_ACK') {
            const peer = this.addPeer(response.nodeId, address, port);
            this.connections.set(response.nodeId, socket);
            
            this.setupSocketHandlers(socket, response.nodeId);
            
            this.emit('peer:connected', { peerId: response.nodeId });
            resolve(peer);
          }
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      });
      
      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
  
  /**
   * Handle incoming connection
   */
  handleIncomingConnection(socket) {
    let peerId = null;
    
    socket.on('data', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'HANDSHAKE') {
          peerId = message.nodeId;
          
          // Add peer
          const peer = this.addPeer(
            peerId,
            socket.remoteAddress,
            socket.remotePort
          );
          
          // Send acknowledgment
          const ack = {
            type: 'HANDSHAKE_ACK',
            nodeId: this.config.nodeId,
            version: '1.0.0',
            capabilities: ['sharechain', 'stratum', 'p2p'],
            timestamp: Date.now()
          };
          
          socket.write(JSON.stringify(ack) + '\n');
          
          this.connections.set(peerId, socket);
          this.setupSocketHandlers(socket, peerId);
          
          this.emit('peer:connected', { peerId });
        }
      } catch (error) {
        this.logger.error('Error handling incoming connection', {
          error: error.message
        });
      }
    });
    
    socket.on('error', (error) => {
      if (peerId) {
        this.handlePeerDisconnection(peerId);
      }
    });
    
    socket.on('close', () => {
      if (peerId) {
        this.handlePeerDisconnection(peerId);
      }
    });
  }
  
  /**
   * Setup socket handlers
   */
  setupSocketHandlers(socket, peerId) {
    socket.on('data', (data) => {
      this.handlePeerMessage(peerId, data);
    });
    
    socket.on('error', (error) => {
      this.logger.debug('Socket error', { peerId, error: error.message });
      this.handlePeerDisconnection(peerId);
    });
    
    socket.on('close', () => {
      this.handlePeerDisconnection(peerId);
    });
  }
  
  /**
   * Handle peer message
   */
  handlePeerMessage(peerId, data) {
    try {
      const messages = data.toString().split('\n').filter(m => m.length > 0);
      
      for (const msgStr of messages) {
        const message = JSON.parse(msgStr);
        
        switch (message.type) {
          case 'PEER_EXCHANGE':
            this.handlePeerExchange(peerId, message.peers);
            break;
            
          case 'PING':
            this.handlePing(peerId, message);
            break;
            
          case 'SHARE_CHAIN_HEIGHT':
            this.updatePeerInfo(peerId, { shareChainHeight: message.height });
            break;
            
          default:
            this.emit('peer:message', { peerId, message });
        }
      }
      
      this.stats.messagesReceived++;
      
    } catch (error) {
      this.logger.error('Error handling peer message', {
        peerId,
        error: error.message
      });
    }
  }
  
  /**
   * Handle DHT message
   */
  handleDHTMessage(msg, rinfo) {
    try {
      const message = JSON.parse(msg.toString());
      
      switch (message.type) {
        case 'PING':
          this.sendDHTResponse(rinfo, {
            type: 'PONG',
            nonce: message.nonce,
            sender: this.config.nodeId
          });
          break;
          
        case 'FIND_NODE':
          const closest = this.dht.findClosestNodes(message.target);
          this.sendDHTResponse(rinfo, {
            type: 'FIND_NODE_RESPONSE',
            nonce: message.nonce,
            sender: this.config.nodeId,
            nodes: closest.map(n => ({
              id: n.id,
              ip: n.ip,
              port: n.port
            }))
          });
          break;
          
        case 'PONG':
        case 'FIND_NODE_RESPONSE':
          const callback = this.dht.pendingRequests.get(message.nonce);
          if (callback) {
            callback(message);
            this.dht.pendingRequests.delete(message.nonce);
          }
          break;
      }
    } catch (error) {
      this.logger.debug('Invalid DHT message', { error: error.message });
    }
  }
  
  /**
   * Send DHT response
   */
  sendDHTResponse(rinfo, response) {
    const data = JSON.stringify(response);
    this.dht.socket.send(data, rinfo.port, rinfo.address);
  }
  
  /**
   * Handle peer exchange
   */
  handlePeerExchange(fromPeerId, peers) {
    for (const peerInfo of peers) {
      if (peerInfo.id === this.config.nodeId) continue;
      if (this.peers.has(peerInfo.id)) continue;
      
      // Add to DHT if available
      if (this.dht) {
        this.dht.addNode({
          id: peerInfo.id,
          ip: peerInfo.address,
          port: peerInfo.port
        });
      }
      
      // Consider connecting if we need more peers
      if (this.connections.size < this.config.targetPeers) {
        this.connectToPeer(peerInfo.address, peerInfo.port, peerInfo.id)
          .catch(error => {
            this.logger.debug('Failed to connect to exchanged peer', {
              peerId: peerInfo.id,
              error: error.message
            });
          });
      }
    }
  }
  
  /**
   * Handle ping message
   */
  handlePing(peerId, message) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    // Update peer info
    peer.lastSeen = Date.now();
    
    // Send pong
    const socket = this.connections.get(peerId);
    if (socket) {
      const pong = {
        type: 'PONG',
        nonce: message.nonce,
        timestamp: Date.now()
      };
      
      socket.write(JSON.stringify(pong) + '\n');
    }
  }
  
  /**
   * Add peer to registry
   */
  addPeer(id, address, port) {
    let peer = this.peers.get(id);
    
    if (!peer) {
      peer = new PeerInfo(id, address, port);
      this.peers.set(id, peer);
      this.stats.peersDiscovered++;
      
      this.emit('peer:discovered', {
        peerId: id,
        address,
        port
      });
    } else {
      peer.lastSeen = Date.now();
    }
    
    return peer;
  }
  
  /**
   * Update peer information
   */
  updatePeerInfo(peerId, updates) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    Object.assign(peer, updates);
    peer.lastSeen = Date.now();
  }
  
  /**
   * Handle peer disconnection
   */
  handlePeerDisconnection(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.state = PEER_STATES.DISCONNECTED;
    }
    
    const socket = this.connections.get(peerId);
    if (socket) {
      socket.destroy();
      this.connections.delete(peerId);
    }
    
    this.emit('peer:disconnected', { peerId });
    
    // Try to maintain minimum peers
    if (this.connections.size < this.config.minPeers) {
      this.discoverNewPeers();
    }
  }
  
  /**
   * Start discovery processes
   */
  startDiscoveryProcesses() {
    // DHT discovery
    if (this.config.mechanisms.includes(DISCOVERY_MECHANISMS.DHT)) {
      this.dhtInterval = setInterval(() => {
        this.performDHTDiscovery();
      }, this.config.dhtInterval);
    }
    
    // Gossip protocol
    if (this.config.mechanisms.includes(DISCOVERY_MECHANISMS.GOSSIP)) {
      this.gossipInterval = setInterval(() => {
        this.performGossipExchange();
      }, this.config.gossipInterval);
    }
  }
  
  /**
   * Perform DHT discovery
   */
  async performDHTDiscovery() {
    if (!this.dht) return;
    
    // Find nodes close to our ID
    const nodes = await this.dht.iterativeFindNode(this.config.nodeId);
    
    // Connect to discovered nodes if needed
    for (const node of nodes) {
      if (this.connections.size >= this.config.targetPeers) break;
      if (this.connections.has(node.id)) continue;
      
      this.connectToPeer(node.ip, node.port, node.id)
        .catch(error => {
          this.logger.debug('DHT connection failed', {
            nodeId: node.id,
            error: error.message
          });
        });
    }
  }
  
  /**
   * Perform gossip exchange
   */
  performGossipExchange() {
    const connectedPeers = Array.from(this.connections.keys());
    if (connectedPeers.length === 0) return;
    
    // Select random peer
    const peerId = connectedPeers[Math.floor(Math.random() * connectedPeers.length)];
    const socket = this.connections.get(peerId);
    
    if (!socket) return;
    
    // Send our peer list
    const peerList = Array.from(this.peers.values())
      .filter(p => p.isHealthy())
      .slice(0, 20)
      .map(p => ({
        id: p.id,
        address: p.address,
        port: p.port
      }));
    
    const message = {
      type: 'PEER_EXCHANGE',
      peers: peerList
    };
    
    socket.write(JSON.stringify(message) + '\n');
    this.stats.messagesSent++;
  }
  
  /**
   * Start health monitoring
   */
  startHealthMonitoring() {
    this.healthInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.config.healthCheckInterval);
  }
  
  /**
   * Perform health check on peers
   */
  performHealthCheck() {
    const now = Date.now();
    
    for (const [peerId, peer] of this.peers) {
      const socket = this.connections.get(peerId);
      
      if (socket) {
        // Send ping
        const ping = {
          type: 'PING',
          nonce: crypto.randomBytes(16).toString('hex'),
          timestamp: now
        };
        
        socket.write(JSON.stringify(ping) + '\n');
      } else if (peer.state === PEER_STATES.CONNECTED) {
        // Mark as disconnected if no socket
        peer.state = PEER_STATES.DISCONNECTED;
      }
      
      // Remove stale peers
      if (!peer.isHealthy() && !this.connections.has(peerId)) {
        this.peers.delete(peerId);
      }
    }
  }
  
  /**
   * Discover new peers
   */
  async discoverNewPeers() {
    // Try all available mechanisms
    const promises = [];
    
    if (this.config.mechanisms.includes(DISCOVERY_MECHANISMS.DHT)) {
      promises.push(this.performDHTDiscovery());
    }
    
    if (this.config.mechanisms.includes(DISCOVERY_MECHANISMS.BOOTSTRAP)) {
      promises.push(this.bootstrapNetwork());
    }
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Get connected peers
   */
  getConnectedPeers() {
    const connected = [];
    
    for (const [peerId, socket] of this.connections) {
      const peer = this.peers.get(peerId);
      if (peer) {
        connected.push({
          id: peerId,
          address: peer.address,
          port: peer.port,
          latency: peer.latency,
          score: peer.getScore()
        });
      }
    }
    
    return connected;
  }
  
  /**
   * Get discovery statistics
   */
  getStats() {
    const peersByState = {};
    
    for (const state of Object.values(PEER_STATES)) {
      peersByState[state] = 0;
    }
    
    for (const peer of this.peers.values()) {
      peersByState[peer.state]++;
    }
    
    return {
      nodeId: this.config.nodeId,
      peers: {
        total: this.peers.size,
        connected: this.connections.size,
        byState: peersByState
      },
      discovery: {
        mechanisms: this.config.mechanisms,
        ...this.stats
      },
      health: {
        healthyPeers: Array.from(this.peers.values()).filter(p => p.isHealthy()).length,
        averageLatency: this.calculateAverageLatency(),
        averageScore: this.calculateAverageScore()
      }
    };
  }
  
  /**
   * Calculate average latency
   */
  calculateAverageLatency() {
    const connected = Array.from(this.connections.keys());
    if (connected.length === 0) return 0;
    
    let total = 0;
    for (const peerId of connected) {
      const peer = this.peers.get(peerId);
      if (peer) {
        total += peer.latency;
      }
    }
    
    return total / connected.length;
  }
  
  /**
   * Calculate average peer score
   */
  calculateAverageScore() {
    const peers = Array.from(this.peers.values());
    if (peers.length === 0) return 0;
    
    const total = peers.reduce((sum, peer) => sum + peer.getScore(), 0);
    return total / peers.length;
  }
  
  /**
   * Shutdown discovery system
   */
  async shutdown() {
    // Clear intervals
    if (this.dhtInterval) clearInterval(this.dhtInterval);
    if (this.gossipInterval) clearInterval(this.gossipInterval);
    if (this.healthInterval) clearInterval(this.healthInterval);
    
    // Close all connections
    for (const [peerId, socket] of this.connections) {
      socket.destroy();
    }
    
    // Close servers
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
    }
    
    if (this.dht && this.dht.socket) {
      await new Promise(resolve => this.dht.socket.close(resolve));
    }
    
    this.peers.clear();
    this.connections.clear();
    
    this.logger.info('Advanced peer discovery shutdown');
  }
}

// Export constants
export {
  DISCOVERY_MECHANISMS,
  PEER_STATES
};

export default AdvancedPeerDiscovery;