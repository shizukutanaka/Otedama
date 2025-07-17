/**
 * Concentrated Liquidity AMM Implementation
 * Inspired by Uniswap V3's concentrated liquidity design
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';

/**
 * Concentrated Liquidity Pool
 * Allows liquidity providers to concentrate their capital within custom price ranges
 */
export class ConcentratedLiquidityPool extends EventEmitter {
    constructor(token0, token1, config = {}) {
        super();
        
        this.token0 = token0;
        this.token1 = token1;
        
        this.config = {
            feeTiers: config.feeTiers || [100, 500, 3000, 10000], // 0.01%, 0.05%, 0.3%, 1%
            tickSpacing: config.tickSpacing || 60,
            minTick: config.minTick || -887272,
            maxTick: config.maxTick || 887272,
            protocolFee: config.protocolFee || 0, // basis points
            maxSlippage: config.maxSlippage || 500, // 5%
            ...config
        };
        
        // Pool state
        this.liquidity = 0n;
        this.sqrtPriceX96 = 0n;
        this.tick = 0;
        this.feeGrowthGlobal0X128 = 0n;
        this.feeGrowthGlobal1X128 = 0n;
        this.protocolFees0 = 0n;
        this.protocolFees1 = 0n;
        
        // Tick data structure
        this.ticks = new Map();
        this.tickBitmap = new Map();
        
        // Position management
        this.positions = new Map();
        this.nextPositionId = 1;
        
        // Performance tracking
        this.metrics = {
            totalSwaps: 0,
            totalVolume0: 0n,
            totalVolume1: 0n,
            totalFeesCollected0: 0n,
            totalFeesCollected1: 0n,
            avgGasPerSwap: 0
        };
        
        this.initialized = false;
    }

    /**
     * Initialize pool with starting price
     */
    async initialize(sqrtPriceX96) {
        if (this.initialized) {
            throw new Error('Pool already initialized');
        }
        
        this.sqrtPriceX96 = sqrtPriceX96;
        this.tick = this.getTickAtSqrtRatio(sqrtPriceX96);
        this.initialized = true;
        
        this.emit('initialized', {
            token0: this.token0,
            token1: this.token1,
            sqrtPriceX96: this.sqrtPriceX96.toString(),
            tick: this.tick
        });
        
        return true;
    }

    /**
     * Add liquidity to a specific price range
     */
    async mint(recipient, tickLower, tickUpper, amount, data = {}) {
        const startGas = performance.now();
        
        // Validate inputs
        this.validateTicks(tickLower, tickUpper);
        
        if (amount <= 0n) {
            throw new Error('Amount must be positive');
        }
        
        // Update ticks
        const amount0 = await this.updatePosition(recipient, tickLower, tickUpper, amount);
        const amount1 = this.getAmount1ForLiquidity(
            this.getSqrtRatioAtTick(tickLower),
            this.getSqrtRatioAtTick(tickUpper),
            amount
        );
        
        // Create position
        const positionId = this.nextPositionId++;
        const position = {
            id: positionId,
            owner: recipient,
            tickLower,
            tickUpper,
            liquidity: amount,
            feeGrowthInside0LastX128: this.getFeeGrowthInside(tickLower, tickUpper).feeGrowthInside0X128,
            feeGrowthInside1LastX128: this.getFeeGrowthInside(tickLower, tickUpper).feeGrowthInside1X128,
            tokensOwed0: 0n,
            tokensOwed1: 0n
        };
        
        this.positions.set(positionId, position);
        
        const gasUsed = performance.now() - startGas;
        
        this.emit('mint', {
            positionId,
            recipient,
            tickLower,
            tickUpper,
            amount: amount.toString(),
            amount0: amount0.toString(),
            amount1: amount1.toString(),
            gasUsed
        });
        
        return {
            positionId,
            amount0,
            amount1,
            liquidity: amount
        };
    }

