/**
 * Unified CSRF Protection System for Otedama
 * 
 * Design principles:
 * - Carmack: Fast verification with minimal overhead
 * - Martin: Clean security implementation  
 * - Pike: Simple but secure
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { EventEmitter } from 'events';

// Token types
export const TokenType = {
  CSRF: 'csrf',
  API_SIGNATURE: 'api_signature',
  WEBHOOK_SIGNATURE: 'webhook_signature'
};

// CSRF strategies
export const CSRFStrategy = {
  DOUBLE_SUBMIT: 'double_submit',  // Default - simple and fast
  SYNCHRONIZER: 'synchronizer',     // Session-based
  SIGNED: 'signed'                  // HMAC signed
};

/**
 * Unified CSRF Protection
 */
export class CSRFProtection extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Core configuration
    this.secret = options.secret || randomBytes(32).toString('hex');
    this.tokenLength = options.tokenLength || 32;
    this.tokenExpiry = options.tokenExpiry || 3600000; // 1 hour
    this.strategy = options.strategy || CSRFStrategy.DOUBLE_SUBMIT;
    
    // Cookie settings
    this.cookieName = options.cookieName || '__Host-csrf';
    this.headerName = options.headerName || 'X-CSRF-Token';
    this.cookieOptions = {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      ...options.cookieOptions
    };
    
    // Performance optimization
    this.tokenCache = new Map();
    this.maxCacheSize = options.maxCacheSize || 10000;
    
    // Excluded paths
    this.excludePaths = new Set(options.excludePaths || [
      '/api/webhook',
      '/api/public',
      '/health'
    ]);
    
    // Safe methods
    this.safeMethods = new Set(options.safeMethods || ['GET', 'HEAD', 'OPTIONS']);
    
    // Cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000); // 5 minutes
  }

  /**
   * Generate CSRF token
   */
  generateToken(sessionId) {
    const token = randomBytes(this.tokenLength).toString('hex');
    
    switch (this.strategy) {
      case CSRFStrategy.SYNCHRONIZER:
        if (!sessionId) {
          throw new Error('Session ID required for synchronizer pattern');
        }
        this.storeToken(sessionId, token);
        break;
        
      case CSRFStrategy.SIGNED:
        return this.signToken(token);
        
      case CSRFStrategy.DOUBLE_SUBMIT:
      default:
        // Token is used as-is
        break;
    }
    
    return token;
  }

  /**
   * Verify CSRF token
   */
  verifyToken(token, sessionId, cookieToken) {
    if (!token) {
      return false;
    }
    
    switch (this.strategy) {
      case CSRFStrategy.SYNCHRONIZER:
        return this.verifySynchronizerToken(token, sessionId);
        
      case CSRFStrategy.SIGNED:
        return this.verifySignedToken(token);
        
      case CSRFStrategy.DOUBLE_SUBMIT:
      default:
        return this.verifyDoubleSubmitToken(token, cookieToken);
    }
  }

  /**
   * Middleware for Express
   */
  middleware() {
    return async (req, res, next) => {
      // Skip safe methods
      if (this.safeMethods.has(req.method)) {
        return next();
      }
      
      // Skip excluded paths
      if (this.excludePaths.has(req.path)) {
        return next();
      }
      
      // Generate token for GET requests
      if (req.method === 'GET') {
        const token = this.generateToken(req.session?.id);
        res.locals.csrfToken = token;
        
        if (this.strategy === CSRFStrategy.DOUBLE_SUBMIT) {
          res.cookie(this.cookieName, token, this.cookieOptions);
        }
        
        return next();
      }
      
      // Verify token for state-changing requests
      const headerToken = req.headers[this.headerName.toLowerCase()];
      const cookieToken = req.cookies?.[this.cookieName];
      const sessionId = req.session?.id;
      
      if (!this.verifyToken(headerToken, sessionId, cookieToken)) {
        this.emit('csrf_attack', {
          ip: req.ip,
          path: req.path,
          method: req.method
        });
        
        return res.status(403).json({ 
          error: 'Invalid CSRF token' 
        });
      }
      
      next();
    };
  }

  /**
   * Sign token with HMAC
   */
  signToken(token) {
    const timestamp = Date.now();
    const data = `${token}.${timestamp}`;
    const signature = createHmac('sha256', this.secret)
      .update(data)
      .digest('hex');
    
    return `${data}.${signature}`;
  }

  /**
   * Verify signed token
   */
  verifySignedToken(signedToken) {
    if (!signedToken) return false;
    
    const parts = signedToken.split('.');
    if (parts.length !== 3) return false;
    
    const [token, timestamp, signature] = parts;
    
    // Check expiry
    if (Date.now() - parseInt(timestamp) > this.tokenExpiry) {
      return false;
    }
    
    // Verify signature
    const expectedSignature = createHmac('sha256', this.secret)
      .update(`${token}.${timestamp}`)
      .digest('hex');
    
    return timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  }

  /**
   * Verify double submit token
   */
  verifyDoubleSubmitToken(headerToken, cookieToken) {
    if (!headerToken || !cookieToken) return false;
    
    return timingSafeEqual(
      Buffer.from(headerToken),
      Buffer.from(cookieToken)
    );
  }

  /**
   * Verify synchronizer token
   */
  verifySynchronizerToken(token, sessionId) {
    if (!token || !sessionId) return false;
    
    const storedToken = this.tokenCache.get(sessionId);
    if (!storedToken) return false;
    
    // Check expiry
    if (Date.now() - storedToken.timestamp > this.tokenExpiry) {
      this.tokenCache.delete(sessionId);
      return false;
    }
    
    return timingSafeEqual(
      Buffer.from(token),
      Buffer.from(storedToken.token)
    );
  }

  /**
   * Store token for synchronizer pattern
   */
  storeToken(sessionId, token) {
    // Enforce cache size limit
    if (this.tokenCache.size >= this.maxCacheSize) {
      const firstKey = this.tokenCache.keys().next().value;
      this.tokenCache.delete(firstKey);
    }
    
    this.tokenCache.set(sessionId, {
      token,
      timestamp: Date.now()
    });
  }

  /**
   * Clean up expired tokens
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, value] of this.tokenCache.entries()) {
      if (now - value.timestamp > this.tokenExpiry) {
        this.tokenCache.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.emit('cleanup', { cleaned });
    }
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    clearInterval(this.cleanupInterval);
    this.tokenCache.clear();
    this.removeAllListeners();
  }
}

/**
 * Request signing for API authentication
 */
