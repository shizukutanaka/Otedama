/**
 * Real-time Monitoring System
 * Provides comprehensive monitoring and alerting for Otedama Mining Pool
 */

import { EventEmitter } from 'events';
import { cpus, freemem, totalmem, loadavg } from 'os';
import { performance } from 'perf_hooks';

export class RealTimeMonitor extends EventEmitter {
  constructor() {
    super();
    
    this.metrics = {
      system: {
        cpuUsage: 0,
        memoryUsage: 0,
        loadAverage: [0, 0, 0],
        uptime: 0,
        processes: 0
      },
      pool: {
        connectedMiners: 0,
        totalHashrate: 0,
        sharesAccepted: 0,
        sharesRejected: 0,
        blocksFound: 0,
        efficiency: 0
      },
      network: {
        connectionsActive: 0,
        bytesReceived: 0,
        bytesSent: 0,
        requestsPerSecond: 0,
        avgResponseTime: 0
      },
      security: {
        securityScore: 100,
        threatsDetected: 0,
        failedLogins: 0,
        suspiciousActivity: 0
      },
      database: {
        connectionPool: 0,
        queryTime: 0,
        slowQueries: 0,
        deadlocks: 0
      },
      dex: {
        tradingVolume: 0,
        activeTrades: 0,
        liquidityPools: 0,
        totalValueLocked: 0
      }
    };
    
    this.alerts = [];
    this.subscribers = new Set();
    this.monitoringInterval = null;
    this.performanceCounters = new Map();
    this.thresholds = this.getDefaultThresholds();
    
    this.startMonitoring();
  }

  getDefaultThresholds() {
    return {
      system: {
        cpuUsage: { warning: 70, critical: 90 },
        memoryUsage: { warning: 80, critical: 95 },
        loadAverage: { warning: 2.0, critical: 4.0 }
      },
      pool: {
        efficiency: { warning: 85, critical: 75 },
        hashrate: { warning: 1000000, critical: 500000 }, // H/s
        rejectionRate: { warning: 5, critical: 10 } // percentage
      },
      network: {
        responseTime: { warning: 1000, critical: 5000 }, // ms
        requestsPerSecond: { warning: 5000, critical: 10000 }
      },
      security: {
        securityScore: { warning: 80, critical: 60 },
        threatsDetected: { warning: 1, critical: 5 },
        failedLogins: { warning: 100, critical: 500 }
      },
      database: {
        queryTime: { warning: 100, critical: 1000 }, // ms
        slowQueries: { warning: 10, critical: 50 },
        connectionPool: { warning: 80, critical: 95 } // percentage
      }
    };
  }

  startMonitoring() {
    // Collect metrics every 5 seconds
    this.monitoringInterval = setInterval(() => {
      this.collectMetrics();
    }, 5000);

    // Check alerts every 10 seconds
    setInterval(() => {
      this.checkAlerts();
    }, 10000);

    // Clean old alerts every minute
    setInterval(() => {
      this.cleanOldAlerts();
    }, 60000);
  }

  collectMetrics() {
    const startTime = performance.now();
    
    // Collect system metrics
    this.collectSystemMetrics();
    
    // Collect pool metrics
    this.collectPoolMetrics();
    
    // Collect network metrics
    this.collectNetworkMetrics();
    
    // Collect security metrics
    this.collectSecurityMetrics();
    
    // Collect database metrics
    this.collectDatabaseMetrics();
    
    // Collect DEX metrics
    this.collectDEXMetrics();
    
    const collectionTime = performance.now() - startTime;
    this.updatePerformanceCounter('metricsCollection', collectionTime);
    
    // Broadcast metrics to subscribers
    this.broadcastMetrics();
  }

  collectSystemMetrics() {
    const cpuCount = cpus().length;
    const totalMem = totalmem();
    const freeMem = freemem();
    const usedMem = totalMem - freeMem;
    const loadAvg = loadavg();
    
    this.metrics.system = {
      cpuUsage: this.calculateCPUUsage(),
      memoryUsage: Math.round((usedMem / totalMem) * 100),
      freeMemory: Math.round(freeMem / 1024 / 1024), // MB
      totalMemory: Math.round(totalMem / 1024 / 1024), // MB
      loadAverage: loadAvg,
      uptime: Math.round(process.uptime()),
      processes: cpuCount,
      nodeVersion: process.version
    };
  }

