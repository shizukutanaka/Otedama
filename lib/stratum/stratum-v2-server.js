/**
 * Stratum V2 Protocol Implementation
 * Next-generation mining protocol with improved efficiency and security
 */

const { EventEmitter } = require('events');
const net = require('net');
const crypto = require('crypto');
const { createLogger } = require('../core/logger');

const logger = createLogger('stratum-v2');

// Stratum V2 message types
const MessageType = {
  // Setup Connection
  SETUP_CONNECTION: 0x00,
  SETUP_CONNECTION_SUCCESS: 0x01,
  SETUP_CONNECTION_ERROR: 0x02,
  
  // Channel Management
  OPEN_STANDARD_MINING_CHANNEL: 0x10,
  OPEN_STANDARD_MINING_CHANNEL_SUCCESS: 0x11,
  OPEN_EXTENDED_MINING_CHANNEL: 0x12,
  OPEN_EXTENDED_MINING_CHANNEL_SUCCESS: 0x13,
  OPEN_MINING_CHANNEL_ERROR: 0x14,
  
  // Mining Protocol
  NEW_MINING_JOB: 0x20,
  UPDATE_CHANNEL: 0x21,
  SUBMIT_SHARES_STANDARD: 0x22,
  SUBMIT_SHARES_EXTENDED: 0x23,
  SET_NEW_PREV_HASH: 0x24,
  SET_TARGET: 0x25,
  
  // Template Distribution
  NEW_TEMPLATE: 0x30,
  SET_NEW_PREV_HASH_TEMPLATE: 0x31,
  REQUEST_TRANSACTION_DATA: 0x32,
  REQUEST_TRANSACTION_DATA_SUCCESS: 0x33,
  REQUEST_TRANSACTION_DATA_ERROR: 0x34,
  
  // Shares
  SUBMIT_SOLUTION: 0x40,
  SHARE_ACCEPTED: 0x41,
  SHARE_REJECTED: 0x42,
  
  // General
  CHANNEL_ENDPOINT_CHANGED: 0x50,
  RECONNECT: 0x51,
  SET_CUSTOM_MINING_JOB: 0x52,
  SET_CUSTOM_MINING_JOB_SUCCESS: 0x53,
  SET_CUSTOM_MINING_JOB_ERROR: 0x54
};

// Error codes
const ErrorCode = {
  UNSUPPORTED_FEATURE: 0x01,
  UNSUPPORTED_PROTOCOL: 0x02,
  PROTOCOL_VERSION_MISMATCH: 0x03,
  INVALID_CHANNEL_ID: 0x04,
  CHANNEL_LIMIT_EXCEEDED: 0x05,
  INVALID_JOB_ID: 0x06,
  STALE_SHARE: 0x07,
  INVALID_SHARE: 0x08,
  LOW_DIFFICULTY_SHARE: 0x09,
  UNAUTHORIZED: 0x0A,
  BAD_REQUEST: 0x0B
};

// Protocol features
const ProtocolFeature = {
  VERSION_ROLLING: 0x01,
  MINIMUM_DIFFICULTY: 0x02,
  SUBSCRIBE_EXTRANONCE: 0x04,
  JOB_DECLARATION: 0x08,
  ZERO_TIME: 0x10,
  END_OF_SERVICE: 0x20
};

class StratumV2Connection {
  constructor(socket, server) {
    this.socket = socket;
    this.server = server;
    this.id = crypto.randomBytes(16).toString('hex');
    this.state = 'connected';
    this.channels = new Map();
    this.features = 0;
    this.protocolVersion = 2;
    this.isNoise = false; // Noise protocol encryption
    this.buffer = Buffer.alloc(0);
    
    this.setupHandlers();
  }

  setupHandlers() {
    this.socket.on('data', (data) => this.handleData(data));
    this.socket.on('close', () => this.handleClose());
    this.socket.on('error', (err) => this.handleError(err));
  }

