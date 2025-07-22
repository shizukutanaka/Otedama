/**
 * Simple CPU Miner
 * Efficient CPU mining implementation
 */

const { EventEmitter } = require('events');
const net = require('net');
const crypto = require('crypto');
const os = require('os');
const { Worker } = require('worker_threads');
const { createLogger } = require('../core/logger');

const logger = createLogger('simple-cpu-miner');

class SimpleCPUMiner extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      pool: config.pool || 'localhost:3333',
      wallet: config.wallet || null,
      threads: config.threads || os.cpus().length,
      algorithm: config.algorithm || 'sha256',
      ...config
    };
    
    if (!this.config.wallet) {
      throw new Error('Wallet address required');
    }
    
    this.socket = null;
    this.connected = false;
    this.currentJob = null;
    this.workers = [];
    this.stats = {
      hashrate: 0,
      shares: 0,
      accepted: 0,
      rejected: 0,
      uptime: Date.now()
    };
  }
  
  /**
   * Start mining
   */
  async start() {
    logger.info(`Starting CPU miner with ${this.config.threads} threads`);
    
    // Connect to pool
    await this.connectToPool();
    
    // Start worker threads
    this.startWorkers();
    
    // Start stats reporting
    this.startStatsReporting();
    
    this.emit('started', {
      pool: this.config.pool,
      threads: this.config.threads,
      algorithm: this.config.algorithm
    });
  }
  
  /**
   * Connect to mining pool
   */
  async connectToPool() {
    const [host, port] = this.config.pool.split(':');
    
    return new Promise((resolve, reject) => {
      this.socket = net.connect(parseInt(port), host, () => {
        logger.info(`Connected to pool ${this.config.pool}`);
        this.connected = true;
        
        // Subscribe to pool
        this.subscribe();
        
        resolve();
      });
      
      this.socket.on('data', (data) => {
        this.handlePoolData(data);
      });
      
      this.socket.on('error', (err) => {
        logger.error('Pool connection error:', err);
        reject(err);
      });
      
      this.socket.on('close', () => {
        this.connected = false;
        logger.warn('Disconnected from pool');
        
        // Reconnect after 5 seconds
        setTimeout(() => {
          if (!this.connected) {
            this.connectToPool();
          }
        }, 5000);
      });
    });
  }
  
  /**
   * Subscribe to pool
   */
  subscribe() {
    // Send mining.subscribe
    this.sendToPool({
      id: 1,
      method: 'mining.subscribe',
      params: ['SimpleCPUMiner/1.0']
    });
    
    // Send mining.authorize
    this.sendToPool({
      id: 2,
      method: 'mining.authorize',
      params: [this.config.wallet, 'x']
    });
  }
  
  /**
   * Handle data from pool
   */
  handlePoolData(data) {
    const messages = data.toString().trim().split('\n');
    
    for (const message of messages) {
      if (!message) continue;
      
      try {
        const json = JSON.parse(message);
        
        if (json.method) {
          this.handlePoolMethod(json);
        } else if (json.id) {
          this.handlePoolResponse(json);
        }
      } catch (err) {
        logger.debug('Parse error:', err.message);
      }
    }
  }
  
  /**
   * Handle pool method
   */
  handlePoolMethod(message) {
    switch (message.method) {
      case 'mining.notify':
        this.handleNewJob(message.params);
        break;
      case 'mining.set_difficulty':
        this.handleSetDifficulty(message.params[0]);
        break;
      default:
        logger.debug('Unknown method:', message.method);
    }
  }
  
  /**
   * Handle pool response
   */
  handlePoolResponse(message) {
    if (message.error) {
      logger.error('Pool error:', message.error);
    }
  }
  
  /**
   * Handle new job
   */
  handleNewJob(params) {
    const [jobId, prevHash, coinbase1, coinbase2, merkleBranch, version, bits, time, clean] = params;
    
    this.currentJob = {
      jobId,
      prevHash,
      coinbase1,
      coinbase2,
      merkleBranch,
      version,
      bits,
      time,
      clean,
      target: this.bitsToTarget(bits)
    };
    
    // Send job to workers
    for (const worker of this.workers) {
      worker.postMessage({
        type: 'job',
        job: this.currentJob
      });
    }
    
    this.emit('new-job', { jobId });
  }
  
  /**
   * Handle set difficulty
   */
  handleSetDifficulty(difficulty) {
    logger.info(`Pool difficulty set to ${difficulty}`);
    this.emit('difficulty-changed', { difficulty });
  }
  
  /**
   * Start worker threads
   */
  startWorkers() {
    for (let i = 0; i < this.config.threads; i++) {
      const worker = new Worker(`
        const { parentPort } = require('worker_threads');
        const crypto = require('crypto');
        
        let currentJob = null;
        let mining = true;
        let hashCount = 0;
        
        parentPort.on('message', (msg) => {
          if (msg.type === 'job') {
            currentJob = msg.job;
          } else if (msg.type === 'stop') {
            mining = false;
          }
        });
        
        function mine() {
          if (!currentJob) {
            setTimeout(mine, 100);
            return;
          }
          
          const startNonce = Math.floor(Math.random() * 0xFFFFFFFF);
          let nonce = startNonce;
          const startTime = Date.now();
          
          while (mining) {
            // Build block header
            const header = Buffer.concat([
              Buffer.from(currentJob.version, 'hex'),
              Buffer.from(currentJob.prevHash, 'hex'),
              Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex'), // merkle root placeholder
              Buffer.from(currentJob.time, 'hex'),
              Buffer.from(currentJob.bits, 'hex'),
              Buffer.alloc(4)
            ]);
            
            // Write nonce
            header.writeUInt32LE(nonce, 76);
            
            // Calculate hash
            const hash = crypto.createHash('sha256').update(
              crypto.createHash('sha256').update(header).digest()
            ).digest();
            
            hashCount++;
            
            // Check if meets difficulty
            if (hash.compare(Buffer.from(currentJob.target, 'hex')) <= 0) {
              parentPort.postMessage({
                type: 'share',
                jobId: currentJob.jobId,
                nonce: nonce,
                time: currentJob.time,
                hash: hash.toString('hex')
              });
            }
            
            // Report hashrate every second
            if (Date.now() - startTime > 1000) {
              parentPort.postMessage({
                type: 'hashrate',
                count: hashCount
              });
              hashCount = 0;
            }
            
            nonce = (nonce + 1) >>> 0;
            
            // Restart at different nonce after 10M hashes
            if (nonce - startNonce > 10000000) {
              break;
            }
          }
          
          if (mining) {
            setImmediate(mine);
          }
        }
        
        mine();
      `, { eval: true });
      
      worker.on('message', (msg) => {
        if (msg.type === 'share') {
          this.submitShare(msg);
        } else if (msg.type === 'hashrate') {
          this.updateHashrate(i, msg.count);
        }
      });
      
      worker.on('error', (err) => {
        logger.error(`Worker ${i} error:`, err);
      });
      
      this.workers.push(worker);
    }
  }
  
  /**
   * Submit share to pool
   */
  submitShare(share) {
    this.stats.shares++;
    
    this.sendToPool({
      id: 100 + this.stats.shares,
      method: 'mining.submit',
      params: [
        this.config.wallet,
        share.jobId,
        share.time,
        share.nonce.toString(16).padStart(8, '0')
      ]
    });
    
    this.emit('share-submitted', {
      jobId: share.jobId,
      hash: share.hash
    });
  }
  
  /**
   * Update hashrate from worker
   */
  updateHashrate(workerId, count) {
    if (!this.workerHashrates) {
      this.workerHashrates = new Array(this.config.threads).fill(0);
    }
    
    this.workerHashrates[workerId] = count;
    
    // Calculate total hashrate
    this.stats.hashrate = this.workerHashrates.reduce((a, b) => a + b, 0);
  }
  
  /**
   * Send message to pool
   */
  sendToPool(message) {
    if (this.socket && this.connected) {
      this.socket.write(JSON.stringify(message) + '\n');
    }
  }
  
  /**
   * Convert bits to target
   */
  bitsToTarget(bits) {
    const bitsHex = bits;
    const exponent = parseInt(bitsHex.substring(0, 2), 16);
    const coefficient = parseInt(bitsHex.substring(2), 16);
    const target = coefficient * Math.pow(256, exponent - 3);
    return target.toString(16).padStart(64, '0');
  }
  
  /**
   * Start stats reporting
   */
  startStatsReporting() {
    setInterval(() => {
      const uptime = Math.floor((Date.now() - this.stats.uptime) / 1000);
      const hashrate = this.formatHashrate(this.stats.hashrate);
      
      logger.info(`Hashrate: ${hashrate}, Shares: ${this.stats.accepted}/${this.stats.shares}, Uptime: ${uptime}s`);
      
      this.emit('stats', {
        hashrate: this.stats.hashrate,
        shares: this.stats.shares,
        accepted: this.stats.accepted,
        rejected: this.stats.rejected,
        uptime: uptime
      });
    }, 10000); // Every 10 seconds
  }
  
  /**
   * Format hashrate
   */
  formatHashrate(hashrate) {
    if (hashrate > 1e9) return `${(hashrate / 1e9).toFixed(2)} GH/s`;
    if (hashrate > 1e6) return `${(hashrate / 1e6).toFixed(2)} MH/s`;
    if (hashrate > 1e3) return `${(hashrate / 1e3).toFixed(2)} KH/s`;
    return `${hashrate.toFixed(2)} H/s`;
  }
  
  /**
   * Stop mining
   */
  async stop() {
    logger.info('Stopping miner...');
    
    // Stop workers
    for (const worker of this.workers) {
      worker.postMessage({ type: 'stop' });
      await worker.terminate();
    }
    
    // Close pool connection
    if (this.socket) {
      this.socket.destroy();
    }
    
    this.emit('stopped');
  }
  
  /**
   * Get current stats
   */
  getStats() {
    return {
      ...this.stats,
      pool: this.config.pool,
      wallet: this.config.wallet,
      threads: this.config.threads,
      algorithm: this.config.algorithm
    };
  }
}

/**
 * Create simple CPU miner instance
 */
function createSimpleCPUMiner(config) {
  return new SimpleCPUMiner(config);
}

module.exports = SimpleCPUMiner;