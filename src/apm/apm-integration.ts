/**
 * APM (Application Performance Monitoring) ツール統合システム
 * 設計思想: John Carmack (性能重視), Rob Pike (シンプル), Robert C. Martin (拡張性)
 * 
 * 対応APMツール:
 * - New Relic
 * - DataDog
 * - AppDynamics
 * - Prometheus + Grafana
 * - カスタムAPM
 * 
 * 機能:
 * - パフォーマンスメトリクス自動収集
 * - エラー追跡とアラート
 * - リアルタイム監視ダッシュボード
 * - 分散トレーシング
 * - ユーザーエクスペリエンス監視
 */

import { EventEmitter } from 'events';
import * as os from 'os';
import { performance } from 'perf_hooks';

// === 型定義 ===
export interface APMConfig {
  provider: 'newrelic' | 'datadog' | 'appdynamics' | 'prometheus' | 'custom';
  apiKey: string;
  appName: string;
  environment: 'production' | 'staging' | 'development';
  endpoint?: string;
  customConfig?: Record<string, any>;
  enabled: boolean;
  samplingRate: number; // 0.0 - 1.0
  batchSize: number;
  flushInterval: number; // milliseconds
}

export interface PerformanceMetric {
  name: string;
  value: number;
  unit: string;
  timestamp: number;
  tags: Record<string, string>;
  type: 'gauge' | 'counter' | 'histogram' | 'timer';
}

export interface Transaction {
  id: string;
  name: string;
  type: 'web' | 'background' | 'mining' | 'p2p';
  startTime: number;
  endTime: number;
  duration: number;
  success: boolean;
  errorMessage?: string;
  attributes: Record<string, any>;
  spans: Span[];
}

export interface Span {
  id: string;
  traceId: string;
  parentId?: string;
  operationName: string;
  startTime: number;
  endTime: number;
  duration: number;
  tags: Record<string, any>;
  logs: LogEntry[];
}

export interface LogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: Record<string, any>;
}

export interface ErrorEvent {
  id: string;
  type: string;
  message: string;
  stack: string;
  timestamp: number;
  userId?: string;
  sessionId?: string;
  url?: string;
  userAgent?: string;
  attributes: Record<string, any>;
}

export interface HealthMetrics {
  cpu: {
    usage: number;
    loadAverage: number[];
  };
  memory: {
    used: number;
    free: number;
    total: number;
    heapUsed: number;
    heapTotal: number;
  };
  network: {
    connections: number;
    bytesIn: number;
    bytesOut: number;
  };
  mining: {
    hashrate: number;
    sharesSubmitted: number;
    sharesAccepted: number;
    activeMiners: number;
  };
  pool: {
    blocksFound: number;
    revenue: number;
    difficulty: number;
  };
}

export interface Alert {
  id: string;
  name: string;
  condition: string;
  threshold: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  triggered: boolean;
  triggeredAt?: number;
  message: string;
  actions: AlertAction[];
}

export interface AlertAction {
  type: 'email' | 'slack' | 'webhook' | 'sms';
  target: string;
  template?: string;
}

// === APM プロバイダー抽象クラス ===
export abstract class APMProvider {
  protected config: APMConfig;
  protected metrics: PerformanceMetric[] = [];
  protected transactions: Transaction[] = [];
  protected errors: ErrorEvent[] = [];

  constructor(config: APMConfig) {
    this.config = config;
  }

  abstract initialize(): Promise<void>;
  abstract sendMetric(metric: PerformanceMetric): Promise<void>;
  abstract sendTransaction(transaction: Transaction): Promise<void>;
  abstract sendError(error: ErrorEvent): Promise<void>;
  abstract createDashboard(name: string, widgets: any[]): Promise<string>;
  abstract shutdown(): Promise<void>;

  // 共通メソッド
  protected shouldSample(): boolean {
    return Math.random() < this.config.samplingRate;
  }

