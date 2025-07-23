/**
 * Binary Network Adapter
 * Network communication layer using the binary protocol
 */

const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');
const { BinaryProtocol, MessageTypes } = require('./binary-protocol');
const { BaseService } = require('../common/base-service');
const crypto = require('crypto');

class BinaryNetworkAdapter extends BaseService {
  constructor(options = {}) {
    super('BinaryNetworkAdapter', {
      // Network configuration
      host: options.host || '0.0.0.0',
      port: options.port || 3333,
      secure: options.secure || false,
      
      // TLS options
      tlsOptions: options.tlsOptions || {},
      
      // Connection management
      maxConnections: options.maxConnections || 1000,
      connectionTimeout: options.connectionTimeout || 30000,
      keepAliveInterval: options.keepAliveInterval || 60000,
      
      // Protocol options
      protocolOptions: options.protocolOptions || {},
      
      // Backpressure
      highWaterMark: options.highWaterMark || 16384,
      pauseOnHighWater: options.pauseOnHighWater !== false,
      
      ...options
    });
    
    // Protocol instance
    this.protocol = new BinaryProtocol(this.config.protocolOptions);
    
    // Connection management
    this.connections = new Map();
    this.server = null;
    
    // Message routing
    this.messageHandlers = new Map();
    
    // Statistics
    this.networkStats = {
      connectionsAccepted: 0,
      connectionsRejected: 0,
      activeConnections: 0,
      totalBytesIn: 0,
      totalBytesOut: 0,
      messagesIn: 0,
      messagesOut: 0,
      errors: 0
    };
  }
  
  /**
   * Initialize the network adapter
   */
  async onInitialize() {
    // Initialize protocol
    await this.protocol.initialize();
    
    // Setup protocol handlers
    this.setupProtocolHandlers();
    
    // Start keep-alive timer
    this.startTimer('keepAlive', 
      () => this.sendKeepAlives(), 
      this.config.keepAliveInterval
    );
  }
  
  /**
   * Start server
   */
  async startServer() {
    return new Promise((resolve, reject) => {
      // Create server
      if (this.config.secure) {
        this.server = tls.createServer(this.config.tlsOptions);
      } else {
        this.server = net.createServer();
      }
      
      // Server event handlers
      this.server.on('connection', this.handleConnection.bind(this));
      this.server.on('error', this.handleServerError.bind(this));
      this.server.on('close', () => {
        this.logger.info('Server closed');
        this.emit('server:closed');
      });
      
      // Set max connections
      this.server.maxConnections = this.config.maxConnections;
      
      // Start listening
      this.server.listen(this.config.port, this.config.host, () => {
        this.logger.info(`Binary server listening on ${this.config.host}:${this.config.port}`);
        this.emit('server:listening', {
          host: this.config.host,
          port: this.config.port,
          secure: this.config.secure
        });
        resolve();
      });
      
      this.server.on('error', reject);
    });
  }
  
