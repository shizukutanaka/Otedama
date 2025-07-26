/**
 * Real-time Profitability Dashboard - Otedama
 * Advanced analytics and monitoring dashboard for mining operations
 * Features: real-time metrics, predictive analytics, multi-timeframe analysis
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import WebSocket from 'ws';

const logger = createLogger('RealtimeDashboard');

/**
 * Metric types
 */
export const MetricType = {
  HASHRATE: 'hashrate',
  PROFITABILITY: 'profitability',
  EFFICIENCY: 'efficiency',
  REVENUE: 'revenue',
  COSTS: 'costs',
  DEFI: 'defi',
  NETWORK: 'network',
  HARDWARE: 'hardware'
};

/**
 * Time frames
 */
export const TimeFrame = {
  REALTIME: '1m',
  MINUTE_5: '5m',
  MINUTE_15: '15m',
  HOUR: '1h',
  DAY: '1d',
  WEEK: '1w',
  MONTH: '1mo'
};

/**
 * Real-time dashboard system
 */
export class RealtimeDashboard extends EventEmitter {
  constructor(pool, options = {}) {
    super();
    
    this.pool = pool;
    this.config = {
      port: options.port || 8082,
      updateInterval: options.updateInterval || 1000, // 1 second
      metricsRetention: options.metricsRetention || 2592000000, // 30 days
      alertsEnabled: options.alertsEnabled !== false,
      predictiveAnalytics: options.predictiveAnalytics !== false,
      ...options
    };
    
    this.metrics = new Map();
    this.timeSeries = new Map();
    this.alerts = new Map();
    this.predictions = new Map();
    this.wsServer = null;
    this.clients = new Set();
    
    this.stats = {
      totalMetrics: 0,
      activeAlerts: 0,
      connectedClients: 0,
      dataPoints: 0
    };
  }
  
  /**
   * Initialize dashboard
   */
  async initialize() {
    logger.info('Initializing real-time dashboard...');
    
    // Initialize metric collectors
    this.initializeMetricCollectors();
    
    // Start WebSocket server
    await this.startWebSocketServer();
    
    // Start data collection
    this.startDataCollection();
    this.startAnalytics();
    
    logger.info(`Dashboard initialized on port ${this.config.port}`);
    this.emit('initialized');
  }
  
  /**
   * Initialize metric collectors
   */
  initializeMetricCollectors() {
    // Hashrate metrics
    this.registerMetric({
      id: 'pool_hashrate',
      type: MetricType.HASHRATE,
      name: 'Pool Hashrate',
      unit: 'H/s',
      aggregation: 'average'
    });
    
    this.registerMetric({
      id: 'network_hashrate',
      type: MetricType.HASHRATE,
      name: 'Network Hashrate',
      unit: 'H/s',
      aggregation: 'average'
    });
    
    // Profitability metrics
    this.registerMetric({
      id: 'btc_per_th_day',
      type: MetricType.PROFITABILITY,
      name: 'BTC per TH/day',
      unit: 'BTC',
      aggregation: 'average'
    });
    
    this.registerMetric({
      id: 'usd_per_th_day',
      type: MetricType.PROFITABILITY,
      name: 'USD per TH/day',
      unit: 'USD',
      aggregation: 'average'
    });
    
    // Efficiency metrics
    this.registerMetric({
      id: 'power_efficiency',
      type: MetricType.EFFICIENCY,
      name: 'Power Efficiency',
      unit: 'W/TH',
      aggregation: 'average'
    });
    
    this.registerMetric({
      id: 'share_efficiency',
      type: MetricType.EFFICIENCY,
      name: 'Share Efficiency',
      unit: '%',
      aggregation: 'average'
    });
    
    // Revenue metrics
    this.registerMetric({
      id: 'daily_revenue',
      type: MetricType.REVENUE,
      name: 'Daily Revenue',
      unit: 'USD',
      aggregation: 'sum'
    });
    
    this.registerMetric({
      id: 'mining_rewards',
      type: MetricType.REVENUE,
      name: 'Mining Rewards',
      unit: 'BTC',
      aggregation: 'sum'
    });
    
    // DeFi metrics
    this.registerMetric({
      id: 'defi_apy',
      type: MetricType.DEFI,
      name: 'DeFi APY',
      unit: '%',
      aggregation: 'average'
    });
    
    this.registerMetric({
      id: 'liquidity_deployed',
      type: MetricType.DEFI,
      name: 'Liquidity Deployed',
      unit: 'USD',
      aggregation: 'sum'
    });
    
    // Cost metrics
    this.registerMetric({
      id: 'electricity_cost',
      type: MetricType.COSTS,
      name: 'Electricity Cost',
      unit: 'USD',
      aggregation: 'sum'
    });
    
    this.registerMetric({
      id: 'maintenance_cost',
      type: MetricType.COSTS,
      name: 'Maintenance Cost',
      unit: 'USD',
      aggregation: 'sum'
    });
  }
  
