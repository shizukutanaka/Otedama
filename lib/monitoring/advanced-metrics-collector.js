const { EventEmitter } = require('events');
const os = require('os');
const { performance } = require('perf_hooks');
const cluster = require('cluster');

class AdvancedMetricsCollector extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            collectInterval: options.collectInterval || 1000,
            aggregateInterval: options.aggregateInterval || 5000,
            retentionPeriod: options.retentionPeriod || 86400000, // 24 hours
            enableProfiling: options.enableProfiling !== false,
            enableTracing: options.enableTracing !== false,
            metricsBuffer: options.metricsBuffer || 10000,
            ...options
        };
        
        // Metrics storage
        this.metrics = {
            system: new Map(),
            mining: new Map(),
            network: new Map(),
            custom: new Map()
        };
        
        // Time series data
        this.timeSeries = {
            hashrate: [],
            temperature: [],
            power: [],
            efficiency: [],
            latency: [],
            shares: []
        };
        
        // Aggregated metrics
        this.aggregated = {
            hashrate: { min: 0, max: 0, avg: 0, current: 0 },
            temperature: { min: 100, max: 0, avg: 0, current: 0 },
            efficiency: { min: 0, max: 0, avg: 0, current: 0 },
            shares: { accepted: 0, rejected: 0, stale: 0, total: 0 }
        };
        
        // Performance marks
        this.performanceMarks = new Map();
        this.traces = [];
        
        this.isCollecting = false;
        this.collectors = new Map();
        
        this.initializeCollectors();
    }

    initializeCollectors() {
        // System metrics collector
        this.registerCollector('system', this.collectSystemMetrics.bind(this));
        
        // Process metrics collector
        this.registerCollector('process', this.collectProcessMetrics.bind(this));
        
        // Mining metrics collector
        this.registerCollector('mining', this.collectMiningMetrics.bind(this));
        
        // Network metrics collector
        this.registerCollector('network', this.collectNetworkMetrics.bind(this));
        
        // GPU metrics collector
        this.registerCollector('gpu', this.collectGPUMetrics.bind(this));
    }

    registerCollector(name, collector) {
        this.collectors.set(name, {
            name,
            collector,
            lastRun: 0,
            errors: 0
        });
    }

    async start() {
        if (this.isCollecting) return;
        
        this.isCollecting = true;
        this.emit('collection:started');
        
        // Start collection loops
        this.startCollectionLoop();
        this.startAggregationLoop();
        this.startCleanupLoop();
    }

    stop() {
        this.isCollecting = false;
        
        if (this.collectionTimer) clearInterval(this.collectionTimer);
        if (this.aggregationTimer) clearInterval(this.aggregationTimer);
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
        
        this.emit('collection:stopped');
    }

    startCollectionLoop() {
        this.collectionTimer = setInterval(async () => {
            const timestamp = Date.now();
            
            for (const [name, collector] of this.collectors) {
                try {
                    const startTime = performance.now();
                    const metrics = await collector.collector(timestamp);
                    const duration = performance.now() - startTime;
                    
                    collector.lastRun = timestamp;
                    
                    // Store metrics
                    this.storeMetrics(name, metrics, timestamp);
                    
                    // Track collection performance
                    this.trackPerformance(`collect:${name}`, duration);
                    
                } catch (error) {
                    collector.errors++;
                    this.emit('collector:error', { name, error });
                }
            }
            
            this.emit('metrics:collected', { timestamp });
        }, this.config.collectInterval);
    }

    startAggregationLoop() {
        this.aggregationTimer = setInterval(() => {
            this.aggregateMetrics();
            this.calculateDerivedMetrics();
            this.detectAnomalies();
            
            this.emit('metrics:aggregated', this.getAggregatedMetrics());
        }, this.config.aggregateInterval);
    }

    startCleanupLoop() {
        this.cleanupTimer = setInterval(() => {
            const cutoff = Date.now() - this.config.retentionPeriod;
            
            // Clean up old time series data
            for (const [key, series] of Object.entries(this.timeSeries)) {
                this.timeSeries[key] = series.filter(point => point.timestamp > cutoff);
            }
            
            // Clean up old metrics
            for (const category of this.metrics.values()) {
                for (const [key, values] of category) {
                    category.set(key, values.filter(v => v.timestamp > cutoff));
                }
            }
            
            this.emit('cleanup:completed', { removed: cutoff });
        }, 3600000); // Every hour
    }

    async collectSystemMetrics(timestamp) {
        const cpus = os.cpus();
        const loadAvg = os.loadavg();
        
        return {
            cpu: {
                usage: this.calculateCPUUsage(cpus),
                cores: cpus.length,
                speed: cpus[0]?.speed || 0,
                temperature: await this.getCPUTemperature()
            },
            memory: {
                total: os.totalmem(),
                free: os.freemem(),
                used: os.totalmem() - os.freemem(),
                usage: ((os.totalmem() - os.freemem()) / os.totalmem()) * 100
            },
            load: {
                '1m': loadAvg[0],
                '5m': loadAvg[1],
                '15m': loadAvg[2]
            },
            uptime: os.uptime()
        };
    }

    async collectProcessMetrics(timestamp) {
        const usage = process.cpuUsage();
        const memory = process.memoryUsage();
        
        return {
            cpu: {
                user: usage.user,
                system: usage.system,
                percent: this.calculateProcessCPUPercent(usage)
            },
            memory: {
                rss: memory.rss,
                heapTotal: memory.heapTotal,
                heapUsed: memory.heapUsed,
                external: memory.external,
                arrayBuffers: memory.arrayBuffers
            },
            handles: process._getActiveHandles?.().length || 0,
            requests: process._getActiveRequests?.().length || 0,
            eventLoop: await this.measureEventLoopLag()
        };
    }

    async collectMiningMetrics(timestamp) {
        // This would be populated by actual mining data
        return {
            hashrate: this.getCurrentHashrate(),
            difficulty: this.getCurrentDifficulty(),
            shares: {
                submitted: this.getShareCount('submitted'),
                accepted: this.getShareCount('accepted'),
                rejected: this.getShareCount('rejected'),
                stale: this.getShareCount('stale')
            },
            blocks: {
                found: this.getBlockCount(),
                effort: this.getCurrentEffort()
            },
            efficiency: this.calculateMiningEfficiency()
        };
    }

    async collectNetworkMetrics(timestamp) {
        return {
            connections: {
                active: this.getActiveConnections(),
                total: this.getTotalConnections(),
                failed: this.getFailedConnections()
            },
            bandwidth: {
                in: this.getBandwidthIn(),
                out: this.getBandwidthOut()
            },
            latency: {
                pool: await this.measurePoolLatency(),
                peers: await this.measurePeerLatency()
            },
            packets: {
                sent: this.getPacketsSent(),
                received: this.getPacketsReceived(),
                dropped: this.getPacketsDropped()
            }
        };
    }

    async collectGPUMetrics(timestamp) {
        const gpuData = await this.queryGPUs();
        
        return gpuData.map(gpu => ({
            id: gpu.id,
            name: gpu.name,
            temperature: gpu.temperature,
            fanSpeed: gpu.fanSpeed,
            powerDraw: gpu.powerDraw,
            utilization: {
                gpu: gpu.gpuUtil,
                memory: gpu.memUtil
            },
            memory: {
                total: gpu.memTotal,
                used: gpu.memUsed,
                free: gpu.memFree
            },
            clocks: {
                core: gpu.coreClock,
                memory: gpu.memClock
            }
        }));
    }

    calculateCPUUsage(cpus) {
        if (!this.lastCPUs) {
            this.lastCPUs = cpus;
            return 0;
        }
        
        let totalDiff = 0;
        let idleDiff = 0;
        
        for (let i = 0; i < cpus.length; i++) {
            const last = this.lastCPUs[i];
            const current = cpus[i];
            
            const lastTotal = Object.values(last.times).reduce((a, b) => a + b);
            const currentTotal = Object.values(current.times).reduce((a, b) => a + b);
            
            totalDiff += currentTotal - lastTotal;
            idleDiff += current.times.idle - last.times.idle;
        }
        
        this.lastCPUs = cpus;
        
        return ((totalDiff - idleDiff) / totalDiff) * 100;
    }

    calculateProcessCPUPercent(usage) {
        if (!this.lastProcessUsage) {
            this.lastProcessUsage = { ...usage, timestamp: Date.now() };
            return 0;
        }
        
        const timeDiff = Date.now() - this.lastProcessUsage.timestamp;
        const userDiff = usage.user - this.lastProcessUsage.user;
        const systemDiff = usage.system - this.lastProcessUsage.system;
        
        this.lastProcessUsage = { ...usage, timestamp: Date.now() };
        
        const totalDiff = userDiff + systemDiff;
        const cpuPercent = (totalDiff / (timeDiff * 1000)) * 100;
        
        return Math.min(100 * os.cpus().length, cpuPercent);
    }

    async measureEventLoopLag() {
        return new Promise((resolve) => {
            const start = process.hrtime.bigint();
            setImmediate(() => {
                const lag = Number(process.hrtime.bigint() - start) / 1000000;
                resolve(lag);
            });
        });
    }

    storeMetrics(category, metrics, timestamp) {
        const categoryMap = this.metrics[category] || this.metrics.custom;
        
        for (const [key, value] of Object.entries(metrics)) {
            if (typeof value === 'object' && !Array.isArray(value)) {
                // Flatten nested objects
                for (const [subKey, subValue] of Object.entries(value)) {
                    const metricKey = `${key}.${subKey}`;
                    this.addMetricPoint(categoryMap, metricKey, subValue, timestamp);
                }
            } else {
                this.addMetricPoint(categoryMap, key, value, timestamp);
            }
        }
        
        // Update time series for key metrics
        this.updateTimeSeries(metrics, timestamp);
    }

    addMetricPoint(map, key, value, timestamp) {
        if (!map.has(key)) {
            map.set(key, []);
        }
        
        const points = map.get(key);
        points.push({ value, timestamp });
        
        // Limit buffer size
        if (points.length > this.config.metricsBuffer) {
            points.shift();
        }
    }

    updateTimeSeries(metrics, timestamp) {
        // Update hashrate time series
        if (metrics.hashrate) {
            this.timeSeries.hashrate.push({
                value: metrics.hashrate,
                timestamp
            });
        }
        
        // Update temperature time series
        if (metrics.temperature) {
            this.timeSeries.temperature.push({
                value: metrics.temperature,
                timestamp
            });
        }
        
        // Update shares time series
        if (metrics.shares) {
            this.timeSeries.shares.push({
                value: metrics.shares.accepted,
                timestamp
            });
        }
        
        // Trim old data
        const cutoff = timestamp - this.config.retentionPeriod;
        for (const [key, series] of Object.entries(this.timeSeries)) {
            this.timeSeries[key] = series.filter(point => point.timestamp > cutoff);
        }
    }

    aggregateMetrics() {
        // Aggregate hashrate
        const hashrateValues = this.timeSeries.hashrate.map(p => p.value);
        if (hashrateValues.length > 0) {
            this.aggregated.hashrate = {
                min: Math.min(...hashrateValues),
                max: Math.max(...hashrateValues),
                avg: hashrateValues.reduce((a, b) => a + b) / hashrateValues.length,
                current: hashrateValues[hashrateValues.length - 1]
            };
        }
        
        // Aggregate temperature
        const tempValues = this.timeSeries.temperature.map(p => p.value);
        if (tempValues.length > 0) {
            this.aggregated.temperature = {
                min: Math.min(...tempValues),
                max: Math.max(...tempValues),
                avg: tempValues.reduce((a, b) => a + b) / tempValues.length,
                current: tempValues[tempValues.length - 1]
            };
        }
    }

    calculateDerivedMetrics() {
        // Calculate efficiency (hashrate per watt)
        const powerMetrics = this.metrics.system.get('power.draw');
        if (powerMetrics && powerMetrics.length > 0 && this.aggregated.hashrate.current > 0) {
            const currentPower = powerMetrics[powerMetrics.length - 1].value;
            this.aggregated.efficiency.current = this.aggregated.hashrate.current / currentPower;
        }
        
        // Calculate share rate
        const shareWindow = 300000; // 5 minutes
        const recentShares = this.timeSeries.shares.filter(
            s => s.timestamp > Date.now() - shareWindow
        );
        
        if (recentShares.length > 0) {
            const shareRate = (recentShares.length / shareWindow) * 60000; // per minute
            this.metrics.custom.set('shareRate', [{
                value: shareRate,
                timestamp: Date.now()
            }]);
        }
    }

    detectAnomalies() {
        // Detect hashrate anomalies
        if (this.aggregated.hashrate.current < this.aggregated.hashrate.avg * 0.8) {
            this.emit('anomaly:detected', {
                type: 'hashrate-drop',
                current: this.aggregated.hashrate.current,
                expected: this.aggregated.hashrate.avg
            });
        }
        
        // Detect temperature anomalies
        if (this.aggregated.temperature.current > 85) {
            this.emit('anomaly:detected', {
                type: 'high-temperature',
                current: this.aggregated.temperature.current,
                threshold: 85
            });
        }
        
        // Detect share rejection anomalies
        const recentShares = this.getRecentShareStats();
        if (recentShares.rejectionRate > 0.05) { // 5% threshold
            this.emit('anomaly:detected', {
                type: 'high-rejection-rate',
                rate: recentShares.rejectionRate
            });
        }
    }

    trackPerformance(operation, duration) {
        if (!this.config.enableProfiling) return;
        
        if (!this.performanceMarks.has(operation)) {
            this.performanceMarks.set(operation, {
                count: 0,
                total: 0,
                min: Infinity,
                max: 0,
                avg: 0
            });
        }
        
        const mark = this.performanceMarks.get(operation);
        mark.count++;
        mark.total += duration;
        mark.min = Math.min(mark.min, duration);
        mark.max = Math.max(mark.max, duration);
        mark.avg = mark.total / mark.count;
    }

    startTrace(name) {
        if (!this.config.enableTracing) return null;
        
        const trace = {
            name,
            start: performance.now(),
            marks: []
        };
        
        return trace;
    }

    endTrace(trace) {
        if (!trace) return;
        
        trace.end = performance.now();
        trace.duration = trace.end - trace.start;
        
        this.traces.push(trace);
        
        // Keep only recent traces
        if (this.traces.length > 1000) {
            this.traces.shift();
        }
    }

    getMetrics(category, key, duration) {
        const categoryMap = this.metrics[category];
        if (!categoryMap) return [];
        
        const metrics = categoryMap.get(key);
        if (!metrics) return [];
        
        if (duration) {
            const cutoff = Date.now() - duration;
            return metrics.filter(m => m.timestamp > cutoff);
        }
        
        return metrics;
    }

    getAggregatedMetrics() {
        return {
            ...this.aggregated,
            system: {
                cpu: this.getLatestMetric('system', 'cpu.usage'),
                memory: this.getLatestMetric('system', 'memory.usage'),
                load: this.getLatestMetric('system', 'load.1m')
            },
            process: {
                cpu: this.getLatestMetric('process', 'cpu.percent'),
                memory: this.getLatestMetric('process', 'memory.heapUsed'),
                eventLoop: this.getLatestMetric('process', 'eventLoop')
            }
        };
    }

    getLatestMetric(category, key) {
        const metrics = this.getMetrics(category, key);
        return metrics.length > 0 ? metrics[metrics.length - 1].value : 0;
    }

    getTimeSeries(metric, duration) {
        const series = this.timeSeries[metric];
        if (!series) return [];
        
        if (duration) {
            const cutoff = Date.now() - duration;
            return series.filter(point => point.timestamp > cutoff);
        }
        
        return series;
    }

    getPerformanceReport() {
        const report = {};
        
        for (const [operation, stats] of this.performanceMarks) {
            report[operation] = { ...stats };
        }
        
        return report;
    }

    exportMetrics(format = 'json') {
        const data = {
            timestamp: Date.now(),
            aggregated: this.getAggregatedMetrics(),
            timeSeries: {},
            performance: this.getPerformanceReport()
        };
        
        // Include recent time series data
        for (const [key, series] of Object.entries(this.timeSeries)) {
            data.timeSeries[key] = series.slice(-100); // Last 100 points
        }
        
        switch (format) {
            case 'json':
                return JSON.stringify(data, null, 2);
            case 'prometheus':
                return this.formatPrometheus(data);
            case 'csv':
                return this.formatCSV(data);
            default:
                return data;
        }
    }

    formatPrometheus(data) {
        let output = '';
        
        // Format aggregated metrics
        for (const [metric, values] of Object.entries(data.aggregated)) {
            if (typeof values === 'object') {
                for (const [stat, value] of Object.entries(values)) {
                    output += `otedama_${metric}_${stat} ${value}\n`;
                }
            }
        }
        
        return output;
    }

    formatCSV(data) {
        let output = 'metric,timestamp,value\n';
        
        for (const [metric, series] of Object.entries(data.timeSeries)) {
            for (const point of series) {
                output += `${metric},${point.timestamp},${point.value}\n`;
            }
        }
        
        return output;
    }

    // Placeholder methods for actual implementations
    async getCPUTemperature() {
        // Would read from sensors
        return Math.random() * 20 + 50;
    }

    async queryGPUs() {
        // Would query actual GPU data
        return [];
    }

    getCurrentHashrate() {
        return Math.random() * 100000000; // 100 MH/s
    }

    getCurrentDifficulty() {
        return 1000000;
    }

    getShareCount(type) {
        return Math.floor(Math.random() * 100);
    }

    getBlockCount() {
        return Math.floor(Math.random() * 10);
    }

    getCurrentEffort() {
        return Math.random() * 200;
    }

    calculateMiningEfficiency() {
        return Math.random() * 0.5 + 0.5;
    }

    getActiveConnections() {
        return Math.floor(Math.random() * 50);
    }

    getTotalConnections() {
        return Math.floor(Math.random() * 100);
    }

    getFailedConnections() {
        return Math.floor(Math.random() * 10);
    }

    getBandwidthIn() {
        return Math.random() * 1000000;
    }

    getBandwidthOut() {
        return Math.random() * 1000000;
    }

    async measurePoolLatency() {
        return Math.random() * 100;
    }

    async measurePeerLatency() {
        return Math.random() * 50;
    }

    getPacketsSent() {
        return Math.floor(Math.random() * 10000);
    }

    getPacketsReceived() {
        return Math.floor(Math.random() * 10000);
    }

    getPacketsDropped() {
        return Math.floor(Math.random() * 10);
    }

    getRecentShareStats() {
        return {
            total: 100,
            accepted: 95,
            rejected: 5,
            rejectionRate: 0.05
        };
    }
}

module.exports = AdvancedMetricsCollector;