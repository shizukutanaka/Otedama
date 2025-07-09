/**
 * 高度なカナリアリリースシステム
 * 設計思想: John Carmack (効率性), Rob Pike (明確性), Robert C. Martin (拡張性)
 * 
 * 機能:
 * - 自動段階的トラフィック増加
 * - リアルタイムメトリクス監視
 * - 自動ロールバック機能
 * - ユーザーセグメント対応
 * - A/Bテスト統合
 * - カスタムメトリクス評価
 * - 自動決定アルゴリズム
 */

import { EventEmitter } from 'events';

// === 型定義 ===
export interface CanaryConfig {
  name: string;
  version: string;
  baselineVersion: string;
  trafficSteps: number[]; // [5, 10, 25, 50, 100] - percentage progression
  stepDuration: number; // minutes per step
  autoPromote: boolean;
  autoRollback: boolean;
  successCriteria: SuccessCriteria;
  userSegments?: UserSegment[];
  metrics: MetricConfig[];
  notifications: NotificationTarget[];
}

export interface SuccessCriteria {
  errorRate: {
    maxPercent: number;
    comparisonWindow: number; // minutes
  };
  responseTime: {
    maxPercentile95: number; // milliseconds
    maxIncrease: number; // percentage increase vs baseline
  };
  customMetrics: CustomMetricCriteria[];
  minimumSamples: number;
  confidenceLevel: number; // 0.95 = 95%
}

export interface CustomMetricCriteria {
  name: string;
  operator: 'greater_than' | 'less_than' | 'within_range' | 'equals';
  threshold: number | [number, number];
  weight: number; // 0-1, importance of this metric
}

export interface UserSegment {
  id: string;
  name: string;
  criteria: SegmentCriteria;
  percentage: number; // percentage of this segment to include in canary
}

export interface SegmentCriteria {
  countries?: string[];
  userAgent?: string[];
  userType?: 'new' | 'returning' | 'premium';
  customAttributes?: Record<string, any>;
}

export interface MetricConfig {
  name: string;
  source: 'prometheus' | 'newrelic' | 'datadog' | 'custom';
  query: string;
  aggregation: 'avg' | 'sum' | 'count' | 'p95' | 'p99';
  interval: number; // seconds
}

export interface NotificationTarget {
  type: 'slack' | 'email' | 'webhook' | 'pagerduty';
  target: string;
  events: CanaryEvent[];
}

export type CanaryEvent = 
  | 'canary_started'
  | 'step_completed'
  | 'promotion_triggered'
  | 'rollback_triggered'
  | 'canary_completed'
  | 'canary_failed';

export interface CanaryDeployment {
  id: string;
  config: CanaryConfig;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'rolled_back';
  currentStep: number;
  currentTrafficPercent: number;
  startTime: number;
  stepStartTime: number;
  endTime?: number;
  metrics: CanaryMetrics;
  analysis: CanaryAnalysis;
  history: CanaryStepHistory[];
}

export interface CanaryMetrics {
  canary: MetricSnapshot;
  baseline: MetricSnapshot;
  comparison: MetricComparison;
  lastUpdated: number;
}

export interface MetricSnapshot {
  errorRate: number;
  responseTimeP95: number;
  requestCount: number;
  uniqueUsers: number;
  customMetrics: Record<string, number>;
}

export interface MetricComparison {
  errorRateDelta: number; // percentage points
  responseTimeDelta: number; // percentage change
  significantDifference: boolean;
  confidence: number;
  recommendation: 'continue' | 'pause' | 'rollback' | 'promote';
}

