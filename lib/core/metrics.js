/**
 * Metrics & Monitoring - Otedama
 * Prometheus-compatible metrics and monitoring
 * 
 * Design: Observe everything, alert on what matters (Carmack)
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from './structured-logger.js';

const logger = createStructuredLogger('Metrics');

/**
 * Metric types
 */
export const MetricType = {
  COUNTER: 'counter',
  GAUGE: 'gauge',
  HISTOGRAM: 'histogram',
  SUMMARY: 'summary'
};

/**
 * Base metric class
 */
export class Metric {
  constructor(name, help, labels = []) {
    this.name = name;
    this.help = help;
    this.labels = labels;
    this.type = MetricType.COUNTER;
    this.values = new Map();
  }
  
  getLabelKey(labels = {}) {
    if (this.labels.length === 0) return '';
    
    const values = this.labels.map(label => labels[label] || '');
    return values.join(',');
  }
  
  getOrCreateValue(labels = {}) {
    const key = this.getLabelKey(labels);
    
    if (!this.values.has(key)) {
      this.values.set(key, this.createValue());
    }
    
    return this.values.get(key);
  }
  
  createValue() {
    return { value: 0 };
  }
  
  collect() {
    const samples = [];
    
    for (const [labelKey, data] of this.values) {
      const labels = {};
      
      if (labelKey) {
        const values = labelKey.split(',');
        this.labels.forEach((label, i) => {
          if (values[i]) labels[label] = values[i];
        });
      }
      
      samples.push({
        name: this.name,
        labels,
        value: data.value
      });
    }
    
    return {
      name: this.name,
      help: this.help,
      type: this.type,
      samples
    };
  }
  
  reset() {
    this.values.clear();
  }
}

/**
 * Counter metric
 */
export class Counter extends Metric {
  constructor(name, help, labels) {
    super(name, help, labels);
    this.type = MetricType.COUNTER;
  }
  
  inc(labels = {}, value = 1) {
    if (value < 0) {
      throw new Error('Counter can only increase');
    }
    
    const data = this.getOrCreateValue(labels);
    data.value += value;
  }
  
  get(labels = {}) {
    const data = this.getOrCreateValue(labels);
    return data.value;
  }
}

/**
 * Gauge metric
 */
export class Gauge extends Metric {
  constructor(name, help, labels) {
    super(name, help, labels);
    this.type = MetricType.GAUGE;
  }
  
  set(labels, value) {
    if (typeof labels === 'number') {
      value = labels;
      labels = {};
    }
    
    const data = this.getOrCreateValue(labels);
    data.value = value;
  }
  
  inc(labels = {}, value = 1) {
    const data = this.getOrCreateValue(labels);
    data.value += value;
  }
  
  dec(labels = {}, value = 1) {
    const data = this.getOrCreateValue(labels);
    data.value -= value;
  }
  
  get(labels = {}) {
    const data = this.getOrCreateValue(labels);
    return data.value;
  }
}

/**
 * Histogram metric
 */
export class Histogram extends Metric {
  constructor(name, help, labels, buckets) {
    super(name, help, labels);
    this.type = MetricType.HISTOGRAM;
    this.buckets = buckets || [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
  }
  
  createValue() {
    const bucketCounts = {};
    this.buckets.forEach(bucket => {
      bucketCounts[bucket] = 0;
    });
    
    return {
      buckets: bucketCounts,
      sum: 0,
      count: 0
    };
  }
  
  observe(labels, value) {
    if (typeof labels === 'number') {
      value = labels;
      labels = {};
    }
    
    const data = this.getOrCreateValue(labels);
    
    // Update buckets
    for (const bucket of this.buckets) {
      if (value <= bucket) {
        data.buckets[bucket]++;
      }
    }
    
    // Update sum and count
    data.sum += value;
    data.count++;
  }
  
  collect() {
    const samples = [];
    
    for (const [labelKey, data] of this.values) {
      const labels = {};
      
      if (labelKey) {
        const values = labelKey.split(',');
        this.labels.forEach((label, i) => {
          if (values[i]) labels[label] = values[i];
        });
      }
      
      // Bucket samples
      for (const [bucket, count] of Object.entries(data.buckets)) {
        samples.push({
          name: `${this.name}_bucket`,
          labels: { ...labels, le: bucket },
          value: count
        });
      }
      
      // +Inf bucket
      samples.push({
        name: `${this.name}_bucket`,
        labels: { ...labels, le: '+Inf' },
        value: data.count
      });
      
      // Sum
      samples.push({
        name: `${this.name}_sum`,
        labels,
        value: data.sum
      });
      
      // Count
      samples.push({
        name: `${this.name}_count`,
        labels,
        value: data.count
      });
    }
    
    return {
      name: this.name,
      help: this.help,
      type: this.type,
      samples
    };
  }
}

/**
 * Summary metric
 */
export class Summary extends Metric {
  constructor(name, help, labels, percentiles, window) {
    super(name, help, labels);
    this.type = MetricType.SUMMARY;
    this.percentiles = percentiles || [0.5, 0.9, 0.95, 0.99];
    this.window = window || 600000; // 10 minutes
  }
  
