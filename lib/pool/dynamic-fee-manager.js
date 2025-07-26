/**
 * Dynamic Fee Manager - Otedama
 * Intelligent fee adjustment based on market conditions
 * Maximizes competitiveness while ensuring profitability
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('DynamicFeeManager');

/**
 * Fee adjustment strategies
 */
export const FeeStrategy = {
  COMPETITIVE: 'competitive',     // Always stay competitive
  PROFIT_MAX: 'profit_max',      // Maximize profit
  BALANCED: 'balanced',          // Balance competitiveness and profit
  MARKET_FOLLOWING: 'market_following', // Follow market trends
  DYNAMIC: 'dynamic'             // AI-driven dynamic adjustment
};

/**
 * Market conditions
 */
export const MarketCondition = {
  BULL: 'bull',
  BEAR: 'bear',
  SIDEWAYS: 'sideways',
  VOLATILE: 'volatile'
};

/**
 * Dynamic Fee Manager
 */
export class DynamicFeeManager extends EventEmitter {
  constructor(pool, options = {}) {
    super();
    
    this.pool = pool;
    this.config = {
      strategy: options.strategy || FeeStrategy.BALANCED,
      minFee: options.minFee || 0.005, // 0.5%
      maxFee: options.maxFee || 0.03,  // 3%
      baseFee: options.baseFee || 0.01, // 1%
      adjustmentInterval: options.adjustmentInterval || 3600000, // 1 hour
      competitorCheckInterval: options.competitorCheckInterval || 1800000, // 30 min
      marketAnalysisInterval: options.marketAnalysisInterval || 600000, // 10 min
      ...options
    };
    
    this.currentFee = this.config.baseFee;
    this.competitors = new Map();
    this.marketData = {
      condition: MarketCondition.SIDEWAYS,
      hashrate: 0,
      difficulty: 0,
      profitability: 0,
      volatility: 0
    };
    this.feeHistory = [];
    this.performanceMetrics = {
      minerRetention: 1.0,
      revenuePerMiner: 0,
      competitivePosition: 0.5
    };
    
    this.stats = {
      feeAdjustments: 0,
      totalRevenueIncrease: 0,
      minerGrowth: 0,
      averageFee: this.config.baseFee,
      competitiveScore: 0.5
    };
  }
  
  /**
   * Initialize fee manager
   */
  async initialize() {
    logger.info('Initializing dynamic fee manager...');
    
    // Load competitor data
    await this.loadCompetitorData();
    
    // Start monitoring cycles
    this.startMarketAnalysis();
    this.startCompetitorMonitoring();
    this.startFeeAdjustment();
    
    logger.info('Dynamic fee manager initialized');
    this.emit('initialized');
  }
  
  /**
   * Analyze market conditions
   */
  async analyzeMarketConditions() {
    logger.debug('Analyzing market conditions...');
    
    try {
      // Get current market data
      const hashrate = await this.getNetworkHashrate();
      const difficulty = await this.getNetworkDifficulty();
      const price = await this.getCoinPrice();
      const profitability = await this.calculateProfitability(price, difficulty);
      
      // Calculate volatility
      const volatility = await this.calculateVolatility();
      
      // Determine market condition
      const condition = this.determineMarketCondition({
        hashrate,
        difficulty,
        price,
        profitability,
        volatility
      });
      
      // Update market data
      this.marketData = {
        condition,
        hashrate,
        difficulty,
        profitability,
        volatility,
        price,
        timestamp: Date.now()
      };
      
      logger.debug('Market analysis completed', {
        condition,
        profitability: profitability.toFixed(4),
        volatility: volatility.toFixed(4)
      });
      
      this.emit('market:analyzed', this.marketData);
      
    } catch (error) {
      logger.error('Market analysis failed:', error);
    }
  }
  
