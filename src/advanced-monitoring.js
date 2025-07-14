import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import * as os from 'os';

/**
 * Advanced Monitoring System
 * システム全体の健全性監視とアラート管理
 * 
 * Features:
 * - Real-time metrics collection
 * - Intelligent alert thresholds
 * - Automated incident response
 * - Performance anomaly detection
 * - Predictive maintenance
 */
export class AdvancedMonitoringSystem extends EventEmitter {
  constructor(config = {}) {
    super();
    this.logger = new Logger('Monitoring');
    this.config = {
      metricsInterval: 10000, // 10 seconds
      alertCooldown: 300000, // 5 minutes
      historyRetention: 86400000, // 24 hours
      anomalyDetection: true,
      predictiveAnalysis: true,
      ...config
    };
    
    // Metrics storage
    this.metrics = new Map();
    this.metricHistory = new Map();
    this.alerts = new Map();
    this.incidents = [];
    
    // Alert definitions
    this.alertDefinitions = [
      {
        id: 'high_cpu',
        name: 'High CPU Usage',
        metric: 'system.cpu.usage',
        condition: 'above',
        threshold: 90,
        duration: 60000, // 1 minute
        severity: 'warning',
        autoResolve: true
      },
      {
        id: 'high_memory',
        name: 'High Memory Usage',
        metric: 'system.memory.usage',
        condition: 'above',
        threshold: 85,
        duration: 120000, // 2 minutes
        severity: 'warning',
        autoResolve: true
      },
      {
        id: 'low_disk',
        name: 'Low Disk Space',
        metric: 'system.disk.available',
        condition: 'below',
        threshold: 10, // 10%
        duration: 0,
        severity: 'critical',
        autoResolve: false
      },
      {
        id: 'hashrate_drop',
        name: 'Hashrate Drop',
        metric: 'pool.hashrate',
        condition: 'drop',
        threshold: 30, // 30% drop
        duration: 300000, // 5 minutes
        severity: 'warning',
        autoResolve: true
      },
      {
        id: 'miner_disconnect',
        name: 'Mass Miner Disconnect',
        metric: 'pool.miners',
        condition: 'drop',
        threshold: 20, // 20% drop
        duration: 60000,
        severity: 'critical',
        autoResolve: false
      },
      {
        id: 'fee_collection_failure',
        name: 'Fee Collection Failure',
        metric: 'fees.collection.failures',
        condition: 'above',
        threshold: 3,
        duration: 0,
        severity: 'critical',
        autoResolve: false
      },
      {
        id: 'payment_queue_backup',
        name: 'Payment Queue Backup',
        metric: 'payments.queue.length',
        condition: 'above',
        threshold: 100,
        duration: 600000, // 10 minutes
        severity: 'warning',
        autoResolve: true
      },
      {
        id: 'dex_liquidity_low',
        name: 'Low DEX Liquidity',
        metric: 'dex.tvl',
        condition: 'below',
        threshold: 10000, // $10k
        duration: 1800000, // 30 minutes
        severity: 'info',
        autoResolve: true
      },
      {
        id: 'network_latency',
        name: 'High Network Latency',
        metric: 'network.latency.avg',
        condition: 'above',
        threshold: 1000, // 1 second
        duration: 300000,
        severity: 'warning',
        autoResolve: true
      },
      {
        id: 'database_slow',
        name: 'Database Performance',
        metric: 'database.query.time',
        condition: 'above',
        threshold: 100, // 100ms
        duration: 300000,
        severity: 'warning',
        autoResolve: true
      }
    ];
    
    // Performance baselines
    this.baselines = new Map();
    this.anomalies = new Map();
    
    // Initialize monitoring
    this.initialize();
  }

  /**
   * Initialize monitoring system
   */
  initialize() {
    this.logger.info('Initializing advanced monitoring system...');
    
    // Initialize metric categories
    const categories = [
      'system', 'pool', 'network', 'database', 
      'fees', 'payments', 'dex', 'defi', 'security'
    ];
    
    for (const category of categories) {
      this.metrics.set(category, {});
      this.metricHistory.set(category, []);
    }
    
    // Start metric collection
    this.startMetricCollection();
    
    // Start alert evaluation
    this.startAlertEvaluation();
    
    // Start anomaly detection
    if (this.config.anomalyDetection) {
      this.startAnomalyDetection();
    }
    
    // Start predictive analysis
    if (this.config.predictiveAnalysis) {
      this.startPredictiveAnalysis();
    }
    
    this.logger.info('Monitoring system initialized');
  }

