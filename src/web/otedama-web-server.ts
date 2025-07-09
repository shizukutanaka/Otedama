/**
 * Otedama Web Server - Digital Dashboard API
 * デジタルUIとリアルタイムデータを提供
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { EventEmitter } from 'events';
import OtedamaCoreSystem from '../core/otedama-core-system';

// === 型定義 ===
interface DashboardData {
  pool: {
    hashrate: number;
    hashrateUnit: string;
    miners: number;
    activeMiners: number;
    blocks: number;
    efficiency: number;
    revenue: number;
    uptime: number;
    uptimePercentage: number;
  };
  algorithms: Array<{
    name: string;
    symbol: string;
    hashrate: number;
    miners: number;
    shares: number;
    difficulty: number;
    lastBlock?: number;
  }>;
  miners: Array<{
    id: string;
    address: string;
    worker: string;
    hashrate: number;
    shares: {
      valid: number;
      invalid: number;
      stale: number;
    };
    revenue: number;
    lastSeen: number;
    status: 'active' | 'idle' | 'offline';
  }>;
  network: {
    p2pNodes: number;
    connections: number;
    latency: number;
    syncStatus: 'synced' | 'syncing' | 'error';
    protocol: string;
    version: string;
  };
  performance: {
    cpuUsage: number;
    memoryUsage: number;
    diskUsage: number;
    networkBandwidth: {
      in: number;
      out: number;
    };
  };
  realtimeData: {
    hashrateSeries: Array<{ time: number; value: number }>;
    sharesSeries: Array<{ time: number; valid: number; invalid: number }>;
    revenueSeries: Array<{ time: number; value: number }>;
  };
}

// === Webサーバークラス ===
export class OtedamaWebServer extends EventEmitter {
  private app: express.Application;
  private server: any;
  private io: SocketIOServer;
  private pool: OtedamaCoreSystem;
  private port: number;
  private dashboardData: DashboardData;
  private updateInterval: NodeJS.Timeout | null = null;

  constructor(pool: OtedamaCoreSystem, port: number = 8080) {
    super();
    this.pool = pool;
    this.port = port;
    this.app = express();
    this.server = createServer(this.app);
    this.io = new SocketIOServer(this.server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });

    this.dashboardData = this.initializeDashboardData();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupPoolListeners();
  }

  private initializeDashboardData(): DashboardData {
    return {
      pool: {
        hashrate: 0,
        hashrateUnit: 'GH/s',
        miners: 0,
        activeMiners: 0,
        blocks: 0,
        efficiency: 98.5,
        revenue: 0,
        uptime: Date.now(),
        uptimePercentage: 100
      },
      algorithms: [],
      miners: [],
      network: {
        p2pNodes: 0,
        connections: 0,
        latency: 12,
        syncStatus: 'synced',
        protocol: 'Stratum V2',
        version: '1.0.0'
      },
      performance: {
        cpuUsage: 0,
        memoryUsage: 0,
        diskUsage: 0,
        networkBandwidth: {
          in: 0,
          out: 0
        }
      },
      realtimeData: {
        hashrateSeries: [],
        sharesSeries: [],
        revenueSeries: []
      }
    };
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '../../public')));
    
    // ログミドルウェア
    this.app.use((req, res, next) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
      next();
    });
  }

  private setupRoutes(): void {
    // API Routes
    const apiRouter = express.Router();

    // ダッシュボードデータ
    apiRouter.get('/dashboard', (req, res) => {
      res.json(this.dashboardData);
    });

    // プール統計
    apiRouter.get('/stats', (req, res) => {
      const stats = this.pool.getStats();
      res.json({
        ...stats,
        timestamp: Date.now()
      });
    });

    // マイナー一覧
    apiRouter.get('/miners', (req, res) => {
      const miners = this.pool.getMiners();
      res.json({
        count: miners.length,
        miners: miners.map(m => ({
          ...m,
          status: this.getMinerStatus(m.lastSeen)
        }))
      });
    });

    // 特定マイナー情報
    apiRouter.get('/miners/:id', (req, res) => {
      const miner = this.pool.getMiner(req.params.id);
      if (miner) {
        res.json({
          ...miner,
          status: this.getMinerStatus(miner.lastSeen),
          performance: this.getMinerPerformance(miner.id)
        });
      } else {
        res.status(404).json({ error: 'Miner not found' });
      }
    });

    // アルゴリズム一覧
    apiRouter.get('/algorithms', (req, res) => {
      const algorithms = this.pool.getSupportedAlgorithms();
      res.json({
        supported: algorithms,
        details: algorithms.map(algo => this.getAlgorithmDetails(algo))
      });
    });

    // ネットワーク状態
    apiRouter.get('/network', (req, res) => {
      res.json(this.dashboardData.network);
    });

    // パフォーマンスメトリクス
    apiRouter.get('/performance', (req, res) => {
      res.json({
        ...this.dashboardData.performance,
        timestamp: Date.now()
      });
    });

    // リアルタイムデータ
    apiRouter.get('/realtime/:metric', (req, res) => {
      const metric = req.params.metric;
      if (metric in this.dashboardData.realtimeData) {
        res.json(this.dashboardData.realtimeData[metric as keyof typeof this.dashboardData.realtimeData]);
      } else {
        res.status(404).json({ error: 'Metric not found' });
      }
    });

    // 収益計算
    apiRouter.post('/calculate-revenue', (req, res) => {
      const { hashrate, algorithm, electricityCost } = req.body;
      const revenue = this.calculateRevenue(hashrate, algorithm, electricityCost);
      res.json(revenue);
    });

    // 接続情報
    apiRouter.get('/connection-info', (req, res) => {
      const algorithms = this.pool.getSupportedAlgorithms();
      res.json({
        stratum: {
          urls: algorithms.map(algo => ({
            algorithm: algo,
            url: this.pool.getPoolUrl(algo)
          }))
        },
        p2p: {
          url: `p2p://localhost:8333`
        },
        api: {
          rest: `http://localhost:${this.port}/api`,
          websocket: `ws://localhost:${this.port}`
        }
      });
    });

    this.app.use('/api', apiRouter);

    // デジタルダッシュボード（React）
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../../public/index.html'));
    });

    // 404ハンドラー
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
  }

  private setupWebSocket(): void {
    this.io.on('connection', (socket) => {
      console.log('Client connected:', socket.id);

      // 初期データ送信
      socket.emit('dashboard:update', this.dashboardData);

      // クライアントからのイベント
      socket.on('subscribe', (channels: string[]) => {
        channels.forEach(channel => {
          socket.join(channel);
        });
      });

      socket.on('unsubscribe', (channels: string[]) => {
        channels.forEach(channel => {
          socket.leave(channel);
        });
      });

      // マイナー固有のデータ購読
      socket.on('miner:subscribe', (minerId: string) => {
        socket.join(`miner:${minerId}`);
        const miner = this.pool.getMiner(minerId);
        if (miner) {
          socket.emit('miner:data', {
            ...miner,
            performance: this.getMinerPerformance(minerId)
          });
        }
      });

      socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
      });
    });
  }

  private setupPoolListeners(): void {
    // プールイベントのリスニング
    this.pool.on('minerConnected', (miner) => {
      this.updateDashboardData();
      this.io.emit('miner:connected', miner);
      this.emitNotification('success', `New miner connected: ${miner.address}`);
    });

    this.pool.on('shareProcessed', (share) => {
      this.updateShareData(share);
      this.io.to(`miner:${share.minerId}`).emit('share:processed', share);
    });

    this.pool.on('blockFound', (block) => {
      this.updateDashboardData();
      this.io.emit('block:found', block);
      this.emitNotification('info', `🎉 Block found! Height: ${block.blockHeight}`);
    });

    this.pool.on('statsUpdated', (stats) => {
      this.updatePoolStats(stats);
    });
  }

  private updateDashboardData(): void {
    const stats = this.pool.getStats();
    const miners = this.pool.getMiners();

    // プール統計更新
    this.dashboardData.pool = {
      hashrate: stats.hashrate.total / 1e9, // Convert to GH/s
      hashrateUnit: 'GH/s',
      miners: stats.miners.total,
      activeMiners: stats.miners.active,
      blocks: stats.shares.blocks,
      efficiency: this.calculateEfficiency(),
      revenue: stats.revenue.total,
      uptime: Date.now() - stats.uptime,
      uptimePercentage: 99.9
    };

    // アルゴリズム統計更新
    this.dashboardData.algorithms = this.pool.getSupportedAlgorithms().map(algo => ({
      name: algo,
      symbol: algo.toLowerCase(),
      hashrate: (stats.hashrate.byAlgorithm[algo] || 0) / 1e9,
      miners: stats.miners.byAlgorithm[algo] || 0,
      shares: 0,
      difficulty: 100000,
      lastBlock: Date.now() - Math.random() * 3600000
    }));

    // マイナー情報更新
    this.dashboardData.miners = miners
      .sort((a, b) => b.hashrate - a.hashrate)
      .slice(0, 100)
      .map(miner => ({
        ...miner,
        revenue: this.calculateMinerRevenue(miner),
        status: this.getMinerStatus(miner.lastSeen)
      }));

    // ネットワーク状態更新
    this.dashboardData.network.p2pNodes = stats.network.p2pNodes;
    this.dashboardData.network.connections = stats.network.stratumConnections;

    // パフォーマンスメトリクス更新
    this.updatePerformanceMetrics();

    // リアルタイムデータ更新
    this.updateRealtimeData();

    // WebSocketで配信
    this.io.emit('dashboard:update', this.dashboardData);
  }

  private updateShareData(share: any): void {
    const time = Date.now();
    const series = this.dashboardData.realtimeData.sharesSeries;
    
    // 最新のエントリを更新または追加
    if (series.length > 0 && time - series[series.length - 1].time < 60000) {
      if (share.valid) {
        series[series.length - 1].valid++;
      } else {
        series[series.length - 1].invalid++;
      }
    } else {
      series.push({
        time,
        valid: share.valid ? 1 : 0,
        invalid: share.valid ? 0 : 1
      });
    }

    // 古いデータを削除（1時間以上前）
    const cutoff = time - 3600000;
    while (series.length > 0 && series[0].time < cutoff) {
      series.shift();
    }
  }

  private updatePoolStats(stats: any): void {
    // ハッシュレート履歴更新
    const time = Date.now();
    this.dashboardData.realtimeData.hashrateSeries.push({
      time,
      value: stats.hashrate.total / 1e9
    });

    // 収益履歴更新
    this.dashboardData.realtimeData.revenueSeries.push({
      time,
      value: stats.revenue.total
    });

    // 古いデータを削除
    const cutoff = time - 3600000;
    ['hashrateSeries', 'revenueSeries'].forEach(key => {
      const series = this.dashboardData.realtimeData[key as keyof typeof this.dashboardData.realtimeData];
      while (series.length > 0 && series[0].time < cutoff) {
        series.shift();
      }
    });
  }

  private updatePerformanceMetrics(): void {
    const usage = process.cpuUsage();
    const mem = process.memoryUsage();
    
    this.dashboardData.performance = {
      cpuUsage: (usage.user + usage.system) / 1000000, // マイクロ秒をパーセンテージに
      memoryUsage: (mem.heapUsed / mem.heapTotal) * 100,
      diskUsage: 45, // ダミー値
      networkBandwidth: {
        in: Math.random() * 100,
        out: Math.random() * 50
      }
    };
  }

  private updateRealtimeData(): void {
    const now = Date.now();
    
    // ハッシュレートの変動をシミュレート
    const hashrate = this.dashboardData.pool.hashrate + (Math.random() - 0.5) * 10;
    this.dashboardData.realtimeData.hashrateSeries.push({
      time: now,
      value: Math.max(0, hashrate)
    });

    // データポイントを最大100個に制限
    if (this.dashboardData.realtimeData.hashrateSeries.length > 100) {
      this.dashboardData.realtimeData.hashrateSeries.shift();
    }
  }

  private getMinerStatus(lastSeen: number): 'active' | 'idle' | 'offline' {
    const now = Date.now();
    const diff = now - lastSeen;
    
    if (diff < 60000) return 'active';      // 1分以内
    if (diff < 300000) return 'idle';       // 5分以内
    return 'offline';
  }

  private getMinerPerformance(minerId: string): any {
    // マイナーのパフォーマンスメトリクス
    return {
      hashrate24h: Math.random() * 200,
      sharesPerHour: Math.floor(Math.random() * 1000),
      efficiency: 95 + Math.random() * 5,
      uptime: 98 + Math.random() * 2
    };
  }

  private getAlgorithmDetails(algorithm: string): any {
    const details: { [key: string]: any } = {
      randomx: {
        name: 'RandomX',
        coins: ['XMR', 'WOWNERO'],
        hardware: 'CPU',
        memoryRequired: 2048,
        powerUsage: 65
      },
      kawpow: {
        name: 'KawPow',
        coins: ['RVN'],
        hardware: 'GPU',
        memoryRequired: 4096,
        powerUsage: 220
      },
      autolykos2: {
        name: 'Autolykos v2',
        coins: ['ERG'],
        hardware: 'GPU',
        memoryRequired: 4096,
        powerUsage: 180
      },
      kheavyhash: {
        name: 'kHeavyHash',
        coins: ['KAS'],
        hardware: 'ASIC/GPU',
        memoryRequired: 512,
        powerUsage: 160
      }
    };

    return details[algorithm] || {};
  }

  private calculateEfficiency(): number {
    // プール効率計算
    const stats = this.pool.getStats();
    if (stats.shares.valid + stats.shares.invalid === 0) return 100;
    
    return (stats.shares.valid / (stats.shares.valid + stats.shares.invalid)) * 100;
  }

  private calculateMinerRevenue(miner: any): number {
    // マイナー収益計算（簡略化）
    const dailyBlocks = 144; // Bitcoin例
    const blockReward = 6.25;
    const poolHashrate = this.dashboardData.pool.hashrate;
    const minerHashrate = miner.hashrate / 1e9;
    
    if (poolHashrate === 0) return 0;
    
    const minerShare = minerHashrate / poolHashrate;
    return dailyBlocks * blockReward * minerShare * 50000; // BTCをUSDに換算（仮）
  }

  private calculateRevenue(hashrate: number, algorithm: string, electricityCost: number): any {
    // 収益計算ロジック
    const coinPrices: { [key: string]: number } = {
      BTC: 50000,
      XMR: 150,
      RVN: 0.03,
      ERG: 1.5,
      KAS: 0.15
    };

    const rewards: { [key: string]: number } = {
      randomx: 0.6,      // XMR per block
      kawpow: 2500,      // RVN per block
      autolykos2: 3.125, // ERG per block
      kheavyhash: 100    // KAS per block
    };

    const powerUsage: { [key: string]: number } = {
      randomx: 65,
      kawpow: 220,
      autolykos2: 180,
      kheavyhash: 160
    };

    const dailyReward = (hashrate / 1e9) * rewards[algorithm] || 0;
    const coin = algorithm === 'randomx' ? 'XMR' : 
                 algorithm === 'kawpow' ? 'RVN' :
                 algorithm === 'autolykos2' ? 'ERG' : 'KAS';
    
    const revenue = dailyReward * (coinPrices[coin] || 0);
    const powerCost = (powerUsage[algorithm] || 0) * 24 * electricityCost / 1000;
    
    return {
      daily: {
        gross: revenue,
        powerCost,
        net: revenue - powerCost
      },
      monthly: {
        gross: revenue * 30,
        powerCost: powerCost * 30,
        net: (revenue - powerCost) * 30
      },
      coin,
      amount: dailyReward
    };
  }

  private emitNotification(type: 'success' | 'info' | 'warning' | 'error', message: string): void {
    this.io.emit('notification', {
      type,
      message,
      timestamp: Date.now()
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`🌐 Web server listening on http://localhost:${this.port}`);
        console.log(`📡 WebSocket server ready`);
        console.log(`🎨 Digital dashboard available at http://localhost:${this.port}`);
        
        // 定期更新開始
        this.updateInterval = setInterval(() => {
          this.updateDashboardData();
        }, 5000); // 5秒ごと
        
        this.emit('started');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    this.io.close();
    
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('Web server stopped');
        this.emit('stopped');
        resolve();
      });
    });
  }
}

// === エクスポート ===
export default OtedamaWebServer;

// === 使用例 ===
export async function startWebServer(pool: OtedamaCoreSystem, port?: number): Promise<OtedamaWebServer> {
  const server = new OtedamaWebServer(pool, port);
  await server.start();
  return server;
}