  /**
   * Monitor competitors
   */
  async monitorCompetitors() {
    logger.debug('Monitoring competitor fees...');
    
    try {
      const competitorList = await this.getCompetitorList();
      
      for (const competitor of competitorList) {
        const competitorData = await this.getCompetitorData(competitor);
        
        this.competitors.set(competitor.name, {
          ...competitorData,
          lastUpdate: Date.now()
        });
      }
      
      // Analyze competitive position
      await this.analyzeCompetitivePosition();
      
      this.emit('competitors:updated', this.getCompetitorSummary());
      
    } catch (error) {
      logger.error('Competitor monitoring failed:', error);
    }
  }
  
  /**
   * Adjust fees based on strategy
   */
  async adjustFees() {
    logger.info('Adjusting fees based on market conditions...');
    
    try {
      // Calculate optimal fee
      const optimalFee = await this.calculateOptimalFee();
      
      // Apply strategy-specific adjustments
      const adjustedFee = this.applyStrategyAdjustments(optimalFee);
      
      // Validate fee bounds
      const finalFee = this.validateFeeBounds(adjustedFee);
      
      // Check if adjustment is significant enough
      const feeChange = Math.abs(finalFee - this.currentFee);
      const minChangeThreshold = this.currentFee * 0.05; // 5% change minimum
      
      if (feeChange >= minChangeThreshold) {
        await this.implementFeeChange(finalFee);
      } else {
        logger.debug('Fee change too small, skipping adjustment');
      }
      
    } catch (error) {
      logger.error('Fee adjustment failed:', error);
    }
  }
  
  /**
   * Calculate optimal fee
   */
  async calculateOptimalFee() {
    const { condition, profitability, volatility } = this.marketData;
    const competitivePosition = this.performanceMetrics.competitivePosition;
    
    let optimalFee = this.config.baseFee;
    
    // Market condition adjustments
    switch (condition) {
      case MarketCondition.BULL:
        // High profitability allows for higher fees
        optimalFee += profitability * 0.01;
        break;
        
      case MarketCondition.BEAR:
        // Low profitability requires lower fees
        optimalFee -= (1 - profitability) * 0.005;
        break;
        
      case MarketCondition.VOLATILE:
        // Volatility requires more aggressive pricing
        optimalFee += volatility * 0.002;
        break;
        
      case MarketCondition.SIDEWAYS:
        // Stable conditions allow for steady fees
        break;
    }
    
    // Competitive position adjustments
    if (competitivePosition < 0.3) {
      // We're not competitive, reduce fees
      optimalFee *= 0.95;
    } else if (competitivePosition > 0.7) {
      // We're very competitive, can increase fees
      optimalFee *= 1.05;
    }
    
    // Miner retention adjustments
    const retentionRate = this.performanceMetrics.minerRetention;
    if (retentionRate < 0.9) {
      // Poor retention, reduce fees
      optimalFee *= (0.9 + retentionRate * 0.1);
    }
    
    return optimalFee;
  }
  
  /**
   * Apply strategy-specific adjustments
   */
  applyStrategyAdjustments(optimalFee) {
    const strategy = this.config.strategy;
    
    switch (strategy) {
      case FeeStrategy.COMPETITIVE:
        return this.applyCompetitiveStrategy(optimalFee);
        
      case FeeStrategy.PROFIT_MAX:
        return this.applyProfitMaxStrategy(optimalFee);
        
      case FeeStrategy.BALANCED:
        return this.applyBalancedStrategy(optimalFee);
        
      case FeeStrategy.MARKET_FOLLOWING:
        return this.applyMarketFollowingStrategy(optimalFee);
        
      case FeeStrategy.DYNAMIC:
        return this.applyDynamicStrategy(optimalFee);
        
      default:
        return optimalFee;
    }
  }
  
  /**
   * Competitive strategy
   */
  applyCompetitiveStrategy(optimalFee) {
    const averageCompetitorFee = this.getAverageCompetitorFee();
    const topCompetitorFee = this.getLowestCompetitorFee();
    
    // Stay slightly below top competitor
    return Math.min(optimalFee, topCompetitorFee * 0.95);
  }
  
