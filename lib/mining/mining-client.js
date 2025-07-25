/**
 * Mining Client - Otedama
 * Client for connecting to mining pools
 * 
 * Features:
 * - Multi-algorithm support
 * - CPU/GPU/ASIC mining
 * - Auto-reconnect
 * - Performance monitoring
 * - Stratum protocol support
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import net from 'net';
import crypto from 'crypto';
import os from 'os';
import { Worker } from 'worker_threads';
import { GPUMiningManager } from './gpu-mining.js';
import { ASICMiningManager } from './asic-mining.js';

const logger = createLogger('MiningClient');

/**
 * Mining Client
 */
export class MiningClient extends EventEmitter {
  constructor(config = {}) {
    super();
    
    // Configuration
    this.poolUrl = config.poolUrl || 'stratum+tcp://localhost:3333';
    this.poolUser = config.poolUser || 'wallet.worker';
    this.poolPassword = config.poolPassword || 'x';
    this.algorithm = config.algorithm || 'sha256';
    
    // Mining configuration
    this.threads = config.threads || os.cpus().length;
    this.cpuEnabled = config.cpuEnabled !== false;
    this.gpuEnabled = config.gpuEnabled || false;
    this.asicEnabled = config.asicEnabled || false;
    this.intensity = config.intensity || 20;
    this.temperatureLimit = config.temperatureLimit || 85;
    this.autoTune = config.autoTune !== false;
    
    // Connection state
    this.socket = null;
    this.connected = false;
    this.subscribed = false;
    this.authorized = false;
    this.extraNonce1 = null;
    this.extraNonce2Size = 4;
    this.difficulty = 1;
    
    // Job state
    this.currentJob = null;
    this.jobQueue = [];
    
    // Mining state
    this.mining = false;
    this.workers = [];
    this.nonce = 0;
    
    // Statistics
    this.stats = {
      startTime: Date.now(),
      sharesSubmitted: 0,
      sharesAccepted: 0,
      sharesRejected: 0,
      hashrate: 0,
      temperature: 0
    };
    
    // Timers
    this.reconnectTimer = null;
    this.statsTimer = null;
  }
  
  /**
   * Initialize mining client
   */
  async initialize() {
    logger.info('Initializing mining client...');
    
    // Parse pool URL
    const match = this.poolUrl.match(/^(\w+)\+tcp:\/\/([^:]+):(\d+)$/);
    if (!match) {
      throw new Error('Invalid pool URL format');
    }
    
    this.poolProtocol = match[1];
    this.poolHost = match[2];
    this.poolPort = parseInt(match[3]);
    
    // Initialize mining workers
    if (this.cpuEnabled) {
      await this.initializeCPUWorkers();
    }
    
    if (this.gpuEnabled) {
      await this.initializeGPUWorkers();
    }
    
    if (this.asicEnabled) {
      await this.initializeASICWorkers();
    }
    
    logger.info('Mining client initialized');
  }
  
  /**
   * Start mining
   */
  async start() {
    logger.info('Starting mining client...');
    
    // Connect to pool
    await this.connectToPool();
    
    // Start statistics timer
    this.statsTimer = setInterval(() => {
      this.updateStatistics();
      this.logStatistics();
    }, 10000); // Every 10 seconds
    
    logger.info('Mining client started');
  }
  
