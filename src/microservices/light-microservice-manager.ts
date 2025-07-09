/**
 * 軽量マイクロサービス分割システム
 * 設計思想: John Carmack (効率性), Robert C. Martin (クリーン), Rob Pike (シンプル)
 * 
 * 特徴:
 * - 軽量なサービス分割
 * - 自動ロードバランシング
 * - ヘルスチェック
 * - サービス発見
 * - 障害隔離
 * - 簡単な設定
 */

import { EventEmitter } from 'events';
import express, { Express, Request, Response } from 'express';
import http from 'http';
import { createProxyMiddleware } from 'http-proxy-middleware';

// === 型定義 ===
export interface ServiceDefinition {
  id: string;
  name: string;
  version: string;
  port: number;
  host?: string;
  healthCheck: string;
  endpoints: ServiceEndpoint[];
  dependencies?: string[];
  resources: ServiceResources;
  config: ServiceConfig;
}

export interface ServiceEndpoint {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  handler?: string;
  timeout?: number;
  rateLimit?: number;
}

export interface ServiceResources {
  cpu: {
    min: number;
    max: number;
  };
  memory: {
    min: number;
    max: number;
  };
  instances: {
    min: number;
    max: number;
  };
}

export interface ServiceConfig {
  environment: Record<string, string>;
  secrets?: Record<string, string>;
  volumes?: string[];
  networks?: string[];
}

export interface ServiceInstance {
  id: string;
  serviceId: string;
  host: string;
  port: number;
  status: 'starting' | 'healthy' | 'unhealthy' | 'stopping' | 'stopped';
  lastHealthCheck: number;
  startedAt: number;
  version: string;
  pid?: number;
  server?: http.Server;
}

export interface LoadBalancerConfig {
  strategy: 'round-robin' | 'least-connections' | 'weighted' | 'random';
  healthCheckInterval: number;
  timeout: number;
  maxRetries: number;
}

export interface ServiceMetrics {
  requestCount: number;
  errorCount: number;
  avgResponseTime: number;
  activeConnections: number;
  cpuUsage: number;
  memoryUsage: number;
  uptime: number;
}

// === 軽量マイクロサービスマネージャー ===
export class LightMicroserviceManager extends EventEmitter {
  private services = new Map<string, ServiceDefinition>();
  private instances = new Map<string, ServiceInstance[]>();
  private gateway: Express;
  private gatewayServer?: http.Server;
  private healthCheckTimer?: NodeJS.Timeout;
  private metrics = new Map<string, ServiceMetrics>();
  private loadBalancer: LoadBalancerConfig;
  private serviceRegistry = new Map<string, ServiceInstance[]>();

  constructor() {
    super();
    this.gateway = express();
    this.loadBalancer = {
      strategy: 'round-robin',
      healthCheckInterval: 30000,
      timeout: 5000,
      maxRetries: 3
    };

    this.setupGateway();
  }

  // === サービス登録 ===
  registerService(service: ServiceDefinition): void {
    this.services.set(service.id, service);
    this.instances.set(service.id, []);
    this.metrics.set(service.id, {
      requestCount: 0,
      errorCount: 0,
      avgResponseTime: 0,
      activeConnections: 0,
      cpuUsage: 0,
      memoryUsage: 0,
      uptime: 0
    });

    console.log(`📦 Service registered: ${service.name} (${service.id})`);
    this.emit('serviceRegistered', service);
  }

  // === サービス開始 ===
  async startService(serviceId: string, instanceCount = 1): Promise<void> {
    const service = this.services.get(serviceId);
    if (!service) {
      throw new Error(`Service ${serviceId} not found`);
    }

    console.log(`🚀 Starting service: ${service.name} with ${instanceCount} instances`);

    for (let i = 0; i < instanceCount; i++) {
      await this.startServiceInstance(service, i);
    }

    this.emit('serviceStarted', serviceId);
  }

