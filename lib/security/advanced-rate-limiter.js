/**
 * Advanced Rate Limiter with DDoS Protection
 * Implements multiple rate limiting strategies and attack detection
 */

const { RateLimiterRedis, RateLimiterMemory } = require('rate-limiter-flexible');
const crypto = require('crypto');
const { createLogger } = require('../core/logger');
const PrometheusMetrics = require('../monitoring/prometheus-metrics');

const logger = createLogger('rate-limiter');

// Rate limiting presets
const RATE_LIMIT_PRESETS = {
  // API endpoints
  api_strict: { points: 10, duration: 60, blockDuration: 600 },
  api_normal: { points: 60, duration: 60, blockDuration: 300 },
  api_relaxed: { points: 300, duration: 60, blockDuration: 60 },
  
  // Authentication
  auth_login: { points: 5, duration: 900, blockDuration: 900 },
  auth_2fa: { points: 3, duration: 300, blockDuration: 3600 },
  auth_register: { points: 3, duration: 3600, blockDuration: 3600 },
  
  // Mining operations
  mining_submit: { points: 1000, duration: 60, blockDuration: 60 },
  mining_connect: { points: 10, duration: 300, blockDuration: 600 },
  
  // Payment operations
  payment_request: { points: 5, duration: 3600, blockDuration: 3600 },
  payment_webhook: { points: 100, duration: 60, blockDuration: 300 },
  
  // WebSocket
  ws_connect: { points: 5, duration: 60, blockDuration: 600 },
  ws_message: { points: 120, duration: 60, blockDuration: 60 }
};

// DDoS detection thresholds
const DDOS_THRESHOLDS = {
  requestsPerSecond: 100,
  uniqueIPsPerSecond: 50,
  totalBandwidthMbps: 100,
  suspiciousPatterns: {
    sameUserAgent: 50,
    sameReferer: 50,
    noHeaders: 100
  }
};

class AdvancedRateLimiter {
  constructor(options = {}) {
    this.options = {
      redis: options.redis || null,
      keyPrefix: options.keyPrefix || 'otedama:rl:',
      globalLimits: options.globalLimits || true,
      enableDDoSProtection: options.enableDDoSProtection !== false,
      enableMetrics: options.enableMetrics !== false,
      whitelistIPs: options.whitelistIPs || [],
      blacklistIPs: options.blacklistIPs || [],
      trustedProxies: options.trustedProxies || [],
      customLimits: options.customLimits || {},
      ...options
    };

    // Initialize rate limiters
    this.limiters = new Map();
    this.ddosProtection = new Map();
    this.metrics = options.metrics || (this.options.enableMetrics ? new PrometheusMetrics() : null);
    
    // Attack detection state
    this.attackState = {
      isUnderAttack: false,
      attackStartTime: null,
      attackType: null,
      mitigationActive: false
    };

    // Initialize presets
    this._initializeLimiters();
    
    // Start DDoS monitoring
    if (this.options.enableDDoSProtection) {
      this._startDDoSMonitoring();
    }

    logger.info('Advanced rate limiter initialized');
  }

  _initializeLimiters() {
    // Create limiters for each preset
    const presets = { ...RATE_LIMIT_PRESETS, ...this.options.customLimits };
    
    for (const [name, config] of Object.entries(presets)) {
      this.limiters.set(name, this._createLimiter(name, config));
    }

    // Global rate limiter
    if (this.options.globalLimits) {
      this.limiters.set('global', this._createLimiter('global', {
        points: 10000,
        duration: 60,
        blockDuration: 300
      }));
    }

    // DDoS protection limiter
    if (this.options.enableDDoSProtection) {
      this.limiters.set('ddos_shield', this._createLimiter('ddos_shield', {
        points: 1000,
        duration: 1,
        blockDuration: 3600
      }));
    }
  }