  /**
   * Connect to a remote server
   */
  async connect(host, port, options = {}) {
    return new Promise((resolve, reject) => {
      const connectionId = crypto.randomBytes(16).toString('hex');
      
      // Create socket
      let socket;
      if (options.secure || this.config.secure) {
        socket = tls.connect(port, host, {
          ...this.config.tlsOptions,
          ...options.tlsOptions
        });
      } else {
        socket = net.createConnection(port, host);
      }
      
      // Set timeout
      socket.setTimeout(this.config.connectionTimeout);
      
      // Handle connection
      socket.once('connect', () => {
        this.logger.info(`Connected to ${host}:${port}`);
        
        // Setup connection
        const connection = this.setupConnection(socket, connectionId, 'client');
        
        // Send handshake
        this.sendHandshake(connection)
          .then(() => resolve(connection))
          .catch(reject);
      });
      
      socket.once('error', reject);
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      });
    });
  }
  
  /**
   * Handle incoming connection
   */
  handleConnection(socket) {
    const connectionId = crypto.randomBytes(16).toString('hex');
    const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    
    this.logger.info(`New connection from ${remoteAddress}`);
    
    // Check connection limit
    if (this.connections.size >= this.config.maxConnections) {
      this.logger.warn(`Connection limit reached, rejecting ${remoteAddress}`);
      socket.end();
      this.networkStats.connectionsRejected++;
      return;
    }
    
    // Setup connection
    const connection = this.setupConnection(socket, connectionId, 'server');
    
    this.networkStats.connectionsAccepted++;
    this.emit('connection:accepted', {
      connectionId,
      remoteAddress
    });
  }
  
  /**
   * Setup connection handling
   */
  setupConnection(socket, connectionId, role) {
    const connection = {
      id: connectionId,
      socket,
      role,
      state: 'connecting',
      remoteAddress: `${socket.remoteAddress}:${socket.remotePort}`,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      authenticated: false,
      metadata: {},
      stats: {
        bytesIn: 0,
        bytesOut: 0,
        messagesIn: 0,
        messagesOut: 0
      }
    };
    
    // Create protocol streams
    const encoder = this.protocol.createEncoder();
    const decoder = this.protocol.createDecoder();
    
    // Setup pipeline
    encoder.pipe(socket);
    socket.pipe(decoder);
    
    // Handle decoded messages
    decoder.on('data', (message) => {
      this.handleMessage(connection, message);
    });
    
    // Socket event handlers
    socket.on('data', (data) => {
      connection.stats.bytesIn += data.length;
      this.networkStats.totalBytesIn += data.length;
      connection.lastActivity = Date.now();
    });
    
    socket.on('drain', () => {
      this.emit('connection:drain', connectionId);
    });
    
    socket.on('error', (error) => {
      this.handleConnectionError(connection, error);
    });
    
    socket.on('close', (hadError) => {
      this.handleConnectionClose(connection, hadError);
    });
    
    socket.on('timeout', () => {
      this.logger.warn(`Connection ${connectionId} timed out`);
      socket.destroy();
    });
    
    // Backpressure handling
    if (this.config.pauseOnHighWater) {
      encoder.on('drain', () => {
        if (socket.isPaused()) {
          socket.resume();
        }
      });
    }
    
    // Store connection
    connection.encoder = encoder;
    connection.decoder = decoder;
    this.connections.set(connectionId, connection);
    this.networkStats.activeConnections = this.connections.size;
    
    return connection;
  }
  
  /**
   * Send handshake message
   */
  async sendHandshake(connection) {
    const handshakeData = {
      version: this.protocol.config.version,
      clientId: connection.id,
      timestamp: Date.now(),
      capabilities: this.getCapabilities(),
      userAgent: 'Otedama/2.0'
    };
    
    await this.sendMessage(connection, MessageTypes.HANDSHAKE, handshakeData);
    connection.state = 'handshaking';
  }
  
  /**
   * Handle incoming message
   */
  async handleMessage(connection, message) {
    try {
      connection.stats.messagesIn++;
      this.networkStats.messagesIn++;
      connection.lastActivity = Date.now();
      
      // Handle system messages
      switch (message.type) {
        case MessageTypes.HANDSHAKE:
          await this.handleHandshake(connection, message.data);
          break;
          
        case MessageTypes.HEARTBEAT:
          await this.handleHeartbeat(connection, message.data);
          break;
          
        case MessageTypes.ACK:
          this.handleAck(connection, message.data);
          break;
          
        case MessageTypes.ERROR:
          this.handleError(connection, message.data);
          break;
          
        default:
          // Route to registered handlers
          await this.routeMessage(connection, message);
      }
      
    } catch (error) {
      this.logger.error(`Error handling message from ${connection.id}:`, error);
      this.networkStats.errors++;
      
      // Send error response
      await this.sendError(connection, error.message);
    }
  }
  
  /**
   * Handle handshake
   */
  async handleHandshake(connection, data) {
    this.logger.info(`Handshake from ${connection.id}:`, data);
    
    // Validate version
    if (data.version !== this.protocol.config.version) {
      throw new Error(`Protocol version mismatch: expected ${this.protocol.config.version}, got ${data.version}`);
    }
    
    // Update connection state
    connection.state = 'connected';
    connection.authenticated = true;
    connection.metadata = {
      ...connection.metadata,
      clientId: data.clientId,
      userAgent: data.userAgent,
      capabilities: data.capabilities
    };
    
    // Send ACK if we're the server
    if (connection.role === 'server') {
      await this.sendMessage(connection, MessageTypes.ACK, {
        messageId: data.messageId,
        timestamp: Date.now()
      });
    }
    
    this.emit('connection:ready', {
      connectionId: connection.id,
      metadata: connection.metadata
    });
  }
  
  /**
   * Handle heartbeat
   */
  async handleHeartbeat(connection, data) {
    // Send heartbeat response
    await this.sendMessage(connection, MessageTypes.HEARTBEAT, {
      timestamp: Date.now(),
      echo: data
    });
  }
  
  /**
   * Handle acknowledgment
   */
  handleAck(connection, data) {
    this.emit('message:ack', {
      connectionId: connection.id,
      messageId: data.messageId
    });
  }
  
  /**
   * Handle error message
   */
  handleError(connection, data) {
    this.logger.error(`Error from ${connection.id}:`, data);
    this.emit('connection:error', {
      connectionId: connection.id,
      error: data
    });
  }
  
  /**
   * Route message to handlers
   */
  async routeMessage(connection, message) {
    const handlers = this.messageHandlers.get(message.type) || [];
    
    if (handlers.length === 0) {
      this.logger.warn(`No handlers for message type: ${message.type}`);
      return;
    }
    
    // Execute handlers
    for (const handler of handlers) {
      try {
        await handler(connection, message.data, message.metadata);
      } catch (error) {
        this.logger.error(`Handler error for message type ${message.type}:`, error);
        this.recordFailure(error);
      }
    }
  }
  
  /**
   * Send message to connection
   */
  async sendMessage(connection, messageType, data, options = {}) {
    if (!connection || connection.state !== 'connected' && messageType !== MessageTypes.HANDSHAKE) {
      throw new Error('Connection not ready');
    }
    
    try {
      // Check backpressure
      if (this.config.pauseOnHighWater && connection.encoder.writableLength > this.config.highWaterMark) {
        await new Promise(resolve => connection.encoder.once('drain', resolve));
      }
      
      // Send through encoder
      const messageId = crypto.randomBytes(8);
      connection.encoder.write({
        type: messageType,
        data: {
          ...data,
          messageId: options.messageId || messageId
        }
      });
      
      // Update stats
      connection.stats.messagesOut++;
      this.networkStats.messagesOut++;
      
      // Track bytes (estimate)
      const estimatedSize = JSON.stringify(data).length;
      connection.stats.bytesOut += estimatedSize;
      this.networkStats.totalBytesOut += estimatedSize;
      
      return messageId;
      
    } catch (error) {
      this.logger.error(`Error sending message to ${connection.id}:`, error);
      throw error;
    }
  }
  
  /**
   * Send error message
   */
  async sendError(connection, errorMessage) {
    try {
      await this.sendMessage(connection, MessageTypes.ERROR, {
        error: errorMessage,
        timestamp: Date.now()
      });
    } catch (error) {
      this.logger.error('Failed to send error message:', error);
    }
  }
  
  /**
   * Broadcast message to all connections
   */
  async broadcast(messageType, data, filter = () => true) {
    const connections = Array.from(this.connections.values())
      .filter(conn => conn.state === 'connected' && conn.authenticated && filter(conn));
    
    const results = await Promise.allSettled(
      connections.map(conn => this.sendMessage(conn, messageType, data))
    );
    
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    return {
      successful,
      failed,
      total: connections.length
    };
  }
  
  /**
   * Send keep-alive messages
   */
  async sendKeepAlives() {
    const now = Date.now();
    const timeout = this.config.keepAliveInterval * 2;
    
    for (const connection of this.connections.values()) {
      if (connection.state !== 'connected') continue;
      
      // Check for stale connections
      if (now - connection.lastActivity > timeout) {
        this.logger.warn(`Connection ${connection.id} is stale, closing`);
        connection.socket.destroy();
        continue;
      }
      
      // Send heartbeat
      try {
        await this.sendMessage(connection, MessageTypes.HEARTBEAT, {
          timestamp: now
        });
      } catch (error) {
        this.logger.error(`Failed to send heartbeat to ${connection.id}:`, error);
      }
    }
  }
  
  /**
   * Handle connection error
   */
  handleConnectionError(connection, error) {
    this.logger.error(`Connection error for ${connection.id}:`, error);
    this.networkStats.errors++;
    
    this.emit('connection:error', {
      connectionId: connection.id,
      error: error.message
    });
  }
  
  /**
   * Handle connection close
   */
  handleConnectionClose(connection, hadError) {
    this.logger.info(`Connection ${connection.id} closed${hadError ? ' with error' : ''}`);
    
    // Clean up
    connection.state = 'closed';
    connection.encoder.destroy();
    connection.decoder.destroy();
    
    this.connections.delete(connection.id);
    this.networkStats.activeConnections = this.connections.size;
    
    this.emit('connection:closed', {
      connectionId: connection.id,
      hadError,
      duration: Date.now() - connection.createdAt,
      stats: connection.stats
    });
  }
  
  /**
   * Register message handler
   */
  on(messageType, handler) {
    if (!this.messageHandlers.has(messageType)) {
      this.messageHandlers.set(messageType, []);
    }
    
    this.messageHandlers.get(messageType).push(handler);
    return this;
  }
  
  /**
   * Remove message handler
   */
  off(messageType, handler) {
    if (this.messageHandlers.has(messageType)) {
      const handlers = this.messageHandlers.get(messageType);
      const index = handlers.indexOf(handler);
      
      if (index !== -1) {
        handlers.splice(index, 1);
      }
      
      if (handlers.length === 0) {
        this.messageHandlers.delete(messageType);
      }
    }
    
    return this;
  }
  
  /**
   * Get capabilities bitmap
   */
  getCapabilities() {
    let capabilities = 0;
    
    if (this.config.secure) capabilities |= 0x01;
    if (this.protocol.config.enableCompression) capabilities |= 0x02;
    if (this.protocol.config.enableEncryption) capabilities |= 0x04;
    
    return capabilities;
  }
  
  /**
   * Close connection
   */
  closeConnection(connectionId) {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.socket.end();
    }
  }
  
  /**
   * Get connection by ID
   */
  getConnection(connectionId) {
    return this.connections.get(connectionId);
  }
  
  /**
   * Get all connections
   */
  getAllConnections() {
    return Array.from(this.connections.values());
  }
  
  /**
   * Handle server error
   */
  handleServerError(error) {
    this.logger.error('Server error:', error);
    this.emit('server:error', error);
  }
  
  /**
   * Stop server
   */
  async stopServer() {
    if (!this.server) return;
    
    return new Promise((resolve) => {
      // Close all connections
      for (const connection of this.connections.values()) {
        connection.socket.end();
      }
      
      // Close server
      this.server.close(() => {
        this.logger.info('Server stopped');
        resolve();
      });
    });
  }
  
  /**
   * Get statistics
   */
  async getStats() {
    const baseStats = await super.getStats();
    const protocolStats = await this.protocol.getStats();
    
    return {
      ...baseStats,
      network: {
        ...this.networkStats,
        connections: Array.from(this.connections.values()).map(conn => ({
          id: conn.id,
          role: conn.role,
          state: conn.state,
          remoteAddress: conn.remoteAddress,
          authenticated: conn.authenticated,
          uptime: Date.now() - conn.createdAt,
          stats: conn.stats
        }))
      },
      protocol: protocolStats.protocol
    };
  }
  
  /**
   * Health check
   */
  async onHealthCheck() {
    const serverListening = this.server && this.server.listening;
    const connectionsHealthy = this.connections.size < this.config.maxConnections * 0.9;
    
    return {
      serverListening,
      connectionsHealthy,
      activeConnections: this.connections.size,
      maxConnections: this.config.maxConnections
    };
  }
  
  /**
   * Cleanup on shutdown
   */
  async onShutdown() {
    // Stop server
    await this.stopServer();
    
    // Shutdown protocol
    await this.protocol.shutdown();
    
    // Clear handlers
    this.messageHandlers.clear();
    
    await super.onShutdown();
  }
}

