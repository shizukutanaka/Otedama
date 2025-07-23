/**
 * Share Validator
 * Validates mining shares for different algorithms
 */

const crypto = require('crypto');
const { createLogger } = require('../core/logger');

const logger = createLogger('share-validator');

// Difficulty 1 targets for different algorithms
const DIFF1_TARGETS = {
  sha256: '00000000ffff0000000000000000000000000000000000000000000000000000',
  scrypt: '0000ffff00000000000000000000000000000000000000000000000000000000',
  ethash: '00000000ffff0000000000000000000000000000000000000000000000000000',
  randomx: '00000000ffff0000000000000000000000000000000000000000000000000000',
  kawpow: '00000000ffff0000000000000000000000000000000000000000000000000000'
};

class ShareCache {
  constructor(maxSize = 100000, ttl = 600000) { // 10 minutes TTL
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.shares = new Map();
    this.accessOrder = [];
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
  }

  add(shareId, data) {
    // Check if already exists
    if (this.shares.has(shareId)) {
      this.stats.hits++;
      return false; // Duplicate
    }
    
    this.stats.misses++;
    
    // Evict old entries if needed
    while (this.shares.size >= this.maxSize) {
      const oldestId = this.accessOrder.shift();
      this.shares.delete(oldestId);
      this.stats.evictions++;
    }
    
    // Add new share
    this.shares.set(shareId, {
      data,
      timestamp: Date.now()
    });
    this.accessOrder.push(shareId);
    
    return true; // New share
  }

  cleanup() {
    const now = Date.now();
    const expired = [];
    
    for (const [shareId, share] of this.shares) {
      if (now - share.timestamp > this.ttl) {
        expired.push(shareId);
      }
    }
    
    for (const shareId of expired) {
      this.shares.delete(shareId);
      const index = this.accessOrder.indexOf(shareId);
      if (index > -1) {
        this.accessOrder.splice(index, 1);
      }
    }
    
    return expired.length;
  }

  getStats() {
    return {
      ...this.stats,
      size: this.shares.size,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses)
    };
  }
}

class FraudDetector {
  constructor() {
    this.minerPatterns = new Map();
    this.suspiciousMiners = new Set();
    this.thresholds = {
      maxSharesPerMinute: 1000,
      minTimeBetweenShares: 50, // milliseconds
      maxConsecutiveInvalid: 10,
      noncePatternThreshold: 0.8,
      timeVarianceThreshold: 0.1
    };
  }

  analyzeMiner(minerId, share, isValid) {
    if (!this.minerPatterns.has(minerId)) {
      this.minerPatterns.set(minerId, {
        shares: [],
        invalidCount: 0,
        consecutiveInvalid: 0,
        lastShareTime: 0,
        nonceHistory: [],
        suspicionLevel: 0
      });
    }
    
    const pattern = this.minerPatterns.get(minerId);
    const now = Date.now();
    
    // Update pattern data
    pattern.shares.push({
      timestamp: now,
      valid: isValid,
      nonce: share.nonce,
      time: share.time
    });
    
    // Keep only recent shares (last 5 minutes)
    const cutoff = now - 300000;
    pattern.shares = pattern.shares.filter(s => s.timestamp > cutoff);
    
    // Update counters
    if (!isValid) {
      pattern.invalidCount++;
      pattern.consecutiveInvalid++;
    } else {
      pattern.consecutiveInvalid = 0;
    }
    
    // Check for fraud patterns
    const fraudIndicators = [];
    
    // 1. Rapid submission check
    if (pattern.lastShareTime > 0) {
      const timeDiff = now - pattern.lastShareTime;
      if (timeDiff < this.thresholds.minTimeBetweenShares) {
        fraudIndicators.push(FraudPattern.RAPID_SUBMISSION);
      }
    }
    pattern.lastShareTime = now;
    
    // 2. Share rate check
    const shareRate = pattern.shares.length / 5; // per minute
    if (shareRate > this.thresholds.maxSharesPerMinute) {
      fraudIndicators.push(FraudPattern.RAPID_SUBMISSION);
    }
    
    // 3. Consecutive invalid shares
    if (pattern.consecutiveInvalid > this.thresholds.maxConsecutiveInvalid) {
      fraudIndicators.push(FraudPattern.DIFFICULTY_EXPLOIT);
    }
    
    // 4. Nonce pattern detection
    pattern.nonceHistory.push(share.nonce);
    if (pattern.nonceHistory.length > 20) {
      pattern.nonceHistory.shift();
      
      if (this.detectNoncePattern(pattern.nonceHistory)) {
        fraudIndicators.push(FraudPattern.NONCE_PATTERN);
      }
    }
    
    // 5. Time manipulation check
    if (this.detectTimeManipulation(pattern.shares)) {
      fraudIndicators.push(FraudPattern.TIME_MANIPULATION);
    }
    
    // Update suspicion level
    pattern.suspicionLevel = Math.max(0, pattern.suspicionLevel - 0.1); // Decay
    pattern.suspicionLevel += fraudIndicators.length * 0.3;
    
    // Mark as suspicious if threshold exceeded
    if (pattern.suspicionLevel > 1) {
      this.suspiciousMiners.add(minerId);
    }
    
    return {
      fraudIndicators,
      suspicionLevel: pattern.suspicionLevel,
      isSuspicious: pattern.suspicionLevel > 1
    };
  }

