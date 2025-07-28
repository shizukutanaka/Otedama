/**
 * Decentralized Stratum Proxy for Otedama P2P Pool
 * Implements stratum protocol for connecting mining software to P2P pool
 * 
 * Design principles:
 * - Carmack: Ultra-low latency job distribution
 * - Martin: Clean protocol abstraction
 * - Pike: Simple and efficient proxy design
 */

import { EventEmitter } from 'events';
import net from 'net';
import crypto from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';
import { AlgorithmFactory } from '../mining/algorithms.js';

const logger = createStructuredLogger('DecentralizedStratumProxy');

/**
 * Stratum message types
 */
const StratumMethod = {
  // Client to server
  SUBSCRIBE: 'mining.subscribe',
  AUTHORIZE: 'mining.authorize',
  SUBMIT: 'mining.submit',
  GET_TRANSACTIONS: 'mining.get_transactions',
  EXTRANONCE_SUBSCRIBE: 'mining.extranonce.subscribe',
  
  // Server to client
  SET_DIFFICULTY: 'mining.set_difficulty',
  NOTIFY: 'mining.notify',
  SET_EXTRANONCE: 'mining.set_extranonce'
};

/**
 * Mining job for stratum
 */
class StratumJob {
  constructor(id, prevHash, coinbase1, coinbase2, merkleBranch, version, nBits, nTime, cleanJobs) {
    this.id = id;
    this.prevHash = prevHash;
    this.coinbase1 = coinbase1;
    this.coinbase2 = coinbase2;
    this.merkleBranch = merkleBranch;
    this.version = version;
    this.nBits = nBits;
    this.nTime = nTime;
    this.cleanJobs = cleanJobs;
    this.submittedShares = new Set();
  }

  /**
   * Build coinbase transaction
   */
  buildCoinbase(extraNonce1, extraNonce2) {
    return Buffer.concat([
      Buffer.from(this.coinbase1, 'hex'),
      Buffer.from(extraNonce1, 'hex'),
      Buffer.from(extraNonce2, 'hex'),
      Buffer.from(this.coinbase2, 'hex')
    ]);
  }

  /**
   * Calculate merkle root
   */
  calculateMerkleRoot(coinbaseHash) {
    let hash = coinbaseHash;
    
    for (const branch of this.merkleBranch) {
      const combined = Buffer.concat([hash, Buffer.from(branch, 'hex')]);
      hash = crypto.createHash('sha256').update(
        crypto.createHash('sha256').update(combined).digest()
      ).digest();
    }
    
    return hash;
  }

  /**
   * Check if share is duplicate
   */
  isDuplicateShare(nonce, nTime, extraNonce2) {
    const shareId = `${nonce}:${nTime}:${extraNonce2}`;
    if (this.submittedShares.has(shareId)) {
      return true;
    }
    this.submittedShares.add(shareId);
    return false;
  }
}

/**
 * Stratum client connection
 */
class StratumClient extends EventEmitter {
  constructor(socket, proxy) {
    super();
    
    this.socket = socket;
    this.proxy = proxy;
    this.id = crypto.randomUUID();
    this.subscriptionId = null;
    this.extraNonce1 = null;
    this.authorized = false;
    this.workerName = null;
    this.difficulty = 1;
    this.shares = {
      accepted: 0,
      rejected: 0,
      stale: 0
    };
    this.lastActivity = Date.now();
    
    this.setupHandlers();
  }

