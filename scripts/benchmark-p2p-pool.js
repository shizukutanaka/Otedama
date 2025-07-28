#!/usr/bin/env node

/**
 * P2P Pool Benchmark Script for Otedama
 * Performance testing and optimization validation
 */

import { P2PPoolManager } from '../lib/p2p/p2p-pool-manager.js';
import { OptimizedSharePropagation } from '../lib/p2p/optimized-share-propagation.js';
import { AdvancedPeerDiscovery } from '../lib/p2p/advanced-peer-discovery.js';
import { OptimizedMiningEngine } from '../lib/mining/optimized-mining-engine.js';
import { DistributedShareValidator } from '../lib/network/distributed-share-validator.js';
import { P2PRealtimeDashboard } from '../lib/monitoring/p2p-realtime-dashboard.js';
import crypto from 'crypto';
import { performance } from 'perf_hooks';
import { cpus } from 'os';

/**
 * Benchmark configuration
 */
const BENCHMARK_CONFIG = {
  // Test duration
  duration: 60000, // 1 minute
  
  // Share generation
  shareRate: 1000, // Shares per second
  minerCount: 100,
  
  // Network simulation
  peerCount: 50,
  networkLatency: { min: 10, max: 100 }, // ms
  packetLoss: 0.01, // 1%
  
  // Mining simulation
  hashratePer Worker: 100000000, // 100 MH/s
  blockInterval: 600000, // 10 minutes
  
  // Validation
  validationNodes: 7,
  validationStrategy: 'byzantine'
};

/**
 * Benchmark results
 */
class BenchmarkResults {
  constructor() {
    this.metrics = {
      shares: {
        submitted: 0,
        accepted: 0,
        rejected: 0,
        propagated: 0,
        validated: 0
      },
      latency: {
        submission: [],
        propagation: [],
        validation: [],
        endToEnd: []
      },
      throughput: {
        sharesPerSecond: 0,
        messagesPerSecond: 0,
        validationsPerSecond: 0
      },
      network: {
        totalMessages: 0,
        totalBytes: 0,
        duplicates: 0
      },
      mining: {
        totalHashes: 0,
        effectiveHashrate: 0,
        sharesFound: 0,
        blocksFound: 0
      },
      resources: {
        cpuUsage: [],
        memoryUsage: [],
        connections: 0
      }
    };
    
    this.startTime = Date.now();
  }
  
  recordShare(type, latency) {
    this.metrics.shares[type]++;
    if (latency !== undefined) {
      this.metrics.latency.submission.push(latency);
    }
  }
  
  recordPropagation(latency, bytes) {
    this.metrics.shares.propagated++;
    this.metrics.latency.propagation.push(latency);
    this.metrics.network.totalMessages++;
    this.metrics.network.totalBytes += bytes;
  }
  
  recordValidation(latency, success) {
    this.metrics.shares.validated++;
    this.metrics.latency.validation.push(latency);
    if (!success) {
      this.metrics.shares.rejected++;
    }
  }
  
  recordEndToEnd(latency) {
    this.metrics.latency.endToEnd.push(latency);
  }
  
  recordMining(hashes, shares, blocks) {
    this.metrics.mining.totalHashes += hashes;
    this.metrics.mining.sharesFound += shares;
    this.metrics.mining.blocksFound += blocks;
  }
  
  recordResources(cpu, memory, connections) {
    this.metrics.resources.cpuUsage.push(cpu);
    this.metrics.resources.memoryUsage.push(memory);
    this.metrics.resources.connections = connections;
  }
  
  calculate() {
    const duration = (Date.now() - this.startTime) / 1000; // seconds
    
    // Calculate throughput
    this.metrics.throughput.sharesPerSecond = this.metrics.shares.submitted / duration;
    this.metrics.throughput.messagesPerSecond = this.metrics.network.totalMessages / duration;
    this.metrics.throughput.validationsPerSecond = this.metrics.shares.validated / duration;
    
    // Calculate effective hashrate
    this.metrics.mining.effectiveHashrate = this.metrics.mining.totalHashes / duration;
    
    // Calculate latency percentiles
    const calculatePercentiles = (values) => {
      if (values.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0 };
      
      const sorted = [...values].sort((a, b) => a - b);
      return {
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        p99: sorted[Math.floor(sorted.length * 0.99)]
      };
    };
    
    return {
      duration,
      shares: this.metrics.shares,
      throughput: this.metrics.throughput,
      latency: {
        submission: calculatePercentiles(this.metrics.latency.submission),
        propagation: calculatePercentiles(this.metrics.latency.propagation),
        validation: calculatePercentiles(this.metrics.latency.validation),
        endToEnd: calculatePercentiles(this.metrics.latency.endToEnd)
      },
      network: {
        ...this.metrics.network,
        bandwidthMBps: (this.metrics.network.totalBytes / duration) / 1024 / 1024
      },
      mining: {
        ...this.metrics.mining,
        effectiveHashrateTHs: this.metrics.mining.effectiveHashrate / 1e12
      },
      resources: {
        avgCpu: this.metrics.resources.cpuUsage.reduce((a, b) => a + b, 0) / 
                this.metrics.resources.cpuUsage.length || 0,
        avgMemoryMB: (this.metrics.resources.memoryUsage.reduce((a, b) => a + b, 0) / 
                     this.metrics.resources.memoryUsage.length || 0) / 1024 / 1024,
        connections: this.metrics.resources.connections
      }
    };
  }
}

