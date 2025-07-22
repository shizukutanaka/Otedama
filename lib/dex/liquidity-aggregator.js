/**
 * Liquidity Aggregator for Otedama DEX
 * Aggregates liquidity from multiple sources for optimal trade execution
 * 
 * Design principles:
 * - Performance-first approach (Carmack)
 * - Clean architecture with clear interfaces (Martin)
 * - Simple and effective algorithms (Pike)
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

const logger = getLogger('LiquidityAggregator');

export class LiquidityAggregator extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            maxSlippage: config.maxSlippage || 0.05, // 5% default
            minSavings: config.minSavings || 0.001, // 0.1% minimum savings to split
            maxSplits: config.maxSplits || 5, // Maximum number of route splits
            routingFee: config.routingFee || 0.0001, // 0.01% routing fee
            enableSmartRouting: config.enableSmartRouting !== false,
            ...config
        };
        
        // Liquidity sources
        this.sources = new Map(); // sourceId -> source
        this.sourceTypes = {
            ORDER_BOOK: 'order_book',
            AMM_POOL: 'amm_pool',
            EXTERNAL_DEX: 'external_dex'
        };
        
        // Route cache for performance
        this.routeCache = new Map(); // cacheKey -> { route, timestamp }
        this.cacheTimeout = config.cacheTimeout || 1000; // 1 second cache
        
        // Statistics
        this.stats = {
            totalRoutesCalculated: 0,
            totalTradesRouted: 0,
            totalSavings: 0,
            avgExecutionTime: 0,
            cacheHits: 0,
            cacheMisses: 0
        };
    }
    
    /**
     * Register a liquidity source
     */
    registerSource(sourceId, source) {
        if (!source.type || !source.getQuote || !source.executeTrade) {
            throw new Error('Invalid liquidity source');
        }
        
        this.sources.set(sourceId, {
            id: sourceId,
            type: source.type,
            priority: source.priority || 0,
            enabled: true,
            ...source
        });
        
        logger.info(`Registered liquidity source: ${sourceId} (${source.type})`);
        
        this.emit('source:registered', { sourceId, type: source.type });
    }
    
    /**
     * Find optimal route for a trade
     */
    async findOptimalRoute(params) {
        const startTime = Date.now();
        
        const {
            pair,
            side,
            amount,
            type = 'market',
            maxSlippage = this.config.maxSlippage
        } = params;
        
        // Check cache first
        const cacheKey = `${pair}:${side}:${amount}:${type}`;
        const cached = this.getFromCache(cacheKey);
        if (cached) {
            this.stats.cacheHits++;
            return cached;
        }
        
        this.stats.cacheMisses++;
        
        try {
            // Get quotes from all enabled sources
            const quotes = await this.getAllQuotes({
                pair,
                side,
                amount,
                type
            });
            
            if (quotes.length === 0) {
                throw new Error('No liquidity available');
            }
            
            // Calculate optimal route
            let route;
            
            if (this.config.enableSmartRouting && quotes.length > 1) {
                route = await this.calculateSmartRoute(quotes, amount, maxSlippage);
            } else {
                // Simple routing - use best single source
                route = this.calculateSimpleRoute(quotes, amount);
            }
            
            // Add routing metadata
            route.timestamp = Date.now();
            route.executionTime = route.timestamp - startTime;
            
            // Update stats
            this.stats.totalRoutesCalculated++;
            this.stats.avgExecutionTime = 
                (this.stats.avgExecutionTime * 0.95) + (route.executionTime * 0.05);
            
            // Cache the route
            this.saveToCache(cacheKey, route);
            
            this.emit('route:calculated', route);
            
            return route;
            
        } catch (error) {
            logger.error('Failed to find optimal route:', error);
            throw error;
        }
    }
    
    /**
     * Get quotes from all sources
     */
    async getAllQuotes(params) {
        const enabledSources = Array.from(this.sources.values())
            .filter(source => source.enabled)
            .sort((a, b) => b.priority - a.priority);
        
        const quotePromises = enabledSources.map(async (source) => {
            try {
                const quote = await source.getQuote(params);
                return {
                    sourceId: source.id,
                    sourceType: source.type,
                    quote,
                    priority: source.priority
                };
            } catch (error) {
                logger.warn(`Failed to get quote from ${source.id}:`, error.message);
                return null;
            }
        });
        
        const results = await Promise.all(quotePromises);
        return results.filter(r => r !== null && r.quote && r.quote.price > 0);
    }
    
    /**
     * Calculate simple route (best single source)
     */
    calculateSimpleRoute(quotes, amount) {
        // Sort by best price
        const sorted = quotes.sort((a, b) => {
            const priceA = a.quote.price;
            const priceB = b.quote.price;
            return a.quote.side === 'buy' ? priceA - priceB : priceB - priceA;
        });
        
        const best = sorted[0];
        
        return {
            type: 'simple',
            totalAmount: amount,
            totalPrice: best.quote.price,
            totalCost: amount * best.quote.price,
            splits: [{
                sourceId: best.sourceId,
                sourceType: best.sourceType,
                amount: amount,
                price: best.quote.price,
                cost: amount * best.quote.price,
                percentage: 100
            }],
            estimatedSlippage: best.quote.estimatedSlippage || 0,
            fees: {
                trading: best.quote.fees || 0,
                routing: 0
            }
        };
    }
    
    /**
     * Calculate smart route (split across multiple sources)
     */
    async calculateSmartRoute(quotes, totalAmount, maxSlippage) {
        // Build liquidity depth map
        const depthMap = this.buildDepthMap(quotes);
        
        // Find optimal split using dynamic programming
        const optimalSplit = this.findOptimalSplit(
            depthMap,
            totalAmount,
            maxSlippage
        );
        
        // Calculate total metrics
        let totalCost = 0;
        let weightedPrice = 0;
        let totalFees = 0;
        
        for (const split of optimalSplit.splits) {
            totalCost += split.cost;
            weightedPrice += split.price * (split.amount / totalAmount);
            totalFees += split.fees || 0;
        }
        
        // Add routing fee for splits
        const routingFee = optimalSplit.splits.length > 1 
            ? totalCost * this.config.routingFee 
            : 0;
        
        return {
            type: 'smart',
            totalAmount,
            totalPrice: weightedPrice,
            totalCost,
            splits: optimalSplit.splits,
            estimatedSlippage: optimalSplit.estimatedSlippage,
            fees: {
                trading: totalFees,
                routing: routingFee
            },
            savings: optimalSplit.savings || 0
        };
    }
    
    /**
     * Build depth map from quotes
     */
    buildDepthMap(quotes) {
        const depthMap = new Map();
        
        for (const { sourceId, sourceType, quote } of quotes) {
            const levels = quote.depth || [{ price: quote.price, amount: quote.availableAmount || Infinity }];
            
            depthMap.set(sourceId, {
                sourceType,
                levels: levels.map(level => ({
                    price: level.price,
                    amount: level.amount,
                    cumAmount: 0, // Will be calculated
                    cumCost: 0
                })),
                fees: quote.fees || 0
            });
        }
        
        // Calculate cumulative amounts
        for (const [sourceId, data] of depthMap) {
            let cumAmount = 0;
            let cumCost = 0;
            
            for (const level of data.levels) {
                cumAmount += level.amount;
                cumCost += level.amount * level.price;
                level.cumAmount = cumAmount;
                level.cumCost = cumCost;
            }
        }
        
        return depthMap;
    }
    
    /**
     * Find optimal split using greedy algorithm
     */
    findOptimalSplit(depthMap, totalAmount, maxSlippage) {
        const splits = [];
        let remainingAmount = totalAmount;
        const usedSources = new Set();
        
        // Greedy approach: always take the best available price
        while (remainingAmount > 0.0001 && splits.length < this.config.maxSplits) {
            let bestSource = null;
            let bestPrice = Infinity;
            let bestAmount = 0;
            
            // Find best available price across all sources
            for (const [sourceId, data] of depthMap) {
                if (usedSources.has(sourceId)) continue;
                
                const availableAmount = Math.min(
                    remainingAmount,
                    data.levels[data.levels.length - 1].cumAmount
                );
                
                if (availableAmount <= 0) continue;
                
                // Calculate average price for this amount
                const avgPrice = this.calculateAveragePrice(
                    data.levels,
                    availableAmount
                );
                
                if (avgPrice < bestPrice) {
                    bestPrice = avgPrice;
                    bestSource = sourceId;
                    bestAmount = availableAmount;
                }
            }
            
            if (!bestSource) break;
            
            // Add split
            splits.push({
                sourceId: bestSource,
                sourceType: depthMap.get(bestSource).sourceType,
                amount: bestAmount,
                price: bestPrice,
                cost: bestAmount * bestPrice,
                percentage: (bestAmount / totalAmount) * 100,
                fees: depthMap.get(bestSource).fees
            });
            
            remainingAmount -= bestAmount;
            usedSources.add(bestSource);
        }
        
        // Calculate estimated slippage
        const basePrice = Math.min(...Array.from(depthMap.values())
            .map(d => d.levels[0].price));
        const avgExecutionPrice = splits.reduce((sum, s) => 
            sum + s.price * (s.amount / totalAmount), 0);
        const estimatedSlippage = (avgExecutionPrice - basePrice) / basePrice;
        
        // Calculate savings vs single source
        const singleSourceCost = totalAmount * basePrice;
        const splitCost = splits.reduce((sum, s) => sum + s.cost, 0);
        const savings = Math.max(0, singleSourceCost - splitCost);
        
        return {
            splits,
            estimatedSlippage,
            savings
        };
    }
    
    /**
     * Calculate average price for given amount from depth levels
     */
    calculateAveragePrice(levels, amount) {
        let totalCost = 0;
        let totalAmount = 0;
        
        for (const level of levels) {
            const levelAmount = Math.min(
                amount - totalAmount,
                level.amount
            );
            
            if (levelAmount <= 0) break;
            
            totalCost += levelAmount * level.price;
            totalAmount += levelAmount;
            
            if (totalAmount >= amount) break;
        }
        
        return totalAmount > 0 ? totalCost / totalAmount : Infinity;
    }
    
    /**
     * Execute trade through optimal route
     */
    async executeTrade(route, userId) {
        const startTime = Date.now();
        
        try {
            const results = [];
            const failures = [];
            
            // Execute each split
            for (const split of route.splits) {
                try {
                    const source = this.sources.get(split.sourceId);
                    if (!source) {
                        throw new Error(`Source ${split.sourceId} not found`);
                    }
                    
                    const result = await source.executeTrade({
                        pair: route.pair,
                        side: route.side,
                        amount: split.amount,
                        price: split.price,
                        type: route.type,
                        userId
                    });
                    
                    results.push({
                        sourceId: split.sourceId,
                        ...result
                    });
                    
                } catch (error) {
                    logger.error(`Failed to execute split on ${split.sourceId}:`, error);
                    failures.push({
                        sourceId: split.sourceId,
                        error: error.message
                    });
                }
            }
            
            // Calculate execution metrics
            const executionTime = Date.now() - startTime;
            const totalExecuted = results.reduce((sum, r) => sum + r.executedAmount, 0);
            const avgExecutionPrice = results.reduce((sum, r) => 
                sum + r.executionPrice * (r.executedAmount / totalExecuted), 0);
            
            // Update statistics
            this.stats.totalTradesRouted++;
            if (route.savings > 0) {
                this.stats.totalSavings += route.savings;
            }
            
            const execution = {
                route,
                results,
                failures,
                totalExecuted,
                avgExecutionPrice,
                executionTime,
                status: failures.length === 0 ? 'completed' : 'partial'
            };
            
            this.emit('trade:executed', execution);
            
            return execution;
            
        } catch (error) {
            logger.error('Failed to execute trade:', error);
            throw error;
        }
    }
    
    /**
     * Cache management
     */
    getFromCache(key) {
        const cached = this.routeCache.get(key);
        if (!cached) return null;
        
        if (Date.now() - cached.timestamp > this.cacheTimeout) {
            this.routeCache.delete(key);
            return null;
        }
        
        return cached.route;
    }
    
    saveToCache(key, route) {
        this.routeCache.set(key, {
            route,
            timestamp: Date.now()
        });
        
        // Limit cache size
        if (this.routeCache.size > 1000) {
            const oldestKey = this.routeCache.keys().next().value;
            this.routeCache.delete(oldestKey);
        }
    }
    
    /**
     * Source management
     */
    enableSource(sourceId) {
        const source = this.sources.get(sourceId);
        if (source) {
            source.enabled = true;
            this.emit('source:enabled', sourceId);
        }
    }
    
    disableSource(sourceId) {
        const source = this.sources.get(sourceId);
        if (source) {
            source.enabled = false;
            this.emit('source:disabled', sourceId);
        }
    }
    
    /**
     * Get statistics
     */
    getStats() {
        const sourceStats = {};
        
        for (const [sourceId, source] of this.sources) {
            sourceStats[sourceId] = {
                type: source.type,
                enabled: source.enabled,
                priority: source.priority
            };
        }
        
        return {
            ...this.stats,
            sources: sourceStats,
            cacheSize: this.routeCache.size,
            avgSavingsPerTrade: this.stats.totalTradesRouted > 0
                ? this.stats.totalSavings / this.stats.totalTradesRouted
                : 0
        };
    }
}

export default LiquidityAggregator;