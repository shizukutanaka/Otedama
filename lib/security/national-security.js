/**
 * National-Grade Security System for Otedama
 * Enterprise-level security with advanced threat protection
 * 
 * Design:
 * - Carmack: Fast security checks without performance impact
 * - Martin: Layered security architecture
 * - Pike: Simple but effective security measures
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';
import { CircuitBreaker } from '../core/error-handler-unified.js';

// Security constants
const MAX_REQUESTS_PER_MINUTE = 1000;
const MAX_REQUESTS_PER_SECOND = 50;
const BLACKLIST_DURATION = 86400000; // 24 hours
const GRAYLIST_DURATION = 3600000; // 1 hour
const PATTERN_WINDOW = 300000; // 5 minutes
const ENTROPY_THRESHOLD = 3.5; // For anomaly detection
const MIN_REQUEST_INTERVAL = 20; // 20ms minimum between requests

/**
 * Advanced rate limiter with multiple algorithms
 */
class AdvancedRateLimiter {
  constructor(options = {}) {
    this.limits = {
      perSecond: options.perSecond || MAX_REQUESTS_PER_SECOND,
      perMinute: options.perMinute || MAX_REQUESTS_PER_MINUTE,
      burst: options.burst || 100
    };
    
    // Token bucket for burst handling
    this.tokens = new Map();
    
    // Sliding window for accurate rate limiting
    this.windows = new Map();
    
    // Request patterns for anomaly detection
    this.patterns = new Map();
  }
  
  /**
   * Check if request is allowed
   */
  async checkRequest(identifier, weight = 1) {
    const now = Date.now();
    
    // Check token bucket
    if (!this.checkTokenBucket(identifier, weight, now)) {
      return { allowed: false, reason: 'burst_limit', retryAfter: 1000 };
    }
    
    // Check sliding window
    const windowCheck = this.checkSlidingWindow(identifier, now);
    if (!windowCheck.allowed) {
      return windowCheck;
    }
    
    // Update pattern tracking
    this.updatePattern(identifier, now);
    
    return { allowed: true };
  }
  
  /**
   * Token bucket algorithm for burst handling
   */
  checkTokenBucket(identifier, weight, now) {
    let bucket = this.tokens.get(identifier);
    
    if (!bucket) {
      bucket = {
        tokens: this.limits.burst,
        lastRefill: now
      };
      this.tokens.set(identifier, bucket);
    }
    
    // Refill tokens
    const elapsed = now - bucket.lastRefill;
    const refillRate = this.limits.perSecond;
    const newTokens = Math.floor(elapsed * refillRate / 1000);
    
    if (newTokens > 0) {
      bucket.tokens = Math.min(this.limits.burst, bucket.tokens + newTokens);
      bucket.lastRefill = now;
    }
    
    // Check if enough tokens
    if (bucket.tokens >= weight) {
      bucket.tokens -= weight;
      return true;
    }
    
    return false;
  }
  
  /**
   * Sliding window algorithm for precise rate limiting
   */
  checkSlidingWindow(identifier, now) {
    let window = this.windows.get(identifier);
    
    if (!window) {
      window = {
        requests: [],
        blocked: false,
        blockUntil: 0
      };
      this.windows.set(identifier, window);
    }
    
    // Check if currently blocked
    if (window.blocked && now < window.blockUntil) {
      return {
        allowed: false,
        reason: 'rate_limit',
        retryAfter: window.blockUntil - now
      };
    }
    
    // Clean old requests
    const oneMinuteAgo = now - 60000;
    window.requests = window.requests.filter(t => t > oneMinuteAgo);
    
    // Check per-minute limit
    if (window.requests.length >= this.limits.perMinute) {
      window.blocked = true;
      window.blockUntil = now + 60000;
      return {
        allowed: false,
        reason: 'minute_limit',
        retryAfter: 60000
      };
    }
    
    // Check per-second limit
    const oneSecondAgo = now - 1000;
    const recentRequests = window.requests.filter(t => t > oneSecondAgo);
    
    if (recentRequests.length >= this.limits.perSecond) {
      return {
        allowed: false,
        reason: 'second_limit',
        retryAfter: 1000
      };
    }
    
    // Add current request
    window.requests.push(now);
    
    return { allowed: true };
  }
  
