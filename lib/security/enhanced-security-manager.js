import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import crypto from 'crypto';
import { promisify } from 'util';

export class EnhancedSecurityManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableRateLimiting: options.enableRateLimiting !== false,
      enableDDoSProtection: options.enableDDoSProtection !== false,
      enableEncryption: options.enableEncryption !== false,
      enableIntrustionDetection: options.enableIntrustionDetection !== false,
      enableAuditLogging: options.enableAuditLogging !== false,
      maxConnectionsPerIP: options.maxConnectionsPerIP || 100,
      rateLimitWindow: options.rateLimitWindow || 60000, // 1 minute
      rateLimitMax: options.rateLimitMax || 1000, // requests per window
      ddosThreshold: options.ddosThreshold || 10000, // requests per minute
      encryptionAlgorithm: options.encryptionAlgorithm || 'aes-256-gcm',
      ...options
    };

    this.rateLimiters = new Map();
    this.connectionTracker = new Map();
    this.suspiciousIPs = new Set();
    this.blockedIPs = new Set();
    this.securityEvents = [];
    this.auditLogs = [];
    
    this.stats = {
      totalRequests: 0,
      blockedRequests: 0,
      suspiciousActivities: 0,
      ddosAttempts: 0,
      encryptedMessages: 0,
      securityViolations: 0
    };

    this.threats = {
      // Common attack patterns
      patterns: new Map([
        ['sql_injection', /(\b(union|select|insert|update|delete|drop|create|alter)\b|['\";]|--|\*|\|)/i],
        ['xss', /<script|javascript:|onerror|onload|onclick/i],
        ['command_injection', /(\||&|;|`|\$\(|\${)/],
        ['path_traversal', /\.\.(\/|\\)/],
        ['brute_force', /^(admin|root|test|guest|user)$/i]
      ]),
      
      // Suspicious behavior indicators
      behaviors: {
        rapidRequests: { threshold: 100, window: 10000 }, // 100 requests in 10 seconds
        repeatedFails: { threshold: 10, window: 60000 },   // 10 failed attempts in 1 minute
        largePayload: { threshold: 1024 * 1024 },          // 1MB payload
        unusualPorts: [23, 135, 139, 445, 1433, 3389]     // Common attack ports
      }
    };

    this.initializeSecurityManager();
  }

  async initializeSecurityManager() {
    try {
      await this.setupRateLimiting();
      await this.setupDDoSProtection();
      await this.setupEncryption();
      await this.setupIntrusionDetection();
      await this.setupAuditLogging();
      await this.startSecurityMonitoring();
      
      this.emit('securityManagerInitialized', {
        rateLimiting: this.options.enableRateLimiting,
        ddosProtection: this.options.enableDDoSProtection,
        encryption: this.options.enableEncryption,
        intrusionDetection: this.options.enableIntrustionDetection,
        auditLogging: this.options.enableAuditLogging,
        timestamp: Date.now()
      });
      
      console.log('🔒 Enhanced Security Manager initialized');
    } catch (error) {
      this.emit('securityManagerError', { error: error.message, timestamp: Date.now() });
      throw error;
    }
  }

  async setupRateLimiting() {
    if (!this.options.enableRateLimiting) return;

    this.rateLimit = {
      check: (identifier, limit = this.options.rateLimitMax, window = this.options.rateLimitWindow) => {
        const now = Date.now();
        let limiter = this.rateLimiters.get(identifier);
        
        if (!limiter) {
          limiter = {
            requests: [],
            blocked: 0,
            lastReset: now
          };
          this.rateLimiters.set(identifier, limiter);
        }
        
        // Remove old requests outside the window
        limiter.requests = limiter.requests.filter(timestamp => now - timestamp < window);
        
        // Check if limit exceeded
        if (limiter.requests.length >= limit) {
          limiter.blocked++;
          this.stats.blockedRequests++;
          
          this.emit('rateLimitExceeded', {
            identifier,
            requests: limiter.requests.length,
            limit,
            window,
            timestamp: now
          });
          
          return false;
        }
        
        // Add current request
        limiter.requests.push(now);
        this.stats.totalRequests++;
        
        return true;
      },
      
      getRemainingRequests: (identifier) => {
        const limiter = this.rateLimiters.get(identifier);
        if (!limiter) return this.options.rateLimitMax;
        
        const now = Date.now();
        const validRequests = limiter.requests.filter(timestamp => now - timestamp < this.options.rateLimitWindow);
        return Math.max(0, this.options.rateLimitMax - validRequests.length);
      },
      
      reset: (identifier) => {
        this.rateLimiters.delete(identifier);
      }
    };

    console.log('🚦 Rate limiting system initialized');
  }

  async setupDDoSProtection() {
    if (!this.options.enableDDoSProtection) return;

    this.ddosProtection = {
      check: (ip) => {
        const now = Date.now();
        let tracker = this.connectionTracker.get(ip);
        
        if (!tracker) {
          tracker = {
            connections: 0,
            requests: [],
            firstSeen: now,
            lastActivity: now,
            suspicious: false
          };
          this.connectionTracker.set(ip, tracker);
        }
        
        // Update activity
        tracker.lastActivity = now;
        tracker.requests = tracker.requests.filter(timestamp => now - timestamp < 60000); // 1 minute window
        
        // Check for DDoS patterns
        if (tracker.requests.length > this.options.ddosThreshold) {
          this.handleDDoSDetection(ip, tracker);
          return false;
        }
        
        // Check connection limits
        if (tracker.connections > this.options.maxConnectionsPerIP) {
          this.handleConnectionLimit(ip, tracker);
          return false;
        }
        
        tracker.requests.push(now);
        return true;
      },
      
      trackConnection: (ip) => {
        let tracker = this.connectionTracker.get(ip) || {
          connections: 0,
          requests: [],
          firstSeen: Date.now(),
          lastActivity: Date.now(),
          suspicious: false
        };
        
        tracker.connections++;
        tracker.lastActivity = Date.now();
        this.connectionTracker.set(ip, tracker);
      },
      
      releaseConnection: (ip) => {
        const tracker = this.connectionTracker.get(ip);
        if (tracker && tracker.connections > 0) {
          tracker.connections--;
          tracker.lastActivity = Date.now();
        }
      }
    };

    console.log('🛡️ DDoS protection system initialized');
  }

  handleDDoSDetection(ip, tracker) {
    this.stats.ddosAttempts++;
    this.blockedIPs.add(ip);
    
    this.logSecurityEvent('ddos_detected', {
      ip,
      requestCount: tracker.requests.length,
      threshold: this.options.ddosThreshold,
      firstSeen: tracker.firstSeen,
      severity: 'high'
    });
    
    this.emit('ddosDetected', {
      ip,
      requestCount: tracker.requests.length,
      timestamp: Date.now()
    });
    
    // Auto-unblock after 1 hour
    setTimeout(() => {
      this.blockedIPs.delete(ip);
      this.connectionTracker.delete(ip);
    }, 3600000);
  }

  handleConnectionLimit(ip, tracker) {
    this.suspiciousIPs.add(ip);
    
    this.logSecurityEvent('connection_limit_exceeded', {
      ip,
      connections: tracker.connections,
      limit: this.options.maxConnectionsPerIP,
      severity: 'medium'
    });
    
    this.emit('connectionLimitExceeded', {
      ip,
      connections: tracker.connections,
      timestamp: Date.now()
    });
  }

  async setupEncryption() {
    if (!this.options.enableEncryption) return;

    this.encryption = {
      generateKey: () => {
        return crypto.randomBytes(32); // 256-bit key
      },
      
      generateIV: () => {
        return crypto.randomBytes(16); // 128-bit IV
      },
      
      encrypt: (data, key) => {
        const iv = this.encryption.generateIV();
        const cipher = crypto.createCipher(this.options.encryptionAlgorithm, key);
        cipher.setAAD(Buffer.from('otedama-mining-pool')); // Additional authenticated data
        
        let encrypted = cipher.update(data, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        const authTag = cipher.getAuthTag();
        
        this.stats.encryptedMessages++;
        
        return {
          encrypted,
          iv: iv.toString('hex'),
          authTag: authTag.toString('hex')
        };
      },
      
      decrypt: (encryptedData, key) => {
        const { encrypted, iv, authTag } = encryptedData;
        
        const decipher = crypto.createDecipher(this.options.encryptionAlgorithm, key);
        decipher.setAAD(Buffer.from('otedama-mining-pool'));
        decipher.setAuthTag(Buffer.from(authTag, 'hex'));
        
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
      },
      
      hash: (data, salt) => {
        return crypto.pbkdf2Sync(data, salt || 'otedama-salt', 10000, 64, 'sha512').toString('hex');
      },
      
      generateSecureToken: () => {
        return crypto.randomBytes(32).toString('hex');
      }
    };

    console.log('🔐 Encryption system initialized');
  }

  async setupIntrusionDetection() {
    if (!this.options.enableIntrustionDetection) return;

    this.intrusionDetection = {
      analyze: (request) => {
        const threats = [];
        const { ip, data, headers, method } = request;
        
        // Pattern-based detection
        for (const [threatType, pattern] of this.threats.patterns.entries()) {
          if (pattern.test(data) || (headers && pattern.test(JSON.stringify(headers)))) {
            threats.push({
              type: threatType,
              severity: this.getThreatSeverity(threatType),
              pattern: pattern.source
            });
          }
        }
        
        // Behavioral analysis
        const behavior = this.analyzeBehavior(ip, request);
        if (behavior.suspicious) {
          threats.push({
            type: 'suspicious_behavior',
            severity: 'medium',
            indicators: behavior.indicators
          });
        }
        
        // Log threats
        if (threats.length > 0) {
          this.handleThreatDetection(ip, threats, request);
        }
        
        return threats;
      },
      
      checkPayloadSize: (data) => {
        const size = Buffer.byteLength(data, 'utf8');
        if (size > this.threats.behaviors.largePayload.threshold) {
          return {
            threat: true,
            type: 'large_payload',
            size,
            threshold: this.threats.behaviors.largePayload.threshold
          };
        }
        return { threat: false };
      }
    };

    console.log('👁️ Intrusion detection system initialized');
  }

  analyzeBehavior(ip, request) {
    const tracker = this.connectionTracker.get(ip);
    if (!tracker) return { suspicious: false };
    
    const indicators = [];
    const now = Date.now();
    
    // Rapid requests
    const recentRequests = tracker.requests.filter(timestamp => 
      now - timestamp < this.threats.behaviors.rapidRequests.window
    );
    if (recentRequests.length > this.threats.behaviors.rapidRequests.threshold) {
      indicators.push('rapid_requests');
    }
    
    // Check for port scanning (if port info available)
    if (request.port && this.threats.behaviors.unusualPorts.includes(request.port)) {
      indicators.push('unusual_port');
    }
    
    // Payload analysis
    const payloadCheck = this.intrusionDetection.checkPayloadSize(request.data || '');
    if (payloadCheck.threat) {
      indicators.push('large_payload');
    }
    
    return {
      suspicious: indicators.length > 0,
      indicators,
      score: indicators.length * 0.3 // Simple scoring
    };
  }

  handleThreatDetection(ip, threats, request) {
    this.stats.suspiciousActivities++;
    
    const maxSeverity = Math.max(...threats.map(t => this.getSeverityScore(t.severity)));
    
    if (maxSeverity >= 0.8) { // High severity
      this.blockedIPs.add(ip);
      this.stats.securityViolations++;
    } else if (maxSeverity >= 0.6) { // Medium severity
      this.suspiciousIPs.add(ip);
    }
    
    this.logSecurityEvent('threat_detected', {
      ip,
      threats,
      request: {
        method: request.method,
        size: Buffer.byteLength(request.data || '', 'utf8'),
        headers: Object.keys(request.headers || {})
      },
      severity: this.getSeverityLevel(maxSeverity)
    });
    
    this.emit('threatDetected', {
      ip,
      threats,
      severity: maxSeverity,
      timestamp: Date.now()
    });
  }

  getThreatSeverity(threatType) {
    const severityMap = {
      sql_injection: 'high',
      xss: 'high',
      command_injection: 'critical',
      path_traversal: 'medium',
      brute_force: 'medium',
      suspicious_behavior: 'low'
    };
    return severityMap[threatType] || 'low';
  }

  getSeverityScore(severity) {
    const scoreMap = { low: 0.3, medium: 0.6, high: 0.8, critical: 1.0 };
    return scoreMap[severity] || 0.3;
  }

  getSeverityLevel(score) {
    if (score >= 1.0) return 'critical';
    if (score >= 0.8) return 'high';
    if (score >= 0.6) return 'medium';
    return 'low';
  }

  async setupAuditLogging() {
    if (!this.options.enableAuditLogging) return;

    this.auditLogger = {
      log: (event, data) => {
        const auditEntry = {
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          event,
          data,
          source: 'security_manager'
        };
        
        this.auditLogs.push(auditEntry);
        
        // Keep only recent logs (last 10000)
        if (this.auditLogs.length > 10000) {
          this.auditLogs = this.auditLogs.slice(-10000);
        }
        
        this.emit('auditLog', auditEntry);
      },
      
      search: (criteria) => {
        return this.auditLogs.filter(entry => {
          if (criteria.event && entry.event !== criteria.event) return false;
          if (criteria.ip && entry.data.ip !== criteria.ip) return false;
          if (criteria.timeRange) {
            const entryTime = entry.timestamp;
            if (entryTime < criteria.timeRange.start || entryTime > criteria.timeRange.end) {
              return false;
            }
          }
          return true;
        });
      },
      
      export: (format = 'json') => {
        if (format === 'json') {
          return JSON.stringify(this.auditLogs, null, 2);
        } else if (format === 'csv') {
          const header = 'timestamp,event,ip,severity,details\n';
          const rows = this.auditLogs.map(entry => {
            return `${entry.timestamp},${entry.event},${entry.data.ip || ''},${entry.data.severity || ''},${JSON.stringify(entry.data).replace(/"/g, '""')}`;
          }).join('\n');
          return header + rows;
        }
        return this.auditLogs;
      }
    };

    console.log('📝 Audit logging system initialized');
  }

  logSecurityEvent(event, data) {
    const securityEvent = {
      timestamp: Date.now(),
      event,
      ...data
    };
    
    this.securityEvents.push(securityEvent);
    
    // Keep only recent events
    if (this.securityEvents.length > 1000) {
      this.securityEvents = this.securityEvents.slice(-1000);
    }
    
    if (this.options.enableAuditLogging) {
      this.auditLogger.log(event, data);
    }
  }

  startSecurityMonitoring() {
    // Clean up old rate limiters every 5 minutes
    setInterval(() => {
      this.cleanupRateLimiters();
    }, 300000);
    
    // Clean up connection tracking every 10 minutes
    setInterval(() => {
      this.cleanupConnectionTracking();
    }, 600000);
    
    // Generate security report every hour
    setInterval(() => {
      this.generateSecurityReport();
    }, 3600000);
  }

  cleanupRateLimiters() {
    const now = Date.now();
    
    for (const [identifier, limiter] of this.rateLimiters.entries()) {
      // Remove limiters with no recent activity
      if (now - limiter.lastReset > this.options.rateLimitWindow * 2) {
        this.rateLimiters.delete(identifier);
      } else {
        // Clean up old requests
        limiter.requests = limiter.requests.filter(timestamp => now - timestamp < this.options.rateLimitWindow);
      }
    }
  }

  cleanupConnectionTracking() {
    const now = Date.now();
    const timeout = 3600000; // 1 hour
    
    for (const [ip, tracker] of this.connectionTracker.entries()) {
      if (now - tracker.lastActivity > timeout && tracker.connections === 0) {
        this.connectionTracker.delete(ip);
        this.suspiciousIPs.delete(ip); // Clean up suspicious IPs too
      }
    }
  }

  generateSecurityReport() {
    const report = {
      timestamp: Date.now(),
      period: '1 hour',
      summary: {
        totalRequests: this.stats.totalRequests,
        blockedRequests: this.stats.blockedRequests,
        suspiciousActivities: this.stats.suspiciousActivities,
        ddosAttempts: this.stats.ddosAttempts,
        securityViolations: this.stats.securityViolations
      },
      topThreats: this.getTopThreats(),
      blockedIPs: Array.from(this.blockedIPs),
      suspiciousIPs: Array.from(this.suspiciousIPs)
    };
    
    this.emit('securityReport', report);
    
    if (this.options.enableAuditLogging) {
      this.auditLogger.log('security_report', report);
    }
  }

  getTopThreats() {
    const threatCounts = new Map();
    
    for (const event of this.securityEvents) {
      if (event.threats) {
        for (const threat of event.threats) {
          const count = threatCounts.get(threat.type) || 0;
          threatCounts.set(threat.type, count + 1);
        }
      }
    }
    
    return Array.from(threatCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([type, count]) => ({ type, count }));
  }

  // Public API
  checkSecurity(request) {
    const { ip, data, headers, method, port } = request;
    
    // Check if IP is blocked
    if (this.blockedIPs.has(ip)) {
      return {
        allowed: false,
        reason: 'ip_blocked',
        action: 'block'
      };
    }
    
    // Rate limiting check
    if (this.options.enableRateLimiting && !this.rateLimit.check(ip)) {
      return {
        allowed: false,
        reason: 'rate_limit_exceeded',
        action: 'block'
      };
    }
    
    // DDoS protection check
    if (this.options.enableDDoSProtection && !this.ddosProtection.check(ip)) {
      return {
        allowed: false,
        reason: 'ddos_protection',
        action: 'block'
      };
    }
    
    // Intrusion detection
    if (this.options.enableIntrustionDetection) {
      const threats = this.intrusionDetection.analyze(request);
      if (threats.length > 0) {
        const maxSeverity = Math.max(...threats.map(t => this.getSeverityScore(t.severity)));
        
        if (maxSeverity >= 0.8) {
          return {
            allowed: false,
            reason: 'security_threat',
            threats,
            action: 'block'
          };
        } else if (maxSeverity >= 0.6) {
          return {
            allowed: true,
            reason: 'suspicious_activity',
            threats,
            action: 'monitor'
          };
        }
      }
    }
    
    return {
      allowed: true,
      reason: 'passed_security_checks',
      action: 'allow'
    };
  }

  encryptData(data, key) {
    if (!this.options.enableEncryption) return data;
    return this.encryption.encrypt(data, key);
  }

  decryptData(encryptedData, key) {
    if (!this.options.enableEncryption) return encryptedData;
    return this.encryption.decrypt(encryptedData, key);
  }

  generateSecureHash(data, salt) {
    return this.encryption.hash(data, salt);
  }

  generateSecureToken() {
    return this.encryption.generateSecureToken();
  }

  blockIP(ip, duration = 3600000) { // Default: 1 hour
    this.blockedIPs.add(ip);
    
    this.logSecurityEvent('ip_blocked', {
      ip,
      duration,
      reason: 'manual_block',
      severity: 'medium'
    });
    
    setTimeout(() => {
      this.blockedIPs.delete(ip);
      this.logSecurityEvent('ip_unblocked', { ip, reason: 'timeout' });
    }, duration);
  }

  unblockIP(ip) {
    this.blockedIPs.delete(ip);
    this.suspiciousIPs.delete(ip);
    this.connectionTracker.delete(ip);
    
    this.logSecurityEvent('ip_unblocked', {
      ip,
      reason: 'manual_unblock'
    });
  }

  // Statistics and Monitoring
  getSecurityStats() {
    return {
      ...this.stats,
      rateLimiters: this.rateLimiters.size,
      connectionTrackers: this.connectionTracker.size,
      blockedIPs: this.blockedIPs.size,
      suspiciousIPs: this.suspiciousIPs.size,
      securityEvents: this.securityEvents.length,
      auditLogs: this.auditLogs.length,
      uptime: process.uptime(),
      timestamp: Date.now()
    };
  }

  getSecurityStatus() {
    const stats = this.getSecurityStats();
    const blockRate = stats.totalRequests > 0 ? (stats.blockedRequests / stats.totalRequests) * 100 : 0;
    
    return {
      status: this.determineSecurityStatus(stats),
      blockRate: Math.round(blockRate * 100) / 100,
      threatsDetected: stats.suspiciousActivities,
      activeSessions: stats.connectionTrackers,
      protection: {
        rateLimiting: this.options.enableRateLimiting,
        ddosProtection: this.options.enableDDoSProtection,
        encryption: this.options.enableEncryption,
        intrusionDetection: this.options.enableIntrustionDetection,
        auditLogging: this.options.enableAuditLogging
      },
      timestamp: Date.now()
    };
  }

  determineSecurityStatus(stats) {
    if (stats.ddosAttempts > 10 || stats.securityViolations > 50) {
      return 'critical';
    } else if (stats.suspiciousActivities > 100 || stats.blockedIPs > 100) {
      return 'high';
    } else if (stats.suspiciousActivities > 10) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  async shutdown() {
    this.emit('securityManagerShutdown', { timestamp: Date.now() });
    console.log('🔒 Enhanced Security Manager shutdown complete');
  }
}

export default EnhancedSecurityManager;