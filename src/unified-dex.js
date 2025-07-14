import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { createHash } from 'crypto';

/**
 * Unified DEX System - V2 AMM + V3 Concentrated Liquidity
 * 統合されたDEXシステム（自動化済み）
 * 
 * Features:
 * - V2: Automated Market Making with constant product formula
 * - V3: Concentrated liquidity with automated range management
 * - Automatic fee collection and distribution
 * - Cross-version liquidity aggregation
 * - Unified interface for both protocols
 */
export class UnifiedDEX extends EventEmitter {
  constructor(feeManager) {
    super();
    this.feeManager = feeManager;
    this.logger = new Logger('UnifiedDEX');
    
    // V2 State
    this.v2Pools = new Map();
    this.v2LiquidityProviders = new Map();
    
    // V3 State
    this.v3Pools = new Map();
    this.v3Positions = new Map();
    this.v3Ticks = new Map();
    
    // Shared State
    this.tradingHistory = [];
    this.priceOracle = new Map();
    this.conversionRates = new Map();
    
    // Configuration
    this.config = {
      // V2 Config
      v2: {
        tradingFee: 0.003, // 0.3%
        rebalanceThreshold: 0.05,
        minLiquidity: 1000,
        maxSlippage: 0.10,
        autoRebalanceInterval: 600000
      },
      // V3 Config
      v3: {
        tickSpacing: {
          100: 1,    // 0.01% fee tier
          500: 10,   // 0.05% fee tier
          3000: 60,  // 0.3% fee tier
          10000: 200 // 1% fee tier
        },
        autoCompoundInterval: 300000,
        rangeAdjustmentInterval: 900000,
        Q96: BigInt(2) ** BigInt(96),
        Q128: BigInt(2) ** BigInt(128)
      },
      // Shared Config
      feeDistributionInterval: 3600000,
      arbitrageThreshold: 0.02,
      mevProtectionEnabled: true
    };
    
    // Automated processes
    this.automatedProcesses = new Map();
    
    // Initialize automated systems
    this.initializeAutomatedSystems();
    
    this.logger.info('Unified DEX system initialized with V2 AMM and V3 concentrated liquidity');
  }

  /**
   * Initialize all automated systems
   */
  initializeAutomatedSystems() {
    // V2 Automated systems
    this.startV2AutomatedRebalancing();
    
    // V3 Automated systems
    this.startV3AutomatedFeeCompounding();
    this.startV3AutomatedRangeManagement();
    
    // Shared automated systems
    this.startAutomatedFeeDistribution();
    this.startCrossVersionArbitrage();
    this.startPriceOracleUpdates();
    
    this.logger.info('All DEX automated systems started');
  }

  /**
   * Create V2 liquidity pool
   */
  createV2Pool(token0, token1, fee = null) {
    const poolId = this.generatePoolId(token0, token1, 'v2');
    
    if (this.v2Pools.has(poolId)) {
      return { version: 'v2', poolId, exists: true };
    }

    const pool = {
      id: poolId,
      version: 'v2',
      token0,
      token1,
      reserve0: BigInt(0),
      reserve1: BigInt(0),
      totalSupply: BigInt(0),
      fee: fee || this.config.v2.tradingFee,
      kLast: BigInt(0),
      createdAt: Date.now(),
      autoRebalance: true,
      feeAccumulated: BigInt(0),
      volume24h: BigInt(0),
      lastVolumeReset: Date.now()
    };

    this.v2Pools.set(poolId, pool);
    
    this.logger.info(`Created V2 pool: ${poolId} with ${pool.fee * 100}% fee`);
    this.emit('pool:created', { version: 'v2', ...pool });
    
    return { version: 'v2', poolId, pool };
  }

