/**
 * Automated Liquidity Manager - Otedama
 * Intelligent management of pool liquidity reserves
 * Features: dynamic rebalancing, impermanent loss protection, multi-protocol support
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('LiquidityManager');

/**
 * Liquidity strategies
 */
export const LiquidityStrategy = {
  CONSERVATIVE: 'conservative',  // Low risk, stable pairs
  BALANCED: 'balanced',          // Medium risk, balanced approach
  AGGRESSIVE: 'aggressive',      // High risk, maximum yield
  ADAPTIVE: 'adaptive'          // Dynamic based on market conditions
};

/**
 * Protocol types
 */
export const ProtocolType = {
  UNISWAP_V2: 'uniswap-v2',
  UNISWAP_V3: 'uniswap-v3',
  CURVE: 'curve',
  BALANCER: 'balancer',
  SUSHISWAP: 'sushiswap'
};

/**
 * Automated liquidity manager
 */
export class AutomatedLiquidityManager extends EventEmitter {
  constructor(pool, options = {}) {
    super();
    
    this.pool = pool;
    this.config = {
      strategy: options.strategy || LiquidityStrategy.BALANCED,
      targetUtilization: options.targetUtilization || 0.8, // 80%
      rebalanceThreshold: options.rebalanceThreshold || 0.05, // 5%
      impermanentLossLimit: options.impermanentLossLimit || 0.1, // 10%
      minLiquidity: options.minLiquidity || 10000, // $10k minimum
      maxLiquidity: options.maxLiquidity || 1000000, // $1M maximum
      rebalanceInterval: options.rebalanceInterval || 3600000, // 1 hour
      ...options
    };
    
    this.positions = new Map();
    this.protocols = new Map();
    this.reserves = {
      available: {},
      deployed: {},
      pending: {}
    };
    this.priceHistory = new Map();
    
    this.stats = {
      totalLiquidityUSD: 0,
      totalFeesEarned: 0,
      impermanentLoss: 0,
      rebalances: 0,
      averageAPR: 0,
      utilizationRate: 0
    };
  }
  
  /**
   * Initialize liquidity manager
   */
  async initialize() {
    logger.info('Initializing automated liquidity manager...');
    
    // Initialize protocols
    await this.initializeProtocols();
    
    // Load existing positions
    await this.loadExistingPositions();
    
    // Start management cycles
    this.startLiquidityMonitoring();
    this.startRebalancingCycle();
    this.startImpermanentLossProtection();
    
    logger.info('Liquidity manager initialized');
    this.emit('initialized');
  }
  
  /**
   * Initialize supported protocols
   */
  async initializeProtocols() {
    // Uniswap V3
    this.protocols.set(ProtocolType.UNISWAP_V3, {
      name: 'Uniswap V3',
      type: ProtocolType.UNISWAP_V3,
      features: {
        concentratedLiquidity: true,
        customFees: true,
        rangeOrders: true
      },
      feeTiers: [0.0005, 0.003, 0.01], // 0.05%, 0.3%, 1%
      gasEstimate: 300000
    });
    
    // Curve
    this.protocols.set(ProtocolType.CURVE, {
      name: 'Curve',
      type: ProtocolType.CURVE,
      features: {
        stablePools: true,
        metaPools: true,
        boostedRewards: true
      },
      feeTiers: [0.0004], // 0.04%
      gasEstimate: 400000
    });
    
    // Balancer
    this.protocols.set(ProtocolType.BALANCER, {
      name: 'Balancer',
      type: ProtocolType.BALANCER,
      features: {
        weightedPools: true,
        stablePools: true,
        managedPools: true
      },
      feeTiers: [0.001, 0.003, 0.01],
      gasEstimate: 350000
    });
  }
  
