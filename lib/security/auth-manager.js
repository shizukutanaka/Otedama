/**
 * Authentication Manager for Otedama
 * JWT-based authentication with refresh tokens
 * 
 * Design:
 * - Carmack: Fast token validation
 * - Martin: Clean auth architecture
 * - Pike: Simple but secure authentication
 */

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';
import { StorageManager } from '../storage/index.js';

const logger = createStructuredLogger('AuthManager');

// Auth constants
const DEFAULT_ACCESS_TOKEN_EXPIRY = '15m';
const DEFAULT_REFRESH_TOKEN_EXPIRY = '7d';
const DEFAULT_API_KEY_LENGTH = 32;

/**
 * Token store for refresh tokens
 */
class TokenStore {
  constructor(storage) {
    this.storage = storage;
    this.cache = new Map();
  }
  
  async initialize() {
    await this.storage.createTable('refresh_tokens', {
      id: 'TEXT PRIMARY KEY',
      userId: 'TEXT NOT NULL',
      token: 'TEXT NOT NULL',
      createdAt: 'INTEGER NOT NULL',
      expiresAt: 'INTEGER NOT NULL',
      lastUsed: 'INTEGER',
      userAgent: 'TEXT',
      ip: 'TEXT',
      INDEX: ['userId', 'token', 'expiresAt']
    });
    
    await this.storage.createTable('api_keys', {
      id: 'TEXT PRIMARY KEY',
      key: 'TEXT UNIQUE NOT NULL',
      userId: 'TEXT NOT NULL',
      name: 'TEXT',
      permissions: 'TEXT',
      createdAt: 'INTEGER NOT NULL',
      lastUsed: 'INTEGER',
      usageCount: 'INTEGER DEFAULT 0',
      active: 'INTEGER DEFAULT 1',
      INDEX: ['key', 'userId', 'active']
    });
  }
  
  async storeRefreshToken(userId, token, expiresIn, metadata = {}) {
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + this.parseExpiry(expiresIn);
    
    await this.storage.insert('refresh_tokens', {
      id,
      userId,
      token,
      createdAt: now,
      expiresAt,
      userAgent: metadata.userAgent,
      ip: metadata.ip
    });
    
    // Cache for quick lookup
    this.cache.set(token, {
      id,
      userId,
      expiresAt
    });
    
    return id;
  }
  
  async validateRefreshToken(token) {
    // Check cache first
    const cached = this.cache.get(token);
    if (cached) {
      if (Date.now() < cached.expiresAt) {
        return cached;
      } else {
        this.cache.delete(token);
      }
    }
    
    // Check database
    const result = await this.storage.query(
      'SELECT * FROM refresh_tokens WHERE token = ? AND expiresAt > ?',
      [token, Date.now()]
    );
    
    if (result.length === 0) {
      return null;
    }
    
    const tokenData = result[0];
    
    // Update last used
    await this.storage.query(
      'UPDATE refresh_tokens SET lastUsed = ? WHERE id = ?',
      [Date.now(), tokenData.id]
    );
    
    // Cache it
    this.cache.set(token, {
      id: tokenData.id,
      userId: tokenData.userId,
      expiresAt: tokenData.expiresAt
    });
    
    return tokenData;
  }
  
  async revokeRefreshToken(token) {
    this.cache.delete(token);
    
    await this.storage.query(
      'DELETE FROM refresh_tokens WHERE token = ?',
      [token]
    );
  }
  
  async revokeUserTokens(userId) {
    // Clear from cache
    for (const [token, data] of this.cache) {
      if (data.userId === userId) {
        this.cache.delete(token);
      }
    }
    
    // Delete from database
    await this.storage.query(
      'DELETE FROM refresh_tokens WHERE userId = ?',
      [userId]
    );
  }
  
  async cleanupExpiredTokens() {
    const deleted = await this.storage.query(
      'DELETE FROM refresh_tokens WHERE expiresAt < ?',
      [Date.now()]
    );
    
    // Clean cache
    for (const [token, data] of this.cache) {
      if (Date.now() > data.expiresAt) {
        this.cache.delete(token);
      }
    }
    
    return deleted.changes;
  }
  
  parseExpiry(expiry) {
    if (typeof expiry === 'number') {
      return expiry;
    }
    
    const match = expiry.match(/^(\d+)([smhd])$/);
    if (!match) {
      throw new Error('Invalid expiry format');
    }
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    const multipliers = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000
    };
    
    return value * multipliers[unit];
  }
}

/**
 * API key manager
 */
