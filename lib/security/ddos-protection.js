/**
 * DDoS Protection System for Otedama
 * Multi-layered defense against distributed denial of service attacks
 * 
 * Design principles:
 * - Carmack: Ultra-fast packet inspection and filtering
 * - Martin: Layered defense architecture
 * - Pike: Simple but highly effective
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';

// Attack types
export const AttackType = {
  VOLUMETRIC: 'volumetric',          // High bandwidth consumption
  PROTOCOL: 'protocol',              // TCP SYN flood, etc.
  APPLICATION: 'application',        // HTTP flood, slowloris
  AMPLIFICATION: 'amplification',    // DNS, NTP amplification
  UNKNOWN: 'unknown'
};

// Defense strategies
export const DefenseStrategy = {
  RATE_LIMITING: 'rate_limiting',
  SYN_COOKIES: 'syn_cookies',
  BLACKHOLING: 'blackholing',
  CAPTCHA: 'captcha',
  PROOF_OF_WORK: 'proof_of_work',
  GEOBLOCKING: 'geoblocking',
  PATTERN_BLOCKING: 'pattern_blocking'
};

// Protection levels
export const ProtectionLevel = {
  OFF: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  UNDER_ATTACK: 4
};

/**
 * Traffic pattern analyzer
 */
class TrafficAnalyzer {
  constructor(windowSize = 60000) { // 1 minute window
    this.windowSize = windowSize;
    this.requests = [];
    this.patterns = new Map();
    this.anomalies = [];
  }

  addRequest(req) {
    const now = Date.now();
    const request = {
      timestamp: now,
      ip: req.ip,
      method: req.method,
      path: req.path,
      userAgent: req.headers['user-agent'],
      size: req.headers['content-length'] || 0,
      responseTime: req.responseTime || 0
    };
    
    this.requests.push(request);
    this.cleanup(now);
    
    return this.analyze(request);
  }

  analyze(request) {
    const patterns = {
      rapidFire: this.detectRapidFire(request),
      slowloris: this.detectSlowloris(request),
      httpFlood: this.detectHTTPFlood(request),
      botPattern: this.detectBotPattern(request),
      amplification: this.detectAmplification(request)
    };
    
    const anomalies = Object.entries(patterns)
      .filter(([_, detected]) => detected)
      .map(([type, _]) => type);
    
    if (anomalies.length > 0) {
      this.anomalies.push({
        timestamp: request.timestamp,
        ip: request.ip,
        anomalies
      });
    }
    
    return { patterns, anomalies };
  }

  detectRapidFire(request) {
    const recentRequests = this.requests.filter(r => 
      r.ip === request.ip && 
      r.timestamp > request.timestamp - 1000 // Last second
    );
    
    return recentRequests.length > 50; // More than 50 req/sec from single IP
  }

  detectSlowloris(request) {
    if (!request.responseTime) return false;
    
    const slowRequests = this.requests.filter(r =>
      r.ip === request.ip &&
      r.responseTime > 30000 && // Requests taking > 30 seconds
      r.timestamp > request.timestamp - 60000
    );
    
    return slowRequests.length > 5;
  }

  detectHTTPFlood(request) {
    const pathRequests = this.requests.filter(r =>
      r.path === request.path &&
      r.timestamp > request.timestamp - 10000 // Last 10 seconds
    );
    
    return pathRequests.length > 1000; // More than 100 req/sec to same path
  }

  detectBotPattern(request) {
    const userAgent = request.userAgent?.toLowerCase() || '';
    
    // Common bot patterns
    const botPatterns = [
      /bot|crawler|spider|scraper/i,
      /python|java|go-http|curl|wget/i,
      /^$/  // Empty user agent
    ];
    
    return botPatterns.some(pattern => pattern.test(userAgent));
  }

  detectAmplification(request) {
    // Check if response is much larger than request
    const requestSize = parseInt(request.size) || 0;
    const responseSize = request.responseSize || 0;
    
    return responseSize > requestSize * 10 && responseSize > 10000;
  }

