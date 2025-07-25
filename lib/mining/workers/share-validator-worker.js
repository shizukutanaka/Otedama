/**
 * Share Validator Worker - Otedama
 * Worker thread for parallel share validation
 */

import { parentPort } from 'worker_threads';
import { createHash } from 'crypto';

// Pre-computed values
const maxTargetBigInt = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');

/**
 * Handle messages from main thread
 */
parentPort.on('message', (message) => {
  const { type, batch, batchId } = message;
  
  if (type === 'validateBatch') {
    const results = validateBatch(batch);
    
    parentPort.postMessage({
      type: 'batchComplete',
      results,
      workerId: process.pid,
      batchId
    });
  }
});

/**
 * Validate batch of shares
 */
function validateBatch(batch) {
  return batch.map(item => validateShare(item));
}

/**
 * Validate single share
 */
function validateShare(item) {
  const { share, job, minerTarget, networkTarget } = item;
  
  try {
    // Construct block header
    const header = constructHeader(share, job);
    
    // Calculate hash
    const hash = calculateHash(header);
    const hashBigInt = BigInt('0x' + hash.toString('hex'));
    
    // Check against miner target
    const minerTargetBigInt = BigInt('0x' + minerTarget);
    
    if (hashBigInt > minerTargetBigInt) {
      return {
        valid: false,
        reason: 'High hash',
        hash: hash.toString('hex')
      };
    }
    
    // Check if it's a block
    const networkTargetBigInt = BigInt('0x' + networkTarget);
    const isBlock = hashBigInt <= networkTargetBigInt;
    
    // Calculate share value
    const shareValue = Number(maxTargetBigInt / hashBigInt);
    
    return {
      valid: true,
      hash: hash.toString('hex'),
      shareValue,
      isBlock,
      blockHeight: isBlock ? job.height : null
    };
    
  } catch (error) {
    return {
      valid: false,
      reason: 'Validation error: ' + error.message
    };
  }
}

/**
 * Construct block header
 */
function constructHeader(share, job) {
  const header = Buffer.alloc(80);
  
  // Version (4 bytes)
  header.writeUInt32LE(parseInt(job.version, 16), 0);
  
  // Previous block hash (32 bytes)
  Buffer.from(job.prevHash, 'hex').reverse().copy(header, 4);
  
  // Merkle root (32 bytes)
  const merkleRoot = calculateMerkleRoot(share, job);
  merkleRoot.copy(header, 36);
  
  // Timestamp (4 bytes)
  header.writeUInt32LE(parseInt(share.ntime, 16), 68);
  
  // Bits (4 bytes)
  header.writeUInt32LE(parseInt(job.nbits, 16), 72);
  
  // Nonce (4 bytes)
  header.writeUInt32LE(parseInt(share.nonce, 16), 76);
  
  return header;
}

/**
 * Calculate merkle root
 */
function calculateMerkleRoot(share, job) {
  // Construct coinbase
  const coinbase = Buffer.concat([
    Buffer.from(job.coinbase1, 'hex'),
    Buffer.from(share.extraNonce1, 'hex'),
    Buffer.from(share.extraNonce2, 'hex'),
    Buffer.from(job.coinbase2, 'hex')
  ]);
  
  // Hash coinbase
  let root = sha256d(coinbase);
  
  // Calculate merkle root
  for (const branch of (job.merkleBranch || [])) {
    const branchHash = Buffer.from(branch, 'hex');
    root = sha256d(Buffer.concat([root, branchHash]));
  }
  
  return root.reverse();
}

/**
 * Calculate hash
 */
function calculateHash(data) {
  return sha256d(data).reverse();
}

/**
 * SHA256d (double SHA256)
 */
function sha256d(data) {
  return createHash('sha256')
    .update(createHash('sha256').update(data).digest())
    .digest();
}

// Signal ready
parentPort.postMessage({ type: 'ready', workerId: process.pid });