  /**
   * Update request pattern for anomaly detection
   */
  updatePattern(identifier, now) {
    let pattern = this.patterns.get(identifier);
    
    if (!pattern) {
      pattern = {
        timestamps: [],
        intervals: [],
        lastRequest: now
      };
      this.patterns.set(identifier, pattern);
    }
    
    // Calculate interval
    const interval = now - pattern.lastRequest;
    pattern.lastRequest = now;
    
    // Update pattern data
    pattern.timestamps.push(now);
    if (pattern.timestamps.length > 1) {
      pattern.intervals.push(interval);
    }
    
    // Keep only recent data
    const cutoff = now - PATTERN_WINDOW;
    pattern.timestamps = pattern.timestamps.filter(t => t > cutoff);
    if (pattern.intervals.length > 100) {
      pattern.intervals = pattern.intervals.slice(-100);
    }
  }
  
  /**
   * Calculate request pattern entropy for anomaly detection
   */
  calculateEntropy(identifier) {
    const pattern = this.patterns.get(identifier);
    if (!pattern || pattern.intervals.length < 10) {
      return 0;
    }
    
    // Calculate interval distribution
    const buckets = new Map();
    const bucketSize = 100; // 100ms buckets
    
    for (const interval of pattern.intervals) {
      const bucket = Math.floor(interval / bucketSize);
      buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
    }
    
    // Calculate entropy
    let entropy = 0;
    const total = pattern.intervals.length;
    
    for (const count of buckets.values()) {
      const probability = count / total;
      if (probability > 0) {
        entropy -= probability * Math.log2(probability);
      }
    }
    
    return entropy;
  }
  
  /**
   * Clean up old data
   */
  cleanup() {
    const now = Date.now();
    const cutoff = now - 300000; // 5 minutes
    
    // Clean patterns
    for (const [id, pattern] of this.patterns) {
      if (pattern.lastRequest < cutoff) {
        this.patterns.delete(id);
      }
    }
    
    // Clean windows
    for (const [id, window] of this.windows) {
      if (window.requests.length === 0 && window.blockUntil < now) {
        this.windows.delete(id);
      }
    }
    
    // Clean tokens
    for (const [id, bucket] of this.tokens) {
      if (bucket.lastRefill < cutoff) {
        this.tokens.delete(id);
      }
    }
  }
}

/**
 * IP reputation and blacklist management
 */
class ReputationManager {
  constructor() {
    this.whitelist = new Set();
    this.blacklist = new Map(); // IP -> expiry
    this.graylist = new Map(); // IP -> { score, expiry }
    this.reputation = new Map(); // IP -> score
    
    // Threat intelligence feeds (would be external in production)
    this.threatFeeds = new Set();
    
    // Geographic restrictions
    this.geoBlacklist = new Set(); // Country codes
    this.geoWhitelist = null; // If set, only allow these countries
  }
  
  /**
   * Check IP reputation
   */
  checkIP(ip, options = {}) {
    // Check whitelist first
    if (this.whitelist.has(ip)) {
      return { allowed: true, reason: 'whitelisted' };
    }
    
    // Check blacklist
    const blacklistExpiry = this.blacklist.get(ip);
    if (blacklistExpiry && Date.now() < blacklistExpiry) {
      return { allowed: false, reason: 'blacklisted' };
    }
    
    // Check graylist
    const graylistEntry = this.graylist.get(ip);
    if (graylistEntry && Date.now() < graylistEntry.expiry) {
      if (graylistEntry.score < -50) {
        return { allowed: false, reason: 'graylisted' };
      }
    }
    
    // Check threat feeds
    if (this.threatFeeds.has(ip)) {
      return { allowed: false, reason: 'threat_feed' };
    }
    
    // Check geographic restrictions
    if (options.country) {
      if (this.geoBlacklist.has(options.country)) {
        return { allowed: false, reason: 'geo_blocked' };
      }
      
      if (this.geoWhitelist && !this.geoWhitelist.has(options.country)) {
        return { allowed: false, reason: 'geo_restricted' };
      }
    }
    
    return { allowed: true };
  }
  
