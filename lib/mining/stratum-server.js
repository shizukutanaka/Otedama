/**
 * Lightweight Stratum Server
 * Simple and efficient Stratum V1 implementation
 */

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createLogger } = require('../core/logger');

const logger = createLogger('stratum-server');

class StratumServer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      port: options.port || 3333,
      host: options.host || '0.0.0.0',
      difficulty: options.difficulty || 16,
      extraNonce1Size: options.extraNonce1Size || 4,
      extraNonce2Size: options.extraNonce2Size || 4,
      ...options
    };
    
    this.server = null;
    this.miners = new Map();
    this.jobs = new Map();
    this.currentJob = null;
    this.extraNonce1Counter = 0;
    
    // Performance optimization: Pre-allocate buffers
    this.bufferPool = [];
    this.messageQueue = [];
    this.batchTimer = null;
    
    // Statistics
    this.stats = {
      connections: 0,
      miners: 0,
      shares: 0,
      validShares: 0,
      invalidShares: 0,
      blocks: 0
    };
  }
  
  /**
   * Start the stratum server
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer({
        // Performance optimizations
        noDelay: true,
        keepAlive: true,
        keepAliveInitialDelay: 30000
      });
      
      // Handle connections with backpressure control
      this.server.on('connection', (socket) => {
        // Apply TCP optimizations
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30000);
        
        // Set socket buffer sizes for better performance
        socket.setWriteQueueWaterMark(16 * 1024, 64 * 1024);
        
        this.handleConnection(socket);
      });
      
      this.server.on('error', (err) => {
        logger.error('Server error:', err);
        reject(err);
      });
      
      // Set server limits for better resource management
      this.server.maxConnections = this.options.maxConnections || 10000;
      
      this.server.listen(this.options.port, this.options.host, () => {
        logger.info(`Stratum server listening on ${this.options.host}:${this.options.port}`);
        this.startCleanup();
        resolve();
      });
    });
  }
  
  /**
   * Stop the server
   */
  async stop() {
    // Clear batch timer if exists
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    
    return new Promise((resolve) => {
      // Close all miner connections gracefully
      const closePromises = [];
      for (const miner of this.miners.values()) {
        closePromises.push(new Promise((res) => {
          miner.socket.end(() => res());
        }));
      }
      
      Promise.all(closePromises).then(() => {
        if (this.server) {
          this.server.close(() => {
            logger.info('Stratum server stopped');
            resolve();
          });
        } else {
          resolve();
        }
      });
    });
  }
  
  /**
   * Handle new connection
   */
  handleConnection(socket) {
    const minerId = crypto.randomBytes(16).toString('hex');
    const extraNonce1 = this.generateExtraNonce1();
    
    const miner = {
      id: minerId,
      socket,
      address: null,
      worker: null,
      extraNonce1,
      difficulty: this.options.difficulty,
      subscribed: false,
      authorized: false,
      shares: 0,
      validShares: 0,
      lastActivity: Date.now()
    };
    
    this.miners.set(minerId, miner);
    this.stats.connections++;
    this.stats.miners++;
    
    logger.info(`New connection from ${socket.remoteAddress}, assigned ID: ${minerId}`);
    
    // Set up socket handlers
    socket.setEncoding('utf8');
    
    // Optimized buffer handling with pre-allocated buffer
    let buffer = Buffer.allocUnsafe(65536); // 64KB buffer
    let bufferOffset = 0;
    
    socket.on('data', (chunk) => {
      // Handle buffer overflow
      if (bufferOffset + chunk.length > buffer.length) {
        const newBuffer = Buffer.allocUnsafe(buffer.length * 2);
        buffer.copy(newBuffer, 0, 0, bufferOffset);
        buffer = newBuffer;
      }
      
      chunk.copy(buffer, bufferOffset);
      bufferOffset += chunk.length;
      
      // Process complete lines
      let lineStart = 0;
      for (let i = 0; i < bufferOffset; i++) {
        if (buffer[i] === 0x0A) { // newline
          const line = buffer.toString('utf8', lineStart, i).trim();
          if (line) {
            this.handleMessage(miner, line);
          }
          lineStart = i + 1;
        }
      }
      
      // Keep remaining data
      if (lineStart < bufferOffset) {
        buffer.copy(buffer, 0, lineStart, bufferOffset);
        bufferOffset -= lineStart;
      } else {
        bufferOffset = 0;
      }
    });
    
    socket.on('error', (err) => {
      logger.error(`Socket error for miner ${minerId}:`, err);
    });
    
    socket.on('close', () => {
      this.miners.delete(minerId);
      this.stats.miners--;
      logger.info(`Miner ${minerId} disconnected`);
      this.emit('miner-disconnected', miner);
    });
  }
  
  /**
   * Handle stratum message with optimized parsing
   */
  handleMessage(miner, message) {
    try {
      // Use cached parser for better performance
      const data = this.parseMessage(message);
      miner.lastActivity = Date.now();
      
      switch (data.method) {
        case 'mining.subscribe':
          this.handleSubscribe(miner, data);
          break;
          
        case 'mining.authorize':
          this.handleAuthorize(miner, data);
          break;
          
        case 'mining.submit':
          this.handleSubmit(miner, data);
          break;
          
        case 'mining.get_transactions':
          this.handleGetTransactions(miner, data);
          break;
          
        default:
          if (data.id) {
            this.sendError(miner, data.id, 'Unknown method');
          }
      }
    } catch (err) {
      logger.error('Failed to parse message:', err, message);
    }
  }
  
  /**
   * Handle mining.subscribe
   */
  handleSubscribe(miner, data) {
    miner.subscribed = true;
    
    const response = {
      id: data.id,
      result: [
        [
          ['mining.set_difficulty', crypto.randomBytes(8).toString('hex')],
          ['mining.notify', crypto.randomBytes(8).toString('hex')]
        ],
        miner.extraNonce1,
        this.options.extraNonce2Size
      ],
      error: null
    };
    
    this.send(miner, response);
    
    // Send initial difficulty
    this.sendDifficulty(miner);
    
    // Send current job if available
    if (this.currentJob) {
      this.sendJob(miner, this.currentJob);
    }
    
    logger.info(`Miner ${miner.id} subscribed`);
  }
  
  /**
   * Handle mining.authorize
   */
  handleAuthorize(miner, data) {
    const [address, password] = data.params;
    
    // Basic validation
    if (!address || address.length < 20) {
      this.sendError(miner, data.id, 'Invalid address');
      return;
    }
    
    miner.address = address;
    miner.worker = password || 'default';
    miner.authorized = true;
    
    const response = {
      id: data.id,
      result: true,
      error: null
    };
    
    this.send(miner, response);
    
    logger.info(`Miner ${miner.id} authorized as ${address}.${miner.worker}`);
    this.emit('miner-connected', miner);
  }
  
  /**
   * Handle mining.submit
   */
  handleSubmit(miner, data) {
    if (!miner.authorized) {
      this.sendError(miner, data.id, 'Not authorized');
      return;
    }
    
    const [worker, jobId, extraNonce2, ntime, nonce] = data.params;
    
    miner.shares++;
    this.stats.shares++;
    
    // Validate share
    const share = {
      worker,
      jobId,
      extraNonce1: miner.extraNonce1,
      extraNonce2,
      ntime,
      nonce,
      difficulty: miner.difficulty,
      timestamp: Date.now()
    };
    
    // Emit for validation
    this.emit('share-submitted', miner, share, (isValid, isBlock) => {
      if (isValid) {
        miner.validShares++;
        this.stats.validShares++;
        
        const response = {
          id: data.id,
          result: true,
          error: null
        };
        
        this.send(miner, response);
        
        if (isBlock) {
          this.stats.blocks++;
          logger.info(`Block found by ${miner.address}!`);
          this.emit('block-found', miner, share);
        }
      } else {
        this.stats.invalidShares++;
        this.sendError(miner, data.id, 'Invalid share');
      }
    });
  }
  
  /**
   * Handle mining.get_transactions
   */
  handleGetTransactions(miner, data) {
    // Return empty array for now
    const response = {
      id: data.id,
      result: [],
      error: null
    };
    
    this.send(miner, response);
  }
  
  /**
   * Send difficulty to miner
   */
  sendDifficulty(miner) {
    const message = {
      id: null,
      method: 'mining.set_difficulty',
      params: [miner.difficulty]
    };
    
    this.send(miner, message);
  }
  
  /**
   * Send job to miner
   */
  sendJob(miner, job, clean = false) {
    if (!miner.subscribed) return;
    
    const message = {
      id: null,
      method: 'mining.notify',
      params: [
        job.id,
        job.prevHash,
        job.coinbase1,
        job.coinbase2,
        job.merkleTree,
        job.version,
        job.bits,
        job.time,
        clean
      ]
    };
    
    this.send(miner, message);
  }
  
  /**
   * Broadcast new job to all miners
   */
  broadcastJob(job, clean = false) {
    this.currentJob = job;
    this.jobs.set(job.id, job);
    
    // Clean old jobs
    if (this.jobs.size > 10) {
      const oldJobs = Array.from(this.jobs.keys()).slice(0, -10);
      oldJobs.forEach(id => this.jobs.delete(id));
    }
    
    // Send to all subscribed miners
    for (const miner of this.miners.values()) {
      if (miner.subscribed) {
        this.sendJob(miner, job, clean);
      }
    }
    
    logger.info(`Broadcasted job ${job.id} to ${this.miners.size} miners`);
  }
  
  /**
   * Set difficulty for a miner
   */
  setMinerDifficulty(minerId, difficulty) {
    const miner = this.miners.get(minerId);
    if (!miner) return;
    
    miner.difficulty = difficulty;
    this.sendDifficulty(miner);
  }
  
  /**
   * Send message to miner with batching optimization
   */
  send(miner, message) {
    // Check if batching is enabled and not a priority message
    if (this.options.enableBatching && !message.priority) {
      this.queueMessage(miner, message);
    } else {
      // Send immediately
      const data = JSON.stringify(message) + '\n';
      try {
        if (!miner.socket.destroyed) {
          miner.socket.write(data);
        }
      } catch (err) {
        logger.error(`Failed to send message to miner ${miner.id}:`, err);
      }
    }
  }
  
  /**
   * Queue message for batch sending
   */
  queueMessage(miner, message) {
    if (!this.messageQueue[miner.id]) {
      this.messageQueue[miner.id] = [];
    }
    
    this.messageQueue[miner.id].push(message);
    
    // Start batch timer if not already running
    if (!this.batchTimer) {
      this.batchTimer = setInterval(() => this.flushMessageQueue(), 100);
    }
  }
  
  /**
   * Flush message queue - send all queued messages
   */
  flushMessageQueue() {
    for (const [minerId, messages] of Object.entries(this.messageQueue)) {
      const miner = this.miners.get(minerId);
      if (!miner || miner.socket.destroyed) {
        delete this.messageQueue[minerId];
        continue;
      }
      
      // Batch all messages into one write
      const batchData = messages.map(msg => JSON.stringify(msg)).join('\n') + '\n';
      
      try {
        miner.socket.write(batchData);
      } catch (err) {
        logger.error(`Failed to send batch to miner ${minerId}:`, err);
      }
      
      delete this.messageQueue[minerId];
    }
    
    // Stop timer if no more messages
    if (Object.keys(this.messageQueue).length === 0 && this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }
  
  /**
   * Send error to miner
   */
  sendError(miner, id, message) {
    const response = {
      id,
      result: null,
      error: [20, message, null]
    };
    
    this.send(miner, response);
  }
  
  /**
   * Generate extra nonce 1
   */
  generateExtraNonce1() {
    const buffer = Buffer.allocUnsafe(this.options.extraNonce1Size);
    buffer.writeUInt32BE(this.extraNonce1Counter++, 0);
    return buffer.toString('hex');
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      uptime: process.uptime(),
      miners: Array.from(this.miners.values()).map(m => ({
        id: m.id,
        address: m.address,
        worker: m.worker,
        difficulty: m.difficulty,
        shares: m.shares,
        validShares: m.validShares,
        hashrate: this.calculateHashrate(m)
      }))
    };
  }
  
  /**
   * Calculate miner hashrate using unified calculator
   */
  calculateHashrate(miner) {
    const hashrateCalculator = require('../utils/hashrate-calculator');
    return hashrateCalculator.calculateFromMinerStats({
      validShares: miner.validShares,
      difficulty: miner.difficulty,
      startTime: Date.now() - (process.uptime() * 1000),
      algorithm: 'sha256'
    });
  }
  
  // Security helper methods
  checkRateLimit(minerId) {
    const now = Date.now();
    const window = 60000; // 1 minute
    
    if (!this.messageRateLimits.has(minerId)) {
      this.messageRateLimits.set(minerId, { count: 1, resetTime: now + window });
      return true;
    }
    
    const rateLimit = this.messageRateLimits.get(minerId);
    
    if (now > rateLimit.resetTime) {
      rateLimit.count = 1;
      rateLimit.resetTime = now + window;
      return true;
    }
    
    rateLimit.count++;
    return rateLimit.count <= this.maxMessagesPerMinute;
  }
  
  blacklistIP(ip) {
    this.blacklistedIPs.add(ip);
    
    // Disconnect all miners from this IP
    for (const [id, miner] of this.miners) {
      if (miner.socket.remoteAddress === ip) {
        miner.socket.destroy();
        this.miners.delete(id);
      }
    }
  }
  
  validateSubmitParams(worker, jobId, extraNonce2, ntime, nonce) {
    // Validate worker
    if (typeof worker !== 'string' || worker.length > 50) return false;
    
    // Validate job ID
    if (typeof jobId !== 'string' || jobId.length > 64) return false;
    
    // Validate hex strings
    const hexRegex = /^[0-9a-fA-F]+$/;
    
    if (typeof extraNonce2 !== 'string' || !hexRegex.test(extraNonce2)) return false;
    if (typeof ntime !== 'string' || !hexRegex.test(ntime) || ntime.length !== 8) return false;
    if (typeof nonce !== 'string' || !hexRegex.test(nonce) || nonce.length !== 8) return false;
    
    return true;
  }
  
  // Cleanup task
  startCleanup() {
    setInterval(() => {
      // Clean up rate limits
      const now = Date.now();
      for (const [minerId, rateLimit] of this.messageRateLimits) {
        if (now > rateLimit.resetTime + 300000) { // 5 minutes
          this.messageRateLimits.delete(minerId);
        }
      }
    }, 60000); // Every minute
  }
}

module.exports = StratumServer;