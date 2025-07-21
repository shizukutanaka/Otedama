/**
 * Mining Worker Thread for Otedama
 * Executes mining operations in separate thread
 */

import { parentPort } from 'worker_threads';
import { AlgorithmFactory } from './algorithms.js';

// Message handler
parentPort.on('message', async (message) => {
  try {
    switch (message.type) {
      case 'mine':
        await mine(message);
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
 * Mining function
 */
async function mine(message) {
  const { job, algorithm, startNonce, endNonce } = message;
  
  try {
    // Create algorithm instance
    const algo = AlgorithmFactory.create(algorithm);
    
    // Parse header
    const header = Buffer.from(job.header, 'hex');
    const target = job.target;
    
    // Progress reporting interval
    let lastReport = Date.now();
    const reportInterval = 1000; // 1 second
    
    // Mine
    algo.nonce = startNonce;
    const targetBigInt = BigInt('0x' + target);
    
    while (algo.nonce <= endNonce) {
      const nonceBuffer = Buffer.allocUnsafe(4);
      nonceBuffer.writeUInt32LE(algo.nonce);
      
      // Combine header and nonce
      const data = Buffer.concat([header, nonceBuffer]);
      
      // Calculate hash
      const hash = algo.hash(data);
      const hashBigInt = BigInt('0x' + hash);
      
      algo.hashCount++;
      
      // Check if hash meets target
      if (hashBigInt <= targetBigInt) {
        parentPort.postMessage({
          type: 'found',
          result: {
            found: true,
            nonce: algo.nonce,
            hash,
            attempts: algo.hashCount,
            hashrate: algo.getHashrate()
          }
        });
        return;
      }
      
      // Report progress
      const now = Date.now();
      if (now - lastReport >= reportInterval) {
        parentPort.postMessage({
          type: 'progress',
          nonce: algo.nonce,
          hashrate: algo.getHashrate(),
          attempts: algo.hashCount
        });
        lastReport = now;
      }
      
      algo.nonce++;
    }
    
    // No solution found in range
    parentPort.postMessage({
      type: 'complete',
      result: {
        found: false,
        attempts: algo.hashCount,
        hashrate: algo.getHashrate()
      }
    });
    
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      error: error.message
    });
  }
}

// Ready signal
parentPort.postMessage({ type: 'ready' });