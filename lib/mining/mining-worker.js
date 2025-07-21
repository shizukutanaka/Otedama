/**
 * Mining Worker Thread
 * Executes mining algorithms in separate threads for optimal performance
 */

import { parentPort, workerData } from 'worker_threads';
import { createHash } from 'crypto';
import { performance } from 'perf_hooks';

class MiningWorker {
  constructor(workerData) {
    this.id = workerData.id;
    this.type = workerData.type;
    this.algorithm = workerData.algorithm;
    this.options = workerData.options;
    
    this.state = {
      mining: false,
      hashrate: 0,
      totalHashes: 0,
      sharesFound: 0,
      intensity: this.options.intensity || 1.0
    };
    
    this.currentWork = null;
    this.startTime = 0;
    this.lastHashrateUpdate = 0;
    
    this.initialize();
  }
  
  initialize() {
    // Listen for messages from main thread
    parentPort.on('message', (message) => {
      this.handleMessage(message);
    });
    
    // Send initial status
    this.sendMessage('status', {
      id: this.id,
      type: this.type,
      algorithm: this.algorithm,
      status: 'ready'
    });
  }
  
  handleMessage(message) {
    switch (message.type) {
      case 'work':
        this.startWork(message.data);
        break;
        
      case 'stop':
        this.stopWork();
        break;
        
      case 'intensity':
        this.updateIntensity(message.data);
        break;
        
      case 'difficulty':
        this.updateDifficulty(message.data);
        break;
    }
  }
  
  startWork(work) {
    this.currentWork = work;
    this.state.mining = true;
    this.startTime = performance.now();
    this.lastHashrateUpdate = this.startTime;
    
    // Start mining based on algorithm
    switch (this.algorithm) {
      case 'sha256':
        this.mineSHA256();
        break;
        
      case 'scrypt':
        this.mineScrypt();
        break;
        
      case 'ethash':
        this.mineEthash();
        break;
        
      case 'blake2b':
        this.mineBlake2b();
        break;
        
      default:
        this.sendMessage('error', `Unsupported algorithm: ${this.algorithm}`);
    }
  }
  
  stopWork() {
    this.state.mining = false;
    this.currentWork = null;
    
    this.sendMessage('status', {
      id: this.id,
      status: 'stopped',
      totalHashes: this.state.totalHashes,
      sharesFound: this.state.sharesFound
    });
  }
  
  updateIntensity(intensity) {
    this.state.intensity = intensity;
    this.sendMessage('status', {
      id: this.id,
      intensity: this.state.intensity
    });
  }
  
  updateDifficulty(difficulty) {
    if (this.currentWork) {
      this.currentWork.difficulty = difficulty;
    }
  }
  
  /**
   * SHA-256 Mining Implementation
   */
  mineSHA256() {
    const work = this.currentWork;
    let nonce = work.nonceStart || 0;
    const maxNonce = work.nonceEnd || 0xFFFFFFFF;
    const target = Buffer.from(work.target, 'hex');
    
    const mineLoop = () => {
      const startTime = performance.now();
      let hashes = 0;
      const batchSize = Math.floor(10000 * this.state.intensity);
      
      while (this.state.mining && nonce <= maxNonce && hashes < batchSize) {
        // Build block header
        const header = this.buildSHA256Header(work, nonce);
        
        // Double SHA-256 hash
        const hash1 = createHash('sha256').update(header).digest();
        const hash2 = createHash('sha256').update(hash1).digest();
        
        // Check if hash meets target
        if (hash2.compare(target) <= 0) {
          this.foundShare(work, nonce, hash2);
        }
        
        nonce++;
        hashes++;
        this.state.totalHashes++;
      }
      
      // Update hashrate
      const elapsed = performance.now() - startTime;
      if (elapsed > 0) {
        this.state.hashrate = (hashes / elapsed) * 1000; // H/s
        this.updateHashrate();
      }
      
      // Continue mining if not stopped and nonce not exhausted
      if (this.state.mining && nonce <= maxNonce) {
        // Use setImmediate to prevent blocking
        setImmediate(mineLoop);
      } else if (nonce > maxNonce) {
        // Request new work
        this.sendMessage('work_exhausted', { id: this.id });
      }
    };
    
    mineLoop();
  }
  