  /**
   * Connect to pool
   */
  async connectToPool() {
    return new Promise((resolve, reject) => {
      logger.info(`Connecting to pool ${this.poolHost}:${this.poolPort}...`);
      
      this.socket = net.createConnection({
        host: this.poolHost,
        port: this.poolPort
      }, () => {
        logger.info('Connected to pool');
        this.connected = true;
        
        // Subscribe to pool
        this.sendMessage('mining.subscribe', [
          'Otedama/1.0.0',
          null,
          this.poolHost,
          this.poolPort
        ]);
        
        resolve();
      });
      
      // Message buffer
      let messageBuffer = '';
      
      this.socket.on('data', data => {
        messageBuffer += data.toString();
        
        // Process complete messages
        let newlineIndex;
        while ((newlineIndex = messageBuffer.indexOf('\n')) !== -1) {
          const message = messageBuffer.slice(0, newlineIndex);
          messageBuffer = messageBuffer.slice(newlineIndex + 1);
          
          try {
            const parsed = JSON.parse(message);
            this.handlePoolMessage(parsed);
          } catch (error) {
            logger.error('Invalid pool message:', error);
          }
        }
      });
      
      this.socket.on('error', error => {
        logger.error('Pool connection error:', error);
        this.connected = false;
        reject(error);
      });
      
      this.socket.on('close', () => {
        logger.warn('Pool connection closed');
        this.connected = false;
        this.subscribed = false;
        this.authorized = false;
        
        // Auto-reconnect
        if (!this.reconnectTimer) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connectToPool().catch(error => {
              logger.error('Reconnection failed:', error);
            });
          }, 5000);
        }
      });
    });
  }
  
  /**
   * Handle pool message
   */
  handlePoolMessage(message) {
    if (message.id !== null) {
      // Response to our request
      this.handlePoolResponse(message);
    } else if (message.method) {
      // Notification from pool
      this.handlePoolNotification(message);
    }
  }
  
  /**
   * Handle pool response
   */
  handlePoolResponse(message) {
    const { id, result, error } = message;
    
    if (error) {
      logger.error('Pool error:', error);
      return;
    }
    
    // Handle subscribe response
    if (!this.subscribed && Array.isArray(result) && result.length >= 3) {
      this.subscribed = true;
      this.extraNonce1 = result[1];
      this.extraNonce2Size = result[2];
      
      logger.info(`Subscribed to pool. ExtraNonce1: ${this.extraNonce1}`);
      
      // Authorize
      this.sendMessage('mining.authorize', [this.poolUser, this.poolPassword]);
    }
    
    // Handle authorize response
    else if (!this.authorized && result === true) {
      this.authorized = true;
      logger.info('Authorized with pool');
      
      // Start mining
      this.startMining();
    }
    
    // Handle share submission response
    else if (result === true) {
      this.stats.sharesAccepted++;
      logger.info('Share accepted!');
      this.emit('share', {
        accepted: true,
        difficulty: this.difficulty
      });
    } else if (result === false) {
      this.stats.sharesRejected++;
      logger.warn('Share rejected');
      this.emit('share', {
        accepted: false,
        difficulty: this.difficulty
      });
    }
  }
  
  /**
   * Handle pool notification
   */
  handlePoolNotification(message) {
    const { method, params } = message;
    
    switch (method) {
      case 'mining.notify':
        this.handleNewJob(params);
        break;
        
      case 'mining.set_difficulty':
        this.handleSetDifficulty(params);
        break;
        
      case 'mining.ping':
        // Respond to ping
        this.sendMessage('mining.pong', []);
        break;
        
      default:
        logger.debug('Unknown notification:', method);
    }
  }
  
  /**
   * Handle new job
   */
  handleNewJob(params) {
    const [jobId, prevHash, coinbase1, coinbase2, merkleBranches, version, bits, time, cleanJobs] = params;
    
    this.currentJob = {
      jobId,
      prevHash,
      coinbase1,
      coinbase2,
      merkleBranches,
      version,
      bits,
      time: parseInt(time, 16),
      cleanJobs
    };
    
    logger.info(`New job received: ${jobId}`);
    
    // Reset nonce
    this.nonce = 0;
    
    // Notify workers
    this.broadcastToWorkers({
      type: 'newJob',
      job: this.currentJob,
      extraNonce1: this.extraNonce1,
      extraNonce2Size: this.extraNonce2Size,
      difficulty: this.difficulty
    });
  }
  
  /**
   * Handle set difficulty
   */
  handleSetDifficulty(params) {
    this.difficulty = params[0];
    logger.info(`Difficulty set to: ${this.difficulty}`);
    
    // Notify workers
    this.broadcastToWorkers({
      type: 'setDifficulty',
      difficulty: this.difficulty
    });
  }
  
  /**
   * Send message to pool
   */
  sendMessage(method, params, id = null) {
    if (!this.connected) {
      logger.warn('Not connected to pool');
      return;
    }
    
    const message = {
      id: id || Date.now(),
      method,
      params
    };
    
    this.socket.write(JSON.stringify(message) + '\n');
  }
  
  /**
   * Initialize CPU workers
   */
  async initializeCPUWorkers() {
    logger.info(`Initializing ${this.threads} CPU mining threads...`);
    
    for (let i = 0; i < this.threads; i++) {
      const worker = new Worker(new URL('./workers/cpu-worker.js', import.meta.url), {
        workerData: {
          threadId: i,
          algorithm: this.algorithm
        }
      });
      
      worker.on('message', message => {
        this.handleWorkerMessage(worker, message);
      });
      
      worker.on('error', error => {
        logger.error(`CPU worker ${i} error:`, error);
      });
      
      this.workers.push({
        type: 'cpu',
        id: i,
        worker,
        hashrate: 0
      });
    }
  }
  
  /**
   * Initialize GPU workers
   */
  async initializeGPUWorkers() {
    logger.info('Initializing GPU mining...');
    
    this.gpuManager = new GPUMiningManager({
      algorithm: this.algorithm,
      intensity: this.intensity,
      temperatureLimit: this.temperatureLimit
    });
    
    const initialized = await this.gpuManager.initialize();
    
    if (initialized) {
      // Handle GPU share events
      this.gpuManager.on('share', (share) => {
        this.submitShare({
          extraNonce2: crypto.randomBytes(this.extraNonce2Size).toString('hex'),
          time: Math.floor(Date.now() / 1000),
          nonce: share.nonce
        });
      });
      
      // Handle GPU stats
      this.gpuManager.on('stats', (stats) => {
        this.stats.hashrate = (this.stats.hashrate || 0) + stats.hashrate;
        this.stats.temperature = Math.max(this.stats.temperature || 0, stats.temperature);
      });
    }
  }
  
  /**
   * Initialize ASIC workers
   */
  async initializeASICWorkers() {
    logger.info('Initializing ASIC mining...');
    
    this.asicManager = new ASICMiningManager();
    await this.asicManager.initialize();
    
    if (this.asicManager.devices.length > 0) {
      // Configure pool on all ASICs
      await this.asicManager.configurePool(
        this.poolUrl,
        this.poolUser,
        this.poolPassword
      );
      
      // Handle ASIC stats
      this.asicManager.on('stats:updated', (stats) => {
        this.stats.hashrate = (this.stats.hashrate || 0) + stats.totalHashrate;
      });
    } else {
      logger.warn('No ASIC devices found');
    }
  }
  
  /**
   * Start mining
   */
  startMining() {
    if (!this.authorized) {
      logger.warn('Not authorized to mine');
      return;
    }
    
    if (this.mining) {
      logger.warn('Already mining');
      return;
    }
    
    this.mining = true;
    this.stats.startTime = Date.now();
    
    logger.info('Mining started');
    
    // Start all workers
    this.broadcastToWorkers({
      type: 'start'
    });
    
    // Start GPU mining if enabled
    if (this.gpuEnabled && this.gpuManager) {
      await this.gpuManager.start(this.currentJob, this.difficulty);
    }
    
    // Start ASIC mining if enabled
    if (this.asicEnabled && this.asicManager) {
      await this.asicManager.start();
    }
  }
  
  /**
   * Stop mining
   */
  async stop() {
    logger.info('Stopping mining client...');
    
    this.mining = false;
    
    // Stop workers
    this.broadcastToWorkers({
      type: 'stop'
    });
    
    // Stop GPU mining
    if (this.gpuManager) {
      await this.gpuManager.stop();
    }
    
    // Stop ASIC mining
    if (this.asicManager) {
      await this.asicManager.stop();
    }
    
    // Close workers
    for (const workerInfo of this.workers) {
      await workerInfo.worker.terminate();
    }
    this.workers = [];
    
    // Cancel timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    
    // Close socket
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    
    logger.info('Mining client stopped');
  }
  
  /**
   * Handle worker message
   */
  handleWorkerMessage(worker, message) {
    switch (message.type) {
      case 'share':
        this.submitShare(message.share);
        break;
        
      case 'hashrate':
        const workerInfo = this.workers.find(w => w.worker === worker);
        if (workerInfo) {
          workerInfo.hashrate = message.hashrate;
        }
        break;
        
      case 'error':
        logger.error('Worker error:', message.error);
        break;
    }
  }
  
  /**
   * Submit share to pool
   */
  submitShare(share) {
    if (!this.currentJob) {
      logger.warn('No current job');
      return;
    }
    
    this.stats.sharesSubmitted++;
    
    // Submit to pool
    this.sendMessage('mining.submit', [
      this.poolUser,
      this.currentJob.jobId,
      share.extraNonce2,
      share.time.toString(16),
      share.nonce
    ]);
    
    logger.debug(`Submitted share: ${share.nonce}`);
  }
  
  /**
   * Broadcast message to all workers
   */
  broadcastToWorkers(message) {
    for (const workerInfo of this.workers) {
      workerInfo.worker.postMessage(message);
    }
  }
  
  /**
   * Update statistics
   */
  updateStatistics() {
    // Calculate total hashrate
    this.stats.hashrate = this.workers.reduce((total, w) => total + w.hashrate, 0);
    
    // Update temperature (mock)
    this.stats.temperature = 65 + Math.random() * 10;
  }
  
  /**
   * Log statistics
   */
  logStatistics() {
    const runtime = (Date.now() - this.stats.startTime) / 1000;
    const shareRate = this.stats.sharesAccepted / runtime * 60;
    const rejectRate = this.stats.sharesRejected / this.stats.sharesSubmitted * 100 || 0;
    
    logger.info('==== Mining Statistics ====');
    logger.info(`Hashrate: ${this.formatHashrate(this.stats.hashrate)}`);
    logger.info(`Shares: ${this.stats.sharesAccepted}/${this.stats.sharesSubmitted} (${rejectRate.toFixed(2)}% rejected)`);
    logger.info(`Share rate: ${shareRate.toFixed(2)} shares/min`);
    logger.info(`Temperature: ${this.stats.temperature.toFixed(1)}°C`);
    logger.info(`Runtime: ${this.formatDuration(runtime)}`);
    logger.info('=========================');
  }
  
  /**
   * Format hashrate
   */
  formatHashrate(hashrate) {
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s'];
    let unitIndex = 0;
    let value = hashrate;
    
    while (value >= 1000 && unitIndex < units.length - 1) {
      value /= 1000;
      unitIndex++;
    }
    
    return `${value.toFixed(2)} ${units[unitIndex]}`;
  }
  
  /**
   * Format duration
   */
  formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    return `${hours}h ${minutes}m ${secs}s`;
  }
}

export default MiningClient;
