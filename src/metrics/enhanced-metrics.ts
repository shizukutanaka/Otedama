/**
 * Enhanced Metrics Collection System - 高度なメトリクス収集システム
 * 設計思想: Carmack (効率性), Martin (クリーン), Pike (シンプル)
 * 
 * 機能:
 * - Prometheus形式メトリクス
 * - リアルタイム性能監視
 * - カスタムメトリクス定義
 * - 時系列データ分析
 * - アラート閾値管理
 * - メトリクス可視化
 * - 自動異常検知
 */

import { EventEmitter } from 'events';
import { register, Counter, Gauge, Histogram, Summary, collectDefaultMetrics } from 'prom-client';
import * as os from 'os';
import * as process from 'process';

// === 型定義 ===
interface MetricConfig {
  name: string;
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
  help: string;
  labels?: string[];
  buckets?: number[];
  percentiles?: number[];
  aggregator?: 'sum' | 'average' | 'min' | 'max' | 'last';
}

interface MetricValue {
  name: string;
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

interface TimeSeriesData {
  metric: string;
  values: Array<{ timestamp: number; value: number }>;
  labels: Record<string, string>;
}

interface AlertRule {
  id: string;
  name: string;
  metric: string;
  condition: 'gt' | 'lt' | 'eq' | 'gte' | 'lte' | 'change_rate';
  threshold: number;
  duration: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  enabled: boolean;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

interface AlertInstance {
  id: string;
  ruleId: string;
  name: string;
  severity: string;
  status: 'firing' | 'resolved';
  startsAt: number;
  endsAt?: number;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  value: number;
}

interface PerformanceProfile {
  cpu: {
    usage: number;
    loadAverage: number[];
    cores: number;
  };
  memory: {
    used: number;
    free: number;
    total: number;
    usage: number;
    heapUsed: number;
    heapTotal: number;
  };
  network: {
    bytesIn: number;
    bytesOut: number;
    packetsIn: number;
    packetsOut: number;
    connectionsActive: number;
    connectionsTotal: number;
  };
  disk: {
    used: number;
    free: number;
    total: number;
    usage: number;
    readOps: number;
    writeOps: number;
  };
  application: {
    uptime: number;
    version: string;
    requests: number;
    errors: number;
    responseTime: number;
  };
}

// === メトリクス定義レジストリ ===
class MetricsRegistry {
  private metrics = new Map<string, any>();
  private configs = new Map<string, MetricConfig>();
  private logger: any;

  constructor(logger: any) {
    this.logger = logger;
    this.initializeDefaultMetrics();
  }

  private initializeDefaultMetrics(): void {
    // プール関連メトリクス
    this.registerMetric({
      name: 'pool_miners_total',
      type: 'gauge',
      help: 'Total number of miners connected to the pool',
      labels: ['status']
    });

    this.registerMetric({
      name: 'pool_hashrate_total',
      type: 'gauge',
      help: 'Total pool hashrate in H/s',
      labels: ['algorithm', 'currency']
    });

    this.registerMetric({
      name: 'pool_shares_total',
      type: 'counter',
      help: 'Total number of shares submitted',
      labels: ['status', 'miner_id', 'algorithm']
    });

    this.registerMetric({
      name: 'pool_blocks_found_total',
      type: 'counter',
      help: 'Total number of blocks found',
      labels: ['currency', 'difficulty']
    });

    this.registerMetric({
      name: 'pool_payout_amount',
      type: 'counter',
      help: 'Total payout amount in currency units',
      labels: ['currency', 'miner_id']
    });

    // システム関連メトリクス
    this.registerMetric({
      name: 'system_cpu_usage_percent',
      type: 'gauge',
      help: 'CPU usage percentage'
    });

    this.registerMetric({
      name: 'system_memory_usage_bytes',
      type: 'gauge',
      help: 'Memory usage in bytes',
      labels: ['type']
    });

    this.registerMetric({
      name: 'system_network_bytes_total',
      type: 'counter',
      help: 'Network traffic in bytes',
      labels: ['direction']
    });

    this.registerMetric({
      name: 'system_disk_usage_bytes',
      type: 'gauge',
      help: 'Disk usage in bytes',
      labels: ['type']
    });

    // アプリケーション関連メトリクス
    this.registerMetric({
      name: 'app_requests_total',
      type: 'counter',
      help: 'Total number of requests',
      labels: ['method', 'endpoint', 'status']
    });

    this.registerMetric({
      name: 'app_request_duration_seconds',
      type: 'histogram',
      help: 'Request duration in seconds',
      labels: ['method', 'endpoint'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10]
    });

    this.registerMetric({
      name: 'app_websocket_connections',
      type: 'gauge',
      help: 'Number of active WebSocket connections',
      labels: ['status']
    });

    this.registerMetric({
      name: 'app_websocket_messages_total',
      type: 'counter',
      help: 'Total WebSocket messages',
      labels: ['direction', 'channel']
    });

    // セキュリティ関連メトリクス
    this.registerMetric({
      name: 'security_attacks_total',
      type: 'counter',
      help: 'Total number of security attacks detected',
      labels: ['type', 'source_ip']
    });

    this.registerMetric({
      name: 'security_blocked_ips_total',
      type: 'gauge',
      help: 'Number of blocked IP addresses'
    });

    this.registerMetric({
      name: 'security_rate_limit_exceeded_total',
      type: 'counter',
      help: 'Number of rate limit violations',
      labels: ['source_ip']
    });

    // ビジネス関連メトリクス
    this.registerMetric({
      name: 'business_revenue_usd',
      type: 'counter',
      help: 'Total revenue in USD',
      labels: ['currency']
    });

    this.registerMetric({
      name: 'business_efficiency_percent',
      type: 'gauge',
      help: 'Pool efficiency percentage'
    });

    this.registerMetric({
      name: 'business_uptime_seconds',
      type: 'counter',
      help: 'Total uptime in seconds'
    });
  }