  /**
   * Deploy liquidity
   */
  async deployLiquidity(params) {
    const {
      tokenA,
      tokenB,
      amountA,
      amountB,
      protocol = ProtocolType.UNISWAP_V3,
      strategy = this.config.strategy
    } = params;
    
    logger.info(`Deploying liquidity: ${amountA} ${tokenA} + ${amountB} ${tokenB}`);
    
    try {
      // Select optimal pool
      const pool = await this.selectOptimalPool(
        tokenA,
        tokenB,
        protocol,
        strategy
      );
      
      // Calculate optimal range (for concentrated liquidity)
      const range = await this.calculateOptimalRange(
        pool,
        tokenA,
        tokenB,
        strategy
      );
      
      // Check impermanent loss risk
      const ilRisk = await this.assessImpermanentLossRisk(
        tokenA,
        tokenB,
        range
      );
      
      if (ilRisk > this.config.impermanentLossLimit) {
        throw new Error('Impermanent loss risk too high');
      }
      
      // Create position
      const position = {
        id: this.generatePositionId(),
        protocol,
        pool: pool.address,
        tokenA,
        tokenB,
        amountA,
        amountB,
        range,
        strategy,
        createdAt: Date.now(),
        lastRebalance: Date.now(),
        fees: {
          earned: 0,
          unclaimed: 0
        },
        performance: {
          initialValue: amountA + amountB, // Simplified
          currentValue: amountA + amountB,
          impermanentLoss: 0,
          apr: 0
        }
      };
      
      // Deploy to protocol
      const result = await this.deployToProtocol(position);
      position.nftId = result.nftId;
      position.liquidity = result.liquidity;
      
      // Update reserves
      this.updateReserves(tokenA, -amountA);
      this.updateReserves(tokenB, -amountB);
      
      // Store position
      this.positions.set(position.id, position);
      
      // Update stats
      this.stats.totalLiquidityUSD += position.performance.initialValue;
      this.updateUtilizationRate();
      
      logger.info(`Liquidity deployed: ${position.id}`);
      this.emit('liquidity:deployed', position);
      
      return position;
      
    } catch (error) {
      logger.error('Failed to deploy liquidity:', error);
      throw error;
    }
  }
  
  /**
   * Select optimal pool
   */
  async selectOptimalPool(tokenA, tokenB, protocol, strategy) {
    const protocolConfig = this.protocols.get(protocol);
    if (!protocolConfig) {
      throw new Error('Unsupported protocol');
    }
    
    // Get available pools
    const pools = await this.getAvailablePools(tokenA, tokenB, protocol);
    
    // Score pools based on strategy
    const scoredPools = pools.map(pool => ({
      ...pool,
      score: this.scorePool(pool, strategy)
    }));
    
    // Sort by score
    scoredPools.sort((a, b) => b.score - a.score);
    
    return scoredPools[0];
  }
  
  /**
   * Score pool based on strategy
   */
  scorePool(pool, strategy) {
    let score = 100;
    
    // TVL factor
    const tvlScore = Math.min(pool.tvl / 1000000, 100); // Cap at $100M
    score += tvlScore * 0.3;
    
    // Volume factor
    const volumeScore = Math.min(pool.volume24h / 1000000, 100);
    score += volumeScore * 0.3;
    
    // Fee factor
    const feeScore = pool.fee * 10000; // Convert to basis points
    if (strategy === LiquidityStrategy.CONSERVATIVE) {
      score += (5 - feeScore) * 10; // Prefer lower fees
    } else if (strategy === LiquidityStrategy.AGGRESSIVE) {
      score += feeScore * 5; // Prefer higher fees
    }
    
    // APR factor
    score += Math.min(pool.apr * 100, 50); // Cap APR contribution
    
    return score;
  }
  
  /**
   * Calculate optimal range for concentrated liquidity
   */
  async calculateOptimalRange(pool, tokenA, tokenB, strategy) {
    const currentPrice = await this.getCurrentPrice(tokenA, tokenB);
    const volatility = await this.getVolatility(tokenA, tokenB);
    
    let rangeMultiplier;
    switch (strategy) {
      case LiquidityStrategy.CONSERVATIVE:
        rangeMultiplier = 2.0; // Wide range
        break;
      case LiquidityStrategy.BALANCED:
        rangeMultiplier = 1.5;
        break;
      case LiquidityStrategy.AGGRESSIVE:
        rangeMultiplier = 1.2; // Narrow range
        break;
      case LiquidityStrategy.ADAPTIVE:
        rangeMultiplier = 1.0 + volatility * 2;
        break;
      default:
        rangeMultiplier = 1.5;
    }
    
    const lowerPrice = currentPrice / rangeMultiplier;
    const upperPrice = currentPrice * rangeMultiplier;
    
    return {
      current: currentPrice,
      lower: lowerPrice,
      upper: upperPrice,
      tickLower: this.priceToTick(lowerPrice),
      tickUpper: this.priceToTick(upperPrice)
    };
  }
  
