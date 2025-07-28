/**
 * Realtime Analytics Dashboard - Otedama
 * リアルタイム分析ダッシュボード
 * 
 * 機能:
 * - リアルタイムメトリクス表示
 * - 予測分析とトレンド
 * - カスタマイズ可能なウィジェット
 * - アラートと通知
 * - データエクスポート
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import WebSocket from 'ws';
import { ethers } from 'ethers';

const logger = createStructuredLogger('RealtimeAnalyticsDashboard');

// ダッシュボードウィジェット
export const DashboardWidgets = {
  HASHRATE_CHART: {
    id: 'hashrate_chart',
    name: 'ハッシュレートチャート',
    type: 'line_chart',
    dataSource: 'mining.hashrate',
    updateInterval: 5000,
    displayOptions: {
      timeRange: '24h',
      aggregation: 'avg',
      showTrend: true
    }
  },
  
  PROFIT_CALCULATOR: {
    id: 'profit_calculator',
    name: '収益計算機',
    type: 'calculator',
    dataSource: ['mining.hashrate', 'market.price', 'costs.power'],
    updateInterval: 60000,
    displayOptions: {
      currency: 'USD',
      showBreakdown: true,
      projections: true
    }
  },
  
  HARDWARE_MONITOR: {
    id: 'hardware_monitor',
    name: 'ハードウェアモニター',
    type: 'gauge_cluster',
    dataSource: 'hardware.*',
    updateInterval: 3000,
    displayOptions: {
      showTemperature: true,
      showPower: true,
      showFanSpeed: true,
      alertThresholds: true
    }
  },
  
  MARKET_OVERVIEW: {
    id: 'market_overview',
    name: '市場概況',
    type: 'market_widget',
    dataSource: 'market.*',
    updateInterval: 30000,
    displayOptions: {
      coins: ['BTC', 'ETH', 'ETC', 'RVN'],
      showChange: true,
      showVolume: true
    }
  },
  
  POOL_STATISTICS: {
    id: 'pool_statistics',
    name: 'プール統計',
    type: 'statistics',
    dataSource: 'pool.*',
    updateInterval: 60000,
    displayOptions: {
      showShares: true,
      showWorkers: true,
      showPayouts: true
    }
  },
  
  AI_INSIGHTS: {
    id: 'ai_insights',
    name: 'AI分析',
    type: 'insights',
    dataSource: 'ai.*',
    updateInterval: 300000,
    displayOptions: {
      showPredictions: true,
      showRecommendations: true,
      confidenceLevel: true
    }
  },
  
  EFFICIENCY_MATRIX: {
    id: 'efficiency_matrix',
    name: '効率マトリックス',
    type: 'heatmap',
    dataSource: ['mining.efficiency', 'hardware.performance'],
    updateInterval: 60000,
    displayOptions: {
      dimensions: ['time', 'device'],
      colorScale: 'efficiency'
    }
  },
  
  ALERT_FEED: {
    id: 'alert_feed',
    name: 'アラートフィード',
    type: 'feed',
    dataSource: 'alerts.*',
    updateInterval: 1000,
    displayOptions: {
      maxItems: 50,
      severity: ['critical', 'warning', 'info'],
      autoScroll: true
    }
  }
};

// メトリクスタイプ
export const MetricTypes = {
  GAUGE: 'gauge',
  COUNTER: 'counter',
  HISTOGRAM: 'histogram',
  SUMMARY: 'summary',
  TREND: 'trend'
};

// 分析設定
export const AnalyticsConfig = {
  AGGREGATIONS: ['sum', 'avg', 'min', 'max', 'count', 'p50', 'p95', 'p99'],
  TIME_RANGES: ['1h', '6h', '24h', '7d', '30d', 'custom'],
  REFRESH_RATES: [1000, 5000, 10000, 30000, 60000, 300000],
  EXPORT_FORMATS: ['json', 'csv', 'excel', 'pdf']
};

export class RealtimeAnalyticsDashboard extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // 基本設定
      enabled: options.enabled !== false,
      port: options.port || 8080,
      wsPort: options.wsPort || 8081,
      
      // ダッシュボード設定
      defaultLayout: options.defaultLayout || 'grid',
      theme: options.theme || 'dark',
      refreshRate: options.refreshRate || 5000,
      
      // データ設定
      dataRetention: options.dataRetention || 7 * 24 * 60 * 60 * 1000, // 7日
      aggregationInterval: options.aggregationInterval || 60000, // 1分
      maxDataPoints: options.maxDataPoints || 10000,
      
      // パフォーマンス設定
      enableCaching: options.enableCaching !== false,
      cacheExpiry: options.cacheExpiry || 60000,
      streamingEnabled: options.streamingEnabled !== false,
      compression: options.compression !== false,
      
      // カスタマイズ
      customWidgets: options.customWidgets || [],
      plugins: options.plugins || [],
      
      // アラート設定
      alertingEnabled: options.alertingEnabled !== false,
      alertRules: options.alertRules || [],
      
      ...options
    };
    
    // データストア
    this.metrics = new Map();
    this.timeSeries = new Map();
    this.aggregations = new Map();
    
    // WebSocketサーバー
    this.wsServer = null;
    this.wsClients = new Map();
    
    // ウィジェット管理
    this.widgets = new Map();
    this.widgetSubscriptions = new Map();
    
    // レイアウト
    this.layouts = new Map();
    this.activeLayout = null;
    
    // キャッシュ
    this.cache = new Map();
    this.cacheTimestamps = new Map();
    
    // アラート
    this.activeAlerts = new Map();
    this.alertHistory = [];
    
    // 統計
    this.stats = {
      totalMetrics: 0,
      dataPointsReceived: 0,
      clientsConnected: 0,
      widgetsActive: 0,
      alertsTriggered: 0,
      cacheHits: 0,
      cacheMisses: 0
    };
    
    // タイマー
    this.aggregationTimer = null;
    this.cleanupTimer = null;
  }
  
  /**
   * 初期化
   */
  async initialize() {
    logger.info('リアルタイム分析ダッシュボード初期化中', {
      port: this.options.port,
      wsPort: this.options.wsPort
    });
    
    try {
      // HTTPサーバー初期化
      await this.setupHTTPServer();
      
      // WebSocketサーバー初期化
      if (this.options.streamingEnabled) {
        await this.setupWebSocketServer();
      }
      
      // デフォルトウィジェット登録
      this.registerDefaultWidgets();
      
      // カスタムウィジェット登録
      for (const widget of this.options.customWidgets) {
        this.registerWidget(widget);
      }
      
      // プラグイン初期化
      await this.initializePlugins();
      
      // デフォルトレイアウト設定
      this.setupDefaultLayout();
      
      // 集計処理開始
      this.startAggregation();
      
      // クリーンアップ処理開始
      this.startCleanup();
      
      logger.info('ダッシュボード初期化完了', {
        widgets: this.widgets.size,
        plugins: this.options.plugins.length
      });
      
      this.emit('initialized', {
        widgets: Array.from(this.widgets.keys()),
        port: this.options.port
      });
      
    } catch (error) {
      logger.error('ダッシュボード初期化失敗', { error: error.message });
      throw error;
    }
  }
  
  /**
   * メトリクス記録
   */
  recordMetric(name, value, type = MetricTypes.GAUGE, tags = {}) {
    const metric = {
      name,
      value,
      type,
      tags,
      timestamp: Date.now()
    };
    
    // メトリクスストアに保存
    this.metrics.set(name, metric);
    
    // 時系列データに追加
    if (!this.timeSeries.has(name)) {
      this.timeSeries.set(name, []);
    }
    
    const series = this.timeSeries.get(name);
    series.push({
      value,
      timestamp: metric.timestamp,
      tags
    });
    
    // データポイント制限
    if (series.length > this.options.maxDataPoints) {
      series.shift();
    }
    
    // 統計更新
    this.stats.totalMetrics++;
    this.stats.dataPointsReceived++;
    
    // リアルタイムブロードキャスト
    if (this.options.streamingEnabled) {
      this.broadcastMetric(metric);
    }
    
    // ウィジェット更新通知
    this.notifyWidgets(name, metric);
    
    // アラートチェック
    if (this.options.alertingEnabled) {
      this.checkAlerts(metric);
    }
  }
  
  /**
   * 一括メトリクス記録
   */
  recordMetrics(metrics) {
    const timestamp = Date.now();
    
    for (const metric of metrics) {
      this.recordMetric(
        metric.name,
        metric.value,
        metric.type || MetricTypes.GAUGE,
        metric.tags || {}
      );
    }
    
    logger.debug('一括メトリクス記録', {
      count: metrics.length,
      timestamp
    });
  }
  
  /**
   * ウィジェットデータ取得
   */
  async getWidgetData(widgetId, options = {}) {
    const widget = this.widgets.get(widgetId);
    if (!widget) {
      throw new Error(`ウィジェットが見つかりません: ${widgetId}`);
    }
    
    // キャッシュチェック
    if (this.options.enableCaching) {
      const cached = this.getCachedData(widgetId, options);
      if (cached) {
        this.stats.cacheHits++;
        return cached;
      }
      this.stats.cacheMisses++;
    }
    
    try {
      let data = null;
      
      switch (widget.type) {
        case 'line_chart':
          data = await this.getTimeSeriesData(widget, options);
          break;
          
        case 'gauge_cluster':
          data = await this.getGaugeData(widget, options);
          break;
          
        case 'statistics':
          data = await this.getStatisticsData(widget, options);
          break;
          
        case 'heatmap':
          data = await this.getHeatmapData(widget, options);
          break;
          
        case 'insights':
          data = await this.getInsightsData(widget, options);
          break;
          
        case 'calculator':
          data = await this.getCalculatorData(widget, options);
          break;
          
        case 'market_widget':
          data = await this.getMarketData(widget, options);
          break;
          
        case 'feed':
          data = await this.getFeedData(widget, options);
          break;
          
        default:
          // カスタムウィジェット処理
          if (widget.dataHandler) {
            data = await widget.dataHandler(this, widget, options);
          }
      }
      
      // キャッシュ保存
      if (this.options.enableCaching && data) {
        this.setCachedData(widgetId, options, data);
      }
      
      return data;
      
    } catch (error) {
      logger.error('ウィジェットデータ取得エラー', {
        widgetId,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * 時系列データ取得
   */
  async getTimeSeriesData(widget, options) {
    const timeRange = options.timeRange || widget.displayOptions.timeRange;
    const aggregation = options.aggregation || widget.displayOptions.aggregation;
    
    // データソース解決
    const dataSource = this.resolveDataSource(widget.dataSource);
    const series = [];
    
    for (const source of dataSource) {
      const data = this.timeSeries.get(source) || [];
      const filtered = this.filterByTimeRange(data, timeRange);
      const aggregated = this.aggregateData(filtered, aggregation, options.interval);
      
      series.push({
        name: source,
        data: aggregated,
        stats: this.calculateStatistics(aggregated)
      });
    }
    
    // トレンド分析
    if (widget.displayOptions.showTrend) {
      for (const s of series) {
        s.trend = this.calculateTrend(s.data);
      }
    }
    
    return {
      series,
      timeRange,
      aggregation,
      lastUpdate: Date.now()
    };
  }
  
  /**
   * 統計データ取得
   */
  async getStatisticsData(widget, options) {
    const dataSource = this.resolveDataSource(widget.dataSource);
    const stats = {};
    
    for (const source of dataSource) {
      const data = this.timeSeries.get(source) || [];
      const recent = this.filterByTimeRange(data, '1h');
      
      stats[source] = {
        current: this.metrics.get(source)?.value || 0,
        avg: this.calculateAverage(recent),
        min: this.calculateMin(recent),
        max: this.calculateMax(recent),
        sum: this.calculateSum(recent),
        count: recent.length,
        stdDev: this.calculateStdDev(recent),
        percentiles: {
          p50: this.calculatePercentile(recent, 50),
          p95: this.calculatePercentile(recent, 95),
          p99: this.calculatePercentile(recent, 99)
        }
      };
    }
    
    return {
      stats,
      timestamp: Date.now()
    };
  }
  
  /**
   * リアルタイムストリーム購読
   */
  subscribeToWidget(clientId, widgetId, options = {}) {
    const client = this.wsClients.get(clientId);
    if (!client) {
      throw new Error('クライアントが見つかりません');
    }
    
    const widget = this.widgets.get(widgetId);
    if (!widget) {
      throw new Error('ウィジェットが見つかりません');
    }
    
    // 購読登録
    if (!this.widgetSubscriptions.has(widgetId)) {
      this.widgetSubscriptions.set(widgetId, new Set());
    }
    
    this.widgetSubscriptions.get(widgetId).add(clientId);
    client.subscriptions.add(widgetId);
    
    // 初期データ送信
    this.getWidgetData(widgetId, options).then(data => {
      this.sendToClient(clientId, {
        type: 'widget_data',
        widgetId,
        data
      });
    });
    
    logger.info('ウィジェット購読登録', { clientId, widgetId });
  }
  
  /**
   * カスタムアラート作成
   */
  createAlert(rule) {
    const alert = {
      id: crypto.randomUUID(),
      name: rule.name,
      condition: rule.condition,
      threshold: rule.threshold,
      action: rule.action,
      enabled: rule.enabled !== false,
      cooldown: rule.cooldown || 300000, // 5分
      lastTriggered: 0,
      triggerCount: 0
    };
    
    this.options.alertRules.push(alert);
    
    logger.info('アラート作成', {
      id: alert.id,
      name: alert.name
    });
    
    this.emit('alert:created', alert);
    
    return alert;
  }
  
  /**
   * データエクスポート
   */
  async exportData(widgetId, format, options = {}) {
    const data = await this.getWidgetData(widgetId, options);
    
    switch (format) {
      case 'json':
        return JSON.stringify(data, null, 2);
        
      case 'csv':
        return this.convertToCSV(data);
        
      case 'excel':
        return this.convertToExcel(data);
        
      case 'pdf':
        return this.generatePDFReport(widgetId, data, options);
        
      default:
        throw new Error(`未対応のフォーマット: ${format}`);
    }
  }
  
  /**
   * レイアウト保存
   */
  saveLayout(name, layout) {
    this.layouts.set(name, {
      id: crypto.randomUUID(),
      name,
      layout,
      created: Date.now(),
      modified: Date.now()
    });
    
    logger.info('レイアウト保存', { name });
    
    this.emit('layout:saved', { name });
  }
  
  /**
   * パフォーマンス分析
   */
  analyzePerformance(timeRange = '24h') {
    const analysis = {
      hashrate: {
        average: 0,
        peak: 0,
        stability: 0,
        trend: 'stable'
      },
      
      efficiency: {
        powerEfficiency: 0,
        rejectRate: 0,
        uptimePercent: 0,
        costPerHash: 0
      },
      
      profitability: {
        currentRate: 0,
        dailyProjection: 0,
        monthlyProjection: 0,
        breakEvenDays: 0
      },
      
      optimization: {
        potentialGains: 0,
        recommendedSettings: {},
        bottlenecks: []
      }
    };
    
    // ハッシュレート分析
    const hashrateData = this.filterByTimeRange(
      this.timeSeries.get('mining.hashrate') || [],
      timeRange
    );
    
    if (hashrateData.length > 0) {
      analysis.hashrate.average = this.calculateAverage(hashrateData);
      analysis.hashrate.peak = this.calculateMax(hashrateData);
      analysis.hashrate.stability = this.calculateStability(hashrateData);
      analysis.hashrate.trend = this.calculateTrend(hashrateData);
    }
    
    // 効率分析
    const powerData = this.timeSeries.get('hardware.power') || [];
    const sharesData = this.timeSeries.get('pool.shares') || [];
    
    if (powerData.length > 0 && hashrateData.length > 0) {
      const avgPower = this.calculateAverage(powerData);
      analysis.efficiency.powerEfficiency = analysis.hashrate.average / avgPower;
    }
    
    // 収益性分析
    const priceData = this.metrics.get('market.price')?.value || 0;
    const difficultyData = this.metrics.get('network.difficulty')?.value || 1;
    
    analysis.profitability.currentRate = this.calculateProfitRate(
      analysis.hashrate.average,
      priceData,
      difficultyData
    );
    
    analysis.profitability.dailyProjection = analysis.profitability.currentRate * 24;
    analysis.profitability.monthlyProjection = analysis.profitability.dailyProjection * 30;
    
    return analysis;
  }
  
  /**
   * ダッシュボード統計取得
   */
  getStatistics() {
    return {
      metrics: {
        total: this.metrics.size,
        dataPoints: this.stats.dataPointsReceived,
        timeSeries: this.timeSeries.size
      },
      
      connections: {
        websocket: this.wsClients.size,
        subscriptions: this.widgetSubscriptions.size,
        activeWidgets: this.stats.widgetsActive
      },
      
      performance: {
        cacheHitRate: this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses) * 100,
        dataRetention: `${(this.options.dataRetention / 86400000).toFixed(0)} days`,
        aggregationInterval: `${this.options.aggregationInterval / 1000}s`
      },
      
      alerts: {
        active: this.activeAlerts.size,
        total: this.stats.alertsTriggered,
        rules: this.options.alertRules.length
      }
    };
  }
  
  /**
   * シャットダウン
   */
  async shutdown() {
    logger.info('ダッシュボードシャットダウン中');
    
    // タイマー停止
    if (this.aggregationTimer) clearInterval(this.aggregationTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    
    // WebSocket接続を閉じる
    for (const [clientId, client] of this.wsClients) {
      client.ws.close(1000, 'Server shutting down');
    }
    
    // WebSocketサーバー停止
    if (this.wsServer) {
      this.wsServer.close();
    }
    
    logger.info('ダッシュボードシャットダウン完了');
  }
  
  // ユーティリティメソッド
  
  async setupHTTPServer() {
    // HTTPサーバー設定（Express等）
    logger.info('HTTPサーバー設定完了', { port: this.options.port });
  }
  
  async setupWebSocketServer() {
    this.wsServer = new WebSocket.Server({
      port: this.options.wsPort
    });
    
    this.wsServer.on('connection', (ws, request) => {
      this.handleWebSocketConnection(ws, request);
    });
    
    logger.info('WebSocketサーバー起動', { port: this.options.wsPort });
  }
  
  handleWebSocketConnection(ws, request) {
    const clientId = crypto.randomUUID();
    
    const client = {
      id: clientId,
      ws,
      subscriptions: new Set(),
      lastActivity: Date.now()
    };
    
    this.wsClients.set(clientId, client);
    this.stats.clientsConnected++;
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        this.handleWebSocketMessage(clientId, message);
      } catch (error) {
        logger.error('WebSocketメッセージエラー', {
          clientId,
          error: error.message
        });
      }
    });
    
    ws.on('close', () => {
      this.handleWebSocketDisconnection(clientId);
    });
    
    // 初期メッセージ
    this.sendToClient(clientId, {
      type: 'connected',
      clientId,
      widgets: Array.from(this.widgets.keys())
    });
  }
  
  handleWebSocketMessage(clientId, message) {
    const client = this.wsClients.get(clientId);
    if (!client) return;
    
    client.lastActivity = Date.now();
    
    switch (message.type) {
      case 'subscribe':
        this.subscribeToWidget(clientId, message.widgetId, message.options);
        break;
        
      case 'unsubscribe':
        this.unsubscribeFromWidget(clientId, message.widgetId);
        break;
        
      case 'get_data':
        this.handleGetData(clientId, message.widgetId, message.options);
        break;
        
      case 'create_alert':
        this.createAlert(message.rule);
        break;
        
      case 'export':
        this.handleExport(clientId, message.widgetId, message.format, message.options);
        break;
    }
  }
  
  handleWebSocketDisconnection(clientId) {
    const client = this.wsClients.get(clientId);
    if (!client) return;
    
    // 購読解除
    for (const widgetId of client.subscriptions) {
      const subs = this.widgetSubscriptions.get(widgetId);
      if (subs) {
        subs.delete(clientId);
      }
    }
    
    this.wsClients.delete(clientId);
    this.stats.clientsConnected--;
  }
  
  registerDefaultWidgets() {
    for (const [key, config] of Object.entries(DashboardWidgets)) {
      this.widgets.set(config.id, config);
    }
  }
  
  registerWidget(widget) {
    this.widgets.set(widget.id, widget);
    logger.info('ウィジェット登録', { id: widget.id, name: widget.name });
  }
  
  async initializePlugins() {
    for (const plugin of this.options.plugins) {
      try {
        await plugin.initialize(this);
        logger.info('プラグイン初期化', { name: plugin.name });
      } catch (error) {
        logger.error('プラグイン初期化エラー', {
          name: plugin.name,
          error: error.message
        });
      }
    }
  }
  
  setupDefaultLayout() {
    const defaultLayout = {
      type: this.options.defaultLayout,
      widgets: [
        { id: 'hashrate_chart', position: { x: 0, y: 0, w: 6, h: 4 } },
        { id: 'profit_calculator', position: { x: 6, y: 0, w: 6, h: 4 } },
        { id: 'hardware_monitor', position: { x: 0, y: 4, w: 4, h: 3 } },
        { id: 'market_overview', position: { x: 4, y: 4, w: 4, h: 3 } },
        { id: 'alert_feed', position: { x: 8, y: 4, w: 4, h: 3 } }
      ]
    };
    
    this.saveLayout('default', defaultLayout);
    this.activeLayout = 'default';
  }
  
  startAggregation() {
    this.aggregationTimer = setInterval(() => {
      this.performAggregation();
    }, this.options.aggregationInterval);
  }
  
  startCleanup() {
    this.cleanupTimer = setInterval(() => {
      this.performCleanup();
    }, 3600000); // 1時間ごと
  }
  
  performAggregation() {
    for (const [name, series] of this.timeSeries) {
      const recent = series.filter(d => 
        Date.now() - d.timestamp < this.options.aggregationInterval
      );
      
      if (recent.length > 0) {
        const aggregated = {
          name: `${name}_aggregated`,
          timestamp: Date.now(),
          avg: this.calculateAverage(recent),
          min: this.calculateMin(recent),
          max: this.calculateMax(recent),
          count: recent.length
        };
        
        this.aggregations.set(name, aggregated);
      }
    }
  }
  
  performCleanup() {
    const cutoff = Date.now() - this.options.dataRetention;
    
    for (const [name, series] of this.timeSeries) {
      const filtered = series.filter(d => d.timestamp > cutoff);
      if (filtered.length < series.length) {
        this.timeSeries.set(name, filtered);
        logger.debug('データクリーンアップ', {
          metric: name,
          removed: series.length - filtered.length
        });
      }
    }
  }
  
  broadcastMetric(metric) {
    const message = JSON.stringify({
      type: 'metric_update',
      metric
    });
    
    for (const [_, client] of this.wsClients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  }
  
  notifyWidgets(metricName, metric) {
    for (const [widgetId, widget] of this.widgets) {
      const sources = this.resolveDataSource(widget.dataSource);
      
      if (sources.includes(metricName) || sources.some(s => metricName.match(s))) {
        const subscribers = this.widgetSubscriptions.get(widgetId);
        
        if (subscribers && subscribers.size > 0) {
          this.getWidgetData(widgetId).then(data => {
            const message = JSON.stringify({
              type: 'widget_update',
              widgetId,
              data
            });
            
            for (const clientId of subscribers) {
              const client = this.wsClients.get(clientId);
              if (client && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(message);
              }
            }
          });
        }
      }
    }
  }
  
  checkAlerts(metric) {
    for (const rule of this.options.alertRules) {
      if (!rule.enabled) continue;
      
      if (this.evaluateAlertCondition(rule, metric)) {
        if (Date.now() - rule.lastTriggered > rule.cooldown) {
          this.triggerAlert(rule, metric);
        }
      }
    }
  }
  
  evaluateAlertCondition(rule, metric) {
    // アラート条件評価（実装省略）
    return false;
  }
  
  triggerAlert(rule, metric) {
    const alert = {
      id: crypto.randomUUID(),
      ruleId: rule.id,
      name: rule.name,
      metric: metric.name,
      value: metric.value,
      threshold: rule.threshold,
      timestamp: Date.now()
    };
    
    this.activeAlerts.set(alert.id, alert);
    this.alertHistory.push(alert);
    this.stats.alertsTriggered++;
    
    rule.lastTriggered = Date.now();
    rule.triggerCount++;
    
    // アクション実行
    if (rule.action) {
      this.executeAlertAction(rule.action, alert);
    }
    
    // 通知
    this.emit('alert:triggered', alert);
    
    // WebSocket通知
    this.broadcastAlert(alert);
  }
  
  executeAlertAction(action, alert) {
    // アラートアクション実行（実装省略）
  }
  
  broadcastAlert(alert) {
    const message = JSON.stringify({
      type: 'alert',
      alert
    });
    
    for (const [_, client] of this.wsClients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  }
  
  getCachedData(widgetId, options) {
    const key = `${widgetId}:${JSON.stringify(options)}`;
    const cached = this.cache.get(key);
    
    if (cached) {
      const timestamp = this.cacheTimestamps.get(key);
      if (Date.now() - timestamp < this.options.cacheExpiry) {
        return cached;
      }
    }
    
    return null;
  }
  
  setCachedData(widgetId, options, data) {
    const key = `${widgetId}:${JSON.stringify(options)}`;
    this.cache.set(key, data);
    this.cacheTimestamps.set(key, Date.now());
  }
  
  resolveDataSource(source) {
    if (Array.isArray(source)) {
      return source;
    }
    
    if (source.includes('*')) {
      // ワイルドカード展開
      const pattern = source.replace('*', '.*');
      const regex = new RegExp(`^${pattern}$`);
      return Array.from(this.metrics.keys()).filter(key => regex.test(key));
    }
    
    return [source];
  }
  
  filterByTimeRange(data, timeRange) {
    const now = Date.now();
    let cutoff;
    
    switch (timeRange) {
      case '1h':
        cutoff = now - 3600000;
        break;
      case '6h':
        cutoff = now - 21600000;
        break;
      case '24h':
        cutoff = now - 86400000;
        break;
      case '7d':
        cutoff = now - 604800000;
        break;
      case '30d':
        cutoff = now - 2592000000;
        break;
      default:
        cutoff = 0;
    }
    
    return data.filter(d => d.timestamp > cutoff);
  }
  
  aggregateData(data, method, interval) {
    if (!interval) {
      return data;
    }
    
    const buckets = new Map();
    
    for (const point of data) {
      const bucket = Math.floor(point.timestamp / interval) * interval;
      
      if (!buckets.has(bucket)) {
        buckets.set(bucket, []);
      }
      
      buckets.get(bucket).push(point);
    }
    
    const aggregated = [];
    
    for (const [timestamp, points] of buckets) {
      let value;
      
      switch (method) {
        case 'sum':
          value = this.calculateSum(points);
          break;
        case 'avg':
          value = this.calculateAverage(points);
          break;
        case 'min':
          value = this.calculateMin(points);
          break;
        case 'max':
          value = this.calculateMax(points);
          break;
        case 'count':
          value = points.length;
          break;
        default:
          value = this.calculateAverage(points);
      }
      
      aggregated.push({ timestamp, value });
    }
    
    return aggregated.sort((a, b) => a.timestamp - b.timestamp);
  }
  
  calculateStatistics(data) {
    if (data.length === 0) {
      return {
        avg: 0,
        min: 0,
        max: 0,
        sum: 0,
        count: 0,
        stdDev: 0
      };
    }
    
    return {
      avg: this.calculateAverage(data),
      min: this.calculateMin(data),
      max: this.calculateMax(data),
      sum: this.calculateSum(data),
      count: data.length,
      stdDev: this.calculateStdDev(data)
    };
  }
  
  calculateAverage(data) {
    if (data.length === 0) return 0;
    const sum = data.reduce((acc, d) => acc + (d.value || d), 0);
    return sum / data.length;
  }
  
  calculateMin(data) {
    if (data.length === 0) return 0;
    return Math.min(...data.map(d => d.value || d));
  }
  
  calculateMax(data) {
    if (data.length === 0) return 0;
    return Math.max(...data.map(d => d.value || d));
  }
  
  calculateSum(data) {
    return data.reduce((acc, d) => acc + (d.value || d), 0);
  }
  
  calculateStdDev(data) {
    if (data.length === 0) return 0;
    const avg = this.calculateAverage(data);
    const squareDiffs = data.map(d => Math.pow((d.value || d) - avg, 2));
    const avgSquareDiff = squareDiffs.reduce((acc, d) => acc + d, 0) / data.length;
    return Math.sqrt(avgSquareDiff);
  }
  
  calculatePercentile(data, percentile) {
    if (data.length === 0) return 0;
    const sorted = data.map(d => d.value || d).sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[index];
  }
  
  calculateTrend(data) {
    if (data.length < 2) return 'stable';
    
    // 簡単な線形回帰
    const n = data.length;
    const sumX = data.reduce((acc, _, i) => acc + i, 0);
    const sumY = data.reduce((acc, d) => acc + (d.value || d), 0);
    const sumXY = data.reduce((acc, d, i) => acc + i * (d.value || d), 0);
    const sumXX = data.reduce((acc, _, i) => acc + i * i, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    
    if (slope > 0.01) return 'up';
    if (slope < -0.01) return 'down';
    return 'stable';
  }
  
  calculateStability(data) {
    if (data.length === 0) return 0;
    const stdDev = this.calculateStdDev(data);
    const avg = this.calculateAverage(data);
    return avg > 0 ? 1 - (stdDev / avg) : 0;
  }
  
  calculateProfitRate(hashrate, price, difficulty) {
    // 収益率計算（簡略版）
    const blockReward = 2; // ETH
    const blocksPerDay = 6646; // 約13秒/ブロック
    const networkHashrate = difficulty / 13.5;
    const minerShare = hashrate / networkHashrate;
    
    return minerShare * blockReward * blocksPerDay * price;
  }
  
  async getGaugeData(widget, options) {
    // ゲージデータ取得（実装省略）
    return {};
  }
  
  async getHeatmapData(widget, options) {
    // ヒートマップデータ取得（実装省略）
    return {};
  }
  
  async getInsightsData(widget, options) {
    // インサイトデータ取得（実装省略）
    return {};
  }
  
  async getCalculatorData(widget, options) {
    // 計算機データ取得（実装省略）
    return {};
  }
  
  async getMarketData(widget, options) {
    // 市場データ取得（実装省略）
    return {};
  }
  
  async getFeedData(widget, options) {
    // フィードデータ取得（実装省略）
    return this.alertHistory.slice(-50);
  }
  
  sendToClient(clientId, data) {
    const client = this.wsClients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(data));
    }
  }
  
  unsubscribeFromWidget(clientId, widgetId) {
    const client = this.wsClients.get(clientId);
    if (!client) return;
    
    client.subscriptions.delete(widgetId);
    
    const subs = this.widgetSubscriptions.get(widgetId);
    if (subs) {
      subs.delete(clientId);
    }
  }
  
  async handleGetData(clientId, widgetId, options) {
    try {
      const data = await this.getWidgetData(widgetId, options);
      this.sendToClient(clientId, {
        type: 'widget_data',
        widgetId,
        data
      });
    } catch (error) {
      this.sendToClient(clientId, {
        type: 'error',
        widgetId,
        error: error.message
      });
    }
  }
  
  async handleExport(clientId, widgetId, format, options) {
    try {
      const data = await this.exportData(widgetId, format, options);
      this.sendToClient(clientId, {
        type: 'export_data',
        widgetId,
        format,
        data
      });
    } catch (error) {
      this.sendToClient(clientId, {
        type: 'error',
        widgetId,
        error: error.message
      });
    }
  }
  
  convertToCSV(data) {
    // CSV変換（実装省略）
    return '';
  }
  
  convertToExcel(data) {
    // Excel変換（実装省略）
    return Buffer.from('');
  }
  
  generatePDFReport(widgetId, data, options) {
    // PDFレポート生成（実装省略）
    return Buffer.from('');
  }
}

export default RealtimeAnalyticsDashboard;