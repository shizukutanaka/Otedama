/**
 * Metrics WebSocket Server
 * Streams real-time performance metrics to dashboard clients
 */

import { EventEmitter } from 'events';
import { WebSocketServer } from 'ws';

export class MetricsWebSocketServer extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            server: options.server,
            path: options.path || '/ws/metrics',
            broadcastInterval: options.broadcastInterval || 1000, // 1 second
            compression: options.compression !== false,
            maxClients: options.maxClients || 100,
            metricsCollector: options.metricsCollector,
            ...options
        };
        
        this.metricsCollector = this.options.metricsCollector;
        this.started = false;
    }

    async start() {
        if (this.started) return;
        
        // Initialize WebSocket server
        this.wss = new WebSocketServer({
            server: this.options.server,
            path: this.options.path,
            perMessageDeflate: this.options.compression
        });
        
        // Active clients
        this.clients = new Set();
        
        // Metrics buffer
        this.metricsBuffer = {
            requests: { rate: 0, change: 0 },
            latency: { avg: 0, p50: 0, p95: 0, p99: 0, change: 0 },
            errors: { rate: 0, change: 0 },
            connections: { active: 0, change: 0 },
            cache: { hitRate: 0, change: 0 },
            memory: { heapUsed: 0, change: 0 },
            system: { cpuPercent: 0, memoryPercent: 0 },
            database: { select: 0, insert: 0, update: 0, delete: 0 },
            mining: { hashrate: 0, activeMiners: 0 },
            dex: { volume: {}, trades: 0 }
        };
        
        // Previous values for calculating changes
        this.previousMetrics = {};
        
        // Setup
        this.setupWebSocketServer();
        this.startBroadcasting();
        
        // Connect to metrics collector if provided
        if (this.metricsCollector) {
            this.connectToMetricsCollector();
        }
        
        this.started = true;
    }

    setupWebSocketServer() {
        this.wss.on('connection', (ws, req) => {
            // Check client limit
            if (this.clients.size >= this.options.maxClients) {
                ws.close(1008, 'Server full');
                return;
            }
            
            // Client info
            const clientInfo = {
                ws,
                ip: req.socket.remoteAddress,
                connectedAt: Date.now(),
                lastPing: Date.now()
            };
            
            this.clients.add(clientInfo);
            this.emit('client:connected', { ip: clientInfo.ip });
            
            // Send initial data
            this.sendInitialData(ws);
            
            // Setup ping/pong
            ws.on('pong', () => {
                clientInfo.lastPing = Date.now();
            });
            
            // Handle messages
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleClientMessage(clientInfo, message);
                } catch (error) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Invalid message format'
                    }));
                }
            });
            
            // Handle disconnect
            ws.on('close', () => {
                this.clients.delete(clientInfo);
                this.emit('client:disconnected', { ip: clientInfo.ip });
            });
            
            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.clients.delete(clientInfo);
            });
        });
        
        // Ping clients every 30 seconds
        this.pingInterval = setInterval(() => {
            this.clients.forEach((client) => {
                if (Date.now() - client.lastPing > 60000) {
                    // Client hasn't responded in 60 seconds
                    client.ws.terminate();
                    this.clients.delete(client);
                } else {
                    client.ws.ping();
                }
            });
        }, 30000);
    }

    startBroadcasting() {
        this.broadcastInterval = setInterval(() => {
            const metrics = this.prepareMetrics();
            this.broadcast({
                type: 'metrics',
                data: metrics,
                timestamp: Date.now()
            });
        }, this.options.broadcastInterval);
    }

    sendInitialData(ws) {
        // Send current metrics
        ws.send(JSON.stringify({
            type: 'metrics',
            data: this.metricsBuffer,
            timestamp: Date.now()
        }));
        
        // Send any active alerts
        if (this.options.alertManager) {
            const alerts = this.options.alertManager.getActiveAlerts();
            alerts.forEach(alert => {
                ws.send(JSON.stringify({
                    type: 'alert',
                    data: alert
                }));
            });
        }
    }

    handleClientMessage(client, message) {
        switch (message.type) {
            case 'subscribe':
                // Handle subscription to specific metrics
                client.subscriptions = message.metrics || ['all'];
                break;
                
            case 'query':
                // Handle historical data queries
                this.handleQuery(client, message.query);
                break;
                
            default:
                client.ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Unknown message type'
                }));
        }
    }

    updateMetrics(type, data) {
        switch (type) {
            case 'http':
                this.updateHttpMetrics(data);
                break;
            case 'database':
                this.updateDatabaseMetrics(data);
                break;
            case 'cache':
                this.updateCacheMetrics(data);
                break;
            case 'system':
                this.updateSystemMetrics(data);
                break;
            case 'mining':
                this.updateMiningMetrics(data);
                break;
            case 'dex':
                this.updateDexMetrics(data);
                break;
        }
    }

    updateHttpMetrics(data) {
        // Calculate request rate
        if (data.requestCount !== undefined) {
            const prevCount = this.previousMetrics.requestCount || 0;
            const timeDiff = (Date.now() - (this.previousMetrics.timestamp || Date.now() - 1000)) / 1000;
            this.metricsBuffer.requests.rate = (data.requestCount - prevCount) / timeDiff;
            this.previousMetrics.requestCount = data.requestCount;
        }
        
        // Update latency
        if (data.latency) {
            this.metricsBuffer.latency = {
                ...this.metricsBuffer.latency,
                ...data.latency
            };
        }
        
        // Update error rate
        if (data.errorRate !== undefined) {
            this.metricsBuffer.errors.rate = data.errorRate;
        }
        
        // Update connections
        if (data.activeConnections !== undefined) {
            this.metricsBuffer.connections.active = data.activeConnections;
        }
    }

    updateDatabaseMetrics(data) {
        if (data.queryTimes) {
            this.metricsBuffer.database = {
                select: data.queryTimes.select || 0,
                insert: data.queryTimes.insert || 0,
                update: data.queryTimes.update || 0,
                delete: data.queryTimes.delete || 0
            };
        }
    }

    updateCacheMetrics(data) {
        if (data.hitRate !== undefined) {
            this.metricsBuffer.cache.hitRate = data.hitRate;
        }
    }

    updateSystemMetrics(data) {
        if (data.memory) {
            this.metricsBuffer.memory.heapUsed = data.memory.heapUsed;
            const heapPercent = (data.memory.heapUsed / data.memory.heapTotal) * 100;
            this.metricsBuffer.system.memoryPercent = heapPercent;
        }
        
        if (data.cpu !== undefined) {
            this.metricsBuffer.system.cpuPercent = data.cpu;
        }
    }

    updateMiningMetrics(data) {
        if (data.hashrate !== undefined) {
            this.metricsBuffer.mining.hashrate = data.hashrate;
        }
        
        if (data.activeMiners !== undefined) {
            this.metricsBuffer.mining.activeMiners = data.activeMiners;
        }
    }

    updateDexMetrics(data) {
        if (data.volume) {
            this.metricsBuffer.dex.volume = data.volume;
        }
        
        if (data.trades !== undefined) {
            this.metricsBuffer.dex.trades = data.trades;
        }
    }

    prepareMetrics() {
        // Calculate changes
        const metrics = { ...this.metricsBuffer };
        
        // Request rate change
        if (this.previousMetrics.requestRate !== undefined) {
            const change = ((metrics.requests.rate - this.previousMetrics.requestRate) / 
                           (this.previousMetrics.requestRate || 1)) * 100;
            metrics.requests.change = change;
        }
        this.previousMetrics.requestRate = metrics.requests.rate;
        
        // Latency change
        if (this.previousMetrics.avgLatency !== undefined) {
            const change = ((metrics.latency.avg - this.previousMetrics.avgLatency) / 
                           (this.previousMetrics.avgLatency || 1)) * 100;
            metrics.latency.change = change;
        }
        this.previousMetrics.avgLatency = metrics.latency.avg;
        
        // Cache hit rate change
        if (this.previousMetrics.cacheHitRate !== undefined) {
            const change = metrics.cache.hitRate - this.previousMetrics.cacheHitRate;
            metrics.cache.change = change * 100; // Convert to percentage points
        }
        this.previousMetrics.cacheHitRate = metrics.cache.hitRate;
        
        // Memory change
        if (this.previousMetrics.heapUsed !== undefined) {
            const change = ((metrics.memory.heapUsed - this.previousMetrics.heapUsed) / 
                           (this.previousMetrics.heapUsed || 1)) * 100;
            metrics.memory.change = change;
        }
        this.previousMetrics.heapUsed = metrics.memory.heapUsed;
        
        this.previousMetrics.timestamp = Date.now();
        
        return metrics;
    }

    broadcast(message) {
        const data = JSON.stringify(message);
        
        this.clients.forEach((client) => {
            if (client.ws.readyState === 1) { // WebSocket.OPEN
                try {
                    client.ws.send(data);
                } catch (error) {
                    console.error('Failed to send to client:', error);
                }
            }
        });
    }

    broadcastAlert(alert) {
        this.broadcast({
            type: 'alert',
            data: {
                level: alert.level || 'warning',
                title: alert.title,
                message: alert.message,
                timestamp: alert.timestamp || Date.now()
            }
        });
    }

    async handleQuery(client, query) {
        // Handle historical data queries
        try {
            let result;
            
            switch (query.type) {
                case 'history':
                    result = await this.getHistoricalData(query.metric, query.range);
                    break;
                case 'summary':
                    result = await this.getSummaryData(query.period);
                    break;
                default:
                    throw new Error('Unknown query type');
            }
            
            client.ws.send(JSON.stringify({
                type: 'query-response',
                queryId: query.id,
                data: result
            }));
            
        } catch (error) {
            client.ws.send(JSON.stringify({
                type: 'query-error',
                queryId: query.id,
                error: error.message
            }));
        }
    }

    async getHistoricalData(metric, range) {
        // Implementation depends on your data storage
        // This is a placeholder
        return {
            metric,
            range,
            data: []
        };
    }

    async getSummaryData(period) {
        // Implementation depends on your data storage
        // This is a placeholder
        return {
            period,
            summary: {}
        };
    }

    // Integration with monitoring system
    connectToMonitoring(monitoringSystem) {
        // Subscribe to metric updates
        monitoringSystem.on('metrics:update', (data) => {
            this.updateMetrics(data.type, data.metrics);
        });
        
        // Subscribe to alerts
        monitoringSystem.on('alert:triggered', (alert) => {
            this.broadcastAlert(alert);
        });
    }

    // Connect to metrics collector
    connectToMetricsCollector() {
        // Periodically fetch metrics from collector
        setInterval(() => {
            if (this.metricsCollector) {
                const metrics = this.metricsCollector.getCurrentMetrics();
                
                // Update HTTP metrics
                if (metrics.http) {
                    this.updateMetrics('http', {
                        requestCount: metrics.http.totalRequests,
                        latency: {
                            avg: metrics.http.avgLatency,
                            p50: metrics.http.p50Latency,
                            p95: metrics.http.p95Latency,
                            p99: metrics.http.p99Latency
                        },
                        errorRate: metrics.http.errorRate,
                        activeConnections: metrics.http.activeConnections
                    });
                }
                
                // Update cache metrics
                if (metrics.cache) {
                    this.updateMetrics('cache', {
                        hitRate: metrics.cache.hitRate
                    });
                }
                
                // Update database metrics
                if (metrics.database) {
                    this.updateMetrics('database', {
                        queryTimes: metrics.database.queryTimes
                    });
                }
                
                // Update system metrics
                const memUsage = process.memoryUsage();
                this.updateMetrics('system', {
                    memory: {
                        heapUsed: memUsage.heapUsed,
                        heapTotal: memUsage.heapTotal
                    },
                    cpu: process.cpuUsage().user / 1000000 // Convert to percentage
                });
            }
        }, 1000);
    }

    // Cleanup
    async stop() {
        if (!this.started) return;
        
        if (this.broadcastInterval) {
            clearInterval(this.broadcastInterval);
        }
        
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
        
        // Close all connections
        this.clients.forEach(client => {
            client.ws.close(1001, 'Server shutting down');
        });
        
        if (this.wss) {
            this.wss.close();
        }
        
        this.removeAllListeners();
        this.started = false;
    }
    
    // Legacy alias
    shutdown() {
        return this.stop();
    }
}

export default MetricsWebSocketServer;