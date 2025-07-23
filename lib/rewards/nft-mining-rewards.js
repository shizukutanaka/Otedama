/**
 * NFT Mining Rewards System
 * Gamified mining with collectible NFT rewards
 * 
 * Features:
 * - Achievement-based NFTs
 * - Rarity tiers
 * - Dynamic metadata
 * - Mining power boosts
 * - NFT staking
 * - Marketplace integration
 * - Collection bonuses
 * - Seasonal events
 */

const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const crypto = require('crypto');
const { createLogger } = require('../core/logger');

const logger = createLogger('nft-mining-rewards');

// NFT categories
const NFTCategory = {
  HASHRATE_MILESTONE: 'hashrate_milestone',
  BLOCK_FINDER: 'block_finder',
  LOYALTY_BADGE: 'loyalty_badge',
  RARE_SHARE: 'rare_share',
  EVENT_SPECIAL: 'event_special',
  ACHIEVEMENT: 'achievement',
  COLLECTION: 'collection'
};

// Rarity tiers
const Rarity = {
  COMMON: { name: 'Common', weight: 50, boost: 0 },
  UNCOMMON: { name: 'Uncommon', weight: 30, boost: 5 },
  RARE: { name: 'Rare', weight: 15, boost: 10 },
  EPIC: { name: 'Epic', weight: 4, boost: 20 },
  LEGENDARY: { name: 'Legendary', weight: 1, boost: 50 }
};

// Achievement types
const Achievement = {
  FIRST_BLOCK: 'first_block',
  HASH_WARRIOR: 'hash_warrior',
  LUCKY_MINER: 'lucky_miner',
  CONSISTENT_CONTRIBUTOR: 'consistent_contributor',
  POOL_SUPPORTER: 'pool_supporter',
  DIAMOND_HANDS: 'diamond_hands',
  EARLY_ADOPTER: 'early_adopter'
};

class NFTMetadata {
  constructor(tokenId, category, rarity, attributes) {
    this.tokenId = tokenId;
    this.name = this.generateName(category, rarity);
    this.description = this.generateDescription(category, rarity);
    this.image = this.generateImageURI(category, rarity);
    this.category = category;
    this.rarity = rarity;
    this.attributes = this.formatAttributes(attributes);
    this.createdAt = Date.now();
  }

  generateName(category, rarity) {
    const prefixes = {
      [NFTCategory.HASHRATE_MILESTONE]: 'Hashrate Hero',
      [NFTCategory.BLOCK_FINDER]: 'Block Hunter',
      [NFTCategory.LOYALTY_BADGE]: 'Loyal Miner',
      [NFTCategory.RARE_SHARE]: 'Golden Share',
      [NFTCategory.EVENT_SPECIAL]: 'Event Champion',
      [NFTCategory.ACHIEVEMENT]: 'Achievement',
      [NFTCategory.COLLECTION]: 'Collector'
    };
    
    return `${prefixes[category]} - ${rarity.name} #${this.tokenId}`;
  }

  generateDescription(category, rarity) {
    const descriptions = {
      [NFTCategory.HASHRATE_MILESTONE]: `A ${rarity.name} NFT awarded for reaching significant hashrate milestones.`,
      [NFTCategory.BLOCK_FINDER]: `A ${rarity.name} NFT earned by successfully mining blocks.`,
      [NFTCategory.LOYALTY_BADGE]: `A ${rarity.name} NFT recognizing consistent mining contribution.`,
      [NFTCategory.RARE_SHARE]: `A ${rarity.name} NFT representing exceptional mining luck.`,
      [NFTCategory.EVENT_SPECIAL]: `A ${rarity.name} limited edition NFT from a special event.`,
      [NFTCategory.ACHIEVEMENT]: `A ${rarity.name} NFT unlocked through mining achievements.`,
      [NFTCategory.COLLECTION]: `A ${rarity.name} NFT part of an exclusive collection.`
    };
    
    return descriptions[category];
  }

  generateImageURI(category, rarity) {
    // In production, would point to actual IPFS or CDN URLs
    return `ipfs://QmExample${category}${rarity.name}${this.tokenId}`;
  }

