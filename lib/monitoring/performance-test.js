/**
 * Performance Testing Suite for Otedama
 * National-scale load testing and benchmarking
 * 
 * Design:
 * - Carmack: Accurate performance measurement
 * - Martin: Clean test scenarios
 * - Pike: Simple but comprehensive testing
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { performance } from 'perf_hooks';
import { createStructuredLogger } from '../core/structured-logger.js';
import WebSocket from 'ws';

// Test types
export const TestType = {
  LOAD: 'load',                     // Sustained load test
  STRESS: 'stress',                 // Push to limits
  SPIKE: 'spike',                   // Sudden traffic spike
  ENDURANCE: 'endurance',           // Long-running test
  SCALABILITY: 'scalability',       // Scale testing
  LATENCY: 'latency'               // Latency measurement
};

// Test phases
export const TestPhase = {
  WARMUP: 'warmup',
  RAMPUP: 'rampup',
  SUSTAIN: 'sustain',
  RAMPDOWN: 'rampdown',
  COOLDOWN: 'cooldown'
};

/**
 * Virtual miner for testing
 */
class VirtualMiner {
  constructor(id, config) {
    this.id = id;
    this.config = config;
    this.ws = null;
    this.connected = false;
    this.shares = {
      submitted: 0,
      accepted: 0,
      rejected: 0
    };
    this.latencies = [];
    this.errors = 0;
    this.lastShareTime = 0;
  }
  
  /**
   * Connect to pool
   */
  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.poolUrl);
        
        this.ws.on('open', () => {
          this.connected = true;
          this.subscribe();
          resolve();
        });
        
        this.ws.on('message', (data) => {
          this.handleMessage(data);
        });
        
        this.ws.on('error', (error) => {
          this.errors++;
          reject(error);
        });
        
        this.ws.on('close', () => {
          this.connected = false;
        });
        
      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * Subscribe to mining
   */
  subscribe() {
    const subscribeMsg = {
      id: 1,
      method: 'mining.subscribe',
      params: [`virtual-miner-${this.id}`]
    };
    
    this.ws.send(JSON.stringify(subscribeMsg));
  }
  
  /**
   * Submit share
   */
  submitShare() {
    if (!this.connected) return;
    
    const shareMsg = {
      id: Date.now(),
      method: 'mining.submit',
      params: [
        `virtual-miner-${this.id}`,
        this.jobId || 'test-job',
        crypto.randomBytes(4).toString('hex'),
        Date.now().toString(16),
        crypto.randomBytes(4).toString('hex')
      ]
    };
    
    this.lastShareTime = performance.now();
    this.shares.submitted++;
    
    this.ws.send(JSON.stringify(shareMsg));
  }
  
  /**
   * Handle pool message
   */
  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      
      if (message.method === 'mining.notify') {
        this.jobId = message.params[0];
      } else if (message.id && this.lastShareTime) {
        // Share response
        const latency = performance.now() - this.lastShareTime;
        this.latencies.push(latency);
        
        if (message.result === true) {
          this.shares.accepted++;
        } else {
          this.shares.rejected++;
        }
      }
    } catch (error) {
      this.errors++;
    }
  }
  
  /**
   * Start mining simulation
   */
  startMining(sharesPerMinute) {
    const interval = 60000 / sharesPerMinute;
    
    this.miningInterval = setInterval(() => {
      if (this.connected) {
        this.submitShare();
      }
    }, interval);
  }
  
  /**
   * Stop mining
   */
  stopMining() {
    if (this.miningInterval) {
      clearInterval(this.miningInterval);
    }
  }
  
  /**
   * Disconnect
   */
  disconnect() {
    this.stopMining();
    
    if (this.ws) {
      this.ws.close();
    }
  }
  
  /**
   * Get statistics
   */
  getStats() {
    const avgLatency = this.latencies.length > 0
      ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length
      : 0;
    
    const percentiles = this.calculatePercentiles(this.latencies);
    
    return {
      id: this.id,
      connected: this.connected,
      shares: this.shares,
      shareRate: this.shares.accepted / this.shares.submitted || 0,
      latency: {
        avg: avgLatency,
        p50: percentiles[50],
        p95: percentiles[95],
        p99: percentiles[99]
      },
      errors: this.errors
    };
  }
  
  /**
   * Calculate percentiles
   */
  calculatePercentiles(values) {
    if (values.length === 0) {
      return { 50: 0, 95: 0, 99: 0 };
    }
    
    const sorted = [...values].sort((a, b) => a - b);
    
    return {
      50: sorted[Math.floor(sorted.length * 0.5)],
      95: sorted[Math.floor(sorted.length * 0.95)],
      99: sorted[Math.floor(sorted.length * 0.99)]
    };
  }
}