export class RequestSigner {
  constructor(options = {}) {
    this.algorithm = options.algorithm || 'sha256';
    this.headerName = options.headerName || 'X-Signature';
    this.timestampHeader = options.timestampHeader || 'X-Timestamp';
    this.maxClockSkew = options.maxClockSkew || 300000; // 5 minutes
  }

  /**
   * Sign request
   */
  sign(method, path, body, secret) {
    const timestamp = Date.now();
    const payload = this.buildPayload(method, path, body, timestamp);
    
    const signature = createHmac(this.algorithm, secret)
      .update(payload)
      .digest('hex');
    
    return {
      signature,
      timestamp,
      headers: {
        [this.headerName]: signature,
        [this.timestampHeader]: timestamp
      }
    };
  }

  /**
   * Verify request signature
   */
  verify(req, secret) {
    const signature = req.headers[this.headerName.toLowerCase()];
    const timestamp = parseInt(req.headers[this.timestampHeader.toLowerCase()]);
    
    if (!signature || !timestamp) {
      return false;
    }
    
    // Check timestamp
    const now = Date.now();
    if (Math.abs(now - timestamp) > this.maxClockSkew) {
      return false;
    }
    
    // Build payload
    const payload = this.buildPayload(
      req.method,
      req.path,
      req.body,
      timestamp
    );
    
    // Verify signature
    const expectedSignature = createHmac(this.algorithm, secret)
      .update(payload)
      .digest('hex');
    
    return timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  }

  /**
   * Build payload for signing
   */
  buildPayload(method, path, body, timestamp) {
    const parts = [
      method.toUpperCase(),
      path,
      timestamp
    ];
    
    if (body && Object.keys(body).length > 0) {
      parts.push(JSON.stringify(body));
    }
    
    return parts.join(':');
  }
}

export default CSRFProtection;