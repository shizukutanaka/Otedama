/**
 * Comprehensive Mining Analytics and Monitoring Dashboard
 * Real-time insights, predictive analytics, and performance optimization
 */

import { EventEmitter } from 'events';
import { WebSocketServer } from 'ws';
import express from 'express';
import { logger } from '../../core/logger.js';

/**
 * Analytics metric types
 */
export const MetricType = {
  HASHRATE: 'hashrate',
  TEMPERATURE: 'temperature',
  POWER: 'power',
  EFFICIENCY: 'efficiency',
  SHARES: 'shares',
  REVENUE: 'revenue',
  ERRORS: 'errors',
  LATENCY: 'latency'
};

/**
 * Alert severity levels
 */
export const AlertSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical'
};

/**
 * Time series data store
 */
export class TimeSeriesStore {
  constructor(maxPoints = 10000) {
    this.maxPoints = maxPoints;
    this.data = new Map();
  }
  
  /**
   * Add data point
   */
  addPoint(metric, value, timestamp = Date.now()) {
    if (!this.data.has(metric)) {
      this.data.set(metric, []);
    }
    
    const series = this.data.get(metric);
    series.push({ timestamp, value });
    
    // Maintain max points
    if (series.length > this.maxPoints) {
      series.shift();
    }
  }
  
  /**
   * Get time series data
   */
  getSeries(metric, startTime = 0, endTime = Date.now()) {
    const series = this.data.get(metric) || [];
    
    return series.filter(point => 
      point.timestamp >= startTime && point.timestamp <= endTime
    );
  }
  
  /**
   * Get latest value
   */
  getLatest(metric) {
    const series = this.data.get(metric) || [];
    return series.length > 0 ? series[series.length - 1] : null;
  }
  
  /**
   * Calculate statistics
   */
  getStats(metric, window = 3600000) { // 1 hour default
    const endTime = Date.now();
    const startTime = endTime - window;
    const series = this.getSeries(metric, startTime, endTime);
    
    if (series.length === 0) {
      return null;
    }
    
    const values = series.map(p => p.value);
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    
    // Standard deviation
    const variance = values.reduce((acc, val) => {
      return acc + Math.pow(val - avg, 2);
    }, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    
    return { avg, min, max, stdDev, count: values.length };
  }
}

/**
 * Alert manager
 */
export class AlertManager extends EventEmitter {
  constructor() {
    super();
    this.alerts = [];
    this.rules = new Map();
    this.suppressions = new Map();
  }
  
  /**
   * Add alert rule
   */
  addRule(rule) {
    this.rules.set(rule.id, {
      id: rule.id,
      name: rule.name,
      condition: rule.condition,
      severity: rule.severity || AlertSeverity.WARNING,
      cooldown: rule.cooldown || 300000, // 5 minutes default
      actions: rule.actions || []
    });
  }
  
  /**
   * Check rules against metrics
   */
  checkRules(metrics) {
    for (const [ruleId, rule] of this.rules) {
      try {
        // Check if rule is in cooldown
        if (this.isInCooldown(ruleId)) {
          continue;
        }
        
        // Evaluate condition
        const triggered = rule.condition(metrics);
        
        if (triggered) {
          this.triggerAlert(rule, metrics);
        }
      } catch (error) {
        logger.error(`Error checking rule ${rule.name}: ${error.message}`);
      }
    }
  }
  
  /**
   * Check if rule is in cooldown
   */
  isInCooldown(ruleId) {
    const lastTrigger = this.suppressions.get(ruleId);
    if (!lastTrigger) return false;
    
    const rule = this.rules.get(ruleId);
    return Date.now() - lastTrigger < rule.cooldown;
  }
  
  /**
   * Trigger alert
   */
  triggerAlert(rule, metrics) {
    const alert = {
      id: `${rule.id}_${Date.now()}`,
      ruleId: rule.id,
      name: rule.name,
      severity: rule.severity,
      timestamp: Date.now(),
      metrics: { ...metrics },
      resolved: false
    };
    
    this.alerts.push(alert);
    this.suppressions.set(rule.id, Date.now());
    
    // Execute actions
    for (const action of rule.actions) {
      try {
        action(alert);
      } catch (error) {
        logger.error(`Error executing alert action: ${error.message}`);
      }
    }
    
    logger.warn(`Alert triggered: ${rule.name} (${rule.severity})`);
    
    this.emit('alert:triggered', alert);
  }
  
