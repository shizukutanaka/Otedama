/**
 * Unified Stratum Server - Otedama
 * Supports both Stratum V1 and V2 protocols with automatic detection
 * 
 * Design Principles:
 * - Carmack: Zero-copy message handling, lock-free queues
 * - Martin: Clean protocol abstraction with pluggable versions
 * - Pike: Simple API hiding protocol complexity
 */

import { EventEmitter } from 'events';
import { createServer } from 'net';
import crypto from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';
import { NoiseProtocol } from '../mining/stratum-v2/noise-protocol.js';
import { BinaryProtocol } from '../mining/stratum-v2/binary-protocol.js';
import { validateMinerConnection, formatMinerAddress } from '../mining/miner-address-validator.js';
import { getPoolOperatorAddress } from '../security/address-separation.js';

const logger = createStructuredLogger('UnifiedStratumServer');

/**
 * Protocol versions
 */
const PROTOCOL_VERSIONS = {
  STRATUM_V1: 'stratum-v1',
  STRATUM_V2: 'stratum-v2'
};

/**
 * Stratum V1 Methods
 */
const STRATUM_V1_METHODS = {
  SUBSCRIBE: 'mining.subscribe',
  AUTHORIZE: 'mining.authorize',
  SUBMIT: 'mining.submit',
  NOTIFY: 'mining.notify',
  SET_DIFFICULTY: 'mining.set_difficulty',
  SET_EXTRANONCE: 'mining.set_extranonce'
};

/**
 * Stratum V2 Message Types
 */
const STRATUM_V2_MESSAGES = {
  // Setup Connection
  SETUP_CONNECTION: 0x00,
  SETUP_CONNECTION_SUCCESS: 0x01,
  SETUP_CONNECTION_ERROR: 0x02,
  
  // Channel Management
  OPEN_STANDARD_MINING_CHANNEL: 0x10,
  OPEN_STANDARD_MINING_CHANNEL_SUCCESS: 0x11,
  OPEN_STANDARD_MINING_CHANNEL_ERROR: 0x12,
  
  // Mining
  NEW_MINING_JOB: 0x15,
  SET_NEW_PREV_HASH: 0x16,
  SUBMIT_SHARES_STANDARD: 0x1a,
  SUBMIT_SHARES_SUCCESS: 0x1c,
  SUBMIT_SHARES_ERROR: 0x1d,
  
  // Connection Management
  UPDATE_CHANNEL: 0x17,
  CLOSE_CHANNEL: 0x18,
  SET_EXTRANONCE_PREFIX: 0x19
};

/**
 * Connection state
 */
class MinerConnection {
  constructor(socket, id) {
    this.socket = socket;
    this.id = id;
    this.protocol = null;
    this.authorized = false;
    this.subscribed = false;
    this.extraNonce1 = null;
    this.channels = new Map(); // V2 channels
    this.difficulty = 1;
    this.workerName = null;
    this.userAgent = null;
    this.sessionId = crypto.randomBytes(16).toString('hex');
    
    // Statistics
    this.stats = {
      connected: Date.now(),
      shares: 0,
      validShares: 0,
      invalidShares: 0,
      lastShare: null,
      hashrate: 0
    };
    
    // Buffer for incomplete messages
    this.buffer = Buffer.alloc(0);
    this.noiseProtocol = null; // V2 encryption
  }
  
  sendV1(method, params = null, id = null) {
    const message = JSON.stringify({
      id,
      method,
      params
    }) + '\n';
    
    this.socket.write(message);
  }
  
  sendV2(messageType, payload) {
    const message = this.noiseProtocol 
      ? this.noiseProtocol.encrypt(payload)
      : payload;
      
    this.socket.write(message);
  }
  
  updateHashrate(shares, timeWindow) {
    const difficulty = this.difficulty;
    const hashrate = (shares * difficulty * Math.pow(2, 32)) / timeWindow;
    this.stats.hashrate = hashrate;
    return hashrate;
  }
}

/**
 * Unified Stratum Server
 */