/**
 * Network simulator for testing
 */
class NetworkSimulator {
  constructor(config) {
    this.config = config;
    this.nodes = new Map();
  }
  
  createNode(id) {
    return {
      id,
      latency: this.config.networkLatency.min + 
               Math.random() * (this.config.networkLatency.max - this.config.networkLatency.min),
      online: true
    };
  }
  
  simulateMessage(from, to, size) {
    const fromNode = this.nodes.get(from);
    const toNode = this.nodes.get(to);
    
    if (!fromNode || !toNode || !fromNode.online || !toNode.online) {
      return { delivered: false, latency: 0 };
    }
    
    // Simulate packet loss
    if (Math.random() < this.config.packetLoss) {
      return { delivered: false, latency: 0 };
    }
    
    // Calculate latency
    const latency = (fromNode.latency + toNode.latency) / 2 + Math.random() * 10;
    
    return { delivered: true, latency };
  }
}

/**
 * Run benchmark
 */
async function runBenchmark() {
  console.log('Otedama P2P Pool Benchmark');
  console.log('==========================\n');
  
  const results = new BenchmarkResults();
  const networkSim = new NetworkSimulator(BENCHMARK_CONFIG);
  
  // Initialize components
  console.log('Initializing components...');
  
  const poolManager = new P2PPoolManager({
    poolName: 'Benchmark Pool',
    poolAddress: 'bc1qbenchmark' + crypto.randomBytes(16).toString('hex'),
    poolFee: 0.01,
    p2pPort: 30303,
    stratumPort: 3333
  });
  
  const sharePropagation = new OptimizedSharePropagation({
    strategy: 'adaptive',
    maxPeers: BENCHMARK_CONFIG.peerCount,
    batchSize: 100
  });
  
  const miningEngine = new OptimizedMiningEngine({
    workerCount: cpus().length,
    strategies: ['adaptive_nonce', 'work_stealing', 'cache_optimized']
  });
  
  const shareValidator = new DistributedShareValidator({
    minValidators: 3,
    maxValidators: BENCHMARK_CONFIG.validationNodes,
    validationStrategy: BENCHMARK_CONFIG.validationStrategy,
    enablePrediction: true,
    enableBatching: true
  });
  
  const dashboard = new P2PRealtimeDashboard({
    enableWebSocket: false,
    updateInterval: 1000
  });
  
  // Initialize all components
  await poolManager.initialize();
  await sharePropagation.initialize();
  await miningEngine.initialize();
  await shareValidator.initialize();
  await dashboard.start();
  
  // Start pool
  await poolManager.start();
  
  console.log('Starting benchmark...\n');
  
  // Create simulated peers
  for (let i = 0; i < BENCHMARK_CONFIG.peerCount; i++) {
    const node = networkSim.createNode(`peer-${i}`);
    networkSim.nodes.set(node.id, node);
  }
  
  // Benchmark tasks
  const tasks = [];
  
  // Share submission task
  tasks.push(benchmarkShareSubmission(poolManager, results));
  
  // Share propagation task
  tasks.push(benchmarkSharePropagation(sharePropagation, networkSim, results));
  
  // Mining simulation task
  tasks.push(benchmarkMining(miningEngine, results));
  
  // Validation task
  tasks.push(benchmarkValidation(shareValidator, results));
  
  // Resource monitoring task
  tasks.push(monitorResources(dashboard, results));
  
  // Run for specified duration
  const benchmarkPromise = Promise.all(tasks);
  const timeoutPromise = new Promise(resolve => setTimeout(resolve, BENCHMARK_CONFIG.duration));
  
  await Promise.race([benchmarkPromise, timeoutPromise]);
  
  // Stop all tasks
  console.log('\nStopping benchmark...');
  
  // Cleanup
  await poolManager.stop();
  await sharePropagation.shutdown();
  await miningEngine.shutdown();
  await shareValidator.shutdown();
  await dashboard.stop();
  
  // Calculate and display results
  const finalResults = results.calculate();
  displayResults(finalResults);
}

