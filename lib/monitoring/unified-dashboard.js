/**
 * Unified Dashboard System - Otedama-P2P Mining Pool++
 * Consolidated monitoring and dashboard functionality
 * 
 * Features:
 * - Real-time performance metrics
 * - Mining analytics
 * - Health monitoring
 * - Alert management
 * - WebSocket real-time updates
 */

import { EventEmitter } from 'events';
import http from 'http';
import { WebSocketServer } from 'ws';
import { createStructuredLogger } from '../core/structured-logger.js';
import { PrometheusExporter } from './prometheus-exporter.js';
import { MetricsCollector } from './metrics-collector.js';

const logger = createStructuredLogger('UnifiedDashboard');

/**
 * Unified dashboard server
 */
export class UnifiedDashboard extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      host: config.host || '0.0.0.0',
      port: config.port || 8082,
      wsPort: config.wsPort || 8083,
      updateInterval: config.updateInterval || 1000,
      metricsRetention: config.metricsRetention || 3600000, // 1 hour
      alertThresholds: {
        cpuUsage: config.alertThresholds?.cpuUsage || 80,
        memoryUsage: config.alertThresholds?.memoryUsage || 85,
        latency: config.alertThresholds?.latency || 100,
        errorRate: config.alertThresholds?.errorRate || 0.05
      }
    };
    
    this.metrics = new MetricsCollector();
    this.prometheusExporter = new PrometheusExporter();
    this.httpServer = null;
    this.wsServer = null;
    this.clients = new Set();
    
    this.dashboardData = {
      pool: {
        hashrate: 0,
        activeMiners: 0,
        totalShares: 0,
        blocksFound: 0
      },
      performance: {
        cpuUsage: 0,
        memoryUsage: 0,
        latency: 0,
        sharesPerSecond: 0
      },
      network: {
        connections: 0,
        bandwidth: 0,
        regions: {}
      },
      alerts: []
    };
  }
  
  /**
   * Start the unified dashboard
   */
  async start() {
    logger.info('Starting unified dashboard', {
      host: this.config.host,
      port: this.config.port,
      wsPort: this.config.wsPort
    });
    
    try {
      // Start HTTP server
      await this.startHttpServer();
      
      // Start WebSocket server
      await this.startWebSocketServer();
      
      // Start metrics collection
      this.startMetricsCollection();
      
      // Start alert monitoring
      this.startAlertMonitoring();
      
      logger.info('Unified dashboard started successfully');
    } catch (error) {
      logger.error('Failed to start dashboard:', error);
      throw error;
    }
  }
  
  /**
   * Start HTTP server
   */
  async startHttpServer() {
    this.httpServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      
      switch (url.pathname) {
        case '/':
          this.serveDashboard(req, res);
          break;
        case '/api/metrics':
          this.serveMetrics(req, res);
          break;
        case '/api/alerts':
          this.serveAlerts(req, res);
          break;
        case '/metrics':
          this.servePrometheusMetrics(req, res);
          break;
        default:
          res.writeHead(404);
          res.end('Not found');
      }
    });
    
    await new Promise((resolve, reject) => {
      this.httpServer.listen(this.config.port, this.config.host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    logger.info(`HTTP server listening on http://${this.config.host}:${this.config.port}`);
  }
  
  /**
   * Start WebSocket server
   */
  async startWebSocketServer() {
    this.wsServer = new WebSocketServer({
      port: this.config.wsPort,
      host: this.config.host
    });
    
    this.wsServer.on('connection', (ws) => {
      this.clients.add(ws);
      
      // Send initial data
      ws.send(JSON.stringify({
        type: 'initial',
        data: this.dashboardData
      }));
      
      ws.on('close', () => {
        this.clients.delete(ws);
      });
      
      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
        this.clients.delete(ws);
      });
    });
    
    logger.info(`WebSocket server listening on ws://${this.config.host}:${this.config.wsPort}`);
  }
  
  /**
   * Serve main dashboard HTML
   */
  serveDashboard(req, res) {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Otedama Mining Pool Dashboard</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }
        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .stat-value {
            font-size: 2em;
            font-weight: bold;
            color: #333;
        }
        .stat-label {
            color: #666;
            margin-top: 5px;
        }
        .chart-container {
            background: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            margin-bottom: 20px;
        }
        .alert {
            padding: 15px;
            margin: 10px 0;
            border-radius: 5px;
            color: white;
        }
        .alert-warning { background-color: #f39c12; }
        .alert-critical { background-color: #e74c3c; }
        .alert-info { background-color: #3498db; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Otedama Mining Pool Dashboard</h1>
            <p>Real-time monitoring and analytics</p>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value" id="hashrate">0 TH/s</div>
                <div class="stat-label">Pool Hashrate</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="miners">0</div>
                <div class="stat-label">Active Miners</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="shares">0</div>
                <div class="stat-label">Shares/sec</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="blocks">0</div>
                <div class="stat-label">Blocks Found</div>
            </div>
        </div>
        
        <div class="chart-container">
            <h3>Performance Metrics</h3>
            <canvas id="performanceChart" width="400" height="200"></canvas>
        </div>
        
        <div id="alerts"></div>
    </div>
    
    <script>
        const ws = new WebSocket('ws://' + window.location.hostname + ':${this.config.wsPort}');
        
        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            updateDashboard(message.data);
        };
        
        function updateDashboard(data) {
            // Update stats
            document.getElementById('hashrate').textContent = formatHashrate(data.pool.hashrate);
            document.getElementById('miners').textContent = data.pool.activeMiners;
            document.getElementById('shares').textContent = data.performance.sharesPerSecond;
            document.getElementById('blocks').textContent = data.pool.blocksFound;
            
            // Update alerts
            const alertsContainer = document.getElementById('alerts');
            alertsContainer.innerHTML = '';
            data.alerts.forEach(alert => {
                const alertDiv = document.createElement('div');
                alertDiv.className = 'alert alert-' + alert.severity;
                alertDiv.textContent = alert.message;
                alertsContainer.appendChild(alertDiv);
            });
        }
        
        function formatHashrate(hashrate) {
            const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
            let unitIndex = 0;
            let value = hashrate;
            
            while (value >= 1000 && unitIndex < units.length - 1) {
                value /= 1000;
                unitIndex++;
            }
            
            return value.toFixed(2) + ' ' + units[unitIndex];
        }
    </script>
</body>
</html>
    `;
    
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }
  
  /**
   * Serve metrics API
   */
  serveMetrics(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.dashboardData));
  }
  
  /**
   * Serve alerts API
   */
  serveAlerts(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ alerts: this.dashboardData.alerts }));
  }
  
  /**
   * Serve Prometheus metrics
   */
  async servePrometheusMetrics(req, res) {
    const metrics = await this.prometheusExporter.getMetrics();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(metrics);
  }
  
  /**
   * Start metrics collection
   */
  startMetricsCollection() {
    setInterval(() => {
      this.updateDashboardData();
      this.broadcastUpdate();
    }, this.config.updateInterval);
  }
  
  /**
   * Update dashboard data
   */
  updateDashboardData() {
    const currentMetrics = this.metrics.getCurrentMetrics();
    
    this.dashboardData = {
      pool: {
        hashrate: currentMetrics.poolHashrate || 0,
        activeMiners: currentMetrics.activeMiners || 0,
        totalShares: currentMetrics.totalShares || 0,
        blocksFound: currentMetrics.blocksFound || 0
      },
      performance: {
        cpuUsage: currentMetrics.cpuUsage || 0,
        memoryUsage: currentMetrics.memoryUsage || 0,
        latency: currentMetrics.averageLatency || 0,
        sharesPerSecond: currentMetrics.sharesPerSecond || 0
      },
      network: {
        connections: currentMetrics.connections || 0,
        bandwidth: currentMetrics.bandwidth || 0,
        regions: currentMetrics.regions || {}
      },
      alerts: this.dashboardData.alerts
    };
  }
  
  /**
   * Broadcast updates to WebSocket clients
   */
  broadcastUpdate() {
    const message = JSON.stringify({
      type: 'update',
      data: this.dashboardData
    });
    
    for (const client of this.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    }
  }
  
  /**
   * Start alert monitoring
   */
  startAlertMonitoring() {
    setInterval(() => {
      this.checkAlerts();
    }, 5000);
  }
  
  /**
   * Check for alerts
   */
  checkAlerts() {
    const alerts = [];
    const { performance } = this.dashboardData;
    const { alertThresholds } = this.config;
    
    if (performance.cpuUsage > alertThresholds.cpuUsage) {
      alerts.push({
        severity: 'warning',
        message: `High CPU usage: ${performance.cpuUsage.toFixed(1)}%`,
        timestamp: Date.now()
      });
    }
    
    if (performance.memoryUsage > alertThresholds.memoryUsage) {
      alerts.push({
        severity: 'warning',
        message: `High memory usage: ${performance.memoryUsage.toFixed(1)}%`,
        timestamp: Date.now()
      });
    }
    
    if (performance.latency > alertThresholds.latency) {
      alerts.push({
        severity: 'warning',
        message: `High latency: ${performance.latency.toFixed(1)}ms`,
        timestamp: Date.now()
      });
    }
    
    // Keep only recent alerts
    this.dashboardData.alerts = alerts.filter(
      alert => Date.now() - alert.timestamp < 300000 // 5 minutes
    );
  }
  
  /**
   * Update pool metrics
   */
  updatePoolMetrics(metrics) {
    this.metrics.updateMetrics('pool', metrics);
  }
  
  /**
   * Update performance metrics
   */
  updatePerformanceMetrics(metrics) {
    this.metrics.updateMetrics('performance', metrics);
  }
  
  /**
   * Shutdown dashboard
   */
  async shutdown() {
    logger.info('Shutting down unified dashboard');
    
    // Close WebSocket connections
    for (const client of this.clients) {
      client.close();
    }
    
    // Close servers
    if (this.wsServer) {
      this.wsServer.close();
    }
    
    if (this.httpServer) {
      this.httpServer.close();
    }
    
    this.emit('shutdown');
  }
}

// Export for use in other modules
export default UnifiedDashboard;