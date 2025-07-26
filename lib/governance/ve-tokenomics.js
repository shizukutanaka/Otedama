/**
 * veTokenomics System - Otedama
 * Vote-escrowed tokenomics for enhanced rewards and governance participation
 * Users lock tokens for increased mining rewards and voting power
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('VeTokenomics');

/**
 * Lock periods in seconds
 */
export const LockPeriod = {
  THREE_MONTHS: 7776000,   // 90 days
  SIX_MONTHS: 15552000,    // 180 days
  ONE_YEAR: 31536000,      // 365 days
  TWO_YEARS: 63072000,     // 730 days
  FOUR_YEARS: 126144000    // 1460 days (max)
};

/**
 * Lock types
 */
export const LockType = {
  MINING_BOOST: 'mining_boost',     // Boost mining rewards
  GOVERNANCE: 'governance',         // Governance voting power
  FEE_SHARE: 'fee_share',          // Share of protocol fees
  COMBINED: 'combined'              // All benefits
};

/**
 * veTokenomics Manager
 */
export class VeTokenomics extends EventEmitter {
  constructor(pool, options = {}) {
    super();
    
    this.pool = pool;
    this.config = {
      tokenSymbol: options.tokenSymbol || 'veOTEDAMA',
      maxLockPeriod: options.maxLockPeriod || LockPeriod.FOUR_YEARS,
      minLockPeriod: options.minLockPeriod || LockPeriod.THREE_MONTHS,
      maxBoostMultiplier: options.maxBoostMultiplier || 2.5, // 2.5x max boost
      decayRate: options.decayRate || 1, // Linear decay
      earlyWithdrawPenalty: options.earlyWithdrawPenalty || 0.5, // 50% penalty
      feeShareRatio: options.feeShareRatio || 0.5, // 50% of fees shared
      ...options
    };
    
    this.locks = new Map(); // userId -> lock data
    this.totalVeSupply = 0;
    this.totalLockedAmount = 0;
    this.feeAccumulator = 0;
    this.lastFeeDistribution = Date.now();
    
    this.stats = {
      totalLocks: 0,
      averageLockDuration: 0,
      totalRewardsDistributed: 0,
      totalFeeDistributed: 0,
      averageBoostMultiplier: 1,
      participationRate: 0
    };
  }
  
  /**
   * Initialize veTokenomics system
   */
  async initialize() {
    logger.info('Initializing veTokenomics system...');
    
    // Start monitoring cycles
    this.startDecayMonitoring();
    this.startFeeDistribution();
    this.startBoostCalculation();
    
    logger.info('veTokenomics system initialized');
    this.emit('initialized');
  }
  
  /**
   * Create new token lock
   */
  async createLock(params) {
    const {
      userId,
      amount,
      lockPeriod,
      lockType = LockType.COMBINED
    } = params;
    
    // Validate parameters
    if (amount <= 0) {
      throw new Error('Lock amount must be positive');
    }
    
    if (lockPeriod < this.config.minLockPeriod || lockPeriod > this.config.maxLockPeriod) {
      throw new Error(`Lock period must be between ${this.config.minLockPeriod} and ${this.config.maxLockPeriod} seconds`);
    }
    
    if (this.locks.has(userId)) {
      throw new Error('User already has an active lock. Use increaseLock or extendLock instead');
    }
    
    const lockEnd = Date.now() + (lockPeriod * 1000);
    const veAmount = this.calculateVeAmount(amount, lockPeriod);
    
    const lock = {
      userId,
      amount,
      veAmount,
      lockType,
      lockStart: Date.now(),
      lockEnd,
      lockPeriod,
      lastRewardClaim: Date.now(),
      totalRewardsClaimed: 0,
      boostMultiplier: this.calculateBoostMultiplier(veAmount, amount),
      isActive: true
    };
    
    // Transfer tokens to lock (in production, this would be a smart contract call)
    await this.transferToLock(userId, amount);
    
    // Update state
    this.locks.set(userId, lock);
    this.totalVeSupply += veAmount;
    this.totalLockedAmount += amount;
    this.stats.totalLocks++;
    
    // Update user's mining boost
    await this.updateMiningBoost(userId);
    
    logger.info(`Lock created for user ${userId}`, {
      amount,
      veAmount,
      lockPeriod: lockPeriod / 86400, // days
      boostMultiplier: lock.boostMultiplier
    });
    
    this.emit('lock:created', {
      userId,
      lock,
      veAmount,
      boostMultiplier: lock.boostMultiplier
    });
    
    return lock;
  }
  