  /**
   * Profit maximization strategy
   */
  applyProfitMaxStrategy(optimalFee) {
    // Find the sweet spot between fee and miner count
    const elasticity = this.calculateDemandElasticity();
    
    // If demand is inelastic, we can increase fees
    if (Math.abs(elasticity) < 1) {
      return optimalFee * 1.1;
    }
    
    return optimalFee;
  }
  
  /**
   * Balanced strategy
   */
  applyBalancedStrategy(optimalFee) {
    const competitiveAdjustment = this.applyCompetitiveStrategy(optimalFee);
    const profitAdjustment = this.applyProfitMaxStrategy(optimalFee);
    
    // Weighted average
    return competitiveAdjustment * 0.6 + profitAdjustment * 0.4;
  }
  
  /**
   * Market following strategy
   */
  applyMarketFollowingStrategy(optimalFee) {
    const marketTrend = this.calculateMarketTrend();
    
    if (marketTrend > 0.1) {
      // Market trending up, increase fees
      return optimalFee * (1 + marketTrend * 0.5);
    } else if (marketTrend < -0.1) {
      // Market trending down, decrease fees
      return optimalFee * (1 + marketTrend * 0.3);
    }
    
    return optimalFee;
  }
  
  /**
   * Dynamic AI-driven strategy
   */
  applyDynamicStrategy(optimalFee) {
    if (!this.pool.components?.mlOptimizer) {
      // Fallback to balanced strategy
      return this.applyBalancedStrategy(optimalFee);
    }
    
    // Use ML to predict optimal fee
    const features = {
      currentFee: this.currentFee,
      marketCondition: this.encodeMarketCondition(this.marketData.condition),
      profitability: this.marketData.profitability,
      volatility: this.marketData.volatility,
      competitivePosition: this.performanceMetrics.competitivePosition,
      minerRetention: this.performanceMetrics.minerRetention,
      timeOfDay: new Date().getHours(),
      dayOfWeek: new Date().getDay()
    };
    
    // Predict optimal fee using ML
    return this.pool.components.mlOptimizer.predictOptimalFee(features) || optimalFee;
  }
  
  /**
   * Implement fee change
   */
  async implementFeeChange(newFee) {
    const oldFee = this.currentFee;
    const change = ((newFee - oldFee) / oldFee) * 100;
    
    logger.info(`Implementing fee change: ${oldFee.toFixed(4)} -> ${newFee.toFixed(4)} (${change.toFixed(2)}%)`);
    
    try {
      // Update pool fee
      await this.pool.updateFee(newFee);
      
      // Record fee change
      this.recordFeeChange(oldFee, newFee);
      
      // Update current fee
      this.currentFee = newFee;
      
      // Update statistics
      this.stats.feeAdjustments++;
      this.updateAverageFee();
      
      // Notify stakeholders
      this.emit('fee:changed', {
        oldFee,
        newFee,
        change,
        reason: this.generateChangeReason(),
        timestamp: Date.now()
      });
      
      logger.info('Fee change implemented successfully');
      
    } catch (error) {
      logger.error('Failed to implement fee change:', error);
      throw error;
    }
  }
  
  /**
   * Analyze competitive position
   */
  async analyzeCompetitivePosition() {
    const competitors = Array.from(this.competitors.values());
    
    if (competitors.length === 0) {
      this.performanceMetrics.competitivePosition = 0.5;
      return;
    }
    
    // Sort competitors by fee (ascending)
    competitors.sort((a, b) => a.fee - b.fee);
    
    // Find our position
    let position = 0;
    for (let i = 0; i < competitors.length; i++) {
      if (competitors[i].fee >= this.currentFee) {
        position = i;
        break;
      }
    }
    
    // Calculate competitive position (0 = worst, 1 = best)
    this.performanceMetrics.competitivePosition = 
      1 - (position / competitors.length);
    
    // Calculate competitive score
    this.stats.competitiveScore = this.performanceMetrics.competitivePosition;
  }
  
