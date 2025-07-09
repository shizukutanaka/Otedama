/**
 * Payment Threshold Settings - Minimum Payout Management
 * Following Carmack/Martin/Pike principles:
 * - Flexible threshold configuration
 * - User-customizable settings
 * - Efficient balance tracking
 */

import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

interface ThresholdConfig {
  // Default thresholds
  defaults: {
    minimum: number; // Absolute minimum allowed
    standard: number; // Default for new users
    maximum: number; // Maximum allowed threshold
  };
  
  // Currency settings
  currency: {
    symbol: string; // BTC, ETH, etc.
    decimals: number;
    dustLimit: number; // Minimum transaction amount
  };
  
  // Dynamic threshold
  dynamic: {
    enabled: boolean;
    basedOn: 'network-fee' | 'exchange-rate' | 'both';
    updateInterval: number; // seconds
    multiplier: number; // For fee-based calculation
  };
  
  // User preferences
  userPreferences: {
    allowCustom: boolean;
    requireVerification: boolean; // For high thresholds
    cooldownPeriod: number; // Time between changes
  };
}

interface UserThreshold {
  userId: string;
  threshold: number;
  customThreshold?: number;
  
  // History
  previousThreshold?: number;
  lastChanged?: Date;
  changeCount: number;
  
  // Verification
  verified: boolean;
  verificationDate?: Date;
  
  // Preferences
  autoAdjust: boolean; // Allow dynamic adjustments
  notifications: {
    nearThreshold: boolean;
    thresholdReached: boolean;
    paymentSent: boolean;
  };
}

interface ThresholdStats {
  totalUsers: number;
  distribution: {
    range: string;
    count: number;
    percentage: number;
  }[];
  averageThreshold: number;
  medianThreshold: number;
}

interface DynamicThresholdData {
  networkFee: number;
  exchangeRate?: number;
  calculatedThreshold: number;
  lastUpdate: Date;
  nextUpdate: Date;
}

export class PaymentThresholdManager extends EventEmitter {
  private config: ThresholdConfig;
  private userThresholds: Map<string, UserThreshold> = new Map();
  private dynamicData?: DynamicThresholdData;
  private updateTimer?: NodeJS.Timer;

  constructor(config: ThresholdConfig) {
    super();
    this.config = config;
  }

  /**
   * Initialize threshold manager
   */
  async initialize(): Promise<void> {
    logger.info('Initializing payment threshold manager', {
      minimum: this.config.defaults.minimum,
      standard: this.config.defaults.standard,
      maximum: this.config.defaults.maximum,
      dynamic: this.config.dynamic.enabled
    });

    // Start dynamic updates if enabled
    if (this.config.dynamic.enabled) {
      await this.updateDynamicThreshold();
      this.startDynamicUpdates();
    }

    this.emit('initialized');
  }

  /**
   * Get user threshold
   */
  getUserThreshold(userId: string): number {
    const userConfig = this.userThresholds.get(userId);
    
    if (!userConfig) {
      return this.getDefaultThreshold();
    }

    // Use custom threshold if set and allowed
    if (userConfig.customThreshold && this.config.userPreferences.allowCustom) {
      return userConfig.customThreshold;
    }

    // Use dynamic threshold if user opted in
    if (userConfig.autoAdjust && this.dynamicData) {
      return Math.max(
        this.config.defaults.minimum,
        Math.min(this.dynamicData.calculatedThreshold, this.config.defaults.maximum)
      );
    }

    return userConfig.threshold;
  }

  /**
   * Set user threshold
   */
  async setUserThreshold(
    userId: string, 
    threshold: number,
    options: {
      verified?: boolean;
      force?: boolean;
    } = {}
  ): Promise<void> {
    // Validate threshold
    if (!options.force) {
      if (threshold < this.config.defaults.minimum) {
        throw new Error(`Threshold below minimum: ${this.config.defaults.minimum}`);
      }
      
      if (threshold > this.config.defaults.maximum) {
        throw new Error(`Threshold above maximum: ${this.config.defaults.maximum}`);
      }

      // Check if high threshold requires verification
      if (threshold > this.config.defaults.standard * 10 && 
          this.config.userPreferences.requireVerification && 
          !options.verified) {
        throw new Error('High threshold requires verification');
      }
    }

    let userConfig = this.userThresholds.get(userId);
    
    // Check cooldown period
    if (userConfig && userConfig.lastChanged) {
      const timeSinceLastChange = Date.now() - userConfig.lastChanged.getTime();
      if (timeSinceLastChange < this.config.userPreferences.cooldownPeriod * 1000) {
        throw new Error(`Please wait ${Math.ceil((this.config.userPreferences.cooldownPeriod * 1000 - timeSinceLastChange) / 1000)} seconds before changing threshold again`);
      }
    }

    if (!userConfig) {
      userConfig = {
        userId,
        threshold: this.config.defaults.standard,
        changeCount: 0,
        verified: false,
        autoAdjust: false,
        notifications: {
          nearThreshold: true,
          thresholdReached: true,
          paymentSent: true
        }
      };
    }

    // Update threshold
    userConfig.previousThreshold = userConfig.customThreshold || userConfig.threshold;
    userConfig.customThreshold = threshold;
    userConfig.lastChanged = new Date();
    userConfig.changeCount++;
    
    if (options.verified) {
      userConfig.verified = true;
      userConfig.verificationDate = new Date();
    }

    this.userThresholds.set(userId, userConfig);

    logger.info('User threshold updated', {
      userId,
      oldThreshold: userConfig.previousThreshold,
      newThreshold: threshold,
      changeCount: userConfig.changeCount
    });

    this.emit('threshold:updated', {
      userId,
      threshold,
      previous: userConfig.previousThreshold
    });
  }

