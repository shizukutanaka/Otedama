#!/usr/bin/env node
/**
 * Quick Test Script for Otedama
 * Validate basic functionality
 * 
 * Design: Fast feedback (Pike principle)
 */

import { createStructuredLogger } from '../lib/core/structured-logger.js';
import { ShareValidator } from '../lib/mining/share-validator.js';
import { EnhancedZKPSystem } from '../lib/zkp/enhanced-zkp-system.js';
import { InputSanitizer } from '../lib/security/input-sanitizer.js';
import { cacheManager } from '../lib/core/cache-manager.js';
import { OptimizedWebSocketPool } from '../lib/network/websocket-pool-optimized.js';

const logger = createStructuredLogger('QuickTest');

/**
 * Test results
 */
const results = {
  passed: 0,
  failed: 0,
  tests: []
};

/**
 * Run test
 */
async function runTest(name, testFn) {
  try {
    logger.info(`Running test: ${name}`);
    const start = Date.now();
    
    await testFn();
    
    const duration = Date.now() - start;
    results.passed++;
    results.tests.push({ name, status: 'PASSED', duration });
    
    logger.info(`✓ ${name} (${duration}ms)`);
    
  } catch (error) {
    results.failed++;
    results.tests.push({ name, status: 'FAILED', error: error.message });
    
    logger.error(`✗ ${name}: ${error.message}`);
  }
}

/**
 * Test suite
 */
async function runTests() {
  logger.info('Starting Otedama quick tests...\n');
  
  // Test 1: Logger functionality
  await runTest('Logger System', async () => {
    const testLogger = createStructuredLogger('Test');
    testLogger.info('Test message');
    testLogger.warn('Warning test');
    testLogger.error('Error test');
  });
  
  // Test 2: Share Validator
  await runTest('Share Validator', async () => {
    const validator = new ShareValidator({
      algorithm: 'sha256',
      workerCount: 2
    });
    
    await validator.initialize();
    
    const testShare = {
      nonce: 12345,
      nTime: Date.now() / 1000,
      extraNonce1: 'abcd',
      extraNonce2: '1234',
      minerId: 'test-miner'
    };
    
    const testJob = {
      version: 1,
      previousblockhash: '00000000000000000000000000000000',
      coinbase1: '01000000010000000000000000',
      coinbase2: '00000000ffffffff',
      merklebranch: [],
      bits: '1d00ffff',
      height: 700000
    };
    
    const result = await validator.validateShare(
      testShare,
      testJob,
      16, // miner difficulty
      100000 // network difficulty
    );
    
    if (!result || result.valid === undefined) {
      throw new Error('Invalid validation result');
    }
    
    await validator.shutdown();
  });
  
  // Test 3: Cache Manager
  await runTest('Cache Manager', async () => {
    await cacheManager.initialize();
    
    // Test set/get
    await cacheManager.set('test-key', { value: 'test-data' });
    const cached = await cacheManager.get('test-key');
    
    if (!cached || cached.value !== 'test-data') {
      throw new Error('Cache get/set failed');
    }
    
    // Test delete
    await cacheManager.delete('test-key');
    const deleted = await cacheManager.get('test-key');
    
    if (deleted !== undefined) {
      throw new Error('Cache delete failed');
    }
  });
  
  // Test 4: Input Sanitizer
  await runTest('Input Sanitizer', async () => {
    const sanitizer = new InputSanitizer();
    
    // Test wallet validation
    const btcAddress = sanitizer.validateWalletAddress(
      '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      'BTC'
    );
    
    // Test worker name validation
    const workerName = sanitizer.validateWorkerName('test_worker-01');
    
    // Test SQL injection prevention
    try {
      sanitizer.sanitizeString('SELECT * FROM users; DROP TABLE users;--');
    } catch (error) {
      // Expected to throw
    }
    
    // Test number validation
    const num = sanitizer.validateNumber('123', { min: 0, max: 1000 });
    if (num !== 123) {
      throw new Error('Number validation failed');
    }
  });
  
  // Test 5: ZKP System (basic)
  await runTest('ZKP System', async () => {
    const zkp = new EnhancedZKPSystem();
    await zkp.initialize();
    
    // Create identity proof
    const proof = await zkp.createIdentityProof({
      age: 25,
      balance: 1000
    });
    
    if (!proof || !proof.id) {
      throw new Error('Failed to create ZKP proof');
    }
    
    // Verify proof
    const verification = await zkp.verifyIdentityProof(proof, {
      age: { min: 18 },
      balance: { min: 100 }
    });
    
    if (!verification || !verification.verified) {
      throw new Error('ZKP verification failed');
    }
    
    await zkp.shutdown();
  });
  
  // Test 6: WebSocket Pool
  await runTest('WebSocket Pool', async () => {
    const pool = new OptimizedWebSocketPool({
      maxConnections: 100
    });
    
    pool.start();
    
    // Test stats
    const stats = pool.getStats();
    if (stats.activeConnections !== 0) {
      throw new Error('Initial stats incorrect');
    }
    
    pool.shutdown();
  });
  
  // Summary
  logger.info('\n' + '='.repeat(50));
  logger.info('Test Summary:');
  logger.info(`Total Tests: ${results.passed + results.failed}`);
  logger.info(`Passed: ${results.passed}`);
  logger.info(`Failed: ${results.failed}`);
  
  if (results.failed > 0) {
    logger.error('\nFailed tests:');
    results.tests
      .filter(t => t.status === 'FAILED')
      .forEach(t => logger.error(`- ${t.name}: ${t.error}`));
  }
  
  logger.info('='.repeat(50));
  
  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  logger.error('Test runner failed:', error);
  process.exit(1);
});