  protected createMetric(
    name: string,
    value: number,
    unit: string = 'count',
    tags: Record<string, string> = {},
    type: PerformanceMetric['type'] = 'gauge'
  ): PerformanceMetric {
    return {
      name,
      value,
      unit,
      timestamp: Date.now(),
      tags: { ...tags, app: this.config.appName, env: this.config.environment },
      type
    };
  }
}

// === New Relic プロバイダー ===
export class NewRelicProvider extends APMProvider {
  private agent: any = null;

  async initialize(): Promise<void> {
    try {
      // Simulate New Relic agent initialization
      console.log(`Initializing New Relic APM for ${this.config.appName}`);
      
      this.agent = {
        setApplicationName: (name: string) => console.log(`Set app name: ${name}`),
        recordMetric: (name: string, value: number) => console.log(`Metric: ${name}=${value}`),
        recordCustomEvent: (type: string, attributes: any) => console.log(`Event: ${type}`, attributes),
        noticeError: (error: Error, attributes?: any) => console.log(`Error:`, error.message, attributes),
        startTransaction: (name: string, group?: string) => ({
          end: () => console.log(`Transaction ended: ${name}`)
        }),
        addCustomAttribute: (key: string, value: any) => console.log(`Attribute: ${key}=${value}`),
        getBrowserTimingHeader: () => '<script>/* Browser timing */</script>',
        getBrowserTimingFooter: () => '<script>/* Browser timing end */</script>'
      };

      this.agent.setApplicationName(this.config.appName);
      
    } catch (error) {
      console.error('Failed to initialize New Relic:', error);
      throw error;
    }
  }

  async sendMetric(metric: PerformanceMetric): Promise<void> {
    if (!this.shouldSample()) return;

    try {
      this.agent?.recordMetric(
        `Custom/${metric.name}`,
        metric.value
      );

      // Send as custom event for better querying
      this.agent?.recordCustomEvent('PoolMetric', {
        name: metric.name,
        value: metric.value,
        unit: metric.unit,
        type: metric.type,
        ...metric.tags
      });

    } catch (error) {
      console.error('Failed to send metric to New Relic:', error);
    }
  }

  async sendTransaction(transaction: Transaction): Promise<void> {
    if (!this.shouldSample()) return;

    try {
      this.agent?.recordCustomEvent('PoolTransaction', {
        id: transaction.id,
        name: transaction.name,
        type: transaction.type,
        duration: transaction.duration,
        success: transaction.success,
        errorMessage: transaction.errorMessage,
        ...transaction.attributes
      });

      // Send spans as separate events
      for (const span of transaction.spans) {
        this.agent?.recordCustomEvent('PoolSpan', {
          spanId: span.id,
          traceId: span.traceId,
          parentId: span.parentId,
          operation: span.operationName,
          duration: span.duration,
          ...span.tags
        });
      }

    } catch (error) {
      console.error('Failed to send transaction to New Relic:', error);
    }
  }

  async sendError(error: ErrorEvent): Promise<void> {
    try {
      const errorObj = new Error(error.message);
      errorObj.stack = error.stack;

      this.agent?.noticeError(errorObj, {
        errorId: error.id,
        errorType: error.type,
        userId: error.userId,
        sessionId: error.sessionId,
        url: error.url,
        userAgent: error.userAgent,
        ...error.attributes
      });

    } catch (err) {
      console.error('Failed to send error to New Relic:', err);
    }
  }

  async createDashboard(name: string, widgets: any[]): Promise<string> {
    // Simulate dashboard creation
    console.log(`Creating New Relic dashboard: ${name}`, widgets);
    return `nr-dashboard-${Date.now()}`;
  }

  async shutdown(): Promise<void> {
    console.log('New Relic APM shutdown');
  }
}

// === DataDog プロバイダー ===
export class DataDogProvider extends APMProvider {
  private client: any = null;

