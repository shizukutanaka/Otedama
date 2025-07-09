/**
 * Prometheus Integration
 * メトリクス収集とPrometheus形式でのエクスポート
 * 
 * 設計思想：
 * - Carmack: 低オーバーヘッドでのメトリクス収集
 * - Martin: 構造化されたメトリクス設計
 * - Pike: シンプルで標準的なPrometheus形式
 */

import { Registry, Counter, Gauge, Histogram, Summary, collectDefaultMetrics } from 'prom-client';
import express, { Router } from 'express';
import { EventEmitter } from 'events';
import { logger } from '../logging/logger';

// === 型定義 ===
export interface MetricConfig {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
  labelNames?: string[];
  buckets?: number[];  // for histogram
  percentiles?: number[];  // for summary
  maxAgeSeconds?: number;  // for summary
  ageBuckets?: number;  // for summary
}

export interface MetricValue {
  value: number;
  labels?: Record<string, string>;
}

export interface PrometheusConfig {
  prefix?: string;
  defaultLabels?: Record<string, string>;
  collectDefaultMetrics?: boolean;
  defaultMetricsInterval?: number;
  customMetrics?: MetricConfig[];
  aggregators?: MetricAggregator[];
}

export interface MetricAggregator {
  name: string;
  interval: number;
  aggregate: () => Promise<MetricValue[]>;
}

// === Prometheus Manager ===
export class PrometheusManager extends EventEmitter {
  private registry: Registry;
  private metrics: Map<string, Counter | Gauge | Histogram | Summary> = new Map();
  private router: Router;
  private aggregatorTimers: Map<string, NodeJS.Timer> = new Map();
  
  constructor(private config: PrometheusConfig) {
    super();
    
    // レジストリの初期化
    this.registry = new Registry();
    
    // デフォルトラベルの設定
    if (config.defaultLabels) {
      this.registry.setDefaultLabels(config.defaultLabels);
    }
    
    // デフォルトメトリクスの収集
    if (config.collectDefaultMetrics !== false) {
      collectDefaultMetrics({
        register: this.registry,
        prefix: config.prefix,
        gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
        eventLoopMonitoringPrecision: 10
      });
    }
    
    // カスタムメトリクスの登録
    if (config.customMetrics) {
      for (const metricConfig of config.customMetrics) {
        this.registerMetric(metricConfig);
      }
    }
    
    // ルーターの設定
    this.router = express.Router();
    this.setupRoutes();
    
    // プールメトリクスの登録
    this.registerPoolMetrics();
  }
  
