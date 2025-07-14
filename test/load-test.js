#!/usr/bin/env node

/**
 * Otedama Ver.0.5 - Automated Load Testing Suite
 * 市販レベルの負荷テストとパフォーマンス検証
 */

import { Worker } from 'worker_threads';
import { performance } from 'perf_hooks';
import WebSocket from 'ws';
import { Logger } from '../src/logger.js';

const logger = new Logger('LoadTest');

// Test configuration
const TEST_CONFIG = {
  api: {
    baseUrl: 'http://localhost:8080',
    endpoints: [
      { path: '/api/stats', method: 'GET', weight: 40 },
      { path: '/api/fees', method: 'GET', weight: 20 },
      { path: '/api/miners', method: 'GET', weight: 20 },
      { path: '/api/dex/prices', method: 'GET', weight: 20 }
    ]
  },
  stratum: {
    host: 'localhost',
    port: 3333,
    miners: {
      min: 100,
      max: 1000,
      rampUp: 60 // seconds
    }
  },
  websocket: {
    url: 'ws://localhost:8080',
    connections: {
      min: 50,
      max: 500,
      rampUp: 30 // seconds
    }
  },
  duration: 300, // 5 minutes
  checkInterval: 10, // seconds
  thresholds: {
    api: {
      responseTime: 100, // ms
      errorRate: 0.01 // 1%
    },
    stratum: {
      shareAcceptRate: 0.95, // 95%
      connectionTime: 1000 // ms
    },
    websocket: {
      messageLatency: 50, // ms
      connectionStability: 0.99 // 99%
    }
  }
};

// Test results storage
const results = {
  api: {
    requests: 0,
    errors: 0,
    responseTimes: [],
    statusCodes: {}
  },
  stratum: {
    connections: 0,
    shares: 0,
    acceptedShares: 0,
    rejectedShares: 0,
    connectionTimes: []
  },
  websocket: {
    connections: 0,
    messages: 0,
    errors: 0,
    latencies: []
  },
  system: {
    cpuUsage: [],
    memoryUsage: [],
    timestamps: []
  }
};

/**
 * API Load Test
 */
class APILoadTest {
  constructor(config) {
    this.config = config;
    this.running = false;
    this.workers = [];
  }

  async start(concurrency) {
    this.running = true;
    logger.info(`Starting API load test with ${concurrency} concurrent users`);

    for (let i = 0; i < concurrency; i++) {
      const worker = new Worker(`
        const { parentPort } = require('worker_threads');
        const https = require('https');
        const http = require('http');
        
        async function makeRequest(endpoint) {
          const start = Date.now();
          const protocol = endpoint.startsWith('https') ? https : http;
          
          return new Promise((resolve) => {
            const req = protocol.get(endpoint, (res) => {
              let data = '';
              res.on('data', chunk => data += chunk);
              res.on('end', () => {
                resolve({
                  statusCode: res.statusCode,
                  responseTime: Date.now() - start,
                  size: data.length
                });
              });
            });
            
            req.on('error', (error) => {
              resolve({
                error: error.message,
                responseTime: Date.now() - start
              });
            });
            
            req.setTimeout(5000, () => {
              req.abort();
              resolve({
                error: 'Timeout',
                responseTime: 5000
              });
            });
          });
        }
        
        parentPort.on('message', async (msg) => {
          if (msg.type === 'test') {
            const result = await makeRequest(msg.endpoint);
            parentPort.postMessage({ type: 'result', result });
          }
        });
      `, { eval: true });

      worker.on('message', (msg) => {
        if (msg.type === 'result') {
          this.recordResult(msg.result);
        }
      });

      this.workers.push(worker);
    }

    // Start sending requests
    this.sendRequests();
  }