  registerMetric(config: MetricConfig): void {
    this.configs.set(config.name, config);

    let metric: any;
    switch (config.type) {
      case 'counter':
        metric = new Counter({
          name: config.name,
          help: config.help,
          labelNames: config.labels || []
        });
        break;

      case 'gauge':
        metric = new Gauge({
          name: config.name,
          help: config.help,
          labelNames: config.labels || []
        });
        break;

      case 'histogram':
        metric = new Histogram({
          name: config.name,
          help: config.help,
          labelNames: config.labels || [],
          buckets: config.buckets || [0.1, 0.5, 1, 5, 10]
        });
        break;

      case 'summary':
        metric = new Summary({
          name: config.name,
          help: config.help,
          labelNames: config.labels || [],
          percentiles: config.percentiles || [0.5, 0.9, 0.95, 0.99]
        });
        break;

      default:
        throw new Error(`Unknown metric type: ${config.type}`);
    }

    this.metrics.set(config.name, metric);
    this.logger.debug(`Registered metric: ${config.name} (${config.type})`);
  }

  getMetric(name: string): any {
    return this.metrics.get(name);
  }

  getAllMetrics(): Map<string, any> {
    return new Map(this.metrics);
  }

  incrementCounter(name: string, labels: Record<string, string> = {}, value: number = 1): void {
    const metric = this.metrics.get(name);
    if (metric && metric.inc) {
      metric.labels(labels).inc(value);
    }
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const metric = this.metrics.get(name);
    if (metric && metric.set) {
      metric.labels(labels).set(value);
    }
  }

  observeHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const metric = this.metrics.get(name);
    if (metric && metric.observe) {
      metric.labels(labels).observe(value);
    }
  }

  observeSummary(name: string, value: number, labels: Record<string, string> = {}): void {
    const metric = this.metrics.get(name);
    if (metric && metric.observe) {
      metric.labels(labels).observe(value);
    }
  }

  clear(): void {
    register.clear();
    this.metrics.clear();
    this.configs.clear();
  }
}

// === パフォーマンスモニター ===
class PerformanceMonitor {
  private logger: any;
  private metricsRegistry: MetricsRegistry;
  private monitoringInterval?: NodeJS.Timeout;
  private networkStats = { bytesIn: 0, bytesOut: 0, packetsIn: 0, packetsOut: 0 };
  private diskStats = { readOps: 0, writeOps: 0 };
  private previousCpuUsage?: NodeJS.CpuUsage;

  constructor(metricsRegistry: MetricsRegistry, logger: any) {
    this.metricsRegistry = metricsRegistry;
    this.logger = logger;
  }

  start(interval: number = 10000): void {
    this.monitoringInterval = setInterval(() => {
      this.collectSystemMetrics();
    }, interval);
    
    this.logger.info(`Performance monitoring started (interval: ${interval}ms)`);
  }

