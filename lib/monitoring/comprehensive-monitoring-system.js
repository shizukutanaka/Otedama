import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import os from 'os';
import fs from 'fs';
import { promisify } from 'util';

export class ComprehensiveMonitoringSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableSystemMonitoring: options.enableSystemMonitoring !== false,
      enableApplicationMonitoring: options.enableApplicationMonitoring !== false,
      enableMiningMonitoring: options.enableMiningMonitoring !== false,
      enableNetworkMonitoring: options.enableNetworkMonitoring !== false,
      enableSecurityMonitoring: options.enableSecurityMonitoring !== false,
      enableAlerts: options.enableAlerts !== false,
      enableDashboard: options.enableDashboard !== false,
      alertThresholds: {
        cpuUsage: 80,
        memoryUsage: 85,
        diskUsage: 90,
        errorRate: 5,
        responseTime: 1000,
        hashrateDrop: 20, // Percentage drop
        ...options.alertThresholds
      },
      retentionPeriod: options.retentionPeriod || 7 * 24 * 60 * 60 * 1000, // 7 days
      updateInterval: options.updateInterval || 30000, // 30 seconds
      ...options
    };

    this.metrics = new Map();
    this.timeSeriesData = new Map();
    this.alerts = new Map();
    this.dashboardData = {};
    this.subscriptions = new Map();
    
    this.collectors = new Map();
    this.processors = new Map();
    this.exporters = new Map();
    
    this.initializeMonitoringSystem();
  }

  async initializeMonitoringSystem() {
    try {
      await this.setupMetricCollectors();
      await this.setupDataProcessors();
      await this.setupAlertSystem();
      await this.setupDashboard();
      await this.setupDataExporters();
      await this.startMonitoring();
      
      this.emit('monitoringSystemInitialized', {
        collectors: this.collectors.size,
        processors: this.processors.size,
        exporters: this.exporters.size,
        updateInterval: this.options.updateInterval,
        timestamp: Date.now()
      });
      
      console.log('📊 Comprehensive Monitoring System initialized');
    } catch (error) {
      this.emit('monitoringSystemError', { error: error.message, timestamp: Date.now() });
      throw error;
    }
  }

  async setupMetricCollectors() {
    // System Metrics Collector
    if (this.options.enableSystemMonitoring) {
      this.collectors.set('system', {
        name: 'System Metrics',
        collect: () => this.collectSystemMetrics(),
        interval: 30000,
        enabled: true
      });
    }

    // Application Metrics Collector
    if (this.options.enableApplicationMonitoring) {
      this.collectors.set('application', {
        name: 'Application Metrics',
        collect: () => this.collectApplicationMetrics(),
        interval: 10000,
        enabled: true
      });
    }

    // Mining Metrics Collector
    if (this.options.enableMiningMonitoring) {
      this.collectors.set('mining', {
        name: 'Mining Metrics',
        collect: () => this.collectMiningMetrics(),
        interval: 15000,
        enabled: true
      });
    }

    // Network Metrics Collector
    if (this.options.enableNetworkMonitoring) {
      this.collectors.set('network', {
        name: 'Network Metrics',
        collect: () => this.collectNetworkMetrics(),
        interval: 30000,
        enabled: true
      });
    }

    // Security Metrics Collector
    if (this.options.enableSecurityMonitoring) {
      this.collectors.set('security', {
        name: 'Security Metrics',
        collect: () => this.collectSecurityMetrics(),
        interval: 60000,
        enabled: true
      });
    }

    console.log(`📈 Initialized ${this.collectors.size} metric collectors`);
  }

  async collectSystemMetrics() {
    const cpus = os.cpus();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    
    // CPU Usage calculation (simplified)
    const cpuUsage = await this.getCPUUsage();
    
    // Disk usage (simplified)
    const diskUsage = await this.getDiskUsage();
    
    // Load average
    const loadAvg = os.loadavg();
    
    const systemMetrics = {
      timestamp: Date.now(),
      cpu: {
        usage: cpuUsage,
        cores: cpus.length,
        model: cpus[0].model,
        speed: cpus[0].speed
      },
      memory: {
        total: totalMemory,
        used: usedMemory,
        free: freeMemory,
        usage: (usedMemory / totalMemory) * 100
      },
      disk: diskUsage,
      load: {
        oneMinute: loadAvg[0],
        fiveMinute: loadAvg[1],
        fifteenMinute: loadAvg[2]
      },
      uptime: os.uptime(),
      platform: os.platform(),
      arch: os.arch()
    };

    this.storeMetric('system', systemMetrics);
    
    // Check system alerts
    this.checkSystemAlerts(systemMetrics);
    
    return systemMetrics;
  }

  async collectApplicationMetrics() {
    const processMemory = process.memoryUsage();
    const processCPU = process.cpuUsage();
    
    const applicationMetrics = {
      timestamp: Date.now(),
      process: {
        pid: process.pid,
        memory: {
          rss: processMemory.rss,
          heapTotal: processMemory.heapTotal,
          heapUsed: processMemory.heapUsed,
          external: processMemory.external,
          arrayBuffers: processMemory.arrayBuffers
        },
        cpu: {
          user: processCPU.user,
          system: processCPU.system
        },
        uptime: process.uptime()
      },
      eventLoop: {
        delay: await this.measureEventLoopDelay(),
        utilization: process.uvCounters ? process.uvCounters() : null
      },
      gc: this.getGCStats(),
      handles: process._getActiveHandles ? process._getActiveHandles().length : 0,
      requests: process._getActiveRequests ? process._getActiveRequests().length : 0
    };

    this.storeMetric('application', applicationMetrics);
    
    return applicationMetrics;
  }

  async collectMiningMetrics() {
    // This would integrate with the mining pool and mining software
    const miningMetrics = {
      timestamp: Date.now(),
      pool: {
        totalHashrate: 0, // Get from mining pool
        connectedMiners: 0, // Get from mining pool
        validShares: 0,
        invalidShares: 0,
        blocksFound: 0,
        difficulty: 0,
        networkHashrate: 0
      },
      miners: [], // Individual miner statistics
      algorithms: {}, // Per-algorithm statistics
      payouts: {
        pending: 0,
        paid: 0,
        total: 0
      }
    };

    // Simulate mining data for now
    miningMetrics.pool = {
      totalHashrate: Math.random() * 1000000000, // Random hashrate
      connectedMiners: Math.floor(Math.random() * 1000),
      validShares: Math.floor(Math.random() * 10000),
      invalidShares: Math.floor(Math.random() * 100),
      blocksFound: Math.floor(Math.random() * 10),
      difficulty: Math.random() * 1000000,
      networkHashrate: Math.random() * 10000000000
    };

    this.storeMetric('mining', miningMetrics);
    
    // Check mining alerts
    this.checkMiningAlerts(miningMetrics);
    
    return miningMetrics;
  }

  async collectNetworkMetrics() {
    const networkInterfaces = os.networkInterfaces();
    
    const networkMetrics = {
      timestamp: Date.now(),
      interfaces: {},
      connections: {
        active: 0, // Get from connection manager
        total: 0,
        errors: 0
      },
      bandwidth: {
        received: 0, // Bytes received
        transmitted: 0, // Bytes transmitted
        receivedPerSec: 0,
        transmittedPerSec: 0
      },
      latency: {
        average: 0,
        min: 0,
        max: 0,
        p95: 0,
        p99: 0
      }
    };

    // Process network interfaces
    for (const [name, addresses] of Object.entries(networkInterfaces)) {
      networkMetrics.interfaces[name] = addresses.map(addr => ({
        address: addr.address,
        netmask: addr.netmask,
        family: addr.family,
        mac: addr.mac,
        internal: addr.internal
      }));
    }

    this.storeMetric('network', networkMetrics);
    
    return networkMetrics;
  }

  async collectSecurityMetrics() {
    const securityMetrics = {
      timestamp: Date.now(),
      threats: {
        detected: 0, // Get from security manager
        blocked: 0,
        suspicious: 0
      },
      connections: {
        blocked: 0, // Blocked IPs
        suspicious: 0, // Suspicious IPs
        total: 0
      },
      authentication: {
        successful: 0,
        failed: 0,
        rate: 0
      },
      encryption: {
        enabled: true,
        algorithm: 'aes-256-gcm',
        messagesEncrypted: 0
      }
    };

    this.storeMetric('security', securityMetrics);
    
    return securityMetrics;
  }

  async setupDataProcessors() {
    // Aggregation Processor
    this.processors.set('aggregator', {
      name: 'Data Aggregator',
      process: (metrics) => this.aggregateMetrics(metrics),
      enabled: true
    });

    // Trend Analysis Processor
    this.processors.set('trend_analyzer', {
      name: 'Trend Analyzer',
      process: (metrics) => this.analyzeTrends(metrics),
      enabled: true
    });

    // Anomaly Detection Processor
    this.processors.set('anomaly_detector', {
      name: 'Anomaly Detector',
      process: (metrics) => this.detectAnomalies(metrics),
      enabled: true
    });

    // Performance Calculator
    this.processors.set('performance_calculator', {
      name: 'Performance Calculator',
      process: (metrics) => this.calculatePerformanceMetrics(metrics),
      enabled: true
    });
  }

  async setupAlertSystem() {
    if (!this.options.enableAlerts) return;

    this.alertSystem = {
      rules: new Map([
        ['high_cpu_usage', {
          condition: (metrics) => metrics.system?.cpu.usage > this.options.alertThresholds.cpuUsage,
          severity: 'warning',
          message: (metrics) => `High CPU usage: ${metrics.system.cpu.usage.toFixed(1)}%`,
          cooldown: 300000 // 5 minutes
        }],
        ['high_memory_usage', {
          condition: (metrics) => metrics.system?.memory.usage > this.options.alertThresholds.memoryUsage,
          severity: 'warning',
          message: (metrics) => `High memory usage: ${metrics.system.memory.usage.toFixed(1)}%`,
          cooldown: 300000
        }],
        ['high_disk_usage', {
          condition: (metrics) => metrics.system?.disk?.usage > this.options.alertThresholds.diskUsage,
          severity: 'critical',
          message: (metrics) => `High disk usage: ${metrics.system.disk.usage.toFixed(1)}%`,
          cooldown: 600000 // 10 minutes
        }],
        ['hashrate_drop', {
          condition: (metrics) => this.checkHashrateDrop(metrics),
          severity: 'critical',
          message: () => `Significant hashrate drop detected`,
          cooldown: 300000
        }],
        ['mining_pool_down', {
          condition: (metrics) => metrics.mining?.pool.connectedMiners === 0,
          severity: 'critical',
          message: () => `No miners connected to pool`,
          cooldown: 60000 // 1 minute
        }]
      ]),
      
      activeAlerts: new Map(),
      
      check: (metrics) => {
        for (const [alertId, rule] of this.alertSystem.rules.entries()) {
          if (rule.condition(metrics)) {
            this.triggerAlert(alertId, rule, metrics);
          }
        }
      },
      
      resolve: (alertId) => {
        if (this.alertSystem.activeAlerts.has(alertId)) {
          const alert = this.alertSystem.activeAlerts.get(alertId);
          alert.resolved = true;
          alert.resolvedAt = Date.now();
          alert.duration = alert.resolvedAt - alert.triggeredAt;
          
          this.emit('alertResolved', alert);
        }
      }
    };

    console.log('🚨 Alert system initialized');
  }

  triggerAlert(alertId, rule, metrics) {
    const existingAlert = this.alertSystem.activeAlerts.get(alertId);
    const now = Date.now();
    
    // Check cooldown
    if (existingAlert && !existingAlert.resolved && 
        (now - existingAlert.lastTriggered < rule.cooldown)) {
      return;
    }
    
    const alert = {
      id: alertId,
      severity: rule.severity,
      message: rule.message(metrics),
      triggeredAt: now,
      lastTriggered: now,
      resolved: false,
      metrics: metrics,
      count: existingAlert ? existingAlert.count + 1 : 1
    };
    
    this.alertSystem.activeAlerts.set(alertId, alert);
    
    this.emit('alertTriggered', alert);
    
    // Send notifications based on severity
    this.sendAlertNotification(alert);
  }

  async sendAlertNotification(alert) {
    // In production, integrate with notification services
    console.log(`🚨 ALERT [${alert.severity.toUpperCase()}]: ${alert.message}`);
    
    // Could integrate with:
    // - Email services
    // - Slack/Discord webhooks
    // - SMS services
    // - PagerDuty
    // - Push notifications
  }

  async setupDashboard() {
    if (!this.options.enableDashboard) return;

    this.dashboard = {
      widgets: new Map([
        ['system_overview', {
          type: 'overview',
          data: () => this.getDashboardSystemOverview(),
          refreshInterval: 30000
        }],
        ['mining_stats', {
          type: 'chart',
          data: () => this.getDashboardMiningStats(),
          refreshInterval: 15000
        }],
        ['performance_charts', {
          type: 'charts',
          data: () => this.getDashboardPerformanceCharts(),
          refreshInterval: 30000
        }],
        ['alerts_panel', {
          type: 'alerts',
          data: () => this.getDashboardAlerts(),
          refreshInterval: 10000
        }],
        ['network_topology', {
          type: 'network',
          data: () => this.getDashboardNetworkTopology(),
          refreshInterval: 60000
        }]
      ]),
      
      update: () => {
        const dashboardData = {};
        
        for (const [widgetId, widget] of this.dashboard.widgets.entries()) {
          try {
            dashboardData[widgetId] = widget.data();
          } catch (error) {
            console.error(`Dashboard widget error [${widgetId}]:`, error);
            dashboardData[widgetId] = { error: error.message };
          }
        }
        
        this.dashboardData = dashboardData;
        this.emit('dashboardUpdated', dashboardData);
        
        return dashboardData;
      }
    };

    console.log('📊 Dashboard system initialized');
  }

  async setupDataExporters() {
    // Prometheus Exporter
    this.exporters.set('prometheus', {
      name: 'Prometheus Exporter',
      export: () => this.exportPrometheusMetrics(),
      enabled: true,
      endpoint: '/metrics'
    });

    // JSON Exporter
    this.exporters.set('json', {
      name: 'JSON Exporter',
      export: () => this.exportJSONMetrics(),
      enabled: true,
      endpoint: '/api/metrics'
    });

    // CSV Exporter
    this.exporters.set('csv', {
      name: 'CSV Exporter',
      export: () => this.exportCSVMetrics(),
      enabled: true,
      endpoint: '/api/metrics/csv'
    });

    console.log('📤 Data exporters initialized');
  }

  async startMonitoring() {
    // Start metric collection
    for (const [collectorId, collector] of this.collectors.entries()) {
      if (collector.enabled) {
        this.startCollector(collectorId, collector);
      }
    }

    // Start dashboard updates
    if (this.options.enableDashboard) {
      setInterval(() => {
        this.dashboard.update();
      }, this.options.updateInterval);
    }

    // Start data cleanup
    setInterval(() => {
      this.cleanupOldData();
    }, 3600000); // Every hour

    console.log('🔄 Monitoring started');
  }

  startCollector(collectorId, collector) {
    const collectAndProcess = async () => {
      try {
        const metrics = await collector.collect();
        
        // Process metrics through processors
        for (const processor of this.processors.values()) {
          if (processor.enabled) {
            await processor.process(metrics);
          }
        }
        
        // Check alerts
        if (this.options.enableAlerts) {
          this.alertSystem.check({ [collectorId]: metrics });
        }
        
      } catch (error) {
        console.error(`Collector error [${collectorId}]:`, error);
        this.emit('collectorError', { collectorId, error: error.message, timestamp: Date.now() });
      }
    };

    // Initial collection
    collectAndProcess();
    
    // Schedule regular collection
    setInterval(collectAndProcess, collector.interval);
  }

  storeMetric(category, metric) {
    const timestamp = metric.timestamp;
    
    if (!this.timeSeriesData.has(category)) {
      this.timeSeriesData.set(category, []);
    }
    
    const categoryData = this.timeSeriesData.get(category);
    categoryData.push(metric);
    
    // Keep only data within retention period
    const retentionCutoff = timestamp - this.options.retentionPeriod;
    const filteredData = categoryData.filter(m => m.timestamp > retentionCutoff);
    
    this.timeSeriesData.set(category, filteredData);
    
    // Update current metrics
    this.metrics.set(category, metric);
  }

  // Utility Methods
  async getCPUUsage() {
    // Simplified CPU usage calculation
    const start = process.cpuUsage();
    await new Promise(resolve => setTimeout(resolve, 100));
    const end = process.cpuUsage(start);
    
    const total = (end.user + end.system) / 1000; // Convert to milliseconds
    return (total / 100) * 100; // Convert to percentage (simplified)
  }

  async getDiskUsage() {
    try {
      // Simplified disk usage - in production, use proper disk usage libraries
      const stats = await promisify(fs.stat)('.');
      return {
        total: 1000 * 1024 * 1024 * 1024, // 1TB (mock)
        used: 500 * 1024 * 1024 * 1024,   // 500GB (mock)
        free: 500 * 1024 * 1024 * 1024,   // 500GB (mock)
        usage: 50 // 50% (mock)
      };
    } catch (error) {
      return {
        total: 0,
        used: 0,
        free: 0,
        usage: 0
      };
    }
  }

  async measureEventLoopDelay() {
    return new Promise((resolve) => {
      const start = performance.now();
      setImmediate(() => {
        resolve(performance.now() - start);
      });
    });
  }

  getGCStats() {
    // Simplified GC stats
    if (process.memoryUsage.rss) {
      return {
        collections: 0, // Would need v8 module for real stats
        pauseTime: 0,
        freedMemory: 0
      };
    }
    return null;
  }

  checkHashrateDrop(metrics) {
    const mining = metrics.mining;
    if (!mining || !mining.pool) return false;
    
    const current = this.metrics.get('mining');
    if (!current || !current.pool) return false;
    
    const currentHashrate = current.pool.totalHashrate;
    const newHashrate = mining.pool.totalHashrate;
    
    if (currentHashrate > 0) {
      const dropPercentage = ((currentHashrate - newHashrate) / currentHashrate) * 100;
      return dropPercentage > this.options.alertThresholds.hashrateDrop;
    }
    
    return false;
  }

  checkSystemAlerts(systemMetrics) {
    const alerts = [];
    
    // CPU Usage Alert
    if (systemMetrics.cpu.usage > this.options.alertThresholds.cpuUsage) {
      alerts.push({
        type: 'cpu_high',
        severity: 'warning',
        message: `High CPU usage: ${systemMetrics.cpu.usage.toFixed(1)}%`,
        value: systemMetrics.cpu.usage
      });
    }
    
    // Memory Usage Alert
    if (systemMetrics.memory.usage > this.options.alertThresholds.memoryUsage) {
      alerts.push({
        type: 'memory_high',
        severity: 'warning',
        message: `High memory usage: ${systemMetrics.memory.usage.toFixed(1)}%`,
        value: systemMetrics.memory.usage
      });
    }
    
    // Disk Usage Alert
    if (systemMetrics.disk.usage > this.options.alertThresholds.diskUsage) {
      alerts.push({
        type: 'disk_high',
        severity: 'critical',
        message: `High disk usage: ${systemMetrics.disk.usage.toFixed(1)}%`,
        value: systemMetrics.disk.usage
      });
    }
    
    return alerts;
  }

  checkMiningAlerts(miningMetrics) {
    const alerts = [];
    
    // No miners connected
    if (miningMetrics.pool.connectedMiners === 0) {
      alerts.push({
        type: 'no_miners',
        severity: 'critical',
        message: 'No miners connected to pool',
        value: 0
      });
    }
    
    // High invalid share rate
    const totalShares = miningMetrics.pool.validShares + miningMetrics.pool.invalidShares;
    if (totalShares > 0) {
      const invalidRate = (miningMetrics.pool.invalidShares / totalShares) * 100;
      if (invalidRate > 10) { // 10% invalid shares
        alerts.push({
          type: 'high_invalid_shares',
          severity: 'warning',
          message: `High invalid share rate: ${invalidRate.toFixed(1)}%`,
          value: invalidRate
        });
      }
    }
    
    return alerts;
  }

  // Data Processing Methods
  aggregateMetrics(metrics) {
    // Implement metric aggregation logic
    return metrics;
  }

  analyzeTrends(metrics) {
    // Implement trend analysis logic
    return {
      trends: [],
      predictions: []
    };
  }

  detectAnomalies(metrics) {
    // Implement anomaly detection logic
    return {
      anomalies: [],
      score: 0
    };
  }

  calculatePerformanceMetrics(metrics) {
    // Implement performance calculation logic
    return {
      efficiency: 0,
      throughput: 0,
      reliability: 0
    };
  }

  // Dashboard Data Methods
  getDashboardSystemOverview() {
    const systemMetric = this.metrics.get('system');
    const appMetric = this.metrics.get('application');
    
    return {
      system: systemMetric ? {
        cpu: systemMetric.cpu.usage,
        memory: systemMetric.memory.usage,
        disk: systemMetric.disk?.usage || 0,
        uptime: systemMetric.uptime
      } : null,
      application: appMetric ? {
        memory: (appMetric.process.memory.heapUsed / 1024 / 1024).toFixed(1) + ' MB',
        uptime: appMetric.process.uptime,
        handles: appMetric.handles,
        requests: appMetric.requests
      } : null,
      timestamp: Date.now()
    };
  }

  getDashboardMiningStats() {
    const miningMetric = this.metrics.get('mining');
    
    if (!miningMetric) return { error: 'No mining data' };
    
    return {
      hashrate: miningMetric.pool.totalHashrate,
      miners: miningMetric.pool.connectedMiners,
      shares: {
        valid: miningMetric.pool.validShares,
        invalid: miningMetric.pool.invalidShares
      },
      blocks: miningMetric.pool.blocksFound,
      difficulty: miningMetric.pool.difficulty,
      timestamp: miningMetric.timestamp
    };
  }

  getDashboardPerformanceCharts() {
    const categories = ['system', 'application', 'mining', 'network'];
    const charts = {};
    
    for (const category of categories) {
      const data = this.timeSeriesData.get(category);
      if (data && data.length > 0) {
        // Get last 24 hours of data
        const last24h = data.filter(m => Date.now() - m.timestamp < 24 * 60 * 60 * 1000);
        charts[category] = this.processChartData(category, last24h);
      }
    }
    
    return charts;
  }

  getDashboardAlerts() {
    return {
      active: Array.from(this.alertSystem?.activeAlerts.values() || [])
        .filter(alert => !alert.resolved),
      resolved: Array.from(this.alertSystem?.activeAlerts.values() || [])
        .filter(alert => alert.resolved)
        .slice(-10), // Last 10 resolved alerts
      timestamp: Date.now()
    };
  }

  getDashboardNetworkTopology() {
    const networkMetric = this.metrics.get('network');
    
    return {
      interfaces: networkMetric?.interfaces || {},
      connections: networkMetric?.connections || {},
      bandwidth: networkMetric?.bandwidth || {},
      timestamp: networkMetric?.timestamp || Date.now()
    };
  }

  processChartData(category, data) {
    // Process time series data for charts
    return {
      labels: data.map(d => new Date(d.timestamp).toISOString()),
      datasets: this.extractDatasets(category, data)
    };
  }

  extractDatasets(category, data) {
    // Extract relevant datasets based on category
    switch (category) {
      case 'system':
        return [
          {
            label: 'CPU Usage %',
            data: data.map(d => d.cpu?.usage || 0)
          },
          {
            label: 'Memory Usage %',
            data: data.map(d => d.memory?.usage || 0)
          }
        ];
      case 'mining':
        return [
          {
            label: 'Hashrate',
            data: data.map(d => d.pool?.totalHashrate || 0)
          },
          {
            label: 'Connected Miners',
            data: data.map(d => d.pool?.connectedMiners || 0)
          }
        ];
      default:
        return [];
    }
  }

  // Export Methods
  exportPrometheusMetrics() {
    let output = '';
    
    for (const [category, metric] of this.metrics.entries()) {
      output += this.formatPrometheusMetric(category, metric);
    }
    
    return output;
  }

  exportJSONMetrics() {
    const exportData = {
      timestamp: Date.now(),
      metrics: Object.fromEntries(this.metrics),
      alerts: Array.from(this.alertSystem?.activeAlerts.values() || [])
    };
    
    return JSON.stringify(exportData, null, 2);
  }

  exportCSVMetrics() {
    // Implement CSV export logic
    const headers = ['timestamp', 'category', 'metric', 'value'];
    let csv = headers.join(',') + '\n';
    
    for (const [category, metric] of this.metrics.entries()) {
      csv += this.formatCSVMetric(category, metric);
    }
    
    return csv;
  }

  formatPrometheusMetric(category, metric) {
    // Format metric for Prometheus
    let output = '';
    
    if (category === 'system' && metric.cpu) {
      output += `otedama_system_cpu_usage ${metric.cpu.usage}\n`;
      output += `otedama_system_memory_usage ${metric.memory.usage}\n`;
    }
    
    if (category === 'mining' && metric.pool) {
      output += `otedama_mining_hashrate ${metric.pool.totalHashrate}\n`;
      output += `otedama_mining_miners ${metric.pool.connectedMiners}\n`;
      output += `otedama_mining_valid_shares ${metric.pool.validShares}\n`;
      output += `otedama_mining_invalid_shares ${metric.pool.invalidShares}\n`;
    }
    
    return output;
  }

  formatCSVMetric(category, metric) {
    // Format metric for CSV
    let csv = '';
    
    if (category === 'system') {
      csv += `${metric.timestamp},${category},cpu_usage,${metric.cpu?.usage || 0}\n`;
      csv += `${metric.timestamp},${category},memory_usage,${metric.memory?.usage || 0}\n`;
    }
    
    return csv;
  }

  cleanupOldData() {
    const cutoff = Date.now() - this.options.retentionPeriod;
    
    for (const [category, data] of this.timeSeriesData.entries()) {
      const filtered = data.filter(metric => metric.timestamp > cutoff);
      this.timeSeriesData.set(category, filtered);
    }
    
    console.log('🗑️ Cleaned up old monitoring data');
  }

  // Public API
  getMetrics(category) {
    if (category) {
      return this.metrics.get(category);
    }
    return Object.fromEntries(this.metrics);
  }

  getTimeSeriesData(category, timeRange) {
    const data = this.timeSeriesData.get(category) || [];
    
    if (timeRange) {
      const start = Date.now() - timeRange;
      return data.filter(metric => metric.timestamp > start);
    }
    
    return data;
  }

  getDashboardData() {
    return this.dashboardData;
  }

  getActiveAlerts() {
    return Array.from(this.alertSystem?.activeAlerts.values() || [])
      .filter(alert => !alert.resolved);
  }

  subscribeToMetrics(category, callback) {
    if (!this.subscriptions.has(category)) {
      this.subscriptions.set(category, new Set());
    }
    
    this.subscriptions.get(category).add(callback);
    
    return () => {
      this.subscriptions.get(category)?.delete(callback);
    };
  }

  getMonitoringStats() {
    return {
      collectors: this.collectors.size,
      processors: this.processors.size,
      exporters: this.exporters.size,
      metrics: this.metrics.size,
      timeSeriesDataPoints: Array.from(this.timeSeriesData.values())
        .reduce((sum, data) => sum + data.length, 0),
      activeAlerts: Array.from(this.alertSystem?.activeAlerts.values() || [])
        .filter(alert => !alert.resolved).length,
      uptime: process.uptime(),
      timestamp: Date.now()
    };
  }

  async shutdown() {
    this.emit('monitoringSystemShutdown', { timestamp: Date.now() });
    console.log('📊 Comprehensive Monitoring System shutdown complete');
  }
}

export default ComprehensiveMonitoringSystem;