import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import os from 'os';

export class AdvancedMonitoringSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableRealTimeMonitoring: options.enableRealTimeMonitoring !== false,
      enableAlerts: options.enableAlerts !== false,
      enableMetricsCollection: options.enableMetricsCollection !== false,
      enablePerformanceAnalysis: options.enablePerformanceAnalysis !== false,
      metricsRetention: options.metricsRetention || '30d',
      alertThresholds: options.alertThresholds || {},
      ...options
    };

    this.metrics = new Map();
    this.alerts = new Map();
    this.healthChecks = new Map();
    this.performanceData = [];
    
    this.systemMetrics = {
      cpu: [],
      memory: [],
      disk: [],
      network: [],
      responses: [],
      errors: []
    };

    this.initializeMonitoringSystem();
  }

  async initializeMonitoringSystem() {
    try {
      await this.setupSystemMonitoring();
      await this.setupApplicationMonitoring();
      await this.setupBusinessMetrics();
      await this.setupAlertSystem();
      await this.startPeriodicCollection();
      
      this.emit('monitoringSystemInitialized', {
        healthChecks: this.healthChecks.size,
        alerts: this.alerts.size,
        timestamp: Date.now()
      });
      
      console.log('📊 Advanced Monitoring System initialized');
    } catch (error) {
      this.emit('monitoringSystemError', { error: error.message, timestamp: Date.now() });
      throw error;
    }
  }

  async setupSystemMonitoring() {
    // CPU Monitoring
    this.healthChecks.set('cpu_usage', {
      name: 'CPU Usage',
      check: () => {
        const cpus = os.cpus();
        const usage = cpus.map(cpu => {
          const total = Object.values(cpu.times).reduce((acc, time) => acc + time, 0);
          const idle = cpu.times.idle;
          return ((total - idle) / total) * 100;
        });
        
        const avgUsage = usage.reduce((acc, val) => acc + val, 0) / usage.length;
        
        return {
          status: avgUsage < 80 ? 'healthy' : avgUsage < 95 ? 'warning' : 'critical',
          value: avgUsage,
          details: { cores: usage, average: avgUsage }
        };
      },
      threshold: { warning: 80, critical: 95 },
      interval: 30000 // 30 seconds
    });

    // Memory Monitoring
    this.healthChecks.set('memory_usage', {
      name: 'Memory Usage',
      check: () => {
        const total = os.totalmem();
        const free = os.freemem();
        const used = total - free;
        const usagePercent = (used / total) * 100;
        
        const processMemory = process.memoryUsage();
        
        return {
          status: usagePercent < 85 ? 'healthy' : usagePercent < 95 ? 'warning' : 'critical',
          value: usagePercent,
          details: {
            total: Math.round(total / 1024 / 1024 / 1024 * 100) / 100, // GB
            used: Math.round(used / 1024 / 1024 / 1024 * 100) / 100, // GB
            free: Math.round(free / 1024 / 1024 / 1024 * 100) / 100, // GB
            process: {
              rss: Math.round(processMemory.rss / 1024 / 1024 * 100) / 100, // MB
              heapUsed: Math.round(processMemory.heapUsed / 1024 / 1024 * 100) / 100, // MB
              heapTotal: Math.round(processMemory.heapTotal / 1024 / 1024 * 100) / 100 // MB
            }
          }
        };
      },
      threshold: { warning: 85, critical: 95 },
      interval: 30000
    });

    // Disk Usage Monitoring
    this.healthChecks.set('disk_usage', {
      name: 'Disk Usage',
      check: async () => {
        // Simplified disk usage check
        const stats = await this.getDiskUsage();
        
        return {
          status: stats.usagePercent < 85 ? 'healthy' : stats.usagePercent < 95 ? 'warning' : 'critical',
          value: stats.usagePercent,
          details: stats
        };
      },
      threshold: { warning: 85, critical: 95 },
      interval: 300000 // 5 minutes
    });

    // Network Monitoring
    this.healthChecks.set('network_connectivity', {
      name: 'Network Connectivity',
      check: async () => {
        const networkInterfaces = os.networkInterfaces();
        const activeInterfaces = Object.keys(networkInterfaces).filter(name => 
          networkInterfaces[name].some(iface => !iface.internal)
        );
        
        return {
          status: activeInterfaces.length > 0 ? 'healthy' : 'critical',
          value: activeInterfaces.length,
          details: { activeInterfaces, total: Object.keys(networkInterfaces).length }
        };
      },
      threshold: { warning: 1, critical: 0 },
      interval: 60000 // 1 minute
    });
  }

  async setupApplicationMonitoring() {
    // Database Connection Monitoring
    this.healthChecks.set('database_connection', {
      name: 'Database Connection',
      check: async () => {
        try {
          // Simulate database ping
          const startTime = performance.now();
          await this.pingDatabase();
          const responseTime = performance.now() - startTime;
          
          return {
            status: responseTime < 100 ? 'healthy' : responseTime < 500 ? 'warning' : 'critical',
            value: responseTime,
            details: { responseTime, unit: 'ms' }
          };
        } catch (error) {
          return {
            status: 'critical',
            value: 0,
            details: { error: error.message }
          };
        }
      },
      threshold: { warning: 100, critical: 500 },
      interval: 60000
    });

    // API Response Time Monitoring
    this.healthChecks.set('api_response_time', {
      name: 'API Response Time',
      check: () => {
        const recentResponses = this.systemMetrics.responses.slice(-100);
        if (recentResponses.length === 0) {
          return {
            status: 'unknown',
            value: 0,
            details: { message: 'No recent API responses' }
          };
        }
        
        const avgResponseTime = recentResponses.reduce((acc, val) => acc + val, 0) / recentResponses.length;
        const p95ResponseTime = recentResponses.sort((a, b) => a - b)[Math.floor(recentResponses.length * 0.95)];
        
        return {
          status: avgResponseTime < 200 ? 'healthy' : avgResponseTime < 1000 ? 'warning' : 'critical',
          value: avgResponseTime,
          details: {
            average: Math.round(avgResponseTime),
            p95: Math.round(p95ResponseTime),
            samples: recentResponses.length
          }
        };
      },
      threshold: { warning: 200, critical: 1000 },
      interval: 60000
    });

    // Error Rate Monitoring
    this.healthChecks.set('error_rate', {
      name: 'Application Error Rate',
      check: () => {
        const recentErrors = this.systemMetrics.errors.slice(-100);
        const totalRequests = this.systemMetrics.responses.length;
        
        if (totalRequests === 0) {
          return {
            status: 'unknown',
            value: 0,
            details: { message: 'No requests processed' }
          };
        }
        
        const errorRate = (recentErrors.length / totalRequests) * 100;
        
        return {
          status: errorRate < 1 ? 'healthy' : errorRate < 5 ? 'warning' : 'critical',
          value: errorRate,
          details: {
            errorCount: recentErrors.length,
            totalRequests,
            errorRate: Math.round(errorRate * 100) / 100
          }
        };
      },
      threshold: { warning: 1, critical: 5 },
      interval: 60000
    });
  }

  async setupBusinessMetrics() {
    // Trading Volume Monitoring
    this.healthChecks.set('trading_volume', {
      name: 'Trading Volume',
      check: async () => {
        const volume = await this.getTradingVolume();
        const hourlyAverage = volume.hourly;
        const dailyAverage = volume.daily;
        
        return {
          status: hourlyAverage > 100000 ? 'healthy' : hourlyAverage > 10000 ? 'warning' : 'critical',
          value: hourlyAverage,
          details: {
            hourly: hourlyAverage,
            daily: dailyAverage,
            currency: 'USD'
          }
        };
      },
      threshold: { warning: 10000, critical: 1000 },
      interval: 300000 // 5 minutes
    });

    // User Activity Monitoring
    this.healthChecks.set('active_users', {
      name: 'Active Users',
      check: async () => {
        const activeUsers = await this.getActiveUserCount();
        
        return {
          status: activeUsers > 100 ? 'healthy' : activeUsers > 10 ? 'warning' : 'critical',
          value: activeUsers,
          details: { activeUsers, timeframe: '5 minutes' }
        };
      },
      threshold: { warning: 10, critical: 1 },
      interval: 300000
    });

    // Mining Pool Performance
    this.healthChecks.set('mining_performance', {
      name: 'Mining Pool Performance',
      check: async () => {
        const stats = await this.getMiningStats();
        
        return {
          status: stats.hashrate > 1000000 ? 'healthy' : stats.hashrate > 100000 ? 'warning' : 'critical',
          value: stats.hashrate,
          details: {
            hashrate: stats.hashrate,
            activeMiners: stats.activeMiners,
            efficiency: stats.efficiency
          }
        };
      },
      threshold: { warning: 100000, critical: 10000 },
      interval: 300000
    });
  }

  async setupAlertSystem() {
    this.alertRules = {
      // System Alerts
      high_cpu_usage: {
        condition: (metrics) => metrics.cpu_usage?.value > 90,
        severity: 'warning',
        message: 'High CPU usage detected',
        cooldown: 300000 // 5 minutes
      },
      
      high_memory_usage: {
        condition: (metrics) => metrics.memory_usage?.value > 90,
        severity: 'warning',
        message: 'High memory usage detected',
        cooldown: 300000
      },
      
      disk_space_low: {
        condition: (metrics) => metrics.disk_usage?.value > 90,
        severity: 'critical',
        message: 'Disk space critically low',
        cooldown: 600000 // 10 minutes
      },
      
      // Application Alerts
      database_connection_failed: {
        condition: (metrics) => metrics.database_connection?.status === 'critical',
        severity: 'critical',
        message: 'Database connection failed',
        cooldown: 60000 // 1 minute
      },
      
      high_error_rate: {
        condition: (metrics) => metrics.error_rate?.value > 5,
        severity: 'critical',
        message: 'High application error rate',
        cooldown: 300000
      },
      
      // Business Alerts
      low_trading_volume: {
        condition: (metrics) => metrics.trading_volume?.value < 1000,
        severity: 'warning',
        message: 'Trading volume below threshold',
        cooldown: 900000 // 15 minutes
      },
      
      mining_performance_degraded: {
        condition: (metrics) => metrics.mining_performance?.value < 10000,
        severity: 'warning',
        message: 'Mining performance degraded',
        cooldown: 600000
      }
    };
  }

  async startPeriodicCollection() {
    // Collect metrics every 30 seconds
    setInterval(async () => {
      await this.collectAllMetrics();
    }, 30000);
    
    // Check alerts every minute
    setInterval(async () => {
      await this.checkAlerts();
    }, 60000);
    
    // Clean up old data every hour
    setInterval(() => {
      this.cleanupOldData();
    }, 3600000);
  }

  // Core Monitoring Functions
  async collectAllMetrics() {
    try {
      const currentMetrics = {};
      
      // Run all health checks
      for (const [key, healthCheck] of this.healthChecks) {
        try {
          const result = await healthCheck.check();
          currentMetrics[key] = result;
          
          // Store time series data
          this.storeTimeSeriesData(key, result.value);
        } catch (error) {
          currentMetrics[key] = {
            status: 'error',
            value: null,
            details: { error: error.message }
          };
        }
      }
      
      this.metrics.set('latest', currentMetrics);
      
      this.emit('metricsCollected', {
        metrics: currentMetrics,
        timestamp: Date.now()
      });
      
      return currentMetrics;
    } catch (error) {
      this.emit('metricsCollectionError', { error: error.message, timestamp: Date.now() });
      throw error;
    }
  }

  async checkAlerts() {
    try {
      const latestMetrics = this.metrics.get('latest') || {};
      const triggeredAlerts = [];
      
      for (const [alertKey, rule] of Object.entries(this.alertRules)) {
        const existingAlert = this.alerts.get(alertKey);
        
        // Check cooldown
        if (existingAlert && Date.now() - existingAlert.lastTriggered < rule.cooldown) {
          continue;
        }
        
        // Check condition
        if (rule.condition(latestMetrics)) {
          const alert = {
            key: alertKey,
            severity: rule.severity,
            message: rule.message,
            triggeredAt: Date.now(),
            lastTriggered: Date.now(),
            metrics: latestMetrics
          };
          
          this.alerts.set(alertKey, alert);
          triggeredAlerts.push(alert);
          
          this.emit('alertTriggered', alert);
          
          // Send notification based on severity
          await this.sendAlertNotification(alert);
        } else {
          // Clear alert if condition no longer met
          if (existingAlert) {
            this.alerts.delete(alertKey);
            this.emit('alertCleared', { key: alertKey, timestamp: Date.now() });
          }
        }
      }
      
      return triggeredAlerts;
    } catch (error) {
      this.emit('alertCheckError', { error: error.message, timestamp: Date.now() });
      throw error;
    }
  }

  recordApiResponse(responseTime) {
    this.systemMetrics.responses.push(responseTime);
    
    // Keep only last 1000 responses
    if (this.systemMetrics.responses.length > 1000) {
      this.systemMetrics.responses = this.systemMetrics.responses.slice(-1000);
    }
  }

  recordError(error) {
    this.systemMetrics.errors.push({
      timestamp: Date.now(),
      error: error.message,
      stack: error.stack
    });
    
    // Keep only last 1000 errors
    if (this.systemMetrics.errors.length > 1000) {
      this.systemMetrics.errors = this.systemMetrics.errors.slice(-1000);
    }
  }

  // Helper Methods
  storeTimeSeriesData(metric, value) {
    if (!this.performanceData[metric]) {
      this.performanceData[metric] = [];
    }
    
    this.performanceData[metric].push({
      timestamp: Date.now(),
      value
    });
    
    // Keep only last 24 hours of data
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    this.performanceData[metric] = this.performanceData[metric].filter(
      data => data.timestamp > oneDayAgo
    );
  }

  async sendAlertNotification(alert) {
    // In production, integrate with notification services
    console.log(`🚨 ALERT [${alert.severity.toUpperCase()}]: ${alert.message}`);
    
    // Could integrate with:
    // - Email services
    // - Slack/Discord webhooks
    // - PagerDuty
    // - SMS services
    // - Push notifications
  }

  cleanupOldData() {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    
    // Clean up performance data older than 1 week
    for (const metric in this.performanceData) {
      this.performanceData[metric] = this.performanceData[metric].filter(
        data => data.timestamp > oneWeekAgo
      );
    }
    
    // Clean up old alerts
    for (const [key, alert] of this.alerts) {
      if (Date.now() - alert.triggeredAt > oneWeekAgo) {
        this.alerts.delete(key);
      }
    }
  }

  // Simulated external service calls
  async pingDatabase() {
    // Simulate database ping with random delay
    return new Promise(resolve => {
      setTimeout(resolve, Math.random() * 50 + 10);
    });
  }

  async getDiskUsage() {
    // Simplified disk usage simulation
    return {
      total: 1000, // GB
      used: Math.floor(Math.random() * 800) + 100,
      free: 0,
      usagePercent: 0
    };
  }

  async getTradingVolume() {
    // Simulate trading volume data
    return {
      hourly: Math.floor(Math.random() * 1000000) + 50000,
      daily: Math.floor(Math.random() * 10000000) + 500000
    };
  }

  async getActiveUserCount() {
    // Simulate active user count
    return Math.floor(Math.random() * 500) + 50;
  }

  async getMiningStats() {
    // Simulate mining statistics
    return {
      hashrate: Math.floor(Math.random() * 10000000) + 100000,
      activeMiners: Math.floor(Math.random() * 1000) + 10,
      efficiency: Math.random() * 0.3 + 0.7 // 70-100%
    };
  }

  // Public API Methods
  getHealthStatus() {
    const latest = this.metrics.get('latest') || {};
    const overall = Object.values(latest).every(metric => 
      metric.status === 'healthy' || metric.status === 'unknown'
    ) ? 'healthy' : 'degraded';
    
    return {
      status: overall,
      checks: latest,
      timestamp: Date.now()
    };
  }

  getPerformanceMetrics() {
    return {
      cpu: this.performanceData.cpu_usage || [],
      memory: this.performanceData.memory_usage || [],
      responseTime: this.performanceData.api_response_time || [],
      tradingVolume: this.performanceData.trading_volume || []
    };
  }

  getActiveAlerts() {
    return Array.from(this.alerts.values());
  }

  // System monitoring
  getMonitoringMetrics() {
    return {
      totalHealthChecks: this.healthChecks.size,
      activeAlerts: this.alerts.size,
      dataPoints: Object.values(this.performanceData).reduce((acc, arr) => acc + arr.length, 0),
      systemUptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: Date.now()
    };
  }

  async shutdownMonitoringSystem() {
    this.emit('monitoringSystemShutdown', { timestamp: Date.now() });
    console.log('📊 Advanced Monitoring System shutdown complete');
  }
}

export default AdvancedMonitoringSystem;