export interface CanaryAnalysis {
  score: number; // 0-100, overall health score
  successCriteriaResults: SuccessCriteriaResult[];
  recommendations: AnalysisRecommendation[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  nextAction: 'wait' | 'promote' | 'rollback' | 'manual_review';
}

export interface SuccessCriteriaResult {
  criteria: string;
  passed: boolean;
  currentValue: number;
  threshold: number;
  weight: number;
  impact: number;
}

export interface AnalysisRecommendation {
  type: 'warning' | 'error' | 'info' | 'success';
  message: string;
  action?: string;
  priority: number;
}

export interface CanaryStepHistory {
  step: number;
  trafficPercent: number;
  startTime: number;
  endTime: number;
  duration: number;
  metrics: MetricSnapshot;
  decision: 'continued' | 'paused' | 'rolled_back';
  reason: string;
}

export interface TrafficSplitRule {
  id: string;
  priority: number;
  conditions: TrafficCondition[];
  action: 'canary' | 'baseline' | 'exclude';
  percentage: number;
}

export interface TrafficCondition {
  type: 'header' | 'query' | 'cookie' | 'ip' | 'user_segment';
  key: string;
  operator: 'equals' | 'contains' | 'matches' | 'in_list';
  value: string | string[];
}

// === 統計分析ユーティリティ ===
class StatisticalAnalyzer {
  // ウェルチのt検定（等分散を仮定しない）
  static welchTTest(
    sample1: number[],
    sample2: number[],
    alpha: number = 0.05
  ): {
    tStatistic: number;
    pValue: number;
    significant: boolean;
    confidenceInterval: [number, number];
  } {
    const n1 = sample1.length;
    const n2 = sample2.length;
    
    if (n1 < 2 || n2 < 2) {
      return {
        tStatistic: 0,
        pValue: 1,
        significant: false,
        confidenceInterval: [0, 0]
      };
    }

    const mean1 = sample1.reduce((sum, x) => sum + x, 0) / n1;
    const mean2 = sample2.reduce((sum, x) => sum + x, 0) / n2;
    
    const var1 = sample1.reduce((sum, x) => sum + Math.pow(x - mean1, 2), 0) / (n1 - 1);
    const var2 = sample2.reduce((sum, x) => sum + Math.pow(x - mean2, 2), 0) / (n2 - 1);
    
    const pooledSE = Math.sqrt(var1 / n1 + var2 / n2);
    const tStatistic = (mean1 - mean2) / pooledSE;
    
    // 自由度計算（ウェルチの式）
    const df = Math.pow(var1 / n1 + var2 / n2, 2) / 
               (Math.pow(var1 / n1, 2) / (n1 - 1) + Math.pow(var2 / n2, 2) / (n2 - 1));
    
    // p値計算（簡略化）
    const pValue = this.tDistributionCDF(Math.abs(tStatistic), df) * 2;
    
    // 信頼区間
    const tCritical = this.tDistributionQuantile(1 - alpha / 2, df);
    const marginOfError = tCritical * pooledSE;
    const confidenceInterval: [number, number] = [
      (mean1 - mean2) - marginOfError,
      (mean1 - mean2) + marginOfError
    ];

    return {
      tStatistic,
      pValue,
      significant: pValue < alpha,
      confidenceInterval
    };
  }

  // ベイジアン統計的検定
  static bayesianTest(
    canarySuccesses: number,
    canaryTotal: number,
    baselineSuccesses: number,
    baselineTotal: number
  ): {
    probability: number;
    credibleInterval: [number, number];
    recommendation: 'continue' | 'rollback' | 'promote';
  } {
    // ベータ分布のパラメータ
    const alpha1 = canarySuccesses + 1;
    const beta1 = canaryTotal - canarySuccesses + 1;
    const alpha2 = baselineSuccesses + 1;
    const beta2 = baselineTotal - baselineSuccesses + 1;

    // モンテカルロシミュレーション
    const simulations = 10000;
    let canaryBetter = 0;
    
    for (let i = 0; i < simulations; i++) {
      const canaryRate = this.betaRandom(alpha1, beta1);
      const baselineRate = this.betaRandom(alpha2, beta2);
      
      if (canaryRate > baselineRate) {
        canaryBetter++;
      }
    }

    const probability = canaryBetter / simulations;
    
    // 信頼区間（簡略化）
    const credibleInterval: [number, number] = [
      probability - 0.05,
      probability + 0.05
    ];

    let recommendation: 'continue' | 'rollback' | 'promote';
    if (probability > 0.95) {
      recommendation = 'promote';
    } else if (probability < 0.05) {
      recommendation = 'rollback';
    } else {
      recommendation = 'continue';
    }

    return {
      probability,
      credibleInterval,
      recommendation
    };
  }

  private static betaRandom(alpha: number, beta: number): number {
    // Box-Muller変換を使ったベータ分布の近似
    const u = Math.random();
    const v = Math.random();
    
    const x = Math.pow(u, 1 / alpha);
    const y = Math.pow(v, 1 / beta);
    
    return x / (x + y);
  }

  private static tDistributionCDF(t: number, df: number): number {
    // t分布の累積分布関数の近似
    return 0.5 + (t / Math.sqrt(df)) * (1 - Math.pow(t, 2) / (4 * df));
  }

  private static tDistributionQuantile(p: number, df: number): number {
    // t分布の分位関数の近似
    if (df >= 30) {
      // 正規分布で近似
      return this.normalQuantile(p);
    }
    
    // 簡略化したt分布分位関数
    const z = this.normalQuantile(p);
    return z * (1 + (z * z + 1) / (4 * df));
  }

