/**
 * Advanced Share Validator - Otedama
 * ML-powered share validation with fraud detection
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { createHash } from 'crypto';
import * as tf from '@tensorflow/tfjs-node';
import { LRUCache } from 'lru-cache';

const logger = createStructuredLogger('AdvancedShareValidator');

// Validation result types
export const ValidationResult = {
  VALID: 'valid',
  INVALID: 'invalid',
  SUSPICIOUS: 'suspicious',
  DUPLICATE: 'duplicate',
  STALE: 'stale',
  LOW_DIFFICULTY: 'low_difficulty',
  FRAUDULENT: 'fraudulent'
};

// Fraud detection types
export const FraudType = {
  HASH_FLOODING: 'hash_flooding',
  TIME_MANIPULATION: 'time_manipulation',
  DIFFICULTY_MANIPULATION: 'difficulty_manipulation',
  NONCE_PATTERN: 'nonce_pattern',
  POOL_HOPPING: 'pool_hopping',
  BLOCK_WITHHOLDING: 'block_withholding',
  SELFISH_MINING: 'selfish_mining',
  SHARE_STEALING: 'share_stealing'
};

export class AdvancedShareValidator extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Validation settings
      strictMode: options.strictMode !== false,
      maxShareAge: options.maxShareAge || 120000, // 2 minutes
      minDifficulty: options.minDifficulty || 1,
      difficultyWindow: options.difficultyWindow || 0.95, // Accept 95% of target difficulty
      
      // Duplicate detection
      duplicateWindow: options.duplicateWindow || 3600000, // 1 hour
      duplicateCacheSize: options.duplicateCacheSize || 100000,
      
      // Fraud detection
      enableFraudDetection: options.enableFraudDetection !== false,
      fraudThreshold: options.fraudThreshold || 0.7, // 70% confidence
      suspiciousThreshold: options.suspiciousThreshold || 0.5,
      
      // Rate limiting
      maxSharesPerMinute: options.maxSharesPerMinute || 1000,
      maxSharesPerWorker: options.maxSharesPerWorker || 100,
      burstAllowance: options.burstAllowance || 1.5, // 50% burst allowed
      
      // Pattern detection
      patternDetection: options.patternDetection !== false,
      anomalyDetection: options.anomalyDetection !== false,
      mlValidation: options.mlValidation !== false,
      
      // Behavioral analysis
      workerProfiling: options.workerProfiling !== false,
      profileHistoryDays: options.profileHistoryDays || 30,
      
      ...options
    };
    
    // Share caches
    this.shareCache = new LRUCache({
      max: this.options.duplicateCacheSize,
      ttl: this.options.duplicateWindow
    });
    
    this.nonceCache = new LRUCache({
      max: 50000,
      ttl: 300000 // 5 minutes
    });
    
    // Worker tracking
    this.workerProfiles = new Map();
    this.workerStats = new Map();
    this.suspiciousWorkers = new Map();
    
    // Pattern detection
    this.patterns = new Map();
    this.anomalies = [];
    
    // ML models
    this.models = {
      fraudDetector: null,
      anomalyDetector: null,
      patternClassifier: null
    };
    
    // Validation statistics
    this.stats = {
      totalValidated: 0,
      validShares: 0,
      invalidShares: 0,
      suspiciousShares: 0,
      fraudulentShares: 0,
      duplicates: 0,
      staleShares: 0,
      fraudsDetected: new Map()
    };
    
    // Rate limiters
    this.rateLimiters = {
      global: new Map(),
      worker: new Map()
    };
  }
  
  /**
   * Initialize validator
   */
  async initialize() {
    logger.info('Initializing advanced share validator');
    
    try {
      // Initialize ML models if enabled
      if (this.options.mlValidation) {
        await this.initializeMLModels();
      }
      
      // Load fraud patterns
      await this.loadFraudPatterns();
      
      // Start cleanup timers
      this.startCleanupTimers();
      
      logger.info('Share validator initialized', {
        fraudDetection: this.options.enableFraudDetection,
        mlValidation: this.options.mlValidation,
        strictMode: this.options.strictMode
      });
      
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Failed to initialize share validator', { error: error.message });
      throw error;
    }
  }
  
  /**
   * Validate share
   */
  async validateShare(share, context = {}) {
    const validationStart = Date.now();
    
    const validation = {
      shareId: share.id || this.generateShareId(share),
      result: ValidationResult.VALID,
      confidence: 1.0,
      fraudScore: 0,
      fraudTypes: [],
      details: {},
      timestamp: Date.now()
    };
    
    try {
      // Basic validation
      const basicValidation = this.performBasicValidation(share, context);
      if (basicValidation.result !== ValidationResult.VALID) {
        validation.result = basicValidation.result;
        validation.details = basicValidation.details;
        this.updateStats(validation.result);
        return validation;
      }
      
      // Duplicate check
      if (this.isDuplicate(share)) {
        validation.result = ValidationResult.DUPLICATE;
        validation.details.reason = 'duplicate_share';
        this.stats.duplicates++;
        return validation;
      }
      
      // Rate limiting
      const rateLimitCheck = this.checkRateLimits(share.workerId);
      if (!rateLimitCheck.allowed) {
        validation.result = ValidationResult.SUSPICIOUS;
        validation.fraudScore = 0.6;
        validation.fraudTypes.push(FraudType.HASH_FLOODING);
        validation.details.rateLimit = rateLimitCheck;
      }
      
      // Fraud detection
      if (this.options.enableFraudDetection) {
        const fraudAnalysis = await this.detectFraud(share, context);
        validation.fraudScore = fraudAnalysis.score;
        validation.fraudTypes = fraudAnalysis.types;
        
        if (fraudAnalysis.score >= this.options.fraudThreshold) {
          validation.result = ValidationResult.FRAUDULENT;
          validation.confidence = fraudAnalysis.confidence;
          validation.details.fraud = fraudAnalysis.details;
        } else if (fraudAnalysis.score >= this.options.suspiciousThreshold) {
          validation.result = ValidationResult.SUSPICIOUS;
          validation.confidence = 1 - fraudAnalysis.score;
        }
      }
      
      // ML validation if enabled and not already flagged
      if (this.options.mlValidation && validation.result === ValidationResult.VALID) {
        const mlValidation = await this.performMLValidation(share, context);
        if (!mlValidation.valid) {
          validation.result = ValidationResult.SUSPICIOUS;
          validation.confidence = mlValidation.confidence;
          validation.details.ml = mlValidation.details;
        }
      }
      
      // Update worker profile
      if (this.options.workerProfiling) {
        await this.updateWorkerProfile(share.workerId, share, validation);
      }
      
      // Cache valid share
      if (validation.result === ValidationResult.VALID) {
        this.cacheShare(share);
      }
      
      // Record validation time
      validation.validationTime = Date.now() - validationStart;
      
      // Update statistics
      this.updateStats(validation.result);
      this.stats.totalValidated++;
      
      // Emit events for suspicious/fraudulent shares
      if (validation.result === ValidationResult.SUSPICIOUS) {
        this.emit('suspicious:share', { share, validation });
      } else if (validation.result === ValidationResult.FRAUDULENT) {
        this.emit('fraud:detected', { share, validation });
        this.handleFraudDetection(share, validation);
      }
      
      return validation;
      
    } catch (error) {
      logger.error('Share validation failed', {
        shareId: validation.shareId,
        error: error.message
      });
      
      validation.result = ValidationResult.INVALID;
      validation.details.error = error.message;
      
      return validation;
    }
  }
  
  /**
   * Perform basic validation
   */
  performBasicValidation(share, context) {
    // Check required fields
    if (!share.nonce || !share.hash || !share.workerId) {
      return {
        result: ValidationResult.INVALID,
        details: { reason: 'missing_required_fields' }
      };
    }
    
    // Check share age
    const shareAge = Date.now() - (share.timestamp || 0);
    if (shareAge > this.options.maxShareAge) {
      return {
        result: ValidationResult.STALE,
        details: { 
          reason: 'share_too_old',
          age: shareAge,
          maxAge: this.options.maxShareAge
        }
      };
    }
    
    // Validate hash format
    if (!this.isValidHash(share.hash)) {
      return {
        result: ValidationResult.INVALID,
        details: { reason: 'invalid_hash_format' }
      };
    }
    
    // Check difficulty
    const difficulty = this.calculateDifficulty(share.hash);
    const targetDifficulty = context.difficulty || this.options.minDifficulty;
    
    if (difficulty < targetDifficulty * this.options.difficultyWindow) {
      return {
        result: ValidationResult.LOW_DIFFICULTY,
        details: {
          reason: 'insufficient_difficulty',
          difficulty,
          required: targetDifficulty,
          threshold: targetDifficulty * this.options.difficultyWindow
        }
      };
    }
    
    // Verify proof of work
    if (!this.verifyProofOfWork(share, context)) {
      return {
        result: ValidationResult.INVALID,
        details: { reason: 'invalid_proof_of_work' }
      };
    }
    
    return { result: ValidationResult.VALID };
  }
  
  /**
   * Detect fraud
   */
  async detectFraud(share, context) {
    const fraudAnalysis = {
      score: 0,
      confidence: 0,
      types: [],
      details: {}
    };
    
    const fraudChecks = [
      this.checkHashFlooding(share),
      this.checkTimeManipulation(share),
      this.checkDifficultyManipulation(share, context),
      this.checkNoncePatterns(share),
      this.checkPoolHopping(share),
      this.checkBlockWithholding(share, context),
      this.checkShareStealing(share)
    ];
    
    // Run all fraud checks
    const results = await Promise.all(fraudChecks);
    
    // Aggregate results
    let totalWeight = 0;
    let weightedScore = 0;
    
    for (const result of results) {
      if (result.detected) {
        fraudAnalysis.types.push(result.type);
        fraudAnalysis.details[result.type] = result.details;
        
        weightedScore += result.score * result.weight;
        totalWeight += result.weight;
      }
    }
    
    // Calculate final fraud score
    if (totalWeight > 0) {
      fraudAnalysis.score = weightedScore / totalWeight;
      fraudAnalysis.confidence = Math.min(totalWeight / results.length, 1);
    }
    
    // Check worker history
    const workerReputation = this.getWorkerReputation(share.workerId);
    if (workerReputation < 0.5) {
      fraudAnalysis.score = Math.min(1, fraudAnalysis.score * 1.5);
      fraudAnalysis.details.workerReputation = workerReputation;
    }
    
    return fraudAnalysis;
  }
  
  /**
   * Check for hash flooding attack
   */
  async checkHashFlooding(share) {
    const workerId = share.workerId;
    const stats = this.getWorkerStats(workerId);
    
    // Calculate share rate
    const recentShares = stats.recentShares || [];
    const minuteAgo = Date.now() - 60000;
    const sharesLastMinute = recentShares.filter(t => t > minuteAgo).length;
    
    // Check against limits
    const limit = this.options.maxSharesPerWorker;
    const burstLimit = limit * this.options.burstAllowance;
    
    if (sharesLastMinute > burstLimit) {
      return {
        detected: true,
        type: FraudType.HASH_FLOODING,
        score: Math.min(1, sharesLastMinute / (burstLimit * 2)),
        weight: 0.8,
        details: {
          sharesLastMinute,
          limit,
          burstLimit
        }
      };
    }
    
    return { detected: false };
  }
  
  /**
   * Check for time manipulation
   */
  async checkTimeManipulation(share) {
    const timeDiff = Math.abs(Date.now() - share.timestamp);
    const maxDrift = 30000; // 30 seconds
    
    if (timeDiff > maxDrift) {
      // Check if consistently manipulating time
      const stats = this.getWorkerStats(share.workerId);
      const recentDrifts = stats.timeDrifts || [];
      recentDrifts.push(timeDiff);
      
      // Keep last 100 drifts
      if (recentDrifts.length > 100) {
        recentDrifts.shift();
      }
      
      stats.timeDrifts = recentDrifts;
      
      // Calculate average drift
      const avgDrift = recentDrifts.reduce((a, b) => a + b, 0) / recentDrifts.length;
      
      if (avgDrift > maxDrift) {
        return {
          detected: true,
          type: FraudType.TIME_MANIPULATION,
          score: Math.min(1, avgDrift / (maxDrift * 3)),
          weight: 0.6,
          details: {
            timeDiff,
            avgDrift,
            maxDrift
          }
        };
      }
    }
    
    return { detected: false };
  }
  
  /**
   * Check for nonce patterns
   */
  async checkNoncePatterns(share) {
    const nonce = BigInt(share.nonce);
    const stats = this.getWorkerStats(share.workerId);
    
    // Track nonce history
    const nonceHistory = stats.nonceHistory || [];
    nonceHistory.push(nonce);
    
    if (nonceHistory.length > 100) {
      nonceHistory.shift();
    }
    
    stats.nonceHistory = nonceHistory;
    
    // Detect patterns
    if (nonceHistory.length >= 10) {
      // Check for sequential nonces
      let sequential = 0;
      for (let i = 1; i < nonceHistory.length; i++) {
        if (nonceHistory[i] === nonceHistory[i-1] + 1n) {
          sequential++;
        }
      }
      
      const sequentialRatio = sequential / (nonceHistory.length - 1);
      
      if (sequentialRatio > 0.7) {
        return {
          detected: true,
          type: FraudType.NONCE_PATTERN,
          score: sequentialRatio,
          weight: 0.7,
          details: {
            pattern: 'sequential',
            ratio: sequentialRatio,
            samples: nonceHistory.length
          }
        };
      }
      
      // Check for fixed patterns
      const nonceSet = new Set(nonceHistory.map(n => n % 1000n));
      const uniqueRatio = nonceSet.size / nonceHistory.length;
      
      if (uniqueRatio < 0.3) {
        return {
          detected: true,
          type: FraudType.NONCE_PATTERN,
          score: 1 - uniqueRatio,
          weight: 0.7,
          details: {
            pattern: 'fixed',
            uniqueRatio,
            samples: nonceHistory.length
          }
        };
      }
    }
    
    return { detected: false };
  }
  
  /**
   * Check for pool hopping
   */
  async checkPoolHopping(share) {
    const stats = this.getWorkerStats(share.workerId);
    const sessionHistory = stats.sessions || [];
    
    // Track session
    const currentSession = sessionHistory[sessionHistory.length - 1];
    
    if (!currentSession || Date.now() - currentSession.lastShare > 300000) {
      // New session
      sessionHistory.push({
        start: Date.now(),
        lastShare: Date.now(),
        shares: 1
      });
    } else {
      currentSession.lastShare = Date.now();
      currentSession.shares++;
    }
    
    // Keep last 50 sessions
    if (sessionHistory.length > 50) {
      sessionHistory.shift();
    }
    
    stats.sessions = sessionHistory;
    
    // Analyze hopping pattern
    if (sessionHistory.length >= 5) {
      const avgSessionDuration = sessionHistory
        .slice(-10)
        .reduce((sum, s) => sum + (s.lastShare - s.start), 0) / Math.min(10, sessionHistory.length);
      
      const avgSharesPerSession = sessionHistory
        .slice(-10)
        .reduce((sum, s) => sum + s.shares, 0) / Math.min(10, sessionHistory.length);
      
      // Suspicious if short sessions with few shares
      if (avgSessionDuration < 600000 && avgSharesPerSession < 10) {
        return {
          detected: true,
          type: FraudType.POOL_HOPPING,
          score: 0.8,
          weight: 0.6,
          details: {
            avgSessionDuration,
            avgSharesPerSession,
            sessionCount: sessionHistory.length
          }
        };
      }
    }
    
    return { detected: false };
  }
  
  /**
   * Check for block withholding
   */
  async checkBlockWithholding(share, context) {
    if (!context.isBlockCandidate) {
      return { detected: false };
    }
    
    const stats = this.getWorkerStats(share.workerId);
    stats.blockCandidates = (stats.blockCandidates || 0) + 1;
    
    // Check if share meets block difficulty but not submitted as block
    const blockDifficulty = context.blockDifficulty || context.difficulty * 1000;
    const shareDifficulty = this.calculateDifficulty(share.hash);
    
    if (shareDifficulty >= blockDifficulty && !share.isBlock) {
      stats.withheldBlocks = (stats.withheldBlocks || 0) + 1;
      
      const withholdingRatio = stats.withheldBlocks / stats.blockCandidates;
      
      if (withholdingRatio > 0.1) {
        return {
          detected: true,
          type: FraudType.BLOCK_WITHHOLDING,
          score: Math.min(1, withholdingRatio * 2),
          weight: 1.0, // High weight for block withholding
          details: {
            shareDifficulty,
            blockDifficulty,
            withheldBlocks: stats.withheldBlocks,
            totalCandidates: stats.blockCandidates
          }
        };
      }
    }
    
    return { detected: false };
  }
  
  /**
   * Check for share stealing
   */
  async checkShareStealing(share) {
    // Check if share was previously submitted by different worker
    const shareHash = this.getShareHash(share);
    const previousSubmission = this.shareCache.get(shareHash);
    
    if (previousSubmission && previousSubmission.workerId !== share.workerId) {
      return {
        detected: true,
        type: FraudType.SHARE_STEALING,
        score: 1.0,
        weight: 0.9,
        details: {
          originalWorker: previousSubmission.workerId,
          originalTime: previousSubmission.timestamp,
          currentWorker: share.workerId,
          timeDiff: share.timestamp - previousSubmission.timestamp
        }
      };
    }
    
    return { detected: false };
  }
  
  /**
   * Check difficulty manipulation
   */
  async checkDifficultyManipulation(share, context) {
    const stats = this.getWorkerStats(share.workerId);
    const shareDifficulty = this.calculateDifficulty(share.hash);
    const targetDifficulty = context.difficulty || this.options.minDifficulty;
    
    // Track difficulty history
    const diffHistory = stats.difficultyHistory || [];
    diffHistory.push({
      share: shareDifficulty,
      target: targetDifficulty,
      ratio: shareDifficulty / targetDifficulty
    });
    
    if (diffHistory.length > 100) {
      diffHistory.shift();
    }
    
    stats.difficultyHistory = diffHistory;
    
    // Check for consistent low difficulty submissions
    if (diffHistory.length >= 20) {
      const avgRatio = diffHistory
        .slice(-20)
        .reduce((sum, d) => sum + d.ratio, 0) / 20;
      
      if (avgRatio < 1.05) { // Consistently just above minimum
        return {
          detected: true,
          type: FraudType.DIFFICULTY_MANIPULATION,
          score: 1 - avgRatio,
          weight: 0.7,
          details: {
            avgRatio,
            samples: diffHistory.length,
            currentDifficulty: shareDifficulty,
            targetDifficulty
          }
        };
      }
    }
    
    return { detected: false };
  }
  
  /**
   * Initialize ML models
   */
  async initializeMLModels() {
    // Fraud detection model
    this.models.fraudDetector = tf.sequential({
      layers: [
        tf.layers.dense({
          inputShape: [15], // Various features
          units: 32,
          activation: 'relu'
        }),
        tf.layers.dropout({ rate: 0.3 }),
        tf.layers.dense({
          units: 16,
          activation: 'relu'
        }),
        tf.layers.dense({
          units: 8,
          activation: 'softmax' // Multi-class fraud types
        })
      ]
    });
    
    this.models.fraudDetector.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'categoricalCrossentropy',
      metrics: ['accuracy']
    });
    
    // Anomaly detection model (autoencoder)
    this.models.anomalyDetector = tf.sequential({
      layers: [
        // Encoder
        tf.layers.dense({
          inputShape: [20],
          units: 16,
          activation: 'relu'
        }),
        tf.layers.dense({
          units: 8,
          activation: 'relu'
        }),
        tf.layers.dense({
          units: 4,
          activation: 'relu'
        }),
        // Decoder
        tf.layers.dense({
          units: 8,
          activation: 'relu'
        }),
        tf.layers.dense({
          units: 16,
          activation: 'relu'
        }),
        tf.layers.dense({
          units: 20,
          activation: 'linear'
        })
      ]
    });
    
    this.models.anomalyDetector.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'meanSquaredError'
    });
    
    // Load pre-trained weights if available
    await this.loadModelWeights();
  }
  
  /**
   * Perform ML validation
   */
  async performMLValidation(share, context) {
    if (!this.models.fraudDetector) {
      return { valid: true, confidence: 1.0 };
    }
    
    try {
      // Extract features
      const features = this.extractShareFeatures(share, context);
      const input = tf.tensor2d([features]);
      
      // Fraud detection
      const fraudPrediction = await this.models.fraudDetector.predict(input).data();
      const maxFraudScore = Math.max(...fraudPrediction);
      const fraudType = fraudPrediction.indexOf(maxFraudScore);
      
      // Anomaly detection
      const reconstruction = await this.models.anomalyDetector.predict(input).data();
      const reconstructionError = features.reduce((sum, val, idx) => 
        sum + Math.pow(val - reconstruction[idx], 2), 0
      ) / features.length;
      
      input.dispose();
      
      const isAnomalous = reconstructionError > 0.1;
      const isFraudulent = maxFraudScore > this.options.fraudThreshold;
      
      return {
        valid: !isFraudulent && !isAnomalous,
        confidence: 1 - Math.max(maxFraudScore, reconstructionError),
        details: {
          fraudScore: maxFraudScore,
          fraudType: Object.values(FraudType)[fraudType],
          anomalyScore: reconstructionError,
          isAnomalous
        }
      };
      
    } catch (error) {
      logger.error('ML validation failed', { error: error.message });
      return { valid: true, confidence: 0.5 };
    }
  }
  
  /**
   * Extract features for ML
   */
  extractShareFeatures(share, context) {
    const stats = this.getWorkerStats(share.workerId);
    const now = Date.now();
    
    return [
      // Share characteristics
      this.calculateDifficulty(share.hash) / (context.difficulty || 1),
      (now - share.timestamp) / 1000, // Age in seconds
      share.nonce / Number.MAX_SAFE_INTEGER,
      
      // Worker behavior
      stats.shareRate || 0,
      stats.validRatio || 1,
      stats.avgDifficulty || 1,
      stats.sessionCount || 0,
      
      // Timing patterns
      stats.avgTimeBetweenShares || 60,
      stats.timeVariance || 0,
      
      // Historical fraud indicators
      stats.suspiciousCount || 0,
      stats.fraudCount || 0,
      stats.duplicateCount || 0,
      
      // Resource usage
      stats.avgHashrate || 0,
      stats.hashrateVariance || 0,
      
      // Contextual
      context.poolDifficulty || 1,
      context.blockHeight || 0,
      new Date().getHours() / 24, // Time of day
      new Date().getDay() / 7, // Day of week
      stats.accountAge || 0,
      stats.totalShares || 0
    ];
  }
  
  /**
   * Update worker profile
   */
  async updateWorkerProfile(workerId, share, validation) {
    let profile = this.workerProfiles.get(workerId);
    
    if (!profile) {
      profile = {
        workerId,
        firstSeen: Date.now(),
        reputation: 1.0,
        riskScore: 0,
        totalShares: 0,
        validShares: 0,
        suspiciousShares: 0,
        fraudulentShares: 0,
        patterns: [],
        alerts: []
      };
      this.workerProfiles.set(workerId, profile);
    }
    
    // Update counters
    profile.totalShares++;
    profile.lastSeen = Date.now();
    
    switch (validation.result) {
      case ValidationResult.VALID:
        profile.validShares++;
        profile.reputation = Math.min(1, profile.reputation * 1.001); // Slowly increase
        break;
        
      case ValidationResult.SUSPICIOUS:
        profile.suspiciousShares++;
        profile.reputation *= 0.95;
        profile.riskScore = Math.min(1, profile.riskScore + 0.1);
        break;
        
      case ValidationResult.FRAUDULENT:
        profile.fraudulentShares++;
        profile.reputation *= 0.8;
        profile.riskScore = Math.min(1, profile.riskScore + 0.3);
        
        // Add alert
        profile.alerts.push({
          timestamp: Date.now(),
          type: validation.fraudTypes[0],
          score: validation.fraudScore
        });
        break;
    }
    
    // Update risk score based on patterns
    if (profile.totalShares > 100) {
      const fraudRatio = profile.fraudulentShares / profile.totalShares;
      const suspiciousRatio = profile.suspiciousShares / profile.totalShares;
      
      profile.riskScore = fraudRatio * 0.7 + suspiciousRatio * 0.3;
    }
    
    // Save profile periodically
    if (profile.totalShares % 1000 === 0) {
      await this.saveWorkerProfile(profile);
    }
  }
  
  /**
   * Handle fraud detection
   */
  handleFraudDetection(share, validation) {
    const workerId = share.workerId;
    
    // Update suspicious workers list
    let suspicionLevel = this.suspiciousWorkers.get(workerId) || 0;
    suspicionLevel += validation.fraudScore;
    this.suspiciousWorkers.set(workerId, suspicionLevel);
    
    // Update fraud statistics
    for (const fraudType of validation.fraudTypes) {
      const count = this.stats.fraudsDetected.get(fraudType) || 0;
      this.stats.fraudsDetected.set(fraudType, count + 1);
    }
    
    // Take action based on fraud type and severity
    if (validation.fraudScore >= 0.9) {
      // Severe fraud - immediate action
      this.emit('fraud:severe', {
        workerId,
        share,
        validation,
        action: 'ban_recommended'
      });
    } else if (suspicionLevel > 5) {
      // Repeated suspicious behavior
      this.emit('fraud:repeated', {
        workerId,
        suspicionLevel,
        history: this.getWorkerHistory(workerId)
      });
    }
    
    // Log for analysis
    logger.warn('Fraud detected', {
      workerId,
      fraudTypes: validation.fraudTypes,
      score: validation.fraudScore,
      details: validation.details
    });
  }
  
  /**
   * Get worker statistics
   */
  getWorkerStats(workerId) {
    if (!this.workerStats.has(workerId)) {
      this.workerStats.set(workerId, {
        recentShares: [],
        shareRate: 0,
        validRatio: 1,
        avgDifficulty: 0,
        sessionCount: 0,
        suspiciousCount: 0,
        fraudCount: 0,
        duplicateCount: 0
      });
    }
    
    return this.workerStats.get(workerId);
  }
  
  /**
   * Get worker reputation
   */
  getWorkerReputation(workerId) {
    const profile = this.workerProfiles.get(workerId);
    return profile ? profile.reputation : 0.5; // Default neutral reputation
  }
  
  /**
   * Check rate limits
   */
  checkRateLimits(workerId) {
    const now = Date.now();
    const stats = this.getWorkerStats(workerId);
    
    // Update recent shares
    stats.recentShares = stats.recentShares.filter(t => now - t < 60000);
    stats.recentShares.push(now);
    
    const sharesLastMinute = stats.recentShares.length;
    const limit = this.options.maxSharesPerWorker;
    const burstLimit = limit * this.options.burstAllowance;
    
    return {
      allowed: sharesLastMinute <= burstLimit,
      current: sharesLastMinute,
      limit,
      burstLimit,
      remaining: Math.max(0, burstLimit - sharesLastMinute)
    };
  }
  
  /**
   * Check if share is duplicate
   */
  isDuplicate(share) {
    const shareHash = this.getShareHash(share);
    
    if (this.shareCache.has(shareHash)) {
      this.stats.duplicates++;
      return true;
    }
    
    return false;
  }
  
  /**
   * Cache share
   */
  cacheShare(share) {
    const shareHash = this.getShareHash(share);
    this.shareCache.set(shareHash, {
      workerId: share.workerId,
      timestamp: share.timestamp || Date.now()
    });
    
    // Also cache nonce to detect nonce reuse
    const nonceKey = `${share.workerId}:${share.nonce}`;
    this.nonceCache.set(nonceKey, true);
  }
  
  /**
   * Utility methods
   */
  
  generateShareId(share) {
    return createHash('sha256')
      .update(`${share.workerId}:${share.nonce}:${share.hash}:${share.timestamp}`)
      .digest('hex')
      .substring(0, 16);
  }
  
  getShareHash(share) {
    return createHash('sha256')
      .update(`${share.hash}:${share.nonce}`)
      .digest('hex');
  }
  
  isValidHash(hash) {
    return /^[0-9a-fA-F]{64}$/.test(hash);
  }
  
  calculateDifficulty(hash) {
    // Calculate difficulty from hash
    let difficulty = 0;
    for (let i = 0; i < hash.length; i++) {
      const byte = parseInt(hash.substr(i * 2, 2), 16);
      if (byte === 0) {
        difficulty += 8;
      } else {
        difficulty += Math.floor(Math.log2(256 / byte));
        break;
      }
    }
    return Math.pow(2, difficulty);
  }
  
  verifyProofOfWork(share, context) {
    // Verify the proof of work
    // This is algorithm-specific
    return true; // Simplified
  }
  
  updateStats(result) {
    switch (result) {
      case ValidationResult.VALID:
        this.stats.validShares++;
        break;
      case ValidationResult.INVALID:
        this.stats.invalidShares++;
        break;
      case ValidationResult.SUSPICIOUS:
        this.stats.suspiciousShares++;
        break;
      case ValidationResult.FRAUDULENT:
        this.stats.fraudulentShares++;
        break;
      case ValidationResult.STALE:
        this.stats.staleShares++;
        break;
    }
  }
  
  startCleanupTimers() {
    // Clean old data periodically
    setInterval(() => {
      const cutoff = Date.now() - 3600000; // 1 hour
      
      // Clean worker stats
      for (const [workerId, stats] of this.workerStats) {
        if (stats.recentShares) {
          stats.recentShares = stats.recentShares.filter(t => t > cutoff);
        }
      }
      
      // Clean anomaly history
      this.anomalies = this.anomalies.filter(a => a.timestamp > cutoff);
      
    }, 300000); // Every 5 minutes
  }
  
  async loadFraudPatterns() {
    // Load known fraud patterns
    // This would be loaded from a database or file
  }
  
  async loadModelWeights() {
    // Load pre-trained model weights
  }
  
  async saveWorkerProfile(profile) {
    // Save worker profile to storage
  }
  
  getWorkerHistory(workerId) {
    const profile = this.workerProfiles.get(workerId);
    const stats = this.workerStats.get(workerId);
    
    return {
      profile,
      stats,
      recentAlerts: profile?.alerts.slice(-10) || []
    };
  }
  
  /**
   * Get validation statistics
   */
  getStatistics() {
    return {
      ...this.stats,
      fraudsDetected: Object.fromEntries(this.stats.fraudsDetected),
      validRatio: this.stats.validShares / Math.max(1, this.stats.totalValidated),
      fraudRatio: this.stats.fraudulentShares / Math.max(1, this.stats.totalValidated),
      suspiciousWorkers: this.suspiciousWorkers.size,
      cachedShares: this.shareCache.size
    };
  }
  
  /**
   * Shutdown validator
   */
  async shutdown() {
    // Save models if ML is enabled
    if (this.options.mlValidation) {
      await this.saveModels();
    }
    
    // Save worker profiles
    for (const profile of this.workerProfiles.values()) {
      await this.saveWorkerProfile(profile);
    }
    
    logger.info('Share validator shutdown', this.getStatistics());
  }
  
  async saveModels() {
    // Save ML models
  }
}

export default AdvancedShareValidator;