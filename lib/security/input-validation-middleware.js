/**
 * Input Validation Middleware
 * Comprehensive validation for all API endpoints
 */

import { body, param, query, validationResult } from 'express-validator';
import { createStructuredLogger } from '../core/structured-logger.js';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import crypto from 'crypto';

const logger = createStructuredLogger('InputValidation');

/**
 * Enhanced rate limiter with multiple tiers
 */
class HierarchicalRateLimiter {
  constructor() {
    // Global rate limiter
    this.globalLimiter = new RateLimiterMemory({
      points: 10000, // Total requests
      duration: 60, // Per minute
      blockDuration: 300 // Block for 5 minutes
    });
    
    // Per-IP rate limiter
    this.ipLimiter = new RateLimiterMemory({
      points: 100,
      duration: 60,
      blockDuration: 600 // Block for 10 minutes
    });
    
    // Per-user rate limiter
    this.userLimiter = new RateLimiterMemory({
      points: 200,
      duration: 60,
      blockDuration: 300
    });
    
    // Endpoint-specific limiters
    this.endpointLimiters = new Map();
    
    // Blocked IPs with exponential backoff
    this.blockedIPs = new Map();
    
    this.setupEndpointLimiters();
  }
  
  setupEndpointLimiters() {
    // Auth endpoints - strict limits
    this.endpointLimiters.set('/api/auth/login', new RateLimiterMemory({
      points: 5,
      duration: 300, // 5 attempts per 5 minutes
      blockDuration: 1800 // 30 minutes
    }));
    
    // Mining endpoints - moderate limits
    this.endpointLimiters.set('/api/mining/submit', new RateLimiterMemory({
      points: 1000,
      duration: 60,
      blockDuration: 60
    }));
    
    // Query endpoints - relaxed limits
    this.endpointLimiters.set('/api/stats', new RateLimiterMemory({
      points: 60,
      duration: 60,
      blockDuration: 60
    }));
  }
  
  async checkLimit(req) {
    const ip = req.ip || req.connection.remoteAddress;
    const userId = req.user?.id || 'anonymous';
    const endpoint = req.route?.path || req.path;
    
    try {
      // Check if IP is blocked with backoff
      if (this.isBlockedWithBackoff(ip)) {
        throw new Error('IP blocked due to repeated violations');
      }
      
      // Check global limit
      await this.globalLimiter.consume('global');
      
      // Check IP limit
      await this.ipLimiter.consume(ip);
      
      // Check user limit if authenticated
      if (userId !== 'anonymous') {
        await this.userLimiter.consume(userId);
      }
      
      // Check endpoint-specific limit
      const endpointLimiter = this.endpointLimiters.get(endpoint);
      if (endpointLimiter) {
        await endpointLimiter.consume(`${ip}:${endpoint}`);
      }
      
      return true;
      
    } catch (rejRes) {
      // Add to blocked list on repeated violations
      this.handleRateLimitViolation(ip);
      
      const retryAfter = Math.round(rejRes.msBeforeNext / 1000) || 60;
      
      throw {
        status: 429,
        message: 'Too many requests',
        retryAfter,
        ip,
        endpoint
      };
    }
  }
  
  isBlockedWithBackoff(ip) {
    const blockInfo = this.blockedIPs.get(ip);
    if (!blockInfo) return false;
    
    const now = Date.now();
    const blockDuration = Math.min(
      blockInfo.baseBlockTime * Math.pow(2, blockInfo.violations),
      86400000 // Max 24 hours
    );
    
    if (now < blockInfo.blockedUntil + blockDuration) {
      return true;
    }
    
    // Unblock if time has passed
    this.blockedIPs.delete(ip);
    return false;
  }
  
  handleRateLimitViolation(ip) {
    const existing = this.blockedIPs.get(ip) || {
      violations: 0,
      baseBlockTime: 300000, // 5 minutes base
      blockedUntil: Date.now()
    };
    
    existing.violations++;
    existing.blockedUntil = Date.now();
    
    this.blockedIPs.set(ip, existing);
    
    logger.warn('Rate limit violation', {
      ip,
      violations: existing.violations,
      blockDuration: existing.baseBlockTime * Math.pow(2, existing.violations)
    });
  }
}

/**
 * Validation schemas for different entity types
 */
export const validationSchemas = {
  // User input validation
  user: {
    username: body('username')
      .trim()
      .isLength({ min: 3, max: 30 })
      .matches(/^[a-zA-Z0-9_-]+$/)
      .withMessage('Username must be 3-30 characters, alphanumeric with _ and -'),
    
    email: body('email')
      .trim()
      .isEmail()
      .normalizeEmail()
      .withMessage('Invalid email address'),
    
    password: body('password')
      .isLength({ min: 8, max: 128 })
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
      .withMessage('Password must contain uppercase, lowercase, number and special character'),
    
    address: body('address')
      .trim()
      .matches(/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/)
      .withMessage('Invalid Bitcoin address')
  },
  
  // Mining input validation
  mining: {
    jobId: body('jobId')
      .isHexadecimal()
      .isLength({ min: 16, max: 64 })
      .withMessage('Invalid job ID'),
    
    nonce: body('nonce')
      .isHexadecimal()
      .isLength({ min: 8, max: 16 })
      .withMessage('Invalid nonce'),
    
    hash: body('hash')
      .isHexadecimal()
      .isLength({ min: 64, max: 64 })
      .withMessage('Invalid hash'),
    
    difficulty: body('difficulty')
      .isFloat({ min: 0.0001, max: 1000000000 })
      .withMessage('Invalid difficulty'),
    
    workerId: body('workerId')
      .trim()
      .isAlphanumeric()
      .isLength({ min: 1, max: 50 })
      .withMessage('Invalid worker ID')
  },
  
  // Query parameter validation
  query: {
    limit: query('limit')
      .optional()
      .isInt({ min: 1, max: 1000 })
      .toInt()
      .withMessage('Limit must be between 1 and 1000'),
    
    offset: query('offset')
      .optional()
      .isInt({ min: 0 })
      .toInt()
      .withMessage('Offset must be non-negative'),
    
    sort: query('sort')
      .optional()
      .isIn(['asc', 'desc', 'ASC', 'DESC'])
      .toLowerCase()
      .withMessage('Sort must be asc or desc'),
    
    dateFrom: query('from')
      .optional()
      .isISO8601()
      .toDate()
      .withMessage('Invalid date format'),
    
    dateTo: query('to')
      .optional()
      .isISO8601()
      .toDate()
      .withMessage('Invalid date format')
  },
  
  // Payment validation
  payment: {
    amount: body('amount')
      .isFloat({ min: 0.00000001, max: 21000000 })
      .withMessage('Invalid amount'),
    
    currency: body('currency')
      .isIn(['BTC', 'ETH', 'LTC', 'BCH'])
      .withMessage('Unsupported currency'),
    
    txHash: body('txHash')
      .optional()
      .isHexadecimal()
      .isLength({ min: 64, max: 64 })
      .withMessage('Invalid transaction hash')
  }
};