  /**
   * Register metric
   */
  registerMetric(metric) {
    this.metrics.set(metric.id, {
      ...metric,
      currentValue: 0,
      lastUpdate: Date.now()
    });
    
    // Initialize time series storage
    this.timeSeries.set(metric.id, {
      data: [],
      aggregates: new Map()
    });
    
    this.stats.totalMetrics++;
  }
  
  /**
   * Start WebSocket server
   */
  async startWebSocketServer() {
    this.wsServer = new WebSocket.Server({
      port: this.config.port
    });
    
    this.wsServer.on('connection', (ws, req) => {
      const clientId = this.generateClientId();
      const client = {
        id: clientId,
        ws,
        ip: req.socket.remoteAddress,
        subscriptions: new Set(),
        connectedAt: Date.now()
      };
      
      this.clients.add(client);
      this.stats.connectedClients++;
      
      logger.info(`Client connected: ${clientId}`);
      
      // Send initial data
      this.sendInitialData(client);
      
      // Handle messages
      ws.on('message', (message) => {
        this.handleClientMessage(client, message);
      });
      
      // Handle disconnect
      ws.on('close', () => {
        this.clients.delete(client);
        this.stats.connectedClients--;
        logger.info(`Client disconnected: ${clientId}`);
      });
    });
  }
  
  /**
   * Send initial data to client
   */
  sendInitialData(client) {
    // Send current metrics
    const metrics = {};
    for (const [id, metric] of this.metrics) {
      metrics[id] = {
        ...metric,
        history: this.getMetricHistory(id, TimeFrame.HOUR)
      };
    }
    
    client.ws.send(JSON.stringify({
      type: 'initial',
      data: {
        metrics,
        alerts: Array.from(this.alerts.values()),
        predictions: Array.from(this.predictions.values()),
        systemInfo: this.getSystemInfo()
      }
    }));
  }
  
  /**
   * Handle client message
   */
  handleClientMessage(client, message) {
    try {
      const msg = JSON.parse(message);
      
      switch (msg.type) {
        case 'subscribe':
          this.handleSubscribe(client, msg.data);
          break;
          
        case 'unsubscribe':
          this.handleUnsubscribe(client, msg.data);
          break;
          
        case 'query':
          this.handleQuery(client, msg.data);
          break;
          
        case 'alert':
          this.handleAlertConfig(client, msg.data);
          break;
      }
    } catch (error) {
      logger.error('Invalid client message:', error);
    }
  }
  
