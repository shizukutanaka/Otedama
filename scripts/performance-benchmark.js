#!/usr/bin/env node
/**
 * Performance Benchmark for Otedama Mining Pool
 * Tests various components under load
 */

import { createStructuredLogger } from '../lib/core/structured-logger.js';
import { Worker } from 'worker_threads';
import crypto from 'crypto';
import os from 'os';

const logger = createStructuredLogger('Benchmark');

/**
 * Benchmark configuration
 */
const BENCHMARK_CONFIG = {
  // Share validation benchmark
  shareValidation: {
    totalShares: 1000000,
    batchSize: 1000,
    workerCount: os.cpus().length
  },
  
  // Network throughput benchmark
  network: {
    connectionCount: 10000,
    messagesPerConnection: 100,
    messageSize: 256
  },
  
  // Database benchmark
  database: {
    insertCount: 100000,
    queryCount: 10000,
    batchSize: 1000
  },
  
  // Memory benchmark
  memory: {
    allocationCount: 1000000,
    objectSize: 1024
  }
};

/**
 * Performance benchmark suite
 */
class PerformanceBenchmark {
  constructor() {
    this.results = {};
    this.startTime = Date.now();
  }
  
  /**
   * Run all benchmarks
   */
  async runAll() {
    console.log('\n=== Otedama Performance Benchmark ===\n');
    console.log(`System: ${os.platform()} ${os.arch()}`);
    console.log(`CPUs: ${os.cpus().length}x ${os.cpus()[0].model}`);
    console.log(`Memory: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`);
    console.log(`Node.js: ${process.version}\n`);
    
    // Run benchmarks
    await this.benchmarkShareValidation();
    await this.benchmarkHashing();
    await this.benchmarkMemoryOperations();
    await this.benchmarkSerialization();
    
    // Report results
    this.reportResults();
  }
  
  /**
   * Benchmark share validation
   */
  async benchmarkShareValidation() {
    console.log('Running share validation benchmark...');
    
    const { totalShares, batchSize } = BENCHMARK_CONFIG.shareValidation;
    const startTime = process.hrtime.bigint();
    
    let validated = 0;
    
    // Simulate share validation
    for (let i = 0; i < totalShares; i += batchSize) {
      const batch = [];
      
      for (let j = 0; j < batchSize && i + j < totalShares; j++) {
        batch.push({
          jobId: crypto.randomBytes(32).toString('hex'),
          nonce: crypto.randomBytes(4).readUInt32BE(0),
          extraNonce: crypto.randomBytes(4).readUInt32BE(0),
          time: Date.now(),
          difficulty: 65536
        });
      }
      
      // Validate batch
      for (const share of batch) {
        const hash = crypto.createHash('sha256');
        hash.update(Buffer.from(share.jobId, 'hex'));
        hash.update(Buffer.allocUnsafe(4).writeUInt32BE(share.nonce, 0));
        hash.update(Buffer.allocUnsafe(4).writeUInt32BE(share.extraNonce, 0));
        const result = hash.digest();
        
        // Check difficulty
        const hashValue = result.readBigUInt64BE(0);
        const target = BigInt(0xFFFFFFFFFFFFFFFF) / BigInt(share.difficulty);
        
        if (hashValue <= target) {
          validated++;
        }
      }
    }
    
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1e9; // Convert to seconds
    const sharesPerSecond = totalShares / duration;
    
    this.results.shareValidation = {
      totalShares,
      validated,
      duration: duration.toFixed(3),
      sharesPerSecond: Math.floor(sharesPerSecond),
      latencyPerShare: ((duration * 1000) / totalShares).toFixed(3)
    };
  }
  
  /**
   * Benchmark hashing algorithms
   */
  async benchmarkHashing() {
    console.log('Running hashing benchmark...');
    
    const algorithms = ['sha256', 'sha3-256', 'blake2b512'];
    const iterations = 1000000;
    const data = crypto.randomBytes(80); // Standard block header size
    
    this.results.hashing = {};
    
    for (const algo of algorithms) {
      // Skip if algorithm not available
      try {
        crypto.createHash(algo);
      } catch {
        continue;
      }
      
      const startTime = process.hrtime.bigint();
      
      for (let i = 0; i < iterations; i++) {
        const hash = crypto.createHash(algo);
        hash.update(data);
        hash.digest();
      }
      
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1e9;
      const hashesPerSecond = iterations / duration;
      
      this.results.hashing[algo] = {
        iterations,
        duration: duration.toFixed(3),
        hashesPerSecond: Math.floor(hashesPerSecond),
        MH_s: (hashesPerSecond / 1e6).toFixed(2)
      };
    }
  }
  
