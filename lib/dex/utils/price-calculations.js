/**
 * Shared Price Calculation Utilities for DEX Systems
 * Consolidates duplicated price calculation logic across all DEX components
 * 
 * Design principles:
 * - Carmack: High-performance mathematical operations
 * - Martin: Single responsibility for each calculation
 * - Pike: Simple, reliable price utilities
 */

import { BigNumber } from 'ethers';

// Hard limits for slippage protection
export const SLIPPAGE_LIMITS = {
  ABSOLUTE_MAX: 5000, // 50% in basis points
  DEFAULT_MAX: 1000, // 10% in basis points
  HIGH_VOLATILITY_MAX: 2000, // 20% in basis points
  STABLECOIN_MAX: 50, // 0.5% in basis points
  EMERGENCY_STOP: 10000 // 100% - circuit breaker
};

/**
 * Calculate slippage between expected and actual prices with protection
 */
export function calculateSlippage(expectedPrice, actualPrice, options = {}) {
  if (expectedPrice.isZero()) return BigNumber.from(0);
  
  const difference = expectedPrice.sub(actualPrice).abs();
  const slippageBps = difference.mul(10000).div(expectedPrice); // Basis points
  
  // Apply hard limits based on asset type
  const maxSlippage = options.maxSlippage || SLIPPAGE_LIMITS.DEFAULT_MAX;
  
  if (slippageBps.gt(maxSlippage)) {
    throw new Error(
      `Slippage ${slippageBps.toString()} exceeds maximum allowed ${maxSlippage}`
    );
  }
  
  return slippageBps;
}

/**
 * Calculate protected slippage with multiple safety checks
 */
export function calculateProtectedSlippage(
  expectedPrice,
  actualPrice,
  assetType = 'default',
  userMaxSlippage = null
) {
  // Determine appropriate limit based on asset type
  let hardLimit;
  switch (assetType) {
    case 'stablecoin':
      hardLimit = SLIPPAGE_LIMITS.STABLECOIN_MAX;
      break;
    case 'volatile':
      hardLimit = SLIPPAGE_LIMITS.HIGH_VOLATILITY_MAX;
      break;
    default:
      hardLimit = SLIPPAGE_LIMITS.DEFAULT_MAX;
  }
  
  // Use minimum of user preference and hard limit
  const effectiveLimit = userMaxSlippage 
    ? BigNumber.from(Math.min(userMaxSlippage, hardLimit))
    : BigNumber.from(hardLimit);
  
  const slippage = calculateSlippage(expectedPrice, actualPrice, {
    maxSlippage: effectiveLimit
  });
  
  // Emergency circuit breaker
  if (slippage.gte(SLIPPAGE_LIMITS.EMERGENCY_STOP)) {
    throw new Error('Emergency stop: Extreme slippage detected');
  }
  
  return {
    slippageBps: slippage,
    slippagePercent: slippage.toNumber() / 100,
    withinLimit: true,
    limit: effectiveLimit,
    assetType
  };
}

/**
 * Constant product formula for AMM calculations
 * Used by Automated Market Makers
 */
export function constantProductOutput(amountIn, reserveIn, reserveOut) {
  if (reserveIn.isZero() || reserveOut.isZero()) {
    return BigNumber.from(0);
  }
  
  const numerator = amountIn.mul(reserveOut);
  const denominator = reserveIn.add(amountIn);
  return numerator.div(denominator);
}

/**
 * Calculate price impact for a given trade
 */
export function calculatePriceImpact(amountIn, reserveIn, reserveOut) {
  if (reserveIn.isZero() || reserveOut.isZero()) {
    return BigNumber.from(0);
  }
  
  const initialPrice = reserveOut.mul(10000).div(reserveIn);
  const amountOut = constantProductOutput(amountIn, reserveIn, reserveOut);
  const finalReserveIn = reserveIn.add(amountIn);
  const finalReserveOut = reserveOut.sub(amountOut);
  const finalPrice = finalReserveOut.mul(10000).div(finalReserveIn);
  
  return calculateSlippage(initialPrice, finalPrice);
}

/**
 * Calculate spread between bid and ask prices
 */
export function calculateSpread(bestBid, bestAsk) {
  if (!bestBid || !bestAsk || bestAsk.isZero()) {
    return BigNumber.from(0);
  }
  
  const spread = bestAsk.sub(bestBid);
  return spread.mul(10000).div(bestAsk); // Basis points
}

/**
 * Calculate weighted average price from multiple price levels
 */