  /**
   * Get default threshold
   */
  private getDefaultThreshold(): number {
    if (this.config.dynamic.enabled && this.dynamicData) {
      return Math.max(
        this.config.defaults.minimum,
        Math.min(this.dynamicData.calculatedThreshold, this.config.defaults.standard)
      );
    }
    
    return this.config.defaults.standard;
  }

  /**
   * Update dynamic threshold
   */
  private async updateDynamicThreshold(): Promise<void> {
    try {
      let calculatedThreshold = this.config.defaults.standard;
      
      // Get network fee if needed
      let networkFee = 0;
      if (this.config.dynamic.basedOn === 'network-fee' || 
          this.config.dynamic.basedOn === 'both') {
        networkFee = await this.getNetworkFee();
        
        // Calculate threshold based on fee
        // Threshold should be at least X times the network fee
        const feeBasedThreshold = networkFee * this.config.dynamic.multiplier;
        calculatedThreshold = Math.max(calculatedThreshold, feeBasedThreshold);
      }

      // Get exchange rate if needed
      let exchangeRate;
      if (this.config.dynamic.basedOn === 'exchange-rate' || 
          this.config.dynamic.basedOn === 'both') {
        exchangeRate = await this.getExchangeRate();
        
        // Adjust threshold based on exchange rate
        // For example, maintain a USD value
        const targetUSD = 10; // $10 minimum
        const rateBasedThreshold = targetUSD / exchangeRate;
        calculatedThreshold = Math.max(calculatedThreshold, rateBasedThreshold);
      }

      // Ensure within bounds
      calculatedThreshold = Math.max(
        this.config.defaults.minimum,
        Math.min(calculatedThreshold, this.config.defaults.maximum)
      );

      // Round to appropriate decimals
      const factor = Math.pow(10, this.config.currency.decimals);
      calculatedThreshold = Math.round(calculatedThreshold * factor) / factor;

      this.dynamicData = {
        networkFee,
        exchangeRate,
        calculatedThreshold,
        lastUpdate: new Date(),
        nextUpdate: new Date(Date.now() + this.config.dynamic.updateInterval * 1000)
      };

      logger.info('Dynamic threshold updated', {
        networkFee,
        exchangeRate,
        calculatedThreshold
      });

      this.emit('threshold:dynamic:updated', this.dynamicData);

      // Notify users with auto-adjust enabled
      this.notifyAutoAdjustUsers();

    } catch (err) {
      logger.error('Failed to update dynamic threshold', { error: err });
    }
  }

  /**
   * Get network fee (placeholder)
   */
  private async getNetworkFee(): Promise<number> {
    // This would fetch actual network fees
    // For now, return mock value
    return 0.00001; // BTC
  }

  /**
   * Get exchange rate (placeholder)
   */
  private async getExchangeRate(): Promise<number> {
    // This would fetch actual exchange rate
    // For now, return mock value
    return 50000; // USD per BTC
  }

  /**
   * Notify users with auto-adjust
   */
  private notifyAutoAdjustUsers(): void {
    if (!this.dynamicData) return;

    for (const [userId, config] of this.userThresholds) {
      if (config.autoAdjust) {
        const oldThreshold = config.threshold;
        const newThreshold = this.dynamicData.calculatedThreshold;
        
        if (Math.abs(oldThreshold - newThreshold) / oldThreshold > 0.1) {
          // Threshold changed by more than 10%
          this.emit('threshold:auto:adjusted', {
            userId,
            oldThreshold,
            newThreshold,
            reason: 'dynamic_update'
          });
        }
      }
    }
  }

  /**
   * Start dynamic updates
   */
  private startDynamicUpdates(): void {
    this.updateTimer = setInterval(() => {
      this.updateDynamicThreshold();
    }, this.config.dynamic.updateInterval * 1000);
  }

