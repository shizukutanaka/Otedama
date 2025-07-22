import EventEmitter from 'events';
import crypto from 'crypto';

const PoolType = {
  CONCENTRATED: 'concentrated',
  FULL_RANGE: 'full_range',
  RANGE_ORDER: 'range_order'
};

const PositionStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  OUT_OF_RANGE: 'out_of_range',
  COLLECTING_FEES: 'collecting_fees'
};

const TickSpacing = {
  LOW: 10,      // 0.01% fee
  MEDIUM: 60,   // 0.05% fee
  HIGH: 200     // 0.3% fee
};

const FeeAmount = {
  LOWEST: 100,   // 0.01%
  LOW: 500,      // 0.05%
  MEDIUM: 3000,  // 0.3%
  HIGH: 10000    // 1%
};

export class AMMv3Protocol extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableConcentratedLiquidity: options.enableConcentratedLiquidity !== false,
      enableMultipleFees: options.enableMultipleFees !== false,
      enableRangeOrders: options.enableRangeOrders !== false,
      enableOracleIntegration: options.enableOracleIntegration !== false,
      enableAutoCompound: options.enableAutoCompound !== false,
      maxTickRange: options.maxTickRange || 887272, // Full range
      minTickSpacing: options.minTickSpacing || 1,
      maxLeverage: options.maxLeverage || 10,
      protocolFeeRatio: options.protocolFeeRatio || 0.05, // 5% of LP fees
      rebalanceThreshold: options.rebalanceThreshold || 0.02 // 2%
    };

    this.pools = new Map();
    this.positions = new Map();
    this.ticks = new Map();
    this.oracles = new Map();
    this.fees = new Map();
    
    this.isRunning = false;
    this.metrics = {
      totalPools: 0,
      totalLiquidity: 0,
      totalVolume: 0,
      totalFees: 0,
      activePositions: 0,
      impermanentLoss: 0,
      rebalances: 0
    };

    this.initializeTickMath();
    this.startPriceOracle();
    this.startRebalancing();
  }

  initializeTickMath() {
    // Tick to price conversion: price = 1.0001^tick
    this.tickToPrice = (tick) => Math.pow(1.0001, tick);
    this.priceToTick = (price) => Math.log(price) / Math.log(1.0001);
    
    // Square root price calculations
    this.getSqrtRatioAtTick = (tick) => {
      return Math.sqrt(this.tickToPrice(tick)) * Math.pow(2, 96);
    };
    
    this.getTickAtSqrtRatio = (sqrtPriceX96) => {
      const price = Math.pow(sqrtPriceX96 / Math.pow(2, 96), 2);
      return this.priceToTick(price);
    };
  }

  async createPool(tokenA, tokenB, fee, initialPrice, options = {}) {
    try {
      const poolId = this.generatePoolId(tokenA, tokenB, fee);
      
      if (this.pools.has(poolId)) {
        throw new Error('Pool already exists');
      }

      const tickSpacing = this.getTickSpacing(fee);
      const initialTick = Math.round(this.priceToTick(initialPrice) / tickSpacing) * tickSpacing;
      
      const pool = {
        id: poolId,
        tokenA,
        tokenB,
        fee,
        tickSpacing,
        sqrtPriceX96: this.getSqrtRatioAtTick(initialTick),
        tick: initialTick,
        observationIndex: 0,
        observationCardinality: 1,
        observationCardinalityNext: 1,
        feeProtocol: 0,
        unlocked: true,
        liquidity: 0,
        totalSupply: 0,
        token0Balance: 0,
        token1Balance: 0,
        volume24h: 0,
        fees24h: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      this.pools.set(poolId, pool);
      this.initializePoolTicks(poolId);
      this.initializePoolOracle(poolId, initialPrice);
      
      this.metrics.totalPools++;
      this.emit('poolCreated', pool);
      
      return poolId;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  initializePoolTicks(poolId) {
    const tickMap = new Map();
    
    // Initialize tick at current price
    const pool = this.pools.get(poolId);
    if (pool) {
      tickMap.set(pool.tick, {
        liquidityGross: 0,
        liquidityNet: 0,
        feeGrowthOutside0X128: 0,
        feeGrowthOutside1X128: 0,
        tickCumulativeOutside: 0,
        secondsPerLiquidityOutsideX128: 0,
        secondsOutside: 0,
        initialized: false
      });
    }
    
    this.ticks.set(poolId, tickMap);
  }

  initializePoolOracle(poolId, initialPrice) {
    const observations = [{
      blockTimestamp: Math.floor(Date.now() / 1000),
      tickCumulative: 0,
      secondsPerLiquidityCumulativeX128: 0,
      initialized: true
    }];
    
    this.oracles.set(poolId, observations);
  }

  getTickSpacing(fee) {
    switch (fee) {
      case FeeAmount.LOWEST: return TickSpacing.LOW;
      case FeeAmount.LOW: return TickSpacing.LOW;
      case FeeAmount.MEDIUM: return TickSpacing.MEDIUM;
      case FeeAmount.HIGH: return TickSpacing.HIGH;
      default: return TickSpacing.MEDIUM;
    }
  }

  async mint(poolId, recipient, tickLower, tickUpper, amount, options = {}) {
    try {
      const pool = this.pools.get(poolId);
      if (!pool) {
        throw new Error('Pool not found');
      }

      this.validateTickRange(tickLower, tickUpper, pool.tickSpacing);
      
      const positionId = this.generatePositionId(poolId, recipient, tickLower, tickUpper);
      
      const { amount0, amount1 } = await this.calculateTokenAmounts(
        pool, tickLower, tickUpper, amount
      );

      const position = {
        id: positionId,
        poolId,
        owner: recipient,
        tickLower,
        tickUpper,
        liquidity: amount,
        amount0,
        amount1,
        feeGrowthInside0LastX128: 0,
        feeGrowthInside1LastX128: 0,
        tokensOwed0: 0,
        tokensOwed1: 0,
        status: this.getPositionStatus(pool.tick, tickLower, tickUpper),
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      this.positions.set(positionId, position);
      
      // Update pool state
      await this.updatePoolOnMint(pool, tickLower, tickUpper, amount);
      
      // Update ticks
      await this.updateTick(poolId, tickLower, amount, false);
      await this.updateTick(poolId, tickUpper, amount, true);
      
      this.metrics.activePositions++;
      this.metrics.totalLiquidity += amount;
      
      this.emit('positionMinted', position);
      
      return positionId;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async burn(positionId, amount, options = {}) {
    try {
      const position = this.positions.get(positionId);
      if (!position) {
        throw new Error('Position not found');
      }

      const pool = this.pools.get(position.poolId);
      if (!pool) {
        throw new Error('Pool not found');
      }

      if (amount > position.liquidity) {
        throw new Error('Insufficient liquidity');
      }

      const { amount0, amount1 } = await this.calculateTokenAmounts(
        pool, position.tickLower, position.tickUpper, amount
      );

      // Update position
      position.liquidity -= amount;
      position.amount0 -= amount0;
      position.amount1 -= amount1;
      position.updatedAt = Date.now();

      if (position.liquidity === 0) {
        position.status = PositionStatus.INACTIVE;
        this.metrics.activePositions--;
      }

      // Update pool state
      await this.updatePoolOnBurn(pool, position.tickLower, position.tickUpper, amount);
      
      // Update ticks
      await this.updateTick(position.poolId, position.tickLower, -amount, false);
      await this.updateTick(position.poolId, position.tickUpper, -amount, true);
      
      this.metrics.totalLiquidity -= amount;
      
      this.emit('positionBurned', { positionId, amount, amount0, amount1 });
      
      return { amount0, amount1 };
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async swap(poolId, tokenIn, amountIn, recipient, sqrtPriceLimitX96, options = {}) {
    try {
      const pool = this.pools.get(poolId);
      if (!pool) {
        throw new Error('Pool not found');
      }

      const zeroForOne = tokenIn === pool.tokenA;
      const exactInput = options.exactInput !== false;

      const swapResult = await this.executeSwap(
        pool,
        zeroForOne,
        amountIn,
        sqrtPriceLimitX96,
        exactInput
      );

      // Update pool state
      pool.sqrtPriceX96 = swapResult.sqrtPriceX96;
      pool.tick = swapResult.tick;
      pool.liquidity = swapResult.liquidity;
      pool.updatedAt = Date.now();

      // Update volume and fees
      const swapFee = Math.floor(amountIn * pool.fee / 1000000);
      pool.volume24h += amountIn;
      pool.fees24h += swapFee;
      
      this.metrics.totalVolume += amountIn;
      this.metrics.totalFees += swapFee;

      // Update oracle
      await this.updateOracle(poolId, pool.tick);

      // Distribute fees to LPs
      await this.distributeFees(poolId, swapFee, zeroForOne);

      this.emit('swapExecuted', {
        poolId,
        tokenIn,
        tokenOut: zeroForOne ? pool.tokenB : pool.tokenA,
        amountIn,
        amountOut: swapResult.amountOut,
        recipient,
        price: this.tickToPrice(swapResult.tick)
      });

      return swapResult;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async executeSwap(pool, zeroForOne, amountSpecified, sqrtPriceLimitX96, exactInput) {
    const state = {
      amountSpecifiedRemaining: amountSpecified,
      amountCalculated: 0,
      sqrtPriceX96: pool.sqrtPriceX96,
      tick: pool.tick,
      feeGrowthGlobalX128: 0,
      protocolFee: 0,
      liquidity: pool.liquidity
    };

    const stepComputations = [];

    while (state.amountSpecifiedRemaining !== 0 && state.sqrtPriceX96 !== sqrtPriceLimitX96) {
      const step = {
        sqrtPriceStartX96: state.sqrtPriceX96,
        tickNext: 0,
        initialized: false,
        sqrtPriceNextX96: 0,
        amountIn: 0,
        amountOut: 0,
        feeAmount: 0
      };

      // Find next initialized tick
      step.tickNext = this.nextInitializedTick(pool.id, state.tick, zeroForOne);
      step.initialized = this.isTickInitialized(pool.id, step.tickNext);

      if (step.tickNext < -887272) step.tickNext = -887272;
      else if (step.tickNext > 887272) step.tickNext = 887272;

      step.sqrtPriceNextX96 = this.getSqrtRatioAtTick(step.tickNext);

      const { sqrtRatioTargetX96, amountIn, amountOut, feeAmount } = 
        this.computeSwapStep(
          state.sqrtPriceX96,
          (zeroForOne ? step.sqrtPriceNextX96 < sqrtPriceLimitX96 : step.sqrtPriceNextX96 > sqrtPriceLimitX96)
            ? sqrtPriceLimitX96
            : step.sqrtPriceNextX96,
          state.liquidity,
          state.amountSpecifiedRemaining,
          pool.fee
        );

      step.amountIn = amountIn;
      step.amountOut = amountOut;
      step.feeAmount = feeAmount;

      if (exactInput) {
        state.amountSpecifiedRemaining -= (amountIn + feeAmount);
        state.amountCalculated -= amountOut;
      } else {
        state.amountSpecifiedRemaining += amountOut;
        state.amountCalculated += (amountIn + feeAmount);
      }

      if (state.liquidity > 0) {
        state.feeGrowthGlobalX128 += feeAmount * Math.pow(2, 128) / state.liquidity;
      }

      if (sqrtRatioTargetX96 === step.sqrtPriceNextX96) {
        if (step.initialized) {
          const liquidityNet = this.getTickLiquidityNet(pool.id, step.tickNext);
          
          if (zeroForOne) {
            state.liquidity -= liquidityNet;
          } else {
            state.liquidity += liquidityNet;
          }
        }

        state.tick = zeroForOne ? step.tickNext - 1 : step.tickNext;
      } else {
        state.tick = this.getTickAtSqrtRatio(sqrtRatioTargetX96);
      }

      state.sqrtPriceX96 = sqrtRatioTargetX96;
      stepComputations.push(step);
    }

    return {
      amountIn: exactInput ? amountSpecified - state.amountSpecifiedRemaining : state.amountCalculated,
      amountOut: exactInput ? -state.amountCalculated : -state.amountSpecifiedRemaining,
      sqrtPriceX96: state.sqrtPriceX96,
      liquidity: state.liquidity,
      tick: state.tick
    };
  }

  computeSwapStep(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, amountRemaining, fee) {
    const zeroForOne = sqrtRatioCurrentX96 >= sqrtRatioTargetX96;
    const exactIn = amountRemaining >= 0;

    let sqrtRatioNextX96;
    let amountIn = 0;
    let amountOut = 0;

    if (exactIn) {
      const amountRemainingLessFee = Math.floor(amountRemaining * (1000000 - fee) / 1000000);
      amountIn = zeroForOne
        ? this.getAmount0Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, true)
        : this.getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, true);
      
      if (amountRemainingLessFee >= amountIn) {
        sqrtRatioNextX96 = sqrtRatioTargetX96;
      } else {
        sqrtRatioNextX96 = this.getNextSqrtPriceFromInput(
          sqrtRatioCurrentX96,
          liquidity,
          amountRemainingLessFee,
          zeroForOne
        );
      }
    } else {
      amountOut = zeroForOne
        ? this.getAmount1Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, false)
        : this.getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, false);
      
      if (-amountRemaining >= amountOut) {
        sqrtRatioNextX96 = sqrtRatioTargetX96;
      } else {
        sqrtRatioNextX96 = this.getNextSqrtPriceFromOutput(
          sqrtRatioCurrentX96,
          liquidity,
          -amountRemaining,
          zeroForOne
        );
      }
    }

    const max = sqrtRatioTargetX96 === sqrtRatioNextX96;

    if (zeroForOne) {
      amountIn = max && exactIn
        ? amountIn
        : this.getAmount0Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, true);
      amountOut = max && !exactIn
        ? amountOut
        : this.getAmount1Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, false);
    } else {
      amountIn = max && exactIn
        ? amountIn
        : this.getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, true);
      amountOut = max && !exactIn
        ? amountOut
        : this.getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, false);
    }

    if (!exactIn && amountOut > -amountRemaining) {
      amountOut = -amountRemaining;
    }

    let feeAmount;
    if (exactIn && sqrtRatioNextX96 !== sqrtRatioTargetX96) {
      feeAmount = amountRemaining - amountIn;
    } else {
      feeAmount = Math.ceil(amountIn * fee / (1000000 - fee));
    }

    return {
      sqrtRatioTargetX96: sqrtRatioNextX96,
      amountIn,
      amountOut,
      feeAmount
    };
  }

  getAmount0Delta(sqrtRatioAX96, sqrtRatioBX96, liquidity, roundUp) {
    if (sqrtRatioAX96 > sqrtRatioBX96) {
      [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
    }

    const numerator1 = liquidity * Math.pow(2, 96);
    const numerator2 = sqrtRatioBX96 - sqrtRatioAX96;

    if (roundUp) {
      return Math.ceil(numerator1 * numerator2 / sqrtRatioBX96 / sqrtRatioAX96);
    } else {
      return Math.floor(numerator1 * numerator2 / sqrtRatioBX96 / sqrtRatioAX96);
    }
  }

  getAmount1Delta(sqrtRatioAX96, sqrtRatioBX96, liquidity, roundUp) {
    if (sqrtRatioAX96 > sqrtRatioBX96) {
      [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
    }

    if (roundUp) {
      return Math.ceil(liquidity * (sqrtRatioBX96 - sqrtRatioAX96) / Math.pow(2, 96));
    } else {
      return Math.floor(liquidity * (sqrtRatioBX96 - sqrtRatioAX96) / Math.pow(2, 96));
    }
  }

  getNextSqrtPriceFromInput(sqrtPX96, liquidity, amountIn, zeroForOne) {
    if (zeroForOne) {
      return this.getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountIn, true);
    } else {
      return this.getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountIn, true);
    }
  }

  getNextSqrtPriceFromOutput(sqrtPX96, liquidity, amountOut, zeroForOne) {
    if (zeroForOne) {
      return this.getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountOut, false);
    } else {
      return this.getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountOut, false);
    }
  }

  getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amount, add) {
    if (amount === 0) return sqrtPX96;

    const numerator1 = liquidity * Math.pow(2, 96);

    if (add) {
      const product = amount * sqrtPX96;
      if (product / amount === sqrtPX96) {
        const denominator = numerator1 + product;
        if (denominator >= numerator1) {
          return Math.ceil(numerator1 / denominator * sqrtPX96);
        }
      }
      return Math.ceil(numerator1 / (numerator1 / sqrtPX96 + amount));
    } else {
      const product = amount * sqrtPX96;
      const denominator = numerator1 - product;
      return Math.ceil(numerator1 / denominator * sqrtPX96);
    }
  }

  getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amount, add) {
    if (add) {
      const quotient = amount * Math.pow(2, 96) / liquidity;
      return sqrtPX96 + quotient;
    } else {
      const quotient = amount * Math.pow(2, 96) / liquidity;
      return sqrtPX96 - quotient;
    }
  }

  async calculateTokenAmounts(pool, tickLower, tickUpper, liquidity) {
    const sqrtRatioA = this.getSqrtRatioAtTick(tickLower);
    const sqrtRatioB = this.getSqrtRatioAtTick(tickUpper);
    const sqrtRatio = pool.sqrtPriceX96;

    let amount0 = 0;
    let amount1 = 0;

    if (sqrtRatio <= sqrtRatioA) {
      amount0 = this.getAmount0Delta(sqrtRatioA, sqrtRatioB, liquidity, true);
    } else if (sqrtRatio < sqrtRatioB) {
      amount0 = this.getAmount0Delta(sqrtRatio, sqrtRatioB, liquidity, true);
      amount1 = this.getAmount1Delta(sqrtRatioA, sqrtRatio, liquidity, true);
    } else {
      amount1 = this.getAmount1Delta(sqrtRatioA, sqrtRatioB, liquidity, true);
    }

    return { amount0, amount1 };
  }

  validateTickRange(tickLower, tickUpper, tickSpacing) {
    if (tickLower >= tickUpper) {
      throw new Error('Invalid tick range');
    }
    
    if (tickLower < -887272 || tickUpper > 887272) {
      throw new Error('Tick out of range');
    }
    
    if (tickLower % tickSpacing !== 0 || tickUpper % tickSpacing !== 0) {
      throw new Error('Invalid tick spacing');
    }
  }

  getPositionStatus(currentTick, tickLower, tickUpper) {
    if (currentTick < tickLower || currentTick >= tickUpper) {
      return PositionStatus.OUT_OF_RANGE;
    }
    return PositionStatus.ACTIVE;
  }

  async updatePoolOnMint(pool, tickLower, tickUpper, amount) {
    if (pool.tick >= tickLower && pool.tick < tickUpper) {
      pool.liquidity += amount;
    }
  }

  async updatePoolOnBurn(pool, tickLower, tickUpper, amount) {
    if (pool.tick >= tickLower && pool.tick < tickUpper) {
      pool.liquidity -= amount;
    }
  }

  async updateTick(poolId, tick, liquidityDelta, upper) {
    const ticks = this.ticks.get(poolId);
    if (!ticks) return;

    let tickInfo = ticks.get(tick);
    if (!tickInfo) {
      tickInfo = {
        liquidityGross: 0,
        liquidityNet: 0,
        feeGrowthOutside0X128: 0,
        feeGrowthOutside1X128: 0,
        tickCumulativeOutside: 0,
        secondsPerLiquidityOutsideX128: 0,
        secondsOutside: 0,
        initialized: false
      };
      ticks.set(tick, tickInfo);
    }

    const liquidityGrossBefore = tickInfo.liquidityGross;
    const liquidityGrossAfter = liquidityGrossBefore + Math.abs(liquidityDelta);

    tickInfo.liquidityGross = liquidityGrossAfter;

    if (upper) {
      tickInfo.liquidityNet -= liquidityDelta;
    } else {
      tickInfo.liquidityNet += liquidityDelta;
    }

    if (liquidityGrossBefore === 0) {
      tickInfo.initialized = true;
    }

    if (liquidityGrossAfter === 0) {
      delete tickInfo.initialized;
      ticks.delete(tick);
    }
  }

  nextInitializedTick(poolId, tick, lte) {
    const ticks = this.ticks.get(poolId);
    if (!ticks) return lte ? -887272 : 887272;

    const tickArray = Array.from(ticks.keys()).sort((a, b) => a - b);
    
    if (lte) {
      // Find largest tick <= current tick
      for (let i = tickArray.length - 1; i >= 0; i--) {
        if (tickArray[i] <= tick) {
          return tickArray[i];
        }
      }
      return -887272;
    } else {
      // Find smallest tick > current tick
      for (const t of tickArray) {
        if (t > tick) {
          return t;
        }
      }
      return 887272;
    }
  }

  isTickInitialized(poolId, tick) {
    const ticks = this.ticks.get(poolId);
    return ticks ? ticks.has(tick) : false;
  }

  getTickLiquidityNet(poolId, tick) {
    const ticks = this.ticks.get(poolId);
    const tickInfo = ticks ? ticks.get(tick) : null;
    return tickInfo ? tickInfo.liquidityNet : 0;
  }

  async distributeFees(poolId, feeAmount, zeroForOne) {
    const positions = Array.from(this.positions.values())
      .filter(pos => pos.poolId === poolId && pos.status === PositionStatus.ACTIVE);

    const totalActiveLiquidity = positions.reduce((sum, pos) => sum + pos.liquidity, 0);
    
    if (totalActiveLiquidity === 0) return;

    const protocolFee = feeAmount * this.options.protocolFeeRatio;
    const lpFee = feeAmount - protocolFee;

    for (const position of positions) {
      const feeShare = (position.liquidity / totalActiveLiquidity) * lpFee;
      
      if (zeroForOne) {
        position.tokensOwed1 += feeShare;
      } else {
        position.tokensOwed0 += feeShare;
      }
    }
  }

  async updateOracle(poolId, tick) {
    const observations = this.oracles.get(poolId);
    if (!observations) return;

    const timestamp = Math.floor(Date.now() / 1000);
    const lastObservation = observations[observations.length - 1];

    if (timestamp > lastObservation.blockTimestamp) {
      const timeDelta = timestamp - lastObservation.blockTimestamp;
      const tickCumulative = lastObservation.tickCumulative + (tick * timeDelta);

      observations.push({
        blockTimestamp: timestamp,
        tickCumulative,
        secondsPerLiquidityCumulativeX128: lastObservation.secondsPerLiquidityCumulativeX128,
        initialized: true
      });

      // Keep only recent observations
      if (observations.length > 65536) {
        observations.shift();
      }
    }
  }

  startPriceOracle() {
    if (this.priceOracleInterval) return;
    
    this.priceOracleInterval = setInterval(async () => {
      try {
        for (const [poolId, pool] of this.pools) {
          await this.updateOracle(poolId, pool.tick);
        }
      } catch (error) {
        this.emit('error', error);
      }
    }, 15000); // Update every 15 seconds
  }

  startRebalancing() {
    if (this.rebalanceInterval) return;
    
    this.rebalanceInterval = setInterval(async () => {
      try {
        await this.performAutoRebalancing();
      } catch (error) {
        this.emit('error', error);
      }
    }, 300000); // Check every 5 minutes
  }

  async performAutoRebalancing() {
    for (const [positionId, position] of this.positions) {
      if (position.status === PositionStatus.OUT_OF_RANGE && this.options.enableAutoCompound) {
        const pool = this.pools.get(position.poolId);
        if (!pool) continue;

        const currentPrice = this.tickToPrice(pool.tick);
        const lowerPrice = this.tickToPrice(position.tickLower);
        const upperPrice = this.tickToPrice(position.tickUpper);

        const priceDeviation = Math.max(
          Math.abs(currentPrice - lowerPrice) / lowerPrice,
          Math.abs(currentPrice - upperPrice) / upperPrice
        );

        if (priceDeviation > this.options.rebalanceThreshold) {
          await this.rebalancePosition(positionId);
        }
      }
    }
  }

  async rebalancePosition(positionId) {
    try {
      const position = this.positions.get(positionId);
      if (!position) return;

      const pool = this.pools.get(position.poolId);
      if (!pool) return;

      // Calculate new tick range around current price
      const currentTick = pool.tick;
      const tickSpacing = pool.tickSpacing;
      const range = 4000; // ±40% price range

      const newTickLower = Math.round((currentTick - range) / tickSpacing) * tickSpacing;
      const newTickUpper = Math.round((currentTick + range) / tickSpacing) * tickSpacing;

      // Burn old position
      const { amount0, amount1 } = await this.burn(positionId, position.liquidity);

      // Mint new position
      const newAmount = Math.sqrt(amount0 * amount1); // Geometric mean
      await this.mint(position.poolId, position.owner, newTickLower, newTickUpper, newAmount);

      this.metrics.rebalances++;
      this.emit('positionRebalanced', { positionId, newTickLower, newTickUpper });
    } catch (error) {
      this.emit('error', error);
    }
  }

  generatePoolId(tokenA, tokenB, fee) {
    const tokens = [tokenA, tokenB].sort();
    return crypto.createHash('sha256')
      .update(`${tokens[0]}-${tokens[1]}-${fee}`)
      .digest('hex')
      .substring(0, 16);
  }

  generatePositionId(poolId, owner, tickLower, tickUpper) {
    return crypto.createHash('sha256')
      .update(`${poolId}-${owner}-${tickLower}-${tickUpper}-${Date.now()}`)
      .digest('hex')
      .substring(0, 16);
  }

  async getPool(poolId) {
    return this.pools.get(poolId) || null;
  }

  async getPosition(positionId) {
    return this.positions.get(positionId) || null;
  }

  async getAllPools() {
    return Array.from(this.pools.values());
  }

  async getAllPositions(owner = null) {
    const positions = Array.from(this.positions.values());
    return owner ? positions.filter(pos => pos.owner === owner) : positions;
  }

  getMetrics() {
    return {
      ...this.metrics,
      totalPools: this.pools.size,
      totalActivePositions: Array.from(this.positions.values())
        .filter(pos => pos.status === PositionStatus.ACTIVE).length,
      averageLiquidityPerPool: this.pools.size > 0 ? this.metrics.totalLiquidity / this.pools.size : 0,
      averageVolumePerPool: this.pools.size > 0 ? this.metrics.totalVolume / this.pools.size : 0
    };
  }

  async stop() {
    this.isRunning = false;
    
    if (this.priceOracleInterval) {
      clearInterval(this.priceOracleInterval);
      this.priceOracleInterval = null;
    }
    
    if (this.rebalanceInterval) {
      clearInterval(this.rebalanceInterval);
      this.rebalanceInterval = null;
    }
    
    this.emit('stopped');
  }
}

export { PoolType, PositionStatus, TickSpacing, FeeAmount };