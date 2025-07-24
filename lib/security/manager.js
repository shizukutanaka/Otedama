/**
 * Security Manager for Otedama
 * Enterprise-grade security with national-level requirements
 * 
 * Security Features:
 * - Military-grade encryption (Carmack performance)
 * - Clean security abstractions (Martin principles)  
 * - Simple but robust APIs (Pike simplicity)
 */

import { EventEmitter } from 'events';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, pbkdf2Sync, timingSafeEqual } from 'crypto';
import { performance } from 'perf_hooks';

// Security constants
const SECURITY_CONSTANTS = Object.freeze({
  // Encryption
  ENCRYPTION_ALGORITHM: 'aes-256-gcm',
  KEY_LENGTH: 32,
  IV_LENGTH: 16,
  TAG_LENGTH: 16,
  SALT_LENGTH: 32,
  
  // Key derivation
  PBKDF2_ITERATIONS: 100000,
  SCRYPT_PARAMS: { N: 16384, r: 8, p: 1 },
  
  // Rate limiting
  DEFAULT_RATE_LIMIT: 100,
  DEFAULT_WINDOW: 60000, // 1 minute
  MAX_RATE_LIMIT_ENTRIES: 100000,
  
  // Session management
  SESSION_TIMEOUT: 3600000, // 1 hour
  SESSION_ID_LENGTH: 64,
  
  // Security headers
  SECURITY_HEADERS: {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  },
  
  // Audit levels
  AUDIT_LEVELS: {
    LOW: 1,
    MEDIUM: 2,
    HIGH: 3,
    CRITICAL: 4
  }
});

/**
 * High-performance encryption module
 */
class CryptoEngine {
  constructor() {
    // Pre-allocated buffers for performance
    this.keyBuffer = Buffer.allocUnsafe(SECURITY_CONSTANTS.KEY_LENGTH);
    this.ivBuffer = Buffer.allocUnsafe(SECURITY_CONSTANTS.IV_LENGTH);
    this.saltBuffer = Buffer.allocUnsafe(SECURITY_CONSTANTS.SALT_LENGTH);
  }
  
  // Generate cryptographically secure random key
  generateKey() {
    return randomBytes(SECURITY_CONSTANTS.KEY_LENGTH);
  }
  
  // Derive key from password using PBKDF2
  deriveKey(password, salt = null) {
    if (!salt) {
      salt = randomBytes(SECURITY_CONSTANTS.SALT_LENGTH);
    }
    
    const key = pbkdf2Sync(
      password,
      salt,
      SECURITY_CONSTANTS.PBKDF2_ITERATIONS,
      SECURITY_CONSTANTS.KEY_LENGTH,
      'sha256'
    );
    
    return { key, salt };
  }
  
  // Encrypt data with AES-256-GCM
  encrypt(data, key, additionalData = null) {
    const iv = randomBytes(SECURITY_CONSTANTS.IV_LENGTH);
    const cipher = createCipheriv(SECURITY_CONSTANTS.ENCRYPTION_ALGORITHM, key, iv);
    
    if (additionalData) {
      cipher.setAAD(additionalData);
    }
    
    let encrypted = cipher.update(data);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    const tag = cipher.getAuthTag();
    
    // Return IV + encrypted data + tag
    return Buffer.concat([iv, encrypted, tag]);
  }
  
