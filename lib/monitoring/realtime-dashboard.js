/**
 * Real-time Mining Pool Monitoring Dashboard
 * WebSocket-based live monitoring with comprehensive metrics visualization
 * 
 * Features:
 * - Real-time hashrate monitoring
 * - Active miner tracking
 * - Share submission rates
 * - Payment statistics
 * - Network difficulty tracking
 * - System resource monitoring
 * - Alert notifications
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const express = require('express');
const path = require('path');
const { createLogger } = require('../core/logger');

const logger = createLogger('dashboard');

// Dashboard update intervals
const UPDATE_INTERVALS = {
  hashrate: 5000,      // 5 seconds
  miners: 10000,       // 10 seconds
  payments: 30000,     // 30 seconds
  system: 15000,       // 15 seconds
  network: 60000,      // 1 minute
  alerts: 2000         // 2 seconds
};

// Alert severity levels
const AlertSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical'
};

// Alert types
const AlertType = {
  HIGH_REJECT_RATE: 'high_reject_rate',
  LOW_HASHRATE: 'low_hashrate',
  PAYMENT_DELAYED: 'payment_delayed',
  SYSTEM_OVERLOAD: 'system_overload',
  NETWORK_ISSUE: 'network_issue',
  BLOCK_FOUND: 'block_found',
  LARGE_PAYMENT: 'large_payment'
};

class MetricsCollector {
  constructor(pool, database) {
    this.pool = pool;
    this.database = database;
    this.cache = new Map();
    this.history = {
      hashrate: [],
      miners: [],
      shares: [],
      blocks: []
    };
  }

  async collectHashrateMetrics() {
    const metrics = {
      timestamp: Date.now(),
      total: 0,
      byAlgorithm: {},
      byMiner: {},
      average: 0
    };

    // Get active miners
    const miners = this.pool.getActiveMiners();
    
    for (const miner of miners) {
      const hashrate = miner.getHashrate();
      metrics.total += hashrate;
      
      // By algorithm
      if (!metrics.byAlgorithm[miner.algorithm]) {
        metrics.byAlgorithm[miner.algorithm] = 0;
      }
      metrics.byAlgorithm[miner.algorithm] += hashrate;
      
      // Top miners
      if (hashrate > 0) {
        metrics.byMiner[miner.id] = {
          hashrate,
          algorithm: miner.algorithm,
          shares: miner.validShares
        };
      }
    }

    metrics.average = miners.length > 0 ? metrics.total / miners.length : 0;
    
    // Add to history
    this.history.hashrate.push(metrics);
    if (this.history.hashrate.length > 288) { // Keep 24 hours at 5 min intervals
      this.history.hashrate.shift();
    }

    return metrics;
  }

  async collectMinerMetrics() {
    const metrics = {
      timestamp: Date.now(),
      total: 0,
      active: 0,
      byAlgorithm: {},
      newMiners: 0,
      disconnected: 0
    };

    const miners = this.pool.getAllMiners();
    const activeCutoff = Date.now() - 600000; // 10 minutes

    for (const miner of miners) {
      metrics.total++;
      
      if (miner.lastShare > activeCutoff) {
        metrics.active++;
        
        if (!metrics.byAlgorithm[miner.algorithm]) {
          metrics.byAlgorithm[miner.algorithm] = 0;
        }
        metrics.byAlgorithm[miner.algorithm]++;
      }
      
      // Track new miners (connected in last hour)
      if (miner.connectedAt > Date.now() - 3600000) {
        metrics.newMiners++;
      }
    }

    // Calculate disconnected (from cache)
    const lastMetrics = this.cache.get('miners');
    if (lastMetrics) {
      metrics.disconnected = Math.max(0, lastMetrics.active - metrics.active);
    }

    this.cache.set('miners', metrics);
    return metrics;
  }

  async collectShareMetrics() {
    const metrics = {
      timestamp: Date.now(),
      submitted: 0,
      accepted: 0,
      rejected: 0,
      rate: 0,
      difficulty: {},
      rejectReasons: {}
    };

    // Get recent shares (last 5 minutes)
    const recentShares = await this.database.getRecentShares(300000);
    
    metrics.submitted = recentShares.length;
    metrics.accepted = recentShares.filter(s => s.valid).length;
    metrics.rejected = metrics.submitted - metrics.accepted;
    metrics.rate = metrics.submitted / 5; // Per minute

    // Analyze rejections
    for (const share of recentShares) {
      if (!share.valid) {
        const reason = share.reason || 'unknown';
        metrics.rejectReasons[reason] = (metrics.rejectReasons[reason] || 0) + 1;
      }
      
      // Track difficulty distribution
      const diff = share.difficulty;
      const bucket = Math.floor(Math.log2(diff));
      metrics.difficulty[bucket] = (metrics.difficulty[bucket] || 0) + 1;
    }

    return metrics;
  }

  async collectPaymentMetrics() {
    const metrics = {
      timestamp: Date.now(),
      pending: 0,
      processed: 0,
      total: 0,
      lastPayout: null,
      nextPayout: null,
      balances: {}
    };

    // Get payment stats
    const paymentStats = await this.database.getPaymentStats();
    
    metrics.pending = paymentStats.pendingAmount;
    metrics.processed = paymentStats.processedToday;
    metrics.total = paymentStats.totalPaid;
    metrics.lastPayout = paymentStats.lastPayoutTime;
    
    // Calculate next payout
    if (metrics.lastPayout) {
      metrics.nextPayout = metrics.lastPayout + this.pool.config.payoutInterval;
    }

    // Get top balances
    const topBalances = await this.database.getTopBalances(10);
    for (const balance of topBalances) {
      metrics.balances[balance.address] = balance.amount;
    }

    return metrics;
  }

  async collectSystemMetrics() {
    const metrics = {
      timestamp: Date.now(),
      cpu: process.cpuUsage(),
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      connections: {
        stratum: this.pool.getConnectionCount(),
        websocket: 0, // Will be set by dashboard
        database: await this.database.getConnectionStats()
      },
      queues: {
        shares: this.pool.shareQueue?.size || 0,
        payments: this.pool.paymentQueue?.size || 0
      }
    };

    // Calculate percentages
    const totalMem = require('os').totalmem();
    metrics.memory.percentage = (metrics.memory.rss / totalMem) * 100;

    return metrics;
  }

  async collectNetworkMetrics() {
    const metrics = {
      timestamp: Date.now(),
      difficulty: {},
      blockHeight: {},
      networkHashrate: {},
      lastBlocks: []
    };

    // Get network stats for each coin
    for (const coin of this.pool.getSupportedCoins()) {
      const stats = await this.pool.getNetworkStats(coin);
      
      metrics.difficulty[coin] = stats.difficulty;
      metrics.blockHeight[coin] = stats.height;
      metrics.networkHashrate[coin] = stats.networkHashrate;
    }

    // Get recent blocks found
    metrics.lastBlocks = await this.database.getRecentBlocks(10);

    return metrics;
  }

  getHistoricalData(metric, duration) {
    const history = this.history[metric] || [];
    const cutoff = Date.now() - duration;
    
    return history.filter(entry => entry.timestamp > cutoff);
  }
}

class AlertManager extends EventEmitter {
  constructor() {
    super();
    this.alerts = [];
    this.conditions = new Map();
    this.notificationQueue = [];
    
    this.setupDefaultConditions();
  }

  setupDefaultConditions() {
    // High reject rate
    this.addCondition({
      id: 'high_reject_rate',
      type: AlertType.HIGH_REJECT_RATE,
      check: (metrics) => {
        const rejectRate = metrics.shares.rejected / metrics.shares.submitted;
        return rejectRate > 0.05; // 5%
      },
      severity: AlertSeverity.WARNING,
      message: (metrics) => {
        const rate = ((metrics.shares.rejected / metrics.shares.submitted) * 100).toFixed(2);
        return `High reject rate detected: ${rate}%`;
      }
    });

    // Low hashrate
    this.addCondition({
      id: 'low_hashrate',
      type: AlertType.LOW_HASHRATE,
      check: (metrics) => {
        const history = metrics.hashrateHistory || [];
        if (history.length < 2) return false;
        
        const current = history[history.length - 1].total;
        const average = history.slice(-6).reduce((sum, h) => sum + h.total, 0) / 6;
        
        return current < average * 0.7; // 30% drop
      },
      severity: AlertSeverity.WARNING,
      message: (metrics) => 'Hashrate dropped significantly below average'
    });

    // System overload
    this.addCondition({
      id: 'system_overload',
      type: AlertType.SYSTEM_OVERLOAD,
      check: (metrics) => {
        return metrics.system.memory.percentage > 90 ||
               metrics.system.queues.shares > 10000;
      },
      severity: AlertSeverity.ERROR,
      message: (metrics) => 'System resources under heavy load'
    });

    // Block found
    this.addCondition({
      id: 'block_found',
      type: AlertType.BLOCK_FOUND,
      check: (metrics) => {
        return metrics.newBlockFound === true;
      },
      severity: AlertSeverity.INFO,
      message: (metrics) => `New block found! Height: ${metrics.blockHeight}`
    });
  }

  addCondition(condition) {
    this.conditions.set(condition.id, condition);
  }

  removeCondition(id) {
    this.conditions.delete(id);
  }

  checkConditions(metrics) {
    const newAlerts = [];
    
    for (const [id, condition] of this.conditions) {
      try {
        if (condition.check(metrics)) {
          const alert = {
            id: `${id}_${Date.now()}`,
            type: condition.type,
            severity: condition.severity,
            message: typeof condition.message === 'function' 
              ? condition.message(metrics) 
              : condition.message,
            timestamp: Date.now(),
            acknowledged: false
          };
          
          newAlerts.push(alert);
          this.alerts.push(alert);
          
          // Emit alert event
          this.emit('alert', alert);
        }
      } catch (error) {
        logger.error(`Error checking condition ${id}:`, error);
      }
    }
    
    // Clean old alerts (keep last 100)
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(-100);
    }
    
    return newAlerts;
  }

  getActiveAlerts() {
    const cutoff = Date.now() - 3600000; // 1 hour
    return this.alerts.filter(a => !a.acknowledged && a.timestamp > cutoff);
  }

  acknowledgeAlert(alertId) {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      alert.acknowledgedAt = Date.now();
      return true;
    }
    return false;
  }
}

class RealtimeDashboard extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      port: options.port || 8080,
      host: options.host || 'localhost',
      updateIntervals: { ...UPDATE_INTERVALS, ...(options.updateIntervals || {}) },
      enableAlerts: options.enableAlerts !== false,
      enableHistory: options.enableHistory !== false,
      maxConnections: options.maxConnections || 100,
      authRequired: options.authRequired || false,
      ...options
    };
    
    this.pool = options.pool;
    this.database = options.database;
    
    // Components
    this.metricsCollector = new MetricsCollector(this.pool, this.database);
    this.alertManager = new AlertManager();
    
    // WebSocket server
    this.wss = null;
    this.clients = new Map();
    
    // Express app for static files
    this.app = express();
    this.server = null;
    
    // Update timers
    this.updateTimers = {};
    
    // Current metrics cache
    this.currentMetrics = {
      hashrate: {},
      miners: {},
      shares: {},
      payments: {},
      system: {},
      network: {}
    };
    
    this.setupExpress();
    this.setupWebSocket();
  }

  setupExpress() {
    // Serve static files
    this.app.use(express.static(path.join(__dirname, '../../public/dashboard')));
    
    // API endpoints
    this.app.get('/api/metrics/:type', async (req, res) => {
      const type = req.params.type;
      if (this.currentMetrics[type]) {
        res.json(this.currentMetrics[type]);
      } else {
        res.status(404).json({ error: 'Metric type not found' });
      }
    });
    
    this.app.get('/api/history/:metric', async (req, res) => {
      const metric = req.params.metric;
      const duration = parseInt(req.query.duration) || 3600000; // 1 hour default
      
      const history = this.metricsCollector.getHistoricalData(metric, duration);
      res.json(history);
    });
    
    this.app.get('/api/alerts', (req, res) => {
      res.json(this.alertManager.getActiveAlerts());
    });
    
    this.app.post('/api/alerts/:id/acknowledge', (req, res) => {
      const success = this.alertManager.acknowledgeAlert(req.params.id);
      res.json({ success });
    });
  }

  setupWebSocket() {
    this.server = this.app.listen(this.config.port, this.config.host, () => {
      logger.info(`Dashboard HTTP server listening on ${this.config.host}:${this.config.port}`);
    });
    
    this.wss = new WebSocket.Server({ server: this.server });
    
    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });
    
    this.wss.on('error', (error) => {
      logger.error('WebSocket server error:', error);
    });
  }

  handleConnection(ws, req) {
    const clientId = Math.random().toString(36).substr(2, 9);
    const client = {
      id: clientId,
      ws,
      subscriptions: new Set(['all']), // Subscribe to all by default
      authenticated: !this.config.authRequired,
      connectedAt: Date.now()
    };
    
    this.clients.set(clientId, client);
    logger.info(`Dashboard client connected: ${clientId}`);
    
    // Send initial data
    this.sendInitialData(client);
    
    // Handle messages
    ws.on('message', (message) => {
      this.handleClientMessage(client, message);
    });
    
    ws.on('close', () => {
      this.clients.delete(clientId);
      logger.info(`Dashboard client disconnected: ${clientId}`);
    });
    
    ws.on('error', (error) => {
      logger.error(`Client ${clientId} WebSocket error:`, error);
    });
  }

  handleClientMessage(client, message) {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'subscribe':
          client.subscriptions.add(data.channel);
          break;
          
        case 'unsubscribe':
          client.subscriptions.delete(data.channel);
          break;
          
        case 'auth':
          if (this.config.authRequired) {
            // Implement authentication logic
            client.authenticated = this.authenticate(data.token);
          }
          break;
          
        case 'command':
          this.handleCommand(client, data.command, data.params);
          break;
      }
    } catch (error) {
      logger.error('Error handling client message:', error);
    }
  }

  async sendInitialData(client) {
    // Send current metrics
    for (const [type, metrics] of Object.entries(this.currentMetrics)) {
      if (metrics.timestamp) {
        this.sendToClient(client, {
          type: 'metrics',
          metric: type,
          data: metrics
        });
      }
    }
    
    // Send active alerts
    if (this.config.enableAlerts) {
      this.sendToClient(client, {
        type: 'alerts',
        data: this.alertManager.getActiveAlerts()
      });
    }
  }

  sendToClient(client, data) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(data));
    }
  }

  broadcast(data, channel = 'all') {
    for (const [id, client] of this.clients) {
      if (client.subscriptions.has(channel) || client.subscriptions.has('all')) {
        this.sendToClient(client, data);
      }
    }
  }

  async start() {
    // Start metric collection
    this.startMetricCollection();
    
    // Start alert monitoring
    if (this.config.enableAlerts) {
      this.startAlertMonitoring();
    }
    
    this.emit('started', {
      url: `http://${this.config.host}:${this.config.port}`
    });
  }

  startMetricCollection() {
    // Hashrate updates
    this.updateTimers.hashrate = setInterval(async () => {
      try {
        const metrics = await this.metricsCollector.collectHashrateMetrics();
        this.currentMetrics.hashrate = metrics;
        
        this.broadcast({
          type: 'metrics',
          metric: 'hashrate',
          data: metrics
        }, 'hashrate');
      } catch (error) {
        logger.error('Error collecting hashrate metrics:', error);
      }
    }, this.config.updateIntervals.hashrate);
    
    // Miner updates
    this.updateTimers.miners = setInterval(async () => {
      try {
        const metrics = await this.metricsCollector.collectMinerMetrics();
        this.currentMetrics.miners = metrics;
        
        this.broadcast({
          type: 'metrics',
          metric: 'miners',
          data: metrics
        }, 'miners');
      } catch (error) {
        logger.error('Error collecting miner metrics:', error);
      }
    }, this.config.updateIntervals.miners);
    
    // Share updates
    this.updateTimers.shares = setInterval(async () => {
      try {
        const metrics = await this.metricsCollector.collectShareMetrics();
        this.currentMetrics.shares = metrics;
        
        this.broadcast({
          type: 'metrics',
          metric: 'shares',
          data: metrics
        }, 'shares');
      } catch (error) {
        logger.error('Error collecting share metrics:', error);
      }
    }, this.config.updateIntervals.hashrate);
    
    // Payment updates
    this.updateTimers.payments = setInterval(async () => {
      try {
        const metrics = await this.metricsCollector.collectPaymentMetrics();
        this.currentMetrics.payments = metrics;
        
        this.broadcast({
          type: 'metrics',
          metric: 'payments',
          data: metrics
        }, 'payments');
      } catch (error) {
        logger.error('Error collecting payment metrics:', error);
      }
    }, this.config.updateIntervals.payments);
    
    // System updates
    this.updateTimers.system = setInterval(async () => {
      try {
        const metrics = await this.metricsCollector.collectSystemMetrics();
        metrics.connections.websocket = this.clients.size;
        this.currentMetrics.system = metrics;
        
        this.broadcast({
          type: 'metrics',
          metric: 'system',
          data: metrics
        }, 'system');
      } catch (error) {
        logger.error('Error collecting system metrics:', error);
      }
    }, this.config.updateIntervals.system);
    
    // Network updates
    this.updateTimers.network = setInterval(async () => {
      try {
        const metrics = await this.metricsCollector.collectNetworkMetrics();
        this.currentMetrics.network = metrics;
        
        this.broadcast({
          type: 'metrics',
          metric: 'network',
          data: metrics
        }, 'network');
      } catch (error) {
        logger.error('Error collecting network metrics:', error);
      }
    }, this.config.updateIntervals.network);
  }

  startAlertMonitoring() {
    this.updateTimers.alerts = setInterval(() => {
      const allMetrics = {
        ...this.currentMetrics,
        hashrateHistory: this.metricsCollector.getHistoricalData('hashrate', 3600000)
      };
      
      const newAlerts = this.alertManager.checkConditions(allMetrics);
      
      if (newAlerts.length > 0) {
        this.broadcast({
          type: 'alerts',
          data: newAlerts
        }, 'alerts');
      }
    }, this.config.updateIntervals.alerts);
    
    // Listen for alerts from other components
    this.pool.on('block:found', (block) => {
      this.alertManager.checkConditions({
        newBlockFound: true,
        blockHeight: block.height
      });
    });
  }

  handleCommand(client, command, params) {
    if (!client.authenticated && this.config.authRequired) {
      this.sendToClient(client, {
        type: 'error',
        message: 'Authentication required'
      });
      return;
    }
    
    switch (command) {
      case 'force_update':
        // Force update specific metric
        if (params.metric && this.updateTimers[params.metric]) {
          clearInterval(this.updateTimers[params.metric]);
          this.startMetricCollection(); // Restart collection
        }
        break;
        
      case 'get_miner_details':
        // Get detailed info for specific miner
        const minerDetails = this.pool.getMinerDetails(params.minerId);
        this.sendToClient(client, {
          type: 'miner_details',
          data: minerDetails
        });
        break;
        
      case 'get_block_details':
        // Get detailed info for specific block
        this.database.getBlockDetails(params.blockId).then(details => {
          this.sendToClient(client, {
            type: 'block_details',
            data: details
          });
        });
        break;
    }
  }

  async stop() {
    // Clear all timers
    for (const timer of Object.values(this.updateTimers)) {
      clearInterval(timer);
    }
    
    // Close WebSocket connections
    for (const [id, client] of this.clients) {
      client.ws.close();
    }
    
    // Close servers
    if (this.wss) {
      this.wss.close();
    }
    
    if (this.server) {
      this.server.close();
    }
    
    this.emit('stopped');
  }

  // Add custom alert condition
  addAlertCondition(condition) {
    this.alertManager.addCondition(condition);
  }

  // Get dashboard URL
  getDashboardUrl() {
    return `http://${this.config.host}:${this.config.port}`;
  }

  // Get connection stats
  getStats() {
    return {
      connectedClients: this.clients.size,
      activeAlerts: this.alertManager.getActiveAlerts().length,
      metricsUpdated: Object.keys(this.currentMetrics)
        .filter(k => this.currentMetrics[k].timestamp)
        .length
    };
  }
}

module.exports = RealtimeDashboard;