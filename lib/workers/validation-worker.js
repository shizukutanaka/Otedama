/**
 * Validation Worker for Otedama
 * High-performance share validation in separate thread
 * 
 * Following Martin's principle: single responsibility
 */

import { parentPort, workerData } from 'worker_threads';
import crypto from 'crypto';

// Validation rules
const VALIDATION_RULES = {
  // Basic structure validation
  structure: {
    required: ['jobId', 'nonce', 'minerId', 'timestamp'],
    optional: ['extraNonce', 'mixHash', 'workerName']
  },
  
  // Nonce validation
  nonce: {
    min: 0,
    max: 0xFFFFFFFF, // 32-bit max
    type: 'number'
  },
  
  // Timestamp validation (5 minute window)
  timestamp: {
    futureLimit: 60000, // 1 minute in future
    pastLimit: 300000  // 5 minutes in past
  },
  
  // Difficulty validation
  difficulty: {
    min: 1,
    max: Number.MAX_SAFE_INTEGER
  }
};

// Cache for job templates
const jobCache = new Map();
const CACHE_SIZE = 1000;
const CACHE_TTL = 300000; // 5 minutes

/**
 * Validate share structure
 */
function validateStructure(share) {
  // Check required fields
  for (const field of VALIDATION_RULES.structure.required) {
    if (!(field in share)) {
      return {
        valid: false,
        reason: `Missing required field: ${field}`
      };
    }
  }
  
  // Check field types
  if (typeof share.nonce !== 'number' || 
      !Number.isInteger(share.nonce)) {
    return {
      valid: false,
      reason: 'Nonce must be an integer'
    };
  }
  
  if (share.nonce < VALIDATION_RULES.nonce.min || 
      share.nonce > VALIDATION_RULES.nonce.max) {
    return {
      valid: false,
      reason: 'Nonce out of valid range'
    };
  }
  
  return { valid: true };
}

/**
 * Validate timestamp
 */
function validateTimestamp(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  
  if (timestamp > now + VALIDATION_RULES.timestamp.futureLimit) {
    return {
      valid: false,
      reason: 'Timestamp too far in future'
    };
  }
  
  if (diff > VALIDATION_RULES.timestamp.pastLimit) {
    return {
      valid: false,
      reason: 'Timestamp too old'
    };
  }
  
  return { valid: true };
}

/**
 * Validate difficulty
 */
function validateDifficulty(hash, difficulty) {
  // Convert hash to BigInt
  const hashBigInt = BigInt('0x' + hash);
  
  // Calculate target from difficulty
  const maxTarget = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
  const target = maxTarget / BigInt(difficulty);
  
  if (hashBigInt > target) {
    return {
      valid: false,
      reason: 'Hash does not meet difficulty target'
    };
  }
  
  return { valid: true };
}

/**
 * Check for duplicate share
 */
function checkDuplicate(share, recentShares) {
  const shareKey = `${share.jobId}:${share.nonce}:${share.minerId}`;
  
  if (recentShares.has(shareKey)) {
    return {
      valid: false,
      reason: 'Duplicate share'
    };
  }
  
  // Add to recent shares (with size limit)
  recentShares.set(shareKey, Date.now());
  
  // Clean old shares
  if (recentShares.size > 10000) {
    const cutoff = Date.now() - 300000; // 5 minutes
    for (const [key, time] of recentShares) {
      if (time < cutoff) {
        recentShares.delete(key);
      }
    }
  }
  
  return { valid: true };
}

/**
 * Validate extra nonce (for ASIC miners)
 */
function validateExtraNonce(share, job) {
  if (!share.extraNonce) {
    return { valid: true }; // Optional
  }
  
  // Check length
  if (share.extraNonce.length !== job.extraNonceSize * 2) {
    return {
      valid: false,
      reason: 'Invalid extra nonce size'
    };
  }
  
  // Check format (hex)
  if (!/^[0-9a-fA-F]+$/.test(share.extraNonce)) {
    return {
      valid: false,
      reason: 'Extra nonce must be hexadecimal'
    };
  }
  
  return { valid: true };
}

/**
 * Calculate share hash based on algorithm
 */
function calculateShareHash(share, job, algorithm) {
  let data;
  
  switch (algorithm) {
    case 'sha256':
    case 'sha256d': {
      // Bitcoin-style: version + prevhash + merkle + time + bits + nonce
      const nonceBuffer = Buffer.allocUnsafe(4);
      nonceBuffer.writeUInt32LE(share.nonce, 0);
      
      data = Buffer.concat([
        Buffer.from(job.version, 'hex'),
        Buffer.from(job.previousHash, 'hex'),
        Buffer.from(job.merkleRoot, 'hex'),
        Buffer.from(job.timestamp, 'hex'),
        Buffer.from(job.bits, 'hex'),
        nonceBuffer
      ]);
      
      if (algorithm === 'sha256d') {
        const hash1 = crypto.createHash('sha256').update(data).digest();
        return crypto.createHash('sha256').update(hash1).digest('hex');
      } else {
        return crypto.createHash('sha256').update(data).digest('hex');
      }
    }
    
    case 'scrypt': {
      // Litecoin-style
      const nonceBuffer = Buffer.allocUnsafe(4);
      nonceBuffer.writeUInt32LE(share.nonce, 0);
      
      data = Buffer.concat([
        Buffer.from(job.blockHeader, 'hex'),
        nonceBuffer
      ]);
      
      // Simplified scrypt for validation
      return crypto.scryptSync(data, 'salt', 32).toString('hex');
    }
    
    case 'ethash': {
      // Ethereum-style (simplified)
      if (!share.mixHash) {
        throw new Error('Missing mixHash for ethash');
      }
      
      // In production, this would use proper ethash
      const combined = share.nonce + share.mixHash + job.headerHash;
      return crypto.createHash('sha256').update(combined).digest('hex');
    }
    
    default:
      throw new Error(`Unknown algorithm: ${algorithm}`);
  }
}