  private async startServiceInstance(service: ServiceDefinition, index: number): Promise<void> {
    const instanceId = `${service.id}-${index}`;
    const port = service.port + index;
    
    const instance: ServiceInstance = {
      id: instanceId,
      serviceId: service.id,
      host: service.host || 'localhost',
      port,
      status: 'starting',
      lastHealthCheck: Date.now(),
      startedAt: Date.now(),
      version: service.version
    };

    // Express アプリケーション作成
    const app = express();
    app.use(express.json());

    // ミドルウェア設定
    this.setupServiceMiddleware(app, service, instance);

    // エンドポイント設定
    this.setupServiceEndpoints(app, service, instance);

    // ヘルスチェックエンドポイント
    app.get(service.healthCheck, (req, res) => {
      res.json({
        status: 'healthy',
        service: service.name,
        version: service.version,
        instance: instanceId,
        uptime: Date.now() - instance.startedAt,
        timestamp: Date.now()
      });
    });

    // サーバー開始
    const server = app.listen(port, () => {
      instance.status = 'healthy';
      instance.server = server;
      
      console.log(`✅ Service instance started: ${instanceId} on port ${port}`);
    });

    // エラーハンドリング
    server.on('error', (error) => {
      console.error(`❌ Service instance error: ${instanceId}`, error);
      instance.status = 'unhealthy';
      this.emit('instanceError', instance, error);
    });

    // インスタンス登録
    const instances = this.instances.get(service.id) || [];
    instances.push(instance);
    this.instances.set(service.id, instances);

    // サービスレジストリに追加
    const registryInstances = this.serviceRegistry.get(service.id) || [];
    registryInstances.push(instance);
    this.serviceRegistry.set(service.id, registryInstances);
  }

  private setupServiceMiddleware(app: Express, service: ServiceDefinition, instance: ServiceInstance): void {
    // メトリクス収集ミドルウェア
    app.use((req, res, next) => {
      const start = Date.now();
      const metrics = this.metrics.get(service.id)!;
      
      metrics.requestCount++;
      metrics.activeConnections++;

      res.on('finish', () => {
        const duration = Date.now() - start;
        metrics.avgResponseTime = (metrics.avgResponseTime + duration) / 2;
        metrics.activeConnections--;

        if (res.statusCode >= 400) {
          metrics.errorCount++;
        }

        this.metrics.set(service.id, metrics);
      });

      next();
    });

    // CORS設定
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,PATCH,OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    // エラーハンドリング
    app.use((error: any, req: Request, res: Response, next: any) => {
      console.error(`Service error in ${service.name}:`, error);
      res.status(500).json({
        error: 'Internal Service Error',
        service: service.name,
        instance: instance.id,
        timestamp: Date.now()
      });
    });
  }

  private setupServiceEndpoints(app: Express, service: ServiceDefinition, instance: ServiceInstance): void {
    // サービス固有のエンドポイント実装
    switch (service.id) {
      case 'mining-core':
        this.setupMiningCoreEndpoints(app, service, instance);
        break;
      case 'payment-service':
        this.setupPaymentServiceEndpoints(app, service, instance);
        break;
      case 'stats-service':
        this.setupStatsServiceEndpoints(app, service, instance);
        break;
      case 'notification-service':
        this.setupNotificationServiceEndpoints(app, service, instance);
        break;
      default:
        this.setupDefaultEndpoints(app, service, instance);
    }
  }

  private setupMiningCoreEndpoints(app: Express, service: ServiceDefinition, instance: ServiceInstance): void {
    app.get('/api/work', (req, res) => {
      res.json({
        jobId: `job_${Date.now()}`,
        prevHash: '0'.repeat(64),
        merkleRoot: '0'.repeat(64),
        timestamp: Math.floor(Date.now() / 1000),
        difficulty: 1,
        height: 700000
      });
    });

    app.post('/api/submit', (req, res) => {
      const { jobId, nonce, hash } = req.body;
      
      // シェア検証（簡略化）
      const isValid = Math.random() > 0.1; // 90%の確率で有効
      
      res.json({
        valid: isValid,
        jobId,
        difficulty: 1,
        timestamp: Date.now()
      });
    });

    app.get('/api/stats', (req, res) => {
      const metrics = this.metrics.get(service.id)!;
      res.json({
        hashrate: 1000000,
        workers: 10,
        shares: metrics.requestCount,
        blocks: Math.floor(metrics.requestCount / 1000),
        efficiency: 98.5
      });
    });
  }

