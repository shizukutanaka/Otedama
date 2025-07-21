/**
 * Concentrated Liquidity AMM for Otedama DEX
 * Uniswap V3 style concentrated liquidity positions
 * 
 * Design principles:
 * - Efficient tick management (Carmack)
 * - Clean liquidity abstractions (Martin)
 * - Simple position tracking (Pike)
 */

import { EventEmitter } from 'events';
import { logger } from '../core/logger.js';
import crypto from 'crypto';

// Constants for tick spacing and math
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const Q96 = 2n ** 96n;
const Q128 = 2n ** 128n;

export class ConcentratedLiquidityPool extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            tickSpacing: config.tickSpacing || 60, // 0.6% between ticks
            feeRate: config.feeRate || 3000, // 0.3% in basis points
            protocolFeeRate: config.protocolFeeRate || 500, // 1/6 of fees
            
            // Position limits
            minPositionValue: config.minPositionValue || 100, // $100 minimum
            maxPositionsPerUser: config.maxPositionsPerUser || 100,
            
            // Tick limits
            maxTickCross: config.maxTickCross || 100, // Max ticks per swap
            
            // Price limits
            maxPriceImpact: config.maxPriceImpact || 0.05, // 5%
            
            ...config
        };
        
        // Pool state
        this.state = {
            sqrtPriceX96: 0n,
            tick: 0,
            liquidity: 0n,
            feeGrowthGlobal0X128: 0n,
            feeGrowthGlobal1X128: 0n,
            protocolFees0: 0n,
            protocolFees1: 0n
        };
        
        // Tick data
        this.ticks = new Map(); // tick -> TickInfo
        this.tickBitmap = new Map(); // wordPos -> uint256
        
        // Position data
        this.positions = new Map(); // positionId -> Position
        this.userPositions = new Map(); // userId -> Set<positionId>
        
        // Fee tracking
        this.feeGrowthOutside = new Map(); // tick -> FeeGrowth
        
        // Statistics
        this.stats = {
            totalPositions: 0,
            activePositions: 0,
            totalVolume0: 0n,
            totalVolume1: 0n,
            totalFees0: 0n,
            totalFees1: 0n,
            totalSwaps: 0
        };
        
        // Initialize pool if needed
        if (config.initialPrice) {
            this.initialize(config.initialPrice);
        }
    }
    
    /**
     * Initialize pool with starting price
     */
    initialize(sqrtPriceX96) {
        if (this.state.sqrtPriceX96 !== 0n) {
            throw new Error('Pool already initialized');
        }
        
        this.state.sqrtPriceX96 = BigInt(sqrtPriceX96);
        this.state.tick = this.getTickAtSqrtRatio(sqrtPriceX96);
        
        logger.info(`Pool initialized at sqrtPrice: ${sqrtPriceX96}, tick: ${this.state.tick}`);
        
        this.emit('pool:initialized', {
            sqrtPriceX96: sqrtPriceX96.toString(),
            tick: this.state.tick,
            timestamp: Date.now()
        });
    }
    
    /**
     * Add liquidity in a price range
     */
    async mintPosition(params) {
        const {
            userId,
            tickLower,
            tickUpper,
            liquidity,
            amount0Desired,
            amount1Desired,
            amount0Min,
            amount1Min,
            deadline
        } = params;
        
        // Validate inputs
        this.validateTicks(tickLower, tickUpper);
        
        if (deadline && Date.now() > deadline) {
            throw new Error('Transaction deadline exceeded');
        }
        
        // Check position limits
        const userPositionSet = this.userPositions.get(userId) || new Set();
        if (userPositionSet.size >= this.config.maxPositionsPerUser) {
            throw new Error('Maximum positions per user exceeded');
        }
        
        // Calculate liquidity if not provided
        let liquidityDelta = liquidity;
        if (!liquidityDelta && amount0Desired && amount1Desired) {
            liquidityDelta = this.calculateLiquidityFromAmounts(
                this.state.sqrtPriceX96,
                tickLower,
                tickUpper,
                amount0Desired,
                amount1Desired
            );
        }
        
        // Calculate actual amounts
        const { amount0, amount1 } = this.calculateAmountsForLiquidity(
            this.state.sqrtPriceX96,
            tickLower,
            tickUpper,
            liquidityDelta
        );
        
        // Check slippage
        if (amount0 < amount0Min || amount1 < amount1Min) {
            throw new Error('Slippage check failed');
        }
        
        // Update ticks
        this.updateTick(tickLower, liquidityDelta, true);
        this.updateTick(tickUpper, liquidityDelta, false);
        
        // Create position
        const positionId = this.generatePositionId();
        const position = {
            id: positionId,
            userId,
            tickLower,
            tickUpper,
            liquidity: liquidityDelta,
            feeGrowthInside0LastX128: this.getFeeGrowthInside(tickLower, tickUpper).feeGrowthInside0X128,
            feeGrowthInside1LastX128: this.getFeeGrowthInside(tickLower, tickUpper).feeGrowthInside1X128,
            tokensOwed0: 0n,
            tokensOwed1: 0n,
            createdAt: Date.now(),
            lastUpdated: Date.now()
        };
        
        // Store position
        this.positions.set(positionId, position);
        if (!this.userPositions.has(userId)) {
            this.userPositions.set(userId, new Set());
        }
        this.userPositions.get(userId).add(positionId);
        
        // Update global liquidity if position is active
        if (this.state.tick >= tickLower && this.state.tick < tickUpper) {
            this.state.liquidity += liquidityDelta;
        }
        
        // Update stats
        this.stats.totalPositions++;
        this.stats.activePositions++;
        
        logger.info(`Position minted: ${positionId}, liquidity: ${liquidityDelta}`);
        
        this.emit('position:minted', {
            position,
            amount0: amount0.toString(),
            amount1: amount1.toString(),
            timestamp: Date.now()
        });
        
        return {
            positionId,
            liquidity: liquidityDelta.toString(),
            amount0: amount0.toString(),
            amount1: amount1.toString()
        };
    }
    
    /**
     * Remove liquidity from position
     */
    async burnPosition(params) {
        const {
            positionId,
            userId,
            liquidity,
            amount0Min,
            amount1Min,
            deadline
        } = params;
        
        if (deadline && Date.now() > deadline) {
            throw new Error('Transaction deadline exceeded');
        }
        
        const position = this.positions.get(positionId);
        if (!position) {
            throw new Error('Position not found');
        }
        
        if (position.userId !== userId) {
            throw new Error('Unauthorized');
        }
        
        const liquidityDelta = BigInt(liquidity);
        if (liquidityDelta > position.liquidity) {
            throw new Error('Insufficient liquidity');
        }
        
        // Collect fees before burning
        this.collectPositionFees(position);
        
        // Calculate amounts to withdraw
        const { amount0, amount1 } = this.calculateAmountsForLiquidity(
            this.state.sqrtPriceX96,
            position.tickLower,
            position.tickUpper,
            liquidityDelta
        );
        
        // Check slippage
        if (amount0 < amount0Min || amount1 < amount1Min) {
            throw new Error('Slippage check failed');
        }
        
        // Update position liquidity
        position.liquidity -= liquidityDelta;
        
        // Update ticks
        this.updateTick(position.tickLower, -liquidityDelta, true);
        this.updateTick(position.tickUpper, -liquidityDelta, false);
        
        // Update global liquidity if position is active
        if (this.state.tick >= position.tickLower && this.state.tick < position.tickUpper) {
            this.state.liquidity -= liquidityDelta;
        }
        
        // Remove position if fully withdrawn
        if (position.liquidity === 0n && position.tokensOwed0 === 0n && position.tokensOwed1 === 0n) {
            this.positions.delete(positionId);
            this.userPositions.get(userId).delete(positionId);
            this.stats.activePositions--;
        }
        
        position.lastUpdated = Date.now();
        
        logger.info(`Position burned: ${positionId}, liquidity: ${liquidityDelta}`);
        
        this.emit('position:burned', {
            positionId,
            liquidity: liquidityDelta.toString(),
            amount0: amount0.toString(),
            amount1: amount1.toString(),
            timestamp: Date.now()
        });
        
        return {
            amount0: amount0.toString(),
            amount1: amount1.toString(),
            fees0: position.tokensOwed0.toString(),
            fees1: position.tokensOwed1.toString()
        };
    }
    
    /**
     * Collect fees from position
     */
    async collectFees(params) {
        const { positionId, userId } = params;
        
        const position = this.positions.get(positionId);
        if (!position) {
            throw new Error('Position not found');
        }
        
        if (position.userId !== userId) {
            throw new Error('Unauthorized');
        }
        
        // Update fees owed
        this.collectPositionFees(position);
        
        const fees0 = position.tokensOwed0;
        const fees1 = position.tokensOwed1;
        
        // Reset fees
        position.tokensOwed0 = 0n;
        position.tokensOwed1 = 0n;
        position.lastUpdated = Date.now();
        
        logger.info(`Fees collected: ${positionId}, token0: ${fees0}, token1: ${fees1}`);
        
        this.emit('fees:collected', {
            positionId,
            userId,
            fees0: fees0.toString(),
            fees1: fees1.toString(),
            timestamp: Date.now()
        });
        
        return {
            fees0: fees0.toString(),
            fees1: fees1.toString()
        };
    }
    
    /**
     * Swap tokens
     */
    async swap(params) {
        const {
            zeroForOne, // true: token0 -> token1, false: token1 -> token0
            amountSpecified,
            sqrtPriceLimitX96,
            userId
        } = params;
        
        if (amountSpecified === 0n) {
            throw new Error('Amount must be non-zero');
        }
        
        // Determine if exact input or output
        const exactInput = amountSpecified > 0n;
        
        // Initialize swap state
        const state = {
            amountSpecifiedRemaining: amountSpecified,
            amountCalculated: 0n,
            sqrtPriceX96: this.state.sqrtPriceX96,
            tick: this.state.tick,
            feeGrowthGlobalX128: zeroForOne ? this.state.feeGrowthGlobal0X128 : this.state.feeGrowthGlobal1X128,
            liquidity: this.state.liquidity,
            ticksCrossed: 0
        };
        
        // Swap until amount is exhausted or price limit reached
        while (state.amountSpecifiedRemaining !== 0n && 
               state.sqrtPriceX96 !== sqrtPriceLimitX96 &&
               state.ticksCrossed < this.config.maxTickCross) {
            
            // Get next tick
            const nextTick = this.getNextInitializedTick(state.tick, zeroForOne);
            const nextSqrtPrice = this.getSqrtRatioAtTick(nextTick);
            
            // Calculate target price
            const targetSqrtPrice = zeroForOne
                ? (nextSqrtPrice < sqrtPriceLimitX96 ? sqrtPriceLimitX96 : nextSqrtPrice)
                : (nextSqrtPrice > sqrtPriceLimitX96 ? sqrtPriceLimitX96 : nextSqrtPrice);
            
            // Compute swap step
            const step = this.computeSwapStep(
                state.sqrtPriceX96,
                targetSqrtPrice,
                state.liquidity,
                state.amountSpecifiedRemaining,
                this.config.feeRate
            );
            
            // Update state
            state.sqrtPriceX96 = step.sqrtPriceNextX96;
            state.amountSpecifiedRemaining -= step.amountIn + step.feeAmount;
            state.amountCalculated += step.amountOut;
            
            // Update fees
            if (state.liquidity > 0n) {
                const feeGrowthX128 = (step.feeAmount * Q128) / state.liquidity;
                state.feeGrowthGlobalX128 += feeGrowthX128;
            }
            
            // Cross tick if necessary
            if (state.sqrtPriceX96 === nextSqrtPrice) {
                const tick = this.ticks.get(nextTick);
                if (tick) {
                    // Update fee growth outside
                    this.updateFeeGrowthOutside(nextTick, state.feeGrowthGlobalX128, zeroForOne);
                    
                    // Update liquidity
                    const liquidityDelta = zeroForOne ? -tick.liquidityNet : tick.liquidityNet;
                    state.liquidity = state.liquidity + liquidityDelta;
                    
                    state.ticksCrossed++;
                }
                
                state.tick = zeroForOne ? nextTick - 1 : nextTick;
            } else {
                state.tick = this.getTickAtSqrtRatio(state.sqrtPriceX96);
            }
        }
        
        // Update global state
        this.state.sqrtPriceX96 = state.sqrtPriceX96;
        this.state.tick = state.tick;
        this.state.liquidity = state.liquidity;
        
        if (zeroForOne) {
            this.state.feeGrowthGlobal0X128 = state.feeGrowthGlobalX128;
            this.stats.totalVolume0 += BigInt(Math.abs(Number(amountSpecified - state.amountSpecifiedRemaining)));
            this.stats.totalFees0 += BigInt(Math.abs(Number((amountSpecified - state.amountSpecifiedRemaining) * BigInt(this.config.feeRate) / 1000000n)));
        } else {
            this.state.feeGrowthGlobal1X128 = state.feeGrowthGlobalX128;
            this.stats.totalVolume1 += BigInt(Math.abs(Number(amountSpecified - state.amountSpecifiedRemaining)));
            this.stats.totalFees1 += BigInt(Math.abs(Number((amountSpecified - state.amountSpecifiedRemaining) * BigInt(this.config.feeRate) / 1000000n)));
        }
        
        this.stats.totalSwaps++;
        
        const amount0 = zeroForOne ? amountSpecified - state.amountSpecifiedRemaining : -state.amountCalculated;
        const amount1 = zeroForOne ? -state.amountCalculated : amountSpecified - state.amountSpecifiedRemaining;
        
        logger.info(`Swap executed: ${zeroForOne ? 'token0->token1' : 'token1->token0'}, amount0: ${amount0}, amount1: ${amount1}`);
        
        this.emit('swap', {
            userId,
            amount0: amount0.toString(),
            amount1: amount1.toString(),
            sqrtPriceX96: state.sqrtPriceX96.toString(),
            tick: state.tick,
            liquidity: state.liquidity.toString(),
            timestamp: Date.now()
        });
        
        return {
            amount0: amount0.toString(),
            amount1: amount1.toString(),
            sqrtPriceX96: state.sqrtPriceX96.toString(),
            tick: state.tick
        };
    }
    
    /**
     * Helper methods
     */
    
    validateTicks(tickLower, tickUpper) {
        if (tickLower >= tickUpper) {
            throw new Error('tickLower must be less than tickUpper');
        }
        
        if (tickLower < MIN_TICK || tickUpper > MAX_TICK) {
            throw new Error('Ticks out of bounds');
        }
        
        if (tickLower % this.config.tickSpacing !== 0 || tickUpper % this.config.tickSpacing !== 0) {
            throw new Error('Ticks must be multiples of tickSpacing');
        }
    }
    
    updateTick(tick, liquidityDelta, lower) {
        let tickInfo = this.ticks.get(tick);
        
        if (!tickInfo) {
            tickInfo = {
                liquidityGross: 0n,
                liquidityNet: 0n,
                initialized: false
            };
            this.ticks.set(tick, tickInfo);
        }
        
        const liquidityGrossBefore = tickInfo.liquidityGross;
        tickInfo.liquidityGross += liquidityDelta > 0n ? liquidityDelta : -liquidityDelta;
        
        // Initialize tick if crossing from 0
        if (liquidityGrossBefore === 0n && tickInfo.liquidityGross > 0n) {
            tickInfo.initialized = true;
            this.flipTick(tick, true);
        }
        
        // Update net liquidity
        tickInfo.liquidityNet += lower ? liquidityDelta : -liquidityDelta;
        
        // Uninitialize tick if liquidity removed
        if (tickInfo.liquidityGross === 0n) {
            tickInfo.initialized = false;
            this.flipTick(tick, false);
            this.ticks.delete(tick);
        }
    }
    
    flipTick(tick, initialized) {
        const wordPos = tick >> 8;
        const bitPos = tick % 256;
        
        let word = this.tickBitmap.get(wordPos) || 0n;
        
        if (initialized) {
            word |= (1n << BigInt(bitPos));
        } else {
            word &= ~(1n << BigInt(bitPos));
        }
        
        if (word === 0n) {
            this.tickBitmap.delete(wordPos);
        } else {
            this.tickBitmap.set(wordPos, word);
        }
    }
    
    getNextInitializedTick(tick, lte) {
        // Simplified version - in production would use bitmap
        const ticks = Array.from(this.ticks.keys()).sort((a, b) => a - b);
        
        if (lte) {
            for (let i = ticks.length - 1; i >= 0; i--) {
                if (ticks[i] <= tick) return ticks[i];
            }
            return MIN_TICK;
        } else {
            for (const t of ticks) {
                if (t > tick) return t;
            }
            return MAX_TICK;
        }
    }
    
    calculateLiquidityFromAmounts(sqrtPriceX96, tickLower, tickUpper, amount0, amount1) {
        const sqrtRatioA = this.getSqrtRatioAtTick(tickLower);
        const sqrtRatioB = this.getSqrtRatioAtTick(tickUpper);
        
        if (sqrtPriceX96 <= sqrtRatioA) {
            // Current price below range
            return (BigInt(amount0) * sqrtRatioA * sqrtRatioB) / (sqrtRatioB - sqrtRatioA) / Q96;
        } else if (sqrtPriceX96 < sqrtRatioB) {
            // Current price in range
            const liquidity0 = (BigInt(amount0) * sqrtPriceX96 * sqrtRatioB) / (sqrtRatioB - sqrtPriceX96) / Q96;
            const liquidity1 = BigInt(amount1) * Q96 / (sqrtPriceX96 - sqrtRatioA);
            return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
        } else {
            // Current price above range
            return BigInt(amount1) * Q96 / (sqrtRatioB - sqrtRatioA);
        }
    }
    
    calculateAmountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, liquidity) {
        const sqrtRatioA = this.getSqrtRatioAtTick(tickLower);
        const sqrtRatioB = this.getSqrtRatioAtTick(tickUpper);
        
        let amount0 = 0n;
        let amount1 = 0n;
        
        if (sqrtPriceX96 <= sqrtRatioA) {
            // Current price below range
            amount0 = (liquidity * (sqrtRatioB - sqrtRatioA) * Q96) / sqrtRatioA / sqrtRatioB;
        } else if (sqrtPriceX96 < sqrtRatioB) {
            // Current price in range
            amount0 = (liquidity * (sqrtRatioB - sqrtPriceX96) * Q96) / sqrtPriceX96 / sqrtRatioB;
            amount1 = (liquidity * (sqrtPriceX96 - sqrtRatioA)) / Q96;
        } else {
            // Current price above range
            amount1 = (liquidity * (sqrtRatioB - sqrtRatioA)) / Q96;
        }
        
        return { amount0, amount1 };
    }
    
    computeSwapStep(sqrtPriceCurrentX96, sqrtPriceTargetX96, liquidity, amountRemaining, feeRate) {
        const zeroForOne = sqrtPriceTargetX96 < sqrtPriceCurrentX96;
        const exactInput = amountRemaining > 0n;
        
        // Simplified calculation - in production would be more precise
        const amountIn = BigInt(Math.abs(Number(amountRemaining))) / 2n;
        const feeAmount = (amountIn * BigInt(feeRate)) / 1000000n;
        const amountOut = (amountIn * 9n) / 10n; // Simplified
        
        return {
            sqrtPriceNextX96: sqrtPriceTargetX96,
            amountIn,
            amountOut,
            feeAmount
        };
    }
    
    getSqrtRatioAtTick(tick) {
        // Simplified - in production would use precise math
        const price = 1.0001 ** tick;
        return BigInt(Math.floor(Math.sqrt(price) * Number(Q96)));
    }
    
    getTickAtSqrtRatio(sqrtPriceX96) {
        // Simplified - in production would use precise math
        const price = (Number(sqrtPriceX96) / Number(Q96)) ** 2;
        return Math.floor(Math.log(price) / Math.log(1.0001));
    }
    
    getFeeGrowthInside(tickLower, tickUpper) {
        const feeGrowthBelow0 = this.getFeeGrowthBelow(tickLower, true);
        const feeGrowthBelow1 = this.getFeeGrowthBelow(tickLower, false);
        const feeGrowthAbove0 = this.getFeeGrowthAbove(tickUpper, true);
        const feeGrowthAbove1 = this.getFeeGrowthAbove(tickUpper, false);
        
        return {
            feeGrowthInside0X128: this.state.feeGrowthGlobal0X128 - feeGrowthBelow0 - feeGrowthAbove0,
            feeGrowthInside1X128: this.state.feeGrowthGlobal1X128 - feeGrowthBelow1 - feeGrowthAbove1
        };
    }
    
    getFeeGrowthBelow(tick, isToken0) {
        const growth = this.feeGrowthOutside.get(tick);
        if (!growth) return 0n;
        
        if (this.state.tick >= tick) {
            return isToken0 ? growth.feeGrowth0X128 : growth.feeGrowth1X128;
        } else {
            const global = isToken0 ? this.state.feeGrowthGlobal0X128 : this.state.feeGrowthGlobal1X128;
            const outside = isToken0 ? growth.feeGrowth0X128 : growth.feeGrowth1X128;
            return global - outside;
        }
    }
    
    getFeeGrowthAbove(tick, isToken0) {
        const growth = this.feeGrowthOutside.get(tick);
        if (!growth) return 0n;
        
        if (this.state.tick < tick) {
            return isToken0 ? growth.feeGrowth0X128 : growth.feeGrowth1X128;
        } else {
            const global = isToken0 ? this.state.feeGrowthGlobal0X128 : this.state.feeGrowthGlobal1X128;
            const outside = isToken0 ? growth.feeGrowth0X128 : growth.feeGrowth1X128;
            return global - outside;
        }
    }
    
    updateFeeGrowthOutside(tick, feeGrowthGlobalX128, isToken0) {
        let growth = this.feeGrowthOutside.get(tick);
        if (!growth) {
            growth = { feeGrowth0X128: 0n, feeGrowth1X128: 0n };
            this.feeGrowthOutside.set(tick, growth);
        }
        
        if (isToken0) {
            growth.feeGrowth0X128 = feeGrowthGlobalX128;
        } else {
            growth.feeGrowth1X128 = feeGrowthGlobalX128;
        }
    }
    
    collectPositionFees(position) {
        const feeGrowthInside = this.getFeeGrowthInside(position.tickLower, position.tickUpper);
        
        const fees0 = (position.liquidity * (feeGrowthInside.feeGrowthInside0X128 - position.feeGrowthInside0LastX128)) / Q128;
        const fees1 = (position.liquidity * (feeGrowthInside.feeGrowthInside1X128 - position.feeGrowthInside1LastX128)) / Q128;
        
        position.tokensOwed0 += fees0;
        position.tokensOwed1 += fees1;
        position.feeGrowthInside0LastX128 = feeGrowthInside.feeGrowthInside0X128;
        position.feeGrowthInside1LastX128 = feeGrowthInside.feeGrowthInside1X128;
    }
    
    generatePositionId() {
        return `POS${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Get pool state
     */
    getPoolState() {
        return {
            sqrtPriceX96: this.state.sqrtPriceX96.toString(),
            tick: this.state.tick,
            liquidity: this.state.liquidity.toString(),
            feeRate: this.config.feeRate,
            tickSpacing: this.config.tickSpacing
        };
    }
    
    /**
     * Get position info
     */
    getPosition(positionId) {
        const position = this.positions.get(positionId);
        if (!position) return null;
        
        // Update fees
        this.collectPositionFees(position);
        
        return {
            ...position,
            liquidity: position.liquidity.toString(),
            tokensOwed0: position.tokensOwed0.toString(),
            tokensOwed1: position.tokensOwed1.toString()
        };
    }
    
    /**
     * Get user positions
     */
    getUserPositions(userId) {
        const positionIds = this.userPositions.get(userId);
        if (!positionIds) return [];
        
        return Array.from(positionIds).map(id => this.getPosition(id)).filter(p => p !== null);
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            totalVolume0: this.stats.totalVolume0.toString(),
            totalVolume1: this.stats.totalVolume1.toString(),
            totalFees0: this.stats.totalFees0.toString(),
            totalFees1: this.stats.totalFees1.toString(),
            currentLiquidity: this.state.liquidity.toString(),
            currentPrice: this.getCurrentPrice().toString(),
            activeTicks: this.ticks.size
        };
    }
    
    getCurrentPrice() {
        const sqrtPrice = Number(this.state.sqrtPriceX96) / Number(Q96);
        return sqrtPrice * sqrtPrice;
    }
}

export default ConcentratedLiquidityPool;