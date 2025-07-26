/**
 * Dashboard Server - Otedama
 * Real-time monitoring dashboard for mining pool operations
 * 
 * Design Principles:
 * - Pike: Simple HTTP server with WebSocket for real-time updates
 * - Martin: Clean separation of data collection and presentation
 * - Carmack: Efficient data streaming with minimal overhead
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { MetricsCollector } from './metrics-collector.js';
import path from 'path';
import fs from 'fs';

const logger = createStructuredLogger('DashboardServer');

/**
 * Dashboard Server
 */
export class DashboardServer extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      port: config.port || 8080,
      host: config.host || '0.0.0.0',
      updateInterval: config.updateInterval || 1000,
      authRequired: config.authRequired || false,
      apiKey: config.apiKey || null,
      ...config
    };
    
    // Server components
    this.httpServer = null;
    this.wsServer = null;
    this.metricsCollector = null;
    
    // Connected clients
    this.clients = new Set();
    
    // Dashboard state
    this.running = false;
    this.updateTimer = null;
    
    this.logger = logger;
  }
  
  /**
   * Start dashboard server
   */
  async start(metricsCollector) {
    if (this.running) return;
    
    this.metricsCollector = metricsCollector || new MetricsCollector();
    
    // Create HTTP server
    this.httpServer = createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });
    
    // Create WebSocket server
    this.wsServer = new WebSocketServer({ 
      server: this.httpServer,
      path: '/ws'
    });
    
    this.wsServer.on('connection', (ws, req) => {
      this.handleWebSocketConnection(ws, req);
    });
    
    // Start HTTP server
    return new Promise((resolve, reject) => {
      this.httpServer.listen(this.config.port, this.config.host, () => {
        this.running = true;
        
        // Start metrics updates
        this.startMetricsUpdates();
        
        this.logger.info('Dashboard server started', {
          port: this.config.port,
          host: this.config.host,
          url: `http://${this.config.host}:${this.config.port}`
        });
        
        resolve();
      });
      
      this.httpServer.on('error', reject);
    });
  }
  
  /**
   * Stop dashboard server
   */
  async stop() {
    if (!this.running) return;
    
    // Stop metrics updates
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    
    // Close all WebSocket connections
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    
    // Close servers
    return new Promise((resolve) => {
      this.wsServer.close(() => {
        this.httpServer.close(() => {
          this.running = false;
          this.logger.info('Dashboard server stopped');
          resolve();
        });
      });
    });
  }
  
  /**
   * Handle HTTP requests
   */
  handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // Check authentication if required
    if (this.config.authRequired && !this.checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    
    // Route requests
    switch (url.pathname) {
      case '/':
        this.serveDashboard(res);
        break;
        
      case '/api/metrics':
        this.serveMetrics(res);
        break;
        
      case '/api/metrics/export':
        this.serveMetricsExport(res, url.searchParams.get('format'));
        break;
        
      case '/api/history':
        this.serveHistory(res, url.searchParams);
        break;
        
      case '/api/alerts':
        this.serveAlerts(res);
        break;
        
      case '/health':
        this.serveHealth(res);
        break;
        
      default:
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
  }
  
  /**
   * Serve dashboard HTML
   */
  serveDashboard(res) {
    const dashboardHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Otedama Mining Pool Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0e1a;
      color: #e0e0e0;
      line-height: 1.6;
    }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    .header { 
      background: #1a1f2e;
      padding: 20px;
      border-radius: 10px;
      margin-bottom: 30px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }
    h1 { 
      font-size: 2.5em; 
      background: linear-gradient(45deg, #00ff88, #00aaff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 10px;
    }
    .status { 
      display: inline-block;
      padding: 5px 15px;
      border-radius: 20px;
      font-size: 0.9em;
      font-weight: 500;
    }
    .status.online { background: #00ff8830; color: #00ff88; }
    .status.offline { background: #ff444430; color: #ff4444; }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .metric-card {
      background: #1a1f2e;
      padding: 25px;
      border-radius: 10px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      transition: transform 0.3s ease;
    }
    .metric-card:hover { transform: translateY(-5px); }
    .metric-title { 
      font-size: 0.9em; 
      color: #888;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .metric-value { 
      font-size: 2.5em; 
      font-weight: 300;
      color: #00ff88;
      margin-bottom: 5px;
    }
    .metric-change { 
      font-size: 0.9em; 
      color: #888;
    }
    .metric-change.positive { color: #00ff88; }
    .metric-change.negative { color: #ff4444; }
    .chart-container {
      background: #1a1f2e;
      padding: 25px;
      border-radius: 10px;
      margin-bottom: 20px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }
    .chart-title { 
      font-size: 1.2em; 
      margin-bottom: 20px;
      color: #00aaff;
    }
    #hashrate-chart, #shares-chart {
      width: 100%;
      height: 300px;
      background: #0a0e1a;
      border-radius: 5px;
      position: relative;
      overflow: hidden;
    }
    .alert-banner {
      background: #ff444430;
      border: 1px solid #ff4444;
      color: #ff4444;
      padding: 15px 20px;
      border-radius: 10px;
      margin-bottom: 20px;
      display: none;
    }
    .alert-banner.active { display: block; }
    .footer {
      text-align: center;
      color: #666;
      margin-top: 50px;
      padding-top: 20px;
      border-top: 1px solid #333;
    }
    canvas { display: block; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Otedama Mining Pool</h1>
      <span class="status online" id="pool-status">ONLINE</span>
    </div>
    
    <div class="alert-banner" id="alert-banner"></div>
    
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-title">Total Hashrate</div>
        <div class="metric-value" id="hashrate">0 H/s</div>
        <div class="metric-change" id="hashrate-change">-</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-title">Active Miners</div>
        <div class="metric-value" id="miners">0</div>
        <div class="metric-change" id="miners-change">-</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-title">Network Difficulty</div>
        <div class="metric-value" id="difficulty">0</div>
        <div class="metric-change" id="difficulty-change">-</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-title">Blocks Found (24h)</div>
        <div class="metric-value" id="blocks">0</div>
        <div class="metric-change" id="blocks-change">-</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-title">Share Accept Rate</div>
        <div class="metric-value" id="accept-rate">0%</div>
        <div class="metric-change" id="accept-rate-change">-</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-title">Pool Efficiency</div>
        <div class="metric-value" id="efficiency">0%</div>
        <div class="metric-change" id="efficiency-change">-</div>
      </div>
    </div>
    
    <div class="chart-container">
      <div class="chart-title">Hashrate History (1 Hour)</div>
      <canvas id="hashrate-chart"></canvas>
    </div>
    
    <div class="chart-container">
      <div class="chart-title">Shares per Second (1 Hour)</div>
      <canvas id="shares-chart"></canvas>
    </div>
    
    <div class="footer">
      <p>Otedama Mining Pool - High-Performance P2P Mining</p>
    </div>
  </div>
  
  <script>
    // WebSocket connection
    const ws = new WebSocket('ws://' + window.location.host + '/ws');
    let metrics = {};
    let hashrateHistory = [];
    let sharesHistory = [];
    
    // Format numbers
    function formatHashrate(h) {
      if (h >= 1e18) return (h / 1e18).toFixed(2) + ' EH/s';
      if (h >= 1e15) return (h / 1e15).toFixed(2) + ' PH/s';
      if (h >= 1e12) return (h / 1e12).toFixed(2) + ' TH/s';
      if (h >= 1e9) return (h / 1e9).toFixed(2) + ' GH/s';
      if (h >= 1e6) return (h / 1e6).toFixed(2) + ' MH/s';
      if (h >= 1e3) return (h / 1e3).toFixed(2) + ' KH/s';
      return h.toFixed(2) + ' H/s';
    }
    
    function formatNumber(n) {
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
      return n.toString();
    }
    
    // Update metrics display
    function updateMetrics(data) {
      // Hashrate
      document.getElementById('hashrate').textContent = formatHashrate(data.pool.hashrate);
      updateChange('hashrate-change', data.pool.hashrate, metrics.pool?.hashrate);
      
      // Miners
      document.getElementById('miners').textContent = data.pool.miners;
      updateChange('miners-change', data.pool.miners, metrics.pool?.miners);
      
      // Difficulty
      document.getElementById('difficulty').textContent = formatNumber(data.pool.difficulty);
      updateChange('difficulty-change', data.pool.difficulty, metrics.pool?.difficulty);
      
      // Blocks
      document.getElementById('blocks').textContent = data.blocks.last24h;
      updateChange('blocks-change', data.blocks.last24h, metrics.blocks?.last24h);
      
      // Accept rate
      document.getElementById('accept-rate').textContent = data.shares.acceptRate.toFixed(1) + '%';
      updateChange('accept-rate-change', data.shares.acceptRate, metrics.shares?.acceptRate);
      
      // Efficiency
      document.getElementById('efficiency').textContent = data.pool.efficiency.toFixed(1) + '%';
      updateChange('efficiency-change', data.pool.efficiency, metrics.pool?.efficiency);
      
      metrics = data;
    }
    
    function updateChange(id, current, previous) {
      const element = document.getElementById(id);
      if (previous === undefined) {
        element.textContent = '-';
        return;
      }
      
      const change = ((current - previous) / previous) * 100;
      if (change > 0) {
        element.textContent = '+' + change.toFixed(1) + '%';
        element.className = 'metric-change positive';
      } else if (change < 0) {
        element.textContent = change.toFixed(1) + '%';
        element.className = 'metric-change negative';
      } else {
        element.textContent = '0%';
        element.className = 'metric-change';
      }
    }
    
    // Chart drawing
    function drawChart(canvasId, data, color) {
      const canvas = document.getElementById(canvasId);
      const ctx = canvas.getContext('2d');
      const width = canvas.offsetWidth;
      const height = canvas.offsetHeight;
      
      canvas.width = width;
      canvas.height = height;
      
      ctx.clearRect(0, 0, width, height);
      
      if (data.length < 2) return;
      
      const max = Math.max(...data);
      const min = Math.min(...data);
      const range = max - min || 1;
      
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      
      data.forEach((value, i) => {
        const x = (i / (data.length - 1)) * width;
        const y = height - ((value - min) / range) * height * 0.8 - height * 0.1;
        
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      
      ctx.stroke();
      
      // Fill gradient
      const gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, color + '40');
      gradient.addColorStop(1, color + '00');
      
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    
    // WebSocket handlers
    ws.onopen = () => {
      console.log('Connected to dashboard');
      document.getElementById('pool-status').textContent = 'ONLINE';
      document.getElementById('pool-status').className = 'status online';
    };
    
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      
      switch (message.type) {
        case 'metrics':
          updateMetrics(message.data);
          
          // Update history
          hashrateHistory.push(message.data.pool.hashrate);
          sharesHistory.push(message.data.shares.sharesPerSecond);
          
          if (hashrateHistory.length > 3600) hashrateHistory.shift();
          if (sharesHistory.length > 3600) sharesHistory.shift();
          
          // Redraw charts
          drawChart('hashrate-chart', hashrateHistory, '#00ff88');
          drawChart('shares-chart', sharesHistory, '#00aaff');
          break;
          
        case 'alert':
          showAlert(message.data);
          break;
      }
    };
    
    ws.onclose = () => {
      console.log('Disconnected from dashboard');
      document.getElementById('pool-status').textContent = 'OFFLINE';
      document.getElementById('pool-status').className = 'status offline';
    };
    
    function showAlert(alert) {
      const banner = document.getElementById('alert-banner');
      banner.textContent = 'ALERT: ' + alert.type.replace(/_/g, ' ').toUpperCase() + ' - ' + JSON.stringify(alert.data);
      banner.className = 'alert-banner active';
      
      setTimeout(() => {
        banner.className = 'alert-banner';
      }, 10000);
    }
  </script>
</body>
</html>`;
    
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(dashboardHtml);
  }
  
  /**
   * Serve current metrics
   */
  serveMetrics(res) {
    const metrics = this.metricsCollector.getCurrentMetrics();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metrics, null, 2));
  }
  
  /**
   * Serve metrics export
   */
  serveMetricsExport(res, format = 'json') {
    try {
      const data = this.metricsCollector.exportMetrics(format);
      
      const contentType = format === 'prometheus' ? 
        'text/plain' : 'application/json';
      
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(typeof data === 'string' ? data : JSON.stringify(data));
      
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }
  
  /**
   * Serve historical data
   */
  serveHistory(res, params) {
    const metric = params.get('metric');
    const duration = parseInt(params.get('duration') || '3600');
    
    try {
      const data = this.metricsCollector.getHistoricalData(metric, duration);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }
  
  /**
   * Serve alerts
   */
  serveAlerts(res) {
    const alerts = Array.from(this.metricsCollector.alerts.values());
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(alerts));
  }
  
  /**
   * Serve health check
   */
  serveHealth(res) {
    const health = {
      status: 'healthy',
      uptime: process.uptime(),
      connections: this.clients.size,
      timestamp: Date.now()
    };
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
  }
  
  /**
   * Handle WebSocket connections
   */
  handleWebSocketConnection(ws, req) {
    // Check authentication if required
    if (this.config.authRequired && !this.checkWebSocketAuth(req)) {
      ws.close(1008, 'Unauthorized');
      return;
    }
    
    this.clients.add(ws);
    this.logger.info('Dashboard client connected', {
      ip: req.socket.remoteAddress,
      clients: this.clients.size
    });
    
    // Send initial metrics
    const metrics = this.metricsCollector.getCurrentMetrics();
    ws.send(JSON.stringify({
      type: 'metrics',
      data: metrics
    }));
    
    // Handle client messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        this.handleClientMessage(ws, message);
      } catch (error) {
        this.logger.error('Invalid client message:', error);
      }
    });
    
    // Handle disconnection
    ws.on('close', () => {
      this.clients.delete(ws);
      this.logger.info('Dashboard client disconnected', {
        clients: this.clients.size
      });
    });
    
    ws.on('error', (error) => {
      this.logger.error('WebSocket error:', error);
    });
  }
  
  /**
   * Handle client messages
   */
  handleClientMessage(ws, message) {
    switch (message.type) {
      case 'subscribe':
        // Client can subscribe to specific metrics
        ws.subscriptions = message.metrics || [];
        break;
        
      case 'command':
        // Handle dashboard commands
        this.handleDashboardCommand(ws, message.command, message.params);
        break;
    }
  }
  
  /**
   * Handle dashboard commands
   */
  handleDashboardCommand(ws, command, params) {
    // Implement dashboard commands (e.g., reset stats, change settings)
    this.logger.info('Dashboard command received', { command, params });
  }
  
  /**
   * Start metrics updates
   */
  startMetricsUpdates() {
    // Listen for alerts
    this.metricsCollector.on('alert', (alert) => {
      this.broadcastAlert(alert);
    });
    
    // Send periodic updates
    this.updateTimer = setInterval(() => {
      const metrics = this.metricsCollector.getCurrentMetrics();
      this.broadcastMetrics(metrics);
    }, this.config.updateInterval);
  }
  
  /**
   * Broadcast metrics to all clients
   */
  broadcastMetrics(metrics) {
    const message = JSON.stringify({
      type: 'metrics',
      data: metrics,
      timestamp: Date.now()
    });
    
    for (const client of this.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    }
  }
  
  /**
   * Broadcast alert to all clients
   */
  broadcastAlert(alert) {
    const message = JSON.stringify({
      type: 'alert',
      data: alert,
      timestamp: Date.now()
    });
    
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(message);
      }
    }
  }
  
  /**
   * Check HTTP authentication
   */
  checkAuth(req) {
    if (!this.config.apiKey) return true;
    
    const auth = req.headers.authorization;
    if (!auth) return false;
    
    const [type, key] = auth.split(' ');
    return type === 'Bearer' && key === this.config.apiKey;
  }
  
  /**
   * Check WebSocket authentication
   */
  checkWebSocketAuth(req) {
    if (!this.config.apiKey) return true;
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = url.searchParams.get('key');
    
    return key === this.config.apiKey;
  }
}

export default DashboardServer;