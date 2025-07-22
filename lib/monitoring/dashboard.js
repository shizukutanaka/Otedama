/**
 * Real-time Monitoring Dashboard for Otedama
 * Provides web-based monitoring interface
 * 
 * Design principles:
 * - Carmack: Fast updates, minimal latency
 * - Martin: Clean dashboard architecture
 * - Pike: Simple and effective visualization
 */

import { EventEmitter } from 'events';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from '../core/logger.js';
import { getMonitor } from '../profiling/performance-monitor.js';
import { getProfiler } from '../profiling/profiler.js';

const logger = getLogger('Dashboard');

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Dashboard configuration
 */
export const DashboardConfig = {
  UPDATE_INTERVAL: 1000,      // 1 second
  HISTORY_SIZE: 300,          // 5 minutes of data
  METRIC_RETENTION: 3600000,  // 1 hour
  MAX_ALERTS: 100,
  MAX_LOGS: 1000
};

/**
 * Monitoring dashboard server
 */
export class MonitoringDashboard extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      port: options.port || 3001,
      host: options.host || '0.0.0.0',
      updateInterval: options.updateInterval || DashboardConfig.UPDATE_INTERVAL,
      historySize: options.historySize || DashboardConfig.HISTORY_SIZE,
      auth: options.auth || null,
      cors: options.cors !== false,
      ...options
    };
    
    // Components
    this.server = null;
    this.wss = null;
    this.clients = new Set();
    
    // Data storage
    this.metricsHistory = new Map();
    this.alerts = [];
    this.logs = [];
    this.traceData = [];
    
    // Update timer
    this.updateTimer = null;
    
    // Performance monitor
    this.monitor = options.monitor || getMonitor();
    this.profiler = options.profiler || getProfiler();
    
    // Metrics
    this.dashboardMetrics = {
      connectedClients: 0,
      messagesPerSecond: 0,
      updatesSent: 0,
      errors: 0
    };
  }
  
  /**
   * Start dashboard server
   */
  async start() {
    // Create HTTP server
    this.server = createServer((req, res) => {
      this._handleHttpRequest(req, res);
    });
    
    // Create WebSocket server
    this.wss = new WebSocketServer({ 
      server: this.server,
      path: '/ws'
    });
    
    // Setup WebSocket handlers
    this._setupWebSocketHandlers();
    
    // Start listening
    await new Promise((resolve, reject) => {
      this.server.listen(this.options.port, this.options.host, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    
    // Start data collection
    this._startDataCollection();
    
    logger.info(`Monitoring dashboard started on http://${this.options.host}:${this.options.port}`);
    this.emit('started');
  }
  
  /**
   * Stop dashboard server
   */
  async stop() {
    // Stop data collection
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    
    // Close all WebSocket connections
    for (const client of this.clients) {
      client.close();
    }
    
    // Close WebSocket server
    if (this.wss) {
      await new Promise(resolve => {
        this.wss.close(resolve);
      });
    }
    
    // Close HTTP server
    if (this.server) {
      await new Promise(resolve => {
        this.server.close(resolve);
      });
    }
    
    logger.info('Monitoring dashboard stopped');
    this.emit('stopped');
  }
  
  /**
   * Handle HTTP requests
   */
  _handleHttpRequest(req, res) {
    // CORS headers
    if (this.options.cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    
    // Handle auth if configured
    if (this.options.auth && !this._checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    
    // Route requests
    if (req.url === '/' || req.url === '/index.html') {
      this._serveDashboard(res);
    } else if (req.url === '/api/metrics') {
      this._serveMetrics(res);
    } else if (req.url === '/api/alerts') {
      this._serveAlerts(res);
    } else if (req.url === '/api/logs') {
      this._serveLogs(res);
    } else if (req.url === '/api/traces') {
      this._serveTraces(res);
    } else if (req.url === '/api/profile') {
      this._serveProfile(res);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }
  
  /**
   * Serve dashboard HTML
   */
  _serveDashboard(res) {
    const html = this._generateDashboardHTML();
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Content-Length': Buffer.byteLength(html)
    });
    res.end(html);
  }
  
  /**
   * Generate dashboard HTML
   */
  _generateDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Otedama Monitoring Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0a0a;
            color: #e0e0e0;
            line-height: 1.6;
        }
        
        .header {
            background: #1a1a1a;
            padding: 1rem 2rem;
            border-bottom: 1px solid #333;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .header h1 {
            font-size: 1.5rem;
            font-weight: 300;
        }
        
        .status {
            display: flex;
            align-items: center;
            gap: 1rem;
        }
        
        .status-indicator {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #4caf50;
        }
        
        .status-indicator.disconnected {
            background: #f44336;
        }
        
        .container {
            padding: 2rem;
            max-width: 1400px;
            margin: 0 auto;
        }
        
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }
        
        .metric-card {
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 1.5rem;
        }
        
        .metric-card h3 {
            font-size: 0.875rem;
            color: #888;
            margin-bottom: 0.5rem;
            text-transform: uppercase;
        }
        
        .metric-value {
            font-size: 2rem;
            font-weight: 300;
            color: #fff;
        }
        
        .metric-unit {
            font-size: 0.875rem;
            color: #666;
            margin-left: 0.25rem;
        }
        
        .charts-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }
        
        .chart-container {
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 1.5rem;
            height: 300px;
        }
        
        .chart-title {
            font-size: 1rem;
            margin-bottom: 1rem;
            color: #fff;
        }
        
        .chart {
            width: 100%;
            height: calc(100% - 2rem);
        }
        
        .alerts-container {
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 1.5rem;
            margin-bottom: 2rem;
        }
        
        .alerts-title {
            font-size: 1rem;
            margin-bottom: 1rem;
            color: #fff;
        }
        
        .alert-item {
            padding: 0.75rem;
            margin-bottom: 0.5rem;
            border-radius: 4px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .alert-item.info {
            background: #1976d2;
        }
        
        .alert-item.warning {
            background: #ff9800;
        }
        
        .alert-item.critical {
            background: #f44336;
        }
        
        .logs-container {
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 1.5rem;
            height: 400px;
            overflow-y: auto;
        }
        
        .log-entry {
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 0.875rem;
            padding: 0.25rem 0;
            border-bottom: 1px solid #222;
        }
        
        .log-entry.error {
            color: #f44336;
        }
        
        .log-entry.warn {
            color: #ff9800;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Otedama Monitoring Dashboard</h1>
        <div class="status">
            <span id="connection-status">Disconnected</span>
            <div class="status-indicator disconnected" id="status-indicator"></div>
        </div>
    </div>
    
    <div class="container">
        <div class="metrics-grid" id="metrics-grid"></div>
        
        <div class="charts-grid">
            <div class="chart-container">
                <h3 class="chart-title">CPU Usage</h3>
                <canvas class="chart" id="cpu-chart"></canvas>
            </div>
            
            <div class="chart-container">
                <h3 class="chart-title">Memory Usage</h3>
                <canvas class="chart" id="memory-chart"></canvas>
            </div>
            
            <div class="chart-container">
                <h3 class="chart-title">Request Rate</h3>
                <canvas class="chart" id="request-chart"></canvas>
            </div>
            
            <div class="chart-container">
                <h3 class="chart-title">Response Time</h3>
                <canvas class="chart" id="response-chart"></canvas>
            </div>
        </div>
        
        <div class="alerts-container">
            <h3 class="alerts-title">Active Alerts</h3>
            <div id="alerts-list"></div>
        </div>
        
        <div class="logs-container">
            <h3 class="alerts-title">Recent Logs</h3>
            <div id="logs-list"></div>
        </div>
    </div>
    
    <script src="https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js"></script>
    <script>
        ${this._generateDashboardScript()}
    </script>
</body>
</html>`;
  }
  
  /**
   * Generate dashboard JavaScript
   */
  _generateDashboardScript() {
    return `
        // WebSocket connection
        let ws = null;
        let reconnectTimer = null;
        
        // Chart instances
        const charts = {};
        const chartData = {
            cpu: [],
            memory: [],
            requests: [],
            responseTime: []
        };
        
        // Chart configuration
        const chartOptions = {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                x: {
                    display: false
                },
                y: {
                    beginAtZero: true,
                    grid: {
                        color: '#333'
                    },
                    ticks: {
                        color: '#888'
                    }
                }
            }
        };
        
        // Initialize charts
        function initCharts() {
            const ctx = {
                cpu: document.getElementById('cpu-chart').getContext('2d'),
                memory: document.getElementById('memory-chart').getContext('2d'),
                request: document.getElementById('request-chart').getContext('2d'),
                response: document.getElementById('response-chart').getContext('2d')
            };
            
            charts.cpu = new Chart(ctx.cpu, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        data: [],
                        borderColor: '#4caf50',
                        backgroundColor: 'rgba(76, 175, 80, 0.1)',
                        tension: 0.4
                    }]
                },
                options: {
                    ...chartOptions,
                    scales: {
                        ...chartOptions.scales,
                        y: {
                            ...chartOptions.scales.y,
                            max: 100
                        }
                    }
                }
            });
            
            charts.memory = new Chart(ctx.memory, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        data: [],
                        borderColor: '#2196f3',
                        backgroundColor: 'rgba(33, 150, 243, 0.1)',
                        tension: 0.4
                    }]
                },
                options: chartOptions
            });
            
            charts.request = new Chart(ctx.request, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        data: [],
                        borderColor: '#ff9800',
                        backgroundColor: 'rgba(255, 152, 0, 0.1)',
                        tension: 0.4
                    }]
                },
                options: chartOptions
            });
            
            charts.response = new Chart(ctx.response, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        data: [],
                        borderColor: '#e91e63',
                        backgroundColor: 'rgba(233, 30, 99, 0.1)',
                        tension: 0.4
                    }]
                },
                options: chartOptions
            });
        }
        
        // Connect to WebSocket
        function connect() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = protocol + '//' + window.location.host + '/ws';
            
            ws = new WebSocket(wsUrl);
            
            ws.onopen = () => {
                console.log('Connected to monitoring dashboard');
                updateConnectionStatus(true);
                
                // Request initial data
                ws.send(JSON.stringify({ type: 'subscribe' }));
            };
            
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                handleUpdate(data);
            };
            
            ws.onclose = () => {
                console.log('Disconnected from monitoring dashboard');
                updateConnectionStatus(false);
                
                // Reconnect after 3 seconds
                if (!reconnectTimer) {
                    reconnectTimer = setTimeout(() => {
                        reconnectTimer = null;
                        connect();
                    }, 3000);
                }
            };
            
            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };
        }
        
        // Update connection status
        function updateConnectionStatus(connected) {
            const statusText = document.getElementById('connection-status');
            const statusIndicator = document.getElementById('status-indicator');
            
            if (connected) {
                statusText.textContent = 'Connected';
                statusIndicator.classList.remove('disconnected');
            } else {
                statusText.textContent = 'Disconnected';
                statusIndicator.classList.add('disconnected');
            }
        }
        
        // Handle updates from server
        function handleUpdate(data) {
            switch (data.type) {
                case 'metrics':
                    updateMetrics(data.metrics);
                    updateCharts(data.metrics);
                    break;
                    
                case 'alerts':
                    updateAlerts(data.alerts);
                    break;
                    
                case 'logs':
                    updateLogs(data.logs);
                    break;
            }
        }
        
        // Update metric cards
        function updateMetrics(metrics) {
            const grid = document.getElementById('metrics-grid');
            
            const cards = [
                { title: 'CPU Usage', value: metrics.cpu_usage_percent || 0, unit: '%' },
                { title: 'Memory Usage', value: ((metrics.memory_heap_used_bytes || 0) / 1024 / 1024).toFixed(1), unit: 'MB' },
                { title: 'Active Connections', value: metrics.active_connections || 0, unit: '' },
                { title: 'Request Rate', value: metrics.request_rate || 0, unit: 'req/s' },
                { title: 'Response Time', value: metrics.avg_response_time || 0, unit: 'ms' },
                { title: 'Error Rate', value: metrics.error_rate || 0, unit: '%' }
            ];
            
            grid.innerHTML = cards.map(card => 
                '<div class="metric-card">' +
                '<h3>' + card.title + '</h3>' +
                '<div class="metric-value">' + card.value + 
                '<span class="metric-unit">' + card.unit + '</span></div>' +
                '</div>'
            ).join('');
        }
        
        // Update charts
        function updateCharts(metrics) {
            const timestamp = new Date().toLocaleTimeString();
            const maxPoints = 60;
            
            // Update CPU chart
            if (charts.cpu) {
                charts.cpu.data.labels.push(timestamp);
                charts.cpu.data.datasets[0].data.push(metrics.cpu_usage_percent || 0);
                
                if (charts.cpu.data.labels.length > maxPoints) {
                    charts.cpu.data.labels.shift();
                    charts.cpu.data.datasets[0].data.shift();
                }
                
                charts.cpu.update('none');
            }
            
            // Update memory chart
            if (charts.memory) {
                const memoryMB = (metrics.memory_heap_used_bytes || 0) / 1024 / 1024;
                charts.memory.data.labels.push(timestamp);
                charts.memory.data.datasets[0].data.push(memoryMB);
                
                if (charts.memory.data.labels.length > maxPoints) {
                    charts.memory.data.labels.shift();
                    charts.memory.data.datasets[0].data.shift();
                }
                
                charts.memory.update('none');
            }
            
            // Update request rate chart
            if (charts.request) {
                charts.request.data.labels.push(timestamp);
                charts.request.data.datasets[0].data.push(metrics.request_rate || 0);
                
                if (charts.request.data.labels.length > maxPoints) {
                    charts.request.data.labels.shift();
                    charts.request.data.datasets[0].data.shift();
                }
                
                charts.request.update('none');
            }
            
            // Update response time chart
            if (charts.response) {
                charts.response.data.labels.push(timestamp);
                charts.response.data.datasets[0].data.push(metrics.avg_response_time || 0);
                
                if (charts.response.data.labels.length > maxPoints) {
                    charts.response.data.labels.shift();
                    charts.response.data.datasets[0].data.shift();
                }
                
                charts.response.update('none');
            }
        }
        
        // Update alerts
        function updateAlerts(alerts) {
            const list = document.getElementById('alerts-list');
            
            if (alerts.length === 0) {
                list.innerHTML = '<p style="color: #666; text-align: center;">No active alerts</p>';
            } else {
                list.innerHTML = alerts.map(alert => 
                    '<div class="alert-item ' + alert.level + '">' +
                    '<span>' + alert.message + '</span>' +
                    '<span>' + new Date(alert.triggeredAt).toLocaleTimeString() + '</span>' +
                    '</div>'
                ).join('');
            }
        }
        
        // Update logs
        function updateLogs(logs) {
            const list = document.getElementById('logs-list');
            
            list.innerHTML = logs.map(log => 
                '<div class="log-entry ' + log.level + '">' +
                '[' + new Date(log.timestamp).toLocaleTimeString() + '] ' +
                '[' + log.level.toUpperCase() + '] ' +
                log.message +
                '</div>'
            ).join('');
            
            // Auto-scroll to bottom
            list.scrollTop = list.scrollHeight;
        }
        
        // Initialize
        document.addEventListener('DOMContentLoaded', () => {
            initCharts();
            connect();
        });
        
        // Cleanup on unload
        window.addEventListener('beforeunload', () => {
            if (ws) {
                ws.close();
            }
        });
    `;
  }
  
  /**
   * Serve metrics API
   */
  _serveMetrics(res) {
    const metrics = this._collectMetrics();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metrics));
  }
  
  /**
   * Serve alerts API
   */
  _serveAlerts(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.alerts));
  }
  
  /**
   * Serve logs API
   */
  _serveLogs(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.logs));
  }
  
  /**
   * Serve traces API
   */
  _serveTraces(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.traceData));
  }
  
  /**
   * Serve profile API
   */
  _serveProfile(res) {
    const report = this.profiler.getReport();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(report));
  }
  
  /**
   * Setup WebSocket handlers
   */
  _setupWebSocketHandlers() {
    this.wss.on('connection', (ws, req) => {
      logger.info('New dashboard client connected', { 
        ip: req.socket.remoteAddress 
      });
      
      // Add to clients
      this.clients.add(ws);
      this.dashboardMetrics.connectedClients = this.clients.size;
      
      // Setup client handlers
      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          this._handleClientMessage(ws, data);
        } catch (error) {
          logger.error('Invalid WebSocket message', error);
        }
      });
      
      ws.on('close', () => {
        this.clients.delete(ws);
        this.dashboardMetrics.connectedClients = this.clients.size;
        logger.info('Dashboard client disconnected');
      });
      
      ws.on('error', (error) => {
        logger.error('WebSocket error', error);
        this.dashboardMetrics.errors++;
      });
      
      // Send initial data
      this._sendInitialData(ws);
    });
  }
  
  /**
   * Handle client messages
   */
  _handleClientMessage(ws, data) {
    switch (data.type) {
      case 'subscribe':
        // Client wants real-time updates
        ws.subscribed = true;
        break;
        
      case 'unsubscribe':
        ws.subscribed = false;
        break;
        
      case 'command':
        // Handle dashboard commands
        this._handleCommand(data.command, data.params);
        break;
    }
  }
  
  /**
   * Send initial data to client
   */
  _sendInitialData(ws) {
    // Send current metrics
    const metrics = this._collectMetrics();
    this._sendToClient(ws, {
      type: 'metrics',
      metrics
    });
    
    // Send alerts
    this._sendToClient(ws, {
      type: 'alerts',
      alerts: this.alerts
    });
    
    // Send recent logs
    this._sendToClient(ws, {
      type: 'logs',
      logs: this.logs.slice(-50)
    });
  }
  
  /**
   * Start data collection
   */
  _startDataCollection() {
    // Monitor performance metrics
    this.monitor.on('metrics:collected', (metrics) => {
      this._updateMetricsHistory(metrics);
    });
    
    // Monitor alerts
    this.monitor.on('alert:triggered', (alert) => {
      this.alerts.unshift(alert);
      if (this.alerts.length > DashboardConfig.MAX_ALERTS) {
        this.alerts.pop();
      }
      
      this._broadcast({
        type: 'alerts',
        alerts: this.alerts
      });
    });
    
    // Monitor logs
    this._setupLogCapture();
    
    // Start update timer
    this.updateTimer = setInterval(() => {
      this._sendUpdates();
    }, this.options.updateInterval);
  }
  
  /**
   * Setup log capture
   */
  _setupLogCapture() {
    // Intercept logger
    const originalLog = logger._log.bind(logger);
    logger._log = (level, message, metadata) => {
      // Call original
      originalLog(level, message, metadata);
      
      // Capture for dashboard
      this.logs.unshift({
        timestamp: Date.now(),
        level,
        message,
        metadata
      });
      
      if (this.logs.length > DashboardConfig.MAX_LOGS) {
        this.logs.pop();
      }
    };
  }
  
  /**
   * Update metrics history
   */
  _updateMetricsHistory(metrics) {
    const timestamp = Date.now();
    
    for (const [key, value] of Object.entries(metrics)) {
      if (!this.metricsHistory.has(key)) {
        this.metricsHistory.set(key, []);
      }
      
      const history = this.metricsHistory.get(key);
      history.push({ timestamp, value });
      
      // Trim old data
      const cutoff = timestamp - DashboardConfig.METRIC_RETENTION;
      while (history.length > 0 && history[0].timestamp < cutoff) {
        history.shift();
      }
    }
  }
  
  /**
   * Send updates to all clients
   */
  _sendUpdates() {
    const metrics = this._collectMetrics();
    const update = {
      type: 'metrics',
      metrics
    };
    
    this._broadcast(update);
    this.dashboardMetrics.updatesSent++;
  }
  
  /**
   * Collect current metrics
   */
  _collectMetrics() {
    const systemMetrics = this.monitor.getMetrics();
    const customMetrics = this._calculateCustomMetrics();
    
    return {
      ...systemMetrics,
      ...customMetrics,
      dashboard: this.dashboardMetrics
    };
  }
  
  /**
   * Calculate custom metrics
   */
  _calculateCustomMetrics() {
    // Calculate request rate from history
    const requestHistory = this.metricsHistory.get('request_count') || [];
    const now = Date.now();
    const recentRequests = requestHistory.filter(r => now - r.timestamp < 60000);
    const requestRate = recentRequests.length > 1 ? 
      (recentRequests[recentRequests.length - 1].value - recentRequests[0].value) / 60 : 0;
    
    // Calculate error rate
    const errorHistory = this.metricsHistory.get('error_count') || [];
    const recentErrors = errorHistory.filter(e => now - e.timestamp < 60000);
    const errorRate = requestRate > 0 ? (recentErrors.length / requestRate * 100) : 0;
    
    // Calculate average response time
    const responseHistory = this.metricsHistory.get('response_time') || [];
    const avgResponseTime = responseHistory.length > 0 ?
      responseHistory.reduce((sum, r) => sum + r.value, 0) / responseHistory.length : 0;
    
    return {
      request_rate: Math.round(requestRate * 10) / 10,
      error_rate: Math.round(errorRate * 10) / 10,
      avg_response_time: Math.round(avgResponseTime)
    };
  }
  
  /**
   * Send to specific client
   */
  _sendToClient(ws, data) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
  
  /**
   * Broadcast to all subscribed clients
   */
  _broadcast(data) {
    const message = JSON.stringify(data);
    let sent = 0;
    
    for (const client of this.clients) {
      if (client.readyState === client.OPEN && client.subscribed) {
        client.send(message);
        sent++;
      }
    }
    
    this.dashboardMetrics.messagesPerSecond = sent;
  }
  
  /**
   * Handle dashboard commands
   */
  _handleCommand(command, params) {
    switch (command) {
      case 'clearAlerts':
        this.alerts = [];
        this._broadcast({ type: 'alerts', alerts: [] });
        break;
        
      case 'clearLogs':
        this.logs = [];
        this._broadcast({ type: 'logs', logs: [] });
        break;
        
      case 'startProfile':
        this.profiler.startProfile(params.name, params.type, params.options);
        break;
        
      case 'stopProfile':
        this.profiler.stopProfile(params.name);
        break;
    }
  }
  
  /**
   * Check authentication
   */
  _checkAuth(req) {
    if (!this.options.auth) return true;
    
    const auth = req.headers.authorization;
    if (!auth) return false;
    
    const [type, credentials] = auth.split(' ');
    if (type !== 'Bearer') return false;
    
    return credentials === this.options.auth.token;
  }
}

export default MonitoringDashboard;