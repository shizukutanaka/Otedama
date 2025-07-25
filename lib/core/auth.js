/**
 * Authentication System - Otedama
 * JWT-based authentication and authorization
 * 
 * Design: Secure by default (Martin)
 */

import crypto from 'crypto';
import { promisify } from 'util';
import { AuthenticationError, AuthorizationError } from './errors.js';
import { createLogger } from './logger.js';
import { validator, Rules, Sanitizers } from './validator.js';

const logger = createLogger('Auth');

/**
 * JWT implementation (simplified)
 */
export class JWT {
  constructor(secret, options = {}) {
    this.secret = secret;
    this.options = {
      algorithm: options.algorithm || 'HS256',
      expiresIn: options.expiresIn || '1h',
      issuer: options.issuer || 'otedama',
      audience: options.audience || 'otedama-api',
      ...options
    };
  }
  
  sign(payload) {
    const header = {
      alg: this.options.algorithm,
      typ: 'JWT'
    };
    
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = this.parseExpiration(this.options.expiresIn);
    
    const claims = {
      ...payload,
      iat: now,
      exp: now + expiresIn,
      iss: this.options.issuer,
      aud: this.options.audience
    };
    
    const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
    const encodedPayload = this.base64UrlEncode(JSON.stringify(claims));
    
    const signature = this.createSignature(encodedHeader, encodedPayload);
    
    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }
  
  verify(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        throw new AuthenticationError('Invalid token format');
      }
      
      const [encodedHeader, encodedPayload, signature] = parts;
      
      // Verify signature
      const expectedSignature = this.createSignature(encodedHeader, encodedPayload);
      if (signature !== expectedSignature) {
        throw new AuthenticationError('Invalid signature');
      }
      
      // Decode payload
      const payload = JSON.parse(this.base64UrlDecode(encodedPayload));
      
      // Verify claims
      const now = Math.floor(Date.now() / 1000);
      
      if (payload.exp && payload.exp < now) {
        throw new AuthenticationError('Token expired');
      }
      
      if (payload.nbf && payload.nbf > now) {
        throw new AuthenticationError('Token not yet valid');
      }
      
      if (payload.iss && payload.iss !== this.options.issuer) {
        throw new AuthenticationError('Invalid issuer');
      }
      
      if (payload.aud && payload.aud !== this.options.audience) {
        throw new AuthenticationError('Invalid audience');
      }
      
      return payload;
      
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      }
      throw new AuthenticationError('Token verification failed');
    }
  }
  
  refresh(token) {
    const payload = this.verify(token);
    
    // Remove old claims
    delete payload.iat;
    delete payload.exp;
    delete payload.nbf;
    
    // Sign new token
    return this.sign(payload);
  }
  
  createSignature(header, payload) {
    const data = `${header}.${payload}`;
    const hmac = crypto.createHmac('sha256', this.secret);
    hmac.update(data);
    return this.base64UrlEncode(hmac.digest());
  }
  
  base64UrlEncode(data) {
    const base64 = Buffer.isBuffer(data) 
      ? data.toString('base64')
      : Buffer.from(data).toString('base64');
    
    return base64
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }
  
  base64UrlDecode(data) {
    data += '='.repeat((4 - data.length % 4) % 4);
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf8');
  }
  
  parseExpiration(exp) {
    if (typeof exp === 'number') return exp;
    
    const match = exp.match(/^(\d+)([smhd])$/);
    if (!match) {
      throw new Error('Invalid expiration format');
    }
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    switch (unit) {
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 3600;
      case 'd': return value * 86400;
      default: throw new Error('Invalid time unit');
    }
  }
}

/**
 * Password hasher using bcrypt-like algorithm
 */
export class PasswordHasher {
  constructor(options = {}) {
    this.options = {
      saltRounds: options.saltRounds || 10,
      algorithm: options.algorithm || 'sha256',
      ...options
    };
  }
  
  async hash(password) {
    // Generate salt
    const salt = crypto.randomBytes(16);
    
    // Hash password with salt
    const hash = await this.pbkdf2(
      password,
      salt,
      Math.pow(2, this.options.saltRounds),
      32
    );
    
    // Format: $algorithm$rounds$salt$hash
    return `$${this.options.algorithm}$${this.options.saltRounds}$${salt.toString('base64')}$${hash.toString('base64')}`;
  }
  
