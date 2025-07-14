import { EventEmitter } from 'events';
import { createHash, randomBytes, pbkdf2Sync, timingSafeEqual } from 'crypto';
import { Logger } from './logger.js';
import { TIME_CONSTANTS, ERROR_CODES } from './constants.js';

/**
 * Advanced Security Manager
 * 高度なセキュリティマネージャ
 * 
 * Features:
 * - API key management and validation
 * - Rate limiting with sliding window
 * - Intrusion detection and prevention
 * - Input validation and sanitization
 * - Session management
 * - Security headers enforcement
 * - Cryptographic operations
 * - Security audit logging
 */
export class SecurityManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = new Logger('Security');
    this.options = {
      enableRateLimit: options.enableRateLimit !== false,
      enableAuth: options.enableAuth || false,
      enableIDS: options.enableIDS !== false,
      enableAuditLog: options.enableAuditLog !== false,
      maxRequestsPerMinute: options.maxRequestsPerMinute || 100,
      maxRequestsPerHour: options.maxRequestsPerHour || 1000,
      blockDuration: options.blockDuration || TIME_CONSTANTS.hour,
      maxFailedAttempts: options.maxFailedAttempts || 5,
      sessionTimeout: options.sessionTimeout || TIME_CONSTANTS.hour,
      keyDerivationIterations: options.keyDerivationIterations || 100000,
      ...options
    };

    // Security state
    this.apiKeys = new Map();
    this.rateLimits = new Map();
    this.blockedIPs = new Map();
    this.sessions = new Map();
    this.securityEvents = [];
    this.suspiciousActivities = new Map();
    
    // Attack patterns
    this.attackPatterns = [
      /union\s+select/i,
      /script\s*>/i,
      /<\s*script/i,
      /javascript:/i,
      /on\w+\s*=/i,
      /exec\s*\(/i,
      /eval\s*\(/i,
      /\.\.\/\.\.\//,
      /\/etc\/passwd/,
      /cmd\.exe/i,
      /powershell/i
    ];

    // Security metrics
    this.metrics = {
      requestsBlocked: 0,
      attacksDetected: 0,
      failedAuthentications: 0,
      rateLimitExceeded: 0,
      suspiciousActivities: 0,
      startTime: Date.now()
    };

    this.initialize();
  }

  /**
   * Initialize security system
   */
  initialize() {
    try {
      // Start cleanup timer
      this.cleanupTimer = setInterval(() => {
        this.cleanup();
      }, TIME_CONSTANTS.hour);

      // Start metrics collection
      this.metricsTimer = setInterval(() => {
        this.collectMetrics();
      }, TIME_CONSTANTS.minute);

      this.logger.info('Security Manager initialized');
      this.logSecurityEvent('system', 'security_manager_started', 'Security system initialization completed');

    } catch (error) {
      this.logger.error('Failed to initialize Security Manager:', error);
      throw error;
    }
  }

  /**
   * Generate secure API key
   */
  generateAPIKey(userId, permissions = ['read']) {
    try {
      const keyData = randomBytes(32);
      const timestamp = Date.now();
      const keyString = keyData.toString('hex');
      
      const apiKey = {
        key: keyString,
        userId,
        permissions,
        createdAt: timestamp,
        lastUsed: timestamp,
        usageCount: 0,
        isActive: true,
        rateLimitRemaining: this.options.maxRequestsPerHour
      };

      this.apiKeys.set(keyString, apiKey);
      
      this.logger.info(`Generated API key for user: ${userId}`);
      this.logSecurityEvent(userId, 'api_key_generated', `New API key generated with permissions: ${permissions.join(', ')}`);
      
      return keyString;
    } catch (error) {
      this.logger.error('Failed to generate API key:', error);
      throw error;
    }
  }

  /**
   * Validate API key
   */
  validateAPIKey(keyString) {
    try {
      if (!keyString || typeof keyString !== 'string') {
        return { valid: false, reason: 'Invalid key format' };
      }

      const apiKey = this.apiKeys.get(keyString);
      
      if (!apiKey) {
        this.metrics.failedAuthentications++;
        this.logSecurityEvent('unknown', 'invalid_api_key', `Invalid API key attempted: ${keyString.substring(0, 8)}...`);
        return { valid: false, reason: 'Key not found' };
      }

      if (!apiKey.isActive) {
        this.logSecurityEvent(apiKey.userId, 'inactive_api_key', 'Attempt to use inactive API key');
        return { valid: false, reason: 'Key inactive' };
      }

      // Update usage
      apiKey.lastUsed = Date.now();
      apiKey.usageCount++;

      return { 
        valid: true, 
        userId: apiKey.userId, 
        permissions: apiKey.permissions,
        apiKey 
      };
    } catch (error) {
      this.logger.error('API key validation error:', error);
      return { valid: false, reason: 'Validation error' };
    }
  }

  /**
   * Check rate limits with sliding window
   */
  checkRateLimit(identifier, requestType = 'general') {
    try {
      if (!this.options.enableRateLimit) {
        return { allowed: true, remaining: 999 };
      }

      const now = Date.now();
      const windowSize = TIME_CONSTANTS.minute;
      const hourWindowSize = TIME_CONSTANTS.hour;
      
      const key = `${identifier}:${requestType}`;
      const limit = this.rateLimits.get(key) || {
        minuteRequests: [],
        hourRequests: [],
        blockedUntil: 0
      };

      // Check if currently blocked
      if (limit.blockedUntil > now) {
        this.metrics.rateLimitExceeded++;
        return { 
          allowed: false, 
          reason: 'Rate limit exceeded',
          retryAfter: Math.ceil((limit.blockedUntil - now) / 1000)
        };
      }

      // Clean old requests
      limit.minuteRequests = limit.minuteRequests.filter(time => now - time < windowSize);
      limit.hourRequests = limit.hourRequests.filter(time => now - time < hourWindowSize);

      // Check minute limit
      if (limit.minuteRequests.length >= this.options.maxRequestsPerMinute) {
        limit.blockedUntil = now + TIME_CONSTANTS.minute;
        this.rateLimits.set(key, limit);
        
        this.logger.warn(`Rate limit exceeded for ${identifier}: ${limit.minuteRequests.length} requests in last minute`);
        this.logSecurityEvent(identifier, 'rate_limit_exceeded', `Minute rate limit exceeded: ${limit.minuteRequests.length} requests`);
        
        return { allowed: false, reason: 'Minute rate limit exceeded', retryAfter: 60 };
      }

      // Check hour limit
      if (limit.hourRequests.length >= this.options.maxRequestsPerHour) {
        limit.blockedUntil = now + TIME_CONSTANTS.hour;
        this.rateLimits.set(key, limit);
        
        this.logger.warn(`Hourly rate limit exceeded for ${identifier}: ${limit.hourRequests.length} requests in last hour`);
        this.logSecurityEvent(identifier, 'hourly_rate_limit_exceeded', `Hour rate limit exceeded: ${limit.hourRequests.length} requests`);
        
        return { allowed: false, reason: 'Hourly rate limit exceeded', retryAfter: 3600 };
      }

      // Add current request
      limit.minuteRequests.push(now);
      limit.hourRequests.push(now);
      this.rateLimits.set(key, limit);

      return { 
        allowed: true, 
        remaining: Math.min(
          this.options.maxRequestsPerMinute - limit.minuteRequests.length,
          this.options.maxRequestsPerHour - limit.hourRequests.length
        )
      };
    } catch (error) {
      this.logger.error('Rate limit check error:', error);
      return { allowed: true, remaining: 0 };
    }
  }

  /**
   * Detect and prevent intrusions
   */
  checkIntrusionAttempt(request, clientIP) {
    try {
      if (!this.options.enableIDS) {
        return { threat: false, risk: 'low' };
      }

      const threats = [];
      let riskLevel = 'low';

      // Check for blocked IP
      if (this.isIPBlocked(clientIP)) {
        this.metrics.requestsBlocked++;
        return { 
          threat: true, 
          risk: 'high', 
          reason: 'Blocked IP',
          action: 'block'
        };
      }

      // Check for attack patterns in URL and parameters
      const urlToCheck = request.url || '';
      const bodyToCheck = JSON.stringify(request.body || {});
      const headersToCheck = JSON.stringify(request.headers || {});
      
      for (const pattern of this.attackPatterns) {
        if (pattern.test(urlToCheck) || pattern.test(bodyToCheck) || pattern.test(headersToCheck)) {
          threats.push(`Attack pattern detected: ${pattern.source}`);
          riskLevel = 'high';
        }
      }

      // Check for suspicious behavior patterns
      const suspiciousActivity = this.checkSuspiciousActivity(clientIP, request);
      if (suspiciousActivity.suspicious) {
        threats.push(suspiciousActivity.reason);
        riskLevel = suspiciousActivity.risk;
      }

      // Check for known attack signatures
      const knownAttack = this.checkKnownAttackSignatures(request);
      if (knownAttack.detected) {
        threats.push(knownAttack.signature);
        riskLevel = 'critical';
      }

      if (threats.length > 0) {
        this.metrics.attacksDetected++;
        this.logSecurityEvent(clientIP, 'intrusion_attempt', `Threats detected: ${threats.join(', ')}`);
        
        // Auto-block for critical threats
        if (riskLevel === 'critical') {
          this.blockIP(clientIP, 'Automated block for critical threat');
        }

        return {
          threat: true,
          risk: riskLevel,
          threats,
          action: riskLevel === 'critical' ? 'block' : 'monitor'
        };
      }

      return { threat: false, risk: 'low' };
    } catch (error) {
      this.logger.error('Intrusion detection error:', error);
      return { threat: false, risk: 'low' };
    }
  }

  /**
   * Check for suspicious activity patterns
   */
  checkSuspiciousActivity(clientIP, request) {
    try {
      const now = Date.now();
      const activity = this.suspiciousActivities.get(clientIP) || {
        requests: [],
        failedAttempts: 0,
        patterns: new Set()
      };

      // Clean old requests
      activity.requests = activity.requests.filter(time => now - time < TIME_CONSTANTS.hour);

      // Check for rapid requests
      if (activity.requests.length > 200) { // More than 200 requests per hour
        return {
          suspicious: true,
          reason: 'Rapid request pattern detected',
          risk: 'medium'
        };
      }

      // Check for failed authentication attempts
      if (activity.failedAttempts > this.options.maxFailedAttempts) {
        return {
          suspicious: true,
          reason: 'Multiple failed authentication attempts',
          risk: 'high'
        };
      }

      // Check for directory traversal attempts
      if (request.url && request.url.includes('../')) {
        activity.patterns.add('directory_traversal');
        return {
          suspicious: true,
          reason: 'Directory traversal attempt',
          risk: 'high'
        };
      }

      // Check for SQL injection patterns
      const sqlPatterns = ['union select', "' or 1=1", '" or 1=1', 'drop table'];
      const requestString = JSON.stringify(request).toLowerCase();
      
      for (const pattern of sqlPatterns) {
        if (requestString.includes(pattern)) {
          activity.patterns.add('sql_injection');
          return {
            suspicious: true,
            reason: 'SQL injection attempt detected',
            risk: 'critical'
          };
        }
      }

      // Update activity
      activity.requests.push(now);
      this.suspiciousActivities.set(clientIP, activity);

      return { suspicious: false };
    } catch (error) {
      this.logger.error('Suspicious activity check error:', error);
      return { suspicious: false };
    }
  }

  /**
   * Check for known attack signatures
   */
  checkKnownAttackSignatures(request) {
    try {
      const knownSignatures = [
        { name: 'Nikto Scanner', pattern: /nikto/i },
        { name: 'SQLMap', pattern: /sqlmap/i },
        { name: 'Nmap NSE', pattern: /nmap.*nse/i },
        { name: 'Burp Suite', pattern: /burp.*suite/i },
        { name: 'OWASP ZAP', pattern: /owasp.*zap/i }
      ];

      const userAgent = request.headers?.['user-agent'] || '';
      const requestString = JSON.stringify(request);

      for (const signature of knownSignatures) {
        if (signature.pattern.test(userAgent) || signature.pattern.test(requestString)) {
          return {
            detected: true,
            signature: signature.name
          };
        }
      }

      return { detected: false };
    } catch (error) {
      this.logger.error('Known attack signature check error:', error);
      return { detected: false };
    }
  }

  /**
   * Validate and sanitize input
   */
  validateInput(input, type = 'string', options = {}) {
    try {
      if (input === null || input === undefined) {
        return { valid: false, reason: 'Input is null or undefined' };
      }

      switch (type) {
        case 'string':
          return this.validateString(input, options);
        case 'number':
          return this.validateNumber(input, options);
        case 'email':
          return this.validateEmail(input);
        case 'wallet':
          return this.validateWalletAddress(input, options.currency);
        case 'json':
          return this.validateJSON(input);
        case 'url':
          return this.validateURL(input);
        default:
          return { valid: false, reason: 'Unknown validation type' };
      }
    } catch (error) {
      this.logger.error('Input validation error:', error);
      return { valid: false, reason: 'Validation error' };
    }
  }

  /**
   * Validate string input
   */
  validateString(input, options = {}) {
    if (typeof input !== 'string') {
      return { valid: false, reason: 'Input is not a string' };
    }

    const {
      minLength = 0,
      maxLength = 1000,
      allowHTML = false,
      allowSpecialChars = true
    } = options;

    if (input.length < minLength) {
      return { valid: false, reason: `String too short (min: ${minLength})` };
    }

    if (input.length > maxLength) {
      return { valid: false, reason: `String too long (max: ${maxLength})` };
    }

    if (!allowHTML && /<[^>]*>/g.test(input)) {
      return { valid: false, reason: 'HTML tags not allowed' };
    }

    if (!allowSpecialChars && /[<>\"'&]/.test(input)) {
      return { valid: false, reason: 'Special characters not allowed' };
    }

    // Check for attack patterns
    for (const pattern of this.attackPatterns) {
      if (pattern.test(input)) {
        return { valid: false, reason: 'Potentially malicious content detected' };
      }
    }

    return { valid: true, sanitized: this.sanitizeString(input, options) };
  }

  /**
   * Validate number input
   */
  validateNumber(input, options = {}) {
    const num = Number(input);
    
    if (isNaN(num)) {
      return { valid: false, reason: 'Input is not a valid number' };
    }

    const { min = -Infinity, max = Infinity, integer = false } = options;

    if (num < min) {
      return { valid: false, reason: `Number too small (min: ${min})` };
    }

    if (num > max) {
      return { valid: false, reason: `Number too large (max: ${max})` };
    }

    if (integer && !Number.isInteger(num)) {
      return { valid: false, reason: 'Integer required' };
    }

    return { valid: true, sanitized: num };
  }

  /**
   * Validate email address
   */
  validateEmail(input) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    if (!emailRegex.test(input)) {
      return { valid: false, reason: 'Invalid email format' };
    }

    return { valid: true, sanitized: input.toLowerCase().trim() };
  }

  /**
   * Validate wallet address
   */
  validateWalletAddress(input, currency) {
    if (!currency) {
      return { valid: false, reason: 'Currency not specified' };
    }

    // Import wallet patterns from constants
    const { WALLET_PATTERNS } = require('./constants.js');
    const pattern = WALLET_PATTERNS[currency.toUpperCase()];
    
    if (!pattern) {
      return { valid: false, reason: 'Unsupported currency' };
    }

    if (!pattern.test(input)) {
      return { valid: false, reason: `Invalid ${currency} wallet address format` };
    }

    return { valid: true, sanitized: input.trim() };
  }

  /**
   * Validate JSON input
   */
  validateJSON(input) {
    try {
      const parsed = JSON.parse(input);
      return { valid: true, sanitized: parsed };
    } catch (error) {
      return { valid: false, reason: 'Invalid JSON format' };
    }
  }

  /**
   * Validate URL
   */
  validateURL(input) {
    try {
      const url = new URL(input);
      
      // Check for allowed protocols
      if (!['http:', 'https:'].includes(url.protocol)) {
        return { valid: false, reason: 'Protocol not allowed' };
      }

      return { valid: true, sanitized: url.toString() };
    } catch (error) {
      return { valid: false, reason: 'Invalid URL format' };
    }
  }

  /**
   * Sanitize string input
   */
  sanitizeString(input, options = {}) {
    let sanitized = input;

    // Remove HTML tags if not allowed
    if (!options.allowHTML) {
      sanitized = sanitized.replace(/<[^>]*>/g, '');
    }

    // Escape special characters if not allowed
    if (!options.allowSpecialChars) {
      sanitized = sanitized
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
    }

    return sanitized.trim();
  }

  /**
   * Generate secure hash
   */
  generateSecureHash(data, salt = null) {
    try {
      const saltBytes = salt || randomBytes(32);
      const hash = pbkdf2Sync(data, saltBytes, this.options.keyDerivationIterations, 64, 'sha512');
      
      return {
        hash: hash.toString('hex'),
        salt: saltBytes.toString('hex')
      };
    } catch (error) {
      this.logger.error('Hash generation error:', error);
      throw error;
    }
  }

  /**
   * Verify secure hash
   */
  verifySecureHash(data, hash, salt) {
    try {
      const saltBytes = Buffer.from(salt, 'hex');
      const expectedHash = pbkdf2Sync(data, saltBytes, this.options.keyDerivationIterations, 64, 'sha512');
      const actualHash = Buffer.from(hash, 'hex');
      
      return timingSafeEqual(expectedHash, actualHash);
    } catch (error) {
      this.logger.error('Hash verification error:', error);
      return false;
    }
  }

  /**
   * Block IP address
   */
  blockIP(ip, reason = 'Security violation') {
    try {
      const blockInfo = {
        ip,
        reason,
        blockedAt: Date.now(),
        expiresAt: Date.now() + this.options.blockDuration
      };

      this.blockedIPs.set(ip, blockInfo);
      
      this.logger.warn(`Blocked IP ${ip}: ${reason}`);
      this.logSecurityEvent(ip, 'ip_blocked', `IP blocked for: ${reason}`);
      
      // Emit event for external systems
      this.emit('ip_blocked', blockInfo);

      return true;
    } catch (error) {
      this.logger.error('IP blocking error:', error);
      return false;
    }
  }

  /**
   * Check if IP is blocked
   */
  isIPBlocked(ip) {
    try {
      const blockInfo = this.blockedIPs.get(ip);
      
      if (!blockInfo) {
        return false;
      }

      // Check if block has expired
      if (Date.now() > blockInfo.expiresAt) {
        this.blockedIPs.delete(ip);
        this.logger.info(`IP block expired for ${ip}`);
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error('IP block check error:', error);
      return false;
    }
  }

  /**
   * Get security headers
   */
  getSecurityHeaders() {
    return {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
    };
  }

  /**
   * Log security event
   */
  logSecurityEvent(identifier, eventType, description, severity = 'info') {
    try {
      const event = {
        timestamp: Date.now(),
        identifier,
        eventType,
        description,
        severity,
        id: randomBytes(8).toString('hex')
      };

      this.securityEvents.push(event);
      
      // Keep only last 1000 events
      if (this.securityEvents.length > 1000) {
        this.securityEvents.shift();
      }

      // Log based on severity
      switch (severity) {
        case 'critical':
          this.logger.error(`SECURITY ALERT [${eventType}]: ${description}`);
          break;
        case 'warning':
          this.logger.warn(`SECURITY WARNING [${eventType}]: ${description}`);
          break;
        default:
          this.logger.info(`SECURITY EVENT [${eventType}]: ${description}`);
      }

      // Emit event for external monitoring
      this.emit('security_event', event);
      
    } catch (error) {
      this.logger.error('Security event logging error:', error);
    }
  }

  /**
   * Get security metrics
   */
  getMetrics() {
    const uptime = Date.now() - this.metrics.startTime;
    
    return {
      ...this.metrics,
      uptime,
      activeAPIKeys: this.apiKeys.size,
      blockedIPs: this.blockedIPs.size,
      activeSessions: this.sessions.size,
      recentEvents: this.securityEvents.slice(-10),
      rateLimitEntries: this.rateLimits.size,
      suspiciousIPs: this.suspiciousActivities.size
    };
  }

  /**
   * Cleanup expired data
   */
  cleanup() {
    try {
      const now = Date.now();
      let cleaned = 0;

      // Cleanup expired IP blocks
      for (const [ip, blockInfo] of this.blockedIPs) {
        if (now > blockInfo.expiresAt) {
          this.blockedIPs.delete(ip);
          cleaned++;
        }
      }

      // Cleanup old rate limit entries
      for (const [key, limit] of this.rateLimits) {
        if (now > limit.blockedUntil && 
            limit.minuteRequests.length === 0 && 
            limit.hourRequests.length === 0) {
          this.rateLimits.delete(key);
          cleaned++;
        }
      }

      // Cleanup old suspicious activities
      for (const [ip, activity] of this.suspiciousActivities) {
        activity.requests = activity.requests.filter(time => now - time < TIME_CONSTANTS.day);
        if (activity.requests.length === 0 && activity.failedAttempts === 0) {
          this.suspiciousActivities.delete(ip);
          cleaned++;
        }
      }

      // Cleanup old security events
      this.securityEvents = this.securityEvents.filter(event => 
        now - event.timestamp < TIME_CONSTANTS.week
      );

      if (cleaned > 0) {
        this.logger.debug(`Security cleanup: removed ${cleaned} expired entries`);
      }
      
    } catch (error) {
      this.logger.error('Security cleanup error:', error);
    }
  }

  /**
   * Collect security metrics
   */
  collectMetrics() {
    try {
      // This would integrate with monitoring systems
      const metrics = this.getMetrics();
      
      // Log critical metrics
      if (metrics.attacksDetected > 0) {
        this.logger.warn(`Security Alert: ${metrics.attacksDetected} attacks detected in last period`);
      }
      
    } catch (error) {
      this.logger.error('Metrics collection error:', error);
    }
  }

  /**
   * Stop security manager
   */
  stop() {
    try {
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }

      if (this.metricsTimer) {
        clearInterval(this.metricsTimer);
        this.metricsTimer = null;
      }

      this.logger.info('Security Manager stopped');
      this.logSecurityEvent('system', 'security_manager_stopped', 'Security system shutdown completed');
      
    } catch (error) {
      this.logger.error('Security Manager stop error:', error);
    }
  }
}

export default SecurityManager;