  /**
   * Update IP reputation based on behavior
   */
  updateReputation(ip, event) {
    let score = this.reputation.get(ip) || 0;
    
    switch (event) {
      case 'valid_request':
        score = Math.min(100, score + 1);
        break;
      case 'invalid_request':
        score = Math.max(-100, score - 5);
        break;
      case 'rate_limit':
        score = Math.max(-100, score - 10);
        break;
      case 'malicious_pattern':
        score = Math.max(-100, score - 25);
        break;
      case 'authentication_failure':
        score = Math.max(-100, score - 15);
        break;
      case 'suspicious_activity':
        score = Math.max(-100, score - 20);
        break;
    }
    
    this.reputation.set(ip, score);
    
    // Auto-blacklist if score too low
    if (score <= -75) {
      this.blacklist.set(ip, Date.now() + BLACKLIST_DURATION);
    } else if (score <= -25) {
      this.graylist.set(ip, {
        score,
        expiry: Date.now() + GRAYLIST_DURATION
      });
    }
    
    return score;
  }
  
  /**
   * Add IP to whitelist
   */
  addToWhitelist(ip) {
    this.whitelist.add(ip);
    this.blacklist.delete(ip);
    this.graylist.delete(ip);
  }
  
  /**
   * Add IP to blacklist
   */
  addToBlacklist(ip, duration = BLACKLIST_DURATION) {
    this.blacklist.set(ip, Date.now() + duration);
    this.whitelist.delete(ip);
  }
  
  /**
   * Clean up expired entries
   */
  cleanup() {
    const now = Date.now();
    
    // Clean blacklist
    for (const [ip, expiry] of this.blacklist) {
      if (now > expiry) {
        this.blacklist.delete(ip);
      }
    }
    
    // Clean graylist
    for (const [ip, entry] of this.graylist) {
      if (now > entry.expiry) {
        this.graylist.delete(ip);
      }
    }
  }
}

/**
 * Pattern-based attack detection
 */
