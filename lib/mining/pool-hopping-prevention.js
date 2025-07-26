/**
 * Pool Hopping Prevention - Otedama
 * Prevents miners from exploiting pool reward systems
 * 
 * Design Principles:
 * - Carmack: Fast detection algorithms, minimal overhead
 * - Martin: Clean separation of detection strategies
 * - Pike: Simple but effective prevention mechanisms
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import crypto from 'crypto';

const logger = createStructuredLogger('PoolHoppingPrevention');

/**
 * Detection strategies
 */
const DETECTION_STRATEGIES = {
  SHARE_RATE_ANALYSIS: 'share_rate_analysis',
  CONNECTION_PATTERN: 'connection_pattern',
  ROUND_PARTICIPATION: 'round_participation',
  DIFFICULTY_MANIPULATION: 'difficulty_manipulation',
  TIMING_ANALYSIS: 'timing_analysis',
  STATISTICAL_ANOMALY: 'statistical_anomaly'
};

/**
 * Prevention methods
 */
const PREVENTION_METHODS = {
  SCORE_BASED: 'score_based',        // PPLNS with decay
  TIME_WEIGHTED: 'time_weighted',    // Time-based share weighting
  COMMITMENT_PROOF: 'commitment_proof', // Require commitment
  DYNAMIC_WINDOW: 'dynamic_window',  // Variable PPLNS window
  REPUTATION: 'reputation'           // Long-term reputation system
};

/**
 * Miner behavior profile
 */
class MinerProfile {
  constructor(minerId) {
    this.minerId = minerId;
    this.joinTime = Date.now();
    this.rounds = [];
    this.shareHistory = [];
    this.connectionHistory = [];
    this.suspicionScore = 0;
    this.reputation = 100;
    this.commitmentLevel = 0;
    this.statistics = {
      totalShares: 0,
      totalRounds: 0,
      averageRoundParticipation: 0,
      connectionStability: 1.0,
      shareRateVariance: 0
    };
  }
  
  addShare(share) {
    this.shareHistory.push({
      timestamp: share.timestamp,
      difficulty: share.difficulty,
      round: share.round
    });
    
    // Keep last 10000 shares
    if (this.shareHistory.length > 10000) {
      this.shareHistory.shift();
    }
    
    this.statistics.totalShares++;
  }
  
  addConnection(event) {
    this.connectionHistory.push({
      type: event.type,
      timestamp: event.timestamp,
      duration: event.duration || 0
    });
    
    // Keep last 100 connections
    if (this.connectionHistory.length > 100) {
      this.connectionHistory.shift();
    }
  }
  
  addRound(round) {
    this.rounds.push({
      id: round.id,
      joinTime: round.joinTime,
      leaveTime: round.leaveTime,
      shares: round.shares,
      percentage: round.percentage
    });
    
    // Keep last 100 rounds
    if (this.rounds.length > 100) {
      this.rounds.shift();
    }
    
    this.statistics.totalRounds++;
    this.updateStatistics();
  }
  
  updateStatistics() {
    // Calculate average round participation
    if (this.rounds.length > 0) {
      const participations = this.rounds.map(r => r.percentage || 0);
      this.statistics.averageRoundParticipation = 
        participations.reduce((a, b) => a + b, 0) / participations.length;
    }
    
    // Calculate connection stability
    const recentConnections = this.connectionHistory.slice(-10);
    const disconnects = recentConnections.filter(c => c.type === 'disconnect').length;
    this.statistics.connectionStability = 1 - (disconnects / 10);
    
    // Calculate share rate variance
    this.statistics.shareRateVariance = this.calculateShareRateVariance();
  }
  
  calculateShareRateVariance() {
    if (this.shareHistory.length < 10) return 0;
    
    // Calculate shares per minute for recent history
    const windowSize = 60000; // 1 minute windows
    const windows = new Map();
    
    for (const share of this.shareHistory) {
      const window = Math.floor(share.timestamp / windowSize);
      windows.set(window, (windows.get(window) || 0) + 1);
    }
    
    const rates = Array.from(windows.values());
    if (rates.length < 2) return 0;
    
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    const variance = rates.reduce((sum, rate) => sum + Math.pow(rate - mean, 2), 0) / rates.length;
    
    return Math.sqrt(variance) / mean; // Coefficient of variation
  }
}

/**
 * Pool Hopping Prevention System
 */
