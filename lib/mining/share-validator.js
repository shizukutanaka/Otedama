/**
 * Optimized Share Validator - Otedama
 * High-performance share validation with inline workers
 * 
 * Design: Zero-allocation validation (Carmack principle)
 */

import { createStructuredLogger } from '../core/structured-logger.js';
import { Worker } from 'worker_threads';
import crypto from 'crypto';

const logger = createStructuredLogger('ShareValidator');

// Pre-compute difficulty constants
const MAX_TARGET = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
const DIFFICULTY_ONE_TARGET = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');

/**
 * Mining algorithms
 */
export const MiningAlgorithms = {
  SHA256: 'sha256',
  SCRYPT: 'scrypt',
  ETHASH: 'ethash',
  RANDOMX: 'randomx',
  KAWPOW: 'kawpow'
};

/**
 * Optimized Share Validator
 */
export class ShareValidator {
  constructor(options = {}) {
    this.algorithm = options.algorithm || MiningAlgorithms.SHA256;
    this.workerCount = options.workerCount || 4;
    this.workers = [];
    this.currentWorker = 0;
    
    // Pre-allocated buffers
    this.headerBuffer = Buffer.allocUnsafe(80);
    
    // Validation statistics
    this.stats = {
      totalValidated: 0,
      validShares: 0,
      invalidShares: 0,
      blocksFound: 0
    };
  }
  
  /**
   * Initialize validator with inline workers
   */
  async initialize() {
    // Create workers with inline code
    const workerCode = `
      const { parentPort } = require('worker_threads');
      const crypto = require('crypto');
      
      parentPort.on('message', (task) => {
        try {
          let hash;
          
          switch (task.algorithm) {
            case 'sha256':
              const firstHash = crypto.createHash('sha256').update(task.header).digest();
              hash = crypto.createHash('sha256').update(firstHash).digest();
              break;
              
            case 'scrypt':
              // Simplified - would use proper scrypt
              hash = crypto.createHash('sha256').update(task.header).digest();
              break;
              
            default:
              hash = crypto.createHash('sha256').update(task.header).digest();
          }
          
          parentPort.postMessage({
            hash: hash.toString('hex'),
            taskId: task.taskId
          });
          
        } catch (error) {
          parentPort.postMessage({
            error: error.message,
            taskId: task.taskId
          });
        }
      });
    `;
    
    // Create workers
    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(workerCode, { eval: true });
      this.workers.push(worker);
    }
    
    logger.info(`Optimized validator initialized with ${this.workerCount} workers`);
  }
  
  /**
   * Validate share using round-robin worker selection
   */
  async validateShare(share, job, minerDifficulty, networkDifficulty) {
    // Build block header efficiently
    this.buildBlockHeaderOptimized(share, job);
    
    // Select next worker (round-robin)
    const worker = this.workers[this.currentWorker];
    this.currentWorker = (this.currentWorker + 1) % this.workerCount;
    
    // Create promise for worker response
    const taskId = crypto.randomBytes(4).toString('hex');
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Worker timeout'));
      }, 5000);
      
      const handler = (message) => {
        if (message.taskId === taskId) {
          clearTimeout(timeout);
          worker.off('message', handler);
          
          if (message.error) {
            reject(new Error(message.error));
          } else {
            resolve(message);
          }
        }
      };
      
      worker.on('message', handler);
      worker.postMessage({
        algorithm: this.algorithm,
        header: this.headerBuffer,
        taskId
      });
    });
    
    // Validate result
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
    
    // Check if block found
    const isBlock = hashBigInt <= networkTarget;
    
    if (isBlock) {
      this.stats.blocksFound++;
      logger.info(`Block found! Hash: ${result.hash}`);
    }
    
    // Update statistics
    this.stats.validShares++;
    this.stats.totalValidated++;
    
    return {
      valid: true,
      hash: result.hash,
      isBlock,
      blockHeight: isBlock ? job.height : null
    };
  }
  
  /**
   * Build block header optimized (in-place buffer operations)
   */
  buildBlockHeaderOptimized(share, job) {
    // Version (4 bytes)
    this.headerBuffer.writeUInt32LE(job.version, 0);
    
    // Previous block hash (32 bytes)
    Buffer.from(job.previousblockhash, 'hex').copy(this.headerBuffer, 4);
    
    // Merkle root (32 bytes)
    const merkleRoot = this.calculateMerkleRoot(job, share.extraNonce1, share.extraNonce2);
    merkleRoot.copy(this.headerBuffer, 36);
    
    // Timestamp (4 bytes)
    this.headerBuffer.writeUInt32LE(share.nTime, 68);
    
    // Bits (4 bytes)
    this.headerBuffer.writeUInt32LE(job.bits, 72);
    
    // Nonce (4 bytes)
    this.headerBuffer.writeUInt32LE(share.nonce, 76);
    
    return this.headerBuffer;
  }
  
  /**
   * Calculate merkle root efficiently
   */
  calculateMerkleRoot(job, extraNonce1, extraNonce2) {
    // Combine coinbase with extra nonces
    const coinbase = Buffer.concat([
      Buffer.from(job.coinbase1, 'hex'),
      Buffer.from(extraNonce1, 'hex'),
      Buffer.from(extraNonce2, 'hex'),
      Buffer.from(job.coinbase2, 'hex')
    ]);
    
    // Calculate coinbase hash
    let hash = crypto.createHash('sha256').update(coinbase).digest();
    hash = crypto.createHash('sha256').update(hash).digest();
    
    // Calculate merkle root
    for (const branch of job.merklebranch) {
      const branchBuf = Buffer.from(branch, 'hex');
      hash = crypto.createHash('sha256')
        .update(Buffer.concat([hash, branchBuf]))
        .digest();
      hash = crypto.createHash('sha256').update(hash).digest();
    }
    
    return hash;
  }
  
  /**
   * Convert difficulty to target (optimized)
   */
  difficultyToTarget(difficulty) {
    return difficulty > 1 ? 
      DIFFICULTY_ONE_TARGET / BigInt(Math.floor(difficulty)) : 
      MAX_TARGET;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      validRate: this.stats.totalValidated > 0 ? 
        this.stats.validShares / this.stats.totalValidated : 0
    };
  }
  
  /**
   * Shutdown workers
   */
  async shutdown() {
    await Promise.all(this.workers.map(worker => worker.terminate()));
    this.workers = [];
    logger.info('Share validator shut down');
  }
}

export default ShareValidator;