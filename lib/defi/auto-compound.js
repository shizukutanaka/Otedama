/**
 * Auto-Compounding Yield Manager for Otedama
 * Automatically reinvests yields for compound growth
 * 
 * Design principles:
 * - Efficient compound calculations (Carmack)
 * - Clean yield management (Martin)
 * - Simple automation logic (Pike)
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

const logger = getLogger('AutoCompound');

export class AutoCompoundManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Compound settings
            minCompoundValue: config.minCompoundValue || 10, // $10 minimum
            maxCompoundFrequency: config.maxCompoundFrequency || 3600000, // 1 hour max frequency
            defaultCompoundFrequency: config.defaultCompoundFrequency || 86400000, // 24 hours default
            
            // Gas optimization
            maxGasPrice: config.maxGasPrice || 100, // 100 gwei max
            gasBuffer: config.gasBuffer || 1.2, // 20% gas buffer
            batchSize: config.batchSize || 50, // Batch compounds
            
            // Strategy settings
            emergencyWithdrawThreshold: config.emergencyWithdrawThreshold || 0.9, // 90% loss trigger
            profitTakeThreshold: config.profitTakeThreshold || 2, // 2x profit trigger
            rebalanceThreshold: config.rebalanceThreshold || 0.1, // 10% deviation
            
            // Protocol integrations
            supportedProtocols: config.supportedProtocols || [
                'compound', 'aave', 'yearn', 'curve', 'convex', 'beefy'
            ],
            
            // Fee settings
            performanceFee: config.performanceFee || 0.1, // 10% performance fee
            managementFee: config.managementFee || 0.02, // 2% annual management fee
            
            // Safety settings
            maxSlippage: config.maxSlippage || 0.01, // 1% max slippage
            pauseOnHighGas: config.pauseOnHighGas || true,
            
            ...config
        };
        
        // Strategy registry
        this.strategies = new Map(); // strategyId -> CompoundStrategy
        this.userStrategies = new Map(); // userId -> Set<strategyId>
        
        // Position tracking
        this.positions = new Map(); // positionId -> Position
        this.userPositions = new Map(); // userId -> Set<positionId>
        
        // Protocol adapters
        this.protocolAdapters = new Map(); // protocol -> Adapter
        
        // Compound queue
        this.compoundQueue = [];
        this.isCompounding = false;
        
        // Statistics
        this.stats = {
            totalCompounded: 0,
            totalGasSaved: 0,
            totalPositions: 0,
            activeStrategies: 0,
            totalValueLocked: 0,
            totalYieldGenerated: 0,
            averageAPY: 0
        };
        
        // Start automation
        this.startAutomation();
    }
    
    /**
     * Register compound strategy
     */
    registerStrategy(params) {
        const {
            name,
            protocol,
            asset,
            targetAPY,
            riskLevel = 'medium',
            compoundFrequency = this.config.defaultCompoundFrequency,
            minDeposit = 100,
            maxDeposit = 1000000
        } = params;
        
        if (!this.config.supportedProtocols.includes(protocol)) {
            throw new Error(`Protocol ${protocol} not supported`);
        }
        
        const strategyId = this.generateStrategyId();
        const strategy = {
            id: strategyId,
            name,
            protocol,
            asset,
            targetAPY,
            riskLevel,
            compoundFrequency,
            minDeposit,
            maxDeposit,
            
            // Performance tracking
            actualAPY: 0,
            totalDeposited: 0,
            totalCompounded: 0,
            lastCompoundTime: 0,
            compoundCount: 0,
            
            // Status
            status: 'active',
            createdAt: Date.now()
        };
        
        this.strategies.set(strategyId, strategy);
        this.stats.activeStrategies++;
        
        logger.info(`Compound strategy registered: ${strategyId} - ${name}`);
        
        this.emit('strategy:registered', {
            strategy,
            timestamp: Date.now()
        });
        
        return strategy;
    }
    
    /**
     * Deposit into auto-compound strategy
     */
    async deposit(params) {
        const {
            userId,
            strategyId,
            amount
        } = params;
        
        const strategy = this.strategies.get(strategyId);
        if (!strategy) {
            throw new Error('Strategy not found');
        }
        
        if (amount < strategy.minDeposit || amount > strategy.maxDeposit) {
            throw new Error(`Amount must be between ${strategy.minDeposit} and ${strategy.maxDeposit}`);
        }
        
        // Create position
        const positionId = this.generatePositionId();
        const position = {
            id: positionId,
            userId,
            strategyId,
            
            // Deposit info
            principal: amount,
            currentValue: amount,
            pendingRewards: 0,
            
            // Compound tracking
            totalCompounded: 0,
            compoundCount: 0,
            lastCompoundTime: Date.now(),
            nextCompoundTime: Date.now() + strategy.compoundFrequency,
            
            // Performance
            totalYield: 0,
            currentAPY: 0,
            profitLoss: 0,
            
            // Status
            status: 'active',
            autoCompound: true,
            depositedAt: Date.now()
        };
        
        // Execute deposit on protocol
        const adapter = this.protocolAdapters.get(strategy.protocol);
        if (!adapter) {
            throw new Error(`Protocol adapter not found for ${strategy.protocol}`);
        }
        
        const receipt = await adapter.deposit({
            asset: strategy.asset,
            amount,
            userId
        });
        
        position.protocolPosition = receipt.positionId;
        
        // Store position
        this.positions.set(positionId, position);
        
        // Update user positions
        if (!this.userPositions.has(userId)) {
            this.userPositions.set(userId, new Set());
        }
        this.userPositions.get(userId).add(positionId);
        
        // Update strategy stats
        strategy.totalDeposited += amount;
        
        // Update global stats
        this.stats.totalPositions++;
        this.stats.totalValueLocked += amount;
        
        // Add to compound queue
        this.compoundQueue.push({
            positionId,
            scheduledTime: position.nextCompoundTime
        });
        
        logger.info(`Auto-compound position created: ${positionId}, strategy: ${strategyId}, amount: ${amount}`);
        
        this.emit('position:created', {
            position,
            strategy,
            timestamp: Date.now()
        });
        
        return position;
    }
    
    /**
     * Compound rewards for a position
     */
    async compoundPosition(positionId) {
        const position = this.positions.get(positionId);
        if (!position) {
            throw new Error('Position not found');
        }
        
        if (position.status !== 'active') {
            throw new Error('Position is not active');
        }
        
        const strategy = this.strategies.get(position.strategyId);
        const adapter = this.protocolAdapters.get(strategy.protocol);
        
        try {
            // Check pending rewards
            const rewards = await adapter.getPendingRewards({
                positionId: position.protocolPosition,
                asset: strategy.asset
            });
            
            if (rewards.amount < this.config.minCompoundValue) {
                logger.info(`Rewards too small to compound: ${rewards.amount}`);
                return null;
            }
            
            // Check gas price
            const gasPrice = await this.getGasPrice();
            if (gasPrice > this.config.maxGasPrice && this.config.pauseOnHighGas) {
                logger.info(`Gas price too high: ${gasPrice}, skipping compound`);
                position.nextCompoundTime += 3600000; // Retry in 1 hour
                return null;
            }
            
            // Estimate gas cost
            const gasCost = await adapter.estimateCompoundGas() * gasPrice;
            const netReward = rewards.amount - gasCost;
            
            if (netReward < 0) {
                logger.info(`Gas cost exceeds rewards, skipping compound`);
                position.nextCompoundTime += 3600000; // Retry in 1 hour
                return null;
            }
            
            // Execute compound
            const compoundReceipt = await adapter.compound({
                positionId: position.protocolPosition,
                minAmount: netReward * (1 - this.config.maxSlippage)
            });
            
            // Update position
            const compoundedAmount = compoundReceipt.compoundedAmount;
            position.totalCompounded += compoundedAmount;
            position.currentValue += compoundedAmount;
            position.compoundCount++;
            position.lastCompoundTime = Date.now();
            position.nextCompoundTime = Date.now() + strategy.compoundFrequency;
            position.pendingRewards = 0;
            
            // Calculate yield
            position.totalYield += compoundedAmount;
            position.profitLoss = position.currentValue - position.principal;
            
            // Update APY
            const timeElapsed = Date.now() - position.depositedAt;
            const yearFraction = timeElapsed / (365 * 24 * 60 * 60 * 1000);
            position.currentAPY = (position.profitLoss / position.principal) / yearFraction;
            
            // Update strategy stats
            strategy.totalCompounded += compoundedAmount;
            strategy.compoundCount++;
            strategy.lastCompoundTime = Date.now();
            
            // Update actual APY for strategy
            this.updateStrategyAPY(strategy);
            
            // Update global stats
            this.stats.totalCompounded += compoundedAmount;
            this.stats.totalGasSaved += gasCost * 0.8; // Estimate 80% gas savings from batching
            this.stats.totalYieldGenerated += compoundedAmount;
            
            logger.info(`Position compounded: ${positionId}, amount: ${compoundedAmount}, new value: ${position.currentValue}`);
            
            this.emit('position:compounded', {
                position,
                compoundedAmount,
                gasCost,
                timestamp: Date.now()
            });
            
            // Check triggers
            await this.checkPositionTriggers(position);
            
            return {
                compoundedAmount,
                newValue: position.currentValue,
                gasCost
            };
            
        } catch (error) {
            logger.error(`Failed to compound position ${positionId}:`, error);
            position.nextCompoundTime += 3600000; // Retry in 1 hour
            throw error;
        }
    }
    
    /**
     * Batch compound multiple positions
     */
    async batchCompound() {
        if (this.isCompounding) {
            return;
        }
        
        this.isCompounding = true;
        
        try {
            const now = Date.now();
            const readyToCompound = this.compoundQueue
                .filter(item => item.scheduledTime <= now)
                .slice(0, this.config.batchSize);
            
            if (readyToCompound.length === 0) {
                return;
            }
            
            logger.info(`Starting batch compound for ${readyToCompound.length} positions`);
            
            const results = [];
            for (const item of readyToCompound) {
                try {
                    const result = await this.compoundPosition(item.positionId);
                    if (result) {
                        results.push(result);
                    }
                    
                    // Remove from queue
                    const index = this.compoundQueue.indexOf(item);
                    if (index > -1) {
                        this.compoundQueue.splice(index, 1);
                    }
                    
                    // Re-add with new schedule
                    const position = this.positions.get(item.positionId);
                    if (position && position.status === 'active' && position.autoCompound) {
                        this.compoundQueue.push({
                            positionId: item.positionId,
                            scheduledTime: position.nextCompoundTime
                        });
                    }
                    
                } catch (error) {
                    logger.error(`Failed to compound position ${item.positionId}:`, error);
                }
            }
            
            if (results.length > 0) {
                const totalCompounded = results.reduce((sum, r) => sum + r.compoundedAmount, 0);
                const totalGasCost = results.reduce((sum, r) => sum + r.gasCost, 0);
                
                logger.info(`Batch compound completed: ${results.length} positions, total: ${totalCompounded}, gas: ${totalGasCost}`);
                
                this.emit('batch:compound:completed', {
                    count: results.length,
                    totalCompounded,
                    totalGasCost,
                    timestamp: Date.now()
                });
            }
            
        } finally {
            this.isCompounding = false;
        }
    }
    
    /**
     * Withdraw from position
     */
    async withdraw(params) {
        const {
            userId,
            positionId,
            amount // Optional, withdraws all if not specified
        } = params;
        
        const position = this.positions.get(positionId);
        if (!position) {
            throw new Error('Position not found');
        }
        
        if (position.userId !== userId) {
            throw new Error('Unauthorized');
        }
        
        const strategy = this.strategies.get(position.strategyId);
        const adapter = this.protocolAdapters.get(strategy.protocol);
        
        // Get current position value
        const currentValue = await adapter.getPositionValue({
            positionId: position.protocolPosition
        });
        
        position.currentValue = currentValue;
        
        const withdrawAmount = amount || currentValue;
        if (withdrawAmount > currentValue) {
            throw new Error('Insufficient balance');
        }
        
        // Execute withdrawal
        const receipt = await adapter.withdraw({
            positionId: position.protocolPosition,
            amount: withdrawAmount,
            recipient: userId
        });
        
        // Update position
        if (withdrawAmount >= currentValue * 0.99) {
            // Full withdrawal
            position.status = 'closed';
            position.currentValue = 0;
            position.autoCompound = false;
            
            // Remove from queue
            this.compoundQueue = this.compoundQueue.filter(
                item => item.positionId !== positionId
            );
            
            // Update stats
            this.stats.totalPositions--;
            this.stats.totalValueLocked -= currentValue;
            
        } else {
            // Partial withdrawal
            position.currentValue -= withdrawAmount;
            position.principal = Math.max(0, position.principal - withdrawAmount);
        }
        
        // Collect fees if profitable
        let feeAmount = 0;
        if (position.profitLoss > 0) {
            feeAmount = position.profitLoss * this.config.performanceFee;
            // In production, would transfer fee to treasury
        }
        
        const netAmount = receipt.amount - feeAmount;
        
        logger.info(`Position withdrawn: ${positionId}, amount: ${withdrawAmount}, net: ${netAmount}`);
        
        this.emit('position:withdrawn', {
            position,
            withdrawAmount,
            netAmount,
            feeAmount,
            timestamp: Date.now()
        });
        
        return {
            withdrawnAmount: netAmount,
            feeAmount,
            remainingValue: position.currentValue
        };
    }
    
    /**
     * Check position triggers (emergency withdraw, profit taking)
     */
    async checkPositionTriggers(position) {
        const strategy = this.strategies.get(position.strategyId);
        
        // Check emergency withdraw trigger
        const lossRatio = (position.principal - position.currentValue) / position.principal;
        if (lossRatio >= this.config.emergencyWithdrawThreshold) {
            logger.warn(`Emergency withdraw triggered for position ${position.id}`);
            
            await this.withdraw({
                userId: position.userId,
                positionId: position.id
            });
            
            this.emit('position:emergency:withdraw', {
                position,
                lossRatio,
                timestamp: Date.now()
            });
            
            return;
        }
        
        // Check profit taking trigger
        const profitRatio = position.currentValue / position.principal;
        if (profitRatio >= this.config.profitTakeThreshold) {
            // Take 50% profit
            const profitAmount = (position.currentValue - position.principal) * 0.5;
            
            logger.info(`Profit taking triggered for position ${position.id}`);
            
            await this.withdraw({
                userId: position.userId,
                positionId: position.id,
                amount: profitAmount
            });
            
            this.emit('position:profit:taken', {
                position,
                profitRatio,
                profitAmount,
                timestamp: Date.now()
            });
        }
    }
    
    /**
     * Update strategy APY based on actual performance
     */
    updateStrategyAPY(strategy) {
        const positions = Array.from(this.positions.values())
            .filter(p => p.strategyId === strategy.id && p.status === 'active');
        
        if (positions.length === 0) {
            return;
        }
        
        const totalAPY = positions.reduce((sum, p) => sum + p.currentAPY, 0);
        strategy.actualAPY = totalAPY / positions.length;
        
        // Update global average APY
        const allStrategies = Array.from(this.strategies.values())
            .filter(s => s.status === 'active' && s.actualAPY > 0);
        
        if (allStrategies.length > 0) {
            this.stats.averageAPY = allStrategies.reduce((sum, s) => sum + s.actualAPY, 0) / allStrategies.length;
        }
    }
    
    /**
     * Get gas price (mock implementation)
     */
    async getGasPrice() {
        // In production, would fetch from gas oracle
        return 30; // 30 gwei
    }
    
    /**
     * Register protocol adapter
     */
    registerProtocolAdapter(protocol, adapter) {
        if (!this.config.supportedProtocols.includes(protocol)) {
            throw new Error(`Protocol ${protocol} not supported`);
        }
        
        // Validate adapter interface
        const requiredMethods = [
            'deposit', 'withdraw', 'compound', 
            'getPendingRewards', 'getPositionValue',
            'estimateCompoundGas'
        ];
        
        for (const method of requiredMethods) {
            if (typeof adapter[method] !== 'function') {
                throw new Error(`Adapter missing required method: ${method}`);
            }
        }
        
        this.protocolAdapters.set(protocol, adapter);
        logger.info(`Protocol adapter registered: ${protocol}`);
    }
    
    /**
     * Start automation
     */
    startAutomation() {
        // Compound check interval
        this.compoundInterval = setInterval(async () => {
            await this.batchCompound();
        }, 60000); // Check every minute
        
        // Stats update interval
        this.statsInterval = setInterval(() => {
            this.updateStats();
        }, 10000); // Update every 10 seconds
        
        // Sort compound queue by scheduled time
        this.queueSortInterval = setInterval(() => {
            this.compoundQueue.sort((a, b) => a.scheduledTime - b.scheduledTime);
        }, 30000); // Sort every 30 seconds
        
        logger.info('Auto-compound automation started');
    }
    
    /**
     * Update statistics
     */
    updateStats() {
        let totalValueLocked = 0;
        let activePositions = 0;
        
        for (const position of this.positions.values()) {
            if (position.status === 'active') {
                totalValueLocked += position.currentValue;
                activePositions++;
            }
        }
        
        this.stats.totalValueLocked = totalValueLocked;
        this.stats.totalPositions = activePositions;
    }
    
    /**
     * Stop automation
     */
    stop() {
        if (this.compoundInterval) {
            clearInterval(this.compoundInterval);
        }
        
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
        }
        
        if (this.queueSortInterval) {
            clearInterval(this.queueSortInterval);
        }
        
        logger.info('Auto-compound automation stopped');
    }
    
    /**
     * Helper methods
     */
    
    generateStrategyId() {
        return `STR${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
    
    generatePositionId() {
        return `POS${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
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
     * Get strategy info
     */
    getStrategy(strategyId) {
        return this.strategies.get(strategyId);
    }
    
    /**
     * Get all active strategies
     */
    getActiveStrategies() {
        return Array.from(this.strategies.values())
            .filter(s => s.status === 'active');
    }
    
    /**
     * Get platform statistics
     */
    getStats() {
        return {
            ...this.stats,
            strategies: this.strategies.size,
            protocols: this.protocolAdapters.size,
            queueSize: this.compoundQueue.length,
            timestamp: Date.now()
        };
    }
}

export default AutoCompoundManager;