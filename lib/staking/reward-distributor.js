/**
 * Reward Distributor for Otedama
 * Automated reward distribution system
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

export class RewardDistributor extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            distributionInterval: config.distributionInterval || 24 * 60 * 60 * 1000, // Daily
            minDistributionAmount: config.minDistributionAmount || 100, // Min 100 tokens
            rewardSources: config.rewardSources || {
                tradingFees: 0.4,    // 40% of trading fees
                miningFees: 0.3,     // 30% of mining pool fees
                lendingFees: 0.2,    // 20% of lending fees
                treasuryYield: 0.1   // 10% from treasury yield
            },
            distribution: config.distribution || {
                stakers: 0.4,        // 40% to stakers
                liquidityProviders: 0.3, // 30% to LPs
                miners: 0.15,        // 15% to miners
                treasury: 0.1,       // 10% to treasury
                development: 0.05    // 5% to development
            },
            ...config
        };
        
        this.logger = getLogger('RewardDistributor');
        
        // Reward pools
        this.rewardPools = new Map(); // poolId -> pool
        
        // Pending rewards
        this.pendingRewards = new Map(); // userId -> asset -> amount
        
        // Distribution history
        this.distributionHistory = [];
        
        // Revenue tracking
        this.revenueAccumulator = new Map(); // source -> asset -> amount
        
        this.isRunning = false;
    }
    
    /**
     * Start reward distributor
     */
    async start() {
        if (this.isRunning) return;
        
        this.logger.info('Starting reward distributor...');
        
        // Initialize reward pools
        this.initializeRewardPools();
        
        // Start distribution cycle
        this.startDistributionCycle();
        
        // Start revenue tracking
        this.startRevenueTracking();
        
        this.isRunning = true;
        this.logger.info('Reward distributor started');
    }
    
    /**
     * Initialize reward pools
     */
    initializeRewardPools() {
        // Staking rewards pool
        this.createRewardPool({
            poolId: 'STAKING_REWARDS',
            name: 'Staking Rewards',
            type: 'staking',
            allocation: this.config.distribution.stakers
        });
        
        // LP rewards pool
        this.createRewardPool({
            poolId: 'LP_REWARDS',
            name: 'Liquidity Provider Rewards',
            type: 'liquidity',
            allocation: this.config.distribution.liquidityProviders
        });
        
        // Mining rewards pool
        this.createRewardPool({
            poolId: 'MINING_REWARDS',
            name: 'Mining Rewards',
            type: 'mining',
            allocation: this.config.distribution.miners
        });
        
        // Treasury pool
        this.createRewardPool({
            poolId: 'TREASURY',
            name: 'Treasury',
            type: 'treasury',
            allocation: this.config.distribution.treasury
        });
        
        // Development fund
        this.createRewardPool({
            poolId: 'DEVELOPMENT',
            name: 'Development Fund',
            type: 'development',
            allocation: this.config.distribution.development
        });
    }
    
    /**
     * Create reward pool
     */
    createRewardPool(params) {
        const {
            poolId,
            name,
            type,
            allocation,
            distributionRules = {}
        } = params;
        
        const pool = {
            poolId,
            name,
            type,
            allocation,
            distributionRules,
            totalDistributed: 0,
            participants: new Map(), // userId -> share
            lastDistribution: Date.now()
        };
        
        this.rewardPools.set(poolId, pool);
        
        return pool;
    }
    
    /**
     * Add revenue from various sources
     */
    addRevenue(source, asset, amount) {
        if (!this.config.rewardSources[source]) {
            this.logger.warn(`Unknown revenue source: ${source}`);
            return;
        }
        
        if (!this.revenueAccumulator.has(source)) {
            this.revenueAccumulator.set(source, new Map());
        }
        
        const sourceRevenue = this.revenueAccumulator.get(source);
        const currentAmount = sourceRevenue.get(asset) || 0;
        sourceRevenue.set(asset, currentAmount + amount);
        
        this.emit('revenue-added', {
            source,
            asset,
            amount,
            timestamp: Date.now()
        });
    }
    
    /**
     * Calculate distribution amounts
     */
    calculateDistribution() {
        const distribution = new Map(); // poolId -> asset -> amount
        
        // Calculate total revenue to distribute
        const totalRevenue = new Map(); // asset -> amount
        
        for (const [source, sourceAllocation] of Object.entries(this.config.rewardSources)) {
            const sourceRevenue = this.revenueAccumulator.get(source);
            if (!sourceRevenue) continue;
            
            for (const [asset, amount] of sourceRevenue) {
                const allocatedAmount = amount * sourceAllocation;
                const current = totalRevenue.get(asset) || 0;
                totalRevenue.set(asset, current + allocatedAmount);
            }
        }
        
        // Distribute to pools based on allocation
        for (const [poolId, pool] of this.rewardPools) {
            const poolDistribution = new Map();
            
            for (const [asset, amount] of totalRevenue) {
                const poolAmount = amount * pool.allocation;
                if (poolAmount >= this.config.minDistributionAmount) {
                    poolDistribution.set(asset, poolAmount);
                }
            }
            
            if (poolDistribution.size > 0) {
                distribution.set(poolId, poolDistribution);
            }
        }
        
        return distribution;
    }
    
    /**
     * Distribute rewards
     */
    async distributeRewards() {
        this.logger.info('Starting reward distribution...');
        
        const distribution = this.calculateDistribution();
        const timestamp = Date.now();
        const results = {
            timestamp,
            distributions: [],
            totalDistributed: new Map()
        };
        
        // Update participant shares before distribution
        await this.updateParticipantShares();
        
        // Distribute to each pool
        for (const [poolId, poolDistribution] of distribution) {
            const pool = this.rewardPools.get(poolId);
            
            for (const [asset, amount] of poolDistribution) {
                try {
                    const distributed = await this.distributeToPool(pool, asset, amount);
                    
                    results.distributions.push({
                        poolId,
                        asset,
                        amount,
                        recipients: distributed.recipients
                    });
                    
                    // Update totals
                    const currentTotal = results.totalDistributed.get(asset) || 0;
                    results.totalDistributed.set(asset, currentTotal + amount);
                    
                    // Update pool stats
                    pool.totalDistributed += amount;
                    pool.lastDistribution = timestamp;
                    
                } catch (error) {
                    this.logger.error(`Distribution failed for pool ${poolId}:`, error);
                }
            }
        }
        
        // Clear distributed revenue
        this.clearDistributedRevenue(distribution);
        
        // Record distribution history
        this.distributionHistory.push(results);
        if (this.distributionHistory.length > 100) {
            this.distributionHistory.shift();
        }
        
        this.emit('distribution-completed', results);
        
        return results;
    }
    
    /**
     * Distribute to specific pool
     */
    async distributeToPool(pool, asset, amount) {
        const distributed = {
            recipients: 0,
            totalAmount: amount
        };
        
        switch (pool.type) {
            case 'staking':
                distributed.recipients = await this.distributeToStakers(asset, amount);
                break;
                
            case 'liquidity':
                distributed.recipients = await this.distributeToLPs(asset, amount);
                break;
                
            case 'mining':
                distributed.recipients = await this.distributeToMiners(asset, amount);
                break;
                
            case 'treasury':
                await this.addToTreasury(asset, amount);
                distributed.recipients = 1;
                break;
                
            case 'development':
                await this.addToDevelopmentFund(asset, amount);
                distributed.recipients = 1;
                break;
        }
        
        return distributed;
    }
    
    /**
     * Distribute rewards to stakers
     */
    async distributeToStakers(asset, amount) {
        const stakers = await this.getStakers();
        const totalStaked = stakers.reduce((sum, s) => sum + s.stakedAmount, 0);
        
        if (totalStaked === 0) {
            // No stakers, add to treasury
            await this.addToTreasury(asset, amount);
            return 0;
        }
        
        let recipients = 0;
        
        for (const staker of stakers) {
            const share = staker.stakedAmount / totalStaked;
            const reward = amount * share;
            
            if (reward > 0) {
                this.addPendingReward(staker.userId, asset, reward);
                recipients++;
            }
        }
        
        return recipients;
    }
    
    /**
     * Distribute rewards to liquidity providers
     */
    async distributeToLPs(asset, amount) {
        const lps = await this.getLiquidityProviders();
        const totalLiquidity = lps.reduce((sum, lp) => sum + lp.liquidityValue, 0);
        
        if (totalLiquidity === 0) {
            await this.addToTreasury(asset, amount);
            return 0;
        }
        
        let recipients = 0;
        
        for (const lp of lps) {
            const share = lp.liquidityValue / totalLiquidity;
            const reward = amount * share;
            
            if (reward > 0) {
                this.addPendingReward(lp.userId, asset, reward);
                recipients++;
            }
        }
        
        return recipients;
    }
    
    /**
     * Distribute rewards to miners
     */
    async distributeToMiners(asset, amount) {
        const miners = await this.getActiveMiners();
        const totalHashrate = miners.reduce((sum, m) => sum + m.hashrate, 0);
        
        if (totalHashrate === 0) {
            await this.addToTreasury(asset, amount);
            return 0;
        }
        
        let recipients = 0;
        
        for (const miner of miners) {
            const share = miner.hashrate / totalHashrate;
            const reward = amount * share;
            
            if (reward > 0) {
                this.addPendingReward(miner.userId, asset, reward);
                recipients++;
            }
        }
        
        return recipients;
    }
    
    /**
     * Add pending reward
     */
    addPendingReward(userId, asset, amount) {
        if (!this.pendingRewards.has(userId)) {
            this.pendingRewards.set(userId, new Map());
        }
        
        const userRewards = this.pendingRewards.get(userId);
        const current = userRewards.get(asset) || 0;
        userRewards.set(asset, current + amount);
    }
    
    /**
     * Claim pending rewards
     */
    async claimRewards(userId) {
        const userRewards = this.pendingRewards.get(userId);
        if (!userRewards || userRewards.size === 0) {
            throw new Error('No pending rewards');
        }
        
        const claimed = [];
        
        for (const [asset, amount] of userRewards) {
            if (amount > 0) {
                await this.transferTo(userId, asset, amount);
                claimed.push({ asset, amount });
            }
        }
        
        // Clear pending rewards
        this.pendingRewards.delete(userId);
        
        this.emit('rewards-claimed', {
            userId,
            rewards: claimed,
            timestamp: Date.now()
        });
        
        return claimed;
    }
    
    /**
     * Get pending rewards for user
     */
    getPendingRewards(userId) {
        const userRewards = this.pendingRewards.get(userId);
        if (!userRewards) return [];
        
        const rewards = [];
        for (const [asset, amount] of userRewards) {
            if (amount > 0) {
                rewards.push({ asset, amount });
            }
        }
        
        return rewards;
    }
    
    /**
     * Update participant shares
     */
    async updateParticipantShares() {
        // Update staker shares
        const stakingPool = this.rewardPools.get('STAKING_REWARDS');
        if (stakingPool) {
            const stakers = await this.getStakers();
            stakingPool.participants.clear();
            
            const totalStaked = stakers.reduce((sum, s) => sum + s.stakedAmount, 0);
            for (const staker of stakers) {
                if (totalStaked > 0) {
                    stakingPool.participants.set(
                        staker.userId, 
                        staker.stakedAmount / totalStaked
                    );
                }
            }
        }
        
        // Update LP shares
        const lpPool = this.rewardPools.get('LP_REWARDS');
        if (lpPool) {
            const lps = await this.getLiquidityProviders();
            lpPool.participants.clear();
            
            const totalLiquidity = lps.reduce((sum, lp) => sum + lp.liquidityValue, 0);
            for (const lp of lps) {
                if (totalLiquidity > 0) {
                    lpPool.participants.set(
                        lp.userId,
                        lp.liquidityValue / totalLiquidity
                    );
                }
            }
        }
    }
    
    /**
     * Clear distributed revenue
     */
    clearDistributedRevenue(distribution) {
        for (const [poolId, poolDistribution] of distribution) {
            const pool = this.rewardPools.get(poolId);
            
            for (const [asset, amount] of poolDistribution) {
                // Reduce revenue accumulator proportionally
                for (const [source, sourceRevenue] of this.revenueAccumulator) {
                    const sourceAmount = sourceRevenue.get(asset) || 0;
                    const sourceAllocation = this.config.rewardSources[source] || 0;
                    const deduction = amount * (sourceAllocation / pool.allocation);
                    
                    if (sourceAmount > deduction) {
                        sourceRevenue.set(asset, sourceAmount - deduction);
                    } else {
                        sourceRevenue.delete(asset);
                    }
                }
            }
        }
    }
    
    /**
     * Start distribution cycle
     */
    startDistributionCycle() {
        // Initial distribution after 1 minute
        setTimeout(() => {
            this.distributeRewards();
        }, 60 * 1000);
        
        // Regular distributions
        setInterval(() => {
            this.distributeRewards();
        }, this.config.distributionInterval);
    }
    
    /**
     * Start revenue tracking
     */
    startRevenueTracking() {
        // This would integrate with various platform components
        // to automatically track revenue
        
        // Example: Track trading fees
        this.on('trading-fee', (data) => {
            this.addRevenue('tradingFees', data.asset, data.amount);
        });
        
        // Example: Track mining fees
        this.on('mining-fee', (data) => {
            this.addRevenue('miningFees', data.asset, data.amount);
        });
    }
    
    /**
     * Get distribution statistics
     */
    getStats() {
        const stats = {
            rewardPools: [],
            pendingRewards: 0,
            totalDistributed: {},
            recentDistributions: this.distributionHistory.slice(-10)
        };
        
        // Pool stats
        for (const [poolId, pool] of this.rewardPools) {
            stats.rewardPools.push({
                poolId,
                name: pool.name,
                allocation: pool.allocation,
                totalDistributed: pool.totalDistributed,
                participants: pool.participants.size,
                lastDistribution: pool.lastDistribution
            });
        }
        
        // Pending rewards count
        for (const [userId, rewards] of this.pendingRewards) {
            stats.pendingRewards += rewards.size;
        }
        
        // Total distributed by asset
        for (const distribution of this.distributionHistory) {
            for (const [asset, amount] of distribution.totalDistributed) {
                stats.totalDistributed[asset] = 
                    (stats.totalDistributed[asset] || 0) + amount;
            }
        }
        
        return stats;
    }
    
    /**
     * Helper functions
     */
    async getStakers() {
        // This would integrate with staking system
        return [
            { userId: 'user1', stakedAmount: 50000 },
            { userId: 'user2', stakedAmount: 30000 },
            { userId: 'user3', stakedAmount: 20000 }
        ];
    }
    
    async getLiquidityProviders() {
        // This would integrate with DEX
        return [
            { userId: 'user1', liquidityValue: 100000 },
            { userId: 'user4', liquidityValue: 50000 },
            { userId: 'user5', liquidityValue: 25000 }
        ];
    }
    
    async getActiveMiners() {
        // This would integrate with mining pool
        return [
            { userId: 'miner1', hashrate: 1000000 },
            { userId: 'miner2', hashrate: 500000 },
            { userId: 'miner3', hashrate: 250000 }
        ];
    }
    
    async addToTreasury(asset, amount) {
        this.logger.info(`Added ${amount} ${asset} to treasury`);
        // This would integrate with treasury management
    }
    
    async addToDevelopmentFund(asset, amount) {
        this.logger.info(`Added ${amount} ${asset} to development fund`);
        // This would integrate with development fund management
    }
    
    async transferTo(userId, asset, amount) {
        this.logger.info(`Transferred ${amount} ${asset} to user ${userId}`);
        // This would integrate with wallet system
    }
    
    /**
     * Stop reward distributor
     */
    async stop() {
        if (!this.isRunning) return;
        
        this.logger.info('Stopping reward distributor...');
        
        // Clear intervals
        // (Would need to store interval IDs)
        
        this.isRunning = false;
        this.logger.info('Reward distributor stopped');
    }
}

export default RewardDistributor;