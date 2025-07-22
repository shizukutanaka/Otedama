import EventEmitter from 'events';
import crypto from 'crypto';

const InsuranceType = {
  SMART_CONTRACT: 'smart_contract',
  PROTOCOL_HACK: 'protocol_hack',
  IMPERMANENT_LOSS: 'impermanent_loss',
  LIQUIDATION: 'liquidation',
  SLASHING: 'slashing',
  BRIDGE_FAILURE: 'bridge_failure',
  STABLECOIN_DEPEG: 'stablecoin_depeg'
};

const CoverageStatus = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  CLAIMED: 'claimed',
  CANCELLED: 'cancelled',
  PENDING_CLAIM: 'pending_claim'
};

const ClaimStatus = {
  SUBMITTED: 'submitted',
  INVESTIGATING: 'investigating',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PAID: 'paid'
};

const RiskCategory = {
  VERY_LOW: 'very_low',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

const PolicyType = {
  BASIC: 'basic',
  PREMIUM: 'premium',
  COMPREHENSIVE: 'comprehensive',
  CUSTOM: 'custom'
};

export class RiskManagementInsuranceProtocol extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableDynamicPricing: options.enableDynamicPricing !== false,
      enableRiskAssessment: options.enableRiskAssessment !== false,
      enableAutoClaim: options.enableAutoClaim !== false,
      enableReinsurance: options.enableReinsurance !== false,
      enableParametricPayout: options.enableParametricPayout !== false,
      maxCoverageRatio: options.maxCoverageRatio || 0.8, // 80% of pool
      minUtilizationRate: options.minUtilizationRate || 0.1, // 10%
      basePremiumRate: options.basePremiumRate || 0.02, // 2% annually
      claimAssessmentTime: options.claimAssessmentTime || 7 * 24 * 60 * 60 * 1000, // 7 days
      parametricTriggerThreshold: options.parametricTriggerThreshold || 0.05, // 5%
      reinsuranceThreshold: options.reinsuranceThreshold || 10000000, // $10M
      maxSingleClaim: options.maxSingleClaim || 50000000 // $50M
    };

    this.insurancePools = new Map();
    this.coveragePolicies = new Map();
    this.claims = new Map();
    this.riskAssessments = new Map();
    this.premiumHistory = new Map();
    this.underwriters = new Map();
    this.reinsurers = new Map();
    this.parametricTriggers = new Map();
    
    this.isRunning = false;
    this.metrics = {
      totalPoolValue: 0,
      totalCoverage: 0,
      totalPremiums: 0,
      totalClaims: 0,
      claimsRatio: 0,
      activeNolicies: 0,
      averagePremium: 0,
      riskScore: 0,
      solvencyRatio: 0
    };

    this.initializeInsurancePools();
    this.initializeUnderwriters();
    this.startRiskMonitoring();
    this.startPremiumAdjustment();
    this.startClaimProcessing();
    this.startParametricMonitoring();
  }

  initializeInsurancePools() {
    const pools = [
      {
        name: 'DeFi Protocol Insurance',
        type: InsuranceType.PROTOCOL_HACK,
        capacity: 100000000, // $100M
        availableCapacity: 80000000,
        premiumRate: 0.025,
        maxCoverage: 10000000,
        riskCategory: RiskCategory.HIGH,
        protocols: ['Aave', 'Compound', 'Uniswap', 'Curve'],
        minCoveragePeriod: 30 * 24 * 60 * 60 * 1000, // 30 days
        maxCoveragePeriod: 365 * 24 * 60 * 60 * 1000 // 365 days
      },
      {
        name: 'Smart Contract Bugs',
        type: InsuranceType.SMART_CONTRACT,
        capacity: 50000000,
        availableCapacity: 40000000,
        premiumRate: 0.03,
        maxCoverage: 5000000,
        riskCategory: RiskCategory.MEDIUM,
        protocols: ['All DeFi protocols'],
        minCoveragePeriod: 7 * 24 * 60 * 60 * 1000,
        maxCoveragePeriod: 180 * 24 * 60 * 60 * 1000
      },
      {
        name: 'Impermanent Loss Protection',
        type: InsuranceType.IMPERMANENT_LOSS,
        capacity: 75000000,
        availableCapacity: 60000000,
        premiumRate: 0.015,
        maxCoverage: 2000000,
        riskCategory: RiskCategory.MEDIUM,
        protocols: ['Uniswap', 'SushiSwap', 'Curve', 'Balancer'],
        minCoveragePeriod: 1 * 24 * 60 * 60 * 1000,
        maxCoveragePeriod: 90 * 24 * 60 * 60 * 1000
      },
      {
        name: 'Liquidation Insurance',
        type: InsuranceType.LIQUIDATION,
        capacity: 30000000,
        availableCapacity: 25000000,
        premiumRate: 0.02,
        maxCoverage: 1000000,
        riskCategory: RiskCategory.HIGH,
        protocols: ['Aave', 'Compound', 'MakerDAO'],
        minCoveragePeriod: 1 * 24 * 60 * 60 * 1000,
        maxCoveragePeriod: 30 * 24 * 60 * 60 * 1000
      },
      {
        name: 'Bridge Failure Coverage',
        type: InsuranceType.BRIDGE_FAILURE,
        capacity: 40000000,
        availableCapacity: 35000000,
        premiumRate: 0.04,
        maxCoverage: 3000000,
        riskCategory: RiskCategory.HIGH,
        protocols: ['Multichain', 'Hop', 'Stargate', 'Synapse'],
        minCoveragePeriod: 1 * 24 * 60 * 60 * 1000,
        maxCoveragePeriod: 60 * 24 * 60 * 60 * 1000
      },
      {
        name: 'Stablecoin Depeg Protection',
        type: InsuranceType.STABLECOIN_DEPEG,
        capacity: 20000000,
        availableCapacity: 18000000,
        premiumRate: 0.01,
        maxCoverage: 500000,
        riskCategory: RiskCategory.LOW,
        protocols: ['USDC', 'USDT', 'DAI', 'FRAX'],
        minCoveragePeriod: 1 * 24 * 60 * 60 * 1000,
        maxCoveragePeriod: 30 * 24 * 60 * 60 * 1000
      }
    ];

    pools.forEach(pool => {
      this.insurancePools.set(pool.name, {
        ...pool,
        id: this.generatePoolId(),
        totalPremiums: 0,
        totalClaims: 0,
        activePolicies: 0,
        utilizationRate: (pool.capacity - pool.availableCapacity) / pool.capacity,
        createdAt: Date.now(),
        lastUpdate: Date.now()
      });
    });

    // Update total pool value metric
    this.metrics.totalPoolValue = Array.from(this.insurancePools.values())
      .reduce((sum, pool) => sum + pool.capacity, 0);
  }

  initializeUnderwriters() {
    const underwriters = [
      {
        name: 'Nexus Mutual',
        capacity: 200000000,
        riskAppetite: RiskCategory.MEDIUM,
        specialties: [InsuranceType.SMART_CONTRACT, InsuranceType.PROTOCOL_HACK],
        reputation: 0.95,
        stakingAmount: 50000000
      },
      {
        name: 'InsurAce',
        capacity: 150000000,
        riskAppetite: RiskCategory.HIGH,
        specialties: [InsuranceType.BRIDGE_FAILURE, InsuranceType.LIQUIDATION],
        reputation: 0.92,
        stakingAmount: 30000000
      },
      {
        name: 'Unslashed Finance',
        capacity: 100000000,
        riskAppetite: RiskCategory.LOW,
        specialties: [InsuranceType.STABLECOIN_DEPEG, InsuranceType.SLASHING],
        reputation: 0.98,
        stakingAmount: 40000000
      }
    ];

    underwriters.forEach(underwriter => {
      this.underwriters.set(underwriter.name, {
        ...underwriter,
        id: this.generateUnderwriterId(),
        availableCapacity: underwriter.capacity * 0.8,
        activePolicies: 0,
        totalPremiums: 0,
        totalClaims: 0,
        profitLoss: 0
      });
    });
  }

  async purchaseCoverage(user, poolName, coverageAmount, duration, options = {}) {
    try {
      const pool = this.insurancePools.get(poolName);
      if (!pool) {
        throw new Error('Insurance pool not found');
      }

      if (coverageAmount > pool.maxCoverage) {
        throw new Error(`Coverage amount exceeds maximum of ${pool.maxCoverage}`);
      }

      if (coverageAmount > pool.availableCapacity) {
        throw new Error('Insufficient pool capacity');
      }

      if (duration < pool.minCoveragePeriod || duration > pool.maxCoveragePeriod) {
        throw new Error('Coverage period outside allowed range');
      }

      // Assess risk and calculate premium
      const riskAssessment = await this.assessRisk(user, pool.type, coverageAmount, options);
      const basePremium = this.calculateBasePremium(coverageAmount, duration, pool.premiumRate);
      const riskAdjustedPremium = this.applyRiskAdjustment(basePremium, riskAssessment);
      const finalPremium = this.applyDynamicPricing(riskAdjustedPremium, pool);

      const policyId = this.generatePolicyId();
      const policy = {
        id: policyId,
        user,
        poolName,
        poolType: pool.type,
        coverageAmount,
        duration,
        premium: finalPremium,
        premiumRate: finalPremium / coverageAmount,
        startDate: Date.now(),
        endDate: Date.now() + duration,
        status: CoverageStatus.ACTIVE,
        riskScore: riskAssessment.score,
        riskFactors: riskAssessment.factors,
        protocols: options.protocols || pool.protocols,
        deductible: options.deductible || 0,
        policyType: options.policyType || PolicyType.BASIC,
        autoRenewal: options.autoRenewal || false,
        claimHistory: [],
        createdAt: Date.now()
      };

      this.coveragePolicies.set(policyId, policy);

      // Update pool state
      pool.availableCapacity -= coverageAmount;
      pool.totalPremiums += finalPremium;
      pool.activePolicies++;
      pool.utilizationRate = (pool.capacity - pool.availableCapacity) / pool.capacity;
      pool.lastUpdate = Date.now();

      // Update metrics
      this.metrics.totalCoverage += coverageAmount;
      this.metrics.totalPremiums += finalPremium;
      this.metrics.activeNolicies++;
      this.updateAveragePremium();

      this.emit('coveragePurchased', policy);
      return policyId;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async submitClaim(policyId, claimAmount, incident, evidence, options = {}) {
    try {
      const policy = this.coveragePolicies.get(policyId);
      if (!policy) {
        throw new Error('Policy not found');
      }

      if (policy.status !== CoverageStatus.ACTIVE) {
        throw new Error('Policy is not active');
      }

      if (Date.now() > policy.endDate) {
        throw new Error('Policy has expired');
      }

      if (claimAmount > policy.coverageAmount) {
        throw new Error('Claim amount exceeds coverage');
      }

      const claimId = this.generateClaimId();
      const claim = {
        id: claimId,
        policyId,
        user: policy.user,
        poolName: policy.poolName,
        poolType: policy.poolType,
        claimAmount,
        netClaimAmount: Math.max(0, claimAmount - policy.deductible),
        incident,
        evidence,
        submittedAt: Date.now(),
        status: ClaimStatus.SUBMITTED,
        assessors: [],
        assessmentDeadline: Date.now() + this.options.claimAssessmentTime,
        votes: { approve: 0, reject: 0 },
        finalDecision: null,
        payoutAmount: 0,
        processedAt: null
      };

      this.claims.set(claimId, claim);
      policy.status = CoverageStatus.PENDING_CLAIM;
      policy.claimHistory.push(claimId);

      // Check for parametric triggers if applicable
      if (this.options.enableParametricPayout) {
        const parametricResult = await this.checkParametricTriggers(claim);
        if (parametricResult.triggered) {
          await this.processParametricPayout(claimId, parametricResult);
        }
      }

      // Assign assessors
      await this.assignClaimAssessors(claimId);

      this.emit('claimSubmitted', claim);
      return claimId;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async assessClaim(claimId, assessor, decision, reasoning) {
    try {
      const claim = this.claims.get(claimId);
      if (!claim) {
        throw new Error('Claim not found');
      }

      if (claim.status !== ClaimStatus.INVESTIGATING) {
        throw new Error('Claim is not in investigation status');
      }

      if (!claim.assessors.includes(assessor)) {
        throw new Error('Assessor not assigned to this claim');
      }

      // Record assessment
      const assessment = {
        assessor,
        decision, // 'approve' or 'reject'
        reasoning,
        timestamp: Date.now()
      };

      if (!claim.assessments) {
        claim.assessments = [];
      }
      claim.assessments.push(assessment);

      // Update votes
      if (decision === 'approve') {
        claim.votes.approve++;
      } else {
        claim.votes.reject++;
      }

      // Check if we have enough votes to make a decision
      const totalVotes = claim.votes.approve + claim.votes.reject;
      const requiredVotes = Math.ceil(claim.assessors.length / 2);

      if (totalVotes >= requiredVotes) {
        const approved = claim.votes.approve > claim.votes.reject;
        await this.finalizeClaim(claimId, approved);
      }

      this.emit('claimAssessed', { claimId, assessor, decision });
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async finalizeClaim(claimId, approved) {
    try {
      const claim = this.claims.get(claimId);
      if (!claim) {
        throw new Error('Claim not found');
      }

      const policy = this.coveragePolicies.get(claim.policyId);
      if (!policy) {
        throw new Error('Policy not found');
      }

      const pool = this.insurancePools.get(claim.poolName);
      if (!pool) {
        throw new Error('Pool not found');
      }

      claim.finalDecision = approved;
      claim.processedAt = Date.now();

      if (approved) {
        claim.status = ClaimStatus.APPROVED;
        claim.payoutAmount = claim.netClaimAmount;
        
        // Update pool
        pool.totalClaims += claim.payoutAmount;
        pool.availableCapacity += (policy.coverageAmount - claim.payoutAmount);

        // Update policy
        policy.status = CoverageStatus.CLAIMED;
        policy.coverageAmount -= claim.payoutAmount;

        // Update metrics
        this.metrics.totalClaims += claim.payoutAmount;
        this.updateClaimsRatio();

        // Process payout
        await this.processPayout(claimId);
      } else {
        claim.status = ClaimStatus.REJECTED;
        
        // Restore policy to active if not expired
        if (Date.now() <= policy.endDate) {
          policy.status = CoverageStatus.ACTIVE;
        } else {
          policy.status = CoverageStatus.EXPIRED;
        }
      }

      this.emit('claimFinalized', claim);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async processPayout(claimId) {
    try {
      const claim = this.claims.get(claimId);
      if (!claim || claim.status !== ClaimStatus.APPROVED) {
        return;
      }

      // Simulate payout process
      await this.delay(2000);

      claim.status = ClaimStatus.PAID;
      claim.paidAt = Date.now();

      this.emit('payoutProcessed', {
        claimId,
        amount: claim.payoutAmount,
        recipient: claim.user
      });

      return true;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async assessRisk(user, insuranceType, amount, options = {}) {
    try {
      let riskScore = 0;
      const riskFactors = [];

      // Base risk by insurance type
      const baseRisks = {
        [InsuranceType.SMART_CONTRACT]: 0.3,
        [InsuranceType.PROTOCOL_HACK]: 0.4,
        [InsuranceType.IMPERMANENT_LOSS]: 0.2,
        [InsuranceType.LIQUIDATION]: 0.35,
        [InsuranceType.SLASHING]: 0.15,
        [InsuranceType.BRIDGE_FAILURE]: 0.45,
        [InsuranceType.STABLECOIN_DEPEG]: 0.1
      };

      riskScore += baseRisks[insuranceType] || 0.25;
      riskFactors.push({ factor: 'insurance_type', impact: baseRisks[insuranceType] || 0.25 });

      // Protocol-specific risks
      if (options.protocols) {
        const protocolRisk = await this.assessProtocolRisk(options.protocols);
        riskScore += protocolRisk * 0.3;
        riskFactors.push({ factor: 'protocol_risk', impact: protocolRisk });
      }

      // Amount-based risk (larger amounts = higher risk)
      const amountRisk = Math.min(0.2, amount / 10000000); // Max 20% for $10M+
      riskScore += amountRisk;
      riskFactors.push({ factor: 'amount_risk', impact: amountRisk });

      // User history risk
      const userRisk = await this.assessUserRisk(user);
      riskScore += userRisk * 0.15;
      riskFactors.push({ factor: 'user_risk', impact: userRisk });

      // Market conditions risk
      const marketRisk = await this.assessMarketRisk();
      riskScore += marketRisk * 0.1;
      riskFactors.push({ factor: 'market_risk', impact: marketRisk });

      // Normalize to 0-1 scale
      riskScore = Math.min(1, Math.max(0, riskScore));

      const assessment = {
        score: riskScore,
        category: this.categorizeTisk(riskScore),
        factors: riskFactors,
        assessedAt: Date.now(),
        assessmentId: this.generateAssessmentId()
      };

      this.riskAssessments.set(assessment.assessmentId, assessment);
      
      return assessment;
    } catch (error) {
      this.emit('error', error);
      return { score: 0.5, category: RiskCategory.MEDIUM, factors: [] };
    }
  }

  calculateBasePremium(amount, duration, premiumRate) {
    const annualPremium = amount * premiumRate;
    const durationInYears = duration / (365 * 24 * 60 * 60 * 1000);
    return annualPremium * durationInYears;
  }

  applyRiskAdjustment(basePremium, riskAssessment) {
    const riskMultipliers = {
      [RiskCategory.VERY_LOW]: 0.8,
      [RiskCategory.LOW]: 0.9,
      [RiskCategory.MEDIUM]: 1.0,
      [RiskCategory.HIGH]: 1.3,
      [RiskCategory.CRITICAL]: 1.8
    };

    const multiplier = riskMultipliers[riskAssessment.category] || 1.0;
    return basePremium * multiplier;
  }

  applyDynamicPricing(premium, pool) {
    // Adjust based on pool utilization
    const utilizationAdjustment = 1 + (pool.utilizationRate * 0.5); // Up to 50% increase
    
    // Adjust based on claims ratio
    const claimsRatio = pool.totalClaims / (pool.totalPremiums || 1);
    const claimsAdjustment = 1 + Math.min(1, claimsRatio * 0.3); // Up to 30% increase

    // Adjust based on available capacity
    const capacityRatio = pool.availableCapacity / pool.capacity;
    const capacityAdjustment = capacityRatio < 0.2 ? 1.2 : 1.0; // 20% increase if low capacity

    return premium * utilizationAdjustment * claimsAdjustment * capacityAdjustment;
  }

  startRiskMonitoring() {
    if (this.riskMonitor) return;
    
    this.riskMonitor = setInterval(async () => {
      try {
        // Update risk scores for all active policies
        for (const [policyId, policy] of this.coveragePolicies) {
          if (policy.status === CoverageStatus.ACTIVE) {
            // Check for risk changes
            const newRiskAssessment = await this.assessRisk(
              policy.user, 
              policy.poolType, 
              policy.coverageAmount,
              { protocols: policy.protocols }
            );

            const riskIncrease = newRiskAssessment.score - policy.riskScore;
            
            if (riskIncrease > 0.2) { // 20% risk increase
              this.emit('riskEscalation', {
                policyId,
                oldRiskScore: policy.riskScore,
                newRiskScore: newRiskAssessment.score,
                riskIncrease
              });

              // Update policy risk score
              policy.riskScore = newRiskAssessment.score;
            }
          }
        }

        // Update overall system risk score
        await this.updateSystemRiskScore();

      } catch (error) {
        this.emit('error', error);
      }
    }, 3600000); // Check every hour
  }

  startPremiumAdjustment() {
    if (this.premiumAdjuster) return;
    
    this.premiumAdjuster = setInterval(async () => {
      try {
        for (const [poolName, pool] of this.insurancePools) {
          const oldRate = pool.premiumRate;
          
          // Adjust based on claims experience
          const claimsRatio = pool.totalClaims / (pool.totalPremiums || 1);
          let adjustment = 1.0;

          if (claimsRatio > 0.8) { // High claims ratio
            adjustment = 1.2;
          } else if (claimsRatio < 0.3) { // Low claims ratio
            adjustment = 0.9;
          }

          // Adjust based on capacity utilization
          if (pool.utilizationRate > 0.9) {
            adjustment *= 1.15;
          } else if (pool.utilizationRate < 0.3) {
            adjustment *= 0.95;
          }

          pool.premiumRate *= adjustment;
          
          // Record premium history
          if (!this.premiumHistory.has(poolName)) {
            this.premiumHistory.set(poolName, []);
          }

          const history = this.premiumHistory.get(poolName);
          history.push({
            timestamp: Date.now(),
            oldRate,
            newRate: pool.premiumRate,
            adjustment,
            claimsRatio,
            utilizationRate: pool.utilizationRate
          });

          // Keep only recent history
          if (history.length > 100) {
            history.shift();
          }

          if (Math.abs(adjustment - 1.0) > 0.05) { // 5% change threshold
            this.emit('premiumAdjusted', {
              poolName,
              oldRate,
              newRate: pool.premiumRate,
              adjustment
            });
          }
        }
      } catch (error) {
        this.emit('error', error);
      }
    }, 24 * 60 * 60 * 1000); // Daily adjustment
  }

  startClaimProcessing() {
    if (this.claimProcessor) return;
    
    this.claimProcessor = setInterval(async () => {
      try {
        // Auto-process expired claims
        for (const [claimId, claim] of this.claims) {
          if (claim.status === ClaimStatus.INVESTIGATING && 
              Date.now() > claim.assessmentDeadline) {
            
            // Auto-reject if no assessments
            if (!claim.assessments || claim.assessments.length === 0) {
              await this.finalizeClaim(claimId, false);
              this.emit('claimAutoRejected', { claimId, reason: 'no_assessments' });
            }
            // Auto-approve if majority approved
            else if (claim.votes.approve > claim.votes.reject) {
              await this.finalizeClaim(claimId, true);
              this.emit('claimAutoApproved', { claimId, reason: 'majority_vote' });
            }
            // Auto-reject otherwise
            else {
              await this.finalizeClaim(claimId, false);
              this.emit('claimAutoRejected', { claimId, reason: 'majority_reject' });
            }
          }
        }

        // Process pending payouts
        const approvedClaims = Array.from(this.claims.values())
          .filter(claim => claim.status === ClaimStatus.APPROVED);

        for (const claim of approvedClaims) {
          await this.processPayout(claim.id);
        }

      } catch (error) {
        this.emit('error', error);
      }
    }, 3600000); // Check every hour
  }

  startParametricMonitoring() {
    if (!this.options.enableParametricPayout) return;
    if (this.parametricMonitor) return;
    
    this.parametricMonitor = setInterval(async () => {
      try {
        // Monitor parametric triggers
        await this.checkAllParametricTriggers();
      } catch (error) {
        this.emit('error', error);
      }
    }, 300000); // Check every 5 minutes
  }

  async checkParametricTriggers(claim) {
    try {
      const result = { triggered: false, triggerType: null, confidence: 0 };

      switch (claim.poolType) {
        case InsuranceType.STABLECOIN_DEPEG:
          const depegCheck = await this.checkStablecoinDepeg(claim);
          if (depegCheck.depegged) {
            result.triggered = true;
            result.triggerType = 'depeg';
            result.confidence = depegCheck.confidence;
          }
          break;

        case InsuranceType.LIQUIDATION:
          const liquidationCheck = await this.checkLiquidationEvent(claim);
          if (liquidationCheck.occurred) {
            result.triggered = true;
            result.triggerType = 'liquidation';
            result.confidence = liquidationCheck.confidence;
          }
          break;

        case InsuranceType.BRIDGE_FAILURE:
          const bridgeCheck = await this.checkBridgeFailure(claim);
          if (bridgeCheck.failed) {
            result.triggered = true;
            result.triggerType = 'bridge_failure';
            result.confidence = bridgeCheck.confidence;
          }
          break;
      }

      return result;
    } catch (error) {
      this.emit('error', error);
      return { triggered: false, triggerType: null, confidence: 0 };
    }
  }

  async processParametricPayout(claimId, parametricResult) {
    try {
      const claim = this.claims.get(claimId);
      if (!claim) return;

      claim.status = ClaimStatus.APPROVED;
      claim.finalDecision = true;
      claim.payoutAmount = claim.netClaimAmount;
      claim.parametricTrigger = parametricResult;
      claim.processedAt = Date.now();

      await this.processPayout(claimId);

      this.emit('parametricPayoutProcessed', {
        claimId,
        triggerType: parametricResult.triggerType,
        confidence: parametricResult.confidence,
        payoutAmount: claim.payoutAmount
      });
    } catch (error) {
      this.emit('error', error);
    }
  }

  async assignClaimAssessors(claimId) {
    try {
      const claim = this.claims.get(claimId);
      if (!claim) return;

      // Select 3-5 assessors based on expertise and reputation
      const availableAssessors = Array.from(this.underwriters.values())
        .filter(u => u.specialties.includes(claim.poolType))
        .sort((a, b) => b.reputation - a.reputation);

      const numAssessors = Math.min(5, Math.max(3, availableAssessors.length));
      const selectedAssessors = availableAssessors
        .slice(0, numAssessors)
        .map(a => a.name);

      claim.assessors = selectedAssessors;
      claim.status = ClaimStatus.INVESTIGATING;

      this.emit('assessorsAssigned', { claimId, assessors: selectedAssessors });
    } catch (error) {
      this.emit('error', error);
    }
  }

  // Helper methods for risk assessment
  async assessProtocolRisk(protocols) {
    const protocolRisks = {
      'Aave': 0.1,
      'Compound': 0.12,
      'Uniswap': 0.15,
      'Curve': 0.08,
      'MakerDAO': 0.09,
      'SushiSwap': 0.18,
      'Balancer': 0.16,
      'Yearn': 0.20
    };

    let avgRisk = 0;
    let count = 0;

    for (const protocol of protocols) {
      if (protocolRisks[protocol]) {
        avgRisk += protocolRisks[protocol];
        count++;
      }
    }

    return count > 0 ? avgRisk / count : 0.15; // Default 15%
  }

  async assessUserRisk(user) {
    // Simulate user risk assessment based on history
    const userPolicies = Array.from(this.coveragePolicies.values())
      .filter(p => p.user === user);

    if (userPolicies.length === 0) return 0.1; // New user - low risk

    const claimsCount = userPolicies.reduce((sum, p) => sum + p.claimHistory.length, 0);
    const claimsRatio = claimsCount / userPolicies.length;

    return Math.min(0.3, claimsRatio * 0.5); // Max 30% user risk
  }

  async assessMarketRisk() {
    // Simulate market risk assessment
    const volatility = Math.random() * 0.5; // 0-50% volatility
    const marketCap = Math.random(); // Market cap indicator
    const liquidityRisk = Math.random() * 0.3; // 0-30% liquidity risk

    return (volatility * 0.4) + ((1 - marketCap) * 0.3) + (liquidityRisk * 0.3);
  }

  categorizeTisk(riskScore) {
    if (riskScore < 0.2) return RiskCategory.VERY_LOW;
    if (riskScore < 0.4) return RiskCategory.LOW;
    if (riskScore < 0.6) return RiskCategory.MEDIUM;
    if (riskScore < 0.8) return RiskCategory.HIGH;
    return RiskCategory.CRITICAL;
  }

  async updateSystemRiskScore() {
    const activePolicies = Array.from(this.coveragePolicies.values())
      .filter(p => p.status === CoverageStatus.ACTIVE);

    if (activePolicies.length === 0) {
      this.metrics.riskScore = 0;
      return;
    }

    const totalCoverage = activePolicies.reduce((sum, p) => sum + p.coverageAmount, 0);
    const weightedRiskScore = activePolicies.reduce((sum, p) => 
      sum + (p.riskScore * p.coverageAmount), 0) / totalCoverage;

    this.metrics.riskScore = weightedRiskScore;
    this.updateSolvencyRatio();
  }

  updateAveragePremium() {
    const activePolicies = Array.from(this.coveragePolicies.values())
      .filter(p => p.status === CoverageStatus.ACTIVE);

    if (activePolicies.length === 0) {
      this.metrics.averagePremium = 0;
      return;
    }

    this.metrics.averagePremium = activePolicies
      .reduce((sum, p) => sum + p.premium, 0) / activePolicies.length;
  }

  updateClaimsRatio() {
    this.metrics.claimsRatio = this.metrics.totalPremiums > 0 ? 
      (this.metrics.totalClaims / this.metrics.totalPremiums) * 100 : 0;
  }

  updateSolvencyRatio() {
    const totalLiabilities = Array.from(this.coveragePolicies.values())
      .filter(p => p.status === CoverageStatus.ACTIVE)
      .reduce((sum, p) => sum + p.coverageAmount, 0);

    this.metrics.solvencyRatio = totalLiabilities > 0 ? 
      (this.metrics.totalPoolValue / totalLiabilities) * 100 : 100;
  }

  // Parametric trigger checking methods
  async checkStablecoinDepeg(claim) {
    // Simulate stablecoin depeg checking
    const currentPrice = 0.98 + (Math.random() * 0.04); // $0.98 - $1.02
    const depegThreshold = 0.95; // 5% depeg threshold
    
    return {
      depegged: currentPrice < depegThreshold,
      currentPrice,
      confidence: currentPrice < depegThreshold ? 0.95 : 0.1
    };
  }

  async checkLiquidationEvent(claim) {
    // Simulate liquidation event checking
    const liquidationOccurred = Math.random() < 0.1; // 10% chance
    
    return {
      occurred: liquidationOccurred,
      confidence: liquidationOccurred ? 0.98 : 0.02
    };
  }

  async checkBridgeFailure(claim) {
    // Simulate bridge failure checking
    const bridgeFailed = Math.random() < 0.05; // 5% chance
    
    return {
      failed: bridgeFailed,
      confidence: bridgeFailed ? 0.99 : 0.01
    };
  }

  async checkAllParametricTriggers() {
    // Check global parametric conditions
    const activePolicies = Array.from(this.coveragePolicies.values())
      .filter(p => p.status === CoverageStatus.ACTIVE);

    for (const policy of activePolicies) {
      const mockClaim = {
        policyId: policy.id,
        poolType: policy.poolType,
        user: policy.user
      };

      const triggerResult = await this.checkParametricTriggers(mockClaim);
      
      if (triggerResult.triggered && triggerResult.confidence > 0.8) {
        // Auto-create and process parametric claim
        const autoClaimId = await this.createAutomaticClaim(policy, triggerResult);
        this.emit('parametricTriggerActivated', {
          policyId: policy.id,
          claimId: autoClaimId,
          triggerType: triggerResult.triggerType
        });
      }
    }
  }

  async createAutomaticClaim(policy, triggerResult) {
    const claimId = this.generateClaimId();
    const claim = {
      id: claimId,
      policyId: policy.id,
      user: policy.user,
      poolName: policy.poolName,
      poolType: policy.poolType,
      claimAmount: policy.coverageAmount,
      netClaimAmount: policy.coverageAmount - policy.deductible,
      incident: `Automatic parametric claim: ${triggerResult.triggerType}`,
      evidence: triggerResult,
      submittedAt: Date.now(),
      status: ClaimStatus.APPROVED, // Auto-approved
      parametricTrigger: triggerResult,
      automatic: true
    };

    this.claims.set(claimId, claim);
    await this.processParametricPayout(claimId, triggerResult);
    
    return claimId;
  }

  // ID generation methods
  generatePoolId() {
    return `pool_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  generatePolicyId() {
    return `policy_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  }

  generateClaimId() {
    return `claim_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  generateAssessmentId() {
    return `assess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  generateUnderwriterId() {
    return `uw_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Public API methods
  async getPolicy(policyId) {
    return this.coveragePolicies.get(policyId) || null;
  }

  async getClaim(claimId) {
    return this.claims.get(claimId) || null;
  }

  async getUserPolicies(user) {
    return Array.from(this.coveragePolicies.values())
      .filter(policy => policy.user === user);
  }

  async getUserClaims(user) {
    return Array.from(this.claims.values())
      .filter(claim => claim.user === user);
  }

  async getInsurancePools() {
    return Array.from(this.insurancePools.values());
  }

  async getPoolByType(insuranceType) {
    return Array.from(this.insurancePools.values())
      .filter(pool => pool.type === insuranceType);
  }

  async getPremiumQuote(poolName, coverageAmount, duration, userOptions = {}) {
    const pool = this.insurancePools.get(poolName);
    if (!pool) {
      throw new Error('Pool not found');
    }

    const riskAssessment = await this.assessRisk('quote_user', pool.type, coverageAmount, userOptions);
    const basePremium = this.calculateBasePremium(coverageAmount, duration, pool.premiumRate);
    const riskAdjustedPremium = this.applyRiskAdjustment(basePremium, riskAssessment);
    const finalPremium = this.applyDynamicPricing(riskAdjustedPremium, pool);

    return {
      poolName,
      coverageAmount,
      duration,
      basePremium,
      riskAdjustedPremium,
      finalPremium,
      premiumRate: finalPremium / coverageAmount,
      riskScore: riskAssessment.score,
      riskCategory: riskAssessment.category,
      validUntil: Date.now() + (15 * 60 * 1000) // 15 minutes
    };
  }

  getMetrics() {
    const activePolicies = Array.from(this.coveragePolicies.values())
      .filter(p => p.status === CoverageStatus.ACTIVE);
    const activeClaims = Array.from(this.claims.values())
      .filter(c => [ClaimStatus.SUBMITTED, ClaimStatus.INVESTIGATING].includes(c.status));
    
    return {
      ...this.metrics,
      activeNolicies: activePolicies.length,
      activeClaims: activeClaims.length,
      totalPools: this.insurancePools.size,
      totalUnderwriters: this.underwriters.size
    };
  }

  async stop() {
    this.isRunning = false;
    
    if (this.riskMonitor) {
      clearInterval(this.riskMonitor);
      this.riskMonitor = null;
    }
    
    if (this.premiumAdjuster) {
      clearInterval(this.premiumAdjuster);
      this.premiumAdjuster = null;
    }
    
    if (this.claimProcessor) {
      clearInterval(this.claimProcessor);
      this.claimProcessor = null;
    }
    
    if (this.parametricMonitor) {
      clearInterval(this.parametricMonitor);
      this.parametricMonitor = null;
    }
    
    this.emit('stopped');
  }
}

export { InsuranceType, CoverageStatus, ClaimStatus, RiskCategory, PolicyType };