  /**
   * Start metric collection
   */
  startMetricCollection() {
    this.metricTimer = setInterval(() => {
      this.collectSystemMetrics();
      this.collectApplicationMetrics();
    }, this.config.metricsInterval);
  }

  /**
   * Collect system metrics
   */
  collectSystemMetrics() {
    const cpus = os.cpus();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const loadAvg = os.loadavg();
    
    // CPU metrics
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    
    const cpuUsage = 100 - ~~(100 * totalIdle / totalTick);
    
    // Memory metrics
    const memoryUsage = ((totalMemory - freeMemory) / totalMemory) * 100;
    
    // Update metrics
    this.updateMetric('system', {
      cpu: {
        usage: cpuUsage,
        count: cpus.length,
        loadAvg: loadAvg[0]
      },
      memory: {
        total: totalMemory,
        free: freeMemory,
        used: totalMemory - freeMemory,
        usage: memoryUsage
      },
      uptime: os.uptime(),
      platform: os.platform(),
      arch: os.arch()
    });
  }

  /**
   * Collect application metrics
   */
  async collectApplicationMetrics() {
    // Get metrics from global components
    if (global.core) {
      const stats = global.core.getAutomatedStats();
      
      // Pool metrics
      this.updateMetric('pool', {
        miners: stats.pool?.miners || 0,
        hashrate: stats.pool?.hashrate || 0,
        shares: stats.pool?.shares || {},
        efficiency: parseFloat(stats.pool?.efficiency || 100)
      });
      
      // Fee metrics
      this.updateMetric('fees', {
        totalCollectedBTC: stats.fees?.totalCollectedBTC || 0,
        pendingFees: stats.fees?.pendingFees || {},
        operatorFeeRate: stats.fees?.operatorFeeRate || 0.001,
        collection: {
          failures: stats.fees?.collectionAttempts?.failed || 0,
          success: stats.fees?.collectionAttempts?.success || 0
        }
      });
      
      // Payment metrics
      this.updateMetric('payments', {
        queue: {
          length: stats.payments?.queueLength || 0
        },
        pending: stats.payments?.pendingBalances || {},
        lastPayout: stats.payments?.lastPayout || 0,
        totalPaid: stats.payments?.totalPayments || {}
      });
      
      // DEX metrics
      this.updateMetric('dex', {
        tvl: (stats.dex?.v2?.tvl || 0) + (stats.dex?.v3?.tvl || 0),
        pools: (stats.dex?.v2?.pools || 0) + (stats.dex?.v3?.pools || 0),
        volume24h: stats.dex?.v2?.volume24h || 0,
        trades: stats.dex?.tradingHistory || 0
      });
      
      // Network metrics
      this.updateMetric('network', {
        peers: stats.p2p?.peers || 0,
        latency: {
          avg: stats.p2p?.latency?.avg || 0,
          min: stats.p2p?.latency?.min || 0,
          max: stats.p2p?.latency?.max || 0
        },
        bandwidth: stats.p2p?.bandwidth || {}
      });
      
      // Database metrics
      if (stats.optimization?.databaseBatcher) {
        this.updateMetric('database', {
          query: {
            time: stats.optimization.databaseBatcher.avgBatchTime || 0
          },
          batches: stats.optimization.databaseBatcher.totalBatches || 0,
          operations: stats.optimization.databaseBatcher.totalOperations || 0,
          efficiency: stats.optimization.databaseBatcher.batchEfficiency || 0
        });
      }
      
      // Security metrics
      this.updateMetric('security', {
        ddos: {
          blocked: stats.security?.ddos?.currentBlacklisted || 0,
          challenges: stats.security?.ddos?.challenges || 0
        },
        rateLimit: {
          hits: stats.security?.rateLimiter?.totalHits || 0
        },
        authentication: {
          sessions: stats.security?.activeSessions || 0,
          failures: stats.security?.authentication?.failures || 0
        }
      });
    }
  }

  /**
   * Update metric value
   */
  updateMetric(category, data) {
    this.metrics.set(category, data);
    
    // Add to history
    const history = this.metricHistory.get(category);
    history.push({
      timestamp: Date.now(),
      data: { ...data }
    });
    
    // Cleanup old history
    const cutoff = Date.now() - this.config.historyRetention;
    while (history.length > 0 && history[0].timestamp < cutoff) {
      history.shift();
    }
    
    // Emit metric update
    this.emit('metric:updated', { category, data });
  }