  /**
   * Market condition detection
   */
  determineMarketCondition(data) {
    const { profitability, volatility } = data;
    
    if (volatility > 0.3) {
      return MarketCondition.VOLATILE;
    }
    
    if (profitability > 0.8) {
      return MarketCondition.BULL;
    }
    
    if (profitability < 0.3) {
      return MarketCondition.BEAR;
    }
    
    return MarketCondition.SIDEWAYS;
  }
  
  /**
   * Performance tracking
   */
  async updatePerformanceMetrics() {
    // Calculate miner retention
    const currentMiners = this.pool.getConnectedMiners().length;
    const previousMiners = this.getPreviousMinerCount();
    
    if (previousMiners > 0) {
      this.performanceMetrics.minerRetention = currentMiners / previousMiners;
      this.stats.minerGrowth = ((currentMiners - previousMiners) / previousMiners) * 100;
    }
    
    // Calculate revenue per miner
    const totalRevenue = await this.calculateTotalRevenue();
    this.performanceMetrics.revenuePerMiner = 
      currentMiners > 0 ? totalRevenue / currentMiners : 0;
  }
  
  /**
   * Helper methods
   */
  validateFeeBounds(fee) {
    return Math.max(this.config.minFee, Math.min(this.config.maxFee, fee));
  }
  
  recordFeeChange(oldFee, newFee) {
    this.feeHistory.push({
      oldFee,
      newFee,
      change: newFee - oldFee,
      changePercent: ((newFee - oldFee) / oldFee) * 100,
      marketCondition: this.marketData.condition,
      timestamp: Date.now()
    });
    
    // Keep only last 1000 records
    if (this.feeHistory.length > 1000) {
      this.feeHistory.shift();
    }
  }
  
  updateAverageFee() {
    if (this.feeHistory.length === 0) return;
    
    const totalFee = this.feeHistory.reduce((sum, record) => sum + record.newFee, 0);
    this.stats.averageFee = totalFee / this.feeHistory.length;
  }
  
  generateChangeReason() {
    const { condition, profitability } = this.marketData;
    const competitivePos = this.performanceMetrics.competitivePosition;
    
    if (competitivePos < 0.3) {
      return 'Improving competitive position';
    }
    
    if (condition === MarketCondition.BULL && profitability > 0.8) {
      return 'High market profitability';
    }
    
    if (condition === MarketCondition.BEAR) {
      return 'Market downturn adjustment';
    }
    
    return 'Market condition optimization';
  }
  
  getAverageCompetitorFee() {
    const competitors = Array.from(this.competitors.values());
    
    if (competitors.length === 0) return this.config.baseFee;
    
    const totalFee = competitors.reduce((sum, comp) => sum + comp.fee, 0);
    return totalFee / competitors.length;
  }
  
  getLowestCompetitorFee() {
    const competitors = Array.from(this.competitors.values());
    
    if (competitors.length === 0) return this.config.baseFee;
    
    return Math.min(...competitors.map(comp => comp.fee));
  }
  
  calculateDemandElasticity() {
    // Simplified elasticity calculation
    if (this.feeHistory.length < 2) return -1;
    
    const recent = this.feeHistory.slice(-10);
    const feeChanges = recent.map(r => r.changePercent);
    const minerChanges = recent.map(() => Math.random() * 10 - 5); // Mock data
    
    // Calculate correlation
    const avgFeeChange = feeChanges.reduce((a, b) => a + b, 0) / feeChanges.length;
    const avgMinerChange = minerChanges.reduce((a, b) => a + b, 0) / minerChanges.length;
    
    let numerator = 0;
    let denominator = 0;
    
    for (let i = 0; i < feeChanges.length; i++) {
      numerator += (feeChanges[i] - avgFeeChange) * (minerChanges[i] - avgMinerChange);
      denominator += Math.pow(feeChanges[i] - avgFeeChange, 2);
    }
    
    return denominator !== 0 ? numerator / denominator : -1;
  }
  
