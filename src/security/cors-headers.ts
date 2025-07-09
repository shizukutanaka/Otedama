// CORS Configuration & Security Headers (Items 72, 73: Security Enhancements)
// Following security-first principles with pragmatic configuration

import { Logger } from '../logging/logger';

export interface CORSConfig {
  enabled: boolean;
  origins: string[] | '*';
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
  credentials: boolean;
  maxAge: number;
  preflightContinue: boolean;
}

export interface SecurityHeadersConfig {
  enabled: boolean;
  contentSecurityPolicy: string | false;
  frameOptions: 'DENY' | 'SAMEORIGIN' | 'ALLOW-FROM' | false;
  contentTypeOptions: boolean;
  referrerPolicy: string | false;
  strictTransportSecurity: {
    enabled: boolean;
    maxAge: number;
    includeSubDomains: boolean;
    preload: boolean;
  } | false;
  permissionsPolicy: string | false;
  crossOriginEmbedderPolicy: 'require-corp' | 'unsafe-none' | false;
  crossOriginOpenerPolicy: 'same-origin' | 'same-origin-allow-popups' | 'unsafe-none' | false;
  crossOriginResourcePolicy: 'same-origin' | 'cross-origin' | 'same-site' | false;
}

/**
 * Security Middleware Manager - handles CORS and security headers
 * Provides protection against common web vulnerabilities
 */
export class SecurityMiddleware {
  private logger = new Logger('SecurityMiddleware');
  private corsConfig: CORSConfig;
  private headersConfig: SecurityHeadersConfig;
  
  constructor(corsConfig: CORSConfig, headersConfig: SecurityHeadersConfig) {
    this.corsConfig = corsConfig;
    this.headersConfig = headersConfig;
    
    this.validateConfigurations();
  }
  
  /**
   * Validate security configurations
   */
  private validateConfigurations(): void {
    // Validate CORS origins
    if (Array.isArray(this.corsConfig.origins)) {
      for (const origin of this.corsConfig.origins) {
        try {
          new URL(origin);
        } catch (error) {
          this.logger.warn(`Invalid CORS origin: ${origin}`);
        }
      }
    }
    
    // Warn about potentially insecure configurations
    if (this.corsConfig.origins === '*' && this.corsConfig.credentials) {
      this.logger.warn('CORS configured with wildcard origin and credentials - this is insecure');
    }
    
    if (this.headersConfig.frameOptions === false) {
      this.logger.warn('X-Frame-Options disabled - clickjacking protection removed');
    }
    
    if (this.headersConfig.contentSecurityPolicy === false) {
      this.logger.warn('Content Security Policy disabled - XSS protection reduced');
    }
  }
  
  /**
   * Express middleware for CORS handling
   */
  corsMiddleware() {
    return (req: any, res: any, next: any) => {
      if (!this.corsConfig.enabled) {
        return next();
      }
      
      const origin = req.headers.origin;
      const requestMethod = req.method;
      const requestHeaders = req.headers['access-control-request-headers'];
      
      // Handle preflight requests
      if (requestMethod === 'OPTIONS') {
        this.handlePreflightRequest(req, res);
        return;
      }
      
      // Set CORS headers for actual requests
      this.setActualRequestHeaders(req, res);
      
      next();
    };
  }
  
  /**
   * Handle CORS preflight requests
   */
  private handlePreflightRequest(req: any, res: any): void {
    const origin = req.headers.origin;
    const requestMethod = req.headers['access-control-request-method'];
    const requestHeaders = req.headers['access-control-request-headers'];
    
    // Check if origin is allowed
    if (!this.isOriginAllowed(origin)) {
      this.logger.warn(`CORS preflight rejected for origin: ${origin}`);
      res.status(403).end();
      return;
    }
    
    // Check if method is allowed
    if (requestMethod && !this.corsConfig.methods.includes(requestMethod)) {
      this.logger.warn(`CORS preflight rejected for method: ${requestMethod}`);
      res.status(403).end();
      return;
    }
    
    // Set preflight response headers
    res.header('Access-Control-Allow-Origin', this.getOriginHeader(origin));
    res.header('Access-Control-Allow-Methods', this.corsConfig.methods.join(', '));
    res.header('Access-Control-Allow-Headers', this.corsConfig.allowedHeaders.join(', '));
    res.header('Access-Control-Max-Age', this.corsConfig.maxAge.toString());
    
    if (this.corsConfig.credentials) {
      res.header('Access-Control-Allow-Credentials', 'true');
    }
    
    if (this.corsConfig.preflightContinue) {
      return;
    }
    
    res.status(204).end();
  }
  