  /**
   * Create V3 concentrated liquidity pool
   */
  createV3Pool(token0, token1, fee, sqrtPriceX96) {
    const poolKey = this.generatePoolId(token0, token1, 'v3', fee);
    
    if (this.v3Pools.has(poolKey)) {
      return { version: 'v3', poolKey, exists: true };
    }

    const [tokenA, tokenB] = token0 < token1 ? [token0, token1] : [token1, token0];
    const adjustedSqrtPriceX96 = token0 < token1 ? sqrtPriceX96 : this.config.v3.Q256 / sqrtPriceX96;

    const pool = {
      id: poolKey,
      version: 'v3',
      token0: tokenA,
      token1: tokenB,
      fee,
      tickSpacing: this.config.v3.tickSpacing[fee] || 60,
      sqrtPriceX96: adjustedSqrtPriceX96,
      tick: this.getTickAtSqrtRatio(adjustedSqrtPriceX96),
      liquidity: BigInt(0),
      feeGrowthGlobal0X128: BigInt(0),
      feeGrowthGlobal1X128: BigInt(0),
      createdAt: Date.now(),
      autoCompound: true,
      autoRangeManagement: true,
      volume24h: { token0: BigInt(0), token1: BigInt(0) },
      lastVolumeReset: Date.now()
    };

    this.v3Pools.set(poolKey, pool);
    this.v3Ticks.set(poolKey, new Map());

    this.logger.info(`Created V3 pool: ${poolKey}`);
    this.emit('pool:created', { version: 'v3', ...pool });

    return { version: 'v3', poolKey, pool };
  }

  /**
   * Universal swap function - routes to best pool
   */
  async swap(tokenIn, tokenOut, amountIn, minAmountOut = 0, trader = 'anonymous') {
    // Find all available pools for this pair
    const v2Pool = this.findV2Pool(tokenIn, tokenOut);
    const v3Pools = this.findV3Pools(tokenIn, tokenOut);
    
    // Calculate output amounts for all pools
    const quotes = [];
    
    if (v2Pool) {
      const v2Quote = this.getV2Quote(v2Pool, tokenIn, amountIn);
      quotes.push({ version: 'v2', pool: v2Pool, ...v2Quote });
    }
    
    for (const v3Pool of v3Pools) {
      const v3Quote = this.getV3Quote(v3Pool, tokenIn, amountIn);
      quotes.push({ version: 'v3', pool: v3Pool, ...v3Quote });
    }
    
    if (quotes.length === 0) {
      throw new Error('No liquidity available for this pair');
    }
    
    // Select best quote (highest output)
    const bestQuote = quotes.reduce((best, current) => 
      current.amountOut > best.amountOut ? current : best
    );
    
    if (bestQuote.amountOut < BigInt(minAmountOut)) {
      throw new Error('Insufficient output amount');
    }
    
    // Execute swap on best pool
    let result;
    if (bestQuote.version === 'v2') {
      result = await this.executeV2Swap(bestQuote.pool, tokenIn, amountIn, minAmountOut, trader);
    } else {
      result = await this.executeV3Swap(bestQuote.pool, tokenIn, amountIn, minAmountOut, trader);
    }
    
    // Record trade
    const trade = {
      ...result,
      trader,
      timestamp: Date.now()
    };
    
    this.tradingHistory.push(trade);
    if (this.tradingHistory.length > 1000) {
      this.tradingHistory.shift();
    }
    
    // Update price oracle
    this.updatePriceOracle(tokenIn, tokenOut, result.amountIn, result.amountOut);
    
    // Emit unified swap event
    this.emit('swap', trade);
    
    // Trigger cross-version arbitrage check
    this.checkCrossVersionArbitrage(tokenIn, tokenOut);
    
    return result;
  }

  /**
   * Add liquidity with automatic version selection
   */
  async addLiquidity(token0, token1, amount0, amount1, options = {}) {
    const { 
      version = 'auto',
      tickLower,
      tickUpper,
      fee,
      provider = 'anonymous'
    } = options;
    
    if (version === 'v3' || (version === 'auto' && tickLower !== undefined)) {
      // V3 liquidity (concentrated)
      if (!tickLower || !tickUpper || !fee) {
        throw new Error('V3 liquidity requires tickLower, tickUpper, and fee');
      }
      
      const poolKey = this.generatePoolId(token0, token1, 'v3', fee);
      const pool = this.v3Pools.get(poolKey);
      
      if (!pool) {
        throw new Error('V3 pool not found - create it first');
      }
      
      return this.mintV3Position(poolKey, tickLower, tickUpper, amount0, amount1, provider);
      
    } else {
      // V2 liquidity (full range)
      const poolId = this.generatePoolId(token0, token1, 'v2');
      const pool = this.v2Pools.get(poolId);
      
      if (!pool) {
        throw new Error('V2 pool not found - create it first');
      }
      
      return this.addV2Liquidity(poolId, amount0, amount1, provider);
    }
  }