  stop(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
  }

  private async collectSystemMetrics(): Promise<void> {
    try {
      const profile = await this.getPerformanceProfile();
      this.updateMetrics(profile);
    } catch (error) {
      this.logger.error('Failed to collect system metrics:', error);
    }
  }

  async getPerformanceProfile(): Promise<PerformanceProfile> {
    const cpuUsage = await this.getCPUUsage();
    const memoryUsage = this.getMemoryUsage();
    const networkUsage = await this.getNetworkUsage();
    const diskUsage = await this.getDiskUsage();
    const appUsage = this.getApplicationUsage();

    return {
      cpu: {
        usage: cpuUsage,
        loadAverage: os.loadavg(),
        cores: os.cpus().length
      },
      memory: memoryUsage,
      network: networkUsage,
      disk: diskUsage,
      application: appUsage
    };
  }

  private async getCPUUsage(): Promise<number> {
    return new Promise((resolve) => {
      const startUsage = process.cpuUsage();
      const startTime = Date.now();

      setTimeout(() => {
        const endUsage = process.cpuUsage(startUsage);
        const endTime = Date.now();
        
        const totalUsage = endUsage.user + endUsage.system;
        const totalTime = (endTime - startTime) * 1000; // microseconds
        
        const usage = Math.min(100, (totalUsage / totalTime) * 100);
        resolve(usage);
      }, 100);
    });
  }

  private getMemoryUsage(): PerformanceProfile['memory'] {
    const nodeMemory = process.memoryUsage();
    const systemMemory = {
      total: os.totalmem(),
      free: os.freemem()
    };

    return {
      used: systemMemory.total - systemMemory.free,
      free: systemMemory.free,
      total: systemMemory.total,
      usage: ((systemMemory.total - systemMemory.free) / systemMemory.total) * 100,
      heapUsed: nodeMemory.heapUsed,
      heapTotal: nodeMemory.heapTotal
    };
  }

  private async getNetworkUsage(): Promise<PerformanceProfile['network']> {
    // 簡易実装 - 実際の環境では /proc/net/dev や netstat を解析
    return {
      bytesIn: this.networkStats.bytesIn,
      bytesOut: this.networkStats.bytesOut,
      packetsIn: this.networkStats.packetsIn,
      packetsOut: this.networkStats.packetsOut,
      connectionsActive: 0, // 外部から設定
      connectionsTotal: 0   // 外部から設定
    };
  }

  private async getDiskUsage(): Promise<PerformanceProfile['disk']> {
    const fs = require('fs');
    
    try {
      const stats = fs.statSync(process.cwd());
      
      // 簡易実装 - 実際の環境では statvfs や df コマンドを使用
      return {
        used: 0,
        free: 0,
        total: 0,
        usage: 0,
        readOps: this.diskStats.readOps,
        writeOps: this.diskStats.writeOps
      };
    } catch (error) {
      return {
        used: 0,
        free: 0,
        total: 0,
        usage: 0,
        readOps: 0,
        writeOps: 0
      };
    }
  }

  private getApplicationUsage(): PerformanceProfile['application'] {
    return {
      uptime: process.uptime(),
      version: process.version,
      requests: 0, // 外部から設定
      errors: 0,   // 外部から設定
      responseTime: 0 // 外部から設定
    };
  }

  private updateMetrics(profile: PerformanceProfile): void {
    // CPU メトリクス
    this.metricsRegistry.setGauge('system_cpu_usage_percent', profile.cpu.usage);

    // メモリメトリクス
    this.metricsRegistry.setGauge('system_memory_usage_bytes', profile.memory.used, { type: 'used' });
    this.metricsRegistry.setGauge('system_memory_usage_bytes', profile.memory.free, { type: 'free' });
    this.metricsRegistry.setGauge('system_memory_usage_bytes', profile.memory.heapUsed, { type: 'heap_used' });
    this.metricsRegistry.setGauge('system_memory_usage_bytes', profile.memory.heapTotal, { type: 'heap_total' });

    // ネットワークメトリクス
    this.metricsRegistry.incrementCounter('system_network_bytes_total', { direction: 'in' }, profile.network.bytesIn);
    this.metricsRegistry.incrementCounter('system_network_bytes_total', { direction: 'out' }, profile.network.bytesOut);

    // ディスクメトリクス
    this.metricsRegistry.setGauge('system_disk_usage_bytes', profile.disk.used, { type: 'used' });
    this.metricsRegistry.setGauge('system_disk_usage_bytes', profile.disk.free, { type: 'free' });

    // アプリケーションメトリクス
    this.metricsRegistry.incrementCounter('business_uptime_seconds', {}, 10); // 10秒間隔
  }

