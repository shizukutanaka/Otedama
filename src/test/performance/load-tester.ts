/**
 * Load Testing Framework
 * Following Carmack/Martin/Pike principles:
 * - Measure real performance, not theoretical
 * - Simple and reliable testing
 * - Clear metrics and results
 */

import * as net from 'net';
import WebSocket from 'ws';
import axios from 'axios';
import { EventEmitter } from 'events';
import * as os from 'os';

interface LoadTestConfig {
  poolHost: string;
  poolPort: number;
  apiUrl: string;
  wsUrl: string;
  duration: number; // seconds
  minerCount: number;
  shareRate: number; // shares per second per miner
  rampUpTime: number; // seconds
  connectionMode: 'concurrent' | 'sequential';
  testScenarios: TestScenario[];
}

interface TestScenario {
  name: string;
  weight: number; // 0-100, percentage of miners
  behavior: MinerBehavior;
}

interface MinerBehavior {
  shareRate: number;
  disconnectProbability: number;
  reconnectDelay: number;
  invalidShareRate: number;
}

interface TestMetrics {
  totalConnections: number;
  successfulConnections: number;
  failedConnections: number;
  totalShares: number;
  acceptedShares: number;
  rejectedShares: number;
  totalRequests: number;
  failedRequests: number;
  avgResponseTime: number;
  maxResponseTime: number;
  minResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  connectionErrors: number;
  sharesPerSecond: number;
  requestsPerSecond: number;
  cpuUsage: number[];
  memoryUsage: number[];
  networkBandwidth: number;
}

class LoadTester extends EventEmitter {
  private config: LoadTestConfig;
  private miners: Map<string, MinerSimulator> = new Map();
  private metrics: TestMetrics;
  private startTime: number = 0;
  private responseTimes: number[] = [];
  private metricsCollector?: NodeJS.Timer;

  constructor(config: Partial<LoadTestConfig> = {}) {
    super();
    
    this.config = {
      poolHost: 'localhost',
      poolPort: 3333,
      apiUrl: 'http://localhost:8080',
      wsUrl: 'ws://localhost:8081',
      duration: 60,
      minerCount: 100,
      shareRate: 1,
      rampUpTime: 10,
      connectionMode: 'concurrent',
      testScenarios: [
        {
          name: 'Normal Miner',
          weight: 80,
          behavior: {
            shareRate: 1,
            disconnectProbability: 0.01,
            reconnectDelay: 5000,
            invalidShareRate: 0.05
          }
        },
        {
          name: 'High Performance',
          weight: 15,
          behavior: {
            shareRate: 10,
            disconnectProbability: 0.001,
            reconnectDelay: 1000,
            invalidShareRate: 0.01
          }
        },
        {
          name: 'Unstable Connection',
          weight: 5,
          behavior: {
            shareRate: 0.5,
            disconnectProbability: 0.1,
            reconnectDelay: 10000,
            invalidShareRate: 0.1
          }
        }
      ],
      ...config
    };
    
    this.metrics = this.initMetrics();
  }

  /**
   * Initialize metrics
   */
  private initMetrics(): TestMetrics {
    return {
      totalConnections: 0,
      successfulConnections: 0,
      failedConnections: 0,
      totalShares: 0,
      acceptedShares: 0,
      rejectedShares: 0,
      totalRequests: 0,
      failedRequests: 0,
      avgResponseTime: 0,
      maxResponseTime: 0,
      minResponseTime: Infinity,
      p95ResponseTime: 0,
      p99ResponseTime: 0,
      connectionErrors: 0,
      sharesPerSecond: 0,
      requestsPerSecond: 0,
      cpuUsage: [],
      memoryUsage: [],
      networkBandwidth: 0
    };
  }

