// Test script for enhanced pool functionality
import { EnhancedMiningPoolCore } from '../src/core/enhanced-pool';
import { ShareValidator } from '../src/core/validator';
import { BlockchainClient } from '../src/core/blockchain';
import { Share } from '../src/domain/share';
import * as dotenv from 'dotenv';

dotenv.config();

async function testEnhancedPool() {
  console.log('Testing Enhanced Mining Pool Core...\n');
  
  // Initialize components
  const validator = new ShareValidator();
  const blockchain = new BlockchainClient(
    process.env.RPC_URL || 'http://localhost:8332',
    process.env.RPC_USER || 'user',
    process.env.RPC_PASSWORD || 'password'
  );
  
  const poolCore = new EnhancedMiningPoolCore(validator, blockchain, {
    enableParallelValidation: true,
    parallelWorkers: 2,
    dataDir: './test-data'
  });
  
  // Setup event handlers
  poolCore.on('share:accepted', (share) => {
    console.log('✅ Share accepted:', share.getHash().substring(0, 16) + '...');
  });
  
  poolCore.on('block:found', ({ height, reward }) => {
    console.log('🎉 Block found! Height:', height, 'Reward:', reward);
  });
  
  poolCore.on('error', (error) => {
    console.error('❌ Error:', error.message);
  });
  
  poolCore.on('recovered', (state) => {
    console.log('🔄 Recovered from state:', state);
  });
  
  // Test share submission
  console.log('Testing share submission...');
  
  // Create test shares
  const testShares = [];
  for (let i = 0; i < 5; i++) {
    const share = new Share();
    share.minerId = `test-miner-${i % 2}`;
    share.jobId = 'test-job-1';
    share.nonce = i;
    share.data = Buffer.from(`test-data-${i}`);
    share.difficulty = 1000;
    share.timestamp = Date.now();
    testShares.push(share);
  }
  
  // Submit shares
  for (const share of testShares) {
    const result = await poolCore.submitShare(share);
    console.log(`Share ${share.nonce} submitted:`, result);
    await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
  }
  
  // Test duplicate share
  console.log('\nTesting duplicate share detection...');
  const duplicateShare = testShares[0];
  const dupResult = await poolCore.submitShare(duplicateShare);
  console.log('Duplicate share submitted:', dupResult);
  
  // Get statistics
  console.log('\nPool Statistics:');
  const stats = await poolCore.getStats();
  console.log(JSON.stringify(stats, null, 2));
  
  // Allow some time for processing
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Stop the pool
  console.log('\nStopping pool...');
  await poolCore.stop();
  
  console.log('Test completed!');
}

// Run the test
testEnhancedPool().catch(console.error);
