/**
 * CORS (Cross-Origin Resource Sharing) 設定
 * セキュアなクロスオリジンアクセス制御
 */

import { Request, Response, NextFunction } from 'express';
import { createError, ErrorCode } from '../errors/types';

export interface CorsOptions {
  // 許可するオリジン
  origin?: string | string[] | RegExp | ((origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void);
  
  // 許可するHTTPメソッド
  methods?: string | string[];
  
  // 許可するヘッダー
  allowedHeaders?: string | string[];
  
  // 公開するヘッダー
  exposedHeaders?: string | string[];
  
  // 認証情報の送信を許可
  credentials?: boolean;
  
  // プリフライトキャッシュ時間（秒）
  maxAge?: number;
  
  // OPTIONSリクエストへの自動レスポンス
  optionsSuccessStatus?: number;
  
  // プリフライトを続行するか
  preflightContinue?: boolean;

  // 開発モード
  development?: boolean;

  // セキュリティ強化オプション
  strictMode?: boolean;
}

interface CorsConfig extends Required<CorsOptions> {
  allowedOriginsCache: Set<string>;
  regexOrigins: RegExp[];
}

export class CorsManager {
  private config: CorsConfig;
  private stats = {
    totalRequests: 0,
    allowedRequests: 0,
    blockedRequests: 0,
    preflightRequests: 0,
    originViolations: 0
  };

  constructor(options: CorsOptions = {}) {
    // デフォルト設定
    const defaultOptions: Required<CorsOptions> = {
      origin: this.getDefaultOrigins(),
      methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Origin',
        'X-Requested-With',
        'Content-Type',
        'Accept',
        'Authorization',
        'Cache-Control',
        'X-API-Key',
        'X-Forwarded-For',
        'User-Agent'
      ],
      exposedHeaders: [
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
        'X-Response-Time'
      ],
      credentials: false,
      maxAge: 86400, // 24時間
      optionsSuccessStatus: 204,
      preflightContinue: false,
      development: process.env.NODE_ENV === 'development',
      strictMode: process.env.NODE_ENV === 'production'
    };

    this.config = {
      ...defaultOptions,
      ...options,
      allowedOriginsCache: new Set(),
      regexOrigins: []
    };

    this.initializeOriginHandling();
    console.log('[CORS] Initialized with config:', this.getSafeConfig());
  }

  private getDefaultOrigins(): string[] {
    const origins = [];
    
    if (process.env.NODE_ENV === 'development') {
      origins.push(
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:8080',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3001',
        'http://127.0.0.1:8080'
      );
    } else {
      // プロダクション環境では環境変数から取得
      const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS;
      if (allowedOrigins) {
        origins.push(...allowedOrigins.split(',').map(origin => origin.trim()));
      }
    }

    return origins;
  }

