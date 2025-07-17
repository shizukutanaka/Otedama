/**
 * Dynamic Fee Adjustment System
 * Automatically adjusts fees based on market volatility and volume
 */

import { EventEmitter } from 'events';

export class DynamicFeeManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            baseFee: config.baseFee || 30, // 0.3% in basis points
            minFee: config.minFee || 5, // 0.05%
            maxFee: config.maxFee || 100, // 1%
            volatilityWindow: config.volatilityWindow || 3600000, // 1 hour
            volumeWindow: config.volumeWindow || 86400000, // 24 hours
            updateInterval: config.updateInterval || 60000, // 1 minute
            volatilityWeight: config.volatilityWeight || 0.4,
            volumeWeight: config.volumeWeight || 0.3,
            utilizationWeight: config.utilizationWeight || 0.3,
            smoothingFactor: config.smoothingFactor || 0.1,
            ...config
        };
        
        // State
        this.currentFee = this.config.baseFee;
        this.priceHistory = [];
        this.volumeHistory = [];
        this.lastUpdate = Date.now();
        
        // Metrics
        this.metrics = {
            volatility: 0,
            volume24h: 0,
            utilization: 0,
            feeAdjustments: 0,
            avgFee: this.config.baseFee
        };
        
        // Start update loop
        this.updateTimer = null;
        this.startUpdateLoop();
    }

    /**
     * Start automatic fee update loop
     */
    startUpdateLoop() {
        this.updateTimer = setInterval(() => {
            this.updateFee();
        }, this.config.updateInterval);
    }

    /**
     * Stop update loop
     */
    stopUpdateLoop() {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
        }
    }

    /**
     * Record a trade for fee calculation
     */
    recordTrade(price, volume, timestamp = Date.now()) {
        // Add to price history
        this.priceHistory.push({ price, timestamp });
        
        // Add to volume history
        this.volumeHistory.push({ volume, timestamp });
        
        // Clean old data
        this.cleanOldData();
        
        // Immediate update if significant price change
        if (this.shouldImmediateUpdate(price)) {
            this.updateFee();
        }
    }

    /**
     * Update pool utilization
     */
    updateUtilization(utilization) {
        this.metrics.utilization = utilization;
    }

    /**
     * Calculate and update dynamic fee
     */
    updateFee() {
        const now = Date.now();
        
        // Calculate volatility
        const volatility = this.calculateVolatility();
        this.metrics.volatility = volatility;
        
        // Calculate 24h volume
        const volume24h = this.calculate24hVolume();
        this.metrics.volume24h = volume24h;
        
        // Calculate fee components
        const volatilityComponent = this.calculateVolatilityFee(volatility);
        const volumeComponent = this.calculateVolumeFee(volume24h);
        const utilizationComponent = this.calculateUtilizationFee(this.metrics.utilization);
        
        // Weighted average of components
        const targetFee = Math.round(
            volatilityComponent * this.config.volatilityWeight +
            volumeComponent * this.config.volumeWeight +
            utilizationComponent * this.config.utilizationWeight
        );
        
        // Apply smoothing
        const smoothedFee = Math.round(
            this.currentFee * (1 - this.config.smoothingFactor) +
            targetFee * this.config.smoothingFactor
        );
        
        // Enforce bounds
        const newFee = Math.max(
            this.config.minFee,
            Math.min(this.config.maxFee, smoothedFee)
        );
        
        // Update if changed
        if (newFee !== this.currentFee) {
            const oldFee = this.currentFee;
            this.currentFee = newFee;
            this.metrics.feeAdjustments++;
            
            // Update average fee
            this.metrics.avgFee = 
                (this.metrics.avgFee * (this.metrics.feeAdjustments - 1) + newFee) / 
                this.metrics.feeAdjustments;
            
            this.emit('feeUpdated', {
                oldFee,
                newFee,
                volatility,
                volume24h,
                utilization: this.metrics.utilization,
                components: {
                    volatility: volatilityComponent,
                    volume: volumeComponent,
                    utilization: utilizationComponent
                }
            });
        }
        
        this.lastUpdate = now;
    }

    /**
     * Calculate price volatility
     */
    calculateVolatility() {
        if (this.priceHistory.length < 2) return 0;
        
        const now = Date.now();
        const windowStart = now - this.config.volatilityWindow;
        
        // Filter recent prices
        const recentPrices = this.priceHistory
            .filter(p => p.timestamp >= windowStart)
            .map(p => p.price);
        
        if (recentPrices.length < 2) return 0;
        
        // Calculate returns
        const returns = [];
        for (let i = 1; i < recentPrices.length; i++) {
            const ret = Math.log(recentPrices[i] / recentPrices[i - 1]);
            returns.push(ret);
        }
        
        // Calculate standard deviation
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);
        
        // Annualize volatility
        const periodsPerYear = 365 * 24 * 60 * 60 * 1000 / this.config.volatilityWindow;
        const annualizedVol = stdDev * Math.sqrt(periodsPerYear);
        
        return annualizedVol;
    }

    /**
     * Calculate 24h volume
     */
    calculate24hVolume() {
        const now = Date.now();
        const windowStart = now - this.config.volumeWindow;
        
        return this.volumeHistory
            .filter(v => v.timestamp >= windowStart)
            .reduce((sum, v) => sum + v.volume, 0);
    }

    /**
     * Calculate fee based on volatility
     */
    calculateVolatilityFee(volatility) {
        // Higher volatility = higher fee
        // Map volatility to fee range
        
        if (volatility < 0.1) {
            // Low volatility
            return this.config.baseFee * 0.8;
        } else if (volatility < 0.3) {
            // Normal volatility
            return this.config.baseFee;
        } else if (volatility < 0.5) {
            // High volatility
            return this.config.baseFee * 1.5;
        } else {
            // Extreme volatility
            return this.config.baseFee * 2;
        }
    }

    /**
     * Calculate fee based on volume
     */
    calculateVolumeFee(volume24h) {
        // Higher volume = lower fee (more liquidity)
        // This encourages trading during high volume periods
        
        const volumeThresholds = [
            { threshold: 1000000, multiplier: 0.7 },   // > $1M
            { threshold: 500000, multiplier: 0.85 },   // > $500K
            { threshold: 100000, multiplier: 1.0 },    // > $100K
            { threshold: 50000, multiplier: 1.15 },    // > $50K
            { threshold: 0, multiplier: 1.3 }          // Low volume
        ];
        
        const tier = volumeThresholds.find(t => volume24h >= t.threshold);
        return this.config.baseFee * tier.multiplier;
    }

    /**
     * Calculate fee based on pool utilization
     */
    calculateUtilizationFee(utilization) {
        // Higher utilization = higher fee
        // This helps balance the pool
        
        if (utilization < 0.2) {
            // Low utilization
            return this.config.baseFee * 0.9;
        } else if (utilization < 0.8) {
            // Normal utilization
            return this.config.baseFee;
        } else if (utilization < 0.95) {
            // High utilization
            return this.config.baseFee * 1.2;
        } else {
            // Critical utilization
            return this.config.baseFee * 1.5;
        }
    }

    /**
     * Check if immediate update needed
     */
    shouldImmediateUpdate(newPrice) {
        if (this.priceHistory.length === 0) return false;
        
        const lastPrice = this.priceHistory[this.priceHistory.length - 1].price;
        const priceChange = Math.abs((newPrice - lastPrice) / lastPrice);
        
        // Update immediately if price change > 2%
        return priceChange > 0.02;
    }

    /**
     * Clean old data from history
     */
    cleanOldData() {
        const now = Date.now();
        const maxAge = Math.max(this.config.volatilityWindow, this.config.volumeWindow);
        const cutoff = now - maxAge;
        
        this.priceHistory = this.priceHistory.filter(p => p.timestamp >= cutoff);
        this.volumeHistory = this.volumeHistory.filter(v => v.timestamp >= cutoff);
    }

    /**
     * Get current fee tier
     */
    getCurrentFeeTier() {
        if (this.currentFee <= 10) return 'low';
        if (this.currentFee <= 30) return 'standard';
        if (this.currentFee <= 50) return 'medium';
        return 'high';
    }

    /**
     * Get fee statistics
     */
    getStats() {
        return {
            currentFee: this.currentFee,
            feeTier: this.getCurrentFeeTier(),
            baseFee: this.config.baseFee,
            minFee: this.config.minFee,
            maxFee: this.config.maxFee,
            metrics: this.metrics,
            lastUpdate: this.lastUpdate,
            priceDataPoints: this.priceHistory.length,
            volumeDataPoints: this.volumeHistory.length
        };
    }

    /**
     * Simulate fee for given conditions
     */
    simulateFee(volatility, volume24h, utilization) {
        const volatilityComponent = this.calculateVolatilityFee(volatility);
        const volumeComponent = this.calculateVolumeFee(volume24h);
        const utilizationComponent = this.calculateUtilizationFee(utilization);
        
        const fee = Math.round(
            volatilityComponent * this.config.volatilityWeight +
            volumeComponent * this.config.volumeWeight +
            utilizationComponent * this.config.utilizationWeight
        );
        
        return Math.max(
            this.config.minFee,
            Math.min(this.config.maxFee, fee)
        );
    }

    /**
     * Destroy manager
     */
    destroy() {
        this.stopUpdateLoop();
        this.removeAllListeners();
        this.priceHistory = [];
        this.volumeHistory = [];
    }
}

