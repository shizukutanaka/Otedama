const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');
const v8 = require('v8');
const os = require('os');

/**
 * Performance Optimizer
 * Real-time performance monitoring and automatic optimization
 */
class PerformanceOptimizer extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            // Monitoring intervals
            monitoringInterval: config.monitoringInterval || 5000, // 5 seconds
            metricsRetention: config.metricsRetention || 3600000, // 1 hour
            
            // Performance thresholds
            cpuThreshold: config.cpuThreshold || 80, // 80%
            memoryThreshold: config.memoryThreshold || 85, // 85%
            eventLoopThreshold: config.eventLoopThreshold || 100, // 100ms
            gcThreshold: config.gcThreshold || 50, // 50ms
            
            // Optimization settings
            autoOptimize: config.autoOptimize !== false,
            gcOptimization: config.gcOptimization !== false,
            connectionPooling: config.connectionPooling !== false,
            cacheOptimization: config.cacheOptimization !== false,
            
            // Resource limits
            maxWorkers: config.maxWorkers || os.cpus().length,
            maxMemory: config.maxMemory || os.totalmem() * 0.8,
            maxConnections: config.maxConnections || 10000,
            
            ...config
        };
        
        // Metrics storage
        this.metrics = {
            cpu: [],
            memory: [],
            eventLoop: [],
            gc: [],
            requests: [],
            custom: new Map()
        };
        
        // Performance marks
        this.marks = new Map();
        this.measures = new Map();
        
        // Optimization state
        this.optimizations = {
            gcScheduled: false,
            cacheCleared: false,
            connectionsReduced: false,
            workersAdjusted: false
        };
        
        // Start monitoring
        this.startMonitoring();
    }
    
    // Start performance monitoring
    startMonitoring() {
        // CPU and memory monitoring
        this.monitoringTimer = setInterval(() => {
            this.collectMetrics();
            this.analyzePerformance();
            
            if (this.config.autoOptimize) {
                this.performOptimizations();
            }
        }, this.config.monitoringInterval);
        
        // Event loop monitoring
        this.monitorEventLoop();
        
        // GC monitoring
        if (this.config.gcOptimization) {
            this.monitorGC();
        }
        
        // Cleanup old metrics
        setInterval(() => {
            this.cleanupMetrics();
        }, 60000);
    }
    
    // Collect system metrics
    collectMetrics() {
        const timestamp = Date.now();
        
        // CPU usage
        const cpuUsage = process.cpuUsage();
        const cpuPercent = this.calculateCPUPercentage(cpuUsage);
        this.metrics.cpu.push({ timestamp, value: cpuPercent });
        
        // Memory usage
        const memUsage = process.memoryUsage();
        const memPercent = (memUsage.heapUsed / this.config.maxMemory) * 100;
        this.metrics.memory.push({
            timestamp,
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
            rss: memUsage.rss,
            external: memUsage.external,
            arrayBuffers: memUsage.arrayBuffers,
            percent: memPercent
        });
        
        // V8 heap statistics
        const heapStats = v8.getHeapStatistics();
        this.emit('heap-stats', {
            totalHeapSize: heapStats.total_heap_size,
            usedHeapSize: heapStats.used_heap_size,
            heapSizeLimit: heapStats.heap_size_limit,
            mallocedMemory: heapStats.malloced_memory,
            peakMallocedMemory: heapStats.peak_malloced_memory
        });
    }
    
    // Calculate CPU percentage
    calculateCPUPercentage(usage) {
        if (!this.lastCPUUsage) {
            this.lastCPUUsage = usage;
            this.lastCPUTime = Date.now();
            return 0;
        }
        
        const timeDelta = Date.now() - this.lastCPUTime;
        const userDelta = usage.user - this.lastCPUUsage.user;
        const systemDelta = usage.system - this.lastCPUUsage.system;
        
        const totalDelta = userDelta + systemDelta;
        const percentage = (totalDelta / (timeDelta * 1000)) * 100;
        
        this.lastCPUUsage = usage;
        this.lastCPUTime = Date.now();
        
        return Math.min(100, percentage);
    }
    
    // Monitor event loop lag
    monitorEventLoop() {
        let lastCheck = Date.now();
        
        const checkLoop = () => {
            const now = Date.now();
            const delay = now - lastCheck - this.config.monitoringInterval;
            
            if (delay > 0) {
                this.metrics.eventLoop.push({
                    timestamp: now,
                    delay: delay
                });
                
                if (delay > this.config.eventLoopThreshold) {
                    this.emit('event-loop-blocked', { delay });
                }
            }
            
            lastCheck = now;
        };
        
        this.eventLoopTimer = setInterval(checkLoop, this.config.monitoringInterval);
    }
    
    // Monitor garbage collection
    monitorGC() {
        try {
            const obs = new PerformanceObserver((list) => {
                const entries = list.getEntries();
                
                for (const entry of entries) {
                    this.metrics.gc.push({
                        timestamp: Date.now(),
                        duration: entry.duration,
                        type: entry.detail ? entry.detail.kind : 'unknown'
                    });
                    
                    if (entry.duration > this.config.gcThreshold) {
                        this.emit('gc-slow', {
                            duration: entry.duration,
                            type: entry.detail ? entry.detail.kind : 'unknown'
                        });
                    }
                }
            });
            
            obs.observe({ entryTypes: ['gc'] });
        } catch (error) {
            // GC monitoring not available
            console.warn('GC monitoring not available:', error.message);
        }
    }
    
    // Analyze performance metrics
    analyzePerformance() {
        const analysis = {
            cpu: this.analyzeMetric(this.metrics.cpu, 'value'),
            memory: this.analyzeMetric(this.metrics.memory, 'percent'),
            eventLoop: this.analyzeMetric(this.metrics.eventLoop, 'delay'),
            gc: this.analyzeMetric(this.metrics.gc, 'duration')
        };
        
        // Check for performance issues
        const issues = [];
        
        if (analysis.cpu.current > this.config.cpuThreshold) {
            issues.push({
                type: 'cpu',
                severity: 'high',
                message: `CPU usage high: ${analysis.cpu.current.toFixed(2)}%`
            });
        }
        
        if (analysis.memory.current > this.config.memoryThreshold) {
            issues.push({
                type: 'memory',
                severity: 'high',
                message: `Memory usage high: ${analysis.memory.current.toFixed(2)}%`
            });
        }
        
        if (analysis.eventLoop.avg > this.config.eventLoopThreshold) {
            issues.push({
                type: 'eventLoop',
                severity: 'medium',
                message: `Event loop lag: ${analysis.eventLoop.avg.toFixed(2)}ms`
            });
        }
        
        if (issues.length > 0) {
            this.emit('performance-issues', issues);
        }
        
        this.lastAnalysis = analysis;
        return analysis;
    }
    
    // Analyze a specific metric
    analyzeMetric(data, field) {
        if (data.length === 0) {
            return { current: 0, avg: 0, max: 0, min: 0 };
        }
        
        const values = data.map(d => d[field] || 0);
        const current = values[values.length - 1];
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const max = Math.max(...values);
        const min = Math.min(...values);
        
        return { current, avg, max, min };
    }
    
    // Perform automatic optimizations
    performOptimizations() {
        if (!this.lastAnalysis) return;
        
        // Memory optimization
        if (this.lastAnalysis.memory.current > this.config.memoryThreshold) {
            this.optimizeMemory();
        }
        
        // CPU optimization
        if (this.lastAnalysis.cpu.current > this.config.cpuThreshold) {
            this.optimizeCPU();
        }
        
        // Event loop optimization
        if (this.lastAnalysis.eventLoop.avg > this.config.eventLoopThreshold) {
            this.optimizeEventLoop();
        }
    }
    
    // Memory optimization
    optimizeMemory() {
        if (this.optimizations.gcScheduled) return;
        
        this.optimizations.gcScheduled = true;
        
        // Schedule garbage collection
        setImmediate(() => {
            if (global.gc) {
                const before = process.memoryUsage().heapUsed;
                global.gc();
                const after = process.memoryUsage().heapUsed;
                
                this.emit('gc-performed', {
                    freed: before - after,
                    before,
                    after
                });
            }
            
            this.optimizations.gcScheduled = false;
        });
        
        // Clear caches if needed
        if (!this.optimizations.cacheCleared && this.lastAnalysis.memory.current > 90) {
            this.emit('clear-caches');
            this.optimizations.cacheCleared = true;
            
            setTimeout(() => {
                this.optimizations.cacheCleared = false;
            }, 300000); // 5 minutes
        }
    }
    
    // CPU optimization
    optimizeCPU() {
        // Reduce worker processes if CPU is too high
        if (!this.optimizations.workersAdjusted) {
            const currentWorkers = this.getCurrentWorkerCount();
            const targetWorkers = Math.max(1, Math.floor(currentWorkers * 0.8));
            
            if (targetWorkers < currentWorkers) {
                this.emit('adjust-workers', { 
                    current: currentWorkers, 
                    target: targetWorkers 
                });
                
                this.optimizations.workersAdjusted = true;
                setTimeout(() => {
                    this.optimizations.workersAdjusted = false;
                }, 60000); // 1 minute
            }
        }
    }
    
    // Event loop optimization
    optimizeEventLoop() {
        // Reduce concurrent operations
        if (!this.optimizations.connectionsReduced) {
            this.emit('reduce-connections', {
                reason: 'event_loop_lag',
                reduction: 0.8
            });
            
            this.optimizations.connectionsReduced = true;
            setTimeout(() => {
                this.optimizations.connectionsReduced = false;
            }, 30000); // 30 seconds
        }
    }
    
    // Performance measurement API
    mark(name) {
        this.marks.set(name, performance.now());
    }
    
    measure(name, startMark, endMark = null) {
        const start = this.marks.get(startMark);
        if (!start) {
            throw new Error(`Start mark '${startMark}' not found`);
        }
        
        const end = endMark ? this.marks.get(endMark) : performance.now();
        const duration = end - start;
        
        let measures = this.measures.get(name);
        if (!measures) {
            measures = [];
            this.measures.set(name, measures);
        }
        
        measures.push({
            timestamp: Date.now(),
            duration,
            start,
            end
        });
        
        // Keep only recent measures
        if (measures.length > 1000) {
            measures.shift();
        }
        
        return duration;
    }
    
    // Get performance report
    getReport() {
        const report = {
            timestamp: Date.now(),
            uptime: process.uptime(),
            metrics: {},
            measures: {},
            system: {
                platform: os.platform(),
                arch: os.arch(),
                cpus: os.cpus().length,
                totalMemory: os.totalmem(),
                freeMemory: os.freemem(),
                loadAverage: os.loadavg()
            },
            process: {
                pid: process.pid,
                version: process.version,
                memoryUsage: process.memoryUsage(),
                cpuUsage: process.cpuUsage()
            }
        };
        
        // Add analyzed metrics
        if (this.lastAnalysis) {
            report.metrics = this.lastAnalysis;
        }
        
        // Add custom measures
        for (const [name, measures] of this.measures) {
            const durations = measures.map(m => m.duration);
            report.measures[name] = {
                count: measures.length,
                avg: durations.reduce((a, b) => a + b, 0) / durations.length,
                min: Math.min(...durations),
                max: Math.max(...durations),
                p50: this.percentile(durations, 50),
                p95: this.percentile(durations, 95),
                p99: this.percentile(durations, 99)
            };
        }
        
        return report;
    }
    
    // Calculate percentile
    percentile(arr, p) {
        if (arr.length === 0) return 0;
        
        const sorted = arr.slice().sort((a, b) => a - b);
        const index = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, index)];
    }
    
    // Custom metric tracking
    trackMetric(name, value, tags = {}) {
        let metric = this.metrics.custom.get(name);
        if (!metric) {
            metric = [];
            this.metrics.custom.set(name, metric);
        }
        
        metric.push({
            timestamp: Date.now(),
            value,
            tags
        });
        
        // Keep only recent metrics
        if (metric.length > 10000) {
            metric.shift();
        }
    }
    
    // Get custom metric stats
    getMetricStats(name) {
        const metric = this.metrics.custom.get(name);
        if (!metric || metric.length === 0) {
            return null;
        }
        
        const values = metric.map(m => m.value);
        return {
            count: values.length,
            current: values[values.length - 1],
            avg: values.reduce((a, b) => a + b, 0) / values.length,
            min: Math.min(...values),
            max: Math.max(...values),
            p50: this.percentile(values, 50),
            p95: this.percentile(values, 95),
            p99: this.percentile(values, 99)
        };
    }
    
    // Cleanup old metrics
    cleanupMetrics() {
        const cutoff = Date.now() - this.config.metricsRetention;
        
        // Clean built-in metrics
        for (const key of Object.keys(this.metrics)) {
            if (Array.isArray(this.metrics[key])) {
                this.metrics[key] = this.metrics[key].filter(m => m.timestamp > cutoff);
            }
        }
        
        // Clean custom metrics
        for (const [name, data] of this.metrics.custom) {
            const filtered = data.filter(m => m.timestamp > cutoff);
            if (filtered.length === 0) {
                this.metrics.custom.delete(name);
            } else {
                this.metrics.custom.set(name, filtered);
            }
        }
    }
    
    // Get current worker count (stub - should be implemented by app)
    getCurrentWorkerCount() {
        return this.config.maxWorkers;
    }
    
    // Express middleware for request tracking
    middleware() {
        return (req, res, next) => {
            const start = performance.now();
            
            // Track request start
            this.mark(`request-${req.id || Date.now()}`);
            
            // Override res.end to track completion
            const originalEnd = res.end;
            res.end = (...args) => {
                const duration = performance.now() - start;
                
                this.metrics.requests.push({
                    timestamp: Date.now(),
                    method: req.method,
                    path: req.path,
                    statusCode: res.statusCode,
                    duration
                });
                
                // Track by endpoint
                this.trackMetric(`request.${req.method}.${req.path}`, duration, {
                    statusCode: res.statusCode
                });
                
                originalEnd.apply(res, args);
            };
            
            next();
        };
    }
    
    // Shutdown
    shutdown() {
        if (this.monitoringTimer) {
            clearInterval(this.monitoringTimer);
        }
        if (this.eventLoopTimer) {
            clearInterval(this.eventLoopTimer);
        }
        
        this.removeAllListeners();
    }
}

