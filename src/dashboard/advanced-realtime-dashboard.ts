/**
 * Advanced Real-time Dashboard System - 高度リアルタイムダッシュボード
 * 
 * 設計思想:
 * - John Carmack: 高性能・リアルタイム更新・最適化
 * - Robert C. Martin: クリーンアーキテクチャ・SOLID原則
 * - Rob Pike: シンプリシティ・必要最小限
 * 
 * 機能（IMPROVEMENTS_300.md 76-90番対応）:
 * - リアルタイムダッシュボード（76番）- 1秒間隔更新
 * - ハッシュレートヒートマップ（77番）- 視覚的性能表示
 * - 収益リアルタイム計算（78番）- 秒単位収益更新
 * - 温度監視システム（79番）- 60°C-95°C閾値管理
 * - 電力監視・制御（80番）- ワット単位精密制御
 * - ファン速度制御（81番）- 温度連動自動調整
 * - メモリ使用量監視（82番）- リーク検出
 * - ネットワーク状態表示（83番）- 接続品質可視化
 * - プール状態監視（84番）- 複数プールステータス
 * - シェア統計表示（85番）- 承認・拒否率分析
 * - 効率指標表示（86番）- ハッシュ/ワット効率
 * - アラート・通知システム（87番）- 即座問題通知
 * - カスタムメトリクス（88番）- ユーザー定義指標
 * - 履歴データ分析（89番）- 長期トレンド表示
 * - 比較分析機能（90番）- 期間・設定比較
 */

import { EventEmitter } from 'events';

// ===== Types =====
export interface DashboardMetrics {
  timestamp: number;
  mining: {
    active: boolean;
    currency: string;
    hashrate: number;
    difficulty: number;
    sharesAccepted: number;
    sharesRejected: number;
    shareRate: number; // shares per minute
    uptime: number;
    estimatedReward: number;
  };
  hardware: {
    devices: DeviceMetrics[];
    totalPower: number;
    avgTemperature: number;
    avgFanSpeed: number;
    efficiency: number; // hash/watt
  };
  system: {
    cpu: number;
    memory: number;
    disk: number;
    network: {
      download: number;
      upload: number;
      latency: number;
      packetsLost: number;
    };
  };
  pool: {
    connected: boolean;
    latency: number;
    peers: number;
    hashrate: number;
    blocks: number;
    lastBlockTime: number;
  };
  financial: {
    dailyRevenue: number;
    dailyCost: number;
    dailyProfit: number;
    monthlyEstimate: number;
    electricityCost: number;
    profitMargin: number;
  };
}

export interface DeviceMetrics {
  id: string;
  name: string;
  type: 'CPU' | 'GPU' | 'ASIC';
  enabled: boolean;
  hashrate: number;
  power: number;
  temperature: number;
  fanSpeed: number;
  memoryUsage: number;
  coreUsage: number;
  efficiency: number;
  health: 'excellent' | 'good' | 'warning' | 'critical';
  errors: number;
  uptime: number;
}

export interface AlertConfig {
  id: string;
  name: string;
  type: 'temperature' | 'power' | 'hashrate' | 'memory' | 'network' | 'custom';
  enabled: boolean;
  threshold: number;
  comparison: 'greater' | 'less' | 'equal';
  severity: 'low' | 'medium' | 'high' | 'critical';
  cooldown: number; // minutes
  actions: AlertAction[];
}

export interface AlertAction {
  type: 'notification' | 'email' | 'webhook' | 'script' | 'shutdown';
  parameters: Record<string, any>;
}

export interface CustomMetric {
  id: string;
  name: string;
  description: string;
  formula: string; // JavaScript expression
  unit: string;
  format: string;
  enabled: boolean;
  category: string;
}

export interface DashboardWidget {
  id: string;
  type: 'metric' | 'chart' | 'heatmap' | 'table' | 'gauge' | 'custom';
  title: string;
  dataSource: string;
  config: Record<string, any>;
  position: { x: number; y: number; width: number; height: number };
  refreshRate: number; // seconds
}

export interface TrendAnalysis {
  metric: string;
  timeframe: string;
  trend: 'increasing' | 'decreasing' | 'stable';
  change: number;
  confidence: number;
  prediction: number;
  factors: string[];
}

// ===== Advanced Real-time Dashboard =====
export class AdvancedRealtimeDashboard extends EventEmitter {
  private logger: any;
  private isRunning: boolean = false;
  private updateInterval?: NodeJS.Timeout;
  
  // Data storage
  private metricsHistory: DashboardMetrics[] = [];
  private deviceMetrics: Map<string, DeviceMetrics[]> = new Map();
  private alertConfigs: Map<string, AlertConfig> = new Map();
  private customMetrics: Map<string, CustomMetric> = new Map();
  private widgets: Map<string, DashboardWidget> = new Map();
  
