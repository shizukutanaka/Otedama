// WebSocket server for real-time dashboard updates (Pike simplicity)
import * as WebSocket from 'ws';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { createComponentLogger } from '../logging/logger';

export interface DashboardConfig {
  httpPort: number;
  wsPort: number;
  host: string;
  updateInterval: number; // milliseconds
  maxConnections: number;
  enableAuth: boolean;
  authToken?: string;
}

export interface PoolStats {
  hashrate: number;
  miners: number;
  workers: number;
  difficulty: number;
  shares: {
    valid: number;
    invalid: number;
    total: number;
  };
  blocks: {
    found: number;
    pending: number;
    confirmed: number;
    orphaned: number;
  };
  network: {
    blockHeight: number;
    difficulty: number;
    hashrate: number;
  };
}

export interface MinerStats {
  id: string;
  hashrate: number;
  shares: number;
  lastShare: number;
  difficulty: number;
  connected: boolean;
}

export class DashboardServer extends EventEmitter {
  private logger = createComponentLogger('Dashboard');
  private httpServer: http.Server | https.Server | null = null;
  private wsServer: WebSocket.Server | null = null;
  private config: DashboardConfig;
  private clients = new Set<WebSocket>();
  private updateTimer: NodeJS.Timeout | null = null;
  private stats: PoolStats = {
    hashrate: 0,
    miners: 0,
    workers: 0,
    difficulty: 0,
    shares: { valid: 0, invalid: 0, total: 0 },
    blocks: { found: 0, pending: 0, confirmed: 0, orphaned: 0 },
    network: { blockHeight: 0, difficulty: 0, hashrate: 0 }
  };
  
  constructor(config: Partial<DashboardConfig> = {}) {
    super();
    this.config = {
      httpPort: 8080,
      wsPort: 8081,
      host: '0.0.0.0',
      updateInterval: 5000,
      maxConnections: 100,
      enableAuth: false,
      ...config
    };
  }
  
  // Start dashboard servers
  async start(tlsOptions?: any): Promise<void> {
    // Start HTTP server for static files
    await this.startHttpServer(tlsOptions);
    
    // Start WebSocket server
    await this.startWebSocketServer(tlsOptions);
    
    // Start periodic updates
    this.startUpdates();
    
    this.logger.info('Dashboard started', {
      httpPort: this.config.httpPort,
      wsPort: this.config.wsPort
    });
  }
  
  // Stop dashboard servers
  async stop(): Promise<void> {
    // Stop updates
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    
    // Close WebSocket connections
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    
    // Stop servers
    if (this.wsServer) {
      this.wsServer.close();
      this.wsServer = null;
    }
    
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
    
    this.logger.info('Dashboard stopped');
  }
  
  // Start HTTP server for static files
  private async startHttpServer(tlsOptions?: any): Promise<void> {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      this.handleHttpRequest(req, res);
    };
    
    if (tlsOptions) {
      this.httpServer = https.createServer(tlsOptions, handler);
    } else {
      this.httpServer = http.createServer(handler);
    }
    
