/**
 * Push Notification Integration for Otedama
 * Handles push service initialization and integration
 * 
 * Design principles:
 * - Clean initialization (Martin)
 * - Fast notification delivery (Carmack)
 * - Simple integration (Pike)
 */

import PushNotificationService from '../notifications/push-service.js';
import { logger } from './logger.js';

export async function initializePushNotifications(app, services = {}) {
    try {
        logger.info('Initializing push notification service...');
        
        // Create push notification service
        const pushService = new PushNotificationService({
            vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
            vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
            vapidEmail: process.env.VAPID_EMAIL,
            firebaseConfig: process.env.FIREBASE_CONFIG,
            batchSize: 1000,
            retryAttempts: 3
        });
        
        // Subscribe to system events
        pushService.subscribeToSystemEvents({
            priceMonitor: services.priceMonitor,
            dexEngine: services.dexEngine,
            miningPool: services.miningPool,
            botEngine: services.botEngine,
            authManager: services.authManager
        });
        
        // Store in app locals for API endpoints
        app.locals.pushService = pushService;
        
        // Setup notification API routes
        const notificationRoutes = await import('../api/notification-endpoints.js');
        app.use('/api/notifications', notificationRoutes.default);
        
        logger.info('Push notification service initialized successfully');
        
        return pushService;
        
    } catch (error) {
        logger.error('Failed to initialize push notifications:', error);
        // Push notifications are optional, don't fail startup
        return null;
    }
}

export function setupPushNotificationHandlers(server, pushService) {
    if (!pushService) return;
    
    // Handle server shutdown
    server.on('close', () => {
        logger.info('Shutting down push notification service...');
        // Any cleanup needed
    });
}