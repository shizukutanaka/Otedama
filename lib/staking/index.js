/**
 * Staking Module for Otedama
 * Unified interface for staking, governance, and rewards
 */

import { EventEmitter } from 'events';
import { StakingPool } from './staking-pool.js';
import { GovernanceSystem } from './governance.js';
import { RewardDistributor } from './reward-distributor.js';
import { getLogger } from '../core/logger.js';

export class StakingManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            enableStaking: config.enableStaking !== false,
            enableGovernance: config.enableGovernance !== false,
            enableRewards: config.enableRewards !== false,
            ...config
        };
        
        this.logger = getLogger('StakingManager');
        
        // Components
        this.stakingPool = null;
        this.governance = null;
        this.rewardDistributor = null;
        
        // Statistics
        this.stats = {
            totalValueStaked: 0,
            totalRewardsDistributed: 0,
            activeStakers: 0,
            activeProposals: 0
        };
        
        this.isRunning = false;
    }
    
    /**
     * Start staking manager
     */
    async start() {
        if (this.isRunning) return;
        
        this.logger.info('Starting staking manager...');
        
        // Initialize staking pool
        if (this.config.enableStaking) {
            this.stakingPool = new StakingPool(this.config.staking);
            await this.stakingPool.start();
            this.setupStakingListeners();
        }
        
        // Initialize governance
        if (this.config.enableGovernance) {
            this.governance = new GovernanceSystem(this.config.governance);
            await this.governance.start();
            this.setupGovernanceListeners();
        }
        
        // Initialize reward distributor
        if (this.config.enableRewards) {
            this.rewardDistributor = new RewardDistributor(this.config.rewards);
            await this.rewardDistributor.start();
            this.setupRewardListeners();
        }
        
        // Start statistics tracking
        this.startStatsTracking();
        
        this.isRunning = true;
        this.logger.info('Staking manager started');
    }
    
    /**
     * Setup event listeners
     */
    setupStakingListeners() {
        this.stakingPool.on('staked', (data) => {
            this.updateStats();
            this.emit('stake', data);
        });
        
        this.stakingPool.on('unstaked', (data) => {
            this.updateStats();
            this.emit('unstake', data);
        });
        
        this.stakingPool.on('rewards-claimed', (data) => {
            this.emit('rewards-claimed', data);
        });
        
        this.stakingPool.on('rewards-compounded', (data) => {
            this.emit('rewards-compounded', data);
        });
    }
    
    setupGovernanceListeners() {
        this.governance.on('proposal-created', (proposal) => {
            this.updateStats();
            this.emit('proposal-created', proposal);
        });
        
        this.governance.on('vote-cast', (vote) => {
            this.emit('vote-cast', vote);
        });
        
        this.governance.on('proposal-executed', (proposal) => {
            this.updateStats();
            this.emit('proposal-executed', proposal);
        });
    }
    
    setupRewardListeners() {
        this.rewardDistributor.on('distribution-completed', (results) => {
            this.stats.totalRewardsDistributed += Array.from(results.totalDistributed.values())
                .reduce((sum, amount) => sum + amount, 0);
            this.emit('rewards-distributed', results);
        });
        
        this.rewardDistributor.on('revenue-added', (data) => {
            this.emit('revenue-added', data);
        });
    }
    
    /**
     * Staking operations
     */
    async stake(userId, poolId, amount, lockPeriod = 0) {
        if (!this.stakingPool) {
            throw new Error('Staking is not enabled');
        }
        
        return await this.stakingPool.stake({
            userId,
            poolId,
            amount,
            lockPeriod
        });
    }
    
    async unstake(userId, stakeId, amount = 0) {
        if (!this.stakingPool) {
            throw new Error('Staking is not enabled');
        }
        
        return await this.stakingPool.unstake({
            userId,
            stakeId,
            amount
        });
    }
    
    async claimStakingRewards(userId, stakeId) {
        if (!this.stakingPool) {
            throw new Error('Staking is not enabled');
        }
        
        return await this.stakingPool.claimRewards(userId, stakeId);
    }
    
    async compound(userId, stakeId) {
        if (!this.stakingPool) {
            throw new Error('Staking is not enabled');
        }
        
        return await this.stakingPool.compound(userId, stakeId);
    }
    
    /**
     * Governance operations
     */
    async createProposal(params) {
        if (!this.governance) {
            throw new Error('Governance is not enabled');
        }
        
        return await this.governance.createProposal(params);
    }
    
    async vote(userId, proposalId, support, reason = '') {
        if (!this.governance) {
            throw new Error('Governance is not enabled');
        }
        
        return await this.governance.vote({
            userId,
            proposalId,
            support,
            reason
        });
    }
    
    async executeProposal(proposalId) {
        if (!this.governance) {
            throw new Error('Governance is not enabled');
        }
        
        return await this.governance.executeProposal(proposalId);
    }
    
    /**
     * Reward operations
     */
    async claimRewards(userId) {
        if (!this.rewardDistributor) {
            throw new Error('Rewards are not enabled');
        }
        
        return await this.rewardDistributor.claimRewards(userId);
    }
    
    /**
     * Get user information
     */
    getUserStakes(userId) {
        if (!this.stakingPool) return [];
        return this.stakingPool.getUserStakes(userId);
    }
    
    getUserVotingPower(userId) {
        if (!this.governance) return 0;
        return this.governance.getVotingPower(userId);
    }
    
    getUserPendingRewards(userId) {
        if (!this.rewardDistributor) return [];
        return this.rewardDistributor.getPendingRewards(userId);
    }
    
    /**
     * Get complete user position
     */
    async getUserPosition(userId) {
        const position = {
            stakes: [],
            votingPower: 0,
            pendingRewards: [],
            totalStaked: 0,
            totalRewards: 0
        };
        
        // Get stakes
        if (this.stakingPool) {
            position.stakes = this.getUserStakes(userId);
            position.totalStaked = position.stakes.reduce(
                (sum, stake) => sum + stake.amount, 0
            );
        }
        
        // Get voting power
        if (this.governance) {
            position.votingPower = await this.getUserVotingPower(userId);
        }
        
        // Get pending rewards
        if (this.rewardDistributor) {
            position.pendingRewards = this.getUserPendingRewards(userId);
            position.totalRewards = position.pendingRewards.reduce(
                (sum, reward) => sum + reward.amount, 0
            );
        }
        
        return position;
    }
    
    /**
     * Get staking pools
     */
    getStakingPools() {
        if (!this.stakingPool) return [];
        return this.stakingPool.getAllPools();
    }
    
    /**
     * Get proposals
     */
    getProposals(filter = {}) {
        if (!this.governance) return [];
        return this.governance.getProposals(filter);
    }
    
    /**
     * Get specific proposal
     */
    getProposal(proposalId) {
        if (!this.governance) return null;
        return this.governance.getProposal(proposalId);
    }
    
    /**
     * Get statistics
     */
    getStats() {
        const stats = {
            ...this.stats,
            pools: [],
            governance: null,
            rewards: null
        };
        
        // Staking stats
        if (this.stakingPool) {
            stats.pools = this.getStakingPools().map(pool => ({
                poolId: pool.poolId,
                name: pool.name,
                tvl: pool.tvl,
                apy: pool.currentAPY,
                stakers: pool.stakersCount
            }));
        }
        
        // Governance stats
        if (this.governance) {
            stats.governance = this.governance.getStats();
        }
        
        // Reward stats
        if (this.rewardDistributor) {
            stats.rewards = this.rewardDistributor.getStats();
        }
        
        return stats;
    }
    
    /**
     * Update statistics
     */
    async updateStats() {
        // Calculate total value staked
        if (this.stakingPool) {
            let tvs = 0;
            let activeStakers = new Set();
            
            const pools = this.stakingPool.getAllPools();
            for (const pool of pools) {
                tvs += pool.tvl || 0;
                
                // Count unique stakers
                const poolStakes = this.stakingPool.stakes;
                for (const [userId, userStakes] of poolStakes) {
                    if (userStakes.has(pool.poolId)) {
                        activeStakers.add(userId);
                    }
                }
            }
            
            this.stats.totalValueStaked = tvs;
            this.stats.activeStakers = activeStakers.size;
        }
        
        // Count active proposals
        if (this.governance) {
            const proposals = this.governance.getProposals({ status: 'active' });
            this.stats.activeProposals = proposals.length;
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
     * Revenue tracking integration
     */
    addRevenue(source, asset, amount) {
        if (this.rewardDistributor) {
            this.rewardDistributor.addRevenue(source, asset, amount);
        }
    }
    
    /**
     * Admin functions
     */
    updatePoolAPY(poolId, newAPY) {
        if (this.stakingPool) {
            this.stakingPool.updatePoolAPY(poolId, newAPY);
        }
    }
    
    pauseStakingPool(poolId) {
        if (this.stakingPool) {
            this.stakingPool.pausePool(poolId);
        }
    }
    
    resumeStakingPool(poolId) {
        if (this.stakingPool) {
            this.stakingPool.resumePool(poolId);
        }
    }
    
    /**
     * Stop staking manager
     */
    async stop() {
        if (!this.isRunning) return;
        
        this.logger.info('Stopping staking manager...');
        
        if (this.stakingPool) {
            await this.stakingPool.stop();
        }
        
        if (this.governance) {
            await this.governance.stop();
        }
        
        if (this.rewardDistributor) {
            await this.rewardDistributor.stop();
        }
        
        this.isRunning = false;
        this.logger.info('Staking manager stopped');
    }
}

// Export components
export { StakingPool } from './staking-pool.js';
export { GovernanceSystem } from './governance.js';
export { RewardDistributor } from './reward-distributor.js';

export default StakingManager;