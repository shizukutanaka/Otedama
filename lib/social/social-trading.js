/**
 * Social Trading Features
 * Community-driven trading and strategy sharing
 * 
 * Features:
 * - Copy trading
 * - Strategy marketplace
 * - Social signals
 * - Performance tracking
 * - Leader boards
 * - Risk management
 * - Profit sharing
 * - Community chat
 */

const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const crypto = require('crypto');
const { createLogger } = require('../core/logger');

const logger = createLogger('social-trading');

// Trader roles
const TraderRole = {
  LEADER: 'leader',
  FOLLOWER: 'follower',
  OBSERVER: 'observer'
};

// Strategy types
const StrategyType = {
  MANUAL: 'manual',
  AUTOMATED: 'automated',
  SIGNAL_BASED: 'signal_based',
  AI_POWERED: 'ai_powered',
  HYBRID: 'hybrid'
};

// Risk levels
const RiskLevel = {
  CONSERVATIVE: { name: 'Conservative', maxDrawdown: 10, leverage: 1 },
  MODERATE: { name: 'Moderate', maxDrawdown: 20, leverage: 2 },
  AGGRESSIVE: { name: 'Aggressive', maxDrawdown: 30, leverage: 5 },
  VERY_AGGRESSIVE: { name: 'Very Aggressive', maxDrawdown: 50, leverage: 10 }
};

// Copy modes
const CopyMode = {
  FIXED_AMOUNT: 'fixed_amount',
  PROPORTIONAL: 'proportional',
  PERCENTAGE: 'percentage',
  MIRROR: 'mirror'
};

class TraderProfile {
  constructor(userId, config = {}) {
    this.userId = userId;
    this.username = config.username || `Trader${userId.slice(-6)}`;
    this.avatar = config.avatar || this.generateAvatar();
    this.bio = config.bio || '';
    this.verified = config.verified || false;
    this.role = TraderRole.OBSERVER;
    
    // Trading statistics
    this.stats = {
      totalTrades: 0,
      winRate: 0,
      profitLoss: ethers.BigNumber.from(0),
      roi: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      avgTradeSize: ethers.BigNumber.from(0),
      tradingDays: 0,
      followers: 0,
      copiers: 0,
      aum: ethers.BigNumber.from(0) // Assets under management
    };
    
    // Trading preferences
    this.preferences = {
      riskLevel: config.riskLevel || RiskLevel.MODERATE,
      maxPositions: config.maxPositions || 10,
      stopLoss: config.stopLoss || 5, // percentage
      takeProfit: config.takeProfit || 10,
      allowCopying: config.allowCopying !== false,
      minCopyAmount: config.minCopyAmount || '100000000000000000', // 0.1 ETH
      performanceFee: config.performanceFee || 20 // percentage
    };
    
    // Social features
    this.followers = new Set();
    this.following = new Set();
    this.blockedUsers = new Set();
    
    this.createdAt = Date.now();
    this.lastActive = Date.now();
  }

  generateAvatar() {
    // Generate deterministic avatar based on userId
    return `https://avatars.dicebear.com/api/identicon/${this.userId}.svg`;
  }

  updateStats(trade) {
    this.stats.totalTrades++;
    
    // Update P&L
    const pnl = trade.exitPrice 
      ? ethers.BigNumber.from(trade.exitPrice).sub(trade.entryPrice).mul(trade.quantity)
      : ethers.BigNumber.from(0);
    
    this.stats.profitLoss = this.stats.profitLoss.add(pnl);
    
    // Update win rate
    if (pnl.gt(0)) {
      this.stats.winRate = ((this.stats.winRate * (this.stats.totalTrades - 1)) + 100) / this.stats.totalTrades;
    } else {
      this.stats.winRate = (this.stats.winRate * (this.stats.totalTrades - 1)) / this.stats.totalTrades;
    }
    
    // Update average trade size
    this.stats.avgTradeSize = this.stats.avgTradeSize
      .mul(this.stats.totalTrades - 1)
      .add(trade.quantity)
      .div(this.stats.totalTrades);
    
    this.lastActive = Date.now();
  }