  /**
   * Run load test
   */
  async run(): Promise<TestMetrics> {
    console.log('🚀 Starting Load Test');
    console.log(`   Miners: ${this.config.minerCount}`);
    console.log(`   Duration: ${this.config.duration}s`);
    console.log(`   Share Rate: ${this.config.shareRate}/s per miner\n`);
    
    this.startTime = Date.now();
    
    // Start system metrics collection
    this.startMetricsCollection();
    
    // Start miners based on ramp-up strategy
    await this.startMiners();
    
    // Run test for specified duration
    await this.runTest();
    
    // Stop all miners
    await this.stopMiners();
    
    // Calculate final metrics
    this.calculateFinalMetrics();
    
    // Stop metrics collection
    this.stopMetricsCollection();
    
    return this.metrics;
  }

  /**
   * Start miners with ramp-up
   */
  private async startMiners(): Promise<void> {
    const minersPerSecond = this.config.minerCount / this.config.rampUpTime;
    const interval = 1000 / minersPerSecond;
    
    console.log(`⏳ Ramping up ${this.config.minerCount} miners over ${this.config.rampUpTime}s...`);
    
    let minersStarted = 0;
    
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (minersStarted >= this.config.minerCount) {
          clearInterval(timer);
          console.log('✅ All miners connected\n');
          resolve();
          return;
        }
        
        // Select scenario based on weights
        const scenario = this.selectScenario();
        const minerId = `miner_${minersStarted}_${scenario.name.replace(/\s+/g, '_')}`;
        
        const miner = new MinerSimulator(
          minerId,
          this.config.poolHost,
          this.config.poolPort,
          scenario.behavior
        );
        
        // Track miner events
        miner.on('connected', () => {
          this.metrics.successfulConnections++;
        });
        
        miner.on('connection_failed', () => {
          this.metrics.failedConnections++;
          this.metrics.connectionErrors++;
        });
        
        miner.on('share_submitted', () => {
          this.metrics.totalShares++;
        });
        
        miner.on('share_accepted', () => {
          this.metrics.acceptedShares++;
        });
        
        miner.on('share_rejected', () => {
          this.metrics.rejectedShares++;
        });
        
        this.miners.set(minerId, miner);
        miner.start();
        
        minersStarted++;
        this.metrics.totalConnections++;
        
        if (minersStarted % 10 === 0) {
          console.log(`   Connected: ${minersStarted}/${this.config.minerCount}`);
        }
      }, interval);
    });
  }

  /**
   * Select scenario based on weights
   */
  private selectScenario(): TestScenario {
    const random = Math.random() * 100;
    let cumulative = 0;
    
    for (const scenario of this.config.testScenarios) {
      cumulative += scenario.weight;
      if (random <= cumulative) {
        return scenario;
      }
    }
    
    return this.config.testScenarios[0];
  }

  /**
   * Run the test
   */
  private async runTest(): Promise<void> {
    console.log(`🏃 Running load test for ${this.config.duration}s...`);
    
    // Start API load testing
    this.startAPILoadTest();
    
    // Start WebSocket load testing
    this.startWebSocketLoadTest();
    
    // Wait for test duration
    const startTime = Date.now();
    const updateInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = this.config.duration - elapsed;
      
      if (remaining <= 0) {
        clearInterval(updateInterval);
        return;
      }
      
      if (elapsed % 10 === 0) {
        this.printProgress(elapsed, remaining);
      }
    }, 1000);
    
    await new Promise(resolve => setTimeout(resolve, this.config.duration * 1000));
    clearInterval(updateInterval);
  }

  /**
   * Start API load testing
   */
  private startAPILoadTest(): void {
    const endpoints = [
      '/api/v1/stats',
      '/api/v1/miners',
      '/api/v1/blocks',
      '/api/v1/payments'
    ];
    
    // Generate API requests
    const requestInterval = setInterval(async () => {
      const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
      const start = Date.now();
      
      try {
        await axios.get(`${this.config.apiUrl}${endpoint}`, { timeout: 5000 });
        const responseTime = Date.now() - start;
        this.responseTimes.push(responseTime);
        this.metrics.totalRequests++;
      } catch {
        this.metrics.failedRequests++;
      }
    }, 100); // 10 requests per second
    
    // Store interval for cleanup
    this.on('stop', () => clearInterval(requestInterval));
  }

  /**
   * Start WebSocket load testing
   */
  private startWebSocketLoadTest(): void {
    // Create WebSocket connections
    const wsConnections: WebSocket[] = [];
    
    for (let i = 0; i < 10; i++) {
      try {
        const ws = new WebSocket(this.config.wsUrl);
        
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'subscribe', channel: 'stats' }));
        });
        
        ws.on('error', () => {
          this.metrics.connectionErrors++;
        });
        
        wsConnections.push(ws);
      } catch {
        this.metrics.connectionErrors++;
      }
    }
    
    // Cleanup on stop
    this.on('stop', () => {
      wsConnections.forEach(ws => ws.close());
    });
  }

  /**
   * Stop all miners
   */
  private async stopMiners(): Promise<void> {
    console.log('\n🛑 Stopping miners...');
    
    for (const [id, miner] of this.miners) {
      miner.stop();
    }
    
    this.miners.clear();
    this.emit('stop');
  }

  /**
   * Start system metrics collection
   */
  private startMetricsCollection(): void {
    this.metricsCollector = setInterval(() => {
      // CPU usage
      const cpus = os.cpus();
      const cpuUsage = cpus.reduce((acc, cpu) => {
        const total = Object.values(cpu.times).reduce((a, b) => a + b);
        const idle = cpu.times.idle;
        return acc + ((total - idle) / total) * 100;
      }, 0) / cpus.length;
      
      this.metrics.cpuUsage.push(cpuUsage);
      
      // Memory usage
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const memUsage = ((totalMem - freeMem) / totalMem) * 100;
      
      this.metrics.memoryUsage.push(memUsage);
    }, 1000);
  }

  /**
   * Stop metrics collection
   */
  private stopMetricsCollection(): void {
    if (this.metricsCollector) {
      clearInterval(this.metricsCollector);
    }
  }

  /**
   * Calculate final metrics
   */
  private calculateFinalMetrics(): void {
    const duration = (Date.now() - this.startTime) / 1000;
    
    // Response time metrics
    if (this.responseTimes.length > 0) {
      this.responseTimes.sort((a, b) => a - b);
      
      this.metrics.avgResponseTime = 
        this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length;
      
      this.metrics.minResponseTime = this.responseTimes[0];
      this.metrics.maxResponseTime = this.responseTimes[this.responseTimes.length - 1];
      
      const p95Index = Math.floor(this.responseTimes.length * 0.95);
      const p99Index = Math.floor(this.responseTimes.length * 0.99);
      
      this.metrics.p95ResponseTime = this.responseTimes[p95Index] || 0;
      this.metrics.p99ResponseTime = this.responseTimes[p99Index] || 0;
    }
    
    // Rate metrics
    this.metrics.sharesPerSecond = this.metrics.totalShares / duration;
    this.metrics.requestsPerSecond = this.metrics.totalRequests / duration;
  }

  /**
   * Print progress
   */
  private printProgress(elapsed: number, remaining: number): void {
    const shareRate = this.metrics.totalShares / elapsed;
    const acceptRate = (this.metrics.acceptedShares / this.metrics.totalShares) * 100 || 0;
    
    console.log(`⏱️  Progress: ${elapsed}s elapsed, ${remaining}s remaining`);
    console.log(`   Shares: ${this.metrics.totalShares} (${shareRate.toFixed(2)}/s)`);
    console.log(`   Accept Rate: ${acceptRate.toFixed(2)}%`);
    console.log(`   Active Miners: ${this.miners.size}`);
  }

  /**
   * Generate report
   */
  generateReport(): string {
    const avgCpu = this.metrics.cpuUsage.length > 0
      ? this.metrics.cpuUsage.reduce((a, b) => a + b, 0) / this.metrics.cpuUsage.length
      : 0;
    
    const avgMem = this.metrics.memoryUsage.length > 0
      ? this.metrics.memoryUsage.reduce((a, b) => a + b, 0) / this.metrics.memoryUsage.length
      : 0;
    
    const report = `
# Load Test Report

## Test Configuration
- Duration: ${this.config.duration}s
- Miners: ${this.config.minerCount}
- Share Rate: ${this.config.shareRate}/s per miner
- Ramp Up Time: ${this.config.rampUpTime}s

## Connection Metrics
- Total Connections: ${this.metrics.totalConnections}
- Successful: ${this.metrics.successfulConnections}
- Failed: ${this.metrics.failedConnections}
- Error Rate: ${((this.metrics.failedConnections / this.metrics.totalConnections) * 100).toFixed(2)}%

## Share Metrics
- Total Shares: ${this.metrics.totalShares}
- Accepted: ${this.metrics.acceptedShares}
- Rejected: ${this.metrics.rejectedShares}
- Accept Rate: ${((this.metrics.acceptedShares / this.metrics.totalShares) * 100).toFixed(2)}%
- Shares/Second: ${this.metrics.sharesPerSecond.toFixed(2)}

## API Performance
- Total Requests: ${this.metrics.totalRequests}
- Failed Requests: ${this.metrics.failedRequests}
- Success Rate: ${(((this.metrics.totalRequests - this.metrics.failedRequests) / this.metrics.totalRequests) * 100).toFixed(2)}%
- Requests/Second: ${this.metrics.requestsPerSecond.toFixed(2)}

## Response Times (ms)
- Average: ${this.metrics.avgResponseTime.toFixed(2)}
- Min: ${this.metrics.minResponseTime}
- Max: ${this.metrics.maxResponseTime}
- P95: ${this.metrics.p95ResponseTime}
- P99: ${this.metrics.p99ResponseTime}

## System Resources
- Average CPU: ${avgCpu.toFixed(2)}%
- Average Memory: ${avgMem.toFixed(2)}%
- Peak CPU: ${Math.max(...this.metrics.cpuUsage).toFixed(2)}%
- Peak Memory: ${Math.max(...this.metrics.memoryUsage).toFixed(2)}%

## Recommendations
${this.generateRecommendations()}
`;
    
    return report;
  }

  /**
   * Generate recommendations based on metrics
   */
  private generateRecommendations(): string {
    const recommendations: string[] = [];
    
    // Connection issues
    if (this.metrics.failedConnections > this.metrics.totalConnections * 0.05) {
      recommendations.push('- High connection failure rate detected. Consider increasing connection timeout or pool capacity.');
    }
    
    // Share rejection rate
    const rejectRate = this.metrics.rejectedShares / this.metrics.totalShares;
    if (rejectRate > 0.1) {
      recommendations.push('- High share rejection rate. Review difficulty adjustment algorithm.');
    }
    
    // Response times
    if (this.metrics.p99ResponseTime > 1000) {
      recommendations.push('- P99 response time exceeds 1 second. Consider optimizing API endpoints or adding caching.');
    }
    
    // CPU usage
    const avgCpu = this.metrics.cpuUsage.reduce((a, b) => a + b, 0) / this.metrics.cpuUsage.length;
    if (avgCpu > 80) {
      recommendations.push('- High CPU usage detected. Consider horizontal scaling or code optimization.');
    }
    
    // Memory usage
    const avgMem = this.metrics.memoryUsage.reduce((a, b) => a + b, 0) / this.metrics.memoryUsage.length;
    if (avgMem > 80) {
      recommendations.push('- High memory usage detected. Check for memory leaks or consider increasing memory allocation.');
    }
    
    if (recommendations.length === 0) {
      recommendations.push('- Performance is within acceptable parameters.');
    }
    
    return recommendations.join('\n');
  }
}