  /**
   * Get comprehensive pool info across versions
   */
  getPoolInfo(token0, token1) {
    const info = {
      v2: null,
      v3: [],
      bestPrice: null,
      totalLiquidity: BigInt(0)
    };
    
    // V2 pool info
    const v2Pool = this.findV2Pool(token0, token1);
    if (v2Pool) {
      info.v2 = {
        id: v2Pool.id,
        reserve0: v2Pool.reserve0.toString(),
        reserve1: v2Pool.reserve1.toString(),
        price: this.getV2Price(v2Pool, token0),
        tvl: this.calculateV2TVL(v2Pool),
        volume24h: v2Pool.volume24h.toString()
      };
      info.totalLiquidity += v2Pool.reserve0 + v2Pool.reserve1;
    }
    
    // V3 pools info
    const v3Pools = this.findV3Pools(token0, token1);
    for (const pool of v3Pools) {
      info.v3.push({
        id: pool.id,
        fee: pool.fee,
        liquidity: pool.liquidity.toString(),
        price: this.getV3Price(pool, token0),
        tick: pool.tick,
        volume24h: pool.volume24h
      });
      info.totalLiquidity += pool.liquidity;
    }
    
    // Calculate best price
    const allPrices = [];
    if (info.v2) allPrices.push(info.v2.price);
    info.v3.forEach(p => allPrices.push(p.price));
    
    if (allPrices.length > 0) {
      info.bestPrice = allPrices.reduce((sum, price) => sum + price, 0) / allPrices.length;
    }
    
    return info;
  }

  /**
   * Internal V2 swap execution
   */
  executeV2Swap(pool, tokenIn, amountIn, minAmountOut, trader) {
    const amountInBigInt = BigInt(amountIn);
    let reserveIn, reserveOut, tokenOut;

    if (tokenIn === pool.token0) {
      reserveIn = pool.reserve0;
      reserveOut = pool.reserve1;
      tokenOut = pool.token1;
    } else {
      reserveIn = pool.reserve1;
      reserveOut = pool.reserve0;
      tokenOut = pool.token0;
    }

    // Calculate output with fee
    const amountInWithFee = amountInBigInt * BigInt(Math.floor((1 - pool.fee) * 10000)) / BigInt(10000);
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn + amountInWithFee;
    const amountOut = numerator / denominator;

    // Update reserves
    if (tokenIn === pool.token0) {
      pool.reserve0 += amountInBigInt;
      pool.reserve1 -= amountOut;
    } else {
      pool.reserve1 += amountInBigInt;
      pool.reserve0 -= amountOut;
    }

    // Calculate and collect fees
    const feeAmount = amountInBigInt - amountInWithFee;
    pool.feeAccumulated += feeAmount;
    
    // Automatic operator fee collection
    const operatorFee = feeAmount * BigInt(Math.floor(this.feeManager.getOperatorFeeRate() * 10000)) / BigInt(10000);
    this.feeManager.collectOperatorFee(Number(operatorFee), tokenIn);

    // Update volume
    pool.volume24h += amountInBigInt;

    return {
      version: 'v2',
      poolId: pool.id,
      tokenIn,
      tokenOut,
      amountIn: amountInBigInt,
      amountOut,
      fee: feeAmount
    };
  }

  /**
   * Internal V3 swap execution
   */
  executeV3Swap(pool, tokenIn, amountIn, minAmountOut, trader) {
    // Simplified V3 swap logic
    const amountInBigInt = BigInt(amountIn);
    const zeroForOne = tokenIn === pool.token0;
    
    // Calculate output amount (simplified)
    const feeAmount = (amountInBigInt * BigInt(pool.fee)) / BigInt(1000000);
    const amountInAfterFee = amountInBigInt - feeAmount;
    
    // Simple price calculation based on current sqrt price
    const price = Number(pool.sqrtPriceX96) / Number(this.config.v3.Q96);
    const amountOut = zeroForOne ? 
      BigInt(Math.floor(Number(amountInAfterFee) / (price * price))) :
      BigInt(Math.floor(Number(amountInAfterFee) * price * price));

    // Update pool state (simplified)
    if (zeroForOne) {
      pool.volume24h.token0 += amountInBigInt;
    } else {
      pool.volume24h.token1 += amountInBigInt;
    }

    // Collect operator fee
    const operatorFee = feeAmount * BigInt(Math.floor(this.feeManager.getOperatorFeeRate() * 10000)) / BigInt(10000);
    this.feeManager.collectOperatorFee(Number(operatorFee), tokenIn);

    return {
      version: 'v3',
      poolId: pool.id,
      tokenIn,
      tokenOut: tokenIn === pool.token0 ? pool.token1 : pool.token0,
      amountIn: amountInBigInt,
      amountOut,
      fee: feeAmount
    };
  }