    return new Promise((resolve, reject) => {
      this.httpServer!.listen(this.config.httpPort, this.config.host, () => {
        resolve();
      });
      
      this.httpServer!.on('error', reject);
    });
  }
  
  // Handle HTTP requests
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '/';
    
    // Serve dashboard HTML
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(this.getDashboardHtml());
      return;
    }
    
    // Serve dashboard JavaScript
    if (url === '/dashboard.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(this.getDashboardJs());
      return;
    }
    
    // Serve dashboard CSS
    if (url === '/dashboard.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(this.getDashboardCss());
      return;
    }
    
    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
  
  // Start WebSocket server
  private async startWebSocketServer(tlsOptions?: any): Promise<void> {
    const options: WebSocket.ServerOptions = {
      port: this.config.wsPort,
      host: this.config.host,
      maxPayload: 1024 * 1024 // 1MB
    };
    
    // If TLS is enabled, create HTTPS server first
    if (tlsOptions) {
      const server = https.createServer(tlsOptions);
      await new Promise<void>((resolve) => {
        server.listen(this.config.wsPort, this.config.host, () => resolve());
      });
      options.server = server;
      delete options.port;
      delete options.host;
    }
    
    this.wsServer = new WebSocket.Server(options);
    
    this.wsServer.on('connection', (ws, req) => {
      this.handleWebSocketConnection(ws, req);
    });
  }
  
  // Handle WebSocket connection
  private handleWebSocketConnection(ws: WebSocket, req: http.IncomingMessage): void {
    // Check max connections
    if (this.clients.size >= this.config.maxConnections) {
      ws.close(1008, 'Max connections reached');
      return;
    }
    
    // Check authentication if enabled
    if (this.config.enableAuth) {
      const token = this.extractAuthToken(req);
      if (token !== this.config.authToken) {
        ws.close(1008, 'Unauthorized');
        return;
      }
    }
    
    // Add client
    this.clients.add(ws);
    this.logger.debug('WebSocket client connected', {
      ip: req.socket.remoteAddress,
      totalClients: this.clients.size
    });
    
    // Send initial stats
    this.sendToClient(ws, {
      type: 'initial',
      data: this.stats
    });
    
    // Handle messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleClientMessage(ws, message);
      } catch (error) {
        this.logger.error('Invalid WebSocket message', error as Error);
      }
    });
    
    // Handle close
    ws.on('close', () => {
      this.clients.delete(ws);
      this.logger.debug('WebSocket client disconnected', {
        totalClients: this.clients.size
      });
    });
    
    // Handle error
    ws.on('error', (error) => {
      this.logger.error('WebSocket error', error);
      this.clients.delete(ws);
    });
  }
  
  // Extract auth token from request
  private extractAuthToken(req: http.IncomingMessage): string | null {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      return auth.substring(7);
    }
    
    // Check query parameter
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    return url.searchParams.get('token');
  }
  
  // Handle client message
  private handleClientMessage(ws: WebSocket, message: any): void {
    switch (message.type) {
      case 'ping':
        this.sendToClient(ws, { type: 'pong' });
        break;
        
      case 'subscribe':
        // Client can subscribe to specific events
        // For now, all clients get all updates
        break;
        
      default:
        this.logger.warn('Unknown message type', { type: message.type });
    }
  }
  
  // Send message to client
  private sendToClient(ws: WebSocket, message: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
  
  // Broadcast to all clients
  private broadcast(message: any): void {
    const data = JSON.stringify(message);
    
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }
  
  // Start periodic updates
  private startUpdates(): void {
    this.updateTimer = setInterval(() => {
      this.broadcast({
        type: 'update',
        data: this.stats
      });
    }, this.config.updateInterval);
  }
  
  // Update pool stats
  updateStats(stats: Partial<PoolStats>): void {
    Object.assign(this.stats, stats);
    
    // Broadcast immediately for important events
    if (stats.blocks?.found) {
      this.broadcast({
        type: 'block_found',
        data: { height: stats.network?.blockHeight }
      });
    }
  }
  
  // Update miner stats
  updateMinerStats(miners: MinerStats[]): void {
    this.broadcast({
      type: 'miners',
      data: miners
    });
  }
  
  // Emit events
  emitEvent(event: string, data: any): void {
    this.broadcast({
      type: 'event',
      event,
      data
    });
  }
  
  // Get dashboard HTML
  private getDashboardHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Otedama Pool Dashboard</title>
    <link rel="stylesheet" href="/dashboard.css">
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
</head>
<body>
    <div class="container">
        <header>
            <h1>Otedama Mining Pool</h1>
            <div class="status" id="connectionStatus">Connecting...</div>
        </header>
        
        <div class="stats-grid">
            <div class="stat-card">
                <h3>Pool Hashrate</h3>
                <div class="stat-value" id="poolHashrate">0 H/s</div>
            </div>
            <div class="stat-card">
                <h3>Active Miners</h3>
                <div class="stat-value" id="activeMiners">0</div>
            </div>
            <div class="stat-card">
                <h3>Total Shares</h3>
                <div class="stat-value" id="totalShares">0</div>
            </div>
            <div class="stat-card">
                <h3>Blocks Found</h3>
                <div class="stat-value" id="blocksFound">0</div>
            </div>
        </div>
        
        <div class="charts-grid">
            <div class="chart-container">
                <h3>Hashrate History</h3>
                <canvas id="hashrateChart"></canvas>
            </div>
            <div class="chart-container">
                <h3>Share Distribution</h3>
                <canvas id="shareChart"></canvas>
            </div>
        </div>
        
        <div class="miners-section">
            <h2>Top Miners</h2>
            <table id="minersTable">
                <thead>
                    <tr>
                        <th>Miner</th>
                        <th>Hashrate</th>
                        <th>Shares</th>
                        <th>Last Share</th>
                    </tr>
                </thead>
                <tbody id="minersBody">
                    <tr><td colspan="4">Loading...</td></tr>
                </tbody>
            </table>
        </div>
        
        <div class="network-section">
            <h3>Network Status</h3>
            <div class="network-stats">
                <div>Block Height: <span id="blockHeight">0</span></div>
                <div>Network Difficulty: <span id="networkDiff">0</span></div>
                <div>Network Hashrate: <span id="networkHash">0 H/s</span></div>
            </div>
        </div>
    </div>
    
    <script src="/dashboard.js"></script>
</body>
</html>`;
  }
  
  // Get dashboard JavaScript
  private getDashboardJs(): string {
    return `// Dashboard WebSocket client
const WS_URL = 'ws://' + window.location.hostname + ':${this.config.wsPort}';
let ws = null;
let reconnectTimer = null;
let charts = {};

// Format hashrate
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

// Format time ago
function timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
}