  /**
   * Scrypt Mining Implementation (CPU optimized)
   */
  mineScrypt() {
    const work = this.currentWork;
    let nonce = work.nonceStart || 0;
    const maxNonce = work.nonceEnd || 0xFFFFFFFF;
    
    const mineLoop = () => {
      const startTime = performance.now();
      let hashes = 0;
      const batchSize = Math.floor(1000 * this.state.intensity); // Scrypt is more expensive
      
      while (this.state.mining && nonce <= maxNonce && hashes < batchSize) {
        // Scrypt hashing (simplified implementation)
        const header = this.buildScryptHeader(work, nonce);
        const hash = this.scryptHash(header);
        
        if (this.checkTarget(hash, work.target)) {
          this.foundShare(work, nonce, hash);
        }
        
        nonce++;
        hashes++;
        this.state.totalHashes++;
      }
      
      // Update hashrate
      const elapsed = performance.now() - startTime;
      if (elapsed > 0) {
        this.state.hashrate = (hashes / elapsed) * 1000;
        this.updateHashrate();
      }
      
      if (this.state.mining && nonce <= maxNonce) {
        setImmediate(mineLoop);
      } else if (nonce > maxNonce) {
        this.sendMessage('work_exhausted', { id: this.id });
      }
    };
    
    mineLoop();
  }
  
  /**
   * Ethash Mining Implementation (GPU optimized)
   */
  mineEthash() {
    const work = this.currentWork;
    let nonce = work.nonceStart || 0;
    const maxNonce = work.nonceEnd || 0xFFFFFFFF;
    
    const mineLoop = () => {
      const startTime = performance.now();
      let hashes = 0;
      const batchSize = Math.floor(5000 * this.state.intensity);
      
      while (this.state.mining && nonce <= maxNonce && hashes < batchSize) {
        // Ethash hashing (simplified implementation)
        const header = this.buildEthashHeader(work, nonce);
        const hash = this.ethashHash(header);
        
        if (this.checkTarget(hash, work.target)) {
          this.foundShare(work, nonce, hash);
        }
        
        nonce++;
        hashes++;
        this.state.totalHashes++;
      }
      
      // Update hashrate
      const elapsed = performance.now() - startTime;
      if (elapsed > 0) {
        this.state.hashrate = (hashes / elapsed) * 1000;
        this.updateHashrate();
      }
      
      if (this.state.mining && nonce <= maxNonce) {
        setImmediate(mineLoop);
      } else if (nonce > maxNonce) {
        this.sendMessage('work_exhausted', { id: this.id });
      }
    };
    
    mineLoop();
  }
  
  /**
   * Blake2b Mining Implementation
   */
  mineBlake2b() {
    const work = this.currentWork;
    let nonce = work.nonceStart || 0;
    const maxNonce = work.nonceEnd || 0xFFFFFFFF;
    
    const mineLoop = () => {
      const startTime = performance.now();
      let hashes = 0;
      const batchSize = Math.floor(15000 * this.state.intensity);
      
      while (this.state.mining && nonce <= maxNonce && hashes < batchSize) {
        // Blake2b hashing
        const header = this.buildBlake2bHeader(work, nonce);
        const hash = this.blake2bHash(header);
        
        if (this.checkTarget(hash, work.target)) {
          this.foundShare(work, nonce, hash);
        }
        
        nonce++;
        hashes++;
        this.state.totalHashes++;
      }
      
      // Update hashrate
      const elapsed = performance.now() - startTime;
      if (elapsed > 0) {
        this.state.hashrate = (hashes / elapsed) * 1000;
        this.updateHashrate();
      }
      
      if (this.state.mining && nonce <= maxNonce) {
        setImmediate(mineLoop);
      } else if (nonce > maxNonce) {
        this.sendMessage('work_exhausted', { id: this.id });
      }
    };
    
    mineLoop();
  }
  