class APIKeyManager {
  constructor(storage) {
    this.storage = storage;
    this.cache = new Map();
  }
  
  async generateAPIKey(userId, name = null, permissions = []) {
    const id = crypto.randomUUID();
    const key = crypto.randomBytes(DEFAULT_API_KEY_LENGTH).toString('hex');
    
    await this.storage.insert('api_keys', {
      id,
      key,
      userId,
      name,
      permissions: JSON.stringify(permissions),
      createdAt: Date.now()
    });
    
    // Cache it
    this.cache.set(key, {
      id,
      userId,
      permissions,
      active: true
    });
    
    return { id, key };
  }
  
  async validateAPIKey(key) {
    // Check cache
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached.active ? cached : null;
    }
    
    // Check database
    const result = await this.storage.query(
      'SELECT * FROM api_keys WHERE key = ? AND active = 1',
      [key]
    );
    
    if (result.length === 0) {
      this.cache.set(key, { active: false });
      return null;
    }
    
    const keyData = result[0];
    
    // Update usage
    await this.storage.query(
      'UPDATE api_keys SET lastUsed = ?, usageCount = usageCount + 1 WHERE id = ?',
      [Date.now(), keyData.id]
    );
    
    // Cache it
    const data = {
      id: keyData.id,
      userId: keyData.userId,
      permissions: JSON.parse(keyData.permissions || '[]'),
      active: true
    };
    
    this.cache.set(key, data);
    
    return data;
  }
  
  async revokeAPIKey(key) {
    this.cache.delete(key);
    
    await this.storage.query(
      'UPDATE api_keys SET active = 0 WHERE key = ?',
      [key]
    );
  }
  
  async listUserAPIKeys(userId) {
    return await this.storage.query(
      'SELECT id, name, permissions, createdAt, lastUsed, usageCount FROM api_keys WHERE userId = ? AND active = 1',
      [userId]
    );
  }
}

/**
 * Authentication Manager
 */
export class AuthManager {
  constructor(config = {}) {
    this.config = {
      accessTokenSecret: config.accessTokenSecret || crypto.randomBytes(64).toString('hex'),
      refreshTokenSecret: config.refreshTokenSecret || crypto.randomBytes(64).toString('hex'),
      accessTokenExpiry: config.accessTokenExpiry || DEFAULT_ACCESS_TOKEN_EXPIRY,
      refreshTokenExpiry: config.refreshTokenExpiry || DEFAULT_REFRESH_TOKEN_EXPIRY,
      issuer: config.issuer || 'otedama',
      audience: config.audience || 'otedama-pool',
      ...config
    };
    
    // Storage
    this.storage = new StorageManager({
      dbFile: config.dbFile || 'auth.db'
    });
    
    // Components
    this.tokenStore = new TokenStore(this.storage);
    this.apiKeyManager = new APIKeyManager(this.storage);
    
    // Cleanup interval
    this.cleanupInterval = null;
    
    this.logger = createStructuredLogger('AuthManager');
  }
  
  /**
   * Initialize auth manager
   */
  async initialize() {
    await this.storage.initialize();
    await this.tokenStore.initialize();
    
    // Start cleanup task
    this.cleanupInterval = setInterval(() => {
      this.tokenStore.cleanupExpiredTokens()
        .then(count => {
          if (count > 0) {
            this.logger.info('Cleaned up expired tokens', { count });
          }
        })
        .catch(error => {
          this.logger.error('Token cleanup failed', error);
        });
    }, 3600000); // Every hour
    
    this.logger.info('Auth manager initialized');
  }
  
  /**
   * Generate tokens for user
   */
  async generateTokens(userId, claims = {}) {
    const payload = {
      sub: userId,
      iss: this.config.issuer,
      aud: this.config.audience,
      ...claims
    };
    
    // Generate access token
    const accessToken = jwt.sign(
      payload,
      this.config.accessTokenSecret,
      {
        expiresIn: this.config.accessTokenExpiry
      }
    );
    
    // Generate refresh token
    const refreshPayload = {
      sub: userId,
      type: 'refresh',
      jti: crypto.randomUUID()
    };
    
    const refreshToken = jwt.sign(
      refreshPayload,
      this.config.refreshTokenSecret,
      {
        expiresIn: this.config.refreshTokenExpiry
      }
    );
    
    // Store refresh token
    await this.tokenStore.storeRefreshToken(
      userId,
      refreshToken,
      this.config.refreshTokenExpiry,
      claims.metadata
    );
    
    return {
      accessToken,
      refreshToken,
      expiresIn: this.tokenStore.parseExpiry(this.config.accessTokenExpiry)
    };
  }
  