// Specialized adapters

class BinaryStratumAdapter extends BinaryNetworkAdapter {
  constructor(options = {}) {
    super({
      ...options,
      port: options.port || 3333
    });
    
    // Register Stratum message handlers
    this.setupStratumHandlers();
  }
  
  setupStratumHandlers() {
    // Mining messages
    this.on(MessageTypes.WORK_REQUEST, this.handleWorkRequest.bind(this));
    this.on(MessageTypes.SHARE_SUBMIT, this.handleShareSubmit.bind(this));
    
    // Pool messages
    this.on(MessageTypes.MINER_CONNECT, this.handleMinerConnect.bind(this));
    this.on(MessageTypes.STATS_REQUEST, this.handleStatsRequest.bind(this));
  }
  
  async handleWorkRequest(connection, data) {
    // Emit event for pool to handle
    this.emit('work:request', {
      connectionId: connection.id,
      workerId: data.workerId
    });
  }
  
  async handleShareSubmit(connection, data) {
    // Emit event for pool to handle
    this.emit('share:submit', {
      connectionId: connection.id,
      share: data
    });
  }
  
  async handleMinerConnect(connection, data) {
    // Emit event for pool to handle
    this.emit('miner:connect', {
      connectionId: connection.id,
      minerInfo: data
    });
  }
  
  async handleStatsRequest(connection, data) {
    // Emit event for pool to handle
    this.emit('stats:request', {
      connectionId: connection.id,
      query: data
    });
  }
  
  // Stratum-specific methods
  async sendWork(connectionId, work) {
    const connection = this.getConnection(connectionId);
    if (!connection) throw new Error('Connection not found');
    
    return this.sendMessage(connection, MessageTypes.WORK_RESPONSE, work);
  }
  
  async sendDifficulty(connectionId, difficulty) {
    const connection = this.getConnection(connectionId);
    if (!connection) throw new Error('Connection not found');
    
    return this.sendMessage(connection, MessageTypes.DIFFICULTY_UPDATE, {
      difficulty,
      timestamp: Date.now()
    });
  }
  
  async notifyBlock(block) {
    return this.broadcast(MessageTypes.BLOCK_NOTIFY, block);
  }
  
  async notifyPayment(payment) {
    const connection = this.connections.get(payment.connectionId);
    if (!connection) return;
    
    return this.sendMessage(connection, MessageTypes.PAYMENT_NOTIFY, payment);
  }
}

module.exports = {
  BinaryNetworkAdapter,
  BinaryStratumAdapter
};