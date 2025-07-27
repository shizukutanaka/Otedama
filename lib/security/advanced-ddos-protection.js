/**
 * Advanced DDoS Protection System - Otedama
 * Multi-layered defense against distributed denial of service attacks
 * 
 * Design principles:
 * - Defense in depth
 * - Adaptive rate limiting
 * - Behavioral analysis
 * - Distributed mitigation
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';
import { memoryManager } from '../core/memory-manager.js';

const logger = createStructuredLogger('AdvancedDDoSProtection');

/**
 * Attack types
 */
export const AttackType = {
  VOLUMETRIC: 'volumetric',
  PROTOCOL: 'protocol',
  APPLICATION: 'application',
  AMPLIFICATION: 'amplification',
  SLOWLORIS: 'slowloris',
  SYN_FLOOD: 'syn_flood',
  UDP_FLOOD: 'udp_flood',
  HTTP_FLOOD: 'http_flood',
  DNS_AMPLIFICATION: 'dns_amplification'
};

/**
 * Mitigation strategies
 */
export const MitigationStrategy = {
  RATE_LIMIT: 'rate_limit',
  BLACKHOLE: 'blackhole',
  CHALLENGE: 'challenge',
  TARPIT: 'tarpit',
  REDIRECT: 'redirect',
  ADAPTIVE: 'adaptive'
};

/**
 * Advanced DDoS Protection System
 */