  /**
   * Collect real-time data
   */
  async collectRealtimeData() {
    const timestamp = Date.now();
    
    // Pool metrics
    const poolStats = this.pool.getStats();
    this.updateMetric('pool_hashrate', poolStats.poolHashrate, timestamp);
    this.updateMetric('network_hashrate', poolStats.networkHashrate, timestamp);
    
    // Profitability metrics
    const profitability = await this.calculateProfitability();
    this.updateMetric('btc_per_th_day', profitability.btcPerThDay, timestamp);
    this.updateMetric('usd_per_th_day', profitability.usdPerThDay, timestamp);
    
    // Efficiency metrics
    const efficiency = await this.calculateEfficiency();
    this.updateMetric('power_efficiency', efficiency.powerEfficiency, timestamp);
    this.updateMetric('share_efficiency', efficiency.shareEfficiency, timestamp);
    
    // Revenue metrics
    const revenue = await this.calculateRevenue();
    this.updateMetric('daily_revenue', revenue.daily, timestamp);
    this.updateMetric('mining_rewards', revenue.rewards, timestamp);
    
    // DeFi metrics
    if (this.pool.defi) {
      const defiStats = this.pool.defi.getStats();
      this.updateMetric('defi_apy', defiStats.averageAPY || 0, timestamp);
      this.updateMetric('liquidity_deployed', defiStats.totalLiquidityUSD || 0, timestamp);
    }
    
    // Cost metrics
    const costs = await this.calculateCosts();
    this.updateMetric('electricity_cost', costs.electricity, timestamp);
    this.updateMetric('maintenance_cost', costs.maintenance, timestamp);
    
    // Check alerts
    this.checkAlerts();
    
    // Broadcast updates
    this.broadcastUpdates();
  }
  
  /**
   * Update metric
   */
  updateMetric(metricId, value, timestamp = Date.now()) {
    const metric = this.metrics.get(metricId);
    if (!metric) return;
    
    // Update current value
    metric.currentValue = value;
    metric.lastUpdate = timestamp;
    
    // Update time series
    const series = this.timeSeries.get(metricId);
    series.data.push({ timestamp, value });
    
    // Clean old data
    const retention = timestamp - this.config.metricsRetention;
    series.data = series.data.filter(d => d.timestamp > retention);
    
    this.stats.dataPoints++;
    
    // Update aggregates
    this.updateAggregates(metricId);
  }
  
  /**
   * Update aggregates for different time frames
   */
  updateAggregates(metricId) {
    const series = this.timeSeries.get(metricId);
    const metric = this.metrics.get(metricId);
    const now = Date.now();
    
    for (const [frame, duration] of Object.entries({
      [TimeFrame.MINUTE_5]: 5 * 60 * 1000,
      [TimeFrame.MINUTE_15]: 15 * 60 * 1000,
      [TimeFrame.HOUR]: 60 * 60 * 1000,
      [TimeFrame.DAY]: 24 * 60 * 60 * 1000,
      [TimeFrame.WEEK]: 7 * 24 * 60 * 60 * 1000
    })) {
      const cutoff = now - duration;
      const data = series.data.filter(d => d.timestamp > cutoff);
      
      if (data.length === 0) continue;
      
      const aggregate = this.calculateAggregate(data, metric.aggregation);
      series.aggregates.set(frame, aggregate);
    }
  }
  
  /**
   * Calculate aggregate value
   */
  calculateAggregate(data, aggregation) {
    const values = data.map(d => d.value);
    
    switch (aggregation) {
      case 'average':
        return values.reduce((a, b) => a + b, 0) / values.length;
        
      case 'sum':
        return values.reduce((a, b) => a + b, 0);
        
      case 'min':
        return Math.min(...values);
        
      case 'max':
        return Math.max(...values);
        
      default:
        return values[values.length - 1]; // Last value
    }
  }
  
  /**
   * Calculate profitability
   */
  async calculateProfitability() {
    const poolHashrate = this.pool.getPoolHashrate();
    const networkDifficulty = this.pool.networkDifficulty;
    const blockReward = 6.25; // BTC
    const btcPrice = await this.getBTCPrice();
    
    // Calculate expected BTC per TH/day
    const blocksPerDay = 144;
    const networkHashrate = networkDifficulty * 2**32 / 600; // 10 min blocks
    const poolShare = poolHashrate / networkHashrate;
    const btcPerDay = blocksPerDay * blockReward * poolShare;
    const btcPerThDay = btcPerDay / (poolHashrate / 1e12); // Convert to TH
    
    return {
      btcPerThDay,
      usdPerThDay: btcPerThDay * btcPrice,
      poolShare: poolShare * 100,
      expectedDailyRevenue: btcPerDay * btcPrice
    };
  }
  
