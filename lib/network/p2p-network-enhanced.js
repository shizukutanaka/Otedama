/**
 * Enhanced P2P Network Layer for Otedama
 * National-scale distributed network with resilience
 * 
 * Design:
 * - Carmack: Efficient routing and minimal latency
 * - Martin: Clean separation of concerns
 * - Pike: Simple but powerful protocols
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';
import { NetworkError } from '../core/error-handler-unified.js';
import { BinaryProtocol, MessageType, MessageBuilder, MessageFramer } from './binary-protocol-v2.js';

// Constants for national-scale operation
const KADEMLIA_K = 20; // Bucket size
const KADEMLIA_ALPHA = 3; // Concurrent lookups
const KADEMLIA_BITS = 256; // ID space
const MAX_PEERS = 10000; // Support large networks
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const PEER_TIMEOUT = 120000; // 2 minutes
const GOSSIP_FANOUT = 6; // Gossip to 6 random peers
const GOSSIP_ROUNDS = 3; // Maximum gossip rounds

/**
 * Kademlia DHT implementation for peer discovery
 */
class KademliaDHT {
  constructor(nodeId) {
    this.nodeId = nodeId;
    this.buckets = new Array(KADEMLIA_BITS).fill(null).map(() => []);
    this.logger = createStructuredLogger('KademliaDHT');
  }
  
  /**
   * XOR distance between two node IDs
   */
  distance(id1, id2) {
    const dist = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      dist[i] = id1[i] ^ id2[i];
    }
    return dist;
  }
  
  /**
   * Find bucket index for a node ID
   */
  getBucketIndex(nodeId) {
    const dist = this.distance(this.nodeId, nodeId);
    
    // Find first non-zero bit
    for (let i = 0; i < KADEMLIA_BITS; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = 7 - (i % 8);
      
      if ((dist[byteIndex] >> bitIndex) & 1) {
        return KADEMLIA_BITS - 1 - i;
      }
    }
    
    return 0; // Same ID
  }
  
  /**
   * Add peer to routing table
   */
  addPeer(peer) {
    const bucketIndex = this.getBucketIndex(peer.id);
    const bucket = this.buckets[bucketIndex];
    
    // Check if peer already exists
    const existingIndex = bucket.findIndex(p => p.id.equals(peer.id));
    
    if (existingIndex !== -1) {
      // Move to end (most recently seen)
      bucket.splice(existingIndex, 1);
      bucket.push(peer);
    } else if (bucket.length < KADEMLIA_K) {
      // Add to bucket
      bucket.push(peer);
    } else {
      // Bucket full, replace least recently seen if offline
      const oldestPeer = bucket[0];
      if (Date.now() - oldestPeer.lastSeen > PEER_TIMEOUT) {
        bucket.shift();
        bucket.push(peer);
      }
    }
  }
  
  /**
   * Find K closest peers to target ID
   */
  findClosestPeers(targetId, k = KADEMLIA_K) {
    const peers = [];
    
    // Collect all peers
    for (const bucket of this.buckets) {
      peers.push(...bucket);
    }
    
    // Sort by distance to target
    peers.sort((a, b) => {
      const distA = this.distance(a.id, targetId);
      const distB = this.distance(b.id, targetId);
      return Buffer.compare(distA, distB);
    });
    
    return peers.slice(0, k);
  }
  
  /**
   * Remove offline peers
   */
  cleanup() {
    const now = Date.now();
    let removed = 0;
    
    for (const bucket of this.buckets) {
      const initialLength = bucket.length;
      bucket.splice(0, bucket.length, 
        ...bucket.filter(peer => now - peer.lastSeen < PEER_TIMEOUT)
      );
      removed += initialLength - bucket.length;
    }
    
    if (removed > 0) {
      this.logger.debug(`Removed ${removed} offline peers`);
    }
  }
  
  /**
   * Get routing table statistics
   */
  getStats() {
    let totalPeers = 0;
    let activeBuckets = 0;
    
    for (const bucket of this.buckets) {
      if (bucket.length > 0) {
        activeBuckets++;
        totalPeers += bucket.length;
      }
    }
    
    return {
      totalPeers,
      activeBuckets,
      averageBucketSize: activeBuckets > 0 ? totalPeers / activeBuckets : 0
    };
  }
}