export function calculateWeightedAveragePrice(priceLevels, totalAmount) {
  if (!priceLevels.length || totalAmount.isZero()) {
    return BigNumber.from(0);
  }
  
  let weightedSum = BigNumber.from(0);
  let remainingAmount = totalAmount;
  
  for (const level of priceLevels) {
    const amountToFill = BigNumber.from(level.amount).lt(remainingAmount) 
      ? BigNumber.from(level.amount)
      : remainingAmount;
    
    weightedSum = weightedSum.add(
      BigNumber.from(level.price).mul(amountToFill)
    );
    
    remainingAmount = remainingAmount.sub(amountToFill);
    
    if (remainingAmount.isZero()) break;
  }
  
  return weightedSum.div(totalAmount.sub(remainingAmount));
}

/**
 * Calculate trading fees based on amount and fee rate
 */
export function calculateTradingFee(amount, feeRate) {
  return amount.mul(Math.floor(feeRate * 10000)).div(10000);
}

/**
 * Calculate liquidity provider fee
 */
export function calculateLiquidityProviderFee(amount, lpFeeRate) {
  return calculateTradingFee(amount, lpFeeRate);
}

/**
 * Calculate protocol fee
 */
export function calculateProtocolFee(amount, protocolFeeRate) {
  return calculateTradingFee(amount, protocolFeeRate);
}

/**
 * Calculate optimal swap route through multiple pools
 */
export function calculateOptimalRoute(amountIn, pools) {
  let bestOutput = BigNumber.from(0);
  let bestRoute = null;
  
  // Single hop routes
  for (const pool of pools) {
    const output = constantProductOutput(
      amountIn, 
      pool.reserveIn, 
      pool.reserveOut
    );
    
    if (output.gt(bestOutput)) {
      bestOutput = output;
      bestRoute = [pool];
    }
  }
  
  // Multi-hop routes (simplified - only 2-hop for now)
  for (let i = 0; i < pools.length; i++) {
    for (let j = i + 1; j < pools.length; j++) {
      const pool1 = pools[i];
      const pool2 = pools[j];
      
      // Check if pools can be chained
      if (pool1.tokenOut === pool2.tokenIn) {
        const intermediateOutput = constantProductOutput(
          amountIn,
          pool1.reserveIn,
          pool1.reserveOut
        );
        
        const finalOutput = constantProductOutput(
          intermediateOutput,
          pool2.reserveIn,
          pool2.reserveOut
        );
        
        if (finalOutput.gt(bestOutput)) {
          bestOutput = finalOutput;
          bestRoute = [pool1, pool2];
        }
      }
    }
  }
  
  return { amountOut: bestOutput, route: bestRoute };
}

/**
 * Price formatting utilities
 */
export const PriceFormatter = {
  /**
   * Format price for display
   */
  formatPrice(price, decimals = 6) {
    return parseFloat(price.toString()).toFixed(decimals);
  },
  
  /**
   * Format percentage
   */
  formatPercentage(basisPoints) {
    return (parseFloat(basisPoints.toString()) / 100).toFixed(2) + '%';
  },
  
  /**
   * Format large numbers with suffixes
   */
  formatLargeNumber(amount) {
    const num = parseFloat(amount.toString());
    
    if (num >= 1e9) {
      return (num / 1e9).toFixed(2) + 'B';
    } else if (num >= 1e6) {
      return (num / 1e6).toFixed(2) + 'M';
    } else if (num >= 1e3) {
      return (num / 1e3).toFixed(2) + 'K';
    } else {
      return num.toFixed(2);
    }
  }
};

/**
 * Price validation utilities with enhanced protection
 */
export const PriceValidator = {
  /**
   * Validate if price is within acceptable range
   */
  isValidPrice(price, minPrice = BigNumber.from(1), maxPrice = null) {
    if (price.lte(0)) return false;
    if (price.lt(minPrice)) return false;
    if (maxPrice && price.gt(maxPrice)) return false;
    return true;
  },
  
  /**
   * Check if price difference is within tolerance with hard limits
   */
  isPriceWithinTolerance(price1, price2, tolerancePercent = 5, assetType = 'default') {
    try {
      const result = calculateProtectedSlippage(price1, price2, assetType, tolerancePercent * 100);
      return result.withinLimit;
    } catch (error) {
      return false;
    }
  },
  
  /**
   * Validate price impact is acceptable with protection
   */
  isPriceImpactAcceptable(amountIn, reserveIn, reserveOut, maxImpactPercent = 10, options = {}) {
    const impact = calculatePriceImpact(amountIn, reserveIn, reserveOut);
    
    // Determine hard limit based on pool type
    const poolType = options.poolType || 'default';
    let hardLimit;
    
    switch (poolType) {
      case 'stablecoin':
        hardLimit = Math.min(maxImpactPercent * 100, SLIPPAGE_LIMITS.STABLECOIN_MAX);
        break;
      case 'concentrated':
        hardLimit = Math.min(maxImpactPercent * 100, 300); // 3% max for concentrated liquidity
        break;
      default:
        hardLimit = Math.min(maxImpactPercent * 100, SLIPPAGE_LIMITS.DEFAULT_MAX);
    }
    
    return impact.lte(hardLimit);
  },
  
  /**
   * Validate execution price against oracle price
   */
  validateAgainstOracle(executionPrice, oraclePrice, maxDeviation = 200) {
    if (!oraclePrice || oraclePrice.isZero()) {
      throw new Error('Invalid oracle price');
    }
    
    const deviation = executionPrice.sub(oraclePrice).abs().mul(10000).div(oraclePrice);
    
    if (deviation.gt(maxDeviation)) {
      throw new Error(
        `Price deviation ${deviation.toString()} bps exceeds maximum ${maxDeviation} bps`
      );
    }
    
    return {
      valid: true,
      deviationBps: deviation,
      executionPrice,
      oraclePrice
    };
  }
};

