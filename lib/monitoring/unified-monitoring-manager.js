/**
 * Unified Monitoring System for Otedama
 * Combines all monitoring functionality into a single, high-performance module
 * 
 * Design principles:
 * - Carmack: Performance-optimized metrics collection
 * - Martin: Clean interfaces and single responsibility
 * - Pike: Simple is better than complex
 */

import { EventEmitter } from 'events';
import { cpus, freemem, totalmem, loadavg } from 'os';
import { performance } from 'perf_hooks';
import { createHash } from 'crypto';

// Metric types
export const MetricType = {
  COUNTER: 'counter',
  GAUGE: 'gauge',
  HISTOGRAM: 'histogram',
  SUMMARY: 'summary'
};

// Alert severity levels
export const AlertSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical'
};

// Health status
export const HealthStatus = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  UNKNOWN: 'unknown'
};

/**
 * Unified Monitoring Manager
 */
export class UnifiedMonitoringManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration (Pike: sensible defaults)
    this.config = {
      // Collection intervals
      systemInterval: options.systemInterval || 5000,       // 5 seconds
      applicationInterval: options.applicationInterval || 10000, // 10 seconds
      cleanupInterval: options.cleanupInterval || 60000,   // 1 minute
      
      // Retention
      retentionPeriod: options.retentionPeriod || 3600000, // 1 hour
      maxDataPoints: options.maxDataPoints || 720,         // 5s intervals for 1 hour
      
      // Alerts
      alertThresholds: {
        cpu: { warning: 70, critical: 90 },
        memory: { warning: 80, critical: 95 },
        responseTime: { warning: 1000, critical: 5000 },
        errorRate: { warning: 5, critical: 10 },
        ...options.alertThresholds
      },
      
      // Performance
      enableDetailedMetrics: options.enableDetailedMetrics !== false,
      enableRealtime: options.enableRealtime !== false,
      enableAlerts: options.enableAlerts !== false,
      
      ...options
    };
    
    // Metrics storage (Carmack: efficient data structures)
    this.metrics = {
      system: {
        cpu: [],
        memory: [],
        load: [],
        process: []
      },
      application: {
        requests: [],
        responses: [],
        errors: [],
        connections: []
      },
      mining: {
        hashrate: [],
        shares: [],
        blocks: [],
        efficiency: []
      },
      dex: {
        trades: [],
        volume: [],
        liquidity: [],
        orders: []
      },
      database: {
        queries: [],
        connections: [],
        performance: []
      },
      network: {
        bandwidth: [],
        latency: [],
        peers: []
      },
      custom: new Map()
    };
    
    // Current values for quick access
    this.current = {
      system: {},
      application: {},
      mining: {},
      dex: {},
      database: {},
      network: {}
    };
    
    // Alert management
    this.alerts = {
      active: new Map(),
      history: [],
      cooldowns: new Map()
    };
    
    // Health checks
    this.health = {
      status: HealthStatus.UNKNOWN,
      components: new Map(),
      lastCheck: null
    };
    
    // Performance tracking
    this.timings = new Map();
    this.counters = new Map();
    
    // Real-time subscribers
    this.subscribers = new Set();
    
    // State
    this.running = false;
    this.intervals = new Map();
    
    // CPU tracking for usage calculation
    this.previousCPU = null;
  }

  /**
   * Start monitoring
   */
  async start() {
    if (this.running) return;
    
    this.running = true;
    
    // Start system metrics collection
    this.intervals.set('system', setInterval(() => {
      this.collectSystemMetrics();
    }, this.config.systemInterval));
    
    // Start application metrics collection
    this.intervals.set('application', setInterval(() => {
      this.collectApplicationMetrics();
    }, this.config.applicationInterval));
    
    // Start cleanup
    this.intervals.set('cleanup', setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval));
    
    // Start alert checking if enabled
    if (this.config.enableAlerts) {
      this.intervals.set('alerts', setInterval(() => {
        this.checkAlerts();
      }, 10000)); // Check every 10 seconds
    }
    
    // Initial collection
    await this.collectAllMetrics();
    
    this.emit('started');
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (!this.running) return;
    
    // Clear all intervals
    for (const [name, interval] of this.intervals) {
      clearInterval(interval);
    }
    this.intervals.clear();
    
    this.running = false;
    this.emit('stopped');
  }

  /**
   * Collect all metrics
   */
  async collectAllMetrics() {
    await Promise.all([
      this.collectSystemMetrics(),
      this.collectApplicationMetrics()
    ]);
  }

  /**
   * Collect system metrics
   */
  async collectSystemMetrics() {
    const timestamp = Date.now();
    
    // CPU usage (Carmack: efficient calculation)
    const cpuUsage = this.calculateCPUUsage();
    this.recordMetric('system', 'cpu', {
      timestamp,
      usage: cpuUsage,
      cores: cpus().length
    });
    
    // Memory usage
    const totalMem = totalmem();
    const freeMem = freemem();
    const usedMem = totalMem - freeMem;
    const memoryUsage = (usedMem / totalMem) * 100;
    
    this.recordMetric('system', 'memory', {
      timestamp,
      total: totalMem,
      used: usedMem,
      free: freeMem,
      percentage: memoryUsage
    });
    
    // Load average
    const load = loadavg();
    this.recordMetric('system', 'load', {
      timestamp,
      load1: load[0],
      load5: load[1],
      load15: load[2]
    });
    
    // Process metrics
    const memUsage = process.memoryUsage();
    this.recordMetric('system', 'process', {
      timestamp,
      pid: process.pid,
      uptime: process.uptime(),
      rss: memUsage.rss,
      heapTotal: memUsage.heapTotal,
      heapUsed: memUsage.heapUsed,
      external: memUsage.external
    });
    
    // Update current values
    this.current.system = {
      cpuUsage,
      memoryUsage,
      load: load[0],
      uptime: process.uptime()
    };
    
    // Check thresholds
    this.checkSystemThresholds();
  }

  /**
   * Collect application metrics
   */
  async collectApplicationMetrics() {
    const timestamp = Date.now();
    
    // Get metrics from counters
    const requests = this.getCounter('requests') || 0;
    const errors = this.getCounter('errors') || 0;
    const connections = this.getCounter('connections') || 0;
    
    // Calculate rates
    const requestRate = this.calculateRate('requests', requests);
    const errorRate = this.calculateRate('errors', errors);
    
    // Record metrics
    this.recordMetric('application', 'requests', {
      timestamp,
      total: requests,
      rate: requestRate
    });
    
    this.recordMetric('application', 'errors', {
      timestamp,
      total: errors,
      rate: errorRate,
      percentage: requests > 0 ? (errors / requests * 100) : 0
    });
    
    this.recordMetric('application', 'connections', {
      timestamp,
      active: connections
    });
    
    // Update current values
    this.current.application = {
      requestRate,
      errorRate,
      connections
    };
    
    // Emit real-time update
    if (this.config.enableRealtime) {
      this.broadcastMetrics();
    }
  }

  /**
   * Record metric value
   */
  recordMetric(category, type, data) {
    if (!this.metrics[category] || !this.metrics[category][type]) {
      return;
    }
    
    const metrics = this.metrics[category][type];
    metrics.push(data);
    
    // Limit size (Martin: clean data management)
    if (metrics.length > this.config.maxDataPoints) {
      metrics.shift();
    }
    
    this.emit('metric', { category, type, data });
  }

  /**
   * Calculate CPU usage
   */
  calculateCPUUsage() {
    const cpuInfo = cpus();
    let total = 0;
    let idle = 0;
    
    cpuInfo.forEach(cpu => {
      for (const type in cpu.times) {
        total += cpu.times[type];
      }
      idle += cpu.times.idle;
    });
    
    if (this.previousCPU) {
      const totalDiff = total - this.previousCPU.total;
      const idleDiff = idle - this.previousCPU.idle;
      const usage = totalDiff > 0 ? 100 - (100 * idleDiff / totalDiff) : 0;
      
      this.previousCPU = { total, idle };
      return Math.round(usage * 100) / 100;
    }
    
    this.previousCPU = { total, idle };
    return 0;
  }

  /**
   * Calculate rate of change
   */
  calculateRate(name, currentValue) {
    const key = `_rate_${name}`;
    const previous = this[key] || { value: currentValue, time: Date.now() };
    
    const timeDiff = (Date.now() - previous.time) / 1000;
    const valueDiff = currentValue - previous.value;
    const rate = timeDiff > 0 ? valueDiff / timeDiff : 0;
    
    this[key] = { value: currentValue, time: Date.now() };
    
    return Math.max(0, Math.round(rate * 100) / 100);
  }

  /**
   * Counter management (Pike: simple interface)
   */
  
  incrementCounter(name, value = 1) {
    const current = this.counters.get(name) || 0;
    this.counters.set(name, current + value);
  }
  
  getCounter(name) {
    return this.counters.get(name) || 0;
  }
  
  resetCounter(name) {
    this.counters.set(name, 0);
  }

  /**
   * Timing management
   */
  
  startTiming(name) {
    this.timings.set(name, performance.now());
  }
  
  endTiming(name) {
    const start = this.timings.get(name);
    if (!start) return null;
    
    const duration = performance.now() - start;
    this.timings.delete(name);
    
    // Record timing as custom metric
    this.recordCustomMetric(`timing_${name}`, duration);
    
    return duration;
  }

  /**
   * Custom metrics
   */
  
  recordCustomMetric(name, value, metadata = {}) {
    if (!this.metrics.custom.has(name)) {
      this.metrics.custom.set(name, []);
    }
    
    const metrics = this.metrics.custom.get(name);
    const data = {
      timestamp: Date.now(),
      value,
      ...metadata
    };
    
    metrics.push(data);
    
    // Limit size
    if (metrics.length > this.config.maxDataPoints) {
      metrics.shift();
    }
    
    this.emit('customMetric', { name, data });
  }

  /**
   * Alert management
   */
  
  createAlert(type, message, severity = AlertSeverity.WARNING, metadata = {}) {
    const id = `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Check cooldown
    const cooldownKey = `${type}_${severity}`;
    const cooldown = this.alerts.cooldowns.get(cooldownKey);
    if (cooldown && Date.now() < cooldown) {
      return null; // Skip due to cooldown
    }
    
    const alert = {
      id,
      type,
      message,
      severity,
      timestamp: Date.now(),
      metadata,
      acknowledged: false
    };
    
    this.alerts.active.set(id, alert);
    this.alerts.history.push(alert);
    
    // Set cooldown (5 minutes)
    this.alerts.cooldowns.set(cooldownKey, Date.now() + 300000);
    
    // Limit history
    if (this.alerts.history.length > 1000) {
      this.alerts.history = this.alerts.history.slice(-500);
    }
    
    this.emit('alert', alert);
    
    return id;
  }
  
  acknowledgeAlert(id) {
    const alert = this.alerts.active.get(id);
    if (alert) {
      alert.acknowledged = true;
      this.alerts.active.delete(id);
      this.emit('alertAcknowledged', alert);
    }
  }
  
  checkSystemThresholds() {
    const thresholds = this.config.alertThresholds;
    const current = this.current.system;
    
    // CPU threshold
    if (current.cpuUsage > thresholds.cpu.critical) {
      this.createAlert('cpu', `CPU usage critical: ${current.cpuUsage}%`, AlertSeverity.CRITICAL);
    } else if (current.cpuUsage > thresholds.cpu.warning) {
      this.createAlert('cpu', `CPU usage high: ${current.cpuUsage}%`, AlertSeverity.WARNING);
    }
    
    // Memory threshold
    if (current.memoryUsage > thresholds.memory.critical) {
      this.createAlert('memory', `Memory usage critical: ${current.memoryUsage.toFixed(1)}%`, AlertSeverity.CRITICAL);
    } else if (current.memoryUsage > thresholds.memory.warning) {
      this.createAlert('memory', `Memory usage high: ${current.memoryUsage.toFixed(1)}%`, AlertSeverity.WARNING);
    }
  }
  
  checkAlerts() {
    // Check all active alerts
    for (const [id, alert] of this.alerts.active) {
      // Auto-resolve alerts older than 1 hour
      if (Date.now() - alert.timestamp > 3600000) {
        this.acknowledgeAlert(id);
      }
    }
  }

  /**
   * Health check system
   */
  
  async performHealthCheck() {
    const checks = new Map();
    
    // System health
    checks.set('system', this.checkSystemHealth());
    
    // Application health
    checks.set('application', this.checkApplicationHealth());
    
    // Database health
    checks.set('database', await this.checkDatabaseHealth());
    
    // Network health
    checks.set('network', this.checkNetworkHealth());
    
    // Calculate overall health
    let unhealthyCount = 0;
    let degradedCount = 0;
    
    for (const [component, status] of checks) {
      if (status === HealthStatus.UNHEALTHY) unhealthyCount++;
      else if (status === HealthStatus.DEGRADED) degradedCount++;
    }
    
    let overall = HealthStatus.HEALTHY;
    if (unhealthyCount > 0) overall = HealthStatus.UNHEALTHY;
    else if (degradedCount > 0) overall = HealthStatus.DEGRADED;
    
    this.health = {
      status: overall,
      components: checks,
      lastCheck: Date.now()
    };
    
    this.emit('healthCheck', this.health);
    
    return this.health;
  }
  
  checkSystemHealth() {
    const current = this.current.system;
    
    if (current.cpuUsage > 90 || current.memoryUsage > 95) {
      return HealthStatus.UNHEALTHY;
    } else if (current.cpuUsage > 70 || current.memoryUsage > 80) {
      return HealthStatus.DEGRADED;
    }
    
    return HealthStatus.HEALTHY;
  }
  
  checkApplicationHealth() {
    const current = this.current.application;
    
    if (current.errorRate > 10) {
      return HealthStatus.UNHEALTHY;
    } else if (current.errorRate > 5) {
      return HealthStatus.DEGRADED;
    }
    
    return HealthStatus.HEALTHY;
  }
  
  async checkDatabaseHealth() {
    // This would check actual database health
    // For now, return healthy
    return HealthStatus.HEALTHY;
  }
  
  checkNetworkHealth() {
    // This would check network connectivity
    // For now, return healthy
    return HealthStatus.HEALTHY;
  }

  /**
   * Real-time monitoring
   */
  
  subscribe(ws, channels = []) {
    this.subscribers.add(ws);
    
    // Send initial data
    ws.send(JSON.stringify({
      type: 'initial',
      data: this.getCurrentMetrics(),
      timestamp: Date.now()
    }));
    
    // Setup cleanup
    ws.on('close', () => this.unsubscribe(ws));
    ws.on('error', () => this.unsubscribe(ws));
  }
  
  unsubscribe(ws) {
    this.subscribers.delete(ws);
  }
  
  broadcastMetrics() {
    if (this.subscribers.size === 0) return;
    
    const data = JSON.stringify({
      type: 'update',
      data: this.getCurrentMetrics(),
      timestamp: Date.now()
    });
    
    for (const ws of this.subscribers) {
      try {
        if (ws.readyState === 1) { // OPEN
          ws.send(data);
        }
      } catch (error) {
        this.unsubscribe(ws);
      }
    }
  }

  /**
   * Data retrieval methods
   */
  
  getCurrentMetrics() {
    return {
      system: this.current.system,
      application: this.current.application,
      mining: this.current.mining || {},
      dex: this.current.dex || {},
      database: this.current.database || {},
      network: this.current.network || {},
      health: this.health.status,
      alerts: this.alerts.active.size
    };
  }
  
  getMetrics(category, type, duration = 3600000) {
    const metrics = this.metrics[category]?.[type];
    if (!metrics) return [];
    
    const cutoff = Date.now() - duration;
    return metrics.filter(m => m.timestamp >= cutoff);
  }
  
  getCustomMetric(name, duration = 3600000) {
    const metrics = this.metrics.custom.get(name);
    if (!metrics) return [];
    
    const cutoff = Date.now() - duration;
    return metrics.filter(m => m.timestamp >= cutoff);
  }
  
  getActiveAlerts() {
    return Array.from(this.alerts.active.values());
  }
  
  getAlertHistory(limit = 100) {
    return this.alerts.history.slice(-limit);
  }
  
  getHealthStatus() {
    return this.health;
  }
  
  async getStats() {
    const stats = {
      uptime: process.uptime(),
      metrics: {
        system: Object.keys(this.metrics.system).reduce((acc, key) => {
          acc[key] = this.metrics.system[key].length;
          return acc;
        }, {}),
        custom: this.metrics.custom.size
      },
      alerts: {
        active: this.alerts.active.size,
        total: this.alerts.history.length
      },
      subscribers: this.subscribers.size,
      health: this.health
    };
    
    return stats;
  }

  /**
   * Export metrics for external systems
   */
  
  exportPrometheus() {
    const lines = [];
    const timestamp = Date.now();
    
    // System metrics
    const system = this.current.system;
    if (system.cpuUsage !== undefined) {
      lines.push(`# HELP otedama_cpu_usage CPU usage percentage`);
      lines.push(`# TYPE otedama_cpu_usage gauge`);
      lines.push(`otedama_cpu_usage ${system.cpuUsage} ${timestamp}`);
    }
    
    if (system.memoryUsage !== undefined) {
      lines.push(`# HELP otedama_memory_usage Memory usage percentage`);
      lines.push(`# TYPE otedama_memory_usage gauge`);
      lines.push(`otedama_memory_usage ${system.memoryUsage} ${timestamp}`);
    }
    
    // Application metrics
    const app = this.current.application;
    if (app.requestRate !== undefined) {
      lines.push(`# HELP otedama_request_rate Requests per second`);
      lines.push(`# TYPE otedama_request_rate gauge`);
      lines.push(`otedama_request_rate ${app.requestRate} ${timestamp}`);
    }
    
    if (app.errorRate !== undefined) {
      lines.push(`# HELP otedama_error_rate Errors per second`);
      lines.push(`# TYPE otedama_error_rate gauge`);
      lines.push(`otedama_error_rate ${app.errorRate} ${timestamp}`);
    }
    
    // Custom metrics
    for (const [name, metrics] of this.metrics.custom) {
      if (metrics.length > 0) {
        const latest = metrics[metrics.length - 1];
        const metricName = name.replace(/[^a-zA-Z0-9_]/g, '_');
        lines.push(`# HELP otedama_${metricName} Custom metric ${name}`);
        lines.push(`# TYPE otedama_${metricName} gauge`);
        lines.push(`otedama_${metricName} ${latest.value} ${timestamp}`);
      }
    }
    
    return lines.join('\n');
  }

  /**
   * Cleanup old data
   */
  
  cleanup() {
    const cutoff = Date.now() - this.config.retentionPeriod;
    
    // Clean metrics
    for (const category of Object.values(this.metrics)) {
      if (category instanceof Map) {
        // Custom metrics
        for (const [name, metrics] of category) {
          const filtered = metrics.filter(m => m.timestamp > cutoff);
          category.set(name, filtered);
        }
      } else {
        // Regular metrics
        for (const type in category) {
          category[type] = category[type].filter(m => m.timestamp > cutoff);
        }
      }
    }
    
    // Clean alerts
    this.alerts.history = this.alerts.history.filter(a => a.timestamp > cutoff);
    
    // Clean cooldowns
    for (const [key, time] of this.alerts.cooldowns) {
      if (Date.now() > time) {
        this.alerts.cooldowns.delete(key);
      }
    }
  }

  /**
   * Mining-specific metrics
   */
  
  updateMiningMetrics(data) {
    const timestamp = Date.now();
    
    if (data.hashrate !== undefined) {
      this.recordMetric('mining', 'hashrate', {
        timestamp,
        value: data.hashrate,
        unit: 'H/s'
      });
    }
    
    if (data.shares !== undefined) {
      this.recordMetric('mining', 'shares', {
        timestamp,
        accepted: data.shares.accepted || 0,
        rejected: data.shares.rejected || 0,
        stale: data.shares.stale || 0
      });
    }
    
    if (data.blocks !== undefined) {
      this.recordMetric('mining', 'blocks', {
        timestamp,
        found: data.blocks,
        value: data.blockValue || 0
      });
    }
    
    // Calculate efficiency
    if (data.shares) {
      const total = data.shares.accepted + data.shares.rejected + data.shares.stale;
      const efficiency = total > 0 ? (data.shares.accepted / total * 100) : 100;
      
      this.recordMetric('mining', 'efficiency', {
        timestamp,
        value: efficiency,
        unit: '%'
      });
    }
    
    // Update current values
    this.current.mining = {
      hashrate: data.hashrate || 0,
      efficiency: data.efficiency || 100,
      blocksFound: data.blocks || 0
    };
  }

  /**
   * DEX-specific metrics
   */
  
  updateDEXMetrics(data) {
    const timestamp = Date.now();
    
    if (data.trades !== undefined) {
      this.recordMetric('dex', 'trades', {
        timestamp,
        count: data.trades,
        volume: data.tradeVolume || 0
      });
    }
    
    if (data.volume !== undefined) {
      this.recordMetric('dex', 'volume', {
        timestamp,
        value: data.volume,
        currency: data.currency || 'USD'
      });
    }
    
    if (data.liquidity !== undefined) {
      this.recordMetric('dex', 'liquidity', {
        timestamp,
        total: data.liquidity,
        pools: data.liquidityPools || 0
      });
    }
    
    if (data.orders !== undefined) {
      this.recordMetric('dex', 'orders', {
        timestamp,
        active: data.orders.active || 0,
        completed: data.orders.completed || 0,
        cancelled: data.orders.cancelled || 0
      });
    }
    
    // Update current values
    this.current.dex = {
      tradingVolume: data.volume || 0,
      activeTrades: data.trades || 0,
      totalLiquidity: data.liquidity || 0
    };
  }

  /**
   * Database-specific metrics
   */
  
  updateDatabaseMetrics(data) {
    const timestamp = Date.now();
    
    if (data.queries !== undefined) {
      this.recordMetric('database', 'queries', {
        timestamp,
        total: data.queries.total || 0,
        slow: data.queries.slow || 0,
        failed: data.queries.failed || 0
      });
    }
    
    if (data.connections !== undefined) {
      this.recordMetric('database', 'connections', {
        timestamp,
        active: data.connections.active || 0,
        idle: data.connections.idle || 0,
        total: data.connections.total || 0
      });
    }
    
    if (data.performance !== undefined) {
      this.recordMetric('database', 'performance', {
        timestamp,
        avgQueryTime: data.performance.avgQueryTime || 0,
        cacheHitRate: data.performance.cacheHitRate || 0
      });
    }
    
    // Update current values
    this.current.database = {
      activeConnections: data.connections?.active || 0,
      avgQueryTime: data.performance?.avgQueryTime || 0,
      queryRate: this.calculateRate('db_queries', data.queries?.total || 0)
    };
  }

  /**
   * Network-specific metrics
   */
  
  updateNetworkMetrics(data) {
    const timestamp = Date.now();
    
    if (data.bandwidth !== undefined) {
      this.recordMetric('network', 'bandwidth', {
        timestamp,
        in: data.bandwidth.in || 0,
        out: data.bandwidth.out || 0,
        unit: 'bytes/s'
      });
    }
    
    if (data.latency !== undefined) {
      this.recordMetric('network', 'latency', {
        timestamp,
        value: data.latency,
        unit: 'ms'
      });
    }
    
    if (data.peers !== undefined) {
      this.recordMetric('network', 'peers', {
        timestamp,
        connected: data.peers.connected || 0,
        total: data.peers.total || 0,
        inbound: data.peers.inbound || 0,
        outbound: data.peers.outbound || 0
      });
    }
    
    // Update current values
    this.current.network = {
      connectedPeers: data.peers?.connected || 0,
      avgLatency: data.latency || 0,
      bandwidth: {
        in: data.bandwidth?.in || 0,
        out: data.bandwidth?.out || 0
      }
    };
  }

  /**
   * Shutdown
   */
  
  async shutdown() {
    this.stop();
    
    // Clear all data
    this.metrics = {};
    this.current = {};
    this.alerts.active.clear();
    this.alerts.history = [];
    this.subscribers.clear();
    
    this.emit('shutdown');
  }
}

// Factory function
export function createUnifiedMonitoring(options) {
  return new UnifiedMonitoringManager(options);
}

// Default export
export default UnifiedMonitoringManager;
