/**
 * Otedama Unified Security Manager
 * 
 * Enterprise-grade security system with comprehensive protection
 * following John Carmack (performance), Robert C. Martin (clean code), 
 * and Rob Pike (simplicity) principles.
 * 
 * Replaces:
 * - security-middleware.js
 * - enhanced-security-middleware.js
 * - security-audit.js
 * - security-audit-system.js
 * - security-hardening.js
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { performance } from 'perf_hooks';

// Constants for optimal security (Carmack principle)
const SECURITY_CONSTANTS = Object.freeze({
  // Rate limiting
  DEFAULT_RATE_LIMIT: 100,        // requests per window
  RATE_LIMIT_WINDOW: 60000,       // 1 minute
  AUTH_RATE_LIMIT: 5,             // auth attempts per window
  
  // Session settings
  SESSION_TIMEOUT: 3600000,       // 1 hour
  SESSION_SECRET_LENGTH: 64,      // bytes
  
  // Token settings
  TOKEN_LENGTH: 32,               // bytes
  TOKEN_EXPIRY: 86400000,         // 24 hours
  
  // Brute force protection
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_DURATION: 900000,       // 15 minutes
  
  // DDoS protection
  DDOS_THRESHOLD: 1000,           // requests per window
  DDOS_BLOCK_DURATION: 300000,    // 5 minutes
  
  // Content limits
  MAX_BODY_SIZE: 10 * 1024 * 1024, // 10MB
  MAX_HEADER_SIZE: 8192,          // 8KB
  
  // Audit settings
  AUDIT_INTERVAL: 3600000,        // 1 hour
  MAX_SECURITY_EVENTS: 10000,
  
  // Cleanup intervals
  CLEANUP_INTERVAL: 300000,       // 5 minutes
});

// Security levels
const SecurityLevel = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
});

// Attack types
const AttackType = Object.freeze({
  BRUTE_FORCE: 'brute_force',
  RATE_LIMIT: 'rate_limit',
  SQL_INJECTION: 'sql_injection',
  XSS: 'xss',
  CSRF: 'csrf',
  DDOS: 'ddos',
  SUSPICIOUS: 'suspicious'
});

// Security actions
const SecurityAction = Object.freeze({
  ALLOW: 'allow',
  BLOCK: 'block',
  THROTTLE: 'throttle',
  LOG: 'log'
});

/**
 * Rate limiter with token bucket algorithm
 */
class RateLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = new Map(); // ip -> { tokens, lastRefill }
  }

  check(ip) {
    const now = Date.now();
    
    if (!this.requests.has(ip)) {
      this.requests.set(ip, {
        tokens: this.maxRequests,
        lastRefill: now
      });
      return true;
    }

    const bucket = this.requests.get(ip);
    
    // Refill tokens based on time passed
    const timePassed = now - bucket.lastRefill;
    const tokensToAdd = Math.floor(timePassed / this.windowMs * this.maxRequests);
    
    bucket.tokens = Math.min(this.maxRequests, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    if (bucket.tokens > 0) {
      bucket.tokens--;
      return true;
    }

    return false;
  }

  reset(ip) {
    this.requests.delete(ip);
  }

  cleanup() {
    const now = Date.now();
    const expired = [];
    
    for (const [ip, bucket] of this.requests) {
      if (now - bucket.lastRefill > this.windowMs * 2) {
        expired.push(ip);
      }
    }
    
    expired.forEach(ip => this.requests.delete(ip));
  }
}

/**
 * Security patterns detector
 */