  async verify(password, hashedPassword) {
    const parts = hashedPassword.split('$').filter(Boolean);
    if (parts.length !== 4) {
      return false;
    }
    
    const [algorithm, rounds, saltBase64, hashBase64] = parts;
    
    const salt = Buffer.from(saltBase64, 'base64');
    const expectedHash = Buffer.from(hashBase64, 'base64');
    
    const hash = await this.pbkdf2(
      password,
      salt,
      Math.pow(2, parseInt(rounds)),
      expectedHash.length
    );
    
    return crypto.timingSafeEqual(hash, expectedHash);
  }
  
  async pbkdf2(password, salt, iterations, keylen) {
    return promisify(crypto.pbkdf2)(
      password,
      salt,
      iterations,
      keylen,
      this.options.algorithm
    );
  }
}

/**
 * Session manager
 */
export class SessionManager {
  constructor(storage, options = {}) {
    this.storage = storage;
    this.options = {
      ttl: options.ttl || 3600, // 1 hour
      prefix: options.prefix || 'session:',
      ...options
    };
    
    this.sessions = new Map();
  }
  
  async create(userId, data = {}) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    
    const session = {
      id: sessionId,
      userId,
      data,
      createdAt: Date.now(),
      expiresAt: Date.now() + (this.options.ttl * 1000)
    };
    
    // Store in memory
    this.sessions.set(sessionId, session);
    
    // Store in persistent storage
    if (this.storage) {
      await this.storage.set(
        `${this.options.prefix}${sessionId}`,
        session,
        this.options.ttl
      );
    }
    
    return sessionId;
  }
  
  async get(sessionId) {
    // Check memory first
    let session = this.sessions.get(sessionId);
    
    if (!session && this.storage) {
      // Check persistent storage
      session = await this.storage.get(`${this.options.prefix}${sessionId}`);
      
      if (session) {
        this.sessions.set(sessionId, session);
      }
    }
    
    if (!session) {
      return null;
    }
    
    // Check expiration
    if (session.expiresAt < Date.now()) {
      await this.destroy(sessionId);
      return null;
    }
    
    return session;
  }
  
  async update(sessionId, data) {
    const session = await this.get(sessionId);
    if (!session) {
      throw new AuthenticationError('Session not found');
    }
    
    // Update data
    session.data = { ...session.data, ...data };
    session.updatedAt = Date.now();
    
    // Update in storage
    if (this.storage) {
      await this.storage.set(
        `${this.options.prefix}${sessionId}`,
        session,
        this.options.ttl
      );
    }
    
    return session;
  }
  
  async destroy(sessionId) {
    this.sessions.delete(sessionId);
    
    if (this.storage) {
      await this.storage.delete(`${this.options.prefix}${sessionId}`);
    }
  }
  
  async destroyUserSessions(userId) {
    const toDestroy = [];
    
    // Find all sessions for user
    for (const [sessionId, session] of this.sessions) {
      if (session.userId === userId) {
        toDestroy.push(sessionId);
      }
    }
    
    // Destroy them
    await Promise.all(toDestroy.map(id => this.destroy(id)));
  }
  
  cleanup() {
    const now = Date.now();
    
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt < now) {
        this.destroy(sessionId);
      }
    }
  }
}

/**
 * API key manager
 */
export class APIKeyManager {
  constructor(storage) {
    this.storage = storage;
    this.keys = new Map();
  }
  
  async generate(userId, permissions = [], metadata = {}) {
    const key = `otedama_${crypto.randomBytes(32).toString('hex')}`;
    const hashedKey = crypto.createHash('sha256').update(key).digest('hex');
    
    const keyData = {
      id: crypto.randomBytes(16).toString('hex'),
      userId,
      hashedKey,
      permissions,
      metadata,
      createdAt: Date.now(),
      lastUsed: null,
      usageCount: 0
    };
    
    // Store
    this.keys.set(hashedKey, keyData);
    
    if (this.storage) {
      await this.storage.set(`apikey:${hashedKey}`, keyData);
    }
    
    // Return the actual key (only shown once)
    return { key, id: keyData.id };
  }
  
  async verify(key) {
    if (!key || !key.startsWith('otedama_')) {
      throw new AuthenticationError('Invalid API key format');
    }
    
    const hashedKey = crypto.createHash('sha256').update(key).digest('hex');
    
    let keyData = this.keys.get(hashedKey);
    
    if (!keyData && this.storage) {
      keyData = await this.storage.get(`apikey:${hashedKey}`);
      
      if (keyData) {
        this.keys.set(hashedKey, keyData);
      }
    }
    
    if (!keyData) {
      throw new AuthenticationError('Invalid API key');
    }
    
    // Update usage
    keyData.lastUsed = Date.now();
    keyData.usageCount++;
    
    if (this.storage) {
      await this.storage.set(`apikey:${hashedKey}`, keyData);
    }
    
    return keyData;
  }
  
