/**
 * Enhanced Share Validator
 * Combines security, performance, and reliability for production mining pools
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { createLogger } = require('../core/logger');
const LRU = require('lru-cache');

const logger = createLogger('share-validator-enhanced');

class EnhancedShareValidator extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Performance
      workerPoolSize: options.workerPoolSize || 4,
      batchSize: options.batchSize || 100,
      cacheSize: options.cacheSize || 100000,
      cacheTTL: options.cacheTTL || 3600000, // 1 hour
      
      // Security
      maxTimeDeviation: options.maxTimeDeviation || 7200, // 2 hours
      duplicateWindow: options.duplicateWindow || 3600000, // 1 hour
      rateLimit: options.rateLimit || 100, // shares per second
      banThreshold: options.banThreshold || 1000, // invalid shares before ban
      banDuration: options.banDuration || 3600000, // 1 hour
      
      // Validation
      strictValidation: options.strictValidation !== false,
      validateCoinbase: options.validateCoinbase !== false,
      validateMerkleRoot: options.validateMerkleRoot !== false,
      
      // Monitoring
      statsInterval: options.statsInterval || 60000, // 1 minute
      alertThreshold: options.alertThreshold || 0.9, // 90% invalid share rate
      
      ...options
    };
    
    // Worker pool for CPU-intensive validation
    this.workers = [];
    this.workerQueue = [];
    this.activeWorkers = 0;
    
    // Caching layers
    this.shareCache = new LRU({
      max: this.options.cacheSize,
      ttl: this.options.cacheTTL,
      updateAgeOnGet: true
    });
    
    this.difficultyCache = new Map();
    this.jobCache = new Map();
    
    // Security tracking
    this.minerStats = new Map();
    this.banList = new Map();
    this.suspiciousPatterns = new Map();
    
    // Performance metrics
    this.stats = {
      total: 0,
      valid: 0,
      invalid: 0,
      duplicate: 0,
      banned: 0,
      errors: 0,
      avgValidationTime: 0,
      cacheHits: 0,
      cacheMisses: 0
    };
    
    // Validation patterns
    this.fraudPatterns = [
      { name: 'time_manipulation', check: this.checkTimeManipulation.bind(this) },
      { name: 'nonce_pattern', check: this.checkNoncePattern.bind(this) },
      { name: 'hash_collision', check: this.checkHashCollision.bind(this) },
      { name: 'difficulty_exploit', check: this.checkDifficultyExploit.bind(this) }
    ];
    
    // Pre-compiled validation regex
    this.hexRegex = /^[0-9a-fA-F]+$/;
    this.addressRegex = /^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,62}$/;
  }
  
  /**
   * Initialize the validator
   */
  async initialize() {
    try {
      // Create worker pool
      await this.createWorkerPool();
      
      // Start monitoring
      this.startMonitoring();
      
      // Load ban list if persisted
      await this.loadBanList();
      
      logger.info('Enhanced share validator initialized');
      this.emit('initialized');
      
      return true;
    } catch (error) {
      logger.error('Failed to initialize validator:', error);
      throw error;
    }
  }
  
  /**
   * Create worker thread pool
   */
  async createWorkerPool() {
    for (let i = 0; i < this.options.workerPoolSize; i++) {
      const worker = new Worker(`${__dirname}/share-validation-worker.js`, {
        workerData: {
          workerId: i,
          options: this.options
        }
      });
      
      worker.on('message', (result) => {
        this.handleWorkerResult(result);
      });
      
      worker.on('error', (error) => {
        logger.error(`Worker ${i} error:`, error);
        this.restartWorker(i);
      });
      
      this.workers.push(worker);
    }
    
    logger.info(`Created ${this.options.workerPoolSize} validation workers`);
  }
  
  /**
   * Validate a share with comprehensive checks
   */
  async validateShare(share, job, miner) {
    const startTime = Date.now();
    
    try {
      this.stats.total++;
      
      // Check if miner is banned
      if (this.isBanned(miner.address || miner.id)) {
        this.stats.banned++;
        return { valid: false, reason: 'banned', ban: true };
      }
      
      // Rate limiting
      if (!this.checkRateLimit(miner)) {
        this.stats.invalid++;
        return { valid: false, reason: 'rate_exceeded' };
      }
      
      // Basic validation
      const basicCheck = this.validateBasicParams(share);
      if (!basicCheck.valid) {
        this.trackInvalidShare(miner, basicCheck.reason);
        this.stats.invalid++;
        return basicCheck;
      }
      
      // Check cache for duplicate
      const shareId = this.getShareId(share);
      if (this.shareCache.has(shareId)) {
        this.stats.duplicate++;
        this.stats.cacheHits++;
        this.trackInvalidShare(miner, 'duplicate');
        return { valid: false, reason: 'duplicate' };
      }
      this.stats.cacheMisses++;
      
      // Time validation
      const timeCheck = this.validateTime(share);
      if (!timeCheck.valid) {
        this.trackInvalidShare(miner, timeCheck.reason);
        this.stats.invalid++;
        return timeCheck;
      }
      
      // Job validation
      if (!this.validateJob(share, job)) {
        this.trackInvalidShare(miner, 'invalid_job');
        this.stats.invalid++;
        return { valid: false, reason: 'invalid_job' };
      }
      
      // Fraud detection
      const fraudCheck = await this.detectFraud(share, miner);
      if (fraudCheck.suspicious) {
        this.trackSuspiciousActivity(miner, fraudCheck.pattern);
        if (fraudCheck.reject) {
          this.stats.invalid++;
          return { valid: false, reason: fraudCheck.reason };
        }
      }
      
      // CPU-intensive validation (proof of work)
      const powResult = await this.validateProofOfWork(share, job);
      
      if (powResult.valid) {
        // Cache valid share
        this.shareCache.set(shareId, {
          timestamp: Date.now(),
          miner: miner.id,
          difficulty: share.difficulty
        });
        
        // Update miner stats
        this.updateMinerStats(miner, true, powResult.isBlock);
        this.stats.valid++;
        
        // Check if it's a block
        if (powResult.isBlock) {
          this.handleBlockFound(share, miner);
        }
      } else {
        this.trackInvalidShare(miner, powResult.reason);
        this.stats.invalid++;
      }
      
      // Update average validation time
      const validationTime = Date.now() - startTime;
      this.updateAvgValidationTime(validationTime);
      
      return powResult;
      
    } catch (error) {
      logger.error('Share validation error:', error);
      this.stats.errors++;
      return { valid: false, reason: 'validation_error' };
    }
  }
  
  /**
   * Validate basic share parameters
   */
  validateBasicParams(share) {
    // Required fields
    const required = ['jobId', 'nonce', 'time', 'extraNonce1', 'extraNonce2'];
    for (const field of required) {
      if (!share[field]) {
        return { valid: false, reason: `missing_${field}` };
      }
    }
    
    // Hex validation
    const hexFields = ['nonce', 'time', 'extraNonce1', 'extraNonce2'];
    for (const field of hexFields) {
      if (!this.hexRegex.test(share[field])) {
        return { valid: false, reason: `invalid_${field}_format` };
      }
    }
    
    // Length validation
    if (share.nonce.length !== 8) {
      return { valid: false, reason: 'invalid_nonce_length' };
    }
    
    if (share.time.length !== 8) {
      return { valid: false, reason: 'invalid_time_length' };
    }
    
    // Address validation if present
    if (share.workerName && share.workerName.includes('.')) {
      const [address] = share.workerName.split('.');
      if (!this.addressRegex.test(address)) {
        return { valid: false, reason: 'invalid_address' };
      }
    }
    
    return { valid: true };
  }
  
  /**
   * Validate share timestamp
   */
  validateTime(share) {
    const shareTime = parseInt(share.time, 16);
    const currentTime = Math.floor(Date.now() / 1000);
    const deviation = Math.abs(currentTime - shareTime);
    
    if (deviation > this.options.maxTimeDeviation) {
      return { 
        valid: false, 
        reason: 'time_too_' + (shareTime > currentTime ? 'new' : 'old'),
        deviation
      };
    }
    
    return { valid: true };
  }
  
  /**
   * Validate job exists and is current
   */
  validateJob(share, job) {
    if (!job) {
      return false;
    }
    
    // Check if job is in cache
    const cachedJob = this.jobCache.get(share.jobId);
    if (cachedJob && cachedJob.id !== job.id) {
      return false;
    }
    
    // Validate job hasn't expired
    if (job.expiresAt && Date.now() > job.expiresAt) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Validate proof of work (delegated to worker)
   */
  async validateProofOfWork(share, job) {
    return new Promise((resolve) => {
      const validationTask = {
        share,
        job,
        callback: resolve,
        timestamp: Date.now()
      };
      
      // Try to assign to available worker
      const availableWorker = this.workers.find((w, i) => !this.isWorkerBusy(i));
      
      if (availableWorker) {
        this.assignToWorker(availableWorker, validationTask);
      } else {
        // Queue for later
        this.workerQueue.push(validationTask);
      }
    });
  }
  
  /**
   * Assign validation task to worker
   */
  assignToWorker(worker, task) {
    const workerId = this.workers.indexOf(worker);
    this.activeWorkers++;
    
    worker.postMessage({
      type: 'validate',
      taskId: crypto.randomBytes(16).toString('hex'),
      share: task.share,
      job: task.job,
      timestamp: task.timestamp
    });
    
    // Store callback for result handling
    if (!worker.pendingCallbacks) {
      worker.pendingCallbacks = new Map();
    }
    worker.pendingCallbacks.set(task.timestamp, task.callback);
  }
  
  /**
   * Handle worker validation result
   */
  handleWorkerResult(result) {
    const worker = this.workers[result.workerId];
    this.activeWorkers--;
    
    // Call original callback
    if (worker.pendingCallbacks && worker.pendingCallbacks.has(result.timestamp)) {
      const callback = worker.pendingCallbacks.get(result.timestamp);
      worker.pendingCallbacks.delete(result.timestamp);
      callback(result);
    }
    
    // Process queued tasks
    if (this.workerQueue.length > 0) {
      const nextTask = this.workerQueue.shift();
      this.assignToWorker(worker, nextTask);
    }
  }
  
  /**
   * Detect fraudulent patterns
   */
  async detectFraud(share, miner) {
    const results = [];
    
    for (const pattern of this.fraudPatterns) {
      const result = await pattern.check(share, miner);
      if (result.suspicious) {
        results.push({
          pattern: pattern.name,
          confidence: result.confidence,
          details: result.details
        });
      }
    }
    
    if (results.length === 0) {
      return { suspicious: false };
    }
    
    // Determine action based on confidence
    const maxConfidence = Math.max(...results.map(r => r.confidence));
    const shouldReject = maxConfidence > 0.8;
    
    return {
      suspicious: true,
      reject: shouldReject,
      pattern: results[0].pattern,
      reason: shouldReject ? 'fraud_detected' : null,
      details: results
    };
  }
  
  /**
   * Check for time manipulation
   */
  checkTimeManipulation(share, miner) {
    const stats = this.getMinerStats(miner);
    if (!stats.lastShareTime) {
      return { suspicious: false };
    }
    
    const timeDiff = parseInt(share.time, 16) - stats.lastShareTime;
    
    // Check for backwards time
    if (timeDiff < 0) {
      return {
        suspicious: true,
        confidence: 0.9,
        details: { timeDiff }
      };
    }
    
    // Check for time jumps
    if (timeDiff > 300) { // 5 minutes
      return {
        suspicious: true,
        confidence: 0.6,
        details: { timeDiff }
      };
    }
    
    return { suspicious: false };
  }
  
  /**
   * Check for suspicious nonce patterns
   */
  checkNoncePattern(share, miner) {
    const stats = this.getMinerStats(miner);
    if (!stats.nonceHistory) {
      stats.nonceHistory = [];
    }
    
    const nonce = parseInt(share.nonce, 16);
    stats.nonceHistory.push(nonce);
    
    // Keep last 100 nonces
    if (stats.nonceHistory.length > 100) {
      stats.nonceHistory.shift();
    }
    
    // Check for sequential nonces
    if (stats.nonceHistory.length >= 10) {
      const recent = stats.nonceHistory.slice(-10);
      const differences = [];
      
      for (let i = 1; i < recent.length; i++) {
        differences.push(recent[i] - recent[i-1]);
      }
      
      // All differences are the same (sequential mining)
      const uniqueDiffs = new Set(differences);
      if (uniqueDiffs.size === 1) {
        return {
          suspicious: true,
          confidence: 0.7,
          details: { pattern: 'sequential', step: differences[0] }
        };
      }
    }
    
    return { suspicious: false };
  }
  
  /**
   * Check for hash collisions
   */
  checkHashCollision(share, miner) {
    // This would check for statistically unlikely hash patterns
    // For now, simplified implementation
    return { suspicious: false };
  }
  
  /**
   * Check for difficulty exploits
   */
  checkDifficultyExploit(share, miner) {
    const stats = this.getMinerStats(miner);
    
    // Check if miner is submitting shares just above difficulty
    if (stats.validShares > 100) {
      const avgDiffRatio = stats.totalDifficultyRatio / stats.validShares;
      
      // Suspicious if all shares are within 1% of minimum difficulty
      if (avgDiffRatio < 1.01) {
        return {
          suspicious: true,
          confidence: 0.8,
          details: { avgDiffRatio }
        };
      }
    }
    
    return { suspicious: false };
  }
  
  /**
   * Check rate limit for miner
   */
  checkRateLimit(miner) {
    const stats = this.getMinerStats(miner);
    const now = Date.now();
    
    // Reset rate limit window
    if (now - stats.rateWindowStart > 1000) {
      stats.rateWindowStart = now;
      stats.rateWindowShares = 0;
    }
    
    stats.rateWindowShares++;
    
    return stats.rateWindowShares <= this.options.rateLimit;
  }
  
  /**
   * Track invalid share
   */
  trackInvalidShare(miner, reason) {
    const stats = this.getMinerStats(miner);
    stats.invalidShares++;
    stats.invalidReasons[reason] = (stats.invalidReasons[reason] || 0) + 1;
    
    // Check for ban threshold
    if (stats.invalidShares >= this.options.banThreshold) {
      this.banMiner(miner, 'excessive_invalid_shares');
    }
    
    // Alert on high invalid rate
    const invalidRate = stats.invalidShares / (stats.validShares + stats.invalidShares);
    if (invalidRate > this.options.alertThreshold && stats.validShares > 100) {
      this.emit('high-invalid-rate', {
        miner,
        rate: invalidRate,
        reasons: stats.invalidReasons
      });
    }
  }
  
  /**
   * Track suspicious activity
   */
  trackSuspiciousActivity(miner, pattern) {
    const key = `${miner.id}:${pattern}`;
    const count = (this.suspiciousPatterns.get(key) || 0) + 1;
    this.suspiciousPatterns.set(key, count);
    
    // Auto-ban after threshold
    if (count >= 10) {
      this.banMiner(miner, `suspicious_pattern:${pattern}`);
    }
    
    this.emit('suspicious-activity', {
      miner,
      pattern,
      count
    });
  }
  
  /**
   * Ban a miner
   */
  banMiner(miner, reason) {
    const banKey = miner.address || miner.id;
    
    this.banList.set(banKey, {
      timestamp: Date.now(),
      reason,
      miner: {
        id: miner.id,
        address: miner.address,
        ip: miner.ip
      }
    });
    
    logger.warn(`Banned miner ${banKey}: ${reason}`);
    this.emit('miner-banned', { miner, reason });
  }
  
  /**
   * Check if miner is banned
   */
  isBanned(identifier) {
    const ban = this.banList.get(identifier);
    if (!ban) return false;
    
    // Check if ban expired
    if (Date.now() - ban.timestamp > this.options.banDuration) {
      this.banList.delete(identifier);
      return false;
    }
    
    return true;
  }
  
  /**
   * Get or create miner stats
   */
  getMinerStats(miner) {
    const key = miner.id || miner.address;
    
    if (!this.minerStats.has(key)) {
      this.minerStats.set(key, {
        validShares: 0,
        invalidShares: 0,
        blocks: 0,
        invalidReasons: {},
        totalDifficultyRatio: 0,
        lastShareTime: null,
        rateWindowStart: Date.now(),
        rateWindowShares: 0,
        nonceHistory: []
      });
    }
    
    return this.minerStats.get(key);
  }
  
  /**
   * Update miner statistics
   */
  updateMinerStats(miner, valid, isBlock = false) {
    const stats = this.getMinerStats(miner);
    
    if (valid) {
      stats.validShares++;
      if (isBlock) {
        stats.blocks++;
      }
      stats.lastShareTime = Date.now();
    } else {
      stats.invalidShares++;
    }
  }
  
  /**
   * Handle block found
   */
  handleBlockFound(share, miner) {
    logger.info(`🎉 Block found by ${miner.address || miner.id}!`);
    
    this.emit('block-found', {
      share,
      miner,
      timestamp: Date.now()
    });
  }
  
  /**
   * Get share ID for deduplication
   */
  getShareId(share) {
    const data = `${share.jobId}:${share.extraNonce1}:${share.extraNonce2}:${share.nonce}:${share.time}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }
  
  /**
   * Update average validation time
   */
  updateAvgValidationTime(time) {
    const alpha = 0.1; // Exponential moving average factor
    if (this.stats.avgValidationTime === 0) {
      this.stats.avgValidationTime = time;
    } else {
      this.stats.avgValidationTime = (1 - alpha) * this.stats.avgValidationTime + alpha * time;
    }
  }
  
  /**
   * Start monitoring
   */
  startMonitoring() {
    this.monitorInterval = setInterval(() => {
      const stats = this.getStatistics();
      
      // Log statistics
      logger.info('Validation stats:', {
        total: stats.total,
        valid: stats.valid,
        invalid: stats.invalid,
        validRate: stats.validRate.toFixed(2) + '%',
        avgTime: stats.avgValidationTime.toFixed(2) + 'ms',
        cacheHitRate: stats.cacheHitRate.toFixed(2) + '%'
      });
      
      // Emit stats event
      this.emit('stats', stats);
      
      // Check for anomalies
      if (stats.validRate < 50 && stats.total > 1000) {
        this.emit('anomaly', {
          type: 'low_valid_rate',
          rate: stats.validRate
        });
      }
      
    }, this.options.statsInterval);
  }
  
  /**
   * Get statistics
   */
  getStatistics() {
    const stats = { ...this.stats };
    
    // Calculate rates
    stats.validRate = stats.total > 0 ? (stats.valid / stats.total) * 100 : 0;
    stats.invalidRate = stats.total > 0 ? (stats.invalid / stats.total) * 100 : 0;
    stats.duplicateRate = stats.total > 0 ? (stats.duplicate / stats.total) * 100 : 0;
    
    // Cache statistics
    const cacheTotal = stats.cacheHits + stats.cacheMisses;
    stats.cacheHitRate = cacheTotal > 0 ? (stats.cacheHits / cacheTotal) * 100 : 0;
    
    // Miner statistics
    stats.totalMiners = this.minerStats.size;
    stats.bannedMiners = this.banList.size;
    
    // Worker statistics
    stats.activeWorkers = this.activeWorkers;
    stats.queuedTasks = this.workerQueue.length;
    
    return stats;
  }
  
  /**
   * Get miner statistics
   */
  getMinerStatistics(minerId) {
    return this.minerStats.get(minerId) || null;
  }
  
  /**
   * Clear old data
   */
  async cleanup() {
    const now = Date.now();
    
    // Clear old bans
    for (const [key, ban] of this.banList) {
      if (now - ban.timestamp > this.options.banDuration) {
        this.banList.delete(key);
      }
    }
    
    // Clear old suspicious patterns
    for (const [key, count] of this.suspiciousPatterns) {
      if (count === 0) {
        this.suspiciousPatterns.delete(key);
      } else {
        // Decay count
        this.suspiciousPatterns.set(key, Math.floor(count * 0.9));
      }
    }
    
    // Clear old miner stats (inactive for 24 hours)
    for (const [key, stats] of this.minerStats) {
      if (stats.lastShareTime && now - stats.lastShareTime > 86400000) {
        this.minerStats.delete(key);
      }
    }
  }
  
  /**
   * Load persisted ban list
   */
  async loadBanList() {
    // In production, load from database or file
    // For now, starts empty
  }
  
  /**
   * Save ban list
   */
  async saveBanList() {
    // In production, persist to database or file
  }
  
  /**
   * Check if worker is busy
   */
  isWorkerBusy(workerId) {
    const worker = this.workers[workerId];
    return worker.pendingCallbacks && worker.pendingCallbacks.size > 0;
  }
  
  /**
   * Restart failed worker
   */
  async restartWorker(workerId) {
    logger.info(`Restarting worker ${workerId}`);
    
    const oldWorker = this.workers[workerId];
    if (oldWorker) {
      oldWorker.terminate();
    }
    
    const worker = new Worker(`${__dirname}/share-validation-worker.js`, {
      workerData: {
        workerId,
        options: this.options
      }
    });
    
    worker.on('message', (result) => {
      this.handleWorkerResult(result);
    });
    
    worker.on('error', (error) => {
      logger.error(`Worker ${workerId} error:`, error);
      this.restartWorker(workerId);
    });
    
    this.workers[workerId] = worker;
  }
  
  /**
   * Shutdown validator
   */
  async shutdown() {
    // Stop monitoring
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }
    
    // Save ban list
    await this.saveBanList();
    
    // Terminate workers
    for (const worker of this.workers) {
      worker.terminate();
    }
    
    logger.info('Enhanced share validator shutdown complete');
  }
}

module.exports = EnhancedShareValidator;