  formatAttributes(attributes) {
    const formatted = [
      {
        trait_type: 'Category',
        value: this.category
      },
      {
        trait_type: 'Rarity',
        value: this.rarity.name
      },
      {
        trait_type: 'Mining Boost',
        value: `${this.rarity.boost}%`,
        display_type: 'boost_percentage'
      },
      {
        trait_type: 'Generation Date',
        value: new Date(this.createdAt).toISOString(),
        display_type: 'date'
      }
    ];
    
    // Add custom attributes
    for (const [key, value] of Object.entries(attributes)) {
      formatted.push({
        trait_type: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '),
        value: value
      });
    }
    
    return formatted;
  }

  toJSON() {
    return {
      name: this.name,
      description: this.description,
      image: this.image,
      attributes: this.attributes,
      properties: {
        category: this.category,
        rarity: this.rarity.name,
        boost: this.rarity.boost,
        created: this.createdAt
      }
    };
  }
}

class NFTContract {
  constructor(config) {
    this.config = config;
    this.name = config.name || 'Otedama Mining NFTs';
    this.symbol = config.symbol || 'OTNFT';
    this.totalSupply = 0;
    this.maxSupply = config.maxSupply || 10000;
    
    // Token storage
    this.tokens = new Map();
    this.owners = new Map();
    this.balances = new Map();
    this.tokensByOwner = new Map();
    
    // Metadata storage
    this.tokenMetadata = new Map();
    this.baseURI = config.baseURI || 'https://api.otedama.com/nft/';
  }

  async mint(to, metadata) {
    if (this.totalSupply >= this.maxSupply) {
      throw new Error('Max supply reached');
    }
    
    const tokenId = this.totalSupply + 1;
    this.totalSupply++;
    
    // Mint token
    this.tokens.set(tokenId, {
      id: tokenId,
      owner: to,
      metadata,
      mintedAt: Date.now()
    });
    
    this.owners.set(tokenId, to);
    
    // Update balances
    const currentBalance = this.balances.get(to) || 0;
    this.balances.set(to, currentBalance + 1);
    
    // Update owner's token list
    if (!this.tokensByOwner.has(to)) {
      this.tokensByOwner.set(to, new Set());
    }
    this.tokensByOwner.get(to).add(tokenId);
    
    // Store metadata
    this.tokenMetadata.set(tokenId, metadata);
    
    return {
      tokenId,
      owner: to,
      metadata: metadata.toJSON(),
      transactionHash: '0x' + crypto.randomBytes(32).toString('hex')
    };
  }

  async burn(tokenId) {
    const token = this.tokens.get(tokenId);
    if (!token) {
      throw new Error('Token does not exist');
    }
    
    const owner = token.owner;
    
    // Remove token
    this.tokens.delete(tokenId);
    this.owners.delete(tokenId);
    this.tokenMetadata.delete(tokenId);
    
    // Update balance
    const currentBalance = this.balances.get(owner) || 0;
    this.balances.set(owner, Math.max(0, currentBalance - 1));
    
    // Remove from owner's list
    const ownerTokens = this.tokensByOwner.get(owner);
    if (ownerTokens) {
      ownerTokens.delete(tokenId);
    }
    
    return {
      tokenId,
      burned: true,
      previousOwner: owner
    };
  }

  async transfer(from, to, tokenId) {
    const token = this.tokens.get(tokenId);
    if (!token) {
      throw new Error('Token does not exist');
    }
    
    if (token.owner !== from) {
      throw new Error('Not token owner');
    }
    
    // Update token owner
    token.owner = to;
    this.owners.set(tokenId, to);
    
    // Update balances
    const fromBalance = this.balances.get(from) || 0;
    const toBalance = this.balances.get(to) || 0;
    this.balances.set(from, Math.max(0, fromBalance - 1));
    this.balances.set(to, toBalance + 1);
    
    // Update token lists
    const fromTokens = this.tokensByOwner.get(from);
    if (fromTokens) {
      fromTokens.delete(tokenId);
    }
    
    if (!this.tokensByOwner.has(to)) {
      this.tokensByOwner.set(to, new Set());
    }
    this.tokensByOwner.get(to).add(tokenId);
    
    return {
      tokenId,
      from,
      to,
      transferred: true
    };
  }

