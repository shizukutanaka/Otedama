/**
 * Social Trading API Endpoints for Otedama
 * Handles social features and copy trading
 * 
 * Design principles:
 * - Fast social operations (Carmack)
 * - Clean API design (Martin)
 * - Simple social features (Pike)
 */

import { Router } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { authenticateToken } from '../auth/middleware.js';
import { getLogger } from '../core/logger.js';

const logger = getLogger('SocialEndpoints');

const router = Router();

/**
 * Register for social trading
 * POST /api/social/register
 */
router.post('/register',
    authenticateToken,
    [
        body('username').isString().isLength({ min: 3, max: 30 }).matches(/^[a-zA-Z0-9_]+$/),
        body('displayName').optional().isString().isLength({ max: 50 }),
        body('bio').optional().isString().isLength({ max: 500 }),
        body('allowCopyTrading').optional().isBoolean(),
        body('profitShare').optional().isFloat({ min: 0, max: 0.5 })
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const socialCore = req.app.locals.socialCore;
            if (!socialCore) {
                return res.status(503).json({ error: 'Social service not available' });
            }
            
            const profile = await socialCore.registerUser(req.user.id, req.body);
            
            res.status(201).json({
                success: true,
                profile
            });
            
        } catch (error) {
            logger.error('Social registration error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Get trader profile
 * GET /api/social/traders/:traderId
 */
router.get('/traders/:traderId',
    authenticateToken,
    param('traderId').isString(),
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const socialCore = req.app.locals.socialCore;
            if (!socialCore) {
                return res.status(503).json({ error: 'Social service not available' });
            }
            
            const profile = await socialCore.getTraderProfile(
                req.params.traderId,
                req.user.id
            );
            
            res.json({
                success: true,
                profile
            });
            
        } catch (error) {
            logger.error('Get profile error:', error);
            res.status(error.message === 'Trader not found' ? 404 : 500)
                .json({ error: error.message });
        }
    }
);

/**
 * Follow a trader
 * POST /api/social/follow/:traderId
 */
router.post('/follow/:traderId',
    authenticateToken,
    param('traderId').isString(),
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const socialCore = req.app.locals.socialCore;
            if (!socialCore) {
                return res.status(503).json({ error: 'Social service not available' });
            }
            
            const result = await socialCore.followTrader(req.user.id, req.params.traderId);
            
            res.json(result);
            
        } catch (error) {
            logger.error('Follow error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Unfollow a trader
 * DELETE /api/social/follow/:traderId
 */
router.delete('/follow/:traderId',
    authenticateToken,
    param('traderId').isString(),
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const socialCore = req.app.locals.socialCore;
            if (!socialCore) {
                return res.status(503).json({ error: 'Social service not available' });
            }
            
            const result = await socialCore.unfollowTrader(req.user.id, req.params.traderId);
            
            res.json(result);
            
        } catch (error) {
            logger.error('Unfollow error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Start copy trading
 * POST /api/social/copy/:traderId
 */
router.post('/copy/:traderId',
    authenticateToken,
    [
        param('traderId').isString(),
        body('amount').isFloat({ min: 10, max: 100000 }),
        body('mode').optional().isIn(['proportional', 'fixed']),
        body('maxLoss').optional().isFloat({ min: 0 }),
        body('copyOpenTrades').optional().isBoolean()
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const socialCore = req.app.locals.socialCore;
            if (!socialCore) {
                return res.status(503).json({ error: 'Social service not available' });
            }
            
            const copyConfig = await socialCore.startCopyTrading(
                req.user.id,
                req.params.traderId,
                req.body
            );
            
            res.json({
                success: true,
                copyConfig
            });
            
        } catch (error) {
            logger.error('Start copy error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Stop copy trading
 * DELETE /api/social/copy/:traderId
 */
router.delete('/copy/:traderId',
    authenticateToken,
    param('traderId').isString(),
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const socialCore = req.app.locals.socialCore;
            if (!socialCore) {
                return res.status(503).json({ error: 'Social service not available' });
            }
            
            const result = await socialCore.stopCopyTrading(req.user.id, req.params.traderId);
            
            res.json(result);
            
        } catch (error) {
            logger.error('Stop copy error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Get followers
 * GET /api/social/traders/:traderId/followers
 */
router.get('/traders/:traderId/followers',
    authenticateToken,
    [
        param('traderId').isString(),
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('offset').optional().isInt({ min: 0 })
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const socialCore = req.app.locals.socialCore;
            if (!socialCore) {
                return res.status(503).json({ error: 'Social service not available' });
            }
            
            const result = await socialCore.getFollowers(
                req.params.traderId,
                parseInt(req.query.limit) || 50,
                parseInt(req.query.offset) || 0
            );
            
            res.json({
                success: true,
                ...result
            });
            
        } catch (error) {
            logger.error('Get followers error:', error);
            res.status(500).json({ error: 'Failed to get followers' });
        }
    }
);

/**
 * Get following
 * GET /api/social/following
 */
router.get('/following',
    authenticateToken,
    [
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('offset').optional().isInt({ min: 0 })
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const socialCore = req.app.locals.socialCore;
            if (!socialCore) {
                return res.status(503).json({ error: 'Social service not available' });
            }
            
            const result = await socialCore.getFollowing(
                req.user.id,
                parseInt(req.query.limit) || 50,
                parseInt(req.query.offset) || 0
            );
            
            res.json({
                success: true,
                ...result
            });
            
        } catch (error) {
            logger.error('Get following error:', error);
            res.status(500).json({ error: 'Failed to get following' });
        }
    }
);

/**
 * Search traders
 * GET /api/social/search
 */
router.get('/search',
    authenticateToken,
    [
        query('q').notEmpty().isString(),
        query('minRoi').optional().isFloat(),
        query('minWinRate').optional().isFloat({ min: 0, max: 1 }),
        query('allowCopyTrading').optional().isBoolean(),
        query('verifiedOnly').optional().isBoolean(),
        query('sortBy').optional().isIn(['roi', 'followers', 'winRate']),
        query('limit').optional().isInt({ min: 1, max: 100 })
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const socialCore = req.app.locals.socialCore;
            if (!socialCore) {
                return res.status(503).json({ error: 'Social service not available' });
            }
            
            const results = await socialCore.searchTraders(req.query.q, {
                ...req.query,
                viewerId: req.user.id
            });
            
            res.json({
                success: true,
                results,
                count: results.length
            });
            
        } catch (error) {
            logger.error('Search error:', error);
            res.status(500).json({ error: 'Search failed' });
        }
    }
);

/**
 * Get leaderboard
 * GET /api/social/leaderboard
 */
router.get('/leaderboard',
    [
        query('period').optional().isIn(['7', '30', '90']),
        query('category').optional().isIn(['roi', 'profitFactor', 'winRate', 'followers'])
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const socialCore = req.app.locals.socialCore;
            if (!socialCore) {
                return res.status(503).json({ error: 'Social service not available' });
            }
            
            const leaderboard = await socialCore.getLeaderboard(
                parseInt(req.query.period) || 30,
                req.query.category || 'roi'
            );
            
            res.json({
                success: true,
                leaderboard,
                period: req.query.period || 30,
                category: req.query.category || 'roi'
            });
            
        } catch (error) {
            logger.error('Leaderboard error:', error);
            res.status(500).json({ error: 'Failed to get leaderboard' });
        }
    }
);

/**
 * Create a post
 * POST /api/social/posts
 */
router.post('/posts',
    authenticateToken,
    [
        body('type').optional().isIn(['text', 'trade', 'analysis', 'achievement', 'share']),
        body('text').optional().isString().isLength({ max: 500 }),
        body('tradingData').optional().isObject(),
        body('analysis').optional().isObject(),
        body('visibility').optional().isIn(['public', 'followers', 'private'])
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const feedManager = req.app.locals.feedManager;
            if (!feedManager) {
                return res.status(503).json({ error: 'Feed service not available' });
            }
            
            const post = await feedManager.createPost(req.user.id, req.body);
            
            res.status(201).json({
                success: true,
                post
            });
            
        } catch (error) {
            logger.error('Create post error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Get user feed
 * GET /api/social/feed
 */
router.get('/feed',
    authenticateToken,
    [
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('offset').optional().isInt({ min: 0 }),
        query('includeFollowing').optional().isBoolean()
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const feedManager = req.app.locals.feedManager;
            if (!feedManager) {
                return res.status(503).json({ error: 'Feed service not available' });
            }
            
            const feed = await feedManager.getUserFeed(req.user.id, {
                limit: parseInt(req.query.limit) || 50,
                offset: parseInt(req.query.offset) || 0,
                includeFollowing: req.query.includeFollowing !== 'false'
            });
            
            res.json({
                success: true,
                ...feed
            });
            
        } catch (error) {
            logger.error('Get feed error:', error);
            res.status(500).json({ error: 'Failed to get feed' });
        }
    }
);

/**
 * Like a post
 * POST /api/social/posts/:postId/like
 */
router.post('/posts/:postId/like',
    authenticateToken,
    param('postId').isString(),
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const feedManager = req.app.locals.feedManager;
            if (!feedManager) {
                return res.status(503).json({ error: 'Feed service not available' });
            }
            
            const result = await feedManager.likePost(req.user.id, req.params.postId);
            
            res.json(result);
            
        } catch (error) {
            logger.error('Like post error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Comment on a post
 * POST /api/social/posts/:postId/comment
 */
router.post('/posts/:postId/comment',
    authenticateToken,
    [
        param('postId').isString(),
        body('text').notEmpty().isString().isLength({ max: 500 })
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const feedManager = req.app.locals.feedManager;
            if (!feedManager) {
                return res.status(503).json({ error: 'Feed service not available' });
            }
            
            const comment = await feedManager.commentOnPost(
                req.user.id,
                req.params.postId,
                req.body.text
            );
            
            res.status(201).json({
                success: true,
                comment
            });
            
        } catch (error) {
            logger.error('Comment error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Get social stats
 * GET /api/social/stats
 */
router.get('/stats', async (req, res) => {
    try {
        const socialCore = req.app.locals.socialCore;
        const feedManager = req.app.locals.feedManager;
        
        const stats = {
            social: socialCore?.getStats() || {},
            feed: feedManager?.getStats() || {}
        };
        
        res.json({
            success: true,
            stats
        });
        
    } catch (error) {
        logger.error('Get stats error:', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

export default router;