/**
 * Performance Monitoring System for Otedama
 * Real-time performance tracking and optimization
 * 
 * Design:
 * - Carmack: Zero-overhead performance monitoring
 * - Martin: Clean separation of monitoring concerns
 * - Pike: Simple but effective metrics collection
 */

import { EventEmitter } from 'events';
import { performance, PerformanceObserver } from 'perf_hooks';
import { createStructuredLogger } from '../core/structured-logger.js';
import prometheus from 'prom-client';

// Performance constants
const SAMPLE_INTERVAL = 1000; // 1 second
const HISTORY_SIZE = 3600; // 1 hour of second-by-second data
const PERCENTILES = [0.5, 0.75, 0.9, 0.95, 0.99];

/**
 * High-resolution timer for accurate measurements
 */
class HighResTimer {
  constructor() {
    this.marks = new Map();
  }
  
  mark(name) {
    this.marks.set(name, process.hrtime.bigint());
  }
  
  measure(name, startMark, endMark = null) {
    const start = this.marks.get(startMark);
    if (!start) return null;
    
    const end = endMark ? this.marks.get(endMark) : process.hrtime.bigint();
    const duration = Number(end - start) / 1e6; // Convert to milliseconds
    
    return duration;
  }
  
  clear() {
    this.marks.clear();
  }
}

/**
 * Metrics collector with statistical analysis
 */
class MetricsCollector {
  constructor(name, options = {}) {
    this.name = name;
    this.windowSize = options.windowSize || 1000;
    this.values = [];
    this.sum = 0;
    this.count = 0;
    
    // Pre-calculated statistics
    this.stats = {
      min: Infinity,
      max: -Infinity,
      mean: 0,
      median: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      stdDev: 0
    };
  }
  
  record(value) {
    this.values.push(value);
    this.sum += value;
    this.count++;
    
    // Update min/max
    if (value < this.stats.min) this.stats.min = value;
    if (value > this.stats.max) this.stats.max = value;
    
    // Maintain window size
    while (this.values.length > this.windowSize) {
      const removed = this.values.shift();
      this.sum -= removed;
    }
    
    // Update statistics periodically
    if (this.count % 100 === 0) {
      this.updateStatistics();
    }
  }
  
  updateStatistics() {
    if (this.values.length === 0) return;
    
    // Sort values for percentile calculation
    const sorted = [...this.values].sort((a, b) => a - b);
    const len = sorted.length;
    
    // Calculate percentiles
    this.stats.median = sorted[Math.floor(len * 0.5)];
    this.stats.p75 = sorted[Math.floor(len * 0.75)];
    this.stats.p90 = sorted[Math.floor(len * 0.9)];
    this.stats.p95 = sorted[Math.floor(len * 0.95)];
    this.stats.p99 = sorted[Math.floor(len * 0.99)];
    
    // Calculate mean
    this.stats.mean = this.sum / this.values.length;
    
    // Calculate standard deviation
    const variance = this.values.reduce((acc, val) => {
      const diff = val - this.stats.mean;
      return acc + diff * diff;
    }, 0) / this.values.length;
    
    this.stats.stdDev = Math.sqrt(variance);
  }
  
  getStats() {
    this.updateStatistics();
    return {
      name: this.name,
      count: this.count,
      current: this.values[this.values.length - 1] || 0,
      ...this.stats
    };
  }
  
  reset() {
    this.values = [];
    this.sum = 0;
    this.count = 0;
    this.stats = {
      min: Infinity,
      max: -Infinity,
      mean: 0,
      median: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      stdDev: 0
    };
  }
}

/**
 * System resource monitor
 */
class ResourceMonitor {
  constructor() {
    this.metrics = {
      cpu: new MetricsCollector('cpu_usage'),
      memory: new MetricsCollector('memory_usage'),
      eventLoop: new MetricsCollector('event_loop_lag'),
      gc: new MetricsCollector('gc_duration')
    };
    
    this.lastCpuUsage = process.cpuUsage();
    this.setupGCMonitoring();
  }
  
