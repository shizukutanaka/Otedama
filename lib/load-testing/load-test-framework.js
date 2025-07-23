/**
 * Load Testing Framework for Otedama
 * Comprehensive load testing and stress testing capabilities
 */

import { EventEmitter } from 'events';
import cluster from 'cluster';
import os from 'os';
import { performance } from 'perf_hooks';
import { createWriteStream } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import WebSocket from 'ws';
import { getErrorHandler } from '../core/standardized-error-handler.js';

// Test types
export const TestType = {
  LOAD: 'load',           // Standard load test
  STRESS: 'stress',       // Stress test to find breaking point
  SPIKE: 'spike',         // Sudden traffic spike
  SOAK: 'soak',          // Long duration test
  CAPACITY: 'capacity',   // Find max capacity
  ENDURANCE: 'endurance'  // Extended duration test
};

// Test scenarios
export const TestScenario = {
  API: 'api',
  WEBSOCKET: 'websocket',
  MINING: 'mining',
  DEX: 'dex',
  MIXED: 'mixed'
};

export class LoadTestFramework extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Target configuration
      targetUrl: config.targetUrl || 'http://localhost:8080',
      wsUrl: config.wsUrl || 'ws://localhost:3334',
      
      // Test configuration
      testType: config.testType || TestType.LOAD,
      scenario: config.scenario || TestScenario.MIXED,
      duration: config.duration || 60000, // 1 minute default
      
      // Load configuration
      virtualUsers: config.virtualUsers || 100,
      rampUpTime: config.rampUpTime || 10000, // 10 seconds
      rampDownTime: config.rampDownTime || 5000, // 5 seconds
      
      // Request configuration
      requestsPerUser: config.requestsPerUser || 10,
      thinkTime: config.thinkTime || 1000, // 1 second between requests
      timeout: config.timeout || 30000, // 30 seconds
      
      // Stress test configuration
      stressIncrement: config.stressIncrement || 50, // Users to add each step
      stressInterval: config.stressInterval || 30000, // 30 seconds per step
      maxUsers: config.maxUsers || 10000,
      
      // Output configuration
      outputDir: config.outputDir || './load-test-results',
      reportFormat: config.reportFormat || ['json', 'html'],
      realTimeMetrics: config.realTimeMetrics !== false,
      
      // Worker configuration
      workers: config.workers || os.cpus().length,
      
      ...config
    };
    
    this.errorHandler = getErrorHandler();
    
    // Test state
    this.state = {
      status: 'idle',
      startTime: null,
      endTime: null,
      currentUsers: 0,
      totalRequests: 0,
      completedRequests: 0,
      failedRequests: 0,
      activeConnections: new Set()
    };
    
    // Metrics collection
    this.metrics = {
      requests: [],
      responses: [],
      errors: [],
      connectionTimes: [],
      latencies: [],
      throughput: [],
      concurrency: [],
      resources: []
    };
    
    // Real-time stats
    this.stats = {
      avgResponseTime: 0,
      minResponseTime: Infinity,
      maxResponseTime: 0,
      percentiles: {},
      throughput: 0,
      errorRate: 0,
      activeUsers: 0
    };
    
    // Workers
    this.workers = new Map();
    
    // Initialize
    this.initialize();
  }

  /**
   * Initialize the framework
   */
  async initialize() {
    // Create output directory
    await fs.mkdir(this.config.outputDir, { recursive: true });
    
    // Setup cluster if master
    if (cluster.isMaster) {
      this.setupMaster();
    } else {
      this.setupWorker();
    }
  }

  /**
   * Setup master process
   */
  setupMaster() {
    console.log(`Load Test Master (${process.pid}) is running`);
    
    // Fork workers
    for (let i = 0; i < this.config.workers; i++) {
      const worker = cluster.fork();
      this.workers.set(worker.id, {
        id: worker.id,
        status: 'idle',
        stats: {
          requests: 0,
          failures: 0,
          totalTime: 0
        }
      });
    }
    
    // Handle worker messages
    cluster.on('message', (worker, message) => {
      this.handleWorkerMessage(worker, message);
    });
    
    // Handle worker exit
    cluster.on('exit', (worker, code, signal) => {
      console.log(`Worker ${worker.process.pid} died`);
      if (this.state.status === 'running') {
        // Restart worker
        const newWorker = cluster.fork();
        this.workers.set(newWorker.id, {
          id: newWorker.id,
          status: 'idle',
          stats: {
            requests: 0,
            failures: 0,
            totalTime: 0
          }
        });
      }
    });
    
    // Start metrics collection
    if (this.config.realTimeMetrics) {
      this.startMetricsCollection();
    }
  }

  /**
   * Setup worker process
   */
  setupWorker() {
    console.log(`Load Test Worker (${process.pid}) started`);
    
    // Listen for tasks
    process.on('message', async (message) => {
      if (message.type === 'START_TEST') {
        await this.runWorkerTest(message.config);
      } else if (message.type === 'STOP_TEST') {
        process.exit(0);
      }
    });
  }

  /**
   * Start load test
   */
  async start() {
    if (this.state.status !== 'idle') {
      throw new Error('Test already running');
    }
    
    console.log(`Starting ${this.config.testType} test...`);
    console.log(`Target: ${this.config.targetUrl}`);
    console.log(`Scenario: ${this.config.scenario}`);
    console.log(`Virtual Users: ${this.config.virtualUsers}`);
    console.log(`Duration: ${this.config.duration}ms`);
    
    this.state.status = 'running';
    this.state.startTime = Date.now();
    
    this.emit('test:started', {
      testType: this.config.testType,
      scenario: this.config.scenario,
      config: this.config
    });
    
    try {
      // Run test based on type
      switch (this.config.testType) {
        case TestType.LOAD:
          await this.runLoadTest();
          break;
        case TestType.STRESS:
          await this.runStressTest();
          break;
        case TestType.SPIKE:
          await this.runSpikeTest();
          break;
        case TestType.SOAK:
          await this.runSoakTest();
          break;
        case TestType.CAPACITY:
          await this.runCapacityTest();
          break;
        case TestType.ENDURANCE:
          await this.runEnduranceTest();
          break;
        default:
          throw new Error(`Unknown test type: ${this.config.testType}`);
      }
      
      // Finalize test
      await this.finalize();
      
    } catch (error) {
      this.state.status = 'failed';
      this.emit('test:failed', error);
      throw error;
    }
  }

  /**
   * Run standard load test
   */
  async runLoadTest() {
    // Ramp up users
    await this.rampUp();
    
    // Run test for duration
    const testEndTime = Date.now() + this.config.duration;
    
    while (Date.now() < testEndTime && this.state.status === 'running') {
      // Distribute load across workers
      await this.distributeLoad();
      
      // Wait for think time
      await this.sleep(this.config.thinkTime);
    }
    
    // Ramp down users
    await this.rampDown();
  }

  /**
   * Run stress test
   */
  async runStressTest() {
    let currentUsers = this.config.virtualUsers;
    
    while (currentUsers <= this.config.maxUsers && this.state.status === 'running') {
      console.log(`Stress test: ${currentUsers} users`);
      
      // Update user count
      this.config.virtualUsers = currentUsers;
      this.state.currentUsers = currentUsers;
      
      // Run load test for interval
      const intervalEndTime = Date.now() + this.config.stressInterval;
      
      while (Date.now() < intervalEndTime && this.state.status === 'running') {
        await this.distributeLoad();
        await this.sleep(this.config.thinkTime);
        
        // Check for system failure
        if (this.stats.errorRate > 0.5) { // 50% error rate
          console.log(`System failure detected at ${currentUsers} users`);
          this.emit('stress:breaking-point', {
            users: currentUsers,
            errorRate: this.stats.errorRate
          });
          return;
        }
      }
      
      // Increase users
      currentUsers += this.config.stressIncrement;
    }
  }

  /**
   * Run spike test
   */
  async runSpikeTest() {
    // Normal load
    console.log('Running normal load...');
    await this.runLoadTest();
    
    // Sudden spike
    console.log('Applying traffic spike...');
    const originalUsers = this.config.virtualUsers;
    this.config.virtualUsers = originalUsers * 5; // 5x spike
    
    // Run spike for 1/3 of duration
    const spikeEndTime = Date.now() + (this.config.duration / 3);
    
    while (Date.now() < spikeEndTime && this.state.status === 'running') {
      await this.distributeLoad();
      await this.sleep(this.config.thinkTime / 2); // Faster requests during spike
    }
    
    // Return to normal
    console.log('Returning to normal load...');
    this.config.virtualUsers = originalUsers;
    
    // Continue normal load
    await this.runLoadTest();
  }

  /**
   * Run soak test
   */
  async runSoakTest() {
    // Extended duration test
    const soakDuration = this.config.duration * 10; // 10x normal duration
    console.log(`Running soak test for ${soakDuration}ms`);
    
    this.config.duration = soakDuration;
    await this.runLoadTest();
  }

  /**
   * Run capacity test
   */
  async runCapacityTest() {
    let optimalUsers = 0;
    let maxThroughput = 0;
    
    // Binary search for optimal user count
    let low = 1;
    let high = this.config.maxUsers;
    
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      this.config.virtualUsers = mid;
      
      console.log(`Testing capacity with ${mid} users`);
      
      // Reset metrics
      this.resetMetrics();
      
      // Run test
      const testDuration = 30000; // 30 seconds per test
      const testEndTime = Date.now() + testDuration;
      
      while (Date.now() < testEndTime && this.state.status === 'running') {
        await this.distributeLoad();
        await this.sleep(this.config.thinkTime);
      }
      
      // Calculate throughput
      const throughput = this.calculateThroughput();
      
      if (throughput > maxThroughput && this.stats.errorRate < 0.01) {
        maxThroughput = throughput;
        optimalUsers = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    
    console.log(`Optimal capacity: ${optimalUsers} users`);
    console.log(`Max throughput: ${maxThroughput} req/s`);
    
    this.emit('capacity:found', {
      optimalUsers,
      maxThroughput
    });
  }

  /**
   * Run endurance test
   */
  async runEnduranceTest() {
    // 24 hour test
    const enduranceDuration = 24 * 60 * 60 * 1000;
    console.log(`Running endurance test for 24 hours`);
    
    this.config.duration = enduranceDuration;
    
    // Monitor memory leaks and performance degradation
    const monitorInterval = setInterval(() => {
      const memoryUsage = process.memoryUsage();
      this.emit('endurance:checkpoint', {
        timestamp: Date.now(),
        memoryUsage,
        stats: this.stats
      });
      
      // Check for memory leaks
      if (memoryUsage.heapUsed > 1024 * 1024 * 1024) { // 1GB
        console.warn('Potential memory leak detected');
      }
    }, 60000); // Every minute
    
    await this.runLoadTest();
    
    clearInterval(monitorInterval);
  }

  /**
   * Distribute load across workers
   */
  async distributeLoad() {
    const usersPerWorker = Math.ceil(this.config.virtualUsers / this.workers.size);
    
    const promises = [];
    
    for (const [workerId, workerInfo] of this.workers) {
      if (workerInfo.status === 'idle') {
        promises.push(this.sendWorkToWorker(workerId, {
          users: usersPerWorker,
          scenario: this.config.scenario,
          targetUrl: this.config.targetUrl,
          wsUrl: this.config.wsUrl,
          requestsPerUser: this.config.requestsPerUser,
          timeout: this.config.timeout
        }));
      }
    }
    
    await Promise.all(promises);
  }

  /**
   * Send work to worker
   */
  async sendWorkToWorker(workerId, work) {
    return new Promise((resolve) => {
      const worker = cluster.workers[workerId];
      
      if (!worker) {
        resolve();
        return;
      }
      
      worker.send({
        type: 'START_TEST',
        config: work
      });
      
      // Mark worker as busy
      const workerInfo = this.workers.get(workerId);
      if (workerInfo) {
        workerInfo.status = 'busy';
      }
      
      // Timeout to prevent hanging
      setTimeout(() => {
        resolve();
      }, work.timeout + 5000);
    });
  }

  /**
   * Run worker test
   */
  async runWorkerTest(config) {
    const results = {
      requests: 0,
      failures: 0,
      totalTime: 0,
      responses: []
    };
    
    try {
      // Create virtual users
      const promises = [];
      
      for (let i = 0; i < config.users; i++) {
        promises.push(this.runVirtualUser(config, results));
      }
      
      await Promise.all(promises);
      
      // Send results back to master
      process.send({
        type: 'TEST_RESULTS',
        workerId: cluster.worker.id,
        results
      });
      
    } catch (error) {
      process.send({
        type: 'TEST_ERROR',
        workerId: cluster.worker.id,
        error: error.message
      });
    }
  }

  /**
   * Run virtual user
   */
  async runVirtualUser(config, results) {
    for (let i = 0; i < config.requestsPerUser; i++) {
      try {
        const startTime = performance.now();
        
        // Execute scenario
        let response;
        switch (config.scenario) {
          case TestScenario.API:
            response = await this.executeAPIRequest(config);
            break;
          case TestScenario.WEBSOCKET:
            response = await this.executeWebSocketRequest(config);
            break;
          case TestScenario.MINING:
            response = await this.executeMiningRequest(config);
            break;
          case TestScenario.DEX:
            response = await this.executeDEXRequest(config);
            break;
          case TestScenario.MIXED:
            response = await this.executeMixedScenario(config);
            break;
        }
        
        const endTime = performance.now();
        const responseTime = endTime - startTime;
        
        results.requests++;
        results.totalTime += responseTime;
        results.responses.push({
          timestamp: Date.now(),
          responseTime,
          statusCode: response.statusCode || 200,
          success: true
        });
        
      } catch (error) {
        results.requests++;
        results.failures++;
        results.responses.push({
          timestamp: Date.now(),
          responseTime: 0,
          error: error.message,
          success: false
        });
      }
      
      // Think time between requests
      await this.sleep(Math.random() * config.thinkTime);
    }
  }

  /**
   * Execute API request
   */
  async executeAPIRequest(config) {
    const endpoints = [
      '/api/status',
      '/api/stats',
      '/api/mining/stats',
      '/api/dex/orderbook',
      '/api/wallet/balance'
    ];
    
    const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
    const url = new URL(endpoint, config.targetUrl);
    
    return new Promise((resolve, reject) => {
      const protocol = url.protocol === 'https:' ? https : http;
      
      const req = protocol.get(url, {
        timeout: config.timeout
      }, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data
          });
        });
      });
      
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  /**
   * Execute WebSocket request
   */
  async executeWebSocketRequest(config) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(config.wsUrl);
      
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket timeout'));
      }, config.timeout);
      
      ws.on('open', () => {
        // Send test message
        ws.send(JSON.stringify({
          type: 'subscribe',
          channel: 'mining.stats'
        }));
      });
      
      ws.on('message', (data) => {
        clearTimeout(timeout);
        ws.close();
        resolve({
          success: true,
          data: data.toString()
        });
      });
      
      ws.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Execute mining request
   */
  async executeMiningRequest(config) {
    const miningEndpoints = [
      '/api/mining/submit',
      '/api/mining/stats',
      '/api/mining/workers',
      '/api/mining/shares'
    ];
    
    const endpoint = miningEndpoints[Math.floor(Math.random() * miningEndpoints.length)];
    
    if (endpoint === '/api/mining/submit') {
      // Simulate share submission
      const shareData = {
        nonce: Math.random().toString(36),
        hash: Math.random().toString(36),
        difficulty: 1000000,
        timestamp: Date.now()
      };
      
      return this.postRequest(config.targetUrl + endpoint, shareData, config.timeout);
    } else {
      return this.executeAPIRequest({ ...config, targetUrl: config.targetUrl + endpoint });
    }
  }

  /**
   * Execute DEX request
   */
  async executeDEXRequest(config) {
    const dexOperations = [
      { endpoint: '/api/dex/orderbook', method: 'GET' },
      { endpoint: '/api/dex/ticker', method: 'GET' },
      { endpoint: '/api/dex/trades', method: 'GET' },
      { endpoint: '/api/dex/order', method: 'POST' },
      { endpoint: '/api/dex/cancel', method: 'POST' }
    ];
    
    const operation = dexOperations[Math.floor(Math.random() * dexOperations.length)];
    
    if (operation.method === 'POST') {
      const orderData = {
        type: Math.random() > 0.5 ? 'buy' : 'sell',
        price: Math.random() * 1000,
        amount: Math.random() * 10,
        pair: 'BTC/USDT'
      };
      
      return this.postRequest(config.targetUrl + operation.endpoint, orderData, config.timeout);
    } else {
      return this.executeAPIRequest({ ...config, targetUrl: config.targetUrl + operation.endpoint });
    }
  }

  /**
   * Execute mixed scenario
   */
  async executeMixedScenario(config) {
    const scenarios = [
      () => this.executeAPIRequest(config),
      () => this.executeWebSocketRequest(config),
      () => this.executeMiningRequest(config),
      () => this.executeDEXRequest(config)
    ];
    
    const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
    return scenario();
  }

  /**
   * POST request helper
   */
  async postRequest(url, data, timeout) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const protocol = urlObj.protocol === 'https:' ? https : http;
      
      const postData = JSON.stringify(data);
      
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout
      };
      
      const req = protocol.request(options, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: responseData
          });
        });
      });
      
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      req.write(postData);
      req.end();
    });
  }

  /**
   * Handle worker message
   */
  handleWorkerMessage(worker, message) {
    if (message.type === 'TEST_RESULTS') {
      const workerInfo = this.workers.get(message.workerId);
      if (workerInfo) {
        workerInfo.status = 'idle';
        workerInfo.stats.requests += message.results.requests;
        workerInfo.stats.failures += message.results.failures;
        workerInfo.stats.totalTime += message.results.totalTime;
        
        // Update global metrics
        this.state.totalRequests += message.results.requests;
        this.state.completedRequests += message.results.requests - message.results.failures;
        this.state.failedRequests += message.results.failures;
        
        // Store response data
        this.metrics.responses.push(...message.results.responses);
      }
    } else if (message.type === 'TEST_ERROR') {
      console.error(`Worker ${message.workerId} error:`, message.error);
      this.metrics.errors.push({
        timestamp: Date.now(),
        workerId: message.workerId,
        error: message.error
      });
    }
  }

  /**
   * Ramp up users
   */
  async rampUp() {
    console.log('Ramping up users...');
    
    const startUsers = 0;
    const targetUsers = this.config.virtualUsers;
    const rampUpSteps = 10;
    const stepDelay = this.config.rampUpTime / rampUpSteps;
    const usersPerStep = Math.ceil((targetUsers - startUsers) / rampUpSteps);
    
    for (let i = 0; i < rampUpSteps; i++) {
      this.state.currentUsers = Math.min(startUsers + (i + 1) * usersPerStep, targetUsers);
      this.emit('rampup:step', {
        step: i + 1,
        users: this.state.currentUsers
      });
      
      await this.sleep(stepDelay);
    }
    
    console.log('Ramp up complete');
  }

  /**
   * Ramp down users
   */
  async rampDown() {
    console.log('Ramping down users...');
    
    const currentUsers = this.state.currentUsers;
    const rampDownSteps = 5;
    const stepDelay = this.config.rampDownTime / rampDownSteps;
    const usersPerStep = Math.ceil(currentUsers / rampDownSteps);
    
    for (let i = 0; i < rampDownSteps; i++) {
      this.state.currentUsers = Math.max(currentUsers - (i + 1) * usersPerStep, 0);
      this.emit('rampdown:step', {
        step: i + 1,
        users: this.state.currentUsers
      });
      
      await this.sleep(stepDelay);
    }
    
    console.log('Ramp down complete');
  }

  /**
   * Calculate real-time stats
   */
  calculateStats() {
    if (this.metrics.responses.length === 0) {
      return;
    }
    
    // Response times
    const responseTimes = this.metrics.responses
      .filter(r => r.success)
      .map(r => r.responseTime)
      .sort((a, b) => a - b);
    
    if (responseTimes.length > 0) {
      this.stats.avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
      this.stats.minResponseTime = responseTimes[0];
      this.stats.maxResponseTime = responseTimes[responseTimes.length - 1];
      
      // Calculate percentiles
      this.stats.percentiles = {
        p50: this.percentile(responseTimes, 0.5),
        p75: this.percentile(responseTimes, 0.75),
        p90: this.percentile(responseTimes, 0.9),
        p95: this.percentile(responseTimes, 0.95),
        p99: this.percentile(responseTimes, 0.99)
      };
    }
    
    // Throughput
    const duration = (Date.now() - this.state.startTime) / 1000; // seconds
    this.stats.throughput = this.state.completedRequests / duration;
    
    // Error rate
    this.stats.errorRate = this.state.failedRequests / this.state.totalRequests;
    
    // Active users
    this.stats.activeUsers = this.state.currentUsers;
  }

  /**
   * Calculate throughput
   */
  calculateThroughput() {
    const duration = (Date.now() - this.state.startTime) / 1000;
    return this.state.completedRequests / duration;
  }

  /**
   * Calculate percentile
   */
  percentile(arr, p) {
    const index = Math.ceil(arr.length * p) - 1;
    return arr[index];
  }

  /**
   * Start metrics collection
   */
  startMetricsCollection() {
    this.metricsInterval = setInterval(() => {
      this.calculateStats();
      
      // Emit real-time metrics
      this.emit('metrics:update', {
        timestamp: Date.now(),
        stats: this.stats,
        state: this.state
      });
      
      // Store metrics snapshot
      this.metrics.throughput.push({
        timestamp: Date.now(),
        value: this.stats.throughput
      });
      
      this.metrics.concurrency.push({
        timestamp: Date.now(),
        value: this.state.currentUsers
      });
      
      // Resource usage
      const usage = process.cpuUsage();
      const memory = process.memoryUsage();
      
      this.metrics.resources.push({
        timestamp: Date.now(),
        cpu: usage,
        memory
      });
      
    }, 1000); // Every second
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      requests: [],
      responses: [],
      errors: [],
      connectionTimes: [],
      latencies: [],
      throughput: [],
      concurrency: [],
      resources: []
    };
    
    this.state.totalRequests = 0;
    this.state.completedRequests = 0;
    this.state.failedRequests = 0;
  }

  /**
   * Finalize test
   */
  async finalize() {
    console.log('Finalizing test...');
    
    this.state.status = 'completed';
    this.state.endTime = Date.now();
    
    // Stop metrics collection
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    
    // Calculate final stats
    this.calculateStats();
    
    // Generate report
    const report = await this.generateReport();
    
    // Save reports
    await this.saveReports(report);
    
    // Stop workers
    for (const worker of Object.values(cluster.workers)) {
      worker.send({ type: 'STOP_TEST' });
    }
    
    this.emit('test:completed', report);
    
    console.log('Test completed successfully');
  }

  /**
   * Generate report
   */
  async generateReport() {
    const duration = this.state.endTime - this.state.startTime;
    
    const report = {
      summary: {
        testType: this.config.testType,
        scenario: this.config.scenario,
        duration,
        virtualUsers: this.config.virtualUsers,
        totalRequests: this.state.totalRequests,
        completedRequests: this.state.completedRequests,
        failedRequests: this.state.failedRequests,
        avgResponseTime: this.stats.avgResponseTime,
        minResponseTime: this.stats.minResponseTime,
        maxResponseTime: this.stats.maxResponseTime,
        percentiles: this.stats.percentiles,
        throughput: this.stats.throughput,
        errorRate: this.stats.errorRate
      },
      configuration: this.config,
      metrics: this.metrics,
      errors: this.metrics.errors,
      timestamp: new Date().toISOString()
    };
    
    return report;
  }

  /**
   * Save reports
   */
  async saveReports(report) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseFilename = `load-test-${this.config.testType}-${timestamp}`;
    
    // Save JSON report
    if (this.config.reportFormat.includes('json')) {
      const jsonPath = path.join(this.config.outputDir, `${baseFilename}.json`);
      await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
      console.log(`JSON report saved: ${jsonPath}`);
    }
    
    // Save HTML report
    if (this.config.reportFormat.includes('html')) {
      const htmlPath = path.join(this.config.outputDir, `${baseFilename}.html`);
      const htmlContent = this.generateHTMLReport(report);
      await fs.writeFile(htmlPath, htmlContent);
      console.log(`HTML report saved: ${htmlPath}`);
    }
    
    // Save summary
    const summaryPath = path.join(this.config.outputDir, 'summary.json');
    await fs.writeFile(summaryPath, JSON.stringify(report.summary, null, 2));
  }

  /**
   * Generate HTML report
   */
  generateHTMLReport(report) {
    return `
<!DOCTYPE html>
<html>
<head>
  <title>Otedama Load Test Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { 
      font-family: Arial, sans-serif; 
      margin: 20px; 
      background: #f5f5f5;
    }
    .container { 
      max-width: 1200px; 
      margin: 0 auto;
      background: white;
      padding: 20px;
      border-radius: 10px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    h1, h2 { color: #333; }
    .summary { 
      display: grid; 
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin: 20px 0;
    }
    .metric { 
      background: #f8f9fa; 
      padding: 15px; 
      border-radius: 5px;
      border-left: 4px solid #007bff;
    }
    .metric h3 { 
      margin: 0 0 10px 0; 
      color: #666;
      font-size: 14px;
    }
    .metric .value { 
      font-size: 24px; 
      font-weight: bold;
      color: #333;
    }
    .chart-container { 
      margin: 30px 0;
      height: 400px;
    }
    .success { color: #28a745; }
    .error { color: #dc3545; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    th, td {
      padding: 10px;
      text-align: left;
      border-bottom: 1px solid #ddd;
    }
    th { background: #f8f9fa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Otedama Load Test Report</h1>
    <p>Generated: ${report.timestamp}</p>
    
    <h2>Test Summary</h2>
    <div class="summary">
      <div class="metric">
        <h3>Test Type</h3>
        <div class="value">${report.summary.testType}</div>
      </div>
      <div class="metric">
        <h3>Scenario</h3>
        <div class="value">${report.summary.scenario}</div>
      </div>
      <div class="metric">
        <h3>Duration</h3>
        <div class="value">${(report.summary.duration / 1000).toFixed(1)}s</div>
      </div>
      <div class="metric">
        <h3>Virtual Users</h3>
        <div class="value">${report.summary.virtualUsers}</div>
      </div>
      <div class="metric">
        <h3>Total Requests</h3>
        <div class="value">${report.summary.totalRequests.toLocaleString()}</div>
      </div>
      <div class="metric">
        <h3>Success Rate</h3>
        <div class="value ${report.summary.errorRate < 0.01 ? 'success' : 'error'}">
          ${((1 - report.summary.errorRate) * 100).toFixed(2)}%
        </div>
      </div>
      <div class="metric">
        <h3>Throughput</h3>
        <div class="value">${report.summary.throughput.toFixed(2)} req/s</div>
      </div>
      <div class="metric">
        <h3>Avg Response Time</h3>
        <div class="value">${report.summary.avgResponseTime.toFixed(2)}ms</div>
      </div>
    </div>
    
    <h2>Response Time Percentiles</h2>
    <table>
      <tr>
        <th>Percentile</th>
        <th>Response Time (ms)</th>
      </tr>
      <tr>
        <td>50th (Median)</td>
        <td>${report.summary.percentiles.p50?.toFixed(2) || 'N/A'}</td>
      </tr>
      <tr>
        <td>75th</td>
        <td>${report.summary.percentiles.p75?.toFixed(2) || 'N/A'}</td>
      </tr>
      <tr>
        <td>90th</td>
        <td>${report.summary.percentiles.p90?.toFixed(2) || 'N/A'}</td>
      </tr>
      <tr>
        <td>95th</td>
        <td>${report.summary.percentiles.p95?.toFixed(2) || 'N/A'}</td>
      </tr>
      <tr>
        <td>99th</td>
        <td>${report.summary.percentiles.p99?.toFixed(2) || 'N/A'}</td>
      </tr>
    </table>
    
    <h2>Performance Charts</h2>
    
    <div class="chart-container">
      <canvas id="throughputChart"></canvas>
    </div>
    
    <div class="chart-container">
      <canvas id="responseTimeChart"></canvas>
    </div>
    
    <div class="chart-container">
      <canvas id="concurrencyChart"></canvas>
    </div>
    
    <h2>Errors</h2>
    ${report.errors.length > 0 ? `
      <table>
        <tr>
          <th>Timestamp</th>
          <th>Error</th>
        </tr>
        ${report.errors.slice(0, 100).map(e => `
          <tr>
            <td>${new Date(e.timestamp).toLocaleTimeString()}</td>
            <td>${e.error}</td>
          </tr>
        `).join('')}
      </table>
    ` : '<p>No errors recorded</p>'}
  </div>
  
  <script>
    // Throughput chart
    const throughputCtx = document.getElementById('throughputChart').getContext('2d');
    new Chart(throughputCtx, {
      type: 'line',
      data: {
        labels: ${JSON.stringify(report.metrics.throughput.map(t => new Date(t.timestamp).toLocaleTimeString()))},
        datasets: [{
          label: 'Throughput (req/s)',
          data: ${JSON.stringify(report.metrics.throughput.map(t => t.value))},
          borderColor: 'rgb(75, 192, 192)',
          tension: 0.1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Throughput Over Time'
          }
        }
      }
    });
    
    // Response time distribution
    const responseTimeCtx = document.getElementById('responseTimeChart').getContext('2d');
    const responseTimes = ${JSON.stringify(report.metrics.responses.filter(r => r.success).map(r => r.responseTime))};
    const histogram = {};
    const bucketSize = 50; // 50ms buckets
    
    responseTimes.forEach(time => {
      const bucket = Math.floor(time / bucketSize) * bucketSize;
      histogram[bucket] = (histogram[bucket] || 0) + 1;
    });
    
    new Chart(responseTimeCtx, {
      type: 'bar',
      data: {
        labels: Object.keys(histogram).map(b => b + 'ms'),
        datasets: [{
          label: 'Response Time Distribution',
          data: Object.values(histogram),
          backgroundColor: 'rgba(54, 162, 235, 0.5)'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Response Time Distribution'
          }
        }
      }
    });
    
    // Concurrency chart
    const concurrencyCtx = document.getElementById('concurrencyChart').getContext('2d');
    new Chart(concurrencyCtx, {
      type: 'line',
      data: {
        labels: ${JSON.stringify(report.metrics.concurrency.map(c => new Date(c.timestamp).toLocaleTimeString()))},
        datasets: [{
          label: 'Active Users',
          data: ${JSON.stringify(report.metrics.concurrency.map(c => c.value))},
          borderColor: 'rgb(255, 99, 132)',
          tension: 0.1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'User Concurrency Over Time'
          }
        }
      }
    });
  </script>
</body>
</html>
    `;
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Stop test
   */
  async stop() {
    console.log('Stopping load test...');
    this.state.status = 'stopping';
    
    // Wait for current operations to complete
    await this.sleep(5000);
    
    // Finalize
    await this.finalize();
  }
}

// Export factory function
export function createLoadTestFramework(config) {
  return new LoadTestFramework(config);
}

export default LoadTestFramework;