  /**
   * Increase existing lock amount
   */
  async increaseLock(userId, additionalAmount) {
    const lock = this.locks.get(userId);
    if (!lock || !lock.isActive) {
      throw new Error('No active lock found for user');
    }
    
    if (additionalAmount <= 0) {
      throw new Error('Additional amount must be positive');
    }
    
    // Check if lock hasn't expired
    if (Date.now() >= lock.lockEnd) {
      throw new Error('Cannot increase expired lock');
    }
    
    // Transfer additional tokens
    await this.transferToLock(userId, additionalAmount);
    
    // Calculate remaining lock time
    const remainingTime = (lock.lockEnd - Date.now()) / 1000;
    const additionalVe = this.calculateVeAmount(additionalAmount, remainingTime);
    
    // Update lock
    lock.amount += additionalAmount;
    lock.veAmount += additionalVe;
    lock.boostMultiplier = this.calculateBoostMultiplier(lock.veAmount, lock.amount);
    
    // Update global state
    this.totalVeSupply += additionalVe;
    this.totalLockedAmount += additionalAmount;
    
    // Update mining boost
    await this.updateMiningBoost(userId);
    
    logger.info(`Lock increased for user ${userId}`, {
      additionalAmount,
      newTotalAmount: lock.amount,
      newVeAmount: lock.veAmount,
      newBoostMultiplier: lock.boostMultiplier
    });
    
    this.emit('lock:increased', {
      userId,
      additionalAmount,
      lock
    });
    
    return lock;
  }
  
  /**
   * Extend lock duration
   */
  async extendLock(userId, newLockPeriod) {
    const lock = this.locks.get(userId);
    if (!lock || !lock.isActive) {
      throw new Error('No active lock found for user');
    }
    
    if (newLockPeriod < this.config.minLockPeriod || newLockPeriod > this.config.maxLockPeriod) {
      throw new Error('Invalid lock period');
    }
    
    const newLockEnd = Date.now() + (newLockPeriod * 1000);
    
    // Cannot reduce lock time
    if (newLockEnd <= lock.lockEnd) {
      throw new Error('Cannot reduce lock duration');
    }
    
    // Calculate new veAmount
    const oldVeAmount = lock.veAmount;
    const newVeAmount = this.calculateVeAmount(lock.amount, newLockPeriod);
    
    // Update lock
    lock.lockEnd = newLockEnd;
    lock.lockPeriod = newLockPeriod;
    lock.veAmount = newVeAmount;
    lock.boostMultiplier = this.calculateBoostMultiplier(newVeAmount, lock.amount);
    
    // Update global state
    this.totalVeSupply += (newVeAmount - oldVeAmount);
    
    // Update mining boost
    await this.updateMiningBoost(userId);
    
    logger.info(`Lock extended for user ${userId}`, {
      newLockPeriod: newLockPeriod / 86400, // days
      newVeAmount,
      newBoostMultiplier: lock.boostMultiplier
    });
    
    this.emit('lock:extended', {
      userId,
      newLockPeriod,
      lock
    });
    
    return lock;
  }
  
