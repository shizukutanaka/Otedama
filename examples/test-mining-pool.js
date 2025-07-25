/**
 * Mining Pool Test Script - Otedama
 * Simple test to verify mining pool functionality
 */

import { getMiningPool, MiningAlgorithm, PaymentScheme } from './lib/mining/index.js';
import { createLogger } from './lib/core/logger.js';

const logger = createLogger('MiningPoolTest');

async function testMiningPool() {
  logger.info('Starting mining pool test...');
  
  try {
    // Create pool instance
    const pool = getMiningPool({
      poolName: 'Test Pool',
      port: 3334,
      algorithm: MiningAlgorithm.SHA256,
      paymentScheme: PaymentScheme.PPLNS,
      p2pEnabled: false, // Disable P2P for simple test
      shareValidationWorkers: 2
    });
    
    // Start pool
    logger.info('Starting pool...');
    await pool.start();
    
    // Simulate miner connection
    logger.info('Simulating miner connection...');
    const minerId = 'test-miner-001';
    
    pool.minerManager.registerMiner({
      id: minerId,
      address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      ip: '127.0.0.1',
      worker: 'test-worker'
    });
    
    // Simulate share submission
    logger.info('Simulating share submission...');
    pool.minerManager.recordShare(minerId, {
      workerName: 'test-worker',
      difficulty: 1000,
      isValid: true
    });
    
    // Get statistics
    const stats = pool.getStats();
    logger.info('Pool statistics:', stats);
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Stop pool
    logger.info('Stopping pool...');
    await pool.stop();
    
    logger.info('Test completed successfully!');
    
  } catch (error) {
    logger.error('Test failed:', error);
    process.exit(1);
  }
}

// Run test
testMiningPool().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});