  /**
   * Rebalance positions
   */
  async rebalancePositions() {
    logger.info('Rebalancing liquidity positions...');
    
    const rebalances = [];
    
    for (const [id, position] of this.positions) {
      try {
        const shouldRebalance = await this.shouldRebalance(position);
        
        if (shouldRebalance) {
          const result = await this.rebalancePosition(position);
          rebalances.push(result);
          
          this.stats.rebalances++;
        }
        
      } catch (error) {
        logger.error(`Failed to rebalance position ${id}:`, error);
      }
    }
    
    if (rebalances.length > 0) {
      logger.info(`Completed ${rebalances.length} rebalances`);
      this.emit('rebalance:completed', rebalances);
    }
  }
  
  /**
   * Should rebalance position
   */
  async shouldRebalance(position) {
    // Check if price is out of range
    const currentPrice = await this.getCurrentPrice(
      position.tokenA,
      position.tokenB
    );
    
    const outOfRange = currentPrice < position.range.lower || 
                       currentPrice > position.range.upper;
    
    if (outOfRange) return true;
    
    // Check utilization
    const utilization = (currentPrice - position.range.lower) / 
                       (position.range.upper - position.range.lower);
    
    const utilizationDiff = Math.abs(utilization - 0.5);
    if (utilizationDiff > this.config.rebalanceThreshold) return true;
    
    // Check time since last rebalance
    const timeSinceRebalance = Date.now() - position.lastRebalance;
    if (timeSinceRebalance > 7 * 24 * 60 * 60 * 1000) return true; // 7 days
    
    return false;
  }
  
  /**
   * Rebalance individual position
   */
  async rebalancePosition(position) {
    logger.info(`Rebalancing position ${position.id}`);
    
    // Collect fees first
    const fees = await this.collectFees(position);
    position.fees.earned += fees.amount;
    
    // Calculate new range
    const newRange = await this.calculateOptimalRange(
      position.pool,
      position.tokenA,
      position.tokenB,
      position.strategy
    );
    
    // Withdraw liquidity
    const withdrawn = await this.withdrawLiquidity(position);
    
    // Rebalance amounts
    const rebalanced = await this.rebalanceAmounts(
      withdrawn.amountA,
      withdrawn.amountB,
      position.tokenA,
      position.tokenB,
      newRange.current
    );
    
    // Redeploy with new range
    const newPosition = await this.deployLiquidity({
      tokenA: position.tokenA,
      tokenB: position.tokenB,
      amountA: rebalanced.amountA,
      amountB: rebalanced.amountB,
      protocol: position.protocol,
      strategy: position.strategy
    });
    
    // Update position
    position.range = newRange;
    position.lastRebalance = Date.now();
    position.nftId = newPosition.nftId;
    position.liquidity = newPosition.liquidity;
    
    return {
      positionId: position.id,
      oldRange: position.range,
      newRange,
      fees: fees.amount,
      timestamp: Date.now()
    };
  }
  
  /**
   * Monitor impermanent loss
   */
  async monitorImpermanentLoss() {
    for (const [id, position] of this.positions) {
      const il = await this.calculateImpermanentLoss(position);
      position.performance.impermanentLoss = il;
      
      if (il > this.config.impermanentLossLimit) {
        logger.warn(`High impermanent loss detected for position ${id}: ${il * 100}%`);
        
        this.emit('impermanent-loss:high', {
          positionId: id,
          loss: il,
          action: 'consider-withdrawal'
        });
        
        // Auto-withdraw if loss is too high
        if (il > this.config.impermanentLossLimit * 1.5) {
          await this.emergencyWithdraw(position);
        }
      }
    }
    
    // Update total IL
    this.stats.impermanentLoss = this.calculateTotalImpermanentLoss();
  }
  
