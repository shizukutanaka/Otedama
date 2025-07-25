/**
 * CPU Mining Worker - Otedama
 * Worker thread for CPU mining
 * 
 * Features:
 * - Multi-algorithm support
 * - Nonce range partitioning
 * - Performance monitoring
 * - Efficient hashing
 */

import { parentPort, workerData } from 'worker_threads';
import crypto from 'crypto';

// Worker configuration
const { threadId, algorithm } = workerData;

// Mining state
let mining = false;
let currentJob = null;
let extraNonce1 = null;
let extraNonce2Size = 4;
let difficulty = 1;
let nonceRange = 0xFFFFFFFF;

// Statistics
let hashCount = 0;
let lastHashrateReport = Date.now();

// Algorithm implementations
const algorithms = {
  /**
   * SHA256 (Bitcoin)
   */
  sha256: (header) => {
    return crypto.createHash('sha256').update(
      crypto.createHash('sha256').update(header).digest()
    ).digest();
  },
  
  /**
   * Scrypt (Litecoin)
   */
  scrypt: (header) => {
    // Simplified - real scrypt requires more complex implementation
    return crypto.scryptSync(header, header, 32);
  },
  
  /**
   * Ethash (Ethereum)
   */
  ethash: (header) => {
    // Simplified - real ethash requires DAG
    return crypto.createHash('sha3-256').update(header).digest();
  },
  
  /**
   * RandomX (Monero)
   */
  randomx: (header) => {
    // Simplified - real RandomX is much more complex
    let hash = header;
    for (let i = 0; i < 8; i++) {
      hash = crypto.createHash('sha256').update(hash).digest();
    }
    return hash;
  }
};

// Select algorithm
const hashFunction = algorithms[algorithm] || algorithms.sha256;

/**
 * Handle messages from main thread
 */
parentPort.on('message', (message) => {
  switch (message.type) {
    case 'newJob':
      handleNewJob(message);
      break;
      
    case 'setDifficulty':
      difficulty = message.difficulty;
      break;
      
    case 'start':
      startMining();
      break;
      
    case 'stop':
      stopMining();
      break;
  }
});

/**
 * Handle new job
 */
function handleNewJob(message) {
  currentJob = message.job;
  extraNonce1 = message.extraNonce1;
  extraNonce2Size = message.extraNonce2Size;
  difficulty = message.difficulty;
  
  // Reset hash count for new job
  hashCount = 0;
}

/**
 * Start mining
 */
function startMining() {
  if (mining) return;
  
  mining = true;
  mine();
}

/**
 * Stop mining
 */
function stopMining() {
  mining = false;
}

/**
 * Main mining loop
 */
async function mine() {
  if (!mining || !currentJob) return;
  
  // Calculate nonce range for this thread
  const threadsTotal = 4; // Should be passed from main thread
  const rangeSize = Math.floor(nonceRange / threadsTotal);
  const startNonce = threadId * rangeSize;
  const endNonce = (threadId === threadsTotal - 1) ? nonceRange : (threadId + 1) * rangeSize;
  
  // Generate extranonce2 for this thread
  const extraNonce2 = Buffer.allocUnsafe(extraNonce2Size);
  extraNonce2.writeUInt32LE(threadId, 0);
  
  // Current time
  let time = currentJob.time;
  
  // Mining loop
  for (let nonce = startNonce; nonce < endNonce && mining; nonce++) {
    // Build block header
    const header = buildBlockHeader(currentJob, extraNonce1, extraNonce2, time, nonce);
    
    // Hash the header
    const hash = hashFunction(header);
    hashCount++;
    
    // Check if hash meets difficulty
    if (checkDifficulty(hash, difficulty)) {
      // Found a share!
      parentPort.postMessage({
        type: 'share',
        share: {
          extraNonce2: extraNonce2.toString('hex'),
          time,
          nonce: nonce.toString(16).padStart(8, '0')
        }
      });
    }
    
    // Report hashrate periodically
    const now = Date.now();
    if (now - lastHashrateReport > 5000) {
      const elapsed = (now - lastHashrateReport) / 1000;
      const hashrate = hashCount / elapsed;
      
      parentPort.postMessage({
        type: 'hashrate',
        hashrate
      });
      
      hashCount = 0;
      lastHashrateReport = now;
    }
    
    // Allow other operations periodically
    if (nonce % 10000 === 0) {
      await new Promise(resolve => setImmediate(resolve));
      
      // Update time if needed
      const currentTime = Math.floor(Date.now() / 1000);
      if (currentTime > time) {
        time = currentTime;
      }
    }
  }
  
  // Continue mining with next range
  if (mining) {
    setImmediate(() => mine());
  }
}

/**
 * Build block header
 */
function buildBlockHeader(job, extraNonce1, extraNonce2, time, nonce) {
  // Build coinbase
  const coinbase = Buffer.concat([
    Buffer.from(job.coinbase1, 'hex'),
    Buffer.from(extraNonce1, 'hex'),
    extraNonce2,
    Buffer.from(job.coinbase2, 'hex')
  ]);
  
  // Calculate coinbase hash
  const coinbaseHash = crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(coinbase).digest()
  ).digest();
  
  // Calculate merkle root
  let merkleRoot = coinbaseHash;
  for (const branch of job.merkleBranches) {
    const branchBuf = Buffer.from(branch, 'hex');
    merkleRoot = crypto.createHash('sha256').update(
      crypto.createHash('sha256').update(
        Buffer.concat([merkleRoot, branchBuf])
      ).digest()
    ).digest();
  }
  
  // Build header
  const header = Buffer.allocUnsafe(80);
  header.writeInt32LE(parseInt(job.version, 16), 0);
  Buffer.from(job.prevHash, 'hex').reverse().copy(header, 4);
  merkleRoot.reverse().copy(header, 36);
  header.writeUInt32LE(time, 68);
  header.writeUInt32LE(parseInt(job.bits, 16), 72);
  header.writeUInt32LE(nonce, 76);
  
  return header;
}

/**
 * Check if hash meets difficulty target
 */
function checkDifficulty(hash, difficulty) {
  // Convert hash to big integer
  let hashValue = BigInt('0x' + hash.reverse().toString('hex'));
  
  // Calculate target from difficulty
  const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
  const target = maxTarget / BigInt(difficulty);
  
  return hashValue <= target;
}

// Log worker start
console.log(`CPU Worker ${threadId} started for ${algorithm} mining`);