export class AdvancedDDoSProtection extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Rate limiting
      windowSize: config.windowSize || 60000, // 1 minute
      maxRequestsPerWindow: config.maxRequestsPerWindow || 100,
      burstLimit: config.burstLimit || 20,
      
      // Adaptive thresholds
      baselineMultiplier: config.baselineMultiplier || 3,
      anomalyThreshold: config.anomalyThreshold || 0.8,
      
      // Challenge system
      challengeExpiry: config.challengeExpiry || 300000, // 5 minutes
      maxChallengeRetries: config.maxChallengeRetries || 3,
      
      // Blacklist/whitelist
      blacklistDuration: config.blacklistDuration || 3600000, // 1 hour
      whitelistTTL: config.whitelistTTL || 86400000, // 24 hours
      
      // Performance
      cleanupInterval: config.cleanupInterval || 60000, // 1 minute
      maxTrackedIPs: config.maxTrackedIPs || 100000,
      
      ...config
    };
    
    // Traffic tracking
    this.trafficStats = new Map();
    this.connectionStats = new Map();
    this.requestPatterns = new Map();
    
    // Protection mechanisms
    this.rateLimiter = new AdaptiveRateLimiter(this.config);
    this.challengeSystem = new ChallengeSystem(this.config);
    this.blacklist = new TimedBlacklist(this.config);
    this.whitelist = new Map();
    
    // Attack detection
    this.attackDetector = new AttackDetector(this.config);
    this.mitigationEngine = new MitigationEngine(this.config);
    
    // Initialize
    this.initialize();
  }
  
  initialize() {
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
    
    // Start baseline calculation
    this.calculateBaseline();
    
    logger.info('Advanced DDoS protection initialized', {
      windowSize: this.config.windowSize,
      maxRequests: this.config.maxRequestsPerWindow
    });
  }
  
  /**
   * Process incoming request
   */
  async processRequest(request) {
    const ip = this.extractIP(request);
    const fingerprint = this.generateFingerprint(request);
    const timestamp = Date.now();
    
    // Check whitelist
    if (this.isWhitelisted(ip)) {
      return { allowed: true, reason: 'whitelisted' };
    }
    
    // Check blacklist
    if (this.blacklist.isBlacklisted(ip)) {
      this.emit('request:blocked', { ip, reason: 'blacklisted' });
      return { allowed: false, reason: 'blacklisted' };
    }
    
    // Update traffic stats
    this.updateTrafficStats(ip, request, timestamp);
    
    // Detect attacks
    const attacks = await this.attackDetector.detect({
      ip,
      request,
      stats: this.trafficStats.get(ip),
      patterns: this.requestPatterns.get(ip)
    });
    
    if (attacks.length > 0) {
      // Apply mitigation
      const mitigation = await this.mitigationEngine.mitigate({
        ip,
        attacks,
        request,
        fingerprint
      });
      
      if (mitigation.action === 'block') {
        this.blacklist.add(ip, mitigation.duration);
        this.emit('attack:mitigated', {
          ip,
          attacks,
          mitigation
        });
        return { allowed: false, reason: 'attack_detected', mitigation };
      }
      
      if (mitigation.action === 'challenge') {
        const challenge = this.challengeSystem.create(ip, fingerprint);
        return {
          allowed: false,
          reason: 'challenge_required',
          challenge
        };
      }
      
      if (mitigation.action === 'rateLimit') {
        const limited = await this.rateLimiter.limit(ip, mitigation.limit);
        if (limited) {
          return { allowed: false, reason: 'rate_limited' };
        }
      }
    }
    
    // Standard rate limiting
    const rateLimited = await this.rateLimiter.check(ip);
    if (rateLimited) {
      this.emit('request:rate_limited', { ip });
      return { allowed: false, reason: 'rate_limited' };
    }
    
    // Pattern analysis
    const suspicious = this.analyzePattern(ip, request);
    if (suspicious.score > this.config.anomalyThreshold) {
      const challenge = this.challengeSystem.create(ip, fingerprint);
      return {
        allowed: false,
        reason: 'suspicious_pattern',
        challenge
      };
    }
    
    return { allowed: true };
  }
  
  /**
   * Verify challenge response
   */
  async verifyChallenge(ip, response) {
    const verified = await this.challengeSystem.verify(ip, response);
    
    if (verified) {
      // Add to whitelist temporarily
      this.whitelist.set(ip, {
        added: Date.now(),
        expires: Date.now() + this.config.whitelistTTL
      });
      
      this.emit('challenge:passed', { ip });
      return true;
    }
    
    // Increment failure count
    const failures = this.challengeSystem.incrementFailure(ip);
    if (failures >= this.config.maxChallengeRetries) {
      this.blacklist.add(ip, this.config.blacklistDuration * 2);
      this.emit('challenge:failed', { ip, failures });
    }
    
    return false;
  }
  
  /**
   * Update traffic statistics
   */
  updateTrafficStats(ip, request, timestamp) {
    let stats = this.trafficStats.get(ip);
    
    if (!stats) {
      stats = {
        firstSeen: timestamp,
        lastSeen: timestamp,
        requests: [],
        totalRequests: 0,
        bytesReceived: 0,
        uniqueUserAgents: new Set(),
        uniquePaths: new Set(),
        methods: new Map()
      };
      this.trafficStats.set(ip, stats);
    }
    
    // Update stats
    stats.lastSeen = timestamp;
    stats.totalRequests++;
    stats.requests.push({
      timestamp,
      method: request.method,
      path: request.url,
      size: request.headers['content-length'] || 0
    });
    
    // Keep only recent requests
    const cutoff = timestamp - this.config.windowSize * 5;
    stats.requests = stats.requests.filter(r => r.timestamp > cutoff);
    
    // Update unique trackers
    if (request.headers['user-agent']) {
      stats.uniqueUserAgents.add(request.headers['user-agent']);
    }
    stats.uniquePaths.add(request.url);
    
    // Method distribution
    const method = request.method || 'GET';
    stats.methods.set(method, (stats.methods.get(method) || 0) + 1);
    
    // Update patterns
    this.updateRequestPatterns(ip, request, timestamp);
  }
  
  /**
   * Update request patterns
   */
  updateRequestPatterns(ip, request, timestamp) {
    let patterns = this.requestPatterns.get(ip);
    
    if (!patterns) {
      patterns = {
        intervals: [],
        sizes: [],
        entropy: [],
        burstiness: 0
      };
      this.requestPatterns.set(ip, patterns);
    }
    
    // Request intervals
    if (patterns.lastRequest) {
      const interval = timestamp - patterns.lastRequest;
      patterns.intervals.push(interval);
      
      // Keep last 100 intervals
      if (patterns.intervals.length > 100) {
        patterns.intervals.shift();
      }
    }
    patterns.lastRequest = timestamp;
    
    // Request sizes
    const size = parseInt(request.headers['content-length'] || 0);
    patterns.sizes.push(size);
    if (patterns.sizes.length > 100) {
      patterns.sizes.shift();
    }
    
    // Path entropy
    const pathEntropy = this.calculateEntropy(request.url);
    patterns.entropy.push(pathEntropy);
    if (patterns.entropy.length > 100) {
      patterns.entropy.shift();
    }
    
    // Calculate burstiness
    patterns.burstiness = this.calculateBurstiness(patterns.intervals);
  }
  
  /**
   * Analyze request pattern
   */
  analyzePattern(ip, request) {
    const patterns = this.requestPatterns.get(ip);
    if (!patterns || patterns.intervals.length < 10) {
      return { score: 0, factors: [] };
    }
    
    const factors = [];
    let score = 0;
    
    // High burstiness
    if (patterns.burstiness > 0.8) {
      score += 0.3;
      factors.push('high_burstiness');
    }
    
    // Low interval variance (bot-like)
    const intervalVariance = this.calculateVariance(patterns.intervals);
    if (intervalVariance < 100) {
      score += 0.3;
      factors.push('low_interval_variance');
    }
    
    // Unusual request sizes
    const avgSize = patterns.sizes.reduce((a, b) => a + b, 0) / patterns.sizes.length;
    if (avgSize > 1000000 || avgSize < 10) {
      score += 0.2;
      factors.push('unusual_request_size');
    }
    
    // High path entropy
    const avgEntropy = patterns.entropy.reduce((a, b) => a + b, 0) / patterns.entropy.length;
    if (avgEntropy > 4) {
      score += 0.2;
      factors.push('high_path_entropy');
    }
    
    return { score: Math.min(1, score), factors };
  }
  
  /**
   * Calculate baseline traffic
   */
  calculateBaseline() {
    const now = Date.now();
    const baseline = {
      requestsPerMinute: 0,
      uniqueIPs: 0,
      avgRequestSize: 0,
      timestamp: now
    };
    
    // Calculate from current traffic
    let totalRequests = 0;
    let totalSize = 0;
    
    for (const [ip, stats] of this.trafficStats) {
      const recentRequests = stats.requests.filter(
        r => r.timestamp > now - 60000
      );
      totalRequests += recentRequests.length;
      totalSize += recentRequests.reduce((sum, r) => sum + r.size, 0);
    }
    
    baseline.requestsPerMinute = totalRequests;
    baseline.uniqueIPs = this.trafficStats.size;
    baseline.avgRequestSize = totalRequests > 0 ? totalSize / totalRequests : 0;
    
    this.baseline = baseline;
    
    // Schedule next calculation
    setTimeout(() => this.calculateBaseline(), 300000); // 5 minutes
  }
  
  /**
   * Extract IP from request
   */
  extractIP(request) {
    return request.headers['x-forwarded-for']?.split(',')[0].trim() ||
           request.headers['x-real-ip'] ||
           request.connection?.remoteAddress ||
           request.ip;
  }
  
  /**
   * Generate request fingerprint
   */
  generateFingerprint(request) {
    const components = [
      request.headers['user-agent'] || '',
      request.headers['accept'] || '',
      request.headers['accept-language'] || '',
      request.headers['accept-encoding'] || ''
    ];
    
    return createHash('sha256')
      .update(components.join('|'))
      .digest('hex')
      .substring(0, 16);
  }
  
  /**
   * Check if IP is whitelisted
   */
  isWhitelisted(ip) {
    const entry = this.whitelist.get(ip);
    if (!entry) return false;
    
    if (Date.now() > entry.expires) {
      this.whitelist.delete(ip);
      return false;
    }
    
    return true;
  }
  
  /**
   * Calculate entropy
   */
  calculateEntropy(str) {
    const freq = {};
    for (const char of str) {
      freq[char] = (freq[char] || 0) + 1;
    }
    
    let entropy = 0;
    const len = str.length;
    
    for (const count of Object.values(freq)) {
      const p = count / len;
      entropy -= p * Math.log2(p);
    }
    
    return entropy;
  }
  
  /**
   * Calculate variance
   */
  calculateVariance(values) {
    if (values.length < 2) return 0;
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  }
  
  /**
   * Calculate burstiness
   */
  calculateBurstiness(intervals) {
    if (intervals.length < 3) return 0;
    
    // Count rapid sequences
    let bursts = 0;
    for (let i = 1; i < intervals.length; i++) {
      if (intervals[i] < 100) bursts++; // Less than 100ms
    }
    
    return bursts / intervals.length;
  }
  
  /**
   * Cleanup old data
   */
  cleanup() {
    const now = Date.now();
    const maxAge = this.config.windowSize * 10;
    
    // Clean traffic stats
    for (const [ip, stats] of this.trafficStats) {
      if (now - stats.lastSeen > maxAge) {
        this.trafficStats.delete(ip);
        this.requestPatterns.delete(ip);
      }
    }
    
    // Clean whitelist
    for (const [ip, entry] of this.whitelist) {
      if (now > entry.expires) {
        this.whitelist.delete(ip);
      }
    }
    
    // Trim if too many IPs
    if (this.trafficStats.size > this.config.maxTrackedIPs) {
      const sorted = Array.from(this.trafficStats.entries())
        .sort((a, b) => b[1].lastSeen - a[1].lastSeen);
      
      const toKeep = sorted.slice(0, this.config.maxTrackedIPs * 0.8);
      this.trafficStats = new Map(toKeep);
    }
    
    logger.debug('Cleanup completed', {
      trackedIPs: this.trafficStats.size,
      blacklisted: this.blacklist.size
    });
  }
  
  /**
   * Get protection statistics
   */
  getStats() {
    const now = Date.now();
    const stats = {
      trackedIPs: this.trafficStats.size,
      blacklistedIPs: this.blacklist.size,
      whitelistedIPs: this.whitelist.size,
      activeChallenges: this.challengeSystem.getActiveCount(),
      baseline: this.baseline,
      recentRequests: 0,
      blockedRequests: 0
    };
    
    // Count recent requests
    for (const [ip, trafficStats] of this.trafficStats) {
      const recent = trafficStats.requests.filter(
        r => r.timestamp > now - 60000
      );
      stats.recentRequests += recent.length;
    }
    
    return stats;
  }
  
  /**
   * Shutdown protection
   */
  shutdown() {
    clearInterval(this.cleanupInterval);
    this.rateLimiter.shutdown();
    this.challengeSystem.shutdown();
    logger.info('Advanced DDoS protection shutdown');
  }
}