  /**
   * Set CORS headers for actual requests
   */
  private setActualRequestHeaders(req: any, res: any): void {
    const origin = req.headers.origin;
    
    if (!this.isOriginAllowed(origin)) {
      this.logger.warn(`CORS request rejected for origin: ${origin}`);
      return;
    }
    
    res.header('Access-Control-Allow-Origin', this.getOriginHeader(origin));
    
    if (this.corsConfig.credentials) {
      res.header('Access-Control-Allow-Credentials', 'true');
    }
    
    if (this.corsConfig.exposedHeaders.length > 0) {
      res.header('Access-Control-Expose-Headers', this.corsConfig.exposedHeaders.join(', '));
    }
  }
  
  /**
   * Check if origin is allowed
   */
  private isOriginAllowed(origin: string): boolean {
    if (!origin) {
      return true; // Allow requests without origin (like from Postman)
    }
    
    if (this.corsConfig.origins === '*') {
      return true;
    }
    
    if (Array.isArray(this.corsConfig.origins)) {
      return this.corsConfig.origins.includes(origin);
    }
    
    return false;
  }
  
  /**
   * Get origin header value
   */
  private getOriginHeader(origin: string): string {
    if (this.corsConfig.origins === '*' && !this.corsConfig.credentials) {
      return '*';
    }
    
    return origin || '*';
  }
  
  /**
   * Express middleware for security headers
   */
  securityHeadersMiddleware() {
    return (req: any, res: any, next: any) => {
      if (!this.headersConfig.enabled) {
        return next();
      }
      
      this.setSecurityHeaders(req, res);
      next();
    };
  }
  
  /**
   * Set security headers
   */
  private setSecurityHeaders(req: any, res: any): void {
    // Content Security Policy
    if (this.headersConfig.contentSecurityPolicy) {
      res.header('Content-Security-Policy', this.headersConfig.contentSecurityPolicy);
    }
    
    // X-Frame-Options
    if (this.headersConfig.frameOptions) {
      res.header('X-Frame-Options', this.headersConfig.frameOptions);
    }
    
    // X-Content-Type-Options
    if (this.headersConfig.contentTypeOptions) {
      res.header('X-Content-Type-Options', 'nosniff');
    }
    
    // Referrer Policy
    if (this.headersConfig.referrerPolicy) {
      res.header('Referrer-Policy', this.headersConfig.referrerPolicy);
    }
    
    // Strict Transport Security
    if (this.headersConfig.strictTransportSecurity) {
      const hsts = this.headersConfig.strictTransportSecurity;
      let hstsValue = `max-age=${hsts.maxAge}`;
      
      if (hsts.includeSubDomains) {
        hstsValue += '; includeSubDomains';
      }
      
      if (hsts.preload) {
        hstsValue += '; preload';
      }
      
      res.header('Strict-Transport-Security', hstsValue);
    }
    
    // Permissions Policy
    if (this.headersConfig.permissionsPolicy) {
      res.header('Permissions-Policy', this.headersConfig.permissionsPolicy);
    }
    
    // Cross-Origin Headers
    if (this.headersConfig.crossOriginEmbedderPolicy) {
      res.header('Cross-Origin-Embedder-Policy', this.headersConfig.crossOriginEmbedderPolicy);
    }
    
    if (this.headersConfig.crossOriginOpenerPolicy) {
      res.header('Cross-Origin-Opener-Policy', this.headersConfig.crossOriginOpenerPolicy);
    }
    
    if (this.headersConfig.crossOriginResourcePolicy) {
      res.header('Cross-Origin-Resource-Policy', this.headersConfig.crossOriginResourcePolicy);
    }
    
    // Remove potentially sensitive headers
    res.removeHeader('X-Powered-By');
    res.removeHeader('Server');
  }
  
