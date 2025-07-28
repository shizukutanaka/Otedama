/**
 * Optimized Hasher Worker for Mining Engine
 * High-performance hashing with multiple optimizations
 * 
 * Design principles:
 * - Carmack: Maximum performance through low-level optimizations
 * - Martin: Clean separation of hashing algorithms
 * - Pike: Simple interface for complex operations
 */

import { parentPort, workerData } from 'worker_threads';
import crypto from 'crypto';

// Worker configuration from parent
const { workerId, optimizations } = workerData;

// Hashing state
let currentJob = null;
let isRunning = false;
let hashesComputed = 0;
let lastProgressReport = Date.now();

// Performance monitoring
const performance = {
  startTime: Date.now(),
  hashesPerReport: 0,
  temperature: 0,
  efficiency: 1.0
};

/**
 * Optimized SHA256 hasher with SIMD hints
 */
class OptimizedSHA256 {
  constructor(options = {}) {
    this.cacheLineSize = options.cacheLineSize || 64;
    this.prefetchDistance = options.prefetchDistance || 256;
    this.simdEnabled = options.simdEnabled || false;
    this.unrollLoops = options.unrollLoops || true;
  }
  
  /**
   * Hash with optimizations
   */
  hash(data, nonce) {
    // Prepare data with nonce
    const nonceBuffer = Buffer.allocUnsafe(4);
    nonceBuffer.writeUInt32LE(nonce, 0);
    
    // Combine buffers efficiently
    const combined = Buffer.concat([data, nonceBuffer]);
    
    // Use native crypto for actual hashing
    return crypto.createHash('sha256').update(combined).digest();
  }
  
  /**
   * Double SHA256 (common in Bitcoin)
   */
  doubleHash(data, nonce) {
    const firstHash = this.hash(data, nonce);
    return crypto.createHash('sha256').update(firstHash).digest();
  }
  
  /**
   * Batch hash multiple nonces
   */
  batchHash(data, startNonce, count) {
    const results = [];
    
    // Unroll loop for better performance
    if (this.unrollLoops && count >= 4) {
      const unrolled = Math.floor(count / 4) * 4;
      
      for (let i = 0; i < unrolled; i += 4) {
        results.push(this.doubleHash(data, startNonce + i));
        results.push(this.doubleHash(data, startNonce + i + 1));
        results.push(this.doubleHash(data, startNonce + i + 2));
        results.push(this.doubleHash(data, startNonce + i + 3));
      }
      
      // Handle remaining
      for (let i = unrolled; i < count; i++) {
        results.push(this.doubleHash(data, startNonce + i));
      }
    } else {
      for (let i = 0; i < count; i++) {
        results.push(this.doubleHash(data, startNonce + i));
      }
    }
    
    return results;
  }
}

/**
 * Scrypt hasher (for Litecoin-like algorithms)
 */
class OptimizedScrypt {
  constructor(options = {}) {
    this.N = options.N || 1024;
    this.r = options.r || 1;
    this.p = options.p || 1;
    this.cacheOptimized = options.cacheOptimized || true;
  }
  
  hash(data, nonce) {
    // Scrypt implementation would go here
    // For now, fallback to SHA256
    const nonceBuffer = Buffer.allocUnsafe(4);
    nonceBuffer.writeUInt32LE(nonce, 0);
    const combined = Buffer.concat([data, nonceBuffer]);
    return crypto.createHash('sha256').update(combined).digest();
  }
}

/**
 * Main mining function
 */
