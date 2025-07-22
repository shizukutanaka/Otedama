/**
 * Dynamic Fee Protection System
 * Automatic fee adjustment based on risk factors and market conditions
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

const logger = getLogger();

/**
 * Risk-based dynamic fee adjustment system
 */
export class DynamicFeeProtection extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Risk thresholds
      riskThresholds: {
        low: 0.3,
        medium: 0.6,
        high: 0.8,
        critical: 0.95
      },
      
      // Fee multipliers based on risk level
      feeMultipliers: {
        low: 1.0,      // Normal fees
        medium: 1.5,   // 50% increase
        high: 2.0,     // 100% increase
        critical: 3.0  // 200% increase
      },
      
      // Market volatility settings
      volatilityWindow: options.volatilityWindow || 3600000, // 1 hour
      volatilityThreshold: options.volatilityThreshold || 0.1, // 10% price change
      
      // Security incident response
      securityIncidentMultiplier: options.securityIncidentMultiplier || 2.5,
      securityCooldown: options.securityCooldown || 86400000, // 24 hours
      
      // Auto-adjustment settings
      adjustmentInterval: options.adjustmentInterval || 300000, // 5 minutes
      smoothingFactor: options.smoothingFactor || 0.3, // Smoothing for gradual changes
      
      // Reserve requirements
      minReserveRatio: options.minReserveRatio || 1.5, // 150% of daily payouts
      criticalReserveRatio: options.criticalReserveRatio || 1.1, // 110% emergency threshold
      
      // Price data sources
      priceUpdateInterval: options.priceUpdateInterval || 60000, // 1 minute
      
      ...options
    };
    
    // State tracking
    this.currentRiskLevel = 'low';
    this.currentMultiplier = 1.0;
    this.priceHistory = [];
    this.incidentHistory = [];
    this.reserveStatus = {
      current: 0,
      required: 0,
      ratio: 0
    };
    
    // Adjustment state
    this.isAdjusting = false;
    this.lastAdjustment = Date.now();
    this.adjustmentHistory = [];
    
    this.initialize();
  }

  /**
   * Initialize the dynamic protection system
   */
  async initialize() {
    try {
      logger.info('Initializing Dynamic Fee Protection System...');
      
      // Start monitoring services
      await this.startMonitoring();
      
      // Load historical data
      await this.loadHistoricalData();
      
      logger.info('Dynamic Fee Protection System initialized');
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Failed to initialize Dynamic Fee Protection:', error);
      this.emit('error', error);
    }
  }

  /**
   * Start all monitoring services
   */
  async startMonitoring() {
    // Price monitoring
    this.priceMonitor = setInterval(() => {
      this.updatePriceData();
    }, this.options.priceUpdateInterval);
    
    // Risk assessment
    this.riskMonitor = setInterval(() => {
      this.assessRisk();
    }, this.options.adjustmentInterval);
    
    // Reserve monitoring
    this.reserveMonitor = setInterval(() => {
      this.checkReserveStatus();
    }, 60000); // Every minute
  }

  /**
   * Calculate dynamic fee based on current conditions
   */
  calculateDynamicFee(baseFeeAmount, transactionType = 'standard') {
    // Get base risk multiplier
    let multiplier = this.currentMultiplier;
    
    // Check for active security incidents
    if (this.hasActiveSecurityIncident()) {
      multiplier = Math.max(multiplier, this.options.securityIncidentMultiplier);
    }
    
    // Check reserve status
    if (this.reserveStatus.ratio < this.options.criticalReserveRatio) {
      // Critical reserve level - increase fees significantly
      multiplier = Math.max(multiplier, 2.5);
    }
    
    // Apply transaction type modifiers
    switch (transactionType) {
      case 'withdrawal':
        multiplier *= 1.2; // Higher fees for withdrawals during risk
        break;
      case 'large_transaction':
        if (this.currentRiskLevel !== 'low') {
          multiplier *= 1.5; // Extra protection for large transactions
        }
        break;
    }
    
    // Calculate adjusted fee
    const adjustedFee = Math.floor(baseFeeAmount * multiplier);
    
    // Apply maximum cap (3x base fee maximum)
    const maxFee = baseFeeAmount * 3;
    const finalFee = Math.min(adjustedFee, maxFee);
    
    return {
      baseFee: baseFeeAmount,
      multiplier: multiplier,
      adjustedFee: finalFee,
      riskLevel: this.currentRiskLevel,
      reason: this.getAdjustmentReason()
    };
  }

  /**
   * Assess current risk level
   */
  async assessRisk() {
    const riskFactors = {
      marketVolatility: await this.calculateMarketVolatility(),
      securityThreat: this.getSecurityThreatLevel(),
      reserveHealth: this.getReserveHealthScore(),
      networkCongestion: await this.getNetworkCongestion(),
      anomalyScore: await this.calculateAnomalyScore()
    };
    
    // Calculate composite risk score (0-1)
    const weights = {
      marketVolatility: 0.25,
      securityThreat: 0.3,
      reserveHealth: 0.2,
      networkCongestion: 0.15,
      anomalyScore: 0.1
    };
    
    let riskScore = 0;
    for (const [factor, weight] of Object.entries(weights)) {
      riskScore += riskFactors[factor] * weight;
    }
    
    // Determine risk level
    const previousLevel = this.currentRiskLevel;
    this.currentRiskLevel = this.getRiskLevel(riskScore);
    
    // Update multiplier with smoothing
    const targetMultiplier = this.options.feeMultipliers[this.currentRiskLevel];
    this.currentMultiplier = this.smoothMultiplier(this.currentMultiplier, targetMultiplier);
    
    // Log risk assessment
    this.logRiskAssessment({
      timestamp: Date.now(),
      riskScore,
      riskLevel: this.currentRiskLevel,
      factors: riskFactors,
      multiplier: this.currentMultiplier
    });
    
    // Emit events if risk level changed
    if (previousLevel !== this.currentRiskLevel) {
      this.emit('risk-level-changed', {
        previous: previousLevel,
        current: this.currentRiskLevel,
        multiplier: this.currentMultiplier,
        factors: riskFactors
      });
    }
  }

  /**
   * Calculate market volatility
   */
  async calculateMarketVolatility() {
    if (this.priceHistory.length < 2) return 0;
    
    const recentPrices = this.priceHistory.slice(-60); // Last hour
    if (recentPrices.length < 2) return 0;
    
    // Calculate price volatility
    const prices = recentPrices.map(p => p.price);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    const volatility = stdDev / mean;
    
    // Calculate rapid price changes
    const priceChanges = [];
    for (let i = 1; i < recentPrices.length; i++) {
      const change = Math.abs(recentPrices[i].price - recentPrices[i-1].price) / recentPrices[i-1].price;
      priceChanges.push(change);
    }
    
    const maxChange = Math.max(...priceChanges);
    
    // Combine volatility metrics
    let volatilityScore = 0;
    
    // Standard deviation based score
    if (volatility > 0.2) volatilityScore = 1.0;
    else if (volatility > 0.1) volatilityScore = 0.7;
    else if (volatility > 0.05) volatilityScore = 0.4;
    else volatilityScore = 0.2;
    
    // Boost score for rapid changes
    if (maxChange > this.options.volatilityThreshold) {
      volatilityScore = Math.min(1.0, volatilityScore + 0.3);
    }
    
    return volatilityScore;
  }

  /**
   * Get security threat level
   */
  getSecurityThreatLevel() {
    const recentIncidents = this.incidentHistory.filter(
      incident => Date.now() - incident.timestamp < this.options.securityCooldown
    );
    
    if (recentIncidents.length === 0) return 0;
    
    // Calculate threat level based on incident severity and recency
    let threatLevel = 0;
    
    for (const incident of recentIncidents) {
      const age = Date.now() - incident.timestamp;
      const recencyFactor = 1 - (age / this.options.securityCooldown);
      
      let severity = 0;
      switch (incident.type) {
        case 'hack_attempt':
          severity = 0.8;
          break;
        case 'ddos_attack':
          severity = 0.6;
          break;
        case 'suspicious_activity':
          severity = 0.4;
          break;
        case 'unauthorized_access':
          severity = 0.9;
          break;
        default:
          severity = 0.3;
      }
      
      threatLevel = Math.max(threatLevel, severity * recencyFactor);
    }
    
    return threatLevel;
  }

  /**
   * Get reserve health score
   */
  getReserveHealthScore() {
    const ratio = this.reserveStatus.ratio;
    
    if (ratio >= this.options.minReserveRatio) {
      return 0; // Healthy reserves
    } else if (ratio >= this.options.criticalReserveRatio) {
      // Linear scale between critical and minimum
      return 0.5 * (this.options.minReserveRatio - ratio) / 
             (this.options.minReserveRatio - this.options.criticalReserveRatio);
    } else {
      // Critical - exponential increase
      return 0.5 + 0.5 * Math.pow((this.options.criticalReserveRatio - ratio) / this.options.criticalReserveRatio, 2);
    }
  }

  /**
   * Calculate anomaly score
   */
  async calculateAnomalyScore() {
    // Simplified anomaly detection
    const anomalies = [];
    
    // Check for unusual transaction patterns
    const recentTransactions = await this.getRecentTransactions();
    const avgSize = recentTransactions.reduce((sum, tx) => sum + tx.amount, 0) / recentTransactions.length;
    const unusualTxs = recentTransactions.filter(tx => tx.amount > avgSize * 10);
    
    if (unusualTxs.length > 0) {
      anomalies.push({ type: 'large_transactions', score: 0.6 });
    }
    
    // Check for unusual user behavior
    const userAnomalies = await this.detectUserAnomalies();
    if (userAnomalies > 0) {
      anomalies.push({ type: 'user_behavior', score: 0.4 * userAnomalies });
    }
    
    // Return highest anomaly score
    return anomalies.length > 0 ? Math.max(...anomalies.map(a => a.score)) : 0;
  }

  /**
   * Report security incident
   */
  reportSecurityIncident(incident) {
    const incidentRecord = {
      id: Date.now().toString(),
      timestamp: Date.now(),
      type: incident.type,
      severity: incident.severity,
      details: incident.details,
      automaticResponse: true
    };
    
    this.incidentHistory.push(incidentRecord);
    
    // Immediate risk reassessment
    this.assessRisk();
    
    logger.warn('Security incident reported:', incidentRecord);
    
    this.emit('security-incident', incidentRecord);
  }

  /**
   * Update reserve status
   */
  updateReserveStatus(current, required) {
    this.reserveStatus = {
      current,
      required,
      ratio: current / required,
      healthy: (current / required) >= this.options.minReserveRatio,
      critical: (current / required) < this.options.criticalReserveRatio,
      lastUpdate: Date.now()
    };
    
    if (this.reserveStatus.critical) {
      this.emit('critical-reserve-level', this.reserveStatus);
    }
  }

  /**
   * Get risk level from score
   */
  getRiskLevel(score) {
    if (score >= this.options.riskThresholds.critical) return 'critical';
    if (score >= this.options.riskThresholds.high) return 'high';
    if (score >= this.options.riskThresholds.medium) return 'medium';
    return 'low';
  }

  /**
   * Smooth multiplier changes
   */
  smoothMultiplier(current, target) {
    const diff = target - current;
    return current + (diff * this.options.smoothingFactor);
  }

  /**
   * Get adjustment reason
   */
  getAdjustmentReason() {
    const reasons = [];
    
    if (this.currentRiskLevel !== 'low') {
      reasons.push(`Risk level: ${this.currentRiskLevel}`);
    }
    
    if (this.hasActiveSecurityIncident()) {
      reasons.push('Active security incident');
    }
    
    if (this.reserveStatus.ratio < this.options.minReserveRatio) {
      reasons.push('Low reserve levels');
    }
    
    const volatility = this.priceHistory.length > 0 ? 
      this.calculateMarketVolatility() : 0;
    if (volatility > 0.5) {
      reasons.push('High market volatility');
    }
    
    return reasons.length > 0 ? reasons.join(', ') : 'Normal operations';
  }

  /**
   * Check for active security incidents
   */
  hasActiveSecurityIncident() {
    return this.incidentHistory.some(
      incident => Date.now() - incident.timestamp < this.options.securityCooldown
    );
  }

  /**
   * Get status report
   */
  getStatus() {
    return {
      currentRiskLevel: this.currentRiskLevel,
      currentMultiplier: this.currentMultiplier,
      reserveStatus: this.reserveStatus,
      activeIncidents: this.incidentHistory.filter(
        i => Date.now() - i.timestamp < this.options.securityCooldown
      ).length,
      priceVolatility: this.priceHistory.length > 0 ? 
        this.calculateMarketVolatility() : 0,
      lastAdjustment: this.lastAdjustment,
      adjustmentReason: this.getAdjustmentReason()
    };
  }

  /**
   * Mock methods for data retrieval (implement with actual data sources)
   */
  async updatePriceData() {
    // In production, fetch from price feed service
    const mockPrice = 50000 + (Math.random() - 0.5) * 5000;
    this.priceHistory.push({
      price: mockPrice,
      timestamp: Date.now()
    });
    
    // Keep only recent history
    const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
    this.priceHistory = this.priceHistory.filter(p => p.timestamp > cutoff);
  }

  async getNetworkCongestion() {
    // In production, check actual network metrics
    return Math.random() * 0.3; // Mock low congestion
  }

  async getRecentTransactions() {
    // In production, fetch from database
    return Array.from({ length: 10 }, () => ({
      amount: Math.random() * 1000000,
      timestamp: Date.now() - Math.random() * 3600000
    }));
  }

  async detectUserAnomalies() {
    // In production, run actual anomaly detection
    return Math.random() < 0.1 ? 0.5 : 0;
  }

  async loadHistoricalData() {
    // In production, load from database
    logger.info('Historical data loaded');
  }

  async checkReserveStatus() {
    // In production, calculate from actual balances
    const mockCurrent = 100 + Math.random() * 50;
    const mockRequired = 100;
    this.updateReserveStatus(mockCurrent, mockRequired);
  }

  logRiskAssessment(assessment) {
    this.adjustmentHistory.push(assessment);
    
    // Keep only recent history
    const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 days
    this.adjustmentHistory = this.adjustmentHistory.filter(a => a.timestamp > cutoff);
  }
}

// Create singleton instance
export const dynamicFeeProtection = new DynamicFeeProtection();

export default DynamicFeeProtection;