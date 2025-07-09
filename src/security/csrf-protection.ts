/**
 * CSRF Protection
 * Following Carmack/Martin/Pike principles:
 * - Simple token-based protection
 * - Stateless when possible
 * - Clear and secure implementation
 */

import * as crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

interface CSRFOptions {
  secretLength?: number;
  tokenLength?: number;
  saltLength?: number;
  cookieName?: string;
  headerName?: string;
  bodyField?: string;
  queryField?: string;
  sessionKey?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  maxAge?: number;
  ignoreMethods?: string[];
  ignoreRoutes?: string[];
  doubleSubmit?: boolean; // Use double-submit cookie pattern
}

interface TokenPair {
  token: string;
  secret: string;
}

export class CSRFProtection {
  private options: Required<CSRFOptions>;
  private secret: Buffer;

  constructor(secret: string, options: CSRFOptions = {}) {
    this.secret = Buffer.from(secret);
    this.options = {
      secretLength: 32,
      tokenLength: 32,
      saltLength: 8,
      cookieName: 'XSRF-TOKEN',
      headerName: 'X-XSRF-TOKEN',
      bodyField: '_csrf',
      queryField: '_csrf',
      sessionKey: 'csrfSecret',
      secure: process.env.NODE_ENV === 'production',
      httpOnly: false, // Must be false for double-submit pattern
      sameSite: 'strict',
      maxAge: 86400000, // 24 hours
      ignoreMethods: ['GET', 'HEAD', 'OPTIONS'],
      ignoreRoutes: ['/api/v1/public', '/health', '/metrics'],
      doubleSubmit: true,
      ...options
    };
  }

  /**
   * Generate a new CSRF token
   */
  generateToken(): TokenPair {
    const salt = crypto.randomBytes(this.options.saltLength);
    const secret = crypto.randomBytes(this.options.secretLength);
    
    // Create token using HMAC
    const token = this.createToken(secret, salt);
    
    return {
      token: salt.toString('base64url') + '.' + token,
      secret: secret.toString('base64url')
    };
  }

  /**
   * Create token from secret and salt
   */
  private createToken(secret: Buffer, salt: Buffer): string {
    const hash = crypto.createHmac('sha256', this.secret);
    hash.update(salt);
    hash.update(secret);
    return hash.digest('base64url');
  }

  /**
   * Verify CSRF token
   */
  verifyToken(token: string, secret: string): boolean {
    if (!token || !secret) {
      return false;
    }
    
    // Parse token
    const parts = token.split('.');
    if (parts.length !== 2) {
      return false;
    }
    
    const [saltB64, tokenHash] = parts;
    
    try {
      const salt = Buffer.from(saltB64, 'base64url');
      const secretBuf = Buffer.from(secret, 'base64url');
      
      // Recreate token and compare
      const expectedToken = this.createToken(secretBuf, salt);
      
      // Constant-time comparison
      return crypto.timingSafeEqual(
        Buffer.from(tokenHash),
        Buffer.from(expectedToken)
      );
    } catch {
      return false;
    }
  }

  /**
   * Express middleware
   */
  middleware() {
    return async (req: Request & { csrfToken?: () => string }, res: Response, next: NextFunction) => {
      // Skip ignored methods
      if (this.options.ignoreMethods.includes(req.method)) {
        // Generate token for forms
        req.csrfToken = () => this.getOrCreateToken(req, res).token;
        return next();
      }
      
      // Skip ignored routes
      if (this.options.ignoreRoutes.some(route => req.path.startsWith(route))) {
        return next();
      }
      
      // Get token from request
      const token = this.getTokenFromRequest(req);
      
      if (!token) {
        return this.handleError(res, 'CSRF token missing');
      }
      
      // Get secret
      const secret = this.options.doubleSubmit 
        ? this.getSecretFromCookie(req)
        : this.getSecretFromSession(req);
      
      if (!secret) {
        return this.handleError(res, 'CSRF secret missing');
      }
      
      // Verify token
      if (!this.verifyToken(token, secret)) {
        return this.handleError(res, 'Invalid CSRF token');
      }
      
      // Regenerate token for next request
      const newPair = this.generateToken();
      this.setToken(req, res, newPair);
      
      // Add helper function
      req.csrfToken = () => newPair.token;
      
      next();
    };
  }

  /**
   * Get or create token for request
   */
  private getOrCreateToken(req: Request, res: Response): TokenPair {
    // Try to get existing secret
    const secret = this.options.doubleSubmit 
      ? this.getSecretFromCookie(req)
      : this.getSecretFromSession(req);
    
    if (secret) {
      // Generate new token with existing secret
      const salt = crypto.randomBytes(this.options.saltLength);
      const secretBuf = Buffer.from(secret, 'base64url');
      const token = this.createToken(secretBuf, salt);
      
      return {
        token: salt.toString('base64url') + '.' + token,
        secret
      };
    }
    
    // Generate new pair
    const pair = this.generateToken();
    this.setToken(req, res, pair);
    return pair;
  }

  /**
   * Get token from request
   */
  private getTokenFromRequest(req: Request): string | null {
    // Check header
    const headerToken = req.headers[this.options.headerName.toLowerCase()] as string;
    if (headerToken) {
      return headerToken;
    }
    
    // Check body
    if (req.body && req.body[this.options.bodyField]) {
      return req.body[this.options.bodyField];
    }
    
    // Check query
    if (req.query[this.options.queryField]) {
      return req.query[this.options.queryField] as string;
    }
    
    return null;
  }

