/**
 * Monitoring & Analytics Module for Otedama Ver0.6
 * Implements comprehensive monitoring and analytics
 */

import { EventEmitter } from 'events';
import { cpus, freemem, totalmem, loadavg } from 'os';
import { performance } from 'perf_hooks';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Metrics Collector
 */
export class MetricsCollector extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      interval: options.interval || 60000, // 1 minute
      retention: options.retention || 86400000, // 24 hours
      maxDataPoints: options.maxDataPoints || 1440, // 24 hours of minutes
      ...options
    };
    
    this.metrics = {
      system: [],
      application: [],
      business: [],
      custom: new Map()
    };
    
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    this.timers = new Map();
    
    this.startCollection();
  }
  
  // Counter metrics (always increasing)
  incrementCounter(name, value = 1, tags = {}) {
    const key = this.getKey(name, tags);
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + value);
    
    this.emit('metric', {
      type: 'counter',
      name,
      value: current + value,
      tags,
      timestamp: Date.now()
    });
  }
  
  // Gauge metrics (can go up or down)
  setGauge(name, value, tags = {}) {
    const key = this.getKey(name, tags);
    this.gauges.set(key, value);
    
    this.emit('metric', {
      type: 'gauge',
      name,
      value,
      tags,
      timestamp: Date.now()
    });
  }
  
  // Histogram metrics (distribution of values)
  recordHistogram(name, value, tags = {}) {
    const key = this.getKey(name, tags);
    if (!this.histograms.has(key)) {
      this.histograms.set(key, []);
    }
    
    const histogram = this.histograms.get(key);
    histogram.push(value);
    
    // Keep only recent values
    if (histogram.length > 1000) {
      histogram.shift();
    }
    
    this.emit('metric', {
      type: 'histogram',
      name,
      value,
      tags,
      timestamp: Date.now()
    });
  }
  
  // Timer metrics
  startTimer(name, tags = {}) {
    const key = this.getKey(name, tags);
    this.timers.set(key, performance.now());
    
    return () => {
      const start = this.timers.get(key);
      if (start) {
        const duration = performance.now() - start;
        this.recordHistogram(`${name}.duration`, duration, tags);
        this.timers.delete(key);
        return duration;
      }
      return 0;
    };
  }
  
  // Get metric key
  getKey(name, tags = {}) {
    const tagStr = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(',');
    return tagStr ? `${name}{${tagStr}}` : name;
  }
  
  // Collect system metrics
  collectSystemMetrics() {
    const cpuInfo = cpus();
    const cpuUsage = this.calculateCPUUsage(cpuInfo);
    
    const systemMetrics = {
      timestamp: Date.now(),
      cpu: {
        usage: cpuUsage,
        count: cpuInfo.length,
        loadAvg: loadavg()
      },
      memory: {
        total: totalmem(),
        free: freemem(),
        used: totalmem() - freemem(),
        usagePercent: ((totalmem() - freemem()) / totalmem()) * 100
      },
      process: {
        uptime: process.uptime(),
        pid: process.pid,
        memory: process.memoryUsage(),
        cpu: process.cpuUsage()
      }
    };
    
    // Store metrics
    this.metrics.system.push(systemMetrics);
    this.pruneMetrics('system');
    
    // Set gauges
    this.setGauge('system.cpu.usage', cpuUsage);
    this.setGauge('system.memory.usage', systemMetrics.memory.usagePercent);
    this.setGauge('process.memory.heapUsed', systemMetrics.process.memory.heapUsed);
    
    return systemMetrics;
  }
  
  // Calculate CPU usage
  calculateCPUUsage(cpus) {
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    
    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const usage = 100 - ~~(100 * idle / total);
    
    return usage;
  }
  
  // Prune old metrics
  pruneMetrics(type) {
    const cutoff = Date.now() - this.options.retention;
    this.metrics[type] = this.metrics[type].filter(m => m.timestamp > cutoff);
    
    // Keep max data points
    if (this.metrics[type].length > this.options.maxDataPoints) {
      this.metrics[type] = this.metrics[type].slice(-this.options.maxDataPoints);
    }
  }
  
  // Start metric collection
  startCollection() {
    this.collectionInterval = setInterval(() => {
      this.collectSystemMetrics();
      this.emit('collect');
    }, this.options.interval);
  }
  
  // Stop metric collection
  stopCollection() {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
    }
  }
  
  // Get metric statistics
  getStats(name, tags = {}) {
    const key = this.getKey(name, tags);
    const histogram = this.histograms.get(key);
    
    if (!histogram || histogram.length === 0) {
      return null;
    }
    
    const sorted = [...histogram].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const mean = sum / sorted.length;
    
    return {
      count: sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean,
      median: sorted[Math.floor(sorted.length / 2)],
      p75: sorted[Math.floor(sorted.length * 0.75)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)]
    };
  }
  
  // Export metrics
  exportMetrics() {
    return {
      system: this.metrics.system,
      application: this.metrics.application,
      business: this.metrics.business,
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(
        Array.from(this.histograms.entries()).map(([k, v]) => [k, this.getStats(k)])
      )
    };
  }
}

