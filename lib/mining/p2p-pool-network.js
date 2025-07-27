/**
 * P2P Mining Pool Network - Otedama
 * Distributed peer-to-peer mining pool networking
 * 
 * Design principles:
 * - Carmack: Low-latency peer discovery and message passing
 * - Martin: Clean P2P architecture with clear separation of concerns
 * - Pike: Simple but robust networking
 */

import { EventEmitter } from 'events';
import { createServer, Socket } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import { createHash, randomBytes } from 'crypto';
import { promisify } from 'util';
import dns from 'dns';
import { createStructuredLogger } from '../core/structured-logger.js';
import { MiningError } from '../core/error-handler.js';
import { memoryManager } from '../core/memory-manager.js';
import { validator } from '../core/validator.js';
import { rateLimiter } from '../core/rate-limiter.js';

const logger = createStructuredLogger('P2PPoolNetwork');
const dnsResolve4 = promisify(dns.resolve4);

// Message types
export const MessageType = {
  // Peer discovery
  PING: 'ping',
  PONG: 'pong',
  PEER_ANNOUNCE: 'peer_announce',
  PEER_LIST: 'peer_list',
  
  // Pool synchronization
  SHARE_BROADCAST: 'share_broadcast',
  BLOCK_FOUND: 'block_found',
  JOB_UPDATE: 'job_update',
  DIFFICULTY_ADJUSTMENT: 'difficulty_adjustment',
  
  // Pool management
  POOL_STATS: 'pool_stats',
  MINER_STATS: 'miner_stats',
  REWARD_DISTRIBUTION: 'reward_distribution',
  
  // Consensus
  VOTE_REQUEST: 'vote_request',
  VOTE_RESPONSE: 'vote_response',
  CONSENSUS_RESULT: 'consensus_result'
};

// Peer states
export const PeerState = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  AUTHENTICATED: 'authenticated',
  DISCONNECTED: 'disconnected',
  BANNED: 'banned'
};

/**
 * P2P Pool Network Manager
 */
