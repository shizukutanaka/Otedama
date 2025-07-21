/**
 * Unified Authentication System for Otedama
 * Enterprise-grade authentication with national-level security
 * 
 * Design principles:
 * - Carmack: High-performance token validation
 * - Martin: Clean separation of concerns
 * - Pike: Simple, secure interfaces
 */

import { EventEmitter } from 'events';
import { randomBytes, scryptSync, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'crypto';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';

// Constants
const SALT_LENGTH = 32;
const KEY_LENGTH = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

// Token types
export const TokenType = {
  ACCESS: 'access',
  REFRESH: 'refresh',
  API_KEY: 'api_key',
  SESSION: 'session',
  RESET: 'reset',
  VERIFICATION: 'verification'
};

// User roles
export const UserRole = {
  USER: 'user',
  MINER: 'miner',
  TRADER: 'trader',
  OPERATOR: 'operator',
  ADMIN: 'admin',
  SUPER_ADMIN: 'super_admin'
};

// Permission flags
export const Permission = {
  // Mining permissions
  MINING_VIEW: 1 << 0,
  MINING_SUBMIT: 1 << 1,
  MINING_MANAGE: 1 << 2,
  
  // Trading permissions
  TRADING_VIEW: 1 << 3,
  TRADING_CREATE: 1 << 4,
  TRADING_CANCEL: 1 << 5,
  
  // DeFi permissions
  DEFI_VIEW: 1 << 6,
  DEFI_STAKE: 1 << 7,
  DEFI_GOVERN: 1 << 8,
  
  // Admin permissions
  ADMIN_VIEW: 1 << 9,
  ADMIN_USERS: 1 << 10,
  ADMIN_SYSTEM: 1 << 11,
  
  // API permissions
  API_READ: 1 << 12,
  API_WRITE: 1 << 13,
  API_DELETE: 1 << 14,
  
  // Full access
  FULL_ACCESS: 0xFFFFFFFF
};

// Default role permissions
const ROLE_PERMISSIONS = {
  [UserRole.USER]: Permission.MINING_VIEW | Permission.TRADING_VIEW | Permission.DEFI_VIEW | Permission.API_READ,
  [UserRole.MINER]: Permission.MINING_VIEW | Permission.MINING_SUBMIT | Permission.API_READ,
  [UserRole.TRADER]: Permission.TRADING_VIEW | Permission.TRADING_CREATE | Permission.TRADING_CANCEL | Permission.API_READ | Permission.API_WRITE,
  [UserRole.OPERATOR]: Permission.MINING_VIEW | Permission.MINING_SUBMIT | Permission.MINING_MANAGE | Permission.TRADING_VIEW | Permission.API_READ | Permission.API_WRITE,
  [UserRole.ADMIN]: Permission.FULL_ACCESS & ~Permission.ADMIN_SYSTEM,
  [UserRole.SUPER_ADMIN]: Permission.FULL_ACCESS
};

/**
 * Authentication Manager
 */
export class AuthenticationManager extends EventEmitter {
  constructor(dbManager, options = {}) {
    super();
    
    this.db = dbManager;
    
    // Configuration
    this.config = {
      // JWT settings
      jwtSecret: options.jwtSecret || this.generateSecret(),
      accessTokenExpiry: options.accessTokenExpiry || '15m',
      refreshTokenExpiry: options.refreshTokenExpiry || '7d',
      
      // Session settings
      sessionTimeout: options.sessionTimeout || 3600000, // 1 hour
      maxSessions: options.maxSessions || 5,
      
      // Security settings
      maxLoginAttempts: options.maxLoginAttempts || 5,
      lockoutDuration: options.lockoutDuration || 900000, // 15 minutes
      passwordMinLength: options.passwordMinLength || 8,
      passwordRequirements: options.passwordRequirements || {
        uppercase: true,
        lowercase: true,
        numbers: true,
        special: true
      },
      
      // 2FA settings
      twoFactorRequired: options.twoFactorRequired || false,
      twoFactorIssuer: options.twoFactorIssuer || 'Otedama',
      
      // API key settings
      apiKeyLength: options.apiKeyLength || 32,
      apiKeyPrefix: options.apiKeyPrefix || 'otd_',
      
      // Encryption for sensitive data
      encryptionKey: options.encryptionKey || this.deriveEncryptionKey(),
      
      ...options
    };
    
    // In-memory caches (Carmack: performance)
    this.sessions = new Map();
    this.apiKeys = new Map();
    this.blacklist = new Set();
    this.rateLimits = new Map();
    
    // Initialize database schema
    this.initializeDatabase();
    
    // Start cleanup intervals
    this.startCleanup();
  }

  /**
   * Initialize database tables
   */
  async initializeDatabase() {
    try {
      // Users table is already created in main schema
      // Add additional auth-specific tables
      
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS user_sessions (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          token_hash TEXT NOT NULL,
          ip_address TEXT,
          user_agent TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME NOT NULL,
          last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          permissions INTEGER NOT NULL DEFAULT 0,
          last_used DATETIME,
          expires_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS login_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT,
          ip_address TEXT NOT NULL,
          success BOOLEAN NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS password_resets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at DATETIME NOT NULL,
          used BOOLEAN DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      
      // Create indexes
      await this.db.query('CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id)');
      await this.db.query('CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(token_hash)');
      await this.db.query('CREATE INDEX IF NOT EXISTS idx_apikeys_user ON api_keys(user_id)');
      await this.db.query('CREATE INDEX IF NOT EXISTS idx_apikeys_hash ON api_keys(key_hash)');
      await this.db.query('CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip_address, created_at)');
      
    } catch (error) {
      this.emit('error', { phase: 'database_init', error });
      throw error;
    }
  }

  /**
   * Register new user
   */
  async register(userData) {
    const { username, email, password, btcAddress, role = UserRole.USER } = userData;
    
    try {
      // Validate input
      this.validateUsername(username);
      this.validateEmail(email);
      this.validatePassword(password);
      if (btcAddress) this.validateBtcAddress(btcAddress);
      
      // Check if user exists
      const existing = await this.db.get(
        'SELECT id FROM users WHERE username = ? OR email = ?',
        [username.toLowerCase(), email.toLowerCase()]
      );
      
      if (existing) {
        throw new Error('User already exists');
      }
      
      // Hash password
      const passwordHash = await this.hashPassword(password);
      
      // Generate API key
      const apiKey = this.generateApiKey();
      const apiKeyHash = this.hashApiKey(apiKey);
      
      // Create user
      const result = await this.db.run(`
        INSERT INTO users (username, email, password_hash, btc_address, api_key, role)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        username.toLowerCase(),
        email.toLowerCase(),
        passwordHash,
        btcAddress,
        apiKeyHash,
        role
      ]);
      
      const userId = result.lastID;
      
      // Store API key
      await this.db.run(`
        INSERT INTO api_keys (user_id, key_hash, name, permissions)
        VALUES (?, ?, ?, ?)
      `, [
        userId,
        apiKeyHash,
        'Default API Key',
        ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS[UserRole.USER]
      ]);
      
      // Log registration
      this.emit('user:registered', { userId, username, email });
      
      return {
        userId,
        apiKey, // Return plain API key only once
        message: 'Registration successful'
      };
      
    } catch (error) {
      this.emit('error', { phase: 'registration', error });
      throw error;
    }
  }

  /**
   * Login user
   */
  async login(credentials, metadata = {}) {
    const { username, password, twoFactorToken, ipAddress, userAgent } = { ...credentials, ...metadata };
    
    try {
      // Check rate limiting
      this.checkRateLimit(ipAddress || 'unknown');
      
      // Find user
      const user = await this.db.get(`
        SELECT id, username, email, password_hash, role, status, 
               two_factor_enabled, two_factor_secret, failed_login_attempts, locked_until
        FROM users 
        WHERE username = ? OR email = ?
      `, [username.toLowerCase(), username.toLowerCase()]);
      
      if (!user) {
        await this.recordLoginAttempt(username, ipAddress, false);
        throw new Error('Invalid credentials');
      }
      
      // Check account status
      if (user.status !== 'active') {
        throw new Error(`Account is ${user.status}`);
      }
      
      // Check lockout
      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        throw new Error('Account is temporarily locked');
      }
      
      // Verify password
      const validPassword = await this.verifyPassword(password, user.password_hash);
      if (!validPassword) {
        await this.handleFailedLogin(user.id, username, ipAddress);
        throw new Error('Invalid credentials');
      }
      
      // Verify 2FA if enabled
      if (user.two_factor_enabled) {
        if (!twoFactorToken) {
          return { requiresTwoFactor: true };
        }
        
        const valid2FA = this.verify2FA(twoFactorToken, user.two_factor_secret);
        if (!valid2FA) {
          await this.recordLoginAttempt(username, ipAddress, false);
          throw new Error('Invalid 2FA token');
        }
      }
      
      // Generate tokens
      const sessionId = this.generateSessionId();
      const { accessToken, refreshToken } = this.generateTokens(user.id, user.role);
      
      // Create session
      const expiresAt = new Date(Date.now() + this.config.sessionTimeout);
      await this.db.run(`
        INSERT INTO user_sessions (id, user_id, token_hash, ip_address, user_agent, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        sessionId,
        user.id,
        this.hashToken(refreshToken),
        ipAddress,
        userAgent,
        expiresAt
      ]);
      
      // Update user login info
      await this.db.run(`
        UPDATE users 
        SET last_login = CURRENT_TIMESTAMP, failed_login_attempts = 0 
        WHERE id = ?
      `, [user.id]);
      
      // Record successful login
      await this.recordLoginAttempt(username, ipAddress, true);
      
      // Cache session
      this.sessions.set(sessionId, {
        userId: user.id,
        role: user.role,
        permissions: ROLE_PERMISSIONS[user.role],
        ipAddress,
        createdAt: Date.now()
      });
      
      this.emit('user:login', { userId: user.id, username: user.username, ipAddress });
      
      return {
        userId: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        accessToken,
        refreshToken,
        sessionId,
        expiresIn: this.config.sessionTimeout
      };
      
    } catch (error) {
      this.emit('error', { phase: 'login', error });
      throw error;
    }
  }

  /**
   * Logout user
   */
  async logout(sessionId, refreshToken = null) {
    try {
      // Remove session from database
      await this.db.run('DELETE FROM user_sessions WHERE id = ?', [sessionId]);
      
      // Remove from cache
      this.sessions.delete(sessionId);
      
      // Blacklist refresh token if provided
      if (refreshToken) {
        this.blacklist.add(refreshToken);
      }
      
      this.emit('user:logout', { sessionId });
      
      return { success: true };
      
    } catch (error) {
      this.emit('error', { phase: 'logout', error });
      throw error;
    }
  }

  /**
   * Refresh access token
   */
  async refreshAccessToken(refreshToken) {
    try {
      // Check blacklist
      if (this.blacklist.has(refreshToken)) {
        throw new Error('Token has been revoked');
      }
      
      // Verify refresh token
      const payload = this.verifyToken(refreshToken, TokenType.REFRESH);
      if (!payload) {
        throw new Error('Invalid refresh token');
      }
      
      // Check session
      const session = await this.db.get(`
        SELECT * FROM user_sessions 
        WHERE user_id = ? AND token_hash = ? AND expires_at > datetime('now')
      `, [payload.userId, this.hashToken(refreshToken)]);
      
      if (!session) {
        throw new Error('Session not found or expired');
      }
      
      // Get user
      const user = await this.db.get(
        'SELECT id, role, status FROM users WHERE id = ?',
        [payload.userId]
      );
      
      if (!user || user.status !== 'active') {
        throw new Error('User not found or inactive');
      }
      
      // Generate new access token
      const accessToken = this.generateAccessToken(user.id, user.role);
      
      // Update session activity
      await this.db.run(
        'UPDATE user_sessions SET last_activity = CURRENT_TIMESTAMP WHERE id = ?',
        [session.id]
      );
      
      return { accessToken, expiresIn: '15m' };
      
    } catch (error) {
      this.emit('error', { phase: 'token_refresh', error });
      throw error;
    }
  }

  /**
   * Verify access token
   */
  verifyAccessToken(token) {
    return this.verifyToken(token, TokenType.ACCESS);
  }

  /**
   * Create API key
   */
  async createApiKey(userId, name, permissions = null) {
    try {
      // Get user
      const user = await this.db.get(
        'SELECT id, role FROM users WHERE id = ?',
        [userId]
      );
      
      if (!user) {
        throw new Error('User not found');
      }
      
      // Generate API key
      const apiKey = this.generateApiKey();
      const keyHash = this.hashApiKey(apiKey);
      
      // Default permissions based on role
      const keyPermissions = permissions || ROLE_PERMISSIONS[user.role];
      
      // Store API key
      await this.db.run(`
        INSERT INTO api_keys (user_id, key_hash, name, permissions)
        VALUES (?, ?, ?, ?)
      `, [userId, keyHash, name, keyPermissions]);
      
      // Cache API key
      this.apiKeys.set(keyHash, {
        userId,
        permissions: keyPermissions,
        createdAt: Date.now()
      });
      
      this.emit('apikey:created', { userId, name });
      
      return { apiKey, name, permissions: keyPermissions };
      
    } catch (error) {
      this.emit('error', { phase: 'apikey_creation', error });
      throw error;
    }
  }

  /**
   * Verify API key
   */
  async verifyApiKey(apiKey) {
    try {
      const keyHash = this.hashApiKey(apiKey);
      
      // Check cache first
      const cached = this.apiKeys.get(keyHash);
      if (cached) {
        return cached;
      }
      
      // Check database
      const key = await this.db.get(`
        SELECT k.*, u.status as user_status 
        FROM api_keys k
        JOIN users u ON k.user_id = u.id
        WHERE k.key_hash = ? AND (k.expires_at IS NULL OR k.expires_at > datetime('now'))
      `, [keyHash]);
      
      if (!key || key.user_status !== 'active') {
        return null;
      }
      
      // Update last used
      await this.db.run(
        'UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?',
        [key.id]
      );
      
      // Cache result
      const result = {
        userId: key.user_id,
        permissions: key.permissions,
        name: key.name
      };
      
      this.apiKeys.set(keyHash, result);
      
      return result;
      
    } catch (error) {
      this.emit('error', { phase: 'apikey_verification', error });
      return null;
    }
  }

  /**
   * Change password
   */
  async changePassword(userId, oldPassword, newPassword) {
    try {
      // Get user
      const user = await this.db.get(
        'SELECT password_hash FROM users WHERE id = ?',
        [userId]
      );
      
      if (!user) {
        throw new Error('User not found');
      }
      
      // Verify old password
      const validPassword = await this.verifyPassword(oldPassword, user.password_hash);
      if (!validPassword) {
        throw new Error('Invalid current password');
      }
      
      // Validate new password
      this.validatePassword(newPassword);
      
      // Hash new password
      const newPasswordHash = await this.hashPassword(newPassword);
      
      // Update password
      await this.db.run(
        'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [newPasswordHash, userId]
      );
      
      // Invalidate all sessions
      await this.db.run('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
      
      this.emit('user:password_changed', { userId });
      
      return { success: true };
      
    } catch (error) {
      this.emit('error', { phase: 'password_change', error });
      throw error;
    }
  }

  /**
   * Enable 2FA
   */
  async enable2FA(userId) {
    try {
      // Generate secret
      const secret = speakeasy.generateSecret({
        name: `${this.config.twoFactorIssuer}:${userId}`,
        issuer: this.config.twoFactorIssuer
      });
      
      // Encrypt secret before storing
      const encryptedSecret = this.encrypt(secret.base32);
      
      // Store encrypted secret
      await this.db.run(
        'UPDATE users SET two_factor_secret = ? WHERE id = ?',
        [encryptedSecret, userId]
      );
      
      return {
        secret: secret.base32,
        qrCode: secret.otpauth_url
      };
      
    } catch (error) {
      this.emit('error', { phase: '2fa_enable', error });
      throw error;
    }
  }

  /**
   * Confirm 2FA enable
   */
  async confirm2FA(userId, token) {
    try {
      // Get user
      const user = await this.db.get(
        'SELECT two_factor_secret FROM users WHERE id = ?',
        [userId]
      );
      
      if (!user || !user.two_factor_secret) {
        throw new Error('2FA not initialized');
      }
      
      // Decrypt secret
      const secret = this.decrypt(user.two_factor_secret);
      
      // Verify token
      const valid = this.verify2FA(token, secret);
      if (!valid) {
        throw new Error('Invalid 2FA token');
      }
      
      // Enable 2FA
      await this.db.run(
        'UPDATE users SET two_factor_enabled = 1 WHERE id = ?',
        [userId]
      );
      
      this.emit('user:2fa_enabled', { userId });
      
      return { success: true };
      
    } catch (error) {
      this.emit('error', { phase: '2fa_confirm', error });
      throw error;
    }
  }

  /**
   * Check permissions
   */
  hasPermission(userPermissions, requiredPermission) {
    return (userPermissions & requiredPermission) === requiredPermission;
  }

  /**
   * Helper methods
   */
  
  async hashPassword(password) {
    const salt = randomBytes(SALT_LENGTH);
    const hash = scryptSync(password, salt, KEY_LENGTH, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION
    });
    
    return salt.toString('hex') + ':' + hash.toString('hex');
  }
  
  async verifyPassword(password, storedHash) {
    const [salt, hash] = storedHash.split(':');
    const saltBuffer = Buffer.from(salt, 'hex');
    const hashBuffer = Buffer.from(hash, 'hex');
    
    const derivedHash = scryptSync(password, saltBuffer, KEY_LENGTH, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION
    });
    
    return timingSafeEqual(hashBuffer, derivedHash);
  }
  
  generateTokens(userId, role) {
    const accessToken = this.generateAccessToken(userId, role);
    const refreshToken = this.generateRefreshToken(userId);
    
    return { accessToken, refreshToken };
  }
  
  generateAccessToken(userId, role) {
    return jwt.sign(
      {
        userId,
        role,
        type: TokenType.ACCESS,
        permissions: ROLE_PERMISSIONS[role]
      },
      this.config.jwtSecret,
      { expiresIn: this.config.accessTokenExpiry }
    );
  }
  
  generateRefreshToken(userId) {
    return jwt.sign(
      {
        userId,
        type: TokenType.REFRESH,
        jti: randomBytes(16).toString('hex')
      },
      this.config.jwtSecret,
      { expiresIn: this.config.refreshTokenExpiry }
    );
  }
  
  verifyToken(token, expectedType) {
    try {
      const payload = jwt.verify(token, this.config.jwtSecret);
      
      if (payload.type !== expectedType) {
        return null;
      }
      
      return payload;
    } catch (error) {
      return null;
    }
  }
  
  generateApiKey() {
    const key = randomBytes(this.config.apiKeyLength).toString('base64url');
    return `${this.config.apiKeyPrefix}${key}`;
  }
  
  hashApiKey(apiKey) {
    return createHash('sha256').update(apiKey).digest('hex');
  }
  
  hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
  }
  
  generateSessionId() {
    return randomBytes(32).toString('hex');
  }
  
  generateSecret() {
    return randomBytes(64).toString('hex');
  }
  
  deriveEncryptionKey() {
    const secret = this.config.jwtSecret || this.generateSecret();
    return createHash('sha256').update(secret).digest();
  }
  
  encrypt(text) {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', this.config.encryptionKey, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
  }
  
  decrypt(encrypted) {
    const parts = encrypted.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const ciphertext = parts[2];
    
    const decipher = createDecipheriv('aes-256-gcm', this.config.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
  
  verify2FA(token, secret) {
    return speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token,
      window: 2
    });
  }
  
  validateUsername(username) {
    if (!username || username.length < 3 || username.length > 32) {
      throw new Error('Username must be between 3 and 32 characters');
    }
    
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      throw new Error('Username can only contain letters, numbers, underscores, and hyphens');
    }
  }
  
  validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      throw new Error('Invalid email address');
    }
  }
  
  validatePassword(password) {
    if (password.length < this.config.passwordMinLength) {
      throw new Error(`Password must be at least ${this.config.passwordMinLength} characters`);
    }
    
    const req = this.config.passwordRequirements;
    
    if (req.uppercase && !/[A-Z]/.test(password)) {
      throw new Error('Password must contain at least one uppercase letter');
    }
    
    if (req.lowercase && !/[a-z]/.test(password)) {
      throw new Error('Password must contain at least one lowercase letter');
    }
    
    if (req.numbers && !/[0-9]/.test(password)) {
      throw new Error('Password must contain at least one number');
    }
    
    if (req.special && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
      throw new Error('Password must contain at least one special character');
    }
  }
  
  validateBtcAddress(address) {
    // Basic Bitcoin address validation
    if (!/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/.test(address)) {
      throw new Error('Invalid Bitcoin address');
    }
  }
  
  checkRateLimit(identifier) {
    const key = `login_${identifier}`;
    const now = Date.now();
    const window = 300000; // 5 minutes
    const maxAttempts = 10;
    
    const attempts = this.rateLimits.get(key) || [];
    const recentAttempts = attempts.filter(time => time > now - window);
    
    if (recentAttempts.length >= maxAttempts) {
      throw new Error('Too many login attempts. Please try again later.');
    }
    
    recentAttempts.push(now);
    this.rateLimits.set(key, recentAttempts);
  }
  
  async recordLoginAttempt(username, ipAddress, success) {
    await this.db.run(
      'INSERT INTO login_attempts (username, ip_address, success) VALUES (?, ?, ?)',
      [username, ipAddress || 'unknown', success]
    );
  }
  
  async handleFailedLogin(userId, username, ipAddress) {
    await this.recordLoginAttempt(username, ipAddress, false);
    
    const result = await this.db.run(
      'UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = ?',
      [userId]
    );
    
    const user = await this.db.get(
      'SELECT failed_login_attempts FROM users WHERE id = ?',
      [userId]
    );
    
    if (user && user.failed_login_attempts >= this.config.maxLoginAttempts) {
      const lockoutUntil = new Date(Date.now() + this.config.lockoutDuration);
      await this.db.run(
        'UPDATE users SET locked_until = ? WHERE id = ?',
        [lockoutUntil.toISOString(), userId]
      );
    }
  }
  
  startCleanup() {
    // Clean expired sessions every hour
    setInterval(async () => {
      try {
        await this.db.run('DELETE FROM user_sessions WHERE expires_at < datetime("now")');
        await this.db.run('DELETE FROM password_resets WHERE expires_at < datetime("now")');
        
        // Clean rate limits
        const now = Date.now();
        const window = 300000; // 5 minutes
        
        for (const [key, attempts] of this.rateLimits) {
          const recent = attempts.filter(time => time > now - window);
          if (recent.length === 0) {
            this.rateLimits.delete(key);
          } else {
            this.rateLimits.set(key, recent);
          }
        }
        
        // Clean blacklist (tokens older than refresh expiry)
        // This would need more sophisticated handling in production
        
      } catch (error) {
        this.emit('error', { phase: 'cleanup', error });
      }
    }, 3600000); // 1 hour
  }

  /**
   * Get user profile
   */
  async getUserProfile(userId) {
    try {
      const user = await this.db.get(`
        SELECT id, username, email, role, btc_address, 
               two_factor_enabled, created_at, last_login
        FROM users 
        WHERE id = ?
      `, [userId]);
      
      if (!user) {
        throw new Error('User not found');
      }
      
      // Get active sessions count
      const sessions = await this.db.get(
        'SELECT COUNT(*) as count FROM user_sessions WHERE user_id = ? AND expires_at > datetime("now")',
        [userId]
      );
      
      // Get API keys count
      const apiKeys = await this.db.get(
        'SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?',
        [userId]
      );
      
      return {
        ...user,
        activeSessions: sessions.count,
        apiKeys: apiKeys.count
      };
      
    } catch (error) {
      this.emit('error', { phase: 'get_profile', error });
      throw error;
    }
  }

  /**
   * Update user profile
   */
  async updateUserProfile(userId, updates) {
    try {
      const allowedFields = ['email', 'btc_address'];
      const updateFields = [];
      const values = [];
      
      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          if (field === 'email') this.validateEmail(updates[field]);
          if (field === 'btc_address' && updates[field]) this.validateBtcAddress(updates[field]);
          
          updateFields.push(`${field} = ?`);
          values.push(updates[field]);
        }
      }
      
      if (updateFields.length === 0) {
        throw new Error('No valid fields to update');
      }
      
      values.push(userId);
      
      await this.db.run(
        `UPDATE users SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        values
      );
      
      this.emit('user:updated', { userId, updates });
      
      return { success: true };
      
    } catch (error) {
      this.emit('error', { phase: 'update_profile', error });
      throw error;
    }
  }

  /**
   * List user sessions
   */
  async getUserSessions(userId) {
    try {
      const sessions = await this.db.all(`
        SELECT id, ip_address, user_agent, created_at, last_activity, expires_at
        FROM user_sessions
        WHERE user_id = ? AND expires_at > datetime('now')
        ORDER BY last_activity DESC
      `, [userId]);
      
      return sessions;
      
    } catch (error) {
      this.emit('error', { phase: 'get_sessions', error });
      throw error;
    }
  }

  /**
   * Revoke session
   */
  async revokeSession(userId, sessionId) {
    try {
      const result = await this.db.run(
        'DELETE FROM user_sessions WHERE id = ? AND user_id = ?',
        [sessionId, userId]
      );
      
      if (result.changes === 0) {
        throw new Error('Session not found');
      }
      
      this.sessions.delete(sessionId);
      
      return { success: true };
      
    } catch (error) {
      this.emit('error', { phase: 'revoke_session', error });
      throw error;
    }
  }

  /**
   * Get authentication stats
   */
  async getStats() {
    try {
      const stats = await this.db.get(`
        SELECT 
          (SELECT COUNT(*) FROM users) as totalUsers,
          (SELECT COUNT(*) FROM users WHERE status = 'active') as activeUsers,
          (SELECT COUNT(*) FROM user_sessions WHERE expires_at > datetime('now')) as activeSessions,
          (SELECT COUNT(*) FROM api_keys) as totalApiKeys,
          (SELECT COUNT(*) FROM login_attempts WHERE success = 1 AND created_at > datetime('now', '-24 hours')) as successfulLogins24h,
          (SELECT COUNT(*) FROM login_attempts WHERE success = 0 AND created_at > datetime('now', '-24 hours')) as failedLogins24h
      `);
      
      return {
        ...stats,
        cacheStats: {
          sessions: this.sessions.size,
          apiKeys: this.apiKeys.size,
          blacklist: this.blacklist.size,
          rateLimits: this.rateLimits.size
        }
      };
      
    } catch (error) {
      this.emit('error', { phase: 'get_stats', error });
      throw error;
    }
  }

  /**
   * Shutdown
   */
  async shutdown() {
    // Clear caches
    this.sessions.clear();
    this.apiKeys.clear();
    this.blacklist.clear();
    this.rateLimits.clear();
    
    this.emit('shutdown');
  }
}

// Export factory function
export function createAuthenticationManager(dbManager, options) {
  return new AuthenticationManager(dbManager, options);
}

// Default export
export default AuthenticationManager;