/**
 * Alert Manager
 */
export class AlertManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      channels: options.channels || ['console'],
      thresholds: options.thresholds || {},
      cooldown: options.cooldown || 300000, // 5 minutes
      ...options
    };
    
    this.alerts = new Map();
    this.alertHistory = [];
  }
  
  // Check threshold
  checkThreshold(metric, value, threshold) {
    const alertKey = `${metric}:${threshold.condition}`;
    const lastAlert = this.alerts.get(alertKey);
    
    // Check cooldown
    if (lastAlert && Date.now() - lastAlert.timestamp < this.options.cooldown) {
      return;
    }
    
    let triggered = false;
    
    switch (threshold.condition) {
      case 'gt':
        triggered = value > threshold.value;
        break;
      case 'gte':
        triggered = value >= threshold.value;
        break;
      case 'lt':
        triggered = value < threshold.value;
        break;
      case 'lte':
        triggered = value <= threshold.value;
        break;
      case 'eq':
        triggered = value === threshold.value;
        break;
      case 'ne':
        triggered = value !== threshold.value;
        break;
    }
    
    if (triggered) {
      this.triggerAlert({
        metric,
        value,
        threshold,
        timestamp: Date.now()
      });
    }
  }
  
  // Trigger alert
  triggerAlert(alert) {
    const alertKey = `${alert.metric}:${alert.threshold.condition}`;
    
    // Store alert
    this.alerts.set(alertKey, alert);
    this.alertHistory.push(alert);
    
    // Emit alert event
    this.emit('alert', alert);
    
    // Send to channels
    this.sendAlert(alert);
  }
  
  // Send alert to channels
  sendAlert(alert) {
    const message = this.formatAlert(alert);
    
    this.options.channels.forEach(channel => {
      switch (channel) {
        case 'console':
          console.error(`[ALERT] ${message}`);
          break;
        case 'file':
          this.logToFile(alert);
          break;
        case 'webhook':
          this.sendWebhook(alert);
          break;
      }
    });
  }
  
  // Format alert message
  formatAlert(alert) {
    return `${alert.metric} ${alert.threshold.condition} ${alert.threshold.value} (current: ${alert.value})`;
  }
  
  // Log alert to file
  logToFile(alert) {
    const logDir = resolve(process.cwd(), 'logs');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    
    const logFile = resolve(logDir, `alerts-${new Date().toISOString().split('T')[0]}.log`);
    const logEntry = `${new Date().toISOString()} ${this.formatAlert(alert)}\n`;
    
    try {
      writeFileSync(logFile, logEntry, { flag: 'a' });
    } catch (error) {
      console.error('Failed to write alert to file:', error);
    }
  }
  
  // Send webhook (implement based on your webhook service)
  async sendWebhook(alert) {
    // Implementation depends on webhook service
    if (this.options.webhookUrl) {
      try {
        await fetch(this.options.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(alert)
        });
      } catch (error) {
        console.error('Failed to send webhook:', error);
      }
    }
  }
  
  // Clear alert
  clearAlert(metric, condition) {
    const alertKey = `${metric}:${condition}`;
    this.alerts.delete(alertKey);
  }
  
  // Get alert history
  getHistory(limit = 100) {
    return this.alertHistory.slice(-limit);
  }
}

