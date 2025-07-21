/**
 * Production Metrics System with Prometheus Export
 * 
 * Design principles:
 * - Carmack: Low overhead, lock-free where possible
 * - Martin: Clean metric types and aggregation
 * - Pike: Simple but powerful
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';

// Metric types
export const MetricType = {
  COUNTER: 'counter',
  GAUGE: 'gauge',
  HISTOGRAM: 'histogram',
  SUMMARY: 'summary'
};

// Time windows for aggregation
const TIME_WINDOWS = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000
};

/**
 * Counter metric - monotonically increasing value
 */
class Counter {
  constructor(name, help, labels = []) {
    this.name = name;
    this.help = help;
    this.labels = labels;
    this.values = new Map();
  }

  inc(labelValues = {}, value = 1) {
    const key = this.getLabelKey(labelValues);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  get(labelValues = {}) {
    const key = this.getLabelKey(labelValues);
    return this.values.get(key) || 0;
  }

  reset(labelValues = {}) {
    const key = this.getLabelKey(labelValues);
    this.values.set(key, 0);
  }

  getLabelKey(labelValues) {
    if (this.labels.length === 0) {
      return 'default';
    }
    
    return this.labels
      .map(label => `${label}="${labelValues[label] || ''}"`)
      .join(',');
  }

  collect() {
    const metrics = [];
    
    for (const [labels, value] of this.values) {
      metrics.push({
        name: this.name,
        type: MetricType.COUNTER,
        help: this.help,
        labels: labels === 'default' ? {} : this.parseLabelKey(labels),
        value
      });
    }
    
    return metrics;
  }

  parseLabelKey(key) {
    const result = {};
    const pairs = key.split(',');
    
    for (const pair of pairs) {
      const [label, value] = pair.split('=');
      result[label] = value.replace(/"/g, '');
    }
    
    return result;
  }
}

/**
 * Gauge metric - value that can go up or down
 */
class Gauge {
  constructor(name, help, labels = []) {
    this.name = name;
    this.help = help;
    this.labels = labels;
    this.values = new Map();
  }

  set(labelValues = {}, value) {
    const key = this.getLabelKey(labelValues);
    this.values.set(key, value);
  }

  inc(labelValues = {}, value = 1) {
    const key = this.getLabelKey(labelValues);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  dec(labelValues = {}, value = 1) {
    const key = this.getLabelKey(labelValues);
    const current = this.values.get(key) || 0;
    this.values.set(key, current - value);
  }

  get(labelValues = {}) {
    const key = this.getLabelKey(labelValues);
    return this.values.get(key) || 0;
  }

  getLabelKey(labelValues) {
    if (this.labels.length === 0) {
      return 'default';
    }
    
    return this.labels
      .map(label => `${label}="${labelValues[label] || ''}"`)
      .join(',');
  }

  collect() {
    const metrics = [];
    
    for (const [labels, value] of this.values) {
      metrics.push({
        name: this.name,
        type: MetricType.GAUGE,
        help: this.help,
        labels: labels === 'default' ? {} : this.parseLabelKey(labels),
        value
      });
    }
    
    return metrics;
  }

  parseLabelKey(key) {
    const result = {};
    const pairs = key.split(',');
    
    for (const pair of pairs) {
      const [label, value] = pair.split('=');
      result[label] = value.replace(/"/g, '');
    }
    
    return result;
  }
}

/**
 * Histogram metric - distribution of values
 */
class Histogram {
  constructor(name, help, buckets = null, labels = []) {
    this.name = name;
    this.help = help;
    this.labels = labels;
    this.buckets = buckets || [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
    this.values = new Map();
  }

  observe(labelValues = {}, value) {
    const key = this.getLabelKey(labelValues);
    
    if (!this.values.has(key)) {
      this.values.set(key, {
        buckets: new Array(this.buckets.length).fill(0),
        count: 0,
        sum: 0
      });
    }
    
    const data = this.values.get(key);
    
    // Update buckets
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        data.buckets[i]++;
      }
    }
    
    // Update count and sum
    data.count++;
    data.sum += value;
  }

  getLabelKey(labelValues) {
    if (this.labels.length === 0) {
      return 'default';
    }
    
    return this.labels
      .map(label => `${label}="${labelValues[label] || ''}"`)
      .join(',');
  }

  collect() {
    const metrics = [];
    
    for (const [labels, data] of this.values) {
      const labelObj = labels === 'default' ? {} : this.parseLabelKey(labels);
      
      // Bucket metrics
      for (let i = 0; i < this.buckets.length; i++) {
        metrics.push({
          name: `${this.name}_bucket`,
          type: MetricType.COUNTER,
          help: `${this.help} (bucket)`,
          labels: { ...labelObj, le: this.buckets[i].toString() },
          value: data.buckets[i]
        });
      }
      
      // +Inf bucket
      metrics.push({
        name: `${this.name}_bucket`,
        type: MetricType.COUNTER,
        help: `${this.help} (bucket)`,
        labels: { ...labelObj, le: '+Inf' },
        value: data.count
      });
      
      // Count
      metrics.push({
        name: `${this.name}_count`,
        type: MetricType.COUNTER,
        help: `${this.help} (count)`,
        labels: labelObj,
        value: data.count
      });
      
      // Sum
      metrics.push({
        name: `${this.name}_sum`,
        type: MetricType.COUNTER,
        help: `${this.help} (sum)`,
        labels: labelObj,
        value: data.sum
      });
    }
    
    return metrics;
  }

  parseLabelKey(key) {
    const result = {};
    const pairs = key.split(',');
    
    for (const pair of pairs) {
      const [label, value] = pair.split('=');
      result[label] = value.replace(/"/g, '');
    }
    
    return result;
  }
}

/**
 * Summary metric - like histogram but with quantiles
 */
class Summary {
  constructor(name, help, quantiles = null, labels = [], maxAge = 600000) {
    this.name = name;
    this.help = help;
    this.labels = labels;
    this.quantiles = quantiles || [0.5, 0.9, 0.95, 0.99];
    this.maxAge = maxAge; // 10 minutes default
    this.values = new Map();
  }

  observe(labelValues = {}, value) {
    const key = this.getLabelKey(labelValues);
    const now = Date.now();
    
    if (!this.values.has(key)) {
      this.values.set(key, {
        observations: [],
        count: 0,
        sum: 0
      });
    }
    
    const data = this.values.get(key);
    
    // Add observation with timestamp
    data.observations.push({ value, time: now });
    data.count++;
    data.sum += value;
    
    // Clean old observations
    const cutoff = now - this.maxAge;
    data.observations = data.observations.filter(obs => obs.time > cutoff);
  }

  getLabelKey(labelValues) {
    if (this.labels.length === 0) {
      return 'default';
    }
    
    return this.labels
      .map(label => `${label}="${labelValues[label] || ''}"`)
      .join(',');
  }

  calculateQuantile(values, quantile) {
    if (values.length === 0) return 0;
    
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * quantile) - 1;
    return sorted[Math.max(0, index)];
  }

  collect() {
    const metrics = [];
    
    for (const [labels, data] of this.values) {
      const labelObj = labels === 'default' ? {} : this.parseLabelKey(labels);
      const values = data.observations.map(obs => obs.value);
      
      // Quantile metrics
      for (const quantile of this.quantiles) {
        metrics.push({
          name: this.name,
          type: MetricType.GAUGE,
          help: this.help,
          labels: { ...labelObj, quantile: quantile.toString() },
          value: this.calculateQuantile(values, quantile)
        });
      }
      
      // Count
      metrics.push({
        name: `${this.name}_count`,
        type: MetricType.COUNTER,
        help: `${this.help} (count)`,
        labels: labelObj,
        value: data.count
      });
      
      // Sum
      metrics.push({
        name: `${this.name}_sum`,
        type: MetricType.COUNTER,
        help: `${this.help} (sum)`,
        labels: labelObj,
        value: data.sum
      });
    }
    
    return metrics;
  }

  parseLabelKey(key) {
    const result = {};
    const pairs = key.split(',');
    
    for (const pair of pairs) {
      const [label, value] = pair.split('=');
      result[label] = value.replace(/"/g, '');
    }
    
    return result;
  }
}

/**
 * Production Metrics System
 */
export class MetricsSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.prefix = options.prefix || 'otedama';
    this.defaultLabels = options.defaultLabels || {};
    this.collectInterval = options.collectInterval || 10000; // 10 seconds
    
    // Metric storage
    this.metrics = new Map();
    
    // Built-in metrics
    this.initializeBuiltinMetrics();
    
    // Collection timer
    this.collectionTimer = null;
    if (options.autoCollect !== false) {
      this.startAutoCollection();
    }
  }

  /**
   * Initialize built-in system metrics
   */
  initializeBuiltinMetrics() {
    // Process metrics
    this.register('process_cpu_seconds_total', 'Total CPU time spent', MetricType.COUNTER);
    this.register('process_memory_bytes', 'Process memory usage', MetricType.GAUGE, ['type']);
    this.register('process_gc_duration_seconds', 'GC duration', MetricType.HISTOGRAM);
    this.register('process_handles_total', 'Number of handles', MetricType.GAUGE);
    this.register('process_requests_total', 'Number of requests', MetricType.COUNTER);
    
    // Node.js metrics
    this.register('nodejs_version_info', 'Node.js version', MetricType.GAUGE);
    this.register('nodejs_eventloop_lag_seconds', 'Event loop lag', MetricType.GAUGE);
    this.register('nodejs_active_handles_total', 'Active handles', MetricType.GAUGE);
    this.register('nodejs_active_requests_total', 'Active requests', MetricType.GAUGE);
    
    // Application metrics
    this.register('http_request_duration_seconds', 'HTTP request duration', MetricType.HISTOGRAM, ['method', 'route', 'status']);
    this.register('http_requests_total', 'Total HTTP requests', MetricType.COUNTER, ['method', 'route', 'status']);
    this.register('websocket_connections', 'WebSocket connections', MetricType.GAUGE, ['type']);
    this.register('database_connections', 'Database connections', MetricType.GAUGE, ['state']);
    this.register('cache_operations_total', 'Cache operations', MetricType.COUNTER, ['operation', 'result']);
    
    // Business metrics
    this.register('mining_hashrate', 'Mining hashrate', MetricType.GAUGE, ['algorithm']);
    this.register('mining_shares_total', 'Mining shares', MetricType.COUNTER, ['result']);
    this.register('dex_orders_total', 'DEX orders', MetricType.COUNTER, ['side', 'status']);
    this.register('dex_volume_total', 'DEX volume', MetricType.COUNTER, ['pair']);
    this.register('defi_tvl', 'DeFi total value locked', MetricType.GAUGE, ['pool']);
  }

  /**
   * Register a new metric
   */
  register(name, help, type = MetricType.COUNTER, labels = []) {
    const fullName = `${this.prefix}_${name}`;
    
    if (this.metrics.has(fullName)) {
      throw new Error(`Metric ${fullName} already registered`);
    }
    
    let metric;
    
    switch (type) {
      case MetricType.COUNTER:
        metric = new Counter(fullName, help, labels);
        break;
        
      case MetricType.GAUGE:
        metric = new Gauge(fullName, help, labels);
        break;
        
      case MetricType.HISTOGRAM:
        metric = new Histogram(fullName, help, null, labels);
        break;
        
      case MetricType.SUMMARY:
        metric = new Summary(fullName, help, null, labels);
        break;
        
      default:
        throw new Error(`Unknown metric type: ${type}`);
    }
    
    this.metrics.set(fullName, metric);
    return metric;
  }

  /**
   * Get or create metric
   */
  getMetric(name, type, help, labels) {
    const fullName = `${this.prefix}_${name}`;
    
    if (!this.metrics.has(fullName)) {
      return this.register(name, help || name, type, labels);
    }
    
    return this.metrics.get(fullName);
  }

  /**
   * Increment counter
   */
  inc(name, labelValues = {}, value = 1) {
    const metric = this.getMetric(name, MetricType.COUNTER, name);
    metric.inc(labelValues, value);
  }

  /**
   * Set gauge value
   */
  set(name, labelValues = {}, value) {
    const metric = this.getMetric(name, MetricType.GAUGE, name);
    metric.set(labelValues, value);
  }

  /**
   * Record histogram observation
   */
  observe(name, labelValues = {}, value) {
    const metric = this.getMetric(name, MetricType.HISTOGRAM, name);
    metric.observe(labelValues, value);
  }

  /**
   * Time a function execution
   */
  async time(name, labelValues = {}, fn) {
    const start = performance.now();
    
    try {
      const result = await fn();
      const duration = (performance.now() - start) / 1000; // Convert to seconds
      this.observe(name, labelValues, duration);
      return result;
    } catch (error) {
      const duration = (performance.now() - start) / 1000;
      this.observe(name, { ...labelValues, error: 'true' }, duration);
      throw error;
    }
  }

  /**
   * Collect system metrics
   */
  collectSystemMetrics() {
    // CPU usage
    const cpuUsage = process.cpuUsage();
    this.set('process_cpu_seconds_total', {}, (cpuUsage.user + cpuUsage.system) / 1000000);
    
    // Memory usage
    const memUsage = process.memoryUsage();
    this.set('process_memory_bytes', { type: 'rss' }, memUsage.rss);
    this.set('process_memory_bytes', { type: 'heap_total' }, memUsage.heapTotal);
    this.set('process_memory_bytes', { type: 'heap_used' }, memUsage.heapUsed);
    this.set('process_memory_bytes', { type: 'external' }, memUsage.external);
    
    // Event loop lag
    const start = performance.now();
    setImmediate(() => {
      const lag = (performance.now() - start) / 1000;
      this.set('nodejs_eventloop_lag_seconds', {}, lag);
    });
    
    // Active handles and requests
    if (process._getActiveHandles) {
      this.set('nodejs_active_handles_total', {}, process._getActiveHandles().length);
    }
    
    if (process._getActiveRequests) {
      this.set('nodejs_active_requests_total', {}, process._getActiveRequests().length);
    }
    
    // Node.js version
    this.set('nodejs_version_info', { version: process.version }, 1);
  }

  /**
   * Start automatic metric collection
   */
  startAutoCollection() {
    this.collectionTimer = setInterval(() => {
      this.collectSystemMetrics();
      this.emit('collect');
    }, this.collectInterval);
  }

  /**
   * Stop automatic metric collection
   */
  stopAutoCollection() {
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
      this.collectionTimer = null;
    }
  }

  /**
   * Export metrics in Prometheus format
   */
  exportPrometheus() {
    const lines = [];
    const timestamp = Date.now();
    
    // Collect all metrics
    const allMetrics = [];
    for (const metric of this.metrics.values()) {
      allMetrics.push(...metric.collect());
    }
    
    // Group by metric name
    const grouped = new Map();
    for (const metric of allMetrics) {
      if (!grouped.has(metric.name)) {
        grouped.set(metric.name, {
          type: metric.type,
          help: metric.help,
          metrics: []
        });
      }
      grouped.get(metric.name).metrics.push(metric);
    }
    
    // Format output
    for (const [name, data] of grouped) {
      // Add help text
      lines.push(`# HELP ${name} ${data.help}`);
      
      // Add type
      lines.push(`# TYPE ${name} ${data.type}`);
      
      // Add metrics
      for (const metric of data.metrics) {
        const labels = { ...this.defaultLabels, ...metric.labels };
        const labelStr = Object.entries(labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(',');
        
        const line = labelStr ? 
          `${metric.name}{${labelStr}} ${metric.value}` :
          `${metric.name} ${metric.value}`;
          
        lines.push(line);
      }
      
      lines.push(''); // Empty line between metrics
    }
    
    return lines.join('\n');
  }

  /**
   * Export metrics as JSON
   */
  exportJSON() {
    const metrics = [];
    
    for (const metric of this.metrics.values()) {
      metrics.push(...metric.collect());
    }
    
    return {
      timestamp: Date.now(),
      metrics
    };
  }

  /**
   * Reset all metrics
   */
  reset() {
    for (const metric of this.metrics.values()) {
      if (metric instanceof Counter) {
        metric.values.clear();
      }
    }
  }

  /**
   * Get metric statistics
   */
  getStats() {
    const stats = {
      metrics: this.metrics.size,
      counters: 0,
      gauges: 0,
      histograms: 0,
      summaries: 0
    };
    
    for (const metric of this.metrics.values()) {
      if (metric instanceof Counter) stats.counters++;
      else if (metric instanceof Gauge) stats.gauges++;
      else if (metric instanceof Histogram) stats.histograms++;
      else if (metric instanceof Summary) stats.summaries++;
    }
    
    return stats;
  }

  /**
   * Shutdown metrics system
   */
  shutdown() {
    this.stopAutoCollection();
    this.metrics.clear();
    this.emit('shutdown');
  }
}

// Global metrics instance
export const metrics = new MetricsSystem({
  prefix: 'otedama',
  defaultLabels: {
    instance: process.env.INSTANCE_NAME || 'default',
    environment: process.env.NODE_ENV || 'development'
  }
});

// Convenience exports
export const inc = metrics.inc.bind(metrics);
export const set = metrics.set.bind(metrics);
export const observe = metrics.observe.bind(metrics);
export const time = metrics.time.bind(metrics);

// Default export
export default MetricsSystem;
