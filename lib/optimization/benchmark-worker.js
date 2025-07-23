const { parentPort } = require('worker_threads');
const crypto = require('crypto');

// Algorithm implementations for benchmarking
const algorithms = {
  SHA256: {
    hash: (data) => crypto.createHash('sha256').update(data).digest()
  },
  Scrypt: {
    hash: (data) => crypto.scryptSync(data, 'salt', 32, { N: 1024, r: 1, p: 1 })
  },
  // Simplified implementations for benchmarking
  Ethash: {
    hash: (data) => {
      // Simplified Ethash-like operation
      let result = data;
      for (let i = 0; i < 64; i++) {
        result = crypto.createHash('sha3-256').update(result).digest();
      }
      return result;
    }
  },
  RandomX: {
    hash: (data) => {
      // Simplified RandomX-like operation
      let result = data;
      for (let i = 0; i < 8; i++) {
        const key = crypto.randomBytes(32);
        result = crypto.createHmac('sha256', key).update(result).digest();
      }
      return result;
    }
  },
  KawPow: {
    hash: (data) => {
      // Simplified KawPow-like operation
      let result = data;
      for (let i = 0; i < 32; i++) {
        result = crypto.createHash('sha3-512').update(result).digest();
      }
      return result;
    }
  }
};

let benchmarkRunning = false;
let totalHashes = 0;
let startTime = 0;

parentPort.on('message', (message) => {
  if (message.type === 'benchmark') {
    runBenchmark(message.algorithm, message.parameters, message.duration);
  } else if (message.type === 'stop') {
    benchmarkRunning = false;
  }
});

function runBenchmark(algorithmName, parameters, duration) {
  const algorithm = algorithms[algorithmName];
  
  if (!algorithm) {
    parentPort.postMessage({
      type: 'error',
      error: `Unknown algorithm: ${algorithmName}`
    });
    return;
  }
  
  benchmarkRunning = true;
  totalHashes = 0;
  startTime = Date.now();
  
  const nonce = Buffer.allocUnsafe(32);
  const updateInterval = 1000; // Update every second
  let lastUpdate = startTime;
  
  while (benchmarkRunning && (Date.now() - startTime) < duration) {
    // Generate random nonce
    crypto.randomFillSync(nonce);
    
    // Perform hash
    try {
      algorithm.hash(nonce);
      totalHashes++;
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        error: error.message
      });
      benchmarkRunning = false;
      break;
    }
    
    // Send progress updates
    const now = Date.now();
    if (now - lastUpdate >= updateInterval) {
      const elapsed = (now - startTime) / 1000;
      const hashrate = totalHashes / elapsed;
      
      parentPort.postMessage({
        type: 'progress',
        hashes: totalHashes,
        hashrate,
        elapsed
      });
      
      lastUpdate = now;
    }
  }
  
  // Send final results
  parentPort.postMessage({
    type: 'complete',
    totalHashes,
    duration: Date.now() - startTime
  });
}

// Handle cleanup
process.on('exit', () => {
  benchmarkRunning = false;
});