  /**
   * Start alert evaluation
   */
  startAlertEvaluation() {
    this.alertTimer = setInterval(() => {
      this.evaluateAlerts();
    }, 30000); // Every 30 seconds
  }

  /**
   * Evaluate all alert conditions
   */
  evaluateAlerts() {
    for (const definition of this.alertDefinitions) {
      const metricValue = this.getMetricValue(definition.metric);
      
      if (metricValue === undefined) continue;
      
      const isTriggered = this.checkAlertCondition(
        metricValue,
        definition.condition,
        definition.threshold,
        definition.metric
      );
      
      const alert = this.alerts.get(definition.id);
      
      if (isTriggered) {
        if (!alert) {
          // New alert
          this.triggerAlert(definition, metricValue);
        } else if (alert.status === 'resolved') {
          // Re-triggered alert
          this.triggerAlert(definition, metricValue);
        }
      } else if (alert && alert.status === 'active' && definition.autoResolve) {
        // Auto-resolve alert
        this.resolveAlert(definition.id, 'auto-resolved');
      }
    }
  }

  /**
   * Check alert condition
   */
  checkAlertCondition(value, condition, threshold, metric) {
    switch (condition) {
      case 'above':
        return value > threshold;
      
      case 'below':
        return value < threshold;
      
      case 'drop':
        // Check percentage drop from baseline
        const baseline = this.getMetricBaseline(metric);
        if (baseline && baseline > 0) {
          const dropPercentage = ((baseline - value) / baseline) * 100;
          return dropPercentage > threshold;
        }
        return false;
      
      case 'equals':
        return value === threshold;
      
      default:
        return false;
    }
  }

  /**
   * Trigger alert
   */
  triggerAlert(definition, value) {
    const alert = {
      id: definition.id,
      name: definition.name,
      severity: definition.severity,
      metric: definition.metric,
      value,
      threshold: definition.threshold,
      condition: definition.condition,
      status: 'active',
      triggeredAt: Date.now(),
      resolvedAt: null,
      notifications: []
    };
    
    this.alerts.set(definition.id, alert);
    
    // Create incident
    const incident = {
      id: `INC-${Date.now()}`,
      alertId: definition.id,
      name: definition.name,
      severity: definition.severity,
      startedAt: Date.now(),
      endedAt: null,
      status: 'open',
      details: {
        metric: definition.metric,
        value,
        threshold: definition.threshold
      }
    };
    
    this.incidents.push(incident);
    
    this.logger.warn(`Alert triggered: ${definition.name} (${value} ${definition.condition} ${definition.threshold})`);
    
    // Emit alert event
    this.emit('alert:triggered', { alert, incident });
    
    // Automated response
    this.executeAutomatedResponse(definition, alert);
  }

  /**
   * Resolve alert
   */
  resolveAlert(alertId, reason = 'manual') {
    const alert = this.alerts.get(alertId);
    
    if (!alert || alert.status !== 'active') return;
    
    alert.status = 'resolved';
    alert.resolvedAt = Date.now();
    alert.resolveReason = reason;
    
    // Close related incident
    const incident = this.incidents.find(
      inc => inc.alertId === alertId && inc.status === 'open'
    );
    
    if (incident) {
      incident.status = 'closed';
      incident.endedAt = Date.now();
    }
    
    this.logger.info(`Alert resolved: ${alert.name} (${reason})`);
    
    // Emit resolve event
    this.emit('alert:resolved', { alert, incident });
  }

  /**
   * Execute automated response
   */
  async executeAutomatedResponse(definition, alert) {
    switch (definition.id) {
      case 'high_cpu':
        // Trigger garbage collection
        if (global.performance) {
          global.performance.forceGarbageCollection();
        }
        break;
      
      case 'hashrate_drop':
        // Check stratum server health
        if (global.stratum) {
          this.logger.info('Checking stratum server health...');
          // Additional health checks
        }
        break;
      
      case 'fee_collection_failure':
        // Attempt emergency collection
        if (global.feeManager) {
          this.logger.warn('Attempting emergency fee collection...');
          await global.feeManager.emergencyCollection();
        }
        break;
      
      case 'payment_queue_backup':
        // Force payment processing
        if (global.paymentManager) {
          this.logger.info('Force processing payment queue...');
          await global.paymentManager.processPaymentQueue();
        }
        break;
      
      case 'database_slow':
        // Optimize database
        if (global.db) {
          this.logger.info('Running database optimization...');
          global.db.optimize();
        }
        break;
    }
  }

