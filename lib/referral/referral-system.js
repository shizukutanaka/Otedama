/**
 * Referral System - Otedama
 * Tiered referral rewards system to maximize user acquisition and retention
 * Multi-level marketing structure with performance-based bonuses
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('ReferralSystem');

/**
 * Referral tiers
 */
export const ReferralTier = {
  BRONZE: 'bronze',     // Entry level
  SILVER: 'silver',     // 5+ referrals
  GOLD: 'gold',         // 15+ referrals
  PLATINUM: 'platinum', // 50+ referrals
  DIAMOND: 'diamond'    // 100+ referrals
};

/**
 * Reward types
 */
export const RewardType = {
  COMMISSION: 'commission',         // % of referral's earnings
  BONUS: 'bonus',                  // Fixed bonus amounts
  TIER_BONUS: 'tier_bonus',        // Tier upgrade bonuses
  VOLUME_BONUS: 'volume_bonus',    // Based on team volume
  LOYALTY_BONUS: 'loyalty_bonus'   // Long-term retention bonus
};

/**
 * Referral System
 */
export class ReferralSystem extends EventEmitter {
  constructor(pool, options = {}) {
    super();
    
    this.pool = pool;
    this.config = {
      // Commission rates by tier
      commissionRates: {
        [ReferralTier.BRONZE]: 0.05,   // 5%
        [ReferralTier.SILVER]: 0.08,   // 8%
        [ReferralTier.GOLD]: 0.12,     // 12%
        [ReferralTier.PLATINUM]: 0.15, // 15%
        [ReferralTier.DIAMOND]: 0.20   // 20%
      },
      
      // Tier requirements (number of direct referrals)
      tierRequirements: {
        [ReferralTier.BRONZE]: 0,
        [ReferralTier.SILVER]: 5,
        [ReferralTier.GOLD]: 15,
        [ReferralTier.PLATINUM]: 50,
        [ReferralTier.DIAMOND]: 100
      },
      
      // Multi-level commissions (levels deep)
      levelCommissions: {
        1: 0.15, // 15% from direct referrals
        2: 0.10, // 10% from 2nd level
        3: 0.05, // 5% from 3rd level
        4: 0.03, // 3% from 4th level
        5: 0.02  // 2% from 5th level
      },
      
      // Tier upgrade bonuses
      tierBonuses: {
        [ReferralTier.SILVER]: 100,   // $100
        [ReferralTier.GOLD]: 500,     // $500
        [ReferralTier.PLATINUM]: 2000, // $2000
        [ReferralTier.DIAMOND]: 10000  // $10000
      },
      
      minWithdrawal: options.minWithdrawal || 10, // $10 minimum
      payoutInterval: options.payoutInterval || 604800000, // Weekly
      maxLevels: options.maxLevels || 5,
      ...options
    };
    
    this.referrals = new Map(); // userId -> referral data
    this.referralTree = new Map(); // userId -> tree structure
    this.codes = new Map(); // code -> userId
    this.pendingRewards = new Map(); // userId -> pending rewards
    this.rewardHistory = [];
    
    this.stats = {
      totalReferrers: 0,
      totalReferrals: 0,
      totalCommissionsPaid: 0,
      totalBonusesPaid: 0,
      averageReferralsPerUser: 0,
      topPerformers: [],
      conversionRate: 0
    };
  }
  
  /**
   * Initialize referral system
   */
  async initialize() {
    logger.info('Initializing referral system...');
    
    // Start monitoring cycles
    this.startRewardTracking();
    this.startPayoutProcessing();
    this.startTierUpdates();
    this.startPerformanceTracking();
    
    logger.info('Referral system initialized');
    this.emit('initialized');
  }
  
