/**
 * Real-time Performance Monitor for Otedama
 * Tracks and alerts on performance metrics
 * 
 * Design principles:
 * - Carmack: Minimal monitoring overhead
 * - Martin: Clean metric collection
 * - Pike: Simple threshold-based alerts
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import v8 from 'v8';
import { getLogger } from '../core/logger.js';

const logger = getLogger('PerformanceMonitor');

// Metric types
export const MetricType = {
  GAUGE: 'gauge',      // Point-in-time value
  COUNTER: 'counter',  // Cumulative value
  HISTOGRAM: 'histogram', // Distribution of values
  SUMMARY: 'summary'   // Statistical summary
};

// Alert levels
export const AlertLevel = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical'
};

/**
 * Performance metric
 */
class Metric {
  constructor(name, type, options = {}) {
    this.name = name;
    this.type = type;
    this.labels = options.labels || {};
    this.description = options.description || '';
    this.unit = options.unit || '';
    
    // Storage based on type
    switch (type) {
      case MetricType.GAUGE:
        this.value = 0;
        break;
        
      case MetricType.COUNTER:
        this.value = 0;
        break;
        
      case MetricType.HISTOGRAM:
        this.buckets = options.buckets || [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
        this.values = [];
        this.sum = 0;
        this.count = 0;
        break;
        
      case MetricType.SUMMARY:
        this.values = [];
        this.windowSize = options.windowSize || 600; // 10 minutes
        this.percentiles = options.percentiles || [0.5, 0.9, 0.95, 0.99];
        break;
    }
    
    this.lastUpdate = Date.now();
  }
  
  update(value, labels = {}) {
    this.lastUpdate = Date.now();
    
    switch (this.type) {
      case MetricType.GAUGE:
        this.value = value;
        break;
        
      case MetricType.COUNTER:
        this.value += value;
        break;
        
      case MetricType.HISTOGRAM:
        this.values.push(value);
        this.sum += value;
        this.count++;
        break;
        
      case MetricType.SUMMARY:
        this.values.push({ value, timestamp: Date.now() });
        this._cleanOldValues();
        break;
    }
  }
  
  get() {
    switch (this.type) {
      case MetricType.GAUGE:
      case MetricType.COUNTER:
        return this.value;
        
      case MetricType.HISTOGRAM:
        return this._calculateHistogram();
        
      case MetricType.SUMMARY:
        return this._calculateSummary();
        
      default:
        return null;
    }
  }
  
  reset() {
    switch (this.type) {
      case MetricType.GAUGE:
        this.value = 0;
        break;
        
      case MetricType.COUNTER:
        // Counters typically don't reset
        break;
        
      case MetricType.HISTOGRAM:
      case MetricType.SUMMARY:
        this.values = [];
        this.sum = 0;
        this.count = 0;
        break;
    }
  }
  
  _calculateHistogram() {
    const bucketCounts = new Array(this.buckets.length).fill(0);
    
    for (const value of this.values) {
      for (let i = 0; i < this.buckets.length; i++) {
        if (value <= this.buckets[i]) {
          bucketCounts[i]++;
        }
      }
    }
    
    return {
      buckets: this.buckets.map((bucket, i) => ({
        le: bucket,
        count: bucketCounts[i]
      })),
      sum: this.sum,
      count: this.count,
      avg: this.count > 0 ? this.sum / this.count : 0
    };
  }
  
  _calculateSummary() {
    if (this.values.length === 0) {
      return { count: 0, percentiles: {} };
    }
    
    const sorted = this.values
      .map(v => v.value)
      .sort((a, b) => a - b);
    
    const percentiles = {};
    for (const p of this.percentiles) {
      const index = Math.ceil(sorted.length * p) - 1;
      percentiles[p] = sorted[Math.max(0, index)];
    }
    
    return {
      count: sorted.length,
      sum: sorted.reduce((a, b) => a + b, 0),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      percentiles
    };
  }
  
  _cleanOldValues() {
    const cutoff = Date.now() - (this.windowSize * 1000);
    this.values = this.values.filter(v => v.timestamp > cutoff);
  }
}

/**
 * Performance monitor
 */
export class PerformanceMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      collectInterval: options.collectInterval || 1000,
      gcMonitoring: options.gcMonitoring !== false,
      eventLoopMonitoring: options.eventLoopMonitoring !== false,
      processMonitoring: options.processMonitoring !== false,
      ...options
    };
    
    // Metrics storage
    this.metrics = new Map();
    this.customMetrics = new Map();
    
    // Alerts configuration
    this.alerts = new Map();
    this.activeAlerts = new Map();
    
    // Collection state
    this.collecting = false;
    this.collectionTimer = null;
    
    // Initialize default metrics
    this._initializeDefaultMetrics();
    
    // Start collection
    if (options.autoStart !== false) {
      this.start();
    }
  }
  
  /**
   * Initialize default system metrics
   */
  _initializeDefaultMetrics() {
    // CPU metrics
    this.registerMetric('cpu_usage_percent', MetricType.GAUGE, {
      description: 'CPU usage percentage',
      unit: 'percent'
    });
    
    // Memory metrics
    this.registerMetric('memory_heap_used_bytes', MetricType.GAUGE, {
      description: 'Heap memory used',
      unit: 'bytes'
    });
    
    this.registerMetric('memory_heap_total_bytes', MetricType.GAUGE, {
      description: 'Total heap memory',
      unit: 'bytes'
    });
    
    this.registerMetric('memory_external_bytes', MetricType.GAUGE, {
      description: 'External memory',
      unit: 'bytes'
    });
    
    this.registerMetric('memory_rss_bytes', MetricType.GAUGE, {
      description: 'Resident set size',
      unit: 'bytes'
    });
    
    // Event loop metrics
    if (this.options.eventLoopMonitoring) {
      this.registerMetric('event_loop_delay_ms', MetricType.HISTOGRAM, {
        description: 'Event loop delay',
        unit: 'milliseconds',
        buckets: [0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000]
      });
      
      this._setupEventLoopMonitoring();
    }
    
    // GC metrics
    if (this.options.gcMonitoring) {
      this.registerMetric('gc_duration_ms', MetricType.HISTOGRAM, {
        description: 'Garbage collection duration',
        unit: 'milliseconds'
      });
      
      this.registerMetric('gc_count_total', MetricType.COUNTER, {
        description: 'Total garbage collections'
      });
      
      this._setupGCMonitoring();
    }
    
    // Process metrics
    if (this.options.processMonitoring) {
      this.registerMetric('process_uptime_seconds', MetricType.COUNTER, {
        description: 'Process uptime',
        unit: 'seconds'
      });
      
      this.registerMetric('process_handles_active', MetricType.GAUGE, {
        description: 'Active handles'
      });
      
      this.registerMetric('process_requests_active', MetricType.GAUGE, {
        description: 'Active requests'
      });
    }
  }
  
  /**
   * Register a metric
   */
  registerMetric(name, type, options = {}) {
    const metric = new Metric(name, type, options);
    this.metrics.set(name, metric);
    return metric;
  }
  
  /**
   * Update metric value
   */
  updateMetric(name, value, labels = {}) {
    const metric = this.metrics.get(name) || this.customMetrics.get(name);
    if (!metric) {
      // Auto-create custom metric
      const metric = new Metric(name, MetricType.GAUGE);
      this.customMetrics.set(name, metric);
      metric.update(value, labels);
    } else {
      metric.update(value, labels);
    }
    
    // Check alerts
    this._checkAlerts(name, value);
  }
  
  /**
   * Register custom metric
   */
  gauge(name, value, labels = {}) {
    this.updateMetric(name, value, labels);
  }
  
  counter(name, increment = 1, labels = {}) {
    let metric = this.customMetrics.get(name);
    if (!metric) {
      metric = new Metric(name, MetricType.COUNTER);
      this.customMetrics.set(name, metric);
    }
    metric.update(increment, labels);
  }
  
  histogram(name, value, labels = {}) {
    let metric = this.customMetrics.get(name);
    if (!metric) {
      metric = new Metric(name, MetricType.HISTOGRAM);
      this.customMetrics.set(name, metric);
    }
    metric.update(value, labels);
  }
  
  summary(name, value, labels = {}) {
    let metric = this.customMetrics.get(name);
    if (!metric) {
      metric = new Metric(name, MetricType.SUMMARY);
      this.customMetrics.set(name, metric);
    }
    metric.update(value, labels);
  }
  
  /**
   * Register alert
   */
  registerAlert(name, options) {
    this.alerts.set(name, {
      metric: options.metric,
      condition: options.condition || 'gt',
      threshold: options.threshold,
      duration: options.duration || 0,
      level: options.level || AlertLevel.WARNING,
      message: options.message || `Alert: ${options.metric} ${options.condition} ${options.threshold}`,
      callback: options.callback
    });
  }
  
  /**
   * Start monitoring
   */
  start() {
    if (this.collecting) return;
    
    this.collecting = true;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCollectTime = Date.now();
    
    // Start collection interval
    this.collectionTimer = setInterval(() => {
      this._collect();
    }, this.options.collectInterval);
    
    logger.info('Performance monitoring started');
  }
  
  /**
   * Stop monitoring
   */
  stop() {
    if (!this.collecting) return;
    
    this.collecting = false;
    
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
      this.collectionTimer = null;
    }
    
    if (this.eventLoopTimer) {
      clearInterval(this.eventLoopTimer);
    }
    
    logger.info('Performance monitoring stopped');
  }
  
  /**
   * Collect metrics
   */
  _collect() {
    const now = Date.now();
    
    // CPU usage
    const cpuUsage = process.cpuUsage(this.lastCpuUsage);
    const elapsedTime = now - this.lastCollectTime;
    const cpuPercent = ((cpuUsage.user + cpuUsage.system) / 1000 / elapsedTime) * 100;
    
    this.updateMetric('cpu_usage_percent', cpuPercent);
    
    this.lastCpuUsage = process.cpuUsage();
    this.lastCollectTime = now;
    
    // Memory usage
    const memoryUsage = process.memoryUsage();
    this.updateMetric('memory_heap_used_bytes', memoryUsage.heapUsed);
    this.updateMetric('memory_heap_total_bytes', memoryUsage.heapTotal);
    this.updateMetric('memory_external_bytes', memoryUsage.external);
    this.updateMetric('memory_rss_bytes', memoryUsage.rss);
    
    // Heap statistics
    const heapStats = v8.getHeapStatistics();
    this.updateMetric('memory_heap_size_limit', heapStats.heap_size_limit);
    
    // Process metrics
    if (this.options.processMonitoring) {
      this.updateMetric('process_uptime_seconds', process.uptime());
      this.updateMetric('process_handles_active', process._getActiveHandles().length);
      this.updateMetric('process_requests_active', process._getActiveRequests().length);
    }
    
    this.emit('metrics:collected', this.getMetrics());
  }
  
  /**
   * Setup event loop monitoring
   */
  _setupEventLoopMonitoring() {
    let lastCheck = performance.now();
    
    this.eventLoopTimer = setInterval(() => {
      const now = performance.now();
      const delay = now - lastCheck - this.options.collectInterval;
      
      if (delay > 0) {
        this.updateMetric('event_loop_delay_ms', delay);
      }
      
      lastCheck = now;
    }, this.options.collectInterval);
    
    this.eventLoopTimer.unref();
  }
  
  /**
   * Setup GC monitoring
   */
  _setupGCMonitoring() {
    try {
      const obs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        
        for (const entry of entries) {
          if (entry.entryType === 'gc') {
            this.updateMetric('gc_duration_ms', entry.duration);
            this.updateMetric('gc_count_total', 1);
            
            this.emit('gc', {
              duration: entry.duration,
              type: entry.detail?.kind,
              flags: entry.detail?.flags
            });
          }
        }
      });
      
      obs.observe({ entryTypes: ['gc'] });
    } catch (error) {
      logger.warn('GC monitoring not available', error);
    }
  }
  
  /**
   * Check alerts
   */
  _checkAlerts(metricName, value) {
    for (const [alertName, alert] of this.alerts) {
      if (alert.metric !== metricName) continue;
      
      const triggered = this._evaluateCondition(value, alert.condition, alert.threshold);
      const activeAlert = this.activeAlerts.get(alertName);
      
      if (triggered) {
        if (!activeAlert) {
          // New alert
          const alertInfo = {
            name: alertName,
            metric: metricName,
            value,
            threshold: alert.threshold,
            level: alert.level,
            message: alert.message,
            triggeredAt: Date.now()
          };
          
          this.activeAlerts.set(alertName, alertInfo);
          
          this.emit('alert:triggered', alertInfo);
          
          if (alert.callback) {
            alert.callback(alertInfo);
          }
        } else {
          // Update duration
          activeAlert.duration = Date.now() - activeAlert.triggeredAt;
        }
      } else if (activeAlert) {
        // Alert resolved
        this.activeAlerts.delete(alertName);
        
        this.emit('alert:resolved', {
          ...activeAlert,
          resolvedAt: Date.now(),
          duration: Date.now() - activeAlert.triggeredAt
        });
      }
    }
  }
  
  _evaluateCondition(value, condition, threshold) {
    switch (condition) {
      case 'gt': return value > threshold;
      case 'gte': return value >= threshold;
      case 'lt': return value < threshold;
      case 'lte': return value <= threshold;
      case 'eq': return value === threshold;
      case 'ne': return value !== threshold;
      default: return false;
    }
  }
  
  /**
   * Get all metrics
   */
  getMetrics() {
    const result = {};
    
    // System metrics
    for (const [name, metric] of this.metrics) {
      result[name] = metric.get();
    }
    
    // Custom metrics
    for (const [name, metric] of this.customMetrics) {
      result[name] = metric.get();
    }
    
    return result;
  }
  
  /**
   * Get active alerts
   */
  getActiveAlerts() {
    return Array.from(this.activeAlerts.values());
  }
  
  /**
   * Export metrics in Prometheus format
   */
  exportPrometheus() {
    const lines = [];
    
    const exportMetric = (name, metric) => {
      const sanitizedName = name.replace(/[^a-zA-Z0-9_]/g, '_');
      
      if (metric.description) {
        lines.push(`# HELP ${sanitizedName} ${metric.description}`);
      }
      
      lines.push(`# TYPE ${sanitizedName} ${metric.type}`);
      
      switch (metric.type) {
        case MetricType.GAUGE:
        case MetricType.COUNTER:
          lines.push(`${sanitizedName} ${metric.value}`);
          break;
          
        case MetricType.HISTOGRAM:
          const hist = metric.get();
          for (const bucket of hist.buckets) {
            lines.push(`${sanitizedName}_bucket{le="${bucket.le}"} ${bucket.count}`);
          }
          lines.push(`${sanitizedName}_bucket{le="+Inf"} ${hist.count}`);
          lines.push(`${sanitizedName}_sum ${hist.sum}`);
          lines.push(`${sanitizedName}_count ${hist.count}`);
          break;
          
        case MetricType.SUMMARY:
          const summary = metric.get();
          for (const [percentile, value] of Object.entries(summary.percentiles)) {
            lines.push(`${sanitizedName}{quantile="${percentile}"} ${value}`);
          }
          lines.push(`${sanitizedName}_sum ${summary.sum}`);
          lines.push(`${sanitizedName}_count ${summary.count}`);
          break;
      }
    };
    
    // Export all metrics
    for (const [name, metric] of this.metrics) {
      exportMetric(name, metric);
    }
    
    for (const [name, metric] of this.customMetrics) {
      exportMetric(name, metric);
    }
    
    return lines.join('\n');
  }
}

// Global monitor instance
let globalMonitor = null;

export function getMonitor(options) {
  if (!globalMonitor) {
    globalMonitor = new PerformanceMonitor(options);
  }
  return globalMonitor;
}

export function setGlobalMonitor(monitor) {
  globalMonitor = monitor;
}

export default PerformanceMonitor;