  /**
   * Get metric value by path
   */
  getMetricValue(path) {
    const parts = path.split('.');
    let value = this.metrics.get(parts[0]);
    
    for (let i = 1; i < parts.length; i++) {
      if (value && typeof value === 'object') {
        value = value[parts[i]];
      } else {
        return undefined;
      }
    }
    
    return value;
  }

  /**
   * Get metric baseline
   */
  getMetricBaseline(metric) {
    if (!this.baselines.has(metric)) {
      // Calculate baseline from history
      const values = this.getMetricHistory(metric, 3600000); // 1 hour
      if (values.length > 0) {
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        this.baselines.set(metric, avg);
        return avg;
      }
      return null;
    }
    
    return this.baselines.get(metric);
  }

  /**
   * Get metric history values
   */
  getMetricHistory(path, duration = 3600000) {
    const parts = path.split('.');
    const category = parts[0];
    const history = this.metricHistory.get(category) || [];
    
    const cutoff = Date.now() - duration;
    const values = [];
    
    for (const entry of history) {
      if (entry.timestamp < cutoff) continue;
      
      let value = entry.data;
      for (let i = 1; i < parts.length; i++) {
        if (value && typeof value === 'object') {
          value = value[parts[i]];
        } else {
          value = undefined;
          break;
        }
      }
      
      if (value !== undefined && typeof value === 'number') {
        values.push(value);
      }
    }
    
    return values;
  }

  /**
   * Start anomaly detection
   */
  startAnomalyDetection() {
    setInterval(() => {
      this.detectAnomalies();
    }, 60000); // Every minute
  }

  /**
   * Detect anomalies in metrics
   */
  detectAnomalies() {
    const anomalyThresholds = {
      'pool.hashrate': { method: 'zscore', threshold: 3 },
      'pool.miners': { method: 'zscore', threshold: 2.5 },
      'network.latency.avg': { method: 'iqr', threshold: 1.5 },
      'database.query.time': { method: 'iqr', threshold: 2 }
    };
    
    for (const [metric, config] of Object.entries(anomalyThresholds)) {
      const values = this.getMetricHistory(metric, 3600000); // 1 hour
      
      if (values.length < 10) continue;
      
      const currentValue = this.getMetricValue(metric);
      if (currentValue === undefined) continue;
      
      const isAnomaly = this.detectAnomaly(values, currentValue, config);
      
      if (isAnomaly) {
        const anomaly = {
          metric,
          value: currentValue,
          method: config.method,
          timestamp: Date.now()
        };
        
        this.anomalies.set(metric, anomaly);
        
        this.logger.warn(`Anomaly detected in ${metric}: ${currentValue}`);
        this.emit('anomaly:detected', anomaly);
      }
    }
  }

  /**
   * Detect anomaly using statistical methods
   */
  detectAnomaly(values, current, config) {
    if (config.method === 'zscore') {
      // Z-score method
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
      const stdDev = Math.sqrt(variance);
      
      if (stdDev === 0) return false;
      
      const zScore = Math.abs((current - mean) / stdDev);
      return zScore > config.threshold;
      
    } else if (config.method === 'iqr') {
      // Interquartile range method
      const sorted = [...values].sort((a, b) => a - b);
      const q1 = sorted[Math.floor(sorted.length * 0.25)];
      const q3 = sorted[Math.floor(sorted.length * 0.75)];
      const iqr = q3 - q1;
      
      const lowerBound = q1 - (config.threshold * iqr);
      const upperBound = q3 + (config.threshold * iqr);
      
      return current < lowerBound || current > upperBound;
    }
    
    return false;
  }

  /**
   * Start predictive analysis
   */
  startPredictiveAnalysis() {
    setInterval(() => {
      this.runPredictiveAnalysis();
    }, 300000); // Every 5 minutes
  }

  /**
   * Run predictive analysis
   */
  runPredictiveAnalysis() {
    // Predict hashrate trends
    const hashrateHistory = this.getMetricHistory('pool.hashrate', 86400000); // 24 hours
    
    if (hashrateHistory.length > 100) {
      const trend = this.calculateTrend(hashrateHistory);
      
      if (trend.slope < -0.1) { // Declining trend
        this.emit('prediction:hashrate_decline', {
          currentTrend: trend.slope,
          predictedDrop: Math.abs(trend.slope * 3600), // Next hour
          confidence: trend.r2
        });
      }
    }
    
    // Predict resource exhaustion
    const memoryHistory = this.getMetricHistory('system.memory.usage', 3600000); // 1 hour
    
    if (memoryHistory.length > 30) {
      const trend = this.calculateTrend(memoryHistory);
      
      if (trend.slope > 0.1 && trend.r2 > 0.7) {
        const currentUsage = memoryHistory[memoryHistory.length - 1];
        const hoursUntilFull = (100 - currentUsage) / (trend.slope * 6); // 10-minute intervals
        
        if (hoursUntilFull < 2) {
          this.emit('prediction:memory_exhaustion', {
            hoursUntilFull,
            currentUsage,
            trend: trend.slope,
            confidence: trend.r2
          });
        }
      }
    }
  }