  ownerOf(tokenId) {
    return this.owners.get(tokenId) || null;
  }

  balanceOf(owner) {
    return this.balances.get(owner) || 0;
  }

  tokenURI(tokenId) {
    const metadata = this.tokenMetadata.get(tokenId);
    if (!metadata) {
      throw new Error('Token does not exist');
    }
    
    return this.baseURI + tokenId;
  }

  tokensOfOwner(owner) {
    const tokens = this.tokensByOwner.get(owner);
    return tokens ? Array.from(tokens) : [];
  }

  getTokenMetadata(tokenId) {
    const metadata = this.tokenMetadata.get(tokenId);
    return metadata ? metadata.toJSON() : null;
  }
}

class AchievementTracker {
  constructor() {
    this.achievements = new Map();
    this.userAchievements = new Map();
    this.achievementDefinitions = this.defineAchievements();
  }

  defineAchievements() {
    return {
      [Achievement.FIRST_BLOCK]: {
        name: 'First Block',
        description: 'Mine your first block',
        condition: (stats) => stats.blocksFound >= 1,
        points: 100,
        nftCategory: NFTCategory.ACHIEVEMENT,
        rarity: Rarity.UNCOMMON
      },
      [Achievement.HASH_WARRIOR]: {
        name: 'Hash Warrior',
        description: 'Maintain 1 TH/s for 24 hours',
        condition: (stats) => stats.sustainedHashrate >= 1000000000000,
        points: 500,
        nftCategory: NFTCategory.HASHRATE_MILESTONE,
        rarity: Rarity.RARE
      },
      [Achievement.LUCKY_MINER]: {
        name: 'Lucky Miner',
        description: 'Find a block within first 100 shares',
        condition: (stats) => stats.luckyBlockFound,
        points: 1000,
        nftCategory: NFTCategory.RARE_SHARE,
        rarity: Rarity.EPIC
      },
      [Achievement.CONSISTENT_CONTRIBUTOR]: {
        name: 'Consistent Contributor',
        description: 'Mine for 30 consecutive days',
        condition: (stats) => stats.consecutiveDays >= 30,
        points: 750,
        nftCategory: NFTCategory.LOYALTY_BADGE,
        rarity: Rarity.RARE
      },
      [Achievement.POOL_SUPPORTER]: {
        name: 'Pool Supporter',
        description: 'Refer 10 miners to the pool',
        condition: (stats) => stats.referrals >= 10,
        points: 2000,
        nftCategory: NFTCategory.ACHIEVEMENT,
        rarity: Rarity.EPIC
      },
      [Achievement.DIAMOND_HANDS]: {
        name: 'Diamond Hands',
        description: 'Hold all mined rewards for 6 months',
        condition: (stats) => stats.holdingDuration >= 15552000000, // 6 months in ms
        points: 3000,
        nftCategory: NFTCategory.LOYALTY_BADGE,
        rarity: Rarity.LEGENDARY
      },
      [Achievement.EARLY_ADOPTER]: {
        name: 'Early Adopter',
        description: 'Join within first 1000 miners',
        condition: (stats) => stats.minerNumber <= 1000,
        points: 500,
        nftCategory: NFTCategory.ACHIEVEMENT,
        rarity: Rarity.RARE
      }
    };
  }

  async checkAchievements(userId, stats) {
    const userAchievements = this.userAchievements.get(userId) || new Set();
    const newAchievements = [];
    
    for (const [achievementId, definition] of Object.entries(this.achievementDefinitions)) {
      if (!userAchievements.has(achievementId) && definition.condition(stats)) {
        userAchievements.add(achievementId);
        newAchievements.push({
          id: achievementId,
          ...definition,
          unlockedAt: Date.now()
        });
      }
    }
    
    this.userAchievements.set(userId, userAchievements);
    
    return newAchievements;
  }

