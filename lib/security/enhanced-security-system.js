/**
 * Enhanced Security and Authentication System
 * Multi-layered security with advanced authentication mechanisms
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { logger } from '../core/logger.js';

/**
 * Advanced authentication manager
 */
export class AuthenticationManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      jwtSecret: options.jwtSecret || crypto.randomBytes(64).toString('hex'),
      jwtExpiry: options.jwtExpiry || '24h',
      refreshExpiry: options.refreshExpiry || '7d',
      mfaRequired: options.mfaRequired || false,
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireNumbers: true,
        requireSpecialChars: true,
        preventCommon: true,
        preventReuse: 5,
        maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
        ...options.passwordPolicy
      },
      sessionPolicy: {
        maxConcurrent: 5,
        absoluteTimeout: 24 * 60 * 60 * 1000, // 24 hours
        idleTimeout: 30 * 60 * 1000, // 30 minutes
        renewalWindow: 5 * 60 * 1000, // 5 minutes
        ...options.sessionPolicy
      },
      riskScoring: {
        enabled: true,
        threshold: 0.7,
        factors: ['ip', 'device', 'behavior', 'time'],
        ...options.riskScoring
      },
      ...options
    };
    
    this.sessions = new Map();
    this.refreshTokens = new Map();
    this.mfaTokens = new Map();
    this.loginAttempts = new Map();
    this.passwordHistory = new Map();
    this.trustedDevices = new Map();
    
    this.startCleanup();
  }

  /**
   * Register new user
   */
  async register(userData) {
    const { email, password, ...profile } = userData;
    
    // Validate email
    if (!this.isValidEmail(email)) {
      throw new Error('Invalid email address');
    }
    
    // Check if user exists
    if (await this.userExists(email)) {
      throw new Error('User already exists');
    }
    
    // Validate password
    const passwordValidation = this.validatePassword(password);
    if (!passwordValidation.valid) {
      throw new Error(`Password validation failed: ${passwordValidation.errors.join(', ')}`);
    }
    
    // Generate secure user ID
    const userId = crypto.randomBytes(16).toString('hex');
    
    // Hash password with Argon2id
    const hashedPassword = await this.hashPassword(password);
    
    // Generate encryption keys
    const encryptionKeys = this.generateUserKeys();
    
    // Create user record
    const user = {
      id: userId,
      email: email.toLowerCase(),
      password: hashedPassword,
      profile,
      encryptionKeys,
      mfaEnabled: this.options.mfaRequired,
      mfaSecret: this.options.mfaRequired ? this.generateMFASecret() : null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      passwordChangedAt: Date.now(),
      loginCount: 0,
      lastLogin: null,
      status: 'active'
    };
    
    // Store user (in production, save to database)
    await this.saveUser(user);
    
    // Initialize password history
    this.passwordHistory.set(userId, [hashedPassword]);
    
    this.emit('user-registered', { userId, email });
    
    return {
      userId,
      mfaSecret: user.mfaSecret,
      mfaQR: user.mfaSecret ? this.generateMFAQR(email, user.mfaSecret) : null
    };
  }

  /**
   * Authenticate user
   */
  async authenticate(credentials) {
    const { email, password, mfaToken, deviceId, clientInfo } = credentials;
    
    // Rate limiting check
    this.checkLoginAttempts(email);
    
    // Get user
    const user = await this.getUserByEmail(email);
    if (!user) {
      this.recordFailedLogin(email);
      throw new Error('Invalid credentials');
    }
    
    // Check account status
    if (user.status !== 'active') {
      throw new Error(`Account is ${user.status}`);
    }
    
    // Verify password
    const passwordValid = await this.verifyPassword(password, user.password);
    if (!passwordValid) {
      this.recordFailedLogin(email);
      throw new Error('Invalid credentials');
    }
    
    // Check password expiry
    if (this.isPasswordExpired(user.passwordChangedAt)) {
      throw new Error('Password expired');
    }
    
    // Risk assessment
    const riskScore = await this.assessRisk({
      userId: user.id,
      email,
      deviceId,
      clientInfo
    });
    
    if (riskScore > this.options.riskScoring.threshold) {
      this.emit('high-risk-login', { userId: user.id, riskScore });
      
      // Force MFA for high-risk logins
      if (!user.mfaEnabled) {
        throw new Error('High-risk login detected. Please enable MFA.');
      }
    }
    
    // MFA verification
    if (user.mfaEnabled) {
      if (!mfaToken) {
        // Generate temporary token for MFA step
        const tempToken = this.generateTempToken(user.id);
        return {
          requiresMFA: true,
          tempToken,
          trustedDevice: this.isTrustedDevice(user.id, deviceId)
        };
      }
      
      // Verify MFA token
      const mfaValid = this.verifyMFAToken(user.mfaSecret, mfaToken);
      if (!mfaValid) {
        this.recordFailedLogin(email);
        throw new Error('Invalid MFA token');
      }
    }
    
    // Check concurrent sessions
    this.checkConcurrentSessions(user.id);
    
    // Generate tokens
    const sessionId = crypto.randomBytes(16).toString('hex');
    const accessToken = this.generateAccessToken(user, sessionId);
    const refreshToken = this.generateRefreshToken(user.id, sessionId);
    
    // Create session
    const session = {
      id: sessionId,
      userId: user.id,
      deviceId,
      clientInfo,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      expiresAt: Date.now() + this.options.sessionPolicy.absoluteTimeout,
      riskScore
    };
    
    this.sessions.set(sessionId, session);
    
    // Update user login info
    await this.updateUserLogin(user.id);
    
    // Clear login attempts
    this.loginAttempts.delete(email);
    
    // Trust device if requested
    if (credentials.trustDevice && deviceId) {
      this.trustDevice(user.id, deviceId);
    }
    
    this.emit('user-authenticated', {
      userId: user.id,
      sessionId,
      riskScore
    });
    
    return {
      accessToken,
      refreshToken,
      sessionId,
      expiresIn: this.options.jwtExpiry,
      user: this.sanitizeUser(user)
    };
  }

  /**
   * Refresh access token
   */
  async refreshAccessToken(refreshToken) {
    const payload = this.verifyRefreshToken(refreshToken);
    if (!payload) {
      throw new Error('Invalid refresh token');
    }
    
    const { userId, sessionId } = payload;
    
    // Check if refresh token is still valid
    const storedToken = this.refreshTokens.get(`${userId}:${sessionId}`);
    if (!storedToken || storedToken !== refreshToken) {
      throw new Error('Refresh token not found or expired');
    }
    
    // Check session
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) {
      throw new Error('Session not found');
    }
    
    // Check session expiry
    if (Date.now() > session.expiresAt) {
      this.endSession(sessionId);
      throw new Error('Session expired');
    }
    
    // Get user
    const user = await this.getUserById(userId);
    if (!user || user.status !== 'active') {
      throw new Error('User not found or inactive');
    }
    
    // Generate new access token
    const newAccessToken = this.generateAccessToken(user, sessionId);
    
    // Update session activity
    session.lastActivity = Date.now();
    
    // Generate new refresh token if in renewal window
    let newRefreshToken = refreshToken;
    const refreshPayload = jwt.decode(refreshToken);
    const refreshExpiry = refreshPayload.exp * 1000;
    
    if (refreshExpiry - Date.now() < this.options.sessionPolicy.renewalWindow) {
      newRefreshToken = this.generateRefreshToken(userId, sessionId);
      this.refreshTokens.set(`${userId}:${sessionId}`, newRefreshToken);
    }
    
    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn: this.options.jwtExpiry
    };
  }

  /**
   * Logout user
   */
  async logout(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    
    // End session
    this.endSession(sessionId);
    
    // Revoke refresh token
    this.refreshTokens.delete(`${session.userId}:${sessionId}`);
    
    this.emit('user-logged-out', {
      userId: session.userId,
      sessionId
    });
  }

  /**
   * Change password
   */
  async changePassword(userId, currentPassword, newPassword) {
    const user = await this.getUserById(userId);
    if (!user) {
      throw new Error('User not found');
    }
    
    // Verify current password
    const passwordValid = await this.verifyPassword(currentPassword, user.password);
    if (!passwordValid) {
      throw new Error('Current password is incorrect');
    }
    
    // Validate new password
    const validation = this.validatePassword(newPassword);
    if (!validation.valid) {
      throw new Error(`Password validation failed: ${validation.errors.join(', ')}`);
    }
    
    // Check password history
    const history = this.passwordHistory.get(userId) || [];
    for (const oldHash of history.slice(0, this.options.passwordPolicy.preventReuse)) {
      if (await this.verifyPassword(newPassword, oldHash)) {
        throw new Error('Password has been used recently');
      }
    }
    
    // Hash new password
    const hashedPassword = await this.hashPassword(newPassword);
    
    // Update user
    user.password = hashedPassword;
    user.passwordChangedAt = Date.now();
    user.updatedAt = Date.now();
    
    await this.saveUser(user);
    
    // Update password history
    history.unshift(hashedPassword);
    if (history.length > this.options.passwordPolicy.preventReuse) {
      history.pop();
    }
    this.passwordHistory.set(userId, history);
    
    // Invalidate all sessions
    this.invalidateUserSessions(userId);
    
    this.emit('password-changed', { userId });
  }

  /**
   * Enable MFA
   */
  async enableMFA(userId) {
    const user = await this.getUserById(userId);
    if (!user) {
      throw new Error('User not found');
    }
    
    if (user.mfaEnabled) {
      throw new Error('MFA already enabled');
    }
    
    const mfaSecret = this.generateMFASecret();
    
    user.mfaEnabled = true;
    user.mfaSecret = mfaSecret;
    user.updatedAt = Date.now();
    
    await this.saveUser(user);
    
    this.emit('mfa-enabled', { userId });
    
    return {
      secret: mfaSecret,
      qr: this.generateMFAQR(user.email, mfaSecret)
    };
  }

  /**
   * Validate password
   */
  validatePassword(password) {
    const errors = [];
    const { passwordPolicy } = this.options;
    
    if (password.length < passwordPolicy.minLength) {
      errors.push(`Password must be at least ${passwordPolicy.minLength} characters`);
    }
    
    if (passwordPolicy.requireUppercase && !/[A-Z]/.test(password)) {
      errors.push('Password must contain uppercase letters');
    }
    
    if (passwordPolicy.requireLowercase && !/[a-z]/.test(password)) {
      errors.push('Password must contain lowercase letters');
    }
    
    if (passwordPolicy.requireNumbers && !/\d/.test(password)) {
      errors.push('Password must contain numbers');
    }
    
    if (passwordPolicy.requireSpecialChars && !/[^A-Za-z0-9]/.test(password)) {
      errors.push('Password must contain special characters');
    }
    
    if (passwordPolicy.preventCommon && this.isCommonPassword(password)) {
      errors.push('Password is too common');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Hash password using Argon2id
   */
  async hashPassword(password) {
    // In production, use actual argon2 library
    // For now, using crypto.scrypt as placeholder
    return new Promise((resolve, reject) => {
      const salt = crypto.randomBytes(32);
      crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
        if (err) reject(err);
        resolve(salt.toString('hex') + ':' + derivedKey.toString('hex'));
      });
    });
  }

  /**
   * Verify password
   */
  async verifyPassword(password, hash) {
    return new Promise((resolve) => {
      const [salt, key] = hash.split(':');
      crypto.scrypt(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
        if (err) return resolve(false);
        resolve(key === derivedKey.toString('hex'));
      });
    });
  }

  /**
   * Generate access token
   */
  generateAccessToken(user, sessionId) {
    const payload = {
      userId: user.id,
      email: user.email,
      sessionId,
      roles: user.roles || [],
      permissions: user.permissions || []
    };
    
    return jwt.sign(payload, this.options.jwtSecret, {
      expiresIn: this.options.jwtExpiry,
      issuer: 'otedama',
      audience: 'otedama-api',
      subject: user.id
    });
  }

  /**
   * Generate refresh token
   */
  generateRefreshToken(userId, sessionId) {
    const payload = {
      userId,
      sessionId,
      type: 'refresh'
    };
    
    const token = jwt.sign(payload, this.options.jwtSecret, {
      expiresIn: this.options.refreshExpiry,
      issuer: 'otedama',
      audience: 'otedama-refresh'
    });
    
    this.refreshTokens.set(`${userId}:${sessionId}`, token);
    
    return token;
  }

  /**
   * Risk assessment
   */
  async assessRisk(context) {
    const { userId, email, deviceId, clientInfo } = context;
    
    let riskScore = 0;
    const factors = [];
    
    // IP address check
    if (this.options.riskScoring.factors.includes('ip')) {
      const ipRisk = await this.assessIPRisk(clientInfo.ip);
      riskScore += ipRisk * 0.3;
      if (ipRisk > 0.5) factors.push('suspicious-ip');
    }
    
    // Device check
    if (this.options.riskScoring.factors.includes('device')) {
      const deviceRisk = this.assessDeviceRisk(userId, deviceId);
      riskScore += deviceRisk * 0.3;
      if (deviceRisk > 0.5) factors.push('unknown-device');
    }
    
    // Behavior check
    if (this.options.riskScoring.factors.includes('behavior')) {
      const behaviorRisk = await this.assessBehaviorRisk(userId, email);
      riskScore += behaviorRisk * 0.3;
      if (behaviorRisk > 0.5) factors.push('unusual-behavior');
    }
    
    // Time check
    if (this.options.riskScoring.factors.includes('time')) {
      const timeRisk = this.assessTimeRisk(userId);
      riskScore += timeRisk * 0.1;
      if (timeRisk > 0.5) factors.push('unusual-time');
    }
    
    this.emit('risk-assessed', {
      userId,
      riskScore,
      factors
    });
    
    return riskScore;
  }

  /**
   * Start cleanup tasks
   */
  startCleanup() {
    // Clean expired sessions
    setInterval(() => {
      this.cleanupSessions();
    }, 60000); // Every minute
    
    // Clean expired MFA tokens
    setInterval(() => {
      this.cleanupMFATokens();
    }, 300000); // Every 5 minutes
    
    // Clean old login attempts
    setInterval(() => {
      this.cleanupLoginAttempts();
    }, 3600000); // Every hour
  }

  /**
   * Cleanup expired sessions
   */
  cleanupSessions() {
    const now = Date.now();
    
    for (const [sessionId, session] of this.sessions) {
      // Check absolute timeout
      if (now > session.expiresAt) {
        this.endSession(sessionId);
        continue;
      }
      
      // Check idle timeout
      if (now - session.lastActivity > this.options.sessionPolicy.idleTimeout) {
        this.endSession(sessionId);
      }
    }
  }

  /**
   * End session
   */
  endSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      this.refreshTokens.delete(`${session.userId}:${sessionId}`);
      
      this.emit('session-ended', {
        userId: session.userId,
        sessionId
      });
    }
  }

  /**
   * Helper methods (stubs for production implementation)
   */
  
  isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
  
  async userExists(email) {
    // Check in database
    return false;
  }
  
  async getUserByEmail(email) {
    // Fetch from database
    return null;
  }
  
  async getUserById(userId) {
    // Fetch from database
    return null;
  }
  
  async saveUser(user) {
    // Save to database
  }
  
  generateUserKeys() {
    return {
      public: crypto.randomBytes(32).toString('hex'),
      private: crypto.randomBytes(32).toString('hex')
    };
  }
  
  generateMFASecret() {
    // In production, use speakeasy or similar
    return crypto.randomBytes(20).toString('base64');
  }
  
  generateMFAQR(email, secret) {
    // In production, generate actual QR code
    return `otpauth://totp/Otedama:${email}?secret=${secret}&issuer=Otedama`;
  }
  
  verifyMFAToken(secret, token) {
    // In production, use speakeasy or similar
    return token === '123456'; // Placeholder
  }
  
  isCommonPassword(password) {
    const common = ['password', '123456', 'qwerty'];
    return common.includes(password.toLowerCase());
  }
  
  sanitizeUser(user) {
    const { password, mfaSecret, encryptionKeys, ...safe } = user;
    return safe;
  }
}

