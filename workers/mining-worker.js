/**
 * Mining Worker Thread for Otedama
 * Handles hash calculations and share validation
 */

import { parentPort } from 'worker_threads';
import { AlgorithmFactory } from '../lib/mining/algorithms.js';

// Message handler
parentPort.on('message', async (message) => {
  try {
    switch (message.type) {
      case 'validate':
        await handleValidation(message);
        break;
        
      case 'calculate':
        await handleCalculation(message);
        break;
        
      case 'mine':
        await handleMining(message);
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

/**
 * Handle share validation
 */
async function handleValidation(message) {
  const { job, nonce, hash, difficulty } = message;
  
  try {
    // Reconstruct block header with nonce
    const header = Buffer.from(job.header, 'hex');
    const nonceBuffer = Buffer.from(nonce, 'hex');
    
    // Replace nonce in header
    nonceBuffer.copy(header, header.length - 4);
    
    // Calculate hash based on algorithm
    const calculatedHash = calculateHash(job.algorithm, header);
    
    // Verify hash matches
    const hashMatches = calculatedHash === hash;
    
    // Check if hash meets difficulty target
    const meetsTarget = checkDifficulty(calculatedHash, difficulty);
    
    parentPort.postMessage({
      type: 'validation_result',
      valid: hashMatches && meetsTarget,
      calculatedHash,
      providedHash: hash
    });
  } catch (error) {
    parentPort.postMessage({
      type: 'validation_result',
      valid: false,
      error: error.message
    });
  }
}

/**
 * Handle hash calculation
 */
async function handleCalculation(message) {
  const { algorithm, data } = message;
  
  try {
    const hash = calculateHash(algorithm, Buffer.from(data, 'hex'));
    
    parentPort.postMessage({
      type: 'hash_calculated',
      hash,
      algorithm
    });
  } catch (error) {
    parentPort.postMessage({
      type: 'hash_calculated',
      error: error.message
    });
  }
}

/**
 * Handle mining (finding valid nonce)
 */
async function handleMining(message) {
  const { job, startNonce, endNonce, target } = message;
  
  try {
    const header = Buffer.from(job.header, 'hex');
    const targetBigInt = BigInt('0x' + target);
    let found = false;
    
    for (let nonce = startNonce; nonce <= endNonce; nonce++) {
      // Update nonce in header
      const nonceBuffer = Buffer.allocUnsafe(4);
      nonceBuffer.writeUInt32LE(nonce);
      nonceBuffer.copy(header, header.length - 4);
      
      // Calculate hash
      const hash = calculateHash(job.algorithm, header);
      const hashBigInt = BigInt('0x' + hash);
      
      // Check if hash meets target
      if (hashBigInt <= targetBigInt) {
        parentPort.postMessage({
          type: 'nonce_found',
          nonce: nonce.toString(16).padStart(8, '0'),
          hash,
          job: job.id
        });
        found = true;
        break;
      }
      
      // Report progress every 10000 hashes
      if (nonce % 10000 === 0) {
        parentPort.postMessage({
          type: 'mining_progress',
          nonce,
          hashrate: 10000 // Simple hashrate estimation
        });
      }
    }
    
    if (!found) {
      parentPort.postMessage({
        type: 'mining_complete',
        found: false
      });
    }
  } catch (error) {
    parentPort.postMessage({
      type: 'mining_error',
      error: error.message
    });
  }
}

/**
 * Calculate hash using specified algorithm
 */
function calculateHash(algorithm, data) {
  try {
    const algo = AlgorithmFactory.create(algorithm);
    return algo.hash(data);
  } catch (error) {
    // Fallback to SHA256 if algorithm not found
    const algo = AlgorithmFactory.create('sha256');
    return algo.hash(data);
  }
}

/**
 * Check if hash meets difficulty requirement
 */
function checkDifficulty(hash, difficulty) {
  // Difficulty 1 target
  const diff1Target = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
  
  // Calculate target for this difficulty
  const target = diff1Target / BigInt(Math.floor(difficulty));
  
  // Convert hash to BigInt
  const hashBigInt = BigInt('0x' + hash);
  
  // Hash must be less than or equal to target
  return hashBigInt <= target;
}

// Log that worker is ready
parentPort.postMessage({
  type: 'ready',
  algorithms: AlgorithmFactory.getSupported()
});