  /**
   * Calculate efficiency
   */
  async calculateEfficiency() {
    const miners = this.pool.getConnectedMiners();
    let totalPower = 0;
    let totalHashrate = 0;
    let validShares = 0;
    let totalShares = 0;
    
    for (const miner of miners) {
      totalPower += miner.power || 0;
      totalHashrate += miner.hashrate || 0;
      validShares += miner.validShares || 0;
      totalShares += (miner.validShares || 0) + (miner.invalidShares || 0);
    }
    
    return {
      powerEfficiency: totalHashrate > 0 ? totalPower / (totalHashrate / 1e12) : 0,
      shareEfficiency: totalShares > 0 ? (validShares / totalShares) * 100 : 0,
      averageEfficiency: miners.length > 0 ? totalHashrate / miners.length : 0
    };
  }
  
  /**
   * Calculate revenue
   */
  async calculateRevenue() {
    const profitability = await this.calculateProfitability();
    const poolHashrate = this.pool.getPoolHashrate();
    
    // Daily mining revenue
    const dailyBTC = (poolHashrate / 1e12) * profitability.btcPerThDay;
    const btcPrice = await this.getBTCPrice();
    const dailyUSD = dailyBTC * btcPrice;
    
    // Add DeFi revenue if enabled
    let defiRevenue = 0;
    if (this.pool.defi) {
      const defiStats = this.pool.defi.getStats();
      defiRevenue = defiStats.totalProfitUSD / 365; // Daily average
    }
    
    return {
      daily: dailyUSD + defiRevenue,
      rewards: dailyBTC,
      defi: defiRevenue,
      total: dailyUSD + defiRevenue
    };
  }
  
  /**
   * Calculate costs
   */
  async calculateCosts() {
    const miners = this.pool.getConnectedMiners();
    const electricityRate = 0.10; // $0.10 per kWh
    
    let totalPower = 0;
    for (const miner of miners) {
      totalPower += miner.power || 0;
    }
    
    // Daily electricity cost
    const dailyElectricity = (totalPower / 1000) * 24 * electricityRate;
    
    // Estimated maintenance (2% of revenue)
    const revenue = await this.calculateRevenue();
    const dailyMaintenance = revenue.daily * 0.02;
    
    return {
      electricity: dailyElectricity,
      maintenance: dailyMaintenance,
      total: dailyElectricity + dailyMaintenance
    };
  }
  
  /**
   * Generate predictions
   */
  async generatePredictions() {
    if (!this.config.predictiveAnalytics) return;
    
    // Hashrate prediction
    const hashrateHistory = this.getMetricHistory('pool_hashrate', TimeFrame.DAY);
    const hashratePrediction = this.predictTimeSeries(hashrateHistory, 24); // 24 hours
    
    this.predictions.set('hashrate_24h', {
      metric: 'pool_hashrate',
      horizon: '24h',
      predictions: hashratePrediction,
      confidence: 0.85,
      generatedAt: Date.now()
    });
    
    // Profitability prediction
    const profitHistory = this.getMetricHistory('usd_per_th_day', TimeFrame.WEEK);
    const profitPrediction = this.predictTimeSeries(profitHistory, 7); // 7 days
    
    this.predictions.set('profitability_7d', {
      metric: 'usd_per_th_day',
      horizon: '7d',
      predictions: profitPrediction,
      confidence: 0.75,
      generatedAt: Date.now()
    });
    
    // Revenue prediction
    const revenueHistory = this.getMetricHistory('daily_revenue', TimeFrame.MONTH);
    const revenuePrediction = this.predictTimeSeries(revenueHistory, 30); // 30 days
    
    this.predictions.set('revenue_30d', {
      metric: 'daily_revenue',
      horizon: '30d',
      predictions: revenuePrediction,
      confidence: 0.70,
      generatedAt: Date.now()
    });
  }
  
  /**
   * Predict time series using simple linear regression
   */
  predictTimeSeries(history, periods) {
    if (history.length < 10) return [];
    
    // Calculate trend
    const n = history.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += history[i].value;
      sumXY += i * history[i].value;
      sumX2 += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Generate predictions
    const predictions = [];
    const lastTimestamp = history[history.length - 1].timestamp;
    const interval = history.length > 1 ? 
      (history[history.length - 1].timestamp - history[0].timestamp) / (n - 1) : 
      3600000; // 1 hour default
    
    for (let i = 0; i < periods; i++) {
      const value = intercept + slope * (n + i);
      const timestamp = lastTimestamp + (i + 1) * interval;
      
      predictions.push({
        timestamp,
        value: Math.max(0, value), // Ensure non-negative
        confidence: Math.max(0.5, 0.9 - i * 0.01) // Confidence decreases over time
      });
    }
    
    return predictions;
  }
  
