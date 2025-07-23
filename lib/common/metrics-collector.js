const { EventEmitter } = require('events');

/**
 * Unified metrics collection for all services
 */
class MetricsCollector extends EventEmitter {
  constructor(serviceName, config = {}) {
    super();
    
    this.serviceName = serviceName;
    this.config = {
      // Collection settings
      flushInterval: config.flushInterval || 60000, // 1 minute
      maxMetricsAge: config.maxMetricsAge || 3600000, // 1 hour
      enableHistogram: config.enableHistogram !== false,
      histogramBuckets: config.histogramBuckets || [0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000],
      
      // Aggregation
      enableAggregation: config.enableAggregation !== false,
      aggregationWindow: config.aggregationWindow || 300000, // 5 minutes
      
      // Export
      exportFormat: config.exportFormat || 'prometheus', // 'prometheus', 'json', 'statsd'
      
      ...config
    };
    
    // Metric stores
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    this.summaries = new Map();
    
    // Time series data
    this.timeSeries = new Map();
    
    // Aggregated metrics
    this.aggregated = new Map();
    
    // Start flush timer
    this.startFlushTimer();
  }
  
  /**
   * Increment a counter
   */
  increment(name, value = 1, labels = {}) {
    const key = this.getMetricKey(name, labels);
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + value);
    
