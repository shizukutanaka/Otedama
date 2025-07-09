/**
 * Otedama - シンプルAPIサーバー
 * 設計思想: Rob Pike (シンプル), John Carmack (高性能), Robert C. Martin (クリーン)
 * 
 * 基本機能のみ:
 * - 統計API
 * - 設定API  
 * - ヘルスチェック
 * - 軽量ログ
 */

import express, { Request, Response, NextFunction } from 'express';
import { createServer, Server } from 'http';
import { EventEmitter } from 'events';

// === 型定義 ===
export interface APIConfig {
  port: number;
  cors: boolean;
  rateLimit?: {
    windowMs: number;
    max: number;
  };
  auth?: {
    enabled: boolean;
    apiKey?: string;
  };
}

export interface APIStats {
  requests: number;
  errors: number;
  uptime: number;
  startTime: number;
  endpoints: Record<string, number>;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    memory: { status: string; usage: number };
    cpu: { status: string; usage: number };
    storage: { status: string; available: number };
  };
  timestamp: number;
}

// === シンプルAPIサーバー ===
export class SimpleAPIServer extends EventEmitter {
  private app: express.Application;
  private server: Server | null = null;
  private config: APIConfig;
  private stats: APIStats;
  private startTime: number;

  constructor(config: Partial<APIConfig> = {}) {
    super();
    
    this.config = {
      port: 3333,
      cors: true,
      ...config
    };

    this.startTime = Date.now();
    this.stats = {
      requests: 0,
      errors: 0,
      uptime: 0,
      startTime: this.startTime,
      endpoints: {}
    };

    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // JSON parser
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '1mb' }));

    // CORS
    if (this.config.cors) {
      this.app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
        
        if (req.method === 'OPTIONS') {
          res.sendStatus(200);
          return;
        }
        next();
      });
    }

    // 統計収集
    this.app.use((req, res, next) => {
      this.stats.requests++;
      this.stats.endpoints[req.path] = (this.stats.endpoints[req.path] || 0) + 1;
      this.stats.uptime = Date.now() - this.startTime;
      
      const start = Date.now();
      res.on('finish', () => {
        if (res.statusCode >= 400) {
          this.stats.errors++;
        }
        
        this.emit('request', {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration: Date.now() - start,
          ip: req.ip
        });
      });
      
      next();
    });

    // 認証（オプション）
    if (this.config.auth?.enabled) {
      this.app.use('/api', this.authMiddleware());
    }

    // エラーハンドリング
    this.app.use(this.errorHandler());
  }

  private setupRoutes(): void {
    // ヘルスチェック
    this.app.get('/health', (req, res) => {
      const health = this.getHealthStatus();
      const statusCode = health.status === 'healthy' ? 200 : 
                        health.status === 'degraded' ? 200 : 503;
      res.status(statusCode).json(health);
    });

    // API統計
    this.app.get('/api/stats', (req, res) => {
      res.json(this.getAPIStats());
    });

    // システム情報
    this.app.get('/api/system', (req, res) => {
      res.json(this.getSystemInfo());
    });

    // 設定API
    this.app.get('/api/config', (req, res) => {
      res.json({
        port: this.config.port,
        cors: this.config.cors,
        auth: this.config.auth?.enabled || false
      });
    });

    // マイニング統計（プレースホルダー）
    this.app.get('/api/mining/stats', (req, res) => {
      res.json({
        hashrate: 0,
        miners: 0,
        blocks: 0,
        shares: { accepted: 0, rejected: 0 },
        uptime: this.stats.uptime
      });
    });

    // 404ハンドラー
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Endpoint not found',
        path: req.originalUrl,
        method: req.method
      });
    });
  }

  private authMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
      
      if (!apiKey || apiKey !== this.config.auth?.apiKey) {
        return res.status(401).json({ error: 'Invalid or missing API key' });
      }
      
      next();
    };
  }

  private errorHandler() {
    return (err: any, req: Request, res: Response, next: NextFunction) => {
      console.error('API Error:', err);
      
      this.stats.errors++;
      this.emit('error', {
        error: err.message,
        path: req.path,
        method: req.method,
        timestamp: Date.now()
      });

      res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
      });
    };
  }

  private getHealthStatus(): HealthStatus {
    const memUsage = process.memoryUsage();
    const memoryPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    
    // CPU使用率は簡略化（実際は外部ライブラリが必要）
    const cpuUsage = process.cpuUsage();
    const cpuPercent = 0; // プレースホルダー

    return {
      status: memoryPercent > 90 ? 'unhealthy' : 
              memoryPercent > 70 ? 'degraded' : 'healthy',
      checks: {
        memory: {
          status: memoryPercent > 90 ? 'critical' : 
                  memoryPercent > 70 ? 'warning' : 'ok',
          usage: Math.round(memoryPercent)
        },
        cpu: {
          status: 'ok',
          usage: cpuPercent
        },
        storage: {
          status: 'ok',
          available: 1000000000 // プレースホルダー
        }
      },
      timestamp: Date.now()
    };
  }

  private getAPIStats(): APIStats {
    return {
      ...this.stats,
      uptime: Date.now() - this.startTime
    };
  }

  private getSystemInfo() {
    return {
      platform: process.platform,
      nodeVersion: process.version,
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      pid: process.pid,
      startTime: this.startTime
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.config.port, () => {
        console.log(`🚀 API Server listening on port ${this.config.port}`);
        console.log(`📊 Health check: http://localhost:${this.config.port}/health`);
        console.log(`📈 API stats: http://localhost:${this.config.port}/api/stats`);
        
        this.emit('started', { port: this.config.port });
        resolve();
      });

      this.server.on('error', (error) => {
        this.emit('error', error);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('🛑 API Server stopped');
          this.emit('stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // カスタムエンドポイント追加
  addEndpoint(method: 'get' | 'post' | 'put' | 'delete', path: string, handler: express.RequestHandler): void {
    this.app[method](path, handler);
    this.emit('endpointAdded', { method, path });
  }

  // マイニング統計更新用
  updateMiningStats(stats: any): void {
    this.app.get('/api/mining/stats', (req, res) => {
      res.json({
        ...stats,
        uptime: this.stats.uptime,
        timestamp: Date.now()
      });
    });
  }

  getPort(): number {
    return this.config.port;
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }
}

// === 使用例 ===
export async function createAPIServer(config?: Partial<APIConfig>): Promise<SimpleAPIServer> {
  const server = new SimpleAPIServer(config);
  
  // イベントハンドラー設定
  server.on('started', ({ port }) => {
    console.log(`✅ API Server ready on port ${port}`);
  });

  server.on('request', (data) => {
    if (data.status >= 400) {
      console.log(`⚠️ ${data.method} ${data.path} - ${data.status} (${data.duration}ms)`);
    }
  });

  server.on('error', (error) => {
    console.error('❌ API Server error:', error);
  });

  return server;
}

export default SimpleAPIServer;