class PatternDetector {
  constructor() {
    // Attack patterns
    this.patterns = {
      sqlInjection: [
        /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION)\b)/i,
        /(\b(OR|AND)\s+\d+\s*=\s*\d+)/i,
        /(\'|(\\\')|(\;\s*(--|\#)))/i,
        /(\bUNION\b.*\bSELECT\b)/i
      ],
      
      xss: [
        /<script[^>]*>.*?<\/script>/gi,
        /javascript\s*:/gi,
        /on\w+\s*=/gi,
        /<iframe[^>]*>.*?<\/iframe>/gi,
        /eval\s*\(/gi,
        /expression\s*\(/gi
      ],
      
      pathTraversal: [
        /\.\.\//g,
        /\.\.\\/g,
        /%2e%2e%2f/gi,
        /%2e%2e%5c/gi,
        /\.\.%2f/gi
      ],
      
      suspiciousUserAgent: [
        /bot|crawler|spider|scanner/i,
        /sqlmap|nikto|nmap|masscan/i,
        /curl|wget|python-requests/i
      ]
    };
  }

  detect(input, type = null) {
    const threats = [];
    const patterns = type ? { [type]: this.patterns[type] } : this.patterns;

    for (const [patternType, patternList] of Object.entries(patterns)) {
      if (!patternList) continue;
      
      for (const pattern of patternList) {
        if (pattern.test(input)) {
          threats.push({
            type: patternType,
            severity: this.getSeverity(patternType),
            pattern: pattern.toString()
          });
          break; // One threat per type is enough
        }
      }
    }

    return threats;
  }

  getSeverity(patternType) {
    const severityMap = {
      sqlInjection: SecurityLevel.CRITICAL,
      xss: SecurityLevel.HIGH,
      pathTraversal: SecurityLevel.HIGH,
      suspiciousUserAgent: SecurityLevel.MEDIUM
    };
    
    return severityMap[patternType] || SecurityLevel.LOW;
  }
}

/**
 * Security auditor
 */
class SecurityAuditor {
  constructor() {
    this.events = [];
    this.findings = [];
    this.metrics = {
      totalRequests: 0,
      blockedRequests: 0,
      threatsByType: {},
      averageResponseTime: 0
    };
  }

  logEvent(event) {
    this.events.push({
      timestamp: Date.now(),
      ...event
    });

    // Keep only recent events
    if (this.events.length > SECURITY_CONSTANTS.MAX_SECURITY_EVENTS) {
      this.events.shift();
    }

    // Update metrics
    this.updateMetrics(event);
  }

  updateMetrics(event) {
    this.metrics.totalRequests++;
    
    if (event.action === SecurityAction.BLOCK) {
      this.metrics.blockedRequests++;
    }

    if (event.attackType) {
      this.metrics.threatsByType[event.attackType] = 
        (this.metrics.threatsByType[event.attackType] || 0) + 1;
    }
  }

  addFinding(finding) {
    this.findings.push({
      id: randomBytes(8).toString('hex'),
      timestamp: Date.now(),
      ...finding
    });
  }

  generateReport() {
    return {
      timestamp: Date.now(),
      metrics: { ...this.metrics },
      recentEvents: this.events.slice(-100),
      findings: this.findings.slice(-50),
      summary: {
        totalEvents: this.events.length,
        blockedPercentage: this.metrics.totalRequests > 0 ? 
          (this.metrics.blockedRequests / this.metrics.totalRequests * 100).toFixed(2) : 0,
        topThreats: this.getTopThreats()
      }
    };
  }

  getTopThreats() {
    return Object.entries(this.metrics.threatsByType)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([type, count]) => ({ type, count }));
  }
}

/**
 * Main Security Manager (Clean Architecture - Martin principle)
 */