  createValue() {
    return {
      values: [],
      sum: 0,
      count: 0
    };
  }
  
  observe(labels, value) {
    if (typeof labels === 'number') {
      value = labels;
      labels = {};
    }
    
    const data = this.getOrCreateValue(labels);
    const now = Date.now();
    
    // Add value with timestamp
    data.values.push({ value, timestamp: now });
    
    // Remove old values
    const cutoff = now - this.window;
    data.values = data.values.filter(v => v.timestamp > cutoff);
    
    // Update sum and count
    data.sum = data.values.reduce((sum, v) => sum + v.value, 0);
    data.count = data.values.length;
  }
  
  collect() {
    const samples = [];
    
    for (const [labelKey, data] of this.values) {
      const labels = {};
      
      if (labelKey) {
        const values = labelKey.split(',');
        this.labels.forEach((label, i) => {
          if (values[i]) labels[label] = values[i];
        });
      }
      
      if (data.values.length > 0) {
        // Calculate percentiles
        const sorted = data.values.map(v => v.value).sort((a, b) => a - b);
        
        for (const percentile of this.percentiles) {
          const index = Math.floor(sorted.length * percentile);
          samples.push({
            name: this.name,
            labels: { ...labels, quantile: percentile },
            value: sorted[index]
          });
        }
      }
      
      // Sum
      samples.push({
        name: `${this.name}_sum`,
        labels,
        value: data.sum
      });
      
      // Count
      samples.push({
        name: `${this.name}_count`,
        labels,
        value: data.count
      });
    }
    
    return {
      name: this.name,
      help: this.help,
      type: this.type,
      samples
    };
  }
}

/**
 * Metrics registry
 */
export class MetricsRegistry {
  constructor() {
    this.metrics = new Map();
    this.defaultLabels = {};
  }
  
  register(metric) {
    if (this.metrics.has(metric.name)) {
      throw new Error(`Metric ${metric.name} already registered`);
    }
    
    this.metrics.set(metric.name, metric);
    return metric;
  }
  
  unregister(name) {
    return this.metrics.delete(name);
  }
  
  counter(name, help, labels) {
    const metric = new Counter(name, help, labels);
    return this.register(metric);
  }
  
  gauge(name, help, labels) {
    const metric = new Gauge(name, help, labels);
    return this.register(metric);
  }
  
  histogram(name, help, labels, buckets) {
    const metric = new Histogram(name, help, labels, buckets);
    return this.register(metric);
  }
  
  summary(name, help, labels, percentiles, window) {
    const metric = new Summary(name, help, labels, percentiles, window);
    return this.register(metric);
  }
  
  setDefaultLabels(labels) {
    this.defaultLabels = { ...this.defaultLabels, ...labels };
  }
  
  collect() {
    const metrics = [];
    
    for (const metric of this.metrics.values()) {
      metrics.push(metric.collect());
    }
    
    return metrics;
  }
  
  reset() {
    for (const metric of this.metrics.values()) {
      metric.reset();
    }
  }
  
