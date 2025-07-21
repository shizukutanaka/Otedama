/**
 * Trading Bot API Endpoints for Otedama
 * Provides bot management and control APIs
 * 
 * Design principles:
 * - Fast bot operations (Carmack)
 * - Clean API design (Martin)
 * - Simple bot management (Pike)
 */

import { Router } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { authenticateToken } from '../auth/middleware.js';
import { logger } from '../core/logger.js';

const router = Router();

/**
 * Get available strategies
 * GET /api/bots/strategies
 */
router.get('/strategies', authenticateToken, async (req, res) => {
    try {
        const botEngine = req.app.locals.botEngine;
        if (!botEngine) {
            return res.status(503).json({ error: 'Bot service not available' });
        }
        
        const strategies = Array.from(botEngine.strategies.entries()).map(([id, strategy]) => ({
            id,
            name: strategy.name,
            description: strategy.description,
            parameters: strategy.parameters
        }));
        
        res.json({
            success: true,
            strategies
        });
        
    } catch (error) {
        logger.error('Get strategies error:', error);
        res.status(500).json({ error: 'Failed to get strategies' });
    }
});

/**
 * Create a new bot
 * POST /api/bots
 */
router.post('/', 
    authenticateToken,
    [
        body('name').optional().isString().isLength({ max: 100 }),
        body('strategy').notEmpty().isString(),
        body('pair').notEmpty().matches(/^[A-Z]+\/[A-Z]+$/),
        body('capital').isFloat({ min: 10, max: 1000000 }),
        body('parameters').isObject()
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const botEngine = req.app.locals.botEngine;
            if (!botEngine) {
                return res.status(503).json({ error: 'Bot service not available' });
            }
            
            const bot = await botEngine.createBot(req.user.id, req.body);
            
            res.status(201).json({
                success: true,
                bot: {
                    id: bot.id,
                    name: bot.name,
                    strategy: bot.strategy,
                    pair: bot.pair,
                    capital: bot.capital,
                    status: bot.status,
                    createdAt: bot.createdAt
                }
            });
            
        } catch (error) {
            logger.error('Create bot error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Get user's bots
 * GET /api/bots
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const botEngine = req.app.locals.botEngine;
        if (!botEngine) {
            return res.status(503).json({ error: 'Bot service not available' });
        }
        
        const bots = botEngine.getUserBots(req.user.id);
        
        res.json({
            success: true,
            bots,
            count: bots.length,
            maxAllowed: botEngine.config.maxBotsPerUser
        });
        
    } catch (error) {
        logger.error('Get bots error:', error);
        res.status(500).json({ error: 'Failed to get bots' });
    }
});

/**
 * Get specific bot details
 * GET /api/bots/:botId
 */
router.get('/:botId', 
    authenticateToken,
    param('botId').isUUID(),
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const botEngine = req.app.locals.botEngine;
            if (!botEngine) {
                return res.status(503).json({ error: 'Bot service not available' });
            }
            
            const bot = botEngine.bots.get(req.params.botId);
            if (!bot) {
                return res.status(404).json({ error: 'Bot not found' });
            }
            
            if (bot.userId !== req.user.id) {
                return res.status(403).json({ error: 'Unauthorized' });
            }
            
            res.json({
                success: true,
                bot: {
                    ...bot,
                    performance: botEngine.getBotPerformance(bot.id),
                    activeOrders: Array.from(bot.orders.values()).filter(o => o.status === 'pending').length,
                    positions: Array.from(bot.positions.entries())
                }
            });
            
        } catch (error) {
            logger.error('Get bot details error:', error);
            res.status(500).json({ error: 'Failed to get bot details' });
        }
    }
);

/**
 * Start a bot
 * POST /api/bots/:botId/start
 */