class AttackDetector extends EventEmitter {
  constructor() {
    super();
    
    this.patterns = {
      // SQL injection patterns
      sqlInjection: [
        /(\b(union|select|insert|update|delete|drop|create)\b.*\b(from|where|table)\b)/i,
        /(\b(or|and)\b\s*\d+\s*=\s*\d+)/i,
        /(--|\#|\/\*|\*\/)/,
        /(\bexec(ute)?\b|\bsp_\w+)/i
      ],
      
      // XSS patterns
      xss: [
        /<script[^>]*>[\s\S]*?<\/script>/gi,
        /javascript:/gi,
        /on\w+\s*=/gi,
        /<iframe|<object|<embed/gi
      ],
      
      // Path traversal
      pathTraversal: [
        /\.\.[\/\\]/g,
        /%2e%2e[%2f%5c]/gi,
        /\x00/g
      ],
      
      // Command injection
      commandInjection: [
        /[;&|`$]/g,
        /\b(cat|ls|pwd|whoami|id|uname)\b/g
      ]
    };
    
    // Behavioral patterns
    this.behaviorTracking = new Map();
    
    // Machine learning model placeholder
    this.mlModel = null;
  }
  
  /**
   * Detect malicious patterns in request
   */
  detectAttack(request) {
    const threats = [];
    
    // Check URL
    if (request.url) {
      threats.push(...this.checkPatterns(request.url, 'url'));
    }
    
    // Check headers
    for (const [header, value] of Object.entries(request.headers || {})) {
      threats.push(...this.checkPatterns(value, `header:${header}`));
    }
    
    // Check body
    if (request.body) {
      const bodyStr = typeof request.body === 'string' 
        ? request.body 
        : JSON.stringify(request.body);
      threats.push(...this.checkPatterns(bodyStr, 'body'));
    }
    
    // Check behavior
    const behaviorThreat = this.checkBehavior(request);
    if (behaviorThreat) {
      threats.push(behaviorThreat);
    }
    
    return threats;
  }
  
  /**
   * Check string against attack patterns
   */
  checkPatterns(input, location) {
    const threats = [];
    
    for (const [attackType, patterns] of Object.entries(this.patterns)) {
      for (const pattern of patterns) {
        if (pattern.test(input)) {
          threats.push({
            type: attackType,
            location,
            pattern: pattern.toString(),
            severity: this.getSeverity(attackType),
            confidence: 0.8
          });
        }
      }
    }
    
    return threats;
  }
  
  /**
   * Check behavioral patterns
   */
  checkBehavior(request) {
    const ip = request.ip;
    if (!ip) return null;
    
    let behavior = this.behaviorTracking.get(ip);
    if (!behavior) {
      behavior = {
        requests: [],
        uniqueUrls: new Set(),
        uniqueUserAgents: new Set(),
        methods: new Map(),
        errors: 0
      };
      this.behaviorTracking.set(ip, behavior);
    }
    
    // Update behavior
    const now = Date.now();
    behavior.requests.push(now);
    behavior.uniqueUrls.add(request.url);
    behavior.uniqueUserAgents.add(request.headers?.['user-agent']);
    
    const method = request.method || 'GET';
    behavior.methods.set(method, (behavior.methods.get(method) || 0) + 1);
    
    // Clean old data
    const fiveMinutesAgo = now - 300000;
    behavior.requests = behavior.requests.filter(t => t > fiveMinutesAgo);
    
    // Detect anomalies
    if (behavior.requests.length > 1000) {
      return {
        type: 'dos_attack',
        location: 'behavior',
        severity: 'high',
        confidence: 0.9,
        details: { requestCount: behavior.requests.length }
      };
    }
    
    if (behavior.uniqueUserAgents.size > 10) {
      return {
        type: 'bot_behavior',
        location: 'behavior',
        severity: 'medium',
        confidence: 0.7,
        details: { userAgentCount: behavior.uniqueUserAgents.size }
      };
    }
    
    if (behavior.uniqueUrls.size > 100 && behavior.requests.length < 200) {
      return {
        type: 'scanner_behavior',
        location: 'behavior',
        severity: 'medium',
        confidence: 0.8,
        details: { 
          urlCount: behavior.uniqueUrls.size,
          requestCount: behavior.requests.length
        }
      };
    }
    
    return null;
  }
  
  /**
   * Get attack severity
   */
  getSeverity(attackType) {
    const severityMap = {
      sqlInjection: 'critical',
      xss: 'high',
      pathTraversal: 'high',
      commandInjection: 'critical',
      dos_attack: 'high',
      bot_behavior: 'medium',
      scanner_behavior: 'medium'
    };
    
    return severityMap[attackType] || 'medium';
  }
  
  /**
   * Clean up old behavioral data
   */
  cleanup() {
    const cutoff = Date.now() - 3600000; // 1 hour
    
    for (const [ip, behavior] of this.behaviorTracking) {
      if (behavior.requests.length === 0 || 
          behavior.requests[behavior.requests.length - 1] < cutoff) {
        this.behaviorTracking.delete(ip);
      }
    }
  }
}

/**
 * National-grade security system
 */
export class SecuritySystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      rateLimiting: options.rateLimiting !== false,
      reputationChecking: options.reputationChecking !== false,
      attackDetection: options.attackDetection !== false,
      encryption: options.encryption !== false,
      ...options
    };
    
    // Initialize components
    this.rateLimiter = new AdvancedRateLimiter(options.rateLimit);
    this.reputation = new ReputationManager();
    this.attackDetector = new AttackDetector();
    
    // Circuit breakers for external services
    this.circuitBreakers = new Map();
    
    // Statistics
    this.stats = {
      totalRequests: 0,
      blockedRequests: 0,
      detectedAttacks: 0,
      blacklistedIPs: 0
    };
    
    // Logger
    this.logger = createStructuredLogger('SecuritySystem');
    
    // Setup event handlers
    this.setupEventHandlers();
    
    // Start maintenance
    this.startMaintenance();
  }
  
  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.attackDetector.on('attack', (attack) => {
      this.stats.detectedAttacks++;
      this.logger.warn('Attack detected', attack);
      
      // Update reputation
      if (attack.ip) {
        this.reputation.updateReputation(attack.ip, 'malicious_pattern');
      }
    });
  }
  
  /**
   * Start maintenance tasks
   */
  startMaintenance() {
    // Cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.rateLimiter.cleanup();
      this.reputation.cleanup();
      this.attackDetector.cleanup();
    }, 300000); // 5 minutes
    
    // Stats reporting
    this.statsInterval = setInterval(() => {
      this.logger.info('Security statistics', this.getStats());
    }, 3600000); // 1 hour
  }
  
  /**
   * Check request security
   */
  async checkRequest(request) {
    this.stats.totalRequests++;
    
    const checks = [];
    const ip = request.ip || request.connection?.remoteAddress;
    
    // IP reputation check
    if (this.options.reputationChecking && ip) {
      const repCheck = this.reputation.checkIP(ip, { 
        country: request.country 
      });
      
      if (!repCheck.allowed) {
        this.stats.blockedRequests++;
        return {
          allowed: false,
          reason: repCheck.reason,
          action: 'block'
        };
      }
    }
    
    // Rate limiting
    if (this.options.rateLimiting && ip) {
      const rateCheck = await this.rateLimiter.checkRequest(ip);
      
      if (!rateCheck.allowed) {
        this.stats.blockedRequests++;
        this.reputation.updateReputation(ip, 'rate_limit');
        
        return {
          allowed: false,
          reason: rateCheck.reason,
          retryAfter: rateCheck.retryAfter,
          action: 'rate_limit'
        };
      }
    }
    
    // Attack detection
    if (this.options.attackDetection) {
      const threats = this.attackDetector.detectAttack(request);
      
      if (threats.length > 0) {
        this.stats.detectedAttacks++;
        
        // Check severity
        const critical = threats.some(t => 
          t.severity === 'critical' && t.confidence > 0.7
        );
        
        if (critical) {
          this.stats.blockedRequests++;
          
          if (ip) {
            this.reputation.addToBlacklist(ip);
            this.stats.blacklistedIPs++;
          }
          
          return {
            allowed: false,
            reason: 'attack_detected',
            threats,
            action: 'block'
          };
        }
        
        // Log but allow for lower severity
        this.logger.warn('Potential threats detected', { threats, ip });
        
        if (ip) {
          this.reputation.updateReputation(ip, 'suspicious_activity');
        }
      }
    }
    
    // Check request entropy for anomalies
    if (ip) {
      const entropy = this.rateLimiter.calculateEntropy(ip);
      if (entropy > ENTROPY_THRESHOLD) {
        this.logger.warn('High entropy detected', { ip, entropy });
        this.reputation.updateReputation(ip, 'suspicious_activity');
      }
    }
    
    return {
      allowed: true,
      checks: {
        reputation: 'passed',
        rateLimit: 'passed',
        attacks: 'passed'
      }
    };
  }
  
  /**
   * Express middleware
   */
  middleware() {
    return async (req, res, next) => {
      const result = await this.checkRequest(req);
      
      if (!result.allowed) {
        const status = result.action === 'rate_limit' ? 429 : 403;
        
        res.status(status).json({
          error: {
            code: result.reason.toUpperCase(),
            message: `Access denied: ${result.reason}`,
            retryAfter: result.retryAfter
          }
        });
        
        return;
      }
      
      // Add security headers
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      
      next();
    };
  }
  
  /**
   * WebSocket security check
   */
  async checkWebSocket(ws, req) {
    const result = await this.checkRequest(req);
    
    if (!result.allowed) {
      ws.close(1008, result.reason);
      return false;
    }
    
    return true;
  }
  
  /**
   * Add IP to whitelist
   */
  whitelist(ip) {
    this.reputation.addToWhitelist(ip);
    this.logger.info('IP whitelisted', { ip });
  }
  
  /**
   * Add IP to blacklist
   */
  blacklist(ip, duration) {
    this.reputation.addToBlacklist(ip, duration);
    this.stats.blacklistedIPs++;
    this.logger.info('IP blacklisted', { ip, duration });
  }
  
  /**
   * Get security statistics
   */
  getStats() {
    return {
      requests: this.stats,
      reputation: {
        whitelisted: this.reputation.whitelist.size,
        blacklisted: this.reputation.blacklist.size,
        graylisted: this.reputation.graylist.size
      },
      rateLimiter: {
        activeIPs: this.rateLimiter.windows.size,
        patterns: this.rateLimiter.patterns.size
      },
      attackDetector: {
        tracking: this.attackDetector.behaviorTracking.size
      }
    };
  }
  
  /**
   * Shutdown security system
   */
  shutdown() {
    clearInterval(this.cleanupInterval);
    clearInterval(this.statsInterval);
    this.removeAllListeners();
  }
}

// Export components
export {
  AdvancedRateLimiter,
  ReputationManager,
  AttackDetector
};

export default SecuritySystem;