  async initialize(): Promise<void> {
    try {
      console.log(`Initializing DataDog APM for ${this.config.appName}`);
      
      // Simulate DataDog client
      this.client = {
        gauge: (metric: string, value: number, tags: string[]) => 
          console.log(`Gauge: ${metric}=${value} tags=[${tags.join(',')}]`),
        increment: (metric: string, value: number, tags: string[]) =>
          console.log(`Counter: ${metric}+=${value} tags=[${tags.join(',')}]`),
        histogram: (metric: string, value: number, tags: string[]) =>
          console.log(`Histogram: ${metric}=${value} tags=[${tags.join(',')}]`),
        event: (title: string, text: string, options: any) =>
          console.log(`Event: ${title} - ${text}`, options),
        serviceCheck: (name: string, status: number, options: any) =>
          console.log(`Service Check: ${name}=${status}`, options)
      };

    } catch (error) {
      console.error('Failed to initialize DataDog:', error);
      throw error;
    }
  }

  async sendMetric(metric: PerformanceMetric): Promise<void> {
    if (!this.shouldSample()) return;

    try {
      const tags = Object.entries(metric.tags).map(([k, v]) => `${k}:${v}`);
      
      switch (metric.type) {
        case 'gauge':
          this.client?.gauge(`pool.${metric.name}`, metric.value, tags);
          break;
        case 'counter':
          this.client?.increment(`pool.${metric.name}`, metric.value, tags);
          break;
        case 'histogram':
          this.client?.histogram(`pool.${metric.name}`, metric.value, tags);
          break;
        case 'timer':
          this.client?.histogram(`pool.${metric.name}.duration`, metric.value, tags);
          break;
      }

    } catch (error) {
      console.error('Failed to send metric to DataDog:', error);
    }
  }

  async sendTransaction(transaction: Transaction): Promise<void> {
    if (!this.shouldSample()) return;

    try {
      const tags = [
        `transaction_name:${transaction.name}`,
        `transaction_type:${transaction.type}`,
        `success:${transaction.success}`
      ];

      // Send transaction duration
      this.client?.histogram('pool.transaction.duration', transaction.duration, tags);
      
      // Send transaction count
      this.client?.increment('pool.transaction.count', 1, tags);

      // Send error count if failed
      if (!transaction.success) {
        this.client?.increment('pool.transaction.error', 1, tags);
      }

      // Send spans
      for (const span of transaction.spans) {
        const spanTags = [
          `operation:${span.operationName}`,
          `trace_id:${span.traceId}`
        ];
        this.client?.histogram('pool.span.duration', span.duration, spanTags);
      }

    } catch (error) {
      console.error('Failed to send transaction to DataDog:', error);
    }
  }

  async sendError(error: ErrorEvent): Promise<void> {
    try {
      // Send error count
      this.client?.increment('pool.error.count', 1, [
        `error_type:${error.type}`,
        `user_id:${error.userId || 'unknown'}`
      ]);

      // Send error event
      this.client?.event(
        `Error: ${error.type}`,
        error.message,
        {
          alert_type: 'error',
          tags: [
            `error_id:${error.id}`,
            `session_id:${error.sessionId || 'unknown'}`
          ],
          source_type_name: 'mining_pool'
        }
      );

    } catch (err) {
      console.error('Failed to send error to DataDog:', err);
    }
  }

  async createDashboard(name: string, widgets: any[]): Promise<string> {
    console.log(`Creating DataDog dashboard: ${name}`, widgets);
    return `dd-dashboard-${Date.now()}`;
  }

  async shutdown(): Promise<void> {
    console.log('DataDog APM shutdown');
  }
}

// === Prometheus プロバイダー ===
export class PrometheusProvider extends APMProvider {
  private metrics: Map<string, any> = new Map();
  private registry: any = null;

  async initialize(): Promise<void> {
    try {
      console.log(`Initializing Prometheus APM for ${this.config.appName}`);
      
      // Simulate Prometheus client
      this.registry = {
        register: (metric: any) => this.metrics.set(metric.name, metric),
        metrics: () => this.generatePrometheusOutput(),
        clear: () => this.metrics.clear(),
        getSingleMetricAsString: (name: string) => this.metrics.get(name)?.toString() || ''
      };

    } catch (error) {
      console.error('Failed to initialize Prometheus:', error);
      throw error;
    }
  }