  /**
   * Create referral account
   */
  async createReferralAccount(userId) {
    if (this.referrals.has(userId)) {
      throw new Error('Referral account already exists');
    }
    
    const referralCode = this.generateReferralCode(userId);
    
    const referralData = {
      userId,
      referralCode,
      tier: ReferralTier.BRONZE,
      directReferrals: [],
      totalReferrals: 0,
      totalEarnings: 0,
      pendingRewards: 0,
      lifetimeCommissions: 0,
      lifetimeBonuses: 0,
      createdAt: Date.now(),
      lastPayout: null,
      isActive: true,
      referredBy: null
    };
    
    this.referrals.set(userId, referralData);
    this.codes.set(referralCode, userId);
    
    // Initialize tree structure
    this.referralTree.set(userId, {
      parent: null,
      children: [],
      level: 0,
      teamVolume: 0
    });
    
    this.stats.totalReferrers++;
    
    logger.info(`Referral account created for user ${userId}`, {
      referralCode,
      tier: ReferralTier.BRONZE
    });
    
    this.emit('account:created', {
      userId,
      referralCode
    });
    
    return referralData;
  }
  
  /**
   * Process referral signup
   */
  async processReferral(newUserId, referralCode) {
    const referrerId = this.codes.get(referralCode);
    if (!referrerId) {
      throw new Error('Invalid referral code');
    }
    
    const referrer = this.referrals.get(referrerId);
    if (!referrer || !referrer.isActive) {
      throw new Error('Referrer account not active');
    }
    
    // Create account for new user
    const newUserData = await this.createReferralAccount(newUserId);
    newUserData.referredBy = referrerId;
    
    // Update referrer's data
    referrer.directReferrals.push(newUserId);
    referrer.totalReferrals++;
    
    // Update referral tree
    const referrerTree = this.referralTree.get(referrerId);
    const newUserTree = this.referralTree.get(newUserId);
    
    newUserTree.parent = referrerId;
    newUserTree.level = referrerTree.level + 1;
    referrerTree.children.push(newUserId);
    
    // Check for tier upgrade
    await this.checkTierUpgrade(referrerId);
    
    // Award signup bonus
    await this.awardSignupBonus(referrerId, newUserId);
    
    this.stats.totalReferrals++;
    this.updateAverageReferrals();
    
    logger.info(`Referral processed: ${newUserId} referred by ${referrerId}`, {
      referrerTier: referrer.tier,
      referrerTotalReferrals: referrer.totalReferrals
    });
    
    this.emit('referral:processed', {
      referrerId,
      newUserId,
      referralCode
    });
    
    return {
      referrer: referrerId,
      newUser: newUserId,
      signupBonus: this.calculateSignupBonus(referrer.tier)
    };
  }
  
  /**
   * Calculate and award commissions
   */
  async calculateCommissions(userId, earnings) {
    const userTree = this.referralTree.get(userId);
    if (!userTree || !userTree.parent) return;
    
    let currentUserId = userTree.parent;
    let level = 1;
    const commissions = [];
    
    // Traverse up the referral tree
    while (currentUserId && level <= this.config.maxLevels) {
      const referrer = this.referrals.get(currentUserId);
      if (!referrer || !referrer.isActive) break;
      
      const levelRate = this.config.levelCommissions[level];
      const tierRate = this.config.commissionRates[referrer.tier];
      
      // Combined commission rate
      const totalRate = levelRate * tierRate;
      const commission = earnings * totalRate;
      
      if (commission > 0) {
        await this.awardCommission(currentUserId, {
          amount: commission,
          level,
          fromUser: userId,
          earnings,
          rate: totalRate,
          type: RewardType.COMMISSION
        });
        
        commissions.push({
          referrerId: currentUserId,
          level,
          amount: commission,
          rate: totalRate
        });
      }
      
      // Move up one level
      const parentTree = this.referralTree.get(currentUserId);
      currentUserId = parentTree?.parent;
      level++;
    }
    
    return commissions;
  }
  