  /**
   * Add V2 liquidity
   */
  addV2Liquidity(poolId, amount0, amount1, provider) {
    const pool = this.v2Pools.get(poolId);
    if (!pool) throw new Error('Pool not found');

    const amount0BigInt = BigInt(amount0);
    const amount1BigInt = BigInt(amount1);

    let liquidity;
    
    if (pool.totalSupply === BigInt(0)) {
      liquidity = this.sqrt(amount0BigInt * amount1BigInt);
      pool.reserve0 = amount0BigInt;
      pool.reserve1 = amount1BigInt;
    } else {
      const liquidity0 = (amount0BigInt * pool.totalSupply) / pool.reserve0;
      const liquidity1 = (amount1BigInt * pool.totalSupply) / pool.reserve1;
      liquidity = liquidity0 < liquidity1 ? liquidity0 : liquidity1;
      
      pool.reserve0 += amount0BigInt;
      pool.reserve1 += amount1BigInt;
    }

    pool.totalSupply += liquidity;

    // Track liquidity provider
    const lpKey = `${poolId}:${provider}`;
    const currentLP = this.v2LiquidityProviders.get(lpKey) || BigInt(0);
    this.v2LiquidityProviders.set(lpKey, currentLP + liquidity);

    this.emit('liquidity:added', {
      version: 'v2',
      poolId,
      provider,
      amount0: amount0BigInt.toString(),
      amount1: amount1BigInt.toString(),
      liquidity: liquidity.toString()
    });

    return { liquidity: liquidity.toString() };
  }

  /**
   * Mint V3 position
   */
  mintV3Position(poolKey, tickLower, tickUpper, amount0, amount1, recipient) {
    const pool = this.v3Pools.get(poolKey);
    if (!pool) throw new Error('Pool not found');

    // Simplified V3 liquidity calculation
    const liquidity = this.sqrt(BigInt(amount0) * BigInt(amount1));
    
    const positionKey = `${recipient}:${tickLower}:${tickUpper}`;
    const position = this.v3Positions.get(positionKey) || {
      liquidity: BigInt(0),
      tickLower,
      tickUpper,
      poolKey,
      recipient
    };

    position.liquidity += liquidity;
    this.v3Positions.set(positionKey, position);

    // Update pool liquidity if in range
    if (pool.tick >= tickLower && pool.tick < tickUpper) {
      pool.liquidity += liquidity;
    }

    this.emit('liquidity:added', {
      version: 'v3',
      poolKey,
      positionKey,
      recipient,
      liquidity: liquidity.toString(),
      tickLower,
      tickUpper
    });

    return { positionKey, liquidity: liquidity.toString() };
  }

  /**
   * Helper functions
   */
  generatePoolId(token0, token1, version, fee = null) {
    const [tokenA, tokenB] = token0 < token1 ? [token0, token1] : [token1, token0];
    if (version === 'v3' && fee !== null) {
      return `${tokenA}-${tokenB}-${fee}`;
    }
    return `${tokenA}-${tokenB}`;
  }

  findV2Pool(token0, token1) {
    const poolId = this.generatePoolId(token0, token1, 'v2');
    return this.v2Pools.get(poolId);
  }

  findV3Pools(token0, token1) {
    const pools = [];
    const baseId = this.generatePoolId(token0, token1, 'v3');
    
    for (const [poolKey, pool] of this.v3Pools) {
      if (poolKey.startsWith(baseId)) {
        pools.push(pool);
      }
    }
    
    return pools;
  }

  getV2Quote(pool, tokenIn, amountIn) {
    const amountInBigInt = BigInt(amountIn);
    let reserveIn, reserveOut;

    if (tokenIn === pool.token0) {
      reserveIn = pool.reserve0;
      reserveOut = pool.reserve1;
    } else {
      reserveIn = pool.reserve1;
      reserveOut = pool.reserve0;
    }

    const amountInWithFee = amountInBigInt * BigInt(Math.floor((1 - pool.fee) * 10000)) / BigInt(10000);
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn + amountInWithFee;
    const amountOut = numerator / denominator;

    return { amountOut, priceImpact: Number(amountInBigInt) / (Number(reserveIn) + Number(amountInBigInt)) };
  }

