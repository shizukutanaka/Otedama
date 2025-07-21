/**
 * Performance Monitoring Dashboard
 * 
 * Advanced performance metrics collection and visualization
 * Following Carmack's performance-first principles
 */

import { EventEmitter } from 'events';
import { performance, PerformanceObserver } from 'perf_hooks';
import v8 from 'v8';
import { cpus, totalmem, freemem, loadavg } from 'os';
import { Worker } from 'worker_threads';
import { createHash } from 'crypto';

/**
 * Performance metric types
 */
export const MetricType = {
    COUNTER: 'counter',
    GAUGE: 'gauge',
    HISTOGRAM: 'histogram',
    SUMMARY: 'summary',
    TIMING: 'timing'
};

/**
 * Performance categories
 */
export const MetricCategory = {
    SYSTEM: 'system',
    DATABASE: 'database',
    API: 'api',
    WEBSOCKET: 'websocket',
    P2P: 'p2p',
    MINING: 'mining',
    TRADING: 'trading',
    CUSTOM: 'custom'
};

/**
 * Advanced Performance Dashboard
 */
export class PerformanceDashboard extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            // Collection intervals
            systemInterval: options.systemInterval || 1000,      // 1 second
            detailedInterval: options.detailedInterval || 5000,  // 5 seconds
            aggregateInterval: options.aggregateInterval || 60000, // 1 minute
            
            // History retention
            historySize: options.historySize || 3600,    // 1 hour of seconds
            aggregateSize: options.aggregateSize || 1440, // 24 hours of minutes
            
            // Performance thresholds
            thresholds: {
                cpuWarning: 70,
                cpuCritical: 90,
                memoryWarning: 80,
                memoryCritical: 95,
                responseTimeWarning: 1000,  // 1 second
                responseTimeCritical: 5000, // 5 seconds
                errorRateWarning: 0.05,     // 5%
                errorRateCritical: 0.10,    // 10%
                ...options.thresholds
            },
            
            // Features
            enableV8Profiling: options.enableV8Profiling !== false,
            enableGCTracking: options.enableGCTracking !== false,
            enableEventLoopMonitoring: options.enableEventLoopMonitoring !== false,
            enableHttpTracking: options.enableHttpTracking !== false,
            enableCustomMetrics: options.enableCustomMetrics !== false
        };
        
        // Metric storage
        this.metrics = new Map();
        this.history = new Map();
        this.aggregates = new Map();
        
        // Performance marks and measures
        this.marks = new Map();
        this.measures = new Map();
        
        // System metrics cache
        this.systemMetrics = {
            cpu: { usage: 0, cores: cpus().length },
            memory: { used: 0, total: totalmem() },
            eventLoop: { delay: 0, utilization: 0 },
            gc: { collections: 0, duration: 0, lastRun: 0 },
            handles: { active: 0, total: 0 },
            requests: { active: 0, total: 0 }
        };
        
        // Request tracking
        this.activeRequests = new Map();
        this.requestMetrics = {
            total: 0,
            success: 0,
            errors: 0,
            totalDuration: 0,
            histogram: new Array(20).fill(0) // 0-2000ms in 100ms buckets
        };
        
        // Database query tracking
        this.queryMetrics = {
            total: 0,
            success: 0,
            errors: 0,
            totalDuration: 0,
            slowQueries: [],
            queryTypes: new Map()
        };
        
        // WebSocket metrics
        this.wsMetrics = {
            connections: 0,
            messages: { sent: 0, received: 0 },
            errors: 0,
            bandwidth: { sent: 0, received: 0 }
        };
        
        // Custom metric definitions
        this.customMetrics = new Map();
        
        // Performance observer
        this.perfObserver = null;
        
        // Intervals
        this.intervals = {};
    }
    
    /**
     * Start performance monitoring
     */
    start() {
        console.log('Starting performance dashboard...');
        
        // Initialize performance observer
        if (this.config.enableGCTracking) {
            this.setupGCTracking();
        }
        
        if (this.config.enableEventLoopMonitoring) {
            this.setupEventLoopMonitoring();
        }
        
        // Start metric collection
        this.startSystemMetrics();
        this.startDetailedMetrics();
        this.startAggregation();
        
        // Initialize V8 profiling if enabled
        if (this.config.enableV8Profiling) {
            this.setupV8Profiling();
        }
        
        this.emit('started');
    }
    
    /**
     * Stop performance monitoring
     */
    stop() {
        // Clear intervals
        Object.values(this.intervals).forEach(interval => clearInterval(interval));
        this.intervals = {};
        
        // Stop observers
        if (this.perfObserver) {
            this.perfObserver.disconnect();
        }
        
        this.emit('stopped');
    }
    
    /**
     * Start system metrics collection
     */
    startSystemMetrics() {
        const previousCPU = process.cpuUsage();
        
        this.intervals.system = setInterval(() => {
            // CPU usage
            const currentCPU = process.cpuUsage(previousCPU);
            const cpuPercent = ((currentCPU.user + currentCPU.system) / 1000000) * 100 / this.systemMetrics.cpu.cores;
            this.systemMetrics.cpu.usage = cpuPercent;
            
            // Memory usage
            const memUsage = process.memoryUsage();
            this.systemMetrics.memory.used = memUsage.heapUsed;
            this.systemMetrics.memory.percent = (memUsage.heapUsed / this.systemMetrics.memory.total) * 100;
            
            // Record metrics
            this.recordMetric('system.cpu.usage', cpuPercent, MetricType.GAUGE);
            this.recordMetric('system.memory.used', memUsage.heapUsed, MetricType.GAUGE);
            this.recordMetric('system.memory.rss', memUsage.rss, MetricType.GAUGE);
            this.recordMetric('system.memory.external', memUsage.external, MetricType.GAUGE);
            
            // Check thresholds
            this.checkThresholds();
            
            // Emit update
            this.emit('metrics:system', this.systemMetrics);
            
        }, this.config.systemInterval);
    }
    
    /**
     * Start detailed metrics collection
     */
    startDetailedMetrics() {
        this.intervals.detailed = setInterval(() => {
            // V8 heap statistics
            if (this.config.enableV8Profiling) {
                const heapStats = v8.getHeapStatistics();
                this.recordMetric('v8.heap.total', heapStats.total_heap_size, MetricType.GAUGE);
                this.recordMetric('v8.heap.used', heapStats.used_heap_size, MetricType.GAUGE);
                this.recordMetric('v8.heap.limit', heapStats.heap_size_limit, MetricType.GAUGE);
                this.recordMetric('v8.heap.available', heapStats.total_available_size, MetricType.GAUGE);
                
                // Heap spaces
                const heapSpaces = v8.getHeapSpaceStatistics();
                heapSpaces.forEach(space => {
                    this.recordMetric(`v8.heap.space.${space.space_name}.size`, space.space_size, MetricType.GAUGE);
                    this.recordMetric(`v8.heap.space.${space.space_name}.used`, space.space_used_size, MetricType.GAUGE);
                });
            }
            
            // Active handles and requests
            if (process._getActiveHandles) {
                this.systemMetrics.handles.active = process._getActiveHandles().length;
                this.recordMetric('system.handles.active', this.systemMetrics.handles.active, MetricType.GAUGE);
            }
            
            if (process._getActiveRequests) {
                this.systemMetrics.requests.active = process._getActiveRequests().length;
                this.recordMetric('system.requests.active', this.systemMetrics.requests.active, MetricType.GAUGE);
            }
            
            // Load average (Unix-like systems)
            const load = loadavg();
            this.recordMetric('system.load.1m', load[0], MetricType.GAUGE);
            this.recordMetric('system.load.5m', load[1], MetricType.GAUGE);
            this.recordMetric('system.load.15m', load[2], MetricType.GAUGE);
            
            // Request metrics
            this.recordMetric('http.requests.total', this.requestMetrics.total, MetricType.COUNTER);
            this.recordMetric('http.requests.success', this.requestMetrics.success, MetricType.COUNTER);
            this.recordMetric('http.requests.errors', this.requestMetrics.errors, MetricType.COUNTER);
            
            if (this.requestMetrics.total > 0) {
                const avgDuration = this.requestMetrics.totalDuration / this.requestMetrics.total;
                this.recordMetric('http.requests.duration.avg', avgDuration, MetricType.GAUGE);
                
                const errorRate = this.requestMetrics.errors / this.requestMetrics.total;
                this.recordMetric('http.requests.error_rate', errorRate, MetricType.GAUGE);
            }
            
            this.emit('metrics:detailed', {
                v8: this.config.enableV8Profiling ? v8.getHeapStatistics() : null,
                handles: this.systemMetrics.handles,
                requests: this.systemMetrics.requests,
                http: this.requestMetrics,
                database: this.queryMetrics,
                websocket: this.wsMetrics
            });
            
        }, this.config.detailedInterval);
    }
    
    /**
     * Start metric aggregation
     */
    startAggregation() {
        this.intervals.aggregate = setInterval(() => {
            const now = Date.now();
            
            // Aggregate each metric
            for (const [name, metric] of this.metrics) {
                const history = this.history.get(name) || [];
                const aggregate = this.calculateAggregate(history);
                
                // Store aggregate
                let aggregates = this.aggregates.get(name) || [];
                aggregates.push({
                    timestamp: now,
                    ...aggregate
                });
                
                // Trim old aggregates
                if (aggregates.length > this.config.aggregateSize) {
                    aggregates = aggregates.slice(-this.config.aggregateSize);
                }
                
                this.aggregates.set(name, aggregates);
            }
            
            this.emit('metrics:aggregated', { timestamp: now });
            
        }, this.config.aggregateInterval);
    }
    
    /**
     * Setup GC tracking
     */
    setupGCTracking() {
        this.perfObserver = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            entries.forEach((entry) => {
                if (entry.kind === 'gc') {
                    this.systemMetrics.gc.collections++;
                    this.systemMetrics.gc.duration += entry.duration;
                    this.systemMetrics.gc.lastRun = Date.now();
                    
                    this.recordMetric('gc.collections', this.systemMetrics.gc.collections, MetricType.COUNTER);
                    this.recordMetric('gc.duration', entry.duration, MetricType.TIMING);
                    this.recordMetric('gc.type', entry.flags || 0, MetricType.GAUGE);
                    
                    this.emit('gc', {
                        duration: entry.duration,
                        type: entry.flags,
                        timestamp: Date.now()
                    });
                }
            });
        });
        
        this.perfObserver.observe({ entryTypes: ['gc'] });
    }
    
    /**
     * Setup event loop monitoring
     */
    setupEventLoopMonitoring() {
        let lastCheck = process.hrtime.bigint();
        
        const checkEventLoop = () => {
            const now = process.hrtime.bigint();
            const delay = Number(now - lastCheck) / 1000000; // Convert to ms
            lastCheck = now;
            
            // Expected delay is the interval (1ms)
            const actualDelay = Math.max(0, delay - 1);
            this.systemMetrics.eventLoop.delay = actualDelay;
            
            // Calculate utilization (rough estimate)
            const utilization = Math.min(100, (actualDelay / this.config.systemInterval) * 100);
            this.systemMetrics.eventLoop.utilization = utilization;
            
            this.recordMetric('eventloop.delay', actualDelay, MetricType.GAUGE);
            this.recordMetric('eventloop.utilization', utilization, MetricType.GAUGE);
            
            // Schedule next check
            setImmediate(checkEventLoop);
        };
        
        checkEventLoop();
    }
    
    /**
     * Setup V8 profiling
     */
    setupV8Profiling() {
        // Enable heap profiling
        if (v8.writeHeapSnapshot) {
            this.heapProfiler = {
                takeSnapshot: () => {
                    const filename = `heap-${Date.now()}.heapsnapshot`;
                    const path = v8.writeHeapSnapshot(filename);
                    this.emit('heap:snapshot', { path });
                    return path;
                }
            };
        }
        
        // Monitor heap allocation
        let lastHeapUsed = process.memoryUsage().heapUsed;
        this.intervals.heap = setInterval(() => {
            const currentHeapUsed = process.memoryUsage().heapUsed;
            const allocation = Math.max(0, currentHeapUsed - lastHeapUsed);
            lastHeapUsed = currentHeapUsed;
            
            this.recordMetric('v8.heap.allocation_rate', allocation, MetricType.GAUGE);
        }, 1000);
    }
    
    /**
     * Record a metric
     */
    recordMetric(name, value, type = MetricType.GAUGE, tags = {}) {
        const now = Date.now();
        
        // Get or create metric
        let metric = this.metrics.get(name);
        if (!metric) {
            metric = {
                name,
                type,
                tags,
                value: 0,
                count: 0,
                sum: 0,
                min: Infinity,
                max: -Infinity,
                lastUpdate: now
            };
            this.metrics.set(name, metric);
        }
        
        // Update metric based on type
        switch (type) {
            case MetricType.COUNTER:
                metric.value = value;
                metric.count = value;
                break;
                
            case MetricType.GAUGE:
                metric.value = value;
                metric.sum += value;
                metric.count++;
                metric.min = Math.min(metric.min, value);
                metric.max = Math.max(metric.max, value);
                break;
                
            case MetricType.TIMING:
            case MetricType.HISTOGRAM:
                metric.sum += value;
                metric.count++;
                metric.min = Math.min(metric.min, value);
                metric.max = Math.max(metric.max, value);
                metric.value = metric.sum / metric.count; // Average
                break;
        }
        
        metric.lastUpdate = now;
        
        // Add to history
        let history = this.history.get(name) || [];
        history.push({ timestamp: now, value });
        
        // Trim old history
        const cutoff = now - (this.config.historySize * 1000);
        history = history.filter(h => h.timestamp > cutoff);
        this.history.set(name, history);
    }
    
    /**
     * Start timing a operation
     */
    startTiming(name, tags = {}) {
        const id = `${name}-${Date.now()}-${Math.random()}`;
        this.marks.set(id, {
            name,
            tags,
            start: performance.now()
        });
        return id;
    }
    
    /**
     * End timing and record metric
     */
    endTiming(id) {
        const mark = this.marks.get(id);
        if (!mark) return;
        
        const duration = performance.now() - mark.start;
        this.marks.delete(id);
        
        this.recordMetric(`timing.${mark.name}`, duration, MetricType.TIMING, mark.tags);
        
        return duration;
    }
    
    /**
     * Track HTTP request
     */
    trackRequest(req, res) {
        const id = `${req.method}-${req.url}-${Date.now()}`;
        const start = performance.now();
        
        this.activeRequests.set(id, {
            method: req.method,
            url: req.url,
            start
        });
        
        // Track response
        const originalEnd = res.end;
        res.end = (...args) => {
            const duration = performance.now() - start;
            const request = this.activeRequests.get(id);
            
            if (request) {
                this.activeRequests.delete(id);
                
                // Update metrics
                this.requestMetrics.total++;
                this.requestMetrics.totalDuration += duration;
                
                if (res.statusCode >= 200 && res.statusCode < 400) {
                    this.requestMetrics.success++;
                } else {
                    this.requestMetrics.errors++;
                }
                
                // Update histogram
                const bucket = Math.min(Math.floor(duration / 100), 19);
                this.requestMetrics.histogram[bucket]++;
                
                // Record individual request metric
                this.recordMetric(`http.request.${req.method.toLowerCase()}`, duration, MetricType.TIMING, {
                    path: req.url,
                    status: res.statusCode
                });
            }
            
            originalEnd.apply(res, args);
        };
    }
    
    /**
     * Track database query
     */
    trackQuery(query, duration, success = true) {
        this.queryMetrics.total++;
        this.queryMetrics.totalDuration += duration;
        
        if (success) {
            this.queryMetrics.success++;
        } else {
            this.queryMetrics.errors++;
        }
        
        // Track query type
        const queryType = this.getQueryType(query);
        const typeMetrics = this.queryMetrics.queryTypes.get(queryType) || { count: 0, duration: 0 };
        typeMetrics.count++;
        typeMetrics.duration += duration;
        this.queryMetrics.queryTypes.set(queryType, typeMetrics);
        
        // Track slow queries
        if (duration > 1000) { // 1 second
            this.queryMetrics.slowQueries.push({
                query: query.substring(0, 100),
                duration,
                timestamp: Date.now()
            });
            
            // Keep only last 100 slow queries
            if (this.queryMetrics.slowQueries.length > 100) {
                this.queryMetrics.slowQueries = this.queryMetrics.slowQueries.slice(-100);
            }
        }
        
        this.recordMetric(`db.query.${queryType.toLowerCase()}`, duration, MetricType.TIMING);
    }
    
    /**
     * Track WebSocket metrics
     */
    trackWebSocket(event, data = {}) {
        switch (event) {
            case 'connection':
                this.wsMetrics.connections++;
                this.recordMetric('ws.connections', this.wsMetrics.connections, MetricType.GAUGE);
                break;
                
            case 'disconnection':
                this.wsMetrics.connections = Math.max(0, this.wsMetrics.connections - 1);
                this.recordMetric('ws.connections', this.wsMetrics.connections, MetricType.GAUGE);
                break;
                
            case 'message:sent':
                this.wsMetrics.messages.sent++;
                this.wsMetrics.bandwidth.sent += data.size || 0;
                this.recordMetric('ws.messages.sent', this.wsMetrics.messages.sent, MetricType.COUNTER);
                break;
                
            case 'message:received':
                this.wsMetrics.messages.received++;
                this.wsMetrics.bandwidth.received += data.size || 0;
                this.recordMetric('ws.messages.received', this.wsMetrics.messages.received, MetricType.COUNTER);
                break;
                
            case 'error':
                this.wsMetrics.errors++;
                this.recordMetric('ws.errors', this.wsMetrics.errors, MetricType.COUNTER);
                break;
        }
    }
    
    /**
     * Define custom metric
     */
    defineCustomMetric(name, type, description, unit = '') {
        this.customMetrics.set(name, {
            type,
            description,
            unit,
            created: Date.now()
        });
    }
    
    /**
     * Record custom metric
     */
    recordCustom(name, value, tags = {}) {
        const definition = this.customMetrics.get(name);
        if (!definition) {
            throw new Error(`Custom metric ${name} not defined`);
        }
        
        this.recordMetric(`custom.${name}`, value, definition.type, tags);
    }
    
    /**
     * Check performance thresholds
     */
    checkThresholds() {
        const alerts = [];
        
        // CPU threshold
        if (this.systemMetrics.cpu.usage > this.config.thresholds.cpuCritical) {
            alerts.push({
                level: 'critical',
                metric: 'cpu',
                value: this.systemMetrics.cpu.usage,
                threshold: this.config.thresholds.cpuCritical
            });
        } else if (this.systemMetrics.cpu.usage > this.config.thresholds.cpuWarning) {
            alerts.push({
                level: 'warning',
                metric: 'cpu',
                value: this.systemMetrics.cpu.usage,
                threshold: this.config.thresholds.cpuWarning
            });
        }
        
        // Memory threshold
        const memoryPercent = this.systemMetrics.memory.percent || 0;
        if (memoryPercent > this.config.thresholds.memoryCritical) {
            alerts.push({
                level: 'critical',
                metric: 'memory',
                value: memoryPercent,
                threshold: this.config.thresholds.memoryCritical
            });
        } else if (memoryPercent > this.config.thresholds.memoryWarning) {
            alerts.push({
                level: 'warning',
                metric: 'memory',
                value: memoryPercent,
                threshold: this.config.thresholds.memoryWarning
            });
        }
        
        // Response time threshold
        const avgResponseTime = this.requestMetrics.total > 0 ? 
            this.requestMetrics.totalDuration / this.requestMetrics.total : 0;
            
        if (avgResponseTime > this.config.thresholds.responseTimeCritical) {
            alerts.push({
                level: 'critical',
                metric: 'response_time',
                value: avgResponseTime,
                threshold: this.config.thresholds.responseTimeCritical
            });
        } else if (avgResponseTime > this.config.thresholds.responseTimeWarning) {
            alerts.push({
                level: 'warning',
                metric: 'response_time',
                value: avgResponseTime,
                threshold: this.config.thresholds.responseTimeWarning
            });
        }
        
        // Error rate threshold
        const errorRate = this.requestMetrics.total > 0 ?
            this.requestMetrics.errors / this.requestMetrics.total : 0;
            
        if (errorRate > this.config.thresholds.errorRateCritical) {
            alerts.push({
                level: 'critical',
                metric: 'error_rate',
                value: errorRate,
                threshold: this.config.thresholds.errorRateCritical
            });
        } else if (errorRate > this.config.thresholds.errorRateWarning) {
            alerts.push({
                level: 'warning',
                metric: 'error_rate',
                value: errorRate,
                threshold: this.config.thresholds.errorRateWarning
            });
        }
        
        // Emit alerts
        alerts.forEach(alert => {
            this.emit('threshold:exceeded', alert);
        });
    }
    
    /**
     * Calculate aggregate statistics
     */
    calculateAggregate(history) {
        if (history.length === 0) {
            return { avg: 0, min: 0, max: 0, sum: 0, count: 0 };
        }
        
        const values = history.map(h => h.value);
        const sum = values.reduce((a, b) => a + b, 0);
        
        return {
            avg: sum / values.length,
            min: Math.min(...values),
            max: Math.max(...values),
            sum,
            count: values.length,
            p50: this.percentile(values, 0.5),
            p95: this.percentile(values, 0.95),
            p99: this.percentile(values, 0.99)
        };
    }
    
    /**
     * Calculate percentile
     */
    percentile(values, p) {
        if (values.length === 0) return 0;
        
        const sorted = [...values].sort((a, b) => a - b);
        const index = Math.ceil(sorted.length * p) - 1;
        return sorted[Math.max(0, index)];
    }
    
    /**
     * Get query type from SQL
     */
    getQueryType(query) {
        const normalized = query.trim().toUpperCase();
        if (normalized.startsWith('SELECT')) return 'SELECT';
        if (normalized.startsWith('INSERT')) return 'INSERT';
        if (normalized.startsWith('UPDATE')) return 'UPDATE';
        if (normalized.startsWith('DELETE')) return 'DELETE';
        if (normalized.startsWith('CREATE')) return 'CREATE';
        if (normalized.startsWith('DROP')) return 'DROP';
        if (normalized.startsWith('ALTER')) return 'ALTER';
        return 'OTHER';
    }
    
    /**
     * Get current metrics snapshot
     */
    getSnapshot() {
        const metrics = {};
        
        for (const [name, metric] of this.metrics) {
            metrics[name] = {
                ...metric,
                history: this.history.get(name) || [],
                aggregates: this.aggregates.get(name) || []
            };
        }
        
        return {
            timestamp: Date.now(),
            system: this.systemMetrics,
            http: this.requestMetrics,
            database: this.queryMetrics,
            websocket: this.wsMetrics,
            metrics,
            custom: Array.from(this.customMetrics.entries())
        };
    }
    
    /**
     * Export metrics in Prometheus format
     */
    exportPrometheus() {
        const lines = [];
        
        for (const [name, metric] of this.metrics) {
            const metricName = name.replace(/\./g, '_');
            
            // Add HELP and TYPE comments
            lines.push(`# HELP ${metricName} ${metric.type}`);
            lines.push(`# TYPE ${metricName} ${metric.type.toLowerCase()}`);
            
            // Add metric value
            const labels = Object.entries(metric.tags || {})
                .map(([k, v]) => `${k}="${v}"`)
                .join(',');
                
            const labelStr = labels ? `{${labels}}` : '';
            lines.push(`${metricName}${labelStr} ${metric.value}`);
            
            // Add additional metrics for summaries
            if (metric.type === MetricType.SUMMARY || metric.type === MetricType.HISTOGRAM) {
                lines.push(`${metricName}_sum${labelStr} ${metric.sum}`);
                lines.push(`${metricName}_count${labelStr} ${metric.count}`);
                lines.push(`${metricName}_min${labelStr} ${metric.min}`);
                lines.push(`${metricName}_max${labelStr} ${metric.max}`);
            }
        }
        
        return lines.join('\n');
    }
    
    /**
     * Generate performance report
     */
    generateReport() {
        const snapshot = this.getSnapshot();
        const report = {
            summary: {
                uptime: process.uptime(),
                timestamp: snapshot.timestamp,
                cpu: {
                    usage: snapshot.system.cpu.usage.toFixed(2) + '%',
                    cores: snapshot.system.cpu.cores
                },
                memory: {
                    used: (snapshot.system.memory.used / 1024 / 1024).toFixed(2) + ' MB',
                    percent: snapshot.system.memory.percent?.toFixed(2) + '%'
                },
                requests: {
                    total: snapshot.http.total,
                    success_rate: snapshot.http.total > 0 ? 
                        ((snapshot.http.success / snapshot.http.total) * 100).toFixed(2) + '%' : 'N/A',
                    avg_duration: snapshot.http.total > 0 ?
                        (snapshot.http.totalDuration / snapshot.http.total).toFixed(2) + ' ms' : 'N/A'
                }
            },
            alerts: [],
            recommendations: []
        };
        
        // Add alerts based on current state
        if (snapshot.system.cpu.usage > this.config.thresholds.cpuWarning) {
            report.alerts.push(`High CPU usage: ${snapshot.system.cpu.usage.toFixed(2)}%`);
        }
        
        if (snapshot.system.memory.percent > this.config.thresholds.memoryWarning) {
            report.alerts.push(`High memory usage: ${snapshot.system.memory.percent.toFixed(2)}%`);
        }
        
        // Add recommendations
        if (snapshot.system.eventLoop.delay > 10) {
            report.recommendations.push('Consider optimizing event loop blocking operations');
        }
        
        if (snapshot.database.slowQueries.length > 10) {
            report.recommendations.push('Review and optimize slow database queries');
        }
        
        if (snapshot.http.errors > snapshot.http.success * 0.1) {
            report.recommendations.push('High error rate detected - investigate error logs');
        }
        
        return report;
    }
}

export default PerformanceDashboard;