const { EventEmitter } = require('events');
const { Transform } = require('stream');
const fs = require('fs');
const path = require('path');

class RealtimeLogAnalyzer extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            logPatterns: options.logPatterns || this.getDefaultPatterns(),
            alertThresholds: options.alertThresholds || this.getDefaultThresholds(),
            windowSize: options.windowSize || 60000, // 1 minute sliding window
            aggregationInterval: options.aggregationInterval || 5000, // 5 seconds
            maxBufferSize: options.maxBufferSize || 10000,
            enableML: options.enableML !== false,
            ...options
        };
        
        this.logStreams = new Map();
        this.logBuffer = [];
        this.metrics = new Map();
        this.patterns = new Map();
        this.alerts = [];
        
        // Analysis state
        this.analysisState = {
            totalLogs: 0,
            errorCount: 0,
            warningCount: 0,
            anomalyCount: 0,
            performanceIssues: 0
        };
        
        // Pattern matching cache
        this.patternCache = new Map();
        this.compiledPatterns = new Map();
        
        this.initialize();
    }

    initialize() {
        // Compile regex patterns
        this.compilePatterns();
        
        // Setup aggregation
        this.startAggregation();
        
        // Setup ML models if enabled
        if (this.config.enableML) {
            this.initializeMLModels();
        }
        
        this.emit('initialized');
    }

    getDefaultPatterns() {
        return {
            error: {
                patterns: [
                    /ERROR|FATAL|CRITICAL/i,
                    /Exception|Error|Failed/i,
                    /\b5\d{2}\b/, // HTTP 5xx errors
                    /Connection refused|Timeout/i
                ],
                severity: 'high'
            },
            warning: {
                patterns: [
                    /WARN|WARNING/i,
                    /Deprecated|Obsolete/i,
                    /\b4\d{2}\b/, // HTTP 4xx errors
                    /Retry|Attempting/i
                ],
                severity: 'medium'
            },
            performance: {
                patterns: [
                    /slow|latency|delay/i,
                    /took\s+(\d+)ms/i,
                    /timeout|deadline/i,
                    /memory|heap|gc/i
                ],
                severity: 'medium'
            },
            security: {
                patterns: [
                    /unauthorized|forbidden|denied/i,
                    /authentication|login\s+failed/i,
                    /invalid\s+token|expired/i,
                    /SQL\s+injection|XSS|CSRF/i
                ],
                severity: 'critical'
            },
            mining: {
                patterns: [
                    /share\s+(accepted|rejected)/i,
                    /new\s+job|work\s+update/i,
                    /hashrate|difficulty/i,
                    /pool\s+connection/i
                ],
                severity: 'info'
            }
        };
    }

    getDefaultThresholds() {
        return {
            errorRate: 10, // errors per minute
            warningRate: 50, // warnings per minute
            responseTime: 1000, // ms
            memoryUsage: 0.9, // 90%
            cpuUsage: 0.8, // 80%
            anomalyScore: 0.7
        };
    }

    compilePatterns() {
        for (const [category, config] of Object.entries(this.config.logPatterns)) {
            const compiled = config.patterns.map(pattern => {
                if (pattern instanceof RegExp) {
                    return pattern;
                } else {
                    return new RegExp(pattern, 'i');
                }
            });
            
            this.compiledPatterns.set(category, {
                ...config,
                patterns: compiled
            });
        }
    }

    attachLogStream(name, stream) {
        const analyzer = new LogAnalyzerTransform(this);
        
        stream.pipe(analyzer);
        
        this.logStreams.set(name, {
            stream,
            analyzer,
            stats: {
                processed: 0,
                errors: 0,
                warnings: 0
            }
        });
        
        this.emit('stream:attached', { name });
    }

    analyzeLine(line, source = 'unknown') {
        this.analysisState.totalLogs++;
        
        const timestamp = this.extractTimestamp(line);
        const logEntry = {
            line,
            source,
            timestamp: timestamp || Date.now(),
            categories: [],
            metrics: {},
            anomalies: []
        };
        
        // Pattern matching
        for (const [category, config] of this.compiledPatterns) {
            for (const pattern of config.patterns) {
                if (pattern.test(line)) {
                    logEntry.categories.push(category);
                    
                    // Extract metrics if pattern has capture groups
                    const match = line.match(pattern);
                    if (match && match.length > 1) {
                        logEntry.metrics[category] = match.slice(1);
                    }
                    
                    break;
                }
            }
        }
        
        // Extract structured data
        this.extractStructuredData(logEntry);
        
        // Anomaly detection
        if (this.config.enableML) {
            const anomalies = this.detectAnomalies(logEntry);
            logEntry.anomalies = anomalies;
        }
        
        // Update metrics
        this.updateMetrics(logEntry);
        
        // Check thresholds
        this.checkThresholds(logEntry);
        
        // Buffer management
        this.addToBuffer(logEntry);
        
        // Emit categorized events
        for (const category of logEntry.categories) {
            this.emit(`log:${category}`, logEntry);
        }
        
        return logEntry;
    }

    extractTimestamp(line) {
        // Common timestamp patterns
        const patterns = [
            /(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})?)/,
            /(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/,
            /(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/,
            /\[(\d+)\]/, // Unix timestamp
        ];
        
        for (const pattern of patterns) {
            const match = line.match(pattern);
            if (match) {
                const timestamp = Date.parse(match[1]);
                if (!isNaN(timestamp)) {
                    return timestamp;
                }
                
                // Try Unix timestamp
                if (/^\d+$/.test(match[1])) {
                    return parseInt(match[1]) * 1000;
                }
            }
        }
        
        return null;
    }

    extractStructuredData(logEntry) {
        const line = logEntry.line;
        
        // Extract JSON
        const jsonMatch = line.match(/\{[^}]+\}/);
        if (jsonMatch) {
            try {
                logEntry.json = JSON.parse(jsonMatch[0]);
            } catch (e) {
                // Not valid JSON
            }
        }
        
        // Extract key-value pairs
        const kvPattern = /(\w+)=([^\s,]+)/g;
        const kvPairs = {};
        let match;
        
        while ((match = kvPattern.exec(line)) !== null) {
            kvPairs[match[1]] = match[2];
        }
        
        if (Object.keys(kvPairs).length > 0) {
            logEntry.kvPairs = kvPairs;
        }
        
        // Extract metrics
        this.extractMetrics(logEntry);
    }

    extractMetrics(logEntry) {
        const line = logEntry.line;
        
        // Response time
        const timeMatch = line.match(/took\s+(\d+(?:\.\d+)?)\s*(ms|s|seconds?)/i);
        if (timeMatch) {
            let time = parseFloat(timeMatch[1]);
            if (timeMatch[2].startsWith('s')) {
                time *= 1000; // Convert to ms
            }
            logEntry.metrics.responseTime = time;
        }
        
        // Memory usage
        const memMatch = line.match(/memory:\s*(\d+(?:\.\d+)?)\s*(MB|GB|KB)?/i);
        if (memMatch) {
            let memory = parseFloat(memMatch[1]);
            const unit = memMatch[2] || 'MB';
            
            // Convert to MB
            if (unit === 'GB') memory *= 1024;
            else if (unit === 'KB') memory /= 1024;
            
            logEntry.metrics.memory = memory;
        }
        
        // CPU usage
        const cpuMatch = line.match(/cpu:\s*(\d+(?:\.\d+)?)\s*%/i);
        if (cpuMatch) {
            logEntry.metrics.cpu = parseFloat(cpuMatch[1]);
        }
        
        // Mining specific
        const hashrateMatch = line.match(/hashrate:\s*(\d+(?:\.\d+)?)\s*(H\/s|KH\/s|MH\/s|GH\/s|TH\/s)/i);
        if (hashrateMatch) {
            logEntry.metrics.hashrate = {
                value: parseFloat(hashrateMatch[1]),
                unit: hashrateMatch[2]
            };
        }
        
        const shareMatch = line.match(/share\s+(accepted|rejected)/i);
        if (shareMatch) {
            logEntry.metrics.share = shareMatch[1].toLowerCase();
        }
    }

    updateMetrics(logEntry) {
        const now = Date.now();
        const window = this.config.windowSize;
        
        // Update category counters
        for (const category of logEntry.categories) {
            const key = `${category}_count`;
            const metric = this.metrics.get(key) || [];
            
            metric.push({ timestamp: now, value: 1 });
            
            // Remove old entries
            const cutoff = now - window;
            this.metrics.set(key, metric.filter(m => m.timestamp > cutoff));
        }
        
        // Update numeric metrics
        for (const [name, value] of Object.entries(logEntry.metrics)) {
            if (typeof value === 'number') {
                const metric = this.metrics.get(name) || [];
                metric.push({ timestamp: now, value });
                
                const cutoff = now - window;
                this.metrics.set(name, metric.filter(m => m.timestamp > cutoff));
            }
        }
        
        // Update state counters
        if (logEntry.categories.includes('error')) {
            this.analysisState.errorCount++;
        }
        if (logEntry.categories.includes('warning')) {
            this.analysisState.warningCount++;
        }
        if (logEntry.anomalies.length > 0) {
            this.analysisState.anomalyCount++;
        }
    }

    checkThresholds(logEntry) {
        const now = Date.now();
        
        // Check error rate
        const errorMetric = this.metrics.get('error_count') || [];
        const recentErrors = errorMetric.filter(m => m.timestamp > now - 60000).length;
        
        if (recentErrors > this.config.alertThresholds.errorRate) {
            this.createAlert('high_error_rate', {
                rate: recentErrors,
                threshold: this.config.alertThresholds.errorRate,
                logEntry
            });
        }
        
        // Check response time
        if (logEntry.metrics.responseTime > this.config.alertThresholds.responseTime) {
            this.createAlert('slow_response', {
                responseTime: logEntry.metrics.responseTime,
                threshold: this.config.alertThresholds.responseTime,
                logEntry
            });
        }
        
        // Check resource usage
        if (logEntry.metrics.memory) {
            const memoryUsage = logEntry.metrics.memory / this.getTotalMemory();
            if (memoryUsage > this.config.alertThresholds.memoryUsage) {
                this.createAlert('high_memory', {
                    usage: memoryUsage,
                    threshold: this.config.alertThresholds.memoryUsage,
                    logEntry
                });
            }
        }
        
        if (logEntry.metrics.cpu && logEntry.metrics.cpu > this.config.alertThresholds.cpuUsage * 100) {
            this.createAlert('high_cpu', {
                usage: logEntry.metrics.cpu,
                threshold: this.config.alertThresholds.cpuUsage * 100,
                logEntry
            });
        }
    }

    createAlert(type, data) {
        const alert = {
            id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type,
            timestamp: Date.now(),
            severity: this.getAlertSeverity(type),
            data,
            resolved: false
        };
        
        this.alerts.push(alert);
        this.emit('alert', alert);
        
        // Auto-resolve after timeout
        if (this.config.alertAutoResolve) {
            setTimeout(() => {
                alert.resolved = true;
                this.emit('alert:resolved', alert);
            }, this.config.alertResolveTimeout || 300000); // 5 minutes
        }
        
        return alert;
    }

    getAlertSeverity(type) {
        const severityMap = {
            high_error_rate: 'critical',
            slow_response: 'high',
            high_memory: 'high',
            high_cpu: 'high',
            anomaly_detected: 'medium',
            pattern_match: 'low'
        };
        
        return severityMap[type] || 'medium';
    }

    addToBuffer(logEntry) {
        this.logBuffer.push(logEntry);
        
        // Maintain buffer size
        if (this.logBuffer.length > this.config.maxBufferSize) {
            this.logBuffer.shift();
        }
    }

    startAggregation() {
        this.aggregationInterval = setInterval(() => {
            const aggregated = this.aggregateMetrics();
            this.emit('metrics:aggregated', aggregated);
        }, this.config.aggregationInterval);
    }

    aggregateMetrics() {
        const now = Date.now();
        const aggregated = {
            timestamp: now,
            window: this.config.windowSize,
            categories: {},
            metrics: {},
            trends: {}
        };
        
        // Aggregate category counts
        for (const [key, values] of this.metrics) {
            if (key.endsWith('_count')) {
                const category = key.replace('_count', '');
                aggregated.categories[category] = values.length;
            } else {
                // Aggregate numeric metrics
                if (values.length > 0) {
                    const sorted = values.map(v => v.value).sort((a, b) => a - b);
                    
                    aggregated.metrics[key] = {
                        count: values.length,
                        min: sorted[0],
                        max: sorted[sorted.length - 1],
                        avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
                        p50: sorted[Math.floor(sorted.length * 0.5)],
                        p95: sorted[Math.floor(sorted.length * 0.95)],
                        p99: sorted[Math.floor(sorted.length * 0.99)]
                    };
                    
                    // Calculate trend
                    aggregated.trends[key] = this.calculateTrend(values);
                }
            }
        }
        
        return aggregated;
    }

    calculateTrend(values) {
        if (values.length < 2) return 'stable';
        
        // Simple linear regression
        const n = values.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        
        values.forEach((v, i) => {
            sumX += i;
            sumY += v.value;
            sumXY += i * v.value;
            sumX2 += i * i;
        });
        
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        
        if (Math.abs(slope) < 0.01) return 'stable';
        return slope > 0 ? 'increasing' : 'decreasing';
    }

    // Machine Learning Integration
    initializeMLModels() {
        this.mlModels = {
            anomaly: this.createAnomalyDetector(),
            pattern: this.createPatternRecognizer(),
            forecast: this.createForecaster()
        };
    }

    createAnomalyDetector() {
        // Simplified anomaly detection using statistical methods
        return {
            detect: (logEntry) => {
                const anomalies = [];
                
                // Check for unusual patterns
                if (this.isUnusualPattern(logEntry)) {
                    anomalies.push({
                        type: 'unusual_pattern',
                        score: 0.8,
                        reason: 'Pattern not seen in recent history'
                    });
                }
                
                // Check for outlier metrics
                for (const [metric, value] of Object.entries(logEntry.metrics)) {
                    if (typeof value === 'number') {
                        const score = this.getOutlierScore(metric, value);
                        if (score > this.config.alertThresholds.anomalyScore) {
                            anomalies.push({
                                type: 'metric_outlier',
                                metric,
                                value,
                                score,
                                reason: `${metric} value is unusual`
                            });
                        }
                    }
                }
                
                return anomalies;
            }
        };
    }

    createPatternRecognizer() {
        return {
            recognize: (buffer) => {
                const patterns = [];
                
                // Look for repeating sequences
                const sequences = this.findRepeatingSequences(buffer);
                patterns.push(...sequences);
                
                // Look for correlated events
                const correlations = this.findCorrelations(buffer);
                patterns.push(...correlations);
                
                return patterns;
            }
        };
    }

    createForecaster() {
        return {
            forecast: (metric, horizon = 10) => {
                const values = this.metrics.get(metric) || [];
                if (values.length < 3) return null;
                
                // Simple moving average forecast
                const recent = values.slice(-10).map(v => v.value);
                const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
                
                const forecast = [];
                for (let i = 0; i < horizon; i++) {
                    forecast.push({
                        timestamp: Date.now() + (i + 1) * this.config.aggregationInterval,
                        value: avg,
                        confidence: 0.7 - (i * 0.05) // Decrease confidence over time
                    });
                }
                
                return forecast;
            }
        };
    }

    detectAnomalies(logEntry) {
        if (!this.mlModels?.anomaly) return [];
        return this.mlModels.anomaly.detect(logEntry);
    }

    isUnusualPattern(logEntry) {
        const pattern = logEntry.categories.join(':');
        const patternCount = this.patternCache.get(pattern) || 0;
        
        this.patternCache.set(pattern, patternCount + 1);
        
        // Unusual if seen less than 1% of the time
        const totalPatterns = Array.from(this.patternCache.values()).reduce((a, b) => a + b, 0);
        return patternCount / totalPatterns < 0.01;
    }

    getOutlierScore(metric, value) {
        const values = (this.metrics.get(metric) || []).map(v => v.value);
        if (values.length < 10) return 0;
        
        // Calculate z-score
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
        const stdDev = Math.sqrt(variance);
        
        if (stdDev === 0) return 0;
        
        const zScore = Math.abs((value - mean) / stdDev);
        
        // Convert to 0-1 score
        return Math.min(1, zScore / 3);
    }

    findRepeatingSequences(buffer, minLength = 3) {
        const sequences = [];
        const seen = new Map();
        
        for (let i = 0; i < buffer.length - minLength; i++) {
            for (let len = minLength; len <= 10 && i + len <= buffer.length; len++) {
                const sequence = buffer.slice(i, i + len)
                    .map(entry => entry.categories.join(':'))
                    .join('->');
                
                if (seen.has(sequence)) {
                    seen.set(sequence, seen.get(sequence) + 1);
                } else {
                    seen.set(sequence, 1);
                }
            }
        }
        
        // Find sequences that repeat
        for (const [sequence, count] of seen) {
            if (count > 2) {
                sequences.push({
                    type: 'repeating_sequence',
                    sequence,
                    count,
                    probability: count / buffer.length
                });
            }
        }
        
        return sequences;
    }

    findCorrelations(buffer) {
        const correlations = [];
        const events = {};
        
        // Group events by category
        buffer.forEach(entry => {
            entry.categories.forEach(category => {
                if (!events[category]) events[category] = [];
                events[category].push(entry.timestamp);
            });
        });
        
        // Find temporal correlations
        const categories = Object.keys(events);
        for (let i = 0; i < categories.length; i++) {
            for (let j = i + 1; j < categories.length; j++) {
                const correlation = this.calculateCorrelation(
                    events[categories[i]],
                    events[categories[j]]
                );
                
                if (correlation > 0.7) {
                    correlations.push({
                        type: 'temporal_correlation',
                        events: [categories[i], categories[j]],
                        correlation,
                        lag: this.findOptimalLag(events[categories[i]], events[categories[j]])
                    });
                }
            }
        }
        
        return correlations;
    }

    calculateCorrelation(times1, times2) {
        // Simplified correlation based on co-occurrence within time windows
        let coOccurrences = 0;
        const window = 5000; // 5 seconds
        
        times1.forEach(t1 => {
            if (times2.some(t2 => Math.abs(t2 - t1) < window)) {
                coOccurrences++;
            }
        });
        
        return coOccurrences / Math.max(times1.length, times2.length);
    }

    findOptimalLag(times1, times2) {
        // Find the most common time difference
        const lags = [];
        
        times1.forEach(t1 => {
            times2.forEach(t2 => {
                if (Math.abs(t2 - t1) < 10000) { // Within 10 seconds
                    lags.push(t2 - t1);
                }
            });
        });
        
        if (lags.length === 0) return 0;
        
        // Return median lag
        lags.sort((a, b) => a - b);
        return lags[Math.floor(lags.length / 2)];
    }

    getTotalMemory() {
        // Placeholder - would get from system
        return 8192; // 8GB in MB
    }

    exportAnalysis(format = 'json') {
        const analysis = {
            state: this.analysisState,
            metrics: this.aggregateMetrics(),
            alerts: this.alerts.filter(a => !a.resolved),
            patterns: this.mlModels?.pattern?.recognize(this.logBuffer) || [],
            timestamp: Date.now()
        };
        
        if (format === 'json') {
            return JSON.stringify(analysis, null, 2);
        } else if (format === 'csv') {
            // Convert to CSV format
            return this.convertToCSV(analysis);
        }
        
        return analysis;
    }

    convertToCSV(analysis) {
        // Simplified CSV conversion
        const rows = [];
        
        rows.push('Metric,Value');
        rows.push(`Total Logs,${analysis.state.totalLogs}`);
        rows.push(`Errors,${analysis.state.errorCount}`);
        rows.push(`Warnings,${analysis.state.warningCount}`);
        rows.push(`Anomalies,${analysis.state.anomalyCount}`);
        
        return rows.join('\n');
    }

    destroy() {
        if (this.aggregationInterval) {
            clearInterval(this.aggregationInterval);
        }
        
        for (const [name, config] of this.logStreams) {
            config.stream.unpipe(config.analyzer);
        }
        
        this.logStreams.clear();
        this.emit('destroyed');
    }
}

class LogAnalyzerTransform extends Transform {
    constructor(analyzer) {
        super({ objectMode: true });
        this.analyzer = analyzer;
        this.buffer = '';
    }

    _transform(chunk, encoding, callback) {
        this.buffer += chunk.toString();
        const lines = this.buffer.split('\n');
        
        // Keep last incomplete line in buffer
        this.buffer = lines.pop() || '';
        
        for (const line of lines) {
            if (line.trim()) {
                this.analyzer.analyzeLine(line);
            }
        }
        
        callback();
    }

    _flush(callback) {
        if (this.buffer.trim()) {
            this.analyzer.analyzeLine(this.buffer);
        }
        callback();
    }
}

module.exports = RealtimeLogAnalyzer;