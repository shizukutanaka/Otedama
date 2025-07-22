/**
 * Push Notification API Endpoints for Otedama
 * Manages device registration and notification preferences
 * 
 * Design principles:
 * - Fast notification delivery (Carmack)
 * - Clean API structure (Martin)
 * - Simple device management (Pike)
 */

import { Router } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { authenticateToken } from '../auth/middleware.js';
import { getLogger } from '../core/logger.js';

const logger = getLogger('NotificationEndpoints');

const router = Router();

/**
 * Register device for push notifications
 * POST /api/notifications/register
 */
router.post('/register',
    authenticateToken,
    [
        body('platform').isIn(['web', 'ios', 'android']),
        body('token').optional().isString(),
        body('subscription').optional().isObject(),
        body('deviceId').isString().isLength({ min: 10, max: 255 })
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const pushService = req.app.locals.pushService;
            if (!pushService) {
                return res.status(503).json({ error: 'Push notification service not available' });
            }
            
            const result = await pushService.registerDevice(req.user.id, {
                platform: req.body.platform,
                token: req.body.token,
                subscription: req.body.subscription,
                deviceId: req.body.deviceId
            });
            
            res.json(result);
            
        } catch (error) {
            logger.error('Device registration error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Unregister device
 * DELETE /api/notifications/device/:deviceId
 */
router.delete('/device/:deviceId',
    authenticateToken,
    param('deviceId').isString(),
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const pushService = req.app.locals.pushService;
            if (!pushService) {
                return res.status(503).json({ error: 'Push notification service not available' });
            }
            
            const result = await pushService.unregisterDevice(req.user.id, req.params.deviceId);
            res.json(result);
            
        } catch (error) {
            logger.error('Device unregistration error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Get user notification preferences
 * GET /api/notifications/preferences
 */
router.get('/preferences', authenticateToken, async (req, res) => {
    try {
        const pushService = req.app.locals.pushService;
        if (!pushService) {
            return res.status(503).json({ error: 'Push notification service not available' });
        }
        
        const preferences = await pushService.getUserPreferences(req.user.id);
        res.json({
            success: true,
            preferences
        });
        
    } catch (error) {
        logger.error('Get preferences error:', error);
        res.status(500).json({ error: 'Failed to get preferences' });
    }
});

/**
 * Update notification preferences
 * PUT /api/notifications/preferences
 */
router.put('/preferences',
    authenticateToken,
    [
        body('priceAlerts').optional().isBoolean(),
        body('orderUpdates').optional().isBoolean(),
        body('miningEvents').optional().isBoolean(),
        body('botAlerts').optional().isBoolean(),
        body('securityAlerts').optional().isBoolean(),
        body('marketingUpdates').optional().isBoolean(),
        body('quietHours').optional().isObject(),
        body('quietHours.enabled').optional().isBoolean(),
        body('quietHours.start').optional().matches(/^([01]\d|2[0-3]):[0-5]\d$/),
        body('quietHours.end').optional().matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const pushService = req.app.locals.pushService;
            if (!pushService) {
                return res.status(503).json({ error: 'Push notification service not available' });
            }
            
            const result = await pushService.updateUserPreferences(req.user.id, req.body);
            res.json(result);
            
        } catch (error) {
            logger.error('Update preferences error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Send test notification
 * POST /api/notifications/test
 */
router.post('/test',
    authenticateToken,
    async (req, res) => {
        try {
            const pushService = req.app.locals.pushService;
            if (!pushService) {
                return res.status(503).json({ error: 'Push notification service not available' });
            }
            
            const result = await pushService.sendNotification(req.user.id, {
                title: 'Test Notification',
                body: 'This is a test notification from Otedama.',
                icon: '/icon-192.png',
                badge: '/badge-72.png',
                data: {
                    type: 'test',
                    timestamp: Date.now()
                }
            }, { priority: 'high' });
            
            res.json({
                success: true,
                message: 'Test notification sent',
                ...result
            });
            
        } catch (error) {
            logger.error('Send test notification error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Handle notification interaction
 * POST /api/notifications/interaction
 */
router.post('/interaction',
    authenticateToken,
    [
        body('notificationId').isString(),
        body('action').isString()
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const pushService = req.app.locals.pushService;
            if (!pushService) {
                return res.status(503).json({ error: 'Push notification service not available' });
            }
            
            const result = await pushService.handleInteraction(
                req.user.id,
                req.body.notificationId,
                req.body.action
            );
            
            res.json(result);
            
        } catch (error) {
            logger.error('Handle interaction error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Get notification statistics
 * GET /api/notifications/stats
 */
router.get('/stats', authenticateToken, async (req, res) => {
    try {
        const pushService = req.app.locals.pushService;
        if (!pushService) {
            return res.status(503).json({ error: 'Push notification service not available' });
        }
        
        const stats = pushService.getStats();
        res.json({
            success: true,
            stats
        });
        
    } catch (error) {
        logger.error('Get stats error:', error);
        res.status(500).json({ error: 'Failed to get statistics' });
    }
});

/**
 * Admin: Send bulk notifications
 * POST /api/notifications/admin/bulk
 */
router.post('/admin/bulk',
    authenticateToken,
    [
        body('userIds').optional().isArray(),
        body('filter').optional().isObject(),
        body('notification').isObject(),
        body('notification.title').notEmpty(),
        body('notification.body').notEmpty()
    ],
    async (req, res) => {
        try {
            // Check admin permission
            if (!req.user.roles?.includes('admin')) {
                return res.status(403).json({ error: 'Admin access required' });
            }
            
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }
            
            const pushService = req.app.locals.pushService;
            if (!pushService) {
                return res.status(503).json({ error: 'Push notification service not available' });
            }
            
            // Get target users
            let userIds = req.body.userIds || [];
            
            if (req.body.filter) {
                // This would query database based on filter criteria
                // For now, just use provided userIds
            }
            
            // Create notification batch
            const notifications = userIds.map(userId => ({
                userId,
                notification: req.body.notification,
                options: { priority: req.body.priority || 'normal' }
            }));
            
            const result = await pushService.sendBulkNotifications(notifications);
            
            res.json({
                success: true,
                ...result
            });
            
        } catch (error) {
            logger.error('Send bulk notifications error:', error);
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Get VAPID public key for Web Push
 * GET /api/notifications/vapid-key
 */
router.get('/vapid-key', async (req, res) => {
    try {
        const pushService = req.app.locals.pushService;
        if (!pushService) {
            return res.status(503).json({ error: 'Push notification service not available' });
        }
        
        res.json({
            success: true,
            publicKey: pushService.config.vapidPublicKey
        });
        
    } catch (error) {
        logger.error('Get VAPID key error:', error);
        res.status(500).json({ error: 'Failed to get VAPID key' });
    }
});

export default router;