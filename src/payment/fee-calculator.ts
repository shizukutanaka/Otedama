/**
 * Fee Calculator - Dynamic Fee Management
 * Following Carmack/Martin/Pike principles:
 * - Flexible fee structures
 * - Market-responsive pricing
 * - Transparent calculations
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

interface FeeConfig {
  // Base fees
  base: {
    poolFee: number; // Base pool fee percentage
    minFee: number; // Minimum fee amount
    maxFee: number; // Maximum fee percentage
  };
  
  // Dynamic fee adjustments
  dynamic: {
    enabled: boolean;
    factors: DynamicFactor[];
    updateInterval: number;
  };
  
  // Tiered fees
  tiers: {
    enabled: boolean;
    levels: FeeTier[];
  };
  
  // Special fees
  special: {
    withdrawalFee: number;
    conversionFee: number;
    priorityFee: number;
  };
  
  // Market-based fees
  market: {
    enabled: boolean;
    targetProfit: number;
    minMargin: number;
    adjustmentSpeed: number;
  };
}

interface DynamicFactor {
  name: string;
  type: 'network' | 'market' | 'load' | 'risk';
  weight: number;
  
  // Calculation method
  calculate: (context: FeeContext) => number;
}

interface FeeTier {
  name: string;
  minVolume: number; // Minimum volume for tier (30-day)
  feeReduction: number; // Percentage reduction
  benefits: string[];
}

interface FeeContext {
  userId: string;
  amount: number;
  currency: string;
  type: 'mining' | 'withdrawal' | 'conversion';
  
  // User metrics
  volume30d?: number;
  lifetime?: number;
  referrals?: number;
  
  // Market context
  networkFee?: number;
  marketPrice?: number;
  volatility?: number;
  
  // System context
  poolLoad?: number;
  riskScore?: number;
}

interface FeeCalculation {
  baseFee: number;
  adjustments: FeeAdjustment[];
  finalFee: number;
  feeAmount: number;
  netAmount: number;
  breakdown: FeeBreakdown;
}

interface FeeAdjustment {
  name: string;
  factor: number;
  amount: number;
  reason: string;
}

interface FeeBreakdown {
  poolFee: number;
  networkFee: number;
  processingFee: number;
  discounts: number;
  total: number;
}

interface UserFeeProfile {
  userId: string;
  tier?: string;
  volume30d: number;
  lifetime: number;
  customFees?: Map<string, number>;
  discounts: Discount[];
  lastUpdated: Date;
}

interface Discount {
  type: string;
  percentage: number;
  validUntil?: Date;
  reason: string;
}

export class FeeCalculator extends EventEmitter {
  private config: FeeConfig;
  private userProfiles: Map<string, UserFeeProfile> = new Map();
  private marketData: Map<string, any> = new Map();
  private dynamicFactors: Map<string, DynamicFactor> = new Map();
  private updateTimer?: NodeJS.Timer;
  
  // Fee history for analysis
  private feeHistory: FeeCalculation[] = [];
  private profitMetrics = {
    totalRevenue: 0,
    totalCosts: 0,
    avgMargin: 0
  };

  constructor(config: FeeConfig) {
    super();
    this.config = config;
    
    // Register dynamic factors
    if (config.dynamic.enabled) {
      this.registerDefaultFactors();
    }
  }

  /**
   * Initialize fee calculator
   */
  async initialize(): Promise<void> {
    logger.info('Initializing fee calculator', {
      baseFee: this.config.base.poolFee,
      dynamicEnabled: this.config.dynamic.enabled,
      tiersEnabled: this.config.tiers.enabled
    });

    // Load user profiles
    await this.loadUserProfiles();

    // Start dynamic updates if enabled
    if (this.config.dynamic.enabled || this.config.market.enabled) {
      this.startDynamicUpdates();
    }

    this.emit('initialized');
  }

  /**
   * Calculate fees for transaction
   */
  calculateFees(context: FeeContext): FeeCalculation {
    // Get user profile
    const userProfile = this.getUserProfile(context.userId);
    
    // Start with base fee
    let baseFee = this.getBaseFee(context);
    const adjustments: FeeAdjustment[] = [];

    // Apply tier discount
    if (this.config.tiers.enabled && userProfile.tier) {
      const tierAdjustment = this.applyTierDiscount(baseFee, userProfile.tier);
      if (tierAdjustment) {
        adjustments.push(tierAdjustment);
        baseFee *= (1 - tierAdjustment.factor);
      }
    }

    // Apply dynamic adjustments
    if (this.config.dynamic.enabled) {
      const dynamicAdjustments = this.applyDynamicFactors(baseFee, context);
      adjustments.push(...dynamicAdjustments);
      
      // Apply adjustments
      for (const adj of dynamicAdjustments) {
        baseFee *= (1 + adj.factor);
      }
    }

    // Apply user discounts
    const discountAdjustments = this.applyUserDiscounts(baseFee, userProfile);
    adjustments.push(...discountAdjustments);
    
    for (const adj of discountAdjustments) {
      baseFee *= (1 - adj.factor);
    }

    // Apply market-based adjustments
    if (this.config.market.enabled) {
      const marketAdjustment = this.applyMarketAdjustment(baseFee, context);
      if (marketAdjustment) {
        adjustments.push(marketAdjustment);
        baseFee *= (1 + marketAdjustment.factor);
      }
    }

    // Ensure within bounds
    const finalFee = Math.max(
      this.config.base.minFee,
      Math.min(this.config.base.maxFee, baseFee)
    );

    // Calculate amounts
    const feeAmount = context.amount * finalFee;
    const netAmount = context.amount - feeAmount;

    // Create breakdown
    const breakdown = this.createFeeBreakdown(
      context,
      finalFee,
      adjustments
    );

    const calculation: FeeCalculation = {
      baseFee: this.config.base.poolFee,
      adjustments,
      finalFee,
      feeAmount,
      netAmount,
      breakdown
    };

    // Record for analysis
    this.recordFeeCalculation(calculation);

    logger.debug('Fee calculated', {
      userId: context.userId,
      baseFee: this.config.base.poolFee,
      finalFee,
      adjustments: adjustments.length
    });

    return calculation;
  }

  /**
   * Get base fee for transaction type
   */
  private getBaseFee(context: FeeContext): number {
    switch (context.type) {
      case 'mining':
        return this.config.base.poolFee;
      case 'withdrawal':
        return this.config.special.withdrawalFee;
      case 'conversion':
        return this.config.special.conversionFee;
      default:
        return this.config.base.poolFee;
    }
  }

  /**
   * Apply tier discount
   */
  private applyTierDiscount(baseFee: number, tierName: string): FeeAdjustment | null {
    const tier = this.config.tiers.levels.find(t => t.name === tierName);
    if (!tier) return null;

    return {
      name: 'Tier Discount',
      factor: tier.feeReduction,
      amount: baseFee * tier.feeReduction,
      reason: `${tier.name} tier benefits`
    };
  }

  /**
   * Apply dynamic factors
   */
  private applyDynamicFactors(baseFee: number, context: FeeContext): FeeAdjustment[] {
    const adjustments: FeeAdjustment[] = [];

    for (const [name, factor] of this.dynamicFactors) {
      const adjustment = factor.calculate(context);
      if (adjustment !== 0) {
        adjustments.push({
          name,
          factor: adjustment,
          amount: baseFee * adjustment,
          reason: `Dynamic ${factor.type} adjustment`
        });
      }
    }

    return adjustments;
  }

  /**
   * Apply user discounts
   */
  private applyUserDiscounts(baseFee: number, profile: UserFeeProfile): FeeAdjustment[] {
    const adjustments: FeeAdjustment[] = [];
    const now = new Date();

    for (const discount of profile.discounts) {
      if (!discount.validUntil || discount.validUntil > now) {
        adjustments.push({
          name: `${discount.type} Discount`,
          factor: discount.percentage,
          amount: baseFee * discount.percentage,
          reason: discount.reason
        });
      }
    }

    return adjustments;
  }

  /**
   * Apply market-based adjustment
   */
  private applyMarketAdjustment(baseFee: number, context: FeeContext): FeeAdjustment | null {
    const currentMargin = this.calculateCurrentMargin();
    const targetMargin = this.config.market.targetProfit;
    
    if (Math.abs(currentMargin - targetMargin) < 0.01) {
      return null; // Close enough
    }

    // Calculate adjustment needed
    const adjustment = (targetMargin - currentMargin) * this.config.market.adjustmentSpeed;
    
    // Ensure minimum margin
    if (currentMargin < this.config.market.minMargin) {
      return {
        name: 'Market Adjustment',
        factor: Math.max(0.1, adjustment), // At least 10% increase
        amount: baseFee * adjustment,
        reason: 'Below minimum margin'
      };
    }

    return {
      name: 'Market Adjustment',
      factor: adjustment,
      amount: baseFee * adjustment,
      reason: 'Market conditions'
    };
  }

  /**
   * Create fee breakdown
   */
  private createFeeBreakdown(
    context: FeeContext,
    finalFee: number,
    adjustments: FeeAdjustment[]
  ): FeeBreakdown {
    const poolFee = context.amount * finalFee;
    const networkFee = context.networkFee || 0;
    const processingFee = context.type === 'withdrawal' ? 0.0001 : 0; // Example
    const discounts = adjustments
      .filter(a => a.factor < 0)
      .reduce((sum, a) => sum + Math.abs(a.amount), 0);

    return {
      poolFee,
      networkFee,
      processingFee,
      discounts,
      total: poolFee + networkFee + processingFee - discounts
    };
  }

  /**
   * Register default dynamic factors
   */
  private registerDefaultFactors(): void {
    // Network congestion factor
    this.registerDynamicFactor({
      name: 'Network Congestion',
      type: 'network',
      weight: 0.2,
      calculate: (context) => {
        const congestion = context.networkFee ? context.networkFee / 0.0001 : 1;
        return Math.min(0.1, (congestion - 1) * 0.01); // Max 10% increase
      }
    });

    // Market volatility factor
    this.registerDynamicFactor({
      name: 'Market Volatility',
      type: 'market',
      weight: 0.3,
      calculate: (context) => {
        const volatility = context.volatility || 0;
        return volatility > 0.1 ? volatility * 0.1 : 0; // Increase fee during high volatility
      }
    });

    // Pool load factor
    this.registerDynamicFactor({
      name: 'Pool Load',
      type: 'load',
      weight: 0.2,
      calculate: (context) => {
        const load = context.poolLoad || 0.5;
        if (load > 0.8) return 0.05; // 5% increase when busy
        if (load < 0.2) return -0.02; // 2% decrease when idle
        return 0;
      }
    });

    // Risk factor
    this.registerDynamicFactor({
      name: 'Risk Assessment',
      type: 'risk',
      weight: 0.3,
      calculate: (context) => {
        const risk = context.riskScore || 0;
        return risk > 0.5 ? risk * 0.1 : 0; // Increase fee for risky transactions
      }
    });
  }

  /**
   * Register dynamic factor
   */
  registerDynamicFactor(factor: DynamicFactor): void {
    this.dynamicFactors.set(factor.name, factor);
    logger.info('Registered dynamic factor', { name: factor.name, type: factor.type });
  }

  /**
   * Get or create user profile
   */
  private getUserProfile(userId: string): UserFeeProfile {
    let profile = this.userProfiles.get(userId);
    
    if (!profile) {
      profile = {
        userId,
        volume30d: 0,
        lifetime: 0,
        discounts: [],
        lastUpdated: new Date()
      };
      this.userProfiles.set(userId, profile);
    }

    // Update tier if needed
    if (this.config.tiers.enabled) {
      profile.tier = this.calculateUserTier(profile);
    }

    return profile;
  }

  /**
   * Calculate user tier
   */
  private calculateUserTier(profile: UserFeeProfile): string | undefined {
    const eligibleTiers = this.config.tiers.levels
      .filter(tier => profile.volume30d >= tier.minVolume)
      .sort((a, b) => b.minVolume - a.minVolume);

    return eligibleTiers[0]?.name;
  }

  /**
   * Update user volume
   */
  updateUserVolume(userId: string, amount: number, currency: string): void {
    const profile = this.getUserProfile(userId);
    
    // Convert to base currency if needed
    const baseAmount = this.convertToBaseCurrency(amount, currency);
    
    profile.volume30d += baseAmount;
    profile.lifetime += baseAmount;
    profile.lastUpdated = new Date();

    // Check for tier upgrade
    const oldTier = profile.tier;
    profile.tier = this.calculateUserTier(profile);
    
    if (oldTier !== profile.tier) {
      logger.info('User tier changed', {
        userId,
        oldTier,
        newTier: profile.tier
      });
      
      this.emit('tier:changed', {
        userId,
        oldTier,
        newTier: profile.tier
      });
    }
  }

  /**
   * Add user discount
   */
  addUserDiscount(
    userId: string,
    discount: Omit<Discount, 'validUntil'> & { duration?: number }
  ): void {
    const profile = this.getUserProfile(userId);
    
    const fullDiscount: Discount = {
      ...discount,
      validUntil: discount.duration
        ? new Date(Date.now() + discount.duration * 1000)
        : undefined
    };

    profile.discounts.push(fullDiscount);
    
    logger.info('Added user discount', {
      userId,
      type: discount.type,
      percentage: discount.percentage
    });

    this.emit('discount:added', { userId, discount: fullDiscount });
  }

  /**
   * Calculate current profit margin
   */
  private calculateCurrentMargin(): number {
    if (this.profitMetrics.totalRevenue === 0) {
      return 0;
    }

    return (this.profitMetrics.totalRevenue - this.profitMetrics.totalCosts) / 
           this.profitMetrics.totalRevenue;
  }

  /**
   * Record fee calculation for analysis
   */
  private recordFeeCalculation(calculation: FeeCalculation): void {
    this.feeHistory.push(calculation);
    
    // Keep last 10000 calculations
    if (this.feeHistory.length > 10000) {
      this.feeHistory.shift();
    }

    // Update profit metrics
    this.profitMetrics.totalRevenue += calculation.feeAmount;
    
    // Estimate costs (simplified)
    const estimatedCost = calculation.feeAmount * 0.3; // 30% operational cost
    this.profitMetrics.totalCosts += estimatedCost;
    
    this.profitMetrics.avgMargin = this.calculateCurrentMargin();
  }

  /**
   * Convert amount to base currency
   */
  private convertToBaseCurrency(amount: number, currency: string): number {
    // This would use actual exchange rates
    const rates: { [key: string]: number } = {
      'BTC': 1,
      'ETH': 0.05,
      'LTC': 0.0025,
      'USD': 0.000025
    };

    return amount * (rates[currency] || 1);
  }

  /**
   * Start dynamic updates
   */
  private startDynamicUpdates(): void {
    this.updateTimer = setInterval(() => {
      this.updateMarketData();
      this.cleanupOldDiscounts();
      this.updateVolumes();
    }, this.config.dynamic.updateInterval);

    // Initial update
    this.updateMarketData();
  }

  /**
   * Update market data
   */
  private async updateMarketData(): Promise<void> {
    // This would fetch actual market data
    this.marketData.set('volatility', Math.random() * 0.2);
    this.marketData.set('networkFee', 0.00005 + Math.random() * 0.00005);
    this.marketData.set('poolLoad', Math.random());

    this.emit('market:updated', Object.fromEntries(this.marketData));
  }

  /**
   * Cleanup expired discounts
   */
  private cleanupOldDiscounts(): void {
    const now = new Date();
    let cleaned = 0;

    for (const profile of this.userProfiles.values()) {
      const before = profile.discounts.length;
      profile.discounts = profile.discounts.filter(
        d => !d.validUntil || d.validUntil > now
      );
      cleaned += before - profile.discounts.length;
    }

    if (cleaned > 0) {
      logger.info('Cleaned up expired discounts', { count: cleaned });
    }
  }

  /**
   * Update 30-day volumes
   */
  private updateVolumes(): void {
    // In production, would track actual 30-day rolling window
    // For now, apply simple decay
    for (const profile of this.userProfiles.values()) {
      profile.volume30d *= 0.9999; // Slight decay
    }
  }

  /**
   * Load user profiles
   */
  private async loadUserProfiles(): Promise<void> {
    // TODO: Implement storage loading
    logger.info('Loading user fee profiles');
  }

  /**
   * Get fee statistics
   */
  getStatistics(): any {
    const avgFee = this.feeHistory.length > 0
      ? this.feeHistory.reduce((sum, calc) => sum + calc.finalFee, 0) / this.feeHistory.length
      : this.config.base.poolFee;

    const tierStats = new Map<string, number>();
    for (const profile of this.userProfiles.values()) {
      if (profile.tier) {
        tierStats.set(profile.tier, (tierStats.get(profile.tier) || 0) + 1);
      }
    }

    return {
      fees: {
        base: this.config.base.poolFee,
        average: avgFee,
        min: Math.min(...this.feeHistory.map(c => c.finalFee)),
        max: Math.max(...this.feeHistory.map(c => c.finalFee))
      },
      users: {
        total: this.userProfiles.size,
        withDiscounts: Array.from(this.userProfiles.values())
          .filter(p => p.discounts.length > 0).length,
        byTier: Object.fromEntries(tierStats)
      },
      profit: {
        margin: this.profitMetrics.avgMargin,
        totalRevenue: this.profitMetrics.totalRevenue,
        totalCosts: this.profitMetrics.totalCosts
      },
      adjustments: {
        dynamic: this.config.dynamic.enabled,
        market: this.config.market.enabled,
        factors: Array.from(this.dynamicFactors.keys())
      }
    };
  }

  /**
   * Shutdown
   */
  shutdown(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
  }
}

// Export types
export {
  FeeConfig,
  DynamicFactor,
  FeeTier,
  FeeContext,
  FeeCalculation,
  FeeAdjustment,
  FeeBreakdown,
  UserFeeProfile,
  Discount
};
