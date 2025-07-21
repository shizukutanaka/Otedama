/**
 * Optimized Mining Pool for Otedama
 * High-performance P2P mining with multi-algorithm support
 * 
 * DEPRECATED: This implementation has been consolidated into lib/mining/index.js
 * This file is maintained for backward compatibility only.
 * Please migrate to ConsolidatedMiningPool for new features and better performance.
 * 
 * Optimizations:
 * - Zero-copy buffer operations (Carmack)
 * - Clean modular architecture (Martin)
 * - Simple, clear interfaces (Pike)
 */

import { getLogger } from '../core/logger.js';

const logger = getLogger('MiningPoolOptimized');
logger.warn('lib/mining/pool-optimized.js is deprecated. Please use lib/mining/index.js');

// Re-export from compatibility layer
export { MiningPoolOptimized, ALGORITHMS } from './compatibility.js';
export default from './compatibility.js';

// Keep the algorithm definitions for reference
/*

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { performance } from 'perf_hooks';
import { createHash, randomBytes } from 'crypto';

// Algorithm definitions with optimized parameters
const MINING_ALGORITHMS = Object.freeze({
  SHA256: {
    name: 'sha256',
    currencies: ['BTC'],
    difficulty: 0x1d00ffff,
    blockTime: 600, // 10 minutes
    reward: 6.25,
    hardwareTypes: ['ASIC']
  },
  SCRYPT: {
    name: 'scrypt',
    currencies: ['LTC', 'DOGE'],
    difficulty: 0x1e0ffff0,
    blockTime: 150, // 2.5 minutes
    reward: 12.5,
    hardwareTypes: ['ASIC', 'GPU']
  },
  ETHASH: {
    name: 'ethash', 
    currencies: ['ETC'],
    difficulty: 0x00000000ffff0000,
    blockTime: 13, // 13 seconds
    reward: 3.2,
    hardwareTypes: ['GPU']
  },
  RANDOMX: {
    name: 'randomx',
    currencies: ['XMR'],
    difficulty: 0x00000000ffffffff,
    blockTime: 120, // 2 minutes
    reward: 0.6,
    hardwareTypes: ['CPU', 'GPU']
  },
  KAWPOW: {
    name: 'kawpow',
    currencies: ['RVN'],
    difficulty: 0x00000000ffff0000,
    blockTime: 60, // 1 minute
    reward: 5000,
    hardwareTypes: ['GPU']
  },
  X11: {
    name: 'x11',
    currencies: ['DASH'],
    difficulty: 0x1e0ffff0,
    blockTime: 156, // 2.6 minutes
    reward: 1.67,
    hardwareTypes: ['ASIC']
  },
  EQUIHASH: {
    name: 'equihash',
    currencies: ['ZEC', 'FLUX'],
    difficulty: 0x1f07ffff,
    blockTime: 75, // 1.25 minutes
    reward: 3.125,
    hardwareTypes: ['GPU', 'ASIC']
  },
  AUTOLYKOS2: {
    name: 'autolykos2',
    currencies: ['ERGO'],
    difficulty: 0x1d00ffff,
    blockTime: 120, // 2 minutes
    reward: 67.5,
    hardwareTypes: ['GPU']
  },
  KHEAVYHASH: {
    name: 'kheavyhash',
    currencies: ['KAS'],
    difficulty: 0x1e00ffff,
    blockTime: 1, // 1 second
    reward: 100,
    hardwareTypes: ['ASIC']
  },
  BLAKE3: {
    name: 'blake3',
    currencies: ['ALPH'],
    difficulty: 0x1d00ffff,
    blockTime: 16, // 16 seconds
    reward: 1.0,
    hardwareTypes: ['GPU']
  }
});

/**
 * High-performance share validator using worker threads
 */
class ShareValidator {
  constructor(workerCount = 4) {
    this.workers = [];
    this.queue = [];
    this.processing = 0;
    this.maxQueue = 10000;
    
    // Initialize workers
    for (let i = 0; i < workerCount; i++) {
      this.createWorker();
    }
  }
  