  cleanup(now) {
    const cutoff = now - this.windowSize;
    this.requests = this.requests.filter(r => r.timestamp > cutoff);
    
    // Clean old anomalies
    this.anomalies = this.anomalies.filter(a => a.timestamp > cutoff);
  }

  getStats() {
    const now = Date.now();
    const cutoff = now - this.windowSize;
    const recentRequests = this.requests.filter(r => r.timestamp > cutoff);
    
    const ipCounts = new Map();
    const pathCounts = new Map();
    
    for (const req of recentRequests) {
      ipCounts.set(req.ip, (ipCounts.get(req.ip) || 0) + 1);
      pathCounts.set(req.path, (pathCounts.get(req.path) || 0) + 1);
    }
    
    return {
      totalRequests: recentRequests.length,
      uniqueIPs: ipCounts.size,
      requestsPerSecond: recentRequests.length / (this.windowSize / 1000),
      topIPs: Array.from(ipCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10),
      topPaths: Array.from(pathCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10),
      anomalies: this.anomalies.length
    };
  }
}

/**
 * Challenge system for bot detection
 */
class ChallengeSystem {
  constructor(options = {}) {
    this.challenges = new Map();
    this.solved = new Map();
    this.difficulty = options.difficulty || 4;
    this.expiry = options.expiry || 300000; // 5 minutes
  }

  generateChallenge(identifier) {
    const challenge = {
      id: createHash('sha256').update(`${identifier}:${Date.now()}`).digest('hex'),
      type: 'proof_of_work',
      difficulty: this.difficulty,
      prefix: randomBytes(8).toString('hex'),
      timestamp: Date.now(),
      attempts: 0
    };
    
    this.challenges.set(challenge.id, challenge);
    
    return {
      id: challenge.id,
      type: challenge.type,
      difficulty: challenge.difficulty,
      prefix: challenge.prefix
    };
  }

  verifyChallenge(id, solution) {
    const challenge = this.challenges.get(id);
    
    if (!challenge) {
      return { valid: false, reason: 'Challenge not found' };
    }
    
    if (Date.now() - challenge.timestamp > this.expiry) {
      this.challenges.delete(id);
      return { valid: false, reason: 'Challenge expired' };
    }
    
    challenge.attempts++;
    
    if (challenge.attempts > 10) {
      this.challenges.delete(id);
      return { valid: false, reason: 'Too many attempts' };
    }
    
    // Verify proof of work
    const hash = createHash('sha256')
      .update(challenge.prefix + solution)
      .digest('hex');
    
    const leadingZeros = hash.match(/^0*/)[0].length;
    
    if (leadingZeros >= challenge.difficulty) {
      this.challenges.delete(id);
      this.solved.set(id, {
        timestamp: Date.now(),
        solution
      });
      
      return { valid: true };
    }
    
    return { valid: false, reason: 'Invalid solution' };
  }

  isSolved(identifier) {
    // Check if challenge was recently solved
    const cutoff = Date.now() - this.expiry;
    
    for (const [id, solved] of this.solved) {
      if (solved.timestamp < cutoff) {
        this.solved.delete(id);
      }
    }
    
    // Simple check - in production, tie to specific identifier
    return this.solved.size > 0;
  }

  cleanup() {
    const cutoff = Date.now() - this.expiry;
    
    for (const [id, challenge] of this.challenges) {
      if (challenge.timestamp < cutoff) {
        this.challenges.delete(id);
      }
    }
    
    for (const [id, solved] of this.solved) {
      if (solved.timestamp < cutoff) {
        this.solved.delete(id);
      }
    }
  }
}

/**
 * Main DDoS Protection System
 */
