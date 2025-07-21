/**
 * Automated Market Maker Engine
 * Manages multiple liquidity pools and routing
 */

import { EventEmitter } from 'events';
import { LiquidityPool } from './liquidity-pool.js';
import BN from 'bn.js';
import { getLogger } from '../core/logger.js';

// Supported DEX protocols
export const AMMProtocol = {
    UNISWAP_V3: 'uniswap-v3',
    CURVE: 'curve',
    BALANCER: 'balancer',
    CONSTANT_PRODUCT: 'constant-product'
};

// Route finding algorithms
export const RoutingAlgorithm = {
    SHORTEST_PATH: 'shortest-path',
    LOWEST_SLIPPAGE: 'lowest-slippage',
    BEST_PRICE: 'best-price',
    MULTI_HOP: 'multi-hop'
};

export class AMMEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.logger = getLogger('AMMEngine');
        this.options = {
            maxHops: options.maxHops || 3,
            defaultSlippageTolerance: options.defaultSlippageTolerance || 0.005, // 0.5%
            routingAlgorithm: options.routingAlgorithm || RoutingAlgorithm.BEST_PRICE,
            enableArbitrage: options.enableArbitrage !== false,
            gasOptimization: options.gasOptimization !== false,
            ...options
        };
        
        // Pool management
        this.pools = new Map();
        this.tokenPools = new Map(); // token -> pool mappings
        this.routingGraph = new Map();
        
        // Price feeds and oracles
        this.priceFeeds = new Map();
        this.priceCache = new Map();
        
        // MEV and arbitrage
        this.arbitrageOpportunities = [];
        this.mevProtection = {
            enabled: true,
            maxPriceImpact: 0.1, // 10%
            frontRunningDetection: true
        };
        
        // Statistics
        this.stats = {
            totalPools: 0,
            totalTVL: new BN(0),
            totalVolume24h: new BN(0),
            totalFees24h: new BN(0),
            activeRoutes: 0,
            arbitrageProfit: new BN(0)
        };
    }
    
    /**
     * Create a new liquidity pool
     */
    async createPool(token0, token1, feeTier, initialPrice) {
        const poolKey = this.getPoolKey(token0, token1, feeTier);
        
        if (this.pools.has(poolKey)) {
            throw new Error('Pool already exists');
        }
        
        const pool = new LiquidityPool({
            token0,
            token1,
            feeTier,
            concentratedLiquidity: true,
            oracleEnabled: true
        });
        
        // Initialize pool if price provided
        if (initialPrice) {
            await pool.initialize(initialPrice);
        }
        
        // Store pool
        this.pools.set(poolKey, pool);
        
        // Update token mappings
        this.addTokenMapping(token0, poolKey);
        this.addTokenMapping(token1, poolKey);
        
        // Update routing graph
        this.updateRoutingGraph(token0, token1, poolKey);
        
        // Setup event listeners
        this.setupPoolEventListeners(pool);
        
        this.stats.totalPools++;
        
        this.logger.info(`Pool created: ${token0}/${token1} (${feeTier})`);
        this.emit('poolCreated', {
            poolId: pool.poolId,
            token0,
            token1,
            feeTier
        });
        
        return pool;
    }
    
    /**
     * Find best route for token swap
     */
    async findBestRoute(tokenIn, tokenOut, amountIn, options = {}) {
        const routes = await this.findAllRoutes(tokenIn, tokenOut, options.maxHops || this.options.maxHops);
        
        if (routes.length === 0) {
            throw new Error('No route found');
        }
        
        // Evaluate routes based on algorithm
        let bestRoute;
        
        switch (this.options.routingAlgorithm) {
            case RoutingAlgorithm.BEST_PRICE:
                bestRoute = await this.findBestPriceRoute(routes, amountIn);
                break;
                
            case RoutingAlgorithm.LOWEST_SLIPPAGE:
                bestRoute = await this.findLowestSlippageRoute(routes, amountIn);
                break;
                
            case RoutingAlgorithm.SHORTEST_PATH:
                bestRoute = routes.sort((a, b) => a.path.length - b.path.length)[0];
                break;
                
            default:
                bestRoute = await this.findBestPriceRoute(routes, amountIn);
        }
        
        return bestRoute;
    }
    
    /**
     * Execute swap with optimal routing
     */
    async executeSwap(trader, tokenIn, tokenOut, amountIn, minAmountOut, options = {}) {
        // Find best route
        const route = await this.findBestRoute(tokenIn, tokenOut, amountIn, options);
        
        if (!route) {
            throw new Error('No viable route found');
        }
        
        // Calculate expected output
        const { amountOut, priceImpact } = await this.calculateSwapOutput(route, amountIn);
        
        // Check slippage tolerance
        const slippageTolerance = options.slippageTolerance || this.options.defaultSlippageTolerance;
        const minOutput = new BN(minAmountOut || amountOut.mul(new BN(10000 - slippageTolerance * 10000)).div(new BN(10000)));
        
        if (amountOut.lt(minOutput)) {
            throw new Error('Insufficient output amount (slippage)');
        }
        
        // MEV protection
        if (this.mevProtection.enabled && priceImpact > this.mevProtection.maxPriceImpact) {
            throw new Error('Price impact too high');
        }
        
        // Execute swap through route
        const result = await this.executeRouteSwap(trader, route, amountIn, minOutput);
        
        // Update statistics
        this.updateSwapStats(tokenIn, tokenOut, amountIn, result.amountOut);
        
        // Check for arbitrage opportunities
        if (this.options.enableArbitrage) {
            this.detectArbitrageOpportunities(tokenIn, tokenOut);
        }
        
        this.emit('swapExecuted', {
            trader,
            tokenIn,
            tokenOut,
            amountIn: amountIn.toString(),
            amountOut: result.amountOut.toString(),
            route: route.path,
            priceImpact
        });
        
        return result;
    }
    
    /**
     * Execute multi-hop swap through route
     */
    async executeRouteSwap(trader, route, amountIn, minAmountOut) {
        let currentAmount = new BN(amountIn);
        let totalFees = new BN(0);
        const swapResults = [];
        
        for (let i = 0; i < route.pools.length; i++) {
            const pool = this.pools.get(route.pools[i]);
            const tokenIn = route.path[i];
            const tokenOut = route.path[i + 1];
            
            // Calculate minimum output for this hop
            const isLastHop = i === route.pools.length - 1;
            const minOutput = isLastHop ? minAmountOut : new BN(0);
            
            // Execute swap on pool
            const swapResult = await pool.swap(trader, tokenIn, currentAmount.toString(), minOutput.toString());
            
            currentAmount = new BN(swapResult.amountOut);
            totalFees = totalFees.add(new BN(swapResult.fee));
            
            swapResults.push({
                pool: pool.poolId,
                tokenIn,
                tokenOut,
                amountIn: i === 0 ? amountIn.toString() : swapResults[i - 1].amountOut,
                amountOut: swapResult.amountOut,
                fee: swapResult.fee,
                priceImpact: swapResult.priceImpact
            });
        }
        
        return {
            amountOut: currentAmount.toString(),
            totalFees: totalFees.toString(),
            swaps: swapResults,
            route: route.path
        };
    }
    
    /**
     * Add liquidity across multiple pools
     */
    async addLiquidityMultiPool(provider, positions) {
        const results = [];
        
        for (const position of positions) {
            const { token0, token1, feeTier, amount0, amount1, tickLower, tickUpper } = position;
            const poolKey = this.getPoolKey(token0, token1, feeTier);
            const pool = this.pools.get(poolKey);
            
            if (!pool) {
                throw new Error(`Pool not found: ${token0}/${token1}`);
            }
            
            const result = await pool.addLiquidity(
                provider,
                amount0,
                amount1,
                tickLower,
                tickUpper
            );
            
            results.push({
                pool: poolKey,
                ...result
            });
        }
        
        // Update total TVL
        this.updateTVL();
        
        return results;
    }
    
    /**
     * Flash loan across pools
     */
    async flashLoanMultiPool(borrower, loans, callback) {
        const activeLoan = {
            borrower,
            loans: [],
            startTime: Date.now()
        };
        
        try {
            // Execute flash loans
            for (const loan of loans) {
                const { token0, token1, feeTier, token, amount } = loan;
                const poolKey = this.getPoolKey(token0, token1, feeTier);
                const pool = this.pools.get(poolKey);
                
                if (!pool) {
                    throw new Error(`Pool not found: ${token0}/${token1}`);
                }
                
                const loanResult = await pool.flashLoan(borrower, token, amount, loan.data);
                activeLoan.loans.push({
                    pool: poolKey,
                    token,
                    amount,
                    fee: loanResult.fee
                });
            }
            
            // Execute callback with borrowed funds
            const callbackResult = await callback(activeLoan);
            
            this.emit('flashLoanExecuted', {
                borrower,
                loans: activeLoan.loans,
                totalFees: activeLoan.loans.reduce((sum, loan) => sum.add(new BN(loan.fee)), new BN(0)).toString()
            });
            
            return {
                success: true,
                loans: activeLoan.loans,
                result: callbackResult
            };
            
        } catch (error) {
            this.logger.error('Flash loan failed:', error);
            throw error;
        }
    }
    
    /**
     * Detect arbitrage opportunities
     */
    detectArbitrageOpportunities(token0, token1) {
        const pools = this.getPoolsForTokenPair(token0, token1);
        
        if (pools.length < 2) {
            return;
        }
        
        // Check price differences between pools
        for (let i = 0; i < pools.length; i++) {
            for (let j = i + 1; j < pools.length; j++) {
                const pool1 = this.pools.get(pools[i]);
                const pool2 = this.pools.get(pools[j]);
                
                const price1 = this.getPoolPrice(pool1, token0, token1);
                const price2 = this.getPoolPrice(pool2, token0, token1);
                
                const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);
                
                if (priceDiff > 0.001) { // 0.1% threshold
                    this.arbitrageOpportunities.push({
                        token0,
                        token1,
                        pool1: pools[i],
                        pool2: pools[j],
                        price1,
                        price2,
                        priceDiff,
                        timestamp: Date.now()
                    });
                    
                    this.emit('arbitrageOpportunity', {
                        token0,
                        token1,
                        priceDiff,
                        pools: [pools[i], pools[j]]
                    });
                }
            }
        }
    }
    
    /**
     * Find all possible routes between tokens
     */
    async findAllRoutes(tokenIn, tokenOut, maxHops, visited = new Set(), currentPath = []) {
        if (maxHops <= 0 || visited.has(tokenIn)) {
            return [];
        }
        
        visited.add(tokenIn);
        currentPath.push(tokenIn);
        
        const routes = [];
        
        // Direct route
        const directPools = this.getPoolsForTokenPair(tokenIn, tokenOut);
        for (const poolKey of directPools) {
            routes.push({
                path: [...currentPath, tokenOut],
                pools: [poolKey],
                hops: 1
            });
        }
        
        // Multi-hop routes
        if (maxHops > 1) {
            const intermediateTokens = this.getConnectedTokens(tokenIn);
            
            for (const intermediateToken of intermediateTokens) {
                if (!visited.has(intermediateToken) && intermediateToken !== tokenOut) {
                    const subRoutes = await this.findAllRoutes(
                        intermediateToken,
                        tokenOut,
                        maxHops - 1,
                        new Set(visited),
                        [...currentPath]
                    );
                    
                    const connectionPools = this.getPoolsForTokenPair(tokenIn, intermediateToken);
                    
                    for (const poolKey of connectionPools) {
                        for (const subRoute of subRoutes) {
                            routes.push({
                                path: [tokenIn, ...subRoute.path],
                                pools: [poolKey, ...subRoute.pools],
                                hops: subRoute.hops + 1
                            });
                        }
                    }
                }
            }
        }
        
        return routes;
    }
    
    /**
     * Find best price route
     */
    async findBestPriceRoute(routes, amountIn) {
        let bestRoute = null;
        let bestAmountOut = new BN(0);
        
        for (const route of routes) {
            try {
                const { amountOut } = await this.calculateSwapOutput(route, amountIn);
                
                if (amountOut.gt(bestAmountOut)) {
                    bestAmountOut = amountOut;
                    bestRoute = route;
                }
            } catch (error) {
                // Skip invalid routes
                continue;
            }
        }
        
        return bestRoute;
    }
    
    /**
     * Calculate swap output for route
     */
    async calculateSwapOutput(route, amountIn) {
        let currentAmount = new BN(amountIn);
        let totalPriceImpact = 0;
        
        for (let i = 0; i < route.pools.length; i++) {
            const pool = this.pools.get(route.pools[i]);
            const tokenIn = route.path[i];
            
            // Simulate swap to get output
            const swapResult = pool.computeSwap(
                tokenIn === pool.options.token0,
                currentAmount
            );
            
            currentAmount = swapResult.amountOut;
            totalPriceImpact += swapResult.priceImpact;
        }
        
        return {
            amountOut: currentAmount,
            priceImpact: totalPriceImpact
        };
    }
    
    /**
     * Get all pools for a token pair
     */
    getPoolsForTokenPair(token0, token1) {
        const pools = [];
        
        for (const [poolKey, pool] of this.pools) {
            if ((pool.options.token0 === token0 && pool.options.token1 === token1) ||
                (pool.options.token0 === token1 && pool.options.token1 === token0)) {
                pools.push(poolKey);
            }
        }
        
        return pools;
    }
    
    /**
     * Get connected tokens for routing
     */
    getConnectedTokens(token) {
        const connected = new Set();
        
        for (const [poolKey, pool] of this.pools) {
            if (pool.options.token0 === token) {
                connected.add(pool.options.token1);
            } else if (pool.options.token1 === token) {
                connected.add(pool.options.token0);
            }
        }
        
        return Array.from(connected);
    }
    
    /**
     * Get pool price
     */
    getPoolPrice(pool, token0, token1) {
        const info = pool.getPoolInfo();
        const price = new BN(info.reserve1).div(new BN(info.reserve0));
        
        return pool.options.token0 === token0
            ? price.toNumber()
            : 1 / price.toNumber();
    }
    
    /**
     * Utility methods
     */
    
    getPoolKey(token0, token1, feeTier) {
        const sortedTokens = [token0, token1].sort();
        return `${sortedTokens[0]}-${sortedTokens[1]}-${feeTier}`;
    }
    
    addTokenMapping(token, poolKey) {
        if (!this.tokenPools.has(token)) {
            this.tokenPools.set(token, new Set());
        }
        this.tokenPools.get(token).add(poolKey);
    }
    
    updateRoutingGraph(token0, token1, poolKey) {
        if (!this.routingGraph.has(token0)) {
            this.routingGraph.set(token0, new Map());
        }
        if (!this.routingGraph.has(token1)) {
            this.routingGraph.set(token1, new Map());
        }
        
        this.routingGraph.get(token0).set(token1, poolKey);
        this.routingGraph.get(token1).set(token0, poolKey);
    }
    
    setupPoolEventListeners(pool) {
        pool.on('swap', (data) => {
            this.emit('poolSwap', { poolId: pool.poolId, ...data });
        });
        
        pool.on('liquidityAdded', (data) => {
            this.emit('poolLiquidityAdded', { poolId: pool.poolId, ...data });
            this.updateTVL();
        });
        
        pool.on('liquidityRemoved', (data) => {
            this.emit('poolLiquidityRemoved', { poolId: pool.poolId, ...data });
            this.updateTVL();
        });
    }
    
    updateTVL() {
        let totalTVL = new BN(0);
        
        for (const pool of this.pools.values()) {
            const info = pool.getPoolInfo();
            // Simplified TVL calculation - in production would use USD values
            totalTVL = totalTVL.add(new BN(info.reserve0)).add(new BN(info.reserve1));
        }
        
        this.stats.totalTVL = totalTVL;
    }
    
    updateSwapStats(tokenIn, tokenOut, amountIn, amountOut) {
        // Update 24h volume - simplified
        this.stats.totalVolume24h = this.stats.totalVolume24h.add(new BN(amountIn));
    }
    
    /**
     * Get engine statistics
     */
    getStats() {
        return {
            ...this.stats,
            totalTVL: this.stats.totalTVL.toString(),
            totalVolume24h: this.stats.totalVolume24h.toString(),
            totalFees24h: this.stats.totalFees24h.toString(),
            arbitrageProfit: this.stats.arbitrageProfit.toString(),
            arbitrageOpportunities: this.arbitrageOpportunities.length
        };
    }
}

export default AMMEngine;