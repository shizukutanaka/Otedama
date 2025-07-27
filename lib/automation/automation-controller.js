/**
 * Automation Controller
 * Central controller for all automation systems
 * 
 * Features:
 * - Unified automation management
 * - Strategy coordination
 * - Performance monitoring
 * - Manual override capability
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import { ConversionAutomationEngine } from './conversion-automation-engine.js';
import { MultiCoinPayoutManager } from '../mining/multi-coin-payout-manager.js';

const logger = createLogger('AutomationController');

/**
 * Automation modes
 */
export const AutomationMode = {
  FULL_AUTO: 'full_auto',          // Complete automation
  SEMI_AUTO: 'semi_auto',          // Requires confirmation for large amounts
  SCHEDULED: 'scheduled',          // Time-based automation
  MANUAL: 'manual'                 // Manual control only
};

/**
 * Automation Controller
 */
export class AutomationController extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Mode settings
      mode: config.mode || AutomationMode.FULL_AUTO,
      enabled: config.enabled !== false,
      
      // Confirmation thresholds (for semi-auto)
      confirmationThresholds: config.confirmationThresholds || {
        BTC: 0.1,
        ETH: 2,
        default: 1000 // USD equivalent
      },
      
      // Schedule settings
      schedules: config.schedules || [
        { cron: '0 */4 * * *', action: 'optimize_conversions' },  // Every 4 hours
        { cron: '0 2 * * *', action: 'bulk_convert' },           // Daily at 2 AM
        { cron: '0 * * * *', action: 'check_pending' }           // Every hour
      ],
      
      // Safety limits
      dailyConversionLimit: config.dailyConversionLimit || {
        BTC: 10,
        ETH: 100,
        default: 100000 // USD equivalent
      },
      
      // Integration settings
      payoutManagerConfig: config.payoutManagerConfig || {},
      automationEngineConfig: config.automationEngineConfig || {},
      
      // Monitoring
      dashboardPort: config.dashboardPort || 8082,
      metricsInterval: config.metricsInterval || 60000 // 1 minute
    };
    
    // Components
    this.automationEngine = null;
    this.payoutManager = null;
    this.scheduleTimers = new Map();
    
    // State
    this.dailyVolume = new Map();
    this.pendingConfirmations = new Map();
    this.automationHistory = [];
    
    // Statistics
    this.stats = {
      totalAutomated: 0,
      totalManual: 0,
      totalValue: 0,
      successRate: 0,
      averageProcessingTime: 0
    };
    
    // Initialize
    this.initialize();
  }
  
  /**
   * Initialize automation controller
   */
  async initialize() {
    logger.info('Initializing automation controller...');
    
    // Initialize conversion automation engine
    this.automationEngine = new ConversionAutomationEngine({
      ...this.config.automationEngineConfig,
      enabled: this.config.mode !== AutomationMode.MANUAL
    });
    
    // Initialize payout manager
    this.payoutManager = new MultiCoinPayoutManager({
      ...this.config.payoutManagerConfig,
      useExternalServices: true,
      bulkOptimizationEnabled: true
    });
    
    // Set up event handlers
    this.setupEventHandlers();
    
    // Start automation if enabled
    if (this.config.enabled) {
      this.start();
    }
    
    logger.info('Automation controller initialized', {
      mode: this.config.mode,
      enabled: this.config.enabled
    });
  }
  
  /**
   * Start automation
   */
  start() {
    logger.info('Starting automation controller...');
    
    // Start based on mode
    switch (this.config.mode) {
      case AutomationMode.FULL_AUTO:
        this.startFullAutomation();
        break;
        
      case AutomationMode.SEMI_AUTO:
        this.startSemiAutomation();
        break;
        
      case AutomationMode.SCHEDULED:
        this.startScheduledAutomation();
        break;
        
      case AutomationMode.MANUAL:
        logger.info('Manual mode - automation disabled');
        break;
    }
    
    // Start metrics collection
    this.startMetricsCollection();
    
    // Reset daily volume at midnight
    this.scheduleDailyReset();
    
    this.emit('started', { mode: this.config.mode });
  }
  
  /**
   * Stop automation
   */
  stop() {
    logger.info('Stopping automation controller...');
    
    // Stop automation engine
    if (this.automationEngine) {
      this.automationEngine.stop();
    }
    
    // Clear schedules
    for (const timer of this.scheduleTimers.values()) {
      clearInterval(timer);
    }
    this.scheduleTimers.clear();
    
    this.emit('stopped');
  }
  
  /**
   * Start full automation
   */
  startFullAutomation() {
    logger.info('Starting full automation mode');
    
    // Enable automation engine
    this.automationEngine.start();
    
    // Auto-process all conversions
    this.automationEngine.on('conversion:queued', async (conversion) => {
      if (this.checkDailyLimit(conversion)) {
        await this.processConversion(conversion);
      }
    });
  }
  
  /**
   * Start semi-automation
   */
  startSemiAutomation() {
    logger.info('Starting semi-automation mode');
    
    // Enable automation engine
    this.automationEngine.start();
    
    // Check if confirmation needed
    this.automationEngine.on('conversion:queued', async (conversion) => {
      if (this.needsConfirmation(conversion)) {
        await this.queueForConfirmation(conversion);
      } else if (this.checkDailyLimit(conversion)) {
        await this.processConversion(conversion);
      }
    });
  }
  
  /**
   * Start scheduled automation
   */
  startScheduledAutomation() {
    logger.info('Starting scheduled automation mode');
    
    for (const schedule of this.config.schedules) {
      this.scheduleTask(schedule);
    }
  }
  
  /**
   * Schedule a task
   */
  scheduleTask(schedule) {
    const { cron, action } = schedule;
    
    // Parse cron expression (simplified)
    const [minute, hour] = cron.split(' ');
    
    let interval;
    if (minute === '0' && hour === '*') {
      interval = 3600000; // Every hour
    } else if (minute === '0' && hour.includes('/')) {
      const hours = parseInt(hour.split('/')[1]);
      interval = hours * 3600000;
    } else {
      interval = 86400000; // Daily
    }
    
    const timer = setInterval(() => {
      this.executeScheduledAction(action);
    }, interval);
    
    this.scheduleTimers.set(action, timer);
    
    // Execute immediately if needed
    if (this.shouldExecuteNow(cron)) {
      this.executeScheduledAction(action);
    }
  }
  
  /**
   * Execute scheduled action
   */
  async executeScheduledAction(action) {
    logger.info(`Executing scheduled action: ${action}`);
    
    try {
      switch (action) {
        case 'optimize_conversions':
          await this.optimizeConversions();
          break;
          
        case 'bulk_convert':
          await this.processBulkConversions();
          break;
          
        case 'check_pending':
          await this.checkPendingConversions();
          break;
          
        default:
          logger.warn(`Unknown scheduled action: ${action}`);
      }
      
      this.emit('schedule:executed', { action, timestamp: Date.now() });
      
    } catch (error) {
      logger.error(`Scheduled action failed: ${action}`, error);
      this.emit('schedule:failed', { action, error: error.message });
    }
  }
  
  /**
   * Process a conversion
   */
  async processConversion(conversion) {
    const startTime = Date.now();
    
    try {
      // Add to automation engine
      const conversionId = this.automationEngine.addConversion({
        ...conversion,
        priority: this.calculatePriority(conversion)
      });
      
      // Track in history
      this.recordAutomation({
        id: conversionId,
        type: 'conversion',
        mode: this.config.mode,
        ...conversion,
        startTime
      });
      
      // Update daily volume
      this.updateDailyVolume(conversion.fromCoin, conversion.amount);
      
      this.stats.totalAutomated++;
      
      this.emit('conversion:automated', {
        conversionId,
        mode: this.config.mode
      });
      
      return conversionId;
      
    } catch (error) {
      logger.error('Failed to process conversion:', error);
      throw error;
    }
  }
  
  /**
   * Queue conversion for confirmation
   */
  async queueForConfirmation(conversion) {
    const confirmationId = this.generateId();
    
    this.pendingConfirmations.set(confirmationId, {
      ...conversion,
      queuedAt: Date.now(),
      expiresAt: Date.now() + 3600000 // 1 hour
    });
    
    logger.info(`Conversion queued for confirmation: ${confirmationId}`);
    
    this.emit('confirmation:required', {
      confirmationId,
      conversion,
      reason: 'Amount exceeds automatic threshold'
    });
    
    return confirmationId;
  }
  
  /**
   * Confirm a pending conversion
   */
  async confirmConversion(confirmationId, approved = true) {
    const pending = this.pendingConfirmations.get(confirmationId);
    
    if (!pending) {
      throw new Error('Confirmation not found or expired');
    }
    
    this.pendingConfirmations.delete(confirmationId);
    
    if (approved) {
      logger.info(`Conversion confirmed: ${confirmationId}`);
      return await this.processConversion(pending);
    } else {
      logger.info(`Conversion rejected: ${confirmationId}`);
      this.emit('conversion:rejected', { confirmationId });
      return null;
    }
  }
  
  /**
   * Optimize conversions
   */
  async optimizeConversions() {
    logger.info('Optimizing conversions...');
    
    // Get all pending conversions
    const pending = await this.payoutManager.getConversionQueue();
    
    // Group by optimization potential
    const optimizationGroups = this.groupForOptimization(pending);
    
    // Process each group
    for (const group of optimizationGroups) {
      if (group.potential > 0.01) { // 1% improvement potential
        await this.processOptimizationGroup(group);
      }
    }
    
    logger.info('Conversion optimization completed');
  }
  
  /**
   * Process bulk conversions
   */
  async processBulkConversions() {
    logger.info('Processing bulk conversions...');
    
    // Trigger bulk conversion in payout manager
    await this.payoutManager.bulkConvert();
    
    this.emit('bulk:processed', { timestamp: Date.now() });
  }
  
  /**
   * Check pending conversions
   */
  async checkPendingConversions() {
    // Clean expired confirmations
    const now = Date.now();
    for (const [id, pending] of this.pendingConfirmations) {
      if (pending.expiresAt < now) {
        this.pendingConfirmations.delete(id);
        this.emit('confirmation:expired', { confirmationId: id });
      }
    }
    
    // Check automation engine queue
    const engineStats = this.automationEngine.getStats();
    
    logger.info('Pending conversions check', {
      pending: engineStats.pendingConversions,
      confirmations: this.pendingConfirmations.size
    });
  }
  
  /**
   * Check if confirmation needed
   */
  needsConfirmation(conversion) {
    if (this.config.mode !== AutomationMode.SEMI_AUTO) {
      return false;
    }
    
    const threshold = this.config.confirmationThresholds[conversion.fromCoin] ||
                     this.config.confirmationThresholds.default;
    
    return conversion.amount >= threshold;
  }
  
  /**
   * Check daily limit
   */
  checkDailyLimit(conversion) {
    const limit = this.config.dailyConversionLimit[conversion.fromCoin] ||
                 this.config.dailyConversionLimit.default;
    
    const current = this.dailyVolume.get(conversion.fromCoin) || 0;
    
    if (current + conversion.amount > limit) {
      logger.warn(`Daily limit exceeded for ${conversion.fromCoin}`);
      
      this.emit('limit:exceeded', {
        coin: conversion.fromCoin,
        current,
        limit,
        attempted: conversion.amount
      });
      
      return false;
    }
    
    return true;
  }
  
  /**
   * Update daily volume
   */
  updateDailyVolume(coin, amount) {
    const current = this.dailyVolume.get(coin) || 0;
    this.dailyVolume.set(coin, current + amount);
  }
  
  /**
   * Calculate conversion priority
   */
  calculatePriority(conversion) {
    let priority = 5; // Base priority
    
    // Increase priority for larger amounts
    const sizeRatio = conversion.amount / 0.1; // Relative to 0.1 BTC
    priority += Math.min(3, Math.floor(sizeRatio));
    
    // Increase priority for volatile coins
    const volatileCoins = ['DOGE', 'SHIB', 'XRP'];
    if (volatileCoins.includes(conversion.fromCoin)) {
      priority += 2;
    }
    
    // User-specific priority
    if (conversion.userPriority) {
      priority = Math.max(priority, conversion.userPriority);
    }
    
    return Math.min(10, priority);
  }
  
  /**
   * Group conversions for optimization
   */
  groupForOptimization(conversions) {
    const groups = new Map();
    
    for (const conversion of conversions) {
      const key = `${conversion.fromCoin}:${conversion.toCoin}`;
      
      if (!groups.has(key)) {
        groups.set(key, {
          pair: key,
          conversions: [],
          totalAmount: 0,
          potential: 0
        });
      }
      
      const group = groups.get(key);
      group.conversions.push(conversion);
      group.totalAmount += conversion.amount;
    }
    
    // Calculate optimization potential
    for (const group of groups.values()) {
      group.potential = this.calculateOptimizationPotential(group);
    }
    
    return Array.from(groups.values())
      .sort((a, b) => b.potential - a.potential);
  }
  
  /**
   * Calculate optimization potential
   */
  calculateOptimizationPotential(group) {
    // Factors:
    // 1. Volume discount potential
    // 2. Current rate favorability
    // 3. Number of conversions to batch
    
    const volumeDiscount = group.totalAmount > 1000 ? 0.005 : 0;
    const batchingBenefit = group.conversions.length > 5 ? 0.002 : 0;
    
    return volumeDiscount + batchingBenefit;
  }
  
  /**
   * Process optimization group
   */
  async processOptimizationGroup(group) {
    logger.info(`Processing optimization group: ${group.pair}`, {
      conversions: group.conversions.length,
      totalAmount: group.totalAmount,
      potential: group.potential
    });
    
    // Add all conversions to automation engine with high priority
    for (const conversion of group.conversions) {
      await this.processConversion({
        ...conversion,
        priority: 8,
        optimizationGroup: group.pair
      });
    }
  }
  
  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    // Automation engine events
    this.automationEngine.on('conversion:executed', (data) => {
      this.handleConversionCompleted(data);
    });
    
    this.automationEngine.on('conversion:failed', (data) => {
      this.handleConversionFailed(data);
    });
    
    // Payout manager events
    this.payoutManager.on('conversion:completed', (data) => {
      this.updateStatistics('success', data);
    });
  }
  
  /**
   * Handle conversion completed
   */
  handleConversionCompleted(data) {
    const automation = this.automationHistory.find(a => a.id === data.conversionId);
    
    if (automation) {
      automation.completedAt = Date.now();
      automation.result = data.result;
      automation.processingTime = automation.completedAt - automation.startTime;
      
      this.updateStatistics('success', automation);
    }
    
    this.emit('automation:completed', data);
  }
  
  /**
   * Handle conversion failed
   */
  handleConversionFailed(data) {
    const automation = this.automationHistory.find(a => a.id === data.conversionId);
    
    if (automation) {
      automation.failedAt = Date.now();
      automation.error = data.error;
      
      this.updateStatistics('failure', automation);
    }
    
    this.emit('automation:failed', data);
  }
  
  /**
   * Update statistics
   */
  updateStatistics(result, data) {
    if (result === 'success') {
      this.stats.successRate = 
        (this.stats.successRate * this.stats.totalAutomated + 1) / 
        (this.stats.totalAutomated + 1);
      
      if (data.processingTime) {
        this.stats.averageProcessingTime = 
          (this.stats.averageProcessingTime * this.stats.totalAutomated + data.processingTime) /
          (this.stats.totalAutomated + 1);
      }
      
      if (data.amount && data.rate) {
        this.stats.totalValue += data.amount * data.rate;
      }
    } else {
      this.stats.successRate = 
        (this.stats.successRate * this.stats.totalAutomated) / 
        (this.stats.totalAutomated + 1);
    }
  }
  
  /**
   * Record automation event
   */
  recordAutomation(automation) {
    this.automationHistory.push(automation);
    
    // Limit history size
    if (this.automationHistory.length > 10000) {
      this.automationHistory = this.automationHistory.slice(-5000);
    }
  }
  
  /**
   * Schedule daily reset
   */
  scheduleDailyReset() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const msUntilMidnight = tomorrow - now;
    
    setTimeout(() => {
      this.resetDailyVolume();
      
      // Schedule next reset
      setInterval(() => {
        this.resetDailyVolume();
      }, 86400000); // 24 hours
      
    }, msUntilMidnight);
  }
  
  /**
   * Reset daily volume
   */
  resetDailyVolume() {
    logger.info('Resetting daily volume counters');
    
    this.dailyVolume.clear();
    
    this.emit('daily:reset', { timestamp: Date.now() });
  }
  
  /**
   * Start metrics collection
   */
  startMetricsCollection() {
    setInterval(() => {
      this.collectMetrics();
    }, this.config.metricsInterval);
  }
  
  /**
   * Collect metrics
   */
  collectMetrics() {
    const metrics = {
      mode: this.config.mode,
      enabled: this.config.enabled,
      ...this.stats,
      engineStats: this.automationEngine.getStats(),
      payoutStats: this.payoutManager.getStats(),
      pendingConfirmations: this.pendingConfirmations.size,
      dailyVolume: Object.fromEntries(this.dailyVolume),
      timestamp: Date.now()
    };
    
    this.emit('metrics:collected', metrics);
  }
  
  /**
   * Get controller statistics
   */
  getStats() {
    return {
      controller: {
        mode: this.config.mode,
        enabled: this.config.enabled,
        ...this.stats,
        pendingConfirmations: this.pendingConfirmations.size,
        activeSchedules: this.scheduleTimers.size
      },
      engine: this.automationEngine.getStats(),
      payout: this.payoutManager.getStats(),
      dailyVolume: Object.fromEntries(this.dailyVolume),
      recentAutomations: this.automationHistory.slice(-10)
    };
  }
  
  /**
   * Change automation mode
   */
  changeMode(newMode) {
    logger.info(`Changing automation mode from ${this.config.mode} to ${newMode}`);
    
    // Stop current mode
    this.stop();
    
    // Update mode
    this.config.mode = newMode;
    
    // Restart with new mode
    this.start();
    
    this.emit('mode:changed', { 
      previousMode: this.config.mode,
      newMode 
    });
  }
  
  /**
   * Manual override
   */
  async manualConversion(params) {
    logger.info('Manual conversion requested');
    
    this.stats.totalManual++;
    
    // Process directly through payout manager
    return await this.payoutManager.multiServiceConverter.convert(params);
  }
  
  /**
   * Check if should execute now
   */
  shouldExecuteNow(cron) {
    // Simple check - execute if it's the right hour
    const [minute, hour] = cron.split(' ');
    const now = new Date();
    
    if (hour === '*') return true;
    if (hour.includes('/')) return true;
    
    return parseInt(hour) === now.getHours() && parseInt(minute) === now.getMinutes();
  }
  
  /**
   * Generate unique ID
   */
  generateId() {
    return `ctrl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

export default AutomationController;