  private static normalQuantile(p: number): number {
    // 標準正規分布の分位関数（Beasley-Springer-Moro algorithm）
    const a = [0, -3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [0, -5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    if (p === 0.5) return 0;

    const r = p < 0.5 ? p : 1 - p;
    const t = Math.sqrt(-2 * Math.log(r));
    
    let num = a[6];
    for (let i = 5; i >= 0; i--) {
      num = num * t + a[i];
    }
    
    let den = b[5];
    for (let i = 4; i >= 0; i--) {
      den = den * t + b[i];
    }
    
    const result = t + num / den;
    return p < 0.5 ? -result : result;
  }
}

// === メインカナリアリリースシステム ===
export class CanaryReleaseSystem extends EventEmitter {
  private activeDeployments = new Map<string, CanaryDeployment>();
  private trafficRules = new Map<string, TrafficSplitRule[]>();
  private metricSources = new Map<string, any>();
  private analysisTimer?: NodeJS.Timeout;
  
  constructor() {
    super();
    this.startMetricsAnalysis();
  }

  // === カナリアデプロイメント開始 ===
  async startCanaryDeployment(config: CanaryConfig): Promise<string> {
    const deploymentId = this.generateDeploymentId();
    
    const deployment: CanaryDeployment = {
      id: deploymentId,
      config,
      status: 'running',
      currentStep: 0,
      currentTrafficPercent: config.trafficSteps[0] || 5,
      startTime: Date.now(),
      stepStartTime: Date.now(),
      metrics: this.getInitialMetrics(),
      analysis: this.getInitialAnalysis(),
      history: []
    };

    this.activeDeployments.set(deploymentId, deployment);
    
    // 初期トラフィック分割設定
    await this.updateTrafficSplit(deploymentId, deployment.currentTrafficPercent);
    
    console.log(`🐤 Started canary deployment: ${config.name} v${config.version}`);
    console.log(`📊 Initial traffic: ${deployment.currentTrafficPercent}%`);
    
    this.emit('canary_started', deployment);
    this.sendNotification(deployment, 'canary_started');
    
    return deploymentId;
  }

  // === カナリア進行管理 ===
  async advanceCanaryStep(deploymentId: string): Promise<boolean> {
    const deployment = this.activeDeployments.get(deploymentId);
    if (!deployment || deployment.status !== 'running') {
      return false;
    }

    const config = deployment.config;
    const currentStepIndex = deployment.currentStep;
    
    // 現在のステップの結果を記録
    await this.recordStepHistory(deployment);
    
    // 次のステップがあるかチェック
    if (currentStepIndex + 1 >= config.trafficSteps.length) {
      // 最終ステップ完了 - プロモーション
      return this.promoteCanary(deploymentId);
    }

    // 次のステップに進む
    deployment.currentStep = currentStepIndex + 1;
    deployment.currentTrafficPercent = config.trafficSteps[deployment.currentStep];
    deployment.stepStartTime = Date.now();

    await this.updateTrafficSplit(deploymentId, deployment.currentTrafficPercent);

    console.log(`📈 Advanced canary to step ${deployment.currentStep + 1}: ${deployment.currentTrafficPercent}% traffic`);
    
    this.emit('step_completed', deployment);
    this.sendNotification(deployment, 'step_completed');
    
    return true;
  }

  // === 自動分析と決定 ===
  private startMetricsAnalysis(): void {
    this.analysisTimer = setInterval(async () => {
      for (const [deploymentId, deployment] of this.activeDeployments) {
        if (deployment.status === 'running') {
          await this.analyzeCanaryMetrics(deploymentId);
          await this.makeAutomaticDecision(deploymentId);
        }
      }
    }, 30000); // 30秒ごと
  }

  private async analyzeCanaryMetrics(deploymentId: string): Promise<void> {
    const deployment = this.activeDeployments.get(deploymentId);
    if (!deployment) return;

    // メトリクス収集
    const canaryMetrics = await this.collectMetrics(deployment, 'canary');
    const baselineMetrics = await this.collectMetrics(deployment, 'baseline');
    
    // 統計的比較
    const comparison = await this.compareMetrics(canaryMetrics, baselineMetrics);
    
    // 成功基準評価
    const criteriaResults = this.evaluateSuccessCriteria(
      deployment.config.successCriteria,
      canaryMetrics,
      baselineMetrics,
      comparison
    );

    // 全体的な分析スコア計算
    const score = this.calculateHealthScore(criteriaResults);
    const riskLevel = this.assessRiskLevel(score, comparison);
    const nextAction = this.determineNextAction(score, riskLevel, criteriaResults);

    // 推奨事項生成
    const recommendations = this.generateRecommendations(criteriaResults, comparison);

    // 結果を更新
    deployment.metrics = {
      canary: canaryMetrics,
      baseline: baselineMetrics,
      comparison,
      lastUpdated: Date.now()
    };

    deployment.analysis = {
      score,
      successCriteriaResults: criteriaResults,
      recommendations,
      riskLevel,
      nextAction
    };

    this.emit('metrics_updated', deployment);
  }

  private async makeAutomaticDecision(deploymentId: string): Promise<void> {
    const deployment = this.activeDeployments.get(deploymentId);
    if (!deployment) return;

    const config = deployment.config;
    const analysis = deployment.analysis;
    
    // ステップ持続時間チェック
    const stepDuration = Date.now() - deployment.stepStartTime;
    const requiredDuration = config.stepDuration * 60 * 1000; // minutes to ms
    
    if (stepDuration < requiredDuration) {
      return; // まだ十分な時間が経過していない
    }

    // 自動決定ロジック
    switch (analysis.nextAction) {
      case 'rollback':
        if (config.autoRollback) {
          console.log(`🚨 Auto-rollback triggered for ${deployment.id}: Risk level ${analysis.riskLevel}`);
          await this.rollbackCanary(deploymentId, 'Automatic rollback due to high risk');
        } else {
          console.log(`⚠️ Manual rollback recommended for ${deployment.id}`);
          deployment.status = 'paused';
        }
        break;

      case 'promote':
        if (config.autoPromote && analysis.score >= 90) {
          console.log(`🚀 Auto-promotion triggered for ${deployment.id}: Score ${analysis.score}`);
          await this.promoteCanary(deploymentId);
        } else {
          console.log(`✅ Manual promotion recommended for ${deployment.id}`);
        }
        break;

      case 'wait':
        if (deployment.currentStep < config.trafficSteps.length - 1) {
          console.log(`📊 Advancing canary step for ${deployment.id}: Score ${analysis.score}`);
          await this.advanceCanaryStep(deploymentId);
        }
        break;

      case 'manual_review':
        console.log(`👀 Manual review required for ${deployment.id}`);
        deployment.status = 'paused';
        break;
    }
  }

  // === メトリクス収集 ===
  private async collectMetrics(
    deployment: CanaryDeployment,
    variant: 'canary' | 'baseline'
  ): Promise<MetricSnapshot> {
    const config = deployment.config;
    const metrics: MetricSnapshot = {
      errorRate: 0,
      responseTimeP95: 0,
      requestCount: 0,
      uniqueUsers: 0,
      customMetrics: {}
    };

    try {
      // 各メトリクスソースからデータ収集
      for (const metricConfig of config.metrics) {
        const value = await this.queryMetricSource(metricConfig, variant);
        
        switch (metricConfig.name) {
          case 'error_rate':
            metrics.errorRate = value;
            break;
          case 'response_time_p95':
            metrics.responseTimeP95 = value;
            break;
          case 'request_count':
            metrics.requestCount = value;
            break;
          case 'unique_users':
            metrics.uniqueUsers = value;
            break;
          default:
            metrics.customMetrics[metricConfig.name] = value;
        }
      }

      // モックデータ（実装時は実際のメトリクスソースから取得）
      if (variant === 'canary') {
        metrics.errorRate = Math.random() * 2; // 0-2%
        metrics.responseTimeP95 = 200 + Math.random() * 100; // 200-300ms
        metrics.requestCount = Math.floor(Math.random() * 1000 + 500);
        metrics.uniqueUsers = Math.floor(metrics.requestCount * 0.7);
      } else {
        metrics.errorRate = Math.random() * 1.5; // 0-1.5%
        metrics.responseTimeP95 = 180 + Math.random() * 80; // 180-260ms
        metrics.requestCount = Math.floor(Math.random() * 5000 + 2000);
        metrics.uniqueUsers = Math.floor(metrics.requestCount * 0.8);
      }

    } catch (error) {
      console.error(`Failed to collect metrics for ${variant}:`, error);
    }

    return metrics;
  }

  private async queryMetricSource(
    metricConfig: MetricConfig,
    variant: 'canary' | 'baseline'
  ): Promise<number> {
    // 実際の実装では、各メトリクスソースのAPIを呼び出す
    switch (metricConfig.source) {
      case 'prometheus':
        return this.queryPrometheus(metricConfig.query, variant);
      case 'newrelic':
        return this.queryNewRelic(metricConfig.query, variant);
      case 'datadog':
        return this.queryDataDog(metricConfig.query, variant);
      default:
        return Math.random() * 100; // Mock data
    }
  }

  private async queryPrometheus(query: string, variant: string): Promise<number> {
    // Prometheus API クエリのシミュレーション
    console.log(`📊 Querying Prometheus: ${query} (${variant})`);
    return Math.random() * 100;
  }

  private async queryNewRelic(query: string, variant: string): Promise<number> {
    // New Relic API クエリのシミュレーション
    console.log(`📊 Querying New Relic: ${query} (${variant})`);
    return Math.random() * 100;
  }

  private async queryDataDog(query: string, variant: string): Promise<number> {
    // DataDog API クエリのシミュレーション
    console.log(`📊 Querying DataDog: ${query} (${variant})`);
    return Math.random() * 100;
  }

  // === 統計的比較 ===
  private async compareMetrics(
    canary: MetricSnapshot,
    baseline: MetricSnapshot
  ): Promise<MetricComparison> {
    // エラー率の比較
    const errorRateDelta = canary.errorRate - baseline.errorRate;
    
    // レスポンス時間の変化率
    const responseTimeDelta = baseline.responseTimeP95 > 0 
      ? ((canary.responseTimeP95 - baseline.responseTimeP95) / baseline.responseTimeP95) * 100
      : 0;

    // 統計的有意性の計算（簡略化）
    const minSamples = Math.min(canary.requestCount, baseline.requestCount);
    const significantDifference = minSamples > 100 && (
      Math.abs(errorRateDelta) > 0.5 || Math.abs(responseTimeDelta) > 10
    );

    // 信頼度計算
    const confidence = Math.min(95, Math.max(50, minSamples / 10));

    // 推奨事項
    let recommendation: MetricComparison['recommendation'];
    if (errorRateDelta > 1 || responseTimeDelta > 20) {
      recommendation = 'rollback';
    } else if (errorRateDelta < -0.5 && responseTimeDelta < 5) {
      recommendation = 'promote';
    } else if (significantDifference) {
      recommendation = 'pause';
    } else {
      recommendation = 'continue';
    }

    return {
      errorRateDelta,
      responseTimeDelta,
      significantDifference,
      confidence,
      recommendation
    };
  }

  // === 成功基準評価 ===
  private evaluateSuccessCriteria(
    criteria: SuccessCriteria,
    canary: MetricSnapshot,
    baseline: MetricSnapshot,
    comparison: MetricComparison
  ): SuccessCriteriaResult[] {
    const results: SuccessCriteriaResult[] = [];

    // エラー率評価
    const errorRatePassed = canary.errorRate <= criteria.errorRate.maxPercent;
    results.push({
      criteria: 'Error Rate',
      passed: errorRatePassed,
      currentValue: canary.errorRate,
      threshold: criteria.errorRate.maxPercent,
      weight: 0.4,
      impact: errorRatePassed ? 0 : (canary.errorRate - criteria.errorRate.maxPercent)
    });

    // レスポンス時間評価
    const responseTimePassed = canary.responseTimeP95 <= criteria.responseTime.maxPercentile95 &&
                              comparison.responseTimeDelta <= criteria.responseTime.maxIncrease;
    results.push({
      criteria: 'Response Time',
      passed: responseTimePassed,
      currentValue: canary.responseTimeP95,
      threshold: criteria.responseTime.maxPercentile95,
      weight: 0.3,
      impact: responseTimePassed ? 0 : Math.max(
        canary.responseTimeP95 - criteria.responseTime.maxPercentile95,
        comparison.responseTimeDelta - criteria.responseTime.maxIncrease
      )
    });

    // カスタムメトリクス評価
    for (const customCriteria of criteria.customMetrics) {
      const currentValue = canary.customMetrics[customCriteria.name] || 0;
      let passed = false;

      switch (customCriteria.operator) {
        case 'greater_than':
          passed = currentValue > customCriteria.threshold as number;
          break;
        case 'less_than':
          passed = currentValue < customCriteria.threshold as number;
          break;
        case 'within_range':
          const [min, max] = customCriteria.threshold as [number, number];
          passed = currentValue >= min && currentValue <= max;
          break;
        case 'equals':
          passed = Math.abs(currentValue - (customCriteria.threshold as number)) < 0.01;
          break;
      }

      results.push({
        criteria: customCriteria.name,
        passed,
        currentValue,
        threshold: Array.isArray(customCriteria.threshold) 
          ? customCriteria.threshold[0] 
          : customCriteria.threshold,
        weight: customCriteria.weight,
        impact: passed ? 0 : Math.abs(currentValue - (customCriteria.threshold as number))
      });
    }

    // 最小サンプル数評価
    const samplesEnough = canary.requestCount >= criteria.minimumSamples;
    results.push({
      criteria: 'Minimum Samples',
      passed: samplesEnough,
      currentValue: canary.requestCount,
      threshold: criteria.minimumSamples,
      weight: 0.1,
      impact: samplesEnough ? 0 : (criteria.minimumSamples - canary.requestCount)
    });

    return results;
  }

  // === スコア計算 ===
  private calculateHealthScore(results: SuccessCriteriaResult[]): number {
    let weightedScore = 0;
    let totalWeight = 0;

    for (const result of results) {
      const criteriaScore = result.passed ? 100 : Math.max(0, 100 - result.impact * 10);
      weightedScore += criteriaScore * result.weight;
      totalWeight += result.weight;
    }

    return totalWeight > 0 ? weightedScore / totalWeight : 0;
  }

  private assessRiskLevel(
    score: number,
    comparison: MetricComparison
  ): CanaryAnalysis['riskLevel'] {
    if (score < 50 || comparison.errorRateDelta > 2) {
      return 'critical';
    } else if (score < 70 || comparison.responseTimeDelta > 30) {
      return 'high';
    } else if (score < 85 || comparison.significantDifference) {
      return 'medium';
    }
    return 'low';
  }

  private determineNextAction(
    score: number,
    riskLevel: CanaryAnalysis['riskLevel'],
    results: SuccessCriteriaResult[]
  ): CanaryAnalysis['nextAction'] {
    if (riskLevel === 'critical' || score < 50) {
      return 'rollback';
    } else if (score >= 95 && riskLevel === 'low') {
      return 'promote';
    } else if (riskLevel === 'high' || results.some(r => !r.passed && r.weight > 0.3)) {
      return 'manual_review';
    }
    return 'wait';
  }

  private generateRecommendations(
    results: SuccessCriteriaResult[],
    comparison: MetricComparison
  ): AnalysisRecommendation[] {
    const recommendations: AnalysisRecommendation[] = [];

    // 失敗した基準について推奨事項を生成
    for (const result of results) {
      if (!result.passed) {
        if (result.criteria === 'Error Rate') {
          recommendations.push({
            type: 'error',
            message: `Error rate (${result.currentValue.toFixed(2)}%) exceeds threshold (${result.threshold}%)`,
            action: 'Consider rolling back or investigating error causes',
            priority: 1
          });
        } else if (result.criteria === 'Response Time') {
          recommendations.push({
            type: 'warning',
            message: `Response time (${result.currentValue.toFixed(0)}ms) exceeds threshold (${result.threshold}ms)`,
            action: 'Monitor performance and consider optimization',
            priority: 2
          });
        }
      }
    }

    // 統計的有意性について
    if (comparison.significantDifference) {
      recommendations.push({
        type: 'info',
        message: `Statistically significant difference detected (confidence: ${comparison.confidence.toFixed(1)}%)`,
        action: 'Continue monitoring or extend testing period',
        priority: 3
      });
    }

    return recommendations.sort((a, b) => a.priority - b.priority);
  }

  // === トラフィック管理 ===
  private async updateTrafficSplit(
    deploymentId: string,
    canaryPercent: number
  ): Promise<void> {
    const deployment = this.activeDeployments.get(deploymentId);
    if (!deployment) return;

    console.log(`🔀 Updating traffic split: ${canaryPercent}% to canary, ${100 - canaryPercent}% to baseline`);

    // 実際の実装では、ロードバランサーやサービスメッシュを更新
    // 例: Istio, Nginx, HAProxy, AWS ALB, etc.
    
    // トラフィックルールを更新
    const rules: TrafficSplitRule[] = [
      {
        id: 'canary-rule',
        priority: 1,
        conditions: [],
        action: 'canary',
        percentage: canaryPercent
      },
      {
        id: 'baseline-rule',
        priority: 2,
        conditions: [],
        action: 'baseline',
        percentage: 100 - canaryPercent
      }
    ];

    this.trafficRules.set(deploymentId, rules);
    
    // ロードバランサー設定更新のシミュレーション
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    this.emit('traffic_updated', { deploymentId, canaryPercent });
  }

  // === カナリープロモーション ===
  async promoteCanary(deploymentId: string): Promise<boolean> {
    const deployment = this.activeDeployments.get(deploymentId);
    if (!deployment) return false;

    console.log(`🚀 Promoting canary deployment: ${deployment.config.name} v${deployment.config.version}`);

    // 100%トラフィックをカナリアに切り替え
    await this.updateTrafficSplit(deploymentId, 100);

    // ステータス更新
    deployment.status = 'completed';
    deployment.endTime = Date.now();
    deployment.currentTrafficPercent = 100;

    // 履歴記録
    await this.recordStepHistory(deployment);

    console.log(`✅ Canary promotion completed: ${deployment.id}`);
    
    this.emit('promotion_triggered', deployment);
    this.sendNotification(deployment, 'promotion_triggered');
    
    // カナリア完了通知
    this.emit('canary_completed', deployment);
    this.sendNotification(deployment, 'canary_completed');

    return true;
  }

  // === カナリアロールバック ===
  async rollbackCanary(deploymentId: string, reason: string): Promise<boolean> {
    const deployment = this.activeDeployments.get(deploymentId);
    if (!deployment) return false;

    console.log(`🔄 Rolling back canary deployment: ${deployment.id}`);
    console.log(`📝 Reason: ${reason}`);

    // トラフィックを100%ベースラインに戻す
    await this.updateTrafficSplit(deploymentId, 0);

    // ステータス更新
    deployment.status = 'rolled_back';
    deployment.endTime = Date.now();
    deployment.currentTrafficPercent = 0;

    // 履歴記録
    await this.recordStepHistory(deployment);

    console.log(`✅ Canary rollback completed: ${deployment.id}`);
    
    this.emit('rollback_triggered', { deployment, reason });
    this.sendNotification(deployment, 'rollback_triggered');

    return true;
  }

  // === 履歴記録 ===
  private async recordStepHistory(deployment: CanaryDeployment): Promise<void> {
    const stepHistory: CanaryStepHistory = {
      step: deployment.currentStep,
      trafficPercent: deployment.currentTrafficPercent,
      startTime: deployment.stepStartTime,
      endTime: Date.now(),
      duration: Date.now() - deployment.stepStartTime,
      metrics: deployment.metrics.canary,
      decision: deployment.status === 'rolled_back' ? 'rolled_back' : 'continued',
      reason: deployment.analysis.nextAction
    };

    deployment.history.push(stepHistory);
  }

  // === 通知 ===
  private sendNotification(deployment: CanaryDeployment, event: CanaryEvent): void {
    for (const notification of deployment.config.notifications) {
      if (notification.events.includes(event)) {
        this.deliverNotification(notification, deployment, event);
      }
    }
  }

  private deliverNotification(
    notification: NotificationTarget,
    deployment: CanaryDeployment,
    event: CanaryEvent
  ): void {
    const message = this.formatNotificationMessage(deployment, event);
    
    console.log(`📢 ${notification.type.toUpperCase()} notification to ${notification.target}: ${message}`);
    
    // 実際の実装では、各通知サービスのAPIを呼び出す
    switch (notification.type) {
      case 'slack':
        // Slack webhook
        break;
      case 'email':
        // Email service
        break;
      case 'webhook':
        // HTTP webhook
        break;
      case 'pagerduty':
        // PagerDuty API
        break;
    }
  }

  private formatNotificationMessage(deployment: CanaryDeployment, event: CanaryEvent): string {
    const config = deployment.config;
    const analysis = deployment.analysis;
    
    switch (event) {
      case 'canary_started':
        return `🐤 Canary deployment started: ${config.name} v${config.version} (${deployment.currentTrafficPercent}% traffic)`;
      case 'step_completed':
        return `📈 Canary step completed: ${config.name} step ${deployment.currentStep + 1} (${deployment.currentTrafficPercent}% traffic, score: ${analysis.score.toFixed(0)})`;
      case 'promotion_triggered':
        return `🚀 Canary promoted: ${config.name} v${config.version} (final score: ${analysis.score.toFixed(0)})`;
      case 'rollback_triggered':
        return `🔄 Canary rolled back: ${config.name} v${config.version} (risk: ${analysis.riskLevel})`;
      case 'canary_completed':
        return `✅ Canary deployment completed: ${config.name} v${config.version}`;
      case 'canary_failed':
        return `❌ Canary deployment failed: ${config.name} v${config.version}`;
      default:
        return `Canary event: ${event}`;
    }
  }

  // === ユーティリティ ===
  private generateDeploymentId(): string {
    return `canary-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private getInitialMetrics(): CanaryMetrics {
    const emptySnapshot: MetricSnapshot = {
      errorRate: 0,
      responseTimeP95: 0,
      requestCount: 0,
      uniqueUsers: 0,
      customMetrics: {}
    };

    return {
      canary: emptySnapshot,
      baseline: emptySnapshot,
      comparison: {
        errorRateDelta: 0,
        responseTimeDelta: 0,
        significantDifference: false,
        confidence: 0,
        recommendation: 'continue'
      },
      lastUpdated: Date.now()
    };
  }

  private getInitialAnalysis(): CanaryAnalysis {
    return {
      score: 100,
      successCriteriaResults: [],
      recommendations: [],
      riskLevel: 'low',
      nextAction: 'wait'
    };
  }

  // === パブリック API ===
  getActiveDeployments(): CanaryDeployment[] {
    return Array.from(this.activeDeployments.values());
  }

  getDeployment(deploymentId: string): CanaryDeployment | null {
    return this.activeDeployments.get(deploymentId) || null;
  }

  async pauseDeployment(deploymentId: string): Promise<boolean> {
    const deployment = this.activeDeployments.get(deploymentId);
    if (deployment && deployment.status === 'running') {
      deployment.status = 'paused';
      console.log(`⏸️ Paused canary deployment: ${deploymentId}`);
      return true;
    }
    return false;
  }

  async resumeDeployment(deploymentId: string): Promise<boolean> {
    const deployment = this.activeDeployments.get(deploymentId);
    if (deployment && deployment.status === 'paused') {
      deployment.status = 'running';
      deployment.stepStartTime = Date.now();
      console.log(`▶️ Resumed canary deployment: ${deploymentId}`);
      return true;
    }
    return false;
  }

  async forcePromote(deploymentId: string): Promise<boolean> {
    console.log(`🚀 Force promoting canary deployment: ${deploymentId}`);
    return this.promoteCanary(deploymentId);
  }

  async forceRollback(deploymentId: string, reason: string = 'Manual rollback'): Promise<boolean> {
    console.log(`🔄 Force rolling back canary deployment: ${deploymentId}`);
    return this.rollbackCanary(deploymentId, reason);
  }

  // === レポート生成 ===
  generateDeploymentReport(deploymentId: string): string {
    const deployment = this.activeDeployments.get(deploymentId);
    if (!deployment) return 'Deployment not found';

    const config = deployment.config;
    const analysis = deployment.analysis;
    const duration = deployment.endTime 
      ? deployment.endTime - deployment.startTime
      : Date.now() - deployment.startTime;

    const lines = [
      `=== Canary Deployment Report ===`,
      `ID: ${deployment.id}`,
      `Application: ${config.name}`,
      `Version: ${config.version}`,
      `Status: ${deployment.status}`,
      `Duration: ${Math.round(duration / 60000)} minutes`,
      `Current Step: ${deployment.currentStep + 1}/${config.trafficSteps.length}`,
      `Current Traffic: ${deployment.currentTrafficPercent}%`,
      `Health Score: ${analysis.score.toFixed(1)}/100`,
      `Risk Level: ${analysis.riskLevel}`,
      ``,
      `Metrics Comparison:`,
      `- Error Rate: Canary ${deployment.metrics.canary.errorRate.toFixed(2)}% vs Baseline ${deployment.metrics.baseline.errorRate.toFixed(2)}%`,
      `- Response Time: Canary ${deployment.metrics.canary.responseTimeP95.toFixed(0)}ms vs Baseline ${deployment.metrics.baseline.responseTimeP95.toFixed(0)}ms`,
      `- Request Count: Canary ${deployment.metrics.canary.requestCount} vs Baseline ${deployment.metrics.baseline.requestCount}`,
      ``,
      `Success Criteria:`,
      ...analysis.successCriteriaResults.map(result => 
        `- ${result.criteria}: ${result.passed ? '✅' : '❌'} (${result.currentValue.toFixed(2)} vs threshold ${result.threshold})`
      ),
      ``,
      `Recommendations:`,
      ...analysis.recommendations.map(rec => 
        `- ${rec.type.toUpperCase()}: ${rec.message}`
      ),
      ``,
      `Step History:`,
      ...deployment.history.map((step, index) => 
        `${index + 1}. Step ${step.step + 1}: ${step.trafficPercent}% for ${Math.round(step.duration / 60000)}min -> ${step.decision}`
      )
    ];

    return lines.join('\n');
  }

  // === 停止処理 ===
  async shutdown(): Promise<void> {
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
    }

    // 進行中のカナリアを安全に停止
    for (const [deploymentId, deployment] of this.activeDeployments) {
      if (deployment.status === 'running') {
        await this.pauseDeployment(deploymentId);
      }
    }

    console.log('🛑 Canary Release System shutdown');
  }
}

// === ヘルパークラス ===
export class CanaryConfigHelper {
  static createStandardConfig(
    name: string,
    version: string,
    baselineVersion: string
  ): CanaryConfig {
    return {
      name,
      version,
      baselineVersion,
      trafficSteps: [5, 10, 25, 50, 100],
      stepDuration: 10, // minutes
      autoPromote: false,
      autoRollback: true,
      successCriteria: {
        errorRate: {
          maxPercent: 2.0,
          comparisonWindow: 10
        },
        responseTime: {
          maxPercentile95: 500,
          maxIncrease: 20
        },
        customMetrics: [],
        minimumSamples: 100,
        confidenceLevel: 0.95
      },
      metrics: [
        {
          name: 'error_rate',
          source: 'prometheus',
          query: 'rate(http_requests_total{status=~"5.."}[5m])',
          aggregation: 'avg',
          interval: 30
        },
        {
          name: 'response_time_p95',
          source: 'prometheus',
          query: 'histogram_quantile(0.95, http_request_duration_seconds_bucket)',
          aggregation: 'p95',
          interval: 30
        }
      ],
      notifications: [
        {
          type: 'slack',
          target: '#deployments',
          events: ['canary_started', 'promotion_triggered', 'rollback_triggered', 'canary_completed']
        }
      ]
    };
  }

  static createConservativeConfig(
    name: string,
    version: string,
    baselineVersion: string
  ): CanaryConfig {
    const config = this.createStandardConfig(name, version, baselineVersion);
    
    // より保守的な設定
    config.trafficSteps = [1, 5, 10, 25, 50, 100];
    config.stepDuration = 20; // 20 minutes per step
    config.autoPromote = false;
    config.autoRollback = true;
    config.successCriteria.errorRate.maxPercent = 1.0; // Stricter error rate
    config.successCriteria.responseTime.maxIncrease = 10; // Stricter response time
    config.successCriteria.minimumSamples = 500; // More samples required
    
    return config;
  }

  static createAggressiveConfig(
    name: string,
    version: string,
    baselineVersion: string
  ): CanaryConfig {
    const config = this.createStandardConfig(name, version, baselineVersion);
    
    // より積極的な設定
    config.trafficSteps = [10, 50, 100];
    config.stepDuration = 5; // 5 minutes per step
    config.autoPromote = true;
    config.autoRollback = true;
    config.successCriteria.errorRate.maxPercent = 3.0; // More lenient error rate
    config.successCriteria.responseTime.maxIncrease = 30; // More lenient response time
    config.successCriteria.minimumSamples = 50; // Fewer samples required
    
    return config;
  }
}

export default CanaryReleaseSystem;