  // Decrypt data with AES-256-GCM
  decrypt(encryptedData, key, additionalData = null) {
    if (encryptedData.length < SECURITY_CONSTANTS.IV_LENGTH + SECURITY_CONSTANTS.TAG_LENGTH) {
      throw new Error('Invalid encrypted data');
    }
    
    const iv = encryptedData.slice(0, SECURITY_CONSTANTS.IV_LENGTH);
    const tag = encryptedData.slice(-SECURITY_CONSTANTS.TAG_LENGTH);
    const encrypted = encryptedData.slice(SECURITY_CONSTANTS.IV_LENGTH, -SECURITY_CONSTANTS.TAG_LENGTH);
    
    const decipher = createDecipheriv(SECURITY_CONSTANTS.ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    if (additionalData) {
      decipher.setAAD(additionalData);
    }
    
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted;
  }
  
  // Create HMAC for data integrity
  createHMAC(data, key) {
    return createHmac('sha256', key).update(data).digest();
  }
  
  // Verify HMAC
  verifyHMAC(data, hmac, key) {
    const computedHmac = this.createHMAC(data, key);
    return timingSafeEqual(hmac, computedHmac);
  }
  
  // Secure hash function
  hash(data, algorithm = 'sha256') {
    return createHash(algorithm).update(data).digest();
  }
  
  // Generate secure random ID
  generateSecureId(length = 32) {
    return randomBytes(length).toString('hex');
  }
}

/**
 * Rate limiting system with sliding window
 */
class RateLimiter {
  constructor(options = {}) {
    this.limits = new Map(); // key -> { count, window, resets }
    this.defaultLimit = options.defaultLimit || SECURITY_CONSTANTS.DEFAULT_RATE_LIMIT;
    this.defaultWindow = options.defaultWindow || SECURITY_CONSTANTS.DEFAULT_WINDOW;
    this.maxEntries = options.maxEntries || SECURITY_CONSTANTS.MAX_RATE_LIMIT_ENTRIES;
    
    // Cleanup interval
    setInterval(() => this.cleanup(), this.defaultWindow);
  }
  
  // Check if request is allowed
  isAllowed(key, limit = this.defaultLimit, window = this.defaultWindow) {
    const now = Date.now();
    let entry = this.limits.get(key);
    
    if (!entry) {
      entry = {
        count: 0,
        window: now + window,
        resets: now + window
      };
      this.limits.set(key, entry);
    }
    
    // Reset if window expired
    if (now >= entry.window) {
      entry.count = 0;
      entry.window = now + window;
      entry.resets = now + window;
    }
    
    // Check limit
    if (entry.count >= limit) {
      return {
        allowed: false,
        count: entry.count,
        limit,
        remaining: 0,
        resets: entry.resets
      };
    }
    
    // Increment counter
    entry.count++;
    
    return {
      allowed: true,
      count: entry.count,
      limit,
      remaining: limit - entry.count,
      resets: entry.resets
    };
  }
  
  // Get current rate limit info
  getInfo(key) {
    const entry = this.limits.get(key);
    if (!entry) {
      return {
        count: 0,
        limit: this.defaultLimit,
        remaining: this.defaultLimit,
        resets: Date.now() + this.defaultWindow
      };
    }
    
    return {
      count: entry.count,
      limit: this.defaultLimit,
      remaining: Math.max(0, this.defaultLimit - entry.count),
      resets: entry.resets
    };
  }
  
  // Reset rate limit for key
  reset(key) {
    this.limits.delete(key);
  }
  
  // Cleanup expired entries
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of this.limits) {
      if (now >= entry.window) {
        this.limits.delete(key);
        cleaned++;
      }
    }
    
    // If still too many entries, remove oldest
    if (this.limits.size > this.maxEntries) {
      const entries = Array.from(this.limits.entries())
        .sort((a, b) => a[1].window - b[1].window);
      
      const toRemove = entries.slice(0, this.limits.size - this.maxEntries);
      for (const [key] of toRemove) {
        this.limits.delete(key);
        cleaned++;
      }
    }
    
    return cleaned;
  }
  
  getStats() {
    return {
      totalEntries: this.limits.size,
      maxEntries: this.maxEntries,
      defaultLimit: this.defaultLimit,
      defaultWindow: this.defaultWindow
    };
  }
}

/**
 * Session management system
 */