// Initialize charts
function initCharts() {
    // Hashrate chart
    const hashrateCtx = document.getElementById('hashrateChart').getContext('2d');
    charts.hashrate = new Chart(hashrateCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Pool Hashrate',
                data: [],
                borderColor: 'rgb(75, 192, 192)',
                backgroundColor: 'rgba(75, 192, 192, 0.1)',
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: function(value) {
                            return formatHashrate(value);
                        }
                    }
                }
            }
        }
    });
    
    // Share chart
    const shareCtx = document.getElementById('shareChart').getContext('2d');
    charts.shares = new Chart(shareCtx, {
        type: 'doughnut',
        data: {
            labels: ['Valid', 'Invalid'],
            datasets: [{
                data: [0, 0],
                backgroundColor: [
                    'rgba(75, 192, 192, 0.8)',
                    'rgba(255, 99, 132, 0.8)'
                ]
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false
        }
    });
}

// Update stats
function updateStats(data) {
    // Update text stats
    document.getElementById('poolHashrate').textContent = formatHashrate(data.hashrate);
    document.getElementById('activeMiners').textContent = data.miners;
    document.getElementById('totalShares').textContent = data.shares.total.toLocaleString();
    document.getElementById('blocksFound').textContent = data.blocks.found;
    
    // Update network stats
    document.getElementById('blockHeight').textContent = data.network.blockHeight.toLocaleString();
    document.getElementById('networkDiff').textContent = data.network.difficulty.toExponential(2);
    document.getElementById('networkHash').textContent = formatHashrate(data.network.hashrate);
    
    // Update hashrate chart
    const chart = charts.hashrate;
    if (chart) {
        const now = new Date().toLocaleTimeString();
        chart.data.labels.push(now);
        chart.data.datasets[0].data.push(data.hashrate);
        
        // Keep only last 20 points
        if (chart.data.labels.length > 20) {
            chart.data.labels.shift();
            chart.data.datasets[0].data.shift();
        }
        
        chart.update('none'); // No animation for performance
    }
    
    // Update share chart
    if (charts.shares) {
        charts.shares.data.datasets[0].data = [data.shares.valid, data.shares.invalid];
        charts.shares.update('none');
    }
}

// Update miners table
function updateMiners(miners) {
    const tbody = document.getElementById('minersBody');
    tbody.innerHTML = '';
    
    // Sort by hashrate
    miners.sort((a, b) => b.hashrate - a.hashrate);
    
    // Show top 10
    miners.slice(0, 10).forEach(miner => {
        const row = tbody.insertRow();
        row.insertCell(0).textContent = miner.id.substring(0, 8) + '...';
        row.insertCell(1).textContent = formatHashrate(miner.hashrate);
        row.insertCell(2).textContent = miner.shares.toLocaleString();
        row.insertCell(3).textContent = timeAgo(miner.lastShare);
        
        if (!miner.connected) {
            row.classList.add('offline');
        }
    });
    
    if (miners.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4">No miners connected</td></tr>';
    }
}

// WebSocket connection
function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        return;
    }
    
    ws = new WebSocket(WS_URL);
    
    ws.onopen = function() {
        console.log('Connected to dashboard');
        document.getElementById('connectionStatus').textContent = 'Connected';
        document.getElementById('connectionStatus').classList.add('connected');
        
        // Clear reconnect timer
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    };
    
    ws.onmessage = function(event) {
        try {
            const message = JSON.parse(event.data);
            
            switch (message.type) {
                case 'initial':
                case 'update':
                    updateStats(message.data);
                    break;
                    
                case 'miners':
                    updateMiners(message.data);
                    break;
                    
                case 'block_found':
                    // Show notification
                    console.log('Block found!', message.data);
                    break;
                    
                case 'event':
                    console.log('Event:', message.event, message.data);
                    break;
            }
        } catch (error) {
            console.error('Failed to parse message:', error);
        }
    };
    
    ws.onerror = function(error) {
        console.error('WebSocket error:', error);
    };
    
    ws.onclose = function() {
        console.log('Disconnected from dashboard');
        document.getElementById('connectionStatus').textContent = 'Disconnected';
        document.getElementById('connectionStatus').classList.remove('connected');
        
        // Reconnect after 5 seconds
        if (!reconnectTimer) {
            reconnectTimer = setTimeout(connect, 5000);
        }
    };
}