/**
 * Fee oracle for multiple pools
 */
export class FeeOracle extends EventEmitter {
    constructor() {
        super();
        this.managers = new Map();
        this.globalMetrics = {
            avgFee: 30,
            totalVolume: 0,
            avgVolatility: 0
        };
    }

    /**
     * Register a pool for fee management
     */
    registerPool(poolId, config = {}) {
        if (this.managers.has(poolId)) {
            throw new Error(`Pool ${poolId} already registered`);
        }
        
        const manager = new DynamicFeeManager(config);
        
        // Forward events
        manager.on('feeUpdated', (data) => {
            this.emit('poolFeeUpdated', { poolId, ...data });
            this.updateGlobalMetrics();
        });
        
        this.managers.set(poolId, manager);
        
        return manager;
    }

    /**
     * Unregister a pool
     */
    unregisterPool(poolId) {
        const manager = this.managers.get(poolId);
        if (manager) {
            manager.destroy();
            this.managers.delete(poolId);
            this.updateGlobalMetrics();
        }
    }

    /**
     * Get manager for pool
     */
    getPoolManager(poolId) {
        return this.managers.get(poolId);
    }

    /**
     * Update global metrics
     */
    updateGlobalMetrics() {
        if (this.managers.size === 0) return;
        
        let totalFee = 0;
        let totalVolume = 0;
        let totalVolatility = 0;
        
        for (const manager of this.managers.values()) {
            const stats = manager.getStats();
            totalFee += stats.currentFee;
            totalVolume += stats.metrics.volume24h;
            totalVolatility += stats.metrics.volatility;
        }
        
        this.globalMetrics = {
            avgFee: totalFee / this.managers.size,
            totalVolume,
            avgVolatility: totalVolatility / this.managers.size
        };
    }

    /**
     * Get suggested fee for new pool
     */
    getSuggestedFee(token0, token1) {
        // Use global average as starting point
        let suggestedFee = this.globalMetrics.avgFee;
        
        // Adjust based on token characteristics
        const stableTokens = ['USDC', 'USDT', 'DAI', 'BUSD'];
        const isStablePair = 
            stableTokens.includes(token0) && 
            stableTokens.includes(token1);
        
        if (isStablePair) {
            // Stable pairs have lower fees
            suggestedFee = Math.min(suggestedFee, 5);
        }
        
        // Major pairs get standard fees
        const majorTokens = ['BTC', 'ETH', 'BNB'];
        const isMajorPair = 
            majorTokens.includes(token0) || 
            majorTokens.includes(token1);
        
        if (isMajorPair && !isStablePair) {
            suggestedFee = 30; // Standard 0.3%
        }
        
        return suggestedFee;
    }

    /**
     * Get all pool fees
     */
    getAllFees() {
        const fees = {};
        
        for (const [poolId, manager] of this.managers) {
            fees[poolId] = manager.currentFee;
        }
        
        return fees;
    }
}

export default DynamicFeeManager;