/**
 * Collateral Manager for Otedama Lending
 * Manages collateral requirements and liquidations
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

export class CollateralManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            liquidationThreshold: config.liquidationThreshold || 1.2, // 120%
            liquidationPenalty: config.liquidationPenalty || 0.1, // 10%
            minHealthFactor: config.minHealthFactor || 1.0,
            priceStalePeriod: config.priceStalePeriod || 5 * 60 * 1000, // 5 minutes
            ...config
        };
        
        this.logger = getLogger('CollateralManager');
        
        // Collateral configurations per asset
        this.collateralConfigs = new Map();
        
        // Liquidation queue
        this.liquidationQueue = [];
        
        // Price oracle
        this.priceOracle = config.priceOracle || null;
        
        // Price cache
        this.priceCache = new Map();
        
        this.isRunning = false;
    }
    
    /**
     * Start collateral manager
     */
    async start() {
        if (this.isRunning) return;
        
        this.logger.info('Starting collateral manager...');
        
        // Initialize default collateral configs
        this.initializeDefaultConfigs();
        
        // Start price monitoring
        this.startPriceMonitoring();
        
        // Start liquidation processing
        this.startLiquidationProcessing();
        
        this.isRunning = true;
        this.logger.info('Collateral manager started');
    }
    
    /**
     * Initialize default collateral configurations
     */
    initializeDefaultConfigs() {
        // Stablecoins - High LTV, low volatility
        this.setCollateralConfig('USDT', {
            enabled: true,
            maxLTV: 0.85, // 85%
            liquidationThreshold: 0.9, // 90%
            liquidationPenalty: 0.05, // 5%
            volatilityFactor: 0.01
        });
        
        this.setCollateralConfig('USDC', {
            enabled: true,
            maxLTV: 0.85,
            liquidationThreshold: 0.9,
            liquidationPenalty: 0.05,
            volatilityFactor: 0.01
        });
        
        // Major cryptocurrencies - Medium LTV
        this.setCollateralConfig('BTC', {
            enabled: true,
            maxLTV: 0.7, // 70%
            liquidationThreshold: 0.75, // 75%
            liquidationPenalty: 0.1, // 10%
            volatilityFactor: 0.3
        });
        
        this.setCollateralConfig('ETH', {
            enabled: true,
            maxLTV: 0.7,
            liquidationThreshold: 0.75,
            liquidationPenalty: 0.1,
            volatilityFactor: 0.35
        });
        
        // Volatile assets - Lower LTV
        this.setCollateralConfig('SOL', {
            enabled: true,
            maxLTV: 0.5, // 50%
            liquidationThreshold: 0.6, // 60%
            liquidationPenalty: 0.15, // 15%
            volatilityFactor: 0.5
        });
    }
    
    /**
     * Set collateral configuration for asset
     */
    setCollateralConfig(asset, config) {
        this.collateralConfigs.set(asset, {
            asset,
            enabled: config.enabled !== false,
            maxLTV: config.maxLTV || 0.5,
            liquidationThreshold: config.liquidationThreshold || 0.6,
            liquidationPenalty: config.liquidationPenalty || 0.1,
            volatilityFactor: config.volatilityFactor || 0.3,
            priceFeed: config.priceFeed || null,
            ...config
        });
        
        this.emit('collateral-config-updated', { asset, config });
    }
    
    /**
     * Get collateral configuration
     */
    getCollateralConfig(asset) {
        return this.collateralConfigs.get(asset) || {
            enabled: false,
            maxLTV: 0,
            liquidationThreshold: 0,
            liquidationPenalty: 0,
            volatilityFactor: 1
        };
    }
    
    /**
     * Calculate health factor for a position
     */
    async calculateHealthFactor(position) {
        const {
            collaterals, // Array of { asset, amount }
            borrows // Array of { asset, amount }
        } = position;
        
        let totalCollateralValue = 0;
        let totalBorrowValue = 0;
        
        // Calculate weighted collateral value
        for (const collateral of collaterals) {
            const config = this.getCollateralConfig(collateral.asset);
            if (!config.enabled) continue;
            
            const price = await this.getAssetPrice(collateral.asset);
            const value = collateral.amount * price;
            
            // Apply liquidation threshold
            totalCollateralValue += value * config.liquidationThreshold;
        }
        
        // Calculate total borrow value
        for (const borrow of borrows) {
            const price = await this.getAssetPrice(borrow.asset);
            totalBorrowValue += borrow.amount * price;
        }
        
        if (totalBorrowValue === 0) {
            return Infinity; // No borrows
        }
        
        return totalCollateralValue / totalBorrowValue;
    }
    
    /**
     * Calculate maximum borrowable amount
     */
    async calculateBorrowingPower(collaterals) {
        let totalBorrowingPower = 0;
        
        for (const collateral of collaterals) {
            const config = this.getCollateralConfig(collateral.asset);
            if (!config.enabled) continue;
            
            const price = await this.getAssetPrice(collateral.asset);
            const value = collateral.amount * price;
            
            // Apply max LTV
            totalBorrowingPower += value * config.maxLTV;
        }
        
        return totalBorrowingPower;
    }
    
    /**
     * Check if position is liquidatable
     */
    async isLiquidatable(position) {
        const healthFactor = await this.calculateHealthFactor(position);
        return healthFactor < this.config.minHealthFactor;
    }
    
    /**
     * Calculate liquidation amounts
     */
    async calculateLiquidation(position) {
        const {
            collaterals,
            borrows,
            userId
        } = position;
        
        // Calculate current values
        let totalCollateralValue = 0;
        let totalBorrowValue = 0;
        const collateralValues = [];
        
        for (const collateral of collaterals) {
            const price = await this.getAssetPrice(collateral.asset);
            const value = collateral.amount * price;
            totalCollateralValue += value;
            collateralValues.push({ ...collateral, value, price });
        }
        
        for (const borrow of borrows) {
            const price = await this.getAssetPrice(borrow.asset);
            totalBorrowValue += borrow.amount * price;
        }
        
        // Sort collaterals by liquidity/preference
        collateralValues.sort((a, b) => {
            const configA = this.getCollateralConfig(a.asset);
            const configB = this.getCollateralConfig(b.asset);
            return configA.volatilityFactor - configB.volatilityFactor;
        });
        
        // Calculate liquidation details
        const liquidationDetails = {
            userId,
            totalCollateralValue,
            totalBorrowValue,
            healthFactor: await this.calculateHealthFactor(position),
            liquidations: []
        };
        
        // Determine which assets to liquidate
        let remainingDebtValue = totalBorrowValue;
        
        for (const collateral of collateralValues) {
            if (remainingDebtValue <= 0) break;
            
            const config = this.getCollateralConfig(collateral.asset);
            const liquidationValue = Math.min(collateral.value, remainingDebtValue * 1.1);
            const liquidationAmount = liquidationValue / collateral.price;
            
            // Apply liquidation penalty
            const collateralToLiquidator = liquidationAmount * (1 - config.liquidationPenalty);
            const penaltyAmount = liquidationAmount * config.liquidationPenalty;
            
            liquidationDetails.liquidations.push({
                asset: collateral.asset,
                amount: liquidationAmount,
                value: liquidationValue,
                collateralToLiquidator,
                penaltyAmount,
                price: collateral.price
            });
            
            remainingDebtValue -= liquidationValue;
        }
        
        return liquidationDetails;
    }
    
    /**
     * Process liquidation
     */
    async processLiquidation(position, liquidatorId) {
        if (!await this.isLiquidatable(position)) {
            throw new Error('Position is not liquidatable');
        }
        
        const liquidationDetails = await this.calculateLiquidation(position);
        
        this.emit('liquidation-started', {
            userId: position.userId,
            liquidatorId,
            details: liquidationDetails
        });
        
        // Execute liquidation transfers
        const results = [];
        
        for (const liquidation of liquidationDetails.liquidations) {
            try {
                // Transfer debt from liquidator
                // Transfer collateral to liquidator
                // Transfer penalty to protocol
                
                results.push({
                    asset: liquidation.asset,
                    amount: liquidation.amount,
                    success: true
                });
            } catch (error) {
                this.logger.error(`Liquidation failed for ${liquidation.asset}: ${error.message}`);
                results.push({
                    asset: liquidation.asset,
                    amount: liquidation.amount,
                    success: false,
                    error: error.message
                });
            }
        }
        
        this.emit('liquidation-completed', {
            userId: position.userId,
            liquidatorId,
            results
        });
        
        return results;
    }
    
    /**
     * Add position to liquidation queue
     */
    queueLiquidation(position) {
        this.liquidationQueue.push({
            position,
            timestamp: Date.now(),
            attempts: 0
        });
        
        this.emit('liquidation-queued', {
            userId: position.userId,
            queueLength: this.liquidationQueue.length
        });
    }
    
    /**
     * Process liquidation queue
     */
    async processLiquidationQueue() {
        while (this.liquidationQueue.length > 0) {
            const item = this.liquidationQueue.shift();
            
            try {
                // Find liquidator (could be automated or incentivized)
                const liquidatorId = await this.findLiquidator(item.position);
                
                if (liquidatorId) {
                    await this.processLiquidation(item.position, liquidatorId);
                } else {
                    // Re-queue if no liquidator found
                    item.attempts++;
                    if (item.attempts < 3) {
                        this.liquidationQueue.push(item);
                    }
                }
            } catch (error) {
                this.logger.error(`Queue processing error: ${error.message}`);
            }
        }
    }
    
    /**
     * Find available liquidator
     */
    async findLiquidator(position) {
        // This would implement liquidator selection logic
        // Could be based on:
        // - Available balance
        // - Liquidation history
        // - Incentive mechanisms
        
        // For now, return mock liquidator
        return 'LIQUIDATOR_BOT';
    }
    
    /**
     * Get asset price with caching
     */
    async getAssetPrice(asset) {
        const cached = this.priceCache.get(asset);
        const now = Date.now();
        
        if (cached && (now - cached.timestamp) < this.config.priceStalePeriod) {
            return cached.price;
        }
        
        let price;
        
        if (this.priceOracle) {
            price = await this.priceOracle.getPrice(asset);
        } else {
            // Mock prices
            const prices = {
                'BTC': 40000,
                'ETH': 2500,
                'USDT': 1,
                'USDC': 1,
                'SOL': 100
            };
            price = prices[asset] || 0;
        }
        
        this.priceCache.set(asset, {
            price,
            timestamp: now
        });
        
        return price;
    }
    
    /**
     * Monitor price changes for liquidations
     */
    startPriceMonitoring() {
        setInterval(async () => {
            // Clear price cache to force updates
            this.priceCache.clear();
            
            // Emit price update event
            this.emit('prices-updated');
        }, 30000); // Every 30 seconds
    }
    
    /**
     * Start liquidation queue processing
     */
    startLiquidationProcessing() {
        setInterval(() => {
            this.processLiquidationQueue();
        }, 5000); // Every 5 seconds
    }
    
    /**
     * Calculate risk parameters for asset
     */
    calculateRiskParameters(asset, historicalData) {
        // Calculate volatility
        const returns = [];
        for (let i = 1; i < historicalData.length; i++) {
            const return_i = (historicalData[i] - historicalData[i-1]) / historicalData[i-1];
            returns.push(return_i);
        }
        
        const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
        const volatility = Math.sqrt(variance);
        
        // Suggest risk parameters based on volatility
        const maxLTV = Math.max(0.3, Math.min(0.85, 0.9 - volatility * 2));
        const liquidationThreshold = maxLTV + 0.05;
        const liquidationPenalty = Math.max(0.05, Math.min(0.2, volatility));
        
        return {
            volatility,
            suggestedMaxLTV: maxLTV,
            suggestedLiquidationThreshold: liquidationThreshold,
            suggestedLiquidationPenalty: liquidationPenalty
        };
    }
    
    /**
     * Get collateral statistics
     */
    getCollateralStats() {
        const stats = {
            totalCollateralConfigs: this.collateralConfigs.size,
            enabledCollaterals: 0,
            liquidationQueueLength: this.liquidationQueue.length,
            collaterals: []
        };
        
        for (const [asset, config] of this.collateralConfigs) {
            if (config.enabled) {
                stats.enabledCollaterals++;
            }
            
            stats.collaterals.push({
                asset,
                enabled: config.enabled,
                maxLTV: config.maxLTV,
                liquidationThreshold: config.liquidationThreshold,
                liquidationPenalty: config.liquidationPenalty
            });
        }
        
        return stats;
    }
    
    /**
     * Stop collateral manager
     */
    async stop() {
        if (!this.isRunning) return;
        
        this.logger.info('Stopping collateral manager...');
        
        // Clear intervals
        // (Would need to store interval IDs)
        
        this.isRunning = false;
        this.logger.info('Collateral manager stopped');
    }
}

export default CollateralManager;