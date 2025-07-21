/**
 * Social Feed Manager for Otedama
 * Manages activity feeds and social interactions
 * 
 * Design principles:
 * - Fast feed generation (Carmack)
 * - Clean timeline architecture (Martin)
 * - Simple post system (Pike)
 */

import { EventEmitter } from 'events';
import { logger } from '../core/logger.js';

export class FeedManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            maxPostLength: config.maxPostLength || 500,
            maxMediaPerPost: config.maxMediaPerPost || 4,
            feedCacheTime: config.feedCacheTime || 300000, // 5 minutes
            maxFeedItems: config.maxFeedItems || 100,
            maxCommentsPerPost: config.maxCommentsPerPost || 1000,
            maxLikesVisible: config.maxLikesVisible || 1000,
            ...config
        };
        
        // In-memory storage
        this.posts = new Map();
        this.comments = new Map(); // postId -> comments array
        this.likes = new Map(); // postId -> Set of userIds
        this.feeds = new Map(); // userId -> feed cache
        this.userTimelines = new Map(); // userId -> postIds array
        
        // Statistics
        this.stats = {
            totalPosts: 0,
            totalComments: 0,
            totalLikes: 0,
            totalShares: 0
        };
        
        // Post types
        this.postTypes = {
            TEXT: 'text',
            TRADE: 'trade',
            ANALYSIS: 'analysis',
            ACHIEVEMENT: 'achievement',
            MILESTONE: 'milestone',
            SHARE: 'share'
        };
    }
    
    /**
     * Create a new post
     */
    async createPost(userId, content) {
        const postId = this.generatePostId();
        
        const post = {
            id: postId,
            userId,
            type: content.type || this.postTypes.TEXT,
            text: content.text || '',
            media: content.media || [],
            tradingData: content.tradingData || null,
            analysis: content.analysis || null,
            achievement: content.achievement || null,
            sharedPostId: content.sharedPostId || null,
            tags: this.extractTags(content.text || ''),
            mentions: this.extractMentions(content.text || ''),
            visibility: content.visibility || 'public', // public, followers, private
            createdAt: Date.now(),
            updatedAt: Date.now(),
            stats: {
                likes: 0,
                comments: 0,
                shares: 0,
                views: 0
            }
        };
        
        // Validate post
        this.validatePost(post);
        
        // Store post
        this.posts.set(postId, post);
        
        // Add to user timeline
        if (!this.userTimelines.has(userId)) {
            this.userTimelines.set(userId, []);
        }
        this.userTimelines.get(userId).unshift(postId);
        
        // Initialize interactions
        this.comments.set(postId, []);
        this.likes.set(postId, new Set());
        
        // Update stats
        this.stats.totalPosts++;
        
        // Clear feed caches
        this.clearFeedCaches(userId);
        
        logger.info(`Post created: ${postId} by user ${userId}`);
        
        this.emit('post:created', post);
        
        // Handle special post types
        if (post.type === this.postTypes.ACHIEVEMENT) {
            this.emit('achievement:shared', {
                userId,
                achievement: post.achievement,
                postId
            });
        }
        
        return post;
    }
    
    /**
     * Create a trade post
     */
    async createTradePost(userId, trade, analysis = null) {
        const content = {
            type: this.postTypes.TRADE,
            text: analysis?.summary || `${trade.side.toUpperCase()} ${trade.pair} at ${trade.price}`,
            tradingData: {
                pair: trade.pair,
                side: trade.side,
                entryPrice: trade.price,
                size: trade.size,
                stopLoss: trade.stopLoss,
                takeProfit: trade.takeProfit,
                pnl: trade.pnl || null,
                roi: trade.roi || null,
                duration: trade.duration || null
            },
            analysis
        };
        
        return this.createPost(userId, content);
    }
    
    /**
     * Like a post
     */
    async likePost(userId, postId) {
        const post = this.posts.get(postId);
        if (!post) {
            throw new Error('Post not found');
        }
        
        const likes = this.likes.get(postId);
        if (likes.has(userId)) {
            throw new Error('Already liked this post');
        }
        
        // Add like
        likes.add(userId);
        post.stats.likes++;
        this.stats.totalLikes++;
        
        logger.debug(`User ${userId} liked post ${postId}`);
        
        this.emit('post:liked', {
            userId,
            postId,
            postAuthorId: post.userId,
            timestamp: Date.now()
        });
        
        return { success: true, totalLikes: post.stats.likes };
    }
    
    /**
     * Unlike a post
     */
    async unlikePost(userId, postId) {
        const post = this.posts.get(postId);
        if (!post) {
            throw new Error('Post not found');
        }
        
        const likes = this.likes.get(postId);
        if (!likes.has(userId)) {
            throw new Error('Not liked this post');
        }
        
        // Remove like
        likes.delete(userId);
        post.stats.likes--;
        this.stats.totalLikes--;
        
        logger.debug(`User ${userId} unliked post ${postId}`);
        
        this.emit('post:unliked', {
            userId,
            postId,
            postAuthorId: post.userId,
            timestamp: Date.now()
        });
        
        return { success: true, totalLikes: post.stats.likes };
    }
    
    /**
     * Comment on a post
     */
    async commentOnPost(userId, postId, text) {
        const post = this.posts.get(postId);
        if (!post) {
            throw new Error('Post not found');
        }
        
        const comments = this.comments.get(postId);
        if (comments.length >= this.config.maxCommentsPerPost) {
            throw new Error('Maximum comments reached');
        }
        
        const commentId = this.generateCommentId();
        
        const comment = {
            id: commentId,
            postId,
            userId,
            text: text.substring(0, this.config.maxPostLength),
            mentions: this.extractMentions(text),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            likes: 0
        };
        
        // Add comment
        comments.push(comment);
        post.stats.comments++;
        this.stats.totalComments++;
        
        logger.debug(`User ${userId} commented on post ${postId}`);
        
        this.emit('post:commented', {
            comment,
            postAuthorId: post.userId,
            timestamp: Date.now()
        });
        
        return comment;
    }
    
    /**
     * Share a post
     */
    async sharePost(userId, postId, comment = null) {
        const originalPost = this.posts.get(postId);
        if (!originalPost) {
            throw new Error('Post not found');
        }
        
        // Create share post
        const shareContent = {
            type: this.postTypes.SHARE,
            text: comment || '',
            sharedPostId: postId
        };
        
        const sharePost = await this.createPost(userId, shareContent);
        
        // Update original post stats
        originalPost.stats.shares++;
        this.stats.totalShares++;
        
        logger.debug(`User ${userId} shared post ${postId}`);
        
        this.emit('post:shared', {
            userId,
            originalPostId: postId,
            sharePostId: sharePost.id,
            originalAuthorId: originalPost.userId,
            timestamp: Date.now()
        });
        
        return sharePost;
    }
    
    /**
     * Get user feed
     */
    async getUserFeed(userId, options = {}) {
        const limit = options.limit || 50;
        const offset = options.offset || 0;
        const includeFollowing = options.includeFollowing !== false;
        
        // Check cache
        const cacheKey = `${userId}:${includeFollowing}`;
        if (this.feeds.has(cacheKey)) {
            const cached = this.feeds.get(cacheKey);
            if (Date.now() - cached.timestamp < this.config.feedCacheTime) {
                return {
                    posts: cached.posts.slice(offset, offset + limit),
                    total: cached.posts.length,
                    hasMore: offset + limit < cached.posts.length
                };
            }
        }
        
        // Build feed
        const feedPosts = [];
        
        // Get user's own posts
        const userPosts = this.userTimelines.get(userId) || [];
        
        // Get following users' posts (would come from social service)
        const followingPosts = []; // This would be populated from following list
        
        // Combine and sort by time
        const allPostIds = [...userPosts, ...followingPosts];
        
        // Get posts with interactions
        for (const postId of allPostIds) {
            const post = await this.getPostWithInteractions(postId, userId);
            if (post && this.canViewPost(userId, post)) {
                feedPosts.push(post);
            }
        }
        
        // Sort by creation time
        feedPosts.sort((a, b) => b.createdAt - a.createdAt);
        
        // Limit feed size
        const limitedFeed = feedPosts.slice(0, this.config.maxFeedItems);
        
        // Cache feed
        this.feeds.set(cacheKey, {
            posts: limitedFeed,
            timestamp: Date.now()
        });
        
        return {
            posts: limitedFeed.slice(offset, offset + limit),
            total: limitedFeed.length,
            hasMore: offset + limit < limitedFeed.length
        };
    }
    
    /**
     * Get post with interactions
     */
    async getPostWithInteractions(postId, viewerId = null) {
        const post = this.posts.get(postId);
        if (!post) return null;
        
        // Increment view count
        post.stats.views++;
        
        // Get interactions
        const likes = this.likes.get(postId) || new Set();
        const comments = this.comments.get(postId) || [];
        
        // Get shared post if applicable
        let sharedPost = null;
        if (post.sharedPostId) {
            sharedPost = await this.getPostWithInteractions(post.sharedPostId);
        }
        
        return {
            ...post,
            isLiked: viewerId ? likes.has(viewerId) : false,
            likes: Array.from(likes).slice(0, this.config.maxLikesVisible),
            comments: comments.slice(-10), // Last 10 comments
            sharedPost
        };
    }
    
    /**
     * Get trending posts
     */
    async getTrendingPosts(period = 24, limit = 20) {
        const cutoff = Date.now() - (period * 60 * 60 * 1000);
        const trendingPosts = [];
        
        for (const [postId, post] of this.posts) {
            if (post.createdAt > cutoff) {
                // Calculate trending score
                const ageHours = (Date.now() - post.createdAt) / (60 * 60 * 1000);
                const engagement = post.stats.likes + (post.stats.comments * 2) + (post.stats.shares * 3);
                const trendingScore = engagement / Math.pow(ageHours + 2, 1.8); // Reddit-like algorithm
                
                trendingPosts.push({
                    post: await this.getPostWithInteractions(postId),
                    score: trendingScore
                });
            }
        }
        
        // Sort by trending score
        trendingPosts.sort((a, b) => b.score - a.score);
        
        return trendingPosts
            .slice(0, limit)
            .map(item => item.post);
    }
    
    /**
     * Get posts by tag
     */
    async getPostsByTag(tag, limit = 50, offset = 0) {
        const tagLower = tag.toLowerCase();
        const taggedPosts = [];
        
        for (const [postId, post] of this.posts) {
            if (post.tags.includes(tagLower)) {
                taggedPosts.push(await this.getPostWithInteractions(postId));
            }
        }
        
        // Sort by creation time
        taggedPosts.sort((a, b) => b.createdAt - a.createdAt);
        
        return {
            posts: taggedPosts.slice(offset, offset + limit),
            total: taggedPosts.length,
            hasMore: offset + limit < taggedPosts.length
        };
    }
    
    /**
     * Delete post
     */
    async deletePost(userId, postId) {
        const post = this.posts.get(postId);
        if (!post) {
            throw new Error('Post not found');
        }
        
        if (post.userId !== userId) {
            throw new Error('Unauthorized to delete this post');
        }
        
        // Remove from storage
        this.posts.delete(postId);
        this.comments.delete(postId);
        this.likes.delete(postId);
        
        // Remove from user timeline
        const timeline = this.userTimelines.get(userId);
        if (timeline) {
            const index = timeline.indexOf(postId);
            if (index > -1) {
                timeline.splice(index, 1);
            }
        }
        
        // Clear caches
        this.clearFeedCaches(userId);
        
        logger.info(`Post deleted: ${postId}`);
        
        this.emit('post:deleted', {
            postId,
            userId,
            timestamp: Date.now()
        });
        
        return { success: true };
    }
    
    /**
     * Helper methods
     */
    
    validatePost(post) {
        if (post.text.length > this.config.maxPostLength) {
            throw new Error(`Post text exceeds maximum length of ${this.config.maxPostLength}`);
        }
        
        if (post.media.length > this.config.maxMediaPerPost) {
            throw new Error(`Maximum ${this.config.maxMediaPerPost} media items allowed`);
        }
    }
    
    extractTags(text) {
        const tags = text.match(/#\w+/g) || [];
        return tags.map(tag => tag.substring(1).toLowerCase());
    }
    
    extractMentions(text) {
        const mentions = text.match(/@\w+/g) || [];
        return mentions.map(mention => mention.substring(1));
    }
    
    canViewPost(viewerId, post) {
        if (post.visibility === 'public') return true;
        if (post.visibility === 'private' && post.userId === viewerId) return true;
        // Would check following relationship for 'followers' visibility
        return false;
    }
    
    clearFeedCaches(userId) {
        // Clear user's feed cache and their followers' caches
        for (const [key] of this.feeds) {
            if (key.includes(userId)) {
                this.feeds.delete(key);
            }
        }
    }
    
    generatePostId() {
        return `post_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    generateCommentId() {
        return `comment_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Get feed statistics
     */
    getStats() {
        const recentPosts = Array.from(this.posts.values())
            .filter(p => Date.now() - p.createdAt < 24 * 60 * 60 * 1000);
        
        return {
            ...this.stats,
            postsToday: recentPosts.length,
            engagementToday: recentPosts.reduce((sum, p) => 
                sum + p.stats.likes + p.stats.comments + p.stats.shares, 0
            ),
            popularTags: this.getPopularTags(10)
        };
    }
    
    getPopularTags(limit = 10) {
        const tagCounts = new Map();
        
        for (const post of this.posts.values()) {
            for (const tag of post.tags) {
                tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
            }
        }
        
        return Array.from(tagCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([tag, count]) => ({ tag, count }));
    }
}

export default FeedManager;