/**
 * Adaptive Rate Limiter
 */
class AdaptiveRateLimiter {
  constructor(config) {
    this.config = config;
    this.buckets = new Map();
  }
  
  async check(ip) {
    const now = Date.now();
    let bucket = this.buckets.get(ip);
    
    if (!bucket) {
      bucket = {
        tokens: this.config.burstLimit,
        lastRefill: now,
        requests: []
      };
      this.buckets.set(ip, bucket);
    }
    
    // Refill tokens
    const elapsed = now - bucket.lastRefill;
    const refillRate = this.config.maxRequestsPerWindow / this.config.windowSize;
    const newTokens = Math.floor(elapsed * refillRate);
    
    bucket.tokens = Math.min(
      this.config.burstLimit,
      bucket.tokens + newTokens
    );
    bucket.lastRefill = now;
    
    // Check if request allowed
    if (bucket.tokens < 1) {
      return true; // Rate limited
    }
    
    bucket.tokens--;
    bucket.requests.push(now);
    
    // Clean old requests
    bucket.requests = bucket.requests.filter(
      t => t > now - this.config.windowSize
    );
    
    return false;
  }
  
  async limit(ip, customLimit) {
    // Apply custom limit
    const bucket = this.buckets.get(ip);
    if (bucket) {
      bucket.tokens = Math.min(bucket.tokens, customLimit);
    }
    return this.check(ip);
  }
  