// Initialize on load
window.addEventListener('load', function() {
    initCharts();
    connect();
    
    // Send ping every 30 seconds
    setInterval(function() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000);
});`;
  }
  
  // Get dashboard CSS
  private getDashboardCss(): string {
    return `/* Dashboard styles */
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f0f0f;
    color: #e0e0e0;
    line-height: 1.6;
}

.container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 20px;
}

header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 30px;
    padding-bottom: 20px;
    border-bottom: 1px solid #333;
}

h1 {
    font-size: 2.5em;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
}

.status {
    padding: 8px 16px;
    border-radius: 20px;
    background: #333;
    font-size: 0.9em;
}

.status.connected {
    background: #10b981;
    color: #000;
}

.stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 20px;
    margin-bottom: 30px;
}

.stat-card {
    background: #1a1a1a;
    padding: 20px;
    border-radius: 10px;
    border: 1px solid #333;
    transition: transform 0.2s, border-color 0.2s;
}

.stat-card:hover {
    transform: translateY(-2px);
    border-color: #667eea;
}

.stat-card h3 {
    font-size: 0.9em;
    color: #888;
    margin-bottom: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
}

.stat-value {
    font-size: 2em;
    font-weight: bold;
    color: #fff;
}

.charts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
    gap: 20px;
    margin-bottom: 30px;
}

.chart-container {
    background: #1a1a1a;
    padding: 20px;
    border-radius: 10px;
    border: 1px solid #333;
}

.chart-container h3 {
    margin-bottom: 15px;
    color: #fff;
}

.chart-container canvas {
    max-height: 300px;
}

.miners-section {
    background: #1a1a1a;
    padding: 20px;
    border-radius: 10px;
    border: 1px solid #333;
    margin-bottom: 30px;
}

.miners-section h2 {
    margin-bottom: 20px;
    color: #fff;
}

table {
    width: 100%;
    border-collapse: collapse;
}

th, td {
    padding: 12px;
    text-align: left;
    border-bottom: 1px solid #333;
}

th {
    background: #252525;
    font-weight: 600;
    color: #888;
    text-transform: uppercase;
    font-size: 0.85em;
    letter-spacing: 1px;
}

tr:hover {
    background: #252525;
}

tr.offline {
    opacity: 0.5;
}

.network-section {
    background: #1a1a1a;
    padding: 20px;
    border-radius: 10px;
    border: 1px solid #333;
}

.network-section h3 {
    margin-bottom: 15px;
    color: #fff;
}

.network-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 15px;
}

.network-stats > div {
    padding: 10px;
    background: #252525;
    border-radius: 5px;
}

.network-stats span {
    font-weight: bold;
    color: #667eea;
}

/* Responsive */
@media (max-width: 768px) {
    .stats-grid {
        grid-template-columns: 1fr;
    }
    
    .charts-grid {
        grid-template-columns: 1fr;
    }
    
    table {
        font-size: 0.9em;
    }
    
    .stat-value {
        font-size: 1.5em;
    }
}

