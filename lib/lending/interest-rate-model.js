/**
 * Interest Rate Model for Otedama Lending
 * Dynamic rate calculation based on utilization
 */

export class InterestRateModel {
    constructor(config = {}) {
        this.config = {
            baseRate: config.baseRate || 0.02, // 2% base APR
            multiplier: config.multiplier || 0.15, // Rate increase per utilization
            jumpMultiplier: config.jumpMultiplier || 0.8, // Rate increase after kink
            kink: config.kink || 0.8, // 80% utilization kink point
            reserveFactor: config.reserveFactor || 0.1, // 10% to reserves
            ...config
        };
        
        // Model types
        this.modelType = config.modelType || 'jump'; // jump, linear, polynomial
    }
    
    /**
     * Calculate borrow rate based on utilization
     */
    calculateBorrowRate(utilization) {
        if (utilization < 0 || utilization > 1) {
            throw new Error('Utilization must be between 0 and 1');
        }
        
        switch (this.modelType) {
            case 'jump':
                return this.jumpRateModel(utilization);
            case 'linear':
                return this.linearRateModel(utilization);
            case 'polynomial':
                return this.polynomialRateModel(utilization);
            default:
                return this.jumpRateModel(utilization);
        }
    }
    
    /**
     * Jump rate model (kink model)
     */
    jumpRateModel(utilization) {
        const { baseRate, multiplier, jumpMultiplier, kink } = this.config;
        
        if (utilization <= kink) {
            // Below kink: linear increase
            return baseRate + (utilization / kink) * multiplier;
        } else {
            // Above kink: steep increase
            const normalRate = baseRate + multiplier;
            const excessUtilization = utilization - kink;
            return normalRate + (excessUtilization / (1 - kink)) * jumpMultiplier;
        }
    }
    
    /**
     * Linear rate model
     */
    linearRateModel(utilization) {
        const { baseRate, multiplier } = this.config;
        return baseRate + utilization * multiplier;
    }
    
    /**
     * Polynomial rate model
     */
    polynomialRateModel(utilization) {
        const { baseRate, multiplier } = this.config;
        // Quadratic curve for smoother rate changes
        return baseRate + multiplier * Math.pow(utilization, 2);
    }
    
    /**
     * Calculate supply rate from borrow rate
     */
    calculateSupplyRate(borrowRate, utilization) {
        // Supply rate = Borrow rate * Utilization * (1 - Reserve Factor)
        return borrowRate * utilization * (1 - this.config.reserveFactor);
    }
    
    /**
     * Get rate curve data for visualization
     */
    getRateCurve(points = 100) {
        const curve = {
            utilization: [],
            borrowRate: [],
            supplyRate: []
        };
        
        for (let i = 0; i <= points; i++) {
            const utilization = i / points;
            const borrowRate = this.calculateBorrowRate(utilization);
            const supplyRate = this.calculateSupplyRate(borrowRate, utilization);
            
            curve.utilization.push(utilization);
            curve.borrowRate.push(borrowRate);
            curve.supplyRate.push(supplyRate);
        }
        
        return curve;
    }
    
    /**
     * Calculate optimal utilization for maximum supply APY
     */
    getOptimalUtilization() {
        let maxSupplyRate = 0;
        let optimalUtilization = 0;
        
        // Sample points to find maximum
        for (let i = 0; i <= 100; i++) {
            const utilization = i / 100;
            const borrowRate = this.calculateBorrowRate(utilization);
            const supplyRate = this.calculateSupplyRate(borrowRate, utilization);
            
            if (supplyRate > maxSupplyRate) {
                maxSupplyRate = supplyRate;
                optimalUtilization = utilization;
            }
        }
        
        return {
            utilization: optimalUtilization,
            supplyRate: maxSupplyRate
        };
    }
    
    /**
     * Update model parameters
     */
    updateParameters(params) {
        Object.assign(this.config, params);
    }
    
    /**
     * Get model configuration
     */
    getConfig() {
        return { ...this.config };
    }
}

/**
 * Asset-specific interest rate models
 */
export class AssetRateModels {
    constructor() {
        this.models = new Map();
        this.initializeDefaultModels();
    }
    
    initializeDefaultModels() {
        // Stablecoins - Lower base rate, higher kink
        this.models.set('USDT', new InterestRateModel({
            baseRate: 0.01, // 1%
            multiplier: 0.1,
            jumpMultiplier: 0.5,
            kink: 0.9
        }));
        
        this.models.set('USDC', new InterestRateModel({
            baseRate: 0.01,
            multiplier: 0.1,
            jumpMultiplier: 0.5,
            kink: 0.9
        }));
        
        // Major cryptos - Standard rates
        this.models.set('BTC', new InterestRateModel({
            baseRate: 0.02, // 2%
            multiplier: 0.15,
            jumpMultiplier: 0.8,
            kink: 0.8
        }));
        
        this.models.set('ETH', new InterestRateModel({
            baseRate: 0.02,
            multiplier: 0.15,
            jumpMultiplier: 0.8,
            kink: 0.8
        }));
        
        // Volatile assets - Higher rates
        this.models.set('SOL', new InterestRateModel({
            baseRate: 0.03, // 3%
            multiplier: 0.2,
            jumpMultiplier: 1.0,
            kink: 0.75
        }));
    }
    
    getModel(asset) {
        return this.models.get(asset) || new InterestRateModel();
    }
    
    setModel(asset, model) {
        this.models.set(asset, model);
    }
    
    updateModel(asset, params) {
        const model = this.getModel(asset);
        model.updateParameters(params);
    }
}

export default InterestRateModel;