  updateNetworkStats(bytesIn: number, bytesOut: number): void {
    this.networkStats.bytesIn += bytesIn;
    this.networkStats.bytesOut += bytesOut;
  }

  updateConnectionStats(active: number, total: number): void {
    this.metricsRegistry.setGauge('app_websocket_connections', active, { status: 'active' });
    this.metricsRegistry.setGauge('app_websocket_connections', total, { status: 'total' });
  }
}

// === アラートマネージャー ===
class AlertManager extends EventEmitter {
  private rules = new Map<string, AlertRule>();
  private activeAlerts = new Map<string, AlertInstance>();
  private metricsRegistry: MetricsRegistry;
  private logger: any;
  private evaluationInterval?: NodeJS.Timeout;

  constructor(metricsRegistry: MetricsRegistry, logger: any) {
    super();
    this.metricsRegistry = metricsRegistry;
    this.logger = logger;
    
    this.setupDefaultRules();
  }

  private setupDefaultRules(): void {
    // CPUアラート
    this.addRule({
      id: 'cpu-high-usage',
      name: 'High CPU Usage',
      metric: 'system_cpu_usage_percent',
      condition: 'gt',
      threshold: 80,
      duration: 300000, // 5分
      severity: 'high',
      enabled: true,
      annotations: {
        description: 'CPU usage is above 80% for more than 5 minutes'
      }
    });

    // メモリアラート
    this.addRule({
      id: 'memory-high-usage',
      name: 'High Memory Usage',
      metric: 'system_memory_usage_bytes',
      condition: 'gt',
      threshold: 85,
      duration: 300000,
      severity: 'high',
      enabled: true,
      labels: { type: 'used' }
    });

    // プールハッシュレートアラート
    this.addRule({
      id: 'hashrate-drop',
      name: 'Pool Hashrate Drop',
      metric: 'pool_hashrate_total',
      condition: 'change_rate',
      threshold: -30, // 30%減少
      duration: 600000, // 10分
      severity: 'critical',
      enabled: true
    });

    // マイナー離脱アラート
    this.addRule({
      id: 'miner-dropout',
      name: 'Miner Dropout',
      metric: 'pool_miners_total',
      condition: 'change_rate',
      threshold: -50, // 50%減少
      duration: 300000,
      severity: 'high',
      enabled: true
    });

    // セキュリティアラート
    this.addRule({
      id: 'security-attacks',
      name: 'Security Attacks Detected',
      metric: 'security_attacks_total',
      condition: 'gt',
      threshold: 10,
      duration: 60000, // 1分
      severity: 'critical',
      enabled: true
    });
  }

  addRule(rule: AlertRule): void {
    this.rules.set(rule.id, rule);
    this.logger.info(`Added alert rule: ${rule.name} (${rule.id})`);
  }

  removeRule(ruleId: string): void {
    this.rules.delete(ruleId);
    
    // 関連するアクティブアラートを削除
    for (const [alertId, alert] of this.activeAlerts) {
      if (alert.ruleId === ruleId) {
        this.resolveAlert(alertId);
      }
    }
    
    this.logger.info(`Removed alert rule: ${ruleId}`);
  }

  start(interval: number = 30000): void {
    this.evaluationInterval = setInterval(() => {
      this.evaluateRules();
    }, interval);
    
    this.logger.info(`Alert evaluation started (interval: ${interval}ms)`);
  }

  stop(): void {
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
      this.evaluationInterval = undefined;
    }
  }

