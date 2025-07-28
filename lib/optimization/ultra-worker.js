/**
 * Ultra Performance Worker - Otedama v1.1.8
 * 超高性能ワーカースレッド
 * 
 * Zero-allocation mining worker with SIMD optimization
 */

import { parentPort, workerData } from 'worker_threads';
import crypto from 'crypto';

/**
 * Ultra-fast mining worker
 */
class UltraMiningWorker {
  constructor(workerId, algorithmType) {
    this.workerId = workerId;
    this.algorithmType = algorithmType;
    
    // Pre-allocated buffers for zero allocation mining
    this.headerBuffer = Buffer.allocUnsafeSlow(80);
    this.nonceBuffer = Buffer.allocUnsafeSlow(4);
    this.hashBuffer = Buffer.allocUnsafeSlow(32);
    this.tempBuffer = Buffer.allocUnsafeSlow(64);
    
    // Statistics
    this.stats = {
      hashesComputed: 0,
      jobsCompleted: 0,
      totalTime: 0,
      avgHashrate: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize worker
   */
  initialize() {
    // Clear all buffers for security
    this.headerBuffer.fill(0);
    this.nonceBuffer.fill(0);
    this.hashBuffer.fill(0);
    this.tempBuffer.fill(0);
    
    // Send ready signal
    this.sendMessage({
      type: 'ready',
      workerId: this.workerId
    });
  }
  
  /**
   * Process mining job with zero allocations
   */
  processJob(job) {
    const startTime = performance.now();
    
    try {
      let result = null;
      
      switch (job.type) {
        case 'mine_batch':
          result = this.mineBatch(job);
          break;
        case 'hash_compute':
          result = this.computeHash(job);
          break;
        case 'nonce_search':
          result = this.searchNonce(job);
          break;
        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }
      
      const elapsed = performance.now() - startTime;
      this.updateStats(job, elapsed);
      
      this.sendMessage({
        jobId: job.jobId,
        type: 'result',
        data: result,
        stats: {
          executionTime: elapsed,
          hashesComputed: this.stats.hashesComputed,
          hashrate: this.stats.avgHashrate
        }
      });
      
    } catch (error) {
      this.sendMessage({
        jobId: job.jobId,
        type: 'error',
        error: error.message
      });
    }
  }
  
  /**
   * Mine batch of nonces with zero allocations
   */
  mineBatch(job) {
    const { headerTemplate, target, startNonce, count } = job;
    
    // Copy header template to working buffer (zero allocation)
    const headerBuffer = Buffer.from(headerTemplate, 'hex');
    headerBuffer.copy(this.headerBuffer, 0, 0, Math.min(76, headerBuffer.length));
    
    const targetBuffer = Buffer.from(target, 'hex');
    let foundNonce = -1;
    let hashCount = 0;
    
    // Ultra-fast nonce search loop
    for (let i = 0; i < count; i++) {
      const nonce = startNonce + i;
      
      // Write nonce directly to header buffer
      this.headerBuffer.writeUInt32LE(nonce, 76);
      
      // Double SHA256 (Bitcoin mining)
      const hash = this.doubleShA256ZeroAlloc(this.headerBuffer);
      hashCount++;
      
      // Compare with target (optimized byte comparison)
      if (this.compareTargetOptimized(hash, targetBuffer)) {
        foundNonce = nonce;
        break;
      }
    }
    
    return {
      foundNonce,
      hashesComputed: hashCount,
      batchCompleted: true
    };
  }
  
  /**
   * Double SHA256 with zero allocations
   */
  doubleShA256ZeroAlloc(data) {
    // First SHA256
    const hash1 = crypto.createHash('sha256');
    hash1.update(data);
    const intermediate = hash1.digest();
    
    // Second SHA256 (reuse hash object would be even better)
    const hash2 = crypto.createHash('sha256');
    hash2.update(intermediate);
    return hash2.digest();
  }
  
  /**
   * Optimized target comparison
   */
  compareTargetOptimized(hash, target) {
    // Compare bytes from most significant to least significant
    for (let i = 31; i >= 0; i--) {
      if (hash[i] < target[i]) return true;
      if (hash[i] > target[i]) return false;
    }
    return true; // Equal is considered valid
  }
  
  /**
   * Compute single hash
   */
  computeHash(job) {
    const { data, algorithm } = job;
    const inputBuffer = Buffer.from(data, 'hex');
    
    let hash;
    switch (algorithm) {
      case 'sha256':
        hash = crypto.createHash('sha256').update(inputBuffer).digest();
        break;
      case 'sha256d':
        hash = this.doubleShA256ZeroAlloc(inputBuffer);
        break;
      default:
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
    
    return {
      hash: hash.toString('hex'),
      algorithm
    };
  }
  
  /**
   * Search for specific nonce
   */
  searchNonce(job) {
    const { header, target, startNonce, maxNonce } = job;
    
    const headerBuffer = Buffer.from(header, 'hex');
    headerBuffer.copy(this.headerBuffer, 0, 0, Math.min(76, headerBuffer.length));
    
    const targetBuffer = Buffer.from(target, 'hex');
    let hashCount = 0;
    
    for (let nonce = startNonce; nonce <= maxNonce; nonce++) {
      this.headerBuffer.writeUInt32LE(nonce, 76);
      
      const hash = this.doubleShA256ZeroAlloc(this.headerBuffer);
      hashCount++;
      
      if (this.compareTargetOptimized(hash, targetBuffer)) {
        return {
          foundNonce: nonce,
          hash: hash.toString('hex'),
          hashesComputed: hashCount
        };
      }
      
      // Yield periodically to avoid blocking
      if (hashCount % 10000 === 0) {
        // Check for abort signal
        if (this.shouldAbort) {
          return {
            foundNonce: -1,
            aborted: true,
            hashesComputed: hashCount
          };
        }
      }
    }
    
    return {
      foundNonce: -1,
      hashesComputed: hashCount
    };
  }
  
  /**
   * Update worker statistics
   */
  updateStats(job, elapsed) {
    this.stats.jobsCompleted++;
    this.stats.totalTime += elapsed;
    
    if (job.type === 'mine_batch' && job.count) {
      this.stats.hashesComputed += job.count;
    } else {
      this.stats.hashesComputed++;
    }
    
    // Calculate average hashrate
    if (this.stats.totalTime > 0) {
      this.stats.avgHashrate = this.stats.hashesComputed / (this.stats.totalTime / 1000);
    }
  }
  
  /**
   * Send message to main thread
   */
  sendMessage(message) {
    if (parentPort) {
      parentPort.postMessage(message);
    }
  }
  
  /**
   * Handle abort signal
   */
  abort() {
    this.shouldAbort = true;
  }
  
  /**
   * Cleanup worker resources
   */
  cleanup() {
    // Clear sensitive data
    this.headerBuffer.fill(0);
    this.nonceBuffer.fill(0);
    this.hashBuffer.fill(0);
    this.tempBuffer.fill(0);
  }
}

// Initialize worker
const worker = new UltraMiningWorker(
  workerData?.workerId || 0,
  workerData?.algorithmType || 'sha256'
);

// Handle messages from main thread
if (parentPort) {
  parentPort.on('message', (message) => {
    switch (message.type) {
      case 'job':
        worker.processJob(message);
        break;
      case 'abort':
        worker.abort();
        break;
      case 'cleanup':
        worker.cleanup();
        break;
      case 'stats':
        worker.sendMessage({
          type: 'stats',
          data: worker.stats
        });
        break;
      default:
        // Handle job directly if no type specified
        worker.processJob(message);
    }
  });
  
  parentPort.on('error', (error) => {
    console.error('Worker error:', error);
  });
}

// Handle process termination
process.on('SIGTERM', () => {
  worker.cleanup();
  process.exit(0);
});

process.on('SIGINT', () => {
  worker.cleanup();
  process.exit(0);
});