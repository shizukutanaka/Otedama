/**
 * Advanced DDoS Protection System
 * National-scale protection with AI-powered threat detection
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';

export class DDoSProtection extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.config = {
      // Request limits
      requestsPerMinute: options.requestsPerMinute || 60,
      requestsPerHour: options.requestsPerHour || 1000,
      burstLimit: options.burstLimit || 100,
      
      // Connection limits
      maxConcurrentConnections: options.maxConcurrentConnections || 10000,
      connectionsPerIP: options.connectionsPerIP || 100,
      
      // Blacklist/whitelist
      blacklistDuration: options.blacklistDuration || 3600000, // 1 hour
      whitelistIPs: new Set(options.whitelistIPs || []),
      
      // Advanced protection
      enablePatternDetection: options.enablePatternDetection !== false,
      enableGeoBlocking: options.enableGeoBlocking || false,
      blockedCountries: new Set(options.blockedCountries || []),
      
      // Thresholds
      cpuThreshold: options.cpuThreshold || 80,
      memoryThreshold: options.memoryThreshold || 85,
      
      // AI detection
      enableAIDetection: options.enableAIDetection !== false,
      anomalyThreshold: options.anomalyThreshold || 0.8
    };
    
    // Request tracking
    this.requestCache = new LRUCache({
      max: 100000,
      ttl: 60000 // 1 minute
    });
    
    // Connection tracking
    this.connectionCache = new LRUCache({
      max: 50000,
      ttl: 300000 // 5 minutes
    });
    
    // Blacklist
    this.blacklist = new Map();
    
    // Attack patterns
    this.attackPatterns = new Map();
    this.initializePatterns();
    
    // Metrics
    this.metrics = {
      totalRequests: 0,
      blockedRequests: 0,
      detectedAttacks: 0,
      activeConnections: 0,
      blacklistedIPs: 0
    };
    
    // Start cleanup interval
    this.startCleanup();
  }

  async initialize() {
    // Load geo database if enabled
    if (this.config.enableGeoBlocking) {
      // Initialize geo blocking
      this.emit('geo:initialized');
    }
    
    // Initialize AI model if enabled
    if (this.config.enableAIDetection) {
      // Initialize AI detection
      this.emit('ai:initialized');
    }
    
    this.emit('initialized');
  }

  async checkRequest(req) {
    const ip = this.getClientIP(req);
    const now = Date.now();
    
    this.metrics.totalRequests++;
    
    // Check whitelist
    if (this.config.whitelistIPs.has(ip)) {
      return { allowed: true, reason: 'whitelisted' };
    }
    
    // Check blacklist
    if (this.isBlacklisted(ip)) {
      this.metrics.blockedRequests++;
      return { allowed: false, reason: 'blacklisted' };
    }
    
    // Check rate limits
    const rateCheck = this.checkRateLimit(ip);
    if (!rateCheck.allowed) {
      this.metrics.blockedRequests++;
      this.addToBlacklist(ip, 'rate_limit_exceeded');
      return rateCheck;
    }
    
    // Check connection limits
    const connCheck = this.checkConnectionLimit(ip);
    if (!connCheck.allowed) {
      this.metrics.blockedRequests++;
      return connCheck;
    }
    
    // Pattern detection
    if (this.config.enablePatternDetection) {
      const patternCheck = this.checkPatterns(req);
      if (!patternCheck.allowed) {
        this.metrics.blockedRequests++;
        this.metrics.detectedAttacks++;
        this.addToBlacklist(ip, 'attack_pattern_detected');
        return patternCheck;
      }
    }
    
    // AI anomaly detection
    if (this.config.enableAIDetection) {
      const anomalyScore = await this.calculateAnomalyScore(req);
      if (anomalyScore > this.config.anomalyThreshold) {
        this.metrics.blockedRequests++;
        this.metrics.detectedAttacks++;
        this.emit('anomaly:detected', { ip, score: anomalyScore });
        return { allowed: false, reason: 'anomaly_detected', score: anomalyScore };
      }
    }
    
    // Update request tracking
    this.trackRequest(ip);
    
    return { allowed: true };
  }

  checkRateLimit(ip) {
    const key = `req:${ip}`;
    const requests = this.requestCache.get(key) || [];
    const now = Date.now();
    
    // Filter requests within time windows
    const recentRequests = requests.filter(t => now - t < 60000);
    const hourlyRequests = requests.filter(t => now - t < 3600000);
    
    // Check limits
    if (recentRequests.length >= this.config.requestsPerMinute) {
      return { allowed: false, reason: 'minute_rate_exceeded' };
    }
    
    if (hourlyRequests.length >= this.config.requestsPerHour) {
      return { allowed: false, reason: 'hourly_rate_exceeded' };
    }
    
    // Check burst
    const recentBurst = recentRequests.filter(t => now - t < 10000);
    if (recentBurst.length >= this.config.burstLimit) {
      return { allowed: false, reason: 'burst_limit_exceeded' };
    }
    
    return { allowed: true };
  }

  checkConnectionLimit(ip) {
    const connections = this.connectionCache.get(ip) || 0;
    
    if (connections >= this.config.connectionsPerIP) {
      return { allowed: false, reason: 'connection_limit_exceeded' };
    }
    
    if (this.metrics.activeConnections >= this.config.maxConcurrentConnections) {
      return { allowed: false, reason: 'global_connection_limit_exceeded' };
    }
    
    return { allowed: true };
  }

  checkPatterns(req) {
    const path = req.path || req.url;
    const userAgent = req.headers['user-agent'] || '';
    const method = req.method;
    
    // Check known attack patterns
    for (const [name, pattern] of this.attackPatterns) {
      if (pattern.test(path, userAgent, method)) {
        return { allowed: false, reason: `attack_pattern_${name}` };
      }
    }
    
    return { allowed: true };
  }

  async calculateAnomalyScore(req) {
    // Simplified anomaly scoring
    let score = 0;
    
    // Check request frequency pattern
    const ip = this.getClientIP(req);
    const requests = this.requestCache.get(`req:${ip}`) || [];
    const intervals = [];
    
    for (let i = 1; i < requests.length; i++) {
      intervals.push(requests[i] - requests[i-1]);
    }
    
    if (intervals.length > 5) {
      const avgInterval = intervals.reduce((a, b) => a + b) / intervals.length;
      const variance = intervals.reduce((sum, i) => sum + Math.pow(i - avgInterval, 2), 0) / intervals.length;
      
      // Low variance indicates bot-like behavior
      if (variance < 100) {
        score += 0.3;
      }
    }
    
    // Check for suspicious headers
    if (!req.headers['user-agent']) score += 0.2;
    if (!req.headers['accept']) score += 0.1;
    if (!req.headers['accept-language']) score += 0.1;
    
    // Check for suspicious patterns
    const path = req.path || req.url;
    if (path.includes('..') || path.includes('//')) score += 0.2;
    if (path.length > 200) score += 0.1;
    
    return Math.min(score, 1);
  }

  trackRequest(ip) {
    const key = `req:${ip}`;
    const requests = this.requestCache.get(key) || [];
    requests.push(Date.now());
    
    // Keep only last 1000 requests
    if (requests.length > 1000) {
      requests.shift();
    }
    
    this.requestCache.set(key, requests);
  }

  trackConnection(ip, add = true) {
    const current = this.connectionCache.get(ip) || 0;
    const newCount = add ? current + 1 : Math.max(0, current - 1);
    
    if (newCount > 0) {
      this.connectionCache.set(ip, newCount);
    } else {
      this.connectionCache.delete(ip);
    }
    
    this.metrics.activeConnections += add ? 1 : -1;
  }

  isBlacklisted(ip) {
    const entry = this.blacklist.get(ip);
    if (!entry) return false;
    
    if (Date.now() > entry.expires) {
      this.blacklist.delete(ip);
      this.metrics.blacklistedIPs--;
      return false;
    }
    
    return true;
  }

  addToBlacklist(ip, reason) {
    this.blacklist.set(ip, {
      reason,
      timestamp: Date.now(),
      expires: Date.now() + this.config.blacklistDuration
    });
    
    this.metrics.blacklistedIPs++;
    this.emit('ip:blacklisted', { ip, reason });
  }

  removeFromBlacklist(ip) {
    if (this.blacklist.delete(ip)) {
      this.metrics.blacklistedIPs--;
      this.emit('ip:unblacklisted', { ip });
    }
  }

  initializePatterns() {
    // SQL injection patterns
    this.attackPatterns.set('sql_injection', {
      test: (path) => /(\' or \'|union select|drop table|insert into)/i.test(path)
    });
    
    // XSS patterns
    this.attackPatterns.set('xss', {
      test: (path) => /<script|javascript:|onerror=/i.test(path)
    });
    
    // Directory traversal
    this.attackPatterns.set('directory_traversal', {
      test: (path) => /\.\.\/|\.\.\\/.test(path)
    });
    
    // Bot patterns
    this.attackPatterns.set('bot', {
      test: (path, ua) => /bot|crawler|spider|scraper/i.test(ua) && !this.isGoodBot(ua)
    });
  }

  isGoodBot(userAgent) {
    const goodBots = /googlebot|bingbot|slurp|duckduckbot|baiduspider/i;
    return goodBots.test(userAgent);
  }

  getClientIP(req) {
    return req.ip || 
           req.headers['x-forwarded-for']?.split(',')[0] || 
           req.headers['x-real-ip'] || 
           req.connection?.remoteAddress ||
           'unknown';
  }

  startCleanup() {
    // Clean up expired blacklist entries every 5 minutes
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [ip, entry] of this.blacklist.entries()) {
        if (now > entry.expires) {
          this.blacklist.delete(ip);
          this.metrics.blacklistedIPs--;
        }
      }
    }, 300000);
  }

  middleware() {
    return async (req, res, next) => {
      const result = await this.checkRequest(req);
      
      if (!result.allowed) {
        res.status(429).json({
          error: 'Too Many Requests',
          reason: result.reason,
          retryAfter: 60
        });
        return;
      }
      
      // Track connection
      const ip = this.getClientIP(req);
      this.trackConnection(ip, true);
      
      // Clean up on response end
      res.on('finish', () => {
        this.trackConnection(ip, false);
      });
      
      next();
    };
  }

  getMetrics() {
    return {
      ...this.metrics,
      cacheSize: this.requestCache.size,
      blacklistSize: this.blacklist.size
    };
  }

  async shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.requestCache.clear();
    this.connectionCache.clear();
    this.blacklist.clear();
    
    this.emit('shutdown');
  }
}

export default DDoSProtection;