  detectNoncePattern(nonceHistory) {
    if (nonceHistory.length < 10) return false;
    
    // Check for sequential patterns
    let sequential = 0;
    for (let i = 1; i < nonceHistory.length; i++) {
      const diff = parseInt(nonceHistory[i], 16) - parseInt(nonceHistory[i-1], 16);
      if (Math.abs(diff) === 1 || diff === 0) {
        sequential++;
      }
    }
    
    const sequentialRatio = sequential / (nonceHistory.length - 1);
    return sequentialRatio > this.thresholds.noncePatternThreshold;
  }

  detectTimeManipulation(shares) {
    if (shares.length < 10) return false;
    
    const times = shares.map(s => s.time);
    const timeDiffs = [];
    
    for (let i = 1; i < times.length; i++) {
      timeDiffs.push(times[i] - times[i-1]);
    }
    
    // Calculate variance
    const avgDiff = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
    const variance = timeDiffs.reduce((sum, diff) => {
      return sum + Math.pow(diff - avgDiff, 2);
    }, 0) / timeDiffs.length;
    
    const coefficientOfVariation = Math.sqrt(variance) / avgDiff;
    
    // Very low variance might indicate manipulation
    return coefficientOfVariation < this.thresholds.timeVarianceThreshold;
  }

  isSuspicious(minerId) {
    return this.suspiciousMiners.has(minerId);
  }

  clearSuspicion(minerId) {
    this.suspiciousMiners.delete(minerId);
    this.minerPatterns.delete(minerId);
  }

  getStats() {
    return {
      totalMiners: this.minerPatterns.size,
      suspiciousMiners: this.suspiciousMiners.size,
      patterns: Array.from(this.minerPatterns.entries()).map(([minerId, pattern]) => ({
        minerId,
        suspicionLevel: pattern.suspicionLevel,
        invalidRate: pattern.invalidCount / pattern.shares.length,
        shareRate: pattern.shares.length / 5 // per minute
      }))
    };
  }
}

