/**
 * Enterprise Authentication System - Otedama
 * Multi-factor authentication with enterprise SSO integration
 * 
 * Design principles:
 * - Carmack: Fast authentication with minimal latency
 * - Martin: Clean separation of authentication providers
 * - Pike: Simple API for complex auth flows
 */

import { EventEmitter } from 'events';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes, pbkdf2 } from 'crypto';
import { promisify } from 'util';
import { createStructuredLogger } from '../core/structured-logger.js';
import { UnifiedRateLimiter } from '../security/rate-limit-unified.js';
import speakeasy from 'speakeasy';
import qrcode from 'qrcode';

const logger = createStructuredLogger('EnterpriseAuthentication');
const pbkdf2Async = promisify(pbkdf2);

/**
 * Authentication methods
 */
export const AuthMethod = {
  PASSWORD: 'password',
  TWO_FACTOR: '2fa',
  SSO_SAML: 'saml',
  SSO_OAUTH: 'oauth',
  CERTIFICATE: 'certificate',
  BIOMETRIC: 'biometric',
  ZERO_KNOWLEDGE: 'zkp',
  HARDWARE_TOKEN: 'hardware_token'
};

/**
 * Authentication levels
 */
export const AuthLevel = {
  NONE: 0,
  BASIC: 1,
  STANDARD: 2,
  ENHANCED: 3,
  MAXIMUM: 4
};

/**
 * Session types
 */
export const SessionType = {
  WEB: 'web',
  API: 'api',
  MOBILE: 'mobile',
  CLI: 'cli',
  SERVICE: 'service'
};

/**
 * Enterprise Authentication System
 */