  calculateROI(initialCapital) {
    if (ethers.BigNumber.from(initialCapital).eq(0)) return 0;
    
    return this.stats.profitLoss
      .mul(10000)
      .div(initialCapital)
      .toNumber() / 100;
  }

  calculateSharpeRatio(returns, riskFreeRate = 0.02) {
    if (returns.length < 2) return 0;
    
    // Calculate average return
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    
    // Calculate standard deviation
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    if (stdDev === 0) return 0;
    
    // Sharpe ratio = (avg return - risk free rate) / std dev
    return (avgReturn - riskFreeRate) / stdDev;
  }

  updateMaxDrawdown(equityCurve) {
    let maxDrawdown = 0;
    let peak = equityCurve[0] || 0;
    
    for (const value of equityCurve) {
      if (value > peak) {
        peak = value;
      }
      
      const drawdown = ((peak - value) / peak) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
    
    this.stats.maxDrawdown = maxDrawdown;
  }

  canBecomeLeader() {
    return (
      this.stats.totalTrades >= 50 &&
      this.stats.winRate >= 40 &&
      this.stats.tradingDays >= 30 &&
      this.verified
    );
  }

  toJSON() {
    return {
      userId: this.userId,
      username: this.username,
      avatar: this.avatar,
      bio: this.bio,
      verified: this.verified,
      role: this.role,
      stats: {
        ...this.stats,
        profitLoss: this.stats.profitLoss.toString(),
        avgTradeSize: this.stats.avgTradeSize.toString(),
        aum: this.stats.aum.toString()
      },
      preferences: this.preferences,
      followerCount: this.followers.size,
      followingCount: this.following.size,
      createdAt: this.createdAt,
      lastActive: this.lastActive
    };
  }
}

class TradingStrategy {
  constructor(config) {
    this.id = config.id || this.generateId();
    this.name = config.name;
    this.description = config.description;
    this.type = config.type || StrategyType.MANUAL;
    this.creator = config.creator;
    this.riskLevel = config.riskLevel || RiskLevel.MODERATE;
    
    // Strategy parameters
    this.parameters = {
      entryConditions: config.entryConditions || [],
      exitConditions: config.exitConditions || [],
      stopLoss: config.stopLoss || 5,
      takeProfit: config.takeProfit || 10,
      positionSize: config.positionSize || 'dynamic',
      maxPositions: config.maxPositions || 5,
      timeframe: config.timeframe || '1h',
      indicators: config.indicators || []
    };
    
    // Performance metrics
    this.performance = {
      backtestResults: config.backtestResults || null,
      liveResults: {
        trades: 0,
        winRate: 0,
        profitLoss: ethers.BigNumber.from(0),
        sharpeRatio: 0,
        maxDrawdown: 0
      },
      rating: 0,
      reviews: []
    };
    
    // Marketplace info
    this.marketplace = {
      isPublic: config.isPublic || false,
      price: config.price || '0',
      subscribers: new Set(),
      revenue: ethers.BigNumber.from(0),
      copyCount: 0
    };
    
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  generateId() {
    return 'strategy_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
  }

  updatePerformance(trade) {
    const results = this.performance.liveResults;
    results.trades++;
    
    const pnl = ethers.BigNumber.from(trade.exitPrice || 0)
      .sub(trade.entryPrice)
      .mul(trade.quantity);
    
    results.profitLoss = results.profitLoss.add(pnl);
    
    if (pnl.gt(0)) {
      results.winRate = ((results.winRate * (results.trades - 1)) + 100) / results.trades;
    } else {
      results.winRate = (results.winRate * (results.trades - 1)) / results.trades;
    }
    
    this.updatedAt = Date.now();
  }

  addReview(userId, rating, comment) {
    this.performance.reviews.push({
      userId,
      rating,
      comment,
      timestamp: Date.now()
    });
    
    // Update average rating
    const totalRating = this.performance.reviews.reduce((sum, r) => sum + r.rating, 0);
    this.performance.rating = totalRating / this.performance.reviews.length;
  }

  subscribe(userId) {
    this.marketplace.subscribers.add(userId);
    this.marketplace.revenue = this.marketplace.revenue.add(this.marketplace.price);
  }

  unsubscribe(userId) {
    this.marketplace.subscribers.delete(userId);
  }

  canAccess(userId) {
    return (
      this.creator === userId ||
      !this.marketplace.isPublic ||
      this.marketplace.subscribers.has(userId)
    );
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      type: this.type,
      creator: this.creator,
      riskLevel: this.riskLevel,
      parameters: this.parameters,
      performance: {
        ...this.performance,
        liveResults: {
          ...this.performance.liveResults,
          profitLoss: this.performance.liveResults.profitLoss.toString()
        }
      },
      marketplace: {
        ...this.marketplace,
        subscribers: this.marketplace.subscribers.size,
        revenue: this.marketplace.revenue.toString()
      },
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}

class CopyTradingEngine {
  constructor(config) {
    this.config = config;
    this.copyRelationships = new Map(); // follower -> leader mappings
    this.activeCopies = new Map(); // active copy positions
    this.performanceTracking = new Map();
  }

  async startCopying(followerId, leaderId, settings) {
    // Validate settings
    if (!settings.mode || !settings.amount) {
      throw new Error('Invalid copy settings');
    }
    
    const copyId = this.generateCopyId();
    
    const copyRelation = {
      id: copyId,
      followerId,
      leaderId,
      mode: settings.mode,
      amount: ethers.BigNumber.from(settings.amount),
      maxLoss: settings.maxLoss || 20, // percentage
      copyOpenTrades: settings.copyOpenTrades || false,
      startedAt: Date.now(),
      status: 'active',
      stats: {
        totalTrades: 0,
        profitLoss: ethers.BigNumber.from(0),
        feePaid: ethers.BigNumber.from(0)
      }
    };
    
    // Store relationship
    if (!this.copyRelationships.has(followerId)) {
      this.copyRelationships.set(followerId, new Map());
    }
    this.copyRelationships.get(followerId).set(leaderId, copyRelation);
    
    // Copy existing open positions if requested
    if (settings.copyOpenTrades) {
      await this.copyOpenPositions(copyRelation);
    }
    
    return {
      copyId,
      followerId,
      leaderId,
      settings: copyRelation
    };
  }

  async stopCopying(followerId, leaderId, closePositions = false) {
    const followerCopies = this.copyRelationships.get(followerId);
    if (!followerCopies) {
      throw new Error('No copy relationships found');
    }
    
    const copyRelation = followerCopies.get(leaderId);
    if (!copyRelation) {
      throw new Error('Copy relationship not found');
    }
    
    copyRelation.status = 'stopped';
    copyRelation.stoppedAt = Date.now();
    
    // Close copied positions if requested
    if (closePositions) {
      await this.closeAllCopiedPositions(copyRelation.id);
    }
    
    // Remove from active relationships
    followerCopies.delete(leaderId);
    
    return {
      copyId: copyRelation.id,
      finalStats: copyRelation.stats,
      duration: copyRelation.stoppedAt - copyRelation.startedAt
    };
  }

  async copyTrade(leaderTrade) {
    const { leaderId, action, symbol, quantity, price, type } = leaderTrade;
    
    // Find all followers copying this leader
    const followers = this.findFollowers(leaderId);
    const copiedTrades = [];
    
    for (const { followerId, copyRelation } of followers) {
      if (copyRelation.status !== 'active') continue;
      
      try {
        // Calculate copy size based on mode
        const copySize = this.calculateCopySize(
          copyRelation,
          quantity,
          price
        );
        
        // Check risk limits
        if (!this.checkRiskLimits(copyRelation, copySize, price)) {
          logger.warn(`Risk limit exceeded for follower ${followerId}`);
          continue;
        }
        
        // Execute copy trade
        const copiedTrade = {
          id: this.generateTradeId(),
          copyId: copyRelation.id,
          followerId,
          leaderId,
          leaderTradeId: leaderTrade.id,
          action,
          symbol,
          quantity: copySize,
          price,
          type,
          timestamp: Date.now()
        };
        
        // Track copied position
        this.trackCopiedPosition(copiedTrade);
        
        // Update statistics
        copyRelation.stats.totalTrades++;
        
        copiedTrades.push(copiedTrade);
      } catch (error) {
        logger.error(`Failed to copy trade for follower ${followerId}:`, error);
      }
    }
    
    return copiedTrades;
  }

  calculateCopySize(copyRelation, leaderQuantity, price) {
    const { mode, amount } = copyRelation;
    
    switch (mode) {
      case CopyMode.FIXED_AMOUNT:
        // Fixed amount per trade
        return amount.div(price);
        
      case CopyMode.PROPORTIONAL:
        // Proportional to leader's position size
        // Assumes we know leader's total capital
        return leaderQuantity.mul(amount).div(ethers.constants.WeiPerEther);
        
      case CopyMode.PERCENTAGE:
        // Percentage of follower's allocated capital
        const percentageAmount = amount.mul(leaderQuantity).div(100);
        return percentageAmount.div(price);
        
      case CopyMode.MIRROR:
        // Exact copy of leader's trade
        return leaderQuantity;
        
      default:
        throw new Error(`Unknown copy mode: ${mode}`);
    }
  }

  checkRiskLimits(copyRelation, quantity, price) {
    // Calculate position value
    const positionValue = quantity.mul(price);
    
    // Check against max loss limit
    const maxLossAmount = copyRelation.amount.mul(copyRelation.maxLoss).div(100);
    const currentLoss = copyRelation.stats.profitLoss.lt(0) 
      ? copyRelation.stats.profitLoss.abs() 
      : ethers.BigNumber.from(0);
    
    if (currentLoss.add(positionValue).gt(maxLossAmount)) {
      return false;
    }
    
    return true;
  }

  trackCopiedPosition(copiedTrade) {
    const positionKey = `${copiedTrade.followerId}-${copiedTrade.symbol}`;
    
    if (!this.activeCopies.has(positionKey)) {
      this.activeCopies.set(positionKey, []);
    }
    
    this.activeCopies.get(positionKey).push(copiedTrade);
  }

  async closeCopiedPosition(leaderTrade) {
    const { leaderId, symbol, exitPrice } = leaderTrade;
    const followers = this.findFollowers(leaderId);
    const closedTrades = [];
    
    for (const { followerId, copyRelation } of followers) {
      const positionKey = `${followerId}-${symbol}`;
      const positions = this.activeCopies.get(positionKey) || [];
      
      // Find matching positions
      const matchingPositions = positions.filter(p => 
        p.leaderId === leaderId && p.leaderTradeId === leaderTrade.id
      );
      
      for (const position of matchingPositions) {
        // Calculate P&L
        const pnl = ethers.BigNumber.from(exitPrice)
          .sub(position.price)
          .mul(position.quantity);
        
        // Update statistics
        copyRelation.stats.profitLoss = copyRelation.stats.profitLoss.add(pnl);
        
        // Calculate performance fee if profitable
        if (pnl.gt(0)) {
          const fee = pnl.mul(20).div(100); // 20% performance fee
          copyRelation.stats.feePaid = copyRelation.stats.feePaid.add(fee);
        }
        
        closedTrades.push({
          ...position,
          exitPrice,
          pnl: pnl.toString(),
          closedAt: Date.now()
        });
      }
      
      // Remove closed positions
      const remainingPositions = positions.filter(p => 
        !(p.leaderId === leaderId && p.leaderTradeId === leaderTrade.id)
      );
      
      if (remainingPositions.length > 0) {
        this.activeCopies.set(positionKey, remainingPositions);
      } else {
        this.activeCopies.delete(positionKey);
      }
    }
    
    return closedTrades;
  }

  findFollowers(leaderId) {
    const followers = [];
    
    for (const [followerId, relationships] of this.copyRelationships) {
      const copyRelation = relationships.get(leaderId);
      if (copyRelation && copyRelation.status === 'active') {
        followers.push({ followerId, copyRelation });
      }
    }
    
    return followers;
  }

  async copyOpenPositions(copyRelation) {
    // Implementation would copy all open positions from leader
    // This is a placeholder
    return [];
  }

  async closeAllCopiedPositions(copyId) {
    // Implementation would close all positions for a copy relationship
    // This is a placeholder
    return [];
  }

  generateCopyId() {
    return 'copy_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
  }

  generateTradeId() {
    return 'trade_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
  }

  getCopyStatistics(followerId, leaderId) {
    const followerCopies = this.copyRelationships.get(followerId);
    if (!followerCopies) return null;
    
    const copyRelation = followerCopies.get(leaderId);
    if (!copyRelation) return null;
    
    return {
      ...copyRelation,
      stats: {
        ...copyRelation.stats,
        profitLoss: copyRelation.stats.profitLoss.toString(),
        feePaid: copyRelation.stats.feePaid.toString()
      },
      duration: (copyRelation.stoppedAt || Date.now()) - copyRelation.startedAt
    };
  }
}

class SocialSignals {
  constructor() {
    this.signals = new Map();
    this.signalProviders = new Map();
    this.subscribers = new Map();
  }

  async createSignal(providerId, signal) {
    const signalId = this.generateSignalId();
    
    const newSignal = {
      id: signalId,
      providerId,
      type: signal.type, // 'buy', 'sell', 'hold'
      symbol: signal.symbol,
      action: signal.action,
      entryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      confidence: signal.confidence || 50, // 0-100
      reasoning: signal.reasoning,
      timeframe: signal.timeframe,
      expiresAt: signal.expiresAt || Date.now() + 86400000, // 24 hours
      createdAt: Date.now(),
      status: 'active',
      performance: {
        views: 0,
        copies: 0,
        successRate: null
      }
    };
    
    this.signals.set(signalId, newSignal);
    
    // Notify subscribers
    await this.notifySubscribers(providerId, newSignal);
    
    return newSignal;
  }

  async updateSignalPerformance(signalId, outcome) {
    const signal = this.signals.get(signalId);
    if (!signal) return;
    
    signal.status = 'closed';
    signal.outcome = outcome; // 'success', 'failed', 'breakeven'
    signal.closedAt = Date.now();
    
    // Update provider statistics
    const provider = this.signalProviders.get(signal.providerId);
    if (provider) {
      provider.totalSignals++;
      if (outcome === 'success') {
        provider.successfulSignals++;
      }
      provider.successRate = (provider.successfulSignals / provider.totalSignals) * 100;
    }
  }

  async subscribeToProvider(userId, providerId) {
    if (!this.subscribers.has(providerId)) {
      this.subscribers.set(providerId, new Set());
    }
    
    this.subscribers.get(providerId).add(userId);
    
    return {
      subscribed: true,
      providerId,
      subscriberCount: this.subscribers.get(providerId).size
    };
  }

  async notifySubscribers(providerId, signal) {
    const subscribers = this.subscribers.get(providerId);
    if (!subscribers) return;
    
    // In production, would send actual notifications
    logger.info(`Notifying ${subscribers.size} subscribers of new signal from ${providerId}`);
  }

  generateSignalId() {
    return 'signal_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
  }

  getActiveSignals(filter = {}) {
    const now = Date.now();
    const activeSignals = [];
    
    for (const signal of this.signals.values()) {
      if (signal.status === 'active' && signal.expiresAt > now) {
        if (!filter.symbol || signal.symbol === filter.symbol) {
          if (!filter.providerId || signal.providerId === filter.providerId) {
            activeSignals.push(signal);
          }
        }
      }
    }
    
    // Sort by confidence and recency
    activeSignals.sort((a, b) => {
      const scoreA = a.confidence + (1 / (now - a.createdAt));
      const scoreB = b.confidence + (1 / (now - b.createdAt));
      return scoreB - scoreA;
    });
    
    return activeSignals;
  }
}

class CommunityChat {
  constructor() {
    this.channels = new Map();
    this.messages = new Map();
    this.userStatus = new Map();
  }

  createChannel(name, type = 'public', creator) {
    const channelId = this.generateChannelId();
    
    const channel = {
      id: channelId,
      name,
      type, // 'public', 'private', 'strategy'
      creator,
      members: new Set([creator]),
      admins: new Set([creator]),
      createdAt: Date.now(),
      lastActivity: Date.now()
    };
    
    this.channels.set(channelId, channel);
    this.messages.set(channelId, []);
    
    return channel;
  }

  async sendMessage(channelId, userId, content, metadata = {}) {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new Error('Channel not found');
    }
    
    if (!channel.members.has(userId)) {
      throw new Error('Not a member of this channel');
    }
    
    const message = {
      id: this.generateMessageId(),
      channelId,
      userId,
      content,
      metadata, // Can include trade data, charts, etc.
      timestamp: Date.now(),
      edited: false,
      reactions: new Map()
    };
    
    this.messages.get(channelId).push(message);
    channel.lastActivity = Date.now();
    
    // Update user status
    this.updateUserStatus(userId, 'online');
    
    return message;
  }

  async reactToMessage(messageId, userId, reaction) {
    // Find message across all channels
    for (const channelMessages of this.messages.values()) {
      const message = channelMessages.find(m => m.id === messageId);
      if (message) {
        if (!message.reactions.has(reaction)) {
          message.reactions.set(reaction, new Set());
        }
        message.reactions.get(reaction).add(userId);
        return true;
      }
    }
    return false;
  }

  updateUserStatus(userId, status) {
    this.userStatus.set(userId, {
      status, // 'online', 'away', 'offline'
      lastSeen: Date.now()
    });
  }

  getChannelMessages(channelId, limit = 50, before = null) {
    const channelMessages = this.messages.get(channelId) || [];
    
    let filtered = channelMessages;
    if (before) {
      filtered = channelMessages.filter(m => m.timestamp < before);
    }
    
    return filtered.slice(-limit);
  }

  generateChannelId() {
    return 'channel_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
  }

  generateMessageId() {
    return 'msg_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
  }
}

class SocialTrading extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      minFollowers: options.minFollowers || 10,
      minTrades: options.minTrades || 50,
      performanceFee: options.performanceFee || 20,
      maxCopyAmount: options.maxCopyAmount || '10000000000000000000', // 10 ETH
      ...options
    };
    