/**
 * Advanced security middleware
 */
export class SecurityMiddleware {
  constructor(authManager, options = {}) {
    this.authManager = authManager;
    this.options = {
      encryption: {
        algorithm: 'aes-256-gcm',
        keyDerivation: 'pbkdf2',
        iterations: 100000
      },
      headers: {
        hsts: {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true
        },
        csp: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"]
        }
      },
      cors: {
        origin: false,
        credentials: true,
        maxAge: 86400
      },
      rateLimit: {
        windowMs: 60000,
        max: 100,
        skipSuccessfulRequests: false
      },
      ...options
    };
    
    this.encryptionKeys = new Map();
  }

  /**
   * Authentication middleware
   */
  authenticate(options = {}) {
    return async (req, res, next) => {
      try {
        // Extract token
        const token = this.extractToken(req);
        if (!token) {
          return res.status(401).json({ error: 'No token provided' });
        }
        
        // Verify token
        const payload = jwt.verify(token, this.authManager.options.jwtSecret);
        
        // Check session
        const session = this.authManager.sessions.get(payload.sessionId);
        if (!session || session.userId !== payload.userId) {
          return res.status(401).json({ error: 'Invalid session' });
        }
        
        // Check session expiry
        if (Date.now() > session.expiresAt) {
          this.authManager.endSession(payload.sessionId);
          return res.status(401).json({ error: 'Session expired' });
        }
        
        // Update session activity
        session.lastActivity = Date.now();
        
        // Attach user to request
        req.user = payload;
        req.sessionId = payload.sessionId;
        
        next();
      } catch (error) {
        if (error.name === 'TokenExpiredError') {
          return res.status(401).json({ error: 'Token expired' });
        }
        
        return res.status(401).json({ error: 'Invalid token' });
      }
    };
  }

  /**
   * Authorization middleware
   */
  authorize(requiredPermissions = []) {
    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      
      const userPermissions = req.user.permissions || [];
      const hasPermission = requiredPermissions.every(perm => 
        userPermissions.includes(perm)
      );
      
      if (!hasPermission) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      
      next();
    };
  }

  /**
   * Security headers middleware
   */
  securityHeaders() {
    return (req, res, next) => {
      // HSTS
      const hsts = this.options.headers.hsts;
      res.setHeader(
        'Strict-Transport-Security',
        `max-age=${hsts.maxAge}${hsts.includeSubDomains ? '; includeSubDomains' : ''}${hsts.preload ? '; preload' : ''}`
      );
      
      // CSP
      const csp = Object.entries(this.options.headers.csp)
        .map(([directive, sources]) => `${this.kebabCase(directive)} ${sources.join(' ')}`)
        .join('; ');
      res.setHeader('Content-Security-Policy', csp);
      
      // Other security headers
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
      
      next();
    };
  }

  /**
   * Input validation middleware
   */
  validateInput(schema) {
    return (req, res, next) => {
      const { error } = schema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true
      });
      
      if (error) {
        const errors = error.details.map(detail => ({
          field: detail.path.join('.'),
          message: detail.message
        }));
        
        return res.status(400).json({ errors });
      }
      
      next();
    };
  }

  /**
   * Encryption middleware
   */
  encrypt(fields = []) {
    return async (req, res, next) => {
      if (!req.user) {
        return next();
      }
      
      try {
        const encryptionKey = await this.getUserEncryptionKey(req.user.userId);
        
        // Encrypt specified fields
        for (const field of fields) {
          const value = this.getNestedValue(req.body, field);
          if (value !== undefined) {
            const encrypted = await this.encryptData(value, encryptionKey);
            this.setNestedValue(req.body, field, encrypted);
          }
        }
        
        next();
      } catch (error) {
        logger.error('Encryption error:', error);
        res.status(500).json({ error: 'Encryption failed' });
      }
    };
  }

  /**
   * Decrypt middleware
   */
  decrypt(fields = []) {
    return async (req, res, next) => {
      if (!req.user) {
        return next();
      }
      
      // Store original res.json
      const originalJson = res.json;
      
      res.json = async function(data) {
        try {
          const encryptionKey = await this.getUserEncryptionKey(req.user.userId);
          
          // Decrypt specified fields
          const decrypted = JSON.parse(JSON.stringify(data));
          
          for (const field of fields) {
            const value = this.getNestedValue(decrypted, field);
            if (value && typeof value === 'object' && value._encrypted) {
              const decryptedValue = await this.decryptData(value, encryptionKey);
              this.setNestedValue(decrypted, field, decryptedValue);
            }
          }
          
          originalJson.call(res, decrypted);
        } catch (error) {
          logger.error('Decryption error:', error);
          originalJson.call(res, { error: 'Decryption failed' });
        }
      }.bind(this);
      
      next();
    };
  }

  /**
   * Audit logging middleware
   */
  auditLog(action) {
    return (req, res, next) => {
      const startTime = Date.now();
      
      // Store original res.json
      const originalJson = res.json;
      
      res.json = function(data) {
        const duration = Date.now() - startTime;
        
        const auditEntry = {
          timestamp: new Date().toISOString(),
          action,
          userId: req.user?.userId,
          sessionId: req.sessionId,
          method: req.method,
          path: req.path,
          ip: req.ip,
          userAgent: req.get('user-agent'),
          statusCode: res.statusCode,
          duration,
          success: res.statusCode < 400
        };
        
        // Log sensitive actions
        if (this.isSensitiveAction(action)) {
          auditEntry.requestBody = this.sanitizeRequestBody(req.body);
          auditEntry.responsePreview = this.sanitizeResponse(data);
        }
        
        // Emit audit event
        this.authManager.emit('audit', auditEntry);
        
        // Store in audit log (in production, use proper audit logging service)
        logger.info('Audit:', auditEntry);
        
        originalJson.call(res, data);
      }.bind(this);
      
      next();
    };
  }

  /**
   * Helper methods
   */
  
  extractToken(req) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    
    return req.cookies?.token || req.query.token;
  }
  
  async getUserEncryptionKey(userId) {
    if (!this.encryptionKeys.has(userId)) {
      // In production, fetch from secure key store
      const key = crypto.randomBytes(32);
      this.encryptionKeys.set(userId, key);
    }
    
    return this.encryptionKeys.get(userId);
  }
  
  async encryptData(data, key) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.options.encryption.algorithm, key, iv);
    
    const text = JSON.stringify(data);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag();
    
    return {
      _encrypted: true,
      algorithm: this.options.encryption.algorithm,
      data: encrypted,
      iv: iv.toString('hex'),
      tag: tag.toString('hex')
    };
  }
  
  async decryptData(encrypted, key) {
    const decipher = crypto.createDecipheriv(
      encrypted.algorithm,
      key,
      Buffer.from(encrypted.iv, 'hex')
    );
    
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
    
    let decrypted = decipher.update(encrypted.data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return JSON.parse(decrypted);
  }
  
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }
  
  setNestedValue(obj, path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((current, key) => {
      if (!current[key]) current[key] = {};
      return current[key];
    }, obj);
    
    target[lastKey] = value;
  }
  
  kebabCase(str) {
    return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  }
  
  isSensitiveAction(action) {
    const sensitive = [
      'user.create',
      'user.update',
      'user.delete',
      'auth.login',
      'auth.logout',
      'password.change',
      'permission.grant',
      'permission.revoke'
    ];
    
    return sensitive.includes(action);
  }
  
  sanitizeRequestBody(body) {
    const sanitized = { ...body };
    const sensitiveFields = ['password', 'token', 'secret', 'key'];
    
    for (const field of sensitiveFields) {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    }
    
    return sanitized;
  }
  
  sanitizeResponse(data) {
    if (typeof data !== 'object') return data;
    
    const preview = JSON.stringify(data).substring(0, 200);
    return preview.length < JSON.stringify(data).length ? preview + '...' : preview;
  }
}

