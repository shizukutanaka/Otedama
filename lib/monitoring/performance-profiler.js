const { EventEmitter } = require('events');
const { performance, PerformanceObserver } = require('perf_hooks');
const v8 = require('v8');
const async_hooks = require('async_hooks');

class PerformanceProfiler extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            sampleInterval: options.sampleInterval || 100,
            cpuProfileDuration: options.cpuProfileDuration || 10000,
            heapSnapshotInterval: options.heapSnapshotInterval || 300000,
            enableAsyncHooks: options.enableAsyncHooks !== false,
            enableSourceMaps: options.enableSourceMaps !== false,
            ...options
        };
        
        this.profiles = new Map();
        this.metrics = new Map();
        this.asyncOperations = new Map();
        this.functionTimings = new Map();
        this.memorySnapshots = [];
        
        this.isProfileing = false;
        this.observers = new Map();
    }

    async initialize() {
        this.setupPerformanceObservers();
        
        if (this.config.enableAsyncHooks) {
            this.setupAsyncHooks();
        }
        
        this.startMetricsCollection();
        
        this.emit('initialized');
    }

    setupPerformanceObservers() {
        // Observe various performance entries
        const obs = new PerformanceObserver((items) => {
            items.getEntries().forEach((entry) => {
                this.processPerformanceEntry(entry);
            });
        });
        
        obs.observe({ 
            entryTypes: ['measure', 'mark', 'function', 'gc', 'http', 'dns'] 
        });
        
        this.observers.set('main', obs);
    }

    processPerformanceEntry(entry) {
        const type = entry.entryType;
        const name = entry.name;
        const duration = entry.duration;
        
        if (!this.metrics.has(type)) {
            this.metrics.set(type, new Map());
        }
        
        const typeMetrics = this.metrics.get(type);
        
        if (!typeMetrics.has(name)) {
            typeMetrics.set(name, {
                count: 0,
                totalDuration: 0,
                minDuration: Infinity,
                maxDuration: -Infinity,
                avgDuration: 0,
                p50: 0,
                p95: 0,
                p99: 0,
                samples: []
            });
        }
        
        const metric = typeMetrics.get(name);
        metric.count++;
        metric.totalDuration += duration;
        metric.minDuration = Math.min(metric.minDuration, duration);
        metric.maxDuration = Math.max(metric.maxDuration, duration);
        metric.avgDuration = metric.totalDuration / metric.count;
        
        // Store samples for percentile calculation
        metric.samples.push(duration);
        if (metric.samples.length > 1000) {
            metric.samples.shift();
        }
        
        // Calculate percentiles
        this.updatePercentiles(metric);
        
        this.emit('performance:entry', {
            type,
            name,
            duration,
            timestamp: entry.startTime
        });
    }

    updatePercentiles(metric) {
        const sorted = [...metric.samples].sort((a, b) => a - b);
        const len = sorted.length;
        
        metric.p50 = sorted[Math.floor(len * 0.5)];
        metric.p95 = sorted[Math.floor(len * 0.95)];
        metric.p99 = sorted[Math.floor(len * 0.99)];
    }

    setupAsyncHooks() {
        const asyncHook = async_hooks.createHook({
            init: (asyncId, type, triggerAsyncId) => {
                this.asyncOperations.set(asyncId, {
                    type,
                    triggerAsyncId,
                    startTime: performance.now(),
                    state: 'init'
                });
            },
            
            before: (asyncId) => {
                const op = this.asyncOperations.get(asyncId);
                if (op) {
                    op.state = 'before';
                    op.beforeTime = performance.now();
                }
            },
            
            after: (asyncId) => {
                const op = this.asyncOperations.get(asyncId);
                if (op && op.beforeTime) {
                    op.state = 'after';
                    op.duration = performance.now() - op.beforeTime;
                    
                    this.trackAsyncOperation(op);
                }
            },
            
            destroy: (asyncId) => {
                this.asyncOperations.delete(asyncId);
            }
        });
        
        asyncHook.enable();
        this.asyncHook = asyncHook;
    }

    trackAsyncOperation(op) {
        const key = op.type;
        
        if (!this.metrics.has('async')) {
            this.metrics.set('async', new Map());
        }
        
        const asyncMetrics = this.metrics.get('async');
        
        if (!asyncMetrics.has(key)) {
            asyncMetrics.set(key, {
                count: 0,
                totalDuration: 0,
                avgDuration: 0,
                concurrent: 0,
                maxConcurrent: 0
            });
        }
        
        const metric = asyncMetrics.get(key);
        metric.count++;
        metric.totalDuration += op.duration;
        metric.avgDuration = metric.totalDuration / metric.count;
        
        // Track concurrent operations
        const concurrent = Array.from(this.asyncOperations.values())
            .filter(o => o.type === op.type && o.state === 'before').length;
        
        metric.concurrent = concurrent;
        metric.maxConcurrent = Math.max(metric.maxConcurrent, concurrent);
    }

    startMetricsCollection() {
        this.metricsInterval = setInterval(() => {
            this.collectCPUMetrics();
            this.collectMemoryMetrics();
            this.collectEventLoopMetrics();
        }, this.config.sampleInterval);
    }

    collectCPUMetrics() {
        const startUsage = process.cpuUsage();
        
        setTimeout(() => {
            const endUsage = process.cpuUsage(startUsage);
            const totalCPU = endUsage.user + endUsage.system;
            const cpuPercent = (totalCPU / 1000) / this.config.sampleInterval * 100;
            
            if (!this.metrics.has('cpu')) {
                this.metrics.set('cpu', {
                    samples: [],
                    current: 0,
                    avg: 0,
                    max: 0
                });
            }
            
            const cpuMetric = this.metrics.get('cpu');
            cpuMetric.current = cpuPercent;
            cpuMetric.samples.push({ timestamp: Date.now(), value: cpuPercent });
            
            // Keep last hour
            const cutoff = Date.now() - 3600000;
            cpuMetric.samples = cpuMetric.samples.filter(s => s.timestamp > cutoff);
            
            // Update aggregates
            const values = cpuMetric.samples.map(s => s.value);
            cpuMetric.avg = values.reduce((a, b) => a + b, 0) / values.length;
            cpuMetric.max = Math.max(...values);
            
        }, this.config.sampleInterval);
    }

    collectMemoryMetrics() {
        const memUsage = process.memoryUsage();
        const heapStats = v8.getHeapStatistics();
        
        if (!this.metrics.has('memory')) {
            this.metrics.set('memory', {
                heap: { samples: [], current: {} },
                external: { samples: [], current: 0 },
                gc: { count: 0, duration: 0, lastRun: 0 }
            });
        }
        
        const memMetric = this.metrics.get('memory');
        
        // Heap metrics
        memMetric.heap.current = {
            used: memUsage.heapUsed,
            total: memUsage.heapTotal,
            limit: heapStats.heap_size_limit,
            percent: memUsage.heapUsed / heapStats.heap_size_limit * 100
        };
        
        memMetric.heap.samples.push({
            timestamp: Date.now(),
            ...memMetric.heap.current
        });
        
        // External memory
        memMetric.external.current = memUsage.external;
        memMetric.external.samples.push({
            timestamp: Date.now(),
            value: memUsage.external
        });
        
        // Keep last hour
        const cutoff = Date.now() - 3600000;
        memMetric.heap.samples = memMetric.heap.samples.filter(s => s.timestamp > cutoff);
        memMetric.external.samples = memMetric.external.samples.filter(s => s.timestamp > cutoff);
    }

    collectEventLoopMetrics() {
        const start = performance.now();
        
        setImmediate(() => {
            const delay = performance.now() - start;
            
            if (!this.metrics.has('eventLoop')) {
                this.metrics.set('eventLoop', {
                    delays: [],
                    current: 0,
                    avg: 0,
                    max: 0,
                    blocked: false
                });
            }
            
            const elMetric = this.metrics.get('eventLoop');
            elMetric.current = delay;
            elMetric.delays.push({ timestamp: Date.now(), value: delay });
            
            // Keep last 1000 samples
            if (elMetric.delays.length > 1000) {
                elMetric.delays.shift();
            }
            
            // Update aggregates
            const values = elMetric.delays.map(d => d.value);
            elMetric.avg = values.reduce((a, b) => a + b, 0) / values.length;
            elMetric.max = Math.max(...values);
            elMetric.blocked = delay > 50; // Consider blocked if > 50ms
            
            if (elMetric.blocked) {
                this.emit('eventloop:blocked', { delay });
            }
        });
    }

    profile(name, fn) {
        return async (...args) => {
            const start = performance.now();
            const startMem = process.memoryUsage().heapUsed;
            
            try {
                const result = await fn(...args);
                
                const duration = performance.now() - start;
                const memDelta = process.memoryUsage().heapUsed - startMem;
                
                this.recordFunctionTiming(name, duration, memDelta);
                
                return result;
                
            } catch (error) {
                const duration = performance.now() - start;
                this.recordFunctionTiming(name, duration, 0, true);
                throw error;
            }
        };
    }

    recordFunctionTiming(name, duration, memoryDelta, isError = false) {
        if (!this.functionTimings.has(name)) {
            this.functionTimings.set(name, {
                count: 0,
                errors: 0,
                totalDuration: 0,
                avgDuration: 0,
                minDuration: Infinity,
                maxDuration: -Infinity,
                totalMemoryDelta: 0,
                avgMemoryDelta: 0,
                samples: []
            });
        }
        
        const timing = this.functionTimings.get(name);
        timing.count++;
        if (isError) timing.errors++;
        
        timing.totalDuration += duration;
        timing.avgDuration = timing.totalDuration / timing.count;
        timing.minDuration = Math.min(timing.minDuration, duration);
        timing.maxDuration = Math.max(timing.maxDuration, duration);
        
        timing.totalMemoryDelta += memoryDelta;
        timing.avgMemoryDelta = timing.totalMemoryDelta / timing.count;
        
        timing.samples.push({
            timestamp: Date.now(),
            duration,
            memoryDelta,
            isError
        });
        
        // Keep last 100 samples
        if (timing.samples.length > 100) {
            timing.samples.shift();
        }
        
        performance.measure(`function:${name}`, {
            start: performance.now() - duration,
            duration
        });
    }

    async startCPUProfile(name = 'cpu-profile') {
        if (this.isProfileing) {
            throw new Error('Already profiling');
        }
        
        this.isProfileing = true;
        const profile = {
            name,
            startTime: Date.now(),
            samples: []
        };
        
        this.profiles.set(name, profile);
        
        // Simulate CPU profiling (real implementation would use V8 profiler)
        const interval = setInterval(() => {
            const sample = {
                timestamp: Date.now(),
                stack: this.captureStackTrace(),
                cpu: process.cpuUsage()
            };
            
            profile.samples.push(sample);
        }, 10); // Sample every 10ms
        
        profile.interval = interval;
        
        this.emit('profile:started', { name });
        
        // Auto-stop after duration
        setTimeout(() => {
            this.stopCPUProfile(name);
        }, this.config.cpuProfileDuration);
    }

    captureStackTrace() {
        const obj = {};
        Error.captureStackTrace(obj, this.captureStackTrace);
        return obj.stack;
    }

    stopCPUProfile(name) {
        const profile = this.profiles.get(name);
        if (!profile) return null;
        
        clearInterval(profile.interval);
        profile.endTime = Date.now();
        profile.duration = profile.endTime - profile.startTime;
        
        this.isProfileing = false;
        
        // Analyze profile
        const analysis = this.analyzeProfile(profile);
        profile.analysis = analysis;
        
        this.emit('profile:stopped', { name, analysis });
        
        return profile;
    }

    analyzeProfile(profile) {
        const functionCounts = new Map();
        const callGraph = new Map();
        
        // Count function occurrences
        profile.samples.forEach(sample => {
            const lines = sample.stack.split('\n');
            
            lines.forEach((line, index) => {
                const match = line.match(/at (.+?) \(/);
                if (match) {
                    const funcName = match[1];
                    functionCounts.set(funcName, (functionCounts.get(funcName) || 0) + 1);
                    
                    // Build call graph
                    if (index > 0) {
                        const callerMatch = lines[index - 1].match(/at (.+?) \(/);
                        if (callerMatch) {
                            const caller = callerMatch[1];
                            const key = `${caller} -> ${funcName}`;
                            callGraph.set(key, (callGraph.get(key) || 0) + 1);
                        }
                    }
                }
            });
        });
        
        // Find hotspots
        const hotspots = Array.from(functionCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([func, count]) => ({
                function: func,
                samples: count,
                percentage: (count / profile.samples.length) * 100
            }));
        
        return {
            totalSamples: profile.samples.length,
            duration: profile.duration,
            hotspots,
            callGraph: Array.from(callGraph.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 20)
                .map(([path, count]) => ({ path, count }))
        };
    }

    async createHeapSnapshot() {
        const snapshot = {
            timestamp: Date.now(),
            stats: v8.getHeapStatistics(),
            spaces: v8.getHeapSpaceStatistics(),
            codeStats: v8.getHeapCodeStatistics()
        };
        
        // Analyze heap
        const analysis = this.analyzeHeap(snapshot);
        snapshot.analysis = analysis;
        
        this.memorySnapshots.push(snapshot);
        
        // Keep last 10 snapshots
        if (this.memorySnapshots.length > 10) {
            this.memorySnapshots.shift();
        }
        
        this.emit('heap:snapshot', snapshot);
        
        return snapshot;
    }

    analyzeHeap(snapshot) {
        const { stats, spaces } = snapshot;
        
        const analysis = {
            totalHeapSize: stats.total_heap_size,
            usedHeapSize: stats.used_heap_size,
            heapSizeLimit: stats.heap_size_limit,
            utilizationPercent: (stats.used_heap_size / stats.heap_size_limit) * 100,
            mallocedMemory: stats.malloced_memory,
            peakMallocedMemory: stats.peak_malloced_memory,
            gcPressure: stats.used_heap_size > stats.heap_size_limit * 0.9,
            spaces: spaces.map(space => ({
                name: space.space_name,
                size: space.space_size,
                used: space.space_used_size,
                available: space.space_available_size,
                utilization: (space.space_used_size / space.space_size) * 100
            }))
        };
        
        // Detect memory leaks
        if (this.memorySnapshots.length > 1) {
            const prevSnapshot = this.memorySnapshots[this.memorySnapshots.length - 2];
            const growth = stats.used_heap_size - prevSnapshot.stats.used_heap_size;
            const growthRate = growth / (snapshot.timestamp - prevSnapshot.timestamp) * 1000; // bytes per second
            
            analysis.memoryGrowth = growth;
            analysis.growthRate = growthRate;
            analysis.possibleLeak = growthRate > 1000000; // 1MB/s
        }
        
        return analysis;
    }

    detectBottlenecks() {
        const bottlenecks = [];
        
        // CPU bottlenecks
        const cpuMetric = this.metrics.get('cpu');
        if (cpuMetric && cpuMetric.avg > 80) {
            bottlenecks.push({
                type: 'cpu',
                severity: cpuMetric.avg > 90 ? 'high' : 'medium',
                description: `Average CPU usage is ${cpuMetric.avg.toFixed(1)}%`,
                recommendation: 'Consider optimizing CPU-intensive operations or scaling horizontally'
            });
        }
        
        // Memory bottlenecks
        const memMetric = this.metrics.get('memory');
        if (memMetric && memMetric.heap.current.percent > 85) {
            bottlenecks.push({
                type: 'memory',
                severity: memMetric.heap.current.percent > 95 ? 'high' : 'medium',
                description: `Heap usage is ${memMetric.heap.current.percent.toFixed(1)}%`,
                recommendation: 'Investigate memory leaks or increase heap size'
            });
        }
        
        // Event loop bottlenecks
        const elMetric = this.metrics.get('eventLoop');
        if (elMetric && elMetric.avg > 20) {
            bottlenecks.push({
                type: 'eventLoop',
                severity: elMetric.avg > 50 ? 'high' : 'medium',
                description: `Average event loop delay is ${elMetric.avg.toFixed(1)}ms`,
                recommendation: 'Break up long-running synchronous operations'
            });
        }
        
        // Function bottlenecks
        const slowFunctions = Array.from(this.functionTimings.entries())
            .filter(([_, timing]) => timing.avgDuration > 100)
            .sort((a, b) => b[1].totalDuration - a[1].totalDuration)
            .slice(0, 5);
        
        slowFunctions.forEach(([name, timing]) => {
            bottlenecks.push({
                type: 'function',
                severity: timing.avgDuration > 1000 ? 'high' : 'medium',
                description: `Function ${name} averages ${timing.avgDuration.toFixed(1)}ms`,
                recommendation: 'Optimize this function or consider caching results'
            });
        });
        
        return bottlenecks;
    }

    generateReport() {
        return {
            timestamp: Date.now(),
            metrics: Object.fromEntries(this.metrics),
            functionTimings: Object.fromEntries(this.functionTimings),
            bottlenecks: this.detectBottlenecks(),
            recommendations: this.generateRecommendations()
        };
    }

    generateRecommendations() {
        const recommendations = [];
        
        // Based on metrics
        const cpuMetric = this.metrics.get('cpu');
        if (cpuMetric && cpuMetric.max > 95) {
            recommendations.push({
                area: 'CPU',
                priority: 'high',
                suggestion: 'Implement worker threads for CPU-intensive tasks'
            });
        }
        
        const memMetric = this.metrics.get('memory');
        if (memMetric && memMetric.heap.current.percent > 90) {
            recommendations.push({
                area: 'Memory',
                priority: 'high',
                suggestion: 'Run heap profiler to identify memory leaks'
            });
        }
        
        return recommendations;
    }

    stop() {
        if (this.metricsInterval) clearInterval(this.metricsInterval);
        if (this.asyncHook) this.asyncHook.disable();
        
        for (const observer of this.observers.values()) {
            observer.disconnect();
        }
        
        this.emit('stopped');
    }
}

module.exports = PerformanceProfiler;