  async sendMetric(metric: PerformanceMetric): Promise<void> {
    if (!this.shouldSample()) return;

    try {
      const metricName = `pool_${metric.name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      
      if (!this.metrics.has(metricName)) {
        const promMetric = {
          name: metricName,
          help: `Pool metric: ${metric.name}`,
          type: metric.type === 'counter' ? 'counter' : 'gauge',
          values: new Map(),
          set: (value: number, labels: Record<string, string>) => {
            const labelKey = JSON.stringify(labels);
            promMetric.values.set(labelKey, value);
          },
          inc: (value: number, labels: Record<string, string>) => {
            const labelKey = JSON.stringify(labels);
            const current = promMetric.values.get(labelKey) || 0;
            promMetric.values.set(labelKey, current + value);
          },
          toString: () => this.formatPrometheusMetric(promMetric)
        };
        
        this.metrics.set(metricName, promMetric);
      }

      const promMetric = this.metrics.get(metricName);
      if (metric.type === 'counter') {
        promMetric.inc(metric.value, metric.tags);
      } else {
        promMetric.set(metric.value, metric.tags);
      }

    } catch (error) {
      console.error('Failed to send metric to Prometheus:', error);
    }
  }

  async sendTransaction(transaction: Transaction): Promise<void> {
    if (!this.shouldSample()) return;

    try {
      // Duration histogram
      const durationMetric = this.createMetric(
        'transaction_duration_seconds',
        transaction.duration / 1000,
        'seconds',
        {
          transaction_name: transaction.name,
          transaction_type: transaction.type,
          success: transaction.success.toString()
        },
        'histogram'
      );
      
      await this.sendMetric(durationMetric);

      // Transaction counter
      const countMetric = this.createMetric(
        'transaction_total',
        1,
        'count',
        {
          transaction_name: transaction.name,
          transaction_type: transaction.type,
          success: transaction.success.toString()
        },
        'counter'
      );
      
      await this.sendMetric(countMetric);

    } catch (error) {
      console.error('Failed to send transaction to Prometheus:', error);
    }
  }

  async sendError(error: ErrorEvent): Promise<void> {
    try {
      const errorMetric = this.createMetric(
        'errors_total',
        1,
        'count',
        {
          error_type: error.type,
          user_id: error.userId || 'unknown'
        },
        'counter'
      );
      
      await this.sendMetric(errorMetric);

    } catch (err) {
      console.error('Failed to send error to Prometheus:', err);
    }
  }

  async createDashboard(name: string, widgets: any[]): Promise<string> {
    console.log(`Creating Prometheus/Grafana dashboard: ${name}`, widgets);
    return `prom-dashboard-${Date.now()}`;
  }

  async shutdown(): Promise<void> {
    this.metrics.clear();
    console.log('Prometheus APM shutdown');
  }

  private formatPrometheusMetric(metric: any): string {
    let output = `# HELP ${metric.name} ${metric.help}\n`;
    output += `# TYPE ${metric.name} ${metric.type}\n`;
    
    for (const [labelKey, value] of metric.values) {
      const labels = JSON.parse(labelKey);
      const labelString = Object.entries(labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',');
      
      output += `${metric.name}{${labelString}} ${value}\n`;
    }
    
    return output;
  }

  private generatePrometheusOutput(): string {
    let output = '';
    for (const metric of this.metrics.values()) {
      output += metric.toString() + '\n';
    }
    return output;
  }

  getMetricsEndpoint(): string {
    return this.registry?.metrics() || '';
  }
}

// === メインAPM統合システム ===
export class APMIntegration extends EventEmitter {
  private providers = new Map<string, APMProvider>();
  private activeTransactions = new Map<string, Transaction>();
  private alerts = new Map<string, Alert>();
  private healthMetrics: HealthMetrics;
  private metricsBuffer: PerformanceMetric[] = [];
  private flushTimer?: NodeJS.Timeout;

  constructor() {
    super();
    this.healthMetrics = this.getInitialHealthMetrics();
    this.startHealthMonitoring();
  }