/**
 * Benchmark share submission
 */
async function benchmarkShareSubmission(poolManager, results) {
  const shareInterval = 1000 / BENCHMARK_CONFIG.shareRate;
  
  while (true) {
    const minerIndex = Math.floor(Math.random() * BENCHMARK_CONFIG.minerCount);
    const share = {
      minerId: `miner-${minerIndex}`,
      hash: crypto.randomBytes(32).toString('hex'),
      difficulty: 1000 + Math.random() * 1000,
      nonce: Math.floor(Math.random() * 0xFFFFFFFF),
      timestamp: Date.now()
    };
    
    const start = performance.now();
    poolManager.shareChain.addShare(share);
    const latency = performance.now() - start;
    
    results.recordShare('submitted', latency);
    
    await new Promise(resolve => setTimeout(resolve, shareInterval));
  }
}

/**
 * Benchmark share propagation
 */
async function benchmarkSharePropagation(propagation, networkSim, results) {
  const propagationInterval = 10; // 10ms
  
  while (true) {
    // Simulate share propagation
    const share = {
      height: Math.floor(Math.random() * 1000000),
      hash: crypto.randomBytes(32).toString('hex'),
      nonce: Math.floor(Math.random() * 0xFFFFFFFF),
      minerId: `miner-${Math.floor(Math.random() * BENCHMARK_CONFIG.minerCount)}`,
      difficulty: 1000
    };
    
    const messageSize = JSON.stringify(share).length;
    const start = performance.now();
    
    await propagation.propagateShare(share);
    
    const latency = performance.now() - start;
    results.recordPropagation(latency, messageSize);
    
    await new Promise(resolve => setTimeout(resolve, propagationInterval));
  }
}

/**
 * Benchmark mining
 */
async function benchmarkMining(miningEngine, results) {
  const template = {
    height: 100000,
    previousblockhash: crypto.randomBytes(32).toString('hex'),
    merkleroot: crypto.randomBytes(32).toString('hex'),
    curtime: Math.floor(Date.now() / 1000),
    bits: '1d00ffff',
    target: 'ffff'.repeat(16)
  };
  
  let totalHashes = 0;
  let sharesFound = 0;
  let blocksFound = 0;
  
  miningEngine.on('share:found', () => sharesFound++);
  miningEngine.on('block:found', () => blocksFound++);
  
  await miningEngine.startMining(template, 10000);
  
  const statsInterval = setInterval(() => {
    const stats = miningEngine.getStatistics();
    const newHashes = stats.performance.totalHashes - totalHashes;
    totalHashes = stats.performance.totalHashes;
    
    results.recordMining(newHashes, sharesFound, blocksFound);
    sharesFound = 0;
    blocksFound = 0;
  }, 1000);
  
  // Cleanup on exit
  process.on('beforeExit', () => clearInterval(statsInterval));
}

/**
 * Benchmark validation
 */
async function benchmarkValidation(validator, results) {
  const validationInterval = 5; // 5ms
  
  while (true) {
    const share = {
      hash: crypto.randomBytes(32).toString('hex'),
      difficulty: 1000 + Math.random() * 1000,
      nonce: Math.floor(Math.random() * 0xFFFFFFFF)
    };
    
    const start = performance.now();
    const result = await validator.validateShare(share, 'sha256');
    
    // Wait for validation to complete
    if (result.taskId && !result.cached) {
      const validationResult = await validator.getValidationResult(result.taskId, 1000);
      const latency = performance.now() - start;
      
      if (validationResult.found) {
        results.recordValidation(latency, validationResult.result?.valid);
      }
    } else if (result.cached) {
      const latency = performance.now() - start;
      results.recordValidation(latency, result.valid);
    }
    
    await new Promise(resolve => setTimeout(resolve, validationInterval));
  }
}

/**
 * Monitor resources
 */
async function monitorResources(dashboard, results) {
  const monitorInterval = 1000; // 1 second
  
  while (true) {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    // Update dashboard metrics
    dashboard.updateMetrics({
      'performance.cpu.usage': cpuUsage.user / 1000000, // Convert to percentage
      'performance.memory.usage': memUsage.heapUsed
    });
    
    results.recordResources(
      cpuUsage.user / 1000000,
      memUsage.heapUsed,
      50 // Simulated connection count
    );
    
    await new Promise(resolve => setTimeout(resolve, monitorInterval));
  }
}