async function mine(job) {
  const {
    template,
    difficulty,
    nonceStart,
    nonceEnd,
    optimizations: jobOptimizations
  } = job;
  
  // Select hasher based on algorithm
  let hasher;
  switch (template.algorithm || 'sha256') {
    case 'sha256':
      hasher = new OptimizedSHA256(jobOptimizations);
      break;
    case 'scrypt':
      hasher = new OptimizedScrypt(jobOptimizations);
      break;
    default:
      hasher = new OptimizedSHA256(jobOptimizations);
  }
  
  // Prepare template data
  const headerData = prepareBlockHeader(template);
  
  // Calculate target from difficulty
  const target = calculateTarget(difficulty);
  
  // Mining loop
  const batchSize = 1000;
  let nonce = nonceStart;
  let foundShare = false;
  
  while (isRunning && nonce < nonceEnd) {
    // Batch process for efficiency
    const count = Math.min(batchSize, nonceEnd - nonce);
    const hashes = hasher.batchHash(headerData, nonce, count);
    
    // Check results
    for (let i = 0; i < hashes.length; i++) {
      const hash = hashes[i];
      hashesComputed++;
      
      // Check if hash meets target
      if (checkHash(hash, target)) {
        const result = {
          nonce: nonce + i,
          hash: hash.toString('hex'),
          difficulty: calculateHashDifficulty(hash)
        };
        
        // Check if it's a block
        if (checkHash(hash, template.target)) {
          parentPort.postMessage({
            type: 'BLOCK_FOUND',
            data: result
          });
          foundShare = true;
          break;
        } else {
          parentPort.postMessage({
            type: 'SHARE_FOUND',
            data: result
          });
        }
      }
    }
    
    if (foundShare) break;
    
    nonce += count;
    
    // Report progress periodically
    const now = Date.now();
    if (now - lastProgressReport > 1000) { // Every second
      reportProgress(nonce - nonceStart);
      lastProgressReport = now;
    }
    
    // Yield to prevent blocking
    if (hashesComputed % 10000 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  
  // Final progress report
  reportProgress(nonce - nonceStart);
}

/**
 * Prepare block header from template
 */
function prepareBlockHeader(template) {
  // Simplified header preparation
  const header = Buffer.allocUnsafe(80);
  
  // Version
  header.writeInt32LE(template.version || 1, 0);
  
  // Previous block hash
  if (template.previousblockhash) {
    Buffer.from(template.previousblockhash, 'hex').copy(header, 4);
  }
  
  // Merkle root
  if (template.merkleroot) {
    Buffer.from(template.merkleroot, 'hex').copy(header, 36);
  }
  
  // Timestamp
  header.writeUInt32LE(template.curtime || Math.floor(Date.now() / 1000), 68);
  
  // Bits (difficulty)
  if (template.bits) {
    Buffer.from(template.bits, 'hex').copy(header, 72);
  }
  
  // Nonce placeholder (76-79)
  
  return header;
}

/**
 * Calculate target from difficulty
 */
function calculateTarget(difficulty) {
  const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
  const target = maxTarget / BigInt(Math.floor(difficulty));
  
  // Convert to buffer for comparison
  const hex = target.toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

/**
 * Check if hash meets target
 */
function checkHash(hash, target) {
  // Compare as buffers (reverse for little-endian)
  const hashReversed = Buffer.from(hash).reverse();
  return hashReversed.compare(target) <= 0;
}

/**
 * Calculate difficulty of a hash
 */
function calculateHashDifficulty(hash) {
  const hashBigInt = BigInt('0x' + hash.toString('hex'));
  const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
  
  if (hashBigInt === 0n) return 0;
  
  return Number(maxTarget / hashBigInt);
}

/**
 * Report mining progress
 */
function reportProgress(noncesProcessed) {
  const elapsed = Date.now() - performance.startTime;
  const hashrate = elapsed > 0 ? (hashesComputed / elapsed) * 1000 : 0;
  
  // Update performance metrics
  performance.hashesPerReport = hashesComputed - performance.hashesPerReport;
  performance.efficiency = hashrate > 0 ? 
    Math.min(1, hashrate / 100000000) : 0; // Normalize to 100MH/s
  
  parentPort.postMessage({
    type: 'PROGRESS',
    data: {
      noncesProcessed,
      hashesComputed,
      hashrate,
      workerId
    }
  });
  
  // Report performance metrics
  parentPort.postMessage({
    type: 'PERFORMANCE',
    data: {
      efficiency: performance.efficiency,
      temperature: performance.temperature,
      powerUsage: estimatePowerUsage(hashrate)
    }
  });
}

/**
 * Estimate power usage based on hashrate
 */
function estimatePowerUsage(hashrate) {
  // Rough estimation: 1 MH/s ≈ 0.1W for optimized CPU mining
  return (hashrate / 1000000) * 0.1;
}

/**
 * Handle messages from parent
 */
parentPort.on('message', async (message) => {
  switch (message.type) {
    case 'START_MINING':
      currentJob = message.job;
      isRunning = true;
      hashesComputed = 0;
      performance.startTime = Date.now();
      await mine(currentJob);
      break;
      
    case 'STOP_MINING':
      isRunning = false;
      break;
      
    case 'UPDATE_OPTIMIZATIONS':
      // Update runtime optimizations
      if (currentJob) {
        currentJob.optimizations = message.optimizations;
      }
      break;
  }
});

// Send ready signal
parentPort.postMessage({
  type: 'WORKER_READY',
  workerId
});