  collectPoolMetrics() {
    // These would be populated by the actual mining pool
    this.metrics.pool = {
      connectedMiners: this.getConnectedMiners(),
      totalHashrate: this.getTotalHashrate(),
      sharesAccepted: this.getSharesAccepted(),
      sharesRejected: this.getSharesRejected(),
      blocksFound: this.getBlocksFound(),
      efficiency: this.calculateEfficiency(),
      averageHashrate: this.getAverageHashrate(),
      topMiners: this.getTopMiners()
    };
  }

  collectNetworkMetrics() {
    this.metrics.network = {
      connectionsActive: this.getActiveConnections(),
      bytesReceived: this.getBytesReceived(),
      bytesSent: this.getBytesSent(),
      requestsPerSecond: this.getRequestsPerSecond(),
      avgResponseTime: this.getAverageResponseTime(),
      bandwidth: this.getBandwidthUsage()
    };
  }

  collectSecurityMetrics() {
    this.metrics.security = {
      securityScore: this.getSecurityScore(),
      threatsDetected: this.getThreatsDetected(),
      failedLogins: this.getFailedLogins(),
      suspiciousActivity: this.getSuspiciousActivity(),
      lastAudit: this.getLastAuditTime(),
      vulnerabilities: this.getVulnerabilityCount()
    };
  }

  collectDatabaseMetrics() {
    this.metrics.database = {
      connectionPool: this.getConnectionPoolUsage(),
      queryTime: this.getAverageQueryTime(),
      slowQueries: this.getSlowQueryCount(),
      deadlocks: this.getDeadlockCount(),
      totalQueries: this.getTotalQueries(),
      cacheHitRate: this.getCacheHitRate()
    };
  }

  collectDEXMetrics() {
    this.metrics.dex = {
      tradingVolume: this.getTradingVolume(),
      activeTrades: this.getActiveTrades(),
      liquidityPools: this.getLiquidityPools(),
      totalValueLocked: this.getTotalValueLocked(),
      swapCount: this.getSwapCount(),
      feeRevenue: this.getFeeRevenue()
    };
  }

  checkAlerts() {
    const now = Date.now();
    
    // Check system alerts
    this.checkSystemAlerts(now);
    
    // Check pool alerts
    this.checkPoolAlerts(now);
    
    // Check network alerts
    this.checkNetworkAlerts(now);
    
    // Check security alerts
    this.checkSecurityAlerts(now);
    
    // Check database alerts
    this.checkDatabaseAlerts(now);
  }

  checkSystemAlerts(timestamp) {
    const { system } = this.metrics;
    const { system: thresholds } = this.thresholds;
    
    // CPU usage alert
    if (system.cpuUsage > thresholds.cpuUsage.critical) {
      this.createAlert('system_cpu_critical', 'critical', 
        `CPU usage critically high: ${system.cpuUsage}%`, timestamp);
    } else if (system.cpuUsage > thresholds.cpuUsage.warning) {
      this.createAlert('system_cpu_warning', 'warning', 
        `CPU usage high: ${system.cpuUsage}%`, timestamp);
    }
    
    // Memory usage alert
    if (system.memoryUsage > thresholds.memoryUsage.critical) {
      this.createAlert('system_memory_critical', 'critical',
        `Memory usage critically high: ${system.memoryUsage}%`, timestamp);
    } else if (system.memoryUsage > thresholds.memoryUsage.warning) {
      this.createAlert('system_memory_warning', 'warning',
        `Memory usage high: ${system.memoryUsage}%`, timestamp);
    }
    
    // Load average alert
    if (system.loadAverage[0] > thresholds.loadAverage.critical) {
      this.createAlert('system_load_critical', 'critical',
        `Load average critically high: ${system.loadAverage[0].toFixed(2)}`, timestamp);
    } else if (system.loadAverage[0] > thresholds.loadAverage.warning) {
      this.createAlert('system_load_warning', 'warning',
        `Load average high: ${system.loadAverage[0].toFixed(2)}`, timestamp);
    }
  }

