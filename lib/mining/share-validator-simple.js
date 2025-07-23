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

class ShareValidator {
  constructor(options = {}) {
    this.options = {
      algorithm: options.algorithm || 'sha256',
      rejectDuplicates: options.rejectDuplicates !== false,
      shareTimeout: options.shareTimeout || 60000, // 1 minute
      ...options
    };
    
    // Track submitted shares to detect duplicates
    this.submittedShares = new Map();
    
    // Clean up old shares periodically
    setInterval(() => {
      this.cleanupOldShares();
    }, 60000);
  }
  
  /**
   * Validate a share
   */
  async validate(share, job) {
    try {
      // Check if share is for current job
      if (share.jobId !== job.id) {
        return { valid: false, reason: 'Job not found' };
      }
      
      // Check for duplicate shares
      if (this.options.rejectDuplicates && this.isDuplicate(share)) {
        return { valid: false, reason: 'Duplicate share' };
      }
      
      // Check time validity
      if (!this.isTimeValid(share.ntime, job.time)) {
        return { valid: false, reason: 'Invalid time' };
      }
      
      // Check extraNonce2 size
      if (share.extraNonce2.length !== job.extraNonce2Size * 2) {
        return { valid: false, reason: 'Invalid extraNonce2 size' };
      }
      
      // Build coinbase
      const coinbase = this.buildCoinbase(share, job);
      
      // Calculate merkle root
      const merkleRoot = this.calculateMerkleRoot(coinbase, job.merkleTree);
      
      // Build block header
      const header = this.buildBlockHeader(share, job, merkleRoot);
      
      // Calculate hash
      const hash = await this.calculateHash(header);
      
      // Check if hash meets difficulty
      const hashBigInt = BigInt('0x' + hash);
      const targetBigInt = this.difficultyToTarget(share.difficulty);
      
      const isValid = hashBigInt <= targetBigInt;
      
      // Check if it's a block
      let isBlock = false;
      if (isValid && job.target) {
        const blockTargetBigInt = BigInt('0x' + job.target);
        isBlock = hashBigInt <= blockTargetBigInt;
      }
      
      // Record share
      if (isValid && this.options.rejectDuplicates) {
        this.recordShare(share);
      }
      
      return {
        valid: isValid,
        isBlock,
        hash,
        difficulty: share.difficulty
      };
      
    } catch (error) {
      logger.error('Share validation error:', error);
      return { valid: false, reason: 'Validation error' };
    }
  }
  
  /**
   * Build coinbase transaction
   */
  buildCoinbase(share, job) {
    const extraNonce = share.extraNonce1 + share.extraNonce2;
    return job.coinbase1 + extraNonce + job.coinbase2;
  }
  
  /**
   * Calculate merkle root
   */
  calculateMerkleRoot(coinbase, merkleTree) {
    let hash = this.sha256d(Buffer.from(coinbase, 'hex'));
    
    for (const branch of merkleTree) {
      const combined = Buffer.concat([
        hash,
        Buffer.from(branch, 'hex')
      ]);
      hash = this.sha256d(combined);
    }
    
    return hash.reverse().toString('hex');
  }
  
  /**
   * Build block header
   */
  buildBlockHeader(share, job, merkleRoot) {
    const header = Buffer.allocUnsafe(80);
    
    // Version (4 bytes)
    header.writeUInt32LE(parseInt(job.version, 16), 0);
    
    // Previous block hash (32 bytes)
    Buffer.from(job.prevHash, 'hex').reverse().copy(header, 4);
    
    // Merkle root (32 bytes)
    Buffer.from(merkleRoot, 'hex').copy(header, 36);
    
    // Time (4 bytes)
    header.writeUInt32LE(parseInt(share.ntime, 16), 68);
    
    // Bits (4 bytes)
    header.writeUInt32LE(parseInt(job.bits, 16), 72);
    
    // Nonce (4 bytes)
    header.writeUInt32LE(parseInt(share.nonce, 16), 76);
    
    return header;
  }
  
  /**
   * Calculate hash based on algorithm
   */
  async calculateHash(header) {
    switch (this.options.algorithm) {
      case 'sha256':
        return this.sha256d(header).reverse().toString('hex');
        
      case 'scrypt':
        // Simplified - in production use native scrypt
        return this.sha256d(header).reverse().toString('hex');
        
      case 'ethash':
        // Simplified - in production use ethash library
        return this.sha256d(header).reverse().toString('hex');
        
      case 'randomx':
        // Simplified - in production use RandomX library
        return this.sha256d(header).reverse().toString('hex');
        
      case 'kawpow':
        // Simplified - in production use KawPow library
        return this.sha256d(header).reverse().toString('hex');
        
      default:
        throw new Error(`Unsupported algorithm: ${this.options.algorithm}`);
    }
  }
  
  /**
   * Double SHA256
   */
  sha256d(data) {
    return crypto.createHash('sha256')
      .update(crypto.createHash('sha256').update(data).digest())
      .digest();
  }
  
  /**
   * Convert difficulty to target
   */
  difficultyToTarget(difficulty) {
    const diff1Target = BigInt('0x' + DIFF1_TARGETS[this.options.algorithm]);
    return diff1Target / BigInt(Math.floor(difficulty));
  }
  
  /**
   * Check if share is duplicate
   */
  isDuplicate(share) {
    const key = `${share.extraNonce1}:${share.extraNonce2}:${share.ntime}:${share.nonce}`;
    return this.submittedShares.has(key);
  }
  
  /**
   * Record share
   */
  recordShare(share) {
    const key = `${share.extraNonce1}:${share.extraNonce2}:${share.ntime}:${share.nonce}`;
    this.submittedShares.set(key, Date.now());
  }
  
  /**
   * Check if time is valid
   */
  isTimeValid(shareTime, jobTime) {
    const shareTimeNum = parseInt(shareTime, 16);
    const jobTimeNum = parseInt(jobTime, 16);
    const now = Math.floor(Date.now() / 1000);
    
    // Allow some variance (±7200 seconds)
    return shareTimeNum >= jobTimeNum &&
           shareTimeNum <= now + 7200;
  }
  
  /**
   * Clean up old shares
   */
  cleanupOldShares() {
    const cutoff = Date.now() - this.options.shareTimeout;
    
    for (const [key, timestamp] of this.submittedShares) {
      if (timestamp < cutoff) {
        this.submittedShares.delete(key);
      }
    }
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      algorithm: this.options.algorithm,
      duplicatesTracked: this.submittedShares.size
    };
  }
}

module.exports = ShareValidator;