  private initializeOriginHandling(): void {
    if (Array.isArray(this.config.origin)) {
      // 文字列配列を高速検索用Setに変換
      this.config.origin.forEach(origin => {
        if (typeof origin === 'string') {
          if (origin.includes('*') || origin.includes('?')) {
            // ワイルドカードを正規表現に変換
            const regex = new RegExp('^' + origin.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
            this.config.regexOrigins.push(regex);
          } else {
            this.config.allowedOriginsCache.add(origin);
          }
        }
      });
    }
  }

  /**
   * CORSミドルウェア
   */
  public middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      this.stats.totalRequests++;

      const origin = req.headers.origin;
      const method = req.method;

      // Origin検証
      const isOriginAllowed = this.isOriginAllowed(origin);
      
      if (!isOriginAllowed && this.config.strictMode && origin) {
        this.stats.originViolations++;
        this.stats.blockedRequests++;
        
        console.warn('[CORS] Blocked request from unauthorized origin:', origin);
        
        const error = createError.security(
          ErrorCode.SECURITY_UNAUTHORIZED_ACCESS,
          'CORS policy violation',
          {
            context: {
              origin,
              ip: req.ip,
              userAgent: req.headers['user-agent'],
              method: req.method,
              path: req.path
            }
          }
        );
        
        return res.status(403).json({
          error: 'CORS policy violation',
          message: 'Origin not allowed'
        });
      }

      // CORS ヘッダー設定
      this.setCorsHeaders(req, res, isOriginAllowed);

      // プリフライトリクエスト処理
      if (method === 'OPTIONS') {
        this.stats.preflightRequests++;
        
        if (this.config.preflightContinue) {
          next();
        } else {
          res.status(this.config.optionsSuccessStatus).end();
        }
        return;
      }

      if (isOriginAllowed) {
        this.stats.allowedRequests++;
      } else {
        this.stats.blockedRequests++;
      }

      next();
    };
  }

  private isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) {
      // オリジンなし（同一オリジンリクエスト）は通常許可
      return !this.config.strictMode;
    }

    // 開発モードでは全て許可
    if (this.config.development && !this.config.strictMode) {
      return true;
    }

    if (typeof this.config.origin === 'string') {
      if (this.config.origin === '*') {
        return true;
      }
      return this.config.origin === origin;
    }

    if (Array.isArray(this.config.origin)) {
      // 高速検索用Setでチェック
      if (this.config.allowedOriginsCache.has(origin)) {
        return true;
      }

      // 正規表現でチェック
      for (const regex of this.config.regexOrigins) {
        if (regex.test(origin)) {
          return true;
        }
      }

      return false;
    }

    if (this.config.origin instanceof RegExp) {
      return this.config.origin.test(origin);
    }

    if (typeof this.config.origin === 'function') {
      return new Promise<boolean>((resolve) => {
        this.config.origin(origin, (err, allow) => {
          resolve(!err && !!allow);
        });
      }) as any; // 非同期処理の簡略化
    }

    return false;
  }

  private setCorsHeaders(req: Request, res: Response, isOriginAllowed: boolean): void {
    const origin = req.headers.origin;

    // Access-Control-Allow-Origin
    if (isOriginAllowed && origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (this.config.origin === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    // Access-Control-Allow-Credentials
    if (this.config.credentials && isOriginAllowed) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    // Access-Control-Allow-Methods
    const methods = Array.isArray(this.config.methods) 
      ? this.config.methods.join(',') 
      : this.config.methods;
    res.setHeader('Access-Control-Allow-Methods', methods);

    // Access-Control-Allow-Headers
    const allowedHeaders = Array.isArray(this.config.allowedHeaders)
      ? this.config.allowedHeaders.join(',')
      : this.config.allowedHeaders;
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders);

    // Access-Control-Expose-Headers
    const exposedHeaders = Array.isArray(this.config.exposedHeaders)
      ? this.config.exposedHeaders.join(',')
      : this.config.exposedHeaders;
    if (exposedHeaders) {
      res.setHeader('Access-Control-Expose-Headers', exposedHeaders);
    }

    // Access-Control-Max-Age
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Max-Age', this.config.maxAge.toString());
    }

    // セキュリティヘッダーの追加
    if (this.config.strictMode) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    }
  }

  /**
   * オリジンを動的に追加
   */
  public addAllowedOrigin(origin: string): void {
    if (Array.isArray(this.config.origin)) {
      this.config.origin.push(origin);
      this.config.allowedOriginsCache.add(origin);
    } else {
      this.config.origin = [this.config.origin as string, origin];
      this.initializeOriginHandling();
    }
    console.log('[CORS] Added allowed origin:', origin);
  }

  /**
   * オリジンを動的に削除
   */
  public removeAllowedOrigin(origin: string): void {
    if (Array.isArray(this.config.origin)) {
      const index = this.config.origin.indexOf(origin);
      if (index > -1) {
        this.config.origin.splice(index, 1);
        this.config.allowedOriginsCache.delete(origin);
      }
    }
    console.log('[CORS] Removed allowed origin:', origin);
  }

  /**
   * 設定を更新
   */
  public updateConfig(options: Partial<CorsOptions>): void {
    this.config = { ...this.config, ...options };
    this.initializeOriginHandling();
    console.log('[CORS] Configuration updated');
  }

  /**
   * 統計情報取得
   */
  public getStats() {
    return {
      ...this.stats,
      allowedOrigins: Array.from(this.config.allowedOriginsCache),
      regexOriginsCount: this.config.regexOrigins.length,
      config: this.getSafeConfig()
    };
  }

  private getSafeConfig() {
    return {
      methods: this.config.methods,
      allowedHeaders: this.config.allowedHeaders,
      exposedHeaders: this.config.exposedHeaders,
      credentials: this.config.credentials,
      maxAge: this.config.maxAge,
      development: this.config.development,
      strictMode: this.config.strictMode,
      allowedOriginsCount: this.config.allowedOriginsCache.size
    };
  }

  /**
   * 統計リセット
   */
  public resetStats(): void {
    this.stats = {
      totalRequests: 0,
      allowedRequests: 0,
      blockedRequests: 0,
      preflightRequests: 0,
      originViolations: 0
    };
  }
}

// デフォルトのCORS設定
export const createCorsMiddleware = (options?: CorsOptions) => {
  const corsManager = new CorsManager(options);
  return corsManager.middleware();
};

// プリセット設定
export const CORS_PRESETS = {
  // 開発環境用（緩い設定）
  development: {
    origin: '*',
    credentials: true,
    development: true,
    strictMode: false
  },

  // プロダクション環境用（厳格な設定）
  production: {
    origin: process.env.CORS_ALLOWED_ORIGINS?.split(',') || [],
    credentials: false,
    development: false,
    strictMode: true,
    maxAge: 3600 // 1時間
  },

  // API専用（最小限の設定）
  api: {
    origin: false, // オリジンチェックを無効化
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    credentials: false
  },

  // パブリックAPI用
  public: {
    origin: '*',
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: false,
    maxAge: 86400 // 24時間
  }
};

export default CorsManager;