  /**
   * Verify access token
   */
  verifyAccessToken(token) {
    try {
      const payload = jwt.verify(token, this.config.accessTokenSecret, {
        issuer: this.config.issuer,
        audience: this.config.audience
      });
      
      return {
        valid: true,
        userId: payload.sub,
        claims: payload
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message
      };
    }
  }
  
  /**
   * Refresh access token
   */
  async refreshAccessToken(refreshToken) {
    // Verify refresh token format
    let payload;
    try {
      payload = jwt.verify(refreshToken, this.config.refreshTokenSecret);
    } catch (error) {
      throw new Error('Invalid refresh token');
    }
    
    // Validate in store
    const tokenData = await this.tokenStore.validateRefreshToken(refreshToken);
    if (!tokenData) {
      throw new Error('Refresh token not found or expired');
    }
    
    // Generate new access token
    const accessToken = jwt.sign(
      {
        sub: tokenData.userId,
        iss: this.config.issuer,
        aud: this.config.audience
      },
      this.config.accessTokenSecret,
      {
        expiresIn: this.config.accessTokenExpiry
      }
    );
    
    return {
      accessToken,
      expiresIn: this.tokenStore.parseExpiry(this.config.accessTokenExpiry)
    };
  }
  
  /**
   * Revoke refresh token
   */
  async revokeRefreshToken(refreshToken) {
    await this.tokenStore.revokeRefreshToken(refreshToken);
  }
  
  /**
   * Revoke all user tokens
   */
  async revokeUserTokens(userId) {
    await this.tokenStore.revokeUserTokens(userId);
  }
  
  /**
   * Generate API key
   */
  async generateAPIKey(userId, name = null, permissions = []) {
    return await this.apiKeyManager.generateAPIKey(userId, name, permissions);
  }
  
  /**
   * Validate API key
   */
  async validateAPIKey(key) {
    return await this.apiKeyManager.validateAPIKey(key);
  }
  
  /**
   * Revoke API key
   */
  async revokeAPIKey(key) {
    await this.apiKeyManager.revokeAPIKey(key);
  }
  
  /**
   * List user API keys
   */
  async listUserAPIKeys(userId) {
    return await this.apiKeyManager.listUserAPIKeys(userId);
  }
  
  /**
   * Express middleware for JWT authentication
   */
  authenticate(requiredRole = null) {
    return async (req, res, next) => {
      const token = this.extractToken(req);
      
      if (!token) {
        return res.status(401).json({
          error: 'No token provided'
        });
      }
      
      const result = this.verifyAccessToken(token);
      
      if (!result.valid) {
        return res.status(401).json({
          error: 'Invalid token',
          details: result.error
        });
      }
      
      // Check role if required
      if (requiredRole && result.claims.role !== requiredRole) {
        return res.status(403).json({
          error: 'Insufficient permissions'
        });
      }
      
      // Attach user info to request
      req.user = {
        id: result.userId,
        ...result.claims
      };
      
      next();
    };
  }
  
  /**
   * Express middleware for API key authentication
   */
  authenticateAPIKey(requiredPermissions = []) {
    return async (req, res, next) => {
      const apiKey = req.get('X-API-Key') || req.query.apiKey;
      
      if (!apiKey) {
        return res.status(401).json({
          error: 'No API key provided'
        });
      }
      
      const keyData = await this.validateAPIKey(apiKey);
      
      if (!keyData) {
        return res.status(401).json({
          error: 'Invalid API key'
        });
      }
      
      // Check permissions
      if (requiredPermissions.length > 0) {
        const hasPermission = requiredPermissions.every(perm => 
          keyData.permissions.includes(perm)
        );
        
        if (!hasPermission) {
          return res.status(403).json({
            error: 'Insufficient permissions'
          });
        }
      }
      
      // Attach user info to request
      req.user = {
        id: keyData.userId,
        apiKeyId: keyData.id,
        permissions: keyData.permissions
      };
      
      next();
    };
  }
  
  /**
   * Extract token from request
   */
  extractToken(req) {
    // Check Authorization header
    const authHeader = req.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    
    // Check query parameter
    if (req.query.token) {
      return req.query.token;
    }
    
    // Check cookie
    if (req.cookies && req.cookies.token) {
      return req.cookies.token;
    }
    
    return null;
  }
  
  /**
   * Shutdown auth manager
   */
  async shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    await this.storage.close();
    
    this.logger.info('Auth manager shut down');
  }
}

// Export components
export {
  TokenStore,
  APIKeyManager
};

export default AuthManager;