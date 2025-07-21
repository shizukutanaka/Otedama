/**
 * Real-Time Alert Manager for Otedama
 * Enhanced alert system with DEX, mining, and cross-chain integration
 * 
 * Design principles:
 * - Real-time event processing (Carmack)
 * - Clean integration with all subsystems (Martin)
 * - Simple and powerful alert rules (Pike)
 */

import { EventEmitter } from 'events';
import { logger } from '../core/logger.js';
import AlertSystem from './alert-system.js';

// Event categories for real-time monitoring
export const EventCategory = {
    // DEX events
    LARGE_TRADE: 'large_trade',
    PRICE_MOVEMENT: 'price_movement',
    LIQUIDITY_CHANGE: 'liquidity_change',
    ORDER_BOOK_IMBALANCE: 'order_book_imbalance',
    
    // Mining events
    BLOCK_FOUND: 'block_found',
    HASHRATE_CHANGE: 'hashrate_change',
    WORKER_STATUS: 'worker_status',
    POOL_PERFORMANCE: 'pool_performance',
    
    // Cross-chain events
    TRANSFER_STATUS: 'transfer_status',
    BRIDGE_LIQUIDITY: 'bridge_liquidity',
    CHAIN_STATUS: 'chain_status',
    
    // Security events
    SUSPICIOUS_ACTIVITY: 'suspicious_activity',
    RATE_LIMIT: 'rate_limit',
    AUTHENTICATION: 'authentication',
    
    // System events
    PERFORMANCE: 'performance',
    ERROR_RATE: 'error_rate',
    RESOURCE_USAGE: 'resource_usage'
};