  private setupPaymentServiceEndpoints(app: Express, service: ServiceDefinition, instance: ServiceInstance): void {
    app.post('/api/payout', (req, res) => {
      const { minerId, amount, address, currency } = req.body;
      
      // 支払い処理（簡略化）
      const txHash = `tx_${Date.now()}_${Math.random().toString(36).substring(2)}`;
      
      res.json({
        success: true,
        txHash,
        amount,
        address,
        currency,
        fee: 0, // 手数料0%
        timestamp: Date.now()
      });
    });

    app.get('/api/balance/:minerId', (req, res) => {
      const { minerId } = req.params;
      
      res.json({
        minerId,
        balance: Math.random() * 0.1,
        currency: 'BTC',
        lastUpdate: Date.now()
      });
    });

    app.get('/api/history/:minerId', (req, res) => {
      const { minerId } = req.params;
      const { limit = 10 } = req.query;
      
      const history = Array.from({ length: Number(limit) }, (_, i) => ({
        txHash: `tx_${Date.now() - i * 3600000}_${i}`,
        amount: Math.random() * 0.01,
        timestamp: Date.now() - i * 3600000,
        status: 'confirmed'
      }));
      
      res.json(history);
    });
  }

  private setupStatsServiceEndpoints(app: Express, service: ServiceDefinition, instance: ServiceInstance): void {
    app.get('/api/pool', (req, res) => {
      res.json({
        hashrate: 50000000,
        workers: 150,
        blocks: 42,
        efficiency: 100, // 手数料0%
        fee: 0,
        payouts: 1250,
        uptime: process.uptime() * 1000
      });
    });

    app.get('/api/network', (req, res) => {
      res.json({
        difficulty: 25000000000000,
        blockHeight: 700000,
        blockTime: 600,
        networkHashrate: 150000000000000,
        nextDifficultyChange: 1000
      });
    });

    app.get('/api/miners', (req, res) => {
      const miners = Array.from({ length: 10 }, (_, i) => ({
        id: `miner_${i}`,
        hashrate: Math.random() * 1000000,
        shares: Math.floor(Math.random() * 1000),
        lastSeen: Date.now() - Math.random() * 300000
      }));
      
      res.json(miners);
    });
  }

  private setupNotificationServiceEndpoints(app: Express, service: ServiceDefinition, instance: ServiceInstance): void {
    app.post('/api/notify', (req, res) => {
      const { type, message, recipients } = req.body;
      
      console.log(`📢 Notification: ${type} - ${message}`);
      
      res.json({
        success: true,
        type,
        message,
        recipients: recipients?.length || 0,
        timestamp: Date.now()
      });
    });

    app.post('/api/alert', (req, res) => {
      const { severity, title, description } = req.body;
      
      console.log(`🚨 Alert: [${severity}] ${title} - ${description}`);
      
      res.json({
        success: true,
        alertId: `alert_${Date.now()}`,
        severity,
        timestamp: Date.now()
      });
    });
  }

  private setupDefaultEndpoints(app: Express, service: ServiceDefinition, instance: ServiceInstance): void {
    app.get('/api/info', (req, res) => {
      res.json({
        service: service.name,
        version: service.version,
        instance: instance.id,
        uptime: Date.now() - instance.startedAt,
        status: instance.status
      });
    });
  }

