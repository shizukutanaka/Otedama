/**
 * Social Trading Core for Otedama
 * Enables copy trading and social features
 * 
 * Design principles:
 * - High-performance social graph (Carmack)
 * - Clean social architecture (Martin)
 * - Simple following system (Pike)
 */

import { EventEmitter } from 'events';
import { logger } from '../core/logger.js';
import { inc, set, observe } from '../monitoring/index.js';

export class SocialTradingCore extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            maxFollowers: config.maxFollowers || 10000,
            maxFollowing: config.maxFollowing || 1000,
            minCopyAmount: config.minCopyAmount || 10, // Minimum USDT to copy trade
            maxCopyAmount: config.maxCopyAmount || 100000,
            performancePeriods: config.performancePeriods || [7, 30, 90], // days
            leaderboardSize: config.leaderboardSize || 100,
            profitShareDefault: config.profitShareDefault || 0.1, // 10% profit share
            ...config
        };
        
        // In-memory storage (would be database in production)
        this.users = new Map();
        this.following = new Map(); // userId -> Set of followedUserIds
        this.followers = new Map(); // userId -> Set of followerUserIds
        this.copySettings = new Map(); // followerId:leaderId -> settings
        this.traderStats = new Map();
        this.leaderboards = new Map();
        
        // Performance tracking
        this.stats = {
            totalUsers: 0,
            totalFollows: 0,
            activeCopyTraders: 0,
            totalCopiedVolume: 0
        };
        
        // Start periodic updates
        this.startPeriodicUpdates();
    }
    
    /**
     * Register a user for social trading
     */
    async registerUser(userId, profile = {}) {
        if (this.users.has(userId)) {
            throw new Error('User already registered');
        }
        
        const user = {
            id: userId,
            username: profile.username || `trader_${userId.substring(0, 8)}`,
            displayName: profile.displayName || profile.username,
            avatar: profile.avatar || null,
            bio: profile.bio || '',
            isPublic: profile.isPublic !== false,
            isPro: profile.isPro || false,
            allowCopyTrading: profile.allowCopyTrading || false,
            profitShare: profile.profitShare || this.config.profitShareDefault,
            minCopyAmount: profile.minCopyAmount || this.config.minCopyAmount,
            maxCopyAmount: profile.maxCopyAmount || this.config.maxCopyAmount,
            registeredAt: Date.now(),
            verified: false,
            badges: [],
            stats: {
                followers: 0,
                following: 0,
                copiers: 0,
                totalProfitGenerated: 0
            }
        };
        
        this.users.set(userId, user);
        this.following.set(userId, new Set());
        this.followers.set(userId, new Set());
        
        // Initialize trader stats
        this.traderStats.set(userId, {
            trades: 0,
            winRate: 0,
            profitFactor: 0,
            sharpeRatio: 0,
            maxDrawdown: 0,
            roi: {},
            performance: {}
        });
        
        this.stats.totalUsers++;
        
        logger.info(`User registered for social trading: ${userId}`);
        this.emit('user:registered', user);
        
        return user;
    }
    
    /**
     * Follow another trader
     */
    async followTrader(followerId, traderId) {
        if (!this.users.has(followerId) || !this.users.has(traderId)) {
            throw new Error('User not found');
        }
        
        if (followerId === traderId) {
            throw new Error('Cannot follow yourself');
        }
        
        const followerSet = this.following.get(followerId);
        const traderFollowers = this.followers.get(traderId);
        
        if (followerSet.has(traderId)) {
            throw new Error('Already following this trader');
        }
        
        if (followerSet.size >= this.config.maxFollowing) {
            throw new Error(`Cannot follow more than ${this.config.maxFollowing} traders`);
        }
        
        if (traderFollowers.size >= this.config.maxFollowers) {
            throw new Error('This trader has reached maximum followers');
        }
        
        // Add follow relationship
        followerSet.add(traderId);
        traderFollowers.add(followerId);
        
        // Update stats
        this.users.get(followerId).stats.following++;
        this.users.get(traderId).stats.followers++;
        this.stats.totalFollows++;
        
        logger.info(`User ${followerId} followed trader ${traderId}`);
        
        this.emit('trader:followed', {
            followerId,
            traderId,
            timestamp: Date.now()
        });
        
        return { success: true };
    }
    
    /**
     * Unfollow a trader
     */
    async unfollowTrader(followerId, traderId) {
        const followerSet = this.following.get(followerId);
        const traderFollowers = this.followers.get(traderId);
        
        if (!followerSet?.has(traderId)) {
            throw new Error('Not following this trader');
        }
        
        // Remove follow relationship
        followerSet.delete(traderId);
        traderFollowers.delete(followerId);
        
        // Update stats
        this.users.get(followerId).stats.following--;
        this.users.get(traderId).stats.followers--;
        this.stats.totalFollows--;
        
        // Remove copy trading if exists
        const copyKey = `${followerId}:${traderId}`;
        if (this.copySettings.has(copyKey)) {
            await this.stopCopyTrading(followerId, traderId);
        }
        
        logger.info(`User ${followerId} unfollowed trader ${traderId}`);
        
        this.emit('trader:unfollowed', {
            followerId,
            traderId,
            timestamp: Date.now()
        });
        
        return { success: true };
    }
    
    /**
     * Start copy trading
     */
    async startCopyTrading(followerId, traderId, settings = {}) {
        if (!this.following.get(followerId)?.has(traderId)) {
            throw new Error('Must follow trader before copy trading');
        }
        
        const trader = this.users.get(traderId);
        if (!trader.allowCopyTrading) {
            throw new Error('This trader does not allow copy trading');
        }
        
        const copyAmount = settings.amount || trader.minCopyAmount;
        
        if (copyAmount < trader.minCopyAmount) {
            throw new Error(`Minimum copy amount is ${trader.minCopyAmount} USDT`);
        }
        
        if (copyAmount > trader.maxCopyAmount) {
            throw new Error(`Maximum copy amount is ${trader.maxCopyAmount} USDT`);
        }
        
        const copyKey = `${followerId}:${traderId}`;
        
        const copyConfig = {
            followerId,
            traderId,
            amount: copyAmount,
            mode: settings.mode || 'proportional', // proportional, fixed
            maxLoss: settings.maxLoss || copyAmount * 0.2, // 20% max loss
            takeProfitMultiplier: settings.takeProfitMultiplier || 1,
            stopLossMultiplier: settings.stopLossMultiplier || 1,
            copyOpenTrades: settings.copyOpenTrades || false,
            profitShare: trader.profitShare,
            startedAt: Date.now(),
            isPaused: false,
            stats: {
                totalTrades: 0,
                profitLoss: 0,
                profitShared: 0
            }
        };
        
        this.copySettings.set(copyKey, copyConfig);
        
        // Update stats
        this.users.get(traderId).stats.copiers++;
        this.stats.activeCopyTraders++;
        this.stats.totalCopiedVolume += copyAmount;
        
        logger.info(`Copy trading started: ${followerId} copying ${traderId} with ${copyAmount} USDT`);
        
        this.emit('copy:started', copyConfig);
        
        // Copy open positions if requested
        if (copyConfig.copyOpenTrades) {
            await this.copyOpenPositions(followerId, traderId, copyConfig);
        }
        
        return copyConfig;
    }
    
    /**
     * Stop copy trading
     */
    async stopCopyTrading(followerId, traderId) {
        const copyKey = `${followerId}:${traderId}`;
        const copyConfig = this.copySettings.get(copyKey);
        
        if (!copyConfig) {
            throw new Error('No copy trading relationship found');
        }
        
        // Calculate final profit share
        if (copyConfig.stats.profitLoss > 0) {
            const profitShare = copyConfig.stats.profitLoss * copyConfig.profitShare;
            copyConfig.stats.profitShared = profitShare;
            
            // Process profit share payment
            await this.processProfitShare(followerId, traderId, profitShare);
        }
        
        // Remove copy settings
        this.copySettings.delete(copyKey);
        
        // Update stats
        this.users.get(traderId).stats.copiers--;
        this.stats.activeCopyTraders--;
        
        logger.info(`Copy trading stopped: ${followerId} stopped copying ${traderId}`);
        
        this.emit('copy:stopped', {
            ...copyConfig,
            stoppedAt: Date.now()
        });
        
        return {
            success: true,
            finalStats: copyConfig.stats
        };
    }
    
    /**
     * Handle trade execution from leader
     */
    async handleLeaderTrade(traderId, trade) {
        // Find all copiers
        const copiers = [];
        
        for (const [key, config] of this.copySettings) {
            if (config.traderId === traderId && !config.isPaused) {
                copiers.push(config);
            }
        }
        
        if (copiers.length === 0) return;
        
        logger.info(`Processing leader trade for ${copiers.length} copiers`);
        
        // Process each copier
        const copyTrades = [];
        
        for (const config of copiers) {
            try {
                const copyTrade = await this.createCopyTrade(config, trade);
                if (copyTrade) {
                    copyTrades.push(copyTrade);
                    config.stats.totalTrades++;
                }
            } catch (error) {
                logger.error(`Failed to copy trade for ${config.followerId}:`, error);
                
                this.emit('copy:error', {
                    followerId: config.followerId,
                    traderId: config.traderId,
                    error: error.message,
                    trade
                });
            }
        }
        
        this.emit('trades:copied', {
            leaderTrade: trade,
            copyTrades,
            timestamp: Date.now()
        });
        
        return copyTrades;
    }
    
    /**
     * Create copy trade based on settings
     */
    async createCopyTrade(config, leaderTrade) {
        let copySize;
        
        if (config.mode === 'fixed') {
            // Fixed size copy
            copySize = config.amount / 1000; // Simple fixed sizing
        } else {
            // Proportional copy
            const proportion = config.amount / 10000; // Assume leader has 10k capital
            copySize = leaderTrade.size * proportion;
        }
        
        // Apply risk management
        const maxRisk = config.maxLoss / 100; // Max risk per trade
        if (copySize * leaderTrade.price > maxRisk) {
            copySize = maxRisk / leaderTrade.price;
        }
        
        // Create copy trade
        const copyTrade = {
            followerId: config.followerId,
            leaderId: config.traderId,
            originalTradeId: leaderTrade.id,
            pair: leaderTrade.pair,
            side: leaderTrade.side,
            size: copySize,
            price: leaderTrade.price,
            stopLoss: leaderTrade.stopLoss ? leaderTrade.stopLoss * config.stopLossMultiplier : null,
            takeProfit: leaderTrade.takeProfit ? leaderTrade.takeProfit * config.takeProfitMultiplier : null,
            timestamp: Date.now()
        };
        
        return copyTrade;
    }
    
    /**
     * Update trader statistics
     */
    async updateTraderStats(traderId, tradeResult) {
        const stats = this.traderStats.get(traderId);
        if (!stats) return;
        
        stats.trades++;
        
        // Update win rate
        if (tradeResult.profit > 0) {
            stats.winRate = ((stats.winRate * (stats.trades - 1)) + 1) / stats.trades;
        } else {
            stats.winRate = (stats.winRate * (stats.trades - 1)) / stats.trades;
        }
        
        // Update performance metrics
        for (const period of this.config.performancePeriods) {
            if (!stats.performance[period]) {
                stats.performance[period] = {
                    profit: 0,
                    trades: 0,
                    startEquity: 10000 // Default starting equity
                };
            }
            
            const perf = stats.performance[period];
            perf.profit += tradeResult.profit;
            perf.trades++;
            
            // Calculate ROI
            stats.roi[period] = (perf.profit / perf.startEquity) * 100;
        }
        
        // Update profit factor
        if (tradeResult.profit > 0) {
            stats.totalWins = (stats.totalWins || 0) + tradeResult.profit;
        } else {
            stats.totalLosses = (stats.totalLosses || 0) + Math.abs(tradeResult.profit);
        }
        
        if (stats.totalLosses > 0) {
            stats.profitFactor = stats.totalWins / stats.totalLosses;
        }
        
        // Emit stats update
        this.emit('stats:updated', {
            traderId,
            stats,
            tradeResult
        });
    }
    
    /**
     * Get trader profile with stats
     */
    async getTraderProfile(traderId, viewerId = null) {
        const user = this.users.get(traderId);
        if (!user) {
            throw new Error('Trader not found');
        }
        
        const stats = this.traderStats.get(traderId);
        const isFollowing = viewerId ? this.following.get(viewerId)?.has(traderId) : false;
        const copySettings = viewerId ? this.copySettings.get(`${viewerId}:${traderId}`) : null;
        
        return {
            ...user,
            stats: {
                ...user.stats,
                ...stats
            },
            isFollowing,
            copySettings,
            canCopy: user.allowCopyTrading && (!viewerId || viewerId !== traderId)
        };
    }
    
    /**
     * Get followers list
     */
    async getFollowers(traderId, limit = 50, offset = 0) {
        const followerIds = Array.from(this.followers.get(traderId) || []);
        const total = followerIds.length;
        
        const followers = followerIds
            .slice(offset, offset + limit)
            .map(id => {
                const user = this.users.get(id);
                const copyKey = `${id}:${traderId}`;
                const isCopying = this.copySettings.has(copyKey);
                
                return {
                    id: user.id,
                    username: user.username,
                    displayName: user.displayName,
                    avatar: user.avatar,
                    isCopying,
                    followedAt: Date.now() // Would be stored in DB
                };
            });
        
        return {
            followers,
            total,
            hasMore: offset + limit < total
        };
    }
    
    /**
     * Get following list
     */
    async getFollowing(userId, limit = 50, offset = 0) {
        const followingIds = Array.from(this.following.get(userId) || []);
        const total = followingIds.length;
        
        const following = followingIds
            .slice(offset, offset + limit)
            .map(id => {
                const user = this.users.get(id);
                const stats = this.traderStats.get(id);
                const copyKey = `${userId}:${id}`;
                const copySettings = this.copySettings.get(copyKey);
                
                return {
                    id: user.id,
                    username: user.username,
                    displayName: user.displayName,
                    avatar: user.avatar,
                    isPro: user.isPro,
                    stats: {
                        roi30d: stats.roi[30] || 0,
                        winRate: stats.winRate || 0,
                        followers: user.stats.followers
                    },
                    isCopying: !!copySettings,
                    copyAmount: copySettings?.amount || 0,
                    followedAt: Date.now() // Would be stored in DB
                };
            });
        
        return {
            following,
            total,
            hasMore: offset + limit < total
        };
    }
    
    /**
     * Get copy traders for a leader
     */
    async getCopyTraders(traderId, includeStats = false) {
        const copiers = [];
        
        for (const [key, config] of this.copySettings) {
            if (config.traderId === traderId) {
                const user = this.users.get(config.followerId);
                
                const copier = {
                    id: user.id,
                    username: user.username,
                    displayName: user.displayName,
                    copyAmount: config.amount,
                    mode: config.mode,
                    startedAt: config.startedAt,
                    isPaused: config.isPaused
                };
                
                if (includeStats) {
                    copier.stats = config.stats;
                }
                
                copiers.push(copier);
            }
        }
        
        return copiers;
    }
    
    /**
     * Search traders
     */
    async searchTraders(query, filters = {}) {
        const results = [];
        const searchTerm = query.toLowerCase();
        
        for (const [userId, user] of this.users) {
            // Skip private profiles unless following
            if (!user.isPublic && filters.viewerId && 
                !this.following.get(filters.viewerId)?.has(userId)) {
                continue;
            }
            
            // Search by username or display name
            if (user.username.toLowerCase().includes(searchTerm) ||
                user.displayName.toLowerCase().includes(searchTerm)) {
                
                const stats = this.traderStats.get(userId);
                
                // Apply filters
                if (filters.minRoi && (!stats.roi[30] || stats.roi[30] < filters.minRoi)) {
                    continue;
                }
                
                if (filters.minWinRate && (!stats.winRate || stats.winRate < filters.minWinRate)) {
                    continue;
                }
                
                if (filters.allowCopyTrading && !user.allowCopyTrading) {
                    continue;
                }
                
                if (filters.verifiedOnly && !user.verified) {
                    continue;
                }
                
                results.push({
                    id: user.id,
                    username: user.username,
                    displayName: user.displayName,
                    avatar: user.avatar,
                    isPro: user.isPro,
                    verified: user.verified,
                    allowCopyTrading: user.allowCopyTrading,
                    stats: {
                        followers: user.stats.followers,
                        roi30d: stats.roi[30] || 0,
                        winRate: stats.winRate || 0,
                        trades: stats.trades
                    }
                });
            }
        }
        
        // Sort by relevance/performance
        results.sort((a, b) => {
            if (filters.sortBy === 'roi') {
                return b.stats.roi30d - a.stats.roi30d;
            } else if (filters.sortBy === 'followers') {
                return b.stats.followers - a.stats.followers;
            } else if (filters.sortBy === 'winRate') {
                return b.stats.winRate - a.stats.winRate;
            }
            return 0;
        });
        
        return results.slice(0, filters.limit || 50);
    }
    
    /**
     * Get trader leaderboard
     */
    async getLeaderboard(period = 30, category = 'roi') {
        const cacheKey = `${period}:${category}`;
        
        // Check cache
        if (this.leaderboards.has(cacheKey)) {
            const cached = this.leaderboards.get(cacheKey);
            if (Date.now() - cached.timestamp < 300000) { // 5 min cache
                return cached.data;
            }
        }
        
        const traders = [];
        
        for (const [userId, user] of this.users) {
            if (!user.isPublic || !user.allowCopyTrading) continue;
            
            const stats = this.traderStats.get(userId);
            if (!stats || stats.trades < 10) continue; // Min 10 trades
            
            let score;
            switch (category) {
                case 'roi':
                    score = stats.roi[period] || 0;
                    break;
                case 'profitFactor':
                    score = stats.profitFactor || 0;
                    break;
                case 'winRate':
                    score = stats.winRate || 0;
                    break;
                case 'followers':
                    score = user.stats.followers;
                    break;
                default:
                    score = 0;
            }
            
            if (score > 0) {
                traders.push({
                    rank: 0,
                    id: user.id,
                    username: user.username,
                    displayName: user.displayName,
                    avatar: user.avatar,
                    isPro: user.isPro,
                    verified: user.verified,
                    badges: user.badges,
                    score,
                    stats: {
                        roi: stats.roi[period] || 0,
                        winRate: stats.winRate,
                        profitFactor: stats.profitFactor,
                        trades: stats.trades,
                        followers: user.stats.followers,
                        copiers: user.stats.copiers
                    }
                });
            }
        }
        
        // Sort and rank
        traders.sort((a, b) => b.score - a.score);
        traders.forEach((trader, index) => {
            trader.rank = index + 1;
        });
        
        const leaderboard = traders.slice(0, this.config.leaderboardSize);
        
        // Cache result
        this.leaderboards.set(cacheKey, {
            data: leaderboard,
            timestamp: Date.now()
        });
        
        return leaderboard;
    }
    
    /**
     * Process profit share payment
     */
    async processProfitShare(followerId, traderId, amount) {
        logger.info(`Processing profit share: ${amount} USDT from ${followerId} to ${traderId}`);
        
        // Update trader's total profit generated
        const trader = this.users.get(traderId);
        if (trader) {
            trader.stats.totalProfitGenerated += amount;
        }
        
        this.emit('profitshare:processed', {
            followerId,
            traderId,
            amount,
            timestamp: Date.now()
        });
        
        // In production, this would process actual payment
        return { success: true, amount };
    }
    
    /**
     * Copy open positions when starting copy trading
     */
    async copyOpenPositions(followerId, traderId, config) {
        // This would fetch open positions from trading system
        logger.info(`Copying open positions from ${traderId} to ${followerId}`);
        
        this.emit('positions:copied', {
            followerId,
            traderId,
            config,
            timestamp: Date.now()
        });
    }
    
    /**
     * Award badges to traders
     */
    async awardBadge(traderId, badgeType) {
        const user = this.users.get(traderId);
        if (!user) return;
        
        const badge = {
            type: badgeType,
            awardedAt: Date.now()
        };
        
        // Define badge criteria
        const badges = {
            'rising-star': { minFollowers: 100, minRoi: 20 },
            'consistent-winner': { minWinRate: 0.7, minTrades: 100 },
            'profit-machine': { minProfitFactor: 2, minTrades: 50 },
            'popular-trader': { minFollowers: 1000 },
            'elite-trader': { minRoi: 100, minFollowers: 500, minTrades: 200 }
        };
        
        if (!user.badges.find(b => b.type === badgeType)) {
            user.badges.push(badge);
            
            logger.info(`Badge awarded: ${badgeType} to ${traderId}`);
            
            this.emit('badge:awarded', {
                traderId,
                badge,
                user
            });
        }
    }
    
    /**
     * Start periodic updates
     */
    startPeriodicUpdates() {
        // Update leaderboards every hour
        setInterval(() => {
            this.leaderboards.clear();
            this.emit('leaderboards:refreshed');
        }, 3600000);
        
        // Check for badge eligibility every day
        setInterval(async () => {
            for (const [userId, user] of this.users) {
                const stats = this.traderStats.get(userId);
                if (!stats) continue;
                
                // Check each badge criteria
                if (user.stats.followers >= 100 && stats.roi[30] >= 20) {
                    await this.awardBadge(userId, 'rising-star');
                }
                
                if (stats.winRate >= 0.7 && stats.trades >= 100) {
                    await this.awardBadge(userId, 'consistent-winner');
                }
                
                if (stats.profitFactor >= 2 && stats.trades >= 50) {
                    await this.awardBadge(userId, 'profit-machine');
                }
                
                if (user.stats.followers >= 1000) {
                    await this.awardBadge(userId, 'popular-trader');
                }
                
                if (stats.roi[90] >= 100 && user.stats.followers >= 500 && stats.trades >= 200) {
                    await this.awardBadge(userId, 'elite-trader');
                }
            }
        }, 86400000); // Daily
    }
    
    /**
     * Get platform statistics
     */
    getStats() {
        return {
            ...this.stats,
            topTraders: Array.from(this.users.values())
                .filter(u => u.allowCopyTrading)
                .sort((a, b) => b.stats.followers - a.stats.followers)
                .slice(0, 10)
                .map(u => ({
                    id: u.id,
                    username: u.username,
                    followers: u.stats.followers,
                    copiers: u.stats.copiers
                }))
        };
    }
}

export default SocialTradingCore;