  getUserAchievements(userId) {
    const userAchievements = this.userAchievements.get(userId) || new Set();
    const achievements = [];
    
    for (const achievementId of userAchievements) {
      const definition = this.achievementDefinitions[achievementId];
      if (definition) {
        achievements.push({
          id: achievementId,
          ...definition
        });
      }
    }
    
    return achievements;
  }

  getProgress(userId, stats) {
    const progress = {};
    const userAchievements = this.userAchievements.get(userId) || new Set();
    
    for (const [achievementId, definition] of Object.entries(this.achievementDefinitions)) {
      if (!userAchievements.has(achievementId)) {
        progress[achievementId] = {
          name: definition.name,
          description: definition.description,
          unlocked: false,
          progress: this.calculateProgress(definition, stats)
        };
      }
    }
    
    return progress;
  }

  calculateProgress(definition, stats) {
    // Simplified progress calculation
    // In production, would have specific progress tracking for each achievement
    if (definition.name === 'First Block') {
      return (stats.blocksFound / 1) * 100;
    } else if (definition.name === 'Hash Warrior') {
      return (stats.sustainedHashrate / 1000000000000) * 100;
    } else if (definition.name === 'Consistent Contributor') {
      return (stats.consecutiveDays / 30) * 100;
    }
    
    return 0;
  }
}

class NFTStaking {
  constructor(config) {
    this.config = config;
    this.stakes = new Map();
    this.stakedTokens = new Map();
    this.totalStaked = 0;
    this.rewardRate = config.rewardRate || '1000000000000000'; // 0.001 per day per NFT
    this.boostMultipliers = new Map();
  }

  async stakeNFT(owner, tokenId, nftContract) {
    // Verify ownership
    if (nftContract.ownerOf(tokenId) !== owner) {
      throw new Error('Not token owner');
    }
    
    // Check if already staked
    if (this.stakedTokens.has(tokenId)) {
      throw new Error('Token already staked');
    }
    
    // Get token metadata for boost calculation
    const metadata = nftContract.getTokenMetadata(tokenId);
    const boost = metadata.properties.boost || 0;
    
    const stake = {
      tokenId,
      owner,
      stakedAt: Date.now(),
      boost,
      rewards: ethers.BigNumber.from(0),
      lastClaim: Date.now()
    };
    
    this.stakes.set(tokenId, stake);
    
    // Track staked tokens by owner
    if (!this.stakedTokens.has(owner)) {
      this.stakedTokens.set(owner, new Set());
    }
    this.stakedTokens.get(owner).add(tokenId);
    
    // Update boost multiplier
    this.updateBoostMultiplier(owner);
    
    this.totalStaked++;
    
    return {
      tokenId,
      staked: true,
      boost,
      totalBoost: this.boostMultipliers.get(owner)
    };
  }

  async unstakeNFT(owner, tokenId) {
    const stake = this.stakes.get(tokenId);
    if (!stake) {
      throw new Error('Token not staked');
    }
    
    if (stake.owner !== owner) {
      throw new Error('Not stake owner');
    }
    
    // Calculate final rewards
    const pendingRewards = this.calculateRewards(tokenId);
    const totalRewards = stake.rewards.add(pendingRewards);
    
    // Remove stake
    this.stakes.delete(tokenId);
    const ownerTokens = this.stakedTokens.get(owner);
    if (ownerTokens) {
      ownerTokens.delete(tokenId);
    }
    
    // Update boost multiplier
    this.updateBoostMultiplier(owner);
    
    this.totalStaked--;
    
    return {
      tokenId,
      unstaked: true,
      rewards: totalRewards.toString(),
      stakeDuration: Date.now() - stake.stakedAt
    };
  }

  calculateRewards(tokenId) {
    const stake = this.stakes.get(tokenId);
    if (!stake) {
      return ethers.BigNumber.from(0);
    }
    
    const duration = Date.now() - stake.lastClaim;
    const daysStaked = duration / (24 * 60 * 60 * 1000);
    
    const baseReward = ethers.BigNumber.from(this.rewardRate)
      .mul(Math.floor(daysStaked * 1000))
      .div(1000);
    
    // Apply NFT boost
    const boostedReward = baseReward.mul(100 + stake.boost).div(100);
    
    return boostedReward;
  }