  /**
   * Award commission to referrer
   */
  async awardCommission(referrerId, commission) {
    const referrer = this.referrals.get(referrerId);
    if (!referrer) return;
    
    // Add to pending rewards
    if (!this.pendingRewards.has(referrerId)) {
      this.pendingRewards.set(referrerId, []);
    }
    
    const reward = {
      id: this.generateRewardId(),
      type: commission.type,
      amount: commission.amount,
      level: commission.level,
      fromUser: commission.fromUser,
      timestamp: Date.now(),
      isPaid: false
    };
    
    this.pendingRewards.get(referrerId).push(reward);
    
    // Update referrer stats
    referrer.pendingRewards += commission.amount;
    referrer.lifetimeCommissions += commission.amount;
    
    logger.debug(`Commission awarded: ${commission.amount} to ${referrerId} from ${commission.fromUser} (Level ${commission.level})`);
    
    this.emit('commission:awarded', {
      referrerId,
      commission: reward
    });
  }
  
  /**
   * Check and process tier upgrades
   */
  async checkTierUpgrade(userId) {
    const referrer = this.referrals.get(userId);
    if (!referrer) return;
    
    const currentTier = referrer.tier;
    const directReferrals = referrer.directReferrals.length;
    
    // Find new tier based on referral count
    let newTier = currentTier;
    
    for (const [tier, requirement] of Object.entries(this.config.tierRequirements)) {
      if (directReferrals >= requirement) {
        newTier = tier;
      }
    }
    
    // Check if upgrade is needed
    if (newTier !== currentTier && this.getTierLevel(newTier) > this.getTierLevel(currentTier)) {
      const oldTier = currentTier;
      referrer.tier = newTier;
      
      // Award tier upgrade bonus
      const bonus = this.config.tierBonuses[newTier];
      if (bonus) {
        await this.awardBonus(userId, {
          amount: bonus,
          type: RewardType.TIER_BONUS,
          reason: `Tier upgrade to ${newTier}`,
          fromTier: oldTier,
          toTier: newTier
        });
      }
      
      logger.info(`Tier upgrade: ${userId} from ${oldTier} to ${newTier}`, {
        directReferrals,
        bonus
      });
      
      this.emit('tier:upgraded', {
        userId,
        oldTier,
        newTier,
        bonus,
        directReferrals
      });
    }
  }
  
  /**
   * Award various bonuses
   */
  async awardBonus(userId, bonus) {
    const referrer = this.referrals.get(userId);
    if (!referrer) return;
    
    if (!this.pendingRewards.has(userId)) {
      this.pendingRewards.set(userId, []);
    }
    
    const reward = {
      id: this.generateRewardId(),
      type: bonus.type,
      amount: bonus.amount,
      reason: bonus.reason,
      timestamp: Date.now(),
      isPaid: false,
      metadata: bonus
    };
    
    this.pendingRewards.get(userId).push(reward);
    
    referrer.pendingRewards += bonus.amount;
    referrer.lifetimeBonuses += bonus.amount;
    
    this.emit('bonus:awarded', {
      userId,
      bonus: reward
    });
  }
  
  /**
   * Calculate signup bonus
   */
  calculateSignupBonus(tier) {
    const bonuses = {
      [ReferralTier.BRONZE]: 5,
      [ReferralTier.SILVER]: 10,
      [ReferralTier.GOLD]: 20,
      [ReferralTier.PLATINUM]: 50,
      [ReferralTier.DIAMOND]: 100
    };
    
    return bonuses[tier] || 5;
  }
  
  /**
   * Award signup bonus
   */
  async awardSignupBonus(referrerId, newUserId) {
    const referrer = this.referrals.get(referrerId);
    if (!referrer) return;
    
    const bonusAmount = this.calculateSignupBonus(referrer.tier);
    
    await this.awardBonus(referrerId, {
      amount: bonusAmount,
      type: RewardType.BONUS,
      reason: `New referral signup: ${newUserId}`,
      newUser: newUserId
    });
  }
  
