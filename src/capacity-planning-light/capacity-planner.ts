/**
 * 軽量キャパシティプランニングシステム
 * 設計思想: Rob Pike (シンプル), John Carmack (高性能), Robert C. Martin (クリーン)
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// === 型定義 ===
export interface ResourceMetrics {
  timestamp: number;
  cpu: {
    usage: number; // パーセンテージ
    cores: number;
    loadAverage: number[];
  };
  memory: {
    used: number; // bytes
    total: number; // bytes
    usage: number; // パーセンテージ
  };
  network: {
    bytesIn: number;
    bytesOut: number;
    connectionsActive: number;
    connectionsTotal: number;
  };
  mining: {
    activeMiners: number;
    totalMiners: number;
    hashrate: number;
    sharesPerSecond: number;
    blocksFound: number;
  };
  storage: {
    used: number; // bytes
    total: number; // bytes
    usage: number; // パーセンテージ
    iopsRead: number;
    iopsWrite: number;
  };
}

export interface CapacityPrediction {
  resource: string;
  currentUsage: number;
  predictedUsage: number;
  timeToLimit: number; // milliseconds
  confidence: number; // 0-1
  recommendedAction: 'none' | 'scale_up' | 'scale_down' | 'optimize';
  details: string;
}

export interface ScalingRecommendation {
  id: string;
  timestamp: number;
  resource: string;
  action: 'scale_up' | 'scale_down' | 'optimize' | 'monitor';
  priority: 'low' | 'medium' | 'high' | 'critical';
  currentValue: number;
  targetValue: number;
  estimatedCost: number;
  estimatedBenefit: number;
  implementation: {
    steps: string[];
    estimatedTime: number; // minutes
    riskLevel: 'low' | 'medium' | 'high';
  };
  metadata: Record<string, any>;
}

export interface CapacityThresholds {
  cpu: {
    warning: number; // 70%
    critical: number; // 90%
  };
  memory: {
    warning: number; // 80%
    critical: number; // 95%
  };
  network: {
    connectionsWarning: number;
    connectionsCritical: number;
  };
  storage: {
    warning: number; // 85%
    critical: number; // 95%
  };
  mining: {
    minActiveMiners: number;
    maxLoadPerMiner: number;
  };
}

export interface CapacityConfig {
  monitoringInterval: number; // milliseconds
  retentionPeriod: number; // days
  predictionWindow: number; // hours
  autoScalingEnabled: boolean;
  costOptimizationEnabled: boolean;
  thresholds: CapacityThresholds;
}

// === 軽量キャパシティプランニング ===
export class LightCapacityPlanner extends EventEmitter {
  private metrics: ResourceMetrics[] = [];
  private predictions: CapacityPrediction[] = [];
  private recommendations: ScalingRecommendation[] = [];
  private config: CapacityConfig;
  private monitoringTimer?: NodeJS.Timeout;
  private predictionTimer?: NodeJS.Timeout;
  private dataPath: string;
  private isRunning = false;

  constructor(config: Partial<CapacityConfig> = {}, dataPath = './data/capacity') {
    super();
    this.dataPath = dataPath;
    this.config = {
      monitoringInterval: 60000, // 1分
      retentionPeriod: 30, // 30日
      predictionWindow: 24, // 24時間
      autoScalingEnabled: false,
      costOptimizationEnabled: true,
      thresholds: {
        cpu: { warning: 70, critical: 90 },
        memory: { warning: 80, critical: 95 },
        network: { connectionsWarning: 1000, connectionsCritical: 5000 },
        storage: { warning: 85, critical: 95 },
        mining: { minActiveMiners: 1, maxLoadPerMiner: 100 }
      },
      ...config
    };

    this.loadHistoricalData();
  }

  // === 開始・停止 ===
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.startMonitoring();
    this.startPredictionEngine();
    this.emit('started');

    console.log('🔍 Capacity planner started');
  }

  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
    }
    
    if (this.predictionTimer) {
      clearInterval(this.predictionTimer);
    }

    this.saveHistoricalData();
    this.emit('stopped');

    console.log('🔍 Capacity planner stopped');
  }

  // === メトリクス収集 ===
  private startMonitoring(): void {
    this.monitoringTimer = setInterval(async () => {
      try {
        const metrics = await this.collectMetrics();
        this.addMetrics(metrics);
        this.checkThresholds(metrics);
      } catch (error) {
        console.error('Error collecting metrics:', error);
      }
    }, this.config.monitoringInterval);
  }

  private async collectMetrics(): Promise<ResourceMetrics> {
    const process_usage = process.cpuUsage();
    const memUsage = process.memoryUsage();
    
    return {
      timestamp: Date.now(),
      cpu: {
        usage: await this.getCPUUsage(),
        cores: require('os').cpus().length,
        loadAverage: require('os').loadavg()
      },
      memory: {
        used: memUsage.heapUsed,
        total: memUsage.heapTotal,
        usage: (memUsage.heapUsed / memUsage.heapTotal) * 100
      },
      network: {
        bytesIn: 0, // 実装が必要
        bytesOut: 0, // 実装が必要
        connectionsActive: 0, // 実装が必要
        connectionsTotal: 0 // 実装が必要
      },
      mining: {
        activeMiners: this.getActiveMinersCount(),
        totalMiners: this.getTotalMinersCount(),
        hashrate: this.getTotalHashrate(),
        sharesPerSecond: this.getSharesPerSecond(),
        blocksFound: this.getBlocksFoundCount()
      },
      storage: {
        used: 0, // 実装が必要
        total: 0, // 実装が必要
        usage: 0, // 実装が必要
        iopsRead: 0, // 実装が必要
        iopsWrite: 0 // 実装が必要
      }
    };
  }

  private async getCPUUsage(): Promise<number> {
    // 簡易CPU使用率計算
    const startUsage = process.cpuUsage();
    await new Promise(resolve => setTimeout(resolve, 100));
    const endUsage = process.cpuUsage(startUsage);
    
    const totalUsage = endUsage.user + endUsage.system;
    const totalTime = 100 * 1000; // 100ms in microseconds
    
    return Math.min(100, (totalUsage / totalTime) * 100);
  }

  private getActiveMinersCount(): number {
    // 実際のマイナー数を取得（プールから）
    return 0; // プレースホルダー
  }

  private getTotalMinersCount(): number {
    // 実際の総マイナー数を取得
    return 0; // プレースホルダー
  }

  private getTotalHashrate(): number {
    // 実際のハッシュレートを取得
    return 0; // プレースホルダー
  }

  private getSharesPerSecond(): number {
    // 実際のシェア/秒を取得
    return 0; // プレースホルダー
  }

  private getBlocksFoundCount(): number {
    // 実際のブロック発見数を取得
    return 0; // プレースホルダー
  }

  addMetrics(metrics: ResourceMetrics): void {
    this.metrics.push(metrics);
    
    // 古いデータを削除
    const cutoff = Date.now() - (this.config.retentionPeriod * 24 * 60 * 60 * 1000);
    this.metrics = this.metrics.filter(m => m.timestamp > cutoff);

    this.emit('metricsAdded', metrics);
  }

  // === 閾値チェック ===
  private checkThresholds(metrics: ResourceMetrics): void {
    const alerts: Array<{ resource: string; level: string; value: number; threshold: number }> = [];

    // CPU閾値チェック
    if (metrics.cpu.usage >= this.config.thresholds.cpu.critical) {
      alerts.push({
        resource: 'cpu',
        level: 'critical',
        value: metrics.cpu.usage,
        threshold: this.config.thresholds.cpu.critical
      });
    } else if (metrics.cpu.usage >= this.config.thresholds.cpu.warning) {
      alerts.push({
        resource: 'cpu',
        level: 'warning',
        value: metrics.cpu.usage,
        threshold: this.config.thresholds.cpu.warning
      });
    }

    // メモリ閾値チェック
    if (metrics.memory.usage >= this.config.thresholds.memory.critical) {
      alerts.push({
        resource: 'memory',
        level: 'critical',
        value: metrics.memory.usage,
        threshold: this.config.thresholds.memory.critical
      });
    } else if (metrics.memory.usage >= this.config.thresholds.memory.warning) {
      alerts.push({
        resource: 'memory',
        level: 'warning',
        value: metrics.memory.usage,
        threshold: this.config.thresholds.memory.warning
      });
    }

    // ストレージ閾値チェック
    if (metrics.storage.usage >= this.config.thresholds.storage.critical) {
      alerts.push({
        resource: 'storage',
        level: 'critical',
        value: metrics.storage.usage,
        threshold: this.config.thresholds.storage.critical
      });
    } else if (metrics.storage.usage >= this.config.thresholds.storage.warning) {
      alerts.push({
        resource: 'storage',
        level: 'warning',
        value: metrics.storage.usage,
        threshold: this.config.thresholds.storage.warning
      });
    }

    // アラートを発行
    for (const alert of alerts) {
      this.emit('thresholdExceeded', alert);
      console.warn(`⚠️ ${alert.level.toUpperCase()}: ${alert.resource} usage ${alert.value.toFixed(1)}% exceeds ${alert.threshold}% threshold`);
    }
  }

  // === 予測エンジン ===
  private startPredictionEngine(): void {
    this.predictionTimer = setInterval(() => {
      try {
        this.generatePredictions();
        this.generateRecommendations();
      } catch (error) {
        console.error('Error in prediction engine:', error);
      }
    }, 300000); // 5分間隔
  }

  private generatePredictions(): void {
    if (this.metrics.length < 10) {
      return; // 十分なデータがない
    }

    const predictions: CapacityPrediction[] = [];

    // CPU予測
    const cpuPrediction = this.predictResource('cpu', this.metrics.map(m => m.cpu.usage));
    if (cpuPrediction) predictions.push(cpuPrediction);

    // メモリ予測
    const memoryPrediction = this.predictResource('memory', this.metrics.map(m => m.memory.usage));
    if (memoryPrediction) predictions.push(memoryPrediction);

    // ストレージ予測
    const storagePrediction = this.predictResource('storage', this.metrics.map(m => m.storage.usage));
    if (storagePrediction) predictions.push(storagePrediction);

    // マイナー数予測
    const minersPrediction = this.predictResource('miners', this.metrics.map(m => m.mining.activeMiners));
    if (minersPrediction) predictions.push(minersPrediction);

    this.predictions = predictions;
    this.emit('predictionsGenerated', predictions);
  }

  private predictResource(resourceName: string, values: number[]): CapacityPrediction | null {
    if (values.length < 5) return null;

    // 線形回帰による簡易予測
    const n = values.length;
    const recent = values.slice(-Math.min(n, 50)); // 最新50データポイント
    
    const trend = this.calculateTrend(recent);
    const currentUsage = recent[recent.length - 1];
    
    // 予測時間窓での予測値
    const hoursToPredict = this.config.predictionWindow;
    const predictedUsage = currentUsage + (trend * hoursToPredict);
    
    // 制限時間の計算
    const limit = this.getResourceLimit(resourceName);
    const timeToLimit = trend > 0 ? (limit - currentUsage) / trend : Infinity;
    
    // 信頼度計算（分散に基づく）
    const variance = this.calculateVariance(recent);
    const confidence = Math.max(0, Math.min(1, 1 - variance / 100));

    // 推奨アクション
    let recommendedAction: 'none' | 'scale_up' | 'scale_down' | 'optimize' = 'none';
    if (predictedUsage > 90) {
      recommendedAction = 'scale_up';
    } else if (predictedUsage < 30 && currentUsage < 50) {
      recommendedAction = 'scale_down';
    } else if (trend > 5) {
      recommendedAction = 'optimize';
    }

    return {
      resource: resourceName,
      currentUsage,
      predictedUsage: Math.max(0, Math.min(100, predictedUsage)),
      timeToLimit: timeToLimit * 60 * 60 * 1000, // hours to milliseconds
      confidence,
      recommendedAction,
      details: this.generatePredictionDetails(resourceName, currentUsage, predictedUsage, trend)
    };
  }

  private calculateTrend(values: number[]): number {
    const n = values.length;
    if (n < 2) return 0;

    // 線形回帰でトレンド計算
    const x = Array.from({ length: n }, (_, i) => i);
    const y = values;
    
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    
    return slope;
  }

  private calculateVariance(values: number[]): number {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  private getResourceLimit(resourceName: string): number {
    switch (resourceName) {
      case 'cpu':
      case 'memory':
      case 'storage':
        return 100; // パーセンテージ
      case 'miners':
        return 10000; // 最大マイナー数の仮定
      default:
        return 100;
    }
  }

  private generatePredictionDetails(resourceName: string, current: number, predicted: number, trend: number): string {
    const change = predicted - current;
    const direction = change > 0 ? 'increase' : 'decrease';
    
    return `${resourceName} usage will ${direction} by ${Math.abs(change).toFixed(1)}% in the next ${this.config.predictionWindow} hours (trend: ${trend.toFixed(2)}%/hour)`;
  }

  // === 推奨事項生成 ===
  private generateRecommendations(): void {
    const recommendations: ScalingRecommendation[] = [];

    for (const prediction of this.predictions) {
      const recommendation = this.createRecommendation(prediction);
      if (recommendation) {
        recommendations.push(recommendation);
      }
    }

    // コスト最適化推奨事項
    if (this.config.costOptimizationEnabled) {
      const costOptimizations = this.generateCostOptimizations();
      recommendations.push(...costOptimizations);
    }

    this.recommendations = recommendations;
    this.emit('recommendationsGenerated', recommendations);

    // 高優先度の推奨事項をログ出力
    const highPriority = recommendations.filter(r => r.priority === 'high' || r.priority === 'critical');
    for (const rec of highPriority) {
      console.warn(`🚨 ${rec.priority.toUpperCase()}: ${rec.resource} - ${rec.action} (${rec.implementation.steps[0]})`);
    }
  }

  private createRecommendation(prediction: CapacityPrediction): ScalingRecommendation | null {
    if (prediction.recommendedAction === 'none') {
      return null;
    }

    const priority = this.calculatePriority(prediction);
    const implementation = this.generateImplementationPlan(prediction);

    return {
      id: this.generateRecommendationId(),
      timestamp: Date.now(),
      resource: prediction.resource,
      action: prediction.recommendedAction,
      priority,
      currentValue: prediction.currentUsage,
      targetValue: this.calculateTargetValue(prediction),
      estimatedCost: this.estimateCost(prediction),
      estimatedBenefit: this.estimateBenefit(prediction),
      implementation,
      metadata: {
        confidence: prediction.confidence,
        timeToLimit: prediction.timeToLimit,
        trend: prediction.details
      }
    };
  }

  private calculatePriority(prediction: CapacityPrediction): 'low' | 'medium' | 'high' | 'critical' {
    if (prediction.timeToLimit < 60 * 60 * 1000) { // 1時間以内
      return 'critical';
    } else if (prediction.timeToLimit < 6 * 60 * 60 * 1000) { // 6時間以内
      return 'high';
    } else if (prediction.timeToLimit < 24 * 60 * 60 * 1000) { // 24時間以内
      return 'medium';
    } else {
      return 'low';
    }
  }

  private generateImplementationPlan(prediction: CapacityPrediction): ScalingRecommendation['implementation'] {
    const steps: string[] = [];
    let estimatedTime = 30; // minutes
    let riskLevel: 'low' | 'medium' | 'high' = 'low';

    switch (prediction.action) {
      case 'scale_up':
        steps.push(`Scale up ${prediction.resource} resources`);
        steps.push('Monitor performance after scaling');
        steps.push('Validate resource utilization');
        estimatedTime = 45;
        riskLevel = 'medium';
        break;

      case 'scale_down':
        steps.push('Validate current load can handle reduced resources');
        steps.push(`Scale down ${prediction.resource} resources`);
        steps.push('Monitor for performance degradation');
        estimatedTime = 60;
        riskLevel = 'high';
        break;

      case 'optimize':
        steps.push(`Analyze ${prediction.resource} usage patterns`);
        steps.push('Implement optimization strategies');
        steps.push('Monitor optimization effectiveness');
        estimatedTime = 120;
        riskLevel = 'low';
        break;
    }

    return {
      steps,
      estimatedTime,
      riskLevel
    };
  }

  private calculateTargetValue(prediction: CapacityPrediction): number {
    switch (prediction.action) {
      case 'scale_up':
        return Math.max(50, prediction.currentUsage - 20); // 余裕を持たせる
      case 'scale_down':
        return Math.min(70, prediction.currentUsage + 20); // 効率化
      case 'optimize':
        return Math.max(40, prediction.currentUsage - 10); // 軽度改善
      default:
        return prediction.currentUsage;
    }
  }

  private estimateCost(prediction: CapacityPrediction): number {
    // 簡易コスト推定（実際の環境では詳細な計算が必要）
    switch (prediction.action) {
      case 'scale_up':
        return 100; // $100/month
      case 'scale_down':
        return -50; // $50/month savings
      case 'optimize':
        return 20; // $20 one-time optimization cost
      default:
        return 0;
    }
  }

  private estimateBenefit(prediction: CapacityPrediction): number {
    // 簡易ベネフィット推定
    switch (prediction.action) {
      case 'scale_up':
        return 200; // Avoid downtime cost
      case 'scale_down':
        return 50; // Cost savings
      case 'optimize':
        return 80; // Performance improvement
      default:
        return 0;
    }
  }

  private generateCostOptimizations(): ScalingRecommendation[] {
    const optimizations: ScalingRecommendation[] = [];

    // 未使用リソースの検出
    const recentMetrics = this.metrics.slice(-20); // 最新20データポイント
    if (recentMetrics.length > 0) {
      const avgCpuUsage = recentMetrics.reduce((sum, m) => sum + m.cpu.usage, 0) / recentMetrics.length;
      const avgMemoryUsage = recentMetrics.reduce((sum, m) => sum + m.memory.usage, 0) / recentMetrics.length;

      if (avgCpuUsage < 30 && avgMemoryUsage < 40) {
        optimizations.push({
          id: this.generateRecommendationId(),
          timestamp: Date.now(),
          resource: 'compute',
          action: 'scale_down',
          priority: 'medium',
          currentValue: Math.max(avgCpuUsage, avgMemoryUsage),
          targetValue: 60,
          estimatedCost: -100,
          estimatedBenefit: 100,
          implementation: {
            steps: [
              'Review current resource allocation',
              'Reduce instance size or count',
              'Monitor performance metrics'
            ],
            estimatedTime: 60,
            riskLevel: 'medium'
          },
          metadata: {
            type: 'cost_optimization',
            avgCpuUsage,
            avgMemoryUsage
          }
        });
      }
    }

    return optimizations;
  }

  // === ユーティリティ ===
  private generateRecommendationId(): string {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2);
    return createHash('sha256').update(timestamp + random).digest('hex').substring(0, 12);
  }

  // === データ永続化 ===
  private loadHistoricalData(): void {
    try {
      if (existsSync(`${this.dataPath}/metrics.json`)) {
        const data = JSON.parse(readFileSync(`${this.dataPath}/metrics.json`, 'utf8'));
        this.metrics = data.metrics || [];
        this.predictions = data.predictions || [];
        this.recommendations = data.recommendations || [];
      }
    } catch (error) {
      console.error('Error loading historical data:', error);
    }
  }

  private saveHistoricalData(): void {
    try {
      const data = {
        metrics: this.metrics,
        predictions: this.predictions,
        recommendations: this.recommendations,
        lastSaved: Date.now()
      };

      // ディレクトリ作成
      require('fs').mkdirSync(this.dataPath, { recursive: true });
      
      writeFileSync(`${this.dataPath}/metrics.json`, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Error saving historical data:', error);
    }
  }

  // === 公開API ===
  getCurrentMetrics(): ResourceMetrics | null {
    return this.metrics.length > 0 ? this.metrics[this.metrics.length - 1] : null;
  }

  getMetricsHistory(hours: number = 24): ResourceMetrics[] {
    const cutoff = Date.now() - (hours * 60 * 60 * 1000);
    return this.metrics.filter(m => m.timestamp > cutoff);
  }

  getPredictions(): CapacityPrediction[] {
    return [...this.predictions];
  }

  getRecommendations(priority?: 'low' | 'medium' | 'high' | 'critical'): ScalingRecommendation[] {
    if (priority) {
      return this.recommendations.filter(r => r.priority === priority);
    }
    return [...this.recommendations];
  }

  getCapacityReport(): {
    current: ResourceMetrics | null;
    predictions: CapacityPrediction[];
    recommendations: ScalingRecommendation[];
    summary: {
      healthScore: number;
      riskLevel: 'low' | 'medium' | 'high' | 'critical';
      estimatedCostSavings: number;
      nextActionRequired: string;
    };
  } {
    const current = this.getCurrentMetrics();
    const predictions = this.getPredictions();
    const recommendations = this.getRecommendations();

    const healthScore = this.calculateHealthScore(current);
    const riskLevel = this.calculateOverallRiskLevel(predictions);
    const estimatedCostSavings = recommendations.reduce((sum, r) => sum + Math.max(0, -r.estimatedCost), 0);
    const nextActionRequired = this.getNextActionRequired(recommendations);

    return {
      current,
      predictions,
      recommendations,
      summary: {
        healthScore,
        riskLevel,
        estimatedCostSavings,
        nextActionRequired
      }
    };
  }

  private calculateHealthScore(metrics: ResourceMetrics | null): number {
    if (!metrics) return 50;

    const cpuScore = Math.max(0, 100 - metrics.cpu.usage);
    const memoryScore = Math.max(0, 100 - metrics.memory.usage);
    const storageScore = Math.max(0, 100 - metrics.storage.usage);

    return (cpuScore + memoryScore + storageScore) / 3;
  }

  private calculateOverallRiskLevel(predictions: CapacityPrediction[]): 'low' | 'medium' | 'high' | 'critical' {
    const criticalPredictions = predictions.filter(p => p.timeToLimit < 60 * 60 * 1000);
    const highRiskPredictions = predictions.filter(p => p.timeToLimit < 6 * 60 * 60 * 1000);

    if (criticalPredictions.length > 0) return 'critical';
    if (highRiskPredictions.length > 0) return 'high';
    if (predictions.some(p => p.recommendedAction !== 'none')) return 'medium';
    return 'low';
  }

  private getNextActionRequired(recommendations: ScalingRecommendation[]): string {
    const critical = recommendations.filter(r => r.priority === 'critical');
    const high = recommendations.filter(r => r.priority === 'high');

    if (critical.length > 0) {
      return `URGENT: ${critical[0].implementation.steps[0]}`;
    }
    if (high.length > 0) {
      return `High priority: ${high[0].implementation.steps[0]}`;
    }
    if (recommendations.length > 0) {
      return recommendations[0].implementation.steps[0];
    }
    return 'No action required';
  }

  // === 設定更新 ===
  updateConfig(newConfig: Partial<CapacityConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.emit('configUpdated', this.config);
  }

  getConfig(): CapacityConfig {
    return { ...this.config };
  }
}

// === ヘルパークラス ===
export class CapacityPlannerHelper {
  static createDefaultConfig(): CapacityConfig {
    return {
      monitoringInterval: 60000,
      retentionPeriod: 30,
      predictionWindow: 24,
      autoScalingEnabled: false,
      costOptimizationEnabled: true,
      thresholds: {
        cpu: { warning: 70, critical: 90 },
        memory: { warning: 80, critical: 95 },
        network: { connectionsWarning: 1000, connectionsCritical: 5000 },
        storage: { warning: 85, critical: 95 },
        mining: { minActiveMiners: 1, maxLoadPerMiner: 100 }
      }
    };
  }

  static createMiningPoolConfig(): CapacityConfig {
    return {
      monitoringInterval: 30000, // 30秒（マイニングプールは高頻度監視）
      retentionPeriod: 90, // 90日（長期トレンド分析）
      predictionWindow: 12, // 12時間（短期予測）
      autoScalingEnabled: true, // 自動スケーリング有効
      costOptimizationEnabled: true,
      thresholds: {
        cpu: { warning: 60, critical: 85 }, // マイニングプールは低めの閾値
        memory: { warning: 70, critical: 90 },
        network: { connectionsWarning: 500, connectionsCritical: 2000 },
        storage: { warning: 80, critical: 90 },
        mining: { minActiveMiners: 5, maxLoadPerMiner: 50 }
      }
    };
  }

  static formatMetrics(metrics: ResourceMetrics): string {
    return `
📊 Resource Metrics (${new Date(metrics.timestamp).toISOString()})
💻 CPU: ${metrics.cpu.usage.toFixed(1)}% (${metrics.cpu.cores} cores)
🧠 Memory: ${metrics.memory.usage.toFixed(1)}% (${(metrics.memory.used / 1024 / 1024).toFixed(0)}MB used)
🗄️ Storage: ${metrics.storage.usage.toFixed(1)}%
⛏️ Mining: ${metrics.mining.activeMiners} active miners, ${(metrics.mining.hashrate / 1000000).toFixed(2)}MH/s
`;
  }

  static formatRecommendation(rec: ScalingRecommendation): string {
    const priority = rec.priority.toUpperCase();
    const cost = rec.estimatedCost > 0 ? `+$${rec.estimatedCost}` : `-$${Math.abs(rec.estimatedCost)}`;
    
    return `
🎯 ${priority} RECOMMENDATION: ${rec.resource}
Action: ${rec.action}
Current: ${rec.currentValue.toFixed(1)}% → Target: ${rec.targetValue.toFixed(1)}%
Cost Impact: ${cost}/month, Benefit: $${rec.estimatedBenefit}
Implementation: ${rec.implementation.steps[0]}
Time Required: ${rec.implementation.estimatedTime} minutes
Risk Level: ${rec.implementation.riskLevel}
`;
  }
}

export default LightCapacityPlanner;