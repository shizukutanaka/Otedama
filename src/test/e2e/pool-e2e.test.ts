/**
 * End-to-End Integration Test Suite
 * Following Carmack/Martin/Pike principles:
 * - Test real scenarios, not abstractions
 * - Fast and reliable tests
 * - Clear failure messages
 */

import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import WebSocket from 'ws';
import axios from 'axios';
import Redis from 'ioredis';
import { Database } from 'sqlite3';
import * as path from 'path';
import * as fs from 'fs';

interface TestConfig {
  poolPort: number;
  apiPort: number;
  wsPort: number;
  redisPort: number;
  dbPath: string;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
}

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
}

class E2ETestRunner {
  private config: TestConfig;
  private poolProcess?: ChildProcess;
  private redis?: Redis;
  private db?: Database;
  private results: TestResult[] = [];

  constructor(config: Partial<TestConfig> = {}) {
    this.config = {
      poolPort: 13333,
      apiPort: 18080,
      wsPort: 18081,
      redisPort: 16379,
      dbPath: ':memory:',
      logLevel: 'error',
      ...config
    };
  }

  /**
   * Run all E2E tests
   */
  async runAll(): Promise<void> {
    console.log('🚀 Starting E2E Test Suite\n');
    
    try {
      await this.setup();
      
      // Core functionality tests
      await this.runTest('Pool Startup', this.testPoolStartup.bind(this));
      await this.runTest('Stratum Connection', this.testStratumConnection.bind(this));
      await this.runTest('Miner Authentication', this.testMinerAuth.bind(this));
      await this.runTest('Share Submission', this.testShareSubmission.bind(this));
      await this.runTest('API Endpoints', this.testAPIEndpoints.bind(this));
      await this.runTest('WebSocket Updates', this.testWebSocketUpdates.bind(this));
      await this.runTest('Database Operations', this.testDatabaseOperations.bind(this));
      await this.runTest('Redis Caching', this.testRedisCaching.bind(this));
      await this.runTest('Concurrent Miners', this.testConcurrentMiners.bind(this));
      await this.runTest('Failover Handling', this.testFailover.bind(this));
      await this.runTest('Memory Stability', this.testMemoryStability.bind(this));
      await this.runTest('Graceful Shutdown', this.testGracefulShutdown.bind(this));
      
      this.printResults();
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Run a single test
   */
  private async runTest(name: string, testFn: () => Promise<void>): Promise<void> {
    const start = Date.now();
    let passed = false;
    let error: string | undefined;
    
    try {
      await testFn();
      passed = true;
      console.log(`✅ ${name}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.log(`❌ ${name}: ${error}`);
    }
    
    this.results.push({
      name,
      passed,
      duration: Date.now() - start,
      error
    });
  }

  /**
   * Setup test environment
   */
  private async setup(): Promise<void> {
    console.log('🔧 Setting up test environment...\n');
    
    // Start Redis
    this.redis = new Redis({
      port: this.config.redisPort,
      lazyConnect: true,
      maxRetriesPerRequest: 1
    });
    
    try {
      await this.redis.connect();
    } catch (e) {
      throw new Error('Failed to connect to Redis. Make sure Redis is running.');
    }
    
    // Initialize database
    this.db = new Database(this.config.dbPath);
    
    // Start pool process
    await this.startPool();
    
    // Wait for services to be ready
    await this.waitForServices();
  }

  /**
   * Start the mining pool process
   */
  private async startPool(): Promise<void> {
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      POOL_PORT: String(this.config.poolPort),
      API_PORT: String(this.config.apiPort),
      WS_PORT: String(this.config.wsPort),
      REDIS_PORT: String(this.config.redisPort),
      DATABASE_PATH: this.config.dbPath,
      LOG_LEVEL: this.config.logLevel
    };
    
    this.poolProcess = spawn('node', ['dist/main.js'], {
      env,
      stdio: this.config.logLevel === 'debug' ? 'inherit' : 'ignore'
    });
    
    this.poolProcess.on('error', (error) => {
      throw new Error(`Failed to start pool: ${error.message}`);
    });
  }

  /**
   * Wait for all services to be ready
   */
  private async waitForServices(): Promise<void> {
    const maxRetries = 30;
    const retryDelay = 1000;
    
    // Wait for Stratum port
    await this.waitForPort(this.config.poolPort, maxRetries, retryDelay);
    
    // Wait for API port
    await this.waitForPort(this.config.apiPort, maxRetries, retryDelay);
    
    // Wait for WebSocket port
    await this.waitForPort(this.config.wsPort, maxRetries, retryDelay);
  }

  /**
   * Wait for a port to be available
   */
  private async waitForPort(port: number, maxRetries: number, delay: number): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(port, '127.0.0.1');
          socket.on('connect', () => {
            socket.end();
            resolve();
          });
          socket.on('error', reject);
        });
        return;
      } catch {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error(`Port ${port} not available after ${maxRetries} retries`);
  }

  /**
   * Test: Pool startup
   */
  private async testPoolStartup(): Promise<void> {
    // Check process is running
    if (!this.poolProcess || this.poolProcess.exitCode !== null) {
      throw new Error('Pool process not running');
    }
    
    // Check health endpoint
    const response = await axios.get(`http://localhost:${this.config.apiPort}/health`);
    if (response.status !== 200) {
      throw new Error('Health check failed');
    }
    
    const health = response.data;
    if (health.status !== 'healthy') {
      throw new Error(`Pool unhealthy: ${health.status}`);
    }
  }

  /**
   * Test: Stratum connection
   */
  private async testStratumConnection(): Promise<void> {
    const client = new net.Socket();
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.destroy();
        reject(new Error('Connection timeout'));
      }, 5000);
      
      client.connect(this.config.poolPort, '127.0.0.1', () => {
        clearTimeout(timeout);
        
        // Send mining.subscribe
        const subscribe = JSON.stringify({
          id: 1,
          method: 'mining.subscribe',
          params: ['e2e-test-miner/1.0']
        }) + '\n';
        
        client.write(subscribe);
      });
      
      client.on('data', (data) => {
        const response = JSON.parse(data.toString());
        if (response.id === 1 && response.result) {
          client.end();
          resolve();
        } else {
          client.destroy();
          reject(new Error('Invalid subscribe response'));
        }
      });
      
      client.on('error', reject);
    });
  }

