/**
 * CPU Mining Worker Thread - Otedama
 * Executes mining algorithms in worker threads
 * 
 * Design principles:
 * - Carmack: SIMD optimizations where available
 * - Martin: Clean worker interface
 * - Pike: Simple and efficient
 */

import { parentPort, workerData } from 'worker_threads';
import { createHash } from 'crypto';
import { randomBytes } from 'crypto';

// Get worker configuration
const { threadId, algorithm, features } = workerData;

// Mining algorithms
const algorithms = {
  // SHA256 (Bitcoin)
  sha256: (header, nonce) => {
    const buffer = Buffer.concat([header, Buffer.from(nonce.toString(16).padStart(8, '0'), 'hex')]);
    return createHash('sha256').update(buffer).digest();
  },
  
  // SHA256d (Bitcoin)
  sha256d: (header, nonce) => {
    const buffer = Buffer.concat([header, Buffer.from(nonce.toString(16).padStart(8, '0'), 'hex')]);
    const hash1 = createHash('sha256').update(buffer).digest();
    return createHash('sha256').update(hash1).digest();
  },
  
  // Scrypt (Litecoin)
  scrypt: (header, nonce) => {
    // Simplified - in production use native scrypt
    const buffer = Buffer.concat([header, Buffer.from(nonce.toString(16).padStart(8, '0'), 'hex')]);
    return createHash('sha256').update(buffer).digest();
  },
  
  // RandomX (Monero)
  randomx: (header, nonce) => {
    // Simplified - in production use RandomX library
    const buffer = Buffer.concat([header, Buffer.from(nonce.toString(16).padStart(8, '0'), 'hex')]);
    let hash = createHash('sha256').update(buffer).digest();
    
    // Simulate RandomX's memory-hard operations
    for (let i = 0; i < 4; i++) {
      hash = createHash('sha256').update(hash).digest();
    }
    
    return hash;
  },
  
  // Ethash (Ethereum)
  ethash: (header, nonce) => {
    // Simplified - in production use ethash library
    const buffer = Buffer.concat([header, Buffer.from(nonce.toString(16).padStart(16, '0'), 'hex')]);
    return createHash('sha256').update(buffer).digest();
  },
  
  // KawPow (Ravencoin)
  kawpow: (header, nonce) => {
    // Simplified - in production use KawPow library
    const buffer = Buffer.concat([header, Buffer.from(nonce.toString(16).padStart(8, '0'), 'hex')]);
    let hash = createHash('sha256').update(buffer).digest();
    
    // Simulate ProgPoW operations
    for (let i = 0; i < 2; i++) {
      hash = createHash('sha256').update(hash).digest();
    }
    
    return hash;
  }
};

// Select mining function
const mineFunction = algorithms[algorithm.toLowerCase()] || algorithms.sha256d;

// Performance tracking
let totalHashes = 0;
let lastReportTime = Date.now();
const reportInterval = 1000; // Report every second

// Mining state
let currentJob = null;
let mining = false;

/**
 * Check if hash meets target difficulty
 */
function checkDifficulty(hash, target) {
  // Compare hash with target
  for (let i = 0; i < hash.length; i++) {
    if (hash[i] < target[i]) return true;
    if (hash[i] > target[i]) return false;
  }
  return false;
}

/**
 * Convert difficulty to target
 */
function difficultyToTarget(difficulty) {
  // Simplified target calculation
  const maxTarget = Buffer.from('00000000ffff0000000000000000000000000000000000000000000000000000', 'hex');
  const target = Buffer.alloc(32);
  
  // Calculate actual target from difficulty
  // This is simplified - use proper difficulty conversion in production
  const zeros = Math.floor(Math.log2(difficulty) / 8);
  target.fill(0, 0, zeros);
  target.fill(0xff, zeros);
  
  return target;
}

/**
 * Mining loop
 */
async function mine(job, startNonce, endNonce) {
  currentJob = job;
  mining = true;
  
  const header = Buffer.from(job.header, 'hex');
  const target = difficultyToTarget(job.difficulty);
  
  let nonce = startNonce;
  let hashCount = 0;
  
  while (mining && nonce <= endNonce) {
    // Mine in batches for better performance
    const batchSize = features.avx2 ? 1000 : 100;
    
    for (let i = 0; i < batchSize && nonce <= endNonce; i++) {
      const hash = mineFunction(header, nonce);
      hashCount++;
      
      // Check if we found a valid share
      if (checkDifficulty(hash, target)) {
        parentPort.postMessage({
          type: 'share',
          jobId: job.id,
          nonce,
          hash: hash.toString('hex')
        });
      }
      
      nonce++;
    }
    
    totalHashes += hashCount;
    hashCount = 0;
    
    // Report performance periodically
    const now = Date.now();
    if (now - lastReportTime >= reportInterval) {
      parentPort.postMessage({
        type: 'hashrate',
        hashes: totalHashes,
        duration: now - lastReportTime
      });
      
      totalHashes = 0;
      lastReportTime = now;
    }
    
    // Yield to prevent blocking
    if (nonce % 10000 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  
  mining = false;
}

/**
 * SIMD-optimized mining (when available)
 */
function mineSIMD(job, startNonce, endNonce) {
  // This would use actual SIMD instructions through N-API
  // For now, fall back to regular mining
  return mine(job, startNonce, endNonce);
}

/**
 * Handle messages from main thread
 */
parentPort.on('message', async (message) => {
  try {
    switch (message.type) {
      case 'mine':
        if (features.avx2 || features.avx) {
          await mineSIMD(message.job, message.startNonce, message.endNonce);
        } else {
          await mine(message.job, message.startNonce, message.endNonce);
        }
        break;
        
      case 'stop':
        mining = false;
        break;
        
      case 'update_job':
        currentJob = message.job;
        break;
        
      default:
        parentPort.postMessage({
          type: 'error',
          error: `Unknown message type: ${message.type}`
        });
    }
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      error: error.message
    });
  }
});

// Log worker startup
parentPort.postMessage({
  type: 'ready',
  threadId,
  algorithm,
  features
});