export class EnterpriseAuthentication extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // JWT settings
      jwtSecret: config.jwtSecret || process.env.JWT_SECRET || randomBytes(32).toString('hex'),
      jwtExpiry: config.jwtExpiry || '24h',
      refreshTokenExpiry: config.refreshTokenExpiry || '30d',
      
      // Password policy
      passwordMinLength: config.passwordMinLength || 12,
      passwordRequireUppercase: config.passwordRequireUppercase !== false,
      passwordRequireLowercase: config.passwordRequireLowercase !== false,
      passwordRequireNumbers: config.passwordRequireNumbers !== false,
      passwordRequireSymbols: config.passwordRequireSymbols !== false,
      passwordHistory: config.passwordHistory || 5,
      
      // 2FA settings
      tfaIssuer: config.tfaIssuer || 'Otedama Mining Pool',
      tfaWindow: config.tfaWindow || 2,
      
      // Session settings
      sessionTimeout: config.sessionTimeout || 3600000, // 1 hour
      maxConcurrentSessions: config.maxConcurrentSessions || 5,
      
      // Security settings
      maxLoginAttempts: config.maxLoginAttempts || 5,
      lockoutDuration: config.lockoutDuration || 900000, // 15 minutes
      requireMFA: config.requireMFA || false,
      
      // SSO settings
      ssoProviders: config.ssoProviders || [],
      
      ...config
    };
    
    this.sessions = new Map();
    this.users = new Map();
    this.refreshTokens = new Map();
    this.loginAttempts = new Map();
    this.passwordHistory = new Map();
    
    this.rateLimiter = new UnifiedRateLimiter({
      keyPrefix: 'auth',
      defaultTier: {
        points: 10,
        duration: 60,
        blockDuration: 300
      }
    });
    
    this.initialize();
  }
  
  /**
   * Initialize authentication system
   */
  async initialize() {
    try {
      // Initialize SSO providers
      await this.initializeSSOProviders();
      
      // Start session cleanup
      this.startSessionCleanup();
      
      logger.info('Enterprise authentication system initialized', {
        requireMFA: this.config.requireMFA,
        ssoProviders: this.config.ssoProviders.length
      });
      
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Failed to initialize authentication system', { error });
      throw error;
    }
  }
  
  /**
   * Initialize SSO providers
   */
  async initializeSSOProviders() {
    // Initialize SAML, OAuth, etc.
    // This would integrate with actual SSO providers
    for (const provider of this.config.ssoProviders) {
      logger.info('SSO provider configured', { provider: provider.name });
    }
  }
  
  /**
   * Register new user
   */
  async register(userData) {
    const { username, password, email, requireMFA = this.config.requireMFA } = userData;
    
    // Validate username
    if (!this.validateUsername(username)) {
      throw new Error('Invalid username format');
    }
    
    // Check if user exists
    if (this.users.has(username)) {
      throw new Error('Username already exists');
    }
    
    // Validate password
    const passwordValidation = this.validatePassword(password);
    if (!passwordValidation.valid) {
      throw new Error(`Password validation failed: ${passwordValidation.errors.join(', ')}`);
    }
    
    // Hash password
    const salt = randomBytes(32).toString('hex');
    const hashedPassword = await this.hashPassword(password, salt);
    
    // Generate user ID
    const userId = randomBytes(16).toString('hex');
    
    // Create user
    const user = {
      id: userId,
      username,
      email,
      password: hashedPassword,
      salt,
      requireMFA,
      mfaSecret: null,
      createdAt: new Date(),
      lastLogin: null,
      loginCount: 0,
      locked: false,
      roles: ['user'],
      permissions: [],
      metadata: {}
    };
    
    // Setup 2FA if required
    if (requireMFA) {
      const mfaSetup = await this.setupTwoFactor(userId);
      user.mfaSecret = mfaSetup.secret;
      
      // Return QR code for setup
      userData.mfaQRCode = mfaSetup.qrCode;
    }
    
    // Store user
    this.users.set(username, user);
    
    // Initialize password history
    this.passwordHistory.set(userId, [hashedPassword]);
    
    logger.info('User registered', {
      userId,
      username,
      requireMFA
    });
    
    this.emit('userRegistered', { userId, username });
    
    return {
      userId,
      username,
      requireMFA,
      mfaQRCode: userData.mfaQRCode
    };
  }
  
  /**
   * Authenticate user
   */
  async authenticate(credentials, options = {}) {
    const { method = AuthMethod.PASSWORD } = options;
    
    // Rate limiting
    const rateLimitKey = credentials.username || credentials.clientId || 'anonymous';
    const rateLimitResult = await this.rateLimiter.checkLimit(rateLimitKey);
    
    if (!rateLimitResult.allowed) {
      throw new Error('Too many authentication attempts');
    }
    
    try {
      let result;
      
      switch (method) {
        case AuthMethod.PASSWORD:
          result = await this.authenticatePassword(credentials);
          break;
          
        case AuthMethod.TWO_FACTOR:
          result = await this.authenticateTwoFactor(credentials);
          break;
          
        case AuthMethod.SSO_SAML:
          result = await this.authenticateSAML(credentials);
          break;
          
        case AuthMethod.SSO_OAUTH:
          result = await this.authenticateOAuth(credentials);
          break;
          
        case AuthMethod.CERTIFICATE:
          result = await this.authenticateCertificate(credentials);
          break;
          
        case AuthMethod.ZERO_KNOWLEDGE:
          result = await this.authenticateZKP(credentials);
          break;
          
        default:
          throw new Error(`Unsupported authentication method: ${method}`);
      }
      
      // Create session
      const session = await this.createSession(result.userId, {
        authMethod: method,
        authLevel: result.authLevel,
        sessionType: options.sessionType || SessionType.WEB
      });
      
      logger.info('Authentication successful', {
        userId: result.userId,
        method,
        sessionId: session.id
      });
      
      this.emit('authenticationSuccess', {
        userId: result.userId,
        method,
        sessionId: session.id
      });
      
      return session;
      
    } catch (error) {
      // Track failed attempts
      this.trackFailedAttempt(rateLimitKey);
      
      logger.warn('Authentication failed', {
        method,
        error: error.message
      });
      
      this.emit('authenticationFailed', {
        method,
        error: error.message
      });
      
      throw error;
    }
  }
  
  /**
   * Authenticate with password
   */
  async authenticatePassword(credentials) {
    const { username, password } = credentials;
    
    // Get user
    const user = this.users.get(username);
    if (!user) {
      throw new Error('Invalid credentials');
    }
    
    // Check if account is locked
    if (user.locked) {
      throw new Error('Account is locked');
    }
    
    // Verify password
    const hashedPassword = await this.hashPassword(password, user.salt);
    if (hashedPassword !== user.password) {
      throw new Error('Invalid credentials');
    }
    
    // Check if 2FA is required
    let authLevel = AuthLevel.BASIC;
    if (user.requireMFA && !credentials.mfaCode) {
      throw new Error('2FA code required');
    }
    
    // Verify 2FA if provided
    if (credentials.mfaCode) {
      const mfaValid = this.verifyTwoFactorCode(user.mfaSecret, credentials.mfaCode);
      if (!mfaValid) {
        throw new Error('Invalid 2FA code');
      }
      authLevel = AuthLevel.STANDARD;
    }
    
    // Update login info
    user.lastLogin = new Date();
    user.loginCount++;
    
    return {
      userId: user.id,
      username: user.username,
      authLevel,
      roles: user.roles,
      permissions: user.permissions
    };
  }
  
  /**
   * Setup two-factor authentication
   */
  async setupTwoFactor(userId) {
    // Generate secret
    const secret = speakeasy.generateSecret({
      name: this.config.tfaIssuer,
      length: 32
    });
    
    // Generate QR code
    const qrCode = await qrcode.toDataURL(secret.otpauth_url);
    
    return {
      secret: secret.base32,
      qrCode
    };
  }
  
  /**
   * Verify two-factor code
   */
  verifyTwoFactorCode(secret, code) {
    if (!secret || !code) return false;
    
    return speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: code,
      window: this.config.tfaWindow
    });
  }
  
  /**
   * Create session
   */
  async createSession(userId, options = {}) {
    // Check concurrent sessions
    const userSessions = Array.from(this.sessions.values())
      .filter(s => s.userId === userId && !s.expired);
    
    if (userSessions.length >= this.config.maxConcurrentSessions) {
      // Expire oldest session
      const oldestSession = userSessions.sort((a, b) => a.createdAt - b.createdAt)[0];
      await this.revokeSession(oldestSession.id);
    }
    
    // Generate tokens
    const sessionId = randomBytes(32).toString('hex');
    const accessToken = this.generateAccessToken(userId, sessionId, options);
    const refreshToken = randomBytes(32).toString('hex');
    
    // Create session
    const session = {
      id: sessionId,
      userId,
      accessToken,
      refreshToken,
      authMethod: options.authMethod,
      authLevel: options.authLevel,
      sessionType: options.sessionType,
      createdAt: new Date(),
      lastActivity: new Date(),
      expiresAt: new Date(Date.now() + this.config.sessionTimeout),
      expired: false,
      metadata: options.metadata || {}
    };
    
    // Store session and refresh token
    this.sessions.set(sessionId, session);
    this.refreshTokens.set(refreshToken, {
      sessionId,
      userId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + ms(this.config.refreshTokenExpiry))
    });
    
    return {
      id: sessionId,
      accessToken,
      refreshToken,
      expiresIn: this.config.sessionTimeout / 1000
    };
  }
  
  /**
   * Generate access token
   */
  generateAccessToken(userId, sessionId, options = {}) {
    const payload = {
      sub: userId,
      sid: sessionId,
      authLevel: options.authLevel,
      roles: options.roles || [],
      permissions: options.permissions || [],
      iat: Math.floor(Date.now() / 1000)
    };
    
    return jwt.sign(payload, this.config.jwtSecret, {
      expiresIn: this.config.jwtExpiry,
      issuer: this.config.tfaIssuer,
      audience: 'otedama-api'
    });
  }
  
  /**
   * Verify access token
   */
  async verifyAccessToken(token) {
    try {
      const decoded = jwt.verify(token, this.config.jwtSecret, {
        issuer: this.config.tfaIssuer,
        audience: 'otedama-api'
      });
      
      // Check if session exists and is valid
      const session = this.sessions.get(decoded.sid);
      if (!session || session.expired) {
        throw new Error('Invalid session');
      }
      
      // Update last activity
      session.lastActivity = new Date();
      
      return {
        userId: decoded.sub,
        sessionId: decoded.sid,
        authLevel: decoded.authLevel,
        roles: decoded.roles,
        permissions: decoded.permissions
      };
      
    } catch (error) {
      throw new Error('Invalid token');
    }
  }
  
  /**
   * Refresh access token
   */
  async refreshAccessToken(refreshToken) {
    const tokenData = this.refreshTokens.get(refreshToken);
    
    if (!tokenData) {
      throw new Error('Invalid refresh token');
    }
    
    if (new Date() > tokenData.expiresAt) {
      this.refreshTokens.delete(refreshToken);
      throw new Error('Refresh token expired');
    }
    
    // Get session
    const session = this.sessions.get(tokenData.sessionId);
    if (!session || session.expired) {
      throw new Error('Session expired');
    }
    
    // Generate new access token
    const newAccessToken = this.generateAccessToken(tokenData.userId, tokenData.sessionId, {
      authLevel: session.authLevel,
      roles: session.roles,
      permissions: session.permissions
    });
    
    // Update session
    session.accessToken = newAccessToken;
    session.lastActivity = new Date();
    
    return {
      accessToken: newAccessToken,
      expiresIn: this.config.sessionTimeout / 1000
    };
  }
  
  /**
   * Revoke session
   */
  async revokeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    
    if (session) {
      session.expired = true;
      
      // Remove associated refresh tokens
      for (const [token, data] of this.refreshTokens) {
        if (data.sessionId === sessionId) {
          this.refreshTokens.delete(token);
        }
      }
      
      logger.info('Session revoked', { sessionId });
      this.emit('sessionRevoked', { sessionId, userId: session.userId });
    }
  }
  
  /**
   * Change password
   */
  async changePassword(userId, oldPassword, newPassword) {
    const user = Array.from(this.users.values()).find(u => u.id === userId);
    
    if (!user) {
      throw new Error('User not found');
    }
    
    // Verify old password
    const hashedOldPassword = await this.hashPassword(oldPassword, user.salt);
    if (hashedOldPassword !== user.password) {
      throw new Error('Invalid current password');
    }
    
    // Validate new password
    const passwordValidation = this.validatePassword(newPassword);
    if (!passwordValidation.valid) {
      throw new Error(`Password validation failed: ${passwordValidation.errors.join(', ')}`);
    }
    
    // Check password history
    const history = this.passwordHistory.get(userId) || [];
    const newHash = await this.hashPassword(newPassword, user.salt);
    
    if (history.slice(-this.config.passwordHistory).includes(newHash)) {
      throw new Error('Password has been used recently');
    }
    
    // Update password
    user.password = newHash;
    
    // Update password history
    history.push(newHash);
    if (history.length > this.config.passwordHistory) {
      history.shift();
    }
    this.passwordHistory.set(userId, history);
    
    // Revoke all sessions
    for (const [sessionId, session] of this.sessions) {
      if (session.userId === userId) {
        await this.revokeSession(sessionId);
      }
    }
    
    logger.info('Password changed', { userId });
    this.emit('passwordChanged', { userId });
  }
  
  /**
   * Validate username
   */
  validateUsername(username) {
    if (!username || typeof username !== 'string') return false;
    if (username.length < 3 || username.length > 32) return false;
    return /^[a-zA-Z0-9_-]+$/.test(username);
  }
  
  /**
   * Validate password
   */
  validatePassword(password) {
    const errors = [];
    
    if (!password || password.length < this.config.passwordMinLength) {
      errors.push(`Password must be at least ${this.config.passwordMinLength} characters`);
    }
    
    if (this.config.passwordRequireUppercase && !/[A-Z]/.test(password)) {
      errors.push('Password must contain uppercase letters');
    }
    
    if (this.config.passwordRequireLowercase && !/[a-z]/.test(password)) {
      errors.push('Password must contain lowercase letters');
    }
    
    if (this.config.passwordRequireNumbers && !/[0-9]/.test(password)) {
      errors.push('Password must contain numbers');
    }
    
    if (this.config.passwordRequireSymbols && !/[^a-zA-Z0-9]/.test(password)) {
      errors.push('Password must contain special characters');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  /**
   * Hash password
   */
  async hashPassword(password, salt) {
    const hash = await pbkdf2Async(password, salt, 100000, 64, 'sha512');
    return hash.toString('hex');
  }
  
  /**
   * Track failed login attempt
   */
  trackFailedAttempt(identifier) {
    const attempts = this.loginAttempts.get(identifier) || {
      count: 0,
      firstAttempt: new Date(),
      lastAttempt: new Date()
    };
    
    attempts.count++;
    attempts.lastAttempt = new Date();
    
    // Check if should lock account
    if (attempts.count >= this.config.maxLoginAttempts) {
      const timeSinceFirst = Date.now() - attempts.firstAttempt.getTime();
      
      if (timeSinceFirst < this.config.lockoutDuration) {
        // Lock account
        const user = this.users.get(identifier);
        if (user) {
          user.locked = true;
          user.lockedUntil = new Date(Date.now() + this.config.lockoutDuration);
          
          logger.warn('Account locked due to failed attempts', {
            username: identifier,
            attempts: attempts.count
          });
        }
      } else {
        // Reset attempts
        attempts.count = 1;
        attempts.firstAttempt = new Date();
      }
    }
    
    this.loginAttempts.set(identifier, attempts);
  }
  
  /**
   * Authenticate with SAML
   */
  async authenticateSAML(credentials) {
    // This would integrate with actual SAML provider
    throw new Error('SAML authentication not configured');
  }
  
  /**
   * Authenticate with OAuth
   */
  async authenticateOAuth(credentials) {
    // This would integrate with actual OAuth provider
    throw new Error('OAuth authentication not configured');
  }
  
  /**
   * Authenticate with certificate
   */
  async authenticateCertificate(credentials) {
    // This would verify client certificates
    throw new Error('Certificate authentication not configured');
  }
  
  /**
   * Authenticate with zero-knowledge proof
   */
  async authenticateZKP(credentials) {
    // This would verify ZKP
    const { proof, challenge, publicKey } = credentials;
    
    // Simplified ZKP verification
    const hash = createHash('sha256')
      .update(proof + challenge + publicKey)
      .digest('hex');
    
    // In production, this would be actual ZKP verification
    const valid = hash.startsWith('0000');
    
    if (!valid) {
      throw new Error('Invalid zero-knowledge proof');
    }
    
    return {
      userId: publicKey,
      authLevel: AuthLevel.ENHANCED
    };
  }
  
  /**
   * Start session cleanup
   */
  startSessionCleanup() {
    this.cleanupInterval = setInterval(() => {
      const now = new Date();
      
      // Clean expired sessions
      for (const [sessionId, session] of this.sessions) {
        if (now > session.expiresAt) {
          this.revokeSession(sessionId);
        }
      }
      
      // Clean expired refresh tokens
      for (const [token, data] of this.refreshTokens) {
        if (now > data.expiresAt) {
          this.refreshTokens.delete(token);
        }
      }
      
      // Unlock accounts
      for (const user of this.users.values()) {
        if (user.locked && user.lockedUntil && now > user.lockedUntil) {
          user.locked = false;
          user.lockedUntil = null;
          logger.info('Account unlocked', { username: user.username });
        }
      }
      
    }, 60000); // Every minute
  }
  
  /**
   * Get authentication statistics
   */
  getStatistics() {
    const stats = {
      totalUsers: this.users.size,
      activeSessions: Array.from(this.sessions.values()).filter(s => !s.expired).length,
      lockedAccounts: Array.from(this.users.values()).filter(u => u.locked).length,
      mfaEnabled: Array.from(this.users.values()).filter(u => u.requireMFA).length,
      authMethods: {
        password: 0,
        twoFactor: 0,
        sso: 0,
        certificate: 0,
        zkp: 0
      }
    };
    
    // Count auth methods from sessions
    for (const session of this.sessions.values()) {
      if (session.authMethod) {
        const key = session.authMethod.replace('_', '');
        if (stats.authMethods[key] !== undefined) {
          stats.authMethods[key]++;
        }
      }
    }
    
    return stats;
  }
  
  /**
   * Export user data (GDPR compliance)
   */
  async exportUserData(userId) {
    const user = Array.from(this.users.values()).find(u => u.id === userId);
    
    if (!user) {
      throw new Error('User not found');
    }
    
    // Remove sensitive data
    const exportData = {
      ...user,
      password: undefined,
      salt: undefined,
      mfaSecret: undefined
    };
    
    // Add session history
    exportData.sessions = Array.from(this.sessions.values())
      .filter(s => s.userId === userId)
      .map(s => ({
        id: s.id,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        authMethod: s.authMethod,
        sessionType: s.sessionType
      }));
    
    return exportData;
  }
  
  /**
   * Delete user (GDPR compliance)
   */
  async deleteUser(userId) {
    const user = Array.from(this.users.values()).find(u => u.id === userId);
    
    if (!user) {
      throw new Error('User not found');
    }
    
    // Revoke all sessions
    for (const [sessionId, session] of this.sessions) {
      if (session.userId === userId) {
        await this.revokeSession(sessionId);
      }
    }
    
    // Remove user
    this.users.delete(user.username);
    this.passwordHistory.delete(userId);
    
    logger.info('User deleted', { userId });
    this.emit('userDeleted', { userId });
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    clearInterval(this.cleanupInterval);
    
    // Revoke all sessions
    for (const sessionId of this.sessions.keys()) {
      await this.revokeSession(sessionId);
    }
    
    logger.info('Authentication system shutdown');
    this.emit('shutdown');
  }
}

/**
 * Express middleware factory
 */
export function createAuthMiddleware(authSystem, options = {}) {
  return async (req, res, next) => {
    try {
      // Extract token
      const token = extractToken(req);
      
      if (!token) {
        if (options.required !== false) {
          return res.status(401).json({ error: 'Authentication required' });
        }
        return next();
      }
      
      // Verify token
      const tokenData = await authSystem.verifyAccessToken(token);
      
      // Check required auth level
      if (options.authLevel && tokenData.authLevel < options.authLevel) {
        return res.status(403).json({ error: 'Insufficient authentication level' });
      }
      
      // Check required roles
      if (options.roles && !options.roles.some(role => tokenData.roles.includes(role))) {
        return res.status(403).json({ error: 'Insufficient privileges' });
      }
      
      // Check required permissions
      if (options.permissions && !options.permissions.every(perm => tokenData.permissions.includes(perm))) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      
      // Attach auth data to request
      req.auth = tokenData;
      
      next();
      
    } catch (error) {
      logger.error('Authentication middleware error', { error });
      
      if (options.required !== false) {
        return res.status(401).json({ error: 'Invalid authentication' });
      }
      
      next();
    }
  };
}

/**
 * Extract token from request
 */
function extractToken(req) {
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  
  // Check cookie
  if (req.cookies && req.cookies.token) {
    return req.cookies.token;
  }
  
  // Check query parameter
  if (req.query && req.query.token) {
    return req.query.token;
  }
  
  return null;
}

/**
 * Convert time string to milliseconds
 */
function ms(str) {
  const units = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000
  };
  
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match) return 0;
  
  return parseInt(match[1]) * units[match[2]];
}

/**
 * Factory function
 */
export function createEnterpriseAuth(config) {
  return new EnterpriseAuthentication(config);
}

export default EnterpriseAuthentication;