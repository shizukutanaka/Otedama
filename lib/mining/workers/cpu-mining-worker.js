/**
 * CPU Mining Worker - Otedama
 * Worker thread for CPU mining
 * 
 * Design principles:
 * - Efficient hashing loops (Carmack)
 * - Clean algorithm abstraction (Martin)
 * - Simple worker protocol (Pike)
 */

import { parentPort, workerData } from 'worker_threads';
import { createHash } from 'crypto';
import * as algorithms from '../algorithms/index.js';

// Worker configuration
const config = {
  threadId: workerData.threadId || 0,
  algorithm: workerData.algorithm || 'sha256',
  affinity: workerData.affinity
};

// Mining state
let isRunning = false;
let currentJob = null;
let difficulty = 1;
let hashCount = 0;
let lastReport = Date.now();

// Algorithm instance
let algo = null;

/**
 * Initialize worker
 */
function initialize() {
  // Load algorithm
  const AlgorithmClass = algorithms[config.algorithm.toUpperCase()];
  
  if (!AlgorithmClass) {
    parentPort.postMessage({
      type: 'error',
      error: `Unknown algorithm: ${config.algorithm}`
    });
    return;
  }
  
  algo = new AlgorithmClass();
  
  // Set thread affinity if specified
  if (config.affinity && process.platform === 'linux') {
    try {
      const { execSync } = require('child_process');
      execSync(`taskset -pc ${config.affinity} ${process.pid}`);
    } catch (error) {
      // Affinity setting failed, continue anyway
    }
  }
  
  parentPort.postMessage({
    type: 'ready',
    threadId: config.threadId
  });
}

/**
 * Main message handler
 */
parentPort.on('message', (message) => {
  switch (message.type) {
    case 'start':
      currentJob = message.job;
      difficulty = message.difficulty;
      isRunning = true;
      startMining();
      break;
      
    case 'stop':
      isRunning = false;
      break;
      
    case 'job':
      currentJob = message.job;
      break;
      
    case 'difficulty':
      difficulty = message.difficulty;
      break;
      
    case 'priority':
      setPriority(message.priority);
      break;
  }
});

/**
 * Start mining loop
 */
async function startMining() {
  while (isRunning) {
    if (!currentJob) {
      await sleep(100);
      continue;
    }
    
    // Mine one batch
    const batchSize = 100000; // Hashes per batch
    const found = await mineBatch(batchSize);
    
    if (found) {
      reportShare(found);
    }
    
    // Report hashrate periodically
    const now = Date.now();
    if (now - lastReport > 1000) {
      reportHashrate();
      lastReport = now;
    }
    
    // Yield to other processes
    await sleep(0);
  }
}

/**
 * Mine a batch of hashes
 */
async function mineBatch(batchSize) {
  const job = currentJob;
  const target = difficultyToTarget(difficulty);
  
  // Get nonce range for this batch
  const startNonce = hashCount;
  const endNonce = startNonce + batchSize;
  
  for (let nonce = startNonce; nonce < endNonce && isRunning; nonce++) {
    // Build block header
    const header = buildHeader(job, nonce);
    
    // Hash it
    const hash = algo.hash(header);
    
    // Check if it meets target
    if (hashMeetsTarget(hash, target)) {
      return {
        nonce,
        hash: hash.toString('hex'),
        difficulty: targetToDifficulty(hash)
      };
    }
    
    hashCount++;
  }
  
  return null;
}

/**
 * Build block header
 */
function buildHeader(job, nonce) {
  // This is simplified - actual implementation depends on algorithm
  const header = Buffer.allocUnsafe(80);
  
  // Version (4 bytes)
  header.writeUInt32LE(parseInt(job.version, 16), 0);
  
  // Previous block hash (32 bytes)
  Buffer.from(job.prevHash, 'hex').copy(header, 4);
  
  // Merkle root (32 bytes)
  Buffer.from(job.merkleRoot || calculateMerkleRoot(job), 'hex').copy(header, 36);
  
  // Timestamp (4 bytes)
  header.writeUInt32LE(parseInt(job.ntime, 16), 68);
  
  // Bits (4 bytes)
  header.writeUInt32LE(parseInt(job.nbits, 16), 72);
  
  // Nonce (4 bytes)
  header.writeUInt32LE(nonce, 76);
  
  return header;
}

/**
 * Calculate merkle root
 */
function calculateMerkleRoot(job) {
  // Combine coinbase with extranonce
  const coinbase = Buffer.concat([
    Buffer.from(job.coinbase1, 'hex'),
    Buffer.from(job.extraNonce1 || '', 'hex'),
    Buffer.from(job.extraNonce2 || '', 'hex'),
    Buffer.from(job.coinbase2, 'hex')
  ]);
  
  // Hash coinbase
  let root = doubleSHA256(coinbase);
  
  // Build merkle tree
  for (const branch of (job.merkleBranch || [])) {
    const branchBuf = Buffer.from(branch, 'hex');
    root = doubleSHA256(Buffer.concat([root, branchBuf]));
  }
  
  return root.toString('hex');
}

/**
 * Double SHA256
 */
function doubleSHA256(data) {
  return createHash('sha256')
    .update(createHash('sha256').update(data).digest())
    .digest();
}

/**
 * Convert difficulty to target
 */
function difficultyToTarget(difficulty) {
  const maxTarget = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
  return maxTarget / BigInt(Math.floor(difficulty));
}

/**
 * Check if hash meets target
 */
function hashMeetsTarget(hash, target) {
  const hashBigInt = BigInt('0x' + hash.toString('hex'));
  return hashBigInt <= target;
}

/**
 * Convert hash to difficulty
 */
function targetToDifficulty(hash) {
  const maxTarget = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
  const hashBigInt = BigInt('0x' + hash.toString('hex'));
  return Number(maxTarget / hashBigInt);
}

/**
 * Report found share
 */
function reportShare(share) {
  parentPort.postMessage({
    type: 'share',
    data: {
      threadId: config.threadId,
      ...share,
      timestamp: Date.now()
    }
  });
}

/**
 * Report hashrate
 */
function reportHashrate() {
  const duration = (Date.now() - lastReport) / 1000;
  const hashrate = hashCount / duration;
  
  parentPort.postMessage({
    type: 'hashrate',
    data: {
      threadId: config.threadId,
      hashes: hashCount,
      hashrate
    }
  });
}

/**
 * Set process priority
 */
function setPriority(priority) {
  try {
    process.nice(priority);
  } catch (error) {
    // Priority setting might not be available
  }
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Initialize worker
initialize();