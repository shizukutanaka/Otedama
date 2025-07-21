/**
 * AMM Optimizer
 * Integrates concentrated liquidity, dynamic fees, and MEV protection
 */

import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import ConcentratedLiquidityPool from './concentrated-liquidity.js';
import DynamicFeeManager from './dynamic-fee.js';
import MEVProtection from './mev-protection.js';

export class AMMOptimizer extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            enableConcentratedLiquidity: config.enableConcentratedLiquidity ?? true,
            enableDynamicFees: config.enableDynamicFees ?? true,
            enableMEVProtection: config.enableMEVProtection ?? true,
            
            // Pool configuration
            defaultFeeTiers: config.defaultFeeTiers || [100, 500, 3000, 10000],
            defaultTickSpacing: config.defaultTickSpacing || 60,
            
            // Optimization parameters
            routingMaxHops: config.routingMaxHops || 3,
            routingMaxPools: config.routingMaxPools || 5,
            priceImpactThreshold: config.priceImpactThreshold || 100, // 1%
            
            // Gas optimization
            gasEstimateBuffer: config.gasEstimateBuffer || 1.2,
            maxGasPrice: config.maxGasPrice || 500e9, // 500 gwei
            
            ...config
        };
        
        // Component instances
        this.pools = new Map();
        this.feeManagers = new Map();
        this.mevProtection = null;
        
        // Routing cache
        this.routeCache = new Map();
        this.routeCacheTimeout = 60000; // 1 minute
        
        // Metrics
        this.metrics = {
            totalPools: 0,
            totalSwaps: 0,
            totalVolume: 0n,
            avgGasUsed: 0,
            routeCacheHits: 0,
            routeCacheMisses: 0
        };
        
        this.initialize();
    }

    /**
     * Initialize optimizer components
     */
    initialize() {
        // Initialize MEV protection
        if (this.config.enableMEVProtection) {
            this.mevProtection = new MEVProtection({
                commitDelay: this.config.commitDelay,
                batchInterval: this.config.batchInterval
            });
            
            this.mevProtection.on('batchProcessed', (data) => {
                this.processMEVBatch(data);
            });
        }
        
        this.emit('initialized', {
            features: {
                concentratedLiquidity: this.config.enableConcentratedLiquidity,
                dynamicFees: this.config.enableDynamicFees,
                mevProtection: this.config.enableMEVProtection
            }
        });
    }

    /**
     * Create optimized pool
     */
    async createPool(token0, token1, config = {}) {
        const poolId = this.getPoolId(token0, token1);
        
        if (this.pools.has(poolId)) {
            throw new Error('Pool already exists');
        }
        
        // Create concentrated liquidity pool
        const pool = new ConcentratedLiquidityPool(token0, token1, {
            feeTiers: config.feeTiers || this.config.defaultFeeTiers,
            tickSpacing: config.tickSpacing || this.config.defaultTickSpacing,
            ...config
        });
        
        // Initialize with starting price
        if (config.sqrtPriceX96) {
            await pool.initialize(config.sqrtPriceX96);
        }
        
        // Setup dynamic fee manager
        if (this.config.enableDynamicFees) {
            const feeManager = new DynamicFeeManager({
                baseFee: config.baseFee || 30,
                minFee: config.minFee || 5,
                maxFee: config.maxFee || 100
            });
            
            // Connect fee manager to pool
            feeManager.on('feeUpdated', (data) => {
                this.updatePoolFee(poolId, data.newFee);
            });
            
            this.feeManagers.set(poolId, feeManager);
        }
        
        // Store pool
        this.pools.set(poolId, pool);
        this.metrics.totalPools++;
        
        // Setup event handlers
        this.setupPoolEventHandlers(poolId, pool);
        
        this.emit('poolCreated', {
            poolId,
            token0,
            token1,
            features: {
                concentratedLiquidity: true,
                dynamicFees: this.config.enableDynamicFees
            }
        });
        
        return {
            poolId,
            pool,
            feeManager: this.feeManagers.get(poolId)
        };
    }

    /**
     * Execute optimized swap
     */
    async swap(params) {
        const startTime = performance.now();
        
        // Validate parameters
        this.validateSwapParams(params);
        
        let swapData = params;
        
        // Apply MEV protection if enabled
        if (this.config.enableMEVProtection && !params.skipMEVProtection) {
            const commitment = await this.mevProtection.commitSwap(
                params,
                params.userSecret || this.generateUserSecret()
            );
            
            // Wait for commit delay
            await this.wait(this.mevProtection.config.commitDelay);
            
            // Reveal swap
            const revealed = await this.mevProtection.revealSwap(
                commitment.commitHash,
                params,
                params.userSecret
            );
            
            // Wait for batch execution
            return {
                status: 'queued',
                commitment,
                revealed,
                estimatedExecution: revealed.estimatedExecution
            };
        }
        
        // Find optimal route
        const route = await this.findOptimalRoute(
            swapData.tokenIn,
            swapData.tokenOut,
            swapData.amountIn,
            swapData.amountOut
        );
        
        if (!route) {
            throw new Error('No route found');
        }
        
        // Check price impact
        const priceImpact = this.calculatePriceImpact(route);
        if (priceImpact > this.config.priceImpactThreshold) {
            throw new Error(`Price impact too high: ${priceImpact}%`);
        }
        
        // Execute swap through route
        const result = await this.executeRoute(route, swapData);
        
        // Update metrics
        this.metrics.totalSwaps++;
        this.metrics.totalVolume += BigInt(swapData.amountIn || 0);
        
        const gasUsed = this.estimateGas(route);
        this.metrics.avgGasUsed = 
            (this.metrics.avgGasUsed * (this.metrics.totalSwaps - 1) + gasUsed) / 
            this.metrics.totalSwaps;
        
        const executionTime = performance.now() - startTime;
        
        this.emit('swapExecuted', {
            ...result,
            route,
            priceImpact,
            executionTime,
            gasEstimate: gasUsed
        });
        
        return result;
    }

    /**
     * Find optimal route for swap
     */
    async findOptimalRoute(tokenIn, tokenOut, amountIn, amountOut) {
        const cacheKey = `${tokenIn}-${tokenOut}-${amountIn || 'output'}-${amountOut || 'input'}`;
        
        // Check cache
        const cached = this.routeCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.routeCacheTimeout) {
            this.metrics.routeCacheHits++;
            return cached.route;
        }
        
        this.metrics.routeCacheMisses++;
        
        // Find all possible routes
        const routes = await this.findAllRoutes(tokenIn, tokenOut);
        
        // Score and rank routes
        const scoredRoutes = await Promise.all(
            routes.map(route => this.scoreRoute(route, amountIn, amountOut))
        );
        
        // Sort by score (higher is better)
        scoredRoutes.sort((a, b) => b.score - a.score);
        
        // Select best route
        const bestRoute = scoredRoutes[0];
        
        if (!bestRoute || bestRoute.score <= 0) {
            return null;
        }
        
        // Cache route
        this.routeCache.set(cacheKey, {
            route: bestRoute,
            timestamp: Date.now()
        });
        
        // Clean old cache entries
        this.cleanRouteCache();
        
        return bestRoute;
    }

    /**
     * Find all possible routes
     */
    async findAllRoutes(tokenIn, tokenOut, currentPath = [], depth = 0) {
        if (depth > this.config.routingMaxHops) {
            return [];
        }
        
        const routes = [];
        const lastToken = currentPath.length > 0 
            ? currentPath[currentPath.length - 1].tokenOut 
            : tokenIn;
        
        // Direct route
        const directPoolId = this.getPoolId(lastToken, tokenOut);
        if (this.pools.has(directPoolId)) {
            routes.push([
                ...currentPath,
                {
                    poolId: directPoolId,
                    tokenIn: lastToken,
                    tokenOut: tokenOut,
                    pool: this.pools.get(directPoolId)
                }
            ]);
        }
        
        // Multi-hop routes
        if (depth < this.config.routingMaxHops - 1) {
            const intermediateTokens = this.getIntermediateTokens(lastToken, tokenOut);
            
            for (const intermediate of intermediateTokens) {
                const poolId = this.getPoolId(lastToken, intermediate);
                
                if (this.pools.has(poolId) && !this.pathContainsPool(currentPath, poolId)) {
                    const hop = {
                        poolId,
                        tokenIn: lastToken,
                        tokenOut: intermediate,
                        pool: this.pools.get(poolId)
                    };
                    
                    const subRoutes = await this.findAllRoutes(
                        tokenIn,
                        tokenOut,
                        [...currentPath, hop],
                        depth + 1
                    );
                    
                    routes.push(...subRoutes);
                }
            }
        }
        
        return routes.slice(0, this.config.routingMaxPools);
    }

    /**
     * Score a route based on expected output and gas cost
     */
    async scoreRoute(route, amountIn, amountOut) {
        let currentAmount = BigInt(amountIn || 0);
        let totalGas = 0;
        let totalFees = 0;
        
        // Simulate swap through route
        for (const hop of route.path) {
            const pool = hop.pool;
            const feeManager = this.feeManagers.get(hop.poolId);
            
            // Get current fee
            const fee = feeManager ? feeManager.currentFee : 30;
            
            // Calculate output for this hop
            const output = await this.simulateSwap(
                pool,
                hop.tokenIn === pool.token0,
                currentAmount,
                fee
            );
            
            currentAmount = output.amountOut;
            totalGas += this.estimatePoolGas(pool);
            totalFees += fee;
        }
        
        // Calculate score
        let score = 0;
        
        if (amountOut) {
            // For exact output, minimize input
            score = 1e18 / Number(currentAmount);
        } else {
            // For exact input, maximize output
            score = Number(currentAmount);
        }
        
        // Penalize for gas cost
        const gasPenalty = totalGas * this.getGasPrice() / 1e9;
        score -= gasPenalty;
        
        // Penalize for high fees
        score *= (1 - totalFees / 10000);
        
        // Penalize for long routes
        score *= Math.pow(0.98, route.path.length - 1);
        
        return {
            path: route.path,
            score,
            expectedOutput: currentAmount,
            totalGas,
            totalFees,
            priceImpact: this.calculateRouteImpact(route, amountIn)
        };
    }

    /**
     * Execute swap through route
     */
    async executeRoute(route, params) {
        const results = [];
        let currentAmount = BigInt(params.amountIn || 0);
        let currentToken = params.tokenIn;
        
        for (const hop of route.path) {
            const pool = hop.pool;
            const zeroForOne = currentToken === pool.token0;
            
            // Record trade for dynamic fees
            const feeManager = this.feeManagers.get(hop.poolId);
            if (feeManager) {
                const price = pool.getPriceFromSqrtRatio(pool.sqrtPriceX96);
                feeManager.recordTrade(price, Number(currentAmount));
            }
            
            // Execute swap
            const result = await pool.swap(
                params.recipient || params.from,
                zeroForOne,
                currentAmount,
                0n, // No price limit for now
                { deadline: params.deadline }
            );
            
            results.push({
                pool: hop.poolId,
                amountIn: currentAmount,
                amountOut: zeroForOne ? -result.amount1 : -result.amount0
            });
            
            currentAmount = zeroForOne ? -result.amount1 : -result.amount0;
            currentToken = hop.tokenOut;
        }
        
        return {
            success: true,
            route: route.path.map(h => h.poolId),
            amountIn: params.amountIn,
            amountOut: currentAmount,
            hops: results
        };
    }

    /**
     * Process MEV batch
     */
    async processMEVBatch(batchData) {
        const results = [];
        
        for (const item of batchData.results) {
            if (item.success) {
                try {
                    const swapResult = await this.swap({
                        ...item.params,
                        skipMEVProtection: true
                    });
                    
                    results.push({
                        commitHash: item.commitHash,
                        ...swapResult
                    });
                } catch (error) {
                    results.push({
                        commitHash: item.commitHash,
                        success: false,
                        error: error.message
                    });
                }
            }
        }
        
        this.emit('mevBatchExecuted', {
            batchId: batchData.batchId,
            results
        });
    }

    /**
     * Add liquidity with optimization
     */
    async addLiquidity(params) {
        const poolId = this.getPoolId(params.token0, params.token1);
        const pool = this.pools.get(poolId);
        
        if (!pool) {
            throw new Error('Pool not found');
        }
        
        // Find optimal range based on current price and volatility
        const optimalRange = await this.findOptimalRange(pool, params.amount0, params.amount1);
        
        // Add liquidity
        const result = await pool.mint(
            params.recipient || params.from,
            optimalRange.tickLower,
            optimalRange.tickUpper,
            optimalRange.liquidity
        );
        
        // Record position for JIT protection
        if (this.mevProtection) {
            this.mevProtection.recordLiquidityPosition(result.positionId);
        }
        
        this.emit('liquidityAdded', {
            poolId,
            positionId: result.positionId,
            range: optimalRange,
            amounts: {
                amount0: result.amount0,
                amount1: result.amount1
            }
        });
        
        return result;
    }

    /**
     * Find optimal liquidity range
     */
    async findOptimalRange(pool, amount0, amount1) {
        const currentTick = pool.tick;
        const tickSpacing = pool.config.tickSpacing;
        
        // Get volatility from fee manager
        const feeManager = this.feeManagers.get(this.getPoolIdFromPool(pool));
        const volatility = feeManager ? feeManager.metrics.volatility : 0.3;
        
        // Calculate range based on volatility
        const rangeMultiplier = 1 + (2 * volatility);
        const tickRange = Math.floor(rangeMultiplier * 1000 / tickSpacing) * tickSpacing;
        
        const tickLower = Math.floor((currentTick - tickRange) / tickSpacing) * tickSpacing;
        const tickUpper = Math.ceil((currentTick + tickRange) / tickSpacing) * tickSpacing;
        
        // Calculate liquidity for range
        const sqrtRatioA = pool.getSqrtRatioAtTick(tickLower);
        const sqrtRatioB = pool.getSqrtRatioAtTick(tickUpper);
        const sqrtRatioX = pool.sqrtPriceX96;
        
        // Calculate liquidity from amounts
        const liquidity0 = this.getLiquidityForAmount0(sqrtRatioA, sqrtRatioB, amount0);
        const liquidity1 = this.getLiquidityForAmount1(sqrtRatioA, sqrtRatioB, amount1);
        
        const liquidity = currentTick < tickLower 
            ? liquidity0
            : currentTick < tickUpper
            ? BigInt(Math.min(Number(liquidity0), Number(liquidity1)))
            : liquidity1;
        
        return {
            tickLower,
            tickUpper,
            liquidity,
            range: tickRange * 2
        };
    }

    /**
     * Helper functions
     */
    getPoolId(token0, token1) {
        return token0 < token1 
            ? `${token0}-${token1}` 
            : `${token1}-${token0}`;
    }

    getPoolIdFromPool(pool) {
        return this.getPoolId(pool.token0, pool.token1);
    }

    getIntermediateTokens(tokenIn, tokenOut) {
        // Common routing tokens
        const commonTokens = ['BTC', 'ETH', 'USDC', 'USDT', 'DAI'];
        
        return commonTokens.filter(token => 
            token !== tokenIn && 
            token !== tokenOut &&
            (this.pools.has(this.getPoolId(tokenIn, token)) ||
             this.pools.has(this.getPoolId(token, tokenOut)))
        );
    }

    pathContainsPool(path, poolId) {
        return path.some(hop => hop.poolId === poolId);
    }

    async simulateSwap(pool, zeroForOne, amountIn, fee) {
        // Simplified simulation
        const amountWithFee = (amountIn * BigInt(1000000 - fee)) / 1000000n;
        const price = pool.getPriceFromSqrtRatio(pool.sqrtPriceX96);
        
        const amountOut = zeroForOne
            ? amountWithFee * BigInt(Math.floor(price * 1e18)) / BigInt(1e18)
            : amountWithFee * BigInt(1e18) / BigInt(Math.floor(price * 1e18));
        
        return { amountOut };
    }

    calculatePriceImpact(route) {
        // Simplified calculation
        const totalLiquidity = route.path.reduce((sum, hop) => 
            sum + Number(hop.pool.liquidity), 0
        );
        
        const avgLiquidity = totalLiquidity / route.path.length;
        const impact = Number(route.expectedOutput) / avgLiquidity * 100;
        
        return Math.min(impact, 100);
    }

    calculateRouteImpact(route, amountIn) {
        return this.calculatePriceImpact({ 
            path: route.path, 
            expectedOutput: amountIn 
        });
    }

    estimateGas(route) {
        return route.path.reduce((sum, hop) => 
            sum + this.estimatePoolGas(hop.pool), 0
        );
    }

    estimatePoolGas(pool) {
        // Base gas + tick crosses
        return 150000 + (pool.liquidity > 0n ? 50000 : 0);
    }

    getGasPrice() {
        // Simplified - would fetch from network
        return 20e9; // 20 gwei
    }

    updatePoolFee(poolId, newFee) {
        // Update pool fee tier
        // In production, would update pool contract
        this.emit('poolFeeUpdated', { poolId, newFee });
    }

    setupPoolEventHandlers(poolId, pool) {
        pool.on('swap', (data) => {
            this.emit('poolSwap', { poolId, ...data });
        });
        
        pool.on('mint', (data) => {
            this.emit('poolMint', { poolId, ...data });
        });
        
        pool.on('burn', (data) => {
            this.emit('poolBurn', { poolId, ...data });
        });
    }

    validateSwapParams(params) {
        if (!params.tokenIn || !params.tokenOut) {
            throw new Error('Missing token parameters');
        }
        
        if (!params.amountIn && !params.amountOut) {
            throw new Error('Must specify either amountIn or amountOut');
        }
        
        if (params.amountIn && params.amountOut) {
            throw new Error('Cannot specify both amountIn and amountOut');
        }
    }

    generateUserSecret() {
        return randomBytes(32).toString('hex');
    }

    async wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    cleanRouteCache() {
        const now = Date.now();
        const expired = [];
        
        for (const [key, value] of this.routeCache) {
            if (now - value.timestamp > this.routeCacheTimeout) {
                expired.push(key);
            }
        }
        
        expired.forEach(key => this.routeCache.delete(key));
    }

    getLiquidityForAmount0(sqrtRatioAX96, sqrtRatioBX96, amount0) {
        if (sqrtRatioAX96 > sqrtRatioBX96) {
            [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
        }
        
        return (amount0 * sqrtRatioAX96 * sqrtRatioBX96) / 
               ((sqrtRatioBX96 - sqrtRatioAX96) << 96n);
    }

    getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioBX96, amount1) {
        if (sqrtRatioAX96 > sqrtRatioBX96) {
            [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
        }
        
        return (amount1 << 96n) / (sqrtRatioBX96 - sqrtRatioAX96);
    }

    /**
     * Get optimizer metrics
     */
    getMetrics() {
        const poolMetrics = {};
        
        for (const [poolId, pool] of this.pools) {
            poolMetrics[poolId] = pool.getMetrics();
        }
        
        return {
            global: this.metrics,
            pools: poolMetrics,
            mevProtection: this.mevProtection?.getMetrics(),
            features: {
                concentratedLiquidity: this.config.enableConcentratedLiquidity,
                dynamicFees: this.config.enableDynamicFees,
                mevProtection: this.config.enableMEVProtection
            }
        };
    }

    /**
     * Cleanup
     */
    destroy() {
        // Stop all fee managers
        for (const manager of this.feeManagers.values()) {
            manager.destroy();
        }
        
        // Stop MEV protection
        if (this.mevProtection) {
            this.mevProtection.stop();
        }
        
        // Clear caches
        this.routeCache.clear();
        
        // Remove all listeners
        this.removeAllListeners();
    }
}

export default AMMOptimizer;