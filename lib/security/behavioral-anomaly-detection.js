/**
 * Behavioral Anomaly Detection System - Otedama
 * AI-powered security monitoring and threat detection
 * 
 * Design principles:
 * - Machine learning based detection
 * - Real-time anomaly scoring
 * - Adaptive baseline learning
 * - Multi-dimensional behavioral analysis
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';
import { memoryManager } from '../core/memory-manager.js';

const logger = createStructuredLogger('BehavioralAnomalyDetection');

/**
 * Behavior dimensions
 */
export const BehaviorDimension = {
  ACCESS_PATTERN: 'access_pattern',
  TIME_PATTERN: 'time_pattern',
  RESOURCE_USAGE: 'resource_usage',
  API_SEQUENCE: 'api_sequence',
  GEO_LOCATION: 'geo_location',
  NETWORK_PATTERN: 'network_pattern',
  AUTHENTICATION: 'authentication',
  DATA_ACCESS: 'data_access',
  SYSTEM_INTERACTION: 'system_interaction'
};

/**
 * Anomaly types
 */
export const AnomalyType = {
  UNUSUAL_ACCESS_TIME: 'unusual_access_time',
  ABNORMAL_RESOURCE_USAGE: 'abnormal_resource_usage',
  SUSPICIOUS_API_SEQUENCE: 'suspicious_api_sequence',
  IMPOSSIBLE_TRAVEL: 'impossible_travel',
  PRIVILEGE_ESCALATION: 'privilege_escalation',
  DATA_EXFILTRATION: 'data_exfiltration',
  LATERAL_MOVEMENT: 'lateral_movement',
  BRUTE_FORCE: 'brute_force',
  ACCOUNT_TAKEOVER: 'account_takeover'
};

/**
 * Risk levels
 */
export const RiskLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

/**
 * Behavioral Anomaly Detection System
 */