/**
 * Load generator for different test scenarios
 */
class LoadGenerator extends EventEmitter {
  constructor(config) {
    super();
    
    this.config = {
      poolUrl: config.poolUrl || 'ws://localhost:3333',
      maxMiners: config.maxMiners || 1000,
      sharesPerMinute: config.sharesPerMinute || 60,
      ...config
    };
    
    this.miners = new Map();
    this.phase = null;
    this.startTime = 0;
  }
  
  /**
   * Generate load pattern
   */
  async generateLoad(pattern) {
    this.startTime = performance.now();
    
    switch (pattern.type) {
      case TestType.LOAD:
        await this.loadTest(pattern);
        break;
        
      case TestType.STRESS:
        await this.stressTest(pattern);
        break;
        
      case TestType.SPIKE:
        await this.spikeTest(pattern);
        break;
        
      case TestType.ENDURANCE:
        await this.enduranceTest(pattern);
        break;
        
      case TestType.SCALABILITY:
        await this.scalabilityTest(pattern);
        break;
        
      case TestType.LATENCY:
        await this.latencyTest(pattern);
        break;
    }
  }
  
  /**
   * Standard load test
   */
  async loadTest(pattern) {
    const targetMiners = pattern.miners || 100;
    const duration = pattern.duration || 300000; // 5 minutes
    const rampTime = pattern.rampTime || 60000; // 1 minute
    
    // Warmup
    await this.setPhase(TestPhase.WARMUP);
    await this.addMiners(10);
    await this.wait(10000);
    
    // Ramp up
    await this.setPhase(TestPhase.RAMPUP);
    await this.rampUp(targetMiners, rampTime);
    
    // Sustain
    await this.setPhase(TestPhase.SUSTAIN);
    await this.wait(duration);
    
    // Ramp down
    await this.setPhase(TestPhase.RAMPDOWN);
    await this.rampDown(0, rampTime);
    
    // Cooldown
    await this.setPhase(TestPhase.COOLDOWN);
    await this.wait(10000);
  }
  
  /**
   * Stress test - push to limits
   */
  async stressTest(pattern) {
    const maxMiners = pattern.maxMiners || this.config.maxMiners;
    const increment = pattern.increment || 100;
    const stepDuration = pattern.stepDuration || 30000; // 30 seconds
    
    await this.setPhase(TestPhase.RAMPUP);
    
    let currentMiners = 0;
    let failed = false;
    
    while (currentMiners < maxMiners && !failed) {
      try {
        await this.addMiners(increment);
        currentMiners += increment;
        
        this.emit('stress:step', {
          miners: currentMiners,
          stats: this.getStats()
        });
        
        await this.wait(stepDuration);
        
        // Check if system is still responsive
        const stats = this.getStats();
        if (stats.errorRate > 0.1) {
          failed = true;
          this.emit('stress:limit', {
            miners: currentMiners,
            errorRate: stats.errorRate
          });
        }
        
      } catch (error) {
        failed = true;
        this.emit('stress:failed', {
          miners: currentMiners,
          error: error.message
        });
      }
    }
  }
  
  /**
   * Spike test - sudden load
   */
  async spikeTest(pattern) {
    const baseMiners = pattern.baseMiners || 100;
    const spikeMiners = pattern.spikeMiners || 1000;
    const spikeDuration = pattern.spikeDuration || 60000; // 1 minute
    
    // Establish baseline
    await this.setPhase(TestPhase.WARMUP);
    await this.addMiners(baseMiners);
    await this.wait(30000);
    
    // Spike
    await this.setPhase(TestPhase.SUSTAIN);
    const spikeStart = performance.now();
    await this.addMiners(spikeMiners - baseMiners);
    
    this.emit('spike:triggered', {
      from: baseMiners,
      to: spikeMiners,
      time: performance.now() - spikeStart
    });
    
    await this.wait(spikeDuration);
    
    // Return to baseline
    await this.removeMiners(spikeMiners - baseMiners);
    await this.wait(30000);
  }
  
