/**
 * Otedama - 軽量Webサーバー (モバイルダッシュボード対応)
 * 設計思想: John Carmack (効率性), Robert C. Martin (保守性), Rob Pike (シンプルさ)
 * 
 * 機能:
 * - 軽量モバイルダッシュボード配信
 * - リアルタイムAPI
 * - WebSocket通信
 * - 100言語対応
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';
import WebSocket from 'ws';

// === 軽量型定義 ===
export interface DashboardData {
  system: {
    health: 'GOOD' | 'WARNING' | 'CRITICAL' | 'EMERGENCY';
    uptime: number;
    mining: boolean;
  };
  temperature: {
    cpu: number;
    gpu: number;
  };
  power: {
    consumption: number;    // Watts
    hashrate: number;       // H/s
    efficiency: number;     // H/W
  };
  revenue: {
    coin: string;
    daily: number;          // USD
    monthly: number;        // USD
    profit: number;         // USD (after electricity)
  };
  alerts: Array<{
    level: 'info' | 'warning' | 'critical';
    message: string;
    time: number;
  }>;
}

export interface LightWebServerConfig {
  port: number;
  staticPath?: string;
  apiPrefix: string;
  enableWebSocket: boolean;
  corsOrigins: string[];
  updateIntervalMs: number;
}

// === 軽量Webサーバークラス ===
export class LightWebServer extends EventEmitter {
  private server: any;
  private wsServer?: WebSocket.Server;
  private config: LightWebServerConfig;
  private dashboardData: DashboardData;
  private updateInterval?: NodeJS.Timeout;
  private connectedClients = new Set<WebSocket>();

  // ハードウェア監視への参照
  private hardwareMonitor?: any;
  private revenueCalculator?: any;

  constructor(config: Partial<LightWebServerConfig> = {}) {
    super();
    
    this.config = {
      port: 8080,
      staticPath: join(__dirname, '../ui'),
      apiPrefix: '/api',
      enableWebSocket: true,
      corsOrigins: ['*'],
      updateIntervalMs: 3000,
      ...config
    };

    this.dashboardData = this.initializeDashboardData();
    this.server = createServer(this.handleRequest.bind(this));
    
    if (this.config.enableWebSocket) {
      this.setupWebSocket();
    }
  }

  private initializeDashboardData(): DashboardData {
    return {
      system: {
        health: 'GOOD',
        uptime: 0,
        mining: false
      },
      temperature: {
        cpu: 0,
        gpu: 0
      },
      power: {
        consumption: 0,
        hashrate: 0,
        efficiency: 0
      },
      revenue: {
        coin: '--',
        daily: 0,
        monthly: 0,
        profit: 0
      },
      alerts: []
    };
  }

  // === HTTP リクエストハンドリング ===
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsedUrl = parse(req.url || '', true);
    const pathname = parsedUrl.pathname || '/';

    // CORS ヘッダー
    this.setCorsHeaders(res);

    // OPTIONS プリフライト
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      // API エンドポイント
      if (pathname.startsWith(this.config.apiPrefix)) {
        await this.handleApiRequest(req, res, pathname);
        return;
      }

      // 静的ファイル配信
      await this.handleStaticRequest(req, res, pathname);
      
    } catch (error) {
      console.error('Request handling error:', error);
      this.sendError(res, 500, 'Internal Server Error');
    }
  }

  private setCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  // === API ハンドリング (軽量化) ===
  private async handleApiRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const apiPath = pathname.replace(this.config.apiPrefix, '');
    
    switch (apiPath) {
      case '/dashboard-data':
        this.sendJson(res, this.dashboardData);
        break;
        
      case '/system-status':
        this.sendJson(res, this.dashboardData.system);
        break;
        
      case '/temperature':
        this.sendJson(res, this.dashboardData.temperature);
        break;
        
      case '/power':
        this.sendJson(res, this.dashboardData.power);
        break;
        
      case '/revenue':
        this.sendJson(res, this.dashboardData.revenue);
        break;
        
      case '/alerts':
        this.sendJson(res, this.dashboardData.alerts);
        break;

      case '/mining/start':
        if (req.method === 'POST') {
          await this.handleMiningStart();
          this.sendJson(res, { success: true, message: 'Mining started' });
        } else {
          this.sendError(res, 405, 'Method Not Allowed');
        }
        break;

      case '/mining/stop':
        if (req.method === 'POST') {
          await this.handleMiningStop();
          this.sendJson(res, { success: true, message: 'Mining stopped' });
        } else {
          this.sendError(res, 405, 'Method Not Allowed');
        }
        break;

      case '/mining/optimize':
        if (req.method === 'POST') {
          await this.handleMiningOptimize();
          this.sendJson(res, { success: true, message: 'Optimization started' });
        } else {
          this.sendError(res, 405, 'Method Not Allowed');
        }
        break;

      case '/health':
        this.sendJson(res, {
          status: 'ok',
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          version: '1.0.0'
        });
        break;

      default:
        this.sendError(res, 404, 'API endpoint not found');
    }
  }

  // === 静的ファイル配信 (軽量化) ===
  private async handleStaticRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    let filePath: string;

    // ルートパスの場合はダッシュボードを返す
    if (pathname === '/') {
      const dashboardContent = this.getDashboardHTML();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(dashboardContent);
      return;
    }

    // ファイルパス解決
    filePath = join(this.config.staticPath || '', pathname);

    // セキュリティチェック (ディレクトリトラバーサル防止)
    if (!filePath.startsWith(this.config.staticPath || '')) {
      this.sendError(res, 403, 'Forbidden');
      return;
    }

    // ファイル存在チェック
    if (!existsSync(filePath)) {
      this.sendError(res, 404, 'File not found');
      return;
    }

    try {
      const content = readFileSync(filePath);
      const contentType = this.getContentType(filePath);
      
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch (error) {
      this.sendError(res, 500, 'Error reading file');
    }
  }

  // === ダッシュボードHTML取得 ===
  private getDashboardHTML(): string {
    // インラインダッシュボード (軽量化のため埋め込み)
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Otedama Mining Dashboard</title>
    <style>
        /* 軽量CSS */
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; }
        .container { max-width: 1200px; margin: 0 auto; padding: 1rem; }
        .header { background: #1f2937; color: white; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; }
        .card { background: white; border-radius: 8px; padding: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .metric { display: flex; justify-content: space-between; padding: 0.5rem 0; }
        .status-good { color: #059669; }
        .status-warning { color: #d97706; }
        .status-critical { color: #dc2626; }
        .btn { padding: 0.5rem 1rem; border: none; border-radius: 4px; cursor: pointer; }
        .btn-primary { background: #2563eb; color: white; }
        .btn-success { background: #059669; color: white; }
        .btn-danger { background: #dc2626; color: white; }
        @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎯 Otedama Mining Dashboard</h1>
        </div>
        
        <div class="grid">
            <div class="card">
                <h3>System Status</h3>
                <div class="metric">
                    <span>Health:</span>
                    <span id="health" class="status-good">GOOD</span>
                </div>
                <div class="metric">
                    <span>Mining:</span>
                    <span id="mining-status">Stopped</span>
                </div>
            </div>
            
            <div class="card">
                <h3>Temperature</h3>
                <div class="metric">
                    <span>CPU:</span>
                    <span id="cpu-temp">--°C</span>
                </div>
                <div class="metric">
                    <span>GPU:</span>
                    <span id="gpu-temp">--°C</span>
                </div>
            </div>
            
            <div class="card">
                <h3>Power & Performance</h3>
                <div class="metric">
                    <span>Power:</span>
                    <span id="power">-- W</span>
                </div>
                <div class="metric">
                    <span>Hashrate:</span>
                    <span id="hashrate">-- H/s</span>
                </div>
            </div>
            
            <div class="card">
                <h3>Revenue</h3>
                <div class="metric">
                    <span>Daily:</span>
                    <span id="daily-revenue">$--</span>
                </div>
                <div class="metric">
                    <span>Profit:</span>
                    <span id="daily-profit">$--</span>
                </div>
            </div>
            
            <div class="card">
                <h3>Controls</h3>
                <button class="btn btn-success" onclick="startMining()">Start Mining</button>
                <button class="btn btn-danger" onclick="stopMining()">Stop Mining</button>
                <button class="btn btn-primary" onclick="optimize()">Optimize</button>
            </div>
        </div>
    </div>

    <script>
        let ws;
        
        function connectWebSocket() {
            if (typeof WebSocket !== 'undefined') {
                ws = new WebSocket('ws://localhost:${this.config.port + 1}');
                ws.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    updateUI(data);
                };
            }
        }
        
        function updateUI(data) {
            document.getElementById('health').textContent = data.system?.health || 'UNKNOWN';
            document.getElementById('mining-status').textContent = data.system?.mining ? 'Active' : 'Stopped';
            document.getElementById('cpu-temp').textContent = data.temperature?.cpu ? data.temperature.cpu + '°C' : '--°C';
            document.getElementById('gpu-temp').textContent = data.temperature?.gpu ? data.temperature.gpu + '°C' : '--°C';
            document.getElementById('power').textContent = data.power?.consumption ? data.power.consumption + ' W' : '-- W';
            document.getElementById('hashrate').textContent = formatHashrate(data.power?.hashrate || 0);
            document.getElementById('daily-revenue').textContent = '$' + (data.revenue?.daily || 0).toFixed(2);
            document.getElementById('daily-profit').textContent = '$' + (data.revenue?.profit || 0).toFixed(2);
        }
        
        function formatHashrate(hashrate) {
            if (hashrate >= 1e9) return (hashrate / 1e9).toFixed(1) + ' GH/s';
            if (hashrate >= 1e6) return (hashrate / 1e6).toFixed(1) + ' MH/s';
            if (hashrate >= 1e3) return (hashrate / 1e3).toFixed(1) + ' KH/s';
            return hashrate.toFixed(0) + ' H/s';
        }
        
        async function startMining() {
            try {
                await fetch('/api/mining/start', { method: 'POST' });
                alert('Mining started!');
            } catch (error) {
                alert('Error starting mining');
            }
        }
        
        async function stopMining() {
            try {
                await fetch('/api/mining/stop', { method: 'POST' });
                alert('Mining stopped!');
            } catch (error) {
                alert('Error stopping mining');
            }
        }
        
        async function optimize() {
            try {
                await fetch('/api/mining/optimize', { method: 'POST' });
                alert('Optimization started!');
            } catch (error) {
                alert('Error optimizing');
            }
        }
        
        // 初期化
        connectWebSocket();
        setInterval(async () => {
            try {
                const response = await fetch('/api/dashboard-data');
                const data = await response.json();
                updateUI(data);
            } catch (error) {
                console.error('Failed to fetch data:', error);
            }
        }, 3000);
    </script>
</body>
</html>`;
  }

  // === WebSocket セットアップ ===
  private setupWebSocket(): void {
    this.wsServer = new WebSocket.Server({ port: this.config.port + 1 });
    
    this.wsServer.on('connection', (ws) => {
      this.connectedClients.add(ws);
      console.log('WebSocket client connected');
      
      // 初期データ送信
      ws.send(JSON.stringify(this.dashboardData));
      
      ws.on('close', () => {
        this.connectedClients.delete(ws);
        console.log('WebSocket client disconnected');
      });
      
      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.connectedClients.delete(ws);
      });
    });
  }

  // === データ更新とブロードキャスト ===
  private broadcastData(): void {
    if (this.connectedClients.size === 0) return;
    
    const message = JSON.stringify(this.dashboardData);
    
    this.connectedClients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      } else {
        this.connectedClients.delete(ws);
      }
    });
  }

  // === マイニング操作 ===
  private async handleMiningStart(): Promise<void> {
    this.dashboardData.system.mining = true;
    this.emit('miningStart');
    this.broadcastData();
  }

  private async handleMiningStop(): Promise<void> {
    this.dashboardData.system.mining = false;
    this.emit('miningStop');
    this.broadcastData();
  }

  private async handleMiningOptimize(): Promise<void> {
    this.emit('miningOptimize');
    // 最適化処理はここで実装
  }

  // === ユーティリティメソッド ===
  private sendJson(res: ServerResponse, data: any): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private sendError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }

  private getContentType(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const types: { [key: string]: string } = {
      'html': 'text/html',
      'css': 'text/css',
      'js': 'application/javascript',
      'json': 'application/json',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'svg': 'image/svg+xml',
      'ico': 'image/x-icon'
    };
    return types[ext || ''] || 'application/octet-stream';
  }

  // === 外部システム統合 ===
  setHardwareMonitor(monitor: any): void {
    this.hardwareMonitor = monitor;
    
    // ハードウェア監視イベント
    if (monitor) {
      monitor.on('reading', (reading: any) => {
        this.dashboardData.system.health = reading.system?.health || 'GOOD';
        this.dashboardData.temperature.cpu = reading.cpu?.temperature || 0;
        this.dashboardData.temperature.gpu = reading.gpu?.length > 0 ? 
          Math.max(...reading.gpu.map((g: any) => g.temperature)) : 0;
        this.dashboardData.power.consumption = reading.system?.totalPower || 0;
        this.broadcastData();
      });
      
      monitor.on('alert', (alert: any) => {
        this.dashboardData.alerts.push({
          level: alert.level.toLowerCase(),
          message: alert.message,
          time: alert.timestamp
        });
        
        // アラート履歴制限
        if (this.dashboardData.alerts.length > 10) {
          this.dashboardData.alerts.shift();
        }
        
        this.broadcastData();
      });
    }
  }

  setRevenueCalculator(calculator: any): void {
    this.revenueCalculator = calculator;
    
    // 収益計算イベント
    if (calculator) {
      calculator.on('revenueUpdate', (revenue: any) => {
        this.dashboardData.revenue = {
          coin: revenue.coin,
          daily: revenue.dailyRevenue,
          monthly: revenue.dailyRevenue * 30,
          profit: revenue.dailyProfit
        };
        this.broadcastData();
      });
    }
  }

  updateHashrate(hashrate: number): void {
    this.dashboardData.power.hashrate = hashrate;
    this.dashboardData.power.efficiency = this.dashboardData.power.consumption > 0 ?
      hashrate / this.dashboardData.power.consumption : 0;
    this.broadcastData();
  }

  // === サーバー制御 ===
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.config.port, () => {
        console.log(`🌐 Light Web Server listening on http://localhost:${this.config.port}`);
        console.log(`📱 Mobile Dashboard: http://localhost:${this.config.port}`);
        
        if (this.config.enableWebSocket) {
          console.log(`🔗 WebSocket Server: ws://localhost:${this.config.port + 1}`);
        }
        
        // 定期更新開始
        this.updateInterval = setInterval(() => {
          this.broadcastData();
        }, this.config.updateIntervalMs);
        
        this.emit('started');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }
    
    if (this.wsServer) {
      this.wsServer.close();
    }
    
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('Light Web Server stopped');
        this.emit('stopped');
        resolve();
      });
    });
  }

  // === ゲッター ===
  getConfig(): LightWebServerConfig {
    return { ...this.config };
  }

  getDashboardData(): DashboardData {
    return { ...this.dashboardData };
  }

  getConnectedClients(): number {
    return this.connectedClients.size;
  }
}

// === ファクトリー関数 ===
export async function createLightWebServer(config?: Partial<LightWebServerConfig>): Promise<LightWebServer> {
  const server = new LightWebServer(config);
  
  // 基本イベントハンドラー
  server.on('miningStart', () => {
    console.log('🚀 Mining started via web interface');
  });
  
  server.on('miningStop', () => {
    console.log('⏹️ Mining stopped via web interface');
  });
  
  server.on('miningOptimize', () => {
    console.log('⚡ Mining optimization triggered via web interface');
  });
  
  return server;
}

// === 使用例 ===
export async function startLightWebServer(
  port: number = 8080,
  hardwareMonitor?: any,
  revenueCalculator?: any
): Promise<LightWebServer> {
  const server = await createLightWebServer({ port });
  
  if (hardwareMonitor) {
    server.setHardwareMonitor(hardwareMonitor);
  }
  
  if (revenueCalculator) {
    server.setRevenueCalculator(revenueCalculator);
  }
  
  await server.start();
  
  console.log('✅ 軽量Webサーバー開始完了');
  return server;
}