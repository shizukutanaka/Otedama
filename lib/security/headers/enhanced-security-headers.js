/**
 * Enhanced Security Headers Implementation
 * Provides comprehensive security headers for modern web security
 * 
 * Design principles:
 * - Carmack: Efficient header generation with minimal overhead
 * - Martin: Clean configuration with security concerns separation
 * - Pike: Simple, reliable security header management
 */

import { randomBytes, randomUUID } from 'crypto';

/**
 * Enhanced Security Headers Manager
 */
export class EnhancedSecurityHeaders {
  constructor(options = {}) {
    this.environment = options.environment || process.env.NODE_ENV || 'development';
    this.apiVersion = options.apiVersion || '1.0';
    this.allowedOrigins = options.allowedOrigins || ['https://otedama.io'];
    this.reportUri = options.reportUri || '/api/security/csp-report';
    this.domainName = options.domainName || 'otedama.io';
    
    // Security feature flags
    this.features = {
      cspNonce: options.cspNonce !== false,
      crossOriginIsolation: options.crossOriginIsolation !== false,
      permissionsPolicy: options.permissionsPolicy !== false,
      apiHeaders: options.apiHeaders !== false,
      strictCsp: options.strictCsp !== false,
      ...options.features
    };
  }

  /**
   * Get comprehensive security headers for a request
   */
  getSecurityHeaders(context = {}) {
    const headers = {};
    
    // Core Security Headers
    Object.assign(headers, this.getCoreSecurityHeaders());
    
    // Content Security Policy with dynamic nonce
    if (this.features.cspNonce || context.requiresNonce) {
      const nonce = this.generateNonce();
      context.cspNonce = nonce;
      headers['Content-Security-Policy'] = this.generateEnhancedCSP(context);
    } else {
      headers['Content-Security-Policy'] = this.generateBasicCSP();
    }
    
    // Cross-Origin Isolation Headers
    if (this.features.crossOriginIsolation) {
      Object.assign(headers, this.getCrossOriginHeaders());
    }
    
    // Permissions Policy
    if (this.features.permissionsPolicy) {
      headers['Permissions-Policy'] = this.generatePermissionsPolicy();
    }
    
    // API-specific headers
    if (context.api && this.features.apiHeaders) {
      Object.assign(headers, this.getApiHeaders(context));
    }
    
    // Cache Control based on content type
    headers['Cache-Control'] = this.getCacheControl(context);
    
    // Request tracking
    headers['X-Request-ID'] = context.requestId || randomUUID();
    headers['X-Response-Time'] = context.responseTime || '';
    
    // Remove information disclosure headers
    headers['Server'] = '';
    headers['X-Powered-By'] = '';
    
    // Rate limiting headers (if available)
    if (context.rateLimit) {
      Object.assign(headers, this.getRateLimitHeaders(context.rateLimit));
    }
    
    // Authentication context headers
    if (context.authenticated) {
      Object.assign(headers, this.getAuthenticationHeaders(context));
    }
    
    return headers;
  }
  
  /**
   * Core security headers that should always be present
   */
  getCoreSecurityHeaders() {
    const isProduction = this.environment === 'production';
    
    return {
      // HTTP Strict Transport Security
      'Strict-Transport-Security': isProduction 
        ? 'max-age=31536000; includeSubDomains; preload' 
        : 'max-age=31536000; includeSubDomains',
      
      // Frame Options - Prevent clickjacking
      'X-Frame-Options': 'DENY',
      
      // Content Type Options - Prevent MIME sniffing
      'X-Content-Type-Options': 'nosniff',
      
      // XSS Protection - Disabled in favor of CSP
      'X-XSS-Protection': '0',
      
      // Referrer Policy - Privacy protection
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      
      // DNS Prefetch Control
      'X-DNS-Prefetch-Control': 'off',
      
      // Download Options (IE only, but doesn't hurt)
      'X-Download-Options': 'noopen',
      
      // Permitted Cross-Domain Policies
      'X-Permitted-Cross-Domain-Policies': 'none'
    };
  }
  
  /**
   * Cross-origin isolation headers for enhanced security
   */
  getCrossOriginHeaders() {
    return {
      // Cross-Origin Embedder Policy
      'Cross-Origin-Embedder-Policy': 'require-corp',
      
      // Cross-Origin Opener Policy
      'Cross-Origin-Opener-Policy': 'same-origin',
      
      // Cross-Origin Resource Policy
      'Cross-Origin-Resource-Policy': 'same-origin'
    };
  }
  
