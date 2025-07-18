// NOTE: This file was an incomplete continuation and caused syntax errors.
// All functionality has been merged into lib/security/ddos-protection.js.
// Keeping an empty module here to preserve import paths, if any.
export {};
    const difficulty = this.getChallengeLevel();
      challenge.difficulty = difficulty;
      challenge.prefix = crypto.randomBytes(16).toString('hex');
      challenge.target = '0'.repeat(difficulty);
      challenge.algorithm = 'sha256';
    } else if (this.config.challenge.type === 'captcha') {
      // CAPTCHA challenge
      challenge.captchaId = crypto.randomUUID();
      challenge.captchaUrl = `/api/captcha/${challenge.captchaId}`;
    }
    
    // Store challenge
    this.challengeCache.set(challenge.id, challenge);
    
    return challenge;
  }

  /**
   * Verify challenge response
   */
  verifyChallenge(challengeId, response, ip) {
    const challenge = this.challengeCache.get(challengeId);
    
    if (!challenge || challenge.ip !== ip) {
      return { valid: false, reason: 'invalid_challenge' };
    }
    
    // Check timeout
    if (Date.now() - challenge.timestamp > this.config.challenge.timeout) {
      this.challengeCache.delete(challengeId);
      return { valid: false, reason: 'challenge_timeout' };
    }
    
    if (challenge.type === 'computational') {
      // Verify proof of work
      const hash = crypto
        .createHash(challenge.algorithm)
        .update(challenge.prefix + response)
        .digest('hex');
      
      if (hash.startsWith(challenge.target)) {
        this.challengeCache.delete(challengeId);
        // Whitelist IP temporarily
        this.whitelistTemporary(ip, 3600000); // 1 hour
        return { valid: true };
      } else {
        return { valid: false, reason: 'invalid_proof' };
      }
    } else if (challenge.type === 'captcha') {
      // Verify CAPTCHA (simplified)
      if (response === challenge.captchaSolution) {
        this.challengeCache.delete(challengeId);
        this.whitelistTemporary(ip, 3600000);
        return { valid: true };
      } else {
        return { valid: false, reason: 'invalid_captcha' };
      }
    }
    
    return { valid: false, reason: 'unknown_challenge_type' };
  }

  /**
   * Handle WebSocket connections
   */
  async checkWebSocketConnection(ws, req) {
    const ip = this.getClientIP(req);
    
    // Check if allowed
    const check = await this.checkRequest(req);
    if (!check.allowed) {
      ws.close(1008, 'Policy violation');
      return false;
    }
    
    // Monitor WebSocket behavior
    const connectionId = crypto.randomUUID();
    
    ws.on('message', (data) => {
      this.trackWebSocketMessage(ip, connectionId, data);
    });
    
    ws.on('close', () => {
      this.removeWebSocketConnection(ip, connectionId);
    });
    
    // Add to active connections
    this.addWebSocketConnection(ip, connectionId);
    
    return true;
  }

  /**
   * Track WebSocket message
   */
  trackWebSocketMessage(ip, connectionId, data) {
    const connections = this.connectionCache.get(`ws:${ip}`) || new Map();
    const connection = connections.get(connectionId) || {
      messages: 0,
      bytes: 0,
      startTime: Date.now()
    };
    
    connection.messages++;
    connection.bytes += data.length;
    
    // Check for flood
    const duration = Date.now() - connection.startTime;
    const messagesPerSecond = connection.messages / (duration / 1000);
    
    if (messagesPerSecond > 100) { // 100 messages per second
      this.handleWebSocketFlood(ip, connectionId);
    }
    
    connections.set(connectionId, connection);
    this.connectionCache.set(`ws:${ip}`, connections);
  }

  /**
   * Start monitoring
   */
  startMonitoring() {
    // Periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000); // Every minute
    
    // Attack detection
    this.detectionInterval = setInterval(() => {
      this.detectAttacks();
    }, 5000); // Every 5 seconds
    
    // Statistics update
    this.statsInterval = setInterval(() => {
      this.updateStatistics();
    }, 10000); // Every 10 seconds
  }

  /**
   * Detect ongoing attacks
   */
  detectAttacks() {
    const now = Date.now();
    const window = 60000; // 1 minute window
    
    // Analyze request patterns
    const requestCounts = new Map();
    
    for (const [key, requests] of this.requestCache.entries()) {
      if (key.startsWith('rate:')) {
        const ip = key.substring(5);
        const recentRequests = requests.filter(t => t > now - window);
        requestCounts.set(ip, recentRequests.length);
      }
    }
    
    // Detect volumetric attack
    const totalRequests = Array.from(requestCounts.values()).reduce((a, b) => a + b, 0);
    const avgRequestsPerIP = totalRequests / requestCounts.size || 0;
    
    if (totalRequests > 10000) { // 10k requests per minute
      this.handleAttackDetected({
        type: AttackType.VOLUMETRIC,
        severity: 'high',
        metrics: {
          totalRequests,
          uniqueIPs: requestCounts.size,
          avgRequestsPerIP
        }
      });
    }
    
    // Detect distributed attack
    const attackingIPs = Array.from(requestCounts.entries())
      .filter(([ip, count]) => count > this.config.rateLimit.maxRequests)
      .map(([ip]) => ip);
    
    if (attackingIPs.length > 100) { // 100+ attacking IPs
      this.handleAttackDetected({
        type: AttackType.DISTRIBUTED,
        severity: 'critical',
        metrics: {
          attackingIPs: attackingIPs.length,
          totalRequests
        }
      });
    }
    
    // Detect slowloris attack
    const slowConnections = Array.from(this.connectionCache.entries())
      .filter(([key, value]) => {
        if (!key.startsWith('ws:')) return false;
        const connections = value;
        return Array.from(connections.values()).some(conn => {
          const duration = now - conn.startTime;
          return duration > 300000 && conn.messages < 10; // 5 min, <10 messages
        });
      });
    
    if (slowConnections.length > 50) {
      this.handleAttackDetected({
        type: AttackType.SLOWLORIS,
        severity: 'medium',
        metrics: {
          slowConnections: slowConnections.length
        }
      });
    }
  }

  /**
   * Handle detected attack
   */
  handleAttackDetected(attack) {
    const attackId = crypto.randomUUID();
    
    this.attackStats.ongoing.set(attackId, {
      ...attack,
      id: attackId,
      startTime: Date.now(),
      mitigations: []
    });
    
    this.emit('attack:detected', attack);
    
    // Apply mitigation based on attack type
    switch (attack.type) {
      case AttackType.VOLUMETRIC:
        this.mitigateVolumetricAttack(attackId);
        break;
      case AttackType.DISTRIBUTED:
        this.mitigateDistributedAttack(attackId);
        break;
      case AttackType.SLOWLORIS:
        this.mitigateSlowlorisAttack(attackId);
        break;
    }
    
    this.attackStats.detected++;
  }

  /**
   * Mitigate volumetric attack
   */
  mitigateVolumetricAttack(attackId) {
    const attack = this.attackStats.ongoing.get(attackId);
    
    // Increase protection level
    this.escalateProtection('extreme');
    
    // Reduce rate limits
    this.config.rateLimit.maxRequests = Math.floor(this.config.rateLimit.maxRequests / 2);
    this.config.rateLimit.maxBurst = Math.floor(this.config.rateLimit.maxBurst / 2);
    
    // Enable stricter challenge-response
    this.config.challenge.difficulty = 'hard';
    
    attack.mitigations.push({
      strategy: ProtectionStrategy.RATE_LIMITING,
      timestamp: Date.now(),
      actions: ['reduced_limits', 'increased_challenge_difficulty']
    });
    
    this.emit('mitigation:applied', {
      attackId,
      strategy: ProtectionStrategy.RATE_LIMITING
    });
  }

  /**
   * Mitigate distributed attack
   */
  mitigateDistributedAttack(attackId) {
    const attack = this.attackStats.ongoing.get(attackId);
    
    // Enable geographic filtering if not already
    if (!this.config.geoFilter.enabled) {
      this.config.geoFilter.enabled = true;
      // Allow only specific regions during attack
      this.config.geoFilter.allowedCountries = ['US', 'CA', 'GB', 'DE', 'FR'];
    }
    
    // Implement behavioral analysis
    this.config.analysis.anomalyThreshold = 2; // More sensitive
    
    // Blacklist aggressive IPs
    const threshold = Math.floor(this.config.rateLimit.maxRequests * 0.8);
    for (const [key, requests] of this.requestCache.entries()) {
      if (key.startsWith('rate:')) {
        const ip = key.substring(5);
        if (requests.length > threshold) {
          this.blacklistIP(ip, 'ddos_attack');
        }
      }
    }
    
    attack.mitigations.push({
      strategy: ProtectionStrategy.BLACKLISTING,
      timestamp: Date.now(),
      actions: ['geo_filtering', 'behavioral_analysis', 'ip_blacklisting']
    });
    
    this.emit('mitigation:applied', {
      attackId,
      strategy: ProtectionStrategy.BLACKLISTING
    });
  }

  /**
   * Mitigate slowloris attack
   */
  mitigateSlowlorisAttack(attackId) {
    const attack = this.attackStats.ongoing.get(attackId);
    
    // Reduce connection timeouts
    this.config.connectionLimit.maxPerIP = Math.floor(this.config.connectionLimit.maxPerIP / 2);
    
    // Close slow connections
    const now = Date.now();
    for (const [key, connections] of this.connectionCache.entries()) {
      if (key.startsWith('ws:')) {
        for (const [connId, conn] of connections.entries()) {
          const duration = now - conn.startTime;
          const messagesPerMinute = (conn.messages / duration) * 60000;
          
          if (messagesPerMinute < 1) { // Less than 1 message per minute
            this.emit('connection:close', {
              ip: key.substring(3),
              connectionId: connId,
              reason: 'slowloris_mitigation'
            });
            connections.delete(connId);
          }
        }
      }
    }
    
    attack.mitigations.push({
      strategy: ProtectionStrategy.CONNECTION_LIMITING,
      timestamp: Date.now(),
      actions: ['reduced_connection_limits', 'closed_slow_connections']
    });
    
    this.emit('mitigation:applied', {
      attackId,
      strategy: ProtectionStrategy.CONNECTION_LIMITING
    });
  }

  /**
   * Escalate protection level
   */
  escalateProtection(level) {
    const levels = ['low', 'medium', 'high', 'extreme'];
    const currentIndex = levels.indexOf(this.config.protectionLevel);
    const newIndex = levels.indexOf(level);
    
    if (newIndex > currentIndex) {
      this.config.protectionLevel = level;
      
      // Apply level-specific settings
      switch (level) {
        case 'high':
          this.config.rateLimit.maxRequests = 50;
          this.config.rateLimit.maxBurst = 10;
          this.config.challenge.enabled = true;
          break;
        case 'extreme':
          this.config.rateLimit.maxRequests = 20;
          this.config.rateLimit.maxBurst = 5;
          this.config.challenge.enabled = true;
          this.config.challenge.difficulty = 'hard';
          this.config.analysis.enabled = true;
          break;
      }
      
      this.emit('protection:escalated', {
        from: levels[currentIndex],
        to: level
      });
    }
  }

  /**
   * Handle rate limited IP
   */
  handleRateLimited(ip) {
    const violations = (this.violationCache?.get(ip) || 0) + 1;
    this.violationCache?.set(ip, violations);
    
    if (violations >= this.config.blacklist.threshold) {
      this.blacklistIP(ip, 'rate_limit_violations');
    }
    
    this.emit('request:rate_limited', { ip, violations });
  }

  /**
   * Blacklist IP
   */
  blacklistIP(ip, reason) {
    if (this.isWhitelisted(ip)) {
      return; // Don't blacklist whitelisted IPs
    }
    
    this.blacklistCache.set(ip, {
      reason,
      timestamp: Date.now(),
      violations: this.violationCache?.get(ip) || 0
    });
    
    this.emit('ip:blacklisted', { ip, reason });
  }

  /**
   * Whitelist IP temporarily
   */
  whitelistTemporary(ip, duration) {
    if (!this.whitelistCache) {
      this.whitelistCache = new LRUCache({
        max: 10000,
        ttl: duration
      });
    }
    
    this.whitelistCache.set(ip, {
      timestamp: Date.now(),
      duration
    });
  }

  /**
   * Check if IP is blacklisted
   */
  isBlacklisted(ip) {
    return this.blacklistCache.has(ip);
  }

  /**
   * Check if IP is whitelisted
   */
  isWhitelisted(ip) {
    // Check permanent whitelist
    if (this.config.whitelist?.permanent?.includes(ip)) {
      return true;
    }
    
    // Check temporary whitelist
    return this.whitelistCache?.has(ip) || false;
  }

  /**
   * Get client IP
   */
  getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           req.ip;
  }

  /**
   * Track successful request
   */
  trackRequest(ip, timestamp) {
    // Update request cache
    const key = `rate:${ip}`;
    const requests = this.requestCache.get(key) || [];
    requests.push(timestamp);
    this.requestCache.set(key, requests);
    
    // Update traffic pattern
    if (!this.trafficPatterns.has(ip)) {
      this.trafficPatterns.set(ip, {
        requests: [],
        startTime: timestamp
      });
    }
    
    const pattern = this.trafficPatterns.get(ip);
    pattern.requests.push(timestamp);
    
    // Limit pattern history
    if (pattern.requests.length > 1000) {
      pattern.requests = pattern.requests.slice(-500);
    }
  }

  /**
   * Get challenge difficulty level
   */
  getChallengeLevel() {
    const difficultyMap = {
      easy: 3,
      medium: 4,
      hard: 5,
      extreme: 6
    };
    
    return difficultyMap[this.config.challenge.difficulty] || 4;
  }

  /**
   * Get total connections
   */
  getTotalConnections() {
    let total = 0;
    for (const [key, value] of this.connectionCache.entries()) {
      if (typeof value === 'number') {
        total += value;
      }
    }
    return total;
  }

  /**
   * Cleanup old data
   */
  cleanup() {
    // Clean up old attack records
    const now = Date.now();
    const maxAge = 3600000; // 1 hour
    
    for (const [id, attack] of this.attackStats.ongoing) {
      if (now - attack.startTime > maxAge) {
        this.attackStats.history.push(attack);
        this.attackStats.ongoing.delete(id);
      }
    }
    
    // Limit history
    if (this.attackStats.history.length > 100) {
      this.attackStats.history = this.attackStats.history.slice(-50);
    }
    
    // Clean up traffic patterns
    for (const [ip, pattern] of this.trafficPatterns) {
      if (now - pattern.startTime > 3600000 && pattern.requests.length === 0) {
        this.trafficPatterns.delete(ip);
      }
    }
  }

  /**
   * Update statistics
   */
  updateStatistics() {
    const stats = {
      requests: {
        total: 0,
        blocked: 0,
        challenged: 0
      },
      ips: {
        total: this.requestCache.size,
        blacklisted: this.blacklistCache.size,
        whitelisted: this.whitelistCache?.size || 0
      },
      attacks: {
        detected: this.attackStats.detected,
        mitigated: this.attackStats.mitigated,
        ongoing: this.attackStats.ongoing.size
      },
      protectionLevel: this.config.protectionLevel
    };
    
    this.emit('stats:update', stats);
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    if (this.detectionInterval) {
      clearInterval(this.detectionInterval);
    }
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      protectionLevel: this.config.protectionLevel,
      attacks: {
        ongoing: Array.from(this.attackStats.ongoing.values()),
        recent: this.attackStats.history.slice(-10),
        total: this.attackStats.detected
      },
      metrics: {
        requestsPerMinute: this.getRequestRate(),
        blacklistedIPs: this.blacklistCache.size,
        activeConnections: this.getTotalConnections()
      },
      config: {
        rateLimit: this.config.rateLimit,
        connectionLimit: this.config.connectionLimit,
        challenges: this.config.challenge.enabled
      }
    };
  }

  /**
   * Get request rate
   */
  getRequestRate() {
    const now = Date.now();
    const window = 60000; // 1 minute
    let total = 0;
    
    for (const [key, requests] of this.requestCache.entries()) {
      if (key.startsWith('rate:')) {
        const recent = requests.filter(t => t > now - window);
        total += recent.length;
      }
    }
    
    return total;
  }

  /**
   * Express middleware
   */
  middleware() {
    return async (req, res, next) => {
      try {
        const check = await this.checkRequest(req);
        
        if (!check.allowed) {
          // Handle based on reason
          switch (check.reason) {
            case 'blacklisted':
              res.status(403).json({ error: 'Access denied' });
              break;
            case 'rate_limit_exceeded':
              res.status(429).json({ 
                error: 'Too many requests',
                retryAfter: this.config.rateLimit.windowMs / 1000
              });
              break;
            case 'challenge_required':
              res.status(402).json({
                error: 'Challenge required',
                challenge: check.challenge
              });
              break;
            default:
              res.status(403).json({ error: 'Request blocked' });
          }
          return;
        }
        
        // Add security headers
        res.setHeader('X-RateLimit-Limit', this.config.rateLimit.maxRequests);
        res.setHeader('X-RateLimit-Remaining', 
          this.config.rateLimit.maxRequests - (this.requestCache.get(`rate:${this.getClientIP(req)}`)?.length || 0)
        );
        res.setHeader('X-RateLimit-Reset', new Date(Date.now() + this.config.rateLimit.windowMs).toISOString());
        
        next();
      } catch (error) {
        this.errorHandler.log(error);
        res.status(500).json({ error: 'Internal server error' });
      }
    };
  }
}

// Export factory function
export function createDDoSProtection(config) {
  return new DDoSProtection(config);
}

export default DDoSProtection;