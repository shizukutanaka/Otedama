/**
 * Advanced Health Check System
 * Kubernetes Liveness/Readiness プローブ対応
 * 
 * 設計思想：
 * - Carmack: 高速で効率的なヘルスチェック
 * - Martin: 階層的な健全性チェック
 * - Pike: シンプルで明確な健全性指標
 */

import { EventEmitter } from 'events';
import express, { Router } from 'express';
import { logger } from '../logging/logger';

// === 型定義 ===
export interface HealthCheckConfig {
  name: string;
  interval?: number;              // チェック間隔（ms）
  timeout?: number;               // タイムアウト（ms）
  retries?: number;               // リトライ回数
  critical?: boolean;             // クリティカルかどうか
  dependencies?: string[];        // 依存関係
  check: () => Promise<HealthStatus>;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  details?: any;
  metrics?: HealthMetrics;
}

export interface HealthMetrics {
  responseTime?: number;
  uptime?: number;
  memory?: {
    used: number;
    total: number;
    percentage: number;
  };
  cpu?: {
    usage: number;
    load: number[];
  };
  custom?: Record<string, any>;
}

export interface ComponentHealth {
  name: string;
  status: HealthStatus;
  lastCheck: number;
  consecutive: {
    successes: number;
    failures: number;
  };
  history: HealthCheckResult[];
}

export interface HealthCheckResult {
  timestamp: number;
  status: HealthStatus;
  duration: number;
  error?: any;
}

export interface OverallHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  uptime: number;
  version: string;
  components: Record<string, ComponentHealth>;
  metrics?: HealthMetrics;
}

// === Health Check Manager ===
export class HealthCheckManager extends EventEmitter {
  private components: Map<string, HealthCheckComponent> = new Map();
  private router: Router;
  private startTime: number = Date.now();
  private version: string;
  
  constructor(version: string = '1.0.0') {
    super();
    this.version = version;
    this.router = express.Router();
    this.setupRoutes();
  }
  
  // コンポーネント登録
  register(config: HealthCheckConfig): void {
    if (this.components.has(config.name)) {
      throw new Error(`Health check component ${config.name} already registered`);
    }
    
    const component = new HealthCheckComponent(config, this);
    this.components.set(config.name, component);
    
    logger.info(`Health check registered: ${config.name}`);
  }
  
  // 複数コンポーネント一括登録
  registerMany(configs: HealthCheckConfig[]): void {
    for (const config of configs) {
      this.register(config);
    }
  }
  
  // コンポーネント削除
  unregister(name: string): boolean {
    const component = this.components.get(name);
    if (component) {
      component.stop();
      this.components.delete(name);
      logger.info(`Health check unregistered: ${name}`);
      return true;
    }
    return false;
  }
  
  // 全体のヘルスチェック
  async checkHealth(): Promise<OverallHealth> {
    const results = await Promise.all(
      Array.from(this.components.values()).map(c => c.performCheck())
    );
    
    const components: Record<string, ComponentHealth> = {};
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    for (const component of this.components.values()) {
      const health = component.getHealth();
      components[component.config.name] = health;
      
      // 全体ステータスの決定
      if (health.status.status === 'unhealthy') {
        if (component.config.critical) {
          overallStatus = 'unhealthy';
        } else if (overallStatus !== 'unhealthy') {
          overallStatus = 'degraded';
        }
      } else if (health.status.status === 'degraded' && overallStatus === 'healthy') {
        overallStatus = 'degraded';
      }
    }
    
    // メトリクス収集
    const metrics = await this.collectMetrics();
    
    return {
      status: overallStatus,
      timestamp: Date.now(),
      uptime: Date.now() - this.startTime,
      version: this.version,
      components,
      metrics
    };
  }
  
