/**
 * Hash Worker for Ultra-Fast Hash Engine
 * Handles cryptographic hashing operations in a separate thread
 */

const { parentPort } = require('worker_threads');
const crypto = require('crypto');

// Hash algorithm implementations
const algorithms = {
  sha256: (data) => {
    return crypto.createHash('sha256').update(data).digest();
  },
  sha256d: (data) => {
    const hash1 = crypto.createHash('sha256').update(data).digest();
    return crypto.createHash('sha256').update(hash1).digest();
  },
  scrypt: async (data) => {
    return new Promise((resolve, reject) => {
      crypto.scrypt(data, data, 32, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }
};

// Message handler
parentPort.on('message', async (task) => {
  try {
    const { id, algorithm, data } = task;
    const hasher = algorithms[algorithm];
    
    if (!hasher) {
      throw new Error('Unknown algorithm: ' + algorithm);
    }
    
    const result = await hasher(Buffer.from(data, 'hex'));
    
    parentPort.postMessage({
      id,
      result: result.toString('hex')
    });
  } catch (error) {
    parentPort.postMessage({
      id: task.id,
      error: error.message
    });
  }
});