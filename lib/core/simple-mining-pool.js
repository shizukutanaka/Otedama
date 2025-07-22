/**
 * Simple Mining Pool Core
 * Clean, efficient implementation following KISS principle
 */

const { EventEmitter } = require('events');
const net = require('net');
const crypto = require('crypto');
const { createLogger } = require('./logger');

const logger = createLogger('simple-mining-pool');

class SimpleMiningPool extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      port: config.port || 3333,
      difficulty: config.difficulty || 16,
      payoutInterval: config.payoutInterval || 3600000, // 1 hour
      minPayout: config.minPayout || 0.001,
      fee: config.fee || 0.01,
      maxConnections: config.maxConnections || 10000,
      ...config
    };
    
    this.miners = new Map();
    this.shares = [];
    this.currentWork = null;
    this.server = null;
    this.stats = {
      totalHashrate: 0,
      activeMiners: 0,
      totalShares: 0,
      validShares: 0,
      blocksFound: 0
    };
  }
  
  /**
   * Start the mining pool server
   */
  async start() {
    this.server = net.createServer(this.handleConnection.bind(this));
    
    this.server.listen(this.config.port, () => {
      logger.info(`Mining pool listening on port ${this.config.port}`);
      this.emit('started', { port: this.config.port });
    });
    
    this.server.on('error', (err) => {
      logger.error('Server error:', err);
      this.emit('error', err);
    });
    
    // Start periodic tasks
    this.startPeriodicTasks();
  }
  
  /**
   * Handle new miner connection
   */
  handleConnection(socket) {
    const minerId = crypto.randomBytes(16).toString('hex');
    const miner = {
      id: minerId,
      socket: socket,
      address: null,
      difficulty: this.config.difficulty,
      shares: 0,
      hashrate: 0,
      lastShare: Date.now()
    };
    
    this.miners.set(minerId, miner);
    this.stats.activeMiners++;
    
    socket.on('data', (data) => {
      this.handleMinerData(miner, data);
    });
    
    socket.on('close', () => {
      this.miners.delete(minerId);
      this.stats.activeMiners--;
    });
    
    socket.on('error', (err) => {
      logger.debug(`Miner ${minerId} error:`, err.message);
    });
    
    // Send initial job
    this.sendJob(miner);
  }
  
  /**
   * Handle data from miner
   */
  handleMinerData(miner, data) {
    try {
      const messages = data.toString().trim().split('\n');
      
      for (const message of messages) {
        if (!message) continue;
        
        const json = JSON.parse(message);
        
        switch (json.method) {
          case 'mining.subscribe':
            this.handleSubscribe(miner, json);
            break;
          case 'mining.authorize':
            this.handleAuthorize(miner, json);
            break;
          case 'mining.submit':
            this.handleSubmit(miner, json);
            break;
          default:
            logger.debug('Unknown method:', json.method);
        }
      }
    } catch (err) {
      logger.debug('Parse error:', err.message);
    }
  }
  
  /**
   * Handle mining.subscribe
   */
  handleSubscribe(miner, message) {
    const response = {
      id: message.id,
      result: [
        [
          ['mining.notify', miner.id],
          ['mining.set_difficulty', miner.id]
        ],
        miner.id.substring(0, 8),
        4
      ],
      error: null
    };
    
    this.sendToMiner(miner, response);
    this.sendDifficulty(miner);
  }
  
  /**
   * Handle mining.authorize
   */
  handleAuthorize(miner, message) {
    const [address] = message.params;
    miner.address = address;
    
    const response = {
      id: message.id,
      result: true,
      error: null
    };
    
    this.sendToMiner(miner, response);
    this.emit('miner-connected', { id: miner.id, address: address });
  }
  
  /**
   * Handle mining.submit
   */
  handleSubmit(miner, message) {
    const [worker, jobId, time, nonce] = message.params;
    
    // Simple share validation
    const isValid = this.validateShare(miner, jobId, time, nonce);
    
    const response = {
      id: message.id,
      result: isValid,
      error: isValid ? null : [23, 'Invalid share', null]
    };
    
    this.sendToMiner(miner, response);
    
    if (isValid) {
      miner.shares++;
      this.stats.validShares++;
      
      this.shares.push({
        minerId: miner.id,
        address: miner.address,
        timestamp: Date.now(),
        difficulty: miner.difficulty
      });
      
      this.emit('share-accepted', {
        minerId: miner.id,
        shares: miner.shares
      });
    }
    
    this.stats.totalShares++;
  }
  
  /**
   * Validate share (simplified)
   */
  validateShare(miner, jobId, time, nonce) {
    // In production, this would validate against actual work
    // For now, simple probability check
    return Math.random() > 0.05; // 95% valid shares
  }
  
  /**
   * Send job to miner
   */
  sendJob(miner) {
    if (!this.currentWork) {
      this.currentWork = this.generateWork();
    }
    
    const job = {
      id: null,
      method: 'mining.notify',
      params: [
        this.currentWork.jobId,
        this.currentWork.prevHash,
        this.currentWork.coinbase1,
        this.currentWork.coinbase2,
        this.currentWork.merkleBranch,
        this.currentWork.version,
        this.currentWork.bits,
        this.currentWork.time,
        true // clean jobs
      ]
    };
    
    this.sendToMiner(miner, job);
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
    
    this.sendToMiner(miner, message);
  }
  
  /**
   * Send message to miner
   */
  sendToMiner(miner, message) {
    if (miner.socket && !miner.socket.destroyed) {
      miner.socket.write(JSON.stringify(message) + '\n');
    }
  }
  
  /**
   * Generate work (simplified)
   */
  generateWork() {
    return {
      jobId: crypto.randomBytes(4).toString('hex'),
      prevHash: crypto.randomBytes(32).toString('hex'),
      coinbase1: crypto.randomBytes(50).toString('hex'),
      coinbase2: crypto.randomBytes(50).toString('hex'),
      merkleBranch: [],
      version: '00000020',
      bits: '1a0fffff',
      time: Math.floor(Date.now() / 1000).toString(16)
    };
  }
  
  /**
   * Start periodic tasks
   */
  startPeriodicTasks() {
    // Update work every 30 seconds
    setInterval(() => {
      this.currentWork = this.generateWork();
      this.broadcastNewJob();
    }, 30000);
    
    // Calculate hashrates every 10 seconds
    setInterval(() => {
      this.calculateHashrates();
    }, 10000);
    
    // Process payouts
    setInterval(() => {
      this.processPayout();
    }, this.config.payoutInterval);
  }
  
  /**
   * Broadcast new job to all miners
   */
  broadcastNewJob() {
    for (const [id, miner] of this.miners) {
      this.sendJob(miner);
    }
  }
  
  /**
   * Calculate hashrates
   */
  calculateHashrates() {
    let totalHashrate = 0;
    
    for (const [id, miner] of this.miners) {
      const timeDiff = (Date.now() - miner.lastShare) / 1000;
      if (timeDiff > 0 && timeDiff < 300) { // 5 minutes
        miner.hashrate = (miner.shares * miner.difficulty * 4294967296) / timeDiff;
        totalHashrate += miner.hashrate;
      } else {
        miner.hashrate = 0;
      }
    }
    
    this.stats.totalHashrate = totalHashrate;
  }
  
  /**
   * Process payout
   */
  processPayout() {
    const sharesByAddress = new Map();
    const totalShares = this.shares.length;
    
    if (totalShares === 0) return;
    
    // Group shares by address
    for (const share of this.shares) {
      const current = sharesByAddress.get(share.address) || 0;
      sharesByAddress.set(share.address, current + share.difficulty);
    }
    
    // Calculate payouts
    const payouts = [];
    const totalDifficulty = Array.from(sharesByAddress.values()).reduce((a, b) => a + b, 0);
    
    for (const [address, difficulty] of sharesByAddress) {
      const percentage = difficulty / totalDifficulty;
      const amount = percentage * (1 - this.config.fee); // Apply pool fee
      
      if (amount >= this.config.minPayout) {
        payouts.push({ address, amount });
      }
    }
    
    // Clear processed shares
    this.shares = [];
    
    this.emit('payout-processed', { payouts, totalShares });
    
    logger.info(`Processed ${payouts.length} payouts from ${totalShares} shares`);
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      ...this.stats,
      miners: this.miners.size,
      difficulty: this.config.difficulty,
      fee: this.config.fee,
      minPayout: this.config.minPayout
    };
  }
  
  /**
   * Stop the pool
   */
  async stop() {
    if (this.server) {
      this.server.close();
    }
    
    // Close all miner connections
    for (const [id, miner] of this.miners) {
      if (miner.socket) {
        miner.socket.destroy();
      }
    }
    
    this.emit('stopped');
  }
}

/**
 * Create simple mining pool instance
 */
function createSimpleMiningPool(config) {
  return new SimpleMiningPool(config);
}

module.exports = {
  SimpleMiningPool,
  createSimpleMiningPool
};