class SessionManager {
  constructor(options = {}) {
    this.sessions = new Map(); // sessionId -> session data
    this.userSessions = new Map(); // userId -> Set<sessionId>
    this.timeout = options.timeout || SECURITY_CONSTANTS.SESSION_TIMEOUT;
    this.crypto = new CryptoEngine();
    
    // Session cleanup
    setInterval(() => this.cleanup(), 300000); // Every 5 minutes
  }
  
  // Create new session
  createSession(userId, metadata = {}) {
    const sessionId = this.crypto.generateSecureId(SECURITY_CONSTANTS.SESSION_ID_LENGTH);
    const now = Date.now();
    
    const session = {
      id: sessionId,
      userId,
      createdAt: now,
      lastAccess: now,
      expiresAt: now + this.timeout,
      metadata,
      active: true
    };
    
    this.sessions.set(sessionId, session);
    
    // Track user sessions
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, new Set());
    }
    this.userSessions.get(userId).add(sessionId);
    
    return sessionId;
  }
  
  // Validate session
  validateSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { valid: false, reason: 'Session not found' };
    }
    
    if (!session.active) {
      return { valid: false, reason: 'Session inactive' };
    }
    
    if (Date.now() > session.expiresAt) {
      this.destroySession(sessionId);
      return { valid: false, reason: 'Session expired' };
    }
    
    // Update last access
    session.lastAccess = Date.now();
    session.expiresAt = Date.now() + this.timeout;
    
    return { valid: true, session };
  }
  
  // Update session data
  updateSession(sessionId, metadata) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    
    Object.assign(session.metadata, metadata);
    session.lastAccess = Date.now();
    
    return true;
  }
  
  // Destroy session
  destroySession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    
    // Remove from user sessions
    const userSessions = this.userSessions.get(session.userId);
    if (userSessions) {
      userSessions.delete(sessionId);
      if (userSessions.size === 0) {
        this.userSessions.delete(session.userId);
      }
    }
    
    this.sessions.delete(sessionId);
    return true;
  }
  
  // Destroy all user sessions
  destroyUserSessions(userId) {
    const userSessions = this.userSessions.get(userId);
    if (!userSessions) return 0;
    
    let destroyed = 0;
    for (const sessionId of userSessions) {
      if (this.sessions.delete(sessionId)) {
        destroyed++;
      }
    }
    
    this.userSessions.delete(userId);
    return destroyed;
  }
  
  // Get user sessions
  getUserSessions(userId) {
    const sessionIds = this.userSessions.get(userId);
    if (!sessionIds) return [];
    
    return Array.from(sessionIds)
      .map(id => this.sessions.get(id))
      .filter(session => session && session.active);
  }
  
  // Cleanup expired sessions
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [sessionId, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.destroySession(sessionId);
        cleaned++;
      }
    }
    
    return cleaned;
  }
  
  getStats() {
    return {
      totalSessions: this.sessions.size,
      activeUsers: this.userSessions.size,
      timeout: this.timeout
    };
  }
}

/**
 * Audit logging system
 */
class AuditLogger {
  constructor(database, options = {}) {
    this.database = database;
    this.enabled = options.enabled !== false;
    this.level = options.level || SECURITY_CONSTANTS.AUDIT_LEVELS.MEDIUM;
    this.retention = options.retention || 2592000000; // 30 days
    
    // Initialize audit table
    this.initializeDatabase();
    
    // Cleanup old logs
    setInterval(() => this.cleanup(), 86400000); // Daily
  }
  