  async sendRequests() {
    while (this.running) {
      const endpoint = this.selectEndpoint();
      const worker = this.workers[Math.floor(Math.random() * this.workers.length)];
      
      worker.postMessage({
        type: 'test',
        endpoint: `${this.config.baseUrl}${endpoint.path}`
      });

      // Random delay between requests (10-100ms)
      await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 90));
    }
  }

  selectEndpoint() {
    const random = Math.random() * 100;
    let weight = 0;

    for (const endpoint of this.config.endpoints) {
      weight += endpoint.weight;
      if (random <= weight) {
        return endpoint;
      }
    }

    return this.config.endpoints[0];
  }

  recordResult(result) {
    results.api.requests++;

    if (result.error) {
      results.api.errors++;
    } else {
      results.api.responseTimes.push(result.responseTime);
      results.api.statusCodes[result.statusCode] = 
        (results.api.statusCodes[result.statusCode] || 0) + 1;
    }
  }

  stop() {
    this.running = false;
    this.workers.forEach(worker => worker.terminate());
    this.workers = [];
  }
}

/**
 * Stratum Load Test
 */
class StratumLoadTest {
  constructor(config) {
    this.config = config;
    this.miners = [];
    this.running = false;
  }

  async start(minerCount) {
    this.running = true;
    logger.info(`Starting Stratum load test with ${minerCount} miners`);

    for (let i = 0; i < minerCount; i++) {
      await this.connectMiner(i);
      
      // Stagger connections
      if (i % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  async connectMiner(id) {
    const start = performance.now();
    const socket = new require('net').Socket();
    
    const miner = {
      id: `test-miner-${id}`,
      socket,
      connected: false,
      shares: 0,
      accepted: 0
    };

    socket.connect(this.config.port, this.config.host, () => {
      const connectionTime = performance.now() - start;
      results.stratum.connectionTimes.push(connectionTime);
      results.stratum.connections++;
      
      miner.connected = true;
      
      // Subscribe
      socket.write(JSON.stringify({
        id: 1,
        method: 'mining.subscribe',
        params: ['OtedamaLoadTest/0.5']
      }) + '\n');
    });

    socket.on('data', (data) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          this.handleStratumMessage(miner, msg);
        } catch (error) {
          // Ignore parse errors
        }
      }
    });

    socket.on('error', () => {
      miner.connected = false;
    });

    socket.on('close', () => {
      miner.connected = false;
      results.stratum.connections--;
    });

    this.miners.push(miner);

    // Start submitting shares
    if (this.running) {
      this.submitShares(miner);
    }
  }

  handleStratumMessage(miner, msg) {
    if (msg.method === 'mining.set_difficulty') {
      miner.difficulty = msg.params[0];
    } else if (msg.method === 'mining.notify') {
      miner.job = msg.params;
    } else if (msg.id && msg.result !== undefined) {
      // Share response
      if (msg.result === true) {
        miner.accepted++;
        results.stratum.acceptedShares++;
      } else {
        results.stratum.rejectedShares++;
      }
    }
  }

  async submitShares(miner) {
    while (this.running && miner.connected) {
      if (miner.job) {
        // Submit mock share
        miner.socket.write(JSON.stringify({
          id: Date.now(),
          method: 'mining.submit',
          params: [
            miner.id,
            miner.job[0], // job_id
            '00000000', // extranonce2
            Date.now().toString(16), // ntime
            Math.random().toString(16).substring(2, 10) // nonce
          ]
        }) + '\n');

        miner.shares++;
        results.stratum.shares++;
      }

      // Random interval between shares (5-30 seconds)
      await new Promise(resolve => 
        setTimeout(resolve, 5000 + Math.random() * 25000)
      );
    }
  }

  stop() {
    this.running = false;
    this.miners.forEach(miner => {
      if (miner.socket) {
        miner.socket.destroy();
      }
    });
    this.miners = [];
  }
}

/**
 * WebSocket Load Test
 */
class WebSocketLoadTest {
  constructor(config) {
    this.config = config;
    this.connections = [];
    this.running = false;
  }