  setupGCMonitoring() {
    // Monitor garbage collection
    const obs = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      entries.forEach((entry) => {
        if (entry.entryType === 'gc') {
          this.metrics.gc.record(entry.duration);
        }
      });
    });
    
    obs.observe({ entryTypes: ['gc'], buffered: true });
  }
  
  collect() {
    // CPU usage
    const currentCpuUsage = process.cpuUsage(this.lastCpuUsage);
    const cpuPercent = (currentCpuUsage.user + currentCpuUsage.system) / 1000000 * 100;
    this.metrics.cpu.record(cpuPercent);
    this.lastCpuUsage = process.cpuUsage();
    
    // Memory usage
    const memUsage = process.memoryUsage();
    const memPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    this.metrics.memory.record(memPercent);
    
    // Event loop lag
    const start = process.hrtime();
    setImmediate(() => {
      const lag = process.hrtime(start);
      const lagMs = lag[0] * 1000 + lag[1] / 1e6;
      this.metrics.eventLoop.record(lagMs);
    });
    
    return {
      cpu: this.metrics.cpu.getStats(),
      memory: {
        ...this.metrics.memory.getStats(),
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        external: memUsage.external,
        rss: memUsage.rss
      },
      eventLoop: this.metrics.eventLoop.getStats(),
      gc: this.metrics.gc.getStats()
    };
  }
}

/**
 * Application performance monitor
 */
class ApplicationMonitor {
  constructor() {
    this.operations = new Map();
    this.timer = new HighResTimer();
  }
  
  startOperation(name, metadata = {}) {
    const id = `${name}_${Date.now()}_${Math.random()}`;
    this.timer.mark(id);
    
    this.operations.set(id, {
      name,
      startTime: Date.now(),
      metadata
    });
    
    return id;
  }
  
  endOperation(id, metadata = {}) {
    const operation = this.operations.get(id);
    if (!operation) return null;
    
    const duration = this.timer.measure(id, id);
    this.operations.delete(id);
    
    return {
      name: operation.name,
      duration,
      startTime: operation.startTime,
      endTime: Date.now(),
      metadata: { ...operation.metadata, ...metadata }
    };
  }
  
  recordMetric(name, value, labels = {}) {
    // Record to appropriate collector based on metric type
    if (!this.operations.has(name)) {
      this.operations.set(name, new MetricsCollector(name));
    }
    
    const collector = this.operations.get(name);
    collector.record(value);
    
    return collector.getStats();
  }
}

/**
 * Prometheus metrics integration
 */
class PrometheusMetrics {
  constructor(prefix = 'otedama') {
    this.prefix = prefix;
    this.register = new prometheus.Registry();
    
    // Default metrics
    prometheus.collectDefaultMetrics({ register: this.register });
    
    // Custom metrics
    this.metrics = {
      // Counters
      sharesAccepted: new prometheus.Counter({
        name: `${prefix}_shares_accepted_total`,
        help: 'Total number of accepted shares',
        labelNames: ['algorithm', 'miner'],
        registers: [this.register]
      }),
      
      sharesRejected: new prometheus.Counter({
        name: `${prefix}_shares_rejected_total`,
        help: 'Total number of rejected shares',
        labelNames: ['algorithm', 'reason'],
        registers: [this.register]
      }),
      
      blocksFound: new prometheus.Counter({
        name: `${prefix}_blocks_found_total`,
        help: 'Total number of blocks found',
        labelNames: ['algorithm'],
        registers: [this.register]
      }),
      
      // Gauges
      hashrate: new prometheus.Gauge({
        name: `${prefix}_hashrate`,
        help: 'Current pool hashrate',
        labelNames: ['algorithm'],
        registers: [this.register]
      }),
      
      connectedMiners: new prometheus.Gauge({
        name: `${prefix}_connected_miners`,
        help: 'Number of connected miners',
        labelNames: ['algorithm'],
        registers: [this.register]
      }),
      
      // Histograms
      shareValidationTime: new prometheus.Histogram({
        name: `${prefix}_share_validation_duration_seconds`,
        help: 'Time taken to validate shares',
        labelNames: ['algorithm'],
        buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
        registers: [this.register]
      }),
      
      paymentProcessingTime: new prometheus.Histogram({
        name: `${prefix}_payment_processing_duration_seconds`,
        help: 'Time taken to process payments',
        buckets: [1, 5, 10, 30, 60, 300, 600],
        registers: [this.register]
      }),
      
      // Summary
      apiResponseTime: new prometheus.Summary({
        name: `${prefix}_api_response_time_seconds`,
        help: 'API response time summary',
        labelNames: ['method', 'route', 'status'],
        percentiles: [0.5, 0.9, 0.95, 0.99],
        registers: [this.register]
      })
    };
  }
  
  recordShare(accepted, algorithm, miner = null, reason = null) {
    if (accepted) {
      this.metrics.sharesAccepted.inc({ algorithm, miner: miner || 'unknown' });
    } else {
      this.metrics.sharesRejected.inc({ algorithm, reason: reason || 'unknown' });
    }
  }
  