  /**
   * Withdraw from expired lock
   */
  async withdraw(userId) {
    const lock = this.locks.get(userId);
    if (!lock || !lock.isActive) {
      throw new Error('No active lock found for user');
    }
    
    const now = Date.now();
    let withdrawAmount = lock.amount;
    let penalty = 0;
    
    // Check if lock has expired
    if (now < lock.lockEnd) {
      // Early withdrawal with penalty
      penalty = lock.amount * this.config.earlyWithdrawPenalty;
      withdrawAmount -= penalty;
      
      logger.warn(`Early withdrawal for user ${userId} with penalty ${penalty}`);
    }
    
    // Claim any pending rewards first
    await this.claimRewards(userId);
    
    // Update global state
    this.totalVeSupply -= lock.veAmount;
    this.totalLockedAmount -= lock.amount;
    
    // Transfer tokens back to user
    await this.transferFromLock(userId, withdrawAmount);
    
    // Handle penalty (send to treasury or burn)
    if (penalty > 0) {
      await this.handlePenalty(penalty);
    }
    
    // Deactivate lock
    lock.isActive = false;
    
    // Remove mining boost
    await this.removeMiningBoost(userId);
    
    logger.info(`Withdrawal completed for user ${userId}`, {
      withdrawAmount,
      penalty,
      wasEarly: now < lock.lockEnd
    });
    
    this.emit('lock:withdrawn', {
      userId,
      withdrawAmount,
      penalty,
      lock
    });
    
    return {
      withdrawAmount,
      penalty,
      wasEarly: now < lock.lockEnd
    };
  }
  
  /**
   * Claim accumulated rewards
   */
  async claimRewards(userId) {
    const lock = this.locks.get(userId);
    if (!lock || !lock.isActive) {
      throw new Error('No active lock found for user');
    }
    
    const rewards = await this.calculatePendingRewards(userId);
    
    if (rewards.total <= 0) {
      return { total: 0, breakdown: {} };
    }
    
    // Update last claim time
    lock.lastRewardClaim = Date.now();
    lock.totalRewardsClaimed += rewards.total;
    
    // Distribute rewards
    await this.distributeRewards(userId, rewards);
    
    // Update stats
    this.stats.totalRewardsDistributed += rewards.total;
    
    logger.info(`Rewards claimed for user ${userId}`, {
      total: rewards.total,
      breakdown: rewards.breakdown
    });
    
    this.emit('rewards:claimed', {
      userId,
      rewards
    });
    
    return rewards;
  }
  
  /**
   * Calculate pending rewards for a user
   */
  async calculatePendingRewards(userId) {
    const lock = this.locks.get(userId);
    if (!lock || !lock.isActive) {
      return { total: 0, breakdown: {} };
    }
    
    const now = Date.now();
    const timeSinceLastClaim = now - lock.lastRewardClaim;
    const userVeShare = lock.veAmount / this.totalVeSupply;
    
    const rewards = {
      total: 0,
      breakdown: {}
    };
    
    // 1. Mining boost rewards
    if (lock.lockType === LockType.MINING_BOOST || lock.lockType === LockType.COMBINED) {
      const miningRewards = await this.calculateMiningBoostRewards(userId, timeSinceLastClaim);
      rewards.breakdown.miningBoost = miningRewards;
      rewards.total += miningRewards;
    }
    
    // 2. Fee sharing rewards
    if (lock.lockType === LockType.FEE_SHARE || lock.lockType === LockType.COMBINED) {
      const feeRewards = this.calculateFeeShareRewards(userVeShare, timeSinceLastClaim);
      rewards.breakdown.feeShare = feeRewards;
      rewards.total += feeRewards;
    }
    
    // 3. Governance participation rewards
    if (lock.lockType === LockType.GOVERNANCE || lock.lockType === LockType.COMBINED) {
      const govRewards = await this.calculateGovernanceRewards(userId, timeSinceLastClaim);
      rewards.breakdown.governance = govRewards;
      rewards.total += govRewards;
    }
    
    return rewards;
  }
  
  /**
   * Calculate veToken amount based on lock amount and duration
   */
  calculateVeAmount(amount, lockPeriod) {
    // Linear relationship: longer locks get more voting power
    const maxPeriod = this.config.maxLockPeriod;
    const ratio = Math.min(lockPeriod / maxPeriod, 1);
    
    // veAmount = amount * (lockPeriod / maxLockPeriod)
    // Max veAmount is equal to amount when locked for max period
    return amount * ratio;
  }
  
  /**
   * Calculate mining boost multiplier
   */
  calculateBoostMultiplier(veAmount, lockedAmount) {
    if (lockedAmount === 0) return 1;
    
    // Boost is based on ve ratio, capped at maxBoostMultiplier
    const veRatio = veAmount / lockedAmount;
    const maxRatio = this.config.maxLockPeriod / this.config.maxLockPeriod; // 1
    
    const boost = 1 + (veRatio / maxRatio) * (this.config.maxBoostMultiplier - 1);
    return Math.min(boost, this.config.maxBoostMultiplier);
  }
  