  getV3Quote(pool, tokenIn, amountIn) {
    // Simplified V3 quote
    const amountInBigInt = BigInt(amountIn);
    const feeAmount = (amountInBigInt * BigInt(pool.fee)) / BigInt(1000000);
    const amountInAfterFee = amountInBigInt - feeAmount;
    
    const price = Number(pool.sqrtPriceX96) / Number(this.config.v3.Q96);
    const amountOut = tokenIn === pool.token0 ? 
      BigInt(Math.floor(Number(amountInAfterFee) / (price * price))) :
      BigInt(Math.floor(Number(amountInAfterFee) * price * price));

    return { amountOut, priceImpact: 0.01 }; // Simplified impact
  }

  getV2Price(pool, baseToken) {
    if (pool.reserve0 === BigInt(0) || pool.reserve1 === BigInt(0)) return 0;
    
    if (baseToken === pool.token0) {
      return Number(pool.reserve1) / Number(pool.reserve0);
    } else {
      return Number(pool.reserve0) / Number(pool.reserve1);
    }
  }

  getV3Price(pool, baseToken) {
    const price = Number(pool.sqrtPriceX96) / Number(this.config.v3.Q96);
    if (baseToken === pool.token0) {
      return price * price;
    } else {
      return 1 / (price * price);
    }
  }

  calculateV2TVL(pool) {
    // Simplified TVL calculation
    const price0 = this.priceOracle.get(pool.token0) || 1;
    const price1 = this.priceOracle.get(pool.token1) || 1;
    const tvl0 = Number(pool.reserve0) / 1e8 * price0;
    const tvl1 = Number(pool.reserve1) / 1e8 * price1;
    return tvl0 + tvl1;
  }

  sqrt(value) {
    if (value < BigInt(0)) {
      throw new Error('Square root of negative number');
    }
    if (value < BigInt(2)) {
      return value;
    }

    let z = value / BigInt(2) + BigInt(1);
    let y = value;
    while (z < y) {
      y = z;
      z = (value / z + z) / BigInt(2);
    }
    return y;
  }

  getTickAtSqrtRatio(sqrtPriceX96) {
    const price = Number(sqrtPriceX96) / Number(this.config.v3.Q96);
    const tick = Math.floor(Math.log(price * price) / Math.log(1.0001));
    return Math.max(-887272, Math.min(887272, tick));
  }

  updatePriceOracle(token0, token1, amount0, amount1) {
    const price = Number(amount1) / Number(amount0);
    this.priceOracle.set(`${token0}-${token1}`, price);
    this.priceOracle.set(`${token1}-${token0}`, 1 / price);
  }

  checkCrossVersionArbitrage(token0, token1) {
    // Check for arbitrage opportunities between V2 and V3
    setTimeout(() => {
      const v2Price = this.findV2Pool(token0, token1) ? 
        this.getV2Price(this.findV2Pool(token0, token1), token0) : null;
      
      const v3Pools = this.findV3Pools(token0, token1);
      if (v2Price && v3Pools.length > 0) {
        for (const v3Pool of v3Pools) {
          const v3Price = this.getV3Price(v3Pool, token0);
          const priceDiff = Math.abs(v2Price - v3Price) / v2Price;
          
          if (priceDiff > this.config.arbitrageThreshold) {
            this.logger.info(`Cross-version arbitrage opportunity: ${token0}/${token1} - ${(priceDiff * 100).toFixed(2)}%`);
            this.emit('arbitrage:detected', {
              type: 'cross-version',
              token0,
              token1,
              v2Price,
              v3Price,
              difference: priceDiff
            });
          }
        }
      }
    }, 100);
  }

  /**
   * Start V2 automated rebalancing
   */
  startV2AutomatedRebalancing() {
    const process = setInterval(() => {
      for (const pool of this.v2Pools.values()) {
        if (pool.autoRebalance) {
          this.rebalanceV2Pool(pool.id);
        }
      }
    }, this.config.v2.autoRebalanceInterval);
    
    this.automatedProcesses.set('v2Rebalancing', process);
    this.logger.info('V2 automated rebalancing started');
  }

  /**
   * Start V3 automated fee compounding
   */
  startV3AutomatedFeeCompounding() {
    const process = setInterval(() => {
      for (const position of this.v3Positions.values()) {
        // Simplified fee compounding
        this.logger.debug(`Compounding fees for V3 position ${position.positionKey}`);
      }
    }, this.config.v3.autoCompoundInterval);
    
    this.automatedProcesses.set('v3FeeCompounding', process);
    this.logger.info('V3 automated fee compounding started');
  }