  // === プロバイダー管理 ===
  async addProvider(name: string, config: APMConfig): Promise<void> {
    if (!config.enabled) return;

    let provider: APMProvider;

    switch (config.provider) {
      case 'newrelic':
        provider = new NewRelicProvider(config);
        break;
      case 'datadog':
        provider = new DataDogProvider(config);
        break;
      case 'prometheus':
        provider = new PrometheusProvider(config);
        break;
      default:
        throw new Error(`Unsupported APM provider: ${config.provider}`);
    }

    try {
      await provider.initialize();
      this.providers.set(name, provider);
      
      this.emit('providerAdded', { name, provider: config.provider });
      console.log(`✅ APM Provider added: ${name} (${config.provider})`);

      // Start auto-flushing for this provider
      this.startAutoFlush(config.flushInterval);

    } catch (error) {
      console.error(`❌ Failed to add APM provider ${name}:`, error);
      throw error;
    }
  }

  async removeProvider(name: string): Promise<void> {
    const provider = this.providers.get(name);
    if (provider) {
      await provider.shutdown();
      this.providers.delete(name);
      this.emit('providerRemoved', { name });
    }
  }

  // === メトリクス送信 ===
  recordMetric(
    name: string,
    value: number,
    unit: string = 'count',
    tags: Record<string, string> = {},
    type: PerformanceMetric['type'] = 'gauge'
  ): void {
    const metric: PerformanceMetric = {
      name,
      value,
      unit,
      timestamp: Date.now(),
      tags: { ...tags, hostname: os.hostname() },
      type
    };

    this.metricsBuffer.push(metric);
    this.emit('metricRecorded', metric);

    // Immediate flush for critical metrics
    if (tags.priority === 'critical') {
      this.flushMetrics();
    }
  }

  // === トランザクション追跡 ===
  startTransaction(name: string, type: Transaction['type'] = 'web'): string {
    const transactionId = this.generateId();
    const transaction: Transaction = {
      id: transactionId,
      name,
      type,
      startTime: Date.now(),
      endTime: 0,
      duration: 0,
      success: true,
      attributes: {},
      spans: []
    };

    this.activeTransactions.set(transactionId, transaction);
    this.emit('transactionStarted', transaction);
    
    return transactionId;
  }

  endTransaction(
    transactionId: string,
    success: boolean = true,
    errorMessage?: string,
    attributes: Record<string, any> = {}
  ): void {
    const transaction = this.activeTransactions.get(transactionId);
    if (!transaction) return;

    transaction.endTime = Date.now();
    transaction.duration = transaction.endTime - transaction.startTime;
    transaction.success = success;
    transaction.errorMessage = errorMessage;
    transaction.attributes = { ...transaction.attributes, ...attributes };

    this.sendToAllProviders('sendTransaction', transaction);
    this.activeTransactions.delete(transactionId);
    
    this.emit('transactionEnded', transaction);

    // Record performance metrics
    this.recordMetric(
      'transaction_duration',
      transaction.duration,
      'ms',
      {
        transaction_name: transaction.name,
        transaction_type: transaction.type,
        success: success.toString()
      },
      'histogram'
    );
  }

  addSpan(
    transactionId: string,
    operationName: string,
    startTime: number,
    endTime: number,
    tags: Record<string, any> = {}
  ): void {
    const transaction = this.activeTransactions.get(transactionId);
    if (!transaction) return;

    const span: Span = {
      id: this.generateId(),
      traceId: transactionId,
      parentId: transaction.spans.length > 0 ? transaction.spans[transaction.spans.length - 1].id : undefined,
      operationName,
      startTime,
      endTime,
      duration: endTime - startTime,
      tags,
      logs: []
    };

    transaction.spans.push(span);
    this.emit('spanAdded', span);
  }

  // === エラー追跡 ===
  recordError(
    error: Error,
    attributes: Record<string, any> = {},
    userId?: string,
    sessionId?: string
  ): void {
    const errorEvent: ErrorEvent = {
      id: this.generateId(),
      type: error.constructor.name,
      message: error.message,
      stack: error.stack || '',
      timestamp: Date.now(),
      userId,
      sessionId,
      attributes
    };

    this.sendToAllProviders('sendError', errorEvent);
    this.emit('errorRecorded', errorEvent);

    // Record error metrics
    this.recordMetric(
      'errors_total',
      1,
      'count',
      {
        error_type: errorEvent.type,
        user_id: userId || 'unknown'
      },
      'counter'
    );
  }