    /**
     * Remove liquidity from a position
     */
    async burn(positionId, amount) {
        const position = this.positions.get(positionId);
        if (!position) {
            throw new Error('Position not found');
        }
        
        if (amount > position.liquidity) {
            throw new Error('Amount exceeds position liquidity');
        }
        
        // Update position
        const { amount0, amount1 } = await this.updatePosition(
            position.owner,
            position.tickLower,
            position.tickUpper,
            -amount
        );
        
        // Collect fees
        const fees = this.collectPositionFees(position);
        position.tokensOwed0 += fees.amount0;
        position.tokensOwed1 += fees.amount1;
        
        // Update position liquidity
        position.liquidity -= amount;
        
        this.emit('burn', {
            positionId,
            amount: amount.toString(),
            amount0: amount0.toString(),
            amount1: amount1.toString(),
            fees0: fees.amount0.toString(),
            fees1: fees.amount1.toString()
        });
        
        return {
            amount0: amount0 + fees.amount0,
            amount1: amount1 + fees.amount1
        };
    }

    /**
     * Swap tokens
     */
    async swap(recipient, zeroForOne, amountSpecified, sqrtPriceLimitX96, data = {}) {
        const startTime = performance.now();
        const startGas = performance.now();
        
        if (!this.initialized) {
            throw new Error('Pool not initialized');
        }
        
        // Swap state
        const state = {
            amountSpecifiedRemaining: amountSpecified,
            amountCalculated: 0n,
            sqrtPriceX96: this.sqrtPriceX96,
            tick: this.tick,
            feeGrowthGlobalX128: zeroForOne ? this.feeGrowthGlobal0X128 : this.feeGrowthGlobal1X128,
            protocolFee: 0n,
            liquidity: this.liquidity
        };
        
        // Swap until amount is exhausted or price limit reached
        while (state.amountSpecifiedRemaining !== 0n && state.sqrtPriceX96 !== sqrtPriceLimitX96) {
            const step = await this.computeSwapStep(
                state.sqrtPriceX96,
                (zeroForOne ? sqrtPriceLimitX96 < state.sqrtPriceX96 : sqrtPriceLimitX96 > state.sqrtPriceX96) 
                    ? sqrtPriceLimitX96 
                    : this.getNextSqrtPrice(state.tick, zeroForOne),
                state.liquidity,
                state.amountSpecifiedRemaining,
                this.config.feeTiers[0] // Use default fee tier
            );
            
            state.sqrtPriceX96 = step.sqrtRatioNextX96;
            state.amountSpecifiedRemaining -= step.amountIn;
            state.amountCalculated += step.amountOut;
            
            // Update fees
            if (state.liquidity > 0n) {
                const feeAmount = (step.amountIn * BigInt(this.config.feeTiers[0])) / 1000000n;
                state.feeGrowthGlobalX128 += (feeAmount << 128n) / state.liquidity;
                state.protocolFee += (feeAmount * BigInt(this.config.protocolFee)) / 10000n;
            }
            
            // Cross tick if necessary
            if (state.sqrtPriceX96 === step.sqrtRatioNextX96) {
                const nextTick = zeroForOne ? state.tick - 1 : state.tick;
                const tickData = this.ticks.get(nextTick);
                
                if (tickData) {
                    state.liquidity = zeroForOne 
                        ? state.liquidity - tickData.liquidityNet
                        : state.liquidity + tickData.liquidityNet;
                }
                
                state.tick = this.getTickAtSqrtRatio(state.sqrtPriceX96);
            }
        }
        
        // Update global state
        this.sqrtPriceX96 = state.sqrtPriceX96;
        this.tick = state.tick;
        this.liquidity = state.liquidity;
        
        if (zeroForOne) {
            this.feeGrowthGlobal0X128 = state.feeGrowthGlobalX128;
            this.protocolFees0 += state.protocolFee;
        } else {
            this.feeGrowthGlobal1X128 = state.feeGrowthGlobalX128;
            this.protocolFees1 += state.protocolFee;
        }
        
        // Update metrics
        this.metrics.totalSwaps++;
        if (zeroForOne) {
            this.metrics.totalVolume0 += amountSpecified - state.amountSpecifiedRemaining;
        } else {
            this.metrics.totalVolume1 += amountSpecified - state.amountSpecifiedRemaining;
        }
        
        const gasUsed = performance.now() - startGas;
        this.metrics.avgGasPerSwap = 
            (this.metrics.avgGasPerSwap * (this.metrics.totalSwaps - 1) + gasUsed) / 
            this.metrics.totalSwaps;
        
        const executionTime = performance.now() - startTime;
        
        this.emit('swap', {
            recipient,
            zeroForOne,
            amountIn: (amountSpecified - state.amountSpecifiedRemaining).toString(),
            amountOut: state.amountCalculated.toString(),
            sqrtPriceX96: state.sqrtPriceX96.toString(),
            tick: state.tick,
            executionTime,
            gasUsed
        });
        
        return {
            amount0: zeroForOne ? amountSpecified - state.amountSpecifiedRemaining : -state.amountCalculated,
            amount1: zeroForOne ? -state.amountCalculated : amountSpecified - state.amountSpecifiedRemaining
        };
    }

