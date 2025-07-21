/**
 * Core Security Module for Otedama
 * Provides basic security functionality
 */

import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { DatabaseService } from '../database-service.js';
import { getCryptoUtils } from '../crypto/crypto-utils.js';

// Rate limiting configuration
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 100;
const MAX_REQUESTS_PER_IP = 500;

// JWT configuration
const JWT_SECRET = (() => {
  if (!process.env.JWT_SECRET) {
    console.error('CRITICAL SECURITY ERROR: JWT_SECRET environment variable is not set!');
    console.error('Application will not start without a secure JWT secret.');
    process.exit(1);
  }
  if (process.env.JWT_SECRET.length < 32) {
    console.error('CRITICAL SECURITY ERROR: JWT_SECRET must be at least 32 characters long!');
    process.exit(1);
  }
  return process.env.JWT_SECRET;
})();
const JWT_EXPIRY = '24h';

// CSRF token store
const csrfTokens = new Map();

// API key store
const apiKeys = new Map();

// IP filters
const ipWhitelist = new Set();
const ipBlacklist = new Set();

// Crypto utilities instance
const crypto = getCryptoUtils();

/**
 * Rate limiting middleware
 */
export function rateLimit(identifier, maxRequests = MAX_REQUESTS_PER_WINDOW) {
  const now = Date.now();
  const key = identifier;
  
  if (!rateLimits.has(key)) {
    rateLimits.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return { allowed: true, remaining: maxRequests - 1 };
  }
  
  const limit = rateLimits.get(key);
  
  if (now > limit.resetTime) {
    limit.count = 1;
    limit.resetTime = now + RATE_LIMIT_WINDOW;
    return { allowed: true, remaining: maxRequests - 1 };
  }
  
  if (limit.count >= maxRequests) {
    return { 
      allowed: false, 
      remaining: 0, 
      resetTime: limit.resetTime,
      retryAfter: Math.ceil((limit.resetTime - now) / 1000)
    };
  }
  
  limit.count++;
  return { allowed: true, remaining: maxRequests - limit.count };
}

/**
 * Input sanitization functions
 */
