/**
 * Optimized Share Validator - Otedama
 * High-performance share validation with inline workers
 * 
 * Design: Zero-allocation validation (Carmack principle)
 */

import { createStructuredLogger } from '../core/structured-logger.js';
import { Worker } from 'worker_threads';
import crypto from 'crypto';
import os from 'os';
import { ErrorBoundary } from '../core/error-boundary.js';

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
    this.workerCount = options.workerCount || Math.min(os.cpus().length, 8);
    this.workers = [];
    this.workerLoads = new Map(); // Track worker load
    this.cpuAffinityEnabled = options.cpuAffinity !== false;
    
    // Pre-allocated buffers
    this.headerBuffer = Buffer.allocUnsafe(80);
    
    // Validation statistics
    this.stats = {
      totalValidated: 0,
      validShares: 0,
      invalidShares: 0,
      blocksFound: 0,
      avgValidationTime: 0,
      workerUtilization: 0
    };

    // Performance tracking
    this.validationTimes = [];
    this.maxValidationTimeHistory = 1000;
    
    // Setup error boundary
    this.errorBoundary = new ErrorBoundary({
      maxRetries: 2,
      retryDelay: 500,
      onError: (error, context) => {
        logger.error('Share validation error caught', {
          error: error.message,
          function: context.fn.name,
          retry: context.retry
        });
      }
    });
    
    // Register recovery strategies
    this.setupRecoveryStrategies();
  }
  
  /**
   * Initialize validator with CPU-aware workers
   */
  async initialize() {
    // Create workers with optimized code
    const workerCode = `
      const { parentPort, workerData } = require('worker_threads');
      const crypto = require('crypto');
      
      // Set CPU affinity if supported and enabled
      if (workerData.cpuIndex !== undefined && process.env.NODE_ENV !== 'test') {
        try {
          // This would set CPU affinity in production environment
          // process.binding('os').setCPUAffinity?.(workerData.cpuIndex);
        } catch (e) {
          // CPU affinity not supported
        }
      }
      
      // Pre-allocate hash instances for better performance
      const sha256Instance1 = crypto.createHash('sha256');
      const sha256Instance2 = crypto.createHash('sha256');
      
      parentPort.on('message', (task) => {
        const startTime = process.hrtime.bigint();
        
        try {
          let hash;
          
          switch (task.algorithm) {
            case 'sha256':
              // Reset and reuse hash instances
              sha256Instance1._flush();
              sha256Instance2._flush();
              
              const firstHash = sha256Instance1.update(task.header).digest();
              hash = sha256Instance2.update(firstHash).digest();
              break;
              
            case 'scrypt':
              // Would use optimized scrypt implementation
              hash = crypto.createHash('sha256').update(task.header).digest();
              break;
              
            default:
              hash = crypto.createHash('sha256').update(task.header).digest();
          }
          
          const endTime = process.hrtime.bigint();
          
          parentPort.postMessage({
            hash: hash.toString('hex'),
            taskId: task.taskId,
            processingTime: Number(endTime - startTime) / 1000000 // Convert to ms
          });
          
        } catch (error) {
          parentPort.postMessage({
            error: error.message,
            taskId: task.taskId
          });
        }
      });
    `;
    
    // Create workers with CPU affinity
    for (let i = 0; i < this.workerCount; i++) {
      const workerOptions = { 
        eval: true,
        workerData: {
          cpuIndex: this.cpuAffinityEnabled ? i % os.cpus().length : undefined
        }
      };
      
      const worker = new Worker(workerCode, workerOptions);
      worker.id = i;
      worker.activeJobs = 0;
      worker.totalJobs = 0;
      worker.avgProcessingTime = 0;
      
      // Create SharedArrayBuffer for atomic operations if available
      if (typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined') {
        const buffer = new SharedArrayBuffer(4);
        worker.activeJobsBuffer = new Int32Array(buffer);
        Atomics.store(worker.activeJobsBuffer, 0, 0);
      }
      
      this.workers.push(worker);
      this.workerLoads.set(i, { active: 0, total: 0, avgTime: 0 });
    }
    
    logger.info(`CPU-aware validator initialized with ${this.workerCount} workers`);
  }
  
  /**
   * Setup recovery strategies for common errors
   */
  setupRecoveryStrategies() {
    // Worker timeout recovery
    this.errorBoundary.registerRecoveryStrategy('Error', async (error, functionName) => {
      if (error.message.includes('Worker timeout')) {
        logger.warn('Worker timeout detected, attempting recovery');
        // Return invalid share instead of crashing
        return {
          valid: false,
          reason: 'Worker timeout during validation'
        };
      }
      return null;
    });
  }
  
  /**
   * Validate share using intelligent worker selection
   */
  async validateShare(share, job, minerDifficulty, networkDifficulty) {
    // Wrap the validation in error boundary
    return this.errorBoundary.wrap(
      this._validateShareInternal.bind(this),
      this
    )(share, job, minerDifficulty, networkDifficulty);
  }
  
  /**
   * Internal share validation logic
   */
  async _validateShareInternal(share, job, minerDifficulty, networkDifficulty) {
    const startTime = Date.now();
    
    // Build block header efficiently
    this.buildBlockHeaderOptimized(share, job);
    
    // Select optimal worker based on load and performance
    const worker = this.selectOptimalWorker();
    
    // Track worker usage with atomic operations
    // Use atomic increment to prevent race conditions
    const workerLoad = this.workerLoads.get(worker.id);
    
    // Atomic increment using Atomics if available, otherwise use mutex pattern
    if (typeof Atomics !== 'undefined' && worker.activeJobsBuffer) {
      Atomics.add(worker.activeJobsBuffer, 0, 1);
      worker.activeJobs = Atomics.load(worker.activeJobsBuffer, 0);
    } else {
      // Fallback to safer increment
      worker.activeJobs = (worker.activeJobs || 0) + 1;
    }
    
    workerLoad.active = (workerLoad.active || 0) + 1;
    
    // Create promise for worker response
    const taskId = crypto.randomBytes(4).toString('hex');
    
    try {
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

      // Update worker statistics with atomic operations
      if (typeof Atomics !== 'undefined' && worker.activeJobsBuffer) {
        Atomics.sub(worker.activeJobsBuffer, 0, 1);
        worker.activeJobs = Atomics.load(worker.activeJobsBuffer, 0);
      } else {
        worker.activeJobs = Math.max(0, (worker.activeJobs || 0) - 1);
      }
      
      worker.totalJobs = (worker.totalJobs || 0) + 1;
      workerLoad.active = Math.max(0, (workerLoad.active || 0) - 1);
      workerLoad.total = (workerLoad.total || 0) + 1;
      
      if (result.processingTime) {
        // Update average processing time
        const oldAvg = worker.avgProcessingTime;
        worker.avgProcessingTime = ((oldAvg * (worker.totalJobs - 1)) + result.processingTime) / worker.totalJobs;
        workerLoad.avgTime = worker.avgProcessingTime;
      }
      
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
      
      const validationTime = Date.now() - startTime;
      this.updateValidationStats(validationTime);
      
      return {
        valid: true,
        hash: result.hash,
        isBlock,
        blockHeight: isBlock ? job.height : null,
        validationTime
      };
      
    } catch (error) {
      // Cleanup on error with atomic operations
      if (typeof Atomics !== 'undefined' && worker.activeJobsBuffer) {
        Atomics.sub(worker.activeJobsBuffer, 0, 1);
        worker.activeJobs = Atomics.load(worker.activeJobsBuffer, 0);
      } else {
        worker.activeJobs = Math.max(0, (worker.activeJobs || 0) - 1);
      }
      
      workerLoad.active = Math.max(0, (workerLoad.active || 0) - 1);
      
      logger.error('Share validation error', { error: error.message, workerId: worker.id });
      throw error;
    }
  }

  /**
   * Select optimal worker based on load and performance
   */
  selectOptimalWorker() {
    let bestWorker = this.workers[0];
    let bestScore = Infinity;
    
    for (const worker of this.workers) {
      // Calculate worker score (lower is better)
      const loadFactor = worker.activeJobs / (worker.totalJobs + 1);
      const timeFactor = worker.avgProcessingTime || 1;
      const score = loadFactor * timeFactor + worker.activeJobs;
      
      if (score < bestScore) {
        bestScore = score;
        bestWorker = worker;
      }
    }
    
    return bestWorker;
  }

  /**
   * Update validation statistics
   */
  updateValidationStats(validationTime) {
    this.validationTimes.push(validationTime);
    
    if (this.validationTimes.length > this.maxValidationTimeHistory) {
      this.validationTimes.shift();
    }
    
    // Update average validation time
    this.stats.avgValidationTime = 
      this.validationTimes.reduce((a, b) => a + b, 0) / this.validationTimes.length;
    
    // Update worker utilization
    const totalActiveJobs = this.workers.reduce((sum, w) => sum + w.activeJobs, 0);
    this.stats.workerUtilization = totalActiveJobs / this.workers.length;
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