import EventEmitter from 'events';
import crypto from 'crypto';

const TraderTier = {
  BEGINNER: 'beginner',
  INTERMEDIATE: 'intermediate',
  ADVANCED: 'advanced',
  EXPERT: 'expert',
  MASTER: 'master'
};

const FollowType = {
  FULL_COPY: 'full_copy',
  PROPORTIONAL: 'proportional',
  SELECTIVE: 'selective',
  RISK_MANAGED: 'risk_managed',
  CUSTOM: 'custom'
};

const TradeSignalType = {
  ENTRY: 'entry',
  EXIT: 'exit',
  PARTIAL_CLOSE: 'partial_close',
  ADD_POSITION: 'add_position',
  STOP_LOSS: 'stop_loss',
  TAKE_PROFIT: 'take_profit'
};

const FollowStatus = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  RISK_LIMIT_HIT: 'risk_limit_hit'
};

const TraderStatus = {
  ACTIVE: 'active',
  VERIFIED: 'verified',
  SUSPENDED: 'suspended',
  UNDER_REVIEW: 'under_review'
};

export class SocialTradingCopyTradingSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableAutoFollowing: options.enableAutoFollowing !== false,
      enableRiskManagement: options.enableRiskManagement !== false,
      enablePerformanceTracking: options.enablePerformanceTracking !== false,
      enableSignalSharing: options.enableSignalSharing !== false,
      enableSocialFeatures: options.enableSocialFeatures !== false,
      maxFollowersPerTrader: options.maxFollowersPerTrader || 10000,
      maxFollowingPerUser: options.maxFollowingPerUser || 100,
      minTraderBalance: options.minTraderBalance || 10000, // $10k minimum
      maxCopyRatio: options.maxCopyRatio || 0.2, // 20% of portfolio max
      performanceTrackingPeriod: options.performanceTrackingPeriod || 90 * 24 * 60 * 60 * 1000, // 90 days
      signalDelay: options.signalDelay || 1000, // 1 second delay
      maxSlippage: options.maxSlippage || 0.05, // 5%
      riskScoreThreshold: options.riskScoreThreshold || 7.0
    };

    this.traders = new Map();
    this.followers = new Map();
    this.followRelationships = new Map();
    this.tradeSignals = new Map();
    this.copiedTrades = new Map();
    this.performanceMetrics = new Map();
    this.socialPosts = new Map();
    this.leaderboard = new Map();
    this.notifications = new Map();
    
    this.isRunning = false;
    this.metrics = {
      totalTraders: 0,
      totalFollowers: 0,
      totalCopiedTrades: 0,
      totalSignals: 0,
      averageFollowersPerTrader: 0,
      totalCopyVolume: 0,
      averageSuccessRate: 0,
      totalProfitGenerated: 0,
      topTraderROI: 0
    };

    this.initializeTraders();
    this.startPerformanceTracking();
    this.startSignalProcessing();
    this.startRiskMonitoring();
    this.startSocialUpdates();
  }

  initializeTraders() {
    const sampleTraders = [
      {
        username: 'CryptoMaster2024',
        tier: TraderTier.EXPERT,
        totalBalance: 500000,
        followersCount: 2500,
        roi90d: 0.35,
        winRate: 0.68,
        maxDrawdown: 0.15,
        averageHoldTime: 5 * 24 * 60 * 60 * 1000, // 5 days
        specialties: ['DeFi', 'Yield Farming', 'Arbitrage'],
        riskScore: 6.5,
        verified: true,
        publicProfile: true
      },
      {
        username: 'DeFiGuru',
        tier: TraderTier.MASTER,
        totalBalance: 1200000,
        followersCount: 5000,
        roi90d: 0.55,
        winRate: 0.72,
        maxDrawdown: 0.12,
        averageHoldTime: 3 * 24 * 60 * 60 * 1000, // 3 days
        specialties: ['DeFi', 'Governance', 'Staking'],
        riskScore: 7.2,
        verified: true,
        publicProfile: true
      },
      {
        username: 'ArbitrageKing',
        tier: TraderTier.EXPERT,
        totalBalance: 800000,
        followersCount: 1800,
        roi90d: 0.28,
        winRate: 0.85,
        maxDrawdown: 0.08,
        averageHoldTime: 2 * 60 * 60 * 1000, // 2 hours
        specialties: ['Arbitrage', 'Flash Loans', 'Cross-chain'],
        riskScore: 4.5,
        verified: true,
        publicProfile: true
      },
      {
        username: 'YieldHunter',
        tier: TraderTier.ADVANCED,
        totalBalance: 300000,
        followersCount: 1200,
        roi90d: 0.42,
        winRate: 0.65,
        maxDrawdown: 0.18,
        averageHoldTime: 7 * 24 * 60 * 60 * 1000, // 7 days
        specialties: ['Yield Farming', 'Staking', 'Lending'],
        riskScore: 7.8,
        verified: false,
        publicProfile: true
      },
      {
        username: 'LiquidityPro',
        tier: TraderTier.EXPERT,
        totalBalance: 600000,
        followersCount: 3200,
        roi90d: 0.31,
        winRate: 0.70,
        maxDrawdown: 0.14,
        averageHoldTime: 4 * 24 * 60 * 60 * 1000, // 4 days
        specialties: ['Liquidity Mining', 'AMM', 'Options'],
        riskScore: 6.8,
        verified: true,
        publicProfile: true
      }
    ];

    sampleTraders.forEach(traderData => {
      const traderId = this.generateTraderId();
      const trader = {
        id: traderId,
        ...traderData,
        status: TraderStatus.ACTIVE,
        joinedAt: Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000, // Random join time
        lastActiveAt: Date.now(),
        totalTrades: Math.floor(Math.random() * 500) + 100,
        copiedTrades: Math.floor(traderData.followersCount * 0.3),
        averagePositionSize: traderData.totalBalance * 0.1,
        socialScore: Math.random() * 100,
        commissionRate: 0.1 + Math.random() * 0.15, // 10-25%
        allowCopyTrading: true,
        maxFollowers: this.options.maxFollowersPerTrader,
        tradingStyle: this.generateTradingStyle()
      };

      this.traders.set(traderId, trader);
      this.metrics.totalTraders++;
    });
  }

  async followTrader(followerId, traderId, followConfig = {}) {
    try {
      const trader = this.traders.get(traderId);
      const follower = this.getOrCreateFollower(followerId);

      if (!trader) {
        throw new Error('Trader not found');
      }

      if (!trader.allowCopyTrading || trader.status !== TraderStatus.ACTIVE) {
        throw new Error('Trader is not available for copy trading');
      }

      if (trader.followersCount >= trader.maxFollowers) {
        throw new Error('Trader has reached maximum followers limit');
      }

      if (follower.following.length >= this.options.maxFollowingPerUser) {
        throw new Error('Maximum following limit reached');
      }

      // Check if already following
      const existingFollow = this.followRelationships.get(`${followerId}-${traderId}`);
      if (existingFollow && existingFollow.status === FollowStatus.ACTIVE) {
        throw new Error('Already following this trader');
      }

      // Validate follow configuration
      this.validateFollowConfig(followConfig, follower);

      const followId = this.generateFollowId();
      const followRelationship = {
        id: followId,
        followerId,
        traderId,
        status: FollowStatus.ACTIVE,
        followType: followConfig.followType || FollowType.PROPORTIONAL,
        copyRatio: followConfig.copyRatio || 0.1, // 10% default
        maxPositionSize: followConfig.maxPositionSize || follower.balance * this.options.maxCopyRatio,
        riskLimits: {
          maxDailyLoss: followConfig.maxDailyLoss || follower.balance * 0.05, // 5%
          maxDrawdown: followConfig.maxDrawdown || 0.2, // 20%
          stopLossPercentage: followConfig.stopLossPercentage || 0.1 // 10%
        },
        includedAssets: followConfig.includedAssets || [],
        excludedAssets: followConfig.excludedAssets || [],
        minTradeSize: followConfig.minTradeSize || 10,
        maxTradeSize: followConfig.maxTradeSize || follower.balance * 0.1,
        delaySeconds: followConfig.delaySeconds || 0,
        startedAt: Date.now(),
        totalCopiedTrades: 0,
        totalProfit: 0,
        currentDrawdown: 0,
        lastCopyTime: 0
      };

      this.followRelationships.set(`${followerId}-${traderId}`, followRelationship);

      // Update trader and follower stats
      trader.followersCount++;
      follower.following.push(traderId);
      follower.activeFollows++;

      this.metrics.totalFollowers++;

      this.emit('traderFollowed', {
        followerId,
        traderId,
        followId,
        followConfig: followRelationship
      });

      return followId;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async unfollowTrader(followerId, traderId) {
    try {
      const followKey = `${followerId}-${traderId}`;
      const followRelationship = this.followRelationships.get(followKey);

      if (!followRelationship) {
        throw new Error('Follow relationship not found');
      }

      const trader = this.traders.get(traderId);
      const follower = this.followers.get(followerId);

      // Update status
      followRelationship.status = FollowStatus.STOPPED;
      followRelationship.endedAt = Date.now();

      // Update stats
      if (trader) {
        trader.followersCount = Math.max(0, trader.followersCount - 1);
      }

      if (follower) {
        follower.following = follower.following.filter(id => id !== traderId);
        follower.activeFollows = Math.max(0, follower.activeFollows - 1);
      }

      this.emit('traderUnfollowed', { followerId, traderId });
      return true;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async publishTradeSignal(traderId, signalData) {
    try {
      const trader = this.traders.get(traderId);
      if (!trader || trader.status !== TraderStatus.ACTIVE) {
        throw new Error('Trader not found or inactive');
      }

      const signalId = this.generateSignalId();
      const signal = {
        id: signalId,
        traderId,
        type: signalData.type,
        asset: signalData.asset,
        action: signalData.action, // 'buy', 'sell', 'hold'
        amount: signalData.amount,
        price: signalData.price,
        stopLoss: signalData.stopLoss,
        takeProfit: signalData.takeProfit,
        leverage: signalData.leverage || 1,
        reasoning: signalData.reasoning || '',
        confidence: signalData.confidence || 0.5, // 0-1 scale
        timeframe: signalData.timeframe || '1d',
        publishedAt: Date.now(),
        expiresAt: Date.now() + (signalData.validFor || 24 * 60 * 60 * 1000), // 24h default
        copiedBy: [],
        performance: {
          totalCopies: 0,
          successfulCopies: 0,
          averageProfit: 0
        }
      };

      this.tradeSignals.set(signalId, signal);

      // Process signal for all followers
      setTimeout(() => {
        this.processTradeSignal(signalId);
      }, this.options.signalDelay);

      this.metrics.totalSignals++;

      this.emit('tradeSignalPublished', signal);
      return signalId;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async processTradeSignal(signalId) {
    try {
      const signal = this.tradeSignals.get(signalId);
      if (!signal) return;

      const trader = this.traders.get(signal.traderId);
      if (!trader) return;

      // Find all active followers of this trader
      const followers = Array.from(this.followRelationships.values())
        .filter(follow => 
          follow.traderId === signal.traderId && 
          follow.status === FollowStatus.ACTIVE
        );

      for (const followRelationship of followers) {
        try {
          await this.executeCopyTrade(signal, followRelationship);
        } catch (error) {
          this.emit('copyTradeError', {
            signalId,
            followerId: followRelationship.followerId,
            error: error.message
          });
        }
      }

      this.emit('tradeSignalProcessed', {
        signalId,
        followersNotified: followers.length
      });
    } catch (error) {
      this.emit('error', error);
    }
  }

  async executeCopyTrade(signal, followRelationship) {
    try {
      const follower = this.followers.get(followRelationship.followerId);
      if (!follower) return;

      // Check if asset is allowed/excluded
      if (followRelationship.includedAssets.length > 0 && 
          !followRelationship.includedAssets.includes(signal.asset)) {
        return;
      }

      if (followRelationship.excludedAssets.includes(signal.asset)) {
        return;
      }

      // Calculate copy amount based on follow type
      let copyAmount = this.calculateCopyAmount(signal, followRelationship, follower);

      // Apply risk limits
      copyAmount = this.applyCopyRiskLimits(copyAmount, followRelationship, follower);

      if (copyAmount <= followRelationship.minTradeSize) {
        return; // Trade too small
      }

      // Execute the copy trade
      const copyTradeId = this.generateCopyTradeId();
      const copyTrade = {
        id: copyTradeId,
        signalId: signal.id,
        followerId: followRelationship.followerId,
        traderId: signal.traderId,
        asset: signal.asset,
        action: signal.action,
        originalAmount: signal.amount,
        copiedAmount: copyAmount,
        originalPrice: signal.price,
        executionPrice: this.calculateExecutionPrice(signal.price),
        slippage: 0,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        leverage: signal.leverage,
        executedAt: Date.now(),
        status: 'executed',
        currentPnL: 0,
        commissionPaid: 0
      };

      // Calculate slippage
      copyTrade.slippage = Math.abs(copyTrade.executionPrice - copyTrade.originalPrice) / copyTrade.originalPrice;

      // Validate slippage
      if (copyTrade.slippage > this.options.maxSlippage) {
        copyTrade.status = 'rejected';
        copyTrade.rejectionReason = 'excessive_slippage';
        this.emit('copyTradeRejected', copyTrade);
        return;
      }

      this.copiedTrades.set(copyTradeId, copyTrade);

      // Update follow relationship stats
      followRelationship.totalCopiedTrades++;
      followRelationship.lastCopyTime = Date.now();

      // Update signal stats
      signal.copiedBy.push(followRelationship.followerId);
      signal.performance.totalCopies++;

      // Update follower balance (simulate)
      const tradeValue = copyAmount * copyTrade.executionPrice;
      if (signal.action === 'buy') {
        follower.balance -= tradeValue;
        follower.positions = follower.positions || [];
        follower.positions.push({
          asset: signal.asset,
          amount: copyAmount,
          averagePrice: copyTrade.executionPrice,
          openedAt: Date.now()
        });
      } else if (signal.action === 'sell') {
        follower.balance += tradeValue;
        // Update positions (simplified)
        if (follower.positions) {
          const position = follower.positions.find(p => p.asset === signal.asset);
          if (position) {
            position.amount -= copyAmount;
            if (position.amount <= 0) {
              follower.positions = follower.positions.filter(p => p.asset !== signal.asset);
            }
          }
        }
      }

      this.metrics.totalCopiedTrades++;
      this.metrics.totalCopyVolume += tradeValue;

      this.emit('copyTradeExecuted', copyTrade);
      return copyTradeId;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  calculateCopyAmount(signal, followRelationship, follower) {
    let copyAmount = 0;

    switch (followRelationship.followType) {
      case FollowType.FULL_COPY:
        copyAmount = signal.amount;
        break;

      case FollowType.PROPORTIONAL:
        const traderBalance = this.traders.get(followRelationship.traderId)?.totalBalance || 1;
        const proportion = follower.balance / traderBalance;
        copyAmount = signal.amount * proportion * followRelationship.copyRatio;
        break;

      case FollowType.SELECTIVE:
        // Use fixed copy ratio
        copyAmount = follower.balance * followRelationship.copyRatio;
        break;

      case FollowType.RISK_MANAGED:
        const riskAdjustedRatio = followRelationship.copyRatio * (1 - followRelationship.currentDrawdown);
        copyAmount = follower.balance * riskAdjustedRatio;
        break;

      default:
        copyAmount = follower.balance * 0.05; // 5% default
    }

    return Math.max(0, copyAmount);
  }

  applyCopyRiskLimits(amount, followRelationship, follower) {
    // Apply maximum position size limit
    amount = Math.min(amount, followRelationship.maxPositionSize);

    // Apply maximum trade size limit
    amount = Math.min(amount, followRelationship.maxTradeSize);

    // Apply balance limit
    amount = Math.min(amount, follower.balance * 0.5); // Max 50% of balance per trade

    return amount;
  }

  calculateExecutionPrice(originalPrice) {
    // Simulate price movement and slippage
    const slippage = (Math.random() - 0.5) * 0.01; // ±0.5% random slippage
    return originalPrice * (1 + slippage);
  }

  async getRankings(category = 'roi', timeframe = '90d', limit = 50) {
    try {
      let traders = Array.from(this.traders.values())
        .filter(trader => trader.publicProfile && trader.status === TraderStatus.ACTIVE);

      // Sort based on category
      switch (category) {
        case 'roi':
          traders.sort((a, b) => (b.roi90d || 0) - (a.roi90d || 0));
          break;
        case 'followers':
          traders.sort((a, b) => b.followersCount - a.followersCount);
          break;
        case 'winrate':
          traders.sort((a, b) => (b.winRate || 0) - (a.winRate || 0));
          break;
        case 'volume':
          traders.sort((a, b) => (b.totalBalance || 0) - (a.totalBalance || 0));
          break;
        case 'social':
          traders.sort((a, b) => (b.socialScore || 0) - (a.socialScore || 0));
          break;
        default:
          traders.sort((a, b) => (b.roi90d || 0) - (a.roi90d || 0));
      }

      return traders.slice(0, limit).map((trader, index) => ({
        rank: index + 1,
        traderId: trader.id,
        username: trader.username,
        tier: trader.tier,
        roi: trader.roi90d,
        winRate: trader.winRate,
        followersCount: trader.followersCount,
        maxDrawdown: trader.maxDrawdown,
        verified: trader.verified,
        riskScore: trader.riskScore,
        specialties: trader.specialties
      }));
    } catch (error) {
      this.emit('error', error);
      return [];
    }
  }

  async getTraderProfile(traderId) {
    try {
      const trader = this.traders.get(traderId);
      if (!trader) {
        throw new Error('Trader not found');
      }

      // Calculate additional metrics
      const recentSignals = Array.from(this.tradeSignals.values())
        .filter(signal => signal.traderId === traderId)
        .sort((a, b) => b.publishedAt - a.publishedAt)
        .slice(0, 20);

      const monthlyReturns = this.calculateMonthlyReturns(traderId);
      const portfolioAllocation = this.getPortfolioAllocation(traderId);

      return {
        ...trader,
        recentSignals,
        monthlyReturns,
        portfolioAllocation,
        socialMetrics: {
          postsCount: this.getSocialPostsCount(traderId),
          likesReceived: this.getSocialLikes(traderId),
          commentsCount: this.getSocialComments(traderId)
        }
      };
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async publishSocialPost(traderId, content, options = {}) {
    try {
      const trader = this.traders.get(traderId);
      if (!trader) {
        throw new Error('Trader not found');
      }

      const postId = this.generatePostId();
      const post = {
        id: postId,
        traderId,
        username: trader.username,
        content,
        type: options.type || 'text', // 'text', 'image', 'chart', 'signal'
        attachments: options.attachments || [],
        tags: options.tags || [],
        publishedAt: Date.now(),
        likes: 0,
        comments: [],
        reposts: 0,
        views: 0
      };

      this.socialPosts.set(postId, post);

      // Update trader's social score
      trader.socialScore += 1;

      this.emit('socialPostPublished', post);
      return postId;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  startPerformanceTracking() {
    if (this.performanceTracker) return;
    
    this.performanceTracker = setInterval(async () => {
      try {
        // Update trader performance metrics
        for (const [traderId, trader] of this.traders) {
          await this.updateTraderPerformance(traderId);
        }

        // Update follower performance metrics
        for (const [followerId, follower] of this.followers) {
          await this.updateFollowerPerformance(followerId);
        }

        // Update overall system metrics
        this.updateSystemMetrics();

      } catch (error) {
        this.emit('error', error);
      }
    }, 3600000); // Update every hour
  }

  startSignalProcessing() {
    if (this.signalProcessor) return;
    
    this.signalProcessor = setInterval(async () => {
      try {
        // Clean up expired signals
        const now = Date.now();
        const expiredSignals = [];

        for (const [signalId, signal] of this.tradeSignals) {
          if (signal.expiresAt <= now) {
            expiredSignals.push(signalId);
          }
        }

        expiredSignals.forEach(signalId => {
          this.tradeSignals.delete(signalId);
        });

        if (expiredSignals.length > 0) {
          this.emit('signalsExpired', expiredSignals);
        }

      } catch (error) {
        this.emit('error', error);
      }
    }, 300000); // Check every 5 minutes
  }

  startRiskMonitoring() {
    if (this.riskMonitor) return;
    
    this.riskMonitor = setInterval(async () => {
      try {
        // Monitor follow relationships for risk limits
        for (const [followKey, follow] of this.followRelationships) {
          if (follow.status !== FollowStatus.ACTIVE) continue;

          const follower = this.followers.get(follow.followerId);
          if (!follower) continue;

          // Check drawdown limits
          if (follow.currentDrawdown > follow.riskLimits.maxDrawdown) {
            follow.status = FollowStatus.RISK_LIMIT_HIT;
            this.emit('followRiskLimitHit', {
              followId: follow.id,
              reason: 'max_drawdown',
              currentDrawdown: follow.currentDrawdown,
              limit: follow.riskLimits.maxDrawdown
            });
          }

          // Check daily loss limits
          const dailyLoss = this.calculateDailyLoss(follow);
          if (dailyLoss > follow.riskLimits.maxDailyLoss) {
            follow.status = FollowStatus.RISK_LIMIT_HIT;
            this.emit('followRiskLimitHit', {
              followId: follow.id,
              reason: 'max_daily_loss',
              dailyLoss,
              limit: follow.riskLimits.maxDailyLoss
            });
          }
        }

        // Monitor trader risk scores
        for (const [traderId, trader] of this.traders) {
          if (trader.riskScore > this.options.riskScoreThreshold) {
            this.emit('traderHighRisk', {
              traderId,
              username: trader.username,
              riskScore: trader.riskScore,
              threshold: this.options.riskScoreThreshold
            });
          }
        }

      } catch (error) {
        this.emit('error', error);
      }
    }, 900000); // Check every 15 minutes
  }

  startSocialUpdates() {
    if (this.socialUpdater) return;
    
    this.socialUpdater = setInterval(async () => {
      try {
        // Update social scores based on engagement
        for (const [traderId, trader] of this.traders) {
          const recentEngagement = this.calculateRecentEngagement(traderId);
          trader.socialScore = (trader.socialScore * 0.9) + (recentEngagement * 0.1);
        }

        // Update leaderboard
        await this.updateLeaderboard();

      } catch (error) {
        this.emit('error', error);
      }
    }, 1800000); // Update every 30 minutes
  }

  async updateTraderPerformance(traderId) {
    try {
      const trader = this.traders.get(traderId);
      if (!trader) return;

      // Calculate recent signals performance
      const recentSignals = Array.from(this.tradeSignals.values())
        .filter(signal => 
          signal.traderId === traderId && 
          signal.publishedAt > Date.now() - this.options.performanceTrackingPeriod
        );

      if (recentSignals.length > 0) {
        const successfulSignals = recentSignals.filter(signal => 
          signal.performance.averageProfit > 0
        );
        
        trader.winRate = successfulSignals.length / recentSignals.length;
        trader.totalTrades = recentSignals.length;
      }

      // Simulate ROI calculation
      const roiVariation = (Math.random() - 0.5) * 0.02; // ±1% variation
      trader.roi90d = Math.max(-0.5, Math.min(2.0, trader.roi90d + roiVariation));

      // Update last active time
      trader.lastActiveAt = Date.now();

    } catch (error) {
      this.emit('error', error);
    }
  }

  async updateFollowerPerformance(followerId) {
    try {
      const follower = this.followers.get(followerId);
      if (!follower) return;

      // Calculate portfolio performance
      let totalPnL = 0;
      let totalInvested = 0;

      const followerTrades = Array.from(this.copiedTrades.values())
        .filter(trade => trade.followerId === followerId);

      for (const trade of followerTrades) {
        const currentPrice = this.getCurrentPrice(trade.asset);
        const pnl = this.calculateTradePnL(trade, currentPrice);
        
        trade.currentPnL = pnl;
        totalPnL += pnl;
        totalInvested += trade.copiedAmount * trade.executionPrice;
      }

      follower.totalPnL = totalPnL;
      follower.totalInvested = totalInvested;
      follower.roi = totalInvested > 0 ? (totalPnL / totalInvested) : 0;

    } catch (error) {
      this.emit('error', error);
    }
  }

  calculateTradePnL(trade, currentPrice) {
    if (trade.action === 'buy') {
      return (currentPrice - trade.executionPrice) * trade.copiedAmount;
    } else if (trade.action === 'sell') {
      return (trade.executionPrice - currentPrice) * trade.copiedAmount;
    }
    return 0;
  }

  getCurrentPrice(asset) {
    // Simulate current price (in a real system, this would fetch from price feeds)
    const basePrices = {
      'ETH': 2500,
      'BTC': 45000,
      'USDC': 1.0,
      'AAVE': 100,
      'UNI': 15
    };
    
    const basePrice = basePrices[asset] || 100;
    const variation = (Math.random() - 0.5) * 0.1; // ±5% variation
    return basePrice * (1 + variation);
  }

  calculateDailyLoss(follow) {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentTrades = Array.from(this.copiedTrades.values())
      .filter(trade => 
        trade.followerId === follow.followerId && 
        trade.executedAt >= oneDayAgo
      );

    return recentTrades.reduce((totalLoss, trade) => {
      return trade.currentPnL < 0 ? totalLoss + Math.abs(trade.currentPnL) : totalLoss;
    }, 0);
  }

  calculateRecentEngagement(traderId) {
    const recentPosts = Array.from(this.socialPosts.values())
      .filter(post => 
        post.traderId === traderId && 
        post.publishedAt > Date.now() - 7 * 24 * 60 * 60 * 1000 // Last 7 days
      );

    return recentPosts.reduce((total, post) => 
      total + post.likes + post.comments.length + post.reposts, 0);
  }

  updateSystemMetrics() {
    const activeTraders = Array.from(this.traders.values())
      .filter(trader => trader.status === TraderStatus.ACTIVE);
    
    const activeFollows = Array.from(this.followRelationships.values())
      .filter(follow => follow.status === FollowStatus.ACTIVE);

    this.metrics.averageFollowersPerTrader = activeTraders.length > 0 ? 
      activeTraders.reduce((sum, trader) => sum + trader.followersCount, 0) / activeTraders.length : 0;

    this.metrics.averageSuccessRate = activeTraders.length > 0 ?
      activeTraders.reduce((sum, trader) => sum + (trader.winRate || 0), 0) / activeTraders.length : 0;

    this.metrics.topTraderROI = Math.max(...activeTraders.map(trader => trader.roi90d || 0));

    const totalProfit = Array.from(this.copiedTrades.values())
      .reduce((sum, trade) => sum + Math.max(0, trade.currentPnL), 0);
    
    this.metrics.totalProfitGenerated = totalProfit;
  }

  async updateLeaderboard() {
    const rankings = {
      roi: await this.getRankings('roi', '90d', 10),
      followers: await this.getRankings('followers', '90d', 10),
      winrate: await this.getRankings('winrate', '90d', 10),
      social: await this.getRankings('social', '90d', 10)
    };

    this.leaderboard = new Map(Object.entries(rankings));
    this.emit('leaderboardUpdated', rankings);
  }

  // Helper methods
  getOrCreateFollower(followerId) {
    if (!this.followers.has(followerId)) {
      this.followers.set(followerId, {
        id: followerId,
        balance: 10000 + Math.random() * 90000, // $10k - $100k random balance
        following: [],
        activeFollows: 0,
        totalPnL: 0,
        totalInvested: 0,
        roi: 0,
        joinedAt: Date.now(),
        positions: []
      });
    }
    return this.followers.get(followerId);
  }

  validateFollowConfig(config, follower) {
    if (config.copyRatio && (config.copyRatio < 0.01 || config.copyRatio > this.options.maxCopyRatio)) {
      throw new Error(`Copy ratio must be between 1% and ${this.options.maxCopyRatio * 100}%`);
    }

    if (config.maxPositionSize && config.maxPositionSize > follower.balance) {
      throw new Error('Max position size exceeds available balance');
    }
  }

  generateTradingStyle() {
    const styles = ['Conservative', 'Moderate', 'Aggressive', 'Scalping', 'Swing', 'Position'];
    return styles[Math.floor(Math.random() * styles.length)];
  }

  // Mock data calculation methods
  calculateMonthlyReturns(traderId) {
    const returns = [];
    for (let i = 0; i < 12; i++) {
      returns.push({
        month: new Date(Date.now() - i * 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 7),
        return: (Math.random() - 0.4) * 0.3 // -40% to +30% monthly returns
      });
    }
    return returns.reverse();
  }

  getPortfolioAllocation(traderId) {
    return [
      { asset: 'ETH', percentage: 30 + Math.random() * 20 },
      { asset: 'BTC', percentage: 20 + Math.random() * 15 },
      { asset: 'DeFi', percentage: 25 + Math.random() * 20 },
      { asset: 'Stablecoins', percentage: 10 + Math.random() * 15 },
      { asset: 'Others', percentage: 5 + Math.random() * 10 }
    ];
  }

  getSocialPostsCount(traderId) {
    return Array.from(this.socialPosts.values())
      .filter(post => post.traderId === traderId).length;
  }

  getSocialLikes(traderId) {
    return Array.from(this.socialPosts.values())
      .filter(post => post.traderId === traderId)
      .reduce((sum, post) => sum + post.likes, 0);
  }

  getSocialComments(traderId) {
    return Array.from(this.socialPosts.values())
      .filter(post => post.traderId === traderId)
      .reduce((sum, post) => sum + post.comments.length, 0);
  }

  // ID generation methods
  generateTraderId() {
    return `trader_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  generateFollowId() {
    return `follow_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  generateSignalId() {
    return `signal_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  generateCopyTradeId() {
    return `copy_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  generatePostId() {
    return `post_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  // Public API methods
  async getTrader(traderId) {
    return this.traders.get(traderId) || null;
  }

  async getFollower(followerId) {
    return this.followers.get(followerId) || null;
  }

  async getFollowRelationship(followerId, traderId) {
    return this.followRelationships.get(`${followerId}-${traderId}`) || null;
  }

  async getTradeSignal(signalId) {
    return this.tradeSignals.get(signalId) || null;
  }

  async getCopiedTrade(copyTradeId) {
    return this.copiedTrades.get(copyTradeId) || null;
  }

  async searchTraders(criteria = {}) {
    let traders = Array.from(this.traders.values())
      .filter(trader => trader.publicProfile && trader.status === TraderStatus.ACTIVE);

    if (criteria.specialty) {
      traders = traders.filter(trader => 
        trader.specialties.includes(criteria.specialty)
      );
    }

    if (criteria.minROI) {
      traders = traders.filter(trader => 
        (trader.roi90d || 0) >= criteria.minROI
      );
    }

    if (criteria.maxRisk) {
      traders = traders.filter(trader => 
        trader.riskScore <= criteria.maxRisk
      );
    }

    if (criteria.minFollowers) {
      traders = traders.filter(trader => 
        trader.followersCount >= criteria.minFollowers
      );
    }

    if (criteria.verified === true) {
      traders = traders.filter(trader => trader.verified);
    }

    return traders.slice(0, criteria.limit || 50);
  }

  async getRecentSignals(traderId = null, limit = 50) {
    let signals = Array.from(this.tradeSignals.values());

    if (traderId) {
      signals = signals.filter(signal => signal.traderId === traderId);
    }

    return signals
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, limit);
  }

  async getSocialFeed(userId, limit = 20) {
    // Get posts from followed traders
    const userFollows = Array.from(this.followRelationships.values())
      .filter(follow => follow.followerId === userId && follow.status === FollowStatus.ACTIVE)
      .map(follow => follow.traderId);

    const posts = Array.from(this.socialPosts.values())
      .filter(post => userFollows.includes(post.traderId))
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, limit);

    return posts;
  }

  getMetrics() {
    return {
      ...this.metrics,
      totalTraders: this.traders.size,
      activeFollowRelationships: Array.from(this.followRelationships.values())
        .filter(follow => follow.status === FollowStatus.ACTIVE).length,
      totalSocialPosts: this.socialPosts.size
    };
  }

  async stop() {
    this.isRunning = false;
    
    if (this.performanceTracker) {
      clearInterval(this.performanceTracker);
      this.performanceTracker = null;
    }
    
    if (this.signalProcessor) {
      clearInterval(this.signalProcessor);
      this.signalProcessor = null;
    }
    
    if (this.riskMonitor) {
      clearInterval(this.riskMonitor);
      this.riskMonitor = null;
    }
    
    if (this.socialUpdater) {
      clearInterval(this.socialUpdater);
      this.socialUpdater = null;
    }
    
    this.emit('stopped');
  }
}

export { TraderTier, FollowType, TradeSignalType, FollowStatus, TraderStatus };