/**
 * Gossip protocol for message propagation
 */
class GossipProtocol extends EventEmitter {
  constructor(nodeId) {
    super();
    
    this.nodeId = nodeId;
    this.seen = new Map(); // Message ID -> timestamp
    this.peers = new Map(); // Peer ID -> peer info
    this.logger = createStructuredLogger('GossipProtocol');
    
    // Cleanup old messages periodically
    setInterval(() => this.cleanup(), 60000);
  }
  
  /**
   * Handle incoming gossip message
   */
  handleMessage(message, fromPeer) {
    const messageId = this.getMessageId(message);
    
    // Check if we've seen this message
    if (this.seen.has(messageId)) {
      return false;
    }
    
    // Mark as seen
    this.seen.set(messageId, Date.now());
    
    // Emit for local processing
    this.emit('message', message, fromPeer);
    
    // Propagate if rounds remaining
    if (message.rounds > 0) {
      this.propagate({
        ...message,
        rounds: message.rounds - 1
      }, fromPeer);
    }
    
    return true;
  }
  
  /**
   * Broadcast new message
   */
  broadcast(type, data) {
    const message = {
      id: crypto.randomBytes(16),
      type,
      data,
      origin: this.nodeId,
      rounds: GOSSIP_ROUNDS,
      timestamp: Date.now()
    };
    
    const messageId = this.getMessageId(message);
    this.seen.set(messageId, Date.now());
    
    this.propagate(message);
    
    return messageId;
  }
  
  /**
   * Propagate message to random peers
   */
  propagate(message, excludePeer = null) {
    const eligiblePeers = Array.from(this.peers.values())
      .filter(peer => !excludePeer || !peer.id.equals(excludePeer));
    
    if (eligiblePeers.length === 0) return;
    
    // Select random peers
    const selectedPeers = this.selectRandomPeers(eligiblePeers, GOSSIP_FANOUT);
    
    // Send to selected peers
    for (const peer of selectedPeers) {
      this.emit('send', peer, message);
    }
  }
  
  /**
   * Select random peers using reservoir sampling
   */
  selectRandomPeers(peers, count) {
    if (peers.length <= count) return peers;
    
    const selected = peers.slice(0, count);
    
    for (let i = count; i < peers.length; i++) {
      const j = Math.floor(Math.random() * (i + 1));
      if (j < count) {
        selected[j] = peers[i];
      }
    }
    
    return selected;
  }
  
  /**
   * Generate message ID
   */
  getMessageId(message) {
    return crypto
      .createHash('sha256')
      .update(message.id)
      .update(message.origin)
      .update(String(message.timestamp))
      .digest();
  }
  
  /**
   * Add peer
   */
  addPeer(peer) {
    this.peers.set(peer.id.toString('hex'), peer);
  }
  
  /**
   * Remove peer
   */
  removePeer(peerId) {
    this.peers.delete(peerId.toString('hex'));
  }
  
  /**
   * Cleanup old messages
   */
  cleanup() {
    const cutoff = Date.now() - 300000; // 5 minutes
    let removed = 0;
    
    for (const [messageId, timestamp] of this.seen) {
      if (timestamp < cutoff) {
        this.seen.delete(messageId);
        removed++;
      }
    }
    
    if (removed > 0) {
      this.logger.debug(`Cleaned up ${removed} old messages`);
    }
  }
}

/**
 * Enhanced P2P Network with national-scale capabilities
 */
