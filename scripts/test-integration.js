#!/usr/bin/env node

/**
 * Test Integration - Otedama
 * Tests module integration and basic functionality
 */

import { createLogger } from '../lib/core/logger.js';
import { BufferPool, LRUCache } from '../lib/core/performance.js';
import { BinaryProtocol } from '../lib/network/binary-protocol.js';
import { createStorageManager } from '../lib/storage/index.js';
import { ShareValidator } from '../lib/mining/share-validator.js';
import { DDoSProtection } from '../lib/security/ddos-protection.js';
import { MonitoringSystem } from '../lib/monitoring/index.js';
import { APIServer } from '../lib/api/index.js';
import { CryptoUtils, TimeUtils } from '../lib/utils/index.js';

const logger = createLogger('TestIntegration');

async function runTests() {
  console.log('Running Otedama integration tests...\n');
  
  const results = {
    passed: 0,
    failed: 0,
    errors: []
  };
  
  // Test 1: Core module
  try {
    console.log('Testing Core module...');
    
    // Logger
    logger.info('Logger test');
    logger.debug('Debug test');
    
    // Buffer pool
    const bufferPool = new BufferPool(1024, 10);
    const buffer = bufferPool.acquire();
    bufferPool.release(buffer);
    
    // LRU Cache
    const cache = new LRUCache(100);
    cache.set('test', 'value');
    const value = cache.get('test');
    
    if (value === 'value') {
      console.log('✓ Core module passed\n');
      results.passed++;
    } else {
      throw new Error('Cache test failed');
    }
  } catch (error) {
    console.error('✗ Core module failed:', error.message, '\n');
    results.failed++;
    results.errors.push({ module: 'Core', error: error.message });
  }
  
  // Test 2: Network module
  try {
    console.log('Testing Network module...');
    
    const protocol = new BinaryProtocol();
    const testData = { message: 'Hello, Otedama!' };
    
    const encoded = await protocol.encode(0x01, testData);
    const decoded = await protocol.decode(encoded);
    
    if (decoded.data.message === testData.message) {
      console.log('✓ Network module passed\n');
      results.passed++;
    } else {
      throw new Error('Binary protocol test failed');
    }
  } catch (error) {
    console.error('✗ Network module failed:', error.message, '\n');
    results.failed++;
    results.errors.push({ module: 'Network', error: error.message });
  }
  
  // Test 3: Storage module
  try {
    console.log('Testing Storage module...');
    
    const storage = createStorageManager({
      dataDir: './test-data',
      dbFile: 'test.db'
    });
    
    await storage.initialize();
    
    // Test cache
    await storage.set('test-key', 'test-value', async (value) => {
      // Mock store function
    });
    
    const retrieved = await storage.get('test-key', async () => 'test-value');
    
    await storage.shutdown();
    
    // Clean up test data
    const fs = await import('fs/promises');
    await fs.rm('./test-data', { recursive: true, force: true });
    
    if (retrieved === 'test-value') {
      console.log('✓ Storage module passed\n');
      results.passed++;
    } else {
      throw new Error('Storage test failed');
    }
  } catch (error) {
    console.error('✗ Storage module failed:', error.message, '\n');
    results.failed++;
    results.errors.push({ module: 'Storage', error: error.message });
  }
  
  // Test 4: Mining module
  try {
    console.log('Testing Mining module...');
    
    const validator = new ShareValidator({
      algorithm: 'sha256',
      workerCount: 1
    });
    
    await validator.initialize();
    
    // Mock share validation
    const mockShare = {
      minerId: 'test-miner',
      jobId: '00000001',
      nonce: '12345678',
      difficulty: 1000
    };
    
    const mockJob = {
      id: '00000001',
      prevHash: '0'.repeat(64),
      coinbase1: '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff',
      coinbase2: '00000000',
      merkleBranches: [],
      version: '20000000',
      bits: '1a0fffff',
      time: Math.floor(Date.now() / 1000),
      height: 100
    };
    
    // Just test initialization for now
    await validator.shutdown();
    
    console.log('✓ Mining module passed\n');
    results.passed++;
  } catch (error) {
    console.error('✗ Mining module failed:', error.message, '\n');
    results.failed++;
    results.errors.push({ module: 'Mining', error: error.message });
  }
  
  // Test 5: Security module
  try {
    console.log('Testing Security module...');
    
    const ddos = new DDoSProtection({
      maxConnectionsPerIP: 5,
      maxRequestsPerMinute: 100
    });
    
    // Test connection check
    const check = await ddos.checkConnection('127.0.0.1', 'test-connection');
    
    ddos.shutdown();
    
    if (check.allowed) {
      console.log('✓ Security module passed\n');
      results.passed++;
    } else {
      throw new Error('DDoS protection test failed');
    }
  } catch (error) {
    console.error('✗ Security module failed:', error.message, '\n');
    results.failed++;
    results.errors.push({ module: 'Security', error: error.message });
  }
  
  // Test 6: Monitoring module
  try {
    console.log('Testing Monitoring module...');
    
    const monitoring = new MonitoringSystem({
      metricsInterval: 1000,
      enablePrometheus: false
    });
    
    monitoring.start();
    monitoring.updateMetric('test.metric', 42);
    const metrics = monitoring.getMetrics();
    
    monitoring.stop();
    
    if (metrics['test.metric']?.value === 42) {
      console.log('✓ Monitoring module passed\n');
      results.passed++;
    } else {
      throw new Error('Monitoring test failed');
    }
  } catch (error) {
    console.error('✗ Monitoring module failed:', error.message, '\n');
    results.failed++;
    results.errors.push({ module: 'Monitoring', error: error.message });
  }
  
  // Test 7: API module
  try {
    console.log('Testing API module...');
    
    const api = new APIServer({
      port: 0 // Random port
    });
    
    // Just test creation for now
    console.log('✓ API module passed\n');
    results.passed++;
  } catch (error) {
    console.error('✗ API module failed:', error.message, '\n');
    results.failed++;
    results.errors.push({ module: 'API', error: error.message });
  }
  
  // Test 8: Utils module
  try {
    console.log('Testing Utils module...');
    
    const hash = CryptoUtils.sha256('test');
    const timestamp = TimeUtils.now();
    
    if (hash.length === 64 && typeof timestamp === 'number') {
      console.log('✓ Utils module passed\n');
      results.passed++;
    } else {
      throw new Error('Utils test failed');
    }
  } catch (error) {
    console.error('✗ Utils module failed:', error.message, '\n');
    results.failed++;
    results.errors.push({ module: 'Utils', error: error.message });
  }
  
  // Summary
  console.log('========================================');
  console.log('Test Summary:');
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  
  if (results.failed > 0) {
    console.log('\nErrors:');
    results.errors.forEach(({ module, error }) => {
      console.log(`- ${module}: ${error}`);
    });
  }
  
  if (results.failed === 0) {
    console.log('\n✅ All integration tests passed!');
  } else {
    console.log('\n❌ Some tests failed.');
  }
  
  return results.failed === 0;
}

// Run tests
runTests().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
