/**
 * Perpetual Futures Trading for Otedama
 * Leveraged trading with no expiry date
 * 
 * Design principles:
 * - High-performance margin engine (Carmack)
 * - Clean position management (Martin)
 * - Simple funding mechanism (Pike)
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

const logger = getLogger('PerpetualFutures');

export class PerpetualFuturesEngine extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Leverage settings
            maxLeverage: config.maxLeverage || 100,
            defaultLeverage: config.defaultLeverage || 10,
            minLeverage: config.minLeverage || 1,
            
            // Margin requirements
            initialMarginRate: config.initialMarginRate || 0.01, // 1%
            maintenanceMarginRate: config.maintenanceMarginRate || 0.005, // 0.5%
            liquidationFeeRate: config.liquidationFeeRate || 0.001, // 0.1%
            
            // Position limits
            maxPositionSize: config.maxPositionSize || 1000000, // $1M
            minPositionSize: config.minPositionSize || 10, // $10
            maxOpenPositions: config.maxOpenPositions || 100,
            
            // Funding rate settings
            fundingInterval: config.fundingInterval || 28800000, // 8 hours
            maxFundingRate: config.maxFundingRate || 0.001, // 0.1% per interval
            fundingRateDampener: config.fundingRateDampener || 0.1,
            
            // Mark price settings
            markPriceUpdateInterval: config.markPriceUpdateInterval || 1000, // 1 second
            indexPriceSources: config.indexPriceSources || 3,
            
            // Risk parameters
            maxPriceDeviation: config.maxPriceDeviation || 0.1, // 10%
            adlThreshold: config.adlThreshold || 0.9, // 90% of insurance fund
            insuranceFundTarget: config.insuranceFundTarget || 0.01, // 1% of total volume
            
            // Fee structure
            makerFee: config.makerFee || -0.00025, // -0.025% (rebate)
            takerFee: config.takerFee || 0.00075, // 0.075%
            
            ...config
        };
        
        // Market data
        this.markets = new Map(); // symbol -> PerpMarket
        this.orderBooks = new Map(); // symbol -> OrderBook
        
        // Position tracking
        this.positions = new Map(); // positionId -> Position
        this.userPositions = new Map(); // userId -> Map<symbol, Position>
        
        // Margin and collateral
        this.userMargins = new Map(); // userId -> MarginAccount
        this.insuranceFund = {
            balance: 0,
            contributions: 0,
            payouts: 0
        };
        
        // Pricing
        this.markPrices = new Map(); // symbol -> MarkPrice
        this.indexPrices = new Map(); // symbol -> IndexPrice
        this.fundingRates = new Map(); // symbol -> FundingRate
        
        // Liquidation queue
        this.liquidationQueue = [];
        this.adlQueue = new Map(); // symbol -> ADLQueue
        
        // Statistics
        this.stats = {
            totalVolume: 0,
            totalPositions: 0,
            activeLongs: 0,
            activeShorts: 0,
            totalLiquidations: 0,
            totalFundingPaid: 0,
            totalFeesCollected: 0
        };
        
        // Start engines
        this.startPriceEngine();
        this.startFundingEngine();
        this.startLiquidationEngine();
    }
    
    /**
     * Create perpetual market
     */
    createMarket(params) {
        const {
            symbol,
            baseAsset,
            quoteAsset = 'USDT',
            contractSize = 1,
            tickSize = 0.1,
            maxLeverage = this.config.maxLeverage
        } = params;
        
        if (this.markets.has(symbol)) {
            throw new Error(`Market ${symbol} already exists`);
        }
        
        const market = {
            symbol,
            baseAsset,
            quoteAsset,
            contractSize,
            tickSize,
            maxLeverage,
            status: 'active',
            createdAt: Date.now(),
            
            // Volume tracking
            volume24h: 0,
            volumeRolling: [],
            
            // Open interest
            openInterestLong: 0,
            openInterestShort: 0,
            
            // Funding
            lastFundingTime: Date.now(),
            accumulatedFunding: 0
        };
        
        this.markets.set(symbol, market);
        this.orderBooks.set(symbol, {
            bids: new Map(),
            asks: new Map(),
            lastPrice: 0,
            markPrice: 0
        });
        
        // Initialize pricing
        this.markPrices.set(symbol, {
            price: 0,
            lastUpdate: Date.now(),
            confidence: 0
        });
        
        this.indexPrices.set(symbol, {
            price: 0,
            sources: [],
            lastUpdate: Date.now()
        });
        
        this.fundingRates.set(symbol, {
            rate: 0,
            nextFunding: Date.now() + this.config.fundingInterval,
            history: []
        });
        
        logger.info(`Perpetual market created: ${symbol}`);
        
        this.emit('market:created', {
            market,
            timestamp: Date.now()
        });
        
        return market;
    }
    
    /**
     * Open perpetual position
     */
    async openPosition(params) {
        const {
            userId,
            symbol,
            side, // 'long' or 'short'
            size,
            leverage = this.config.defaultLeverage,
            type = 'market', // 'market' or 'limit'
            price,
            reduceOnly = false,
            postOnly = false
        } = params;
        
        const market = this.markets.get(symbol);
        if (!market) {
            throw new Error(`Market ${symbol} not found`);
        }
        
        // Validate leverage
        if (leverage < this.config.minLeverage || leverage > market.maxLeverage) {
            throw new Error(`Invalid leverage: ${leverage}`);
        }
        
        // Calculate position value
        const markPrice = this.markPrices.get(symbol).price;
        const positionValue = size * markPrice;
        
        // Validate position size
        if (positionValue < this.config.minPositionSize || positionValue > this.config.maxPositionSize) {
            throw new Error(`Invalid position size: ${positionValue}`);
        }
        
        // Check margin requirements
        const requiredMargin = positionValue / leverage;
        const userMargin = await this.getUserAvailableMargin(userId);
        
        if (userMargin < requiredMargin) {
            throw new Error(`Insufficient margin: ${userMargin} < ${requiredMargin}`);
        }
        
        // Check position limits
        const userPositionCount = this.getUserPositionCount(userId);
        if (userPositionCount >= this.config.maxOpenPositions) {
            throw new Error('Maximum open positions reached');
        }
        
        // Create position
        const positionId = this.generatePositionId();
        const position = {
            id: positionId,
            userId,
            symbol,
            side,
            size,
            entryPrice: type === 'market' ? markPrice : price,
            markPrice,
            leverage,
            margin: requiredMargin,
            
            // P&L tracking
            unrealizedPnl: 0,
            realizedPnl: 0,
            
            // Risk metrics
            liquidationPrice: this.calculateLiquidationPrice(side, markPrice, leverage),
            bankruptcyPrice: this.calculateBankruptcyPrice(side, markPrice, leverage),
            
            // Funding
            fundingPaid: 0,
            lastFundingTime: Date.now(),
            
            // Status
            status: 'pending',
            reduceOnly,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        
        // Lock margin
        await this.lockMargin(userId, requiredMargin);
        
        // Submit order
        const order = {
            id: this.generateOrderId(),
            positionId,
            userId,
            symbol,
            side: side === 'long' ? 'buy' : 'sell',
            type,
            price: type === 'limit' ? price : undefined,
            size,
            filled: 0,
            remaining: size,
            postOnly,
            createdAt: Date.now()
        };
        
        // Execute order
        if (type === 'market') {
            await this.executeMarketOrder(order, position);
        } else {
            await this.placeLimitOrder(order, position);
        }
        
        // Store position if filled
        if (position.status === 'open') {
            this.positions.set(positionId, position);
            
            // Update user positions
            if (!this.userPositions.has(userId)) {
                this.userPositions.set(userId, new Map());
            }
            this.userPositions.get(userId).set(symbol, position);
            
            // Update market stats
            if (side === 'long') {
                market.openInterestLong += size;
                this.stats.activeLongs++;
            } else {
                market.openInterestShort += size;
                this.stats.activeShorts++;
            }
            
            this.stats.totalPositions++;
            
            logger.info(`Position opened: ${positionId}, ${side} ${size} ${symbol} @ ${position.entryPrice}`);
            
            this.emit('position:opened', {
                position,
                order,
                timestamp: Date.now()
            });
        }
        
        return position;
    }
    
    /**
     * Close position
     */
    async closePosition(params) {
        const {
            userId,
            positionId,
            size, // Optional, closes entire position if not specified
            type = 'market',
            price
        } = params;
        
        const position = this.positions.get(positionId);
        if (!position) {
            throw new Error('Position not found');
        }
        
        if (position.userId !== userId) {
            throw new Error('Unauthorized');
        }
        
        const closeSize = size || position.size;
        if (closeSize > position.size) {
            throw new Error('Close size exceeds position size');
        }
        
        // Create closing order
        const order = {
            id: this.generateOrderId(),
            positionId,
            userId,
            symbol: position.symbol,
            side: position.side === 'long' ? 'sell' : 'buy',
            type,
            price: type === 'limit' ? price : undefined,
            size: closeSize,
            filled: 0,
            remaining: closeSize,
            isClosing: true,
            createdAt: Date.now()
        };
        
        // Execute order
        if (type === 'market') {
            await this.executeMarketOrder(order, position, true);
        } else {
            await this.placeLimitOrder(order, position, true);
        }
        
        return {
            position,
            order,
            realizedPnl: position.realizedPnl
        };
    }
    
    /**
     * Update position margin
     */
    async adjustMargin(userId, positionId, marginDelta) {
        const position = this.positions.get(positionId);
        if (!position) {
            throw new Error('Position not found');
        }
        
        if (position.userId !== userId) {
            throw new Error('Unauthorized');
        }
        
        if (marginDelta > 0) {
            // Add margin
            const availableMargin = await this.getUserAvailableMargin(userId);
            if (availableMargin < marginDelta) {
                throw new Error('Insufficient margin');
            }
            
            await this.lockMargin(userId, marginDelta);
            position.margin += marginDelta;
            
        } else {
            // Remove margin
            const minMargin = position.size * this.markPrices.get(position.symbol).price * this.config.initialMarginRate;
            const newMargin = position.margin + marginDelta; // marginDelta is negative
            
            if (newMargin < minMargin) {
                throw new Error('Cannot reduce margin below minimum');
            }
            
            position.margin = newMargin;
            await this.unlockMargin(userId, -marginDelta);
        }
        
        // Recalculate liquidation price
        position.liquidationPrice = this.calculateLiquidationPrice(
            position.side,
            position.entryPrice,
            position.size * position.entryPrice / position.margin
        );
        
        position.updatedAt = Date.now();
        
        logger.info(`Margin adjusted: ${positionId}, delta: ${marginDelta}`);
        
        this.emit('margin:adjusted', {
            position,
            marginDelta,
            timestamp: Date.now()
        });
        
        return position;
    }
    
    /**
     * Execute market order
     */
    async executeMarketOrder(order, position, isClosing = false) {
        const orderBook = this.orderBooks.get(order.symbol);
        const oppositeSide = order.side === 'buy' ? 'asks' : 'bids';
        const levels = Array.from(orderBook[oppositeSide].entries()).sort((a, b) => 
            order.side === 'buy' ? a[0] - b[0] : b[0] - a[0]
        );
        
        let remainingSize = order.size;
        let totalCost = 0;
        const fills = [];
        
        for (const [price, orders] of levels) {
            if (remainingSize <= 0) break;
            
            for (const limitOrder of orders) {
                if (remainingSize <= 0) break;
                
                const fillSize = Math.min(remainingSize, limitOrder.remaining);
                const fillCost = fillSize * price;
                
                fills.push({
                    price,
                    size: fillSize,
                    maker: limitOrder.userId,
                    taker: order.userId,
                    makerOrderId: limitOrder.id,
                    takerOrderId: order.id
                });
                
                remainingSize -= fillSize;
                totalCost += fillCost;
                
                // Update limit order
                limitOrder.filled += fillSize;
                limitOrder.remaining -= fillSize;
                
                if (limitOrder.remaining === 0) {
                    // Remove filled order
                    orders.splice(orders.indexOf(limitOrder), 1);
                }
            }
            
            if (orders.length === 0) {
                orderBook[oppositeSide].delete(price);
            }
        }
        
        if (fills.length === 0) {
            throw new Error('No liquidity available');
        }
        
        // Calculate average fill price
        const avgPrice = totalCost / (order.size - remainingSize);
        order.filled = order.size - remainingSize;
        order.remaining = remainingSize;
        
        if (isClosing) {
            // Calculate realized P&L
            const pnl = this.calculateRealizedPnl(position, avgPrice, order.filled);
            position.realizedPnl += pnl;
            position.size -= order.filled;
            
            if (position.size === 0) {
                // Position fully closed
                position.status = 'closed';
                await this.unlockMargin(position.userId, position.margin);
                this.positions.delete(position.id);
                this.userPositions.get(position.userId).delete(position.symbol);
                
                // Update stats
                const market = this.markets.get(position.symbol);
                if (position.side === 'long') {
                    market.openInterestLong -= order.filled;
                    this.stats.activeLongs--;
                } else {
                    market.openInterestShort -= order.filled;
                    this.stats.activeShorts--;
                }
            }
        } else {
            // Opening position
            position.entryPrice = avgPrice;
            position.status = 'open';
        }
        
        // Calculate and collect fees
        const fees = await this.calculateAndCollectFees(order, fills);
        
        // Update volume
        this.updateVolume(order.symbol, totalCost);
        
        // Emit fills
        for (const fill of fills) {
            this.emit('order:filled', {
                ...fill,
                symbol: order.symbol,
                timestamp: Date.now()
            });
        }
        
        return {
            order,
            fills,
            avgPrice,
            fees
        };
    }
    
    /**
     * Calculate liquidation price
     */
    calculateLiquidationPrice(side, entryPrice, leverage) {
        const maintenanceMargin = this.config.maintenanceMarginRate;
        
        if (side === 'long') {
            return entryPrice * (1 - 1/leverage + maintenanceMargin);
        } else {
            return entryPrice * (1 + 1/leverage - maintenanceMargin);
        }
    }
    
    /**
     * Calculate bankruptcy price
     */
    calculateBankruptcyPrice(side, entryPrice, leverage) {
        if (side === 'long') {
            return entryPrice * (1 - 1/leverage);
        } else {
            return entryPrice * (1 + 1/leverage);
        }
    }
    
    /**
     * Calculate realized P&L
     */
    calculateRealizedPnl(position, exitPrice, size) {
        const { side, entryPrice } = position;
        
        if (side === 'long') {
            return size * (exitPrice - entryPrice);
        } else {
            return size * (entryPrice - exitPrice);
        }
    }
    
    /**
     * Update mark price
     */
    updateMarkPrice(symbol, price) {
        const markPrice = this.markPrices.get(symbol);
        if (!markPrice) return;
        
        // Simple EMA for mark price
        const alpha = 0.1;
        markPrice.price = markPrice.price * (1 - alpha) + price * alpha;
        markPrice.lastUpdate = Date.now();
        
        // Update position P&L
        this.updateUnrealizedPnl(symbol);
        
        // Check for liquidations
        this.checkLiquidations(symbol);
    }
    
    /**
     * Update unrealized P&L for all positions
     */
    updateUnrealizedPnl(symbol) {
        const markPrice = this.markPrices.get(symbol).price;
        
        for (const position of this.positions.values()) {
            if (position.symbol !== symbol || position.status !== 'open') continue;
            
            const { side, size, entryPrice } = position;
            
            if (side === 'long') {
                position.unrealizedPnl = size * (markPrice - entryPrice);
            } else {
                position.unrealizedPnl = size * (entryPrice - markPrice);
            }
            
            position.markPrice = markPrice;
            
            // Check margin ratio
            const marginRatio = (position.margin + position.unrealizedPnl) / (size * markPrice);
            position.marginRatio = marginRatio;
        }
    }
    
    /**
     * Funding rate calculation and payment
     */
    async calculateAndPayFunding() {
        for (const [symbol, market] of this.markets) {
            const markPrice = this.markPrices.get(symbol).price;
            const indexPrice = this.indexPrices.get(symbol).price;
            
            if (!markPrice || !indexPrice) continue;
            
            // Calculate funding rate
            const premium = (markPrice - indexPrice) / indexPrice;
            const fundingRate = Math.max(
                -this.config.maxFundingRate,
                Math.min(this.config.maxFundingRate, premium * this.config.fundingRateDampener)
            );
            
            // Update funding rate
            const funding = this.fundingRates.get(symbol);
            funding.rate = fundingRate;
            funding.history.push({
                rate: fundingRate,
                timestamp: Date.now()
            });
            
            // Keep only last 30 days
            const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
            funding.history = funding.history.filter(h => h.timestamp > cutoff);
            
            // Pay funding
            let totalFundingPaid = 0;
            let totalFundingReceived = 0;
            
            for (const position of this.positions.values()) {
                if (position.symbol !== symbol || position.status !== 'open') continue;
                
                const positionValue = position.size * markPrice;
                const fundingPayment = positionValue * fundingRate;
                
                if (position.side === 'long') {
                    // Longs pay shorts when funding is positive
                    if (fundingRate > 0) {
                        position.fundingPaid += fundingPayment;
                        totalFundingPaid += fundingPayment;
                        await this.deductMargin(position.userId, fundingPayment);
                    } else {
                        position.fundingPaid += fundingPayment; // negative
                        totalFundingReceived -= fundingPayment;
                        await this.creditMargin(position.userId, -fundingPayment);
                    }
                } else {
                    // Shorts pay longs when funding is negative
                    if (fundingRate < 0) {
                        position.fundingPaid -= fundingPayment; // double negative = positive
                        totalFundingPaid -= fundingPayment;
                        await this.deductMargin(position.userId, -fundingPayment);
                    } else {
                        position.fundingPaid -= fundingPayment; // negative
                        totalFundingReceived += fundingPayment;
                        await this.creditMargin(position.userId, fundingPayment);
                    }
                }
                
                position.lastFundingTime = Date.now();
            }
            
            // Update stats
            this.stats.totalFundingPaid += Math.abs(totalFundingPaid);
            
            // Update next funding time
            funding.nextFunding = Date.now() + this.config.fundingInterval;
            
            logger.info(`Funding paid for ${symbol}: rate=${fundingRate}, paid=${totalFundingPaid}, received=${totalFundingReceived}`);
            
            this.emit('funding:paid', {
                symbol,
                rate: fundingRate,
                totalPaid: totalFundingPaid,
                totalReceived: totalFundingReceived,
                timestamp: Date.now()
            });
        }
    }
    
    /**
     * Check and execute liquidations
     */
    async checkLiquidations(symbol) {
        const markPrice = this.markPrices.get(symbol).price;
        const liquidations = [];
        
        for (const position of this.positions.values()) {
            if (position.symbol !== symbol || position.status !== 'open') continue;
            
            const shouldLiquidate = position.side === 'long' 
                ? markPrice <= position.liquidationPrice
                : markPrice >= position.liquidationPrice;
                
            if (shouldLiquidate) {
                liquidations.push(position);
            }
        }
        
        // Execute liquidations
        for (const position of liquidations) {
            await this.liquidatePosition(position);
        }
    }
    
    /**
     * Liquidate position
     */
    async liquidatePosition(position) {
        logger.warn(`Liquidating position: ${position.id}`);
        
        position.status = 'liquidating';
        
        try {
            // Try to close position at market
            const liquidationOrder = {
                id: this.generateOrderId(),
                positionId: position.id,
                userId: 'LIQUIDATION_ENGINE',
                symbol: position.symbol,
                side: position.side === 'long' ? 'sell' : 'buy',
                type: 'market',
                size: position.size,
                isLiquidation: true,
                createdAt: Date.now()
            };
            
            const result = await this.executeMarketOrder(liquidationOrder, position, true);
            
            // Calculate liquidation loss
            const bankruptcyLoss = this.calculateBankruptcyLoss(position, result.avgPrice);
            
            if (bankruptcyLoss > 0) {
                // Insurance fund covers the loss
                if (this.insuranceFund.balance >= bankruptcyLoss) {
                    this.insuranceFund.balance -= bankruptcyLoss;
                    this.insuranceFund.payouts += bankruptcyLoss;
                } else {
                    // Trigger ADL
                    await this.triggerADL(position.symbol, bankruptcyLoss - this.insuranceFund.balance);
                }
            }
            
            // Collect liquidation fee
            const liquidationFee = position.margin * this.config.liquidationFeeRate;
            this.insuranceFund.balance += liquidationFee;
            this.insuranceFund.contributions += liquidationFee;
            
            // Update stats
            this.stats.totalLiquidations++;
            
            this.emit('position:liquidated', {
                position,
                liquidationPrice: result.avgPrice,
                loss: bankruptcyLoss,
                timestamp: Date.now()
            });
            
        } catch (error) {
            logger.error(`Liquidation failed for position ${position.id}:`, error);
            // Add to ADL queue
            this.addToADLQueue(position);
        }
    }
    
    /**
     * Auto-deleveraging (ADL)
     */
    async triggerADL(symbol, requiredAmount) {
        logger.warn(`Triggering ADL for ${symbol}, amount: ${requiredAmount}`);
        
        // Get profitable positions on opposite side
        const positions = Array.from(this.positions.values())
            .filter(p => p.symbol === symbol && p.status === 'open' && p.unrealizedPnl > 0)
            .sort((a, b) => {
                // Sort by PnL ratio (most profitable first)
                const ratioA = a.unrealizedPnl / (a.size * a.markPrice);
                const ratioB = b.unrealizedPnl / (b.size * b.markPrice);
                return ratioB - ratioA;
            });
        
        let remainingAmount = requiredAmount;
        
        for (const position of positions) {
            if (remainingAmount <= 0) break;
            
            const positionValue = position.size * position.markPrice;
            const deleverageSize = Math.min(position.size, remainingAmount / position.markPrice);
            
            // Force close portion of position
            await this.closePosition({
                userId: position.userId,
                positionId: position.id,
                size: deleverageSize,
                type: 'market'
            });
            
            remainingAmount -= deleverageSize * position.markPrice;
            
            this.emit('position:deleveraged', {
                position,
                deleverageSize,
                reason: 'ADL',
                timestamp: Date.now()
            });
        }
    }
    
    /**
     * Helper methods
     */
    
    async getUserAvailableMargin(userId) {
        const margin = this.userMargins.get(userId);
        if (!margin) {
            return 0;
        }
        return margin.available;
    }
    
    async lockMargin(userId, amount) {
        let margin = this.userMargins.get(userId);
        if (!margin) {
            margin = {
                total: 0,
                available: 0,
                locked: 0,
                unrealizedPnl: 0
            };
            this.userMargins.set(userId, margin);
        }
        
        if (margin.available < amount) {
            throw new Error('Insufficient margin');
        }
        
        margin.available -= amount;
        margin.locked += amount;
    }
    
    async unlockMargin(userId, amount) {
        const margin = this.userMargins.get(userId);
        if (!margin) return;
        
        margin.locked -= amount;
        margin.available += amount;
    }
    
    async deductMargin(userId, amount) {
        const margin = this.userMargins.get(userId);
        if (!margin) return;
        
        margin.total -= amount;
        margin.available -= amount;
    }
    
    async creditMargin(userId, amount) {
        const margin = this.userMargins.get(userId);
        if (!margin) return;
        
        margin.total += amount;
        margin.available += amount;
    }
    
    getUserPositionCount(userId) {
        const positions = this.userPositions.get(userId);
        return positions ? positions.size : 0;
    }
    
    calculateBankruptcyLoss(position, exitPrice) {
        const bankruptcyPrice = position.bankruptcyPrice;
        
        if (position.side === 'long' && exitPrice < bankruptcyPrice) {
            return position.size * (bankruptcyPrice - exitPrice);
        } else if (position.side === 'short' && exitPrice > bankruptcyPrice) {
            return position.size * (exitPrice - bankruptcyPrice);
        }
        
        return 0;
    }
    
    async calculateAndCollectFees(order, fills) {
        let totalFees = 0;
        
        for (const fill of fills) {
            const isMaker = order.userId === fill.maker;
            const feeRate = isMaker ? this.config.makerFee : this.config.takerFee;
            const fee = fill.size * fill.price * Math.abs(feeRate);
            
            if (feeRate > 0) {
                // Deduct fee
                await this.deductMargin(order.userId, fee);
                this.insuranceFund.balance += fee * 0.1; // 10% to insurance fund
                totalFees += fee;
            } else {
                // Rebate
                await this.creditMargin(order.userId, fee);
                totalFees -= fee;
            }
        }
        
        this.stats.totalFeesCollected += Math.abs(totalFees);
        
        return totalFees;
    }
    
    updateVolume(symbol, volume) {
        const market = this.markets.get(symbol);
        if (!market) return;
        
        market.volume24h += volume;
        market.volumeRolling.push({
            volume,
            timestamp: Date.now()
        });
        
        // Keep only last 24 hours
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        market.volumeRolling = market.volumeRolling.filter(v => v.timestamp > cutoff);
        
        this.stats.totalVolume += volume;
    }
    
    generatePositionId() {
        return `POS${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
    
    generateOrderId() {
        return `ORD${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Start price engine
     */
    startPriceEngine() {
        this.priceInterval = setInterval(() => {
            for (const symbol of this.markets.keys()) {
                // In production, would aggregate from multiple sources
                const mockPrice = 50000 + Math.random() * 1000 - 500;
                this.updateMarkPrice(symbol, mockPrice);
            }
        }, this.config.markPriceUpdateInterval);
        
        logger.info('Perpetual price engine started');
    }
    
    /**
     * Start funding engine
     */
    startFundingEngine() {
        this.fundingInterval = setInterval(async () => {
            await this.calculateAndPayFunding();
        }, this.config.fundingInterval);
        
        logger.info('Perpetual funding engine started');
    }
    
    /**
     * Start liquidation engine
     */
    startLiquidationEngine() {
        this.liquidationInterval = setInterval(() => {
            for (const symbol of this.markets.keys()) {
                this.checkLiquidations(symbol);
            }
        }, 1000); // Check every second
        
        logger.info('Perpetual liquidation engine started');
    }
    
    /**
     * Stop engines
     */
    stop() {
        if (this.priceInterval) {
            clearInterval(this.priceInterval);
        }
        
        if (this.fundingInterval) {
            clearInterval(this.fundingInterval);
        }
        
        if (this.liquidationInterval) {
            clearInterval(this.liquidationInterval);
        }
        
        logger.info('Perpetual futures engine stopped');
    }
    
    /**
     * Get market info
     */
    getMarketInfo(symbol) {
        const market = this.markets.get(symbol);
        if (!market) return null;
        
        const markPrice = this.markPrices.get(symbol);
        const indexPrice = this.indexPrices.get(symbol);
        const fundingRate = this.fundingRates.get(symbol);
        
        return {
            ...market,
            markPrice: markPrice?.price,
            indexPrice: indexPrice?.price,
            fundingRate: fundingRate?.rate,
            nextFunding: fundingRate?.nextFunding,
            totalOpenInterest: market.openInterestLong + market.openInterestShort
        };
    }
    
    /**
     * Get position info
     */
    getPosition(positionId) {
        return this.positions.get(positionId);
    }
    
    /**
     * Get user positions
     */
    getUserPositions(userId) {
        const positions = this.userPositions.get(userId);
        if (!positions) return [];
        
        return Array.from(positions.values());
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            markets: this.markets.size,
            activePositions: this.positions.size,
            insuranceFund: this.insuranceFund,
            timestamp: Date.now()
        };
    }
}

export default PerpetualFuturesEngine;