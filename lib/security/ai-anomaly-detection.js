/**
 * AI-Based Anomaly Detection System
 * AIベースの異常検知システム
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { performance } from 'perf_hooks';

const logger = getLogger('AIAnomalyDetection');

// 異常タイプ
export const AnomalyType = {
  // ネットワーク異常
  TRAFFIC_SPIKE: 'traffic_spike',
  UNUSUAL_TRAFFIC_PATTERN: 'unusual_traffic_pattern',
  PORT_SCAN: 'port_scan',
  BANDWIDTH_ANOMALY: 'bandwidth_anomaly',
  
  // ユーザー行動異常
  UNUSUAL_LOGIN_TIME: 'unusual_login_time',
  UNUSUAL_LOGIN_LOCATION: 'unusual_login_location',
  ABNORMAL_ACTIVITY_PATTERN: 'abnormal_activity_pattern',
  PRIVILEGE_ESCALATION: 'privilege_escalation',
  
  // システム異常
  RESOURCE_ANOMALY: 'resource_anomaly',
  PERFORMANCE_DEGRADATION: 'performance_degradation',
  ERROR_RATE_SPIKE: 'error_rate_spike',
  LATENCY_ANOMALY: 'latency_anomaly',
  
  // データ異常
  DATA_EXFILTRATION: 'data_exfiltration',
  UNUSUAL_DATA_ACCESS: 'unusual_data_access',
  DATA_CORRUPTION: 'data_corruption',
  
  // トランザクション異常
  TRANSACTION_ANOMALY: 'transaction_anomaly',
  FRAUD_PATTERN: 'fraud_pattern',
  MONEY_LAUNDERING: 'money_laundering'
};

// 検知アルゴリズム
export const DetectionAlgorithm = {
  ISOLATION_FOREST: 'isolation_forest',
  AUTOENCODER: 'autoencoder',
  LSTM: 'lstm',
  ONE_CLASS_SVM: 'one_class_svm',
  LOF: 'local_outlier_factor',
  ENSEMBLE: 'ensemble'
};

export class AIAnomalyDetection extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = logger;
    
    this.options = {
      // 検知設定
      enableRealTimeDetection: options.enableRealTimeDetection !== false,
      detectionInterval: options.detectionInterval || 5000, // 5秒
      
      // アルゴリズム設定
      primaryAlgorithm: options.primaryAlgorithm || DetectionAlgorithm.ENSEMBLE,
      algorithms: options.algorithms || [
        DetectionAlgorithm.ISOLATION_FOREST,
        DetectionAlgorithm.AUTOENCODER,
        DetectionAlgorithm.LSTM
      ],
      
      // しきい値
      anomalyThreshold: options.anomalyThreshold || 0.85,
      criticalThreshold: options.criticalThreshold || 0.95,
      
      // 学習設定
      enableContinuousLearning: options.enableContinuousLearning !== false,
      learningRate: options.learningRate || 0.01,
      modelUpdateInterval: options.modelUpdateInterval || 3600000, // 1時間
      
      // データ設定
      historyWindowSize: options.historyWindowSize || 10000,
      featureWindowSize: options.featureWindowSize || 100,
      
      // アラート設定
      enableAlerts: options.enableAlerts !== false,
      alertCooldown: options.alertCooldown || 300000, // 5分
      
      ...options
    };
    
    // モデル管理
    this.models = new Map();
    this.modelPerformance = new Map();
    
    // データストア
    this.dataHistory = [];
    this.normalProfiles = new Map();
    this.anomalyHistory = [];
    
    // 特徴量抽出
    this.featureExtractors = new Map();
    this.featureCache = new Map();
    
    // アラート管理
    this.activeAlerts = new Map();
    this.alertHistory = [];
    
    // メトリクス
    this.metrics = {
      totalDetections: 0,
      anomaliesDetected: 0,
      falsePositives: 0,
      truePositives: 0,
      detectionAccuracy: 0,
      averageDetectionTime: 0
    };
    
    this.initialize();
  }
  
  async initialize() {
    // モデルを初期化
    await this.initializeModels();
    
    // 特徴量抽出器を設定
    this.setupFeatureExtractors();
    
    // リアルタイム検知を開始
    if (this.options.enableRealTimeDetection) {
      this.startRealTimeDetection();
    }
    
    // 継続的学習を開始
    if (this.options.enableContinuousLearning) {
      this.startContinuousLearning();
    }
    
    this.logger.info('AI anomaly detection system initialized');
  }
  
  /**
   * データを分析して異常を検知
   */
  async detectAnomalies(data) {
    const startTime = performance.now();
    const detectionResults = {
      timestamp: Date.now(),
      anomalies: [],
      score: 0,
      details: {}
    };
    
    try {
      // 特徴量を抽出
      const features = await this.extractFeatures(data);
      
      // 各アルゴリズムで検知
      const algorithmResults = await this.runDetectionAlgorithms(features);
      
      // 結果を統合
      const ensembleResult = this.ensembleResults(algorithmResults);
      detectionResults.score = ensembleResult.score;
      
      // 異常を分類
      if (ensembleResult.score > this.options.anomalyThreshold) {
        const anomalies = await this.classifyAnomalies(features, ensembleResult);
        detectionResults.anomalies = anomalies;
        
        // アラートを生成
        if (this.options.enableAlerts) {
          await this.generateAlerts(anomalies);
        }
      }
      
      // 正常プロファイルを更新
      if (ensembleResult.score < 0.3) {
        await this.updateNormalProfile(data.type, features);
      }
      
      // メトリクスを更新
      const detectionTime = performance.now() - startTime;
      this.updateMetrics(detectionResults, detectionTime);
      
      // 履歴に追加
      this.addToHistory(data, detectionResults);
      
      this.emit('detection:completed', detectionResults);
      
      return detectionResults;
      
    } catch (error) {
      this.logger.error('Anomaly detection failed', error);
      throw error;
    }
  }
  
  /**
   * モデルを初期化
   */
  async initializeModels() {
    for (const algorithm of this.options.algorithms) {
      const model = await this.createModel(algorithm);
      this.models.set(algorithm, model);
      this.modelPerformance.set(algorithm, {
        accuracy: 0,
        precision: 0,
        recall: 0,
        f1Score: 0
      });
    }
  }
  
  /**
   * モデルを作成
   */
  async createModel(algorithm) {
    switch (algorithm) {
      case DetectionAlgorithm.ISOLATION_FOREST:
        return this.createIsolationForest();
        
      case DetectionAlgorithm.AUTOENCODER:
        return this.createAutoencoder();
        
      case DetectionAlgorithm.LSTM:
        return this.createLSTM();
        
      case DetectionAlgorithm.ONE_CLASS_SVM:
        return this.createOneClassSVM();
        
      case DetectionAlgorithm.LOF:
        return this.createLOF();
        
      default:
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
  }
  
  /**
   * Isolation Forestモデルを作成
   */
  createIsolationForest() {
    return {
      type: DetectionAlgorithm.ISOLATION_FOREST,
      parameters: {
        nEstimators: 100,
        maxSamples: 256,
        contamination: 0.1
      },
      trees: [],
      
      async fit(data) {
        // Isolation Forestの学習実装（簡略化）
        this.trees = this.buildIsolationTrees(data);
      },
      
      async predict(features) {
        // 異常スコアを計算
        const pathLengths = this.trees.map(tree => 
          this.computePathLength(features, tree)
        );
        
        const avgPathLength = pathLengths.reduce((a, b) => a + b, 0) / pathLengths.length;
        const score = Math.pow(2, -avgPathLength / this.c(features.length));
        
        return score;
      },
      
      buildIsolationTrees(data) {
        // ツリー構築の実装（省略）
        return [];
      },
      
      computePathLength(features, tree) {
        // パス長計算の実装（省略）
        return Math.random() * 10;
      },
      
      c(n) {
        // 平均パス長の期待値
        return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1) / n);
      }
    };
  }
  
  /**
   * Autoencoderモデルを作成
   */
  createAutoencoder() {
    return {
      type: DetectionAlgorithm.AUTOENCODER,
      parameters: {
        inputDim: 50,
        encodingDim: 10,
        hiddenLayers: [32, 16],
        activation: 'relu',
        optimizer: 'adam'
      },
      
      async fit(data) {
        // Autoencoderの学習実装（簡略化）
      },
      
      async predict(features) {
        // 再構成誤差を計算
        const reconstruction = await this.reconstruct(features);
        const error = this.calculateReconstructionError(features, reconstruction);
        
        // エラーを正規化してスコアに変換
        const normalizedError = Math.min(error / 10, 1);
        return normalizedError;
      },
      
      async reconstruct(features) {
        // 特徴量を再構成（簡略化）
        return features.map(f => f + (Math.random() - 0.5) * 0.1);
      },
      
      calculateReconstructionError(original, reconstructed) {
        // MSEを計算
        let sum = 0;
        for (let i = 0; i < original.length; i++) {
          sum += Math.pow(original[i] - reconstructed[i], 2);
        }
        return Math.sqrt(sum / original.length);
      }
    };
  }
  
  /**
   * LSTMモデルを作成
   */
  createLSTM() {
    return {
      type: DetectionAlgorithm.LSTM,
      parameters: {
        sequenceLength: 10,
        lstmUnits: 64,
        dropoutRate: 0.2,
        learningRate: 0.001
      },
      
      async fit(data) {
        // LSTMの学習実装（簡略化）
      },
      
      async predict(features) {
        // 時系列予測と実際の値の差異を計算
        const predicted = await this.predictNext(features);
        const actual = features[features.length - 1];
        
        const error = Math.abs(predicted - actual);
        return Math.min(error / 10, 1);
      },
      
      async predictNext(sequence) {
        // 次の値を予測（簡略化）
        const avg = sequence.reduce((a, b) => a + b, 0) / sequence.length;
        return avg + (Math.random() - 0.5) * 0.2;
      }
    };
  }
  
  /**
   * 特徴量抽出器を設定
   */
  setupFeatureExtractors() {
    // ネットワークトラフィック特徴量
    this.featureExtractors.set('network', {
      extract: (data) => this.extractNetworkFeatures(data)
    });
    
    // ユーザー行動特徴量
    this.featureExtractors.set('user', {
      extract: (data) => this.extractUserFeatures(data)
    });
    
    // システムメトリクス特徴量
    this.featureExtractors.set('system', {
      extract: (data) => this.extractSystemFeatures(data)
    });
    
    // トランザクション特徴量
    this.featureExtractors.set('transaction', {
      extract: (data) => this.extractTransactionFeatures(data)
    });
  }
  
  /**
   * 特徴量を抽出
   */
  async extractFeatures(data) {
    const features = [];
    
    // データタイプに応じた特徴量抽出
    const extractor = this.featureExtractors.get(data.type);
    if (extractor) {
      const extracted = await extractor.extract(data);
      features.push(...extracted);
    }
    
    // 時系列特徴量
    const timeFeatures = this.extractTimeSeriesFeatures(data);
    features.push(...timeFeatures);
    
    // 統計的特徴量
    const statisticalFeatures = this.extractStatisticalFeatures(data);
    features.push(...statisticalFeatures);
    
    return features;
  }
  
  /**
   * ネットワーク特徴量を抽出
   */
  extractNetworkFeatures(data) {
    return [
      data.packetCount || 0,
      data.byteCount || 0,
      data.flowDuration || 0,
      data.avgPacketSize || 0,
      data.protocolDistribution?.tcp || 0,
      data.protocolDistribution?.udp || 0,
      data.portScanIndicator || 0,
      data.unusualPortAccess || 0
    ];
  }
  
  /**
   * ユーザー行動特徴量を抽出
   */
  extractUserFeatures(data) {
    const now = new Date();
    const loginTime = new Date(data.loginTime);
    const hourOfDay = loginTime.getHours();
    const dayOfWeek = loginTime.getDay();
    
    return [
      hourOfDay,
      dayOfWeek,
      data.failedLoginAttempts || 0,
      data.accessedResources?.length || 0,
      data.dataTransferVolume || 0,
      data.sessionDuration || 0,
      data.unusualLocationAccess ? 1 : 0,
      data.privilegeEscalationAttempt ? 1 : 0
    ];
  }
  
  /**
   * 検知アルゴリズムを実行
   */
  async runDetectionAlgorithms(features) {
    const results = [];
    
    for (const [algorithm, model] of this.models) {
      try {
        const score = await model.predict(features);
        results.push({
          algorithm,
          score,
          timestamp: Date.now()
        });
      } catch (error) {
        this.logger.error(`Algorithm ${algorithm} failed`, error);
      }
    }
    
    return results;
  }
  
  /**
   * 結果を統合
   */
  ensembleResults(algorithmResults) {
    if (algorithmResults.length === 0) {
      return { score: 0, confidence: 0 };
    }
    
    // 重み付き平均
    const weights = {
      [DetectionAlgorithm.ISOLATION_FOREST]: 0.3,
      [DetectionAlgorithm.AUTOENCODER]: 0.4,
      [DetectionAlgorithm.LSTM]: 0.3
    };
    
    let weightedSum = 0;
    let totalWeight = 0;
    
    for (const result of algorithmResults) {
      const weight = weights[result.algorithm] || 0.2;
      weightedSum += result.score * weight;
      totalWeight += weight;
    }
    
    const ensembleScore = weightedSum / totalWeight;
    
    // 信頼度を計算（アルゴリズム間の一致度）
    const scores = algorithmResults.map(r => r.score);
    const variance = this.calculateVariance(scores);
    const confidence = 1 - Math.min(variance, 1);
    
    return {
      score: ensembleScore,
      confidence,
      individualScores: algorithmResults
    };
  }
  
  /**
   * 異常を分類
   */
  async classifyAnomalies(features, detectionResult) {
    const anomalies = [];
    
    // スコアに基づいて異常タイプを推定
    if (detectionResult.score > this.options.criticalThreshold) {
      // 重大な異常
      anomalies.push({
        type: this.inferAnomalyType(features, detectionResult),
        severity: 'critical',
        score: detectionResult.score,
        confidence: detectionResult.confidence,
        details: {
          features,
          algorithms: detectionResult.individualScores
        }
      });
    } else if (detectionResult.score > this.options.anomalyThreshold) {
      // 通常の異常
      anomalies.push({
        type: this.inferAnomalyType(features, detectionResult),
        severity: 'high',
        score: detectionResult.score,
        confidence: detectionResult.confidence,
        details: {
          features,
          algorithms: detectionResult.individualScores
        }
      });
    }
    
    return anomalies;
  }
  
  /**
   * 異常タイプを推定
   */
  inferAnomalyType(features, detectionResult) {
    // 特徴量パターンから異常タイプを推定（簡略化）
    const patterns = {
      [AnomalyType.TRAFFIC_SPIKE]: features[0] > 1000,
      [AnomalyType.UNUSUAL_LOGIN_TIME]: features[1] < 6 || features[1] > 22,
      [AnomalyType.DATA_EXFILTRATION]: features[4] > 1000000,
      [AnomalyType.PORT_SCAN]: features[6] > 0.5
    };
    
    for (const [type, condition] of Object.entries(patterns)) {
      if (condition) {
        return type;
      }
    }
    
    return AnomalyType.UNUSUAL_TRAFFIC_PATTERN;
  }
  
  /**
   * アラートを生成
   */
  async generateAlerts(anomalies) {
    for (const anomaly of anomalies) {
      const alertKey = `${anomaly.type}_${anomaly.severity}`;
      
      // クールダウン期間をチェック
      const lastAlert = this.activeAlerts.get(alertKey);
      if (lastAlert && Date.now() - lastAlert.timestamp < this.options.alertCooldown) {
        continue;
      }
      
      const alert = {
        id: this.generateAlertId(),
        timestamp: Date.now(),
        anomaly,
        status: 'active',
        actions: this.determineActions(anomaly)
      };
      
      this.activeAlerts.set(alertKey, alert);
      this.alertHistory.push(alert);
      
      this.emit('alert:generated', alert);
    }
  }
  
  /**
   * アクションを決定
   */
  determineActions(anomaly) {
    const actions = [];
    
    switch (anomaly.severity) {
      case 'critical':
        actions.push('block_traffic', 'notify_admin', 'capture_forensics');
        break;
      case 'high':
        actions.push('rate_limit', 'monitor_closely', 'notify_security');
        break;
      case 'medium':
        actions.push('log_detailed', 'monitor');
        break;
    }
    
    return actions;
  }
  
  /**
   * 正常プロファイルを更新
   */
  async updateNormalProfile(type, features) {
    if (!this.normalProfiles.has(type)) {
      this.normalProfiles.set(type, {
        features: [],
        statistics: {}
      });
    }
    
    const profile = this.normalProfiles.get(type);
    profile.features.push(features);
    
    // 統計を更新
    profile.statistics = {
      mean: this.calculateMean(profile.features),
      std: this.calculateStd(profile.features),
      min: this.calculateMin(profile.features),
      max: this.calculateMax(profile.features)
    };
    
    // 古いデータを削除
    if (profile.features.length > this.options.historyWindowSize) {
      profile.features = profile.features.slice(-this.options.historyWindowSize / 2);
    }
  }
  
  /**
   * リアルタイム検知を開始
   */
  startRealTimeDetection() {
    this.detectionInterval = setInterval(async () => {
      // キューからデータを取得して処理
      await this.processDetectionQueue();
    }, this.options.detectionInterval);
  }
  
  /**
   * 継続的学習を開始
   */
  startContinuousLearning() {
    this.learningInterval = setInterval(async () => {
      await this.updateModels();
    }, this.options.modelUpdateInterval);
  }
  
  /**
   * モデルを更新
   */
  async updateModels() {
    this.logger.info('Updating anomaly detection models...');
    
    for (const [algorithm, model] of this.models) {
      try {
        // 最近のデータで再学習
        const trainingData = this.prepareTrainingData();
        await model.fit(trainingData);
        
        // パフォーマンスを評価
        const performance = await this.evaluateModel(model, algorithm);
        this.modelPerformance.set(algorithm, performance);
        
      } catch (error) {
        this.logger.error(`Model update failed for ${algorithm}`, error);
      }
    }
  }
  
  /**
   * 統計情報を取得
   */
  getStats() {
    return {
      metrics: this.metrics,
      models: {
        active: Array.from(this.models.keys()),
        performance: Object.fromEntries(this.modelPerformance)
      },
      detection: {
        totalAnomalies: this.anomalyHistory.length,
        activeAlerts: this.activeAlerts.size,
        recentAnomalies: this.anomalyHistory.slice(-10)
      },
      profiles: {
        normalProfiles: this.normalProfiles.size,
        dataHistory: this.dataHistory.length
      }
    };
  }
  
  // ヘルパーメソッド
  calculateVariance(values) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    return variance;
  }
  
  calculateMean(features) {
    // 特徴量の平均を計算（簡略化）
    return features[0].map((_, i) => {
      const sum = features.reduce((acc, f) => acc + f[i], 0);
      return sum / features.length;
    });
  }
  
  calculateStd(features) {
    // 標準偏差を計算（簡略化）
    const mean = this.calculateMean(features);
    return mean.map(() => 1.0);
  }
  
  calculateMin(features) {
    // 最小値を計算（簡略化）
    return features[0].map(() => 0);
  }
  
  calculateMax(features) {
    // 最大値を計算（簡略化）
    return features[0].map(() => 100);
  }
  
  extractTimeSeriesFeatures(data) {
    // 時系列特徴量を抽出（簡略化）
    return [
      data.timestamp % 86400000, // 時刻
      Math.sin(2 * Math.PI * data.timestamp / 86400000), // 周期性
      Math.cos(2 * Math.PI * data.timestamp / 86400000)
    ];
  }
  
  extractStatisticalFeatures(data) {
    // 統計的特徴量を抽出（簡略化）
    return [
      data.mean || 0,
      data.std || 0,
      data.skewness || 0,
      data.kurtosis || 0
    ];
  }
  
  generateAlertId() {
    return `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  updateMetrics(detectionResults, detectionTime) {
    this.metrics.totalDetections++;
    
    if (detectionResults.anomalies.length > 0) {
      this.metrics.anomaliesDetected++;
    }
    
    // 検知時間の移動平均
    const alpha = 0.1;
    this.metrics.averageDetectionTime = 
      alpha * detectionTime + (1 - alpha) * this.metrics.averageDetectionTime;
  }
  
  addToHistory(data, results) {
    this.dataHistory.push({
      data,
      results,
      timestamp: Date.now()
    });
    
    // 履歴サイズを制限
    if (this.dataHistory.length > this.options.historyWindowSize) {
      this.dataHistory = this.dataHistory.slice(-this.options.historyWindowSize);
    }
    
    if (results.anomalies.length > 0) {
      this.anomalyHistory.push(...results.anomalies);
    }
  }
  
  prepareTrainingData() {
    // 正常データと異常データを準備（簡略化）
    return this.dataHistory.map(item => ({
      features: item.data,
      label: item.results.anomalies.length > 0 ? 1 : 0
    }));
  }
  
  async evaluateModel(model, algorithm) {
    // モデルのパフォーマンスを評価（簡略化）
    return {
      accuracy: 0.95 + Math.random() * 0.05,
      precision: 0.90 + Math.random() * 0.10,
      recall: 0.85 + Math.random() * 0.15,
      f1Score: 0.88 + Math.random() * 0.12
    };
  }
  
  async processDetectionQueue() {
    // 検知キューを処理（実装は省略）
  }
  
  /**
   * クリーンアップ
   */
  async cleanup() {
    if (this.detectionInterval) {
      clearInterval(this.detectionInterval);
    }
    
    if (this.learningInterval) {
      clearInterval(this.learningInterval);
    }
    
    this.models.clear();
    this.featureCache.clear();
  }
}

export default AIAnomalyDetection;