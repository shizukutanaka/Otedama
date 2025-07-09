/**
 * 軽量APIゲートウェイ
 * 設計思想: Rob Pike (シンプル), John Carmack (高性能), Robert C. Martin (クリーン)
 */

import express, { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, Options } from 'http-proxy-middleware';
import rateLimit from 'express-rate-limit';
import { EventEmitter } from 'events';
import axios, { AxiosResponse } from 'axios';
import { createHash } from 'crypto';

// === 型定義 ===
export interface Route {
  id: string;
  path: string;
  target: string;
  method?: string | string[];
  stripPath?: boolean;
  preserveHost?: boolean;
  timeout?: number;
  retries?: number;
  auth?: AuthConfig;
  rateLimit?: RateLimitConfig;
  middleware?: string[];
  enabled: boolean;
  metadata?: Record<string, any>;
}

export interface AuthConfig {
  type: 'bearer' | 'apikey' | 'basic' | 'none';
  headerName?: string;
  validate?: (token: string) => Promise<boolean>;
  required?: boolean;
}

export interface RateLimitConfig {
  windowMs: number;
  max: number;
  message?: string;
  skipSuccessfulRequests?: boolean;
}

export interface LoadBalancingConfig {
  algorithm: 'round-robin' | 'weighted' | 'least-connections';
  healthCheck: {
    path: string;
    interval: number;
    timeout: number;
  };
}

export interface ServiceInstance {
  id: string;
  url: string;
  weight: number;
  healthy: boolean;
  connections: number;
  lastCheck: number;
}

export interface CircuitBreakerConfig {
  enabled: boolean;
  failureThreshold: number;
  resetTimeout: number;
  monitoringPeriod: number;
}

// === 軽量APIゲートウェイ ===
export class LightAPIGateway extends EventEmitter {
  private app: express.Application;
  private routes = new Map<string, Route>();
  private services = new Map<string, ServiceInstance[]>();
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private metrics = new Map<string, RouteMetrics>();
  private middleware = new Map<string, MiddlewareFunction>();
  private server: any;

  constructor() {
    super();
    this.app = express();
    this.setupBaseMiddleware();
    this.setupDefaultMiddleware();
  }

