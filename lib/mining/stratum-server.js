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
  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });
      
      this.server.on('error', (err) => {
        logger.error('Server error:', err);
        reject(err);
      });
      
      this.server.listen(this.options.port, this.options.host, () => {
        logger.info(`Stratum server listening on ${this.options.host}:${this.options.port}`);
        resolve();
      });
    });
  }
  
  /**
   * Stop the server
   */
  stop() {
    return new Promise((resolve) => {
      // Close all miner connections
      for (const miner of this.miners.values()) {
        miner.socket.end();
      }
      
      if (this.server) {
        this.server.close(() => {
          logger.info('Stratum server stopped');
          resolve();
        });
      } else {
        resolve();
      }
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
    
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          this.handleMessage(miner, line.trim());
        }
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
   * Handle stratum message
   */
  handleMessage(miner, message) {
    try {
      const data = JSON.parse(message);
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
   * Send message to miner
   */
  send(miner, message) {
    const data = JSON.stringify(message) + '\n';
    miner.socket.write(data);
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
   * Calculate miner hashrate
   */
  calculateHashrate(miner) {
    // Simple estimation based on shares and difficulty
    const sharesPerMinute = miner.validShares / (process.uptime() / 60);
    return Math.floor(sharesPerMinute * miner.difficulty * 4294967296 / 60);
  }
}

module.exports = StratumServer;