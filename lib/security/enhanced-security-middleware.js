/**
 * Enhanced Security Middleware for Otedama
 * Advanced security features with DDoS protection and threat detection
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import { getErrorHandler, OtedamaError, ErrorCategory, safeExecute } from '../error-handler.js';

// Security threat levels
export const ThreatLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

// Attack types
export const AttackType = {
  DDOS: 'ddos',
  BRUTE_FORCE: 'brute_force',
  SQL_INJECTION: 'sql_injection',
  XSS: 'xss',
  CSRF: 'csrf',
  RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',
  SUSPICIOUS_PATTERN: 'suspicious_pattern'
};

// Security actions
export const SecurityAction = {
  ALLOW: 'allow',
  BLOCK: 'block',
  THROTTLE: 'throttle',
  CHALLENGE: 'challenge',
  LOG: 'log'
};

export class EnhancedSecurityMiddleware extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Rate limiting
      rateLimit: {
        windowMs: options.rateLimitWindow || 60000, // 1 minute
        maxRequests: options.maxRequests || 100,
        userMaxRequests: options.userMaxRequests || 60, // per-user limit per window
        skipSuccessfulRequests: options.skipSuccessfulRequests || false,
        skipFailedRequests: options.skipFailedRequests || false
      },
      
      // DDoS protection
      ddosProtection: {
        enabled: options.ddosProtection !== false,
        threshold: options.ddosThreshold || 1000,
        windowMs: options.ddosWindow || 60000,
        blockDuration: options.ddosBlockDuration || 300000, // 5 minutes
        whitelistEnabled: options.whitelistEnabled || true
      },
      
      // Brute force protection
      bruteForceProtection: {
        enabled: options.bruteForceProtection !== false,
        maxAttempts: options.maxLoginAttempts || 5,
        lockoutDuration: options.lockoutDuration || 900000, // 15 minutes
        progressiveDelay: options.progressiveDelay || true
      },
      
      // Input validation
      inputValidation: {
        enabled: options.inputValidation !== false,
        maxBodySize: options.maxBodySize || 10 * 1024 * 1024, // 10MB
        sanitizeInput: options.sanitizeInput !== false,
        validateHeaders: options.validateHeaders !== false
      },
      
      // Encryption
      encryption: {
        algorithm: options.encryptionAlgorithm || 'aes-256-cbc',
        keyRotationInterval: options.keyRotationInterval || 86400000, // 24 hours
        sessionTimeout: options.sessionTimeout || 3600000 // 1 hour
      },
      
      // Monitoring
      monitoring: {
        enabled: options.monitoring !== false,
        logLevel: options.logLevel || 'info',
        alertThreshold: options.alertThreshold || ThreatLevel.HIGH
      },
      
      ...options
    };
    
    this.state = {
      requestCounts: new Map(),
      userRequestCounts: new Map(),
      blockedIPs: new Map(),
      failedAttempts: new Map(),
      suspiciousPatterns: new Map(),
      encryptionKeys: new Map(),
      sessions: new Map()
    };
    
    this.metrics = {
      totalRequests: 0,
      blockedRequests: 0,
      throttledRequests: 0,
      challengedRequests: 0,
      detectedAttacks: {
        ddos: 0,
        bruteForce: 0,
        sqlInjection: 0,
        xss: 0,
        csrf: 0,
        rateLimitExceeded: 0,
        suspiciousPattern: 0
      },
      securityEvents: []
    };
    
    this.patterns = {
      sqlInjection: [
        /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION)\b)/i,
        /(\b(OR|AND)\s+\d+\s*=\s*\d+)/i,
        /('|(\\')|(;)|(--)|(\s*(or|and)\s*\d+\s*=\s*\d+))/i
      ],
      xss: [
        /<script[^>]*>.*?<\/script>/gi,
        /javascript:/gi,
        /on\w+\s*=/gi,
        /<iframe[^>]*>.*?<\/iframe>/gi
      ],
      pathTraversal: [
        /\.\.\//g,
        /\.\.\\/g,
        /%2e%2e%2f/gi,
        /%2e%2e%5c/gi
      ]
    };
    
    this.timers = new Map();
    this.errorHandler = getErrorHandler();
    
    this.startSecurityMonitoring();
    this.initializeEncryption();
  }
  
  /**
   * Start security monitoring
   */
  startSecurityMonitoring() {
    // Cleanup expired entries
    const cleanupTimer = setInterval(() => {
      this.cleanupExpiredEntries();
    }, 60000); // Every minute
    
    this.timers.set('cleanup', cleanupTimer);
    
    // Rotate encryption keys
    if (this.options.encryption.keyRotationInterval) {
      const keyRotationTimer = setInterval(() => {
        this.rotateEncryptionKeys();
      }, this.options.encryption.keyRotationInterval);
      
      this.timers.set('keyRotation', keyRotationTimer);
    }
    
    // Security metrics collection
    const metricsTimer = setInterval(() => {
      this.collectSecurityMetrics();
    }, 300000); // Every 5 minutes
    
    this.timers.set('metrics', metricsTimer);
  }
  
  /**
   * Initialize encryption system
   */
  initializeEncryption() {
    this.generateEncryptionKey('primary');
    this.generateEncryptionKey('secondary');
  }
  
  /**
   * Main security middleware function
   */
  async securityCheck(req, res, next) {
    this.metrics.totalRequests++;
    
    try {
      const clientIP = this.getClientIP(req);
      const userAgent = req.headers['user-agent'] || '';
      const userId = (req.user && req.user.id) || req.headers['x-user-id'] || null;
      const requestData = {
        ip: clientIP,
        userId,
        userAgent,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        timestamp: Date.now()
      };
      
      // Check if IP is blocked
      if (this.isIPBlocked(clientIP)) {
        this.handleSecurityAction(SecurityAction.BLOCK, requestData, AttackType.DDOS);
        return this.sendSecurityResponse(res, 403, 'IP blocked due to security violation');
      }
      
      // Rate limiting check
      const rateLimitResult = await this.checkRateLimit(requestData);
      if (rateLimitResult.action !== SecurityAction.ALLOW) {
        this.handleSecurityAction(rateLimitResult.action, requestData, AttackType.RATE_LIMIT_EXCEEDED);
        
        if (rateLimitResult.action === SecurityAction.BLOCK) {
          return this.sendSecurityResponse(res, 429, 'Rate limit exceeded');
        }
      }
      
      // DDoS protection
      if (this.options.ddosProtection.enabled) {
        const ddosResult = await this.checkDDoSProtection(requestData);
        if (ddosResult.action !== SecurityAction.ALLOW) {
          this.handleSecurityAction(ddosResult.action, requestData, AttackType.DDOS);
          
          if (ddosResult.action === SecurityAction.BLOCK) {
            return this.sendSecurityResponse(res, 503, 'Service temporarily unavailable');
          }
        }
      }
      
      // Input validation
      if (this.options.inputValidation.enabled) {
        const validationResult = await this.validateInput(requestData);
        if (validationResult.threats.length > 0) {
          for (const threat of validationResult.threats) {
            this.handleSecurityAction(SecurityAction.BLOCK, requestData, threat.type);
          }
          return this.sendSecurityResponse(res, 400, 'Invalid input detected');
        }
      }
      
      // Brute force protection
      if (this.options.bruteForceProtection.enabled && this.isAuthenticationRequest(req)) {
        const bruteForceResult = await this.checkBruteForceProtection(requestData);
        if (bruteForceResult.action !== SecurityAction.ALLOW) {
          this.handleSecurityAction(bruteForceResult.action, requestData, AttackType.BRUTE_FORCE);
          
          if (bruteForceResult.action === SecurityAction.BLOCK) {
            return this.sendSecurityResponse(res, 423, 'Account temporarily locked');
          }
        }
      }
      
      // Pattern-based threat detection
      const patternResult = await this.detectSuspiciousPatterns(requestData);
      if (patternResult.threats.length > 0) {
        for (const threat of patternResult.threats) {
          this.handleSecurityAction(SecurityAction.LOG, requestData, threat.type);
          
          if (threat.level === ThreatLevel.CRITICAL) {
            this.handleSecurityAction(SecurityAction.BLOCK, requestData, threat.type);
            return this.sendSecurityResponse(res, 403, 'Suspicious activity detected');
          }
        }
      }
      
      // Add security headers
      this.addSecurityHeaders(res);
      
      // Continue to next middleware
      next();
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        context: 'security_middleware',
        category: ErrorCategory.SECURITY
      });
      
      // Fail securely - block on error
      return this.sendSecurityResponse(res, 500, 'Security check failed');
    }
  }
  
  /**
   * Check rate limiting
   */
  async checkRateLimit(requestData) {
    const { ip, userId } = requestData;
    const now = Date.now();
    const windowStart = now - this.options.rateLimit.windowMs;
    
    // ---------- IP-based rate limit ----------
    if (!this.state.requestCounts.has(ip)) {
      this.state.requestCounts.set(ip, []);
    }
    const ipRequests = this.state.requestCounts.get(ip).filter(ts => ts > windowStart);
    this.state.requestCounts.set(ip, ipRequests);
    ipRequests.push(now);
    if (ipRequests.length > this.options.rateLimit.maxRequests) {
      return { action: SecurityAction.BLOCK, reason: 'Rate limit exceeded (IP)' };
    }
    if (ipRequests.length > this.options.rateLimit.maxRequests * 0.8) {
      return { action: SecurityAction.THROTTLE, reason: 'Approaching rate limit (IP)' };
    }
    
    // ---------- User-based rate limit ----------
    if (userId) {
      if (!this.state.userRequestCounts.has(userId)) {
        this.state.userRequestCounts.set(userId, []);
      }
      const userRequests = this.state.userRequestCounts.get(userId).filter(ts => ts > windowStart);
      this.state.userRequestCounts.set(userId, userRequests);
      userRequests.push(now);
      if (userRequests.length > this.options.rateLimit.userMaxRequests) {
        return { action: SecurityAction.BLOCK, reason: 'Rate limit exceeded (User)' };
      }
      if (userRequests.length > this.options.rateLimit.userMaxRequests * 0.8) {
        return { action: SecurityAction.THROTTLE, reason: 'Approaching rate limit (User)' };
      }
    }
    
    return { action: SecurityAction.ALLOW };
  }
  
  /**
   * Check DDoS protection
   */
  async checkDDoSProtection(requestData) {
    const { ip } = requestData;
    const now = Date.now();
    const windowStart = now - this.options.ddosProtection.windowMs;
    
    if (!this.state.requestCounts.has(ip)) {
      this.state.requestCounts.set(ip, []);
    }
    
    const requests = this.state.requestCounts.get(ip);
    const recentRequests = requests.filter(timestamp => timestamp > windowStart);
    
    if (recentRequests.length > this.options.ddosProtection.threshold) {
      // Block IP
      this.blockIP(ip, this.options.ddosProtection.blockDuration);
      return { action: SecurityAction.BLOCK, reason: 'DDoS attack detected' };
    }
    
    return { action: SecurityAction.ALLOW };
  }
  
  /**
   * Validate input for security threats
   */
  async validateInput(requestData) {
    const threats = [];
    const { body, url, headers } = requestData;
    
    // Check URL for path traversal
    if (this.patterns.pathTraversal.some(pattern => pattern.test(url))) {
      threats.push({
        type: AttackType.SUSPICIOUS_PATTERN,
        level: ThreatLevel.HIGH,
        details: 'Path traversal attempt detected'
      });
    }
    
    // Check body for SQL injection
    if (body && typeof body === 'string') {
      if (this.patterns.sqlInjection.some(pattern => pattern.test(body))) {
        threats.push({
          type: AttackType.SQL_INJECTION,
          level: ThreatLevel.CRITICAL,
          details: 'SQL injection attempt detected'
        });
      }
      
      // Check for XSS
      if (this.patterns.xss.some(pattern => pattern.test(body))) {
        threats.push({
          type: AttackType.XSS,
          level: ThreatLevel.HIGH,
          details: 'XSS attempt detected'
        });
      }
    }
    
    // Check headers for suspicious content
    for (const [headerName, headerValue] of Object.entries(headers)) {
      if (typeof headerValue === 'string') {
        if (this.patterns.xss.some(pattern => pattern.test(headerValue))) {
          threats.push({
            type: AttackType.XSS,
            level: ThreatLevel.MEDIUM,
            details: `XSS attempt in header: ${headerName}`
          });
        }
      }
    }
    
    return { threats };
  }
  
  /**
   * Check brute force protection
   */
  async checkBruteForceProtection(requestData) {
    const { ip } = requestData;
    const now = Date.now();
    
    if (!this.state.failedAttempts.has(ip)) {
      this.state.failedAttempts.set(ip, {
        count: 0,
        lastAttempt: now,
        lockoutUntil: 0
      });
    }
    
    const attempts = this.state.failedAttempts.get(ip);
    
    // Check if still locked out
    if (attempts.lockoutUntil > now) {
      return { action: SecurityAction.BLOCK, reason: 'Account locked due to brute force' };
    }
    
    // Reset if lockout period has passed
    if (attempts.lockoutUntil > 0 && attempts.lockoutUntil <= now) {
      attempts.count = 0;
      attempts.lockoutUntil = 0;
    }
    
    return { action: SecurityAction.ALLOW };
  }
  
  /**
   * Detect suspicious patterns
   */
  async detectSuspiciousPatterns(requestData) {
    const threats = [];
    const { ip, userAgent, url, method } = requestData;
    
    // Check for suspicious user agents
    const suspiciousUserAgents = [
      /bot/i,
      /crawler/i,
      /scanner/i,
      /sqlmap/i,
      /nikto/i
    ];
    
    if (suspiciousUserAgents.some(pattern => pattern.test(userAgent))) {
      threats.push({
        type: AttackType.SUSPICIOUS_PATTERN,
        level: ThreatLevel.MEDIUM,
        details: 'Suspicious user agent detected'
      });
    }
    
    // Check for rapid sequential requests
    if (this.state.requestCounts.has(ip)) {
      const requests = this.state.requestCounts.get(ip);
      const recentRequests = requests.slice(-10);
      
      if (recentRequests.length >= 10) {
        const timeSpan = recentRequests[recentRequests.length - 1] - recentRequests[0];
        if (timeSpan < 1000) { // 10 requests in less than 1 second
          threats.push({
            type: AttackType.SUSPICIOUS_PATTERN,
            level: ThreatLevel.HIGH,
            details: 'Rapid sequential requests detected'
          });
        }
      }
    }
    
    return { threats };
  }
  
  /**
   * Handle security action
   */
  handleSecurityAction(action, requestData, attackType) {
    const securityEvent = {
      timestamp: Date.now(),
      action,
      attackType,
      ip: requestData.ip,
      userAgent: requestData.userAgent,
      url: requestData.url,
      method: requestData.method
    };
    
    // Update metrics
    this.metrics.detectedAttacks[attackType]++;
    this.metrics.securityEvents.push(securityEvent);
    
    // Keep only recent events
    if (this.metrics.securityEvents.length > 1000) {
      this.metrics.securityEvents.shift();
    }
    
    // Update counters
    switch (action) {
      case SecurityAction.BLOCK:
        this.metrics.blockedRequests++;
        break;
      case SecurityAction.THROTTLE:
        this.metrics.throttledRequests++;
        break;
      case SecurityAction.CHALLENGE:
        this.metrics.challengedRequests++;
        break;
    }
    
    // Emit security event
    this.emit('securityEvent', securityEvent);
    
    // Log based on threat level
    const threatLevel = this.getThreatLevel(attackType);
    if (threatLevel >= this.options.monitoring.alertThreshold) {
      this.emit('securityAlert', securityEvent);
    }
  }
  
  /**
   * Get threat level for attack type
   */
  getThreatLevel(attackType) {
    const threatLevels = {
      [AttackType.DDOS]: ThreatLevel.CRITICAL,
      [AttackType.BRUTE_FORCE]: ThreatLevel.HIGH,
      [AttackType.SQL_INJECTION]: ThreatLevel.CRITICAL,
      [AttackType.XSS]: ThreatLevel.HIGH,
      [AttackType.CSRF]: ThreatLevel.MEDIUM,
      [AttackType.RATE_LIMIT_EXCEEDED]: ThreatLevel.MEDIUM,
      [AttackType.SUSPICIOUS_PATTERN]: ThreatLevel.LOW
    };
    
    return threatLevels[attackType] || ThreatLevel.LOW;
  }
  
  /**
   * Block IP address
   */
  blockIP(ip, duration) {
    const blockUntil = Date.now() + duration;
    this.state.blockedIPs.set(ip, blockUntil);
    
    this.emit('ipBlocked', { ip, blockUntil });
  }
  
  /**
   * Check if IP is blocked
   */
  isIPBlocked(ip) {
    if (!this.state.blockedIPs.has(ip)) return false;
    
    const blockUntil = this.state.blockedIPs.get(ip);
    if (Date.now() > blockUntil) {
      this.state.blockedIPs.delete(ip);
      return false;
    }
    
    return true;
  }
  
  /**
   * Check if request is authentication-related
   */
  isAuthenticationRequest(req) {
    const authPaths = ['/login', '/auth', '/signin', '/api/auth'];
    return authPaths.some(path => req.url.includes(path));
  }
  
  /**
   * Get client IP address
   */
  getClientIP(req) {
    return req.headers['x-forwarded-for'] ||
           req.headers['x-real-ip'] ||
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           '127.0.0.1';
  }
  
  /**
   * Add security headers
   */
  addSecurityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  
  /**
   * Send security response
   */
  sendSecurityResponse(res, statusCode, message) {
    res.status(statusCode).json({
      error: message,
      timestamp: new Date().toISOString()
    });
  }
  
  /**
   * Generate encryption key
   */
  generateEncryptionKey(keyName) {
    const key = randomBytes(32);
    this.state.encryptionKeys.set(keyName, {
      key,
      created: Date.now(),
      used: 0
    });
  }
  
  /**
   * Rotate encryption keys
   */
  rotateEncryptionKeys() {
    // Move primary to secondary
    const primaryKey = this.state.encryptionKeys.get('primary');
    if (primaryKey) {
      this.state.encryptionKeys.set('secondary', primaryKey);
    }
    
    // Generate new primary key
    this.generateEncryptionKey('primary');
    
    this.emit('keyRotated', { timestamp: Date.now() });
  }
  
  /**
   * Cleanup expired entries
   */
  cleanupExpiredEntries() {
    const now = Date.now();
    
    // Cleanup blocked IPs
    for (const [ip, blockUntil] of this.state.blockedIPs) {
      if (now > blockUntil) {
        this.state.blockedIPs.delete(ip);
      }
    }
    
    // Cleanup old request counts
    for (const [ip, requests] of this.state.requestCounts) {
      const recentRequests = requests.filter(timestamp => 
        now - timestamp < this.options.rateLimit.windowMs
      );
      
      if (recentRequests.length === 0) {
        this.state.requestCounts.delete(ip);
      } else {
        this.state.requestCounts.set(ip, recentRequests);
      }
    }
    
    // Cleanup failed attempts
    for (const [ip, attempts] of this.state.failedAttempts) {
      if (attempts.lockoutUntil > 0 && now > attempts.lockoutUntil + 3600000) {
        this.state.failedAttempts.delete(ip);
      }
    }
  }
  
  /**
   * Collect security metrics
   */
  collectSecurityMetrics() {
    const metrics = {
      timestamp: Date.now(),
      totalRequests: this.metrics.totalRequests,
      blockedRequests: this.metrics.blockedRequests,
      throttledRequests: this.metrics.throttledRequests,
      challengedRequests: this.metrics.challengedRequests,
      detectedAttacks: { ...this.metrics.detectedAttacks },
      blockedIPs: this.state.blockedIPs.size,
      activeRateLimits: this.state.requestCounts.size,
      failedAttempts: this.state.failedAttempts.size
    };
    
    this.emit('securityMetrics', metrics);
  }
  
  /**
   * Get security status
   */
  getSecurityStatus() {
    return {
      metrics: { ...this.metrics },
      state: {
        blockedIPs: this.state.blockedIPs.size,
        activeRateLimits: this.state.requestCounts.size,
        failedAttempts: this.state.failedAttempts.size,
        encryptionKeys: this.state.encryptionKeys.size
      },
      recentEvents: this.metrics.securityEvents.slice(-50)
    };
  }
  
  /**
   * Cleanup resources
   */
  cleanup() {
    // Clear all timers
    for (const [name, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    
    // Clear state
    this.state.requestCounts.clear();
    this.state.blockedIPs.clear();
    this.state.failedAttempts.clear();
    this.state.suspiciousPatterns.clear();
    this.state.encryptionKeys.clear();
    this.state.sessions.clear();
    
    // Remove all listeners
    this.removeAllListeners();
  }
}

export default EnhancedSecurityMiddleware;