  /**
   * Check if balance meets threshold
   */
  shouldPayout(userId: string, balance: number): boolean {
    const threshold = this.getUserThreshold(userId);
    return balance >= threshold;
  }

  /**
   * Get payout readiness
   */
  getPayoutReadiness(userId: string, balance: number): {
    ready: boolean;
    threshold: number;
    percentage: number;
    amountNeeded: number;
  } {
    const threshold = this.getUserThreshold(userId);
    const percentage = (balance / threshold) * 100;
    
    return {
      ready: balance >= threshold,
      threshold,
      percentage: Math.min(100, percentage),
      amountNeeded: Math.max(0, threshold - balance)
    };
  }

  /**
   * Set user preferences
   */
  setUserPreferences(
    userId: string,
    preferences: Partial<{
      autoAdjust: boolean;
      notifications: Partial<UserThreshold['notifications']>;
    }>
  ): void {
    let userConfig = this.userThresholds.get(userId);
    
    if (!userConfig) {
      userConfig = {
        userId,
        threshold: this.config.defaults.standard,
        changeCount: 0,
        verified: false,
        autoAdjust: false,
        notifications: {
          nearThreshold: true,
          thresholdReached: true,
          paymentSent: true
        }
      };
    }

    if (preferences.autoAdjust !== undefined) {
      userConfig.autoAdjust = preferences.autoAdjust;
    }

    if (preferences.notifications) {
      userConfig.notifications = {
        ...userConfig.notifications,
        ...preferences.notifications
      };
    }

    this.userThresholds.set(userId, userConfig);

    this.emit('preferences:updated', {
      userId,
      preferences: userConfig
    });
  }

  /**
   * Get threshold statistics
   */
  getStatistics(): ThresholdStats {
    const thresholds = Array.from(this.userThresholds.values()).map(u => 
      u.customThreshold || u.threshold
    );

    if (thresholds.length === 0) {
      return {
        totalUsers: 0,
        distribution: [],
        averageThreshold: this.config.defaults.standard,
        medianThreshold: this.config.defaults.standard
      };
    }

    // Calculate distribution
    const ranges = [
      { min: 0, max: this.config.defaults.minimum, label: 'Below Minimum' },
      { min: this.config.defaults.minimum, max: this.config.defaults.standard * 0.5, label: 'Low' },
      { min: this.config.defaults.standard * 0.5, max: this.config.defaults.standard * 1.5, label: 'Standard' },
      { min: this.config.defaults.standard * 1.5, max: this.config.defaults.standard * 3, label: 'High' },
      { min: this.config.defaults.standard * 3, max: Infinity, label: 'Very High' }
    ];

    const distribution = ranges.map(range => {
      const count = thresholds.filter(t => t >= range.min && t < range.max).length;
      return {
        range: range.label,
        count,
        percentage: (count / thresholds.length) * 100
      };
    });

    // Calculate average and median
    const sum = thresholds.reduce((a, b) => a + b, 0);
    const average = sum / thresholds.length;
    
    const sorted = [...thresholds].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    return {
      totalUsers: this.userThresholds.size,
      distribution,
      averageThreshold: average,
      medianThreshold: median
    };
  }

  /**
   * Check and notify near-threshold balances
   */
  checkNearThresholdBalances(balances: Map<string, number>): void {
    for (const [userId, balance] of balances) {
      const config = this.userThresholds.get(userId);
      if (!config || !config.notifications.nearThreshold) continue;

      const threshold = this.getUserThreshold(userId);
      const percentage = (balance / threshold) * 100;

      if (percentage >= 80 && percentage < 100) {
        this.emit('threshold:near', {
          userId,
          balance,
          threshold,
          percentage,
          amountNeeded: threshold - balance
        });
      }
    }
  }

  /**
   * Export user settings
   */
  exportUserSettings(): any[] {
    return Array.from(this.userThresholds.values()).map(config => ({
      userId: config.userId,
      threshold: config.customThreshold || config.threshold,
      autoAdjust: config.autoAdjust,
      verified: config.verified,
      lastChanged: config.lastChanged,
      notifications: config.notifications
    }));
  }

  /**
   * Import user settings
   */
  importUserSettings(settings: any[]): void {
    for (const setting of settings) {
      try {
        this.setUserThreshold(setting.userId, setting.threshold, {
          verified: setting.verified,
          force: true
        });
        
        if (setting.autoAdjust !== undefined || setting.notifications) {
          this.setUserPreferences(setting.userId, {
            autoAdjust: setting.autoAdjust,
            notifications: setting.notifications
          });
        }
      } catch (err) {
        logger.error('Failed to import user setting', {
          userId: setting.userId,
          error: err
        });
      }
    }
  }

  /**
   * Cleanup
   */
  cleanup(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
  }
}

// Export types
export { ThresholdConfig, UserThreshold, ThresholdStats, DynamicThresholdData };