  /**
   * Process volume-based bonuses
   */
  async processVolumeBonus(userId, volume) {
    const referrer = this.referrals.get(userId);
    if (!referrer) return;
    
    // Update team volume
    await this.updateTeamVolume(userId, volume);
    
    // Check for volume milestones
    const tree = this.referralTree.get(userId);
    const teamVolume = tree.teamVolume;
    
    const volumeBonuses = [
      { threshold: 100000, bonus: 500 },   // $100k team volume = $500 bonus
      { threshold: 500000, bonus: 2500 },  // $500k team volume = $2500 bonus
      { threshold: 1000000, bonus: 10000 } // $1M team volume = $10k bonus
    ];
    
    for (const milestone of volumeBonuses) {
      if (teamVolume >= milestone.threshold && !referrer.volumeMilestones?.includes(milestone.threshold)) {
        await this.awardBonus(userId, {
          amount: milestone.bonus,
          type: RewardType.VOLUME_BONUS,
          reason: `Team volume milestone: $${milestone.threshold.toLocaleString()}`
        });
        
        if (!referrer.volumeMilestones) referrer.volumeMilestones = [];
        referrer.volumeMilestones.push(milestone.threshold);
      }
    }
  }
  
  /**
   * Update team volume
   */
  async updateTeamVolume(userId, volume) {
    const tree = this.referralTree.get(userId);
    if (!tree) return;
    
    tree.teamVolume += volume;
    
    // Propagate volume up the tree
    let currentUserId = tree.parent;
    while (currentUserId) {
      const parentTree = this.referralTree.get(currentUserId);
      if (!parentTree) break;
      
      parentTree.teamVolume += volume;
      currentUserId = parentTree.parent;
    }
  }
  
  /**
   * Process payouts
   */
  async processPayouts() {
    const payoutCandidates = Array.from(this.pendingRewards.entries())
      .filter(([userId, rewards]) => {
        const totalPending = rewards.reduce((sum, r) => r.isPaid ? 0 : sum + r.amount, 0);
        return totalPending >= this.config.minWithdrawal;
      });
    
    for (const [userId, rewards] of payoutCandidates) {
      try {
        await this.processPayout(userId);
      } catch (error) {
        logger.error(`Error processing payout for ${userId}:`, error);
      }
    }
  }
  
  /**
   * Process individual payout
   */
  async processPayout(userId) {
    const rewards = this.pendingRewards.get(userId) || [];
    const unpaidRewards = rewards.filter(r => !r.isPaid);
    
    if (unpaidRewards.length === 0) return;
    
    const totalAmount = unpaidRewards.reduce((sum, r) => sum + r.amount, 0);
    
    if (totalAmount < this.config.minWithdrawal) {
      logger.debug(`Payout amount ${totalAmount} below minimum ${this.config.minWithdrawal} for user ${userId}`);
      return;
    }
    
    // Execute payout
    await this.executePayout(userId, totalAmount);
    
    // Mark rewards as paid
    unpaidRewards.forEach(reward => {
      reward.isPaid = true;
      reward.paidAt = Date.now();
    });
    
    // Update referrer data
    const referrer = this.referrals.get(userId);
    if (referrer) {
      referrer.pendingRewards -= totalAmount;
      referrer.totalEarnings += totalAmount;
      referrer.lastPayout = Date.now();
    }
    
    // Record payout history
    this.rewardHistory.push({
      userId,
      amount: totalAmount,
      rewards: unpaidRewards.map(r => ({ id: r.id, type: r.type, amount: r.amount })),
      timestamp: Date.now()
    });
    
    // Update stats
    const commissionAmount = unpaidRewards.filter(r => r.type === RewardType.COMMISSION).reduce((sum, r) => sum + r.amount, 0);
    const bonusAmount = totalAmount - commissionAmount;
    
    this.stats.totalCommissionsPaid += commissionAmount;
    this.stats.totalBonusesPaid += bonusAmount;
    
    logger.info(`Payout processed for ${userId}: ${totalAmount}`, {
      commissions: commissionAmount,
      bonuses: bonusAmount,
      rewardCount: unpaidRewards.length
    });
    
    this.emit('payout:processed', {
      userId,
      amount: totalAmount,
      rewards: unpaidRewards
    });
  }
  
  /**
   * Execute actual payout
   */
  async executePayout(userId, amount) {
    // In production, this would transfer funds to user
    logger.debug(`Executing payout: ${amount} to user ${userId}`);
  }
  