  handleData(data) {
    // Append to buffer
    this.buffer = Buffer.concat([this.buffer, data]);
    
    // Process complete messages
    while (this.buffer.length >= 6) { // Minimum message size
      // Read header
      const messageType = this.buffer.readUInt8(0);
      const messageLength = this.buffer.readUInt32LE(1);
      
      // Check if we have complete message
      if (this.buffer.length < messageLength + 5) {
        break;
      }
      
      // Extract message
      const messageData = this.buffer.slice(5, messageLength + 5);
      this.buffer = this.buffer.slice(messageLength + 5);
      
      // Process message
      this.processMessage(messageType, messageData);
    }
  }

  processMessage(type, data) {
    try {
      switch (type) {
        case MessageType.SETUP_CONNECTION:
          this.handleSetupConnection(data);
          break;
          
        case MessageType.OPEN_STANDARD_MINING_CHANNEL:
          this.handleOpenStandardMiningChannel(data);
          break;
          
        case MessageType.SUBMIT_SHARES_STANDARD:
          this.handleSubmitSharesStandard(data);
          break;
          
        default:
          logger.warn(`Unknown message type: 0x${type.toString(16)}`);
          this.sendError(ErrorCode.BAD_REQUEST, 'Unknown message type');
      }
    } catch (error) {
      logger.error('Error processing message:', error);
      this.sendError(ErrorCode.BAD_REQUEST, error.message);
    }
  }

  handleSetupConnection(data) {
    const message = this.parseSetupConnection(data);
    
    // Validate protocol version
    if (message.maxVersion < 2 || message.minVersion > 2) {
      this.sendSetupConnectionError(
        ErrorCode.PROTOCOL_VERSION_MISMATCH,
        'Protocol version not supported'
      );
      return;
    }
    
    // Set features
    this.features = message.features & this.server.supportedFeatures;
    this.protocolVersion = 2;
    
    // Send success
    this.sendSetupConnectionSuccess();
  }

  handleOpenStandardMiningChannel(data) {
    const message = this.parseOpenStandardMiningChannel(data);
    
    // Create channel
    const channelId = this.server.createChannel(this, {
      requestId: message.requestId,
      userIdentity: message.userIdentity,
      nominalHashRate: message.nominalHashRate,
      maxTarget: message.maxTarget
    });
    
    if (!channelId) {
      this.sendOpenMiningChannelError(
        message.requestId,
        ErrorCode.CHANNEL_LIMIT_EXCEEDED,
        'Channel limit exceeded'
      );
      return;
    }
    
    // Store channel
    this.channels.set(channelId, {
      id: channelId,
      type: 'standard',
      userIdentity: message.userIdentity,
      nominalHashRate: message.nominalHashRate,
      difficulty: 1,
      extranonce: crypto.randomBytes(4).toString('hex')
    });
    
    // Send success
    this.sendOpenStandardMiningChannelSuccess(message.requestId, channelId);
    
    // Send initial job
    this.sendNewMiningJob(channelId);
  }

  handleSubmitSharesStandard(data) {
    const message = this.parseSubmitSharesStandard(data);
    const channel = this.channels.get(message.channelId);
    
    if (!channel) {
      this.sendShareRejected(
        message.channelId,
        message.sequenceNumber,
        ErrorCode.INVALID_CHANNEL_ID
      );
      return;
    }
    
    // Validate share
    const validation = this.server.validateShare({
      channelId: message.channelId,
      sequenceNumber: message.sequenceNumber,
      jobId: message.jobId,
      nonce: message.nonce,
      ntime: message.ntime,
      version: message.version
    });
    
    if (validation.valid) {
      this.sendShareAccepted(
        message.channelId,
        message.sequenceNumber,
        validation.newSubmitsAccepted,
        validation.newSharesSum
      );
      
      // Update stats
      channel.sharesAccepted = (channel.sharesAccepted || 0) + 1;
      
      // Emit event
      this.server.emit('share:accepted', {
        connectionId: this.id,
        channelId: message.channelId,
        difficulty: channel.difficulty
      });
    } else {
      this.sendShareRejected(
        message.channelId,
        message.sequenceNumber,
        validation.errorCode || ErrorCode.INVALID_SHARE
      );
    }
  }

  // Message parsing methods