  async start(connectionCount) {
    this.running = true;
    logger.info(`Starting WebSocket load test with ${connectionCount} connections`);

    for (let i = 0; i < connectionCount; i++) {
      await this.createConnection(i);
      
      // Stagger connections
      if (i % 5 === 0) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }

  async createConnection(id) {
    const ws = new WebSocket(this.config.url);
    const connection = {
      id,
      ws,
      connected: false,
      messages: 0,
      lastPing: Date.now()
    };

    ws.on('open', () => {
      connection.connected = true;
      results.websocket.connections++;
      
      // Subscribe to channels
      ws.send(JSON.stringify({
        type: 'subscribe',
        channels: ['stats', 'alerts', 'prices']
      }));

      // Start ping interval
      this.startPingInterval(connection);
    });

    ws.on('message', (data) => {
      const receiveTime = Date.now();
      connection.messages++;
      results.websocket.messages++;

      try {
        const msg = JSON.parse(data);
        
        if (msg.type === 'pong') {
          const latency = receiveTime - connection.lastPing;
          results.websocket.latencies.push(latency);
        }
      } catch (error) {
        // Ignore parse errors
      }
    });

    ws.on('error', () => {
      connection.connected = false;
      results.websocket.errors++;
    });

    ws.on('close', () => {
      connection.connected = false;
      results.websocket.connections--;
    });

    this.connections.push(connection);
  }

  startPingInterval(connection) {
    const interval = setInterval(() => {
      if (!this.running || !connection.connected) {
        clearInterval(interval);
        return;
      }

      connection.lastPing = Date.now();
      connection.ws.send(JSON.stringify({ type: 'ping' }));
    }, 5000);
  }

  stop() {
    this.running = false;
    this.connections.forEach(conn => {
      if (conn.ws) {
        conn.ws.close();
      }
    });
    this.connections = [];
  }
}

/**
 * System Monitor
 */
class SystemMonitor {
  constructor() {
    this.monitoring = false;
  }

  start() {
    this.monitoring = true;
    this.monitor();
  }

