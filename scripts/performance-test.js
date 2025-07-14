#!/usr/bin/env node

/**
 * Otedama Performance Test Suite
 * 包括的なパフォーマンステストとベンチマーク
 */

import { performance } from 'perf_hooks';
import * as os from 'os';
import * as fs from 'fs';
import { Worker } from 'worker_threads';

class PerformanceTester {
  constructor() {
    this.results = {
      system: this.getSystemInfo(),
      tests: [],
      timestamp: new Date().toISOString()
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
        total: Math.round(os.totalmem() / 1024 / 1024),
        free: Math.round(os.freemem() / 1024 / 1024)
      }
    };
  }

  measureMemory() {
    if (global.gc) global.gc();
    const usage = process.memoryUsage();
    return {
      heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
      external: Math.round(usage.external / 1024 / 1024),
      rss: Math.round(usage.rss / 1024 / 1024)
    };
  }

  async testHashrate(algorithm = 'sha256', duration = 10000) {
    console.log(`\n📊 Testing ${algorithm} hashrate...`);
    
    const startMem = this.measureMemory();
    const startTime = performance.now();
    let hashes = 0;
    
    const workerCode = `
      const { parentPort, workerData } = require('worker_threads');
      const crypto = require('crypto');
      
      const { algorithm, duration } = workerData;
      let hashes = 0;
      const startTime = Date.now();
      
      while (Date.now() - startTime < duration) {
        const data = Buffer.from(Math.random().toString());
        crypto.createHash(algorithm).update(data).digest();
        hashes++;
      }
      
      parentPort.postMessage({ hashes });
    `;
    
    const threadCount = Math.max(1, os.cpus().length - 1);
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
    hashes = results.reduce((sum, h) => sum + h, 0);
    
    const endTime = performance.now();
    const endMem = this.measureMemory();
    const elapsed = endTime - startTime;
    
    const hashrate = Math.round(hashes / (elapsed / 1000));
    
    return {
      test: 'hashrate',
      algorithm,
      threads: threadCount,
      duration: Math.round(elapsed),
      hashes,
      hashrate,
      hashrateFormatted: this.formatHashrate(hashrate),
      memory: {
        start: startMem,
        end: endMem,
        delta: endMem.heapUsed - startMem.heapUsed
      }
    };
  }

  formatHashrate(hashrate) {
    if (hashrate > 1e9) return `${(hashrate / 1e9).toFixed(2)} GH/s`;
    if (hashrate > 1e6) return `${(hashrate / 1e6).toFixed(2)} MH/s`;
    if (hashrate > 1e3) return `${(hashrate / 1e3).toFixed(2)} kH/s`;
    return `${hashrate} H/s`;
  }

  generateReport() {
    console.log('\n' + '='.repeat(50));
    console.log('📋 PERFORMANCE TEST REPORT');
    console.log('='.repeat(50));
    
    console.log('\n🖥️  System Information:');
    console.log(`  Platform: ${this.results.system.platform} ${this.results.system.arch}`);
    console.log(`  Node.js: ${this.results.system.nodeVersion}`);
    console.log(`  CPU: ${this.results.system.cpu.model}`);
    console.log(`  Cores: ${this.results.system.cpu.cores}`);
    console.log(`  Memory: ${this.results.system.memory.total}MB total`);
    
    console.log('\n📊 Test Results:');
    for (const test of this.results.tests) {
      console.log(`\n  ${test.test.toUpperCase()}:`);
      console.log(`    Algorithm: ${test.algorithm}`);
      console.log(`    Threads: ${test.threads}`);
      console.log(`    Hashrate: ${test.hashrateFormatted}`);
      console.log(`    Memory Delta: ${test.memory.delta}MB`);
    }
    
    console.log('\n' + '='.repeat(50));
  }

  async runTest() {
    console.log('🚀 Starting Otedama Performance Test...\n');
    
    this.results.tests.push(await this.testHashrate('sha256', 5000));
    this.results.tests.push(await this.testHashrate('sha3-256', 5000));
    
    this.generateReport();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new PerformanceTester();
  tester.runTest().catch(console.error);
}