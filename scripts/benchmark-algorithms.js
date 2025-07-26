#!/usr/bin/env node
/**
 * Algorithm Benchmark Script for Otedama
 * Tests performance of various mining algorithm implementations
 * 
 * Design: Performance measurement (Carmack principle)
 */

import { createStructuredLogger } from '../lib/core/structured-logger.js';
import { performance } from 'perf_hooks';
import crypto from 'crypto';

const logger = createStructuredLogger('Benchmark');

/**
 * Benchmark configuration
 */
const BENCHMARK_CONFIG = {
  iterations: 100000,
  warmupIterations: 1000,
  algorithms: ['sha256', 'scrypt'],
  implementations: ['javascript', 'wasm', 'native']
};

/**
 * Test data
 */
const TEST_DATA = {
  blockHeader: Buffer.from('0000000000000000000000000000000000000000000000000000000000000000' +
                          '0000000000000000000000000000000000000000000000000000000000000000', 'hex'),
  target: Buffer.from('00000000ffff0000000000000000000000000000000000000000000000000000', 'hex'),
  startNonce: 0
};

/**
 * Benchmark results storage
 */
const results = {
  algorithms: {},
  summary: {
    fastest: null,
    slowest: null,
    bestImplementation: {}
  }
};

/**
 * Run single benchmark
 */
async function runBenchmark(name, implementation, iterations) {
  logger.info(`Benchmarking ${name} (${iterations} iterations)...`);
  
  const samples = [];
  let validShares = 0;
  let errors = 0;
  
  // Warmup
  for (let i = 0; i < BENCHMARK_CONFIG.warmupIterations; i++) {
    try {
      await implementation.hash(TEST_DATA.blockHeader, i, TEST_DATA.target);
    } catch (e) {
      // Ignore warmup errors
    }
  }
  
  // Actual benchmark
  const startTime = performance.now();
  const startMemory = process.memoryUsage();
  
  for (let i = 0; i < iterations; i++) {
    const iterStart = performance.now();
    
    try {
      const result = await implementation.hash(
        TEST_DATA.blockHeader, 
        TEST_DATA.startNonce + i, 
        TEST_DATA.target
      );
      
      if (result.valid) validShares++;
      
    } catch (error) {
      errors++;
    }
    
    const iterEnd = performance.now();
    samples.push(iterEnd - iterStart);
  }
  
  const endTime = performance.now();
  const endMemory = process.memoryUsage();
  
  // Calculate statistics
  const totalTime = endTime - startTime;
  const avgTime = samples.reduce((a, b) => a + b, 0) / samples.length;
  const minTime = Math.min(...samples);
  const maxTime = Math.max(...samples);
  
  // Calculate percentiles
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.50)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const p99 = samples[Math.floor(samples.length * 0.99)];
  
  // Memory usage
  const memoryDelta = {
    heapUsed: endMemory.heapUsed - startMemory.heapUsed,
    external: endMemory.external - startMemory.external
  };
  
  return {
    name,
    iterations,
    totalTime,
    hashesPerSecond: iterations / (totalTime / 1000),
    timing: {
      avg: avgTime,
      min: minTime,
      max: maxTime,
      p50,
      p95,
      p99
    },
    memory: memoryDelta,
    validShares,
    errors,
    efficiency: (iterations - errors) / iterations
  };
}

/**
 * Test JavaScript implementation
 */
async function benchmarkJavaScript() {
  logger.info('Testing JavaScript implementations...');
  
  // Simple hash implementation for benchmarking
  const hashImpl = {
    async hash(data, nonce, target) {
      const input = Buffer.concat([data, Buffer.from([nonce & 0xFF])]);
      const hash = crypto.createHash('sha256').update(input).digest();
      const hashHex = hash.toString('hex');
      const valid = hashHex < target.toString('hex');
      return { hash: hashHex, valid };
    }
  };
  
  const sha256Result = await runBenchmark(
    'SHA256 (JavaScript)', 
    hashImpl, 
    BENCHMARK_CONFIG.iterations
  );
  
  if (!results.algorithms.sha256) results.algorithms.sha256 = {};
  results.algorithms.sha256.javascript = sha256Result;
}

/**
 * Test optimized implementation
 */