  /**
   * Get security score based on configuration
   */
  getSecurityScore(): { score: number; recommendations: string[] } {
    let score = 0;
    const recommendations: string[] = [];
    const maxScore = 100;
    
    // CORS Configuration (20 points)
    if (this.corsConfig.enabled) {
      score += 10;
      
      if (this.corsConfig.origins !== '*') {
        score += 10;
      } else {
        recommendations.push('Use specific origins instead of wildcard (*)');
      }
    } else {
      recommendations.push('Enable CORS protection');
    }
    
    // Security Headers (80 points)
    if (this.headersConfig.enabled) {
      score += 10;
      
      if (this.headersConfig.contentSecurityPolicy) {
        score += 15;
      } else {
        recommendations.push('Enable Content Security Policy');
      }
      
      if (this.headersConfig.frameOptions) {
        score += 10;
      } else {
        recommendations.push('Enable X-Frame-Options');
      }
      
      if (this.headersConfig.contentTypeOptions) {
        score += 10;
      } else {
        recommendations.push('Enable X-Content-Type-Options');
      }
      
      if (this.headersConfig.strictTransportSecurity) {
        score += 15;
      } else {
        recommendations.push('Enable Strict Transport Security (HTTPS)');
      }
      
      if (this.headersConfig.referrerPolicy) {
        score += 10;
      } else {
        recommendations.push('Set Referrer Policy');
      }
      
      if (this.headersConfig.crossOriginEmbedderPolicy) {
        score += 5;
      }
      
      if (this.headersConfig.crossOriginOpenerPolicy) {
        score += 5;
      }
    } else {
      recommendations.push('Enable security headers');
    }
    
    return { score, recommendations };
  }
}

/**
 * Default security configurations
 */
export const defaultCORSConfig: CORSConfig = {
  enabled: true,
  origins: process.env.NODE_ENV === 'production' 
    ? ['https://your-mining-pool.com'] 
    : ['http://localhost:3000', 'http://localhost:8080'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'X-API-Key'
  ],
  exposedHeaders: ['X-Total-Count', 'X-Rate-Limit-Remaining'],
  credentials: true,
  maxAge: 86400, // 24 hours
  preflightContinue: false
};

export const defaultSecurityHeadersConfig: SecurityHeadersConfig = {
  enabled: true,
  contentSecurityPolicy: [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'", // Allow inline scripts for development
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '),
  frameOptions: 'DENY',
  contentTypeOptions: true,
  referrerPolicy: 'strict-origin-when-cross-origin',
  strictTransportSecurity: process.env.NODE_ENV === 'production' ? {
    enabled: true,
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  } : false,
  permissionsPolicy: [
    'geolocation=()',
    'microphone=()',
    'camera=()',
    'payment=()',
    'usb=()',
    'magnetometer=()',
    'gyroscope=()',
    'accelerometer=()'
  ].join(', '),
  crossOriginEmbedderPolicy: 'require-corp',
  crossOriginOpenerPolicy: 'same-origin',
  crossOriginResourcePolicy: 'same-origin'
};

/**
 * Production security configuration (more restrictive)
 */
export const productionSecurityHeadersConfig: SecurityHeadersConfig = {
  ...defaultSecurityHeadersConfig,
  contentSecurityPolicy: [
    "default-src 'self'",
    "script-src 'self'", // No unsafe-inline in production
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests"
  ].join('; '),
  strictTransportSecurity: {
    enabled: true,
    maxAge: 63072000, // 2 years
    includeSubDomains: true,
    preload: true
  }
};

/**
 * Factory function for creating security middleware
 */
export function createSecurityMiddleware(
  corsConfig: Partial<CORSConfig> = {},
  headersConfig: Partial<SecurityHeadersConfig> = {}
): SecurityMiddleware {
  const finalCorsConfig = { ...defaultCORSConfig, ...corsConfig };
  const finalHeadersConfig = process.env.NODE_ENV === 'production'
    ? { ...productionSecurityHeadersConfig, ...headersConfig }
    : { ...defaultSecurityHeadersConfig, ...headersConfig };
  
  return new SecurityMiddleware(finalCorsConfig, finalHeadersConfig);
}

/**
 * Mining pool specific CORS configuration
 */
export function createMiningPoolCORS(): CORSConfig {
  return {
    enabled: true,
    origins: process.env.CORS_ORIGINS 
      ? process.env.CORS_ORIGINS.split(',')
      : ['http://localhost:3000', 'http://localhost:8080'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Stratum-Version',
      'X-Mining-Extensions'
    ],
    exposedHeaders: ['X-Pool-Stats', 'X-Block-Height'],
    credentials: false, // Mining pools typically don't need credentials
    maxAge: 3600,
    preflightContinue: false
  };
}