/**
 * SQL injection prevention
 */
export function sanitizeSQL(input) {
  if (typeof input !== 'string') return input;
  
  // Remove common SQL injection patterns
  return input
    .replace(/'/g, "''") // Escape single quotes
    .replace(/;/g, '') // Remove semicolons
    .replace(/--/g, '') // Remove SQL comments
    .replace(/\/\*/g, '') // Remove block comments
    .replace(/\*\//g, '')
    .replace(/xp_/gi, '') // Remove extended procedures
    .replace(/script/gi, '') // Remove script tags
    .trim();
}

/**
 * XSS prevention
 */
export function sanitizeHTML(input) {
  if (typeof input !== 'string') return input;
  
  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
    .replace(/`/g, '&#x60;')
    .replace(/=/g, '&#x3D;');
}

/**
 * Path traversal prevention
 */
export function sanitizePath(input) {
  if (typeof input !== 'string') return input;
  
  return input
    .replace(/\.\./g, '') // Remove directory traversal
    .replace(/[<>:"|?*]/g, '') // Remove invalid characters
    .replace(/\\/g, '/') // Normalize slashes
    .replace(/\/+/g, '/') // Remove multiple slashes
    .trim();
}

/**
 * Create validation middleware
 */
export function createValidationMiddleware(schemas) {
  return async (req, res, next) => {
    try {
      // Run validations
      await Promise.all(schemas.map(schema => schema.run(req)));
      
      // Check results
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        logger.warn('Validation failed', {
          errors: errors.array(),
          ip: req.ip,
          path: req.path
        });
        
        return res.status(400).json({
          error: 'Validation failed',
          details: errors.array().map(err => ({
            field: err.param,
            message: err.msg,
            value: err.value
          }))
        });
      }
      
      // Sanitize all inputs
      req.body = sanitizeObject(req.body);
      req.query = sanitizeObject(req.query);
      req.params = sanitizeObject(req.params);
      
      next();
      
    } catch (error) {
      logger.error('Validation middleware error:', error);
      res.status(500).json({ error: 'Internal validation error' });
    }
  };
}

/**
 * Recursively sanitize object
 */
function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  
  const sanitized = Array.isArray(obj) ? [] : {};
  
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      sanitized[key] = sanitizeHTML(value);
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeObject(value);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

/**
 * Rate limiting middleware
 */
const rateLimiter = new HierarchicalRateLimiter();

export async function rateLimitMiddleware(req, res, next) {
  try {
    await rateLimiter.checkLimit(req);
    next();
  } catch (error) {
    const status = error.status || 429;
    res.status(status)
      .set('Retry-After', error.retryAfter || 60)
      .json({
        error: error.message || 'Too many requests',
        retryAfter: error.retryAfter || 60
      });
  }
}

/**
 * Security headers middleware
 */
export function securityHeaders(req, res, next) {
  // Security headers
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss:; frame-ancestors 'none';",
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
  });
  
  // Remove sensitive headers
  res.removeHeader('X-Powered-By');
  
  next();
}

/**
 * Request signing verification
 */
export function verifyRequestSignature(secret) {
  return (req, res, next) => {
    const signature = req.headers['x-signature'];
    const timestamp = req.headers['x-timestamp'];
    
    if (!signature || !timestamp) {
      return res.status(401).json({ error: 'Missing signature' });
    }
    
    // Check timestamp (5 minute window)
    const now = Date.now();
    const requestTime = parseInt(timestamp);
    if (Math.abs(now - requestTime) > 300000) {
      return res.status(401).json({ error: 'Request expired' });
    }
    
    // Verify signature
    const payload = JSON.stringify(req.body) + timestamp;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    
    if (signature !== expectedSignature) {
      logger.warn('Invalid request signature', {
        ip: req.ip,
        path: req.path
      });
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    next();
  };
}

// Export validation middleware for common endpoints
export const authValidation = createValidationMiddleware([
  validationSchemas.user.username,
  validationSchemas.user.password
]);

export const miningValidation = createValidationMiddleware([
  validationSchemas.mining.jobId,
  validationSchemas.mining.nonce,
  validationSchemas.mining.hash,
  validationSchemas.mining.workerId
]);

export const queryValidation = createValidationMiddleware([
  validationSchemas.query.limit,
  validationSchemas.query.offset,
  validationSchemas.query.sort
]);