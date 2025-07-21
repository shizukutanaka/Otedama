/**
 * Derivatives Trading Module for Otedama
 * Unified interface for futures and options trading
 */

import { EventEmitter } from 'events';
import { FuturesEngine } from './futures-engine.js';
import { OptionsEngine } from './options-engine.js';
import { getLogger } from '../core/logger.js';

export class DerivativesManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            enableFutures: config.enableFutures !== false,
            enableOptions: config.enableOptions !== false,
            ...config
        };
        
        this.logger = getLogger('DerivativesManager');
        
        // Initialize engines
        this.futuresEngine = null;
        this.optionsEngine = null;
        
        // Portfolio tracking
        this.portfolios = new Map(); // userId -> portfolio
        
        // Risk metrics
        this.riskMetrics = new Map(); // userId -> metrics
        
        this.isRunning = false;
    }
    
    /**
     * Start derivatives manager
     */
    async start() {
        if (this.isRunning) return;
        
        this.logger.info('Starting derivatives manager...');
        
        // Start futures engine
        if (this.config.enableFutures) {
            this.futuresEngine = new FuturesEngine(this.config.futures);
            await this.futuresEngine.start();
            this.setupFuturesListeners();
        }
        
        // Start options engine
        if (this.config.enableOptions) {
            this.optionsEngine = new OptionsEngine(this.config.options);
            await this.optionsEngine.start();
            this.setupOptionsListeners();
        }
        
        // Start portfolio monitoring
        this.startPortfolioMonitoring();
        
        // Start risk monitoring
        this.startRiskMonitoring();
        
        this.isRunning = true;
        this.logger.info('Derivatives manager started');
    }
    
    /**
     * Setup event listeners
     */
    setupFuturesListeners() {
        this.futuresEngine.on('position-updated', (data) => {
            this.updatePortfolio(data.userId);
            this.emit('futures-position-updated', data);
        });
        
        this.futuresEngine.on('position-liquidated', (data) => {
            this.updatePortfolio(data.userId);
            this.emit('futures-position-liquidated', data);
        });
        
        this.futuresEngine.on('contract-created', (contract) => {
            this.emit('futures-contract-created', contract);
        });
    }
    
    setupOptionsListeners() {
        this.optionsEngine.on('position-updated', (data) => {
            this.updatePortfolio(data.userId);
            this.emit('options-position-updated', data);
        });
        
        this.optionsEngine.on('option-exercised', (data) => {
            this.updatePortfolio(data.userId);
            this.emit('option-exercised', data);
        });
        
        this.optionsEngine.on('option-created', (option) => {
            this.emit('option-created', option);
        });
    }
    
    /**
     * Create derivatives products
     */
    async createFuturesContract(params) {
        if (!this.futuresEngine) {
            throw new Error('Futures engine not enabled');
        }
        
        return this.futuresEngine.createContract(params);
    }
    
    async createOptionSeries(params) {
        if (!this.optionsEngine) {
            throw new Error('Options engine not enabled');
        }
        
        return this.optionsEngine.createOptionSeries(params);
    }
    
    /**
     * Trading functions
     */
    async openFuturesPosition(params) {
        if (!this.futuresEngine) {
            throw new Error('Futures engine not enabled');
        }
        
        const result = await this.futuresEngine.openPosition(params);
        
        // Update risk metrics
        this.calculateRiskMetrics(params.userId);
        
        return result;
    }
    
    async closeFuturesPosition(userId, contractId, orderType, price) {
        if (!this.futuresEngine) {
            throw new Error('Futures engine not enabled');
        }
        
        return this.futuresEngine.closePosition(userId, contractId, orderType, price);
    }
    
    async buyOption(params) {
        if (!this.optionsEngine) {
            throw new Error('Options engine not enabled');
        }
        
        const result = await this.optionsEngine.buyOption(params);
        
        // Update risk metrics
        this.calculateRiskMetrics(params.userId);
        
        return result;
    }
    
    async sellOption(params) {
        if (!this.optionsEngine) {
            throw new Error('Options engine not enabled');
        }
        
        return this.optionsEngine.sellOption(params);
    }
    
    async exerciseOption(userId, optionId, quantity) {
        if (!this.optionsEngine) {
            throw new Error('Options engine not enabled');
        }
        
        return this.optionsEngine.exerciseOption(userId, optionId, quantity);
    }
    
    /**
     * Get user portfolio
     */
    getUserPortfolio(userId) {
        const portfolio = {
            futures: [],
            options: [],
            totalValue: 0,
            totalMargin: 0,
            totalPnL: 0,
            risk: {
                var: 0, // Value at Risk
                marginUsage: 0,
                leverage: 0
            }
        };
        
        // Get futures positions
        if (this.futuresEngine) {
            const futuresPositions = this.futuresEngine.getUserPositions(userId);
            portfolio.futures = futuresPositions;
            
            // Calculate futures metrics
            for (const position of futuresPositions) {
                portfolio.totalMargin += position.margin;
                portfolio.totalPnL += position.realizedPnL + position.unrealizedPnL;
            }
        }
        
        // Get options positions
        if (this.optionsEngine) {
            const optionsPositions = this.optionsEngine.getUserPositions(userId);
            portfolio.options = optionsPositions;
            
            // Calculate options metrics
            for (const position of optionsPositions) {
                const option = position.option;
                const marketValue = position.quantity * option.lastPrice * 
                                  this.optionsEngine.getMultiplier(option.underlying);
                portfolio.totalValue += marketValue;
                portfolio.totalPnL += position.realizedPnL + position.unrealizedPnL;
            }
        }
        
        // Get risk metrics
        const riskMetrics = this.riskMetrics.get(userId);
        if (riskMetrics) {
            portfolio.risk = riskMetrics;
        }
        
        return portfolio;
    }
    
    /**
     * Calculate risk metrics
     */
    calculateRiskMetrics(userId) {
        const portfolio = this.getUserPortfolio(userId);
        
        const metrics = {
            var: 0, // Value at Risk
            marginUsage: 0,
            leverage: 0,
            delta: 0,
            gamma: 0,
            theta: 0,
            vega: 0,
            correlations: {}
        };
        
        // Calculate futures risk
        for (const position of portfolio.futures) {
            const contract = this.futuresEngine.getContract(position.contractId);
            if (contract) {
                const notionalValue = Math.abs(position.size) * contract.markPrice;
                metrics.leverage += notionalValue / position.margin;
                
                // Simple VaR calculation (would be more sophisticated in production)
                const volatility = 0.02; // 2% daily volatility
                metrics.var += notionalValue * volatility * 2.33; // 99% confidence
            }
        }
        
        // Calculate options Greeks
        for (const position of portfolio.options) {
            const option = position.option;
            const multiplier = this.optionsEngine.getMultiplier(option.underlying);
            
            metrics.delta += position.quantity * option.greeks.delta * multiplier;
            metrics.gamma += position.quantity * option.greeks.gamma * multiplier;
            metrics.theta += position.quantity * option.greeks.theta * multiplier;
            metrics.vega += position.quantity * option.greeks.vega * multiplier;
        }
        
        // Calculate margin usage
        const totalMargin = portfolio.totalMargin;
        const availableBalance = 100000; // Would get from wallet
        metrics.marginUsage = totalMargin / availableBalance;
        
        // Average leverage
        if (portfolio.futures.length > 0) {
            metrics.leverage /= portfolio.futures.length;
        }
        
        this.riskMetrics.set(userId, metrics);
        
        this.emit('risk-metrics-updated', {
            userId,
            metrics
        });
        
        return metrics;
    }
    
    /**
     * Risk management
     */
    async checkRiskLimits(userId) {
        const metrics = this.riskMetrics.get(userId);
        if (!metrics) return true;
        
        const limits = {
            maxLeverage: 20,
            maxMarginUsage: 0.8, // 80%
            maxVaR: 50000, // $50k
            maxDelta: 1000,
            maxGamma: 100
        };
        
        const violations = [];
        
        if (metrics.leverage > limits.maxLeverage) {
            violations.push(`Leverage ${metrics.leverage.toFixed(1)}x exceeds limit ${limits.maxLeverage}x`);
        }
        
        if (metrics.marginUsage > limits.maxMarginUsage) {
            violations.push(`Margin usage ${(metrics.marginUsage * 100).toFixed(1)}% exceeds limit ${limits.maxMarginUsage * 100}%`);
        }
        
        if (metrics.var > limits.maxVaR) {
            violations.push(`VaR $${metrics.var.toFixed(0)} exceeds limit $${limits.maxVaR}`);
        }
        
        if (Math.abs(metrics.delta) > limits.maxDelta) {
            violations.push(`Delta ${metrics.delta.toFixed(1)} exceeds limit ${limits.maxDelta}`);
        }
        
        if (Math.abs(metrics.gamma) > limits.maxGamma) {
            violations.push(`Gamma ${metrics.gamma.toFixed(1)} exceeds limit ${limits.maxGamma}`);
        }
        
        if (violations.length > 0) {
            this.emit('risk-limit-exceeded', {
                userId,
                violations,
                metrics
            });
            
            return false;
        }
        
        return true;
    }
    
    /**
     * Market data
     */
    getFuturesContracts() {
        if (!this.futuresEngine) return [];
        return this.futuresEngine.getActiveContracts();
    }
    
    getOptionChain(underlying, expiry) {
        if (!this.optionsEngine) return [];
        return this.optionsEngine.getOptionChain(underlying, expiry);
    }
    
    getImpliedVolatilitySurface(underlying) {
        if (!this.optionsEngine) return [];
        return this.optionsEngine.getIVSurface(underlying);
    }
    
    /**
     * Portfolio monitoring
     */
    updatePortfolio(userId) {
        const portfolio = this.getUserPortfolio(userId);
        this.portfolios.set(userId, portfolio);
        
        // Check risk limits
        this.checkRiskLimits(userId);
        
        this.emit('portfolio-updated', {
            userId,
            portfolio
        });
    }
    
    startPortfolioMonitoring() {
        setInterval(() => {
            // Update all portfolios
            for (const userId of this.portfolios.keys()) {
                this.updatePortfolio(userId);
            }
        }, 5000); // Every 5 seconds
    }
    
    startRiskMonitoring() {
        setInterval(() => {
            // Recalculate risk metrics
            for (const userId of this.riskMetrics.keys()) {
                this.calculateRiskMetrics(userId);
            }
        }, 10000); // Every 10 seconds
    }
    
    /**
     * Get summary statistics
     */
    getStats() {
        const stats = {
            futures: {
                contracts: 0,
                openInterest: 0,
                volume24h: 0
            },
            options: {
                contracts: 0,
                openInterest: 0,
                volume24h: 0
            },
            users: {
                total: this.portfolios.size,
                withPositions: 0
            }
        };
        
        // Futures stats
        if (this.futuresEngine) {
            const contracts = this.futuresEngine.getAllContracts();
            stats.futures.contracts = contracts.length;
            
            for (const contract of contracts) {
                stats.futures.openInterest += contract.openInterest;
                stats.futures.volume24h += contract.volume24h;
            }
        }
        
        // Options stats
        if (this.optionsEngine) {
            stats.options.contracts = this.optionsEngine.options.size;
            
            for (const option of this.optionsEngine.options.values()) {
                stats.options.openInterest += option.openInterest;
                stats.options.volume24h += option.volume;
            }
        }
        
        // User stats
        for (const portfolio of this.portfolios.values()) {
            if (portfolio.futures.length > 0 || portfolio.options.length > 0) {
                stats.users.withPositions++;
            }
        }
        
        return stats;
    }
    
    /**
     * Stop derivatives manager
     */
    async stop() {
        if (!this.isRunning) return;
        
        this.logger.info('Stopping derivatives manager...');
        
        if (this.futuresEngine) {
            await this.futuresEngine.stop();
        }
        
        if (this.optionsEngine) {
            await this.optionsEngine.stop();
        }
        
        this.isRunning = false;
        this.logger.info('Derivatives manager stopped');
    }
}

// Export individual engines as well
export { FuturesEngine } from './futures-engine.js';
export { OptionsEngine } from './options-engine.js';

export default DerivativesManager;