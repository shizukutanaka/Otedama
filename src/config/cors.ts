/**
 * CORS (Cross-Origin Resource Sharing) configuration
 * Following security best practices while maintaining flexibility
 */

import { Request, Response, NextFunction } from 'express';
import { getEnvConfig } from './env';

export interface CorsOptions {
  origins?: string[] | '*';
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
  preflightContinue?: boolean;
  optionsSuccessStatus?: number;
}

export class CorsConfig {
  private options: Required<CorsOptions>;
  
  constructor(options?: CorsOptions) {
    const env = getEnvConfig();
    
    // Default CORS configuration
    this.options = {
      origins: options?.origins || this.getDefaultOrigins(),
      methods: options?.methods || ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
      allowedHeaders: options?.allowedHeaders || [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'Accept',
        'Origin',
        'Access-Control-Request-Method',
        'Access-Control-Request-Headers',
        'X-API-Key'
      ],
      exposedHeaders: options?.exposedHeaders || [
        'X-Total-Count',
        'X-Page-Count',
        'X-Current-Page',
        'X-Per-Page',
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset'
      ],
      credentials: options?.credentials ?? true,
      maxAge: options?.maxAge || 86400, // 24 hours
      preflightContinue: options?.preflightContinue || false,
      optionsSuccessStatus: options?.optionsSuccessStatus || 204
    };
  }
  
  private getDefaultOrigins(): string[] | '*' {
    const env = getEnvConfig();
    
    // In development, allow all origins
    if (env.NODE_ENV === 'development') {
      return '*';
    }
    
    // In production, use whitelist
    const origins: string[] = [];
    
    // Add configured origins
    if (process.env.CORS_ORIGINS) {
      origins.push(...process.env.CORS_ORIGINS.split(',').map(o => o.trim()));
    }
    
    // Add default production origins
    origins.push(
      'https://app.otedama.io',
      'https://otedama.io',
      'http://localhost:3000' // For local development with production API
    );
    
    return origins;
  }
  
  /**
   * CORS middleware factory
   */
  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const origin = req.headers.origin;
      
      // Handle origin validation
      if (this.options.origins === '*') {
        res.setHeader('Access-Control-Allow-Origin', '*');
      } else if (origin && this.options.origins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      } else if (!origin && req.method === 'GET') {
        // Allow requests without origin header (e.g., server-to-server)
        // Only for GET requests for security
      } else {
        // Origin not allowed - don't set CORS headers
        // The browser will block the request
      }
      
      // Set credentials
      if (this.options.credentials) {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      
      // Handle preflight requests
      if (req.method === 'OPTIONS') {
        // Set allowed methods
        res.setHeader(
          'Access-Control-Allow-Methods',
          this.options.methods.join(', ')
        );
        
        // Set allowed headers
        res.setHeader(
          'Access-Control-Allow-Headers',
          this.options.allowedHeaders.join(', ')
        );
        
        // Set max age
        res.setHeader(
          'Access-Control-Max-Age',
          this.options.maxAge.toString()
        );
        
        // End preflight request
        if (!this.options.preflightContinue) {
          res.status(this.options.optionsSuccessStatus).end();
          return;
        }
      }
      
      // Set exposed headers
      if (this.options.exposedHeaders.length > 0) {
        res.setHeader(
          'Access-Control-Expose-Headers',
          this.options.exposedHeaders.join(', ')
        );
      }
      
      next();
    };
  }
  
  /**
   * Dynamic CORS middleware with per-route configuration
   */
  static dynamic(routeOptions?: Partial<CorsOptions>) {
    const defaultConfig = new CorsConfig();
    
    return (req: Request, res: Response, next: NextFunction) => {
      // Merge route-specific options with defaults
      const config = new CorsConfig({
        ...defaultConfig.options,
        ...routeOptions
      });
      
      return config.middleware()(req, res, next);
    };
  }
  
  /**
   * Strict CORS for sensitive endpoints
   */
  static strict(allowedOrigins: string[]) {
    return new CorsConfig({
      origins: allowedOrigins,
      credentials: true,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }).middleware();
  }
  
  /**
   * Public CORS for open API endpoints
   */
  static public() {
    return new CorsConfig({
      origins: '*',
      credentials: false,
      methods: ['GET', 'HEAD'],
      maxAge: 3600 // 1 hour
    }).middleware();
  }
  
  /**
   * WebSocket CORS configuration
   */
  static websocket(allowedOrigins?: string[]) {
    return (req: Request, res: Response, next: NextFunction) => {
      const origin = req.headers.origin;
      
      if (!origin) {
        next();
        return;
      }
      
      const allowed = allowedOrigins || new CorsConfig().options.origins;
      
      if (allowed === '*' || (Array.isArray(allowed) && allowed.includes(origin))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      
      next();
    };
  }
}

// Security headers middleware
export function securityHeaders() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'DENY');
    
    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // Enable XSS filter
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    // Control referrer information
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    
    // Content Security Policy
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "connect-src 'self' wss: https:"
    ].join('; ');
    
    res.setHeader('Content-Security-Policy', csp);
    
    // Feature Policy
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    
    // HSTS (only in production with HTTPS)
    const env = getEnvConfig();
    if (env.NODE_ENV === 'production' && env.ENABLE_HTTPS) {
      res.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains; preload'
      );
    }
    
    next();
  };
}

// Export convenience functions
export const cors = {
  // Default CORS for most endpoints
  default: () => new CorsConfig().middleware(),
  
  // Dynamic CORS with options
  dynamic: CorsConfig.dynamic,
  
  // Strict CORS for sensitive endpoints
  strict: CorsConfig.strict,
  
  // Public CORS for open endpoints
  public: CorsConfig.public,
  
  // WebSocket CORS
  websocket: CorsConfig.websocket,
  
  // Security headers
  security: securityHeaders
};

export default cors;
