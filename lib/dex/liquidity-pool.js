/**
 * Liquidity Pool Implementation
 * Provides AMM functionality with concentrated liquidity support
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import BN from 'bn.js';
import { getLogger } from '../core/logger.js';

// Constants
const FEE_TIERS = {
    LOWEST: 100,    // 0.01%
    LOW: 500,       // 0.05%
    MEDIUM: 3000,   // 0.30%
    HIGH: 10000     // 1.00%
};

const MINIMUM_LIQUIDITY = new BN('1000');
const TICK_SPACING = {
    [FEE_TIERS.LOWEST]: 1,
    [FEE_TIERS.LOW]: 10,
    [FEE_TIERS.MEDIUM]: 60,
    [FEE_TIERS.HIGH]: 200
};

export class LiquidityPool extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.logger = getLogger('LiquidityPool');
        this.options = {
            token0: options.token0,
            token1: options.token1,
            feeTier: options.feeTier || FEE_TIERS.MEDIUM,
            tickSpacing: TICK_SPACING[options.feeTier || FEE_TIERS.MEDIUM],
            protocolFee: options.protocolFee || 0.1, // 10% of swap fees
            oracleEnabled: options.oracleEnabled !== false,
            concentratedLiquidity: options.concentratedLiquidity !== false,
            ...options
        };
        
        // Pool state
        this.poolId = this.generatePoolId();
        this.reserve0 = new BN(0);
        this.reserve1 = new BN(0);
        this.kLast = new BN(0);
        this.totalSupply = new BN(0);
        this.protocolFees0 = new BN(0);
        this.protocolFees1 = new BN(0);
        
        // Price and tick data
        this.sqrtPriceX96 = new BN(0);
        this.currentTick = 0;
        this.liquidity = new BN(0);
        this.feeGrowthGlobal0X128 = new BN(0);
        this.feeGrowthGlobal1X128 = new BN(0);
        
        // Concentrated liquidity positions
        this.positions = new Map();
        this.ticks = new Map();
        
        // Oracle data
        this.observations = [];
        this.observationIndex = 0;
        this.observationCardinality = 1;
        this.observationCardinalityNext = 1;
        
        // Flash loan state
        this.flashLoanActive = false;
        
        // Statistics
        this.stats = {
            totalVolume0: new BN(0),
            totalVolume1: new BN(0),
            totalFees0: new BN(0),
            totalFees1: new BN(0),
            totalTransactions: 0,
            liquidityProviders: new Set(),
            created: Date.now()
        };
    }
    
    /**
     * Initialize pool with initial liquidity
     */
    async initialize(sqrtPriceX96) {
        if (!this.sqrtPriceX96.isZero()) {
            throw new Error('Pool already initialized');
        }
        
        this.sqrtPriceX96 = new BN(sqrtPriceX96);
        this.currentTick = this.getTickAtSqrtRatio(sqrtPriceX96);
        
        // Initialize oracle
        if (this.options.oracleEnabled) {
            this.observations.push({
                timestamp: Math.floor(Date.now() / 1000),
                tickCumulative: 0,
                secondsPerLiquidityX128: new BN(0),
                initialized: true
            });
        }
        
        this.logger.info(`Pool initialized with sqrt price: ${sqrtPriceX96.toString()}`);
        this.emit('initialized', { poolId: this.poolId, sqrtPriceX96 });
    }
    
    /**
     * Add liquidity to the pool
     */
    async addLiquidity(provider, amount0Desired, amount1Desired, tickLower, tickUpper) {
        // Validate inputs
        if (tickLower >= tickUpper) {
            throw new Error('Invalid tick range');
        }
        
        if (tickLower % this.options.tickSpacing !== 0 || tickUpper % this.options.tickSpacing !== 0) {
            throw new Error('Ticks must be multiples of tick spacing');
        }
        
        const amount0 = new BN(amount0Desired);
        const amount1 = new BN(amount1Desired);
        
        // Calculate liquidity amount
        const liquidity = this.getLiquidityForAmounts(
            this.sqrtPriceX96,
            tickLower,
            tickUpper,
            amount0,
            amount1
        );
        
        if (liquidity.lte(new BN(0))) {
            throw new Error('Insufficient liquidity amount');
        }
        
        // Update position
        const positionKey = this.getPositionKey(provider, tickLower, tickUpper);
        let position = this.positions.get(positionKey) || {
            liquidity: new BN(0),
            feeGrowthInside0LastX128: new BN(0),
            feeGrowthInside1LastX128: new BN(0),
            tokensOwed0: new BN(0),
            tokensOwed1: new BN(0)
        };
        
        // Update ticks
        this.updateTick(tickLower, liquidity, true);
        this.updateTick(tickUpper, liquidity, false);
        
        // Update position liquidity
        position.liquidity = position.liquidity.add(liquidity);
        
        // Calculate actual amounts
        const { amount0: actualAmount0, amount1: actualAmount1 } = this.getAmountsForLiquidity(
            this.sqrtPriceX96,
            tickLower,
            tickUpper,
            liquidity
        );
        
        // Update reserves
        this.reserve0 = this.reserve0.add(actualAmount0);
        this.reserve1 = this.reserve1.add(actualAmount1);
        
        // Update global liquidity if position is active
        if (this.currentTick >= tickLower && this.currentTick < tickUpper) {
            this.liquidity = this.liquidity.add(liquidity);
        }
        
        // Mint LP tokens
        const lpTokens = liquidity; // Simplified - in practice would be more complex
        this.totalSupply = this.totalSupply.add(lpTokens);
        
        // Store position
        this.positions.set(positionKey, position);
        this.stats.liquidityProviders.add(provider);
        
        this.logger.info(`Liquidity added: ${liquidity.toString()} by ${provider}`);
        this.emit('liquidityAdded', {
            provider,
            amount0: actualAmount0.toString(),
            amount1: actualAmount1.toString(),
            liquidity: liquidity.toString(),
            tickLower,
            tickUpper
        });
        
        return {
            liquidity: liquidity.toString(),
            amount0: actualAmount0.toString(),
            amount1: actualAmount1.toString(),
            lpTokens: lpTokens.toString()
        };
    }
    
    /**
     * Remove liquidity from the pool
     */
    async removeLiquidity(provider, liquidity, tickLower, tickUpper) {
        const positionKey = this.getPositionKey(provider, tickLower, tickUpper);
        const position = this.positions.get(positionKey);
        
        if (!position || position.liquidity.lt(new BN(liquidity))) {
            throw new Error('Insufficient liquidity');
        }
        
        // Calculate amounts to return
        const { amount0, amount1 } = this.getAmountsForLiquidity(
            this.sqrtPriceX96,
            tickLower,
            tickUpper,
            new BN(liquidity)
        );
        
        // Update position
        position.liquidity = position.liquidity.sub(new BN(liquidity));
        
        // Collect fees
        const fees = this.collectFees(position, tickLower, tickUpper);
        
        // Update ticks
        this.updateTick(tickLower, new BN(liquidity), false);
        this.updateTick(tickUpper, new BN(liquidity), true);
        
        // Update global liquidity if position is active
        if (this.currentTick >= tickLower && this.currentTick < tickUpper) {
            this.liquidity = this.liquidity.sub(new BN(liquidity));
        }
        
        // Update reserves
        this.reserve0 = this.reserve0.sub(amount0).sub(fees.amount0);
        this.reserve1 = this.reserve1.sub(amount1).sub(fees.amount1);
        
        // Burn LP tokens
        this.totalSupply = this.totalSupply.sub(new BN(liquidity));
        
        if (position.liquidity.isZero()) {
            this.positions.delete(positionKey);
        } else {
            this.positions.set(positionKey, position);
        }
        
        this.logger.info(`Liquidity removed: ${liquidity} by ${provider}`);
        this.emit('liquidityRemoved', {
            provider,
            amount0: amount0.add(fees.amount0).toString(),
            amount1: amount1.add(fees.amount1).toString(),
            liquidity: liquidity.toString()
        });
        
        return {
            amount0: amount0.add(fees.amount0).toString(),
            amount1: amount1.add(fees.amount1).toString()
        };
    }
    
    /**
     * Swap tokens
     */
    async swap(trader, tokenIn, amountIn, minAmountOut) {
        const amount = new BN(amountIn);
        const zeroForOne = tokenIn === this.options.token0;
        
        if (amount.lte(new BN(0))) {
            throw new Error('Invalid swap amount');
        }
        
        // Calculate swap
        const swapResult = this.computeSwap(zeroForOne, amount);
        
        if (swapResult.amountOut.lt(new BN(minAmountOut))) {
            throw new Error('Insufficient output amount');
        }
        
        // Update state
        this.sqrtPriceX96 = swapResult.sqrtPriceX96Next;
        this.currentTick = swapResult.tickNext;
        this.liquidity = swapResult.liquidityNext;
        
        // Update reserves
        if (zeroForOne) {
            this.reserve0 = this.reserve0.add(amount);
            this.reserve1 = this.reserve1.sub(swapResult.amountOut);
            this.stats.totalVolume0 = this.stats.totalVolume0.add(amount);
            this.stats.totalFees0 = this.stats.totalFees0.add(swapResult.feeAmount);
        } else {
            this.reserve1 = this.reserve1.add(amount);
            this.reserve0 = this.reserve0.sub(swapResult.amountOut);
            this.stats.totalVolume1 = this.stats.totalVolume1.add(amount);
            this.stats.totalFees1 = this.stats.totalFees1.add(swapResult.feeAmount);
        }
        
        // Update fee growth
        this.updateFeeGrowth(zeroForOne, swapResult.feeAmount);
        
        // Update oracle
        if (this.options.oracleEnabled) {
            this.updateOracle();
        }
        
        this.stats.totalTransactions++;
        
        this.logger.info(`Swap executed: ${amountIn} -> ${swapResult.amountOut.toString()}`);
        this.emit('swap', {
            trader,
            tokenIn,
            amountIn: amount.toString(),
            amountOut: swapResult.amountOut.toString(),
            fee: swapResult.feeAmount.toString()
        });
        
        return {
            amountOut: swapResult.amountOut.toString(),
            fee: swapResult.feeAmount.toString(),
            priceImpact: swapResult.priceImpact
        };
    }
    
    /**
     * Flash loan implementation
     */
    async flashLoan(borrower, token, amount, data) {
        if (this.flashLoanActive) {
            throw new Error('Flash loan already active');
        }
        
        const loanAmount = new BN(amount);
        const token0Loan = token === this.options.token0;
        
        // Check available liquidity
        const available = token0Loan ? this.reserve0 : this.reserve1;
        if (loanAmount.gt(available)) {
            throw new Error('Insufficient liquidity for flash loan');
        }
        
        // Calculate fee (0.09% flash loan fee)
        const flashFee = loanAmount.mul(new BN(9)).div(new BN(10000));
        
        this.flashLoanActive = true;
        
        try {
            // Update reserves
            if (token0Loan) {
                this.reserve0 = this.reserve0.sub(loanAmount);
            } else {
                this.reserve1 = this.reserve1.sub(loanAmount);
            }
            
            // Execute callback
            const callbackResult = await this.executeFlashLoanCallback(
                borrower,
                token,
                loanAmount,
                flashFee,
                data
            );
            
            // Verify repayment
            const expectedBalance = available.add(flashFee);
            const actualBalance = token0Loan ? this.reserve0 : this.reserve1;
            
            if (actualBalance.lt(expectedBalance)) {
                throw new Error('Flash loan not repaid');
            }
            
            // Distribute flash loan fee
            if (token0Loan) {
                this.protocolFees0 = this.protocolFees0.add(
                    flashFee.mul(new BN(this.options.protocolFee * 10000)).div(new BN(10000))
                );
            } else {
                this.protocolFees1 = this.protocolFees1.add(
                    flashFee.mul(new BN(this.options.protocolFee * 10000)).div(new BN(10000))
                );
            }
            
            this.logger.info(`Flash loan executed: ${amount} ${token}`);
            this.emit('flashLoan', {
                borrower,
                token,
                amount: loanAmount.toString(),
                fee: flashFee.toString()
            });
            
            return {
                success: true,
                fee: flashFee.toString(),
                result: callbackResult
            };
            
        } finally {
            this.flashLoanActive = false;
        }
    }
    
    /**
     * Execute flash loan callback
     */
    async executeFlashLoanCallback(borrower, token, amount, fee, data) {
        // In production, this would call the borrower's contract
        // For now, simulate callback execution
        this.logger.info(`Executing flash loan callback for ${borrower}`);
        
        // Simulate repayment
        if (token === this.options.token0) {
            this.reserve0 = this.reserve0.add(amount).add(fee);
        } else {
            this.reserve1 = this.reserve1.add(amount).add(fee);
        }
        
        return { executed: true };
    }
    
    /**
     * Compute swap amounts and state changes
     */
    computeSwap(zeroForOne, amountSpecified) {
        let state = {
            amountSpecifiedRemaining: amountSpecified,
            amountCalculated: new BN(0),
            sqrtPriceX96: this.sqrtPriceX96,
            tick: this.currentTick,
            liquidity: this.liquidity,
            feeAmount: new BN(0)
        };
        
        // Simplified swap logic - in production would be more complex
        // with tick crossing and concentrated liquidity
        
        const feeAmount = amountSpecified
            .mul(new BN(this.options.feeTier))
            .div(new BN(1000000));
        
        const amountInLessFee = amountSpecified.sub(feeAmount);
        
        // Constant product formula: x * y = k
        let amountOut;
        if (zeroForOne) {
            amountOut = this.reserve1
                .mul(amountInLessFee)
                .div(this.reserve0.add(amountInLessFee));
        } else {
            amountOut = this.reserve0
                .mul(amountInLessFee)
                .div(this.reserve1.add(amountInLessFee));
        }
        
        // Calculate price impact
        const priceImpact = amountOut
            .mul(new BN(10000))
            .div(amountInLessFee)
            .sub(new BN(10000))
            .abs()
            .toNumber() / 100;
        
        return {
            amountOut,
            feeAmount,
            sqrtPriceX96Next: this.calculateNewSqrtPrice(zeroForOne, amountInLessFee, amountOut),
            tickNext: this.currentTick, // Simplified - would calculate new tick
            liquidityNext: this.liquidity,
            priceImpact
        };
    }
    
    /**
     * Update tick
     */
    updateTick(tick, liquidityDelta, upper) {
        let tickInfo = this.ticks.get(tick) || {
            liquidityGross: new BN(0),
            liquidityNet: new BN(0),
            feeGrowthOutside0X128: new BN(0),
            feeGrowthOutside1X128: new BN(0),
            initialized: false
        };
        
        tickInfo.liquidityGross = upper
            ? tickInfo.liquidityGross.sub(liquidityDelta)
            : tickInfo.liquidityGross.add(liquidityDelta);
        
        tickInfo.liquidityNet = upper
            ? tickInfo.liquidityNet.sub(liquidityDelta)
            : tickInfo.liquidityNet.add(liquidityDelta);
        
        tickInfo.initialized = true;
        
        this.ticks.set(tick, tickInfo);
    }
    
    /**
     * Update fee growth
     */
    updateFeeGrowth(zeroForOne, feeAmount) {
        const liquidityShifted = this.liquidity.shln(128);
        
        if (zeroForOne) {
            this.feeGrowthGlobal0X128 = this.feeGrowthGlobal0X128.add(
                feeAmount.shln(128).div(liquidityShifted)
            );
        } else {
            this.feeGrowthGlobal1X128 = this.feeGrowthGlobal1X128.add(
                feeAmount.shln(128).div(liquidityShifted)
            );
        }
    }
    
    /**
     * Update price oracle
     */
    updateOracle() {
        const timestamp = Math.floor(Date.now() / 1000);
        const lastObservation = this.observations[this.observationIndex];
        
        if (timestamp === lastObservation.timestamp) {
            return;
        }
        
        const delta = timestamp - lastObservation.timestamp;
        const tickCumulative = lastObservation.tickCumulative + this.currentTick * delta;
        
        const secondsPerLiquidityX128 = this.liquidity.gt(new BN(0))
            ? new BN(delta).shln(128).div(this.liquidity)
            : new BN(0);
        
        this.observationIndex = (this.observationIndex + 1) % this.observationCardinality;
        
        this.observations[this.observationIndex] = {
            timestamp,
            tickCumulative,
            secondsPerLiquidityX128: lastObservation.secondsPerLiquidityX128.add(secondsPerLiquidityX128),
            initialized: true
        };
    }
    
    /**
     * Get pool information
     */
    getPoolInfo() {
        return {
            poolId: this.poolId,
            token0: this.options.token0,
            token1: this.options.token1,
            feeTier: this.options.feeTier,
            reserve0: this.reserve0.toString(),
            reserve1: this.reserve1.toString(),
            totalSupply: this.totalSupply.toString(),
            liquidity: this.liquidity.toString(),
            sqrtPriceX96: this.sqrtPriceX96.toString(),
            currentTick: this.currentTick,
            stats: {
                ...this.stats,
                totalVolume0: this.stats.totalVolume0.toString(),
                totalVolume1: this.stats.totalVolume1.toString(),
                totalFees0: this.stats.totalFees0.toString(),
                totalFees1: this.stats.totalFees1.toString(),
                liquidityProviders: this.stats.liquidityProviders.size
            }
        };
    }
    
    /**
     * Utility methods
     */
    
    generatePoolId() {
        const data = `${this.options.token0}-${this.options.token1}-${this.options.feeTier}`;
        return createHash('sha256').update(data).digest('hex').substr(0, 16);
    }
    
    getPositionKey(owner, tickLower, tickUpper) {
        return `${owner}-${tickLower}-${tickUpper}`;
    }
    
    getTickAtSqrtRatio(sqrtPriceX96) {
        // Simplified - in production would be more precise
        return Math.floor(Math.log(sqrtPriceX96.toNumber() / (2 ** 96)) * 2 / Math.log(1.0001));
    }
    
    getLiquidityForAmounts(sqrtPriceX96, tickLower, tickUpper, amount0, amount1) {
        // Simplified calculation
        const price = sqrtPriceX96.mul(sqrtPriceX96).div(new BN(2).pow(new BN(192)));
        return amount0.add(amount1.mul(price));
    }
    
    getAmountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, liquidity) {
        // Simplified calculation
        const price = sqrtPriceX96.mul(sqrtPriceX96).div(new BN(2).pow(new BN(192)));
        const amount0 = liquidity.div(new BN(2));
        const amount1 = liquidity.sub(amount0).div(price.add(new BN(1)));
        
        return { amount0, amount1 };
    }
    
    calculateNewSqrtPrice(zeroForOne, amountIn, amountOut) {
        // Simplified - in production would be more precise
        const newReserve0 = zeroForOne
            ? this.reserve0.add(amountIn)
            : this.reserve0.sub(amountOut);
        const newReserve1 = zeroForOne
            ? this.reserve1.sub(amountOut)
            : this.reserve1.add(amountIn);
        
        const newPrice = newReserve1.mul(new BN(2).pow(new BN(192))).div(newReserve0);
        return newPrice.sqrt();
    }
    
    collectFees(position, tickLower, tickUpper) {
        // Calculate fees owed to position
        const feeGrowthInside = this.getFeeGrowthInside(tickLower, tickUpper);
        
        const fees0 = position.liquidity
            .mul(feeGrowthInside.feeGrowthInside0X128.sub(position.feeGrowthInside0LastX128))
            .shrn(128);
        
        const fees1 = position.liquidity
            .mul(feeGrowthInside.feeGrowthInside1X128.sub(position.feeGrowthInside1LastX128))
            .shrn(128);
        
        position.feeGrowthInside0LastX128 = feeGrowthInside.feeGrowthInside0X128;
        position.feeGrowthInside1LastX128 = feeGrowthInside.feeGrowthInside1X128;
        
        return {
            amount0: fees0.add(position.tokensOwed0),
            amount1: fees1.add(position.tokensOwed1)
        };
    }
    
    getFeeGrowthInside(tickLower, tickUpper) {
        // Simplified - in production would account for tick state
        return {
            feeGrowthInside0X128: this.feeGrowthGlobal0X128,
            feeGrowthInside1X128: this.feeGrowthGlobal1X128
        };
    }
}

export default LiquidityPool;