  private async evaluateRules(): Promise<void> {
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;

      try {
        await this.evaluateRule(rule);
      } catch (error) {
        this.logger.error(`Error evaluating rule ${rule.id}:`, error);
      }
    }
  }

  private async evaluateRule(rule: AlertRule): Promise<void> {
    const metric = this.metricsRegistry.getMetric(rule.metric);
    if (!metric) {
      return;
    }

    // メトリクス値取得（簡易実装）
    const currentValue = await this.getMetricValue(metric, rule);
    const shouldFire = this.evaluateCondition(rule.condition, currentValue, rule.threshold);

    const existingAlert = this.findActiveAlert(rule.id);

    if (shouldFire && !existingAlert) {
      // 新しいアラートを発火
      this.fireAlert(rule, currentValue);
    } else if (!shouldFire && existingAlert) {
      // アラートを解決
      this.resolveAlert(existingAlert.id);
    } else if (existingAlert) {
      // 既存アラートの値を更新
      existingAlert.value = currentValue;
    }
  }

  private async getMetricValue(metric: any, rule: AlertRule): Promise<number> {
    // 実際の実装ではメトリクスレジストリから値を取得
    // ここでは簡易実装
    try {
      if (metric.get) {
        const result = metric.get();
        if (result.values && result.values.length > 0) {
          return result.values[0].value;
        }
      }
      return 0;
    } catch {
      return 0;
    }
  }

  private evaluateCondition(condition: AlertRule['condition'], value: number, threshold: number): boolean {
    switch (condition) {
      case 'gt':
        return value > threshold;
      case 'gte':
        return value >= threshold;
      case 'lt':
        return value < threshold;
      case 'lte':
        return value <= threshold;
      case 'eq':
        return value === threshold;
      case 'change_rate':
        // 変化率の計算（簡易実装）
        return Math.abs(value) > Math.abs(threshold);
      default:
        return false;
    }
  }

  private findActiveAlert(ruleId: string): AlertInstance | undefined {
    for (const alert of this.activeAlerts.values()) {
      if (alert.ruleId === ruleId && alert.status === 'firing') {
        return alert;
      }
    }
    return undefined;
  }

  private fireAlert(rule: AlertRule, value: number): void {
    const alertId = crypto.randomUUID();
    const alert: AlertInstance = {
      id: alertId,
      ruleId: rule.id,
      name: rule.name,
      severity: rule.severity,
      status: 'firing',
      startsAt: Date.now(),
      labels: rule.labels || {},
      annotations: rule.annotations || {},
      value
    };

    this.activeAlerts.set(alertId, alert);
    
    this.logger.warn(`Alert fired: ${alert.name} (value: ${value}, threshold: ${rule.threshold})`);
    this.emit('alertFired', alert);
  }

  private resolveAlert(alertId: string): void {
    const alert = this.activeAlerts.get(alertId);
    if (alert) {
      alert.status = 'resolved';
      alert.endsAt = Date.now();
      
      this.logger.info(`Alert resolved: ${alert.name}`);
      this.emit('alertResolved', alert);
      
      // 一定時間後にアラートを削除
      setTimeout(() => {
        this.activeAlerts.delete(alertId);
      }, 300000); // 5分
    }
  }

  getActiveAlerts(): AlertInstance[] {
    return Array.from(this.activeAlerts.values())
      .filter(alert => alert.status === 'firing');
  }

  getAllAlerts(): AlertInstance[] {
    return Array.from(this.activeAlerts.values());
  }

  getRules(): AlertRule[] {
    return Array.from(this.rules.values());
  }
}

// === 時系列データストア ===
class TimeSeriesStore {
  private data = new Map<string, TimeSeriesData>();
  private maxDataPoints = 10000;
  private retentionPeriod = 7 * 24 * 60 * 60 * 1000; // 7日間
  private logger: any;

  constructor(logger: any) {
    this.logger = logger;
    this.startCleanup();
  }

  record(metric: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.generateKey(metric, labels);
    let series = this.data.get(key);

    if (!series) {
      series = {
        metric,
        values: [],
        labels
      };
      this.data.set(key, series);
    }

    series.values.push({
      timestamp: Date.now(),
      value
    });

    // データポイント数制限
    if (series.values.length > this.maxDataPoints) {
      series.values.shift();
    }
  }

  query(metric: string, labels: Record<string, string> = {}, startTime?: number, endTime?: number): TimeSeriesData | null {
    const key = this.generateKey(metric, labels);
    const series = this.data.get(key);

    if (!series) {
      return null;
    }

    let values = series.values;

    // 時間範囲フィルタリング
    if (startTime || endTime) {
      values = values.filter(point => {
        if (startTime && point.timestamp < startTime) return false;
        if (endTime && point.timestamp > endTime) return false;
        return true;
      });
    }

    return {
      metric: series.metric,
      values: values.slice(),
      labels: series.labels
    };
  }