  // === ゲートウェイ設定 ===
  private setupGateway(): void {
    this.gateway.use(express.json());

    // ヘルスチェック
    this.gateway.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        services: Array.from(this.services.keys()),
        instances: this.getTotalInstanceCount(),
        timestamp: Date.now()
      });
    });

    // メトリクス
    this.gateway.get('/metrics', (req, res) => {
      const allMetrics = Object.fromEntries(this.metrics);
      res.json(allMetrics);
    });

    // サービス発見
    this.gateway.get('/services', (req, res) => {
      const services = Array.from(this.services.values()).map(service => ({
        id: service.id,
        name: service.name,
        version: service.version,
        instances: this.instances.get(service.id)?.length || 0,
        status: this.getServiceStatus(service.id)
      }));
      
      res.json(services);
    });

    // 動的プロキシ設定
    this.setupDynamicProxy();
  }

  private setupDynamicProxy(): void {
    // サービスへのプロキシ
    this.gateway.use('/api/*', (req, res, next) => {
      const path = req.path;
      const serviceId = this.detectServiceFromPath(path);
      
      if (!serviceId) {
        return res.status(404).json({ error: 'Service not found' });
      }

      const instance = this.getHealthyInstance(serviceId);
      if (!instance) {
        return res.status(503).json({ error: 'Service unavailable' });
      }

      // プロキシリクエスト
      const proxy = createProxyMiddleware({
        target: `http://${instance.host}:${instance.port}`,
        changeOrigin: true,
        timeout: this.loadBalancer.timeout,
        onError: (err, req, res) => {
          console.error(`Proxy error for ${serviceId}:`, err);
          instance.status = 'unhealthy';
          res.status(502).json({ error: 'Bad Gateway' });
        }
      });

      proxy(req, res, next);
    });
  }

  private detectServiceFromPath(path: string): string | null {
    // パスからサービスを推定（簡略化）
    if (path.includes('/work') || path.includes('/submit')) return 'mining-core';
    if (path.includes('/payout') || path.includes('/balance')) return 'payment-service';
    if (path.includes('/pool') || path.includes('/network')) return 'stats-service';
    if (path.includes('/notify') || path.includes('/alert')) return 'notification-service';
    
    return null;
  }

  private getHealthyInstance(serviceId: string): ServiceInstance | null {
    const instances = this.instances.get(serviceId) || [];
    const healthyInstances = instances.filter(i => i.status === 'healthy');
    
    if (healthyInstances.length === 0) {
      return null;
    }

    // ロードバランシング
    switch (this.loadBalancer.strategy) {
      case 'round-robin':
        return healthyInstances[Date.now() % healthyInstances.length];
      case 'random':
        return healthyInstances[Math.floor(Math.random() * healthyInstances.length)];
      case 'least-connections':
        return healthyInstances.reduce((min, instance) => {
          const minMetrics = this.metrics.get(min.serviceId)!;
          const instanceMetrics = this.metrics.get(instance.serviceId)!;
          return instanceMetrics.activeConnections < minMetrics.activeConnections ? instance : min;
        });
      default:
        return healthyInstances[0];
    }
  }

  // === ヘルスチェック ===
  startHealthChecks(): void {
    this.healthCheckTimer = setInterval(async () => {
      await this.performHealthChecks();
    }, this.loadBalancer.healthCheckInterval);

    console.log(`💓 Health checks started (interval: ${this.loadBalancer.healthCheckInterval}ms)`);
  }

  private async performHealthChecks(): Promise<void> {
    for (const [serviceId, instances] of this.instances) {
      const service = this.services.get(serviceId);
      if (!service) continue;

      for (const instance of instances) {
        try {
          const response = await fetch(
            `http://${instance.host}:${instance.port}${service.healthCheck}`,
            { 
              method: 'GET',
              signal: AbortSignal.timeout(this.loadBalancer.timeout)
            }
          );

          if (response.ok) {
            instance.status = 'healthy';
            instance.lastHealthCheck = Date.now();
          } else {
            instance.status = 'unhealthy';
          }
        } catch (error) {
          instance.status = 'unhealthy';
          console.warn(`⚠️ Health check failed for ${instance.id}:`, error.message);
        }
      }
    }
  }

  // === ユーティリティ ===
  private getServiceStatus(serviceId: string): 'healthy' | 'degraded' | 'unhealthy' {
    const instances = this.instances.get(serviceId) || [];
    if (instances.length === 0) return 'unhealthy';

    const healthyCount = instances.filter(i => i.status === 'healthy').length;
    const healthyRatio = healthyCount / instances.length;

    if (healthyRatio >= 0.8) return 'healthy';
    if (healthyRatio >= 0.5) return 'degraded';
    return 'unhealthy';
  }

  private getTotalInstanceCount(): number {
    return Array.from(this.instances.values())
      .reduce((total, instances) => total + instances.length, 0);
  }

  // === ゲートウェイ開始 ===
  async startGateway(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.gatewayServer = this.gateway.listen(port, () => {
        console.log(`🌐 Microservice Gateway started on port ${port}`);
        resolve();
      });

      this.gatewayServer.on('error', reject);
    });
  }

  // === サービス停止 ===
  async stopService(serviceId: string): Promise<void> {
    const instances = this.instances.get(serviceId) || [];
    
    console.log(`🛑 Stopping service: ${serviceId}`);

    for (const instance of instances) {
      if (instance.server) {
        instance.status = 'stopping';
        instance.server.close();
        instance.status = 'stopped';
      }
    }

    this.instances.delete(serviceId);
    this.serviceRegistry.delete(serviceId);
    
    this.emit('serviceStopped', serviceId);
  }

  // === 全体停止 ===
  async stop(): Promise<void> {
    console.log('🛑 Stopping all microservices...');

    // ヘルスチェック停止
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    // 全サービス停止
    for (const serviceId of this.services.keys()) {
      await this.stopService(serviceId);
    }

    // ゲートウェイ停止
    if (this.gatewayServer) {
      this.gatewayServer.close();
    }

    console.log('✅ All microservices stopped');
  }

  // === 統計情報 ===
  getStats() {
    return {
      services: this.services.size,
      totalInstances: this.getTotalInstanceCount(),
      healthyInstances: Array.from(this.instances.values())
        .flat()
        .filter(i => i.status === 'healthy').length,
      metrics: Object.fromEntries(this.metrics),
      loadBalancer: this.loadBalancer
    };
  }

  getServiceInstances(serviceId: string): ServiceInstance[] {
    return this.instances.get(serviceId) || [];
  }

  getServiceMetrics(serviceId: string): ServiceMetrics | undefined {
    return this.metrics.get(serviceId);
  }
}