  async initializeDatabase() {
    if (!this.database) return;
    
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        level INTEGER NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        user_id TEXT,
        ip_address TEXT,
        user_agent TEXT,
        details TEXT,
        success BOOLEAN NOT NULL,
        risk_score INTEGER DEFAULT 0
      );
      
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_logs(category);
    `);
  }
  
  // Log security event
  async log(event) {
    if (!this.enabled || event.level < this.level) return;
    
    const logEntry = {
      timestamp: Date.now(),
      level: event.level,
      category: event.category,
      action: event.action,
      userId: event.userId || null,
      ipAddress: event.ipAddress || null,
      userAgent: event.userAgent || null,
      details: JSON.stringify(event.details || {}),
      success: event.success !== false,
      riskScore: event.riskScore || 0
    };
    
    // Store in database if available
    if (this.database) {
      try {
        await this.database.run(`
          INSERT INTO audit_logs (timestamp, level, category, action, user_id, ip_address, user_agent, details, success, risk_score)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          logEntry.timestamp,
          logEntry.level,
          logEntry.category,
          logEntry.action,
          logEntry.userId,
          logEntry.ipAddress,
          logEntry.userAgent,
          logEntry.details,
          logEntry.success,
          logEntry.riskScore
        ]);
      } catch (error) {
        console.error('Failed to write audit log:', error);
      }
    }
    
    // Emit event for real-time monitoring
    this.emit('audit:logged', logEntry);
  }
  
  // Query audit logs
  async query(filters = {}) {
    if (!this.database) return [];
    
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    
    if (filters.startTime) {
      query += ' AND timestamp >= ?';
      params.push(filters.startTime);
    }
    
    if (filters.endTime) {
      query += ' AND timestamp <= ?';
      params.push(filters.endTime);
    }
    
    if (filters.userId) {
      query += ' AND user_id = ?';
      params.push(filters.userId);
    }
    
    if (filters.category) {
      query += ' AND category = ?';
      params.push(filters.category);
    }
    
    if (filters.level) {
      query += ' AND level >= ?';
      params.push(filters.level);
    }
    
    query += ' ORDER BY timestamp DESC';
    
    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }
    
    return this.database.all(query, params);
  }
  
  // Cleanup old logs
  async cleanup() {
    if (!this.database) return;
    
    const cutoff = Date.now() - this.retention;
    
    try {
      const result = await this.database.run(
        'DELETE FROM audit_logs WHERE timestamp < ?',
        [cutoff]
      );
      
      if (result.changes > 0) {
        console.log(`Cleaned up ${result.changes} old audit logs`);
      }
    } catch (error) {
      console.error('Failed to cleanup audit logs:', error);
    }
  }
}

/**
 * Main Security Manager
 */