  /**
   * Add miners
   */
  async addMiners(count) {
    const promises = [];
    
    for (let i = 0; i < count; i++) {
      const minerId = crypto.randomUUID();
      const miner = new VirtualMiner(minerId, this.config);
      
      promises.push(
        miner.connect()
          .then(() => {
            this.miners.set(minerId, miner);
            miner.startMining(this.config.sharesPerMinute);
          })
          .catch(error => {
            throw error;
          })
      );
    }
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Remove miners
   */
  async removeMiners(count) {
    const minerIds = Array.from(this.miners.keys()).slice(0, count);
    
    for (const id of minerIds) {
      const miner = this.miners.get(id);
      if (miner) {
        miner.disconnect();
        this.miners.delete(id);
      }
    }
  }
  
  /**
   * Ramp up miners
   */
  async rampUp(target, duration) {
    const current = this.miners.size;
    const toAdd = target - current;
    const steps = 10;
    const stepSize = Math.ceil(toAdd / steps);
    const stepDuration = duration / steps;
    
    for (let i = 0; i < steps && this.miners.size < target; i++) {
      await this.addMiners(Math.min(stepSize, target - this.miners.size));
      await this.wait(stepDuration);
    }
  }
  
  /**
   * Ramp down miners
   */
  async rampDown(target, duration) {
    const current = this.miners.size;
    const toRemove = current - target;
    const steps = 10;
    const stepSize = Math.ceil(toRemove / steps);
    const stepDuration = duration / steps;
    
    for (let i = 0; i < steps && this.miners.size > target; i++) {
      await this.removeMiners(Math.min(stepSize, this.miners.size - target));
      await this.wait(stepDuration);
    }
  }
  
  /**
   * Set test phase
   */
  async setPhase(phase) {
    this.phase = phase;
    this.emit('phase:changed', phase);
  }
  
  /**
   * Wait for duration
   */
  wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Get current statistics
   */
  getStats() {
    const minerStats = Array.from(this.miners.values()).map(m => m.getStats());
    
    const aggregate = {
      miners: this.miners.size,
      connected: minerStats.filter(s => s.connected).length,
      totalShares: minerStats.reduce((sum, s) => sum + s.shares.submitted, 0),
      acceptedShares: minerStats.reduce((sum, s) => sum + s.shares.accepted, 0),
      rejectedShares: minerStats.reduce((sum, s) => sum + s.shares.rejected, 0),
      totalErrors: minerStats.reduce((sum, s) => sum + s.errors, 0),
      latencies: []
    };
    
    // Aggregate latencies
    for (const stats of minerStats) {
      aggregate.latencies.push(...stats.latency);
    }
    
    // Calculate metrics
    aggregate.shareRate = aggregate.totalShares > 0
      ? aggregate.acceptedShares / aggregate.totalShares
      : 0;
    
    aggregate.errorRate = aggregate.totalShares > 0
      ? aggregate.totalErrors / aggregate.totalShares
      : 0;
    
    // Latency percentiles
    const allLatencies = minerStats.flatMap(s => s.latency);
    aggregate.latency = this.calculateLatencyStats(allLatencies);
    
    aggregate.duration = performance.now() - this.startTime;
    
    return aggregate;
  }
  
  /**
   * Calculate latency statistics
   */
  calculateLatencyStats(latencies) {
    if (latencies.length === 0) {
      return { avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    }
    
    const sorted = [...latencies].sort((a, b) => a - b);
    
    return {
      avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      max: sorted[sorted.length - 1]
    };
  }
  
  /**
   * Stop all miners
   */
  async stop() {
    for (const miner of this.miners.values()) {
      miner.disconnect();
    }
    
    this.miners.clear();
  }
}

/**
 * Performance test suite
 */
export class PerformanceTestSuite extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      poolUrl: config.poolUrl || 'ws://localhost:3333',
      reportInterval: config.reportInterval || 10000, // 10 seconds
      ...config
    };
    