// === プリセットサービス定義 ===
export class MiningPoolMicroservices {
  static createMiningCoreService(): ServiceDefinition {
    return {
      id: 'mining-core',
      name: 'Mining Core Service',
      version: '1.0.0',
      port: 3001,
      healthCheck: '/health',
      endpoints: [
        { path: '/api/work', method: 'GET' },
        { path: '/api/submit', method: 'POST' },
        { path: '/api/stats', method: 'GET' }
      ],
      resources: {
        cpu: { min: 0.5, max: 2.0 },
        memory: { min: 512, max: 2048 },
        instances: { min: 1, max: 5 }
      },
      config: {
        environment: {
          NODE_ENV: 'production',
          LOG_LEVEL: 'info'
        }
      }
    };
  }

  static createPaymentService(): ServiceDefinition {
    return {
      id: 'payment-service',
      name: 'Payment Service',
      version: '1.0.0',
      port: 3002,
      healthCheck: '/health',
      endpoints: [
        { path: '/api/payout', method: 'POST' },
        { path: '/api/balance/:minerId', method: 'GET' },
        { path: '/api/history/:minerId', method: 'GET' }
      ],
      dependencies: ['mining-core'],
      resources: {
        cpu: { min: 0.3, max: 1.5 },
        memory: { min: 256, max: 1024 },
        instances: { min: 1, max: 3 }
      },
      config: {
        environment: {
          POOL_FEE: '0',
          MIN_PAYOUT: '0.001'
        }
      }
    };
  }

  static createStatsService(): ServiceDefinition {
    return {
      id: 'stats-service',
      name: 'Statistics Service',
      version: '1.0.0',
      port: 3003,
      healthCheck: '/health',
      endpoints: [
        { path: '/api/pool', method: 'GET' },
        { path: '/api/network', method: 'GET' },
        { path: '/api/miners', method: 'GET' }
      ],
      resources: {
        cpu: { min: 0.2, max: 1.0 },
        memory: { min: 128, max: 512 },
        instances: { min: 1, max: 2 }
      },
      config: {
        environment: {
          UPDATE_INTERVAL: '30000'
        }
      }
    };
  }

  static createNotificationService(): ServiceDefinition {
    return {
      id: 'notification-service',
      name: 'Notification Service',
      version: '1.0.0',
      port: 3004,
      healthCheck: '/health',
      endpoints: [
        { path: '/api/notify', method: 'POST' },
        { path: '/api/alert', method: 'POST' }
      ],
      resources: {
        cpu: { min: 0.1, max: 0.5 },
        memory: { min: 64, max: 256 },
        instances: { min: 1, max: 2 }
      },
      config: {
        environment: {
          ALERT_THRESHOLD: 'high'
        }
      }
    };
  }

  static getAllServices(): ServiceDefinition[] {
    return [
      this.createMiningCoreService(),
      this.createPaymentService(),
      this.createStatsService(),
      this.createNotificationService()
    ];
  }
}

export default LightMicroserviceManager;