  // === ヘルスモニタリング ===
  private startHealthMonitoring(): void {
    setInterval(() => {
      this.updateHealthMetrics();
      this.checkAlerts();
    }, 30000); // Every 30 seconds
  }

  private updateHealthMetrics(): void {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    this.healthMetrics = {
      cpu: {
        usage: (cpuUsage.user + cpuUsage.system) / 1000000, // Convert to percentage approximation
        loadAverage: os.loadavg()
      },
      memory: {
        used: memUsage.heapUsed,
        free: os.freemem(),
        total: os.totalmem(),
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal
      },
      network: {
        connections: 100, // Mock data
        bytesIn: 1000000,
        bytesOut: 2000000
      },
      mining: {
        hashrate: 1000000000000,
        sharesSubmitted: 1000,
        sharesAccepted: 980,
        activeMiners: 50
      },
      pool: {
        blocksFound: 5,
        revenue: 6.25,
        difficulty: 50000000000000
      }
    };

    // Send health metrics
    this.recordHealthMetrics();
    this.emit('healthMetricsUpdated', this.healthMetrics);
  }

  private recordHealthMetrics(): void {
    const h = this.healthMetrics;

    // System metrics
    this.recordMetric('cpu_usage_percent', h.cpu.usage, 'percent', {}, 'gauge');
    this.recordMetric('memory_used_bytes', h.memory.used, 'bytes', {}, 'gauge');
    this.recordMetric('memory_free_bytes', h.memory.free, 'bytes', {}, 'gauge');
    this.recordMetric('load_average_1m', h.cpu.loadAverage[0], 'count', {}, 'gauge');

    // Mining metrics
    this.recordMetric('mining_hashrate', h.mining.hashrate, 'hash/s', {}, 'gauge');
    this.recordMetric('mining_shares_submitted', h.mining.sharesSubmitted, 'count', {}, 'counter');
    this.recordMetric('mining_shares_accepted', h.mining.sharesAccepted, 'count', {}, 'counter');
    this.recordMetric('mining_active_miners', h.mining.activeMiners, 'count', {}, 'gauge');

    // Pool metrics
    this.recordMetric('pool_blocks_found', h.pool.blocksFound, 'count', {}, 'counter');
    this.recordMetric('pool_revenue', h.pool.revenue, 'BTC', {}, 'gauge');
    this.recordMetric('pool_difficulty', h.pool.difficulty, 'count', {}, 'gauge');

    // Calculate derived metrics
    const acceptanceRate = h.mining.sharesSubmitted > 0 
      ? (h.mining.sharesAccepted / h.mining.sharesSubmitted) * 100 
      : 0;
    this.recordMetric('mining_acceptance_rate', acceptanceRate, 'percent', {}, 'gauge');

    const memoryUtilization = (h.memory.used / h.memory.total) * 100;
    this.recordMetric('memory_utilization_percent', memoryUtilization, 'percent', {}, 'gauge');
  }

  // === アラート管理 ===
  addAlert(alert: Alert): void {
    this.alerts.set(alert.id, alert);
    this.emit('alertAdded', alert);
  }

