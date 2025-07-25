/**
 * Stratum V2 Server - Otedama
 * Next-generation mining protocol with binary encoding and encryption
 * 
 * Design principles:
 * - Binary protocol for 10x bandwidth reduction (Carmack)
 * - NOISE protocol encryption for security (Martin)
 * - Simple API with powerful features (Pike)
 */

import { EventEmitter } from 'events';
import { createServer } from 'net';
import { randomBytes } from 'crypto';
import { NoiseState } from '../mining/stratum-v2/noise-protocol.js';
import { BinaryEncoder, BinaryDecoder } from '../mining/stratum-v2/binary-protocol.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('StratumV2Server');

// Stratum V2 message types
export const MessageType = {
  // Setup messages
  SETUP_CONNECTION: 0x00,
  SETUP_CONNECTION_SUCCESS: 0x01,
  SETUP_CONNECTION_ERROR: 0x02,
  
  // Mining protocol
  MINING_SUBSCRIBE: 0x10,
  MINING_SUBSCRIBE_SUCCESS: 0x11,
  NEW_MINING_JOB: 0x12,
  UPDATE_CHANNEL: 0x13,
  SUBMIT_SHARES_STANDARD: 0x14,
  SUBMIT_SHARES_EXTENDED: 0x15,
  
  // Job negotiation
  ALLOCATE_MINING_JOB_TOKEN: 0x20,
  ALLOCATE_MINING_JOB_TOKEN_SUCCESS: 0x21,
  COMMIT_MINING_JOB: 0x22,
  COMMIT_MINING_JOB_SUCCESS: 0x23,
  
  // Template distribution
  NEW_TEMPLATE: 0x30,
  SET_NEW_PREV_HASH: 0x31,
  REQUEST_TRANSACTION_DATA: 0x32,
  REQUEST_TRANSACTION_DATA_SUCCESS: 0x33
};

// Channel types
export const ChannelType = {
  STANDARD: 0,
  EXTENDED: 1,
  GROUP: 2
};