export class DDoSProtection extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Protection settings
      defaultLevel: options.defaultLevel || ProtectionLevel.MEDIUM,
      autoEscalate: options.autoEscalate !== false,
      
      // Thresholds
      thresholds: {
        requestsPerSecond: {
          low: 100,
          medium: 50,
          high: 20,
          underAttack: 10
        },
        requestsPerIP: {
          low: 20,
          medium: 10,
          high: 5,
          underAttack: 2
        },
        ...options.thresholds
      },
      
      // Time windows
      windows: {
        rateLimit: options.windows?.rateLimit || 1000,    // 1 second
        analysis: options.windows?.analysis || 60000,      // 1 minute
        escalation: options.windows?.escalation || 300000  // 5 minutes
      },
      
      // Defense strategies
      strategies: {
        [ProtectionLevel.LOW]: [DefenseStrategy.RATE_LIMITING],
        [ProtectionLevel.MEDIUM]: [DefenseStrategy.RATE_LIMITING, DefenseStrategy.PATTERN_BLOCKING],
        [ProtectionLevel.HIGH]: [DefenseStrategy.RATE_LIMITING, DefenseStrategy.PATTERN_BLOCKING, DefenseStrategy.CAPTCHA],
        [ProtectionLevel.UNDER_ATTACK]: [DefenseStrategy.RATE_LIMITING, DefenseStrategy.PATTERN_BLOCKING, DefenseStrategy.PROOF_OF_WORK, DefenseStrategy.BLACKHOLING],
        ...options.strategies
      },
      
      // Integration
      ipListManager: options.ipListManager,
      rateLimiter: options.rateLimiter
    };
    
    // Current protection level
    this.currentLevel = this.config.defaultLevel;
    
    // Components
    this.analyzer = new TrafficAnalyzer(this.config.windows.analysis);
    this.challengeSystem = new ChallengeSystem();
    
    // Request tracking
    this.requestCounts = new Map();
    this.blockedRequests = new Map();
    
    // Statistics
    this.stats = {
      totalRequests: 0,
      blockedRequests: 0,
      challenges: {
        issued: 0,
        solved: 0,
        failed: 0
      },
      attacks: {
        detected: 0,
        mitigated: 0,
        ongoing: 0
      },
      levelChanges: []
    };
    
    // Attack detection state
    this.attackState = {
      underAttack: false,
      startTime: null,
      type: null,
      sources: new Set()
    };
    
    // Start monitoring
    this.monitoringInterval = setInterval(() => this.monitor(), 5000);
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Process incoming request
   */
  async processRequest(req) {
    this.stats.totalRequests++;
    
    const ip = this.extractIP(req);
    const now = Date.now();
    
    // Add to analyzer
    const analysis = this.analyzer.addRequest({
      ...req,
      ip,
      timestamp: now
    });
    
    // Check current protection level
    const protection = await this.checkProtection(req, ip, analysis);
    
    if (!protection.allowed) {
      this.stats.blockedRequests++;
      this.recordBlockedRequest(ip, protection.reason);
      
      this.emit('request:blocked', {
        ip,
        reason: protection.reason,
        strategy: protection.strategy
      });
    }
    
    return protection;
  }

  /**
   * Check protection rules
   */
  async checkProtection(req, ip, analysis) {
    const strategies = this.config.strategies[this.currentLevel] || [];
    
    for (const strategy of strategies) {
      const result = await this.applyStrategy(strategy, req, ip, analysis);
      
      if (!result.allowed) {
        return {
          allowed: false,
          reason: result.reason,
          strategy,
          challenge: result.challenge
        };
      }
    }
    
    return { allowed: true };
  }

  /**
   * Apply defense strategy
   */
  async applyStrategy(strategy, req, ip, analysis) {
    switch (strategy) {
      case DefenseStrategy.RATE_LIMITING:
        return this.applyRateLimiting(ip);
        
      case DefenseStrategy.PATTERN_BLOCKING:
        return this.applyPatternBlocking(analysis);
        
      case DefenseStrategy.CAPTCHA:
        return this.applyCaptchaChallenge(req, ip);
        
      case DefenseStrategy.PROOF_OF_WORK:
        return this.applyProofOfWork(req, ip);
        
      case DefenseStrategy.BLACKHOLING:
        return this.applyBlackholing(ip);
        
      case DefenseStrategy.GEOBLOCKING:
        return this.applyGeoBlocking(ip);
        
      default:
        return { allowed: true };
    }
  }

  /**
   * Apply rate limiting
   */
  applyRateLimiting(ip) {
    const window = this.config.windows.rateLimit;
    const now = Date.now();
    const cutoff = now - window;
    
    // Get request count for IP
    let count = this.requestCounts.get(ip) || [];
    count = count.filter(t => t > cutoff);
    count.push(now);
    this.requestCounts.set(ip, count);
    
    // Get threshold for current level
    const levelName = Object.keys(ProtectionLevel).find(
      key => ProtectionLevel[key] === this.currentLevel
    )?.toLowerCase() || 'medium';
    
    const threshold = this.config.thresholds.requestsPerIP[levelName];
    
    if (count.length > threshold) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${count.length} requests in ${window}ms`
      };
    }
    
    return { allowed: true };
  }

  /**
   * Apply pattern blocking
   */
  applyPatternBlocking(analysis) {
    if (analysis.anomalies.length > 0) {
      // Block specific patterns based on level
      const blockPatterns = {
        [ProtectionLevel.MEDIUM]: ['rapidFire', 'httpFlood'],
        [ProtectionLevel.HIGH]: ['rapidFire', 'httpFlood', 'slowloris', 'botPattern'],
        [ProtectionLevel.UNDER_ATTACK]: ['rapidFire', 'httpFlood', 'slowloris', 'botPattern', 'amplification']
      };
      
      const patternsToBlock = blockPatterns[this.currentLevel] || [];
      const detectedPatterns = analysis.anomalies.filter(a => patternsToBlock.includes(a));
      
      if (detectedPatterns.length > 0) {
        return {
          allowed: false,
          reason: `Suspicious pattern detected: ${detectedPatterns.join(', ')}`
        };
      }
    }
    
    return { allowed: true };
  }

  /**
   * Apply CAPTCHA challenge
   */
  async applyCaptchaChallenge(req, ip) {
    // Check if already solved
    if (this.challengeSystem.isSolved(ip)) {
      return { allowed: true };
    }
    
    // Check if solving attempt
    if (req.method === 'POST' && req.path === '/api/challenge/solve') {
      return { allowed: true }; // Allow solving attempt
    }
    
    // Issue challenge
    const challenge = this.challengeSystem.generateChallenge(ip);
    this.stats.challenges.issued++;
    
    return {
      allowed: false,
      reason: 'CAPTCHA verification required',
      challenge: {
        type: 'captcha',
        ...challenge
      }
    };
  }

  /**
   * Apply proof of work
   */
  async applyProofOfWork(req, ip) {
    // Check if already solved
    if (this.challengeSystem.isSolved(ip)) {
      return { allowed: true };
    }
    
    // Check if solving attempt
    if (req.headers['x-pow-solution']) {
      const challengeId = req.headers['x-pow-challenge'];
      const solution = req.headers['x-pow-solution'];
      
      const result = this.challengeSystem.verifyChallenge(challengeId, solution);
      
      if (result.valid) {
        this.stats.challenges.solved++;
        return { allowed: true };
      } else {
        this.stats.challenges.failed++;
        return {
          allowed: false,
          reason: `Proof of work failed: ${result.reason}`
        };
      }
    }
    
    // Issue challenge
    const challenge = this.challengeSystem.generateChallenge(ip);
    this.stats.challenges.issued++;
    
    return {
      allowed: false,
      reason: 'Proof of work required',
      challenge: {
        type: 'proof_of_work',
        ...challenge
      }
    };
  }

  /**
   * Apply blackholing (drop all traffic)
   */
  applyBlackholing(ip) {
    // In UNDER_ATTACK mode, blackhole IPs with extreme behavior
    const requests = this.requestCounts.get(ip) || [];
    
    if (requests.length > 100) { // More than 100 requests in rate limit window
      // Add to blacklist if IP list manager available
      if (this.config.ipListManager) {
        this.config.ipListManager.addIP(ip, 'blacklist', {
          source: 'ddos_protection',
          reason: 'DDoS attack source',
          duration: 3600000 // 1 hour
        });
      }
      
      return {
        allowed: false,
        reason: 'Traffic blackholed due to attack behavior'
      };
    }
    
    return { allowed: true };
  }

  /**
   * Apply geo-blocking
   */
  async applyGeoBlocking(ip) {
    // This would integrate with GeoIP service
    // For now, return allowed
    return { allowed: true };
  }

  /**
   * Monitor traffic and adjust protection level
   */
  monitor() {
    const stats = this.analyzer.getStats();
    
    // Check if under attack
    const indicators = {
      highRPS: stats.requestsPerSecond > 1000,
      manyAnomalies: stats.anomalies > 100,
      fewUniqueIPs: stats.uniqueIPs < stats.totalRequests / 100,
      concentrated: stats.topIPs[0]?.[1] > stats.totalRequests * 0.1
    };
    
    const attackScore = Object.values(indicators).filter(Boolean).length;
    
    if (attackScore >= 2 && !this.attackState.underAttack) {
      // Attack detected
      this.detectAttack(stats, indicators);
    } else if (attackScore === 0 && this.attackState.underAttack) {
      // Attack ended
      this.endAttack();
    }
    
    // Auto-escalate protection level
    if (this.config.autoEscalate) {
      this.adjustProtectionLevel(stats, attackScore);
    }
    
    // Emit monitoring event
    this.emit('monitor', {
      stats,
      level: this.currentLevel,
      underAttack: this.attackState.underAttack
    });
  }

  /**
   * Detect attack
   */
  detectAttack(stats, indicators) {
    this.attackState = {
      underAttack: true,
      startTime: Date.now(),
      type: this.determineAttackType(stats, indicators),
      sources: new Set(stats.topIPs.slice(0, 10).map(([ip]) => ip))
    };
    
    this.stats.attacks.detected++;
    this.stats.attacks.ongoing++;
    
    this.emit('attack:detected', {
      type: this.attackState.type,
      stats,
      indicators
    });
    
    // Escalate to highest protection
    if (this.currentLevel < ProtectionLevel.UNDER_ATTACK) {
      this.setProtectionLevel(ProtectionLevel.UNDER_ATTACK);
    }
  }

  /**
   * End attack
   */
  endAttack() {
    const duration = Date.now() - this.attackState.startTime;
    
    this.stats.attacks.mitigated++;
    this.stats.attacks.ongoing--;
    
    this.emit('attack:mitigated', {
      type: this.attackState.type,
      duration,
      sources: Array.from(this.attackState.sources)
    });
    
    this.attackState = {
      underAttack: false,
      startTime: null,
      type: null,
      sources: new Set()
    };
    
    // Lower protection level
    if (this.currentLevel === ProtectionLevel.UNDER_ATTACK) {
      this.setProtectionLevel(ProtectionLevel.HIGH);
    }
  }

  /**
   * Determine attack type
   */
  determineAttackType(stats, indicators) {
    if (indicators.highRPS && indicators.fewUniqueIPs) {
      return AttackType.VOLUMETRIC;
    }
    
    if (stats.anomalies > 100) {
      const patterns = this.analyzer.anomalies.flatMap(a => a.anomalies);
      
      if (patterns.includes('slowloris')) {
        return AttackType.APPLICATION;
      }
      
      if (patterns.includes('amplification')) {
        return AttackType.AMPLIFICATION;
      }
    }
    
    return AttackType.UNKNOWN;
  }

  /**
   * Adjust protection level based on traffic
   */
  adjustProtectionLevel(stats, attackScore) {
    let targetLevel = this.currentLevel;
    
    if (attackScore >= 3) {
      targetLevel = ProtectionLevel.UNDER_ATTACK;
    } else if (attackScore >= 2) {
      targetLevel = ProtectionLevel.HIGH;
    } else if (stats.requestsPerSecond > 500) {
      targetLevel = ProtectionLevel.MEDIUM;
    } else if (stats.requestsPerSecond > 100) {
      targetLevel = ProtectionLevel.LOW;
    } else {
      targetLevel = this.config.defaultLevel;
    }
    
    if (targetLevel !== this.currentLevel) {
      this.setProtectionLevel(targetLevel);
    }
  }

  /**
   * Set protection level
   */
  setProtectionLevel(level) {
    const oldLevel = this.currentLevel;
    this.currentLevel = level;
    
    this.stats.levelChanges.push({
      from: oldLevel,
      to: level,
      timestamp: Date.now()
    });
    
    this.emit('level:changed', {
      from: oldLevel,
      to: level,
      strategies: this.config.strategies[level]
    });
  }

  /**
   * Record blocked request
   */
  recordBlockedRequest(ip, reason) {
    const record = this.blockedRequests.get(ip) || {
      count: 0,
      reasons: new Map()
    };
    
    record.count++;
    record.reasons.set(reason, (record.reasons.get(reason) || 0) + 1);
    record.lastBlocked = Date.now();
    
    this.blockedRequests.set(ip, record);
    
    // Report to IP list manager if available
    if (this.config.ipListManager && record.count > 100) {
      this.config.ipListManager.recordViolation(ip, 'ddos', record.count / 100);
    }
  }

  /**
   * Get current status
   */
  getStatus() {
    const levelName = Object.keys(ProtectionLevel).find(
      key => ProtectionLevel[key] === this.currentLevel
    );
    
    return {
      level: this.currentLevel,
      levelName,
      underAttack: this.attackState.underAttack,
      attack: this.attackState.underAttack ? {
        type: this.attackState.type,
        duration: Date.now() - this.attackState.startTime,
        sources: this.attackState.sources.size
      } : null,
      strategies: this.config.strategies[this.currentLevel],
      stats: {
        ...this.stats,
        ...this.analyzer.getStats()
      },
      thresholds: this.config.thresholds
    };
  }

  /**
   * Middleware for Express/Connect
   */
  middleware() {
    return async (req, res, next) => {
      const protection = await this.processRequest(req);
      
      if (!protection.allowed) {
        res.statusCode = protection.challenge ? 403 : 429;
        res.setHeader('X-DDoS-Protection', 'active');
        
        if (protection.challenge) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            error: 'Challenge Required',
            message: protection.reason,
            challenge: protection.challenge
          }));
        } else {
          res.end(protection.reason);
        }
        
        return;
      }
      
      // Add protection headers
      res.setHeader('X-DDoS-Protection-Level', this.currentLevel);
      
      next();
    };
  }

  /**
   * Extract IP from request
   */
  extractIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0] ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           req.ip;
  }

  /**
   * Clean up old data
   */
  cleanup() {
    const cutoff = Date.now() - 300000; // 5 minutes
    
    // Clean request counts
    for (const [ip, timestamps] of this.requestCounts) {
      const filtered = timestamps.filter(t => t > cutoff);
      if (filtered.length === 0) {
        this.requestCounts.delete(ip);
      } else {
        this.requestCounts.set(ip, filtered);
      }
    }
    
    // Clean blocked requests
    for (const [ip, record] of this.blockedRequests) {
      if (record.lastBlocked < cutoff) {
        this.blockedRequests.delete(ip);
      }
    }
    
    // Clean challenge system
    this.challengeSystem.cleanup();
  }

  /**
   * Shutdown
   */
  shutdown() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.emit('shutdown');
  }
}

// Factory function
export function createDDoSProtection(options) {
  return new DDoSProtection(options);
}

// Default export
export default DDoSProtection;