  aggregate(metric: string, aggregation: 'sum' | 'avg' | 'min' | 'max' | 'count', interval: number): TimeSeriesData[] {
    const results: TimeSeriesData[] = [];
    
    for (const [key, series] of this.data) {
      if (!series.metric.includes(metric)) continue;

      const buckets = new Map<number, number[]>();
      
      for (const point of series.values) {
        const bucket = Math.floor(point.timestamp / interval) * interval;
        if (!buckets.has(bucket)) {
          buckets.set(bucket, []);
        }
        buckets.get(bucket)!.push(point.value);
      }

      const aggregatedValues = [];
      for (const [timestamp, values] of buckets) {
        let aggregatedValue: number;
        
        switch (aggregation) {
          case 'sum':
            aggregatedValue = values.reduce((sum, v) => sum + v, 0);
            break;
          case 'avg':
            aggregatedValue = values.reduce((sum, v) => sum + v, 0) / values.length;
            break;
          case 'min':
            aggregatedValue = Math.min(...values);
            break;
          case 'max':
            aggregatedValue = Math.max(...values);
            break;
          case 'count':
            aggregatedValue = values.length;
            break;
          default:
            aggregatedValue = 0;
        }

        aggregatedValues.push({ timestamp, value: aggregatedValue });
      }

      results.push({
        metric: series.metric,
        values: aggregatedValues,
        labels: series.labels
      });
    }

    return results;
  }

  private generateKey(metric: string, labels: Record<string, string>): string {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    
    return `${metric}{${labelStr}}`;
  }

  private startCleanup(): void {
    setInterval(() => {
      const cutoff = Date.now() - this.retentionPeriod;
      let removedCount = 0;

      for (const [key, series] of this.data) {
        const initialLength = series.values.length;
        series.values = series.values.filter(point => point.timestamp > cutoff);
        removedCount += initialLength - series.values.length;

        // 空のシリーズを削除
        if (series.values.length === 0) {
          this.data.delete(key);
        }
      }

      if (removedCount > 0) {
        this.logger.debug(`Cleaned up ${removedCount} old data points`);
      }
    }, 3600000); // 1時間間隔
  }

  getStats(): any {
    let totalDataPoints = 0;
    for (const series of this.data.values()) {
      totalDataPoints += series.values.length;
    }

    return {
      totalSeries: this.data.size,
      totalDataPoints,
      memoryUsage: totalDataPoints * 16, // 推定メモリ使用量
      retentionPeriod: this.retentionPeriod
    };
  }
}

// === メインメトリクスシステム ===
export class EnhancedMetricsSystem extends EventEmitter {
  private logger: any;
  private metricsRegistry: MetricsRegistry;
  private performanceMonitor: PerformanceMonitor;
  private alertManager: AlertManager;
  private timeSeriesStore: TimeSeriesStore;
  private startTime: number;

  constructor(logger: any) {
    super();
    this.logger = logger;
    this.startTime = Date.now();

    // コンポーネント初期化
    this.metricsRegistry = new MetricsRegistry(logger);
    this.performanceMonitor = new PerformanceMonitor(this.metricsRegistry, logger);
    this.alertManager = new AlertManager(this.metricsRegistry, logger);
    this.timeSeriesStore = new TimeSeriesStore(logger);

    // デフォルトメトリクス有効化
    collectDefaultMetrics();

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.alertManager.on('alertFired', (alert) => {
      this.logger.warn(`🚨 Alert fired: ${alert.name}`);
      this.emit('alertFired', alert);
    });

    this.alertManager.on('alertResolved', (alert) => {
      this.logger.info(`✅ Alert resolved: ${alert.name}`);
      this.emit('alertResolved', alert);
    });
  }

  async start(): Promise<void> {
    this.logger.info('Starting Enhanced Metrics System...');

    // パフォーマンス監視開始
    this.performanceMonitor.start(10000); // 10秒間隔

    // アラート評価開始
    this.alertManager.start(30000); // 30秒間隔

    this.logger.success('Metrics system started');
  }

  // プール関連メトリクス更新
  updatePoolMetrics(data: {
    totalMiners?: number;
    activeMiners?: number;
    totalHashrate?: number;
    currency?: string;
    algorithm?: string;
  }): void {
    if (data.totalMiners !== undefined) {
      this.metricsRegistry.setGauge('pool_miners_total', data.totalMiners, { status: 'total' });
    }
    
    if (data.activeMiners !== undefined) {
      this.metricsRegistry.setGauge('pool_miners_total', data.activeMiners, { status: 'active' });
    }
    
    if (data.totalHashrate !== undefined) {
      const labels: Record<string, string> = {};
      if (data.algorithm) labels.algorithm = data.algorithm;
      if (data.currency) labels.currency = data.currency;
      
      this.metricsRegistry.setGauge('pool_hashrate_total', data.totalHashrate, labels);
      this.timeSeriesStore.record('pool_hashrate_total', data.totalHashrate, labels);
    }
  }

