/**
 * Real-Time Performance Dashboard
 * リアルタイムパフォーマンスダッシュボード
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

class RealTimePerformanceDashboard extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Server configuration
            port: config.port || 8081,
            host: config.host || '0.0.0.0',
            
            // Update intervals
            metricsInterval: config.metricsInterval || 1000, // 1 second
            historyInterval: config.historyInterval || 5000, // 5 seconds
            alertCheckInterval: config.alertCheckInterval || 3000, // 3 seconds
            
            // Data retention
            maxDataPoints: config.maxDataPoints || 300, // 5 minutes at 1s intervals
            maxHistoryEntries: config.maxHistoryEntries || 100,
            
            // Thresholds for alerts
            thresholds: {
                cpu: config.thresholds?.cpu || 80,
                memory: config.thresholds?.memory || 85,
                responseTime: config.thresholds?.responseTime || 1000,
                errorRate: config.thresholds?.errorRate || 0.05,
                throughput: config.thresholds?.throughput || 100,
                ...config.thresholds
            },
            
            // Features
            enableAlerts: config.enableAlerts !== false,
            enableLogging: config.enableLogging !== false,
            enableExport: config.enableExport !== false,
            
            // Integration
            metricsCollectors: config.metricsCollectors || [],
            
            ...config
        };
        
        // Dashboard state
        this.server = null;
        this.wss = null;
        this.clients = new Set();
        
        // Metrics storage
        this.currentMetrics = {};
        this.metricsHistory = new Map();
        this.alerts = [];
        
        // Performance tracking
        this.performanceScores = {
            overall: 100,
            cpu: 100,
            memory: 100,
            network: 100,
            disk: 100,
            application: 100
        };
        
        // Initialize
        this.initialize();
    }
    
    async initialize() {
        console.log('リアルタイムパフォーマンスダッシュボードを初期化中...');
        
        // Setup HTTP server
        await this.setupHttpServer();
        
        // Setup WebSocket server
        this.setupWebSocketServer();
        
        // Start metrics collection
        this.startMetricsCollection();
        
        // Start alert monitoring
        if (this.config.enableAlerts) {
            this.startAlertMonitoring();
        }
        
        console.log(`✓ ダッシュボードが起動しました: http://${this.config.host}:${this.config.port}`);
    }
    
    /**
     * Setup HTTP server for dashboard UI
     */
    async setupHttpServer() {
        this.server = http.createServer((req, res) => {
            if (req.url === '/' || req.url === '/index.html') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(this.generateDashboardHTML());
            } else if (req.url === '/api/metrics') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(this.getMetricsSummary()));
            } else if (req.url === '/api/export' && this.config.enableExport) {
                res.writeHead(200, { 
                    'Content-Type': 'application/json',
                    'Content-Disposition': 'attachment; filename="performance-metrics.json"'
                });
                res.end(JSON.stringify(this.exportMetrics()));
            } else {
                res.writeHead(404);
                res.end('Not Found');
            }
        });
        
        await new Promise((resolve) => {
            this.server.listen(this.config.port, this.config.host, resolve);
        });
    }
    
    /**
     * Setup WebSocket server for real-time updates
     */
    setupWebSocketServer() {
        this.wss = new WebSocket.Server({ server: this.server });
        
        this.wss.on('connection', (ws) => {
            this.clients.add(ws);
            
            // Send initial data
            ws.send(JSON.stringify({
                type: 'initial',
                data: {
                    metrics: this.currentMetrics,
                    history: this.getHistorySummary(),
                    alerts: this.alerts,
                    scores: this.performanceScores
                }
            }));
            
            ws.on('close', () => {
                this.clients.delete(ws);
            });
            
            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.clients.delete(ws);
            });
        });
    }
    
    /**
     * Start collecting metrics
     */
    startMetricsCollection() {
        // Collect system metrics
        setInterval(() => {
            this.collectSystemMetrics();
        }, this.config.metricsInterval);
        
        // Update history
        setInterval(() => {
            this.updateHistory();
        }, this.config.historyInterval);
        
        // Connect to external collectors
        this.connectToCollectors();
    }
    
    /**
     * Collect system metrics
     */
    async collectSystemMetrics() {
        const os = require('os');
        const process = require('process');
        
        // CPU usage
        const cpus = os.cpus();
        let totalIdle = 0;
        let totalTick = 0;
        
        cpus.forEach(cpu => {
            for (const type in cpu.times) {
                totalTick += cpu.times[type];
            }
            totalIdle += cpu.times.idle;
        });
        
        const idle = totalIdle / cpus.length;
        const total = totalTick / cpus.length;
        const cpuUsage = 100 - ~~(100 * idle / total);
        
        // Memory usage
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memoryUsage = (usedMem / totalMem) * 100;
        
        // Process metrics
        const processMemory = process.memoryUsage();
        const heapUsage = (processMemory.heapUsed / processMemory.heapTotal) * 100;
        
        // Update current metrics
        this.currentMetrics = {
            timestamp: Date.now(),
            system: {
                cpu: {
                    usage: cpuUsage,
                    cores: cpus.length,
                    model: cpus[0].model
                },
                memory: {
                    total: totalMem,
                    used: usedMem,
                    free: freeMem,
                    usage: memoryUsage
                },
                process: {
                    pid: process.pid,
                    uptime: process.uptime(),
                    heapUsed: processMemory.heapUsed,
                    heapTotal: processMemory.heapTotal,
                    heapUsage: heapUsage,
                    external: processMemory.external,
                    rss: processMemory.rss
                }
            },
            application: await this.collectApplicationMetrics()
        };
        
        // Calculate performance scores
        this.updatePerformanceScores();
        
        // Broadcast to clients
        this.broadcast({
            type: 'metrics',
            data: this.currentMetrics
        });
    }
    
    /**
     * Collect application-specific metrics
     */
    async collectApplicationMetrics() {
        const metrics = {
            mining: {
                hashrate: 0,
                activeMiners: 0,
                totalShares: 0,
                rejectedShares: 0,
                difficulty: 0
            },
            network: {
                connections: 0,
                bandwidth: {
                    in: 0,
                    out: 0
                },
                latency: 0
            },
            pool: {
                blocks: 0,
                payments: 0,
                workers: 0,
                efficiency: 0
            }
        };
        
        // Collect from registered collectors
        for (const collector of this.config.metricsCollectors) {
            try {
                const collectorMetrics = await collector.collect();
                Object.assign(metrics, collectorMetrics);
            } catch (error) {
                console.error('Collector error:', error);
            }
        }
        
        return metrics;
    }
    
    /**
     * Update performance scores
     */
    updatePerformanceScores() {
        const metrics = this.currentMetrics;
        
        // CPU score
        this.performanceScores.cpu = Math.max(0, 100 - metrics.system.cpu.usage);
        
        // Memory score
        this.performanceScores.memory = Math.max(0, 100 - metrics.system.memory.usage);
        
        // Network score (placeholder - would need actual network metrics)
        this.performanceScores.network = 95;
        
        // Disk score (placeholder - would need actual disk metrics)
        this.performanceScores.disk = 90;
        
        // Application score based on heap usage
        this.performanceScores.application = Math.max(0, 100 - metrics.system.process.heapUsage);
        
        // Overall score
        this.performanceScores.overall = Math.round(
            (this.performanceScores.cpu * 0.3 +
             this.performanceScores.memory * 0.3 +
             this.performanceScores.network * 0.15 +
             this.performanceScores.disk * 0.15 +
             this.performanceScores.application * 0.1)
        );
        
        // Broadcast scores
        this.broadcast({
            type: 'scores',
            data: this.performanceScores
        });
    }
    
    /**
     * Update metrics history
     */
    updateHistory() {
        const timestamp = Date.now();
        
        // Add current metrics to history
        for (const [key, value] of Object.entries(this.currentMetrics.system)) {
            if (!this.metricsHistory.has(key)) {
                this.metricsHistory.set(key, []);
            }
            
            const history = this.metricsHistory.get(key);
            history.push({
                timestamp,
                value: typeof value === 'object' ? value.usage || 0 : value
            });
            
            // Trim old data
            if (history.length > this.config.maxDataPoints) {
                history.shift();
            }
        }
        
        // Broadcast history update
        this.broadcast({
            type: 'history',
            data: this.getHistorySummary()
        });
    }
    
    /**
     * Start alert monitoring
     */
    startAlertMonitoring() {
        setInterval(() => {
            this.checkAlerts();
        }, this.config.alertCheckInterval);
    }
    
    /**
     * Check for alert conditions
     */
    checkAlerts() {
        const newAlerts = [];
        const metrics = this.currentMetrics;
        
        // CPU alert
        if (metrics.system.cpu.usage > this.config.thresholds.cpu) {
            newAlerts.push({
                id: this.generateAlertId(),
                type: 'cpu',
                severity: 'warning',
                message: `CPU使用率が高い: ${metrics.system.cpu.usage.toFixed(1)}%`,
                timestamp: Date.now(),
                value: metrics.system.cpu.usage,
                threshold: this.config.thresholds.cpu
            });
        }
        
        // Memory alert
        if (metrics.system.memory.usage > this.config.thresholds.memory) {
            newAlerts.push({
                id: this.generateAlertId(),
                type: 'memory',
                severity: 'warning',
                message: `メモリ使用率が高い: ${metrics.system.memory.usage.toFixed(1)}%`,
                timestamp: Date.now(),
                value: metrics.system.memory.usage,
                threshold: this.config.thresholds.memory
            });
        }
        
        // Process new alerts
        for (const alert of newAlerts) {
            // Check if similar alert already exists
            const exists = this.alerts.some(a => 
                a.type === alert.type && 
                Date.now() - a.timestamp < 60000 // 1 minute
            );
            
            if (!exists) {
                this.alerts.unshift(alert);
                this.emit('alert', alert);
                
                // Broadcast alert
                this.broadcast({
                    type: 'alert',
                    data: alert
                });
            }
        }
        
        // Clean old alerts
        this.alerts = this.alerts.filter(a => 
            Date.now() - a.timestamp < 3600000 // 1 hour
        ).slice(0, 50); // Keep max 50 alerts
    }
    
    /**
     * Connect to external metric collectors
     */
    connectToCollectors() {
        this.emit('collectors-connecting', {
            count: this.config.metricsCollectors.length
        });
        
        // Initialize each collector
        for (const collector of this.config.metricsCollectors) {
            if (typeof collector.initialize === 'function') {
                collector.initialize();
            }
        }
    }
    
    /**
     * Broadcast message to all clients
     */
    broadcast(message) {
        const data = JSON.stringify(message);
        
        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        }
    }
    
    /**
     * Get metrics summary
     */
    getMetricsSummary() {
        return {
            current: this.currentMetrics,
            scores: this.performanceScores,
            alerts: this.alerts.slice(0, 10),
            timestamp: Date.now()
        };
    }
    
    /**
     * Get history summary
     */
    getHistorySummary() {
        const summary = {};
        
        for (const [key, history] of this.metricsHistory) {
            summary[key] = history.slice(-50); // Last 50 points
        }
        
        return summary;
    }
    
    /**
     * Export metrics
     */
    exportMetrics() {
        return {
            exportTime: new Date().toISOString(),
            currentMetrics: this.currentMetrics,
            performanceScores: this.performanceScores,
            history: Object.fromEntries(this.metricsHistory),
            alerts: this.alerts,
            config: {
                thresholds: this.config.thresholds,
                intervals: {
                    metrics: this.config.metricsInterval,
                    history: this.config.historyInterval,
                    alertCheck: this.config.alertCheckInterval
                }
            }
        };
    }
    
    /**
     * Generate alert ID
     */
    generateAlertId() {
        return `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Generate dashboard HTML
     */
    generateDashboardHTML() {
        return `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Otedama Performance Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0a0a;
            color: #e0e0e0;
            line-height: 1.6;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid #1a1a1a;
        }
        .header h1 {
            font-size: 2.5em;
            background: linear-gradient(45deg, #00ff88, #0088ff);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .status {
            display: flex;
            align-items: center;
            gap: 15px;
        }
        .status-indicator {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #00ff88;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .card {
            background: #1a1a1a;
            border-radius: 12px;
            padding: 20px;
            border: 1px solid #2a2a2a;
            transition: all 0.3s ease;
        }
        .card:hover {
            border-color: #00ff88;
            box-shadow: 0 0 20px rgba(0, 255, 136, 0.1);
        }
        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .card-title {
            font-size: 1.2em;
            color: #00ff88;
        }
        .metric-value {
            font-size: 2.5em;
            font-weight: bold;
            margin: 10px 0;
        }
        .metric-label {
            color: #888;
            font-size: 0.9em;
        }
        .progress-bar {
            width: 100%;
            height: 8px;
            background: #2a2a2a;
            border-radius: 4px;
            overflow: hidden;
            margin: 10px 0;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #00ff88, #0088ff);
            transition: width 0.3s ease;
        }
        .chart-container {
            height: 200px;
            margin-top: 15px;
        }
        .alerts {
            background: #1a1a1a;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 30px;
        }
        .alert-item {
            background: #2a1a1a;
            border-left: 4px solid #ff4444;
            padding: 10px 15px;
            margin-bottom: 10px;
            border-radius: 4px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .alert-warning {
            border-left-color: #ffaa00;
        }
        .score-container {
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 20px 0;
        }
        .score-circle {
            width: 120px;
            height: 120px;
            border-radius: 50%;
            background: conic-gradient(#00ff88 0deg, #00ff88 var(--score), #2a2a2a var(--score));
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
        }
        .score-circle::before {
            content: '';
            position: absolute;
            width: 90%;
            height: 90%;
            background: #1a1a1a;
            border-radius: 50%;
        }
        .score-value {
            position: relative;
            font-size: 2em;
            font-weight: bold;
        }
        .actions {
            display: flex;
            gap: 10px;
        }
        .btn {
            background: #00ff88;
            color: #000;
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-weight: bold;
            transition: all 0.3s ease;
        }
        .btn:hover {
            background: #00cc6a;
            transform: translateY(-2px);
        }
        .btn-secondary {
            background: #2a2a2a;
            color: #e0e0e0;
        }
        .btn-secondary:hover {
            background: #3a3a3a;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Performance Dashboard</h1>
            <div class="status">
                <span class="status-indicator"></span>
                <span>Connected</span>
                <div class="actions">
                    <button class="btn btn-secondary" onclick="exportMetrics()">Export</button>
                    <button class="btn" onclick="clearAlerts()">Clear Alerts</button>
                </div>
            </div>
        </div>
        
        <div class="grid">
            <div class="card">
                <div class="card-header">
                    <h3 class="card-title">Overall Score</h3>
                </div>
                <div class="score-container">
                    <div class="score-circle" style="--score: 0deg">
                        <div class="score-value" id="overall-score">0</div>
                    </div>
                </div>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <h3 class="card-title">CPU Usage</h3>
                    <span id="cpu-value" class="metric-value">0%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" id="cpu-progress" style="width: 0%"></div>
                </div>
                <div class="chart-container" id="cpu-chart"></div>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <h3 class="card-title">Memory Usage</h3>
                    <span id="memory-value" class="metric-value">0%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" id="memory-progress" style="width: 0%"></div>
                </div>
                <div class="chart-container" id="memory-chart"></div>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <h3 class="card-title">Process Heap</h3>
                    <span id="heap-value" class="metric-value">0%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" id="heap-progress" style="width: 0%"></div>
                </div>
                <div class="metric-label">
                    <span id="heap-used">0</span> / <span id="heap-total">0</span> MB
                </div>
            </div>
        </div>
        
        <div class="alerts" id="alerts-container">
            <h3 class="card-title">Recent Alerts</h3>
            <div id="alerts-list"></div>
        </div>
    </div>
    
    <script>
        const ws = new WebSocket('ws://' + window.location.host);
        const charts = {};
        
        ws.onopen = () => {
            console.log('Connected to dashboard');
            document.querySelector('.status-indicator').style.background = '#00ff88';
        };
        
        ws.onclose = () => {
            console.log('Disconnected from dashboard');
            document.querySelector('.status-indicator').style.background = '#ff4444';
        };
        
        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            
            switch (message.type) {
                case 'initial':
                    initializeDashboard(message.data);
                    break;
                case 'metrics':
                    updateMetrics(message.data);
                    break;
                case 'scores':
                    updateScores(message.data);
                    break;
                case 'alert':
                    addAlert(message.data);
                    break;
            }
        };
        
        function initializeDashboard(data) {
            updateMetrics(data.metrics);
            updateScores(data.scores);
            displayAlerts(data.alerts);
        }
        
        function updateMetrics(metrics) {
            if (!metrics || !metrics.system) return;
            
            // CPU
            const cpuUsage = metrics.system.cpu.usage.toFixed(1);
            document.getElementById('cpu-value').textContent = cpuUsage + '%';
            document.getElementById('cpu-progress').style.width = cpuUsage + '%';
            
            // Memory
            const memUsage = metrics.system.memory.usage.toFixed(1);
            document.getElementById('memory-value').textContent = memUsage + '%';
            document.getElementById('memory-progress').style.width = memUsage + '%';
            
            // Heap
            const heapUsage = metrics.system.process.heapUsage.toFixed(1);
            const heapUsedMB = (metrics.system.process.heapUsed / 1024 / 1024).toFixed(1);
            const heapTotalMB = (metrics.system.process.heapTotal / 1024 / 1024).toFixed(1);
            
            document.getElementById('heap-value').textContent = heapUsage + '%';
            document.getElementById('heap-progress').style.width = heapUsage + '%';
            document.getElementById('heap-used').textContent = heapUsedMB;
            document.getElementById('heap-total').textContent = heapTotalMB;
        }
        
        function updateScores(scores) {
            const overallScore = scores.overall;
            document.getElementById('overall-score').textContent = overallScore;
            
            const degrees = (overallScore / 100) * 360;
            document.querySelector('.score-circle').style.setProperty('--score', degrees + 'deg');
        }
        
        function displayAlerts(alerts) {
            const container = document.getElementById('alerts-list');
            container.innerHTML = '';
            
            if (alerts.length === 0) {
                container.innerHTML = '<p style="color: #666;">No active alerts</p>';
                return;
            }
            
            alerts.forEach(alert => {
                const alertEl = document.createElement('div');
                alertEl.className = 'alert-item alert-' + alert.severity;
                alertEl.innerHTML = \`
                    <div>
                        <strong>\${alert.message}</strong>
                        <div style="font-size: 0.8em; color: #666;">
                            \${new Date(alert.timestamp).toLocaleTimeString()}
                        </div>
                    </div>
                    <div style="color: #ff4444;">
                        \${alert.value.toFixed(1)}% / \${alert.threshold}%
                    </div>
                \`;
                container.appendChild(alertEl);
            });
        }
        
        function addAlert(alert) {
            const alerts = document.querySelectorAll('.alert-item');
            if (alerts.length > 10) {
                alerts[alerts.length - 1].remove();
            }
            
            const container = document.getElementById('alerts-list');
            const alertEl = document.createElement('div');
            alertEl.className = 'alert-item alert-' + alert.severity;
            alertEl.innerHTML = \`
                <div>
                    <strong>\${alert.message}</strong>
                    <div style="font-size: 0.8em; color: #666;">
                        \${new Date(alert.timestamp).toLocaleTimeString()}
                    </div>
                </div>
                <div style="color: #ff4444;">
                    \${alert.value.toFixed(1)}% / \${alert.threshold}%
                </div>
            \`;
            container.insertBefore(alertEl, container.firstChild);
        }
        
        function exportMetrics() {
            window.open('/api/export', '_blank');
        }
        
        function clearAlerts() {
            document.getElementById('alerts-list').innerHTML = '<p style="color: #666;">No active alerts</p>';
        }
    </script>
</body>
</html>
        `;
    }
    
    /**
     * Stop dashboard
     */
    async stop() {
        // Close all connections
        for (const client of this.clients) {
            client.close();
        }
        
        // Close WebSocket server
        if (this.wss) {
            this.wss.close();
        }
        
        // Close HTTP server
        if (this.server) {
            await new Promise((resolve) => {
                this.server.close(resolve);
            });
        }
        
        console.log('ダッシュボードを停止しました');
    }
}

module.exports = RealTimePerformanceDashboard;