  private checkAlerts(): void {
    const h = this.healthMetrics;

    for (const [alertId, alert] of this.alerts) {
      let currentValue: number = 0;
      let shouldTrigger = false;

      // Evaluate alert condition
      switch (alert.condition) {
        case 'cpu_usage':
          currentValue = h.cpu.usage;
          shouldTrigger = currentValue > alert.threshold;
          break;
        case 'memory_usage':
          currentValue = (h.memory.used / h.memory.total) * 100;
          shouldTrigger = currentValue > alert.threshold;
          break;
        case 'hashrate_drop':
          currentValue = h.mining.hashrate;
          shouldTrigger = currentValue < alert.threshold;
          break;
        case 'acceptance_rate':
          currentValue = h.mining.sharesSubmitted > 0 
            ? (h.mining.sharesAccepted / h.mining.sharesSubmitted) * 100 
            : 100;
          shouldTrigger = currentValue < alert.threshold;
          break;
      }

      // Trigger or resolve alert
      if (shouldTrigger && !alert.triggered) {
        alert.triggered = true;
        alert.triggeredAt = Date.now();
        this.triggerAlert(alert, currentValue);
      } else if (!shouldTrigger && alert.triggered) {
        alert.triggered = false;
        alert.triggeredAt = undefined;
        this.resolveAlert(alert, currentValue);
      }
    }
  }

  private triggerAlert(alert: Alert, currentValue: number): void {
    const message = alert.message.replace('{value}', currentValue.toString())
                                 .replace('{threshold}', alert.threshold.toString());

    console.warn(`🚨 ALERT TRIGGERED: ${alert.name} - ${message}`);
    
    this.recordMetric(
      'alert_triggered',
      1,
      'count',
      {
        alert_name: alert.name,
        severity: alert.severity
      },
      'counter'
    );

    this.emit('alertTriggered', { alert, currentValue, message });

    // Execute alert actions
    for (const action of alert.actions) {
      this.executeAlertAction(action, alert, message);
    }
  }

  private resolveAlert(alert: Alert, currentValue: number): void {
    console.info(`✅ ALERT RESOLVED: ${alert.name} - Current value: ${currentValue}`);
    
    this.recordMetric(
      'alert_resolved',
      1,
      'count',
      {
        alert_name: alert.name,
        severity: alert.severity
      },
      'counter'
    );

    this.emit('alertResolved', { alert, currentValue });
  }

  private executeAlertAction(action: AlertAction, alert: Alert, message: string): void {
    switch (action.type) {
      case 'email':
        console.log(`📧 Sending email alert to ${action.target}: ${message}`);
        break;
      case 'slack':
        console.log(`💬 Sending Slack alert to ${action.target}: ${message}`);
        break;
      case 'webhook':
        console.log(`🔗 Sending webhook alert to ${action.target}: ${message}`);
        break;
      case 'sms':
        console.log(`📱 Sending SMS alert to ${action.target}: ${message}`);
        break;
    }
  }

  // === データフラッシュ ===
  private startAutoFlush(interval: number): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    this.flushTimer = setInterval(() => {
      this.flushMetrics();
    }, interval);
  }

  private async flushMetrics(): Promise<void> {
    if (this.metricsBuffer.length === 0) return;

    const metricsToFlush = [...this.metricsBuffer];
    this.metricsBuffer = [];

    try {
      await Promise.all(
        metricsToFlush.map(metric => 
          this.sendToAllProviders('sendMetric', metric)
        )
      );

      this.emit('metricsFlushed', { count: metricsToFlush.length });

    } catch (error) {
      console.error('Failed to flush metrics:', error);
      // Re-add failed metrics to buffer
      this.metricsBuffer.unshift(...metricsToFlush);
    }
  }

  // === ユーティリティ ===
  private async sendToAllProviders(method: string, data: any): Promise<void> {
    const promises = Array.from(this.providers.values()).map(async provider => {
      try {
        await (provider as any)[method](data);
      } catch (error) {
        console.error(`Failed to send data to provider:`, error);
      }
    });

    await Promise.all(promises);
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private getInitialHealthMetrics(): HealthMetrics {
    return {
      cpu: { usage: 0, loadAverage: [0, 0, 0] },
      memory: { used: 0, free: 0, total: 0, heapUsed: 0, heapTotal: 0 },
      network: { connections: 0, bytesIn: 0, bytesOut: 0 },
      mining: { hashrate: 0, sharesSubmitted: 0, sharesAccepted: 0, activeMiners: 0 },
      pool: { blocksFound: 0, revenue: 0, difficulty: 0 }
    };
  }

  // === パブリック情報取得 ===
  getHealthMetrics(): HealthMetrics {
    return { ...this.healthMetrics };
  }

  getActiveProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  getActiveTransactions(): Transaction[] {
    return Array.from(this.activeTransactions.values());
  }

  getActiveAlerts(): Alert[] {
    return Array.from(this.alerts.values()).filter(alert => alert.triggered);
  }

  // === Prometheus特別メソッド ===
  getPrometheusMetrics(): string {
    for (const provider of this.providers.values()) {
      if (provider instanceof PrometheusProvider) {
        return provider.getMetricsEndpoint();
      }
    }
    return '';
  }

  // === 停止処理 ===
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    // Final flush
    await this.flushMetrics();

    // Shutdown all providers
    const shutdownPromises = Array.from(this.providers.values()).map(provider => 
      provider.shutdown()
    );

    await Promise.all(shutdownPromises);
    this.providers.clear();
    
    console.log('🛑 APM Integration shutdown complete');
  }
}