export class P2PPoolNetwork extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      nodeId: config.nodeId || this.generateNodeId(),
      listenPort: config.listenPort || 8888,
      wsPort: config.wsPort || 8889,
      maxPeers: config.maxPeers || 50,
      peerTimeout: config.peerTimeout || 30000,
      messageTimeout: config.messageTimeout || 5000,
      consensusThreshold: config.consensusThreshold || 0.51,
      bootstrapPeers: config.bootstrapPeers || [],
      ...config
    };
    
    // Network state
    this.peers = new Map();
    this.pendingMessages = new Map();
    this.messageHandlers = new Map();
    this.consensusVotes = new Map();
    
    // Servers
    this.tcpServer = null;
    this.wsServer = null;
    
    // Statistics
    this.stats = {
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      bytesSent: 0,
      peersConnected: 0,
      consensusRounds: 0
    };
    
    // Message buffer pool
    this.messageBufferPool = memoryManager.createPool(
      'p2p-messages',
      () => Buffer.allocUnsafe(65536),
      (buffer) => buffer.fill(0),
      100
    );
    
    // Setup message handlers
    this.setupMessageHandlers();
    
    // Start heartbeat
    this.heartbeatInterval = setInterval(() => this.heartbeat(), 10000);
  }
  
  /**
   * Start P2P network
   */
  async start() {
    try {
      // Start TCP server
      await this.startTCPServer();
      
      // Start WebSocket server
      await this.startWebSocketServer();
      
      // Connect to bootstrap peers
      await this.connectToBootstrapPeers();
      
      logger.info('P2P network started', {
        nodeId: this.config.nodeId,
        tcpPort: this.config.listenPort,
        wsPort: this.config.wsPort
      });
      
      this.emit('started');
      
    } catch (error) {
      logger.error('Failed to start P2P network:', error);
      throw error;
    }
  }
  
  /**
   * Stop P2P network
   */
  async stop() {
    // Clear intervals
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    // Disconnect all peers
    for (const peer of this.peers.values()) {
      this.disconnectPeer(peer.id);
    }
    
    // Close servers
    if (this.tcpServer) {
      await new Promise(resolve => this.tcpServer.close(resolve));
    }
    
    if (this.wsServer) {
      this.wsServer.close();
    }
    
    logger.info('P2P network stopped');
    this.emit('stopped');
  }
  
  /**
   * Start TCP server
   */
  async startTCPServer() {
    this.tcpServer = createServer((socket) => {
      this.handleIncomingConnection(socket, 'tcp');
    });
    
    await new Promise((resolve, reject) => {
      this.tcpServer.listen(this.config.listenPort, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    logger.info(`TCP server listening on port ${this.config.listenPort}`);
  }
  
  /**
   * Start WebSocket server
   */
  async startWebSocketServer() {
    this.wsServer = new WebSocketServer({
      port: this.config.wsPort,
      perMessageDeflate: {
        zlibDeflateOptions: {
          chunkSize: 1024,
          memLevel: 7,
          level: 3
        },
        threshold: 1024
      }
    });
    
    this.wsServer.on('connection', (ws, req) => {
      const remoteAddress = req.socket.remoteAddress;
      this.handleIncomingConnection(ws, 'websocket', remoteAddress);
    });
    
    logger.info(`WebSocket server listening on port ${this.config.wsPort}`);
  }
  
  /**
   * Handle incoming connection
   */
  handleIncomingConnection(connection, type, remoteAddress) {
    const peerId = this.generatePeerId();
    
    const peer = {
      id: peerId,
      connection,
      type,
      state: PeerState.CONNECTED,
      address: remoteAddress || connection.remoteAddress,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      stats: {
        messagesReceived: 0,
        messagesSent: 0,
        bytesReceived: 0,
        bytesSent: 0
      }
    };
    
    // Check peer limit
    if (this.peers.size >= this.config.maxPeers) {
      logger.warn('Max peers reached, rejecting connection');
      this.closePeerConnection(peer);
      return;
    }
    
    // Check rate limit
    if (!rateLimiter.checkIP(peer.address)) {
      logger.warn('Rate limit exceeded for peer', { address: peer.address });
      this.closePeerConnection(peer);
      return;
    }
    
    // Add peer
    this.peers.set(peerId, peer);
    this.stats.peersConnected++;
    
    // Setup connection handlers
    if (type === 'tcp') {
      this.setupTCPHandlers(peer);
    } else {
      this.setupWebSocketHandlers(peer);
    }
    
    // Send initial ping
    this.sendMessage(peerId, MessageType.PING, {
      nodeId: this.config.nodeId,
      timestamp: Date.now()
    });
    
    logger.info('New peer connected', {
      peerId,
      type,
      address: peer.address
    });
    
    this.emit('peer:connected', peer);
  }
  
  /**
   * Setup TCP connection handlers
   */
  setupTCPHandlers(peer) {
    const socket = peer.connection;
    let buffer = Buffer.alloc(0);
    
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      peer.stats.bytesReceived += data.length;
      this.stats.bytesReceived += data.length;
      
      // Process complete messages
      while (buffer.length >= 4) {
        const messageLength = buffer.readUInt32BE(0);
        
        if (buffer.length >= 4 + messageLength) {
          const messageData = buffer.slice(4, 4 + messageLength);
          buffer = buffer.slice(4 + messageLength);
          
          this.handleMessage(peer.id, messageData);
        } else {
          break;
        }
      }
    });
    
    socket.on('close', () => {
      this.handlePeerDisconnect(peer.id);
    });
    
    socket.on('error', (error) => {
      logger.error('TCP socket error:', { peerId: peer.id, error });
      this.handlePeerDisconnect(peer.id);
    });
  }
  
  /**
   * Setup WebSocket handlers
   */
  setupWebSocketHandlers(peer) {
    const ws = peer.connection;
    
    ws.on('message', (data) => {
      peer.stats.bytesReceived += data.length;
      this.stats.bytesReceived += data.length;
      this.handleMessage(peer.id, data);
    });
    
    ws.on('close', () => {
      this.handlePeerDisconnect(peer.id);
    });
    
    ws.on('error', (error) => {
      logger.error('WebSocket error:', { peerId: peer.id, error });
      this.handlePeerDisconnect(peer.id);
    });
    
    ws.on('pong', () => {
      peer.lastSeen = Date.now();
    });
  }
  
  /**
   * Handle incoming message
   */
  async handleMessage(peerId, data) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    try {
      // Parse message
      const message = JSON.parse(data.toString());
      
      // Validate message
      if (!this.validateMessage(message)) {
        logger.warn('Invalid message from peer', { peerId });
        return;
      }
      
      // Update stats
      peer.stats.messagesReceived++;
      peer.lastSeen = Date.now();
      this.stats.messagesReceived++;
      
      // Handle message
      const handler = this.messageHandlers.get(message.type);
      if (handler) {
        await handler(peerId, message);
      } else {
        logger.warn('Unknown message type', { type: message.type, peerId });
      }
      
    } catch (error) {
      logger.error('Error handling message:', { peerId, error });
    }
  }
  
  /**
   * Send message to peer
   */
  async sendMessage(peerId, type, payload, waitForResponse = false) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.state !== PeerState.CONNECTED) {
      return null;
    }
    
    const message = {
      id: randomBytes(16).toString('hex'),
      type,
      payload,
      timestamp: Date.now()
    };
    
    const data = Buffer.from(JSON.stringify(message));
    
    try {
      if (peer.type === 'tcp') {
        // Send with length prefix
        const lengthBuffer = Buffer.allocUnsafe(4);
        lengthBuffer.writeUInt32BE(data.length, 0);
        peer.connection.write(Buffer.concat([lengthBuffer, data]));
      } else {
        // WebSocket
        peer.connection.send(data);
      }
      
      // Update stats
      peer.stats.messagesSent++;
      peer.stats.bytesSent += data.length;
      this.stats.messagesSent++;
      this.stats.bytesSent += data.length;
      
      // Wait for response if requested
      if (waitForResponse) {
        return await this.waitForResponse(message.id);
      }
      
      return true;
      
    } catch (error) {
      logger.error('Error sending message:', { peerId, error });
      this.handlePeerDisconnect(peerId);
      return null;
    }
  }
  
  /**
   * Broadcast message to all peers
   */
  async broadcast(type, payload, excludePeers = []) {
    const promises = [];
    
    for (const [peerId, peer] of this.peers) {
      if (!excludePeers.includes(peerId) && peer.state === PeerState.CONNECTED) {
        promises.push(this.sendMessage(peerId, type, payload));
      }
    }
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Setup message handlers
   */
  setupMessageHandlers() {
    // Ping/Pong
    this.messageHandlers.set(MessageType.PING, async (peerId, message) => {
      await this.sendMessage(peerId, MessageType.PONG, {
        nodeId: this.config.nodeId,
        timestamp: Date.now(),
        echo: message.payload
      });
    });
    
    this.messageHandlers.set(MessageType.PONG, (peerId, message) => {
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.lastSeen = Date.now();
        peer.latency = Date.now() - message.payload.echo.timestamp;
      }
    });
    
    // Peer discovery
    this.messageHandlers.set(MessageType.PEER_ANNOUNCE, async (peerId, message) => {
      this.handlePeerAnnounce(peerId, message.payload);
    });
    
    this.messageHandlers.set(MessageType.PEER_LIST, (peerId, message) => {
      this.handlePeerList(message.payload.peers);
    });
    
    // Share broadcasting
    this.messageHandlers.set(MessageType.SHARE_BROADCAST, async (peerId, message) => {
      this.emit('share:received', {
        peerId,
        share: message.payload
      });
      
      // Relay to other peers
      await this.broadcast(MessageType.SHARE_BROADCAST, message.payload, [peerId]);
    });
    
    // Block found
    this.messageHandlers.set(MessageType.BLOCK_FOUND, async (peerId, message) => {
      this.emit('block:found', {
        peerId,
        block: message.payload
      });
      
      // Start consensus
      await this.startConsensus('block_validation', message.payload);
    });
    
    // Consensus voting
    this.messageHandlers.set(MessageType.VOTE_REQUEST, async (peerId, message) => {
      const vote = await this.handleVoteRequest(message.payload);
      await this.sendMessage(peerId, MessageType.VOTE_RESPONSE, vote);
    });
    
    this.messageHandlers.set(MessageType.VOTE_RESPONSE, (peerId, message) => {
      this.handleVoteResponse(peerId, message.payload);
    });
  }
  
  /**
   * Connect to bootstrap peers
   */
  async connectToBootstrapPeers() {
    for (const peerAddress of this.config.bootstrapPeers) {
      try {
        await this.connectToPeer(peerAddress);
      } catch (error) {
        logger.warn('Failed to connect to bootstrap peer:', { peerAddress, error });
      }
    }
  }
  
  /**
   * Connect to peer
   */
  async connectToPeer(address) {
    const [host, port] = address.split(':');
    const peerId = this.generatePeerId();
    
    // Check if already connected
    for (const peer of this.peers.values()) {
      if (peer.address === address) {
        return;
      }
    }
    
    const socket = new Socket();
    
    const peer = {
      id: peerId,
      connection: socket,
      type: 'tcp',
      state: PeerState.CONNECTING,
      address,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      stats: {
        messagesReceived: 0,
        messagesSent: 0,
        bytesReceived: 0,
        bytesSent: 0
      }
    };
    
    this.peers.set(peerId, peer);
    
    return new Promise((resolve, reject) => {
      socket.connect(parseInt(port), host, () => {
        peer.state = PeerState.CONNECTED;
        this.setupTCPHandlers(peer);
        
        // Send initial ping
        this.sendMessage(peerId, MessageType.PING, {
          nodeId: this.config.nodeId,
          timestamp: Date.now()
        });
        
        logger.info('Connected to peer', { peerId, address });
        this.emit('peer:connected', peer);
        resolve(peer);
      });
      
      socket.on('error', (error) => {
        this.peers.delete(peerId);
        reject(error);
      });
      
      // Connection timeout
      setTimeout(() => {
        if (peer.state === PeerState.CONNECTING) {
          socket.destroy();
          this.peers.delete(peerId);
          reject(new Error('Connection timeout'));
        }
      }, this.config.messageTimeout);
    });
  }
  
  /**
   * Disconnect peer
   */
  disconnectPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    peer.state = PeerState.DISCONNECTED;
    this.closePeerConnection(peer);
    this.peers.delete(peerId);
    this.stats.peersConnected--;
    
    logger.info('Peer disconnected', { peerId });
    this.emit('peer:disconnected', { peerId });
  }
  
  /**
   * Close peer connection
   */
  closePeerConnection(peer) {
    try {
      if (peer.type === 'tcp') {
        peer.connection.destroy();
      } else {
        peer.connection.close();
      }
    } catch (error) {
      // Ignore errors during close
    }
  }
  
  /**
   * Handle peer disconnect
   */
  handlePeerDisconnect(peerId) {
    this.disconnectPeer(peerId);
  }
  
  /**
   * Handle peer announce
   */
  async handlePeerAnnounce(peerId, peerInfo) {
    // Validate peer info
    if (!this.validatePeerInfo(peerInfo)) {
      return;
    }
    
    // Try to connect if not at peer limit
    if (this.peers.size < this.config.maxPeers) {
      try {
        await this.connectToPeer(peerInfo.address);
      } catch (error) {
        logger.debug('Failed to connect to announced peer:', { address: peerInfo.address });
      }
    }
    
    // Share our peer list
    const peerList = this.getPeerList();
    await this.sendMessage(peerId, MessageType.PEER_LIST, { peers: peerList });
  }
  
  /**
   * Handle peer list
   */
  handlePeerList(peers) {
    // Connect to new peers if needed
    const connectPromises = [];
    
    for (const peerInfo of peers) {
      if (this.peers.size >= this.config.maxPeers) break;
      
      // Check if not already connected
      let alreadyConnected = false;
      for (const peer of this.peers.values()) {
        if (peer.address === peerInfo.address) {
          alreadyConnected = true;
          break;
        }
      }
      
      if (!alreadyConnected && this.validatePeerInfo(peerInfo)) {
        connectPromises.push(
          this.connectToPeer(peerInfo.address).catch(err => {
            logger.debug('Failed to connect to peer from list:', { address: peerInfo.address });
          })
        );
      }
    }
    
    Promise.all(connectPromises);
  }
  
  /**
   * Start consensus round
   */
  async startConsensus(topic, data) {
    const consensusId = randomBytes(16).toString('hex');
    
    this.consensusVotes.set(consensusId, {
      topic,
      data,
      votes: new Map(),
      startTime: Date.now()
    });
    
    // Request votes from all peers
    await this.broadcast(MessageType.VOTE_REQUEST, {
      consensusId,
      topic,
      data
    });
    
    // Wait for votes
    setTimeout(() => {
      this.finalizeConsensus(consensusId);
    }, this.config.messageTimeout);
    
    this.stats.consensusRounds++;
  }
  
  /**
   * Handle vote request
   */
  async handleVoteRequest(request) {
    // Validate based on topic
    let vote = false;
    
    switch (request.topic) {
      case 'block_validation':
        vote = await this.validateBlock(request.data);
        break;
      case 'share_validation':
        vote = await this.validateShare(request.data);
        break;
      default:
        logger.warn('Unknown consensus topic:', request.topic);
    }
    
    return {
      consensusId: request.consensusId,
      vote,
      nodeId: this.config.nodeId,
      signature: this.signVote(request.consensusId, vote)
    };
  }
  
  /**
   * Handle vote response
   */
  handleVoteResponse(peerId, vote) {
    const consensus = this.consensusVotes.get(vote.consensusId);
    if (!consensus) return;
    
    // Verify vote signature
    if (!this.verifyVoteSignature(vote)) {
      logger.warn('Invalid vote signature from peer:', { peerId });
      return;
    }
    
    consensus.votes.set(peerId, vote.vote);
  }
  
  /**
   * Finalize consensus
   */
  finalizeConsensus(consensusId) {
    const consensus = this.consensusVotes.get(consensusId);
    if (!consensus) return;
    
    const totalVotes = consensus.votes.size;
    const yesVotes = Array.from(consensus.votes.values()).filter(v => v).length;
    const consensus Result = yesVotes / totalVotes >= this.config.consensusThreshold;
    
    logger.info('Consensus finalized', {
      consensusId,
      topic: consensus.topic,
      result: consensusResult,
      votes: { yes: yesVotes, total: totalVotes }
    });
    
    this.emit('consensus:complete', {
      consensusId,
      topic: consensus.topic,
      data: consensus.data,
      result: consensusResult,
      votes: { yes: yesVotes, total: totalVotes }
    });
    
    // Broadcast result
    this.broadcast(MessageType.CONSENSUS_RESULT, {
      consensusId,
      result: consensusResult
    });
    
    this.consensusVotes.delete(consensusId);
  }
  
  /**
   * Heartbeat to maintain connections
   */
  heartbeat() {
    const now = Date.now();
    const timeout = this.config.peerTimeout;
    
    for (const [peerId, peer] of this.peers) {
      if (now - peer.lastSeen > timeout) {
        logger.info('Peer timeout', { peerId });
        this.disconnectPeer(peerId);
      } else if (peer.type === 'websocket') {
        // Send WebSocket ping
        try {
          peer.connection.ping();
        } catch (error) {
          this.disconnectPeer(peerId);
        }
      }
    }
    
    // Announce ourselves to peers periodically
    if (this.peers.size > 0 && Math.random() < 0.1) {
      this.broadcast(MessageType.PEER_ANNOUNCE, {
        nodeId: this.config.nodeId,
        address: `${this.getPublicIP()}:${this.config.listenPort}`,
        timestamp: Date.now()
      });
    }
  }
  
  /**
   * Get peer list for sharing
   */
  getPeerList() {
    const peers = [];
    
    for (const peer of this.peers.values()) {
      if (peer.state === PeerState.CONNECTED) {
        peers.push({
          address: peer.address,
          lastSeen: peer.lastSeen,
          latency: peer.latency
        });
      }
    }
    
    return peers.slice(0, 10); // Share top 10 peers
  }
  
  /**
   * Validate message
   */
  validateMessage(message) {
    return message &&
           message.id &&
           message.type &&
           message.timestamp &&
           Math.abs(Date.now() - message.timestamp) < 60000; // 1 minute clock skew
  }
  
  /**
   * Validate peer info
   */
  validatePeerInfo(peerInfo) {
    if (!peerInfo || !peerInfo.address) return false;
    
    const [host, port] = peerInfo.address.split(':');
    if (!host || !port) return false;
    
    const portNum = parseInt(port);
    return portNum > 0 && portNum <= 65535;
  }
  
  /**
   * Validate block (placeholder)
   */
  async validateBlock(block) {
    // Implement block validation logic
    return true;
  }
  
  /**
   * Validate share (placeholder)
   */
  async validateShare(share) {
    // Implement share validation logic
    return true;
  }
  
  /**
   * Sign vote
   */
  signVote(consensusId, vote) {
    const data = `${consensusId}:${vote}:${this.config.nodeId}`;
    return createHash('sha256').update(data).digest('hex');
  }
  
  /**
   * Verify vote signature
   */
  verifyVoteSignature(vote) {
    const data = `${vote.consensusId}:${vote.vote}:${vote.nodeId}`;
    const signature = createHash('sha256').update(data).digest('hex');
    return signature === vote.signature;
  }
  
  /**
   * Wait for response
   */
  async waitForResponse(messageId) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingMessages.delete(messageId);
        reject(new Error('Response timeout'));
      }, this.config.messageTimeout);
      
      this.pendingMessages.set(messageId, { resolve, reject, timeout });
    });
  }
  
  /**
   * Generate node ID
   */
  generateNodeId() {
    return createHash('sha256')
      .update(randomBytes(32))
      .digest('hex')
      .substring(0, 16);
  }
  
  /**
   * Generate peer ID
   */
  generatePeerId() {
    return randomBytes(16).toString('hex');
  }
  
  /**
   * Get public IP (placeholder)
   */
  getPublicIP() {
    // In production, implement proper public IP detection
    return '0.0.0.0';
  }
  
  /**
   * Get network statistics
   */
  getStats() {
    const peerStats = [];
    
    for (const [peerId, peer] of this.peers) {
      peerStats.push({
        id: peerId,
        address: peer.address,
        state: peer.state,
        type: peer.type,
        connectedAt: peer.connectedAt,
        lastSeen: peer.lastSeen,
        latency: peer.latency,
        stats: peer.stats
      });
    }
    
    return {
      nodeId: this.config.nodeId,
      peers: peerStats,
      stats: this.stats,
      consensusRounds: this.consensusVotes.size
    };
  }
}

/**
 * Create P2P pool network instance
 */
export function createP2PNetwork(config) {
  return new P2PPoolNetwork(config);
}

export default P2PPoolNetwork;