/**
 * Main validation function
 */
async function validateShare(params) {
  const { share, job, difficulty, algorithm, recentShares } = params;
  
  try {
    // Step 1: Structure validation
    const structureCheck = validateStructure(share);
    if (!structureCheck.valid) {
      return structureCheck;
    }
    
    // Step 2: Timestamp validation
    const timestampCheck = validateTimestamp(share.timestamp);
    if (!timestampCheck.valid) {
      return timestampCheck;
    }
    
    // Step 3: Job validation (check if job exists)
    if (!job || job.id !== share.jobId) {
      return {
        valid: false,
        reason: 'Invalid or expired job ID'
      };
    }
    
    // Step 4: Duplicate check
    const duplicateCheck = checkDuplicate(share, recentShares);
    if (!duplicateCheck.valid) {
      return duplicateCheck;
    }
    
    // Step 5: Extra nonce validation (if applicable)
    if (job.extraNonceSize) {
      const extraNonceCheck = validateExtraNonce(share, job);
      if (!extraNonceCheck.valid) {
        return extraNonceCheck;
      }
    }
    
    // Step 6: Calculate hash
    const hash = calculateShareHash(share, job, algorithm);
    
    // Step 7: Difficulty validation
    const difficultyCheck = validateDifficulty(hash, difficulty);
    if (!difficultyCheck.valid) {
      return difficultyCheck;
    }
    
    // Step 8: Check if block found (network difficulty)
    let blockFound = false;
    if (job.networkDifficulty) {
      const networkCheck = validateDifficulty(hash, job.networkDifficulty);
      blockFound = networkCheck.valid;
    }
    
    return {
      valid: true,
      hash,
      blockFound,
      difficulty
    };
    
  } catch (error) {
    return {
      valid: false,
      reason: `Validation error: ${error.message}`
    };
  }
}

/**
 * Batch validation for performance
 */
async function validateBatch(shares, jobs, params) {
  const results = [];
  const recentShares = new Map();
  
  for (const share of shares) {
    const job = jobs[share.jobId];
    
    const result = await validateShare({
      share,
      job,
      difficulty: params.difficulty,
      algorithm: params.algorithm,
      recentShares
    });
    
    results.push({
      shareId: share.id,
      ...result
    });
  }
  
  return results;
}

// Worker state
const state = {
  workerId: workerData?.workerId || 'unknown',
  validatedCount: 0,
  startTime: Date.now()
};

// Recent shares for duplicate detection
const recentShares = new Map();

/**
 * Handle messages from main thread
 */
async function handleMessage(message) {
  try {
    switch (message.type) {
      case 'validate':
        state.validatedCount++;
        return await validateShare({
          ...message.params,
          recentShares
        });
        
      case 'validateBatch':
        state.validatedCount += message.shares.length;
        return await validateBatch(
          message.shares,
          message.jobs,
          message.params
        );
        
      case 'updateJob':
        // Cache job template
        jobCache.set(message.job.id, {
          job: message.job,
          timestamp: Date.now()
        });
        
        // Clean old jobs
        if (jobCache.size > CACHE_SIZE) {
          const cutoff = Date.now() - CACHE_TTL;
          for (const [id, data] of jobCache) {
            if (data.timestamp < cutoff) {
              jobCache.delete(id);
            }
          }
        }
        
        return { updated: true };
        
      case 'stats':
        const uptime = Date.now() - state.startTime;
        return {
          workerId: state.workerId,
          validatedCount: state.validatedCount,
          uptime,
          validationRate: state.validatedCount / (uptime / 1000),
          cacheSize: jobCache.size,
          recentSharesSize: recentShares.size
        };
        
      case 'clear':
        recentShares.clear();
        jobCache.clear();
        return { cleared: true };
        
      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
    
  } catch (error) {
    return {
      error: error.message,
      stack: error.stack
    };
  }
}

// Message handler
if (parentPort) {
  parentPort.on('message', async (message) => {
    const result = await handleMessage(message);
    
    parentPort.postMessage({
      type: 'result',
      data: result,
      id: message.id
    });
  });
  
  // Send ready signal
  parentPort.postMessage({
    type: 'log',
    data: `Validation worker ${state.workerId} ready`
  });
  
  // Periodic cleanup
  setInterval(() => {
    // Clean old cached jobs
    const cutoff = Date.now() - CACHE_TTL;
    for (const [id, data] of jobCache) {
      if (data.timestamp < cutoff) {
        jobCache.delete(id);
      }
    }
    
    // Report stats
    parentPort.postMessage({
      type: 'log',
      data: `Worker ${state.workerId} - Cache: ${jobCache.size}, Recent: ${recentShares.size}`
    });
  }, 60000); // Every minute
}

// Export for testing
export {
  validateShare,
  validateBatch,
  validateStructure,
  validateTimestamp,
  validateDifficulty,
  calculateShareHash
};