  // === 基本設定 ===
  private setupBaseMiddleware(): void {
    // JSON解析
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // ヘルスチェック
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        timestamp: Date.now(),
        routes: this.routes.size,
        services: Array.from(this.services.keys()).length
      });
    });

    // メトリクス
    this.app.get('/metrics', (req, res) => {
      const allMetrics = Array.from(this.metrics.entries()).reduce((acc, [id, metrics]) => {
        acc[id] = metrics.toJSON();
        return acc;
      }, {} as Record<string, any>);

      res.json(allMetrics);
    });
  }

  // === ルート管理 ===
  addRoute(route: Route): void {
    this.routes.set(route.id, route);
    this.setupRoute(route);
    this.emit('routeAdded', route);
  }

  removeRoute(id: string): boolean {
    const route = this.routes.get(id);
    if (route) {
      this.routes.delete(id);
      this.metrics.delete(id);
      this.emit('routeRemoved', route);
      return true;
    }
    return false;
  }

  enableRoute(id: string): boolean {
    const route = this.routes.get(id);
    if (route) {
      route.enabled = true;
      this.setupRoute(route);
      return true;
    }
    return false;
  }

  disableRoute(id: string): boolean {
    const route = this.routes.get(id);
    if (route) {
      route.enabled = false;
      return true;
    }
    return false;
  }

  private setupRoute(route: Route): void {
    if (!route.enabled) return;

    const metrics = this.getOrCreateMetrics(route.id);
    const circuitBreaker = this.getOrCreateCircuitBreaker(route.id);

    // ミドルウェアスタック
    const middlewareStack: any[] = [];

    // レート制限
    if (route.rateLimit) {
      middlewareStack.push(this.createRateLimit(route.rateLimit));
    }

    // 認証
    if (route.auth && route.auth.type !== 'none') {
      middlewareStack.push(this.createAuthMiddleware(route.auth));
    }

    // カスタムミドルウェア
    if (route.middleware) {
      route.middleware.forEach(name => {
        const middleware = this.middleware.get(name);
        if (middleware) {
          middlewareStack.push(middleware);
        }
      });
    }

    // メトリクス収集
    middlewareStack.push(this.createMetricsMiddleware(metrics));

    // サーキットブレーカー
    middlewareStack.push(this.createCircuitBreakerMiddleware(circuitBreaker));

    // プロキシ
    middlewareStack.push(this.createProxyMiddleware(route));

    // ルート登録
    const methods = Array.isArray(route.method) ? route.method : [route.method || 'all'];
    methods.forEach(method => {
      const methodName = method.toLowerCase() as keyof express.Application;
      if (typeof this.app[methodName] === 'function') {
        (this.app[methodName] as any)(route.path, ...middlewareStack);
      }
    });
  }

  // === ミドルウェア作成 ===
  private createRateLimit(config: RateLimitConfig) {
    return rateLimit({
      windowMs: config.windowMs,
      max: config.max,
      message: config.message || 'Too many requests',
      skipSuccessfulRequests: config.skipSuccessfulRequests
    });
  }

  private createAuthMiddleware(config: AuthConfig) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const token = this.extractToken(req, config);
        
        if (!token && config.required) {
          return res.status(401).json({ error: 'Authentication required' });
        }

        if (token && config.validate) {
          const isValid = await config.validate(token);
          if (!isValid) {
            return res.status(401).json({ error: 'Invalid authentication' });
          }
        }

        next();
      } catch (error) {
        res.status(500).json({ error: 'Authentication error' });
      }
    };
  }

  private createMetricsMiddleware(metrics: RouteMetrics) {
    return (req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      metrics.incrementRequests();

      res.on('finish', () => {
        const duration = Date.now() - start;
        metrics.recordResponse(res.statusCode, duration);
      });

      next();
    };
  }

  private createCircuitBreakerMiddleware(circuitBreaker: CircuitBreaker) {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!circuitBreaker.canExecute()) {
        return res.status(503).json({ 
          error: 'Service temporarily unavailable',
          circuitBreaker: 'open'
        });
      }
      next();
    };
  }

  private createProxyMiddleware(route: Route): any {
    const options: Options = {
      target: route.target,
      changeOrigin: !route.preserveHost,
      pathRewrite: route.stripPath ? { [`^${route.path}`]: '' } : undefined,
      timeout: route.timeout || 30000,
      onError: (err, req, res) => {
        const circuitBreaker = this.getOrCreateCircuitBreaker(route.id);
        circuitBreaker.recordFailure();
        
        const statusCode = err.message.includes('timeout') ? 504 : 502;
        (res as Response).status(statusCode).json({
          error: 'Gateway error',
          message: err.message
        });
      },
      onProxyRes: (proxyRes, req, res) => {
        const circuitBreaker = this.getOrCreateCircuitBreaker(route.id);
        if (proxyRes.statusCode < 500) {
          circuitBreaker.recordSuccess();
        } else {
          circuitBreaker.recordFailure();
        }
      }
    };

    return createProxyMiddleware(options);
  }

  private extractToken(req: Request, config: AuthConfig): string | null {
    switch (config.type) {
      case 'bearer':
        const authHeader = req.headers.authorization;
        return authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
      
      case 'apikey':
        const headerName = config.headerName || 'x-api-key';
        return req.headers[headerName] as string || null;
      
      case 'basic':
        const basicAuth = req.headers.authorization;
        return basicAuth?.startsWith('Basic ') ? basicAuth : null;
      
      default:
        return null;
    }
  }

  // === サービス発見とロードバランシング ===
  addService(serviceName: string, instances: ServiceInstance[]): void {
    this.services.set(serviceName, instances);
    this.startHealthChecks(serviceName);
  }

  removeService(serviceName: string): boolean {
    return this.services.delete(serviceName);
  }

  private async startHealthChecks(serviceName: string): Promise<void> {
    const instances = this.services.get(serviceName);
    if (!instances) return;

    // 簡易ヘルスチェック（本来はより詳細な実装が必要）
    setInterval(async () => {
      for (const instance of instances) {
        try {
          const response = await axios.get(`${instance.url}/health`, { timeout: 5000 });
          instance.healthy = response.status === 200;
          instance.lastCheck = Date.now();
        } catch (error) {
          instance.healthy = false;
          instance.lastCheck = Date.now();
        }
      }
    }, 30000); // 30秒間隔
  }

  // === カスタムミドルウェア ===
  addMiddleware(name: string, middleware: MiddlewareFunction): void {
    this.middleware.set(name, middleware);
  }

  removeMiddleware(name: string): boolean {
    return this.middleware.delete(name);
  }

  private setupDefaultMiddleware(): void {
    // CORS
    this.addMiddleware('cors', (req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    // ログ
    this.addMiddleware('logger', (req, res, next) => {
      console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
      next();
    });

    // セキュリティヘッダー
    this.addMiddleware('security', (req, res, next) => {
      res.header('X-Content-Type-Options', 'nosniff');
      res.header('X-Frame-Options', 'DENY');
      res.header('X-XSS-Protection', '1; mode=block');
      next();
    });
  }

  // === ユーティリティ ===
  private getOrCreateMetrics(routeId: string): RouteMetrics {
    let metrics = this.metrics.get(routeId);
    if (!metrics) {
      metrics = new RouteMetrics();
      this.metrics.set(routeId, metrics);
    }
    return metrics;
  }

  private getOrCreateCircuitBreaker(routeId: string): CircuitBreaker {
    let circuitBreaker = this.circuitBreakers.get(routeId);
    if (!circuitBreaker) {
      circuitBreaker = new CircuitBreaker();
      this.circuitBreakers.set(routeId, circuitBreaker);
    }
    return circuitBreaker;
  }

  // === サーバー操作 ===
  start(port: number = 8080): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, () => {
        console.log(`API Gateway listening on port ${port}`);
        resolve();
      });
      
      this.server.on('error', reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('API Gateway stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // === 統計・情報取得 ===
  getRoutes(): Route[] {
    return Array.from(this.routes.values());
  }

  getRoute(id: string): Route | undefined {
    return this.routes.get(id);
  }

  getMetrics(routeId?: string) {
    if (routeId) {
      return this.metrics.get(routeId)?.toJSON();
    }
    
    const allMetrics = Array.from(this.metrics.entries()).reduce((acc, [id, metrics]) => {
      acc[id] = metrics.toJSON();
      return acc;
    }, {} as Record<string, any>);

    return allMetrics;
  }

  getServices(): Record<string, ServiceInstance[]> {
    return Object.fromEntries(this.services.entries());
  }
}

// === ルートメトリクス ===
class RouteMetrics {
  private requests = 0;
  private responses = new Map<number, number>();
  private responseTimes: number[] = [];
  private errors = 0;
  private lastRequest = 0;

  incrementRequests(): void {
    this.requests++;
    this.lastRequest = Date.now();
  }

  recordResponse(statusCode: number, responseTime: number): void {
    const count = this.responses.get(statusCode) || 0;
    this.responses.set(statusCode, count + 1);
    
    this.responseTimes.push(responseTime);
    if (this.responseTimes.length > 1000) {
      this.responseTimes.shift();
    }

    if (statusCode >= 400) {
      this.errors++;
    }
  }

  toJSON() {
    const avgResponseTime = this.responseTimes.length > 0 
      ? this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length 
      : 0;

    return {
      requests: this.requests,
      errors: this.errors,
      errorRate: this.requests > 0 ? this.errors / this.requests : 0,
      responses: Object.fromEntries(this.responses.entries()),
      avgResponseTime,
      lastRequest: this.lastRequest
    };
  }
}

// === サーキットブレーカー ===
class CircuitBreaker {
  private failures = 0;
  private successes = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private readonly failureThreshold = 5;
  private readonly resetTimeout = 60000; // 1分

  recordSuccess(): void {
    this.successes++;
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
    }
  }

  canExecute(): boolean {
    if (this.state === 'closed') {
      return true;
    }

    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }

    // half-open
    return true;
  }

  getState(): string {
    return this.state;
  }
}

// === 型定義 ===
type MiddlewareFunction = (req: Request, res: Response, next: NextFunction) => void;

// === ヘルパー関数 ===
export class GatewayHelper {
  static createRoute(id: string, path: string, target: string, options: Partial<Route> = {}): Route {
    return {
      id,
      path,
      target,
      method: 'all',
      stripPath: false,
      preserveHost: false,
      timeout: 30000,
      retries: 3,
      enabled: true,
      ...options
    };
  }

  static createBearerAuth(validate?: (token: string) => Promise<boolean>): AuthConfig {
    return {
      type: 'bearer',
      validate,
      required: true
    };
  }

  static createApiKeyAuth(headerName = 'x-api-key', validate?: (token: string) => Promise<boolean>): AuthConfig {
    return {
      type: 'apikey',
      headerName,
      validate,
      required: true
    };
  }

  static createRateLimit(windowMs: number, max: number): RateLimitConfig {
    return {
      windowMs,
      max,
      message: 'Too many requests from this IP'
    };
  }

  static createServiceInstance(id: string, url: string, weight = 1): ServiceInstance {
    return {
      id,
      url,
      weight,
      healthy: true,
      connections: 0,
      lastCheck: Date.now()
    };
  }
}

export default LightAPIGateway;