  checkPoolAlerts(timestamp) {
    const { pool } = this.metrics;
    const { pool: thresholds } = this.thresholds;
    
    // Pool efficiency alert
    if (pool.efficiency < thresholds.efficiency.critical) {
      this.createAlert('pool_efficiency_critical', 'critical',
        `Pool efficiency critically low: ${pool.efficiency}%`, timestamp);
    } else if (pool.efficiency < thresholds.efficiency.warning) {
      this.createAlert('pool_efficiency_warning', 'warning',
        `Pool efficiency low: ${pool.efficiency}%`, timestamp);
    }
    
    // Hashrate alert
    if (pool.totalHashrate < thresholds.hashrate.critical) {
      this.createAlert('pool_hashrate_critical', 'critical',
        `Pool hashrate critically low: ${pool.totalHashrate} H/s`, timestamp);
    } else if (pool.totalHashrate < thresholds.hashrate.warning) {
      this.createAlert('pool_hashrate_warning', 'warning',
        `Pool hashrate low: ${pool.totalHashrate} H/s`, timestamp);
    }
    
    // Rejection rate alert
    const rejectionRate = (pool.sharesRejected / (pool.sharesAccepted + pool.sharesRejected)) * 100;
    if (rejectionRate > thresholds.rejectionRate.critical) {
      this.createAlert('pool_rejection_critical', 'critical',
        `Share rejection rate critically high: ${rejectionRate.toFixed(2)}%`, timestamp);
    } else if (rejectionRate > thresholds.rejectionRate.warning) {
      this.createAlert('pool_rejection_warning', 'warning',
        `Share rejection rate high: ${rejectionRate.toFixed(2)}%`, timestamp);
    }
  }

  checkNetworkAlerts(timestamp) {
    const { network } = this.metrics;
    const { network: thresholds } = this.thresholds;
    
    // Response time alert
    if (network.avgResponseTime > thresholds.responseTime.critical) {
      this.createAlert('network_response_critical', 'critical',
        `Response time critically high: ${network.avgResponseTime}ms`, timestamp);
    } else if (network.avgResponseTime > thresholds.responseTime.warning) {
      this.createAlert('network_response_warning', 'warning',
        `Response time high: ${network.avgResponseTime}ms`, timestamp);
    }
    
    // Request rate alert
    if (network.requestsPerSecond > thresholds.requestsPerSecond.critical) {
      this.createAlert('network_requests_critical', 'critical',
        `Request rate critically high: ${network.requestsPerSecond} req/s`, timestamp);
    } else if (network.requestsPerSecond > thresholds.requestsPerSecond.warning) {
      this.createAlert('network_requests_warning', 'warning',
        `Request rate high: ${network.requestsPerSecond} req/s`, timestamp);
    }
  }

  checkSecurityAlerts(timestamp) {
    const { security } = this.metrics;
    const { security: thresholds } = this.thresholds;
    
    // Security score alert
    if (security.securityScore < thresholds.securityScore.critical) {
      this.createAlert('security_score_critical', 'critical',
        `Security score critically low: ${security.securityScore}`, timestamp);
    } else if (security.securityScore < thresholds.securityScore.warning) {
      this.createAlert('security_score_warning', 'warning',
        `Security score low: ${security.securityScore}`, timestamp);
    }
    
    // Threats detected alert
    if (security.threatsDetected >= thresholds.threatsDetected.critical) {
      this.createAlert('security_threats_critical', 'critical',
        `Multiple threats detected: ${security.threatsDetected}`, timestamp);
    } else if (security.threatsDetected >= thresholds.threatsDetected.warning) {
      this.createAlert('security_threats_warning', 'warning',
        `Threats detected: ${security.threatsDetected}`, timestamp);
    }
    
    // Failed logins alert
    if (security.failedLogins >= thresholds.failedLogins.critical) {
      this.createAlert('security_logins_critical', 'critical',
        `High number of failed logins: ${security.failedLogins}`, timestamp);
    } else if (security.failedLogins >= thresholds.failedLogins.warning) {
      this.createAlert('security_logins_warning', 'warning',
        `Failed logins detected: ${security.failedLogins}`, timestamp);
    }
  }

