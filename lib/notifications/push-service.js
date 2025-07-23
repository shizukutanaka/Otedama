/**
 * Push Notification Service for Otedama
 * Handles mobile app notifications across platforms
 * 
 * Design principles:
 * - Low-latency delivery (Carmack)
 * - Clean notification architecture (Martin)
 * - Simple integration (Pike)
 */

const webpush = require('web-push');
const admin = require('firebase-admin');
const { BaseService } = require('../common/base-service');

class PushNotificationService extends BaseService {
    constructor(config = {}) {
        super('PushNotificationService', {
            vapidPublicKey: config.vapidPublicKey || process.env.VAPID_PUBLIC_KEY,
            vapidPrivateKey: config.vapidPrivateKey || process.env.VAPID_PRIVATE_KEY,
            vapidEmail: config.vapidEmail || process.env.VAPID_EMAIL || 'mailto:notifications@otedama.com',
            firebaseConfig: config.firebaseConfig || process.env.FIREBASE_CONFIG,
            apnsConfig: config.apnsConfig,
            batchSize: config.batchSize || 1000,
            retryAttempts: config.retryAttempts || 3,
            ...config
        });
        
        // Notification queues
        this.queues = new Map();
        this.subscriptions = new Map();
        this.tokens = new Map();
        
        // Statistics (extending base metrics)
        this.notificationStats = {
            sent: 0,
            delivered: 0,
            failed: 0,
            clicked: 0
        };
    }
    
    /**
     * Initialize push notification services
     */
    async initializeServices() {
        try {
            // Initialize Web Push (PWA)
            if (this.config.vapidPublicKey && this.config.vapidPrivateKey) {
                webpush.setVapidDetails(
                    this.config.vapidEmail,
                    this.config.vapidPublicKey,
                    this.config.vapidPrivateKey
                );
                this.logger.info('Web Push initialized');
            }
            
            // Initialize Firebase (Android/iOS)
            if (this.config.firebaseConfig) {
                const serviceAccount = typeof this.config.firebaseConfig === 'string' 
                    ? JSON.parse(this.config.firebaseConfig)
                    : this.config.firebaseConfig;
                    
                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount)
                });
                