  async revoke(keyId) {
    // Find key by ID
    let hashedKey = null;
    
    for (const [hash, data] of this.keys) {
      if (data.id === keyId) {
        hashedKey = hash;
        break;
      }
    }
    
    if (hashedKey) {
      this.keys.delete(hashedKey);
      
      if (this.storage) {
        await this.storage.delete(`apikey:${hashedKey}`);
      }
      
      return true;
    }
    
    return false;
  }
  
  async listUserKeys(userId) {
    const keys = [];
    
    for (const keyData of this.keys.values()) {
      if (keyData.userId === userId) {
        keys.push({
          id: keyData.id,
          permissions: keyData.permissions,
          metadata: keyData.metadata,
          createdAt: keyData.createdAt,
          lastUsed: keyData.lastUsed,
          usageCount: keyData.usageCount
        });
      }
    }
    
    return keys;
  }
}

/**
 * Auth middleware factory
 */
export class AuthMiddleware {
  constructor(options = {}) {
    this.options = options;
    this.jwt = options.jwt;
    this.sessionManager = options.sessionManager;
    this.apiKeyManager = options.apiKeyManager;
  }
  
  /**
   * JWT authentication middleware
   */
  jwt(options = {}) {
    const { required = true } = options;
    
    return async (req, res, next) => {
      try {
        const token = this.extractToken(req);
        
        if (!token) {
          if (required) {
            throw new AuthenticationError('No token provided');
          }
          return next();
        }
        
        const payload = this.jwt.verify(token);
        req.user = payload;
        
        next();
      } catch (error) {
        if (error instanceof AuthenticationError) {
          res.status(401).json({
            error: {
              message: error.message,
              code: 'AUTHENTICATION_FAILED'
            }
          });
        } else {
          next(error);
        }
      }
    };
  }
  
  /**
   * Session authentication middleware
   */
  session(options = {}) {
    const { required = true } = options;
    
    return async (req, res, next) => {
      try {
        const sessionId = req.cookies?.sessionId || req.headers['x-session-id'];
        
        if (!sessionId) {
          if (required) {
            throw new AuthenticationError('No session');
          }
          return next();
        }
        
        const session = await this.sessionManager.get(sessionId);
        
        if (!session) {
          if (required) {
            throw new AuthenticationError('Invalid session');
          }
          return next();
        }
        
        req.session = session;
        req.user = { id: session.userId };
        
        next();
      } catch (error) {
        if (error instanceof AuthenticationError) {
          res.status(401).json({
            error: {
              message: error.message,
              code: 'AUTHENTICATION_FAILED'
            }
          });
        } else {
          next(error);
        }
      }
    };
  }
  
  /**
   * API key authentication middleware
   */
  apiKey(options = {}) {
    const { required = true } = options;
    
    return async (req, res, next) => {
      try {
        const apiKey = req.headers['x-api-key'];
        
        if (!apiKey) {
          if (required) {
            throw new AuthenticationError('No API key provided');
          }
          return next();
        }
        
        const keyData = await this.apiKeyManager.verify(apiKey);
        
        req.apiKey = keyData;
        req.user = { id: keyData.userId };
        
        next();
      } catch (error) {
        if (error instanceof AuthenticationError) {
          res.status(401).json({
            error: {
              message: error.message,
              code: 'AUTHENTICATION_FAILED'
            }
          });
        } else {
          next(error);
        }
      }
    };
  }
  
  /**
   * Permission check middleware
   */
  requirePermission(permission) {
    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({
          error: {
            message: 'Authentication required',
            code: 'AUTHENTICATION_REQUIRED'
          }
        });
      }
      
      const hasPermission = 
        (req.user.permissions && req.user.permissions.includes(permission)) ||
        (req.apiKey && req.apiKey.permissions.includes(permission));
      
      if (!hasPermission) {
        return res.status(403).json({
          error: {
            message: 'Insufficient permissions',
            code: 'PERMISSION_DENIED',
            required: permission
          }
        });
      }
      
      next();
    };
  }
  
  extractToken(req) {
    // Bearer token
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    
    // Query parameter
    if (req.query.token) {
      return req.query.token;
    }
    
    // Cookie
    if (req.cookies?.token) {
      return req.cookies.token;
    }
    
    return null;
  }
}

export default {
  JWT,
  PasswordHasher,
  SessionManager,
  APIKeyManager,
  AuthMiddleware
};
