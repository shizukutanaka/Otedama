/**
 * Payment Threshold Settings - Minimum Payout Configuration
 * Following Carmack/Martin/Pike principles:
 * - Flexible threshold management
 * - User-configurable minimums
 * - Efficient payment batching
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

interface ThresholdConfig {
  // Global settings
  global: {
    minimum: number; // Absolute minimum
    default: number; // Default threshold
    maximum: number; // Maximum allowed threshold
  };
  
  // Currency-specific thresholds
  currencies: Map<string, CurrencyThreshold>;
  
  // Network fee consideration
  feeAdjustment: {
    enabled: boolean;
    multiplier: number; // Threshold = fee * multiplier
    updateInterval: number; // How often to update
  };
  
  // User tier settings
  tiers: {
    enabled: boolean;
    levels: TierLevel[];
  };
}

interface CurrencyThreshold {
  symbol: string;
  minimum: number;
  default: number;
  decimals: number;
  networkFee?: number;
}

interface TierLevel {
  name: string;
  minHashrate: number; // Minimum hashrate for tier
  thresholdMultiplier: number; // Multiplier for threshold
  feeDiscount: number; // Fee discount percentage
}

interface UserThreshold {
  userId: string;
  currency: string;
  customThreshold?: number;
  effectiveThreshold: number;
  tier?: string;
  lastUpdated: Date;
  autoAdjust: boolean;
}

interface ThresholdStats {
  currency: string;
  averageThreshold: number;
  medianThreshold: number;
  usersAtMinimum: number;
  usersWithCustom: number;
  totalUsers: number;
}

export class PaymentThresholdManager extends EventEmitter {
  private config: ThresholdConfig;
  private userThresholds: Map<string, UserThreshold> = new Map();
  private networkFees: Map<string, number> = new Map();
  private updateTimer?: NodeJS.Timer;

  constructor(config: ThresholdConfig) {
    super();
    this.config = config;
  }

  /**
   * Initialize threshold manager
   */
  async initialize(): Promise<void> {
    logger.info('Initializing payment threshold manager');

    // Load user thresholds from storage
    await this.loadUserThresholds();

    // Start fee update timer if enabled
    if (this.config.feeAdjustment.enabled) {
      this.startFeeUpdates();
    }

    this.emit('initialized');
  }

  /**
   * Get threshold for user
   */
  getThreshold(userId: string, currency: string = 'BTC'): number {
    const userKey = `${userId}-${currency}`;
    const userThreshold = this.userThresholds.get(userKey);

    if (userThreshold) {
      return userThreshold.effectiveThreshold;
    }

    // Return default for currency
    const currencyConfig = this.config.currencies.get(currency);
    return currencyConfig?.default || this.config.global.default;
  }

  /**
   * Set custom threshold for user
   */
  async setCustomThreshold(
    userId: string,
    currency: string,
    threshold: number
  ): Promise<void> {
    const currencyConfig = this.config.currencies.get(currency);
    if (!currencyConfig) {
      throw new Error(`Currency ${currency} not supported`);
    }

    // Validate threshold
    const minimum = Math.max(currencyConfig.minimum, this.config.global.minimum);
    const maximum = this.config.global.maximum;

    if (threshold < minimum) {
      throw new Error(`Threshold below minimum ${minimum}`);
    }

    if (threshold > maximum) {
      throw new Error(`Threshold above maximum ${maximum}`);
    }

    // Get or create user threshold
    const userKey = `${userId}-${currency}`;
    let userThreshold = this.userThresholds.get(userKey);

    if (!userThreshold) {
      userThreshold = {
        userId,
        currency,
        effectiveThreshold: threshold,
        lastUpdated: new Date(),
        autoAdjust: false
      };
    }

    userThreshold.customThreshold = threshold;
    userThreshold.effectiveThreshold = this.calculateEffectiveThreshold(
      userId,
      currency,
      threshold
    );
    userThreshold.lastUpdated = new Date();
    userThreshold.autoAdjust = false;

    this.userThresholds.set(userKey, userThreshold);

    logger.info('Custom threshold set', {
      userId,
      currency,
      threshold,
      effective: userThreshold.effectiveThreshold
    });

    this.emit('threshold:updated', {
      userId,
      currency,
      threshold: userThreshold.effectiveThreshold
    });

    // Persist
    await this.persistUserThreshold(userThreshold);
  }

  /**
   * Enable auto-adjustment for user
   */
  async enableAutoAdjust(userId: string, currency: string): Promise<void> {
    const userKey = `${userId}-${currency}`;
    let userThreshold = this.userThresholds.get(userKey);

    if (!userThreshold) {
      userThreshold = {
        userId,
        currency,
        effectiveThreshold: this.getDefaultThreshold(currency),
        lastUpdated: new Date(),
        autoAdjust: true
      };
    }

    userThreshold.autoAdjust = true;
    userThreshold.customThreshold = undefined;
    userThreshold.effectiveThreshold = this.calculateAutoThreshold(currency);
    userThreshold.lastUpdated = new Date();

    this.userThresholds.set(userKey, userThreshold);

    logger.info('Auto-adjustment enabled', {
      userId,
      currency,
      threshold: userThreshold.effectiveThreshold
    });

    this.emit('threshold:auto-enabled', { userId, currency });

    await this.persistUserThreshold(userThreshold);
  }

  /**
   * Calculate effective threshold considering tier
   */
  private calculateEffectiveThreshold(
    userId: string,
    currency: string,
    baseThreshold: number
  ): number {
    if (!this.config.tiers.enabled) {
      return baseThreshold;
    }

    const tier = this.getUserTier(userId);
    if (!tier) {
      return baseThreshold;
    }

    return baseThreshold * tier.thresholdMultiplier;
  }

  /**
   * Get user tier based on hashrate
   */
  private getUserTier(userId: string): TierLevel | null {
    if (!this.config.tiers.enabled) return null;

    // This would get actual user hashrate from mining stats
    const userHashrate = this.getUserHashrate(userId);

    // Find appropriate tier
    const tier = this.config.tiers.levels
      .sort((a, b) => b.minHashrate - a.minHashrate)
      .find(t => userHashrate >= t.minHashrate);

    return tier || null;
  }

  /**
   * Get user hashrate (placeholder)
   */
  private getUserHashrate(userId: string): number {
    // This would connect to actual mining statistics
    return 1000000000; // 1 GH/s placeholder
  }

  /**
   * Calculate auto threshold based on network fees
   */
  private calculateAutoThreshold(currency: string): number {
    const currencyConfig = this.config.currencies.get(currency);
    if (!currencyConfig) {
      return this.config.global.default;
    }

    const networkFee = this.networkFees.get(currency) || currencyConfig.networkFee || 0;
    
    if (this.config.feeAdjustment.enabled && networkFee > 0) {
      // Threshold should be at least X times the network fee
      const feeBasedThreshold = networkFee * this.config.feeAdjustment.multiplier;
      
      // Ensure within bounds
      return Math.max(
        currencyConfig.minimum,
        Math.min(this.config.global.maximum, feeBasedThreshold)
      );
    }

    return currencyConfig.default;
  }

  /**
   * Get default threshold for currency
   */
  private getDefaultThreshold(currency: string): number {
    const currencyConfig = this.config.currencies.get(currency);
    return currencyConfig?.default || this.config.global.default;
  }

  /**
   * Update network fees
   */
  async updateNetworkFees(): Promise<void> {
    logger.info('Updating network fees');

    for (const [currency, config] of this.config.currencies) {
      try {
        const fee = await this.fetchNetworkFee(currency);
        this.networkFees.set(currency, fee);

        // Update auto-adjusting thresholds
        await this.updateAutoThresholds(currency);
      } catch (err) {
        logger.error('Failed to update network fee', {
          currency,
          error: err
        });
      }
    }

    this.emit('fees:updated', Object.fromEntries(this.networkFees));
  }

  /**
   * Fetch network fee for currency
   */
  private async fetchNetworkFee(currency: string): Promise<number> {
    // This would fetch actual network fees from blockchain or fee estimation service
    switch (currency) {
      case 'BTC':
        return 0.00005; // 5000 sats
      case 'ETH':
        return 0.002; // 0.002 ETH
      case 'LTC':
        return 0.0001; // 0.0001 LTC
      default:
        return 0;
    }
  }

  /**
   * Update auto-adjusting thresholds
   */
  private async updateAutoThresholds(currency: string): Promise<void> {
    const autoUsers = Array.from(this.userThresholds.values()).filter(
      ut => ut.currency === currency && ut.autoAdjust
    );

    if (autoUsers.length === 0) return;

    const newThreshold = this.calculateAutoThreshold(currency);

    for (const userThreshold of autoUsers) {
      const oldThreshold = userThreshold.effectiveThreshold;
      userThreshold.effectiveThreshold = newThreshold;
      userThreshold.lastUpdated = new Date();

      if (Math.abs(oldThreshold - newThreshold) / oldThreshold > 0.1) {
        // Notify user if threshold changed by more than 10%
        this.emit('threshold:auto-adjusted', {
          userId: userThreshold.userId,
          currency,
          oldThreshold,
          newThreshold
        });
      }
    }

    logger.info('Auto thresholds updated', {
      currency,
      users: autoUsers.length,
      threshold: newThreshold
    });
  }

  /**
   * Check if balance meets threshold
   */
  meetsThreshold(userId: string, currency: string, balance: number): boolean {
    const threshold = this.getThreshold(userId, currency);
    return balance >= threshold;
  }

  /**
   * Get users ready for payment
   */
  getUsersReadyForPayment(
    balances: Map<string, { currency: string; balance: number }>
  ): string[] {
    const readyUsers: string[] = [];

    for (const [userId, { currency, balance }] of balances) {
      if (this.meetsThreshold(userId, currency, balance)) {
        readyUsers.push(userId);
      }
    }

    return readyUsers;
  }

  /**
   * Optimize payment batch
   */
  optimizePaymentBatch(
    candidates: Array<{ userId: string; currency: string; balance: number }>
  ): Array<{ userId: string; currency: string; balance: number }> {
    // Sort by currency to batch same-currency payments
    const byCurrency = new Map<string, typeof candidates>();

    for (const candidate of candidates) {
      const currencyBatch = byCurrency.get(candidate.currency) || [];
      currencyBatch.push(candidate);
      byCurrency.set(candidate.currency, currencyBatch);
    }

    const optimized: typeof candidates = [];

    // Process each currency
    for (const [currency, batch] of byCurrency) {
      const networkFee = this.networkFees.get(currency) || 0;
      const currencyConfig = this.config.currencies.get(currency);
      
      if (!currencyConfig) continue;

      // Sort by balance descending
      batch.sort((a, b) => b.balance - a.balance);

      // Include users where payment is cost-effective
      for (const candidate of batch) {
        const feePercentage = networkFee / candidate.balance;
        
        // Include if fee is less than 5% of balance or user has custom threshold
        if (feePercentage < 0.05 || this.hasCustomThreshold(candidate.userId, currency)) {
          optimized.push(candidate);
        }
      }
    }

    return optimized;
  }

  /**
   * Check if user has custom threshold
   */
  private hasCustomThreshold(userId: string, currency: string): boolean {
    const userKey = `${userId}-${currency}`;
    const userThreshold = this.userThresholds.get(userKey);
    return userThreshold?.customThreshold !== undefined;
  }

  /**
   * Get threshold statistics
   */
  getStatistics(): ThresholdStats[] {
    const stats = new Map<string, ThresholdStats>();

    // Initialize stats for each currency
    for (const [currency] of this.config.currencies) {
      stats.set(currency, {
        currency,
        averageThreshold: 0,
        medianThreshold: 0,
        usersAtMinimum: 0,
        usersWithCustom: 0,
        totalUsers: 0
      });
    }

    // Calculate statistics
    for (const userThreshold of this.userThresholds.values()) {
      const stat = stats.get(userThreshold.currency);
      if (!stat) continue;

      stat.totalUsers++;
      
      if (userThreshold.customThreshold) {
        stat.usersWithCustom++;
      }

      const currencyConfig = this.config.currencies.get(userThreshold.currency);
      if (currencyConfig && userThreshold.effectiveThreshold === currencyConfig.minimum) {
        stat.usersAtMinimum++;
      }
    }

    // Calculate averages
    for (const [currency, stat] of stats) {
      const thresholds = Array.from(this.userThresholds.values())
        .filter(ut => ut.currency === currency)
        .map(ut => ut.effectiveThreshold);

      if (thresholds.length > 0) {
        stat.averageThreshold = thresholds.reduce((a, b) => a + b) / thresholds.length;
        
        // Calculate median
        thresholds.sort((a, b) => a - b);
        const mid = Math.floor(thresholds.length / 2);
        stat.medianThreshold = thresholds.length % 2 === 0
          ? (thresholds[mid - 1] + thresholds[mid]) / 2
          : thresholds[mid];
      }
    }

    return Array.from(stats.values());
  }

  /**
   * Start fee update timer
   */
  private startFeeUpdates(): void {
    // Initial update
    this.updateNetworkFees();

    // Schedule regular updates
    this.updateTimer = setInterval(() => {
      this.updateNetworkFees();
    }, this.config.feeAdjustment.updateInterval);
  }

  /**
   * Load user thresholds from storage
   */
  private async loadUserThresholds(): Promise<void> {
    // TODO: Implement storage loading
    logger.info('Loading user thresholds');
  }

  /**
   * Persist user threshold
   */
  private async persistUserThreshold(threshold: UserThreshold): Promise<void> {
    // TODO: Implement storage persistence
  }

  /**
   * Add currency support
   */
  addCurrency(currency: CurrencyThreshold): void {
    this.config.currencies.set(currency.symbol, currency);
    logger.info('Added currency support', { currency: currency.symbol });
    this.emit('currency:added', currency);
  }

  /**
   * Update currency configuration
   */
  updateCurrency(symbol: string, updates: Partial<CurrencyThreshold>): void {
    const currency = this.config.currencies.get(symbol);
    if (!currency) {
      throw new Error(`Currency ${symbol} not found`);
    }

    Object.assign(currency, updates);
    logger.info('Updated currency configuration', { symbol, updates });
    this.emit('currency:updated', { symbol, updates });
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
export { ThresholdConfig, CurrencyThreshold, TierLevel, UserThreshold, ThresholdStats };
