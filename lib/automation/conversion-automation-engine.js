/**
 * Conversion Automation Engine
 * Fully automated cryptocurrency conversion with intelligent decision making
 * 
 * Features:
 * - Automatic trigger detection
 * - Market analysis and timing
 * - Dynamic threshold adjustment
 * - Risk management
 * - Performance optimization
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import { MultiServiceConverter } from '../integrations/multi-service-converter.js';
import { RatePredictor } from './rate-predictor.js';

const logger = createLogger('ConversionAutomationEngine');

/**
 * Automation strategies
 */
export const AutomationStrategy = {
  AGGRESSIVE: 'aggressive',      // Convert immediately when profitable
  BALANCED: 'balanced',          // Balance between rate and timing
  CONSERVATIVE: 'conservative',  // Wait for optimal conditions
  ADAPTIVE: 'adaptive'          // AI-driven strategy
};

/**
 * Trigger types
 */
export const TriggerType = {
  THRESHOLD: 'threshold',        // Amount-based trigger
  RATE: 'rate',                 // Rate-based trigger
  TIME: 'time',                 // Time-based trigger
  VOLATILITY: 'volatility',     // Market volatility trigger
  PATTERN: 'pattern',           // Pattern recognition trigger
  COMPOSITE: 'composite'        // Multiple conditions
};

/**
 * Conversion Automation Engine
 */
