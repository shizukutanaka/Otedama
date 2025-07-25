/**
 * Monitoring System - Otedama
 * Simple monitoring and metrics collection
 */

import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';

const logger = createLogger('Monitoring');

export class MonitoringSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      enablePrometheus: options.enablePrometheus !== false,
      enableLogs: options.enableLogs !== false,
      logLevel: options.logLevel || 'info',
      metricsInterval: options.metricsInterval || 10000
    };
    
    this.metrics = new Map();
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
  }
  
  async start() {
    logger.info('Monitoring system started');
    
    // Start metrics collection
    this.metricsTimer = setInterval(() => {
      this.collectMetrics();
    }, this.config.metricsInterval);
    
    this.emit('started');
  }
  
  async stop() {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
    }
    
    logger.info('Monitoring system stopped');
    this.emit('stopped');
  }
  
  // Metric recording methods
  
  recordMetric(name, value, labels = {}) {
    const key = this.getMetricKey(name, labels);
    this.metrics.set(key, {
      name,
      value,
      labels,
      timestamp: Date.now()
    });
  }
  
  incrementCounter(name, value = 1, labels = {}) {
    const key = this.getMetricKey(name, labels);
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + value);
  }
  
  setGauge(name, value, labels = {}) {
    const key = this.getMetricKey(name, labels);
    this.gauges.set(key, {
      name,
      value,
      labels,
      timestamp: Date.now()
    });
  }
  
  recordHistogram(name, value, labels = {}) {
    const key = this.getMetricKey(name, labels);
    
    if (!this.histograms.has(key)) {
      this.histograms.set(key, {
        name,
        labels,
        values: [],
        sum: 0,
        count: 0
      });
    }
    
    const histogram = this.histograms.get(key);
    histogram.values.push(value);
    histogram.sum += value;
    histogram.count++;
    
    // Keep only last 1000 values
    if (histogram.values.length > 1000) {
      histogram.values.shift();
    }
  }
  
  // Metric retrieval
  
  async getMetrics() {
    const metrics = {
      timestamp: Date.now(),
      metrics: Object.fromEntries(this.metrics),
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: {}
    };
    
    // Calculate histogram statistics
    for (const [key, histogram] of this.histograms) {
      const sorted = [...histogram.values].sort((a, b) => a - b);
      
      metrics.histograms[key] = {
        name: histogram.name,
        labels: histogram.labels,
        count: histogram.count,
        sum: histogram.sum,
        mean: histogram.sum / histogram.count,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        p50: this.percentile(sorted, 0.5),
        p95: this.percentile(sorted, 0.95),
        p99: this.percentile(sorted, 0.99)
      };
    }
    
    return metrics;
  }
  
  // Helper methods
  
  getMetricKey(name, labels) {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    
    return labelStr ? `${name}{${labelStr}}` : name;
  }
  
  percentile(sorted, p) {
    const index = Math.floor(sorted.length * p);
    return sorted[index];
  }
  
  collectMetrics() {
    // Collect system metrics
    const usage = process.memoryUsage();
    
    this.setGauge('process_memory_heap_used', usage.heapUsed);
    this.setGauge('process_memory_heap_total', usage.heapTotal);
    this.setGauge('process_memory_rss', usage.rss);
    this.setGauge('process_uptime', process.uptime());
    
    // CPU usage
    const cpuUsage = process.cpuUsage();
    this.setGauge('process_cpu_user', cpuUsage.user);
    this.setGauge('process_cpu_system', cpuUsage.system);
    
    this.emit('metrics:collected');
  }
  
  // Logging methods
  
  log(level, message, meta = {}) {
    if (!this.config.enableLogs) return;
    
    const logLevels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3
    };
    
    const configLevel = logLevels[this.config.logLevel] || 2;
    const messageLevel = logLevels[level] || 2;
    
    if (messageLevel <= configLevel) {
      logger[level](message, meta);
      
      this.emit('log', {
        level,
        message,
        meta,
        timestamp: Date.now()
      });
    }
  }
  
  error(message, meta) {
    this.log('error', message, meta);
    this.incrementCounter('logs_total', 1, { level: 'error' });
  }
  
  warn(message, meta) {
    this.log('warn', message, meta);
    this.incrementCounter('logs_total', 1, { level: 'warn' });
  }
  
  info(message, meta) {
    this.log('info', message, meta);
    this.incrementCounter('logs_total', 1, { level: 'info' });
  }
  
  debug(message, meta) {
    this.log('debug', message, meta);
    this.incrementCounter('logs_total', 1, { level: 'debug' });
  }
}

export default MonitoringSystem;
