import EventEmitter from 'events';
import crypto from 'crypto';

const LendingStrategy = {
  CONSERVATIVE: 'conservative',
  BALANCED: 'balanced',
  AGGRESSIVE: 'aggressive',
  YIELD_MAXIMIZATION: 'yield_maximization',
  RISK_PARITY: 'risk_parity',
  MOMENTUM_BASED: 'momentum_based'
};

const LoanType = {
  FIXED_RATE: 'fixed_rate',
  VARIABLE_RATE: 'variable_rate',
  FLASH_LOAN: 'flash_loan',
  CREDIT_LINE: 'credit_line',
  LEVERAGED: 'leveraged'
};

const CollateralType = {
  SINGLE_ASSET: 'single_asset',
  MULTI_ASSET: 'multi_asset',
  LP_TOKEN: 'lp_token',
  SYNTHETIC: 'synthetic',
  CROSS_CHAIN: 'cross_chain'
};

const PositionStatus = {
  ACTIVE: 'active',
  LIQUIDATING: 'liquidating',
  LIQUIDATED: 'liquidated',
  CLOSED: 'closed',
  DEFAULTED: 'defaulted'
};

const RiskTier = {
  AAA: 'AAA',
  AA: 'AA',
  A: 'A',
  BBB: 'BBB',
  BB: 'BB',
  B: 'B',
  CCC: 'CCC'
};

export class LendingBorrowingOptimizationSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableRateOptimization: options.enableRateOptimization !== false,
      enableRiskAssessment: options.enableRiskAssessment !== false,
      enableLiquidationProtection: options.enableLiquidationProtection !== false,
      enableYieldFarming: options.enableYieldFarming !== false,
      enableCrossProtocolOptimization: options.enableCrossProtocolOptimization !== false,
      maxLTV: options.maxLTV || 0.85, // 85%
      liquidationThreshold: options.liquidationThreshold || 0.90, // 90%
      healthFactorThreshold: options.healthFactorThreshold || 1.5,
      rebalanceThreshold: options.rebalanceThreshold || 0.05, // 5%
      maxSlippage: options.maxSlippage || 0.02, // 2%
      minYieldImprovement: options.minYieldImprovement || 0.005, // 0.5%
      riskAdjustmentFactor: options.riskAdjustmentFactor || 0.1,
      protocolFee: options.protocolFee || 0.001 // 0.1%
    };

    this.protocols = new Map();
    this.lendingPools = new Map();
    this.borrowPositions = new Map();
    this.lendingPositions = new Map();
    this.rateHistory = new Map();
    this.yieldOpportunities = new Map();
    this.liquidationQueue = new Map();
    this.riskScores = new Map();
    
    this.isRunning = false;
    this.metrics = {
      totalLent: 0,
      totalBorrowed: 0,
      totalInterestEarned: 0,
      totalInterestPaid: 0,
      averageAPY: 0,
      totalLiquidations: 0,
      protocolRevenue: 0,
      utilizationRate: 0,
      avgHealthFactor: 0
    };

    this.initializeLendingProtocols();
    this.startRateMonitoring();
    this.startYieldOptimization();
    this.startRiskMonitoring();
    this.startLiquidationEngine();
  }

  initializeLendingProtocols() {
    const protocols = [
      {
        name: 'Aave',
        type: 'variable_rate',
        baseRate: 0.02,
        utilizationOptimal: 0.80,
        slopeRate1: 0.04,
        slopeRate2: 0.60,
        reserveFactor: 0.25,
        liquidationBonus: 0.05,
        maxLTV: 0.825,
        liquidationThreshold: 0.86,
        supportedAssets: ['USDC', 'USDT', 'DAI', 'WETH', 'WBTC', 'LINK'],
        tvl: 15000000000,
        reliability: 0.98
      },
      {
        name: 'Compound',
        type: 'variable_rate',
        baseRate: 0.025,
        utilizationOptimal: 0.90,
        slopeRate1: 0.035,
        slopeRate2: 0.45,
        reserveFactor: 0.30,
        liquidationBonus: 0.08,
        maxLTV: 0.80,
        liquidationThreshold: 0.83,
        supportedAssets: ['USDC', 'USDT', 'DAI', 'WETH', 'WBTC'],
        tvl: 12000000000,
        reliability: 0.97
      },
      {
        name: 'MakerDAO',
        type: 'fixed_rate',
        baseRate: 0.015,
        stabilityFee: 0.035,
        liquidationPenalty: 0.13,
        maxLTV: 0.75,
        liquidationThreshold: 0.78,
        supportedAssets: ['WETH', 'WBTC', 'LINK', 'YFI'],
        tvl: 8000000000,
        reliability: 0.99
      },
      {
        name: 'Venus',
        type: 'variable_rate',
        baseRate: 0.03,
        utilizationOptimal: 0.75,
        slopeRate1: 0.05,
        slopeRate2: 0.50,
        reserveFactor: 0.20,
        liquidationBonus: 0.05,
        maxLTV: 0.80,
        liquidationThreshold: 0.85,
        supportedAssets: ['USDC', 'USDT', 'WETH', 'WBTC', 'BNB'],
        tvl: 3000000000,
        reliability: 0.95
      }
    ];

    protocols.forEach(protocol => {
      this.protocols.set(protocol.name, {
        ...protocol,
        currentUtilization: Math.random() * 0.9,
        totalSupply: protocol.tvl * (0.8 + Math.random() * 0.4),
        totalBorrow: protocol.tvl * (0.6 + Math.random() * 0.3),
        reserveSize: protocol.tvl * 0.1
      });
    });
  }

  async createLendingPosition(user, protocol, asset, amount, strategy = LendingStrategy.BALANCED, options = {}) {
    try {
      const protocolData = this.protocols.get(protocol);
      if (!protocolData) {
        throw new Error('Protocol not found');
      }

      if (!protocolData.supportedAssets.includes(asset)) {
        throw new Error(`Asset ${asset} not supported by ${protocol}`);
      }

      const positionId = this.generatePositionId();
      const currentRate = await this.calculateLendingRate(protocol, asset);
      const riskScore = await this.assessAssetRisk(asset);
      const expectedYield = currentRate * (1 - protocolData.reserveFactor);

      const position = {
        id: positionId,
        user,
        protocol,
        asset,
        amount,
        strategy,
        depositedAt: Date.now(),
        currentRate,
        expectedYield,
        accruedInterest: 0,
        lastUpdateTime: Date.now(),
        status: PositionStatus.ACTIVE,
        riskScore,
        autoCompound: options.autoCompound || false,
        rebalanceEnabled: options.rebalanceEnabled || true
      };

      this.lendingPositions.set(positionId, position);

      // Update protocol metrics
      protocolData.totalSupply += amount;
      protocolData.currentUtilization = protocolData.totalBorrow / protocolData.totalSupply;

      this.metrics.totalLent += amount;

      this.emit('lendingPositionCreated', position);
      return positionId;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async createBorrowPosition(user, protocol, collateralAsset, collateralAmount, borrowAsset, borrowAmount, options = {}) {
    try {
      const protocolData = this.protocols.get(protocol);
      if (!protocolData) {
        throw new Error('Protocol not found');
      }

      if (!protocolData.supportedAssets.includes(collateralAsset) || 
          !protocolData.supportedAssets.includes(borrowAsset)) {
        throw new Error('Asset not supported by protocol');
      }

      // Calculate collateral value and LTV
      const collateralPrice = await this.getAssetPrice(collateralAsset);
      const borrowPrice = await this.getAssetPrice(borrowAsset);
      const collateralValue = collateralAmount * collateralPrice;
      const borrowValue = borrowAmount * borrowPrice;
      const ltv = borrowValue / collateralValue;

      if (ltv > protocolData.maxLTV) {
        throw new Error(`LTV ${(ltv * 100).toFixed(2)}% exceeds maximum ${(protocolData.maxLTV * 100).toFixed(2)}%`);
      }

      const positionId = this.generatePositionId();
      const borrowRate = await this.calculateBorrowRate(protocol, borrowAsset);
      const healthFactor = this.calculateHealthFactor(collateralValue, borrowValue, protocolData.liquidationThreshold);
      const liquidationPrice = this.calculateLiquidationPrice(
        collateralAmount, borrowAmount, protocolData.liquidationThreshold, collateralPrice, borrowPrice
      );

      const position = {
        id: positionId,
        user,
        protocol,
        collateralAsset,
        collateralAmount,
        borrowAsset,
        borrowAmount,
        collateralValue,
        borrowValue,
        ltv,
        borrowRate,
        healthFactor,
        liquidationPrice,
        accruedDebt: 0,
        openedAt: Date.now(),
        lastUpdateTime: Date.now(),
        status: PositionStatus.ACTIVE,
        loanType: options.loanType || LoanType.VARIABLE_RATE,
        autoLiquidationProtection: options.autoLiquidationProtection || false
      };

      this.borrowPositions.set(positionId, position);

      // Update protocol metrics
      protocolData.totalBorrow += borrowValue;
      protocolData.currentUtilization = protocolData.totalBorrow / protocolData.totalSupply;

      this.metrics.totalBorrowed += borrowValue;

      this.emit('borrowPositionCreated', position);
      return positionId;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async optimizeYieldAcrossProtocols(user, asset, amount, maxProtocols = 3) {
    try {
      const opportunities = [];

      // Get current rates from all protocols
      for (const [protocolName, protocolData] of this.protocols) {
        if (protocolData.supportedAssets.includes(asset)) {
          const rate = await this.calculateLendingRate(protocolName, asset);
          const riskScore = await this.assessProtocolRisk(protocolName);
          const capacity = await this.getProtocolCapacity(protocolName, asset);

          opportunities.push({
            protocol: protocolName,
            asset,
            rate,
            riskScore,
            capacity,
            riskAdjustedRate: rate * (1 - riskScore * this.options.riskAdjustmentFactor),
            maxAllocation: Math.min(amount, capacity)
          });
        }
      }

      // Sort by risk-adjusted rate
      opportunities.sort((a, b) => b.riskAdjustedRate - a.riskAdjustedRate);

      // Optimize allocation
      const allocation = this.optimizeAllocation(opportunities, amount, maxProtocols);
      
      // Execute allocations
      const positionIds = [];
      for (const alloc of allocation) {
        if (alloc.amount > 0) {
          const positionId = await this.createLendingPosition(
            user, 
            alloc.protocol, 
            asset, 
            alloc.amount,
            LendingStrategy.YIELD_MAXIMIZATION
          );
          positionIds.push(positionId);
        }
      }

      this.emit('yieldOptimizationCompleted', {
        user,
        asset,
        amount,
        allocation,
        positionIds,
        expectedYield: allocation.reduce((sum, alloc) => sum + (alloc.rate * alloc.amount), 0) / amount
      });

      return positionIds;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  optimizeAllocation(opportunities, totalAmount, maxProtocols) {
    const allocation = [];
    let remainingAmount = totalAmount;
    let usedProtocols = 0;

    // Risk parity approach with yield optimization
    for (const opp of opportunities) {
      if (usedProtocols >= maxProtocols || remainingAmount <= 0) break;

      // Calculate optimal allocation based on risk-adjusted return
      const riskWeight = 1 / (opp.riskScore + 0.01); // Avoid division by zero
      const maxAllowableAmount = Math.min(
        opp.maxAllocation,
        remainingAmount * 0.6, // Max 60% in single protocol
        totalAmount * riskWeight / 10 // Risk-based allocation
      );

      const allocatedAmount = Math.min(maxAllowableAmount, remainingAmount);

      if (allocatedAmount > totalAmount * 0.01) { // Minimum 1% allocation
        allocation.push({
          protocol: opp.protocol,
          asset: opp.asset,
          amount: allocatedAmount,
          rate: opp.rate,
          riskScore: opp.riskScore,
          riskAdjustedRate: opp.riskAdjustedRate
        });

        remainingAmount -= allocatedAmount;
        usedProtocols++;
      }
    }

    // Allocate remaining amount to best opportunity
    if (remainingAmount > 0 && allocation.length > 0) {
      allocation[0].amount += remainingAmount;
    }

    return allocation;
  }

  async rebalanceLendingPositions(user, options = {}) {
    try {
      const userPositions = Array.from(this.lendingPositions.values())
        .filter(pos => pos.user === user && pos.status === PositionStatus.ACTIVE);

      if (userPositions.length === 0) return [];

      const rebalanceActions = [];

      for (const position of userPositions) {
        const currentRate = await this.calculateLendingRate(position.protocol, position.asset);
        const rateDifference = Math.abs(currentRate - position.currentRate) / position.currentRate;

        if (rateDifference > this.options.rebalanceThreshold) {
          // Find better opportunities
          const betterOpportunities = await this.findBetterYieldOpportunities(
            position.asset, 
            position.amount,
            currentRate
          );

          for (const opportunity of betterOpportunities) {
            const yieldImprovement = opportunity.rate - currentRate;
            const rebalanceCost = this.calculateRebalanceCost(position.amount);

            if (yieldImprovement > rebalanceCost + this.options.minYieldImprovement) {
              rebalanceActions.push({
                type: 'move',
                fromPosition: position.id,
                toProtocol: opportunity.protocol,
                amount: position.amount,
                expectedImprovement: yieldImprovement,
                estimatedCost: rebalanceCost
              });
              break;
            }
          }
        }
      }

      // Execute rebalance actions
      const results = [];
      for (const action of rebalanceActions) {
        try {
          const result = await this.executeRebalance(action);
          results.push(result);
        } catch (error) {
          this.emit('error', error);
          results.push({ success: false, action, error: error.message });
        }
      }

      this.emit('rebalanceCompleted', { user, actions: rebalanceActions, results });
      return results;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async executeRebalance(action) {
    try {
      const position = this.lendingPositions.get(action.fromPosition);
      if (!position) {
        throw new Error('Source position not found');
      }

      // Withdraw from current protocol
      await this.withdrawLendingPosition(action.fromPosition, action.amount);

      // Deposit to new protocol
      const newPositionId = await this.createLendingPosition(
        position.user,
        action.toProtocol,
        position.asset,
        action.amount,
        position.strategy
      );

      return {
        success: true,
        action,
        oldPositionId: action.fromPosition,
        newPositionId,
        actualCost: action.estimatedCost
      };
    } catch (error) {
      throw error;
    }
  }

  async liquidatePosition(positionId, liquidator = null, options = {}) {
    try {
      const position = this.borrowPositions.get(positionId);
      if (!position || position.status !== PositionStatus.ACTIVE) {
        throw new Error('Position not found or not active');
      }

      // Update position with current prices
      await this.updatePositionHealthFactor(positionId);

      if (position.healthFactor > 1.0) {
        throw new Error('Position is healthy and cannot be liquidated');
      }

      position.status = PositionStatus.LIQUIDATING;
      const liquidationStartTime = Date.now();

      const protocolData = this.protocols.get(position.protocol);
      const collateralPrice = await this.getAssetPrice(position.collateralAsset);
      const borrowPrice = await this.getAssetPrice(position.borrowAsset);

      // Calculate liquidation amounts
      const maxLiquidationAmount = Math.min(
        position.borrowAmount * 0.5, // Max 50% liquidation
        position.collateralValue * protocolData.maxLTV / borrowPrice
      );

      const liquidationAmount = options.amount || maxLiquidationAmount;
      const collateralToSeize = liquidationAmount * borrowPrice / collateralPrice * 
                                (1 + protocolData.liquidationBonus);

      // Execute liquidation
      const liquidation = {
        positionId,
        liquidator: liquidator || 'system',
        liquidationAmount,
        collateralSeized: collateralToSeize,
        liquidationBonus: collateralToSeize * protocolData.liquidationBonus,
        timestamp: liquidationStartTime,
        gasUsed: 200000 + Math.random() * 100000
      };

      // Update position
      position.borrowAmount -= liquidationAmount;
      position.collateralAmount -= collateralToSeize;
      position.borrowValue = position.borrowAmount * borrowPrice;
      position.collateralValue = position.collateralAmount * collateralPrice;
      position.ltv = position.borrowValue / position.collateralValue;
      position.healthFactor = this.calculateHealthFactor(
        position.collateralValue, 
        position.borrowValue, 
        protocolData.liquidationThreshold
      );

      if (position.borrowAmount <= 0.01) { // Dust threshold
        position.status = PositionStatus.LIQUIDATED;
      } else {
        position.status = PositionStatus.ACTIVE;
      }

      // Update metrics
      this.metrics.totalLiquidations++;
      this.metrics.protocolRevenue += liquidation.liquidationBonus * this.options.protocolFee;

      this.emit('positionLiquidated', liquidation);
      return liquidation;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async calculateLendingRate(protocol, asset) {
    try {
      const protocolData = this.protocols.get(protocol);
      if (!protocolData) return 0;

      const utilization = protocolData.currentUtilization;
      let rate = 0;

      if (protocolData.type === 'variable_rate') {
        if (utilization <= protocolData.utilizationOptimal) {
          rate = protocolData.baseRate + 
                (utilization / protocolData.utilizationOptimal) * protocolData.slopeRate1;
        } else {
          rate = protocolData.baseRate + protocolData.slopeRate1 + 
                ((utilization - protocolData.utilizationOptimal) / (1 - protocolData.utilizationOptimal)) * 
                protocolData.slopeRate2;
        }
      } else if (protocolData.type === 'fixed_rate') {
        rate = protocolData.stabilityFee || protocolData.baseRate;
      }

      // Apply asset-specific multipliers
      const assetMultiplier = this.getAssetRateMultiplier(asset);
      return rate * assetMultiplier * (1 - protocolData.reserveFactor);
    } catch (error) {
      this.emit('error', error);
      return 0;
    }
  }

  async calculateBorrowRate(protocol, asset) {
    try {
      const protocolData = this.protocols.get(protocol);
      if (!protocolData) return 0;

      const utilization = protocolData.currentUtilization;
      let rate = 0;

      if (protocolData.type === 'variable_rate') {
        if (utilization <= protocolData.utilizationOptimal) {
          rate = protocolData.baseRate + 
                (utilization / protocolData.utilizationOptimal) * protocolData.slopeRate1;
        } else {
          rate = protocolData.baseRate + protocolData.slopeRate1 + 
                ((utilization - protocolData.utilizationOptimal) / (1 - protocolData.utilizationOptimal)) * 
                protocolData.slopeRate2;
        }
      } else if (protocolData.type === 'fixed_rate') {
        rate = protocolData.stabilityFee || protocolData.baseRate;
      }

      // Apply asset-specific multipliers and risk premium
      const assetMultiplier = this.getAssetRateMultiplier(asset);
      const riskPremium = await this.calculateRiskPremium(asset);
      
      return rate * assetMultiplier + riskPremium;
    } catch (error) {
      this.emit('error', error);
      return 0;
    }
  }

  calculateHealthFactor(collateralValue, borrowValue, liquidationThreshold) {
    if (borrowValue === 0) return Number.MAX_SAFE_INTEGER;
    return (collateralValue * liquidationThreshold) / borrowValue;
  }

  calculateLiquidationPrice(collateralAmount, borrowAmount, liquidationThreshold, collateralPrice, borrowPrice) {
    // Price at which position gets liquidated
    return (borrowAmount * borrowPrice) / (collateralAmount * liquidationThreshold);
  }

  async updatePositionHealthFactor(positionId) {
    try {
      const position = this.borrowPositions.get(positionId);
      if (!position) return;

      const collateralPrice = await this.getAssetPrice(position.collateralAsset);
      const borrowPrice = await this.getAssetPrice(position.borrowAsset);
      const protocolData = this.protocols.get(position.protocol);

      position.collateralValue = position.collateralAmount * collateralPrice;
      position.borrowValue = position.borrowAmount * borrowPrice;
      position.ltv = position.borrowValue / position.collateralValue;
      position.healthFactor = this.calculateHealthFactor(
        position.collateralValue,
        position.borrowValue,
        protocolData.liquidationThreshold
      );
      position.liquidationPrice = this.calculateLiquidationPrice(
        position.collateralAmount,
        position.borrowAmount,
        protocolData.liquidationThreshold,
        collateralPrice,
        borrowPrice
      );
      position.lastUpdateTime = Date.now();
    } catch (error) {
      this.emit('error', error);
    }
  }

  startRateMonitoring() {
    if (this.rateMonitor) return;
    
    this.rateMonitor = setInterval(async () => {
      try {
        // Update protocol utilization rates
        for (const [protocolName, protocolData] of this.protocols) {
          const utilizationChange = (Math.random() - 0.5) * 0.02; // ±1% change
          protocolData.currentUtilization = Math.max(0, 
            Math.min(0.98, protocolData.currentUtilization + utilizationChange));

          // Record rate history
          for (const asset of protocolData.supportedAssets) {
            const lendingRate = await this.calculateLendingRate(protocolName, asset);
            const borrowRate = await this.calculateBorrowRate(protocolName, asset);

            const key = `${protocolName}-${asset}`;
            if (!this.rateHistory.has(key)) {
              this.rateHistory.set(key, []);
            }

            const history = this.rateHistory.get(key);
            history.push({
              timestamp: Date.now(),
              lendingRate,
              borrowRate,
              utilization: protocolData.currentUtilization
            });

            // Keep only recent history
            if (history.length > 1000) {
              history.shift();
            }
          }
        }

        // Update position interest accrual
        await this.updateInterestAccrual();
      } catch (error) {
        this.emit('error', error);
      }
    }, 60000); // Update every minute
  }

  startYieldOptimization() {
    if (this.yieldOptimizer) return;
    
    this.yieldOptimizer = setInterval(async () => {
      try {
        // Auto-rebalance positions with rebalance enabled
        const autoRebalancePositions = Array.from(this.lendingPositions.values())
          .filter(pos => pos.rebalanceEnabled && pos.status === PositionStatus.ACTIVE);

        for (const position of autoRebalancePositions) {
          const timeSinceLastUpdate = Date.now() - position.lastUpdateTime;
          if (timeSinceLastUpdate > 24 * 60 * 60 * 1000) { // Check daily
            await this.rebalanceLendingPositions(position.user);
          }
        }
      } catch (error) {
        this.emit('error', error);
      }
    }, 3600000); // Check every hour
  }

  startRiskMonitoring() {
    if (this.riskMonitor) return;
    
    this.riskMonitor = setInterval(async () => {
      try {
        // Update all borrow position health factors
        for (const positionId of this.borrowPositions.keys()) {
          await this.updatePositionHealthFactor(positionId);
        }

        // Check for positions at risk
        const riskPositions = Array.from(this.borrowPositions.values())
          .filter(pos => pos.status === PositionStatus.ACTIVE && pos.healthFactor < this.options.healthFactorThreshold);

        for (const position of riskPositions) {
          this.emit('positionAtRisk', position);

          // Auto-liquidation protection
          if (position.autoLiquidationProtection && position.healthFactor < 1.1) {
            await this.executeLiquidationProtection(position.id);
          }
        }

        // Update average health factor metric
        const activePositions = Array.from(this.borrowPositions.values())
          .filter(pos => pos.status === PositionStatus.ACTIVE);
        
        if (activePositions.length > 0) {
          this.metrics.avgHealthFactor = activePositions
            .reduce((sum, pos) => sum + pos.healthFactor, 0) / activePositions.length;
        }
      } catch (error) {
        this.emit('error', error);
      }
    }, 30000); // Check every 30 seconds
  }

  startLiquidationEngine() {
    if (this.liquidationEngine) return;
    
    this.liquidationEngine = setInterval(async () => {
      try {
        // Check for liquidatable positions
        const liquidatablePositions = Array.from(this.borrowPositions.values())
          .filter(pos => pos.status === PositionStatus.ACTIVE && pos.healthFactor < 1.0);

        for (const position of liquidatablePositions) {
          try {
            await this.liquidatePosition(position.id, 'system');
          } catch (error) {
            this.emit('error', error);
          }
        }
      } catch (error) {
        this.emit('error', error);
      }
    }, 15000); // Check every 15 seconds
  }

  async updateInterestAccrual() {
    try {
      const currentTime = Date.now();

      // Update lending positions
      for (const position of this.lendingPositions.values()) {
        if (position.status === PositionStatus.ACTIVE) {
          const timeElapsed = (currentTime - position.lastUpdateTime) / (1000 * 60 * 60 * 24 * 365); // Years
          const newRate = await this.calculateLendingRate(position.protocol, position.asset);
          const interestEarned = position.amount * newRate * timeElapsed;

          position.accruedInterest += interestEarned;
          position.currentRate = newRate;
          position.lastUpdateTime = currentTime;

          if (position.autoCompound) {
            position.amount += interestEarned;
            position.accruedInterest = 0;
          }

          this.metrics.totalInterestEarned += interestEarned;
        }
      }

      // Update borrow positions
      for (const position of this.borrowPositions.values()) {
        if (position.status === PositionStatus.ACTIVE) {
          const timeElapsed = (currentTime - position.lastUpdateTime) / (1000 * 60 * 60 * 24 * 365); // Years
          const newRate = await this.calculateBorrowRate(position.protocol, position.borrowAsset);
          const interestAccrued = position.borrowAmount * newRate * timeElapsed;

          position.accruedDebt += interestAccrued;
          position.borrowRate = newRate;
          position.borrowAmount += interestAccrued;
          position.lastUpdateTime = currentTime;

          this.metrics.totalInterestPaid += interestAccrued;
        }
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  async executeLiquidationProtection(positionId) {
    try {
      const position = this.borrowPositions.get(positionId);
      if (!position) return;

      // Repay part of the debt to improve health factor
      const repayAmount = position.borrowAmount * 0.1; // Repay 10%
      const protocolData = this.protocols.get(position.protocol);

      position.borrowAmount -= repayAmount;
      position.borrowValue = position.borrowAmount * await this.getAssetPrice(position.borrowAsset);
      position.healthFactor = this.calculateHealthFactor(
        position.collateralValue,
        position.borrowValue,
        protocolData.liquidationThreshold
      );

      this.emit('liquidationProtectionExecuted', {
        positionId,
        repayAmount,
        newHealthFactor: position.healthFactor
      });
    } catch (error) {
      this.emit('error', error);
    }
  }

  // Helper methods for calculations
  getAssetRateMultiplier(asset) {
    const multipliers = {
      'USDC': 1.0,
      'USDT': 1.0,
      'DAI': 1.0,
      'WETH': 1.1,
      'WBTC': 1.15,
      'LINK': 1.2
    };
    return multipliers[asset] || 1.0;
  }

  async calculateRiskPremium(asset) {
    const riskPremiums = {
      'USDC': 0.002,
      'USDT': 0.003,
      'DAI': 0.002,
      'WETH': 0.005,
      'WBTC': 0.006,
      'LINK': 0.008
    };
    return riskPremiums[asset] || 0.005;
  }

  async getAssetPrice(asset) {
    const prices = {
      'USDC': 1.0,
      'USDT': 1.0,
      'DAI': 1.0,
      'WETH': 2500 + (Math.random() - 0.5) * 100,
      'WBTC': 45000 + (Math.random() - 0.5) * 2000,
      'LINK': 15 + (Math.random() - 0.5) * 2
    };
    return prices[asset] || 1.0;
  }

  async assessAssetRisk(asset) {
    const riskScores = {
      'USDC': 0.1,
      'USDT': 0.15,
      'DAI': 0.12,
      'WETH': 0.3,
      'WBTC': 0.35,
      'LINK': 0.5
    };
    return riskScores[asset] || 0.4;
  }

  async assessProtocolRisk(protocol) {
    const protocolData = this.protocols.get(protocol);
    if (!protocolData) return 0.5;

    // Base risk from reliability
    let riskScore = 1 - protocolData.reliability;
    
    // Add utilization risk
    if (protocolData.currentUtilization > 0.9) {
      riskScore += 0.1;
    }
    
    // Add TVL risk (smaller protocols are riskier)
    if (protocolData.tvl < 5000000000) {
      riskScore += 0.05;
    }

    return Math.min(0.8, riskScore);
  }

  async getProtocolCapacity(protocol, asset) {
    const protocolData = this.protocols.get(protocol);
    if (!protocolData) return 0;

    const availableCapacity = protocolData.totalSupply * (1 - protocolData.currentUtilization);
    return availableCapacity * 0.8; // 80% of available capacity
  }

  async findBetterYieldOpportunities(asset, amount, currentRate) {
    const opportunities = [];

    for (const [protocolName, protocolData] of this.protocols) {
      if (protocolData.supportedAssets.includes(asset)) {
        const rate = await this.calculateLendingRate(protocolName, asset);
        if (rate > currentRate) {
          opportunities.push({
            protocol: protocolName,
            asset,
            rate,
            improvement: rate - currentRate
          });
        }
      }
    }

    return opportunities.sort((a, b) => b.improvement - a.improvement);
  }

  calculateRebalanceCost(amount) {
    return amount * 0.001; // 0.1% rebalance cost
  }

  async withdrawLendingPosition(positionId, amount) {
    // Simulate withdrawal
    const position = this.lendingPositions.get(positionId);
    if (position) {
      position.amount -= amount;
      if (position.amount <= 0) {
        position.status = PositionStatus.CLOSED;
      }
    }
  }

  generatePositionId() {
    return `pos_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  // Public API methods
  async getLendingPosition(positionId) {
    return this.lendingPositions.get(positionId) || null;
  }

  async getBorrowPosition(positionId) {
    return this.borrowPositions.get(positionId) || null;
  }

  async getUserPositions(user) {
    const lendingPositions = Array.from(this.lendingPositions.values())
      .filter(pos => pos.user === user);
    const borrowPositions = Array.from(this.borrowPositions.values())
      .filter(pos => pos.user === user);
    
    return { lending: lendingPositions, borrowing: borrowPositions };
  }

  async getProtocolRates(protocol) {
    const protocolData = this.protocols.get(protocol);
    if (!protocolData) return null;

    const rates = {};
    for (const asset of protocolData.supportedAssets) {
      rates[asset] = {
        lending: await this.calculateLendingRate(protocol, asset),
        borrowing: await this.calculateBorrowRate(protocol, asset)
      };
    }

    return rates;
  }

  async getAllProtocolRates() {
    const allRates = {};
    for (const protocolName of this.protocols.keys()) {
      allRates[protocolName] = await this.getProtocolRates(protocolName);
    }
    return allRates;
  }

  getMetrics() {
    const activeLendingPositions = Array.from(this.lendingPositions.values())
      .filter(pos => pos.status === PositionStatus.ACTIVE);
    const activeBorrowPositions = Array.from(this.borrowPositions.values())
      .filter(pos => pos.status === PositionStatus.ACTIVE);

    const totalActiveSupply = activeLendingPositions.reduce((sum, pos) => sum + pos.amount, 0);
    const totalActiveBorrow = activeBorrowPositions.reduce((sum, pos) => sum + pos.borrowValue, 0);

    return {
      ...this.metrics,
      totalActiveSupply,
      totalActiveBorrow,
      utilizationRate: totalActiveSupply > 0 ? (totalActiveBorrow / totalActiveSupply) * 100 : 0,
      activeLendingPositions: activeLendingPositions.length,
      activeBorrowPositions: activeBorrowPositions.length,
      protocolCount: this.protocols.size
    };
  }

  async stop() {
    this.isRunning = false;
    
    if (this.rateMonitor) {
      clearInterval(this.rateMonitor);
      this.rateMonitor = null;
    }
    
    if (this.yieldOptimizer) {
      clearInterval(this.yieldOptimizer);
      this.yieldOptimizer = null;
    }
    
    if (this.riskMonitor) {
      clearInterval(this.riskMonitor);
      this.riskMonitor = null;
    }
    
    if (this.liquidationEngine) {
      clearInterval(this.liquidationEngine);
      this.liquidationEngine = null;
    }
    
    this.emit('stopped');
  }
}

export { LendingStrategy, LoanType, CollateralType, PositionStatus, RiskTier };