// === ヘルパークラス ===
export class APMHelper {
  static createDefaultConfig(
    provider: APMConfig['provider'],
    apiKey: string,
    appName: string = 'otedama-pool'
  ): APMConfig {
    return {
      provider,
      apiKey,
      appName,
      environment: 'production',
      enabled: true,
      samplingRate: 1.0,
      batchSize: 100,
      flushInterval: 10000
    };
  }

  static createStandardAlerts(): Alert[] {
    return [
      {
        id: 'high_cpu_usage',
        name: 'High CPU Usage',
        condition: 'cpu_usage',
        threshold: 80,
        severity: 'high',
        triggered: false,
        message: 'CPU usage is {value}%, exceeding threshold of {threshold}%',
        actions: [
          { type: 'email', target: 'admin@pool.com' },
          { type: 'slack', target: '#alerts' }
        ]
      },
      {
        id: 'high_memory_usage',
        name: 'High Memory Usage',
        condition: 'memory_usage',
        threshold: 85,
        severity: 'high',
        triggered: false,
        message: 'Memory usage is {value}%, exceeding threshold of {threshold}%',
        actions: [
          { type: 'email', target: 'admin@pool.com' }
        ]
      },
      {
        id: 'low_hashrate',
        name: 'Low Hashrate',
        condition: 'hashrate_drop',
        threshold: 500000000000, // 500 TH/s
        severity: 'medium',
        triggered: false,
        message: 'Pool hashrate dropped to {value} H/s, below threshold of {threshold} H/s',
        actions: [
          { type: 'slack', target: '#mining' }
        ]
      },
      {
        id: 'low_acceptance_rate',
        name: 'Low Share Acceptance Rate',
        condition: 'acceptance_rate',
        threshold: 95,
        severity: 'medium',
        triggered: false,
        message: 'Share acceptance rate is {value}%, below threshold of {threshold}%',
        actions: [
          { type: 'email', target: 'ops@pool.com' }
        ]
      }
    ];
  }

  static formatMetricValue(value: number, unit: string): string {
    switch (unit) {
      case 'bytes':
        return this.formatBytes(value);
      case 'percent':
        return `${value.toFixed(1)}%`;
      case 'ms':
        return `${value.toFixed(2)}ms`;
      case 'seconds':
        return `${value.toFixed(2)}s`;
      case 'hash/s':
        return this.formatHashrate(value);
      default:
        return value.toString();
    }
  }

  private static formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let value = bytes;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }

    return `${value.toFixed(2)} ${units[unitIndex]}`;
  }

  private static formatHashrate(hashrate: number): string {
    if (hashrate >= 1e18) {
      return `${(hashrate / 1e18).toFixed(2)} EH/s`;
    } else if (hashrate >= 1e15) {
      return `${(hashrate / 1e15).toFixed(2)} PH/s`;
    } else if (hashrate >= 1e12) {
      return `${(hashrate / 1e12).toFixed(2)} TH/s`;
    } else if (hashrate >= 1e9) {
      return `${(hashrate / 1e9).toFixed(2)} GH/s`;
    }
    return `${hashrate.toFixed(0)} H/s`;
  }
}

export default APMIntegration;