/**
 * Business Analytics
 */
export class BusinessAnalytics {
  constructor(db) {
    this.db = db;
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 minutes
  }
  
  // Get cached or compute
  async getCachedOrCompute(key, computeFn) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }
    
    const data = await computeFn();
    this.cache.set(key, { data, timestamp: Date.now() });
    return data;
  }
  
  // Mining analytics
  async getMiningAnalytics(timeRange = 86400000) { // 24 hours
    return this.getCachedOrCompute(`mining:${timeRange}`, async () => {
      const cutoff = Date.now() - timeRange;
      
      const stats = await this.db.get(`
        SELECT 
          COUNT(DISTINCT minerId) as uniqueMiners,
          COUNT(*) as totalShares,
          SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END) as validShares,
          AVG(difficulty) as avgDifficulty,
          MAX(timestamp) as lastShare
        FROM shares 
        WHERE timestamp > ?
      `, cutoff);
      
      const minerStats = await this.db.all(`
        SELECT 
          currency,
          algorithm,
          COUNT(*) as count,
          SUM(hashrate) as totalHashrate,
          AVG(hashrate) as avgHashrate,
          SUM(balance) as totalBalance,
          SUM(btcBalance) as totalBtcBalance
        FROM miners
        WHERE lastSeen > ?
        GROUP BY currency, algorithm
      `, cutoff);
      
      return {
        overview: stats,
        byMiner: minerStats,
        validShareRate: stats.totalShares > 0 
          ? (stats.validShares / stats.totalShares) * 100 
          : 0
      };
    });
  }
  
  // Revenue analytics
  async getRevenueAnalytics(timeRange = 86400000) {
    return this.getCachedOrCompute(`revenue:${timeRange}`, async () => {
      const cutoff = Date.now() - timeRange;
      
      const revenue = await this.db.all(`
        SELECT 
          currency,
          SUM(amount) as totalAmount,
          SUM(btcAmount) as totalBtcAmount,
          SUM(fee) as totalFees,
          SUM(conversionFee) as totalConversionFees,
          COUNT(*) as transactionCount
        FROM transactions
        WHERE timestamp > ? AND status = 'completed'
        GROUP BY currency
      `, cutoff);
      
      const totalBtcRevenue = revenue.reduce((sum, r) => sum + r.totalBtcAmount, 0);
      const totalFees = revenue.reduce((sum, r) => sum + r.totalFees + r.totalConversionFees, 0);
      
      return {
        byCurrency: revenue,
        totalBtcRevenue,
        totalFees,
        netRevenue: totalBtcRevenue - totalFees,
        avgTransactionValue: revenue.length > 0
          ? totalBtcRevenue / revenue.reduce((sum, r) => sum + r.transactionCount, 0)
          : 0
      };
    });
  }
  
  // User analytics
  async getUserAnalytics(timeRange = 86400000) {
    return this.getCachedOrCompute(`users:${timeRange}`, async () => {
      const cutoff = Date.now() - timeRange;
      
      const activeUsers = await this.db.get(`
        SELECT COUNT(DISTINCT minerId) as count
        FROM shares
        WHERE timestamp > ?
      `, cutoff);
      
      const newUsers = await this.db.get(`
        SELECT COUNT(*) as count
        FROM miners
        WHERE created > ?
      `, cutoff);
      
      const retention = await this.db.all(`
        SELECT 
          DATE(created / 1000, 'unixepoch') as cohortDate,
          COUNT(*) as cohortSize,
          SUM(CASE WHEN lastSeen > ? THEN 1 ELSE 0 END) as retained
        FROM miners
        WHERE created > ?
        GROUP BY cohortDate
      `, cutoff, cutoff - 604800000); // 7 days ago
      
      return {
        activeUsers: activeUsers.count,
        newUsers: newUsers.count,
        retention: retention.map(r => ({
          date: r.cohortDate,
          size: r.cohortSize,
          retained: r.retained,
          retentionRate: r.cohortSize > 0 ? (r.retained / r.cohortSize) * 100 : 0
        }))
      };
    });
  }
  
  // Performance analytics
  async getPerformanceAnalytics() {
    return this.getCachedOrCompute('performance', async () => {
      const shares = await this.db.all(`
        SELECT 
          strftime('%H', timestamp / 1000, 'unixepoch') as hour,
          COUNT(*) as count,
          AVG(difficulty) as avgDifficulty
        FROM shares
        WHERE timestamp > ?
        GROUP BY hour
        ORDER BY hour
      `, Date.now() - 86400000);
      
      const response = await this.db.all(`
        SELECT 
          action,
          COUNT(*) as count,
          AVG(responseTime) as avgResponseTime,
          MAX(responseTime) as maxResponseTime
        FROM performance_logs
        WHERE timestamp > ?
        GROUP BY action
      `, Date.now() - 3600000);
      
      return {
        sharesByHour: shares,
        apiPerformance: response
      };
    });
  }
  
  // Get all analytics
  async getAllAnalytics(timeRange = 86400000) {
    const [mining, revenue, users, performance] = await Promise.all([
      this.getMiningAnalytics(timeRange),
      this.getRevenueAnalytics(timeRange),
      this.getUserAnalytics(timeRange),
      this.getPerformanceAnalytics()
    ]);
    
    return {
      mining,
      revenue,
      users,
      performance,
      generated: Date.now()
    };
  }
}

