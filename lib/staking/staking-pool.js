/**
 * Staking Pool for Otedama
 * High-performance staking with flexible rewards
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

export class StakingPool extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            minStakeAmount: config.minStakeAmount || 1,
            maxStakeAmount: config.maxStakeAmount || 1000000,
            cooldownPeriod: config.cooldownPeriod || 7 * 24 * 60 * 60 * 1000, // 7 days
            rewardInterval: config.rewardInterval || 24 * 60 * 60 * 1000, // 1 day
            baseAPY: config.baseAPY || 0.05, // 5% base APY
            maxAPY: config.maxAPY || 0.20, // 20% max APY
            emergencyWithdrawFee: config.emergencyWithdrawFee || 0.1, // 10%
            compoundingEnabled: config.compoundingEnabled !== false,
            ...config
        };
        
        this.logger = getLogger('StakingPool');
        
        // Staking pools for different assets
        this.pools = new Map(); // poolId -> pool
        
        // User stakes
        this.stakes = new Map(); // userId -> poolId -> stake
        
        // Reward history
        this.rewardHistory = new Map(); // userId -> rewards[]
        
        // Pool statistics
        this.poolStats = new Map(); // poolId -> stats
        
        this.isRunning = false;
    }
    
    /**
     * Start staking pool
     */
    async start() {
        if (this.isRunning) return;
        
        this.logger.info('Starting staking pool...');
        
        // Initialize default pools
        this.initializeDefaultPools();
        
        // Start reward distribution
        this.startRewardDistribution();
        
        // Start APY calculation
        this.startAPYCalculation();
        
        // Start statistics tracking
        this.startStatsTracking();
        
        this.isRunning = true;
        this.logger.info('Staking pool started');
    }
    
    /**
     * Initialize default staking pools
     */
    initializeDefaultPools() {
        // OTD Token Staking
        this.createPool({
            poolId: 'OTD-STAKING',
            asset: 'OTD',
            name: 'OTD Token Staking',
            description: 'Stake OTD tokens to earn rewards',
            minLockPeriod: 0, // No lock
            rewardAsset: 'OTD',
            baseAPY: 0.08, // 8%
            bonusAPY: {
                '30d': 0.02,  // +2% for 30 days
                '90d': 0.05,  // +5% for 90 days
                '180d': 0.10, // +10% for 180 days
                '365d': 0.15  // +15% for 365 days
            }
        });
        
        // BTC Staking
        this.createPool({
            poolId: 'BTC-STAKING',
            asset: 'BTC',
            name: 'Bitcoin Staking',
            description: 'Stake BTC to earn OTD rewards',
            minLockPeriod: 7 * 24 * 60 * 60 * 1000, // 7 days
            rewardAsset: 'OTD',
            baseAPY: 0.04, // 4%
            bonusAPY: {
                '30d': 0.01,
                '90d': 0.02,
                '180d': 0.03
            }
        });
        
        // ETH Staking
        this.createPool({
            poolId: 'ETH-STAKING',
            asset: 'ETH',
            name: 'Ethereum Staking',
            description: 'Stake ETH to earn rewards',
            minLockPeriod: 0,
            rewardAsset: 'ETH',
            baseAPY: 0.05, // 5%
            bonusAPY: {
                '30d': 0.01,
                '90d': 0.02
            }
        });
        
        // LP Token Staking
        this.createPool({
            poolId: 'LP-OTD-USDT',
            asset: 'LP-OTD-USDT',
            name: 'OTD-USDT LP Staking',
            description: 'Stake LP tokens to earn bonus rewards',
            minLockPeriod: 0,
            rewardAsset: 'OTD',
            baseAPY: 0.15, // 15% for LP providers
            bonusAPY: {
                '30d': 0.05,
                '90d': 0.10
            }
        });
    }
    
    /**
     * Create staking pool
     */
    createPool(params) {
        const {
            poolId,
            asset,
            name,
            description,
            minLockPeriod = 0,
            maxLockPeriod = 365 * 24 * 60 * 60 * 1000, // 1 year
            rewardAsset = asset,
            baseAPY = this.config.baseAPY,
            bonusAPY = {},
            minStake = this.config.minStakeAmount,
            maxStake = this.config.maxStakeAmount,
            totalCap = 0, // 0 = unlimited
            enabled = true
        } = params;
        
        if (this.pools.has(poolId)) {
            throw new Error(`Pool ${poolId} already exists`);
        }
        
        const pool = {
            poolId,
            asset,
            name,
            description,
            minLockPeriod,
            maxLockPeriod,
            rewardAsset,
            baseAPY,
            bonusAPY,
            minStake,
            maxStake,
            totalCap,
            enabled,
            totalStaked: 0,
            totalRewards: 0,
            stakersCount: 0,
            createdAt: Date.now(),
            lastRewardTime: Date.now()
        };
        
        this.pools.set(poolId, pool);
        this.poolStats.set(poolId, {
            tvl: 0,
            apy: baseAPY,
            dailyRewards: 0,
            totalDistributed: 0
        });
        
        this.logger.info(`Created staking pool: ${poolId}`);
        this.emit('pool-created', pool);
        
        return pool;
    }
    
    /**
     * Stake assets
     */
    async stake(params) {
        const {
            userId,
            poolId,
            amount,
            lockPeriod = 0 // in milliseconds
        } = params;
        
        const pool = this.pools.get(poolId);
        if (!pool || !pool.enabled) {
            throw new Error(`Pool ${poolId} not available`);
        }
        
        // Validate amount
        if (amount < pool.minStake || amount > pool.maxStake) {
            throw new Error(`Stake amount must be between ${pool.minStake} and ${pool.maxStake}`);
        }
        
        // Check pool cap
        if (pool.totalCap > 0 && pool.totalStaked + amount > pool.totalCap) {
            throw new Error('Pool capacity reached');
        }
        
        // Check user balance
        const balance = await this.getUserBalance(userId, pool.asset);
        if (balance < amount) {
            throw new Error('Insufficient balance');
        }
        
        // Calculate lock bonus
        const lockBonus = this.calculateLockBonus(pool, lockPeriod);
        const effectiveAPY = pool.baseAPY + lockBonus;
        
        // Get or create user stakes
        if (!this.stakes.has(userId)) {
            this.stakes.set(userId, new Map());
        }
        const userStakes = this.stakes.get(userId);
        
        // Create stake entry
        const stakeId = this.generateStakeId();
        const stake = {
            stakeId,
            userId,
            poolId,
            amount,
            stakedAt: Date.now(),
            lockPeriod,
            unlockTime: lockPeriod > 0 ? Date.now() + lockPeriod : 0,
            effectiveAPY,
            rewards: 0,
            lastRewardCalculation: Date.now(),
            compounded: 0,
            status: 'active'
        };
        
        // Update pool stats
        pool.totalStaked += amount;
        pool.stakersCount++;
        
        // Store stake
        if (!userStakes.has(poolId)) {
            userStakes.set(poolId, []);
        }
        userStakes.get(poolId).push(stake);
        
        // Transfer assets from user
        await this.transferFrom(userId, pool.asset, amount);
        
        // Update TVL
        this.updatePoolTVL(poolId);
        
        this.emit('staked', {
            userId,
            poolId,
            stakeId,
            amount,
            lockPeriod,
            effectiveAPY,
            timestamp: Date.now()
        });
        
        return {
            stakeId,
            amount,
            effectiveAPY,
            unlockTime: stake.unlockTime
        };
    }
    
    /**
     * Unstake assets
     */
    async unstake(params) {
        const {
            userId,
            stakeId,
            amount = 0 // 0 = unstake all
        } = params;
        
        const userStakes = this.stakes.get(userId);
        if (!userStakes) {
            throw new Error('No stakes found');
        }
        
        // Find stake
        let stake = null;
        let poolId = null;
        
        for (const [pid, stakes] of userStakes) {
            const found = stakes.find(s => s.stakeId === stakeId);
            if (found) {
                stake = found;
                poolId = pid;
                break;
            }
        }
        
        if (!stake || stake.status !== 'active') {
            throw new Error('Active stake not found');
        }
        
        const pool = this.pools.get(poolId);
        
        // Check lock period
        const now = Date.now();
        if (stake.unlockTime > 0 && now < stake.unlockTime) {
            // Allow emergency withdrawal with penalty
            const timeRemaining = stake.unlockTime - now;
            const penalty = stake.amount * this.config.emergencyWithdrawFee;
            
            this.logger.warn(`Emergency withdrawal for stake ${stakeId}, penalty: ${penalty}`);
            
            // Apply penalty
            stake.amount -= penalty;
            pool.totalStaked -= penalty;
            
            // Add penalty to rewards pool
            pool.totalRewards += penalty;
        }
        
        // Calculate final rewards
        const rewards = this.calculateRewards(stake);
        stake.rewards = rewards;
        
        // Determine unstake amount
        const unstakeAmount = amount > 0 ? 
            Math.min(amount, stake.amount) : stake.amount;
        
        if (unstakeAmount === 0) {
            throw new Error('Nothing to unstake');
        }
        
        // Update stake
        stake.amount -= unstakeAmount;
        pool.totalStaked -= unstakeAmount;
        
        if (stake.amount === 0) {
            // Full unstake
            stake.status = 'completed';
            stake.completedAt = now;
            pool.stakersCount--;
            
            // Remove from active stakes
            const poolStakes = userStakes.get(poolId);
            const index = poolStakes.indexOf(stake);
            if (index > -1) {
                poolStakes.splice(index, 1);
            }
        }
        
        // Transfer assets to user
        await this.transferTo(userId, pool.asset, unstakeAmount);
        
        // Transfer rewards
        if (rewards > 0) {
            await this.transferTo(userId, pool.rewardAsset, rewards);
        }
        
        // Update TVL
        this.updatePoolTVL(poolId);
        
        this.emit('unstaked', {
            userId,
            poolId,
            stakeId,
            amount: unstakeAmount,
            rewards,
            timestamp: now
        });
        
        return {
            unstakedAmount: unstakeAmount,
            rewards,
            remainingStake: stake.amount
        };
    }
    
    /**
     * Claim rewards without unstaking
     */
    async claimRewards(userId, stakeId) {
        const userStakes = this.stakes.get(userId);
        if (!userStakes) {
            throw new Error('No stakes found');
        }
        
        // Find stake
        let stake = null;
        let poolId = null;
        
        for (const [pid, stakes] of userStakes) {
            const found = stakes.find(s => s.stakeId === stakeId);
            if (found) {
                stake = found;
                poolId = pid;
                break;
            }
        }
        
        if (!stake || stake.status !== 'active') {
            throw new Error('Active stake not found');
        }
        
        const pool = this.pools.get(poolId);
        
        // Calculate rewards
        const rewards = this.calculateRewards(stake);
        
        if (rewards === 0) {
            throw new Error('No rewards to claim');
        }
        
        // Update stake
        stake.lastRewardCalculation = Date.now();
        stake.rewards = 0; // Reset after claiming
        
        // Transfer rewards
        await this.transferTo(userId, pool.rewardAsset, rewards);
        
        // Record reward history
        this.recordReward(userId, {
            poolId,
            stakeId,
            amount: rewards,
            asset: pool.rewardAsset,
            timestamp: Date.now()
        });
        
        this.emit('rewards-claimed', {
            userId,
            poolId,
            stakeId,
            rewards,
            timestamp: Date.now()
        });
        
        return {
            rewards,
            asset: pool.rewardAsset
        };
    }
    
    /**
     * Compound rewards (reinvest)
     */
    async compound(userId, stakeId) {
        const userStakes = this.stakes.get(userId);
        if (!userStakes) {
            throw new Error('No stakes found');
        }
        
        // Find stake
        let stake = null;
        let poolId = null;
        
        for (const [pid, stakes] of userStakes) {
            const found = stakes.find(s => s.stakeId === stakeId);
            if (found) {
                stake = found;
                poolId = pid;
                break;
            }
        }
        
        if (!stake || stake.status !== 'active') {
            throw new Error('Active stake not found');
        }
        
        const pool = this.pools.get(poolId);
        
        // Only compound if reward asset matches stake asset
        if (pool.rewardAsset !== pool.asset) {
            throw new Error('Cannot compound: reward asset differs from stake asset');
        }
        
        // Calculate rewards
        const rewards = this.calculateRewards(stake);
        
        if (rewards === 0) {
            throw new Error('No rewards to compound');
        }
        
        // Add rewards to stake
        stake.amount += rewards;
        stake.compounded += rewards;
        stake.lastRewardCalculation = Date.now();
        stake.rewards = 0;
        
        // Update pool
        pool.totalStaked += rewards;
        
        this.emit('rewards-compounded', {
            userId,
            poolId,
            stakeId,
            amount: rewards,
            newTotal: stake.amount,
            timestamp: Date.now()
        });
        
        return {
            compoundedAmount: rewards,
            newStakeTotal: stake.amount
        };
    }
    
    /**
     * Calculate rewards for a stake
     */
    calculateRewards(stake) {
        const now = Date.now();
        const timePassed = now - stake.lastRewardCalculation;
        const daysStaked = timePassed / (24 * 60 * 60 * 1000);
        
        // Calculate reward based on APY
        const principal = stake.amount;
        const rate = stake.effectiveAPY / 365; // Daily rate
        const rewards = principal * rate * daysStaked;
        
        return rewards;
    }
    
    /**
     * Calculate lock bonus APY
     */
    calculateLockBonus(pool, lockPeriod) {
        if (lockPeriod === 0) return 0;
        
        const days = lockPeriod / (24 * 60 * 60 * 1000);
        let bonus = 0;
        
        // Find applicable bonus tier
        const tiers = Object.entries(pool.bonusAPY).sort((a, b) => {
            const daysA = parseInt(a[0]);
            const daysB = parseInt(b[0]);
            return daysB - daysA;
        });
        
        for (const [tierDays, tierBonus] of tiers) {
            const requiredDays = parseInt(tierDays.replace('d', ''));
            if (days >= requiredDays) {
                bonus = tierBonus;
                break;
            }
        }
        
        return bonus;
    }
    
    /**
     * Get user stakes
     */
    getUserStakes(userId) {
        const userStakes = this.stakes.get(userId);
        if (!userStakes) return [];
        
        const allStakes = [];
        
        for (const [poolId, stakes] of userStakes) {
            const pool = this.pools.get(poolId);
            for (const stake of stakes) {
                if (stake.status === 'active') {
                    // Calculate current rewards
                    const currentRewards = this.calculateRewards(stake);
                    
                    allStakes.push({
                        ...stake,
                        poolName: pool.name,
                        asset: pool.asset,
                        rewardAsset: pool.rewardAsset,
                        currentRewards,
                        totalValue: stake.amount + currentRewards
                    });
                }
            }
        }
        
        return allStakes;
    }
    
    /**
     * Get pool information
     */
    getPoolInfo(poolId) {
        const pool = this.pools.get(poolId);
        if (!pool) return null;
        
        const stats = this.poolStats.get(poolId);
        
        return {
            ...pool,
            tvl: stats.tvl,
            currentAPY: stats.apy,
            dailyRewards: stats.dailyRewards,
            totalDistributed: stats.totalDistributed,
            utilizationRate: pool.totalCap > 0 ? 
                pool.totalStaked / pool.totalCap : 0
        };
    }
    
    /**
     * Get all pools
     */
    getAllPools() {
        const pools = [];
        
        for (const [poolId, pool] of this.pools) {
            pools.push(this.getPoolInfo(poolId));
        }
        
        return pools;
    }
    
    /**
     * Update pool TVL
     */
    async updatePoolTVL(poolId) {
        const pool = this.pools.get(poolId);
        if (!pool) return;
        
        const stats = this.poolStats.get(poolId);
        const price = await this.getAssetPrice(pool.asset);
        
        stats.tvl = pool.totalStaked * price;
        
        this.emit('tvl-updated', {
            poolId,
            tvl: stats.tvl,
            totalStaked: pool.totalStaked
        });
    }
    
    /**
     * Start reward distribution
     */
    startRewardDistribution() {
        setInterval(() => {
            this.distributeRewards();
        }, 60 * 60 * 1000); // Every hour
    }
    
    /**
     * Distribute rewards to all stakers
     */
    async distributeRewards() {
        for (const [poolId, pool] of this.pools) {
            if (!pool.enabled) continue;
            
            const stats = this.poolStats.get(poolId);
            let totalDistributed = 0;
            
            // Process all stakes in pool
            for (const [userId, userStakes] of this.stakes) {
                const poolStakes = userStakes.get(poolId);
                if (!poolStakes) continue;
                
                for (const stake of poolStakes) {
                    if (stake.status !== 'active') continue;
                    
                    // Auto-compound if enabled
                    if (this.config.compoundingEnabled && 
                        pool.rewardAsset === pool.asset) {
                        try {
                            const result = await this.compound(userId, stake.stakeId);
                            totalDistributed += result.compoundedAmount;
                        } catch (error) {
                            // Just accumulate rewards if compound fails
                            const rewards = this.calculateRewards(stake);
                            stake.rewards += rewards;
                            totalDistributed += rewards;
                        }
                    } else {
                        // Just accumulate rewards
                        const rewards = this.calculateRewards(stake);
                        stake.rewards += rewards;
                        totalDistributed += rewards;
                    }
                }
            }
            
            stats.dailyRewards = totalDistributed * 24; // Hourly to daily
            stats.totalDistributed += totalDistributed;
            pool.lastRewardTime = Date.now();
        }
    }
    
    /**
     * Start APY calculation
     */
    startAPYCalculation() {
        setInterval(() => {
            this.updateAPYs();
        }, 5 * 60 * 1000); // Every 5 minutes
    }
    
    /**
     * Update pool APYs based on utilization
     */
    updateAPYs() {
        for (const [poolId, pool] of this.pools) {
            const stats = this.poolStats.get(poolId);
            
            // Dynamic APY based on pool utilization
            let dynamicAPY = pool.baseAPY;
            
            if (pool.totalCap > 0) {
                const utilization = pool.totalStaked / pool.totalCap;
                
                // Higher utilization = lower APY
                if (utilization > 0.9) {
                    dynamicAPY *= 0.8; // 20% reduction
                } else if (utilization > 0.7) {
                    dynamicAPY *= 0.9; // 10% reduction
                } else if (utilization < 0.3) {
                    dynamicAPY *= 1.2; // 20% bonus for low utilization
                }
            }
            
            // Apply max APY cap
            stats.apy = Math.min(dynamicAPY, this.config.maxAPY);
            
            this.emit('apy-updated', {
                poolId,
                apy: stats.apy,
                utilization: pool.totalCap > 0 ? 
                    pool.totalStaked / pool.totalCap : 0
            });
        }
    }
    
    /**
     * Start statistics tracking
     */
    startStatsTracking() {
        setInterval(() => {
            this.updateStats();
        }, 60 * 1000); // Every minute
    }
    
    /**
     * Update statistics
     */
    async updateStats() {
        for (const [poolId, pool] of this.pools) {
            await this.updatePoolTVL(poolId);
        }
    }
    
    /**
     * Record reward distribution
     */
    recordReward(userId, reward) {
        if (!this.rewardHistory.has(userId)) {
            this.rewardHistory.set(userId, []);
        }
        
        const history = this.rewardHistory.get(userId);
        history.push(reward);
        
        // Keep last 100 rewards
        if (history.length > 100) {
            history.shift();
        }
    }
    
    /**
     * Get user reward history
     */
    getUserRewardHistory(userId) {
        return this.rewardHistory.get(userId) || [];
    }
    
    /**
     * Helper functions
     */
    generateStakeId() {
        return `STAKE-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    async getAssetPrice(asset) {
        // This would integrate with price oracle
        const prices = {
            'OTD': 1,
            'BTC': 40000,
            'ETH': 2500,
            'USDT': 1,
            'LP-OTD-USDT': 2 // LP tokens worth 2x
        };
        return prices[asset] || 0;
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
     * Admin functions
     */
    updatePoolAPY(poolId, newAPY) {
        const pool = this.pools.get(poolId);
        if (pool) {
            pool.baseAPY = newAPY;
            this.updateAPYs();
        }
    }
    
    pausePool(poolId) {
        const pool = this.pools.get(poolId);
        if (pool) {
            pool.enabled = false;
            this.emit('pool-paused', { poolId });
        }
    }
    
    resumePool(poolId) {
        const pool = this.pools.get(poolId);
        if (pool) {
            pool.enabled = true;
            this.emit('pool-resumed', { poolId });
        }
    }
    
    /**
     * Stop staking pool
     */
    async stop() {
        if (!this.isRunning) return;
        
        this.logger.info('Stopping staking pool...');
        
        // Clear intervals
        // (Would need to store interval IDs)
        
        this.isRunning = false;
        this.logger.info('Staking pool stopped');
    }
}

export default StakingPool;