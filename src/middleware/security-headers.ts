/**
 * セキュリティヘッダー設定 - 軽量版
 * XSS、CSRF、クリックジャッキング等の攻撃対策
 */

import { Request, Response, NextFunction } from 'express';

export interface SecurityHeadersOptions {
  // Content Security Policy
  csp?: {
    defaultSrc?: string[];
    scriptSrc?: string[];
    styleSrc?: string[];
    imgSrc?: string[];
  } | boolean;

  // X-Frame-Options
  frameOptions?: 'deny' | 'sameorigin' | boolean;

  // HTTP Strict Transport Security
  hsts?: {
    maxAge?: number;
    includeSubDomains?: boolean;
  } | boolean;

  // X-Content-Type-Options
  noSniff?: boolean;

  // X-XSS-Protection
  xssFilter?: boolean;

  // Referrer-Policy
  referrerPolicy?: string | boolean;

  // カスタムヘッダー
  customHeaders?: { [key: string]: string };
}

export class SecurityHeadersManager {
  private config: Required<SecurityHeadersOptions>;
  private stats = {
    requestsProcessed: 0,
    headersSet: 0
  };

  constructor(options: SecurityHeadersOptions = {}) {
    this.config = {
      csp: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:']
      },
      frameOptions: 'deny',
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true
      },
      noSniff: true,
      xssFilter: true,
      referrerPolicy: 'strict-origin-when-cross-origin',
      customHeaders: {},
      ...options
    };

    console.log('[Security Headers] Initialized');
  }

  /**
   * セキュリティヘッダーミドルウェア
   */
  public middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      this.stats.requestsProcessed++;
      let headersSet = 0;

      // X-Powered-By を隠す
      res.removeHeader('X-Powered-By');
      headersSet++;

      // Content Security Policy
      if (this.config.csp && typeof this.config.csp === 'object') {
        const directives: string[] = [];
        
        if (this.config.csp.defaultSrc) {
          directives.push(`default-src ${this.config.csp.defaultSrc.join(' ')}`);
        }
        if (this.config.csp.scriptSrc) {
          directives.push(`script-src ${this.config.csp.scriptSrc.join(' ')}`);
        }
        if (this.config.csp.styleSrc) {
          directives.push(`style-src ${this.config.csp.styleSrc.join(' ')}`);
        }
        if (this.config.csp.imgSrc) {
          directives.push(`img-src ${this.config.csp.imgSrc.join(' ')}`);
        }

        if (directives.length > 0) {
          res.setHeader('Content-Security-Policy', directives.join('; '));
          headersSet++;
        }
      }

      // X-Frame-Options
      if (this.config.frameOptions && typeof this.config.frameOptions === 'string') {
        res.setHeader('X-Frame-Options', this.config.frameOptions.toUpperCase());
        headersSet++;
      }

      // HTTP Strict Transport Security
      if (this.config.hsts && req.secure && typeof this.config.hsts === 'object') {
        let value = `max-age=${this.config.hsts.maxAge}`;
        if (this.config.hsts.includeSubDomains) {
          value += '; includeSubDomains';
        }
        res.setHeader('Strict-Transport-Security', value);
        headersSet++;
      }

      // X-Content-Type-Options
      if (this.config.noSniff) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        headersSet++;
      }

      // X-XSS-Protection
      if (this.config.xssFilter) {
        res.setHeader('X-XSS-Protection', '1; mode=block');
        headersSet++;
      }

      // Referrer-Policy
      if (this.config.referrerPolicy && typeof this.config.referrerPolicy === 'string') {
        res.setHeader('Referrer-Policy', this.config.referrerPolicy);
        headersSet++;
      }

      // カスタムヘッダー
      for (const [header, value] of Object.entries(this.config.customHeaders)) {
        res.setHeader(header, value);
        headersSet++;
      }

      this.stats.headersSet += headersSet;
      next();
    };
  }

  /**
   * 統計情報取得
   */
  public getStats() {
    return {
      ...this.stats,
      avgHeadersPerRequest: this.stats.requestsProcessed > 0 
        ? Math.round((this.stats.headersSet / this.stats.requestsProcessed) * 100) / 100 
        : 0
    };
  }

  /**
   * 統計リセット
   */
  public resetStats(): void {
    this.stats = {
      requestsProcessed: 0,
      headersSet: 0
    };
  }
}

// デフォルトのセキュリティヘッダーミドルウェア
export const createSecurityHeadersMiddleware = (options?: SecurityHeadersOptions) => {
  const manager = new SecurityHeadersManager(options);
  return manager.middleware();
};

export default SecurityHeadersManager;