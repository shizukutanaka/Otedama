/**
 * Share Validator Worker for Otedama
 * Performs CPU-intensive share validation in separate thread
 */

import { parentPort } from 'worker_threads';
import { createHash } from 'crypto';

// Algorithm implementations
const algorithms = {
  sha256: (data) => {
    return createHash('sha256').update(data).digest();
  },
  
  sha256d: (data) => {
    const hash1 = createHash('sha256').update(data).digest();
    return createHash('sha256').update(hash1).digest();
  },
  
  scrypt: (data, params = { N: 1024, r: 1, p: 1 }) => {
    // Simplified scrypt for demonstration
    // In production, use a proper scrypt library
    return createHash('sha256').update(data).digest();
  },
  
  ethash: (data) => {
    // Simplified ethash
    return createHash('sha256').update(data).digest();
  },
  
  randomx: (data) => {
    // Simplified RandomX
    return createHash('sha256').update(data).digest();
  },
  
  kawpow: (data) => {
    // Simplified KawPow
    return createHash('sha256').update(data).digest();
  },
  
  x11: (data) => {
    // X11 uses 11 different hash functions
    // Simplified implementation
    let result = data;
    const hashFunctions = ['sha256', 'sha512', 'sha384'];
    
    for (const func of hashFunctions) {
      result = createHash(func).update(result).digest();
    }
    
    return result;
  },
  
  equihash: (data) => {
    // Simplified Equihash
    return createHash('sha256').update(data).digest();
  },
  
  autolykos2: (data) => {
    // Simplified Autolykos
    return createHash('sha256').update(data).digest();
  },
  
  kheavyhash: (data) => {
    // Simplified kHeavyHash
    return createHash('sha256').update(data).digest();
  },
  
  blake3: (data) => {
    // Simplified Blake3
    return createHash('sha256').update(data).digest();
  }
};

/**
 * Validate a mining share
 */
function validateShare(job, nonce, hash, difficulty) {
  try {
    // Get algorithm
    const algo = algorithms[job.algorithm];
    if (!algo) {
      throw new Error(`Unknown algorithm: ${job.algorithm}`);
    }
    
    // Construct block header with nonce
    const header = Buffer.concat([
      Buffer.from(job.header, 'hex'),
      Buffer.from(nonce, 'hex')
    ]);
    
    // Calculate hash
    const calculatedHash = algo(header);
    
    // Verify hash matches
    if (hash && calculatedHash.toString('hex') !== hash) {
      return { valid: false, reason: 'Hash mismatch' };
    }
    
    // Check if hash meets difficulty target
    const hashValue = BigInt('0x' + calculatedHash.toString('hex'));
    const target = calculateTarget(job.target, difficulty);
    
    if (hashValue > target) {
      return { valid: false, reason: 'Difficulty not met' };
    }
    
    // Check for block solution
    const blockTarget = BigInt('0x' + job.target);
    const isBlockSolution = hashValue <= blockTarget;
    
    return {
      valid: true,
      hash: calculatedHash.toString('hex'),
      isBlockSolution,
      difficulty
    };
    
  } catch (error) {
    return {
      valid: false,
      reason: error.message
    };
  }
}

/**
 * Calculate target from difficulty
 */
function calculateTarget(baseTarget, difficulty) {
  const base = BigInt('0x' + baseTarget);
  const diff = BigInt(Math.floor(difficulty));
  
  // Target = baseTarget / difficulty
  return base / diff;
}

/**
 * Handle messages from main thread
 */
parentPort.on('message', (task) => {
  const { job, nonce, hash, difficulty } = task;
  
  try {
    const result = validateShare(job, nonce, hash, difficulty);
    parentPort.postMessage({ success: true, result });
  } catch (error) {
    parentPort.postMessage({ 
      success: false, 
      error: error.message 
    });
  }
});