/**
 * Real-time Log Dashboard
 * 
 * Web-based dashboard for log analysis visualization
 * Real-time metrics, pattern tracking, and alert management
 */

import { EventEmitter } from 'events';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

export class LogDashboard extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      port: options.port || 3334,
      host: options.host || 'localhost',
      enableAuth: options.enableAuth !== false,
      enableAlerts: options.enableAlerts !== false,
      updateInterval: options.updateInterval || 5000,
      retentionPeriod: options.retentionPeriod || 7 * 24 * 3600 * 1000, // 7 days
      maxDataPoints: options.maxDataPoints || 1000,
      ...options
    };
    
    this.server = null;
    this.wsServer = null;
    this.clients = new Set();
    this.isRunning = false;
    
    // Dashboard data
    this.dashboardData = {
      metrics: {
        totalLogs: 0,
        errorRate: 0,
        warningRate: 0,
        processingSpeed: 0,
        memoryUsage: 0
      },
      patterns: new Map(),
      alerts: [],
      timeline: [],
      recentLogs: []
    };
    
    this.initialize();
  }
  
  /**
   * Initialize dashboard
   */
  async initialize() {
    try {
      await this.loadDashboardData();
      this.emit('initialized');
    } catch (error) {
      console.error('Dashboard initialization error:', error.message);
    }
  }
  
  /**
   * Start dashboard server
   */
  async start() {
    if (this.isRunning) {
      throw new Error('Dashboard already running');
    }
    
    console.log(`🌐 Starting log dashboard on ${this.options.host}:${this.options.port}`);
    
    // Create HTTP server
    this.server = createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });
    
    // Create WebSocket server
    this.wsServer = new WebSocketServer({ server: this.server });
    this.wsServer.on('connection', (ws) => {
      this.handleWebSocketConnection(ws);
    });
    
    // Start server
    await new Promise((resolve, reject) => {
      this.server.listen(this.options.port, this.options.host, (error) => {
        if (error) {
          reject(error);
        } else {
          this.isRunning = true;
          console.log(`✅ Dashboard running at http://${this.options.host}:${this.options.port}`);
          resolve();
        }
      });
    });
    
    // Start data update loop
    this.startDataUpdates();
    
    this.emit('started');
  }
  
  /**
   * Stop dashboard server
   */
  async stop() {
    if (!this.isRunning) return;
    
    console.log('🛑 Stopping log dashboard...');
    
    // Stop data updates
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
    
    // Close WebSocket connections
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    
    // Close servers
    if (this.wsServer) {
      this.wsServer.close();
    }
    
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
    }
    
    this.isRunning = false;
    console.log('✅ Dashboard stopped');
    this.emit('stopped');
  }
  
  /**
   * Handle HTTP requests
   */
  async handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    try {
      switch (url.pathname) {
        case '/':
          await this.serveDashboardHtml(res);
          break;
        case '/api/metrics':
          await this.serveMetrics(res);
          break;
        case '/api/patterns':
          await this.servePatterns(res);
          break;
        case '/api/alerts':
          await this.serveAlerts(res);
          break;
        case '/api/timeline':
          await this.serveTimeline(res);
          break;
        case '/api/recent':
          await this.serveRecentLogs(res);
          break;
        default:
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
      }
    } catch (error) {
      console.error('HTTP request error:', error.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }
  
  /**
   * Handle WebSocket connections
   */
  handleWebSocketConnection(ws) {
    console.log('📡 New WebSocket client connected');
    this.clients.add(ws);
    
    // Send initial data
    ws.send(JSON.stringify({
      type: 'initial_data',
      data: this.getDashboardSnapshot()
    }));
    
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        this.handleWebSocketMessage(ws, data);
      } catch (error) {
        console.error('WebSocket message error:', error.message);
      }
    });
    
    ws.on('close', () => {
      console.log('📡 WebSocket client disconnected');
      this.clients.delete(ws);
    });
    
    ws.on('error', (error) => {
      console.error('WebSocket error:', error.message);
      this.clients.delete(ws);
    });
  }
  
  /**
   * Handle WebSocket messages
   */
  handleWebSocketMessage(ws, data) {
    switch (data.type) {
      case 'get_metrics':
        ws.send(JSON.stringify({
          type: 'metrics',
          data: this.dashboardData.metrics
        }));
        break;
      case 'get_patterns':
        ws.send(JSON.stringify({
          type: 'patterns',
          data: Array.from(this.dashboardData.patterns.entries())
        }));
        break;
      case 'clear_alerts':
        this.dashboardData.alerts = [];
        this.broadcastUpdate('alerts', this.dashboardData.alerts);
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  }
  
  /**
   * Serve dashboard HTML
   */
  async serveDashboardHtml(res) {
    const html = this.generateDashboardHtml();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }
  
  /**
   * Generate dashboard HTML
   */
  generateDashboardHtml() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Otedama Log Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: #1a1a1a; 
            color: #e0e0e0; 
            line-height: 1.6;
        }
        .header { 
            background: #2d2d2d; 
            padding: 1rem; 
            border-bottom: 2px solid #4a90e2; 
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        }
        .header h1 { 
            color: #4a90e2; 
            display: flex; 
            align-items: center; 
            gap: 0.5rem;
        }
        .container { 
            max-width: 1400px; 
            margin: 0 auto; 
            padding: 2rem; 
        }
        .grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
            gap: 2rem; 
            margin-bottom: 2rem;
        }
        .card { 
            background: #2d2d2d; 
            border-radius: 8px; 
            padding: 1.5rem; 
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            border: 1px solid #404040;
        }
        .card h3 { 
            color: #4a90e2; 
            margin-bottom: 1rem; 
            display: flex; 
            align-items: center; 
            gap: 0.5rem;
        }
        .metric { 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            margin-bottom: 0.5rem; 
            padding: 0.5rem; 
            background: #1a1a1a; 
            border-radius: 4px;
        }
        .metric-value { 
            font-weight: bold; 
            color: #4a90e2; 
        }
        .status-indicator { 
            display: inline-block; 
            width: 12px; 
            height: 12px; 
            border-radius: 50%; 
            margin-right: 0.5rem;
        }
        .status-good { background: #28a745; }
        .status-warning { background: #ffc107; }
        .status-critical { background: #dc3545; }
        .pattern-list { 
            max-height: 300px; 
            overflow-y: auto; 
        }
        .pattern-item { 
            display: flex; 
            justify-content: space-between; 
            padding: 0.5rem; 
            background: #1a1a1a; 
            margin-bottom: 0.5rem; 
            border-radius: 4px;
        }
        .alert { 
            background: #3d1a1a; 
            border-left: 4px solid #dc3545; 
            padding: 1rem; 
            margin-bottom: 0.5rem; 
            border-radius: 4px;
        }
        .alert-high { border-left-color: #dc3545; }
        .alert-medium { border-left-color: #ffc107; }
        .alert-low { border-left-color: #17a2b8; }
        .timeline { 
            height: 200px; 
            background: #1a1a1a; 
            border-radius: 4px; 
            position: relative; 
            overflow: hidden;
        }
        .log-entry { 
            font-family: 'Courier New', monospace; 
            font-size: 0.9rem; 
            padding: 0.25rem 0.5rem; 
            border-bottom: 1px solid #404040;
        }
        .log-error { color: #ff6b6b; }
        .log-warning { color: #ffd93d; }
        .log-info { color: #6bcf7f; }
        .btn { 
            background: #4a90e2; 
            color: white; 
            border: none; 
            padding: 0.5rem 1rem; 
            border-radius: 4px; 
            cursor: pointer; 
            transition: background 0.2s;
        }
        .btn:hover { background: #357abd; }
        .connection-status { 
            position: fixed; 
            top: 1rem; 
            right: 1rem; 
            padding: 0.5rem 1rem; 
            border-radius: 4px; 
            font-size: 0.9rem;
        }
        .connected { background: #28a745; color: white; }
        .disconnected { background: #dc3545; color: white; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔍 Otedama Log Dashboard</h1>
    </div>
    
    <div class="connection-status" id="connectionStatus">
        <span class="status-indicator"></span>
        <span id="statusText">Connecting...</span>
    </div>
    
    <div class="container">
        <div class="grid">
            <div class="card">
                <h3>📊 System Metrics</h3>
                <div class="metric">
                    <span>Total Logs Processed</span>
                    <span class="metric-value" id="totalLogs">0</span>
                </div>
                <div class="metric">
                    <span>Error Rate</span>
                    <span class="metric-value" id="errorRate">0%</span>
                </div>
                <div class="metric">
                    <span>Processing Speed</span>
                    <span class="metric-value" id="processingSpeed">0 lines/sec</span>
                </div>
                <div class="metric">
                    <span>Memory Usage</span>
                    <span class="metric-value" id="memoryUsage">0 MB</span>
                </div>
            </div>
            
            <div class="card">
                <h3>🔍 Top Patterns</h3>
                <div class="pattern-list" id="patternList">
                    <div class="pattern-item">
                        <span>No patterns detected</span>
                        <span>0</span>
                    </div>
                </div>
            </div>
            
            <div class="card">
                <h3>⚠️ Active Alerts</h3>
                <div id="alertsList">
                    <p>No active alerts</p>
                </div>
                <button class="btn" onclick="clearAlerts()">Clear All Alerts</button>
            </div>
        </div>
        
        <div class="grid">
            <div class="card">
                <h3>📈 Activity Timeline</h3>
                <div class="timeline" id="timeline">
                    <canvas id="timelineChart" width="400" height="180"></canvas>
                </div>
            </div>
            
            <div class="card">
                <h3>📄 Recent Log Entries</h3>
                <div id="recentLogs" style="max-height: 300px; overflow-y: auto;">
                    <div class="log-entry">No recent logs</div>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        class LogDashboard {
            constructor() {
                this.ws = null;
                this.connected = false;
                this.reconnectTimer = null;
                this.init();
            }
            
            init() {
                this.connect();
                this.setupHeartbeat();
            }
            
            connect() {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = \`\${protocol}//\${window.location.host}\`;
                
                try {
                    this.ws = new WebSocket(wsUrl);
                    
                    this.ws.onopen = () => {
                        console.log('✅ Connected to dashboard');
                        this.connected = true;
                        this.updateConnectionStatus();
                        if (this.reconnectTimer) {
                            clearInterval(this.reconnectTimer);
                            this.reconnectTimer = null;
                        }
                    };
                    
                    this.ws.onmessage = (event) => {
                        const data = JSON.parse(event.data);
                        this.handleMessage(data);
                    };
                    
                    this.ws.onclose = () => {
                        console.log('❌ Disconnected from dashboard');
                        this.connected = false;
                        this.updateConnectionStatus();
                        this.scheduleReconnect();
                    };
                    
                    this.ws.onerror = (error) => {
                        console.error('WebSocket error:', error);
                    };
                } catch (error) {
                    console.error('Connection error:', error);
                    this.scheduleReconnect();
                }
            }
            
            scheduleReconnect() {
                if (!this.reconnectTimer) {
                    this.reconnectTimer = setInterval(() => {
                        console.log('🔄 Attempting to reconnect...');
                        this.connect();
                    }, 5000);
                }
            }
            
            setupHeartbeat() {
                setInterval(() => {
                    if (this.connected && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({ type: 'ping' }));
                    }
                }, 30000);
            }
            
            handleMessage(data) {
                switch (data.type) {
                    case 'initial_data':
                        this.updateDashboard(data.data);
                        break;
                    case 'metrics':
                        this.updateMetrics(data.data);
                        break;
                    case 'patterns':
                        this.updatePatterns(data.data);
                        break;
                    case 'alerts':
                        this.updateAlerts(data.data);
                        break;
                    case 'timeline':
                        this.updateTimeline(data.data);
                        break;
                    case 'recent_logs':
                        this.updateRecentLogs(data.data);
                        break;
                    case 'pong':
                        // Heartbeat response
                        break;
                }
            }
            
            updateDashboard(data) {
                this.updateMetrics(data.metrics);
                this.updatePatterns(data.patterns);
                this.updateAlerts(data.alerts);
                this.updateRecentLogs(data.recentLogs);
            }
            
            updateMetrics(metrics) {
                document.getElementById('totalLogs').textContent = metrics.totalLogs.toLocaleString();
                document.getElementById('errorRate').textContent = metrics.errorRate.toFixed(1) + '%';
                document.getElementById('processingSpeed').textContent = metrics.processingSpeed.toFixed(0) + ' lines/sec';
                document.getElementById('memoryUsage').textContent = metrics.memoryUsage.toFixed(1) + ' MB';
            }
            
            updatePatterns(patterns) {
                const list = document.getElementById('patternList');
                if (patterns.length === 0) {
                    list.innerHTML = '<div class="pattern-item"><span>No patterns detected</span><span>0</span></div>';
                    return;
                }
                
                list.innerHTML = patterns.slice(0, 10).map(([pattern, count]) => 
                    \`<div class="pattern-item"><span>\${pattern}</span><span>\${count.toLocaleString()}</span></div>\`
                ).join('');
            }
            
            updateAlerts(alerts) {
                const container = document.getElementById('alertsList');
                if (alerts.length === 0) {
                    container.innerHTML = '<p>No active alerts</p>';
                    return;
                }
                
                container.innerHTML = alerts.map(alert => 
                    \`<div class="alert alert-\${alert.severity}">
                        <strong>\${alert.type}</strong>: \${alert.message}
                        <br><small>\${new Date(alert.timestamp).toLocaleString()}</small>
                    </div>\`
                ).join('');
            }
            
            updateRecentLogs(logs) {
                const container = document.getElementById('recentLogs');
                if (logs.length === 0) {
                    container.innerHTML = '<div class="log-entry">No recent logs</div>';
                    return;
                }
                
                container.innerHTML = logs.map(log => {
                    const className = log.level === 'ERROR' ? 'log-error' : 
                                     log.level === 'WARN' ? 'log-warning' : 'log-info';
                    const time = new Date(log.timestamp).toLocaleTimeString();
                    return \`<div class="log-entry \${className}">\${time} [\${log.level}] \${log.message}</div>\`;
                }).join('');
                
                container.scrollTop = container.scrollHeight;
            }
            
            updateConnectionStatus() {
                const status = document.getElementById('connectionStatus');
                const text = document.getElementById('statusText');
                
                if (this.connected) {
                    status.className = 'connection-status connected';
                    text.textContent = 'Connected';
                } else {
                    status.className = 'connection-status disconnected';
                    text.textContent = 'Disconnected';
                }
            }
        }
        
        function clearAlerts() {
            if (window.dashboard && window.dashboard.connected) {
                window.dashboard.ws.send(JSON.stringify({ type: 'clear_alerts' }));
            }
        }
        
        // Initialize dashboard
        window.dashboard = new LogDashboard();
    </script>
</body>
</html>`;
  }
  
  /**
   * Serve API endpoints
   */
  async serveMetrics(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.dashboardData.metrics));
  }
  
  async servePatterns(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.from(this.dashboardData.patterns.entries())));
  }
  
  async serveAlerts(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.dashboardData.alerts));
  }
  
  async serveTimeline(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.dashboardData.timeline));
  }
  
  async serveRecentLogs(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.dashboardData.recentLogs));
  }
  
  /**
   * Start data updates
   */
  startDataUpdates() {
    this.updateTimer = setInterval(() => {
      this.generateSampleData();
      this.broadcastUpdate('all', this.getDashboardSnapshot());
    }, this.options.updateInterval);
  }
  
  /**
   * Generate sample data for demonstration
   */
  generateSampleData() {
    // Simulate real-time metrics
    this.dashboardData.metrics = {
      totalLogs: Math.floor(Math.random() * 100000) + 50000,
      errorRate: Math.random() * 5,
      warningRate: Math.random() * 10 + 5,
      processingSpeed: Math.random() * 1000 + 500,
      memoryUsage: Math.random() * 100 + 50
    };
    
    // Simulate pattern updates
    const patterns = ['connection_timeout', 'database_error', 'auth_failure', 'slow_query', 'memory_leak'];
    patterns.forEach(pattern => {
      this.dashboardData.patterns.set(pattern, Math.floor(Math.random() * 100) + 10);
    });
    
    // Simulate alerts
    if (Math.random() < 0.1) { // 10% chance of new alert
      this.dashboardData.alerts.push({
        id: Date.now(),
        type: 'high_error_rate',
        severity: 'medium',
        message: 'Error rate exceeded threshold',
        timestamp: Date.now()
      });
      
      // Keep only recent alerts
      this.dashboardData.alerts = this.dashboardData.alerts.slice(-10);
    }
    
    // Simulate recent logs
    const levels = ['INFO', 'WARN', 'ERROR'];
    const messages = [
      'Database connection established',
      'User authentication successful',
      'Cache miss for key: user_123',
      'Slow query detected',
      'Memory usage warning'
    ];
    
    this.dashboardData.recentLogs.unshift({
      timestamp: Date.now(),
      level: levels[Math.floor(Math.random() * levels.length)],
      message: messages[Math.floor(Math.random() * messages.length)]
    });
    
    // Keep only recent logs
    this.dashboardData.recentLogs = this.dashboardData.recentLogs.slice(0, 20);
  }
  
  /**
   * Update dashboard data from log analyzer
   */
  updateFromAnalyzer(analyzerData) {
    if (analyzerData.metrics) {
      this.dashboardData.metrics = { ...analyzerData.metrics };
    }
    
    if (analyzerData.patterns) {
      this.dashboardData.patterns = new Map(analyzerData.patterns);
    }
    
    if (analyzerData.alerts) {
      this.dashboardData.alerts = [...analyzerData.alerts];
    }
    
    // Broadcast updates to connected clients
    this.broadcastUpdate('all', this.getDashboardSnapshot());
  }
  
  /**
   * Broadcast update to all connected clients
   */
  broadcastUpdate(type, data) {
    const message = JSON.stringify({ type, data });
    
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(message);
        } catch (error) {
          console.error('Broadcast error:', error.message);
          this.clients.delete(client);
        }
      }
    }
  }
  
  /**
   * Get dashboard snapshot
   */
  getDashboardSnapshot() {
    return {
      metrics: this.dashboardData.metrics,
      patterns: Array.from(this.dashboardData.patterns.entries()),
      alerts: this.dashboardData.alerts,
      timeline: this.dashboardData.timeline,
      recentLogs: this.dashboardData.recentLogs
    };
  }
  
  /**
   * Load dashboard data from storage
   */
  async loadDashboardData() {
    try {
      const dataFile = join('./data', 'dashboard.json');
      const content = await readFile(dataFile, 'utf8');
      const saved = JSON.parse(content);
      
      if (saved.patterns) {
        this.dashboardData.patterns = new Map(saved.patterns);
      }
      
      if (saved.alerts) {
        this.dashboardData.alerts = saved.alerts;
      }
    } catch {
      // File doesn't exist or invalid JSON
    }
  }
  
  /**
   * Save dashboard data to storage
   */
  async saveDashboardData() {
    try {
      const dataFile = join('./data', 'dashboard.json');
      const data = {
        patterns: Array.from(this.dashboardData.patterns.entries()),
        alerts: this.dashboardData.alerts,
        timestamp: Date.now()
      };
      
      await writeFile(dataFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save dashboard data:', error.message);
    }
  }
  
  /**
   * Get dashboard status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      port: this.options.port,
      connectedClients: this.clients.size,
      lastUpdate: this.dashboardData.timestamp
    };
  }
}

export default LogDashboard;