  _createLimiter(name, config) {
    const limiterConfig = {
      keyPrefix: `${this.options.keyPrefix}${name}:`,
      points: config.points,
      duration: config.duration,
      blockDuration: config.blockDuration,
      execEvenly: config.execEvenly || false
    };

    // Use Redis if available, otherwise memory
    if (this.options.redis) {
      return new RateLimiterRedis({
        storeClient: this.options.redis,
        ...limiterConfig
      });
    } else {
      return new RateLimiterMemory(limiterConfig);
    }
  }

  /**
   * Main rate limiting middleware
   */
  middleware(limiterName = 'api_normal') {
    return async (req, res, next) => {
      try {
        // Extract client identifier
        const clientId = this._getClientId(req);
        
        // Check whitelist/blacklist
        const ipCheck = this._checkIPList(clientId.ip);
        if (ipCheck === 'blacklist') {
          return this._rejectRequest(res, 'Forbidden', 403);
        }
        if (ipCheck === 'whitelist') {
          return next();
        }

        // Check if under DDoS attack
        if (this.attackState.isUnderAttack && this.options.enableDDoSProtection) {
          await this._handleDDoSMitigation(req, res, clientId);
        }

        // Apply rate limiting
        const limiters = [limiterName];
        if (this.options.globalLimits) {
          limiters.push('global');
        }

        for (const limiter of limiters) {
          try {
            await this._consumePoints(limiter, clientId.key, 1);
          } catch (rateLimiterRes) {
            return this._handleRateLimitExceeded(req, res, limiter, rateLimiterRes);
          }
        }

        // Track metrics
        if (this.metrics) {
          this.metrics.recordHttpRequest(
            req.method,
            req.path,
            200,
            0,
            0,
            0
          );
        }

        next();
      } catch (error) {
        logger.error('Rate limiter error:', error);
        // Fail open in case of errors
        next();
      }
    };
  }

  /**
   * WebSocket rate limiting
   */
  wsMiddleware(limiterName = 'ws_message') {
    return async (socket, next) => {
      try {
        const clientId = this._getClientIdFromSocket(socket);
        
        // Check IP lists
        const ipCheck = this._checkIPList(clientId.ip);
        if (ipCheck === 'blacklist') {
          socket.disconnect(true);
          return;
        }
        if (ipCheck === 'whitelist') {
          return next();
        }

        // Apply rate limiting
        try {
          await this._consumePoints(limiterName, clientId.key, 1);
          next();
        } catch (rateLimiterRes) {
          socket.emit('error', {
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter: Math.ceil(rateLimiterRes.msBeforeNext / 1000)
          });
          socket.disconnect(true);
        }
      } catch (error) {
        logger.error('WebSocket rate limiter error:', error);
        next();
      }
    };
  }

  /**
   * Custom rate limiting for specific operations
   */
  async checkLimit(key, limiterName, points = 1) {
    const limiter = this.limiters.get(limiterName);
    if (!limiter) {
      throw new Error(`Unknown limiter: ${limiterName}`);
    }

    try {
      const result = await limiter.consume(key, points);
      return {
        allowed: true,
        remainingPoints: result.remainingPoints,
        msBeforeNext: result.msBeforeNext
      };
    } catch (rateLimiterRes) {
      return {
        allowed: false,
        remainingPoints: rateLimiterRes.remainingPoints || 0,
        msBeforeNext: rateLimiterRes.msBeforeNext || 0,
        retryAfter: Math.ceil(rateLimiterRes.msBeforeNext / 1000)
      };
    }
  }

  /**
   * DDoS Protection Methods
   */
  _startDDoSMonitoring() {
    // Monitor request patterns every second
    setInterval(() => {
      this._analyzeDDoSPatterns();
    }, 1000);

    // Reset attack state periodically
    setInterval(() => {
      if (this.attackState.isUnderAttack && 
          Date.now() - this.attackState.attackStartTime > 300000) { // 5 minutes
        this._clearAttackState();
      }
    }, 60000);
  }

