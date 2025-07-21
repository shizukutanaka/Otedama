/**
 * CSRF Protection and Request Signing System for Otedama
 * 
 * Design principles:
 * - Carmack: Fast verification with minimal overhead
 * - Martin: Clean security implementation
 * - Pike: Simple but secure
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { EventEmitter } from 'events';

// Security token types
export const TokenType = {
  CSRF: 'csrf',
  API_SIGNATURE: 'api_signature',
  WEBHOOK_SIGNATURE: 'webhook_signature'
};

/**
 * CSRF Token Manager
 */
export class CSRFProtection {
  constructor(options = {}) {
    this.secret = options.secret || randomBytes(32).toString('hex');
    this.tokenLength = options.tokenLength || 32;
    this.tokenExpiry = options.tokenExpiry || 3600000; // 1 hour
    this.sameSite = options.sameSite || 'strict';
    this.secure = options.secure !== false;
    this.httpOnly = options.httpOnly !== false;
    this.cookieName = options.cookieName || 'csrf-token';
    this.headerName = options.headerName || 'X-CSRF-Token';
    
    // Token storage (in production, use Redis)
    this.tokens = new Map();
    
    // Cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000); // 5 minutes
  }

  /**
   * Generate CSRF token
   */
  generateToken(sessionId) {
    if (!sessionId) {
      throw new Error('Session ID required for CSRF token generation');
    }
    
    const token = randomBytes(this.tokenLength).toString('hex');
    const hash = this.hashToken(token, sessionId);
    const expiry = Date.now() + this.tokenExpiry;
    
    // Store token data
    this.tokens.set(hash, {
      sessionId,
      expiry,
      used: false
    });
    
    return {
      token,
      hash,
      expiry
    };
  }

  /**
   * Verify CSRF token
   */
  verifyToken(token, sessionId) {
    if (!token || !sessionId) {
      return { valid: false, reason: 'Missing token or session' };
    }
    
    const hash = this.hashToken(token, sessionId);
    const tokenData = this.tokens.get(hash);
    
    if (!tokenData) {
      return { valid: false, reason: 'Invalid token' };
    }
    
    if (tokenData.sessionId !== sessionId) {
      return { valid: false, reason: 'Session mismatch' };
    }
    
    if (Date.now() > tokenData.expiry) {
      this.tokens.delete(hash);
      return { valid: false, reason: 'Token expired' };
    }
    
    if (tokenData.used) {
      return { valid: false, reason: 'Token already used' };
    }
    
    // Mark as used for single-use tokens
    tokenData.used = true;
    
    return { valid: true };
  }

  /**
   * Hash token with session binding
   */
  hashToken(token, sessionId) {
    return createHmac('sha256', this.secret)
      .update(`${token}:${sessionId}`)
      .digest('hex');
  }

  /**
   * Extract token from request
   */
  extractToken(req) {
    // Check header first
    let token = req.headers[this.headerName.toLowerCase()];
    
    // Check body if POST
    if (!token && req.method === 'POST' && req.body) {
      token = req.body._csrf || req.body.csrf || req.body.csrfToken;
    }
    
    // Check query parameters
    if (!token && req.query) {
      token = req.query._csrf || req.query.csrf;
    }
    
    // Check cookies
    if (!token && req.cookies) {
      token = req.cookies[this.cookieName];
    }
    
    return token;
  }

  /**
   * Middleware for CSRF protection
   */
  middleware(options = {}) {
    const skipMethods = options.skipMethods || ['GET', 'HEAD', 'OPTIONS'];
    const skipPaths = options.skipPaths || [];
    
    return (req, res, next) => {
      // Skip for safe methods
      if (skipMethods.includes(req.method)) {
        return next();
      }
      
      // Skip for excluded paths
      const path = req.path || req.url;
      if (skipPaths.some(skip => {
        if (typeof skip === 'string') {
          return path.startsWith(skip);
        }
        if (skip instanceof RegExp) {
          return skip.test(path);
        }
        return false;
      })) {
        return next();
      }
      
      // Extract session ID
      const sessionId = req.session?.id || req.sessionID;
      if (!sessionId) {
        res.statusCode = 403;
        res.end(JSON.stringify({
          error: 'Forbidden',
          message: 'Session required'
        }));
        return;
      }
      
      // Extract and verify token
      const token = this.extractToken(req);
      const verification = this.verifyToken(token, sessionId);
      
      if (!verification.valid) {
        res.statusCode = 403;
        res.end(JSON.stringify({
          error: 'Forbidden',
          message: 'Invalid CSRF token',
          reason: verification.reason
        }));
        return;
      }
      
      // Generate new token for response
      const newToken = this.generateToken(sessionId);
      res.setHeader(this.headerName, newToken.token);
      
      // Set cookie if configured
      if (this.cookieName) {
        const cookieOptions = [
          `${this.cookieName}=${newToken.token}`,
          'Path=/',
          `Max-Age=${Math.floor(this.tokenExpiry / 1000)}`,
          `SameSite=${this.sameSite}`
        ];
        
        if (this.secure) {
          cookieOptions.push('Secure');
        }
        
        if (this.httpOnly) {
          cookieOptions.push('HttpOnly');
        }
        
        res.setHeader('Set-Cookie', cookieOptions.join('; '));
      }
      
      next();
    };
  }