/**
 * Health Monitor
 */
export class HealthMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      interval: options.interval || 30000, // 30 seconds
      timeout: options.timeout || 5000,
      checks: options.checks || [],
      ...options
    };
    
    this.status = {
      healthy: true,
      lastCheck: null,
      checks: {}
    };
    
    this.startMonitoring();
  }
  
  // Add health check
  addCheck(name, checkFn) {
    this.options.checks.push({ name, check: checkFn });
  }
  
  // Run health checks
  async runChecks() {
    const results = {};
    let healthy = true;
    
    for (const { name, check } of this.options.checks) {
      try {
        const start = Date.now();
        const result = await Promise.race([
          check(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Check timeout')), this.options.timeout)
          )
        ]);
        
        results[name] = {
          status: result.status || 'healthy',
          message: result.message,
          duration: Date.now() - start,
          timestamp: Date.now()
        };
        
        if (result.status !== 'healthy') {
          healthy = false;
        }
      } catch (error) {
        results[name] = {
          status: 'unhealthy',
          message: error.message,
          timestamp: Date.now()
        };
        healthy = false;
      }
    }
    
    this.status = {
      healthy,
      lastCheck: Date.now(),
      checks: results
    };
    
    this.emit('health', this.status);
    
    return this.status;
  }
  
  // Start monitoring
  startMonitoring() {
    this.monitoringInterval = setInterval(() => {
      this.runChecks();
    }, this.options.interval);
    
    // Run initial check
    this.runChecks();
  }
  
  // Stop monitoring
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
  }
  
  // Get current status
  getStatus() {
    return this.status;
  }
}

// Export singleton instances
export const metrics = new MetricsCollector();
export const alerts = new AlertManager({
  thresholds: {
    'system.cpu.usage': { condition: 'gt', value: 80 },
    'system.memory.usage': { condition: 'gt', value: 90 },
    'process.memory.heapUsed': { condition: 'gt', value: 1024 * 1024 * 1024 } // 1GB
  }
});

// Connect metrics to alerts
metrics.on('metric', (metric) => {
  const threshold = alerts.options.thresholds[metric.name];
  if (threshold) {
    alerts.checkThreshold(metric.name, metric.value, threshold);
  }
});