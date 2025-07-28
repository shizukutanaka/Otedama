/**
 * P2P Real-time Dashboard for Otedama
 * Advanced monitoring and visualization system
 * 
 * Design principles:
 * - Carmack: Real-time performance with minimal overhead
 * - Martin: Clean separation of metrics collection and display
 * - Pike: Simple but comprehensive monitoring
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import WebSocket from 'ws';
import { performance } from 'perf_hooks';

const logger = createStructuredLogger('P2PRealtimeDashboard');

/**
 * Metric types
 */
const METRIC_TYPES = {
  COUNTER: 'counter',           // Monotonic counter
  GAUGE: 'gauge',               // Current value
  HISTOGRAM: 'histogram',       // Distribution of values
  RATE: 'rate',                 // Rate per time unit
  PERCENTILE: 'percentile'      // Percentile calculations
};

/**
 * Dashboard sections
 */
const DASHBOARD_SECTIONS = {
  OVERVIEW: 'overview',
  NETWORK: 'network',
  MINING: 'mining',
  SHARES: 'shares',
  PEERS: 'peers',
  PERFORMANCE: 'performance',
  ALERTS: 'alerts'
};

/**
 * Time series data store
 */
class TimeSeriesStore {
  constructor(maxAge = 3600000) { // 1 hour default
    this.data = new Map();
    this.maxAge = maxAge;
    this.resolution = 1000; // 1 second buckets
  }
  
  /**
   * Add data point
   */
  add(metric, value, timestamp = Date.now()) {
    if (!this.data.has(metric)) {
      this.data.set(metric, []);
    }
    
    const series = this.data.get(metric);
    const bucket = Math.floor(timestamp / this.resolution) * this.resolution;
    
    // Find or create bucket
    let point = series.find(p => p.timestamp === bucket);
    if (!point) {
      point = {
        timestamp: bucket,
        values: [],
        min: value,
        max: value,
        sum: 0,
        count: 0
      };
      series.push(point);
    }
    
    // Update bucket
    point.values.push(value);
    point.min = Math.min(point.min, value);
    point.max = Math.max(point.max, value);
    point.sum += value;
    point.count++;
    
    // Clean old data
    this.cleanup(metric);
  }
  
  /**
   * Get time series data
   */
  getSeries(metric, duration = 300000) { // 5 minutes default
    const series = this.data.get(metric) || [];
    const cutoff = Date.now() - duration;
    
    return series
      .filter(p => p.timestamp >= cutoff)
      .map(p => ({
        timestamp: p.timestamp,
        value: p.sum / p.count, // Average
        min: p.min,
        max: p.max,
        count: p.count
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }
  
  /**
   * Clean old data
   */
  cleanup(metric) {
    const series = this.data.get(metric);
    if (!series) return;
    
    const cutoff = Date.now() - this.maxAge;
    const filtered = series.filter(p => p.timestamp >= cutoff);
    
    if (filtered.length < series.length) {
      this.data.set(metric, filtered);
    }
  }
  
  /**
   * Calculate statistics
   */
  getStats(metric, duration = 300000) {
    const series = this.getSeries(metric, duration);
    if (series.length === 0) return null;
    
    const values = series.map(p => p.value);
    const sorted = [...values].sort((a, b) => a - b);
    
    return {
      count: series.length,
      sum: values.reduce((a, b) => a + b, 0),
      average: values.reduce((a, b) => a + b, 0) / values.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)]
    };
  }
}

/**
 * Alert manager
 */
class AlertManager {
  constructor() {
    this.alerts = new Map();
    this.thresholds = new Map();
    this.subscribers = new Set();
  }
  
  /**
   * Set alert threshold
   */
  setThreshold(metric, condition, value, severity = 'warning') {
    this.thresholds.set(metric, {
      condition, // 'gt', 'lt', 'eq', 'ne'
      value,
      severity, // 'info', 'warning', 'error', 'critical'
      cooldown: 60000 // 1 minute cooldown
    });
  }
  