export class ConversionAutomationEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Automation settings
      enabled: config.enabled !== false,
      strategy: config.strategy || AutomationStrategy.ADAPTIVE,
      
      // Trigger configuration
      triggers: config.triggers || [
        {
          type: TriggerType.THRESHOLD,
          conditions: {
            minAmount: { BTC: 0.001, ETH: 0.05, LTC: 0.5, default: 10 },
            urgentAmount: { BTC: 0.01, ETH: 0.5, LTC: 5, default: 100 }
          }
        },
        {
          type: TriggerType.RATE,
          conditions: {
            favorableThreshold: 0.02,    // 2% above average
            excellentThreshold: 0.05,    // 5% above average
            emergencyThreshold: -0.10    // 10% below average
          }
        },
        {
          type: TriggerType.TIME,
          conditions: {
            maxHoldTime: 86400000,       // 24 hours
            optimalTimes: [2, 10, 14, 22] // UTC hours
          }
        },
        {
          type: TriggerType.VOLATILITY,
          conditions: {
            lowVolatility: 0.02,         // 2% std dev
            highVolatility: 0.10         // 10% std dev
          }
        }
      ],
      
      // Dynamic adjustment
      adaptiveThresholds: config.adaptiveThresholds !== false,
      learningRate: config.learningRate || 0.1,
      
      // Risk management
      maxDailyConversions: config.maxDailyConversions || 100,
      maxConversionSize: config.maxConversionSize || {
        BTC: 1,
        ETH: 50,
        default: 10000
      },
      stopLossThreshold: config.stopLossThreshold || -0.05, // 5% loss
      
      // Performance optimization
      batchingEnabled: config.batchingEnabled !== false,
      parallelConversions: config.parallelConversions || 5,
      priorityQueue: config.priorityQueue !== false,
      
      // Monitoring
      checkInterval: config.checkInterval || 60000,        // 1 minute
      analysisWindow: config.analysisWindow || 3600000,   // 1 hour
      historicalDataDays: config.historicalDataDays || 30
    };
    
    // Components
    this.multiServiceConverter = null;
    this.ratePredictor = null;
    
    // State
    this.pendingConversions = new Map();
    this.conversionHistory = [];
    this.marketData = new Map();
    this.thresholds = new Map();
    
    // Timers
    this.automationTimer = null;
    this.analysisTimer = null;
    
    // Statistics
    this.stats = {
      totalAutomated: 0,
      successfulConversions: 0,
      profitGenerated: 0,
      averageRate: 0,
      bestRate: 0,
      worstRate: Infinity,
      triggerStats: {}
    };
    
    // Initialize
    this.initialize();
  }
  
  /**
   * Initialize automation engine
   */
  async initialize() {
    // Initialize multi-service converter
    this.multiServiceConverter = new MultiServiceConverter({
      alwaysUseBestRate: true,
      autoFailover: true,
      parallelQueries: true
    });
    
    // Initialize rate predictor
    this.ratePredictor = new RatePredictor({
      historicalDays: this.config.historicalDataDays,
      predictionWindow: 3600000 // 1 hour ahead
    });
    
    // Load historical data
    await this.loadHistoricalData();
    
    // Initialize adaptive thresholds
    if (this.config.adaptiveThresholds) {
      this.initializeAdaptiveThresholds();
    }
    
    // Start automation
    if (this.config.enabled) {
      this.start();
    }
    
    logger.info('Conversion automation engine initialized', {
      strategy: this.config.strategy,
      triggers: this.config.triggers.length
    });
  }
  
  /**
   * Start automation
   */
  start() {
    logger.info('Starting conversion automation...');
    
    // Start periodic checks
    this.automationTimer = setInterval(() => {
      this.performAutomationCheck();
    }, this.config.checkInterval);
    
    // Start market analysis
    this.analysisTimer = setInterval(() => {
      this.performMarketAnalysis();
    }, this.config.analysisWindow / 6); // 6 times per window
    
    // Initial check
    this.performAutomationCheck();
    
    this.emit('started');
  }
  
  /**
   * Stop automation
   */
  stop() {
    logger.info('Stopping conversion automation...');
    
    if (this.automationTimer) {
      clearInterval(this.automationTimer);
      this.automationTimer = null;
    }
    
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
    }
    
    this.emit('stopped');
  }
  
  /**
   * Add conversion to automation queue
   */
  addConversion(params) {
    const { fromCoin, toCoin, amount, address, userId, priority = 0 } = params;
    const conversionId = this.generateId();
    
    const conversion = {
      id: conversionId,
      fromCoin,
      toCoin,
      amount,
      address,
      userId,
      priority,
      addedAt: Date.now(),
      attempts: 0,
      status: 'pending'
    };
    
    this.pendingConversions.set(conversionId, conversion);
    
    logger.info(`Added conversion to automation queue: ${conversionId}`, {
      fromCoin,
      toCoin,
      amount
    });
    
    // Immediate check for high priority
    if (priority > 5) {
      this.checkConversion(conversion);
    }
    
    return conversionId;
  }
  
  /**
   * Perform automation check
   */
  async performAutomationCheck() {
    const conversions = Array.from(this.pendingConversions.values())
      .sort((a, b) => b.priority - a.priority); // Priority order
    
    // Process conversions in parallel (limited)
    const batches = this.createBatches(conversions, this.config.parallelConversions);
    
    for (const batch of batches) {
      await Promise.all(batch.map(conv => this.checkConversion(conv)));
    }
  }
  
  /**
   * Check if conversion should be executed
   */
  async checkConversion(conversion) {
    try {
      // Get current market conditions
      const marketConditions = await this.getMarketConditions(
        conversion.fromCoin,
        conversion.toCoin
      );
      
      // Evaluate all triggers
      const triggerResults = await this.evaluateTriggers(conversion, marketConditions);
      
      // Determine if should convert
      const shouldConvert = this.shouldExecuteConversion(triggerResults, conversion);
      
      if (shouldConvert) {
        await this.executeConversion(conversion, marketConditions);
      } else {
        // Update priority based on conditions
        this.updateConversionPriority(conversion, triggerResults);
      }
      
    } catch (error) {
      logger.error(`Failed to check conversion ${conversion.id}:`, error);
      conversion.attempts++;
      
      if (conversion.attempts > 5) {
        this.handleFailedConversion(conversion, error);
      }
    }
  }
  
  /**
   * Evaluate all triggers
   */
  async evaluateTriggers(conversion, marketConditions) {
    const results = [];
    
    for (const trigger of this.config.triggers) {
      const result = await this.evaluateTrigger(trigger, conversion, marketConditions);
      results.push(result);
    }
    
    return results;
  }
  
  /**
   * Evaluate single trigger
   */
  async evaluateTrigger(trigger, conversion, marketConditions) {
    switch (trigger.type) {
      case TriggerType.THRESHOLD:
        return this.evaluateThresholdTrigger(trigger, conversion);
        
      case TriggerType.RATE:
        return this.evaluateRateTrigger(trigger, marketConditions);
        
      case TriggerType.TIME:
        return this.evaluateTimeTrigger(trigger, conversion);
        
      case TriggerType.VOLATILITY:
        return this.evaluateVolatilityTrigger(trigger, marketConditions);
        
      case TriggerType.PATTERN:
        return this.evaluatePatternTrigger(trigger, marketConditions);
        
      default:
        return { triggered: false, score: 0 };
    }
  }
  
  /**
   * Evaluate threshold trigger
   */
  evaluateThresholdTrigger(trigger, conversion) {
    const { minAmount, urgentAmount } = trigger.conditions;
    const threshold = minAmount[conversion.fromCoin] || minAmount.default;
    const urgent = urgentAmount[conversion.fromCoin] || urgentAmount.default;
    
    if (conversion.amount >= urgent) {
      return { triggered: true, score: 1.0, reason: 'Urgent amount threshold' };
    }
    
    if (conversion.amount >= threshold) {
      const score = (conversion.amount - threshold) / (urgent - threshold);
      return { triggered: true, score: 0.5 + score * 0.5, reason: 'Amount threshold met' };
    }
    
    return { triggered: false, score: conversion.amount / threshold * 0.5 };
  }
  
  /**
   * Evaluate rate trigger
   */
  async evaluateRateTrigger(trigger, marketConditions) {
    const { currentRate, averageRate, prediction } = marketConditions;
    const { favorableThreshold, excellentThreshold } = trigger.conditions;
    
    const rateDeviation = (currentRate - averageRate) / averageRate;
    
    if (rateDeviation >= excellentThreshold) {
      return { triggered: true, score: 1.0, reason: 'Excellent rate available' };
    }
    
    if (rateDeviation >= favorableThreshold) {
      return { triggered: true, score: 0.7, reason: 'Favorable rate' };
    }
    
    // Check prediction
    if (prediction && prediction.trend === 'down' && prediction.confidence > 0.7) {
      return { triggered: true, score: 0.6, reason: 'Rate predicted to decrease' };
    }
    
    return { triggered: false, score: Math.max(0, rateDeviation * 10) };
  }
  
  /**
   * Evaluate time trigger
   */
  evaluateTimeTrigger(trigger, conversion) {
    const { maxHoldTime, optimalTimes } = trigger.conditions;
    const holdTime = Date.now() - conversion.addedAt;
    const currentHour = new Date().getUTCHours();
    
    // Check if exceeded max hold time
    if (holdTime >= maxHoldTime) {
      return { triggered: true, score: 1.0, reason: 'Maximum hold time exceeded' };
    }
    
    // Check if optimal time
    if (optimalTimes.includes(currentHour)) {
      const timeScore = holdTime / maxHoldTime;
      return { 
        triggered: timeScore > 0.3, 
        score: 0.5 + timeScore * 0.5, 
        reason: 'Optimal conversion time' 
      };
    }
    
    return { triggered: false, score: holdTime / maxHoldTime * 0.3 };
  }
  
  /**
   * Evaluate volatility trigger
   */
  evaluateVolatilityTrigger(trigger, marketConditions) {
    const { volatility } = marketConditions;
    const { lowVolatility, highVolatility } = trigger.conditions;
    
    // Low volatility is good for conversion
    if (volatility <= lowVolatility) {
      return { triggered: true, score: 0.8, reason: 'Low market volatility' };
    }
    
    // High volatility might trigger stop-loss
    if (volatility >= highVolatility && marketConditions.trend === 'down') {
      return { triggered: true, score: 0.9, reason: 'High volatility stop-loss' };
    }
    
    const volatilityScore = 1 - (volatility / highVolatility);
    return { triggered: false, score: volatilityScore * 0.5 };
  }
  
  /**
   * Evaluate pattern trigger
   */
  async evaluatePatternTrigger(trigger, marketConditions) {
    // Use ML model to detect patterns
    const patterns = await this.ratePredictor.detectPatterns(marketConditions);
    
    if (patterns.bullishReversal && patterns.confidence > 0.8) {
      return { triggered: true, score: 0.9, reason: 'Bullish reversal pattern' };
    }
    
    if (patterns.support && marketConditions.currentRate <= patterns.support * 1.01) {
      return { triggered: true, score: 0.7, reason: 'Near support level' };
    }
    
    return { triggered: false, score: patterns.confidence * 0.4 };
  }
  
  /**
   * Determine if should execute conversion
   */
  shouldExecuteConversion(triggerResults, conversion) {
    const strategy = this.getStrategy(conversion);
    
    // Calculate composite score
    const totalScore = triggerResults.reduce((sum, r) => sum + r.score, 0) / triggerResults.length;
    const triggered = triggerResults.filter(r => r.triggered);
    
    switch (strategy) {
      case AutomationStrategy.AGGRESSIVE:
        // Convert if any trigger fires
        return triggered.length > 0;
        
      case AutomationStrategy.BALANCED:
        // Need at least 2 triggers or high score
        return triggered.length >= 2 || totalScore >= 0.7;
        
      case AutomationStrategy.CONSERVATIVE:
        // Need multiple triggers and high score
        return triggered.length >= 3 && totalScore >= 0.8;
        
      case AutomationStrategy.ADAPTIVE:
        // Use ML model decision
        return this.getAdaptiveDecision(triggerResults, conversion, totalScore);
        
      default:
        return totalScore >= 0.6;
    }
  }
  
  /**
   * Get adaptive decision using ML
   */
  getAdaptiveDecision(triggerResults, conversion, score) {
    // Consider historical performance
    const historicalSuccess = this.getHistoricalSuccessRate(conversion.fromCoin, conversion.toCoin);
    
    // Adjust threshold based on success rate
    const adjustedThreshold = 0.6 - (historicalSuccess - 0.5) * 0.2;
    
    // Factor in market conditions
    const marketFactor = triggerResults.find(r => r.reason?.includes('rate'))?.score || 0.5;
    
    return score * marketFactor >= adjustedThreshold;
  }
  
  /**
   * Execute conversion
   */
  async executeConversion(conversion, marketConditions) {
    logger.info(`Executing automated conversion ${conversion.id}`);
    
    try {
      // Remove from pending
      this.pendingConversions.delete(conversion.id);
      
      // Execute via multi-service converter
      const result = await this.multiServiceConverter.convert({
        fromCoin: conversion.fromCoin,
        toCoin: conversion.toCoin,
        amount: conversion.amount,
        address: conversion.address,
        userId: conversion.userId
      });
      
      // Record conversion
      this.recordConversion({
        ...conversion,
        result,
        executedAt: Date.now(),
        rate: marketConditions.currentRate,
        marketConditions
      });
      
      // Update statistics
      this.updateStatistics(conversion, result, marketConditions);
      
      // Emit success event
      this.emit('conversion:executed', {
        conversionId: conversion.id,
        result,
        automation: true
      });
      
      return result;
      
    } catch (error) {
      logger.error(`Automated conversion failed for ${conversion.id}:`, error);
      
      // Re-add to pending with lower priority
      conversion.priority = Math.max(0, conversion.priority - 1);
      conversion.attempts++;
      this.pendingConversions.set(conversion.id, conversion);
      
      throw error;
    }
  }
  
  /**
   * Get market conditions
   */
  async getMarketConditions(fromCoin, toCoin) {
    const pair = `${fromCoin}:${toCoin}`;
    
    // Get current rate
    const rates = await this.multiServiceConverter.externalConverter.getAllServiceRates(
      fromCoin,
      toCoin,
      1
    );
    
    const currentRate = rates.length > 0 
      ? rates.reduce((sum, r) => sum + r.rate, 0) / rates.length
      : 0;
    
    // Get historical data
    const history = this.getHistoricalRates(pair);
    const averageRate = history.length > 0
      ? history.reduce((sum, h) => sum + h.rate, 0) / history.length
      : currentRate;
    
    // Calculate volatility
    const volatility = this.calculateVolatility(history);
    
    // Get prediction
    const prediction = await this.ratePredictor.predict(fromCoin, toCoin, history);
    
    // Determine trend
    const trend = this.determineTrend(history);
    
    return {
      currentRate,
      averageRate,
      volatility,
      prediction,
      trend,
      spread: rates.length > 1 
        ? Math.max(...rates.map(r => r.rate)) - Math.min(...rates.map(r => r.rate))
        : 0
    };
  }
  
  /**
   * Update conversion priority
   */
  updateConversionPriority(conversion, triggerResults) {
    const avgScore = triggerResults.reduce((sum, r) => sum + r.score, 0) / triggerResults.length;
    
    // Increase priority based on score and age
    const ageFactor = Math.min(1, (Date.now() - conversion.addedAt) / 86400000); // 0-1 over 24h
    conversion.priority = Math.min(10, conversion.priority + avgScore + ageFactor);
  }
  
  /**
   * Perform market analysis
   */
  async performMarketAnalysis() {
    // Analyze each trading pair
    const pairs = this.getActivePairs();
    
    for (const pair of pairs) {
      const [fromCoin, toCoin] = pair.split(':');
      
      try {
        const conditions = await this.getMarketConditions(fromCoin, toCoin);
        
        // Store market data
        this.marketData.set(pair, {
          ...conditions,
          timestamp: Date.now()
        });
        
        // Adjust thresholds if adaptive
        if (this.config.adaptiveThresholds) {
          this.adjustThresholds(pair, conditions);
        }
        
      } catch (error) {
        logger.error(`Market analysis failed for ${pair}:`, error);
      }
    }
    
    // Clean old data
    this.cleanHistoricalData();
  }
  
  /**
   * Initialize adaptive thresholds
   */
  initializeAdaptiveThresholds() {
    // Set initial thresholds based on configuration
    for (const trigger of this.config.triggers) {
      if (trigger.type === TriggerType.THRESHOLD) {
        this.thresholds.set('amount', { ...trigger.conditions });
      } else if (trigger.type === TriggerType.RATE) {
        this.thresholds.set('rate', { ...trigger.conditions });
      }
    }
  }
  
  /**
   * Adjust thresholds based on market conditions
   */
  adjustThresholds(pair, conditions) {
    const { volatility, trend, prediction } = conditions;
    const [fromCoin] = pair.split(':');
    
    // Adjust amount thresholds
    const amountThresholds = this.thresholds.get('amount');
    if (amountThresholds) {
      const adjustment = volatility > 0.05 ? 1.2 : 0.9; // Increase in high volatility
      
      if (amountThresholds.minAmount[fromCoin]) {
        amountThresholds.minAmount[fromCoin] *= adjustment;
      }
    }
    
    // Adjust rate thresholds
    const rateThresholds = this.thresholds.get('rate');
    if (rateThresholds && prediction) {
      if (prediction.trend === 'up' && prediction.confidence > 0.7) {
        // Be more patient if rates are improving
        rateThresholds.favorableThreshold = Math.min(0.05, rateThresholds.favorableThreshold * 1.1);
      } else if (prediction.trend === 'down' && prediction.confidence > 0.7) {
        // Be more aggressive if rates are declining
        rateThresholds.favorableThreshold = Math.max(0.01, rateThresholds.favorableThreshold * 0.9);
      }
    }
  }
  
  /**
   * Record conversion for history
   */
  recordConversion(conversion) {
    this.conversionHistory.push(conversion);
    
    // Limit history size
    if (this.conversionHistory.length > 10000) {
      this.conversionHistory = this.conversionHistory.slice(-5000);
    }
    
    // Update trigger statistics
    const triggers = conversion.triggeredBy || [];
    for (const trigger of triggers) {
      if (!this.stats.triggerStats[trigger]) {
        this.stats.triggerStats[trigger] = { count: 0, success: 0 };
      }
      this.stats.triggerStats[trigger].count++;
      if (conversion.result?.success) {
        this.stats.triggerStats[trigger].success++;
      }
    }
  }
  
  /**
   * Update statistics
   */
  updateStatistics(conversion, result, marketConditions) {
    this.stats.totalAutomated++;
    
    if (result.success) {
      this.stats.successfulConversions++;
      
      // Calculate profit (simplified)
      const marketRate = marketConditions.averageRate;
      const actualRate = marketConditions.currentRate;
      const profit = conversion.amount * (actualRate - marketRate);
      
      this.stats.profitGenerated += profit;
      
      // Update rate stats
      const totalRates = this.stats.averageRate * (this.stats.successfulConversions - 1) + actualRate;
      this.stats.averageRate = totalRates / this.stats.successfulConversions;
      
      if (actualRate > this.stats.bestRate) {
        this.stats.bestRate = actualRate;
      }
      if (actualRate < this.stats.worstRate) {
        this.stats.worstRate = actualRate;
      }
    }
  }
  
  /**
   * Get historical success rate
   */
  getHistoricalSuccessRate(fromCoin, toCoin) {
    const relevantHistory = this.conversionHistory.filter(
      c => c.fromCoin === fromCoin && c.toCoin === toCoin && c.result
    );
    
    if (relevantHistory.length === 0) return 0.5; // Default 50%
    
    const successful = relevantHistory.filter(c => c.result.success).length;
    return successful / relevantHistory.length;
  }
  
  /**
   * Get active trading pairs
   */
  getActivePairs() {
    const pairs = new Set();
    
    // From pending conversions
    for (const conversion of this.pendingConversions.values()) {
      pairs.add(`${conversion.fromCoin}:${conversion.toCoin}`);
    }
    
    // From recent history
    const recentHistory = this.conversionHistory.slice(-100);
    for (const conversion of recentHistory) {
      pairs.add(`${conversion.fromCoin}:${conversion.toCoin}`);
    }
    
    return Array.from(pairs);
  }
  
  /**
   * Calculate volatility
   */
  calculateVolatility(history) {
    if (history.length < 2) return 0;
    
    const rates = history.map(h => h.rate);
    const mean = rates.reduce((sum, r) => sum + r, 0) / rates.length;
    
    const variance = rates.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / rates.length;
    return Math.sqrt(variance) / mean; // Normalized standard deviation
  }
  
  /**
   * Determine market trend
   */
  determineTrend(history) {
    if (history.length < 3) return 'neutral';
    
    const recent = history.slice(-10);
    const older = history.slice(-20, -10);
    
    const recentAvg = recent.reduce((sum, h) => sum + h.rate, 0) / recent.length;
    const olderAvg = older.reduce((sum, h) => sum + h.rate, 0) / older.length;
    
    const change = (recentAvg - olderAvg) / olderAvg;
    
    if (change > 0.02) return 'up';
    if (change < -0.02) return 'down';
    return 'neutral';
  }
  
  /**
   * Get historical rates
   */
  getHistoricalRates(pair) {
    const cutoff = Date.now() - this.config.analysisWindow;
    return this.conversionHistory
      .filter(c => 
        `${c.fromCoin}:${c.toCoin}` === pair && 
        c.executedAt > cutoff &&
        c.rate
      )
      .map(c => ({ rate: c.rate, timestamp: c.executedAt }));
  }
  
  /**
   * Create batches for parallel processing
   */
  createBatches(items, batchSize) {
    const batches = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }
  
  /**
   * Handle failed conversion
   */
  handleFailedConversion(conversion, error) {
    logger.error(`Conversion ${conversion.id} failed permanently:`, error);
    
    this.pendingConversions.delete(conversion.id);
    
    this.emit('conversion:failed', {
      conversionId: conversion.id,
      error: error.message,
      attempts: conversion.attempts
    });
  }
  
  /**
   * Load historical data
   */
  async loadHistoricalData() {
    // In production, load from database
    logger.info('Loading historical conversion data...');
  }
  
  /**
   * Clean old historical data
   */
  cleanHistoricalData() {
    const cutoff = Date.now() - (this.config.historicalDataDays * 86400000);
    
    this.conversionHistory = this.conversionHistory.filter(
      c => c.executedAt > cutoff
    );
    
    // Clean old market data
    for (const [pair, data] of this.marketData) {
      if (data.timestamp < cutoff) {
        this.marketData.delete(pair);
      }
    }
  }
  
  /**
   * Get strategy for conversion
   */
  getStrategy(conversion) {
    // Can be overridden per conversion
    return conversion.strategy || this.config.strategy;
  }
  
  /**
   * Generate unique ID
   */
  generateId() {
    return `auto_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Get automation statistics
   */
  getStats() {
    return {
      ...this.stats,
      pendingConversions: this.pendingConversions.size,
      successRate: this.stats.totalAutomated > 0
        ? (this.stats.successfulConversions / this.stats.totalAutomated * 100).toFixed(2) + '%'
        : '0%',
      averageProfit: this.stats.successfulConversions > 0
        ? this.stats.profitGenerated / this.stats.successfulConversions
        : 0,
      strategy: this.config.strategy,
      activeThresholds: Object.fromEntries(this.thresholds)
    };
  }
}

export default ConversionAutomationEngine;