  /**
   * Clean up expired tokens
   */
  cleanup() {
    const now = Date.now();
    
    for (const [hash, data] of this.tokens) {
      if (now > data.expiry) {
        this.tokens.delete(hash);
      }
    }
  }

  /**
   * Shutdown
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.tokens.clear();
  }
}

/**
 * Request Signing for API Authentication
 */
export class RequestSigner {
  constructor(options = {}) {
    this.algorithm = options.algorithm || 'sha256';
    this.headerName = options.headerName || 'X-Signature';
    this.timestampHeader = options.timestampHeader || 'X-Timestamp';
    this.nonceHeader = options.nonceHeader || 'X-Nonce';
    this.maxClockSkew = options.maxClockSkew || 300000; // 5 minutes
    this.includeMethod = options.includeMethod !== false;
    this.includePath = options.includePath !== false;
    this.includeQuery = options.includeQuery !== false;
    this.includeHeaders = options.includeHeaders || ['host', 'content-type'];
    
    // Nonce tracking (in production, use Redis with TTL)
    this.usedNonces = new Map();
    
    // Cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanupNonces(), 600000); // 10 minutes
  }

  /**
   * Sign request
   */
  signRequest(method, path, options = {}) {
    const timestamp = options.timestamp || Date.now();
    const nonce = options.nonce || randomBytes(16).toString('hex');
    const secret = options.secret;
    const body = options.body || '';
    const headers = options.headers || {};
    const query = options.query || {};
    
    if (!secret) {
      throw new Error('Secret required for request signing');
    }
    
    // Build canonical request
    const canonical = this.buildCanonicalRequest(method, path, {
      timestamp,
      nonce,
      body,
      headers,
      query
    });
    
    // Create signature
    const signature = createHmac(this.algorithm, secret)
      .update(canonical)
      .digest('hex');
    
    return {
      signature,
      timestamp,
      nonce,
      headers: {
        [this.headerName]: signature,
        [this.timestampHeader]: timestamp.toString(),
        [this.nonceHeader]: nonce
      }
    };
  }

  /**
   * Verify request signature
   */
  verifyRequest(req, secret) {
    if (!secret) {
      return { valid: false, reason: 'No secret provided' };
    }
    
    // Extract signature and metadata
    const signature = req.headers[this.headerName.toLowerCase()];
    const timestamp = parseInt(req.headers[this.timestampHeader.toLowerCase()]);
    const nonce = req.headers[this.nonceHeader.toLowerCase()];
    
    if (!signature || !timestamp || !nonce) {
      return { valid: false, reason: 'Missing signature headers' };
    }
    
    // Check timestamp
    const now = Date.now();
    if (Math.abs(now - timestamp) > this.maxClockSkew) {
      return { valid: false, reason: 'Timestamp outside acceptable window' };
    }
    
    // Check nonce
    const nonceKey = `${nonce}:${timestamp}`;
    if (this.usedNonces.has(nonceKey)) {
      return { valid: false, reason: 'Nonce already used' };
    }
    
    // Build canonical request
    const canonical = this.buildCanonicalRequest(req.method, req.path || req.url, {
      timestamp,
      nonce,
      body: req.body,
      headers: req.headers,
      query: req.query
    });
    
    // Calculate expected signature
    const expectedSignature = createHmac(this.algorithm, secret)
      .update(canonical)
      .digest('hex');
    
    // Timing-safe comparison
    const signatureBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    
    if (signatureBuffer.length !== expectedBuffer.length) {
      return { valid: false, reason: 'Invalid signature length' };
    }
    
    if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
      return { valid: false, reason: 'Invalid signature' };
    }
    
