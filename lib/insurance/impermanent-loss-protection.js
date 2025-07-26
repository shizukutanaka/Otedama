/**
 * Impermanent Loss Protection - Otedama
 * Insurance fund system to protect liquidity providers from impermanent loss
 * Maximizes user confidence and participation in liquidity provision
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('ImpermanentLossProtection');

/**
 * Protection levels
 */
export const ProtectionLevel = {
  BASIC: 'basic',         // 50% protection
  PREMIUM: 'premium',     // 80% protection
  COMPLETE: 'complete'    // 100% protection
};

/**
 * Insurance claim status
 */
export const ClaimStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PAID: 'paid'
};

/**
 * Pool risk levels
 */
export const RiskLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  EXTREME: 'extreme'
};

/**
 * Impermanent Loss Protection System
 */
export class ImpermanentLossProtection extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      fundTargetSize: options.fundTargetSize || 1000000, // $1M target
      premiumRate: options.premiumRate || 0.01, // 1% of LP value
      minLockPeriod: options.minLockPeriod || 604800000, // 7 days
      maxClaimPeriod: options.maxClaimPeriod || 2592000000, // 30 days
      riskAssessmentInterval: options.riskAssessmentInterval || 3600000, // 1 hour
      claimProcessingDelay: options.claimProcessingDelay || 86400000, // 24 hours
      ...options
    };
    
    this.insuranceFund = {
      totalFunds: 0,
      availableFunds: 0,
      reservedFunds: 0,
      totalClaims: 0,
      totalPayouts: 0
    };
    
    this.policies = new Map(); // policyId -> policy data
    this.claims = new Map(); // claimId -> claim data
    this.poolRisks = new Map(); // poolAddress -> risk assessment
    this.priceHistory = new Map(); // token -> price history
    this.protectedPositions = new Map(); // positionId -> position data
    
    this.stats = {
      totalPoliciesSold: 0,
      totalPremiumsCollected: 0,
      totalClaimsProcessed: 0,
      totalPayoutsMade: 0,
      averageClaimSize: 0,
      claimSuccessRate: 0,
      fundUtilizationRate: 0
    };
  }
  
  /**
   * Initialize insurance system
   */
  async initialize() {
    logger.info('Initializing impermanent loss protection...');
    
    // Start monitoring cycles
    this.startRiskAssessment();
    this.startPriceTracking();
    this.startClaimProcessing();
    this.startFundManagement();
    
    logger.info('Impermanent loss protection initialized');
    this.emit('initialized');
  }
  
  /**
   * Purchase insurance policy
   */
  async purchasePolicy(params) {
    const {
      userId,
      poolAddress,
      lpTokenAmount,
      protectionLevel = ProtectionLevel.PREMIUM,
      duration = this.config.minLockPeriod
    } = params;
    
    // Validate parameters
    if (lpTokenAmount <= 0) {
      throw new Error('LP token amount must be positive');
    }
    
    if (duration < this.config.minLockPeriod) {
      throw new Error(`Minimum protection duration is ${this.config.minLockPeriod / 86400000} days`);
    }
    
    // Assess pool risk
    const riskAssessment = await this.assessPoolRisk(poolAddress);
    
    if (riskAssessment.level === RiskLevel.EXTREME) {
      throw new Error('Pool risk too high for insurance coverage');
    }
    
    // Calculate premium
    const premium = await this.calculatePremium({
      lpTokenAmount,
      protectionLevel,
      duration,
      riskLevel: riskAssessment.level,
      poolAddress
    });
    
    // Check fund capacity
    if (!await this.checkFundCapacity(premium.maxPayout)) {
      throw new Error('Insufficient fund capacity for this policy');
    }
    
    const policyId = this.generatePolicyId();
    const policy = {
      id: policyId,
      userId,
      poolAddress,
      lpTokenAmount,
      protectionLevel,
      duration,
      premium: premium.amount,
      maxPayout: premium.maxPayout,
      startTime: Date.now(),
      endTime: Date.now() + duration,
      isActive: true,
      initialPoolValue: await this.calculatePoolValue(poolAddress, lpTokenAmount),
      initialTokenPrices: await this.getTokenPrices(poolAddress),
      riskLevel: riskAssessment.level
    };
    
    // Collect premium
    await this.collectPremium(userId, premium.amount);
    
    // Reserve funds for potential claim
    this.reserveFunds(premium.maxPayout);
    
    // Store policy
    this.policies.set(policyId, policy);
    
    // Update statistics
    this.stats.totalPoliciesSold++;
    this.stats.totalPremiumsCollected += premium.amount;
    
    logger.info(`Insurance policy purchased`, {
      policyId,
      userId,
      premium: premium.amount,
      maxPayout: premium.maxPayout,
      protectionLevel
    });
    
    this.emit('policy:purchased', {
      policyId,
      policy
    });
    
    return policy;
  }
  
  /**
   * File insurance claim
   */
  async fileClaim(params) {
    const {
      policyId,
      userId,
      claimReason,
      evidence
    } = params;
    
    const policy = this.policies.get(policyId);
    if (!policy) {
      throw new Error('Policy not found');
    }
    
    if (policy.userId !== userId) {
      throw new Error('Unauthorized claim attempt');
    }
    
    if (!policy.isActive) {
      throw new Error('Policy is not active');
    }
    
    const now = Date.now();
    if (now > policy.endTime + this.config.maxClaimPeriod) {
      throw new Error('Claim period has expired');
    }
    
    // Calculate impermanent loss
    const impermanentLoss = await this.calculateImpermanentLoss(policy);
    
    if (impermanentLoss.amount <= 0) {
      throw new Error('No impermanent loss detected');
    }
    
    const claimId = this.generateClaimId();
    const claim = {
      id: claimId,
      policyId,
      userId,
      claimReason,
      evidence,
      impermanentLoss,
      claimAmount: this.calculateClaimAmount(impermanentLoss.amount, policy.protectionLevel),
      status: ClaimStatus.PENDING,
      filedAt: now,
      processedAt: null,
      paidAt: null
    };
    
    // Store claim
    this.claims.set(claimId, claim);
    
    logger.info(`Insurance claim filed`, {
      claimId,
      policyId,
      claimAmount: claim.claimAmount,
      impermanentLoss: impermanentLoss.amount
    });
    
    this.emit('claim:filed', {
      claimId,
      claim
    });
    
    // Start claim verification process
    await this.initiateClaimVerification(claimId);
    
    return claim;
  }
  
  /**
   * Calculate impermanent loss
   */
  async calculateImpermanentLoss(policy) {
    const { poolAddress, lpTokenAmount, initialPoolValue, initialTokenPrices } = policy;
    
    // Get current token prices
    const currentPrices = await this.getTokenPrices(poolAddress);
    
    // Get pool composition
    const poolInfo = await this.getPoolInfo(poolAddress);
    const { tokenA, tokenB } = poolInfo;
    
    // Calculate price ratios
    const initialRatio = initialTokenPrices[tokenA] / initialTokenPrices[tokenB];
    const currentRatio = currentPrices[tokenA] / currentPrices[tokenB];
    
    // Calculate value if held individually vs LP
    const currentPoolValue = await this.calculatePoolValue(poolAddress, lpTokenAmount);
    const holdValue = this.calculateHoldValue(initialPoolValue, initialTokenPrices, currentPrices, poolInfo);
    
    // Impermanent loss = hold value - current pool value
    const impermanentLossAmount = Math.max(0, holdValue - currentPoolValue);
    const impermanentLossPercentage = impermanentLossAmount / holdValue;
    
    return {
      amount: impermanentLossAmount,
      percentage: impermanentLossPercentage,
      initialValue: initialPoolValue,
      currentValue: currentPoolValue,
      holdValue,
      priceChange: {
        tokenA: (currentPrices[tokenA] - initialTokenPrices[tokenA]) / initialTokenPrices[tokenA],
        tokenB: (currentPrices[tokenB] - initialTokenPrices[tokenB]) / initialTokenPrices[tokenB]
      }
    };
  }
  
  /**
   * Calculate claim amount based on protection level
   */
  calculateClaimAmount(impermanentLoss, protectionLevel) {
    const protectionRates = {
      [ProtectionLevel.BASIC]: 0.5,      // 50% coverage
      [ProtectionLevel.PREMIUM]: 0.8,    // 80% coverage
      [ProtectionLevel.COMPLETE]: 1.0    // 100% coverage
    };
    
    return impermanentLoss * protectionRates[protectionLevel];
  }
  
  /**
   * Calculate insurance premium
   */
  async calculatePremium(params) {
    const { lpTokenAmount, protectionLevel, duration, riskLevel, poolAddress } = params;
    
    // Get pool value
    const poolValue = await this.calculatePoolValue(poolAddress, lpTokenAmount);
    
    // Base premium rate
    let basePremiumRate = this.config.premiumRate;
    
    // Risk level multipliers
    const riskMultipliers = {
      [RiskLevel.LOW]: 0.5,
      [RiskLevel.MEDIUM]: 1.0,
      [RiskLevel.HIGH]: 2.0,
      [RiskLevel.EXTREME]: 5.0
    };
    
    // Protection level multipliers
    const protectionMultipliers = {
      [ProtectionLevel.BASIC]: 0.6,
      [ProtectionLevel.PREMIUM]: 1.0,
      [ProtectionLevel.COMPLETE]: 1.5
    };
    
    // Duration multiplier (longer = higher rate)
    const durationMultiplier = Math.sqrt(duration / this.config.minLockPeriod);
    
    // Calculate premium
    const premiumRate = basePremiumRate * 
                       riskMultipliers[riskLevel] * 
                       protectionMultipliers[protectionLevel] * 
                       durationMultiplier;
    
    const premiumAmount = poolValue * premiumRate;
    const maxPayout = this.calculateClaimAmount(poolValue, protectionLevel);
    
    return {
      amount: premiumAmount,
      rate: premiumRate,
      maxPayout,
      riskLevel,
      protectionLevel
    };
  }
  
  /**
   * Assess pool risk
   */
  async assessPoolRisk(poolAddress) {
    const poolInfo = await this.getPoolInfo(poolAddress);
    const { tokenA, tokenB, totalLiquidity, volume24h, fees24h } = poolInfo;
    
    let riskScore = 0;
    
    // 1. Volatility risk
    const volatilityA = await this.calculateTokenVolatility(tokenA);
    const volatilityB = await this.calculateTokenVolatility(tokenB);
    const avgVolatility = (volatilityA + volatilityB) / 2;
    
    if (avgVolatility > 0.5) riskScore += 40;
    else if (avgVolatility > 0.3) riskScore += 25;
    else if (avgVolatility > 0.1) riskScore += 10;
    
    // 2. Liquidity risk
    if (totalLiquidity < 1000000) riskScore += 30; // < $1M
    else if (totalLiquidity < 10000000) riskScore += 15; // < $10M
    else if (totalLiquidity < 100000000) riskScore += 5; // < $100M
    
    // 3. Volume/Liquidity ratio
    const volumeRatio = volume24h / totalLiquidity;
    if (volumeRatio > 2) riskScore += 20; // High turnover
    else if (volumeRatio > 1) riskScore += 10;
    
    // 4. Token correlation
    const correlation = await this.calculateTokenCorrelation(tokenA, tokenB);
    if (correlation < -0.5) riskScore += 25; // Negative correlation increases IL risk
    else if (correlation < 0) riskScore += 15;
    
    // 5. Pool age and stability
    const poolAge = await this.getPoolAge(poolAddress);
    if (poolAge < 2592000000) riskScore += 20; // < 30 days
    else if (poolAge < 7776000000) riskScore += 10; // < 90 days
    
    // Determine risk level
    let riskLevel;
    if (riskScore >= 80) riskLevel = RiskLevel.EXTREME;
    else if (riskScore >= 60) riskLevel = RiskLevel.HIGH;
    else if (riskScore >= 30) riskLevel = RiskLevel.MEDIUM;
    else riskLevel = RiskLevel.LOW;
    
    const assessment = {
      poolAddress,
      riskScore,
      level: riskLevel,
      factors: {
        volatility: avgVolatility,
        liquidity: totalLiquidity,
        volumeRatio,
        correlation,
        poolAge
      },
      timestamp: Date.now()
    };
    
    // Cache assessment
    this.poolRisks.set(poolAddress, assessment);
    
    return assessment;
  }
  
  /**
   * Process insurance claims
   */
  async processClaimQueue() {
    const pendingClaims = Array.from(this.claims.values())
      .filter(claim => claim.status === ClaimStatus.PENDING)
      .filter(claim => Date.now() - claim.filedAt >= this.config.claimProcessingDelay);
    
    for (const claim of pendingClaims) {
      try {
        await this.processClaim(claim.id);
      } catch (error) {
        logger.error(`Error processing claim ${claim.id}:`, error);
      }
    }
  }
  
  /**
   * Process individual claim
   */
  async processClaim(claimId) {
    const claim = this.claims.get(claimId);
    if (!claim) return;
    
    const policy = this.policies.get(claim.policyId);
    if (!policy) {
      claim.status = ClaimStatus.REJECTED;
      return;
    }
    
    // Verify claim legitimacy
    const verification = await this.verifyClaim(claim);
    
    if (!verification.isValid) {
      claim.status = ClaimStatus.REJECTED;
      claim.rejectionReason = verification.reason;
      
      logger.info(`Claim rejected: ${claimId} - ${verification.reason}`);
      this.emit('claim:rejected', { claimId, reason: verification.reason });
      return;
    }
    
    // Approve claim
    claim.status = ClaimStatus.APPROVED;
    claim.processedAt = Date.now();
    
    // Pay out claim
    try {
      await this.payoutClaim(claim);
      
      claim.status = ClaimStatus.PAID;
      claim.paidAt = Date.now();
      
      // Update statistics
      this.stats.totalClaimsProcessed++;
      this.stats.totalPayoutsMade += claim.claimAmount;
      this.updateClaimStats();
      
      logger.info(`Claim paid: ${claimId} - Amount: ${claim.claimAmount}`);
      this.emit('claim:paid', { claimId, amount: claim.claimAmount });
      
    } catch (error) {
      logger.error(`Failed to pay claim ${claimId}:`, error);
      claim.status = ClaimStatus.APPROVED; // Keep approved, retry later
    }
  }
  
  /**
   * Verify claim legitimacy
   */
  async verifyClaim(claim) {
    const policy = this.policies.get(claim.policyId);
    
    // 1. Check if policy is still valid
    if (!policy.isActive) {
      return { isValid: false, reason: 'Policy not active' };
    }
    
    // 2. Recalculate impermanent loss
    const currentIL = await this.calculateImpermanentLoss(policy);
    
    // 3. Check if impermanent loss is significant
    if (currentIL.amount < claim.impermanentLoss.amount * 0.9) {
      return { isValid: false, reason: 'Impermanent loss amount dispute' };
    }
    
    // 4. Check for suspicious activity
    const suspiciousActivity = await this.checkForSuspiciousActivity(claim);
    if (suspiciousActivity.detected) {
      return { isValid: false, reason: suspiciousActivity.reason };
    }
    
    // 5. Verify evidence
    const evidenceValid = await this.verifyEvidence(claim.evidence);
    if (!evidenceValid) {
      return { isValid: false, reason: 'Invalid evidence provided' };
    }
    
    return { isValid: true };
  }
  
  /**
   * Fund management
   */
  async manageFunds() {
    // Check fund health
    const fundHealth = this.assessFundHealth();
    
    if (fundHealth.needsCapital) {
      await this.raiseFunds(fundHealth.requiredAmount);
    }
    
    // Rebalance fund allocation
    await this.rebalanceFunds();
    
    // Update fund utilization
    this.stats.fundUtilizationRate = this.insuranceFund.reservedFunds / this.insuranceFund.totalFunds;
  }
  
  /**
   * Helper methods
   */
  async getPoolInfo(poolAddress) {
    // Mock implementation - would fetch from DEX
    return {
      tokenA: 'ETH',
      tokenB: 'USDC',
      totalLiquidity: 50000000, // $50M
      volume24h: 5000000, // $5M
      fees24h: 15000, // $15k
      reserves: {
        tokenA: 20000 * 1e18,
        tokenB: 30000000 * 1e6
      }
    };
  }
  
  async getTokenPrices(poolAddress) {
    // Mock implementation - would fetch from price oracle
    return {
      ETH: 3000,
      USDC: 1
    };
  }
  
  async calculatePoolValue(poolAddress, lpTokenAmount) {
    const poolInfo = await this.getPoolInfo(poolAddress);
    const prices = await this.getTokenPrices(poolAddress);
    
    // Simplified calculation
    return lpTokenAmount * 1000; // Mock $1000 per LP token
  }
  
  calculateHoldValue(initialValue, initialPrices, currentPrices, poolInfo) {
    // Calculate what the value would be if tokens were held individually
    const { tokenA, tokenB } = poolInfo;
    
    const priceChangeA = currentPrices[tokenA] / initialPrices[tokenA];
    const priceChangeB = currentPrices[tokenB] / initialPrices[tokenB];
    
    // Assume 50/50 split initially
    return initialValue * 0.5 * (priceChangeA + priceChangeB);
  }
  
  async calculateTokenVolatility(token) {
    // Calculate 30-day volatility
    // Mock implementation
    return Math.random() * 0.3; // 0-30%
  }
  
  async calculateTokenCorrelation(tokenA, tokenB) {
    // Calculate price correlation
    // Mock implementation
    return (Math.random() - 0.5) * 2; // -1 to 1
  }
  
  async getPoolAge(poolAddress) {
    // Mock implementation
    return Date.now() - (Math.random() * 31536000000); // Random age up to 1 year
  }
  
  generatePolicyId() {
    return `policy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateClaimId() {
    return `claim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  async checkFundCapacity(requiredAmount) {
    return this.insuranceFund.availableFunds >= requiredAmount;
  }
  
  async collectPremium(userId, amount) {
    // Collect premium from user
    this.insuranceFund.totalFunds += amount;
    this.insuranceFund.availableFunds += amount;
    
    logger.debug(`Premium collected from ${userId}: ${amount}`);
  }
  
  reserveFunds(amount) {
    this.insuranceFund.availableFunds -= amount;
    this.insuranceFund.reservedFunds += amount;
  }
  
  async initiateClaimVerification(claimId) {
    // Start automated verification process
    setTimeout(() => {
      this.processClaim(claimId);
    }, this.config.claimProcessingDelay);
  }
  
  async checkForSuspiciousActivity(claim) {
    // Check for patterns indicating fraud
    // Mock implementation
    return { detected: false };
  }
  
  async verifyEvidence(evidence) {
    // Verify provided evidence
    // Mock implementation
    return true;
  }
  
  async payoutClaim(claim) {
    // Pay out claim amount
    this.insuranceFund.reservedFunds -= claim.claimAmount;
    this.insuranceFund.totalClaims += claim.claimAmount;
    this.insuranceFund.totalPayouts += claim.claimAmount;
    
    logger.debug(`Claim payout: ${claim.claimAmount}`);
  }
  
  assessFundHealth() {
    const utilizationRate = this.insuranceFund.reservedFunds / this.insuranceFund.totalFunds;
    const needsCapital = utilizationRate > 0.8 || this.insuranceFund.availableFunds < this.config.fundTargetSize * 0.1;
    
    return {
      utilizationRate,
      needsCapital,
      requiredAmount: needsCapital ? this.config.fundTargetSize * 0.2 : 0
    };
  }
  
  async raiseFunds(amount) {
    // Raise additional funds through various mechanisms
    logger.info(`Raising ${amount} for insurance fund`);
  }
  
  async rebalanceFunds() {
    // Rebalance fund investments
    logger.debug('Rebalancing insurance fund');
  }
  
  updateClaimStats() {
    const paidClaims = Array.from(this.claims.values()).filter(c => c.status === ClaimStatus.PAID);
    
    if (paidClaims.length > 0) {
      this.stats.averageClaimSize = paidClaims.reduce((sum, c) => sum + c.claimAmount, 0) / paidClaims.length;
    }
    
    const totalClaims = this.claims.size;
    this.stats.claimSuccessRate = totalClaims > 0 ? paidClaims.length / totalClaims : 0;
  }
  
  /**
   * Start monitoring cycles
   */
  startRiskAssessment() {
    setInterval(() => {
      // Reassess pool risks
      for (const poolAddress of this.poolRisks.keys()) {
        this.assessPoolRisk(poolAddress);
      }
    }, this.config.riskAssessmentInterval);
  }
  
  startPriceTracking() {
    setInterval(async () => {
      // Update price history for all tracked tokens
      const tokens = new Set();
      for (const policy of this.policies.values()) {
        const poolInfo = await this.getPoolInfo(policy.poolAddress);
        tokens.add(poolInfo.tokenA);
        tokens.add(poolInfo.tokenB);
      }
      
      for (const token of tokens) {
        // Update price history
      }
    }, 60000); // Every minute
  }
  
  startClaimProcessing() {
    setInterval(() => {
      this.processClaimQueue();
    }, 300000); // Every 5 minutes
  }
  
  startFundManagement() {
    setInterval(() => {
      this.manageFunds();
    }, 3600000); // Every hour
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      fundStatus: this.insuranceFund,
      activePolicies: Array.from(this.policies.values()).filter(p => p.isActive).length,
      pendingClaims: Array.from(this.claims.values()).filter(c => c.status === ClaimStatus.PENDING).length,
      fundUtilization: this.stats.fundUtilizationRate
    };
  }
  
  /**
   * Get policy info
   */
  getPolicyInfo(policyId) {
    return this.policies.get(policyId);
  }
  
  /**
   * Get claim info
   */
  getClaimInfo(claimId) {
    return this.claims.get(claimId);
  }
  
  /**
   * Shutdown
   */
  shutdown() {
    this.removeAllListeners();
    logger.info('Impermanent loss protection shutdown');
  }
}

export default ImpermanentLossProtection;