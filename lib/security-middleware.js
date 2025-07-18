/**
 * Security Middleware for Otedama
 * Comprehensive security headers and CORS configuration
 */

import crypto from 'crypto';

export class SecurityMiddleware {
  constructor(options = {}) {
    this.options = {
      // CORS settings
      cors: {
        enabled: options.cors?.enabled !== false,
        origin: options.cors?.origin || '*',
        methods: options.cors?.methods || ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: options.cors?.allowedHeaders || ['Content-Type', 'Authorization', 'X-API-Key'],
        exposedHeaders: options.cors?.exposedHeaders || ['X-Request-ID', 'X-Response-Time'],
        credentials: options.cors?.credentials || true,
        maxAge: options.cors?.maxAge || 86400 // 24 hours
      },
      
      // CSP settings
      csp: {
        enabled: options.csp?.enabled !== false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', (nonce) => `'nonce-${nonce}'`],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: [],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'", 'wss:', 'https:'],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          ...options.csp?.directives
        }
      },
      
      // Rate limiting
      rateLimit: {
        enabled: options.rateLimit?.enabled !== false,
        windowMs: options.rateLimit?.windowMs || 60000, // 1 minute
        maxRequests: options.rateLimit?.maxRequests || 100,
        keyGenerator: options.rateLimit?.keyGenerator || ((req) => req.headers['x-forwarded-for'] || req.socket.remoteAddress)
      },
      
      // Security headers
      headers: {
        hsts: {
          maxAge: options.headers?.hsts?.maxAge || 31536000, // 1 year
          includeSubDomains: options.headers?.hsts?.includeSubDomains !== false,
          preload: options.headers?.hsts?.preload !== false
        },
        noSniff: options.headers?.noSniff !== false,
        xssProtection: options.headers?.xssProtection !== false,
        referrerPolicy: options.headers?.referrerPolicy || 'strict-origin-when-cross-origin',
        permittedCrossDomainPolicies: options.headers?.permittedCrossDomainPolicies || 'none'
      },
      
      ...options
    };
    
    // Rate limit storage
    this.rateLimitStore = new Map();
    
