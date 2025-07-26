/**
 * Unified Security System - Otedama
 * National-grade security with Zero-Knowledge Proof authentication
 * 
 * Design Principles:
 * - Carmack: Performance-critical security checks with minimal overhead
 * - Martin: Clean separation of security domains
 * - Pike: Simple API for complex security requirements
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import crypto from 'crypto';
import { RateLimiter } from '../core/rate-limiter.js';

const logger = createStructuredLogger('UnifiedSecuritySystem');

/**
 * Security domains
 */
const SECURITY_DOMAINS = {
  AUTHENTICATION: 'authentication',
  AUTHORIZATION: 'authorization',
  ENCRYPTION: 'encryption',
  AUDIT: 'audit',
  THREAT_DETECTION: 'threat_detection',
  ACCESS_CONTROL: 'access_control'
};

/**
 * Threat levels
 */
const THREAT_LEVELS = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4
};

/**
 * Zero-Knowledge Proof implementation
 */
class ZeroKnowledgeProof {
  constructor(config = {}) {
    this.config = {
      challengeSize: config.challengeSize || 32,
      proofIterations: config.proofIterations || 10,
      hashAlgorithm: config.hashAlgorithm || 'sha256',
      ...config
    };
    
    this.challenges = new Map();
    this.proofs = new Map();
  }
  
  /**
   * Generate ZKP challenge
   */
  generateChallenge(userId) {
    const challenge = crypto.randomBytes(this.config.challengeSize);
    const challengeId = crypto.randomBytes(16).toString('hex');
    
    this.challenges.set(challengeId, {
      userId,
      challenge,
      timestamp: Date.now(),
      attempts: 0
    });
    
    // Clean old challenges
    this.cleanupChallenges();
    
    return {
      challengeId,
      challenge: challenge.toString('hex')
    };
  }
  
  /**
   * Verify ZKP proof
   */
  verifyProof(challengeId, proof, publicKey) {
    const challengeData = this.challenges.get(challengeId);
    
    if (!challengeData) {
      return { valid: false, reason: 'invalid_challenge' };
    }
    
    // Check attempts
    challengeData.attempts++;
    if (challengeData.attempts > 3) {
      this.challenges.delete(challengeId);
      return { valid: false, reason: 'too_many_attempts' };
    }
    
    // Check timeout (5 minutes)
    if (Date.now() - challengeData.timestamp > 300000) {
      this.challenges.delete(challengeId);
      return { valid: false, reason: 'challenge_expired' };
    }
    
    // Verify proof
    const expectedProof = this.computeProof(challengeData.challenge, publicKey);
    const isValid = crypto.timingSafeEqual(
      Buffer.from(proof, 'hex'),
      expectedProof
    );
    
    if (isValid) {
      this.challenges.delete(challengeId);
      
      // Store successful proof
      this.proofs.set(challengeData.userId, {
        timestamp: Date.now(),
        publicKey
      });
    }
    
    return { 
      valid: isValid, 
      userId: isValid ? challengeData.userId : null 
    };
  }
  
  /**
   * Compute proof for verification
   */
  computeProof(challenge, publicKey) {
    let proof = challenge;
    
    // Multiple rounds for security
    for (let i = 0; i < this.config.proofIterations; i++) {
      const hash = crypto.createHash(this.config.hashAlgorithm);
      hash.update(proof);
      hash.update(publicKey);
      hash.update(Buffer.from(i.toString()));
      proof = hash.digest();
    }
    
    return proof;
  }
  
  /**
   * Clean up old challenges
   */
  cleanupChallenges() {
    const now = Date.now();
    const timeout = 300000; // 5 minutes
    
    for (const [id, data] of this.challenges) {
      if (now - data.timestamp > timeout) {
        this.challenges.delete(id);
      }
    }
  }
}

/**
 * Threat detection engine
 */
