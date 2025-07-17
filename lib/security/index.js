/**
 * Unified Security Module for Otedama
 * Consolidates all security functionality
 */

// Import core security functions
import {
  rateLimit,
  sanitize,
  password,
  session,
  csrf,
  securityHeaders,
  apiKey,
  signing,
  IPFilter,
  AuditLogger,
  twoFactor
} from './core.js';

// Import enhanced security
import { SecurityEnhanced } from './enhanced.js';

// Import security audit
import { SecurityAuditManager } from './audit.js';

// Re-export all functionality
export {
  // Core security functions
  rateLimit,
  sanitize,
  password,
  session,
  csrf,
  securityHeaders,
  apiKey,
  signing,
  IPFilter,
  AuditLogger,
  twoFactor,
  
  // Enhanced security class
  SecurityEnhanced,
  
  // Security audit manager
  SecurityAuditManager
};

/**
 * Unified Security Manager
 * Provides a single interface for all security features
 */
export class UnifiedSecurityManager {
  constructor(options = {}) {
    // Initialize database connection if provided
    this.db = options.db;
    
    // Initialize core components
    this.auditLogger = new AuditLogger(this.db);
    this.enhanced = new SecurityEnhanced(options.enhanced || {});
    this.auditManager = new SecurityAuditManager();
    
    // Configure event forwarding
    this.setupEventForwarding();
    
    // Track security metrics
    this.metrics = {
      rateLimitHits: 0,
      authenticationAttempts: 0,
      authenticationSuccesses: 0,
      authenticationFailures: 0,
      encryptionOperations: 0,
      validationErrors: 0
    };
  }
  
  /**
   * Setup event forwarding between components
   */
  setupEventForwarding() {
    // Forward enhanced security events to audit manager
    this.enhanced.on('ddos-detected', (data) => {
      this.auditManager.logSecurityEvent({
        type: 'ddos_detected',
        severity: 'high',
        ...data
      });
    });
    
    this.enhanced.on('sql-injection-attempt', (data) => {
      this.auditManager.logSecurityEvent({
        type: 'sql_injection',
        severity: 'high',
        ...data
      });
    });
    
    this.enhanced.on('xss-attempt', (data) => {
      this.auditManager.logSecurityEvent({
        type: 'xss_attempt',
        severity: 'medium',
        ...data
      });
    });
    
    this.enhanced.on('honeypot-accessed', (data) => {
      this.auditManager.logSecurityEvent({
        type: 'honeypot_access',
        severity: 'high',
        ...data
      });
    });
  }
  
  /**
   * Check rate limit with audit logging
   */
  checkRateLimit(identifier, maxRequests) {
    const result = rateLimit(identifier, maxRequests);
    
    if (!result.allowed) {
      this.metrics.rateLimitHits++;
      this.auditLogger.log({
        action: 'rate_limit_exceeded',
        resource: identifier,
        success: false,
        details: result
      });
    }
    
    return result;
  }
  
  /**
   * Authenticate user with comprehensive security checks
   */
  async authenticateUser(username, plainPassword, ip, userAgent) {
    this.metrics.authenticationAttempts++;
    
    try {
      // Sanitize inputs
      const cleanUsername = sanitize.username(username);
      if (!cleanUsername) {
        throw new Error('Invalid username');
      }
      
      // Check DDoS protection
      const ddosCheck = this.enhanced.checkDDoS(ip);
      if (!ddosCheck.allowed) {
        throw new Error('Too many authentication attempts');
      }
      
      // Verify password (this is a placeholder - actual implementation would check database)
      // const user = await this.getUserFromDatabase(cleanUsername);
      // const isValid = password.verify(plainPassword, user.passwordHash);
      
      // For demo purposes, simulate authentication
      const isValid = plainPassword.length > 8;
      
      if (isValid) {
        this.metrics.authenticationSuccesses++;
        
        // Create session
        const token = session.create(cleanUsername, { ip, userAgent });
        
        // Log successful authentication
        this.auditLogger.log({
          action: 'authentication_success',
          userId: cleanUsername,
          ip,
          userAgent,
          success: true
        });
        
        return { success: true, token };
      } else {
        throw new Error('Invalid credentials');
      }
    } catch (error) {
      this.metrics.authenticationFailures++;
      
      // Log failed authentication
      this.auditLogger.log({
        action: 'authentication_failure',
        userId: username,
        ip,
        userAgent,
        success: false,
        details: { error: error.message }
      });
      
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Encrypt sensitive data with audit logging
   */
  encryptData(data, userId) {
    try {
      const encrypted = this.enhanced.encrypt(data);
      this.metrics.encryptionOperations++;
      
      this.auditLogger.log({
        action: 'data_encrypted',
        userId,
        success: true
      });
      
      return encrypted;
    } catch (error) {
      this.auditLogger.log({
        action: 'data_encryption_failed',
        userId,
        success: false,
        details: { error: error.message }
      });
      
      throw error;
    }
  }
  
  /**
   * Validate and sanitize input with metrics tracking
   */
  validateInput(input, type, context = {}) {
    this.metrics.validationErrors++;
    
    let sanitized;
    switch (type) {
      case 'sql':
        sanitized = this.enhanced.preventSQLInjection(input);
        break;
      case 'html':
        sanitized = this.enhanced.preventXSS(input, 'html');
        break;
      case 'wallet':
        sanitized = sanitize.wallet(input, context.currency);
        break;
      case 'number':
        sanitized = sanitize.number(input, context.min, context.max);
        break;
      case 'username':
        sanitized = sanitize.username(input);
        break;
      default:
        sanitized = sanitize.html(input);
    }
    
    if (sanitized !== input) {
      this.metrics.validationErrors++;
    }
    
    return sanitized;
  }
  
  /**
   * Get comprehensive security metrics
   */
  getSecurityMetrics() {
    return {
      core: this.metrics,
      enhanced: this.enhanced.getMetrics(),
      audit: this.auditManager.getMetrics()
    };
  }
  
  /**
   * Perform security audit
   */
  async performSecurityAudit() {
    const results = await this.auditManager.performComprehensiveAudit();
    
    // Log audit results
    this.auditLogger.log({
      action: 'security_audit_performed',
      success: true,
      details: {
        score: results.overallScore,
        vulnerabilities: results.vulnerabilities.length,
        recommendations: results.recommendations.length
      }
    });
    
    return results;
  }
}

// Export default instance for convenience
export default UnifiedSecurityManager;