  /**
   * Format metrics in Prometheus format
   */
  getPrometheusFormat() {
    const lines = [];
    const metrics = this.collect();
    
    for (const metric of metrics) {
      // Help text
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      
      // Type
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      
      // Samples
      for (const sample of metric.samples) {
        let line = sample.name;
        
        // Add labels
        const allLabels = { ...this.defaultLabels, ...sample.labels };
        const labelPairs = Object.entries(allLabels);
        
        if (labelPairs.length > 0) {
          const labelStr = labelPairs
            .map(([k, v]) => `${k}="${v}"`)
            .join(',');
          line += `{${labelStr}}`;
        }
        
        line += ` ${sample.value}`;
        lines.push(line);
      }
      
      lines.push(''); // Empty line between metrics
    }
    
    return lines.join('\n');
  }
}

/**
 * System metrics collector
 */
export class SystemMetrics {
  constructor(registry) {
    this.registry = registry;
    this.interval = null;
    
    // Register system metrics
    this.cpuUsage = this.registry.gauge(
      'process_cpu_usage_percent',
      'Process CPU usage percentage'
    );
    
    this.memoryUsage = this.registry.gauge(
      'process_memory_usage_bytes',
      'Process memory usage in bytes',
      ['type']
    );
    
    this.eventLoopLag = this.registry.histogram(
      'nodejs_eventloop_lag_seconds',
      'Event loop lag in seconds'
    );
    
    this.gcDuration = this.registry.histogram(
      'nodejs_gc_duration_seconds',
      'Garbage collection duration in seconds',
      ['type']
    );
    
    this.activeHandles = this.registry.gauge(
      'nodejs_active_handles',
      'Number of active handles'
    );
    
    this.activeRequests = this.registry.gauge(
      'nodejs_active_requests',
      'Number of active requests'
    );
  }
  
  start(interval = 10000) {
    if (this.interval) return;
    
    // Collect immediately
    this.collect();
    
    // Start periodic collection
    this.interval = setInterval(() => {
      this.collect();
    }, interval);
    
    // Monitor GC if available
    if (global.gc) {
      const { PerformanceObserver } = require('perf_hooks');
      
      const obs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        
        for (const entry of entries) {
          if (entry.entryType === 'gc') {
            this.gcDuration.observe(
              { type: entry.kind || 'unknown' },
              entry.duration / 1000
            );
          }
        }
      });
      
      obs.observe({ entryTypes: ['gc'] });
    }
    
    logger.info('System metrics collection started');
  }
  
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    logger.info('System metrics collection stopped');
  }
  
  collect() {
    // CPU usage
    const cpuUsage = process.cpuUsage();
    const cpuPercent = (cpuUsage.user + cpuUsage.system) / 1000000 * 100;
    this.cpuUsage.set(cpuPercent);
    
    // Memory usage
    const memUsage = process.memoryUsage();
    this.memoryUsage.set({ type: 'rss' }, memUsage.rss);
    this.memoryUsage.set({ type: 'heapTotal' }, memUsage.heapTotal);
    this.memoryUsage.set({ type: 'heapUsed' }, memUsage.heapUsed);
    this.memoryUsage.set({ type: 'external' }, memUsage.external);
    this.memoryUsage.set({ type: 'arrayBuffers' }, memUsage.arrayBuffers || 0);
    
    // Event loop lag
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const lag = Number(process.hrtime.bigint() - start) / 1e9;
      this.eventLoopLag.observe(lag);
    });
    
    // Active handles and requests
    this.activeHandles.set(process._getActiveHandles?.()?.length || 0);
    this.activeRequests.set(process._getActiveRequests?.()?.length || 0);
  }
}

/**
 * HTTP metrics middleware
 */
export class HTTPMetrics {
  constructor(registry) {
    this.registry = registry;
    
    // Register HTTP metrics
    this.requestDuration = this.registry.histogram(
      'http_request_duration_seconds',
      'HTTP request duration in seconds',
      ['method', 'route', 'status_code']
    );
    
    this.requestsTotal = this.registry.counter(
      'http_requests_total',
      'Total number of HTTP requests',
      ['method', 'route', 'status_code']
    );
    
    this.requestsInProgress = this.registry.gauge(
      'http_requests_in_progress',
      'Number of HTTP requests in progress',
      ['method', 'route']
    );
    
    this.requestSize = this.registry.histogram(
      'http_request_size_bytes',
      'HTTP request size in bytes',
      ['method', 'route']
    );
    
    this.responseSize = this.registry.histogram(
      'http_response_size_bytes',
      'HTTP response size in bytes',
      ['method', 'route']
    );
  }
  