  /**
   * Generate referral code
   */
  generateReferralCode(userId) {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 6);
    return `${timestamp}${random}`.toUpperCase();
  }
  
  /**
   * Generate reward ID
   */
  generateRewardId() {
    return `reward_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Get tier level (for comparison)
   */
  getTierLevel(tier) {
    const levels = {
      [ReferralTier.BRONZE]: 1,
      [ReferralTier.SILVER]: 2,
      [ReferralTier.GOLD]: 3,
      [ReferralTier.PLATINUM]: 4,
      [ReferralTier.DIAMOND]: 5
    };
    
    return levels[tier] || 1;
  }
  
  /**
   * Update statistics
   */
  updateAverageReferrals() {
    const totalReferrers = this.stats.totalReferrers;
    if (totalReferrers === 0) return;
    
    this.stats.averageReferralsPerUser = this.stats.totalReferrals / totalReferrers;
  }
  
  /**
   * Update top performers
   */
  updateTopPerformers() {
    const performers = Array.from(this.referrals.values())
      .sort((a, b) => b.totalEarnings - a.totalEarnings)
      .slice(0, 10)
      .map(ref => ({
        userId: ref.userId,
        tier: ref.tier,
        totalEarnings: ref.totalEarnings,
        totalReferrals: ref.totalReferrals
      }));
    
    this.stats.topPerformers = performers;
  }
  
  /**
   * Start monitoring cycles
   */
  startRewardTracking() {
    setInterval(() => {
      // Track mining earnings and award commissions
      const miners = this.pool.getConnectedMiners();
      
      for (const miner of miners) {
        if (miner.earnings > miner.lastCommissionCalculation || 0) {
          const newEarnings = miner.earnings - (miner.lastCommissionCalculation || 0);
          this.calculateCommissions(miner.userId, newEarnings);
          this.processVolumeBonus(miner.userId, newEarnings);
          miner.lastCommissionCalculation = miner.earnings;
        }
      }
    }, 300000); // Every 5 minutes
  }
  
  startPayoutProcessing() {
    setInterval(() => {
      this.processPayouts();
    }, this.config.payoutInterval);
  }
  
  startTierUpdates() {
    setInterval(() => {
      // Check for tier upgrades
      for (const userId of this.referrals.keys()) {
        this.checkTierUpgrade(userId);
      }
    }, 3600000); // Every hour
  }
  
  startPerformanceTracking() {
    setInterval(() => {
      this.updateTopPerformers();
    }, 1800000); // Every 30 minutes
  }
  
  /**
   * Get referral info
   */
  getReferralInfo(userId) {
    const referralData = this.referrals.get(userId);
    const treeData = this.referralTree.get(userId);
    const pendingRewards = this.pendingRewards.get(userId) || [];
    
    if (!referralData) return null;
    
    return {
      ...referralData,
      tree: treeData,
      pendingRewards: pendingRewards.filter(r => !r.isPaid),
      pendingAmount: pendingRewards.filter(r => !r.isPaid).reduce((sum, r) => sum + r.amount, 0)
    };
  }
  
  /**
   * Get team statistics
   */
  getTeamStats(userId) {
    const tree = this.referralTree.get(userId);
    if (!tree) return null;
    
    // Calculate team size recursively
    const calculateTeamSize = (userId, visited = new Set()) => {
      if (visited.has(userId)) return 0;
      visited.add(userId);
      
      const userTree = this.referralTree.get(userId);
      if (!userTree) return 0;
      
      let size = userTree.children.length;
      for (const childId of userTree.children) {
        size += calculateTeamSize(childId, visited);
      }
      
      return size;
    };
    
    return {
      directReferrals: tree.children.length,
      totalTeamSize: calculateTeamSize(userId),
      teamVolume: tree.teamVolume,
      level: tree.level
    };
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeCodes: this.codes.size,
      totalPendingRewards: Array.from(this.pendingRewards.values())
        .flat()
        .filter(r => !r.isPaid)
        .reduce((sum, r) => sum + r.amount, 0),
      rewardHistoryCount: this.rewardHistory.length
    };
  }
  
  /**
   * Shutdown
   */
  shutdown() {
    this.removeAllListeners();
    logger.info('Referral system shutdown');
  }
}

export default ReferralSystem;