  // メトリクスの登録
  registerMetric(config: MetricConfig): void {
    const fullName = this.config.prefix ? `${this.config.prefix}_${config.name}` : config.name;
    
    let metric: Counter | Gauge | Histogram | Summary;
    
    switch (config.type) {
      case 'counter':
        metric = new Counter({
          name: fullName,
          help: config.help,
          labelNames: config.labelNames || [],
          registers: [this.registry]
        });
        break;
        
      case 'gauge':
        metric = new Gauge({
          name: fullName,
          help: config.help,
          labelNames: config.labelNames || [],
          registers: [this.registry]
        });
        break;
        
      case 'histogram':
        metric = new Histogram({
          name: fullName,
          help: config.help,
          labelNames: config.labelNames || [],
          buckets: config.buckets || [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
          registers: [this.registry]
        });
        break;
        
      case 'summary':
        metric = new Summary({
          name: fullName,
          help: config.help,
          labelNames: config.labelNames || [],
          percentiles: config.percentiles || [0.01, 0.05, 0.5, 0.9, 0.95, 0.99, 0.999],
          maxAgeSeconds: config.maxAgeSeconds || 600,
          ageBuckets: config.ageBuckets || 5,
          registers: [this.registry]
        });
        break;
    }
    
    this.metrics.set(config.name, metric);
    logger.debug(`Metric registered: ${fullName}`);
  }
  
  // プール専用メトリクスの登録
  private registerPoolMetrics(): void {
    // ハッシュレート
    this.registerMetric({
      name: 'pool_hashrate_total',
      help: 'Total pool hashrate in hashes per second',
      type: 'gauge'
    });
    
    this.registerMetric({
      name: 'miner_hashrate',
      help: 'Individual miner hashrate',
      type: 'gauge',
      labelNames: ['miner_address', 'worker_name']
    });
    
    // 接続数
    this.registerMetric({
      name: 'pool_connections_active',
      help: 'Number of active stratum connections',
      type: 'gauge'
    });
    
    this.registerMetric({
      name: 'pool_connections_total',
      help: 'Total number of connections',
      type: 'counter',
      labelNames: ['status']
    });
    
    // シェア
    this.registerMetric({
      name: 'pool_shares_total',
      help: 'Total number of shares',
      type: 'counter',
      labelNames: ['status', 'miner_address']
    });
    
    this.registerMetric({
      name: 'pool_share_difficulty',
      help: 'Share difficulty histogram',
      type: 'histogram',
      buckets: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384]
    });
    
    // ブロック
    this.registerMetric({
      name: 'pool_blocks_found_total',
      help: 'Total number of blocks found',
      type: 'counter',
      labelNames: ['coin', 'network']
    });
    
    this.registerMetric({
      name: 'pool_blocks_orphaned_total',
      help: 'Total number of orphaned blocks',
      type: 'counter',
      labelNames: ['coin', 'network']
    });
    
    // 支払い
    this.registerMetric({
      name: 'pool_payments_total',
      help: 'Total number of payments',
      type: 'counter',
      labelNames: ['status', 'coin']
    });
    
    this.registerMetric({
      name: 'pool_payments_amount_total',
      help: 'Total amount paid out',
      type: 'counter',
      labelNames: ['coin']
    });
    
    this.registerMetric({
      name: 'pool_balance_pending',
      help: 'Pending balance to be paid',
      type: 'gauge',
      labelNames: ['coin']
    });
    
    // パフォーマンス
    this.registerMetric({
      name: 'pool_stratum_request_duration_seconds',
      help: 'Stratum request processing time',
      type: 'histogram',
      labelNames: ['method'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]
    });
    
    this.registerMetric({
      name: 'pool_database_query_duration_seconds',
      help: 'Database query execution time',
      type: 'histogram',
      labelNames: ['query_type'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]
    });
    
    // エラー
    this.registerMetric({
      name: 'pool_errors_total',
      help: 'Total number of errors',
      type: 'counter',
      labelNames: ['type', 'component']
    });
    
    // Circuit Breaker
    this.registerMetric({
      name: 'circuit_breaker_state',
      help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
      type: 'gauge',
      labelNames: ['name']
    });
    
    this.registerMetric({
      name: 'circuit_breaker_failures_total',
      help: 'Total circuit breaker failures',
      type: 'counter',
      labelNames: ['name']
    });
  }
  
  // メトリクス更新メソッド
  inc(name: string, labels?: Record<string, string>, value = 1): void {
    const metric = this.metrics.get(name);
    if (metric && (metric instanceof Counter || metric instanceof Gauge)) {
      if (labels) {
        metric.labels(labels).inc(value);
      } else {
        metric.inc(value);
      }
    }
  }
  
  dec(name: string, labels?: Record<string, string>, value = 1): void {
    const metric = this.metrics.get(name);
    if (metric && metric instanceof Gauge) {
      if (labels) {
        metric.labels(labels).dec(value);
      } else {
        metric.dec(value);
      }
    }
  }
  
  set(name: string, value: number, labels?: Record<string, string>): void {
    const metric = this.metrics.get(name);
    if (metric && metric instanceof Gauge) {
      if (labels) {
        metric.labels(labels).set(value);
      } else {
        metric.set(value);
      }
    }
  }
  