  parseSetupConnection(data) {
    let offset = 0;
    
    const minVersion = data.readUInt16LE(offset);
    offset += 2;
    
    const maxVersion = data.readUInt16LE(offset);
    offset += 2;
    
    const features = data.readUInt32LE(offset);
    offset += 4;
    
    const endpointHostLength = data.readUInt8(offset);
    offset += 1;
    
    const endpointHost = data.slice(offset, offset + endpointHostLength).toString();
    offset += endpointHostLength;
    
    const endpointPort = data.readUInt16LE(offset);
    offset += 2;
    
    return {
      minVersion,
      maxVersion,
      features,
      endpointHost,
      endpointPort
    };
  }

  parseOpenStandardMiningChannel(data) {
    let offset = 0;
    
    const requestId = data.readUInt32LE(offset);
    offset += 4;
    
    const userIdentityLength = data.readUInt8(offset);
    offset += 1;
    
    const userIdentity = data.slice(offset, offset + userIdentityLength).toString();
    offset += userIdentityLength;
    
    const nominalHashRate = data.readBigUInt64LE(offset);
    offset += 8;
    
    const maxTarget = data.slice(offset, offset + 32);
    
    return {
      requestId,
      userIdentity,
      nominalHashRate,
      maxTarget
    };
  }

  parseSubmitSharesStandard(data) {
    let offset = 0;
    
    const channelId = data.readUInt32LE(offset);
    offset += 4;
    
    const sequenceNumber = data.readUInt32LE(offset);
    offset += 4;
    
    const jobId = data.readUInt32LE(offset);
    offset += 4;
    
    const nonce = data.readUInt32LE(offset);
    offset += 4;
    
    const ntime = data.readUInt32LE(offset);
    offset += 4;
    
    const version = data.readUInt32LE(offset);
    
    return {
      channelId,
      sequenceNumber,
      jobId,
      nonce,
      ntime,
      version
    };
  }

  // Message sending methods

