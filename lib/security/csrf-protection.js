/**
 * Unified CSRF Protection System
 * Combines best practices from multiple implementations
 * Zero-knowledge proof compatible
 */

import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { EventEmitter } from 'events';

export const CSRFStrategy = {
  DOUBLE_SUBMIT: 'double_submit',
  SYNCHRONIZER: 'synchronizer',
  SIGNED: 'signed',
  ENCRYPTED: 'encrypted'
};

export class CSRFProtection extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.secret = options.secret || randomBytes(32).toString('hex');
    this.tokenLength = options.tokenLength || 32;
    this.tokenExpiry = options.tokenExpiry || 3600000; // 1 hour
    this.strategy = options.strategy || CSRFStrategy.DOUBLE_SUBMIT;
    
    // Cookie configuration
    this.cookieName = options.cookieName || '__Host-csrf';
    this.headerName = options.headerName || 'X-CSRF-Token';
    this.cookieOptions = {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      ...options.cookieOptions
    };
    
    // Token store for session-based strategies
    this.tokenStore = new Map();
    
    // Excluded paths
    this.excludePaths = new Set(options.excludePaths || [
      '/api/webhook',
      '/api/public',
      '/health'
    ]);
    
    // Safe methods that don't require CSRF
    this.safeMethods = new Set(options.safeMethods || ['GET', 'HEAD', 'OPTIONS']);
    
    // Metrics
    this.metrics = {
      generated: 0,
      validated: 0,
      failed: 0
    };
    
    // Start cleanup interval
    this.startCleanup();
  }

  generateToken(sessionId = null) {
    const token = randomBytes(this.tokenLength).toString('hex');
    const timestamp = Date.now();
    
    let finalToken;
    switch (this.strategy) {
      case CSRFStrategy.SIGNED:
        const signature = this.sign(token, timestamp);
        finalToken = `${token}.${timestamp}.${signature}`;
        break;
        
      case CSRFStrategy.SYNCHRONIZER:
        if (!sessionId) throw new Error('Session ID required for synchronizer strategy');
        this.tokenStore.set(sessionId, { token, timestamp });
        finalToken = token;
        break;
        
      case CSRFStrategy.DOUBLE_SUBMIT:
      default:
        finalToken = token;
        break;
    }
    
    this.metrics.generated++;
    this.emit('token:generated', { strategy: this.strategy });
    
    return finalToken;
  }

  validateToken(token, sessionId = null, cookieToken = null) {
    try {
      if (!token) {
        this.metrics.failed++;
        return false;
      }
      
      let isValid = false;
      
      switch (this.strategy) {
        case CSRFStrategy.SIGNED:
          isValid = this.validateSignedToken(token);
          break;
          
        case CSRFStrategy.SYNCHRONIZER:
          isValid = this.validateSynchronizerToken(token, sessionId);
          break;
          
        case CSRFStrategy.DOUBLE_SUBMIT:
          isValid = this.validateDoubleSubmitToken(token, cookieToken);
          break;
      }
      
      if (isValid) {
        this.metrics.validated++;
        this.emit('token:validated', { strategy: this.strategy });
      } else {
        this.metrics.failed++;
        this.emit('token:failed', { strategy: this.strategy });
      }
      
      return isValid;
    } catch (error) {
      this.emit('error', error);
      this.metrics.failed++;
      return false;
    }
  }

  validateSignedToken(token) {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    
    const [tokenPart, timestamp, signature] = parts;
    const expectedSignature = this.sign(tokenPart, timestamp);
    
    // Check signature
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return false;
    }
    
    // Check expiry
    const tokenAge = Date.now() - parseInt(timestamp);
    return tokenAge <= this.tokenExpiry;
  }

  validateSynchronizerToken(token, sessionId) {
    if (!sessionId) return false;
    
    const stored = this.tokenStore.get(sessionId);
    if (!stored) return false;
    
    // Check token match
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(stored.token))) {
      return false;
    }
    
    // Check expiry
    const tokenAge = Date.now() - stored.timestamp;
    if (tokenAge > this.tokenExpiry) {
      this.tokenStore.delete(sessionId);
      return false;
    }
    
    return true;
  }

  validateDoubleSubmitToken(headerToken, cookieToken) {
    if (!headerToken || !cookieToken) return false;
    
    // Simple timing-safe comparison
    return timingSafeEqual(
      Buffer.from(headerToken),
      Buffer.from(cookieToken)
    );
  }

  sign(token, timestamp) {
    const data = `${token}.${timestamp}`;
    return createHmac('sha256', this.secret)
      .update(data)
      .digest('hex');
  }

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
        const token = this.generateToken(req.sessionID);
        res.locals.csrfToken = token;
        
        if (this.strategy === CSRFStrategy.DOUBLE_SUBMIT) {
          res.cookie(this.cookieName, token, this.cookieOptions);
        }
        
        return next();
      }
      
      // Validate token for state-changing requests
      const headerToken = req.headers[this.headerName.toLowerCase()] || 
                         req.body._csrf || 
                         req.query._csrf;
      
      const cookieToken = req.cookies?.[this.cookieName];
      const isValid = this.validateToken(headerToken, req.sessionID, cookieToken);
      
      if (!isValid) {
        return res.status(403).json({
          error: 'Invalid CSRF token',
          code: 'CSRF_VALIDATION_FAILED'
        });
      }
      
      next();
    };
  }

  startCleanup() {
    // Clean up expired tokens every hour
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, data] of this.tokenStore.entries()) {
        if (now - data.timestamp > this.tokenExpiry) {
          this.tokenStore.delete(sessionId);
        }
      }
    }, 3600000);
  }

  getMetrics() {
    return {
      ...this.metrics,
      activeTokens: this.tokenStore.size
    };
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.tokenStore.clear();
    this.removeAllListeners();
  }
}

// Export convenience functions
export function createCSRFProtection(options) {
  return new CSRFProtection(options);
}

export default CSRFProtection;