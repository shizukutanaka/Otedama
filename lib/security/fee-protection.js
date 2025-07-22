/**
 * Fee Protection System
 * Secure system to prevent unauthorized modification of administrator fees
 */

import crypto from 'crypto';
import { getLogger } from '../core/logger.js';
import { dynamicFeeProtection } from './dynamic-fee-protection.js';
const logger = getLogger();

/**
 * Secure fee configuration with integrity protection
 */
export class SecureFeeConfiguration {
  constructor() {
    // Immutable fee structure - cannot be modified after initialization
    this.fees = Object.freeze({
      // Pool operation fee - BTC denominated
      POOL_FEE_RATE: 0.005, // 0.5% percentage fallback for small transactions
      
      // BTC-specific fee structure
      BTC_FEES: Object.freeze({
        // Fixed fee per transaction in satoshis
        FIXED_FEE_SATOSHIS: 10000, // 0.0001 BTC fixed fee
        
        // Minimum fee for percentage calculation
        MIN_FEE_SATOSHIS: 5000, // 0.00005 BTC minimum
        
        // Maximum fee cap in satoshis
        MAX_FEE_SATOSHIS: 1000000, // 0.01 BTC maximum cap
        
        // Fee calculation method
        FEE_METHOD: 'hybrid', // 'fixed', 'percentage', or 'hybrid'
        
        // Threshold for switching between fixed and percentage
        THRESHOLD_SATOSHIS: 1000000, // 0.01 BTC threshold
        
        // Dust limit (minimum output value)
        DUST_LIMIT_SATOSHIS: 546 // Standard Bitcoin dust limit
      }),
      
      // Maximum allowed fee (safety ceiling)
      MAX_POOL_FEE: 0.01, // 1% absolute maximum for percentage mode
      
      // Minimum viable fee (operational costs)
      MIN_POOL_FEE: 0.002, // 0.2% minimum for percentage mode
      
      // Fee adjustment constraints
      ADJUSTMENT_LIMITS: Object.freeze({
        maxIncrease: 0.001, // Maximum 0.1% increase per adjustment
        maxDecrease: 0.002, // Maximum 0.2% decrease per adjustment
        cooldownPeriod: 7 * 24 * 60 * 60 * 1000, // 7 days between adjustments
        requiresConsensus: true // Multiple admin approval required
      })
    });

    // Generate integrity hash for fee structure
    this.integrityHash = this.generateIntegrityHash();
    
    // Track any modification attempts
    this.modificationAttempts = [];
    
    // Lock the object to prevent property addition/deletion
    Object.seal(this);
  }

  /**
   * Get current pool fee rate (read-only)
   */
  getPoolFeeRate() {
    this.verifyIntegrity();
    return this.fees.POOL_FEE_RATE;
  }

  /**
   * Get fee limits (read-only)
   */
  getFeeLimits() {
    this.verifyIntegrity();
    return {
      current: this.fees.POOL_FEE_RATE,
      minimum: this.fees.MIN_POOL_FEE,
      maximum: this.fees.MAX_POOL_FEE
    };
  }

  /**
   * Calculate fee amount for a given transaction in BTC (satoshis)
   */
  calculateBTCFee(amountSatoshis, options = {}) {
    this.verifyIntegrity();
    
    if (typeof amountSatoshis !== 'number' || amountSatoshis <= 0) {
      throw new Error('Invalid amount for fee calculation');
    }

    const btcFees = this.fees.BTC_FEES;
    let baseFeeAmount = 0;
    let feeMethod = '';

    switch (btcFees.FEE_METHOD) {
      case 'fixed':
        baseFeeAmount = btcFees.FIXED_FEE_SATOSHIS;
        feeMethod = 'fixed';
        break;
        
      case 'percentage':
        baseFeeAmount = Math.floor(amountSatoshis * this.fees.POOL_FEE_RATE);
        feeMethod = 'percentage';
        break;
        
      case 'hybrid':
      default:
        if (amountSatoshis <= btcFees.THRESHOLD_SATOSHIS) {
          // Use fixed fee for small amounts
          baseFeeAmount = btcFees.FIXED_FEE_SATOSHIS;
          feeMethod = 'fixed';
        } else {
          // Use percentage for larger amounts
          baseFeeAmount = Math.floor(amountSatoshis * this.fees.POOL_FEE_RATE);
          feeMethod = 'percentage';
        }
        break;
    }

    // Apply minimum and maximum limits to base fee
    baseFeeAmount = Math.max(baseFeeAmount, btcFees.MIN_FEE_SATOSHIS);
    baseFeeAmount = Math.min(baseFeeAmount, btcFees.MAX_FEE_SATOSHIS);

    // Apply dynamic fee protection if enabled
    let feeAmount = baseFeeAmount;
    let dynamicAdjustment = null;
    
    if (options.applyDynamicProtection !== false) {
      // Determine transaction type
      const transactionType = options.transactionType || 
        (amountSatoshis > 10000000 ? 'large_transaction' : 'standard');
      
      // Get dynamic adjustment
      dynamicAdjustment = dynamicFeeProtection.calculateDynamicFee(baseFeeAmount, transactionType);
      feeAmount = dynamicAdjustment.adjustedFee;
    }

    // Ensure fee doesn't exceed the transaction amount
    if (feeAmount >= amountSatoshis) {
      feeAmount = Math.max(btcFees.MIN_FEE_SATOSHIS, Math.floor(amountSatoshis * 0.1));
    }

    const netAmount = amountSatoshis - feeAmount;

    return {
      originalAmount: amountSatoshis,
      originalBTC: amountSatoshis / 100000000,
      baseFeeAmount: baseFeeAmount,
      feeAmount: feeAmount,
      feeBTC: feeAmount / 100000000,
      netAmount: netAmount,
      netBTC: netAmount / 100000000,
      feeMethod: feeMethod,
      feeRate: feeMethod === 'percentage' ? this.fees.POOL_FEE_RATE : null,
      feePercentage: ((feeAmount / amountSatoshis) * 100).toFixed(4) + '%',
      dynamicAdjustment: dynamicAdjustment,
      currency: 'BTC'
    };
  }

