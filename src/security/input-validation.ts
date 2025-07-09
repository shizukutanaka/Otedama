// Security middleware for input validation and SQL injection prevention
import { Request, Response, NextFunction } from 'express';
import * as validator from 'validator';
import { createHash } from 'crypto';
import { ValidationError } from '../errors/custom-errors';
import { createComponentLogger } from '../logging/logger';

const logger = createComponentLogger('SecurityMiddleware');

// Rate limiting storage
const requestCounts = new Map<string, { count: number; resetAt: number }>();

// SQL injection patterns
const SQL_INJECTION_PATTERNS = [
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|EXEC|EXECUTE)\b)/gi,
  /(-{2}|\/\*|\*\/|;|'|"|`|\\x00|\\n|\\r|\\x1a)/g,
  /(CAST|CONVERT|CHAR|CONCAT|SUBSTRING|LENGTH|ASCII)\s*\(/gi,
  /(\bOR\b\s*\d+\s*=\s*\d+|\bAND\b\s*\d+\s*=\s*\d+)/gi,
  /(SLEEP|BENCHMARK|WAITFOR|DELAY)/gi
];

// XSS patterns
const XSS_PATTERNS = [
  /<script[^>]*>.*?<\/script>/gi,
  /<iframe[^>]*>.*?<\/iframe>/gi,
  /javascript:/gi,
  /on\w+\s*=/gi,
  /<img[^>]+src[\\s]*=[\\s]*["\']javascript:/gi
];

// Path traversal patterns
const PATH_TRAVERSAL_PATTERNS = [
  /\.\./g,
  /\.\.\\/, 
  /%2e%2e/gi,
  /%252e%252e/gi
];

// Input sanitization middleware
export function sanitizeInput(req: Request, res: Response, next: NextFunction) {
  try {
    // Sanitize query parameters
    if (req.query) {
      req.query = sanitizeObject(req.query);
    }
    
    // Sanitize body
    if (req.body) {
      req.body = sanitizeObject(req.body);
    }
    
    // Sanitize params
    if (req.params) {
      req.params = sanitizeObject(req.params);
    }
    
    next();
  } catch (error) {
    logger.error('Input sanitization failed', error as Error);
    res.status(400).json({ error: 'Invalid input' });
  }
}

// Recursive object sanitizer
function sanitizeObject(obj: any): any {
  if (typeof obj === 'string') {
    return sanitizeString(obj);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }
  
  if (obj && typeof obj === 'object') {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      // Sanitize key
      const sanitizedKey = sanitizeString(key);
      // Sanitize value
      sanitized[sanitizedKey] = sanitizeObject(value);
    }
    return sanitized;
  }
  
  return obj;
}

// String sanitization
function sanitizeString(str: string): string {
  if (typeof str !== 'string') return str;
  
  // Trim whitespace
  str = str.trim();
  
  // Remove null bytes
  str = str.replace(/\0/g, '');
  
  // Escape HTML entities
  str = validator.escape(str);
  
  // Remove control characters
  str = str.replace(/[\x00-\x1F\x7F]/g, '');
  
  return str;
}

// SQL injection prevention middleware
export function preventSQLInjection(req: Request, res: Response, next: NextFunction) {
  const checkValue = (value: any): boolean => {
    if (typeof value !== 'string') return true;
    
    // Check against SQL injection patterns
    for (const pattern of SQL_INJECTION_PATTERNS) {
      if (pattern.test(value)) {
        logger.warn('SQL injection attempt detected', {
          ip: req.ip,
          value: value.substring(0, 100),
          path: req.path
        });
        return false;
      }
    }
    return true;
  };
  
  // Check all input sources
  const checkObject = (obj: any): boolean => {
    for (const value of Object.values(obj)) {
      if (typeof value === 'string' && !checkValue(value)) {
        return false;
      } else if (typeof value === 'object' && value !== null) {
        if (!checkObject(value)) return false;
      }
    }
    return true;
  };
  
  if (req.query && !checkObject(req.query)) {
    return res.status(400).json({ error: 'Invalid input detected' });
  }
  
  if (req.body && !checkObject(req.body)) {
    return res.status(400).json({ error: 'Invalid input detected' });
  }
  
  if (req.params && !checkObject(req.params)) {
    return res.status(400).json({ error: 'Invalid input detected' });
  }
  
  next();
}

// XSS prevention middleware
export function preventXSS(req: Request, res: Response, next: NextFunction) {
  // Set security headers
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline';");
  
  const checkValue = (value: any): boolean => {
    if (typeof value !== 'string') return true;
    
    for (const pattern of XSS_PATTERNS) {
      if (pattern.test(value)) {
        logger.warn('XSS attempt detected', {
          ip: req.ip,
          value: value.substring(0, 100),
          path: req.path
        });
        return false;
      }
    }
    return true;
  };
  
  // Check request body for XSS
  if (req.body && typeof req.body === 'object') {
    const checkObject = (obj: any): boolean => {
      for (const value of Object.values(obj)) {
        if (!checkValue(value)) return false;
        if (typeof value === 'object' && value !== null) {
          if (!checkObject(value)) return false;
        }
      }
      return true;
    };
    
    if (!checkObject(req.body)) {
      return res.status(400).json({ error: 'Invalid input detected' });
    }
  }
  
  next();
}

// Path traversal prevention
export function preventPathTraversal(req: Request, res: Response, next: NextFunction) {
  const checkPath = (path: string): boolean => {
    for (const pattern of PATH_TRAVERSAL_PATTERNS) {
      if (pattern.test(path)) {
        logger.warn('Path traversal attempt detected', {
          ip: req.ip,
          path: path,
          requestPath: req.path
        });
        return false;
      }
    }
    return true;
  };
  
  // Check URL path
  if (!checkPath(req.path)) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  
  // Check query parameters that might contain paths
  const pathParams = ['file', 'path', 'dir', 'folder', 'filename'];
  for (const param of pathParams) {
    if (req.query[param] && !checkPath(req.query[param] as string)) {
      return res.status(400).json({ error: 'Invalid path parameter' });
    }
  }
  
  next();
}

// Rate limiting middleware
export function rateLimit(options: {
  windowMs: number;
  max: number;
  keyGenerator?: (req: Request) => string;
}) {
  const { windowMs, max, keyGenerator } = options;
  
  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyGenerator ? keyGenerator(req) : req.ip;
    const now = Date.now();
    
    // Clean up old entries
    for (const [k, v] of requestCounts.entries()) {
      if (now > v.resetAt) {
        requestCounts.delete(k);
      }
    }
    
    // Get or create rate limit data
    let rateData = requestCounts.get(key);
    if (!rateData || now > rateData.resetAt) {
      rateData = { count: 0, resetAt: now + windowMs };
      requestCounts.set(key, rateData);
    }
    
    // Increment count
    rateData.count++;
    
    // Check limit
    if (rateData.count > max) {
      logger.warn('Rate limit exceeded', {
        ip: req.ip,
        key,
        count: rateData.count
      });
      
      res.setHeader('X-RateLimit-Limit', max.toString());
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', new Date(rateData.resetAt).toISOString());
      
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((rateData.resetAt - now) / 1000)
      });
    }
    
    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', max.toString());
    res.setHeader('X-RateLimit-Remaining', (max - rateData.count).toString());
    res.setHeader('X-RateLimit-Reset', new Date(rateData.resetAt).toISOString());
    
    next();
  };
}

