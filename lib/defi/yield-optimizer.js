/**
 * Yield Optimizer for Otedama DeFi
 * Automatically compounds and optimizes yield farming strategies
 */

import { EventEmitter } from 'events';

/**
 * Yield farming optimizer
 */
export class YieldOptimizer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      minAPY: options.minAPY || 0.05, // 5% minimum APY
      compoundInterval: options.compoundInterval || 3600000, // 1 hour
      maxGasCost: options.maxGasCost || 0.01, // 1% of rewards
      rebalanceThreshold: options.rebalanceThreshold || 0.1, // 10% difference
      ...options
    };
    
    this.strategies = new Map();
    this.positions = new Map();
    this.rewards = new Map();
    
    // Performance tracking
    this.metrics = {
      totalValueLocked: 0,
      totalRewardsEarned: 0,
      compoundCount: 0,
      rebalanceCount: 0,
      averageAPY: 0
    };
    
    // Start auto-compound timer
    this.startAutoCompound();
  }
  
  /**
   * Add yield farming strategy
   */
  addStrategy(strategy) {
    const { id, protocol, pool, apy, risk, requirements } = strategy;
    
    this.strategies.set(id, {
      id,
      protocol,
      pool,
      apy,
      risk: risk || 'medium',
      requirements: requirements || {},
      tvl: 0,
      active: true,
      lastUpdate: Date.now()
    });
    
    this.emit('strategy:added', strategy);
  }
  
  /**
   * Deposit into yield farming position
   */
  async deposit(userId, strategyId, amount, token) {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error('Strategy not found');
    }
    
    // Validate deposit
    if (amount < strategy.requirements.minDeposit || 0) {
      throw new Error('Amount below minimum');
    }
    
    // Create or update position
    const positionId = `${userId}-${strategyId}`;
    const position = this.positions.get(positionId) || {
      userId,
      strategyId,
      deposited: 0,
      shares: 0,
      rewards: 0,
      lastHarvest: Date.now()
    };
    
    // Calculate shares based on current strategy TVL
    const shares = strategy.tvl > 0 
      ? (amount * position.shares) / strategy.tvl
      : amount;
    
    position.deposited += amount;
    position.shares += shares;
    
    this.positions.set(positionId, position);
    
    // Update strategy TVL
    strategy.tvl += amount;
    
    this.emit('deposit', {
      userId,
      strategyId,
      amount,
      token,
      shares
    });
    
    return position;
  }
  
  /**
   * Withdraw from position
   */
  async withdraw(userId, strategyId, shares) {
    const positionId = `${userId}-${strategyId}`;
    const position = this.positions.get(positionId);
    
    if (!position) {
      throw new Error('Position not found');
    }
    
    if (shares > position.shares) {
      throw new Error('Insufficient shares');
    }
    
    const strategy = this.strategies.get(strategyId);
    
    // Calculate withdrawal amount including rewards
    const shareRatio = shares / position.shares;
    const principal = position.deposited * shareRatio;
    const rewards = await this.calculateRewards(positionId);
    const totalAmount = principal + (rewards * shareRatio);
    
    // Update position
    position.shares -= shares;
    position.deposited -= principal;
    position.rewards = rewards * (1 - shareRatio);
    
    if (position.shares === 0) {
      this.positions.delete(positionId);
    } else {
      this.positions.set(positionId, position);
    }
    
    // Update strategy TVL
    strategy.tvl -= principal;
    
    this.emit('withdraw', {
      userId,
      strategyId,
      shares,
      amount: totalAmount,
      principal,
      rewards: rewards * shareRatio
    });
    
    return {
      amount: totalAmount,
      principal,
      rewards: rewards * shareRatio
    };
  }
  
  /**
   * Calculate pending rewards
   */
  async calculateRewards(positionId) {
    const position = this.positions.get(positionId);
    if (!position) return 0;
    
    const strategy = this.strategies.get(position.strategyId);
    const timeSinceHarvest = Date.now() - position.lastHarvest;
    const timeInHours = timeSinceHarvest / 3600000;
    
    // Simple APY calculation
    const pendingRewards = position.deposited * (strategy.apy / 8760) * timeInHours;
    
    return position.rewards + pendingRewards;
  }
  
  /**
   * Harvest rewards from position
   */
  async harvest(userId, strategyId) {
    const positionId = `${userId}-${strategyId}`;
    const position = this.positions.get(positionId);
    
    if (!position) {
      throw new Error('Position not found');
    }
    
    const rewards = await this.calculateRewards(positionId);
    
    if (rewards === 0) {
      return { rewards: 0 };
    }
    
    // Update position
    position.rewards = 0;
    position.lastHarvest = Date.now();
    this.positions.set(positionId, position);
    
    // Track metrics
    this.metrics.totalRewardsEarned += rewards;
    
    this.emit('harvest', {
      userId,
      strategyId,
      rewards
    });
    
    return { rewards };
  }
  
  /**
   * Auto-compound rewards
   */
  async autoCompound() {
    for (const [positionId, position] of this.positions) {
      try {
        const rewards = await this.calculateRewards(positionId);
        const strategy = this.strategies.get(position.strategyId);
        
        // Check if compounding is profitable
        const gasCost = this.estimateGasCost('compound');
        const minRewards = position.deposited * this.options.maxGasCost;
        
        if (rewards > minRewards && rewards > gasCost) {
          // Reinvest rewards
          await this.deposit(
            position.userId,
            position.strategyId,
            rewards,
            'reward'
          );
          
          position.rewards = 0;
          position.lastHarvest = Date.now();
          this.positions.set(positionId, position);
          
          this.metrics.compoundCount++;
          
          this.emit('compound', {
            positionId,
            rewards,
            gasCost
          });
        }
      } catch (error) {
        this.emit('error', {
          type: 'compound',
          positionId,
          error: error.message
        });
      }
    }
  }
  
  /**
   * Rebalance strategies
   */
  async rebalanceStrategies() {
    const activeStrategies = Array.from(this.strategies.values())
      .filter(s => s.active)
      .sort((a, b) => b.apy - a.apy);
    
    for (const [positionId, position] of this.positions) {
      const currentStrategy = this.strategies.get(position.strategyId);
      const bestStrategy = activeStrategies[0];
      
      // Check if rebalancing would be beneficial
      const apyDifference = bestStrategy.apy - currentStrategy.apy;
      
      if (apyDifference > this.options.rebalanceThreshold) {
        // Calculate rebalancing cost
        const withdrawCost = this.estimateGasCost('withdraw');
        const depositCost = this.estimateGasCost('deposit');
        const totalCost = withdrawCost + depositCost;
        
        // Estimate time to break even
        const extraYield = position.deposited * apyDifference;
        const breakEvenDays = (totalCost / extraYield) * 365;
        
        if (breakEvenDays < 30) { // Break even within 30 days
          // Withdraw from current strategy
          const withdrawal = await this.withdraw(
            position.userId,
            position.strategyId,
            position.shares
          );
          
          // Deposit to better strategy
          await this.deposit(
            position.userId,
            bestStrategy.id,
            withdrawal.amount,
            'rebalance'
          );
          
          this.metrics.rebalanceCount++;
          
          this.emit('rebalance', {
            userId: position.userId,
            fromStrategy: position.strategyId,
            toStrategy: bestStrategy.id,
            amount: withdrawal.amount,
            apyImprovement: apyDifference
          });
        }
      }
    }
  }
  
  /**
   * Find best strategies for user
   */
  findBestStrategies(requirements = {}) {
    const { minAPY, maxRisk, tokens, amount } = requirements;
    
    return Array.from(this.strategies.values())
      .filter(strategy => {
        if (minAPY && strategy.apy < minAPY) return false;
        if (maxRisk && this.getRiskScore(strategy.risk) > this.getRiskScore(maxRisk)) return false;
        if (tokens && !tokens.includes(strategy.pool.token)) return false;
        if (amount && strategy.requirements.minDeposit > amount) return false;
        return strategy.active;
      })
      .sort((a, b) => {
        // Sort by risk-adjusted APY
        const aScore = a.apy / this.getRiskScore(a.risk);
        const bScore = b.apy / this.getRiskScore(b.risk);
        return bScore - aScore;
      });
  }
  
  /**
   * Get risk score
   */
  getRiskScore(risk) {
    const scores = {
      low: 1,
      medium: 2,
      high: 3,
      extreme: 5
    };
    return scores[risk] || 2;
  }
  
  /**
   * Estimate gas cost
   */
  estimateGasCost(operation) {
    const gasCosts = {
      deposit: 0.002,
      withdraw: 0.003,
      compound: 0.001,
      harvest: 0.001
    };
    return gasCosts[operation] || 0.002;
  }
  
  /**
   * Start auto-compound timer
   */
  startAutoCompound() {
    this.compoundTimer = setInterval(
      () => this.autoCompound(),
      this.options.compoundInterval
    );
    
    // Also check for rebalancing opportunities
    this.rebalanceTimer = setInterval(
      () => this.rebalanceStrategies(),
      this.options.compoundInterval * 24 // Daily
    );
  }
  
  /**
   * Get user portfolio
   */
  getUserPortfolio(userId) {
    const positions = [];
    let totalValue = 0;
    let totalRewards = 0;
    
    for (const [positionId, position] of this.positions) {
      if (position.userId === userId) {
        const strategy = this.strategies.get(position.strategyId);
        const rewards = this.calculateRewards(positionId);
        const value = position.deposited + rewards;
        
        positions.push({
          strategy: strategy.id,
          protocol: strategy.protocol,
          deposited: position.deposited,
          rewards,
          value,
          apy: strategy.apy,
          shares: position.shares
        });
        
        totalValue += value;
        totalRewards += rewards;
      }
    }
    
    return {
      positions,
      totalValue,
      totalRewards,
      positionCount: positions.length,
      averageAPY: positions.length > 0
        ? positions.reduce((sum, p) => sum + p.apy, 0) / positions.length
        : 0
    };
  }
  
  /**
   * Shutdown
   */
  shutdown() {
    if (this.compoundTimer) {
      clearInterval(this.compoundTimer);
    }
    if (this.rebalanceTimer) {
      clearInterval(this.rebalanceTimer);
    }
  }
}