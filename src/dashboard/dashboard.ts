// Real-time monitoring dashboard (Pike simplicity)
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import { Database } from '../database/database';
import { OtedamaPool } from '../main';

export interface DashboardConfig {
  port: number;
  updateInterval: number;
}

export class MonitoringDashboard {
  private server: http.Server;
  private wss: WebSocketServer;
  private updateInterval: NodeJS.Timeout | null = null;
  private clients = new Set<WebSocket>();
  
  constructor(
    private config: DashboardConfig,
    private pool: OtedamaPool
  ) {
    this.server = http.createServer(this.handleRequest.bind(this));
    this.wss = new WebSocketServer({ server: this.server });
    this.setupWebSocket();
  }
  
  async start(): Promise<void> {
    this.server.listen(this.config.port, () => {
      console.log(`Dashboard running at http://localhost:${this.config.port}`);
    });
    
    // Start sending updates
    this.startUpdates();
  }
  
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(this.getHTML());
    } else if (req.url === '/api/stats') {
      this.handleAPIStats(req, res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  }
  
  private async handleAPIStats(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const stats = await this.pool.getStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats, null, 2));
  }
  
  private setupWebSocket(): void {
    this.wss.on('connection', (ws) => {
      console.log('Dashboard client connected');
      this.clients.add(ws);
      
      // Send initial data
      this.sendUpdate(ws);
      
      ws.on('close', () => {
        this.clients.delete(ws);
        console.log('Dashboard client disconnected');
      });
      
      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.clients.delete(ws);
      });
    });
  }
  
  private startUpdates(): void {
    this.updateInterval = setInterval(async () => {
      const stats = await this.getStats();
      const message = JSON.stringify({ type: 'update', data: stats });
      
      // Broadcast to all clients
      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    }, this.config.updateInterval);
  }
  
  private async sendUpdate(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.OPEN) {
      const stats = await this.getStats();
      ws.send(JSON.stringify({ type: 'update', data: stats }));
    }
  }
  
  private async getStats(): Promise<any> {
    const poolStats = await this.pool.getStats();
    
    return {
      timestamp: new Date().toISOString(),
      ...poolStats,
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage()
      }
    };
  }
  
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    for (const client of this.clients) {
      client.close();
    }
    
    this.wss.close();
    this.server.close();
  }
  
  private getHTML(): string {
    return `<!DOCTYPE html>
<html>
<head>
    <title>Otedama Mining Pool Dashboard</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
            background: #0a0a0a;
            color: #e0e0e0;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        h1 {
            color: #00ff41;
            margin-bottom: 30px;
            font-size: 2.5em;
            text-shadow: 0 0 10px rgba(0, 255, 65, 0.5);
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .card {
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
        }
        .card h2 {
            color: #00ff41;
            margin-bottom: 15px;
            font-size: 1.2em;
        }
        .metric {
            display: flex;
            justify-content: space-between;
            margin: 10px 0;
            padding: 8px 0;
            border-bottom: 1px solid #333;
        }
        .metric:last-child {
            border-bottom: none;
        }
        .label {
            color: #888;
        }
        .value {
            color: #fff;
            font-weight: bold;
            font-family: monospace;
        }
        .status {
            display: inline-block;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            margin-right: 10px;
        }
        .status.online { background: #00ff41; box-shadow: 0 0 5px #00ff41; }
        .status.warning { background: #ffcc00; box-shadow: 0 0 5px #ffcc00; }
        .status.offline { background: #ff3333; box-shadow: 0 0 5px #ff3333; }
        .chart {
            margin-top: 20px;
            height: 200px;
            background: #0a0a0a;
            border-radius: 4px;
            position: relative;
            overflow: hidden;
        }
        #log {
            background: #0a0a0a;
            border: 1px solid #333;
            border-radius: 4px;
            padding: 10px;
            height: 200px;
            overflow-y: auto;
            font-family: monospace;
            font-size: 0.9em;
        }
        .log-entry {
            margin: 2px 0;
            padding: 2px 0;
        }
        .log-info { color: #00ff41; }
        .log-warn { color: #ffcc00; }
        .log-error { color: #ff3333; }
    </style>
</head>
<body>
    <div class="container">
        <h1>⚡ Otedama Mining Pool</h1>
        
        <div class="grid">
            <div class="card">
                <h2>Pool Status</h2>
                <div class="metric">
                    <span class="label">Status</span>
                    <span class="value"><span class="status online"></span>Online</span>
                </div>
                <div class="metric">
                    <span class="label">Uptime</span>
                    <span class="value" id="uptime">0h 0m</span>
                </div>
                <div class="metric">
                    <span class="label">Health</span>
                    <span class="value" id="health">OK</span>
                </div>
            </div>
            
            <div class="card">
                <h2>Mining Stats</h2>
                <div class="metric">
                    <span class="label">Hashrate</span>
                    <span class="value" id="hashrate">0 GH/s</span>
                </div>
                <div class="metric">
                    <span class="label">Active Miners</span>
                    <span class="value" id="activeMiners">0</span>
                </div>
                <div class="metric">
                    <span class="label">Total Shares</span>
                    <span class="value" id="totalShares">0</span>
                </div>
            </div>
            
            <div class="card">
                <h2>Network</h2>
                <div class="metric">
                    <span class="label">Connections</span>
                    <span class="value" id="connections">0</span>
                </div>
                <div class="metric">
                    <span class="label">Authorized</span>
                    <span class="value" id="authorized">0</span>
                </div>
                <div class="metric">
                    <span class="label">Blocked IPs</span>
                    <span class="value" id="blockedIps">0</span>
                </div>
            </div>
            
            <div class="card">
                <h2>System</h2>
                <div class="metric">
                    <span class="label">Memory Usage</span>
                    <span class="value" id="memory">0 MB</span>
                </div>
                <div class="metric">
                    <span class="label">CPU Usage</span>
                    <span class="value" id="cpu">0%</span>
                </div>
                <div class="metric">
                    <span class="label">Circuit Breaker</span>
                    <span class="value" id="circuitBreaker">Closed</span>
                </div>
            </div>
        </div>
        
        <div class="card">
            <h2>Live Log</h2>
            <div id="log"></div>
        </div>
    </div>
    
    <script>
        let ws;
        const logContainer = document.getElementById('log');
        const maxLogEntries = 50;
        
        function connect() {
            ws = new WebSocket('ws://localhost:${this.config.port}');
            
            ws.onopen = () => {
                addLog('Connected to pool', 'info');
            };
            
            ws.onmessage = (event) => {
                const message = JSON.parse(event.data);
                if (message.type === 'update') {
                    updateStats(message.data);
                }
            };
            
            ws.onclose = () => {
                addLog('Disconnected from pool', 'error');
                setTimeout(connect, 5000);
            };
            
            ws.onerror = (error) => {
                addLog('WebSocket error', 'error');
            };
        }
        
        function updateStats(data) {
            // Update uptime
            const uptime = Math.floor(data.uptime || 0);
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            document.getElementById('uptime').textContent = hours + 'h ' + minutes + 'm';
            
            // Update health
            document.getElementById('health').textContent = data.health ? 'OK' : 'DEGRADED';
            
            // Update mining stats
            const dbStats = data.database || {};
            document.getElementById('hashrate').textContent = 
                formatHashrate(dbStats.poolHashrate || 0);
            document.getElementById('activeMiners').textContent = 
                dbStats.activeMiners || 0;
            document.getElementById('totalShares').textContent = 
                (dbStats.totalShares || 0).toLocaleString();
            
            // Update network stats
            const stratumStats = data.stratum || {};
            document.getElementById('connections').textContent = 
                stratumStats.connections || 0;
            document.getElementById('authorized').textContent = 
                stratumStats.authorized || 0;
            document.getElementById('blockedIps').textContent = 
                (stratumStats.ddosStats?.blockedIPs || 0);
            
            // Update system stats
            const memory = data.system?.memory || {};
            const memoryMB = Math.round((memory.heapUsed || 0) / 1024 / 1024);
            document.getElementById('memory').textContent = memoryMB + ' MB';
            
            const cpu = data.system?.cpu || {};
            const cpuPercent = Math.round(((cpu.user || 0) + (cpu.system || 0)) / 1000000);
            document.getElementById('cpu').textContent = cpuPercent + '%';
            
            const poolStats = data.pool || {};
            document.getElementById('circuitBreaker').textContent = 
                poolStats.circuitBreakerState || 'Unknown';
        }
        
        function formatHashrate(hashrate) {
            if (hashrate > 1e12) return (hashrate / 1e12).toFixed(2) + ' TH/s';
            if (hashrate > 1e9) return (hashrate / 1e9).toFixed(2) + ' GH/s';
            if (hashrate > 1e6) return (hashrate / 1e6).toFixed(2) + ' MH/s';
            if (hashrate > 1e3) return (hashrate / 1e3).toFixed(2) + ' KH/s';
            return hashrate.toFixed(2) + ' H/s';
        }
        
        function addLog(message, type = 'info') {
            const entry = document.createElement('div');
            entry.className = 'log-entry log-' + type;
            entry.textContent = new Date().toLocaleTimeString() + ' - ' + message;
            
            logContainer.appendChild(entry);
            
            // Keep only last N entries
            while (logContainer.children.length > maxLogEntries) {
                logContainer.removeChild(logContainer.firstChild);
            }
            
            // Scroll to bottom
            logContainer.scrollTop = logContainer.scrollHeight;
        }
        
        // Connect on load
        connect();
    </script>
</body>
</html>`;
  }
}
