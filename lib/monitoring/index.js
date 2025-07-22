/**
 * Consolidated Monitoring System for Otedama
 * 
 * This module provides a unified interface to all monitoring capabilities,
 * consolidating multiple monitoring systems into one coherent solution.
 * 
 * Design principles:
 * - Carmack: High-performance, minimal overhead
 * - Martin: Clean interfaces, single responsibility
 * - Pike: Simple and powerful
 */

import { UnifiedMonitoringManager } from './unified-monitoring-manager.js';
import { EventEmitter } from 'events';

// Create singleton instance
let monitoringInstance = null;

/**
 * Enhanced Unified Monitoring Manager with all features consolidated
 */
class ConsolidatedMonitoring extends UnifiedMonitoringManager {
  constructor(options = {}) {
    super(options);
    
    // Add Prometheus registry for compatibility
    this.prometheusRegistry = null;
    
    // Additional metric types for compatibility
    this.histograms = new Map();
    this.summaries = new Map();
    
    // HTTP middleware support
    this.middlewareActive = false;
  }

  /**
   * Initialize with enhanced features
   */
  async initialize() {
    await super.start();
    
    // Initialize Prometheus compatibility if needed
    if (this.config.prometheusEnabled !== false) {
      this.initializePrometheus();
    }
    
    this.emit('monitoring:initialized');
  }

  /**
   * Initialize Prometheus compatibility layer
   */
  initializePrometheus() {
    // We'll use our existing exportPrometheus method
    // but add support for more metric types
    this.prometheusRegistry = {
      contentType: 'text/plain; version=0.0.4; charset=utf-8',
      metrics: () => this.exportPrometheus()
    };
  }

