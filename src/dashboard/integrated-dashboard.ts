/**
 * Integrated Dashboard Module
 * ダッシュボードサーバーとReactアプリケーションの統合
 * 
 * 設計思想：
 * - Carmack: 高速起動と効率的なリソース管理
 * - Martin: クリーンなモジュール統合
 * - Pike: シンプルな設定と起動
 */

import path from 'path';
import { EnhancedDashboardServer } from './dashboard-server';
import { EventBus } from '../event/bus';
import { MetricsCollector } from '../metrics/advanced-collector';
import { logger } from '../logging/logger';
import { initI18n } from '../i18n';

// === 設定型定義 ===
export interface IntegratedDashboardConfig {
  enabled: boolean;
  port: number;
  host?: string;
  updateInterval?: number;
  maxConnections?: number;
  corsOrigins?: string[];
  enableCompression?: boolean;
  staticPath?: string;
  buildPath?: string;
  devMode?: boolean;
}

// === 統合ダッシュボード ===
export class IntegratedDashboard {
  private server: EnhancedDashboardServer | null = null;
  private config: Required<IntegratedDashboardConfig>;
  
  constructor(
    config: IntegratedDashboardConfig,
    private eventBus: EventBus,
    private metricsCollector: MetricsCollector
  ) {
    // デフォルト設定の適用
    this.config = {
      enabled: config.enabled,
      port: config.port,
      host: config.host || '0.0.0.0',
      updateInterval: config.updateInterval || 1000,
      maxConnections: config.maxConnections || 100,
      corsOrigins: config.corsOrigins || ['http://localhost:3000'],
      enableCompression: config.enableCompression !== false,
      staticPath: config.staticPath || path.join(__dirname, '../../dashboard/build'),
      buildPath: config.buildPath || path.join(__dirname, '../../dashboard'),
      devMode: config.devMode || process.env.NODE_ENV === 'development'
    };
    
    // i18n初期化
    initI18n();
  }
  
  // ダッシュボードの開始
  async start(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('Dashboard is disabled in configuration');
      return;
    }
    
