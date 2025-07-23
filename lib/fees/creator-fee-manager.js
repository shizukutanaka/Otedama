/**
 * Creator Fee Manager
 * Manages automatic creator fees with minimal rates
 */

const { EventEmitter } = require('events');
const { createLogger } = require('../core/logger');
const AddressValidator = require('../security/address-validator');

const logger = createLogger('creator-fee-manager');

// Fee tiers based on pool size and volume
const FeeTiers = {
  MICRO: { // < 10 miners
    minMiners: 0,
    maxMiners: 10,
    feePercent: 0.3, // 0.3% - lowest in industry
    description: 'Micro pool'
  },
  SMALL: { // 10-100 miners
    minMiners: 10,
    maxMiners: 100,
    feePercent: 0.5, // 0.5%
    description: 'Small pool'
  },
  MEDIUM: { // 100-1000 miners
    minMiners: 100,
    maxMiners: 1000,
    feePercent: 0.7, // 0.7%
    description: 'Medium pool'
  },
  LARGE: { // 1000+ miners
    minMiners: 1000,
    maxMiners: Infinity,
    feePercent: 0.9, // 0.9% - still competitive
    description: 'Large pool'
  }
};

// Comparison with other pools
const PoolComparison = {
  'Otedama': '0.3-0.9%',
  'F2Pool': '2.5%',
  'Poolin': '2.5%',
  'BTC.com': '1.5%',
  'AntPool': '2.5%',
  'ViaBTC': '2-4%',
  'Slush Pool': '2%',
  'Luxor': '2%'
};

class CreatorFeeManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Validate creator address before initialization
    const creatorAddress = options.creatorAddress || process.env.CREATOR_WALLET_ADDRESS || '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa';
    AddressValidator.enforce(creatorAddress);
    
    this.options = {
      creatorAddress: creatorAddress,
      minFeePercent: options.minFeePercent || 0.3, // Minimum 0.3%
      maxFeePercent: options.maxFeePercent || 0.9, // Maximum 0.9%
      dynamicFees: options.dynamicFees !== false, // Enable by default
      operationalCostTarget: options.operationalCostTarget || 0.2, // 0.2% for operations
      profitMargin: options.profitMargin || 0.1, // 0.1% profit minimum
      updateInterval: options.updateInterval || 86400000, // Daily updates
      ...options
    };
    
    // Re-validate to ensure options weren't tampered
    AddressValidator.enforce(this.options.creatorAddress);
    
    // Current fee state
    this.currentFeePercent = this.options.minFeePercent;
    this.currentTier = FeeTiers.MICRO;
    this.minerCount = 0;
    this.monthlyVolume = 0;
    this.operationalCosts = 0;
    
    // Fee collection tracking
    this.collectedFees = 0;
    this.lastCollection = Date.now();
    
    // Update timer
    this.updateTimer = null;
    
    logger.info('Creator fee manager initialized', {
      creatorAddress: this.options.creatorAddress,
      minFee: this.options.minFeePercent,
      maxFee: this.options.maxFeePercent
    });
  }
  
  /**
   * Start fee management
   */
  start() {
    if (this.options.dynamicFees) {
      this.updateTimer = setInterval(() => {
        this.updateFeeStructure();
      }, this.options.updateInterval);
    }
    
    logger.info('Creator fee manager started');
  }
  
  /**
   * Stop fee management
   */
  stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    
    logger.info('Creator fee manager stopped');
  }
  
  /**
   * Update miner count
   */
  updateMinerCount(count) {
    this.minerCount = count;
    
    // Update tier based on miner count
    for (const [tierName, tier] of Object.entries(FeeTiers)) {
      if (count >= tier.minMiners && count < tier.maxMiners) {
        this.currentTier = tier;
        
        if (!this.options.dynamicFees) {
          this.currentFeePercent = tier.feePercent;
        }
        
        break;
      }
    }
  }
  
  /**
   * Update monthly volume
   */
  updateMonthlyVolume(volume) {
    this.monthlyVolume = volume;
  }
  
  /**
   * Update operational costs
   */
  updateOperationalCosts(costs) {
    this.operationalCosts = costs;
  }
  
  /**
   * Calculate dynamic fee based on operational costs
   */
  calculateDynamicFee() {
    if (!this.options.dynamicFees) {
      return this.currentTier.feePercent;
    }
    
    // Base fee from tier
    let baseFee = this.currentTier.feePercent;
    
    // Adjust based on operational costs
    if (this.monthlyVolume > 0) {
      const costPercent = (this.operationalCosts / this.monthlyVolume) * 100;
      const requiredFee = costPercent + this.options.operationalCostTarget + this.options.profitMargin;
      
      // Ensure we cover costs but stay competitive
      baseFee = Math.max(baseFee, requiredFee);
    }
    
    // Apply min/max limits
    return Math.max(
      this.options.minFeePercent,
      Math.min(this.options.maxFeePercent, baseFee)
    );
  }
  
  /**
   * Update fee structure
   */
  updateFeeStructure() {
    const oldFee = this.currentFeePercent;
    this.currentFeePercent = this.calculateDynamicFee();
    
    if (oldFee !== this.currentFeePercent) {
      logger.info('Fee structure updated', {
        oldFee,
        newFee: this.currentFeePercent,
        tier: this.currentTier.description,
        minerCount: this.minerCount
      });
      
      this.emit('fee-updated', {
        oldFee,
        newFee: this.currentFeePercent,
        tier: this.currentTier
      });
    }
  }
  
  /**
   * Calculate creator fee from reward
   */
  calculateCreatorFee(reward) {
    return reward * (this.currentFeePercent / 100);
  }
  
  /**
   * Process block reward with creator fee
   */
  processBlockReward(blockReward, poolFeePercent = 1.0) {
    // Total pool fee (includes operational + creator fee)
    const totalPoolFee = poolFeePercent / 100;
    const totalFeeAmount = blockReward * totalPoolFee;
    
    // Creator fee is part of the total pool fee
    const creatorFeeAmount = blockReward * (this.currentFeePercent / 100);
    const operationalFeeAmount = totalFeeAmount - creatorFeeAmount;
    
    // Track collected fees
    this.collectedFees += creatorFeeAmount;
    
    return {
      blockReward,
      totalFeeAmount,
      creatorFeeAmount,
      operationalFeeAmount,
      minerReward: blockReward - totalFeeAmount,
      creatorAddress: this.options.creatorAddress
    };
  }
  
  /**
   * Get fee comparison with other pools
   */
  getFeeComparison() {
    return {
      current: `${this.currentFeePercent}%`,
      tier: this.currentTier.description,
      comparison: PoolComparison,
      savings: {
        vsF2Pool: `${2.5 - this.currentFeePercent}%`,
        vsAntPool: `${2.5 - this.currentFeePercent}%`,
        vsBTCcom: `${1.5 - this.currentFeePercent}%`,
        vsAverage: `${2.2 - this.currentFeePercent}%`
      }
    };
  }
  
  /**
   * Get fee statistics
   */
  getStats() {
    const runtime = Date.now() - this.lastCollection;
    const dailyAverage = (this.collectedFees / runtime) * 86400000;
    
    return {
      currentFeePercent: this.currentFeePercent,
      currentTier: this.currentTier,
      minerCount: this.minerCount,
      monthlyVolume: this.monthlyVolume,
      operationalCosts: this.operationalCosts,
      collectedFees: this.collectedFees,
      dailyAverage,
      creatorAddress: this.options.creatorAddress,
      feeTiers: FeeTiers,
      comparison: this.getFeeComparison()
    };
  }
  
  /**
   * Check if fee covers operational costs
   */
  isProfitable() {
    if (this.monthlyVolume === 0) return true;
    
    const monthlyFees = this.monthlyVolume * (this.currentFeePercent / 100);
    return monthlyFees > this.operationalCosts;
  }
  
  /**
   * Get recommended fee based on current conditions
   */
  getRecommendedFee() {
    const dynamicFee = this.calculateDynamicFee();
    const profitable = this.isProfitable();
    
    return {
      recommended: dynamicFee,
      current: this.currentFeePercent,
      isProfitable: profitable,
      reason: profitable 
        ? 'Current fee covers operational costs'
        : 'Fee may need adjustment to cover costs'
    };
  }
}

module.exports = CreatorFeeManager;