  createWorker() {
    const worker = new Worker(`
      const { parentPort } = require('worker_threads');
      const crypto = require('crypto');
      
      parentPort.on('message', ({ id, jobData, nonce, hash, difficulty }) => {
        try {
          // Fast validation logic here
          const isValid = this.validateShare(jobData, nonce, hash, difficulty);
          parentPort.postMessage({ id, valid: isValid });
        } catch (error) {
          parentPort.postMessage({ id, error: error.message });
        }
      });
      
      // Optimized share validation
      function validateShare(jobData, nonce, hash, difficulty) {
        // Implementation depends on algorithm
        // This is a simplified version
        const target = this.difficultyToTarget(difficulty);
        const hashBuffer = Buffer.from(hash, 'hex');
        const targetBuffer = Buffer.from(target, 'hex');
        
        return hashBuffer.compare(targetBuffer) <= 0;
      }
      
      function difficultyToTarget(difficulty) {
        // Convert difficulty to target (simplified)
        const base = '00000000ffff0000000000000000000000000000000000000000000000000000';
        const target = BigInt('0x' + base) / BigInt(difficulty);
        return target.toString(16).padStart(64, '0');
      }
    `, { eval: true });
    
    worker.on('message', (result) => {
      this.handleWorkerResult(result);
    });
    
    worker.on('error', (error) => {
      console.error('Share validator worker error:', error);
    });
    
    this.workers.push(worker);
  }
  
  async validateShare(jobData, nonce, hash, difficulty) {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= this.maxQueue) {
        reject(new Error('Validation queue full'));
        return;
      }
      
      const id = randomBytes(8).toString('hex');
      const request = {
        id,
        jobData,
        nonce,
        hash,
        difficulty,
        resolve,
        reject,
        timestamp: performance.now()
      };
      
      this.queue.push(request);
      this.processQueue();
    });
  }
  
  processQueue() {
    if (this.queue.length === 0 || this.processing >= this.workers.length) {
      return;
    }
    
    const request = this.queue.shift();
    const worker = this.workers[this.processing % this.workers.length];
    
    this.processing++;
    
    // Send to worker
    worker.postMessage({
      id: request.id,
      jobData: request.jobData,
      nonce: request.nonce,
      hash: request.hash,
      difficulty: request.difficulty
    });
    
    // Store request for result handling
    this.pendingRequests = this.pendingRequests || new Map();
    this.pendingRequests.set(request.id, request);
  }
  
  handleWorkerResult(result) {
    this.processing--;
    
    const request = this.pendingRequests.get(result.id);
    if (!request) return;
    
    this.pendingRequests.delete(result.id);
    
    if (result.error) {
      request.reject(new Error(result.error));
    } else {
      request.resolve(result.valid);
    }
    
    // Process next item in queue
    this.processQueue();
  }
  
  getStats() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      workers: this.workers.length,
      pendingRequests: this.pendingRequests?.size || 0
    };
  }
  
  async shutdown() {
    for (const worker of this.workers) {
      await worker.terminate();
    }
  }
}

/**
 * Optimized connection pool for high-concurrency mining
 */
class MinerConnectionPool {
  constructor(maxConnections = 50000) {
    this.maxConnections = maxConnections;
    this.connections = new Map(); // Fast lookup
    this.activeMiners = new Set(); // Fast iteration
    this.inactiveMiners = new Set();
    
    // Performance tracking
    this.stats = {
      totalConnections: 0,
      activeConnections: 0,
      connectionsPerSecond: 0,
      lastStatsUpdate: Date.now()
    };
    
    // Connection recycling
    this.connectionPool = [];
    this.maxPoolSize = 1000;
    
    this.startStatsUpdater();
  }
  
  addConnection(minerId, connectionData) {
    if (this.connections.size >= this.maxConnections) {
      throw new Error('Connection limit exceeded');
    }
    
    // Reuse connection object if available
    let connection = this.connectionPool.pop();
    if (!connection) {
      connection = {};
    }
    
    // Reset connection data
    Object.assign(connection, {
      id: minerId,
      ...connectionData,
      connected: true,
      lastSeen: Date.now(),
      shares: 0,
      hashrate: 0
    });
    
    this.connections.set(minerId, connection);
    this.activeMiners.add(minerId);
    this.inactiveMiners.delete(minerId);
    
    this.stats.totalConnections++;
    this.stats.activeConnections++;
    
    return connection;
  }
  