    try {
      // 開発モードでのビルドチェック
      if (this.config.devMode) {
        await this.checkAndBuildDashboard();
      }
      
      // サーバーの作成
      this.server = new EnhancedDashboardServer(
        {
          port: this.config.port,
          updateInterval: this.config.updateInterval,
          maxConnections: this.config.maxConnections,
          corsOrigins: this.config.corsOrigins,
          enableCompression: this.config.enableCompression,
          staticPath: this.config.staticPath
        },
        this.eventBus,
        this.metricsCollector
      );
      
      // サーバーの開始
      await this.server.start();
      
      logger.info(`Integrated dashboard started on http://${this.config.host}:${this.config.port}`);
      
      // ダッシュボードイベントの発行
      this.eventBus.emit('dashboard:started', {
        url: `http://${this.config.host}:${this.config.port}`,
        wsUrl: `ws://${this.config.host}:${this.config.port}/ws`
      });
      
    } catch (error) {
      logger.error('Failed to start integrated dashboard:', error);
      throw error;
    }
  }
  
  // ダッシュボードの停止
  async stop(): Promise<void> {
    if (!this.server) return;
    
    try {
      await this.server.stop();
      this.server = null;
      
      logger.info('Integrated dashboard stopped');
      
      this.eventBus.emit('dashboard:stopped');
      
    } catch (error) {
      logger.error('Failed to stop integrated dashboard:', error);
      throw error;
    }
  }
  
  // ダッシュボードのビルドチェック
  private async checkAndBuildDashboard(): Promise<void> {
    const fs = await import('fs').then(m => m.promises);
    const { exec } = await import('child_process').then(m => m.default);
    const util = await import('util');
    const execAsync = util.promisify(exec);
    
    try {
      // ビルドディレクトリの存在確認
      const buildExists = await fs.access(this.config.staticPath)
        .then(() => true)
        .catch(() => false);
      
      if (!buildExists) {
        logger.info('Dashboard build not found, building...');
        
        // package.jsonの存在確認
        const packageJsonPath = path.join(this.config.buildPath, 'package.json');
        const packageExists = await fs.access(packageJsonPath)
          .then(() => true)
          .catch(() => false);
        
        if (!packageExists) {
          // package.jsonの作成
          await this.createDashboardPackageJson();
        }
        
        // 依存関係のインストール
        logger.info('Installing dashboard dependencies...');
        await execAsync('npm install', { cwd: this.config.buildPath });
        
        // ビルドの実行
        logger.info('Building dashboard...');
        await execAsync('npm run build', { cwd: this.config.buildPath });
        
        logger.info('Dashboard build completed');
      }
    } catch (error) {
      logger.warn('Failed to build dashboard, using fallback:', error);
      // フォールバックとして基本的なHTMLを提供
      await this.createFallbackDashboard();
    }
  }
  
  // package.jsonの作成
  private async createDashboardPackageJson(): Promise<void> {
    const fs = await import('fs').then(m => m.promises);
    
    const packageJson = {
      name: 'otedama-dashboard',
      version: '1.0.0',
      private: true,
      dependencies: {
        'react': '^18.2.0',
        'react-dom': '^18.2.0',
        'react-scripts': '5.0.1',
        'typescript': '^5.0.0',
        'chart.js': '^4.4.0',
        'react-chartjs-2': '^5.2.0',
        'i18next': '^23.0.0',
        'react-i18next': '^13.0.0',
        'file-saver': '^2.0.5',
        'papaparse': '^5.4.0',
        'date-fns': '^2.30.0',
        '@types/react': '^18.2.0',
        '@types/react-dom': '^18.2.0',
        '@types/file-saver': '^2.0.5',
        '@types/papaparse': '^5.3.0'
      },
      scripts: {
        'start': 'react-scripts start',
        'build': 'react-scripts build',
        'test': 'react-scripts test',
        'eject': 'react-scripts eject'
      },
      eslintConfig: {
        extends: ['react-app']
      },
      browserslist: {
        production: ['>0.2%', 'not dead', 'not op_mini all'],
        development: ['last 1 chrome version', 'last 1 firefox version', 'last 1 safari version']
      }
    };
    
    await fs.mkdir(this.config.buildPath, { recursive: true });
    await fs.writeFile(
      path.join(this.config.buildPath, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );
  }
  
  // フォールバックダッシュボードの作成
  private async createFallbackDashboard(): Promise<void> {
    const fs = await import('fs').then(m => m.promises);
    
    const fallbackHtml = `<!DOCTYPE html>
<html>
<head>
    <title>Otedama Mining Pool Dashboard</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0a0a;
            color: #e0e0e0;
            margin: 0;
            padding: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
        }
        .container {
            text-align: center;
            max-width: 600px;
        }
        h1 {
            color: #00ff41;
            margin-bottom: 20px;
        }
        .status {
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 20px;
            margin: 20px 0;
        }
        .metric {
            display: flex;
            justify-content: space-between;
            margin: 10px 0;
            padding: 10px;
            background: #0a0a0a;
            border-radius: 4px;
        }
        .label {
            color: #888;
        }
        .value {
            color: #00ff41;
            font-weight: bold;
            font-family: monospace;
        }
        #status {
            color: #00ff41;
            margin: 10px 0;
        }
        .offline {
            color: #ff3333;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>⚡ Otedama Mining Pool</h1>
        <p id="status">Connecting to pool...</p>
        
        <div class="status" id="stats" style="display: none;">
            <div class="metric">
                <span class="label">Pool Hashrate</span>
                <span class="value" id="hashrate">0 H/s</span>
            </div>
            <div class="metric">
                <span class="label">Active Miners</span>
                <span class="value" id="miners">0</span>
            </div>
            <div class="metric">
                <span class="label">Total Shares</span>
                <span class="value" id="shares">0</span>
            </div>
            <div class="metric">
                <span class="label">Blocks Found</span>
                <span class="value" id="blocks">0</span>
            </div>
        </div>
    </div>
    
    <script>
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = wsProtocol + '//' + window.location.host + '/ws';
        let ws;
        
        function connect() {
            ws = new WebSocket(wsUrl);
            
            ws.onopen = () => {
                document.getElementById('status').textContent = 'Connected to pool';
                document.getElementById('status').classList.remove('offline');
                document.getElementById('stats').style.display = 'block';
            };
            
            ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    if (message.type === 'dashboardUpdate' && message.data) {
                        updateStats(message.data);
                    }
                } catch (error) {
                    console.error('Failed to parse message:', error);
                }
            };
            
            ws.onclose = () => {
                document.getElementById('status').textContent = 'Disconnected from pool';
                document.getElementById('status').classList.add('offline');
                setTimeout(connect, 5000);
            };
            
            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };
        }
        
        function updateStats(data) {
            if (data.poolStats) {
                document.getElementById('hashrate').textContent = formatHashrate(data.poolStats.hashrate);
                document.getElementById('miners').textContent = data.poolStats.activeMiners;
                document.getElementById('shares').textContent = data.poolStats.totalShares.toLocaleString();
                document.getElementById('blocks').textContent = data.poolStats.blocksFound;
            }
        }
        
        function formatHashrate(hashrate) {
            if (hashrate >= 1e15) return (hashrate / 1e15).toFixed(2) + ' PH/s';
            if (hashrate >= 1e12) return (hashrate / 1e12).toFixed(2) + ' TH/s';
            if (hashrate >= 1e9) return (hashrate / 1e9).toFixed(2) + ' GH/s';
            if (hashrate >= 1e6) return (hashrate / 1e6).toFixed(2) + ' MH/s';
            if (hashrate >= 1e3) return (hashrate / 1e3).toFixed(2) + ' KH/s';
            return hashrate.toFixed(2) + ' H/s';
        }
        
        connect();
    </script>
</body>
</html>`;
    
    await fs.mkdir(this.config.staticPath, { recursive: true });
    await fs.writeFile(
      path.join(this.config.staticPath, 'index.html'),
      fallbackHtml
    );
  }
  
  // 統計情報の取得
  getStats(): any {
    if (!this.server) {
      return {
        enabled: false,
        status: 'stopped'
      };
    }
    
    return {
      enabled: true,
      status: 'running',
      url: `http://${this.config.host}:${this.config.port}`,
      ...this.server.getStats()
    };
  }
  
  // 設定の更新
  async updateConfig(newConfig: Partial<IntegratedDashboardConfig>): Promise<void> {
    // 設定の更新
    Object.assign(this.config, newConfig);
    
    // 再起動が必要な場合
    if (this.server && (newConfig.port || newConfig.host)) {
      await this.stop();
      await this.start();
    }
  }
}

// === ヘルパー関数 ===
export function createDashboardFromConfig(
  config: any,
  eventBus: EventBus,
  metricsCollector: MetricsCollector
): IntegratedDashboard {
  const dashboardConfig: IntegratedDashboardConfig = {
    enabled: config.dashboard?.enabled !== false,
    port: config.dashboard?.port || 8080,
    host: config.dashboard?.host,
    updateInterval: config.dashboard?.updateInterval,
    maxConnections: config.dashboard?.maxConnections,
    corsOrigins: config.dashboard?.corsOrigins,
    enableCompression: config.dashboard?.enableCompression,
    staticPath: config.dashboard?.staticPath,
    buildPath: config.dashboard?.buildPath,
    devMode: config.dashboard?.devMode
  };
  
  return new IntegratedDashboard(dashboardConfig, eventBus, metricsCollector);
}

export default IntegratedDashboard;