// Advanced Network Attack Protection for Mining Pool
// Implements comprehensive security measures against various mining attacks

import EventEmitter from 'events';
import { createLogger } from '../core/logger.js';
import crypto from 'crypto';
import { LRUCache } from 'lru-cache';
import net from 'net';
import dns from 'dns/promises';

const logger = createLogger('attack-protection');

// Attack types
export const AttackType = {
  DDOS: 'ddos',
  SHARE_FLOODING: 'share_flooding',
  BLOCK_WITHHOLDING: 'block_withholding',
  SELFISH_MINING: 'selfish_mining',
  TIME_WARP: 'time_warp',
  SYBIL: 'sybil',
  DOUBLE_SPEND: 'double_spend',
  HASH_RATE_HIJACKING: 'hashrate_hijacking',
  POOL_HOPPING: 'pool_hopping',
  DIFFICULTY_MANIPULATION: 'difficulty_manipulation',
  STRATUM_EXPLOITS: 'stratum_exploits',
  REPLAY_ATTACK: 'replay_attack'
};

// Security levels
export const SecurityLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  PARANOID: 'paranoid'
};

export class AdvancedAttackProtection extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      securityLevel: options.securityLevel || SecurityLevel.HIGH,
      
      // Rate limiting
      maxConnectionsPerIP: options.maxConnectionsPerIP || 10,
      maxSharesPerMinute: options.maxSharesPerMinute || 1000,
      maxRequestsPerSecond: options.maxRequestsPerSecond || 100,
      
      // Anomaly detection
      anomalyThreshold: options.anomalyThreshold || 3, // Standard deviations
      anomalyWindowSize: options.anomalyWindowSize || 1000, // Samples
      
      // Block withholding detection
      blockWithholdingThreshold: options.blockWithholdingThreshold || 0.001, // 0.1%
      shareValidationSamples: options.shareValidationSamples || 10000,
      
      // Time-based protections
      maxTimeDrift: options.maxTimeDrift || 300000, // 5 minutes
      nonceReuseWindow: options.nonceReuseWindow || 3600000, // 1 hour
      
      // Blacklisting
      blacklistDuration: options.blacklistDuration || 86400000, // 24 hours
      suspicionThreshold: options.suspicionThreshold || 5, // Strikes before blacklist
      
      // Cryptographic settings
      challengeComplexity: options.challengeComplexity || 20, // Bits
      proofOfWorkRequired: options.proofOfWorkRequired || true,
      
      // Advanced protections
      enableHoneypot: options.enableHoneypot !== false,
      enableBehaviorAnalysis: options.enableBehaviorAnalysis !== false,
      enableMachineLearning: options.enableMachineLearning !== false,
      
      ...options
    };
    
    // Security state
    this.connections = new Map();
    this.blacklist = new Set();
    this.whitelist = new Set();
    this.suspicionScores = new Map();
    
    // Rate limiting
    this.rateLimiters = {
      connections: new LRUCache({ max: 10000, ttl: 60000 }),
      shares: new LRUCache({ max: 10000, ttl: 60000 }),
      requests: new LRUCache({ max: 10000, ttl: 1000 })
    };
    
    // Anomaly detection
    this.anomalyDetectors = {
      hashrate: new AnomalyDetector(this.config.anomalyWindowSize),
      difficulty: new AnomalyDetector(this.config.anomalyWindowSize),
      shareTime: new AnomalyDetector(this.config.anomalyWindowSize),
      blockTime: new AnomalyDetector(this.config.anomalyWindowSize)
    };
    
    // Share validation tracking
    this.shareValidation = {
      total: 0,
      valid: 0,
      potentialBlocks: 0,
      actualBlocks: 0,
      suspiciousMiners: new Set()
    };
    
    // Nonce tracking
    this.nonceCache = new LRUCache({ 
      max: 1000000, 
      ttl: this.config.nonceReuseWindow 
    });
    
    // Challenge system
    this.activeChallenges = new Map();
    
    // Honeypot
    this.honeypotAddresses = new Set();
    
    // ML model for behavior analysis
    this.behaviorModel = null;
    
    // Attack statistics
    this.attackStats = {
      detected: new Map(),
      blocked: new Map(),
      falsePositives: 0
    };
  }

  async initialize(poolSystem) {
    this.poolSystem = poolSystem;
    
    logger.info(`Initializing advanced attack protection (Level: ${this.config.securityLevel})`);
    
    // Set up interceptors
    this.setupInterceptors();
    
    // Initialize ML model if enabled
    if (this.config.enableMachineLearning) {
      await this.initializeMachineLearning();
    }
    
    // Set up honeypot if enabled
    if (this.config.enableHoneypot) {
      this.setupHoneypot();
    }
    
    // Start monitoring
    this.startMonitoring();
    
    logger.info('Attack protection initialized');
  }

  // Connection validation
  async validateConnection(socket, info) {
    const ip = this.getClientIP(socket);
    const connectionId = crypto.randomBytes(16).toString('hex');
    
    // Check blacklist
    if (this.blacklist.has(ip)) {
      this.recordAttack(AttackType.DDOS, ip, 'Blacklisted IP');
      return { allowed: false, reason: 'blacklisted' };
    }
    
    // Check whitelist
    if (this.whitelist.has(ip)) {
      this.connections.set(connectionId, { ip, socket, trusted: true });
      return { allowed: true, connectionId };
    }
    
    // Rate limiting
    if (!this.checkRateLimit('connections', ip, this.config.maxConnectionsPerIP)) {
      this.recordAttack(AttackType.DDOS, ip, 'Connection rate limit exceeded');
      return { allowed: false, reason: 'rate_limit' };
    }
    
    // Geolocation check (if configured)
    if (this.config.allowedCountries) {
      const country = await this.getCountryFromIP(ip);
      if (!this.config.allowedCountries.includes(country)) {
        return { allowed: false, reason: 'geo_blocked' };
      }
    }
    
    // Proof of work challenge for suspicious IPs
    if (this.config.proofOfWorkRequired && this.isSuspicious(ip)) {
      const challenge = this.generateChallenge();
      this.activeChallenges.set(ip, challenge);
      return { 
        allowed: false, 
        reason: 'challenge_required',
        challenge: challenge
      };
    }
    
    // Store connection
    this.connections.set(connectionId, {
      ip,
      socket,
      connectedAt: Date.now(),
      shares: 0,
      lastShareTime: 0,
      hashrate: 0,
      suspicious: false
    });
    
    return { allowed: true, connectionId };
  }

  // Share validation with attack detection
  async validateShare(connectionId, share) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return { valid: false, reason: 'invalid_connection' };
    }
    
    const validations = [
      this.validateShareRate(connection, share),
      this.validateShareTime(share),
      this.validateShareDifficulty(share),
      this.validateNonce(share),
      this.detectBlockWithholding(connection, share),
      this.validateSharePattern(connection, share)
    ];
    
    const results = await Promise.all(validations);
    const failed = results.find(r => !r.valid);
    
    if (failed) {
      this.handleSuspiciousActivity(connection, failed.attack || AttackType.SHARE_FLOODING, failed.reason);
      return failed;
    }
    
    // Update connection stats
    connection.shares++;
    connection.lastShareTime = Date.now();
    
    // Track for block withholding detection
    this.shareValidation.total++;
    if (share.valid) this.shareValidation.valid++;
    
    return { valid: true };
  }

  // Rate limiting check
  checkRateLimit(type, identifier, limit) {
    const limiter = this.rateLimiters[type];
    const current = limiter.get(identifier) || 0;
    
    if (current >= limit) {
      return false;
    }
    
    limiter.set(identifier, current + 1);
    return true;
  }

  // Share rate validation
  validateShareRate(connection, share) {
    const now = Date.now();
    const timeSinceLastShare = now - connection.lastShareTime;
    
    // Check share rate
    if (!this.checkRateLimit('shares', connection.ip, this.config.maxSharesPerMinute)) {
      return { 
        valid: false, 
        reason: 'share_rate_exceeded',
        attack: AttackType.SHARE_FLOODING
      };
    }
    
    // Check for unrealistic share submission speed
    if (timeSinceLastShare < 10 && connection.shares > 10) { // Less than 10ms between shares
      return {
        valid: false,
        reason: 'unrealistic_share_speed',
        attack: AttackType.SHARE_FLOODING
      };
    }
    
    // Anomaly detection on share timing
    this.anomalyDetectors.shareTime.addSample(timeSinceLastShare);
    if (this.anomalyDetectors.shareTime.isAnomaly(timeSinceLastShare)) {
      return {
        valid: false,
        reason: 'anomalous_share_timing',
        attack: AttackType.SHARE_FLOODING
      };
    }
    
    return { valid: true };
  }

  // Time-based validation
  validateShareTime(share) {
    const now = Date.now();
    const shareTime = share.timestamp || parseInt(share.nTime, 16) * 1000;
    const drift = Math.abs(now - shareTime);
    
    if (drift > this.config.maxTimeDrift) {
      return {
        valid: false,
        reason: 'excessive_time_drift',
        attack: AttackType.TIME_WARP
      };
    }
    
    return { valid: true };
  }

  // Difficulty validation
  validateShareDifficulty(share) {
    const difficulty = this.parseShareDifficulty(share);
    
    // Check for difficulty manipulation
    this.anomalyDetectors.difficulty.addSample(difficulty);
    if (this.anomalyDetectors.difficulty.isAnomaly(difficulty)) {
      return {
        valid: false,
        reason: 'anomalous_difficulty',
        attack: AttackType.DIFFICULTY_MANIPULATION
      };
    }
    
    // Check if difficulty meets minimum requirements
    if (difficulty < this.poolSystem.getMinimumDifficulty()) {
      return {
        valid: false,
        reason: 'insufficient_difficulty'
      };
    }
    
    return { valid: true };
  }

  // Nonce validation
  validateNonce(share) {
    const nonceKey = `${share.jobId}:${share.nonce}`;
    
    // Check for nonce reuse
    if (this.nonceCache.has(nonceKey)) {
      return {
        valid: false,
        reason: 'nonce_reuse',
        attack: AttackType.REPLAY_ATTACK
      };
    }
    
    this.nonceCache.set(nonceKey, true);
    
    // Check nonce pattern for anomalies
    const nonceValue = parseInt(share.nonce, 16);
    if (this.isSequentialNonce(nonceValue)) {
      return {
        valid: false,
        reason: 'sequential_nonce_pattern',
        attack: AttackType.HASH_RATE_HIJACKING
      };
    }
    
    return { valid: true };
  }

  // Block withholding detection
  detectBlockWithholding(connection, share) {
    const difficulty = this.parseShareDifficulty(share);
    const networkDifficulty = this.poolSystem.getNetworkDifficulty();
    
    // Check if share could be a block
    if (difficulty >= networkDifficulty) {
      this.shareValidation.potentialBlocks++;
      connection.potentialBlocks = (connection.potentialBlocks || 0) + 1;
      
      // Mark for tracking
      share.potentialBlock = true;
    }
    
    // Statistical analysis for block withholding
    if (this.shareValidation.total > this.config.shareValidationSamples) {
      const expectedBlocks = this.shareValidation.potentialBlocks * 
        (this.poolSystem.getPoolDifficulty() / networkDifficulty);
      
      const blockRatio = this.shareValidation.actualBlocks / expectedBlocks;
      
      if (blockRatio < this.config.blockWithholdingThreshold) {
        // Potential block withholding attack
        this.identifySuspiciousMiners();
        return {
          valid: false,
          reason: 'suspected_block_withholding',
          attack: AttackType.BLOCK_WITHHOLDING
        };
      }
    }
    
    return { valid: true };
  }

  // Pattern-based validation
  validateSharePattern(connection, share) {
    if (!this.config.enableBehaviorAnalysis) {
      return { valid: true };
    }
    
    // Collect behavioral features
    const features = this.extractBehaviorFeatures(connection, share);
    
    // Check against known attack patterns
    const attackPattern = this.detectAttackPattern(features);
    if (attackPattern) {
      return {
        valid: false,
        reason: 'attack_pattern_detected',
        attack: attackPattern
      };
    }
    
    // ML-based detection if enabled
    if (this.behaviorModel && this.config.enableMachineLearning) {
      const prediction = this.behaviorModel.predict(features);
      if (prediction.isAttack && prediction.confidence > 0.8) {
        return {
          valid: false,
          reason: 'ml_detected_attack',
          attack: prediction.attackType
        };
      }
    }
    
    return { valid: true };
  }

  // Extract behavioral features
  extractBehaviorFeatures(connection, share) {
    const now = Date.now();
    const sessionDuration = now - connection.connectedAt;
    
    return {
      shareRate: connection.shares / (sessionDuration / 60000), // shares per minute
      avgTimeBetweenShares: sessionDuration / connection.shares,
      difficultyVariance: this.calculateVariance(connection.difficultyHistory || []),
      nonceDistribution: this.analyzeNonceDistribution(connection.nonceHistory || []),
      timeOfDay: new Date().getHours(),
      connectionUptime: sessionDuration,
      shareAcceptanceRate: connection.acceptedShares / connection.shares,
      potentialBlockRatio: (connection.potentialBlocks || 0) / connection.shares
    };
  }

  // Detect known attack patterns
  detectAttackPattern(features) {
    // Pool hopping detection
    if (features.connectionUptime < 300000 && features.shareRate > 100) {
      return AttackType.POOL_HOPPING;
    }
    
    // Selfish mining detection
    if (features.potentialBlockRatio > 0.01 && features.shareAcceptanceRate < 0.5) {
      return AttackType.SELFISH_MINING;
    }
    
    // Hash rate hijacking
    if (features.shareRate > 1000 && features.difficultyVariance < 0.01) {
      return AttackType.HASH_RATE_HIJACKING;
    }
    
    return null;
  }

  // Suspicious activity handling
  handleSuspiciousActivity(connection, attackType, reason) {
    const ip = connection.ip;
    
    // Update suspicion score
    const currentScore = this.suspicionScores.get(ip) || 0;
    const newScore = currentScore + this.getAttackSeverity(attackType);
    this.suspicionScores.set(ip, newScore);
    
    // Log attack
    this.recordAttack(attackType, ip, reason);
    
    // Take action based on score
    if (newScore >= this.config.suspicionThreshold) {
      this.blacklistIP(ip, `Multiple suspicious activities: ${reason}`);
    } else if (newScore >= this.config.suspicionThreshold * 0.5) {
      // Increase monitoring
      connection.suspicious = true;
      this.emit('suspicious-activity', {
        ip,
        attackType,
        reason,
        score: newScore
      });
    }
  }

  // Attack severity scoring
  getAttackSeverity(attackType) {
    const severities = {
      [AttackType.DDOS]: 2,
      [AttackType.SHARE_FLOODING]: 1,
      [AttackType.BLOCK_WITHHOLDING]: 5,
      [AttackType.SELFISH_MINING]: 5,
      [AttackType.TIME_WARP]: 3,
      [AttackType.SYBIL]: 4,
      [AttackType.DOUBLE_SPEND]: 5,
      [AttackType.HASH_RATE_HIJACKING]: 4,
      [AttackType.POOL_HOPPING]: 2,
      [AttackType.DIFFICULTY_MANIPULATION]: 3,
      [AttackType.STRATUM_EXPLOITS]: 4,
      [AttackType.REPLAY_ATTACK]: 3
    };
    
    return severities[attackType] || 1;
  }

  // IP blacklisting
  blacklistIP(ip, reason) {
    logger.warn(`Blacklisting IP ${ip}: ${reason}`);
    
    this.blacklist.add(ip);
    
    // Disconnect all connections from this IP
    for (const [id, connection] of this.connections) {
      if (connection.ip === ip) {
        connection.socket.destroy();
        this.connections.delete(id);
      }
    }
    
    // Schedule removal
    setTimeout(() => {
      this.blacklist.delete(ip);
      this.suspicionScores.delete(ip);
    }, this.config.blacklistDuration);
    
    this.emit('ip-blacklisted', { ip, reason });
  }

  // Challenge system for proof of work
  generateChallenge() {
    const challenge = {
      id: crypto.randomBytes(16).toString('hex'),
      target: crypto.randomBytes(32).toString('hex'),
      difficulty: this.config.challengeComplexity,
      created: Date.now(),
      expires: Date.now() + 60000 // 1 minute
    };
    
    return challenge;
  }

  validateChallengeResponse(ip, response) {
    const challenge = this.activeChallenges.get(ip);
    if (!challenge) {
      return false;
    }
    
    // Check expiry
    if (Date.now() > challenge.expires) {
      this.activeChallenges.delete(ip);
      return false;
    }
    
    // Validate proof of work
    const hash = crypto.createHash('sha256')
      .update(challenge.target + response.nonce)
      .digest('hex');
    
    const hashValue = parseInt(hash.substring(0, 8), 16);
    const target = Math.pow(2, 32 - challenge.difficulty);
    
    if (hashValue < target) {
      this.activeChallenges.delete(ip);
      // Reduce suspicion score
      const score = this.suspicionScores.get(ip) || 0;
      this.suspicionScores.set(ip, Math.max(0, score - 1));
      return true;
    }
    
    return false;
  }

  // Honeypot system
  setupHoneypot() {
    // Create fake high-value addresses
    const honeypotCount = 5;
    for (let i = 0; i < honeypotCount; i++) {
      const address = this.generateHoneypotAddress();
      this.honeypotAddresses.add(address);
    }
    
    logger.info(`Honeypot activated with ${honeypotCount} addresses`);
  }

  generateHoneypotAddress() {
    // Generate realistic-looking mining address
    return '1' + crypto.randomBytes(25).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 33);
  }

  checkHoneypotAccess(address) {
    if (this.honeypotAddresses.has(address)) {
      return true;
    }
    return false;
  }

  // Machine learning integration
  async initializeMachineLearning() {
    try {
      // Load pre-trained model or train new one
      // This would integrate with TensorFlow.js or similar
      logger.info('Initializing ML-based attack detection');
      
      // Simplified ML model structure
      this.behaviorModel = {
        predict: (features) => {
          // Simplified prediction logic
          const score = this.calculateAnomalyScore(features);
          return {
            isAttack: score > 0.7,
            confidence: score,
            attackType: score > 0.9 ? AttackType.BLOCK_WITHHOLDING : AttackType.SHARE_FLOODING
          };
        }
      };
    } catch (error) {
      logger.error('Failed to initialize ML model:', error);
      this.config.enableMachineLearning = false;
    }
  }

  calculateAnomalyScore(features) {
    // Simplified anomaly scoring
    let score = 0;
    
    if (features.shareRate > 200) score += 0.3;
    if (features.difficultyVariance < 0.01) score += 0.2;
    if (features.shareAcceptanceRate < 0.8) score += 0.2;
    if (features.potentialBlockRatio > 0.001) score += 0.3;
    
    return Math.min(1, score);
  }

  // Monitoring and alerting
  startMonitoring() {
    // Periodic security checks
    setInterval(() => {
      this.performSecurityAudit();
    }, 300000); // Every 5 minutes
    
    // Clean up old data
    setInterval(() => {
      this.cleanupOldData();
    }, 3600000); // Every hour
  }

  performSecurityAudit() {
    const audit = {
      timestamp: Date.now(),
      activeConnections: this.connections.size,
      blacklistedIPs: this.blacklist.size,
      suspiciousIPs: this.suspicionScores.size,
      detectedAttacks: {}
    };
    
    // Count attacks by type
    for (const [type, count] of this.attackStats.detected) {
      audit.detectedAttacks[type] = count;
    }
    
    // Check for ongoing attacks
    const shareRate = this.calculateGlobalShareRate();
    if (shareRate > this.config.maxSharesPerMinute * 10) {
      this.emit('attack-detected', {
        type: AttackType.SHARE_FLOODING,
        severity: 'high',
        metric: 'global_share_rate',
        value: shareRate
      });
    }
    
    // Check block withholding
    if (this.shareValidation.total > 0) {
      const blockRate = this.shareValidation.actualBlocks / this.shareValidation.potentialBlocks;
      if (blockRate < 0.5 && this.shareValidation.potentialBlocks > 10) {
        this.emit('attack-detected', {
          type: AttackType.BLOCK_WITHHOLDING,
          severity: 'critical',
          metric: 'block_rate',
          value: blockRate
        });
      }
    }
    
    this.emit('security-audit', audit);
  }

  calculateGlobalShareRate() {
    let totalShares = 0;
    const now = Date.now();
    
    for (const connection of this.connections.values()) {
      const duration = (now - connection.connectedAt) / 60000; // minutes
      totalShares += connection.shares / duration;
    }
    
    return totalShares;
  }

  cleanupOldData() {
    // Clean up expired challenges
    for (const [ip, challenge] of this.activeChallenges) {
      if (Date.now() > challenge.expires) {
        this.activeChallenges.delete(ip);
      }
    }
    
    // Reset share validation stats periodically
    if (this.shareValidation.total > 1000000) {
      this.shareValidation.total = 0;
      this.shareValidation.valid = 0;
      this.shareValidation.potentialBlocks = 0;
      this.shareValidation.actualBlocks = 0;
    }
  }

  // Helper methods
  getClientIP(socket) {
    return socket.remoteAddress || socket._socket.remoteAddress;
  }

  async getCountryFromIP(ip) {
    try {
      // This would use a GeoIP service
      // For now, return a default
      return 'US';
    } catch (error) {
      return 'Unknown';
    }
  }

  parseShareDifficulty(share) {
    if (typeof share.difficulty === 'number') return share.difficulty;
    if (typeof share.difficulty === 'string') {
      return parseInt(share.difficulty, 16);
    }
    return 1;
  }

  isSuspicious(ip) {
    const score = this.suspicionScores.get(ip) || 0;
    return score > 0;
  }

  isSequentialNonce(nonce) {
    if (!this.lastNonces) this.lastNonces = [];
    
    this.lastNonces.push(nonce);
    if (this.lastNonces.length > 10) {
      this.lastNonces.shift();
    }
    
    if (this.lastNonces.length < 3) return false;
    
    // Check for sequential pattern
    let sequential = true;
    for (let i = 1; i < this.lastNonces.length; i++) {
      if (this.lastNonces[i] - this.lastNonces[i-1] !== 1) {
        sequential = false;
        break;
      }
    }
    
    return sequential;
  }

  calculateVariance(values) {
    if (values.length === 0) return 0;
    
    const mean = values.reduce((a, b) => a + b) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    
    return variance;
  }

  identifySuspiciousMiners() {
    // Analyze miners with high potential block counts but no actual blocks
    for (const [id, connection] of this.connections) {
      if (connection.potentialBlocks > 5 && !connection.actualBlocks) {
        this.shareValidation.suspiciousMiners.add(id);
        this.handleSuspiciousActivity(
          connection,
          AttackType.BLOCK_WITHHOLDING,
          'No blocks submitted despite potential blocks'
        );
      }
    }
  }

  recordAttack(type, source, details) {
    // Update attack statistics
    const detected = this.attackStats.detected.get(type) || 0;
    this.attackStats.detected.set(type, detected + 1);
    
    // Log attack
    logger.warn(`Attack detected: ${type} from ${source} - ${details}`);
    
    // Emit event
    this.emit('attack-recorded', {
      type,
      source,
      details,
      timestamp: Date.now()
    });
  }

  // Public API
  reportFalsePositive(connectionId) {
    this.attackStats.falsePositives++;
    
    const connection = this.connections.get(connectionId);
    if (connection) {
      // Reduce suspicion score
      const score = this.suspicionScores.get(connection.ip) || 0;
      this.suspicionScores.set(connection.ip, Math.max(0, score - 2));
    }
  }

  whitelistIP(ip, reason) {
    this.whitelist.add(ip);
    this.blacklist.delete(ip);
    this.suspicionScores.delete(ip);
    
    logger.info(`Whitelisted IP ${ip}: ${reason}`);
  }

  getSecurityStatistics() {
    return {
      level: this.config.securityLevel,
      connections: {
        active: this.connections.size,
        blacklisted: this.blacklist.size,
        whitelisted: this.whitelist.size,
        suspicious: Array.from(this.connections.values()).filter(c => c.suspicious).length
      },
      attacks: {
        detected: Object.fromEntries(this.attackStats.detected),
        blocked: Object.fromEntries(this.attackStats.blocked),
        falsePositives: this.attackStats.falsePositives
      },
      validation: {
        totalShares: this.shareValidation.total,
        validShares: this.shareValidation.valid,
        potentialBlocks: this.shareValidation.potentialBlocks,
        actualBlocks: this.shareValidation.actualBlocks,
        suspiciousMiners: this.shareValidation.suspiciousMiners.size
      },
      challenges: {
        active: this.activeChallenges.size,
        completed: this.challengesCompleted || 0
      }
    };
  }

  // Emergency response
  async emergencyLockdown(reason) {
    logger.error(`EMERGENCY LOCKDOWN: ${reason}`);
    
    // Reject all new connections
    this.config.securityLevel = SecurityLevel.PARANOID;
    
    // Disconnect all suspicious connections
    for (const [id, connection] of this.connections) {
      if (connection.suspicious || this.isSuspicious(connection.ip)) {
        connection.socket.destroy();
        this.connections.delete(id);
      }
    }
    
    // Increase all thresholds
    this.config.maxConnectionsPerIP = 1;
    this.config.maxSharesPerMinute = 100;
    this.config.suspicionThreshold = 1;
    
    this.emit('emergency-lockdown', { reason, timestamp: Date.now() });
  }

  // Shutdown
  shutdown() {
    logger.info('Shutting down attack protection system');
    
    // Clear all timers
    clearInterval(this.auditInterval);
    clearInterval(this.cleanupInterval);
    
    // Save attack statistics
    this.emit('shutdown', {
      attacks: Object.fromEntries(this.attackStats.detected),
      blocked: Object.fromEntries(this.attackStats.blocked)
    });
  }
}

// Anomaly detection helper class
class AnomalyDetector {
  constructor(windowSize) {
    this.windowSize = windowSize;
    this.samples = [];
    this.mean = 0;
    this.stdDev = 0;
  }

  addSample(value) {
    this.samples.push(value);
    
    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }
    
    this.updateStatistics();
  }

  updateStatistics() {
    if (this.samples.length === 0) return;
    
    // Calculate mean
    this.mean = this.samples.reduce((a, b) => a + b) / this.samples.length;
    
    // Calculate standard deviation
    const variance = this.samples.reduce((sum, val) => 
      sum + Math.pow(val - this.mean, 2), 0
    ) / this.samples.length;
    
    this.stdDev = Math.sqrt(variance);
  }

  isAnomaly(value, threshold = 3) {
    if (this.samples.length < 10) return false; // Not enough data
    
    const zScore = Math.abs((value - this.mean) / this.stdDev);
    return zScore > threshold;
  }

  getStatistics() {
    return {
      samples: this.samples.length,
      mean: this.mean,
      stdDev: this.stdDev
    };
  }
}

export default AdvancedAttackProtection;