    // Mark nonce as used
    this.usedNonces.set(nonceKey, timestamp);
    
    return { valid: true };
  }

  /**
   * Build canonical request string
   */
  buildCanonicalRequest(method, path, options) {
    const parts = [];
    
    // HTTP method
    if (this.includeMethod) {
      parts.push(method.toUpperCase());
    }
    
    // Path
    if (this.includePath) {
      parts.push(path);
    }
    
    // Query string
    if (this.includeQuery && options.query) {
      const queryPairs = [];
      const sortedKeys = Object.keys(options.query).sort();
      
      for (const key of sortedKeys) {
        const value = options.query[key];
        if (Array.isArray(value)) {
          for (const v of value.sort()) {
            queryPairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
          }
        } else {
          queryPairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
        }
      }
      
      parts.push(queryPairs.join('&'));
    }
    
    // Headers
    if (this.includeHeaders.length > 0 && options.headers) {
      const headerParts = [];
      
      for (const headerName of this.includeHeaders) {
        const value = options.headers[headerName.toLowerCase()];
        if (value) {
          headerParts.push(`${headerName.toLowerCase()}:${value.trim()}`);
        }
      }
      
      parts.push(headerParts.join('\n'));
    }
    
    // Timestamp and nonce
    parts.push(options.timestamp.toString());
    parts.push(options.nonce);
    
    // Body
    if (options.body) {
      if (typeof options.body === 'object') {
        parts.push(JSON.stringify(options.body));
      } else {
        parts.push(options.body.toString());
      }
    }
    
    return parts.join('\n');
  }

  /**
   * Middleware for request signing verification
   */
  middleware(getSecret) {
    return async (req, res, next) => {
      // Extract API key or user ID to look up secret
      const apiKey = req.headers['x-api-key'];
      const userId = req.user?.id;
      
      if (!apiKey && !userId) {
        res.statusCode = 401;
        res.end(JSON.stringify({
          error: 'Unauthorized',
          message: 'API key or authentication required'
        }));
        return;
      }
      
      // Get secret
      const secret = await getSecret(apiKey || userId);
      if (!secret) {
        res.statusCode = 401;
        res.end(JSON.stringify({
          error: 'Unauthorized',
          message: 'Invalid credentials'
        }));
        return;
      }
      
      // Parse body if needed
      if (req.headers['content-type']?.includes('application/json') && typeof req.body === 'string') {
        try {
          req.body = JSON.parse(req.body);
        } catch (error) {
          // Keep as string if not valid JSON
        }
      }
      
      // Verify signature
      const verification = this.verifyRequest(req, secret);
      
      if (!verification.valid) {
        res.statusCode = 401;
        res.end(JSON.stringify({
          error: 'Unauthorized',
          message: 'Invalid request signature',
          reason: verification.reason
        }));
        return;
      }
      
      next();
    };
  }

  /**
   * Clean up old nonces
   */
  cleanupNonces() {
    const cutoff = Date.now() - this.maxClockSkew * 2;
    
    for (const [nonceKey, timestamp] of this.usedNonces) {
      if (timestamp < cutoff) {
        this.usedNonces.delete(nonceKey);
      }
    }
  }

  /**
   * Shutdown
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.usedNonces.clear();
  }
}

/**
 * Webhook signature verification
 */
export class WebhookVerifier {
  constructor(options = {}) {
    this.algorithm = options.algorithm || 'sha256';
    this.headerName = options.headerName || 'X-Webhook-Signature';
    this.timestampTolerance = options.timestampTolerance || 300000; // 5 minutes
    this.encoding = options.encoding || 'hex';
  }

  /**
   * Sign webhook payload
   */
  sign(payload, secret, timestamp = Date.now()) {
    const data = typeof payload === 'object' ? JSON.stringify(payload) : payload;
    const message = `${timestamp}.${data}`;
    
    const signature = createHmac(this.algorithm, secret)
      .update(message)
      .digest(this.encoding);
    
    return {
      signature: `t=${timestamp},v1=${signature}`,
      timestamp,
      headers: {
        [this.headerName]: `t=${timestamp},v1=${signature}`
      }
    };
  }

