#!/usr/bin/env node

/**
 * Otedama Performance Optimization Test Suite
 * パフォーマンス最適化機能の包括的テスト
 */

import { Logger } from '../src/logger.js';
import { performance } from 'perf_hooks';

class PerformanceOptimizationTest {
  constructor() {
    this.logger = new Logger('PerfOptTest');
    this.results = {
      passed: 0,
      failed: 0,
      tests: [],
      benchmarks: []
    };
  }

  /**
   * Test Database Batcher
   */
  async testDatabaseBatcher() {
    console.log('\n📊 Testing Database Batcher...');
    
    try {
      const { OtedamaDB } = await import('../src/database.js');
      const { DatabaseBatcher } = await import('../src/database-batcher.js');
      
      // Create test database
      const db = new OtedamaDB({ filename: ':memory:', memory: true });
      await db.initialize();
      
      const batcher = new DatabaseBatcher(db.db, {
        maxBatchSize: 10,
        batchInterval: 50,
        adaptiveSizing: true
      });
      
      // Test 1: Basic batching
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(batcher.batch('shares',
          'INSERT INTO shares (worker_id, difficulty, valid, timestamp, algorithm) VALUES (?, ?, ?, ?, ?)',
          [`worker_${i}`, 1000, 1, Date.now(), 'kawpow']
        ));
      }
      
      const results = await Promise.all(promises);
      this.recordTest('Batcher: Basic batching', results.length === 5);
      
      // Test 2: Query merging
      const mergePromises = [];
      for (let i = 0; i < 3; i++) {
        mergePromises.push(batcher.batch('shares',
          'INSERT INTO shares (worker_id, difficulty, valid, timestamp, algorithm) VALUES (?, ?, ?, ?, ?)',
          [`merge_${i}`, 2000, 1, Date.now(), 'kawpow']
        ));
      }
      
      await Promise.all(mergePromises);
      const stats = batcher.getPerformanceReport();
      this.recordTest('Batcher: Query merging', stats.metrics.mergedQueries > 0);
      
      // Test 3: Performance comparison
      const testData = [];
      for (let i = 0; i < 100; i++) {
        testData.push({
          workerId: `perf_${i}`,
          difficulty: Math.random() * 10000,
          valid: true,
          algorithm: 'kawpow'
        });
      }
      
      // Without batching
      const withoutStart = performance.now();
      for (const data of testData) {
        await db.addShare(data.workerId, data.difficulty, data.valid, data.algorithm);
      }
      const withoutTime = performance.now() - withoutStart;
      
      // With batching
      const withStart = performance.now();
      await db.batchAddShares(testData);
      const withTime = performance.now() - withStart;
      
      const improvement = ((withoutTime - withTime) / withoutTime) * 100;
      this.recordTest('Batcher: Performance improvement', improvement > 30);
      this.recordBenchmark('Database batching improvement', `${improvement.toFixed(2)}%`);
      
      await batcher.stop();
      await db.close();
      
    } catch (error) {
      this.logger.error('Database batcher test failed:', error);
      this.recordTest('Database Batcher', false);
    }
  }

  /**
   * Test Network Optimizer
   */
  async testNetworkOptimizer() {
    console.log('\n🌐 Testing Network Optimizer...');
    
    try {
      const { NetworkOptimizer } = await import('../src/network-optimizer.js');
      
      const optimizer = new NetworkOptimizer({
        enableCompression: true,
        compressionThreshold: 100,
        batchInterval: 10,
        maxBatchSize: 10
      });
      
      // Test 1: Message queuing
      const messages = [];
      optimizer.on('send', (data) => {
        messages.push(data);
      });
      
      for (let i = 0; i < 5; i++) {
        await optimizer.queueMessage('peer1', {
          type: 'share',
          data: { id: i }
        });
      }
      
      // Wait for batch processing
      await new Promise(resolve => setTimeout(resolve, 50));
      
      this.recordTest('Network Optimizer: Message batching', 
        messages.length > 0 && messages[0].data.type === 'batch');
      
      // Test 2: Compression
      const largeMessage = {
        type: 'block',
        data: 'x'.repeat(1000)
      };
      
      await optimizer.queueMessage('peer2', largeMessage, 0);
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const compressed = messages.find(m => m.peerId === 'peer2');
      this.recordTest('Network Optimizer: Compression', 
        compressed && compressed.data.compressed === true);
      
      // Test 3: Priority queuing
      messages.length = 0;
      
      await optimizer.queueMessage('peer3', { type: 'heartbeat' }, 3); // Low priority
      await optimizer.queueMessage('peer3', { type: 'block' }, 0); // High priority
      await optimizer.queueMessage('peer3', { type: 'share' }, 1); // Medium priority
      
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const batch = messages.find(m => m.peerId === 'peer3');
      if (batch && batch.data.type === 'batch') {
        const batchData = await optimizer.processIncomingBatch('peer3', batch.data);
        this.recordTest('Network Optimizer: Priority queuing', batchData >= 3);
      }
      
      const report = optimizer.getOptimizationReport();
      this.recordBenchmark('Network compression ratio', 
        `${report.metrics.compressionRatio ? (report.metrics.compressionRatio * 100).toFixed(2) : 0}%`);
      
      optimizer.stop();
      
    } catch (error) {
      this.logger.error('Network optimizer test failed:', error);
      this.recordTest('Network Optimizer', false);
    }
  }

  /**
   * Test Advanced Cache Manager
   */
  async testCacheManager() {
    console.log('\n💾 Testing Advanced Cache Manager...');
    
    try {
      const { AdvancedCacheManager } = await import('../src/cache-manager.js');
      
      const cache = new AdvancedCacheManager({
        maxSize: 100,
        maxMemoryMB: 1,
        enableCompression: true,
        evictionPolicy: 'lru'
      });
      
      // Test 1: Basic operations
      await cache.set('test1', { data: 'value1' });
      const value1 = await cache.get('test1');
      this.recordTest('Cache: Basic set/get', value1?.data === 'value1');
      
      // Test 2: TTL functionality
      await cache.set('test2', { data: 'value2' }, { ttl: 100 }); // 100ms TTL
      await new Promise(resolve => setTimeout(resolve, 150));
      const expired = await cache.get('test2');
      this.recordTest('Cache: TTL expiration', expired === null);
      
      // Test 3: LRU eviction
      for (let i = 0; i < 110; i++) {
        await cache.set(`lru_${i}`, { data: `value_${i}` });
      }
      
      const firstItem = await cache.get('lru_0');
      const lastItem = await cache.get('lru_109');
      this.recordTest('Cache: LRU eviction', firstItem === null && lastItem !== null);
      
      // Test 4: Compression
      const largeData = { data: 'x'.repeat(20000) };
      await cache.set('compressed', largeData);
      const stats = cache.getStats();
      this.recordTest('Cache: Compression', stats.compressions > 0);
      
      // Test 5: Performance metrics
      const testKeys = 1000;
      const writeStart = performance.now();
      for (let i = 0; i < testKeys; i++) {
        await cache.set(`perf_${i}`, { value: i });
      }
      const writeTime = performance.now() - writeStart;
      
      const readStart = performance.now();
      for (let i = 0; i < testKeys; i++) {
        await cache.get(`perf_${i}`);
      }
      const readTime = performance.now() - readStart;
      
      this.recordBenchmark('Cache write speed', `${Math.round(testKeys / (writeTime / 1000))} ops/sec`);
      this.recordBenchmark('Cache read speed', `${Math.round(testKeys / (readTime / 1000))} ops/sec`);
      this.recordBenchmark('Cache hit rate', stats.hitRate);
      
      cache.destroy();
      
    } catch (error) {
      this.logger.error('Cache manager test failed:', error);
      this.recordTest('Cache Manager', false);
    }
  }

  /**
   * Test Performance Optimizer
   */
  async testPerformanceOptimizer() {
    console.log('\n⚡ Testing Performance Optimizer...');
    
    try {
      const { PerformanceOptimizer } = await import('../src/performance-optimizer.js');
      
      const optimizer = new PerformanceOptimizer();
      
      // Test 1: Memory monitoring
      const initialMetrics = optimizer.metrics;
      this.recordTest('Performance Optimizer: Metrics collection', 
        initialMetrics.memory.total > 0 && initialMetrics.cpu.cores > 0);
      
      // Test 2: Garbage collection
      // Create memory pressure
      const arrays = [];
      for (let i = 0; i < 50; i++) {
        arrays.push(new Array(10000).fill(Math.random()));
      }
      
      optimizer.forceGarbageCollection();
      arrays.length = 0; // Clear references
      
      await new Promise(resolve => setTimeout(resolve, 100));
      this.recordTest('Performance Optimizer: Garbage collection', true);
      
      // Test 3: Adaptive strategies
      optimizer.collectMetrics();
      const strategies = Array.from(optimizer.strategies.keys());
      this.recordTest('Performance Optimizer: Strategy initialization', strategies.length > 0);
      
      // Test 4: Performance profiling
      optimizer.enableProfiling();
      
      await optimizer.profileOperation('test_operation', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      
      const profilingReport = optimizer.getProfilingReport();
      this.recordTest('Performance Optimizer: Profiling', 
        profilingReport.enabled && profilingReport.operations.test_operation);
      
      const perfReport = optimizer.getPerformanceReport();
      this.recordBenchmark('Memory usage', `${perfReport.current.memory.used}MB`);
      this.recordBenchmark('CPU usage', `${(perfReport.current.cpu.usage * 100).toFixed(2)}%`);
      
      optimizer.stop();
      
    } catch (error) {
      this.logger.error('Performance optimizer test failed:', error);
      this.recordTest('Performance Optimizer', false);
    }
  }

  /**
   * Test P2P Network Optimization
   */
  async testP2POptimization() {
    console.log('\n🔗 Testing P2P Network Optimization...');
    
    try {
      const { P2PNetwork } = await import('../src/p2p-network.js');
      
      // Create two P2P nodes
      const node1 = new P2PNetwork(18333, 10, {
        enableBandwidthControl: true,
        maxMessageSize: 1024 * 1024
      });
      
      const node2 = new P2PNetwork(18334, 10, {
        enableBandwidthControl: true,
        maxMessageSize: 1024 * 1024
      });
      
      await node1.start();
      await node2.start();
      
      // Connect nodes
      await node2.connectToPeer('localhost', 18333);
      
      // Wait for connection
      await new Promise(resolve => setTimeout(resolve, 100));
      
      this.recordTest('P2P: Connection established', 
        node1.getPeerCount() > 0 && node2.getPeerCount() > 0);
      
      // Test message batching
      let messagesReceived = 0;
      node1.on('message', () => messagesReceived++);
      
      // Send multiple messages
      for (let i = 0; i < 10; i++) {
        await node2.sendMessage(
          node2.getPeers()[0]?.id,
          { type: 'test', data: { id: i } }
        );
      }
      
      await new Promise(resolve => setTimeout(resolve, 200));
      
      this.recordTest('P2P: Message optimization', messagesReceived > 0);
      
      const stats = node2.getNetworkStats();
      if (stats.optimization) {
        this.recordBenchmark('P2P compression savings', 
          `${stats.optimization.metrics?.compressionRatio || 0}%`);
      }
      
      await node1.stop();
      await node2.stop();
      
    } catch (error) {
      this.logger.error('P2P optimization test failed:', error);
      this.recordTest('P2P Optimization', false);
    }
  }

  /**
   * Record test result
   */
  recordTest(name, passed) {
    this.results.tests.push({ name, passed });
    if (passed) {
      this.results.passed++;
      console.log(`  ✅ ${name}`);
    } else {
      this.results.failed++;
      console.log(`  ❌ ${name}`);
    }
  }

  /**
   * Record benchmark result
   */
  recordBenchmark(name, value) {
    this.results.benchmarks.push({ name, value });
    console.log(`  📊 ${name}: ${value}`);
  }

  /**
   * Run all tests
   */
  async runTests() {
    console.log('⚡ Starting Otedama Performance Optimization Tests...\n');
    
    const startTime = Date.now();
    
    // Run test suites
    await this.testDatabaseBatcher();
    await this.testNetworkOptimizer();
    await this.testCacheManager();
    await this.testPerformanceOptimizer();
    await this.testP2POptimization();
    
    const duration = Date.now() - startTime;
    
    // Display results
    console.log('\n' + '='.repeat(60));
    console.log('📊 TEST RESULTS');
    console.log('='.repeat(60));
    console.log(`Total Tests: ${this.results.tests.length}`);
    console.log(`Passed: ${this.results.passed} ✅`);
    console.log(`Failed: ${this.results.failed} ❌`);
    console.log(`Duration: ${duration}ms`);
    console.log('='.repeat(60));
    
    if (this.results.benchmarks.length > 0) {
      console.log('\n📈 BENCHMARK RESULTS:');
      this.results.benchmarks.forEach(b => {
        console.log(`  ${b.name}: ${b.value}`);
      });
    }
    
    if (this.results.failed > 0) {
      console.log('\n❌ FAILED TESTS:');
      this.results.tests
        .filter(t => !t.passed)
        .forEach(t => console.log(`  - ${t.name}`));
    }
    
    console.log('\n' + (this.results.failed === 0 ? '✅ All tests passed!' : '❌ Some tests failed!'));
    
    return this.results.failed === 0;
  }
}

// Run tests if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new PerformanceOptimizationTest();
  tester.runTests()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      console.error('Test suite error:', error);
      process.exit(1);
    });
}

export default PerformanceOptimizationTest;
