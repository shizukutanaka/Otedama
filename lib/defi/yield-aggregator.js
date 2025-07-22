/**
 * Yield Aggregator for Otedama DeFi
 * Automatically optimizes yield across multiple protocols
 * 
 * Design principles:
 * - Efficient yield optimization (Carmack)
 * - Clean strategy management (Martin)
 * - Simple aggregation logic (Pike)
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

const logger = getLogger('YieldAggregator');

export class YieldAggregator extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Strategy settings
            minYieldDifference: config.minYieldDifference || 0.005, // 0.5% minimum difference
            rebalanceThreshold: config.rebalanceThreshold || 0.01, // 1% threshold
            maxSlippage: config.maxSlippage || 0.005, // 0.5% max slippage
            
            // Risk settings
            maxAllocationPerProtocol: config.maxAllocationPerProtocol || 0.4, // 40% max
            minAllocationPerProtocol: config.minAllocationPerProtocol || 0.05, // 5% min
            riskScoreThreshold: config.riskScoreThreshold || 80, // 0-100 scale
            
            // Optimization settings
            optimizationInterval: config.optimizationInterval || 3600000, // 1 hour
            emergencyRebalanceThreshold: config.emergencyRebalanceThreshold || 0.05, // 5%
            
            // Gas optimization
            minRebalanceValue: config.minRebalanceValue || 1000, // $1000 minimum
            gasBuffer: config.gasBuffer || 1.2, // 20% gas buffer
            
            // Compound settings
            autoCompound: config.autoCompound !== false,
            compoundThreshold: config.compoundThreshold || 100, // $100 minimum
            compoundInterval: config.compoundInterval || 86400000, // 24 hours
            
            ...config
        };
        
        // Protocol registry
        this.protocols = new Map(); // protocolId -> ProtocolAdapter
        this.strategies = new Map(); // strategyId -> Strategy
        
        // User positions
        this.userPositions = new Map(); // userId -> YieldPosition[]
        this.userStrategies = new Map(); // userId -> activeStrategyId
        
        // Yield data
        this.yieldRates = new Map(); // protocolId -> YieldInfo
        this.historicalYields = new Map(); // protocolId -> YieldHistory[]
        
        // Risk tracking
        this.protocolRisks = new Map(); // protocolId -> RiskScore
        this.incidentHistory = new Map(); // protocolId -> Incident[]
        
        // Statistics
        this.stats = {
            totalValueLocked: 0,
            totalYieldEarned: 0,
            totalRebalances: 0,
            totalCompounds: 0,
            averageAPY: 0,
            activeStrategies: 0,
            activeUsers: 0
        };
        
        // Start optimization loop
        this.startOptimization();
    }
    
    /**
     * Register a yield protocol adapter
     */
    registerProtocol(protocolId, adapter) {
        if (this.protocols.has(protocolId)) {
            throw new Error(`Protocol ${protocolId} already registered`);
        }
        
        // Validate adapter interface
        const requiredMethods = ['getYieldRate', 'deposit', 'withdraw', 'getBalance', 'compound'];
        for (const method of requiredMethods) {
            if (typeof adapter[method] !== 'function') {
                throw new Error(`Protocol adapter missing required method: ${method}`);
            }
        }
        
        this.protocols.set(protocolId, adapter);
        
        // Initialize risk score
        this.protocolRisks.set(protocolId, {
            score: 50, // Default neutral score
            factors: {
                tvl: 50,
                age: 50,
                audits: 50,
                incidents: 100,
                volatility: 50
            },
            lastUpdate: Date.now()
        });
        
        logger.info(`Protocol registered: ${protocolId}`);
        
        // Fetch initial yield rate
        this.updateYieldRate(protocolId);
    }
    
    /**
     * Create a yield optimization strategy
     */
    createStrategy(params) {
        const {
            name,
            description,
            protocols,
            allocation,
            riskLevel = 'medium',
            autoRebalance = true,
            autoCompound = true
        } = params;
        
        // Validate protocols
        for (const protocolId of protocols) {
            if (!this.protocols.has(protocolId)) {
                throw new Error(`Unknown protocol: ${protocolId}`);
            }
        }
        
        // Validate allocation
        const totalAllocation = Object.values(allocation).reduce((sum, a) => sum + a, 0);
        if (Math.abs(totalAllocation - 1) > 0.001) {
            throw new Error('Allocation must sum to 100%');
        }
        
        const strategyId = this.generateStrategyId();
        const strategy = {
            id: strategyId,
            name,
            description,
            protocols,
            allocation,
            riskLevel,
            autoRebalance,
            autoCompound,
            createdAt: Date.now(),
            lastRebalance: Date.now(),
            performance: {
                totalReturn: 0,
                avgAPY: 0,
                volatility: 0
            }
        };
        
        this.strategies.set(strategyId, strategy);
        this.stats.activeStrategies++;
        
        logger.info(`Strategy created: ${strategyId} - ${name}`);
        
        this.emit('strategy:created', {
            strategy,
            timestamp: Date.now()
        });
        
        return strategy;
    }
    
    /**
     * Deposit funds using a strategy
     */
    async deposit(params) {
        const {
            userId,
            strategyId,
            amount,
            asset = 'USDT'
        } = params;
        
        const strategy = this.strategies.get(strategyId);
        if (!strategy) {
            throw new Error('Strategy not found');
        }
        
        // Create position
        const positionId = this.generatePositionId();
        const position = {
            id: positionId,
            userId,
            strategyId,
            asset,
            initialAmount: amount,
            currentValue: amount,
            deposits: [{ amount, timestamp: Date.now() }],
            withdrawals: [],
            yields: [],
            lastUpdate: Date.now(),
            status: 'active'
        };
        
        // Allocate funds according to strategy
        const allocations = [];
        for (const protocolId of strategy.protocols) {
            const allocationAmount = amount * strategy.allocation[protocolId];
            if (allocationAmount > 0) {
                allocations.push({
                    protocolId,
                    amount: allocationAmount
                });
            }
        }
        
        // Execute deposits
        const results = await Promise.all(
            allocations.map(async ({ protocolId, amount }) => {
                try {
                    const adapter = this.protocols.get(protocolId);
                    const result = await adapter.deposit({
                        userId,
                        amount,
                        asset
                    });
                    
                    return {
                        protocolId,
                        success: true,
                        amount,
                        receipt: result
                    };
                } catch (error) {
                    logger.error(`Deposit failed for ${protocolId}:`, error);
                    return {
                        protocolId,
                        success: false,
                        amount,
                        error: error.message
                    };
                }
            })
        );
        
        // Record successful deposits
        position.allocations = results.filter(r => r.success);
        
        // Store position
        if (!this.userPositions.has(userId)) {
            this.userPositions.set(userId, []);
            this.stats.activeUsers++;
        }
        this.userPositions.get(userId).push(position);
        
        // Update user strategy
        this.userStrategies.set(userId, strategyId);
        
        // Update stats
        this.stats.totalValueLocked += amount;
        
        logger.info(`Deposit completed: ${positionId}, amount: ${amount} ${asset}`);
        
        this.emit('deposit:completed', {
            position,
            results,
            timestamp: Date.now()
        });
        
        return {
            positionId,
            allocations: results,
            totalDeposited: results.filter(r => r.success).reduce((sum, r) => sum + r.amount, 0)
        };
    }
    
    /**
     * Withdraw funds from position
     */
    async withdraw(params) {
        const {
            userId,
            positionId,
            amount, // Optional, withdraws all if not specified
            asset = 'USDT'
        } = params;
        
        const userPositions = this.userPositions.get(userId);
        if (!userPositions) {
            throw new Error('No positions found');
        }
        
        const position = userPositions.find(p => p.id === positionId);
        if (!position) {
            throw new Error('Position not found');
        }
        
        // Update position value
        await this.updatePositionValue(position);
        
        const withdrawAmount = amount || position.currentValue;
        if (withdrawAmount > position.currentValue) {
            throw new Error('Insufficient balance');
        }
        
        // Calculate proportional withdrawals
        const totalAllocated = position.allocations.reduce((sum, a) => sum + a.amount, 0);
        const withdrawals = position.allocations.map(allocation => ({
            protocolId: allocation.protocolId,
            amount: (allocation.amount / totalAllocated) * withdrawAmount
        }));
        
        // Execute withdrawals
        const results = await Promise.all(
            withdrawals.map(async ({ protocolId, amount }) => {
                try {
                    const adapter = this.protocols.get(protocolId);
                    const result = await adapter.withdraw({
                        userId,
                        amount,
                        asset
                    });
                    
                    return {
                        protocolId,
                        success: true,
                        amount: result.amount,
                        receipt: result
                    };
                } catch (error) {
                    logger.error(`Withdrawal failed for ${protocolId}:`, error);
                    return {
                        protocolId,
                        success: false,
                        amount: 0,
                        error: error.message
                    };
                }
            })
        );
        
        // Record withdrawal
        const totalWithdrawn = results.filter(r => r.success).reduce((sum, r) => sum + r.amount, 0);
        position.withdrawals.push({
            amount: totalWithdrawn,
            timestamp: Date.now()
        });
        
        // Update position
        position.currentValue -= totalWithdrawn;
        if (position.currentValue < 1) {
            position.status = 'closed';
        }
        
        // Update stats
        this.stats.totalValueLocked -= totalWithdrawn;
        
        logger.info(`Withdrawal completed: ${positionId}, amount: ${totalWithdrawn} ${asset}`);
        
        this.emit('withdrawal:completed', {
            positionId,
            userId,
            results,
            totalWithdrawn,
            timestamp: Date.now()
        });
        
        return {
            results,
            totalWithdrawn,
            remainingValue: position.currentValue
        };
    }
    
    /**
     * Rebalance position to optimal allocation
     */
    async rebalancePosition(position, force = false) {
        const strategy = this.strategies.get(position.strategyId);
        if (!strategy || !strategy.autoRebalance) return;
        
        // Update current allocations
        const currentAllocations = await this.getCurrentAllocations(position);
        const totalValue = currentAllocations.reduce((sum, a) => sum + a.value, 0);
        
        // Check if rebalance is needed
        const rebalanceNeeded = this.checkRebalanceNeeded(
            currentAllocations,
            strategy.allocation,
            totalValue,
            force
        );
        
        if (!rebalanceNeeded && !force) {
            return { rebalanced: false, reason: 'Within threshold' };
        }
        
        // Calculate target allocations
        const targetAllocations = Object.entries(strategy.allocation).map(([protocolId, targetPct]) => ({
            protocolId,
            targetValue: totalValue * targetPct,
            currentValue: currentAllocations.find(a => a.protocolId === protocolId)?.value || 0
        }));
        
        // Generate rebalance transactions
        const transactions = this.generateRebalanceTransactions(targetAllocations);
        
        // Check if rebalance is worth the gas
        if (!force && !this.isRebalanceWorthGas(transactions, totalValue)) {
            return { rebalanced: false, reason: 'Not worth gas costs' };
        }
        
        // Execute rebalance
        const results = await this.executeRebalance(position, transactions);
        
        // Update position
        position.lastRebalance = Date.now();
        position.allocations = await this.getCurrentAllocations(position);
        
        // Update stats
        this.stats.totalRebalances++;
        
        logger.info(`Position rebalanced: ${position.id}`);
        
        this.emit('rebalance:completed', {
            positionId: position.id,
            transactions,
            results,
            timestamp: Date.now()
        });
        
        return {
            rebalanced: true,
            transactions,
            results
        };
    }
    
    /**
     * Auto-compound yields
     */
    async compoundPosition(position) {
        const compoundable = [];
        
        // Check each protocol for compoundable yields
        for (const allocation of position.allocations) {
            try {
                const adapter = this.protocols.get(allocation.protocolId);
                const pendingYield = await adapter.getPendingYield({
                    userId: position.userId,
                    positionId: position.id
                });
                
                if (pendingYield && pendingYield.amount >= this.config.compoundThreshold) {
                    compoundable.push({
                        protocolId: allocation.protocolId,
                        amount: pendingYield.amount,
                        asset: pendingYield.asset
                    });
                }
            } catch (error) {
                logger.error(`Failed to check yield for ${allocation.protocolId}:`, error);
            }
        }
        
        if (compoundable.length === 0) {
            return { compounded: false, reason: 'No yields to compound' };
        }
        
        // Execute compounds
        const results = await Promise.all(
            compoundable.map(async ({ protocolId, amount, asset }) => {
                try {
                    const adapter = this.protocols.get(protocolId);
                    const result = await adapter.compound({
                        userId: position.userId,
                        positionId: position.id
                    });
                    
                    return {
                        protocolId,
                        success: true,
                        amount: result.compounded,
                        gasUsed: result.gasUsed
                    };
                } catch (error) {
                    logger.error(`Compound failed for ${protocolId}:`, error);
                    return {
                        protocolId,
                        success: false,
                        error: error.message
                    };
                }
            })
        );
        
        // Record yields
        const totalCompounded = results.filter(r => r.success).reduce((sum, r) => sum + r.amount, 0);
        position.yields.push({
            amount: totalCompounded,
            type: 'compound',
            timestamp: Date.now()
        });
        
        // Update stats
        this.stats.totalYieldEarned += totalCompounded;
        this.stats.totalCompounds++;
        
        logger.info(`Position compounded: ${position.id}, amount: ${totalCompounded}`);
        
        this.emit('compound:completed', {
            positionId: position.id,
            results,
            totalCompounded,
            timestamp: Date.now()
        });
        
        return {
            compounded: true,
            results,
            totalCompounded
        };
    }
    
    /**
     * Get best yield opportunities
     */
    async getBestYields(params = {}) {
        const {
            asset = 'USDT',
            amount = 10000,
            riskLevel = 'medium',
            protocols = Array.from(this.protocols.keys())
        } = params;
        
        const opportunities = [];
        
        for (const protocolId of protocols) {
            try {
                // Get current yield
                const yieldInfo = this.yieldRates.get(protocolId);
                if (!yieldInfo) continue;
                
                // Get risk score
                const riskScore = this.protocolRisks.get(protocolId);
                if (!this.isRiskAcceptable(riskScore, riskLevel)) continue;
                
                // Calculate projected returns
                const projectedReturns = this.calculateProjectedReturns(
                    amount,
                    yieldInfo.apy,
                    yieldInfo.fees
                );
                
                opportunities.push({
                    protocolId,
                    asset,
                    apy: yieldInfo.apy,
                    tvl: yieldInfo.tvl,
                    riskScore: riskScore.score,
                    projectedReturns,
                    lastUpdate: yieldInfo.lastUpdate
                });
            } catch (error) {
                logger.error(`Failed to get yield for ${protocolId}:`, error);
            }
        }
        
        // Sort by risk-adjusted returns
        opportunities.sort((a, b) => {
            const aRiskAdjusted = a.apy * (100 - a.riskScore) / 100;
            const bRiskAdjusted = b.apy * (100 - b.riskScore) / 100;
            return bRiskAdjusted - aRiskAdjusted;
        });
        
        return opportunities;
    }
    
    /**
     * Helper methods
     */
    
    async updateYieldRate(protocolId) {
        try {
            const adapter = this.protocols.get(protocolId);
            const yieldRate = await adapter.getYieldRate();
            
            this.yieldRates.set(protocolId, {
                apy: yieldRate.apy,
                apr: yieldRate.apr,
                tvl: yieldRate.tvl,
                fees: yieldRate.fees || {},
                lastUpdate: Date.now()
            });
            
            // Store historical data
            if (!this.historicalYields.has(protocolId)) {
                this.historicalYields.set(protocolId, []);
            }
            
            this.historicalYields.get(protocolId).push({
                apy: yieldRate.apy,
                tvl: yieldRate.tvl,
                timestamp: Date.now()
            });
            
            // Keep only last 30 days
            const history = this.historicalYields.get(protocolId);
            const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
            this.historicalYields.set(
                protocolId,
                history.filter(h => h.timestamp > cutoff)
            );
            
        } catch (error) {
            logger.error(`Failed to update yield rate for ${protocolId}:`, error);
        }
    }
    
    async updatePositionValue(position) {
        let totalValue = 0;
        
        for (const allocation of position.allocations) {
            try {
                const adapter = this.protocols.get(allocation.protocolId);
                const balance = await adapter.getBalance({
                    userId: position.userId,
                    positionId: position.id
                });
                
                allocation.currentValue = balance.value;
                totalValue += balance.value;
            } catch (error) {
                logger.error(`Failed to get balance for ${allocation.protocolId}:`, error);
            }
        }
        
        position.currentValue = totalValue;
        position.lastUpdate = Date.now();
        
        return totalValue;
    }
    
    async getCurrentAllocations(position) {
        const allocations = [];
        
        for (const allocation of position.allocations) {
            try {
                const adapter = this.protocols.get(allocation.protocolId);
                const balance = await adapter.getBalance({
                    userId: position.userId,
                    positionId: position.id
                });
                
                allocations.push({
                    protocolId: allocation.protocolId,
                    value: balance.value,
                    asset: balance.asset
                });
            } catch (error) {
                logger.error(`Failed to get allocation for ${allocation.protocolId}:`, error);
            }
        }
        
        return allocations;
    }
    
    checkRebalanceNeeded(current, target, totalValue, force) {
        if (force) return true;
        
        for (const [protocolId, targetPct] of Object.entries(target)) {
            const currentAlloc = current.find(a => a.protocolId === protocolId);
            const currentPct = currentAlloc ? currentAlloc.value / totalValue : 0;
            
            if (Math.abs(currentPct - targetPct) > this.config.rebalanceThreshold) {
                return true;
            }
        }
        
        return false;
    }
    
    generateRebalanceTransactions(targetAllocations) {
        const transactions = [];
        
        for (const { protocolId, targetValue, currentValue } of targetAllocations) {
            const diff = targetValue - currentValue;
            
            if (Math.abs(diff) > 10) { // $10 minimum
                transactions.push({
                    protocolId,
                    type: diff > 0 ? 'deposit' : 'withdraw',
                    amount: Math.abs(diff)
                });
            }
        }
        
        return transactions;
    }
    
    isRebalanceWorthGas(transactions, totalValue) {
        const estimatedGas = transactions.length * 100; // Simplified gas estimate
        const rebalanceValue = transactions.reduce((sum, t) => sum + t.amount, 0);
        
        return rebalanceValue > this.config.minRebalanceValue &&
               rebalanceValue / totalValue > 0.01; // 1% of total
    }
    
    async executeRebalance(position, transactions) {
        // First, execute all withdrawals
        const withdrawals = transactions.filter(t => t.type === 'withdraw');
        const deposits = transactions.filter(t => t.type === 'deposit');
        
        const results = [];
        
        // Execute withdrawals
        for (const tx of withdrawals) {
            try {
                const adapter = this.protocols.get(tx.protocolId);
                const result = await adapter.withdraw({
                    userId: position.userId,
                    amount: tx.amount,
                    asset: position.asset
                });
                
                results.push({
                    ...tx,
                    success: true,
                    result
                });
            } catch (error) {
                results.push({
                    ...tx,
                    success: false,
                    error: error.message
                });
            }
        }
        
        // Execute deposits
        for (const tx of deposits) {
            try {
                const adapter = this.protocols.get(tx.protocolId);
                const result = await adapter.deposit({
                    userId: position.userId,
                    amount: tx.amount,
                    asset: position.asset
                });
                
                results.push({
                    ...tx,
                    success: true,
                    result
                });
            } catch (error) {
                results.push({
                    ...tx,
                    success: false,
                    error: error.message
                });
            }
        }
        
        return results;
    }
    
    calculateProjectedReturns(amount, apy, fees = {}) {
        const depositFee = fees.deposit || 0;
        const withdrawFee = fees.withdraw || 0;
        const performanceFee = fees.performance || 0;
        
        const netAmount = amount * (1 - depositFee);
        
        return {
            daily: netAmount * (apy / 365) * (1 - performanceFee),
            weekly: netAmount * (apy / 52) * (1 - performanceFee),
            monthly: netAmount * (apy / 12) * (1 - performanceFee),
            yearly: netAmount * apy * (1 - performanceFee),
            afterFees: netAmount * apy * (1 - performanceFee) * (1 - withdrawFee)
        };
    }
    
    isRiskAcceptable(riskScore, riskLevel) {
        const thresholds = {
            low: 70,
            medium: 50,
            high: 30
        };
        
        return riskScore.score >= (thresholds[riskLevel] || 50);
    }
    
    generatePositionId() {
        return `POS${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
    
    generateStrategyId() {
        return `STR${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Start optimization loop
     */
    startOptimization() {
        // Update yield rates
        this.yieldUpdateInterval = setInterval(() => {
            for (const protocolId of this.protocols.keys()) {
                this.updateYieldRate(protocolId);
            }
        }, 300000); // Every 5 minutes
        
        // Optimize positions
        this.optimizationInterval = setInterval(async () => {
            for (const [userId, positions] of this.userPositions) {
                for (const position of positions) {
                    if (position.status !== 'active') continue;
                    
                    try {
                        // Update value
                        await this.updatePositionValue(position);
                        
                        // Check for rebalance
                        const strategy = this.strategies.get(position.strategyId);
                        if (strategy && strategy.autoRebalance) {
                            await this.rebalancePosition(position);
                        }
                        
                        // Check for compound
                        if (this.config.autoCompound && strategy?.autoCompound) {
                            await this.compoundPosition(position);
                        }
                    } catch (error) {
                        logger.error(`Optimization error for position ${position.id}:`, error);
                    }
                }
            }
            
            // Update stats
            this.updateStats();
            
        }, this.config.optimizationInterval);
        
        logger.info('Yield optimization started');
    }
    
    updateStats() {
        let totalValue = 0;
        let totalYield = 0;
        let weightedAPY = 0;
        
        for (const positions of this.userPositions.values()) {
            for (const position of positions) {
                if (position.status === 'active') {
                    totalValue += position.currentValue;
                    totalYield += position.yields.reduce((sum, y) => sum + y.amount, 0);
                    
                    // Calculate weighted APY
                    const strategy = this.strategies.get(position.strategyId);
                    if (strategy) {
                        for (const [protocolId, allocation] of Object.entries(strategy.allocation)) {
                            const yieldInfo = this.yieldRates.get(protocolId);
                            if (yieldInfo) {
                                weightedAPY += yieldInfo.apy * allocation * position.currentValue;
                            }
                        }
                    }
                }
            }
        }
        
        this.stats.totalValueLocked = totalValue;
        this.stats.totalYieldEarned = totalYield;
        this.stats.averageAPY = totalValue > 0 ? weightedAPY / totalValue : 0;
    }
    
    /**
     * Stop optimization
     */
    stop() {
        if (this.yieldUpdateInterval) {
            clearInterval(this.yieldUpdateInterval);
        }
        
        if (this.optimizationInterval) {
            clearInterval(this.optimizationInterval);
        }
        
        logger.info('Yield optimization stopped');
    }
    
    /**
     * Get aggregator statistics
     */
    getStats() {
        return {
            ...this.stats,
            protocols: this.protocols.size,
            strategies: this.strategies.size,
            positions: Array.from(this.userPositions.values()).reduce((sum, positions) => sum + positions.length, 0),
            timestamp: Date.now()
        };
    }
}

export default YieldAggregator;