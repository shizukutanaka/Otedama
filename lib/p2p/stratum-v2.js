/**
 * Stratum V2 Protocol Implementation
 * Next-generation mining protocol with encryption and advanced features
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { getLogger } from '../logger.js';

const logger = getLogger('StratumV2');

// Stratum V2 Message Types
export const MessageType = {
  // Setup Connection
  SETUP_CONNECTION: 0x00,
  SETUP_CONNECTION_SUCCESS: 0x01,
  SETUP_CONNECTION_ERROR: 0x02,
  
  // Channel Management
  OPEN_CHANNEL: 0x03,
  OPEN_CHANNEL_SUCCESS: 0x04,
  OPEN_CHANNEL_ERROR: 0x05,
  UPDATE_CHANNEL: 0x06,
  CLOSE_CHANNEL: 0x07,
  
  // Mining Protocol
  NEW_MINING_JOB: 0x15,
  SET_NEW_PREV_HASH: 0x16,
  SET_TARGET: 0x17,
  SUBMIT_SHARES: 0x18,
  SUBMIT_SHARES_SUCCESS: 0x19,
  SUBMIT_SHARES_ERROR: 0x1A,
  
  // Template Negotiation
  COINBASE_PREFIX: 0x20,
  COINBASE_SUFFIX: 0x21,
  SET_EXTRANONCE_PREFIX: 0x22,
  
  // Transaction Selection
  NEW_TEMPLATE: 0x30,
  SET_MEMPOOL: 0x31,
  DECLARE_MINING_JOB: 0x32,
  SUBMIT_SOLUTION: 0x33
};

// Channel Types
export const ChannelType = {
  STANDARD: 0,
  EXTENDED: 1,
  GROUP: 2
};

export class StratumV2Server extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || logger;
    this.options = {
      port: options.port || 3333,
      encryption: options.encryption !== false,
      jobNegotiation: options.jobNegotiation !== false,
      transactionSelection: options.transactionSelection !== false,
      noiseProtocol: options.noiseProtocol !== false,
      maxChannelsPerConnection: options.maxChannelsPerConnection || 16,
      ...options
    };
    
    this.connections = new Map();
    this.channels = new Map();
    this.templates = new Map();
    this.encryptionKeys = new Map();
    
    // Job management
    this.currentJobs = new Map();
    this.jobCounter = 0;
    
    // Statistics
    this.stats = {
      connections: 0,
      channels: 0,
      sharesSubmitted: 0,
      sharesAccepted: 0
    };
  }
  
  /**
   * Handle new connection
   */
  async handleConnection(socket, connectionId) {
    const connection = {
      id: connectionId,
      socket,
      channels: new Map(),
      state: 'connecting',
      features: {
        encryption: false,
        jobNegotiation: false,
        transactionSelection: false
      },
      encryptionKey: null,
      nonce: 0
    };
    
    this.connections.set(connectionId, connection);
    this.stats.connections++;
    
    // Setup message handler
    socket.on('data', (data) => this.handleMessage(connectionId, data));
    socket.on('close', () => this.handleDisconnect(connectionId));
    
    this.logger.info(`New Stratum V2 connection: ${connectionId}`);
  }
  
  /**
   * Handle incoming message
   */
  async handleMessage(connectionId, data) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    try {
      // Decrypt if needed
      const decrypted = connection.features.encryption ? 
        this.decryptMessage(data, connection) : data;
      
      // Parse message
      const message = this.parseMessage(decrypted);
      
      // Route to handler
      await this.routeMessage(connectionId, message);
      
    } catch (error) {
      this.logger.error(`Message handling error: ${error.message}`);
      this.sendError(connectionId, 'Invalid message');
    }
  }
  
  /**
   * Route message to appropriate handler
   */
  async routeMessage(connectionId, message) {
    switch (message.type) {
      case MessageType.SETUP_CONNECTION:
        await this.handleSetupConnection(connectionId, message);
        break;
        
      case MessageType.OPEN_CHANNEL:
        await this.handleOpenChannel(connectionId, message);
        break;
        
      case MessageType.SUBMIT_SHARES:
        await this.handleSubmitShares(connectionId, message);
        break;
        
      case MessageType.DECLARE_MINING_JOB:
        await this.handleDeclareMiningJob(connectionId, message);
        break;
        
      case MessageType.SET_MEMPOOL:
        await this.handleSetMempool(connectionId, message);
        break;
        
      default:
        this.logger.warn(`Unknown message type: ${message.type}`);
    }
  }
  
  /**
   * Handle setup connection
   */
  async handleSetupConnection(connectionId, message) {
    const connection = this.connections.get(connectionId);
    const { minVersion, maxVersion, features, publicKey } = message.payload;
    
    // Negotiate protocol version
    const negotiatedVersion = Math.min(maxVersion, 2);
    
    // Setup encryption if requested and supported
    if (features.encryption && this.options.encryption) {
      const sessionKey = await this.negotiateEncryption(connectionId, publicKey);
      connection.encryptionKey = sessionKey;
      connection.features.encryption = true;
    }
    
    // Enable features
    connection.features.jobNegotiation = features.jobNegotiation && this.options.jobNegotiation;
    connection.features.transactionSelection = features.transactionSelection && this.options.transactionSelection;
    
    connection.state = 'connected';
    
    // Send success response
    this.sendMessage(connectionId, {
      type: MessageType.SETUP_CONNECTION_SUCCESS,
      payload: {
        version: negotiatedVersion,
        features: connection.features
      }
    });
    
    this.emit('connection:established', {
      connectionId,
      features: connection.features
    });
  }
  
  /**
   * Handle open channel
   */
  async handleOpenChannel(connectionId, message) {
    const connection = this.connections.get(connectionId);
    const { channelType, nominal_hashrate, max_target } = message.payload;
    
    if (connection.channels.size >= this.options.maxChannelsPerConnection) {
      this.sendMessage(connectionId, {
        type: MessageType.OPEN_CHANNEL_ERROR,
        payload: { error: 'Too many channels' }
      });
      return;
    }
    
    const channelId = this.generateChannelId();
    const channel = {
      id: channelId,
      connectionId,
      type: channelType,
      nominalHashrate: nominal_hashrate,
      maxTarget: max_target,
      state: 'active',
      difficulty: this.calculateInitialDifficulty(nominal_hashrate),
      shares: [],
      extranonce: this.generateExtranonce(),
      stats: {
        sharesSubmitted: 0,
        sharesAccepted: 0,
        lastShare: null
      }
    };
    
    connection.channels.set(channelId, channel);
    this.channels.set(channelId, channel);
    this.stats.channels++;
    
    // Send success with channel details
    this.sendMessage(connectionId, {
      type: MessageType.OPEN_CHANNEL_SUCCESS,
      payload: {
        channelId,
        target: this.difficultyToTarget(channel.difficulty),
        extranonce_prefix: channel.extranonce,
        group_channel_id: channelType === ChannelType.GROUP ? channelId : null
      }
    });
    
    // Send initial job
    this.sendNewJob(channelId);
    
    this.emit('channel:opened', {
      connectionId,
      channelId,
      type: channelType
    });
  }
  
  /**
   * Handle submit shares
   */
  async handleSubmitShares(connectionId, message) {
    const { channelId, job_id, nonce, ntime, version } = message.payload;
    const channel = this.channels.get(channelId);
    
    if (!channel || channel.connectionId !== connectionId) {
      this.sendMessage(connectionId, {
        type: MessageType.SUBMIT_SHARES_ERROR,
        payload: { error: 'Invalid channel' }
      });
      return;
    }
    
    const job = this.currentJobs.get(job_id);
    if (!job) {
      this.sendMessage(connectionId, {
        type: MessageType.SUBMIT_SHARES_ERROR,
        payload: { error: 'Job not found' }
      });
      return;
    }
    
    // Validate share
    const share = {
      jobId: job_id,
      nonce,
      ntime,
      version,
      channelId,
      timestamp: Date.now()
    };
    
    const isValid = await this.validateShare(share, job, channel);
    
    channel.stats.sharesSubmitted++;
    this.stats.sharesSubmitted++;
    
    if (isValid) {
      channel.stats.sharesAccepted++;
      channel.stats.lastShare = Date.now();
      this.stats.sharesAccepted++;
      
      // Calculate share value
      const shareValue = this.calculateShareValue(channel.difficulty);
      
      this.sendMessage(connectionId, {
        type: MessageType.SUBMIT_SHARES_SUCCESS,
        payload: {
          channelId,
          shares_accepted: 1,
          shares_rejected: 0
        }
      });
      
      this.emit('share:accepted', {
        connectionId,
        channelId,
        share,
        value: shareValue
      });
      
      // Adjust difficulty if needed
      this.adjustDifficulty(channel);
      
    } else {
      this.sendMessage(connectionId, {
        type: MessageType.SUBMIT_SHARES_ERROR,
        payload: {
          channelId,
          error: 'Invalid share'
        }
      });
      
      this.emit('share:rejected', {
        connectionId,
        channelId,
        share
      });
    }
  }
  
  /**
   * Handle declare mining job (transaction selection)
   */
  async handleDeclareMiningJob(connectionId, message) {
    const connection = this.connections.get(connectionId);
    
    if (!connection.features.transactionSelection) {
      this.sendError(connectionId, 'Transaction selection not enabled');
      return;
    }
    
    const {
      channelId,
      mining_job_token,
      version,
      coinbase_prefix,
      coinbase_suffix,
      merkle_path
    } = message.payload;
    
    const channel = this.channels.get(channelId);
    if (!channel || channel.connectionId !== connectionId) {
      this.sendError(connectionId, 'Invalid channel');
      return;
    }
    
    // Create custom job
    const customJob = {
      id: this.generateJobId(),
      token: mining_job_token,
      version,
      coinbase: {
        prefix: coinbase_prefix,
        suffix: coinbase_suffix
      },
      merklePath: merkle_path,
      timestamp: Date.now(),
      custom: true
    };
    
    this.currentJobs.set(customJob.id, customJob);
    
    // Send job to channel
    this.sendMessage(connectionId, {
      type: MessageType.NEW_MINING_JOB,
      payload: {
        channelId,
        job_id: customJob.id,
        future_job: false,
        version: customJob.version,
        merkle_root: this.calculateMerkleRoot(customJob)
      }
    });
    
    this.emit('job:custom', {
      connectionId,
      channelId,
      jobId: customJob.id
    });
  }
  
  /**
   * Handle set mempool (for transaction selection)
   */
  async handleSetMempool(connectionId, message) {
    const connection = this.connections.get(connectionId);
    
    if (!connection.features.transactionSelection) {
      this.sendError(connectionId, 'Transaction selection not enabled');
      return;
    }
    
    const { channelId, transaction_list } = message.payload;
    const channel = this.channels.get(channelId);
    
    if (!channel || channel.connectionId !== connectionId) {
      this.sendError(connectionId, 'Invalid channel');
      return;
    }
    
    // Store transaction list for channel
    channel.mempool = transaction_list;
    
    this.emit('mempool:updated', {
      connectionId,
      channelId,
      transactions: transaction_list.length
    });
  }
  
  /**
   * Send new job to channel
   */
  sendNewJob(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    
    const job = this.createJob();
    this.currentJobs.set(job.id, job);
    
    this.sendMessage(channel.connectionId, {
      type: MessageType.NEW_MINING_JOB,
      payload: {
        channelId,
        job_id: job.id,
        future_job: false,
        version: job.version,
        prev_hash: job.prevHash,
        coinbase_tx: job.coinbaseTx,
        merkle_path: job.merklePath,
        nbits: job.bits,
        ntime: job.ntime,
        clean_jobs: job.clean
      }
    });
  }
  
  /**
   * Create new mining job
   */
  createJob() {
    const jobId = this.generateJobId();
    
    return {
      id: jobId,
      version: 0x20000000,
      prevHash: randomBytes(32).toString('hex'),
      coinbaseTx: this.createCoinbaseTransaction(),
      merklePath: [],
      bits: 0x1d00ffff,
      ntime: Math.floor(Date.now() / 1000),
      clean: true,
      height: 750000 + Math.floor(Math.random() * 100)
    };
  }
  
  /**
   * Create coinbase transaction
   */
  createCoinbaseTransaction() {
    // Simplified coinbase - in production use proper transaction construction
    const coinbase = Buffer.concat([
      Buffer.from('01000000', 'hex'), // Version
      Buffer.from('01', 'hex'), // Input count
      Buffer.alloc(32), // Previous output (null)
      Buffer.from('ffffffff', 'hex'), // Previous index
      Buffer.from('00', 'hex'), // Script length
      Buffer.from('ffffffff', 'hex'), // Sequence
      Buffer.from('01', 'hex'), // Output count
      Buffer.from('00f2052a01000000', 'hex'), // Value (50 BTC)
      Buffer.from('00', 'hex'), // Script length
      Buffer.from('00000000', 'hex') // Lock time
    ]);
    
    return coinbase.toString('hex');
  }
  
  /**
   * Validate share
   */
  async validateShare(share, job, channel) {
    // Construct block header
    const header = Buffer.concat([
      Buffer.from(job.version.toString(16).padStart(8, '0'), 'hex'),
      Buffer.from(job.prevHash, 'hex'),
      Buffer.from(this.calculateMerkleRoot(job), 'hex'),
      Buffer.from(share.ntime.toString(16).padStart(8, '0'), 'hex'),
      Buffer.from(job.bits.toString(16).padStart(8, '0'), 'hex'),
      Buffer.from(share.nonce, 'hex')
    ]);
    
    // Calculate hash
    const hash = createHash('sha256').update(createHash('sha256').update(header).digest()).digest();
    
    // Check against target
    const hashBigInt = BigInt('0x' + hash.toString('hex'));
    const targetBigInt = this.difficultyToTargetBigInt(channel.difficulty);
    
    return hashBigInt <= targetBigInt;
  }
  
  /**
   * Calculate share value
   */
  calculateShareValue(difficulty) {
    // Share value proportional to difficulty
    return difficulty * 0.00001; // Adjust based on economics
  }
  
  /**
   * Adjust channel difficulty
   */
  adjustDifficulty(channel) {
    const timeSinceLastShare = Date.now() - (channel.stats.lastShare || Date.now());
    const targetTime = 30000; // 30 seconds target
    const variance = 0.3;
    
    let newDifficulty = channel.difficulty;
    
    if (timeSinceLastShare < targetTime * (1 - variance)) {
      // Too fast - increase difficulty
      newDifficulty = Math.min(channel.difficulty * 1.5, 65536);
    } else if (timeSinceLastShare > targetTime * (1 + variance)) {
      // Too slow - decrease difficulty
      newDifficulty = Math.max(channel.difficulty * 0.7, 1);
    }
    
    if (newDifficulty !== channel.difficulty) {
      channel.difficulty = newDifficulty;
      
      // Send new target
      this.sendMessage(channel.connectionId, {
        type: MessageType.SET_TARGET,
        payload: {
          channelId: channel.id,
          target: this.difficultyToTarget(newDifficulty)
        }
      });
    }
  }
  
  /**
   * Negotiate encryption
   */
  async negotiateEncryption(connectionId, clientPublicKey) {
    // Simplified key exchange - in production use proper ECDH or Noise Protocol
    const serverKey = randomBytes(32);
    const sessionKey = createHash('sha256')
      .update(serverKey)
      .update(clientPublicKey)
      .digest();
    
    this.encryptionKeys.set(connectionId, sessionKey);
    
    return sessionKey;
  }
  
  /**
   * Encrypt message
   */
  encryptMessage(data, connection) {
    if (!connection.encryptionKey) return data;
    
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', connection.encryptionKey, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(data),
      cipher.final(),
      cipher.getAuthTag()
    ]);
    
    return Buffer.concat([iv, encrypted]);
  }
  
  /**
   * Decrypt message
   */
  decryptMessage(data, connection) {
    if (!connection.encryptionKey) return data;
    
    const iv = data.slice(0, 16);
    const authTag = data.slice(-16);
    const encrypted = data.slice(16, -16);
    
    const decipher = createDecipheriv('aes-256-gcm', connection.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
  }
  
  /**
   * Parse message
   */
  parseMessage(data) {
    // Simplified parsing - in production use proper protocol buffers
    const type = data.readUInt8(0);
    const length = data.readUInt32LE(1);
    const payload = JSON.parse(data.slice(5, 5 + length).toString());
    
    return { type, payload };
  }
  
  /**
   * Send message
   */
  sendMessage(connectionId, message) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    // Serialize message
    const payload = JSON.stringify(message.payload);
    const buffer = Buffer.allocUnsafe(5 + payload.length);
    
    buffer.writeUInt8(message.type, 0);
    buffer.writeUInt32LE(payload.length, 1);
    buffer.write(payload, 5);
    
    // Encrypt if needed
    const encrypted = connection.features.encryption ?
      this.encryptMessage(buffer, connection) : buffer;
    
    connection.socket.write(encrypted);
  }
  
  /**
   * Send error message
   */
  sendError(connectionId, error) {
    this.sendMessage(connectionId, {
      type: MessageType.SETUP_CONNECTION_ERROR,
      payload: { error }
    });
  }
  
  /**
   * Calculate initial difficulty
   */
  calculateInitialDifficulty(hashrate) {
    // Target 30 seconds per share
    const sharesPerSecond = 1 / 30;
    const hashesPerShare = hashrate / sharesPerSecond;
    const difficulty = hashesPerShare / Math.pow(2, 32);
    
    return Math.max(1, Math.min(65536, difficulty));
  }
  
  /**
   * Convert difficulty to target
   */
  difficultyToTarget(difficulty) {
    const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
    const target = maxTarget / BigInt(Math.floor(difficulty));
    
    return target.toString(16).padStart(64, '0');
  }
  
  /**
   * Convert difficulty to target BigInt
   */
  difficultyToTargetBigInt(difficulty) {
    const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
    return maxTarget / BigInt(Math.floor(difficulty));
  }
  
  /**
   * Calculate merkle root
   */
  calculateMerkleRoot(job) {
    // Simplified - in production calculate actual merkle root
    return createHash('sha256')
      .update(job.coinbaseTx || '')
      .digest('hex');
  }
  
  /**
   * Generate IDs
   */
  generateChannelId() {
    return randomBytes(4).readUInt32LE(0);
  }
  
  generateJobId() {
    return (++this.jobCounter).toString(16).padStart(8, '0');
  }
  
  generateExtranonce() {
    return randomBytes(4).toString('hex');
  }
  
  /**
   * Handle disconnect
   */
  handleDisconnect(connectionId) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    // Clean up channels
    for (const [channelId, channel] of connection.channels) {
      this.channels.delete(channelId);
      this.stats.channels--;
    }
    
    this.connections.delete(connectionId);
    this.encryptionKeys.delete(connectionId);
    this.stats.connections--;
    
    this.emit('connection:closed', { connectionId });
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      shareEfficiency: this.stats.sharesSubmitted > 0 ?
        (this.stats.sharesAccepted / this.stats.sharesSubmitted) * 100 : 0,
      activeJobs: this.currentJobs.size,
      encryptedConnections: Array.from(this.connections.values())
        .filter(c => c.features.encryption).length
    };
  }
}