  async _analyzeDDoSPatterns() {
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    
    // Analyze recent requests
    const recentRequests = Array.from(this.ddosProtection.entries())
      .filter(([_, data]) => data.timestamp > oneSecondAgo);

    if (recentRequests.length === 0) return;

    // Check various DDoS indicators
    const indicators = {
      requestRate: recentRequests.length,
      uniqueIPs: new Set(recentRequests.map(([_, d]) => d.ip)).size,
      userAgents: this._analyzeUserAgents(recentRequests),
      patterns: this._detectSuspiciousPatterns(recentRequests)
    };

    // Determine if under attack
    const attackType = this._determineAttackType(indicators);
    
    if (attackType && !this.attackState.isUnderAttack) {
      this._activateAttackMode(attackType, indicators);
    } else if (!attackType && this.attackState.isUnderAttack) {
      this._deactivateAttackMode();
    }

    // Clean old entries
    this._cleanDDoSData(oneSecondAgo);
  }

  _analyzeUserAgents(requests) {
    const userAgents = {};
    requests.forEach(([_, data]) => {
      const ua = data.userAgent || 'none';
      userAgents[ua] = (userAgents[ua] || 0) + 1;
    });
    return userAgents;
  }

  _detectSuspiciousPatterns(requests) {
    const patterns = {
      noHeaders: 0,
      sameReferer: {},
      rapidRequests: 0,
      suspiciousUAs: 0
    };

    const ipRequestTimes = {};
    
    requests.forEach(([_, data]) => {
      // No headers
      if (!data.userAgent || !data.headers) {
        patterns.noHeaders++;
      }
      
      // Same referer
      if (data.referer) {
        patterns.sameReferer[data.referer] = (patterns.sameReferer[data.referer] || 0) + 1;
      }
      
      // Rapid requests from same IP
      if (!ipRequestTimes[data.ip]) {
        ipRequestTimes[data.ip] = [];
      }
      ipRequestTimes[data.ip].push(data.timestamp);
      
      // Suspicious user agents
      if (this._isSuspiciousUA(data.userAgent)) {
        patterns.suspiciousUAs++;
      }
    });

    // Calculate rapid request rate
    for (const times of Object.values(ipRequestTimes)) {
      if (times.length > 10) {
        patterns.rapidRequests++;
      }
    }

    return patterns;
  }

  _determineAttackType(indicators) {
    if (indicators.requestRate > DDOS_THRESHOLDS.requestsPerSecond) {
      return 'volumetric';
    }
    
    if (indicators.uniqueIPs > DDOS_THRESHOLDS.uniqueIPsPerSecond) {
      return 'distributed';
    }
    
    const maxSameUA = Math.max(...Object.values(indicators.userAgents));
    if (maxSameUA > DDOS_THRESHOLDS.suspiciousPatterns.sameUserAgent) {
      return 'application';
    }
    
    if (indicators.patterns.noHeaders > DDOS_THRESHOLDS.suspiciousPatterns.noHeaders) {
      return 'bot_attack';
    }
    
    return null;
  }

  _activateAttackMode(attackType, indicators) {
    this.attackState = {
      isUnderAttack: true,
      attackStartTime: Date.now(),
      attackType,
      mitigationActive: true
    };

    logger.warn('DDoS attack detected', {
      type: attackType,
      indicators
    });

    // Emit event for monitoring
    if (this.metrics) {
      this.metrics.recordError('ddos_attack', 'critical');
    }

    // Activate additional protection
    this._activateMitigations(attackType);
  }

  _deactivateAttackMode() {
    logger.info('DDoS attack ended', {
      duration: Date.now() - this.attackState.attackStartTime,
      type: this.attackState.attackType
    });

    this._clearAttackState();
  }