export class PoolHoppingPrevention extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Detection thresholds
      minRoundParticipation: config.minRoundParticipation || 0.5,
      maxShareRateVariance: config.maxShareRateVariance || 0.5,
      suspicionThreshold: config.suspicionThreshold || 50,
      
      // Prevention settings
      preventionMethod: config.preventionMethod || PREVENTION_METHODS.SCORE_BASED,
      pplnsWindow: config.pplnsWindow || 100000,
      decayFactor: config.decayFactor || 0.95,
      minCommitmentTime: config.minCommitmentTime || 3600000, // 1 hour
      
      // Penalties
      hopperPenalty: config.hopperPenalty || 0.5,
      reputationDecay: config.reputationDecay || 0.99,
      
      // Analysis settings
      analysisInterval: config.analysisInterval || 60000, // 1 minute
      roundTimeout: config.roundTimeout || 600000, // 10 minutes
      
      ...config
    };
    
    // State
    this.minerProfiles = new Map();
    this.currentRound = {
      id: crypto.randomUUID(),
      startTime: Date.now(),
      totalShares: 0,
      miners: new Map()
    };
    this.roundHistory = [];
    
    // Detection results
    this.detectedHoppers = new Set();
    this.suspiciousActivity = new Map();
    
    // Statistics
    this.stats = {
      totalMiners: 0,
      detectedHoppers: 0,
      preventedHops: 0,
      falsePositives: 0
    };
    
    // Start analysis
    this.analysisInterval = null;
    
    this.logger = logger;
  }
  
  /**
   * Start prevention system
   */
  start() {
    this.analysisInterval = setInterval(() => {
      this.analyzeMiners();
    }, this.config.analysisInterval);
    
    this.logger.info('Pool hopping prevention started', {
      method: this.config.preventionMethod,
      window: this.config.pplnsWindow
    });
  }
  
  /**
   * Stop prevention system
   */
  stop() {
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }
  }
  
  /**
   * Record miner connection
   */
  onMinerConnect(minerId, timestamp = Date.now()) {
    let profile = this.minerProfiles.get(minerId);
    
    if (!profile) {
      profile = new MinerProfile(minerId);
      this.minerProfiles.set(minerId, profile);
      this.stats.totalMiners++;
    }
    
    profile.addConnection({
      type: 'connect',
      timestamp
    });
    
    // Add to current round
    if (!this.currentRound.miners.has(minerId)) {
      this.currentRound.miners.set(minerId, {
        joinTime: timestamp,
        shares: 0
      });
    }
    
    this.emit('miner:connected', { minerId, timestamp });
  }
  
  /**
   * Record miner disconnection
   */
  onMinerDisconnect(minerId, timestamp = Date.now()) {
    const profile = this.minerProfiles.get(minerId);
    if (!profile) return;
    
    const connectTime = profile.connectionHistory
      .filter(c => c.type === 'connect')
      .pop()?.timestamp;
    
    const duration = connectTime ? timestamp - connectTime : 0;
    
    profile.addConnection({
      type: 'disconnect',
      timestamp,
      duration
    });
    
    // Check for suspicious early disconnection
    if (duration < this.config.minCommitmentTime) {
      this.detectSuspiciousBehavior(minerId, 'early_disconnect', {
        duration,
        threshold: this.config.minCommitmentTime
      });
    }
    
    this.emit('miner:disconnected', { minerId, timestamp, duration });
  }
  
  /**
   * Record share submission
   */
  onShareSubmitted(minerId, share) {
    const profile = this.minerProfiles.get(minerId);
    if (!profile) return;
    
    // Add to profile
    profile.addShare({
      ...share,
      round: this.currentRound.id
    });
    
    // Update round statistics
    this.currentRound.totalShares++;
    const roundMiner = this.currentRound.miners.get(minerId);
    if (roundMiner) {
      roundMiner.shares++;
    }
    
    // Apply prevention method
    const weight = this.calculateShareWeight(minerId, share);
    
    return {
      ...share,
      weight,
      hopper: this.detectedHoppers.has(minerId)
    };
  }
  
  /**
   * Handle new block found
   */
  onBlockFound(blockData) {
    // End current round
    this.endRound(blockData);
    
    // Start new round
    this.startNewRound();
  }
  
  /**
   * End current round
   */
  endRound(blockData) {
    const endTime = Date.now();
    const roundDuration = endTime - this.currentRound.startTime;
    
    // Calculate miner participation
    for (const [minerId, minerData] of this.currentRound.miners) {
      const profile = this.minerProfiles.get(minerId);
      if (!profile) continue;
      
      const participation = minerData.shares / this.currentRound.totalShares;
      const joinDuration = endTime - minerData.joinTime;
      const participationRate = joinDuration / roundDuration;
      
      profile.addRound({
        id: this.currentRound.id,
        joinTime: minerData.joinTime,
        leaveTime: endTime,
        shares: minerData.shares,
        percentage: participation,
        participationRate
      });
      
      // Check for pool hopping behavior
      if (participationRate < this.config.minRoundParticipation) {
        this.detectSuspiciousBehavior(minerId, 'low_participation', {
          rate: participationRate,
          threshold: this.config.minRoundParticipation
        });
      }
    }
    
    // Store round history
    this.roundHistory.push({
      ...this.currentRound,
      endTime,
      duration: roundDuration,
      blockData
    });
    
    // Keep last 100 rounds
    if (this.roundHistory.length > 100) {
      this.roundHistory.shift();
    }
  }
  
  /**
   * Start new round
   */
  startNewRound() {
    this.currentRound = {
      id: crypto.randomUUID(),
      startTime: Date.now(),
      totalShares: 0,
      miners: new Map()
    };
    
    // Re-add active miners
    for (const [minerId, profile] of this.minerProfiles) {
      const lastConnection = profile.connectionHistory
        .filter(c => c.type === 'connect')
        .pop();
      const lastDisconnection = profile.connectionHistory
        .filter(c => c.type === 'disconnect')
        .pop();
      
      // If connected and not disconnected since
      if (lastConnection && (!lastDisconnection || lastConnection.timestamp > lastDisconnection.timestamp)) {
        this.currentRound.miners.set(minerId, {
          joinTime: Date.now(),
          shares: 0
        });
      }
    }
  }
  
  /**
   * Calculate share weight based on prevention method
   */
  calculateShareWeight(minerId, share) {
    const profile = this.minerProfiles.get(minerId);
    if (!profile) return 1.0;
    
    let weight = 1.0;
    
    switch (this.config.preventionMethod) {
      case PREVENTION_METHODS.SCORE_BASED:
        weight = this.calculateScoreBasedWeight(profile, share);
        break;
        
      case PREVENTION_METHODS.TIME_WEIGHTED:
        weight = this.calculateTimeWeight(profile, share);
        break;
        
      case PREVENTION_METHODS.COMMITMENT_PROOF:
        weight = this.calculateCommitmentWeight(profile);
        break;
        
      case PREVENTION_METHODS.DYNAMIC_WINDOW:
        weight = this.calculateDynamicWindowWeight(profile, share);
        break;
        
      case PREVENTION_METHODS.REPUTATION:
        weight = this.calculateReputationWeight(profile);
        break;
    }
    
    // Apply hopper penalty if detected
    if (this.detectedHoppers.has(minerId)) {
      weight *= this.config.hopperPenalty;
    }
    
    return Math.max(0, Math.min(1, weight));
  }
  
  /**
   * Score-based weight (PPLNS with decay)
   */
  calculateScoreBasedWeight(profile, share) {
    const recentShares = profile.shareHistory.slice(-this.config.pplnsWindow);
    if (recentShares.length === 0) return 0;
    
    const now = share.timestamp;
    let totalScore = 0;
    let weightedScore = 0;
    
    for (const historicShare of recentShares) {
      const age = now - historicShare.timestamp;
      const decay = Math.pow(this.config.decayFactor, age / 3600000); // Decay per hour
      const score = historicShare.difficulty * decay;
      
      totalScore += historicShare.difficulty;
      weightedScore += score;
    }
    
    return totalScore > 0 ? weightedScore / totalScore : 0;
  }
  
  /**
   * Time-weighted share value
   */
  calculateTimeWeight(profile, share) {
    const connectionDuration = this.getConnectionDuration(profile);
    const minDuration = this.config.minCommitmentTime;
    
    if (connectionDuration < minDuration) {
      return connectionDuration / minDuration;
    }
    
    return 1.0;
  }
  
  /**
   * Commitment-based weight
   */
  calculateCommitmentWeight(profile) {
    const commitmentLevel = this.calculateCommitmentLevel(profile);
    return Math.min(1, commitmentLevel / 100);
  }
  
  /**
   * Dynamic window weight
   */
  calculateDynamicWindowWeight(profile, share) {
    // Adjust window size based on round participation
    const baseWindow = this.config.pplnsWindow;
    const participation = profile.statistics.averageRoundParticipation;
    const windowMultiplier = 0.5 + participation * 0.5; // 50% to 100% of base window
    
    const adjustedWindow = Math.floor(baseWindow * windowMultiplier);
    const recentShares = profile.shareHistory.slice(-adjustedWindow);
    
    return recentShares.length / adjustedWindow;
  }
  
  /**
   * Reputation-based weight
   */
  calculateReputationWeight(profile) {
    return profile.reputation / 100;
  }
  
  /**
   * Detect suspicious behavior
   */
  detectSuspiciousBehavior(minerId, type, details) {
    const profile = this.minerProfiles.get(minerId);
    if (!profile) return;
    
    // Increase suspicion score
    const scoreIncrease = this.getSuspicionScoreIncrease(type);
    profile.suspicionScore += scoreIncrease;
    
    // Record suspicious activity
    if (!this.suspiciousActivity.has(minerId)) {
      this.suspiciousActivity.set(minerId, []);
    }
    
    this.suspiciousActivity.get(minerId).push({
      type,
      details,
      timestamp: Date.now()
    });
    
    // Check if should mark as hopper
    if (profile.suspicionScore >= this.config.suspicionThreshold) {
      this.markAsHopper(minerId);
    }
    
    this.logger.warn('Suspicious behavior detected', {
      minerId,
      type,
      score: profile.suspicionScore,
      details
    });
    
    this.emit('suspicious:detected', {
      minerId,
      type,
      score: profile.suspicionScore,
      details
    });
  }
  
  /**
   * Mark miner as hopper
   */
  markAsHopper(minerId) {
    if (this.detectedHoppers.has(minerId)) return;
    
    this.detectedHoppers.add(minerId);
    this.stats.detectedHoppers++;
    
    const profile = this.minerProfiles.get(minerId);
    if (profile) {
      profile.reputation = Math.max(0, profile.reputation - 50);
    }
    
    this.logger.error('Pool hopper detected', { minerId });
    this.emit('hopper:detected', { minerId });
  }
  
  /**
   * Analyze all miners periodically
   */
  analyzeMiners() {
    for (const [minerId, profile] of this.minerProfiles) {
      this.analyzeMinerBehavior(minerId, profile);
      
      // Update reputation
      this.updateReputation(minerId, profile);
      
      // Update commitment level
      this.updateCommitmentLevel(minerId, profile);
    }
    
    // Clean old data
    this.cleanOldData();
  }
  
  /**
   * Analyze individual miner behavior
   */
  analyzeMinerBehavior(minerId, profile) {
    const checks = [
      this.checkShareRateAnomaly(profile),
      this.checkConnectionPattern(profile),
      this.checkRoundParticipation(profile),
      this.checkTimingAnalysis(profile)
    ];
    
    for (const check of checks) {
      if (check.suspicious) {
        this.detectSuspiciousBehavior(minerId, check.type, check.details);
      }
    }
  }
  
  /**
   * Check for share rate anomalies
   */
  checkShareRateAnomaly(profile) {
    const variance = profile.statistics.shareRateVariance;
    
    if (variance > this.config.maxShareRateVariance) {
      return {
        suspicious: true,
        type: 'share_rate_anomaly',
        details: {
          variance,
          threshold: this.config.maxShareRateVariance
        }
      };
    }
    
    return { suspicious: false };
  }
  
  /**
   * Check connection patterns
   */
  checkConnectionPattern(profile) {
    const stability = profile.statistics.connectionStability;
    
    if (stability < 0.5) {
      return {
        suspicious: true,
        type: 'unstable_connection',
        details: {
          stability,
          disconnects: profile.connectionHistory.filter(c => c.type === 'disconnect').length
        }
      };
    }
    
    return { suspicious: false };
  }
  
  /**
   * Check round participation
   */
  checkRoundParticipation(profile) {
    const participation = profile.statistics.averageRoundParticipation;
    
    if (participation < this.config.minRoundParticipation && profile.rounds.length > 5) {
      return {
        suspicious: true,
        type: 'low_round_participation',
        details: {
          participation,
          threshold: this.config.minRoundParticipation
        }
      };
    }
    
    return { suspicious: false };
  }
  
  /**
   * Check timing patterns
   */
  checkTimingAnalysis(profile) {
    if (profile.rounds.length < 10) return { suspicious: false };
    
    // Check if miner tends to join late in rounds
    const lateJoins = profile.rounds.filter(round => {
      const roundDuration = (round.leaveTime - round.joinTime);
      const joinDelay = round.joinTime - this.getRoundStartTime(round.id);
      return joinDelay > roundDuration * 0.5;
    });
    
    const lateJoinRate = lateJoins.length / profile.rounds.length;
    
    if (lateJoinRate > 0.5) {
      return {
        suspicious: true,
        type: 'timing_manipulation',
        details: {
          lateJoinRate,
          lateJoins: lateJoins.length
        }
      };
    }
    
    return { suspicious: false };
  }
  
  /**
   * Update miner reputation
   */
  updateReputation(minerId, profile) {
    // Decay suspicion over time
    profile.suspicionScore *= 0.99;
    
    // Increase reputation for good behavior
    if (!this.detectedHoppers.has(minerId)) {
      const goodBehaviorBonus = 0.1;
      profile.reputation = Math.min(100, profile.reputation + goodBehaviorBonus);
    }
    
    // Apply reputation decay for hoppers
    if (this.detectedHoppers.has(minerId)) {
      profile.reputation *= this.config.reputationDecay;
      
      // Remove from hopper list if reputation improves
      if (profile.reputation > 80 && profile.suspicionScore < 10) {
        this.detectedHoppers.delete(minerId);
        this.logger.info('Miner reputation restored', { minerId });
      }
    }
  }
  
  /**
   * Update commitment level
   */
  updateCommitmentLevel(minerId, profile) {
    const connectionDuration = this.getConnectionDuration(profile);
    const shareCount = profile.shareHistory.length;
    const roundParticipation = profile.statistics.averageRoundParticipation;
    
    // Calculate commitment score (0-100)
    const durationScore = Math.min(30, connectionDuration / 3600000 * 10); // Max 30 points for 3 hours
    const shareScore = Math.min(30, shareCount / 1000 * 10); // Max 30 points for 1000 shares
    const participationScore = roundParticipation * 40; // Max 40 points
    
    profile.commitmentLevel = durationScore + shareScore + participationScore;
  }
  
  /**
   * Helper methods
   */
  
  getConnectionDuration(profile) {
    const lastConnect = profile.connectionHistory
      .filter(c => c.type === 'connect')
      .pop();
    const lastDisconnect = profile.connectionHistory
      .filter(c => c.type === 'disconnect')
      .pop();
    
    if (!lastConnect) return 0;
    
    if (!lastDisconnect || lastConnect.timestamp > lastDisconnect.timestamp) {
      return Date.now() - lastConnect.timestamp;
    }
    
    return 0;
  }
  
  getRoundStartTime(roundId) {
    const round = this.roundHistory.find(r => r.id === roundId);
    return round ? round.startTime : this.currentRound.startTime;
  }
  
  getSuspicionScoreIncrease(type) {
    const scores = {
      early_disconnect: 10,
      low_participation: 15,
      share_rate_anomaly: 20,
      unstable_connection: 5,
      timing_manipulation: 25,
      low_round_participation: 15
    };
    
    return scores[type] || 5;
  }
  
  calculateCommitmentLevel(profile) {
    return profile.commitmentLevel;
  }
  
  /**
   * Clean old data
   */
  cleanOldData() {
    const cutoff = Date.now() - 86400000 * 7; // 7 days
    
    for (const [minerId, profile] of this.minerProfiles) {
      // Remove very old miners with no recent activity
      const lastActivity = Math.max(
        ...profile.shareHistory.map(s => s.timestamp),
        ...profile.connectionHistory.map(c => c.timestamp),
        0
      );
      
      if (lastActivity < cutoff) {
        this.minerProfiles.delete(minerId);
      }
    }
  }
  
  /**
   * Get prevention statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeMiner
      s: this.minerProfiles.size,
      currentHoppers: this.detectedHoppers.size,
      suspiciousMiners: this.suspiciousActivity.size,
      currentRound: {
        id: this.currentRound.id,
        duration: Date.now() - this.currentRound.startTime,
        miners: this.currentRound.miners.size,
        shares: this.currentRound.totalShares
      },
      preventionMethod: this.config.preventionMethod
    };
  }
  
  /**
   * Get miner status
   */
  getMinerStatus(minerId) {
    const profile = this.minerProfiles.get(minerId);
    if (!profile) return null;
    
    return {
      minerId,
      reputation: profile.reputation,
      commitmentLevel: profile.commitmentLevel,
      suspicionScore: profile.suspicionScore,
      isHopper: this.detectedHoppers.has(minerId),
      statistics: profile.statistics,
      currentWeight: this.calculateShareWeight(minerId, { timestamp: Date.now() })
    };
  }
  
  /**
   * Export hopper list
   */
  exportHopperList() {
    const hoppers = [];
    
    for (const minerId of this.detectedHoppers) {
      const profile = this.minerProfiles.get(minerId);
      if (profile) {
        hoppers.push({
          minerId,
          detectedAt: this.suspiciousActivity.get(minerId)?.[0]?.timestamp,
          suspicionScore: profile.suspicionScore,
          reputation: profile.reputation,
          evidence: this.suspiciousActivity.get(minerId) || []
        });
      }
    }
    
    return hoppers;
  }
}

export default PoolHoppingPrevention;