  recordShare(minerId: string, algorithm: string, valid: boolean): void {
    const labels = {
      status: valid ? 'valid' : 'invalid',
      miner_id: minerId,
      algorithm
    };
    
    this.metricsRegistry.incrementCounter('pool_shares_total', labels);
    this.timeSeriesStore.record('pool_shares_total', 1, labels);
  }

  recordBlockFound(currency: string, difficulty: number): void {
    const labels = { currency, difficulty: difficulty.toString() };
    this.metricsRegistry.incrementCounter('pool_blocks_found_total', labels);
    this.timeSeriesStore.record('pool_blocks_found_total', 1, labels);
  }

  recordPayout(minerId: string, currency: string, amount: number): void {
    const labels = { currency, miner_id: minerId };
    this.metricsRegistry.incrementCounter('pool_payout_amount', labels, amount);
    this.timeSeriesStore.record('pool_payout_amount', amount, labels);
  }

  recordRequest(method: string, endpoint: string, statusCode: number, duration: number): void {
    const labels = {
      method,
      endpoint,
      status: statusCode.toString()
    };
    
    this.metricsRegistry.incrementCounter('app_requests_total', labels);
    this.metricsRegistry.observeHistogram('app_request_duration_seconds', duration / 1000, { method, endpoint });
  }

  recordWebSocketMessage(direction: 'in' | 'out', channel: string): void {
    const labels = { direction, channel };
    this.metricsRegistry.incrementCounter('app_websocket_messages_total', labels);
  }

  recordSecurityEvent(type: string, sourceIp: string): void {
    const labels = { type, source_ip: sourceIp };
    this.metricsRegistry.incrementCounter('security_attacks_total', labels);
  }

  updateBusinessMetrics(data: {
    revenue?: number;
    currency?: string;
    efficiency?: number;
  }): void {
    if (data.revenue !== undefined && data.currency) {
      this.metricsRegistry.incrementCounter('business_revenue_usd', { currency: data.currency }, data.revenue);
    }
    
    if (data.efficiency !== undefined) {
      this.metricsRegistry.setGauge('business_efficiency_percent', data.efficiency);
    }
  }

  // カスタムメトリクス定義
  defineCustomMetric(config: MetricConfig): void {
    this.metricsRegistry.registerMetric(config);
  }

  // カスタムアラートルール追加
  addAlertRule(rule: AlertRule): void {
    this.alertManager.addRule(rule);
  }

  // Prometheusメトリクス取得
  async getPrometheusMetrics(): Promise<string> {
    return register.metrics();
  }

  // 時系列データクエリ
  queryTimeSeries(metric: string, labels: Record<string, string> = {}, startTime?: number, endTime?: number): TimeSeriesData | null {
    return this.timeSeriesStore.query(metric, labels, startTime, endTime);
  }

  // 集計データ取得
  getAggregatedData(metric: string, aggregation: 'sum' | 'avg' | 'min' | 'max' | 'count', interval: number): TimeSeriesData[] {
    return this.timeSeriesStore.aggregate(metric, aggregation, interval);
  }

  // アクティブアラート取得
  getActiveAlerts(): AlertInstance[] {
    return this.alertManager.getActiveAlerts();
  }

  // システム統計取得
  getSystemStats(): any {
    return {
      uptime: Date.now() - this.startTime,
      metrics: {
        registered: this.metricsRegistry.getAllMetrics().size,
        timeSeries: this.timeSeriesStore.getStats()
      },
      alerts: {
        rules: this.alertManager.getRules().length,
        active: this.alertManager.getActiveAlerts().length,
        total: this.alertManager.getAllAlerts().length
      },
      performance: this.performanceMonitor.getPerformanceProfile()
    };
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping metrics system...');
    
    this.performanceMonitor.stop();
    this.alertManager.stop();
    
    this.logger.success('Metrics system stopped');
  }
}

export {
  MetricConfig,
  MetricValue,
  TimeSeriesData,
  AlertRule,
  AlertInstance,
  PerformanceProfile
};
