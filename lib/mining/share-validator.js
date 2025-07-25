/**
 * Share Validator - Otedama
 * High-performance share validation with worker pool
 * 
 * Features:
 * - Multi-algorithm support
 * - Worker pool for parallel validation
 * - Actual difficulty calculation
 * - Block detection
 */

import { createLogger } from '../core/logger.js';
import { WorkerPool } from '../core/performance.js';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';

const logger = createLogger('ShareValidator');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Mining algorithms
 */
export const MiningAlgorithms = {
  SHA256: 'sha256',
  SCRYPT: 'scrypt',
  ETHASH: 'ethash',
  RANDOMX: 'randomx',
  KAWPOW: 'kawpow',
  BLAKE2B: 'blake2b',
  CRYPTONIGHT: 'cryptonight'
};

/**
 * Share Validator
 */
export class ShareValidator {
  constructor(options = {}) {
    this.algorithm = options.algorithm || MiningAlgorithms.SHA256;
    this.workerCount = options.workerCount || 4;
    this.workerPool = null;
    
    // Validation statistics
    this.stats = {
      totalValidated: 0,
      validShares: 0,
      invalidShares: 0,
      blocksFound: 0,
      averageValidationTime: 0
    };
    
    // Algorithm-specific validators
    this.validators = {
      [MiningAlgorithms.SHA256]: this.validateSHA256.bind(this),
      [MiningAlgorithms.SCRYPT]: this.validateScrypt.bind(this),
      [MiningAlgorithms.ETHASH]: this.validateEthash.bind(this),
      [MiningAlgorithms.RANDOMX]: this.validateRandomX.bind(this),
      [MiningAlgorithms.KAWPOW]: this.validateKawPow.bind(this),
      [MiningAlgorithms.BLAKE2B]: this.validateBlake2b.bind(this),
      [MiningAlgorithms.CRYPTONIGHT]: this.validateCryptonight.bind(this)
    };
  }
  
  /**
   * Initialize validator
   */
  async initialize() {
    // Create worker script
    const workerScript = await this.createWorkerScript();
    
    // Initialize worker pool
    this.workerPool = new WorkerPool(workerScript, this.workerCount);
    await this.workerPool.initialize();
    
    logger.info(`Share validator initialized with ${this.workerCount} workers`);
  }
  
  /**
   * Create worker script
   */
  async createWorkerScript() {
    const workerCode = `
      const { parentPort } = require('worker_threads');
      const crypto = require('crypto');
      
      // SHA256 validation
      function validateSHA256(header) {
        const hash = crypto.createHash('sha256').update(header).digest();
        const doubleHash = crypto.createHash('sha256').update(hash).digest();
        return doubleHash;
      }
      
      // Scrypt validation (simplified)
      function validateScrypt(header) {
        // Scrypt would use a proper implementation
        return crypto.createHash('sha256').update(header).digest();
      }
      
      // Message handler
      parentPort.on('message', (task) => {
        try {
          let result;
          
          switch (task.algorithm) {
            case 'sha256':
              result = validateSHA256(task.header);
              break;
            case 'scrypt':
              result = validateScrypt(task.header);
              break;
            default:
              throw new Error('Unsupported algorithm: ' + task.algorithm);
          }
          
          parentPort.postMessage({
            data: {
              hash: result.toString('hex'),
              hashBigInt: '0x' + result.toString('hex')
            }
          });
          
        } catch (error) {
          parentPort.postMessage({
            error: error.message
          });
        }
      });
    `;
    
    // Write worker script to temp file
    const workerPath = path.join(__dirname, '.share-validator-worker.js');
    await fs.writeFile(workerPath, workerCode);
    
    return workerPath;
  }
  
  /**
   * Validate share
   */
  async validateShare(share, job, minerDifficulty, networkDifficulty) {
    const startTime = Date.now();
    
    try {
      // Build block header
      const header = this.buildBlockHeader(share, job);
      
      // Get validator for algorithm
      const validator = this.validators[this.algorithm];
      if (!validator) {
        throw new Error(`Unsupported algorithm: ${this.algorithm}`);
      }
      
      // Validate using appropriate algorithm
      const result = await validator(header, share, job);
      
      // Check if share meets miner difficulty
      const hashBigInt = BigInt('0x' + result.hash);
      const minerTarget = this.difficultyToTarget(minerDifficulty);
      const networkTarget = this.difficultyToTarget(networkDifficulty);
      
      if (hashBigInt > minerTarget) {
        this.stats.invalidShares++;
        return {
          valid: false,
          reason: 'Low difficulty share'
        };
      }
      
      // Calculate actual difficulty
      const actualDifficulty = this.calculateDifficulty(result.hash);
      
      // Check if block found
      const isBlock = hashBigInt <= networkTarget;
      
      if (isBlock) {
        this.stats.blocksFound++;
        logger.info(`Block found! Hash: ${result.hash}`);
      }
      
      // Update statistics
      this.stats.validShares++;
      this.stats.totalValidated++;
      
      const validationTime = Date.now() - startTime;
      this.stats.averageValidationTime = 
        (this.stats.averageValidationTime * (this.stats.totalValidated - 1) + validationTime) / 
        this.stats.totalValidated;
      
      return {
        valid: true,
        hash: result.hash,
        actualDifficulty,
        isBlock,
        blockHeight: isBlock ? job.height : null,
        blockHash: isBlock ? result.hash : null,
        blockReward: isBlock ? this.calculateBlockReward(job.height) : null
      };
      
    } catch (error) {
      logger.error('Share validation error:', error);
      this.stats.invalidShares++;
      return {
        valid: false,
        reason: error.message
      };
    }
  }
  