export const sanitize = {
  // Remove SQL injection attempts
  sql(input) {
    if (typeof input !== 'string') return input;
    return input
      .replace(/['";\\]/g, '')
      .replace(/--/g, '')
      .replace(/\/\*/g, '')
      .replace(/\*\//g, '')
      .replace(/xp_/gi, '')
      .replace(/script/gi, '');
  },
  
  // Remove XSS attempts
  html(input) {
    if (typeof input !== 'string') return input;
    return input
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  },
  
  // Validate and sanitize wallet addresses
  wallet(address, currency) {
    if (typeof address !== 'string') return null;
    
    // Remove whitespace and convert to appropriate case
    address = address.trim();
    
    // Currency-specific validation
    const validators = {
      BTC: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/,
      ETH: /^0x[a-fA-F0-9]{40}$/,
      RVN: /^R[a-km-zA-HJ-NP-Z1-9]{33}$/,
      XMR: /^4[0-9AB][0-9a-zA-Z]{93}$/,
      LTC: /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$|^ltc1[a-z0-9]{39,59}$/,
      ETC: /^0x[a-fA-F0-9]{40}$/,
      DOGE: /^D{1}[5-9A-HJ-NP-U]{1}[1-9A-HJ-NP-Za-km-z]{32}$/,
      ZEC: /^t1[a-km-zA-HJ-NP-Z1-9]{33}$/,
      DASH: /^X[a-km-zA-HJ-NP-Z1-9]{33}$/,
      ERGO: /^9[a-km-zA-HJ-NP-Z1-9]{50,}$/,
      BEAM: /^[0-9a-f]{64,}$/,
      FLUX: /^t1[a-km-zA-HJ-NP-Z1-9]{33}$/,
      KAS: /^kaspa:[a-z0-9]{61,}$/
    };
    
    if (currency && validators[currency]) {
      return validators[currency].test(address) ? address : null;
    }
    
    // Generic validation for unknown currencies
    return /^[a-zA-Z0-9]{20,100}$/.test(address) ? address : null;
  },
  
  // Sanitize numeric inputs
  number(input, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const num = parseFloat(input);
    if (isNaN(num)) return null;
    if (num < min || num > max) return null;
    return num;
  },
  
  // Sanitize usernames
  username(input) {
    if (typeof input !== 'string') return null;
    const cleaned = input.trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (cleaned.length < 3 || cleaned.length > 32) return null;
    return cleaned;
  }
};

/**
 * Password hashing and verification
 */
export const password = {
  async hash(plaintext) {
    const result = await crypto.hashPassword(plaintext);
    return result.salt + ':' + result.hash;
  },
  
  async verify(plaintext, stored) {
    const [salt, hash] = stored.split(':');
    return await crypto.verifyPassword(plaintext, hash, salt);
  }
};

/**
 * Session management
 */
export const session = {
  create(userId, metadata = {}) {
    const payload = {
      userId,
      metadata,
      iat: Date.now()
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  },
  
  verify(token) {
    try {
      return jwt.verify(token, JWT_SECRET);
    } catch (error) {
      return null;
    }
  },
  
  refresh(token) {
    const payload = this.verify(token);
    if (!payload) return null;
    delete payload.iat;
    delete payload.exp;
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  }
};

/**
 * CSRF protection
 */
export const csrf = {
  generate(sessionId) {
    const token = crypto.randomBytes(32, 'hex');
    csrfTokens.set(sessionId, token);
    setTimeout(() => csrfTokens.delete(sessionId), 3600000); // 1 hour
    return token;
  },
  
  verify(sessionId, token) {
    const stored = csrfTokens.get(sessionId);
    return stored && stored === token;
  }
};

/**
 * Security headers middleware
 */
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self' wss: https:;"
  );
  if (next) next();
}

/**
 * API Key Management
 */
export const apiKey = {
  generate(userId, permissions = []) {
    const key = crypto.generateApiKey('otedama_', 32);
    apiKeys.set(key, {
      userId,
      permissions,
      created: Date.now(),
      lastUsed: null
    });
    return key;
  },
  
  verify(key) {
    const keyData = apiKeys.get(key);
    if (!keyData) return null;
    keyData.lastUsed = Date.now();
    return keyData;
  },
  
  revoke(key) {
    return apiKeys.delete(key);
  }
};

/**
 * Request signing
 */
export const signing = {
  sign(payload, secret) {
    const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return crypto.hmacSha256(message, secret);
  },
  
  verify(payload, signature, secret) {
    const expected = this.sign(payload, secret);
    return crypto.timingSafeEqual(expected, signature);
  }
};

/**
 * IP filtering
 */
export const IPFilter = {
  addToWhitelist(ip) {
    ipWhitelist.add(ip);
  },
  
  addToBlacklist(ip) {
    ipBlacklist.add(ip);
  },
  
  removeFromWhitelist(ip) {
    ipWhitelist.delete(ip);
  },
  
  removeFromBlacklist(ip) {
    ipBlacklist.delete(ip);
  },
  
  check(ip) {
    if (ipBlacklist.has(ip)) return { allowed: false, reason: 'blacklisted' };
    if (ipWhitelist.size > 0 && !ipWhitelist.has(ip)) {
      return { allowed: false, reason: 'not whitelisted' };
    }
    return { allowed: true };
  }
};

/**
 * Audit logger
 */
export class AuditLogger {
  constructor(db) {
    this.db = db || new Database();
    this.initDatabase();
  }
  
  initDatabase() {
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        userId TEXT,
        action TEXT NOT NULL,
        resource TEXT,
        ip TEXT,
        userAgent TEXT,
        success INTEGER,
        details TEXT,
        INDEX idx_timestamp (timestamp),
        INDEX idx_userId (userId),
        INDEX idx_action (action)
      )
    `).run();
  }
  
  log(entry) {
    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (timestamp, userId, action, resource, ip, userAgent, success, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      Date.now(),
      entry.userId || null,
      entry.action,
      entry.resource || null,
      entry.ip || null,
      entry.userAgent || null,
      entry.success ? 1 : 0,
      JSON.stringify(entry.details || {})
    );
  }
  
  query(filters = {}) {
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    
    if (filters.userId) {
      query += ' AND userId = ?';
      params.push(filters.userId);
    }
    
    if (filters.action) {
      query += ' AND action = ?';
      params.push(filters.action);
    }
    
    if (filters.startTime) {
      query += ' AND timestamp >= ?';
      params.push(filters.startTime);
    }
    
    if (filters.endTime) {
      query += ' AND timestamp <= ?';
      params.push(filters.endTime);
    }
    
    query += ' ORDER BY timestamp DESC LIMIT 1000';
    
    return this.db.prepare(query).all(...params);
  }
}

/**
 * Two-factor authentication
 */
export const twoFactor = {
  generateSecret(userId) {
    return authenticator.generateSecret();
  },
  
  generateQRCode(userId, secret, issuer = 'Otedama') {
    return authenticator.keyuri(userId, issuer, secret);
  },
  
  verify(token, secret) {
    return authenticator.verify({ token, secret });
  }
};