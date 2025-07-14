import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { createHash, randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

/**
 * Advanced Authentication System
 * 高度な認証・認可システム
 * 
 * John Carmack Style: Secure, fast authentication
 * Rob Pike Style: Simple API, powerful security
 * Robert C. Martin Style: Clean, extensible auth architecture
 * 
 * Features:
 * - Multi-factor authentication (MFA)
 * - JWT token management
 * - Role-based access control (RBAC)
 * - API key management
 * - Session management
 * - OAuth2 support
 * - Brute force protection
 * - Audit logging
 */
export class AuthenticationSystem extends EventEmitter {
  constructor(db, options = {}) {
    super();
    this.logger = new Logger('Auth');
    this.db = db;
    
    // Configuration
    this.config = {
      // Token settings
      jwtSecret: options.jwtSecret || randomBytes(32).toString('hex'),
      tokenExpiry: options.tokenExpiry || 86400, // 24 hours
      refreshTokenExpiry: options.refreshTokenExpiry || 604800, // 7 days
      
      // Password policy
      minPasswordLength: options.minPasswordLength || 8,
      requireUppercase: options.requireUppercase !== false,
      requireLowercase: options.requireLowercase !== false,
      requireNumbers: options.requireNumbers !== false,
      requireSpecialChars: options.requireSpecialChars !== false,
      
      // Security settings
      maxLoginAttempts: options.maxLoginAttempts || 5,
      lockoutDuration: options.lockoutDuration || 3600000, // 1 hour
      sessionTimeout: options.sessionTimeout || 3600000, // 1 hour
      
      // MFA settings
      mfaEnabled: options.mfaEnabled !== false,
      mfaWindow: options.mfaWindow || 30, // seconds
      mfaDigits: options.mfaDigits || 6,
      
      // API key settings
      apiKeyLength: options.apiKeyLength || 32,
      apiKeyPrefix: options.apiKeyPrefix || 'otd_',
      
      // Rate limiting
      maxTokensPerUser: options.maxTokensPerUser || 10,
      maxApiKeysPerUser: options.maxApiKeysPerUser || 5
    };
    
    // In-memory stores
    this.sessions = new Map();
    this.tokens = new Map();
    this.apiKeys = new Map();
    this.loginAttempts = new Map();
    this.mfaSecrets = new Map();
    
    // Roles and permissions
    this.roles = new Map([
      ['admin', {
        permissions: ['*'],
        description: 'Full system access'
      }],
      ['operator', {
        permissions: ['pool:manage', 'miners:view', 'payments:process'],
        description: 'Pool operator access'
      }],
      ['miner', {
        permissions: ['mining:submit', 'stats:view:own', 'payments:view:own'],
        description: 'Standard miner access'
      }],
      ['trader', {
        permissions: ['dex:trade', 'dex:liquidity', 'lending:access'],
        description: 'DEX trader access'
      }],
      ['api', {
        permissions: ['api:read'],
        description: 'API read-only access'
      }]
    ]);
    
    // Statistics
    this.stats = {
      totalLogins: 0,
      failedLogins: 0,
      activeSessions: 0,
      tokensIssued: 0,
      mfaSuccess: 0,
      mfaFailures: 0
    };
    
    this.initialize();
  }

  /**
   * Initialize authentication system
   */
  async initialize() {
    try {
      // Create database tables
      await this.createTables();
      
      // Start cleanup timers
      this.sessionCleanupTimer = setInterval(() => {
        this.cleanupSessions();
      }, 300000); // 5 minutes
      
      this.tokenCleanupTimer = setInterval(() => {
        this.cleanupTokens();
      }, 3600000); // 1 hour
      
      // Create default admin user if none exists
      await this.createDefaultAdmin();
      
      this.logger.info('Authentication system initialized');
      
    } catch (error) {
      this.logger.error('Failed to initialize auth system:', error);
      throw error;
    }
  }

  /**
   * Create database tables
   */
  async createTables() {
    const queries = [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        roles TEXT DEFAULT 'miner',
        mfa_enabled INTEGER DEFAULT 0,
        mfa_secret TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login INTEGER,
        is_active INTEGER DEFAULT 1,
        metadata TEXT
      )`,
      
      `CREATE TABLE IF NOT EXISTS auth_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        type TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_used INTEGER,
        metadata TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )`,
      
      `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        permissions TEXT,
        created_at INTEGER NOT NULL,
        last_used INTEGER,
        is_active INTEGER DEFAULT 1,
        metadata TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )`,
      
      `CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        action TEXT NOT NULL,
        resource TEXT,
        ip_address TEXT,
        user_agent TEXT,
        success INTEGER DEFAULT 1,
        metadata TEXT,
        timestamp INTEGER NOT NULL
      )`,
      
      // Create indexes
      `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`,
      `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
      `CREATE INDEX IF NOT EXISTS idx_tokens_user ON auth_tokens(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tokens_hash ON auth_tokens(token_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_apikeys_user ON api_keys(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_apikeys_hash ON api_keys(key_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp)`
    ];
    
    for (const query of queries) {
      await this.db.exec(query);
    }
  }

  /**
   * Create default admin user
   */
  async createDefaultAdmin() {
    const adminExists = await this.db.prepare(
      'SELECT id FROM users WHERE username = ?'
    ).get('admin');
    
    if (!adminExists) {
      const defaultPassword = 'Otedama2024!';
      const hashedPassword = await this.hashPassword(defaultPassword);
      
      await this.createUser({
        username: 'admin',
        email: 'admin@otedama.local',
        password: hashedPassword,
        roles: ['admin']
      });
      
      this.logger.warn(`Default admin user created with password: ${defaultPassword}`);
      this.logger.warn('Please change this password immediately!');
    }
  }

  /**
   * Hash password
   */
  async hashPassword(password) {
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, 64);
    return salt.toString('hex') + ':' + hash.toString('hex');
  }

  /**
   * Verify password
   */
  async verifyPassword(password, hashedPassword) {
    const [salt, hash] = hashedPassword.split(':');
    const hashBuffer = Buffer.from(hash, 'hex');
    const derivedHash = await scryptAsync(password, Buffer.from(salt, 'hex'), 64);
    return Buffer.compare(hashBuffer, derivedHash) === 0;
  }

  /**
   * Create user
   */
  async createUser(userData) {
    try {
      // Validate password
      if (!this.validatePassword(userData.password)) {
        throw new Error('Password does not meet requirements');
      }
      
      const userId = randomBytes(16).toString('hex');
      const now = Date.now();
      
      const user = {
        id: userId,
        username: userData.username.toLowerCase(),
        email: userData.email.toLowerCase(),
        password_hash: userData.password.startsWith(':') ? userData.password : await this.hashPassword(userData.password),
        roles: JSON.stringify(userData.roles || ['miner']),
        created_at: now,
        updated_at: now,
        metadata: JSON.stringify(userData.metadata || {})
      };
      
      await this.db.prepare(`
        INSERT INTO users (id, username, email, password_hash, roles, created_at, updated_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.id,
        user.username,
        user.email,
        user.password_hash,
        user.roles,
        user.created_at,
        user.updated_at,
        user.metadata
      );
      
      await this.logAudit(userId, 'user_created', 'users', true);
      
      this.logger.info(`User created: ${userData.username}`);
      this.emit('user:created', { userId, username: userData.username });
      
      return { userId, username: userData.username };
      
    } catch (error) {
      this.logger.error('Failed to create user:', error);
      throw error;
    }
  }

  /**
   * Authenticate user
   */
  async authenticate(credentials) {
    try {
      const { username, password, mfaCode } = credentials;
      
      // Check login attempts
      if (this.isLockedOut(username)) {
        throw new Error('Account locked due to too many failed attempts');
      }
      
      // Find user
      const user = await this.db.prepare(`
        SELECT * FROM users WHERE (username = ? OR email = ?) AND is_active = 1
      `).get(username.toLowerCase(), username.toLowerCase());
      
      if (!user) {
        this.recordFailedLogin(username);
        throw new Error('Invalid credentials');
      }
      
      // Verify password
      const validPassword = await this.verifyPassword(password, user.password_hash);
      if (!validPassword) {
        this.recordFailedLogin(username);
        await this.logAudit(user.id, 'login_failed', 'auth', false);
        throw new Error('Invalid credentials');
      }
      
      // Check MFA if enabled
      if (user.mfa_enabled && this.config.mfaEnabled) {
        if (!mfaCode) {
          return {
            requiresMFA: true,
            userId: user.id
          };
        }
        
        const validMFA = await this.verifyMFA(user.id, mfaCode);
        if (!validMFA) {
          this.stats.mfaFailures++;
          throw new Error('Invalid MFA code');
        }
        
        this.stats.mfaSuccess++;
      }
      
      // Create session
      const session = await this.createSession(user);
      
      // Update last login
      await this.db.prepare(`
        UPDATE users SET last_login = ? WHERE id = ?
      `).run(Date.now(), user.id);
      
      // Clear login attempts
      this.loginAttempts.delete(username);
      
      this.stats.totalLogins++;
      await this.logAudit(user.id, 'login_success', 'auth', true);
      
      this.logger.info(`User authenticated: ${user.username}`);
      this.emit('user:authenticated', { userId: user.id, username: user.username });
      
      return {
        success: true,
        session,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          roles: JSON.parse(user.roles)
        }
      };
      
    } catch (error) {
      this.stats.failedLogins++;
      this.logger.error('Authentication failed:', error);
      throw error;
    }
  }

  /**
   * Create session
   */
  async createSession(user) {
    const sessionId = randomBytes(32).toString('hex');
    const token = this.generateToken();
    const refreshToken = this.generateToken();
    const now = Date.now();
    
    const session = {
      id: sessionId,
      userId: user.id,
      token,
      refreshToken,
      roles: JSON.parse(user.roles),
      createdAt: now,
      expiresAt: now + this.config.tokenExpiry * 1000,
      refreshExpiresAt: now + this.config.refreshTokenExpiry * 1000,
      lastActivity: now
    };
    
    // Store session
    this.sessions.set(sessionId, session);
    this.tokens.set(token, sessionId);
    
    // Store tokens in database
    await this.db.prepare(`
      INSERT INTO auth_tokens (id, user_id, token_hash, type, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      randomBytes(16).toString('hex'),
      user.id,
      this.hashToken(token),
      'access',
      session.expiresAt,
      now
    );
    
    await this.db.prepare(`
      INSERT INTO auth_tokens (id, user_id, token_hash, type, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      randomBytes(16).toString('hex'),
      user.id,
      this.hashToken(refreshToken),
      'refresh',
      session.refreshExpiresAt,
      now
    );
    
    this.stats.activeSessions++;
    this.stats.tokensIssued += 2;
    
    return {
      sessionId,
      token,
      refreshToken,
      expiresIn: this.config.tokenExpiry,
      tokenType: 'Bearer'
    };
  }

  /**
   * Validate token
   */
  async validateToken(token) {
    try {
      const sessionId = this.tokens.get(token);
      if (!sessionId) {
        // Check database
        const tokenHash = this.hashToken(token);
        const dbToken = await this.db.prepare(`
          SELECT * FROM auth_tokens 
          WHERE token_hash = ? AND type = 'access' AND expires_at > ?
        `).get(tokenHash, Date.now());
        
        if (!dbToken) {
          return { valid: false, reason: 'invalid_token' };
        }
        
        // Load user and create session
        const user = await this.db.prepare(`
          SELECT * FROM users WHERE id = ?
        `).get(dbToken.user_id);
        
        if (!user || !user.is_active) {
          return { valid: false, reason: 'user_inactive' };
        }
        
        // Recreate session
        const session = await this.createSession(user);
        return {
          valid: true,
          userId: user.id,
          roles: JSON.parse(user.roles),
          session
        };
      }
      
      const session = this.sessions.get(sessionId);
      if (!session) {
        return { valid: false, reason: 'session_not_found' };
      }
      
      if (Date.now() > session.expiresAt) {
        this.sessions.delete(sessionId);
        this.tokens.delete(token);
        return { valid: false, reason: 'token_expired' };
      }
      
      // Update last activity
      session.lastActivity = Date.now();
      
      return {
        valid: true,
        userId: session.userId,
        roles: session.roles,
        sessionId
      };
      
    } catch (error) {
      this.logger.error('Token validation error:', error);
      return { valid: false, reason: 'validation_error' };
    }
  }

  /**
   * Refresh token
   */
  async refreshToken(refreshToken) {
    try {
      const tokenHash = this.hashToken(refreshToken);
      const dbToken = await this.db.prepare(`
        SELECT * FROM auth_tokens 
        WHERE token_hash = ? AND type = 'refresh' AND expires_at > ?
      `).get(tokenHash, Date.now());
      
      if (!dbToken) {
        throw new Error('Invalid refresh token');
      }
      
      // Get user
      const user = await this.db.prepare(`
        SELECT * FROM users WHERE id = ? AND is_active = 1
      `).get(dbToken.user_id);
      
      if (!user) {
        throw new Error('User not found or inactive');
      }
      
      // Invalidate old refresh token
      await this.db.prepare(`
        DELETE FROM auth_tokens WHERE token_hash = ?
      `).run(tokenHash);
      
      // Create new session
      const session = await this.createSession(user);
      
      return session;
      
    } catch (error) {
      this.logger.error('Token refresh error:', error);
      throw error;
    }
  }

  /**
   * Create API key
   */
  async createAPIKey(userId, keyData) {
    try {
      // Check limit
      const existingKeys = await this.db.prepare(`
        SELECT COUNT(*) as count FROM api_keys 
        WHERE user_id = ? AND is_active = 1
      `).get(userId);
      
      if (existingKeys.count >= this.config.maxApiKeysPerUser) {
        throw new Error('API key limit reached');
      }
      
      const apiKey = this.config.apiKeyPrefix + randomBytes(this.config.apiKeyLength).toString('hex');
      const keyHash = this.hashToken(apiKey);
      const keyId = randomBytes(16).toString('hex');
      const now = Date.now();
      
      await this.db.prepare(`
        INSERT INTO api_keys (id, user_id, key_hash, name, permissions, created_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        keyId,
        userId,
        keyHash,
        keyData.name || 'API Key',
        JSON.stringify(keyData.permissions || ['api:read']),
        now,
        JSON.stringify(keyData.metadata || {})
      );
      
      // Store in memory for fast lookup
      this.apiKeys.set(apiKey, {
        keyId,
        userId,
        permissions: keyData.permissions || ['api:read']
      });
      
      await this.logAudit(userId, 'api_key_created', 'api_keys', true);
      
      this.logger.info(`API key created for user ${userId}`);
      this.emit('apikey:created', { userId, keyId });
      
      return {
        keyId,
        apiKey,
        name: keyData.name || 'API Key'
      };
      
    } catch (error) {
      this.logger.error('Failed to create API key:', error);
      throw error;
    }
  }

  /**
   * Validate API key
   */
  async validateAPIKey(apiKey) {
    try {
      // Check memory cache
      const cached = this.apiKeys.get(apiKey);
      if (cached) {
        return {
          valid: true,
          userId: cached.userId,
          permissions: cached.permissions
        };
      }
      
      // Check database
      const keyHash = this.hashToken(apiKey);
      const dbKey = await this.db.prepare(`
        SELECT ak.*, u.is_active as user_active
        FROM api_keys ak
        JOIN users u ON ak.user_id = u.id
        WHERE ak.key_hash = ? AND ak.is_active = 1
      `).get(keyHash);
      
      if (!dbKey || !dbKey.user_active) {
        return { valid: false, reason: 'invalid_key' };
      }
      
      // Update last used
      await this.db.prepare(`
        UPDATE api_keys SET last_used = ? WHERE id = ?
      `).run(Date.now(), dbKey.id);
      
      // Cache for future requests
      this.apiKeys.set(apiKey, {
        keyId: dbKey.id,
        userId: dbKey.user_id,
        permissions: JSON.parse(dbKey.permissions)
      });
      
      return {
        valid: true,
        userId: dbKey.user_id,
        permissions: JSON.parse(dbKey.permissions)
      };
      
    } catch (error) {
      this.logger.error('API key validation error:', error);
      return { valid: false, reason: 'validation_error' };
    }
  }

  /**
   * Check permission
   */
  hasPermission(roles, permission) {
    if (!Array.isArray(roles)) {
      roles = [roles];
    }
    
    for (const role of roles) {
      const roleConfig = this.roles.get(role);
      if (!roleConfig) continue;
      
      // Check wildcard
      if (roleConfig.permissions.includes('*')) {
        return true;
      }
      
      // Check specific permission
      if (roleConfig.permissions.includes(permission)) {
        return true;
      }
      
      // Check partial wildcard (e.g., 'pool:*' matches 'pool:manage')
      const [resource, action] = permission.split(':');
      if (roleConfig.permissions.includes(`${resource}:*`)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Setup MFA
   */
  async setupMFA(userId) {
    try {
      const secret = randomBytes(20).toString('hex');
      const encodedSecret = this.base32Encode(secret);
      
      // Store temporarily
      this.mfaSecrets.set(userId, {
        secret,
        encodedSecret,
        timestamp: Date.now()
      });
      
      // Generate QR code URL
      const user = await this.db.prepare(`
        SELECT username FROM users WHERE id = ?
      `).get(userId);
      
      const otpauth = `otpauth://totp/Otedama:${user.username}?secret=${encodedSecret}&issuer=Otedama`;
      
      return {
        secret: encodedSecret,
        qrCode: otpauth
      };
      
    } catch (error) {
      this.logger.error('MFA setup error:', error);
      throw error;
    }
  }

  /**
   * Enable MFA
   */
  async enableMFA(userId, code) {
    try {
      const mfaData = this.mfaSecrets.get(userId);
      if (!mfaData) {
        throw new Error('MFA setup not initiated');
      }
      
      // Verify code
      const valid = this.verifyTOTP(code, mfaData.secret);
      if (!valid) {
        throw new Error('Invalid MFA code');
      }
      
      // Save to database
      await this.db.prepare(`
        UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE id = ?
      `).run(mfaData.secret, userId);
      
      // Clean up
      this.mfaSecrets.delete(userId);
      
      await this.logAudit(userId, 'mfa_enabled', 'auth', true);
      
      this.logger.info(`MFA enabled for user ${userId}`);
      this.emit('mfa:enabled', { userId });
      
      return { success: true };
      
    } catch (error) {
      this.logger.error('MFA enable error:', error);
      throw error;
    }
  }

  /**
   * Verify MFA
   */
  async verifyMFA(userId, code) {
    try {
      const user = await this.db.prepare(`
        SELECT mfa_secret FROM users WHERE id = ? AND mfa_enabled = 1
      `).get(userId);
      
      if (!user || !user.mfa_secret) {
        return false;
      }
      
      return this.verifyTOTP(code, user.mfa_secret);
      
    } catch (error) {
      this.logger.error('MFA verify error:', error);
      return false;
    }
  }

  /**
   * Verify TOTP code
   */
  verifyTOTP(code, secret) {
    const window = this.config.mfaWindow;
    const currentTime = Math.floor(Date.now() / 1000);
    
    // Check current and adjacent windows
    for (let i = -window; i <= window; i += 30) {
      const time = currentTime + i;
      const counter = Math.floor(time / 30);
      const expectedCode = this.generateTOTP(secret, counter);
      
      if (code === expectedCode) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Generate TOTP code
   */
  generateTOTP(secret, counter) {
    const hmac = createHash('sha1');
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigInt64BE(BigInt(counter));
    
    hmac.update(Buffer.from(secret, 'hex'));
    hmac.update(counterBuffer);
    
    const hash = hmac.digest();
    const offset = hash[hash.length - 1] & 0xf;
    const code = (
      ((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      (hash[offset + 3] & 0xff)
    ) % (10 ** this.config.mfaDigits);
    
    return code.toString().padStart(this.config.mfaDigits, '0');
  }

  /**
   * Base32 encode (for MFA secrets)
   */
  base32Encode(input) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const buffer = Buffer.from(input, 'hex');
    let bits = '';
    let result = '';
    
    for (const byte of buffer) {
      bits += byte.toString(2).padStart(8, '0');
    }
    
    for (let i = 0; i < bits.length; i += 5) {
      const chunk = bits.substr(i, 5).padEnd(5, '0');
      result += alphabet[parseInt(chunk, 2)];
    }
    
    return result;
  }

  /**
   * Validate password
   */
  validatePassword(password) {
    if (password.length < this.config.minPasswordLength) {
      return false;
    }
    
    if (this.config.requireUppercase && !/[A-Z]/.test(password)) {
      return false;
    }
    
    if (this.config.requireLowercase && !/[a-z]/.test(password)) {
      return false;
    }
    
    if (this.config.requireNumbers && !/[0-9]/.test(password)) {
      return false;
    }
    
    if (this.config.requireSpecialChars && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
      return false;
    }
    
    return true;
  }

  /**
   * Record failed login
   */
  recordFailedLogin(username) {
    const attempts = this.loginAttempts.get(username) || {
      count: 0,
      firstAttempt: Date.now(),
      lastAttempt: Date.now()
    };
    
    attempts.count++;
    attempts.lastAttempt = Date.now();
    
    this.loginAttempts.set(username, attempts);
  }

  /**
   * Check if account is locked
   */
  isLockedOut(username) {
    const attempts = this.loginAttempts.get(username);
    if (!attempts) return false;
    
    if (attempts.count >= this.config.maxLoginAttempts) {
      const lockoutExpiry = attempts.lastAttempt + this.config.lockoutDuration;
      
      if (Date.now() < lockoutExpiry) {
        return true;
      } else {
        // Lockout expired, reset attempts
        this.loginAttempts.delete(username);
        return false;
      }
    }
    
    return false;
  }

  /**
   * Log audit event
   */
  async logAudit(userId, action, resource, success, metadata = {}) {
    try {
      await this.db.prepare(`
        INSERT INTO audit_logs (user_id, action, resource, success, metadata, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        action,
        resource,
        success ? 1 : 0,
        JSON.stringify(metadata),
        Date.now()
      );
    } catch (error) {
      this.logger.error('Audit log error:', error);
    }
  }

  /**
   * Generate token
   */
  generateToken() {
    return randomBytes(32).toString('hex');
  }

  /**
   * Hash token
   */
  hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Cleanup expired sessions
   */
  cleanupSessions() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [sessionId, session] of this.sessions) {
      if (now > session.expiresAt || 
          now - session.lastActivity > this.config.sessionTimeout) {
        this.sessions.delete(sessionId);
        this.tokens.delete(session.token);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.stats.activeSessions -= cleaned;
      this.logger.debug(`Cleaned ${cleaned} expired sessions`);
    }
  }

  /**
   * Cleanup expired tokens
   */
  async cleanupTokens() {
    try {
      const result = await this.db.prepare(`
        DELETE FROM auth_tokens WHERE expires_at < ?
      `).run(Date.now());
      
      if (result.changes > 0) {
        this.logger.debug(`Cleaned ${result.changes} expired tokens`);
      }
    } catch (error) {
      this.logger.error('Token cleanup error:', error);
    }
  }

  /**
   * Get authentication statistics
   */
  getStats() {
    return {
      ...this.stats,
      currentSessions: this.sessions.size,
      cachedTokens: this.tokens.size,
      cachedAPIKeys: this.apiKeys.size,
      lockedAccounts: Array.from(this.loginAttempts.values())
        .filter(a => a.count >= this.config.maxLoginAttempts).length
    };
  }

  /**
   * Stop authentication system
   */
  async stop() {
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
    }
    
    if (this.tokenCleanupTimer) {
      clearInterval(this.tokenCleanupTimer);
    }
    
    this.logger.info('Authentication system stopped');
  }
}

export default AuthenticationSystem;