  // Liveness チェック（生存確認）
  async checkLiveness(): Promise<boolean> {
    // 基本的なシステムチェック
    try {
      // イベントループの応答性チェック
      await new Promise(resolve => setImmediate(resolve));
      
      // メモリ使用量チェック
      const memUsage = process.memoryUsage();
      const memLimit = process.env.MEMORY_LIMIT 
        ? parseInt(process.env.MEMORY_LIMIT) 
        : 4 * 1024 * 1024 * 1024; // 4GB default
      
      if (memUsage.heapUsed > memLimit * 0.95) {
        logger.error('Memory usage critical for liveness');
        return false;
      }
      
      return true;
    } catch (error) {
      logger.error('Liveness check failed:', error);
      return false;
    }
  }
  
  // Readiness チェック（準備完了確認）
  async checkReadiness(): Promise<boolean> {
    const health = await this.checkHealth();
    
    // クリティカルコンポーネントのチェック
    for (const [name, component] of this.components) {
      if (component.config.critical) {
        const componentHealth = health.components[name];
        if (componentHealth.status.status !== 'healthy') {
          logger.warn(`Critical component ${name} is not ready`);
          return false;
        }
      }
    }
    
    return health.status !== 'unhealthy';
  }
  
  // メトリクス収集
  private async collectMetrics(): Promise<HealthMetrics> {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    return {
      responseTime: 0, // APIレスポンスタイムは別途計測
      uptime: Date.now() - this.startTime,
      memory: {
        used: memUsage.heapUsed,
        total: memUsage.heapTotal,
        percentage: (memUsage.heapUsed / memUsage.heapTotal) * 100
      },
      cpu: {
        usage: (cpuUsage.user + cpuUsage.system) / 1000000, // マイクロ秒をミリ秒に
        load: require('os').loadavg()
      }
    };
  }
  
  // ルート設定
  private setupRoutes(): void {
    // Liveness probe
    this.router.get('/live', async (req, res) => {
      const startTime = Date.now();
      
      try {
        const isAlive = await this.checkLiveness();
        const responseTime = Date.now() - startTime;
        
        if (isAlive) {
          res.status(200).json({
            status: 'alive',
            timestamp: Date.now(),
            responseTime
          });
        } else {
          res.status(503).json({
            status: 'dead',
            timestamp: Date.now(),
            responseTime
          });
        }
      } catch (error) {
        res.status(503).json({
          status: 'error',
          error: error.message
        });
      }
    });
    
    // Readiness probe
    this.router.get('/ready', async (req, res) => {
      const startTime = Date.now();
      
      try {
        const isReady = await this.checkReadiness();
        const responseTime = Date.now() - startTime;
        
        if (isReady) {
          res.status(200).json({
            status: 'ready',
            timestamp: Date.now(),
            responseTime
          });
        } else {
          res.status(503).json({
            status: 'not_ready',
            timestamp: Date.now(),
            responseTime
          });
        }
      } catch (error) {
        res.status(503).json({
          status: 'error',
          error: error.message
        });
      }
    });
    
    // 詳細ヘルスチェック
    this.router.get('/health', async (req, res) => {
      const startTime = Date.now();
      
      try {
        const health = await this.checkHealth();
        const responseTime = Date.now() - startTime;
        
        // メトリクスに応答時間を追加
        if (health.metrics) {
          health.metrics.responseTime = responseTime;
        }
        
        const statusCode = health.status === 'healthy' ? 200 : 
                          health.status === 'degraded' ? 200 : 503;
        
        res.status(statusCode).json(health);
      } catch (error) {
        res.status(503).json({
          status: 'error',
          error: error.message,
          timestamp: Date.now()
        });
      }
    });
    
    // コンポーネント別ヘルスチェック
    this.router.get('/health/:component', async (req, res) => {
      const componentName = req.params.component;
      const component = this.components.get(componentName);
      
      if (!component) {
        return res.status(404).json({
          error: `Component ${componentName} not found`
        });
      }
      
      try {
        await component.performCheck();
        const health = component.getHealth();
        
        const statusCode = health.status.status === 'healthy' ? 200 : 
                          health.status.status === 'degraded' ? 200 : 503;
        
        res.status(statusCode).json(health);
      } catch (error) {
        res.status(503).json({
          status: 'error',
          error: error.message
        });
      }
    });
  }
  
