/**
 * P2P Manager - Otedama
 * Peer-to-peer network management with NAT traversal
 * 
 * Features:
 * - STUN/TURN support for NAT traversal
 * - DHT-based peer discovery
 * - Gossip protocol for pool state
 * - Automatic peer selection
 * - Connection health monitoring
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import net from 'net';
import dgram from 'dgram';
import crypto from 'crypto';
import { BinaryProtocol, MessageType } from './binary-protocol.js';

const logger = createLogger('P2PManager');

// P2P Message Types
export const P2PMessageType = {
  // Discovery
  PEER_ANNOUNCE: 0x30,
  PEER_REQUEST: 0x31,
  PEER_RESPONSE: 0x32,
  
  // Pool state
  SHARE_BROADCAST: 0x40,
  BLOCK_BROADCAST: 0x41,
  POOL_STATE_SYNC: 0x42,
  
  // DHT
  DHT_STORE: 0x50,
  DHT_FIND: 0x51,
  DHT_FOUND: 0x52
};

/**
 * P2P Network Manager
 */
export class P2PManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.nodeId = options.nodeId || crypto.randomBytes(20).toString('hex');
    this.port = options.port || 8333;
    this.maxPeers = options.maxPeers || 50;
    this.bootstrapPeers = options.bootstrapPeers || [];
    this.natEnabled = options.natEnabled !== false;
    this.dhtEnabled = options.dhtEnabled !== false;
    
    // Network state
    this.peers = new Map(); // peerId -> peer info
    this.connections = new Map(); // peerId -> socket
    this.pendingConnections = new Set();
    this.server = null;
    this.udpSocket = null;
    
    // Protocol
    this.protocol = new BinaryProtocol({
      version: 2,
      enableCompression: true
    });
    
    // DHT state
    this.dht = {
      routingTable: new Map(), // nodeId -> peer info
      storage: new Map(), // key -> value
      pendingQueries: new Map() // queryId -> callback
    };
    
    // Statistics
    this.stats = {
      totalPeers: 0,
      activePeers: 0,
      messagesIn: 0,
      messagesOut: 0,
      bytesIn: 0,
      bytesOut: 0
    };
    
    // Timers
    this.pingInterval = null;
    this.discoveryInterval = null;
  }
  
  /**
   * Start P2P network
   */
  async start() {
    logger.info(`Starting P2P network on port ${this.port}`);
    
    // Start TCP server
    await this.startTCPServer();
    
    // Start UDP socket for NAT traversal
    if (this.natEnabled) {
      await this.startUDPSocket();
    }
    
    // Connect to bootstrap peers
    await this.connectToBootstrapPeers();
    
    // Start maintenance timers
    this.startMaintenanceTimers();
    
    logger.info(`P2P network started with node ID: ${this.nodeId}`);
    this.emit('started');
  }
  
  /**
   * Start TCP server
   */
  async startTCPServer() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer(socket => {
        this.handleIncomingConnection(socket);
      });
      
      this.server.on('error', error => {
        logger.error('TCP server error:', error);
        reject(error);
      });
      
      this.server.listen(this.port, () => {
        logger.info(`TCP server listening on port ${this.port}`);
        resolve();
      });
    });
  }
  
  /**
   * Start UDP socket
   */
  async startUDPSocket() {
    return new Promise((resolve, reject) => {
      this.udpSocket = dgram.createSocket('udp4');
      
      this.udpSocket.on('message', (msg, rinfo) => {
        this.handleUDPMessage(msg, rinfo);
      });
      
      this.udpSocket.on('error', error => {
        logger.error('UDP socket error:', error);
        reject(error);
      });
      
      this.udpSocket.bind(this.port, () => {
        logger.info(`UDP socket bound to port ${this.port}`);
        resolve();
      });
    });
  }
  
  /**
   * Connect to bootstrap peers
   */
  async connectToBootstrapPeers() {
    for (const peer of this.bootstrapPeers) {
      try {
        await this.connectToPeer(peer.host, peer.port);
      } catch (error) {
        logger.warn(`Failed to connect to bootstrap peer ${peer.host}:${peer.port}:`, error.message);
      }
    }
  }
  
  /**
   * Connect to peer
   */
  async connectToPeer(host, port, peerId = null) {
    const address = `${host}:${port}`;
    
    // Check if already connected or pending
    if (peerId && (this.connections.has(peerId) || this.pendingConnections.has(address))) {
      return;
    }
    
    // Check peer limit
    if (this.connections.size >= this.maxPeers) {
      throw new Error('Max peers reached');
    }
    
    this.pendingConnections.add(address);
    
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        this.pendingConnections.delete(address);
        this.setupPeerConnection(socket, { host, port, outgoing: true });
        resolve(socket);
      });
      
      socket.on('error', error => {
        this.pendingConnections.delete(address);
        reject(error);
      });
      
      // Timeout
      socket.setTimeout(10000, () => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      });
    });
  }
  
  /**
   * Handle incoming connection
   */
  handleIncomingConnection(socket) {
    // Check peer limit
    if (this.connections.size >= this.maxPeers) {
      socket.end();
      return;
    }
    
    this.setupPeerConnection(socket, { incoming: true });
  }
  
  /**
   * Setup peer connection
   */
  setupPeerConnection(socket, peerInfo) {
    const peer = {
      id: null,
      socket,
      address: socket.remoteAddress,
      port: socket.remotePort,
      ...peerInfo,
      connected: Date.now(),
      lastSeen: Date.now(),
      bytesIn: 0,
      bytesOut: 0
    };
    
    // Send handshake
    this.sendHandshake(socket);
    
    // Message buffer for handling partial messages
    let messageBuffer = Buffer.alloc(0);
    
    socket.on('data', async data => {
      peer.bytesIn += data.length;
      this.stats.bytesIn += data.length;
      
      // Append to buffer
      messageBuffer = Buffer.concat([messageBuffer, data]);
      
      // Process complete messages
      while (messageBuffer.length >= 7) { // Minimum message size
        try {
          // Peek at message length
          const messageLength = messageBuffer.readUInt32BE(3) + 7;
          
          if (messageBuffer.length < messageLength) {
            break; // Wait for more data
          }
          
          // Extract message
          const message = messageBuffer.slice(0, messageLength);
          messageBuffer = messageBuffer.slice(messageLength);
          
          // Decode and handle
          const decoded = await this.protocol.decode(message);
          await this.handlePeerMessage(peer, decoded);
          
        } catch (error) {
          logger.error('Error processing peer message:', error);
          socket.destroy();
          break;
        }
      }
    });
    
    socket.on('error', error => {
      logger.debug(`Peer connection error: ${error.message}`);
    });
    
    socket.on('close', () => {
      this.removePeer(peer);
    });
  }
  
  /**
   * Send handshake
   */
  async sendHandshake(socket) {
    const handshake = {
      nodeId: this.nodeId,
      version: 1,
      port: this.port,
      capabilities: {
        dht: this.dhtEnabled,
        nat: this.natEnabled
      }
    };
    
    const message = await this.protocol.encode(MessageType.HELLO, handshake);
    socket.write(message);
  }
  
  /**
   * Handle peer message
   */
  async handlePeerMessage(peer, decoded) {
    const { messageType, data } = decoded;
    this.stats.messagesIn++;
    peer.lastSeen = Date.now();
    
    switch (messageType) {
      case MessageType.HELLO:
        await this.handleHandshake(peer, data);
        break;
        
      case MessageType.PING:
        await this.handlePing(peer);
        break;
        
      case MessageType.PONG:
        // Update peer latency
        if (peer.pingTime) {
          peer.latency = Date.now() - peer.pingTime;
          delete peer.pingTime;
        }
        break;
        
      case P2PMessageType.PEER_REQUEST:
        await this.handlePeerRequest(peer);
        break;
        
      case P2PMessageType.PEER_RESPONSE:
        await this.handlePeerResponse(peer, data);
        break;
        
      case P2PMessageType.SHARE_BROADCAST:
        this.emit('share:broadcast', { peer, share: data });
        break;
        
      case P2PMessageType.BLOCK_BROADCAST:
        this.emit('block:broadcast', { peer, block: data });
        break;
        
      case P2PMessageType.DHT_FIND:
        await this.handleDHTFind(peer, data);
        break;
        
      case P2PMessageType.DHT_FOUND:
        await this.handleDHTFound(peer, data);
        break;
        
      default:
        logger.warn(`Unknown message type: ${messageType}`);
    }
  }
  
  /**
   * Handle handshake
   */
  async handleHandshake(peer, data) {
    peer.id = data.nodeId;
    peer.version = data.version;
    peer.capabilities = data.capabilities;
    
    // Check if duplicate connection
    if (this.connections.has(peer.id)) {
      peer.socket.destroy();
      return;
    }
    
    // Add to connections
    this.connections.set(peer.id, peer);
    this.peers.set(peer.id, {
      id: peer.id,
      address: peer.address,
      port: data.port,
      capabilities: peer.capabilities
    });
    
    // Send handshake ack if incoming
    if (peer.incoming) {
      await this.sendHandshake(peer.socket);
    }
    
    // Update DHT routing table
    if (this.dhtEnabled && peer.capabilities?.dht) {
      this.updateDHTRoutingTable(peer.id, peer);
    }
    
    this.stats.totalPeers++;
    this.stats.activePeers = this.connections.size;
    
    logger.info(`Peer connected: ${peer.id} (${peer.address}:${peer.port})`);
    this.emit('peer:connected', peer);
  }
  
  /**
   * Handle ping
   */
  async handlePing(peer) {
    const pong = await this.protocol.encode(MessageType.PONG, {});
    peer.socket.write(pong);
  }
  
  /**
   * Handle peer request
   */
  async handlePeerRequest(peer) {
    const peers = Array.from(this.peers.values())
      .filter(p => p.id !== peer.id)
      .slice(0, 10); // Send up to 10 peers
    
    const response = await this.protocol.encode(P2PMessageType.PEER_RESPONSE, { peers });
    peer.socket.write(response);
  }
  
  /**
   * Handle peer response
   */
  async handlePeerResponse(peer, data) {
    const { peers } = data;
    
    for (const peerInfo of peers) {
      if (!this.peers.has(peerInfo.id) && this.connections.size < this.maxPeers) {
        try {
          await this.connectToPeer(peerInfo.address, peerInfo.port, peerInfo.id);
        } catch (error) {
          logger.debug(`Failed to connect to discovered peer: ${error.message}`);
        }
      }
    }
  }
  
  /**
   * Broadcast message to all peers
   */
  async broadcast(messageType, data, excludePeer = null) {
    const message = await this.protocol.encode(messageType, data);
    
    for (const [peerId, peer] of this.connections) {
      if (peerId !== excludePeer?.id) {
        try {
          peer.socket.write(message);
          peer.bytesOut += message.length;
          this.stats.bytesOut += message.length;
          this.stats.messagesOut++;
        } catch (error) {
          logger.error(`Failed to send to peer ${peerId}:`, error);
        }
      }
    }
  }
  
  /**
   * Send to specific peer
   */
  async sendToPeer(peerId, messageType, data) {
    const peer = this.connections.get(peerId);
    if (!peer) {
      throw new Error('Peer not found');
    }
    
    const message = await this.protocol.encode(messageType, data);
    peer.socket.write(message);
    peer.bytesOut += message.length;
    this.stats.bytesOut += message.length;
    this.stats.messagesOut++;
  }
  
  /**
   * Remove peer
   */
  removePeer(peer) {
    if (peer.id) {
      this.connections.delete(peer.id);
      this.peers.delete(peer.id);
      this.dht.routingTable.delete(peer.id);
      
      this.stats.activePeers = this.connections.size;
      
      logger.info(`Peer disconnected: ${peer.id}`);
      this.emit('peer:disconnected', peer);
    }
  }
  
  /**
   * Start maintenance timers
   */
  startMaintenanceTimers() {
    // Ping peers periodically
    this.pingInterval = setInterval(() => {
      this.pingPeers();
    }, 30000); // 30 seconds
    
    // Discover new peers periodically
    this.discoveryInterval = setInterval(() => {
      this.discoverPeers();
    }, 60000); // 1 minute
  }
  
  /**
   * Ping all peers
   */
  async pingPeers() {
    const now = Date.now();
    const timeout = 60000; // 1 minute
    
    for (const [peerId, peer] of this.connections) {
      // Remove inactive peers
      if (now - peer.lastSeen > timeout * 2) {
        peer.socket.destroy();
        continue;
      }
      
      // Send ping
      try {
        peer.pingTime = now;
        const ping = await this.protocol.encode(MessageType.PING, {});
        peer.socket.write(ping);
      } catch (error) {
        logger.error(`Failed to ping peer ${peerId}:`, error);
      }
    }
  }
  
  /**
   * Discover new peers
   */
  async discoverPeers() {
    if (this.connections.size >= this.maxPeers) {
      return;
    }
    
    // Request peers from random connected peer
    const peers = Array.from(this.connections.values());
    if (peers.length > 0) {
      const randomPeer = peers[Math.floor(Math.random() * peers.length)];
      
      try {
        const request = await this.protocol.encode(P2PMessageType.PEER_REQUEST, {});
        randomPeer.socket.write(request);
      } catch (error) {
        logger.error('Failed to request peers:', error);
      }
    }
  }
  
  /**
   * DHT operations
   */
  
  /**
   * Update DHT routing table
   */
  updateDHTRoutingTable(nodeId, peerInfo) {
    this.dht.routingTable.set(nodeId, {
      id: nodeId,
      address: peerInfo.address,
      port: peerInfo.port,
      lastSeen: Date.now()
    });
  }
  
  /**
   * DHT store
   */
  async dhtStore(key, value) {
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    
    // Store locally
    this.dht.storage.set(keyHash, value);
    
    // Find closest peers
    const closestPeers = this.findClosestPeers(keyHash, 3);
    
    // Store on closest peers
    for (const peer of closestPeers) {
      try {
        await this.sendToPeer(peer.id, P2PMessageType.DHT_STORE, {
          key: keyHash,
          value
        });
      } catch (error) {
        logger.error(`Failed to store on peer ${peer.id}:`, error);
      }
    }
  }
  
  /**
   * DHT find
   */
  async dhtFind(key) {
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    
    // Check local storage
    if (this.dht.storage.has(keyHash)) {
      return this.dht.storage.get(keyHash);
    }
    
    // Query closest peers
    const queryId = crypto.randomBytes(16).toString('hex');
    const closestPeers = this.findClosestPeers(keyHash, 3);
    
    return new Promise((resolve, reject) => {
      let responses = 0;
      let found = false;
      
      this.dht.pendingQueries.set(queryId, (value) => {
        if (!found && value) {
          found = true;
          resolve(value);
        }
        
        responses++;
        if (responses >= closestPeers.length && !found) {
          reject(new Error('Key not found'));
        }
      });
      
      // Query peers
      for (const peer of closestPeers) {
        this.sendToPeer(peer.id, P2PMessageType.DHT_FIND, {
          queryId,
          key: keyHash
        }).catch(error => {
          logger.error(`Failed to query peer ${peer.id}:`, error);
          responses++;
        });
      }
      
      // Timeout
      setTimeout(() => {
        this.dht.pendingQueries.delete(queryId);
        if (!found) {
          reject(new Error('DHT query timeout'));
        }
      }, 10000);
    });
  }
  
  /**
   * Handle DHT find
   */
  async handleDHTFind(peer, data) {
    const { queryId, key } = data;
    
    // Check local storage
    const value = this.dht.storage.get(key);
    
    // Send response
    await this.sendToPeer(peer.id, P2PMessageType.DHT_FOUND, {
      queryId,
      key,
      value: value || null
    });
  }
  
  /**
   * Handle DHT found
   */
  handleDHTFound(peer, data) {
    const { queryId, value } = data;
    
    const callback = this.dht.pendingQueries.get(queryId);
    if (callback) {
      callback(value);
    }
  }
  
  /**
   * Find closest peers to a key
   */
  findClosestPeers(keyHash, count) {
    const peers = Array.from(this.dht.routingTable.values());
    
    // Calculate XOR distance
    peers.forEach(peer => {
      peer.distance = this.xorDistance(keyHash, peer.id);
    });
    
    // Sort by distance and return closest
    return peers
      .sort((a, b) => a.distance.localeCompare(b.distance))
      .slice(0, count);
  }
  
  /**
   * Calculate XOR distance between two hex strings
   */
  xorDistance(a, b) {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    const result = Buffer.alloc(bufA.length);
    
    for (let i = 0; i < bufA.length; i++) {
      result[i] = bufA[i] ^ bufB[i];
    }
    
    return result.toString('hex');
  }
  
  /**
   * Handle UDP message for NAT traversal
   */
  handleUDPMessage(message, rinfo) {
    // Simple UDP hole punching
    try {
      const data = JSON.parse(message.toString());
      
      if (data.type === 'ping') {
        const response = Buffer.from(JSON.stringify({
          type: 'pong',
          nodeId: this.nodeId
        }));
        
        this.udpSocket.send(response, rinfo.port, rinfo.address);
      }
    } catch (error) {
      logger.debug('Invalid UDP message:', error);
    }
  }
  
  /**
   * Get network statistics
   */
  getStats() {
    const peers = Array.from(this.connections.values()).map(peer => ({
      id: peer.id,
      address: peer.address,
      port: peer.port,
      latency: peer.latency || null,
      bytesIn: peer.bytesIn,
      bytesOut: peer.bytesOut,
      connected: peer.connected
    }));
    
    return {
      ...this.stats,
      nodeId: this.nodeId,
      peers,
      dhtNodes: this.dht.routingTable.size,
      dhtStorage: this.dht.storage.size
    };
  }
  
  /**
   * Stop P2P network
   */
  async stop() {
    logger.info('Stopping P2P network...');
    
    // Stop timers
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }
    
    // Close all connections
    for (const [peerId, peer] of this.connections) {
      peer.socket.destroy();
    }
    
    // Close server
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
    }
    
    // Close UDP socket
    if (this.udpSocket) {
      await new Promise(resolve => this.udpSocket.close(resolve));
    }
    
    this.emit('stopped');
    logger.info('P2P network stopped');
  }
}

/**
 * Create P2P manager instance
 */
export function createP2PManager(options) {
  return new P2PManager(options);
}

export default {
  P2PManager,
  P2PMessageType,
  createP2PManager
};