    this.logger = createStructuredLogger('PerformanceTest');
    this.loadGenerator = new LoadGenerator(this.config);
    this.results = [];
    this.currentTest = null;
  }
  
  /**
   * Run performance test
   */
  async runTest(testConfig) {
    this.logger.info('Starting performance test', testConfig);
    
    this.currentTest = {
      config: testConfig,
      startTime: Date.now(),
      results: [],
      phases: []
    };
    
    // Setup event handlers
    this.setupEventHandlers();
    
    // Start reporting
    const reportInterval = setInterval(() => {
      this.reportProgress();
    }, this.config.reportInterval);
    
    try {
      // Run test
      await this.loadGenerator.generateLoad(testConfig);
      
      // Final report
      this.currentTest.endTime = Date.now();
      this.currentTest.duration = this.currentTest.endTime - this.currentTest.startTime;
      
      const finalStats = this.loadGenerator.getStats();
      this.currentTest.finalStats = finalStats;
      
      this.generateReport();
      
    } catch (error) {
      this.logger.error('Test failed', error);
      this.currentTest.error = error.message;
      
    } finally {
      clearInterval(reportInterval);
      await this.loadGenerator.stop();
    }
    
    return this.currentTest;
  }
  
  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.loadGenerator.on('phase:changed', (phase) => {
      this.currentTest.phases.push({
        phase,
        timestamp: Date.now()
      });
      
      this.logger.info(`Test phase: ${phase}`);
    });
    
    this.loadGenerator.on('stress:limit', (data) => {
      this.currentTest.stressLimit = data;
      this.logger.warn('Stress limit reached', data);
    });
    
    this.loadGenerator.on('spike:triggered', (data) => {
      this.currentTest.spikeResponse = data;
      this.logger.info('Spike triggered', data);
    });
  }
  
  /**
   * Report progress
   */
  reportProgress() {
    const stats = this.loadGenerator.getStats();
    
    this.currentTest.results.push({
      timestamp: Date.now(),
      phase: this.loadGenerator.phase,
      ...stats
    });
    
    this.emit('progress', stats);
    
    this.logger.info('Test progress', {
      phase: this.loadGenerator.phase,
      miners: stats.miners,
      shareRate: `${(stats.shareRate * 100).toFixed(2)}%`,
      avgLatency: `${stats.latency.avg.toFixed(2)}ms`
    });
  }
  
  /**
   * Generate test report
   */
  generateReport() {
    const report = {
      summary: {
        testType: this.currentTest.config.type,
        duration: this.currentTest.duration,
        maxMiners: Math.max(...this.currentTest.results.map(r => r.miners)),
        totalShares: this.currentTest.finalStats.totalShares,
        shareRate: this.currentTest.finalStats.shareRate,
        errorRate: this.currentTest.finalStats.errorRate
      },
      performance: {
        latency: this.currentTest.finalStats.latency,
        throughput: this.calculateThroughput(),
        stability: this.calculateStability()
      },
      phases: this.currentTest.phases,
      recommendations: this.generateRecommendations()
    };
    
    this.currentTest.report = report;
    
    this.logger.info('Test completed', report.summary);
    this.emit('completed', report);
  }
  
  /**
   * Calculate throughput
   */
  calculateThroughput() {
    const results = this.currentTest.results;
    
    if (results.length < 2) return 0;
    
    // Calculate shares per second during sustain phase
    const sustainResults = results.filter(r => r.phase === TestPhase.SUSTAIN);
    
    if (sustainResults.length === 0) return 0;
    
    const totalShares = sustainResults[sustainResults.length - 1].totalShares - 
                       sustainResults[0].totalShares;
    
    const duration = (sustainResults[sustainResults.length - 1].timestamp - 
                     sustainResults[0].timestamp) / 1000;
    
    return totalShares / duration;
  }
  
  /**
   * Calculate stability
   */
  calculateStability() {
    const results = this.currentTest.results;
    const sustainResults = results.filter(r => r.phase === TestPhase.SUSTAIN);
    
    if (sustainResults.length < 2) return 1;
    
    // Calculate variance in share rate
    const shareRates = sustainResults.map(r => r.shareRate);
    const avg = shareRates.reduce((a, b) => a + b, 0) / shareRates.length;
    const variance = shareRates.reduce((sum, rate) => 
      sum + Math.pow(rate - avg, 2), 0) / shareRates.length;
    
    // Convert to stability score (0-1)
    return Math.max(0, 1 - Math.sqrt(variance));
  }
  
  /**
   * Generate recommendations
   */
  generateRecommendations() {
    const recommendations = [];
    const stats = this.currentTest.finalStats;
    
    if (stats.errorRate > 0.05) {
      recommendations.push({
        severity: 'high',
        category: 'reliability',
        message: 'High error rate detected. Review connection handling and error recovery.'
      });
    }
    
    if (stats.latency.p99 > 1000) {
      recommendations.push({
        severity: 'medium',
        category: 'performance',
        message: 'High tail latency. Consider optimizing share validation pipeline.'
      });
    }
    
    if (this.currentTest.stressLimit && this.currentTest.stressLimit.miners < 10000) {
      recommendations.push({
        severity: 'high',
        category: 'scalability',
        message: `System reached limits at ${this.currentTest.stressLimit.miners} miners. Review resource allocation.`
      });
    }
    
    return recommendations;
  }
  
  /**
   * Run benchmark suite
   */
  async runBenchmarkSuite() {
    const tests = [
      {
        name: 'Baseline Performance',
        type: TestType.LOAD,
        miners: 100,
        duration: 120000
      },
      {
        name: 'Scalability Test',
        type: TestType.SCALABILITY,
        targetMiners: 10000,
        increment: 1000
      },
      {
        name: 'Stress Test',
        type: TestType.STRESS,
        maxMiners: 50000
      },
      {
        name: 'Spike Response',
        type: TestType.SPIKE,
        baseMiners: 1000,
        spikeMiners: 10000
      }
    ];
    
    const results = [];
    
    for (const test of tests) {
      this.logger.info(`Running benchmark: ${test.name}`);
      
      try {
        const result = await this.runTest(test);
        results.push({
          name: test.name,
          success: true,
          ...result
        });
      } catch (error) {
        results.push({
          name: test.name,
          success: false,
          error: error.message
        });
      }
      
      // Cool down between tests
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
    
    return {
      timestamp: Date.now(),
      tests: results,
      summary: this.generateBenchmarkSummary(results)
    };
  }
  
  /**
   * Generate benchmark summary
   */
  generateBenchmarkSummary(results) {
    const successful = results.filter(r => r.success);
    
    if (successful.length === 0) {
      return { status: 'failed', message: 'All tests failed' };
    }
    
    // Find max sustainable load
    const scaleTest = successful.find(r => r.config.type === TestType.SCALABILITY);
    const maxLoad = scaleTest ? scaleTest.stressLimit?.miners || 0 : 0;
    
    // Get baseline performance
    const baseline = successful.find(r => r.config.type === TestType.LOAD);
    const baselineLatency = baseline ? baseline.finalStats.latency.avg : 0;
    
    return {
      status: 'completed',
      successRate: successful.length / results.length,
      maxSustainableLoad: maxLoad,
      baselineLatency: baselineLatency,
      recommendations: this.generateSummaryRecommendations(results)
    };
  }
  
  /**
   * Generate summary recommendations
   */
  generateSummaryRecommendations(results) {
    const recommendations = [];
    
    // Aggregate all recommendations
    for (const result of results) {
      if (result.report?.recommendations) {
        recommendations.push(...result.report.recommendations);
      }
    }
    
    // Deduplicate and prioritize
    const unique = new Map();
    for (const rec of recommendations) {
      const key = `${rec.category}:${rec.message}`;
      if (!unique.has(key) || rec.severity === 'high') {
        unique.set(key, rec);
      }
    }
    
    return Array.from(unique.values())
      .sort((a, b) => {
        const severityOrder = { high: 0, medium: 1, low: 2 };
        return severityOrder[a.severity] - severityOrder[b.severity];
      });
  }
}

export default PerformanceTestSuite;