  setupHandlers() {
    let buffer = '';
    
    this.socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      
      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch (error) {
          logger.debug('Invalid stratum message', {
            client: this.id,
            error: error.message
          });
          this.sendError(null, 'Parse error');
        }
      }
    });
    
    this.socket.on('error', (error) => {
      logger.debug('Client socket error', {
        client: this.id,
        error: error.message
      });
      this.destroy();
    });
    
    this.socket.on('close', () => {
      logger.info('Client disconnected', {
        client: this.id,
        worker: this.workerName,
        shares: this.shares
      });
      this.destroy();
    });
  }

  handleMessage(message) {
    this.lastActivity = Date.now();
    
    if (!message.method) {
      logger.debug('Invalid message: missing method', { client: this.id });
      return;
    }
    
    switch (message.method) {
      case StratumMethod.SUBSCRIBE:
        this.handleSubscribe(message);
        break;
        
      case StratumMethod.AUTHORIZE:
        this.handleAuthorize(message);
        break;
        
      case StratumMethod.SUBMIT:
        this.handleSubmit(message);
        break;
        
      case StratumMethod.GET_TRANSACTIONS:
        this.handleGetTransactions(message);
        break;
        
      case StratumMethod.EXTRANONCE_SUBSCRIBE:
        this.handleExtraNonceSubscribe(message);
        break;
        
      default:
        logger.debug('Unknown stratum method', {
          client: this.id,
          method: message.method
        });
        this.sendError(message.id, 'Unknown method');
    }
  }

  handleSubscribe(message) {
    // Generate unique subscription ID and extra nonce
    this.subscriptionId = crypto.randomBytes(8).toString('hex');
    this.extraNonce1 = crypto.randomBytes(4).toString('hex');
    
    // Send response
    this.sendResponse(message.id, [
      [
        ['mining.set_difficulty', this.subscriptionId],
        ['mining.notify', this.subscriptionId]
      ],
      this.extraNonce1,
      4 // extraNonce2 size
    ]);
    
    // Send initial difficulty
    this.sendDifficulty(this.proxy.config.initialDifficulty || 1);
    
    logger.info('Client subscribed', {
      client: this.id,
      extraNonce1: this.extraNonce1
    });
  }

  handleAuthorize(message) {
    const [user, pass] = message.params || [];
    
    if (!user) {
      this.sendResponse(message.id, false);
      return;
    }
    
    // Validate worker credentials
    // Format: walletAddress.workerName or just walletAddress
    const parts = user.split('.');
    const walletAddress = parts[0];
    const workerName = parts[1] || 'default';
    
    // Basic wallet validation
    if (!this.proxy.validateWalletAddress(walletAddress)) {
      logger.warn('Invalid wallet address', {
        client: this.id,
        address: walletAddress
      });
      this.sendResponse(message.id, false);
      return;
    }
    
    this.authorized = true;
    this.walletAddress = walletAddress;
    this.workerName = `${walletAddress}.${workerName}`;
    
    this.sendResponse(message.id, true);
    
    logger.info('Client authorized', {
      client: this.id,
      worker: this.workerName
    });
    
    // Send current job
    const currentJob = this.proxy.getCurrentJob();
    if (currentJob) {
      this.sendJob(currentJob, true);
    }
  }

  handleSubmit(message) {
    if (!this.authorized) {
      this.sendError(message.id, 'Not authorized');
      return;
    }
    
    const [workerName, jobId, extraNonce2, nTime, nonce, versionMask] = message.params || [];
    
    // Validate parameters
    if (!jobId || !extraNonce2 || !nTime || !nonce) {
      this.sendError(message.id, 'Missing parameters');
      this.shares.rejected++;
      return;
    }
    
    // Get job
    const job = this.proxy.getJob(jobId);
    if (!job) {
      this.sendError(message.id, 'Job not found');
      this.shares.stale++;
      return;
    }
    
    // Check for duplicate share
    if (job.isDuplicateShare(nonce, nTime, extraNonce2)) {
      this.sendError(message.id, 'Duplicate share');
      this.shares.rejected++;
      return;
    }
    
    // Validate share
    this.proxy.validateShare({
      client: this,
      job,
      extraNonce2,
      nTime,
      nonce,
      versionMask
    }).then(result => {
      if (result.valid) {
        this.shares.accepted++;
        this.sendResponse(message.id, true);
        
        // Adjust difficulty if needed
        this.proxy.adjustClientDifficulty(this);
      } else {
        this.shares.rejected++;
        this.sendError(message.id, result.reason || 'Invalid share');
      }
    }).catch(error => {
      logger.error('Share validation error', {
        client: this.id,
        error: error.message
      });
      this.shares.rejected++;
      this.sendError(message.id, 'Validation error');
    });
  }

  handleGetTransactions(message) {
    // Return empty array for now (used for merge mining)
    this.sendResponse(message.id, []);
  }

  handleExtraNonceSubscribe(message) {
    // Not supported in basic implementation
    this.sendResponse(message.id, false);
  }

  sendResponse(id, result) {
    const response = {
      id,
      result,
      error: null
    };
    this.send(response);
  }

  sendError(id, error) {
    const response = {
      id,
      result: null,
      error: [20, error, null]
    };
    this.send(response);
  }

  sendRequest(method, params) {
    const request = {
      id: null,
      method,
      params
    };
    this.send(request);
  }

  send(data) {
    try {
      this.socket.write(JSON.stringify(data) + '\n');
    } catch (error) {
      logger.error('Failed to send to client', {
        client: this.id,
        error: error.message
      });
      this.destroy();
    }
  }

  sendDifficulty(difficulty) {
    this.difficulty = difficulty;
    this.sendRequest(StratumMethod.SET_DIFFICULTY, [difficulty]);
  }

  sendJob(job, cleanJobs) {
    this.sendRequest(StratumMethod.NOTIFY, [
      job.id,
      job.prevHash,
      job.coinbase1,
      job.coinbase2,
      job.merkleBranch,
      job.version,
      job.nBits,
      job.nTime,
      cleanJobs
    ]);
  }

  destroy() {
    this.socket.destroy();
    this.emit('close');
  }
}

