/**
 * Advanced Observability Platform
 * 高度な可観測性プラットフォーム
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { performance } from 'perf_hooks';

const logger = getLogger('AdvancedObservabilityPlatform');

// テレメトリータイプ
export const TelemetryType = {
  METRICS: 'metrics',
  TRACES: 'traces',
  LOGS: 'logs',
  EVENTS: 'events',
  PROFILES: 'profiles'
};

// アラート重要度
export const AlertSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical'
};

// ダッシュボードタイプ
export const DashboardType = {
  SYSTEM: 'system',
  APPLICATION: 'application',
  BUSINESS: 'business',
  SECURITY: 'security',
  CUSTOM: 'custom'
};

export class AdvancedObservabilityPlatform extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = logger;
    
    this.options = {
      // 収集設定
      enableMetrics: options.enableMetrics !== false,
      enableTracing: options.enableTracing !== false,
      enableLogging: options.enableLogging !== false,
      enableProfiling: options.enableProfiling !== false,
      
      // サンプリング設定
      metricsSamplingRate: options.metricsSamplingRate || 1.0,
      traceSamplingRate: options.traceSamplingRate || 0.1,
      
      // 保存設定
      retentionPeriod: options.retentionPeriod || 30 * 24 * 60 * 60 * 1000, // 30日
      aggregationIntervals: options.aggregationIntervals || [60, 300, 3600], // 1分, 5分, 1時間
      
      // アラート設定
      enableAlerting: options.enableAlerting !== false,
      alertEvaluationInterval: options.alertEvaluationInterval || 60000, // 1分
      
      // 分析設定
      enableAnomalyDetection: options.enableAnomalyDetection !== false,
      enableCorrelation: options.enableCorrelation !== false,
      
      ...options
    };
    
    // メトリクスストア
    this.metricsStore = new Map();
    this.metricsBuffer = [];
    
    // トレースストア
    this.traces = new Map();
    this.activeSpans = new Map();
    
    // ログストア
    this.logs = [];
    this.logIndex = new Map();
    
    // アラート管理
    this.alertRules = new Map();
    this.activeAlerts = new Map();
    this.alertHistory = [];
    
    // ダッシュボード
    this.dashboards = new Map();
    this.widgets = new Map();
    
    // 分析エンジン
    this.anomalyDetector = null;
    this.correlationEngine = null;
    
    // OpenTelemetry互換
    this.otelCollector = null;
    
    this.initialize();
  }
  
  async initialize() {
    // メトリクス収集を開始
    if (this.options.enableMetrics) {
      this.startMetricsCollection();
    }
    
    // トレーシングを初期化
    if (this.options.enableTracing) {
      this.initializeTracing();
    }
    
    // アラート評価を開始
    if (this.options.enableAlerting) {
      this.startAlertEvaluation();
    }
    
    // 異常検知を初期化
    if (this.options.enableAnomalyDetection) {
      await this.initializeAnomalyDetection();
    }
    
    // デフォルトダッシュボードを作成
    this.createDefaultDashboards();
    
    this.logger.info('Advanced observability platform initialized');
  }
  
  /**
   * メトリクスを記録
   */
  recordMetric(name, value, tags = {}, timestamp = Date.now()) {
    if (!this.shouldSample(this.options.metricsSamplingRate)) {
      return;
    }
    
    const metric = {
      name,
      value,
      tags,
      timestamp,
      type: this.inferMetricType(name, value)
    };
    
    // バッファに追加
    this.metricsBuffer.push(metric);
    
    // 即座に処理が必要な場合
    if (this.isHighPriorityMetric(name)) {
      this.processMetric(metric);
    }
  }
  
  /**
   * カウンターをインクリメント
   */
  incrementCounter(name, value = 1, tags = {}) {
    const key = this.getMetricKey(name, tags);
    const current = this.metricsStore.get(key) || { value: 0, tags };
    
    current.value += value;
    current.lastUpdated = Date.now();
    
    this.metricsStore.set(key, current);
    this.recordMetric(name, current.value, tags);
  }
  
  /**
   * ゲージを設定
   */
  setGauge(name, value, tags = {}) {
    const key = this.getMetricKey(name, tags);
    
    this.metricsStore.set(key, {
      value,
      tags,
      lastUpdated: Date.now()
    });
    
    this.recordMetric(name, value, tags);
  }
  
  /**
   * ヒストグラムを記録
   */
  recordHistogram(name, value, tags = {}) {
    const key = this.getMetricKey(name, tags);
    let histogram = this.metricsStore.get(key);
    
    if (!histogram) {
      histogram = {
        values: [],
        count: 0,
        sum: 0,
        min: Infinity,
        max: -Infinity,
        buckets: this.createHistogramBuckets()
      };
      this.metricsStore.set(key, histogram);
    }
    
    // 値を記録
    histogram.values.push(value);
    histogram.count++;
    histogram.sum += value;
    histogram.min = Math.min(histogram.min, value);
    histogram.max = Math.max(histogram.max, value);
    
    // バケットを更新
    this.updateHistogramBuckets(histogram, value);
    
    // パーセンタイルを計算
    if (histogram.count % 100 === 0) {
      this.calculatePercentiles(histogram);
    }
  }
  
  /**
   * トレースを開始
   */
  startTrace(name, attributes = {}) {
    const traceId = this.generateTraceId();
    const spanId = this.generateSpanId();
    
    const span = {
      traceId,
      spanId,
      parentSpanId: null,
      name,
      startTime: performance.now(),
      endTime: null,
      attributes,
      events: [],
      status: 'in_progress'
    };
    
    this.activeSpans.set(spanId, span);
    
    return {
      traceId,
      spanId,
      
      addEvent: (name, attributes = {}) => {
        span.events.push({
          name,
          timestamp: performance.now(),
          attributes
        });
      },
      
      setAttributes: (attrs) => {
        Object.assign(span.attributes, attrs);
      },
      
      end: (status = 'ok') => {
        span.endTime = performance.now();
        span.duration = span.endTime - span.startTime;
        span.status = status;
        
        this.activeSpans.delete(spanId);
        this.storeTrace(span);
        
        return span;
      }
    };
  }
  
  /**
   * 子スパンを開始
   */
  startSpan(parentSpan, name, attributes = {}) {
    const spanId = this.generateSpanId();
    
    const span = {
      traceId: parentSpan.traceId,
      spanId,
      parentSpanId: parentSpan.spanId,
      name,
      startTime: performance.now(),
      endTime: null,
      attributes,
      events: [],
      status: 'in_progress'
    };
    
    this.activeSpans.set(spanId, span);
    
    return {
      ...span,
      
      addEvent: (name, attributes = {}) => {
        span.events.push({
          name,
          timestamp: performance.now(),
          attributes
        });
      },
      
      setAttributes: (attrs) => {
        Object.assign(span.attributes, attrs);
      },
      
      end: (status = 'ok') => {
        span.endTime = performance.now();
        span.duration = span.endTime - span.startTime;
        span.status = status;
        
        this.activeSpans.delete(spanId);
        this.storeTrace(span);
        
        return span;
      }
    };
  }
  
  /**
   * ログを記録
   */
  log(level, message, context = {}) {
    const logEntry = {
      timestamp: Date.now(),
      level,
      message,
      context,
      traceId: context.traceId || null,
      spanId: context.spanId || null
    };
    
    // ログを保存
    this.logs.push(logEntry);
    
    // インデックスを更新
    this.updateLogIndex(logEntry);
    
    // 重要なログはアラートをトリガー
    if (level === 'error' || level === 'critical') {
      this.checkLogAlerts(logEntry);
    }
    
    // ログローテーション
    if (this.logs.length > 100000) {
      this.rotateLogs();
    }
  }
  
  /**
   * アラートルールを作成
   */
  createAlertRule(name, config) {
    const rule = {
      name,
      condition: config.condition,
      threshold: config.threshold,
      duration: config.duration || 0,
      severity: config.severity || AlertSeverity.WARNING,
      annotations: config.annotations || {},
      actions: config.actions || [],
      enabled: config.enabled !== false,
      lastEvaluation: null,
      state: 'normal'
    };
    
    this.alertRules.set(name, rule);
    
    return rule;
  }
  
  /**
   * ダッシュボードを作成
   */
  createDashboard(name, config) {
    const dashboard = {
      id: this.generateDashboardId(),
      name,
      type: config.type || DashboardType.CUSTOM,
      layout: config.layout || 'grid',
      widgets: [],
      refreshInterval: config.refreshInterval || 30000,
      timeRange: config.timeRange || '1h',
      variables: config.variables || {},
      created: Date.now(),
      modified: Date.now()
    };
    
    this.dashboards.set(dashboard.id, dashboard);
    
    // ウィジェットを追加
    if (config.widgets) {
      for (const widgetConfig of config.widgets) {
        this.addWidget(dashboard.id, widgetConfig);
      }
    }
    
    return dashboard;
  }
  
  /**
   * ウィジェットを追加
   */
  addWidget(dashboardId, config) {
    const widget = {
      id: this.generateWidgetId(),
      dashboardId,
      type: config.type,
      title: config.title,
      query: config.query,
      visualization: config.visualization || 'line',
      options: config.options || {},
      position: config.position || { x: 0, y: 0, w: 6, h: 4 }
    };
    
    this.widgets.set(widget.id, widget);
    
    const dashboard = this.dashboards.get(dashboardId);
    if (dashboard) {
      dashboard.widgets.push(widget.id);
      dashboard.modified = Date.now();
    }
    
    return widget;
  }
  
  /**
   * メトリクスをクエリ
   */
  async queryMetrics(query) {
    const { metric, tags, timeRange, aggregation } = query;
    
    // メトリクスをフィルタ
    const metrics = this.filterMetrics(metric, tags, timeRange);
    
    // 集約を実行
    if (aggregation) {
      return this.aggregateMetrics(metrics, aggregation);
    }
    
    return metrics;
  }
  
  /**
   * トレースを検索
   */
  async searchTraces(criteria) {
    const results = [];
    
    for (const [traceId, trace] of this.traces) {
      if (this.matchTraceCriteria(trace, criteria)) {
        results.push(trace);
      }
    }
    
    // ソートと制限
    results.sort((a, b) => b.startTime - a.startTime);
    
    if (criteria.limit) {
      return results.slice(0, criteria.limit);
    }
    
    return results;
  }
  
  /**
   * ログを検索
   */
  async searchLogs(query) {
    let results = [...this.logs];
    
    // レベルでフィルタ
    if (query.level) {
      results = results.filter(log => log.level === query.level);
    }
    
    // テキスト検索
    if (query.search) {
      const searchRegex = new RegExp(query.search, 'i');
      results = results.filter(log => 
        searchRegex.test(log.message) ||
        searchRegex.test(JSON.stringify(log.context))
      );
    }
    
    // 時間範囲でフィルタ
    if (query.timeRange) {
      const { start, end } = this.parseTimeRange(query.timeRange);
      results = results.filter(log => 
        log.timestamp >= start && log.timestamp <= end
      );
    }
    
    // トレースIDでフィルタ
    if (query.traceId) {
      results = results.filter(log => log.traceId === query.traceId);
    }
    
    return results;
  }
  
  /**
   * 相関分析を実行
   */
  async performCorrelationAnalysis(timeRange) {
    if (!this.options.enableCorrelation) {
      return null;
    }
    
    const { start, end } = this.parseTimeRange(timeRange);
    
    // データを収集
    const metrics = await this.queryMetrics({ timeRange });
    const traces = await this.searchTraces({ startTime: start, endTime: end });
    const logs = await this.searchLogs({ timeRange });
    
    // 相関を分析
    const correlations = {
      metricToMetric: this.correlateMetrics(metrics),
      metricToError: this.correlateMetricsToErrors(metrics, logs),
      traceToMetric: this.correlateTracesToMetrics(traces, metrics),
      anomalies: await this.detectAnomalies(metrics, traces, logs)
    };
    
    return correlations;
  }
  
  /**
   * SLI/SLOを計算
   */
  calculateSLI(name, config) {
    const { goodEvents, totalEvents, timeRange } = config;
    
    // イベントを集計
    const good = this.countEvents(goodEvents, timeRange);
    const total = this.countEvents(totalEvents, timeRange);
    
    const sli = total > 0 ? (good / total) * 100 : 100;
    
    // SLOと比較
    const slo = config.slo || 99.9;
    const errorBudget = 100 - slo;
    const consumedBudget = (100 - sli) / errorBudget * 100;
    
    return {
      name,
      sli,
      slo,
      errorBudget,
      consumedBudget,
      status: sli >= slo ? 'meeting' : 'breaching',
      timeRange
    };
  }
  
  /**
   * カスタムメトリクスを作成
   */
  createCustomMetric(name, formula) {
    return {
      name,
      type: 'custom',
      formula,
      
      evaluate: async (timeRange) => {
        const context = await this.buildFormulaContext(timeRange);
        return this.evaluateFormula(formula, context);
      }
    };
  }
  
  /**
   * メトリクス収集を開始
   */
  startMetricsCollection() {
    // システムメトリクスを収集
    this.metricsInterval = setInterval(() => {
      this.collectSystemMetrics();
    }, 10000); // 10秒ごと
    
    // バッファをフラッシュ
    this.flushInterval = setInterval(() => {
      this.flushMetricsBuffer();
    }, 60000); // 1分ごと
  }
  
  /**
   * システムメトリクスを収集
   */
  collectSystemMetrics() {
    const cpuUsage = process.cpuUsage();
    const memUsage = process.memoryUsage();
    
    // CPU使用率
    this.setGauge('system.cpu.usage', cpuUsage.user + cpuUsage.system);
    
    // メモリ使用量
    this.setGauge('system.memory.heap.used', memUsage.heapUsed);
    this.setGauge('system.memory.heap.total', memUsage.heapTotal);
    this.setGauge('system.memory.rss', memUsage.rss);
    
    // イベントループ遅延
    const start = performance.now();
    setImmediate(() => {
      const delay = performance.now() - start;
      this.recordHistogram('system.eventloop.delay', delay);
    });
  }
  
  /**
   * アラート評価を開始
   */
  startAlertEvaluation() {
    this.alertInterval = setInterval(async () => {
      await this.evaluateAlerts();
    }, this.options.alertEvaluationInterval);
  }
  
  /**
   * アラートを評価
   */
  async evaluateAlerts() {
    for (const [name, rule] of this.alertRules) {
      if (!rule.enabled) continue;
      
      try {
        const result = await this.evaluateAlertCondition(rule);
        
        if (result.firing && rule.state !== 'firing') {
          // アラート発火
          await this.fireAlert(rule, result);
        } else if (!result.firing && rule.state === 'firing') {
          // アラート解決
          await this.resolveAlert(rule);
        }
        
        rule.lastEvaluation = Date.now();
        
      } catch (error) {
        this.logger.error(`Alert evaluation failed for ${name}`, error);
      }
    }
  }
  
  /**
   * 異常検知を初期化
   */
  async initializeAnomalyDetection() {
    this.anomalyDetector = {
      models: new Map(),
      
      train: async (metric, data) => {
        // 統計的モデルを学習（簡略化）
        const model = {
          mean: this.calculateMean(data),
          stdDev: this.calculateStdDev(data),
          seasonality: this.detectSeasonality(data)
        };
        
        this.anomalyDetector.models.set(metric, model);
      },
      
      detect: async (metric, value) => {
        const model = this.anomalyDetector.models.get(metric);
        if (!model) return false;
        
        // Z-スコアを計算
        const zScore = Math.abs((value - model.mean) / model.stdDev);
        
        return zScore > 3; // 3σを超えたら異常
      }
    };
  }
  
  /**
   * デフォルトダッシュボードを作成
   */
  createDefaultDashboards() {
    // システムダッシュボード
    this.createDashboard('System Overview', {
      type: DashboardType.SYSTEM,
      widgets: [
        {
          type: 'graph',
          title: 'CPU Usage',
          query: { metric: 'system.cpu.usage' },
          visualization: 'line'
        },
        {
          type: 'graph',
          title: 'Memory Usage',
          query: { metric: 'system.memory.heap.used' },
          visualization: 'area'
        },
        {
          type: 'stat',
          title: 'Error Rate',
          query: { metric: 'http.requests.errors' },
          visualization: 'gauge'
        },
        {
          type: 'table',
          title: 'Top Endpoints',
          query: { metric: 'http.requests', groupBy: 'endpoint' },
          visualization: 'table'
        }
      ]
    });
    
    // アプリケーションダッシュボード
    this.createDashboard('Application Performance', {
      type: DashboardType.APPLICATION,
      widgets: [
        {
          type: 'graph',
          title: 'Request Rate',
          query: { metric: 'http.requests.rate' },
          visualization: 'line'
        },
        {
          type: 'graph',
          title: 'Response Time',
          query: { metric: 'http.response.time' },
          visualization: 'heatmap'
        },
        {
          type: 'trace',
          title: 'Recent Traces',
          query: { limit: 10 },
          visualization: 'trace'
        }
      ]
    });
  }
  
  /**
   * OpenTelemetryエクスポート
   */
  exportToOpenTelemetry() {
    return {
      metrics: this.convertMetricsToOTLP(),
      traces: this.convertTracesToOTLP(),
      logs: this.convertLogsToOTLP()
    };
  }
  
  /**
   * 統計情報を取得
   */
  getStats() {
    return {
      metrics: {
        total: this.metricsStore.size,
        buffered: this.metricsBuffer.length,
        types: this.getMetricTypes()
      },
      traces: {
        total: this.traces.size,
        active: this.activeSpans.size,
        avgDuration: this.calculateAverageTraceDuration()
      },
      logs: {
        total: this.logs.length,
        byLevel: this.getLogCountByLevel()
      },
      alerts: {
        rules: this.alertRules.size,
        active: this.activeAlerts.size,
        history: this.alertHistory.length
      },
      dashboards: {
        total: this.dashboards.size,
        widgets: this.widgets.size
      }
    };
  }
  
  // ヘルパーメソッド
  shouldSample(rate) {
    return Math.random() < rate;
  }
  
  inferMetricType(name, value) {
    if (name.includes('count') || name.includes('total')) return 'counter';
    if (name.includes('gauge') || name.includes('current')) return 'gauge';
    if (name.includes('duration') || name.includes('latency')) return 'histogram';
    return typeof value === 'number' ? 'gauge' : 'counter';
  }
  
  isHighPriorityMetric(name) {
    return name.includes('error') || name.includes('critical');
  }
  
  getMetricKey(name, tags) {
    const tagStr = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(',');
    
    return `${name}{${tagStr}}`;
  }
  
  createHistogramBuckets() {
    return [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000];
  }
  
  updateHistogramBuckets(histogram, value) {
    for (let i = 0; i < histogram.buckets.length; i++) {
      if (value <= histogram.buckets[i]) {
        histogram.buckets[i]++;
        break;
      }
    }
  }
  
  calculatePercentiles(histogram) {
    const sorted = histogram.values.sort((a, b) => a - b);
    
    histogram.p50 = sorted[Math.floor(sorted.length * 0.5)];
    histogram.p90 = sorted[Math.floor(sorted.length * 0.9)];
    histogram.p95 = sorted[Math.floor(sorted.length * 0.95)];
    histogram.p99 = sorted[Math.floor(sorted.length * 0.99)];
  }
  
  generateTraceId() {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateSpanId() {
    return `span_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateDashboardId() {
    return `dash_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateWidgetId() {
    return `widget_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  storeTrace(span) {
    let trace = this.traces.get(span.traceId);
    
    if (!trace) {
      trace = {
        traceId: span.traceId,
        spans: [],
        startTime: span.startTime,
        endTime: span.endTime,
        duration: span.duration
      };
      this.traces.set(span.traceId, trace);
    }
    
    trace.spans.push(span);
    trace.endTime = Math.max(trace.endTime || 0, span.endTime);
    trace.duration = trace.endTime - trace.startTime;
  }
  
  updateLogIndex(logEntry) {
    // レベル別インデックス
    const levelIndex = this.logIndex.get(logEntry.level) || [];
    levelIndex.push(this.logs.length - 1);
    this.logIndex.set(logEntry.level, levelIndex);
  }
  
  checkLogAlerts(logEntry) {
    // エラーログに対するアラートをチェック
    for (const [name, rule] of this.alertRules) {
      if (rule.condition.type === 'log' && 
          rule.condition.level === logEntry.level) {
        this.incrementCounter(`alert.${name}.count`);
      }
    }
  }
  
  rotateLogs() {
    // 古いログを削除
    const cutoff = Date.now() - this.options.retentionPeriod;
    this.logs = this.logs.filter(log => log.timestamp > cutoff);
    
    // インデックスを再構築
    this.rebuildLogIndex();
  }
  
  rebuildLogIndex() {
    this.logIndex.clear();
    
    this.logs.forEach((log, index) => {
      const levelIndex = this.logIndex.get(log.level) || [];
      levelIndex.push(index);
      this.logIndex.set(log.level, levelIndex);
    });
  }
  
  processMetric(metric) {
    // リアルタイム処理が必要なメトリクス
    if (this.options.enableAnomalyDetection) {
      this.checkMetricAnomaly(metric);
    }
  }
  
  async checkMetricAnomaly(metric) {
    const isAnomaly = await this.anomalyDetector.detect(metric.name, metric.value);
    
    if (isAnomaly) {
      this.emit('anomaly:detected', {
        metric: metric.name,
        value: metric.value,
        timestamp: metric.timestamp
      });
    }
  }
  
  flushMetricsBuffer() {
    if (this.metricsBuffer.length === 0) return;
    
    // バッファの内容を処理
    const buffer = [...this.metricsBuffer];
    this.metricsBuffer = [];
    
    // 集約とストレージへの保存
    this.aggregateAndStore(buffer);
  }
  
  aggregateAndStore(metrics) {
    // 時間ウィンドウごとに集約
    for (const interval of this.options.aggregationIntervals) {
      const aggregated = this.aggregateByInterval(metrics, interval);
      // ストレージに保存（実装は省略）
    }
  }
  
  aggregateByInterval(metrics, interval) {
    const buckets = new Map();
    
    for (const metric of metrics) {
      const bucket = Math.floor(metric.timestamp / (interval * 1000)) * interval * 1000;
      const key = `${metric.name}_${bucket}`;
      
      if (!buckets.has(key)) {
        buckets.set(key, {
          name: metric.name,
          timestamp: bucket,
          values: []
        });
      }
      
      buckets.get(key).values.push(metric.value);
    }
    
    // 各バケットの統計を計算
    const aggregated = [];
    for (const [key, bucket] of buckets) {
      aggregated.push({
        ...bucket,
        count: bucket.values.length,
        sum: bucket.values.reduce((a, b) => a + b, 0),
        avg: bucket.values.reduce((a, b) => a + b, 0) / bucket.values.length,
        min: Math.min(...bucket.values),
        max: Math.max(...bucket.values)
      });
    }
    
    return aggregated;
  }
  
  parseTimeRange(timeRange) {
    const now = Date.now();
    
    if (typeof timeRange === 'string') {
      // 相対的な時間範囲（例: '1h', '24h', '7d'）
      const match = timeRange.match(/(\d+)([hdwm])/);
      if (match) {
        const value = parseInt(match[1]);
        const unit = match[2];
        
        const multipliers = {
          h: 60 * 60 * 1000,
          d: 24 * 60 * 60 * 1000,
          w: 7 * 24 * 60 * 60 * 1000,
          m: 30 * 24 * 60 * 60 * 1000
        };
        
        const duration = value * multipliers[unit];
        return { start: now - duration, end: now };
      }
    } else if (typeof timeRange === 'object') {
      return timeRange;
    }
    
    // デフォルト: 過去1時間
    return { start: now - 3600000, end: now };
  }
  
  filterMetrics(name, tags, timeRange) {
    const { start, end } = this.parseTimeRange(timeRange);
    const filtered = [];
    
    // メトリクスストアから取得（実装は簡略化）
    for (const [key, metric] of this.metricsStore) {
      if (key.startsWith(name) && 
          metric.lastUpdated >= start && 
          metric.lastUpdated <= end) {
        filtered.push(metric);
      }
    }
    
    return filtered;
  }
  
  aggregateMetrics(metrics, aggregation) {
    switch (aggregation.function) {
      case 'sum':
        return metrics.reduce((sum, m) => sum + m.value, 0);
      case 'avg':
        return metrics.reduce((sum, m) => sum + m.value, 0) / metrics.length;
      case 'max':
        return Math.max(...metrics.map(m => m.value));
      case 'min':
        return Math.min(...metrics.map(m => m.value));
      case 'count':
        return metrics.length;
      default:
        return metrics;
    }
  }
  
  matchTraceCriteria(trace, criteria) {
    if (criteria.service && !trace.spans.some(s => s.attributes.service === criteria.service)) {
      return false;
    }
    
    if (criteria.minDuration && trace.duration < criteria.minDuration) {
      return false;
    }
    
    if (criteria.status && !trace.spans.some(s => s.status === criteria.status)) {
      return false;
    }
    
    return true;
  }
  
  correlateMetrics(metrics) {
    // ピアソン相関係数を計算（簡略化）
    const correlations = [];
    
    const metricNames = Array.from(new Set(metrics.map(m => m.name)));
    
    for (let i = 0; i < metricNames.length; i++) {
      for (let j = i + 1; j < metricNames.length; j++) {
        const correlation = this.calculateCorrelation(
          metrics.filter(m => m.name === metricNames[i]),
          metrics.filter(m => m.name === metricNames[j])
        );
        
        if (Math.abs(correlation) > 0.7) {
          correlations.push({
            metric1: metricNames[i],
            metric2: metricNames[j],
            correlation
          });
        }
      }
    }
    
    return correlations;
  }
  
  calculateCorrelation(series1, series2) {
    // ピアソン相関係数の計算（簡略化）
    return 0.85; // デモ値
  }
  
  correlateMetricsToErrors(metrics, logs) {
    const errors = logs.filter(l => l.level === 'error');
    const correlations = [];
    
    // エラー発生時のメトリクスを分析
    for (const error of errors) {
      const nearbyMetrics = metrics.filter(m => 
        Math.abs(m.timestamp - error.timestamp) < 60000 // 1分以内
      );
      
      // 異常なメトリクスを特定
      for (const metric of nearbyMetrics) {
        if (this.isMetricAbnormal(metric)) {
          correlations.push({
            error: error.message,
            metric: metric.name,
            value: metric.value,
            timestamp: error.timestamp
          });
        }
      }
    }
    
    return correlations;
  }
  
  isMetricAbnormal(metric) {
    // 簡略化された異常判定
    return metric.value > 100 || metric.value < 0;
  }
  
  correlateTracesToMetrics(traces, metrics) {
    const correlations = [];
    
    for (const trace of traces) {
      // トレースの時間範囲内のメトリクスを取得
      const traceMetrics = metrics.filter(m => 
        m.timestamp >= trace.startTime && m.timestamp <= trace.endTime
      );
      
      // 遅いトレースと高いメトリクスの相関を検出
      if (trace.duration > 1000) { // 1秒以上
        for (const metric of traceMetrics) {
          if (metric.name.includes('cpu') && metric.value > 80) {
            correlations.push({
              trace: trace.traceId,
              metric: metric.name,
              correlation: 'high_cpu_slow_trace'
            });
          }
        }
      }
    }
    
    return correlations;
  }
  
  async detectAnomalies(metrics, traces, logs) {
    const anomalies = [];
    
    // メトリクス異常
    for (const metric of metrics) {
      if (await this.anomalyDetector.detect(metric.name, metric.value)) {
        anomalies.push({
          type: 'metric',
          name: metric.name,
          value: metric.value,
          timestamp: metric.timestamp
        });
      }
    }
    
    // トレース異常（極端に遅い）
    const avgDuration = traces.reduce((sum, t) => sum + t.duration, 0) / traces.length;
    for (const trace of traces) {
      if (trace.duration > avgDuration * 3) {
        anomalies.push({
          type: 'trace',
          traceId: trace.traceId,
          duration: trace.duration,
          timestamp: trace.startTime
        });
      }
    }
    
    // ログパターン異常
    const errorBurst = this.detectErrorBurst(logs);
    if (errorBurst) {
      anomalies.push({
        type: 'log',
        pattern: 'error_burst',
        count: errorBurst.count,
        timestamp: errorBurst.timestamp
      });
    }
    
    return anomalies;
  }
  
  detectErrorBurst(logs) {
    const errors = logs.filter(l => l.level === 'error');
    const windowSize = 60000; // 1分
    
    // スライディングウィンドウでエラー数をカウント
    let maxCount = 0;
    let maxTimestamp = null;
    
    for (let i = 0; i < errors.length; i++) {
      const windowEnd = errors[i].timestamp + windowSize;
      const count = errors.filter(e => 
        e.timestamp >= errors[i].timestamp && e.timestamp < windowEnd
      ).length;
      
      if (count > maxCount) {
        maxCount = count;
        maxTimestamp = errors[i].timestamp;
      }
    }
    
    // 閾値を超えたらバーストとして検出
    if (maxCount > 10) {
      return { count: maxCount, timestamp: maxTimestamp };
    }
    
    return null;
  }
  
  countEvents(eventQuery, timeRange) {
    // イベント数をカウント（実装は簡略化）
    return 1000;
  }
  
  async buildFormulaContext(timeRange) {
    // フォーミュラ評価用のコンテキストを構築
    return {
      metrics: await this.queryMetrics({ timeRange }),
      functions: {
        sum: (arr) => arr.reduce((a, b) => a + b, 0),
        avg: (arr) => arr.reduce((a, b) => a + b, 0) / arr.length,
        max: (arr) => Math.max(...arr),
        min: (arr) => Math.min(...arr)
      }
    };
  }
  
  evaluateFormula(formula, context) {
    // フォーミュラを評価（実装は簡略化）
    return eval(formula);
  }
  
  async evaluateAlertCondition(rule) {
    // アラート条件を評価
    const value = await this.getMetricValue(rule.condition.metric);
    const threshold = rule.threshold;
    
    let firing = false;
    
    switch (rule.condition.operator) {
      case '>':
        firing = value > threshold;
        break;
      case '<':
        firing = value < threshold;
        break;
      case '>=':
        firing = value >= threshold;
        break;
      case '<=':
        firing = value <= threshold;
        break;
      case '==':
        firing = value === threshold;
        break;
      case '!=':
        firing = value !== threshold;
        break;
    }
    
    return { firing, value };
  }
  
  async getMetricValue(metricName) {
    // 最新のメトリクス値を取得
    const key = this.getMetricKey(metricName, {});
    const metric = this.metricsStore.get(key);
    
    return metric ? metric.value : 0;
  }
  
  async fireAlert(rule, result) {
    rule.state = 'firing';
    
    const alert = {
      id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      rule: rule.name,
      severity: rule.severity,
      value: result.value,
      threshold: rule.threshold,
      firedAt: Date.now(),
      annotations: rule.annotations
    };
    
    this.activeAlerts.set(alert.id, alert);
    this.alertHistory.push(alert);
    
    // アクションを実行
    for (const action of rule.actions) {
      await this.executeAlertAction(action, alert);
    }
    
    this.emit('alert:fired', alert);
  }
  
  async resolveAlert(rule) {
    rule.state = 'resolved';
    
    // アクティブアラートから削除
    for (const [id, alert] of this.activeAlerts) {
      if (alert.rule === rule.name) {
        alert.resolvedAt = Date.now();
        this.activeAlerts.delete(id);
        
        this.emit('alert:resolved', alert);
      }
    }
  }
  
  async executeAlertAction(action, alert) {
    // アラートアクションを実行（実装は省略）
    this.logger.info(`Executing alert action: ${action.type}`, alert);
  }
  
  calculateMean(data) {
    return data.reduce((sum, val) => sum + val, 0) / data.length;
  }
  
  calculateStdDev(data) {
    const mean = this.calculateMean(data);
    const variance = data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / data.length;
    return Math.sqrt(variance);
  }
  
  detectSeasonality(data) {
    // 季節性を検出（実装は簡略化）
    return { period: 24, amplitude: 10 };
  }
  
  getMetricTypes() {
    const types = {};
    
    for (const [key, metric] of this.metricsStore) {
      const type = this.inferMetricType(key, metric.value);
      types[type] = (types[type] || 0) + 1;
    }
    
    return types;
  }
  
  calculateAverageTraceDuration() {
    if (this.traces.size === 0) return 0;
    
    let total = 0;
    for (const trace of this.traces.values()) {
      total += trace.duration;
    }
    
    return total / this.traces.size;
  }
  
  getLogCountByLevel() {
    const counts = {};
    
    for (const [level, indices] of this.logIndex) {
      counts[level] = indices.length;
    }
    
    return counts;
  }
  
  convertMetricsToOTLP() {
    // OpenTelemetry Line Protocol形式に変換
    return Array.from(this.metricsStore.entries()).map(([key, metric]) => ({
      name: key.split('{')[0],
      dataPoints: [{
        value: metric.value,
        timestamp: metric.lastUpdated,
        attributes: metric.tags
      }]
    }));
  }
  
  convertTracesToOTLP() {
    // OpenTelemetry Trace形式に変換
    return Array.from(this.traces.values()).map(trace => ({
      traceId: trace.traceId,
      spans: trace.spans.map(span => ({
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        startTime: span.startTime,
        endTime: span.endTime,
        attributes: span.attributes,
        events: span.events,
        status: span.status
      }))
    }));
  }
  
  convertLogsToOTLP() {
    // OpenTelemetry Log形式に変換
    return this.logs.map(log => ({
      timestamp: log.timestamp,
      severityText: log.level,
      body: log.message,
      attributes: log.context,
      traceId: log.traceId,
      spanId: log.spanId
    }));
  }
  
  /**
   * クリーンアップ
   */
  async cleanup() {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    
    if (this.alertInterval) {
      clearInterval(this.alertInterval);
    }
    
    // 最後のフラッシュ
    this.flushMetricsBuffer();
  }
}

export default AdvancedObservabilityPlatform;