  /**
   * Calculate impermanent loss
   */
  async calculateImpermanentLoss(position) {
    const currentPriceA = await this.getTokenPrice(position.tokenA);
    const currentPriceB = await this.getTokenPrice(position.tokenB);
    const initialPriceA = position.performance.initialPriceA || currentPriceA;
    const initialPriceB = position.performance.initialPriceB || currentPriceB;
    
    const priceRatio = (currentPriceA / currentPriceB) / (initialPriceA / initialPriceB);
    const il = 2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1;
    
    return Math.abs(il);
  }
  
  /**
   * Collect fees from position
   */
  async collectFees(position) {
    // Simulate fee collection
    const feeRate = 0.003; // 0.3%
    const volume = Math.random() * 100000; // Mock volume
    const fees = volume * feeRate * 0.2; // LP gets 20% of fees
    
    position.fees.unclaimed = 0;
    
    return {
      amount: fees,
      tokenA: fees * 0.5,
      tokenB: fees * 0.5
    };
  }
  
  /**
   * Withdraw liquidity
   */
  async withdrawLiquidity(position) {
    logger.info(`Withdrawing liquidity from position ${position.id}`);
    
    // Simulate withdrawal
    const currentRatio = await this.getCurrentPrice(
      position.tokenA,
      position.tokenB
    );
    
    const totalValue = position.amountA + position.amountB * currentRatio;
    const amountA = totalValue / (1 + currentRatio);
    const amountB = totalValue - amountA;
    
    // Update reserves
    this.updateReserves(position.tokenA, amountA);
    this.updateReserves(position.tokenB, amountB);
    
    return {
      amountA,
      amountB
    };
  }
  
  /**
   * Emergency withdraw
   */
  async emergencyWithdraw(position) {
    logger.warn(`Emergency withdraw for position ${position.id}`);
    
    try {
      const withdrawn = await this.withdrawLiquidity(position);
      
      // Remove position
      this.positions.delete(position.id);
      
      // Update stats
      this.stats.totalLiquidityUSD -= position.performance.currentValue;
      
      this.emit('emergency:withdraw', {
        positionId: position.id,
        reason: 'high-impermanent-loss',
        withdrawn
      });
      
      return withdrawn;
      
    } catch (error) {
      logger.error('Emergency withdraw failed:', error);
      throw error;
    }
  }
  
  /**
   * Optimize liquidity allocation
   */
  async optimizeLiquidityAllocation() {
    logger.info('Optimizing liquidity allocation...');
    
    // Get all pool opportunities
    const opportunities = await this.scanOpportunities();
    
    // Score and rank opportunities
    const scored = opportunities.map(opp => ({
      ...opp,
      score: this.scoreOpportunity(opp)
    }));
    
    scored.sort((a, b) => b.score - a.score);
    
    // Reallocate to top opportunities
    const currentAllocation = this.getCurrentAllocation();
    const targetAllocation = this.calculateTargetAllocation(scored);
    
    const reallocationPlan = this.createReallocationPlan(
      currentAllocation,
      targetAllocation
    );
    
    // Execute reallocation
    for (const action of reallocationPlan) {
      try {
        await this.executeReallocation(action);
      } catch (error) {
        logger.error('Reallocation failed:', error);
      }
    }
    
    logger.info('Liquidity optimization completed');
    this.emit('optimization:completed', reallocationPlan);
  }
  