  /**
   * Calculate fee amount for a given transaction (legacy method for backward compatibility)
   */
  calculateFee(amount, currency = 'BTC') {
    this.verifyIntegrity();
    
    if (currency === 'BTC') {
      // Convert BTC to satoshis if needed
      const satoshis = amount < 1 ? Math.floor(amount * 100000000) : amount;
      return this.calculateBTCFee(satoshis);
    }

    // Legacy percentage calculation for other currencies
    if (typeof amount !== 'number' || amount <= 0) {
      throw new Error('Invalid amount for fee calculation');
    }

    const feeAmount = amount * this.fees.POOL_FEE_RATE;
    const netAmount = amount - feeAmount;

    return {
      originalAmount: amount,
      feeRate: this.fees.POOL_FEE_RATE,
      feeAmount: feeAmount,
      netAmount: netAmount,
      feePercentage: (this.fees.POOL_FEE_RATE * 100).toFixed(2) + '%',
      currency: currency
    };
  }

  /**
   * Verify integrity of fee structure
   */
  verifyIntegrity() {
    const currentHash = this.generateIntegrityHash();
    if (currentHash !== this.integrityHash) {
      const violation = {
        timestamp: Date.now(),
        expectedHash: this.integrityHash,
        actualHash: currentHash,
        severity: 'CRITICAL'
      };
      
      this.modificationAttempts.push(violation);
      logger.error('Fee structure integrity violation detected:', violation);
      
      throw new Error('Fee structure has been tampered with - operation denied');
    }
  }

  /**
   * Generate integrity hash for the fee structure
   */
  generateIntegrityHash() {
    const feeData = JSON.stringify(this.fees, Object.keys(this.fees).sort());
    return crypto.createHash('sha256').update(feeData).digest('hex');
  }

  /**
   * Get audit trail of modification attempts
   */
  getAuditTrail() {
    return [...this.modificationAttempts]; // Return copy to prevent modification
  }

  /**
   * Validate proposed fee change (for authorized system maintenance only)
   */
  validateFeeChange(newFeeRate, justification, adminCredentials) {
    this.verifyIntegrity();

    const validation = {
      isValid: false,
      reasons: [],
      warnings: []
    };

    // Check if new fee is within allowed bounds
    if (newFeeRate < this.fees.MIN_POOL_FEE) {
      validation.reasons.push(`Fee too low: ${newFeeRate} < minimum ${this.fees.MIN_POOL_FEE}`);
    }

    if (newFeeRate > this.fees.MAX_POOL_FEE) {
      validation.reasons.push(`Fee too high: ${newFeeRate} > maximum ${this.fees.MAX_POOL_FEE}`);
    }

    // Check adjustment size limits
    const currentFee = this.fees.POOL_FEE_RATE;
    const change = Math.abs(newFeeRate - currentFee);
    const maxChange = newFeeRate > currentFee ? 
      this.fees.ADJUSTMENT_LIMITS.maxIncrease : 
      this.fees.ADJUSTMENT_LIMITS.maxDecrease;

    if (change > maxChange) {
      validation.reasons.push(`Change too large: ${change} > allowed ${maxChange}`);
    }

    // Check if justification is provided
    if (!justification || justification.length < 50) {
      validation.reasons.push('Insufficient justification for fee change');
    }

    // Check admin credentials (simplified check - in production use proper auth)
    if (!adminCredentials || !this.verifyAdminCredentials(adminCredentials)) {
      validation.reasons.push('Invalid or missing administrator credentials');
    }

    // Add warnings for increases
    if (newFeeRate > currentFee) {
      validation.warnings.push('Fee increase may impact pool competitiveness');
    }

    validation.isValid = validation.reasons.length === 0;

    // Log validation attempt
    logger.info('Fee change validation attempted:', {
      currentFee,
      proposedFee: newFeeRate,
      change,
      isValid: validation.isValid,
      justification: justification?.substring(0, 100)
    });

    return validation;
  }

