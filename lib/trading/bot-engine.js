/**
 * Automated Trading Bot Engine for Otedama
 * High-performance bot framework with multiple strategies
 * 
 * Design principles:
 * - Ultra-low latency execution (Carmack)
 * - Clean strategy architecture (Martin)
 * - Simple bot configuration (Pike)
 */

import { EventEmitter } from 'events';
import { logger } from '../core/logger.js';
import { v4 as uuidv4 } from 'uuid';

export class TradingBotEngine extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            maxBotsPerUser: config.maxBotsPerUser || 10,
            tickInterval: config.tickInterval || 1000, // 1 second
            maxOrdersPerBot: config.maxOrdersPerBot || 50,
            riskManagement: {
                maxDrawdown: config.maxDrawdown || 0.2, // 20%
                maxPositionSize: config.maxPositionSize || 0.1, // 10% of capital
                stopLossRequired: config.stopLossRequired !== false
            },
            ...config
        };
        
        // Bot registry
        this.bots = new Map();
        this.strategies = new Map();
        this.performance = new Map();
        
        // Services
        this.dexEngine = null;
        this.pricePredictor = null;
        
        // Initialize built-in strategies
        this.initializeStrategies();
        
        // Start main loop
        this.startMainLoop();
    }
    
    /**
     * Initialize built-in trading strategies
     */
    initializeStrategies() {
        // Grid Trading Strategy
        this.registerStrategy('grid', {
            name: 'Grid Trading',
            description: 'Places buy and sell orders at regular intervals',
            parameters: {
                gridLevels: { type: 'number', default: 10, min: 5, max: 50 },
                gridSpacing: { type: 'number', default: 0.01, min: 0.001, max: 0.1 },
                orderSize: { type: 'number', default: 0.1, min: 0.01 },
                takeProfit: { type: 'number', default: 0.02, min: 0.005 }
            },
            execute: this.executeGridStrategy.bind(this)
        });
        
        // DCA (Dollar Cost Averaging) Strategy
        this.registerStrategy('dca', {
            name: 'Dollar Cost Averaging',
            description: 'Buys at regular intervals regardless of price',
            parameters: {
                interval: { type: 'number', default: 3600000, min: 60000 }, // milliseconds
                amount: { type: 'number', default: 100, min: 10 },
                maxOrders: { type: 'number', default: 100, min: 1 }
            },
            execute: this.executeDCAStrategy.bind(this)
        });
        
        // Momentum Trading Strategy
        this.registerStrategy('momentum', {
            name: 'Momentum Trading',
            description: 'Trades based on price momentum and volume',
            parameters: {
                lookback: { type: 'number', default: 20, min: 10, max: 100 },
                threshold: { type: 'number', default: 0.02, min: 0.01, max: 0.1 },
                stopLoss: { type: 'number', default: 0.03, min: 0.01 },
                takeProfit: { type: 'number', default: 0.05, min: 0.02 }
            },
            execute: this.executeMomentumStrategy.bind(this)
        });
        
        // Arbitrage Strategy
        this.registerStrategy('arbitrage', {
            name: 'Arbitrage Trading',
            description: 'Exploits price differences between pairs',
            parameters: {
                minProfit: { type: 'number', default: 0.001, min: 0.0001 },
                maxSlippage: { type: 'number', default: 0.0005, min: 0.0001 },
                pairs: { type: 'array', default: ['BTC/USDT', 'ETH/USDT', 'ETH/BTC'] }
            },
            execute: this.executeArbitrageStrategy.bind(this)
        });
        
        // ML-Based Strategy
        this.registerStrategy('ml-signals', {
            name: 'ML Signal Trading',
            description: 'Trades based on machine learning predictions',
            parameters: {
                confidenceThreshold: { type: 'number', default: 0.7, min: 0.5, max: 0.95 },
                positionSize: { type: 'number', default: 0.05, min: 0.01, max: 0.2 },
                stopLoss: { type: 'number', default: 0.02, min: 0.01 },
                timeframe: { type: 'string', default: '5m', options: ['1m', '5m', '15m'] }
            },
            execute: this.executeMLStrategy.bind(this)
        });
        
        // Market Making Strategy
        this.registerStrategy('market-maker', {
            name: 'Market Making',
            description: 'Provides liquidity by placing bid/ask orders',
            parameters: {
                spread: { type: 'number', default: 0.002, min: 0.001, max: 0.01 },
                orderSize: { type: 'number', default: 0.1, min: 0.01 },
                orderDepth: { type: 'number', default: 5, min: 1, max: 20 },
                rebalanceThreshold: { type: 'number', default: 0.1, min: 0.05 }
            },
            execute: this.executeMarketMakerStrategy.bind(this)
        });
    }
    
    /**
     * Connect to services
     */
    connectServices(services) {
        this.dexEngine = services.dexEngine;
        this.pricePredictor = services.pricePredictor;
        
        // Subscribe to market events
        if (this.dexEngine) {
            this.dexEngine.on('trade:executed', (trade) => {
                this.handleMarketTrade(trade);
            });
            
            this.dexEngine.on('orderbook:update', (update) => {
                this.handleOrderBookUpdate(update);
            });
        }
    }
    
    /**
     * Register a custom strategy
     */
    registerStrategy(id, strategy) {
        this.strategies.set(id, strategy);
        logger.info(`Registered trading strategy: ${strategy.name}`);
    }
    
    /**
     * Create a new trading bot
     */
    async createBot(userId, config) {
        // Validate user bot limit
        const userBots = Array.from(this.bots.values()).filter(bot => bot.userId === userId);
        if (userBots.length >= this.config.maxBotsPerUser) {
            throw new Error(`Maximum bot limit (${this.config.maxBotsPerUser}) reached`);
        }
        
        // Validate strategy
        const strategy = this.strategies.get(config.strategy);
        if (!strategy) {
            throw new Error(`Unknown strategy: ${config.strategy}`);
        }
        
        // Validate parameters
        const parameters = this.validateParameters(strategy.parameters, config.parameters);
        
        // Create bot instance
        const bot = {
            id: uuidv4(),
            userId,
            name: config.name || `${strategy.name} Bot`,
            strategy: config.strategy,
            pair: config.pair,
            capital: config.capital || 1000,
            parameters,
            status: 'inactive',
            createdAt: Date.now(),
            startedAt: null,
            performance: {
                trades: 0,
                wins: 0,
                losses: 0,
                profit: 0,
                drawdown: 0,
                sharpeRatio: 0
            },
            orders: new Map(),
            positions: new Map(),
            state: {}
        };
        
        this.bots.set(bot.id, bot);
        
        logger.info(`Created trading bot ${bot.id} for user ${userId}`);
        
        this.emit('bot:created', { bot });
        
        return bot;
    }
    
    /**
     * Start a trading bot
     */
    async startBot(botId, userId) {
        const bot = this.bots.get(botId);
        if (!bot) {
            throw new Error('Bot not found');
        }
        
        if (bot.userId !== userId) {
            throw new Error('Unauthorized');
        }
        
        if (bot.status === 'active') {
            throw new Error('Bot already active');
        }
        
        // Check capital availability
        const balance = await this.checkBalance(userId, bot.pair);
        if (balance < bot.capital) {
            throw new Error('Insufficient balance');
        }
        
        bot.status = 'active';
        bot.startedAt = Date.now();
        
        logger.info(`Started bot ${botId}`);
        
        this.emit('bot:started', { bot });
        
        return bot;
    }
    
    /**
     * Stop a trading bot
     */
    async stopBot(botId, userId) {
        const bot = this.bots.get(botId);
        if (!bot) {
            throw new Error('Bot not found');
        }
        
        if (bot.userId !== userId) {
            throw new Error('Unauthorized');
        }
        
        // Cancel all pending orders
        for (const [orderId, order] of bot.orders) {
            if (order.status === 'pending') {
                await this.cancelOrder(bot, orderId);
            }
        }
        
        // Close all positions
        for (const [asset, position] of bot.positions) {
            await this.closePosition(bot, asset);
        }
        
        bot.status = 'inactive';
        
        logger.info(`Stopped bot ${botId}`);
        
        this.emit('bot:stopped', { bot });
        
        return bot;
    }
    
    /**
     * Main execution loop
     */
    startMainLoop() {
        setInterval(() => {
            this.executeTick();
        }, this.config.tickInterval);
    }
    
    /**
     * Execute one tick for all active bots
     */
    async executeTick() {
        const activeBots = Array.from(this.bots.values()).filter(bot => bot.status === 'active');
        
        for (const bot of activeBots) {
            try {
                await this.executeBot(bot);
            } catch (error) {
                logger.error(`Bot ${bot.id} execution error:`, error);
                
                // Stop bot on critical errors
                if (this.isCriticalError(error)) {
                    await this.stopBot(bot.id, bot.userId);
                    this.emit('bot:error', { bot, error });
                }
            }
        }
    }
    
    /**
     * Execute bot strategy
     */
    async executeBot(bot) {
        // Check risk limits
        if (!this.checkRiskLimits(bot)) {
            logger.warn(`Bot ${bot.id} exceeded risk limits`);
            await this.stopBot(bot.id, bot.userId);
            return;
        }
        
        // Get strategy
        const strategy = this.strategies.get(bot.strategy);
        if (!strategy) {
            throw new Error('Strategy not found');
        }
        
        // Prepare context
        const context = {
            bot,
            marketData: await this.getMarketData(bot.pair),
            orderBook: await this.getOrderBook(bot.pair),
            predictions: this.pricePredictor?.getPredictions(bot.pair),
            balance: await this.getBalance(bot.userId, bot.pair)
        };
        
        // Execute strategy
        const actions = await strategy.execute(context);
        
        // Process actions
        await this.processActions(bot, actions);
        
        // Update performance
        this.updatePerformance(bot);
    }
    
    /**
     * Grid Trading Strategy
     */
    async executeGridStrategy(context) {
        const { bot, marketData, orderBook } = context;
        const { gridLevels, gridSpacing, orderSize, takeProfit } = bot.parameters;
        
        const currentPrice = marketData.price;
        const actions = [];
        
        // Initialize grid if needed
        if (!bot.state.gridInitialized) {
            const basePrice = currentPrice;
            bot.state.grid = [];
            
            // Create grid levels
            for (let i = -gridLevels / 2; i <= gridLevels / 2; i++) {
                if (i === 0) continue;
                
                const price = basePrice * (1 + i * gridSpacing);
                bot.state.grid.push({
                    price,
                    side: i < 0 ? 'buy' : 'sell',
                    filled: false
                });
            }
            
            bot.state.gridInitialized = true;
            bot.state.basePrice = basePrice;
        }
        
        // Check grid levels
        for (const level of bot.state.grid) {
            if (!level.filled && !this.hasOrderAtPrice(bot, level.price)) {
                // Place order at this level
                actions.push({
                    type: 'place_order',
                    order: {
                        side: level.side,
                        type: 'limit',
                        price: level.price,
                        quantity: orderSize,
                        metadata: { gridLevel: level.price }
                    }
                });
            }
        }
        
        // Check for take profit opportunities
        for (const [orderId, order] of bot.orders) {
            if (order.status === 'filled' && order.metadata?.gridLevel) {
                const profitPrice = order.side === 'buy' 
                    ? order.price * (1 + takeProfit)
                    : order.price * (1 - takeProfit);
                
                actions.push({
                    type: 'place_order',
                    order: {
                        side: order.side === 'buy' ? 'sell' : 'buy',
                        type: 'limit',
                        price: profitPrice,
                        quantity: order.quantity,
                        metadata: { takeProfit: true, originalOrder: orderId }
                    }
                });
            }
        }
        
        return actions;
    }
    
    /**
     * DCA Strategy
     */
    async executeDCAStrategy(context) {
        const { bot } = context;
        const { interval, amount, maxOrders } = bot.parameters;
        
        const actions = [];
        
        // Initialize state
        if (!bot.state.lastBuyTime) {
            bot.state.lastBuyTime = 0;
            bot.state.totalOrders = 0;
        }
        
        // Check if it's time to buy
        const now = Date.now();
        if (now - bot.state.lastBuyTime >= interval && bot.state.totalOrders < maxOrders) {
            actions.push({
                type: 'place_order',
                order: {
                    side: 'buy',
                    type: 'market',
                    quoteQuantity: amount, // Buy with fixed quote amount
                    metadata: { dca: true, orderNumber: bot.state.totalOrders + 1 }
                }
            });
            
            bot.state.lastBuyTime = now;
            bot.state.totalOrders++;
        }
        
        return actions;
    }
    
    /**
     * Momentum Strategy
     */
    async executeMomentumStrategy(context) {
        const { bot, marketData } = context;
        const { lookback, threshold, stopLoss, takeProfit } = bot.parameters;
        
        const actions = [];
        
        // Calculate momentum
        const momentum = this.calculateMomentum(marketData.candles, lookback);
        
        // Check for entry signals
        if (!bot.positions.has(bot.pair)) {
            if (momentum > threshold) {
                // Bullish momentum - buy
                actions.push({
                    type: 'place_order',
                    order: {
                        side: 'buy',
                        type: 'market',
                        quantity: bot.capital * bot.parameters.positionSize / marketData.price,
                        metadata: { 
                            strategy: 'momentum',
                            entryMomentum: momentum,
                            stopLoss: marketData.price * (1 - stopLoss),
                            takeProfit: marketData.price * (1 + takeProfit)
                        }
                    }
                });
            }
        } else {
            // Check exit conditions
            const position = bot.positions.get(bot.pair);
            const currentPrice = marketData.price;
            
            if (currentPrice <= position.stopLoss || currentPrice >= position.takeProfit) {
                actions.push({
                    type: 'close_position',
                    asset: bot.pair,
                    reason: currentPrice <= position.stopLoss ? 'stop_loss' : 'take_profit'
                });
            }
        }
        
        return actions;
    }
    
    /**
     * Arbitrage Strategy
     */
    async executeArbitrageStrategy(context) {
        const { bot } = context;
        const { minProfit, maxSlippage, pairs } = bot.parameters;
        
        const actions = [];
        
        // Find arbitrage opportunities
        const opportunities = await this.findArbitrageOpportunities(pairs, minProfit);
        
        for (const opp of opportunities) {
            if (opp.profit > minProfit && opp.slippage < maxSlippage) {
                // Execute arbitrage
                actions.push({
                    type: 'arbitrage',
                    path: opp.path,
                    amount: Math.min(opp.maxAmount, bot.capital * 0.5),
                    expectedProfit: opp.profit
                });
            }
        }
        
        return actions;
    }
    
    /**
     * ML-Based Strategy
     */
    async executeMLStrategy(context) {
        const { bot, predictions } = context;
        const { confidenceThreshold, positionSize, stopLoss } = bot.parameters;
        
        const actions = [];
        
        if (!predictions || !predictions.recommendation) {
            return actions;
        }
        
        const signal = predictions.recommendation;
        
        // Check confidence threshold
        if (signal.confidence >= confidenceThreshold) {
            if (signal.action === 'BUY' && !bot.positions.has(bot.pair)) {
                actions.push({
                    type: 'place_order',
                    order: {
                        side: 'buy',
                        type: 'market',
                        quantity: bot.capital * positionSize / predictions.current,
                        metadata: {
                            mlSignal: signal,
                            stopLoss: predictions.current * (1 - stopLoss)
                        }
                    }
                });
            } else if (signal.action === 'SELL' && bot.positions.has(bot.pair)) {
                actions.push({
                    type: 'close_position',
                    asset: bot.pair,
                    reason: 'ml_signal'
                });
            }
        }
        
        return actions;
    }
    
    /**
     * Market Maker Strategy
     */
    async executeMarketMakerStrategy(context) {
        const { bot, orderBook, marketData } = context;
        const { spread, orderSize, orderDepth, rebalanceThreshold } = bot.parameters;
        
        const actions = [];
        const midPrice = (orderBook.bids[0]?.price + orderBook.asks[0]?.price) / 2 || marketData.price;
        
        // Cancel existing orders if price moved significantly
        const shouldRebalance = bot.state.lastMidPrice && 
            Math.abs(midPrice - bot.state.lastMidPrice) / bot.state.lastMidPrice > rebalanceThreshold;
        
        if (shouldRebalance) {
            for (const [orderId, order] of bot.orders) {
                if (order.status === 'pending') {
                    actions.push({ type: 'cancel_order', orderId });
                }
            }
        }
        
        // Place new orders
        for (let i = 1; i <= orderDepth; i++) {
            const buyPrice = midPrice * (1 - spread * i);
            const sellPrice = midPrice * (1 + spread * i);
            
            actions.push({
                type: 'place_order',
                order: {
                    side: 'buy',
                    type: 'limit',
                    price: buyPrice,
                    quantity: orderSize * (1 + i * 0.2), // Increase size with depth
                    metadata: { maker: true, level: i }
                }
            });
            
            actions.push({
                type: 'place_order',
                order: {
                    side: 'sell',
                    type: 'limit',
                    price: sellPrice,
                    quantity: orderSize * (1 + i * 0.2),
                    metadata: { maker: true, level: i }
                }
            });
        }
        
        bot.state.lastMidPrice = midPrice;
        
        return actions;
    }
    
    /**
     * Process strategy actions
     */
    async processActions(bot, actions) {
        for (const action of actions) {
            try {
                switch (action.type) {
                    case 'place_order':
                        await this.placeOrder(bot, action.order);
                        break;
                        
                    case 'cancel_order':
                        await this.cancelOrder(bot, action.orderId);
                        break;
                        
                    case 'close_position':
                        await this.closePosition(bot, action.asset);
                        break;
                        
                    case 'arbitrage':
                        await this.executeArbitrage(bot, action);
                        break;
                        
                    default:
                        logger.warn(`Unknown action type: ${action.type}`);
                }
            } catch (error) {
                logger.error(`Action execution error:`, error);
            }
        }
    }
    
    /**
     * Helper methods
     */
    
    validateParameters(paramDefs, values) {
        const validated = {};
        
        for (const [key, def] of Object.entries(paramDefs)) {
            const value = values[key] !== undefined ? values[key] : def.default;
            
            // Type validation
            if (def.type === 'number') {
                const num = Number(value);
                if (isNaN(num)) throw new Error(`Invalid number for ${key}`);
                if (def.min !== undefined && num < def.min) throw new Error(`${key} below minimum`);
                if (def.max !== undefined && num > def.max) throw new Error(`${key} above maximum`);
                validated[key] = num;
            } else if (def.type === 'string') {
                if (def.options && !def.options.includes(value)) {
                    throw new Error(`Invalid option for ${key}`);
                }
                validated[key] = value;
            } else if (def.type === 'array') {
                validated[key] = Array.isArray(value) ? value : def.default;
            }
        }
        
        return validated;
    }
    
    checkRiskLimits(bot) {
        const drawdown = this.calculateDrawdown(bot);
        return drawdown <= this.config.riskManagement.maxDrawdown;
    }
    
    calculateDrawdown(bot) {
        const currentValue = bot.capital + bot.performance.profit;
        const peak = bot.state.peakValue || bot.capital;
        return (peak - currentValue) / peak;
    }
    
    calculateMomentum(candles, lookback) {
        if (candles.length < lookback) return 0;
        
        const recent = candles.slice(-lookback);
        const oldPrice = recent[0].close;
        const newPrice = recent[recent.length - 1].close;
        
        return (newPrice - oldPrice) / oldPrice;
    }
    
    hasOrderAtPrice(bot, price) {
        for (const order of bot.orders.values()) {
            if (order.status === 'pending' && Math.abs(order.price - price) < 0.0001) {
                return true;
            }
        }
        return false;
    }
    
    isCriticalError(error) {
        return error.message.includes('Insufficient balance') ||
               error.message.includes('API error') ||
               error.message.includes('Connection lost');
    }
    
    async getMarketData(pair) {
        if (!this.dexEngine) return { price: 0, candles: [] };
        
        return {
            price: this.dexEngine.getMarketPrice(pair),
            candles: this.dexEngine.getCandles(pair, '1m', 100),
            volume24h: this.dexEngine.get24hVolume(pair)
        };
    }
    
    async getOrderBook(pair) {
        if (!this.dexEngine) return { bids: [], asks: [] };
        return this.dexEngine.getOrderBook(pair);
    }
    
    async checkBalance(userId, pair) {
        // This would check actual user balance
        return 10000; // Mock balance
    }
    
    async getBalance(userId, pair) {
        const [base, quote] = pair.split('/');
        return {
            base: 1.0,
            quote: 10000
        };
    }
    
    async placeOrder(bot, orderData) {
        if (bot.orders.size >= this.config.maxOrdersPerBot) {
            throw new Error('Maximum orders reached');
        }
        
        const order = {
            id: uuidv4(),
            botId: bot.id,
            ...orderData,
            status: 'pending',
            createdAt: Date.now()
        };
        
        bot.orders.set(order.id, order);
        
        // Send to DEX
        if (this.dexEngine) {
            await this.dexEngine.placeOrder({
                userId: bot.userId,
                pair: bot.pair,
                ...orderData
            });
        }
        
        this.emit('bot:order:placed', { bot, order });
    }
    
    async cancelOrder(bot, orderId) {
        const order = bot.orders.get(orderId);
        if (!order) return;
        
        order.status = 'cancelled';
        
        if (this.dexEngine) {
            await this.dexEngine.cancelOrder(orderId);
        }
        
        this.emit('bot:order:cancelled', { bot, order });
    }
    
    async closePosition(bot, asset) {
        const position = bot.positions.get(asset);
        if (!position) return;
        
        await this.placeOrder(bot, {
            side: position.side === 'buy' ? 'sell' : 'buy',
            type: 'market',
            quantity: position.quantity,
            metadata: { closePosition: true }
        });
        
        bot.positions.delete(asset);
    }
    
    updatePerformance(bot) {
        // Update performance metrics
        const pnl = this.calculatePnL(bot);
        bot.performance.profit = pnl;
        
        // Update peak value for drawdown calculation
        const currentValue = bot.capital + pnl;
        if (!bot.state.peakValue || currentValue > bot.state.peakValue) {
            bot.state.peakValue = currentValue;
        }
    }
    
    calculatePnL(bot) {
        let totalPnL = 0;
        
        // Calculate realized P&L from closed trades
        for (const order of bot.orders.values()) {
            if (order.status === 'filled' && order.pnl) {
                totalPnL += order.pnl;
            }
        }
        
        // Calculate unrealized P&L from open positions
        // This would use current market prices
        
        return totalPnL;
    }
    
    /**
     * Get bot performance metrics
     */
    getBotPerformance(botId) {
        const bot = this.bots.get(botId);
        if (!bot) return null;
        
        const runtime = bot.startedAt ? Date.now() - bot.startedAt : 0;
        const winRate = bot.performance.trades > 0 
            ? bot.performance.wins / bot.performance.trades 
            : 0;
        
        return {
            ...bot.performance,
            runtime,
            winRate,
            averageProfit: bot.performance.trades > 0 
                ? bot.performance.profit / bot.performance.trades 
                : 0
        };
    }
    
    /**
     * Get all bots for a user
     */
    getUserBots(userId) {
        return Array.from(this.bots.values())
            .filter(bot => bot.userId === userId)
            .map(bot => ({
                id: bot.id,
                name: bot.name,
                strategy: bot.strategy,
                pair: bot.pair,
                status: bot.status,
                performance: this.getBotPerformance(bot.id),
                createdAt: bot.createdAt
            }));
    }
    
    /**
     * Delete a bot
     */
    async deleteBot(botId, userId) {
        const bot = this.bots.get(botId);
        if (!bot) {
            throw new Error('Bot not found');
        }
        
        if (bot.userId !== userId) {
            throw new Error('Unauthorized');
        }
        
        // Stop bot if active
        if (bot.status === 'active') {
            await this.stopBot(botId, userId);
        }
        
        this.bots.delete(botId);
        
        logger.info(`Deleted bot ${botId}`);
        
        this.emit('bot:deleted', { botId });
    }
}

export default TradingBotEngine;