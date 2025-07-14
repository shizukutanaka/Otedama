import { EventEmitter } from 'events';
import { WebSocket, WebSocketServer } from 'ws';
import { createHash, randomBytes } from 'crypto';
import { Logger } from './logger.js';
import NetworkOptimizer from './network-optimizer.js';
import { TIME_CONSTANTS } from './constants.js';

/**
 * Peer-to-Peer Network System
 * P2Pネットワークシステム
 * 
 * Features:
 * - WebSocket-based peer connections
 * - Automatic peer discovery and management
 * - Message routing and broadcasting
 * - Network topology optimization
 * - Fault tolerance and peer recovery
 * - Bandwidth control and throttling
 * - Security and peer validation
 * - Distributed hash table (DHT) for peer discovery
 */
export class P2PNetwork extends EventEmitter {
  constructor(port = 8333, maxPeers = 50, options = {}) {
    super();
    this.port = port;
    this.maxPeers = maxPeers;
    this.logger = new Logger('P2P');
    this.options = {
      enableDHT: options.enableDHT !== false,
      enableBandwidthControl: options.enableBandwidthControl !== false,
      enablePeerValidation: options.enablePeerValidation !== false,
      connectionTimeout: options.connectionTimeout || 30000,
      heartbeatInterval: options.heartbeatInterval || 30000,
      peerDiscoveryInterval: options.peerDiscoveryInterval || 60000,
      maxMessageSize: options.maxMessageSize || 1024 * 1024, // 1MB
      maxBandwidth: options.maxBandwidth || 1024 * 1024 * 10, // 10MB/s
      seedNodes: options.seedNodes || [],
      ...options
    };

    // Network state
    this.server = null;
    this.peers = new Map();
    this.connections = new Map();
    this.messageHandlers = new Map();
    this.routingTable = new Map();
    this.bandwidthUsage = new Map();
    this.networkStats = {
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      bytesSent: 0,
      connectionsEstablished: 0,
      connectionsDropped: 0,
      networkErrors: 0
    };

    // DHT for peer discovery
    this.dht = new Map();
    this.nodeId = this.generateNodeId();
    this.buckets = new Array(160).fill(null).map(() => []);

    // Active timers
    this.timers = new Map();

    // Network optimizer for latency reduction
    this.optimizer = null;

    this.initialize();
  }

  /**
   * Initialize P2P network
   */
  initialize() {
    try {
      this.setupMessageHandlers();
      
      // Initialize network optimizer
      this.optimizer = new NetworkOptimizer({
        enableCompression: true,
        compressionThreshold: 1024,
        batchInterval: 10,
        maxBatchSize: 50,
        adaptiveSizing: true
      });
      
      // Setup optimizer event handlers
      this.optimizer.on('send', (data) => {
        this.sendOptimizedMessage(data.peerId, data.data);
      });
      
      this.optimizer.on('message', (data) => {
        this.processMessage(data.peerId, data.message);
      });
      
      this.logger.info(`P2P Network initialized with node ID: ${this.nodeId.substring(0, 16)}...`);
    } catch (error) {
      this.logger.error('Failed to initialize P2P network:', error);
      throw error;
    }
  }

  /**
   * Start P2P network server
   */
  async start() {
    try {
      // Create WebSocket server
      this.server = new WebSocketServer({
        port: this.port,
        perMessageDeflate: true,
        maxPayload: this.options.maxMessageSize
      });

      this.server.on('connection', (ws, request) => {
        this.handleIncomingConnection(ws, request);
      });

      this.server.on('error', (error) => {
        this.logger.error('P2P server error:', error);
        this.networkStats.networkErrors++;
      });

      // Start periodic tasks
      this.startPeriodicTasks();

      // Connect to seed nodes
      await this.connectToSeedNodes();

      // Start peer discovery
      this.startPeerDiscovery();

      this.logger.info(`P2P network started on port ${this.port}`);
      this.emit('network:started', { port: this.port, nodeId: this.nodeId });

    } catch (error) {
      this.logger.error('Failed to start P2P network:', error);
      throw error;
    }
  }

