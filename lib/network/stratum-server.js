/**
 * Stratum Server - Otedama
 * Simple and efficient Stratum V1 implementation
 */

import net from 'net';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';

const logger = createLogger('StratumServer');

export class StratumServer extends EventEmitter {
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
    
    // Performance optimization
    this.messageQueue = new Map();
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
  
  async start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer({
        noDelay: true,
        keepAlive: true,
        keepAliveInitialDelay: 30000
      });
      
      this.server.on('connection', (socket) => {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30000);
        this.handleConnection(socket);
      });
      
      this.server.on('error', (err) => {
        logger.error('Server error:', err);
        reject(err);
      });
      
      this.server.maxConnections = this.options.maxConnections || 10000;
      
      this.server.listen(this.options.port, this.options.host, () => {
        logger.info(`Stratum server listening on ${this.options.host}:${this.options.port}`);
        resolve();
      });
    });
  }
  
  async stop() {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    
    return new Promise((resolve) => {
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
      lastActivity: Date.now(),
      buffer: ''
    };
    
    this.miners.set(minerId, miner);
    this.stats.connections++;
    this.stats.miners++;
    
    logger.info(`New connection from ${socket.remoteAddress}, assigned ID: ${minerId}`);
    
    socket.setEncoding('utf8');
    
    socket.on('data', (data) => {
      miner.buffer += data;
      
      let idx;
      while ((idx = miner.buffer.indexOf('\n')) !== -1) {
        const line = miner.buffer.substring(0, idx).trim();
        miner.buffer = miner.buffer.substring(idx + 1);
        
        if (line) {
          this.handleMessage(miner, line);
        }
      }
    });
    
    socket.on('error', (err) => {
      logger.error(`Socket error for miner ${minerId}:`, err.message);
    });
    
    socket.on('close', () => {
      this.miners.delete(minerId);
      this.stats.miners--;
      logger.info(`Miner ${minerId} disconnected`);
      this.emit('client:disconnected', { id: minerId });
    });
  }
  
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
      logger.error('Failed to parse message:', err.message);
    }
  }
  
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
    this.sendDifficulty(miner);
    
    if (this.currentJob) {
      this.sendJob(miner, this.currentJob);
    }
    
    logger.info(`Miner ${miner.id} subscribed`);
  }
  
  handleAuthorize(miner, data) {
    const [address, password] = data.params;
    
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
    this.emit('client:connected', { 
      id: miner.id,
      address,
      worker: miner.worker,
      ip: miner.socket.remoteAddress
    });
  }
  
  handleSubmit(miner, data) {
    if (!miner.authorized) {
      this.sendError(miner, data.id, 'Not authorized');
      return;
    }
    
    const [worker, jobId, extraNonce2, ntime, nonce] = data.params;
    
    miner.shares++;
    this.stats.shares++;
    
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
    
    this.emit('share:submitted', {
      clientId: miner.id,
      share,
      valid: true, // Validation would be done externally
      difficulty: miner.difficulty
    });
    
    // For now, always accept shares
    miner.validShares++;
    this.stats.validShares++;
    
    const response = {
      id: data.id,
      result: true,
      error: null
    };
    
    this.send(miner, response);
  }
  
  handleGetTransactions(miner, data) {
    const response = {
      id: data.id,
      result: [],
      error: null
    };
    
    this.send(miner, response);
  }
  
  sendDifficulty(miner) {
    const message = {
      id: null,
      method: 'mining.set_difficulty',
      params: [miner.difficulty]
    };
    
    this.send(miner, message);
  }
  
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
  
  broadcastJob(job, clean = false) {
    this.currentJob = job;
    this.jobs.set(job.id, job);
    
    if (this.jobs.size > 10) {
      const oldJobs = Array.from(this.jobs.keys()).slice(0, -10);
      oldJobs.forEach(id => this.jobs.delete(id));
    }
    
    for (const miner of this.miners.values()) {
      if (miner.subscribed) {
        this.sendJob(miner, job, clean);
      }
    }
    
    logger.info(`Broadcasted job ${job.id} to ${this.miners.size} miners`);
  }
  
  async broadcast(message, excludeId = null) {
    for (const miner of this.miners.values()) {
      if (miner.id !== excludeId && miner.subscribed) {
        this.send(miner, message);
      }
    }
  }
  
  send(miner, message) {
    const data = JSON.stringify(message) + '\n';
    try {
      if (!miner.socket.destroyed) {
        miner.socket.write(data);
      }
    } catch (err) {
      logger.error(`Failed to send message to miner ${miner.id}:`, err.message);
    }
  }
  
  sendError(miner, id, message) {
    const response = {
      id,
      result: null,
      error: [20, message, null]
    };
    
    this.send(miner, response);
  }
  
  generateExtraNonce1() {
    const buffer = Buffer.allocUnsafe(this.options.extraNonce1Size);
    buffer.writeUInt32BE(this.extraNonce1Counter++, 0);
    return buffer.toString('hex');
  }
  
  disconnectClient(clientId) {
    const miner = this.miners.get(clientId);
    if (miner && miner.socket) {
      miner.socket.destroy();
    }
  }
  
  getStats() {
    return {
      ...this.stats,
      uptime: process.uptime(),
      activeConnections: this.miners.size,
      miners: Array.from(this.miners.values()).map(m => ({
        id: m.id,
        address: m.address,
        worker: m.worker,
        difficulty: m.difficulty,
        shares: m.shares,
        validShares: m.validShares
      }))
    };
  }
}

export default StratumServer;
