/**
 * Advanced Analytics and Reporting System for Otedama
 * Provides comprehensive metrics, insights, and reporting capabilities
 */

import { EventEmitter } from 'events';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { Logger } from './logger.js';

/**
 * Time series data store
 */
class TimeSeriesStore {
  constructor(maxDataPoints = 10000) {
    this.data = new Map();
    this.maxDataPoints = maxDataPoints;
  }
  
  add(metric, value, timestamp = Date.now()) {
    if (!this.data.has(metric)) {
      this.data.set(metric, []);
    }
    
    const series = this.data.get(metric);
    series.push({ timestamp, value });
    
    // Keep only recent data points
    if (series.length > this.maxDataPoints) {
      series.shift();
    }
  }
  
  get(metric, start = 0, end = Date.now()) {
    const series = this.data.get(metric) || [];
    return series.filter(point => 
      point.timestamp >= start && point.timestamp <= end
    );
  }
  
  getMetrics() {
    return Array.from(this.data.keys());
  }
  
  clear(metric = null) {
    if (metric) {
      this.data.delete(metric);
    } else {
      this.data.clear();
    }
  }
}

/**
 * Analytics aggregator
 */
class Aggregator {
  aggregate(data, type = 'sum') {
    if (!data || data.length === 0) return null;
    
    const values = data.map(d => d.value);
    
    switch (type) {
      case 'sum':
        return values.reduce((a, b) => a + b, 0);
      
      case 'avg':
      case 'mean':
        return values.reduce((a, b) => a + b, 0) / values.length;
      
      case 'min':
        return Math.min(...values);
      
      case 'max':
        return Math.max(...values);
      
      case 'count':
        return values.length;
      
      case 'median':
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 
          ? sorted[mid]
          : (sorted[mid - 1] + sorted[mid]) / 2;
      
      case 'stddev':
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((sum, val) => 
          sum + Math.pow(val - mean, 2), 0) / values.length;
        return Math.sqrt(variance);
      
      case 'percentile':
        // Default to 95th percentile
        return this.percentile(values, 0.95);
      
      default:
        return null;
    }
  }
  
  percentile(values, p) {
    const sorted = [...values].sort((a, b) => a - b);
    const index = p * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index % 1;
    
    if (lower === upper) {
      return sorted[lower];
    }
    
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }
  
  rate(data, interval = 60000) {
    // Calculate rate per interval (default: per minute)
    if (!data || data.length < 2) return 0;
    
    const first = data[0];
    const last = data[data.length - 1];
    const timeDiff = last.timestamp - first.timestamp;
    const valueDiff = last.value - first.value;
    
    return (valueDiff / timeDiff) * interval;
  }
}

/**
 * Analytics Engine
 */
