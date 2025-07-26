/**
 * Mining Worker for Otedama
 * Handles mining computations in separate thread
 * 
 * Following Carmack's principle: optimize the inner loop
 */

import { parentPort, workerData } from 'worker_threads';
import crypto from 'crypto';

// Mining algorithms with optimized implementations
const ALGORITHMS = {
  sha256: {
    hash: (data) => crypto.createHash('sha256').update(data).digest(),
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
  },
  
  scrypt: {
    hash: (data) => {
      // Optimized scrypt implementation
      return crypto.scryptSync(data, 'otedama_salt', 32, {
        N: 1024,
        r: 1, 
        p: 1,
        maxmem: 32 * 1024 * 1024 // 32MB
      });
    },
    target: (difficulty) => {
      const max = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
      return max / BigInt(difficulty);
    }
  },
  
  ethash: {
    hash: (data) => {
      // Simplified Ethash (Keccak-256 based)
      return crypto.createHash('sha3-256').update(data).digest();
    },
    target: (difficulty) => {
      const max = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
      return max / BigInt(difficulty);
    }
  },
  
  randomx: {
    hash: (data) => {
      // Simplified RandomX simulation (memory-hard)
      let result = data;
      for (let i = 0; i < 256; i++) {
        const hash = crypto.createHash('sha3-512');
        hash.update(result);
        hash.update(Buffer.from([i & 0xFF]));
        result = hash.digest();
      }
      return result.slice(0, 32);
    },
    target: (difficulty) => {
      const max = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
      return max / BigInt(difficulty);
    }
  },
  
  kawpow: {
    hash: (data) => {
      // Simplified KawPoW (ProgPoW variant)
      let result = crypto.createHash('sha3-256').update(data).digest();
      
      // Multiple rounds of hashing with different patterns
      for (let i = 0; i < 64; i++) {
        const hash = crypto.createHash('sha256');
        hash.update(result);
        hash.update(Buffer.from([i & 0xFF]));
        result = hash.digest();
        
        // Periodic mixing with SHA3
        if (i % 8 === 0) {
          result = crypto.createHash('sha3-256').update(result).digest();
        }
      }
      
      return result;
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
 * Validate share with enhanced algorithm support
 */
function validateShare(share) {
  const { nonce, blockHeader, difficulty, algorithm, target } = share;
  
  const algo = ALGORITHMS[algorithm];
  if (!algo) {
    return { valid: false, reason: 'Unknown algorithm' };
  }
  
  try {
    // Reconstruct and hash
    const nonceBuffer = Buffer.allocUnsafe(4);
    nonceBuffer.writeUInt32LE(nonce, 0);
    const data = Buffer.concat([
      Buffer.from(blockHeader, 'hex'),
      nonceBuffer
    ]);
    
    const hash = algo.hash(data);
    const hashHex = hash.toString('hex');
    const hashBigInt = BigInt('0x' + hashHex);
    
    // Use provided target or calculate from difficulty
    let targetBigInt;
    if (target) {
      targetBigInt = BigInt('0x' + target);
    } else {
      targetBigInt = algo.target(difficulty);
    }
    
    const validShare = hashBigInt <= targetBigInt;
    
    if (!validShare) {
      return { valid: false, reason: 'Hash does not meet difficulty' };
    }
    
    // Check if it's a block candidate (meets network difficulty)
    const networkTarget = algo.target(difficulty * 1000); // Assume network is 1000x harder
    const blockCandidate = hashBigInt <= networkTarget;
    
    return {
      valid: true,
      hash: hashHex,
      difficulty,
      blockCandidate,
      algorithm
    };
    
  } catch (error) {
    return { valid: false, reason: 'Validation error', error: error.message };
  }
}

/**
 * Hardware optimization functions
 */
function optimizeForHardware(hardwareType, algorithm) {
  const optimizations = {
    cpu: {
      preferredAlgorithms: ['randomx', 'scrypt'],
      batchSize: 1000,
      threads: require('os').cpus().length
    },
    gpu: {
      preferredAlgorithms: ['ethash', 'kawpow'],
      batchSize: 10000,
      threads: 1 // GPU handles parallelism internally
    },
    asic: {
      preferredAlgorithms: ['sha256', 'sha256d'],
      batchSize: 100000,
      threads: 1 // ASIC optimized for specific algorithm
    }
  };
  
  return optimizations[hardwareType] || optimizations.cpu;
}

/**
 * Benchmark algorithm performance
 */
function benchmarkAlgorithm(algorithm, iterations = 1000) {
  const algo = ALGORITHMS[algorithm];
  if (!algo) {
    return { error: 'Unknown algorithm' };
  }
  
  const testData = crypto.randomBytes(80); // Typical block header size
  const startTime = process.hrtime.bigint();
  
  for (let i = 0; i < iterations; i++) {
    algo.hash(testData);
  }
  
  const endTime = process.hrtime.bigint();
  const duration = Number(endTime - startTime) / 1000000; // Convert to ms
  
  return {
    algorithm,
    iterations,
    duration,
    hashesPerSecond: iterations / (duration / 1000),
    averageTime: duration / iterations
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
      case 'validate_share':
        return validateShare(message.share || message.shareData);
        
      case 'merkle':
        return {
          root: calculateMerkleRoot(message.transactions)
        };
        
      case 'benchmark':
        return benchmarkAlgorithm(message.algorithm, message.iterations);
        
      case 'optimize_hardware':
        return optimizeForHardware(message.hardwareType, message.algorithm);
        
      case 'stats':
        const uptime = Date.now() - state.startTime;
        return {
          workerId: state.workerId,
          hashCount: state.hashCount,
          uptime,
          hashRate: state.hashCount / (uptime / 1000),
          algorithm: state.algorithm ? Object.keys(ALGORITHMS).find(key => ALGORITHMS[key] === state.algorithm) : null
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

export { ALGORITHMS, mine, validateShare, calculateMerkleRoot, benchmarkAlgorithm, optimizeForHardware };