  // Express Router取得
  getRouter(): Router {
    return this.router;
  }
  
  // 全チェック開始
  startAll(): void {
    for (const component of this.components.values()) {
      component.start();
    }
  }
  
  // 全チェック停止
  stopAll(): void {
    for (const component of this.components.values()) {
      component.stop();
    }
  }
}

// === Health Check Component ===
class HealthCheckComponent {
  private timer?: NodeJS.Timeout;
  private status: HealthStatus = { status: 'healthy' };
  private lastCheck: number = 0;
  private consecutiveSuccesses = 0;
  private consecutiveFailures = 0;
  private history: HealthCheckResult[] = [];
  private readonly maxHistorySize = 100;
  
  constructor(
    public config: Required<HealthCheckConfig>,
    private manager: HealthCheckManager
  ) {
    // デフォルト値設定
    this.config.interval = config.interval || 30000; // 30秒
    this.config.timeout = config.timeout || 5000;    // 5秒
    this.config.retries = config.retries || 3;
    this.config.critical = config.critical !== false;
    this.config.dependencies = config.dependencies || [];
  }
  
  // チェック開始
  start(): void {
    if (this.timer) return;
    
    // 初回チェック
    this.performCheck();
    
    // 定期チェック
    this.timer = setInterval(() => {
      this.performCheck();
    }, this.config.interval);
  }
  
  // チェック停止
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
  