  /**
   * Update mining boost for user
   */
  async updateMiningBoost(userId) {
    const lock = this.locks.get(userId);
    if (!lock || !lock.isActive) return;
    
    // Find connected miner for this user
    const miner = this.pool.getConnectedMiners().find(m => m.userId === userId);
    if (!miner) return;
    
    // Apply boost to miner
    miner.rewardMultiplier = lock.boostMultiplier;
    
    logger.debug(`Mining boost updated for user ${userId}: ${lock.boostMultiplier}x`);
    
    this.emit('boost:updated', {
      userId,
      multiplier: lock.boostMultiplier
    });
  }
  
  /**
   * Remove mining boost
   */
  async removeMiningBoost(userId) {
    const miner = this.pool.getConnectedMiners().find(m => m.userId === userId);
    if (miner) {
      miner.rewardMultiplier = 1.0;
    }
    
    this.emit('boost:removed', { userId });
  }
  
  /**
   * Calculate fee share rewards
   */
  calculateFeeShareRewards(userVeShare, timePeriod) {
    if (this.totalVeSupply === 0) return 0;
    
    // Calculate accumulated fees during time period
    const totalFees = this.feeAccumulator;
    const shareableFees = totalFees * this.config.feeShareRatio;
    
    return shareableFees * userVeShare * (timePeriod / 86400000); // Daily rate
  }
  
  /**
   * Calculate mining boost rewards
   */
  async calculateMiningBoostRewards(userId, timePeriod) {
    const miner = this.pool.getConnectedMiners().find(m => m.userId === userId);
    if (!miner) return 0;
    
    const lock = this.locks.get(userId);
    const baseRewards = miner.pendingRewards || 0;
    const boostedRewards = baseRewards * (lock.boostMultiplier - 1);
    
    return boostedRewards * (timePeriod / 86400000); // Daily rate
  }
  
  /**
   * Calculate governance rewards
   */
  async calculateGovernanceRewards(userId, timePeriod) {
    // Reward for governance participation
    const lock = this.locks.get(userId);
    const participationBonus = lock.veAmount * 0.001; // 0.1% per day
    
    return participationBonus * (timePeriod / 86400000);
  }
  
  /**
   * Process vote decay over time
   */
  async processDecay() {
    const now = Date.now();
    let totalDecay = 0;
    
    for (const [userId, lock] of this.locks) {
      if (!lock.isActive) continue;
      
      // Calculate time-based decay
      const remainingTime = Math.max(0, lock.lockEnd - now) / 1000;
      const newVeAmount = this.calculateVeAmount(lock.amount, remainingTime);
      
      // Update if changed
      if (newVeAmount !== lock.veAmount) {
        const decay = lock.veAmount - newVeAmount;
        totalDecay += decay;
        
        lock.veAmount = newVeAmount;
        lock.boostMultiplier = this.calculateBoostMultiplier(newVeAmount, lock.amount);
        
        // Update mining boost
        await this.updateMiningBoost(userId);
      }
      
      // Handle expired locks
      if (remainingTime === 0 && lock.isActive) {
        logger.info(`Lock expired for user ${userId}`);
        this.emit('lock:expired', { userId, lock });
      }
    }
    
    // Update total supply
    this.totalVeSupply -= totalDecay;
    
    if (totalDecay > 0) {
      logger.debug(`Processed decay: ${totalDecay} veTokens`);
      this.emit('decay:processed', { totalDecay });
    }
  }
  
