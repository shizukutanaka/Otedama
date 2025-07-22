// Advanced Mining Analytics Dashboard V2
// Real-time monitoring with hardware integration for P2P mining pool operations

import EventEmitter from 'events';
import { createLogger } from '../core/logger.js';
import { WebSocketServer } from 'ws';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger('mining-analytics-dashboard-v2');

export class MiningAnalyticsDashboardV2 extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      httpPort: options.httpPort || 8080,
      wsPort: options.wsPort || 8081,
      updateInterval: options.updateInterval || 1000, // 1 second
      hardwareUpdateInterval: options.hardwareUpdateInterval || 5000, // 5 seconds
      metricsRetention: options.metricsRetention || 86400000, // 24 hours
      alertThresholds: {
        lowHashrate: options.lowHashrateThreshold || 0.9, // 90% of average
        highRejectRate: options.highRejectRateThreshold || 0.05, // 5%
        minerTimeout: options.minerTimeout || 600000, // 10 minutes
        highTemperature: options.highTemperatureThreshold || 80, // 80°C
        lowEfficiency: options.lowEfficiencyThreshold || 0.85, // 85%
        ...options.alertThresholds
      },
      ...options
    };
    
    // Components
    this.app = null;
    this.wsServer = null;
    this.httpServer = null;
    
    // Data storage
    this.metrics = {
      pool: {
        hashrate: [],
        miners: [],
        shares: [],
        blocks: [],
        difficulty: [],
        earnings: [],
        efficiency: []
      },
      miners: new Map(),
      algorithms: new Map(),
      network: {
        nodes: [],
        latency: [],
        bandwidth: [],
        shareValidation: []
      },
      hardware: {
        gpus: new Map(),
        cpus: new Map(),
        asics: new Map(),
        memory: [],
        temperature: [],
        power: [],
        fans: []
      },
      externalMiners: new Map(),
      profitability: {
        current: [],
        predictions: [],
        switches: []
      }
    };
    
    // Alerts
    this.alerts = new Map();
    this.alertHistory = [];
    
    // Clients
    this.wsClients = new Set();
    
    // Performance tracking
    this.performanceMetrics = {
      sharesPerSecond: 0,
      validationTime: 0,
      networkLatency: 0,
      cpuUsage: 0,
      memoryUsage: 0
    };
  }

  async initialize(poolSystem) {
    this.poolSystem = poolSystem;
    
    logger.info('Initializing mining analytics dashboard V2');
    
    // Set up HTTP server
    await this.setupHTTPServer();
    
    // Set up WebSocket server
    await this.setupWebSocketServer();
    
    // Set up pool system listeners
    this.setupPoolListeners();
    
    // Start data collection
    this.startDataCollection();
    
    // Start alert monitoring
    this.startAlertMonitoring();
    
    logger.info(`Dashboard V2 available at http://localhost:${this.config.httpPort}`);
    
    return this;
  }

  async setupHTTPServer() {
    this.app = express();
    
    // Middleware
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '../../public/dashboard')));
    
    // API routes
    this.setupAPIRoutes();
    
    // Start server
    this.httpServer = this.app.listen(this.config.httpPort);
  }

  setupAPIRoutes() {
    // Pool overview
    this.app.get('/api/pool/overview', (req, res) => {
      res.json(this.getPoolOverview());
    });
    
    // Miners list
    this.app.get('/api/miners', (req, res) => {
      res.json(this.getMinersData());
    });
    
    // Individual miner stats
    this.app.get('/api/miners/:minerId', (req, res) => {
      const minerData = this.getMinerData(req.params.minerId);
      if (minerData) {
        res.json(minerData);
      } else {
        res.status(404).json({ error: 'Miner not found' });
      }
    });
    
    // Hardware status
    this.app.get('/api/hardware', (req, res) => {
      res.json(this.getHardwareStatus());
    });
    
    // GPU details
    this.app.get('/api/hardware/gpus', (req, res) => {
      res.json(this.getGPUDetails());
    });
    
    // External miners status
    this.app.get('/api/external-miners', (req, res) => {
      res.json(this.getExternalMinersStatus());
    });
    
    // Profitability data
    this.app.get('/api/profitability', (req, res) => {
      res.json(this.getProfitabilityData());
    });
    
    // Network status
    this.app.get('/api/network', (req, res) => {
      res.json(this.getNetworkStatus());
    });
    
    // Alerts
    this.app.get('/api/alerts', (req, res) => {
      res.json({
        active: Array.from(this.alerts.values()),
        history: this.alertHistory.slice(-100)
      });
    });
    
    // Clear alert
    this.app.post('/api/alerts/:alertId/clear', (req, res) => {
      this.clearAlert(req.params.alertId);
      res.json({ success: true });
    });
    
    // Control endpoints
    this.app.post('/api/control/profile', async (req, res) => {
      try {
        await this.poolSystem.applyMiningProfile(req.body.profile);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    
    this.app.post('/api/control/mining/:action', async (req, res) => {
      try {
        if (req.params.action === 'start') {
          await this.poolSystem.startMining();
        } else if (req.params.action === 'stop') {
          await this.poolSystem.stopMining();
        }
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    
    // Historical data
    this.app.get('/api/history/:metric', (req, res) => {
      const period = req.query.period || '1h';
      res.json(this.getHistoricalData(req.params.metric, period));
    });
  }

  async setupWebSocketServer() {
    this.wsServer = new WebSocketServer({ port: this.config.wsPort });
    
    this.wsServer.on('connection', (ws) => {
      logger.info('New WebSocket client connected');
      
      this.wsClients.add(ws);
      
      // Send initial data
      ws.send(JSON.stringify({
        type: 'initial',
        data: this.getInitialData()
      }));
      
      ws.on('close', () => {
        this.wsClients.delete(ws);
        logger.info('WebSocket client disconnected');
      });
      
      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
        this.wsClients.delete(ws);
      });
    });
  }

  setupPoolListeners() {
    // Pool events
    this.poolSystem.on('share:accepted', (share) => {
      this.handleShareAccepted(share);
    });
    
    this.poolSystem.on('share:rejected', (share, reason) => {
      this.handleShareRejected(share, reason);
    });
    
    this.poolSystem.on('block-found', (block) => {
      this.handleBlockFound(block);
    });
    
    this.poolSystem.on('miner-connected', (data) => {
      this.handleMinerConnected(data);
    });
    
    this.poolSystem.on('miner-disconnected', (data) => {
      this.handleMinerDisconnected(data);
    });
    
    // Hardware events
    this.poolSystem.on('hardware-stats', (stats) => {
      this.updateHardwareMetrics(stats);
    });
    
    this.poolSystem.on('thermal-throttle', (data) => {
      this.handleThermalThrottle(data);
    });
    
    // Mining events
    this.poolSystem.on('algorithm-switch', (data) => {
      this.handleAlgorithmSwitch(data);
    });
    
    this.poolSystem.on('statistics', (stats) => {
      this.updatePoolStatistics(stats);
    });
    
    // External miner events
    if (this.poolSystem.minerManager) {
      this.poolSystem.minerManager.on('stats-update', (data) => {
        this.updateExternalMinerStats(data);
      });
    }
  }

  startDataCollection() {
    // Main update interval
    setInterval(() => {
      this.collectMetrics();
      this.broadcastUpdate();
    }, this.config.updateInterval);
    
    // Hardware update interval
    setInterval(() => {
      this.collectHardwareMetrics();
    }, this.config.hardwareUpdateInterval);
    
    // Cleanup old metrics
    setInterval(() => {
      this.cleanupOldMetrics();
    }, 300000); // Every 5 minutes
  }

  collectMetrics() {
    const now = Date.now();
    const poolStats = this.poolSystem.getPoolStatistics();
    
    // Pool metrics
    this.addMetric(this.metrics.pool.hashrate, {
      time: now,
      value: poolStats.stats.totalHashrate,
      stratum: poolStats.stats.totalHashrate - poolStats.stats.externalHashrate,
      external: poolStats.stats.externalHashrate
    });
    
    this.addMetric(this.metrics.pool.miners, {
      time: now,
      value: poolStats.stats.totalMiners,
      active: poolStats.miners.filter(m => m.hashrate > 0).length
    });
    
    // Calculate efficiency
    const totalAccepted = poolStats.miners.reduce((sum, m) => sum + m.shares.accepted, 0);
    const totalRejected = poolStats.miners.reduce((sum, m) => sum + m.shares.rejected, 0);
    const efficiency = totalAccepted / (totalAccepted + totalRejected) || 0;
    
    this.addMetric(this.metrics.pool.efficiency, {
      time: now,
      value: efficiency * 100
    });
    
    // Network metrics
    if (poolStats.network) {
      this.addMetric(this.metrics.network.nodes, {
        time: now,
        value: poolStats.network.p2pNodes
      });
    }
  }

  collectHardwareMetrics() {
    if (!this.poolSystem.hardwareInterface) return;
    
    const now = Date.now();
    const hwStats = this.poolSystem.hardwareInterface.getStatistics();
    
    // GPU metrics
    for (const [gpuId, gpu] of Object.entries(hwStats.gpus)) {
      if (!this.metrics.hardware.gpus.has(gpuId)) {
        this.metrics.hardware.gpus.set(gpuId, {
          temperature: [],
          power: [],
          hashrate: [],
          fanSpeed: [],
          memory: [],
          utilization: []
        });
      }
      
      const gpuMetrics = this.metrics.hardware.gpus.get(gpuId);
      
      this.addMetric(gpuMetrics.temperature, {
        time: now,
        value: gpu.temperature
      });
      
      this.addMetric(gpuMetrics.power, {
        time: now,
        value: gpu.power
      });
      
      this.addMetric(gpuMetrics.fanSpeed, {
        time: now,
        value: gpu.fanSpeed
      });
      
      if (gpu.utilization) {
        this.addMetric(gpuMetrics.utilization, {
          time: now,
          gpu: gpu.utilization.gpu,
          memory: gpu.utilization.memory
        });
      }
    }
    
    // CPU metrics
    if (hwStats.cpu) {
      this.addMetric(this.metrics.hardware.temperature, {
        time: now,
        cpu: hwStats.cpu.temperature,
        gpuAvg: this.poolSystem.getAverageTemperature()
      });
      
      this.addMetric(this.metrics.hardware.memory, {
        time: now,
        used: (hwStats.cpu.totalMemory - hwStats.cpu.freeMemory) / 1073741824, // GB
        total: hwStats.cpu.totalMemory / 1073741824
      });
    }
    
    // Calculate total power consumption
    let totalPower = 0;
    for (const gpu of Object.values(hwStats.gpus)) {
      totalPower += gpu.power || 0;
    }
    
    this.addMetric(this.metrics.hardware.power, {
      time: now,
      value: totalPower,
      costPerHour: (totalPower / 1000) * (this.config.electricityRate || 0.10)
    });
  }

  handleShareAccepted(share) {
    const miner = this.metrics.miners.get(share.minerId);
    if (!miner) return;
    
    miner.lastShare = Date.now();
    miner.sharesAccepted++;
    
    this.performanceMetrics.sharesPerSecond = 
      (this.performanceMetrics.sharesPerSecond * 0.9) + 0.1;
  }

  handleShareRejected(share, reason) {
    const miner = this.metrics.miners.get(share.minerId);
    if (!miner) return;
    
    miner.sharesRejected++;
    
    // Check reject rate
    const rejectRate = miner.sharesRejected / (miner.sharesAccepted + miner.sharesRejected);
    if (rejectRate > this.config.alertThresholds.highRejectRate) {
      this.createAlert('high-reject-rate', {
        minerId: share.minerId,
        rate: rejectRate,
        reason: reason
      });
    }
  }

  handleBlockFound(block) {
    const now = Date.now();
    
    this.addMetric(this.metrics.pool.blocks, {
      time: now,
      height: block.height,
      hash: block.hash,
      reward: block.reward,
      finder: block.finder,
      coin: block.coin
    });
    
    // Broadcast special block notification
    this.broadcast({
      type: 'block-found',
      data: block
    });
  }

  handleMinerConnected(data) {
    this.metrics.miners.set(data.minerId, {
      id: data.minerId,
      worker: data.worker,
      connectedAt: Date.now(),
      lastShare: 0,
      sharesAccepted: 0,
      sharesRejected: 0,
      hashrate: []
    });
  }

  handleMinerDisconnected(data) {
    this.metrics.miners.delete(data.minerId);
  }

  updateHardwareMetrics(stats) {
    // Hardware updates are handled in collectHardwareMetrics
    // This is for immediate updates
    if (stats.gpus) {
      for (const [gpuId, gpu] of Object.entries(stats.gpus)) {
        if (gpu.temperature > this.config.alertThresholds.highTemperature) {
          this.createAlert('high-temperature', {
            device: `GPU ${gpuId}`,
            temperature: gpu.temperature,
            limit: this.config.alertThresholds.highTemperature
          });
        }
      }
    }
  }

  handleThermalThrottle(data) {
    this.createAlert('thermal-throttle', {
      device: data.gpuId,
      temperature: data.temperature,
      severity: 'warning'
    });
  }

  handleAlgorithmSwitch(data) {
    const now = Date.now();
    
    this.addMetric(this.metrics.profitability.switches, {
      time: now,
      from: data.from,
      to: data.to,
      algorithm: data.algorithm,
      estimatedProfit: data.estimatedProfit
    });
  }

  updatePoolStatistics(stats) {
    // Update real-time statistics
    this.performanceMetrics.cpuUsage = process.cpuUsage().user / 1000000;
    this.performanceMetrics.memoryUsage = process.memoryUsage().heapUsed / 1048576; // MB
  }

  updateExternalMinerStats(data) {
    this.metrics.externalMiners.set(data.type, {
      type: data.type,
      stats: data.stats,
      lastUpdate: Date.now()
    });
  }

  startAlertMonitoring() {
    setInterval(() => {
      this.checkAlerts();
    }, 10000); // Every 10 seconds
  }

  checkAlerts() {
    const now = Date.now();
    const poolStats = this.poolSystem.getPoolStatistics();
    
    // Check miner timeouts
    for (const [minerId, miner] of this.metrics.miners) {
      if (miner.lastShare && (now - miner.lastShare) > this.config.alertThresholds.minerTimeout) {
        this.createAlert('miner-timeout', {
          minerId: minerId,
          worker: miner.worker,
          lastSeen: new Date(miner.lastShare).toISOString()
        });
      }
    }
    
    // Check pool hashrate
    if (this.metrics.pool.hashrate.length > 10) {
      const avgHashrate = this.calculateAverage(
        this.metrics.pool.hashrate.slice(-10).map(m => m.value)
      );
      const currentHashrate = poolStats.stats.totalHashrate;
      
      if (currentHashrate < avgHashrate * this.config.alertThresholds.lowHashrate) {
        this.createAlert('low-hashrate', {
          current: currentHashrate,
          average: avgHashrate,
          drop: ((avgHashrate - currentHashrate) / avgHashrate * 100).toFixed(2)
        });
      }
    }
    
    // Check efficiency
    const currentEfficiency = this.metrics.pool.efficiency.slice(-1)[0]?.value || 100;
    if (currentEfficiency < this.config.alertThresholds.lowEfficiency * 100) {
      this.createAlert('low-efficiency', {
        efficiency: currentEfficiency,
        threshold: this.config.alertThresholds.lowEfficiency * 100
      });
    }
  }

  createAlert(type, data) {
    const alertId = `${type}-${Date.now()}`;
    
    const alert = {
      id: alertId,
      type: type,
      severity: this.getAlertSeverity(type),
      message: this.getAlertMessage(type, data),
      data: data,
      timestamp: Date.now()
    };
    
    this.alerts.set(alertId, alert);
    this.alertHistory.push(alert);
    
    // Broadcast alert
    this.broadcast({
      type: 'alert',
      data: alert
    });
    
    logger.warn(`Alert created: ${alert.message}`);
  }

  getAlertSeverity(type) {
    const severities = {
      'high-temperature': 'critical',
      'thermal-throttle': 'warning',
      'miner-timeout': 'warning',
      'low-hashrate': 'warning',
      'high-reject-rate': 'error',
      'low-efficiency': 'warning'
    };
    
    return severities[type] || 'info';
  }

  getAlertMessage(type, data) {
    const messages = {
      'high-temperature': `${data.device} temperature is ${data.temperature}°C (limit: ${data.limit}°C)`,
      'thermal-throttle': `${data.device} is thermal throttling at ${data.temperature}°C`,
      'miner-timeout': `Miner ${data.worker} hasn't submitted shares since ${data.lastSeen}`,
      'low-hashrate': `Pool hashrate dropped ${data.drop}% below average`,
      'high-reject-rate': `Miner ${data.minerId} has ${(data.rate * 100).toFixed(2)}% reject rate`,
      'low-efficiency': `Pool efficiency is ${data.efficiency.toFixed(2)}% (threshold: ${data.threshold}%)`
    };
    
    return messages[type] || `Alert: ${type}`;
  }

  clearAlert(alertId) {
    this.alerts.delete(alertId);
  }

  addMetric(array, metric) {
    array.push(metric);
    
    // Keep only recent data based on retention period
    const cutoff = Date.now() - this.config.metricsRetention;
    while (array.length > 0 && array[0].time < cutoff) {
      array.shift();
    }
  }

  cleanupOldMetrics() {
    const cutoff = Date.now() - this.config.metricsRetention;
    
    // Clean up all metric arrays
    for (const category of Object.values(this.metrics)) {
      if (Array.isArray(category)) {
        while (category.length > 0 && category[0].time < cutoff) {
          category.shift();
        }
      } else if (category instanceof Map) {
        for (const [key, value] of category) {
          if (Array.isArray(value)) {
            while (value.length > 0 && value[0].time < cutoff) {
              value.shift();
            }
          }
        }
      }
    }
    
    // Clean up alert history
    this.alertHistory = this.alertHistory.filter(alert => alert.timestamp > cutoff);
  }

  calculateAverage(values) {
    if (values.length === 0) return 0;
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  broadcastUpdate() {
    const update = {
      type: 'update',
      data: {
        pool: this.getPoolOverview(),
        hardware: this.getHardwareStatus(),
        performance: this.performanceMetrics,
        alerts: Array.from(this.alerts.values()).slice(0, 5)
      }
    };
    
    this.broadcast(update);
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    
    for (const client of this.wsClients) {
      try {
        if (client.readyState === 1) { // OPEN
          client.send(data);
        }
      } catch (error) {
        logger.error('Error broadcasting to client:', error);
        this.wsClients.delete(client);
      }
    }
  }

  getInitialData() {
    return {
      pool: this.getPoolOverview(),
      miners: this.getMinersData(),
      hardware: this.getHardwareStatus(),
      network: this.getNetworkStatus(),
      profitability: this.getProfitabilityData(),
      alerts: {
        active: Array.from(this.alerts.values()),
        history: this.alertHistory.slice(-50)
      }
    };
  }

  getPoolOverview() {
    const poolStats = this.poolSystem.getPoolStatistics();
    const latestHashrate = this.metrics.pool.hashrate.slice(-1)[0];
    const latestEfficiency = this.metrics.pool.efficiency.slice(-1)[0];
    
    return {
      name: poolStats.pool.name,
      algorithm: poolStats.pool.algorithm,
      coin: poolStats.pool.coin,
      miners: {
        total: poolStats.stats.totalMiners,
        active: poolStats.miners.filter(m => m.hashrate > 0).length
      },
      hashrate: {
        total: poolStats.stats.totalHashrate,
        stratum: latestHashrate?.stratum || 0,
        external: latestHashrate?.external || 0,
        unit: 'H/s'
      },
      shares: {
        total: poolStats.stats.totalShares,
        perSecond: this.performanceMetrics.sharesPerSecond
      },
      blocks: {
        total: poolStats.stats.totalBlocks,
        last: this.metrics.pool.blocks.slice(-1)[0] || null
      },
      efficiency: latestEfficiency?.value || 100,
      uptime: poolStats.stats.uptime
    };
  }

  getMinersData() {
    const miners = [];
    const poolStats = this.poolSystem.getPoolStatistics();
    
    for (const miner of poolStats.miners) {
      const metrics = this.metrics.miners.get(miner.id);
      
      miners.push({
        id: miner.id,
        worker: miner.worker,
        hashrate: miner.hashrate,
        shares: miner.shares,
        efficiency: miner.shares.accepted / (miner.shares.accepted + miner.shares.rejected) * 100 || 0,
        lastShare: metrics?.lastShare || 0,
        isExternal: miner.isExternal
      });
    }
    
    return miners.sort((a, b) => b.hashrate - a.hashrate);
  }

  getMinerData(minerId) {
    const poolStats = this.poolSystem.getMinerStatistics(minerId);
    if (!poolStats) return null;
    
    const metrics = this.metrics.miners.get(minerId);
    
    return {
      ...poolStats,
      metrics: metrics,
      shareHistory: poolStats.shareHistory?.slice(-100) || []
    };
  }

  getHardwareStatus() {
    const hwStats = this.poolSystem.hardwareInterface?.getStatistics();
    if (!hwStats) return { available: false };
    
    const gpus = [];
    for (const [gpuId, gpu] of Object.entries(hwStats.gpus)) {
      const metrics = this.metrics.hardware.gpus.get(gpuId);
      
      gpus.push({
        id: gpuId,
        name: gpu.name,
        type: gpu.type,
        temperature: gpu.temperature,
        power: gpu.power,
        fanSpeed: gpu.fanSpeed,
        hashrate: gpu.hashrate || 0,
        memory: gpu.memory,
        utilization: gpu.utilization,
        metrics: {
          temperature: metrics?.temperature.slice(-20) || [],
          power: metrics?.power.slice(-20) || []
        }
      });
    }
    
    return {
      available: true,
      cpu: hwStats.cpu,
      gpus: gpus,
      totalPower: this.metrics.hardware.power.slice(-1)[0]?.value || 0,
      averageTemperature: this.poolSystem.getAverageTemperature()
    };
  }

  getGPUDetails() {
    const details = [];
    
    for (const [gpuId, metrics] of this.metrics.hardware.gpus) {
      details.push({
        id: gpuId,
        temperature: metrics.temperature.slice(-60),
        power: metrics.power.slice(-60),
        fanSpeed: metrics.fanSpeed.slice(-60),
        utilization: metrics.utilization.slice(-60)
      });
    }
    
    return details;
  }

  getExternalMinersStatus() {
    const miners = [];
    
    for (const [type, data] of this.metrics.externalMiners) {
      miners.push({
        type: type,
        ...data.stats,
        lastUpdate: data.lastUpdate
      });
    }
    
    return miners;
  }

  getProfitabilityData() {
    const profitSwitcher = this.poolSystem.profitSwitcher;
    if (!profitSwitcher) return { available: false };
    
    return {
      available: true,
      current: {
        coin: this.poolSystem.currentCoin,
        algorithm: this.poolSystem.currentAlgorithm,
        profitability: profitSwitcher.getCurrentProfitability()
      },
      alternatives: profitSwitcher.getProfitabilityTable(),
      switches: this.metrics.profitability.switches.slice(-10),
      predictions: profitSwitcher.getPricePredictions()
    };
  }

  getNetworkStatus() {
    const poolStats = this.poolSystem.getPoolStatistics();
    
    return {
      p2p: {
        nodes: poolStats.network?.p2pNodes || 0,
        latency: this.performanceMetrics.networkLatency
      },
      consensus: {
        view: poolStats.network?.consensusView || 0
      },
      shareChain: {
        length: poolStats.network?.shareChainLength || 0
      }
    };
  }

  getHistoricalData(metric, period) {
    const now = Date.now();
    const periods = {
      '1h': 3600000,
      '6h': 21600000,
      '24h': 86400000,
      '7d': 604800000
    };
    
    const duration = periods[period] || periods['1h'];
    const cutoff = now - duration;
    
    let data = [];
    
    switch (metric) {
      case 'hashrate':
        data = this.metrics.pool.hashrate.filter(m => m.time > cutoff);
        break;
      case 'efficiency':
        data = this.metrics.pool.efficiency.filter(m => m.time > cutoff);
        break;
      case 'temperature':
        data = this.metrics.hardware.temperature.filter(m => m.time > cutoff);
        break;
      case 'power':
        data = this.metrics.hardware.power.filter(m => m.time > cutoff);
        break;
      case 'blocks':
        data = this.metrics.pool.blocks.filter(m => m.time > cutoff);
        break;
      default:
        data = [];
    }
    
    return data;
  }

  async shutdown() {
    logger.info('Shutting down mining analytics dashboard');
    
    // Close WebSocket connections
    for (const client of this.wsClients) {
      client.close();
    }
    
    if (this.wsServer) {
      this.wsServer.close();
    }
    
    if (this.httpServer) {
      this.httpServer.close();
    }
  }
}

export default MiningAnalyticsDashboardV2;