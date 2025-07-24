/**
 * Share Validation Worker
 * Handles CPU-intensive proof of work validation in separate thread
 */

const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');
const { createLogger } = require('../core/logger');

const logger = createLogger(`share-worker-${workerData.workerId}`);

// Algorithm implementations
const algorithms = {
  sha256d: require('./algorithms/sha256'),
  scrypt: require('./algorithms/scrypt'),
  ethash: require('./algorithms/ethash'),
  randomx: require('./algorithms/randomx'),
  kawpow: require('./algorithms/kawpow')
};

// Pre-computed constants
const MAX_TARGET = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
const DIFF1_TARGET = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');

// Buffer pools for zero-copy operations
const bufferPools = {
  header: [],
  hash: [],
  target: []
};

/**
 * Initialize buffer pools
 */
function initializeBufferPools() {
  // Pre-allocate buffers
  for (let i = 0; i < 100; i++) {
    bufferPools.header.push(Buffer.allocUnsafe(80));
    bufferPools.hash.push(Buffer.allocUnsafe(32));
    bufferPools.target.push(Buffer.allocUnsafe(32));
  }
}

/**
 * Get buffer from pool
 */
function getBuffer(type) {
  return bufferPools[type].pop() || Buffer.allocUnsafe(type === 'header' ? 80 : 32);
}

/**
 * Return buffer to pool
 */
function returnBuffer(type, buffer) {
  if (bufferPools[type].length < 100) {
    buffer.fill(0); // Clear for security
    bufferPools[type].push(buffer);
  }
}

/**
 * Handle validation message
 */
parentPort.on('message', async (message) => {
  if (message.type === 'validate') {
    const result = await validateShare(message);
    
    parentPort.postMessage({
      ...result,
      workerId: workerData.workerId,
      taskId: message.taskId,
      timestamp: message.timestamp
    });
  }
});

/**
 * Validate share proof of work
 */
async function validateShare(message) {
  const { share, job } = message;
  const startTime = Date.now();
  
  try {
    // Get algorithm
    const algorithm = algorithms[job.algorithm || 'sha256d'];
    if (!algorithm) {
      return {
        valid: false,
        reason: 'unsupported_algorithm',
        processingTime: Date.now() - startTime
      };
    }
    
    // Build block header
    const header = buildBlockHeader(share, job);
    
    // Calculate hash
    const hash = await algorithm.hash(header, share);
    
    // Convert hash to BigInt for comparison
    const hashBigInt = hashToBigInt(hash);
    
    // Check share difficulty
    const shareDifficulty = calculateDifficulty(hashBigInt);
    const targetDifficulty = share.difficulty || job.difficulty;
    
    if (shareDifficulty < targetDifficulty) {
      return {
        valid: false,
        reason: 'low_difficulty',
        shareDifficulty,
        targetDifficulty,
        processingTime: Date.now() - startTime
      };
    }
    
    // Check if it's a block (meets network difficulty)
    const networkTarget = difficultyToTarget(job.networkDifficulty);
    const isBlock = hashBigInt <= networkTarget;
    
    // Additional validation for blocks
    if (isBlock && workerData.options.validateCoinbase) {
      const coinbaseValid = await validateCoinbase(share, job);
      if (!coinbaseValid) {
        return {
          valid: false,
          reason: 'invalid_coinbase',
          processingTime: Date.now() - startTime
        };
      }
    }
    
    return {
      valid: true,
      isBlock,
      hash: hash.toString('hex'),
      shareDifficulty,
      processingTime: Date.now() - startTime
    };
    
  } catch (error) {
    logger.error('Validation error:', error);
    return {
      valid: false,
      reason: 'validation_error',
      error: error.message,
      processingTime: Date.now() - startTime
    };
  }
}

/**
 * Build block header from share and job
 */
function buildBlockHeader(share, job) {
  const header = getBuffer('header');
  
  try {
    // Version (4 bytes)
    header.writeUInt32LE(parseInt(job.version, 16), 0);
    
    // Previous block hash (32 bytes)
    Buffer.from(job.prevHash, 'hex').copy(header, 4);
    
    // Merkle root (32 bytes)
    const merkleRoot = calculateMerkleRoot(share, job);
    merkleRoot.copy(header, 36);
    
    // Timestamp (4 bytes)
    header.writeUInt32LE(parseInt(share.time, 16), 68);
    
    // Bits (4 bytes)
    header.writeUInt32LE(parseInt(job.bits, 16), 72);
    
    // Nonce (4 bytes)
    header.writeUInt32LE(parseInt(share.nonce, 16), 76);
    
    return header;
  } catch (error) {
    returnBuffer('header', header);
    throw error;
  }
}

/**
 * Calculate merkle root
 */
function calculateMerkleRoot(share, job) {
  // Build coinbase transaction
  const coinbase = Buffer.concat([
    Buffer.from(job.coinbase1, 'hex'),
    Buffer.from(share.extraNonce1, 'hex'),
    Buffer.from(share.extraNonce2, 'hex'),
    Buffer.from(job.coinbase2, 'hex')
  ]);
  
  // Hash coinbase
  const coinbaseHash = doubleSha256(coinbase);
  
  // Build merkle tree
  let hashes = [coinbaseHash];
  
  // Add transaction hashes
  if (job.transactions) {
    for (const tx of job.transactions) {
      hashes.push(Buffer.from(tx, 'hex'));
    }
  }
  
  // Calculate merkle root
  while (hashes.length > 1) {
    const newHashes = [];
    
    for (let i = 0; i < hashes.length; i += 2) {
      const left = hashes[i];
      const right = hashes[i + 1] || left;
      
      const combined = Buffer.concat([left, right]);
      const hash = doubleSha256(combined);
      newHashes.push(hash);
    }
    
    hashes = newHashes;
  }
  
  return hashes[0];
}

/**
 * Double SHA256 hash
 */
function doubleSha256(data) {
  const hash1 = crypto.createHash('sha256').update(data).digest();
  return crypto.createHash('sha256').update(hash1).digest();
}

/**
 * Convert hash buffer to BigInt
 */
function hashToBigInt(hash) {
  // Reverse for little-endian
  const reversed = Buffer.from(hash).reverse();
  return BigInt('0x' + reversed.toString('hex'));
}

/**
 * Calculate difficulty from hash
 */
function calculateDifficulty(hashBigInt) {
  if (hashBigInt === 0n) return 0;
  return Number(DIFF1_TARGET / hashBigInt);
}

/**
 * Convert difficulty to target
 */
function difficultyToTarget(difficulty) {
  return DIFF1_TARGET / BigInt(Math.floor(difficulty));
}

/**
 * Validate coinbase transaction
 */
async function validateCoinbase(share, job) {
  try {
    // Build coinbase
    const coinbase = Buffer.concat([
      Buffer.from(job.coinbase1, 'hex'),
      Buffer.from(share.extraNonce1, 'hex'),
      Buffer.from(share.extraNonce2, 'hex'),
      Buffer.from(job.coinbase2, 'hex')
    ]);
    
    // Basic validation
    if (coinbase.length < 60) {
      return false;
    }
    
    // Check for required patterns
    // This is simplified - real validation would parse the transaction
    
    return true;
  } catch (error) {
    logger.error('Coinbase validation error:', error);
    return false;
  }
}

/**
 * Initialize worker
 */
function initialize() {
  initializeBufferPools();
  logger.info(`Share validation worker ${workerData.workerId} initialized`);
}

// Initialize on startup
initialize();

// Handle cleanup
process.on('exit', () => {
  logger.info(`Share validation worker ${workerData.workerId} shutting down`);
});