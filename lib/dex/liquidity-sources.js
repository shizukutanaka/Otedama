/**
 * Liquidity Source Adapters for Otedama DEX
 * Adapts order books and AMM pools to work with the liquidity aggregator
 */

import { logger } from '../core/logger.js';

/**
 * Order Book Liquidity Source Adapter
 */
export class OrderBookSource {
    constructor(matchingEngine, pair) {
        this.matchingEngine = matchingEngine;
        this.pair = pair;
        this.type = 'order_book';
        this.priority = 100; // High priority for order books
    }
    
    async getQuote(params) {
        const { side, amount, type } = params;
        
        try {
            // Get order book snapshot
            const orderBook = this.matchingEngine.getOrderBook(this.pair);
            if (!orderBook) {
                throw new Error('Order book not available');
            }
            
            // Calculate execution price and depth
            const depth = this.calculateDepth(
                orderBook,
                side,
                amount
            );
            
            if (depth.length === 0) {
                return null;
            }
            
            // Calculate average execution price
            let totalCost = 0;
            let totalAmount = 0;
            
            for (const level of depth) {
                const levelAmount = Math.min(
                    amount - totalAmount,
                    level.amount
                );
                
                totalCost += levelAmount * level.price;
                totalAmount += levelAmount;
                
                if (totalAmount >= amount) break;
            }
            
            const avgPrice = totalAmount > 0 ? totalCost / totalAmount : 0;
            const availableAmount = totalAmount;
            
            // Estimate slippage
            const bestPrice = depth[0].price;
            const estimatedSlippage = Math.abs(avgPrice - bestPrice) / bestPrice;
            
            return {
                price: avgPrice,
                availableAmount,
                depth,
                estimatedSlippage,
                fees: 0.002, // 0.2% taker fee
                side,
                timestamp: Date.now()
            };
            
        } catch (error) {
            logger.error(`Failed to get order book quote:`, error);
            return null;
        }
    }
    
    async executeTrade(params) {
        const { side, amount, type, userId, price } = params;
        
        try {
            // Create order
            const order = {
                userId,
                pair: this.pair,
                side: side.toLowerCase(),
                type: type || 'market',
                quantity: amount,
                price: type === 'limit' ? price : undefined
            };
            
            // Submit to matching engine
            const result = await this.matchingEngine.submitOrder(order);
            
            // Calculate execution metrics
            const executedAmount = result.order.filledQuantity;
            let totalCost = 0;
            
            for (const trade of result.trades) {
                totalCost += trade.quantity * trade.price;
            }
            
            const executionPrice = executedAmount > 0 
                ? totalCost / executedAmount 
                : 0;
            
            return {
                orderId: result.order.id,
                executedAmount,
                executionPrice,
                trades: result.trades,
                status: result.order.status,
                timestamp: Date.now()
            };
            
        } catch (error) {
            logger.error(`Failed to execute order book trade:`, error);
            throw error;
        }
    }
    
    calculateDepth(orderBook, side, maxAmount) {
        const levels = side === 'buy' ? orderBook.asks : orderBook.bids;
        const depth = [];
        let cumAmount = 0;
        
        for (const [price, amount] of levels) {
            if (cumAmount >= maxAmount) break;
            
            depth.push({
                price: Number(price),
                amount: Number(amount),
                cumAmount: cumAmount + Number(amount)
            });
            
            cumAmount += Number(amount);
        }
        
        return depth;
    }
}

/**
 * AMM Pool Liquidity Source Adapter
 */
export class AMMPoolSource {
    constructor(amm, poolId) {
        this.amm = amm;
        this.poolId = poolId;
        this.type = 'amm_pool';
        this.priority = 90; // Slightly lower priority than order book
        
        // Parse pool info
        const [token0, token1] = poolId.split(':');
        this.token0 = token0;
        this.token1 = token1;
        this.pair = `${token0}/${token1}`;
    }
    
    async getQuote(params) {
        const { side, amount } = params;
        
        try {
            const pool = this.amm.pools.get(this.poolId);
            if (!pool) {
                throw new Error('Pool not found');
            }
            
            // Determine token in/out based on side
            const tokenIn = side === 'buy' ? this.token1 : this.token0;
            const zeroForOne = tokenIn === this.token0;
            
            // Calculate swap result
            const swapResult = this.amm.computeSwapStep(
                pool,
                BigInt(Math.floor(amount * 1e18)), // Convert to wei
                zeroForOne,
                true // exactInput
            );
            
            // Calculate price
            const amountOut = Number(swapResult.amountOut) / 1e18;
            const price = side === 'buy' 
                ? amount / amountOut  // Buying token0 with token1
                : amountOut / amount; // Selling token0 for token1
            
            // Estimate slippage based on pool liquidity
            const liquidityUSD = Number(pool.liquidity) / 1e18;
            const tradeSize = amount * price;
            const estimatedSlippage = Math.min(
                0.3, // 30% max
                tradeSize / (liquidityUSD * 2) // Simple slippage model
            );
            
            return {
                price,
                availableAmount: amount, // AMMs have "infinite" liquidity
                depth: [{ price, amount: Infinity }],
                estimatedSlippage,
                fees: pool.feeRate || 0.003, // Pool fee
                side,
                timestamp: Date.now()
            };
            
        } catch (error) {
            logger.error(`Failed to get AMM quote:`, error);
            return null;
        }
    }
    
    async executeTrade(params) {
        const { side, amount, userId } = params;
        
        try {
            // Determine token in/out
            const tokenIn = side === 'buy' ? this.token1 : this.token0;
            const amountIn = BigInt(Math.floor(amount * 1e18));
            const minAmountOut = 0n; // Should calculate based on slippage tolerance
            
            // Execute swap
            const result = await this.amm.swap(
                this.poolId,
                amountIn,
                tokenIn,
                minAmountOut
            );
            
            const executedAmount = Number(result.amountIn) / 1e18;
            const amountOut = Number(result.amountOut) / 1e18;
            const executionPrice = side === 'buy'
                ? executedAmount / amountOut
                : amountOut / executedAmount;
            
            return {
                swapId: `SWAP-${Date.now()}`,
                executedAmount,
                executionPrice,
                amountOut,
                fees: Number(result.feeAmount) / 1e18,
                status: 'completed',
                timestamp: Date.now()
            };
            
        } catch (error) {
            logger.error(`Failed to execute AMM trade:`, error);
            throw error;
        }
    }
}

/**
 * External DEX Liquidity Source (for future cross-DEX aggregation)
 */
export class ExternalDEXSource {
    constructor(config) {
        this.name = config.name;
        this.apiUrl = config.apiUrl;
        this.apiKey = config.apiKey;
        this.type = 'external_dex';
        this.priority = config.priority || 50;
        this.timeout = config.timeout || 5000;
    }
    
    async getQuote(params) {
        // Placeholder for external DEX integration
        // Would make API calls to external DEXs like Uniswap, Sushiswap, etc.
        return null;
    }
    
    async executeTrade(params) {
        // Placeholder for external DEX trade execution
        throw new Error('External DEX execution not implemented');
    }
}

export default {
    OrderBookSource,
    AMMPoolSource,
    ExternalDEXSource
};