export class SecurityManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      // Security levels
      level: options.level || SecurityLevel.HIGH,
      
      // Rate limiting
      rateLimiting: {
        enabled: options.rateLimiting?.enabled !== false,
        maxRequests: options.rateLimiting?.maxRequests || SECURITY_CONSTANTS.DEFAULT_RATE_LIMIT,
        windowMs: options.rateLimiting?.windowMs || SECURITY_CONSTANTS.RATE_LIMIT_WINDOW,
        authMaxRequests: options.rateLimiting?.authMaxRequests || SECURITY_CONSTANTS.AUTH_RATE_LIMIT
      },
      
      // DDoS protection
      ddosProtection: {
        enabled: options.ddosProtection?.enabled !== false,
        threshold: options.ddosProtection?.threshold || SECURITY_CONSTANTS.DDOS_THRESHOLD,
        blockDuration: options.ddosProtection?.blockDuration || SECURITY_CONSTANTS.DDOS_BLOCK_DURATION
      },
      
      // Input validation
      inputValidation: {
        enabled: options.inputValidation?.enabled !== false,
        maxBodySize: options.inputValidation?.maxBodySize || SECURITY_CONSTANTS.MAX_BODY_SIZE,
        maxHeaderSize: options.inputValidation?.maxHeaderSize || SECURITY_CONSTANTS.MAX_HEADER_SIZE
      },
      
      // Session security
      sessionSecurity: {
        enabled: options.sessionSecurity?.enabled !== false,
        timeout: options.sessionSecurity?.timeout || SECURITY_CONSTANTS.SESSION_TIMEOUT,
        secret: options.sessionSecurity?.secret || this.generateSecret()
      },
      
      // Audit settings
      audit: {
        enabled: options.audit?.enabled !== false,
        logLevel: options.audit?.logLevel || SecurityLevel.MEDIUM,
        reportInterval: options.audit?.reportInterval || SECURITY_CONSTANTS.AUDIT_INTERVAL
      },
      
      ...options
    };

    // Core components
    this.rateLimiters = {
      general: new RateLimiter(
        this.options.rateLimiting.maxRequests,
        this.options.rateLimiting.windowMs
      ),
      auth: new RateLimiter(
        this.options.rateLimiting.authMaxRequests,
        this.options.rateLimiting.windowMs
      )
    };

    this.patternDetector = new PatternDetector();
    this.auditor = new SecurityAuditor();

    // Security state
    this.blockedIPs = new Map(); // ip -> blockUntil
    this.failedAttempts = new Map(); // ip -> { count, lastAttempt }
    this.sessions = new Map(); // sessionId -> { userId, expiresAt }
    this.tokens = new Map(); // token -> { userId, expiresAt }

    // Intervals
    this.intervals = {
      cleanup: null,
      audit: null
    };

    this.startMonitoring();
  }

  /**
   * Main security middleware (Pike principle - simple interface)
   */
  middleware() {
    return async (req, res, next) => {
      const startTime = performance.now();
      
      try {
        const securityContext = {
          ip: this.getClientIP(req),
          userAgent: req.headers['user-agent'] || '',
          path: req.path,
          method: req.method,
          headers: req.headers,
          body: req.body
        };

        // Security checks
        const result = await this.performSecurityChecks(securityContext);
        
        if (result.action === SecurityAction.BLOCK) {
          this.auditSecurityEvent(securityContext, result);
          return this.sendSecurityResponse(res, 403, result.reason);
        }

        if (result.action === SecurityAction.THROTTLE) {
          this.auditSecurityEvent(securityContext, result);
          // Add delay for throttling
          await this.delay(1000);
        }

        // Add security headers
        this.addSecurityHeaders(res);

        // Continue to next middleware
        const duration = performance.now() - startTime;
        this.auditor.logEvent({
          type: 'request',
          action: SecurityAction.ALLOW,
          duration,
          ip: securityContext.ip
        });

        next();

      } catch (error) {
        this.emit('error', error);
        return this.sendSecurityResponse(res, 500, 'Security check failed');
      }
    };
  }

  /**
   * Perform comprehensive security checks
   */
  async performSecurityChecks(context) {
    // Check if IP is blocked
    if (this.isIPBlocked(context.ip)) {
      return {
        action: SecurityAction.BLOCK,
        reason: 'IP blocked',
        attackType: AttackType.DDOS
      };
    }

    // Rate limiting check
    const rateLimitResult = this.checkRateLimit(context);
    if (rateLimitResult.action !== SecurityAction.ALLOW) {
      return rateLimitResult;
    }

    // DDoS protection
    if (this.options.ddosProtection.enabled) {
      const ddosResult = this.checkDDoSProtection(context);
      if (ddosResult.action !== SecurityAction.ALLOW) {
        return ddosResult;
      }
    }

    // Input validation
    if (this.options.inputValidation.enabled) {
      const inputResult = this.validateInput(context);
      if (inputResult.action !== SecurityAction.ALLOW) {
        return inputResult;
      }
    }

    // Pattern detection
    const patternResult = this.detectThreats(context);
    if (patternResult.action !== SecurityAction.ALLOW) {
      return patternResult;
    }

    // Brute force protection
    const bruteForceResult = this.checkBruteForce(context);
    if (bruteForceResult.action !== SecurityAction.ALLOW) {
      return bruteForceResult;
    }

    return { action: SecurityAction.ALLOW };
  }

  /**
   * Check rate limiting
   */
  checkRateLimit(context) {
    const isAuthPath = this.isAuthPath(context.path);
    const limiter = isAuthPath ? this.rateLimiters.auth : this.rateLimiters.general;

    if (!limiter.check(context.ip)) {
      return {
        action: SecurityAction.BLOCK,
        reason: 'Rate limit exceeded',
        attackType: AttackType.RATE_LIMIT
      };
    }

    return { action: SecurityAction.ALLOW };
  }

  /**
   * Check DDoS protection
   */
  checkDDoSProtection(context) {
    // Simple threshold-based detection
    // In production, use more sophisticated algorithms
    const limiter = this.rateLimiters.general;
    const bucket = limiter.requests.get(context.ip);
    
    if (bucket && bucket.tokens <= 0) {
      // Block IP temporarily
      this.blockIP(context.ip, this.options.ddosProtection.blockDuration);
      
      return {
        action: SecurityAction.BLOCK,
        reason: 'DDoS protection activated',
        attackType: AttackType.DDOS
      };
    }

    return { action: SecurityAction.ALLOW };
  }

  /**
   * Validate input
   */
  validateInput(context) {
    // Check content length
    if (context.body && JSON.stringify(context.body).length > this.options.inputValidation.maxBodySize) {
      return {
        action: SecurityAction.BLOCK,
        reason: 'Request body too large',
        attackType: AttackType.SUSPICIOUS
      };
    }

    // Check header sizes
    const headerSize = JSON.stringify(context.headers).length;
    if (headerSize > this.options.inputValidation.maxHeaderSize) {
      return {
        action: SecurityAction.BLOCK,
        reason: 'Headers too large',
        attackType: AttackType.SUSPICIOUS
      };
    }

    return { action: SecurityAction.ALLOW };
  }

  /**
   * Detect security threats using patterns
   */
  detectThreats(context) {
    const allInput = [
      context.path,
      context.userAgent,
      JSON.stringify(context.body || {}),
      JSON.stringify(context.headers)
    ].join(' ');

    const threats = this.patternDetector.detect(allInput);

    for (const threat of threats) {
      if (threat.severity === SecurityLevel.CRITICAL) {
        return {
          action: SecurityAction.BLOCK,
          reason: `${threat.type} detected`,
          attackType: threat.type === 'sqlInjection' ? AttackType.SQL_INJECTION : AttackType.XSS
        };
      }
    }

    if (threats.length > 0) {
      return {
        action: SecurityAction.LOG,
        reason: 'Suspicious patterns detected',
        attackType: AttackType.SUSPICIOUS
      };
    }

    return { action: SecurityAction.ALLOW };
  }

  /**
   * Check brute force protection
   */
  checkBruteForce(context) {
    if (!this.isAuthPath(context.path)) {
      return { action: SecurityAction.ALLOW };
    }

    const attempts = this.failedAttempts.get(context.ip);
    if (attempts && attempts.count >= SECURITY_CONSTANTS.MAX_LOGIN_ATTEMPTS) {
      const lockoutEnd = attempts.lastAttempt + SECURITY_CONSTANTS.LOCKOUT_DURATION;
      
      if (Date.now() < lockoutEnd) {
        return {
          action: SecurityAction.BLOCK,
          reason: 'Too many failed attempts',
          attackType: AttackType.BRUTE_FORCE
        };
      } else {
        // Reset after lockout period
        this.failedAttempts.delete(context.ip);
      }
    }

    return { action: SecurityAction.ALLOW };
  }

  /**
   * Record failed authentication attempt
   */
  recordFailedAttempt(ip) {
    const now = Date.now();
    const attempts = this.failedAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    
    attempts.count++;
    attempts.lastAttempt = now;
    
    this.failedAttempts.set(ip, attempts);
  }

  /**
   * Clear failed attempts for IP
   */
  clearFailedAttempts(ip) {
    this.failedAttempts.delete(ip);
  }

  /**
   * Block IP address
   */
  blockIP(ip, duration) {
    const blockUntil = Date.now() + duration;
    this.blockedIPs.set(ip, blockUntil);
    
    this.emit('ipBlocked', { ip, duration, blockUntil });
  }

  /**
   * Check if IP is blocked
   */
  isIPBlocked(ip) {
    const blockUntil = this.blockedIPs.get(ip);
    if (!blockUntil) return false;
    
    if (Date.now() > blockUntil) {
      this.blockedIPs.delete(ip);
      return false;
    }
    
    return true;
  }

  /**
   * Session management
   */
  createSession(userId, metadata = {}) {
    const sessionId = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + this.options.sessionSecurity.timeout;
    
    this.sessions.set(sessionId, {
      userId,
      metadata,
      expiresAt,
      createdAt: Date.now()
    });
    
    return sessionId;
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    
    return session;
  }

  invalidateSession(sessionId) {
    this.sessions.delete(sessionId);
  }

  /**
   * Token management
   */
  createToken(userId, expiresIn = SECURITY_CONSTANTS.TOKEN_EXPIRY) {
    const token = randomBytes(SECURITY_CONSTANTS.TOKEN_LENGTH).toString('hex');
    const expiresAt = Date.now() + expiresIn;
    
    this.tokens.set(token, {
      userId,
      expiresAt,
      createdAt: Date.now()
    });
    
    return token;
  }

  validateToken(token) {
    const tokenData = this.tokens.get(token);
    if (!tokenData) return null;
    
    if (tokenData.expiresAt < Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    
    return tokenData;
  }

  revokeToken(token) {
    this.tokens.delete(token);
  }

  /**
   * Add security headers
   */
  addSecurityHeaders(res) {
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
    };

    for (const [header, value] of Object.entries(headers)) {
      res.setHeader(header, value);
    }

    // Remove sensitive headers
    res.removeHeader('X-Powered-By');
    res.removeHeader('Server');
  }

  /**
   * Audit security event
   */
  auditSecurityEvent(context, result) {
    this.auditor.logEvent({
      type: 'security_event',
      action: result.action,
      attackType: result.attackType,
      reason: result.reason,
      ip: context.ip,
      userAgent: context.userAgent,
      path: context.path,
      method: context.method
    });
  }

  /**
   * Send security response
   */
  sendSecurityResponse(res, statusCode, message) {
    res.status(statusCode).json({
      error: message,
      timestamp: new Date().toISOString(),
      requestId: randomBytes(8).toString('hex')
    });
  }

  /**
   * Utility methods
   */
  getClientIP(req) {
    return req.headers['x-forwarded-for'] ||
           req.headers['x-real-ip'] ||
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           req.ip ||
           '127.0.0.1';
  }

  isAuthPath(path) {
    const authPaths = ['/auth', '/login', '/register', '/api/auth'];
    return authPaths.some(authPath => path.includes(authPath));
  }

  generateSecret() {
    return randomBytes(SECURITY_CONSTANTS.SESSION_SECRET_LENGTH).toString('hex');
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Monitoring and maintenance
   */
  startMonitoring() {
    // Cleanup expired entries
    this.intervals.cleanup = setInterval(() => {
      this.cleanup();
    }, SECURITY_CONSTANTS.CLEANUP_INTERVAL);

    // Generate audit reports
    if (this.options.audit.enabled) {
      this.intervals.audit = setInterval(() => {
        this.generateAuditReport();
      }, this.options.audit.reportInterval);
    }
  }

  cleanup() {
    const now = Date.now();

    // Cleanup blocked IPs
    for (const [ip, blockUntil] of this.blockedIPs) {
      if (now > blockUntil) {
        this.blockedIPs.delete(ip);
      }
    }

    // Cleanup expired sessions
    for (const [sessionId, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(sessionId);
      }
    }

    // Cleanup expired tokens
    for (const [token, tokenData] of this.tokens) {
      if (now > tokenData.expiresAt) {
        this.tokens.delete(token);
      }
    }

    // Cleanup rate limiters
    this.rateLimiters.general.cleanup();
    this.rateLimiters.auth.cleanup();

    // Cleanup old failed attempts
    for (const [ip, attempts] of this.failedAttempts) {
      if (now - attempts.lastAttempt > SECURITY_CONSTANTS.LOCKOUT_DURATION * 2) {
        this.failedAttempts.delete(ip);
      }
    }
  }

  generateAuditReport() {
    const report = this.auditor.generateReport();
    
    this.emit('auditReport', report);
    
    // Log high-severity events
    if (report.metrics.blockedRequests > 0) {
      this.emit('securityAlert', {
        type: 'blocked_requests',
        count: report.metrics.blockedRequests,
        percentage: report.summary.blockedPercentage
      });
    }
  }

  /**
   * Security analysis and recommendations
   */
  async runSecurityAudit() {
    console.log('Running security audit...');
    
    const findings = [];
    
    // Check configuration
    if (this.options.level === SecurityLevel.LOW) {
      findings.push({
        severity: SecurityLevel.MEDIUM,
        category: 'configuration',
        message: 'Security level set to LOW',
        recommendation: 'Consider using MEDIUM or HIGH security level for production'
      });
    }

    // Check session security
    if (!this.options.sessionSecurity.enabled) {
      findings.push({
        severity: SecurityLevel.HIGH,
        category: 'session',
        message: 'Session security disabled',
        recommendation: 'Enable session security for user authentication'
      });
    }

    // Check rate limiting
    if (!this.options.rateLimiting.enabled) {
      findings.push({
        severity: SecurityLevel.HIGH,
        category: 'rate_limiting',
        message: 'Rate limiting disabled',
        recommendation: 'Enable rate limiting to prevent abuse'
      });
    }

    // Add findings to auditor
    findings.forEach(finding => this.auditor.addFinding(finding));

    return {
      findings,
      score: this.calculateSecurityScore(findings),
      recommendations: this.generateRecommendations(findings)
    };
  }

  calculateSecurityScore(findings) {
    let score = 100;
    
    for (const finding of findings) {
      switch (finding.severity) {
        case SecurityLevel.CRITICAL:
          score -= 25;
          break;
        case SecurityLevel.HIGH:
          score -= 15;
          break;
        case SecurityLevel.MEDIUM:
          score -= 10;
          break;
        case SecurityLevel.LOW:
          score -= 5;
          break;
      }
    }
    
    return Math.max(0, score);
  }

  generateRecommendations(findings) {
    const recommendations = [];
    
    const criticalFindings = findings.filter(f => f.severity === SecurityLevel.CRITICAL);
    if (criticalFindings.length > 0) {
      recommendations.push({
        priority: 'immediate',
        message: 'Address critical security issues immediately',
        actions: criticalFindings.map(f => f.recommendation)
      });
    }

    const highFindings = findings.filter(f => f.severity === SecurityLevel.HIGH);
    if (highFindings.length > 0) {
      recommendations.push({
        priority: 'high',
        message: 'Fix high-severity security issues',
        actions: highFindings.map(f => f.recommendation)
      });
    }

    // General recommendations
    recommendations.push({
      priority: 'ongoing',
      message: 'Security best practices',
      actions: [
        'Regular security audits',
        'Keep dependencies updated',
        'Monitor security events',
        'Regular penetration testing',
        'Security training for developers'
      ]
    });

    return recommendations;
  }

  /**
   * Export security report
   */
  async exportSecurityReport(format = 'json', path = './security-report.json') {
    const auditResult = await this.runSecurityAudit();
    const report = {
      timestamp: new Date().toISOString(),
      securityLevel: this.options.level,
      audit: auditResult,
      metrics: this.auditor.generateReport(),
      configuration: {
        rateLimiting: this.options.rateLimiting,
        ddosProtection: this.options.ddosProtection,
        inputValidation: this.options.inputValidation,
        sessionSecurity: {
          ...this.options.sessionSecurity,
          secret: '[REDACTED]'
        }
      },
      status: {
        blockedIPs: this.blockedIPs.size,
        activeSessions: this.sessions.size,
        activeTokens: this.tokens.size,
        failedAttempts: this.failedAttempts.size
      }
    };

    if (format === 'json') {
      await fs.writeFile(path, JSON.stringify(report, null, 2));
    } else if (format === 'markdown') {
      const markdown = this.generateMarkdownReport(report);
      await fs.writeFile(path, markdown);
    }

    return report;
  }

  generateMarkdownReport(report) {
    return `# Security Report

Generated: ${report.timestamp}  
Security Level: ${report.securityLevel}  
Security Score: ${report.audit.score}/100

## Status
- Blocked IPs: ${report.status.blockedIPs}
- Active Sessions: ${report.status.activeSessions}
- Active Tokens: ${report.status.activeTokens}
- Failed Attempts: ${report.status.failedAttempts}

## Metrics
- Total Requests: ${report.metrics.metrics.totalRequests}
- Blocked Requests: ${report.metrics.metrics.blockedRequests}
- Block Rate: ${report.metrics.summary.blockedPercentage}%

## Findings
${report.audit.findings.map(f => 
  `- **${f.severity.toUpperCase()}**: ${f.message}\n  *Recommendation: ${f.recommendation}*`
).join('\n')}

## Recommendations
${report.audit.recommendations.map(r => 
  `### ${r.priority.toUpperCase()}\n${r.message}\n${r.actions.map(a => `- ${a}`).join('\n')}`
).join('\n\n')}
`;
  }

  /**
   * Get current security status
   */
  getStatus() {
    return {
      level: this.options.level,
      blockedIPs: this.blockedIPs.size,
      activeSessions: this.sessions.size,
      activeTokens: this.tokens.size,
      failedAttempts: this.failedAttempts.size,
      metrics: this.auditor.metrics,
      uptime: process.uptime()
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    // Clear intervals
    Object.values(this.intervals).forEach(interval => {
      if (interval) clearInterval(interval);
    });

    // Clear sensitive data
    this.sessions.clear();
    this.tokens.clear();
    this.blockedIPs.clear();
    this.failedAttempts.clear();

    this.emit('shutdown');
    console.log('Security manager shutdown complete');
  }
}

/**
 * Factory function for creating security middleware
 */
export function createSecurityMiddleware(options = {}) {
  const securityManager = new SecurityManager(options);
  return securityManager.middleware();
}

/**
 * Helper functions for specific security features
 */
export const SecurityHelpers = {
  // Generate secure random token
  generateToken: (length = 32) => {
    return randomBytes(length).toString('hex');
  },

  // Hash password securely
  hashPassword: (password, salt = null) => {
    const actualSalt = salt || randomBytes(16).toString('hex');
    const hash = createHash('sha256')
      .update(password + actualSalt)
      .digest('hex');
    return { hash, salt: actualSalt };
  },

  // Verify password
  verifyPassword: (password, hash, salt) => {
    const computed = createHash('sha256')
      .update(password + salt)
      .digest('hex');
    return timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
  },

  // Create HMAC signature
  createSignature: (data, secret) => {
    return createHmac('sha256', secret)
      .update(JSON.stringify(data))
      .digest('hex');
  },

  // Verify HMAC signature
  verifySignature: (data, signature, secret) => {
    const computed = createHmac('sha256', secret)
      .update(JSON.stringify(data))
      .digest('hex');
    return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  }
};

export default SecurityManager;
