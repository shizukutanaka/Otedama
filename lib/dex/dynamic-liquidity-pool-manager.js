import EventEmitter from 'events';
import crypto from 'crypto';

const PoolStrategy = {
  BALANCED: 'balanced',
  AGGRESSIVE: 'aggressive',
  CONSERVATIVE: 'conservative',
  MOMENTUM: 'momentum',
  MEAN_REVERSION: 'mean_reversion',
  VOLATILITY_BASED: 'volatility_based'
};

const RebalanceReason = {
  PRICE_DEVIATION: 'price_deviation',
  VOLATILITY_SPIKE: 'volatility_spike',
  VOLUME_THRESHOLD: 'volume_threshold',
  TIME_BASED: 'time_based',
  IMPERMANENT_LOSS: 'impermanent_loss',
  YIELD_OPTIMIZATION: 'yield_optimization'
};

const PoolStatus = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  REBALANCING: 'rebalancing',
  EMERGENCY: 'emergency'
};

const RiskLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  EXTREME: 'extreme'
};

export class DynamicLiquidityPoolManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableAutoRebalancing: options.enableAutoRebalancing !== false,
      enableRiskManagement: options.enableRiskManagement !== false,
      enableYieldOptimization: options.enableYieldOptimization !== false,
      enableImpermanentLossProtection: options.enableImpermanentLossProtection !== false,
      enableMultiDEXSupport: options.enableMultiDEXSupport !== false,
      rebalanceThreshold: options.rebalanceThreshold || 0.05, // 5%
      maxSlippage: options.maxSlippage || 0.02, // 2%
      emergencyThreshold: options.emergencyThreshold || 0.20, // 20%
      rebalanceInterval: options.rebalanceInterval || 15 * 60 * 1000, // 15 minutes
      volatilityWindow: options.volatilityWindow || 24 * 60 * 60 * 1000, // 24 hours
      maxLeverage: options.maxLeverage || 3.0,
      minLiquidity: options.minLiquidity || 10000, // $10k minimum
      feeOptimization: options.feeOptimization || true
    };

    this.pools = new Map();
    this.strategies = new Map();
    this.positions = new Map();
    this.priceHistory = new Map();
    this.volatilityCache = new Map();
    this.rebalanceHistory = new Map();
    this.yieldTracking = new Map();
    
    this.isRunning = false;
    this.metrics = {
      totalPools: 0,
      totalLiquidity: 0,
      totalYield: 0,
      rebalances: 0,
      impermanentLoss: 0,
      emergencyExits: 0,
      averageAPY: 0,
      sharpeRatio: 0
    };

    this.initializeStrategies();
    this.startPriceMonitoring();
    this.startRebalancingEngine();
    this.startRiskMonitoring();
  }

  initializeStrategies() {
    const strategies = [
      {
        name: PoolStrategy.BALANCED,
        description: 'Balanced allocation with moderate risk',
        targetAllocation: { stable: 0.4, volatile: 0.6 },
        rebalanceThreshold: 0.05,
        maxDrawdown: 0.15,
        targetVolatility: 0.2
      },
      {
        name: PoolStrategy.AGGRESSIVE,
        description: 'High-risk, high-reward strategy',
        targetAllocation: { stable: 0.2, volatile: 0.8 },
        rebalanceThreshold: 0.08,
        maxDrawdown: 0.30,
        targetVolatility: 0.4
      },
      {
        name: PoolStrategy.CONSERVATIVE,
        description: 'Low-risk strategy with stable returns',
        targetAllocation: { stable: 0.7, volatile: 0.3 },
        rebalanceThreshold: 0.03,
        maxDrawdown: 0.08,
        targetVolatility: 0.1
      },
      {
        name: PoolStrategy.MOMENTUM,
        description: 'Follow price momentum trends',
        targetAllocation: { stable: 0.3, volatile: 0.7 },
        rebalanceThreshold: 0.06,
        maxDrawdown: 0.25,
        targetVolatility: 0.3
      },
      {
        name: PoolStrategy.MEAN_REVERSION,
        description: 'Exploit mean reversion opportunities',
        targetAllocation: { stable: 0.5, volatile: 0.5 },
        rebalanceThreshold: 0.04,
        maxDrawdown: 0.12,
        targetVolatility: 0.15
      },
      {
        name: PoolStrategy.VOLATILITY_BASED,
        description: 'Adjust allocation based on volatility',
        targetAllocation: { stable: 0.5, volatile: 0.5 },
        rebalanceThreshold: 0.07,
        maxDrawdown: 0.18,
        targetVolatility: 0.25
      }
    ];

    strategies.forEach(strategy => {
      this.strategies.set(strategy.name, strategy);
    });
  }

  async createPool(tokenA, tokenB, strategy, initialLiquidity, options = {}) {
    try {
      const poolId = this.generatePoolId(tokenA, tokenB, strategy);
      
      if (this.pools.has(poolId)) {
        throw new Error('Pool already exists');
      }

      const strategyConfig = this.strategies.get(strategy);
      if (!strategyConfig) {
        throw new Error('Invalid strategy');
      }

      if (initialLiquidity < this.options.minLiquidity) {
        throw new Error(`Initial liquidity must be at least $${this.options.minLiquidity}`);
      }

      const pool = {
        id: poolId,
        tokenA,
        tokenB,
        strategy,
        strategyConfig,
        totalLiquidity: initialLiquidity,
        liquidityA: initialLiquidity * strategyConfig.targetAllocation.stable,
        liquidityB: initialLiquidity * strategyConfig.targetAllocation.volatile,
        priceA: options.priceA || 1.0,
        priceB: options.priceB || 1.0,
        fees24h: 0,
        volume24h: 0,
        apy: 0,
        impermanentLoss: 0,
        volatility: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        lastRebalance: Date.now(),
        nextRebalance: Date.now() + this.options.rebalanceInterval,
        status: PoolStatus.ACTIVE,
        riskLevel: RiskLevel.MEDIUM,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      this.pools.set(poolId, pool);
      this.priceHistory.set(poolId, []);
      this.rebalanceHistory.set(poolId, []);
      this.yieldTracking.set(poolId, []);

      this.metrics.totalPools++;
      this.metrics.totalLiquidity += initialLiquidity;

      this.emit('poolCreated', pool);
      return poolId;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async rebalancePool(poolId, reason = RebalanceReason.TIME_BASED, options = {}) {
    try {
      const pool = this.pools.get(poolId);
      if (!pool || pool.status !== PoolStatus.ACTIVE) {
        throw new Error('Pool not found or not active');
      }

      pool.status = PoolStatus.REBALANCING;
      const startTime = Date.now();

      const currentAllocation = this.getCurrentAllocation(pool);
      const targetAllocation = await this.calculateOptimalAllocation(pool);
      
      const rebalanceData = {
        poolId,
        reason,
        timestamp: startTime,
        beforeAllocation: currentAllocation,
        targetAllocation,
        slippage: 0,
        gasUsed: 0,
        profitLoss: 0
      };

      // Calculate required swaps
      const swaps = this.calculateRebalanceSwaps(pool, currentAllocation, targetAllocation);
      
      // Execute swaps
      for (const swap of swaps) {
        const result = await this.executeSwap(pool, swap);
        rebalanceData.slippage += result.slippage;
        rebalanceData.gasUsed += result.gasUsed;
        rebalanceData.profitLoss += result.profitLoss;
      }

      // Update pool allocation
      this.updatePoolAllocation(pool, targetAllocation);

      // Record rebalance
      pool.lastRebalance = Date.now();
      pool.nextRebalance = Date.now() + this.options.rebalanceInterval;
      pool.status = PoolStatus.ACTIVE;
      
      rebalanceData.afterAllocation = this.getCurrentAllocation(pool);
      rebalanceData.executionTime = Date.now() - startTime;

      const history = this.rebalanceHistory.get(poolId) || [];
      history.push(rebalanceData);
      this.rebalanceHistory.set(poolId, history);

      this.metrics.rebalances++;

      this.emit('poolRebalanced', rebalanceData);
      return rebalanceData;
    } catch (error) {
      const pool = this.pools.get(poolId);
      if (pool) {
        pool.status = PoolStatus.ACTIVE;
      }
      this.emit('error', error);
      throw error;
    }
  }

  getCurrentAllocation(pool) {
    const totalValue = pool.liquidityA * pool.priceA + pool.liquidityB * pool.priceB;
    return {
      stable: (pool.liquidityA * pool.priceA) / totalValue,
      volatile: (pool.liquidityB * pool.priceB) / totalValue
    };
  }

  async calculateOptimalAllocation(pool) {
    try {
      const strategy = pool.strategyConfig;
      const volatility = await this.calculateVolatility(pool.id);
      const momentum = await this.calculateMomentum(pool.id);
      const marketConditions = await this.analyzeMarketConditions(pool.id);

      let allocation = { ...strategy.targetAllocation };

      // Adjust based on strategy type
      switch (pool.strategy) {
        case PoolStrategy.VOLATILITY_BASED:
          if (volatility > 0.3) {
            allocation.stable = Math.min(0.8, allocation.stable + 0.2);
            allocation.volatile = 1 - allocation.stable;
          } else if (volatility < 0.1) {
            allocation.volatile = Math.min(0.8, allocation.volatile + 0.2);
            allocation.stable = 1 - allocation.volatile;
          }
          break;

        case PoolStrategy.MOMENTUM:
          if (momentum > 0.05) {
            allocation.volatile = Math.min(0.9, allocation.volatile + 0.1);
            allocation.stable = 1 - allocation.volatile;
          } else if (momentum < -0.05) {
            allocation.stable = Math.min(0.8, allocation.stable + 0.2);
            allocation.volatile = 1 - allocation.stable;
          }
          break;

        case PoolStrategy.MEAN_REVERSION:
          const priceDeviation = await this.calculatePriceDeviation(pool.id);
          if (Math.abs(priceDeviation) > 0.1) {
            // Increase allocation to oversold/overbought asset
            if (priceDeviation > 0) {
              allocation.stable = Math.min(0.7, allocation.stable + 0.1);
            } else {
              allocation.volatile = Math.min(0.7, allocation.volatile + 0.1);
            }
          }
          break;

        case PoolStrategy.AGGRESSIVE:
          // Increase volatile allocation in trending markets
          if (marketConditions.trend > 0.02) {
            allocation.volatile = Math.min(0.95, allocation.volatile + 0.05);
            allocation.stable = 1 - allocation.volatile;
          }
          break;

        case PoolStrategy.CONSERVATIVE:
          // Increase stable allocation during high volatility
          if (volatility > 0.2 || marketConditions.uncertainty > 0.15) {
            allocation.stable = Math.min(0.85, allocation.stable + 0.1);
            allocation.volatile = 1 - allocation.stable;
          }
          break;
      }

      return allocation;
    } catch (error) {
      this.emit('error', error);
      return pool.strategyConfig.targetAllocation;
    }
  }

  calculateRebalanceSwaps(pool, currentAllocation, targetAllocation) {
    const swaps = [];
    const totalValue = pool.liquidityA * pool.priceA + pool.liquidityB * pool.priceB;
    
    const currentStableValue = currentAllocation.stable * totalValue;
    const targetStableValue = targetAllocation.stable * totalValue;
    const rebalanceAmount = Math.abs(currentStableValue - targetStableValue);

    if (Math.abs(currentAllocation.stable - targetAllocation.stable) > this.options.rebalanceThreshold) {
      if (currentAllocation.stable > targetAllocation.stable) {
        // Sell stable for volatile
        swaps.push({
          fromToken: pool.tokenA,
          toToken: pool.tokenB,
          amount: rebalanceAmount / pool.priceA,
          type: 'stable_to_volatile'
        });
      } else {
        // Sell volatile for stable
        swaps.push({
          fromToken: pool.tokenB,
          toToken: pool.tokenA,
          amount: rebalanceAmount / pool.priceB,
          type: 'volatile_to_stable'
        });
      }
    }

    return swaps;
  }

  async executeSwap(pool, swap) {
    try {
      // Simulate swap execution
      const slippage = Math.random() * this.options.maxSlippage;
      const gasUsed = Math.random() * 0.001 * swap.amount; // Simulate gas costs
      
      let profitLoss = 0;
      
      if (swap.type === 'stable_to_volatile') {
        const receivedAmount = swap.amount * (1 - slippage) * (pool.priceA / pool.priceB);
        pool.liquidityA -= swap.amount;
        pool.liquidityB += receivedAmount;
        profitLoss = receivedAmount * pool.priceB - swap.amount * pool.priceA;
      } else {
        const receivedAmount = swap.amount * (1 - slippage) * (pool.priceB / pool.priceA);
        pool.liquidityB -= swap.amount;
        pool.liquidityA += receivedAmount;
        profitLoss = receivedAmount * pool.priceA - swap.amount * pool.priceB;
      }

      // Simulate execution delay
      await this.delay(1000 + Math.random() * 2000);

      return {
        slippage,
        gasUsed,
        profitLoss: profitLoss - gasUsed
      };
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  updatePoolAllocation(pool, newAllocation) {
    const totalValue = pool.liquidityA * pool.priceA + pool.liquidityB * pool.priceB;
    
    pool.liquidityA = (newAllocation.stable * totalValue) / pool.priceA;
    pool.liquidityB = (newAllocation.volatile * totalValue) / pool.priceB;
    pool.updatedAt = Date.now();
  }

  async calculateVolatility(poolId) {
    try {
      const priceHistory = this.priceHistory.get(poolId) || [];
      if (priceHistory.length < 10) return 0.2; // Default volatility

      const returns = [];
      for (let i = 1; i < priceHistory.length; i++) {
        const returnRate = (priceHistory[i].price - priceHistory[i-1].price) / priceHistory[i-1].price;
        returns.push(returnRate);
      }

      const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
      const volatility = Math.sqrt(variance) * Math.sqrt(365); // Annualized volatility

      return volatility;
    } catch (error) {
      this.emit('error', error);
      return 0.2;
    }
  }

  async calculateMomentum(poolId) {
    try {
      const priceHistory = this.priceHistory.get(poolId) || [];
      if (priceHistory.length < 5) return 0;

      const recentPrices = priceHistory.slice(-5);
      const oldestPrice = recentPrices[0].price;
      const newestPrice = recentPrices[recentPrices.length - 1].price;
      
      return (newestPrice - oldestPrice) / oldestPrice;
    } catch (error) {
      this.emit('error', error);
      return 0;
    }
  }

  async calculatePriceDeviation(poolId) {
    try {
      const priceHistory = this.priceHistory.get(poolId) || [];
      if (priceHistory.length < 20) return 0;

      const recentPrices = priceHistory.slice(-20).map(p => p.price);
      const mean = recentPrices.reduce((sum, p) => sum + p, 0) / recentPrices.length;
      const currentPrice = recentPrices[recentPrices.length - 1];
      
      return (currentPrice - mean) / mean;
    } catch (error) {
      this.emit('error', error);
      return 0;
    }
  }

  async analyzeMarketConditions(poolId) {
    try {
      const volatility = await this.calculateVolatility(poolId);
      const momentum = await this.calculateMomentum(poolId);
      
      return {
        trend: momentum,
        volatility,
        uncertainty: volatility > 0.3 ? 0.8 : volatility < 0.1 ? 0.2 : 0.5,
        marketPhase: volatility > 0.4 ? 'high_volatility' : 
                    Math.abs(momentum) > 0.1 ? 'trending' : 'ranging'
      };
    } catch (error) {
      this.emit('error', error);
      return { trend: 0, volatility: 0.2, uncertainty: 0.5, marketPhase: 'ranging' };
    }
  }

  startPriceMonitoring() {
    if (this.priceMonitor) return;
    
    this.priceMonitor = setInterval(async () => {
      try {
        for (const [poolId, pool] of this.pools) {
          // Simulate price updates
          const volatility = this.volatilityCache.get(poolId) || 0.2;
          const priceChangeA = (Math.random() - 0.5) * volatility * 0.1;
          const priceChangeB = (Math.random() - 0.5) * volatility * 0.15;
          
          pool.priceA *= (1 + priceChangeA);
          pool.priceB *= (1 + priceChangeB);

          // Update price history
          const history = this.priceHistory.get(poolId) || [];
          history.push({
            timestamp: Date.now(),
            priceA: pool.priceA,
            priceB: pool.priceB,
            price: pool.priceB / pool.priceA // Ratio price
          });

          // Keep only recent history
          if (history.length > 1000) {
            history.shift();
          }

          this.priceHistory.set(poolId, history);

          // Update pool metrics
          await this.updatePoolMetrics(pool);
        }
      } catch (error) {
        this.emit('error', error);
      }
    }, 10000); // Update every 10 seconds
  }

  startRebalancingEngine() {
    if (this.rebalancingEngine) return;
    
    this.rebalancingEngine = setInterval(async () => {
      try {
        for (const [poolId, pool] of this.pools) {
          if (pool.status !== PoolStatus.ACTIVE) continue;

          const shouldRebalance = await this.shouldRebalance(pool);
          
          if (shouldRebalance.shouldRebalance) {
            await this.rebalancePool(poolId, shouldRebalance.reason);
          }
        }
      } catch (error) {
        this.emit('error', error);
      }
    }, 60000); // Check every minute
  }

  async shouldRebalance(pool) {
    try {
      const currentAllocation = this.getCurrentAllocation(pool);
      const targetAllocation = await this.calculateOptimalAllocation(pool);
      
      const allocationDeviation = Math.abs(currentAllocation.stable - targetAllocation.stable);
      
      // Time-based rebalancing
      if (Date.now() >= pool.nextRebalance) {
        return { shouldRebalance: true, reason: RebalanceReason.TIME_BASED };
      }

      // Threshold-based rebalancing
      if (allocationDeviation > pool.strategyConfig.rebalanceThreshold) {
        return { shouldRebalance: true, reason: RebalanceReason.PRICE_DEVIATION };
      }

      // Volatility-based rebalancing
      const volatility = await this.calculateVolatility(pool.id);
      if (volatility > 0.5) {
        return { shouldRebalance: true, reason: RebalanceReason.VOLATILITY_SPIKE };
      }

      // Impermanent loss protection
      const impermanentLoss = await this.calculateImpermanentLoss(pool);
      if (impermanentLoss > 0.1) {
        return { shouldRebalance: true, reason: RebalanceReason.IMPERMANENT_LOSS };
      }

      return { shouldRebalance: false, reason: null };
    } catch (error) {
      this.emit('error', error);
      return { shouldRebalance: false, reason: null };
    }
  }

  async calculateImpermanentLoss(pool) {
    try {
      const priceHistory = this.priceHistory.get(pool.id) || [];
      if (priceHistory.length < 2) return 0;

      const initialPrice = priceHistory[0].price;
      const currentPrice = priceHistory[priceHistory.length - 1].price;
      const priceRatio = currentPrice / initialPrice;

      // Impermanent loss formula for 50/50 pool
      const impermanentLoss = 2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1;
      
      return Math.abs(impermanentLoss);
    } catch (error) {
      this.emit('error', error);
      return 0;
    }
  }

  startRiskMonitoring() {
    if (this.riskMonitor) return;
    
    this.riskMonitor = setInterval(async () => {
      try {
        for (const [poolId, pool] of this.pools) {
          const riskLevel = await this.assessRiskLevel(pool);
          pool.riskLevel = riskLevel;

          if (riskLevel === RiskLevel.EXTREME && pool.status === PoolStatus.ACTIVE) {
            pool.status = PoolStatus.EMERGENCY;
            this.emit('emergencyStop', { poolId, reason: 'extreme_risk' });
            this.metrics.emergencyExits++;
          }
        }
      } catch (error) {
        this.emit('error', error);
      }
    }, 30000); // Check every 30 seconds
  }

  async assessRiskLevel(pool) {
    try {
      const volatility = await this.calculateVolatility(pool.id);
      const impermanentLoss = await this.calculateImpermanentLoss(pool);
      const drawdown = await this.calculateMaxDrawdown(pool);

      let riskScore = 0;
      
      // Volatility component
      if (volatility > 0.5) riskScore += 3;
      else if (volatility > 0.3) riskScore += 2;
      else if (volatility > 0.2) riskScore += 1;

      // Impermanent loss component
      if (impermanentLoss > 0.2) riskScore += 3;
      else if (impermanentLoss > 0.1) riskScore += 2;
      else if (impermanentLoss > 0.05) riskScore += 1;

      // Drawdown component
      if (drawdown > 0.3) riskScore += 3;
      else if (drawdown > 0.2) riskScore += 2;
      else if (drawdown > 0.1) riskScore += 1;

      if (riskScore >= 7) return RiskLevel.EXTREME;
      if (riskScore >= 5) return RiskLevel.HIGH;
      if (riskScore >= 3) return RiskLevel.MEDIUM;
      return RiskLevel.LOW;
    } catch (error) {
      this.emit('error', error);
      return RiskLevel.MEDIUM;
    }
  }

  async calculateMaxDrawdown(pool) {
    try {
      const yieldHistory = this.yieldTracking.get(pool.id) || [];
      if (yieldHistory.length < 2) return 0;

      let maxValue = yieldHistory[0].totalValue;
      let maxDrawdown = 0;

      for (const entry of yieldHistory) {
        if (entry.totalValue > maxValue) {
          maxValue = entry.totalValue;
        } else {
          const drawdown = (maxValue - entry.totalValue) / maxValue;
          if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
          }
        }
      }

      return maxDrawdown;
    } catch (error) {
      this.emit('error', error);
      return 0;
    }
  }

  async updatePoolMetrics(pool) {
    try {
      const totalValue = pool.liquidityA * pool.priceA + pool.liquidityB * pool.priceB;
      
      // Update yield tracking
      const yieldHistory = this.yieldTracking.get(pool.id) || [];
      const lastEntry = yieldHistory[yieldHistory.length - 1];
      
      if (lastEntry) {
        const timeElapsed = (Date.now() - lastEntry.timestamp) / (1000 * 60 * 60 * 24); // Days
        const yieldRate = (totalValue - lastEntry.totalValue) / lastEntry.totalValue;
        const annualizedYield = (yieldRate / timeElapsed) * 365;
        pool.apy = annualizedYield;
      }

      yieldHistory.push({
        timestamp: Date.now(),
        totalValue,
        apy: pool.apy
      });

      // Keep only recent history
      if (yieldHistory.length > 365) {
        yieldHistory.shift();
      }

      this.yieldTracking.set(pool.id, yieldHistory);

      // Update volatility cache
      const volatility = await this.calculateVolatility(pool.id);
      this.volatilityCache.set(pool.id, volatility);
      pool.volatility = volatility;

      // Calculate Sharpe ratio
      pool.sharpeRatio = pool.apy > 0 ? pool.apy / volatility : 0;

      // Calculate impermanent loss
      pool.impermanentLoss = await this.calculateImpermanentLoss(pool);

      // Calculate max drawdown
      pool.maxDrawdown = await this.calculateMaxDrawdown(pool);

    } catch (error) {
      this.emit('error', error);
    }
  }

  generatePoolId(tokenA, tokenB, strategy) {
    return crypto.createHash('sha256')
      .update(`${tokenA}-${tokenB}-${strategy}-${Date.now()}`)
      .digest('hex')
      .substring(0, 16);
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async getPool(poolId) {
    return this.pools.get(poolId) || null;
  }

  async getAllPools() {
    return Array.from(this.pools.values());
  }

  async getPoolsByStrategy(strategy) {
    return Array.from(this.pools.values())
      .filter(pool => pool.strategy === strategy);
  }

  async getRebalanceHistory(poolId) {
    return this.rebalanceHistory.get(poolId) || [];
  }

  async emergencyExit(poolId, options = {}) {
    try {
      const pool = this.pools.get(poolId);
      if (!pool) {
        throw new Error('Pool not found');
      }

      pool.status = PoolStatus.EMERGENCY;
      
      // Convert all positions to stable tokens
      const emergencyAllocation = { stable: 1.0, volatile: 0.0 };
      const swaps = this.calculateRebalanceSwaps(pool, this.getCurrentAllocation(pool), emergencyAllocation);
      
      for (const swap of swaps) {
        await this.executeSwap(pool, swap);
      }

      this.updatePoolAllocation(pool, emergencyAllocation);
      
      this.metrics.emergencyExits++;
      this.emit('emergencyExit', { poolId, timestamp: Date.now() });
      
      return true;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  getMetrics() {
    const activePools = Array.from(this.pools.values()).filter(p => p.status === PoolStatus.ACTIVE);
    const totalValue = activePools.reduce((sum, pool) => {
      return sum + (pool.liquidityA * pool.priceA + pool.liquidityB * pool.priceB);
    }, 0);

    const averageAPY = activePools.length > 0 
      ? activePools.reduce((sum, pool) => sum + pool.apy, 0) / activePools.length
      : 0;

    const averageSharpe = activePools.length > 0
      ? activePools.reduce((sum, pool) => sum + pool.sharpeRatio, 0) / activePools.length
      : 0;

    return {
      ...this.metrics,
      totalPools: this.pools.size,
      activePools: activePools.length,
      totalLiquidity: totalValue,
      averageAPY,
      averageSharpe,
      totalImpermanentLoss: activePools.reduce((sum, pool) => sum + pool.impermanentLoss, 0)
    };
  }

  async stop() {
    this.isRunning = false;
    
    if (this.priceMonitor) {
      clearInterval(this.priceMonitor);
      this.priceMonitor = null;
    }
    
    if (this.rebalancingEngine) {
      clearInterval(this.rebalancingEngine);
      this.rebalancingEngine = null;
    }
    
    if (this.riskMonitor) {
      clearInterval(this.riskMonitor);
      this.riskMonitor = null;
    }
    
    this.emit('stopped');
  }
}

export { PoolStrategy, RebalanceReason, PoolStatus, RiskLevel };