  async claimRewards(owner, tokenId) {
    const stake = this.stakes.get(tokenId);
    if (!stake) {
      throw new Error('Token not staked');
    }
    
    if (stake.owner !== owner) {
      throw new Error('Not stake owner');
    }
    
    const pendingRewards = this.calculateRewards(tokenId);
    stake.rewards = stake.rewards.add(pendingRewards);
    stake.lastClaim = Date.now();
    
    const claimed = stake.rewards;
    stake.rewards = ethers.BigNumber.from(0);
    
    return {
      tokenId,
      claimed: claimed.toString()
    };
  }

  updateBoostMultiplier(owner) {
    const stakedTokens = this.stakedTokens.get(owner);
    if (!stakedTokens || stakedTokens.size === 0) {
      this.boostMultipliers.set(owner, 0);
      return;
    }
    
    let totalBoost = 0;
    for (const tokenId of stakedTokens) {
      const stake = this.stakes.get(tokenId);
      if (stake) {
        totalBoost += stake.boost;
      }
    }
    
    // Apply diminishing returns for multiple NFTs
    const effectiveBoost = Math.min(totalBoost, 100); // Cap at 100%
    this.boostMultipliers.set(owner, effectiveBoost);
  }

  getStakedTokens(owner) {
    const tokens = this.stakedTokens.get(owner);
    return tokens ? Array.from(tokens) : [];
  }

  getStakeInfo(tokenId) {
    const stake = this.stakes.get(tokenId);
    if (!stake) return null;
    
    const pendingRewards = this.calculateRewards(tokenId);
    
    return {
      ...stake,
      pendingRewards: pendingRewards.toString(),
      totalRewards: stake.rewards.add(pendingRewards).toString()
    };
  }
}

class SeasonalEvents {
  constructor() {
    this.activeEvents = new Map();
    this.eventHistory = [];
    this.eventRewards = new Map();
  }

  createEvent(config) {
    const event = {
      id: this.generateEventId(),
      name: config.name,
      description: config.description,
      startTime: config.startTime || Date.now(),
      endTime: config.endTime,
      type: config.type,
      requirements: config.requirements || {},
      rewards: config.rewards || [],
      participants: new Set(),
      leaderboard: [],
      active: true
    };
    
    this.activeEvents.set(event.id, event);
    
    // Set up auto-end timer
    if (event.endTime) {
      setTimeout(() => {
        this.endEvent(event.id);
      }, event.endTime - Date.now());
    }
    
    return event;
  }

  async participateInEvent(eventId, userId, contribution) {
    const event = this.activeEvents.get(eventId);
    if (!event || !event.active) {
      throw new Error('Event not active');
    }
    
    if (Date.now() > event.endTime) {
      throw new Error('Event ended');
    }
    
    // Add participant
    event.participants.add(userId);
    
    // Update leaderboard
    const existing = event.leaderboard.find(entry => entry.userId === userId);
    if (existing) {
      existing.score += contribution.score || 0;
      existing.contributions.push(contribution);
    } else {
      event.leaderboard.push({
        userId,
        score: contribution.score || 0,
        contributions: [contribution],
        joinedAt: Date.now()
      });
    }
    
    // Sort leaderboard
    event.leaderboard.sort((a, b) => b.score - a.score);
    
    // Check if user qualifies for rewards
    const rewards = this.checkEventRewards(event, userId);
    
    return {
      eventId,
      participated: true,
      currentRank: event.leaderboard.findIndex(e => e.userId === userId) + 1,
      totalParticipants: event.participants.size,
      eligibleRewards: rewards
    };
  }

  checkEventRewards(event, userId) {
    const userEntry = event.leaderboard.find(entry => entry.userId === userId);
    if (!userEntry) return [];
    
    const eligibleRewards = [];
    const userRank = event.leaderboard.indexOf(userEntry) + 1;
    
    for (const reward of event.rewards) {
      let eligible = false;
      
      if (reward.type === 'rank' && userRank <= reward.maxRank) {
        eligible = true;
      } else if (reward.type === 'score' && userEntry.score >= reward.minScore) {
        eligible = true;
      } else if (reward.type === 'participation') {
        eligible = true;
      }
      
      if (eligible) {
        eligibleRewards.push({
          ...reward,
          userRank,
          userScore: userEntry.score
        });
      }
    }
    
    return eligibleRewards;
  }