router.post('/:botId/start',
    authenticateToken,
    param('botId').isUUID(),
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const botEngine = req.app.locals.botEngine;
            if (!botEngine) {
                return res.status(503).json({ error: 'Bot service not available' });
            }
            
            const bot = await botEngine.startBot(req.params.botId, req.user.id);
            
            res.json({
                success: true,
                message: 'Bot started successfully',
                bot: {
                    id: bot.id,
                    status: bot.status,
                    startedAt: bot.startedAt
                }
            });
            
        } catch (error) {
            logger.error('Start bot error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Stop a bot
 * POST /api/bots/:botId/stop
 */
router.post('/:botId/stop',
    authenticateToken,
    param('botId').isUUID(),
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const botEngine = req.app.locals.botEngine;
            if (!botEngine) {
                return res.status(503).json({ error: 'Bot service not available' });
            }
            
            const bot = await botEngine.stopBot(req.params.botId, req.user.id);
            
            res.json({
                success: true,
                message: 'Bot stopped successfully',
                bot: {
                    id: bot.id,
                    status: bot.status,
                    performance: botEngine.getBotPerformance(bot.id)
                }
            });
            
        } catch (error) {
            logger.error('Stop bot error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Update bot parameters
 * PUT /api/bots/:botId
 */
router.put('/:botId',
    authenticateToken,
    [
        param('botId').isUUID(),
        body('parameters').optional().isObject(),
        body('capital').optional().isFloat({ min: 10, max: 1000000 })
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const botEngine = req.app.locals.botEngine;
            if (!botEngine) {
                return res.status(503).json({ error: 'Bot service not available' });
            }
            
            const bot = botEngine.bots.get(req.params.botId);
            if (!bot) {
                return res.status(404).json({ error: 'Bot not found' });
            }
            
            if (bot.userId !== req.user.id) {
                return res.status(403).json({ error: 'Unauthorized' });
            }
            
            if (bot.status === 'active') {
                return res.status(400).json({ error: 'Cannot update active bot' });
            }
            
            // Update parameters
            if (req.body.parameters) {
                const strategy = botEngine.strategies.get(bot.strategy);
                bot.parameters = botEngine.validateParameters(strategy.parameters, req.body.parameters);
            }
            
            if (req.body.capital !== undefined) {
                bot.capital = req.body.capital;
            }
            
            res.json({
                success: true,
                message: 'Bot updated successfully',
                bot: {
                    id: bot.id,
                    parameters: bot.parameters,
                    capital: bot.capital
                }
            });
            
        } catch (error) {
            logger.error('Update bot error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Delete a bot
 * DELETE /api/bots/:botId
 */
router.delete('/:botId',
    authenticateToken,
    param('botId').isUUID(),
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const botEngine = req.app.locals.botEngine;
            if (!botEngine) {
                return res.status(503).json({ error: 'Bot service not available' });
            }
            
            await botEngine.deleteBot(req.params.botId, req.user.id);
            
            res.json({
                success: true,
                message: 'Bot deleted successfully'
            });
            
        } catch (error) {
            logger.error('Delete bot error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Get bot performance history
 * GET /api/bots/:botId/performance
 */
router.get('/:botId/performance',
    authenticateToken,
    [
        param('botId').isUUID(),
        query('period').optional().isIn(['1h', '24h', '7d', '30d', 'all'])
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const botEngine = req.app.locals.botEngine;
            if (!botEngine) {
                return res.status(503).json({ error: 'Bot service not available' });
            }
            
            const bot = botEngine.bots.get(req.params.botId);
            if (!bot) {
                return res.status(404).json({ error: 'Bot not found' });
            }
            
            if (bot.userId !== req.user.id) {
                return res.status(403).json({ error: 'Unauthorized' });
            }
            
            // Get performance metrics
            const performance = botEngine.getBotPerformance(bot.id);
            
            // Get trade history (would be stored in database)
            const trades = []; // This would fetch from database
            
            res.json({
                success: true,
                performance,
                trades,
                period: req.query.period || 'all'
            });
            
        } catch (error) {
            logger.error('Get performance error:', error);
            res.status(500).json({ error: 'Failed to get performance data' });
        }
    }
);

/**
 * Get bot orders
 * GET /api/bots/:botId/orders
 */
router.get('/:botId/orders',
    authenticateToken,
    [
        param('botId').isUUID(),
        query('status').optional().isIn(['pending', 'filled', 'cancelled', 'all'])
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const botEngine = req.app.locals.botEngine;
            if (!botEngine) {
                return res.status(503).json({ error: 'Bot service not available' });
            }
            
            const bot = botEngine.bots.get(req.params.botId);
            if (!bot) {
                return res.status(404).json({ error: 'Bot not found' });
            }
            
            if (bot.userId !== req.user.id) {
                return res.status(403).json({ error: 'Unauthorized' });
            }
            
            let orders = Array.from(bot.orders.values());
            
            // Filter by status
            if (req.query.status && req.query.status !== 'all') {
                orders = orders.filter(o => o.status === req.query.status);
            }
            
            // Sort by creation time
            orders.sort((a, b) => b.createdAt - a.createdAt);
            
            res.json({
                success: true,
                orders,
                count: orders.length
            });
            
        } catch (error) {
            logger.error('Get bot orders error:', error);
            res.status(500).json({ error: 'Failed to get orders' });
        }
    }
);

/**
 * WebSocket endpoint for real-time bot updates
 * This would be handled by WebSocket server
 */
router.post('/subscribe',
    authenticateToken,
    body('botIds').isArray().optional(),
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const subscriptionId = `bot_${req.user.id}_${Date.now()}`;
            
            res.json({
                success: true,
                subscriptionId,
                websocket: {
                    url: `ws://${req.headers.host}/ws/bots`,
                    protocol: 'bot-updates-v1'
                }
            });
            
        } catch (error) {
            logger.error('Subscribe error:', error);
            res.status(500).json({ error: 'Failed to create subscription' });
        }
    }
);

export default router;