  /**
   * Generate enhanced Content Security Policy with nonce
   */
  generateEnhancedCSP(context = {}) {
    const nonce = context.cspNonce || this.generateNonce();
    const isProduction = this.environment === 'production';
    
    const directives = [
      // Default source
      "default-src 'self'",
      
      // Script sources with nonce and strict-dynamic for modern browsers
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
      
      // Fallback for older browsers
      ...(isProduction ? [] : [`script-src-elem 'self' 'unsafe-inline'`]),
      
      // Style sources with nonce
      `style-src 'self' 'nonce-${nonce}' 'unsafe-inline'`,
      
      // Image sources
      "img-src 'self' data: https: blob:",
      
      // Connection sources for AJAX, WebSocket, etc.
      "connect-src 'self' wss: https:",
      
      // Font sources
      "font-src 'self' https:",
      
      // Object sources (Flash, etc.) - disabled
      "object-src 'none'",
      
      // Media sources
      "media-src 'self'",
      
      // Frame sources - disabled
      "frame-src 'none'",
      
      // Worker sources
      "worker-src 'self'",
      
      // Manifest sources
      "manifest-src 'self'",
      
      // Base URI restriction
      "base-uri 'self'",
      
      // Form action restriction
      "form-action 'self'",
      
      // Frame ancestors - prevents embedding
      "frame-ancestors 'none'",
      
      // Upgrade insecure requests
      "upgrade-insecure-requests"
    ];
    
    // Block mixed content in production
    if (isProduction) {
      directives.push("block-all-mixed-content");
    }
    
    // Trusted Types for modern browsers (experimental)
    if (this.features.strictCsp && isProduction) {
      directives.push("require-trusted-types-for 'script'");
      directives.push("trusted-types 'none'");
    }
    
    // Report URI for CSP violations
    if (this.reportUri) {
      directives.push(`report-uri ${this.reportUri}`);
    }
    
    return directives.join('; ');
  }
  
  /**
   * Generate basic CSP without nonce (fallback)
   */
  generateBasicCSP() {
    const isProduction = this.environment === 'production';
    
    const directives = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self' wss: https:",
      "font-src 'self' https:",
      "object-src 'none'",
      "frame-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests"
    ];
    
    if (isProduction) {
      directives.push("block-all-mixed-content");
    }
    