  _activateMitigations(attackType) {
    switch (attackType) {
      case 'volumetric':
        // Reduce rate limits
        this._tightenRateLimits(0.2); // 20% of normal
        break;
        
      case 'distributed':
        // Enable stricter per-IP limits
        this._enableStrictIPLimits();
        break;
        
      case 'application':
        // Enable challenge-response
        this._enableChallengeResponse();
        break;
        
      case 'bot_attack':
        // Require valid headers
        this._enforceHeaderValidation();
        break;
    }
  }

  async _handleDDoSMitigation(req, res, clientId) {
    // Apply DDoS shield rate limiter
    try {
      await this._consumePoints('ddos_shield', clientId.key, 1);
    } catch (rateLimiterRes) {
      return this._rejectRequest(res, 'Service Unavailable', 503);
    }

    // Additional checks based on attack type
    switch (this.attackState.attackType) {
      case 'bot_attack':
        if (!this._validateHeaders(req)) {
          return this._rejectRequest(res, 'Bad Request', 400);
        }
        break;
        
      case 'application':
        if (this._requiresChallenge(clientId)) {
          return this._sendChallenge(res);
        }
        break;
    }
  }

  /**
   * Client identification
   */
  _getClientId(req) {
    const ip = this._getClientIP(req);
    const userAgent = req.get('user-agent') || 'unknown';
    const userId = req.user?.id || 'anonymous';
    
    // Store request data for DDoS analysis
    if (this.options.enableDDoSProtection) {
      const requestId = crypto.randomBytes(16).toString('hex');
      this.ddosProtection.set(requestId, {
        ip,
        userAgent,
        timestamp: Date.now(),
        headers: req.headers,
        referer: req.get('referer')
      });
    }

    return {
      ip,
      userAgent,
      userId,
      key: `${ip}:${userId}`
    };
  }

  _getClientIdFromSocket(socket) {
    const ip = socket.handshake.address || socket.conn.remoteAddress;
    const userAgent = socket.handshake.headers['user-agent'] || 'unknown';
    const userId = socket.userId || 'anonymous';
    
    return {
      ip,
      userAgent,
      userId,
      key: `${ip}:${userId}`
    };
  }

  _getClientIP(req) {
    // Check trusted proxy headers
    if (this.options.trustedProxies.length > 0) {
      const xForwardedFor = req.get('x-forwarded-for');
      if (xForwardedFor) {
        const ips = xForwardedFor.split(',').map(ip => ip.trim());
        // Return first non-proxy IP
        for (const ip of ips) {
          if (!this.options.trustedProxies.includes(ip)) {
            return ip;
          }
        }
      }
      
      const xRealIP = req.get('x-real-ip');
      if (xRealIP && !this.options.trustedProxies.includes(xRealIP)) {
        return xRealIP;
      }
    }
    
    return req.ip || req.connection.remoteAddress;
  }

  /**
   * IP list management
   */
  _checkIPList(ip) {
    if (this.options.whitelistIPs.includes(ip)) {
      return 'whitelist';
    }
    if (this.options.blacklistIPs.includes(ip)) {
      return 'blacklist';
    }
    return null;
  }

  addToBlacklist(ip, duration = 3600000) {
    this.options.blacklistIPs.push(ip);
    
    // Auto-remove after duration
    if (duration > 0) {
      setTimeout(() => {
        this.removeFromBlacklist(ip);
      }, duration);
    }
    
    logger.info(`IP ${ip} added to blacklist for ${duration}ms`);
  }

  removeFromBlacklist(ip) {
    const index = this.options.blacklistIPs.indexOf(ip);
    if (index > -1) {
      this.options.blacklistIPs.splice(index, 1);
      logger.info(`IP ${ip} removed from blacklist`);
    }
  }

  /**
   * Rate limiting helpers
   */
  async _consumePoints(limiterName, key, points) {
    const limiter = this.limiters.get(limiterName);
    if (!limiter) {
      throw new Error(`Unknown limiter: ${limiterName}`);
    }
    
    return limiter.consume(key, points);
  }