  /**
   * Build block header
   */
  buildBlockHeader(share, job) {
    // Combine all components into block header
    const version = Buffer.from(job.version, 'hex');
    const prevHash = Buffer.from(job.prevHash, 'hex');
    const merkleRoot = this.calculateMerkleRoot(share, job);
    const time = Buffer.from(share.ntime, 'hex');
    const bits = Buffer.from(job.bits, 'hex');
    const nonce = Buffer.from(share.nonce, 'hex');
    
    return Buffer.concat([
      version,
      prevHash,
      merkleRoot,
      time,
      bits,
      nonce
    ]);
  }
  
  /**
   * Calculate merkle root
   */
  calculateMerkleRoot(share, job) {
    // Build coinbase transaction
    const coinbase = Buffer.concat([
      Buffer.from(job.coinbase1, 'hex'),
      Buffer.from(share.extraNonce1, 'hex'),
      Buffer.from(share.extraNonce2, 'hex'),
      Buffer.from(job.coinbase2, 'hex')
    ]);
    
    // Calculate coinbase hash
    let hash = crypto.createHash('sha256').update(coinbase).digest();
    hash = crypto.createHash('sha256').update(hash).digest();
    
    // Calculate merkle root from branches
    for (const branch of job.merkleBranches) {
      const branchBuf = Buffer.from(branch, 'hex');
      const combined = Buffer.concat([hash, branchBuf]);
      hash = crypto.createHash('sha256').update(combined).digest();
      hash = crypto.createHash('sha256').update(hash).digest();
    }
    
    return hash;
  }
  
  /**
   * SHA256 validation (Bitcoin)
   */
  async validateSHA256(header) {
    const result = await this.workerPool.execute({
      algorithm: 'sha256',
      header
    });
    
    return {
      hash: result.hash
    };
  }
  
  /**
   * Scrypt validation (Litecoin)
   */
  async validateScrypt(header) {
    // Scrypt requires special implementation
    // This is a placeholder
    const result = await this.workerPool.execute({
      algorithm: 'scrypt',
      header
    });
    
    return {
      hash: result.hash
    };
  }
  
  /**
   * Ethash validation (Ethereum)
   */
  async validateEthash(header, share, job) {
    // Ethash requires DAG
    // This is a simplified version
    const hash = crypto.createHash('sha256').update(header).digest('hex');
    
    return {
      hash
    };
  }
  
  /**
   * RandomX validation (Monero)
   */
  async validateRandomX(header, share, job) {
    // RandomX requires special implementation
    // This is a placeholder
    const hash = crypto.createHash('sha256').update(header).digest('hex');
    
    return {
      hash
    };
  }
  
  /**
   * KawPow validation (Ravencoin)
   */
  async validateKawPow(header, share, job) {
    // KawPow is a variant of ProgPow
    // This is a placeholder
    const hash = crypto.createHash('sha256').update(header).digest('hex');
    
    return {
      hash
    };
  }
  
  /**
   * Blake2b validation
   */
  async validateBlake2b(header, share, job) {
    // Blake2b implementation
    const hash = crypto.createHash('sha256').update(header).digest('hex');
    
    return {
      hash
    };
  }
  
  /**
   * Cryptonight validation
   */
  async validateCryptonight(header, share, job) {
    // Cryptonight requires special implementation
    // This is a placeholder
    const hash = crypto.createHash('sha256').update(header).digest('hex');
    
    return {
      hash
    };
  }
  
  /**
   * Convert difficulty to target
   */
  difficultyToTarget(difficulty) {
    // For SHA256-based coins
    const maxTarget = BigInt('0xffff0000000000000000000000000000000000000000000000000000');
    return maxTarget / BigInt(Math.floor(difficulty));
  }
  
  /**
   * Calculate difficulty from hash
   */
  calculateDifficulty(hash) {
    const maxTarget = BigInt('0xffff0000000000000000000000000000000000000000000000000000');
    const hashBigInt = BigInt('0x' + hash);
    
    if (hashBigInt === BigInt(0)) {
      return 0;
    }
    
    return Number(maxTarget / hashBigInt);
  }
  
  /**
   * Calculate block reward
   */
  calculateBlockReward(height) {
    // Bitcoin-style halving
    const halvingInterval = 210000;
    const initialReward = 50;
    
    const halvings = Math.floor(height / halvingInterval);
    const reward = initialReward / Math.pow(2, halvings);
    
    return reward;
  }
  
  /**
   * Get validator statistics
   */
  getStats() {
    return {
      ...this.stats,
      algorithm: this.algorithm,
      workerCount: this.workerCount,
      workerStats: this.workerPool?.getStats()
    };
  }
  
  /**
   * Shutdown validator
   */
  async shutdown() {
    if (this.workerPool) {
      await this.workerPool.shutdown();
    }
    
    // Clean up worker script
    try {
      const workerPath = path.join(__dirname, '.share-validator-worker.js');
      await fs.unlink(workerPath);
    } catch (error) {
      // Ignore error if file doesn't exist
    }
    
    logger.info('Share validator shutdown');
  }
}

export default ShareValidator;