/**
 * Slippage protection manager
 */
export class SlippageProtectionManager {
  constructor(options = {}) {
    this.defaultMaxSlippage = options.defaultMaxSlippage || SLIPPAGE_LIMITS.DEFAULT_MAX;
    this.emergencyMode = false;
    this.priceHistory = new Map();
    this.violationCount = new Map();
  }
  
  /**
   * Validate trade with comprehensive slippage protection
   */
  validateTrade(trade) {
    const {
      pair,
      expectedPrice,
      executionPrice,
      amount,
      assetType = 'default',
      userMaxSlippage
    } = trade;
    
    // Emergency mode check
    if (this.emergencyMode) {
      throw new Error('Trading halted: Emergency mode active');
    }
    
    // Calculate and validate slippage
    const slippageResult = calculateProtectedSlippage(
      expectedPrice,
      executionPrice,
      assetType,
      userMaxSlippage
    );
    
    // Check historical price volatility
    const volatilityCheck = this.checkPriceVolatility(pair, executionPrice);
    if (!volatilityCheck.safe) {
      this.recordViolation(pair, 'high_volatility');
      throw new Error(`High volatility detected: ${volatilityCheck.volatilityBps} bps`);
    }
    
    // Record price for future volatility checks
    this.recordPrice(pair, executionPrice);
    
    return {
      approved: true,
      slippage: slippageResult,
      volatility: volatilityCheck,
      timestamp: Date.now()
    };
  }
  
  /**
   * Check price volatility over recent history
   */
  checkPriceVolatility(pair, currentPrice, windowMs = 60000) {
    const history = this.priceHistory.get(pair) || [];
    const cutoff = Date.now() - windowMs;
    
    const recentPrices = history.filter(h => h.timestamp > cutoff);
    
    if (recentPrices.length < 2) {
      return { safe: true, volatilityBps: 0, samples: recentPrices.length };
    }
    
    // Calculate max price deviation in window
    let maxDeviation = BigNumber.from(0);
    
    for (const historical of recentPrices) {
      const deviation = currentPrice.sub(historical.price).abs()
        .mul(10000).div(historical.price);
      
      if (deviation.gt(maxDeviation)) {
        maxDeviation = deviation;
      }
    }
    
    // Dynamic threshold based on asset type
    const threshold = pair.includes('STABLE') ? 100 : 500; // 1% for stables, 5% for others
    
    return {
      safe: maxDeviation.lte(threshold),
      volatilityBps: maxDeviation,
      samples: recentPrices.length,
      threshold
    };
  }
  
  /**
   * Record price for volatility tracking
   */
  recordPrice(pair, price) {
    if (!this.priceHistory.has(pair)) {
      this.priceHistory.set(pair, []);
    }
    
    const history = this.priceHistory.get(pair);
    history.push({
      price,
      timestamp: Date.now()
    });
    
    // Keep only recent history (5 minutes)
    const cutoff = Date.now() - 300000;
    const filtered = history.filter(h => h.timestamp > cutoff);
    this.priceHistory.set(pair, filtered);
  }
  
  /**
   * Record protection violation
   */
  recordViolation(pair, type) {
    const key = `${pair}:${type}`;
    const count = (this.violationCount.get(key) || 0) + 1;
    this.violationCount.set(key, count);
    
    // Trigger emergency mode if too many violations
    if (count > 10) {
      this.activateEmergencyMode();
    }
  }
  
  /**
   * Activate emergency mode
   */
  activateEmergencyMode() {
    this.emergencyMode = true;
    setTimeout(() => {
      this.emergencyMode = false;
      this.violationCount.clear();
    }, 300000); // 5 minute cooldown
  }
}

export default {
  calculateSlippage,
  calculateProtectedSlippage,
  constantProductOutput,
  calculatePriceImpact,
  calculateSpread,
  calculateWeightedAveragePrice,
  calculateTradingFee,
  calculateLiquidityProviderFee,
  calculateProtocolFee,
  calculateOptimalRoute,
  PriceFormatter,
  PriceValidator,
  SlippageProtectionManager,
  SLIPPAGE_LIMITS
};