export class BehavioralAnomalyDetection extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Learning parameters
      learningRate: config.learningRate || 0.01,
      baselinePeriod: config.baselinePeriod || 7 * 24 * 60 * 60 * 1000, // 7 days
      updateInterval: config.updateInterval || 3600000, // 1 hour
      
      // Detection thresholds
      anomalyThreshold: config.anomalyThreshold || 0.8,
      criticalThreshold: config.criticalThreshold || 0.95,
      minDataPoints: config.minDataPoints || 100,
      
      // Feature extraction
      timeWindowSize: config.timeWindowSize || 300000, // 5 minutes
      maxSequenceLength: config.maxSequenceLength || 100,
      
      // Model parameters
      hiddenLayerSize: config.hiddenLayerSize || 64,
      embeddingSize: config.embeddingSize || 32,
      
      // Performance
      maxProfiles: config.maxProfiles || 10000,
      cleanupInterval: config.cleanupInterval || 3600000, // 1 hour
      
      ...config
    };
    
    // User profiles
    this.userProfiles = new Map();
    this.deviceProfiles = new Map();
    this.entityProfiles = new Map();
    
    // Behavioral models
    this.models = {
      access: new AccessPatternModel(this.config),
      time: new TimePatternModel(this.config),
      resource: new ResourceUsageModel(this.config),
      sequence: new SequenceModel(this.config),
      network: new NetworkModel(this.config)
    };
    
    // Detection state
    this.anomalyScores = new Map();
    this.alerts = [];
    this.incidents = new Map();
    
    // Initialize
    this.initialize();
  }
  
  initialize() {
    // Start model training
    this.startModelTraining();
    
    // Start cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
    
    logger.info('Behavioral anomaly detection initialized');
  }
  
  /**
   * Analyze user behavior
   */
  async analyzeUserBehavior(userId, event) {
    const timestamp = Date.now();
    
    // Get or create user profile
    let profile = this.userProfiles.get(userId);
    if (!profile) {
      profile = this.createUserProfile(userId);
      this.userProfiles.set(userId, profile);
    }
    
    // Extract features
    const features = await this.extractFeatures(event, profile);
    
    // Update profile
    this.updateProfile(profile, features, timestamp);
    
    // Detect anomalies
    const anomalies = await this.detectAnomalies(profile, features, event);
    
    // Calculate risk score
    const riskScore = this.calculateRiskScore(anomalies, profile);
    
    // Store anomaly score
    this.anomalyScores.set(userId, {
      score: riskScore,
      timestamp,
      anomalies
    });
    
    // Generate alerts if needed
    if (riskScore > this.config.anomalyThreshold) {
      await this.generateAlert(userId, profile, anomalies, riskScore);
    }
    
    // Emit analysis results
    this.emit('behavior:analyzed', {
      userId,
      riskScore,
      anomalies,
      timestamp
    });
    
    return {
      userId,
      riskScore,
      riskLevel: this.getRiskLevel(riskScore),
      anomalies,
      recommendations: this.getRecommendations(anomalies)
    };
  }
  
  /**
   * Analyze device behavior
   */
  async analyzeDeviceBehavior(deviceId, event) {
    const timestamp = Date.now();
    
    // Get or create device profile
    let profile = this.deviceProfiles.get(deviceId);
    if (!profile) {
      profile = this.createDeviceProfile(deviceId);
      this.deviceProfiles.set(deviceId, profile);
    }
    
    // Extract device-specific features
    const features = await this.extractDeviceFeatures(event, profile);
    
    // Update profile
    this.updateProfile(profile, features, timestamp);
    
    // Detect anomalies
    const anomalies = await this.detectDeviceAnomalies(profile, features, event);
    
    // Calculate risk score
    const riskScore = this.calculateRiskScore(anomalies, profile);
    
    return {
      deviceId,
      riskScore,
      anomalies,
      recommendations: this.getRecommendations(anomalies)
    };
  }
  
  /**
   * Extract behavioral features
   */
  async extractFeatures(event, profile) {
    const features = {
      timestamp: event.timestamp || Date.now(),
      dimensions: {}
    };
    
    // Access pattern features
    features.dimensions[BehaviorDimension.ACCESS_PATTERN] = {
      resource: event.resource,
      action: event.action,
      frequency: this.calculateAccessFrequency(event, profile),
      entropy: this.calculateAccessEntropy(event, profile)
    };
    
    // Time pattern features
    features.dimensions[BehaviorDimension.TIME_PATTERN] = {
      hour: new Date(features.timestamp).getHours(),
      dayOfWeek: new Date(features.timestamp).getDay(),
      isWeekend: [0, 6].includes(new Date(features.timestamp).getDay()),
      isBusinessHours: this.isBusinessHours(features.timestamp),
      timeSinceLastAccess: features.timestamp - (profile.lastAccess || features.timestamp)
    };
    
    // Resource usage features
    features.dimensions[BehaviorDimension.RESOURCE_USAGE] = {
      dataVolume: event.dataVolume || 0,
      requestCount: event.requestCount || 1,
      errorRate: event.errorRate || 0,
      latency: event.latency || 0
    };
    
    // API sequence features
    features.dimensions[BehaviorDimension.API_SEQUENCE] = {
      sequence: this.updateSequence(profile.apiSequence || [], event.api),
      transitionProbability: this.calculateTransitionProbability(
        profile.apiSequence,
        event.api
      )
    };
    
    // Network features
    features.dimensions[BehaviorDimension.NETWORK_PATTERN] = {
      sourceIP: event.sourceIP,
      userAgent: event.userAgent,
      protocol: event.protocol,
      port: event.port
    };
    
    // Geo-location features
    if (event.location) {
      features.dimensions[BehaviorDimension.GEO_LOCATION] = {
        country: event.location.country,
        city: event.location.city,
        coordinates: event.location.coordinates,
        distance: this.calculateLocationDistance(
          profile.lastLocation,
          event.location
        )
      };
    }
    
    return features;
  }
  
  /**
   * Detect anomalies across dimensions
   */
  async detectAnomalies(profile, features, event) {
    const anomalies = [];
    
    // Check each dimension
    for (const [dimension, model] of Object.entries(this.models)) {
      const dimensionFeatures = features.dimensions[dimension];
      if (!dimensionFeatures) continue;
      
      const anomalyScore = await model.predict(dimensionFeatures, profile);
      
      if (anomalyScore > this.config.anomalyThreshold) {
        const anomaly = {
          dimension,
          score: anomalyScore,
          type: this.classifyAnomaly(dimension, dimensionFeatures, profile),
          details: model.explainAnomaly(dimensionFeatures, profile)
        };
        
        anomalies.push(anomaly);
      }
    }
    
    // Cross-dimensional anomalies
    const crossAnomalies = await this.detectCrossDimensionalAnomalies(
      features,
      profile,
      event
    );
    
    anomalies.push(...crossAnomalies);
    
    return anomalies;
  }
  
  /**
   * Detect cross-dimensional anomalies
   */
  async detectCrossDimensionalAnomalies(features, profile, event) {
    const anomalies = [];
    
    // Impossible travel detection
    if (features.dimensions[BehaviorDimension.GEO_LOCATION] &&
        features.dimensions[BehaviorDimension.TIME_PATTERN]) {
      const impossibleTravel = this.detectImpossibleTravel(
        features.dimensions[BehaviorDimension.GEO_LOCATION],
        features.dimensions[BehaviorDimension.TIME_PATTERN],
        profile
      );
      
      if (impossibleTravel) {
        anomalies.push({
          type: AnomalyType.IMPOSSIBLE_TRAVEL,
          score: impossibleTravel.score,
          details: impossibleTravel.details
        });
      }
    }
    
    // Privilege escalation detection
    if (event.privileges && profile.normalPrivileges) {
      const privEscalation = this.detectPrivilegeEscalation(
        event.privileges,
        profile.normalPrivileges
      );
      
      if (privEscalation) {
        anomalies.push({
          type: AnomalyType.PRIVILEGE_ESCALATION,
          score: privEscalation.score,
          details: privEscalation.details
        });
      }
    }
    
    // Data exfiltration detection
    if (features.dimensions[BehaviorDimension.RESOURCE_USAGE]) {
      const dataExfiltration = this.detectDataExfiltration(
        features.dimensions[BehaviorDimension.RESOURCE_USAGE],
        profile
      );
      
      if (dataExfiltration) {
        anomalies.push({
          type: AnomalyType.DATA_EXFILTRATION,
          score: dataExfiltration.score,
          details: dataExfiltration.details
        });
      }
    }
    
    // Lateral movement detection
    if (features.dimensions[BehaviorDimension.NETWORK_PATTERN] &&
        features.dimensions[BehaviorDimension.ACCESS_PATTERN]) {
      const lateralMovement = this.detectLateralMovement(
        features.dimensions[BehaviorDimension.NETWORK_PATTERN],
        features.dimensions[BehaviorDimension.ACCESS_PATTERN],
        profile
      );
      
      if (lateralMovement) {
        anomalies.push({
          type: AnomalyType.LATERAL_MOVEMENT,
          score: lateralMovement.score,
          details: lateralMovement.details
        });
      }
    }
    
    return anomalies;
  }
  
  /**
   * Detect impossible travel
   */
  detectImpossibleTravel(locationFeatures, timeFeatures, profile) {
    if (!profile.lastLocation || !locationFeatures.distance) {
      return null;
    }
    
    const timeDelta = timeFeatures.timeSinceLastAccess / 3600000; // hours
    const maxPossibleDistance = timeDelta * 1000; // 1000 km/h max speed
    
    if (locationFeatures.distance > maxPossibleDistance) {
      return {
        score: Math.min(1, locationFeatures.distance / maxPossibleDistance),
        details: {
          distance: locationFeatures.distance,
          timeDelta,
          lastLocation: profile.lastLocation,
          currentLocation: {
            country: locationFeatures.country,
            city: locationFeatures.city
          }
        }
      };
    }
    
    return null;
  }
  
  /**
   * Detect privilege escalation
   */
  detectPrivilegeEscalation(currentPrivileges, normalPrivileges) {
    const newPrivileges = currentPrivileges.filter(
      p => !normalPrivileges.includes(p)
    );
    
    if (newPrivileges.length > 0) {
      const criticalPrivileges = [
        'admin', 'root', 'sudo', 'system', 'administrator'
      ];
      
      const hasCritical = newPrivileges.some(
        p => criticalPrivileges.some(cp => p.toLowerCase().includes(cp))
      );
      
      return {
        score: hasCritical ? 0.95 : 0.8,
        details: {
          newPrivileges,
          normalPrivileges,
          critical: hasCritical
        }
      };
    }
    
    return null;
  }
  
  /**
   * Detect data exfiltration
   */
  detectDataExfiltration(resourceFeatures, profile) {
    const avgDataVolume = profile.avgDataVolume || 0;
    const stdDataVolume = profile.stdDataVolume || 1;
    
    const zScore = Math.abs((resourceFeatures.dataVolume - avgDataVolume) / stdDataVolume);
    
    if (zScore > 3) { // 3 standard deviations
      return {
        score: Math.min(1, zScore / 5),
        details: {
          dataVolume: resourceFeatures.dataVolume,
          avgDataVolume,
          stdDataVolume,
          zScore
        }
      };
    }
    
    return null;
  }
  
  /**
   * Detect lateral movement
   */
  detectLateralMovement(networkFeatures, accessFeatures, profile) {
    const unusualAccess = !profile.accessedResources?.includes(accessFeatures.resource);
    const newNetwork = !profile.knownNetworks?.includes(networkFeatures.sourceIP);
    
    if (unusualAccess && newNetwork) {
      return {
        score: 0.85,
        details: {
          resource: accessFeatures.resource,
          sourceIP: networkFeatures.sourceIP,
          knownResources: profile.accessedResources || [],
          knownNetworks: profile.knownNetworks || []
        }
      };
    }
    
    return null;
  }
  
  /**
   * Calculate risk score
   */
  calculateRiskScore(anomalies, profile) {
    if (anomalies.length === 0) return 0;
    
    // Weight anomalies by type and dimension
    const weights = {
      [AnomalyType.PRIVILEGE_ESCALATION]: 0.9,
      [AnomalyType.DATA_EXFILTRATION]: 0.85,
      [AnomalyType.ACCOUNT_TAKEOVER]: 0.95,
      [AnomalyType.LATERAL_MOVEMENT]: 0.8,
      [AnomalyType.IMPOSSIBLE_TRAVEL]: 0.75,
      [AnomalyType.BRUTE_FORCE]: 0.7
    };
    
    let totalScore = 0;
    let totalWeight = 0;
    
    for (const anomaly of anomalies) {
      const weight = weights[anomaly.type] || 0.5;
      totalScore += anomaly.score * weight;
      totalWeight += weight;
    }
    
    // Consider profile trust level
    const trustFactor = profile.trustLevel || 1;
    const baseScore = totalWeight > 0 ? totalScore / totalWeight : 0;
    
    // Adjust based on multiple anomalies
    const multiAnomalyFactor = 1 + (anomalies.length - 1) * 0.1;
    
    return Math.min(1, baseScore * multiAnomalyFactor / trustFactor);
  }
  
  /**
   * Get risk level
   */
  getRiskLevel(riskScore) {
    if (riskScore >= this.config.criticalThreshold) return RiskLevel.CRITICAL;
    if (riskScore >= 0.8) return RiskLevel.HIGH;
    if (riskScore >= 0.5) return RiskLevel.MEDIUM;
    return RiskLevel.LOW;
  }
  
  /**
   * Generate security alert
   */
  async generateAlert(userId, profile, anomalies, riskScore) {
    const alert = {
      id: randomBytes(16).toString('hex'),
      userId,
      timestamp: Date.now(),
      riskScore,
      riskLevel: this.getRiskLevel(riskScore),
      anomalies,
      profile: {
        lastAccess: profile.lastAccess,
        trustLevel: profile.trustLevel,
        location: profile.lastLocation
      },
      status: 'active'
    };
    
    this.alerts.push(alert);
    
    // Check for incident creation
    if (riskScore >= this.config.criticalThreshold) {
      await this.createIncident(alert);
    }
    
    logger.warn('Security alert generated', {
      alertId: alert.id,
      userId,
      riskScore,
      anomalyCount: anomalies.length
    });
    
    this.emit('alert:generated', alert);
    
    return alert;
  }
  
  /**
   * Create security incident
   */
  async createIncident(alert) {
    const incident = {
      id: randomBytes(16).toString('hex'),
      alerts: [alert.id],
      startTime: Date.now(),
      status: 'open',
      severity: alert.riskLevel,
      affectedUsers: [alert.userId],
      anomalyTypes: [...new Set(alert.anomalies.map(a => a.type))],
      timeline: [{
        timestamp: Date.now(),
        event: 'incident_created',
        alertId: alert.id
      }]
    };
    
    this.incidents.set(incident.id, incident);
    
    logger.error('Security incident created', {
      incidentId: incident.id,
      severity: incident.severity,
      affectedUsers: incident.affectedUsers
    });
    
    this.emit('incident:created', incident);
    
    return incident;
  }
  
  /**
   * Get recommendations
   */
  getRecommendations(anomalies) {
    const recommendations = [];
    
    for (const anomaly of anomalies) {
      switch (anomaly.type) {
        case AnomalyType.IMPOSSIBLE_TRAVEL:
          recommendations.push({
            action: 'verify_location',
            priority: 'high',
            description: 'Verify user location and require additional authentication'
          });
          break;
          
        case AnomalyType.PRIVILEGE_ESCALATION:
          recommendations.push({
            action: 'review_privileges',
            priority: 'critical',
            description: 'Review and validate privilege changes immediately'
          });
          break;
          
        case AnomalyType.DATA_EXFILTRATION:
          recommendations.push({
            action: 'block_data_transfer',
            priority: 'critical',
            description: 'Block large data transfers and investigate'
          });
          break;
          
        case AnomalyType.LATERAL_MOVEMENT:
          recommendations.push({
            action: 'isolate_system',
            priority: 'high',
            description: 'Isolate affected systems and review access logs'
          });
          break;
          
        case AnomalyType.BRUTE_FORCE:
          recommendations.push({
            action: 'enforce_mfa',
            priority: 'high',
            description: 'Enforce multi-factor authentication and reset credentials'
          });
          break;
      }
    }
    
    return recommendations;
  }
  
  /**
   * Update user profile
   */
  updateProfile(profile, features, timestamp) {
    profile.lastAccess = timestamp;
    profile.accessCount = (profile.accessCount || 0) + 1;
    
    // Update location
    if (features.dimensions[BehaviorDimension.GEO_LOCATION]) {
      profile.lastLocation = {
        country: features.dimensions[BehaviorDimension.GEO_LOCATION].country,
        city: features.dimensions[BehaviorDimension.GEO_LOCATION].city,
        coordinates: features.dimensions[BehaviorDimension.GEO_LOCATION].coordinates
      };
    }
    
    // Update accessed resources
    if (features.dimensions[BehaviorDimension.ACCESS_PATTERN]) {
      if (!profile.accessedResources) {
        profile.accessedResources = [];
      }
      const resource = features.dimensions[BehaviorDimension.ACCESS_PATTERN].resource;
      if (!profile.accessedResources.includes(resource)) {
        profile.accessedResources.push(resource);
      }
    }
    
    // Update network info
    if (features.dimensions[BehaviorDimension.NETWORK_PATTERN]) {
      if (!profile.knownNetworks) {
        profile.knownNetworks = [];
      }
      const ip = features.dimensions[BehaviorDimension.NETWORK_PATTERN].sourceIP;
      if (!profile.knownNetworks.includes(ip)) {
        profile.knownNetworks.push(ip);
      }
    }
    
    // Update statistics
    this.updateProfileStatistics(profile, features);
  }
  
  /**
   * Update profile statistics
   */
  updateProfileStatistics(profile, features) {
    // Update data volume statistics
    if (features.dimensions[BehaviorDimension.RESOURCE_USAGE]) {
      const dataVolume = features.dimensions[BehaviorDimension.RESOURCE_USAGE].dataVolume;
      
      if (!profile.dataVolumeStats) {
        profile.dataVolumeStats = {
          count: 0,
          sum: 0,
          sumSquares: 0
        };
      }
      
      profile.dataVolumeStats.count++;
      profile.dataVolumeStats.sum += dataVolume;
      profile.dataVolumeStats.sumSquares += dataVolume * dataVolume;
      
      // Calculate running average and standard deviation
      profile.avgDataVolume = profile.dataVolumeStats.sum / profile.dataVolumeStats.count;
      
      const variance = (profile.dataVolumeStats.sumSquares / profile.dataVolumeStats.count) -
                      (profile.avgDataVolume * profile.avgDataVolume);
      profile.stdDataVolume = Math.sqrt(Math.max(0, variance));
    }
  }
  
  /**
   * Create user profile
   */
  createUserProfile(userId) {
    return {
      userId,
      created: Date.now(),
      trustLevel: 1.0,
      accessCount: 0,
      anomalyHistory: [],
      baselinePeriodEnd: Date.now() + this.config.baselinePeriod
    };
  }
  
  /**
   * Create device profile
   */
  createDeviceProfile(deviceId) {
    return {
      deviceId,
      created: Date.now(),
      trustLevel: 1.0,
      type: 'unknown',
      characteristics: {},
      anomalyHistory: []
    };
  }
  
  /**
   * Helper methods
   */
  
  calculateAccessFrequency(event, profile) {
    const timeWindow = this.config.timeWindowSize;
    const now = Date.now();
    
    if (!profile.accessTimestamps) {
      profile.accessTimestamps = [];
    }
    
    // Add current timestamp
    profile.accessTimestamps.push(now);
    
    // Remove old timestamps
    profile.accessTimestamps = profile.accessTimestamps.filter(
      t => t > now - timeWindow
    );
    
    return profile.accessTimestamps.length;
  }
  
  calculateAccessEntropy(event, profile) {
    if (!profile.resourceFrequency) {
      profile.resourceFrequency = {};
    }
    
    const resource = event.resource;
    profile.resourceFrequency[resource] = (profile.resourceFrequency[resource] || 0) + 1;
    
    // Calculate Shannon entropy
    const total = Object.values(profile.resourceFrequency).reduce((a, b) => a + b, 0);
    let entropy = 0;
    
    for (const count of Object.values(profile.resourceFrequency)) {
      const p = count / total;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }
    
    return entropy;
  }
  
  isBusinessHours(timestamp) {
    const date = new Date(timestamp);
    const hour = date.getHours();
    const day = date.getDay();
    
    // Monday-Friday, 9 AM - 6 PM
    return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
  }
  
  updateSequence(sequence, newItem) {
    const updated = [...sequence, newItem];
    
    // Keep only recent items
    if (updated.length > this.config.maxSequenceLength) {
      updated.shift();
    }
    
    return updated;
  }
  
  calculateTransitionProbability(sequence, nextItem) {
    if (!sequence || sequence.length === 0) return 0.5;
    
    const lastItem = sequence[sequence.length - 1];
    const transitions = {};
    
    // Count transitions
    for (let i = 0; i < sequence.length - 1; i++) {
      const from = sequence[i];
      const to = sequence[i + 1];
      
      if (!transitions[from]) {
        transitions[from] = {};
      }
      
      transitions[from][to] = (transitions[from][to] || 0) + 1;
    }
    
    // Calculate probability
    if (!transitions[lastItem] || !transitions[lastItem][nextItem]) {
      return 0; // Never seen this transition
    }
    
    const totalTransitions = Object.values(transitions[lastItem])
      .reduce((a, b) => a + b, 0);
    
    return transitions[lastItem][nextItem] / totalTransitions;
  }
  
  calculateLocationDistance(loc1, loc2) {
    if (!loc1 || !loc2 || !loc1.coordinates || !loc2.coordinates) {
      return 0;
    }
    
    // Haversine formula
    const R = 6371; // Earth radius in km
    const dLat = (loc2.coordinates.lat - loc1.coordinates.lat) * Math.PI / 180;
    const dLon = (loc2.coordinates.lon - loc1.coordinates.lon) * Math.PI / 180;
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(loc1.coordinates.lat * Math.PI / 180) *
              Math.cos(loc2.coordinates.lat * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    return R * c;
  }
  
  classifyAnomaly(dimension, features, profile) {
    // Classify based on dimension and features
    switch (dimension) {
      case BehaviorDimension.ACCESS_PATTERN:
        if (features.frequency > profile.avgFrequency * 10) {
          return AnomalyType.BRUTE_FORCE;
        }
        break;
        
      case BehaviorDimension.TIME_PATTERN:
        if (!features.isBusinessHours && profile.onlyBusinessHours) {
          return AnomalyType.UNUSUAL_ACCESS_TIME;
        }
        break;
        
      case BehaviorDimension.RESOURCE_USAGE:
        return AnomalyType.ABNORMAL_RESOURCE_USAGE;
        
      case BehaviorDimension.API_SEQUENCE:
        return AnomalyType.SUSPICIOUS_API_SEQUENCE;
    }
    
    return 'unknown_anomaly';
  }
  
  extractDeviceFeatures(event, profile) {
    // Similar to extractFeatures but device-specific
    return this.extractFeatures(event, profile);
  }
  
  detectDeviceAnomalies(profile, features, event) {
    // Similar to detectAnomalies but device-specific
    return this.detectAnomalies(profile, features, event);
  }
  
  /**
   * Start model training
   */
  startModelTraining() {
    this.trainingInterval = setInterval(() => {
      this.trainModels();
    }, this.config.updateInterval);
    
    // Initial training
    this.trainModels();
  }
  
  /**
   * Train behavioral models
   */
  async trainModels() {
    logger.info('Training behavioral models');
    
    // Prepare training data
    const trainingData = this.prepareTrainingData();
    
    // Train each model
    for (const [name, model] of Object.entries(this.models)) {
      try {
        await model.train(trainingData[name] || []);
      } catch (error) {
        logger.error('Model training failed', { model: name, error });
      }
    }
    
    this.emit('models:trained', {
      timestamp: Date.now(),
      modelCount: Object.keys(this.models).length
    });
  }
  
  /**
   * Prepare training data
   */
  prepareTrainingData() {
    const data = {};
    
    // Collect data from profiles
    for (const profile of this.userProfiles.values()) {
      if (profile.trainingData) {
        for (const [dimension, samples] of Object.entries(profile.trainingData)) {
          if (!data[dimension]) {
            data[dimension] = [];
          }
          data[dimension].push(...samples);
        }
      }
    }
    
    return data;
  }
  
  /**
   * Cleanup old data
   */
  cleanup() {
    const now = Date.now();
    const maxAge = this.config.baselinePeriod;
    
    // Clean old profiles
    for (const [userId, profile] of this.userProfiles) {
      if (now - profile.lastAccess > maxAge) {
        this.userProfiles.delete(userId);
      }
    }
    
    // Clean old alerts
    this.alerts = this.alerts.filter(
      alert => now - alert.timestamp < maxAge
    );
    
    // Clean closed incidents
    for (const [id, incident] of this.incidents) {
      if (incident.status === 'closed' && 
          now - incident.closedAt > maxAge) {
        this.incidents.delete(id);
      }
    }
    
    logger.debug('Cleanup completed', {
      userProfiles: this.userProfiles.size,
      activeAlerts: this.alerts.length,
      incidents: this.incidents.size
    });
  }
  
  /**
   * Get system statistics
   */
  getStats() {
    return {
      userProfiles: this.userProfiles.size,
      deviceProfiles: this.deviceProfiles.size,
      activeAlerts: this.alerts.filter(a => a.status === 'active').length,
      openIncidents: Array.from(this.incidents.values())
        .filter(i => i.status === 'open').length,
      models: Object.keys(this.models).length,
      anomalyScores: this.anomalyScores.size
    };
  }
  
  /**
   * Shutdown system
   */
  shutdown() {
    clearInterval(this.cleanupInterval);
    clearInterval(this.trainingInterval);
    
    logger.info('Behavioral anomaly detection shutdown');
  }
}

