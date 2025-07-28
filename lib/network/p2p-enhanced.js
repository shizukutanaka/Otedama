/**
 * Enhanced P2P Network Layer
 * National-scale P2P implementation with advanced protocols
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import { WebSocket } from 'ws';
import dgram from 'dgram';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('P2PNetwork');

// Protocol versions
const PROTOCOL_VERSION = '2.0';
const SUPPORTED_VERSIONS = ['1.0', '1.1', '2.0'];

// Message types
export const MessageType = {
  // Discovery
  PING: 'ping',
  PONG: 'pong',
  PEER_DISCOVERY: 'peer_discovery',
  PEER_ANNOUNCE: 'peer_announce',
  
  // Data synchronization
  SYNC_REQUEST: 'sync_request',
  SYNC_RESPONSE: 'sync_response',
  BLOCK_ANNOUNCE: 'block_announce',
  SHARE_BROADCAST: 'share_broadcast',
  
  // Consensus
  CONSENSUS_PROPOSAL: 'consensus_proposal',
  CONSENSUS_VOTE: 'consensus_vote',
  CONSENSUS_COMMIT: 'consensus_commit',
  
  // Network management
  PEER_STATUS: 'peer_status',
  NETWORK_STATS: 'network_stats',
  PROTOCOL_UPGRADE: 'protocol_upgrade'
};

export class EnhancedP2PNetwork extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Network identity
      nodeId: options.nodeId || this.generateNodeId(),
      listenPort: options.listenPort || 33333,
      
      // Peer management
      maxPeers: options.maxPeers || 100,
      minPeers: options.minPeers || 10,
      peerTimeout: options.peerTimeout || 300000, // 5 minutes
      
      // Discovery
      enableDHT: options.enableDHT !== false,
      enableMDNS: options.enableMDNS !== false,
      bootstrapPeers: options.bootstrapPeers || [],
      
      // Protocol settings
      protocolVersion: PROTOCOL_VERSION,
      messageTimeout: options.messageTimeout || 30000,
      
      // Security
      enableEncryption: options.enableEncryption !== false,
      requireAuth: options.requireAuth || false,
      
      // Performance
      maxMessageSize: options.maxMessageSize || 1048576, // 1MB
      compressionThreshold: options.compressionThreshold || 1024,
      
      // Consensus
      consensusEnabled: options.consensusEnabled || false,
      consensusQuorum: options.consensusQuorum || 0.67
    };
    
    // Peer management
    this.peers = new Map();
    this.peerScores = new Map();
    this.bannedPeers = new Set();
    
    // Network state
    this.isListening = false;
    this.networkId = options.networkId || 'otedama-mainnet';
    
    // Message handling
    this.messageHandlers = new Map();
    this.pendingRequests = new Map();
    
    // Statistics
    this.stats = {
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      bytesSent: 0,
      peersConnected: 0,
      peersDisconnected: 0
    };
    
    // DHT for peer discovery
    this.dht = null;
    
    // Initialize message handlers
    this.setupMessageHandlers();
  }

  generateNodeId() {
    return randomBytes(32).toString('hex');
  }

  async start() {
    if (this.isListening) {
      return;
    }
    
    logger.info('Starting P2P network', {
      nodeId: this.config.nodeId,
      port: this.config.listenPort,
      networkId: this.networkId
    });
    
    // Start TCP server for peer connections
    await this.startTCPServer();
    
    // Start UDP server for discovery
    if (this.config.enableDHT) {
      await this.startUDPServer();
    }
    
    // Initialize DHT
    if (this.config.enableDHT) {
      await this.initializeDHT();
    }
    
    // Connect to bootstrap peers
    await this.connectToBootstrapPeers();
    
    // Start maintenance tasks
    this.startMaintenanceTasks();
    
    this.isListening = true;
    this.emit('listening', {
      nodeId: this.config.nodeId,
      port: this.config.listenPort
    });
  }

  async startTCPServer() {
    // WebSocket server for peer connections
    this.wsServer = new WebSocket.Server({
      port: this.config.listenPort,
      perMessageDeflate: true,
      maxPayload: this.config.maxMessageSize
    });
    
    this.wsServer.on('connection', (ws, req) => {
      this.handleNewConnection(ws, req);
    });
    
    this.wsServer.on('error', (error) => {
      logger.error('WebSocket server error', { error: error.message });
      this.emit('error', error);
    });
  }

  async startUDPServer() {
    this.udpSocket = dgram.createSocket('udp4');
    
    this.udpSocket.on('message', (msg, rinfo) => {
      this.handleUDPMessage(msg, rinfo);
    });
    
    this.udpSocket.on('error', (error) => {
      logger.error('UDP socket error', { error: error.message });
    });
    
    await new Promise((resolve) => {
      this.udpSocket.bind(this.config.listenPort + 1, resolve);
    });
  }

  handleNewConnection(ws, req) {
    const peerId = this.generatePeerId();
    const remoteAddress = req.socket.remoteAddress;
    
    logger.info('New peer connection', { peerId, remoteAddress });
    
    const peer = {
      id: peerId,
      ws,
      address: remoteAddress,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      version: null,
      capabilities: new Set(),
      state: 'connecting',
      stats: {
        messagesReceived: 0,
        messagesSent: 0,
        bytesReceived: 0,
        bytesSent: 0
      }
    };
    
    this.peers.set(peerId, peer);
    this.stats.peersConnected++;
    
    // Setup message handlers
    ws.on('message', (data) => {
      this.handlePeerMessage(peerId, data);
    });
    
    ws.on('close', () => {
      this.handlePeerDisconnect(peerId);
    });
    
    ws.on('error', (error) => {
      logger.error('Peer connection error', { peerId, error: error.message });
      this.handlePeerDisconnect(peerId);
    });
    
    // Send handshake
    this.sendHandshake(peerId);
  }

  async handlePeerMessage(peerId, data) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    peer.lastSeen = Date.now();
    peer.stats.messagesReceived++;
    peer.stats.bytesReceived += data.length;
    
    this.stats.messagesReceived++;
    this.stats.bytesReceived += data.length;
    
    try {
      const message = this.decodeMessage(data);
      
      // Validate message
      if (!this.validateMessage(message)) {
        this.handleInvalidMessage(peerId, message);
        return;
      }
      
      // Update peer state
      if (message.type === MessageType.PONG && peer.state === 'connecting') {
        peer.state = 'connected';
        peer.version = message.data.version;
        peer.capabilities = new Set(message.data.capabilities);
        this.emit('peer:connected', { peerId, peer });
      }
      
      // Handle message
      const handler = this.messageHandlers.get(message.type);
      if (handler) {
        await handler(peerId, message);
      } else {
        logger.warn('Unknown message type', { type: message.type, peerId });
      }
      
    } catch (error) {
      logger.error('Error handling peer message', {
        peerId,
        error: error.message
      });
      this.updatePeerScore(peerId, -1);
    }
  }

  setupMessageHandlers() {
    // Ping/Pong
    this.messageHandlers.set(MessageType.PING, async (peerId, message) => {
      await this.sendMessage(peerId, {
        type: MessageType.PONG,
        data: {
          timestamp: Date.now(),
          version: this.config.protocolVersion,
          capabilities: ['mining', 'consensus', 'sync']
        }
      });
    });
    
    // Peer discovery
    this.messageHandlers.set(MessageType.PEER_DISCOVERY, async (peerId, message) => {
      const knownPeers = this.getKnownPeers(message.data.limit || 20);
      await this.sendMessage(peerId, {
        type: MessageType.PEER_ANNOUNCE,
        data: { peers: knownPeers }
      });
    });
    
    // Share broadcast
    this.messageHandlers.set(MessageType.SHARE_BROADCAST, async (peerId, message) => {
      const share = message.data;
      this.emit('share:received', { peerId, share });
      
      // Relay to other peers
      await this.broadcastMessage({
        type: MessageType.SHARE_BROADCAST,
        data: share
      }, [peerId]);
    });
    
    // Block announce
    this.messageHandlers.set(MessageType.BLOCK_ANNOUNCE, async (peerId, message) => {
      const block = message.data;
      this.emit('block:received', { peerId, block });
    });
    
    // Consensus messages
    if (this.config.consensusEnabled) {
      this.messageHandlers.set(MessageType.CONSENSUS_PROPOSAL, async (peerId, message) => {
        this.emit('consensus:proposal', { peerId, proposal: message.data });
      });
      
      this.messageHandlers.set(MessageType.CONSENSUS_VOTE, async (peerId, message) => {
        this.emit('consensus:vote', { peerId, vote: message.data });
      });
    }
  }

  async sendMessage(peerId, message) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.state !== 'connected') {
      return false;
    }
    
    try {
      const encoded = this.encodeMessage(message);
      peer.ws.send(encoded);
      
      peer.stats.messagesSent++;
      peer.stats.bytesSent += encoded.length;
      
      this.stats.messagesSent++;
      this.stats.bytesSent += encoded.length;
      
      return true;
    } catch (error) {
      logger.error('Error sending message', {
        peerId,
        messageType: message.type,
        error: error.message
      });
      return false;
    }
  }

  async broadcastMessage(message, excludePeers = []) {
    const excludeSet = new Set(excludePeers);
    const promises = [];
    
    for (const [peerId, peer] of this.peers) {
      if (!excludeSet.has(peerId) && peer.state === 'connected') {
        promises.push(this.sendMessage(peerId, message));
      }
    }
    
    const results = await Promise.allSettled(promises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
    
    logger.debug('Broadcast complete', {
      messageType: message.type,
      totalPeers: this.peers.size,
      successful,
      failed: results.length - successful
    });
    
    return successful;
  }

  sendHandshake(peerId) {
    this.sendMessage(peerId, {
      type: MessageType.PING,
      data: {
        nodeId: this.config.nodeId,
        version: this.config.protocolVersion,
        networkId: this.networkId,
        timestamp: Date.now(),
        capabilities: ['mining', 'consensus', 'sync']
      }
    });
  }

  encodeMessage(message) {
    const json = JSON.stringify({
      ...message,
      id: randomBytes(16).toString('hex'),
      timestamp: Date.now()
    });
    
    // Compress if needed
    if (json.length > this.config.compressionThreshold) {
      // TODO: Implement compression
      return Buffer.from(json);
    }
    
    return Buffer.from(json);
  }

  decodeMessage(data) {
    try {
      // TODO: Handle decompression if needed
      const json = data.toString();
      return JSON.parse(json);
    } catch (error) {
      throw new Error('Invalid message format');
    }
  }

  validateMessage(message) {
    if (!message.type || !message.id || !message.timestamp) {
      return false;
    }
    
    // Check timestamp (prevent replay attacks)
    const age = Date.now() - message.timestamp;
    if (Math.abs(age) > this.config.messageTimeout) {
      return false;
    }
    
    return true;
  }

  handlePeerDisconnect(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    logger.info('Peer disconnected', { peerId });
    
    this.peers.delete(peerId);
    this.stats.peersDisconnected++;
    
    this.emit('peer:disconnected', { peerId });
    
    // Check if we need more peers
    if (this.peers.size < this.config.minPeers) {
      this.findNewPeers();
    }
  }

  updatePeerScore(peerId, delta) {
    const currentScore = this.peerScores.get(peerId) || 0;
    const newScore = currentScore + delta;
    
    this.peerScores.set(peerId, newScore);
    
    // Ban peer if score too low
    if (newScore < -10) {
      this.banPeer(peerId, 'Low peer score');
    }
  }

  banPeer(peerId, reason) {
    const peer = this.peers.get(peerId);
    if (peer) {
      logger.warn('Banning peer', { peerId, reason });
      peer.ws.close(1008, reason);
      this.peers.delete(peerId);
    }
    
    this.bannedPeers.add(peerId);
    this.emit('peer:banned', { peerId, reason });
  }

  async connectToBootstrapPeers() {
    for (const address of this.config.bootstrapPeers) {
      try {
        await this.connectToPeer(address);
      } catch (error) {
        logger.error('Failed to connect to bootstrap peer', {
          address,
          error: error.message
        });
      }
    }
  }

  async connectToPeer(address) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${address}`);
      
      ws.on('open', () => {
        this.handleNewConnection(ws, { socket: { remoteAddress: address } });
        resolve();
      });
      
      ws.on('error', reject);
    });
  }

  getKnownPeers(limit = 20) {
    const peers = [];
    
    for (const [peerId, peer] of this.peers) {
      if (peer.state === 'connected') {
        peers.push({
          id: peerId,
          address: peer.address,
          version: peer.version,
          capabilities: Array.from(peer.capabilities)
        });
      }
      
      if (peers.length >= limit) break;
    }
    
    return peers;
  }

  async findNewPeers() {
    // Ask connected peers for more peers
    await this.broadcastMessage({
      type: MessageType.PEER_DISCOVERY,
      data: { limit: 10 }
    });
  }

  startMaintenanceTasks() {
    // Peer cleanup
    setInterval(() => {
      const now = Date.now();
      for (const [peerId, peer] of this.peers) {
        if (now - peer.lastSeen > this.config.peerTimeout) {
          logger.info('Peer timeout', { peerId });
          peer.ws.close(1000, 'Timeout');
          this.handlePeerDisconnect(peerId);
        }
      }
    }, 60000); // Every minute
    
    // Peer discovery
    setInterval(() => {
      if (this.peers.size < this.config.minPeers) {
        this.findNewPeers();
      }
    }, 30000); // Every 30 seconds
    
    // Statistics reporting
    setInterval(() => {
      this.emit('stats', this.getStats());
    }, 10000); // Every 10 seconds
  }

  generatePeerId() {
    return randomBytes(20).toString('hex');
  }

  getStats() {
    return {
      ...this.stats,
      activePeers: this.peers.size,
      avgPeerScore: this.calculateAvgPeerScore(),
      networkHealth: this.calculateNetworkHealth()
    };
  }

  calculateAvgPeerScore() {
    if (this.peerScores.size === 0) return 0;
    
    let total = 0;
    for (const score of this.peerScores.values()) {
      total += score;
    }
    
    return total / this.peerScores.size;
  }

  calculateNetworkHealth() {
    const peerRatio = this.peers.size / this.config.maxPeers;
    const avgScore = this.calculateAvgPeerScore();
    const scoreNormalized = Math.max(0, Math.min(1, (avgScore + 10) / 20));
    
    return (peerRatio * 0.5 + scoreNormalized * 0.5) * 100;
  }

  async stop() {
    logger.info('Stopping P2P network');
    
    // Close all peer connections
    for (const [peerId, peer] of this.peers) {
      peer.ws.close(1000, 'Shutting down');
    }
    
    // Close servers
    if (this.wsServer) {
      await new Promise((resolve) => {
        this.wsServer.close(resolve);
      });
    }
    
    if (this.udpSocket) {
      await new Promise((resolve) => {
        this.udpSocket.close(resolve);
      });
    }
    
    this.isListening = false;
    this.emit('stopped');
  }

  // DHT implementation placeholder
  async initializeDHT() {
    // TODO: Implement distributed hash table for peer discovery
    logger.info('DHT initialized');
  }

  handleUDPMessage(msg, rinfo) {
    // TODO: Implement UDP-based peer discovery
    logger.debug('UDP message received', {
      from: `${rinfo.address}:${rinfo.port}`,
      size: msg.length
    });
  }

  handleInvalidMessage(peerId, message) {
    logger.warn('Invalid message received', { peerId, messageType: message.type });
    this.updatePeerScore(peerId, -2);
  }
}

export default EnhancedP2PNetwork;