  endEvent(eventId) {
    const event = this.activeEvents.get(eventId);
    if (!event) return;
    
    event.active = false;
    event.endedAt = Date.now();
    
    // Distribute rewards
    this.distributeEventRewards(event);
    
    // Move to history
    this.eventHistory.push(event);
    this.activeEvents.delete(eventId);
  }

  distributeEventRewards(event) {
    const rewardDistribution = [];
    
    // Distribute rank-based rewards
    for (let i = 0; i < Math.min(event.leaderboard.length, 100); i++) {
      const entry = event.leaderboard[i];
      const rank = i + 1;
      
      const rewards = event.rewards.filter(r => 
        (r.type === 'rank' && rank <= r.maxRank) ||
        (r.type === 'score' && entry.score >= r.minScore) ||
        (r.type === 'participation')
      );
      
      if (rewards.length > 0) {
        rewardDistribution.push({
          userId: entry.userId,
          rank,
          score: entry.score,
          rewards
        });
      }
    }
    
    this.eventRewards.set(event.id, rewardDistribution);
    
    return rewardDistribution;
  }

  getEventLeaderboard(eventId, limit = 100) {
    const event = this.activeEvents.get(eventId);
    if (!event) {
      // Check history
      const historical = this.eventHistory.find(e => e.id === eventId);
      if (historical) {
        return historical.leaderboard.slice(0, limit);
      }
      return [];
    }
    
    return event.leaderboard.slice(0, limit);
  }

  generateEventId() {
    return 'event_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
  }
}