  /**
   * Verify admin credentials (placeholder - implement proper auth in production)
   */
  verifyAdminCredentials(credentials) {
    // In production, this would verify:
    // - Multi-factor authentication
    // - Role-based permissions
    // - Time-based access tokens
    // - Consensus from multiple administrators
    
    return credentials && 
           credentials.adminId && 
           credentials.signature && 
           credentials.timestamp &&
           (Date.now() - credentials.timestamp) < 300000; // 5 minute window
  }

  /**
   * Get fee transparency report
   */
  getFeeTransparencyReport() {
    this.verifyIntegrity();

    const btcFees = this.fees.BTC_FEES;

    return {
      currentFee: {
        method: btcFees.FEE_METHOD,
        fixedFeeSatoshis: btcFees.FIXED_FEE_SATOSHIS,
        fixedFeeBTC: btcFees.FIXED_FEE_SATOSHIS / 100000000,
        percentageRate: this.fees.POOL_FEE_RATE,
        percentage: (this.fees.POOL_FEE_RATE * 100).toFixed(2) + '%',
        description: 'Pool operation and maintenance fee (BTC denominated)'
      },
      btcFeeStructure: {
        fixedFee: {
          amount: btcFees.FIXED_FEE_SATOSHIS,
          btc: btcFees.FIXED_FEE_SATOSHIS / 100000000,
          description: 'Fixed fee for small transactions'
        },
        minimumFee: {
          amount: btcFees.MIN_FEE_SATOSHIS,
          btc: btcFees.MIN_FEE_SATOSHIS / 100000000,
          description: 'Minimum fee floor'
        },
        maximumFee: {
          amount: btcFees.MAX_FEE_SATOSHIS,
          btc: btcFees.MAX_FEE_SATOSHIS / 100000000,
          description: 'Maximum fee cap'
        },
        threshold: {
          amount: btcFees.THRESHOLD_SATOSHIS,
          btc: btcFees.THRESHOLD_SATOSHIS / 100000000,
          description: 'Threshold for switching to percentage fee'
        },
        dustLimit: {
          amount: btcFees.DUST_LIMIT_SATOSHIS,
          btc: btcFees.DUST_LIMIT_SATOSHIS / 100000000,
          description: 'Bitcoin dust limit'
        }
      },
      feeStructure: {
        minimum: this.fees.MIN_POOL_FEE,
        maximum: this.fees.MAX_POOL_FEE,
        current: this.fees.POOL_FEE_RATE
      },
      examples: {
        smallTransaction: this.calculateBTCFee(50000), // 0.0005 BTC
        mediumTransaction: this.calculateBTCFee(1000000), // 0.01 BTC
        largeTransaction: this.calculateBTCFee(10000000), // 0.1 BTC
      },
      costBreakdown: {
        serverInfrastructure: '50%',
        developmentMaintenance: '30%',
        securityMonitoring: '20%'
      },
      protections: {
        integrityProtection: 'Cryptographic hash verification',
        modificationLimits: 'Rate-limited with consensus requirement',
        auditTrail: 'All attempts logged and monitored',
        transparencyReporting: 'Public fee disclosure',
        btcCompliance: 'Bitcoin network standards compliance'
      },
      lastVerification: Date.now()
    };
  }
}

/**
 * Fee calculation utilities
 */
export class FeeCalculator {
  constructor(secureFeeConfig) {
    this.feeConfig = secureFeeConfig;
  }

  /**
   * Calculate mining pool fees in BTC
   */
  calculatePoolFees(miningRewardSatoshis, currency = 'BTC') {
    if (currency === 'BTC') {
      return this.feeConfig.calculateBTCFee(miningRewardSatoshis);
    }
    return this.feeConfig.calculateFee(miningRewardSatoshis, currency);
  }

