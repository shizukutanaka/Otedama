/**
 * Reserve Management System
 * Automated reserve monitoring and protection
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { dynamicFeeProtection } from './dynamic-fee-protection.js';

const logger = getLogger();

/**
 * Reserve management for financial protection
 */
export class ReserveManagementSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Reserve requirements
      targetReserveRatio: options.targetReserveRatio || 2.0, // 200% of daily payouts
      minimumReserveRatio: options.minimumReserveRatio || 1.5, // 150%
      criticalReserveRatio: options.criticalReserveRatio || 1.1, // 110%
      emergencyReserveRatio: options.emergencyReserveRatio || 0.9, // 90%
      
      // Payout limits
      maxSinglePayout: options.maxSinglePayout || 10000000, // 0.1 BTC in satoshis
      maxDailyPayout: options.maxDailyPayout || 100000000, // 1 BTC in satoshis
      maxHourlyPayout: options.maxHourlyPayout || 20000000, // 0.2 BTC in satoshis
      
      // Auto-adjustment settings
      payoutThrottleEnabled: options.payoutThrottleEnabled !== false,
      autoHaltEnabled: options.autoHaltEnabled !== false,
      emergencyMode: false,
      
      // Monitoring intervals
      monitoringInterval: options.monitoringInterval || 60000, // 1 minute
      auditInterval: options.auditInterval || 3600000, // 1 hour
      
      ...options
    };
    
    // State tracking
    this.reserves = {
      hot: 0,      // Immediately available
      warm: 0,     // Available within hours
      cold: 0,     // Offline/secure storage
      total: 0,
      lastUpdate: Date.now()
    };
    
    this.payoutTracking = {
      hourly: [],
      daily: [],
      pending: []
    };
    
    this.reserveHistory = [];
    this.alerts = [];
    
    this.initialize();
  }

  /**
   * Initialize reserve management
   */
  async initialize() {
    try {
      logger.info('Initializing Reserve Management System...');
      
      // Load current reserve status
      await this.loadReserveStatus();
      
      // Start monitoring
      await this.startMonitoring();
      
      logger.info('Reserve Management System initialized');
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Failed to initialize Reserve Management:', error);
      this.emit('error', error);
    }
  }

  /**
   * Start monitoring services
   */
  async startMonitoring() {
    // Regular monitoring
    this.monitorTimer = setInterval(() => {
      this.monitorReserves();
    }, this.options.monitoringInterval);
    
    // Audit checks
    this.auditTimer = setInterval(() => {
      this.performAudit();
    }, this.options.auditInterval);
  }

  /**
   * Validate payout request
   */
  async validatePayout(payoutRequest) {
    const validation = {
      approved: false,
      amount: payoutRequest.amount,
      adjustedAmount: payoutRequest.amount,
      reason: '',
      restrictions: []
    };
    
    // Check emergency mode
    if (this.options.emergencyMode) {
      validation.reason = 'Emergency mode - all payouts halted';
      validation.approved = false;
      return validation;
    }
    
    // Check single payout limit
    if (payoutRequest.amount > this.options.maxSinglePayout) {
      validation.restrictions.push('exceeds_single_limit');
      validation.adjustedAmount = this.options.maxSinglePayout;
    }
    
    // Check hourly limit
    const hourlyTotal = this.getHourlyPayoutTotal();
    if (hourlyTotal + payoutRequest.amount > this.options.maxHourlyPayout) {
      const available = Math.max(0, this.options.maxHourlyPayout - hourlyTotal);
      validation.restrictions.push('hourly_limit_reached');
      validation.adjustedAmount = Math.min(validation.adjustedAmount, available);
    }
    
    // Check daily limit
    const dailyTotal = this.getDailyPayoutTotal();
    if (dailyTotal + payoutRequest.amount > this.options.maxDailyPayout) {
      const available = Math.max(0, this.options.maxDailyPayout - dailyTotal);
      validation.restrictions.push('daily_limit_reached');
      validation.adjustedAmount = Math.min(validation.adjustedAmount, available);
    }
    
    // Check reserve ratio
    const reserveCheck = this.checkReserveImpact(payoutRequest.amount);
    if (!reserveCheck.safe) {
      if (reserveCheck.ratio < this.options.emergencyReserveRatio) {
        // Critical - deny payout
        validation.approved = false;
        validation.reason = 'Insufficient reserves';
        validation.adjustedAmount = 0;
      } else if (reserveCheck.ratio < this.options.criticalReserveRatio) {
        // Throttle payout
        const throttleFactor = 0.5; // 50% reduction
        validation.adjustedAmount = Math.floor(validation.adjustedAmount * throttleFactor);
        validation.restrictions.push('reserve_throttle');
      }
    }
    
    // Final approval
    validation.approved = validation.adjustedAmount > 0;
    
    if (!validation.approved) {
      validation.reason = validation.reason || 'Payout restrictions applied';
    } else if (validation.adjustedAmount < payoutRequest.amount) {
      validation.reason = `Payout reduced from ${payoutRequest.amount} to ${validation.adjustedAmount} satoshis`;
    } else {
      validation.reason = 'Payout approved';
    }
    
    // Log validation
    this.logPayoutValidation(payoutRequest, validation);
    
    return validation;
  }

  /**
   * Process approved payout
   */
  async processPayout(payoutData) {
    // Record payout
    const payoutRecord = {
      id: Date.now().toString(),
      amount: payoutData.amount,
      timestamp: Date.now(),
      type: payoutData.type || 'standard',
      userId: payoutData.userId
    };
    
    // Update tracking
    this.payoutTracking.hourly.push(payoutRecord);
    this.payoutTracking.daily.push(payoutRecord);
    
    // Update reserves
    this.updateReserveBalance(-payoutData.amount);
    
    // Clean old records
    this.cleanPayoutRecords();
    
    // Check if we need to trigger alerts
    this.checkReserveAlerts();
    
    return payoutRecord;
  }

  /**
   * Monitor reserve levels
   */
  async monitorReserves() {
    try {
      // Update reserve data
      await this.updateReserveData();
      
      // Calculate metrics
      const metrics = this.calculateReserveMetrics();
      
      // Update dynamic fee protection
      dynamicFeeProtection.updateReserveStatus(
        this.reserves.total,
        metrics.requiredReserve
      );
      
      // Check for issues
      if (metrics.ratio < this.options.criticalReserveRatio) {
        this.handleLowReserves(metrics);
      }
      
      // Record history
      this.recordReserveHistory(metrics);
      
    } catch (error) {
      logger.error('Reserve monitoring error:', error);
    }
  }

  /**
   * Calculate reserve metrics
   */
  calculateReserveMetrics() {
    const dailyPayouts = this.getDailyPayoutTotal();
    const avgDailyPayouts = this.getAverageDailyPayouts();
    const requiredReserve = avgDailyPayouts * this.options.targetReserveRatio;
    
    return {
      currentReserve: this.reserves.total,
      hotReserve: this.reserves.hot,
      requiredReserve: requiredReserve,
      ratio: this.reserves.total / requiredReserve,
      dailyPayouts: dailyPayouts,
      avgDailyPayouts: avgDailyPayouts,
      health: this.getReserveHealth(),
      timestamp: Date.now()
    };
  }

  /**
   * Get reserve health status
   */
  getReserveHealth() {
    const ratio = this.reserves.total / this.getAverageDailyPayouts();
    
    if (ratio >= this.options.targetReserveRatio) {
      return 'excellent';
    } else if (ratio >= this.options.minimumReserveRatio) {
      return 'good';
    } else if (ratio >= this.options.criticalReserveRatio) {
      return 'warning';
    } else if (ratio >= this.options.emergencyReserveRatio) {
      return 'critical';
    } else {
      return 'emergency';
    }
  }

  /**
   * Handle low reserve situation
   */
  async handleLowReserves(metrics) {
    logger.warn('Low reserve levels detected:', metrics);
    
    // Create alert
    const alert = {
      id: Date.now().toString(),
      type: 'low_reserves',
      severity: metrics.ratio < this.options.emergencyReserveRatio ? 'critical' : 'warning',
      metrics: metrics,
      timestamp: Date.now()
    };
    
    this.alerts.push(alert);
    
    // Take action based on severity
    if (metrics.ratio < this.options.emergencyReserveRatio) {
      // Emergency mode
      this.options.emergencyMode = true;
      this.emit('emergency-mode-activated', alert);
      
      // Report to dynamic fee protection
      dynamicFeeProtection.reportSecurityIncident({
        type: 'reserve_emergency',
        severity: 'critical',
        details: metrics
      });
      
    } else if (metrics.ratio < this.options.criticalReserveRatio) {
      // Throttle mode
      this.options.payoutThrottleEnabled = true;
      this.emit('throttle-mode-activated', alert);
    }
    
    this.emit('low-reserve-alert', alert);
  }

  /**
   * Check reserve impact of payout
   */
  checkReserveImpact(payoutAmount) {
    const currentRatio = this.reserves.total / this.getAverageDailyPayouts();
    const afterPayout = (this.reserves.total - payoutAmount) / this.getAverageDailyPayouts();
    
    return {
      currentRatio: currentRatio,
      ratio: afterPayout,
      safe: afterPayout >= this.options.criticalReserveRatio,
      impact: currentRatio - afterPayout
    };
  }

  /**
   * Update reserve balance
   */
  updateReserveBalance(change) {
    this.reserves.hot += change;
    this.reserves.total = this.reserves.hot + this.reserves.warm + this.reserves.cold;
    this.reserves.lastUpdate = Date.now();
    
    // Move funds between wallets if needed
    this.rebalanceReserves();
  }

  /**
   * Rebalance reserves between hot/warm/cold
   */
  async rebalanceReserves() {
    const hotTarget = this.getAverageDailyPayouts() * 0.5; // 50% of daily in hot
    const warmTarget = this.getAverageDailyPayouts() * 1.0; // 100% in warm
    
    if (this.reserves.hot > hotTarget * 1.5) {
      // Move excess to warm
      const toMove = this.reserves.hot - hotTarget;
      this.emit('rebalance-needed', {
        from: 'hot',
        to: 'warm',
        amount: toMove
      });
    } else if (this.reserves.hot < hotTarget * 0.5) {
      // Need more in hot wallet
      const needed = hotTarget - this.reserves.hot;
      this.emit('rebalance-needed', {
        from: 'warm',
        to: 'hot',
        amount: needed
      });
    }
  }

  /**
   * Perform reserve audit
   */
  async performAudit() {
    logger.info('Performing reserve audit...');
    
    const audit = {
      timestamp: Date.now(),
      reserves: { ...this.reserves },
      payouts: {
        hourly: this.getHourlyPayoutTotal(),
        daily: this.getDailyPayoutTotal(),
        pending: this.payoutTracking.pending.length
      },
      health: this.getReserveHealth(),
      alerts: this.alerts.filter(a => Date.now() - a.timestamp < 86400000).length
    };
    
    this.emit('audit-completed', audit);
    
    // Clear old alerts
    this.alerts = this.alerts.filter(a => Date.now() - a.timestamp < 7 * 86400000);
    
    return audit;
  }

  /**
   * Get reserve status
   */
  getStatus() {
    const metrics = this.calculateReserveMetrics();
    
    return {
      reserves: this.reserves,
      metrics: metrics,
      health: this.getReserveHealth(),
      emergencyMode: this.options.emergencyMode,
      throttleEnabled: this.options.payoutThrottleEnabled,
      limits: {
        hourly: this.options.maxHourlyPayout,
        daily: this.options.maxDailyPayout,
        single: this.options.maxSinglePayout
      },
      usage: {
        hourly: this.getHourlyPayoutTotal(),
        daily: this.getDailyPayoutTotal()
      },
      activeAlerts: this.alerts.filter(a => Date.now() - a.timestamp < 86400000).length
    };
  }

  /**
   * Utility methods
   */
  getHourlyPayoutTotal() {
    const hourAgo = Date.now() - 3600000;
    return this.payoutTracking.hourly
      .filter(p => p.timestamp > hourAgo)
      .reduce((sum, p) => sum + p.amount, 0);
  }

  getDailyPayoutTotal() {
    const dayAgo = Date.now() - 86400000;
    return this.payoutTracking.daily
      .filter(p => p.timestamp > dayAgo)
      .reduce((sum, p) => sum + p.amount, 0);
  }

  getAverageDailyPayouts() {
    // Calculate 7-day average
    const history = this.reserveHistory.slice(-7 * 24); // Last 7 days of hourly data
    if (history.length === 0) return 100000000; // Default 1 BTC
    
    const total = history.reduce((sum, h) => sum + (h.dailyPayouts || 0), 0);
    return total / Math.max(1, history.length / 24);
  }

  cleanPayoutRecords() {
    const hourAgo = Date.now() - 3600000;
    const dayAgo = Date.now() - 86400000;
    
    this.payoutTracking.hourly = this.payoutTracking.hourly.filter(p => p.timestamp > hourAgo);
    this.payoutTracking.daily = this.payoutTracking.daily.filter(p => p.timestamp > dayAgo);
  }

  recordReserveHistory(metrics) {
    this.reserveHistory.push(metrics);
    
    // Keep only last 30 days
    const cutoff = Date.now() - (30 * 86400000);
    this.reserveHistory = this.reserveHistory.filter(h => h.timestamp > cutoff);
  }

  logPayoutValidation(request, validation) {
    logger.info('Payout validation:', {
      request: request,
      validation: validation,
      reserveRatio: this.reserves.total / this.getAverageDailyPayouts()
    });
  }

  async loadReserveStatus() {
    // In production, load from database
    // Mock data for now
    this.reserves = {
      hot: 50000000,    // 0.5 BTC
      warm: 100000000,  // 1 BTC
      cold: 350000000,  // 3.5 BTC
      total: 500000000, // 5 BTC total
      lastUpdate: Date.now()
    };
  }

  async updateReserveData() {
    // In production, get actual wallet balances
    // For now, simulate minor fluctuations
    const change = (Math.random() - 0.5) * 1000000; // +/- 0.01 BTC
    this.reserves.hot = Math.max(0, this.reserves.hot + change);
    this.reserves.total = this.reserves.hot + this.reserves.warm + this.reserves.cold;
  }

  checkReserveAlerts() {
    const ratio = this.reserves.total / this.getAverageDailyPayouts();
    
    // Clear emergency mode if reserves recovered
    if (this.options.emergencyMode && ratio > this.options.minimumReserveRatio) {
      this.options.emergencyMode = false;
      this.emit('emergency-mode-deactivated');
    }
    
    // Clear throttle if reserves are healthy
    if (this.options.payoutThrottleEnabled && ratio > this.options.targetReserveRatio) {
      this.options.payoutThrottleEnabled = false;
      this.emit('throttle-mode-deactivated');
    }
  }
}

// Create singleton instance
export const reserveManagement = new ReserveManagementSystem();

export default ReserveManagementSystem;