    return directives.join('; ');
  }
  
  /**
   * Generate comprehensive Permissions Policy
   */
  generatePermissionsPolicy() {
    const policies = [
      // Motion sensors
      'accelerometer=()',
      'ambient-light-sensor=()',
      'gyroscope=()',
      'magnetometer=()',
      
      // Media access
      'camera=()',
      'microphone=()',
      'speaker-selection=()',
      
      // User interactions
      'autoplay=()',
      'clipboard-read=()',
      'clipboard-write=(self)',
      'fullscreen=(self)',
      'picture-in-picture=()',
      
      // Location and tracking
      'geolocation=()',
      'browsing-topics=()',
      
      // Device access
      'bluetooth=()',
      'hid=()',
      'serial=()',
      'usb=()',
      
      // Web features
      'payment=()',
      'web-share=()',
      'storage-access=()',
      'local-fonts=()',
      
      // Biometric
      'identity-credentials-get=()',
      
      // Display
      'display-capture=()',
      'screen-wake-lock=()',
      'window-management=()',
      
      // Gaming
      'gamepad=()',
      
      // XR
      'xr-spatial-tracking=()',
      
      // Crypto
      'publickey-credentials-create=(self)',
      'publickey-credentials-get=(self)',
      
      // Privacy
      'idle-detection=()',
      'cross-origin-isolated=()',
      
      // Navigation
      'navigation-override=()',
      
      // Media
      'encrypted-media=()',
      'midi=()'
    ];
    
    return policies.join(', ');
  }
  
  /**
   * Get cache control headers based on content type and sensitivity
   */
  getCacheControl(context = {}) {
    // Sensitive or authenticated content
    if (context.sensitive || context.authenticated) {
      return 'no-store, no-cache, must-revalidate, private, max-age=0';
    }
    
    // API responses
    if (context.api) {
      return 'no-cache, must-revalidate, max-age=0';
    }
    
    // Static assets
    if (context.static) {
      return 'public, max-age=31536000, immutable';
    }
    
    // Dynamic content
    if (context.dynamic) {
      return 'private, max-age=300, must-revalidate';
    }
    
    // Default for HTML and other content
    return 'no-cache, no-store, must-revalidate, max-age=0';
  }
  
  /**
   * Get API-specific headers
   */
  getApiHeaders(context = {}) {
    return {
      // API versioning
      'X-API-Version': this.apiVersion,
      'X-Content-Version': new Date().toISOString().split('T')[0],
      
      // Content negotiation
      'Vary': 'Accept, Accept-Encoding, Accept-Language, Authorization',
      
      // Prevent caching of API responses
      'Expires': '0',
      'Pragma': 'no-cache',
      
      // CORS headers (if needed)
      ...(context.cors ? this.getCorsHeaders(context) : {}),
      
      // WebSocket upgrade headers (if applicable)
      ...(context.websocket ? this.getWebSocketHeaders(context) : {})
    };
  }
  
  /**
   * Get CORS headers
   */
  getCorsHeaders(context = {}) {
    const origin = context.origin;
    const allowOrigin = this.allowedOrigins.includes(origin) ? origin : 'null';
    
    return {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-API-Key, X-Request-ID',
      'Access-Control-Expose-Headers': 'X-Request-ID, X-Rate-Limit-Remaining, X-Rate-Limit-Reset',
      'Access-Control-Max-Age': '86400' // 24 hours
    };
  }
  
  /**
   * Get WebSocket-specific headers
   */
  getWebSocketHeaders(context = {}) {
    return {
      'X-WebSocket-Rate-Limit': '10/s',
      'X-WebSocket-Connection-Limit': '5',
      'X-WebSocket-Protocol': 'otedama-v1',
      'Sec-WebSocket-Extensions': 'permessage-deflate'
    };
  }
  
  /**
   * Get rate limiting headers
   */
  getRateLimitHeaders(rateLimit) {
    return {
      'X-RateLimit-Limit': rateLimit.limit?.toString() || '100',
      'X-RateLimit-Remaining': rateLimit.remaining?.toString() || '99',
      'X-RateLimit-Reset': rateLimit.resetTime?.toString() || Math.floor(Date.now() / 1000 + 3600).toString(),
      'X-RateLimit-Retry-After': rateLimit.retryAfter?.toString() || '',
      'Retry-After': rateLimit.retryAfter?.toString() || ''
    };
  }
  
  /**
   * Get authentication context headers
   */
  getAuthenticationHeaders(context) {
    return {
      'X-Authenticated-User': 'true',
      'X-Auth-Method': context.authMethod || 'session',
      'X-User-Role': context.userRole || 'user',
      'X-Session-ID': context.sessionId ? context.sessionId.substring(0, 8) + '...' : '',
      'X-User-Permissions': context.permissions ? context.permissions.join(',') : ''
    };
  }
  
  /**
   * Generate cryptographically secure nonce
   */
  generateNonce() {
    return randomBytes(16).toString('base64');
  }
  
  /**
   * Middleware factory for Express
   */
  middleware(options = {}) {
    return (req, res, next) => {
      // Build context from request
      const context = {
        api: req.path.startsWith('/api'),
        static: /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/.test(req.path),
        authenticated: req.user || req.session?.authenticated,
        sensitive: req.path.includes('/auth') || req.path.includes('/admin'),
        cors: req.method === 'OPTIONS' || req.headers.origin,
        websocket: req.headers.upgrade === 'websocket',
        requestId: req.id || randomUUID(),
        origin: req.headers.origin,
        userRole: req.user?.role,
        authMethod: req.authMethod,
        sessionId: req.sessionID,
        permissions: req.user?.permissions,
        rateLimit: req.rateLimit,
        ...options
      };
      
      // Generate and apply headers
      const headers = this.getSecurityHeaders(context);
      
      // Apply headers to response
      Object.entries(headers).forEach(([key, value]) => {
        if (value !== '') {
          res.setHeader(key, value);
        }
      });
      
      // Store nonce in locals for template use
      if (context.cspNonce) {
        res.locals.nonce = context.cspNonce;
      }
      
      next();
    };
  }
  
  /**
   * Get security headers for specific content types
   */
  getHeadersForContentType(contentType, context = {}) {
    const baseContext = {
      ...context,
      static: /^(image|video|audio|font|application\/(javascript|css))/.test(contentType),
      api: contentType.includes('application/json'),
      sensitive: context.sensitive || contentType.includes('application/json')
    };
    
    return this.getSecurityHeaders(baseContext);
  }
}

/**
 * Create security headers middleware with default configuration
 */
export function createSecurityHeadersMiddleware(options = {}) {
  const securityHeaders = new EnhancedSecurityHeaders(options);
  return securityHeaders.middleware();
}

/**
 * CSP nonce helper for templates
 */
export function getNonce(res) {
  return res.locals.nonce || '';
}

export default {
  EnhancedSecurityHeaders,
  createSecurityHeadersMiddleware,
  getNonce
};