  _handleRateLimitExceeded(req, res, limiterName, rateLimiterRes) {
    const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000);
    
    logger.warn('Rate limit exceeded', {
      limiter: limiterName,
      ip: this._getClientIP(req),
      path: req.path,
      retryAfter
    });

    if (this.metrics) {
      this.metrics.recordError('rate_limit_exceeded', 'warning');
    }

    res.set({
      'Retry-After': retryAfter,
      'X-RateLimit-Limit': rateLimiterRes.points,
      'X-RateLimit-Remaining': rateLimiterRes.remainingPoints || 0,
      'X-RateLimit-Reset': new Date(Date.now() + rateLimiterRes.msBeforeNext).toISOString()
    });

    return res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Retry after ${retryAfter} seconds`,
      retryAfter
    });
  }

  _rejectRequest(res, message, status) {
    return res.status(status).json({ error: message });
  }

  /**
   * DDoS mitigation helpers
   */
  _validateHeaders(req) {
    const requiredHeaders = ['user-agent', 'accept'];
    return requiredHeaders.every(header => req.get(header));
  }

  _isSuspiciousUA(userAgent) {
    const suspiciousPatterns = [
      /^python/i,
      /^curl/i,
      /^wget/i,
      /bot/i,
      /crawler/i,
      /spider/i
    ];
    
    return suspiciousPatterns.some(pattern => pattern.test(userAgent));
  }

  _requiresChallenge(clientId) {
    // Implement challenge logic (e.g., CAPTCHA, proof of work)
    return false; // Placeholder
  }

  _sendChallenge(res) {
    return res.status(429).json({
      error: 'Challenge Required',
      challenge: {
        type: 'proof_of_work',
        difficulty: 20,
        nonce: crypto.randomBytes(32).toString('hex')
      }
    });
  }

  _tightenRateLimits(factor) {
    for (const [name, limiter] of this.limiters) {
      if (name !== 'global' && name !== 'ddos_shield') {
        // Temporarily reduce points
        limiter.points = Math.floor(limiter.points * factor);
      }
    }
  }

  _enableStrictIPLimits() {
    // Create temporary strict limiter
    this.limiters.set('ddos_strict_ip', this._createLimiter('ddos_strict_ip', {
      points: 10,
      duration: 60,
      blockDuration: 3600
    }));
  }

  _enforceHeaderValidation() {
    // Flag for header validation
    this.enforceHeaders = true;
  }

  _enableChallengeResponse() {
    // Flag for challenge requirement
    this.requireChallenge = true;
  }

  _cleanDDoSData(threshold) {
    for (const [key, data] of this.ddosProtection) {
      if (data.timestamp < threshold) {
        this.ddosProtection.delete(key);
      }
    }
  }

  _clearAttackState() {
    this.attackState = {
      isUnderAttack: false,
      attackStartTime: null,
      attackType: null,
      mitigationActive: false
    };
    
    // Reset temporary mitigations
    this.enforceHeaders = false;
    this.requireChallenge = false;
    this.limiters.delete('ddos_strict_ip');
    
    // Restore normal rate limits
    this._initializeLimiters();
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      attackState: this.attackState,
      blacklistedIPs: this.options.blacklistIPs.length,
      whitelistedIPs: this.options.whitelistIPs.length,
      activeLimiters: Array.from(this.limiters.keys()),
      ddosDataSize: this.ddosProtection.size
    };
  }

  /**
   * Reset specific limiter
   */
  async resetLimiter(limiterName, key) {
    const limiter = this.limiters.get(limiterName);
    if (limiter) {
      await limiter.delete(key);
    }
  }

  /**
   * Cleanup
   */
  cleanup() {
    // Clear intervals
    if (this._ddosMonitorInterval) {
      clearInterval(this._ddosMonitorInterval);
    }
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
    }
    
    // Clear data
    this.ddosProtection.clear();
    this.limiters.clear();
  }
}

module.exports = AdvancedRateLimiter;