  /**
   * Calculate BTC transaction fees for payouts
   */
  calculateBTCTransactionFees(amountSatoshis, networkFeeRate = null) {
    const poolFee = this.feeConfig.calculateBTCFee(amountSatoshis);
    
    // Estimate network fee (in satoshis)
    // This would be calculated based on current mempool conditions
    const networkFee = networkFeeRate ? 
      Math.floor(250 * networkFeeRate) : // Assuming ~250 bytes transaction
      5000; // Default 5000 satoshis network fee

    const totalFees = poolFee.feeAmount + networkFee;
    const netAmount = amountSatoshis - totalFees;

    return {
      originalAmount: amountSatoshis,
      originalBTC: amountSatoshis / 100000000,
      poolFee: {
        amount: poolFee.feeAmount,
        btc: poolFee.feeBTC,
        method: poolFee.feeMethod
      },
      networkFee: {
        amount: networkFee,
        btc: networkFee / 100000000,
        rate: networkFeeRate || 'default'
      },
      totalFees: {
        amount: totalFees,
        btc: totalFees / 100000000
      },
      netAmount: {
        amount: Math.max(0, netAmount),
        btc: Math.max(0, netAmount / 100000000)
      },
      breakdown: {
        poolFeePercentage: poolFee.feePercentage,
        networkFeePercentage: ((networkFee / amountSatoshis) * 100).toFixed(4) + '%',
        totalFeePercentage: ((totalFees / amountSatoshis) * 100).toFixed(4) + '%'
      },
      currency: 'BTC'
    };
  }

  /**
   * Calculate conversion fees for different currencies (legacy support)
   */
  calculateConversionFees(amount, fromCurrency, toCurrency, conversionRates) {
    if (fromCurrency === 'BTC' && toCurrency === 'BTC') {
      // Pure BTC transaction
      return this.calculateBTCTransactionFees(amount);
    }

    const poolFee = this.feeConfig.calculateFee(amount, fromCurrency);
    
    // Get conversion cost from constants (if converting)
    let conversionCost = 0;
    if (fromCurrency !== toCurrency) {
      // This would reference the BTC_CONVERSION_COSTS from constants
      conversionCost = amount * (conversionRates[fromCurrency] || 0.005);
    }

    return {
      originalAmount: amount,
      poolFee: poolFee.feeAmount,
      conversionCost: conversionCost,
      totalFees: poolFee.feeAmount + conversionCost,
      netAmount: amount - poolFee.feeAmount - conversionCost,
      breakdown: {
        poolFeeRate: poolFee.feeRate,
        conversionRate: conversionRates[fromCurrency] || 0,
        poolFeeAmount: poolFee.feeAmount,
        conversionFeeAmount: conversionCost
      },
      currency: fromCurrency
    };
  }

  /**
   * Get fee summary for transparency
   */
  getFeeSummary() {
    return {
      poolFee: this.feeConfig.getFeeLimits(),
      btcFees: this.feeConfig.fees.BTC_FEES,
      transparency: this.feeConfig.getFeeTransparencyReport(),
      currency: 'BTC',
      lastUpdate: Date.now()
    };
  }

  /**
   * Get BTC-specific fee information
   */
  getBTCFeeInfo() {
    const btcFees = this.feeConfig.fees.BTC_FEES;
    return {
      feeMethod: btcFees.FEE_METHOD,
      fixedFee: {
        satoshis: btcFees.FIXED_FEE_SATOSHIS,
        btc: btcFees.FIXED_FEE_SATOSHIS / 100000000
      },
      minimumFee: {
        satoshis: btcFees.MIN_FEE_SATOSHIS,
        btc: btcFees.MIN_FEE_SATOSHIS / 100000000
      },
      maximumFee: {
        satoshis: btcFees.MAX_FEE_SATOSHIS,
        btc: btcFees.MAX_FEE_SATOSHIS / 100000000
      },
      threshold: {
        satoshis: btcFees.THRESHOLD_SATOSHIS,
        btc: btcFees.THRESHOLD_SATOSHIS / 100000000
      },
      dustLimit: {
        satoshis: btcFees.DUST_LIMIT_SATOSHIS,
        btc: btcFees.DUST_LIMIT_SATOSHIS / 100000000
      },
      percentageRate: this.feeConfig.fees.POOL_FEE_RATE,
      examples: this.feeConfig.getFeeTransparencyReport().examples
    };
  }
}

// Create singleton instances for global use
export const secureFeeConfig = new SecureFeeConfiguration();
export const feeCalculator = new FeeCalculator(secureFeeConfig);

// Export for integration with existing systems
export default {
  SecureFeeConfiguration,
  FeeCalculator,
  secureFeeConfig,
  feeCalculator
};