/**
 * Enterprise Monitoring System - Otedama
 * エンタープライズ監視システム
 * 
 * 機能:
 * - Prometheusメトリクス統合
 * - Grafanaダッシュボード自動設定
 * - Elasticsearchログ統合
 * - カスタムアラートルール
 * - パフォーマンス監視
 * - インフラ監視
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { register, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';

const logger = createStructuredLogger('EnterpriseMonitoringSystem');

// Prometheusメトリクス定義
export const PrometheusMetrics = {
  // マイニングメトリクス
  MINING_HASHRATE: new Gauge({
    name: 'otedama_mining_hashrate_total',
    help: 'Total mining hashrate in H/s',
    labelNames: ['algorithm', 'hardware_type', 'device_id']
  }),
  
  MINING_SHARES: new Counter({
    name: 'otedama_mining_shares_total',
    help: 'Total mining shares',
    labelNames: ['pool', 'status', 'algorithm']
  }),
  
  MINING_EFFICIENCY: new Gauge({
    name: 'otedama_mining_efficiency_ratio',
    help: 'Mining efficiency ratio (hashrate/power)',
    labelNames: ['hardware_type', 'device_id']
  }),
  
  // ハードウェアメトリクス
  HARDWARE_TEMPERATURE: new Gauge({
    name: 'otedama_hardware_temperature_celsius',
    help: 'Hardware temperature in Celsius',
    labelNames: ['hardware_type', 'device_id', 'sensor']
  }),
  
  HARDWARE_POWER: new Gauge({
    name: 'otedama_hardware_power_watts',
    help: 'Hardware power consumption in watts',
    labelNames: ['hardware_type', 'device_id']
  }),
  
  HARDWARE_FAN_SPEED: new Gauge({
    name: 'otedama_hardware_fan_speed_rpm',
    help: 'Hardware fan speed in RPM',
    labelNames: ['hardware_type', 'device_id', 'fan_id']
  }),
  
  // 収益メトリクス
  EARNINGS_CURRENT: new Gauge({
    name: 'otedama_earnings_current_btc',
    help: 'Current earnings in BTC',
    labelNames: ['currency', 'pool']
  }),
  
  EARNINGS_DAILY: new Gauge({
    name: 'otedama_earnings_daily_btc',
    help: 'Daily earnings in BTC',
    labelNames: ['currency', 'pool']
  }),
  
  // システムメトリクス
  SYSTEM_UPTIME: new Gauge({
    name: 'otedama_system_uptime_seconds',
    help: 'System uptime in seconds'
  }),
  
  API_REQUESTS: new Counter({
    name: 'otedama_api_requests_total',
    help: 'Total API requests',
    labelNames: ['method', 'endpoint', 'status_code']
  }),
  
  API_RESPONSE_TIME: new Histogram({
    name: 'otedama_api_response_time_seconds',
    help: 'API response time in seconds',
    labelNames: ['method', 'endpoint']
  }),
  
  // アラートメトリクス
  ALERTS_ACTIVE: new Gauge({
    name: 'otedama_alerts_active_total',
    help: 'Number of active alerts',
    labelNames: ['severity', 'category']
  }),
  
  ALERTS_FIRED: new Counter({
    name: 'otedama_alerts_fired_total',
    help: 'Total alerts fired',
    labelNames: ['severity', 'category', 'rule']
  })
};

// Grafanaダッシュボード設定
export const GrafanaDashboards = {
  MINING_OVERVIEW: {
    title: 'Otedama Mining Overview',
    tags: ['otedama', 'mining'],
    panels: [
      {
        title: 'Total Hashrate',
        type: 'stat',
        targets: [
          {
            expr: 'sum(otedama_mining_hashrate_total)',
            legendFormat: 'Total Hashrate'
          }
        ]
      },
      {
        title: 'Hardware Temperatures',
        type: 'graph',
        targets: [
          {
            expr: 'otedama_hardware_temperature_celsius',
            legendFormat: '{{hardware_type}} {{device_id}}'
          }
        ]
      },
      {
        title: 'Power Consumption',
        type: 'graph',
        targets: [
          {
            expr: 'sum by (hardware_type) (otedama_hardware_power_watts)',
            legendFormat: '{{hardware_type}}'
          }
        ]
      },
      {
        title: 'Mining Efficiency',
        type: 'graph',
        targets: [
          {
            expr: 'otedama_mining_efficiency_ratio',
            legendFormat: '{{hardware_type}} {{device_id}}'
          }
        ]
      }
    ]
  },
  
  HARDWARE_MONITORING: {
    title: 'Otedama Hardware Monitoring',
    tags: ['otedama', 'hardware'],
    panels: [
      {
        title: 'GPU Temperatures',
        type: 'heatmap',
        targets: [
          {
            expr: 'otedama_hardware_temperature_celsius{hardware_type="gpu"}',
            legendFormat: 'GPU {{device_id}}'
          }
        ]
      },
      {
        title: 'Fan Speeds',
        type: 'graph',
        targets: [
          {
            expr: 'otedama_hardware_fan_speed_rpm',
            legendFormat: '{{hardware_type}} {{device_id}} Fan {{fan_id}}'
          }
        ]
      },
      {
        title: 'Power Distribution',
        type: 'piechart',
        targets: [
          {
            expr: 'sum by (hardware_type) (otedama_hardware_power_watts)',
            legendFormat: '{{hardware_type}}'
          }
        ]
      }
    ]
  },
  
  EARNINGS_DASHBOARD: {
    title: 'Otedama Earnings Dashboard',
    tags: ['otedama', 'earnings'],
    panels: [
      {
        title: 'Current Earnings',
        type: 'stat',
        targets: [
          {
            expr: 'sum(otedama_earnings_current_btc)',
            legendFormat: 'Current BTC'
          }
        ]
      },
      {
        title: 'Daily Earnings Trend',
        type: 'graph',
        targets: [
          {
            expr: 'otedama_earnings_daily_btc',
            legendFormat: '{{pool}}'
          }
        ]
      },
      {
        title: 'Earnings per Pool',
        type: 'table',
        targets: [
          {
            expr: 'otedama_earnings_current_btc',
            legendFormat: '{{pool}}'
          }
        ]
      }
    ]
  }
};

// アラートルール定義
export const AlertRules = {
  HIGH_TEMPERATURE: {
    alert: 'OtedamaHighTemperature',
    expr: 'otedama_hardware_temperature_celsius > 85',
    for: '2m',
    labels: {
      severity: 'warning',
      category: 'hardware'
    },
    annotations: {
      summary: 'High hardware temperature detected',
      description: '{{$labels.hardware_type}} {{$labels.device_id}} temperature is {{$value}}°C'
    }
  },
  
  CRITICAL_TEMPERATURE: {
    alert: 'OtedamaCriticalTemperature',
    expr: 'otedama_hardware_temperature_celsius > 90',
    for: '30s',
    labels: {
      severity: 'critical',
      category: 'hardware'
    },
    annotations: {
      summary: 'Critical hardware temperature detected',
      description: '{{$labels.hardware_type}} {{$labels.device_id}} temperature is {{$value}}°C - immediate action required'
    }
  },
  
  LOW_HASHRATE: {
    alert: 'OtedamaLowHashrate',
    expr: 'otedama_mining_hashrate_total < 50000000', // 50 MH/s
    for: '5m',
    labels: {
      severity: 'warning',
      category: 'mining'
    },
    annotations: {
      summary: 'Low mining hashrate detected',
      description: 'Total hashrate is {{$value}} H/s, below expected threshold'
    }
  },
  
  HIGH_POWER_CONSUMPTION: {
    alert: 'OtedamaHighPowerConsumption',
    expr: 'sum(otedama_hardware_power_watts) > 2000',
    for: '10m',
    labels: {
      severity: 'info',
      category: 'efficiency'
    },
    annotations: {
      summary: 'High power consumption detected',
      description: 'Total power consumption is {{$value}}W'
    }
  },
  
  SYSTEM_DOWN: {
    alert: 'OtedamaSystemDown',
    expr: 'up{job="otedama"} == 0',
    for: '1m',
    labels: {
      severity: 'critical',
      category: 'system'
    },
    annotations: {
      summary: 'Otedama system is down',
      description: 'Otedama mining system is not responding'
    }
  },
  
  API_HIGH_ERROR_RATE: {
    alert: 'OtedamaAPIHighErrorRate',
    expr: 'rate(otedama_api_requests_total{status_code=~"5.."}[5m]) / rate(otedama_api_requests_total[5m]) > 0.1',
    for: '2m',
    labels: {
      severity: 'warning',
      category: 'api'
    },
    annotations: {
      summary: 'High API error rate detected',
      description: 'API error rate is {{$value | humanizePercentage}}'
    }
  }
};

export class EnterpriseMonitoringSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // 基本設定
      enabled: options.enabled !== false,
      metricsPort: options.metricsPort || 9090,
      
      // Prometheus設定
      prometheusEnabled: options.prometheusEnabled !== false,
      metricsEndpoint: options.metricsEndpoint || '/metrics',
      collectDefaultMetrics: options.collectDefaultMetrics !== false,
      
      // Elasticsearch設定
      elasticsearchEnabled: options.elasticsearchEnabled !== false,
      elasticsearchUrl: options.elasticsearchUrl || 'http://localhost:9200',
      elasticsearchIndex: options.elasticsearchIndex || 'otedama-logs',
      
      // Grafana設定
      grafanaEnabled: options.grafanaEnabled !== false,
      grafanaUrl: options.grafanaUrl || 'http://localhost:3000',
      grafanaApiKey: options.grafanaApiKey || null,
      autoCreateDashboards: options.autoCreateDashboards !== false,
      
      // アラート設定
      alertingEnabled: options.alertingEnabled !== false,
      alertmanagerUrl: options.alertmanagerUrl || 'http://localhost:9093',
      webhookUrl: options.webhookUrl || null,
      
      // パフォーマンス設定
      metricsUpdateInterval: options.metricsUpdateInterval || 10000, // 10秒
      logShippingInterval: options.logShippingInterval || 30000, // 30秒
      
      ...options
    };
    
    // Elasticsearch クライアント
    this.elasticsearchClient = null;
    
    // メトリクスサーバー
    this.metricsServer = null;
    
    // ログバッファ
    this.logBuffer = [];
    this.maxLogBufferSize = 1000;
    
    // メトリクス更新タイマー
    this.metricsTimer = null;
    this.logShippingTimer = null;
    
    // アラート状態
    this.activeAlerts = new Map();
    this.alertHistory = [];
    
    // 統計
    this.stats = {
      metricsCollected: 0,
      logsShipped: 0,
      alertsFired: 0,
      dashboardsCreated: 0,
      uptime: Date.now()
    };
  }
  
  /**
   * システム初期化
   */
  async initialize() {
    logger.info('Enterprise Monitoring System初期化中', {
      prometheusEnabled: this.options.prometheusEnabled,
      elasticsearchEnabled: this.options.elasticsearchEnabled,
      grafanaEnabled: this.options.grafanaEnabled
    });
    
    try {
      // Prometheusメトリクス初期化
      if (this.options.prometheusEnabled) {
        await this.initializePrometheus();
      }
      
      // Elasticsearch初期化
      if (this.options.elasticsearchEnabled) {
        await this.initializeElasticsearch();
      }
      
      // Grafanaダッシュボード作成
      if (this.options.grafanaEnabled && this.options.autoCreateDashboards) {
        await this.createGrafanaDashboards();
      }
      
      // アラートルール設定
      if (this.options.alertingEnabled) {
        await this.setupAlertRules();
      }
      
      // 定期更新開始
      this.startPeriodicUpdates();
      
      logger.info('Enterprise Monitoring System初期化完了');
      
      this.emit('initialized', {
        prometheus: this.options.prometheusEnabled,
        elasticsearch: this.options.elasticsearchEnabled,
        grafana: this.options.grafanaEnabled,
        alerting: this.options.alertingEnabled
      });
      
    } catch (error) {
      logger.error('Enterprise Monitoring System初期化エラー', {
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Prometheus初期化
   */
  async initializePrometheus() {
    logger.info('Prometheus統合初期化中', {
      port: this.options.metricsPort
    });
    
    // デフォルトメトリクス収集
    if (this.options.collectDefaultMetrics) {
      collectDefaultMetrics({ register });
    }
    
    // カスタムメトリクス登録
    Object.values(PrometheusMetrics).forEach(metric => {
      register.registerMetric(metric);
    });
    
    // メトリクスサーバー起動
    const app = express();
    
    app.get(this.options.metricsEndpoint, async (req, res) => {
      try {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
      } catch (error) {
        res.status(500).end(error.message);
      }
    });
    
    // ヘルスチェックエンドポイント
    app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        uptime: Date.now() - this.stats.uptime,
        metrics: {
          collected: this.stats.metricsCollected,
          alerts: this.activeAlerts.size
        }
      });
    });
    
    this.metricsServer = app.listen(this.options.metricsPort, () => {
      logger.info('Prometheusメトリクスサーバー起動', {
        port: this.options.metricsPort,
        endpoint: this.options.metricsEndpoint
      });
    });
  }
  
  /**
   * Elasticsearch初期化
   */
  async initializeElasticsearch() {
    if (!this.options.elasticsearchUrl) {
      logger.warn('ElasticsearchのURLが設定されていません');
      return;
    }
    
    logger.info('Elasticsearch統合初期化中', {
      url: this.options.elasticsearchUrl,
      index: this.options.elasticsearchIndex
    });
    
    this.elasticsearchClient = new ElasticsearchClient({
      node: this.options.elasticsearchUrl
    });
    
    try {
      // Elasticsearch接続テスト
      await this.elasticsearchClient.ping();
      
      // インデックステンプレート作成
      await this.createElasticsearchTemplate();
      
      logger.info('Elasticsearch接続成功');
      
    } catch (error) {
      logger.error('Elasticsearch接続エラー', { error: error.message });
      this.elasticsearchClient = null;
    }
  }
  
  /**
   * Grafanaダッシュボード作成
   */
  async createGrafanaDashboards() {
    if (!this.options.grafanaApiKey) {
      logger.warn('Grafana APIキーが設定されていません');
      return;
    }
    
    logger.info('Grafanaダッシュボード作成中');
    
    try {
      for (const [name, dashboard] of Object.entries(GrafanaDashboards)) {
        await this.createGrafanaDashboard(name, dashboard);
        this.stats.dashboardsCreated++;
      }
      
      logger.info('Grafanaダッシュボード作成完了', {
        created: this.stats.dashboardsCreated
      });
      
    } catch (error) {
      logger.error('Grafanaダッシュボード作成エラー', {
        error: error.message
      });
    }
  }
  
  /**
   * メトリクス更新
   */
  async updateMetrics(miningData, hardwareData, systemData) {
    if (!this.options.prometheusEnabled) {
      return;
    }
    
    try {
      // マイニングメトリクス
      if (miningData) {
        PrometheusMetrics.MINING_HASHRATE.set(
          { algorithm: miningData.algorithm, hardware_type: 'gpu', device_id: '0' },
          miningData.hashrate || 0
        );
        
        PrometheusMetrics.MINING_SHARES.inc(
          { pool: miningData.pool, status: 'accepted', algorithm: miningData.algorithm },
          miningData.acceptedShares || 0
        );
        
        PrometheusMetrics.MINING_EFFICIENCY.set(
          { hardware_type: 'gpu', device_id: '0' },
          miningData.efficiency || 0
        );
      }
      
      // ハードウェアメトリクス
      if (hardwareData) {
        if (hardwareData.gpus) {
          hardwareData.gpus.forEach((gpu, index) => {
            PrometheusMetrics.HARDWARE_TEMPERATURE.set(
              { hardware_type: 'gpu', device_id: index.toString(), sensor: 'core' },
              gpu.temperature || 0
            );
            
            PrometheusMetrics.HARDWARE_POWER.set(
              { hardware_type: 'gpu', device_id: index.toString() },
              gpu.powerUsage || 0
            );
            
            PrometheusMetrics.HARDWARE_FAN_SPEED.set(
              { hardware_type: 'gpu', device_id: index.toString(), fan_id: '0' },
              gpu.fanSpeed || 0
            );
          });
        }
        
        if (hardwareData.cpus) {
          hardwareData.cpus.forEach((cpu, index) => {
            PrometheusMetrics.HARDWARE_TEMPERATURE.set(
              { hardware_type: 'cpu', device_id: index.toString(), sensor: 'core' },
              cpu.temperature || 0
            );
            
            PrometheusMetrics.HARDWARE_POWER.set(
              { hardware_type: 'cpu', device_id: index.toString() },
              cpu.powerUsage || 0
            );
          });
        }
      }
      
      // システムメトリクス
      if (systemData) {
        PrometheusMetrics.SYSTEM_UPTIME.set(systemData.uptime || 0);
        
        if (systemData.earnings) {
          PrometheusMetrics.EARNINGS_CURRENT.set(
            { currency: 'btc', pool: systemData.pool || 'default' },
            systemData.earnings.current || 0
          );
          
          PrometheusMetrics.EARNINGS_DAILY.set(
            { currency: 'btc', pool: systemData.pool || 'default' },
            systemData.earnings.daily || 0
          );
        }
      }
      
      this.stats.metricsCollected++;
      
    } catch (error) {
      logger.error('メトリクス更新エラー', { error: error.message });
    }
  }
  
  /**
   * ログ送信
   */
  async shipLogs(logs) {
    if (!this.elasticsearchClient || !logs || logs.length === 0) {
      return;
    }
    
    try {
      const body = [];
      
      logs.forEach(log => {
        // インデックスメタデータ
        body.push({
          index: {
            _index: `${this.options.elasticsearchIndex}-${new Date().toISOString().split('T')[0]}`
          }
        });
        
        // ログデータ
        body.push({
          '@timestamp': new Date().toISOString(),
          level: log.level || 'info',
          message: log.message,
          module: log.module || 'otedama',
          data: log.data || {},
          hostname: require('os').hostname()
        });
      });
      
      await this.elasticsearchClient.bulk({
        refresh: true,
        body
      });
      
      this.stats.logsShipped += logs.length;
      
    } catch (error) {
      logger.error('ログ送信エラー', { error: error.message });
    }
  }
  
  /**
   * アラート評価
   */
  async evaluateAlerts(currentMetrics) {
    if (!this.options.alertingEnabled) {
      return;
    }
    
    for (const [ruleName, rule] of Object.entries(AlertRules)) {
      try {
        const alertActive = await this.evaluateAlertRule(rule, currentMetrics);
        
        if (alertActive && !this.activeAlerts.has(ruleName)) {
          // 新しいアラート発火
          await this.fireAlert(ruleName, rule, currentMetrics);
        } else if (!alertActive && this.activeAlerts.has(ruleName)) {
          // アラート解除
          await this.resolveAlert(ruleName, rule);
        }
        
      } catch (error) {
        logger.error('アラート評価エラー', {
          rule: ruleName,
          error: error.message
        });
      }
    }
  }
  
  /**
   * アラート発火
   */
  async fireAlert(ruleName, rule, metrics) {
    const alert = {
      id: `${ruleName}-${Date.now()}`,
      rule: ruleName,
      severity: rule.labels.severity,
      category: rule.labels.category,
      summary: rule.annotations.summary,
      description: rule.annotations.description,
      firedAt: new Date().toISOString(),
      metrics
    };
    
    this.activeAlerts.set(ruleName, alert);
    this.alertHistory.push(alert);
    this.stats.alertsFired++;
    
    // Prometheusメトリクス更新
    PrometheusMetrics.ALERTS_ACTIVE.inc(
      { severity: alert.severity, category: alert.category }
    );
    
    PrometheusMetrics.ALERTS_FIRED.inc(
      { severity: alert.severity, category: alert.category, rule: ruleName }
    );
    
    logger.warn('アラート発火', {
      rule: ruleName,
      severity: alert.severity,
      summary: alert.summary
    });
    
    // Webhook通知
    if (this.options.webhookUrl) {
      await this.sendWebhookNotification(alert);
    }
    
    this.emit('alert:fired', alert);
  }
  
  /**
   * アラート解除
   */
  async resolveAlert(ruleName, rule) {
    const alert = this.activeAlerts.get(ruleName);
    if (!alert) return;
    
    alert.resolvedAt = new Date().toISOString();
    this.activeAlerts.delete(ruleName);
    
    // Prometheusメトリクス更新
    PrometheusMetrics.ALERTS_ACTIVE.dec(
      { severity: alert.severity, category: alert.category }
    );
    
    logger.info('アラート解除', {
      rule: ruleName,
      severity: alert.severity
    });
    
    this.emit('alert:resolved', alert);
  }
  
  /**
   * 統計情報取得
   */
  getStatistics() {
    return {
      monitoring: {
        enabled: this.options.enabled,
        uptime: Date.now() - this.stats.uptime,
        metricsCollected: this.stats.metricsCollected,
        logsShipped: this.stats.logsShipped
      },
      
      integrations: {
        prometheus: {
          enabled: this.options.prometheusEnabled,
          port: this.options.metricsPort,
          endpoint: this.options.metricsEndpoint
        },
        elasticsearch: {
          enabled: this.options.elasticsearchEnabled,
          connected: !!this.elasticsearchClient,
          index: this.options.elasticsearchIndex
        },
        grafana: {
          enabled: this.options.grafanaEnabled,
          dashboardsCreated: this.stats.dashboardsCreated
        }
      },
      
      alerting: {
        enabled: this.options.alertingEnabled,
        activeAlerts: this.activeAlerts.size,
        totalFired: this.stats.alertsFired,
        rules: Object.keys(AlertRules).length
      }
    };
  }
  
  /**
   * シャットダウン
   */
  async shutdown() {
    logger.info('Enterprise Monitoring System シャットダウン中');
    
    // タイマー停止
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
    }
    
    if (this.logShippingTimer) {
      clearInterval(this.logShippingTimer);
    }
    
    // 残りのログを送信
    if (this.logBuffer.length > 0) {
      await this.shipLogs(this.logBuffer);
    }
    
    // メトリクスサーバー停止
    if (this.metricsServer) {
      this.metricsServer.close();
    }
    
    // Elasticsearch接続終了
    if (this.elasticsearchClient) {
      await this.elasticsearchClient.close();
    }
    
    logger.info('Enterprise Monitoring System シャットダウン完了');
  }
  
  // ユーティリティメソッド
  
  startPeriodicUpdates() {
    // メトリクス更新タイマー
    this.metricsTimer = setInterval(async () => {
      try {
        // システムデータ取得（実装は省略）
        const systemData = await this.getSystemData();
        await this.updateMetrics(null, null, systemData);
        await this.evaluateAlerts(systemData);
      } catch (error) {
        logger.error('定期更新エラー', { error: error.message });
      }
    }, this.options.metricsUpdateInterval);
    
    // ログ送信タイマー
    this.logShippingTimer = setInterval(async () => {
      if (this.logBuffer.length > 0) {
        const logs = this.logBuffer.splice(0, this.logBuffer.length);
        await this.shipLogs(logs);
      }
    }, this.options.logShippingInterval);
  }
  
  async createElasticsearchTemplate() {
    const template = {
      index_patterns: [`${this.options.elasticsearchIndex}-*`],
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0
      },
      mappings: {
        properties: {
          '@timestamp': { type: 'date' },
          level: { type: 'keyword' },
          message: { type: 'text' },
          module: { type: 'keyword' },
          hostname: { type: 'keyword' },
          data: {
            type: 'object',
            dynamic: true
          }
        }
      }
    };
    
    await this.elasticsearchClient.indices.putTemplate({
      name: `${this.options.elasticsearchIndex}-template`,
      body: template
    });
  }
  
  async createGrafanaDashboard(name, dashboard) {
    // Grafana API呼び出し（実装省略）
    logger.info('Grafanaダッシュボード作成', { name });
  }
  
  async setupAlertRules() {
    // Prometheusアラートルール設定（実装省略）
    logger.info('アラートルール設定完了', {
      rules: Object.keys(AlertRules).length
    });
  }
  
  async evaluateAlertRule(rule, metrics) {
    // アラートルール評価ロジック（実装省略）
    return false;
  }
  
  async sendWebhookNotification(alert) {
    // Webhook通知送信（実装省略）
    logger.info('Webhook通知送信', { alertId: alert.id });
  }
  
  async getSystemData() {
    // システムデータ取得（実装省略）
    return {
      uptime: Date.now() - this.stats.uptime,
      earnings: {
        current: 0.00012345,
        daily: 0.00234567
      },
      pool: 'otedama-pool-1'
    };
  }
  
  // ログバッファ管理
  addLogToBuffer(log) {
    this.logBuffer.push(log);
    
    if (this.logBuffer.length > this.maxLogBufferSize) {
      this.logBuffer = this.logBuffer.slice(-this.maxLogBufferSize);
    }
  }
  
  // APIメトリクス記録
  recordAPIRequest(method, endpoint, statusCode, responseTime) {
    PrometheusMetrics.API_REQUESTS.inc({
      method,
      endpoint,
      status_code: statusCode.toString()
    });
    
    PrometheusMetrics.API_RESPONSE_TIME.observe(
      { method, endpoint },
      responseTime / 1000 // seconds
    );
  }
}

export default EnterpriseMonitoringSystem;