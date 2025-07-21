/**
 * Options Trading Engine for Otedama
 * European and American style options with Greeks calculation
 * 
 * Design:
 * - Call and Put options
 * - European and American exercise styles
 * - Black-Scholes pricing model
 * - Real-time Greeks calculation
 * - Automated market making
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

export class OptionsEngine extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            riskFreeRate: config.riskFreeRate || 0.05, // 5% annual
            minStrike: config.minStrike || 0.5, // 50% of spot
            maxStrike: config.maxStrike || 2.0, // 200% of spot
            strikeInterval: config.strikeInterval || 100, // $100 intervals
            expiryIntervals: config.expiryIntervals || [
                1, 7, 14, 30, 60, 90 // days
            ],
            minPremium: config.minPremium || 0.01,
            tradingFee: config.tradingFee || 0.001, // 0.1%
            exerciseFee: config.exerciseFee || 0.0005, // 0.05%
            ...config
        };
        
        this.logger = getLogger('OptionsEngine');
        
        // Options registry
        this.options = new Map(); // optionId -> option
        
        // Active positions
        this.positions = new Map(); // userId -> optionId -> position
        
        // Market makers
        this.marketMakers = new Map(); // optionId -> marketMaker
        
        // Implied volatility surface
        this.ivSurface = new Map(); // underlying -> strike -> expiry -> IV
        
        // Exercise queue
        this.exerciseQueue = [];
        
        this.isRunning = false;
    }
    
    /**
     * Start options engine
     */
    async start() {
        if (this.isRunning) return;
        
        this.logger.info('Starting options engine...');
        
        // Start Greeks calculation
        this.startGreeksCalculation();
        
        // Start expiry monitoring
        this.startExpiryMonitoring();
        
        // Start market making
        this.startMarketMaking();
        
        this.isRunning = true;
        this.logger.info('Options engine started');
    }
    
    /**
     * Create option series
     */
    createOptionSeries(params) {
        const {
            underlying,
            expiryDate,
            strikes = []
        } = params;
        
        const options = [];
        
        // Generate strikes if not provided
        const spotPrice = this.getSpotPrice(underlying);
        const generatedStrikes = strikes.length > 0 ? strikes : 
            this.generateStrikes(spotPrice);
        
        // Create call and put for each strike
        for (const strike of generatedStrikes) {
            // Call option
            const call = this.createOption({
                underlying,
                strike,
                expiryDate,
                type: 'call',
                style: 'european'
            });
            options.push(call);
            
            // Put option
            const put = this.createOption({
                underlying,
                strike,
                expiryDate,
                type: 'put',
                style: 'european'
            });
            options.push(put);
        }
        
        this.logger.info(`Created option series: ${underlying} expiry ${new Date(expiryDate).toISOString()}`);
        
        return options;
    }
    
    /**
     * Create single option
     */
    createOption(params) {
        const {
            underlying,
            strike,
            expiryDate,
            type, // call or put
            style = 'european' // european or american
        } = params;
        
        const optionId = `${underlying}-${strike}-${type.toUpperCase()}-${expiryDate}`;
        
        if (this.options.has(optionId)) {
            return this.options.get(optionId);
        }
        
        const option = {
            id: optionId,
            underlying,
            strike,
            expiryDate,
            type,
            style,
            createdAt: Date.now(),
            volume: 0,
            openInterest: 0,
            lastPrice: 0,
            bid: 0,
            ask: 0,
            impliedVolatility: 0.3, // 30% initial IV
            greeks: {
                delta: 0,
                gamma: 0,
                theta: 0,
                vega: 0,
                rho: 0
            }
        };
        
        this.options.set(optionId, option);
        
        // Initialize market maker
        this.initializeMarketMaker(option);
        
        // Calculate initial price and Greeks
        this.updateOptionPricing(option);
        
        this.emit('option-created', option);
        
        return option;
    }
    
    /**
     * Buy option
     */
    async buyOption(params) {
        const {
            userId,
            optionId,
            quantity,
            orderType = 'market',
            limitPrice = null
        } = params;
        
        const option = this.options.get(optionId);
        if (!option) {
            throw new Error(`Option ${optionId} not found`);
        }
        
        // Get market price
        const marketPrice = orderType === 'market' ? 
            option.ask : Math.min(limitPrice, option.ask);
        
        if (marketPrice < this.config.minPremium) {
            throw new Error('Price below minimum premium');
        }
        
        // Calculate cost
        const premium = marketPrice * quantity * this.getMultiplier(option.underlying);
        const fee = premium * this.config.tradingFee;
        const totalCost = premium + fee;
        
        // Check user balance
        const balance = await this.getUserBalance(userId);
        if (balance < totalCost) {
            throw new Error('Insufficient balance');
        }
        
        // Execute trade
        const trade = {
            id: this.generateTradeId(),
            userId,
            optionId,
            type: 'buy',
            quantity,
            price: marketPrice,
            premium,
            fee,
            timestamp: Date.now()
        };
        
        // Update position
        await this.updatePosition(userId, optionId, quantity, marketPrice);
        
        // Update option stats
        option.volume += quantity;
        option.openInterest += quantity;
        option.lastPrice = marketPrice;
        
        // Update market maker inventory
        const marketMaker = this.marketMakers.get(optionId);
        if (marketMaker) {
            marketMaker.inventory -= quantity;
            this.updateMarketMakerQuotes(optionId);
        }
        
        this.emit('option-traded', trade);
        
        return trade;
    }
    
    /**
     * Sell option
     */
    async sellOption(params) {
        const {
            userId,
            optionId,
            quantity,
            orderType = 'market',
            limitPrice = null
        } = params;
        
        const option = this.options.get(optionId);
        if (!option) {
            throw new Error(`Option ${optionId} not found`);
        }
        
        // Check if user has position to sell
        const position = this.getPosition(userId, optionId);
        if (!position || position.quantity < quantity) {
            throw new Error('Insufficient position');
        }
        
        // Get market price
        const marketPrice = orderType === 'market' ? 
            option.bid : Math.max(limitPrice, option.bid);
        
        // Calculate proceeds
        const premium = marketPrice * quantity * this.getMultiplier(option.underlying);
        const fee = premium * this.config.tradingFee;
        const netProceeds = premium - fee;
        
        // Execute trade
        const trade = {
            id: this.generateTradeId(),
            userId,
            optionId,
            type: 'sell',
            quantity,
            price: marketPrice,
            premium,
            fee,
            timestamp: Date.now()
        };
        
        // Update position
        await this.updatePosition(userId, optionId, -quantity, marketPrice);
        
        // Update option stats
        option.volume += quantity;
        option.openInterest -= quantity;
        option.lastPrice = marketPrice;
        
        // Update market maker inventory
        const marketMaker = this.marketMakers.get(optionId);
        if (marketMaker) {
            marketMaker.inventory += quantity;
            this.updateMarketMakerQuotes(optionId);
        }
        
        this.emit('option-traded', trade);
        
        return trade;
    }
    
    /**
     * Exercise option
     */
    async exerciseOption(userId, optionId, quantity) {
        const option = this.options.get(optionId);
        if (!option) {
            throw new Error(`Option ${optionId} not found`);
        }
        
        const position = this.getPosition(userId, optionId);
        if (!position || position.quantity < quantity) {
            throw new Error('Insufficient position');
        }
        
        // Check if option can be exercised
        const now = Date.now();
        if (option.style === 'european' && now < option.expiryDate) {
            throw new Error('European option can only be exercised at expiry');
        }
        
        if (now > option.expiryDate) {
            throw new Error('Option has expired');
        }
        
        // Check if in-the-money
        const spotPrice = this.getSpotPrice(option.underlying);
        const isITM = option.type === 'call' ? 
            spotPrice > option.strike : spotPrice < option.strike;
        
        if (!isITM) {
            throw new Error('Option is out-of-the-money');
        }
        
        // Calculate exercise value
        const intrinsicValue = option.type === 'call' ?
            Math.max(0, spotPrice - option.strike) :
            Math.max(0, option.strike - spotPrice);
        
        const exerciseValue = intrinsicValue * quantity * 
                            this.getMultiplier(option.underlying);
        const fee = exerciseValue * this.config.exerciseFee;
        const netValue = exerciseValue - fee;
        
        // Execute exercise
        const exercise = {
            id: this.generateTradeId(),
            userId,
            optionId,
            quantity,
            spotPrice,
            strike: option.strike,
            intrinsicValue,
            exerciseValue,
            fee,
            netValue,
            timestamp: now
        };
        
        // Update position
        await this.updatePosition(userId, optionId, -quantity, 0);
        
        // Update open interest
        option.openInterest -= quantity;
        
        // Credit user account
        await this.creditUserAccount(userId, netValue);
        
        this.emit('option-exercised', exercise);
        
        return exercise;
    }
    
    /**
     * Calculate option price using Black-Scholes
     */
    calculateOptionPrice(option) {
        const S = this.getSpotPrice(option.underlying); // Spot price
        const K = option.strike; // Strike price
        const t = Math.max(0, (option.expiryDate - Date.now()) / (365 * 24 * 60 * 60 * 1000)); // Time to expiry in years
        const r = this.config.riskFreeRate; // Risk-free rate
        const sigma = option.impliedVolatility; // Implied volatility
        
        if (t === 0) {
            // At expiry, option value is intrinsic value
            return option.type === 'call' ?
                Math.max(0, S - K) :
                Math.max(0, K - S);
        }
        
        // Calculate d1 and d2
        const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * t) / (sigma * Math.sqrt(t));
        const d2 = d1 - sigma * Math.sqrt(t);
        
        // Standard normal CDF
        const N = (x) => {
            const a1 = 0.254829592;
            const a2 = -0.284496736;
            const a3 = 1.421413741;
            const a4 = -1.453152027;
            const a5 = 1.061405429;
            const p = 0.3275911;
            
            const sign = x < 0 ? -1 : 1;
            x = Math.abs(x) / Math.sqrt(2.0);
            
            const t = 1.0 / (1.0 + p * x);
            const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
            
            return 0.5 * (1.0 + sign * y);
        };
        
        // Calculate option price
        if (option.type === 'call') {
            return S * N(d1) - K * Math.exp(-r * t) * N(d2);
        } else {
            return K * Math.exp(-r * t) * N(-d2) - S * N(-d1);
        }
    }
    
    /**
     * Calculate Greeks
     */
    calculateGreeks(option) {
        const S = this.getSpotPrice(option.underlying);
        const K = option.strike;
        const t = Math.max(0.001, (option.expiryDate - Date.now()) / (365 * 24 * 60 * 60 * 1000));
        const r = this.config.riskFreeRate;
        const sigma = option.impliedVolatility;
        
        const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * t) / (sigma * Math.sqrt(t));
        const d2 = d1 - sigma * Math.sqrt(t);
        
        // Standard normal PDF
        const n = (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
        
        // Standard normal CDF
        const N = (x) => {
            const a1 = 0.254829592;
            const a2 = -0.284496736;
            const a3 = 1.421413741;
            const a4 = -1.453152027;
            const a5 = 1.061405429;
            const p = 0.3275911;
            
            const sign = x < 0 ? -1 : 1;
            x = Math.abs(x) / Math.sqrt(2.0);
            
            const t = 1.0 / (1.0 + p * x);
            const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
            
            return 0.5 * (1.0 + sign * y);
        };
        
        const greeks = {};
        
        // Delta - rate of change of option price with respect to underlying price
        if (option.type === 'call') {
            greeks.delta = N(d1);
        } else {
            greeks.delta = N(d1) - 1;
        }
        
        // Gamma - rate of change of delta with respect to underlying price
        greeks.gamma = n(d1) / (S * sigma * Math.sqrt(t));
        
        // Theta - rate of change of option price with respect to time
        if (option.type === 'call') {
            greeks.theta = -(S * n(d1) * sigma / (2 * Math.sqrt(t)) + 
                           r * K * Math.exp(-r * t) * N(d2)) / 365;
        } else {
            greeks.theta = -(S * n(d1) * sigma / (2 * Math.sqrt(t)) - 
                           r * K * Math.exp(-r * t) * N(-d2)) / 365;
        }
        
        // Vega - rate of change of option price with respect to volatility
        greeks.vega = S * n(d1) * Math.sqrt(t) / 100; // Divided by 100 for 1% vol change
        
        // Rho - rate of change of option price with respect to interest rate
        if (option.type === 'call') {
            greeks.rho = K * t * Math.exp(-r * t) * N(d2) / 100; // Divided by 100 for 1% rate change
        } else {
            greeks.rho = -K * t * Math.exp(-r * t) * N(-d2) / 100;
        }
        
        return greeks;
    }
    
    /**
     * Update option pricing and Greeks
     */
    updateOptionPricing(option) {
        // Calculate theoretical price
        const theoreticalPrice = this.calculateOptionPrice(option);
        
        // Calculate Greeks
        option.greeks = this.calculateGreeks(option);
        
        // Update market maker quotes
        const marketMaker = this.marketMakers.get(option.id);
        if (marketMaker) {
            // Add spread based on volatility and time to expiry
            const spread = Math.max(0.01, theoreticalPrice * 0.02); // 2% spread
            
            option.bid = Math.max(this.config.minPremium, theoreticalPrice - spread / 2);
            option.ask = theoreticalPrice + spread / 2;
            
            // Adjust for inventory
            const inventoryAdjustment = marketMaker.inventory * 0.001; // 0.1% per unit
            option.bid *= (1 - inventoryAdjustment);
            option.ask *= (1 - inventoryAdjustment);
        }
        
        return theoreticalPrice;
    }
    
    /**
     * Initialize market maker for option
     */
    initializeMarketMaker(option) {
        const marketMaker = {
            optionId: option.id,
            inventory: 0,
            maxInventory: 1000,
            targetSpread: 0.02, // 2%
            enabled: true
        };
        
        this.marketMakers.set(option.id, marketMaker);
    }
    
    /**
     * Update market maker quotes
     */
    updateMarketMakerQuotes(optionId) {
        const option = this.options.get(optionId);
        const marketMaker = this.marketMakers.get(optionId);
        
        if (!option || !marketMaker || !marketMaker.enabled) return;
        
        // Recalculate pricing with inventory adjustment
        this.updateOptionPricing(option);
        
        this.emit('quotes-updated', {
            optionId,
            bid: option.bid,
            ask: option.ask
        });
    }
    
    /**
     * Update position
     */
    async updatePosition(userId, optionId, quantityChange, price) {
        if (!this.positions.has(userId)) {
            this.positions.set(userId, new Map());
        }
        
        const userPositions = this.positions.get(userId);
        const position = userPositions.get(optionId) || {
            userId,
            optionId,
            quantity: 0,
            avgCost: 0,
            realizedPnL: 0,
            unrealizedPnL: 0
        };
        
        if (quantityChange > 0) {
            // Buying
            const totalCost = position.quantity * position.avgCost + 
                            quantityChange * price;
            position.quantity += quantityChange;
            position.avgCost = position.quantity > 0 ? 
                totalCost / position.quantity : 0;
        } else {
            // Selling
            const soldQuantity = Math.min(position.quantity, -quantityChange);
            const pnl = soldQuantity * (price - position.avgCost) * 
                       this.getMultiplier(this.options.get(optionId).underlying);
            
            position.realizedPnL += pnl;
            position.quantity += quantityChange;
            
            if (position.quantity === 0) {
                position.avgCost = 0;
            }
        }
        
        if (position.quantity > 0) {
            userPositions.set(optionId, position);
        } else {
            userPositions.delete(optionId);
        }
        
        this.emit('position-updated', {
            userId,
            optionId,
            position
        });
    }
    
    /**
     * Get position
     */
    getPosition(userId, optionId) {
        const userPositions = this.positions.get(userId);
        if (!userPositions) return null;
        
        return userPositions.get(optionId);
    }
    
    /**
     * Get all user positions
     */
    getUserPositions(userId) {
        const userPositions = this.positions.get(userId);
        if (!userPositions) return [];
        
        const positions = [];
        for (const [optionId, position] of userPositions) {
            const option = this.options.get(optionId);
            if (option) {
                // Calculate unrealized PnL
                position.unrealizedPnL = position.quantity * 
                    (option.lastPrice - position.avgCost) * 
                    this.getMultiplier(option.underlying);
                
                positions.push({
                    ...position,
                    option
                });
            }
        }
        
        return positions;
    }
    
    /**
     * Generate strike prices
     */
    generateStrikes(spotPrice) {
        const strikes = [];
        const minStrike = spotPrice * this.config.minStrike;
        const maxStrike = spotPrice * this.config.maxStrike;
        
        // Round to strike interval
        const interval = this.config.strikeInterval;
        let strike = Math.floor(minStrike / interval) * interval;
        
        while (strike <= maxStrike) {
            strikes.push(strike);
            strike += interval;
        }
        
        return strikes;
    }
    
    /**
     * Process expired options
     */
    async processExpiredOptions() {
        const now = Date.now();
        
        for (const [optionId, option] of this.options) {
            if (now >= option.expiryDate && option.openInterest > 0) {
                // Auto-exercise ITM options
                const spotPrice = this.getSpotPrice(option.underlying);
                const isITM = option.type === 'call' ? 
                    spotPrice > option.strike : spotPrice < option.strike;
                
                if (isITM) {
                    // Find all positions and auto-exercise
                    for (const [userId, userPositions] of this.positions) {
                        const position = userPositions.get(optionId);
                        if (position && position.quantity > 0) {
                            try {
                                await this.exerciseOption(userId, optionId, position.quantity);
                            } catch (error) {
                                this.logger.error(`Auto-exercise failed: ${error.message}`);
                            }
                        }
                    }
                }
                
                // Mark option as expired
                option.status = 'expired';
                
                this.emit('option-expired', option);
            }
        }
    }
    
    /**
     * Start periodic tasks
     */
    startGreeksCalculation() {
        setInterval(() => {
            for (const [optionId, option] of this.options) {
                if (option.status === 'active') {
                    this.updateOptionPricing(option);
                }
            }
        }, 1000); // Every second
    }
    
    startExpiryMonitoring() {
        setInterval(() => {
            this.processExpiredOptions();
        }, 60000); // Every minute
    }
    
    startMarketMaking() {
        setInterval(() => {
            for (const [optionId, marketMaker] of this.marketMakers) {
                if (marketMaker.enabled) {
                    this.updateMarketMakerQuotes(optionId);
                }
            }
        }, 5000); // Every 5 seconds
    }
    
    /**
     * Helper functions
     */
    generateTradeId() {
        return `OPT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    getSpotPrice(underlying) {
        // This would get real-time price from price feed
        // Mock implementation
        const prices = {
            'BTC': 40000,
            'ETH': 2500,
            'SOL': 100
        };
        return prices[underlying] || 0;
    }
    
    getMultiplier(underlying) {
        // Options contract multiplier
        const multipliers = {
            'BTC': 0.01,  // 0.01 BTC per contract
            'ETH': 0.1,   // 0.1 ETH per contract
            'SOL': 10     // 10 SOL per contract
        };
        return multipliers[underlying] || 1;
    }
    
    async getUserBalance(userId) {
        // This would integrate with wallet system
        return 100000; // Mock balance
    }
    
    async creditUserAccount(userId, amount) {
        // This would integrate with wallet system
        this.logger.info(`Credited ${amount} to user ${userId}`);
    }
    
    /**
     * Get option chain
     */
    getOptionChain(underlying, expiryDate = null) {
        const options = [];
        
        for (const [optionId, option] of this.options) {
            if (option.underlying === underlying && 
                (!expiryDate || option.expiryDate === expiryDate)) {
                options.push(option);
            }
        }
        
        // Sort by strike and type
        options.sort((a, b) => {
            if (a.strike !== b.strike) return a.strike - b.strike;
            return a.type === 'call' ? -1 : 1;
        });
        
        return options;
    }
    
    /**
     * Get implied volatility surface
     */
    getIVSurface(underlying) {
        const surface = [];
        
        for (const [optionId, option] of this.options) {
            if (option.underlying === underlying) {
                surface.push({
                    strike: option.strike,
                    expiry: option.expiryDate,
                    type: option.type,
                    impliedVolatility: option.impliedVolatility
                });
            }
        }
        
        return surface;
    }
    
    /**
     * Stop options engine
     */
    async stop() {
        if (!this.isRunning) return;
        
        this.logger.info('Stopping options engine...');
        
        // Clear all intervals
        // (Would need to store interval IDs)
        
        this.isRunning = false;
        this.logger.info('Options engine stopped');
    }
}

export default OptionsEngine;