/**
 * 統合テストシステム - E2Eテスト
 * システム全体の動作確認とテスト自動化
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import fetch from 'node-fetch';
import { performance } from 'perf_hooks';

export interface IntegrationTestConfig {
  name: string;
  timeout: number;
  setupTimeout: number;
  teardownTimeout: number;
  retries: number;
  serverPort?: number;
  stratumPort?: number;
  apiPort?: number;
}

export interface TestStep {
  name: string;
  action: () => Promise<void>;
  timeout?: number;
  retries?: number;
  critical?: boolean; // 失敗時にテスト全体を停止
}

export interface TestResult {
  testName: string;
  success: boolean;
  duration: number;
  steps: StepResult[];
  error?: string;
  startTime: Date;
  endTime: Date;
}

export interface StepResult {
  name: string;
  success: boolean;
  duration: number;
  error?: string;
  retryCount: number;
}

export class IntegrationTestRunner extends EventEmitter {
  private config: IntegrationTestConfig;
  private serverProcess?: ChildProcess;
  private isRunning = false;
  private testResults: TestResult[] = [];

  constructor(config: Partial<IntegrationTestConfig> = {}) {
    super();
    
    this.config = {
      name: 'Integration Test',
      timeout: 300000, // 5分
      setupTimeout: 30000, // 30秒
      teardownTimeout: 10000, // 10秒
      retries: 2,
      serverPort: 3000,
      stratumPort: 3333,
      apiPort: 3001,
      ...config
    };
  }

  /**
   * テストスイート実行
   */
  public async runTestSuite(tests: TestStep[][]): Promise<TestResult[]> {
    if (this.isRunning) {
      throw new Error('Test suite is already running');
    }

    this.isRunning = true;
    this.testResults = [];

    console.log(`[Integration Test] Starting test suite with ${tests.length} test cases`);

    try {
      // サーバー起動
      await this.startServer();

      // 各テストケースを実行
      for (let i = 0; i < tests.length; i++) {
        const testSteps = tests[i];
        const testName = `Test Case ${i + 1}`;
        
        console.log(`[Integration Test] Running ${testName}...`);
        
        const result = await this.runTestCase(testName, testSteps);
        this.testResults.push(result);
        
        this.emit('testCompleted', result);
        
        if (!result.success && this.shouldStopOnFailure(testSteps)) {
          console.error(`[Integration Test] Critical test failed: ${testName}`);
          break;
        }

        // テスト間の小休止
        await this.sleep(1000);
      }

      // 結果サマリー
      this.printTestSummary();

      return this.testResults;
    } finally {
      await this.stopServer();
      this.isRunning = false;
    }
  }

  /**
   * 単一テストケース実行
   */
  private async runTestCase(testName: string, steps: TestStep[]): Promise<TestResult> {
    const startTime = new Date();
    const stepResults: StepResult[] = [];
    let testSuccess = true;
    let testError: string | undefined;

    for (const step of steps) {
      const stepResult = await this.runTestStep(step);
      stepResults.push(stepResult);

      if (!stepResult.success) {
        testSuccess = false;
        testError = stepResult.error;
        
        if (step.critical) {
          console.error(`[Integration Test] Critical step failed: ${step.name}`);
          break;
        }
      }
    }

    const endTime = new Date();
    const duration = endTime.getTime() - startTime.getTime();

    return {
      testName,
      success: testSuccess,
      duration,
      steps: stepResults,
      error: testError,
      startTime,
      endTime
    };
  }

  /**
   * 単一テストステップ実行
   */
  private async runTestStep(step: TestStep): Promise<StepResult> {
    const startTime = performance.now();
    let retryCount = 0;
    let lastError: string | undefined;
    const maxRetries = step.retries ?? this.config.retries;

    while (retryCount <= maxRetries) {
      try {
        const timeout = step.timeout ?? this.config.timeout;
        
        await Promise.race([
          step.action(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Step timeout')), timeout)
          )
        ]);

        const endTime = performance.now();
        const duration = endTime - startTime;

        return {
          name: step.name,
          success: true,
          duration,
          retryCount
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        retryCount++;

        if (retryCount <= maxRetries) {
          console.warn(`[Integration Test] Step '${step.name}' failed, retrying... (${retryCount}/${maxRetries})`);
          await this.sleep(1000 * retryCount); // 指数バックオフ
        }
      }
    }

    const endTime = performance.now();
    const duration = endTime - startTime;

    return {
      name: step.name,
      success: false,
      duration,
      error: lastError,
      retryCount: retryCount - 1
    };
  }

  /**
   * サーバー起動
   */
  private async startServer(): Promise<void> {
    console.log('[Integration Test] Starting server...');

    return new Promise((resolve, reject) => {
      this.serverProcess = spawn('node', ['dist/server.js'], {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: this.config.serverPort?.toString(),
          STRATUM_PORT: this.config.stratumPort?.toString(),
          API_PORT: this.config.apiPort?.toString(),
          LOG_LEVEL: 'error' // テスト中はログを最小限に
        },
        stdio: 'pipe'
      });

      const timeout = setTimeout(() => {
        reject(new Error('Server startup timeout'));
      }, this.config.setupTimeout);

      this.serverProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        if (output.includes('Server listening') || output.includes('Pool started')) {
          clearTimeout(timeout);
          resolve();
        }
      });

      this.serverProcess.stderr?.on('data', (data) => {
        console.error('[Server Error]', data.toString());
      });

      this.serverProcess.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      this.serverProcess.on('exit', (code) => {
        if (code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}`));
        }
      });
    });
  }

  /**
   * サーバー停止
   */
  private async stopServer(): Promise<void> {
    if (!this.serverProcess) return;

    console.log('[Integration Test] Stopping server...');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.serverProcess?.kill('SIGKILL');
        resolve();
      }, this.config.teardownTimeout);

      this.serverProcess?.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.serverProcess?.kill('SIGTERM');
    });
  }

  /**
   * ヘルパーメソッド：HTTP APIテスト
   */
  public createApiTest(endpoint: string, expectedStatus = 200): TestStep {
    return {
      name: `API Test: ${endpoint}`,
      action: async () => {
        const url = `http://localhost:${this.config.apiPort}${endpoint}`;
        const response = await fetch(url);
        
        if (response.status !== expectedStatus) {
          throw new Error(`Expected status ${expectedStatus}, got ${response.status}`);
        }

        const data = await response.json();
        console.log(`[API Test] ${endpoint} response:`, data);
      },
      timeout: 5000
    };
  }

  /**
   * ヘルパーメソッド：Stratum接続テスト
   */
  public createStratumTest(testName: string): TestStep {
    return {
      name: `Stratum Test: ${testName}`,
      action: () => {
        return new Promise<void>((resolve, reject) => {
          const socket = new net.Socket();
          const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error('Stratum connection timeout'));
          }, 5000);

          socket.connect(this.config.stratumPort!, 'localhost');

          socket.on('connect', () => {
            console.log('[Stratum Test] Connected');
            
            // 認証リクエスト送信
            const authRequest = {
              id: 1,
              method: 'mining.authorize',
              params: ['testworker', 'password']
            };
            
            socket.write(JSON.stringify(authRequest) + '\n');
          });

          socket.on('data', (data) => {
            try {
              const response = JSON.parse(data.toString());
              console.log('[Stratum Test] Response:', response);
              
              clearTimeout(timeout);
              socket.destroy();
              resolve();
            } catch (error) {
              clearTimeout(timeout);
              socket.destroy();
              reject(error);
            }
          });

          socket.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
      },
      timeout: 10000
    };
  }

  /**
   * ヘルパーメソッド：データベーステスト
   */
  public createDatabaseTest(): TestStep {
    return {
      name: 'Database Connection Test',
      action: async () => {
        const response = await fetch(`http://localhost:${this.config.apiPort}/api/health/database`);
        
        if (!response.ok) {
          throw new Error(`Database health check failed: ${response.status}`);
        }

        const data = await response.json();
        if (!data.connected) {
          throw new Error('Database not connected');
        }
      },
      timeout: 5000,
      critical: true
    };
  }

  /**
   * ヘルパーメソッド：負荷テスト
   */
  public createLoadTest(requests: number, concurrency: number): TestStep {
    return {
      name: `Load Test: ${requests} requests, ${concurrency} concurrent`,
      action: async () => {
        const startTime = performance.now();
        const promises: Promise<any>[] = [];
        
        for (let i = 0; i < concurrency; i++) {
          promises.push(this.sendConcurrentRequests(requests / concurrency));
        }

        await Promise.all(promises);
        
        const duration = performance.now() - startTime;
        console.log(`[Load Test] Completed ${requests} requests in ${duration.toFixed(2)}ms`);
      },
      timeout: 30000
    };
  }

  /**
   * 並行リクエスト送信
   */
  private async sendConcurrentRequests(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await fetch(`http://localhost:${this.config.apiPort}/api/stats`);
    }
  }

  /**
   * クリティカルエラーチェック
   */
  private shouldStopOnFailure(steps: TestStep[]): boolean {
    return steps.some(step => step.critical);
  }

  /**
   * テスト結果サマリー出力
   */
  private printTestSummary(): void {
    const totalTests = this.testResults.length;
    const passedTests = this.testResults.filter(r => r.success).length;
    const failedTests = totalTests - passedTests;
    const totalDuration = this.testResults.reduce((sum, r) => sum + r.duration, 0);

    console.log('\n=== Integration Test Results ===');
    console.log(`Total Tests: ${totalTests}`);
    console.log(`Passed: ${passedTests} (${((passedTests / totalTests) * 100).toFixed(1)}%)`);
    console.log(`Failed: ${failedTests} (${((failedTests / totalTests) * 100).toFixed(1)}%)`);
    console.log(`Total Duration: ${(totalDuration / 1000).toFixed(2)}s`);

    if (failedTests > 0) {
      console.log('\nFailed Tests:');
      this.testResults
        .filter(r => !r.success)
        .forEach(r => {
          console.log(`  - ${r.testName}: ${r.error}`);
        });
    }

    console.log('\nDetailed Results:');
    this.testResults.forEach((result, index) => {
      const status = result.success ? '✓' : '✗';
      console.log(`  ${status} Test ${index + 1}: ${result.testName} (${result.duration}ms)`);
      
      result.steps.forEach(step => {
        const stepStatus = step.success ? '  ✓' : '  ✗';
        console.log(`    ${stepStatus} ${step.name} (${step.duration.toFixed(2)}ms)`);
        if (!step.success && step.error) {
          console.log(`        Error: ${step.error}`);
        }
      });
    });
  }

  /**
   * スリープ
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 統計情報取得
   */
  public getStats() {
    return {
      isRunning: this.isRunning,
      totalTests: this.testResults.length,
      passedTests: this.testResults.filter(r => r.success).length,
      failedTests: this.testResults.filter(r => !r.success).length,
      averageDuration: this.testResults.length > 0 
        ? this.testResults.reduce((sum, r) => sum + r.duration, 0) / this.testResults.length 
        : 0
    };
  }
}

// 事前定義されたテストスイート
export const DEFAULT_TEST_SUITES = {
  basic: [
    // 基本機能テスト
    [
      {
        name: 'Server Health Check',
        action: async () => {
          const runner = new IntegrationTestRunner();
          const step = runner.createApiTest('/api/health');
          await step.action();
        }
      },
      {
        name: 'Database Connection',
        action: async () => {
          const runner = new IntegrationTestRunner();
          const step = runner.createDatabaseTest();
          await step.action();
        },
        critical: true
      }
    ]
  ],

  stratum: [
    // Stratumプロトコルテスト
    [
      {
        name: 'Stratum Connection',
        action: async () => {
          const runner = new IntegrationTestRunner();
          const step = runner.createStratumTest('Basic Connection');
          await step.action();
        }
      }
    ]
  ],

  load: [
    // 負荷テスト
    [
      {
        name: 'Light Load Test',
        action: async () => {
          const runner = new IntegrationTestRunner();
          const step = runner.createLoadTest(100, 10);
          await step.action();
        }
      }
    ]
  ]
};

export default IntegrationTestRunner;