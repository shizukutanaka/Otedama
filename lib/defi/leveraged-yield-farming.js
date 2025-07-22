/**
 * Leveraged Yield Farming for Otedama
 * Amplify yields with borrowed capital
 * 
 * Design principles:
 * - High-performance position management (Carmack)
 * - Clean leverage protocols (Martin)
 * - Simple risk controls (Pike)
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

const logger = getLogger('LeveragedYieldFarming');

export class LeveragedYieldFarming extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Leverage settings
            maxLeverage: config.maxLeverage || 3, // 3x max leverage
            minLeverage: config.minLeverage || 1,
            defaultLeverage: config.defaultLeverage || 1.5,
            
            // Risk parameters
            liquidationThreshold: config.liquidationThreshold || 0.85, // 85% LTV
            maintenanceMargin: config.maintenanceMargin || 0.8, // 80%
            liquidationPenalty: config.liquidationPenalty || 0.05, // 5%
            
            // Interest rates
            baseInterestRate: config.baseInterestRate || 0.05, // 5% APR base
            utilizationOptimal: config.utilizationOptimal || 0.8,
            slopeRate1: config.slopeRate1 || 0.1,
            slopeRate2: config.slopeRate2 || 0.5,
            
            // Position limits
            maxPositionsPerUser: config.maxPositionsPerUser || 10,
            minPositionValue: config.minPositionValue || 100, // $100
            maxPositionValue: config.maxPositionValue || 1000000, // $1M
            
            // Fees
            borrowingFee: config.borrowingFee || 0.001, // 0.1%
            performanceFee: config.performanceFee || 0.1, // 10%
            
            // Safety settings
            emergencyWithdrawEnabled: config.emergencyWithdrawEnabled || true,
            maxPriceImpact: config.maxPriceImpact || 0.05, // 5%
            deleverageThreshold: config.deleverageThreshold || 0.9, // 90% of liquidation
            
            // Oracle settings
            priceUpdateInterval: config.priceUpdateInterval || 60000, // 1 minute
            maxPriceAge: config.maxPriceAge || 300000, // 5 minutes
            
            ...config
        };
        
        // Position registry
        this.positions = new Map(); // positionId -> LeveragedPosition
        this.userPositions = new Map(); // userId -> Set<positionId>
        
        // Lending pools
        this.lendingPools = new Map(); // asset -> LendingPool
        
        // Farm registry
        this.farms = new Map(); // farmId -> YieldFarm
        this.farmStrategies = new Map(); // strategyId -> FarmStrategy
        
        // Price oracles
        this.priceOracles = new Map(); // asset -> PriceOracle
        
        // Liquidation queue
        this.liquidationQueue = [];
        this.isProcessingLiquidations = false;
        
        // Statistics
        this.stats = {
            totalPositions: 0,
            activePositions: 0,
            totalBorrowed: 0,
            totalSupplied: 0,
            totalLiquidations: 0,
            totalYieldGenerated: 0,
            averageLeverage: 0,
            utilizationRate: 0
        };
        
        // Start monitoring
        this.startMonitoring();
    }
    
    /**
     * Register yield farm
     */
    registerFarm(params) {
        const {
            farmId,
            name,
            asset,
            rewardToken,
            baseAPY,
            protocol,
            minDeposit = 100,
            maxDeposit = 1000000
        } = params;
        
        const farm = {
            id: farmId,
            name,
            asset,
            rewardToken,
            baseAPY,
            protocol,
            minDeposit,
            maxDeposit,
            totalDeposited: 0,
            status: 'active',
            createdAt: Date.now()
        };
        
        this.farms.set(farmId, farm);
        
        logger.info(`Yield farm registered: ${farmId} - ${name}`);
        
        this.emit('farm:registered', {
            farm,
            timestamp: Date.now()
        });
        
        return farm;
    }
    
    /**
     * Create lending pool for leverage
     */
    createLendingPool(asset, config = {}) {
        const pool = {
            asset,
            totalSupplied: 0,
            totalBorrowed: 0,
            availableLiquidity: 0,
            
            // Interest model
            baseRate: config.baseRate || this.config.baseInterestRate,
            utilizationOptimal: config.utilizationOptimal || this.config.utilizationOptimal,
            slopeRate1: config.slopeRate1 || this.config.slopeRate1,
            slopeRate2: config.slopeRate2 || this.config.slopeRate2,
            
            // Risk parameters
            collateralFactor: config.collateralFactor || 0.75,
            reserveFactor: config.reserveFactor || 0.1,
            
            status: 'active',
            createdAt: Date.now()
        };
        
        this.lendingPools.set(asset, pool);
        
        logger.info(`Lending pool created for ${asset}`);
        
        return pool;
    }
    
    /**
     * Open leveraged yield farming position
     */
    async openPosition(params) {
        const {
            userId,
            farmId,
            depositAmount,
            leverage = this.config.defaultLeverage,
            slippageTolerance = 0.01
        } = params;
        
        // Validate inputs
        const farm = this.farms.get(farmId);
        if (!farm) {
            throw new Error('Farm not found');
        }
        
        if (leverage < this.config.minLeverage || leverage > this.config.maxLeverage) {
            throw new Error(`Leverage must be between ${this.config.minLeverage}x and ${this.config.maxLeverage}x`);
        }
        
        const totalPositionValue = depositAmount * leverage;
        if (totalPositionValue < this.config.minPositionValue || totalPositionValue > this.config.maxPositionValue) {
            throw new Error('Position value out of range');
        }
        
        // Check user position limit
        const userPositionCount = this.userPositions.get(userId)?.size || 0;
        if (userPositionCount >= this.config.maxPositionsPerUser) {
            throw new Error('Maximum positions reached');
        }
        
        // Calculate borrowing amount
        const borrowAmount = depositAmount * (leverage - 1);
        
        // Check lending pool liquidity
        const lendingPool = this.lendingPools.get(farm.asset);
        if (!lendingPool) {
            throw new Error('Lending pool not available');
        }
        
        if (lendingPool.availableLiquidity < borrowAmount) {
            throw new Error('Insufficient liquidity for leverage');
        }
        
        // Calculate interest rate
        const interestRate = this.calculateInterestRate(lendingPool);
        
        // Get current prices
        const assetPrice = await this.getAssetPrice(farm.asset);
        const collateralValue = depositAmount * assetPrice;
        
        // Create position
        const positionId = this.generatePositionId();
        const position = {
            id: positionId,
            userId,
            farmId,
            
            // Amounts
            depositAmount,
            borrowAmount,
            totalAmount: totalPositionValue,
            leverage,
            
            // Pricing
            entryPrice: assetPrice,
            currentPrice: assetPrice,
            
            // Interest
            interestRate,
            accumulatedInterest: 0,
            lastInterestUpdate: Date.now(),
            
            // Yield tracking
            yieldEarned: 0,
            rewardsEarned: 0,
            lastHarvestTime: Date.now(),
            
            // Risk metrics
            collateralValue,
            debtValue: borrowAmount * assetPrice,
            healthFactor: this.calculateHealthFactor(collateralValue, borrowAmount * assetPrice),
            liquidationPrice: this.calculateLiquidationPrice(assetPrice, leverage),
            
            // Status
            status: 'active',
            openedAt: Date.now(),
            lastUpdateTime: Date.now()
        };
        
        // Execute position opening
        try {
            // Borrow funds
            lendingPool.totalBorrowed += borrowAmount;
            lendingPool.availableLiquidity -= borrowAmount;
            
            // Deposit to farm
            farm.totalDeposited += totalPositionValue;
            
            // Store position
            this.positions.set(positionId, position);
            
            // Update user positions
            if (!this.userPositions.has(userId)) {
                this.userPositions.set(userId, new Set());
            }
            this.userPositions.get(userId).add(positionId);
            
            // Update stats
            this.stats.totalPositions++;
            this.stats.activePositions++;
            this.stats.totalBorrowed += borrowAmount;
            this.updateAverageLeverage();
            
            // Pay borrowing fee
            const borrowingFee = borrowAmount * this.config.borrowingFee;
            position.accumulatedInterest += borrowingFee;
            
            logger.info(`Leveraged position opened: ${positionId}, leverage: ${leverage}x, amount: ${totalPositionValue}`);
            
            this.emit('position:opened', {
                position,
                timestamp: Date.now()
            });
            
            return position;
            
        } catch (error) {
            logger.error(`Failed to open leveraged position: ${error.message}`);
            throw error;
        }
    }
    
    /**
     * Close leveraged position
     */
    async closePosition(userId, positionId) {
        const position = this.positions.get(positionId);
        if (!position) {
            throw new Error('Position not found');
        }
        
        if (position.userId !== userId && !this.config.allowLiquidatorClose) {
            throw new Error('Unauthorized');
        }
        
        if (position.status !== 'active') {
            throw new Error('Position is not active');
        }
        
        try {
            // Update interest
            await this.updatePositionInterest(position);
            
            // Harvest pending yields
            await this.harvestYield(position);
            
            // Get current price
            const farm = this.farms.get(position.farmId);
            const currentPrice = await this.getAssetPrice(farm.asset);
            position.currentPrice = currentPrice;
            
            // Calculate final amounts
            const totalDebt = position.borrowAmount + position.accumulatedInterest;
            const positionValue = position.totalAmount * currentPrice;
            const profitLoss = positionValue - (position.depositAmount * position.entryPrice) - totalDebt;
            
            // Repay loan
            const lendingPool = this.lendingPools.get(farm.asset);
            lendingPool.totalBorrowed -= position.borrowAmount;
            lendingPool.availableLiquidity += totalDebt;
            
            // Withdraw from farm
            farm.totalDeposited -= position.totalAmount;
            
            // Calculate fees
            let performanceFee = 0;
            if (profitLoss > 0) {
                performanceFee = profitLoss * this.config.performanceFee;
            }
            
            // Calculate user returns
            const netReturns = position.depositAmount + profitLoss + position.yieldEarned - performanceFee;
            
            // Update position status
            position.status = 'closed';
            position.closedAt = Date.now();
            position.finalPnL = profitLoss;
            position.performanceFee = performanceFee;
            position.netReturns = netReturns;
            
            // Remove from active positions
            this.userPositions.get(userId).delete(positionId);
            
            // Update stats
            this.stats.activePositions--;
            this.stats.totalBorrowed -= position.borrowAmount;
            this.stats.totalYieldGenerated += position.yieldEarned;
            this.updateAverageLeverage();
            
            logger.info(`Position closed: ${positionId}, PnL: ${profitLoss}, net returns: ${netReturns}`);
            
            this.emit('position:closed', {
                position,
                profitLoss,
                netReturns,
                timestamp: Date.now()
            });
            
            return {
                position,
                profitLoss,
                netReturns,
                performanceFee
            };
            
        } catch (error) {
            logger.error(`Failed to close position ${positionId}:`, error);
            throw error;
        }
    }
    
    /**
     * Adjust position leverage
     */
    async adjustLeverage(userId, positionId, newLeverage) {
        const position = this.positions.get(positionId);
        if (!position) {
            throw new Error('Position not found');
        }
        
        if (position.userId !== userId) {
            throw new Error('Unauthorized');
        }
        
        if (position.status !== 'active') {
            throw new Error('Position is not active');
        }
        
        if (newLeverage < this.config.minLeverage || newLeverage > this.config.maxLeverage) {
            throw new Error('Invalid leverage');
        }
        
        const farm = this.farms.get(position.farmId);
        const lendingPool = this.lendingPools.get(farm.asset);
        const currentPrice = await this.getAssetPrice(farm.asset);
        
        // Calculate new borrow amount
        const newTotalAmount = position.depositAmount * newLeverage;
        const newBorrowAmount = position.depositAmount * (newLeverage - 1);
        const borrowDelta = newBorrowAmount - position.borrowAmount;
        
        if (borrowDelta > 0) {
            // Increasing leverage - check liquidity
            if (lendingPool.availableLiquidity < borrowDelta) {
                throw new Error('Insufficient liquidity');
            }
            
            lendingPool.totalBorrowed += borrowDelta;
            lendingPool.availableLiquidity -= borrowDelta;
            farm.totalDeposited += borrowDelta;
            
        } else if (borrowDelta < 0) {
            // Decreasing leverage - repay debt
            const repayAmount = Math.abs(borrowDelta);
            lendingPool.totalBorrowed -= repayAmount;
            lendingPool.availableLiquidity += repayAmount;
            farm.totalDeposited -= repayAmount;
        }
        
        // Update position
        position.borrowAmount = newBorrowAmount;
        position.totalAmount = newTotalAmount;
        position.leverage = newLeverage;
        position.debtValue = newBorrowAmount * currentPrice;
        position.healthFactor = this.calculateHealthFactor(
            position.depositAmount * currentPrice,
            position.debtValue
        );
        position.liquidationPrice = this.calculateLiquidationPrice(currentPrice, newLeverage);
        position.lastUpdateTime = Date.now();
        
        // Update stats
        this.stats.totalBorrowed += borrowDelta;
        this.updateAverageLeverage();
        
        logger.info(`Position leverage adjusted: ${positionId}, new leverage: ${newLeverage}x`);
        
        this.emit('position:leverageAdjusted', {
            position,
            oldLeverage: position.leverage,
            newLeverage,
            timestamp: Date.now()
        });
        
        return position;
    }
    
    /**
     * Update position interest
     */
    async updatePositionInterest(position) {
        const timeDelta = Date.now() - position.lastInterestUpdate;
        const yearFraction = timeDelta / (365 * 24 * 60 * 60 * 1000);
        
        const interestAmount = position.borrowAmount * position.interestRate * yearFraction;
        position.accumulatedInterest += interestAmount;
        position.lastInterestUpdate = Date.now();
        
        return interestAmount;
    }
    
    /**
     * Harvest yield from position
     */
    async harvestYield(position) {
        const farm = this.farms.get(position.farmId);
        const timeDelta = Date.now() - position.lastHarvestTime;
        const yearFraction = timeDelta / (365 * 24 * 60 * 60 * 1000);
        
        // Calculate yield based on farm APY and position size
        const yieldAmount = position.totalAmount * farm.baseAPY * yearFraction;
        position.yieldEarned += yieldAmount;
        position.lastHarvestTime = Date.now();
        
        // Mock reward token earnings
        const rewardAmount = yieldAmount * 0.1; // 10% in reward tokens
        position.rewardsEarned += rewardAmount;
        
        logger.info(`Yield harvested for position ${position.id}: ${yieldAmount}`);
        
        this.emit('yield:harvested', {
            positionId: position.id,
            yieldAmount,
            rewardAmount,
            timestamp: Date.now()
        });
        
        return {
            yieldAmount,
            rewardAmount
        };
    }
    
    /**
     * Check and liquidate unhealthy positions
     */
    async checkLiquidations() {
        const liquidationCandidates = [];
        
        for (const [positionId, position] of this.positions) {
            if (position.status !== 'active') continue;
            
            // Update position metrics
            const farm = this.farms.get(position.farmId);
            const currentPrice = await this.getAssetPrice(farm.asset);
            
            position.currentPrice = currentPrice;
            position.collateralValue = position.depositAmount * currentPrice;
            position.debtValue = (position.borrowAmount + position.accumulatedInterest) * currentPrice;
            position.healthFactor = this.calculateHealthFactor(position.collateralValue, position.debtValue);
            
            // Check if position should be liquidated
            if (position.healthFactor < 1) {
                liquidationCandidates.push(position);
            }
            // Check if position should be deleveraged
            else if (position.healthFactor < (1 / this.config.deleverageThreshold)) {
                this.emit('position:deleverage:warning', {
                    position,
                    healthFactor: position.healthFactor,
                    timestamp: Date.now()
                });
            }
        }
        
        // Process liquidations
        for (const position of liquidationCandidates) {
            await this.liquidatePosition(position);
        }
    }
    
    /**
     * Liquidate unhealthy position
     */
    async liquidatePosition(position) {
        if (position.status !== 'active') return;
        
        logger.warn(`Liquidating position: ${position.id}, health factor: ${position.healthFactor}`);
        
        position.status = 'liquidating';
        
        try {
            // Calculate liquidation amounts
            const totalDebt = position.borrowAmount + position.accumulatedInterest;
            const liquidationPenalty = position.collateralValue * this.config.liquidationPenalty;
            
            // Force close position
            const farm = this.farms.get(position.farmId);
            const lendingPool = this.lendingPools.get(farm.asset);
            
            // Repay debt
            lendingPool.totalBorrowed -= position.borrowAmount;
            lendingPool.availableLiquidity += totalDebt;
            
            // Remove from farm
            farm.totalDeposited -= position.totalAmount;
            
            // Calculate liquidator reward and remaining value
            const remainingValue = position.collateralValue - totalDebt - liquidationPenalty;
            
            // Update position
            position.status = 'liquidated';
            position.liquidatedAt = Date.now();
            position.liquidationPenalty = liquidationPenalty;
            position.remainingValue = Math.max(0, remainingValue);
            
            // Update stats
            this.stats.activePositions--;
            this.stats.totalLiquidations++;
            this.stats.totalBorrowed -= position.borrowAmount;
            this.updateAverageLeverage();
            
            logger.info(`Position liquidated: ${position.id}, penalty: ${liquidationPenalty}`);
            
            this.emit('position:liquidated', {
                position,
                liquidationPenalty,
                remainingValue,
                timestamp: Date.now()
            });
            
        } catch (error) {
            logger.error(`Failed to liquidate position ${position.id}:`, error);
            position.status = 'active'; // Revert status
        }
    }
    
    /**
     * Calculate health factor
     */
    calculateHealthFactor(collateralValue, debtValue) {
        if (debtValue === 0) return 999;
        return (collateralValue * this.config.liquidationThreshold) / debtValue;
    }
    
    /**
     * Calculate liquidation price
     */
    calculateLiquidationPrice(currentPrice, leverage) {
        return currentPrice * (1 - (1 / leverage) * this.config.liquidationThreshold);
    }
    
    /**
     * Calculate interest rate based on utilization
     */
    calculateInterestRate(pool) {
        if (pool.totalSupplied === 0) return this.config.baseInterestRate;
        
        const utilization = pool.totalBorrowed / pool.totalSupplied;
        
        if (utilization <= pool.utilizationOptimal) {
            return pool.baseRate + (utilization / pool.utilizationOptimal) * pool.slopeRate1;
        } else {
            const excessUtilization = utilization - pool.utilizationOptimal;
            return pool.baseRate + pool.slopeRate1 + 
                   (excessUtilization / (1 - pool.utilizationOptimal)) * pool.slopeRate2;
        }
    }
    
    /**
     * Get asset price from oracle
     */
    async getAssetPrice(asset) {
        const oracle = this.priceOracles.get(asset);
        if (!oracle) {
            // Mock price for testing
            return 100 + Math.random() * 20;
        }
        
        const priceData = await oracle.getPrice();
        if (Date.now() - priceData.timestamp > this.config.maxPriceAge) {
            throw new Error('Price data too old');
        }
        
        return priceData.price;
    }
    
    /**
     * Update average leverage
     */
    updateAverageLeverage() {
        let totalLeverage = 0;
        let activeCount = 0;
        
        for (const position of this.positions.values()) {
            if (position.status === 'active') {
                totalLeverage += position.leverage;
                activeCount++;
            }
        }
        
        this.stats.averageLeverage = activeCount > 0 ? totalLeverage / activeCount : 0;
    }
    
    /**
     * Register price oracle
     */
    registerPriceOracle(asset, oracle) {
        this.priceOracles.set(asset, oracle);
        logger.info(`Price oracle registered for ${asset}`);
    }
    
    /**
     * Start monitoring
     */
    startMonitoring() {
        // Health check interval
        this.healthCheckInterval = setInterval(async () => {
            await this.checkLiquidations();
        }, 30000); // Every 30 seconds
        
        // Interest update interval
        this.interestInterval = setInterval(async () => {
            for (const position of this.positions.values()) {
                if (position.status === 'active') {
                    await this.updatePositionInterest(position);
                }
            }
        }, 3600000); // Every hour
        
        // Stats update interval
        this.statsInterval = setInterval(() => {
            this.updateStats();
        }, 10000); // Every 10 seconds
        
        logger.info('Leveraged yield farming monitoring started');
    }
    
    /**
     * Update statistics
     */
    updateStats() {
        let totalSupplied = 0;
        let totalBorrowed = 0;
        
        for (const pool of this.lendingPools.values()) {
            totalSupplied += pool.totalSupplied;
            totalBorrowed += pool.totalBorrowed;
        }
        
        this.stats.totalSupplied = totalSupplied;
        this.stats.utilizationRate = totalSupplied > 0 ? totalBorrowed / totalSupplied : 0;
    }
    
    /**
     * Stop monitoring
     */
    stop() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        
        if (this.interestInterval) {
            clearInterval(this.interestInterval);
        }
        
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
        }
        
        logger.info('Leveraged yield farming monitoring stopped');
    }
    
    /**
     * Helper methods
     */
    
    generatePositionId() {
        return `LYF${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Get user positions
     */
    getUserPositions(userId) {
        const positionIds = this.userPositions.get(userId);
        if (!positionIds) return [];
        
        return Array.from(positionIds)
            .map(id => this.positions.get(id))
            .filter(p => p !== undefined);
    }
    
    /**
     * Get farm info
     */
    getFarm(farmId) {
        return this.farms.get(farmId);
    }
    
    /**
     * Get all active farms
     */
    getActiveFarms() {
        return Array.from(this.farms.values())
            .filter(f => f.status === 'active');
    }
    
    /**
     * Get platform statistics
     */
    getStats() {
        return {
            ...this.stats,
            farms: this.farms.size,
            lendingPools: this.lendingPools.size,
            timestamp: Date.now()
        };
    }
}

export default LeveragedYieldFarming;