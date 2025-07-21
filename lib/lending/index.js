/**
 * Lending Module for Otedama
 * Unified interface for lending and borrowing functionality
 */

import { EventEmitter } from 'events';
import { LendingPool } from './lending-pool.js';
import { CollateralManager } from './collateral-manager.js';
import { InterestRateModel, AssetRateModels } from './interest-rate-model.js';
import { getLogger } from '../core/logger.js';

export class LendingManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            enableLending: config.enableLending !== false,
            enableBorrowing: config.enableBorrowing !== false,
            ...config
        };
        
        this.logger = getLogger('LendingManager');
        
        // Initialize components
        this.lendingPool = null;
        this.collateralManager = null;
        this.rateModels = new AssetRateModels();
        
        // User stats tracking
        this.userStats = new Map();
        
        // Protocol stats
        this.protocolStats = {
            totalValueLocked: 0,
            totalBorrowed: 0,
            totalReserves: 0,
            activeUsers: 0,
            totalLoans: 0
        };
        
        this.isRunning = false;
    }
    
    /**
     * Start lending manager
     */
    async start() {
        if (this.isRunning) return;
        
        this.logger.info('Starting lending manager...');
        
        // Initialize lending pool
        this.lendingPool = new LendingPool({
            ...this.config,
            priceOracle: this.config.priceOracle
        });
        
        // Initialize collateral manager
        this.collateralManager = new CollateralManager({
            ...this.config,
            priceOracle: this.config.priceOracle
        });
        
        // Setup event listeners
        this.setupEventListeners();
        
        // Start components
        await this.lendingPool.start();
        await this.collateralManager.start();
        
        // Start stats tracking
        this.startStatsTracking();
        
        this.isRunning = true;
        this.logger.info('Lending manager started');
    }
    
    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Lending pool events
        this.lendingPool.on('deposited', (data) => {
            this.updateUserStats(data.userId, 'deposit', data);
            this.emit('deposit', data);
        });
        
        this.lendingPool.on('withdrawn', (data) => {
            this.updateUserStats(data.userId, 'withdraw', data);
            this.emit('withdraw', data);
        });
        
        this.lendingPool.on('borrowed', (data) => {
            this.updateUserStats(data.userId, 'borrow', data);
            this.emit('borrow', data);
        });
        
        this.lendingPool.on('repaid', (data) => {
            this.updateUserStats(data.userId, 'repay', data);
            this.emit('repay', data);
        });
        
        this.lendingPool.on('liquidated', (data) => {
            this.updateUserStats(data.borrowerId, 'liquidation', data);
            this.emit('liquidation', data);
        });
        
        // Collateral manager events
        this.collateralManager.on('liquidation-queued', (data) => {
            this.emit('liquidation-risk', data);
        });
        
        // Rate updates
        this.lendingPool.on('rates-updated', (data) => {
            this.emit('rates-updated', data);
        });
    }
    
    /**
     * Deposit assets
     */
    async deposit(userId, asset, amount) {
        if (!this.config.enableLending) {
            throw new Error('Lending is disabled');
        }
        
        return await this.lendingPool.deposit({
            userId,
            asset,
            amount
        });
    }
    
    /**
     * Withdraw assets
     */
    async withdraw(userId, asset, amount) {
        return await this.lendingPool.withdraw({
            userId,
            asset,
            amount
        });
    }
    
    /**
     * Borrow assets
     */
    async borrow(params) {
        if (!this.config.enableBorrowing) {
            throw new Error('Borrowing is disabled');
        }
        
        const {
            userId,
            asset,
            amount,
            collateralAsset,
            collateralAmount
        } = params;
        
        // Check collateral configuration
        const collateralConfig = this.collateralManager.getCollateralConfig(collateralAsset);
        if (!collateralConfig.enabled) {
            throw new Error(`${collateralAsset} is not accepted as collateral`);
        }
        
        // Validate collateral ratio
        const borrowingPower = await this.collateralManager.calculateBorrowingPower([{
            asset: collateralAsset,
            amount: collateralAmount
        }]);
        
        const borrowValue = await this.getAssetValue(asset, amount);
        if (borrowValue > borrowingPower) {
            throw new Error('Insufficient collateral');
        }
        
        return await this.lendingPool.borrow(params);
    }
    
    /**
     * Repay loan
     */
    async repay(userId, loanId, amount) {
        return await this.lendingPool.repay({
            userId,
            loanId,
            amount
        });
    }
    
    /**
     * Get user position
     */
    async getUserPosition(userId) {
        const position = this.lendingPool.getUserPosition(userId);
        
        // Calculate health factor
        if (position.borrows.length > 0) {
            const collaterals = position.deposits.map(d => ({
                asset: d.asset,
                amount: d.amount
            }));
            
            const borrows = position.borrows.map(b => ({
                asset: b.asset,
                amount: b.amount
            }));
            
            position.healthFactor = await this.collateralManager.calculateHealthFactor({
                collaterals,
                borrows
            });
            
            position.borrowingPower = await this.collateralManager.calculateBorrowingPower(collaterals);
        }
        
        // Add user stats
        const stats = this.userStats.get(userId);
        if (stats) {
            position.stats = stats;
        }
        
        return position;
    }
    
    /**
     * Get market data
     */
    getMarkets() {
        const markets = [];
        
        for (const [asset, pool] of this.lendingPool.pools) {
            const collateralConfig = this.collateralManager.getCollateralConfig(asset);
            const rateModel = this.rateModels.getModel(asset);
            
            markets.push({
                asset,
                totalDeposited: pool.totalDeposited,
                totalBorrowed: pool.totalBorrowed,
                availableLiquidity: pool.availableLiquidity,
                utilizationRate: pool.utilizationRate,
                supplyAPR: pool.supplyAPR,
                borrowAPR: pool.borrowAPR,
                collateralEnabled: collateralConfig.enabled,
                maxLTV: collateralConfig.maxLTV,
                liquidationThreshold: collateralConfig.liquidationThreshold,
                rateCurve: rateModel.getRateCurve(20) // 20 points for visualization
            });
        }
        
        return markets;
    }
    
    /**
     * Get protocol statistics
     */
    getProtocolStats() {
        // Calculate TVL and total borrowed
        let tvl = 0;
        let totalBorrowed = 0;
        let totalReserves = 0;
        
        for (const [asset, pool] of this.lendingPool.pools) {
            const price = this.getAssetPrice(asset);
            tvl += pool.totalDeposited * price;
            totalBorrowed += pool.totalBorrowed * price;
            totalReserves += pool.reserves * price;
        }
        
        this.protocolStats.totalValueLocked = tvl;
        this.protocolStats.totalBorrowed = totalBorrowed;
        this.protocolStats.totalReserves = totalReserves;
        this.protocolStats.activeUsers = this.userStats.size;
        this.protocolStats.totalLoans = this.lendingPool.loans.size;
        
        return {
            ...this.protocolStats,
            utilizationRate: tvl > 0 ? totalBorrowed / tvl : 0,
            markets: this.lendingPool.pools.size
        };
    }
    
    /**
     * Update user statistics
     */
    updateUserStats(userId, action, data) {
        if (!this.userStats.has(userId)) {
            this.userStats.set(userId, {
                totalDeposited: 0,
                totalBorrowed: 0,
                totalRepaid: 0,
                totalWithdrawn: 0,
                liquidations: 0,
                firstActionTime: Date.now(),
                lastActionTime: Date.now()
            });
        }
        
        const stats = this.userStats.get(userId);
        stats.lastActionTime = Date.now();
        
        switch (action) {
            case 'deposit':
                stats.totalDeposited += data.amount;
                break;
            case 'withdraw':
                stats.totalWithdrawn += data.amount;
                break;
            case 'borrow':
                stats.totalBorrowed += data.amount;
                break;
            case 'repay':
                stats.totalRepaid += data.repaidAmount;
                break;
            case 'liquidation':
                stats.liquidations++;
                break;
        }
    }
    
    /**
     * Monitor positions for liquidation
     */
    async monitorLiquidations() {
        for (const [userId, borrows] of this.lendingPool.borrows) {
            if (borrows.size === 0) continue;
            
            try {
                const position = await this.getUserPosition(userId);
                
                if (position.healthFactor < 1.0) {
                    // Queue for liquidation
                    this.collateralManager.queueLiquidation({
                        userId,
                        collaterals: position.deposits,
                        borrows: position.borrows
                    });
                } else if (position.healthFactor < 1.1) {
                    // Warning zone
                    this.emit('health-factor-warning', {
                        userId,
                        healthFactor: position.healthFactor
                    });
                }
            } catch (error) {
                this.logger.error(`Error monitoring user ${userId}: ${error.message}`);
            }
        }
    }
    
    /**
     * Start statistics tracking
     */
    startStatsTracking() {
        // Update protocol stats
        setInterval(() => {
            this.getProtocolStats();
        }, 30000); // Every 30 seconds
        
        // Monitor liquidations
        setInterval(() => {
            this.monitorLiquidations();
        }, 10000); // Every 10 seconds
    }
    
    /**
     * Helper functions
     */
    async getAssetValue(asset, amount) {
        const price = await this.getAssetPrice(asset);
        return amount * price;
    }
    
    async getAssetPrice(asset) {
        // This would use the price oracle
        // Mock implementation
        const prices = {
            'BTC': 40000,
            'ETH': 2500,
            'USDT': 1,
            'USDC': 1,
            'SOL': 100
        };
        return prices[asset] || 0;
    }
    
    /**
     * Admin functions
     */
    updateInterestRateModel(asset, params) {
        this.rateModels.updateModel(asset, params);
        
        // Trigger rate recalculation
        this.lendingPool.updatePoolRates(asset);
    }
    
    updateCollateralConfig(asset, config) {
        this.collateralManager.setCollateralConfig(asset, config);
    }
    
    pauseMarket(asset) {
        const pool = this.lendingPool.pools.get(asset);
        if (pool) {
            pool.borrowEnabled = false;
            this.emit('market-paused', { asset });
        }
    }
    
    unpauseMarket(asset) {
        const pool = this.lendingPool.pools.get(asset);
        if (pool) {
            pool.borrowEnabled = true;
            this.emit('market-unpaused', { asset });
        }
    }
    
    /**
     * Stop lending manager
     */
    async stop() {
        if (!this.isRunning) return;
        
        this.logger.info('Stopping lending manager...');
        
        if (this.lendingPool) {
            await this.lendingPool.stop();
        }
        
        if (this.collateralManager) {
            await this.collateralManager.stop();
        }
        
        this.isRunning = false;
        this.logger.info('Lending manager stopped');
    }
}

// Export all components
export { LendingPool } from './lending-pool.js';
export { CollateralManager } from './collateral-manager.js';
export { InterestRateModel, AssetRateModels } from './interest-rate-model.js';

export default LendingManager;