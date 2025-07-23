const EventEmitter = require('events');
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');

class RealtimePerformanceDashboard extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      port: options.port || 8080,
      updateInterval: options.updateInterval || 1000, // 1 second
      historySize: options.historySize || 3600, // 1 hour of seconds
      
      // Features
      enableWebSocket: options.enableWebSocket !== false,
      enableAPI: options.enableAPI !== false,
      enableMetrics: options.enableMetrics !== false,
      
      // Performance thresholds
      thresholds: {
        hashrate: {
          critical: options.hashrateCritical || 0.8, // 80% of expected
          warning: options.hashrateWarning || 0.9   // 90% of expected
        },
        temperature: {
          critical: options.tempCritical || 85,
          warning: options.tempWarning || 75
        },
        rejectRate: {
          critical: options.rejectCritical || 0.05, // 5%
          warning: options.rejectWarning || 0.02    // 2%
        }
      }
    };
    
    // Data stores
    this.metrics = {
      hashrate: [],
      efficiency: [],
      temperature: [],
      power: [],
      shares: { accepted: 0, rejected: 0, total: 0 },
      revenue: [],
      gpus: new Map(),
      pools: new Map(),
      workers: new Map()
    };
    
    this.alerts = [];
    this.predictions = {};
    
    // Server components
    this.app = null;
    this.server = null;
    this.wss = null;
  }
  
  async start() {
    this.emit('starting');
    
    // Initialize Express app
    this.app = express();
    this.server = http.createServer(this.app);
    
    // Setup middleware
    this.setupMiddleware();
    
    // Setup routes
    this.setupRoutes();
    
    // Setup WebSocket
    if (this.config.enableWebSocket) {
      this.setupWebSocket();
    }
    
    // Start server
    await new Promise((resolve) => {
      this.server.listen(this.config.port, () => {
        console.log(`Dashboard running on http://localhost:${this.config.port}`);
        resolve();
      });
    });
    
    // Start metric collection
    this.startMetricCollection();
    
    // Start analysis
    this.startAnalysis();
    
    this.emit('started');
  }
  
  setupMiddleware() {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '../../public')));
    
    // CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      next();
    });
  }
  
  setupRoutes() {
    // Main dashboard
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../../public/dashboard.html'));
    });
    
    // API endpoints
    this.app.get('/api/metrics', (req, res) => {
      res.json(this.getMetrics());
    });
    
    this.app.get('/api/metrics/:type', (req, res) => {
      const { type } = req.params;
      const { period = '1h' } = req.query;
      res.json(this.getMetricHistory(type, period));
    });
    
    this.app.get('/api/gpus', (req, res) => {
      res.json(this.getGPUStatus());
    });
    
    this.app.get('/api/workers', (req, res) => {
      res.json(this.getWorkerStatus());
    });
    
    this.app.get('/api/pools', (req, res) => {
      res.json(this.getPoolStatus());
    });
    
    this.app.get('/api/alerts', (req, res) => {
      res.json(this.getAlerts());
    });
    
    this.app.get('/api/predictions', (req, res) => {
      res.json(this.getPredictions());
    });
    
    this.app.get('/api/analysis', (req, res) => {
      res.json(this.getAnalysis());
    });
    
    this.app.post('/api/alerts/dismiss/:id', (req, res) => {
      this.dismissAlert(req.params.id);
      res.json({ success: true });
    });
  }
  
  setupWebSocket() {
    this.wss = new WebSocket.Server({ server: this.server });
    
    this.wss.on('connection', (ws) => {
      console.log('New WebSocket connection');
      
      // Send initial data
      ws.send(JSON.stringify({
        type: 'initial',
        data: this.getMetrics()
      }));
      
      // Handle messages
      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          this.handleWebSocketMessage(ws, data);
        } catch (error) {
          console.error('WebSocket message error:', error);
        }
      });
      
      ws.on('close', () => {
        console.log('WebSocket connection closed');
      });
    });
    
    // Broadcast updates
    setInterval(() => {
      this.broadcastUpdate();
    }, this.config.updateInterval);
  }
  
  handleWebSocketMessage(ws, data) {
    switch (data.type) {
      case 'subscribe':
        // Handle subscription to specific metrics
        ws.subscriptions = data.metrics || ['all'];
        break;
        
      case 'command':
        // Handle dashboard commands
        this.handleCommand(data.command, data.params);
        break;
        
      case 'query':
        // Handle custom queries
        const result = this.handleQuery(data.query);
        ws.send(JSON.stringify({
          type: 'query_result',
          id: data.id,
          result
        }));
        break;
    }
  }
  
  broadcastUpdate() {
    const update = {
      type: 'update',
      timestamp: Date.now(),
      data: {
        hashrate: this.getCurrentHashrate(),
        efficiency: this.getCurrentEfficiency(),
        temperature: this.getAverageTemperature(),
        power: this.getCurrentPower(),
        shares: this.metrics.shares,
        revenue: this.getCurrentRevenue(),
        alerts: this.alerts.filter(a => !a.dismissed)
      }
    };
    
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(update));
      }
    });
  }
  
  startMetricCollection() {
    // Collect metrics every second
    this.collectionInterval = setInterval(() => {
      this.collectMetrics();
    }, 1000);
    
    // Collect detailed metrics every minute
    this.detailedInterval = setInterval(() => {
      this.collectDetailedMetrics();
    }, 60000);
  }
  
  async collectMetrics() {
    // Simulate metric collection - in production would interface with actual miners
    const hashrate = await this.collectHashrate();
    const temperature = await this.collectTemperature();
    const power = await this.collectPower();
    const shares = await this.collectShares();
    
    // Add to history
    this.addMetric('hashrate', hashrate);
    this.addMetric('temperature', temperature);
    this.addMetric('power', power);
    
    // Update shares
    this.metrics.shares = shares;
    
    // Calculate efficiency
    const efficiency = shares.total > 0 
      ? (shares.accepted / shares.total) * 100 
      : 100;
    this.addMetric('efficiency', efficiency);
    
    // Check for alerts
    this.checkAlerts({
      hashrate,
      temperature,
      efficiency,
      rejectRate: shares.total > 0 ? shares.rejected / shares.total : 0
    });
  }
  
  async collectDetailedMetrics() {
    // Collect GPU-specific metrics
    const gpus = await this.collectGPUMetrics();
    gpus.forEach((gpu, index) => {
      this.metrics.gpus.set(index, gpu);
    });
    
    // Collect worker metrics
    const workers = await this.collectWorkerMetrics();
    workers.forEach((worker) => {
      this.metrics.workers.set(worker.id, worker);
    });
    
    // Collect pool metrics
    const pools = await this.collectPoolMetrics();
    pools.forEach((pool) => {
      this.metrics.pools.set(pool.id, pool);
    });
    
    // Update revenue
    const revenue = await this.calculateRevenue();
    this.addMetric('revenue', revenue);
  }
  
  addMetric(type, value) {
    if (!this.metrics[type]) {
      this.metrics[type] = [];
    }
    
    this.metrics[type].push({
      timestamp: Date.now(),
      value
    });
    
    // Trim to history size
    if (this.metrics[type].length > this.config.historySize) {
      this.metrics[type].shift();
    }
  }
  
  // Metric collection methods (simulated)
  
  async collectHashrate() {
    // Simulate hashrate collection
    return 45000000 + Math.random() * 5000000; // 45-50 MH/s
  }
  
  async collectTemperature() {
    // Simulate temperature collection
    return 65 + Math.random() * 15; // 65-80°C
  }
  
  async collectPower() {
    // Simulate power collection
    return 150 + Math.random() * 50; // 150-200W
  }
  
  async collectShares() {
    // Simulate share collection
    const accepted = Math.floor(Math.random() * 10) > 1 ? 1 : 0;
    const rejected = Math.random() > 0.98 ? 1 : 0;
    
    return {
      accepted: (this.metrics.shares?.accepted || 0) + accepted,
      rejected: (this.metrics.shares?.rejected || 0) + rejected,
      total: (this.metrics.shares?.total || 0) + accepted + rejected
    };
  }
  
  async collectGPUMetrics() {
    // Simulate GPU metrics
    return [
      {
        index: 0,
        name: 'NVIDIA RTX 3080',
        temperature: 72,
        fanSpeed: 65,
        power: 180,
        memory: 85,
        hashrate: 25000000
      },
      {
        index: 1,
        name: 'NVIDIA RTX 3080',
        temperature: 74,
        fanSpeed: 70,
        power: 185,
        memory: 87,
        hashrate: 25000000
      }
    ];
  }
  
  async collectWorkerMetrics() {
    // Simulate worker metrics
    return [
      {
        id: 'worker-1',
        name: 'Main Rig',
        status: 'online',
        hashrate: 50000000,
        shares: { accepted: 1234, rejected: 12 },
        uptime: 86400
      }
    ];
  }
  
  async collectPoolMetrics() {
    // Simulate pool metrics
    return [
      {
        id: 'pool-1',
        name: 'Otedama P2P',
        connected: true,
        latency: 25,
        difficulty: 4000000000,
        lastShare: Date.now() - 5000
      }
    ];
  }
  
  async calculateRevenue() {
    // Simulate revenue calculation
    const btcPrice = 50000;
    const dailyBTC = 0.00123;
    return dailyBTC * btcPrice;
  }
  
  // Analysis methods
  
  startAnalysis() {
    // Run analysis every 5 minutes
    this.analysisInterval = setInterval(() => {
      this.runAnalysis();
    }, 300000);
    
    // Initial analysis
    this.runAnalysis();
  }
  
  async runAnalysis() {
    // Trend analysis
    this.analyzeTrends();
    
    // Anomaly detection
    this.detectAnomalies();
    
    // Performance predictions
    this.generatePredictions();
    
    // Optimization recommendations
    this.generateRecommendations();
  }
  
  analyzeTrends() {
    // Analyze hashrate trend
    const hashrateTrend = this.calculateTrend('hashrate');
    const efficiencyTrend = this.calculateTrend('efficiency');
    const temperatureTrend = this.calculateTrend('temperature');
    
    this.predictions.trends = {
      hashrate: hashrateTrend,
      efficiency: efficiencyTrend,
      temperature: temperatureTrend
    };
  }
  
  calculateTrend(metric) {
    const data = this.metrics[metric] || [];
    if (data.length < 10) return 'insufficient_data';
    
    // Simple linear regression
    const recent = data.slice(-60); // Last minute
    const values = recent.map(d => d.value);
    
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < values.length; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }
    
    const n = values.length;
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    
    if (slope > 0.01) return 'increasing';
    if (slope < -0.01) return 'decreasing';
    return 'stable';
  }
  
  detectAnomalies() {
    const anomalies = [];
    
    // Check for sudden hashrate drops
    const hashrates = this.metrics.hashrate.slice(-10).map(d => d.value);
    if (hashrates.length > 5) {
      const avg = hashrates.reduce((a, b) => a + b) / hashrates.length;
      const latest = hashrates[hashrates.length - 1];
      
      if (latest < avg * 0.8) {
        anomalies.push({
          type: 'hashrate_drop',
          severity: 'high',
          value: latest,
          expected: avg
        });
      }
    }
    
    // Check for temperature spikes
    const temps = this.metrics.temperature.slice(-5).map(d => d.value);
    if (temps.length > 0) {
      const maxTemp = Math.max(...temps);
      if (maxTemp > this.config.thresholds.temperature.critical) {
        anomalies.push({
          type: 'temperature_spike',
          severity: 'critical',
          value: maxTemp
        });
      }
    }
    
    this.predictions.anomalies = anomalies;
  }
  
  generatePredictions() {
    // Predict next hour hashrate
    const hashrateData = this.metrics.hashrate.slice(-3600);
    if (hashrateData.length > 100) {
      const average = hashrateData.reduce((sum, d) => sum + d.value, 0) / hashrateData.length;
      const trend = this.predictions.trends?.hashrate || 'stable';
      
      let prediction = average;
      if (trend === 'increasing') prediction *= 1.02;
      if (trend === 'decreasing') prediction *= 0.98;
      
      this.predictions.nextHourHashrate = prediction;
    }
    
    // Predict daily revenue
    const revenueData = this.metrics.revenue.slice(-24);
    if (revenueData.length > 0) {
      const dailyRevenue = revenueData.reduce((sum, d) => sum + d.value, 0);
      this.predictions.dailyRevenue = dailyRevenue;
    }
  }
  
  generateRecommendations() {
    const recommendations = [];
    
    // Temperature recommendations
    const currentTemp = this.getAverageTemperature();
    if (currentTemp > this.config.thresholds.temperature.warning) {
      recommendations.push({
        type: 'cooling',
        priority: 'high',
        action: 'Increase fan speed or improve cooling',
        impact: 'Prevent thermal throttling and hardware damage'
      });
    }
    
    // Efficiency recommendations
    const efficiency = this.getCurrentEfficiency();
    if (efficiency < 98) {
      recommendations.push({
        type: 'efficiency',
        priority: 'medium',
        action: 'Check network latency and pool connection',
        impact: 'Improve mining efficiency by ' + (100 - efficiency).toFixed(1) + '%'
      });
    }
    
    // Power optimization
    const powerEfficiency = this.getCurrentHashrate() / this.getCurrentPower();
    if (powerEfficiency < 250000) { // Less than 250KH/W
      recommendations.push({
        type: 'power',
        priority: 'low',
        action: 'Consider undervolting or adjusting power limits',
        impact: 'Reduce electricity costs'
      });
    }
    
    this.predictions.recommendations = recommendations;
  }
  
  checkAlerts(metrics) {
    const now = Date.now();
    
    // Check hashrate
    if (metrics.hashrate < 40000000) { // Expected minimum
      this.addAlert({
        id: `hashrate-${now}`,
        type: 'hashrate',
        severity: 'critical',
        message: 'Hashrate dropped below expected minimum',
        value: metrics.hashrate,
        threshold: 40000000
      });
    }
    
    // Check temperature
    if (metrics.temperature > this.config.thresholds.temperature.critical) {
      this.addAlert({
        id: `temp-${now}`,
        type: 'temperature',
        severity: 'critical',
        message: 'Temperature exceeded critical threshold',
        value: metrics.temperature,
        threshold: this.config.thresholds.temperature.critical
      });
    }
    
    // Check reject rate
    if (metrics.rejectRate > this.config.thresholds.rejectRate.critical) {
      this.addAlert({
        id: `reject-${now}`,
        type: 'reject_rate',
        severity: 'high',
        message: 'High reject rate detected',
        value: metrics.rejectRate * 100,
        threshold: this.config.thresholds.rejectRate.critical * 100
      });
    }
  }
  
  addAlert(alert) {
    alert.timestamp = Date.now();
    alert.dismissed = false;
    
    // Check if similar alert already exists
    const existing = this.alerts.find(a => 
      a.type === alert.type && 
      !a.dismissed &&
      Date.now() - a.timestamp < 300000 // 5 minutes
    );
    
    if (!existing) {
      this.alerts.push(alert);
      this.emit('alert', alert);
      
      // Keep only last 100 alerts
      if (this.alerts.length > 100) {
        this.alerts = this.alerts.slice(-100);
      }
    }
  }
  
  dismissAlert(id) {
    const alert = this.alerts.find(a => a.id === id);
    if (alert) {
      alert.dismissed = true;
    }
  }
  
  // API methods
  
  getMetrics() {
    return {
      hashrate: this.getCurrentHashrate(),
      efficiency: this.getCurrentEfficiency(),
      temperature: this.getAverageTemperature(),
      power: this.getCurrentPower(),
      shares: this.metrics.shares,
      revenue: this.getCurrentRevenue(),
      gpus: Array.from(this.metrics.gpus.values()),
      workers: Array.from(this.metrics.workers.values()),
      pools: Array.from(this.metrics.pools.values())
    };
  }
  
  getMetricHistory(type, period) {
    const data = this.metrics[type] || [];
    const periodMs = this.parsePeriod(period);
    const cutoff = Date.now() - periodMs;
    
    return data.filter(d => d.timestamp > cutoff);
  }
  
  parsePeriod(period) {
    const units = {
      'm': 60000,
      'h': 3600000,
      'd': 86400000
    };
    
    const match = period.match(/(\d+)([mhd])/);
    if (match) {
      return parseInt(match[1]) * units[match[2]];
    }
    
    return 3600000; // Default 1 hour
  }
  
  getCurrentHashrate() {
    const recent = this.metrics.hashrate.slice(-1)[0];
    return recent ? recent.value : 0;
  }
  
  getCurrentEfficiency() {
    const recent = this.metrics.efficiency.slice(-1)[0];
    return recent ? recent.value : 100;
  }
  
  getAverageTemperature() {
    const recent = this.metrics.temperature.slice(-10);
    if (recent.length === 0) return 0;
    
    const sum = recent.reduce((acc, d) => acc + d.value, 0);
    return sum / recent.length;
  }
  
  getCurrentPower() {
    const recent = this.metrics.power.slice(-1)[0];
    return recent ? recent.value : 0;
  }
  
  getCurrentRevenue() {
    const recent = this.metrics.revenue.slice(-1)[0];
    return recent ? recent.value : 0;
  }
  
  getGPUStatus() {
    return Array.from(this.metrics.gpus.values());
  }
  
  getWorkerStatus() {
    return Array.from(this.metrics.workers.values());
  }
  
  getPoolStatus() {
    return Array.from(this.metrics.pools.values());
  }
  
  getAlerts() {
    return this.alerts.filter(a => !a.dismissed);
  }
  
  getPredictions() {
    return this.predictions;
  }
  
  getAnalysis() {
    return {
      trends: this.predictions.trends || {},
      anomalies: this.predictions.anomalies || [],
      recommendations: this.predictions.recommendations || [],
      predictions: {
        nextHourHashrate: this.predictions.nextHourHashrate,
        dailyRevenue: this.predictions.dailyRevenue
      }
    };
  }
  
  handleCommand(command, params) {
    switch (command) {
      case 'reset_metrics':
        this.resetMetrics();
        break;
        
      case 'force_analysis':
        this.runAnalysis();
        break;
        
      case 'export_data':
        return this.exportData();
        
      default:
        console.warn('Unknown command:', command);
    }
  }
  
  handleQuery(query) {
    // Handle custom queries
    try {
      // Simple query parser
      if (query.startsWith('SELECT')) {
        return this.executeSelectQuery(query);
      }
      
      return { error: 'Unsupported query type' };
    } catch (error) {
      return { error: error.message };
    }
  }
  
  executeSelectQuery(query) {
    // Very basic SELECT query handler
    const match = query.match(/SELECT (\w+) FROM (\w+) WHERE (\w+) ([><=]+) ([\d.]+)/i);
    if (!match) {
      return { error: 'Invalid query format' };
    }
    
    const [, field, table, condition, operator, value] = match;
    const data = this.metrics[table] || [];
    const threshold = parseFloat(value);
    
    const results = data.filter(d => {
      switch (operator) {
        case '>': return d.value > threshold;
        case '<': return d.value < threshold;
        case '>=': return d.value >= threshold;
        case '<=': return d.value <= threshold;
        case '=': return d.value === threshold;
        default: return false;
      }
    });
    
    return { results, count: results.length };
  }
  
  resetMetrics() {
    // Reset non-historical metrics
    this.metrics.shares = { accepted: 0, rejected: 0, total: 0 };
    this.alerts = [];
    this.predictions = {};
  }
  
  exportData() {
    return {
      metrics: this.metrics,
      alerts: this.alerts,
      predictions: this.predictions,
      timestamp: Date.now()
    };
  }
  
  stop() {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
    }
    
    if (this.detailedInterval) {
      clearInterval(this.detailedInterval);
    }
    
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
    }
    
    if (this.server) {
      this.server.close();
    }
    
    this.emit('stopped');
  }
}

module.exports = RealtimePerformanceDashboard;