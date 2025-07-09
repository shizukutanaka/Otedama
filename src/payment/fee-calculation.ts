/**
 * Fee Calculation - Dynamic Fee Management
 * Following Carmack/Martin/Pike principles:
 * - Transparent fee structure
 * - Dynamic adjustment based on conditions
 * - Multi-tier fee system
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

interface FeeConfig {
  // Base fee structure
  base: {
    percentage: number; // Base pool fee percentage
    minimum: number; // Minimum fee amount
    maximum?: number; // Maximum fee amount (optional)
  };
  
  // Tiered fees based on volume
  tiers?: FeeTier[];
  
  // Dynamic fee adjustments
  dynamic: {
    enabled: boolean;
    factors: {
      difficulty?: boolean; // Adjust based on network difficulty
      poolLuck?: boolean; // Adjust based on pool luck
      marketPrice?: boolean; // Adjust based on coin price
      minerLoyalty?: boolean; // Loyalty discounts
    };
    updateInterval: number; // How often to recalculate
  };
  
  // Special fees
  special: {
    withdrawalFee?: number; // Fixed or percentage
    transactionFee?: boolean; // Pass through network fees
    soloMiningFee?: number; // Different fee for solo miners
  };
  
  // Discounts
  discounts: {
    volume: boolean; // Volume-based discounts
    loyalty: boolean; // Time-based discounts
    referral: boolean; // Referral program discounts
  };
}

interface FeeTier {
  minVolume: number; // Minimum volume for this tier
  maxVolume?: number; // Maximum volume for this tier
  feePercentage: number; // Fee for this tier
  name: string; // Tier name
}

interface MinerFeeProfile {
  minerId: string;
  baseFee: number;
  currentFee: number;
  
  // Discounts applied
  discounts: {
    volume: number;
    loyalty: number;
    referral: number;
    total: number;
  };
  
  // Volume tracking
  volume: {
    current: number; // Current period volume
    rolling30d: number; // 30-day rolling volume
    lifetime: number; // Lifetime volume
  };
  
  // Loyalty tracking
  loyalty: {
    joinDate: Date;
    daysActive: number;
    tier: string;
  };
  
  // Fee history
  history: FeeHistoryEntry[];
}

interface FeeHistoryEntry {
  timestamp: Date;
  feePercentage: number;
  reason: string;
  volumeAtTime: number;
}

interface FeeCalculation {
  minerId: string;
  baseFee: number;
  adjustments: FeeAdjustment[];
  finalFee: number;
  effectiveDate: Date;
  breakdown: FeeBreakdown;
}

interface FeeAdjustment {
  type: 'volume' | 'loyalty' | 'referral' | 'difficulty' | 'luck' | 'market';
  description: string;
  adjustment: number; // Percentage adjustment
}

interface FeeBreakdown {
  grossAmount: number;
  baseFeeAmount: number;
  discountAmount: number;
  netFeeAmount: number;
  minerReceives: number;
}

export class FeeCalculationEngine extends EventEmitter {
  private config: FeeConfig;
  private minerProfiles: Map<string, MinerFeeProfile> = new Map();
  private currentDynamicFactors: Map<string, number> = new Map();
  private updateTimer?: NodeJS.Timer;
  
  // Cache for tier lookups
  private tierCache: Map<number, FeeTier> = new Map();

  constructor(config: FeeConfig) {
    super();
    this.config = config;
    
    // Build tier cache if tiers exist
    if (config.tiers) {
      this.buildTierCache();
    }
  }

  /**
   * Initialize fee calculation engine
   */
  async initialize(): Promise<void> {
    logger.info('Initializing fee calculation engine', {
      baseFee: this.config.base.percentage,
      tiersEnabled: !!this.config.tiers,
      dynamicEnabled: this.config.dynamic.enabled
    });

    // Start dynamic factor updates
    if (this.config.dynamic.enabled) {
      await this.updateDynamicFactors();
      this.startDynamicUpdates();
    }

    this.emit('initialized');
  }

  /**
   * Calculate fee for a miner
   */
  calculateFee(
    minerId: string,
    amount: number,
    options: {
      volume?: number;
      forceRecalculate?: boolean;
    } = {}
  ): FeeCalculation {
    let profile = this.minerProfiles.get(minerId);
    
    // Create profile if doesn't exist
    if (!profile) {
      profile = this.createMinerProfile(minerId);
      this.minerProfiles.set(minerId, profile);
    }

    // Update volume if provided
    if (options.volume !== undefined) {
      profile.volume.current = options.volume;
    }

    // Start with base fee
    let currentFee = this.config.base.percentage;
    const adjustments: FeeAdjustment[] = [];

    // Apply tier-based fee if applicable
    if (this.config.tiers) {
      const tier = this.getVolumeTeir(profile.volume.rolling30d);
      if (tier) {
        currentFee = tier.feePercentage;
        adjustments.push({
          type: 'volume',
          description: `Volume tier: ${tier.name}`,
          adjustment: tier.feePercentage - this.config.base.percentage
        });
      }
    }

    // Apply volume discount
    if (this.config.discounts.volume) {
      const volumeDiscount = this.calculateVolumeDiscount(profile);
      if (volumeDiscount > 0) {
        currentFee *= (1 - volumeDiscount);
        adjustments.push({
          type: 'volume',
          description: `Volume discount: ${(volumeDiscount * 100).toFixed(1)}%`,
          adjustment: -volumeDiscount * 100
        });
      }
    }

    // Apply loyalty discount
    if (this.config.discounts.loyalty) {
      const loyaltyDiscount = this.calculateLoyaltyDiscount(profile);
      if (loyaltyDiscount > 0) {
        currentFee *= (1 - loyaltyDiscount);
        adjustments.push({
          type: 'loyalty',
          description: `Loyalty discount: ${(loyaltyDiscount * 100).toFixed(1)}%`,
          adjustment: -loyaltyDiscount * 100
        });
      }
    }

    // Apply referral discount
    if (this.config.discounts.referral && profile.discounts.referral > 0) {
      currentFee *= (1 - profile.discounts.referral);
      adjustments.push({
        type: 'referral',
        description: `Referral discount: ${(profile.discounts.referral * 100).toFixed(1)}%`,
        adjustment: -profile.discounts.referral * 100
      });
    }

    // Apply dynamic adjustments
    if (this.config.dynamic.enabled) {
      const dynamicAdjustments = this.applyDynamicAdjustments(currentFee);
      currentFee = dynamicAdjustments.fee;
      adjustments.push(...dynamicAdjustments.adjustments);
    }

    // Apply min/max limits
    currentFee = Math.max(currentFee, 0);
    if (this.config.base.maximum) {
      currentFee = Math.min(currentFee, this.config.base.maximum);
    }

    // Calculate fee amounts
    const feeAmount = amount * currentFee;
    const finalFeeAmount = Math.max(feeAmount, this.config.base.minimum);
    
    // Update profile
    profile.currentFee = currentFee;
    profile.history.push({
      timestamp: new Date(),
      feePercentage: currentFee,
      reason: adjustments.map(a => a.description).join(', '),
      volumeAtTime: profile.volume.rolling30d
    });

    // Keep history limited
    if (profile.history.length > 100) {
      profile.history.shift();
    }

    const calculation: FeeCalculation = {
      minerId,
      baseFee: this.config.base.percentage,
      adjustments,
      finalFee: currentFee,
      effectiveDate: new Date(),
      breakdown: {
        grossAmount: amount,
        baseFeeAmount: amount * this.config.base.percentage,
        discountAmount: amount * this.config.base.percentage - finalFeeAmount,
        netFeeAmount: finalFeeAmount,
        minerReceives: amount - finalFeeAmount
      }
    };

    this.emit('fee:calculated', calculation);
    return calculation;
  }

  /**
   * Calculate withdrawal fee
   */
  calculateWithdrawalFee(amount: number, currency: string): number {
    if (!this.config.special.withdrawalFee) return 0;

    if (typeof this.config.special.withdrawalFee === 'number') {
      // Fixed fee
      return this.config.special.withdrawalFee;
    } else {
      // Percentage fee
      return amount * this.config.special.withdrawalFee;
    }
  }

  /**
   * Create miner profile
   */
  private createMinerProfile(minerId: string): MinerFeeProfile {
    return {
      minerId,
      baseFee: this.config.base.percentage,
      currentFee: this.config.base.percentage,
      discounts: {
        volume: 0,
        loyalty: 0,
        referral: 0,
        total: 0
      },
      volume: {
        current: 0,
        rolling30d: 0,
        lifetime: 0
      },
      loyalty: {
        joinDate: new Date(),
        daysActive: 0,
        tier: 'bronze'
      },
      history: []
    };
  }

  /**
   * Build tier cache for fast lookups
   */
  private buildTierCache(): void {
    if (!this.config.tiers) return;

    // Sort tiers by min volume
    const sortedTiers = [...this.config.tiers].sort((a, b) => a.minVolume - b.minVolume);
    
    for (let i = 0; i < sortedTiers.length; i++) {
      const tier = sortedTiers[i];
      const nextTier = sortedTiers[i + 1];
      
      // Set max volume if not specified
      if (!tier.maxVolume && nextTier) {
        tier.maxVolume = nextTier.minVolume;
      }
      
      this.tierCache.set(tier.minVolume, tier);
    }
  }

  /**
   * Get volume tier for amount
   */
  private getVolumeTeir(volume: number): FeeTier | null {
    if (!this.config.tiers) return null;

    let applicableTier: FeeTier | null = null;
    
    for (const tier of this.config.tiers) {
      if (volume >= tier.minVolume && (!tier.maxVolume || volume < tier.maxVolume)) {
        applicableTier = tier;
      }
    }
    
    return applicableTier;
  }

  /**
   * Calculate volume discount
   */
  private calculateVolumeDiscount(profile: MinerFeeProfile): number {
    // Progressive discount based on volume
    // Example: 0.1% discount per 10 BTC volume, max 10%
    const volumeBTC = profile.volume.rolling30d;
    const discount = Math.min(0.1, volumeBTC / 100 * 0.01);
    
    profile.discounts.volume = discount;
    return discount;
  }

  /**
   * Calculate loyalty discount
   */
  private calculateLoyaltyDiscount(profile: MinerFeeProfile): number {
    const daysActive = (Date.now() - profile.loyalty.joinDate.getTime()) / 86400000;
    profile.loyalty.daysActive = daysActive;
    
    // Tier system
    let discount = 0;
    let tier = 'bronze';
    
    if (daysActive >= 365) {
      discount = 0.05; // 5% after 1 year
      tier = 'platinum';
    } else if (daysActive >= 180) {
      discount = 0.03; // 3% after 6 months
      tier = 'gold';
    } else if (daysActive >= 90) {
      discount = 0.02; // 2% after 3 months
      tier = 'silver';
    } else if (daysActive >= 30) {
      discount = 0.01; // 1% after 1 month
      tier = 'bronze';
    }
    
    profile.loyalty.tier = tier;
    profile.discounts.loyalty = discount;
    
    return discount;
  }

  /**
   * Apply dynamic adjustments
   */
  private applyDynamicAdjustments(
    baseFee: number
  ): { fee: number; adjustments: FeeAdjustment[] } {
    let fee = baseFee;
    const adjustments: FeeAdjustment[] = [];
    
    // Difficulty adjustment
    if (this.config.dynamic.factors.difficulty) {
      const difficultyFactor = this.currentDynamicFactors.get('difficulty') || 1;
      if (difficultyFactor !== 1) {
        fee *= difficultyFactor;
        adjustments.push({
          type: 'difficulty',
          description: `Difficulty adjustment: ${((difficultyFactor - 1) * 100).toFixed(1)}%`,
          adjustment: (difficultyFactor - 1) * 100
        });
      }
    }
    
    // Pool luck adjustment
    if (this.config.dynamic.factors.poolLuck) {
      const luckFactor = this.currentDynamicFactors.get('poolLuck') || 1;
      if (luckFactor !== 1) {
        fee *= luckFactor;
        adjustments.push({
          type: 'luck',
          description: `Pool luck adjustment: ${((luckFactor - 1) * 100).toFixed(1)}%`,
          adjustment: (luckFactor - 1) * 100
        });
      }
    }
    
    // Market price adjustment
    if (this.config.dynamic.factors.marketPrice) {
      const marketFactor = this.currentDynamicFactors.get('marketPrice') || 1;
      if (marketFactor !== 1) {
        fee *= marketFactor;
        adjustments.push({
          type: 'market',
          description: `Market adjustment: ${((marketFactor - 1) * 100).toFixed(1)}%`,
          adjustment: (marketFactor - 1) * 100
        });
      }
    }
    
    return { fee, adjustments };
  }

  /**
   * Update dynamic factors
   */
  private async updateDynamicFactors(): Promise<void> {
    // Difficulty factor (example: increase fee when difficulty drops)
    if (this.config.dynamic.factors.difficulty) {
      const difficultyChange = await this.getDifficultyChange();
      // Inverse relationship: lower difficulty = higher fee
      const difficultyFactor = difficultyChange > 0 ? 1 / (1 + difficultyChange) : 1 - difficultyChange;
      this.currentDynamicFactors.set('difficulty', Math.max(0.9, Math.min(1.1, difficultyFactor)));
    }
    
    // Pool luck factor
    if (this.config.dynamic.factors.poolLuck) {
      const poolLuck = await this.getPoolLuck();
      // Good luck = lower fee, bad luck = higher fee
      const luckFactor = poolLuck > 100 ? 0.95 : poolLuck < 100 ? 1.05 : 1;
      this.currentDynamicFactors.set('poolLuck', luckFactor);
    }
    
    // Market price factor
    if (this.config.dynamic.factors.marketPrice) {
      const priceChange = await this.getMarketPriceChange();
      // Higher price = can afford lower fee percentage
      const marketFactor = priceChange > 0 ? 1 / (1 + priceChange * 0.5) : 1;
      this.currentDynamicFactors.set('marketPrice', Math.max(0.8, Math.min(1.2, marketFactor)));
    }
    
    logger.info('Updated dynamic fee factors', Object.fromEntries(this.currentDynamicFactors));
    this.emit('factors:updated', Object.fromEntries(this.currentDynamicFactors));
  }

  /**
   * Get difficulty change (mock)
   */
  private async getDifficultyChange(): Promise<number> {
    // This would fetch actual network difficulty change
    // Return percentage change (-1 to 1)
    return (Math.random() - 0.5) * 0.2; // ±10%
  }

  /**
   * Get pool luck (mock)
   */
  private async getPoolLuck(): Promise<number> {
    // This would calculate actual pool luck
    // Return percentage (100 = expected, >100 = lucky)
    return 95 + Math.random() * 10; // 95-105%
  }

  /**
   * Get market price change (mock)
   */
  private async getMarketPriceChange(): Promise<number> {
    // This would fetch actual price change
    // Return percentage change (-1 to 1)
    return (Math.random() - 0.5) * 0.3; // ±15%
  }

  /**
   * Start dynamic updates
   */
  private startDynamicUpdates(): void {
    this.updateTimer = setInterval(() => {
      this.updateDynamicFactors();
    }, this.config.dynamic.updateInterval);
  }

  /**
   * Update miner volume
   */
  updateMinerVolume(minerId: string, volume: {
    current?: number;
    rolling30d?: number;
    lifetime?: number;
  }): void {
    const profile = this.minerProfiles.get(minerId);
    if (!profile) return;
    
    if (volume.current !== undefined) profile.volume.current = volume.current;
    if (volume.rolling30d !== undefined) profile.volume.rolling30d = volume.rolling30d;
    if (volume.lifetime !== undefined) profile.volume.lifetime = volume.lifetime;
    
    // Recalculate discounts
    this.calculateVolumeDiscount(profile);
    
    // Update total discount
    profile.discounts.total = 
      profile.discounts.volume + 
      profile.discounts.loyalty + 
      profile.discounts.referral;
  }

  /**
   * Set referral discount
   */
  setReferralDiscount(minerId: string, discount: number): void {
    const profile = this.minerProfiles.get(minerId);
    if (!profile) return;
    
    profile.discounts.referral = Math.min(0.1, Math.max(0, discount)); // Max 10%
    profile.discounts.total = 
      profile.discounts.volume + 
      profile.discounts.loyalty + 
      profile.discounts.referral;
    
    logger.info('Set referral discount', { minerId, discount });
  }

  /**
   * Get miner fee profile
   */
  getMinerProfile(minerId: string): MinerFeeProfile | undefined {
    return this.minerProfiles.get(minerId);
  }

  /**
   * Get fee statistics
   */
  getStatistics(): any {
    const profiles = Array.from(this.minerProfiles.values());
    
    const stats = {
      miners: {
        total: profiles.length,
        withDiscounts: profiles.filter(p => p.discounts.total > 0).length
      },
      fees: {
        base: this.config.base.percentage,
        average: profiles.reduce((sum, p) => sum + p.currentFee, 0) / (profiles.length || 1),
        minimum: Math.min(...profiles.map(p => p.currentFee)),
        maximum: Math.max(...profiles.map(p => p.currentFee))
      },
      discounts: {
        volume: {
          count: profiles.filter(p => p.discounts.volume > 0).length,
          average: profiles.reduce((sum, p) => sum + p.discounts.volume, 0) / (profiles.length || 1)
        },
        loyalty: {
          count: profiles.filter(p => p.discounts.loyalty > 0).length,
          average: profiles.reduce((sum, p) => sum + p.discounts.loyalty, 0) / (profiles.length || 1)
        },
        referral: {
          count: profiles.filter(p => p.discounts.referral > 0).length,
          average: profiles.reduce((sum, p) => sum + p.discounts.referral, 0) / (profiles.length || 1)
        }
      },
      tiers: this.config.tiers ? this.getTierStatistics() : null,
      dynamicFactors: Object.fromEntries(this.currentDynamicFactors)
    };
    
    return stats;
  }

  /**
   * Get tier statistics
   */
  private getTierStatistics(): any {
    if (!this.config.tiers) return null;
    
    const profiles = Array.from(this.minerProfiles.values());
    const tierCounts: { [tier: string]: number } = {};
    
    for (const tier of this.config.tiers) {
      tierCounts[tier.name] = profiles.filter(p => {
        const minerTier = this.getVolumeTeir(p.volume.rolling30d);
        return minerTier?.name === tier.name;
      }).length;
    }
    
    return tierCounts;
  }

  /**
   * Export fee configuration
   */
  exportConfiguration(): FeeConfig {
    return JSON.parse(JSON.stringify(this.config));
  }

  /**
   * Update fee configuration
   */
  updateConfiguration(updates: Partial<FeeConfig>): void {
    this.config = { ...this.config, ...updates };
    
    // Rebuild tier cache if tiers updated
    if (updates.tiers) {
      this.buildTierCache();
    }
    
    logger.info('Fee configuration updated');
    this.emit('config:updated', this.config);
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
  FeeTier, 
  MinerFeeProfile, 
  FeeCalculation, 
  FeeAdjustment, 
  FeeBreakdown 
};