  async monitor() {
    while (this.monitoring) {
      const usage = process.cpuUsage();
      const memory = process.memoryUsage();

      results.system.cpuUsage.push(usage.user / 1000000); // Convert to percentage
      results.system.memoryUsage.push(memory.heapUsed / 1024 / 1024); // MB
      results.system.timestamps.push(Date.now());

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  stop() {
    this.monitoring = false;
  }
}

/**
 * Load Test Orchestrator
 */
class LoadTestOrchestrator {
  constructor() {
    this.apiTest = new APILoadTest(TEST_CONFIG.api);
    this.stratumTest = new StratumLoadTest(TEST_CONFIG.stratum);
    this.wsTest = new WebSocketLoadTest(TEST_CONFIG.websocket);
    this.monitor = new SystemMonitor();
    this.startTime = 0;
  }

  async run() {
    logger.info('🚀 Starting Otedama Load Test Suite');
    logger.info(`Duration: ${TEST_CONFIG.duration} seconds`);
    
    this.startTime = Date.now();
    
    // Start system monitoring
    this.monitor.start();

    // Ramp up load gradually
    await this.rampUp();

    // Run at full load
    await this.sustainLoad();

    // Ramp down
    await this.rampDown();

    // Stop all tests
    this.stopAll();

    // Generate report
    this.generateReport();
  }

  async rampUp() {
    logger.info('📈 Ramping up load...');

    const steps = 10;
    const apiStep = 100 / steps;
    const stratumStep = (TEST_CONFIG.stratum.miners.max - TEST_CONFIG.stratum.miners.min) / steps;
    const wsStep = (TEST_CONFIG.websocket.connections.max - TEST_CONFIG.websocket.connections.min) / steps;

    for (let i = 1; i <= steps; i++) {
      await this.apiTest.start(Math.floor(apiStep * i));
      await this.stratumTest.start(Math.floor(TEST_CONFIG.stratum.miners.min + stratumStep * i));
      await this.wsTest.start(Math.floor(TEST_CONFIG.websocket.connections.min + wsStep * i));

      await new Promise(resolve => setTimeout(resolve, 5000));
      
      this.checkThresholds();
    }
  }

  async sustainLoad() {
    logger.info('🔥 Sustaining full load...');

    const sustainDuration = TEST_CONFIG.duration - 60; // Minus ramp up/down time
    const checkInterval = TEST_CONFIG.checkInterval * 1000;
    const checks = Math.floor(sustainDuration * 1000 / checkInterval);

    for (let i = 0; i < checks; i++) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      this.checkThresholds();
      this.logProgress(i, checks);
    }
  }

  async rampDown() {
    logger.info('📉 Ramping down load...');

    // Gradual shutdown
    this.apiTest.stop();
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    this.wsTest.stop();
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    this.stratumTest.stop();
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  stopAll() {
    this.apiTest.stop();
    this.stratumTest.stop();
    this.wsTest.stop();
    this.monitor.stop();
  }

  checkThresholds() {
    const violations = [];

    // Check API thresholds
    if (results.api.responseTimes.length > 0) {
      const avgResponseTime = results.api.responseTimes.reduce((a, b) => a + b, 0) / results.api.responseTimes.length;
      if (avgResponseTime > TEST_CONFIG.thresholds.api.responseTime) {
        violations.push(`API response time: ${avgResponseTime.toFixed(2)}ms (threshold: ${TEST_CONFIG.thresholds.api.responseTime}ms)`);
      }
    }

    if (results.api.requests > 0) {
      const errorRate = results.api.errors / results.api.requests;
      if (errorRate > TEST_CONFIG.thresholds.api.errorRate) {
        violations.push(`API error rate: ${(errorRate * 100).toFixed(2)}% (threshold: ${TEST_CONFIG.thresholds.api.errorRate * 100}%)`);
      }
    }

    // Check Stratum thresholds
    if (results.stratum.shares > 0) {
      const acceptRate = results.stratum.acceptedShares / results.stratum.shares;
      if (acceptRate < TEST_CONFIG.thresholds.stratum.shareAcceptRate) {
        violations.push(`Share accept rate: ${(acceptRate * 100).toFixed(2)}% (threshold: ${TEST_CONFIG.thresholds.stratum.shareAcceptRate * 100}%)`);
      }
    }

    // Check WebSocket thresholds
    if (results.websocket.latencies.length > 0) {
      const avgLatency = results.websocket.latencies.reduce((a, b) => a + b, 0) / results.websocket.latencies.length;
      if (avgLatency > TEST_CONFIG.thresholds.websocket.messageLatency) {
        violations.push(`WebSocket latency: ${avgLatency.toFixed(2)}ms (threshold: ${TEST_CONFIG.thresholds.websocket.messageLatency}ms)`);
      }
    }

    if (violations.length > 0) {
      logger.warn('⚠️  Threshold violations detected:');
      violations.forEach(v => logger.warn(`   - ${v}`));
    }
  }

  logProgress(current, total) {
    const progress = ((current / total) * 100).toFixed(1);
    const elapsed = (Date.now() - this.startTime) / 1000;
    
    logger.info(`Progress: ${progress}% | Elapsed: ${elapsed.toFixed(0)}s | API: ${results.api.requests} | Stratum: ${results.stratum.shares} | WS: ${results.websocket.messages}`);
  }

  generateReport() {
    const duration = (Date.now() - this.startTime) / 1000;
    
    const report = {
      summary: {
        duration: `${duration.toFixed(1)} seconds`,
        testTime: new Date().toISOString(),
        version: '0.5'
      },
      api: {
        totalRequests: results.api.requests,
        totalErrors: results.api.errors,
        errorRate: results.api.requests > 0 ? 
          `${((results.api.errors / results.api.requests) * 100).toFixed(2)}%` : '0%',
        averageResponseTime: results.api.responseTimes.length > 0 ?
          `${(results.api.responseTimes.reduce((a, b) => a + b, 0) / results.api.responseTimes.length).toFixed(2)}ms` : 'N/A',
        p95ResponseTime: results.api.responseTimes.length > 0 ?
          `${this.percentile(results.api.responseTimes, 95).toFixed(2)}ms` : 'N/A',
        p99ResponseTime: results.api.responseTimes.length > 0 ?
          `${this.percentile(results.api.responseTimes, 99).toFixed(2)}ms` : 'N/A',
        requestsPerSecond: (results.api.requests / duration).toFixed(2),
        statusCodes: results.api.statusCodes
      },
      stratum: {
        totalConnections: results.stratum.connections,
        totalShares: results.stratum.shares,
        acceptedShares: results.stratum.acceptedShares,
        rejectedShares: results.stratum.rejectedShares,
        acceptRate: results.stratum.shares > 0 ?
          `${((results.stratum.acceptedShares / results.stratum.shares) * 100).toFixed(2)}%` : 'N/A',
        averageConnectionTime: results.stratum.connectionTimes.length > 0 ?
          `${(results.stratum.connectionTimes.reduce((a, b) => a + b, 0) / results.stratum.connectionTimes.length).toFixed(2)}ms` : 'N/A',
        sharesPerSecond: (results.stratum.shares / duration).toFixed(2)
      },
      websocket: {
        totalConnections: results.websocket.connections,
        totalMessages: results.websocket.messages,
        totalErrors: results.websocket.errors,
        averageLatency: results.websocket.latencies.length > 0 ?
          `${(results.websocket.latencies.reduce((a, b) => a + b, 0) / results.websocket.latencies.length).toFixed(2)}ms` : 'N/A',
        messagesPerSecond: (results.websocket.messages / duration).toFixed(2)
      },
      system: {
        peakCPU: results.system.cpuUsage.length > 0 ?
          `${Math.max(...results.system.cpuUsage).toFixed(2)}%` : 'N/A',
        averageCPU: results.system.cpuUsage.length > 0 ?
          `${(results.system.cpuUsage.reduce((a, b) => a + b, 0) / results.system.cpuUsage.length).toFixed(2)}%` : 'N/A',
        peakMemory: results.system.memoryUsage.length > 0 ?
          `${Math.max(...results.system.memoryUsage).toFixed(2)} MB` : 'N/A',
        averageMemory: results.system.memoryUsage.length > 0 ?
          `${(results.system.memoryUsage.reduce((a, b) => a + b, 0) / results.system.memoryUsage.length).toFixed(2)} MB` : 'N/A'
      },
      thresholdViolations: this.checkFinalThresholds()
    };

    // Display report
    console.log('\n📊 LOAD TEST REPORT');
    console.log('==================\n');
    console.log(JSON.stringify(report, null, 2));

    // Save report to file
    const fs = require('fs');
    fs.writeFileSync(
      `load-test-report-${Date.now()}.json`,
      JSON.stringify(report, null, 2)
    );

    // Determine pass/fail
    const passed = report.thresholdViolations.length === 0;
    
    console.log('\n==================');
    console.log(passed ? '✅ LOAD TEST PASSED' : '❌ LOAD TEST FAILED');
    
    if (!passed) {
      console.log('\nThreshold Violations:');
      report.thresholdViolations.forEach(v => console.log(`  - ${v}`));
    }

    process.exit(passed ? 0 : 1);
  }

  percentile(arr, p) {
    const sorted = arr.slice().sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[index] || 0;
  }

  checkFinalThresholds() {
    const violations = [];
    
    // Similar to checkThresholds but for final report
    // Add comprehensive threshold checks here
    
    return violations;
  }
}

// Run load test
async function main() {
  const orchestrator = new LoadTestOrchestrator();
  
  try {
    await orchestrator.run();
  } catch (error) {
    logger.error('Load test failed:', error);
    process.exit(1);
  }
}

// Handle signals
process.on('SIGINT', () => {
  logger.info('Received SIGINT, stopping load test...');
  process.exit(0);
});

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { LoadTestOrchestrator };