export class P2PNetwork extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.nodeId = options.nodeId || crypto.randomBytes(32);
    this.port = options.port || 0;
    this.maxPeers = options.maxPeers || MAX_PEERS;
    
    // Core components
    this.dht = new KademliaDHT(this.nodeId);
    this.gossip = new GossipProtocol(this.nodeId);
    this.protocol = new BinaryProtocol();
    this.messageBuilder = new MessageBuilder(this.protocol);
    
    // Peer management
    this.peers = new Map();
    this.connections = new Map();
    
    // Statistics
    this.stats = {
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      bytesSent: 0,
      peersDiscovered: 0,
      connectionsEstablished: 0,
      connectionsFailed: 0
    };
    
    // Logger
    this.logger = createStructuredLogger('P2PNetwork');
    
    // Setup gossip handlers
    this.setupGossipHandlers();
    
    // Start maintenance tasks
    this.startMaintenance();
  }
  
  /**
   * Setup gossip protocol handlers
   */
  setupGossipHandlers() {
    // Handle gossip messages
    this.gossip.on('message', (message, fromPeer) => {
      this.handleGossipMessage(message, fromPeer);
    });
    
    // Send gossip messages
    this.gossip.on('send', (peer, message) => {
      this.sendToPeer(peer, MessageType.PEER_ANNOUNCE, message);
    });
  }
  
  /**
   * Start maintenance tasks
   */
  startMaintenance() {
    // Heartbeat
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeats();
    }, HEARTBEAT_INTERVAL);
    
    // DHT cleanup
    this.cleanupInterval = setInterval(() => {
      this.dht.cleanup();
      this.checkPeerHealth();
    }, 60000);
    
    // Statistics reporting
    this.statsInterval = setInterval(() => {
      this.logger.info('P2P Network statistics', this.getStats());
    }, 300000); // 5 minutes
  }
  
  /**
   * Connect to a peer
   */
  async connectToPeer(address, port) {
    const peerId = `${address}:${port}`;
    
    if (this.connections.has(peerId)) {
      return this.connections.get(peerId);
    }
    
    try {
      // Create connection (implementation depends on transport)
      const connection = await this.createConnection(address, port);
      
      // Setup message framing
      const framer = new MessageFramer(this.protocol);
      
      framer.on('message', (message) => {
        this.handleMessage(message, connection);
      });
      
      framer.on('error', (error) => {
        this.logger.error('Framing error', { peerId, error });
        this.disconnectPeer(peerId);
      });
      
      // Store connection
      connection.framer = framer;
      this.connections.set(peerId, connection);
      
      // Send handshake
      await this.sendHandshake(connection);
      
      this.stats.connectionsEstablished++;
      
      return connection;
      
    } catch (error) {
      this.stats.connectionsFailed++;
      throw new NetworkError(`Failed to connect to ${peerId}: ${error.message}`);
    }
  }
  
  /**
   * Handle incoming message
   */
  handleMessage(message, connection) {
    this.stats.messagesReceived++;
    
    switch (message.type) {
      case MessageType.HANDSHAKE:
        this.handleHandshake(message.data, connection);
        break;
        
      case MessageType.HANDSHAKE_ACK:
        this.handleHandshakeAck(message.data, connection);
        break;
        
      case MessageType.PING:
        this.handlePing(message.data, connection);
        break;
        
      case MessageType.PONG:
        this.handlePong(message.data, connection);
        break;
        
      case MessageType.PEER_ANNOUNCE:
        this.handlePeerAnnounce(message.data, connection);
        break;
        
      case MessageType.PEER_REQUEST:
        this.handlePeerRequest(message.data, connection);
        break;
        
      case MessageType.PEER_RESPONSE:
        this.handlePeerResponse(message.data, connection);
        break;
        
      default:
        this.emit('message', message, connection);
    }
  }
  
  /**
   * Handle handshake
   */
  handleHandshake(data, connection) {
    const peer = {
      id: Buffer.from(data.peerId, 'hex'),
      connection,
      capabilities: data.capabilities,
      lastSeen: Date.now()
    };
    
    // Add to DHT
    this.dht.addPeer(peer);
    
    // Add to gossip network
    this.gossip.addPeer(peer);
    
    // Store peer
    this.peers.set(data.peerId, peer);
    
    // Send acknowledgment
    const ack = this.messageBuilder.handshakeAck(this.nodeId, true);
    this.sendMessage(connection, ack);
    
    this.stats.peersDiscovered++;
    
    this.emit('peer:connected', peer);
  }
  
  /**
   * Handle peer announcement (gossip)
   */
  handlePeerAnnounce(data, connection) {
    const handled = this.gossip.handleMessage(data, connection.peer);
    
    if (handled) {
      // Process based on gossip type
      switch (data.type) {
        case 'block_found':
          this.emit('block:found', data.data);
          break;
          
        case 'transaction':
          this.emit('transaction', data.data);
          break;
          
        case 'peer_update':
          this.processPeerUpdate(data.data);
          break;
      }
    }
  }
  
  /**
   * Broadcast message to network
   */
  broadcast(type, data) {
    return this.gossip.broadcast(type, data);
  }
  
  /**
   * Find peers close to a target ID
   */
  async findPeers(targetId) {
    const closest = this.dht.findClosestPeers(targetId);
    
    // Query closest peers for more peers
    const queries = closest.slice(0, KADEMLIA_ALPHA).map(peer => 
      this.queryPeer(peer, targetId)
    );
    
    const results = await Promise.allSettled(queries);
    
    const allPeers = new Set(closest);
    
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        result.value.forEach(peer => allPeers.add(peer));
      }
    }
    
    return Array.from(allPeers);
  }
  
  /**
   * Get network statistics
   */
  getStats() {
    const dhtStats = this.dht.getStats();
    
    return {
      nodeId: this.nodeId.toString('hex'),
      peers: this.peers.size,
      connections: this.connections.size,
      dht: dhtStats,
      gossip: {
        peers: this.gossip.peers.size,
        messagesKnown: this.gossip.seen.size
      },
      traffic: this.stats
    };
  }
  
  /**
   * Graceful shutdown
   */
  async shutdown() {
    // Stop maintenance
    clearInterval(this.heartbeatInterval);
    clearInterval(this.cleanupInterval);
    clearInterval(this.statsInterval);
    
    // Disconnect all peers
    for (const [peerId, connection] of this.connections) {
      await this.disconnectPeer(peerId);
    }
    
    this.logger.info('P2P network shut down');
  }
  
  // Private helper methods...
  
  async createConnection(address, port) {
    // Implementation depends on transport (TCP, WebSocket, etc.)
    throw new Error('createConnection must be implemented by subclass');
  }
  
  sendMessage(connection, message) {
    this.stats.messagesSent++;
    this.stats.bytesSent += message.header.length + message.payload.length;
    
    // Send through connection
    connection.write(message.header);
    connection.write(message.payload);
    message.release();
  }
  
  sendToPeer(peer, type, data) {
    if (peer.connection && peer.connection.readyState === 'open') {
      const message = this.protocol.encode(type, data);
      this.sendMessage(peer.connection, message);
    }
  }
  
  async sendHeartbeats() {
    const now = Date.now();
    const promises = [];
    
    for (const [peerId, peer] of this.peers) {
      if (now - peer.lastSeen > HEARTBEAT_INTERVAL) {
        const ping = this.messageBuilder.ping();
        promises.push(
          this.sendMessage(peer.connection, ping)
            .catch(() => this.disconnectPeer(peerId))
        );
      }
    }
    
    await Promise.allSettled(promises);
  }
  
  checkPeerHealth() {
    const now = Date.now();
    const deadPeers = [];
    
    for (const [peerId, peer] of this.peers) {
      if (now - peer.lastSeen > PEER_TIMEOUT) {
        deadPeers.push(peerId);
      }
    }
    
    for (const peerId of deadPeers) {
      this.disconnectPeer(peerId);
    }
  }
  
  async disconnectPeer(peerId) {
    const peer = this.peers.get(peerId);
    const connection = this.connections.get(peerId);
    
    if (peer) {
      this.peers.delete(peerId);
      this.gossip.removePeer(peer.id);
    }
    
    if (connection) {
      this.connections.delete(peerId);
      try {
        await connection.close();
      } catch (error) {
        // Ignore close errors
      }
    }
    
    this.emit('peer:disconnected', peerId);
  }
}

// Export components
export {
  KademliaDHT,
  GossipProtocol
};

export default P2PNetwork;
