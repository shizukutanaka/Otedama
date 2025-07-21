/**
 * Mining Benchmark Worker
 * Runs mining algorithms in a separate thread
 */

import { parentPort, workerData } from 'worker_threads';
import crypto from 'crypto';

const { algorithm, difficulty, iterations } = workerData;

// Mining algorithm implementations
const algorithms = {
  sha256: (data) => {
    return crypto.createHash('sha256').update(data).digest('hex');
  },
  
  scrypt: (data) => {
    return crypto.scryptSync(data, 'salt', 32).toString('hex');
  },
  
  ethash: (data) => {
    // Simplified ethash-like algorithm
    let hash = data;
    for (let i = 0; i < 64; i++) {
      hash = crypto.createHash('sha3-256').update(hash).digest('hex');
    }
    return hash;
  }
};

// Run benchmark
async function runBenchmark() {
  const startTime = Date.now();
  const hashFunction = algorithms[algorithm] || algorithms.sha256;
  
  let validShares = 0;
  let totalHashes = 0;
  
  for (let i = 0; i < iterations; i++) {
    const nonce = crypto.randomBytes(32).toString('hex');
    const data = `block_${i}_${nonce}`;
    
    const hash = hashFunction(data);
    totalHashes++;
    
    // Check if hash meets difficulty (simplified)
    const hashValue = parseInt(hash.substr(0, 8), 16);
    if (hashValue < difficulty) {
      validShares++;
    }
  }
  
  const duration = Date.now() - startTime;
  const hashrate = totalHashes / (duration / 1000); // hashes per second
  
  return {
    algorithm,
    totalHashes,
    validShares,
    duration,
    hashrate,
    difficulty
  };
}

// Execute benchmark and send results
runBenchmark()
  .then(result => {
    parentPort.postMessage(result);
  })
  .catch(error => {
    parentPort.postMessage({ error: error.message });
  });