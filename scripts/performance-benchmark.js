#!/usr/bin/env node

/**
 * Otedama Advanced Performance Benchmark Suite
 * 最適化機能の効果を測定する包括的ベンチマーク
 * 
 * John Carmack Style: Precise performance measurement
 * Rob Pike Style: Simple, focused benchmarks
 * Robert C. Martin Style: Clean, modular test structure
 */

import { performance } from 'perf_hooks';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class AdvancedPerformanceBenchmark extends EventEmitter {
  constructor() {
    super();
    this.results = {
      system: this.getSystemInfo(),
      benchmarks: [],
      optimizationImpact: {},
      timestamp: new Date().toISOString()
    };
    
    this.config = {
      warmupRuns: 3,
      testRuns: 10,
      sampleSize: 1000
    };
  }

  getSystemInfo() {
    const cpus = os.cpus();
    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cpu: {
        model: cpus[0].model,
        cores: cpus.length,
        speed: cpus[0].speed
      },
      memory: {
        totalMB: Math.round(os.totalmem() / 1024 / 1024),
        freeMB: Math.round(os.freemem() / 1024 / 1024)
      },
      load: os.loadavg()
    };
  }

  measureMemory() {
    if (global.gc) global.gc();
    const usage = process.memoryUsage();
    return {
      heapUsedMB: usage.heapUsed / 1024 / 1024,
      heapTotalMB: usage.heapTotal / 1024 / 1024,
      externalMB: usage.external / 1024 / 1024,
      rssMB: usage.rss / 1024 / 1024
    };
  }

  async measureTime(fn, name = 'operation') {
    const measurements = [];
    
    // Warmup
    for (let i = 0; i < this.config.warmupRuns; i++) {
      await fn();
    }
    
    // Actual measurements
    for (let i = 0; i < this.config.testRuns; i++) {
      const start = performance.now();
      await fn();
      const end = performance.now();
      measurements.push(end - start);
    }
    
    // Calculate statistics
    const sorted = measurements.sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const median = sorted[Math.floor(sorted.length / 2)];
    const avg = measurements.reduce((sum, val) => sum + val, 0) / measurements.length;
    const stdDev = Math.sqrt(
      measurements.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / measurements.length
    );
    
    return {
      name,
      measurements,
      min,
      max,
      median,
      avg,
      stdDev,
      runs: this.config.testRuns
    };
  }

  /**
   * Test database batching performance
   */
  async benchmarkDatabaseBatching() {
    console.log('\n📊 Testing Database Batching Performance...');
    
    try {
      // Import database modules
      const { OtedamaDB } = await import('../src/database.js');
      
      // Create test database
      const db = new OtedamaDB({ 
        filename: ':memory:', 
        memory: true 
      });
      await db.initialize();
      
      const shares = [];
      for (let i = 0; i < this.config.sampleSize; i++) {
        shares.push({
          workerId: `worker_${i % 10}`,
          difficulty: Math.random() * 1000000,
          valid: Math.random() > 0.1,
          algorithm: 'kawpow'
        });
      }
      
      // Test without batching
      const withoutBatching = await this.measureTime(async () => {
        for (const share of shares) {
          await db.addShare(share.workerId, share.difficulty, share.valid, share.algorithm);
        }
      }, 'Without Batching');
      
      // Clear database
      await db.exec('DELETE FROM shares');
      
      // Test with batching
      const withBatching = await this.measureTime(async () => {
        await db.batchAddShares(shares);
      }, 'With Batching');
      
      // Calculate improvement
      const improvement = ((withoutBatching.avg - withBatching.avg) / withoutBatching.avg) * 100;
      
      await db.close();
      
      return {
        test: 'Database Batching',
        withoutBatching: {
          avgMs: withoutBatching.avg.toFixed(2),
          opsPerSec: Math.round(this.config.sampleSize / (withoutBatching.avg / 1000))
        },
        withBatching: {
          avgMs: withBatching.avg.toFixed(2),
          opsPerSec: Math.round(this.config.sampleSize / (withBatching.avg / 1000))
        },
        improvement: improvement.toFixed(2) + '%'
      };
      
    } catch (error) {
      console.error('Database batching test failed:', error);
      return { test: 'Database Batching', error: error.message };
    }
  }

  /**
   * Test network optimization performance
   */
  async benchmarkNetworkOptimization() {
    console.log('\n📊 Testing Network Optimization Performance...');
    
    try {
      const NetworkOptimizer = (await import('../src/network-optimizer.js')).default;
      
      const optimizer = new NetworkOptimizer({
        enableCompression: true,
        batchInterval: 10,
        maxBatchSize: 50
      });
      
      // Generate test messages
      const messages = [];
      for (let i = 0; i < this.config.sampleSize; i++) {
        messages.push({
          type: ['share', 'heartbeat', 'peer_list'][i % 3],
          data: {
            id: i,
            timestamp: Date.now(),
            payload: 'x'.repeat(Math.floor(Math.random() * 1000))
          }
        });
      }
      
      const peerId = 'test_peer';
      let sentMessages = [];
      
      // Setup listener
      optimizer.on('send', (data) => {
        sentMessages.push(data);
      });
      
      // Test without optimization (direct send)
      const withoutOptimization = await this.measureTime(async () => {
        sentMessages = [];
        for (const msg of messages) {
          sentMessages.push({ peerId, data: JSON.stringify(msg) });
        }
      }, 'Without Optimization');
      
      const bytesWithout = sentMessages.reduce((sum, m) => sum + m.data.length, 0);
      
      // Test with optimization
      sentMessages = [];
      const withOptimization = await this.measureTime(async () => {
        for (const msg of messages) {
          await optimizer.queueMessage(peerId, msg);
        }
        // Wait for batch processing
        await new Promise(resolve => setTimeout(resolve, 100));
      }, 'With Optimization');
      
      const bytesWithOpt = sentMessages.reduce((sum, m) => sum + m.data.size || m.data.length, 0);
      
      optimizer.stop();
      
      const compressionRatio = bytesWithout > 0 ? (1 - bytesWithOpt / bytesWithout) * 100 : 0;
      
      return {
        test: 'Network Optimization',
        withoutOptimization: {
          avgMs: withoutOptimization.avg.toFixed(2),
          totalBytes: bytesWithout,
          messages: messages.length
        },
        withOptimization: {
          avgMs: withOptimization.avg.toFixed(2),
          totalBytes: bytesWithOpt,
          batches: sentMessages.length
        },
        compressionRatio: compressionRatio.toFixed(2) + '%',
        batchingRatio: messages.length / sentMessages.length
      };
      
    } catch (error) {
      console.error('Network optimization test failed:', error);
      return { test: 'Network Optimization', error: error.message };
    }
  }

  /**
   * Test cache performance
   */
  async benchmarkCachePerformance() {
    console.log('\n📊 Testing Cache Performance...');
    
    try {
      const { AdvancedCacheManager } = await import('../src/cache-manager.js');
      
      const cache = new AdvancedCacheManager({
        maxSize: 1000,
        maxMemoryMB: 10,
        enableCompression: true
      });
      
      // Generate test data
      const testData = {};
      for (let i = 0; i < this.config.sampleSize; i++) {
        testData[`key_${i}`] = {
          id: i,
          data: 'x'.repeat(Math.floor(Math.random() * 10000)),
          timestamp: Date.now()
        };
      }
      
      // Test write performance
      const writePerf = await this.measureTime(async () => {
        for (const [key, value] of Object.entries(testData)) {
          await cache.set(key, value);
        }
      }, 'Cache Write');
      
      // Test read performance (with hits)
      const readHits = await this.measureTime(async () => {
        for (const key of Object.keys(testData)) {
          await cache.get(key);
        }
      }, 'Cache Read (Hits)');
      
      // Test read performance (with misses)
      const readMisses = await this.measureTime(async () => {
        for (let i = 0; i < this.config.sampleSize; i++) {
          await cache.get(`missing_key_${i}`);
        }
      }, 'Cache Read (Misses)');
      
      const stats = cache.getStats();
      cache.destroy();
      
      return {
        test: 'Cache Performance',
        write: {
          avgMs: writePerf.avg.toFixed(2),
          opsPerSec: Math.round(this.config.sampleSize / (writePerf.avg / 1000))
        },
        readHits: {
          avgMs: readHits.avg.toFixed(2),
          opsPerSec: Math.round(this.config.sampleSize / (readHits.avg / 1000))
        },
        readMisses: {
          avgMs: readMisses.avg.toFixed(2),
          opsPerSec: Math.round(this.config.sampleSize / (readMisses.avg / 1000))
        },
        stats: {
          hitRate: stats.hitRate,
          compressions: stats.compressions,
          memoryUsageMB: stats.memoryUsageMB
        }
      };
      
    } catch (error) {
      console.error('Cache performance test failed:', error);
      return { test: 'Cache Performance', error: error.message };
    }
  }

  /**
   * Test mining hashrate
   */
  async benchmarkHashrate(algorithm = 'sha256', duration = 5000) {
    console.log(`\n📊 Testing ${algorithm} Hashrate...`);
    
    const startMem = this.measureMemory();
    const startTime = performance.now();
    
    const workerCode = `
      const { parentPort, workerData } = require('worker_threads');
      const crypto = require('crypto');
      
      const { algorithm, duration } = workerData;
      let hashes = 0;
      const startTime = Date.now();
      
      while (Date.now() - startTime < duration) {
        const nonce = Math.random().toString();
        const data = Buffer.from('test_block_header_' + nonce);
        crypto.createHash(algorithm).update(data).digest();
        hashes++;
      }
      
      parentPort.postMessage({ hashes });
    `;
    
    const threadCount = os.cpus().length;
    const workers = [];
    
    for (let i = 0; i < threadCount; i++) {
      workers.push(new Promise((resolve) => {
        const worker = new Worker(workerCode, {
          eval: true,
          workerData: { algorithm, duration }
        });
        
        worker.on('message', (msg) => {
          resolve(msg.hashes);
          worker.terminate();
        });
      }));
    }
    
    const results = await Promise.all(workers);
    const totalHashes = results.reduce((sum, h) => sum + h, 0);
    
    const endTime = performance.now();
    const endMem = this.measureMemory();
    const elapsed = endTime - startTime;
    
    const hashrate = totalHashes / (elapsed / 1000);
    
    return {
      test: 'Mining Hashrate',
      algorithm,
      threads: threadCount,
      duration: Math.round(elapsed),
      totalHashes,
      hashrate: Math.round(hashrate),
      hashrateFormatted: this.formatHashrate(hashrate),
      memory: {
        startMB: startMem.heapUsedMB.toFixed(2),
        endMB: endMem.heapUsedMB.toFixed(2),
        deltaMB: (endMem.heapUsedMB - startMem.heapUsedMB).toFixed(2)
      }
    };
  }

  formatHashrate(hashrate) {
    if (hashrate > 1e9) return `${(hashrate / 1e9).toFixed(2)} GH/s`;
    if (hashrate > 1e6) return `${(hashrate / 1e6).toFixed(2)} MH/s`;
    if (hashrate > 1e3) return `${(hashrate / 1e3).toFixed(2)} kH/s`;
    return `${hashrate.toFixed(0)} H/s`;
  }

  /**
   * Test memory optimization
   */
  async benchmarkMemoryOptimization() {
    console.log('\n📊 Testing Memory Optimization...');
    
    try {
      const { PerformanceOptimizer } = await import('../src/performance-optimizer.js');
      
      const optimizer = new PerformanceOptimizer();
      const initialMem = this.measureMemory();
      
      // Create memory pressure
      const bigArrays = [];
      for (let i = 0; i < 100; i++) {
        bigArrays.push(new Array(100000).fill(Math.random()));
      }
      
      const beforeOptMem = this.measureMemory();
      
      // Trigger optimization
      optimizer.forceGarbageCollection();
      optimizer.clearCaches();
      
      // Clear references
      bigArrays.length = 0;
      
      // Wait for GC
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const afterOptMem = this.measureMemory();
      
      optimizer.stop();
      
      return {
        test: 'Memory Optimization',
        initialMemoryMB: initialMem.heapUsedMB.toFixed(2),
        beforeOptimizationMB: beforeOptMem.heapUsedMB.toFixed(2),
        afterOptimizationMB: afterOptMem.heapUsedMB.toFixed(2),
        freedMB: (beforeOptMem.heapUsedMB - afterOptMem.heapUsedMB).toFixed(2),
        freedPercent: ((beforeOptMem.heapUsedMB - afterOptMem.heapUsedMB) / beforeOptMem.heapUsedMB * 100).toFixed(2) + '%'
      };
      
    } catch (error) {
      console.error('Memory optimization test failed:', error);
      return { test: 'Memory Optimization', error: error.message };
    }
  }

  /**
   * Generate comprehensive report
   */
  generateReport() {
    console.log('\n' + '='.repeat(70));
    console.log('📋 OTEDAMA ADVANCED PERFORMANCE BENCHMARK REPORT');
    console.log('='.repeat(70));
    
    console.log('\n🖥️  System Information:');
    console.log(`  Platform: ${this.results.system.platform} ${this.results.system.arch}`);
    console.log(`  Node.js: ${this.results.system.nodeVersion}`);
    console.log(`  CPU: ${this.results.system.cpu.model}`);
    console.log(`  Cores: ${this.results.system.cpu.cores} @ ${this.results.system.cpu.speed}MHz`);
    console.log(`  Memory: ${this.results.system.memory.totalMB}MB (${this.results.system.memory.freeMB}MB free)`);
    console.log(`  Load Average: ${this.results.system.load.map(l => l.toFixed(2)).join(', ')}`);
    
    console.log('\n📊 Benchmark Results:');
    
    for (const benchmark of this.results.benchmarks) {
      console.log(`\n  ${benchmark.test}:`);
      
      if (benchmark.error) {
        console.log(`    ❌ Error: ${benchmark.error}`);
        continue;
      }
      
      // Display results based on test type
      switch (benchmark.test) {
        case 'Database Batching':
          console.log(`    Without Batching: ${benchmark.withoutBatching.avgMs}ms avg (${benchmark.withoutBatching.opsPerSec} ops/sec)`);
          console.log(`    With Batching: ${benchmark.withBatching.avgMs}ms avg (${benchmark.withBatching.opsPerSec} ops/sec)`);
          console.log(`    ✅ Improvement: ${benchmark.improvement}`);
          break;
          
        case 'Network Optimization':
          console.log(`    Without Optimization: ${benchmark.withoutOptimization.avgMs}ms, ${benchmark.withoutOptimization.totalBytes} bytes`);
          console.log(`    With Optimization: ${benchmark.withOptimization.avgMs}ms, ${benchmark.withOptimization.totalBytes} bytes`);
          console.log(`    ✅ Compression Ratio: ${benchmark.compressionRatio}`);
          console.log(`    ✅ Batching Ratio: ${benchmark.batchingRatio.toFixed(2)}:1`);
          break;
          
        case 'Cache Performance':
          console.log(`    Write: ${benchmark.write.avgMs}ms avg (${benchmark.write.opsPerSec} ops/sec)`);
          console.log(`    Read Hits: ${benchmark.readHits.avgMs}ms avg (${benchmark.readHits.opsPerSec} ops/sec)`);
          console.log(`    Read Misses: ${benchmark.readMisses.avgMs}ms avg (${benchmark.readMisses.opsPerSec} ops/sec)`);
          console.log(`    Hit Rate: ${benchmark.stats.hitRate}`);
          console.log(`    Compressions: ${benchmark.stats.compressions}`);
          console.log(`    Memory Usage: ${benchmark.stats.memoryUsageMB}MB`);
          break;
          
        case 'Mining Hashrate':
          console.log(`    Algorithm: ${benchmark.algorithm}`);
          console.log(`    Threads: ${benchmark.threads}`);
          console.log(`    Hashrate: ${benchmark.hashrateFormatted}`);
          console.log(`    Memory Delta: ${benchmark.memory.deltaMB}MB`);
          break;
          
        case 'Memory Optimization':
          console.log(`    Initial Memory: ${benchmark.initialMemoryMB}MB`);
          console.log(`    Before Optimization: ${benchmark.beforeOptimizationMB}MB`);
          console.log(`    After Optimization: ${benchmark.afterOptimizationMB}MB`);
          console.log(`    ✅ Freed: ${benchmark.freedMB}MB (${benchmark.freedPercent})`);
          break;
      }
    }
    
    console.log('\n' + '='.repeat(70));
    console.log('✅ Benchmark Complete');
    console.log('='.repeat(70) + '\n');
  }

  /**
   * Save results to file
   */
  saveResults() {
    const filename = `benchmark-${Date.now()}.json`;
    const filepath = path.join(__dirname, '..', 'benchmarks', filename);
    
    // Create benchmarks directory if it doesn't exist
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(filepath, JSON.stringify(this.results, null, 2));
    console.log(`\n📁 Results saved to: ${filepath}`);
  }

  /**
   * Run all benchmarks
   */
  async runBenchmarks() {
    console.log('🚀 Starting Otedama Advanced Performance Benchmarks...');
    console.log(`   Config: ${this.config.warmupRuns} warmup, ${this.config.testRuns} test runs, ${this.config.sampleSize} samples\n`);
    
    try {
      // Run benchmarks
      this.results.benchmarks.push(await this.benchmarkDatabaseBatching());
      this.results.benchmarks.push(await this.benchmarkNetworkOptimization());
      this.results.benchmarks.push(await this.benchmarkCachePerformance());
      this.results.benchmarks.push(await this.benchmarkHashrate('sha256', 5000));
      this.results.benchmarks.push(await this.benchmarkMemoryOptimization());
      
      // Calculate overall optimization impact
      this.calculateOptimizationImpact();
      
      // Generate report
      this.generateReport();
      
      // Save results
      this.saveResults();
      
    } catch (error) {
      console.error('\n❌ Benchmark suite failed:', error);
      process.exit(1);
    }
  }

  /**
   * Calculate overall optimization impact
   */
  calculateOptimizationImpact() {
    const dbBench = this.results.benchmarks.find(b => b.test === 'Database Batching');
    const netBench = this.results.benchmarks.find(b => b.test === 'Network Optimization');
    const memBench = this.results.benchmarks.find(b => b.test === 'Memory Optimization');
    
    this.results.optimizationImpact = {
      database: dbBench && !dbBench.error ? dbBench.improvement : 'N/A',
      network: netBench && !netBench.error ? netBench.compressionRatio : 'N/A',
      memory: memBench && !memBench.error ? memBench.freedPercent : 'N/A'
    };
  }
}

// Run benchmarks if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const benchmark = new AdvancedPerformanceBenchmark();
  
  // Parse command line arguments
  const args = process.argv.slice(2);
  if (args.includes('--quick')) {
    benchmark.config.warmupRuns = 1;
    benchmark.config.testRuns = 3;
    benchmark.config.sampleSize = 100;
  }
  
  benchmark.runBenchmarks().catch(console.error);
}

export default AdvancedPerformanceBenchmark;
