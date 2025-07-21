/**
 * Lending Pool for Otedama
 * Manages asset lending and borrowing with dynamic interest rates
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

export class LendingPool extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            minLoanDuration: config.minLoanDuration || 1 * 60 * 60 * 1000, // 1 hour
            maxLoanDuration: config.maxLoanDuration || 365 * 24 * 60 * 60 * 1000, // 1 year
            baseInterestRate: config.baseInterestRate || 0.02, // 2% APR base
            utilizationTarget: config.utilizationTarget || 0.8, // 80% target
            collateralRatio: config.collateralRatio || 1.5, // 150% collateralization
            liquidationThreshold: config.liquidationThreshold || 1.2, // 120%
            liquidationPenalty: config.liquidationPenalty || 0.1, // 10%
            borrowFee: config.borrowFee || 0.001, // 0.1%
            ...config
        };
        
        this.logger = getLogger('LendingPool');
        
        // Pools for each asset
        this.pools = new Map(); // asset -> pool info
        
        // Active loans
        this.loans = new Map(); // loanId -> loan
        
        // User positions
        this.deposits = new Map(); // userId -> asset -> deposit
        this.borrows = new Map(); // userId -> loanId -> loan
        
        // Interest accumulator
        this.interestAccumulators = new Map(); // asset -> accumulator
        
        // Price oracle
        this.priceOracle = config.priceOracle || null;
        
        this.isRunning = false;
    }
    
    /**
     * Start lending pool
     */
    async start() {
        if (this.isRunning) return;
        
        this.logger.info('Starting lending pool...');
        
        // Initialize default pools
        this.initializeDefaultPools();
        
        // Start interest calculation
        this.startInterestCalculation();
        
        // Start liquidation monitoring
        this.startLiquidationMonitoring();
        
        // Start utilization monitoring
        this.startUtilizationMonitoring();
        
        this.isRunning = true;
        this.logger.info('Lending pool started');
    }
    
    /**
     * Initialize default asset pools
     */
    initializeDefaultPools() {
        const defaultAssets = ['BTC', 'ETH', 'USDT', 'USDC', 'SOL'];
        
        for (const asset of defaultAssets) {
            this.createPool(asset);
        }
    }
    
    /**
     * Create lending pool for asset
     */
    createPool(asset, config = {}) {
        if (this.pools.has(asset)) {
            return this.pools.get(asset);
        }
        
        const pool = {
            asset,
            totalDeposited: 0,
            totalBorrowed: 0,
            availableLiquidity: 0,
            utilizationRate: 0,
            supplyAPR: 0,
            borrowAPR: 0,
            lastUpdateTime: Date.now(),
            reserveFactor: config.reserveFactor || 0.1, // 10% to reserves
            reserves: 0,
            collateralEnabled: config.collateralEnabled !== false,
            borrowEnabled: config.borrowEnabled !== false,
            maxLTV: config.maxLTV || 0.75, // 75% max loan-to-value
            ...config
        };
        
        this.pools.set(asset, pool);
        this.interestAccumulators.set(asset, 1); // Start at 1
        
        this.logger.info(`Created lending pool for ${asset}`);
        this.emit('pool-created', pool);
        
        return pool;
    }
    
    /**
     * Deposit assets into lending pool
     */
    async deposit(params) {
        const { userId, asset, amount } = params;
        
        const pool = this.pools.get(asset);
        if (!pool) {
            throw new Error(`Pool for ${asset} not found`);
        }
        
        if (amount <= 0) {
            throw new Error('Deposit amount must be positive');
        }
        
        // Check user balance
        const balance = await this.getUserBalance(userId, asset);
        if (balance < amount) {
            throw new Error('Insufficient balance');
        }
        
        // Update pool state
        pool.totalDeposited += amount;
        pool.availableLiquidity += amount;
        this.updatePoolRates(asset);
        
        // Update user deposit
        if (!this.deposits.has(userId)) {
            this.deposits.set(userId, new Map());
        }
        
        const userDeposits = this.deposits.get(userId);
        const existingDeposit = userDeposits.get(asset) || {
            amount: 0,
            shares: 0,
            depositTime: Date.now()
        };
        
        // Calculate shares based on current pool state
        const shares = this.calculateDepositShares(asset, amount);
        
        existingDeposit.amount += amount;
        existingDeposit.shares += shares;
        existingDeposit.lastUpdateTime = Date.now();
        
        userDeposits.set(asset, existingDeposit);
        
        // Transfer assets from user
        await this.transferFrom(userId, asset, amount);
        
        this.emit('deposited', {
            userId,
            asset,
            amount,
            shares,
            timestamp: Date.now()
        });
        
        return {
            asset,
            amount,
            shares,
            apy: pool.supplyAPR
        };
    }
    
    /**
     * Withdraw assets from lending pool
     */
    async withdraw(params) {
        const { userId, asset, amount } = params;
        
        const pool = this.pools.get(asset);
        if (!pool) {
            throw new Error(`Pool for ${asset} not found`);
        }
        
        const userDeposits = this.deposits.get(userId);
        if (!userDeposits) {
            throw new Error('No deposits found');
        }
        
        const deposit = userDeposits.get(asset);
        if (!deposit) {
            throw new Error(`No ${asset} deposits found`);
        }
        
        // Calculate maximum withdrawable amount
        const maxWithdrawable = this.calculateWithdrawableAmount(userId, asset);
        if (amount > maxWithdrawable) {
            throw new Error('Amount exceeds withdrawable balance');
        }
        
        // Check pool liquidity
        if (amount > pool.availableLiquidity) {
            throw new Error('Insufficient pool liquidity');
        }
        
        // Calculate shares to burn
        const sharesToBurn = (amount / deposit.amount) * deposit.shares;
        
        // Update pool state
        pool.totalDeposited -= amount;
        pool.availableLiquidity -= amount;
        this.updatePoolRates(asset);
        
        // Update user deposit
        deposit.amount -= amount;
        deposit.shares -= sharesToBurn;
        
        if (deposit.amount === 0) {
            userDeposits.delete(asset);
        }
        
        // Transfer assets to user
        await this.transferTo(userId, asset, amount);
        
        this.emit('withdrawn', {
            userId,
            asset,
            amount,
            shares: sharesToBurn,
            timestamp: Date.now()
        });
        
        return {
            asset,
            amount,
            remainingDeposit: deposit.amount
        };
    }
    
    /**
     * Borrow assets from lending pool
     */
    async borrow(params) {
        const {
            userId,
            asset,
            amount,
            collateralAsset,
            collateralAmount,
            duration = 0 // 0 for open-ended
        } = params;
        
        const pool = this.pools.get(asset);
        if (!pool || !pool.borrowEnabled) {
            throw new Error(`Borrowing ${asset} not available`);
        }
        
        if (amount > pool.availableLiquidity) {
            throw new Error('Insufficient pool liquidity');
        }
        
        // Check collateral value
        const collateralValue = await this.getAssetValue(collateralAsset, collateralAmount);
        const borrowValue = await this.getAssetValue(asset, amount);
        const collateralRatio = collateralValue / borrowValue;
        
        if (collateralRatio < this.config.collateralRatio) {
            throw new Error(`Insufficient collateral. Required: ${this.config.collateralRatio}x`);
        }
        
        // Check user's borrowing capacity
        const borrowingPower = await this.getUserBorrowingPower(userId);
        if (borrowValue > borrowingPower) {
            throw new Error('Exceeds borrowing capacity');
        }
        
        // Create loan
        const loanId = this.generateLoanId();
        const loan = {
            id: loanId,
            userId,
            asset,
            amount,
            collateralAsset,
            collateralAmount,
            borrowRate: pool.borrowAPR,
            borrowTime: Date.now(),
            duration,
            expiryTime: duration > 0 ? Date.now() + duration : null,
            accruedInterest: 0,
            status: 'active',
            lastUpdateTime: Date.now()
        };
        
        // Calculate and charge borrow fee
        const borrowFee = amount * this.config.borrowFee;
        
        // Update pool state
        pool.totalBorrowed += amount;
        pool.availableLiquidity -= amount;
        this.updatePoolRates(asset);
        
        // Store loan
        this.loans.set(loanId, loan);
        
        // Update user borrows
        if (!this.borrows.has(userId)) {
            this.borrows.set(userId, new Map());
        }
        this.borrows.get(userId).set(loanId, loan);
        
        // Transfer collateral from user
        await this.transferFrom(userId, collateralAsset, collateralAmount);
        
        // Transfer borrowed assets to user (minus fee)
        await this.transferTo(userId, asset, amount - borrowFee);
        
        // Add fee to reserves
        pool.reserves += borrowFee;
        
        this.emit('borrowed', {
            userId,
            loanId,
            asset,
            amount,
            collateralAsset,
            collateralAmount,
            borrowRate: loan.borrowRate,
            timestamp: Date.now()
        });
        
        return {
            loanId,
            asset,
            amount: amount - borrowFee,
            borrowRate: loan.borrowRate,
            collateralRatio
        };
    }
    
    /**
     * Repay borrowed assets
     */
    async repay(params) {
        const { userId, loanId, amount } = params;
        
        const loan = this.loans.get(loanId);
        if (!loan) {
            throw new Error('Loan not found');
        }
        
        if (loan.userId !== userId) {
            throw new Error('Unauthorized');
        }
        
        if (loan.status !== 'active') {
            throw new Error('Loan is not active');
        }
        
        // Calculate current debt
        const currentDebt = this.calculateCurrentDebt(loan);
        const repayAmount = Math.min(amount, currentDebt);
        
        // Check user balance
        const balance = await this.getUserBalance(userId, loan.asset);
        if (balance < repayAmount) {
            throw new Error('Insufficient balance');
        }
        
        const pool = this.pools.get(loan.asset);
        
        // Calculate interest portion
        const interestPortion = loan.accruedInterest;
        const principalPortion = repayAmount - interestPortion;
        
        // Update loan
        loan.amount -= principalPortion;
        loan.accruedInterest -= Math.min(interestPortion, loan.accruedInterest);
        
        // Update pool state
        pool.totalBorrowed -= principalPortion;
        pool.availableLiquidity += repayAmount;
        
        // Add interest to reserves
        pool.reserves += interestPortion * pool.reserveFactor;
        pool.availableLiquidity -= interestPortion * pool.reserveFactor;
        
        this.updatePoolRates(loan.asset);
        
        // Transfer repayment from user
        await this.transferFrom(userId, loan.asset, repayAmount);
        
        // Check if loan is fully repaid
        if (loan.amount === 0 && loan.accruedInterest === 0) {
            // Return collateral
            await this.transferTo(userId, loan.collateralAsset, loan.collateralAmount);
            
            // Mark loan as repaid
            loan.status = 'repaid';
            loan.repaidTime = Date.now();
            
            // Remove from active borrows
            const userBorrows = this.borrows.get(userId);
            if (userBorrows) {
                userBorrows.delete(loanId);
            }
        }
        
        this.emit('repaid', {
            userId,
            loanId,
            amount: repayAmount,
            principalPortion,
            interestPortion,
            remainingDebt: loan.amount + loan.accruedInterest,
            timestamp: Date.now()
        });
        
        return {
            loanId,
            repaidAmount: repayAmount,
            remainingDebt: loan.amount + loan.accruedInterest,
            status: loan.status
        };
    }
    
    /**
     * Liquidate under-collateralized loan
     */
    async liquidate(loanId, liquidatorId) {
        const loan = this.loans.get(loanId);
        if (!loan || loan.status !== 'active') {
            throw new Error('Active loan not found');
        }
        
        // Check if loan is liquidatable
        const collateralRatio = await this.calculateCollateralRatio(loan);
        if (collateralRatio >= this.config.liquidationThreshold) {
            throw new Error('Loan is not liquidatable');
        }
        
        // Calculate liquidation amounts
        const currentDebt = this.calculateCurrentDebt(loan);
        const liquidationAmount = currentDebt;
        const collateralValue = await this.getAssetValue(loan.collateralAsset, loan.collateralAmount);
        const debtValue = await this.getAssetValue(loan.asset, currentDebt);
        
        // Calculate collateral to liquidator (with penalty discount)
        const collateralToLiquidator = loan.collateralAmount * 
            (1 - this.config.liquidationPenalty);
        const penaltyAmount = loan.collateralAmount * this.config.liquidationPenalty;
        
        // Check liquidator balance
        const liquidatorBalance = await this.getUserBalance(liquidatorId, loan.asset);
        if (liquidatorBalance < liquidationAmount) {
            throw new Error('Insufficient liquidator balance');
        }
        
        const pool = this.pools.get(loan.asset);
        
        // Transfer debt from liquidator to pool
        await this.transferFrom(liquidatorId, loan.asset, liquidationAmount);
        
        // Transfer collateral to liquidator
        await this.transferTo(liquidatorId, loan.collateralAsset, collateralToLiquidator);
        
        // Add penalty to reserves
        pool.reserves += penaltyAmount;
        
        // Update pool state
        pool.totalBorrowed -= loan.amount;
        pool.availableLiquidity += liquidationAmount;
        this.updatePoolRates(loan.asset);
        
        // Mark loan as liquidated
        loan.status = 'liquidated';
        loan.liquidatedTime = Date.now();
        loan.liquidatorId = liquidatorId;
        loan.liquidationAmount = liquidationAmount;
        
        // Remove from active borrows
        const userBorrows = this.borrows.get(loan.userId);
        if (userBorrows) {
            userBorrows.delete(loanId);
        }
        
        this.emit('liquidated', {
            loanId,
            borrowerId: loan.userId,
            liquidatorId,
            asset: loan.asset,
            debtAmount: liquidationAmount,
            collateralAsset: loan.collateralAsset,
            collateralAmount: collateralToLiquidator,
            penalty: penaltyAmount,
            timestamp: Date.now()
        });
        
        return {
            loanId,
            debtPaid: liquidationAmount,
            collateralReceived: collateralToLiquidator,
            profit: collateralValue - debtValue
        };
    }
    
    /**
     * Calculate dynamic interest rates
     */
    updatePoolRates(asset) {
        const pool = this.pools.get(asset);
        if (!pool) return;
        
        // Calculate utilization rate
        const totalSupply = pool.totalDeposited;
        if (totalSupply === 0) {
            pool.utilizationRate = 0;
            pool.borrowAPR = this.config.baseInterestRate;
            pool.supplyAPR = 0;
            return;
        }
        
        pool.utilizationRate = pool.totalBorrowed / totalSupply;
        
        // Interest rate model (kink model)
        const kink = this.config.utilizationTarget;
        const baseRate = this.config.baseInterestRate;
        const multiplier = 0.15; // 15% at kink
        const jumpMultiplier = 0.8; // 80% above kink
        
        let borrowRate;
        if (pool.utilizationRate <= kink) {
            // Below kink: linear increase
            borrowRate = baseRate + (pool.utilizationRate / kink) * multiplier;
        } else {
            // Above kink: steep increase
            const excessUtilization = pool.utilizationRate - kink;
            borrowRate = baseRate + multiplier + 
                (excessUtilization / (1 - kink)) * jumpMultiplier;
        }
        
        pool.borrowAPR = borrowRate;
        
        // Supply rate = Borrow rate * Utilization * (1 - Reserve Factor)
        pool.supplyAPR = borrowRate * pool.utilizationRate * 
            (1 - pool.reserveFactor);
        
        this.emit('rates-updated', {
            asset,
            utilizationRate: pool.utilizationRate,
            borrowAPR: pool.borrowAPR,
            supplyAPR: pool.supplyAPR
        });
    }
    
    /**
     * Calculate deposit shares
     */
    calculateDepositShares(asset, amount) {
        const pool = this.pools.get(asset);
        const totalShares = this.getTotalShares(asset);
        
        if (totalShares === 0 || pool.totalDeposited === 0) {
            return amount; // 1:1 for first deposit
        }
        
        // shares = amount * totalShares / totalDeposited
        return (amount * totalShares) / pool.totalDeposited;
    }
    
    /**
     * Calculate withdrawable amount
     */
    calculateWithdrawableAmount(userId, asset) {
        const userDeposits = this.deposits.get(userId);
        if (!userDeposits) return 0;
        
        const deposit = userDeposits.get(asset);
        if (!deposit) return 0;
        
        // Include accrued interest
        const pool = this.pools.get(asset);
        const totalShares = this.getTotalShares(asset);
        
        if (totalShares === 0) return deposit.amount;
        
        // amount = shares * totalDeposited / totalShares
        return (deposit.shares * pool.totalDeposited) / totalShares;
    }
    
    /**
     * Calculate current debt including interest
     */
    calculateCurrentDebt(loan) {
        // Update accrued interest
        const timePassed = Date.now() - loan.lastUpdateTime;
        const yearInMs = 365 * 24 * 60 * 60 * 1000;
        const timeRatio = timePassed / yearInMs;
        
        const interestAccrued = loan.amount * loan.borrowRate * timeRatio;
        loan.accruedInterest += interestAccrued;
        loan.lastUpdateTime = Date.now();
        
        return loan.amount + loan.accruedInterest;
    }
    
    /**
     * Calculate collateral ratio
     */
    async calculateCollateralRatio(loan) {
        const collateralValue = await this.getAssetValue(
            loan.collateralAsset, 
            loan.collateralAmount
        );
        const debtValue = await this.getAssetValue(
            loan.asset,
            this.calculateCurrentDebt(loan)
        );
        
        if (debtValue === 0) return Infinity;
        
        return collateralValue / debtValue;
    }
    
    /**
     * Get user's borrowing power
     */
    async getUserBorrowingPower(userId) {
        let totalCollateralValue = 0;
        let totalBorrowedValue = 0;
        
        // Calculate deposited collateral value
        const userDeposits = this.deposits.get(userId);
        if (userDeposits) {
            for (const [asset, deposit] of userDeposits) {
                const pool = this.pools.get(asset);
                if (pool && pool.collateralEnabled) {
                    const amount = this.calculateWithdrawableAmount(userId, asset);
                    const value = await this.getAssetValue(asset, amount);
                    totalCollateralValue += value * pool.maxLTV;
                }
            }
        }
        
        // Subtract current borrows
        const userBorrows = this.borrows.get(userId);
        if (userBorrows) {
            for (const [loanId, loan] of userBorrows) {
                if (loan.status === 'active') {
                    const debt = this.calculateCurrentDebt(loan);
                    const value = await this.getAssetValue(loan.asset, debt);
                    totalBorrowedValue += value;
                }
            }
        }
        
        return Math.max(0, totalCollateralValue - totalBorrowedValue);
    }
    
    /**
     * Get total shares for asset
     */
    getTotalShares(asset) {
        let totalShares = 0;
        
        for (const [userId, userDeposits] of this.deposits) {
            const deposit = userDeposits.get(asset);
            if (deposit) {
                totalShares += deposit.shares;
            }
        }
        
        return totalShares;
    }
    
    /**
     * Interest calculation loop
     */
    startInterestCalculation() {
        setInterval(() => {
            // Update all active loans
            for (const [loanId, loan] of this.loans) {
                if (loan.status === 'active') {
                    this.calculateCurrentDebt(loan);
                }
            }
            
            // Update pool rates
            for (const [asset, pool] of this.pools) {
                this.updatePoolRates(asset);
            }
        }, 60000); // Every minute
    }
    
    /**
     * Liquidation monitoring
     */
    startLiquidationMonitoring() {
        setInterval(async () => {
            for (const [loanId, loan] of this.loans) {
                if (loan.status === 'active') {
                    try {
                        const ratio = await this.calculateCollateralRatio(loan);
                        
                        if (ratio < this.config.liquidationThreshold) {
                            this.emit('loan-at-risk', {
                                loanId,
                                userId: loan.userId,
                                collateralRatio: ratio,
                                threshold: this.config.liquidationThreshold
                            });
                        }
                    } catch (error) {
                        this.logger.error(`Error checking loan ${loanId}: ${error.message}`);
                    }
                }
            }
        }, 10000); // Every 10 seconds
    }
    
    /**
     * Utilization monitoring
     */
    startUtilizationMonitoring() {
        setInterval(() => {
            for (const [asset, pool] of this.pools) {
                const utilization = pool.utilizationRate;
                
                if (utilization > 0.95) {
                    this.emit('high-utilization', {
                        asset,
                        utilization,
                        availableLiquidity: pool.availableLiquidity
                    });
                }
            }
        }, 30000); // Every 30 seconds
    }
    
    /**
     * Get pool statistics
     */
    getPoolStats(asset) {
        const pool = this.pools.get(asset);
        if (!pool) return null;
        
        return {
            asset: pool.asset,
            totalDeposited: pool.totalDeposited,
            totalBorrowed: pool.totalBorrowed,
            availableLiquidity: pool.availableLiquidity,
            utilizationRate: pool.utilizationRate,
            supplyAPR: pool.supplyAPR,
            borrowAPR: pool.borrowAPR,
            reserves: pool.reserves
        };
    }
    
    /**
     * Get user position
     */
    getUserPosition(userId) {
        const position = {
            deposits: [],
            borrows: [],
            totalDepositedValue: 0,
            totalBorrowedValue: 0,
            borrowingPower: 0,
            healthFactor: 0
        };
        
        // Get deposits
        const userDeposits = this.deposits.get(userId);
        if (userDeposits) {
            for (const [asset, deposit] of userDeposits) {
                const amount = this.calculateWithdrawableAmount(userId, asset);
                position.deposits.push({
                    asset,
                    amount,
                    value: 0 // Would calculate value
                });
            }
        }
        
        // Get borrows
        const userBorrows = this.borrows.get(userId);
        if (userBorrows) {
            for (const [loanId, loan] of userBorrows) {
                if (loan.status === 'active') {
                    const debt = this.calculateCurrentDebt(loan);
                    position.borrows.push({
                        loanId,
                        asset: loan.asset,
                        amount: debt,
                        collateralAsset: loan.collateralAsset,
                        collateralAmount: loan.collateralAmount,
                        apy: loan.borrowRate
                    });
                }
            }
        }
        
        return position;
    }
    
    /**
     * Helper functions
     */
    generateLoanId() {
        return `LOAN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    async getAssetValue(asset, amount) {
        if (!this.priceOracle) {
            // Mock prices
            const prices = {
                'BTC': 40000,
                'ETH': 2500,
                'USDT': 1,
                'USDC': 1,
                'SOL': 100
            };
            return amount * (prices[asset] || 0);
        }
        
        const price = await this.priceOracle.getPrice(asset);
        return amount * price;
    }
    
    async getUserBalance(userId, asset) {
        // This would integrate with wallet system
        return 100000; // Mock balance
    }
    
    async transferFrom(userId, asset, amount) {
        // This would integrate with wallet system
        this.logger.info(`Transferred ${amount} ${asset} from user ${userId}`);
    }
    
    async transferTo(userId, asset, amount) {
        // This would integrate with wallet system
        this.logger.info(`Transferred ${amount} ${asset} to user ${userId}`);
    }
    
    /**
     * Stop lending pool
     */
    async stop() {
        if (!this.isRunning) return;
        
        this.logger.info('Stopping lending pool...');
        
        // Clear intervals
        // (Would need to store interval IDs)
        
        this.isRunning = false;
        this.logger.info('Lending pool stopped');
    }
}

export default LendingPool;