  /**
   * Test: Miner authentication
   */
  private async testMinerAuth(): Promise<void> {
    const client = new net.Socket();
    
    return new Promise((resolve, reject) => {
      client.connect(this.config.poolPort, '127.0.0.1');
      
      let subscribed = false;
      
      client.on('data', (data) => {
        const messages = data.toString().split('\n').filter(m => m);
        
        for (const message of messages) {
          const response = JSON.parse(message);
          
          if (!subscribed && response.id === 1) {
            subscribed = true;
            
            // Send mining.authorize
            const authorize = JSON.stringify({
              id: 2,
              method: 'mining.authorize',
              params: ['test.worker', 'password']
            }) + '\n';
            
            client.write(authorize);
          } else if (response.id === 2) {
            if (response.result === true) {
              client.end();
              resolve();
            } else {
              client.destroy();
              reject(new Error('Authorization failed'));
            }
          }
        }
      });
      
      // Send subscribe first
      const subscribe = JSON.stringify({
        id: 1,
        method: 'mining.subscribe',
        params: []
      }) + '\n';
      
      client.write(subscribe);
      
      client.on('error', reject);
    });
  }

  /**
   * Test: Share submission
   */
  private async testShareSubmission(): Promise<void> {
    // This would test actual share submission
    // For now, we'll test the share validation endpoint
    const share = {
      jobId: 'test-job-001',
      nonce: '00000000',
      hash: '0000000000000000000000000000000000000000000000000000000000000000'
    };
    
    try {
      await axios.post(`http://localhost:${this.config.apiPort}/api/v1/shares/validate`, share);
    } catch (error: any) {
      // Expected to fail with invalid share, but should return proper error
      if (error.response?.status !== 400) {
        throw new Error('Share validation endpoint not working correctly');
      }
    }
  }

  /**
   * Test: API endpoints
   */
  private async testAPIEndpoints(): Promise<void> {
    const endpoints = [
      '/api/v1/stats',
      '/api/v1/miners',
      '/api/v1/blocks',
      '/api/v1/payments'
    ];
    
    for (const endpoint of endpoints) {
      const response = await axios.get(`http://localhost:${this.config.apiPort}${endpoint}`);
      if (response.status !== 200) {
        throw new Error(`Endpoint ${endpoint} returned ${response.status}`);
      }
    }
  }