class NFTMiningRewards extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      nftContractAddress: options.nftContractAddress,
      rarityWeights: options.rarityWeights || Rarity,
      mintCost: options.mintCost || '10000000000000000', // 0.01 ETH
      stakingEnabled: options.stakingEnabled !== false,
      ...options
    };
    
    // Core components
    this.nftContract = new NFTContract(this.config);
    this.achievementTracker = new AchievementTracker();
    this.nftStaking = new NFTStaking(this.config);
    this.seasonalEvents = new SeasonalEvents();
    
    // Mining statistics tracking
    this.minerStats = new Map();
    this.globalStats = {
      totalNFTsMinted: 0,
      totalAchievementsUnlocked: 0,
      totalNFTsStaked: 0,
      activeEvents: 0
    };
    
    this.initialize();
  }

  initialize() {
    // Create default seasonal event
    this.createSeasonalEvent({
      name: 'Launch Celebration',
      description: 'Celebrate the launch with bonus NFT rewards!',
      duration: 7 * 24 * 60 * 60 * 1000, // 7 days
      type: 'mining_competition',
      rewards: [
        { type: 'rank', maxRank: 1, nftRarity: Rarity.LEGENDARY },
        { type: 'rank', maxRank: 10, nftRarity: Rarity.EPIC },
        { type: 'rank', maxRank: 100, nftRarity: Rarity.RARE },
        { type: 'participation', nftRarity: Rarity.UNCOMMON }
      ]
    });
    
    logger.info('NFT mining rewards system initialized');
  }

  async trackMiningActivity(minerId, activity) {
    let stats = this.minerStats.get(minerId);
    if (!stats) {
      stats = {
        minerId,
        joinedAt: Date.now(),
        minerNumber: this.minerStats.size + 1,
        hashrate: 0,
        sustainedHashrate: 0,
        sharesSubmitted: 0,
        blocksFound: 0,
        consecutiveDays: 0,
        lastActiveDay: null,
        totalEarnings: ethers.BigNumber.from(0),
        referrals: 0,
        holdingDuration: 0,
        luckyBlockFound: false
      };
      this.minerStats.set(minerId, stats);
    }
    
    // Update stats based on activity
    if (activity.type === 'share_submitted') {
      stats.sharesSubmitted++;
      stats.hashrate = activity.hashrate || stats.hashrate;
      
      // Check for rare share NFT
      if (activity.difficulty && activity.difficulty > 1000000000) {
        await this.mintNFT(minerId, NFTCategory.RARE_SHARE, this.determineRarity());
      }
    } else if (activity.type === 'block_found') {
      stats.blocksFound++;
      
      // Check if lucky block (found quickly)
      if (stats.sharesSubmitted < 100) {
        stats.luckyBlockFound = true;
      }
      
      // Mint block finder NFT
      await this.mintNFT(minerId, NFTCategory.BLOCK_FINDER, this.determineRarity());
    } else if (activity.type === 'hashrate_update') {
      stats.hashrate = activity.hashrate;
      
      // Check sustained hashrate
      if (activity.duration >= 86400000 && activity.hashrate >= 1000000000000) {
        stats.sustainedHashrate = activity.hashrate;
      }
    } else if (activity.type === 'daily_active') {
      const today = Math.floor(Date.now() / 86400000);
      const lastActive = stats.lastActiveDay;
      
      if (lastActive && today === lastActive + 1) {
        stats.consecutiveDays++;
      } else {
        stats.consecutiveDays = 1;
      }
      
      stats.lastActiveDay = today;
    }
    
    // Check for new achievements
    const newAchievements = await this.achievementTracker.checkAchievements(minerId, stats);
    
    // Mint NFTs for new achievements
    for (const achievement of newAchievements) {
      await this.mintNFT(
        minerId,
        achievement.nftCategory,
        achievement.rarity,
        { achievement: achievement.name }
      );
      
      this.globalStats.totalAchievementsUnlocked++;
    }
    
    // Check event participation
    for (const event of this.seasonalEvents.activeEvents.values()) {
      if (activity.type === 'share_submitted' || activity.type === 'block_found') {
        await this.seasonalEvents.participateInEvent(
          event.id,
          minerId,
          {
            type: activity.type,
            score: activity.type === 'block_found' ? 1000 : 1,
            timestamp: Date.now()
          }
        );
      }
    }
    
    return {
      stats,
      newAchievements
    };
  }

  async mintNFT(to, category, rarity, additionalAttributes = {}) {
    const tokenId = this.nftContract.totalSupply + 1;
    
    // Create metadata
    const metadata = new NFTMetadata(
      tokenId,
      category,
      rarity,
      {
        mintedTo: to,
        mintedAt: Date.now(),
        ...additionalAttributes
      }
    );
    
    // Mint NFT
    const result = await this.nftContract.mint(to, metadata);
    
    this.globalStats.totalNFTsMinted++;
    
    this.emit('nft:minted', {
      tokenId: result.tokenId,
      owner: to,
      category,
      rarity: rarity.name,
      boost: rarity.boost
    });
    
    return result;
  }

  determineRarity() {
    const totalWeight = Object.values(Rarity).reduce((sum, r) => sum + r.weight, 0);
    const random = Math.random() * totalWeight;
    
    let accumulated = 0;
    for (const rarity of Object.values(Rarity)) {
      accumulated += rarity.weight;
      if (random <= accumulated) {
        return rarity;
      }
    }
    
    return Rarity.COMMON;
  }

  async stakeNFT(owner, tokenId) {
    const result = await this.nftStaking.stakeNFT(owner, tokenId, this.nftContract);
    
    this.globalStats.totalNFTsStaked++;
    
    this.emit('nft:staked', {
      tokenId,
      owner,
      boost: result.boost
    });
    
    return result;
  }

  async unstakeNFT(owner, tokenId) {
    const result = await this.nftStaking.unstakeNFT(owner, tokenId);
    
    this.globalStats.totalNFTsStaked--;
    
    this.emit('nft:unstaked', {
      tokenId,
      owner,
      rewards: result.rewards
    });
    
    return result;
  }

  async claimStakingRewards(owner, tokenId) {
    const result = await this.nftStaking.claimRewards(owner, tokenId);
    
    this.emit('rewards:claimed', {
      tokenId,
      owner,
      amount: result.claimed
    });
    
    return result;
  }

  async createSeasonalEvent(config) {
    const event = this.seasonalEvents.createEvent({
      ...config,
      endTime: config.endTime || Date.now() + (config.duration || 604800000) // Default 7 days
    });
    
    this.globalStats.activeEvents++;
    
    this.emit('event:created', {
      eventId: event.id,
      name: event.name,
      endTime: event.endTime
    });
    
    return event;
  }

  getMinerProfile(minerId) {
    const stats = this.minerStats.get(minerId);
    if (!stats) return null;
    
    const achievements = this.achievementTracker.getUserAchievements(minerId);
    const progress = this.achievementTracker.getProgress(minerId, stats);
    const ownedNFTs = this.nftContract.tokensOfOwner(minerId);
    const stakedNFTs = this.nftStaking.getStakedTokens(minerId);
    
    // Calculate total boost
    const totalBoost = this.nftStaking.boostMultipliers.get(minerId) || 0;
    
    return {
      stats,
      achievements,
      achievementProgress: progress,
      nfts: {
        owned: ownedNFTs.map(id => ({
          tokenId: id,
          metadata: this.nftContract.getTokenMetadata(id)
        })),
        staked: stakedNFTs.map(id => ({
          tokenId: id,
          stakeInfo: this.nftStaking.getStakeInfo(id)
        })),
        totalBoost: totalBoost + '%'
      },
      totalNFTs: ownedNFTs.length,
      totalAchievements: achievements.length
    };
  }

  getLeaderboard(category = 'blocks_found', limit = 100) {
    const miners = Array.from(this.minerStats.values());
    
    // Sort by category
    miners.sort((a, b) => {
      switch (category) {
        case 'blocks_found':
          return b.blocksFound - a.blocksFound;
        case 'hashrate':
          return b.hashrate - a.hashrate;
        case 'shares':
          return b.sharesSubmitted - a.sharesSubmitted;
        case 'nfts':
          const aNFTs = this.nftContract.balanceOf(a.minerId);
          const bNFTs = this.nftContract.balanceOf(b.minerId);
          return bNFTs - aNFTs;
        default:
          return 0;
      }
    });
    
    return miners.slice(0, limit).map((stats, index) => ({
      rank: index + 1,
      minerId: stats.minerId,
      value: stats[category] || 0,
      nfts: this.nftContract.balanceOf(stats.minerId),
      boost: this.nftStaking.boostMultipliers.get(stats.minerId) || 0
    }));
  }

  getStatistics() {
    return {
      ...this.globalStats,
      totalMiners: this.minerStats.size,
      nftContract: {
        totalSupply: this.nftContract.totalSupply,
        maxSupply: this.nftContract.maxSupply,
        remainingSupply: this.nftContract.maxSupply - this.nftContract.totalSupply
      },
      rarityDistribution: this.getRarityDistribution(),
      categoryDistribution: this.getCategoryDistribution(),
      activeEvents: Array.from(this.seasonalEvents.activeEvents.values()).map(e => ({
        id: e.id,
        name: e.name,
        participants: e.participants.size,
        endsIn: Math.max(0, e.endTime - Date.now())
      }))
    };
  }

  getRarityDistribution() {
    const distribution = {};
    
    for (const rarity of Object.values(Rarity)) {
      distribution[rarity.name] = 0;
    }
    
    for (const metadata of this.nftContract.tokenMetadata.values()) {
      distribution[metadata.rarity.name]++;
    }
    
    return distribution;
  }

  getCategoryDistribution() {
    const distribution = {};
    
    for (const category of Object.values(NFTCategory)) {
      distribution[category] = 0;
    }
    
    for (const metadata of this.nftContract.tokenMetadata.values()) {
      distribution[metadata.category]++;
    }
    
    return distribution;
  }

  async cleanup() {
    // End all active events
    for (const eventId of this.seasonalEvents.activeEvents.keys()) {
      this.seasonalEvents.endEvent(eventId);
    }
    
    this.removeAllListeners();
    logger.info('NFT mining rewards system cleaned up');
  }
}

module.exports = {
  NFTMiningRewards,
  NFTCategory,
  Rarity,
  Achievement,
  NFTMetadata,
  NFTContract,
  AchievementTracker,
  NFTStaking,
  SeasonalEvents
};