  /**
   * Handle incoming WebSocket connection
   */
  handleIncomingConnection(ws, request) {
    try {
      const remoteAddress = request.socket.remoteAddress;
      const peerId = this.generatePeerId();

      this.logger.debug(`Incoming connection from ${remoteAddress} assigned peer ID: ${peerId}`);

      // Setup connection
      this.setupPeerConnection(ws, peerId, remoteAddress, false);

    } catch (error) {
      this.logger.error('Error handling incoming connection:', error);
      ws.close();
    }
  }

  /**
   * Setup peer connection
   */
  setupPeerConnection(ws, peerId, address, isOutgoing) {
    try {
      const peer = {
        id: peerId,
        ws,
        address,
        isOutgoing,
        connectedAt: Date.now(),
        lastHeartbeat: Date.now(),
        messagesReceived: 0,
        messagesSent: 0,
        bytesReceived: 0,
        bytesSent: 0,
        isValidated: false,
        capabilities: [],
        version: null,
        latency: 0
      };

      this.peers.set(peerId, peer);
      this.connections.set(ws, peerId);

      // Setup WebSocket event handlers
      ws.on('message', (data) => {
        this.handleMessage(peerId, data);
      });

      ws.on('close', (code, reason) => {
        this.handlePeerDisconnection(peerId, code, reason);
      });

      ws.on('error', (error) => {
        this.logger.warn(`Peer ${peerId} error:`, error);
        this.removePeer(peerId);
      });

      ws.on('pong', () => {
        this.handlePongMessage(peerId);
      });

      // Send handshake
      this.sendHandshake(peerId);

      this.networkStats.connectionsEstablished++;
      this.logger.info(`Peer connected: ${peerId} (${address}) - ${isOutgoing ? 'outgoing' : 'incoming'}`);
      this.emit('peer:connected', { peerId, address, isOutgoing });

    } catch (error) {
      this.logger.error('Error setting up peer connection:', error);
      ws.close();
    }
  }

  /**
   * Handle incoming message
   */
  handleMessage(peerId, data) {
    try {
      const peer = this.peers.get(peerId);
      if (!peer) {
        this.logger.warn(`Received message from unknown peer: ${peerId}`);
        return;
      }

      // Update statistics
      peer.messagesReceived++;
      peer.bytesReceived += data.length;
      this.networkStats.messagesReceived++;
      this.networkStats.bytesReceived += data.length;

      // Check bandwidth limits
      if (this.options.enableBandwidthControl && !this.checkBandwidthLimit(peerId, data.length)) {
        this.logger.warn(`Bandwidth limit exceeded for peer ${peerId}`);
        return;
      }

      // Parse message
      let message;
      try {
        message = JSON.parse(data);
      } catch (error) {
        this.logger.warn(`Invalid JSON from peer ${peerId}:`, error);
        return;
      }

      // Validate message structure
      if (!this.validateMessage(message)) {
        this.logger.warn(`Invalid message structure from peer ${peerId}`);
        return;
      }

      // Handle message based on type
      this.processMessage(peerId, message);

    } catch (error) {
      this.logger.error(`Error handling message from peer ${peerId}:`, error);
    }
  }