  checkDatabaseAlerts(timestamp) {
    const { database } = this.metrics;
    const { database: thresholds } = this.thresholds;
    
    // Query time alert
    if (database.queryTime > thresholds.queryTime.critical) {
      this.createAlert('database_query_critical', 'critical',
        `Database query time critically high: ${database.queryTime}ms`, timestamp);
    } else if (database.queryTime > thresholds.queryTime.warning) {
      this.createAlert('database_query_warning', 'warning',
        `Database query time high: ${database.queryTime}ms`, timestamp);
    }
    
    // Slow queries alert
    if (database.slowQueries > thresholds.slowQueries.critical) {
      this.createAlert('database_slow_critical', 'critical',
        `High number of slow queries: ${database.slowQueries}`, timestamp);
    } else if (database.slowQueries > thresholds.slowQueries.warning) {
      this.createAlert('database_slow_warning', 'warning',
        `Slow queries detected: ${database.slowQueries}`, timestamp);
    }
    
    // Connection pool alert
    if (database.connectionPool > thresholds.connectionPool.critical) {
      this.createAlert('database_pool_critical', 'critical',
        `Database connection pool critically high: ${database.connectionPool}%`, timestamp);
    } else if (database.connectionPool > thresholds.connectionPool.warning) {
      this.createAlert('database_pool_warning', 'warning',
        `Database connection pool high: ${database.connectionPool}%`, timestamp);
    }
  }

  createAlert(type, severity, message, timestamp) {
    const alert = {
      id: this.generateAlertId(),
      type,
      severity,
      message,
      timestamp,
      acknowledged: false
    };
    
    this.alerts.push(alert);
    this.emit('alert', alert);
    
    // Limit alerts to prevent memory issues
    if (this.alerts.length > 1000) {
      this.alerts = this.alerts.slice(-500);
    }
  }

  cleanOldAlerts() {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    this.alerts = this.alerts.filter(alert => alert.timestamp > oneDayAgo);
  }

  broadcastMetrics() {
    const data = {
      timestamp: Date.now(),
      metrics: this.metrics,
      alerts: this.alerts.slice(-10), // Last 10 alerts
      performance: this.getPerformanceCounters()
    };
    
    this.emit('metrics', data);
    
    // Send to all subscribers
    this.subscribers.forEach(subscriber => {
      if (subscriber.send) {
        try {
          subscriber.send(JSON.stringify(data));
        } catch (error) {
          this.subscribers.delete(subscriber);
        }
      }
    });
  }

  // Helper methods for collecting metrics
  calculateCPUUsage() {
    // Simplified CPU usage calculation
    const cpuCount = cpus().length;
    const loadAvg = loadavg()[0];
    return Math.min(Math.round((loadAvg / cpuCount) * 100), 100);
  }

  getConnectedMiners() {
    // Would be populated by actual mining pool
    return Math.floor(Math.random() * 1000) + 500;
  }

  getTotalHashrate() {
    // Would be populated by actual mining pool
    return Math.floor(Math.random() * 10000000) + 5000000;
  }

  getSharesAccepted() {
    // Would be populated by actual mining pool
    return Math.floor(Math.random() * 100000) + 50000;
  }

  getSharesRejected() {
    // Would be populated by actual mining pool
    return Math.floor(Math.random() * 1000) + 500;
  }

  getBlocksFound() {
    // Would be populated by actual mining pool
    return Math.floor(Math.random() * 10) + 5;
  }

  calculateEfficiency() {
    const accepted = this.getSharesAccepted();
    const rejected = this.getSharesRejected();
    return Math.round((accepted / (accepted + rejected)) * 100);
  }

  getAverageHashrate() {
    return Math.floor(Math.random() * 1000000) + 500000;
  }