  shutdown() {
    this.buckets.clear();
  }
}

/**
 * Challenge System
 */
class ChallengeSystem {
  constructor(config) {
    this.config = config;
    this.challenges = new Map();
    this.failures = new Map();
  }
  
  create(ip, fingerprint) {
    const challenge = {
      id: randomBytes(16).toString('hex'),
      type: 'proof_of_work',
      difficulty: this.calculateDifficulty(ip),
      nonce: randomBytes(32).toString('hex'),
      created: Date.now(),
      expires: Date.now() + this.config.challengeExpiry,
      fingerprint
    };
    
    this.challenges.set(ip, challenge);
    
    return {
      id: challenge.id,
      type: challenge.type,
      difficulty: challenge.difficulty,
      nonce: challenge.nonce
    };
  }
  
  async verify(ip, response) {
    const challenge = this.challenges.get(ip);
    if (!challenge) return false;
    
    // Check expiry
    if (Date.now() > challenge.expires) {
      this.challenges.delete(ip);
      return false;
    }
    
    // Verify proof of work
    const hash = createHash('sha256')
      .update(challenge.nonce + response.solution)
      .digest('hex');
    
    const difficulty = challenge.difficulty;
    const target = '0'.repeat(difficulty);
    
    if (hash.startsWith(target)) {
      this.challenges.delete(ip);
      this.failures.delete(ip);
      return true;
    }
    
    return false;
  }
  
  calculateDifficulty(ip) {
    const failures = this.failures.get(ip) || 0;
    return Math.min(4 + failures, 8); // 4-8 leading zeros
  }
  
  incrementFailure(ip) {
    const count = (this.failures.get(ip) || 0) + 1;
    this.failures.set(ip, count);
    return count;
  }
  
  getActiveCount() {
    const now = Date.now();
    let active = 0;
    
    for (const [ip, challenge] of this.challenges) {
      if (challenge.expires > now) {
        active++;
      } else {
        this.challenges.delete(ip);
      }
    }
    
    return active;
  }
  