                this.fcm = admin.messaging();
                this.logger.info('Firebase Cloud Messaging initialized');
            }
            
            // Start notification processor
            this.startProcessor();
            
        } catch (error) {
            this.logger.error('Failed to initialize push services:', error);
        }
    }
    
    /**
     * Register device for push notifications
     */
    async registerDevice(userId, deviceInfo) {
        const { platform, token, subscription, deviceId } = deviceInfo;
        
        // Validate platform
        if (!['web', 'ios', 'android'].includes(platform)) {
            throw new Error('Invalid platform');
        }
        
        // Store device info
        const userDevices = this.tokens.get(userId) || new Map();
        
        userDevices.set(deviceId, {
            platform,
            token,
            subscription,
            registeredAt: Date.now(),
            lastActive: Date.now()
        });
        
        this.tokens.set(userId, userDevices);
        
        this.logger.info(`Device registered for user ${userId}:`, { platform, deviceId });
        
        // Send welcome notification
        await this.sendNotification(userId, {
            title: 'Welcome to Otedama',
            body: 'Notifications enabled successfully!',
            icon: '/icon-192.png',
            badge: '/badge-72.png'
        });
        
        return { success: true, deviceId };
    }
    
    /**
     * Unregister device
     */
    async unregisterDevice(userId, deviceId) {
        const userDevices = this.tokens.get(userId);
        if (!userDevices) return;
        
        userDevices.delete(deviceId);
        
        if (userDevices.size === 0) {
            this.tokens.delete(userId);
        }
        
        this.logger.info(`Device unregistered for user ${userId}:`, { deviceId });
        
        return { success: true };
    }
    
    /**
     * Send notification to user
     */
    async sendNotification(userId, notification, options = {}) {
        const userDevices = this.tokens.get(userId);
        if (!userDevices || userDevices.size === 0) {
            this.logger.debug(`No devices registered for user ${userId}`);
            return { success: false, reason: 'No registered devices' };
        }
        
        const notificationId = this.generateNotificationId();
        const enrichedNotification = {
            ...notification,
            id: notificationId,
            timestamp: Date.now(),
            data: {
                ...notification.data,
                notificationId,
                userId
            }
        };
        
        // Queue notifications for each device
        for (const [deviceId, device] of userDevices) {
            const queueKey = `${userId}:${deviceId}`;
            const queue = this.queues.get(queueKey) || [];
            
            queue.push({
                ...enrichedNotification,
                device,
                priority: options.priority || 'normal',
                ttl: options.ttl || 3600 // 1 hour default
            });
            
            this.queues.set(queueKey, queue);
        }
        
        // Process immediately if high priority
        if (options.priority === 'high') {
            await this.processQueues();
        }
        
        return { success: true, notificationId };
    }
    
    /**
     * Send bulk notifications
     */
    async sendBulkNotifications(notifications) {
        const results = [];
        
        // Process in batches
        for (let i = 0; i < notifications.length; i += this.config.batchSize) {
            const batch = notifications.slice(i, i + this.config.batchSize);
            
            const batchResults = await Promise.allSettled(
                batch.map(({ userId, notification, options }) => 
                    this.sendNotification(userId, notification, options)
                )
            );
            
            results.push(...batchResults);
        }
        
        return {
            total: notifications.length,
            successful: results.filter(r => r.status === 'fulfilled').length,
            failed: results.filter(r => r.status === 'rejected').length
        };
    }
    
    /**
     * Process notification queues
     */
    async processQueues() {
        for (const [queueKey, notifications] of this.queues) {
            if (notifications.length === 0) continue;
            
            // Process notifications for this device
            const toProcess = notifications.splice(0, 10); // Process up to 10 at a time
            
            for (const notification of toProcess) {
                try {
                    await this.deliverNotification(notification);
                    this.notificationStats.sent++;
                } catch (error) {
                    this.logger.error('Notification delivery failed:', error);
                    this.notificationStats.failed++;
                    
                    // Retry logic
                    if (notification.retryCount < this.config.retryAttempts) {
                        notification.retryCount = (notification.retryCount || 0) + 1;
                        notifications.push(notification); // Re-queue
                    }
                }
            }
            
            // Update queue
            if (notifications.length === 0) {
                this.queues.delete(queueKey);
            } else {
                this.queues.set(queueKey, notifications);
            }
        }
    }
    
    /**
     * Deliver notification to device
     */
    async deliverNotification(notification) {
        const { device, ...payload } = notification;
        
        switch (device.platform) {
            case 'web':
                await this.sendWebPush(device.subscription, payload);
                break;
                
            case 'android':
            case 'ios':
                await this.sendFCM(device.token, payload);
                break;
                
            default:
                throw new Error(`Unsupported platform: ${device.platform}`);
        }
        
        this.emit('notification:sent', {
            platform: device.platform,
            notificationId: payload.id,
            userId: payload.data.userId
        });
    }
    
    /**
     * Send Web Push notification
     */
    async sendWebPush(subscription, payload) {
        const options = {
            TTL: payload.ttl,
            urgency: payload.priority === 'high' ? 'high' : 'normal'
        };
        
        const notificationPayload = JSON.stringify({
            title: payload.title,
            body: payload.body,
            icon: payload.icon || '/icon-192.png',
            badge: payload.badge || '/badge-72.png',
            tag: payload.tag || payload.id,
            data: payload.data,
            actions: payload.actions,
            requireInteraction: payload.requireInteraction || false,
            silent: payload.silent || false,
            timestamp: payload.timestamp
        });
        
        await webpush.sendNotification(subscription, notificationPayload, options);
    }
    
    /**
     * Send FCM notification
     */
    async sendFCM(token, payload) {
        if (!this.fcm) {
            throw new Error('Firebase not initialized');
        }
        
        const message = {
            token,
            notification: {
                title: payload.title,
                body: payload.body
            },
            data: this.stringifyData(payload.data),
            android: {
                priority: payload.priority === 'high' ? 'high' : 'normal',
                ttl: payload.ttl * 1000, // Convert to milliseconds
                notification: {
                    icon: 'ic_notification',
                    color: '#00d4ff',
                    sound: 'default',
                    clickAction: payload.clickAction || 'OPEN_APP'
                }
            },
            apns: {
                payload: {
                    aps: {
                        alert: {
                            title: payload.title,
                            body: payload.body
                        },
                        badge: payload.badge,
                        sound: 'default',
                        contentAvailable: true
                    }
                }
            }
        };
        
        await this.fcm.send(message);
    }
    
    /**
     * Create notification templates
     */
    createNotificationTemplates() {
        return {
            // Price alerts
            priceAlert: (pair, price, direction) => ({
                title: `${pair} Price Alert`,
                body: `${pair} has ${direction === 'up' ? 'risen above' : 'fallen below'} ${price}`,
                icon: '/icons/price-alert.png',
                data: { type: 'price_alert', pair, price, direction },
                priority: 'high'
            }),
            
            // Trading notifications
            orderFilled: (order) => ({
                title: 'Order Filled',
                body: `Your ${order.side} order for ${order.quantity} ${order.pair} has been filled at ${order.price}`,
                icon: '/icons/order-filled.png',
                data: { type: 'order_filled', orderId: order.id },
                actions: [
                    { action: 'view', title: 'View Order' },
                    { action: 'trade', title: 'Trade More' }
                ]
            }),
            
            // Mining notifications
            blockFound: (reward) => ({
                title: 'Block Found! 🎉',
                body: `Your mining pool found a block! Your reward: ${reward} BTC`,
                icon: '/icons/block-found.png',
                data: { type: 'block_found', reward },
                priority: 'high',
                requireInteraction: true
            }),
            
            // Bot notifications
            botAlert: (bot, message) => ({
                title: `Bot Alert: ${bot.name}`,
                body: message,
                icon: '/icons/bot-alert.png',
                data: { type: 'bot_alert', botId: bot.id },
                actions: [
                    { action: 'stop', title: 'Stop Bot' },
                    { action: 'view', title: 'View Details' }
                ]
            }),
            
            // Security notifications
            newLogin: (location, device) => ({
                title: 'New Login Detected',
                body: `Login from ${device} in ${location}`,
                icon: '/icons/security.png',
                data: { type: 'security_alert', location, device },
                priority: 'high',
                requireInteraction: true,
                actions: [
                    { action: 'approve', title: 'Yes, it was me' },
                    { action: 'deny', title: 'No, secure account' }
                ]
            }),
            
            // DeFi notifications
            liquidationWarning: (position, healthFactor) => ({
                title: 'Liquidation Warning',
                body: `Your ${position.asset} position health factor: ${healthFactor.toFixed(2)}`,
                icon: '/icons/warning.png',
                data: { type: 'liquidation_warning', positionId: position.id },
                priority: 'high',
                requireInteraction: true,
                actions: [
                    { action: 'add_collateral', title: 'Add Collateral' },
                    { action: 'repay', title: 'Repay Loan' }
                ]
            })
        };
    }
    
    /**
     * Subscribe to system events
     */
    subscribeToSystemEvents(services) {
        // Price alerts
        if (services.priceMonitor) {
            services.priceMonitor.on('alert:triggered', async (alert) => {
                const template = this.createNotificationTemplates().priceAlert(
                    alert.pair,
                    alert.price,
                    alert.direction
                );
                await this.sendNotification(alert.userId, template, { priority: 'high' });
            });
        }
        
        // Trading events
        if (services.dexEngine) {
            services.dexEngine.on('order:filled', async (order) => {
                const template = this.createNotificationTemplates().orderFilled(order);
                await this.sendNotification(order.userId, template);
            });
        }
        
        // Mining events
        if (services.miningPool) {
            services.miningPool.on('block:found', async (block) => {
                // Notify all active miners
                const miners = services.miningPool.getActiveMiners();
                const notifications = miners.map(miner => ({
                    userId: miner.userId,
                    notification: this.createNotificationTemplates().blockFound(miner.estimatedReward)
                }));
                await this.sendBulkNotifications(notifications);
            });
        }
        
        // Bot events
        if (services.botEngine) {
            services.botEngine.on('bot:alert', async (event) => {
                const template = this.createNotificationTemplates().botAlert(event.bot, event.message);
                await this.sendNotification(event.bot.userId, template);
            });
        }
        
        // Security events
        if (services.authManager) {
            services.authManager.on('login:new', async (event) => {
                const template = this.createNotificationTemplates().newLogin(event.location, event.device);
                await this.sendNotification(event.userId, template, { priority: 'high' });
            });
        }
    }
    
    /**
     * Handle notification interactions
     */
    async handleInteraction(userId, notificationId, action) {
        this.logger.info('Notification interaction:', { userId, notificationId, action });
        
        this.notificationStats.clicked++;
        
        this.emit('notification:interaction', {
            userId,
            notificationId,
            action,
            timestamp: Date.now()
        });
        
        // Return action-specific response
        switch (action) {
            case 'view':
                return { redirect: `/app/notifications/${notificationId}` };
                
            case 'trade':
                return { redirect: '/app/trading' };
                
            case 'stop':
                // Execute bot stop action
                return { action: 'stop_bot', success: true };
                
            case 'approve':
                // Approve login
                return { action: 'approve_login', success: true };
                
            case 'deny':
                // Trigger security lockdown
                return { action: 'security_lockdown', success: true };
                
            default:
                return { success: true };
        }
    }
    
    /**
     * Get user notification preferences
     */
    async getUserPreferences(userId) {
        // This would typically fetch from database
        return {
            priceAlerts: true,
            orderUpdates: true,
            miningEvents: true,
            botAlerts: true,
            securityAlerts: true,
            marketingUpdates: false,
            quietHours: {
                enabled: true,
                start: '22:00',
                end: '08:00'
            }
        };
    }
    
    /**
     * Update user preferences
     */
    async updateUserPreferences(userId, preferences) {
        // This would typically save to database
        this.logger.info(`Updated notification preferences for user ${userId}`);
        return { success: true, preferences };
    }
    
    /**
     * Utility methods
     */
    
    generateNotificationId() {
        return `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    stringifyData(data) {
        const result = {};
        for (const [key, value] of Object.entries(data)) {
            result[key] = typeof value === 'string' ? value : JSON.stringify(value);
        }
        return result;
    }
    
    /**
     * Start notification processor
     */
    startProcessor() {
        setInterval(() => {
            this.processQueues();
        }, 5000); // Process every 5 seconds
        
        this.logger.info('Push notification processor started');
    }
    
    /**
     * Get service statistics
     */
    async getStats() {
        const baseStats = await super.getStats();
        
        return {
            ...baseStats,
            notifications: {
                ...this.notificationStats,
                registeredUsers: this.tokens.size,
                totalDevices: Array.from(this.tokens.values()).reduce((sum, devices) => sum + devices.size, 0),
                queuedNotifications: Array.from(this.queues.values()).reduce((sum, queue) => sum + queue.length, 0)
            }
        };
    }
    
    /**
     * Cleanup on shutdown
     */
    async onShutdown() {
        // Process remaining notifications
        await this.processQueues();
        
        // Clear queues
        this.queues.clear();
        this.subscriptions.clear();
    }
}

module.exports = PushNotificationService;