/**
 * Base model class
 */
class BehavioralModel {
  constructor(config) {
    this.config = config;
    this.trained = false;
  }
  
  async train(data) {
    // Override in subclasses
    this.trained = true;
  }
  
  async predict(features, profile) {
    // Override in subclasses
    return Math.random(); // Placeholder
  }
  
  explainAnomaly(features, profile) {
    // Override in subclasses
    return 'Anomaly detected';
  }
}

/**
 * Access pattern model
 */
class AccessPatternModel extends BehavioralModel {
  async predict(features, profile) {
    // Simple frequency-based anomaly detection
    const avgFrequency = profile.avgFrequency || 10;
    const deviation = Math.abs(features.frequency - avgFrequency) / avgFrequency;
    
    return Math.min(1, deviation / 5);
  }
}

/**
 * Time pattern model
 */
class TimePatternModel extends BehavioralModel {
  async predict(features, profile) {
    // Check unusual access times
    if (!features.isBusinessHours && profile.onlyBusinessHours) {
      return 0.9;
    }
    
    // Check time since last access
    const avgTimeBetween = profile.avgTimeBetween || 3600000; // 1 hour
    const deviation = Math.abs(features.timeSinceLastAccess - avgTimeBetween) / avgTimeBetween;
    
    return Math.min(1, deviation / 10);
  }
}

/**
 * Resource usage model
 */
class ResourceUsageModel extends BehavioralModel {
  async predict(features, profile) {
    // Z-score based anomaly detection
    const avgVolume = profile.avgDataVolume || 1000;
    const stdVolume = profile.stdDataVolume || 100;
    
    const zScore = Math.abs((features.dataVolume - avgVolume) / stdVolume);
    
    return Math.min(1, zScore / 5);
  }
}

/**
 * Sequence model
 */
class SequenceModel extends BehavioralModel {
  async predict(features, profile) {
    // Transition probability based
    if (features.transitionProbability < 0.01) {
      return 0.95; // Very unlikely transition
    }
    
    return 1 - features.transitionProbability;
  }
}

/**
 * Network model
 */
class NetworkModel extends BehavioralModel {
  async predict(features, profile) {
    // Check for new network sources
    if (profile.knownNetworks && 
        !profile.knownNetworks.includes(features.sourceIP)) {
      return 0.7;
    }
    
    return 0;
  }
}

/**
 * Create behavioral anomaly detection instance
 */
export function createBehavioralAnomalyDetection(config) {
  return new BehavioralAnomalyDetection(config);
}

export default BehavioralAnomalyDetection;