  sendMessage(type, data) {
    const header = Buffer.alloc(5);
    header.writeUInt8(type, 0);
    header.writeUInt32LE(data.length, 1);
    
    const message = Buffer.concat([header, data]);
    
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(message);
    }
  }

  sendSetupConnectionSuccess() {
    const data = Buffer.alloc(6);
    data.writeUInt16LE(this.protocolVersion, 0);
    data.writeUInt32LE(this.features, 2);
    
    this.sendMessage(MessageType.SETUP_CONNECTION_SUCCESS, data);
  }

  sendSetupConnectionError(code, message) {
    const messageBuffer = Buffer.from(message);
    const data = Buffer.alloc(1 + messageBuffer.length);
    data.writeUInt8(code, 0);
    messageBuffer.copy(data, 1);
    
    this.sendMessage(MessageType.SETUP_CONNECTION_ERROR, data);
  }

  sendOpenStandardMiningChannelSuccess(requestId, channelId) {
    const extranoncePrefix = crypto.randomBytes(8);
    const data = Buffer.alloc(24);
    
    data.writeUInt32LE(requestId, 0);
    data.writeUInt32LE(channelId, 4);
    data.writeUInt32LE(this.server.config.maxTarget, 8);
    extranoncePrefix.copy(data, 12);
    data.writeUInt16LE(4, 20); // extranonce size
    data.writeUInt8(1, 22); // channel opened
    
    this.sendMessage(MessageType.OPEN_STANDARD_MINING_CHANNEL_SUCCESS, data);
  }

  sendOpenMiningChannelError(requestId, code, message) {
    const messageBuffer = Buffer.from(message);
    const data = Buffer.alloc(5 + messageBuffer.length);
    
    data.writeUInt32LE(requestId, 0);
    data.writeUInt8(code, 4);
    messageBuffer.copy(data, 5);
    
    this.sendMessage(MessageType.OPEN_MINING_CHANNEL_ERROR, data);
  }

  sendNewMiningJob(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    
    const job = this.server.createJob(channelId);
    const data = Buffer.alloc(76 + job.merklePath.length * 32);
    let offset = 0;
    
    data.writeUInt32LE(channelId, offset);
    offset += 4;
    
    data.writeUInt32LE(job.jobId, offset);
    offset += 4;
    
    data.writeUInt32LE(job.futureJob ? 1 : 0, offset);
    offset += 4;
    
    data.writeUInt32LE(job.version, offset);
    offset += 4;
    
    data.writeUInt32LE(job.versionRollingAllowed ? 1 : 0, offset);
    offset += 4;
    
    Buffer.from(job.prevHash, 'hex').copy(data, offset);
    offset += 32;
    
    data.writeUInt32LE(job.minNtime, offset);
    offset += 4;
    
    data.writeUInt32LE(job.nbits, offset);
    offset += 4;
    
    data.writeUInt32LE(job.maxNtime, offset);
    offset += 4;
    
    data.writeUInt32LE(job.merklePath.length, offset);
    offset += 4;
    
    // Copy merkle path
    for (const hash of job.merklePath) {
      Buffer.from(hash, 'hex').copy(data, offset);
      offset += 32;
    }
    
    this.sendMessage(MessageType.NEW_MINING_JOB, data);
  }

  sendShareAccepted(channelId, sequenceNumber, newSubmitsAccepted, newSharesSum) {
    const data = Buffer.alloc(24);
    
    data.writeUInt32LE(channelId, 0);
    data.writeUInt32LE(sequenceNumber, 4);
    data.writeBigUInt64LE(BigInt(newSubmitsAccepted), 8);
    data.writeBigUInt64LE(BigInt(newSharesSum), 16);
    
    this.sendMessage(MessageType.SHARE_ACCEPTED, data);
  }

  sendShareRejected(channelId, sequenceNumber, errorCode) {
    const data = Buffer.alloc(9);
    
    data.writeUInt32LE(channelId, 0);
    data.writeUInt32LE(sequenceNumber, 4);
    data.writeUInt8(errorCode, 8);
    
    this.sendMessage(MessageType.SHARE_REJECTED, data);
  }

  sendSetTarget(channelId, maxTarget) {
    const data = Buffer.alloc(36);
    
    data.writeUInt32LE(channelId, 0);
    maxTarget.copy(data, 4);
    
    this.sendMessage(MessageType.SET_TARGET, data);
  }

  sendError(code, message) {
    logger.error(`Stratum V2 error: ${message} (code: ${code})`);
    // Implementation depends on context
  }

  handleClose() {
    this.state = 'closed';
    
    // Clean up channels
    for (const [channelId, channel] of this.channels) {
      this.server.removeChannel(channelId);
    }
    
    this.server.removeConnection(this.id);
    logger.info(`Connection ${this.id} closed`);
  }

  handleError(error) {
    logger.error(`Connection ${this.id} error:`, error);
    this.socket.destroy();
  }
}