export class SecurityManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = Object.freeze({
      encryptionEnabled: options.encryptionEnabled !== false,
      rateLimitEnabled: options.rateLimitEnabled !== false,
      sessionManagement: options.sessionManagement !== false,
      auditLogging: options.auditLogging !== false,
      ...options
    });
    
    // Core components
    this.crypto = new CryptoEngine();
    this.rateLimiter = new RateLimiter(options.rateLimit);
    this.sessionManager = new SessionManager(options.session);
    this.auditLogger = new AuditLogger(options.database, options.audit);
    
    // Security state
    this.masterKey = null;
    this.suspiciousIPs = new Map();
    this.blockedIPs = new Set();
    
    // Threat detection
    this.threatScores = new Map();
    this.attackPatterns = new Map();
    
    // Metrics
    this.metrics = {
      totalRequests: 0,
      blockedRequests: 0,
      suspiciousActivities: 0,
      authenticatedUsers: 0,
      activeSessions: 0
    };
    
    this.initialized = false;
  }
  
  async initialize() {
    if (this.initialized) return;
    
    // Generate or load master key
    this.masterKey = this.crypto.generateKey();
    
    // Start threat detection
    this.startThreatDetection();
    
    // Start metrics collection
    this.startMetricsCollection();
    
    this.initialized = true;
    this.emit('initialized');
  }
  
  // User authentication
  async authenticateUser(credentials) {
    const startTime = performance.now();
    
    try {
      // Rate limit check
      const rateLimitResult = this.rateLimiter.isAllowed(
        `auth:${credentials.username}`,
        5, // 5 attempts per minute
        60000
      );
      
      if (!rateLimitResult.allowed) {
        await this.auditLogger.log({
          level: SECURITY_CONSTANTS.AUDIT_LEVELS.HIGH,
          category: 'authentication',
          action: 'rate_limited',
          userId: credentials.username,
          ipAddress: credentials.ipAddress,
          success: false,
          riskScore: 8
        });
        
        throw new Error('Rate limit exceeded');
      }
      
      // Validate credentials (implement your validation logic)
      const user = await this.validateCredentials(credentials);
      
      if (!user) {
        await this.auditLogger.log({
          level: SECURITY_CONSTANTS.AUDIT_LEVELS.MEDIUM,
          category: 'authentication',
          action: 'failed_login',
          userId: credentials.username,
          ipAddress: credentials.ipAddress,
          success: false,
          riskScore: 5
        });
        
        throw new Error('Invalid credentials');
      }
      
      // Create session
      const sessionId = this.sessionManager.createSession(user.id, {
        ipAddress: credentials.ipAddress,
        userAgent: credentials.userAgent,
        loginTime: Date.now()
      });
      
      // Log successful authentication
      await this.auditLogger.log({
        level: SECURITY_CONSTANTS.AUDIT_LEVELS.LOW,
        category: 'authentication',
        action: 'successful_login',
        userId: user.id,
        ipAddress: credentials.ipAddress,
        userAgent: credentials.userAgent,
        success: true,
        details: { sessionId, loginTime: performance.now() - startTime }
      });
      
      this.metrics.authenticatedUsers++;
      
      return { user, sessionId };
      
    } catch (error) {
      // Update threat score
      this.updateThreatScore(credentials.ipAddress, 'failed_auth');
      
      throw error;
    }
  }
  
  // Session validation
  validateSession(sessionId, ipAddress = null) {
    const result = this.sessionManager.validateSession(sessionId);
    
    if (!result.valid) {
      return result;
    }
    
    // Additional security checks
    if (ipAddress && result.session.metadata.ipAddress !== ipAddress) {
      this.auditLogger.log({
        level: SECURITY_CONSTANTS.AUDIT_LEVELS.HIGH,
        category: 'session',
        action: 'ip_mismatch',
        userId: result.session.userId,
        ipAddress,
        success: false,
        riskScore: 9,
        details: {
          sessionIp: result.session.metadata.ipAddress,
          requestIp: ipAddress
        }
      });
      
      // Destroy suspicious session
      this.sessionManager.destroySession(sessionId);
      return { valid: false, reason: 'IP address mismatch' };
    }
    
    return result;
  }
  
  // Rate limiting middleware
  checkRateLimit(key, limit = null, window = null) {
    this.metrics.totalRequests++;
    
    const result = this.rateLimiter.isAllowed(key, limit, window);
    
    if (!result.allowed) {
      this.metrics.blockedRequests++;
      this.updateThreatScore(key, 'rate_limit_exceeded');
    }
    
    return result;
  }
  
  // IP blocking
  blockIP(ipAddress, duration = 3600000) { // 1 hour default
    this.blockedIPs.add(ipAddress);
    
    this.auditLogger.log({
      level: SECURITY_CONSTANTS.AUDIT_LEVELS.HIGH,
      category: 'security',
      action: 'ip_blocked',
      ipAddress,
      success: true,
      details: { duration }
    });
    
    // Auto-unblock after duration
    setTimeout(() => {
      this.blockedIPs.delete(ipAddress);
    }, duration);
  }
  
  // Check if IP is blocked
  isBlocked(ipAddress) {
    return this.blockedIPs.has(ipAddress);
  }
  
  // Encryption/Decryption
  encrypt(data, additionalData = null) {
    if (!this.config.encryptionEnabled) return data;
    return this.crypto.encrypt(data, this.masterKey, additionalData);
  }
  
  decrypt(encryptedData, additionalData = null) {
    if (!this.config.encryptionEnabled) return encryptedData;
    return this.crypto.decrypt(encryptedData, this.masterKey, additionalData);
  }
  
  // Hash functions
  hash(data, algorithm = 'sha256') {
    return this.crypto.hash(data, algorithm);
  }
  
  // HMAC functions
  createHMAC(data) {
    return this.crypto.createHMAC(data, this.masterKey);
  }
  
  verifyHMAC(data, hmac) {
    return this.crypto.verifyHMAC(data, hmac, this.masterKey);
  }
  
  // Threat detection
  startThreatDetection() {
    setInterval(() => {
      this.analyzeThreatPatterns();
    }, 60000); // Every minute
  }
  
  updateThreatScore(identifier, threatType) {
    const currentScore = this.threatScores.get(identifier) || 0;
    
    const scoreIncrements = {
      'failed_auth': 2,
      'rate_limit_exceeded': 3,
      'suspicious_request': 1,
      'malformed_request': 4,
      'sql_injection_attempt': 10,
      'xss_attempt': 8
    };
    
    const newScore = currentScore + (scoreIncrements[threatType] || 1);
    this.threatScores.set(identifier, newScore);
    
    // Auto-block if score too high
    if (newScore >= 15) {
      this.blockIP(identifier, 3600000); // 1 hour block
      this.threatScores.delete(identifier);
    }
    
    this.metrics.suspiciousActivities++;
  }
  
  analyzeThreatPatterns() {
    // Analyze patterns and update threat landscape
    // This is a simplified version - production would be more sophisticated
    
    for (const [identifier, score] of this.threatScores) {
      // Decay scores over time
      const newScore = Math.max(0, score - 1);
      
      if (newScore === 0) {
        this.threatScores.delete(identifier);
      } else {
        this.threatScores.set(identifier, newScore);
      }
    }
  }
  
  // Security headers
  getSecurityHeaders() {
    return { ...SECURITY_CONSTANTS.SECURITY_HEADERS };
  }
  
  // Input validation and sanitization
  validateInput(input, rules) {
    const errors = [];
    
    for (const [field, rule] of Object.entries(rules)) {
      const value = input[field];
      
      if (rule.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} is required`);
        continue;
      }
      
      if (value !== undefined && value !== null) {
        if (rule.type && typeof value !== rule.type) {
          errors.push(`${field} must be of type ${rule.type}`);
        }
        
        if (rule.minLength && value.length < rule.minLength) {
          errors.push(`${field} must be at least ${rule.minLength} characters`);
        }
        
        if (rule.maxLength && value.length > rule.maxLength) {
          errors.push(`${field} must be no more than ${rule.maxLength} characters`);
        }
        
        if (rule.pattern && !rule.pattern.test(value)) {
          errors.push(`${field} format is invalid`);
        }
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  // Metrics collection
  startMetricsCollection() {
    setInterval(() => {
      this.updateMetrics();
    }, 30000); // Every 30 seconds
  }
  
  updateMetrics() {
    this.metrics.activeSessions = this.sessionManager.getStats().totalSessions;
    
    this.emit('metrics:updated', this.metrics);
  }
  
  // SECURITY ENHANCED: Secure credential validation with bcrypt and database
  async validateCredentials(credentials) {
    try {
      // Input validation
      if (!credentials || !credentials.username || !credentials.password) {
        throw new Error('Missing required credentials');
      }
      
      // Validate credentials format
      const validation = this.validateInput(credentials, {
        username: {
          required: true,
          type: 'string',
          minLength: 3,
          maxLength: 50,
          pattern: /^[a-zA-Z0-9_.-]+$/
        },
        password: {
          required: true,
          type: 'string',
          minLength: 8
        }
      });
      
      if (!validation.valid) {
        throw new Error(`Invalid credentials format: ${validation.errors.join(', ')}`);
      }
      
      // Check for environment variables first (fallback for admin)
      const adminUsername = process.env.ADMIN_USERNAME;
      const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
      
      if (adminUsername && adminPasswordHash && credentials.username === adminUsername) {
        // Use bcrypt for password verification
        const bcrypt = require('bcrypt');
        const isValidPassword = await bcrypt.compare(credentials.password, adminPasswordHash);
        
        if (isValidPassword) {
          return {
            id: 'admin-user-id',
            username: adminUsername,
            role: 'administrator',
            authenticatedAt: Date.now(),
            permissions: ['admin', 'pool_management', 'user_management']
          };
        }
      }
      
      // Query database for user credentials (if database is configured)
      if (this.database) {
        const user = await this.database.get(
          'SELECT id, username, password_hash, role, active, failed_attempts, locked_until FROM users WHERE username = ?',
          [credentials.username]
        );
        
        if (!user) {
          // Still perform timing-safe comparison to prevent username enumeration
          const bcrypt = require('bcrypt');
          await bcrypt.compare(credentials.password, '$2b$10$dummy.hash.to.prevent.timing.attacks.for.nonexistent.users');
          throw new Error('Invalid credentials');
        }
        
        // Check if account is locked
        if (user.locked_until && Date.now() < user.locked_until) {
          throw new Error('Account temporarily locked due to failed attempts');
        }
        
        // Check if account is active
        if (!user.active) {
          throw new Error('Account is deactivated');
        }
        
        // Verify password with bcrypt
        const bcrypt = require('bcrypt');
        const isValidPassword = await bcrypt.compare(credentials.password, user.password_hash);
        
        if (!isValidPassword) {
          // Increment failed attempts
          await this.handleFailedLogin(user.id);
          throw new Error('Invalid credentials');
        }
        
        // Reset failed attempts on successful login
        await this.database.run(
          'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login = ? WHERE id = ?',
          [Date.now(), user.id]
        );
        
        return {
          id: user.id,
          username: user.username,
          role: user.role,
          authenticatedAt: Date.now(),
          permissions: await this.getUserPermissions(user.id)
        };
      }
      
      // If no valid authentication method is available
      throw new Error('Authentication system not properly configured');
      
    } catch (error) {
      // Log failed authentication attempts for security monitoring
      await this.auditLogger.log({
        level: SECURITY_CONSTANTS.AUDIT_LEVELS.MEDIUM,
        category: 'authentication',
        action: 'credential_validation_failed',
        userId: credentials.username,
        ipAddress: credentials.ipAddress,
        success: false,
        riskScore: 3,
        details: { error: error.message }
      });
      
      throw error;
    }
  }
  
  // Handle failed login attempts and account locking
  async handleFailedLogin(userId) {
    if (!this.database) return;
    
    const maxAttempts = 5;
    const lockDuration = 15 * 60 * 1000; // 15 minutes
    
    await this.database.run(`
      UPDATE users 
      SET failed_attempts = failed_attempts + 1,
          locked_until = CASE 
            WHEN failed_attempts + 1 >= ? THEN ?
            ELSE locked_until
          END
      WHERE id = ?
    `, [maxAttempts, Date.now() + lockDuration, userId]);
  }
  
  // Get user permissions from database
  async getUserPermissions(userId) {
    if (!this.database) return [];
    
    const permissions = await this.database.all(`
      SELECT p.permission_name 
      FROM user_permissions up
      JOIN permissions p ON up.permission_id = p.id
      WHERE up.user_id = ? AND up.active = 1
    `, [userId]);
    
    return permissions.map(p => p.permission_name);
  }
  
  // Timing-safe string comparison to prevent timing attacks
  timingSafeCompare(a, b) {
    if (a.length !== b.length) {
      return false;
    }
    
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a[i] ^ b[i];
    }
    
    return result === 0;
  }
  
  // Public API
  getMetrics() {
    return {
      ...this.metrics,
      rateLimiter: this.rateLimiter.getStats(),
      sessionManager: this.sessionManager.getStats(),
      threatScores: this.threatScores.size,
      blockedIPs: this.blockedIPs.size
    };
  }
  
  async shutdown() {
    // Cleanup resources
    this.initialized = false;
    this.emit('shutdown');
  }
}

export default SecurityManager;