    // Nonce generation for CSP
    this.generateNonce = () => crypto.randomBytes(16).toString('base64');
  }

  /**
   * Apply security middleware to request/response
   */
  apply(req, res) {
    // Generate request ID
    const requestId = crypto.randomUUID();
    req.id = requestId;
    res.setHeader('X-Request-ID', requestId);
    
    // Apply CORS headers
    if (this.options.cors.enabled) {
      this.applyCORS(req, res);
    }
    
    // Apply security headers
    this.applySecurityHeaders(req, res);
    
    // Apply CSP
    if (this.options.csp.enabled) {
      this.applyCSP(req, res);
    }
    
    // Apply rate limiting
    if (this.options.rateLimit.enabled) {
      const limited = this.checkRateLimit(req);
      if (limited) {
        res.statusCode = 429;
        res.setHeader('Retry-After', Math.ceil(this.options.rateLimit.windowMs / 1000));
        res.end(JSON.stringify({ 
          error: 'Too Many Requests',
          retryAfter: Math.ceil(this.options.rateLimit.windowMs / 1000)
        }));
        return false;
      }
    }
    
    return true;
  }

  /**
   * Apply CORS headers
   */
  applyCORS(req, res) {
    // Handle origin
    const origin = req.headers.origin;
    if (this.options.cors.origin === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (Array.isArray(this.options.cors.origin)) {
      if (this.options.cors.origin.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
    } else if (typeof this.options.cors.origin === 'function') {
      const allowed = this.options.cors.origin(origin);
      if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
    } else {
      res.setHeader('Access-Control-Allow-Origin', this.options.cors.origin);
    }
    
    // Apply other CORS headers
    if (this.options.cors.credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    
    res.setHeader('Access-Control-Allow-Methods', this.options.cors.methods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', this.options.cors.allowedHeaders.join(', '));
    res.setHeader('Access-Control-Expose-Headers', this.options.cors.exposedHeaders.join(', '));
    res.setHeader('Access-Control-Max-Age', this.options.cors.maxAge);
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return false;
    }
  }

  /**
   * Apply security headers
   */
  applySecurityHeaders(req, res) {
    // HSTS
    const hsts = this.options.headers.hsts;
    const hstsValue = `max-age=${hsts.maxAge}${hsts.includeSubDomains ? '; includeSubDomains' : ''}${hsts.preload ? '; preload' : ''}`;
    res.setHeader('Strict-Transport-Security', hstsValue);
    
    // Other security headers
    if (this.options.headers.noSniff) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    
    if (this.options.headers.xssProtection) {
      res.setHeader('X-XSS-Protection', '1; mode=block');
    }
    
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', this.options.headers.referrerPolicy);
    res.setHeader('X-Permitted-Cross-Domain-Policies', this.options.headers.permittedCrossDomainPolicies);
    
    // Remove potentially dangerous headers
    res.removeHeader('X-Powered-By');
    res.removeHeader('Server');
  }

  /**
   * Apply Content Security Policy
   */
  applyCSP(req, res) {
    const nonce = this.generateNonce();
    req.nonce = nonce;
    
    // Build CSP header
    const directives = [];
    for (const [key, values] of Object.entries(this.options.csp.directives)) {
      const directiveName = key.replace(/([A-Z])/g, '-$1').toLowerCase();
      const directiveValues = Array.isArray(values) ? values : [values];
      
      // Add nonce to script-src if present
      if (key === 'scriptSrc') {
        // Replace any function directive with computed value
        for (let i = 0; i < directiveValues.length; i++) {
          if (typeof directiveValues[i] === 'function') {
            directiveValues[i] = directiveValues[i](nonce);
          }
        }
      }
      
      directives.push(`${directiveName} ${directiveValues.join(' ')}`);
    }
    
    res.setHeader('Content-Security-Policy', directives.join('; '));
  }

  /**
   * Check rate limit
   */
  checkRateLimit(req) {
    const key = this.options.rateLimit.keyGenerator(req);
    const now = Date.now();
    const windowStart = now - this.options.rateLimit.windowMs;
    
    // Clean old entries
    for (const [k, v] of this.rateLimitStore) {
      if (v.resetTime < now) {
        this.rateLimitStore.delete(k);
      }
    }
    
    // Get or create rate limit data
    let limitData = this.rateLimitStore.get(key);
    if (!limitData || limitData.resetTime < now) {
      limitData = {
        count: 0,
        resetTime: now + this.options.rateLimit.windowMs
      };
      this.rateLimitStore.set(key, limitData);
    }
    
    // Increment count
    limitData.count++;
    
    // Check if limit exceeded
    return limitData.count > this.options.rateLimit.maxRequests;
  }

  /**
   * Create Express-compatible middleware
   */
  middleware() {
    return (req, res, next) => {
      const allowed = this.apply(req, res);
      if (allowed !== false) {
        next();
      }
    };
  }

  /**
   * Create middleware for specific paths
   */
  forPaths(paths) {
    return (req, res, next) => {
      const shouldApply = paths.some(path => {
        if (typeof path === 'string') {
          return req.url.startsWith(path);
        }
        if (path instanceof RegExp) {
          return path.test(req.url);
        }
        return false;
      });
      
      if (shouldApply) {
        const allowed = this.apply(req, res);
        if (allowed !== false) {
          next();
        }
      } else {
        next();
      }
    };
  }

  /**
   * Get security report
   */
  getSecurityReport() {
    return {
      cors: {
        enabled: this.options.cors.enabled,
        origin: this.options.cors.origin,
        methods: this.options.cors.methods
      },
      csp: {
        enabled: this.options.csp.enabled,
        directiveCount: Object.keys(this.options.csp.directives).length
      },
      rateLimit: {
        enabled: this.options.rateLimit.enabled,
        maxRequests: this.options.rateLimit.maxRequests,
        windowMs: this.options.rateLimit.windowMs,
        activeKeys: this.rateLimitStore.size
      },
      headers: {
        hsts: this.options.headers.hsts,
        additionalHeaders: Object.keys(this.options.headers).length
      }
    };
  }
}

// Default security middleware instance
export const defaultSecurityMiddleware = new SecurityMiddleware();

/**
 * Helper to create custom security middleware
 */
export function createSecurityMiddleware(options) {
  return new SecurityMiddleware(options);
}