/**
 * Database query optimizer
 */
class QueryOptimizer {
    constructor() {
        this.queryCache = new Map();
        this.queryStats = new Map();
        this.slowQueryThreshold = 100; // 100ms
    }
    
    // Optimize query
    optimize(query, params = []) {
        const key = this.getQueryKey(query, params);
        
        // Check cache
        const cached = this.queryCache.get(key);
        if (cached && Date.now() - cached.timestamp < 60000) {
            return cached.optimized;
        }
        
        // Apply optimizations
        let optimized = query;
        
        // Remove unnecessary whitespace
        optimized = optimized.replace(/\s+/g, ' ').trim();
        
        // Add index hints for common patterns
        optimized = this.addIndexHints(optimized);
        
        // Optimize JOINs
        optimized = this.optimizeJoins(optimized);
        
        // Cache result
        this.queryCache.set(key, {
            original: query,
            optimized,
            timestamp: Date.now()
        });
        
        return optimized;
    }
    
    // Track query execution
    trackExecution(query, duration, rowCount) {
        const key = this.getQueryKey(query);
        
        let stats = this.queryStats.get(key);
        if (!stats) {
            stats = {
                count: 0,
                totalDuration: 0,
                avgDuration: 0,
                minDuration: Infinity,
                maxDuration: 0,
                avgRows: 0
            };
            this.queryStats.set(key, stats);
        }
        
        stats.count++;
        stats.totalDuration += duration;
        stats.avgDuration = stats.totalDuration / stats.count;
        stats.minDuration = Math.min(stats.minDuration, duration);
        stats.maxDuration = Math.max(stats.maxDuration, duration);
        stats.avgRows = ((stats.avgRows * (stats.count - 1)) + rowCount) / stats.count;
        
        // Check for slow queries
        if (duration > this.slowQueryThreshold) {
            this.handleSlowQuery(query, duration, stats);
        }
    }
    