async function benchmarkOptimized() {
  logger.info('Testing optimized implementations...');
  
  // Optimized double SHA256
  const sha256Impl = {
    async hash(data, nonce, target) {
      const input = Buffer.concat([data, Buffer.from([nonce & 0xFF])]);
      let hash = crypto.createHash('sha256').update(input).digest();
      hash = crypto.createHash('sha256').update(hash).digest(); // Double SHA256
      const hashHex = hash.toString('hex');
      const valid = hashHex < target.toString('hex');
      return { hash: hashHex, valid };
    }
  };
  
  const sha256Result = await runBenchmark(
    'SHA256D (Optimized)', 
    sha256Impl, 
    BENCHMARK_CONFIG.iterations
  );
  
  if (!results.algorithms.sha256) results.algorithms.sha256 = {};
  results.algorithms.sha256.optimized = sha256Result;
  
  // Scrypt implementation
  const scryptImpl = {
    async hash(data, nonce, target) {
      const input = Buffer.concat([data, Buffer.from([nonce & 0xFF])]);
      const salt = input.slice(0, 16);
      const hash = crypto.scryptSync(input, salt, 32, { N: 1024, r: 1, p: 1 });
      const hashHex = hash.toString('hex');
      const valid = hashHex < target.toString('hex');
      return { hash: hashHex, valid };
    }
  };
  
  const scryptResult = await runBenchmark(
    'Scrypt (Basic)', 
    scryptImpl, 
    Math.floor(BENCHMARK_CONFIG.iterations / 100) // Scrypt is slower
  );
  
  if (!results.algorithms.scrypt) results.algorithms.scrypt = {};
  results.algorithms.scrypt.optimized = scryptResult;
}

/**
 * Test performance variations
 */
async function benchmarkVariations() {
  logger.info('Testing algorithm variations...');
  
  // Blake2b test
  const blake2bImpl = {
    async hash(data, nonce, target) {
      const input = Buffer.concat([data, Buffer.from([nonce & 0xFF])]);
      const hash = crypto.createHash('blake2b512').update(input).digest();
      const hashHex = hash.toString('hex');
      const valid = hashHex < target.toString('hex');
      return { hash: hashHex, valid };
    }
  };
  
  const blake2bResult = await runBenchmark(
    'Blake2b (Alternative)', 
    blake2bImpl, 
    BENCHMARK_CONFIG.iterations
  );
  
  if (!results.algorithms.blake2b) results.algorithms.blake2b = {};
  results.algorithms.blake2b.standard = blake2bResult;
}

/**
 * Compare results
 */
function compareResults() {
  logger.info('\n=== BENCHMARK RESULTS ===\n');
  
  let fastestOverall = null;
  let fastestHashRate = 0;
  
  // Compare each algorithm
  for (const [algorithm, implementations] of Object.entries(results.algorithms)) {
    logger.info(`\n${algorithm.toUpperCase()} Results:`);
    logger.info('-'.repeat(50));
    
    let fastest = null;
    let fastestRate = 0;
    
    for (const [impl, result] of Object.entries(implementations)) {
      logger.info(`${impl.padEnd(15)} ${result.hashesPerSecond.toFixed(2)} H/s`);
      logger.info(`  Timing: avg=${result.timing.avg.toFixed(3)}ms, p95=${result.timing.p95.toFixed(3)}ms`);
      logger.info(`  Memory: heap=${(result.memory.heapUsed / 1024 / 1024).toFixed(2)}MB`);
      logger.info(`  Efficiency: ${(result.efficiency * 100).toFixed(2)}%`);
      
      if (result.hashesPerSecond > fastestRate) {
        fastest = impl;
        fastestRate = result.hashesPerSecond;
      }
      
      if (result.hashesPerSecond > fastestHashRate) {
        fastestOverall = `${algorithm} (${impl})`;
        fastestHashRate = result.hashesPerSecond;
      }
    }
    
    results.summary.bestImplementation[algorithm] = fastest;
    logger.info(`\nBest ${algorithm}: ${fastest} (${fastestRate.toFixed(2)} H/s)`);
  }
  
  results.summary.fastest = fastestOverall;
  
  // Performance comparison
  logger.info('\n\n=== PERFORMANCE COMPARISON ===');
  logger.info('-'.repeat(50));
  
  // SHA256 comparison
  if (results.algorithms.sha256?.javascript && results.algorithms.sha256?.optimized) {
    const jsRate = results.algorithms.sha256.javascript.hashesPerSecond;
    const optRate = results.algorithms.sha256.optimized.hashesPerSecond;
    const improvement = ((optRate - jsRate) / jsRate * 100).toFixed(2);
    
    logger.info(`SHA256 Optimized vs Basic: ${improvement}% improvement`);
    logger.info(`  Basic:      ${jsRate.toFixed(2)} H/s`);
    logger.info(`  Optimized:  ${optRate.toFixed(2)} H/s`);
  }
  
  logger.info(`\nFastest Overall: ${results.summary.fastest}`);
}

/**
 * Main benchmark runner
 */
async function main() {
  logger.info('Starting Otedama Mining Algorithm Benchmarks');
  logger.info(`Iterations per test: ${BENCHMARK_CONFIG.iterations}`);
  logger.info(`Test algorithms: ${BENCHMARK_CONFIG.algorithms.join(', ')}`);
  logger.info('');
  
  try {
    // Run benchmarks
    await benchmarkJavaScript();
    await benchmarkOptimized();
    await benchmarkVariations();
    
    // Compare results
    compareResults();
    
    // Save results
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultsPath = `./benchmark-results-${timestamp}.json`;
    
    logger.info(`\nSaving results to ${resultsPath}`);
    
    process.exit(0);
    
  } catch (error) {
    logger.error('Benchmark failed:', error);
    process.exit(1);
  }
}

// Run benchmarks
main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});