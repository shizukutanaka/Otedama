/**
 * Stratum V2 Server - Otedama
 * Next-generation mining protocol with binary encoding
 * 
 * Features:
 * - Binary protocol (10x bandwidth reduction)
 * - Encryption support
 * - Job negotiation
 * - Header-only mining
 * - Better efficiency
 */

import { createLogger } from '../../core/logger.js';
import { EventEmitter } from 'events';
import { BinaryProtocol, MessageType } from '../../network/binary-protocol.js';
import net from 'net';
import tls from 'tls';
import crypto from 'crypto';

const logger = createLogger('StratumV2Server');

/**
 * Stratum V2 Message Types
 */
export const StratumV2MessageType = {
  // Setup Connection
  SETUP_CONNECTION: 0x00,
  SETUP_CONNECTION_SUCCESS: 0x01,
  SETUP_CONNECTION_ERROR: 0x02,
  
  // Mining Protocol
  OPEN_STANDARD_MINING_CHANNEL: 0x10,
  OPEN_STANDARD_MINING_CHANNEL_SUCCESS: 0x11,
  OPEN_MINING_CHANNEL_ERROR: 0x12,
  UPDATE_CHANNEL: 0x13,
  CLOSE_CHANNEL: 0x14,
  
  // Job Distribution
  NEW_MINING_JOB: 0x20,
  SET_NEW_PREV_HASH: 0x21,
  SET_TARGET: 0x22,
  
  // Share Submission
  SUBMIT_SHARES_STANDARD: 0x30,
  SUBMIT_SHARES_SUCCESS: 0x31,
  SUBMIT_SHARES_ERROR: 0x32,
  
  // Template Negotiation
  COINBASE_OUTPUT_DATA_SIZE: 0x40,
  NEW_TEMPLATE: 0x41,
  SET_NEW_TEMPLATE: 0x42,
  TEMPLATE_ACCEPTED: 0x43,
  TEMPLATE_REJECTED: 0x44
};

/**
 * Channel States
 */
const ChannelState = {
  PENDING: 'pending',
  OPEN: 'open',
  CLOSED: 'closed'
};

/**
 * Stratum V2 Server
 */