  /**
   * Calculate linear trend
   */
  calculateTrend(values) {
    const n = values.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = values;
    
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((a, b, i) => a + b * y[i], 0);
    const sumX2 = x.reduce((a, b) => a + b * b, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Calculate R-squared
    const yMean = sumY / n;
    const ssTotal = y.reduce((a, b) => a + Math.pow(b - yMean, 2), 0);
    const ssResidual = y.reduce((a, b, i) => {
      const predicted = slope * x[i] + intercept;
      return a + Math.pow(b - predicted, 2);
    }, 0);
    const r2 = 1 - (ssResidual / ssTotal);
    
    return { slope, intercept, r2 };
  }

  /**
   * Get current alerts
   */
  getActiveAlerts() {
    return Array.from(this.alerts.values())
      .filter(alert => alert.status === 'active');
  }

  /**
   * Get recent incidents
   */
  getRecentIncidents(hours = 24) {
    const cutoff = Date.now() - (hours * 3600000);
    return this.incidents.filter(incident => incident.startedAt >= cutoff);
  }

  /**
   * Get monitoring dashboard data
   */
  getDashboardData() {
    const activeAlerts = this.getActiveAlerts();
    const recentIncidents = this.getRecentIncidents(24);
    
    return {
      system: this.metrics.get('system'),
      pool: this.metrics.get('pool'),
      network: this.metrics.get('network'),
      database: this.metrics.get('database'),
      fees: this.metrics.get('fees'),
      payments: this.metrics.get('payments'),
      dex: this.metrics.get('dex'),
      security: this.metrics.get('security'),
      alerts: {
        active: activeAlerts.length,
        list: activeAlerts
      },
      incidents: {
        last24h: recentIncidents.length,
        open: recentIncidents.filter(i => i.status === 'open').length,
        list: recentIncidents.slice(0, 10)
      },
      anomalies: Array.from(this.anomalies.values()),
      health: this.calculateHealthScore()
    };
  }

  /**
   * Calculate overall health score
   */
  calculateHealthScore() {
    let score = 100;
    
    // Deduct for active alerts
    const activeAlerts = this.getActiveAlerts();
    for (const alert of activeAlerts) {
      switch (alert.severity) {
        case 'critical':
          score -= 20;
          break;
        case 'warning':
          score -= 10;
          break;
        case 'info':
          score -= 5;
          break;
      }
    }
    
    // Deduct for anomalies
    score -= this.anomalies.size * 5;
    
    // Ensure score is within bounds
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Get comprehensive statistics
   */
  getStats() {
    return {
      metrics: {
        categories: this.metrics.size,
        totalDataPoints: Array.from(this.metricHistory.values())
          .reduce((sum, history) => sum + history.length, 0)
      },
      alerts: {
        total: this.alerts.size,
        active: this.getActiveAlerts().length,
        definitions: this.alertDefinitions.length
      },
      incidents: {
        total: this.incidents.length,
        open: this.incidents.filter(i => i.status === 'open').length,
        mttr: this.calculateMTTR() // Mean Time To Resolution
      },
      anomalies: this.anomalies.size,
      health: this.calculateHealthScore(),
      uptime: process.uptime()
    };
  }

  /**
   * Calculate Mean Time To Resolution
   */
  calculateMTTR() {
    const resolvedIncidents = this.incidents.filter(
      i => i.status === 'closed' && i.endedAt
    );
    
    if (resolvedIncidents.length === 0) return 0;
    
    const totalTime = resolvedIncidents.reduce(
      (sum, incident) => sum + (incident.endedAt - incident.startedAt),
      0
    );
    
    return Math.round(totalTime / resolvedIncidents.length / 60000); // Minutes
  }

  /**
   * Stop monitoring system
   */
  stop() {
    if (this.metricTimer) {
      clearInterval(this.metricTimer);
      this.metricTimer = null;
    }
    
    if (this.alertTimer) {
      clearInterval(this.alertTimer);
      this.alertTimer = null;
    }
    
    this.logger.info('Monitoring system stopped');
  }
}