export class StratumV2Server extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      port: config.port || 3336,
      host: config.host || '0.0.0.0',
      maxConnections: config.maxConnections || 10000,
      
      // Protocol settings
      maxMessageSize: config.maxMessageSize || 1048576, // 1MB
      channelMsgSize: config.channelMsgSize || 4096,
      
      // Job negotiation
      enableJobNegotiation: config.enableJobNegotiation !== false,
      jobTokenExpiry: config.jobTokenExpiry || 600000, // 10 minutes
      
      // Security
      requireEncryption: config.requireEncryption !== false,
      publicKey: config.publicKey,
      privateKey: config.privateKey,
      
      ...config
    };
    
    this.server = null;
    this.connections = new Map();
    this.channels = new Map();
    this.jobTokens = new Map();
    this.currentJob = null;
    
    // Statistics
    this.stats = {
      connectionsTotal: 0,
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      bytesSent: 0,
      sharesAccepted: 0,
      sharesRejected: 0
    };
  }
  
  /**
   * Start the server
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.server = createServer();
      
      this.server.on('connection', this.handleConnection.bind(this));
      
      this.server.on('error', (error) => {
        logger.error('Server error:', error);
        reject(error);
      });
      
      this.server.listen(this.config.port, this.config.host, () => {
        logger.info(`Stratum V2 server listening on ${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
  }
  
  /**
   * Handle new connection
   */
  handleConnection(socket) {
    const connectionId = randomBytes(16).toString('hex');
    
    const connection = {
      id: connectionId,
      socket,
      state: 'connecting',
      noise: this.config.requireEncryption ? new NoiseState('responder') : null,
      encoder: new BinaryEncoder(),
      decoder: new BinaryDecoder(),
      channels: new Set(),
      authorized: false,
      worker: null,
      lastActivity: Date.now()
    };
    
    this.connections.set(connectionId, connection);
    this.stats.connectionsTotal++;
    
    // Setup socket handlers
    socket.on('data', (data) => this.handleData(connection, data));
    socket.on('error', (error) => this.handleError(connection, error));
    socket.on('close', () => this.handleClose(connection));
    
    // Send setup connection if encryption required
    if (this.config.requireEncryption) {
      this.sendSetupConnection(connection);
    } else {
      connection.state = 'connected';
    }
    
    logger.debug(`New connection from ${socket.remoteAddress}:${socket.remotePort}`);
  }
  
  /**
   * Handle incoming data
   */
  async handleData(connection, data) {
    try {
      connection.lastActivity = Date.now();
      this.stats.bytesReceived += data.length;
      
      // Decrypt if encrypted
      if (connection.noise && connection.state === 'connected') {
        data = connection.noise.decryptMessage(data);
      }
      
      // Decode messages
      connection.decoder.push(data);
      
      let message;
      while ((message = connection.decoder.nextMessage()) !== null) {
        this.stats.messagesReceived++;
        await this.handleMessage(connection, message);
      }
      
    } catch (error) {
      logger.error('Error handling data:', error);
      this.closeConnection(connection, 'Protocol error');
    }
  }
  
  /**
   * Handle decoded message
   */
  async handleMessage(connection, message) {
    const { type, payload } = message;
    
    switch (type) {
      case MessageType.SETUP_CONNECTION:
        await this.handleSetupConnection(connection, payload);
        break;
        
      case MessageType.MINING_SUBSCRIBE:
        await this.handleMiningSubscribe(connection, payload);
        break;
        
      case MessageType.SUBMIT_SHARES_STANDARD:
        await this.handleSubmitShares(connection, payload, 'standard');
        break;
        
      case MessageType.SUBMIT_SHARES_EXTENDED:
        await this.handleSubmitShares(connection, payload, 'extended');
        break;
        
      case MessageType.ALLOCATE_MINING_JOB_TOKEN:
        await this.handleAllocateJobToken(connection, payload);
        break;
        
      case MessageType.COMMIT_MINING_JOB:
        await this.handleCommitJob(connection, payload);
        break;
        
      default:
        logger.warn(`Unknown message type: ${type}`);
    }
  }
  
  /**
   * Handle setup connection (NOISE handshake)
   */
  async handleSetupConnection(connection, payload) {
    try {
      // Complete NOISE handshake
      const response = connection.noise.processHandshake(payload);
      
      if (connection.noise.isHandshakeComplete()) {
        connection.state = 'connected';
        
        this.sendMessage(connection, MessageType.SETUP_CONNECTION_SUCCESS, {
          flags: 0,
          version: 2
        });
        
        logger.debug(`Connection ${connection.id} encrypted`);
      } else {
        // Send next handshake message
        connection.socket.write(response);
      }
      
    } catch (error) {
      logger.error('Setup connection error:', error);
      this.sendMessage(connection, MessageType.SETUP_CONNECTION_ERROR, {
        flags: 0,
        errorCode: 'ENCRYPTION_FAILED'
      });
      this.closeConnection(connection);
    }
  }
  
  /**
   * Handle mining subscribe
   */
  async handleMiningSubscribe(connection, payload) {
    const { version, userAgent, extranonce1Size = 4 } = payload;
    
    // Create channel
    const channelId = this.createChannel(connection, {
      type: ChannelType.STANDARD,
      target: payload.target || this.calculateDefaultTarget(),
      extranonce2Size: payload.extranonce2Size || 4
    });
    
    // Generate extranonce1
    const extranonce1 = randomBytes(extranonce1Size);
    
    connection.worker = {
      userAgent,
      extranonce1,
      channels: [channelId]
    };
    
    connection.authorized = true;
    
    // Send success response
    this.sendMessage(connection, MessageType.MINING_SUBSCRIBE_SUCCESS, {
      flags: 0,
      channelId,
      target: this.channels.get(channelId).target,
      extranonce1,
      extranonce2Size: 4
    });
    
    // Send initial job
    if (this.currentJob) {
      this.sendNewJob(connection, channelId);
    }
    
    logger.info(`Miner subscribed: ${userAgent}`);
    
    this.emit('miner:subscribed', {
      connectionId: connection.id,
      userAgent,
      channelId
    });
  }
  
  /**
   * Handle share submission
   */
  async handleSubmitShares(connection, payload, type) {
    const { channelId, jobId, nonce, time, version, extranonce2 } = payload;
    
    const channel = this.channels.get(channelId);
    if (!channel || !channel.connections.has(connection.id)) {
      logger.warn('Invalid channel for share submission');
      return;
    }
    
    // Prepare share for validation
    const share = {
      jobId,
      nonce: nonce.toString('hex'),
      ntime: time.toString(16),
      version: version.toString(16),
      extraNonce1: connection.worker.extranonce1.toString('hex'),
      extraNonce2: extranonce2.toString('hex'),
      type
    };
    
    // Emit for validation
    this.emit('share:submitted', {
      connectionId: connection.id,
      channelId,
      share,
      difficulty: this.targetToDifficulty(channel.target)
    });
    
    // Update stats (actual validation happens in pool)
    this.stats.sharesAccepted++; // This should be updated based on validation result
    
    // Update channel if extended share
    if (type === 'extended' && this.config.enableJobNegotiation) {
      this.sendMessage(connection, MessageType.UPDATE_CHANNEL, {
        channelId,
        nominalHashRate: payload.nominalHashRate,
        maximumHashRate: payload.maximumHashRate
      });
    }
  }
  
  /**
   * Handle job token allocation
   */
  async handleAllocateJobToken(connection, payload) {
    if (!this.config.enableJobNegotiation) {
      return;
    }
    
    const { userData, coinbase1Size, coinbase2Size, futureJob } = payload;
    
    // Generate job token
    const token = randomBytes(32);
    const tokenData = {
      connectionId: connection.id,
      userData,
      coinbase1Size,
      coinbase2Size,
      futureJob,
      createdAt: Date.now()
    };
    
    this.jobTokens.set(token.toString('hex'), tokenData);
    
    // Cleanup expired tokens
    setTimeout(() => {
      this.jobTokens.delete(token.toString('hex'));
    }, this.config.jobTokenExpiry);
    
    this.sendMessage(connection, MessageType.ALLOCATE_MINING_JOB_TOKEN_SUCCESS, {
      token,
      miningJobTokenValidity: Math.floor(this.config.jobTokenExpiry / 1000)
    });
  }
  
  /**
   * Handle job commit
   */
  async handleCommitJob(connection, payload) {
    const { token, version, coinbasePrefix, coinbaseSuffix } = payload;
    
    const tokenData = this.jobTokens.get(token.toString('hex'));
    if (!tokenData || tokenData.connectionId !== connection.id) {
      logger.warn('Invalid job token');
      return;
    }
    
    // Create negotiated job
    const job = {
      version,
      coinbasePrefix,
      coinbaseSuffix,
      ...tokenData
    };
    
    // Create extended channel
    const newChannelId = this.createChannel(connection, {
      type: ChannelType.EXTENDED,
      negotiated: true,
      target: this.calculateDefaultTarget()
    });
    
    // Emit for validation
    this.emit('job:committed', {
      connectionId: connection.id,
      channelId: newChannelId,
      job
    });
    
    this.sendMessage(connection, MessageType.COMMIT_MINING_JOB_SUCCESS, {
      newChannelId
    });
    
    // Remove used token
    this.jobTokens.delete(token.toString('hex'));
  }
  
  /**
   * Send new job to miner
   */
  sendNewJob(connection, channelId) {
    const channel = this.channels.get(channelId);
    if (!channel || !this.currentJob) return;
    
    this.sendMessage(connection, MessageType.NEW_MINING_JOB, {
      channelId,
      jobId: parseInt(this.currentJob.jobId, 16),
      futureJob: false,
      version: parseInt(this.currentJob.version, 16),
      versionRollingAllowed: true,
      prevHash: Buffer.from(this.currentJob.prevHash, 'hex'),
      coinbase1: Buffer.from(this.currentJob.coinbase1, 'hex'),
      coinbase2: Buffer.from(this.currentJob.coinbase2, 'hex'),
      merkleRoot: Buffer.from(this.currentJob.merkleRoot || '', 'hex'),
      time: parseInt(this.currentJob.ntime, 16),
      bits: parseInt(this.currentJob.nbits, 16),
      target: channel.target
    });
  }
  
  /**
   * Broadcast new job to all miners
   */
  broadcastNewJob(job) {
    this.currentJob = job;
    
    for (const [connectionId, connection] of this.connections) {
      if (connection.authorized && connection.worker) {
        for (const channelId of connection.worker.channels) {
          this.sendNewJob(connection, channelId);
        }
      }
    }
  }
  
  /**
   * Send message to connection
   */
  sendMessage(connection, type, payload) {
    try {
      const encoded = connection.encoder.encode(type, payload);
      
      // Encrypt if needed
      let data = encoded;
      if (connection.noise && connection.state === 'connected') {
        data = connection.noise.encryptMessage(encoded);
      }
      
      connection.socket.write(data);
      
      this.stats.messagesSent++;
      this.stats.bytesSent += data.length;
      
    } catch (error) {
      logger.error('Error sending message:', error);
    }
  }
  
  /**
   * Create mining channel
   */
  createChannel(connection, options) {
    const channelId = randomBytes(4).readUInt32LE(0);
    
    const channel = {
      id: channelId,
      type: options.type,
      target: options.target,
      connections: new Set([connection.id]),
      createdAt: Date.now(),
      ...options
    };
    
    this.channels.set(channelId, channel);
    connection.channels.add(channelId);
    
    return channelId;
  }
  
  /**
   * Calculate default target
   */
  calculateDefaultTarget() {
    // Default difficulty 1 target
    return BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
  }
  
  /**
   * Convert target to difficulty
   */
  targetToDifficulty(target) {
    const maxTarget = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
    return Number(maxTarget / BigInt(target));
  }
  
  /**
   * Initialize NOISE handshake
   */
  sendSetupConnection(connection) {
    const handshakeMessage = connection.noise.startHandshake();
    connection.socket.write(handshakeMessage);
  }
  
  /**
   * Handle connection error
   */
  handleError(connection, error) {
    logger.error(`Connection ${connection.id} error:`, error);
    this.closeConnection(connection);
  }
  
  /**
   * Handle connection close
   */
  handleClose(connection) {
    logger.debug(`Connection ${connection.id} closed`);
    this.closeConnection(connection);
  }
  
  /**
   * Close connection
   */
  closeConnection(connection, reason) {
    if (!connection) return;
    
    // Remove from channels
    for (const channelId of connection.channels) {
      const channel = this.channels.get(channelId);
      if (channel) {
        channel.connections.delete(connection.id);
        if (channel.connections.size === 0) {
          this.channels.delete(channelId);
        }
      }
    }
    
    // Close socket
    if (connection.socket && !connection.socket.destroyed) {
      connection.socket.destroy();
    }
    
    // Remove connection
    this.connections.delete(connection.id);
    
    this.emit('connection:closed', {
      connectionId: connection.id,
      reason
    });
  }
  
  async disconnectClient(clientId) {
    const connection = this.connections.get(clientId);
    if (connection) {
      this.closeConnection(connection, 'Disconnected by server');
    }
  }
  
  async broadcast(message, excludeId = null) {
    for (const [connectionId, connection] of this.connections) {
      if (connectionId !== excludeId && connection.authorized) {
        this.sendMessage(connection, message.type, message.payload);
      }
    }
  }
  
  /**
   * Stop the server
   */
  async stop() {
    logger.info('Stopping Stratum V2 server...');
    
    // Close all connections
    for (const connection of this.connections.values()) {
      this.closeConnection(connection, 'Server shutdown');
    }
    
    // Close server
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
    }
    
    logger.info('Stratum V2 server stopped');
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeConnections: this.connections.size,
      activeChannels: this.channels.size,
      pendingJobTokens: this.jobTokens.size
    };
  }
}

export default StratumV2Server;
