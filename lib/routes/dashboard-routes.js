/**
 * Dashboard API Routes
 * 
 * Handles dashboard-specific endpoints
 * Following clean code principles
 */

import express from 'express';
import { RealtimeDashboard, createDashboardRoute } from '../dashboard/realtime-dashboard.js';
import { AdminMiddleware } from '../auth/admin-middleware.js';

export function createDashboardRoutes(options = {}) {
    const router = express.Router();
    const { dashboard, adminMiddleware } = options;
    
    // Apply admin middleware to all dashboard routes
    if (adminMiddleware) {
        router.use(adminMiddleware.middleware());
    } else {
        // Create default admin middleware with IP-based access
        const defaultAdminMiddleware = new AdminMiddleware({
            requireIPWhitelist: true,
            allowedAdminIPs: process.env.ADMIN_ALLOWED_IPS?.split(',') || ['127.0.0.1', '::1']
        });
        router.use(defaultAdminMiddleware.middleware());
    }
    
    /**
     * Get current dashboard metrics
     */
    router.get('/metrics', createDashboardRoute(dashboard));
    
    /**
     * Subscribe to real-time updates (WebSocket upgrade)
     */
    router.get('/subscribe', (req, res) => {
        res.json({
            message: 'Use WebSocket connection to /ws for real-time updates',
            wsUrl: `ws://${req.headers.host}/ws`,
            channels: ['system', 'mining', 'trading', 'financial', 'alerts']
        });
    });
    
    /**
     * Get specific metric channel
     */
    router.get('/metrics/:channel', (req, res) => {
        const { channel } = req.params;
        const validChannels = ['system', 'mining', 'trading', 'financial', 'alerts'];
        
        if (!validChannels.includes(channel)) {
            return res.status(400).json({ 
                error: 'Invalid channel',
                validChannels 
            });
        }
        
        const metrics = dashboard.getCurrentMetrics([channel]);
        res.json({
            timestamp: Date.now(),
            channel,
            data: metrics[channel] || {}
        });
    });
    
    /**
     * Get dashboard alerts
     */
    router.get('/alerts', (req, res) => {
        const { level, limit = 50 } = req.query;
        let alerts = dashboard.metrics.alerts.slice(0, parseInt(limit));
        
        if (level) {
            alerts = alerts.filter(alert => alert.level === level);
        }
        
        res.json({
            alerts,
            count: alerts.length,
            timestamp: Date.now()
        });
    });
    
    /**
     * Create manual alert
     */
    router.post('/alerts', (req, res) => {
        const { level, message, details } = req.body;
        
        if (!level || !message) {
            return res.status(400).json({ 
                error: 'Missing required fields: level, message' 
            });
        }
        
        const validLevels = ['info', 'warning', 'error', 'critical'];
        if (!validLevels.includes(level)) {
            return res.status(400).json({ 
                error: 'Invalid alert level',
                validLevels 
            });
        }
        
        const alert = dashboard.addAlert(level, message, {
            ...details,
            source: 'manual',
            user: req.user?.username || 'admin'
        });
        
        res.json({
            success: true,
            alert,
            timestamp: Date.now()
        });
    });
    
    /**
     * Get system performance history
     */
    router.get('/history/:metric', async (req, res) => {
        const { metric } = req.params;
        const { duration = '1h', interval = '1m' } = req.query;
        
        try {
            // This would fetch historical data from the database
            const history = await dashboard.db.query(
                `SELECT metric_value, created_at 
                 FROM system_metrics 
                 WHERE metric_name = ? 
                 AND created_at > datetime('now', '-${duration}')
                 ORDER BY created_at DESC`,
                [metric]
            );
            
            res.json({
                metric,
                duration,
                interval,
                data: history.map(row => ({
                    value: row.metric_value,
                    timestamp: new Date(row.created_at).getTime()
                })),
                timestamp: Date.now()
            });
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch history' });
        }
    });
    
    /**
     * Export dashboard data
     */
    router.get('/export', async (req, res) => {
        const { format = 'json', channels = 'all' } = req.query;
        const channelList = channels === 'all' ? ['all'] : channels.split(',');
        
        const data = dashboard.getCurrentMetrics(channelList);
        
        if (format === 'csv') {
            // Convert to CSV format
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="dashboard-export.csv"');
            
            // Simple CSV conversion
            const csv = [];
            csv.push('Channel,Metric,Value,Timestamp');
            
            for (const [channel, metrics] of Object.entries(data)) {
                for (const [key, value] of Object.entries(metrics)) {
                    if (typeof value === 'object') {
                        csv.push(`${channel},${key},"${JSON.stringify(value)}",${Date.now()}`);
                    } else {
                        csv.push(`${channel},${key},${value},${Date.now()}`);
                    }
                }
            }
            
            res.end(csv.join('\n'));
        } else {
            // Default JSON format
            res.json({
                export: {
                    format,
                    channels: channelList,
                    timestamp: Date.now()
                },
                data
            });
        }
    });
    
    /**
     * Dashboard configuration
     */
    router.get('/config', (req, res) => {
        res.json({
            intervals: dashboard.intervals,
            features: {
                realtime: true,
                alerts: true,
                export: true,
                history: true
            },
            wsEndpoint: '/ws',
            refreshRates: {
                system: 5000,
                mining: 10000,
                trading: 2000,
                financial: 30000
            },
            timestamp: Date.now()
        });
    });
    
    return router;
}

/**
 * WebSocket handler for dashboard
 */
export function createDashboardWebSocketHandler(dashboard) {
    return (ws, req) => {
        const clientId = req.headers['x-client-id'] || Date.now().toString();
        
        console.log(`Dashboard client connected: ${clientId}`);
        
        // Send initial data
        ws.send(JSON.stringify({
            type: 'dashboard:welcome',
            clientId,
            metrics: dashboard.getCurrentMetrics(['all']),
            timestamp: Date.now()
        }));
        
        // Handle messages
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                switch (data.type) {
                    case 'dashboard:subscribe':
                        dashboard.wsManager?.sendToConnection(
                            { id: clientId, ws },
                            {
                                type: 'dashboard:subscribed',
                                channels: data.channels || ['all']
                            }
                        );
                        break;
                        
                    case 'dashboard:unsubscribe':
                        // Handle unsubscribe
                        break;
                        
                    case 'ping':
                        ws.send(JSON.stringify({ type: 'pong' }));
                        break;
                }
            } catch (error) {
                ws.send(JSON.stringify({
                    type: 'error',
                    error: 'Invalid message format'
                }));
            }
        });
        
        // Handle disconnect
        ws.on('close', () => {
            console.log(`Dashboard client disconnected: ${clientId}`);
        });
    };
}

export default createDashboardRoutes;