  middleware(options = {}) {
    const {
      includePath = true,
      normalizeStatusCode = true
    } = options;
    
    return (req, res, next) => {
      const start = process.hrtime.bigint();
      const route = includePath ? req.route?.path || req.path : req.method;
      
      // Track in-progress requests
      this.requestsInProgress.inc({ method: req.method, route });
      
      // Track request size
      const requestSize = parseInt(req.headers['content-length'] || '0');
      this.requestSize.observe({ method: req.method, route }, requestSize);
      
      // Override res.end
      const originalEnd = res.end;
      res.end = (...args) => {
        // Calculate duration
        const duration = Number(process.hrtime.bigint() - start) / 1e9;
        
        // Get status code
        let statusCode = res.statusCode;
        if (normalizeStatusCode) {
          statusCode = Math.floor(statusCode / 100) + 'xx';
        }
        
        // Record metrics
        this.requestDuration.observe(
          { method: req.method, route, status_code: statusCode },
          duration
        );
        
        this.requestsTotal.inc({
          method: req.method,
          route,
          status_code: statusCode
        });
        
        this.requestsInProgress.dec({ method: req.method, route });
        
        // Track response size
        const responseSize = parseInt(res.getHeader('content-length') || '0');
        this.responseSize.observe({ method: req.method, route }, responseSize);
        
        // Call original end
        originalEnd.apply(res, args);
      };
      
      next();
    };
  }
}

/**
 * Mining metrics
 */
export class MiningMetrics {
  constructor(registry) {
    this.registry = registry;
    
    // Shares
    this.sharesTotal = this.registry.counter(
      'mining_shares_total',
      'Total number of shares',
      ['status', 'worker']
    );
    
    this.sharesDifficulty = this.registry.histogram(
      'mining_shares_difficulty',
      'Share difficulty distribution',
      ['worker']
    );
    
    // Blocks
    this.blocksFound = this.registry.counter(
      'mining_blocks_found_total',
      'Total number of blocks found'
    );
    
    this.blockReward = this.registry.gauge(
      'mining_block_reward',
      'Current block reward'
    );
    
    // Hashrate
    this.hashrate = this.registry.gauge(
      'mining_hashrate_hashes_per_second',
      'Current hashrate',
      ['worker']
    );
    
    this.poolHashrate = this.registry.gauge(
      'mining_pool_hashrate_hashes_per_second',
      'Total pool hashrate'
    );
    
    // Miners
    this.activeMiners = this.registry.gauge(
      'mining_active_miners',
      'Number of active miners'
    );
    
    this.minerConnections = this.registry.gauge(
      'mining_miner_connections',
      'Number of miner connections'
    );
    
    // Jobs
    this.jobsCreated = this.registry.counter(
      'mining_jobs_created_total',
      'Total number of jobs created'
    );
    
    this.jobDifficulty = this.registry.gauge(
      'mining_job_difficulty',
      'Current job difficulty'
    );
  }
  
  recordShare(worker, difficulty, isValid) {
    const status = isValid ? 'valid' : 'invalid';
    
    this.sharesTotal.inc({ status, worker });
    
    if (isValid) {
      this.sharesDifficulty.observe({ worker }, difficulty);
    }
  }
  
  recordBlock(reward) {
    this.blocksFound.inc();
    this.blockReward.set(reward);
  }
  
  updateHashrate(worker, hashrate) {
    this.hashrate.set({ worker }, hashrate);
  }
  
  updatePoolHashrate(hashrate) {
    this.poolHashrate.set(hashrate);
  }
  
  updateMiners(active, connections) {
    this.activeMiners.set(active);
    this.minerConnections.set(connections);
  }
  
  recordJob(difficulty) {
    this.jobsCreated.inc();
    this.jobDifficulty.set(difficulty);
  }
}

// Global registry
export const registry = new MetricsRegistry();

// Default system metrics
export const systemMetrics = new SystemMetrics(registry);

// Start system metrics collection by default
if (process.env.NODE_ENV !== 'test') {
  systemMetrics.start();
}

export default {
  MetricType,
  Metric,
  Counter,
  Gauge,
  Histogram,
  Summary,
  MetricsRegistry,
  SystemMetrics,
  HTTPMetrics,
  MiningMetrics,
  registry,
  systemMetrics
};