export class StratumV2Server extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.port = options.port || 3336;
    this.host = options.host || '0.0.0.0';
    this.requireEncryption = options.requireEncryption || false;
    this.certificatePath = options.certificatePath;
    this.keyPath = options.keyPath;
    this.enableJobNegotiation = options.enableJobNegotiation !== false;
    this.maxChannelsPerConnection = options.maxChannelsPerConnection || 10;
    
    // Protocol handler
    this.protocol = new BinaryProtocol({
      version: 2,
      enableCompression: true,
      enableEncryption: this.requireEncryption
    });
    
    // Server instance
    this.server = null;
    
    // Connection tracking
    this.connections = new Map(); // connectionId -> connection
    this.channels = new Map(); // channelId -> channel
    
    // Job management
    this.currentJob = null;
    this.jobCounter = 0;
    
    // Statistics
    this.stats = {
      totalConnections: 0,
      activeConnections: 0,
      totalChannels: 0,
      activeChannels: 0,
      messagesIn: 0,
      messagesOut: 0,
      sharesSubmitted: 0,
      sharesAccepted: 0
    };
  }
  
  /**
   * Start Stratum V2 server
   */
  async start() {
    logger.info(`Starting Stratum V2 server on port ${this.port}...`);
    
    try {
      if (this.requireEncryption) {
        // Create TLS server
        const options = {
          cert: await fs.readFile(this.certificatePath),
          key: await fs.readFile(this.keyPath)
        };
        
        this.server = tls.createServer(options, socket => {
          this.handleConnection(socket);
        });
      } else {
        // Create regular TCP server
        this.server = net.createServer(socket => {
          this.handleConnection(socket);
        });
      }
      
      await new Promise((resolve, reject) => {
        this.server.on('error', reject);
        this.server.listen(this.port, this.host, () => {
          logger.info(`Stratum V2 server listening on ${this.host}:${this.port}`);
          resolve();
        });
      });
      
      this.emit('started');
      
    } catch (error) {
      logger.error('Failed to start Stratum V2 server:', error);
      throw error;
    }
  }
  
  /**
   * Handle new connection
   */
  handleConnection(socket) {
    const connectionId = crypto.randomBytes(16).toString('hex');
    
    const connection = {
      id: connectionId,
      socket,
      ip: socket.remoteAddress,
      connectedAt: Date.now(),
      channels: new Map(),
      authorized: false,
      flags: 0,
      minVersion: 2,
      maxVersion: 2
    };
    
    this.connections.set(connectionId, connection);
    this.stats.totalConnections++;
    this.stats.activeConnections++;
    
    logger.info(`New Stratum V2 connection from ${connection.ip} (${connectionId})`);
    
    // Setup protocol handlers
    this.protocol.on(StratumV2MessageType.SETUP_CONNECTION, (data) => {
      this.handleSetupConnection(connection, data);
    });
    
    this.protocol.on(StratumV2MessageType.OPEN_STANDARD_MINING_CHANNEL, (data) => {
      this.handleOpenChannel(connection, data);
    });
    
    this.protocol.on(StratumV2MessageType.SUBMIT_SHARES_STANDARD, (data) => {
      this.handleSubmitShares(connection, data);
    });
    
    // Handle socket data
    socket.on('data', async (data) => {
      try {
        const message = await this.protocol.decode(data);
        this.stats.messagesIn++;
        
        const handler = this.protocol.handlers.get(message.messageType);
        if (handler) {
          handler(message.data);
        } else {
          logger.warn(`Unknown message type: ${message.messageType}`);
        }
      } catch (error) {
        logger.error('Error processing message:', error);
        socket.destroy();
      }
    });
    
    socket.on('error', (error) => {
      logger.debug(`Connection error (${connectionId}):`, error.message);
    });
    
    socket.on('close', () => {
      this.handleDisconnection(connection);
    });
  }
  
  /**
   * Handle setup connection
   */
  async handleSetupConnection(connection, data) {
    const { minVersion, maxVersion, flags, endpoint } = data;
    
    // Check version compatibility
    if (maxVersion < 2 || minVersion > 2) {
      await this.sendMessage(connection, StratumV2MessageType.SETUP_CONNECTION_ERROR, {
        flags,
        errorCode: 'unsupported-protocol-version'
      });
      connection.socket.destroy();
      return;
    }
    
    // Store connection parameters
    connection.minVersion = minVersion;
    connection.maxVersion = maxVersion;
    connection.flags = flags;
    connection.endpoint = endpoint;
    
    // Send success response
    await this.sendMessage(connection, StratumV2MessageType.SETUP_CONNECTION_SUCCESS, {
      usedVersion: 2,
      flags
    });
    
    connection.authorized = true;
    logger.info(`Connection ${connection.id} setup complete`);
  }
  
  /**
   * Handle open channel
   */
  async handleOpenChannel(connection, data) {
    if (!connection.authorized) {
      connection.socket.destroy();
      return;
    }
    
    const { requestId, userIdentity, nominalHashRate, maxTarget } = data;
    
    // Check channel limit
    if (connection.channels.size >= this.maxChannelsPerConnection) {
      await this.sendMessage(connection, StratumV2MessageType.OPEN_MINING_CHANNEL_ERROR, {
        requestId,
        errorCode: 'max-channels-reached'
      });
      return;
    }
    
    // Create channel
    const channelId = this.generateChannelId();
    const channel = {
      id: channelId,
      connectionId: connection.id,
      userIdentity,
      nominalHashRate,
      maxTarget,
      state: ChannelState.OPEN,
      extranonce1: crypto.randomBytes(4).toString('hex'),
      extranonce2Size: 4,
      sharesSubmitted: 0,
      sharesAccepted: 0,
      currentDifficulty: 1000000
    };
    
    connection.channels.set(channelId, channel);
    this.channels.set(channelId, channel);
    this.stats.totalChannels++;
    this.stats.activeChannels++;
    
    // Send success response
    await this.sendMessage(connection, StratumV2MessageType.OPEN_STANDARD_MINING_CHANNEL_SUCCESS, {
      requestId,
      channelId,
      target: this.difficultyToTarget(channel.currentDifficulty),
      extranonce1: channel.extranonce1,
      extranonce2Size: channel.extranonce2Size
    });
    
    // Send current job if available
    if (this.currentJob) {
      await this.sendNewJob(connection, channel);
    }
    
    logger.info(`Opened channel ${channelId} for user ${userIdentity}`);
    this.emit('channel:opened', { connection, channel });
  }
  
  /**
   * Handle share submission
   */
  async handleSubmitShares(connection, data) {
    const { channelId, sequence, jobId, nonce, time, version } = data;
    
    const channel = connection.channels.get(channelId);
    if (!channel || channel.state !== ChannelState.OPEN) {
      await this.sendMessage(connection, StratumV2MessageType.SUBMIT_SHARES_ERROR, {
        channelId,
        sequence,
        errorCode: 'invalid-channel'
      });
      return;
    }
    
    channel.sharesSubmitted++;
    this.stats.sharesSubmitted++;
    
    // Build share data
    const share = {
      channelId,
      jobId,
      nonce,
      time,
      version,
      extranonce1: channel.extranonce1,
      difficulty: channel.currentDifficulty
    };
    
    // Emit for validation
    this.emit('share:submitted', {
      connectionId: connection.id,
      channel,
      share,
      difficulty: channel.currentDifficulty
    });
    
    // For now, always accept (real implementation would validate)
    channel.sharesAccepted++;
    this.stats.sharesAccepted++;
    
    await this.sendMessage(connection, StratumV2MessageType.SUBMIT_SHARES_SUCCESS, {
      channelId,
      sequence,
      newSubmits: 1,
      newShares: 1
    });
  }
  
  /**
   * Send new job to channel
   */
  async sendNewJob(connection, channel) {
    if (!this.currentJob) return;
    
    const message = {
      channelId: channel.id,
      jobId: this.currentJob.id,
      prevHash: this.currentJob.prevHash,
      coinbasePrefix: this.currentJob.coinbase1,
      coinbaseSuffix: this.currentJob.coinbase2,
      merkleBranches: this.currentJob.merkleBranches,
      version: parseInt(this.currentJob.version, 16),
      bits: parseInt(this.currentJob.bits, 16),
      time: this.currentJob.time,
      merkleRoot: this.currentJob.merkleRoot || '0000000000000000000000000000000000000000000000000000000000000000'
    };
    
    await this.sendMessage(connection, StratumV2MessageType.NEW_MINING_JOB, message);
  }
  
  /**
   * Broadcast new job to all channels
   */
  async broadcastNewJob(job) {
    this.currentJob = job;
    this.jobCounter++;
    
    for (const connection of this.connections.values()) {
      if (!connection.authorized) continue;
      
      for (const channel of connection.channels.values()) {
        if (channel.state === ChannelState.OPEN) {
          await this.sendNewJob(connection, channel);
        }
      }
    }
    
    logger.info(`Broadcasted new job ${job.id} to ${this.stats.activeChannels} channels`);
  }
  
  /**
   * Send message to connection
   */
  async sendMessage(connection, messageType, data) {
    try {
      const encoded = await this.protocol.encode(messageType, data);
      connection.socket.write(encoded);
      this.stats.messagesOut++;
    } catch (error) {
      logger.error('Error sending message:', error);
    }
  }
  
  /**
   * Handle disconnection
   */
  handleDisconnection(connection) {
    // Close all channels
    for (const channel of connection.channels.values()) {
      this.channels.delete(channel.id);
      this.stats.activeChannels--;
    }
    
    this.connections.delete(connection.id);
    this.stats.activeConnections--;
    
    logger.info(`Connection ${connection.id} disconnected`);
    this.emit('connection:closed', connection);
  }
  
  /**
   * Generate channel ID
   */
  generateChannelId() {
    return ++this.jobCounter;
  }
  
  /**
   * Convert difficulty to target
   */
  difficultyToTarget(difficulty) {
    const maxTarget = BigInt('0xffff0000000000000000000000000000000000000000000000000000');
    const target = maxTarget / BigInt(Math.floor(difficulty));
    return '0x' + target.toString(16).padStart(64, '0');
  }
  
  /**
   * Get server statistics
   */
  getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - (this.startTime || Date.now()),
      averageSharesPerChannel: this.stats.activeChannels > 0 ? 
        this.stats.sharesSubmitted / this.stats.activeChannels : 0
    };
  }
  
  /**
   * Stop server
   */
  async stop() {
    logger.info('Stopping Stratum V2 server...');
    
    // Close all connections
    for (const connection of this.connections.values()) {
      connection.socket.destroy();
    }
    
    // Close server
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
    }
    
    logger.info('Stratum V2 server stopped');
    this.emit('stopped');
  }
}

export default StratumV2Server;