class StratumV2Server extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      port: config.port || 3336,
      host: config.host || '0.0.0.0',
      maxConnections: config.maxConnections || 10000,
      maxChannelsPerConnection: config.maxChannelsPerConnection || 5,
      supportedFeatures: config.supportedFeatures || (
        ProtocolFeature.VERSION_ROLLING |
        ProtocolFeature.MINIMUM_DIFFICULTY |
        ProtocolFeature.SUBSCRIBE_EXTRANONCE
      ),
      maxTarget: config.maxTarget || 0x00000000FFFF0000,
      jobInterval: config.jobInterval || 30000,
      ...config
    };
    
    this.server = null;
    this.connections = new Map();
    this.channels = new Map();
    this.jobs = new Map();
    this.nextChannelId = 1;
    this.nextJobId = 1;
    this.currentWork = null;
    
    this.stats = {
      connectionsTotal: 0,
      connectionsActive: 0,
      channelsTotal: 0,
      channelsActive: 0,
      sharesSubmitted: 0,
      sharesAccepted: 0,
      sharesRejected: 0
    };
  }

  async start() {
    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });
    
    this.server.on('error', (err) => {
      logger.error('Server error:', err);
      this.emit('error', err);
    });
    
    await new Promise((resolve, reject) => {
      this.server.listen(this.config.port, this.config.host, () => {
        logger.info(`Stratum V2 server listening on ${this.config.host}:${this.config.port}`);
        resolve();
      });
      
      this.server.once('error', reject);
    });
    
    // Start job updates
    this.startJobUpdates();
    
    this.emit('started', {
      host: this.config.host,
      port: this.config.port
    });
  }

  handleConnection(socket) {
    const connection = new StratumV2Connection(socket, this);
    
    this.connections.set(connection.id, connection);
    this.stats.connectionsTotal++;
    this.stats.connectionsActive++;
    
    logger.info(`New Stratum V2 connection: ${connection.id}`);
    
    this.emit('connection', {
      id: connection.id,
      remoteAddress: socket.remoteAddress
    });
  }

  removeConnection(connectionId) {
    if (this.connections.delete(connectionId)) {
      this.stats.connectionsActive--;
    }
  }

  createChannel(connection, options) {
    // Check channel limit
    const connectionChannels = Array.from(this.channels.values())
      .filter(ch => ch.connectionId === connection.id).length;
    
    if (connectionChannels >= this.config.maxChannelsPerConnection) {
      return null;
    }
    
    const channelId = this.nextChannelId++;
    
    this.channels.set(channelId, {
      id: channelId,
      connectionId: connection.id,
      userIdentity: options.userIdentity,
      nominalHashRate: options.nominalHashRate,
      maxTarget: options.maxTarget,
      createdAt: Date.now(),
      sharesSubmitted: 0,
      sharesAccepted: 0
    });
    
    this.stats.channelsTotal++;
    this.stats.channelsActive++;
    
    this.emit('channel:created', {
      channelId,
      connectionId: connection.id,
      userIdentity: options.userIdentity
    });
    
    return channelId;
  }

  removeChannel(channelId) {
    if (this.channels.delete(channelId)) {
      this.stats.channelsActive--;
    }
  }

  createJob(channelId) {
    const jobId = this.nextJobId++;
    
    const job = {
      jobId,
      channelId,
      version: 0x20000000,
      prevHash: this.currentWork?.prevHash || crypto.randomBytes(32).toString('hex'),
      merklePath: this.currentWork?.merklePath || [],
      nbits: this.currentWork?.nbits || 0x1a0fffff,
      minNtime: Math.floor(Date.now() / 1000),
      maxNtime: Math.floor(Date.now() / 1000) + 7200,
      versionRollingAllowed: true,
      futureJob: false
    };
    
    this.jobs.set(jobId, job);
    
    return job;
  }

  validateShare(share) {
    const job = this.jobs.get(share.jobId);
    
    if (!job) {
      return {
        valid: false,
        errorCode: ErrorCode.INVALID_JOB_ID
      };
    }
    
    // Check if share is stale
    const currentTime = Math.floor(Date.now() / 1000);
    if (share.ntime < job.minNtime || share.ntime > currentTime + 7200) {
      return {
        valid: false,
        errorCode: ErrorCode.STALE_SHARE
      };
    }
    
    // In production, validate actual proof of work here
    const isValid = Math.random() > 0.05; // 95% valid for demo
    
    if (isValid) {
      this.stats.sharesAccepted++;
      const channel = this.channels.get(share.channelId);
      if (channel) {
        channel.sharesAccepted++;
      }
      
      return {
        valid: true,
        newSubmitsAccepted: channel?.sharesAccepted || 0,
        newSharesSum: channel?.sharesAccepted || 0
      };
    } else {
      this.stats.sharesRejected++;
      return {
        valid: false,
        errorCode: ErrorCode.LOW_DIFFICULTY_SHARE
      };
    }
  }

  updateWork(work) {
    this.currentWork = work;
    
    // Notify all channels
    for (const [connectionId, connection] of this.connections) {
      for (const [channelId, channel] of connection.channels) {
        connection.sendNewMiningJob(channelId);
      }
    }
  }

  startJobUpdates() {
    setInterval(() => {
      // Generate new work
      const work = {
        prevHash: crypto.randomBytes(32).toString('hex'),
        merklePath: [],
        nbits: 0x1a0fffff
      };
      
      this.updateWork(work);
    }, this.config.jobInterval);
  }

  getStats() {
    return {
      ...this.stats,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    };
  }

  async stop() {
    // Stop accepting new connections
    if (this.server) {
      this.server.close();
    }
    
    // Close all existing connections
    for (const [id, connection] of this.connections) {
      connection.socket.destroy();
    }
    
    this.emit('stopped');
    logger.info('Stratum V2 server stopped');
  }
}

module.exports = StratumV2Server;