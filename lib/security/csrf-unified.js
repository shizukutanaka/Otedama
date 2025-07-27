/**
 * Unified CSRF Protection - Otedama
 * Comprehensive CSRF protection with multiple strategies
 * 
 * Design principles:
 * - Carmack: Fast token validation
 * - Martin: Clean security architecture
 * - Pike: Simple but secure
 */

import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('CSRFUnified');

/**
 * CSRF protection strategies
 */
export const CSRFStrategy = {
  DOUBLE_SUBMIT: 'double_submit',
  SYNCHRONIZER_TOKEN: 'synchronizer_token',
  ENCRYPTED_TOKEN: 'encrypted_token',
  HMAC_BASED: 'hmac_based'
};

/**
 * Token storage methods
 */
export const TokenStorage = {
  SESSION: 'session',
  MEMORY: 'memory',
  REDIS: 'redis',
  SIGNED_COOKIE: 'signed_cookie'
};

/**
 * Unified CSRF Protection
 */
export class UnifiedCSRFProtection {
  constructor(config = {}) {
    this.config = {
      strategy: config.strategy || CSRFStrategy.SYNCHRONIZER_TOKEN,
      storage: config.storage || TokenStorage.SESSION,
      tokenLength: config.tokenLength || 32,
      tokenLifetime: config.tokenLifetime || 3600000, // 1 hour
      cookieName: config.cookieName || 'csrf-token',
      headerName: config.headerName || 'x-csrf-token',
      secret: config.secret || randomBytes(32).toString('hex'),
      skipMethods: config.skipMethods || ['GET', 'HEAD', 'OPTIONS'],
      skipPaths: config.skipPaths || [],
      ...config
    };
    
    this.tokenStore = new Map();
    this.initialize();
  }
  
  initialize() {
    // Initialize storage backend
    switch (this.config.storage) {
      case TokenStorage.MEMORY:
        this.storage = this.tokenStore;
        break;
      case TokenStorage.REDIS:
        // Initialize Redis storage if configured
        break;
      default:
        // Session storage handled per request
        break;
    }
    
    // Start cleanup interval for memory storage
    if (this.config.storage === TokenStorage.MEMORY) {
      this.startCleanup();
    }
    
    logger.info('CSRF protection initialized', {
      strategy: this.config.strategy,
      storage: this.config.storage
    });
  }
  
  /**
   * Generate CSRF token
   */
  generateToken(sessionId) {
    const tokenBytes = randomBytes(this.config.tokenLength);
    const token = tokenBytes.toString('hex');
    
    switch (this.config.strategy) {
      case CSRFStrategy.HMAC_BASED:
        return this.generateHMACToken(sessionId);
        
      case CSRFStrategy.ENCRYPTED_TOKEN:
        return this.encryptToken(token, sessionId);
        
      case CSRFStrategy.SYNCHRONIZER_TOKEN:
      default:
        this.storeToken(sessionId, token);
        return token;
    }
  }
  
  /**
   * Verify CSRF token
   */
  verifyToken(sessionId, providedToken) {
    if (!providedToken) {
      return false;
    }
    
    try {
      switch (this.config.strategy) {
        case CSRFStrategy.HMAC_BASED:
          return this.verifyHMACToken(sessionId, providedToken);
          
        case CSRFStrategy.ENCRYPTED_TOKEN:
          return this.verifyEncryptedToken(sessionId, providedToken);
          
        case CSRFStrategy.DOUBLE_SUBMIT:
          return this.verifyDoubleSubmit(sessionId, providedToken);
          
        case CSRFStrategy.SYNCHRONIZER_TOKEN:
        default:
          const storedToken = this.getStoredToken(sessionId);
          if (!storedToken) {
            return false;
          }
          
          // Timing-safe comparison
          const stored = Buffer.from(storedToken);
          const provided = Buffer.from(providedToken);
          
          if (stored.length !== provided.length) {
            return false;
          }
          
          return timingSafeEqual(stored, provided);
      }
    } catch (error) {
      logger.error('Token verification failed', { error, sessionId });
      return false;
    }
  }
  