/**
 * Security scanner for vulnerability detection
 */
export class SecurityScanner {
  constructor(options = {}) {
    this.options = {
      scanners: ['sql', 'xss', 'xxe', 'path', 'command'],
      maxDepth: 10,
      maxStringLength: 10000,
      ...options
    };
    
    this.patterns = this.loadPatterns();
  }

  /**
   * Load security patterns
   */
  loadPatterns() {
    return {
      sql: [
        /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|CREATE|ALTER)\b)/gi,
        /(\'|\"|\`)\s*OR\s*\d+\s*=\s*\d+/gi,
        /(\b(AND|OR)\b\s*\d+\s*=\s*\d+)/gi,
        /(\'|\"|\`)\s*;\s*(SELECT|INSERT|UPDATE|DELETE|DROP)/gi
      ],
      xss: [
        /<script[^>]*>[\s\S]*?<\/script>/gi,
        /<iframe[^>]*>[\s\S]*?<\/iframe>/gi,
        /javascript\s*:/gi,
        /on\w+\s*=/gi,
        /<img[^>]*onerror\s*=/gi
      ],
      xxe: [
        /<!DOCTYPE[^>]*\[[\s\S]*?\]>/gi,
        /<!ENTITY[^>]*>/gi,
        /SYSTEM\s*["'][^"']*["']/gi
      ],
      path: [
        /\.\.[\/\\]/g,
        /^[\/\\]/,
        /[\/\\]\.\.[\/\\]/g
      ],
      command: [
        /[;&|`$]/g,
        /\b(rm|del|format|shutdown|reboot)\b/gi
      ]
    };
  }

  /**
   * Scan input for vulnerabilities
   */
  scan(input, context = {}) {
    const threats = [];
    
    // Scan based on enabled scanners
    for (const scanner of this.options.scanners) {
      const scanMethod = this[`scan${scanner.charAt(0).toUpperCase() + scanner.slice(1)}`];
      if (scanMethod) {
        const results = scanMethod.call(this, input, context);
        threats.push(...results);
      }
    }
    
    return {
      safe: threats.length === 0,
      threats
    };
  }

  /**
   * SQL injection scanner
   */
  scanSql(input, context) {
    const threats = [];
    
    this.traverseInput(input, (value, path) => {
      if (typeof value !== 'string') return;
      
      for (const pattern of this.patterns.sql) {
        if (pattern.test(value)) {
          threats.push({
            type: 'sql-injection',
            severity: 'high',
            path,
            value: value.substring(0, 100),
            pattern: pattern.toString()
          });
        }
      }
    });
    
    return threats;
  }

  /**
   * XSS scanner
   */
  scanXss(input, context) {
    const threats = [];
    
    this.traverseInput(input, (value, path) => {
      if (typeof value !== 'string') return;
      
      for (const pattern of this.patterns.xss) {
        if (pattern.test(value)) {
          threats.push({
            type: 'xss',
            severity: 'high',
            path,
            value: value.substring(0, 100),
            pattern: pattern.toString()
          });
        }
      }
    });
    
    return threats;
  }

  /**
   * Traverse input recursively
   */
  traverseInput(input, callback, path = '', depth = 0) {
    if (depth > this.options.maxDepth) return;
    
    if (typeof input === 'string') {
      if (input.length <= this.options.maxStringLength) {
        callback(input, path);
      }
    } else if (Array.isArray(input)) {
      input.forEach((item, index) => {
        this.traverseInput(item, callback, `${path}[${index}]`, depth + 1);
      });
    } else if (input && typeof input === 'object') {
      Object.entries(input).forEach(([key, value]) => {
        this.traverseInput(value, callback, path ? `${path}.${key}` : key, depth + 1);
      });
    }
  }
}

export default {
  AuthenticationManager,
  SecurityMiddleware,
  SecurityScanner
};