    // Get query key for caching
    getQueryKey(query, params = []) {
        return `${query}:${JSON.stringify(params)}`;
    }
    
    // Add index hints
    addIndexHints(query) {
        // Example: Add index hints for common patterns
        if (query.includes('WHERE miner_id') && !query.includes('USE INDEX')) {
            query = query.replace('FROM shares', 'FROM shares USE INDEX (idx_miner_id)');
        }
        
        return query;
    }
    
    // Optimize JOINs
    optimizeJoins(query) {
        // Put smaller tables first in JOINs
        // This is a simplified example
        return query;
    }
    
    // Handle slow queries
    handleSlowQuery(query, duration, stats) {
        console.warn('Slow query detected:', {
            query: query.substring(0, 100) + '...',
            duration,
            avgDuration: stats.avgDuration,
            executionCount: stats.count
        });
    }
    
    // Get optimization suggestions
    getSuggestions() {
        const suggestions = [];
        
        for (const [query, stats] of this.queryStats) {
            if (stats.avgDuration > this.slowQueryThreshold) {
                suggestions.push({
                    query: query.substring(0, 100) + '...',
                    avgDuration: stats.avgDuration,
                    count: stats.count,
                    suggestion: this.generateSuggestion(query, stats)
                });
            }
        }
        
        return suggestions;
    }
    
    // Generate optimization suggestion
    generateSuggestion(query, stats) {
        const suggestions = [];
        
        if (!query.includes('LIMIT') && stats.avgRows > 1000) {
            suggestions.push('Consider adding LIMIT clause');
        }
        
        if (query.includes('SELECT *')) {
            suggestions.push('Select only needed columns instead of *');
        }
        
        if (query.includes('NOT IN') || query.includes('!=')) {
            suggestions.push('Consider using indexed columns for negative conditions');
        }
        
        return suggestions.join('; ');
    }
}

module.exports = {
    PerformanceOptimizer,
    QueryOptimizer
};