  /**
   * Process message based on type
   */
  processMessage(peerId, message) {
    try {
      const { type, data, id } = message;

      switch (type) {
        case 'batch':
          this.handleBatchMessage(peerId, data);
          break;
          
        case 'handshake':
          this.handleHandshake(peerId, data);
          break;

        case 'heartbeat':
          this.handleHeartbeat(peerId, data);
          break;

        case 'share':
          this.handleShareMessage(peerId, data);
          break;

        case 'block':
          this.handleBlockMessage(peerId, data);
          break;

        case 'peer_list':
          this.handlePeerListMessage(peerId, data);
          break;

        case 'dht_query':
          this.handleDHTQuery(peerId, data);
          break;

        case 'dht_response':
          this.handleDHTResponse(peerId, data);
          break;

        case 'custom':
          this.handleCustomMessage(peerId, data);
          break;

        default:
          this.logger.debug(`Unknown message type from peer ${peerId}: ${type}`);
      }

      // Emit message event for external handling
      this.emit('message', { peerId, type, data, id });

    } catch (error) {
      this.logger.error(`Error processing message from peer ${peerId}:`, error);
    }
  }

  /**
   * Handle handshake message
   */
  handleHandshake(peerId, data) {
    try {
      const peer = this.peers.get(peerId);
      if (!peer) return;

      const { nodeId, version, capabilities, timestamp } = data;

      // Validate handshake
      if (!nodeId || !version) {
        this.logger.warn(`Invalid handshake from peer ${peerId}`);
        this.removePeer(peerId);
        return;
      }

      // Update peer information
      peer.nodeId = nodeId;
      peer.version = version;
      peer.capabilities = capabilities || [];
      peer.isValidated = true;

      // Calculate latency
      if (timestamp) {
        peer.latency = Date.now() - timestamp;
      }

      this.logger.info(`Handshake completed with peer ${peerId} (node: ${nodeId.substring(0, 16)}..., version: ${version})`);

      // Add to DHT if enabled
      if (this.options.enableDHT) {
        this.addToDHT(nodeId, peer.address);
      }

      // Send our peer list
      this.sendPeerList(peerId);

      this.emit('peer:handshake', { peerId, nodeId, version, capabilities });

    } catch (error) {
      this.logger.error(`Error handling handshake from peer ${peerId}:`, error);
    }
  }

  /**
   * Handle heartbeat message
   */
  handleHeartbeat(peerId, data) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.lastHeartbeat = Date.now();
      