/* Dark scrollbar */
::-webkit-scrollbar {
    width: 10px;
}

::-webkit-scrollbar-track {
    background: #1a1a1a;
}

::-webkit-scrollbar-thumb {
    background: #333;
    border-radius: 5px;
}

::-webkit-scrollbar-thumb:hover {
    background: #444;
}`;
  }
}

// Dashboard data collector
export class DashboardDataCollector {
  private logger = createComponentLogger('DashboardCollector');
  private dashboardServer: DashboardServer;
  private pool: any;
  private updateInterval: NodeJS.Timeout | null = null;
  
  constructor(dashboardServer: DashboardServer, pool: any) {
    this.dashboardServer = dashboardServer;
    this.pool = pool;
  }
  
  // Start collecting data
  start(intervalMs: number = 5000): void {
    // Initial collection
    this.collect();
    
    // Periodic collection
    this.updateInterval = setInterval(() => {
      this.collect();
    }, intervalMs);
    
    // Listen for pool events
    this.setupEventListeners();
    
    this.logger.info('Dashboard data collection started');
  }
  
  // Stop collecting
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    this.logger.info('Dashboard data collection stopped');
  }
  
  // Collect data from pool
  private async collect(): Promise<void> {
    try {
      // Get pool stats
      const poolStats = await this.pool.getStats();
      
      // Calculate total hashrate
      let totalHashrate = 0;
      const miners = await this.pool.db?.getAllMiners() || [];
      
      for (const miner of miners) {
        if (miner.isActive(300)) { // 5 minutes
          totalHashrate += miner.hashrate;
        }
      }
      
      // Get share stats from database
      const dbStats = await this.pool.db?.getPoolStats() || {
        totalShares: 0,
        totalMiners: 0,
        activeMiners: 0
      };
      
      // Update dashboard stats
      this.dashboardServer.updateStats({
        hashrate: totalHashrate,
        miners: dbStats.activeMiners,
        workers: dbStats.activeMiners, // Simplified: 1 worker per miner
        difficulty: 0, // Would need average difficulty calculation
        shares: {
          valid: dbStats.totalShares,
          invalid: 0, // Would need to track invalid shares
          total: dbStats.totalShares
        },
        blocks: {
          found: poolStats.pool.blocksFound || 0,
          pending: 0,
          confirmed: poolStats.pool.blocksFound || 0,
          orphaned: 0
        },
        network: {
          blockHeight: poolStats.pool.blockHeight || 0,
          difficulty: poolStats.pool.networkDifficulty || 0,
          hashrate: 0 // Would need network hashrate calculation
        }
      });
      
      // Update miner stats
      const minerStats: MinerStats[] = miners
        .filter(m => m.isActive(300))
        .map(miner => ({
          id: miner.id,
          hashrate: miner.hashrate,
          shares: miner.shares,
          lastShare: miner.lastShareTime,
          difficulty: miner.difficulty,
          connected: miner.isActive(60) // 1 minute for "connected" status
        }));
      
      this.dashboardServer.updateMinerStats(minerStats);
      
    } catch (error) {
      this.logger.error('Failed to collect dashboard data', error as Error);
    }
  }
  
  // Setup event listeners
  private setupEventListeners(): void {
    // Listen for share events
    if (this.pool.poolCore) {
      this.pool.poolCore.on('share:accepted', (share: any) => {
        this.dashboardServer.emitEvent('share_accepted', {
          minerId: share.minerId,
          difficulty: share.difficulty
        });
      });
      
      this.pool.poolCore.on('share:rejected', (share: any) => {
        this.dashboardServer.emitEvent('share_rejected', {
          minerId: share.minerId,
          reason: share.reason
        });
      });
      
      this.pool.poolCore.on('block:found', (block: any) => {
        this.dashboardServer.emitEvent('block_found', {
          height: block.height,
          hash: block.hash,
          minerId: block.minerId
        });
      });
    }
    
    // Listen for miner events
    if (this.pool.stratumServer) {
      // Would need to emit these events from stratum server
      // this.pool.stratumServer.on('miner:connected', ...)
      // this.pool.stratumServer.on('miner:disconnected', ...)
    }
  }
}
