const { EventEmitter } = require('events');
const dgram = require('dgram');
const http = require('http');

class DistributedMetricsAggregator extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            listenPort: options.listenPort || 8125,
            httpPort: options.httpPort || 8080,
            flushInterval: options.flushInterval || 10000,
            percentiles: options.percentiles || [0.5, 0.75, 0.95, 0.99],
            retentionPeriods: options.retentionPeriods || {
                '1m': 7200,    // 2 hours at 1 minute
                '5m': 8640,    // 30 days at 5 minutes
                '1h': 8760,    // 1 year at 1 hour
                '1d': 3650     // 10 years at 1 day
            },
            ...options
        };
        
        this.metrics = new Map();
        this.timeSeries = new Map();
        this.aggregationRules = new Map();
        this.udpServer = null;
        this.httpServer = null;
        
        this.initializeAggregationRules();
    }

    async initialize() {
        // Start UDP server for StatsD protocol
        await this.startUDPServer();
        
        // Start HTTP server for queries
        await this.startHTTPServer();
        
        // Start aggregation timer
        this.startAggregation();
        
        // Start retention management
        this.startRetentionManagement();
        
        this.emit('initialized');
    }

    initializeAggregationRules() {
        // Counter aggregation
        this.aggregationRules.set('counter', {
            aggregate: (values) => values.reduce((a, b) => a + b, 0),
            reset: true
        });
        
        // Gauge aggregation
        this.aggregationRules.set('gauge', {
            aggregate: (values) => values[values.length - 1], // Last value
            reset: false
        });
        
        // Timer/histogram aggregation
        this.aggregationRules.set('timer', {
            aggregate: (values) => {
                const sorted = values.sort((a, b) => a - b);
                const stats = {
                    count: values.length,
                    sum: values.reduce((a, b) => a + b, 0),
                    min: sorted[0],
                    max: sorted[sorted.length - 1],
                    mean: values.reduce((a, b) => a + b, 0) / values.length,
                    percentiles: {}
                };
                
                this.config.percentiles.forEach(p => {
                    const index = Math.floor(sorted.length * p);
                    stats.percentiles[`p${p * 100}`] = sorted[index];
                });
                
                return stats;
            },
            reset: true
        });
        
        // Set aggregation
        this.aggregationRules.set('set', {
            aggregate: (values) => new Set(values).size,
            reset: true
        });
    }

    async startUDPServer() {
        this.udpServer = dgram.createSocket('udp4');
        
        this.udpServer.on('message', (msg, rinfo) => {
            this.parseMetric(msg.toString());
        });
        
        this.udpServer.on('error', (err) => {
            this.emit('error', err);
        });
        
        return new Promise((resolve) => {
            this.udpServer.bind(this.config.listenPort, () => {
                this.emit('udp:listening', { port: this.config.listenPort });
                resolve();
            });
        });
    }

    parseMetric(metric) {
        // StatsD format: metric_name:value|type|@sample_rate#tag1:value,tag2:value
        const match = metric.match(/^([^:]+):([^|]+)\|([^|@#]+)(?:\|@([^#]+))?(?:#(.+))?$/);
        
        if (!match) return;
        
        const [, name, value, type, sampleRate, tags] = match;
        
        const parsedMetric = {
            name,
            value: this.parseValue(value, type),
            type: this.normalizeType(type),
            sampleRate: sampleRate ? parseFloat(sampleRate) : 1,
            tags: this.parseTags(tags),
            timestamp: Date.now()
        };
        
        // Apply sample rate
        if (parsedMetric.sampleRate < 1 && Math.random() > parsedMetric.sampleRate) {
            return;
        }
        
        // Adjust value for sample rate
        if (parsedMetric.type === 'counter' && parsedMetric.sampleRate < 1) {
            parsedMetric.value = parsedMetric.value / parsedMetric.sampleRate;
        }
        
        this.recordMetric(parsedMetric);
    }

    parseValue(value, type) {
        if (type === 's') {
            return value; // Set values are strings
        }
        return parseFloat(value);
    }

    normalizeType(type) {
        const typeMap = {
            'c': 'counter',
            'g': 'gauge',
            'ms': 'timer',
            'h': 'timer',
            's': 'set'
        };
        
        return typeMap[type] || 'gauge';
    }

    parseTags(tagString) {
        if (!tagString) return {};
        
        const tags = {};
        tagString.split(',').forEach(tag => {
            const [key, value] = tag.split(':');
            tags[key] = value || true;
        });
        
        return tags;
    }

    recordMetric(metric) {
        const key = this.getMetricKey(metric.name, metric.tags);
        
        if (!this.metrics.has(key)) {
            this.metrics.set(key, {
                name: metric.name,
                type: metric.type,
                tags: metric.tags,
                values: []
            });
        }
        
        const metricData = this.metrics.get(key);
        metricData.values.push(metric.value);
        
        // Emit for real-time processing
        this.emit('metric:received', metric);
    }

    getMetricKey(name, tags) {
        const tagString = Object.entries(tags)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}:${v}`)
            .join(',');
        
        return `${name}#${tagString}`;
    }

    startAggregation() {
        this.aggregationInterval = setInterval(() => {
            this.aggregate();
        }, this.config.flushInterval);
    }

    aggregate() {
        const timestamp = Date.now();
        const aggregated = new Map();
        
        for (const [key, metric] of this.metrics) {
            const rule = this.aggregationRules.get(metric.type);
            if (!rule) continue;
            
            const result = rule.aggregate(metric.values);
            
            aggregated.set(key, {
                ...metric,
                value: result,
                timestamp
            });
            
            // Store in time series
            this.storeTimeSeries(key, result, timestamp);
            
            // Reset if needed
            if (rule.reset) {
                metric.values = [];
            }
        }
        
        this.emit('aggregation:complete', { 
            timestamp, 
            metricsCount: aggregated.size 
        });
        
        return aggregated;
    }

    storeTimeSeries(key, value, timestamp) {
        if (!this.timeSeries.has(key)) {
            this.timeSeries.set(key, {
                '1m': [],
                '5m': [],
                '1h': [],
                '1d': []
            });
        }
        
        const series = this.timeSeries.get(key);
        
        // Store in 1-minute resolution
        series['1m'].push({ timestamp, value });
        
        // Downsample for other resolutions
        this.downsample(series, timestamp);
        
        // Apply retention
        this.applyRetention(series);
    }

    downsample(series, timestamp) {
        // 5-minute downsampling
        if (this.shouldDownsample(timestamp, 5 * 60 * 1000)) {
            const recent = this.getRecentPoints(series['1m'], 5 * 60 * 1000);
            if (recent.length > 0) {
                series['5m'].push({
                    timestamp,
                    value: this.aggregatePoints(recent)
                });
            }
        }
        
        // 1-hour downsampling
        if (this.shouldDownsample(timestamp, 60 * 60 * 1000)) {
            const recent = this.getRecentPoints(series['5m'], 12 * 5 * 60 * 1000);
            if (recent.length > 0) {
                series['1h'].push({
                    timestamp,
                    value: this.aggregatePoints(recent)
                });
            }
        }
        
        // 1-day downsampling
        if (this.shouldDownsample(timestamp, 24 * 60 * 60 * 1000)) {
            const recent = this.getRecentPoints(series['1h'], 24 * 60 * 60 * 1000);
            if (recent.length > 0) {
                series['1d'].push({
                    timestamp,
                    value: this.aggregatePoints(recent)
                });
            }
        }
    }

    shouldDownsample(timestamp, interval) {
        return timestamp % interval < this.config.flushInterval;
    }

    getRecentPoints(points, duration) {
        const cutoff = Date.now() - duration;
        return points.filter(p => p.timestamp > cutoff);
    }

    aggregatePoints(points) {
        if (points.length === 0) return null;
        
        const values = points.map(p => p.value);
        
        // Handle different value types
        if (typeof values[0] === 'object') {
            // Aggregate complex metrics (like timer stats)
            return this.aggregateComplexValues(values);
        } else {
            // Simple numeric aggregation
            return {
                avg: values.reduce((a, b) => a + b, 0) / values.length,
                min: Math.min(...values),
                max: Math.max(...values),
                sum: values.reduce((a, b) => a + b, 0)
            };
        }
    }

    aggregateComplexValues(values) {
        const result = {
            count: values.reduce((sum, v) => sum + (v.count || 0), 0),
            sum: values.reduce((sum, v) => sum + (v.sum || 0), 0),
            min: Math.min(...values.map(v => v.min || Infinity)),
            max: Math.max(...values.map(v => v.max || -Infinity))
        };
        
        result.mean = result.sum / result.count;
        
        // Aggregate percentiles (approximate)
        if (values[0].percentiles) {
            result.percentiles = {};
            Object.keys(values[0].percentiles).forEach(p => {
                const percentileValues = values.map(v => v.percentiles[p]);
                result.percentiles[p] = percentileValues.reduce((a, b) => a + b, 0) / percentileValues.length;
            });
        }
        
        return result;
    }

    applyRetention(series) {
        const now = Date.now();
        
        Object.entries(this.config.retentionPeriods).forEach(([resolution, points]) => {
            if (series[resolution]) {
                const maxAge = this.getMaxAge(resolution, points);
                const cutoff = now - maxAge;
                
                series[resolution] = series[resolution].filter(p => p.timestamp > cutoff);
            }
        });
    }

    getMaxAge(resolution, points) {
        const resolutionMs = {
            '1m': 60 * 1000,
            '5m': 5 * 60 * 1000,
            '1h': 60 * 60 * 1000,
            '1d': 24 * 60 * 60 * 1000
        };
        
        return resolutionMs[resolution] * points;
    }

    startRetentionManagement() {
        // Run retention cleanup every hour
        this.retentionInterval = setInterval(() => {
            this.cleanupOldData();
        }, 60 * 60 * 1000);
    }

    cleanupOldData() {
        let cleaned = 0;
        
        for (const [key, series] of this.timeSeries) {
            let hasData = false;
            
            Object.values(series).forEach(points => {
                if (points.length > 0) hasData = true;
            });
            
            if (!hasData) {
                this.timeSeries.delete(key);
                this.metrics.delete(key);
                cleaned++;
            }
        }
        
        this.emit('retention:cleanup', { cleaned });
    }

    async startHTTPServer() {
        this.httpServer = http.createServer((req, res) => {
            this.handleHTTPRequest(req, res);
        });
        
        return new Promise((resolve) => {
            this.httpServer.listen(this.config.httpPort, () => {
                this.emit('http:listening', { port: this.config.httpPort });
                resolve();
            });
        });
    }

    handleHTTPRequest(req, res) {
        const url = new URL(req.url, `http://localhost:${this.config.httpPort}`);
        
        res.setHeader('Content-Type', 'application/json');
        
        switch (url.pathname) {
            case '/metrics':
                this.handleMetricsQuery(url.searchParams, res);
                break;
                
            case '/series':
                this.handleSeriesQuery(url.searchParams, res);
                break;
                
            case '/aggregate':
                this.handleAggregateQuery(url.searchParams, res);
                break;
                
            case '/health':
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'healthy' }));
                break;
                
            default:
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Not found' }));
        }
    }

    handleMetricsQuery(params, res) {
        const pattern = params.get('pattern') || '*';
        const tags = this.parseQueryTags(params.get('tags'));
        
        const results = [];
        
        for (const [key, metric] of this.metrics) {
            if (this.matchesPattern(metric.name, pattern) && 
                this.matchesTags(metric.tags, tags)) {
                results.push({
                    name: metric.name,
                    type: metric.type,
                    tags: metric.tags,
                    lastValue: metric.values[metric.values.length - 1],
                    valueCount: metric.values.length
                });
            }
        }
        
        res.writeHead(200);
        res.end(JSON.stringify(results));
    }

    handleSeriesQuery(params, res) {
        const metric = params.get('metric');
        const tags = this.parseQueryTags(params.get('tags'));
        const from = parseInt(params.get('from')) || Date.now() - 3600000;
        const to = parseInt(params.get('to')) || Date.now();
        const resolution = params.get('resolution') || '1m';
        
        const key = this.getMetricKey(metric, tags);
        const series = this.timeSeries.get(key);
        
        if (!series) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Series not found' }));
            return;
        }
        
        const points = series[resolution] || [];
        const filtered = points.filter(p => p.timestamp >= from && p.timestamp <= to);
        
        res.writeHead(200);
        res.end(JSON.stringify({
            metric,
            tags,
            resolution,
            points: filtered
        }));
    }

    handleAggregateQuery(params, res) {
        const metrics = params.get('metrics').split(',');
        const aggregation = params.get('aggregation') || 'sum';
        const groupBy = params.get('groupBy');
        const from = parseInt(params.get('from')) || Date.now() - 3600000;
        const to = parseInt(params.get('to')) || Date.now();
        
        const results = this.performAggregation(metrics, aggregation, groupBy, from, to);
        
        res.writeHead(200);
        res.end(JSON.stringify(results));
    }

    performAggregation(metrics, aggregation, groupBy, from, to) {
        const groups = new Map();
        
        for (const [key, series] of this.timeSeries) {
            const metric = this.metrics.get(key);
            if (!metric || !metrics.includes(metric.name)) continue;
            
            const groupKey = groupBy ? metric.tags[groupBy] || 'null' : 'all';
            
            if (!groups.has(groupKey)) {
                groups.set(groupKey, []);
            }
            
            // Get points in time range
            const points = [];
            Object.values(series).forEach(resolution => {
                resolution.forEach(point => {
                    if (point.timestamp >= from && point.timestamp <= to) {
                        points.push(point);
                    }
                });
            });
            
            groups.get(groupKey).push(...points);
        }
        
        // Aggregate each group
        const results = {};
        for (const [group, points] of groups) {
            results[group] = this.applyAggregation(points, aggregation);
        }
        
        return results;
    }

    applyAggregation(points, aggregation) {
        if (points.length === 0) return null;
        
        const values = points.map(p => typeof p.value === 'object' ? p.value.sum : p.value);
        
        switch (aggregation) {
            case 'sum':
                return values.reduce((a, b) => a + b, 0);
            case 'avg':
                return values.reduce((a, b) => a + b, 0) / values.length;
            case 'min':
                return Math.min(...values);
            case 'max':
                return Math.max(...values);
            case 'count':
                return values.length;
            default:
                return null;
        }
    }

    matchesPattern(name, pattern) {
        if (pattern === '*') return true;
        
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(name);
    }

    matchesTags(metricTags, queryTags) {
        for (const [key, value] of Object.entries(queryTags)) {
            if (metricTags[key] !== value) return false;
        }
        return true;
    }

    parseQueryTags(tagString) {
        if (!tagString) return {};
        
        const tags = {};
        tagString.split(',').forEach(tag => {
            const [key, value] = tag.split('=');
            tags[key] = value;
        });
        
        return tags;
    }

    getStatistics() {
        return {
            metricsCount: this.metrics.size,
            timeSeriesCount: this.timeSeries.size,
            totalDataPoints: Array.from(this.timeSeries.values()).reduce((sum, series) => {
                return sum + Object.values(series).reduce((s, points) => s + points.length, 0);
            }, 0),
            retentionPeriods: this.config.retentionPeriods,
            uptime: Date.now() - this.startTime
        };
    }

    stop() {
        if (this.aggregationInterval) clearInterval(this.aggregationInterval);
        if (this.retentionInterval) clearInterval(this.retentionInterval);
        
        if (this.udpServer) {
            this.udpServer.close();
        }
        
        if (this.httpServer) {
            this.httpServer.close();
        }
        
        this.emit('stopped');
    }
}

module.exports = DistributedMetricsAggregator;