  /**
   * Check metric against thresholds
   */
  check(metric, value) {
    const threshold = this.thresholds.get(metric);
    if (!threshold) return;
    
    let triggered = false;
    
    switch (threshold.condition) {
      case 'gt':
        triggered = value > threshold.value;
        break;
      case 'lt':
        triggered = value < threshold.value;
        break;
      case 'eq':
        triggered = value === threshold.value;
        break;
      case 'ne':
        triggered = value !== threshold.value;
        break;
    }
    
    if (triggered) {
      this.trigger(metric, value, threshold);
    } else {
      this.clear(metric);
    }
  }
  
  /**
   * Trigger alert
   */
  trigger(metric, value, threshold) {
    const existingAlert = this.alerts.get(metric);
    
    // Check cooldown
    if (existingAlert && Date.now() - existingAlert.timestamp < threshold.cooldown) {
      return;
    }
    
    const alert = {
      metric,
      value,
      threshold: threshold.value,
      condition: threshold.condition,
      severity: threshold.severity,
      timestamp: Date.now(),
      message: `${metric} is ${value} (threshold: ${threshold.condition} ${threshold.value})`
    };
    
    this.alerts.set(metric, alert);
    
    // Notify subscribers
    for (const subscriber of this.subscribers) {
      subscriber(alert);
    }
  }
  
  /**
   * Clear alert
   */
  clear(metric) {
    if (this.alerts.has(metric)) {
      this.alerts.delete(metric);
      
      // Notify clear
      for (const subscriber of this.subscribers) {
        subscriber({ metric, cleared: true });
      }
    }
  }
  
  /**
   * Subscribe to alerts
   */
  subscribe(callback) {
    this.subscribers.add(callback);
  }
  
  /**
   * Get active alerts
   */
  getActiveAlerts() {
    return Array.from(this.alerts.values())
      .sort((a, b) => {
        // Sort by severity then timestamp
        const severityOrder = { critical: 0, error: 1, warning: 2, info: 3 };
        const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
        return severityDiff !== 0 ? severityDiff : b.timestamp - a.timestamp;
      });
  }
}

/**
 * P2P Real-time Dashboard
 */
export class P2PRealtimeDashboard extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      port: config.port || 8080,
      updateInterval: config.updateInterval || 1000, // 1 second
      retentionPeriod: config.retentionPeriod || 3600000, // 1 hour
      
      // Features
      enableWebSocket: config.enableWebSocket !== false,
      enableAlerts: config.enableAlerts !== false,
      enablePredictions: config.enablePredictions || true,
      
      // Performance
      maxMetrics: config.maxMetrics || 1000,
      compressionThreshold: config.compressionThreshold || 1024, // 1KB
      
