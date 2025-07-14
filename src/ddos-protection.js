import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { createHash, randomBytes } from 'crypto';

/**
 * Advanced DDoS Protection System
 * 高度なDDoS攻撃防御システム
 * 
 * John Carmack Style: Real-time attack detection and mitigation
 * Rob Pike Style: Simple, effective protection mechanisms
 * Robert C. Martin Style: Clean, modular security architecture
 * 
 * Features:
 * - Multi-layer rate limiting
 * - Adaptive threshold adjustment
 * - Pattern-based attack detection
 * - Automatic blacklisting
 * - Challenge-response system
 * - Traffic analysis
 * - Distributed attack mitigation
 */
export class DDoSProtection extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = new Logger('DDoS');
    
    // Configuration
    this.config = {
      // Rate limiting
      windowSize: options.windowSize || 60000, // 1 minute
      maxRequestsPerWindow: options.maxRequestsPerWindow || 100,
      maxRequestsPerSecond: options.maxRequestsPerSecond || 10,
      
      // Connection limits
      maxConnectionsPerIP: options.maxConnectionsPerIP || 10,
      maxTotalConnections: options.maxTotalConnections || 1000,
      
      // Blacklist settings
      blacklistDuration: options.blacklistDuration || 3600000, // 1 hour
      blacklistThreshold: options.blacklistThreshold || 5, // violations before blacklist
      
      // Challenge system
      enableChallenge: options.enableChallenge !== false,
      challengeDifficulty: options.challengeDifficulty || 4, // leading zeros
      challengeTimeout: options.challengeTimeout || 30000, // 30 seconds
      
      // Adaptive protection
      enableAdaptive: options.enableAdaptive !== false,
      adaptiveWindow: options.adaptiveWindow || 300000, // 5 minutes
      
      // Pattern detection
      enablePatternDetection: options.enablePatternDetection !== false,
      suspiciousPatterns: options.suspiciousPatterns || [
        /\/\.\.\//, // Directory traversal
        /\<script\>/i, // XSS attempt
        /union.*select/i, // SQL injection
        /\x00/, // Null byte
      ]
    };
    
    // Rate limiting buckets
    this.rateLimitBuckets = new Map();
    this.connectionCounts = new Map();
    this.blacklist = new Map();
    this.whitelist = new Set(options.whitelist || []);
    this.challenges = new Map();
    
    // Attack detection
    this.violations = new Map();
    this.attackPatterns = new Map();
    this.trafficHistory = [];
    
    // Statistics
    this.stats = {
      totalRequests: 0,
      blockedRequests: 0,
      challengesIssued: 0,
      challengesPassed: 0,
      blacklistedIPs: 0,
      detectedAttacks: 0,
      adaptiveAdjustments: 0
    };
    
    // Adaptive thresholds
    this.adaptiveThresholds = {
      requestsPerWindow: this.config.maxRequestsPerWindow,
      requestsPerSecond: this.config.maxRequestsPerSecond,
      connectionsPerIP: this.config.maxConnectionsPerIP
    };
    
    this.initialize();
  }

  /**
   * Initialize DDoS protection
   */
  initialize() {
    // Start cleanup timers
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 60000); // 1 minute
    
    // Start adaptive adjustment
    if (this.config.enableAdaptive) {
      this.adaptiveTimer = setInterval(() => {
        this.adjustAdaptiveThresholds();
      }, this.config.adaptiveWindow);
    }
    
    // Start traffic analysis
    this.analysisTimer = setInterval(() => {
      this.analyzeTraffic();
    }, 10000); // 10 seconds
    
    this.logger.info('DDoS protection initialized');
  }

  /**
   * Check if request should be allowed
   */
  async checkRequest(ip, path, headers = {}) {
    try {
      this.stats.totalRequests++;
      
      // Check whitelist
      if (this.whitelist.has(ip)) {
        return { allowed: true, reason: 'whitelisted' };
      }
      
      // Check blacklist
      if (this.isBlacklisted(ip)) {
        this.stats.blockedRequests++;
        return { allowed: false, reason: 'blacklisted' };
      }
      
      // Check rate limits
      const rateCheck = this.checkRateLimit(ip);
      if (!rateCheck.allowed) {
        this.recordViolation(ip, 'rate_limit');
        this.stats.blockedRequests++;
        return rateCheck;
      }
      
      // Check connection limit
      const connCheck = this.checkConnectionLimit(ip);
      if (!connCheck.allowed) {
        this.recordViolation(ip, 'connection_limit');
        this.stats.blockedRequests++;
        return connCheck;
      }
      
      // Check for suspicious patterns
      if (this.config.enablePatternDetection) {
        const patternCheck = this.checkPatterns(path, headers);
        if (!patternCheck.allowed) {
          this.recordViolation(ip, 'suspicious_pattern');
          this.stats.blockedRequests++;
          return patternCheck;
        }
      }
      
      // Check if challenge is required
      if (this.config.enableChallenge && this.requiresChallenge(ip)) {
        const challenge = this.issueChallenge(ip);
        return {
          allowed: false,
          reason: 'challenge_required',
          challenge: challenge
        };
      }
      
      // Record traffic for analysis
      this.recordTraffic(ip, path);
      
      return { allowed: true, reason: 'passed' };
      
    } catch (error) {
      this.logger.error('Error checking request:', error);
      return { allowed: false, reason: 'error' };
    }
  }

  /**
   * Check rate limits
   */
  checkRateLimit(ip) {
    const now = Date.now();
    
    // Get or create bucket
    let bucket = this.rateLimitBuckets.get(ip);
    if (!bucket) {
      bucket = {
        windowStart: now,
        windowCount: 0,
        secondStart: now,
        secondCount: 0,
        history: []
      };
      this.rateLimitBuckets.set(ip, bucket);
    }
    
    // Check window rate limit
    if (now - bucket.windowStart > this.config.windowSize) {
      bucket.windowStart = now;
      bucket.windowCount = 0;
    }
    
    if (bucket.windowCount >= this.adaptiveThresholds.requestsPerWindow) {
      return {
        allowed: false,
        reason: 'rate_limit_window',
        retryAfter: bucket.windowStart + this.config.windowSize - now
      };
    }
    
    // Check per-second rate limit
    if (now - bucket.secondStart > 1000) {
      bucket.secondStart = now;
      bucket.secondCount = 0;
    }
    
    if (bucket.secondCount >= this.adaptiveThresholds.requestsPerSecond) {
      return {
        allowed: false,
        reason: 'rate_limit_second',
        retryAfter: 1000 - (now - bucket.secondStart)
      };
    }
    
    // Update counts
    bucket.windowCount++;
    bucket.secondCount++;
    bucket.history.push(now);
    
    // Keep only recent history
    bucket.history = bucket.history.filter(t => now - t < this.config.windowSize);
    
    return { allowed: true };
  }

  /**
   * Check connection limits
   */
  checkConnectionLimit(ip) {
    const connections = this.connectionCounts.get(ip) || 0;
    
    if (connections >= this.adaptiveThresholds.connectionsPerIP) {
      return {
        allowed: false,
        reason: 'connection_limit',
        current: connections,
        limit: this.adaptiveThresholds.connectionsPerIP
      };
    }
    
    const totalConnections = Array.from(this.connectionCounts.values())
      .reduce((sum, count) => sum + count, 0);
    
    if (totalConnections >= this.config.maxTotalConnections) {
      return {
        allowed: false,
        reason: 'total_connection_limit',
        current: totalConnections,
        limit: this.config.maxTotalConnections
      };
    }
    
    return { allowed: true };
  }

  /**
   * Check for suspicious patterns
   */
  checkPatterns(path, headers) {
    // Check path patterns
    for (const pattern of this.config.suspiciousPatterns) {
      if (pattern.test(path)) {
        return {
          allowed: false,
          reason: 'suspicious_pattern',
          pattern: pattern.toString()
        };
      }
    }
    
    // Check header patterns
    const suspiciousHeaders = [
      'x-forwarded-for',
      'x-real-ip',
      'x-originating-ip'
    ];
    
    let forwardedCount = 0;
    for (const header of suspiciousHeaders) {
      if (headers[header]) {
        forwardedCount++;
      }
    }
    
    if (forwardedCount > 2) {
      return {
        allowed: false,
        reason: 'suspicious_headers',
        detail: 'too_many_forwarded_headers'
      };
    }
    
    // Check User-Agent
    const userAgent = headers['user-agent'] || '';
    if (!userAgent || userAgent.length < 10) {
      return {
        allowed: false,
        reason: 'suspicious_user_agent'
      };
    }
    
    return { allowed: true };
  }

  /**
   * Record violation
   */
  recordViolation(ip, type) {
    const violations = this.violations.get(ip) || {
      count: 0,
      types: {},
      firstViolation: Date.now(),
      lastViolation: Date.now()
    };
    
    violations.count++;
    violations.types[type] = (violations.types[type] || 0) + 1;
    violations.lastViolation = Date.now();
    
    this.violations.set(ip, violations);
    
    // Check if should blacklist
    if (violations.count >= this.config.blacklistThreshold) {
      this.blacklistIP(ip);
    }
    
    // Emit violation event
    this.emit('violation', {
      ip,
      type,
      count: violations.count,
      blacklisted: violations.count >= this.config.blacklistThreshold
    });
  }

  /**
   * Blacklist IP
   */
  blacklistIP(ip) {
    this.blacklist.set(ip, {
      timestamp: Date.now(),
      violations: this.violations.get(ip),
      expires: Date.now() + this.config.blacklistDuration
    });
    
    this.stats.blacklistedIPs++;
    
    this.logger.warn(`IP blacklisted: ${ip}`);
    this.emit('blacklisted', { ip });
  }

  /**
   * Check if IP is blacklisted
   */
  isBlacklisted(ip) {
    const entry = this.blacklist.get(ip);
    if (!entry) return false;
    
    if (Date.now() > entry.expires) {
      this.blacklist.delete(ip);
      this.violations.delete(ip);
      return false;
    }
    
    return true;
  }

  /**
   * Issue challenge
   */
  issueChallenge(ip) {
    const challenge = {
      id: randomBytes(16).toString('hex'),
      nonce: randomBytes(8).toString('hex'),
      difficulty: this.config.challengeDifficulty,
      issued: Date.now(),
      expires: Date.now() + this.config.challengeTimeout
    };
    
    this.challenges.set(challenge.id, {
      ...challenge,
      ip
    });
    
    this.stats.challengesIssued++;
    
    return {
      id: challenge.id,
      nonce: challenge.nonce,
      difficulty: challenge.difficulty,
      timeout: this.config.challengeTimeout
    };
  }

  /**
   * Verify challenge response
   */
  verifyChallenge(challengeId, solution) {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) {
      return { valid: false, reason: 'invalid_challenge' };
    }
    
    if (Date.now() > challenge.expires) {
      this.challenges.delete(challengeId);
      return { valid: false, reason: 'challenge_expired' };
    }
    
    // Verify proof of work
    const hash = createHash('sha256')
      .update(challenge.nonce + solution)
      .digest('hex');
    
    const leadingZeros = hash.match(/^0*/)[0].length;
    if (leadingZeros >= challenge.difficulty) {
      this.challenges.delete(challengeId);
      this.stats.challengesPassed++;
      
      // Clear violations for IP
      const ip = challenge.ip;
      this.violations.delete(ip);
      
      return { valid: true };
    }
    
    return { valid: false, reason: 'invalid_solution' };
  }

  /**
   * Check if IP requires challenge
   */
  requiresChallenge(ip) {
    const violations = this.violations.get(ip);
    if (!violations) return false;
    
    // Require challenge after 2 violations
    return violations.count >= 2 && violations.count < this.config.blacklistThreshold;
  }

  /**
   * Update connection count
   */
  updateConnectionCount(ip, delta) {
    const current = this.connectionCounts.get(ip) || 0;
    const newCount = Math.max(0, current + delta);
    
    if (newCount === 0) {
      this.connectionCounts.delete(ip);
    } else {
      this.connectionCounts.set(ip, newCount);
    }
  }

  /**
   * Record traffic for analysis
   */
  recordTraffic(ip, path) {
    this.trafficHistory.push({
      ip,
      path,
      timestamp: Date.now()
    });
    
    // Keep only recent traffic
    const cutoff = Date.now() - this.config.adaptiveWindow;
    this.trafficHistory = this.trafficHistory.filter(t => t.timestamp > cutoff);
  }

  /**
   * Analyze traffic patterns
   */
  analyzeTraffic() {
    if (this.trafficHistory.length < 100) return;
    
    // Analyze request distribution
    const ipCounts = new Map();
    const pathCounts = new Map();
    
    for (const traffic of this.trafficHistory) {
      ipCounts.set(traffic.ip, (ipCounts.get(traffic.ip) || 0) + 1);
      pathCounts.set(traffic.path, (pathCounts.get(traffic.path) || 0) + 1);
    }
    
    // Detect concentrated attacks
    const totalRequests = this.trafficHistory.length;
    const uniqueIPs = ipCounts.size;
    const avgRequestsPerIP = totalRequests / uniqueIPs;
    
    // Check for IPs with significantly more requests
    const suspiciousIPs = [];
    for (const [ip, count] of ipCounts) {
      if (count > avgRequestsPerIP * 5) {
        suspiciousIPs.push({ ip, count });
      }
    }
    
    if (suspiciousIPs.length > 0) {
      this.logger.warn(`Detected suspicious traffic from ${suspiciousIPs.length} IPs`);
      this.emit('attack_detected', {
        type: 'concentrated',
        ips: suspiciousIPs,
        avgRequestsPerIP
      });
      
      this.stats.detectedAttacks++;
    }
    
    // Detect distributed attacks
    if (uniqueIPs > 100 && avgRequestsPerIP < 5) {
      const recentIPs = new Set();
      const recentCutoff = Date.now() - 60000; // Last minute
      
      for (const traffic of this.trafficHistory) {
        if (traffic.timestamp > recentCutoff) {
          recentIPs.add(traffic.ip);
        }
      }
      
      if (recentIPs.size > 50) {
        this.logger.warn('Detected potential distributed attack');
        this.emit('attack_detected', {
          type: 'distributed',
          uniqueIPs: recentIPs.size,
          timeWindow: '1_minute'
        });
        
        this.stats.detectedAttacks++;
      }
    }
  }

  /**
   * Adjust adaptive thresholds
   */
  adjustAdaptiveThresholds() {
    if (!this.config.enableAdaptive) return;
    
    const totalRequests = this.trafficHistory.length;
    const timeWindow = this.config.adaptiveWindow / 1000; // seconds
    const avgRequestRate = totalRequests / timeWindow;
    
    // Calculate baseline
    const baseline = avgRequestRate * 1.5; // 50% above average
    
    // Adjust thresholds
    if (this.stats.blockedRequests / this.stats.totalRequests > 0.1) {
      // Too many blocks, might be too strict
      this.adaptiveThresholds.requestsPerWindow = Math.min(
        this.config.maxRequestsPerWindow * 2,
        Math.floor(this.adaptiveThresholds.requestsPerWindow * 1.1)
      );
    } else if (this.stats.detectedAttacks > 0) {
      // Attacks detected, be more strict
      this.adaptiveThresholds.requestsPerWindow = Math.max(
        10,
        Math.floor(this.adaptiveThresholds.requestsPerWindow * 0.8)
      );
    }
    
    this.stats.adaptiveAdjustments++;
    
    this.logger.debug('Adaptive thresholds adjusted:', this.adaptiveThresholds);
    this.emit('thresholds_adjusted', this.adaptiveThresholds);
  }

  /**
   * Cleanup expired data
   */
  cleanup() {
    const now = Date.now();
    
    // Clean expired blacklist entries
    for (const [ip, entry] of this.blacklist) {
      if (now > entry.expires) {
        this.blacklist.delete(ip);
        this.violations.delete(ip);
      }
    }
    
    // Clean expired challenges
    for (const [id, challenge] of this.challenges) {
      if (now > challenge.expires) {
        this.challenges.delete(id);
      }
    }
    
    // Clean old rate limit buckets
    for (const [ip, bucket] of this.rateLimitBuckets) {
      if (now - bucket.windowStart > this.config.windowSize * 2) {
        this.rateLimitBuckets.delete(ip);
      }
    }
  }

  /**
   * Get protection statistics
   */
  getStats() {
    return {
      ...this.stats,
      currentBlacklisted: this.blacklist.size,
      currentViolations: this.violations.size,
      activeChallenges: this.challenges.size,
      blockRate: this.stats.totalRequests > 0 
        ? (this.stats.blockedRequests / this.stats.totalRequests * 100).toFixed(2) + '%'
        : '0%',
      challengeSuccessRate: this.stats.challengesIssued > 0
        ? (this.stats.challengesPassed / this.stats.challengesIssued * 100).toFixed(2) + '%'
        : '0%',
      adaptiveThresholds: this.adaptiveThresholds
    };
  }

  /**
   * Stop DDoS protection
   */
  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    if (this.adaptiveTimer) {
      clearInterval(this.adaptiveTimer);
    }
    
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
    }
    
    this.logger.info('DDoS protection stopped');
  }
}

export default DDoSProtection;