  /**
   * Get secret from cookie (double-submit pattern)
   */
  private getSecretFromCookie(req: Request): string | null {
    const cookies = this.parseCookies(req.headers.cookie || '');
    return cookies[this.options.cookieName] || null;
  }

  /**
   * Get secret from session
   */
  private getSecretFromSession(req: Request): string | null {
    const session = (req as any).session;
    return session ? session[this.options.sessionKey] : null;
  }

  /**
   * Set token in response
   */
  private setToken(req: Request, res: Response, pair: TokenPair): void {
    if (this.options.doubleSubmit) {
      // Set secret in cookie
      res.cookie(this.options.cookieName, pair.secret, {
        maxAge: this.options.maxAge,
        httpOnly: this.options.httpOnly,
        secure: this.options.secure,
        sameSite: this.options.sameSite
      });
    } else {
      // Set secret in session
      const session = (req as any).session;
      if (session) {
        session[this.options.sessionKey] = pair.secret;
      }
    }
  }

  /**
   * Parse cookies
   */
  private parseCookies(cookieHeader: string): { [key: string]: string } {
    const cookies: { [key: string]: string } = {};
    
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      if (name && value) {
        cookies[name] = decodeURIComponent(value);
      }
    });
    
    return cookies;
  }

  /**
   * Handle CSRF error
   */
  private handleError(res: Response, message: string): void {
    res.status(403).json({
      error: 'CSRF_VALIDATION_FAILED',
      message
    });
  }

  /**
   * Generate meta tag for HTML
   */
  generateMetaTag(token: string): string {
    return `<meta name="csrf-token" content="${token}">`;
  }

  /**
   * Generate hidden input for forms
   */
  generateFormField(token: string): string {
    return `<input type="hidden" name="${this.options.bodyField}" value="${token}">`;
  }

  /**
   * Client-side helper script
   */
  generateClientScript(): string {
    return `
(function() {
  // Get CSRF token from meta tag
  function getCSRFToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : null;
  }
  
  // Add CSRF token to fetch requests
  const originalFetch = window.fetch;
  window.fetch = function(url, options = {}) {
    const token = getCSRFToken();
    
    if (token && !['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase())) {
      options.headers = options.headers || {};
      options.headers['${this.options.headerName}'] = token;
    }
    
    return originalFetch(url, options);
  };
  
  // Add CSRF token to XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._method = method;
    return originalOpen.apply(this, arguments);
  };
  
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function() {
    const token = getCSRFToken();
    
    if (token && !['GET', 'HEAD'].includes(this._method.toUpperCase())) {
      this.setRequestHeader('${this.options.headerName}', token);
    }
    
    return originalSend.apply(this, arguments);
  };
  
  // Add CSRF token to forms
  document.addEventListener('submit', function(e) {
    const form = e.target;
    if (form.method && form.method.toUpperCase() !== 'GET') {
      const token = getCSRFToken();
      if (token) {
        let input = form.querySelector('input[name="${this.options.bodyField}"]');
        if (!input) {
          input = document.createElement('input');
          input.type = 'hidden';
          input.name = '${this.options.bodyField}';
          form.appendChild(input);
        }
        input.value = token;
      }
    }
  });
})();
    `;
  }
}

/**
 * Synchronizer Token Pattern implementation
 */
export class SynchronizerTokenPattern {
  private tokens: Map<string, { secret: string; expires: number }> = new Map();
  private cleanupInterval: NodeJS.Timer;

  constructor(private ttl: number = 3600000) { // 1 hour default
    // Cleanup expired tokens every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000);
  }

  /**
   * Generate token for session
   */
  generate(sessionId: string): string {
    const secret = crypto.randomBytes(32).toString('base64url');
    const token = crypto.randomBytes(32).toString('base64url');
    
    // Store with expiration
    this.tokens.set(`${sessionId}:${token}`, {
      secret,
      expires: Date.now() + this.ttl
    });
    
    return token;
  }

  /**
   * Verify token
   */
  verify(sessionId: string, token: string): boolean {
    const key = `${sessionId}:${token}`;
    const data = this.tokens.get(key);
    
    if (!data) {
      return false;
    }
    
    // Check expiration
    if (data.expires < Date.now()) {
      this.tokens.delete(key);
      return false;
    }
    
    // Token is valid, remove it (one-time use)
    this.tokens.delete(key);
    return true;
  }

  /**
   * Cleanup expired tokens
   */
  private cleanup(): void {
    const now = Date.now();
    
    for (const [key, data] of this.tokens.entries()) {
      if (data.expires < now) {
        this.tokens.delete(key);
      }
    }
  }

  /**
   * Destroy pattern instance
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.tokens.clear();
  }
}

// Factory function for easy setup
export function createCSRFProtection(options?: CSRFOptions): CSRFProtection {
  const secret = process.env.CSRF_SECRET || crypto.randomBytes(32).toString('base64');
  return new CSRFProtection(secret, options);
}

// Example usage with Express
export function setupCSRFProtection(app: any): void {
  const csrf = createCSRFProtection({
    secure: process.env.NODE_ENV === 'production',
    ignoreMethods: ['GET', 'HEAD', 'OPTIONS'],
    ignoreRoutes: ['/api/v1/public', '/health']
  });
  
  // Add middleware
  app.use(csrf.middleware());
  
  // Add token endpoint for SPAs
  app.get('/api/v1/csrf-token', (req: any, res: any) => {
    res.json({ token: req.csrfToken() });
  });
  
  // Add client script endpoint
  app.get('/csrf-protection.js', (req: any, res: any) => {
    res.type('application/javascript');
    res.send(csrf.generateClientScript());
  });
}
