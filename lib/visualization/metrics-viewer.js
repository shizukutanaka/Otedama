/**
 * Graphical Metrics Viewer
 * 
 * Advanced visualization system for metrics, analytics, and monitoring data
 * Interactive charts, real-time updates, and customizable dashboards
 */

import { EventEmitter } from 'events';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../core/standardized-error-handler.js';

export class MetricsViewer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Server configuration
      port: options.port || 3335,
      host: options.host || 'localhost',
      enableAuth: options.enableAuth !== false,
      
      // Visualization settings
      chartTypes: options.chartTypes || ['line', 'bar', 'area', 'scatter', 'heatmap', 'gauge'],
      enableRealTime: options.enableRealTime !== false,
      updateInterval: options.updateInterval || 5000,
      maxDataPoints: options.maxDataPoints || 1000,
      
      // Chart configuration
      defaultTheme: options.defaultTheme || 'dark',
      enableExport: options.enableExport !== false,
      enableFilters: options.enableFilters !== false,
      enableZoom: options.enableZoom !== false,
      
      // Data sources
      enableMetricsIntegration: options.enableMetricsIntegration !== false,
      enableAnalyticsIntegration: options.enableAnalyticsIntegration !== false,
      enableAnomalyOverlay: options.enableAnomalyOverlay !== false,
      
      // Performance
      enableCaching: options.enableCaching !== false,
      cacheTimeout: options.cacheTimeout || 60000,
      enableCompression: options.enableCompression !== false,
      
      // Storage
      dashboardDirectory: options.dashboardDirectory || './config/dashboards',
      
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.isRunning = false;
    this.server = null;
    this.wsServer = null;
    this.clients = new Set();
    
    // Data management
    this.chartConfigs = new Map();
    this.dashboards = new Map();
    this.dataCache = new Map();
    this.dataProviders = new Map();
    
    // Real-time state
    this.subscriptions = new Map(); // clientId -> subscribed metrics
    this.updateTimers = new Map();
    
    this.initialize();
  }
  
  /**
   * Initialize metrics viewer
   */
  async initialize() {
    try {
      await this.ensureDirectories();
      await this.loadDashboards();
      await this.setupDataProviders();
      
      this.emit('initialized');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'metrics-viewer',
        category: ErrorCategory.INITIALIZATION
      });
    }
  }
  
  /**
   * Start metrics viewer server
   */
  async start() {
    if (this.isRunning) {
      throw new OtedamaError('Metrics viewer already running', ErrorCategory.OPERATION);
    }
    
    console.log(`📊 Starting metrics viewer on ${this.options.host}:${this.options.port}`);
    
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
          console.log(`✅ Metrics viewer running at http://${this.options.host}:${this.options.port}`);
          resolve();
        }
      });
    });
    
    // Start real-time updates
    if (this.options.enableRealTime) {
      this.startRealTimeUpdates();
    }
    
    this.emit('started');
  }
  
  /**
   * Stop metrics viewer server
   */
  async stop() {
    if (!this.isRunning) return;
    
    console.log('🛑 Stopping metrics viewer...');
    
    // Clear update timers
    for (const timer of this.updateTimers.values()) {
      clearInterval(timer);
    }
    this.updateTimers.clear();
    
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
    console.log('✅ Metrics viewer stopped');
    this.emit('stopped');
  }
  
  /**
   * Handle HTTP requests
   */
  async handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    try {
      switch (url.pathname) {
        case '/':
          await this.serveViewer(res);
          break;
        case '/api/dashboards':
          await this.serveDashboards(req, res);
          break;
        case '/api/charts':
          await this.serveCharts(req, res);
          break;
        case '/api/data':
          await this.serveData(req, res);
          break;
        case '/api/export':
          await this.serveExport(req, res);
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
    const clientId = this.generateClientId();
    console.log(`📡 Metrics viewer client connected: ${clientId}`);
    
    this.clients.add(ws);
    this.subscriptions.set(clientId, new Set());
    
    // Send initial data
    ws.send(JSON.stringify({
      type: 'welcome',
      clientId,
      dashboards: Array.from(this.dashboards.keys()),
      chartTypes: this.options.chartTypes
    }));
    
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        this.handleWebSocketMessage(ws, clientId, data);
      } catch (error) {
        console.error('WebSocket message error:', error.message);
      }
    });
    
    ws.on('close', () => {
      console.log(`📡 Metrics viewer client disconnected: ${clientId}`);
      this.clients.delete(ws);
      this.subscriptions.delete(clientId);
    });
    
    ws.on('error', (error) => {
      console.error('WebSocket error:', error.message);
      this.clients.delete(ws);
      this.subscriptions.delete(clientId);
    });
  }
  
  /**
   * Handle WebSocket messages
   */
  async handleWebSocketMessage(ws, clientId, data) {
    try {
      switch (data.type) {
        case 'subscribe':
          await this.handleSubscribe(ws, clientId, data);
          break;
        case 'unsubscribe':
          await this.handleUnsubscribe(ws, clientId, data);
          break;
        case 'get_chart_data':
          await this.handleGetChartData(ws, data);
          break;
        case 'save_dashboard':
          await this.handleSaveDashboard(ws, data);
          break;
        case 'create_chart':
          await this.handleCreateChart(ws, data);
          break;
        default:
          console.warn(`Unknown message type: ${data.type}`);
      }
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        message: error.message
      }));
    }
  }
  
  /**
   * Serve main viewer HTML
   */
  async serveViewer(res) {
    const html = this.generateViewerHtml();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }
  
  /**
   * Generate viewer HTML
   */
  generateViewerHtml() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Otedama Metrics Viewer</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/date-fns@2.29.3/index.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: #0f0f23; 
            color: #cccccc; 
            line-height: 1.6;
        }
        .header { 
            background: #1e1e3e; 
            padding: 1rem 2rem; 
            border-bottom: 2px solid #00ff41; 
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .header h1 { 
            color: #00ff41; 
            display: flex; 
            align-items: center; 
            gap: 0.5rem;
        }
        .controls {
            display: flex;
            gap: 1rem;
            align-items: center;
        }
        .btn {
            background: #00ff41;
            color: #0f0f23;
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            transition: all 0.3s;
        }
        .btn:hover { 
            background: #00cc33; 
            transform: translateY(-2px);
        }
        .btn.secondary {
            background: #333366;
            color: #cccccc;
        }
        .btn.secondary:hover {
            background: #4444aa;
        }
        .container { 
            max-width: 1600px; 
            margin: 0 auto; 
            padding: 2rem; 
        }
        .dashboard-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
            gap: 2rem;
            margin-bottom: 2rem;
        }
        .chart-container {
            background: #1e1e3e;
            border-radius: 8px;
            padding: 1.5rem;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            border: 1px solid #333366;
            position: relative;
        }
        .chart-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1rem;
        }
        .chart-title {
            color: #00ff41;
            font-size: 1.2rem;
            font-weight: bold;
        }
        .chart-controls {
            display: flex;
            gap: 0.5rem;
        }
        .chart-btn {
            background: transparent;
            border: 1px solid #666699;
            color: #cccccc;
            padding: 0.25rem 0.5rem;
            border-radius: 3px;
            cursor: pointer;
            font-size: 0.8rem;
        }
        .chart-btn:hover {
            border-color: #00ff41;
            color: #00ff41;
        }
        .chart-canvas {
            position: relative;
            height: 300px;
            width: 100%;
        }
        .sidebar {
            position: fixed;
            right: -400px;
            top: 0;
            width: 400px;
            height: 100vh;
            background: #1e1e3e;
            border-left: 2px solid #00ff41;
            padding: 2rem;
            transition: right 0.3s;
            z-index: 1000;
            overflow-y: auto;
        }
        .sidebar.open {
            right: 0;
        }
        .sidebar h3 {
            color: #00ff41;
            margin-bottom: 1rem;
        }
        .form-group {
            margin-bottom: 1rem;
        }
        .form-group label {
            display: block;
            margin-bottom: 0.5rem;
            color: #cccccc;
        }
        .form-group input,
        .form-group select,
        .form-group textarea {
            width: 100%;
            padding: 0.5rem;
            background: #0f0f23;
            border: 1px solid #333366;
            border-radius: 4px;
            color: #cccccc;
        }
        .form-group input:focus,
        .form-group select:focus {
            border-color: #00ff41;
            outline: none;
        }
        .status-indicator {
            position: fixed;
            top: 1rem;
            right: 1rem;
            padding: 0.5rem 1rem;
            border-radius: 20px;
            font-size: 0.9rem;
            font-weight: bold;
        }
        .status-connected {
            background: #00ff41;
            color: #0f0f23;
        }
        .status-disconnected {
            background: #ff4444;
            color: white;
        }
        .metric-card {
            background: #0f0f23;
            border: 1px solid #333366;
            border-radius: 6px;
            padding: 1rem;
            margin-bottom: 1rem;
        }
        .metric-value {
            font-size: 2rem;
            font-weight: bold;
            color: #00ff41;
        }
        .metric-label {
            font-size: 0.9rem;
            color: #999999;
        }
        .loading {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 300px;
            color: #666699;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📊 Otedama Metrics Viewer</h1>
        <div class="controls">
            <button class="btn secondary" onclick="toggleSidebar()">⚙️ Settings</button>
            <button class="btn" onclick="addChart()">➕ Add Chart</button>
            <button class="btn secondary" onclick="exportDashboard()">💾 Export</button>
        </div>
    </div>
    
    <div class="status-indicator" id="connectionStatus">
        Connecting...
    </div>
    
    <div class="container">
        <div class="dashboard-grid" id="dashboardGrid">
            <div class="chart-container">
                <div class="chart-header">
                    <div class="chart-title">System Performance</div>
                    <div class="chart-controls">
                        <button class="chart-btn" onclick="refreshChart('system')">🔄</button>
                        <button class="chart-btn" onclick="configureChart('system')">⚙️</button>
                    </div>
                </div>
                <div class="chart-canvas">
                    <canvas id="systemChart"></canvas>
                </div>
            </div>
            
            <div class="chart-container">
                <div class="chart-header">
                    <div class="chart-title">Mining Metrics</div>
                    <div class="chart-controls">
                        <button class="chart-btn" onclick="refreshChart('mining')">🔄</button>
                        <button class="chart-btn" onclick="configureChart('mining')">⚙️</button>
                    </div>
                </div>
                <div class="chart-canvas">
                    <canvas id="miningChart"></canvas>
                </div>
            </div>
            
            <div class="chart-container">
                <div class="chart-header">
                    <div class="chart-title">Network Activity</div>
                    <div class="chart-controls">
                        <button class="chart-btn" onclick="refreshChart('network')">🔄</button>
                        <button class="chart-btn" onclick="configureChart('network')">⚙️</button>
                    </div>
                </div>
                <div class="chart-canvas">
                    <canvas id="networkChart"></canvas>
                </div>
            </div>
            
            <div class="chart-container">
                <div class="chart-header">
                    <div class="chart-title">Real-time Metrics</div>
                </div>
                <div id="realtimeMetrics">
                    <div class="metric-card">
                        <div class="metric-value" id="cpuValue">--</div>
                        <div class="metric-label">CPU Usage (%)</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value" id="memoryValue">--</div>
                        <div class="metric-label">Memory Usage (%)</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value" id="hashrateValue">--</div>
                        <div class="metric-label">Hashrate (H/s)</div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    
    <div class="sidebar" id="sidebar">
        <h3>Chart Configuration</h3>
        <div class="form-group">
            <label for="chartType">Chart Type</label>
            <select id="chartType">
                <option value="line">Line Chart</option>
                <option value="bar">Bar Chart</option>
                <option value="area">Area Chart</option>
                <option value="scatter">Scatter Plot</option>
                <option value="gauge">Gauge</option>
            </select>
        </div>
        
        <div class="form-group">
            <label for="metricName">Metric Name</label>
            <input type="text" id="metricName" placeholder="e.g., cpu_usage">
        </div>
        
        <div class="form-group">
            <label for="timeRange">Time Range</label>
            <select id="timeRange">
                <option value="1h">Last Hour</option>
                <option value="6h">Last 6 Hours</option>
                <option value="24h">Last 24 Hours</option>
                <option value="7d">Last 7 Days</option>
            </select>
        </div>
        
        <div class="form-group">
            <label for="aggregation">Aggregation</label>
            <select id="aggregation">
                <option value="raw">Raw Data</option>
                <option value="1m">1 Minute</option>
                <option value="5m">5 Minutes</option>
                <option value="1h">1 Hour</option>
            </select>
        </div>
        
        <button class="btn" onclick="applyChartConfig()">Apply Configuration</button>
        <button class="btn secondary" onclick="toggleSidebar()">Close</button>
    </div>
    
    <script>
        class MetricsViewer {
            constructor() {
                this.ws = null;
                this.connected = false;
                this.charts = new Map();
                this.subscriptions = new Set();
                this.init();
            }
            
            init() {
                this.connect();
                this.initializeCharts();
            }
            
            connect() {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = \`\${protocol}//\${window.location.host}\`;
                
                try {
                    this.ws = new WebSocket(wsUrl);
                    
                    this.ws.onopen = () => {
                        console.log('✅ Connected to metrics viewer');
                        this.connected = true;
                        this.updateConnectionStatus();
                    };
                    
                    this.ws.onmessage = (event) => {
                        const data = JSON.parse(event.data);
                        this.handleMessage(data);
                    };
                    
                    this.ws.onclose = () => {
                        console.log('❌ Disconnected from metrics viewer');
                        this.connected = false;
                        this.updateConnectionStatus();
                        setTimeout(() => this.connect(), 5000);
                    };
                    
                    this.ws.onerror = (error) => {
                        console.error('WebSocket error:', error);
                    };
                } catch (error) {
                    console.error('Connection error:', error);
                    setTimeout(() => this.connect(), 5000);
                }
            }
            
            handleMessage(data) {
                switch (data.type) {
                    case 'welcome':
                        this.handleWelcome(data);
                        break;
                    case 'chart_data':
                        this.updateChart(data);
                        break;
                    case 'realtime_update':
                        this.updateRealtimeMetrics(data);
                        break;
                    case 'error':
                        console.error('Server error:', data.message);
                        break;
                }
            }
            
            handleWelcome(data) {
                console.log('Welcome message received');
                this.startRealtimeUpdates();
            }
            
            initializeCharts() {
                // System Performance Chart
                const systemCtx = document.getElementById('systemChart').getContext('2d');
                this.charts.set('system', new Chart(systemCtx, {
                    type: 'line',
                    data: {
                        labels: [],
                        datasets: [{
                            label: 'CPU Usage (%)',
                            data: [],
                            borderColor: '#00ff41',
                            backgroundColor: 'rgba(0, 255, 65, 0.1)',
                            tension: 0.4
                        }, {
                            label: 'Memory Usage (%)',
                            data: [],
                            borderColor: '#ff6b6b',
                            backgroundColor: 'rgba(255, 107, 107, 0.1)',
                            tension: 0.4
                        }]
                    },
                    options: this.getChartOptions()
                }));
                
                // Mining Metrics Chart
                const miningCtx = document.getElementById('miningChart').getContext('2d');
                this.charts.set('mining', new Chart(miningCtx, {
                    type: 'line',
                    data: {
                        labels: [],
                        datasets: [{
                            label: 'Hashrate (H/s)',
                            data: [],
                            borderColor: '#4ecdc4',
                            backgroundColor: 'rgba(78, 205, 196, 0.1)',
                            tension: 0.4
                        }]
                    },
                    options: this.getChartOptions()
                }));
                
                // Network Activity Chart
                const networkCtx = document.getElementById('networkChart').getContext('2d');
                this.charts.set('network', new Chart(networkCtx, {
                    type: 'bar',
                    data: {
                        labels: [],
                        datasets: [{
                            label: 'Throughput (MB/s)',
                            data: [],
                            backgroundColor: '#ffd93d',
                            borderColor: '#ffb700',
                            borderWidth: 1
                        }]
                    },
                    options: this.getChartOptions()
                }));
                
                // Generate sample data
                this.generateSampleData();
            }
            
            getChartOptions() {
                return {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            labels: {
                                color: '#cccccc'
                            }
                        }
                    },
                    scales: {
                        x: {
                            ticks: {
                                color: '#cccccc'
                            },
                            grid: {
                                color: '#333366'
                            }
                        },
                        y: {
                            ticks: {
                                color: '#cccccc'
                            },
                            grid: {
                                color: '#333366'
                            }
                        }
                    }
                };
            }
            
            generateSampleData() {
                const now = new Date();
                const labels = [];
                const cpuData = [];
                const memoryData = [];
                const hashrateData = [];
                const throughputData = [];
                
                for (let i = 30; i >= 0; i--) {
                    const time = new Date(now.getTime() - i * 60000);
                    labels.push(time.toLocaleTimeString());
                    
                    cpuData.push(Math.random() * 100);
                    memoryData.push(Math.random() * 100);
                    hashrateData.push(Math.random() * 1000 + 500);
                    throughputData.push(Math.random() * 100 + 50);
                }
                
                // Update system chart
                const systemChart = this.charts.get('system');
                systemChart.data.labels = labels;
                systemChart.data.datasets[0].data = cpuData;
                systemChart.data.datasets[1].data = memoryData;
                systemChart.update();
                
                // Update mining chart
                const miningChart = this.charts.get('mining');
                miningChart.data.labels = labels;
                miningChart.data.datasets[0].data = hashrateData;
                miningChart.update();
                
                // Update network chart
                const networkChart = this.charts.get('network');
                networkChart.data.labels = labels.slice(-10);
                networkChart.data.datasets[0].data = throughputData.slice(-10);
                networkChart.update();
                
                // Update real-time values
                document.getElementById('cpuValue').textContent = cpuData[cpuData.length - 1].toFixed(1);
                document.getElementById('memoryValue').textContent = memoryData[memoryData.length - 1].toFixed(1);
                document.getElementById('hashrateValue').textContent = hashrateData[hashrateData.length - 1].toFixed(0);
            }
            
            startRealtimeUpdates() {
                setInterval(() => {
                    this.generateSampleData();
                }, 5000);
            }
            
            updateChart(data) {
                const chart = this.charts.get(data.chartId);
                if (chart) {
                    chart.data = data.chartData;
                    chart.update();
                }
            }
            
            updateRealtimeMetrics(data) {
                for (const [metric, value] of Object.entries(data.metrics)) {
                    const element = document.getElementById(\`\${metric}Value\`);
                    if (element) {
                        element.textContent = value.toFixed(1);
                    }
                }
            }
            
            updateConnectionStatus() {
                const status = document.getElementById('connectionStatus');
                if (this.connected) {
                    status.className = 'status-indicator status-connected';
                    status.textContent = 'Connected';
                } else {
                    status.className = 'status-indicator status-disconnected';
                    status.textContent = 'Disconnected';
                }
            }
        }
        
        // Global functions
        function toggleSidebar() {
            const sidebar = document.getElementById('sidebar');
            sidebar.classList.toggle('open');
        }
        
        function addChart() {
            alert('Add Chart functionality - would open chart creation dialog');
        }
        
        function exportDashboard() {
            alert('Export Dashboard functionality - would generate export file');
        }
        
        function refreshChart(chartId) {
            console.log(\`Refreshing chart: \${chartId}\`);
            window.viewer.generateSampleData();
        }
        
        function configureChart(chartId) {
            console.log(\`Configuring chart: \${chartId}\`);
            toggleSidebar();
        }
        
        function applyChartConfig() {
            const chartType = document.getElementById('chartType').value;
            const metricName = document.getElementById('metricName').value;
            const timeRange = document.getElementById('timeRange').value;
            const aggregation = document.getElementById('aggregation').value;
            
            console.log('Applying configuration:', {
                chartType, metricName, timeRange, aggregation
            });
            
            alert('Configuration applied! (This would update the chart in a real implementation)');
            toggleSidebar();
        }
        
        // Initialize viewer
        window.viewer = new MetricsViewer();
    </script>
</body>
</html>`;
  }
  
  /**
   * Handle subscription requests
   */
  async handleSubscribe(ws, clientId, data) {
    const subscriptions = this.subscriptions.get(clientId);
    if (subscriptions) {
      subscriptions.add(data.metric);
      
      // Send initial data
      const chartData = await this.getChartData(data.metric, data.options);
      ws.send(JSON.stringify({
        type: 'chart_data',
        chartId: data.chartId,
        metric: data.metric,
        chartData
      }));
    }
  }
  
  /**
   * Handle unsubscribe requests
   */
  async handleUnsubscribe(ws, clientId, data) {
    const subscriptions = this.subscriptions.get(clientId);
    if (subscriptions) {
      subscriptions.delete(data.metric);
    }
  }
  
  /**
   * Get chart data
   */
  async getChartData(metric, options = {}) {
    const cacheKey = `${metric}_${JSON.stringify(options)}`;
    
    // Check cache
    if (this.options.enableCaching && this.dataCache.has(cacheKey)) {
      const cached = this.dataCache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.options.cacheTimeout) {
        return cached.data;
      }
    }
    
    // Generate sample data (in production, fetch from data providers)
    const data = this.generateSampleChartData(metric, options);
    
    // Cache the result
    if (this.options.enableCaching) {
      this.dataCache.set(cacheKey, {
        data,
        timestamp: Date.now()
      });
    }
    
    return data;
  }
  
  /**
   * Generate sample chart data
   */
  generateSampleChartData(metric, options) {
    const now = Date.now();
    const points = options.points || 30;
    const interval = options.interval || 60000; // 1 minute
    
    const labels = [];
    const data = [];
    
    for (let i = points - 1; i >= 0; i--) {
      const timestamp = now - (i * interval);
      labels.push(new Date(timestamp).toLocaleTimeString());
      
      // Generate realistic sample data based on metric type
      let value;
      switch (metric) {
        case 'cpu_usage':
          value = Math.random() * 100;
          break;
        case 'memory_usage':
          value = 60 + Math.random() * 30;
          break;
        case 'mining_hashrate':
          value = 750 + Math.random() * 250;
          break;
        case 'network_throughput':
          value = 100 + Math.random() * 400;
          break;
        case 'error_rate':
          value = Math.random() * 5;
          break;
        default:
          value = Math.random() * 100;
      }
      
      data.push(value);
    }
    
    return {
      labels,
      datasets: [{
        label: metric.replace('_', ' ').toUpperCase(),
        data,
        borderColor: this.getMetricColor(metric),
        backgroundColor: this.getMetricColor(metric, 0.1),
        tension: 0.4
      }]
    };
  }
  
  /**
   * Get color for metric
   */
  getMetricColor(metric, alpha = 1) {
    const colors = {
      cpu_usage: `rgba(255, 107, 107, ${alpha})`,
      memory_usage: `rgba(78, 205, 196, ${alpha})`,
      mining_hashrate: `rgba(0, 255, 65, ${alpha})`,
      network_throughput: `rgba(255, 211, 61, ${alpha})`,
      error_rate: `rgba(255, 77, 77, ${alpha})`
    };
    
    return colors[metric] || `rgba(204, 204, 204, ${alpha})`;
  }
  
  /**
   * Start real-time updates
   */
  startRealTimeUpdates() {
    setInterval(() => {
      this.broadcastRealtimeData();
    }, this.options.updateInterval);
  }
  
  /**
   * Broadcast real-time data to all clients
   */
  broadcastRealtimeData() {
    const realtimeData = {
      type: 'realtime_update',
      timestamp: Date.now(),
      metrics: {
        cpu: Math.random() * 100,
        memory: 60 + Math.random() * 30,
        hashrate: 750 + Math.random() * 250,
        throughput: 100 + Math.random() * 400
      }
    };
    
    this.broadcast(realtimeData);
  }
  
  /**
   * Broadcast message to all connected clients
   */
  broadcast(message) {
    const messageStr = JSON.stringify(message);
    
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(messageStr);
        } catch (error) {
          console.error('Broadcast error:', error.message);
          this.clients.delete(client);
        }
      }
    }
  }
  
  /**
   * Utility methods
   */
  generateClientId() {
    return `client_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }
  
  async ensureDirectories() {
    await mkdir(this.options.dashboardDirectory, { recursive: true });
  }
  
  async loadDashboards() {
    // Load default dashboard configurations
    this.dashboards.set('default', {
      name: 'Default Dashboard',
      charts: [
        { id: 'system', type: 'line', metric: 'cpu_usage' },
        { id: 'mining', type: 'line', metric: 'mining_hashrate' },
        { id: 'network', type: 'bar', metric: 'network_throughput' }
      ]
    });
  }
  
  async setupDataProviders() {
    // Setup integration with metrics aggregator and other data sources
    // This would connect to the actual data providers in production
  }
  
  async serveDashboards(req, res) {
    const dashboards = Array.from(this.dashboards.entries()).map(([id, config]) => ({
      id,
      ...config
    }));
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(dashboards));
  }
  
  async serveCharts(req, res) {
    const charts = Array.from(this.chartConfigs.entries()).map(([id, config]) => ({
      id,
      ...config
    }));
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(charts));
  }
  
  async serveData(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const metric = url.searchParams.get('metric');
    const timeRange = url.searchParams.get('timeRange') || '1h';
    
    if (!metric) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Metric parameter required' }));
      return;
    }
    
    const data = await this.getChartData(metric, { timeRange });
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
  
  async serveExport(req, res) {
    // Export functionality
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Export functionality would be implemented here' }));
  }
  
  async handleGetChartData(ws, data) {
    const chartData = await this.getChartData(data.metric, data.options);
    ws.send(JSON.stringify({
      type: 'chart_data',
      chartId: data.chartId,
      chartData
    }));
  }
  
  async handleSaveDashboard(ws, data) {
    this.dashboards.set(data.dashboardId, data.config);
    ws.send(JSON.stringify({
      type: 'dashboard_saved',
      dashboardId: data.dashboardId
    }));
  }
  
  async handleCreateChart(ws, data) {
    const chartId = this.generateClientId();
    this.chartConfigs.set(chartId, data.config);
    
    ws.send(JSON.stringify({
      type: 'chart_created',
      chartId
    }));
  }
  
  /**
   * Get viewer status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      port: this.options.port,
      connectedClients: this.clients.size,
      dashboards: this.dashboards.size,
      charts: this.chartConfigs.size,
      cacheSize: this.dataCache.size
    };
  }
}

export default MetricsViewer;