class ShareValidator extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      enableDuplicateCheck: options.enableDuplicateCheck !== false,
      enableFraudDetection: options.enableFraudDetection !== false,
      enableTimeValidation: options.enableTimeValidation !== false,
      maxTimeDeviation: options.maxTimeDeviation || 7200, // 2 hours
      shareWindow: options.shareWindow || 600000, // 10 minutes
      cacheSize: options.cacheSize || 100000,
      cacheTTL: options.cacheTTL || 600000,
      ...options
    };
    
    // Components
    this.shareCache = new ShareCache(this.config.cacheSize, this.config.cacheTTL);
    this.fraudDetector = new FraudDetector();
    
    // Current job tracking
    this.currentJobs = new Map();
    
    // Statistics
    this.stats = {
      totalShares: 0,
      validShares: 0,
      invalidShares: {},
      fraudsDetected: 0,
      duplicatesRejected: 0,
      avgValidationTime: 0
    };
    
    // Cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000); // Every minute
  }

  /**
   * Register a new job
   */
  registerJob(jobId, jobData) {
    this.currentJobs.set(jobId, {
      ...jobData,
      createdAt: Date.now(),
      shares: 0,
      validShares: 0
    });
    
    // Clean old jobs
    const cutoff = Date.now() - this.config.shareWindow * 2;
    for (const [id, job] of this.currentJobs) {
      if (job.createdAt < cutoff) {
        this.currentJobs.delete(id);
      }
    }
  }

  /**
   * Validate a share submission
   */
  async validateShare(share, minerData) {
    const startTime = Date.now();
    this.stats.totalShares++;
    
    try {
      // Basic validation
      const basicValidation = this.performBasicValidation(share);
      if (!basicValidation.valid) {
        return this.handleInvalidShare(basicValidation.reason, share, minerData);
      }
      
      // Check for duplicate
      if (this.config.enableDuplicateCheck) {
        const shareId = this.generateShareId(share);
        if (!this.shareCache.add(shareId, share)) {
          this.stats.duplicatesRejected++;
          return this.handleInvalidShare(ValidationResult.DUPLICATE_SHARE, share, minerData);
        }
      }
      
      // Time validation
      if (this.config.enableTimeValidation) {
        const timeValidation = this.validateTime(share);
        if (!timeValidation.valid) {
          return this.handleInvalidShare(timeValidation.reason, share, minerData);
        }
      }
      
      // Get job data
      const job = this.currentJobs.get(share.jobId);
      if (!job) {
        return this.handleInvalidShare(ValidationResult.STALE_SHARE, share, minerData);
      }
      
      // Algorithm-specific validation
      const algorithmValidation = await this.validateByAlgorithm(share, job, minerData);
      if (!algorithmValidation.valid) {
        return this.handleInvalidShare(algorithmValidation.reason, share, minerData);
      }
      
      // Difficulty check
      const difficultyValidation = this.validateDifficulty(
        algorithmValidation.hash,
        share.difficulty,
        job.difficulty
      );
      if (!difficultyValidation.valid) {
        return this.handleInvalidShare(difficultyValidation.reason, share, minerData);
      }
      
      // Fraud detection
      if (this.config.enableFraudDetection) {
        const fraudAnalysis = this.fraudDetector.analyzeMiner(
          minerData.minerId,
          share,
          true
        );
        
        if (fraudAnalysis.isSuspicious) {
          logger.warn(`Suspicious activity detected for miner ${minerData.minerId}`, {
            fraudIndicators: fraudAnalysis.fraudIndicators,
            suspicionLevel: fraudAnalysis.suspicionLevel
          });
          
          this.emit('fraud:detected', {
            minerId: minerData.minerId,
            fraudIndicators: fraudAnalysis.fraudIndicators,
            share
          });
        }
      }
      
      // Valid share
      this.stats.validShares++;
      job.shares++;
      job.validShares++;
      
      // Update validation time metric
      const validationTime = Date.now() - startTime;
      this.stats.avgValidationTime = 
        (this.stats.avgValidationTime * 0.95) + (validationTime * 0.05);
      
      return {
        valid: true,
        hash: algorithmValidation.hash,
        difficulty: share.difficulty,
        jobId: share.jobId,
        validationTime
      };
      
    } catch (error) {
      logger.error('Share validation error:', error);
      return this.handleInvalidShare(ValidationResult.INVALID_SHARE, share, minerData);
    }
  }

  performBasicValidation(share) {
    // Check required fields
    const requiredFields = ['jobId', 'nonce', 'time', 'extraNonce1', 'extraNonce2'];
    for (const field of requiredFields) {
      if (!share[field]) {
        return { valid: false, reason: ValidationResult.INVALID_SHARE };
      }
    }
    
    // Validate nonce format
    if (!/^[0-9a-fA-F]+$/.test(share.nonce)) {
      return { valid: false, reason: ValidationResult.INVALID_NONCE };
    }
    
    return { valid: true };
  }

  validateTime(share) {
    const now = Math.floor(Date.now() / 1000);
    const shareTime = parseInt(share.time, 16);
    
    if (isNaN(shareTime)) {
      return { valid: false, reason: ValidationResult.INVALID_TIME };
    }
    
    const deviation = Math.abs(now - shareTime);
    if (deviation > this.config.maxTimeDeviation) {
      return { valid: false, reason: ValidationResult.INVALID_TIME };
    }
    
    return { valid: true };
  }

  async validateByAlgorithm(share, job, minerData) {
    const algorithm = job.algorithm || minerData.algorithm;
    const validator = ALGORITHM_VALIDATORS[algorithm];
    
    if (!validator) {
      logger.error(`No validator for algorithm: ${algorithm}`);
      return { valid: false, reason: ValidationResult.INVALID_SHARE };
    }
    
    try {
      const result = await validator.validate(share, job);
      return result;
    } catch (error) {
      logger.error(`Algorithm validation error for ${algorithm}:`, error);
      return { valid: false, reason: ValidationResult.INVALID_HASH };
    }
  }

  validateDifficulty(hash, shareDifficulty, jobDifficulty) {
    // Convert hash to big number for comparison
    const hashNum = BigInt('0x' + hash);
    const target = this.difficultyToTarget(shareDifficulty);
    
    // Check if hash meets share difficulty
    if (hashNum > target) {
      return { valid: false, reason: ValidationResult.LOW_DIFFICULTY };
    }
    
    // Check if it's a block solution
    const blockTarget = this.difficultyToTarget(jobDifficulty);
    const isBlockSolution = hashNum <= blockTarget;
    
    return { 
      valid: true, 
      isBlockSolution,
      shareDifficulty,
      actualDifficulty: this.hashToDifficulty(hash)
    };
  }

  difficultyToTarget(difficulty) {
    // Convert difficulty to target
    // This is a simplified version - actual implementation depends on algorithm
    const maxTarget = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
    return maxTarget / BigInt(Math.floor(difficulty));
  }

  hashToDifficulty(hash) {
    const hashNum = BigInt('0x' + hash);
    const maxTarget = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
    return Number(maxTarget / hashNum);
  }

  generateShareId(share) {
    // Generate unique ID for duplicate detection
    const data = `${share.jobId}:${share.nonce}:${share.extraNonce1}:${share.extraNonce2}:${share.time}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  handleInvalidShare(reason, share, minerData) {
    // Update statistics
    this.stats.invalidShares[reason] = (this.stats.invalidShares[reason] || 0) + 1;
    
    // Fraud detection for invalid shares
    if (this.config.enableFraudDetection) {
      const fraudAnalysis = this.fraudDetector.analyzeMiner(
        minerData.minerId,
        share,
        false
      );
      
      if (fraudAnalysis.fraudIndicators.length > 0) {
        this.stats.fraudsDetected++;
      }
    }
    
    // Update job stats
    const job = this.currentJobs.get(share.jobId);
    if (job) {
      job.shares++;
    }
    
    this.emit('share:invalid', {
      reason,
      share,
      minerId: minerData.minerId
    });
    
    return {
      valid: false,
      reason,
      message: this.getReasonMessage(reason)
    };
  }

  getReasonMessage(reason) {
    const messages = {
      [ValidationResult.INVALID_NONCE]: 'Invalid nonce format',
      [ValidationResult.INVALID_HASH]: 'Invalid hash',
      [ValidationResult.LOW_DIFFICULTY]: 'Share difficulty too low',
      [ValidationResult.DUPLICATE_SHARE]: 'Duplicate share',
      [ValidationResult.INVALID_TIME]: 'Invalid timestamp',
      [ValidationResult.STALE_SHARE]: 'Stale share - job expired',
      [ValidationResult.INVALID_EXTRADATA]: 'Invalid extra data',
      [ValidationResult.FRAUD_DETECTED]: 'Suspicious activity detected'
    };
    
    return messages[reason] || 'Invalid share';
  }

  cleanup() {
    // Clean share cache
    const expired = this.shareCache.cleanup();
    
    // Clean old jobs
    const cutoff = Date.now() - this.config.shareWindow * 2;
    let removed = 0;
    
    for (const [jobId, job] of this.currentJobs) {
      if (job.createdAt < cutoff) {
        this.currentJobs.delete(jobId);
        removed++;
      }
    }
    
    logger.debug(`Cleanup: ${expired} expired shares, ${removed} old jobs removed`);
  }

  getStatistics() {
    const cacheStats = this.shareCache.getStats();
    const fraudStats = this.fraudDetector.getStats();
    
    return {
      ...this.stats,
      cache: cacheStats,
      fraud: fraudStats,
      activeJobs: this.currentJobs.size,
      invalidShareReasons: Object.entries(this.stats.invalidShares)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({
          reason,
          count,
          percentage: (count / this.stats.totalShares) * 100
        })),
      validShareRate: this.stats.totalShares > 0 
        ? (this.stats.validShares / this.stats.totalShares) * 100 
        : 0
    };
  }

  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.removeAllListeners();
  }
}

// Algorithm validator modules (stubs - would be separate files in production)
const sha256Validator = {
  async validate(share, job) {
    // SHA256 validation logic
    const headerBin = Buffer.concat([
      Buffer.from(job.version, 'hex'),
      Buffer.from(job.prevHash, 'hex'),
      Buffer.from(share.merkleRoot || job.merkleRoot, 'hex'),
      Buffer.from(share.time, 'hex'),
      Buffer.from(job.bits, 'hex'),
      Buffer.from(share.nonce, 'hex')
    ]);
    
    const hash = crypto.createHash('sha256')
      .update(crypto.createHash('sha256').update(headerBin).digest())
      .digest('hex');
    
    return { valid: true, hash };
  }
};

// Export with stub validators for demo
ALGORITHM_VALIDATORS.sha256 = sha256Validator;
ALGORITHM_VALIDATORS.scrypt = sha256Validator; // Stub
ALGORITHM_VALIDATORS.ethash = sha256Validator; // Stub
ALGORITHM_VALIDATORS.kawpow = sha256Validator; // Stub
ALGORITHM_VALIDATORS.randomx = sha256Validator; // Stub

module.exports = ShareValidator;