export class RealTimeAlertManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            enableRealTimeProcessing: config.enableRealTimeProcessing !== false,
            maxEventsPerSecond: config.maxEventsPerSecond || 1000,
            eventQueueSize: config.eventQueueSize || 10000,
            processingInterval: config.processingInterval || 100, // 100ms
            ...config
        };
        
        // Core alert system
        this.alertSystem = new AlertSystem(config.alertSystemConfig || {});
        
        // Event queue for real-time processing
        this.eventQueue = [];
        this.processing = false;
        
        // Subscriptions to system events
        this.subscriptions = new Map();
        
        // Real-time metrics
        this.realTimeMetrics = {
            eventsProcessed: 0,
            eventsPerSecond: 0,
            alertsTriggered: 0,
            processingLatency: 0,
            eventsByCategory: new Map()
        };
        
        // Initialize real-time rules
        this.initializeRealTimeRules();
        
        // Start processing
        if (this.config.enableRealTimeProcessing) {
            this.startEventProcessing();
        }
    }
    
    /**
     * Initialize real-time alert rules
     */
    initializeRealTimeRules() {
        // Large trade alert
        this.alertSystem.addRule({
            name: 'Large Trade Alert',
            description: 'Alert on unusually large trades',
            conditions: [
                { metric: 'trade.amount', operator: '>', threshold: 1000 },
                { metric: 'trade.value', operator: '>', threshold: 100000 }
            ],
            operator: 'OR',
            severity: 'high',
            title: 'Large Trade Detected',
            message: '{{trade.side}} {{trade.amount}} {{trade.pair}} at {{trade.price}} (Value: ${{trade.value}})',
            channels: ['console', 'slack', 'websocket']
        });
        
        // Price spike alert
        this.alertSystem.addRule({
            name: 'Price Spike Alert',
            description: 'Alert on significant price movements',
            conditions: [
                { metric: 'price.changePercent', operator: '>', threshold: 5 }
            ],
            severity: 'medium',
            title: 'Price Spike: {{price.pair}}',
            message: '{{price.pair}} moved {{price.changePercent}}% to {{price.current}}',
            channels: ['console', 'websocket'],
            throttle: true
        });
        
        // Block found alert
        this.alertSystem.addRule({
            name: 'Block Found',
            description: 'Alert when a block is found',
            conditions: [
                { metric: 'block.found', operator: '==', threshold: true }
            ],
            severity: 'info',
            title: 'Block Found!',
            message: 'Block {{block.height}} found by {{block.worker}} (Reward: {{block.reward}})',
            channels: ['console', 'slack', 'push']
        });
        
        // Worker offline alert
        this.alertSystem.addRule({
            name: 'Worker Offline',
            description: 'Alert when a worker goes offline',
            conditions: [
                { metric: 'worker.status', operator: '==', threshold: 'offline' },
                { metric: 'worker.hashrate', operator: '==', threshold: 0 }
            ],
            operator: 'AND',
            severity: 'high',
            title: 'Worker Offline',
            message: 'Worker {{worker.name}} is offline (Last seen: {{worker.lastSeen}})',
            channels: ['console', 'email', 'push'],
            escalationPath: [
                { level: 1, delay: 300000, channels: ['slack'] }, // 5 min
                { level: 2, delay: 1800000, channels: ['phone'] } // 30 min
            ]
        });
        
        // Cross-chain transfer delay
        this.alertSystem.addRule({
            name: 'Cross-Chain Transfer Delayed',
            description: 'Alert on delayed cross-chain transfers',
            conditions: [
                { metric: 'transfer.delayRatio', operator: '>', threshold: 1.5 }
            ],
            severity: 'medium',
            title: 'Transfer Delayed',
            message: 'Transfer {{transfer.id}} is delayed ({{transfer.fromChain}} → {{transfer.toChain}})',
            channels: ['console', 'websocket']
        });
        
        // High error rate alert
        this.alertSystem.addRule({
            name: 'High Error Rate',
            description: 'Alert on high system error rate',
            conditions: [
                { metric: 'system.errorRate', operator: '>', threshold: 5 },
                { metric: 'system.errors5min', operator: '>', threshold: 100 }
            ],
            operator: 'OR',
            severity: 'critical',
            title: 'High Error Rate',
            message: 'Error rate: {{system.errorRate}}% ({{system.errors5min}} errors in 5 min)',
            channels: ['console', 'slack', 'email', 'webhook']
        });
        
        logger.info('Initialized real-time alert rules');
    }
    
    /**
     * Subscribe to system events
     */
    subscribeToSystemEvents(systems) {
        const { dexEngine, miningPool, crossChainBridge, securityManager } = systems;
        
        // DEX events
        if (dexEngine) {
            dexEngine.on('trade:executed', (event) => {
                this.processEvent({
                    category: EventCategory.LARGE_TRADE,
                    data: {
                        trade: {
                            ...event.trade,
                            value: event.trade.price * event.trade.quantity
                        }
                    }
                });
            });
            
            dexEngine.on('order:processed', (event) => {
                // Monitor order book changes
                this.processEvent({
                    category: EventCategory.ORDER_BOOK_IMBALANCE,
                    data: { order: event.order }
                });
            });
            
            // Monitor price changes
            setInterval(() => {
                this.checkPriceMovements(dexEngine);
            }, 5000); // Every 5 seconds
        }
        
        // Mining pool events
        if (miningPool) {
            miningPool.on('block:found', (block) => {
                this.processEvent({
                    category: EventCategory.BLOCK_FOUND,
                    data: { block: { ...block, found: true } }
                });
            });
            
            miningPool.on('worker:status', (worker) => {
                this.processEvent({
                    category: EventCategory.WORKER_STATUS,
                    data: { worker }
                });
            });
            
            miningPool.on('hashrate:update', (data) => {
                this.processEvent({
                    category: EventCategory.HASHRATE_CHANGE,
                    data: { hashrate: data }
                });
            });
        }
        
        // Cross-chain events
        if (crossChainBridge) {
            crossChainBridge.on('transfer:initiated', (transfer) => {
                this.trackTransfer(transfer);
            });
            
            crossChainBridge.on('transfer:completed', (transfer) => {
                this.processEvent({
                    category: EventCategory.TRANSFER_STATUS,
                    data: { 
                        transfer: {
                            ...transfer,
                            status: 'completed',
                            duration: transfer.completedAt - transfer.createdAt
                        }
                    }
                });
            });
            
            crossChainBridge.on('transfer:failed', (transfer) => {
                this.processEvent({
                    category: EventCategory.TRANSFER_STATUS,
                    data: { 
                        transfer: {
                            ...transfer,
                            status: 'failed'
                        }
                    }
                });
            });
        }
        
        // Security events
        if (securityManager) {
            securityManager.on('suspicious:activity', (event) => {
                this.processEvent({
                    category: EventCategory.SUSPICIOUS_ACTIVITY,
                    data: event
                });
            });
            
            securityManager.on('rate:limit:exceeded', (event) => {
                this.processEvent({
                    category: EventCategory.RATE_LIMIT,
                    data: event
                });
            });
        }
        
        logger.info('Subscribed to system events');
    }
    
    /**
     * Process real-time event
     */
    async processEvent(event) {
        // Add to queue
        this.eventQueue.push({
            ...event,
            timestamp: Date.now()
        });
        
        // Limit queue size
        if (this.eventQueue.length > this.config.eventQueueSize) {
            this.eventQueue.shift();
        }
        
        // Update metrics
        this.realTimeMetrics.eventsProcessed++;
        const categoryCount = this.realTimeMetrics.eventsByCategory.get(event.category) || 0;
        this.realTimeMetrics.eventsByCategory.set(event.category, categoryCount + 1);
        
        this.emit('event:received', event);
    }
    
    /**
     * Start event processing loop
     */
    startEventProcessing() {
        setInterval(async () => {
            if (this.processing || this.eventQueue.length === 0) return;
            
            this.processing = true;
            const startTime = Date.now();
            
            try {
                // Process batch of events
                const batchSize = Math.min(
                    this.eventQueue.length,
                    Math.floor(this.config.maxEventsPerSecond * this.config.processingInterval / 1000)
                );
                
                const events = this.eventQueue.splice(0, batchSize);
                
                for (const event of events) {
                    await this.evaluateEvent(event);
                }
                
                // Update processing metrics
                const processingTime = Date.now() - startTime;
                this.realTimeMetrics.processingLatency = 
                    (this.realTimeMetrics.processingLatency * 0.9) + (processingTime * 0.1);
                
            } catch (error) {
                logger.error('Event processing error:', error);
            } finally {
                this.processing = false;
            }
        }, this.config.processingInterval);
        
        // Update events per second
        setInterval(() => {
            const currentEvents = this.realTimeMetrics.eventsProcessed;
            this.realTimeMetrics.eventsPerSecond = 
                (currentEvents - this.lastEventCount) / 1;
            this.lastEventCount = currentEvents;
        }, 1000);
        
        this.lastEventCount = 0;
    }
    
    /**
     * Evaluate event against alert rules
     */
    async evaluateEvent(event) {
        // Convert event to metrics format
        const metrics = this.eventToMetrics(event);
        
        // Evaluate against alert rules
        await this.alertSystem.evaluateMetrics(metrics);
    }
    
    /**
     * Convert event to metrics format
     */
    eventToMetrics(event) {
        const metrics = {
            timestamp: event.timestamp,
            category: event.category,
            ...event.data
        };
        
        // Add system metrics
        metrics.system = {
            errorRate: this.calculateErrorRate(),
            errors5min: this.getRecentErrors(5 * 60 * 1000)
        };
        
        return metrics;
    }
    
    /**
     * Check price movements across all pairs
     */
    async checkPriceMovements(dexEngine) {
        const pairs = ['BTC/USDT', 'ETH/USDT', 'ETH/BTC']; // Major pairs
        
        for (const pair of pairs) {
            const marketData = dexEngine.getMarketData(pair);
            if (!marketData || !marketData.price) continue;
            
            // Get previous price
            const previousPrice = this.previousPrices?.get(pair) || marketData.price;
            
            // Calculate change
            const changePercent = ((marketData.price - previousPrice) / previousPrice) * 100;
            
            if (Math.abs(changePercent) > 0.1) { // More than 0.1% change
                this.processEvent({
                    category: EventCategory.PRICE_MOVEMENT,
                    data: {
                        price: {
                            pair,
                            current: marketData.price,
                            previous: previousPrice,
                            changePercent: changePercent.toFixed(2),
                            volume: marketData.volume24h
                        }
                    }
                });
            }
            
            // Store current price
            if (!this.previousPrices) {
                this.previousPrices = new Map();
            }
            this.previousPrices.set(pair, marketData.price);
        }
    }
    
    /**
     * Track cross-chain transfer
     */
    trackTransfer(transfer) {
        // Set up monitoring for transfer delays
        const checkDelay = setInterval(() => {
            const now = Date.now();
            const elapsed = now - transfer.createdAt;
            const delayRatio = elapsed / transfer.estimatedTime;
            
            if (delayRatio > 1.5 && transfer.status === 'pending') {
                this.processEvent({
                    category: EventCategory.TRANSFER_STATUS,
                    data: {
                        transfer: {
                            ...transfer,
                            delayRatio,
                            elapsed
                        }
                    }
                });
            }
            
            // Stop monitoring if transfer completes
            if (transfer.status !== 'pending') {
                clearInterval(checkDelay);
            }
        }, 60000); // Check every minute
    }
    
    /**
     * Create custom alert rule
     */
    createCustomRule(ruleConfig) {
        return this.alertSystem.addRule(ruleConfig);
    }
    
    /**
     * Get real-time metrics
     */
    getRealTimeMetrics() {
        return {
            ...this.realTimeMetrics,
            eventsByCategory: Object.fromEntries(this.realTimeMetrics.eventsByCategory),
            queueSize: this.eventQueue.length,
            alertSystemStatus: this.alertSystem.getStatus()
        };
    }
    
    /**
     * Helper methods
     */
    
    calculateErrorRate() {
        // This would calculate from actual error logs
        return Math.random() * 2; // Simulated
    }
    
    getRecentErrors(timeWindow) {
        // This would count actual errors in time window
        return Math.floor(Math.random() * 50); // Simulated
    }
    
    /**
     * Start the alert manager
     */
    async start() {
        await this.alertSystem.start();
        logger.info('Real-time alert manager started');
    }
    
    /**
     * Stop the alert manager
     */
    async stop() {
        await this.alertSystem.stop();
        logger.info('Real-time alert manager stopped');
    }
}

export default RealTimeAlertManager;