  /**
   * Scan for opportunities
   */
  async scanOpportunities() {
    const opportunities = [];
    const tokens = ['ETH', 'USDC', 'USDT', 'DAI', 'WBTC'];
    
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        for (const [protocol, config] of this.protocols) {
          const pools = await this.getAvailablePools(
            tokens[i],
            tokens[j],
            protocol
          );
          
          for (const pool of pools) {
            opportunities.push({
              protocol,
              tokenA: tokens[i],
              tokenB: tokens[j],
              pool,
              apr: pool.apr,
              tvl: pool.tvl,
              volume: pool.volume24h
            });
          }
        }
      }
    }
    
    return opportunities;
  }
  
  /**
   * Score opportunity
   */
  scoreOpportunity(opportunity) {
    let score = 0;
    
    // APR score (40% weight)
    score += Math.min(opportunity.apr * 100, 40);
    
    // Volume score (30% weight)
    const volumeScore = Math.min(opportunity.volume / 1000000, 30);
    score += volumeScore;
    
    // TVL score (20% weight)
    const tvlScore = Math.min(opportunity.tvl / 10000000, 20);
    score += tvlScore;
    
    // Risk adjustment (10% weight)
    const riskScore = this.assessRisk(opportunity);
    score += (10 - riskScore * 10);
    
    return score;
  }
  
  /**
   * Helper methods
   */
  updateReserves(token, amount) {
    this.reserves.available[token] = 
      (this.reserves.available[token] || 0) + amount;
  }
  
  updateUtilizationRate() {
    const totalAvailable = Object.values(this.reserves.available)
      .reduce((sum, amount) => sum + amount, 0);
    
    const totalDeployed = this.stats.totalLiquidityUSD;
    
    this.stats.utilizationRate = totalDeployed / (totalAvailable + totalDeployed);
  }
  
  generatePositionId() {
    return `pos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  priceToTick(price) {
    // Simplified tick calculation
    return Math.floor(Math.log(price) / Math.log(1.0001));
  }
  
  async getCurrentPrice(tokenA, tokenB) {
    // Mock price fetching
    const prices = {
      'ETH': 3000,
      'USDC': 1,
      'USDT': 1,
      'DAI': 1,
      'WBTC': 45000
    };
    
    return prices[tokenA] / prices[tokenB];
  }
  
  async getTokenPrice(token) {
    const prices = {
      'ETH': 3000,
      'USDC': 1,
      'USDT': 1,
      'DAI': 1,
      'WBTC': 45000
    };
    
    return prices[token] || 0;
  }
  
  async getVolatility(tokenA, tokenB) {
    // Mock volatility calculation
    return 0.02 + Math.random() * 0.08; // 2-10%
  }
  
  async getAvailablePools(tokenA, tokenB, protocol) {
    // Mock pool data
    return [{
      address: `0x${Math.random().toString(16).substr(2, 40)}`,
      tokenA,
      tokenB,
      fee: 0.003,
      tvl: Math.random() * 10000000,
      volume24h: Math.random() * 1000000,
      apr: Math.random() * 0.5
    }];
  }
  
  async deployToProtocol(position) {
    // Mock deployment
    return {
      nftId: Math.floor(Math.random() * 1000000),
      liquidity: position.amountA * position.amountB
    };
  }
  
  async rebalanceAmounts(amountA, amountB, tokenA, tokenB, targetPrice) {
    const currentValue = amountA + amountB * targetPrice;
    const newAmountA = currentValue / (1 + targetPrice) / 2;
    const newAmountB = currentValue / 2 / targetPrice;
    
    return {
      amountA: newAmountA,
      amountB: newAmountB
    };
  }
  
  calculateTotalImpermanentLoss() {
    let totalLoss = 0;
    let totalValue = 0;
    
    for (const position of this.positions.values()) {
      const loss = position.performance.impermanentLoss * 
                   position.performance.currentValue;
      totalLoss += loss;
      totalValue += position.performance.currentValue;
    }
    
    return totalValue > 0 ? totalLoss / totalValue : 0;
  }
  
  getCurrentAllocation() {
    const allocation = new Map();
    
    for (const position of this.positions.values()) {
      const key = `${position.protocol}-${position.tokenA}-${position.tokenB}`;
      const current = allocation.get(key) || 0;
      allocation.set(key, current + position.performance.currentValue);
    }
    
    return allocation;
  }
  
  calculateTargetAllocation(opportunities) {
    const target = new Map();
    const totalValue = this.stats.totalLiquidityUSD;
    
    // Allocate based on scores
    const totalScore = opportunities.reduce((sum, opp) => sum + opp.score, 0);
    
    for (const opp of opportunities.slice(0, 10)) { // Top 10
      const key = `${opp.protocol}-${opp.tokenA}-${opp.tokenB}`;
      const allocation = (opp.score / totalScore) * totalValue;
      target.set(key, allocation);
    }
    
    return target;
  }
  
  createReallocationPlan(current, target) {
    const plan = [];
    
    // Identify positions to reduce
    for (const [key, currentAmount] of current) {
      const targetAmount = target.get(key) || 0;
      if (currentAmount > targetAmount) {
        plan.push({
          action: 'reduce',
          key,
          amount: currentAmount - targetAmount
        });
      }
    }
    
    // Identify positions to increase
    for (const [key, targetAmount] of target) {
      const currentAmount = current.get(key) || 0;
      if (targetAmount > currentAmount) {
        plan.push({
          action: 'increase',
          key,
          amount: targetAmount - currentAmount
        });
      }
    }
    
    return plan;
  }
  
  async executeReallocation(action) {
    // Mock reallocation execution
    logger.info(`Executing reallocation: ${action.action} ${action.key} by ${action.amount}`);
  }
  
  assessRisk(opportunity) {
    let risk = 0;
    
    // Low TVL is risky
    if (opportunity.tvl < 1000000) risk += 0.3;
    
    // Low volume is risky
    if (opportunity.volume < 100000) risk += 0.3;
    
    // New pools are risky
    if (!opportunity.pool.established) risk += 0.2;
    
    // High APR might indicate risk
    if (opportunity.apr > 0.5) risk += 0.2;
    
    return Math.min(risk, 1);
  }
  
  async assessImpermanentLossRisk(tokenA, tokenB, range) {
    const correlation = await this.getTokenCorrelation(tokenA, tokenB);
    const volatility = await this.getVolatility(tokenA, tokenB);
    
    // Higher volatility and lower correlation increase IL risk
    const risk = volatility * (1 - correlation) * 
                (range.upper / range.lower - 1);
    
    return Math.min(risk, 1);
  }
  
  async getTokenCorrelation(tokenA, tokenB) {
    // Mock correlation
    if ((tokenA === 'USDC' && tokenB === 'USDT') ||
        (tokenA === 'USDT' && tokenB === 'USDC')) {
      return 0.99; // Stablecoins highly correlated
    }
    
    return 0.5 + Math.random() * 0.4; // 0.5-0.9
  }
  
  async loadExistingPositions() {
    // In production, would load from storage
    logger.info('No existing positions to load');
  }
  
  /**
   * Start cycles
   */
  startLiquidityMonitoring() {
    setInterval(async () => {
      // Update position values
      for (const position of this.positions.values()) {
        const currentPrice = await this.getCurrentPrice(
          position.tokenA,
          position.tokenB
        );
        
        const value = position.amountA + position.amountB * currentPrice;
        position.performance.currentValue = value;
        
        // Calculate APR
        const timeElapsed = Date.now() - position.createdAt;
        const returns = (value - position.performance.initialValue) / 
                       position.performance.initialValue;
        position.performance.apr = returns * (365 * 24 * 60 * 60 * 1000) / timeElapsed;
      }
      
      // Update average APR
      this.updateAverageAPR();
      
    }, 300000); // Every 5 minutes
  }
  
  startRebalancingCycle() {
    setInterval(() => {
      this.rebalancePositions();
    }, this.config.rebalanceInterval);
  }
  
  startImpermanentLossProtection() {
    setInterval(() => {
      this.monitorImpermanentLoss();
    }, 600000); // Every 10 minutes
  }
  
  updateAverageAPR() {
    if (this.positions.size === 0) {
      this.stats.averageAPR = 0;
      return;
    }
    
    let totalAPR = 0;
    let totalValue = 0;
    
    for (const position of this.positions.values()) {
      totalAPR += position.performance.apr * position.performance.currentValue;
      totalValue += position.performance.currentValue;
    }
    
    this.stats.averageAPR = totalValue > 0 ? totalAPR / totalValue : 0;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      activePositions: this.positions.size,
      protocols: this.protocols.size,
      reserves: this.reserves
    };
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    logger.info('Shutting down liquidity manager...');
    
    // Withdraw all positions
    for (const position of this.positions.values()) {
      await this.withdrawLiquidity(position);
    }
    
    this.removeAllListeners();
    logger.info('Liquidity manager shutdown complete');
  }
}

export default {
  AutomatedLiquidityManager,
  LiquidityStrategy,
  ProtocolType
};