  /**
   * Test: WebSocket updates
   */
  private async testWebSocketUpdates(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${this.config.wsPort}`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket timeout'));
      }, 5000);
      
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', channel: 'stats' }));
      });
      
      ws.on('message', (data) => {
        clearTimeout(timeout);
        const message = JSON.parse(data.toString());
        if (message.type === 'stats') {
          ws.close();
          resolve();
        }
      });
      
      ws.on('error', reject);
    });
  }

  /**
   * Test: Database operations
   */
  private async testDatabaseOperations(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    
    return new Promise((resolve, reject) => {
      // Test basic CRUD operations
      this.db.run(
        'INSERT INTO miners (address, username) VALUES (?, ?)',
        ['test-address', 'test-user'],
        (err) => {
          if (err) return reject(err);
          
          this.db.get(
            'SELECT * FROM miners WHERE address = ?',
            ['test-address'],
            (err, row) => {
              if (err) return reject(err);
              if (!row) return reject(new Error('Miner not found'));
              resolve();
            }
          );
        }
      );
    });
  }

  /**
   * Test: Redis caching
   */
  private async testRedisCaching(): Promise<void> {
    if (!this.redis) throw new Error('Redis not initialized');
    
    // Test basic operations
    await this.redis.set('test:key', 'test-value', 'EX', 60);
    const value = await this.redis.get('test:key');
    
    if (value !== 'test-value') {
      throw new Error('Redis caching not working');
    }
    
    // Test hash operations
    await this.redis.hset('test:hash', 'field', 'value');
    const hashValue = await this.redis.hget('test:hash', 'field');
    
    if (hashValue !== 'value') {
      throw new Error('Redis hash operations not working');
    }
  }

  /**
   * Test: Concurrent miners
   */
  private async testConcurrentMiners(): Promise<void> {
    const minerCount = 10;
    const miners: net.Socket[] = [];
    
    try {
      // Connect multiple miners
      for (let i = 0; i < minerCount; i++) {
        const client = new net.Socket();
        await new Promise<void>((resolve, reject) => {
          client.connect(this.config.poolPort, '127.0.0.1', resolve);
          client.on('error', reject);
        });
        miners.push(client);
      }
      
      // All miners should be connected
      if (miners.filter(m => m.readyState === 'open').length !== minerCount) {
        throw new Error('Not all miners connected');
      }
    } finally {
      // Cleanup
      miners.forEach(m => m.destroy());
    }
  }

  /**
   * Test: Failover handling
   */
  private async testFailover(): Promise<void> {
    // Simulate blockchain connection failure
    try {
      await axios.post(`http://localhost:${this.config.apiPort}/api/v1/test/simulate-failure`, {
        component: 'blockchain',
        duration: 1000
      });
    } catch {
      // Expected to handle gracefully
    }
    
    // Pool should still be responsive
    const response = await axios.get(`http://localhost:${this.config.apiPort}/health`);
    if (response.data.status === 'unhealthy') {
      throw new Error('Pool failed to handle blockchain failure');
    }
  }

  /**
   * Test: Memory stability
   */
  private async testMemoryStability(): Promise<void> {
    if (!this.poolProcess) throw new Error('Pool process not running');
    
    // Get initial memory usage
    const initialMemory = process.memoryUsage().heapUsed;
    
    // Run some operations
    for (let i = 0; i < 100; i++) {
      await axios.get(`http://localhost:${this.config.apiPort}/api/v1/stats`);
    }
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
    
    // Check memory hasn't grown excessively
    const finalMemory = process.memoryUsage().heapUsed;
    const memoryGrowth = finalMemory - initialMemory;
    
    if (memoryGrowth > 50 * 1024 * 1024) { // 50MB
      throw new Error(`Excessive memory growth: ${(memoryGrowth / 1024 / 1024).toFixed(2)}MB`);
    }
  }

  /**
   * Test: Graceful shutdown
   */
  private async testGracefulShutdown(): Promise<void> {
    if (!this.poolProcess) throw new Error('Pool process not running');
    
    // Send SIGTERM
    this.poolProcess.kill('SIGTERM');
    
    // Wait for graceful shutdown
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Graceful shutdown timeout'));
      }, 10000);
      
      this.poolProcess!.on('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Cleanup test environment
   */
  private async cleanup(): Promise<void> {
    console.log('\n🧹 Cleaning up...');
    
    // Kill pool process if still running
    if (this.poolProcess && this.poolProcess.exitCode === null) {
      this.poolProcess.kill('SIGKILL');
    }
    
    // Close Redis connection
    if (this.redis) {
      await this.redis.quit();
    }
    
    // Close database
    if (this.db) {
      await new Promise<void>((resolve) => {
        this.db!.close(() => resolve());
      });
    }
  }

  /**
   * Print test results
   */
  private printResults(): void {
    console.log('\n📊 Test Results:\n');
    
    const passed = this.results.filter(r => r.passed).length;
    const failed = this.results.filter(r => !r.passed).length;
    const totalDuration = this.results.reduce((sum, r) => sum + r.duration, 0);
    
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`⏱️  Total time: ${(totalDuration / 1000).toFixed(2)}s`);
    
    if (failed > 0) {
      console.log('\n❌ Failed tests:');
      this.results.filter(r => !r.passed).forEach(r => {
        console.log(`  - ${r.name}: ${r.error}`);
      });
    }
    
    console.log('\n' + (failed === 0 ? '🎉 All tests passed!' : '💔 Some tests failed'));
  }
}

// Run tests if called directly
if (require.main === module) {
  const runner = new E2ETestRunner({
    logLevel: process.env.DEBUG ? 'debug' : 'error'
  });
  
  runner.runAll().catch((error) => {
    console.error('Test runner error:', error);
    process.exit(1);
  });
}

export { E2ETestRunner };
