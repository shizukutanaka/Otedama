/**
 * Mining Pool Core for Otedama
 * Handles mining operations with two payout options:
 * 1. Direct: Original currency - 1.8% pool fee
 * 2. Convert: BTC payout - 2% total fee
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import Database from 'better-sqlite3';
import { Worker } from 'worker_threads';
import { PayoutManager, PayoutMode, FeeStructure } from './payout.js';
import { Logger } from './logger.js';
import { AlgorithmFactory, DifficultyCalculator } from './mining/algorithms.js';
import { PoolOptimizer, ConnectionPool } from './mining/pool-optimizer.js';

// Supported mining algorithms
export const ALGORITHMS = {
  SHA256: 'sha256',
  SCRYPT: 'scrypt',
  ETHASH: 'ethash',
  RANDOMX: 'randomx',
  KAWPOW: 'kawpow',
  X11: 'x11',
  EQUIHASH: 'equihash',
  AUTOLYKOS: 'autolykos2',
  KHEAVYHASH: 'kheavyhash',
  BLAKE3: 'blake3'
};

// Algorithm to currency mapping
export const ALGO_CURRENCY_MAP = {
  [ALGORITHMS.SHA256]: ['BTC'],
  [ALGORITHMS.SCRYPT]: ['LTC', 'DOGE'],
  [ALGORITHMS.ETHASH]: ['ETH', 'ETC'],
  [ALGORITHMS.RANDOMX]: ['XMR'],
  [ALGORITHMS.KAWPOW]: ['RVN'],
  [ALGORITHMS.X11]: ['DASH'],
  [ALGORITHMS.EQUIHASH]: ['ZEC', 'FLUX'],
  [ALGORITHMS.AUTOLYKOS]: ['ERGO'],
  [ALGORITHMS.KHEAVYHASH]: ['KAS'],
  [ALGORITHMS.BLAKE3]: ['ALPH']
};

// Mining difficulty targets
const DIFFICULTY_TARGETS = {
  [ALGORITHMS.SHA256]: 0x1d00ffff,
  [ALGORITHMS.SCRYPT]: 0x1e0ffff0,
  [ALGORITHMS.ETHASH]: 0x00000000ffff0000,
  [ALGORITHMS.RANDOMX]: 0x00000000ffffffff,
  [ALGORITHMS.KAWPOW]: 0x00000000ffff0000,
  [ALGORITHMS.X11]: 0x1e0ffff0,
  [ALGORITHMS.EQUIHASH]: 0x1f07ffff,
  [ALGORITHMS.AUTOLYKOS]: 0x1d00ffff,
  [ALGORITHMS.KHEAVYHASH]: 0x1e00ffff,
  [ALGORITHMS.BLAKE3]: 0x1d00ffff
};

export class MiningPool extends EventEmitter {
  /**
   * Get pool performance metrics
   */
  getPerformanceMetrics() {
    const optimizerMetrics = this.optimizer.getMetrics();
    const connectionStats = this.connectionPool.getStats();
    
    return {
      pool: {
        totalMiners: this.miners.size,
        activeMiners: Array.from(this.miners.values()).filter(m => m.connected).length,
        totalJobs: this.jobs.size,
        currentDifficulty: this.currentJob?.difficulty || 0
      },
      performance: {
        shareValidation: optimizerMetrics,
        connections: connectionStats
      },
      algorithms: this.getAlgorithmStats()
    };
  }
  
  /**
   * Get statistics per algorithm
   */
  getAlgorithmStats() {
    const stats = {};
    
    for (const [algo] of Object.entries(ALGORITHMS)) {
      stats[algo] = {
        miners: 0,
        hashrate: 0,
        shares: 0
      };
    }
    
    for (const miner of this.miners.values()) {
      if (miner.algorithm && stats[miner.algorithm]) {
        stats[miner.algorithm].miners++;
        stats[miner.algorithm].hashrate += miner.hashrate || 0;
      }
    }
    
    return stats;
  }
  
  constructor(db, options = {}) {
    super();
    this.db = db;
    this.logger = options.logger || new Logger('MiningPool');
    this.options = {
      minDifficulty: options.minDifficulty || 1,
      maxDifficulty: options.maxDifficulty || 65536,
      vardiffRetargetTime: options.vardiffRetargetTime || 30,
      vardiffVariance: options.vardiffVariance || 0.3,
      ...options
    };
    
    this.miners = new Map();
    this.jobs = new Map();
    this.shares = new Map();
    this.currentJob = null;
    this.workers = [];
    
    // Initialize payout manager
    this.payoutManager = new PayoutManager(db, {
      logger: this.logger,
      minimumPayout: options.minimumPayout || 0.001,
      payoutInterval: options.payoutInterval || 3600000
    });
    
    // Initialize performance optimizer
    this.optimizer = new PoolOptimizer({
      shareValidationWorkers: options.shareValidationWorkers || 4,
      cacheSize: options.shareCacheSize || 10000
    });
    
    // Initialize connection pool
    this.connectionPool = new ConnectionPool({
      maxConnections: options.maxConnections || 10000,
      connectionTimeout: options.connectionTimeout || 300000
    });
    
    this.initializeDatabase();
    this.setupWorkers();
    this.startDifficultyAdjustment();
  }
  
  initializeDatabase() {
    // Miners table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS miners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_address TEXT UNIQUE NOT NULL,
        worker_name TEXT,
        algorithm TEXT,
        difficulty REAL DEFAULT 1,
        hashrate REAL DEFAULT 0,
        shares_submitted INTEGER DEFAULT 0,
        shares_accepted INTEGER DEFAULT 0,
        last_share INTEGER,
        connected_at INTEGER DEFAULT (strftime('%s', 'now')),
        last_seen INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    
    // Shares table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        miner_id INTEGER NOT NULL,
        job_id TEXT NOT NULL,
        difficulty REAL NOT NULL,
        hash TEXT,
        nonce TEXT,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        status TEXT DEFAULT 'pending',
        reward REAL DEFAULT 0,
        currency TEXT,
        FOREIGN KEY (miner_id) REFERENCES miners(id)
      )
    `);
    
    // Jobs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        algorithm TEXT NOT NULL,
        currency TEXT NOT NULL,
        height INTEGER,
        target TEXT,
        header TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
  }
  
  setupWorkers() {
    const numWorkers = this.options.numWorkers || 4;
    
    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker('./workers/mining-worker.js');
      
      worker.on('message', (message) => {
        this.handleWorkerMessage(worker, message);
      });
      
      worker.on('error', (error) => {
        this.logger.error('Worker error:', error);
      });
      
      this.workers.push(worker);
    }
    
    this.logger.info(`Initialized ${numWorkers} mining workers`);
  }
  
  /**
   * Connect miner
   */
  connectMiner(minerInfo) {
    const { walletAddress, workerName, algorithm, userAgent } = minerInfo;
    
    // Validate wallet address
    if (!this.validateWalletAddress(walletAddress)) {
      throw new Error('Invalid wallet address');
    }
    
    // Validate algorithm
    if (!Object.values(ALGORITHMS).includes(algorithm)) {
      throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
    
    // Get or create miner
    const minerKey = `${walletAddress}:${workerName || 'default'}`;
    let miner = this.miners.get(minerKey);
    
    if (!miner) {
      // Create new miner entry
      const stmt = this.db.prepare(`
        INSERT INTO miners (wallet_address, worker_name, algorithm)
        VALUES (?, ?, ?)
        ON CONFLICT(wallet_address) DO UPDATE SET
          worker_name = excluded.worker_name,
          algorithm = excluded.algorithm,
          last_seen = strftime('%s', 'now')
      `);
      
      const result = stmt.run(walletAddress, workerName, algorithm);
      
      miner = {
        id: result.lastInsertRowid,
        walletAddress,
        workerName,
        algorithm,
        difficulty: this.options.minDifficulty,
        shares: [],
        hashrate: 0,
        lastShareTime: Date.now(),
        userAgent
      };
      
      this.miners.set(minerKey, miner);
    }
    
    miner.connected = true;
    miner.lastSeen = Date.now();
    
    this.emit('miner:connected', {
      walletAddress,
      workerName,
      algorithm,
      difficulty: miner.difficulty
    });
    
    // Send initial job
    this.sendJob(minerKey);
    
    return miner;
  }
  
  /**
   * Disconnect miner
   */
  disconnectMiner(minerKey) {
    const miner = this.miners.get(minerKey);
    
    if (miner) {
      miner.connected = false;
      
      // Update last seen
      const stmt = this.db.prepare(`
        UPDATE miners SET last_seen = strftime('%s', 'now')
        WHERE id = ?
      `);
      
      stmt.run(miner.id);
      
      this.emit('miner:disconnected', {
        walletAddress: miner.walletAddress,
        workerName: miner.workerName
      });
    }
  }
  
  /**
   * Submit share
   */
  async submitShare(minerKey, shareData) {
    const miner = this.miners.get(minerKey);
    
    if (!miner || !miner.connected) {
      throw new Error('Miner not connected');
    }
    
    const { jobId, nonce, hash } = shareData;
    const job = this.jobs.get(jobId);
    
    if (!job) {
      throw new Error('Invalid job ID');
    }
    
    // Validate share
    const isValid = await this.validateShare(job, nonce, hash, miner.difficulty);
    
    if (!isValid) {
      this.emit('share:rejected', {
        minerKey,
        reason: 'Invalid share'
      });
      
      return false;
    }
    
    // Calculate reward based on difficulty
    const reward = this.calculateShareReward(miner.difficulty, job.currency);
    
    // Record share
    const stmt = this.db.prepare(`
      INSERT INTO shares (miner_id, job_id, difficulty, hash, nonce, status, reward, currency)
      VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)
    `);
    
    stmt.run(
      miner.id,
      jobId,
      miner.difficulty,
      hash,
      nonce,
      reward,
      job.currency
    );
    
    // Update miner stats
    miner.shares.push({
      timestamp: Date.now(),
      difficulty: miner.difficulty
    });
    
    miner.lastShareTime = Date.now();
    
    const updateStmt = this.db.prepare(`
      UPDATE miners SET
        shares_submitted = shares_submitted + 1,
        shares_accepted = shares_accepted + 1,
        last_share = strftime('%s', 'now'),
        hashrate = ?
      WHERE id = ?
    `);
    
    const hashrate = this.calculateHashrate(miner);
    updateStmt.run(hashrate, miner.id);
    
    // Add to payout manager
    await this.payoutManager.addMiningReward(
      miner.walletAddress,
      job.currency,
      reward
    );
    
    this.emit('share:accepted', {
      minerKey,
      walletAddress: miner.walletAddress,
      currency: job.currency,
      reward,
      difficulty: miner.difficulty,
      hashrate
    });
    
    // Check for block
    if (this.checkForBlock(hash, job.target)) {
      this.handleBlockFound(miner, job, hash, nonce);
    }
    
    return true;
  }
  
  /**
   * Validate share
   */
  async validateShare(job, nonce, hash, difficulty) {
    // Use optimizer for validation with caching and parallel processing
    const result = await this.optimizer.validateShare(job, nonce, hash, difficulty);
    
    // If it's a block solution, emit event
    if (result && result.isBlockSolution) {
      this.emit('block:found', {
        job,
        nonce,
        hash: result.hash,
        difficulty
      });
    }
    
    return result && result.valid;
  }
  
  /**
   * Create new job
   */
  createJob(template) {
    const jobId = randomBytes(8).toString('hex');
    const { algorithm, currency, height, previousHash, merkleRoot, bits } = template;
    
    const job = {
      id: jobId,
      algorithm,
      currency,
      height,
      target: this.bitsToTarget(bits),
      header: this.buildBlockHeader(template),
      createdAt: Date.now()
    };
    
    this.jobs.set(jobId, job);
    this.currentJob = job;
    
    // Store job
    const stmt = this.db.prepare(`
      INSERT INTO jobs (id, algorithm, currency, height, target, header)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(jobId, algorithm, currency, height, job.target, job.header);
    
    // Notify connected miners
    this.broadcastJob();
    
    return job;
  }
  
  /**
   * Send job to miner
   */
  sendJob(minerKey) {
    const miner = this.miners.get(minerKey);
    
    if (!miner || !miner.connected || !this.currentJob) {
      return;
    }
    
    // Check if job supports miner's algorithm
    if (this.currentJob.algorithm !== miner.algorithm) {
      return;
    }
    
    const jobData = {
      id: this.currentJob.id,
      algorithm: this.currentJob.algorithm,
      target: this.adjustTargetForDifficulty(this.currentJob.target, miner.difficulty),
      header: this.currentJob.header,
      height: this.currentJob.height
    };
    
    this.emit('job:new', {
      minerKey,
      job: jobData
    });
  }
  
  /**
   * Broadcast job to all miners
   */
  broadcastJob() {
    for (const [minerKey, miner] of this.miners) {
      if (miner.connected) {
        this.sendJob(minerKey);
      }
    }
  }
  
  /**
   * Calculate share reward
   */
  calculateShareReward(difficulty, currency) {
    // Base reward per share based on difficulty
    const baseReward = difficulty * 0.00001; // Adjust based on your economics
    
    // Apply currency-specific multipliers
    const multipliers = {
      BTC: 1.0,
      ETH: 0.05,
      RVN: 0.001,
      XMR: 0.1,
      LTC: 0.01,
      DOGE: 0.00001
    };
    
    const multiplier = multipliers[currency] || 0.001;
    
    return baseReward * multiplier;
  }
  
  /**
   * Calculate miner hashrate
   */
  calculateHashrate(miner) {
    // Keep only recent shares (last 5 minutes)
    const recentShares = miner.shares.filter(
      share => Date.now() - share.timestamp < 300000
    );
    
    if (recentShares.length < 2) {
      return 0;
    }
    
    // Calculate total difficulty
    const totalDifficulty = recentShares.reduce(
      (sum, share) => sum + share.difficulty,
      0
    );
    
    // Calculate time span
    const timeSpan = (Date.now() - recentShares[0].timestamp) / 1000;
    
    // Hashrate = (total difficulty * 2^32) / time
    const hashrate = (totalDifficulty * Math.pow(2, 32)) / timeSpan;
    
    miner.hashrate = hashrate;
    miner.shares = recentShares; // Clean old shares
    
    return hashrate;
  }
  
  /**
   * Adjust difficulty for miner
   */
  adjustDifficulty(minerKey) {
    const miner = this.miners.get(minerKey);
    
    if (!miner || !miner.connected || miner.shares.length < 10) {
      return;
    }
    
    // Use optimizer for better difficulty calculation
    const newDifficulty = this.optimizer.optimizeDifficulty({
      shares: miner.shares,
      targetShareRate: 20, // 20 shares per minute
      currentDifficulty: miner.difficulty,
      minDifficulty: this.options.minDifficulty,
      maxDifficulty: this.options.maxDifficulty
    });
    
    if (Math.abs(newDifficulty - miner.difficulty) / miner.difficulty > 0.1) {
      miner.difficulty = newDifficulty;
      
      // Update database
      const stmt = this.db.prepare('UPDATE miners SET difficulty = ? WHERE id = ?');
      stmt.run(newDifficulty, miner.id);
      
      this.emit('difficulty:adjusted', {
        minerKey,
        oldDifficulty: miner.difficulty,
        newDifficulty
      });
      
      // Send new job with updated difficulty
      this.sendJob(minerKey);
    }
  }
  
  /**
   * Start difficulty adjustment timer
   */
  startDifficultyAdjustment() {
    setInterval(() => {
      for (const [minerKey, miner] of this.miners) {
        if (miner.connected) {
          this.adjustDifficulty(minerKey);
        }
      }
    }, 30000); // Every 30 seconds
  }
  
  /**
   * Handle block found
   */
  handleBlockFound(miner, job, hash, nonce) {
    this.logger.info(`BLOCK FOUND! Miner: ${miner.walletAddress}, Currency: ${job.currency}`);
    
    // Record block
    const stmt = this.db.prepare(`
      INSERT INTO blocks (
        height, currency, hash, miner_id, reward, status
      ) VALUES (?, ?, ?, ?, ?, 'pending')
    `);
    
    // Block rewards by currency
    const blockRewards = {
      BTC: 6.25,
      ETH: 2.0,
      RVN: 5000,
      XMR: 0.6,
      LTC: 12.5,
      DOGE: 10000
    };
    
    const blockReward = blockRewards[job.currency] || 0;
    
    stmt.run(
      job.height,
      job.currency,
      hash,
      miner.id,
      blockReward
    );
    
    // Add block reward to miner
    this.payoutManager.addMiningReward(
      miner.walletAddress,
      job.currency,
      blockReward
    ).catch(error => {
      this.logger.error('Failed to add block reward:', error);
    });
    
    this.emit('block:found', {
      minerKey: `${miner.walletAddress}:${miner.workerName}`,
      walletAddress: miner.walletAddress,
      currency: job.currency,
      height: job.height,
      hash,
      reward: blockReward
    });
  }
  
  /**
   * Validate wallet address
   */
  validateWalletAddress(address) {
    // Basic validation - in production, use proper validation per currency
    return /^[a-zA-Z0-9]{20,100}$/.test(address);
  }
  
  /**
   * Check if hash meets block target
   */
  checkForBlock(hash, target) {
    const hashBigInt = BigInt('0x' + hash);
    const targetBigInt = BigInt('0x' + target);
    
    return hashBigInt <= targetBigInt;
  }
  
  /**
   * Convert bits to target
   */
  bitsToTarget(bits) {
    const exponent = bits >>> 24;
    const mantissa = bits & 0xffffff;
    const target = mantissa * Math.pow(256, exponent - 3);
    
    return target.toString(16).padStart(64, '0');
  }
  
  /**
   * Adjust target for difficulty
   */
  adjustTargetForDifficulty(target, difficulty) {
    // Convert current target to difficulty, then adjust, then convert back
    const currentDifficulty = DifficultyCalculator.targetToDifficulty('0x' + target);
    const adjustedDifficulty = currentDifficulty * difficulty;
    return DifficultyCalculator.difficultyToTarget(adjustedDifficulty);
  }
  
  /**
   * Build block header
   */
  buildBlockHeader(template) {
    // Simplified block header construction
    const { version, previousHash, merkleRoot, timestamp, bits, nonce } = template;
    
    const header = Buffer.concat([
      Buffer.from(version.toString(16).padStart(8, '0'), 'hex'),
      Buffer.from(previousHash, 'hex'),
      Buffer.from(merkleRoot, 'hex'),
      Buffer.from(timestamp.toString(16).padStart(8, '0'), 'hex'),
      Buffer.from(bits.toString(16).padStart(8, '0'), 'hex'),
      Buffer.from(nonce.toString(16).padStart(8, '0'), 'hex')
    ]);
    
    return header.toString('hex');
  }
  
  /**
   * Handle worker message
   */
  handleWorkerMessage(worker, message) {
    switch (message.type) {
      case 'validation_result':
        // Handled by promise in validateShare
        break;
        
      case 'hash_calculated':
        // Handle hash calculation results
        this.emit('hash:calculated', message);
        break;
        
      case 'error':
        this.logger.error('Worker error:', message.error);
        break;
    }
  }
  
  /**
   * Get pool statistics
   */
  getPoolStats() {
    const stats = {
      miners: {
        connected: 0,
        total: 0
      },
      hashrate: 0,
      shares: {
        submitted: 0,
        accepted: 0
      },
      currencies: {}
    };
    
    // Count connected miners
    for (const miner of this.miners.values()) {
      if (miner.connected) {
        stats.miners.connected++;
        stats.hashrate += miner.hashrate || 0;
      }
      stats.miners.total++;
    }
    
    // Get share stats
    const shareStats = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted,
        currency,
        SUM(reward) as total_reward
      FROM shares
      WHERE timestamp > strftime('%s', 'now', '-24 hours')
      GROUP BY currency
    `).all();
    
    for (const row of shareStats) {
      stats.shares.submitted += row.total;
      stats.shares.accepted += row.accepted;
      
      stats.currencies[row.currency] = {
        shares: row.total,
        rewards: row.total_reward
      };
    }
    
    // Get payout stats
    const payoutStats = this.payoutManager.getPoolStats();
    stats.payouts = payoutStats;
    
    return stats;
  }
  
  /**
   * Shutdown pool
   */
  async shutdown() {
    this.logger.info('Shutting down mining pool...');
    
    // Disconnect all miners
    for (const [minerKey, miner] of this.miners) {
      if (miner.connected) {
        this.disconnectMiner(minerKey);
      }
    }
    
    // Terminate workers
    for (const worker of this.workers) {
      await worker.terminate();
    }
    
    this.logger.info('Mining pool shutdown complete');
  }
}