  /**
   * Enhanced counter increment (compatible with both APIs)
   */
  inc(name, labelValues = {}, value = 1) {
    this.incrementCounter(name, value);
    
    // Also record as custom metric with labels
    if (Object.keys(labelValues).length > 0) {
      const labelStr = Object.entries(labelValues)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',');
      this.recordCustomMetric(`${name}_${labelStr}`, value);
    }
  }

  /**
   * Enhanced gauge set (compatible with both APIs)
   */
  set(name, labelValues = {}, value) {
    // Record as custom metric
    const metricName = Object.keys(labelValues).length > 0
      ? `${name}_${Object.entries(labelValues).map(([k, v]) => `${k}="${v}"`).join(',')}`
      : name;
    
    this.recordCustomMetric(metricName, value);
  }

  /**
   * Record histogram observation
   */
  observe(name, labelValues = {}, value) {
    const key = this.getMetricKey(name, labelValues);
    
    if (!this.histograms.has(key)) {
      this.histograms.set(key, {
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        values: [],
        sum: 0,
        count: 0
      });
    }
    
    const histogram = this.histograms.get(key);
    histogram.values.push(value);
    histogram.sum += value;
    histogram.count++;
    
    // Limit values array size
    if (histogram.values.length > 1000) {
      histogram.values = histogram.values.slice(-500);
    }
    
    // Also record as custom metric
    this.recordCustomMetric(`${key}_sum`, histogram.sum);
    this.recordCustomMetric(`${key}_count`, histogram.count);
  }

  /**
   * Time a function execution (compatible API)
   */
  async time(name, labelValues = {}, fn) {
    const timing = `timing_${name}`;
    this.startTiming(timing);
    
    try {
      const result = await fn();
      const duration = this.endTiming(timing);
      this.observe(name, labelValues, duration / 1000); // Convert to seconds
      return result;
    } catch (error) {
      const duration = this.endTiming(timing);
      this.observe(name, { ...labelValues, error: 'true' }, duration / 1000);
      throw error;
    }
  }

  /**
   * Record HTTP request (enhanced compatibility)
   */
  recordHttpRequest(method, route, statusCode, duration, requestSize = 0, responseSize = 0) {
    // Use existing counter system
    this.incrementCounter('http_requests_total');
    this.incrementCounter(`http_requests_${method}_${statusCode}`);
    
    // Record timing
    this.observe('http_request_duration_seconds', 
      { method, route: this.sanitizeRoute(route), status_code: statusCode },
      duration
    );
    
    // Record sizes if provided
    if (requestSize > 0) {
      this.recordCustomMetric('http_request_size_bytes', requestSize);
    }
    
    if (responseSize > 0) {
      this.recordCustomMetric('http_response_size_bytes', responseSize);
    }
  }

  /**
   * Record database query (enhanced compatibility)
   */
  recordDbQuery(operation, table, duration, status = 'success') {
    this.incrementCounter(`db_queries_${operation}_${status}`);
    
    this.observe('db_query_duration_seconds',
      { operation, table: this.sanitizeLabel(table) },
      duration
    );
    
    // Track slow queries
    if (duration > 0.1) { // 100ms
      this.incrementCounter('db_slow_queries');
      this.createAlert('slow_query', 
        `Slow ${operation} query on ${table}: ${duration}s`,
        this.AlertSeverity.WARNING,
        { operation, table, duration }
      );
    }
  }

  /**
   * HTTP middleware (Express/Koa compatible)
   */
  httpMiddleware() {
    return (req, res, next) => {
      if (!this.running) {
        return next();
      }
      
      const start = Date.now();
      
      // Track active connections
      this.incrementCounter('http_active_connections');
      this.middlewareActive = true;
      
      // Store original end method
      const originalEnd = res.end;
      let responseSize = 0;
      
      // Override end to capture metrics
      res.end = (...args) => {
        // Calculate metrics
        const duration = (Date.now() - start) / 1000;
        const route = req.route?.path || req.path || req.url;
        
        // Record metrics
        this.recordHttpRequest(
          req.method,
          route,
          res.statusCode,
          duration,
          parseInt(req.get('content-length') || '0'),
          responseSize
        );
        
        // Decrement active connections
        this.incrementCounter('http_active_connections', -1);
        
        // Call original end
        return originalEnd.apply(res, args);
      };
      
      // Track response size
      const originalWrite = res.write;
      res.write = function(...args) {
        if (args[0]) {
          responseSize += Buffer.byteLength(args[0]);
        }
        return originalWrite.apply(res, args);
      };
      
      next();
    };
  }

  /**
   * Metrics endpoint handler (Express/Koa compatible)
   */
  metricsEndpoint() {
    return async (req, res) => {
      try {
        const metrics = await this.exportPrometheus();
        res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.end(metrics);
      } catch (error) {
        res.status(500).end(error.message);
      }
    };
  }

  /**
   * Enhanced Prometheus export with all metric types
   */
  exportPrometheus() {
    const lines = [];
    const timestamp = Date.now();
    
    // First, export standard metrics from parent class
    lines.push(super.exportPrometheus());
    
    // Export histograms
    for (const [key, histogram] of this.histograms) {
      const [name, ...labelParts] = key.split('_');
      const labels = labelParts.join('_');
      
      lines.push(`# HELP ${name} Histogram metric`);
      lines.push(`# TYPE ${name} histogram`);
      
      // Bucket counts
      const buckets = histogram.buckets;
      for (const bucket of buckets) {
        const count = histogram.values.filter(v => v <= bucket).length;
        const labelStr = labels ? `{${labels},le="${bucket}"}` : `{le="${bucket}"}`;
        lines.push(`${name}_bucket${labelStr} ${count} ${timestamp}`);
      }
      
      // +Inf bucket
      const infLabel = labels ? `{${labels},le="+Inf"}` : `{le="+Inf"}`;
      lines.push(`${name}_bucket${infLabel} ${histogram.count} ${timestamp}`);
      
      // Sum and count
      const sumLabel = labels ? `{${labels}}` : '';
      lines.push(`${name}_sum${sumLabel} ${histogram.sum} ${timestamp}`);
      lines.push(`${name}_count${sumLabel} ${histogram.count} ${timestamp}`);
    }
    
    return lines.join('\n');
  }

  /**
   * Get metric key for labelled metrics
   */
  getMetricKey(name, labelValues) {
    if (Object.keys(labelValues).length === 0) {
      return name;
    }
    
    const labels = Object.entries(labelValues)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    
    return `${name}_${labels}`;
  }

  /**
   * Sanitize route for labels
   */
  sanitizeRoute(route) {
    if (!route) return 'unknown';
    
    return route
      .replace(/\/\d+/g, '/:id')
      .replace(/\/[a-f0-9-]{36}/gi, '/:uuid')
      .replace(/\/0x[a-f0-9]+/gi, '/:hash')
      .substring(0, 100);
  }

  /**
   * Sanitize label value
   */
  sanitizeLabel(value) {
    if (!value) return 'unknown';
    
    return String(value)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .substring(0, 50);
  }

  /**
   * Get metrics as JSON (compatibility)
   */
  async getMetricsJson() {
    return {
      timestamp: Date.now(),
      system: this.current.system,
      application: this.current.application,
      mining: this.current.mining,
      dex: this.current.dex,
      custom: Object.fromEntries(this.metrics.custom),
      alerts: this.getActiveAlerts(),
      health: this.getHealthStatus()
    };
  }

  /**
   * Shutdown gracefully
   */
  async shutdown() {
    this.stop();
    await super.shutdown();
  }
}

/**
 * Get or create monitoring instance
 */
export function getMonitoring(options = {}) {
  if (!monitoringInstance) {
    monitoringInstance = new ConsolidatedMonitoring(options);
    
    // Auto-start if not disabled
    if (options.autoStart !== false) {
      monitoringInstance.initialize().catch(error => {
        console.error('Failed to initialize monitoring:', error);
      });
    }
  }
  
  return monitoringInstance;
}

/**
 * Convenience exports for common operations
 */
export const monitoring = getMonitoring();

// Direct method exports for compatibility
export const inc = (name, labels, value) => monitoring.inc(name, labels, value);
export const set = (name, labels, value) => monitoring.set(name, labels, value);
export const observe = (name, labels, value) => monitoring.observe(name, labels, value);
export const time = (name, labels, fn) => monitoring.time(name, labels, fn);
export const recordHttpRequest = (...args) => monitoring.recordHttpRequest(...args);
export const recordDbQuery = (...args) => monitoring.recordDbQuery(...args);
export const httpMiddleware = () => monitoring.httpMiddleware();
export const metricsEndpoint = () => monitoring.metricsEndpoint();

// Re-export types
export { MetricType, AlertSeverity, HealthStatus } from './unified-monitoring-manager.js';

// Default export
export default ConsolidatedMonitoring;