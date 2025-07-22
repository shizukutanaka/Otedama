/**
 * NFT Lending Platform for Otedama
 * Collateralized lending using NFTs
 * 
 * Design principles:
 * - Efficient NFT valuation (Carmack)
 * - Clean lending protocols (Martin)
 * - Simple collateral management (Pike)
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import crypto from 'crypto';

const logger = getLogger('NftLending');

export class NFTLendingPlatform extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Loan parameters
            maxLoanToValue: config.maxLoanToValue || 0.5, // 50% LTV
            minLoanDuration: config.minLoanDuration || 86400000, // 1 day
            maxLoanDuration: config.maxLoanDuration || 2592000000, // 30 days
            defaultLoanDuration: config.defaultLoanDuration || 604800000, // 7 days
            
            // Interest rates
            baseInterestRate: config.baseInterestRate || 0.1, // 10% APR
            maxInterestRate: config.maxInterestRate || 0.5, // 50% APR
            latePaymentPenalty: config.latePaymentPenalty || 0.02, // 2% per day
            
            // Collateral settings
            liquidationThreshold: config.liquidationThreshold || 0.8, // 80% of loan value
            liquidationPenalty: config.liquidationPenalty || 0.1, // 10% penalty
            gracePeriod: config.gracePeriod || 86400000, // 24 hours
            
            // Valuation settings
            priceValidityPeriod: config.priceValidityPeriod || 3600000, // 1 hour
            minOracles: config.minOracles || 2,
            maxPriceDeviation: config.maxPriceDeviation || 0.1, // 10%
            
            // Platform fees
            originationFee: config.originationFee || 0.01, // 1%
            platformFeeRate: config.platformFeeRate || 0.02, // 2% of interest
            
            // Limits
            maxLoansPerUser: config.maxLoansPerUser || 10,
            maxActiveLoans: config.maxActiveLoans || 1000,
            minLoanAmount: config.minLoanAmount || 100, // $100
            maxLoanAmount: config.maxLoanAmount || 1000000, // $1M
            
            ...config
        };
        
        // Loan registry
        this.loans = new Map(); // loanId -> Loan
        this.userLoans = new Map(); // userId -> Set<loanId>
        this.collateralLoans = new Map(); // nftId -> loanId
        
        // Lending pools
        this.lendingPools = new Map(); // poolId -> LendingPool
        this.userDeposits = new Map(); // userId -> Map<poolId, Deposit>
        
        // NFT valuation
        this.nftPrices = new Map(); // nftId -> PriceData
        this.collections = new Map(); // collectionId -> CollectionData
        this.priceOracles = new Map(); // oracleId -> Oracle
        
        // Liquidation queue
        this.liquidationQueue = [];
        this.auctionHouse = new Map(); // auctionId -> Auction
        
        // Statistics
        this.stats = {
            totalLoansCreated: 0,
            activeLoans: 0,
            totalVolume: 0,
            totalInterestPaid: 0,
            totalLiquidations: 0,
            defaultedLoans: 0,
            averageLTV: 0,
            totalTVL: 0
        };
        
        // Start monitoring
        this.startMonitoring();
    }
    
    /**
     * Create lending pool
     */
    createLendingPool(params) {
        const {
            name,
            asset = 'USDT',
            minDeposit = 100,
            collections = [], // Supported NFT collections
            riskParameters = {}
        } = params;
        
        const poolId = this.generatePoolId();
        const pool = {
            id: poolId,
            name,
            asset,
            minDeposit,
            collections,
            
            // Pool metrics
            totalDeposited: 0,
            totalBorrowed: 0,
            availableLiquidity: 0,
            
            // Interest model
            baseRate: riskParameters.baseRate || this.config.baseInterestRate,
            utilizationOptimal: riskParameters.utilizationOptimal || 0.8,
            rateSlope1: riskParameters.rateSlope1 || 0.1,
            rateSlope2: riskParameters.rateSlope2 || 0.5,
            
            // Risk parameters
            maxLTV: riskParameters.maxLTV || this.config.maxLoanToValue,
            liquidationThreshold: riskParameters.liquidationThreshold || this.config.liquidationThreshold,
            
            // Status
            status: 'active',
            createdAt: Date.now()
        };
        
        this.lendingPools.set(poolId, pool);
        
        logger.info(`Lending pool created: ${poolId} - ${name}`);
        
        this.emit('pool:created', {
            pool,
            timestamp: Date.now()
        });
        
        return pool;
    }
    
    /**
     * Deposit liquidity to pool
     */
    async depositToPool(params) {
        const {
            userId,
            poolId,
            amount
        } = params;
        
        const pool = this.lendingPools.get(poolId);
        if (!pool) {
            throw new Error('Pool not found');
        }
        
        if (amount < pool.minDeposit) {
            throw new Error(`Minimum deposit is ${pool.minDeposit}`);
        }
        
        // Create or update deposit
        if (!this.userDeposits.has(userId)) {
            this.userDeposits.set(userId, new Map());
        }
        
        const userPools = this.userDeposits.get(userId);
        const existingDeposit = userPools.get(poolId) || {
            amount: 0,
            shares: 0,
            rewards: 0,
            depositedAt: Date.now()
        };
        
        // Calculate shares (simple 1:1 for initial implementation)
        const shares = amount;
        
        existingDeposit.amount += amount;
        existingDeposit.shares += shares;
        existingDeposit.lastUpdate = Date.now();
        
        userPools.set(poolId, existingDeposit);
        
        // Update pool
        pool.totalDeposited += amount;
        pool.availableLiquidity += amount;
        
        // Update TVL
        this.stats.totalTVL += amount;
        
        logger.info(`Deposit to pool: ${userId} deposited ${amount} to ${poolId}`);
        
        this.emit('pool:deposit', {
            userId,
            poolId,
            amount,
            shares,
            timestamp: Date.now()
        });
        
        return {
            deposit: existingDeposit,
            pool
        };
    }
    
    /**
     * Create NFT-backed loan
     */
    async createLoan(params) {
        const {
            borrowerId,
            nftId,
            collectionId,
            loanAmount,
            duration = this.config.defaultLoanDuration,
            poolId
        } = params;
        
        // Validate loan parameters
        if (loanAmount < this.config.minLoanAmount || loanAmount > this.config.maxLoanAmount) {
            throw new Error('Invalid loan amount');
        }
        
        if (duration < this.config.minLoanDuration || duration > this.config.maxLoanDuration) {
            throw new Error('Invalid loan duration');
        }
        
        // Check if NFT is already collateralized
        if (this.collateralLoans.has(nftId)) {
            throw new Error('NFT already used as collateral');
        }
        
        // Get NFT valuation
        const valuation = await this.getCollateralValue(nftId, collectionId);
        const maxLoanAmount = valuation * this.config.maxLoanToValue;
        
        if (loanAmount > maxLoanAmount) {
            throw new Error(`Maximum loan amount is ${maxLoanAmount}`);
        }
        
        // Check pool liquidity
        const pool = this.lendingPools.get(poolId);
        if (!pool) {
            throw new Error('Pool not found');
        }
        
        if (pool.availableLiquidity < loanAmount) {
            throw new Error('Insufficient liquidity in pool');
        }
        
        // Calculate interest rate
        const interestRate = this.calculateInterestRate(pool);
        const totalInterest = loanAmount * interestRate * (duration / 365 / 24 / 60 / 60 / 1000);
        const originationFee = loanAmount * this.config.originationFee;
        
        // Create loan
        const loanId = this.generateLoanId();
        const loan = {
            id: loanId,
            borrowerId,
            poolId,
            
            // Collateral
            collateral: {
                nftId,
                collectionId,
                valuation,
                lastValuationTime: Date.now()
            },
            
            // Loan terms
            principal: loanAmount,
            interestRate,
            duration,
            startTime: Date.now(),
            maturityTime: Date.now() + duration,
            
            // Amounts
            totalInterest,
            originationFee,
            totalDue: loanAmount + totalInterest + originationFee,
            amountPaid: 0,
            
            // Status
            status: 'active',
            healthFactor: valuation / loanAmount,
            lastPaymentTime: Date.now(),
            
            // History
            payments: [],
            valuationHistory: [{
                value: valuation,
                timestamp: Date.now()
            }]
        };
        
        // Store loan
        this.loans.set(loanId, loan);
        
        // Update user loans
        if (!this.userLoans.has(borrowerId)) {
            this.userLoans.set(borrowerId, new Set());
        }
        this.userLoans.get(borrowerId).add(loanId);
        
        // Lock collateral
        this.collateralLoans.set(nftId, loanId);
        
        // Update pool
        pool.totalBorrowed += loanAmount;
        pool.availableLiquidity -= loanAmount;
        
        // Update stats
        this.stats.totalLoansCreated++;
        this.stats.activeLoans++;
        this.stats.totalVolume += loanAmount;
        
        logger.info(`Loan created: ${loanId}, amount: ${loanAmount}, collateral: ${nftId}`);
        
        this.emit('loan:created', {
            loan,
            timestamp: Date.now()
        });
        
        return loan;
    }
    
    /**
     * Make loan payment
     */
    async makePayment(params) {
        const {
            borrowerId,
            loanId,
            amount
        } = params;
        
        const loan = this.loans.get(loanId);
        if (!loan) {
            throw new Error('Loan not found');
        }
        
        if (loan.borrowerId !== borrowerId) {
            throw new Error('Unauthorized');
        }
        
        if (loan.status !== 'active') {
            throw new Error('Loan is not active');
        }
        
        const remainingDue = loan.totalDue - loan.amountPaid;
        const paymentAmount = Math.min(amount, remainingDue);
        
        // Record payment
        const payment = {
            amount: paymentAmount,
            timestamp: Date.now(),
            type: 'regular'
        };
        
        loan.payments.push(payment);
        loan.amountPaid += paymentAmount;
        loan.lastPaymentTime = Date.now();
        
        // Distribute payment to pool
        const pool = this.lendingPools.get(loan.poolId);
        if (pool) {
            pool.availableLiquidity += paymentAmount;
            
            // Calculate platform fee
            const interestPortion = paymentAmount * (loan.totalInterest / loan.totalDue);
            const platformFee = interestPortion * this.config.platformFeeRate;
            
            // Distribute to depositors (simplified)
            const depositorShare = interestPortion - platformFee;
            pool.totalInterestEarned = (pool.totalInterestEarned || 0) + depositorShare;
        }
        
        // Check if loan is fully paid
        if (loan.amountPaid >= loan.totalDue) {
            loan.status = 'repaid';
            loan.repaidAt = Date.now();
            
            // Release collateral
            this.collateralLoans.delete(loan.collateral.nftId);
            
            // Update stats
            this.stats.activeLoans--;
            this.stats.totalInterestPaid += loan.totalInterest;
            
            logger.info(`Loan repaid: ${loanId}`);
            
            this.emit('loan:repaid', {
                loan,
                timestamp: Date.now()
            });
        }
        
        return {
            payment,
            remainingDue: loan.totalDue - loan.amountPaid,
            loan
        };
    }
    
    /**
     * Liquidate defaulted loan
     */
    async liquidateLoan(loanId) {
        const loan = this.loans.get(loanId);
        if (!loan) {
            throw new Error('Loan not found');
        }
        
        if (loan.status !== 'active') {
            throw new Error('Loan is not active');
        }
        
        // Check if loan is liquidatable
        const isDefaulted = Date.now() > loan.maturityTime + this.config.gracePeriod;
        const isUnderCollateralized = loan.healthFactor < this.config.liquidationThreshold;
        
        if (!isDefaulted && !isUnderCollateralized) {
            throw new Error('Loan is not liquidatable');
        }
        
        loan.status = 'liquidating';
        loan.liquidationStarted = Date.now();
        
        // Create auction
        const auctionId = this.generateAuctionId();
        const auction = {
            id: auctionId,
            loanId,
            nft: loan.collateral,
            
            // Auction parameters
            startingPrice: loan.totalDue - loan.amountPaid,
            reservePrice: (loan.totalDue - loan.amountPaid) * 0.8, // 80% of debt
            currentBid: null,
            
            // Timing
            startTime: Date.now(),
            endTime: Date.now() + 86400000, // 24 hour auction
            
            // Participants
            highestBidder: null,
            bids: [],
            
            status: 'active'
        };
        
        this.auctionHouse.set(auctionId, auction);
        
        // Update stats
        this.stats.totalLiquidations++;
        
        logger.info(`Loan liquidation started: ${loanId}, auction: ${auctionId}`);
        
        this.emit('liquidation:started', {
            loan,
            auction,
            timestamp: Date.now()
        });
        
        return auction;
    }
    
    /**
     * Place bid on liquidation auction
     */
    async placeBid(params) {
        const {
            bidderId,
            auctionId,
            amount
        } = params;
        
        const auction = this.auctionHouse.get(auctionId);
        if (!auction) {
            throw new Error('Auction not found');
        }
        
        if (auction.status !== 'active') {
            throw new Error('Auction is not active');
        }
        
        if (Date.now() > auction.endTime) {
            // Finalize auction
            await this.finalizeAuction(auctionId);
            throw new Error('Auction has ended');
        }
        
        // Validate bid
        const minBid = auction.currentBid ? auction.currentBid.amount * 1.01 : auction.reservePrice;
        if (amount < minBid) {
            throw new Error(`Minimum bid is ${minBid}`);
        }
        
        // Record bid
        const bid = {
            bidderId,
            amount,
            timestamp: Date.now()
        };
        
        auction.bids.push(bid);
        auction.currentBid = bid;
        auction.highestBidder = bidderId;
        
        // Extend auction if bid in last 5 minutes
        if (auction.endTime - Date.now() < 300000) {
            auction.endTime += 300000; // Extend by 5 minutes
        }
        
        logger.info(`Bid placed on auction ${auctionId}: ${amount} by ${bidderId}`);
        
        this.emit('auction:bid', {
            auction,
            bid,
            timestamp: Date.now()
        });
        
        return auction;
    }
    
    /**
     * Finalize auction
     */
    async finalizeAuction(auctionId) {
        const auction = this.auctionHouse.get(auctionId);
        if (!auction) {
            throw new Error('Auction not found');
        }
        
        if (auction.status !== 'active') {
            throw new Error('Auction already finalized');
        }
        
        auction.status = 'completed';
        
        const loan = this.loans.get(auction.loanId);
        if (!loan) {
            throw new Error('Associated loan not found');
        }
        
        if (auction.currentBid && auction.currentBid.amount >= auction.reservePrice) {
            // Successful auction
            const proceeds = auction.currentBid.amount;
            const debt = loan.totalDue - loan.amountPaid;
            const liquidationPenalty = debt * this.config.liquidationPenalty;
            
            // Pay off debt
            loan.amountPaid = loan.totalDue;
            loan.status = 'liquidated';
            loan.liquidatedAt = Date.now();
            
            // Return pool funds
            const pool = this.lendingPools.get(loan.poolId);
            if (pool) {
                pool.availableLiquidity += Math.min(proceeds, debt + liquidationPenalty);
                pool.totalBorrowed -= loan.principal;
            }
            
            // Transfer NFT to winner
            this.collateralLoans.delete(loan.collateral.nftId);
            
            // Any excess goes to borrower
            const excess = proceeds - debt - liquidationPenalty;
            if (excess > 0) {
                // Credit to borrower account
                logger.info(`Liquidation excess ${excess} credited to borrower ${loan.borrowerId}`);
            }
            
            this.emit('auction:completed', {
                auction,
                winner: auction.highestBidder,
                price: auction.currentBid.amount,
                timestamp: Date.now()
            });
            
        } else {
            // Failed auction - NFT goes to pool
            loan.status = 'defaulted';
            loan.defaultedAt = Date.now();
            
            this.stats.defaultedLoans++;
            
            this.emit('auction:failed', {
                auction,
                loan,
                timestamp: Date.now()
            });
        }
        
        // Update stats
        this.stats.activeLoans--;
        
        return auction;
    }
    
    /**
     * Get collateral value
     */
    async getCollateralValue(nftId, collectionId) {
        // Check cached price
        const cachedPrice = this.nftPrices.get(nftId);
        if (cachedPrice && Date.now() - cachedPrice.timestamp < this.config.priceValidityPeriod) {
            return cachedPrice.value;
        }
        
        // Get collection floor price
        const collection = this.collections.get(collectionId);
        if (!collection) {
            throw new Error('Collection not supported');
        }
        
        // Aggregate prices from oracles
        const prices = [];
        for (const [oracleId, oracle] of this.priceOracles) {
            try {
                const price = await oracle.getPrice(nftId, collectionId);
                if (price && price.confidence > 0.8) {
                    prices.push(price.value);
                }
            } catch (error) {
                logger.error(`Oracle ${oracleId} failed:`, error);
            }
        }
        
        if (prices.length < this.config.minOracles) {
            // Fall back to collection floor price
            return collection.floorPrice * 0.9; // 90% of floor
        }
        
        // Calculate median price
        prices.sort((a, b) => a - b);
        const medianPrice = prices[Math.floor(prices.length / 2)];
        
        // Check for price manipulation
        const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length;
        if (Math.abs(medianPrice - avgPrice) / avgPrice > this.config.maxPriceDeviation) {
            logger.warn(`Price deviation detected for NFT ${nftId}`);
            return Math.min(medianPrice, avgPrice);
        }
        
        // Cache price
        this.nftPrices.set(nftId, {
            value: medianPrice,
            timestamp: Date.now(),
            sources: prices.length
        });
        
        return medianPrice;
    }
    
    /**
     * Calculate interest rate based on utilization
     */
    calculateInterestRate(pool) {
        const utilization = pool.totalBorrowed / (pool.totalBorrowed + pool.availableLiquidity);
        
        if (utilization <= pool.utilizationOptimal) {
            // Below optimal utilization
            return pool.baseRate + (utilization / pool.utilizationOptimal) * pool.rateSlope1;
        } else {
            // Above optimal utilization
            const excessUtilization = utilization - pool.utilizationOptimal;
            return pool.baseRate + pool.rateSlope1 + 
                   (excessUtilization / (1 - pool.utilizationOptimal)) * pool.rateSlope2;
        }
    }
    
    /**
     * Update loan health factors
     */
    async updateHealthFactors() {
        for (const [loanId, loan] of this.loans) {
            if (loan.status !== 'active') continue;
            
            try {
                // Get current collateral value
                const currentValue = await this.getCollateralValue(
                    loan.collateral.nftId,
                    loan.collateral.collectionId
                );
                
                // Update valuation
                loan.collateral.valuation = currentValue;
                loan.collateral.lastValuationTime = Date.now();
                
                // Calculate health factor
                const outstandingDebt = loan.totalDue - loan.amountPaid;
                loan.healthFactor = currentValue / outstandingDebt;
                
                // Record valuation history
                loan.valuationHistory.push({
                    value: currentValue,
                    timestamp: Date.now()
                });
                
                // Keep only last 30 days
                const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
                loan.valuationHistory = loan.valuationHistory.filter(v => v.timestamp > cutoff);
                
                // Check if loan needs liquidation
                if (loan.healthFactor < this.config.liquidationThreshold) {
                    this.liquidationQueue.push(loanId);
                }
                
            } catch (error) {
                logger.error(`Failed to update health factor for loan ${loanId}:`, error);
            }
        }
    }
    
    /**
     * Process liquidation queue
     */
    async processLiquidationQueue() {
        while (this.liquidationQueue.length > 0) {
            const loanId = this.liquidationQueue.shift();
            
            try {
                await this.liquidateLoan(loanId);
            } catch (error) {
                logger.error(`Failed to liquidate loan ${loanId}:`, error);
            }
        }
    }
    
    /**
     * Helper methods
     */
    
    generateLoanId() {
        return `LOAN${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
    
    generatePoolId() {
        return `POOL${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
    
    generateAuctionId() {
        return `AUC${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Register price oracle
     */
    registerOracle(oracleId, oracle) {
        // Validate oracle interface
        if (typeof oracle.getPrice !== 'function') {
            throw new Error('Oracle must implement getPrice method');
        }
        
        this.priceOracles.set(oracleId, oracle);
        logger.info(`Price oracle registered: ${oracleId}`);
    }
    
    /**
     * Register NFT collection
     */
    registerCollection(collectionId, data) {
        this.collections.set(collectionId, {
            id: collectionId,
            name: data.name,
            floorPrice: data.floorPrice || 0,
            verified: data.verified || false,
            riskScore: data.riskScore || 50,
            supportedPools: data.supportedPools || [],
            metadata: data.metadata || {}
        });
        
        logger.info(`NFT collection registered: ${collectionId}`);
    }
    
    /**
     * Start monitoring
     */
    startMonitoring() {
        // Update health factors periodically
        this.healthCheckInterval = setInterval(async () => {
            await this.updateHealthFactors();
            await this.processLiquidationQueue();
        }, 300000); // Every 5 minutes
        
        // Check for expired auctions
        this.auctionCheckInterval = setInterval(async () => {
            for (const [auctionId, auction] of this.auctionHouse) {
                if (auction.status === 'active' && Date.now() > auction.endTime) {
                    await this.finalizeAuction(auctionId);
                }
            }
        }, 60000); // Every minute
        
        // Update stats
        this.statsInterval = setInterval(() => {
            this.updateStats();
        }, 10000); // Every 10 seconds
        
        logger.info('NFT lending monitoring started');
    }
    
    updateStats() {
        let totalBorrowed = 0;
        let totalCollateralValue = 0;
        let activeLoanCount = 0;
        
        for (const loan of this.loans.values()) {
            if (loan.status === 'active') {
                totalBorrowed += loan.totalDue - loan.amountPaid;
                totalCollateralValue += loan.collateral.valuation;
                activeLoanCount++;
            }
        }
        
        this.stats.activeLoans = activeLoanCount;
        this.stats.averageLTV = activeLoanCount > 0 ? totalBorrowed / totalCollateralValue : 0;
        
        // Calculate TVL
        let tvl = 0;
        for (const pool of this.lendingPools.values()) {
            tvl += pool.totalDeposited;
        }
        this.stats.totalTVL = tvl;
    }
    
    /**
     * Stop monitoring
     */
    stop() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        
        if (this.auctionCheckInterval) {
            clearInterval(this.auctionCheckInterval);
        }
        
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
        }
        
        logger.info('NFT lending monitoring stopped');
    }
    
    /**
     * Get loan details
     */
    getLoan(loanId) {
        return this.loans.get(loanId);
    }
    
    /**
     * Get user loans
     */
    getUserLoans(userId) {
        const loanIds = this.userLoans.get(userId);
        if (!loanIds) return [];
        
        return Array.from(loanIds)
            .map(id => this.loans.get(id))
            .filter(loan => loan !== undefined);
    }
    
    /**
     * Get pool info
     */
    getPool(poolId) {
        const pool = this.lendingPools.get(poolId);
        if (!pool) return null;
        
        const utilization = pool.totalBorrowed / (pool.totalBorrowed + pool.availableLiquidity);
        const currentRate = this.calculateInterestRate(pool);
        
        return {
            ...pool,
            utilization,
            currentRate,
            depositorAPY: currentRate * utilization * (1 - this.config.platformFeeRate)
        };
    }
    
    /**
     * Get active auctions
     */
    getActiveAuctions() {
        return Array.from(this.auctionHouse.values())
            .filter(auction => auction.status === 'active');
    }
    
    /**
     * Get platform statistics
     */
    getStats() {
        return {
            ...this.stats,
            pools: this.lendingPools.size,
            auctions: this.auctionHouse.size,
            collections: this.collections.size,
            oracles: this.priceOracles.size,
            timestamp: Date.now()
        };
    }
}

export default NFTLendingPlatform;