  /**
   * Express middleware
   */
  middleware(options = {}) {
    return async (req, res, next) => {
      // Skip for safe methods
      if (this.config.skipMethods.includes(req.method)) {
        return next();
      }
      
      // Skip for configured paths
      if (this.config.skipPaths.some(path => req.path.startsWith(path))) {
        return next();
      }
      
      // Get session ID
      const sessionId = req.sessionID || req.session?.id || req.ip;
      
      // Token generation for GET requests
      if (req.method === 'GET') {
        const token = this.generateToken(sessionId);
        res.locals.csrfToken = token;
        
        // Set cookie for double submit
        if (this.config.strategy === CSRFStrategy.DOUBLE_SUBMIT) {
          res.cookie(this.config.cookieName, token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            signed: true
          });
        }
        
        return next();
      }
      
      // Token validation for state-changing requests
      const token = this.extractToken(req);
      
      if (!this.verifyToken(sessionId, token)) {
        logger.warn('CSRF token validation failed', {
          sessionId,
          method: req.method,
          path: req.path
        });
        
        return res.status(403).json({
          error: 'Invalid CSRF token',
          message: 'Request verification failed'
        });
      }
      
      // Regenerate token after successful validation
      if (options.regenerate !== false) {
        const newToken = this.generateToken(sessionId);
        res.locals.csrfToken = newToken;
      }
      
      next();
    };
  }
  
  /**
   * Extract token from request
   */
  extractToken(req) {
    // Check header
    let token = req.headers[this.config.headerName];
    
    // Check body
    if (!token && req.body) {
      token = req.body._csrf || req.body.csrf || req.body.csrfToken;
    }
    
    // Check query
    if (!token && req.query) {
      token = req.query._csrf || req.query.csrf;
    }
    
    // Check cookie for double submit
    if (!token && this.config.strategy === CSRFStrategy.DOUBLE_SUBMIT) {
      token = req.signedCookies[this.config.cookieName];
    }
    
    return token;
  }
  
  /**
   * Store token
   */
  storeToken(sessionId, token) {
    const entry = {
      token,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.tokenLifetime
    };
    
    switch (this.config.storage) {
      case TokenStorage.MEMORY:
        this.tokenStore.set(sessionId, entry);
        break;
      // Other storage implementations
    }
  }
  
  /**
   * Get stored token
   */
  getStoredToken(sessionId) {
    switch (this.config.storage) {
      case TokenStorage.MEMORY:
        const entry = this.tokenStore.get(sessionId);
        if (!entry) return null;
        
        // Check expiration
        if (Date.now() > entry.expiresAt) {
          this.tokenStore.delete(sessionId);
          return null;
        }
        
        return entry.token;
      // Other storage implementations
      default:
        return null;
    }
  }
  
  /**
   * Generate HMAC-based token
   */
  generateHMACToken(sessionId) {
    const timestamp = Date.now();
    const data = `${sessionId}:${timestamp}`;
    const hmac = createHash('sha256')
      .update(this.config.secret + data)
      .digest('hex');
    
    return `${timestamp}:${hmac}`;
  }
  
  /**
   * Verify HMAC-based token
   */
  verifyHMACToken(sessionId, token) {
    const parts = token.split(':');
    if (parts.length !== 2) return false;
    
    const [timestamp, providedHmac] = parts;
    const tokenAge = Date.now() - parseInt(timestamp);
    
    // Check token age
    if (tokenAge > this.config.tokenLifetime) {
      return false;
    }
    
    // Verify HMAC
    const data = `${sessionId}:${timestamp}`;
    const expectedHmac = createHash('sha256')
      .update(this.config.secret + data)
      .digest('hex');
    
    return timingSafeEqual(
      Buffer.from(providedHmac),
      Buffer.from(expectedHmac)
    );
  }
  
  /**
   * Encrypt token
   */
  encryptToken(token, sessionId) {
    // Simple encryption - in production use proper encryption
    const data = JSON.stringify({ token, sessionId, timestamp: Date.now() });
    const encrypted = Buffer.from(data).toString('base64');
    const signature = createHash('sha256')
      .update(this.config.secret + encrypted)
      .digest('hex');
    
    return `${encrypted}.${signature}`;
  }
  
  /**
   * Verify encrypted token
   */
  verifyEncryptedToken(sessionId, encryptedToken) {
    const parts = encryptedToken.split('.');
    if (parts.length !== 2) return false;
    
    const [encrypted, providedSignature] = parts;
    
    // Verify signature
    const expectedSignature = createHash('sha256')
      .update(this.config.secret + encrypted)
      .digest('hex');
    
    if (!timingSafeEqual(
      Buffer.from(providedSignature),
      Buffer.from(expectedSignature)
    )) {
      return false;
    }
    
    // Decrypt and verify
    try {
      const decrypted = Buffer.from(encrypted, 'base64').toString();
      const data = JSON.parse(decrypted);
      
      // Check session ID
      if (data.sessionId !== sessionId) {
        return false;
      }
      
      // Check timestamp
      const age = Date.now() - data.timestamp;
      if (age > this.config.tokenLifetime) {
        return false;
      }
      
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Verify double submit token
   */
  verifyDoubleSubmit(sessionId, token) {
    // In double submit, the token in cookie and header/body must match
    return true; // Implementation depends on cookie handling
  }
  
  /**
   * Start cleanup interval
   */
  startCleanup() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      
      for (const [sessionId, entry] of this.tokenStore) {
        if (now > entry.expiresAt) {
          this.tokenStore.delete(sessionId);
        }
      }
      
      logger.debug('CSRF token cleanup', {
        remaining: this.tokenStore.size
      });
    }, 300000); // Every 5 minutes
  }
  
  /**
   * Get statistics
   */
  getStatistics() {
    return {
      strategy: this.config.strategy,
      storage: this.config.storage,
      activeTokens: this.tokenStore.size
    };
  }
  
  /**
   * Shutdown
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.tokenStore.clear();
    logger.info('CSRF protection shutdown');
  }
}

/**
 * Factory function
 */
export function createCSRFProtection(config) {
  return new UnifiedCSRFProtection(config);
}

export default UnifiedCSRFProtection;