class ThreatDetectionEngine {
  constructor(config = {}) {
    this.config = {
      windowSize: config.windowSize || 300000, // 5 minutes
      thresholds: config.thresholds || {
        failedAuth: 5,
        requestRate: 100,
        suspiciousPatterns: 3
      },
      mlModelEnabled: config.mlModelEnabled || false,
      ...config
    };
    
    this.events = [];
    this.threats = new Map();
    this.patterns = new Map();
    
    // Initialize pattern matchers
    this.initializePatterns();
  }
  
  /**
   * Initialize threat patterns
   */
  initializePatterns() {
    // SQL injection patterns
    this.patterns.set('sql_injection', [
      /(\b(union|select|insert|update|delete|drop|create)\b.*\b(from|where|table)\b)/i,
      /(\b(or|and)\b\s*\d+\s*=\s*\d+)/i,
      /(\'|\")(\s*)(or|and)(\s*)(\d+)(\s*)(=|>|<)(\s*)(\d+)(\'|\")/i
    ]);
    
    // XSS patterns
    this.patterns.set('xss', [
      /<script[^>]*>.*?<\/script>/gi,
      /javascript:/gi,
      /on\w+\s*=/gi
    ]);
    
    // Path traversal patterns
    this.patterns.set('path_traversal', [
      /\.\.[\/\\]/g,
      /%2e%2e[%2f%5c]/gi
    ]);
    
    // Command injection patterns
    this.patterns.set('command_injection', [
      /[;&|`]\s*(ls|cat|rm|wget|curl|nc|bash|sh)/i,
      /\$\(.+\)/,
      /`.*`/
    ]);
  }
  
  /**
   * Analyze event for threats
   */
  analyzeEvent(event) {
    this.events.push({
      ...event,
      timestamp: Date.now()
    });
    
    // Clean old events
    this.cleanupEvents();
    
    // Check patterns
    const patternThreats = this.checkPatterns(event);
    
    // Check behavior
    const behaviorThreats = this.checkBehavior(event);
    
    // ML analysis if enabled
    const mlThreats = this.config.mlModelEnabled 
      ? this.mlAnalysis(event) 
      : [];
    
    // Combine threats
    const allThreats = [...patternThreats, ...behaviorThreats, ...mlThreats];
    
    // Calculate threat level
    const threatLevel = this.calculateThreatLevel(allThreats);
    
    // Store threat info
    if (threatLevel > THREAT_LEVELS.NONE) {
      const threatId = crypto.randomBytes(16).toString('hex');
      this.threats.set(threatId, {
        id: threatId,
        event,
        threats: allThreats,
        level: threatLevel,
        timestamp: Date.now()
      });
    }
    
    return {
      threatLevel,
      threats: allThreats,
      recommendation: this.getRecommendation(threatLevel, allThreats)
    };
  }
  
  /**
   * Check patterns in event
   */
  checkPatterns(event) {
    const threats = [];
    const checkString = JSON.stringify(event.data || event);
    
    for (const [patternName, patterns] of this.patterns) {
      for (const pattern of patterns) {
        if (pattern.test(checkString)) {
          threats.push({
            type: 'pattern',
            name: patternName,
            confidence: 0.9
          });
          break;
        }
      }
    }
    
    return threats;
  }
  
  /**
   * Check behavioral anomalies
   */
  checkBehavior(event) {
    const threats = [];
    const recentEvents = this.getRecentEvents(event.source);
    
    // Check failed auth attempts
    if (event.type === 'auth_failed') {
      const failedCount = recentEvents.filter(e => e.type === 'auth_failed').length;
      if (failedCount >= this.config.thresholds.failedAuth) {
        threats.push({
          type: 'behavior',
          name: 'brute_force',
          confidence: 0.8,
          count: failedCount
        });
      }
    }
    
    // Check request rate
    const requestCount = recentEvents.length;
    if (requestCount > this.config.thresholds.requestRate) {
      threats.push({
        type: 'behavior',
        name: 'rate_anomaly',
        confidence: 0.7,
        rate: requestCount
      });
    }
    
    return threats;
  }
  
  /**
   * Get recent events for source
   */
  getRecentEvents(source) {
    const cutoff = Date.now() - this.config.windowSize;
    return this.events.filter(e => 
      e.source === source && e.timestamp > cutoff
    );
  }
  
  /**
   * Calculate overall threat level
   */
  calculateThreatLevel(threats) {
    if (threats.length === 0) return THREAT_LEVELS.NONE;
    
    const maxConfidence = Math.max(...threats.map(t => t.confidence));
    const threatCount = threats.length;
    
    if (maxConfidence > 0.9 || threatCount > 3) {
      return THREAT_LEVELS.CRITICAL;
    } else if (maxConfidence > 0.7 || threatCount > 2) {
      return THREAT_LEVELS.HIGH;
    } else if (maxConfidence > 0.5 || threatCount > 1) {
      return THREAT_LEVELS.MEDIUM;
    } else {
      return THREAT_LEVELS.LOW;
    }
  }
  
  /**
   * Get recommendation based on threat
   */
  getRecommendation(level, threats) {
    switch (level) {
      case THREAT_LEVELS.CRITICAL:
        return {
          action: 'block',
          duration: 3600000, // 1 hour
          notify: true
        };
        
      case THREAT_LEVELS.HIGH:
        return {
          action: 'challenge',
          rateLimit: 10,
          notify: true
        };
        
      case THREAT_LEVELS.MEDIUM:
        return {
          action: 'monitor',
          rateLimit: 50,
          notify: false
        };
        
      case THREAT_LEVELS.LOW:
        return {
          action: 'log',
          notify: false
        };
        
      default:
        return { action: 'allow' };
    }
  }
  
  /**
   * ML-based threat analysis
   */
  mlAnalysis(event) {
    // Placeholder for ML model integration
    // In production, would use trained model
    return [];
  }
  
  /**
   * Clean up old events
   */
  cleanupEvents() {
    const cutoff = Date.now() - this.config.windowSize * 2;
    this.events = this.events.filter(e => e.timestamp > cutoff);
  }
}

/**
 * Access control manager
 */
class AccessControlManager {
  constructor(config = {}) {
    this.config = {
      defaultPolicy: config.defaultPolicy || 'deny',
      cacheEnabled: config.cacheEnabled !== false,
      cacheTTL: config.cacheTTL || 300000, // 5 minutes
      ...config
    };
    
    this.policies = new Map();
    this.roles = new Map();
    this.permissions = new Map();
    this.cache = new Map();
  }
  
  /**
   * Define role
   */
  defineRole(name, permissions = []) {
    this.roles.set(name, {
      name,
      permissions: new Set(permissions),
      created: Date.now()
    });
  }
  
  /**
   * Define policy
   */
  definePolicy(resource, action, conditions = {}) {
    const policyId = `${resource}:${action}`;
    
    this.policies.set(policyId, {
      resource,
      action,
      conditions,
      created: Date.now()
    });
  }
  
  /**
   * Check access permission
   */
  checkAccess(subject, resource, action, context = {}) {
    // Check cache
    const cacheKey = `${subject.id}:${resource}:${action}`;
    if (this.config.cacheEnabled) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.config.cacheTTL) {
        return cached.result;
      }
    }
    
    // Check role-based access
    const roles = subject.roles || [];
    let allowed = false;
    
    for (const roleName of roles) {
      const role = this.roles.get(roleName);
      if (!role) continue;
      
      const permission = `${resource}:${action}`;
      if (role.permissions.has(permission) || role.permissions.has(`${resource}:*`)) {
        allowed = true;
        break;
      }
    }
    
    // Check policy-based access
    if (!allowed) {
      const policyId = `${resource}:${action}`;
      const policy = this.policies.get(policyId);
      
      if (policy) {
        allowed = this.evaluatePolicy(policy, subject, context);
      }
    }
    
    // Apply default policy
    if (!allowed && this.config.defaultPolicy === 'allow') {
      allowed = true;
    }
    
    // Cache result
    if (this.config.cacheEnabled) {
      this.cache.set(cacheKey, {
        result: allowed,
        timestamp: Date.now()
      });
    }
    
    return allowed;
  }
  
  /**
   * Evaluate policy conditions
   */
  evaluatePolicy(policy, subject, context) {
    for (const [key, condition] of Object.entries(policy.conditions)) {
      const value = context[key] || subject[key];
      
      if (typeof condition === 'function') {
        if (!condition(value, subject, context)) {
          return false;
        }
      } else if (Array.isArray(condition)) {
        if (!condition.includes(value)) {
          return false;
        }
      } else if (value !== condition) {
        return false;
      }
    }
    
    return true;
  }
}

/**
 * Audit logger
 */
class AuditLogger {
  constructor(config = {}) {
    this.config = {
      retentionDays: config.retentionDays || 90,
      encryptLogs: config.encryptLogs !== false,
      compressionEnabled: config.compressionEnabled !== false,
      ...config
    };
    
    this.logs = [];
    this.encryptionKey = this.generateEncryptionKey();
  }
  
  /**
   * Generate encryption key
   */
  generateEncryptionKey() {
    return crypto.randomBytes(32);
  }
  
  /**
   * Log audit event
   */
  log(event) {
    const auditEntry = {
      id: crypto.randomBytes(16).toString('hex'),
      timestamp: Date.now(),
      ...event,
      hash: this.calculateHash(event)
    };
    
    // Encrypt if enabled
    if (this.config.encryptLogs) {
      auditEntry.encrypted = this.encrypt(auditEntry);
      delete auditEntry.data; // Remove unencrypted data
    }
    
    this.logs.push(auditEntry);
    
    // Clean old logs
    this.cleanupLogs();
    
    return auditEntry.id;
  }
  
  /**
   * Calculate hash for integrity
   */
  calculateHash(event) {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify({
      ...event,
      previousHash: this.logs.length > 0 
        ? this.logs[this.logs.length - 1].hash 
        : '0'
    }));
    return hash.digest('hex');
  }
  
  /**
   * Encrypt audit data
   */
  encrypt(data) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      iv
    );
    
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(data), 'utf8'),
      cipher.final()
    ]);
    
    const authTag = cipher.getAuthTag();
    
    return {
      data: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64')
    };
  }
  
  /**
   * Query audit logs
   */
  query(filters = {}) {
    let results = [...this.logs];
    
    // Apply filters
    if (filters.startTime) {
      results = results.filter(log => log.timestamp >= filters.startTime);
    }
    
    if (filters.endTime) {
      results = results.filter(log => log.timestamp <= filters.endTime);
    }
    
    if (filters.actor) {
      results = results.filter(log => log.actor === filters.actor);
    }
    
    if (filters.action) {
      results = results.filter(log => log.action === filters.action);
    }
    
    if (filters.resource) {
      results = results.filter(log => log.resource === filters.resource);
    }
    
    return results;
  }
  
  /**
   * Clean up old logs
   */
  cleanupLogs() {
    const cutoff = Date.now() - (this.config.retentionDays * 24 * 60 * 60 * 1000);
    this.logs = this.logs.filter(log => log.timestamp > cutoff);
  }
}

/**
 * Unified Security System
 */
export class UnifiedSecuritySystem extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // ZKP settings
      zkpEnabled: config.zkpEnabled !== false,
      zkpChallengeExpiry: config.zkpChallengeExpiry || 300000, // 5 minutes
      
      // Threat detection settings
      threatDetectionEnabled: config.threatDetectionEnabled !== false,
      autoBlock: config.autoBlock !== false,
      blockDuration: config.blockDuration || 3600000, // 1 hour
      
      // Access control settings
      rbacEnabled: config.rbacEnabled !== false,
      defaultAccessPolicy: config.defaultAccessPolicy || 'deny',
      
      // Audit settings
      auditEnabled: config.auditEnabled !== false,
      auditRetentionDays: config.auditRetentionDays || 90,
      
      // Rate limiting
      rateLimitEnabled: config.rateLimitEnabled !== false,
      rateLimitWindow: config.rateLimitWindow || 60000, // 1 minute
      rateLimitMax: config.rateLimitMax || 100,
      
      // Encryption settings
      encryptionAlgorithm: config.encryptionAlgorithm || 'aes-256-gcm',
      keyRotationInterval: config.keyRotationInterval || 86400000, // 24 hours
      
      ...config
    };
    
    // Initialize components
    this.zkp = new ZeroKnowledgeProof(config);
    this.threatDetector = new ThreatDetectionEngine(config);
    this.accessControl = new AccessControlManager(config);
    this.auditLogger = new AuditLogger(config);
    this.rateLimiter = new RateLimiter({
      windowMs: this.config.rateLimitWindow,
      max: this.config.rateLimitMax
    });
    
    // Security state
    this.sessions = new Map();
    this.blockedSources = new Map();
    this.encryptionKeys = new Map();
    
    // Statistics
    this.stats = {
      authAttempts: 0,
      authSuccess: 0,
      authFailures: 0,
      threatsDetected: 0,
      threatsBlocked: 0,
      accessChecks: 0,
      accessDenied: 0
    };
    
    this.logger = logger;
    
    // Initialize default roles and policies
    this.initializeDefaults();
  }
  
  /**
   * Initialize security system
   */
  async initialize() {
    // Generate master encryption key
    this.masterKey = crypto.randomBytes(32);
    
    // Start key rotation
    if (this.config.keyRotationInterval > 0) {
      this.startKeyRotation();
    }
    
    // Load security rules
    await this.loadSecurityRules();
    
    this.logger.info('Unified security system initialized', {
      zkp: this.config.zkpEnabled,
      threatDetection: this.config.threatDetectionEnabled,
      rbac: this.config.rbacEnabled,
      audit: this.config.auditEnabled
    });
  }
  
  /**
   * Initialize default roles and policies
   */
  initializeDefaults() {
    // Default roles
    this.accessControl.defineRole('admin', [
      '*:*' // All permissions
    ]);
    
    this.accessControl.defineRole('operator', [
      'pool:read',
      'pool:manage',
      'miner:read',
      'miner:manage'
    ]);
    
    this.accessControl.defineRole('miner', [
      'pool:read',
      'miner:read',
      'miner:submit'
    ]);
    
    this.accessControl.defineRole('viewer', [
      'pool:read',
      'stats:read'
    ]);
    
    // Default policies
    this.accessControl.definePolicy('api', 'access', {
      authenticated: true
    });
    
    this.accessControl.definePolicy('admin', 'access', {
      role: ['admin']
    });
  }
  
  /**
   * Authenticate with Zero-Knowledge Proof
   */
  async authenticateZKP(userId, publicKey, proof = null) {
    this.stats.authAttempts++;
    
    // Log attempt
    if (this.config.auditEnabled) {
      this.auditLogger.log({
        action: 'auth_attempt',
        actor: userId,
        method: 'zkp',
        timestamp: Date.now()
      });
    }
    
    // Check if blocked
    if (this.isBlocked(userId)) {
      this.stats.authFailures++;
      return {
        success: false,
        reason: 'blocked'
      };
    }
    
    // Rate limiting
    if (this.config.rateLimitEnabled) {
      const allowed = await this.rateLimiter.check(userId);
      if (!allowed) {
        this.stats.authFailures++;
        return {
          success: false,
          reason: 'rate_limited'
        };
      }
    }
    
    if (!proof) {
      // Generate challenge
      const challenge = this.zkp.generateChallenge(userId);
      return {
        success: false,
        challenge: challenge
      };
    } else {
      // Verify proof
      const result = this.zkp.verifyProof(proof.challengeId, proof.proof, publicKey);
      
      if (result.valid) {
        // Create session
        const sessionId = crypto.randomBytes(32).toString('hex');
        const session = {
          id: sessionId,
          userId: result.userId,
          publicKey,
          created: Date.now(),
          lastActivity: Date.now(),
          roles: await this.getUserRoles(result.userId)
        };
        
        this.sessions.set(sessionId, session);
        
        // Log success
        if (this.config.auditEnabled) {
          this.auditLogger.log({
            action: 'auth_success',
            actor: result.userId,
            method: 'zkp',
            sessionId
          });
        }
        
        this.stats.authSuccess++;
        
        this.emit('auth:success', {
          userId: result.userId,
          sessionId
        });
        
        return {
          success: true,
          sessionId,
          userId: result.userId
        };
      } else {
        // Log failure
        if (this.config.auditEnabled) {
          this.auditLogger.log({
            action: 'auth_failed',
            actor: userId,
            method: 'zkp',
            reason: result.reason
          });
        }
        
        // Check for threats
        if (this.config.threatDetectionEnabled) {
          const threatAnalysis = this.threatDetector.analyzeEvent({
            type: 'auth_failed',
            source: userId,
            data: { reason: result.reason }
          });
          
          if (threatAnalysis.threatLevel >= THREAT_LEVELS.HIGH) {
            this.handleThreat(userId, threatAnalysis);
          }
        }
        
        this.stats.authFailures++;
        
        return {
          success: false,
          reason: result.reason
        };
      }
    }
  }
  
  /**
   * Validate session
   */
  validateSession(sessionId) {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return { valid: false, reason: 'invalid_session' };
    }
    
    // Check expiry (24 hours)
    if (Date.now() - session.created > 86400000) {
      this.sessions.delete(sessionId);
      return { valid: false, reason: 'session_expired' };
    }
    
    // Update activity
    session.lastActivity = Date.now();
    
    return {
      valid: true,
      userId: session.userId,
      roles: session.roles
    };
  }
  
  /**
   * Check access permission
   */
  checkAccess(sessionId, resource, action, context = {}) {
    this.stats.accessChecks++;
    
    // Validate session
    const sessionResult = this.validateSession(sessionId);
    if (!sessionResult.valid) {
      this.stats.accessDenied++;
      return {
        allowed: false,
        reason: sessionResult.reason
      };
    }
    
    // Get session
    const session = this.sessions.get(sessionId);
    
    // Check access
    const allowed = this.accessControl.checkAccess(
      {
        id: session.userId,
        roles: session.roles
      },
      resource,
      action,
      context
    );
    
    // Audit log
    if (this.config.auditEnabled) {
      this.auditLogger.log({
        action: 'access_check',
        actor: session.userId,
        resource,
        operation: action,
        allowed,
        context
      });
    }
    
    if (!allowed) {
      this.stats.accessDenied++;
    }
    
    return {
      allowed,
      userId: session.userId
    };
  }
  
  /**
   * Analyze request for threats
   */
  analyzeRequest(request) {
    if (!this.config.threatDetectionEnabled) {
      return { safe: true };
    }
    
    const analysis = this.threatDetector.analyzeEvent({
      type: 'request',
      source: request.ip || request.source,
      data: {
        method: request.method,
        path: request.path,
        headers: request.headers,
        body: request.body,
        query: request.query
      }
    });
    
    if (analysis.threatLevel >= THREAT_LEVELS.MEDIUM) {
      this.stats.threatsDetected++;
      
      if (analysis.threatLevel >= THREAT_LEVELS.HIGH && this.config.autoBlock) {
        this.handleThreat(request.ip || request.source, analysis);
      }
      
      this.emit('threat:detected', {
        source: request.ip || request.source,
        analysis
      });
    }
    
    return {
      safe: analysis.threatLevel < THREAT_LEVELS.HIGH,
      threatLevel: analysis.threatLevel,
      threats: analysis.threats,
      recommendation: analysis.recommendation
    };
  }
  
  /**
   * Handle detected threat
   */
  handleThreat(source, analysis) {
    this.stats.threatsBlocked++;
    
    // Block source
    if (analysis.recommendation.action === 'block') {
      this.blockSource(source, analysis.recommendation.duration);
    }
    
    // Audit log
    if (this.config.auditEnabled) {
      this.auditLogger.log({
        action: 'threat_blocked',
        source,
        threatLevel: analysis.threatLevel,
        threats: analysis.threats
      });
    }
    
    this.emit('threat:blocked', {
      source,
      analysis
    });
  }
  
  /**
   * Block source
   */
  blockSource(source, duration = this.config.blockDuration) {
    this.blockedSources.set(source, {
      blockedAt: Date.now(),
      duration,
      expires: Date.now() + duration
    });
    
    // Clean expired blocks
    this.cleanupBlocks();
  }
  
  /**
   * Check if source is blocked
   */
  isBlocked(source) {
    const block = this.blockedSources.get(source);
    
    if (!block) return false;
    
    if (Date.now() > block.expires) {
      this.blockedSources.delete(source);
      return false;
    }
    
    return true;
  }
  
  /**
   * Clean up expired blocks
   */
  cleanupBlocks() {
    const now = Date.now();
    
    for (const [source, block] of this.blockedSources) {
      if (now > block.expires) {
        this.blockedSources.delete(source);
      }
    }
  }
  
  /**
   * Encrypt data
   */
  encrypt(data, keyId = 'default') {
    const key = this.getEncryptionKey(keyId);
    const iv = crypto.randomBytes(16);
    
    const cipher = crypto.createCipheriv(
      this.config.encryptionAlgorithm,
      key,
      iv
    );
    
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(data), 'utf8'),
      cipher.final()
    ]);
    
    return {
      data: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      keyId,
      algorithm: this.config.encryptionAlgorithm
    };
  }
  
  /**
   * Decrypt data
   */
  decrypt(encryptedData) {
    const key = this.getEncryptionKey(encryptedData.keyId);
    const iv = Buffer.from(encryptedData.iv, 'base64');
    
    const decipher = crypto.createDecipheriv(
      encryptedData.algorithm || this.config.encryptionAlgorithm,
      key,
      iv
    );
    
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedData.data, 'base64')),
      decipher.final()
    ]);
    
    return JSON.parse(decrypted.toString('utf8'));
  }
  
  /**
   * Get or generate encryption key
   */
  getEncryptionKey(keyId) {
    if (!this.encryptionKeys.has(keyId)) {
      const key = crypto.pbkdf2Sync(
        this.masterKey,
        keyId,
        100000,
        32,
        'sha256'
      );
      this.encryptionKeys.set(keyId, key);
    }
    
    return this.encryptionKeys.get(keyId);
  }
  
  /**
   * Start key rotation
   */
  startKeyRotation() {
    this.keyRotationInterval = setInterval(() => {
      this.rotateKeys();
    }, this.config.keyRotationInterval);
  }
  
  /**
   * Rotate encryption keys
   */
  rotateKeys() {
    // Generate new master key
    const newMasterKey = crypto.randomBytes(32);
    
    // Re-encrypt sensitive data with new key
    // In production, would need to re-encrypt stored data
    
    this.masterKey = newMasterKey;
    this.encryptionKeys.clear();
    
    this.logger.info('Encryption keys rotated');
  }
  
  /**
   * Get user roles
   */
  async getUserRoles(userId) {
    // In production, would fetch from database
    // For now, return default role
    return ['miner'];
  }
  
  /**
   * Load security rules
   */
  async loadSecurityRules() {
    // In production, would load from configuration
    // Custom policies, roles, threat patterns, etc.
  }
  
  /**
   * Get security statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeSessions: this.sessions.size,
      blockedSources: this.blockedSources.size,
      zkpChallenges: this.zkp.challenges.size,
      threats: this.threatDetector.threats.size,
      auditLogs: this.auditLogger.logs.length
    };
  }
  
  /**
   * Export audit logs
   */
  exportAuditLogs(filters = {}) {
    return this.auditLogger.query(filters);
  }
  
  /**
   * Shutdown security system
   */
  async shutdown() {
    // Clear intervals
    if (this.keyRotationInterval) {
      clearInterval(this.keyRotationInterval);
    }
    
    // Clear sensitive data
    this.sessions.clear();
    this.encryptionKeys.clear();
    this.zkp.challenges.clear();
    
    this.logger.info('Security system shutdown');
  }
}

// Export constants
export {
  SECURITY_DOMAINS,
  THREAT_LEVELS
};

export default UnifiedSecuritySystem;