/**
 * Futures Trading Engine for Otedama
 * High-performance perpetual and dated futures
 * 
 * Design:
 * - Perpetual contracts with funding rates
 * - Dated futures with expiry
 * - Up to 100x leverage
 * - Mark price calculation
 * - Liquidation engine
 */

import { EventEmitter } from 'events';
import { MatchingEngine } from '../dex/matching-engine.js';
import { getLogger } from '../core/logger.js';

export class FuturesEngine extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            maxLeverage: config.maxLeverage || 100,
            initialMarginRate: config.initialMarginRate || 0.01, // 1%
            maintenanceMarginRate: config.maintenanceMarginRate || 0.005, // 0.5%
            fundingInterval: config.fundingInterval || 8 * 60 * 60 * 1000, // 8 hours
            maxFundingRate: config.maxFundingRate || 0.01, // 1% per interval
            insuranceFundRatio: config.insuranceFundRatio || 0.001, // 0.1% of volume
            takerFee: config.takerFee || 0.0006, // 0.06%
            makerFee: config.makerFee || 0.0002, // 0.02%
            ...config
        };
        
        this.logger = getLogger('FuturesEngine');
        
        // Contract registry
        this.contracts = new Map();
        
        // Position tracking
        this.positions = new Map(); // userId -> contractId -> position
        
        // Mark price calculation
        this.markPrices = new Map();
        
        // Funding rates
        this.fundingRates = new Map();
        
        // Insurance fund
        this.insuranceFund = new Map(); // asset -> amount
        
        // Liquidation queue
        this.liquidationQueue = [];
        
        // Order matching engines per contract
        this.matchingEngines = new Map();
        
        this.isRunning = false;
    }
    
    /**
     * Start futures engine
     */
    async start() {
        if (this.isRunning) return;
        
        this.logger.info('Starting futures engine...');
        
        // Start mark price calculation
        this.startMarkPriceCalculation();
        
        // Start funding rate calculation
        this.startFundingRateCalculation();
        
        // Start liquidation monitoring
        this.startLiquidationMonitoring();
        
        this.isRunning = true;
        this.logger.info('Futures engine started');
    }
    
    /**
     * Create new futures contract
     */
    createContract(params) {
        const {
            symbol,
            type = 'perpetual', // perpetual or dated
            underlying,
            quoteCurrency,
            contractSize,
            expiryDate = null,
            settlementAsset = 'USDT'
        } = params;
        
        const contractId = `${symbol}-${type.toUpperCase()}`;
        
        if (this.contracts.has(contractId)) {
            throw new Error(`Contract ${contractId} already exists`);
        }
        
        const contract = {
            id: contractId,
            symbol,
            type,
            underlying,
            quoteCurrency,
            contractSize,
            expiryDate,
            settlementAsset,
            status: 'active',
            createdAt: Date.now(),
            volume24h: 0,
            openInterest: 0,
            lastPrice: 0,
            markPrice: 0,
            indexPrice: 0,
            fundingRate: 0,
            nextFundingTime: type === 'perpetual' ? 
                Date.now() + this.config.fundingInterval : null
        };
        
        this.contracts.set(contractId, contract);
        
        // Create matching engine for contract
        const matchingEngine = new MatchingEngine({
            market: contractId,
            tickSize: 0.01,
            minOrderSize: contractSize
        });
        
        this.matchingEngines.set(contractId, matchingEngine);
        
        // Initialize mark price
        this.markPrices.set(contractId, {
            price: 0,
            timestamp: Date.now()
        });
        
        this.logger.info(`Created futures contract: ${contractId}`);
        this.emit('contract-created', contract);
        
        return contract;
    }
    
    /**
     * Open futures position
     */
    async openPosition(params) {
        const {
            userId,
            contractId,
            side, // long or short
            size,
            leverage = 1,
            orderType = 'market',
            price = null
        } = params;
        
        const contract = this.contracts.get(contractId);
        if (!contract) {
            throw new Error(`Contract ${contractId} not found`);
        }
        
        // Validate leverage
        if (leverage > this.config.maxLeverage) {
            throw new Error(`Leverage ${leverage}x exceeds maximum ${this.config.maxLeverage}x`);
        }
        
        // Calculate required margin
        const notionalValue = size * (price || contract.markPrice);
        const requiredMargin = notionalValue / leverage;
        
        // Check user balance
        const userBalance = await this.getUserBalance(userId, contract.settlementAsset);
        if (userBalance < requiredMargin) {
            throw new Error('Insufficient margin');
        }
        
        // Create order
        const order = {
            id: this.generateOrderId(),
            userId,
            contractId,
            type: orderType,
            side: side === 'long' ? 'buy' : 'sell',
            size,
            price: orderType === 'market' ? null : price,
            leverage,
            margin: requiredMargin,
            timestamp: Date.now(),
            status: 'pending'
        };
        
        // Submit to matching engine
        const matchingEngine = this.matchingEngines.get(contractId);
        const result = await matchingEngine.submitOrder(order);
        
        if (result.fills.length > 0) {
            // Update position
            await this.updatePosition(userId, contractId, result.fills, leverage);
            
            // Update contract stats
            this.updateContractStats(contractId, result.fills);
        }
        
        return {
            order,
            fills: result.fills,
            position: this.getPosition(userId, contractId)
        };
    }
    
    /**
     * Update user position
     */
    async updatePosition(userId, contractId, fills, leverage) {
        if (!this.positions.has(userId)) {
            this.positions.set(userId, new Map());
        }
        
        const userPositions = this.positions.get(userId);
        let position = userPositions.get(contractId) || {
            userId,
            contractId,
            size: 0,
            avgEntryPrice: 0,
            leverage,
            margin: 0,
            unrealizedPnL: 0,
            realizedPnL: 0,
            liquidationPrice: 0,
            timestamp: Date.now()
        };
        
        // Process fills
        for (const fill of fills) {
            const fillSize = fill.side === 'buy' ? fill.amount : -fill.amount;
            const fillValue = fill.amount * fill.price;
            
            if (position.size === 0) {
                // New position
                position.size = fillSize;
                position.avgEntryPrice = fill.price;
                position.margin = fillValue / leverage;
            } else if ((position.size > 0 && fillSize > 0) || 
                      (position.size < 0 && fillSize < 0)) {
                // Adding to position
                const totalValue = Math.abs(position.size) * position.avgEntryPrice + fillValue;
                position.size += fillSize;
                position.avgEntryPrice = totalValue / Math.abs(position.size);
                position.margin += fillValue / leverage;
            } else {
                // Reducing or closing position
                const closedSize = Math.min(Math.abs(position.size), Math.abs(fillSize));
                const pnl = closedSize * (fill.price - position.avgEntryPrice) * 
                           (position.size > 0 ? 1 : -1);
                
                position.realizedPnL += pnl;
                position.size += fillSize;
                
                if (position.size === 0) {
                    // Position closed
                    position.avgEntryPrice = 0;
                    position.margin = 0;
                } else {
                    // Position reduced
                    position.margin *= Math.abs(position.size) / 
                                     (Math.abs(position.size) + closedSize);
                }
            }
            
            // Pay fees
            const fee = fillValue * (fill.isMaker ? 
                this.config.makerFee : this.config.takerFee);
            position.realizedPnL -= fee;
            
            // Add to insurance fund
            this.addToInsuranceFund(contractId, fee * this.config.insuranceFundRatio);
        }
        
        // Calculate liquidation price
        if (position.size !== 0) {
            position.liquidationPrice = this.calculateLiquidationPrice(position);
        }
        
        userPositions.set(contractId, position);
        
        this.emit('position-updated', {
            userId,
            contractId,
            position
        });
        
        return position;
    }
    
    /**
     * Calculate liquidation price
     */
    calculateLiquidationPrice(position) {
        const { size, avgEntryPrice, margin } = position;
        const maintenanceMargin = Math.abs(size) * avgEntryPrice * 
                                this.config.maintenanceMarginRate;
        
        if (size > 0) {
            // Long position
            return avgEntryPrice * (1 - (margin - maintenanceMargin) / 
                   (Math.abs(size) * avgEntryPrice));
        } else {
            // Short position
            return avgEntryPrice * (1 + (margin - maintenanceMargin) / 
                   (Math.abs(size) * avgEntryPrice));
        }
    }
    
    /**
     * Close position
     */
    async closePosition(userId, contractId, orderType = 'market', price = null) {
        const position = this.getPosition(userId, contractId);
        if (!position || position.size === 0) {
            throw new Error('No position to close');
        }
        
        // Create closing order
        const params = {
            userId,
            contractId,
            side: position.size > 0 ? 'short' : 'long',
            size: Math.abs(position.size),
            leverage: position.leverage,
            orderType,
            price
        };
        
        return await this.openPosition(params);
    }
    
    /**
     * Calculate mark price
     */
    calculateMarkPrice(contractId) {
        const contract = this.contracts.get(contractId);
        if (!contract) return 0;
        
        const matchingEngine = this.matchingEngines.get(contractId);
        const orderbook = matchingEngine.getOrderbook();
        
        // Mark price = (Best Bid + Best Ask) / 2
        // With additional checks for manipulation
        const bestBid = orderbook.bids[0]?.[0] || 0;
        const bestAsk = orderbook.asks[0]?.[0] || 0;
        
        if (bestBid && bestAsk) {
            const midPrice = (bestBid + bestAsk) / 2;
            
            // Apply bounds to prevent manipulation
            const indexPrice = contract.indexPrice || midPrice;
            const maxDeviation = 0.005; // 0.5%
            
            const lowerBound = indexPrice * (1 - maxDeviation);
            const upperBound = indexPrice * (1 + maxDeviation);
            
            return Math.max(lowerBound, Math.min(upperBound, midPrice));
        }
        
        return contract.indexPrice || contract.lastPrice || 0;
    }
    
    /**
     * Calculate funding rate
     */
    calculateFundingRate(contractId) {
        const contract = this.contracts.get(contractId);
        if (!contract || contract.type !== 'perpetual') return 0;
        
        const markPrice = contract.markPrice || 0;
        const indexPrice = contract.indexPrice || markPrice;
        
        if (indexPrice === 0) return 0;
        
        // Funding Rate = (Mark Price - Index Price) / Index Price / Funding Interval
        const premium = (markPrice - indexPrice) / indexPrice;
        const fundingRate = premium / (this.config.fundingInterval / (8 * 60 * 60 * 1000));
        
        // Apply bounds
        return Math.max(-this.config.maxFundingRate, 
               Math.min(this.config.maxFundingRate, fundingRate));
    }
    
    /**
     * Process funding payments
     */
    async processFunding(contractId) {
        const contract = this.contracts.get(contractId);
        if (!contract || contract.type !== 'perpetual') return;
        
        const fundingRate = this.calculateFundingRate(contractId);
        contract.fundingRate = fundingRate;
        
        this.logger.info(`Processing funding for ${contractId}: ${fundingRate}`);
        
        // Process all positions
        for (const [userId, userPositions] of this.positions) {
            const position = userPositions.get(contractId);
            if (!position || position.size === 0) continue;
            
            // Funding Payment = Position Size * Mark Price * Funding Rate
            const fundingPayment = position.size * contract.markPrice * fundingRate;
            
            // Longs pay shorts when funding is positive
            position.realizedPnL -= fundingPayment;
            
            // Update position
            this.emit('funding-payment', {
                userId,
                contractId,
                fundingPayment,
                fundingRate
            });
        }
        
        // Schedule next funding
        contract.nextFundingTime = Date.now() + this.config.fundingInterval;
    }
    
    /**
     * Liquidate position
     */
    async liquidatePosition(userId, contractId) {
        const position = this.getPosition(userId, contractId);
        if (!position || position.size === 0) return;
        
        this.logger.warn(`Liquidating position: ${userId} ${contractId}`);
        
        // Calculate liquidation penalty
        const liquidationPenalty = Math.abs(position.size) * position.avgEntryPrice * 
                                 this.config.maintenanceMarginRate;
        
        // Create liquidation order
        const liquidationOrder = {
            id: `LIQ-${this.generateOrderId()}`,
            userId: 'LIQUIDATION_ENGINE',
            contractId,
            type: 'market',
            side: position.size > 0 ? 'sell' : 'buy',
            size: Math.abs(position.size),
            timestamp: Date.now(),
            isLiquidation: true
        };
        
        // Submit to matching engine
        const matchingEngine = this.matchingEngines.get(contractId);
        const result = await matchingEngine.submitOrder(liquidationOrder);
        
        if (result.fills.length > 0) {
            // Calculate final PnL
            let liquidationPnL = 0;
            for (const fill of result.fills) {
                const pnl = fill.amount * (fill.price - position.avgEntryPrice) * 
                           (position.size > 0 ? 1 : -1);
                liquidationPnL += pnl;
            }
            
            // Remaining margin goes to insurance fund
            const remainingMargin = position.margin + liquidationPnL - liquidationPenalty;
            if (remainingMargin > 0) {
                this.addToInsuranceFund(contractId, remainingMargin);
            } else {
                // Use insurance fund to cover losses
                this.useInsuranceFund(contractId, -remainingMargin);
            }
            
            // Clear position
            const userPositions = this.positions.get(userId);
            userPositions.delete(contractId);
            
            this.emit('position-liquidated', {
                userId,
                contractId,
                position,
                liquidationPrice: result.fills[0]?.price || 0,
                loss: -remainingMargin
            });
        }
        
        return result;
    }
    
    /**
     * Monitor positions for liquidation
     */
    async checkLiquidations() {
        for (const [userId, userPositions] of this.positions) {
            for (const [contractId, position] of userPositions) {
                if (position.size === 0) continue;
                
                const contract = this.contracts.get(contractId);
                if (!contract) continue;
                
                const markPrice = contract.markPrice;
                
                // Check if position should be liquidated
                const shouldLiquidate = position.size > 0 ? 
                    markPrice <= position.liquidationPrice :
                    markPrice >= position.liquidationPrice;
                
                if (shouldLiquidate) {
                    this.liquidationQueue.push({ userId, contractId });
                }
            }
        }
        
        // Process liquidation queue
        while (this.liquidationQueue.length > 0) {
            const { userId, contractId } = this.liquidationQueue.shift();
            try {
                await this.liquidatePosition(userId, contractId);
            } catch (error) {
                this.logger.error(`Liquidation failed: ${error.message}`);
            }
        }
    }
    
    /**
     * Get user position
     */
    getPosition(userId, contractId) {
        const userPositions = this.positions.get(userId);
        if (!userPositions) return null;
        
        const position = userPositions.get(contractId);
        if (!position || position.size === 0) return null;
        
        // Calculate unrealized PnL
        const contract = this.contracts.get(contractId);
        if (contract) {
            position.unrealizedPnL = position.size * 
                (contract.markPrice - position.avgEntryPrice);
        }
        
        return position;
    }
    
    /**
     * Get all user positions
     */
    getUserPositions(userId) {
        const userPositions = this.positions.get(userId);
        if (!userPositions) return [];
        
        const positions = [];
        for (const [contractId, position] of userPositions) {
            if (position.size !== 0) {
                // Update unrealized PnL
                const contract = this.contracts.get(contractId);
                if (contract) {
                    position.unrealizedPnL = position.size * 
                        (contract.markPrice - position.avgEntryPrice);
                }
                positions.push(position);
            }
        }
        
        return positions;
    }
    
    /**
     * Update contract statistics
     */
    updateContractStats(contractId, fills) {
        const contract = this.contracts.get(contractId);
        if (!contract) return;
        
        let volume = 0;
        let lastPrice = contract.lastPrice;
        
        for (const fill of fills) {
            volume += fill.amount * fill.price;
            lastPrice = fill.price;
        }
        
        contract.volume24h += volume;
        contract.lastPrice = lastPrice;
        
        // Update open interest
        let openInterest = 0;
        for (const [userId, userPositions] of this.positions) {
            const position = userPositions.get(contractId);
            if (position && position.size !== 0) {
                openInterest += Math.abs(position.size);
            }
        }
        contract.openInterest = openInterest;
    }
    
    /**
     * Insurance fund management
     */
    addToInsuranceFund(contractId, amount) {
        const contract = this.contracts.get(contractId);
        if (!contract) return;
        
        const asset = contract.settlementAsset;
        const currentAmount = this.insuranceFund.get(asset) || 0;
        this.insuranceFund.set(asset, currentAmount + amount);
        
        this.emit('insurance-fund-updated', {
            asset,
            amount: currentAmount + amount,
            change: amount
        });
    }
    
    useInsuranceFund(contractId, amount) {
        const contract = this.contracts.get(contractId);
        if (!contract) return false;
        
        const asset = contract.settlementAsset;
        const currentAmount = this.insuranceFund.get(asset) || 0;
        
        if (currentAmount >= amount) {
            this.insuranceFund.set(asset, currentAmount - amount);
            
            this.emit('insurance-fund-used', {
                asset,
                amount: currentAmount - amount,
                used: amount
            });
            
            return true;
        }
        
        return false;
    }
    
    /**
     * Start periodic tasks
     */
    startMarkPriceCalculation() {
        setInterval(() => {
            for (const [contractId, contract] of this.contracts) {
                const markPrice = this.calculateMarkPrice(contractId);
                contract.markPrice = markPrice;
                
                this.markPrices.set(contractId, {
                    price: markPrice,
                    timestamp: Date.now()
                });
                
                this.emit('mark-price-updated', {
                    contractId,
                    markPrice
                });
            }
        }, 1000); // Every second
    }
    
    startFundingRateCalculation() {
        setInterval(() => {
            const now = Date.now();
            
            for (const [contractId, contract] of this.contracts) {
                if (contract.type === 'perpetual' && 
                    contract.nextFundingTime <= now) {
                    this.processFunding(contractId);
                }
            }
        }, 60000); // Every minute
    }
    
    startLiquidationMonitoring() {
        setInterval(() => {
            this.checkLiquidations();
        }, 100); // Every 100ms for quick liquidations
    }
    
    /**
     * Helper functions
     */
    generateOrderId() {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    async getUserBalance(userId, asset) {
        // This would integrate with the main wallet system
        // For now, return mock balance
        return 10000;
    }
    
    /**
     * Get contract information
     */
    getContract(contractId) {
        return this.contracts.get(contractId);
    }
    
    getAllContracts() {
        return Array.from(this.contracts.values());
    }
    
    getActiveContracts() {
        return this.getAllContracts().filter(c => c.status === 'active');
    }
    
    /**
     * Settlement for dated futures
     */
    async settleFutures(contractId) {
        const contract = this.contracts.get(contractId);
        if (!contract || contract.type !== 'dated') return;
        
        const now = Date.now();
        if (now < contract.expiryDate) return;
        
        this.logger.info(`Settling futures contract: ${contractId}`);
        
        // Get settlement price (usually from index)
        const settlementPrice = contract.indexPrice;
        
        // Settle all positions
        for (const [userId, userPositions] of this.positions) {
            const position = userPositions.get(contractId);
            if (!position || position.size === 0) continue;
            
            // Calculate settlement PnL
            const settlementPnL = position.size * 
                (settlementPrice - position.avgEntryPrice);
            
            // Credit user account
            position.realizedPnL += settlementPnL;
            
            this.emit('position-settled', {
                userId,
                contractId,
                position,
                settlementPrice,
                settlementPnL
            });
            
            // Clear position
            userPositions.delete(contractId);
        }
        
        // Mark contract as settled
        contract.status = 'settled';
        contract.settlementPrice = settlementPrice;
        contract.settlementTime = now;
    }
    
    /**
     * Stop futures engine
     */
    async stop() {
        if (!this.isRunning) return;
        
        this.logger.info('Stopping futures engine...');
        
        // Clear all intervals
        // (Would need to store interval IDs)
        
        this.isRunning = false;
        this.logger.info('Futures engine stopped');
    }
}

export default FuturesEngine;