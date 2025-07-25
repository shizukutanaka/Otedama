/**
 * Real-time Security Monitor
 * Continuous monitoring and incident response system
 * 
 * Design principles:
 * - Pattern recognition for anomaly detection (Carmack)
 * - Modular incident response system (Martin)
 * - Simple alert prioritization (Pike)
 */

const { EventEmitter } = require('events');
const { createHash } = require('crypto');
const { performance } = require('perf_hooks');
const { createLogger } = require('../../core/logger');

const logger = createLogger('SecurityMonitor');

// Threat levels
const THREAT_LEVELS = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4
};

// Attack patterns
const ATTACK_PATTERNS = {
  BRUTE_FORCE: {
    name: 'Brute Force Attack',
    threshold: 10, // Failed attempts
    window: 60000, // 1 minute
    level: THREAT_LEVELS.HIGH
  },
  DDOS: {
    name: 'DDoS Attack',
    threshold: 1000, // Requests
    window: 10000, // 10 seconds
    level: THREAT_LEVELS.CRITICAL
  },
  SQL_INJECTION: {
    name: 'SQL Injection Attempt',
    patterns: [/union.*select/i, /drop.*table/i, /exec.*xp_/i],
    level: THREAT_LEVELS.HIGH
  },
  XSS: {
    name: 'Cross-Site Scripting',
    patterns: [/<script.*>/i, /javascript:/i, /onerror=/i],
    level: THREAT_LEVELS.MEDIUM
  },
  PATH_TRAVERSAL: {
    name: 'Path Traversal',
    patterns: [/\.\.\//g, /\.\.\\/, /%2e%2e/i],
    level: THREAT_LEVELS.HIGH
  },
  SMART_CONTRACT_EXPLOIT: {
    name: 'Smart Contract Exploit',
    patterns: ['reentrancy', 'overflow', 'underflow'],
    level: THREAT_LEVELS.CRITICAL
  }
};

// Response actions
const RESPONSE_ACTIONS = {
  LOG: 'log',
  ALERT: 'alert',
  BLOCK: 'block',
  THROTTLE: 'throttle',
  CAPTCHA: 'captcha',
  LOCKDOWN: 'lockdown'
};

class RealTimeSecurityMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Monitoring settings
      enableRealTimeScanning: options.enableRealTimeScanning !== false,
      scanInterval: options.scanInterval || 100, // 100ms
      
      // Detection thresholds
      anomalyThreshold: options.anomalyThreshold || 3, // Standard deviations
      patternMatchConfidence: options.patternMatchConfidence || 0.8,
      
      // Response settings
      autoResponse: options.autoResponse !== false,
      responseDelay: options.responseDelay || 0, // Immediate
      escalationEnabled: options.escalationEnabled !== false,
      
      // Storage
      eventRetention: options.eventRetention || 86400000, // 24 hours
      maxEvents: options.maxEvents || 100000,
      
      ...options
    };
    
    // State
    this.events = [];
    this.incidents = new Map();
    this.blockedIPs = new Set();
    this.userActivity = new Map();
    this.systemBaseline = null;
    
    // Metrics
    this.metrics = {
      eventsProcessed: 0,
      threatsDetected: 0,
      incidentsCreated: 0,
      actionsExecuted: 0,
      falsePositives: 0
    };
    
    // Machine learning model (simplified)
    this.mlModel = {
      patterns: new Map(),
      weights: new Map()
    };
    
    // Start monitoring
    if (this.options.enableRealTimeScanning) {
      this.startRealTimeScanning();
    }
  }
  
  /**
   * Process security event
   */
  async processEvent(event) {
    const enrichedEvent = this.enrichEvent(event);
    
    // Store event
    this.storeEvent(enrichedEvent);
    
    // Real-time analysis
    const threats = await this.analyzeEvent(enrichedEvent);
    
    if (threats.length > 0) {
      // Create or update incident
      const incident = this.createIncident(enrichedEvent, threats);
      
      // Determine response
      const response = this.determineResponse(incident);
      
      // Execute response
      if (this.options.autoResponse) {
        await this.executeResponse(response);
      }
      
      // Emit alerts
      this.emitAlerts(incident, response);
    }
    
    // Update metrics
    this.metrics.eventsProcessed++;
    
    return {
      eventId: enrichedEvent.id,
      threats,
      processed: true
    };
  }
  
  /**
   * Enrich event with context
   */
  enrichEvent(event) {
    return {
      ...event,
      id: this.generateEventId(),
      timestamp: event.timestamp || Date.now(),
      enrichedAt: Date.now(),
      
      // Add context
      userContext: this.getUserContext(event.userId),
      systemContext: this.getSystemContext(),
      geoLocation: this.getGeoLocation(event.ip),
      
      // Risk scoring
      riskScore: this.calculateRiskScore(event)
    };
  }
  
  /**
   * Analyze event for threats
   */
  async analyzeEvent(event) {
    const threats = [];
    
    // Pattern matching
    const patternThreats = this.detectPatterns(event);
    threats.push(...patternThreats);
    
    // Anomaly detection
    const anomalies = this.detectAnomalies(event);
    threats.push(...anomalies);
    
    // Behavioral analysis
    const behavioralThreats = this.analyzeBehavior(event);
    threats.push(...behavioralThreats);
    
    // Machine learning detection
    const mlThreats = await this.mlDetection(event);
    threats.push(...mlThreats);
    
    // Deduplicate and prioritize
    return this.prioritizeThreats(threats);
  }
  
  /**
   * Detect pattern-based threats
   */
  detectPatterns(event) {
    const threats = [];
    
    // Check request patterns
    if (event.type === 'http_request') {
      // SQL Injection
      const sqlPatterns = ATTACK_PATTERNS.SQL_INJECTION.patterns;
      for (const pattern of sqlPatterns) {
        if (pattern.test(event.data.url) || pattern.test(event.data.body)) {
          threats.push({
            type: 'SQL_INJECTION',
            confidence: 0.9,
            level: ATTACK_PATTERNS.SQL_INJECTION.level,
            details: 'SQL injection pattern detected',
            evidence: event.data
          });
        }
      }
      
      // XSS
      const xssPatterns = ATTACK_PATTERNS.XSS.patterns;
      for (const pattern of xssPatterns) {
        if (pattern.test(event.data.body) || pattern.test(event.data.headers)) {
          threats.push({
            type: 'XSS',
            confidence: 0.85,
            level: ATTACK_PATTERNS.XSS.level,
            details: 'XSS pattern detected',
            evidence: event.data
          });
        }
      }
    }
    
    // Check authentication patterns
    if (event.type === 'auth_failure') {
      const userActivity = this.userActivity.get(event.userId) || { failures: [] };
      userActivity.failures.push(event.timestamp);
      
      // Clean old failures
      const window = ATTACK_PATTERNS.BRUTE_FORCE.window;
      userActivity.failures = userActivity.failures.filter(
        t => t > Date.now() - window
      );
      
      if (userActivity.failures.length >= ATTACK_PATTERNS.BRUTE_FORCE.threshold) {
        threats.push({
          type: 'BRUTE_FORCE',
          confidence: 0.95,
          level: ATTACK_PATTERNS.BRUTE_FORCE.level,
          details: `${userActivity.failures.length} failed attempts in window`,
          evidence: { attempts: userActivity.failures }
        });
      }
      
      this.userActivity.set(event.userId, userActivity);
    }
    
    // Check rate patterns
    if (event.type === 'request') {
      const ipActivity = this.getIPActivity(event.ip);
      
      if (ipActivity.requestCount > ATTACK_PATTERNS.DDOS.threshold) {
        threats.push({
          type: 'DDOS',
          confidence: 0.8,
          level: ATTACK_PATTERNS.DDOS.level,
          details: `${ipActivity.requestCount} requests from IP`,
          evidence: { ip: event.ip, count: ipActivity.requestCount }
        });
      }
    }
    
    return threats;
  }
  
  /**
   * Detect anomalies
   */
  detectAnomalies(event) {
    const anomalies = [];
    
    if (!this.systemBaseline) {
      this.updateBaseline();
      return anomalies;
    }
    
    // Request rate anomaly
    if (event.type === 'request') {
      const currentRate = this.getCurrentRequestRate();
      const baselineRate = this.systemBaseline.avgRequestRate;
      const stdDev = this.systemBaseline.requestRateStdDev;
      
      const deviation = Math.abs(currentRate - baselineRate) / stdDev;
      
      if (deviation > this.options.anomalyThreshold) {
        anomalies.push({
          type: 'RATE_ANOMALY',
          confidence: Math.min(0.9, deviation / 10),
          level: deviation > 5 ? THREAT_LEVELS.HIGH : THREAT_LEVELS.MEDIUM,
          details: `Request rate ${deviation.toFixed(2)} standard deviations from baseline`,
          evidence: { currentRate, baselineRate, deviation }
        });
      }
    }
    
    // Response time anomaly
    if (event.responseTime) {
      const baselineTime = this.systemBaseline.avgResponseTime;
      const deviation = event.responseTime / baselineTime;
      
      if (deviation > 3) {
        anomalies.push({
          type: 'PERFORMANCE_ANOMALY',
          confidence: 0.7,
          level: THREAT_LEVELS.LOW,
          details: `Response time ${deviation.toFixed(2)}x slower than baseline`,
          evidence: { responseTime: event.responseTime, baseline: baselineTime }
        });
      }
    }
    
    // Error rate anomaly
    if (event.type === 'error') {
      const errorRate = this.getCurrentErrorRate();
      const baselineError = this.systemBaseline.avgErrorRate;
      
      if (errorRate > baselineError * 2) {
        anomalies.push({
          type: 'ERROR_SPIKE',
          confidence: 0.8,
          level: THREAT_LEVELS.MEDIUM,
          details: `Error rate ${(errorRate / baselineError).toFixed(2)}x higher than baseline`,
          evidence: { errorRate, baseline: baselineError }
        });
      }
    }
    
    return anomalies;
  }
  
  /**
   * Analyze user behavior
   */
  analyzeBehavior(event) {
    const threats = [];
    
    if (!event.userId) return threats;
    
    const userProfile = this.getUserProfile(event.userId);
    
    // Unusual access time
    const hour = new Date(event.timestamp).getHours();
    if (!userProfile.normalHours.includes(hour)) {
      threats.push({
        type: 'UNUSUAL_ACCESS_TIME',
        confidence: 0.6,
        level: THREAT_LEVELS.LOW,
        details: `Access at unusual hour: ${hour}`,
        evidence: { hour, normalHours: userProfile.normalHours }
      });
    }
    
    // Unusual location
    if (event.geoLocation && userProfile.locations.length > 0) {
      const isKnownLocation = userProfile.locations.some(
        loc => this.calculateDistance(loc, event.geoLocation) < 100 // 100km
      );
      
      if (!isKnownLocation) {
        threats.push({
          type: 'UNUSUAL_LOCATION',
          confidence: 0.7,
          level: THREAT_LEVELS.MEDIUM,
          details: 'Access from unusual location',
          evidence: { location: event.geoLocation, knownLocations: userProfile.locations }
        });
      }
    }
    
    // Privilege escalation attempt
    if (event.type === 'permission_change' && event.data.newPermissions) {
      const currentPerms = userProfile.permissions || [];
      const newPerms = event.data.newPermissions;
      
      const escalated = newPerms.some(p => !currentPerms.includes(p));
      
      if (escalated) {
        threats.push({
          type: 'PRIVILEGE_ESCALATION',
          confidence: 0.9,
          level: THREAT_LEVELS.HIGH,
          details: 'Attempted privilege escalation',
          evidence: { current: currentPerms, requested: newPerms }
        });
      }
    }
    
    return threats;
  }
  
  /**
   * Machine learning detection
   */
  async mlDetection(event) {
    const threats = [];
    
    // Extract features
    const features = this.extractFeatures(event);
    
    // Score against known patterns
    for (const [patternId, pattern] of this.mlModel.patterns) {
      const similarity = this.calculateSimilarity(features, pattern.features);
      
      if (similarity > this.options.patternMatchConfidence) {
        threats.push({
          type: 'ML_DETECTED_THREAT',
          subtype: pattern.type,
          confidence: similarity,
          level: pattern.level || THREAT_LEVELS.MEDIUM,
          details: `ML model detected ${pattern.name} pattern`,
          evidence: { similarity, patternId }
        });
      }
    }
    
    // Update model with new patterns
    if (threats.length === 0 && event.riskScore > 0.7) {
      this.updateMLModel(features, event);
    }
    
    return threats;
  }
  
  /**
   * Create incident from threats
   */
  createIncident(event, threats) {
    // Find highest threat level
    const maxLevel = Math.max(...threats.map(t => t.level));
    
    // Generate incident ID
    const incidentId = this.generateIncidentId();
    
    // Check for existing incident
    const existingIncident = this.findRelatedIncident(event, threats);
    
    if (existingIncident) {
      // Update existing incident
      existingIncident.events.push(event);
      existingIncident.threats.push(...threats);
      existingIncident.lastUpdated = Date.now();
      existingIncident.severity = Math.max(existingIncident.severity, maxLevel);
      
      return existingIncident;
    }
    
    // Create new incident
    const incident = {
      id: incidentId,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      status: 'active',
      severity: maxLevel,
      
      events: [event],
      threats,
      
      affectedUsers: event.userId ? [event.userId] : [],
      affectedSystems: event.system ? [event.system] : [],
      
      timeline: [{
        timestamp: Date.now(),
        action: 'incident_created',
        details: `Incident created from ${threats.length} threats`
      }]
    };
    
    this.incidents.set(incidentId, incident);
    this.metrics.incidentsCreated++;
    
    return incident;
  }
  
  /**
   * Determine response actions
   */
  determineResponse(incident) {
    const actions = [];
    
    // Always log
    actions.push({
      type: RESPONSE_ACTIONS.LOG,
      priority: 1,
      details: 'Log incident details'
    });
    
    // Severity-based responses
    switch (incident.severity) {
      case THREAT_LEVELS.CRITICAL:
        actions.push({
          type: RESPONSE_ACTIONS.LOCKDOWN,
          priority: 10,
          details: 'Initiate system lockdown'
        });
        actions.push({
          type: RESPONSE_ACTIONS.ALERT,
          priority: 9,
          channels: ['email', 'sms', 'slack'],
          details: 'Send critical alerts to security team'
        });
        break;
        
      case THREAT_LEVELS.HIGH:
        actions.push({
          type: RESPONSE_ACTIONS.BLOCK,
          priority: 8,
          targets: incident.threats.map(t => t.evidence?.ip).filter(Boolean),
          details: 'Block suspicious IPs'
        });
        actions.push({
          type: RESPONSE_ACTIONS.ALERT,
          priority: 7,
          channels: ['email', 'slack'],
          details: 'Alert security team'
        });
        break;
        
      case THREAT_LEVELS.MEDIUM:
        actions.push({
          type: RESPONSE_ACTIONS.THROTTLE,
          priority: 6,
          targets: incident.affectedUsers,
          details: 'Apply rate limiting'
        });
        actions.push({
          type: RESPONSE_ACTIONS.CAPTCHA,
          priority: 5,
          targets: incident.affectedUsers,
          details: 'Require CAPTCHA verification'
        });
        break;
        
      case THREAT_LEVELS.LOW:
        // Just logging and monitoring
        break;
    }
    
    // Sort by priority
    actions.sort((a, b) => b.priority - a.priority);
    
    return {
      incidentId: incident.id,
      actions,
      executionTime: Date.now()
    };
  }
  
  /**
   * Execute response actions
   */
  async executeResponse(response) {
    for (const action of response.actions) {
      try {
        switch (action.type) {
          case RESPONSE_ACTIONS.BLOCK:
            await this.executeBlock(action);
            break;
            
          case RESPONSE_ACTIONS.THROTTLE:
            await this.executeThrottle(action);
            break;
            
          case RESPONSE_ACTIONS.CAPTCHA:
            await this.executeCaptcha(action);
            break;
            
          case RESPONSE_ACTIONS.ALERT:
            await this.executeAlert(action);
            break;
            
          case RESPONSE_ACTIONS.LOCKDOWN:
            await this.executeLockdown(action);
            break;
            
          case RESPONSE_ACTIONS.LOG:
            await this.executeLog(action);
            break;
        }
        
        this.metrics.actionsExecuted++;
        
        // Update incident timeline
        const incident = this.incidents.get(response.incidentId);
        if (incident) {
          incident.timeline.push({
            timestamp: Date.now(),
            action: action.type,
            status: 'executed',
            details: action.details
          });
        }
        
      } catch (error) {
        logger.error(`Failed to execute ${action.type}:`, error);
      }
    }
  }
  
  /**
   * Execute block action
   */
  async executeBlock(action) {
    for (const target of action.targets || []) {
      this.blockedIPs.add(target);
      
      this.emit('security:block', {
        type: 'ip',
        target,
        reason: action.details
      });
    }
  }
  
  /**
   * Execute throttle action
   */
  async executeThrottle(action) {
    this.emit('security:throttle', {
      targets: action.targets,
      limit: 10, // Requests per minute
      duration: 300000, // 5 minutes
      reason: action.details
    });
  }
  
  /**
   * Execute CAPTCHA action
   */
  async executeCaptcha(action) {
    this.emit('security:captcha', {
      targets: action.targets,
      duration: 3600000, // 1 hour
      reason: action.details
    });
  }
  
  /**
   * Execute alert action
   */
  async executeAlert(action) {
    this.emit('security:alert', {
      channels: action.channels,
      priority: action.priority,
      message: action.details,
      timestamp: Date.now()
    });
  }
  
  /**
   * Execute lockdown action
   */
  async executeLockdown(action) {
    logger.warn('SYSTEM LOCKDOWN INITIATED');
    
    this.emit('security:lockdown', {
      reason: action.details,
      duration: 300000, // 5 minutes initial
      timestamp: Date.now()
    });
  }
  
  /**
   * Execute log action
   */
  async executeLog(action) {
    logger.info('Security incident:', action.details);
  }
  
  /**
   * Emit alerts
   */
  emitAlerts(incident, response) {
    this.emit('incident:created', {
      incident,
      response
    });
    
    if (incident.severity >= THREAT_LEVELS.HIGH) {
      this.emit('security:high_alert', {
        incident,
        threats: incident.threats
      });
    }
  }
  
  /**
   * Start real-time scanning
   */
  startRealTimeScanning() {
    setInterval(() => {
      this.performScan();
    }, this.options.scanInterval);
    
    // Update baseline periodically
    setInterval(() => {
      this.updateBaseline();
    }, 300000); // Every 5 minutes
    
    // Clean old events
    setInterval(() => {
      this.cleanOldEvents();
    }, 3600000); // Every hour
  }
  
  /**
   * Perform security scan
   */
  async performScan() {
    // Check for ongoing incidents
    for (const [incidentId, incident] of this.incidents) {
      if (incident.status === 'active') {
        // Check if incident should be escalated
        if (this.shouldEscalate(incident)) {
          await this.escalateIncident(incident);
        }
        
        // Check if incident can be closed
        if (this.canCloseIncident(incident)) {
          this.closeIncident(incident);
        }
      }
    }
    
    // Update metrics
    this.updateMetrics();
  }
  
  /**
   * Update system baseline
   */
  updateBaseline() {
    const recentEvents = this.events.filter(
      e => e.timestamp > Date.now() - 3600000 // Last hour
    );
    
    // Calculate baseline metrics
    const requestEvents = recentEvents.filter(e => e.type === 'request');
    const errorEvents = recentEvents.filter(e => e.type === 'error');
    
    const requestRate = requestEvents.length / 3600; // Per second
    const errorRate = errorEvents.length / requestEvents.length || 0;
    
    const responseTimes = requestEvents
      .map(e => e.responseTime)
      .filter(t => t !== undefined);
    
    const avgResponseTime = responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : 100; // Default 100ms
    
    // Calculate standard deviations
    const requestRates = this.calculateHourlyRates(requestEvents);
    const requestRateStdDev = this.calculateStdDev(requestRates);
    
    this.systemBaseline = {
      avgRequestRate: requestRate,
      requestRateStdDev,
      avgResponseTime,
      avgErrorRate: errorRate,
      lastUpdated: Date.now()
    };
  }
  
  /**
   * Helper methods
   */
  
  storeEvent(event) {
    this.events.push(event);
    
    // Maintain max events
    if (this.events.length > this.options.maxEvents) {
      this.events.shift();
    }
  }
  
  generateEventId() {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateIncidentId() {
    return `inc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  getUserContext(userId) {
    if (!userId) return null;
    
    const userActivity = this.userActivity.get(userId) || {};
    return {
      recentActions: userActivity.actions || [],
      failedAttempts: userActivity.failures?.length || 0,
      riskScore: userActivity.riskScore || 0
    };
  }
  
  getSystemContext() {
    return {
      load: process.cpuUsage(),
      memory: process.memoryUsage(),
      uptime: process.uptime()
    };
  }
  
  getGeoLocation(ip) {
    // Simplified - would use actual GeoIP service
    return {
      country: 'US',
      city: 'Unknown',
      lat: 0,
      lon: 0
    };
  }
  
  calculateRiskScore(event) {
    let score = 0;
    
    // Factor in event type
    if (event.type === 'auth_failure') score += 0.2;
    if (event.type === 'error') score += 0.1;
    if (event.type === 'permission_change') score += 0.3;
    
    // Factor in user history
    if (event.userContext?.failedAttempts > 3) score += 0.3;
    
    // Factor in time
    const hour = new Date(event.timestamp).getHours();
    if (hour < 6 || hour > 22) score += 0.1; // Off hours
    
    return Math.min(1, score);
  }
  
  getIPActivity(ip) {
    const recentRequests = this.events.filter(
      e => e.ip === ip && e.timestamp > Date.now() - ATTACK_PATTERNS.DDOS.window
    );
    
    return {
      requestCount: recentRequests.length,
      lastSeen: Math.max(...recentRequests.map(e => e.timestamp))
    };
  }
  
  getCurrentRequestRate() {
    const recentRequests = this.events.filter(
      e => e.type === 'request' && e.timestamp > Date.now() - 60000
    );
    
    return recentRequests.length / 60; // Per second
  }
  
  getCurrentErrorRate() {
    const recentEvents = this.events.filter(
      e => e.timestamp > Date.now() - 60000
    );
    
    const errors = recentEvents.filter(e => e.type === 'error');
    
    return errors.length / Math.max(1, recentEvents.length);
  }
  
  getUserProfile(userId) {
    // Simplified profile
    return {
      normalHours: [9, 10, 11, 12, 13, 14, 15, 16, 17], // 9-5
      locations: [],
      permissions: ['read', 'write']
    };
  }
  
  calculateDistance(loc1, loc2) {
    // Haversine formula (simplified)
    const R = 6371; // Earth radius in km
    const dLat = (loc2.lat - loc1.lat) * Math.PI / 180;
    const dLon = (loc2.lon - loc1.lon) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(loc1.lat * Math.PI / 180) * Math.cos(loc2.lat * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
  
  extractFeatures(event) {
    return {
      type: event.type,
      hour: new Date(event.timestamp).getHours(),
      dayOfWeek: new Date(event.timestamp).getDay(),
      riskScore: event.riskScore,
      responseTime: event.responseTime || 0,
      dataSize: JSON.stringify(event.data || {}).length
    };
  }
  
  calculateSimilarity(features1, features2) {
    // Cosine similarity (simplified)
    const keys = Object.keys(features1);
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;
    
    for (const key of keys) {
      const v1 = features1[key] || 0;
      const v2 = features2[key] || 0;
      
      dotProduct += v1 * v2;
      norm1 += v1 * v1;
      norm2 += v2 * v2;
    }
    
    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }
  
  updateMLModel(features, event) {
    const patternId = `pattern_${Date.now()}`;
    
    this.mlModel.patterns.set(patternId, {
      id: patternId,
      features,
      type: event.type,
      name: `Learned pattern from ${event.type}`,
      level: THREAT_LEVELS.LOW,
      createdAt: Date.now()
    });
  }
  
  findRelatedIncident(event, threats) {
    for (const [incidentId, incident] of this.incidents) {
      if (incident.status !== 'active') continue;
      
      // Check if same user
      if (event.userId && incident.affectedUsers.includes(event.userId)) {
        return incident;
      }
      
      // Check if same threat type
      const threatTypes = new Set(threats.map(t => t.type));
      const incidentTypes = new Set(incident.threats.map(t => t.type));
      
      for (const type of threatTypes) {
        if (incidentTypes.has(type)) {
          return incident;
        }
      }
      
      // Check time proximity
      if (Math.abs(incident.lastUpdated - event.timestamp) < 300000) { // 5 minutes
        return incident;
      }
    }
    
    return null;
  }
  
  prioritizeThreats(threats) {
    // Remove duplicates and sort by level and confidence
    const unique = new Map();
    
    for (const threat of threats) {
      const key = `${threat.type}_${threat.subtype || ''}`;
      const existing = unique.get(key);
      
      if (!existing || threat.confidence > existing.confidence) {
        unique.set(key, threat);
      }
    }
    
    return Array.from(unique.values())
      .sort((a, b) => {
        if (a.level !== b.level) {
          return b.level - a.level;
        }
        return b.confidence - a.confidence;
      });
  }
  
  shouldEscalate(incident) {
    // Escalate if incident is growing
    const recentEvents = incident.events.filter(
      e => e.timestamp > Date.now() - 300000 // Last 5 minutes
    );
    
    return recentEvents.length > incident.events.length * 0.5;
  }
  
  async escalateIncident(incident) {
    incident.severity = Math.min(THREAT_LEVELS.CRITICAL, incident.severity + 1);
    incident.timeline.push({
      timestamp: Date.now(),
      action: 'escalated',
      details: 'Incident escalated due to continued activity'
    });
    
    // Determine new response
    const response = this.determineResponse(incident);
    await this.executeResponse(response);
  }
  
  canCloseIncident(incident) {
    // Close if no activity for 30 minutes
    return Date.now() - incident.lastUpdated > 1800000;
  }
  
  closeIncident(incident) {
    incident.status = 'closed';
    incident.closedAt = Date.now();
    incident.timeline.push({
      timestamp: Date.now(),
      action: 'closed',
      details: 'Incident closed due to inactivity'
    });
    
    this.emit('incident:closed', {
      incidentId: incident.id,
      duration: incident.closedAt - incident.createdAt
    });
  }
  
  calculateHourlyRates(events) {
    const hourlyBuckets = {};
    
    for (const event of events) {
      const hour = Math.floor(event.timestamp / 3600000);
      hourlyBuckets[hour] = (hourlyBuckets[hour] || 0) + 1;
    }
    
    return Object.values(hourlyBuckets);
  }
  
  calculateStdDev(values) {
    if (values.length === 0) return 0;
    
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const squareDiffs = values.map(v => Math.pow(v - avg, 2));
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / values.length;
    
    return Math.sqrt(avgSquareDiff);
  }
  
  updateMetrics() {
    this.metrics.activeIncidents = Array.from(this.incidents.values())
      .filter(i => i.status === 'active').length;
    
    this.metrics.blockedIPs = this.blockedIPs.size;
    
    const recentThreats = this.incidents.values()
      .flatMap(i => i.threats)
      .filter(t => t.timestamp > Date.now() - 3600000); // Last hour
    
    this.metrics.recentThreatCount = recentThreats.length;
  }
  
  cleanOldEvents() {
    const cutoff = Date.now() - this.options.eventRetention;
    this.events = this.events.filter(e => e.timestamp > cutoff);
  }
  
  /**
   * Get security status
   */
  getSecurityStatus() {
    const activeIncidents = Array.from(this.incidents.values())
      .filter(i => i.status === 'active');
    
    const highSeverityIncidents = activeIncidents
      .filter(i => i.severity >= THREAT_LEVELS.HIGH);
    
    let overallStatus = 'secure';
    if (highSeverityIncidents.length > 0) {
      overallStatus = 'critical';
    } else if (activeIncidents.length > 0) {
      overallStatus = 'warning';
    }
    
    return {
      status: overallStatus,
      activeIncidents: activeIncidents.length,
      highSeverityIncidents: highSeverityIncidents.length,
      blockedIPs: this.blockedIPs.size,
      metrics: this.getMetrics(),
      baseline: this.systemBaseline,
      lastScan: Date.now()
    };
  }
  
  /**
   * Get metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      mlPatterns: this.mlModel.patterns.size
    };
  }
  
  /**
   * Export incident report
   */
  exportIncidentReport(incidentId) {
    const incident = this.incidents.get(incidentId);
    if (!incident) return null;
    
    return {
      ...incident,
      summary: {
        duration: incident.closedAt ? incident.closedAt - incident.createdAt : Date.now() - incident.createdAt,
        eventCount: incident.events.length,
        threatCount: incident.threats.length,
        actionsTaken: incident.timeline.filter(t => t.action !== 'incident_created').length
      }
    };
  }
}

module.exports = RealTimeSecurityMonitor;