  /**
   * Build SHA-256 header
   */
  buildSHA256Header(work, nonce) {
    const header = Buffer.alloc(80);
    let offset = 0;
    
    // Version (4 bytes)
    header.writeUInt32LE(work.version || 1, offset);
    offset += 4;
    
    // Previous hash (32 bytes)
    Buffer.from(work.previousHash, 'hex').copy(header, offset);
    offset += 32;
    
    // Merkle root (32 bytes)
    Buffer.from(work.merkleRoot, 'hex').copy(header, offset);
    offset += 32;
    
    // Timestamp (4 bytes)
    header.writeUInt32LE(work.timestamp, offset);
    offset += 4;
    
    // Difficulty (4 bytes)
    header.writeUInt32LE(work.difficulty, offset);
    offset += 4;
    
    // Nonce (4 bytes)
    header.writeUInt32LE(nonce, offset);
    
    return header;
  }
  
  /**
   * Build Scrypt header
   */
  buildScryptHeader(work, nonce) {
    // Similar to SHA-256 but with different format
    return this.buildSHA256Header(work, nonce);
  }
  
  /**
   * Build Ethash header
   */
  buildEthashHeader(work, nonce) {
    const header = Buffer.alloc(64);
    let offset = 0;
    
    // Parent hash (32 bytes)
    Buffer.from(work.parentHash, 'hex').copy(header, offset);
    offset += 32;
    
    // Timestamp (8 bytes)
    header.writeBigUInt64LE(BigInt(work.timestamp), offset);
    offset += 8;
    
    // Difficulty (8 bytes)
    header.writeBigUInt64LE(BigInt(work.difficulty), offset);
    offset += 8;
    
    // Nonce (8 bytes)
    header.writeBigUInt64LE(BigInt(nonce), offset);
    offset += 8;
    
    // Mix hash (32 bytes)
    Buffer.from(work.mixHash || '0'.repeat(64), 'hex').copy(header, offset);
    
    return header;
  }
  
  /**
   * Build Blake2b header
   */
  buildBlake2bHeader(work, nonce) {
    return this.buildSHA256Header(work, nonce);
  }
  
  /**
   * Simplified Scrypt hash
   */
  scryptHash(data) {
    // This is a simplified version - real scrypt implementation would be more complex
    return createHash('sha256').update(data).digest();
  }
  
  /**
   * Simplified Ethash hash
   */
  ethashHash(data) {
    // This is a simplified version - real ethash implementation would be more complex
    return createHash('sha256').update(data).digest();
  }
  
  /**
   * Blake2b hash
   */
  blake2bHash(data) {
    // Node.js doesn't have native Blake2b, so we'll use SHA-256 as placeholder
    return createHash('sha256').update(data).digest();
  }
  
  /**
   * Check if hash meets target
   */
  checkTarget(hash, target) {
    const targetBuffer = Buffer.from(target, 'hex');
    return hash.compare(targetBuffer) <= 0;
  }
  
  /**
   * Found a valid share
   */
  foundShare(work, nonce, hash) {
    this.state.sharesFound++;
    
    const share = {
      algorithm: this.algorithm,
      workId: work.id,
      nonce: nonce,
      hash: hash.toString('hex'),
      timestamp: Date.now(),
      difficulty: work.difficulty,
      target: work.target,
      workerId: this.id
    };
    
    this.sendMessage('share', share);
  }
  
  /**
   * Update hashrate
   */
  updateHashrate() {
    const now = performance.now();
    if (now - this.lastHashrateUpdate >= 10000) { // Update every 10 seconds
      this.sendMessage('hashrate', {
        id: this.id,
        hashrate: this.state.hashrate,
        totalHashes: this.state.totalHashes
      });
      this.lastHashrateUpdate = now;
    }
  }
  
  /**
   * Send message to parent thread
   */
  sendMessage(type, data) {
    parentPort.postMessage({
      type: type,
      data: data,
      timestamp: Date.now()
    });
  }
}

// Initialize worker
const worker = new MiningWorker(workerData);

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  worker.sendMessage('error', {
    message: error.message,
    stack: error.stack
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  worker.sendMessage('error', {
    message: 'Unhandled promise rejection',
    reason: reason,
    promise: promise
  });
});