  /**
   * Verify webhook signature
   */
  verify(payload, signature, secret) {
    if (!payload || !signature || !secret) {
      return { valid: false, reason: 'Missing required parameters' };
    }
    
    // Parse signature header
    const elements = signature.split(',');
    let timestamp = null;
    let signatures = [];
    
    for (const element of elements) {
      const [key, value] = element.split('=');
      
      if (key === 't') {
        timestamp = parseInt(value);
      } else if (key === 'v1') {
        signatures.push(value);
      }
    }
    
    if (!timestamp || signatures.length === 0) {
      return { valid: false, reason: 'Invalid signature format' };
    }
    
    // Check timestamp
    const now = Date.now();
    if (Math.abs(now - timestamp) > this.timestampTolerance) {
      return { valid: false, reason: 'Timestamp outside tolerance window' };
    }
    
    // Calculate expected signature
    const data = typeof payload === 'object' ? JSON.stringify(payload) : payload;
    const message = `${timestamp}.${data}`;
    
    const expectedSignature = createHmac(this.algorithm, secret)
      .update(message)
      .digest(this.encoding);
    
    // Check if any provided signature matches
    let validSignature = false;
    
    for (const sig of signatures) {
      const sigBuffer = Buffer.from(sig, this.encoding);
      const expectedBuffer = Buffer.from(expectedSignature, this.encoding);
      
      if (sigBuffer.length === expectedBuffer.length && timingSafeEqual(sigBuffer, expectedBuffer)) {
        validSignature = true;
        break;
      }
    }
    
    if (!validSignature) {
      return { valid: false, reason: 'Invalid signature' };
    }
    
    return { valid: true, timestamp };
  }

  /**
   * Middleware for webhook verification
   */
  middleware(getSecret) {
    return async (req, res, next) => {
      const signature = req.headers[this.headerName.toLowerCase()];
      
      if (!signature) {
        res.statusCode = 401;
        res.end(JSON.stringify({
          error: 'Unauthorized',
          message: 'Missing webhook signature'
        }));
        return;
      }
      
      // Get secret based on webhook source
      const source = req.headers['x-webhook-source'] || req.path;
      const secret = await getSecret(source);
      
      if (!secret) {
        res.statusCode = 401;
        res.end(JSON.stringify({
          error: 'Unauthorized',
          message: 'Unknown webhook source'
        }));
        return;
      }
      
      // Read raw body
      let rawBody = '';
      req.on('data', chunk => rawBody += chunk);
      req.on('end', () => {
        // Verify signature
        const verification = this.verify(rawBody, signature, secret);
        
        if (!verification.valid) {
          res.statusCode = 401;
          res.end(JSON.stringify({
            error: 'Unauthorized',
            message: 'Invalid webhook signature',
            reason: verification.reason
          }));
          return;
        }
        
        // Parse body
        try {
          req.body = JSON.parse(rawBody);
        } catch (error) {
          req.body = rawBody;
        }
        
        // Add webhook metadata
        req.webhook = {
          verified: true,
          timestamp: verification.timestamp,
          source
        };
        
        next();
      });
    };
  }
}

/**
 * Unified security middleware
 */
export class SecurityManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.csrf = new CSRFProtection(options.csrf);
    this.signer = new RequestSigner(options.signing);
    this.webhook = new WebhookVerifier(options.webhook);
    
    this.enableCSRF = options.enableCSRF !== false;
    this.enableSigning = options.enableSigning || false;
    this.enableWebhook = options.enableWebhook || false;
  }

  /**
   * Apply all security measures
   */
  middleware(options = {}) {
    const middlewares = [];
    
    if (this.enableCSRF) {
      middlewares.push(this.csrf.middleware(options.csrf));
    }
    
    if (this.enableSigning) {
      middlewares.push(this.signer.middleware(options.getSigningSecret));
    }
    
    // Compose middlewares
    return (req, res, next) => {
      let index = 0;
      
      const runNext = (err) => {
        if (err) return next(err);
        
        if (index >= middlewares.length) {
          return next();
        }
        
        const middleware = middlewares[index++];
        middleware(req, res, runNext);
      };
      
      runNext();
    };
  }

  /**
   * Shutdown all components
   */
  shutdown() {
    this.csrf.shutdown();
    this.signer.shutdown();
    this.emit('shutdown');
  }
}

// Convenience exports
export function createCSRFProtection(options) {
  return new CSRFProtection(options);
}

export function createRequestSigner(options) {
  return new RequestSigner(options);
}

export function createWebhookVerifier(options) {
  return new WebhookVerifier(options);
}

export function createSecurityManager(options) {
  return new SecurityManager(options);
}

// Default export
export default SecurityManager;