    // Track time series
    this.recordTimeSeries(name, current + value, labels, 'counter');
  }
  
  /**
   * Decrement a counter
   */
  decrement(name, value = 1, labels = {}) {
    this.increment(name, -value, labels);
  }
  
  /**
   * Set a gauge value
   */
  gauge(name, value, labels = {}) {
    const key = this.getMetricKey(name, labels);
    this.gauges.set(key, value);
    
    // Track time series
    this.recordTimeSeries(name, value, labels, 'gauge');
  }
  
  /**
   * Record a histogram value
   */
  histogram(name, value, labels = {}) {
    const key = this.getMetricKey(name, labels);
    
    if (!this.histograms.has(key)) {
      this.histograms.set(key, this.createHistogram());
    }
    
    const hist = this.histograms.get(key);
    hist.values.push(value);
    hist.count++;
    hist.sum += value;
    
    // Update buckets
    for (let i = 0; i < this.config.histogramBuckets.length; i++) {
      if (value <= this.config.histogramBuckets[i]) {
        hist.buckets[i]++;
      }
    }
    
    // Track time series
    this.recordTimeSeries(name, value, labels, 'histogram');
  }
  
  /**
   * Record a summary value
   */
  summary(name, value, labels = {}) {
    const key = this.getMetricKey(name, labels);
    
    if (!this.summaries.has(key)) {
      this.summaries.set(key, this.createSummary());
    }
    
    const summary = this.summaries.get(key);
    summary.values.push(value);
    summary.count++;
    summary.sum += value;
    
    // Maintain sorted order for percentile calculation
    summary.values.sort((a, b) => a - b);
    
    // Keep only recent values (sliding window)
    const maxValues = 1000;
    if (summary.values.length > maxValues) {
      summary.values = summary.values.slice(-maxValues);
    }
    
    // Track time series
    this.recordTimeSeries(name, value, labels, 'summary');
  }
  
  /**
   * Start timing
   */
  startTimer(name, labels = {}) {
    const startTime = process.hrtime.bigint();
    
    return {
      end: () => {
        const endTime = process.hrtime.bigint();
        const duration = Number(endTime - startTime) / 1e6; // Convert to milliseconds
        this.histogram(name, duration, labels);
        return duration;
      }
    };
  }
  
  /**
   * Create histogram structure
   */
  createHistogram() {
    return {
      values: [],
      count: 0,
      sum: 0,
      buckets: new Array(this.config.histogramBuckets.length).fill(0),
      lastReset: Date.now()
    };
  }
  
  /**
   * Create summary structure
   */
  createSummary() {
    return {
      values: [],
      count: 0,
      sum: 0,
      lastReset: Date.now()
    };
  }
  
  /**
   * Get metric key
   */
  getMetricKey(name, labels) {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    
    return labelStr ? `${name}{${labelStr}}` : name;
  }
  
  /**
   * Record time series data
   */
  recordTimeSeries(name, value, labels, type) {
    if (!this.config.enableAggregation) return;
    
    const key = this.getMetricKey(name, labels);
    const timestamp = Date.now();
    
    if (!this.timeSeries.has(key)) {
      this.timeSeries.set(key, {
        name,
        labels,
        type,
        data: []
      });
    }
    
    const series = this.timeSeries.get(key);
    series.data.push({ timestamp, value });
    
    // Clean old data
    const cutoff = timestamp - this.config.maxMetricsAge;
    series.data = series.data.filter(point => point.timestamp > cutoff);
  }
  
  /**
   * Calculate percentile
   */
  calculatePercentile(values, percentile) {
    if (values.length === 0) return 0;
    
    const index = Math.ceil(values.length * percentile / 100) - 1;
    return values[Math.max(0, index)];
  }
  
  /**
   * Get all metrics
   */
  getAllMetrics() {
    const metrics = {
      service: this.serviceName,
      timestamp: Date.now(),
      counters: {},
      gauges: {},
      histograms: {},
      summaries: {}
    };
    
    // Counters
    for (const [key, value] of this.counters) {
      metrics.counters[key] = value;
    }
    
    // Gauges
    for (const [key, value] of this.gauges) {
      metrics.gauges[key] = value;
    }
    
    // Histograms
    for (const [key, hist] of this.histograms) {
      const values = hist.values;
      metrics.histograms[key] = {
        count: hist.count,
        sum: hist.sum,
        min: Math.min(...values) || 0,
        max: Math.max(...values) || 0,
        mean: hist.count > 0 ? hist.sum / hist.count : 0,
        p50: this.calculatePercentile(values, 50),
        p90: this.calculatePercentile(values, 90),
        p95: this.calculatePercentile(values, 95),
        p99: this.calculatePercentile(values, 99),
        buckets: hist.buckets.map((count, i) => ({
          le: this.config.histogramBuckets[i],
          count
        }))
      };
    }
    
    // Summaries
    for (const [key, summary] of this.summaries) {
      const values = summary.values;
      metrics.summaries[key] = {
        count: summary.count,
        sum: summary.sum,
        min: Math.min(...values) || 0,
        max: Math.max(...values) || 0,
        mean: summary.count > 0 ? summary.sum / summary.count : 0,
        p50: this.calculatePercentile(values, 50),
        p90: this.calculatePercentile(values, 90),
        p95: this.calculatePercentile(values, 95),
        p99: this.calculatePercentile(values, 99)
      };
    }
    
    return metrics;
  }
  
  /**
   * Export metrics in Prometheus format
   */
  exportPrometheus() {
    const lines = [];
    const timestamp = Date.now();
    
    // Counters
    for (const [key, value] of this.counters) {
      lines.push(`${this.serviceName}_${key} ${value} ${timestamp}`);
    }
    
    // Gauges
    for (const [key, value] of this.gauges) {
      lines.push(`${this.serviceName}_${key} ${value} ${timestamp}`);
    }
    
    // Histograms
    for (const [key, hist] of this.histograms) {
      const baseName = key.split('{')[0];
      const labels = key.includes('{') ? key.split('{')[1].replace('}', '') : '';
      
      // Buckets
      hist.buckets.forEach((count, i) => {
        const bucket = this.config.histogramBuckets[i];
        const bucketLabels = labels ? `${labels},le="${bucket}"` : `le="${bucket}"`;
        lines.push(`${this.serviceName}_${baseName}_bucket{${bucketLabels}} ${count} ${timestamp}`);
      });
      
      // Sum and count
      const sumLabels = labels ? `{${labels}}` : '';
      lines.push(`${this.serviceName}_${baseName}_sum${sumLabels} ${hist.sum} ${timestamp}`);
      lines.push(`${this.serviceName}_${baseName}_count${sumLabels} ${hist.count} ${timestamp}`);
    }
    
    // Summaries
    for (const [key, summary] of this.summaries) {
      const baseName = key.split('{')[0];
      const labels = key.includes('{') ? key.split('{')[1].replace('}', '') : '';
      
      // Quantiles
      const quantiles = [
        { q: 0.5, v: this.calculatePercentile(summary.values, 50) },
        { q: 0.9, v: this.calculatePercentile(summary.values, 90) },
        { q: 0.95, v: this.calculatePercentile(summary.values, 95) },
        { q: 0.99, v: this.calculatePercentile(summary.values, 99) }
      ];
      
      quantiles.forEach(({ q, v }) => {
        const quantileLabels = labels ? `${labels},quantile="${q}"` : `quantile="${q}"`;
        lines.push(`${this.serviceName}_${baseName}{${quantileLabels}} ${v} ${timestamp}`);
      });
      
      // Sum and count
      const sumLabels = labels ? `{${labels}}` : '';
      lines.push(`${this.serviceName}_${baseName}_sum${sumLabels} ${summary.sum} ${timestamp}`);
      lines.push(`${this.serviceName}_${baseName}_count${sumLabels} ${summary.count} ${timestamp}`);
    }
    
    return lines.join('\n');
  }
  
  /**
   * Aggregate time series data
   */
  aggregateTimeSeries() {
    const now = Date.now();
    const windowStart = now - this.config.aggregationWindow;
    
    for (const [key, series] of this.timeSeries) {
      const recentData = series.data.filter(point => point.timestamp >= windowStart);
      
      if (recentData.length === 0) continue;
      
      const values = recentData.map(p => p.value);
      const aggregated = {
        name: series.name,
        labels: series.labels,
        type: series.type,
        window: {
          start: windowStart,
          end: now
        },
        stats: {
          count: values.length,
          sum: values.reduce((a, b) => a + b, 0),
          min: Math.min(...values),
          max: Math.max(...values),
          mean: values.reduce((a, b) => a + b, 0) / values.length,
          stdDev: this.calculateStdDev(values)
        }
      };
      
      this.aggregated.set(key, aggregated);
    }
  }
  
  /**
   * Calculate standard deviation
   */
  calculateStdDev(values) {
    if (values.length === 0) return 0;
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    
    return Math.sqrt(variance);
  }
  
  /**
   * Start flush timer
   */
  startFlushTimer() {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.config.flushInterval);
  }
  
  /**
   * Flush metrics
   */
  flush() {
    // Aggregate time series
    if (this.config.enableAggregation) {
      this.aggregateTimeSeries();
    }
    
    // Emit metrics
    this.emit('metrics', this.getAllMetrics());
    
    // Export in configured format
    switch (this.config.exportFormat) {
      case 'prometheus':
        this.emit('export', this.exportPrometheus());
        break;
      case 'json':
        this.emit('export', JSON.stringify(this.getAllMetrics()));
        break;
    }
    
    // Reset histograms and summaries if needed
    const now = Date.now();
    for (const [key, hist] of this.histograms) {
      if (now - hist.lastReset > this.config.aggregationWindow) {
        hist.values = [];
        hist.count = 0;
        hist.sum = 0;
        hist.buckets.fill(0);
        hist.lastReset = now;
      }
    }
    
    for (const [key, summary] of this.summaries) {
      if (now - summary.lastReset > this.config.aggregationWindow) {
        summary.values = [];
        summary.count = 0;
        summary.sum = 0;
        summary.lastReset = now;
      }
    }
  }
  
  /**
   * Reset all metrics
   */
  reset() {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.summaries.clear();
    this.timeSeries.clear();
    this.aggregated.clear();
  }
  
  /**
   * Stop metrics collection
   */
  stop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

module.exports = MetricsCollector;