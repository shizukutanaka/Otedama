/**
 * Real-time Dashboard Manager
 * 
 * Provides real-time statistics and monitoring
 * Following performance-first principles
 */

import { EventEmitter } from 'events';
import { DatabaseManager } from '../core/database-manager.js';
import { CacheManager } from '../core/cache-manager.js';
import { WebSocketManager } from '../core/websocket-manager.js';

export class RealtimeDashboard extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.db = options.db || new DatabaseManager();
        this.cache = options.cache || new CacheManager();
        this.wsManager = options.wsManager;
        
        // Update intervals
        this.intervals = {
            system: 5000,      // 5 seconds
            mining: 10000,     // 10 seconds
            trading: 2000,     // 2 seconds
            financial: 30000   // 30 seconds
        };
        
        // Metric storage
        this.metrics = {
            system: {},
            mining: {},
            trading: {},
            financial: {},
            alerts: []
        };
        
        // Update timers
        this.timers = {};
        
        // Subscribers
        this.subscribers = new Set();
    }
    
    /**
     * Start dashboard updates
     */
    start() {
        console.log('Starting real-time dashboard...');
        
        // Start update loops
        this.startSystemMetrics();
        this.startMiningMetrics();
        this.startTradingMetrics();
        this.startFinancialMetrics();
        
        // Setup WebSocket handlers if available
        if (this.wsManager) {
            this.setupWebSocketHandlers();
        }
        
        this.emit('started');
    }
    
    /**
     * Stop dashboard updates
     */
    stop() {
        // Clear all timers
        Object.values(this.timers).forEach(timer => clearInterval(timer));
        this.timers = {};
        
        this.emit('stopped');
    }
    
    /**
     * Start system metrics collection
     */
    startSystemMetrics() {
        const update = async () => {
            try {
                const metrics = {
                    timestamp: Date.now(),
                    
                    // Process metrics
                    cpu: process.cpuUsage(),
                    memory: process.memoryUsage(),
                    uptime: process.uptime(),
                    
                    // Connection metrics
                    activeConnections: await this.getActiveConnections(),
                    wsConnections: this.wsManager?.connections.size || 0,
                    
                    // Database metrics
                    dbPoolSize: await this.getDbPoolSize(),
                    dbActiveQueries: await this.getActiveQueries(),
                    
                    // Cache metrics
                    cacheHitRate: await this.cache.getHitRate(),
                    cacheSize: await this.cache.getSize(),
                    
                    // System load
                    loadAverage: this.getLoadAverage()
                };
                
                this.metrics.system = metrics;
                this.broadcast('system', metrics);
                
            } catch (error) {
                console.error('System metrics error:', error);
            }
        };
        
        update(); // Initial update
        this.timers.system = setInterval(update, this.intervals.system);
    }
    
    /**
     * Start mining metrics collection
     */
    startMiningMetrics() {
        const update = async () => {
            try {
                const metrics = await this.db.query(`
                    SELECT 
                        COUNT(DISTINCT miner_id) as active_miners,
                        COUNT(DISTINCT worker_id) as active_workers,
                        SUM(hashrate) as total_hashrate,
                        COUNT(CASE WHEN created_at > datetime('now', '-1 hour') THEN 1 END) as shares_last_hour,
                        COUNT(CASE WHEN created_at > datetime('now', '-1 hour') AND valid = 1 THEN 1 END) as valid_shares_last_hour,
                        AVG(CASE WHEN created_at > datetime('now', '-5 minutes') THEN difficulty END) as avg_difficulty,
                        MAX(CASE WHEN found_block = 1 THEN created_at END) as last_block_time
                    FROM (
                        SELECT * FROM shares 
                        WHERE created_at > datetime('now', '-1 hour')
                    )
                `);
                
                const poolStats = metrics[0] || {};
                
                // Calculate additional metrics
                const shareRate = poolStats.shares_last_hour / 3600; // per second
                const efficiency = poolStats.shares_last_hour > 0 
                    ? poolStats.valid_shares_last_hour / poolStats.shares_last_hour 
                    : 1;
                
                const miningMetrics = {
                    timestamp: Date.now(),
                    miners: {
                        active: poolStats.active_miners || 0,
                        total: await this.getTotalMiners()
                    },
                    workers: {
                        active: poolStats.active_workers || 0,
                        total: await this.getTotalWorkers()
                    },
                    hashrate: {
                        current: poolStats.total_hashrate || 0,
                        average: await this.getAverageHashrate(),
                        unit: 'H/s'
                    },
                    shares: {
                        rate: shareRate,
                        valid: poolStats.valid_shares_last_hour || 0,
                        invalid: (poolStats.shares_last_hour || 0) - (poolStats.valid_shares_last_hour || 0),
                        efficiency: efficiency
                    },
                    difficulty: poolStats.avg_difficulty || 0,
                    lastBlock: poolStats.last_block_time ? 
                        new Date(poolStats.last_block_time).getTime() : null,
                    earnings: await this.getPoolEarnings()
                };
                
                this.metrics.mining = miningMetrics;
                this.broadcast('mining', miningMetrics);
                
            } catch (error) {
                console.error('Mining metrics error:', error);
            }
        };
        
        update();
        this.timers.mining = setInterval(update, this.intervals.mining);
    }
    
    /**
     * Start trading metrics collection
     */
    startTradingMetrics() {
        const update = async () => {
            try {
                // Get order book depth
                const orderBookStats = await this.db.query(`
                    SELECT 
                        pair,
                        COUNT(CASE WHEN side = 'buy' THEN 1 END) as bid_count,
                        COUNT(CASE WHEN side = 'sell' THEN 1 END) as ask_count,
                        MAX(CASE WHEN side = 'buy' THEN price END) as best_bid,
                        MIN(CASE WHEN side = 'sell' THEN price END) as best_ask,
                        SUM(CASE WHEN side = 'buy' THEN amount END) as bid_volume,
                        SUM(CASE WHEN side = 'sell' THEN amount END) as ask_volume
                    FROM orders
                    WHERE status = 'open'
                    GROUP BY pair
                `);
                
                // Get recent trades
                const recentTrades = await this.db.query(`
                    SELECT 
                        pair,
                        COUNT(*) as trade_count,
                        SUM(amount) as volume,
                        SUM(amount * price) as value,
                        AVG(price) as avg_price,
                        MIN(price) as low_price,
                        MAX(price) as high_price
                    FROM trades
                    WHERE created_at > datetime('now', '-24 hours')
                    GROUP BY pair
                `);
                
                // Get active orders
                const activeOrders = await this.db.query(`
                    SELECT 
                        COUNT(*) as total_orders,
                        COUNT(DISTINCT user_id) as active_traders
                    FROM orders
                    WHERE status = 'open'
                `);
                
                const tradingMetrics = {
                    timestamp: Date.now(),
                    orderBook: orderBookStats.map(stats => ({
                        pair: stats.pair,
                        depth: {
                            bids: stats.bid_count,
                            asks: stats.ask_count
                        },
                        spread: stats.best_ask - stats.best_bid,
                        midPrice: (stats.best_bid + stats.best_ask) / 2,
                        volume: {
                            bid: stats.bid_volume,
                            ask: stats.ask_volume
                        }
                    })),
                    trades: recentTrades.map(stats => ({
                        pair: stats.pair,
                        count: stats.trade_count,
                        volume: stats.volume,
                        value: stats.value,
                        price: {
                            current: stats.avg_price,
                            low: stats.low_price,
                            high: stats.high_price
                        }
                    })),
                    activity: {
                        activeOrders: activeOrders[0]?.total_orders || 0,
                        activeTraders: activeOrders[0]?.active_traders || 0
                    }
                };
                
                this.metrics.trading = tradingMetrics;
                this.broadcast('trading', tradingMetrics);
                
            } catch (error) {
                console.error('Trading metrics error:', error);
            }
        };
        
        update();
        this.timers.trading = setInterval(update, this.intervals.trading);
    }
    
    /**
     * Start financial metrics collection
     */
    startFinancialMetrics() {
        const update = async () => {
            try {
                // Get revenue metrics
                const revenue = await this.db.query(`
                    SELECT 
                        SUM(CASE WHEN type = 'mining_fee' THEN amount END) as mining_fees,
                        SUM(CASE WHEN type = 'trading_fee' THEN amount END) as trading_fees,
                        SUM(CASE WHEN type = 'withdrawal_fee' THEN amount END) as withdrawal_fees,
                        COUNT(CASE WHEN type = 'deposit' THEN 1 END) as deposit_count,
                        COUNT(CASE WHEN type = 'withdrawal' THEN 1 END) as withdrawal_count,
                        SUM(CASE WHEN type = 'deposit' THEN amount END) as deposit_volume,
                        SUM(CASE WHEN type = 'withdrawal' THEN amount END) as withdrawal_volume
                    FROM transactions
                    WHERE created_at > datetime('now', '-24 hours')
                `);
                
                // Get wallet balances
                const wallets = await this.db.query(`
                    SELECT 
                        type,
                        currency,
                        SUM(balance) as total_balance
                    FROM wallets
                    GROUP BY type, currency
                `);
                
                // Get pending payouts
                const pendingPayouts = await this.db.query(`
                    SELECT 
                        COUNT(*) as count,
                        SUM(amount) as total_amount
                    FROM payouts
                    WHERE status = 'pending'
                `);
                
                const financialMetrics = {
                    timestamp: Date.now(),
                    revenue: {
                        mining: revenue[0]?.mining_fees || 0,
                        trading: revenue[0]?.trading_fees || 0,
                        withdrawal: revenue[0]?.withdrawal_fees || 0,
                        total: (revenue[0]?.mining_fees || 0) + 
                               (revenue[0]?.trading_fees || 0) + 
                               (revenue[0]?.withdrawal_fees || 0)
                    },
                    volume: {
                        deposits: {
                            count: revenue[0]?.deposit_count || 0,
                            amount: revenue[0]?.deposit_volume || 0
                        },
                        withdrawals: {
                            count: revenue[0]?.withdrawal_count || 0,
                            amount: revenue[0]?.withdrawal_volume || 0
                        }
                    },
                    wallets: wallets.reduce((acc, wallet) => {
                        if (!acc[wallet.type]) acc[wallet.type] = {};
                        acc[wallet.type][wallet.currency] = wallet.total_balance;
                        return acc;
                    }, {}),
                    payouts: {
                        pending: pendingPayouts[0]?.count || 0,
                        amount: pendingPayouts[0]?.total_amount || 0
                    }
                };
                
                this.metrics.financial = financialMetrics;
                this.broadcast('financial', financialMetrics);
                
            } catch (error) {
                console.error('Financial metrics error:', error);
            }
        };
        
        update();
        this.timers.financial = setInterval(update, this.intervals.financial);
    }
    
    /**
     * Setup WebSocket handlers
     */
    setupWebSocketHandlers() {
        // Handle dashboard subscriptions
        this.wsManager.addMessageHandler('dashboard:subscribe', async (connection, message) => {
            const { channels = ['all'] } = message;
            
            // Add to subscribers
            this.subscribers.add({
                connectionId: connection.id,
                channels: new Set(channels)
            });
            
            // Send current metrics
            const currentMetrics = this.getCurrentMetrics(channels);
            await this.wsManager.sendToConnection(connection, {
                type: 'dashboard:metrics',
                data: currentMetrics
            });
        });
        
        // Handle unsubscribe
        this.wsManager.addMessageHandler('dashboard:unsubscribe', async (connection) => {
            this.subscribers.delete(
                Array.from(this.subscribers).find(s => s.connectionId === connection.id)
            );
        });
    }
    
    /**
     * Broadcast metrics to subscribers
     */
    broadcast(channel, data) {
        if (!this.wsManager) return;
        
        const message = {
            type: 'dashboard:update',
            channel,
            data
        };
        
        // Use WebSocket manager's broadcast to channel functionality
        const dashboardChannel = `dashboard:${channel}`;
        
        // If wsManager has broadcast method, use it
        if (this.wsManager.broadcast) {
            this.wsManager.broadcast(dashboardChannel, message);
        } else {
            // Fallback to manual broadcast
            for (const subscriber of this.subscribers) {
                if (subscriber.channels.has('all') || subscriber.channels.has(channel)) {
                    const connection = this.wsManager.connections?.get(subscriber.connectionId);
                    if (connection) {
                        this.wsManager.sendToConnection(connection, message).catch(() => {
                            // Remove dead subscribers
                            this.subscribers.delete(subscriber);
                        });
                    }
                }
            }
        }
    }
    
    /**
     * Get current metrics for channels
     */
    getCurrentMetrics(channels) {
        const metrics = {};
        
        if (channels.includes('all')) {
            return this.metrics;
        }
        
        for (const channel of channels) {
            if (this.metrics[channel]) {
                metrics[channel] = this.metrics[channel];
            }
        }
        
        return metrics;
    }
    
    /**
     * Add alert
     */
    addAlert(level, message, details = {}) {
        const alert = {
            id: Date.now() + Math.random(),
            level, // 'info', 'warning', 'error', 'critical'
            message,
            details,
            timestamp: Date.now()
        };
        
        this.metrics.alerts.unshift(alert);
        
        // Keep only last 100 alerts
        if (this.metrics.alerts.length > 100) {
            this.metrics.alerts = this.metrics.alerts.slice(0, 100);
        }
        
        // Broadcast alert
        this.broadcast('alert', alert);
        
        return alert;
    }
    
    // Helper methods
    async getActiveConnections() {
        const result = await this.db.query(
            'SELECT COUNT(*) as count FROM connections WHERE active = 1'
        );
        return result[0]?.count || 0;
    }
    
    async getDbPoolSize() {
        // This would check actual database pool
        return 10;
    }
    
    async getActiveQueries() {
        // This would check active database queries
        return 0;
    }
    
    getLoadAverage() {
        const os = require('os');
        return os.loadavg();
    }
    
    async getTotalMiners() {
        const result = await this.db.query('SELECT COUNT(*) as count FROM miners');
        return result[0]?.count || 0;
    }
    
    async getTotalWorkers() {
        const result = await this.db.query('SELECT COUNT(*) as count FROM workers');
        return result[0]?.count || 0;
    }
    
    async getAverageHashrate() {
        const result = await this.db.query(
            'SELECT AVG(hashrate) as avg FROM workers WHERE active = 1'
        );
        return result[0]?.avg || 0;
    }
    
    async getPoolEarnings() {
        const result = await this.db.query(`
            SELECT SUM(amount) as total 
            FROM earnings 
            WHERE created_at > datetime('now', '-24 hours')
        `);
        return result[0]?.total || 0;
    }
}

/**
 * Dashboard HTTP endpoint
 */
export function createDashboardRoute(dashboard) {
    return async (req, res) => {
        const { channels = ['all'] } = req.query;
        const metrics = dashboard.getCurrentMetrics(
            Array.isArray(channels) ? channels : [channels]
        );
        
        res.json({
            timestamp: Date.now(),
            metrics
        });
    };
}

export default RealtimeDashboard;