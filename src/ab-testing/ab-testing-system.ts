/**
 * A/Bテスト・実験的機能システム
 * 設計思想: John Carmack (データ駆動), Rob Pike (シンプル), Robert C. Martin (拡張性)
 * 
 * 機能:
 * - マルチバリアント実験
 * - 統計的有意性検定
 * - ベイジアン分析
 * - リアルタイム結果監視
 * - 自動実験終了
 * - セグメント分析
 * - 機能フラグ統合
 * - 実験結果レポート
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';

// === 型定義 ===
export interface ExperimentConfig {
  id: string;
  name: string;
  description: string;
  type: 'ab_test' | 'multivariate' | 'feature_flag' | 'split_test';
  status: 'draft' | 'running' | 'paused' | 'completed' | 'stopped';
  startDate: number;
  endDate?: number;
  maxDuration: number; // milliseconds
  
  // トラフィック設定
  trafficAllocation: number; // 0-100, percentage of traffic to include
  variants: ExperimentVariant[];
  
  // ターゲティング
  targeting: TargetingRules;
  
  // 成功指標
  primaryMetric: Metric;
  secondaryMetrics: Metric[];
  guardRailMetrics: Metric[];
  
  // 統計設定
  statisticalConfig: StatisticalConfig;
  
  // 設定
  autoStart: boolean;
  autoStop: boolean;
  notificationConfig: NotificationConfig;
}

export interface ExperimentVariant {
  id: string;
  name: string;
  description: string;
  allocation: number; // percentage of experiment traffic
  config: VariantConfig;
  isControl: boolean;
}

export interface VariantConfig {
  featureFlags: Record<string, boolean>;
  parameters: Record<string, any>;
  uiChanges?: UIChange[];
  algorithmChanges?: AlgorithmChange[];
}

export interface UIChange {
  component: string;
  property: string;
  value: any;
}

export interface AlgorithmChange {
  algorithm: string;
  parameters: Record<string, any>;
}

export interface TargetingRules {
  includeRules: TargetingRule[];
  excludeRules: TargetingRule[];
  segments: string[]; // predefined user segments
}

export interface TargetingRule {
  attribute: string; // 'country', 'user_type', 'mining_device', 'custom'
  operator: 'equals' | 'not_equals' | 'in' | 'not_in' | 'contains' | 'greater_than' | 'less_than';
  value: any;
}

export interface Metric {
  id: string;
  name: string;
  type: 'conversion' | 'continuous' | 'count' | 'ratio';
  description: string;
  source: string; // SQL query, API endpoint, etc.
  aggregation: 'sum' | 'avg' | 'count' | 'median' | 'p95' | 'p99';
  higherIsBetter: boolean;
  minimumDetectableEffect: number; // percentage
}

export interface StatisticalConfig {
  significanceLevel: number; // typically 0.05
  statisticalPower: number; // typically 0.8
  minimumSampleSize: number;
  maxSampleSize?: number;
  sequentialTesting: boolean;
  bayesianAnalysis: boolean;
  falseDiscoveryRate: number; // for multiple comparisons
}

export interface NotificationConfig {
  channels: NotificationChannel[];
  events: ExperimentEvent[];
  alerts: AlertConfig[];
}

export interface NotificationChannel {
  type: 'email' | 'slack' | 'webhook';
  target: string;
}

export type ExperimentEvent = 
  | 'experiment_started'
  | 'experiment_stopped'
  | 'significant_result'
  | 'guardrail_triggered'
  | 'sample_size_reached'
  | 'max_duration_reached';

export interface AlertConfig {
  metric: string;
  condition: 'improvement' | 'degradation' | 'no_change';
  threshold: number;
  enabled: boolean;
}

export interface ExperimentResult {
  experimentId: string;
  status: 'running' | 'completed' | 'inconclusive';
  startTime: number;
  endTime?: number;
  duration: number;
  totalSamples: number;
  
  // バリアント結果
  variantResults: VariantResult[];
  
  // 統計的分析
  statisticalAnalysis: StatisticalAnalysis;
  
  // 推奨事項
  recommendation: ExperimentRecommendation;
  
  // レポート
  summary: ExperimentSummary;
}

export interface VariantResult {
  variantId: string;
  name: string;
  samples: number;
  metrics: MetricResult[];
  conversionData?: ConversionData;
}

export interface MetricResult {
  metricId: string;
  name: string;
  value: number;
  variance: number;
  confidenceInterval: [number, number];
  improvement: number; // percentage vs control
  significance: number; // p-value
  effect: 'positive' | 'negative' | 'neutral';
}

export interface ConversionData {
  conversions: number;
  sessions: number;
  conversionRate: number;
  confidenceInterval: [number, number];
}

export interface StatisticalAnalysis {
  method: 'frequentist' | 'bayesian' | 'both';
  primaryMetricAnalysis: MetricAnalysis;
  secondaryMetricAnalyses: MetricAnalysis[];
  guardrailMetricAnalyses: MetricAnalysis[];
  multipleComparisonCorrection: boolean;
  overallSignificance: boolean;
  recommendation: 'winner_found' | 'continue_test' | 'stop_test' | 'inconclusive';
}

export interface MetricAnalysis {
  metricId: string;
  winner?: string; // variant ID
  winnerProbability: number;
  liftEstimate: number;
  liftConfidenceInterval: [number, number];
  significanceLevel: number;
  statisticalPower: number;
  effectSize: number;
  sampleSizeRecommendation: number;
}

export interface ExperimentRecommendation {
  action: 'implement_winner' | 'extend_test' | 'stop_test' | 'redesign_test';
  confidence: number; // 0-100
  reasons: string[];
  riskAssessment: RiskAssessment;
  businessImpact: BusinessImpact;
}

export interface RiskAssessment {
  level: 'low' | 'medium' | 'high';
  factors: string[];
  mitigations: string[];
}

export interface BusinessImpact {
  expectedLift: number;
  revenueImpact: number;
  userImpact: number;
  implementationComplexity: 'low' | 'medium' | 'high';
}

export interface ExperimentSummary {
  keyFindings: string[];
  metrics: {
    primaryMetric: string;
    improvement: number;
    significance: number;
  };
  duration: string;
  sampleSize: number;
  conclusion: string;
}

export interface UserAssignment {
  userId: string;
  experimentId: string;
  variantId: string;
  assignmentTime: number;
  sessionId?: string;
  metadata: Record<string, any>;
}

// === 統計分析ユーティリティ ===
class StatisticalAnalyzer {
  // 独立標本t検定
  static tTest(
    sample1: number[],
    sample2: number[],
    alpha: number = 0.05
  ): {
    tStatistic: number;
    pValue: number;
    significant: boolean;
    effect: 'positive' | 'negative' | 'neutral';
    confidenceInterval: [number, number];
  } {
    const n1 = sample1.length;
    const n2 = sample2.length;
    
    if (n1 < 2 || n2 < 2) {
      return {
        tStatistic: 0,
        pValue: 1,
        significant: false,
        effect: 'neutral',
        confidenceInterval: [0, 0]
      };
    }

    const mean1 = sample1.reduce((sum, x) => sum + x, 0) / n1;
    const mean2 = sample2.reduce((sum, x) => sum + x, 0) / n2;
    
    const var1 = sample1.reduce((sum, x) => sum + Math.pow(x - mean1, 2), 0) / (n1 - 1);
    const var2 = sample2.reduce((sum, x) => sum + Math.pow(x - mean2, 2), 0) / (n2 - 1);
    
    const pooledVar = ((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2);
    const standardError = Math.sqrt(pooledVar * (1/n1 + 1/n2));
    
    const tStatistic = (mean1 - mean2) / standardError;
    const df = n1 + n2 - 2;
    
    // p値計算（簡略化）
    const pValue = this.tDistributionPValue(Math.abs(tStatistic), df) * 2;
    
    // 効果の方向
    let effect: 'positive' | 'negative' | 'neutral';
    if (Math.abs(tStatistic) < 0.1) {
      effect = 'neutral';
    } else {
      effect = tStatistic > 0 ? 'positive' : 'negative';
    }
    
    // 信頼区間
    const tCritical = 1.96; // 簡略化
    const marginOfError = tCritical * standardError;
    const confidenceInterval: [number, number] = [
      (mean1 - mean2) - marginOfError,
      (mean1 - mean2) + marginOfError
    ];

    return {
      tStatistic,
      pValue,
      significant: pValue < alpha,
      effect,
      confidenceInterval
    };
  }

  // カイ二乗検定（コンバージョン率比較）
  static chiSquareTest(
    conversions1: number,
    sessions1: number,
    conversions2: number,
    sessions2: number,
    alpha: number = 0.05
  ): {
    chiSquare: number;
    pValue: number;
    significant: boolean;
    effect: 'positive' | 'negative' | 'neutral';
    liftEstimate: number;
    confidenceInterval: [number, number];
  } {
    const rate1 = conversions1 / sessions1;
    const rate2 = conversions2 / sessions2;
    
    const pooledRate = (conversions1 + conversions2) / (sessions1 + sessions2);
    
    const expected1 = sessions1 * pooledRate;
    const expected2 = sessions2 * pooledRate;
    
    const chiSquare = Math.pow(conversions1 - expected1, 2) / expected1 +
                     Math.pow(sessions1 - conversions1 - (sessions1 - expected1), 2) / (sessions1 - expected1) +
                     Math.pow(conversions2 - expected2, 2) / expected2 +
                     Math.pow(sessions2 - conversions2 - (sessions2 - expected2), 2) / (sessions2 - expected2);
    
    // p値計算（簡略化）
    const pValue = this.chiSquarePValue(chiSquare, 1);
    
    // 効果とリフト
    const liftEstimate = ((rate1 - rate2) / rate2) * 100;
    let effect: 'positive' | 'negative' | 'neutral';
    if (Math.abs(liftEstimate) < 1) {
      effect = 'neutral';
    } else {
      effect = liftEstimate > 0 ? 'positive' : 'negative';
    }
    
    // 信頼区間（簡略化）
    const se = Math.sqrt(pooledRate * (1 - pooledRate) * (1/sessions1 + 1/sessions2));
    const marginOfError = 1.96 * se;
    const confidenceInterval: [number, number] = [
      rate1 - rate2 - marginOfError,
      rate1 - rate2 + marginOfError
    ];

    return {
      chiSquare,
      pValue,
      significant: pValue < alpha,
      effect,
      liftEstimate,
      confidenceInterval
    };
  }

  // ベイジアンA/Bテスト分析
  static bayesianAnalysis(
    conversions1: number,
    sessions1: number,
    conversions2: number,
    sessions2: number
  ): {
    probabilityB_Better: number;
    expectedLift: number;
    credibleInterval: [number, number];
    recommendation: 'implement_b' | 'keep_a' | 'continue_test';
  } {
    // ベータ分布のパラメータ
    const alpha1 = conversions1 + 1;
    const beta1 = sessions1 - conversions1 + 1;
    const alpha2 = conversions2 + 1;
    const beta2 = sessions2 - conversions2 + 1;

    // モンテカルロシミュレーション
    const simulations = 10000;
    let bBetter = 0;
    const lifts: number[] = [];
    
    for (let i = 0; i < simulations; i++) {
      const rateA = this.betaRandom(alpha1, beta1);
      const rateB = this.betaRandom(alpha2, beta2);
      
      if (rateB > rateA) {
        bBetter++;
      }
      
      const lift = rateA > 0 ? ((rateB - rateA) / rateA) * 100 : 0;
      lifts.push(lift);
    }

    const probabilityB_Better = bBetter / simulations;
    const expectedLift = lifts.reduce((sum, lift) => sum + lift, 0) / lifts.length;
    
    // クレディブル区間
    lifts.sort((a, b) => a - b);
    const credibleInterval: [number, number] = [
      lifts[Math.floor(simulations * 0.025)],
      lifts[Math.floor(simulations * 0.975)]
    ];

    // 推奨事項
    let recommendation: 'implement_b' | 'keep_a' | 'continue_test';
    if (probabilityB_Better > 0.95) {
      recommendation = 'implement_b';
    } else if (probabilityB_Better < 0.05) {
      recommendation = 'keep_a';
    } else {
      recommendation = 'continue_test';
    }

    return {
      probabilityB_Better,
      expectedLift,
      credibleInterval,
      recommendation
    };
  }

  // サンプルサイズ計算
  static calculateSampleSize(
    baselineRate: number,
    minimumDetectableEffect: number,
    alpha: number = 0.05,
    power: number = 0.8
  ): number {
    const z_alpha = this.normalQuantile(1 - alpha / 2);
    const z_beta = this.normalQuantile(power);
    
    const p1 = baselineRate;
    const p2 = baselineRate * (1 + minimumDetectableEffect / 100);
    
    const pooledP = (p1 + p2) / 2;
    
    const numerator = Math.pow(z_alpha * Math.sqrt(2 * pooledP * (1 - pooledP)) + 
                              z_beta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)), 2);
    const denominator = Math.pow(p2 - p1, 2);
    
    return Math.ceil(numerator / denominator);
  }

  // ヘルパー関数
  private static betaRandom(alpha: number, beta: number): number {
    // ベータ分布のサンプリング（簡略化）
    const u = Math.random();
    const v = Math.random();
    
    const x = Math.pow(u, 1 / alpha);
    const y = Math.pow(v, 1 / beta);
    
    return x / (x + y);
  }

  private static tDistributionPValue(t: number, df: number): number {
    // t分布のp値計算（簡略化）
    return 0.5 * (1 - Math.tanh(t / 2));
  }

  private static chiSquarePValue(chiSquare: number, df: number): number {
    // カイ二乗分布のp値計算（簡略化）
    return Math.exp(-chiSquare / 2);
  }

  private static normalQuantile(p: number): number {
    // 標準正規分布の分位関数（簡略化）
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    if (p === 0.5) return 0;

    const c0 = 2.515517;
    const c1 = 0.802853;
    const c2 = 0.010328;
    const d1 = 1.432788;
    const d2 = 0.189269;
    const d3 = 0.001308;

    const sign = p < 0.5 ? -1 : 1;
    const r = p < 0.5 ? p : 1 - p;
    
    const t = Math.sqrt(-2 * Math.log(r));
    const x = t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t);

    return sign * x;
  }
}

// === メインA/Bテストシステム ===
export class ABTestingSystem extends EventEmitter {
  private experiments = new Map<string, ExperimentConfig>();
  private results = new Map<string, ExperimentResult>();
  private assignments = new Map<string, UserAssignment>();
  private userAssignments = new Map<string, Map<string, string>>(); // userId -> experimentId -> variantId
  private metricCollectors = new Map<string, any>();
  private analysisTimer?: NodeJS.Timeout;

  constructor() {
    super();
    this.startAnalysisLoop();
  }

  // === 実験管理 ===
  async createExperiment(config: ExperimentConfig): Promise<string> {
    // 設定検証
    this.validateExperimentConfig(config);
    
    // サンプルサイズ推奨計算
    if (config.primaryMetric.type === 'conversion') {
      const recommendedSampleSize = StatisticalAnalyzer.calculateSampleSize(
        0.1, // 仮のベースライン率 10%
        config.primaryMetric.minimumDetectableEffect,
        config.statisticalConfig.significanceLevel,
        config.statisticalConfig.statisticalPower
      );
      
      if (config.statisticalConfig.minimumSampleSize < recommendedSampleSize) {
        console.warn(`⚠️ Recommended sample size: ${recommendedSampleSize}, configured: ${config.statisticalConfig.minimumSampleSize}`);
      }
    }

    this.experiments.set(config.id, config);
    
    // 初期結果オブジェクト作成
    const initialResult: ExperimentResult = {
      experimentId: config.id,
      status: 'running',
      startTime: config.startDate,
      duration: 0,
      totalSamples: 0,
      variantResults: config.variants.map(v => ({
        variantId: v.id,
        name: v.name,
        samples: 0,
        metrics: [],
        conversionData: {
          conversions: 0,
          sessions: 0,
          conversionRate: 0,
          confidenceInterval: [0, 0]
        }
      })),
      statisticalAnalysis: this.getInitialStatisticalAnalysis(),
      recommendation: this.getInitialRecommendation(),
      summary: this.getInitialSummary()
    };

    this.results.set(config.id, initialResult);

    console.log(`🧪 Created experiment: ${config.name} (${config.id})`);
    console.log(`📊 Variants: ${config.variants.map(v => `${v.name} (${v.allocation}%)`).join(', ')}`);
    
    this.emit('experiment_created', config);
    
    if (config.autoStart && Date.now() >= config.startDate) {
      await this.startExperiment(config.id);
    }
    
    return config.id;
  }

  async startExperiment(experimentId: string): Promise<boolean> {
    const config = this.experiments.get(experimentId);
    if (!config) {
      console.error(`Experiment not found: ${experimentId}`);
      return false;
    }

    if (config.status !== 'draft') {
      console.error(`Cannot start experiment in status: ${config.status}`);
      return false;
    }

    config.status = 'running';
    config.startDate = Date.now();

    const result = this.results.get(experimentId);
    if (result) {
      result.status = 'running';
      result.startTime = Date.now();
    }

    console.log(`🚀 Started experiment: ${config.name}`);
    
    this.emit('experiment_started', config);
    this.sendNotification(config, 'experiment_started');
    
    return true;
  }

  async stopExperiment(experimentId: string, reason: string = 'Manual stop'): Promise<boolean> {
    const config = this.experiments.get(experimentId);
    const result = this.results.get(experimentId);
    
    if (!config || !result) return false;

    config.status = 'stopped';
    result.status = 'completed';
    result.endTime = Date.now();
    result.duration = result.endTime - result.startTime;

    console.log(`🛑 Stopped experiment: ${config.name} - ${reason}`);
    
    // 最終分析実行
    await this.analyzeExperiment(experimentId);
    
    this.emit('experiment_stopped', { config, result, reason });
    this.sendNotification(config, 'experiment_stopped');
    
    return true;
  }

  // === ユーザー割り当て ===
  async assignUser(
    userId: string,
    experimentId: string,
    sessionId?: string,
    metadata: Record<string, any> = {}
  ): Promise<string | null> {
    const config = this.experiments.get(experimentId);
    if (!config || config.status !== 'running') {
      return null;
    }

    // 既存の割り当てがあるかチェック
    const existingAssignment = this.getUserAssignment(userId, experimentId);
    if (existingAssignment) {
      return existingAssignment;
    }

    // ターゲティングルール評価
    if (!this.evaluateTargeting(config.targeting, { userId, ...metadata })) {
      return null;
    }

    // トラフィック割り当て評価
    if (!this.shouldIncludeInExperiment(userId, config.trafficAllocation)) {
      return null;
    }

    // バリアント割り当て
    const variantId = this.assignVariant(userId, config.variants);
    
    // 割り当て記録
    const assignment: UserAssignment = {
      userId,
      experimentId,
      variantId,
      assignmentTime: Date.now(),
      sessionId,
      metadata
    };

    this.assignments.set(`${userId}-${experimentId}`, assignment);
    
    if (!this.userAssignments.has(userId)) {
      this.userAssignments.set(userId, new Map());
    }
    this.userAssignments.get(userId)!.set(experimentId, variantId);

    // サンプル数更新
    const result = this.results.get(experimentId);
    if (result) {
      result.totalSamples++;
      const variantResult = result.variantResults.find(v => v.variantId === variantId);
      if (variantResult) {
        variantResult.samples++;
        if (variantResult.conversionData) {
          variantResult.conversionData.sessions++;
        }
      }
    }

    console.log(`👤 Assigned user ${userId} to variant ${variantId} in experiment ${experimentId}`);
    
    this.emit('user_assigned', assignment);
    
    return variantId;
  }

  getUserAssignment(userId: string, experimentId: string): string | null {
    return this.userAssignments.get(userId)?.get(experimentId) || null;
  }

  // === イベント記録 ===
  async recordEvent(
    userId: string,
    experimentId: string,
    eventType: string,
    value?: number,
    metadata: Record<string, any> = {}
  ): Promise<void> {
    const variantId = this.getUserAssignment(userId, experimentId);
    if (!variantId) return;

    const config = this.experiments.get(experimentId);
    const result = this.results.get(experimentId);
    if (!config || !result) return;

    // メトリクスに応じてイベント処理
    if (eventType === 'conversion' && config.primaryMetric.type === 'conversion') {
      const variantResult = result.variantResults.find(v => v.variantId === variantId);
      if (variantResult?.conversionData) {
        variantResult.conversionData.conversions++;
        variantResult.conversionData.conversionRate = 
          variantResult.conversionData.conversions / variantResult.conversionData.sessions;
      }
    }

    // カスタムメトリクス処理
    for (const metric of [...config.secondaryMetrics, ...config.guardRailMetrics]) {
      if (metric.name === eventType && value !== undefined) {
        const variantResult = result.variantResults.find(v => v.variantId === variantId);
        if (variantResult) {
          // メトリクス値を集計（簡略化）
          const existingMetric = variantResult.metrics.find(m => m.metricId === metric.id);
          if (existingMetric) {
            existingMetric.value = (existingMetric.value + value) / 2; // 平均
          } else {
            variantResult.metrics.push({
              metricId: metric.id,
              name: metric.name,
              value,
              variance: 0,
              confidenceInterval: [value, value],
              improvement: 0,
              significance: 1,
              effect: 'neutral'
            });
          }
        }
      }
    }

    console.log(`📊 Recorded event: ${eventType} for user ${userId} in experiment ${experimentId}`);
    
    this.emit('event_recorded', {
      userId,
      experimentId,
      variantId,
      eventType,
      value,
      metadata
    });
  }

  // === 分析エンジン ===
  private startAnalysisLoop(): void {
    this.analysisTimer = setInterval(async () => {
      for (const [experimentId, config] of this.experiments) {
        if (config.status === 'running') {
          await this.analyzeExperiment(experimentId);
          await this.checkStoppingConditions(experimentId);
        }
      }
    }, 60000); // 1分ごと
  }

  private async analyzeExperiment(experimentId: string): Promise<void> {
    const config = this.experiments.get(experimentId);
    const result = this.results.get(experimentId);
    
    if (!config || !result) return;

    console.log(`🔍 Analyzing experiment: ${config.name}`);

    // 主要メトリクス分析
    const primaryAnalysis = await this.analyzeMetric(
      config.primaryMetric,
      result.variantResults,
      config.statisticalConfig
    );

    // 副次メトリクス分析
    const secondaryAnalyses: MetricAnalysis[] = [];
    for (const metric of config.secondaryMetrics) {
      const analysis = await this.analyzeMetric(metric, result.variantResults, config.statisticalConfig);
      secondaryAnalyses.push(analysis);
    }

    // ガードレールメトリクス分析
    const guardrailAnalyses: MetricAnalysis[] = [];
    for (const metric of config.guardRailMetrics) {
      const analysis = await this.analyzeMetric(metric, result.variantResults, config.statisticalConfig);
      guardrailAnalyses.push(analysis);
    }

    // 全体的な推奨事項
    const overallRecommendation = this.determineOverallRecommendation(
      primaryAnalysis,
      secondaryAnalyses,
      guardrailAnalyses,
      result.totalSamples,
      config.statisticalConfig
    );

    // 結果更新
    result.statisticalAnalysis = {
      method: config.statisticalConfig.bayesianAnalysis ? 'bayesian' : 'frequentist',
      primaryMetricAnalysis: primaryAnalysis,
      secondaryMetricAnalyses: secondaryAnalyses,
      guardrailMetricAnalyses: guardrailAnalyses,
      multipleComparisonCorrection: config.secondaryMetrics.length > 0,
      overallSignificance: primaryAnalysis.significanceLevel < config.statisticalConfig.significanceLevel,
      recommendation: overallRecommendation
    };

    // ビジネス推奨事項生成
    result.recommendation = this.generateBusinessRecommendation(
      result.statisticalAnalysis,
      config,
      result
    );

    // サマリー更新
    result.summary = this.generateSummary(config, result);

    this.emit('analysis_updated', result);
  }

  private async analyzeMetric(
    metric: Metric,
    variantResults: VariantResult[],
    statisticalConfig: StatisticalConfig
  ): Promise<MetricAnalysis> {
    const controlVariant = variantResults.find(v => v.name.toLowerCase().includes('control'));
    const treatmentVariants = variantResults.filter(v => v !== controlVariant);

    if (!controlVariant || treatmentVariants.length === 0) {
      return this.getDefaultMetricAnalysis(metric.id);
    }

    // コンバージョン率分析
    if (metric.type === 'conversion') {
      return this.analyzeConversionMetric(metric, controlVariant, treatmentVariants[0], statisticalConfig);
    }

    // 連続値分析
    if (metric.type === 'continuous') {
      return this.analyzeContinuousMetric(metric, controlVariant, treatmentVariants[0], statisticalConfig);
    }

    return this.getDefaultMetricAnalysis(metric.id);
  }

  private analyzeConversionMetric(
    metric: Metric,
    control: VariantResult,
    treatment: VariantResult,
    config: StatisticalConfig
  ): MetricAnalysis {
    if (!control.conversionData || !treatment.conversionData) {
      return this.getDefaultMetricAnalysis(metric.id);
    }

    const controlConversions = control.conversionData.conversions;
    const controlSessions = control.conversionData.sessions;
    const treatmentConversions = treatment.conversionData.conversions;
    const treatmentSessions = treatment.conversionData.sessions;

    // 頻度論的分析
    const frequentistResult = StatisticalAnalyzer.chiSquareTest(
      treatmentConversions,
      treatmentSessions,
      controlConversions,
      controlSessions,
      config.significanceLevel
    );

    // ベイジアン分析（設定されている場合）
    let bayesianResult;
    if (config.bayesianAnalysis) {
      bayesianResult = StatisticalAnalyzer.bayesianAnalysis(
        controlConversions,
        controlSessions,
        treatmentConversions,
        treatmentSessions
      );
    }

    // 勝者判定
    const winner = frequentistResult.significant && frequentistResult.effect === 'positive'
      ? treatment.variantId
      : undefined;

    const winnerProbability = bayesianResult ? bayesianResult.probabilityB_Better : 
                             (frequentistResult.significant ? 95 : 50);

    // サンプルサイズ推奨
    const recommendedSampleSize = StatisticalAnalyzer.calculateSampleSize(
      controlConversions / controlSessions,
      metric.minimumDetectableEffect,
      config.significanceLevel,
      config.statisticalPower
    );

    return {
      metricId: metric.id,
      winner,
      winnerProbability,
      liftEstimate: frequentistResult.liftEstimate,
      liftConfidenceInterval: frequentistResult.confidenceInterval,
      significanceLevel: frequentistResult.pValue,
      statisticalPower: config.statisticalPower,
      effectSize: Math.abs(frequentistResult.liftEstimate) / 100,
      sampleSizeRecommendation: recommendedSampleSize
    };
  }

  private analyzeContinuousMetric(
    metric: Metric,
    control: VariantResult,
    treatment: VariantResult,
    config: StatisticalConfig
  ): MetricAnalysis {
    // 簡略化：実際の実装では実際のデータポイントを使用
    const controlValues = Array(control.samples).fill(0).map(() => Math.random() * 100);
    const treatmentValues = Array(treatment.samples).fill(0).map(() => Math.random() * 105);

    const testResult = StatisticalAnalyzer.tTest(
      treatmentValues,
      controlValues,
      config.significanceLevel
    );

    const controlMean = controlValues.reduce((sum, v) => sum + v, 0) / controlValues.length;
    const treatmentMean = treatmentValues.reduce((sum, v) => sum + v, 0) / treatmentValues.length;
    const liftEstimate = ((treatmentMean - controlMean) / controlMean) * 100;

    const winner = testResult.significant && testResult.effect === 'positive'
      ? treatment.variantId
      : undefined;

    return {
      metricId: metric.id,
      winner,
      winnerProbability: testResult.significant ? 95 : 50,
      liftEstimate,
      liftConfidenceInterval: testResult.confidenceInterval,
      significanceLevel: testResult.pValue,
      statisticalPower: config.statisticalPower,
      effectSize: Math.abs(liftEstimate) / 100,
      sampleSizeRecommendation: control.samples + treatment.samples
    };
  }

  // === 停止条件チェック ===
  private async checkStoppingConditions(experimentId: string): Promise<void> {
    const config = this.experiments.get(experimentId);
    const result = this.results.get(experimentId);
    
    if (!config || !result) return;

    // 最大期間チェック
    if (Date.now() - result.startTime >= config.maxDuration) {
      await this.stopExperiment(experimentId, 'Maximum duration reached');
      this.sendNotification(config, 'max_duration_reached');
      return;
    }

    // サンプルサイズチェック
    if (config.statisticalConfig.maxSampleSize && 
        result.totalSamples >= config.statisticalConfig.maxSampleSize) {
      await this.stopExperiment(experimentId, 'Maximum sample size reached');
      this.sendNotification(config, 'sample_size_reached');
      return;
    }

    // 統計的有意性チェック
    if (result.statisticalAnalysis.overallSignificance && config.autoStop) {
      await this.stopExperiment(experimentId, 'Statistical significance reached');
      this.sendNotification(config, 'significant_result');
      return;
    }

    // ガードレールメトリクスチェック
    for (const guardrailAnalysis of result.statisticalAnalysis.guardrailMetricAnalyses) {
      if (guardrailAnalysis.significanceLevel < 0.05 && guardrailAnalysis.liftEstimate < -5) {
        await this.stopExperiment(experimentId, `Guardrail metric triggered: ${guardrailAnalysis.metricId}`);
        this.sendNotification(config, 'guardrail_triggered');
        return;
      }
    }
  }

  // === ヘルパー関数 ===
  private validateExperimentConfig(config: ExperimentConfig): void {
    // バリアント配分の合計チェック
    const totalAllocation = config.variants.reduce((sum, v) => sum + v.allocation, 0);
    if (Math.abs(totalAllocation - 100) > 0.1) {
      throw new Error(`Variant allocations must sum to 100%, got ${totalAllocation}%`);
    }

    // コントロールバリアントの存在チェック
    const hasControl = config.variants.some(v => v.isControl);
    if (!hasControl) {
      console.warn('⚠️ No control variant specified');
    }

    // メトリクス設定チェック
    if (!config.primaryMetric) {
      throw new Error('Primary metric is required');
    }
  }

  private evaluateTargeting(rules: TargetingRules, context: Record<string, any>): boolean {
    // 除外ルール評価
    for (const rule of rules.excludeRules) {
      if (this.evaluateRule(rule, context)) {
        return false; // 除外
      }
    }

    // 包含ルール評価
    if (rules.includeRules.length === 0) {
      return true; // ルールがない場合は包含
    }

    for (const rule of rules.includeRules) {
      if (this.evaluateRule(rule, context)) {
        return true; // 包含
      }
    }

    return false;
  }

  private evaluateRule(rule: TargetingRule, context: Record<string, any>): boolean {
    const contextValue = context[rule.attribute];
    
    switch (rule.operator) {
      case 'equals':
        return contextValue === rule.value;
      case 'not_equals':
        return contextValue !== rule.value;
      case 'in':
        return Array.isArray(rule.value) && rule.value.includes(contextValue);
      case 'not_in':
        return Array.isArray(rule.value) && !rule.value.includes(contextValue);
      case 'contains':
        return typeof contextValue === 'string' && contextValue.includes(rule.value);
      case 'greater_than':
        return typeof contextValue === 'number' && contextValue > rule.value;
      case 'less_than':
        return typeof contextValue === 'number' && contextValue < rule.value;
      default:
        return false;
    }
  }

  private shouldIncludeInExperiment(userId: string, trafficAllocation: number): boolean {
    const hash = crypto.createHash('md5').update(userId).digest('hex');
    const hashValue = parseInt(hash.substring(0, 8), 16);
    const percentage = (hashValue % 100);
    return percentage < trafficAllocation;
  }

  private assignVariant(userId: string, variants: ExperimentVariant[]): string {
    const hash = crypto.createHash('md5').update(userId + 'variant').digest('hex');
    const hashValue = parseInt(hash.substring(0, 8), 16);
    const percentage = hashValue % 100;

    let cumulativeAllocation = 0;
    for (const variant of variants) {
      cumulativeAllocation += variant.allocation;
      if (percentage < cumulativeAllocation) {
        return variant.id;
      }
    }

    return variants[0].id; // フォールバック
  }

  private determineOverallRecommendation(
    primary: MetricAnalysis,
    secondary: MetricAnalysis[],
    guardrail: MetricAnalysis[],
    totalSamples: number,
    config: StatisticalConfig
  ): StatisticalAnalysis['recommendation'] {
    // ガードレール違反チェック
    for (const analysis of guardrail) {
      if (analysis.significanceLevel < 0.05 && analysis.liftEstimate < -5) {
        return 'stop_test';
      }
    }

    // 主要メトリクスに基づく判定
    if (primary.winner && primary.significanceLevel < config.significanceLevel) {
      return 'winner_found';
    }

    // サンプルサイズ不足
    if (totalSamples < config.minimumSampleSize) {
      return 'continue_test';
    }

    // 最大サンプルサイズに達した場合
    if (config.maxSampleSize && totalSamples >= config.maxSampleSize) {
      return primary.winner ? 'winner_found' : 'inconclusive';
    }

    return 'continue_test';
  }

  private generateBusinessRecommendation(
    analysis: StatisticalAnalysis,
    config: ExperimentConfig,
    result: ExperimentResult
  ): ExperimentRecommendation {
    const primaryAnalysis = analysis.primaryMetricAnalysis;
    
    let action: ExperimentRecommendation['action'];
    let confidence: number;
    let reasons: string[] = [];

    if (analysis.recommendation === 'winner_found') {
      action = 'implement_winner';
      confidence = primaryAnalysis.winnerProbability;
      reasons.push(`Primary metric shows ${primaryAnalysis.liftEstimate.toFixed(1)}% improvement`);
      reasons.push(`Statistical significance achieved (p=${primaryAnalysis.significanceLevel.toFixed(3)})`);
    } else if (analysis.recommendation === 'stop_test') {
      action = 'stop_test';
      confidence = 90;
      reasons.push('Guardrail metric triggered');
    } else if (analysis.recommendation === 'continue_test') {
      action = 'extend_test';
      confidence = 70;
      reasons.push(`Need more samples (current: ${result.totalSamples}, recommended: ${primaryAnalysis.sampleSizeRecommendation})`);
    } else {
      action = 'redesign_test';
      confidence = 50;
      reasons.push('Inconclusive results after reaching sample size');
    }

    const riskAssessment: RiskAssessment = {
      level: confidence > 80 ? 'low' : confidence > 60 ? 'medium' : 'high',
      factors: [],
      mitigations: []
    };

    const businessImpact: BusinessImpact = {
      expectedLift: primaryAnalysis.liftEstimate,
      revenueImpact: primaryAnalysis.liftEstimate * 1000, // 簡略化
      userImpact: result.totalSamples,
      implementationComplexity: 'medium'
    };

    return {
      action,
      confidence,
      reasons,
      riskAssessment,
      businessImpact
    };
  }

  private generateSummary(config: ExperimentConfig, result: ExperimentResult): ExperimentSummary {
    const primaryAnalysis = result.statisticalAnalysis.primaryMetricAnalysis;
    const duration = Math.round((Date.now() - result.startTime) / (1000 * 60 * 60 * 24));

    return {
      keyFindings: [
        `Primary metric: ${primaryAnalysis.liftEstimate.toFixed(1)}% ${primaryAnalysis.liftEstimate > 0 ? 'improvement' : 'decrease'}`,
        `Statistical significance: ${primaryAnalysis.significanceLevel < 0.05 ? 'Yes' : 'No'}`,
        `Winner: ${primaryAnalysis.winner || 'No clear winner'}`
      ],
      metrics: {
        primaryMetric: config.primaryMetric.name,
        improvement: primaryAnalysis.liftEstimate,
        significance: primaryAnalysis.significanceLevel
      },
      duration: `${duration} days`,
      sampleSize: result.totalSamples,
      conclusion: result.recommendation.action === 'implement_winner' 
        ? `Implement ${primaryAnalysis.winner} variant`
        : 'Continue testing or redesign experiment'
    };
  }

  private sendNotification(config: ExperimentConfig, event: ExperimentEvent): void {
    for (const channel of config.notificationConfig.channels) {
      if (config.notificationConfig.events.includes(event)) {
        const message = this.formatNotificationMessage(config, event);
        console.log(`📢 ${channel.type.toUpperCase()} to ${channel.target}: ${message}`);
      }
    }
  }

  private formatNotificationMessage(config: ExperimentConfig, event: ExperimentEvent): string {
    switch (event) {
      case 'experiment_started':
        return `🧪 Experiment started: ${config.name}`;
      case 'experiment_stopped':
        return `🛑 Experiment stopped: ${config.name}`;
      case 'significant_result':
        return `📊 Significant result found: ${config.name}`;
      case 'guardrail_triggered':
        return `⚠️ Guardrail triggered: ${config.name}`;
      case 'sample_size_reached':
        return `📈 Sample size reached: ${config.name}`;
      case 'max_duration_reached':
        return `⏰ Max duration reached: ${config.name}`;
      default:
        return `Experiment event: ${event}`;
    }
  }

  // === デフォルト値生成 ===
  private getInitialStatisticalAnalysis(): StatisticalAnalysis {
    return {
      method: 'frequentist',
      primaryMetricAnalysis: this.getDefaultMetricAnalysis('primary'),
      secondaryMetricAnalyses: [],
      guardrailMetricAnalyses: [],
      multipleComparisonCorrection: false,
      overallSignificance: false,
      recommendation: 'continue_test'
    };
  }

  private getDefaultMetricAnalysis(metricId: string): MetricAnalysis {
    return {
      metricId,
      winnerProbability: 50,
      liftEstimate: 0,
      liftConfidenceInterval: [0, 0],
      significanceLevel: 1,
      statisticalPower: 0.8,
      effectSize: 0,
      sampleSizeRecommendation: 1000
    };
  }

  private getInitialRecommendation(): ExperimentRecommendation {
    return {
      action: 'extend_test',
      confidence: 50,
      reasons: ['Experiment just started'],
      riskAssessment: {
        level: 'medium',
        factors: [],
        mitigations: []
      },
      businessImpact: {
        expectedLift: 0,
        revenueImpact: 0,
        userImpact: 0,
        implementationComplexity: 'medium'
      }
    };
  }

  private getInitialSummary(): ExperimentSummary {
    return {
      keyFindings: ['Experiment in progress'],
      metrics: {
        primaryMetric: 'TBD',
        improvement: 0,
        significance: 1
      },
      duration: '0 days',
      sampleSize: 0,
      conclusion: 'Collecting data...'
    };
  }

  // === パブリック API ===
  getExperiment(experimentId: string): ExperimentConfig | null {
    return this.experiments.get(experimentId) || null;
  }

  getExperimentResult(experimentId: string): ExperimentResult | null {
    return this.results.get(experimentId) || null;
  }

  getActiveExperiments(): ExperimentConfig[] {
    return Array.from(this.experiments.values()).filter(e => e.status === 'running');
  }

  getUserExperiments(userId: string): Record<string, string> {
    const assignments = this.userAssignments.get(userId);
    return assignments ? Object.fromEntries(assignments) : {};
  }

  generateExperimentReport(experimentId: string): string {
    const config = this.experiments.get(experimentId);
    const result = this.results.get(experimentId);
    
    if (!config || !result) return 'Experiment not found';

    const lines = [
      `=== A/B Test Report ===`,
      `Experiment: ${config.name}`,
      `ID: ${config.id}`,
      `Status: ${config.status}`,
      `Duration: ${result.summary.duration}`,
      `Sample Size: ${result.totalSamples}`,
      ``,
      `Primary Metric: ${config.primaryMetric.name}`,
      `Improvement: ${result.statisticalAnalysis.primaryMetricAnalysis.liftEstimate.toFixed(1)}%`,
      `Statistical Significance: ${result.statisticalAnalysis.primaryMetricAnalysis.significanceLevel.toFixed(3)}`,
      `Winner: ${result.statisticalAnalysis.primaryMetricAnalysis.winner || 'No clear winner'}`,
      ``,
      `Variants:`,
      ...result.variantResults.map(v => 
        `- ${v.name}: ${v.samples} samples, ${v.conversionData?.conversionRate.toFixed(2)}% conversion`
      ),
      ``,
      `Recommendation: ${result.recommendation.action}`,
      `Confidence: ${result.recommendation.confidence}%`,
      ``,
      `Key Findings:`,
      ...result.summary.keyFindings.map(f => `- ${f}`),
      ``,
      `Conclusion: ${result.summary.conclusion}`
    ];

    return lines.join('\n');
  }

  // === 停止処理 ===
  async shutdown(): Promise<void> {
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
    }

    // 実行中の実験を一時停止
    for (const [experimentId, config] of this.experiments) {
      if (config.status === 'running') {
        config.status = 'paused';
      }
    }

    console.log('🛑 A/B Testing System shutdown');
  }
}

// === ヘルパークラス ===
export class ABTestHelper {
  static createSimpleABTest(
    name: string,
    primaryMetric: string,
    variants: Array<{ name: string; allocation: number; isControl?: boolean }>
  ): ExperimentConfig {
    return {
      id: `ab_${Date.now()}`,
      name,
      description: `Simple A/B test for ${name}`,
      type: 'ab_test',
      status: 'draft',
      startDate: Date.now(),
      maxDuration: 30 * 24 * 60 * 60 * 1000, // 30 days
      trafficAllocation: 100,
      variants: variants.map((v, i) => ({
        id: `variant_${i}`,
        name: v.name,
        description: `Variant ${v.name}`,
        allocation: v.allocation,
        config: {
          featureFlags: {},
          parameters: {}
        },
        isControl: v.isControl || false
      })),
      targeting: {
        includeRules: [],
        excludeRules: [],
        segments: []
      },
      primaryMetric: {
        id: 'primary',
        name: primaryMetric,
        type: 'conversion',
        description: `Primary metric: ${primaryMetric}`,
        source: 'analytics',
        aggregation: 'avg',
        higherIsBetter: true,
        minimumDetectableEffect: 5
      },
      secondaryMetrics: [],
      guardRailMetrics: [],
      statisticalConfig: {
        significanceLevel: 0.05,
        statisticalPower: 0.8,
        minimumSampleSize: 1000,
        sequentialTesting: false,
        bayesianAnalysis: false,
        falseDiscoveryRate: 0.05
      },
      autoStart: false,
      autoStop: false,
      notificationConfig: {
        channels: [],
        events: [],
        alerts: []
      }
    };
  }

  static createFeatureFlagTest(
    featureName: string,
    rolloutPercentage: number = 50
  ): ExperimentConfig {
    const config = this.createSimpleABTest(
      `Feature Flag: ${featureName}`,
      'engagement',
      [
        { name: 'Control', allocation: 100 - rolloutPercentage, isControl: true },
        { name: 'Feature Enabled', allocation: rolloutPercentage }
      ]
    );

    config.type = 'feature_flag';
    config.variants[1].config.featureFlags[featureName] = true;

    return config;
  }
}

export default ABTestingSystem;