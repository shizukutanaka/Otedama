/**
 * Distributed Processing Worker
 * Handles distributed computing tasks in a separate thread
 */

const { parentPort } = require('worker_threads');
const crypto = require('crypto');

// Message handler
parentPort.on('message', async (task) => {
  try {
    const result = await processTask(task);
    parentPort.postMessage({ success: true, result });
  } catch (error) {
    parentPort.postMessage({ success: false, error: error.message });
  }
});

async function processTask(task) {
  const startTime = Date.now();
  
  switch (task.type) {
    case 'mining_hash':
      return calculateMiningHash(task.data);
    case 'share_validation':
      return validateShares(task.data);
    case 'map':
      // For security, we should not execute arbitrary functions
      // Instead, implement specific map operations
      return executeMapOperation(task.data, task.operation);
    case 'reduce':
      // For security, we should not execute arbitrary functions
      // Instead, implement specific reduce operations
      return executeReduceOperation(task.data, task.operation);
    default:
      throw new Error('Unknown task type: ' + task.type);
  }
}

function calculateMiningHash(data) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(data));
  return hash.digest('hex');
}

function validateShares(shares) {
  return shares.filter(share => 
    share.difficulty > 0 && 
    share.nonce > 0 && 
    share.hash.length === 64
  );
}

// Implement specific, safe map operations
function executeMapOperation(data, operation) {
  switch (operation) {
    case 'hash_calculation':
      return data.map(item => ({
        ...item,
        hash: calculateMiningHash(item)
      }));
    
    case 'share_filtering':
      return data.filter(share => share.valid);
    
    case 'difficulty_mapping':
      return data.map(item => ({
        id: item.id,
        difficulty: item.difficulty
      }));
    
    default:
      throw new Error('Unknown map operation: ' + operation);
  }
}

// Implement specific, safe reduce operations  
function executeReduceOperation(data, operation) {
  switch (operation) {
    case 'sum':
      return data.reduce((acc, val) => acc + val, 0);
    
    case 'average':
      const sum = data.reduce((acc, val) => acc + val, 0);
      return sum / data.length;
    
    case 'max':
      return Math.max(...data);
    
    case 'min':
      return Math.min(...data);
    
    case 'count':
      return data.length;
    
    case 'hash_aggregation':
      return data.reduce((acc, item) => {
        acc[item.hash] = (acc[item.hash] || 0) + 1;
        return acc;
      }, {});
    
    default:
      throw new Error('Unknown reduce operation: ' + operation);
  }
}