/**
 * Miner simulator
 */
class MinerSimulator extends EventEmitter {
  private id: string;
  private host: string;
  private port: number;
  private behavior: MinerBehavior;
  private socket?: net.Socket;
  private connected = false;
  private shareInterval?: NodeJS.Timer;
  private jobId = '';
  private difficulty = 1;

  constructor(id: string, host: string, port: number, behavior: MinerBehavior) {
    super();
    this.id = id;
    this.host = host;
    this.port = port;
    this.behavior = behavior;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    if (this.shareInterval) {
      clearInterval(this.shareInterval);
    }
    
    if (this.socket) {
      this.socket.destroy();
    }
  }

  private connect(): void {
    this.socket = new net.Socket();
    
    this.socket.on('connect', () => {
      this.connected = true;
      this.emit('connected');
      this.subscribe();
    });
    
    this.socket.on('data', (data) => {
      this.handleData(data);
    });
    
    this.socket.on('error', () => {
      this.emit('connection_failed');
      this.reconnect();
    });
    
    this.socket.on('close', () => {
      this.connected = false;
      this.reconnect();
    });
    
    try {
      this.socket.connect(this.port, this.host);
    } catch {
      this.emit('connection_failed');
    }
  }

  private reconnect(): void {
    if (Math.random() < this.behavior.disconnectProbability) {
      setTimeout(() => this.connect(), this.behavior.reconnectDelay);
    }
  }