      ...config
    };
    
    // Data stores
    this.metrics = new Map();
    this.timeSeries = new TimeSeriesStore(this.config.retentionPeriod);
    this.alertManager = new AlertManager();
    
    // WebSocket server
    this.wss = null;
    this.clients = new Set();
    
    // Metric definitions
    this.metricDefinitions = new Map();
    this.initializeMetrics();
    
    // Performance tracking
    this.lastUpdate = Date.now();
    this.updateCount = 0;
    
    this.logger = logger;
  }
  
  /**
   * Initialize metric definitions
   */
  initializeMetrics() {
    // Network metrics
    this.defineMetric('network.peers.total', METRIC_TYPES.GAUGE, {
      unit: 'peers',
      description: 'Total number of connected peers'
    });
    
    this.defineMetric('network.peers.active', METRIC_TYPES.GAUGE, {
      unit: 'peers',
      description: 'Number of active peers'
    });
    
    this.defineMetric('network.messages.sent', METRIC_TYPES.COUNTER, {
      unit: 'messages',
      description: 'Total messages sent'
    });
    
    this.defineMetric('network.messages.received', METRIC_TYPES.COUNTER, {
      unit: 'messages',
      description: 'Total messages received'
    });
    
    this.defineMetric('network.bandwidth.in', METRIC_TYPES.RATE, {
      unit: 'bytes/s',
      description: 'Incoming bandwidth'
    });
    
    this.defineMetric('network.bandwidth.out', METRIC_TYPES.RATE, {
      unit: 'bytes/s',
      description: 'Outgoing bandwidth'
    });
    
    // Mining metrics
    this.defineMetric('mining.hashrate.total', METRIC_TYPES.GAUGE, {
      unit: 'H/s',
      description: 'Total pool hashrate'
    });
    
    this.defineMetric('mining.hashrate.effective', METRIC_TYPES.GAUGE, {
      unit: 'H/s',
      description: 'Effective hashrate based on shares'
    });
    
    this.defineMetric('mining.workers.active', METRIC_TYPES.GAUGE, {
      unit: 'workers',
      description: 'Number of active mining workers'
    });
    
    this.defineMetric('mining.difficulty.current', METRIC_TYPES.GAUGE, {
      unit: 'difficulty',
      description: 'Current mining difficulty'
    });
    
    // Share metrics
    this.defineMetric('shares.submitted.total', METRIC_TYPES.COUNTER, {
      unit: 'shares',
      description: 'Total shares submitted'
    });
    
    this.defineMetric('shares.accepted.total', METRIC_TYPES.COUNTER, {
      unit: 'shares',
      description: 'Total shares accepted'
    });
    
    this.defineMetric('shares.rejected.total', METRIC_TYPES.COUNTER, {
      unit: 'shares',
      description: 'Total shares rejected'
    });
    
    this.defineMetric('shares.validation.latency', METRIC_TYPES.HISTOGRAM, {
      unit: 'ms',
      description: 'Share validation latency'
    });
    
    // Performance metrics
    this.defineMetric('performance.cpu.usage', METRIC_TYPES.GAUGE, {
      unit: 'percent',
      description: 'CPU usage percentage'
    });
    
    this.defineMetric('performance.memory.usage', METRIC_TYPES.GAUGE, {
      unit: 'bytes',
      description: 'Memory usage in bytes'
    });
    
    this.defineMetric('performance.latency.p2p', METRIC_TYPES.HISTOGRAM, {
      unit: 'ms',
      description: 'P2P network latency'
    });
    
    // Set default alerts
    if (this.config.enableAlerts) {
      this.alertManager.setThreshold('network.peers.total', 'lt', 5, 'warning');
      this.alertManager.setThreshold('shares.rejected.total', 'gt', 100, 'error');
      this.alertManager.setThreshold('performance.cpu.usage', 'gt', 90, 'warning');
      this.alertManager.setThreshold('performance.memory.usage', 'gt', 1024 * 1024 * 1024, 'warning'); // 1GB
    }
  }
  
  /**
   * Define a metric
   */
  defineMetric(name, type, options = {}) {
    this.metricDefinitions.set(name, {
      name,
      type,
      ...options
    });
    
    // Initialize metric value
    this.metrics.set(name, {
      value: 0,
      timestamp: Date.now()
    });
  }
  
  /**
   * Update metric value
   */
  updateMetric(name, value, timestamp = Date.now()) {
    const definition = this.metricDefinitions.get(name);
    if (!definition) {
      logger.warn('Unknown metric', { name });
      return;
    }
    
    // Update current value
    const current = this.metrics.get(name) || { value: 0 };
    
    switch (definition.type) {
      case METRIC_TYPES.COUNTER:
        // Counters only increase
        current.value = Math.max(current.value, value);
        break;
        
      case METRIC_TYPES.GAUGE:
        // Gauges can go up or down
        current.value = value;
        break;
        
      case METRIC_TYPES.RATE:
        // Calculate rate
        const timeDelta = timestamp - current.timestamp;
        if (timeDelta > 0) {
          current.value = (value - current.lastValue || 0) / (timeDelta / 1000);
          current.lastValue = value;
        }
        break;
        
      default:
        current.value = value;
    }
    
    current.timestamp = timestamp;
    this.metrics.set(name, current);
    
    // Add to time series
    this.timeSeries.add(name, current.value, timestamp);
    
    // Check alerts
    if (this.config.enableAlerts) {
      this.alertManager.check(name, current.value);
    }
    
    // Emit update
    this.emit('metric:updated', {
      name,
      value: current.value,
      timestamp
    });
  }
  
  /**
   * Update multiple metrics at once
   */
  updateMetrics(updates) {
    const timestamp = Date.now();
    
    for (const [name, value] of Object.entries(updates)) {
      this.updateMetric(name, value, timestamp);
    }
    
    this.updateCount++;
    
    // Broadcast updates if enough time has passed
    if (timestamp - this.lastUpdate >= this.config.updateInterval) {
      this.broadcastUpdate();
      this.lastUpdate = timestamp;
    }
  }
  
  /**
   * Get dashboard data
   */
  getDashboardData(section = DASHBOARD_SECTIONS.OVERVIEW, options = {}) {
    const data = {
      section,
      timestamp: Date.now(),
      metrics: {},
      timeSeries: {},
      alerts: []
    };
    
    // Get relevant metrics for section
    const relevantMetrics = this.getRelevantMetrics(section);
    
    for (const metricName of relevantMetrics) {
      const metric = this.metrics.get(metricName);
      const definition = this.metricDefinitions.get(metricName);
      
      if (metric && definition) {
        data.metrics[metricName] = {
          ...metric,
          ...definition
        };
        
        // Include time series if requested
        if (options.includeTimeSeries) {
          data.timeSeries[metricName] = this.timeSeries.getSeries(
            metricName,
            options.timeRange || 300000 // 5 minutes default
          );
        }
      }
    }
    
    // Include active alerts
    if (this.config.enableAlerts) {
      data.alerts = this.alertManager.getActiveAlerts();
    }
    
    // Include predictions if enabled
    if (this.config.enablePredictions && options.includePredictions) {
      data.predictions = this.generatePredictions(relevantMetrics);
    }
    
    return data;
  }
  
  /**
   * Get relevant metrics for section
   */
  getRelevantMetrics(section) {
    const allMetrics = Array.from(this.metricDefinitions.keys());
    
    switch (section) {
      case DASHBOARD_SECTIONS.OVERVIEW:
        return allMetrics.filter(m => 
          m.includes('.total') || 
          m.includes('.active') ||
          m.includes('hashrate')
        );
        
      case DASHBOARD_SECTIONS.NETWORK:
        return allMetrics.filter(m => m.startsWith('network.'));
        
      case DASHBOARD_SECTIONS.MINING:
        return allMetrics.filter(m => m.startsWith('mining.'));
        
      case DASHBOARD_SECTIONS.SHARES:
        return allMetrics.filter(m => m.startsWith('shares.'));
        
      case DASHBOARD_SECTIONS.PERFORMANCE:
        return allMetrics.filter(m => m.startsWith('performance.'));
        
      default:
        return allMetrics;
    }
  }
  
  /**
   * Generate predictions
   */
  generatePredictions(metrics) {
    const predictions = {};
    
    for (const metric of metrics) {
      const stats = this.timeSeries.getStats(metric, 3600000); // 1 hour
      if (!stats || stats.count < 10) continue;
      
      // Simple linear prediction
      const series = this.timeSeries.getSeries(metric, 3600000);
      if (series.length < 2) continue;
      
      const recent = series.slice(-10);
      const trend = this.calculateTrend(recent);
      
      predictions[metric] = {
        trend: trend > 0 ? 'increasing' : trend < 0 ? 'decreasing' : 'stable',
        trendValue: trend,
        predicted1h: stats.average + trend * 3600,
        confidence: Math.min(0.9, stats.count / 100)
      };
    }
    
    return predictions;
  }
  
  /**
   * Calculate trend
   */
  calculateTrend(series) {
    if (series.length < 2) return 0;
    
    // Simple linear regression
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    const n = series.length;
    
    for (let i = 0; i < n; i++) {
      const x = i;
      const y = series[i].value;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return slope;
  }
  
  /**
   * Start dashboard server
   */
  async start() {
    // Start WebSocket server if enabled
    if (this.config.enableWebSocket) {
      this.wss = new WebSocket.Server({ 
        port: this.config.port,
        perMessageDeflate: {
          zlibDeflateOptions: {
            level: 1
          },
          threshold: this.config.compressionThreshold
        }
      });
      
      this.wss.on('connection', (ws) => {
        this.handleWebSocketConnection(ws);
      });
    }
    
    // Start update loop
    this.updateInterval = setInterval(() => {
      this.broadcastUpdate();
    }, this.config.updateInterval);
    
    // Subscribe to alerts
    this.alertManager.subscribe((alert) => {
      this.broadcastAlert(alert);
    });
    
    this.logger.info('Real-time dashboard started', {
      port: this.config.port,
      websocket: this.config.enableWebSocket
    });
  }
  
  /**
   * Handle WebSocket connection
   */
  handleWebSocketConnection(ws) {
    this.clients.add(ws);
    
    // Send initial data
    ws.send(JSON.stringify({
      type: 'initial',
      data: this.getDashboardData(DASHBOARD_SECTIONS.OVERVIEW, {
        includeTimeSeries: true,
        timeRange: 300000
      })
    }));
    
    // Handle messages
    ws.on('message', (message) => {
      try {
        const request = JSON.parse(message);
        this.handleWebSocketMessage(ws, request);
      } catch (error) {
        ws.send(JSON.stringify({
          type: 'error',
          error: error.message
        }));
      }
    });
    
    ws.on('close', () => {
      this.clients.delete(ws);
    });
  }
  
  /**
   * Handle WebSocket message
   */
  handleWebSocketMessage(ws, request) {
    switch (request.type) {
      case 'subscribe':
        // Client subscribing to specific section
        ws.section = request.section || DASHBOARD_SECTIONS.OVERVIEW;
        ws.options = request.options || {};
        break;
        
      case 'query':
        // Client requesting specific data
        const data = this.getDashboardData(request.section, request.options);
        ws.send(JSON.stringify({
          type: 'response',
          requestId: request.id,
          data
        }));
        break;
        
      case 'command':
        // Handle dashboard commands
        this.handleCommand(request.command, request.params);
        break;
    }
  }
  
  /**
   * Broadcast update to all clients
   */
  broadcastUpdate() {
    if (this.clients.size === 0) return;
    
    // Group clients by section
    const clientsBySection = new Map();
    
    for (const client of this.clients) {
      const section = client.section || DASHBOARD_SECTIONS.OVERVIEW;
      if (!clientsBySection.has(section)) {
        clientsBySection.set(section, []);
      }
      clientsBySection.get(section).push(client);
    }
    
    // Send updates per section
    for (const [section, clients] of clientsBySection) {
      const data = this.getDashboardData(section, {
        includeTimeSeries: false // Only current values for updates
      });
      
      const message = JSON.stringify({
        type: 'update',
        data
      });
      
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    }
  }
  
  /**
   * Broadcast alert
   */
  broadcastAlert(alert) {
    const message = JSON.stringify({
      type: 'alert',
      alert
    });
    
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
  
  /**
   * Handle dashboard command
   */
  handleCommand(command, params) {
    switch (command) {
      case 'reset_metric':
        if (params.metric && this.metrics.has(params.metric)) {
          this.metrics.get(params.metric).value = 0;
        }
        break;
        
      case 'clear_alerts':
        for (const alert of this.alertManager.getActiveAlerts()) {
          this.alertManager.clear(alert.metric);
        }
        break;
        
      case 'set_threshold':
        if (params.metric && params.condition && params.value !== undefined) {
          this.alertManager.setThreshold(
            params.metric,
            params.condition,
            params.value,
            params.severity
          );
        }
        break;
    }
  }
  
  /**
   * Get statistics
   */
  getStatistics() {
    return {
      metrics: {
        total: this.metrics.size,
        definitions: this.metricDefinitions.size
      },
      clients: {
        connected: this.clients.size
      },
      alerts: {
        active: this.alertManager.getActiveAlerts().length,
        thresholds: this.alertManager.thresholds.size
      },
      performance: {
        updateCount: this.updateCount,
        updateRate: this.updateCount / ((Date.now() - this.lastUpdate) / 1000)
      }
    };
  }
  
  /**
   * Stop dashboard
   */
  async stop() {
    // Clear update interval
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    // Close WebSocket connections
    for (const client of this.clients) {
      client.close();
    }
    
    // Close WebSocket server
    if (this.wss) {
      await new Promise(resolve => this.wss.close(resolve));
    }
    
    this.logger.info('Real-time dashboard stopped');
  }
}

// Export constants
export {
  METRIC_TYPES,
  DASHBOARD_SECTIONS
};

export default P2PRealtimeDashboard;