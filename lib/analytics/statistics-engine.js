const { EventEmitter } = require('events');

/**
 * Advanced Statistics Engine
 * Real-time analytics and predictive modeling for mining operations
 */
class StatisticsEngine extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            // Time windows for analysis
            windows: {
                realtime: config.windows?.realtime || 300000, // 5 minutes
                short: config.windows?.short || 3600000, // 1 hour
                medium: config.windows?.medium || 86400000, // 24 hours
                long: config.windows?.long || 604800000 // 7 days
            },
            
            // Statistical parameters
            outlierThreshold: config.outlierThreshold || 3, // 3 standard deviations
            confidenceLevel: config.confidenceLevel || 0.95,
            
            // Features
            enablePrediction: config.enablePrediction !== false,
            enableAnomalyDetection: config.enableAnomalyDetection !== false,
            enableTrending: config.enableTrending !== false,
            
            // Data retention
            maxDataPoints: config.maxDataPoints || 100000,
            aggregationInterval: config.aggregationInterval || 60000, // 1 minute
            
            ...config
        };
        
        // Data storage
        this.timeSeries = new Map();
        this.aggregates = new Map();
        this.predictions = new Map();
        this.anomalies = [];
        
        // Statistical models
        this.models = {
            hashrate: null,
            efficiency: null,
            revenue: null
        };
        
        // Start aggregation
        this.startAggregation();
    }
    
    // Start data aggregation
    startAggregation() {
        this.aggregationTimer = setInterval(() => {
            this.performAggregation();
        }, this.config.aggregationInterval);
    }
    
    // Record metric
    recordMetric(name, value, tags = {}) {
        // Get or create time series
        let series = this.timeSeries.get(name);
        if (!series) {
            series = {
                data: [],
                tags: new Map(),
                stats: {}
            };
            this.timeSeries.set(name, series);
        }
        
        // Add data point
        const point = {
            timestamp: Date.now(),
            value,
            tags
        };
        
        series.data.push(point);
        
        // Update tag index
        for (const [key, val] of Object.entries(tags)) {
            if (!series.tags.has(key)) {
                series.tags.set(key, new Set());
            }
            series.tags.get(key).add(val);
        }
        
        // Maintain data limit
        if (series.data.length > this.config.maxDataPoints) {
            series.data = series.data.slice(-this.config.maxDataPoints);
        }
        
        // Update real-time stats
        this.updateRealtimeStats(name, series);
        
        // Check for anomalies
        if (this.config.enableAnomalyDetection) {
            this.detectAnomaly(name, value, series);
        }
        
        this.emit('metric-recorded', { name, value, tags });
    }
    
    // Update real-time statistics
    updateRealtimeStats(name, series) {
        const recentData = this.getRecentData(series.data, this.config.windows.realtime);
        
        if (recentData.length === 0) return;
        
        const values = recentData.map(d => d.value);
        
        series.stats = {
            count: values.length,
            sum: this.sum(values),
            mean: this.mean(values),
            median: this.median(values),
            stdDev: this.standardDeviation(values),
            min: Math.min(...values),
            max: Math.max(...values),
            p95: this.percentile(values, 95),
            p99: this.percentile(values, 99),
            trend: this.calculateTrend(recentData)
        };
    }
    
    // Perform aggregation
    performAggregation() {
        const now = Date.now();
        
        for (const [name, series] of this.timeSeries) {
            // Aggregate for each time window
            for (const [windowName, windowSize] of Object.entries(this.config.windows)) {
                const key = `${name}_${windowName}`;
                const data = this.getRecentData(series.data, windowSize);
                
                if (data.length === 0) continue;
                
                const aggregate = this.calculateAggregates(data);
                aggregate.window = windowName;
                aggregate.timestamp = now;
                
                // Store aggregate
                let aggregates = this.aggregates.get(key);
                if (!aggregates) {
                    aggregates = [];
                    this.aggregates.set(key, aggregates);
                }
                
                aggregates.push(aggregate);
                
                // Limit aggregate history
                if (aggregates.length > 1000) {
                    aggregates.shift();
                }
            }
            
            // Update predictions
            if (this.config.enablePrediction) {
                this.updatePredictions(name, series);
            }
        }
    }
    
    // Calculate aggregates
    calculateAggregates(data) {
        const values = data.map(d => d.value);
        const timestamps = data.map(d => d.timestamp);
        
        return {
            count: values.length,
            sum: this.sum(values),
            mean: this.mean(values),
            median: this.median(values),
            mode: this.mode(values),
            variance: this.variance(values),
            stdDev: this.standardDeviation(values),
            skewness: this.skewness(values),
            kurtosis: this.kurtosis(values),
            min: Math.min(...values),
            max: Math.max(...values),
            range: Math.max(...values) - Math.min(...values),
            iqr: this.interquartileRange(values),
            cv: this.coefficientOfVariation(values),
            percentiles: {
                p1: this.percentile(values, 1),
                p5: this.percentile(values, 5),
                p10: this.percentile(values, 10),
                p25: this.percentile(values, 25),
                p50: this.percentile(values, 50),
                p75: this.percentile(values, 75),
                p90: this.percentile(values, 90),
                p95: this.percentile(values, 95),
                p99: this.percentile(values, 99)
            },
            trend: this.calculateTrend(data),
            correlation: this.autocorrelation(values),
            firstTimestamp: Math.min(...timestamps),
            lastTimestamp: Math.max(...timestamps)
        };
    }
    
    // Detect anomalies
    detectAnomaly(name, value, series) {
        const stats = series.stats;
        if (!stats || stats.count < 30) return;
        
        // Z-score method
        const zScore = Math.abs((value - stats.mean) / stats.stdDev);
        
        if (zScore > this.config.outlierThreshold) {
            const anomaly = {
                metric: name,
                value,
                timestamp: Date.now(),
                zScore,
                expected: stats.mean,
                deviation: value - stats.mean,
                severity: zScore > 5 ? 'critical' : zScore > 4 ? 'high' : 'medium'
            };
            
            this.anomalies.push(anomaly);
            
            // Keep only recent anomalies
            const cutoff = Date.now() - this.config.windows.long;
            this.anomalies = this.anomalies.filter(a => a.timestamp > cutoff);
            
            this.emit('anomaly-detected', anomaly);
        }
    }
    
    // Update predictions
    updatePredictions(name, series) {
        const data = this.getRecentData(series.data, this.config.windows.medium);
        if (data.length < 10) return;
        
        try {
            // Simple linear regression for trend
            const trend = this.linearRegression(data);
            
            // Moving average for smoothing
            const ma = this.movingAverage(data.map(d => d.value), 5);
            
            // Exponential smoothing for forecast
            const forecast = this.exponentialSmoothing(data.map(d => d.value), 0.3);
            
            // ARIMA-like prediction (simplified)
            const prediction = this.simplifiedARIMA(data);
            
            this.predictions.set(name, {
                timestamp: Date.now(),
                trend,
                movingAverage: ma[ma.length - 1],
                forecast,
                nextHour: prediction.nextHour,
                nextDay: prediction.nextDay,
                confidence: prediction.confidence
            });
            
        } catch (error) {
            // Prediction failed
        }
    }
    
    // Statistical calculations
    sum(values) {
        return values.reduce((a, b) => a + b, 0);
    }
    
    mean(values) {
        return values.length > 0 ? this.sum(values) / values.length : 0;
    }
    
    median(values) {
        if (values.length === 0) return 0;
        const sorted = values.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    
    mode(values) {
        const counts = new Map();
        let maxCount = 0;
        let mode = null;
        
        for (const value of values) {
            const count = (counts.get(value) || 0) + 1;
            counts.set(value, count);
            
            if (count > maxCount) {
                maxCount = count;
                mode = value;
            }
        }
        
        return mode;
    }
    
    variance(values) {
        const avg = this.mean(values);
        const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
        return this.mean(squaredDiffs);
    }
    
    standardDeviation(values) {
        return Math.sqrt(this.variance(values));
    }
    
    skewness(values) {
        const n = values.length;
        if (n < 3) return 0;
        
        const mean = this.mean(values);
        const stdDev = this.standardDeviation(values);
        
        if (stdDev === 0) return 0;
        
        const sum = values.reduce((acc, v) => acc + Math.pow((v - mean) / stdDev, 3), 0);
        
        return (n / ((n - 1) * (n - 2))) * sum;
    }
    
    kurtosis(values) {
        const n = values.length;
        if (n < 4) return 0;
        
        const mean = this.mean(values);
        const stdDev = this.standardDeviation(values);
        
        if (stdDev === 0) return 0;
        
        const sum = values.reduce((acc, v) => acc + Math.pow((v - mean) / stdDev, 4), 0);
        
        return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum - 
               (3 * Math.pow(n - 1, 2)) / ((n - 2) * (n - 3));
    }
    
    percentile(values, p) {
        if (values.length === 0) return 0;
        const sorted = values.slice().sort((a, b) => a - b);
        const index = (p / 100) * (sorted.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const weight = index % 1;
        
        if (lower === upper) {
            return sorted[lower];
        }
        
        return sorted[lower] * (1 - weight) + sorted[upper] * weight;
    }
    
    interquartileRange(values) {
        return this.percentile(values, 75) - this.percentile(values, 25);
    }
    
    coefficientOfVariation(values) {
        const mean = this.mean(values);
        return mean === 0 ? 0 : this.standardDeviation(values) / mean;
    }
    
    // Trend calculation
    calculateTrend(data) {
        if (data.length < 2) return 'stable';
        
        const regression = this.linearRegression(data);
        const slope = regression.slope;
        const avgValue = this.mean(data.map(d => d.value));
        
        // Calculate trend strength (slope as percentage of average)
        const trendStrength = Math.abs(slope) / avgValue * 100;
        
        if (trendStrength < 1) return 'stable';
        if (slope > 0) return trendStrength > 5 ? 'increasing_fast' : 'increasing';
        return trendStrength > 5 ? 'decreasing_fast' : 'decreasing';
    }
    
    // Linear regression
    linearRegression(data) {
        const n = data.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        
        for (let i = 0; i < n; i++) {
            const x = i;
            const y = data[i].value;
            sumX += x;
            sumY += y;
            sumXY += x * y;
            sumX2 += x * x;
        }
        
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / n;
        
        // Calculate R-squared
        const yMean = sumY / n;
        let ssTotal = 0, ssResidual = 0;
        
        for (let i = 0; i < n; i++) {
            const yPred = slope * i + intercept;
            ssTotal += Math.pow(data[i].value - yMean, 2);
            ssResidual += Math.pow(data[i].value - yPred, 2);
        }
        
        const rSquared = 1 - (ssResidual / ssTotal);
        
        return { slope, intercept, rSquared };
    }
    
    // Moving average
    movingAverage(values, window) {
        const result = [];
        
        for (let i = 0; i < values.length; i++) {
            const start = Math.max(0, i - window + 1);
            const windowValues = values.slice(start, i + 1);
            result.push(this.mean(windowValues));
        }
        
        return result;
    }
    
    // Exponential smoothing
    exponentialSmoothing(values, alpha) {
        if (values.length === 0) return 0;
        
        let s = values[0];
        
        for (let i = 1; i < values.length; i++) {
            s = alpha * values[i] + (1 - alpha) * s;
        }
        
        return s;
    }
    
    // Autocorrelation
    autocorrelation(values, lag = 1) {
        if (values.length <= lag) return 0;
        
        const mean = this.mean(values);
        let numerator = 0;
        let denominator = 0;
        
        for (let i = 0; i < values.length - lag; i++) {
            numerator += (values[i] - mean) * (values[i + lag] - mean);
        }
        
        for (let i = 0; i < values.length; i++) {
            denominator += Math.pow(values[i] - mean, 2);
        }
        
        return denominator === 0 ? 0 : numerator / denominator;
    }
    
    // Simplified ARIMA prediction
    simplifiedARIMA(data) {
        const values = data.map(d => d.value);
        
        // Calculate components
        const trend = this.linearRegression(data);
        const detrended = values.map((v, i) => v - (trend.slope * i + trend.intercept));
        const ma = this.movingAverage(detrended, 3);
        const residuals = detrended.map((v, i) => v - ma[i]);
        
        // Simple forecast
        const lastIndex = values.length - 1;
        const trendComponent = trend.slope * (lastIndex + 1) + trend.intercept;
        const cyclicalComponent = ma[ma.length - 1];
        const noise = this.standardDeviation(residuals) * 0.5;
        
        const basePredict = trendComponent + cyclicalComponent;
        
        return {
            nextHour: basePredict * 1.02, // 2% growth assumption
            nextDay: basePredict * 1.15, // 15% growth assumption
            confidence: Math.min(0.95, trend.rSquared + 0.2)
        };
    }
    
    // Get recent data
    getRecentData(data, windowSize) {
        const cutoff = Date.now() - windowSize;
        return data.filter(d => d.timestamp > cutoff);
    }
    
    // Query time series data
    query(metric, options = {}) {
        const series = this.timeSeries.get(metric);
        if (!series) return [];
        
        let data = series.data;
        
        // Time range filter
        if (options.start) {
            data = data.filter(d => d.timestamp >= options.start);
        }
        if (options.end) {
            data = data.filter(d => d.timestamp <= options.end);
        }
        
        // Tag filter
        if (options.tags) {
            data = data.filter(d => {
                for (const [key, value] of Object.entries(options.tags)) {
                    if (d.tags[key] !== value) return false;
                }
                return true;
            });
        }
        
        // Aggregation
        if (options.aggregate) {
            return this.aggregateData(data, options.aggregate);
        }
        
        return data;
    }
    
    // Aggregate data
    aggregateData(data, interval) {
        const buckets = new Map();
        
        for (const point of data) {
            const bucket = Math.floor(point.timestamp / interval) * interval;
            
            if (!buckets.has(bucket)) {
                buckets.set(bucket, []);
            }
            
            buckets.get(bucket).push(point.value);
        }
        
        const aggregated = [];
        
        for (const [timestamp, values] of buckets) {
            aggregated.push({
                timestamp,
                value: this.mean(values),
                count: values.length,
                min: Math.min(...values),
                max: Math.max(...values)
            });
        }
        
        return aggregated.sort((a, b) => a.timestamp - b.timestamp);
    }
    
    // Get statistics summary
    getStatsSummary(metric, window = 'medium') {
        const series = this.timeSeries.get(metric);
        if (!series) return null;
        
        const windowSize = this.config.windows[window];
        const data = this.getRecentData(series.data, windowSize);
        
        if (data.length === 0) return null;
        
        const aggregates = this.calculateAggregates(data);
        const prediction = this.predictions.get(metric);
        
        return {
            metric,
            window,
            dataPoints: data.length,
            timeRange: {
                start: aggregates.firstTimestamp,
                end: aggregates.lastTimestamp
            },
            statistics: aggregates,
            trend: aggregates.trend,
            prediction: prediction || null,
            recentAnomalies: this.anomalies.filter(a => 
                a.metric === metric && 
                a.timestamp > Date.now() - windowSize
            ).length
        };
    }
    
    // Get correlation matrix
    getCorrelationMatrix(metrics) {
        const matrix = {};
        
        for (const metric1 of metrics) {
            matrix[metric1] = {};
            
            for (const metric2 of metrics) {
                if (metric1 === metric2) {
                    matrix[metric1][metric2] = 1;
                } else {
                    matrix[metric1][metric2] = this.calculateCorrelation(metric1, metric2);
                }
            }
        }
        
        return matrix;
    }
    
    // Calculate correlation between two metrics
    calculateCorrelation(metric1, metric2) {
        const series1 = this.timeSeries.get(metric1);
        const series2 = this.timeSeries.get(metric2);
        
        if (!series1 || !series2) return 0;
        
        // Find overlapping time periods
        const data1 = series1.data;
        const data2 = series2.data;
        
        const paired = [];
        
        for (const point1 of data1) {
            // Find closest point in time from series2
            const closest = data2.reduce((prev, curr) => {
                const prevDiff = Math.abs(prev.timestamp - point1.timestamp);
                const currDiff = Math.abs(curr.timestamp - point1.timestamp);
                return currDiff < prevDiff ? curr : prev;
            });
            
            // Only pair if within 1 minute
            if (Math.abs(closest.timestamp - point1.timestamp) < 60000) {
                paired.push({ x: point1.value, y: closest.value });
            }
        }
        
        if (paired.length < 10) return 0;
        
        // Calculate Pearson correlation
        const xMean = this.mean(paired.map(p => p.x));
        const yMean = this.mean(paired.map(p => p.y));
        
        let numerator = 0;
        let xDenominator = 0;
        let yDenominator = 0;
        
        for (const pair of paired) {
            const xDiff = pair.x - xMean;
            const yDiff = pair.y - yMean;
            
            numerator += xDiff * yDiff;
            xDenominator += xDiff * xDiff;
            yDenominator += yDiff * yDiff;
        }
        
        const denominator = Math.sqrt(xDenominator * yDenominator);
        
        return denominator === 0 ? 0 : numerator / denominator;
    }
    
    // Export data for external analysis
    exportData(metrics, format = 'csv') {
        const data = [];
        
        for (const metric of metrics) {
            const series = this.timeSeries.get(metric);
            if (!series) continue;
            
            for (const point of series.data) {
                data.push({
                    metric,
                    timestamp: point.timestamp,
                    value: point.value,
                    ...point.tags
                });
            }
        }
        
        if (format === 'csv') {
            return this.toCSV(data);
        } else if (format === 'json') {
            return JSON.stringify(data, null, 2);
        }
        
        return data;
    }
    
    // Convert to CSV
    toCSV(data) {
        if (data.length === 0) return '';
        
        const headers = Object.keys(data[0]);
        const rows = [headers.join(',')];
        
        for (const row of data) {
            rows.push(headers.map(h => row[h]).join(','));
        }
        
        return rows.join('\n');
    }
    
    // Shutdown
    shutdown() {
        if (this.aggregationTimer) {
            clearInterval(this.aggregationTimer);
        }
        
        this.removeAllListeners();
    }
}

module.exports = StatisticsEngine;