  /**
   * Benchmark memory operations
   */
  async benchmarkMemoryOperations() {
    console.log('Running memory operations benchmark...');
    
    const { allocationCount, objectSize } = BENCHMARK_CONFIG.memory;
    
    // Buffer allocation
    const bufferStartTime = process.hrtime.bigint();
    const buffers = [];
    
    for (let i = 0; i < allocationCount; i++) {
      buffers.push(Buffer.allocUnsafe(objectSize));
    }
    
    const bufferEndTime = process.hrtime.bigint();
    const bufferDuration = Number(bufferEndTime - bufferStartTime) / 1e9;
    
    // Object allocation
    const objectStartTime = process.hrtime.bigint();
    const objects = [];
    
    for (let i = 0; i < allocationCount; i++) {
      objects.push({
        id: i,
        data: new Array(objectSize / 8).fill(0),
        timestamp: Date.now()
      });
    }
    
    const objectEndTime = process.hrtime.bigint();
    const objectDuration = Number(objectEndTime - objectStartTime) / 1e9;
    
    // Memory usage
    const memUsage = process.memoryUsage();
    
    this.results.memory = {
      allocationCount,
      objectSize,
      bufferAllocation: {
        duration: bufferDuration.toFixed(3),
        allocationsPerSecond: Math.floor(allocationCount / bufferDuration),
        totalSize: `${(allocationCount * objectSize / 1024 / 1024).toFixed(2)} MB`
      },
      objectAllocation: {
        duration: objectDuration.toFixed(3),
        allocationsPerSecond: Math.floor(allocationCount / objectDuration)
      },
      memoryUsage: {
        rss: `${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
        heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        external: `${(memUsage.external / 1024 / 1024).toFixed(2)} MB`
      }
    };
    
    // Clean up
    buffers.length = 0;
    objects.length = 0;
    
    // Force GC if available
    if (global.gc) {
      global.gc();
    }
  }
  
  /**
   * Benchmark serialization
   */
  async benchmarkSerialization() {
    console.log('Running serialization benchmark...');
    
    const iterations = 100000;
    const testData = {
      minerId: crypto.randomBytes(16).toString('hex'),
      shares: {
        accepted: 12345,
        rejected: 67,
        difficulty: 1234567890
      },
      hashrate: 123456789012345,
      lastShare: Date.now(),
      connection: {
        ip: '192.168.1.100',
        port: 3333,
        userAgent: 'Otedama/1.0'
      }
    };
    
    // JSON serialization
    const jsonStartTime = process.hrtime.bigint();
    
    for (let i = 0; i < iterations; i++) {
      const json = JSON.stringify(testData);
      JSON.parse(json);
    }
    
    const jsonEndTime = process.hrtime.bigint();
    const jsonDuration = Number(jsonEndTime - jsonStartTime) / 1e9;
    
    // Binary serialization (simulated)
    const binaryStartTime = process.hrtime.bigint();
    
    for (let i = 0; i < iterations; i++) {
      const buffer = Buffer.allocUnsafe(256);
      let offset = 0;
      
      // Write minerId
      buffer.write(testData.minerId, offset, 'hex');
      offset += 16;
      
      // Write shares
      buffer.writeBigUInt64BE(BigInt(testData.shares.accepted), offset);
      offset += 8;
      buffer.writeBigUInt64BE(BigInt(testData.shares.rejected), offset);
      offset += 8;
      buffer.writeBigUInt64BE(BigInt(testData.shares.difficulty), offset);
      offset += 8;
      
      // Write hashrate
      buffer.writeBigUInt64BE(BigInt(testData.hashrate), offset);
      offset += 8;
      
      // Read back (deserialize)
      offset = 0;
      const minerId = buffer.toString('hex', offset, offset + 16);
      offset += 16;
      const accepted = buffer.readBigUInt64BE(offset);
      offset += 8;
      const rejected = buffer.readBigUInt64BE(offset);
      offset += 8;
      const difficulty = buffer.readBigUInt64BE(offset);
      offset += 8;
      const hashrate = buffer.readBigUInt64BE(offset);
    }
    
    const binaryEndTime = process.hrtime.bigint();
    const binaryDuration = Number(binaryEndTime - binaryStartTime) / 1e9;
    
    this.results.serialization = {
      iterations,
      json: {
        duration: jsonDuration.toFixed(3),
        operationsPerSecond: Math.floor(iterations / jsonDuration),
        size: JSON.stringify(testData).length
      },
      binary: {
        duration: binaryDuration.toFixed(3),
        operationsPerSecond: Math.floor(iterations / binaryDuration),
        size: 256,
        speedup: (jsonDuration / binaryDuration).toFixed(2) + 'x'
      }
    };
  }
  
  /**
   * Report benchmark results
   */
  reportResults() {
    console.log('\n=== Benchmark Results ===\n');
    
    // Share validation results
    if (this.results.shareValidation) {
      const sv = this.results.shareValidation;
      console.log('Share Validation:');
      console.log(`  Total shares: ${sv.totalShares.toLocaleString()}`);
      console.log(`  Valid shares: ${sv.validated.toLocaleString()}`);
      console.log(`  Duration: ${sv.duration}s`);
      console.log(`  Throughput: ${sv.sharesPerSecond.toLocaleString()} shares/sec`);
      console.log(`  Latency: ${sv.latencyPerShare}ms per share`);
      console.log('');
    }
    
    // Hashing results
    if (this.results.hashing) {
      console.log('Hashing Performance:');
      for (const [algo, results] of Object.entries(this.results.hashing)) {
        console.log(`  ${algo}:`);
        console.log(`    ${results.MH_s} MH/s (${results.hashesPerSecond.toLocaleString()} H/s)`);
      }
      console.log('');
    }
    
    // Memory results
    if (this.results.memory) {
      const mem = this.results.memory;
      console.log('Memory Operations:');
      console.log(`  Buffer allocations: ${mem.bufferAllocation.allocationsPerSecond.toLocaleString()}/sec`);
      console.log(`  Object allocations: ${mem.objectAllocation.allocationsPerSecond.toLocaleString()}/sec`);
      console.log(`  Memory usage:`);
      console.log(`    RSS: ${mem.memoryUsage.rss}`);
      console.log(`    Heap: ${mem.memoryUsage.heapUsed} / ${mem.memoryUsage.heapTotal}`);
      console.log('');
    }
    
    // Serialization results
    if (this.results.serialization) {
      const ser = this.results.serialization;
      console.log('Serialization:');
      console.log(`  JSON: ${ser.json.operationsPerSecond.toLocaleString()} ops/sec (${ser.json.size} bytes)`);
      console.log(`  Binary: ${ser.binary.operationsPerSecond.toLocaleString()} ops/sec (${ser.binary.size} bytes)`);
      console.log(`  Binary speedup: ${ser.binary.speedup}`);
      console.log('');
    }
    
    // Overall performance score
    const score = this.calculatePerformanceScore();
    console.log('=== Performance Score ===');
    console.log(`Overall: ${score}/100`);
    
    if (score >= 90) {
      console.log('Rating: EXCELLENT - Ready for production use');
    } else if (score >= 70) {
      console.log('Rating: GOOD - Suitable for most deployments');
    } else if (score >= 50) {
      console.log('Rating: FAIR - Consider hardware upgrades');
    } else {
      console.log('Rating: POOR - Hardware upgrade recommended');
    }
    
    console.log('\nBenchmark completed in', ((Date.now() - this.startTime) / 1000).toFixed(2), 'seconds\n');
  }
  
  /**
   * Calculate overall performance score
   */
  calculatePerformanceScore() {
    let score = 0;
    let weights = 0;
    
    // Share validation score (weight: 40%)
    if (this.results.shareValidation) {
      const sharesPerSec = this.results.shareValidation.sharesPerSecond;
      const shareScore = Math.min(100, (sharesPerSec / 1000000) * 100);
      score += shareScore * 0.4;
      weights += 0.4;
    }
    
    // Hashing score (weight: 30%)
    if (this.results.hashing && this.results.hashing.sha256) {
      const mhPerSec = parseFloat(this.results.hashing.sha256.MH_s);
      const hashScore = Math.min(100, (mhPerSec / 100) * 100);
      score += hashScore * 0.3;
      weights += 0.3;
    }
    
    // Memory score (weight: 20%)
    if (this.results.memory) {
      const allocPerSec = this.results.memory.bufferAllocation.allocationsPerSecond;
      const memScore = Math.min(100, (allocPerSec / 1000000) * 100);
      score += memScore * 0.2;
      weights += 0.2;
    }
    
    // Serialization score (weight: 10%)
    if (this.results.serialization) {
      const opsPerSec = this.results.serialization.binary.operationsPerSecond;
      const serScore = Math.min(100, (opsPerSec / 1000000) * 100);
      score += serScore * 0.1;
      weights += 0.1;
    }
    
    return Math.round(score / weights);
  }
}

// Run benchmark
async function main() {
  const benchmark = new PerformanceBenchmark();
  await benchmark.runAll();
}

main().catch(error => {
  logger.error('Benchmark failed:', error);
  process.exit(1);
});