  observe(name: string, value: number, labels?: Record<string, string>): void {
    const metric = this.metrics.get(name);
    if (metric && (metric instanceof Histogram || metric instanceof Summary)) {
      if (labels) {
        metric.labels(labels).observe(value);
      } else {
        metric.observe(value);
      }
    }
  }
  
  // タイマー（Histogram用）
  startTimer(name: string, labels?: Record<string, string>): () => void {
    const metric = this.metrics.get(name);
    if (metric && metric instanceof Histogram) {
      const end = labels ? metric.labels(labels).startTimer() : metric.startTimer();
      return end;
    }
    return () => {};
  }
  
  // アグリゲーター登録
  registerAggregator(aggregator: MetricAggregator): void {
    // 既存のアグリゲーターを停止
    const existingTimer = this.aggregatorTimers.get(aggregator.name);
    if (existingTimer) {
      clearInterval(existingTimer);
    }
    
    // 定期実行の設定
    const timer = setInterval(async () => {
      try {
        const values = await aggregator.aggregate();
        
        for (const { value, labels } of values) {
          const metricName = aggregator.name;
          const metric = this.metrics.get(metricName);
          
          if (metric && metric instanceof Gauge) {
            if (labels) {
              metric.labels(labels).set(value);
            } else {
              metric.set(value);
            }
          }
        }
      } catch (error) {
        logger.error(`Aggregator ${aggregator.name} failed:`, error);
        this.inc('pool_errors_total', { type: 'aggregator', component: aggregator.name });
      }
    }, aggregator.interval);
    
    this.aggregatorTimers.set(aggregator.name, timer);
    
    // 初回実行
    aggregator.aggregate().catch(error => {
      logger.error(`Initial aggregation failed for ${aggregator.name}:`, error);
    });
  }
  