  /**
   * Check alerts
   */
  checkAlerts() {
    // Hashrate drop alert
    const poolHashrate = this.metrics.get('pool_hashrate').currentValue;
    const hashrate1hAgo = this.getMetricValueAt('pool_hashrate', Date.now() - 3600000);
    
    if (hashrate1hAgo && poolHashrate < hashrate1hAgo * 0.9) {
      this.createAlert({
        id: 'hashrate_drop',
        severity: 'warning',
        title: 'Hashrate Drop Detected',
        message: `Pool hashrate dropped by ${Math.round((1 - poolHashrate/hashrate1hAgo) * 100)}%`,
        metric: 'pool_hashrate',
        threshold: hashrate1hAgo * 0.9,
        currentValue: poolHashrate
      });
    }
    
    // Low profitability alert
    const profitability = this.metrics.get('usd_per_th_day').currentValue;
    if (profitability < 5) { // $5 per TH/day threshold
      this.createAlert({
        id: 'low_profitability',
        severity: 'info',
        title: 'Low Profitability',
        message: `Current profitability is ${profitability.toFixed(2)} USD per TH/day`,
        metric: 'usd_per_th_day',
        threshold: 5,
        currentValue: profitability
      });
    }
    
    // High power consumption alert
    const powerEfficiency = this.metrics.get('power_efficiency').currentValue;
    if (powerEfficiency > 35) { // 35 W/TH threshold
      this.createAlert({
        id: 'high_power',
        severity: 'warning',
        title: 'High Power Consumption',
        message: `Power efficiency is ${powerEfficiency.toFixed(1)} W/TH`,
        metric: 'power_efficiency',
        threshold: 35,
        currentValue: powerEfficiency
      });
    }
  }
  
  /**
   * Create alert
   */
  createAlert(alert) {
    const existing = this.alerts.get(alert.id);
    
    // Don't recreate if already active
    if (existing && existing.status === 'active') {
      return;
    }
    
    const fullAlert = {
      ...alert,
      status: 'active',
      createdAt: Date.now(),
      acknowledgedAt: null
    };
    
    this.alerts.set(alert.id, fullAlert);
    this.stats.activeAlerts++;
    
    // Broadcast to clients
    this.broadcast({
      type: 'alert',
      data: fullAlert
    });
    
    logger.warn(`Alert created: ${alert.title}`);
    this.emit('alert:created', fullAlert);
  }
  
  /**
   * Get metric history
   */
  getMetricHistory(metricId, timeFrame) {
    const series = this.timeSeries.get(metricId);
    if (!series) return [];
    
    const now = Date.now();
    const duration = this.getTimeFrameDuration(timeFrame);
    const cutoff = now - duration;
    
    return series.data.filter(d => d.timestamp > cutoff);
  }
  
  /**
   * Get metric value at specific time
   */
  getMetricValueAt(metricId, timestamp) {
    const series = this.timeSeries.get(metricId);
    if (!series) return null;
    
    // Find closest data point
    let closest = null;
    let minDiff = Infinity;
    
    for (const point of series.data) {
      const diff = Math.abs(point.timestamp - timestamp);
      if (diff < minDiff) {
        minDiff = diff;
        closest = point;
      }
    }
    
    return closest ? closest.value : null;
  }
  
  /**
   * Get time frame duration
   */
  getTimeFrameDuration(timeFrame) {
    const durations = {
      [TimeFrame.REALTIME]: 60000,           // 1 minute
      [TimeFrame.MINUTE_5]: 5 * 60000,      // 5 minutes
      [TimeFrame.MINUTE_15]: 15 * 60000,    // 15 minutes
      [TimeFrame.HOUR]: 3600000,            // 1 hour
      [TimeFrame.DAY]: 86400000,            // 1 day
      [TimeFrame.WEEK]: 604800000,          // 1 week
      [TimeFrame.MONTH]: 2592000000         // 30 days
    };
    
    return durations[timeFrame] || 3600000;
  }
  