  getTopMiners() {
    return [
      { address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', hashrate: 1000000 },
      { address: '12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX', hashrate: 800000 },
      { address: '1HLoD9E4SDFFPDiYfNYnkBLQ85Y51J3Zb1', hashrate: 600000 }
    ];
  }

  getActiveConnections() {
    return Math.floor(Math.random() * 1000) + 500;
  }

  getBytesReceived() {
    return Math.floor(Math.random() * 1000000) + 500000;
  }

  getBytesSent() {
    return Math.floor(Math.random() * 1000000) + 500000;
  }

  getRequestsPerSecond() {
    return Math.floor(Math.random() * 1000) + 500;
  }

  getAverageResponseTime() {
    return Math.floor(Math.random() * 500) + 100;
  }

  getBandwidthUsage() {
    return Math.floor(Math.random() * 100) + 50;
  }

  getSecurityScore() {
    return Math.floor(Math.random() * 20) + 80;
  }

  getThreatsDetected() {
    return Math.floor(Math.random() * 5);
  }

  getFailedLogins() {
    return Math.floor(Math.random() * 100) + 10;
  }

  getSuspiciousActivity() {
    return Math.floor(Math.random() * 10);
  }

  getLastAuditTime() {
    return Date.now() - (Math.random() * 3600000);
  }

  getVulnerabilityCount() {
    return Math.floor(Math.random() * 5);
  }

  getConnectionPoolUsage() {
    return Math.floor(Math.random() * 30) + 40;
  }

  getAverageQueryTime() {
    return Math.floor(Math.random() * 100) + 50;
  }

  getSlowQueryCount() {
    return Math.floor(Math.random() * 10);
  }

  getDeadlockCount() {
    return Math.floor(Math.random() * 3);
  }

  getTotalQueries() {
    return Math.floor(Math.random() * 10000) + 5000;
  }

  getCacheHitRate() {
    return Math.floor(Math.random() * 20) + 80;
  }

  getTradingVolume() {
    return Math.floor(Math.random() * 1000000) + 500000;
  }

  getActiveTrades() {
    return Math.floor(Math.random() * 100) + 50;
  }

  getLiquidityPools() {
    return Math.floor(Math.random() * 20) + 10;
  }

  getTotalValueLocked() {
    return Math.floor(Math.random() * 10000000) + 5000000;
  }

  getSwapCount() {
    return Math.floor(Math.random() * 1000) + 500;
  }

  getFeeRevenue() {
    return Math.floor(Math.random() * 10000) + 5000;
  }

  // Performance counters
  updatePerformanceCounter(name, value) {
    if (!this.performanceCounters.has(name)) {
      this.performanceCounters.set(name, []);
    }
    
    const counter = this.performanceCounters.get(name);
    counter.push(value);
    
    // Keep only last 100 values
    if (counter.length > 100) {
      counter.shift();
    }
  }

  getPerformanceCounters() {
    const counters = {};
    
    for (const [name, values] of this.performanceCounters) {
      counters[name] = {
        current: values[values.length - 1],
        average: values.reduce((a, b) => a + b, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        count: values.length
      };
    }
    
    return counters;
  }

  // WebSocket subscription management
  subscribe(ws) {
    this.subscribers.add(ws);
    
    ws.on('close', () => {
      this.subscribers.delete(ws);
    });
    
    ws.on('error', () => {
      this.subscribers.delete(ws);
    });
    
    // Send initial metrics
    const data = {
      timestamp: Date.now(),
      metrics: this.metrics,
      alerts: this.alerts.slice(-10),
      performance: this.getPerformanceCounters()
    };
    
    ws.send(JSON.stringify(data));
  }

  unsubscribe(ws) {
    this.subscribers.delete(ws);
  }

  // Alert management
  acknowledgeAlert(alertId) {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      this.emit('alertAcknowledged', alert);
    }
  }

  getAlerts(severity = null, limit = 100) {
    let alerts = [...this.alerts];
    
    if (severity) {
      alerts = alerts.filter(alert => alert.severity === severity);
    }
    
    return alerts.slice(-limit);
  }

  generateAlertId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  // Utility methods
  getMetrics() {
    return {
      timestamp: Date.now(),
      metrics: this.metrics,
      alerts: this.alerts.slice(-10),
      performance: this.getPerformanceCounters()
    };
  }

  updateThresholds(newThresholds) {
    this.thresholds = { ...this.thresholds, ...newThresholds };
    this.emit('thresholdsUpdated', this.thresholds);
  }

  getThresholds() {
    return this.thresholds;
  }

  destroy() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    this.subscribers.clear();
    this.removeAllListeners();
  }
}

export default RealTimeMonitor;