  // ルート設定
  private setupRoutes(): void {
    // メトリクスエンドポイント
    this.router.get('/metrics', async (req, res) => {
      try {
        const metrics = await this.registry.metrics();
        res.set('Content-Type', this.registry.contentType);
        res.end(metrics);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    
    // 個別メトリクス取得
    this.router.get('/metrics/:name', async (req, res) => {
      const metricName = req.params.name;
      const metric = this.metrics.get(metricName);
      
      if (!metric) {
        return res.status(404).json({ error: 'Metric not found' });
      }
      
      try {
        const singleMetric = await this.registry.getSingleMetricAsString(
          this.config.prefix ? `${this.config.prefix}_${metricName}` : metricName
        );
        res.set('Content-Type', this.registry.contentType);
        res.end(singleMetric);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    
    // メトリクス一覧
    this.router.get('/metrics-list', (req, res) => {
      const metricsList = Array.from(this.metrics.keys()).map(name => {
        const metric = this.metrics.get(name)!;
        return {
          name,
          type: metric.constructor.name.toLowerCase(),
          help: (metric as any).help
        };
      });
      
      res.json(metricsList);
    });
  }
  
  // Express Router取得
  getRouter(): Router {
    return this.router;
  }
  
  // 便利なヘルパーメソッド
  recordStratumRequest(method: string, duration: number): void {
    this.observe('pool_stratum_request_duration_seconds', duration / 1000, { method });
  }
  
  recordDatabaseQuery(queryType: string, duration: number): void {
    this.observe('pool_database_query_duration_seconds', duration / 1000, { query_type: queryType });
  }
  
  recordShare(status: 'accepted' | 'rejected', minerAddress: string, difficulty: number): void {
    this.inc('pool_shares_total', { status, miner_address: minerAddress });
    this.observe('pool_share_difficulty', difficulty);
  }
  
  recordBlock(status: 'found' | 'orphaned', coin: string, network: string): void {
    if (status === 'found') {
      this.inc('pool_blocks_found_total', { coin, network });
    } else {
      this.inc('pool_blocks_orphaned_total', { coin, network });
    }
  }
  
  recordPayment(status: 'success' | 'failed', coin: string, amount?: number): void {
    this.inc('pool_payments_total', { status, coin });
    if (status === 'success' && amount) {
      this.inc('pool_payments_amount_total', { coin }, amount);
    }
  }
  
  updateCircuitBreakerState(name: string, state: 'closed' | 'open' | 'half-open'): void {
    const stateValue = state === 'closed' ? 0 : state === 'open' ? 1 : 2;
    this.set('circuit_breaker_state', stateValue, { name });
  }
  
  // クリーンアップ
  cleanup(): void {
    // アグリゲーターの停止
    for (const timer of this.aggregatorTimers.values()) {
      clearInterval(timer);
    }
    this.aggregatorTimers.clear();
    
    // メトリクスのクリア
    this.registry.clear();
  }
}

// === プリセットアグリゲーター ===
export const MetricAggregators = {
  // プールハッシュレート集計
  poolHashrate: (getHashrate: () => Promise<number>): MetricAggregator => ({
    name: 'pool_hashrate_total',
    interval: 10000, // 10秒
    aggregate: async () => {
      const hashrate = await getHashrate();
      return [{ value: hashrate }];
    }
  }),
  
  // マイナー別ハッシュレート
  minerHashrates: (getMiners: () => Promise<Array<{ address: string; worker: string; hashrate: number }>>): MetricAggregator => ({
    name: 'miner_hashrate',
    interval: 30000, // 30秒
    aggregate: async () => {
      const miners = await getMiners();
      return miners.map(miner => ({
        value: miner.hashrate,
        labels: {
          miner_address: miner.address,
          worker_name: miner.worker
        }
      }));
    }
  }),
  
  // アクティブ接続数
  activeConnections: (getConnections: () => Promise<number>): MetricAggregator => ({
    name: 'pool_connections_active',
    interval: 5000, // 5秒
    aggregate: async () => {
      const connections = await getConnections();
      return [{ value: connections }];
    }
  }),
  
  // ペンディング残高
  pendingBalance: (getBalance: (coin: string) => Promise<number>): MetricAggregator => ({
    name: 'pool_balance_pending',
    interval: 60000, // 1分
    aggregate: async () => {
      const coins = ['BTC', 'ETH', 'LTC']; // 対応コイン
      const balances = await Promise.all(
        coins.map(async coin => ({
          value: await getBalance(coin),
          labels: { coin }
        }))
      );
      return balances;
    }
  })
};

// === 使用例 ===
/*
// Prometheus Manager の初期化
const prometheus = new PrometheusManager({
  prefix: 'otedama',
  defaultLabels: {
    instance: process.env.HOSTNAME || 'localhost',
    environment: process.env.NODE_ENV || 'development'
  },
  collectDefaultMetrics: true,
  customMetrics: [
    {
      name: 'custom_metric',
      help: 'Custom application metric',
      type: 'gauge',
      labelNames: ['custom_label']
    }
  ]
});

// アグリゲーター登録
prometheus.registerAggregator(
  MetricAggregators.poolHashrate(async () => {
    // プールハッシュレート取得ロジック
    return 1234567890;
  })
);

// Express アプリケーションへの統合
app.use('/metrics', prometheus.getRouter());

// メトリクスの記録
prometheus.inc('pool_connections_total', { status: 'accepted' });
prometheus.set('pool_connections_active', 42);
prometheus.observe('pool_stratum_request_duration_seconds', 0.025, { method: 'mining.submit' });

// タイマーの使用
const end = prometheus.startTimer('pool_database_query_duration_seconds', { query_type: 'select' });
// ... データベースクエリ実行
end(); // 自動的に時間を記録

// Prometheusスクレイプ設定例
// scrape_configs:
//   - job_name: 'otedama-pool'
//     static_configs:
//       - targets: ['localhost:8080']
//     metrics_path: '/metrics'
//     scrape_interval: 15s
*/

export default PrometheusManager;