    // Core components
    this.traders = new Map();
    this.strategies = new Map();
    this.copyEngine = new CopyTradingEngine(this.config);
    this.socialSignals = new SocialSignals();
    this.communityChat = new CommunityChat();
    
    // Analytics
    this.analytics = {
      totalTraders: 0,
      totalStrategies: 0,
      totalCopyRelationships: 0,
      totalSignals: 0,
      totalVolumeCopied: ethers.BigNumber.from(0)
    };
    
    this.initialize();
  }

  initialize() {
    // Create default channels
    this.communityChat.createChannel('General', 'public', 'system');
    this.communityChat.createChannel('Strategies', 'public', 'system');
    this.communityChat.createChannel('Signals', 'public', 'system');
    
    logger.info('Social trading system initialized');
  }

  async registerTrader(userId, profile = {}) {
    if (this.traders.has(userId)) {
      throw new Error('Trader already registered');
    }
    
    const trader = new TraderProfile(userId, profile);
    this.traders.set(userId, trader);
    
    this.analytics.totalTraders++;
    
    this.emit('trader:registered', {
      userId,
      username: trader.username
    });
    
    return trader.toJSON();
  }

  async updateTraderRole(userId, newRole) {
    const trader = this.traders.get(userId);
    if (!trader) {
      throw new Error('Trader not found');
    }
    
    // Check requirements for leader role
    if (newRole === TraderRole.LEADER && !trader.canBecomeLeader()) {
      throw new Error('Does not meet requirements for leader role');
    }
    
    trader.role = newRole;
    
    this.emit('trader:roleChanged', {
      userId,
      newRole,
      previousRole: trader.role
    });
    
    return trader.toJSON();
  }

  async followTrader(followerId, leaderId) {
    const follower = this.traders.get(followerId);
    const leader = this.traders.get(leaderId);
    
    if (!follower || !leader) {
      throw new Error('Trader not found');
    }
    
    if (leader.blockedUsers.has(followerId)) {
      throw new Error('You are blocked by this trader');
    }
    
    follower.following.add(leaderId);
    leader.followers.add(followerId);
    leader.stats.followers++;
    
    this.emit('trader:followed', {
      followerId,
      leaderId,
      followerCount: leader.followers.size
    });
    
    return {
      followed: true,
      leaderId,
      followerCount: leader.followers.size
    };
  }

  async startCopyTrading(followerId, leaderId, settings) {
    const follower = this.traders.get(followerId);
    const leader = this.traders.get(leaderId);
    
    if (!follower || !leader) {
      throw new Error('Trader not found');
    }
    
    if (leader.role !== TraderRole.LEADER) {
      throw new Error('Can only copy leaders');
    }
    
    if (!leader.preferences.allowCopying) {
      throw new Error('Leader does not allow copying');
    }
    
    // Check minimum copy amount
    const copyAmount = ethers.BigNumber.from(settings.amount);
    const minAmount = ethers.BigNumber.from(leader.preferences.minCopyAmount);
    
    if (copyAmount.lt(minAmount)) {
      throw new Error('Copy amount below minimum');
    }
    
    const result = await this.copyEngine.startCopying(followerId, leaderId, settings);
    
    leader.stats.copiers++;
    leader.stats.aum = leader.stats.aum.add(copyAmount);
    
    this.analytics.totalCopyRelationships++;
    this.analytics.totalVolumeCopied = this.analytics.totalVolumeCopied.add(copyAmount);
    
    this.emit('copy:started', result);
    
    return result;
  }

  async executeTrade(traderId, trade) {
    const trader = this.traders.get(traderId);
    if (!trader) {
      throw new Error('Trader not found');
    }
    
    // Update trader statistics
    trader.updateStats(trade);
    
    // If trader is a leader, copy trade to followers
    if (trader.role === TraderRole.LEADER) {
      const copiedTrades = await this.copyEngine.copyTrade({
        leaderId: traderId,
        ...trade
      });
      
      this.emit('trade:copied', {
        originalTrade: trade,
        copiedCount: copiedTrades.length
      });
    }
    
    this.emit('trade:executed', {
      traderId,
      trade
    });
    
    return {
      trade,
      copied: trader.role === TraderRole.LEADER
    };
  }

  async createStrategy(creatorId, strategyConfig) {
    const trader = this.traders.get(creatorId);
    if (!trader) {
      throw new Error('Trader not found');
    }
    
    const strategy = new TradingStrategy({
      ...strategyConfig,
      creator: creatorId
    });
    
    this.strategies.set(strategy.id, strategy);
    this.analytics.totalStrategies++;
    
    this.emit('strategy:created', {
      strategyId: strategy.id,
      creator: creatorId,
      name: strategy.name
    });
    
    return strategy.toJSON();
  }

  async publishSignal(providerId, signal) {
    const trader = this.traders.get(providerId);
    if (!trader) {
      throw new Error('Trader not found');
    }
    
    if (trader.role !== TraderRole.LEADER) {
      throw new Error('Only leaders can publish signals');
    }
    
    const newSignal = await this.socialSignals.createSignal(providerId, signal);
    
    this.analytics.totalSignals++;
    
    this.emit('signal:published', {
      signalId: newSignal.id,
      provider: providerId,
      symbol: signal.symbol
    });
    
    return newSignal;
  }

  async sendChatMessage(userId, channelName, content, metadata) {
    const trader = this.traders.get(userId);
    if (!trader) {
      throw new Error('Trader not found');
    }
    
    // Find channel by name
    let channelId = null;
    for (const [id, channel] of this.communityChat.channels) {
      if (channel.name === channelName) {
        channelId = id;
        break;
      }
    }
    
    if (!channelId) {
      throw new Error('Channel not found');
    }
    
    const message = await this.communityChat.sendMessage(
      channelId,
      userId,
      content,
      metadata
    );
    
    this.emit('chat:message', {
      channelId,
      userId,
      username: trader.username
    });
    
    return message;
  }

  getLeaderboard(metric = 'roi', period = 'all', limit = 100) {
    const leaders = Array.from(this.traders.values())
      .filter(trader => trader.role === TraderRole.LEADER);
    
    // Sort by metric
    leaders.sort((a, b) => {
      switch (metric) {
        case 'roi':
          return b.stats.roi - a.stats.roi;
        case 'followers':
          return b.stats.followers - a.stats.followers;
        case 'winRate':
          return b.stats.winRate - a.stats.winRate;
        case 'sharpeRatio':
          return b.stats.sharpeRatio - a.stats.sharpeRatio;
        case 'aum':
          return b.stats.aum.sub(a.stats.aum).toNumber();
        default:
          return 0;
      }
    });
    
    return leaders.slice(0, limit).map((trader, index) => ({
      rank: index + 1,
      userId: trader.userId,
      username: trader.username,
      avatar: trader.avatar,
      stats: {
        roi: trader.stats.roi,
        winRate: trader.stats.winRate,
        followers: trader.stats.followers,
        copiers: trader.stats.copiers,
        aum: trader.stats.aum.toString()
      }
    }));
  }

  getTraderProfile(userId) {
    const trader = this.traders.get(userId);
    if (!trader) return null;
    
    const profile = trader.toJSON();
    
    // Add additional social data
    profile.isFollowing = new Set();
    profile.followers = Array.from(trader.followers);
    profile.following = Array.from(trader.following);
    
    // Get copy statistics if leader
    if (trader.role === TraderRole.LEADER) {
      const copyStats = [];
      for (const [followerId, relationships] of this.copyEngine.copyRelationships) {
        const relation = relationships.get(userId);
        if (relation) {
          copyStats.push({
            followerId,
            stats: relation.stats
          });
        }
      }
      profile.copyStatistics = copyStats;
    }
    
    return profile;
  }

  getMarketplace(filter = {}) {
    const publicStrategies = Array.from(this.strategies.values())
      .filter(strategy => 
        strategy.marketplace.isPublic &&
        (!filter.type || strategy.type === filter.type) &&
        (!filter.riskLevel || strategy.riskLevel === filter.riskLevel)
      );
    
    // Sort by rating and performance
    publicStrategies.sort((a, b) => {
      const scoreA = a.performance.rating + (a.performance.liveResults.winRate / 100);
      const scoreB = b.performance.rating + (b.performance.liveResults.winRate / 100);
      return scoreB - scoreA;
    });
    
    return publicStrategies.map(s => s.toJSON());
  }

  getStatistics() {
    return {
      ...this.analytics,
      totalVolumeCopied: this.analytics.totalVolumeCopied.toString(),
      activeLeaders: Array.from(this.traders.values())
        .filter(t => t.role === TraderRole.LEADER).length,
      activeCopyRelationships: Array.from(this.copyEngine.copyRelationships.values())
        .reduce((sum, relations) => sum + relations.size, 0),
      activeSignals: this.socialSignals.getActiveSignals().length,
      chatChannels: this.communityChat.channels.size,
      onlineUsers: Array.from(this.communityChat.userStatus.values())
        .filter(s => s.status === 'online').length
    };
  }

  async cleanup() {
    this.removeAllListeners();
    logger.info('Social trading system cleaned up');
  }
}

module.exports = {
  SocialTrading,
  TraderProfile,
  TradingStrategy,
  CopyTradingEngine,
  SocialSignals,
  CommunityChat,
  TraderRole,
  StrategyType,
  RiskLevel,
  CopyMode
};