  removeConnection(minerId) {
    const connection = this.connections.get(minerId);
    if (!connection) return false;
    
    this.connections.delete(minerId);
    this.activeMiners.delete(minerId);
    this.inactiveMiners.delete(minerId);
    
    // Recycle connection object
    if (this.connectionPool.length < this.maxPoolSize) {
      this.connectionPool.push(connection);
    }
    
    this.stats.activeConnections--;
    
    return true;
  }
  
  getConnection(minerId) {
    return this.connections.get(minerId);
  }
  
  updateConnection(minerId, updates) {
    const connection = this.connections.get(minerId);
    if (!connection) return false;
    
    Object.assign(connection, updates, { lastSeen: Date.now() });
    
    // Move between active/inactive as needed
    if (updates.connected === false && this.activeMiners.has(minerId)) {
      this.activeMiners.delete(minerId);
      this.inactiveMiners.add(minerId);
    } else if (updates.connected === true && this.inactiveMiners.has(minerId)) {
      this.inactiveMiners.delete(minerId);
      this.activeMiners.add(minerId);
    }
    
    return true;
  }
  
  // Fast iteration over active miners
  forEachActiveMiner(callback) {
    for (const minerId of this.activeMiners) {
      const connection = this.connections.get(minerId);
      if (connection) {
        callback(connection, minerId);
      }
    }
  }
  
  // Cleanup inactive connections
  cleanupInactive(maxAge = 300000) { // 5 minutes
    const cutoff = Date.now() - maxAge;
    const toRemove = [];
    
    for (const minerId of this.inactiveMiners) {
      const connection = this.connections.get(minerId);
      if (connection && connection.lastSeen < cutoff) {
        toRemove.push(minerId);
      }
    }
    
    for (const minerId of toRemove) {
      this.removeConnection(minerId);
    }
    
    return toRemove.length;
  }
  
  startStatsUpdater() {
    setInterval(() => {
      const now = Date.now();
      const elapsed = (now - this.stats.lastStatsUpdate) / 1000;
      
      this.stats.connectionsPerSecond = this.stats.totalConnections / elapsed;
      this.stats.lastStatsUpdate = now;
      this.stats.totalConnections = 0; // Reset counter
    }, 1000);
  }
  
  getStats() {
    return {
      ...this.stats,
      activeConnections: this.activeMiners.size,
      inactiveConnections: this.inactiveMiners.size,
      totalConnections: this.connections.size,
      poolUtilization: this.connectionPool.length / this.maxPoolSize
    };
  }
}

/**
 * Main optimized mining pool class
 */