  calculateMarketTrend() {
    // Calculate trend from recent profitability data
    // Simplified implementation
    return (Math.random() - 0.5) * 0.4; // -0.2 to 0.2
  }
  
  encodeMarketCondition(condition) {
    const encoding = {
      [MarketCondition.BULL]: 1,
      [MarketCondition.SIDEWAYS]: 0,
      [MarketCondition.BEAR]: -1,
      [MarketCondition.VOLATILE]: 0.5
    };
    
    return encoding[condition] || 0;
  }
  
  async getNetworkHashrate() {
    // Mock implementation
    return 150e18; // 150 EH/s
  }
  
  async getNetworkDifficulty() {
    // Mock implementation
    return 25e12;
  }
  
  async getCoinPrice() {
    // Mock implementation
    return 45000; // $45k
  }
  
  async calculateProfitability(price, difficulty) {
    // Simplified profitability calculation
    return Math.min(1, (price / 50000) * (20e12 / difficulty));
  }
  
  async calculateVolatility() {
    // Mock volatility calculation
    return Math.random() * 0.5; // 0-50% volatility
  }
  
  async loadCompetitorData() {
    // Load known competitors
    const competitorList = [
      { name: 'NiceHash', url: 'nicehash.com' },
      { name: 'F2Pool', url: 'f2pool.com' },
      { name: 'Antpool', url: 'antpool.com' },
      { name: 'Poolin', url: 'poolin.com' }
    ];
    
    for (const competitor of competitorList) {
      this.competitors.set(competitor.name, {
        ...competitor,
        fee: 0.02 + Math.random() * 0.01, // Mock fees 2-3%
        hashrate: Math.random() * 50e18,
        miners: Math.floor(Math.random() * 100000),
        lastUpdate: Date.now()
      });
    }
  }
  
  async getCompetitorList() {
    return Array.from(this.competitors.keys()).map(name => ({ name }));
  }
  
  async getCompetitorData(competitor) {
    // Mock competitor data fetching
    return {
      fee: 0.02 + Math.random() * 0.01,
      hashrate: Math.random() * 50e18,
      miners: Math.floor(Math.random() * 100000),
      uptime: 0.95 + Math.random() * 0.05
    };
  }
  
  getCompetitorSummary() {
    const competitors = Array.from(this.competitors.values());
    
    return {
      count: competitors.length,
      averageFee: this.getAverageCompetitorFee(),
      lowestFee: this.getLowestCompetitorFee(),
      ourPosition: this.performanceMetrics.competitivePosition
    };
  }
  
  getPreviousMinerCount() {
    // Mock previous miner count
    return this.pool.getConnectedMiners().length + Math.floor(Math.random() * 10 - 5);
  }
  
  async calculateTotalRevenue() {
    // Mock revenue calculation
    return this.currentFee * this.pool.getConnectedMiners().length * 1000;
  }
  
  /**
   * Start monitoring cycles
   */
  startMarketAnalysis() {
    setInterval(() => {
      this.analyzeMarketConditions();
    }, this.config.marketAnalysisInterval);
    
    // Initial analysis
    setTimeout(() => {
      this.analyzeMarketConditions();
    }, 10000);
  }
  
  startCompetitorMonitoring() {
    setInterval(() => {
      this.monitorCompetitors();
    }, this.config.competitorCheckInterval);
  }
  
  startFeeAdjustment() {
    setInterval(() => {
      this.adjustFees();
      this.updatePerformanceMetrics();
    }, this.config.adjustmentInterval);
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      currentFee: this.currentFee,
      marketCondition: this.marketData.condition,
      competitorCount: this.competitors.size,
      feeHistoryLength: this.feeHistory.length,
      performanceMetrics: this.performanceMetrics
    };
  }
  
  /**
   * Shutdown
   */
  shutdown() {
    this.removeAllListeners();
    logger.info('Dynamic fee manager shutdown');
  }
}

export default DynamicFeeManager;