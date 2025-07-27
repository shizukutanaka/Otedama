/**
 * Unified Dashboard System - Otedama
 * Consolidated monitoring and dashboard functionality
 * 
 * Design principles:
 * - Carmack: Fast updates, minimal latency
 * - Martin: Clean dashboard architecture  
 * - Pike: Simple and effective visualization
 * 
 * Features:
 * - Real-time performance metrics
 * - Mining analytics
 * - Health monitoring
 * - Alert management
 * - WebSocket real-time updates
 */

import { EventEmitter } from 'events';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createStructuredLogger } from '../core/structured-logger.js';
import { MetricsCollector } from './metrics-collector.js';
import { PrometheusExporter } from './prometheus-exporter.js';

const logger = createStructuredLogger('UnifiedDashboard');
const __dirname = dirname(fileURLToPath(import.meta.url));

export class UnifiedDashboard extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      host: config.host || '0.0.0.0',
      port: config.port || 8080,
      updateInterval: config.updateInterval || 1000,
      historySize: config.historySize || 300,
      enablePrometheus: config.enablePrometheus !== false,
      prometheusPort: config.prometheusPort || 9090,
      ...config
    };
    
    this.server = null;
    this.wss = null;
    this.metricsCollector = null;
    this.prometheusExporter = null;
    this.clients = new Set();
    this.isRunning = false;
    
    // Metrics history
    this.history = {
      hashrate: [],
      shares: [],
      miners: [],
      blocks: [],
      performance: [],
      alerts: []
    };
    
    // Dashboard stats
    this.stats = {
      connections: 0,
      messagesPerSecond: 0,
      dataTransferred: 0,
      uptime: Date.now()
    };
  }
  
  async start() {
    if (this.isRunning) return;
    
    try {
      // Initialize metrics collector
      this.metricsCollector = new MetricsCollector();
      await this.metricsCollector.start();
      
      // Initialize Prometheus exporter if enabled
      if (this.config.enablePrometheus) {
        this.prometheusExporter = new PrometheusExporter({
          port: this.config.prometheusPort
        });
        await this.prometheusExporter.start();
      }
      
      // Create HTTP server
      this.server = createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });
      
      // Create WebSocket server
      this.wss = new WebSocketServer({ server: this.server });
      this.setupWebSocketServer();
      
      // Start server
      await new Promise((resolve, reject) => {
        this.server.listen(this.config.port, this.config.host, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      
      // Start update loop
      this.startUpdateLoop();
      
      this.isRunning = true;
      logger.info(`Dashboard started on http://${this.config.host}:${this.config.port}`);
      
    } catch (error) {
      logger.error('Failed to start dashboard:', error);
      throw error;
    }
  }
  
  async stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    // Close WebSocket connections
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    
    // Stop update loop
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
    
    // Close servers
    if (this.wss) {
      this.wss.close();
    }
    
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
    }
    
    // Stop components
    if (this.metricsCollector) {
      await this.metricsCollector.stop();
    }
    
    if (this.prometheusExporter) {
      await this.prometheusExporter.stop();
    }
    
    logger.info('Dashboard stopped');
  }
  
  setupWebSocketServer() {
    this.wss.on('connection', (ws, req) => {
      const clientInfo = {
        ip: req.socket.remoteAddress,
        userAgent: req.headers['user-agent'],
        connectedAt: Date.now()
      };
      
      this.clients.add(ws);
      this.stats.connections++;
      
      logger.info('Dashboard client connected', clientInfo);
      
      // Send initial data
      this.sendInitialData(ws);
      
      // Handle client messages
      ws.on('message', (data) => {
        this.handleClientMessage(ws, data, clientInfo);
      });
      
      // Handle disconnect
      ws.on('close', () => {
        this.clients.delete(ws);
        this.stats.connections--;
        logger.info('Dashboard client disconnected', clientInfo);
      });
      
      // Handle errors
      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
      });
    });
  }
  
  handleHttpRequest(req, res) {
    const url = req.url;
    
    // Serve dashboard HTML
    if (url === '/' || url === '/index.html') {
      this.serveDashboardHTML(res);
    }
    // Serve static assets
    else if (url.startsWith('/static/')) {
      this.serveStaticFile(url, res);
    }
    // API endpoints
    else if (url.startsWith('/api/')) {
      this.handleApiRequest(url, req, res);
    }
    // 404
    else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }
  
  serveDashboardHTML(res) {
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Otedama Mining Dashboard</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f0f0f0; }
    .container { max-width: 1200px; margin: 0 auto; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .metric { display: inline-block; margin: 10px 20px; }
    .metric-value { font-size: 2em; font-weight: bold; color: #333; }
    .metric-label { color: #666; }
    .chart { height: 200px; margin: 20px 0; }
    .status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; }
    .status.online { background: #4CAF50; }
    .status.offline { background: #f44336; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Otedama Mining Dashboard</h1>
    
    <div class="card">
      <h2>Pool Overview</h2>
      <div id="overview">
        <div class="metric">
          <div class="metric-value" id="hashrate">0 H/s</div>
          <div class="metric-label">Pool Hashrate</div>
        </div>
        <div class="metric">
          <div class="metric-value" id="miners">0</div>
          <div class="metric-label">Active Miners</div>
        </div>
        <div class="metric">
          <div class="metric-value" id="workers">0</div>
          <div class="metric-label">Workers</div>
        </div>
        <div class="metric">
          <div class="metric-value" id="blocks">0</div>
          <div class="metric-label">Blocks Found</div>
        </div>
      </div>
    </div>
    
    <div class="card">
      <h2>Hashrate Chart</h2>
      <canvas id="hashrateChart" class="chart"></canvas>
    </div>
    
    <div class="card">
      <h2>Top Miners</h2>
      <table id="minersTable">
        <thead>
          <tr>
            <th>Address</th>
            <th>Hashrate</th>
            <th>Shares</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    
    <div class="card">
      <h2>Recent Blocks</h2>
      <table id="blocksTable">
        <thead>
          <tr>
            <th>Height</th>
            <th>Hash</th>
            <th>Miner</th>
            <th>Time</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  </div>
  
  <script>
    const ws = new WebSocket('ws://' + window.location.host);
    let chart;
    
    ws.onopen = () => {
      console.log('Connected to dashboard');
    };
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      updateDashboard(data);
    };
    
    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
    
    function updateDashboard(data) {
      // Update overview metrics
      if (data.overview) {
        document.getElementById('hashrate').textContent = formatHashrate(data.overview.hashrate);
        document.getElementById('miners').textContent = data.overview.miners;
        document.getElementById('workers').textContent = data.overview.workers;
        document.getElementById('blocks').textContent = data.overview.blocks;
      }
      
      // Update miners table
      if (data.miners) {
        updateMinersTable(data.miners);
      }
      
      // Update blocks table
      if (data.blocks) {
        updateBlocksTable(data.blocks);
      }
      
      // Update chart
      if (data.history) {
        updateChart(data.history);
      }
    }
    
    function formatHashrate(hashrate) {
      const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
      let unitIndex = 0;
      
      while (hashrate >= 1000 && unitIndex < units.length - 1) {
        hashrate /= 1000;
        unitIndex++;
      }
      
      return hashrate.toFixed(2) + ' ' + units[unitIndex];
    }
    
    function updateMinersTable(miners) {
      const tbody = document.querySelector('#minersTable tbody');
      tbody.innerHTML = miners.slice(0, 10).map(miner => \`
        <tr>
          <td>\${miner.address.substring(0, 8)}...</td>
          <td>\${formatHashrate(miner.hashrate)}</td>
          <td>\${miner.shares}</td>
          <td><span class="status \${miner.online ? 'online' : 'offline'}"></span>\${miner.online ? 'Online' : 'Offline'}</td>
        </tr>
      \`).join('');
    }
    
    function updateBlocksTable(blocks) {
      const tbody = document.querySelector('#blocksTable tbody');
      tbody.innerHTML = blocks.slice(0, 5).map(block => \`
        <tr>
          <td>\${block.height}</td>
          <td>\${block.hash.substring(0, 8)}...</td>
          <td>\${block.miner.substring(0, 8)}...</td>
          <td>\${new Date(block.timestamp).toLocaleString()}</td>
          <td>\${block.confirmed ? 'Confirmed' : 'Pending'}</td>
        </tr>
      \`).join('');
    }
    
    function updateChart(history) {
      // Simple chart update logic
      // In production, use a proper charting library
    }
  </script>
</body>
</html>
    `;
    
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }
  
  handleApiRequest(url, req, res) {
    const endpoint = url.replace('/api/', '');
    
    switch (endpoint) {
      case 'stats':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getStats()));
        break;
        
      case 'history':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.history));
        break;
        
      default:
        res.writeHead(404);
        res.end('Not Found');
    }
  }
  
  startUpdateLoop() {
    this.updateTimer = setInterval(() => {
      this.collectAndBroadcast();
    }, this.config.updateInterval);
  }
  
  async collectAndBroadcast() {
    try {
      // Collect current metrics
      const metrics = await this.metricsCollector.collect();
      
      // Update history
      this.updateHistory(metrics);
      
      // Prepare dashboard data
      const dashboardData = {
        timestamp: Date.now(),
        overview: {
          hashrate: metrics.pool.hashrate,
          miners: metrics.pool.miners,
          workers: metrics.pool.workers,
          blocks: metrics.pool.blocks
        },
        miners: metrics.miners.slice(0, 10),
        blocks: metrics.blocks.slice(0, 5),
        history: this.getRecentHistory(),
        alerts: metrics.alerts
      };
      
      // Broadcast to connected clients
      this.broadcast(dashboardData);
      
      // Update stats
      this.stats.messagesPerSecond++;
      this.stats.dataTransferred += JSON.stringify(dashboardData).length;
      
    } catch (error) {
      logger.error('Error collecting metrics:', error);
    }
  }
  
  updateHistory(metrics) {
    const timestamp = Date.now();
    
    // Add to history
    this.history.hashrate.push({ timestamp, value: metrics.pool.hashrate });
    this.history.shares.push({ timestamp, value: metrics.pool.shares });
    this.history.miners.push({ timestamp, value: metrics.pool.miners });
    
    // Trim old data
    const cutoff = timestamp - (this.config.historySize * 1000);
    for (const key in this.history) {
      this.history[key] = this.history[key].filter(item => item.timestamp > cutoff);
    }
  }
  
  getRecentHistory() {
    const recent = {};
    for (const key in this.history) {
      recent[key] = this.history[key].slice(-60); // Last 60 data points
    }
    return recent;
  }
  
  sendInitialData(ws) {
    const initialData = {
      type: 'initial',
      config: {
        updateInterval: this.config.updateInterval,
        historySize: this.config.historySize
      },
      history: this.history,
      stats: this.getStats()
    };
    
    ws.send(JSON.stringify(initialData));
  }
  
  handleClientMessage(ws, data, clientInfo) {
    try {
      const message = JSON.parse(data);
      
      switch (message.type) {
        case 'subscribe':
          // Handle subscription to specific metrics
          break;
          
        case 'command':
          // Handle dashboard commands
          this.handleCommand(message.command, message.params, ws);
          break;
          
        default:
          logger.warn('Unknown message type:', message.type);
      }
      
    } catch (error) {
      logger.error('Error handling client message:', error);
    }
  }
  
  handleCommand(command, params, ws) {
    // Handle dashboard commands
    switch (command) {
      case 'getMiners':
        ws.send(JSON.stringify({
          type: 'miners',
          data: this.metricsCollector.getMiners()
        }));
        break;
        
      case 'getMinerDetails':
        ws.send(JSON.stringify({
          type: 'minerDetails',
          data: this.metricsCollector.getMinerDetails(params.minerId)
        }));
        break;
        
      default:
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Unknown command'
        }));
    }
  }
  
  broadcast(data) {
    const message = JSON.stringify(data);
    
    for (const client of this.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    }
  }
  
  getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - this.stats.uptime,
      clients: this.clients.size,
      memoryUsage: process.memoryUsage()
    };
  }
}

export default UnifiedDashboard;