/**
 * Decentralized Stratum Proxy
 */
export class DecentralizedStratumProxy extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Server configuration
      port: config.port || 3333,
      host: config.host || '0.0.0.0',
      
      // Mining configuration
      algorithm: config.algorithm || 'sha256',
      initialDifficulty: config.initialDifficulty || 1,
      minDifficulty: config.minDifficulty || 0.001,
      maxDifficulty: config.maxDifficulty || 1000000,
      targetTime: config.targetTime || 10, // seconds per share
      
      // P2P configuration
      shareChain: config.shareChain || null,
      p2pNetwork: config.p2pNetwork || null,
      
      // Pool configuration
      poolAddress: config.poolAddress || null,
      poolFee: config.poolFee || 0.01,
      
      ...config
    };
    
    // Server state
    this.server = null;
    this.clients = new Map();
    this.jobs = new Map();
    this.currentJobId = null;
    this.jobCounter = 0;
    
    // Mining state
    this.algorithm = AlgorithmFactory.create(this.config.algorithm);
    this.blockTemplate = null;
    this.nextJobUpdate = 0;
    
    // Statistics
    this.stats = {
      connections: 0,
      disconnections: 0,
      sharesAccepted: 0,
      sharesRejected: 0,
      blocksFound: 0
    };
  }

  /**
   * Start stratum proxy server
   */
  async start() {
    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });
    
    this.server.on('error', (error) => {
      logger.error('Server error', { error: error.message });
      this.emit('error', error);
    });
    
    await new Promise((resolve, reject) => {
      this.server.listen(this.config.port, this.config.host, () => {
        logger.info('Stratum proxy started', {
          host: this.config.host,
          port: this.config.port,
          algorithm: this.config.algorithm
        });
        resolve();
      });
      
      this.server.on('error', reject);
    });
    
    // Start job update timer
    this.startJobUpdater();
    
    this.emit('started');
  }

  /**
   * Stop stratum proxy server
   */
  async stop() {
    // Disconnect all clients
    for (const client of this.clients.values()) {
      client.destroy();
    }
    this.clients.clear();
    
    // Stop server
    if (this.server) {
      await new Promise(resolve => {
        this.server.close(resolve);
      });
      this.server = null;
    }
    
    logger.info('Stratum proxy stopped');
    this.emit('stopped');
  }

  /**
   * Handle new client connection
   */
  handleConnection(socket) {
    const client = new StratumClient(socket, this);
    
    this.clients.set(client.id, client);
    this.stats.connections++;
    
    client.on('close', () => {
      this.clients.delete(client.id);
      this.stats.disconnections++;
    });
    
    logger.info('New stratum connection', {
      client: client.id,
      address: socket.remoteAddress
    });
    
    this.emit('client:connected', client);
  }

  /**
   * Validate wallet address
   */
  validateWalletAddress(address) {
    // Basic validation - override for specific coins
    if (!address || address.length < 20) return false;
    
    // Bitcoin-like address validation
    if (this.config.algorithm === 'sha256') {
      return /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address) ||
             /^bc1[a-z0-9]{39,59}$/.test(address);
    }
    
    // Generic validation
    return /^[a-zA-Z0-9]{20,}$/.test(address);
  }

  /**
   * Get current job
   */
  getCurrentJob() {
    return this.jobs.get(this.currentJobId);
  }

  /**
   * Get job by ID
   */
  getJob(jobId) {
    return this.jobs.get(jobId);
  }

  /**
   * Create new mining job
   */
  async createJob(blockTemplate, cleanJobs = false) {
    const jobId = (++this.jobCounter).toString(16).padStart(8, '0');
    
    // Build coinbase transaction with pool address
    const coinbase = this.buildCoinbase(blockTemplate);
    const coinbaseBuffer = Buffer.from(coinbase, 'hex');
    
    // Split coinbase for extranonce
    const extraNonceStart = coinbaseBuffer.length - 8; // Reserve 8 bytes for extranonce
    const coinbase1 = coinbaseBuffer.slice(0, extraNonceStart).toString('hex');
    const coinbase2 = coinbaseBuffer.slice(extraNonceStart + 8).toString('hex');
    
    const job = new StratumJob(
      jobId,
      blockTemplate.previousblockhash,
      coinbase1,
      coinbase2,
      blockTemplate.merklebranch || [],
      blockTemplate.version.toString(16).padStart(8, '0'),
      blockTemplate.bits,
      Math.floor(Date.now() / 1000).toString(16).padStart(8, '0'),
      cleanJobs
    );
    
    this.jobs.set(jobId, job);
    this.currentJobId = jobId;
    
    // Clean old jobs
    if (this.jobs.size > 10) {
      const oldJobs = Array.from(this.jobs.keys()).slice(0, -10);
      oldJobs.forEach(id => this.jobs.delete(id));
    }
    
    logger.info('Created new job', {
      jobId,
      previousHash: blockTemplate.previousblockhash.substring(0, 16) + '...',
      cleanJobs
    });
    
    return job;
  }

  /**
   * Build coinbase transaction
   */
  buildCoinbase(blockTemplate) {
    // This is a simplified coinbase - implement properly for each coin
    const height = blockTemplate.height;
    const value = blockTemplate.coinbasevalue;
    
    // Include height in coinbase (BIP34)
    const heightBuffer = Buffer.allocUnsafe(4);
    heightBuffer.writeUInt32LE(height);
    
    // Build script with pool message
    const message = Buffer.from('/Otedama P2Pool/', 'ascii');
    
    // Simple coinbase structure (customize per coin)
    const coinbase = Buffer.concat([
      Buffer.from('01000000', 'hex'), // Version
      Buffer.from('01', 'hex'), // Input count
      Buffer.alloc(32), // Previous output (null)
      Buffer.from('ffffffff', 'hex'), // Previous index
      Buffer.from([3 + heightBuffer.length + message.length]), // Script length
      Buffer.from('03', 'hex'), // Push opcode
      heightBuffer,
      message,
      Buffer.from('ffffffff', 'hex'), // Sequence
      Buffer.from('01', 'hex'), // Output count
      // Output will be filled with pool payout addresses from share chain
    ]);
    
    return coinbase.toString('hex');
  }

  /**
   * Validate submitted share
   */
  async validateShare(submission) {
    const { client, job, extraNonce2, nTime, nonce } = submission;
    
    try {
      // Build block header
      const coinbase = job.buildCoinbase(client.extraNonce1, extraNonce2);
      const coinbaseHash = crypto.createHash('sha256').update(
        crypto.createHash('sha256').update(coinbase).digest()
      ).digest();
      
      const merkleRoot = job.calculateMerkleRoot(coinbaseHash);
      
      // Construct block header
      const header = Buffer.concat([
        Buffer.from(job.version, 'hex'),
        Buffer.from(job.prevHash, 'hex').reverse(),
        merkleRoot.reverse(),
        Buffer.from(nTime, 'hex').reverse(),
        Buffer.from(job.nBits, 'hex').reverse(),
        Buffer.from(nonce, 'hex').reverse()
      ]);
      
      // Calculate hash
      const hash = crypto.createHash('sha256').update(
        crypto.createHash('sha256').update(header).digest()
      ).digest();
      
      const hashBigInt = BigInt('0x' + hash.reverse().toString('hex'));
      
      // Check share difficulty
      const shareDifficulty = this.calculateDifficulty(hashBigInt);
      
      if (shareDifficulty < client.difficulty) {
        return { valid: false, reason: 'Low difficulty share' };
      }
      
      // Valid share! Submit to share chain
      const share = {
        minerId: client.workerName,
        jobId: job.id,
        extraNonce1: client.extraNonce1,
        extraNonce2,
        nTime,
        nonce,
        difficulty: shareDifficulty,
        hash: hash.toString('hex')
      };
      
      // Add to share chain if available
      if (this.config.shareChain) {
        this.config.shareChain.addShare(share);
      }
      
      this.stats.sharesAccepted++;
      this.emit('share:accepted', share);
      
      // Check if this is a block
      const blockDifficulty = this.calculateDifficulty(hashBigInt);
      if (blockDifficulty >= this.blockTemplate?.difficulty) {
        logger.info('Block found!', {
          hash: hash.reverse().toString('hex'),
          height: this.blockTemplate.height,
          miner: client.workerName
        });
        
        this.stats.blocksFound++;
        this.emit('block:found', {
          hash: hash.reverse().toString('hex'),
          share,
          template: this.blockTemplate
        });
      }
      
      return { valid: true, difficulty: shareDifficulty };
      
    } catch (error) {
      logger.error('Share validation error', {
        client: client.id,
        error: error.message
      });
      return { valid: false, reason: 'Validation error' };
    }
  }

  /**
   * Calculate difficulty from hash
   */
  calculateDifficulty(hashBigInt) {
    const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
    return Number(maxTarget / hashBigInt);
  }

  /**
   * Adjust client difficulty based on share rate
   */
  adjustClientDifficulty(client) {
    const now = Date.now();
    const timeSinceLastShare = now - client.lastShareTime;
    client.lastShareTime = now;
    
    // Skip first share
    if (!timeSinceLastShare || timeSinceLastShare > 300000) return;
    
    // Calculate shares per minute
    const sharesPerMinute = 60000 / timeSinceLastShare;
    const targetSharesPerMinute = 60 / this.config.targetTime;
    
    // Adjust difficulty
    if (sharesPerMinute > targetSharesPerMinute * 1.5) {
      // Too many shares, increase difficulty
      const newDifficulty = Math.min(
        client.difficulty * 2,
        this.config.maxDifficulty
      );
      
      if (newDifficulty !== client.difficulty) {
        client.sendDifficulty(newDifficulty);
        logger.info('Increased client difficulty', {
          client: client.id,
          oldDifficulty: client.difficulty,
          newDifficulty
        });
      }
    } else if (sharesPerMinute < targetSharesPerMinute * 0.5) {
      // Too few shares, decrease difficulty
      const newDifficulty = Math.max(
        client.difficulty / 2,
        this.config.minDifficulty
      );
      
      if (newDifficulty !== client.difficulty) {
        client.sendDifficulty(newDifficulty);
        logger.info('Decreased client difficulty', {
          client: client.id,
          oldDifficulty: client.difficulty,
          newDifficulty
        });
      }
    }
  }

  /**
   * Update block template
   */
  async updateBlockTemplate(template) {
    this.blockTemplate = template;
    const job = await this.createJob(template, true);
    
    // Send to all authorized clients
    for (const client of this.clients.values()) {
      if (client.authorized) {
        client.sendJob(job, true);
      }
    }
    
    logger.info('Block template updated', {
      height: template.height,
      previousHash: template.previousblockhash.substring(0, 16) + '...'
    });
  }

  /**
   * Start job updater
   */
  startJobUpdater() {
    setInterval(() => {
      // Check if we need new jobs
      if (Date.now() > this.nextJobUpdate) {
        this.emit('job:needed');
        this.nextJobUpdate = Date.now() + 30000; // Request every 30 seconds
      }
      
      // Clean up inactive clients
      const timeout = 10 * 60 * 1000; // 10 minutes
      const now = Date.now();
      
      for (const [id, client] of this.clients) {
        if (now - client.lastActivity > timeout) {
          logger.info('Removing inactive client', { client: id });
          client.destroy();
        }
      }
    }, 5000);
  }

  /**
   * Get proxy statistics
   */
  getStats() {
    const clients = Array.from(this.clients.values());
    
    return {
      ...this.stats,
      activeClients: clients.length,
      authorizedClients: clients.filter(c => c.authorized).length,
      totalHashrate: this.estimateHashrate(),
      currentJob: this.currentJobId,
      jobCount: this.jobs.size
    };
  }

  /**
   * Estimate network hashrate
   */
  estimateHashrate() {
    let totalHashrate = 0;
    
    for (const client of this.clients.values()) {
      if (client.authorized && client.shares.accepted > 0) {
        // Estimate based on share difficulty and rate
        const sharesPerSecond = client.shares.accepted / ((Date.now() - client.connectedAt) / 1000);
        const hashrate = sharesPerSecond * client.difficulty * Math.pow(2, 32);
        totalHashrate += hashrate;
      }
    }
    
    return totalHashrate;
  }
}

export default DecentralizedStratumProxy;