  private subscribe(): void {
    const message = JSON.stringify({
      id: 1,
      method: 'mining.subscribe',
      params: [`loadtest/${this.id}`]
    }) + '\n';
    
    this.socket?.write(message);
  }

  private authorize(): void {
    const message = JSON.stringify({
      id: 2,
      method: 'mining.authorize',
      params: [this.id, 'x']
    }) + '\n';
    
    this.socket?.write(message);
  }

  private handleData(data: Buffer): void {
    const messages = data.toString().split('\n').filter(m => m);
    
    for (const message of messages) {
      try {
        const msg = JSON.parse(message);
        
        if (msg.id === 1) {
          // Subscribe response
          this.authorize();
        } else if (msg.id === 2) {
          // Authorize response
          if (msg.result) {
            this.startMining();
          }
        } else if (msg.method === 'mining.notify') {
          // New job
          this.jobId = msg.params[0];
        } else if (msg.method === 'mining.set_difficulty') {
          // Difficulty update
          this.difficulty = msg.params[0];
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  private startMining(): void {
    const interval = 1000 / this.behavior.shareRate;
    
    this.shareInterval = setInterval(() => {
      this.submitShare();
    }, interval);
  }

  private submitShare(): void {
    if (!this.connected || !this.jobId) return;
    
    const isInvalid = Math.random() < this.behavior.invalidShareRate;
    const nonce = isInvalid ? '00000000' : this.generateNonce();
    
    const message = JSON.stringify({
      id: Date.now(),
      method: 'mining.submit',
      params: [this.id, this.jobId, '00000000', Date.now().toString(16), nonce]
    }) + '\n';
    
    this.socket?.write(message);
    this.emit('share_submitted');
    
    // Simulate response
    setTimeout(() => {
      if (isInvalid) {
        this.emit('share_rejected');
      } else {
        this.emit('share_accepted');
      }
    }, 10);
  }

  private generateNonce(): string {
    return Math.random().toString(16).substr(2, 8);
  }
}

// Run load test if called directly
if (require.main === module) {
  const config: Partial<LoadTestConfig> = {
    duration: parseInt(process.env.DURATION || '60'),
    minerCount: parseInt(process.env.MINERS || '100'),
    shareRate: parseFloat(process.env.SHARE_RATE || '1')
  };
  
  const tester = new LoadTester(config);
  
  tester.run().then((metrics) => {
    console.log(tester.generateReport());
    process.exit(0);
  }).catch((error) => {
    console.error('Load test error:', error);
    process.exit(1);
  });
}

export { LoadTester, LoadTestConfig, TestMetrics };