// Bitcoin address validation
export function validateBitcoinAddress(address: string): boolean {
  // P2PKH (Legacy)
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
    return true;
  }
  
  // P2SH
  if (/^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
    return true;
  }
  
  // Bech32 (Native SegWit)
  if (/^bc1[a-z0-9]{39,59}$/.test(address)) {
    return true;
  }
  
  // Bech32m (Taproot)
  if (/^bc1p[a-z0-9]{39,59}$/.test(address)) {
    return true;
  }
  
  return false;
}

// Validate Ethereum address
export function validateEthereumAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// Validate mining parameters
export function validateMiningParams(params: any): boolean {
  const schema = {
    jobId: { type: 'string', pattern: /^[a-fA-F0-9]{8,64}$/ },
    nonce: { type: 'string', pattern: /^[a-fA-F0-9]{8}$/ },
    time: { type: 'number', min: 0, max: 2147483647 },
    extraNonce: { type: 'string', pattern: /^[a-fA-F0-9]{0,16}$/ }
  };
  
  for (const [key, rules] of Object.entries(schema)) {
    const value = params[key];
    if (value === undefined) continue;
    
    if (rules.type === 'string' && rules.pattern) {
      if (!rules.pattern.test(value)) {
        logger.warn('Invalid mining parameter', { key, value });
        return false;
      }
    } else if (rules.type === 'number') {
      const num = parseInt(value);
      if (isNaN(num) || num < rules.min! || num > rules.max!) {
        logger.warn('Invalid mining parameter', { key, value });
        return false;
      }
    }
  }
  
  return true;
}

// Password strength validation
export function validatePassword(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }
  
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

// CSRF token generation and validation
const csrfTokens = new Map<string, { token: string; expires: number }>();

export function generateCSRFToken(sessionId: string): string {
  const token = createHash('sha256')
    .update(sessionId + Date.now() + Math.random())
    .digest('hex');
  
  csrfTokens.set(sessionId, {
    token,
    expires: Date.now() + 3600000 // 1 hour
  });
  
  return token;
}

export function validateCSRFToken(sessionId: string, token: string): boolean {
  const stored = csrfTokens.get(sessionId);
  
  if (!stored || stored.expires < Date.now()) {
    return false;
  }
  
  return stored.token === token;
}

// Clean up expired CSRF tokens
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, data] of csrfTokens.entries()) {
    if (data.expires < now) {
      csrfTokens.delete(sessionId);
    }
  }
}, 300000); // Every 5 minutes

// Middleware to validate request origin
export function validateOrigin(allowedOrigins: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin || req.headers.referer;
    
    if (!origin && req.method === 'GET') {
      // Allow GET requests without origin
      return next();
    }
    
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      return next();
    }
    
    logger.warn('Invalid origin', {
      origin,
      ip: req.ip,
      path: req.path
    });
    
    res.status(403).json({ error: 'Forbidden' });
  };
}

// Export all security middleware as a single function
export function applySecurity(app: any, options?: {
  rateLimit?: { windowMs: number; max: number };
  allowedOrigins?: string[];
}) {
  // Apply all security middleware
  app.use(sanitizeInput);
  app.use(preventSQLInjection);
  app.use(preventXSS);
  app.use(preventPathTraversal);
  
  // Apply rate limiting if configured
  if (options?.rateLimit) {
    app.use(rateLimit(options.rateLimit));
  }
  
  // Apply origin validation if configured
  if (options?.allowedOrigins) {
    app.use(validateOrigin(options.allowedOrigins));
  }
  
  logger.info('Security middleware applied');
}