export class AnalyticsEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      flushInterval: options.flushInterval || 60000, // 1 minute
      retentionPeriod: options.retentionPeriod || 7 * 24 * 60 * 60 * 1000, // 7 days
      reportsPath: options.reportsPath || './reports',
      ...options
    };
    
    this.logger = options.logger || new Logger();
    this.timeSeries = new TimeSeriesStore(options.maxDataPoints);
    this.aggregator = new Aggregator();
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    this.alerts = new Map();
    this.reports = new Map();
    
    // Start periodic flush
    this.flushInterval = setInterval(() => {
      this.flush().catch(error => {
        this.logger.error('Analytics flush failed', { error });
      });
    }, this.options.flushInterval);
  }
  
  /**
   * Track counter metric
   */
  increment(metric, value = 1, tags = {}) {
    const key = this.getKey(metric, tags);
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + value);
    
    // Store in time series
    this.timeSeries.add(key, current + value);
    
    this.emit('metric', {
      type: 'counter',
      metric,
      value: current + value,
      tags,
      timestamp: Date.now()
    });
  }
  
  /**
   * Track gauge metric
   */
  gauge(metric, value, tags = {}) {
    const key = this.getKey(metric, tags);
    this.gauges.set(key, value);
    
    // Store in time series
    this.timeSeries.add(key, value);
    
    this.emit('metric', {
      type: 'gauge',
      metric,
      value,
      tags,
      timestamp: Date.now()
    });
  }
  
  /**
   * Track histogram metric
   */
  histogram(metric, value, tags = {}) {
    const key = this.getKey(metric, tags);
    
    if (!this.histograms.has(key)) {
      this.histograms.set(key, []);
    }
    
    this.histograms.get(key).push(value);
    
    // Store in time series
    this.timeSeries.add(key, value);
    
    this.emit('metric', {
      type: 'histogram',
      metric,
      value,
      tags,
      timestamp: Date.now()
    });
  }
  
  /**
   * Track timing metric
   */
  timing(metric, duration, tags = {}) {
    this.histogram(`${metric}.duration`, duration, tags);
  }
  
  /**
   * Create timer
   */
  timer(metric, tags = {}) {
    const start = Date.now();
    
    return {
      end: () => {
        const duration = Date.now() - start;
        this.timing(metric, duration, tags);
        return duration;
      }
    };
  }
  
  /**
   * Query metrics
   */
  query(metric, options = {}) {
    const {
      start = Date.now() - 3600000, // Last hour
      end = Date.now(),
      aggregation = 'avg',
      interval = null,
      tags = {}
    } = options;
    
    const key = this.getKey(metric, tags);
    const data = this.timeSeries.get(key, start, end);
    
    if (!interval) {
      // Return raw data or single aggregation
      return aggregation ? this.aggregator.aggregate(data, aggregation) : data;
    }
    
    // Return time-bucketed aggregations
    const buckets = [];
    let currentBucket = Math.floor(start / interval) * interval;
    
    while (currentBucket <= end) {
      const bucketEnd = currentBucket + interval;
      const bucketData = data.filter(d => 
        d.timestamp >= currentBucket && d.timestamp < bucketEnd
      );
      
      buckets.push({
        timestamp: currentBucket,
        value: this.aggregator.aggregate(bucketData, aggregation),
        count: bucketData.length
      });
      
      currentBucket = bucketEnd;
    }
    
    return buckets;
  }
  
  /**
   * Set alert rule
   */
  setAlert(name, rule) {
    this.alerts.set(name, {
      ...rule,
      enabled: rule.enabled !== false,
      triggered: false,
      lastCheck: 0
    });
  }
  
  /**
   * Check alerts
   */
  async checkAlerts() {
    const now = Date.now();
    
    for (const [name, alert] of this.alerts) {
      if (!alert.enabled) continue;
      
      // Check interval
      if (now - alert.lastCheck < (alert.checkInterval || 60000)) {
        continue;
      }
      
      alert.lastCheck = now;
      
      try {
        // Evaluate condition
        const value = await this.evaluateAlertCondition(alert);
        const shouldTrigger = this.checkThreshold(value, alert.threshold, alert.operator);
        
        if (shouldTrigger && !alert.triggered) {
          // Trigger alert
          alert.triggered = true;
          alert.triggeredAt = now;
          
          this.emit('alert', {
            name,
            alert,
            value,
            timestamp: now
          });
          
          this.logger.warn('Alert triggered', { name, value, threshold: alert.threshold });
        } else if (!shouldTrigger && alert.triggered) {
          // Clear alert
          alert.triggered = false;
          alert.clearedAt = now;
          
          this.emit('alert.cleared', {
            name,
            alert,
            value,
            timestamp: now
          });
          
          this.logger.info('Alert cleared', { name });
        }
      } catch (error) {
        this.logger.error('Alert check failed', { name, error });
      }
    }
  }
  
  /**
   * Evaluate alert condition
   */
  async evaluateAlertCondition(alert) {
    const { metric, aggregation = 'avg', window = 300000, tags = {} } = alert;
    
    const data = this.query(metric, {
      start: Date.now() - window,
      end: Date.now(),
      aggregation,
      tags
    });
    
    return data;
  }
  
  /**
   * Check threshold
   */
  checkThreshold(value, threshold, operator = '>') {
    if (value === null || value === undefined) return false;
    
    switch (operator) {
      case '>':
        return value > threshold;
      case '>=':
        return value >= threshold;
      case '<':
        return value < threshold;
      case '<=':
        return value <= threshold;
      case '==':
        return value === threshold;
      case '!=':
        return value !== threshold;
      default:
        return false;
    }
  }
  
  /**
   * Generate report
   */
  async generateReport(type, options = {}) {
    const report = {
      type,
      generatedAt: Date.now(),
      period: options.period || 'daily',
      data: {}
    };
    
    switch (type) {
      case 'mining':
        report.data = await this.generateMiningReport(options);
        break;
      
      case 'revenue':
        report.data = await this.generateRevenueReport(options);
        break;
      
      case 'performance':
        report.data = await this.generatePerformanceReport(options);
        break;
      
      case 'security':
        report.data = await this.generateSecurityReport(options);
        break;
      
      case 'custom':
        report.data = await this.generateCustomReport(options);
        break;
      
      default:
        throw new Error(`Unknown report type: ${type}`);
    }
    
    // Save report
    const reportId = `${type}_${Date.now()}`;
    this.reports.set(reportId, report);
    
    // Persist to disk
    await this.saveReport(reportId, report);
    
    return report;
  }
  
  /**
   * Generate mining report
   */
  async generateMiningReport(options) {
    const { start, end } = this.getReportPeriod(options.period);
    
    return {
      overview: {
        totalHashrate: this.query('pool.hashrate', { start, end, aggregation: 'avg' }),
        totalMiners: this.query('pool.miners.active', { start, end, aggregation: 'avg' }),
        blocksFound: this.query('pool.blocks.found', { start, end, aggregation: 'sum' }),
        sharesSubmitted: this.query('pool.shares.submitted', { start, end, aggregation: 'sum' }),
        sharesAccepted: this.query('pool.shares.accepted', { start, end, aggregation: 'sum' }),
        efficiency: this.calculateEfficiency(start, end)
      },
      algorithms: await this.getAlgorithmStats(start, end),
      topMiners: await this.getTopMiners(start, end),
      hourlyStats: this.query('pool.hashrate', {
        start,
        end,
        aggregation: 'avg',
        interval: 3600000 // 1 hour
      })
    };
  }
  
  /**
   * Generate revenue report
   */
  async generateRevenueReport(options) {
    const { start, end } = this.getReportPeriod(options.period);
    
    return {
      overview: {
        totalRevenue: this.query('revenue.total', { start, end, aggregation: 'sum' }),
        miningRevenue: this.query('revenue.mining', { start, end, aggregation: 'sum' }),
        feeRevenue: this.query('revenue.fees', { start, end, aggregation: 'sum' }),
        exchangeRevenue: this.query('revenue.exchange', { start, end, aggregation: 'sum' }),
        totalPayouts: this.query('payouts.total', { start, end, aggregation: 'sum' }),
        netRevenue: await this.calculateNetRevenue(start, end)
      },
      currencies: await this.getCurrencyBreakdown(start, end),
      payoutStats: {
        count: this.query('payouts.count', { start, end, aggregation: 'sum' }),
        average: this.query('payouts.amount', { start, end, aggregation: 'avg' }),
        total: this.query('payouts.total', { start, end, aggregation: 'sum' })
      },
      dailyRevenue: this.query('revenue.total', {
        start,
        end,
        aggregation: 'sum',
        interval: 86400000 // 1 day
      })
    };
  }
  
  /**
   * Generate performance report
   */
  async generatePerformanceReport(options) {
    const { start, end } = this.getReportPeriod(options.period);
    
    return {
      api: {
        requestRate: this.query('api.requests', { start, end, aggregation: 'rate' }),
        responseTime: {
          avg: this.query('api.response_time', { start, end, aggregation: 'avg' }),
          p50: this.query('api.response_time', { start, end, aggregation: 'median' }),
          p95: this.query('api.response_time', { start, end, aggregation: 'percentile' }),
          p99: this.getPercentile('api.response_time', 0.99, start, end)
        },
        errorRate: this.calculateErrorRate('api', start, end),
        endpoints: await this.getEndpointStats(start, end)
      },
      system: {
        cpu: this.query('system.cpu', { start, end, aggregation: 'avg' }),
        memory: this.query('system.memory', { start, end, aggregation: 'avg' }),
        disk: this.query('system.disk', { start, end, aggregation: 'avg' }),
        network: {
          in: this.query('system.network.in', { start, end, aggregation: 'sum' }),
          out: this.query('system.network.out', { start, end, aggregation: 'sum' })
        }
      },
      database: {
        queryTime: this.query('db.query_time', { start, end, aggregation: 'avg' }),
        connections: this.query('db.connections', { start, end, aggregation: 'avg' }),
        slowQueries: this.query('db.slow_queries', { start, end, aggregation: 'sum' })
      }
    };
  }
  
  /**
   * Generate security report
   */
  async generateSecurityReport(options) {
    const { start, end } = this.getReportPeriod(options.period);
    
    return {
      authentication: {
        attempts: this.query('auth.attempts', { start, end, aggregation: 'sum' }),
        failures: this.query('auth.failures', { start, end, aggregation: 'sum' }),
        successRate: await this.calculateAuthSuccessRate(start, end),
        twoFactorUsage: this.query('auth.2fa.enabled', { start, end, aggregation: 'avg' })
      },
      threats: {
        blockedIPs: this.query('security.blocked_ips', { start, end, aggregation: 'sum' }),
        rateLimitHits: this.query('security.rate_limit_hits', { start, end, aggregation: 'sum' }),
        suspiciousActivity: this.query('security.suspicious', { start, end, aggregation: 'sum' }),
        attacks: await this.getAttackPatterns(start, end)
      },
      audit: {
        events: this.query('audit.events', { start, end, aggregation: 'sum' }),
        criticalEvents: this.query('audit.critical', { start, end, aggregation: 'sum' }),
        userActions: await this.getUserActionSummary(start, end)
      }
    };
  }
  
  /**
   * Generate custom report
   */
  async generateCustomReport(options) {
    const { metrics, period, aggregations } = options;
    const { start, end } = this.getReportPeriod(period);
    
    const report = {};
    
    for (const metric of metrics) {
      report[metric] = {};
      
      for (const agg of aggregations) {
        report[metric][agg] = this.query(metric, {
          start,
          end,
          aggregation: agg
        });
      }
    }
    
    return report;
  }
  
  /**
   * Calculate efficiency
   */
  async calculateEfficiency(start, end) {
    const accepted = this.query('pool.shares.accepted', { start, end, aggregation: 'sum' }) || 0;
    const submitted = this.query('pool.shares.submitted', { start, end, aggregation: 'sum' }) || 1;
    
    return (accepted / submitted) * 100;
  }
  
  /**
   * Calculate error rate
   */
  async calculateErrorRate(prefix, start, end) {
    const errors = this.query(`${prefix}.errors`, { start, end, aggregation: 'sum' }) || 0;
    const total = this.query(`${prefix}.requests`, { start, end, aggregation: 'sum' }) || 1;
    
    return (errors / total) * 100;
  }
  
  /**
   * Get top miners
   */
  async getTopMiners(start, end, limit = 10) {
    const miners = new Map();
    
    // Aggregate miner stats
    for (const [key, value] of this.counters) {
      if (key.startsWith('miner.') && key.includes('.hashrate')) {
        const minerId = key.split('.')[1];
        const hashrate = this.query(key, { start, end, aggregation: 'avg' });
        
        if (!miners.has(minerId)) {
          miners.set(minerId, {
            id: minerId,
            hashrate: 0,
            shares: 0,
            blocks: 0
          });
        }
        
        const miner = miners.get(minerId);
        miner.hashrate = hashrate;
        miner.shares = this.query(`miner.${minerId}.shares`, { start, end, aggregation: 'sum' });
        miner.blocks = this.query(`miner.${minerId}.blocks`, { start, end, aggregation: 'sum' });
      }
    }
    
    // Sort and limit
    return Array.from(miners.values())
      .sort((a, b) => b.hashrate - a.hashrate)
      .slice(0, limit);
  }
  
  /**
   * Get report period
   */
  getReportPeriod(period) {
    const now = Date.now();
    let start;
    
    switch (period) {
      case 'hourly':
        start = now - 3600000; // 1 hour
        break;
      case 'daily':
        start = now - 86400000; // 24 hours
        break;
      case 'weekly':
        start = now - 604800000; // 7 days
        break;
      case 'monthly':
        start = now - 2592000000; // 30 days
        break;
      default:
        start = now - 86400000; // Default to daily
    }
    
    return { start, end: now };
  }
  
  /**
   * Get metric key
   */
  getKey(metric, tags = {}) {
    if (Object.keys(tags).length === 0) {
      return metric;
    }
    
    const tagStr = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(',');
    
    return `${metric}{${tagStr}}`;
  }
  
  /**
   * Save report to disk
   */
  async saveReport(id, report) {
    const dir = join(this.options.reportsPath, report.type);
    
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    
    const filename = `${id}.json`;
    const filepath = join(dir, filename);
    
    await writeFile(filepath, JSON.stringify(report, null, 2));
    
    this.logger.info('Report saved', { id, type: report.type, path: filepath });
  }
  
  /**
   * Load report from disk
   */
  async loadReport(id) {
    if (this.reports.has(id)) {
      return this.reports.get(id);
    }
    
    // Try to load from disk
    const files = await this.findReportFile(id);
    
    if (files.length === 0) {
      throw new Error(`Report not found: ${id}`);
    }
    
    const content = await readFile(files[0], 'utf8');
    const report = JSON.parse(content);
    
    this.reports.set(id, report);
    
    return report;
  }
  
  /**
   * List reports
   */
  async listReports(type = null, limit = 100) {
    const reports = [];
    
    // From memory
    for (const [id, report] of this.reports) {
      if (!type || report.type === type) {
        reports.push({
          id,
          type: report.type,
          generatedAt: report.generatedAt,
          period: report.period
        });
      }
    }
    
    // TODO: Also list from disk
    
    return reports
      .sort((a, b) => b.generatedAt - a.generatedAt)
      .slice(0, limit);
  }
  
  /**
   * Export metrics
   */
  async exportMetrics(format = 'json', options = {}) {
    const { start, end, metrics = [] } = options;
    const data = {};
    
    const metricsToExport = metrics.length > 0 
      ? metrics 
      : this.timeSeries.getMetrics();
    
    for (const metric of metricsToExport) {
      data[metric] = this.timeSeries.get(metric, start, end);
    }
    
    switch (format) {
      case 'json':
        return JSON.stringify(data, null, 2);
      
      case 'csv':
        return this.exportToCSV(data);
      
      case 'prometheus':
        return this.exportToPrometheus(data);
      
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }
  
  /**
   * Export to CSV
   */
  exportToCSV(data) {
    const rows = ['metric,timestamp,value'];
    
    for (const [metric, points] of Object.entries(data)) {
      for (const point of points) {
        rows.push(`${metric},${point.timestamp},${point.value}`);
      }
    }
    
    return rows.join('\n');
  }
  
  /**
   * Export to Prometheus format
   */
  exportToPrometheus(data) {
    const lines = [];
    
    for (const [metric, points] of Object.entries(data)) {
      const latestPoint = points[points.length - 1];
      
      if (latestPoint) {
        // Convert metric name to Prometheus format
        const promMetric = metric.replace(/[^a-zA-Z0-9_]/g, '_');
        lines.push(`${promMetric} ${latestPoint.value} ${latestPoint.timestamp}`);
      }
    }
    
    return lines.join('\n');
  }
  
  /**
   * Flush metrics
   */
  async flush() {
    // Check alerts
    await this.checkAlerts();
    
    // Clean old data
    const cutoff = Date.now() - this.options.retentionPeriod;
    
    for (const metric of this.timeSeries.getMetrics()) {
      const data = this.timeSeries.get(metric);
      const recentData = data.filter(d => d.timestamp > cutoff);
      
      if (recentData.length < data.length) {
        this.timeSeries.clear(metric);
        recentData.forEach(d => this.timeSeries.add(metric, d.value, d.timestamp));
      }
    }
    
    this.emit('flush', {
      timestamp: Date.now(),
      metrics: this.timeSeries.getMetrics().length
    });
  }
  
  /**
   * Cleanup
   */
  async cleanup() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    
    // Final flush
    await this.flush();
    
    this.logger.info('Analytics engine cleaned up');
  }
}

// Create singleton instance
let analyticsInstance;

export function createAnalytics(options) {
  if (!analyticsInstance) {
    analyticsInstance = new AnalyticsEngine(options);
  }
  return analyticsInstance;
}

export function getAnalytics() {
  if (!analyticsInstance) {
    throw new Error('Analytics not initialized');
  }
  return analyticsInstance;
}

// Convenience exports
export const increment = (metric, value, tags) => getAnalytics().increment(metric, value, tags);
export const gauge = (metric, value, tags) => getAnalytics().gauge(metric, value, tags);
export const histogram = (metric, value, tags) => getAnalytics().histogram(metric, value, tags);
export const timing = (metric, duration, tags) => getAnalytics().timing(metric, duration, tags);
export const timer = (metric, tags) => getAnalytics().timer(metric, tags);