  /**
   * Broadcast to all clients
   */
  broadcast(message) {
    const data = JSON.stringify(message);
    
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }
  
  /**
   * Broadcast updates
   */
  broadcastUpdates() {
    // Prepare update data
    const updates = {};
    
    for (const [id, metric] of this.metrics) {
      updates[id] = {
        currentValue: metric.currentValue,
        lastUpdate: metric.lastUpdate
      };
    }
    
    this.broadcast({
      type: 'update',
      data: {
        metrics: updates,
        timestamp: Date.now()
      }
    });
  }
  
  /**
   * Get system info
   */
  getSystemInfo() {
    return {
      poolName: this.pool.config.name,
      version: '1.0.0',
      uptime: process.uptime(),
      connectedMiners: this.pool.getConnectedMiners().length,
      features: {
        defi: !!this.pool.defi,
        ml: !!this.pool.mlOptimizer,
        privacy: !!this.pool.privacy,
        governance: !!this.pool.governance
      }
    };
  }
  
  /**
   * Helper methods
   */
  async getBTCPrice() {
    // Mock BTC price
    return 45000 + Math.random() * 5000;
  }
  
  generateClientId() {
    return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  handleSubscribe(client, data) {
    const { metrics = [], timeFrame = TimeFrame.REALTIME } = data;
    
    for (const metricId of metrics) {
      client.subscriptions.add(`${metricId}:${timeFrame}`);
    }
    
    // Send current data for subscribed metrics
    const response = {};
    for (const metricId of metrics) {
      const history = this.getMetricHistory(metricId, timeFrame);
      response[metricId] = history;
    }
    
    client.ws.send(JSON.stringify({
      type: 'subscription',
      data: response
    }));
  }
  
  handleUnsubscribe(client, data) {
    const { metrics = [] } = data;
    
    for (const metricId of metrics) {
      for (const sub of client.subscriptions) {
        if (sub.startsWith(metricId)) {
          client.subscriptions.delete(sub);
        }
      }
    }
  }
  
  handleQuery(client, data) {
    const { metric, timeFrame, aggregation } = data;
    
    const series = this.timeSeries.get(metric);
    if (!series) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Metric not found'
      }));
      return;
    }
    
    const aggregate = series.aggregates.get(timeFrame);
    const history = this.getMetricHistory(metric, timeFrame);
    
    client.ws.send(JSON.stringify({
      type: 'query_result',
      data: {
        metric,
        timeFrame,
        aggregate,
        history
      }
    }));
  }
  
  handleAlertConfig(client, data) {
    const { action, alertId } = data;
    
    if (action === 'acknowledge') {
      const alert = this.alerts.get(alertId);
      if (alert) {
        alert.status = 'acknowledged';
        alert.acknowledgedAt = Date.now();
        this.stats.activeAlerts--;
      }
    }
  }
  
  /**
   * Start cycles
   */
  startDataCollection() {
    setInterval(() => {
      this.collectRealtimeData();
    }, this.config.updateInterval);
  }
  
  startAnalytics() {
    // Generate predictions every hour
    setInterval(() => {
      this.generatePredictions();
    }, 3600000);
    
    // Initial prediction
    setTimeout(() => {
      this.generatePredictions();
    }, 60000); // After 1 minute of data collection
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      metrics: this.metrics.size,
      alerts: this.alerts.size,
      predictions: this.predictions.size,
      clients: this.clients.size
    };
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    logger.info('Shutting down dashboard...');
    
    // Close WebSocket connections
    for (const client of this.clients) {
      client.ws.close();
    }
    
    // Close server
    if (this.wsServer) {
      this.wsServer.close();
    }
    
    this.removeAllListeners();
    logger.info('Dashboard shutdown complete');
  }
}

export default {
  RealtimeDashboard,
  MetricType,
  TimeFrame
};