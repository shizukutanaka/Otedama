/**
 * Real-Time Analytics Dashboard for Otedama
 * Provides live analytics and insights across all platform services
 * 
 * Design principles:
 * - Real-time data processing (Carmack)
 * - Clean architecture with modular components (Martin)
 * - Simple and efficient data aggregation (Pike)
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { WebSocketServer } from 'ws';

const logger = getLogger('RealtimeDashboard');

export class RealTimeAnalyticsDashboard extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            updateInterval: config.updateInterval || 1000, // 1 second
            aggregationWindow: config.aggregationWindow || 300000, // 5 minutes
            metricsRetention: config.metricsRetention || 86400000, // 24 hours
            wsPort: config.wsPort || 8090,
            ...config
        };
        
        // Data stores
        this.metrics = new Map();
        this.timeSeriesData = new Map();
        this.aggregations = new Map();
        
        // Connected services
        this.services = new Map();
        
        // WebSocket clients
        this.wsClients = new Set();
        
        // Metric definitions
        this.initializeMetrics();
        
        // Start update loop
        this.startUpdateLoop();
    }
    
    /**
     * Initialize metric definitions
     */
    initializeMetrics() {
        this.metricDefinitions = {
            // System metrics
            system: {
                cpu: { type: 'gauge', unit: 'percent' },
                memory: { type: 'gauge', unit: 'bytes' },
                connections: { type: 'gauge', unit: 'count' },
                uptime: { type: 'counter', unit: 'seconds' }
            },
            
            // Mining metrics
            mining: {
                hashrate: { type: 'gauge', unit: 'hash/s' },
                shares: { type: 'counter', unit: 'count' },
                blocks: { type: 'counter', unit: 'count' },
                workers: { type: 'gauge', unit: 'count' },
                efficiency: { type: 'gauge', unit: 'percent' },
                revenue: { type: 'counter', unit: 'BTC' }
            },
            
            // Trading metrics
            trading: {
                volume24h: { type: 'gauge', unit: 'USD' },
                trades: { type: 'counter', unit: 'count' },
                orders: { type: 'gauge', unit: 'count' },
                liquidity: { type: 'gauge', unit: 'USD' },
                spread: { type: 'gauge', unit: 'percent' },
                fees: { type: 'counter', unit: 'USD' }
            },
            
            // DeFi metrics
            defi: {
                tvl: { type: 'gauge', unit: 'USD' }, // Total Value Locked
                apy: { type: 'gauge', unit: 'percent' },
                loans: { type: 'gauge', unit: 'count' },
                liquidations: { type: 'counter', unit: 'count' },
                staked: { type: 'gauge', unit: 'USD' },
                rewards: { type: 'counter', unit: 'USD' }
            },
            
            // Performance metrics
            performance: {
                latency: { type: 'histogram', unit: 'ms' },
                throughput: { type: 'gauge', unit: 'req/s' },
                errors: { type: 'counter', unit: 'count' },
                cacheHitRate: { type: 'gauge', unit: 'percent' },
                queueSize: { type: 'gauge', unit: 'count' }
            }
        };
        
        // Initialize data structures for each metric
        Object.entries(this.metricDefinitions).forEach(([category, metrics]) => {
            this.metrics.set(category, new Map());
            this.timeSeriesData.set(category, new Map());
            this.aggregations.set(category, new Map());
            
            Object.keys(metrics).forEach(metric => {
                this.timeSeriesData.get(category).set(metric, []);
                this.aggregations.get(category).set(metric, {
                    min: Infinity,
                    max: -Infinity,
                    avg: 0,
                    sum: 0,
                    count: 0
                });
            });
        });
    }
    
    /**
     * Connect to platform services
     */
    connectServices(services) {
        const { miningPool, dexEngine, defiManager, performanceMonitor } = services;
        
        // Mining pool integration
        if (miningPool) {
            this.services.set('mining', miningPool);
            
            miningPool.on('stats:update', (stats) => {
                this.updateMetric('mining', 'hashrate', stats.totalHashrate);
                this.updateMetric('mining', 'workers', stats.activeWorkers);
                this.updateMetric('mining', 'efficiency', stats.efficiency);
            });
            
            miningPool.on('share:accepted', () => {
                this.incrementMetric('mining', 'shares');
            });
            
            miningPool.on('block:found', (block) => {
                this.incrementMetric('mining', 'blocks');
                this.incrementMetric('mining', 'revenue', block.reward);
            });
        }
        
        // DEX engine integration
        if (dexEngine) {
            this.services.set('trading', dexEngine);
            
            dexEngine.on('trade:executed', (trade) => {
                this.incrementMetric('trading', 'trades');
                this.incrementMetric('trading', 'fees', trade.fee);
            });
            
            dexEngine.on('stats:update', (stats) => {
                this.updateMetric('trading', 'volume24h', stats.volume24h);
                this.updateMetric('trading', 'orders', stats.activeOrders);
                this.updateMetric('trading', 'liquidity', stats.totalLiquidity);
                this.updateMetric('trading', 'spread', stats.avgSpread);
            });
        }
        
        // DeFi manager integration
        if (defiManager) {
            this.services.set('defi', defiManager);
            
            defiManager.on('stats:update', (stats) => {
                this.updateMetric('defi', 'tvl', stats.totalValueLocked);
                this.updateMetric('defi', 'apy', stats.averageAPY);
                this.updateMetric('defi', 'loans', stats.activeLoans);
                this.updateMetric('defi', 'staked', stats.totalStaked);
            });
            
            defiManager.on('liquidation', () => {
                this.incrementMetric('defi', 'liquidations');
            });
            
            defiManager.on('reward:distributed', (amount) => {
                this.incrementMetric('defi', 'rewards', amount);
            });
        }
        
        // Performance monitor integration
        if (performanceMonitor) {
            this.services.set('performance', performanceMonitor);
            
            setInterval(() => {
                const stats = performanceMonitor.getStats();
                this.updateMetric('performance', 'latency', stats.avgLatency);
                this.updateMetric('performance', 'throughput', stats.requestsPerSecond);
                this.updateMetric('performance', 'errors', stats.errorCount);
                this.updateMetric('performance', 'cacheHitRate', stats.cacheHitRate);
            }, 5000);
        }
        
        // System metrics
        this.startSystemMetricsCollection();
    }
    
    /**
     * Start system metrics collection
     */
    startSystemMetricsCollection() {
        setInterval(() => {
            const usage = process.cpuUsage();
            const mem = process.memoryUsage();
            
            this.updateMetric('system', 'cpu', 
                (usage.user + usage.system) / 1000000 * 100 / this.config.updateInterval);
            this.updateMetric('system', 'memory', mem.heapUsed);
            this.updateMetric('system', 'uptime', process.uptime());
            this.updateMetric('system', 'connections', this.wsClients.size);
        }, this.config.updateInterval);
    }
    
    /**
     * Update a metric value
     */
    updateMetric(category, metric, value) {
        if (!this.metrics.has(category)) return;
        
        const categoryMetrics = this.metrics.get(category);
        categoryMetrics.set(metric, value);
        
        // Add to time series
        const timeSeries = this.timeSeriesData.get(category).get(metric);
        const dataPoint = {
            timestamp: Date.now(),
            value: value
        };
        
        timeSeries.push(dataPoint);
        
        // Clean old data
        const cutoff = Date.now() - this.config.metricsRetention;
        while (timeSeries.length > 0 && timeSeries[0].timestamp < cutoff) {
            timeSeries.shift();
        }
        
        // Update aggregations
        this.updateAggregation(category, metric, value);
        
        // Emit update event
        this.emit('metric:update', { category, metric, value });
    }
    
    /**
     * Increment a counter metric
     */
    incrementMetric(category, metric, amount = 1) {
        const current = this.metrics.get(category)?.get(metric) || 0;
        this.updateMetric(category, metric, current + amount);
    }
    
    /**
     * Update metric aggregations
     */
    updateAggregation(category, metric, value) {
        const agg = this.aggregations.get(category).get(metric);
        
        agg.min = Math.min(agg.min, value);
        agg.max = Math.max(agg.max, value);
        agg.sum += value;
        agg.count++;
        agg.avg = agg.sum / agg.count;
        
        // Calculate percentiles for time window
        const timeSeries = this.timeSeriesData.get(category).get(metric);
        const windowStart = Date.now() - this.config.aggregationWindow;
        const windowData = timeSeries
            .filter(d => d.timestamp >= windowStart)
            .map(d => d.value)
            .sort((a, b) => a - b);
        
        if (windowData.length > 0) {
            agg.p50 = windowData[Math.floor(windowData.length * 0.5)];
            agg.p95 = windowData[Math.floor(windowData.length * 0.95)];
            agg.p99 = windowData[Math.floor(windowData.length * 0.99)];
        }
    }
    
    /**
     * Get current dashboard data
     */
    getDashboardData() {
        const data = {
            timestamp: Date.now(),
            categories: {}
        };
        
        // Current values
        this.metrics.forEach((metrics, category) => {
            data.categories[category] = {
                current: Object.fromEntries(metrics),
                aggregations: Object.fromEntries(this.aggregations.get(category))
            };
        });
        
        // Add derived metrics
        data.derived = this.calculateDerivedMetrics();
        
        // Add alerts
        data.alerts = this.checkAlertConditions();
        
        return data;
    }
    
    /**
     * Calculate derived metrics
     */
    calculateDerivedMetrics() {
        const derived = {};
        
        // Mining profitability
        const hashrate = this.metrics.get('mining')?.get('hashrate') || 0;
        const revenue = this.metrics.get('mining')?.get('revenue') || 0;
        derived.miningProfitability = hashrate > 0 ? revenue / hashrate : 0;
        
        // Trading efficiency
        const volume = this.metrics.get('trading')?.get('volume24h') || 0;
        const fees = this.metrics.get('trading')?.get('fees') || 0;
        derived.tradingEfficiency = volume > 0 ? (fees / volume) * 100 : 0;
        
        // DeFi utilization
        const tvl = this.metrics.get('defi')?.get('tvl') || 0;
        const loans = this.metrics.get('defi')?.get('loans') || 0;
        derived.defiUtilization = tvl > 0 ? (loans / tvl) * 100 : 0;
        
        // System health score
        const cpu = this.metrics.get('system')?.get('cpu') || 0;
        const errors = this.metrics.get('performance')?.get('errors') || 0;
        derived.healthScore = Math.max(0, 100 - cpu - (errors * 10));
        
        return derived;
    }
    
    /**
     * Check alert conditions
     */
    checkAlertConditions() {
        const alerts = [];
        
        // High CPU usage
        const cpu = this.metrics.get('system')?.get('cpu') || 0;
        if (cpu > 80) {
            alerts.push({
                level: 'warning',
                category: 'system',
                message: `High CPU usage: ${cpu.toFixed(1)}%`
            });
        }
        
        // Low hashrate
        const hashrate = this.metrics.get('mining')?.get('hashrate') || 0;
        const workers = this.metrics.get('mining')?.get('workers') || 0;
        if (workers > 0 && hashrate < 1000000) { // Less than 1 MH/s total
            alerts.push({
                level: 'warning',
                category: 'mining',
                message: 'Low total hashrate detected'
            });
        }
        
        // High error rate
        const errors = this.metrics.get('performance')?.get('errors') || 0;
        if (errors > 100) {
            alerts.push({
                level: 'error',
                category: 'performance',
                message: `High error rate: ${errors} errors`
            });
        }
        
        return alerts;
    }
    
    /**
     * Get time series data for charting
     */
    getTimeSeriesData(category, metric, duration = 3600000) { // 1 hour default
        const timeSeries = this.timeSeriesData.get(category)?.get(metric) || [];
        const startTime = Date.now() - duration;
        
        return timeSeries
            .filter(d => d.timestamp >= startTime)
            .map(d => ({
                x: d.timestamp,
                y: d.value
            }));
    }
    
    /**
     * Start update loop
     */
    startUpdateLoop() {
        setInterval(() => {
            const data = this.getDashboardData();
            
            // Broadcast to WebSocket clients
            this.broadcast({
                type: 'dashboard:update',
                data: data
            });
            
            // Emit update event
            this.emit('dashboard:update', data);
            
        }, this.config.updateInterval);
    }
    
    /**
     * Start WebSocket server
     */
    async startWebSocketServer() {
        this.wss = new WebSocketServer({ 
            port: this.config.wsPort,
            perMessageDeflate: {
                zlibDeflateOptions: {
                    level: 1
                },
                threshold: 1024
            }
        });
        
        this.wss.on('connection', (ws) => {
            this.wsClients.add(ws);
            logger.info(`Analytics dashboard client connected. Total: ${this.wsClients.size}`);
            
            // Send initial data
            ws.send(JSON.stringify({
                type: 'dashboard:init',
                data: this.getDashboardData()
            }));
            
            // Handle client messages
            ws.on('message', (message) => {
                try {
                    const msg = JSON.parse(message);
                    this.handleClientMessage(ws, msg);
                } catch (error) {
                    logger.error('Invalid message from client:', error);
                }
            });
            
            // Handle disconnect
            ws.on('close', () => {
                this.wsClients.delete(ws);
                logger.info(`Analytics dashboard client disconnected. Total: ${this.wsClients.size}`);
            });
            
            // Handle errors
            ws.on('error', (error) => {
                logger.error('WebSocket error:', error);
                this.wsClients.delete(ws);
            });
        });
        
        logger.info(`Analytics dashboard WebSocket server started on port ${this.config.wsPort}`);
    }
    
    /**
     * Handle client WebSocket message
     */
    handleClientMessage(ws, message) {
        switch (message.type) {
            case 'subscribe:metric':
                // Client wants updates for specific metric
                ws.subscribedMetrics = ws.subscribedMetrics || new Set();
                ws.subscribedMetrics.add(`${message.category}.${message.metric}`);
                
                // Send current data
                ws.send(JSON.stringify({
                    type: 'metric:data',
                    category: message.category,
                    metric: message.metric,
                    data: this.getTimeSeriesData(message.category, message.metric, message.duration)
                }));
                break;
                
            case 'unsubscribe:metric':
                if (ws.subscribedMetrics) {
                    ws.subscribedMetrics.delete(`${message.category}.${message.metric}`);
                }
                break;
                
            case 'get:timeseries':
                ws.send(JSON.stringify({
                    type: 'timeseries:data',
                    category: message.category,
                    metric: message.metric,
                    data: this.getTimeSeriesData(message.category, message.metric, message.duration)
                }));
                break;
                
            case 'get:aggregations':
                ws.send(JSON.stringify({
                    type: 'aggregations:data',
                    data: Object.fromEntries(this.aggregations)
                }));
                break;
        }
    }
    
    /**
     * Broadcast message to all connected clients
     */
    broadcast(message) {
        const data = JSON.stringify(message);
        this.wsClients.forEach(ws => {
            if (ws.readyState === ws.OPEN) {
                ws.send(data);
            }
        });
    }
    
    /**
     * Export metrics for Prometheus
     */
    exportPrometheusMetrics() {
        let output = '';
        
        this.metrics.forEach((categoryMetrics, category) => {
            categoryMetrics.forEach((value, metric) => {
                const definition = this.metricDefinitions[category]?.[metric];
                if (!definition) return;
                
                const metricName = `otedama_${category}_${metric}`;
                output += `# TYPE ${metricName} ${definition.type}\n`;
                output += `# UNIT ${metricName} ${definition.unit}\n`;
                output += `${metricName} ${value}\n\n`;
            });
        });
        
        return output;
    }
    
    /**
     * Get analytics summary
     */
    getAnalyticsSummary() {
        return {
            systemHealth: this.calculateDerivedMetrics().healthScore,
            totalHashrate: this.metrics.get('mining')?.get('hashrate') || 0,
            tradingVolume24h: this.metrics.get('trading')?.get('volume24h') || 0,
            totalValueLocked: this.metrics.get('defi')?.get('tvl') || 0,
            activeConnections: this.wsClients.size,
            uptime: process.uptime(),
            alerts: this.checkAlertConditions()
        };
    }
    
    /**
     * Start the analytics dashboard
     */
    async start() {
        await this.startWebSocketServer();
        logger.info('Real-time analytics dashboard started');
    }
    
    /**
     * Stop the analytics dashboard
     */
    async stop() {
        if (this.wss) {
            this.wss.close();
        }
        logger.info('Real-time analytics dashboard stopped');
    }
}

export default RealTimeAnalyticsDashboard;