export class MiningPoolOptimized extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = Object.freeze({
      maxMiners: options.maxMiners || 100000,
      poolFee: options.poolFee || 0.018, // 1.8%
      minDifficulty: options.minDifficulty || 1,
      maxDifficulty: options.maxDifficulty || 1000000,
      shareTargetTime: options.shareTargetTime || 30, // 30 seconds
      vardiffRetargetTime: options.vardiffRetargetTime || 120, // 2 minutes
      enabledAlgorithms: options.enabledAlgorithms || Object.keys(MINING_ALGORITHMS),
      ...options
    });
    
    // Core components
    this.database = options.database;
    this.logger = options.logger;
    
    // Optimized components
    this.shareValidator = new ShareValidator(options.validatorWorkers || 8);
    this.connectionPool = new MinerConnectionPool(this.config.maxMiners);
    
    // Mining state
    this.currentJobs = new Map(); // algorithm -> job
    this.shareHistory = new Map(); // minerId -> shares[]
    this.difficultyCache = new Map(); // minerId -> difficulty
    
    // Performance tracking
    this.metrics = {
      sharesProcessed: 0,
      sharesAccepted: 0,
      sharesRejected: 0,
      blocksFound: 0,
      totalHashrate: 0,
      avgValidationTime: 0
    };
    
    // Batch processing for database operations
    this.pendingShares = [];
    this.batchSize = 1000;
    this.batchTimeout = 100; // 100ms
    
    this.initialized = false;
  }
  
  async initialize() {
    if (this.initialized) return;
    
    this.logger.info('Initializing optimized mining pool...');
    
    // Initialize database schema
    await this.initializeDatabase();
    
    // Start background processes
    this.startBatchProcessor();
    this.startDifficultyAdjustment();
    this.startCleanupTasks();
    this.startMetricsCollection();
    
    // Initialize jobs for enabled algorithms
    await this.initializeJobs();
    
    this.initialized = true;
    this.logger.info('Mining pool initialized successfully');
    
    this.emit('initialized');
  }
  
  async initializeDatabase() {
    // Optimized table structure with indexes
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS miners_optimized (
        id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        worker_name TEXT,
        algorithm TEXT NOT NULL,
        hardware_type TEXT,
        difficulty REAL DEFAULT 1,
        hashrate REAL DEFAULT 0,
        shares_submitted INTEGER DEFAULT 0,
        shares_accepted INTEGER DEFAULT 0,
        shares_rejected INTEGER DEFAULT 0,
        last_share_time INTEGER,
        connected_at INTEGER DEFAULT (strftime('%s', 'now')),
        last_seen INTEGER DEFAULT (strftime('%s', 'now')),
        total_rewards REAL DEFAULT 0,
        status TEXT DEFAULT 'active'
      );
      
      CREATE TABLE IF NOT EXISTS shares_optimized (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        miner_id TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        currency TEXT NOT NULL,
        difficulty REAL NOT NULL,
        block_height INTEGER,
        job_id TEXT,
        nonce TEXT,
        hash TEXT,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        reward REAL DEFAULT 0,
        is_block BOOLEAN DEFAULT 0,
        validation_time REAL
      );
      
      CREATE TABLE IF NOT EXISTS jobs_optimized (
        id TEXT PRIMARY KEY,
        algorithm TEXT NOT NULL,
        currency TEXT NOT NULL,
        height INTEGER NOT NULL,
        difficulty REAL NOT NULL,
        target TEXT NOT NULL,
        header_template TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        expires_at INTEGER,
        status TEXT DEFAULT 'active'
      );
      
      -- Optimized indexes for performance
      CREATE INDEX IF NOT EXISTS idx_miners_algorithm ON miners_optimized(algorithm, status);
      CREATE INDEX IF NOT EXISTS idx_miners_wallet ON miners_optimized(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_shares_miner ON shares_optimized(miner_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_shares_algorithm ON shares_optimized(algorithm, timestamp);
      CREATE INDEX IF NOT EXISTS idx_jobs_algorithm ON jobs_optimized(algorithm, status);
    `);
  }
  
  async initializeJobs() {
    for (const algorithmName of this.config.enabledAlgorithms) {
      const algorithm = MINING_ALGORITHMS[algorithmName];
      if (!algorithm) continue;
      
      // Create initial job for each currency
      for (const currency of algorithm.currencies) {
        const job = await this.createJob(algorithm, currency);
        this.currentJobs.set(`${algorithm.name}:${currency}`, job);
      }
    }
    
    this.logger.info(`Initialized jobs for ${this.currentJobs.size} algorithm-currency pairs`);
  }
  
  async createJob(algorithm, currency, height = 1) {
    const jobId = randomBytes(16).toString('hex');
    const target = this.difficultyToTarget(algorithm.difficulty);
    
    const job = {
      id: jobId,
      algorithm: algorithm.name,
      currency,
      height,
      difficulty: algorithm.difficulty,
      target,
      headerTemplate: this.generateHeaderTemplate(algorithm, currency, height),
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000 // 10 minutes
    };
    
    // Store job in database
    await this.database.run(`
      INSERT INTO jobs_optimized (id, algorithm, currency, height, difficulty, target, header_template, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [jobId, algorithm.name, currency, height, algorithm.difficulty, target, job.headerTemplate, job.expiresAt]);
    
    this.emit('job:created', job);
    return job;
  }
  
  // Optimized miner connection
  async connectMiner(connectionData) {
    const { walletAddress, workerName, algorithm, hardwareType, userAgent } = connectionData;
    
    // Validate inputs
    if (!this.validateWalletAddress(walletAddress)) {
      throw new Error('Invalid wallet address');
    }
    
    if (!MINING_ALGORITHMS[algorithm.toUpperCase()]) {
      throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
    
    const algorithmData = MINING_ALGORITHMS[algorithm.toUpperCase()];
    
    // Check hardware compatibility
    if (!algorithmData.hardwareTypes.includes(hardwareType)) {
      throw new Error(`Hardware type ${hardwareType} not supported for ${algorithm}`);
    }
    
    const minerId = `${walletAddress}:${workerName || 'default'}`;
    
    // Check connection limits
    if (this.connectionPool.connections.size >= this.config.maxMiners) {
      throw new Error('Pool capacity exceeded');
    }
    
    // Get or create miner record
    let miner = await this.database.get(`
      SELECT * FROM miners_optimized WHERE id = ?
    `, [minerId]);
    
    if (!miner) {
      // Create new miner
      await this.database.run(`
        INSERT INTO miners_optimized (id, wallet_address, worker_name, algorithm, hardware_type)
        VALUES (?, ?, ?, ?, ?)
      `, [minerId, walletAddress, workerName, algorithm, hardwareType]);
      
      miner = {
        id: minerId,
        walletAddress,
        workerName,
        algorithm,
        hardwareType,
        difficulty: this.config.minDifficulty,
        hashrate: 0,
        sharesSubmitted: 0,
        sharesAccepted: 0,
        sharesRejected: 0,
        totalRewards: 0
      };
    }
    
    // Add to connection pool
    const connection = this.connectionPool.addConnection(minerId, {
      ...miner,
      userAgent,
      connectedAt: Date.now()
    });
    
    // Initialize difficulty
    this.difficultyCache.set(minerId, miner.difficulty);
    this.shareHistory.set(minerId, []);
    
    this.logger.info(`Miner connected: ${minerId} (${algorithm}/${hardwareType})`);
    this.emit('miner:connected', { minerId, algorithm, hardwareType });
    
    // Send initial job
    await this.sendJob(minerId);
    
    return connection;
  }
  
  async disconnectMiner(minerId) {
    const connection = this.connectionPool.getConnection(minerId);
    if (!connection) return false;
    
    // Update last seen
    await this.database.run(`
      UPDATE miners_optimized SET last_seen = strftime('%s', 'now') WHERE id = ?
    `, [minerId]);
    
    // Remove from pool
    this.connectionPool.removeConnection(minerId);
    this.difficultyCache.delete(minerId);
    this.shareHistory.delete(minerId);
    
    this.logger.info(`Miner disconnected: ${minerId}`);
    this.emit('miner:disconnected', { minerId });
    
    return true;
  }
  
  // High-performance share submission
  async submitShare(minerId, shareData) {
    const startTime = performance.now();
    
    const connection = this.connectionPool.getConnection(minerId);
    if (!connection) {
      throw new Error('Miner not connected');
    }
    
    const { jobId, nonce, hash, extraNonce } = shareData;
    
    // Get job
    const jobKey = `${connection.algorithm}:${shareData.currency || 'BTC'}`;
    const job = this.currentJobs.get(jobKey);
    
    if (!job) {
      throw new Error('Invalid job');
    }
    
    // Get miner difficulty
    const difficulty = this.difficultyCache.get(minerId) || this.config.minDifficulty;
    
    // Validate share (async with worker pool)
    const isValid = await this.shareValidator.validateShare(job, nonce, hash, difficulty);
    
    const validationTime = performance.now() - startTime;
    
    if (!isValid) {
      this.metrics.sharesRejected++;
      this.emit('share:rejected', { minerId, reason: 'Invalid share' });
      return false;
    }
    
    // Calculate reward
    const reward = this.calculateShareReward(difficulty, job.currency);
    
    // Check if it's a block
    const isBlock = this.checkForBlock(hash, job.target);
    
    // Create share record
    const share = {
      minerId,
      algorithm: job.algorithm,
      currency: job.currency,
      difficulty,
      blockHeight: job.height,
      jobId,
      nonce,
      hash,
      timestamp: Date.now(),
      reward,
      isBlock,
      validationTime
    };
    
    // Add to batch for database insertion
    this.pendingShares.push(share);
    
    // Update connection stats
    connection.shares++;
    connection.lastSeen = Date.now();
    
    // Update share history for difficulty adjustment
    const shareHistory = this.shareHistory.get(minerId);
    shareHistory.push({
      timestamp: share.timestamp,
      difficulty
    });
    
    // Keep only recent shares (last 10 minutes)
    const cutoff = share.timestamp - 600000;
    while (shareHistory.length > 0 && shareHistory[0].timestamp < cutoff) {
      shareHistory.shift();
    }
    
    // Update metrics
    this.metrics.sharesProcessed++;
    this.metrics.sharesAccepted++;
    this.metrics.avgValidationTime = (this.metrics.avgValidationTime * 0.95) + (validationTime * 0.05);
    
    this.emit('share:accepted', {
      minerId,
      currency: job.currency,
      reward,
      difficulty,
      isBlock,
      validationTime
    });
    
    // Handle block found
    if (isBlock) {
      await this.handleBlockFound(minerId, job, share);
    }
    
    return true;
  }
  
  async handleBlockFound(minerId, job, share) {
    this.logger.info(`BLOCK FOUND! Miner: ${minerId}, Currency: ${job.currency}, Height: ${job.height}`);
    
    const algorithmData = MINING_ALGORITHMS[job.algorithm.toUpperCase()];
    const blockReward = algorithmData.reward;
    
    // Update share with block status
    share.reward = blockReward;
    share.isBlock = true;
    
    // Update metrics
    this.metrics.blocksFound++;
    
    // Emit block found event
    this.emit('block:found', {
      minerId,
      currency: job.currency,
      height: job.height,
      hash: share.hash,
      reward: blockReward,
      algorithm: job.algorithm
    });
    
    // Create new job for next block
    const nextJob = await this.createJob(algorithmData, job.currency, job.height + 1);
    this.currentJobs.set(`${job.algorithm}:${job.currency}`, nextJob);
    
    // Broadcast new job to all miners
    this.broadcastNewJob(nextJob);
  }
  
  async sendJob(minerId) {
    const connection = this.connectionPool.getConnection(minerId);
    if (!connection) return;
    
    const jobKey = `${connection.algorithm}:BTC`; // Default to BTC, could be configurable
    const job = this.currentJobs.get(jobKey);
    
    if (!job) return;
    
    const difficulty = this.difficultyCache.get(minerId) || this.config.minDifficulty;
    const adjustedTarget = this.adjustTargetForDifficulty(job.target, difficulty);
    
    const jobData = {
      jobId: job.id,
      algorithm: job.algorithm,
      currency: job.currency,
      height: job.height,
      target: adjustedTarget,
      headerTemplate: job.headerTemplate,
      difficulty
    };
    
    this.emit('job:new', { minerId, job: jobData });
  }
  
  broadcastNewJob(job) {
    this.connectionPool.forEachActiveMiner((connection, minerId) => {
      if (connection.algorithm === job.algorithm) {
        this.sendJob(minerId);
      }
    });
  }
  
  // Batch processing for database operations (Carmack optimization)
  startBatchProcessor() {
    setInterval(() => {
      this.processPendingShares();
    }, this.batchTimeout);
  }
  
  async processPendingShares() {
    if (this.pendingShares.length === 0) return;
    
    const batch = this.pendingShares.splice(0, this.batchSize);
    
    try {
      // Batch insert shares
      const stmt = await this.database.prepare(`
        INSERT INTO shares_optimized (
          miner_id, algorithm, currency, difficulty, block_height, job_id, 
          nonce, hash, timestamp, reward, is_block, validation_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      for (const share of batch) {
        await stmt.run([
          share.minerId,
          share.algorithm,
          share.currency,
          share.difficulty,
          share.blockHeight,
          share.jobId,
          share.nonce,
          share.hash,
          share.timestamp,
          share.reward,
          share.isBlock ? 1 : 0,
          share.validationTime
        ]);
      }
      
      // Update miner stats in batch
      const minerUpdates = new Map();
      for (const share of batch) {
        if (!minerUpdates.has(share.minerId)) {
          minerUpdates.set(share.minerId, {
            sharesSubmitted: 0,
            sharesAccepted: 0,
            totalRewards: 0
          });
        }
        
        const update = minerUpdates.get(share.minerId);
        update.sharesSubmitted++;
        update.sharesAccepted++;
        update.totalRewards += share.reward;
      }
      
      // Apply updates
      for (const [minerId, updates] of minerUpdates) {
        await this.database.run(`
          UPDATE miners_optimized SET
            shares_submitted = shares_submitted + ?,
            shares_accepted = shares_accepted + ?,
            total_rewards = total_rewards + ?,
            last_share_time = strftime('%s', 'now')
          WHERE id = ?
        `, [updates.sharesSubmitted, updates.sharesAccepted, updates.totalRewards, minerId]);
      }
      
    } catch (error) {
      this.logger.error('Batch processing error:', error);
      // Re-add failed shares to queue
      this.pendingShares.unshift(...batch);
    }
  }
  
  // Difficulty adjustment system
  startDifficultyAdjustment() {
    setInterval(() => {
      this.adjustAllDifficulties();
    }, this.config.vardiffRetargetTime * 1000);
  }
  
  adjustAllDifficulties() {
    this.connectionPool.forEachActiveMiner((connection, minerId) => {
      this.adjustMinerDifficulty(minerId);
    });
  }
  
  adjustMinerDifficulty(minerId) {
    const shareHistory = this.shareHistory.get(minerId);
    if (!shareHistory || shareHistory.length < 10) return;
    
    const currentDifficulty = this.difficultyCache.get(minerId);
    const now = Date.now();
    const timeWindow = 300000; // 5 minutes
    
    // Calculate recent share rate
    const recentShares = shareHistory.filter(share => 
      now - share.timestamp < timeWindow
    );
    
    if (recentShares.length < 5) return;
    
    const timeSpan = (now - recentShares[0].timestamp) / 1000;
    const shareRate = recentShares.length / timeSpan; // shares per second
    const targetRate = 1 / this.config.shareTargetTime; // target shares per second
    
    // Calculate new difficulty
    let newDifficulty = currentDifficulty * (shareRate / targetRate);
    
    // Apply limits
    newDifficulty = Math.max(this.config.minDifficulty, newDifficulty);
    newDifficulty = Math.min(this.config.maxDifficulty, newDifficulty);
    
    // Only adjust if change is significant (>10%)
    if (Math.abs(newDifficulty - currentDifficulty) / currentDifficulty > 0.1) {
      this.difficultyCache.set(minerId, newDifficulty);
      
      // Update database
      this.database.run(`
        UPDATE miners_optimized SET difficulty = ? WHERE id = ?
      `, [newDifficulty, minerId]).catch(error => {
        this.logger.error('Difficulty update error:', error);
      });
      
      this.emit('difficulty:adjusted', {
        minerId,
        oldDifficulty: currentDifficulty,
        newDifficulty,
        shareRate
      });
      
      // Send new job with updated difficulty
      this.sendJob(minerId);
    }
  }
  
  // Cleanup tasks
  startCleanupTasks() {
    // Cleanup every 5 minutes
    setInterval(() => {
      this.cleanupInactiveConnections();
      this.cleanupOldJobs();
      this.cleanupOldShares();
    }, 300000);
  }
  
  cleanupInactiveConnections() {
    const removed = this.connectionPool.cleanupInactive(300000); // 5 minutes
    if (removed > 0) {
      this.logger.debug(`Cleaned up ${removed} inactive connections`);
    }
  }
  
  async cleanupOldJobs() {
    const cutoff = Date.now() - 3600000; // 1 hour
    
    try {
      const result = await this.database.run(`
        DELETE FROM jobs_optimized WHERE expires_at < ?
      `, [cutoff]);
      
      if (result.changes > 0) {
        this.logger.debug(`Cleaned up ${result.changes} old jobs`);
      }
    } catch (error) {
      this.logger.error('Job cleanup error:', error);
    }
  }
  
  async cleanupOldShares() {
    const cutoff = Date.now() - 604800000; // 1 week
    
    try {
      const result = await this.database.run(`
        DELETE FROM shares_optimized WHERE timestamp < ? AND is_block = 0
      `, [cutoff / 1000]);
      
      if (result.changes > 0) {
        this.logger.debug(`Cleaned up ${result.changes} old shares`);
      }
    } catch (error) {
      this.logger.error('Share cleanup error:', error);
    }
  }
  
  // Metrics collection
  startMetricsCollection() {
    setInterval(() => {
      this.updateHashrateMetrics();
    }, 10000); // Every 10 seconds
  }
  
  updateHashrateMetrics() {
    let totalHashrate = 0;
    
    this.connectionPool.forEachActiveMiner((connection, minerId) => {
      const hashrate = this.calculateMinerHashrate(minerId);
      connection.hashrate = hashrate;
      totalHashrate += hashrate;
    });
    
    this.metrics.totalHashrate = totalHashrate;
  }
  
  calculateMinerHashrate(minerId) {
    const shareHistory = this.shareHistory.get(minerId);
    if (!shareHistory || shareHistory.length < 2) return 0;
    
    const now = Date.now();
    const timeWindow = 300000; // 5 minutes
    
    const recentShares = shareHistory.filter(share => 
      now - share.timestamp < timeWindow
    );
    
    if (recentShares.length < 2) return 0;
    
    const totalDifficulty = recentShares.reduce((sum, share) => sum + share.difficulty, 0);
    const timeSpan = (now - recentShares[0].timestamp) / 1000;
    
    // Hashrate = (total difficulty * 2^32) / time
    return (totalDifficulty * Math.pow(2, 32)) / timeSpan;
  }
  
  // Utility methods
  validateWalletAddress(address) {
    // Basic validation - should be enhanced for production
    return /^[a-zA-Z0-9]{20,100}$/.test(address);
  }
  
  calculateShareReward(difficulty, currency) {
    const baseReward = 0.00001; // Base reward per unit difficulty
    const multipliers = {
      BTC: 1.0,
      LTC: 0.25,
      ETH: 0.5,
      ETC: 0.5,
      XMR: 0.1,
      RVN: 0.001,
      DOGE: 0.0001,
      DASH: 0.5,
      ZEC: 0.5,
      ERGO: 0.01,
      KAS: 0.01,
      ALPH: 0.01
    };
    
    const multiplier = multipliers[currency] || 0.001;
    return difficulty * baseReward * multiplier * (1 - this.config.poolFee);
  }
  
  checkForBlock(hash, target) {
    const hashBigInt = BigInt('0x' + hash);
    const targetBigInt = BigInt('0x' + target);
    return hashBigInt <= targetBigInt;
  }
  
  difficultyToTarget(difficulty) {
    const maxTarget = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
    const target = maxTarget / BigInt(Math.floor(difficulty));
    return target.toString(16).padStart(64, '0');
  }
  
  adjustTargetForDifficulty(baseTarget, difficulty) {
    const baseDifficulty = this.targetToDifficulty(baseTarget);
    const newDifficulty = baseDifficulty * difficulty;
    return this.difficultyToTarget(newDifficulty);
  }
  
  targetToDifficulty(target) {
    const maxTarget = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
    const targetBigInt = BigInt('0x' + target);
    return Number(maxTarget / targetBigInt);
  }
  
  generateHeaderTemplate(algorithm, currency, height) {
    // Simplified header template generation
    return {
      version: 1,
      previousHash: '0'.repeat(64),
      merkleRoot: '0'.repeat(64),
      timestamp: Math.floor(Date.now() / 1000),
      bits: algorithm.difficulty,
      height
    };
  }
  
  // Public API
  getPoolStats() {
    const connectionStats = this.connectionPool.getStats();
    const validatorStats = this.shareValidator.getStats();
    
    return {
      miners: connectionStats,
      validation: validatorStats,
      performance: this.metrics,
      algorithms: Array.from(this.currentJobs.keys()),
      uptime: Date.now() - (this.initializeTime || Date.now())
    };
  }
  
  getMinerStats(minerId) {
    const connection = this.connectionPool.getConnection(minerId);
    if (!connection) return null;
    
    const shareHistory = this.shareHistory.get(minerId);
    const difficulty = this.difficultyCache.get(minerId);
    
    return {
      ...connection,
      currentDifficulty: difficulty,
      recentShares: shareHistory?.length || 0,
      hashrate: this.calculateMinerHashrate(minerId)
    };
  }
  
  async shutdown() {
    this.logger.info('Shutting down mining pool...');
    
    // Process remaining shares
    await this.processPendingShares();
    
    // Shutdown components
    await this.shareValidator.shutdown();
    
    this.logger.info('Mining pool shutdown complete');
  }
}

export default MiningPoolOptimized;
*/