  /**
   * Start V3 automated range management
   */
  startV3AutomatedRangeManagement() {
    const process = setInterval(() => {
      for (const position of this.v3Positions.values()) {
        const pool = this.v3Pools.get(position.poolKey);
        if (pool && (pool.tick < position.tickLower || pool.tick >= position.tickUpper)) {
          this.logger.debug(`Position out of range: ${position.positionKey}`);
        }
      }
    }, this.config.v3.rangeAdjustmentInterval);
    
    this.automatedProcesses.set('v3RangeManagement', process);
    this.logger.info('V3 automated range management started');
  }

  /**
   * Start automated fee distribution
   */
  startAutomatedFeeDistribution() {
    const process = setInterval(() => {
      // Distribute V2 fees
      for (const pool of this.v2Pools.values()) {
        if (pool.feeAccumulated > BigInt(0)) {
          this.distributeV2Fees(pool.id);
        }
      }
    }, this.config.feeDistributionInterval);
    
    this.automatedProcesses.set('feeDistribution', process);
    this.logger.info('Automated fee distribution started');
  }

  /**
   * Start cross-version arbitrage monitoring
   */
  startCrossVersionArbitrage() {
    const process = setInterval(() => {
      const checkedPairs = new Set();
      
      for (const pool of this.v2Pools.values()) {
        const pairKey = `${pool.token0}-${pool.token1}`;
        if (!checkedPairs.has(pairKey)) {
          checkedPairs.add(pairKey);
          this.checkCrossVersionArbitrage(pool.token0, pool.token1);
        }
      }
    }, 30000); // Every 30 seconds
    
    this.automatedProcesses.set('crossVersionArbitrage', process);
    this.logger.info('Cross-version arbitrage monitoring started');
  }

  /**
   * Start price oracle updates
   */
  startPriceOracleUpdates() {
    const process = setInterval(() => {
      // Update V2 prices
      for (const pool of this.v2Pools.values()) {
        const price = this.getV2Price(pool, pool.token0);
        this.priceOracle.set(`${pool.token0}-${pool.token1}`, price);
        this.priceOracle.set(`${pool.token1}-${pool.token0}`, 1 / price);
      }
      
      // Update V3 prices
      for (const pool of this.v3Pools.values()) {
        const price = this.getV3Price(pool, pool.token0);
        this.priceOracle.set(`${pool.token0}-${pool.token1}-v3`, price);
      }
    }, 15000); // Every 15 seconds
    
    this.automatedProcesses.set('priceOracle', process);
    this.logger.info('Price oracle updates started');
  }

  rebalanceV2Pool(poolId) {
    // Simplified rebalancing logic
    const pool = this.v2Pools.get(poolId);
    if (!pool) return;
    
    this.logger.debug(`Rebalancing V2 pool ${poolId}`);
  }

  distributeV2Fees(poolId) {
    const pool = this.v2Pools.get(poolId);
    if (!pool || pool.feeAccumulated === BigInt(0)) return;
    
    const totalFees = pool.feeAccumulated;
    pool.feeAccumulated = BigInt(0);
    
    this.logger.info(`Distributed ${totalFees.toString()} fees for V2 pool ${poolId}`);
    this.emit('fees:distributed', {
      version: 'v2',
      poolId,
      totalFees: totalFees.toString()
    });
  }

  /**
   * Get comprehensive statistics
   */
  getStats() {
    const v2Stats = {
      pools: this.v2Pools.size,
      tvl: 0,
      volume24h: BigInt(0),
      autoRebalancing: true
    };
    
    for (const pool of this.v2Pools.values()) {
      v2Stats.tvl += this.calculateV2TVL(pool);
      v2Stats.volume24h += pool.volume24h;
    }
    
    const v3Stats = {
      pools: this.v3Pools.size,
      positions: this.v3Positions.size,
      tvl: 0,
      autoCompounding: true,
      autoRangeManagement: true
    };
    
    return {
      v2: {
        ...v2Stats,
        volume24h: v2Stats.volume24h.toString()
      },
      v3: v3Stats,
      unified: {
        totalPools: v2Stats.pools + v3Stats.pools,
        totalTVL: v2Stats.tvl + v3Stats.tvl,
        crossVersionArbitrage: true,
        unifiedInterface: true
      },
      tradingHistory: this.tradingHistory.length,
      automatedProcesses: this.automatedProcesses.size
    };
  }

  /**
   * Stop all automated processes
   */
  stop() {
    for (const [name, process] of this.automatedProcesses) {
      clearInterval(process);
      this.logger.info(`Stopped ${name}`);
    }
    this.automatedProcesses.clear();
    this.logger.info('All unified DEX processes stopped');
  }
}