  /**
   * Distribute protocol fees to veToken holders
   */
  async distributeFees() {
    if (this.feeAccumulator === 0 || this.totalVeSupply === 0) return;
    
    const shareableFees = this.feeAccumulator * this.config.feeShareRatio;
    let totalDistributed = 0;
    
    for (const [userId, lock] of this.locks) {
      if (!lock.isActive) continue;
      
      const userShare = lock.veAmount / this.totalVeSupply;
      const userFees = shareableFees * userShare;
      
      if (userFees > 0) {
        await this.distributeFeeShare(userId, userFees);
        totalDistributed += userFees;
      }
    }
    
    // Reset accumulator
    this.feeAccumulator = 0;
    this.lastFeeDistribution = Date.now();
    this.stats.totalFeeDistributed += totalDistributed;
    
    logger.info(`Distributed ${totalDistributed} in fees to veToken holders`);
    this.emit('fees:distributed', { totalDistributed });
  }
  
  /**
   * Get user's voting power
   */
  getVotingPower(userId) {
    const lock = this.locks.get(userId);
    if (!lock || !lock.isActive) return 0;
    
    return lock.veAmount;
  }
  
  /**
   * Get total voting power
   */
  getTotalVotingPower() {
    return this.totalVeSupply;
  }
  
  /**
   * Helper methods
   */
  async transferToLock(userId, amount) {
    // In production, this would transfer tokens to the locking contract
    logger.debug(`Locking ${amount} tokens for user ${userId}`);
  }
  
  async transferFromLock(userId, amount) {
    // In production, this would transfer tokens from the locking contract
    logger.debug(`Releasing ${amount} tokens to user ${userId}`);
  }
  
  async handlePenalty(penalty) {
    // Send penalty to treasury or burn
    logger.info(`Handling penalty: ${penalty} tokens`);
  }
  
  async distributeRewards(userId, rewards) {
    // Distribute rewards to user
    logger.debug(`Distributing ${rewards.total} rewards to user ${userId}`);
  }
  
  async distributeFeeShare(userId, amount) {
    // Distribute fee share to user
    logger.debug(`Distributing ${amount} fee share to user ${userId}`);
  }
  
  /**
   * Start monitoring cycles
   */
  startDecayMonitoring() {
    setInterval(() => {
      this.processDecay();
    }, 3600000); // Every hour
  }
  
  startFeeDistribution() {
    setInterval(() => {
      this.distributeFees();
    }, 86400000); // Daily
  }
  
  startBoostCalculation() {
    setInterval(() => {
      this.updateStatistics();
    }, 300000); // Every 5 minutes
  }
  
  /**
   * Update statistics
   */
  updateStatistics() {
    const activeLocks = Array.from(this.locks.values()).filter(lock => lock.isActive);
    
    if (activeLocks.length === 0) return;
    
    // Calculate average lock duration
    const totalDuration = activeLocks.reduce((sum, lock) => 
      sum + (lock.lockEnd - lock.lockStart), 0
    );
    this.stats.averageLockDuration = totalDuration / activeLocks.length / 86400000; // days
    
    // Calculate average boost multiplier
    const totalBoost = activeLocks.reduce((sum, lock) => sum + lock.boostMultiplier, 0);
    this.stats.averageBoostMultiplier = totalBoost / activeLocks.length;
    
    // Calculate participation rate
    const totalUsers = this.pool.getConnectedMiners().length;
    this.stats.participationRate = totalUsers > 0 ? activeLocks.length / totalUsers : 0;
  }
  
  /**
   * Get lock info for user
   */
  getLockInfo(userId) {
    const lock = this.locks.get(userId);
    if (!lock) return null;
    
    const now = Date.now();
    const remainingTime = Math.max(0, lock.lockEnd - now);
    
    return {
      ...lock,
      remainingTime,
      isExpired: remainingTime === 0,
      currentVotingPower: lock.veAmount,
      pendingRewards: this.calculatePendingRewards(userId)
    };
  }
  
  /**
   * Add fees to accumulator
   */
  addFees(amount) {
    this.feeAccumulator += amount;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      totalVeSupply: this.totalVeSupply,
      totalLockedAmount: this.totalLockedAmount,
      activeLocks: Array.from(this.locks.values()).filter(lock => lock.isActive).length,
      feeAccumulator: this.feeAccumulator,
      averageLockDuration: this.stats.averageLockDuration,
      participationRate: this.stats.participationRate
    };
  }
  
  /**
   * Shutdown
   */
  shutdown() {
    this.removeAllListeners();
    logger.info('veTokenomics system shutdown');
  }
}

export default VeTokenomics;