  /**
   * Get active alerts
   */
  getActiveAlerts() {
    return this.alerts.filter(alert => !alert.resolved);
  }
  
  /**
   * Resolve alert
   */
  resolveAlert(alertId) {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.resolved = true;
      alert.resolvedAt = Date.now();
      this.emit('alert:resolved', alert);
    }
  }
}

/**
 * Performance analyzer
 */
export class PerformanceAnalyzer {
  constructor(timeSeriesStore) {
    this.store = timeSeriesStore;
    this.baselines = new Map();
    this.anomalies = [];
  }
  
  /**
   * Calculate performance baseline
   */
  calculateBaseline(metric, window = 86400000) { // 24 hours
    const stats = this.store.getStats(metric, window);
    if (!stats) return null;
    
    const baseline = {
      metric,
      mean: stats.avg,
      stdDev: stats.stdDev,
      upperBound: stats.avg + 2 * stats.stdDev,
      lowerBound: stats.avg - 2 * stats.stdDev,
      updatedAt: Date.now()
    };
    
    this.baselines.set(metric, baseline);
    return baseline;
  }
  
  /**
   * Detect anomalies
   */
  detectAnomalies() {
    const anomalies = [];
    
    for (const [metric, baseline] of this.baselines) {
      const latest = this.store.getLatest(metric);
      if (!latest) continue;
      
      // Check if value is outside bounds
      if (latest.value > baseline.upperBound || latest.value < baseline.lowerBound) {
        const deviation = Math.abs(latest.value - baseline.mean) / baseline.stdDev;
        
        anomalies.push({
          metric,
          value: latest.value,
          expected: baseline.mean,
          deviation,
          timestamp: latest.timestamp,
          type: latest.value > baseline.upperBound ? 'high' : 'low'
        });
      }
    }
    
    this.anomalies = anomalies;
    return anomalies;
  }
  