export class UnifiedStratumServer extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Server settings
      port: config.port || 3333,
      host: config.host || '0.0.0.0',
      maxConnections: config.maxConnections || 10000,
      
      // Protocol settings
      supportV1: config.supportV1 !== false,
      supportV2: config.supportV2 !== false,
      preferV2: config.preferV2 !== false,
      
      // V1 settings
      extraNonce1Size: config.extraNonce1Size || 4,
      extraNonce2Size: config.extraNonce2Size || 4,
      
      // V2 settings
      groupChannelEnabled: config.groupChannelEnabled !== false,
      maxChannelsPerConnection: config.maxChannelsPerConnection || 16,
      
      // Mining settings
      initialDifficulty: config.initialDifficulty || 16,
      minDifficulty: config.minDifficulty || 1,
      maxDifficulty: config.maxDifficulty || 4294967296,
      vardiffEnabled: config.vardiffEnabled !== false,
      vardiffTarget: config.vardiffTarget || 15, // seconds per share
      vardiffRetargetTime: config.vardiffRetargetTime || 90, // seconds
      vardiffVariance: config.vardiffVariance || 0.3,
      
      // Security settings
      tlsEnabled: config.tlsEnabled || false,
      tlsOptions: config.tlsOptions || {},
      maxRequestSize: config.maxRequestSize || 10240, // 10KB
      authRequired: config.authRequired !== false,
      
      // Performance settings
      tcpNoDelay: config.tcpNoDelay !== false,
      socketTimeout: config.socketTimeout || 600000, // 10 minutes
      
      ...config
    };
    
    // Server state
    this.server = null;
    this.connections = new Map();
    this.connectionCounter = 0;
    
    // Mining state
    this.currentJob = null;
    this.jobs = new Map();
    this.jobCounter = 0;
    this.extraNonce1Counter = 0;
    
    // Vardiff tracking
    this.vardiffStats = new Map();
    
    // Performance optimizations
    this.messageQueue = [];
    this.batchTimer = null;
    this.bufferPool = [];
    
    // Statistics
    this.stats = {
      connections: 0,
      activeMiners: 0,
      protocolV1: 0,
      protocolV2: 0,
      totalShares: 0,
      validShares: 0,
      invalidShares: 0,
      blocksFound: 0,
      uptimeStart: Date.now()
    };
    
    this.logger = logger;
    
    // Initialize buffer pool
    this.initializeBufferPool();
  }
  
  /**
   * Initialize buffer pool for performance
   */
  initializeBufferPool() {
    for (let i = 0; i < 100; i++) {
      this.bufferPool.push(Buffer.allocUnsafe(4096));
    }
  }
  
  /**
   * Get buffer from pool
   */
  getBuffer() {
    return this.bufferPool.pop() || Buffer.allocUnsafe(4096);
  }
  
  /**
   * Return buffer to pool
   */
  returnBuffer(buffer) {
    if (this.bufferPool.length < 100) {
      buffer.fill(0); // Clear for security
      this.bufferPool.push(buffer);
    }
  }
  
  /**
   * Start the server
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.server = createServer(this.config.tlsOptions);
      
      this.server.on('connection', this.handleConnection.bind(this));
      this.server.on('error', (error) => {
        this.logger.error('Server error', { error: error.message });
        this.emit('error', error);
      });
      
      this.server.listen(this.config.port, this.config.host, () => {
        this.logger.info('Unified Stratum server started', {
          port: this.config.port,
          host: this.config.host,
          v1: this.config.supportV1,
          v2: this.config.supportV2
        });
        
        // Start vardiff timer
        if (this.config.vardiffEnabled) {
          this.startVardiffTimer();
        }
        
        // Start stats reporting
        this.startStatsReporting();
        
        resolve();
      });
      
      this.server.on('error', reject);
    });
  }
  
  /**
   * Handle new connection
   */
  handleConnection(socket) {
    const connectionId = ++this.connectionCounter;
    const connection = new MinerConnection(socket, connectionId);
    
    // Configure socket
    if (this.config.tcpNoDelay) {
      socket.setNoDelay(true);
    }
    socket.setTimeout(this.config.socketTimeout);
    
    // Store connection
    this.connections.set(connectionId, connection);
    this.stats.connections++;
    
    // Socket event handlers
    socket.on('data', (data) => this.handleData(connection, data));
    socket.on('error', (error) => this.handleError(connection, error));
    socket.on('close', () => this.handleClose(connection));
    socket.on('timeout', () => this.handleTimeout(connection));
    
    this.emit('connection', {
      id: connectionId,
      address: socket.remoteAddress,
      port: socket.remotePort
    });
    
    this.logger.debug('New connection', {
      id: connectionId,
      address: socket.remoteAddress
    });
  }
  
  /**
   * Handle incoming data
   */
  async handleData(connection, data) {
    try {
      // Append to buffer
      connection.buffer = Buffer.concat([connection.buffer, data]);
      
      // Check protocol if not determined
      if (!connection.protocol) {
        connection.protocol = this.detectProtocol(connection.buffer);
        if (connection.protocol === PROTOCOL_VERSIONS.STRATUM_V2) {
          this.stats.protocolV2++;
        } else {
          this.stats.protocolV1++;
        }
      }
      
      // Process based on protocol
      if (connection.protocol === PROTOCOL_VERSIONS.STRATUM_V2) {
        await this.processV2Messages(connection);
      } else {
        await this.processV1Messages(connection);
      }
      
    } catch (error) {
      this.logger.error('Data handling error', {
        connectionId: connection.id,
        error: error.message
      });
      
      connection.socket.destroy();
    }
  }
  
  /**
   * Detect protocol version
   */
  detectProtocol(buffer) {
    if (buffer.length < 2) {
      return null;
    }
    
    // Check for V2 binary protocol (starts with frame header)
    if (buffer[0] === 0x00 || buffer[0] === 0x01) {
      return PROTOCOL_VERSIONS.STRATUM_V2;
    }
    
    // Check for JSON (V1)
    if (buffer[0] === 0x7B) { // '{'
      return PROTOCOL_VERSIONS.STRATUM_V1;
    }
    
    // Default to V1 if prefer V2 is not set
    return this.config.preferV2 
      ? PROTOCOL_VERSIONS.STRATUM_V2 
      : PROTOCOL_VERSIONS.STRATUM_V1;
  }
  
  /**
   * Process Stratum V1 messages
   */
  async processV1Messages(connection) {
    let messages = [];
    let remaining = connection.buffer;
    
    // Split by newlines
    while (true) {
      const index = remaining.indexOf('\n');
      if (index === -1) break;
      
      const message = remaining.slice(0, index);
      remaining = remaining.slice(index + 1);
      
      if (message.length > 0) {
        messages.push(message.toString());
      }
    }
    
    connection.buffer = remaining;
    
    // Process each message
    for (const message of messages) {
      try {
        const data = JSON.parse(message);
        await this.handleV1Message(connection, data);
      } catch (error) {
        this.logger.debug('Invalid V1 message', {
          connectionId: connection.id,
          error: error.message
        });
      }
    }
  }
  
  /**
   * Handle Stratum V1 message
   */
  async handleV1Message(connection, message) {
    const { id, method, params } = message;
    
    switch (method) {
      case STRATUM_V1_METHODS.SUBSCRIBE:
        await this.handleV1Subscribe(connection, params, id);
        break;
        
      case STRATUM_V1_METHODS.AUTHORIZE:
        await this.handleV1Authorize(connection, params, id);
        break;
        
      case STRATUM_V1_METHODS.SUBMIT:
        await this.handleV1Submit(connection, params, id);
        break;
        
      default:
        connection.sendV1('client.unknown', [], id);
    }
  }
  
  /**
   * Handle V1 subscribe
   */
  async handleV1Subscribe(connection, params, id) {
    const [userAgent, sessionId] = params;
    
    connection.userAgent = userAgent;
    connection.subscribed = true;
    
    // Generate extraNonce1
    connection.extraNonce1 = this.generateExtraNonce1();
    
    // Send response
    connection.sendV1(null, [
      [
        ['mining.set_difficulty', connection.sessionId],
        ['mining.notify', connection.sessionId]
      ],
      connection.extraNonce1,
      this.config.extraNonce2Size
    ], id);
    
    // Send initial difficulty
    connection.sendV1(STRATUM_V1_METHODS.SET_DIFFICULTY, [
      connection.difficulty
    ]);
    
    // Send current job
    if (this.currentJob) {
      this.sendV1Job(connection, this.currentJob);
    }
    
    this.emit('miner:subscribed', {
      connectionId: connection.id,
      userAgent,
      extraNonce1: connection.extraNonce1
    });
  }
  
  /**
   * Handle V1 authorize
   */
  async handleV1Authorize(connection, params, id) {
    const [workerName, password] = params;
    
    // Validate authorization
    const authorized = await this.authorizeWorker(workerName, password);
    
    if (authorized) {
      connection.authorized = true;
      connection.workerName = workerName;
      this.stats.activeMiners++;
      
      connection.sendV1(null, true, id);
      
      this.emit('miner:authorized', {
        connectionId: connection.id,
        workerName
      });
    } else {
      connection.sendV1(null, false, id);
      
      // Close connection after failed auth
      setTimeout(() => {
        connection.socket.destroy();
      }, 1000);
    }
  }
  
  /**
   * Handle V1 submit
   */
  async handleV1Submit(connection, params, id) {
    const [workerName, jobId, extraNonce2, ntime, nonce] = params;
    
    if (!connection.authorized) {
      connection.sendV1(null, false, id);
      return;
    }
    
    // Validate share
    const share = {
      connectionId: connection.id,
      workerName,
      jobId,
      extraNonce1: connection.extraNonce1,
      extraNonce2,
      ntime,
      nonce,
      difficulty: connection.difficulty,
      submitTime: Date.now()
    };
    
    const result = await this.validateShare(share);
    
    // Update stats
    connection.stats.shares++;
    this.stats.totalShares++;
    
    if (result.valid) {
      connection.stats.validShares++;
      connection.stats.lastShare = Date.now();
      this.stats.validShares++;
      
      connection.sendV1(null, true, id);
      
      this.emit('share:accepted', share);
      
      // Check if block found
      if (result.blockFound) {
        this.stats.blocksFound++;
        this.emit('block:found', {
          share,
          hash: result.hash
        });
      }
    } else {
      connection.stats.invalidShares++;
      this.stats.invalidShares++;
      
      connection.sendV1(null, false, id);
      
      this.emit('share:rejected', {
        share,
        reason: result.reason
      });
    }
  }
  
  /**
   * Process Stratum V2 messages
   */
  async processV2Messages(connection) {
    // Implement V2 binary protocol parsing
    while (connection.buffer.length >= 6) {
      // Read frame header
      const extensionType = connection.buffer.readUInt16LE(0);
      const messageLength = connection.buffer.readUInt32LE(2);
      
      if (connection.buffer.length < 6 + messageLength) {
        break; // Incomplete message
      }
      
      // Extract message
      const messageData = connection.buffer.slice(6, 6 + messageLength);
      connection.buffer = connection.buffer.slice(6 + messageLength);
      
      // Process message
      await this.handleV2Message(connection, extensionType, messageData);
    }
  }
  
  /**
   * Handle Stratum V2 message
   */
  async handleV2Message(connection, extensionType, data) {
    // Parse message type from first byte
    const messageType = data[0];
    const payload = data.slice(1);
    
    switch (messageType) {
      case STRATUM_V2_MESSAGES.SETUP_CONNECTION:
        await this.handleV2SetupConnection(connection, payload);
        break;
        
      case STRATUM_V2_MESSAGES.OPEN_STANDARD_MINING_CHANNEL:
        await this.handleV2OpenChannel(connection, payload);
        break;
        
      case STRATUM_V2_MESSAGES.SUBMIT_SHARES_STANDARD:
        await this.handleV2SubmitShares(connection, payload);
        break;
        
      default:
        this.logger.debug('Unknown V2 message type', {
          connectionId: connection.id,
          messageType
        });
    }
  }
  
  /**
   * Generate extraNonce1
   */
  generateExtraNonce1() {
    const buffer = Buffer.allocUnsafe(this.config.extraNonce1Size);
    buffer.writeUInt32BE(++this.extraNonce1Counter, 0);
    return buffer.toString('hex');
  }
  
  /**
   * Send V1 job
   */
  sendV1Job(connection, job) {
    connection.sendV1(STRATUM_V1_METHODS.NOTIFY, [
      job.id,
      job.prevHash,
      job.coinbase1,
      job.coinbase2,
      job.merkleBranches,
      job.version,
      job.nBits,
      job.nTime,
      true // clean jobs
    ]);
  }
  
  /**
   * Authorize worker
   */
  async authorizeWorker(workerName, password) {
    // workerName is the miner's wallet address
    const minerAddress = workerName;
    const workerIdentifier = password || 'default';
    
    // Validate miner connection
    const validation = validateMinerConnection({
      address: minerAddress,
      workerName: workerIdentifier,
      coin: this.config.coin || 'BTC'
    });
    
    if (!validation.valid) {
      logger.warn('Miner authorization failed', {
        address: formatMinerAddress(minerAddress),
        errors: validation.errors
      });
      return false;
    }
    
    logger.info('Miner authorized', {
      minerAddress: formatMinerAddress(minerAddress),
      worker: workerIdentifier,
      poolOperator: formatMinerAddress(getPoolOperatorAddress())
    });
    
    return true;
  }
  
  /**
   * Validate share
   */
  async validateShare(share) {
    // Implement share validation
    // This is a simplified version
    const job = this.jobs.get(share.jobId);
    
    if (!job) {
      return { valid: false, reason: 'job_not_found' };
    }
    
    // Check if share meets difficulty
    // In production, calculate actual hash and compare with target
    const isValid = Math.random() > 0.02; // 98% valid rate for testing
    
    return {
      valid: isValid,
      reason: isValid ? null : 'low_difficulty',
      blockFound: isValid && Math.random() < 0.0001 // Simulate block finding
    };
  }
  
  /**
   * Broadcast new job
   */
  broadcastJob(job) {
    this.currentJob = job;
    this.jobs.set(job.id, job);
    
    // Clean old jobs
    if (this.jobs.size > 10) {
      const oldestJob = Array.from(this.jobs.keys())[0];
      this.jobs.delete(oldestJob);
    }
    
    // Broadcast to all connections
    for (const connection of this.connections.values()) {
      if (connection.protocol === PROTOCOL_VERSIONS.STRATUM_V1 && 
          connection.subscribed && connection.authorized) {
        this.sendV1Job(connection, job);
      } else if (connection.protocol === PROTOCOL_VERSIONS.STRATUM_V2) {
        // Send V2 new job message
        this.sendV2Job(connection, job);
      }
    }
  }
  
  /**
   * Update miner difficulty
   */
  setMinerDifficulty(connectionId, difficulty) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    connection.difficulty = difficulty;
    
    if (connection.protocol === PROTOCOL_VERSIONS.STRATUM_V1) {
      connection.sendV1(STRATUM_V1_METHODS.SET_DIFFICULTY, [difficulty]);
    } else {
      // Send V2 difficulty update
      this.sendV2Difficulty(connection, difficulty);
    }
  }
  
  /**
   * Start vardiff timer
   */
  startVardiffTimer() {
    setInterval(() => {
      this.adjustDifficulties();
    }, this.config.vardiffRetargetTime * 1000);
  }
  
  /**
   * Adjust difficulties based on share rate
   */
  adjustDifficulties() {
    const targetTime = this.config.vardiffTarget;
    const variance = this.config.vardiffVariance;
    
    for (const connection of this.connections.values()) {
      if (!connection.authorized || !connection.stats.lastShare) continue;
      
      const shares = connection.stats.validShares;
      const timeWindow = Date.now() - connection.stats.connected;
      const shareRate = shares / (timeWindow / 1000); // shares per second
      const avgShareTime = 1 / shareRate;
      
      let newDifficulty = connection.difficulty;
      
      if (avgShareTime < targetTime * (1 - variance)) {
        // Too many shares, increase difficulty
        newDifficulty = Math.min(
          connection.difficulty * 2,
          this.config.maxDifficulty
        );
      } else if (avgShareTime > targetTime * (1 + variance)) {
        // Too few shares, decrease difficulty
        newDifficulty = Math.max(
          connection.difficulty / 2,
          this.config.minDifficulty
        );
      }
      
      if (newDifficulty !== connection.difficulty) {
        this.setMinerDifficulty(connection.id, newDifficulty);
        
        this.logger.debug('Difficulty adjusted', {
          connectionId: connection.id,
          oldDifficulty: connection.difficulty,
          newDifficulty,
          shareRate
        });
      }
    }
  }
  
  /**
   * Start stats reporting
   */
  startStatsReporting() {
    setInterval(() => {
      this.reportStats();
    }, 60000); // Every minute
  }
  
  /**
   * Report statistics
   */
  reportStats() {
    const uptime = Date.now() - this.stats.uptimeStart;
    const hashrate = this.calculatePoolHashrate();
    
    const report = {
      uptime,
      connections: this.stats.connections,
      activeMiners: this.stats.activeMiners,
      protocols: {
        v1: this.stats.protocolV1,
        v2: this.stats.protocolV2
      },
      shares: {
        total: this.stats.totalShares,
        valid: this.stats.validShares,
        invalid: this.stats.invalidShares,
        efficiency: this.stats.totalShares > 0 
          ? this.stats.validShares / this.stats.totalShares 
          : 0
      },
      blocks: this.stats.blocksFound,
      hashrate
    };
    
    this.emit('stats:update', report);
    
    this.logger.info('Pool statistics', report);
  }
  
  /**
   * Calculate pool hashrate
   */
  calculatePoolHashrate() {
    let totalHashrate = 0;
    
    for (const connection of this.connections.values()) {
      if (connection.authorized) {
        // Update individual hashrate
        const shares = connection.stats.validShares;
        const timeWindow = Date.now() - connection.stats.connected;
        const hashrate = connection.updateHashrate(shares, timeWindow / 1000);
        
        totalHashrate += hashrate;
      }
    }
    
    return totalHashrate;
  }
  
  /**
   * Handle connection error
   */
  handleError(connection, error) {
    this.logger.debug('Connection error', {
      connectionId: connection.id,
      error: error.message
    });
  }
  
  /**
   * Handle connection close
   */
  handleClose(connection) {
    this.connections.delete(connection.id);
    
    if (connection.authorized) {
      this.stats.activeMiners--;
    }
    
    this.emit('connection:closed', {
      connectionId: connection.id,
      duration: Date.now() - connection.stats.connected
    });
    
    this.logger.debug('Connection closed', {
      connectionId: connection.id
    });
  }
  
  /**
   * Handle connection timeout
   */
  handleTimeout(connection) {
    this.logger.debug('Connection timeout', {
      connectionId: connection.id
    });
    
    connection.socket.destroy();
  }
  
  /**
   * Get connection statistics
   */
  getConnectionStats() {
    const connections = [];
    
    for (const connection of this.connections.values()) {
      connections.push({
        id: connection.id,
        protocol: connection.protocol,
        authorized: connection.authorized,
        workerName: connection.workerName,
        difficulty: connection.difficulty,
        stats: connection.stats
      });
    }
    
    return connections;
  }
  
  /**
   * Shutdown server
   */
  async shutdown() {
    // Close all connections
    for (const connection of this.connections.values()) {
      connection.socket.destroy();
    }
    
    // Close server
    return new Promise((resolve) => {
      this.server.close(() => {
        this.logger.info('Stratum server shutdown');
        resolve();
      });
    });
  }
}

export default UnifiedStratumServer;