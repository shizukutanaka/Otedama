/**
 * パフォーマンステスト自動化システム
 * 負荷テスト、ベンチマーク、継続的パフォーマンス監視
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import * as os from 'os';

export interface PerformanceTestConfig {
  name: string;
  duration: number;           // テスト継続時間（秒）
  concurrency: number;        // 同時実行数
  rampUp: number;            // ランプアップ時間（秒）
  target: string;            // テスト対象URL/エンドポイント
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'STRATUM';
  payload?: any;             // リクエストペイロード
  headers?: Record<string, string>;
  expectedStatusCode?: number;
  timeout: number;           // タイムアウト（ミリ秒）
  warmupRequests?: number;   // ウォームアップリクエスト数
}

export interface PerformanceMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  medianResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
  requestsPerSecond: number;
  errorRate: number;
  throughputMBps: number;
  cpuUsage: SystemMetrics[];
  memoryUsage: SystemMetrics[];
  errors: ErrorSummary[];
  startTime: Date;
  endTime: Date;
  duration: number;
}

interface SystemMetrics {
  timestamp: number;
  cpu: number;
  memory: number;
  heapUsed: number;
  heapTotal: number;
}

interface ErrorSummary {
  error: string;
  count: number;
  percentage: number;
}

interface TestRequest {
  id: number;
  startTime: number;
  endTime?: number;
  responseTime?: number;
  success: boolean;
  error?: string;
  statusCode?: number;
  responseSize?: number;
}

export class PerformanceTester extends EventEmitter {
  private isRunning = false;
  private startTime = 0;
  private requests: TestRequest[] = [];
  private systemMetrics: SystemMetrics[] = [];
  private activeRequests = 0;
  private completedRequests = 0;
  private monitoringInterval?: NodeJS.Timeout;

  constructor() {
    super();
  }

  /**
   * パフォーマンステストを実行
   */
  public async runTest(config: PerformanceTestConfig): Promise<PerformanceMetrics> {
    if (this.isRunning) {
      throw new Error('Test is already running');
    }

    this.isRunning = true;
    this.reset();

    console.log(`[Performance Test] Starting test: ${config.name}`);
    console.log(`[Performance Test] Config:`, {
      duration: config.duration,
      concurrency: config.concurrency,
      target: config.target,
      method: config.method
    });

    try {
      // ウォームアップ
      if (config.warmupRequests && config.warmupRequests > 0) {
        await this.warmup(config);
      }

      this.startTime = performance.now();
      this.startSystemMonitoring();

      this.emit('testStarted', config);

      // 実際のテスト実行
      await this.executeTest(config);

      // 結果の計算
      const metrics = this.calculateMetrics(config);

      this.emit('testCompleted', metrics);

      console.log(`[Performance Test] Test completed: ${config.name}`);
      this.printSummary(metrics);

      return metrics;
    } finally {
      this.stopSystemMonitoring();
      this.isRunning = false;
    }
  }

  /**
   * ウォームアップリクエスト
   */
  private async warmup(config: PerformanceTestConfig): Promise<void> {
    console.log(`[Performance Test] Warming up with ${config.warmupRequests} requests...`);
    
    const warmupPromises = [];
    for (let i = 0; i < config.warmupRequests!; i++) {
      warmupPromises.push(this.sendRequest(config, -1)); // ウォームアップは統計に含めない
    }
    
    await Promise.all(warmupPromises);
    console.log('[Performance Test] Warmup completed');
  }

  /**
   * テスト実行
   */
  private async executeTest(config: PerformanceTestConfig): Promise<void> {
    const testDurationMs = config.duration * 1000;
    const rampUpMs = config.rampUp * 1000;
    const rampUpInterval = rampUpMs / config.concurrency;

    const promises: Promise<void>[] = [];

    // ランプアップしながら同時実行を開始
    for (let i = 0; i < config.concurrency; i++) {
      const delay = i * rampUpInterval;
      
      promises.push(
        new Promise<void>((resolve) => {
          setTimeout(() => {
            this.runWorker(config, testDurationMs - delay).then(resolve);
          }, delay);
        })
      );
    }

    await Promise.all(promises);
  }

  /**
   * ワーカー（継続的リクエスト送信）
   */
  private async runWorker(config: PerformanceTestConfig, duration: number): Promise<void> {
    const startTime = performance.now();
    let requestId = 0;

    while (performance.now() - startTime < duration) {
      if (!this.isRunning) break;

      try {
        await this.sendRequest(config, requestId++);
      } catch (error) {
        // エラーは個別のリクエストで処理
      }

      // 必要に応じて小さな遅延を追加
      if (config.method === 'STRATUM') {
        await this.sleep(10); // Stratumは少し間隔を空ける
      }
    }
  }

  /**
   * リクエスト送信
   */
  private async sendRequest(config: PerformanceTestConfig, requestId: number): Promise<void> {
    if (requestId < 0) return; // ウォームアップの場合はスキップ

    const request: TestRequest = {
      id: requestId,
      startTime: performance.now(),
      success: false
    };

    this.activeRequests++;

    try {
      if (config.method === 'STRATUM') {
        await this.sendStratumRequest(config, request);
      } else {
        await this.sendHttpRequest(config, request);
      }

      request.success = true;
    } catch (error) {
      request.success = false;
      request.error = error instanceof Error ? error.message : String(error);
    } finally {
      request.endTime = performance.now();
      request.responseTime = request.endTime - request.startTime;
      
      this.requests.push(request);
      this.activeRequests--;
      this.completedRequests++;

      // 進捗表示
      if (this.completedRequests % 100 === 0) {
        this.emit('progress', {
          completed: this.completedRequests,
          active: this.activeRequests,
          elapsed: performance.now() - this.startTime
        });
      }
    }
  }

  /**
   * HTTPリクエスト送信
   */
  private async sendHttpRequest(config: PerformanceTestConfig, request: TestRequest): Promise<void> {
    const fetch = (await import('node-fetch')).default;
    
    const options: any = {
      method: config.method,
      headers: config.headers || {},
      timeout: config.timeout
    };

    if (config.payload && (config.method === 'POST' || config.method === 'PUT')) {
      options.body = JSON.stringify(config.payload);
      options.headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(config.target, options);
    
    request.statusCode = response.status;
    request.responseSize = parseInt(response.headers.get('content-length') || '0');

    if (config.expectedStatusCode && response.status !== config.expectedStatusCode) {
      throw new Error(`Expected status ${config.expectedStatusCode}, got ${response.status}`);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }

  /**
   * Stratumリクエスト送信（マイニングプール用）
   */
  private async sendStratumRequest(config: PerformanceTestConfig, request: TestRequest): Promise<void> {
    const net = await import('net');
    
    return new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Stratum request timeout'));
      }, config.timeout);

      socket.connect(parseInt(config.target.split(':')[1]), config.target.split(':')[0]);

      socket.on('connect', () => {
        // Stratum認証リクエスト
        const authRequest = {
          id: request.id,
          method: 'mining.authorize',
          params: ['testworker', 'password']
        };
        
        socket.write(JSON.stringify(authRequest) + '\n');
      });

      socket.on('data', (data) => {
        try {
          const response = JSON.parse(data.toString());
          request.responseSize = data.length;
          
          if (response.error) {
            throw new Error(`Stratum error: ${response.error.message}`);
          }
          
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
  }

  /**
   * システムメトリクス監視開始
   */
  private startSystemMonitoring(): void {
    this.monitoringInterval = setInterval(() => {
      const memUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();
      
      this.systemMetrics.push({
        timestamp: performance.now(),
        cpu: os.loadavg()[0], // 1分平均負荷
        memory: (os.totalmem() - os.freemem()) / os.totalmem() * 100,
        heapUsed: memUsage.heapUsed / 1024 / 1024, // MB
        heapTotal: memUsage.heapTotal / 1024 / 1024 // MB
      });
    }, 1000); // 1秒間隔
  }

  /**
   * システムメトリクス監視停止
   */
  private stopSystemMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
  }

  /**
   * メトリクス計算
   */
  private calculateMetrics(config: PerformanceTestConfig): PerformanceMetrics {
    const successfulRequests = this.requests.filter(r => r.success);
    const failedRequests = this.requests.filter(r => !r.success);
    const responseTimes = successfulRequests
      .map(r => r.responseTime!)
      .filter(rt => rt !== undefined)
      .sort((a, b) => a - b);

    const totalDuration = (performance.now() - this.startTime) / 1000; // 秒

    // エラーサマリー
    const errorCounts = new Map<string, number>();
    failedRequests.forEach(req => {
      const error = req.error || 'Unknown error';
      errorCounts.set(error, (errorCounts.get(error) || 0) + 1);
    });

    const errors: ErrorSummary[] = Array.from(errorCounts.entries()).map(([error, count]) => ({
      error,
      count,
      percentage: (count / this.requests.length) * 100
    }));

    // レスポンス時間統計
    const p95Index = Math.floor(responseTimes.length * 0.95);
    const p99Index = Math.floor(responseTimes.length * 0.99);
    const medianIndex = Math.floor(responseTimes.length * 0.5);

    // スループット計算
    const totalResponseSize = successfulRequests.reduce((sum, req) => sum + (req.responseSize || 0), 0);
    const throughputMBps = (totalResponseSize / 1024 / 1024) / totalDuration;

    return {
      totalRequests: this.requests.length,
      successfulRequests: successfulRequests.length,
      failedRequests: failedRequests.length,
      averageResponseTime: responseTimes.length > 0 ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : 0,
      medianResponseTime: responseTimes[medianIndex] || 0,
      p95ResponseTime: responseTimes[p95Index] || 0,
      p99ResponseTime: responseTimes[p99Index] || 0,
      minResponseTime: responseTimes[0] || 0,
      maxResponseTime: responseTimes[responseTimes.length - 1] || 0,
      requestsPerSecond: this.requests.length / totalDuration,
      errorRate: (failedRequests.length / this.requests.length) * 100,
      throughputMBps,
      cpuUsage: this.systemMetrics,
      memoryUsage: this.systemMetrics,
      errors,
      startTime: new Date(Date.now() - totalDuration * 1000),
      endTime: new Date(),
      duration: totalDuration
    };
  }

  /**
   * サマリー出力
   */
  private printSummary(metrics: PerformanceMetrics): void {
    console.log('\n=== Performance Test Results ===');
    console.log(`Duration: ${metrics.duration.toFixed(2)}s`);
    console.log(`Total Requests: ${metrics.totalRequests}`);
    console.log(`Successful: ${metrics.successfulRequests} (${((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(1)}%)`);
    console.log(`Failed: ${metrics.failedRequests} (${metrics.errorRate.toFixed(1)}%)`);
    console.log(`\nResponse Times (ms):`);
    console.log(`  Average: ${metrics.averageResponseTime.toFixed(2)}`);
    console.log(`  Median: ${metrics.medianResponseTime.toFixed(2)}`);
    console.log(`  95th percentile: ${metrics.p95ResponseTime.toFixed(2)}`);
    console.log(`  99th percentile: ${metrics.p99ResponseTime.toFixed(2)}`);
    console.log(`  Min: ${metrics.minResponseTime.toFixed(2)}`);
    console.log(`  Max: ${metrics.maxResponseTime.toFixed(2)}`);
    console.log(`\nThroughput:`);
    console.log(`  Requests/sec: ${metrics.requestsPerSecond.toFixed(2)}`);
    console.log(`  MB/sec: ${metrics.throughputMBps.toFixed(2)}`);
    
    if (metrics.errors.length > 0) {
      console.log(`\nErrors:`);
      metrics.errors.forEach(error => {
        console.log(`  ${error.error}: ${error.count} (${error.percentage.toFixed(1)}%)`);
      });
    }
  }

  /**
   * リセット
   */
  private reset(): void {
    this.requests = [];
    this.systemMetrics = [];
    this.activeRequests = 0;
    this.completedRequests = 0;
    this.startTime = 0;
  }

  /**
   * スリープ
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 現在のステータス取得
   */
  public getStatus() {
    return {
      isRunning: this.isRunning,
      activeRequests: this.activeRequests,
      completedRequests: this.completedRequests,
      elapsedTime: this.isRunning ? performance.now() - this.startTime : 0
    };
  }

  /**
   * テスト停止
   */
  public stop(): void {
    this.isRunning = false;
    this.emit('testStopped');
  }
}

// デフォルトテスト設定
export const DEFAULT_TEST_CONFIGS = {
  stratumLoad: {
    name: 'Stratum Load Test',
    duration: 60,
    concurrency: 50,
    rampUp: 10,
    target: 'localhost:3333',
    method: 'STRATUM' as const,
    timeout: 5000,
    warmupRequests: 10
  },

  apiLoad: {
    name: 'API Load Test',
    duration: 30,
    concurrency: 20,
    rampUp: 5,
    target: 'http://localhost:3000/api/stats',
    method: 'GET' as const,
    timeout: 3000,
    expectedStatusCode: 200,
    warmupRequests: 5
  },

  stress: {
    name: 'Stress Test',
    duration: 300, // 5分
    concurrency: 100,
    rampUp: 30,
    target: 'localhost:3333',
    method: 'STRATUM' as const,
    timeout: 10000
  }
};

export default PerformanceTester;