    /**
     * Compute a single swap step
     */
    async computeSwapStep(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, amountRemaining, feePips) {
        const zeroForOne = sqrtRatioTargetX96 <= sqrtRatioCurrentX96;
        const exactIn = amountRemaining >= 0n;
        
        let amountIn = 0n;
        let amountOut = 0n;
        let sqrtRatioNextX96 = sqrtRatioTargetX96;
        
        if (exactIn) {
            const amountRemainingLessFee = 
                (amountRemaining * (1000000n - BigInt(feePips))) / 1000000n;
            
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
        
        if (exactIn && sqrtRatioNextX96 !== sqrtRatioTargetX96) {
            amountIn = amountRemaining;
        } else {
            amountIn = (amountIn * 1000000n) / (1000000n - BigInt(feePips));
        }
        
        return {
            sqrtRatioNextX96,
            amountIn,
            amountOut,
            feeAmount: 0n
        };
    }

    /**
     * Update position and ticks
     */
    async updatePosition(owner, tickLower, tickUpper, liquidityDelta) {
        let amount0 = 0n;
        let amount1 = 0n;
        
        if (liquidityDelta !== 0n) {
            if (this.tick < tickLower) {
                amount0 = this.getAmount0ForLiquidity(
                    this.getSqrtRatioAtTick(tickLower),
                    this.getSqrtRatioAtTick(tickUpper),
                    liquidityDelta
                );
            } else if (this.tick < tickUpper) {
                amount0 = this.getAmount0ForLiquidity(
                    this.sqrtPriceX96,
                    this.getSqrtRatioAtTick(tickUpper),
                    liquidityDelta
                );
                amount1 = this.getAmount1ForLiquidity(
                    this.getSqrtRatioAtTick(tickLower),
                    this.sqrtPriceX96,
                    liquidityDelta
                );
                
                this.liquidity = liquidityDelta > 0n 
                    ? this.liquidity + liquidityDelta
                    : this.liquidity - (-liquidityDelta);
            } else {
                amount1 = this.getAmount1ForLiquidity(
                    this.getSqrtRatioAtTick(tickLower),
                    this.getSqrtRatioAtTick(tickUpper),
                    liquidityDelta
                );
            }
        }
        
        // Update ticks
        if (liquidityDelta !== 0n) {
            this.updateTick(tickLower, liquidityDelta, true);
            this.updateTick(tickUpper, liquidityDelta, false);
        }
        
        return { amount0, amount1 };
    }

    /**
     * Update tick
     */
    updateTick(tick, liquidityDelta, lower) {
        const tickData = this.ticks.get(tick) || {
            liquidityGross: 0n,
            liquidityNet: 0n,
            feeGrowthOutside0X128: 0n,
            feeGrowthOutside1X128: 0n,
            initialized: false
        };
        
        const liquidityGrossBefore = tickData.liquidityGross;
        const liquidityGrossAfter = liquidityDelta > 0n
            ? liquidityGrossBefore + liquidityDelta
            : liquidityGrossBefore - (-liquidityDelta);
        
        // Initialize tick if necessary
        if (liquidityGrossBefore === 0n) {
            if (tick <= this.tick) {
                tickData.feeGrowthOutside0X128 = this.feeGrowthGlobal0X128;
                tickData.feeGrowthOutside1X128 = this.feeGrowthGlobal1X128;
            }
            tickData.initialized = true;
        }
        
        tickData.liquidityGross = liquidityGrossAfter;
        
        // Update net liquidity
        tickData.liquidityNet = lower
            ? tickData.liquidityNet + liquidityDelta
            : tickData.liquidityNet - liquidityDelta;
        
        this.ticks.set(tick, tickData);
        
        // Update bitmap
        if (liquidityGrossAfter === 0n) {
            this.flipTick(tick, false);
            this.ticks.delete(tick);
        } else if (liquidityGrossBefore === 0n) {
            this.flipTick(tick, true);
        }
    }

    /**
     * Flip tick in bitmap
     */
    flipTick(tick, initialized) {
        const wordPos = tick >> 8;
        const bitPos = tick % 256;
        
        const word = this.tickBitmap.get(wordPos) || 0n;
        const mask = 1n << BigInt(bitPos);
        
        this.tickBitmap.set(wordPos, initialized ? word | mask : word & ~mask);
    }

    /**
     * Get fee growth inside range
     */
    getFeeGrowthInside(tickLower, tickUpper) {
        const lower = this.ticks.get(tickLower);
        const upper = this.ticks.get(tickUpper);
        
        let feeGrowthBelow0X128 = lower ? lower.feeGrowthOutside0X128 : 0n;
        let feeGrowthBelow1X128 = lower ? lower.feeGrowthOutside1X128 : 0n;
        let feeGrowthAbove0X128 = upper ? upper.feeGrowthOutside0X128 : 0n;
        let feeGrowthAbove1X128 = upper ? upper.feeGrowthOutside1X128 : 0n;
        
        if (this.tick < tickLower) {
            feeGrowthBelow0X128 = this.feeGrowthGlobal0X128 - feeGrowthBelow0X128;
            feeGrowthBelow1X128 = this.feeGrowthGlobal1X128 - feeGrowthBelow1X128;
        }
        
        if (this.tick >= tickUpper) {
            feeGrowthAbove0X128 = this.feeGrowthGlobal0X128 - feeGrowthAbove0X128;
            feeGrowthAbove1X128 = this.feeGrowthGlobal1X128 - feeGrowthAbove1X128;
        }
        
        return {
            feeGrowthInside0X128: this.feeGrowthGlobal0X128 - feeGrowthBelow0X128 - feeGrowthAbove0X128,
            feeGrowthInside1X128: this.feeGrowthGlobal1X128 - feeGrowthBelow1X128 - feeGrowthAbove1X128
        };
    }

    /**
     * Collect fees for a position
     */
    collectPositionFees(position) {
        const feeGrowthInside = this.getFeeGrowthInside(position.tickLower, position.tickUpper);
        
        const amount0 = (position.liquidity * 
            (feeGrowthInside.feeGrowthInside0X128 - position.feeGrowthInside0LastX128)) >> 128n;
        const amount1 = (position.liquidity * 
            (feeGrowthInside.feeGrowthInside1X128 - position.feeGrowthInside1LastX128)) >> 128n;
        
        position.feeGrowthInside0LastX128 = feeGrowthInside.feeGrowthInside0X128;
        position.feeGrowthInside1LastX128 = feeGrowthInside.feeGrowthInside1X128;
        
        return { amount0, amount1 };
    }

    /**
     * Math helpers
     */
    getSqrtRatioAtTick(tick) {
        const absTick = tick < 0 ? -tick : tick;
        let ratio = (absTick & 0x1) !== 0 
            ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
            
        if ((absTick & 0x2) !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
        if ((absTick & 0x4) !== 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
        // ... more bit checks
        
        if (tick > 0) ratio = (2n ** 256n - 1n) / ratio;
        
        return ratio >> 32n;
    }

    getTickAtSqrtRatio(sqrtRatioX96) {
        const ratio = sqrtRatioX96 << 32n;
        let msb = 0;
        
        // Calculate most significant bit
        let r = ratio;
        if (r >= 0x10000000000000000n) { r >>= 64n; msb += 64; }
        if (r >= 0x100000000n) { r >>= 32n; msb += 32; }
        if (r >= 0x10000n) { r >>= 16n; msb += 16; }
        if (r >= 0x100n) { r >>= 8n; msb += 8; }
        if (r >= 0x10n) { r >>= 4n; msb += 4; }
        if (r >= 0x4n) { r >>= 2n; msb += 2; }
        if (r >= 0x2n) { msb += 1; }
        
        const log2 = (msb - 128) << 64n;
        // ... more calculations
        
        const tick = Number((log2 * 255738958999603826347141n) >> 128n) >> 24;
        
        return tick;
    }

    getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity) {
        if (sqrtRatioAX96 > sqrtRatioBX96) {
            [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
        }
        
        const numerator = liquidity << 96n;
        const denominator = sqrtRatioBX96 - sqrtRatioAX96;
        
        return (numerator * denominator) / sqrtRatioBX96 / sqrtRatioAX96;
    }

    getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity) {
        if (sqrtRatioAX96 > sqrtRatioBX96) {
            [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
        }
        
        return (liquidity * (sqrtRatioBX96 - sqrtRatioAX96)) >> 96n;
    }

    getAmount0Delta(sqrtRatioAX96, sqrtRatioBX96, liquidity, roundUp) {
        const amount = this.getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity);
        return roundUp && amount > 0n ? amount + 1n : amount;
    }

    getAmount1Delta(sqrtRatioAX96, sqrtRatioBX96, liquidity, roundUp) {
        const amount = this.getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity);
        return roundUp && amount > 0n ? amount + 1n : amount;
    }

    getNextSqrtPrice(tick, zeroForOne) {
        const nextTick = zeroForOne ? tick - this.config.tickSpacing : tick + this.config.tickSpacing;
        return this.getSqrtRatioAtTick(nextTick);
    }

    getNextSqrtPriceFromInput(sqrtPX96, liquidity, amountIn, zeroForOne) {
        if (zeroForOne) {
            const product = amountIn * sqrtPX96;
            const denominator = (liquidity << 96n) + product;
            return (liquidity << 96n) * sqrtPX96 / denominator;
        } else {
            const quotient = (amountIn << 96n) / liquidity;
            return sqrtPX96 + quotient;
        }
    }

    validateTicks(tickLower, tickUpper) {
        if (tickLower >= tickUpper) {
            throw new Error('tickLower must be less than tickUpper');
        }
        
        if (tickLower < this.config.minTick || tickUpper > this.config.maxTick) {
            throw new Error('Ticks out of bounds');
        }
        
        if (tickLower % this.config.tickSpacing !== 0 || tickUpper % this.config.tickSpacing !== 0) {
            throw new Error('Ticks must be multiples of tickSpacing');
        }
    }

    /**
     * Get pool metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            totalLiquidity: this.liquidity.toString(),
            currentPrice: this.getPriceFromSqrtRatio(this.sqrtPriceX96),
            currentTick: this.tick,
            totalPositions: this.positions.size,
            protocolFees: {
                token0: this.protocolFees0.toString(),
                token1: this.protocolFees1.toString()
            }
        };
    }

    getPriceFromSqrtRatio(sqrtRatioX96) {
        const price = (Number(sqrtRatioX96) / (2 ** 96)) ** 2;
        return price;
    }
}

export default ConcentratedLiquidityPool;