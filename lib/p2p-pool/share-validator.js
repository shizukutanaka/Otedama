const EventEmitter = require('events');
const crypto = require('crypto');
const { BigNumber } = require('bignumber.js');

class ShareValidator extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Validation settings
      maxTimeDeviation: options.maxTimeDeviation || 7200, // 2 hours
      shareTimeout: options.shareTimeout || 300000, // 5 minutes
      duplicateWindow: options.duplicateWindow || 3600000, // 1 hour
      
      // Difficulty settings
      minShareDifficulty: options.minShareDifficulty || 1000,
      difficultyPrecision: options.difficultyPrecision || 8,
      
      // Security settings
      maxSharesPerSecond: options.maxSharesPerSecond || 10,
      banThreshold: options.banThreshold || 50, // 50 invalid shares
      banDuration: options.banDuration || 3600000, // 1 hour
      
      // Algorithm specific
      algorithms: {
        SHA256: { doubleHash: true },
        Scrypt: { doubleHash: false, N: 1024, r: 1, p: 1 },
        X11: { doubleHash: false, chainedHashes: 11 },
        Ethash: { doubleHash: false, dagSize: true },
        RandomX: { doubleHash: false, cache: true }
      }
    };
    
    // Validation state
    this.submittedShares = new Map(); // Duplicate detection
    this.minerStats = new Map(); // Miner statistics
    this.bannedMiners = new Map(); // Banned miners
    this.jobTemplates = new Map(); // Job templates for validation
    
    // Start cleanup interval
    this.startCleanup();
  }
  
  async validateShare(share, job, miner) {
    const validation = {
      valid: false,
      isBlock: false,
      difficulty: 0,
      hash: null,
      error: null,
      timestamp: Date.now()
    };
    
    try {
      // 1. Check if miner is banned
      if (this.isBanned(miner.id)) {
        validation.error = 'Miner banned';
        return validation;
      }
      
      // 2. Rate limiting
      if (!this.checkRateLimit(miner.id)) {
        validation.error = 'Rate limit exceeded';
        this.recordInvalidShare(miner.id, 'rate_limit');
        return validation;
      }
      
      // 3. Validate job exists and is current
      if (!job || !this.jobTemplates.has(job.id)) {
        validation.error = 'Invalid job';
        this.recordInvalidShare(miner.id, 'invalid_job');
        return validation;
      }
      
      // 4. Check for duplicate shares
      if (this.isDuplicateShare(share)) {
        validation.error = 'Duplicate share';
        this.recordInvalidShare(miner.id, 'duplicate');
        return validation;
      }
      
      // 5. Validate share parameters
      const paramValidation = this.validateShareParameters(share, job);
      if (!paramValidation.valid) {
        validation.error = paramValidation.error;
        this.recordInvalidShare(miner.id, 'invalid_params');
        return validation;
      }
      
      // 6. Validate time
      const timeValidation = this.validateTime(share.nTime, job.timestamp);
      if (!timeValidation.valid) {
        validation.error = timeValidation.error;
        this.recordInvalidShare(miner.id, 'invalid_time');
        return validation;
      }
      
      // 7. Build block header
      const header = this.buildBlockHeader(job, share);
      
      // 8. Calculate hash based on algorithm
      const hashResult = await this.calculateHash(header, job.algorithm || 'SHA256');
      validation.hash = hashResult.hash;
      
      // 9. Validate difficulty
      const difficultyResult = this.validateDifficulty(
        hashResult.hash,
        miner.difficulty,
        job.networkDifficulty
      );
      
      if (!difficultyResult.valid) {
        validation.error = 'Low difficulty share';
        this.recordInvalidShare(miner.id, 'low_difficulty');
        return validation;
      }
      
      // Share is valid
      validation.valid = true;
      validation.difficulty = difficultyResult.shareDifficulty;
      validation.isBlock = difficultyResult.isBlock;
      
      // Record valid share
      this.recordValidShare(miner.id, share, validation.difficulty);
      
      // Store share to prevent duplicates
      this.storeShare(share);
      
      return validation;
      
    } catch (error) {
      validation.error = 'Validation error: ' + error.message;
      this.emit('error', { type: 'validation', error });
      return validation;
    }
  }
  
  validateShareParameters(share, job) {
    // Validate required fields
    if (!share.jobId || !share.extraNonce1 || !share.extraNonce2 || 
        share.nTime === undefined || share.nonce === undefined) {
      return { valid: false, error: 'Missing parameters' };
    }
    
    // Validate job ID
    if (share.jobId !== job.id) {
      return { valid: false, error: 'Job ID mismatch' };
    }
    
    // Validate extraNonce2 length
    const expectedLength = job.extraNonce2Size || 4;
    if (share.extraNonce2.length !== expectedLength * 2) {
      return { valid: false, error: 'Invalid extraNonce2 length' };
    }
    
    // Validate hex format
    if (!/^[0-9a-fA-F]+$/.test(share.extraNonce1) ||
        !/^[0-9a-fA-F]+$/.test(share.extraNonce2)) {
      return { valid: false, error: 'Invalid hex format' };
    }
    
    // Validate nonce range
    if (share.nonce < 0 || share.nonce > 0xFFFFFFFF) {
      return { valid: false, error: 'Invalid nonce range' };
    }
    
    return { valid: true };
  }
  
  validateTime(shareTime, jobTime) {
    const currentTime = Math.floor(Date.now() / 1000);
    
    // Check if time is not too far in the past
    if (shareTime < jobTime) {
      return { valid: false, error: 'Share time before job time' };
    }
    
    // Check if time is not too far in the future
    if (shareTime > currentTime + 300) { // 5 minutes
      return { valid: false, error: 'Share time too far in future' };
    }
    
    // Check maximum deviation
    const deviation = Math.abs(shareTime - currentTime);
    if (deviation > this.config.maxTimeDeviation) {
      return { valid: false, error: 'Time deviation too large' };
    }
    
    return { valid: true };
  }
  
  buildBlockHeader(job, share) {
    const header = Buffer.alloc(80);
    
    // Version (4 bytes)
    header.writeUInt32LE(job.version || 1, 0);
    
    // Previous block hash (32 bytes)
    const prevHash = Buffer.from(job.previousHash, 'hex');
    prevHash.reverse().copy(header, 4);
    
    // Merkle root (32 bytes)
    const merkleRoot = this.calculateMerkleRoot(job, share);
    merkleRoot.copy(header, 36);
    
    // Timestamp (4 bytes)
    header.writeUInt32LE(share.nTime, 68);
    
    // Bits (4 bytes)
    header.writeUInt32LE(job.bits, 72);
    
    // Nonce (4 bytes)
    header.writeUInt32LE(share.nonce, 76);
    
    return header;
  }
  
  calculateMerkleRoot(job, share) {
    // Build coinbase transaction with extraNonce
    const coinbase = this.buildCoinbase(job, share);
    const coinbaseHash = this.doubleSHA256(coinbase);
    
    // Calculate merkle root with other transactions
    let hashes = [coinbaseHash];
    
    if (job.transactions && job.transactions.length > 0) {
      hashes = hashes.concat(job.transactions.map(tx => 
        Buffer.from(tx.hash, 'hex').reverse()
      ));
    }
    
    // Build merkle tree
    while (hashes.length > 1) {
      const newHashes = [];
      
      for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = hashes[i + 1] || left;
        const combined = Buffer.concat([left, right]);
        newHashes.push(this.doubleSHA256(combined));
      }
      
      hashes = newHashes;
    }
    
    return hashes[0].reverse();
  }
  
  buildCoinbase(job, share) {
    // Simplified coinbase building
    const extraNonce = Buffer.concat([
      Buffer.from(share.extraNonce1, 'hex'),
      Buffer.from(share.extraNonce2, 'hex')
    ]);
    
    // This would be the actual coinbase transaction construction
    return Buffer.concat([
      Buffer.from(job.coinbase1 || '', 'hex'),
      extraNonce,
      Buffer.from(job.coinbase2 || '', 'hex')
    ]);
  }
  
  async calculateHash(header, algorithm = 'SHA256') {
    const algConfig = this.config.algorithms[algorithm];
    
    switch (algorithm) {
      case 'SHA256':
        return {
          hash: algConfig.doubleHash ? 
            this.doubleSHA256(header) : 
            crypto.createHash('sha256').update(header).digest()
        };
        
      case 'Scrypt':
        return {
          hash: await this.scrypt(header, algConfig)
        };
        
      case 'X11':
        return {
          hash: await this.x11(header)
        };
        
      case 'Ethash':
        return {
          hash: await this.ethash(header, job)
        };
        
      case 'RandomX':
        return {
          hash: await this.randomx(header)
        };
        
      default:
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
  }
  
  doubleSHA256(data) {
    const hash1 = crypto.createHash('sha256').update(data).digest();
    return crypto.createHash('sha256').update(hash1).digest();
  }
  
  async scrypt(data, config) {
    // Simplified scrypt
    return crypto.scryptSync(data, data, 32, {
      N: config.N,
      r: config.r,
      p: config.p
    });
  }
  
  async x11(data) {
    // X11 uses 11 chained hash functions
    const algorithms = [
      'blake', 'bmw', 'groestl', 'jh', 'keccak',
      'skein', 'luffa', 'cubehash', 'shavite', 'simd', 'echo'
    ];
    
    let hash = data;
    for (const algo of algorithms) {
      // Simplified - would use actual implementations
      hash = crypto.createHash('sha256').update(hash).digest();
    }
    
    return hash;
  }
  
  async ethash(header, job) {
    // Simplified Ethash
    // Would use actual DAG and Ethash algorithm
    return crypto.createHash('sha3-256').update(header).digest();
  }
  
  async randomx(header) {
    // Simplified RandomX
    // Would use actual RandomX implementation
    return crypto.createHash('sha256').update(header).digest();
  }
  
  validateDifficulty(hash, shareDifficulty, networkDifficulty) {
    // Convert hash to big number
    const hashBigInt = new BigNumber('0x' + hash.toString('hex'));
    
    // Calculate target from difficulty
    const maxTarget = new BigNumber('0xFFFF0000000000000000000000000000000000000000000000000000');
    const shareTarget = maxTarget.dividedBy(shareDifficulty);
    const networkTarget = maxTarget.dividedBy(networkDifficulty);
    
    // Check share difficulty
    if (hashBigInt.isGreaterThan(shareTarget)) {
      return { valid: false };
    }
    
    // Check if it's a valid block
    const isBlock = hashBigInt.isLessThanOrEqualTo(networkTarget);
    
    // Calculate actual share difficulty
    const actualDifficulty = maxTarget.dividedBy(hashBigInt).toNumber();
    
    return {
      valid: true,
      shareDifficulty: actualDifficulty,
      isBlock
    };
  }
  
  // Rate limiting and ban management
  
  checkRateLimit(minerId) {
    const stats = this.getMinerStats(minerId);
    const now = Date.now();
    
    // Clean old submissions
    stats.submissions = stats.submissions.filter(time => 
      now - time < 1000 // Last second
    );
    
    // Check rate
    if (stats.submissions.length >= this.config.maxSharesPerSecond) {
      return false;
    }
    
    stats.submissions.push(now);
    return true;
  }
  
  isBanned(minerId) {
    const banInfo = this.bannedMiners.get(minerId);
    if (!banInfo) return false;
    
    if (Date.now() > banInfo.until) {
      this.bannedMiners.delete(minerId);
      return false;
    }
    
    return true;
  }
  
  banMiner(minerId, reason) {
    this.bannedMiners.set(minerId, {
      reason,
      timestamp: Date.now(),
      until: Date.now() + this.config.banDuration
    });
    
    this.emit('minerBanned', { minerId, reason });
  }
  
  // Share tracking
  
  isDuplicateShare(share) {
    const shareKey = this.getShareKey(share);
    return this.submittedShares.has(shareKey);
  }
  
  storeShare(share) {
    const shareKey = this.getShareKey(share);
    this.submittedShares.set(shareKey, {
      timestamp: Date.now(),
      share
    });
  }
  
  getShareKey(share) {
    return `${share.jobId}_${share.extraNonce1}_${share.extraNonce2}_${share.nonce}_${share.nTime}`;
  }
  
  // Statistics
  
  getMinerStats(minerId) {
    if (!this.minerStats.has(minerId)) {
      this.minerStats.set(minerId, {
        validShares: 0,
        invalidShares: 0,
        blocks: 0,
        totalDifficulty: new BigNumber(0),
        submissions: [],
        invalidReasons: {}
      });
    }
    
    return this.minerStats.get(minerId);
  }
  
  recordValidShare(minerId, share, difficulty) {
    const stats = this.getMinerStats(minerId);
    stats.validShares++;
    stats.totalDifficulty = stats.totalDifficulty.plus(difficulty);
    
    this.emit('validShare', {
      minerId,
      difficulty,
      totalShares: stats.validShares
    });
  }
  
  recordInvalidShare(minerId, reason) {
    const stats = this.getMinerStats(minerId);
    stats.invalidShares++;
    stats.invalidReasons[reason] = (stats.invalidReasons[reason] || 0) + 1;
    
    // Check ban threshold
    if (stats.invalidShares >= this.config.banThreshold) {
      this.banMiner(minerId, 'Too many invalid shares');
    }
    
    this.emit('invalidShare', {
      minerId,
      reason,
      totalInvalid: stats.invalidShares
    });
  }
  
  // Job template management
  
  registerJob(job) {
    this.jobTemplates.set(job.id, {
      ...job,
      registered: Date.now()
    });
  }
  
  unregisterJob(jobId) {
    this.jobTemplates.delete(jobId);
  }
  
  // Cleanup
  
  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      
      // Clean old shares
      for (const [key, share] of this.submittedShares) {
        if (now - share.timestamp > this.config.duplicateWindow) {
          this.submittedShares.delete(key);
        }
      }
      
      // Clean old jobs
      for (const [jobId, job] of this.jobTemplates) {
        if (now - job.registered > this.config.shareTimeout) {
          this.jobTemplates.delete(jobId);
        }
      }
      
      // Clean expired bans
      for (const [minerId, banInfo] of this.bannedMiners) {
        if (now > banInfo.until) {
          this.bannedMiners.delete(minerId);
        }
      }
    }, 60000); // Every minute
  }
  
  // Public API
  
  getStats() {
    const stats = {
      totalMiners: this.minerStats.size,
      bannedMiners: this.bannedMiners.size,
      activeJobs: this.jobTemplates.size,
      recentShares: this.submittedShares.size,
      minerStats: {}
    };
    
    // Aggregate miner statistics
    for (const [minerId, minerStat] of this.minerStats) {
      stats.minerStats[minerId] = {
        validShares: minerStat.validShares,
        invalidShares: minerStat.invalidShares,
        blocks: minerStat.blocks,
        hashrate: this.calculateHashrate(minerStat),
        efficiency: minerStat.validShares / 
          (minerStat.validShares + minerStat.invalidShares) || 0
      };
    }
    
    return stats;
  }
  
  calculateHashrate(minerStats) {
    // Estimate hashrate from difficulty submissions
    // This is a simplified calculation
    const timeWindow = 300000; // 5 minutes
    const difficulty = minerStats.totalDifficulty.toNumber();
    const hashrate = (difficulty * Math.pow(2, 32)) / (timeWindow / 1000);
    
    return hashrate;
  }
  
  resetMinerStats(minerId) {
    this.minerStats.delete(minerId);
    this.bannedMiners.delete(minerId);
  }
}

module.exports = ShareValidator;