/**
 * Display benchmark results
 */
function displayResults(results) {
  console.log('\nBenchmark Results');
  console.log('=================\n');
  
  console.log('Duration:', results.duration.toFixed(2), 'seconds\n');
  
  console.log('Share Processing:');
  console.log(`  Submitted: ${results.shares.submitted}`);
  console.log(`  Accepted: ${results.shares.accepted}`);
  console.log(`  Rejected: ${results.shares.rejected}`);
  console.log(`  Propagated: ${results.shares.propagated}`);
  console.log(`  Validated: ${results.shares.validated}`);
  console.log();
  
  console.log('Throughput:');
  console.log(`  Shares/second: ${results.throughput.sharesPerSecond.toFixed(2)}`);
  console.log(`  Messages/second: ${results.throughput.messagesPerSecond.toFixed(2)}`);
  console.log(`  Validations/second: ${results.throughput.validationsPerSecond.toFixed(2)}`);
  console.log();
  
  console.log('Latency (ms):');
  console.log('  Share Submission:');
  console.log(`    Average: ${results.latency.submission.avg.toFixed(2)}`);
  console.log(`    P50: ${results.latency.submission.p50.toFixed(2)}`);
  console.log(`    P95: ${results.latency.submission.p95.toFixed(2)}`);
  console.log(`    P99: ${results.latency.submission.p99.toFixed(2)}`);
  
  console.log('  Share Propagation:');
  console.log(`    Average: ${results.latency.propagation.avg.toFixed(2)}`);
  console.log(`    P50: ${results.latency.propagation.p50.toFixed(2)}`);
  console.log(`    P95: ${results.latency.propagation.p95.toFixed(2)}`);
  console.log(`    P99: ${results.latency.propagation.p99.toFixed(2)}`);
  
  console.log('  Share Validation:');
  console.log(`    Average: ${results.latency.validation.avg.toFixed(2)}`);
  console.log(`    P50: ${results.latency.validation.p50.toFixed(2)}`);
  console.log(`    P95: ${results.latency.validation.p95.toFixed(2)}`);
  console.log(`    P99: ${results.latency.validation.p99.toFixed(2)}`);
  console.log();
  
  console.log('Network:');
  console.log(`  Total Messages: ${results.network.totalMessages}`);
  console.log(`  Bandwidth: ${results.network.bandwidthMBps.toFixed(2)} MB/s`);
  console.log(`  Duplicates: ${results.network.duplicates}`);
  console.log();
  
  console.log('Mining:');
  console.log(`  Effective Hashrate: ${results.mining.effectiveHashrateTHs.toFixed(2)} TH/s`);
  console.log(`  Shares Found: ${results.mining.sharesFound}`);
  console.log(`  Blocks Found: ${results.mining.blocksFound}`);
  console.log();
  
  console.log('Resources:');
  console.log(`  Average CPU: ${results.resources.avgCpu.toFixed(2)}%`);
  console.log(`  Average Memory: ${results.resources.avgMemoryMB.toFixed(2)} MB`);
  console.log(`  Connections: ${results.resources.connections}`);
  console.log();
  
  // Performance summary
  console.log('Performance Summary:');
  if (results.throughput.sharesPerSecond > 1000) {
    console.log('  ✓ Excellent share throughput (>1000/s)');
  } else if (results.throughput.sharesPerSecond > 500) {
    console.log('  ✓ Good share throughput (>500/s)');
  } else {
    console.log('  ⚠ Low share throughput (<500/s)');
  }
  
  if (results.latency.submission.p95 < 10) {
    console.log('  ✓ Excellent submission latency (<10ms P95)');
  } else if (results.latency.submission.p95 < 50) {
    console.log('  ✓ Good submission latency (<50ms P95)');
  } else {
    console.log('  ⚠ High submission latency (>50ms P95)');
  }
  
  if (results.latency.validation.p95 < 100) {
    console.log('  ✓ Excellent validation latency (<100ms P95)');
  } else if (results.latency.validation.p95 < 500) {
    console.log('  ✓ Good validation latency (<500ms P95)');
  } else {
    console.log('  ⚠ High validation latency (>500ms P95)');
  }
  
  if (results.resources.avgCpu < 50) {
    console.log('  ✓ Efficient CPU usage (<50%)');
  } else if (results.resources.avgCpu < 80) {
    console.log('  ✓ Acceptable CPU usage (<80%)');
  } else {
    console.log('  ⚠ High CPU usage (>80%)');
  }
}

// Run benchmark
runBenchmark().catch(console.error);