  /**
   * Predict future values
   */
  predictFuture(metric, hoursAhead = 1) {
    const window = 3600000 * 24; // 24 hours
    const series = this.store.getSeries(metric, Date.now() - window);
    
    if (series.length < 10) return null;
    
    // Simple linear regression
    const n = series.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    for (let i = 0; i < n; i++) {
      const x = i;
      const y = series[i].value;
      
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Predict future value
    const futurePoint = n + (hoursAhead * 3600000) / (window / n);
    const prediction = intercept + slope * futurePoint;
    
    return {
      metric,
      prediction,
      confidence: this.calculateConfidence(series, slope, intercept),
      timestamp: Date.now() + hoursAhead * 3600000
    };
  }
  
  /**
   * Calculate prediction confidence
   */
  calculateConfidence(series, slope, intercept) {
    // Calculate R-squared
    const yMean = series.reduce((sum, p) => sum + p.value, 0) / series.length;
    
    let ssTotal = 0;
    let ssResidual = 0;
    
    for (let i = 0; i < series.length; i++) {
      const yActual = series[i].value;
      const yPredicted = intercept + slope * i;
      
      ssTotal += Math.pow(yActual - yMean, 2);
      ssResidual += Math.pow(yActual - yPredicted, 2);
    }
    
    const rSquared = 1 - (ssResidual / ssTotal);
    return Math.max(0, Math.min(1, rSquared));
  }
}

/**
 * Mining analytics dashboard
 */
export class MiningAnalyticsDashboard extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      port: options.port || 3001,
      updateInterval: options.updateInterval || 1000,
      retentionPeriod: options.retentionPeriod || 86400000, // 24 hours
      enableWebSocket: options.enableWebSocket !== false,
      enableAPI: options.enableAPI !== false,
      ...options
    };
    
    // Data stores
    this.timeSeriesStore = new TimeSeriesStore();
    this.alertManager = new AlertManager();
    this.performanceAnalyzer = new PerformanceAnalyzer(this.timeSeriesStore);
    
    // Real-time data
    this.currentMetrics = {
      hashrate: 0,
      temperature: {},
      power: 0,
      efficiency: 0,
      shares: { accepted: 0, rejected: 0, invalid: 0 },
      revenue: { current: 0, daily: 0, monthly: 0 },
      devices: {},
      pools: {},
      algorithms: {}
    };
    
    // Statistics
    this.statistics = {
      uptime: 0,
      totalShares: 0,
      totalRevenue: 0,
      peakHashrate: 0,
      errors: []
    };
    
    // Initialize alert rules
    this.initializeAlertRules();
    
    // Web server
    this.app = null;
    this.wss = null;
    
    this.isRunning = false;
  }
  
  /**
   * Initialize default alert rules
   */
  initializeAlertRules() {
    // High temperature alert
    this.alertManager.addRule({
      id: 'high_temp',
      name: 'High Temperature',
      severity: AlertSeverity.WARNING,
      condition: (metrics) => {
        for (const temp of Object.values(metrics.temperature)) {
          if (temp > 85) return true;
        }
        return false;
      },
      actions: [(alert) => {
        logger.warn(`High temperature alert: ${JSON.stringify(alert.metrics.temperature)}`);
      }]
    });
    
    // Low hashrate alert
    this.alertManager.addRule({
      id: 'low_hashrate',
      name: 'Low Hashrate',
      severity: AlertSeverity.ERROR,
      condition: (metrics) => {
        const baseline = this.performanceAnalyzer.baselines.get('hashrate');
        if (!baseline) return false;
        return metrics.hashrate < baseline.mean * 0.8;
      },
      cooldown: 600000 // 10 minutes
    });
    
    // High reject rate alert
    this.alertManager.addRule({
      id: 'high_rejects',
      name: 'High Reject Rate',
      severity: AlertSeverity.WARNING,
      condition: (metrics) => {
        const total = metrics.shares.accepted + metrics.shares.rejected;
        if (total === 0) return false;
        const rejectRate = metrics.shares.rejected / total;
        return rejectRate > 0.05; // 5% threshold
      }
    });
    
    // Power efficiency alert
    this.alertManager.addRule({
      id: 'low_efficiency',
      name: 'Low Power Efficiency',
      severity: AlertSeverity.INFO,
      condition: (metrics) => {
        return metrics.efficiency < 0.8; // 80% efficiency threshold
      }
    });
  }
  
  /**
   * Start dashboard
   */
  async start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    
    logger.info('Starting mining analytics dashboard');
    
    // Start web server
    if (this.options.enableAPI || this.options.enableWebSocket) {
      await this.startWebServer();
    }
    
    // Start metric collection
    this.startMetricCollection();
    
    // Calculate initial baselines
    setTimeout(() => {
      this.calculateBaselines();
    }, 10000); // Wait 10 seconds for initial data
    
    this.emit('started');
  }
  
  /**
   * Start web server
   */
  async startWebServer() {
    this.app = express();
    this.app.use(express.json());
    
    // API routes
    if (this.options.enableAPI) {
      this.setupAPIRoutes();
    }
    
    // Static dashboard
    this.app.use(express.static('public/dashboard'));
    
    const server = this.app.listen(this.options.port, () => {
      logger.info(`Analytics dashboard listening on port ${this.options.port}`);
    });
    
    // WebSocket server
    if (this.options.enableWebSocket) {
      this.wss = new WebSocketServer({ server });
      this.setupWebSocket();
    }
  }
  
  /**
   * Setup API routes
   */
  setupAPIRoutes() {
    // Current metrics
    this.app.get('/api/metrics', (req, res) => {
      res.json(this.currentMetrics);
    });
    
    // Time series data
    this.app.get('/api/timeseries/:metric', (req, res) => {
      const { metric } = req.params;
      const { start, end } = req.query;
      
      const series = this.timeSeriesStore.getSeries(
        metric,
        parseInt(start) || Date.now() - 3600000,
        parseInt(end) || Date.now()
      );
      
      res.json(series);
    });
    
    // Statistics
    this.app.get('/api/stats', (req, res) => {
      res.json(this.getStatistics());
    });
    
    // Alerts
    this.app.get('/api/alerts', (req, res) => {
      res.json({
        active: this.alertManager.getActiveAlerts(),
        history: this.alertManager.alerts.slice(-100)
      });
    });
    
    // Predictions
    this.app.get('/api/predictions', (req, res) => {
      const predictions = {};
      
      for (const metric of Object.values(MetricType)) {
        const prediction = this.performanceAnalyzer.predictFuture(metric, 1);
        if (prediction) {
          predictions[metric] = prediction;
        }
      }
      
      res.json(predictions);
    });
    
    // Performance analysis
    this.app.get('/api/analysis', (req, res) => {
      res.json({
        baselines: Object.fromEntries(this.performanceAnalyzer.baselines),
        anomalies: this.performanceAnalyzer.anomalies
      });
    });
  }
  
  /**
   * Setup WebSocket
   */
  setupWebSocket() {
    this.wss.on('connection', (ws) => {
      logger.info('New WebSocket connection');
      
      // Send initial data
      ws.send(JSON.stringify({
        type: 'init',
        data: {
          metrics: this.currentMetrics,
          stats: this.getStatistics()
        }
      }));
      
      // Handle messages
      ws.on('message', (message) => {
        try {
          const msg = JSON.parse(message);
          this.handleWebSocketMessage(ws, msg);
        } catch (error) {
          logger.error('Invalid WebSocket message:', error);
        }
      });
      
      ws.on('close', () => {
        logger.info('WebSocket connection closed');
      });
    });
    
    // Broadcast updates
    setInterval(() => {
      this.broadcastUpdate();
    }, this.options.updateInterval);
  }
  
  /**
   * Handle WebSocket message
   */
  handleWebSocketMessage(ws, message) {
    switch (message.type) {
      case 'subscribe':
        // Handle metric subscription
        break;
        
      case 'command':
        // Handle dashboard commands
        break;
        
      default:
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Unknown message type'
        }));
    }
  }
  
  /**
   * Broadcast update to all clients
   */
  broadcastUpdate() {
    if (!this.wss) return;
    
    const update = {
      type: 'update',
      timestamp: Date.now(),
      data: {
        metrics: this.currentMetrics,
        alerts: this.alertManager.getActiveAlerts()
      }
    };
    
    const message = JSON.stringify(update);
    
    this.wss.clients.forEach((client) => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    });
  }
  
  /**
   * Start metric collection
   */
  startMetricCollection() {
    this.collectionInterval = setInterval(() => {
      // Check alerts
      this.alertManager.checkRules(this.currentMetrics);
      
      // Detect anomalies
      this.performanceAnalyzer.detectAnomalies();
      
      // Clean old data
      this.cleanOldData();
    }, 5000); // Every 5 seconds
  }
  
  /**
   * Update metrics
   */
  updateMetrics(metrics) {
    // Update current metrics
    Object.assign(this.currentMetrics, metrics);
    
    // Store time series data
    if (metrics.hashrate !== undefined) {
      this.timeSeriesStore.addPoint(MetricType.HASHRATE, metrics.hashrate);
      
      // Update peak
      if (metrics.hashrate > this.statistics.peakHashrate) {
        this.statistics.peakHashrate = metrics.hashrate;
      }
    }
    
    if (metrics.temperature) {
      for (const [device, temp] of Object.entries(metrics.temperature)) {
        this.timeSeriesStore.addPoint(`${MetricType.TEMPERATURE}_${device}`, temp);
      }
    }
    
    if (metrics.power !== undefined) {
      this.timeSeriesStore.addPoint(MetricType.POWER, metrics.power);
    }
    
    if (metrics.efficiency !== undefined) {
      this.timeSeriesStore.addPoint(MetricType.EFFICIENCY, metrics.efficiency);
    }
    
    if (metrics.shares) {
      this.timeSeriesStore.addPoint(`${MetricType.SHARES}_accepted`, metrics.shares.accepted);
      this.timeSeriesStore.addPoint(`${MetricType.SHARES}_rejected`, metrics.shares.rejected);
      
      // Update totals
      this.statistics.totalShares = metrics.shares.accepted + metrics.shares.rejected;
    }
    
    if (metrics.revenue) {
      this.timeSeriesStore.addPoint(MetricType.REVENUE, metrics.revenue.current);
      this.statistics.totalRevenue += metrics.revenue.current;
    }
    
    this.emit('metrics:updated', metrics);
  }
  
  /**
   * Add error
   */
  addError(error) {
    const errorEntry = {
      timestamp: Date.now(),
      message: error.message || error,
      type: error.type || 'general',
      details: error.details || {}
    };
    
    this.statistics.errors.push(errorEntry);
    
    // Keep last 1000 errors
    if (this.statistics.errors.length > 1000) {
      this.statistics.errors.shift();
    }
    
    this.timeSeriesStore.addPoint(MetricType.ERRORS, 1);
    
    this.emit('error:added', errorEntry);
  }
  
  /**
   * Calculate baselines
   */
  calculateBaselines() {
    for (const metric of Object.values(MetricType)) {
      this.performanceAnalyzer.calculateBaseline(metric);
    }
    
    logger.info('Performance baselines calculated');
  }
  
  /**
   * Clean old data
   */
  cleanOldData() {
    const cutoff = Date.now() - this.options.retentionPeriod;
    
    // Clean time series data
    for (const [metric, series] of this.timeSeriesStore.data) {
      const filtered = series.filter(point => point.timestamp > cutoff);
      if (filtered.length < series.length) {
        this.timeSeriesStore.data.set(metric, filtered);
      }
    }
    
    // Clean old alerts
    this.alertManager.alerts = this.alertManager.alerts.filter(
      alert => alert.timestamp > cutoff
    );
    
    // Clean old errors
    this.statistics.errors = this.statistics.errors.filter(
      error => error.timestamp > cutoff
    );
  }
  
  /**
   * Get statistics
   */
  getStatistics() {
    const now = Date.now();
    
    return {
      ...this.statistics,
      uptime: now - (this.startTime || now),
      currentHashrate: this.currentMetrics.hashrate,
      avgHashrate: this.timeSeriesStore.getStats(MetricType.HASHRATE)?.avg || 0,
      totalPower: this.timeSeriesStore.getStats(MetricType.POWER)?.avg || 0,
      avgEfficiency: this.timeSeriesStore.getStats(MetricType.EFFICIENCY)?.avg || 0,
      shareRate: this.calculateShareRate(),
      errorRate: this.calculateErrorRate()
    };
  }
  
  /**
   * Calculate share rate
   */
  calculateShareRate() {
    const window = 3600000; // 1 hour
    const accepted = this.timeSeriesStore.getSeries(`${MetricType.SHARES}_accepted`, Date.now() - window);
    
    if (accepted.length === 0) return 0;
    
    const total = accepted.reduce((sum, point) => sum + point.value, 0);
    return total / (window / 1000); // Shares per second
  }
  
  /**
   * Calculate error rate
   */
  calculateErrorRate() {
    const window = 3600000; // 1 hour
    const errors = this.timeSeriesStore.getSeries(MetricType.ERRORS, Date.now() - window);
    
    return errors.length / (window / 1000 / 60); // Errors per minute
  }
  
  /**
   * Export data
   */
  exportData(startTime, endTime) {
    const data = {
      metrics: {},
      statistics: this.getStatistics(),
      alerts: this.alertManager.alerts.filter(
        a => a.timestamp >= startTime && a.timestamp <= endTime
      )
    };
    
    // Export all time series
    for (const [metric, series] of this.timeSeriesStore.data) {
      data.metrics[metric] = series.filter(
        p => p.timestamp >= startTime && p.timestamp <= endTime
      );
    }
    
    return data;
  }
  
  /**
   * Stop dashboard
   */
  stop() {
    this.isRunning = false;
    
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
    }
    
    if (this.wss) {
      this.wss.close();
    }
    
    if (this.app) {
      // Close Express server
    }
    
    logger.info('Mining analytics dashboard stopped');
    
    this.emit('stopped');
  }
}

export default MiningAnalyticsDashboard;