  recordBlock(algorithm) {
    this.metrics.blocksFound.inc({ algorithm });
  }
  
  setHashrate(hashrate, algorithm) {
    this.metrics.hashrate.set({ algorithm }, hashrate);
  }
  
  setConnectedMiners(count, algorithm) {
    this.metrics.connectedMiners.set({ algorithm }, count);
  }
  
  recordShareValidation(duration, algorithm) {
    this.metrics.shareValidationTime.observe({ algorithm }, duration / 1000);
  }
  
  recordPaymentProcessing(duration) {
    this.metrics.paymentProcessingTime.observe(duration / 1000);
  }
  
  recordAPIResponse(duration, method, route, status) {
    this.metrics.apiResponseTime.observe(
      { method, route, status },
      duration / 1000
    );
  }
  
  getMetrics() {
    return this.register.metrics();
  }
  
  getContentType() {
    return this.register.contentType;
  }
}

/**
 * Performance monitoring system
 */
export class PerformanceMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      sampleInterval: options.sampleInterval || SAMPLE_INTERVAL,
      historySize: options.historySize || HISTORY_SIZE,
      enablePrometheus: options.enablePrometheus !== false,
      ...options
    };
    
    // Initialize components
    this.resourceMonitor = new ResourceMonitor();
    this.applicationMonitor = new ApplicationMonitor();
    this.timer = new HighResTimer();
    
    if (this.options.enablePrometheus) {
      this.prometheus = new PrometheusMetrics(options.prometheusPrefix);
    }
    
    // Performance history
    this.history = {
      resources: [],
      operations: new Map(),
      alerts: []
    };
    
    // Thresholds for alerts
    this.thresholds = {
      cpu: options.cpuThreshold || 80,
      memory: options.memoryThreshold || 85,
      eventLoopLag: options.eventLoopThreshold || 100,
      responseTime: options.responseTimeThreshold || 1000
    };
    
    this.logger = createStructuredLogger('PerformanceMonitor');
    
    // Start monitoring
    this.startMonitoring();
  }
  
  /**
   * Start monitoring
   */
  startMonitoring() {
    // Resource monitoring
    this.resourceInterval = setInterval(() => {
      const resources = this.resourceMonitor.collect();
      
      // Store in history
      this.history.resources.push({
        timestamp: Date.now(),
        ...resources
      });
      
      // Maintain history size
      while (this.history.resources.length > this.options.historySize) {
        this.history.resources.shift();
      }
      
      // Check thresholds
      this.checkThresholds(resources);
      
      // Emit metrics
      this.emit('metrics:resources', resources);
      
    }, this.options.sampleInterval);
    
    // Log summary every minute
    this.summaryInterval = setInterval(() => {
      this.logSummary();
    }, 60000);
  }
  
  /**
   * Check performance thresholds
   */
  checkThresholds(resources) {
    const alerts = [];
    
    // CPU threshold
    if (resources.cpu.current > this.thresholds.cpu) {
      alerts.push({
        type: 'CPU_HIGH',
        severity: 'WARNING',
        value: resources.cpu.current,
        threshold: this.thresholds.cpu
      });
    }
    
    // Memory threshold
    if (resources.memory.current > this.thresholds.memory) {
      alerts.push({
        type: 'MEMORY_HIGH',
        severity: 'WARNING',
        value: resources.memory.current,
        threshold: this.thresholds.memory
      });
    }
    
    // Event loop lag
    if (resources.eventLoop.p95 > this.thresholds.eventLoopLag) {
      alerts.push({
        type: 'EVENT_LOOP_LAG',
        severity: 'CRITICAL',
        value: resources.eventLoop.p95,
        threshold: this.thresholds.eventLoopLag
      });
    }
    
    // Process alerts
    alerts.forEach(alert => {
      this.history.alerts.push({
        ...alert,
        timestamp: Date.now()
      });
      
      this.emit('alert', alert);
      this.logger.warn('Performance alert', alert);
    });
  }
  
  /**
   * Track operation performance
   */
  startOperation(name, metadata = {}) {
    return this.applicationMonitor.startOperation(name, metadata);
  }
  
  endOperation(id, metadata = {}) {
    const result = this.applicationMonitor.endOperation(id, metadata);
    
    if (result) {
      // Store in operation history
      if (!this.history.operations.has(result.name)) {
        this.history.operations.set(result.name, new MetricsCollector(result.name));
      }
      
      const collector = this.history.operations.get(result.name);
      collector.record(result.duration);
      
      // Check response time threshold
      if (result.duration > this.thresholds.responseTime) {
        this.emit('alert', {
          type: 'SLOW_OPERATION',
          severity: 'WARNING',
          operation: result.name,
          duration: result.duration,
          threshold: this.thresholds.responseTime
        });
      }
      
      this.emit('operation:complete', result);
    }
    
    return result;
  }
  
  /**
   * Record custom metric
   */
  recordMetric(name, value, labels = {}) {
    return this.applicationMonitor.recordMetric(name, value, labels);
  }
  
  /**
   * Track share processing
   */
  recordShare(accepted, algorithm, miner, duration, reason = null) {
    if (this.prometheus) {
      this.prometheus.recordShare(accepted, algorithm, miner, reason);
      if (duration) {
        this.prometheus.recordShareValidation(duration, algorithm);
      }
    }
    
    this.recordMetric('share_processing', duration, {
      accepted,
      algorithm
    });
  }
  
  /**
   * Track block found
   */
  recordBlock(algorithm) {
    if (this.prometheus) {
      this.prometheus.recordBlock(algorithm);
    }
    
    this.emit('block:found', { algorithm, timestamp: Date.now() });
  }
  
  /**
   * Update pool metrics
   */
  updatePoolMetrics(metrics) {
    if (this.prometheus) {
      if (metrics.hashrate !== undefined) {
        this.prometheus.setHashrate(metrics.hashrate, metrics.algorithm || 'unknown');
      }
      if (metrics.connectedMiners !== undefined) {
        this.prometheus.setConnectedMiners(metrics.connectedMiners, metrics.algorithm || 'unknown');
      }
    }
  }
  
  /**
   * Express middleware for API monitoring
   */
  middleware() {
    return (req, res, next) => {
      const start = process.hrtime.bigint();
      const operationId = this.startOperation('http_request', {
        method: req.method,
        url: req.url,
        ip: req.ip
      });
      
      // Override res.end
      const originalEnd = res.end;
      res.end = (...args) => {
        res.end = originalEnd;
        res.end(...args);
        
        const duration = Number(process.hrtime.bigint() - start) / 1e6;
        
        this.endOperation(operationId, {
          status: res.statusCode,
          duration
        });
        
        if (this.prometheus) {
          this.prometheus.recordAPIResponse(
            duration,
            req.method,
            req.route?.path || req.url,
            res.statusCode
          );
        }
      };
      
      next();
    };
  }
  
  /**
   * Get performance report
   */
  getReport() {
    const now = Date.now();
    const report = {
      timestamp: now,
      uptime: process.uptime(),
      resources: this.resourceMonitor.collect(),
      operations: {},
      recentAlerts: this.history.alerts.filter(a => now - a.timestamp < 300000) // Last 5 minutes
    };
    
    // Add operation statistics
    for (const [name, collector] of this.history.operations) {
      report.operations[name] = collector.getStats();
    }
    
    return report;
  }
  
  /**
   * Get Prometheus metrics
   */
  getPrometheusMetrics() {
    if (!this.prometheus) {
      throw new Error('Prometheus not enabled');
    }
    
    return {
      contentType: this.prometheus.getContentType(),
      metrics: this.prometheus.getMetrics()
    };
  }
  
  /**
   * Log performance summary
   */
  logSummary() {
    const report = this.getReport();
    
    this.logger.info('Performance summary', {
      cpu: `${report.resources.cpu.mean.toFixed(1)}% (p95: ${report.resources.cpu.p95.toFixed(1)}%)`,
      memory: `${report.resources.memory.mean.toFixed(1)}% (${(report.resources.memory.heapUsed / 1024 / 1024).toFixed(0)}MB)`,
      eventLoop: `${report.resources.eventLoop.mean.toFixed(1)}ms (p95: ${report.resources.eventLoop.p95.toFixed(1)}ms)`,
      gc: `${report.resources.gc.count} collections (avg: ${report.resources.gc.mean.toFixed(1)}ms)`,
      alerts: report.recentAlerts.length
    });
  }
  
  /**
   * Stop monitoring
   */
  stop() {
    clearInterval(this.resourceInterval);
    clearInterval(this.summaryInterval);
    this.removeAllListeners();
  }
}

// Export components
export {
  HighResTimer,
  MetricsCollector,
  ResourceMonitor,
  ApplicationMonitor,
  PrometheusMetrics
};

export default PerformanceMonitor;