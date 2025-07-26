/**
 * Intelligent Threat Detection and Response - Otedama
 * AI-powered security system with automatic threat mitigation
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import crypto from 'crypto';

const logger = createStructuredLogger('ThreatDetector');

// Threat types
export const ThreatType = {
  DDOS: 'ddos',
  BRUTE_FORCE: 'brute_force',
  SQL_INJECTION: 'sql_injection',
  XSS: 'xss',
  MALWARE: 'malware',
  POOL_HOPPING: 'pool_hopping',
  SELFISH_MINING: 'selfish_mining',
  BLOCK_WITHHOLDING: 'block_withholding',
  DOUBLE_SPENDING: 'double_spending',
  SYBIL_ATTACK: 'sybil_attack',
  ECLIPSE_ATTACK: 'eclipse_attack',
  ANOMALY: 'anomaly'
};

// Threat severity levels
export const ThreatSeverity = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4
};

export class ThreatDetector extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Detection thresholds
      requestRateThreshold: options.requestRateThreshold || 1000, // per second
      connectionRateThreshold: options.connectionRateThreshold || 100, // per second
      shareRateThreshold: options.shareRateThreshold || 10000, // per minute
      errorRateThreshold: options.errorRateThreshold || 0.1, // 10%
      
      // Behavior analysis
      anomalyThreshold: options.anomalyThreshold || 3, // standard deviations
      patternWindow: options.patternWindow || 300000, // 5 minutes
      learningPeriod: options.learningPeriod || 86400000, // 24 hours
      
      // Response settings
      autoResponse: options.autoResponse !== false,
      blockDuration: options.blockDuration || 3600000, // 1 hour
      escalationThreshold: options.escalationThreshold || 5, // incidents before escalation
      
      // Machine learning
      mlEnabled: options.mlEnabled !== false,
      modelUpdateInterval: options.modelUpdateInterval || 3600000, // 1 hour
      
      // Features
      behaviorAnalysis: options.behaviorAnalysis !== false,
      patternRecognition: options.patternRecognition !== false,
      predictiveDetection: options.predictiveDetection !== false,
      honeypots: options.honeypots !== false,
      
      ...options
    };
    
    // Threat intelligence
    this.threats = new Map();
    this.blocklist = new Map();
    this.whitelist = new Set();
    this.incidents = [];
    
    // Behavior profiles
    this.profiles = new Map();
    this.patterns = new Map();
    this.baselines = {
      requestRate: 0,
      connectionRate: 0,
      shareRate: 0,
      errorRate: 0
    };
    
    // Detection models
    this.detectionModels = {
      ddos: this.createDDoSDetector(),
      bruteForce: this.createBruteForceDetector(),
      anomaly: this.createAnomalyDetector(),
      poolAttacks: this.createPoolAttackDetector()
    };
    
    // Response strategies
    this.responseStrategies = new Map();
    this.activeResponses = new Map();
    
    // Honeypot data
    this.honeypots = new Map();
    
    // Statistics
    this.stats = {
      threatsDetected: 0,
      threatsBlocked: 0,
      falsePositives: 0,
      incidentsResolved: 0,
      responseTime: 0
    };
    
    // Initialize response strategies
    this.initializeResponseStrategies();
    
    // Timers
    this.analysisTimer = null;
    this.learningTimer = null;
  }
  
  /**
   * Initialize threat detection
   */
  async initialize() {
    logger.info('Initializing threat detection system');
    
    try {
      // Load threat intelligence
      await this.loadThreatIntelligence();
      
      // Initialize baselines
      await this.establishBaselines();
      
      // Setup honeypots if enabled
      if (this.options.honeypots) {
        this.setupHoneypots();
      }
      
      // Start analysis loops
      this.startAnalysis();
      
      logger.info('Threat detection initialized', {
        models: Object.keys(this.detectionModels),
        strategies: this.responseStrategies.size,
        honeypots: this.honeypots.size
      });
      
    } catch (error) {
      logger.error('Failed to initialize threat detection', { error: error.message });
      throw error;
    }
  }
  
  /**
   * Analyze incoming request/connection
   */
  async analyze(context) {
    const startTime = Date.now();
    
    try {
      // Check whitelist
      if (this.isWhitelisted(context.ip)) {
        return { safe: true, whitelisted: true };
      }
      
      // Check blocklist
      if (this.isBlocked(context.ip)) {
        return { 
          safe: false, 
          blocked: true, 
          reason: this.blocklist.get(context.ip).reason 
        };
      }
      
      // Update behavior profile
      this.updateProfile(context);
      
      // Run detection models
      const detectionResults = await this.runDetection(context);
      
      // Analyze results
      const threats = this.analyzeDetectionResults(detectionResults);
      
      // Handle detected threats
      if (threats.length > 0) {
        await this.handleThreats(threats, context);
      }
      
      // Record metrics
      const responseTime = Date.now() - startTime;
      this.stats.responseTime = 
        (this.stats.responseTime * 0.95) + (responseTime * 0.05); // EMA
      
      return {
        safe: threats.length === 0,
        threats,
        responseTime
      };
      
    } catch (error) {
      logger.error('Analysis failed', { error: error.message });
      return { safe: true, error: error.message };
    }
  }
  
  /**
   * Run detection models
   */
  async runDetection(context) {
    const results = {};
    
    // DDoS detection
    results.ddos = await this.detectionModels.ddos(context);
    
    // Brute force detection
    results.bruteForce = await this.detectionModels.bruteForce(context);
    
    // Anomaly detection
    if (this.options.behaviorAnalysis) {
      results.anomaly = await this.detectionModels.anomaly(context);
    }
    
    // Pool-specific attacks
    if (context.type === 'mining') {
      results.poolAttacks = await this.detectionModels.poolAttacks(context);
    }
    
    // Pattern matching
    if (this.options.patternRecognition) {
      results.patterns = this.detectPatterns(context);
    }
    
    // Honeypot checks
    if (this.options.honeypots && this.isHoneypotAccess(context)) {
      results.honeypot = { detected: true, severity: ThreatSeverity.HIGH };
    }
    
    return results;
  }
  
  /**
   * Create DDoS detector
   */
  createDDoSDetector() {
    return async (context) => {
      const profile = this.profiles.get(context.ip) || {};
      const now = Date.now();
      
      // Request rate analysis
      const requestRate = profile.requestRate || 0;
      const connectionRate = profile.connectionRate || 0;
      
      // Check for various DDoS patterns
      const patterns = {
        volumetric: requestRate > this.options.requestRateThreshold,
        connectionFlood: connectionRate > this.options.connectionRateThreshold,
        slowloris: this.detectSlowloris(profile),
        amplification: this.detectAmplification(context),
        httpFlood: this.detectHTTPFlood(profile)
      };
      
      const detected = Object.values(patterns).some(p => p);
      
      if (detected) {
        return {
          detected: true,
          type: ThreatType.DDOS,
          severity: this.calculateDDoSSeverity(patterns, profile),
          patterns,
          confidence: this.calculateConfidence(profile)
        };
      }
      
      return { detected: false };
    };
  }
  
  /**
   * Create brute force detector
   */
  createBruteForceDetector() {
    return async (context) => {
      const profile = this.profiles.get(context.ip) || {};
      
      // Track failed authentication attempts
      if (context.event === 'auth_failed') {
        profile.failedAuths = (profile.failedAuths || 0) + 1;
        profile.lastFailedAuth = Date.now();
      }
      
      // Reset on successful auth
      if (context.event === 'auth_success') {
        profile.failedAuths = 0;
      }
      
      // Check patterns
      const timeWindow = 300000; // 5 minutes
      const recentFailures = profile.failedAuths || 0;
      const timeSinceFirst = Date.now() - (profile.firstFailedAuth || Date.now());
      
      const patterns = {
        rapidAttempts: recentFailures > 10 && timeSinceFirst < timeWindow,
        distributed: this.detectDistributedBruteForce(context),
        credentialStuffing: this.detectCredentialStuffing(profile),
        dictionaryAttack: this.detectDictionaryAttack(profile)
      };
      
      const detected = patterns.rapidAttempts || patterns.distributed;
      
      if (detected) {
        return {
          detected: true,
          type: ThreatType.BRUTE_FORCE,
          severity: recentFailures > 20 ? ThreatSeverity.HIGH : ThreatSeverity.MEDIUM,
          patterns,
          attempts: recentFailures
        };
      }
      
      return { detected: false };
    };
  }
  
  /**
   * Create anomaly detector
   */
  createAnomalyDetector() {
    return async (context) => {
      const profile = this.profiles.get(context.ip) || {};
      const anomalies = [];
      
      // Statistical anomaly detection
      const metrics = {
        requestRate: profile.requestRate || 0,
        shareRate: profile.shareRate || 0,
        errorRate: profile.errorRate || 0,
        packetSize: context.packetSize || 0,
        timing: context.timing || 0
      };
      
      // Compare with baselines
      for (const [metric, value] of Object.entries(metrics)) {
        const baseline = this.baselines[metric] || 0;
        const stdDev = this.getStandardDeviation(metric);
        const zScore = stdDev > 0 ? Math.abs((value - baseline) / stdDev) : 0;
        
        if (zScore > this.options.anomalyThreshold) {
          anomalies.push({
            metric,
            value,
            baseline,
            zScore,
            deviation: ((value - baseline) / baseline * 100).toFixed(2) + '%'
          });
        }
      }
      
      // Behavioral anomalies
      const behaviorAnomalies = this.detectBehaviorAnomalies(profile, context);
      anomalies.push(...behaviorAnomalies);
      
      if (anomalies.length > 0) {
        return {
          detected: true,
          type: ThreatType.ANOMALY,
          severity: this.calculateAnomalySeverity(anomalies),
          anomalies,
          confidence: anomalies.length / 10 // More anomalies = higher confidence
        };
      }
      
      return { detected: false };
    };
  }
  
  /**
   * Create pool attack detector
   */
  createPoolAttackDetector() {
    return async (context) => {
      const profile = this.profiles.get(context.ip) || {};
      const attacks = {};
      
      // Pool hopping detection
      attacks.poolHopping = this.detectPoolHopping(profile, context);
      
      // Selfish mining detection
      attacks.selfishMining = this.detectSelfishMining(profile, context);
      
      // Block withholding detection
      attacks.blockWithholding = this.detectBlockWithholding(profile, context);
      
      // Share manipulation
      attacks.shareManipulation = this.detectShareManipulation(profile, context);
      
      const detected = Object.values(attacks).some(a => a.detected);
      
      if (detected) {
        const detectedAttacks = Object.entries(attacks)
          .filter(([_, a]) => a.detected)
          .map(([type, details]) => ({ type, ...details }));
        
        return {
          detected: true,
          type: ThreatType.POOL_HOPPING,
          severity: ThreatSeverity.HIGH,
          attacks: detectedAttacks
        };
      }
      
      return { detected: false };
    };
  }
  
  /**
   * Detect pool hopping
   */
  detectPoolHopping(profile, context) {
    // Check for sudden connection/disconnection patterns
    const connectionHistory = profile.connectionHistory || [];
    const recentConnections = connectionHistory.filter(c => 
      Date.now() - c.timestamp < 3600000 // Last hour
    );
    
    // Pool hopping indicators
    const indicators = {
      frequentReconnects: recentConnections.length > 10,
      shortSessions: this.getAverageSessionDuration(profile) < 600000, // < 10 min
      roundSwitching: this.detectRoundSwitching(profile),
      profitSeeking: this.detectProfitSeekingBehavior(profile)
    };
    
    const score = Object.values(indicators).filter(Boolean).length;
    
    return {
      detected: score >= 2,
      indicators,
      confidence: score / 4
    };
  }
  
  /**
   * Detect selfish mining
   */
  detectSelfishMining(profile, context) {
    const shareHistory = profile.shareHistory || [];
    const recentShares = shareHistory.filter(s => 
      Date.now() - s.timestamp < 3600000
    );
    
    // Selfish mining patterns
    const patterns = {
      delayedSubmission: this.detectDelayedSubmission(recentShares),
      burstSubmission: this.detectBurstSubmission(recentShares),
      orphanRate: this.calculateOrphanRate(recentShares),
      forkingBehavior: this.detectForkingBehavior(profile)
    };
    
    return {
      detected: patterns.delayedSubmission || patterns.burstSubmission,
      patterns
    };
  }
  
  /**
   * Detect block withholding
   */
  detectBlockWithholding(profile, context) {
    const shares = profile.totalShares || 0;
    const blocks = profile.blocksFound || 0;
    const expectedBlocks = shares / (context.networkDifficulty || 1e12);
    
    // Statistical analysis
    const blockRatio = blocks / (expectedBlocks || 1);
    const isWithholding = shares > 1000000 && blockRatio < 0.5; // Significantly below expected
    
    return {
      detected: isWithholding,
      shares,
      blocksFound: blocks,
      expectedBlocks: expectedBlocks.toFixed(2),
      ratio: blockRatio.toFixed(4)
    };
  }
  
  /**
   * Update behavior profile
   */
  updateProfile(context) {
    const ip = context.ip;
    let profile = this.profiles.get(ip);
    
    if (!profile) {
      profile = {
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        requestCount: 0,
        connectionCount: 0,
        shareCount: 0,
        errorCount: 0,
        requestRate: 0,
        connectionRate: 0,
        shareRate: 0,
        errorRate: 0,
        connectionHistory: [],
        shareHistory: [],
        patterns: new Set()
      };
      this.profiles.set(ip, profile);
    }
    
    // Update counters
    profile.lastSeen = Date.now();
    
    switch (context.type) {
      case 'request':
        profile.requestCount++;
        break;
      case 'connection':
        profile.connectionCount++;
        profile.connectionHistory.push({
          timestamp: Date.now(),
          duration: context.duration
        });
        break;
      case 'share':
        profile.shareCount++;
        profile.shareHistory.push({
          timestamp: Date.now(),
          difficulty: context.difficulty,
          valid: context.valid
        });
        break;
      case 'error':
        profile.errorCount++;
        break;
    }
    
    // Calculate rates (moving average)
    const timeWindow = 60000; // 1 minute
    const alpha = 0.1; // Smoothing factor
    
    profile.requestRate = profile.requestRate * (1 - alpha) + 
      (profile.requestCount / (timeWindow / 1000)) * alpha;
    
    profile.connectionRate = profile.connectionRate * (1 - alpha) + 
      (profile.connectionCount / (timeWindow / 1000)) * alpha;
    
    profile.shareRate = profile.shareRate * (1 - alpha) + 
      (profile.shareCount / (timeWindow / 1000)) * alpha;
    
    if (profile.requestCount > 0) {
      profile.errorRate = profile.errorCount / profile.requestCount;
    }
    
    // Detect patterns
    this.updatePatterns(profile, context);
  }
  
  /**
   * Handle detected threats
   */
  async handleThreats(threats, context) {
    for (const threat of threats) {
      logger.warn('Threat detected', {
        type: threat.type,
        severity: threat.severity,
        ip: context.ip,
        details: threat
      });
      
      this.stats.threatsDetected++;
      
      // Record incident
      const incident = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        threat,
        context,
        status: 'active'
      };
      this.incidents.push(incident);
      
      // Auto-response if enabled
      if (this.options.autoResponse) {
        await this.respondToThreat(threat, context, incident);
      }
      
      // Emit threat event
      this.emit('threat:detected', {
        incident,
        threat,
        context
      });
    }
  }
  
  /**
   * Respond to threat automatically
   */
  async respondToThreat(threat, context, incident) {
    const strategy = this.responseStrategies.get(threat.type);
    
    if (!strategy) {
      logger.warn('No response strategy for threat type', { type: threat.type });
      return;
    }
    
    try {
      const response = await strategy.execute(threat, context, this);
      
      this.activeResponses.set(incident.id, {
        strategy: strategy.name,
        startTime: Date.now(),
        actions: response.actions
      });
      
      incident.response = response;
      incident.status = 'mitigated';
      
      this.stats.threatsBlocked++;
      
      logger.info('Threat response executed', {
        incident: incident.id,
        strategy: strategy.name,
        actions: response.actions
      });
      
      this.emit('threat:mitigated', {
        incident,
        response
      });
      
    } catch (error) {
      logger.error('Threat response failed', {
        incident: incident.id,
        error: error.message
      });
      
      incident.status = 'failed';
      
      this.emit('threat:response:failed', {
        incident,
        error
      });
    }
  }
  
  /**
   * Initialize response strategies
   */
  initializeResponseStrategies() {
    // DDoS response
    this.responseStrategies.set(ThreatType.DDOS, {
      name: 'ddos_mitigation',
      execute: async (threat, context, detector) => {
        const actions = [];
        
        // Block IP
        detector.blockIP(context.ip, threat.severity * 3600000); // 1-4 hours
        actions.push({ type: 'block_ip', ip: context.ip });
        
        // Rate limit
        actions.push({ type: 'rate_limit', limit: 10 });
        
        // Enable challenge (CAPTCHA/PoW)
        if (threat.severity >= ThreatSeverity.HIGH) {
          actions.push({ type: 'enable_challenge' });
        }
        
        // Traffic rerouting
        if (threat.severity === ThreatSeverity.CRITICAL) {
          actions.push({ type: 'reroute_traffic' });
        }
        
        return { actions };
      }
    });
    
    // Brute force response
    this.responseStrategies.set(ThreatType.BRUTE_FORCE, {
      name: 'brute_force_mitigation',
      execute: async (threat, context, detector) => {
        const actions = [];
        
        // Temporary block
        detector.blockIP(context.ip, 3600000); // 1 hour
        actions.push({ type: 'block_ip', ip: context.ip });
        
        // Increase auth complexity
        actions.push({ type: 'increase_auth_complexity' });
        
        // Alert account owner
        if (context.targetAccount) {
          actions.push({ 
            type: 'alert_user', 
            account: context.targetAccount 
          });
        }
        
        return { actions };
      }
    });
    
    // Pool attack response
    this.responseStrategies.set(ThreatType.POOL_HOPPING, {
      name: 'pool_attack_mitigation',
      execute: async (threat, context, detector) => {
        const actions = [];
        
        // Adjust share difficulty
        actions.push({ 
          type: 'adjust_difficulty', 
          factor: 2.0 
        });
        
        // Delay payouts
        actions.push({ 
          type: 'delay_payouts', 
          duration: 86400000 // 24 hours
        });
        
        // Mark suspicious
        detector.markSuspicious(context.ip);
        actions.push({ type: 'mark_suspicious' });
        
        return { actions };
      }
    });
    
    // Anomaly response
    this.responseStrategies.set(ThreatType.ANOMALY, {
      name: 'anomaly_mitigation',
      execute: async (threat, context, detector) => {
        const actions = [];
        
        // Enhanced monitoring
        actions.push({ type: 'enhance_monitoring' });
        
        // Sandbox if high severity
        if (threat.severity >= ThreatSeverity.HIGH) {
          actions.push({ type: 'sandbox_traffic' });
        }
        
        // Collect forensics
        actions.push({ type: 'collect_forensics' });
        
        return { actions };
      }
    });
  }
  
  /**
   * Block IP address
   */
  blockIP(ip, duration = this.options.blockDuration) {
    const expiry = Date.now() + duration;
    
    this.blocklist.set(ip, {
      reason: 'threat_detected',
      blockedAt: Date.now(),
      expiresAt: expiry,
      permanent: false
    });
    
    logger.info('IP blocked', {
      ip,
      duration,
      expiry: new Date(expiry).toISOString()
    });
    
    this.emit('ip:blocked', { ip, duration, expiry });
  }
  
  /**
   * Check if IP is blocked
   */
  isBlocked(ip) {
    const entry = this.blocklist.get(ip);
    
    if (!entry) return false;
    
    if (!entry.permanent && Date.now() > entry.expiresAt) {
      this.blocklist.delete(ip);
      return false;
    }
    
    return true;
  }
  
  /**
   * Check if IP is whitelisted
   */
  isWhitelisted(ip) {
    return this.whitelist.has(ip);
  }
  
  /**
   * Add IP to whitelist
   */
  addToWhitelist(ip) {
    this.whitelist.add(ip);
    logger.info('IP whitelisted', { ip });
  }
  
  /**
   * Setup honeypots
   */
  setupHoneypots() {
    // Create fake endpoints
    const honeypotEndpoints = [
      '/admin',
      '/wp-admin',
      '/.env',
      '/config.json',
      '/backup.sql',
      '/private/keys',
      '/api/v0/debug'
    ];
    
    honeypotEndpoints.forEach(endpoint => {
      this.honeypots.set(endpoint, {
        created: Date.now(),
        accesses: []
      });
    });
    
    // Create fake mining addresses
    const honeypotAddresses = [
      '1HoneyPot1234567890123456789012345',
      '3FakeMinerAddress111111111111111111'
    ];
    
    honeypotAddresses.forEach(address => {
      this.honeypots.set(address, {
        type: 'mining_address',
        created: Date.now(),
        attempts: []
      });
    });
    
    logger.info('Honeypots deployed', {
      endpoints: honeypotEndpoints.length,
      addresses: honeypotAddresses.length
    });
  }
  
  /**
   * Check if honeypot access
   */
  isHoneypotAccess(context) {
    const honeypot = this.honeypots.get(context.path || context.address);
    
    if (honeypot) {
      honeypot.accesses = honeypot.accesses || [];
      honeypot.accesses.push({
        ip: context.ip,
        timestamp: Date.now(),
        userAgent: context.userAgent
      });
      
      logger.warn('Honeypot accessed', {
        honeypot: context.path || context.address,
        ip: context.ip
      });
      
      return true;
    }
    
    return false;
  }
  
  /**
   * Get threat intelligence report
   */
  getThreatIntelligence() {
    const report = {
      summary: {
        totalThreats: this.stats.threatsDetected,
        activeIncidents: this.incidents.filter(i => i.status === 'active').length,
        blockedIPs: this.blocklist.size,
        whitelistedIPs: this.whitelist.size
      },
      
      threatsByType: {},
      recentIncidents: this.incidents.slice(-10),
      topThreats: this.getTopThreats(),
      
      recommendations: this.getSecurityRecommendations()
    };
    
    // Count threats by type
    this.incidents.forEach(incident => {
      const type = incident.threat.type;
      report.threatsByType[type] = (report.threatsByType[type] || 0) + 1;
    });
    
    return report;
  }
  
  /**
   * Get top threats
   */
  getTopThreats() {
    const ipCounts = new Map();
    
    this.incidents.forEach(incident => {
      const ip = incident.context.ip;
      ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
    });
    
    return Array.from(ipCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([ip, count]) => ({ ip, incidents: count }));
  }
  
  /**
   * Get security recommendations
   */
  getSecurityRecommendations() {
    const recommendations = [];
    
    // Check threat trends
    const recentThreats = this.incidents.filter(i => 
      Date.now() - i.timestamp < 3600000
    ).length;
    
    if (recentThreats > 100) {
      recommendations.push({
        priority: 'high',
        type: 'threat_spike',
        message: 'Significant increase in threats detected',
        action: 'Review security posture and consider stricter policies'
      });
    }
    
    // Check specific attack types
    const ddosCount = this.incidents.filter(i => 
      i.threat.type === ThreatType.DDOS
    ).length;
    
    if (ddosCount > 10) {
      recommendations.push({
        priority: 'high',
        type: 'ddos_risk',
        message: 'Multiple DDoS attempts detected',
        action: 'Consider implementing CDN or DDoS protection service'
      });
    }
    
    return recommendations;
  }
  
  // Helper methods for detection
  
  detectSlowloris(profile) {
    const connections = profile.connectionHistory || [];
    const longConnections = connections.filter(c => c.duration > 300000); // > 5 min
    return longConnections.length > 5;
  }
  
  detectAmplification(context) {
    return context.responseSize > context.requestSize * 10;
  }
  
  detectHTTPFlood(profile) {
    return profile.requestRate > 1000 && profile.errorRate < 0.01;
  }
  
  detectDistributedBruteForce(context) {
    // Check for coordinated attacks from multiple IPs
    const subnet = context.ip.split('.').slice(0, 3).join('.');
    const subnetProfiles = Array.from(this.profiles.entries())
      .filter(([ip]) => ip.startsWith(subnet))
      .map(([_, profile]) => profile);
    
    const failedAuths = subnetProfiles.reduce((sum, p) => 
      sum + (p.failedAuths || 0), 0
    );
    
    return failedAuths > 100;
  }
  
  detectCredentialStuffing(profile) {
    // Look for patterns indicating automated credential testing
    const authHistory = profile.authHistory || [];
    const uniquePasswords = new Set(authHistory.map(a => a.passwordHash));
    return uniquePasswords.size > 50;
  }
  
  detectDictionaryAttack(profile) {
    // Check for common password patterns
    const authHistory = profile.authHistory || [];
    const commonPatterns = ['123', 'password', 'admin', 'test'];
    
    const patternMatches = authHistory.filter(a => 
      commonPatterns.some(p => a.username?.includes(p))
    );
    
    return patternMatches.length > 10;
  }
  
  detectBehaviorAnomalies(profile, context) {
    const anomalies = [];
    
    // Sudden behavior change
    if (profile.requestRate > profile.avgRequestRate * 10) {
      anomalies.push({
        type: 'sudden_spike',
        metric: 'request_rate',
        factor: profile.requestRate / profile.avgRequestRate
      });
    }
    
    // Unusual timing
    const hour = new Date().getHours();
    if (profile.activeHours && !profile.activeHours.includes(hour)) {
      anomalies.push({
        type: 'unusual_timing',
        hour,
        expected: profile.activeHours
      });
    }
    
    return anomalies;
  }
  
  detectPatterns(context) {
    const patterns = [];
    
    // Check for known attack signatures
    const signatures = {
      sqlInjection: /(\bor\b|\band\b).*=.*(\bor\b|\band\b)/i,
      xss: /<script|javascript:|onerror=/i,
      pathTraversal: /\.\.[\/\\]/,
      commandInjection: /[;&|`]|\$\(/
    };
    
    const payload = context.payload || context.path || '';
    
    for (const [attack, regex] of Object.entries(signatures)) {
      if (regex.test(payload)) {
        patterns.push({
          type: attack,
          matched: true,
          confidence: 0.9
        });
      }
    }
    
    return patterns;
  }
  
  detectRoundSwitching(profile) {
    const connections = profile.connectionHistory || [];
    const roundChanges = connections.filter((c, i) => 
      i > 0 && Math.abs(c.timestamp - connections[i-1].timestamp - 600000) < 60000
    );
    
    return roundChanges.length > 5;
  }
  
  detectProfitSeekingBehavior(profile) {
    // Check if miner connects during high profitability periods
    const shareHistory = profile.shareHistory || [];
    const profitableShares = shareHistory.filter(s => s.value > s.difficulty * 1.2);
    
    return profitableShares.length / shareHistory.length > 0.8;
  }
  
  detectDelayedSubmission(shares) {
    const delays = shares.map((s, i) => 
      i > 0 ? s.timestamp - shares[i-1].timestamp : 0
    ).filter(d => d > 0);
    
    const avgDelay = delays.reduce((a, b) => a + b, 0) / delays.length;
    return avgDelay > 60000; // > 1 minute average
  }
  
  detectBurstSubmission(shares) {
    const bursts = [];
    let currentBurst = [];
    
    shares.forEach((share, i) => {
      if (i === 0 || share.timestamp - shares[i-1].timestamp < 1000) {
        currentBurst.push(share);
      } else {
        if (currentBurst.length > 5) {
          bursts.push(currentBurst);
        }
        currentBurst = [share];
      }
    });
    
    return bursts.length > 3;
  }
  
  calculateOrphanRate(shares) {
    const orphaned = shares.filter(s => s.orphaned).length;
    return shares.length > 0 ? orphaned / shares.length : 0;
  }
  
  detectForkingBehavior(profile) {
    // Check for patterns indicating intentional forking
    return profile.forkCount > 5;
  }
  
  detectShareManipulation(profile, context) {
    const shares = profile.shareHistory || [];
    const validShares = shares.filter(s => s.valid);
    const shareRate = validShares.length / shares.length;
    
    return {
      detected: shareRate < 0.8 && shares.length > 100,
      shareRate,
      totalShares: shares.length
    };
  }
  
  getAverageSessionDuration(profile) {
    const connections = profile.connectionHistory || [];
    if (connections.length === 0) return 0;
    
    const durations = connections.map(c => c.duration || 0);
    return durations.reduce((a, b) => a + b, 0) / durations.length;
  }
  
  calculateDDoSSeverity(patterns, profile) {
    let severity = ThreatSeverity.LOW;
    
    const activePatterns = Object.values(patterns).filter(Boolean).length;
    
    if (activePatterns >= 3) severity = ThreatSeverity.CRITICAL;
    else if (activePatterns >= 2) severity = ThreatSeverity.HIGH;
    else if (profile.requestRate > this.options.requestRateThreshold * 2) {
      severity = ThreatSeverity.HIGH;
    }
    
    return severity;
  }
  
  calculateAnomalySeverity(anomalies) {
    const maxZScore = Math.max(...anomalies.map(a => a.zScore || 0));
    
    if (maxZScore > 5) return ThreatSeverity.HIGH;
    if (maxZScore > 4) return ThreatSeverity.MEDIUM;
    return ThreatSeverity.LOW;
  }
  
  calculateConfidence(profile) {
    // Base confidence on data quality and history
    const dataPoints = profile.requestCount + profile.connectionCount + profile.shareCount;
    const timeSpan = Date.now() - profile.firstSeen;
    
    const dataConfidence = Math.min(dataPoints / 1000, 1);
    const timeConfidence = Math.min(timeSpan / 3600000, 1); // 1 hour
    
    return (dataConfidence + timeConfidence) / 2;
  }
  
  analyzeDetectionResults(results) {
    const threats = [];
    
    for (const [detector, result] of Object.entries(results)) {
      if (result && result.detected) {
        threats.push({
          detector,
          ...result
        });
      }
    }
    
    // Sort by severity
    threats.sort((a, b) => (b.severity || 0) - (a.severity || 0));
    
    return threats;
  }
  
  updatePatterns(profile, context) {
    // Track behavior patterns
    const patterns = profile.patterns || new Set();
    
    // Time-based patterns
    const hour = new Date().getHours();
    patterns.add(`hour_${hour}`);
    
    const dayOfWeek = new Date().getDay();
    patterns.add(`day_${dayOfWeek}`);
    
    // Activity patterns
    if (context.type === 'share' && context.valid) {
      patterns.add('valid_shares');
    }
    
    profile.patterns = patterns;
  }
  
  markSuspicious(ip) {
    const profile = this.profiles.get(ip);
    if (profile) {
      profile.suspicious = true;
      profile.suspiciousReason = 'threat_detected';
    }
  }
  
  getStandardDeviation(metric) {
    // Simplified - in production use proper statistical methods
    return this.baselines[metric] * 0.2;
  }
  
  establishBaselines() {
    // Initialize with reasonable defaults
    this.baselines = {
      requestRate: 10,
      connectionRate: 1,
      shareRate: 100,
      errorRate: 0.01
    };
  }
  
  loadThreatIntelligence() {
    // Load known bad IPs, patterns, etc.
    // This would connect to threat intelligence feeds in production
  }
  
  startAnalysis() {
    this.analysisTimer = setInterval(() => {
      this.performPeriodicAnalysis();
    }, 60000); // Every minute
    
    if (this.options.mlEnabled) {
      this.learningTimer = setInterval(() => {
        this.updateModels();
      }, this.options.modelUpdateInterval);
    }
  }
  
  performPeriodicAnalysis() {
    // Clean old data
    const cutoff = Date.now() - 86400000; // 24 hours
    
    // Clean profiles
    for (const [ip, profile] of this.profiles) {
      if (profile.lastSeen < cutoff) {
        this.profiles.delete(ip);
      }
    }
    
    // Clean incidents
    this.incidents = this.incidents.filter(i => i.timestamp > cutoff);
    
    // Update baselines
    this.updateBaselines();
  }
  
  updateBaselines() {
    // Calculate new baselines from recent data
    const profiles = Array.from(this.profiles.values());
    
    if (profiles.length > 0) {
      this.baselines.requestRate = 
        profiles.reduce((sum, p) => sum + p.requestRate, 0) / profiles.length;
      
      this.baselines.connectionRate = 
        profiles.reduce((sum, p) => sum + p.connectionRate, 0) / profiles.length;
      
      this.baselines.shareRate = 
        profiles.reduce((sum, p) => sum + p.shareRate, 0) / profiles.length;
      
      this.baselines.errorRate = 
        profiles.reduce((sum, p) => sum + p.errorRate, 0) / profiles.length;
    }
  }
  
  updateModels() {
    // Update ML models with recent data
    // This would involve retraining or fine-tuning in production
    logger.debug('Updating threat detection models');
  }
  
  /**
   * Get status
   */
  getStatus() {
    return {
      stats: this.stats,
      threats: {
        active: this.incidents.filter(i => i.status === 'active').length,
        mitigated: this.incidents.filter(i => i.status === 'mitigated').length,
        total: this.incidents.length
      },
      blocklist: this.blocklist.size,
      whitelist: this.whitelist.size,
      profiles: this.profiles.size,
      baselines: this.baselines
    };
  }
  
  /**
   * Shutdown threat detector
   */
  shutdown() {
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
    }
    
    if (this.learningTimer) {
      clearInterval(this.learningTimer);
    }
    
    logger.info('Threat detector shutdown', this.stats);
  }
}

export default ThreatDetector;