  shutdown() {
    this.challenges.clear();
    this.failures.clear();
  }
}

/**
 * Timed Blacklist
 */
class TimedBlacklist {
  constructor(config) {
    this.config = config;
    this.entries = new Map();
  }
  
  add(ip, duration) {
    const expires = Date.now() + (duration || this.config.blacklistDuration);
    this.entries.set(ip, { added: Date.now(), expires });
  }
  
  isBlacklisted(ip) {
    const entry = this.entries.get(ip);
    if (!entry) return false;
    
    if (Date.now() > entry.expires) {
      this.entries.delete(ip);
      return false;
    }
    
    return true;
  }
  
  remove(ip) {
    this.entries.delete(ip);
  }
  
  get size() {
    return this.entries.size;
  }
}

/**
 * Attack Detector
 */
class AttackDetector {
  constructor(config) {
    this.config = config;
  }
  
  async detect(context) {
    const attacks = [];
    
    // Volumetric attack
    if (this.detectVolumetric(context)) {
      attacks.push({
        type: AttackType.VOLUMETRIC,
        confidence: 0.9,
        details: 'High request volume detected'
      });
    }
    
    // HTTP flood
    if (this.detectHTTPFlood(context)) {
      attacks.push({
        type: AttackType.HTTP_FLOOD,
        confidence: 0.85,
        details: 'HTTP flood pattern detected'
      });
    }
    
    // Slowloris
    if (this.detectSlowloris(context)) {
      attacks.push({
        type: AttackType.SLOWLORIS,
        confidence: 0.8,
        details: 'Slow request attack detected'
      });
    }
    
    // Application layer
    if (this.detectApplicationAttack(context)) {
      attacks.push({
        type: AttackType.APPLICATION,
        confidence: 0.75,
        details: 'Application layer attack pattern'
      });
    }
    
    return attacks;
  }
  
  detectVolumetric(context) {
    if (!context.stats) return false;
    
    const recentRequests = context.stats.requests.filter(
      r => r.timestamp > Date.now() - 60000
    );
    
    return recentRequests.length > this.config.maxRequestsPerWindow * 2;
  }
  
  detectHTTPFlood(context) {
    if (!context.patterns) return false;
    
    // High burstiness + low interval variance
    return context.patterns.burstiness > 0.7 &&
           this.calculateVariance(context.patterns.intervals) < 200;
  }
  
  detectSlowloris(context) {
    if (!context.request.headers) return false;
    
    // Incomplete headers or slow headers
    const contentLength = parseInt(context.request.headers['content-length'] || 0);
    const hasSlowHeaders = !context.request.headers['user-agent'] ||
                          !context.request.headers['accept'];
    
    return contentLength > 10000 && hasSlowHeaders;
  }
  
  detectApplicationAttack(context) {
    if (!context.stats) return false;
    
    // Many different paths (scanning)
    const pathDiversity = context.stats.uniquePaths.size / context.stats.totalRequests;
    
    // Unusual method distribution
    const postRatio = (context.stats.methods.get('POST') || 0) / context.stats.totalRequests;
    
    return pathDiversity > 0.8 || postRatio > 0.9;
  }
  
  calculateVariance(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  }
}

/**
 * Mitigation Engine
 */
class MitigationEngine {
  constructor(config) {
    this.config = config;
  }
  
  async mitigate(context) {
    const { attacks, ip } = context;
    
    // Determine severity
    const maxConfidence = Math.max(...attacks.map(a => a.confidence));
    const attackTypes = attacks.map(a => a.type);
    
    // Critical attacks - immediate block
    if (maxConfidence > 0.9 || attacks.length > 2) {
      return {
        action: 'block',
        duration: this.config.blacklistDuration * 2,
        reason: 'Multiple high-confidence attacks detected'
      };
    }
    
    // Volumetric attacks - aggressive rate limit
    if (attackTypes.includes(AttackType.VOLUMETRIC)) {
      return {
        action: 'rateLimit',
        limit: 5,
        reason: 'Volumetric attack mitigation'
      };
    }
    
    // Slowloris - tarpit
    if (attackTypes.includes(AttackType.SLOWLORIS)) {
      return {
        action: 'tarpit',
        delay: 10000,
        reason: 'Slowloris mitigation'
      };
    }
    
    // Default - challenge
    return {
      action: 'challenge',
      reason: 'Suspicious activity detected'
    };
  }
}

/**
 * Create advanced DDoS protection instance
 */
export function createAdvancedDDoSProtection(config) {
  return new AdvancedDDoSProtection(config);
}

export default AdvancedDDoSProtection;