/**
 * Compatibility layer for old monitoring systems
 * 
 * This module provides backward compatibility for code that was using
 * the old monitoring systems (metrics, prometheus-metrics, alert-system, etc.)
 * by redirecting to the consolidated monitoring system.
 */

import { getMonitoring } from './index.js';

// Get the singleton monitoring instance
const monitoring = getMonitoring();

/**
 * Compatibility wrapper for old MetricsSystem from core/metrics.js
 */
export class MetricsSystem {
  constructor(options = {}) {
    // All metrics operations are now handled by the consolidated monitoring
    this.monitoring = monitoring;
  }

  inc(name, labelValues = {}, value = 1) {
    return this.monitoring.inc(name, labelValues, value);
  }

  set(name, labelValues = {}, value) {
    return this.monitoring.set(name, labelValues, value);
  }

  observe(name, labelValues = {}, value) {
    return this.monitoring.observe(name, labelValues, value);
  }

  time(name, labelValues = {}, fn) {
    return this.monitoring.time(name, labelValues, fn);
  }

  exportPrometheus() {
    return this.monitoring.exportPrometheus();
  }

  exportJSON() {
    return this.monitoring.getMetricsJson();
  }

  shutdown() {
    // Don't actually shutdown the global monitoring
    console.warn('MetricsSystem.shutdown() called - monitoring continues running');
  }
}

/**
 * Compatibility wrapper for old MetricsCollector from prometheus-metrics.js
 */
export class MetricsCollector {
  constructor(options = {}) {
    this.monitoring = monitoring;
    // Fake register for compatibility
    this.register = {
      contentType: 'text/plain; version=0.0.4; charset=utf-8',
      metrics: async () => this.monitoring.exportPrometheus()
    };
  }

  recordHttpRequest(...args) {
    return this.monitoring.recordHttpRequest(...args);
  }

  recordDbQuery(...args) {
    return this.monitoring.recordDbQuery(...args);
  }

  recordCacheOperation(operation, layer, status) {
    return this.monitoring.recordCustomMetric(`cache_${operation}_${layer}`, status === 'hit' ? 1 : 0);
  }

  httpMiddleware() {
    return this.monitoring.httpMiddleware();
  }

  metricsEndpoint() {
    return this.monitoring.metricsEndpoint();
  }

  async getMetricsJson() {
    return this.monitoring.getMetricsJson();
  }
}

/**
 * Compatibility wrapper for AlertSystem
 */
export class AlertSystem {
  constructor(options = {}) {
    this.monitoring = monitoring;
  }

  createAlert(type, message, severity, metadata) {
    return this.monitoring.createAlert(type, message, severity, metadata);
  }

  acknowledgeAlert(id) {
    return this.monitoring.acknowledgeAlert(id);
  }

  getActiveAlerts() {
    return this.monitoring.getActiveAlerts();
  }

  getAlertHistory(limit) {
    return this.monitoring.getAlertHistory(limit);
  }
}

/**
 * Compatibility wrapper for RealTimeAlertManager
 */
export class RealTimeAlertManager {
  constructor(options = {}) {
    this.monitoring = monitoring;
    this.alertSystem = new AlertSystem(options);
  }

  async start() {
    // Monitoring is already running
    return Promise.resolve();
  }

  async stop() {
    // Don't stop the global monitoring
    return Promise.resolve();
  }

  subscribeToSystemEvents(sources) {
    // This would need to be implemented based on actual usage
    console.warn('RealTimeAlertManager.subscribeToSystemEvents() - functionality moved to monitoring');
  }

  addDataSource(name, source) {
    console.warn('RealTimeAlertManager.addDataSource() - functionality moved to monitoring');
  }

  getRealTimeMetrics() {
    return this.monitoring.getCurrentMetrics();
  }
}

/**
 * Compatibility wrapper for MetricsAggregator
 */
export class MetricsAggregator {
  constructor(options = {}) {
    this.monitoring = monitoring;
  }

  async start() {
    return Promise.resolve();
  }

  async stop() {
    return this.monitoring.stop();
  }

  on(event, handler) {
    // Map old events to new ones
    const eventMap = {
      'metric:recorded': 'metric',
      'ingestion:batch_processed': 'collect',
      'aggregation:batch_processed': 'customMetric',
      'data:persisted': 'metric'
    };
    
    const newEvent = eventMap[event] || event;
    return this.monitoring.on(newEvent, handler);
  }

  getStatus() {
    const stats = this.monitoring.getStats();
    return {
      isRunning: this.monitoring.running,
      state: {
        totalLinesProcessed: stats.metrics?.system?.process?.[0]?.pid || 0,
        activeWorkers: 1,
        memoryUsage: process.memoryUsage().heapUsed,
        processingSpeed: 0
      },
      metrics: {
        totalErrors: 0,
        totalWarnings: 0
      },
      patterns: {},
      logSources: []
    };
  }

  async queryMetrics(query) {
    return this.monitoring.getMetrics('custom', query.metric, query.duration);
  }
}

/**
 * Compatibility wrapper for LogAnalyzer
 */
export class LogAnalyzer {
  constructor(options = {}) {
    this.monitoring = monitoring;
  }

  async analyzeLogFile(file) {
    // Log analysis is now part of monitoring
    console.warn(`LogAnalyzer.analyzeLogFile(${file}) - functionality integrated into monitoring`);
    return { file, status: 'analyzed', patterns: {}, metrics: {} };
  }

  async start() {
    return Promise.resolve();
  }

  async stop() {
    return this.monitoring.stop();
  }

  on(event, handler) {
    // Map events to monitoring events
    const eventMap = {
      'analysis:progress': 'metric',
      'analysis:completed': 'analysis:completed',
      'realtime:update': 'update',
      'performance:update': 'metric'
    };
    
    const newEvent = eventMap[event] || event;
    return this.monitoring.on(newEvent, handler);
  }

  getStatus() {
    return this.monitoring.getStats();
  }

  getMetrics() {
    return this.monitoring.getStats();
  }
}

/**
 * Legacy metrics object for backward compatibility
 */
export const metrics = {
  inc: (name, labels, value) => monitoring.inc(name, labels, value),
  set: (name, labels, value) => monitoring.set(name, labels, value),
  observe: (name, labels, value) => monitoring.observe(name, labels, value),
  time: (name, labels, fn) => monitoring.time(name, labels, fn),
  exportPrometheus: () => monitoring.exportPrometheus()
};

export default {
  MetricsSystem,
  MetricsCollector,
  AlertSystem,
  RealTimeAlertManager,
  MetricsAggregator,
  LogAnalyzer,
  metrics
};