      // Respond with pong if this is a ping
      if (data && data.ping) {
        this.sendMessage(peerId, {
          type: 'heartbeat',
          data: { pong: data.ping, timestamp: Date.now() }
        });
      }
    }
  }

  /**
   * Handle share message
   */
  handleShareMessage(peerId, data) {
    try {
      // Validate share data
      if (!data || !data.workerId || data.difficulty === undefined) {
        this.logger.warn(`Invalid share from peer ${peerId}`);
        return;
      }

      this.logger.debug(`Received share from peer ${peerId}: worker ${data.workerId}, difficulty ${data.difficulty}`);
      this.emit('share:received', { peerId, share: data });

      // Relay to other peers if this is a new share
      this.relayMessage(peerId, {
        type: 'share',
        data,
        relayedBy: this.nodeId
      });

    } catch (error) {
      this.logger.error(`Error handling share from peer ${peerId}:`, error);
    }
  }

  /**
   * Handle block message
   */
  handleBlockMessage(peerId, data) {
    try {
      if (!data || !data.hash || !data.height) {
        this.logger.warn(`Invalid block from peer ${peerId}`);
        return;
      }

      this.logger.info(`Received block from peer ${peerId}: ${data.hash} (height: ${data.height})`);
      this.emit('block:received', { peerId, block: data });

      // Relay block to other peers
      this.relayMessage(peerId, {
        type: 'block',
        data,
        relayedBy: this.nodeId
      });

    } catch (error) {
      this.logger.error(`Error handling block from peer ${peerId}:`, error);
    }
  }

  /**
   * Handle peer list message
   */
  handlePeerListMessage(peerId, data) {
    try {
      if (!Array.isArray(data.peers)) {
        this.logger.warn(`Invalid peer list from peer ${peerId}`);
        return;
      }

      this.logger.debug(`Received peer list from ${peerId}: ${data.peers.length} peers`);

      // Try to connect to new peers
      for (const peerInfo of data.peers) {
        if (this.shouldConnectToPeer(peerInfo)) {
          this.connectToPeer(peerInfo.address, peerInfo.port);
        }
      }

    } catch (error) {
      this.logger.error(`Error handling peer list from peer ${peerId}:`, error);
    }
  }

  /**
   * Handle batch message
   */
  async handleBatchMessage(peerId, data) {
    try {
      const messageCount = await this.optimizer.processIncomingBatch(peerId, data);
      this.logger.debug(`Processed batch from ${peerId}: ${messageCount} messages`);
    } catch (error) {
      this.logger.error(`Error handling batch from ${peerId}:`, error);
    }
  }

  /**
   * Send message to peer (with optimization)
   */
  async sendMessage(peerId, message) {
    try {
      const peer = this.peers.get(peerId);
      if (!peer || peer.ws.readyState !== WebSocket.OPEN) {
        return false;
      }

      // Use optimizer for non-critical messages
      const criticalTypes = ['handshake', 'block'];
      if (!criticalTypes.includes(message.type) && this.optimizer) {
        await this.optimizer.queueMessage(peerId, message);
        return true;
      }

      // Send critical messages immediately
      return this.sendMessageDirect(peerId, message);
    } catch (error) {
      this.logger.error(`Error sending message to peer ${peerId}:`, error);
      return false;
    }
  }

  /**
   * Send message directly (bypassing optimizer)
   */
  sendMessageDirect(peerId, message) {
    try {
      const peer = this.peers.get(peerId);
      if (!peer || peer.ws.readyState !== WebSocket.OPEN) {
        return false;
      }

      const messageStr = JSON.stringify(message);
      const messageSize = Buffer.byteLength(messageStr);

      // Check message size limit
      if (messageSize > this.options.maxMessageSize) {
        this.logger.warn(`Message too large for peer ${peerId}: ${messageSize} bytes`);
        return false;
      }

      // Check bandwidth limit
      if (this.options.enableBandwidthControl && !this.checkBandwidthLimit(peerId, messageSize, false)) {
        this.logger.debug(`Bandwidth limit exceeded for outgoing message to peer ${peerId}`);
        return false;
      }

      peer.ws.send(messageStr);

      // Update statistics
      peer.messagesSent++;
      peer.bytesSent += messageSize;
      this.networkStats.messagesSent++;
      this.networkStats.bytesSent += messageSize;

      return true;
    } catch (error) {
      this.logger.error(`Error sending message directly to peer ${peerId}:`, error);
      return false;
    }
  }

  /**
   * Send optimized message (from optimizer)
   */
  sendOptimizedMessage(peerId, optimizedData) {
    try {
      const peer = this.peers.get(peerId);
      if (!peer || peer.ws.readyState !== WebSocket.OPEN) {
        return false;
      }

      const message = {
        type: 'batch',
        data: optimizedData,
        timestamp: Date.now()
      };

      return this.sendMessageDirect(peerId, message);
    } catch (error) {
      this.logger.error(`Error sending optimized message to peer ${peerId}:`, error);
      return false;
    }
  }

  /**
   * Broadcast message to all peers
   */
  broadcast(type, data, excludePeer = null) {
    try {
      const message = {
        type,
        data,
        id: randomBytes(8).toString('hex'),
        timestamp: Date.now(),
        sender: this.nodeId
      };

      let sent = 0;
      for (const [peerId, peer] of this.peers) {
        if (peerId !== excludePeer && peer.isValidated) {
          if (this.sendMessage(peerId, message)) {
            sent++;
          }
        }
      }

      this.logger.debug(`Broadcasted ${type} message to ${sent} peers`);
      return sent;
    } catch (error) {
      this.logger.error(`Error broadcasting message:`, error);
      return 0;
    }
  }

  /**
   * Relay message to other peers (excluding sender)
   */
  relayMessage(senderPeerId, message, maxHops = 3) {
    try {
      // Add relay information
      message.hops = (message.hops || 0) + 1;
      message.relayedBy = this.nodeId;

      // Check hop limit
      if (message.hops > maxHops) {
        return;
      }

      // Relay to other peers
      this.broadcast(message.type, message.data, senderPeerId);

    } catch (error) {
      this.logger.error('Error relaying message:', error);
    }
  }

  /**
   * Connect to a peer
   */
  async connectToPeer(address, port = this.port) {
    try {
      if (this.peers.size >= this.maxPeers) {
        this.logger.debug(`Max peers reached (${this.maxPeers}), not connecting to ${address}:${port}`);
        return null;
      }

      // Check if already connected
      for (const peer of this.peers.values()) {
        if (peer.address === address) {
          return null; // Already connected
        }
      }

      const url = `ws://${address}:${port}`;
      const ws = new WebSocket(url, {
        handshakeTimeout: this.options.connectionTimeout
      });

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Connection timeout'));
        }, this.options.connectionTimeout);

        ws.on('open', () => {
          clearTimeout(timeout);
          const peerId = this.generatePeerId();
          this.setupPeerConnection(ws, peerId, address, true);
          resolve(peerId);
        });

        ws.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

    } catch (error) {
      this.logger.error(`Error connecting to peer ${address}:${port}:`, error);
      return null;
    }
  }

  /**
   * Connect to seed nodes
   */
  async connectToSeedNodes() {
    try {
      if (this.options.seedNodes.length === 0) {
        this.logger.info('No seed nodes configured');
        return;
      }

      this.logger.info(`Connecting to ${this.options.seedNodes.length} seed nodes...`);

      const connectionPromises = this.options.seedNodes.map(async (seedNode) => {
        try {
          const [address, port] = seedNode.split(':');
          await this.connectToPeer(address, parseInt(port) || this.port);
          this.logger.info(`Connected to seed node: ${seedNode}`);
        } catch (error) {
          this.logger.warn(`Failed to connect to seed node ${seedNode}:`, error.message);
        }
      });

      await Promise.allSettled(connectionPromises);

    } catch (error) {
      this.logger.error('Error connecting to seed nodes:', error);
    }
  }

  /**
   * Start periodic tasks
   */
  startPeriodicTasks() {
    // Heartbeat timer
    this.timers.set('heartbeat', setInterval(() => {
      this.sendHeartbeats();
    }, this.options.heartbeatInterval));

    // Peer maintenance timer
    this.timers.set('maintenance', setInterval(() => {
      this.maintainPeers();
    }, TIME_CONSTANTS.minute));

    // Bandwidth reset timer
    this.timers.set('bandwidth', setInterval(() => {
      this.resetBandwidthCounters();
    }, TIME_CONSTANTS.minute));

    // Network statistics timer
    this.timers.set('stats', setInterval(() => {
      this.updateNetworkStats();
    }, TIME_CONSTANTS.minute * 5));
  }

  /**
   * Send heartbeat to all peers
   */
  sendHeartbeats() {
    try {
      const timestamp = Date.now();
      
      for (const [peerId, peer] of this.peers) {
        if (peer.isValidated) {
          this.sendMessage(peerId, {
            type: 'heartbeat',
            data: { ping: timestamp, timestamp }
          });
        }
      }
    } catch (error) {
      this.logger.error('Error sending heartbeats:', error);
    }
  }

  /**
   * Maintain peer connections
   */
  maintainPeers() {
    try {
      const now = Date.now();
      const heartbeatTimeout = this.options.heartbeatInterval * 3; // 3x heartbeat interval
      const peersToRemove = [];

      // Check for dead peers
      for (const [peerId, peer] of this.peers) {
        if (now - peer.lastHeartbeat > heartbeatTimeout) {
          this.logger.warn(`Peer ${peerId} heartbeat timeout, removing`);
          peersToRemove.push(peerId);
        }
      }

      // Remove dead peers
      for (const peerId of peersToRemove) {
        this.removePeer(peerId);
      }

      // Try to maintain minimum number of connections
      const minPeers = Math.max(3, Math.floor(this.maxPeers * 0.2));
      if (this.peers.size < minPeers) {
        this.logger.info(`Low peer count (${this.peers.size}), attempting to find more peers`);
        this.findMorePeers();
      }

    } catch (error) {
      this.logger.error('Error maintaining peers:', error);
    }
  }

  /**
   * Remove peer
   */
  removePeer(peerId) {
    try {
      const peer = this.peers.get(peerId);
      if (!peer) return;

      // Close WebSocket connection
      if (peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.close();
      }

      // Remove from maps
      this.peers.delete(peerId);
      this.connections.delete(peer.ws);
      this.bandwidthUsage.delete(peerId);

      this.networkStats.connectionsDropped++;
      this.logger.info(`Peer removed: ${peerId}`);
      this.emit('peer:disconnected', { peerId });

    } catch (error) {
      this.logger.error(`Error removing peer ${peerId}:`, error);
    }
  }

  /**
   * Utility functions
   */
  generateNodeId() {
    return createHash('sha256').update(randomBytes(32)).digest('hex');
  }

  generatePeerId() {
    return randomBytes(16).toString('hex');
  }

  validateMessage(message) {
    return message && 
           typeof message.type === 'string' && 
           message.data !== undefined;
  }

  checkBandwidthLimit(peerId, bytes, incoming = true) {
    if (!this.options.enableBandwidthControl) return true;

    const now = Date.now();
    const usage = this.bandwidthUsage.get(peerId) || {
      incoming: { bytes: 0, timestamp: now },
      outgoing: { bytes: 0, timestamp: now }
    };

    const direction = incoming ? 'incoming' : 'outgoing';
    const currentUsage = usage[direction];

    // Reset if more than 1 second has passed
    if (now - currentUsage.timestamp > 1000) {
      currentUsage.bytes = 0;
      currentUsage.timestamp = now;
    }

    currentUsage.bytes += bytes;
    this.bandwidthUsage.set(peerId, usage);

    return currentUsage.bytes <= this.options.maxBandwidth;
  }

  resetBandwidthCounters() {
    this.bandwidthUsage.clear();
  }

  sendHandshake(peerId) {
    this.sendMessage(peerId, {
      type: 'handshake',
      data: {
        nodeId: this.nodeId,
        version: '1.0.0',
        capabilities: ['mining', 'dex', 'bridge'],
        timestamp: Date.now()
      }
    });
  }

  sendPeerList(peerId) {
    const peerList = Array.from(this.peers.values())
      .filter(p => p.isValidated && p.id !== peerId)
      .slice(0, 20) // Limit to 20 peers
      .map(p => ({
        nodeId: p.nodeId,
        address: p.address,
        port: this.port,
        capabilities: p.capabilities
      }));

    this.sendMessage(peerId, {
      type: 'peer_list',
      data: { peers: peerList }
    });
  }

  shouldConnectToPeer(peerInfo) {
    // Don't connect to ourselves
    if (peerInfo.nodeId === this.nodeId) return false;

    // Don't connect if already connected
    for (const peer of this.peers.values()) {
      if (peer.nodeId === peerInfo.nodeId || peer.address === peerInfo.address) {
        return false;
      }
    }

    // Don't connect if we're at max capacity
    if (this.peers.size >= this.maxPeers) return false;

    return true;
  }

  handlePeerDisconnection(peerId, code, reason) {
    this.logger.info(`Peer ${peerId} disconnected: ${code} ${reason}`);
    this.removePeer(peerId);
  }

  handlePongMessage(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.lastHeartbeat = Date.now();
    }
  }

  handleCustomMessage(peerId, data) {
    this.emit('custom_message', { peerId, data });
  }

  handleDHTQuery(peerId, data) {
    // Simplified DHT implementation
    if (this.options.enableDHT && data.key) {
      const result = this.dht.get(data.key);
      this.sendMessage(peerId, {
        type: 'dht_response',
        data: { key: data.key, value: result, queryId: data.queryId }
      });
    }
  }

  handleDHTResponse(peerId, data) {
    this.emit('dht_response', { peerId, data });
  }

  addToDHT(nodeId, address) {
    if (this.options.enableDHT) {
      this.dht.set(nodeId, { address, timestamp: Date.now() });
    }
  }

  findMorePeers() {
    // Request peer lists from connected peers
    this.broadcast('get_peers', {});
  }

  startPeerDiscovery() {
    if (this.options.enableDHT) {
      this.timers.set('discovery', setInterval(() => {
        // DHT-based peer discovery (simplified)
        this.performPeerDiscovery();
      }, this.options.peerDiscoveryInterval));
    }
  }

  performPeerDiscovery() {
    // Simplified peer discovery
    this.broadcast('peer_discovery', { nodeId: this.nodeId });
  }

  updateNetworkStats() {
    this.emit('network:stats', this.getNetworkStats());
  }

  /**
   * Get network statistics
   */
  getNetworkStats() {
    const optimizerReport = this.optimizer ? this.optimizer.getOptimizationReport() : null;
    
    return {
      ...this.networkStats,
      connectedPeers: this.peers.size,
      validatedPeers: Array.from(this.peers.values()).filter(p => p.isValidated).length,
      outgoingConnections: Array.from(this.peers.values()).filter(p => p.isOutgoing).length,
      averageLatency: this.calculateAverageLatency(),
      totalBandwidth: this.calculateTotalBandwidth(),
      optimization: optimizerReport
    };
  }

  calculateAverageLatency() {
    const validatedPeers = Array.from(this.peers.values()).filter(p => p.isValidated && p.latency > 0);
    if (validatedPeers.length === 0) return 0;
    
    const totalLatency = validatedPeers.reduce((sum, peer) => sum + peer.latency, 0);
    return Math.round(totalLatency / validatedPeers.length);
  }

  calculateTotalBandwidth() {
    let totalIncoming = 0;
    let totalOutgoing = 0;
    
    for (const usage of this.bandwidthUsage.values()) {
      totalIncoming += usage.incoming.bytes;
      totalOutgoing += usage.outgoing.bytes;
    }
    
    return { incoming: totalIncoming, outgoing: totalOutgoing };
  }

  /**
   * Get peer count
   */
  getPeerCount() {
    return this.peers.size;
  }

  /**
   * Get connected peers
   */
  getPeers() {
    return Array.from(this.peers.values()).map(peer => ({
      id: peer.id,
      nodeId: peer.nodeId,
      address: peer.address,
      isOutgoing: peer.isOutgoing,
      connectedAt: peer.connectedAt,
      isValidated: peer.isValidated,
      latency: peer.latency,
      messagesReceived: peer.messagesReceived,
      messagesSent: peer.messagesSent
    }));
  }

  /**
   * Stop P2P network
   */
  async stop() {
    try {
      this.logger.info('Stopping P2P network...');

      // Stop optimizer
      if (this.optimizer) {
        this.optimizer.stop();
        this.optimizer = null;
      }
      
      // Stop all timers
      for (const [name, timer] of this.timers) {
        clearInterval(timer);
        this.logger.debug(`Stopped ${name} timer`);
      }
      this.timers.clear();

      // Close all peer connections
      for (const [peerId, peer] of this.peers) {
        if (peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.close();
        }
      }
      this.peers.clear();
      this.connections.clear();

      // Close server
      if (this.server) {
        await new Promise((resolve) => {
          this.server.close(resolve);
        });
        this.server = null;
      }

      this.logger.info('P2P network stopped');
      this.emit('network:stopped');

    } catch (error) {
      this.logger.error('Error stopping P2P network:', error);
    }
  }
}

export default P2PNetwork;