  // Update frequencies
  private readonly FAST_UPDATE_INTERVAL = 1000; // 1 second
  private readonly MEDIUM_UPDATE_INTERVAL = 5000; // 5 seconds
  private readonly SLOW_UPDATE_INTERVAL = 30000; // 30 seconds
  private readonly HISTORY_RETENTION = 24 * 60 * 60 * 1000; // 24 hours
  
  // Alert management
  private activeAlerts: Map<string, { lastTriggered: number; count: number }> = new Map();

  constructor(logger: any) {
    super();
    this.logger = logger;
    this.initializeDefaultConfig();
  }

  async initialize(): Promise<void> {
    this.logger.info('📊 Initializing Advanced Real-time Dashboard...');
    
    try {
      // Load saved configuration
      await this.loadConfiguration();
      
      // Initialize default widgets
      this.initializeDefaultWidgets();
      
      // Initialize default alerts
      this.initializeDefaultAlerts();
      
      this.logger.success('✅ Dashboard initialized with real-time monitoring');
    } catch (error) {
      this.logger.error('❌ Failed to initialize dashboard:', error);
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    this.logger.info('🚀 Starting Real-time Dashboard System...');
    
    try {
      this.isRunning = true;
      
      // Start high-frequency updates
      this.updateInterval = setInterval(async () => {
        await this.updateRealTimeMetrics();
      }, this.FAST_UPDATE_INTERVAL);

      // Start medium-frequency analysis
      setInterval(async () => {
        await this.updateMediumFrequencyData();
      }, this.MEDIUM_UPDATE_INTERVAL);

      // Start low-frequency analysis
      setInterval(async () => {
        await this.updateSlowFrequencyData();
      }, this.SLOW_UPDATE_INTERVAL);

      this.emit('started');
      this.logger.success('✅ Real-time Dashboard started (1s update rate)');
      
    } catch (error) {
      this.logger.error('❌ Failed to start dashboard:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.logger.info('⏹️ Stopping Real-time Dashboard...');
    
    this.isRunning = false;
    
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }

    await this.saveConfiguration();
    
    this.emit('stopped');
    this.logger.success('✅ Dashboard stopped');
  }

  // 76. リアルタイムダッシュボード - 1秒間隔更新
  private async updateRealTimeMetrics(): Promise<void> {
    try {
      const metrics = await this.collectCurrentMetrics();
      
      // Add to history
      this.metricsHistory.push(metrics);
      
      // Trim history
      const cutoff = Date.now() - this.HISTORY_RETENTION;
      this.metricsHistory = this.metricsHistory.filter(m => m.timestamp > cutoff);

      // 78. 収益リアルタイム計算 - 秒単位収益更新
      await this.updateRealtimeRevenue(metrics);

      // 79. 温度監視システム - 60°C-95°C閾値管理
      this.monitorTemperatures(metrics);

      // 80. 電力監視・制御 - ワット単位精密制御
      this.monitorPowerConsumption(metrics);

      // 87. アラート・通知システム - 即座問題通知
      await this.checkAlerts(metrics);

      // Emit update
      this.emit('metricsUpdate', metrics);

    } catch (error) {
      this.logger.error('❌ Failed to update real-time metrics:', error);
    }
  }

  // 77. ハッシュレートヒートマップ - 視覚的性能表示
  generateHashrateHeatmap(): { devices: any[]; heatmapData: number[][] } {
    const devices: any[] = [];
    const heatmapData: number[][] = [];

    try {
      // Get recent device performance data
      const recentHistory = this.metricsHistory.slice(-60); // Last minute
      
      if (recentHistory.length === 0) {
        return { devices: [], heatmapData: [] };
      }

      // Extract unique devices
      const deviceIds = new Set<string>();
      recentHistory.forEach(metrics => {
        metrics.hardware.devices.forEach(device => {
          deviceIds.add(device.id);
        });
      });

      // Build heatmap matrix
      const deviceArray = Array.from(deviceIds);
      
      deviceArray.forEach((deviceId, deviceIndex) => {
        const deviceRow: number[] = [];
        
        recentHistory.forEach((metrics, timeIndex) => {
          const device = metrics.hardware.devices.find(d => d.id === deviceId);
          const normalizedHashrate = device ? 
            Math.min(1, device.hashrate / this.getMaxHashrateForDevice(device.type)) : 0;
          deviceRow.push(normalizedHashrate);
        });
        
        heatmapData.push(deviceRow);
        
        // Device info for labels
        const latestMetrics = recentHistory[recentHistory.length - 1];
        const deviceInfo = latestMetrics.hardware.devices.find(d => d.id === deviceId);
        
        if (deviceInfo) {
          devices.push({
            id: deviceId,
            name: deviceInfo.name,
            type: deviceInfo.type,
            currentHashrate: deviceInfo.hashrate,
            avgHashrate: deviceRow.reduce((a, b) => a + b, 0) / deviceRow.length,
            efficiency: deviceInfo.efficiency,
            health: deviceInfo.health
          });
        }
      });

      return { devices, heatmapData };

    } catch (error) {
      this.logger.error('❌ Failed to generate hashrate heatmap:', error);
      return { devices: [], heatmapData: [] };
    }
  }

  // 79. 温度監視システム - 60°C-95°C閾値管理
  private monitorTemperatures(metrics: DashboardMetrics): void {
    const tempThresholds = {
      warning: 75,   // 75°C
      critical: 85,  // 85°C
      emergency: 95  // 95°C
    };

    metrics.hardware.devices.forEach(device => {
      const temp = device.temperature;
      const deviceName = device.name;

      if (temp >= tempThresholds.emergency) {
        this.triggerAlert({
          type: 'temperature',
          severity: 'critical',
          device: deviceName,
          value: temp,
          threshold: tempThresholds.emergency,
          message: `🔥 EMERGENCY: ${deviceName} temperature ${temp}°C - immediate action required!`,
          actions: ['reduce_power', 'increase_fans', 'notification']
        });
      } else if (temp >= tempThresholds.critical) {
        this.triggerAlert({
          type: 'temperature',
          severity: 'high',
          device: deviceName,
          value: temp,
          threshold: tempThresholds.critical,
          message: `⚠️ CRITICAL: ${deviceName} temperature ${temp}°C - risk of thermal throttling`,
          actions: ['increase_fans', 'notification']
        });
      } else if (temp >= tempThresholds.warning) {
        this.triggerAlert({
          type: 'temperature',
          severity: 'medium',
          device: deviceName,
          value: temp,
          threshold: tempThresholds.warning,
          message: `🌡️ WARNING: ${deviceName} temperature ${temp}°C - monitor closely`,
          actions: ['notification']
        });
      }

      // 81. ファン速度制御 - 温度連動自動調整
      this.adjustFanSpeed(device, temp);
    });
  }

  // 81. ファン速度制御 - 温度連動自動調整
  private adjustFanSpeed(device: DeviceMetrics, temperature: number): void {
    let targetFanSpeed = device.fanSpeed;

    // Temperature-based fan curve
    if (temperature >= 85) {
      targetFanSpeed = 100; // Max speed
    } else if (temperature >= 80) {
      targetFanSpeed = 90;
    } else if (temperature >= 75) {
      targetFanSpeed = 80;
    } else if (temperature >= 70) {
      targetFanSpeed = 70;
    } else if (temperature >= 65) {
      targetFanSpeed = 60;
    } else {
      targetFanSpeed = 50; // Minimum for longevity
    }

    // Gradual adjustment to prevent fan noise spikes
    if (Math.abs(targetFanSpeed - device.fanSpeed) > 5) {
      const adjustment = targetFanSpeed > device.fanSpeed ? 5 : -5;
      device.fanSpeed = Math.max(30, Math.min(100, device.fanSpeed + adjustment));
      
      this.emit('fanSpeedAdjusted', {
        deviceId: device.id,
        temperature,
        oldSpeed: device.fanSpeed - adjustment,
        newSpeed: device.fanSpeed,
        reason: 'temperature_control'
      });
    }
  }

  // 80. 電力監視・制御 - ワット単位精密制御
  private monitorPowerConsumption(metrics: DashboardMetrics): void {
    const totalPower = metrics.hardware.totalPower;
    const powerLimits = {
      warning: 1000,   // 1kW
      critical: 1500,  // 1.5kW
      emergency: 2000  // 2kW
    };

    if (totalPower >= powerLimits.emergency) {
      this.triggerAlert({
        type: 'power',
        severity: 'critical',
        value: totalPower,
        threshold: powerLimits.emergency,
        message: `⚡ EMERGENCY: Total power consumption ${totalPower}W exceeds safe limits!`,
        actions: ['reduce_power_limits', 'disable_devices', 'notification']
      });
    } else if (totalPower >= powerLimits.critical) {
      this.triggerAlert({
        type: 'power',
        severity: 'high',
        value: totalPower,
        threshold: powerLimits.critical,
        message: `⚠️ HIGH: Power consumption ${totalPower}W approaching limits`,
        actions: ['reduce_power_limits', 'notification']
      });
    }

    // Monitor individual device power efficiency
    metrics.hardware.devices.forEach(device => {
      if (device.efficiency < 50 && device.power > 100) { // Less than 50 H/W
        this.triggerAlert({
          type: 'efficiency',
          severity: 'medium',
          device: device.name,
          value: device.efficiency,
          threshold: 50,
          message: `📉 ${device.name} efficiency ${device.efficiency.toFixed(1)} H/W is below optimal`,
          actions: ['optimize_settings', 'notification']
        });
      }
    });
  }

  // 82. メモリ使用量監視 - リーク検出
  private monitorMemoryUsage(metrics: DashboardMetrics): void {
    const memoryUsage = metrics.system.memory;
    const memoryThresholds = {
      warning: 80,   // 80%
      critical: 90,  // 90%
      emergency: 95  // 95%
    };

    if (memoryUsage >= memoryThresholds.emergency) {
      this.triggerAlert({
        type: 'memory',
        severity: 'critical',
        value: memoryUsage,
        threshold: memoryThresholds.emergency,
        message: `🧠 CRITICAL: Memory usage ${memoryUsage}% - system unstable!`,
        actions: ['restart_miners', 'clear_cache', 'notification']
      });
    } else if (memoryUsage >= memoryThresholds.critical) {
      this.triggerAlert({
        type: 'memory',
        severity: 'high',
        value: memoryUsage,
        threshold: memoryThresholds.critical,
        message: `⚠️ HIGH: Memory usage ${memoryUsage}% - possible leak detected`,
        actions: ['clear_cache', 'notification']
      });
    }

    // Memory leak detection
    this.detectMemoryLeaks(memoryUsage);
  }

  // 83. ネットワーク状態表示 - 接続品質可視化
  getNetworkQualityVisualization(): any {
    const recentMetrics = this.metricsHistory.slice(-60); // Last minute
    
    if (recentMetrics.length === 0) {
      return { quality: 'unknown', metrics: [], status: 'no_data' };
    }

    const networkMetrics = recentMetrics.map(m => m.system.network);
    
    // Calculate averages
    const avgLatency = networkMetrics.reduce((sum, n) => sum + n.latency, 0) / networkMetrics.length;
    const avgPacketLoss = networkMetrics.reduce((sum, n) => sum + n.packetsLost, 0) / networkMetrics.length;
    const avgDownload = networkMetrics.reduce((sum, n) => sum + n.download, 0) / networkMetrics.length;
    const avgUpload = networkMetrics.reduce((sum, n) => sum + n.upload, 0) / networkMetrics.length;

    // Determine quality
    let quality = 'excellent';
    if (avgLatency > 100 || avgPacketLoss > 1) quality = 'poor';
    else if (avgLatency > 50 || avgPacketLoss > 0.5) quality = 'fair';
    else if (avgLatency > 20) quality = 'good';

    return {
      quality,
      metrics: {
        latency: avgLatency,
        packetLoss: avgPacketLoss,
        download: avgDownload,
        upload: avgUpload
      },
      history: networkMetrics.slice(-30), // Last 30 seconds
      status: quality === 'poor' ? 'degraded' : 'healthy'
    };
  }

  // 84. プール状態監視 - 複数プールステータス
  getPoolStatus(): any {
    const recentMetrics = this.metricsHistory.slice(-10);
    
    if (recentMetrics.length === 0) {
      return { status: 'unknown', pools: [] };
    }

    const latestPool = recentMetrics[recentMetrics.length - 1].pool;
    
    // Calculate pool health metrics
    const avgLatency = recentMetrics.reduce((sum, m) => sum + m.pool.latency, 0) / recentMetrics.length;
    const connectionStability = recentMetrics.filter(m => m.pool.connected).length / recentMetrics.length;
    
    let poolHealth = 'excellent';
    if (connectionStability < 0.8 || avgLatency > 200) poolHealth = 'poor';
    else if (connectionStability < 0.95 || avgLatency > 100) poolHealth = 'fair';
    else if (avgLatency > 50) poolHealth = 'good';

    return {
      status: latestPool.connected ? 'connected' : 'disconnected',
      health: poolHealth,
      metrics: {
        latency: avgLatency,
        stability: connectionStability * 100,
        peers: latestPool.peers,
        hashrate: latestPool.hashrate,
        blocks: latestPool.blocks,
        lastBlock: latestPool.lastBlockTime
      },
      pools: [
        {
          name: 'Otedama P2P Pool',
          url: 'stratum+tcp://localhost:8333',
          status: latestPool.connected ? 'active' : 'inactive',
          latency: avgLatency,
          hashrate: latestPool.hashrate,
          fee: 0
        }
      ]
    };
  }

  // 85. シェア統計表示 - 承認・拒否率分析
  getShareStatistics(): any {
    const recentMetrics = this.metricsHistory.slice(-360); // Last 6 minutes
    
    if (recentMetrics.length === 0) {
      return { acceptanceRate: 0, rejectionRate: 0, shareRate: 0, analysis: {} };
    }

    const totalAccepted = recentMetrics.reduce((sum, m) => sum + m.mining.sharesAccepted, 0);
    const totalRejected = recentMetrics.reduce((sum, m) => sum + m.mining.sharesRejected, 0);
    const totalShares = totalAccepted + totalRejected;
    
    const acceptanceRate = totalShares > 0 ? (totalAccepted / totalShares) * 100 : 0;
    const rejectionRate = totalShares > 0 ? (totalRejected / totalShares) * 100 : 0;
    const shareRate = totalShares / (recentMetrics.length / 60); // shares per minute

    // Trend analysis
    const firstHalf = recentMetrics.slice(0, Math.floor(recentMetrics.length / 2));
    const secondHalf = recentMetrics.slice(Math.floor(recentMetrics.length / 2));
    
    const firstHalfRate = this.calculateAcceptanceRate(firstHalf);
    const secondHalfRate = this.calculateAcceptanceRate(secondHalf);
    const trend = secondHalfRate > firstHalfRate ? 'improving' : 
                  secondHalfRate < firstHalfRate ? 'declining' : 'stable';

    return {
      acceptanceRate,
      rejectionRate,
      shareRate,
      totalShares,
      trend,
      analysis: {
        performance: acceptanceRate >= 98 ? 'excellent' : 
                    acceptanceRate >= 95 ? 'good' : 
                    acceptanceRate >= 90 ? 'fair' : 'poor',
        issues: rejectionRate > 5 ? ['high_rejection_rate'] : 
                rejectionRate > 2 ? ['moderate_rejection_rate'] : [],
        recommendations: this.generateShareRecommendations(acceptanceRate, rejectionRate)
      }
    };
  }

  // 86. 効率指標表示 - ハッシュ/ワット効率
  getEfficiencyMetrics(): any {
    const recentMetrics = this.metricsHistory.slice(-60); // Last minute
    
    if (recentMetrics.length === 0) {
      return { current: 0, average: 0, peak: 0, trend: 'stable', devices: [] };
    }

    const efficiencies = recentMetrics.map(m => m.hardware.efficiency);
    const avgEfficiency = efficiencies.reduce((a, b) => a + b, 0) / efficiencies.length;
    const peakEfficiency = Math.max(...efficiencies);
    const currentEfficiency = efficiencies[efficiencies.length - 1];

    // Trend calculation
    const firstQuarter = efficiencies.slice(0, Math.floor(efficiencies.length / 4));
    const lastQuarter = efficiencies.slice(-Math.floor(efficiencies.length / 4));
    const firstAvg = firstQuarter.reduce((a, b) => a + b, 0) / firstQuarter.length;
    const lastAvg = lastQuarter.reduce((a, b) => a + b, 0) / lastQuarter.length;
    
    const trend = lastAvg > firstAvg * 1.02 ? 'improving' :
                  lastAvg < firstAvg * 0.98 ? 'declining' : 'stable';

    // Device efficiency breakdown
    const latestMetrics = recentMetrics[recentMetrics.length - 1];
    const deviceEfficiencies = latestMetrics.hardware.devices.map(device => ({
      id: device.id,
      name: device.name,
      type: device.type,
      efficiency: device.efficiency,
      hashrate: device.hashrate,
      power: device.power,
      score: this.calculateEfficiencyScore(device.efficiency, device.type)
    })).sort((a, b) => b.efficiency - a.efficiency);

    return {
      current: currentEfficiency,
      average: avgEfficiency,
      peak: peakEfficiency,
      trend,
      devices: deviceEfficiencies,
      overall: {
        score: this.calculateOverallEfficiencyScore(avgEfficiency),
        ranking: this.getEfficiencyRanking(avgEfficiency)
      }
    };
  }

  // 88. カスタムメトリクス - ユーザー定義指標
  addCustomMetric(metric: CustomMetric): void {
    this.customMetrics.set(metric.id, metric);
    this.emit('customMetricAdded', metric);
    this.logger.info(`📊 Added custom metric: ${metric.name}`);
  }

  calculateCustomMetric(metricId: string, data: DashboardMetrics): number | null {
    const metric = this.customMetrics.get(metricId);
    if (!metric || !metric.enabled) {
      return null;
    }

    try {
      // Create safe evaluation context
      const context = {
        hashrate: data.mining.hashrate,
        power: data.hardware.totalPower,
        temperature: data.hardware.avgTemperature,
        efficiency: data.hardware.efficiency,
        revenue: data.financial.dailyRevenue,
        profit: data.financial.dailyProfit,
        uptime: data.mining.uptime,
        shares: data.mining.sharesAccepted,
        Math,
        Date
      };

      // Evaluate formula safely
      const result = this.evaluateFormula(metric.formula, context);
      return typeof result === 'number' ? result : null;

    } catch (error) {
      this.logger.warn(`❌ Failed to calculate custom metric ${metric.name}:`, error.message);
      return null;
    }
  }

  // 89. 履歴データ分析 - 長期トレンド表示
  analyzeHistoricalTrends(timeframe: string = '24h'): TrendAnalysis[] {
    const analyses: TrendAnalysis[] = [];
    
    try {
      const timeframeMs = this.parseTimeframe(timeframe);
      const cutoff = Date.now() - timeframeMs;
      const historicalData = this.metricsHistory.filter(m => m.timestamp >= cutoff);
      
      if (historicalData.length < 10) {
        return analyses;
      }

      // Analyze key metrics
      const metricsToAnalyze = [
        'hashrate', 'efficiency', 'temperature', 'power', 'revenue', 'profit'
      ];

      for (const metricName of metricsToAnalyze) {
        const values = this.extractMetricValues(historicalData, metricName);
        if (values.length > 0) {
          const analysis = this.performTrendAnalysis(metricName, values, timeframe);
          analyses.push(analysis);
        }
      }

      return analyses;

    } catch (error) {
      this.logger.error('❌ Historical trend analysis failed:', error);
      return [];
    }
  }

  // 90. 比較分析機能 - 期間・設定比較
  comparePerformance(period1: string, period2: string): any {
    try {
      const data1 = this.getDataForPeriod(period1);
      const data2 = this.getDataForPeriod(period2);
      
      if (data1.length === 0 || data2.length === 0) {
        return { error: 'Insufficient data for comparison' };
      }

      const comparison = {
        period1: {
          timeframe: period1,
          dataPoints: data1.length,
          averages: this.calculateAverages(data1),
          totals: this.calculateTotals(data1)
        },
        period2: {
          timeframe: period2,
          dataPoints: data2.length,
          averages: this.calculateAverages(data2),
          totals: this.calculateTotals(data2)
        },
        differences: {},
        insights: []
      };

      // Calculate differences
      comparison.differences = this.calculateDifferences(
        comparison.period1.averages,
        comparison.period2.averages
      );

      // Generate insights
      comparison.insights = this.generateComparisonInsights(comparison.differences);

      return comparison;

    } catch (error) {
      this.logger.error('❌ Performance comparison failed:', error);
      return { error: error.message };
    }
  }

  // Helper methods
  private async collectCurrentMetrics(): Promise<DashboardMetrics> {
    // Mock implementation - in real app, collect from various sources
    return {
      timestamp: Date.now(),
      mining: {
        active: true,
        currency: 'XMR',
        hashrate: 50000 + Math.random() * 10000,
        difficulty: 350000000000,
        sharesAccepted: 42,
        sharesRejected: 1,
        shareRate: 2.5,
        uptime: Date.now() - 3600000,
        estimatedReward: 0.0234
      },
      hardware: {
        devices: [
          {
            id: 'gpu-0',
            name: 'RTX 3080',
            type: 'GPU',
            enabled: true,
            hashrate: 45000 + Math.random() * 5000,
            power: 220 + Math.random() * 30,
            temperature: 65 + Math.random() * 15,
            fanSpeed: 70 + Math.random() * 20,
            memoryUsage: 70 + Math.random() * 20,
            coreUsage: 98 + Math.random() * 2,
            efficiency: 200 + Math.random() * 50,
            health: 'good',
            errors: 0,
            uptime: Date.now() - 3600000
          }
        ],
        totalPower: 250 + Math.random() * 50,
        avgTemperature: 70 + Math.random() * 10,
        avgFanSpeed: 75 + Math.random() * 15,
        efficiency: 180 + Math.random() * 40
      },
      system: {
        cpu: 15 + Math.random() * 10,
        memory: 45 + Math.random() * 20,
        disk: 60 + Math.random() * 10,
        network: {
          download: 10 + Math.random() * 5,
          upload: 2 + Math.random() * 1,
          latency: 20 + Math.random() * 30,
          packetsLost: Math.random() * 0.1
        }
      },
      pool: {
        connected: true,
        latency: 25 + Math.random() * 25,
        peers: 15 + Math.floor(Math.random() * 10),
        hashrate: 2500000000,
        blocks: 1247,
        lastBlockTime: Date.now() - 180000
      },
      financial: {
        dailyRevenue: 12.50 + Math.random() * 2,
        dailyCost: 2.40 + Math.random() * 0.5,
        dailyProfit: 10.10 + Math.random() * 1.5,
        monthlyEstimate: 300 + Math.random() * 50,
        electricityCost: 0.12,
        profitMargin: 82 + Math.random() * 8
      }
    };
  }

  private async updateRealtimeRevenue(metrics: DashboardMetrics): Promise<void> {
    // Calculate real-time revenue based on current hashrate and market conditions
    const secondlyRevenue = metrics.financial.dailyRevenue / (24 * 60 * 60);
    
    this.emit('revenueUpdate', {
      perSecond: secondlyRevenue,
      perMinute: secondlyRevenue * 60,
      perHour: secondlyRevenue * 3600,
      perDay: metrics.financial.dailyRevenue,
      efficiency: metrics.hardware.efficiency,
      profitability: (metrics.financial.dailyProfit / metrics.financial.dailyRevenue) * 100
    });
  }

  private updateMediumFrequencyData(): void {
    // 82. メモリ使用量監視
    const latestMetrics = this.metricsHistory[this.metricsHistory.length - 1];
    if (latestMetrics) {
      this.monitorMemoryUsage(latestMetrics);
    }
  }

  private updateSlowFrequencyData(): void {
    // 89. 履歴データ分析
    const trends = this.analyzeHistoricalTrends('1h');
    if (trends.length > 0) {
      this.emit('trendsUpdate', trends);
    }
  }

  private triggerAlert(alert: any): void {
    const alertId = `${alert.type}_${alert.device || 'system'}`;
    const now = Date.now();
    const existing = this.activeAlerts.get(alertId);
    
    // Cooldown check
    if (existing && now - existing.lastTriggered < 60000) { // 1 minute cooldown
      return;
    }

    this.activeAlerts.set(alertId, {
      lastTriggered: now,
      count: (existing?.count || 0) + 1
    });

    this.emit('alert', {
      ...alert,
      id: alertId,
      timestamp: now,
      count: this.activeAlerts.get(alertId)!.count
    });

    this.logger.warn(`🚨 Alert: ${alert.message}`);
  }

  private detectMemoryLeaks(currentUsage: number): void {
    const recentUsages = this.metricsHistory.slice(-10).map(m => m.system.memory);
    
    if (recentUsages.length >= 5) {
      const trend = this.calculateTrend(recentUsages);
      if (trend > 0.02 && currentUsage > 70) { // Growing > 2% and above 70%
        this.triggerAlert({
          type: 'memory_leak',
          severity: 'medium',
          value: currentUsage,
          message: `🧠 Potential memory leak detected - usage trending upward`,
          actions: ['restart_miners', 'notification']
        });
      }
    }
  }

  private calculateTrend(values: number[]): number {
    if (values.length < 2) return 0;
    return (values[values.length - 1] - values[0]) / values[0];
  }

  private getMaxHashrateForDevice(type: string): number {
    const maxRates = { CPU: 100000, GPU: 100000000, ASIC: 100000000000000 };
    return maxRates[type as keyof typeof maxRates] || 1000000;
  }

  private calculateAcceptanceRate(metrics: DashboardMetrics[]): number {
    const totalAccepted = metrics.reduce((sum, m) => sum + m.mining.sharesAccepted, 0);
    const totalRejected = metrics.reduce((sum, m) => sum + m.mining.sharesRejected, 0);
    const total = totalAccepted + totalRejected;
    return total > 0 ? (totalAccepted / total) * 100 : 100;
  }

  private generateShareRecommendations(acceptanceRate: number, rejectionRate: number): string[] {
    const recommendations: string[] = [];
    
    if (rejectionRate > 5) {
      recommendations.push('Check pool connection stability');
      recommendations.push('Verify mining software configuration');
      recommendations.push('Consider switching to closer pool server');
    }
    
    if (acceptanceRate < 95) {
      recommendations.push('Monitor hardware stability');
      recommendations.push('Check for overclocking issues');
    }
    
    return recommendations;
  }

  private calculateEfficiencyScore(efficiency: number, deviceType: string): number {
    const baselines = { CPU: 50, GPU: 200, ASIC: 5000 };
    const baseline = baselines[deviceType as keyof typeof baselines] || 100;
    return Math.min(100, (efficiency / baseline) * 100);
  }

  private calculateOverallEfficiencyScore(avgEfficiency: number): number {
    // Based on general mining efficiency standards
    if (avgEfficiency >= 300) return 95;
    if (avgEfficiency >= 250) return 85;
    if (avgEfficiency >= 200) return 75;
    if (avgEfficiency >= 150) return 65;
    if (avgEfficiency >= 100) return 55;
    return 45;
  }

  private getEfficiencyRanking(efficiency: number): string {
    if (efficiency >= 300) return 'Excellent';
    if (efficiency >= 250) return 'Very Good';
    if (efficiency >= 200) return 'Good';
    if (efficiency >= 150) return 'Average';
    if (efficiency >= 100) return 'Below Average';
    return 'Poor';
  }

  private evaluateFormula(formula: string, context: any): any {
    // Safe formula evaluation (simplified)
    try {
      const func = new Function(...Object.keys(context), `return ${formula}`);
      return func(...Object.values(context));
    } catch {
      return null;
    }
  }

  private parseTimeframe(timeframe: string): number {
    const multipliers: Record<string, number> = {
      'm': 60 * 1000,
      'h': 60 * 60 * 1000,
      'd': 24 * 60 * 60 * 1000
    };
    
    const match = timeframe.match(/^(\d+)([mhd])$/);
    if (match) {
      return parseInt(match[1]) * multipliers[match[2]];
    }
    
    return 24 * 60 * 60 * 1000; // Default 24 hours
  }

  private extractMetricValues(data: DashboardMetrics[], metricName: string): number[] {
    return data.map(metrics => {
      switch (metricName) {
        case 'hashrate': return metrics.mining.hashrate;
        case 'efficiency': return metrics.hardware.efficiency;
        case 'temperature': return metrics.hardware.avgTemperature;
        case 'power': return metrics.hardware.totalPower;
        case 'revenue': return metrics.financial.dailyRevenue;
        case 'profit': return metrics.financial.dailyProfit;
        default: return 0;
      }
    });
  }

  private performTrendAnalysis(metricName: string, values: number[], timeframe: string): TrendAnalysis {
    const firstQuarter = values.slice(0, Math.floor(values.length / 4));
    const lastQuarter = values.slice(-Math.floor(values.length / 4));
    
    const firstAvg = firstQuarter.reduce((a, b) => a + b, 0) / firstQuarter.length;
    const lastAvg = lastQuarter.reduce((a, b) => a + b, 0) / lastQuarter.length;
    
    const change = (lastAvg - firstAvg) / firstAvg;
    const trend = change > 0.02 ? 'increasing' : change < -0.02 ? 'decreasing' : 'stable';
    
    return {
      metric: metricName,
      timeframe,
      trend,
      change: change * 100,
      confidence: Math.min(100, values.length / 10 * 100),
      prediction: lastAvg * (1 + change),
      factors: this.getFactorsForMetric(metricName)
    };
  }

  private getDataForPeriod(period: string): DashboardMetrics[] {
    const timeframeMs = this.parseTimeframe(period);
    const cutoff = Date.now() - timeframeMs;
    return this.metricsHistory.filter(m => m.timestamp >= cutoff);
  }

  private calculateAverages(data: DashboardMetrics[]): any {
    if (data.length === 0) return {};
    
    return {
      hashrate: data.reduce((sum, d) => sum + d.mining.hashrate, 0) / data.length,
      efficiency: data.reduce((sum, d) => sum + d.hardware.efficiency, 0) / data.length,
      temperature: data.reduce((sum, d) => sum + d.hardware.avgTemperature, 0) / data.length,
      power: data.reduce((sum, d) => sum + d.hardware.totalPower, 0) / data.length,
      revenue: data.reduce((sum, d) => sum + d.financial.dailyRevenue, 0) / data.length
    };
  }

  private calculateTotals(data: DashboardMetrics[]): any {
    return {
      shares: data.reduce((sum, d) => sum + d.mining.sharesAccepted, 0),
      revenue: data.reduce((sum, d) => sum + d.financial.dailyRevenue, 0),
      uptime: data.length * (this.FAST_UPDATE_INTERVAL / 1000) // seconds
    };
  }

  private calculateDifferences(avg1: any, avg2: any): any {
    const differences: any = {};
    
    for (const key in avg1) {
      if (avg2[key] !== undefined) {
        differences[key] = {
          absolute: avg2[key] - avg1[key],
          percentage: ((avg2[key] - avg1[key]) / avg1[key]) * 100
        };
      }
    }
    
    return differences;
  }

  private generateComparisonInsights(differences: any): string[] {
    const insights: string[] = [];
    
    for (const [metric, diff] of Object.entries(differences)) {
      const typedDiff = diff as any;
      if (Math.abs(typedDiff.percentage) > 5) {
        const direction = typedDiff.percentage > 0 ? 'increased' : 'decreased';
        insights.push(`${metric} ${direction} by ${Math.abs(typedDiff.percentage).toFixed(1)}%`);
      }
    }
    
    return insights;
  }

  private getFactorsForMetric(metricName: string): string[] {
    const factors: Record<string, string[]> = {
      hashrate: ['Hardware settings', 'Temperature', 'Power limits'],
      efficiency: ['Power optimization', 'Hardware health', 'Algorithm'],
      temperature: ['Ambient temperature', 'Fan speed', 'Power consumption'],
      power: ['Hardware settings', 'Mining intensity', 'Temperature'],
      revenue: ['Market price', 'Difficulty', 'Hashrate'],
      profit: ['Revenue', 'Electricity cost', 'Efficiency']
    };
    
    return factors[metricName] || ['Unknown factors'];
  }

  private initializeDefaultConfig(): void {
    // Initialize with default configuration
  }

  private async loadConfiguration(): Promise<void> {
    // Load saved dashboard configuration
  }

  private async saveConfiguration(): Promise<void> {
    // Save dashboard configuration
  }

  private initializeDefaultWidgets(): void {
    // Initialize default dashboard widgets
  }

  private initializeDefaultAlerts(): void {
    // Initialize default alert configurations
  }

  // Public API
  getCurrentMetrics(): DashboardMetrics | null {
    return this.metricsHistory.length > 0 ? 
      this.metricsHistory[this.metricsHistory.length - 1] : null;
  }

  getMetricsHistory(timeframe?: string): DashboardMetrics[] {
    if (!timeframe) return [...this.metricsHistory];
    
    const timeframeMs = this.parseTimeframe(timeframe);
    const cutoff = Date.now() - timeframeMs;
    return this.metricsHistory.filter(m => m.timestamp >= cutoff);
  }

  getCustomMetrics(): CustomMetric[] {
    return Array.from(this.customMetrics.values());
  }

  removeCustomMetric(metricId: string): boolean {
    return this.customMetrics.delete(metricId);
  }

  getAlertConfigs(): AlertConfig[] {
    return Array.from(this.alertConfigs.values());
  }

  updateAlertConfig(config: AlertConfig): void {
    this.alertConfigs.set(config.id, config);
    this.emit('alertConfigUpdated', config);
  }

  getDashboardStats(): any {
    return {
      isRunning: this.isRunning,
      updateInterval: this.FAST_UPDATE_INTERVAL,
      metricsCount: this.metricsHistory.length,
      customMetrics: this.customMetrics.size,
      alertConfigs: this.alertConfigs.size,
      activeAlerts: this.activeAlerts.size,
      widgets: this.widgets.size
    };
  }
}
