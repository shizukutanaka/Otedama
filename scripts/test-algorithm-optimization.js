#!/usr/bin/env node
/**
 * Test Mining Algorithm Optimization
 * Validates the WASM and coordinator implementations
 * 
 * Design: Quick validation (Pike principle)
 */

import { createStructuredLogger } from '../lib/core/structured-logger.js';
import { SHA256Optimized } from '../lib/mining/algorithms/sha256.js';
import { WASMSHA256, wasmAlgorithmManager } from '../lib/mining/algorithms/wasm-algorithms.js';
import { AlgorithmCoordinator } from '../lib/mining/algorithm-coordinator.js';

const logger = createStructuredLogger('AlgorithmTest');

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
  logger.info('Starting algorithm optimization tests...\n');
  
  // Test 1: JavaScript SHA256
  await runTest('JavaScript SHA256', async () => {
    const sha256 = new SHA256Optimized();
    
    const result = await sha256.hash(
      Buffer.alloc(80),
      12345,
      Buffer.from('00000000ffff0000000000000000000000000000000000000000000000000000', 'hex')
    );
    
    if (!result || !result.hash) {
      throw new Error('Invalid result from SHA256');
    }
    
    logger.info(`JS SHA256 hash: ${result.hash.substring(0, 16)}...`);
  });
  
  // Test 2: WASM Manager
  await runTest('WASM Algorithm Manager', async () => {
    await wasmAlgorithmManager.initialize();
    
    const algorithms = wasmAlgorithmManager.getAvailableAlgorithms();
    logger.info(`Available WASM algorithms: ${algorithms.join(', ')}`);
    
    if (algorithms.length === 0) {
      throw new Error('No WASM algorithms available');
    }
  });
  
  // Test 3: WASM SHA256
  await runTest('WASM SHA256', async () => {
    const wasm = new WASMSHA256();
    await wasm.initialize();
    
    const result = await wasm.hash(
      Buffer.alloc(80),
      12345,
      Buffer.from('00000000ffff0000000000000000000000000000000000000000000000000000', 'hex')
    );
    
    if (!result || !result.hash) {
      throw new Error('Invalid result from WASM SHA256');
    }
    
    logger.info(`WASM SHA256 hash: ${result.hash.substring(0, 16)}...`);
  });
  
  // Test 4: Algorithm Coordinator
  await runTest('Algorithm Coordinator', async () => {
    const coordinator = new AlgorithmCoordinator({
      algorithm: 'sha256',
      autoOptimize: false
    });
    
    await coordinator.initialize();
    
    const stats = coordinator.getStats();
    logger.info(`Coordinator algorithm: ${stats.algorithm}`);
    logger.info(`Current implementation: ${stats.current}`);
    logger.info(`Available implementations: ${Object.keys(stats.implementations).length}`);
    
    if (!stats.current) {
      throw new Error('No implementation selected');
    }
  });
  
  // Test 5: Performance Comparison
  await runTest('Performance Comparison', async () => {
    const iterations = 1000;
    const testHeader = Buffer.alloc(80);
    const testTarget = Buffer.from('00000000ffff0000000000000000000000000000000000000000000000000000', 'hex');
    
    // Test JavaScript
    const js = new SHA256Optimized();
    const jsStart = Date.now();
    
    for (let i = 0; i < iterations; i++) {
      await js.hash(testHeader, i, testTarget);
    }
    
    const jsTime = Date.now() - jsStart;
    const jsHashRate = (iterations / jsTime) * 1000;
    
    // Test WASM
    const wasm = new WASMSHA256();
    await wasm.initialize();
    const wasmStart = Date.now();
    
    for (let i = 0; i < iterations; i++) {
      await wasm.hash(testHeader, i, testTarget);
    }
    
    const wasmTime = Date.now() - wasmStart;
    const wasmHashRate = (iterations / wasmTime) * 1000;
    
    logger.info(`JavaScript: ${jsHashRate.toFixed(2)} H/s (${jsTime}ms)`);
    logger.info(`WASM: ${wasmHashRate.toFixed(2)} H/s (${wasmTime}ms)`);
    
    const improvement = ((wasmHashRate - jsHashRate) / jsHashRate * 100).toFixed(2);
    logger.info(`WASM improvement: ${improvement}%`);
  });
  
  // Test 6: Batch Processing
  await runTest('Batch Processing', async () => {
    const wasm = new WASMSHA256();
    await wasm.initialize();
    
    const results = await wasm.batchHash(
      Buffer.alloc(80),
      0,
      100,
      Buffer.from('00000000ffff0000000000000000000000000000000000000000000000000000', 'hex')
    );
    
    logger.info(`Batch processed 100 hashes, found ${results.length} valid shares`);
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