  // ヘルスチェック実行
  async performCheck(): Promise<HealthStatus> {
    const startTime = Date.now();
    let lastError: any;
    
    // リトライループ
    for (let attempt = 1; attempt <= this.config.retries; attempt++) {
      try {
        // タイムアウト付きチェック
        const status = await this.executeWithTimeout();
        
        // 成功
        this.onSuccess(status, Date.now() - startTime);
        return status;
        
      } catch (error) {
        lastError = error;
        
        if (attempt < this.config.retries) {
          // リトライ待機
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
    
    // 失敗
    const status: HealthStatus = {
      status: 'unhealthy',
      message: lastError?.message || 'Health check failed',
      details: { error: lastError }
    };
    
    this.onFailure(status, Date.now() - startTime, lastError);
    return status;
  }
  
  // タイムアウト付き実行
  private executeWithTimeout(): Promise<HealthStatus> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Health check timeout after ${this.config.timeout}ms`));
      }, this.config.timeout);
      
      this.config.check()
        .then(status => {
          clearTimeout(timeoutId);
          resolve(status);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }
  
  // 成功処理
  private onSuccess(status: HealthStatus, duration: number): void {
    this.status = status;
    this.lastCheck = Date.now();
    this.consecutiveSuccesses++;
    this.consecutiveFailures = 0;
    
    // 履歴に追加
    this.addToHistory({
      timestamp: this.lastCheck,
      status,
      duration
    });
    
    // イベント発行
    this.manager.emit('checkSuccess', {
      component: this.config.name,
      status,
      duration
    });
  }
  
  // 失敗処理
  private onFailure(status: HealthStatus, duration: number, error: any): void {
    this.status = status;
    this.lastCheck = Date.now();
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    
    // 履歴に追加
    this.addToHistory({
      timestamp: this.lastCheck,
      status,
      duration,
      error
    });
    
    // イベント発行
    this.manager.emit('checkFailure', {
      component: this.config.name,
      status,
      duration,
      error
    });
    
    logger.error(`Health check failed for ${this.config.name}:`, error);
  }
  
  // 履歴追加
  private addToHistory(result: HealthCheckResult): void {
    this.history.push(result);
    
    // サイズ制限
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }
  
  // 現在の健全性取得
  getHealth(): ComponentHealth {
    return {
      name: this.config.name,
      status: this.status,
      lastCheck: this.lastCheck,
      consecutive: {
        successes: this.consecutiveSuccesses,
        failures: this.consecutiveFailures
      },
      history: this.history.slice(-10) // 最新10件
    };
  }
}

// === プリセットヘルスチェック ===
export const HealthChecks = {
  // データベース接続チェック
  database: (name: string, checkFn: () => Promise<boolean>): HealthCheckConfig => ({
    name,
    interval: 30000,
    timeout: 5000,
    critical: true,
    check: async () => {
      try {
        const isHealthy = await checkFn();
        return {
          status: isHealthy ? 'healthy' : 'unhealthy',
          message: isHealthy ? 'Database connection OK' : 'Database connection failed'
        };
      } catch (error) {
        return {
          status: 'unhealthy',
          message: 'Database check failed',
          details: { error: error.message }
        };
      }
    }
  }),
  
  // Redis接続チェック
  redis: (name: string, client: any): HealthCheckConfig => ({
    name,
    interval: 30000,
    timeout: 3000,
    critical: false,
    check: async () => {
      try {
        await client.ping();
        return {
          status: 'healthy',
          message: 'Redis connection OK'
        };
      } catch (error) {
        return {
          status: 'unhealthy',
          message: 'Redis connection failed',
          details: { error: error.message }
        };
      }
    }
  }),
  
  // API エンドポイントチェック
  api: (name: string, url: string, expectedStatus = 200): HealthCheckConfig => ({
    name,
    interval: 60000,
    timeout: 10000,
    critical: false,
    check: async () => {
      try {
        const response = await fetch(url);
        if (response.status === expectedStatus) {
          return {
            status: 'healthy',
            message: `API endpoint ${url} is responsive`
          };
        } else {
          return {
            status: 'degraded',
            message: `API endpoint returned ${response.status}`,
            details: { status: response.status }
          };
        }
      } catch (error) {
        return {
          status: 'unhealthy',
          message: 'API endpoint check failed',
          details: { error: error.message }
        };
      }
    }
  }),
  
  // ディスクスペースチェック
  diskSpace: (name: string, path: string, threshold = 90): HealthCheckConfig => ({
    name,
    interval: 300000, // 5分
    timeout: 5000,
    critical: true,
    check: async () => {
      const { checkDiskSpace } = await import('check-disk-space');
      try {
        const diskSpace = await checkDiskSpace(path);
        const usagePercent = ((diskSpace.size - diskSpace.free) / diskSpace.size) * 100;
        
        if (usagePercent < threshold) {
          return {
            status: 'healthy',
            message: `Disk usage: ${usagePercent.toFixed(1)}%`,
            metrics: {
              custom: {
                diskUsage: usagePercent,
                freeSpace: diskSpace.free,
                totalSpace: diskSpace.size
              }
            }
          };
        } else if (usagePercent < 95) {
          return {
            status: 'degraded',
            message: `Disk usage high: ${usagePercent.toFixed(1)}%`
          };
        } else {
          return {
            status: 'unhealthy',
            message: `Disk usage critical: ${usagePercent.toFixed(1)}%`
          };
        }
      } catch (error) {
        return {
          status: 'unhealthy',
          message: 'Disk space check failed',
          details: { error: error.message }
        };
      }
    }
  })
};

// === 使用例 ===
/*
// Health Check Manager の作成
const healthManager = new HealthCheckManager('1.0.0');

// ヘルスチェックの登録
healthManager.register({
  name: 'database',
  critical: true,
  check: async () => {
    const isConnected = await db.ping();
    return {
      status: isConnected ? 'healthy' : 'unhealthy',
      message: isConnected ? 'Database connected' : 'Database disconnected'
    };
  }
});

// プリセットの使用
healthManager.register(HealthChecks.redis('redis-cache', redisClient));
healthManager.register(HealthChecks.api('external-api', 'https://api.example.com/health'));

// Express アプリケーションへの統合
app.use('/health', healthManager.getRouter());

// 全チェック開始
healthManager.startAll();

// Kubernetes設定例
// livenessProbe:
//   httpGet:
//     path: /health/live
//     port: 8080
//   initialDelaySeconds: 30
//   periodSeconds: 10
//
// readinessProbe:
//   httpGet:
//     path: /health/ready
//     port: 8080
//   initialDelaySeconds: 10
//   periodSeconds: 5
*/

export default HealthCheckManager;