/**
 * Mining Worker for Otedama
 * Handles mining computations in separate thread
 * 
 * Following Carmack's principle: optimize the inner loop
 */

import { parentPort, workerData } from 'worker_threads';
import crypto from 'crypto';

// Mining algorithms
const ALGORITHMS = {
  sha256: {
    hash: (data) => crypto.createHash('sha256').update(data).digest(),
    target: (difficulty) => {
      const max = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
      return max / BigInt(difficulty);
    }
  },
  
  scrypt: {
    hash: (data) => {
      // Simplified scrypt for demo
      return crypto.scryptSync(data, 'salt', 32);
    },
    target: (difficulty) => {
      const max = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
      return max / BigInt(difficulty);
    }
  },
  
  sha256d: {
    hash: (data) => {
      const hash1 = crypto.createHash('sha256').update(data).digest();
      return crypto.createHash('sha256').update(hash1).digest();
    },
    target: (difficulty) => {
      const max = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
      return max / BigInt(difficulty);
    }
  }
};

// Worker state
const state = {
  workerId: workerData?.workerId || 'unknown',
  algorithm: null,
  currentJob: null,
  hashCount: 0,
  startTime: Date.now()
};

/**
 * Initialize algorithm
 */
function initializeAlgorithm(algorithm) {
  if (!ALGORITHMS[algorithm]) {
    throw new Error(`Unknown algorithm: ${algorithm}`);
  }
  
  state.algorithm = ALGORITHMS[algorithm];
  
  parentPort.postMessage({
    type: 'log',
    data: `Worker ${state.workerId} initialized with ${algorithm}`
  });
}

/**
 * Mining function
 */
function mine(job) {
  const { blockHeader, target, startNonce, endNonce } = job;
  
  if (!state.algorithm) {
    throw new Error('Algorithm not initialized');
  }
  
  const targetBigInt = BigInt('0x' + target);
  let nonce = startNonce;
  const headerBuffer = Buffer.from(blockHeader, 'hex');
  
  // Performance optimization: pre-allocate buffers
  const nonceBuffer = Buffer.allocUnsafe(4);
  const dataBuffer = Buffer.concat([headerBuffer, nonceBuffer]);
  
  const startTime = Date.now();
  let lastReport = startTime;
  let localHashCount = 0;
  
  while (nonce <= endNonce) {
    // Write nonce to buffer (little-endian)
    nonceBuffer.writeUInt32LE(nonce, 0);
    
    // Calculate hash
    const hash = state.algorithm.hash(dataBuffer);
    localHashCount++;
    
    // Check if hash meets target
    const hashBigInt = BigInt('0x' + hash.toString('hex'));
    if (hashBigInt <= targetBigInt) {
      return {
        found: true,
        nonce,
        hash: hash.toString('hex'),
        hashCount: localHashCount
      };
    }
    
    // Progress reporting
    const now = Date.now();
    if (now - lastReport >= 1000) { // Report every second
      parentPort.postMessage({
        type: 'progress',
        data: {
          nonce,
          hashCount: localHashCount,
          hashRate: (localHashCount * 1000) / (now - startTime)
        }
      });
      lastReport = now;
    }
    
    nonce++;
  }
  
  return {
    found: false,
    hashCount: localHashCount
  };
}

/**
 * Validate share
 */
function validateShare(share) {
  const { nonce, blockHeader, difficulty, algorithm } = share;
  
  const algo = ALGORITHMS[algorithm];
  if (!algo) {
    return { valid: false, reason: 'Unknown algorithm' };
  }
  
  // Reconstruct and hash
  const nonceBuffer = Buffer.allocUnsafe(4);
  nonceBuffer.writeUInt32LE(nonce, 0);
  const data = Buffer.concat([
    Buffer.from(blockHeader, 'hex'),
    nonceBuffer
  ]);
  
  const hash = algo.hash(data);
  const hashBigInt = BigInt('0x' + hash.toString('hex'));
  const target = algo.target(difficulty);
  
  if (hashBigInt > target) {
    return { valid: false, reason: 'Hash does not meet difficulty' };
  }
  
  return {
    valid: true,
    hash: hash.toString('hex')
  };
}

/**
 * Calculate merkle root
 */
function calculateMerkleRoot(transactions) {
  if (transactions.length === 0) {
    return Buffer.alloc(32).toString('hex');
  }
  
  let level = transactions.map(tx => {
    if (typeof tx === 'string') {
      return Buffer.from(tx, 'hex');
    }
    return crypto.createHash('sha256').update(JSON.stringify(tx)).digest();
  });
  
  while (level.length > 1) {
    const nextLevel = [];
    
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] || left;
      
      const combined = Buffer.concat([left, right]);
      const hash = crypto.createHash('sha256')
        .update(crypto.createHash('sha256').update(combined).digest())
        .digest();
      
      nextLevel.push(hash);
    }
    
    level = nextLevel;
  }
  
  return level[0].toString('hex');
}

/**
 * Handle messages from main thread
 */
async function handleMessage(message) {
  try {
    switch (message.type) {
      case 'initialize':
        initializeAlgorithm(message.algorithm);
        return { initialized: true };
        
      case 'mine':
        state.currentJob = message.job;
        const result = mine(message.job);
        state.hashCount += result.hashCount;
        return result;
        
      case 'validate':
        return validateShare(message.share);
        
      case 'merkle':
        return {
          root: calculateMerkleRoot(message.transactions)
        };
        
      case 'stats':
        const uptime = Date.now() - state.startTime;
        return {
          workerId: state.workerId,
          hashCount: state.hashCount,
          uptime,
          hashRate: state.hashCount / (uptime / 1000)
        };
        
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
    data: `Mining worker ${state.workerId} ready`
  });
}

// Handle errors
process.on('uncaughtException', (error) => {
  parentPort.postMessage({
    type: 'error',
    data: {
      message: error.message,
      stack: error.stack
    }
  });
});

process.on('unhandledRejection', (reason, promise) => {
  parentPort.postMessage({
    type: 'error',
    data: {
      message: 'Unhandled promise rejection',
      reason
    }
  });
});

export { ALGORITHMS, mine, validateShare, calculateMerkleRoot };
