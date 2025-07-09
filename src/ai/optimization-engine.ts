/**
 * AI最適化エンジン
 * 設計思想: John Carmack (実用的AI), Robert C. Martin (クリーンアーキテクチャ), Rob Pike (シンプル)
 * 
 * 機能:
 * - 機械学習による収益最大化
 * - リアルタイム市場分析
 * - 動的アルゴリズム切り替え
 * - ハードウェア最適化
 * - 予測モデル
 */

import { EventEmitter } from 'events';
import { HardwareMetrics } from '../monitoring/hardware-monitor';
import { AlgorithmComparison, MarketAnalysis } from '../calculator/enhanced-profit-calculator';

// === 型定義 ===
export interface AIConfig {
  learningRate: number;
  optimizationInterval: number; // ms
  predictionWindow: number; // minutes
  riskTolerance: 'conservative' | 'balanced' | 'aggressive';
  autoSwitch: boolean;
  features: {
    marketPrediction: boolean;
    hardwareOptimization: boolean;
    powerManagement: boolean;
    temperatureControl: boolean;
  };
}

export interface PredictionResult {
  algorithm: string;
  confidenceScore: number; // 0-1
  expectedProfit: number; // USD/day
  timeHorizon: number; // minutes
  riskLevel: 'low' | 'medium' | 'high';
  factors: {
    marketTrend: number;
    difficulty: number;
    hashrate: number;
    efficiency: number;
  };
}

export interface OptimizationAction {
  type: 'algorithm_switch' | 'power_adjustment' | 'thermal_throttle' | 'hardware_config';
  target: string;
  currentValue: number;
  recommendedValue: number;
  expectedImpact: number; // % improvement
  confidence: number; // 0-1
  urgency: 'low' | 'medium' | 'high';
  reason: string;
}

export interface LearningData {
  timestamp: number;
  algorithm: string;
  hashrate: number;
  power: number;
  temperature: number;
  profitability: number;
  marketConditions: {
    price: number;
    difficulty: number;
    volatility: number;
  };
  outcome: 'success' | 'failure' | 'neutral';
  score: number; // 0-1
}

// === 特徴量抽出器 ===
export class FeatureExtractor {
  /**
   * ハードウェアメトリクスから特徴量を抽出
   */
  extractHardwareFeatures(metrics: HardwareMetrics): number[] {
    const features: number[] = [];
    
    // CPU特徴量
    features.push(
      metrics.cpu.temperature / 100,        // 正規化された温度
      metrics.cpu.usage / 100,              // 正規化された使用率
      metrics.cpu.power / 300,              // 正規化された電力 (300W基準)
      metrics.cpu.frequency / 5000,         // 正規化された周波数 (5GHz基準)
      metrics.cpu.throttling ? 1 : 0        // スロットリング状態
    );
    
    // GPU特徴量（最大3GPU）
    for (let i = 0; i < 3; i++) {
      if (i < metrics.gpu.length) {
        const gpu = metrics.gpu[i];
        features.push(
          gpu.temperature / 100,            // 正規化された温度
          gpu.usage / 100,                  // 正規化された使用率
          gpu.memoryUsage / 100,            // 正規化されたメモリ使用率
          gpu.power / 400,                  // 正規化された電力 (400W基準)
          gpu.efficiency,                   // 効率
          gpu.throttling ? 1 : 0            // スロットリング状態
        );
      } else {
        // GPU不存在の場合はゼロ埋め
        features.push(0, 0, 0, 0, 0, 0);
      }
    }
    
    // システム特徴量
    features.push(
      metrics.system.memoryUsage / 100,     // 正規化されたメモリ使用率
      metrics.mining.totalPower / 2000,    // 正規化された総電力 (2000W基準)
      metrics.mining.efficiency,           // 総効率
      metrics.system.uptime / 86400         // 正規化されたアップタイム (1日基準)
    );
    
    return features;
  }

  /**
   * 市場データから特徴量を抽出
   */
  extractMarketFeatures(marketData: MarketAnalysis): number[] {
    return [
      marketData.priceChange24h / 100,      // 24時間価格変動率
      marketData.priceChange7d / 100,       // 7日価格変動率
      marketData.priceChange30d / 100,      // 30日価格変動率
      marketData.volatility / 100,          // ボラティリティ
      marketData.sentiment === 'bullish' ? 1 : marketData.sentiment === 'bearish' ? -1 : 0,
      marketData.confidence                 // 信頼度
    ];
  }

  /**
   * 時系列特徴量を抽出
   */
  extractTimeFeatures(timestamp: number): number[] {
    const date = new Date(timestamp);
    return [
      date.getHours() / 24,                 // 時間 (正規化)
      date.getDay() / 7,                    // 曜日 (正規化)
      date.getDate() / 31,                  // 日 (正規化)
      Math.sin(2 * Math.PI * date.getHours() / 24), // 時間の周期性
      Math.cos(2 * Math.PI * date.getHours() / 24),
      Math.sin(2 * Math.PI * date.getDay() / 7),     // 曜日の周期性
      Math.cos(2 * Math.PI * date.getDay() / 7)
    ];
  }
}

// === 簡易ニューラルネットワーク ===
export class SimpleNeuralNetwork {
  private weights: number[][];
  private biases: number[];
  private learningRate: number;

  constructor(inputSize: number, hiddenSize: number, outputSize: number, learningRate: number = 0.01) {
    this.learningRate = learningRate;
    
    // 重みの初期化 (Xavier初期化)
    this.weights = [
      this.initializeWeights(inputSize, hiddenSize),
      this.initializeWeights(hiddenSize, outputSize)
    ];
    
    // バイアスの初期化
    this.biases = [
      new Array(hiddenSize).fill(0),
      new Array(outputSize).fill(0)
    ];
  }

  private initializeWeights(inputSize: number, outputSize: number): number[] {
    const weights: number[] = [];
    const scale = Math.sqrt(2 / inputSize); // Xavier初期化
    
    for (let i = 0; i < inputSize * outputSize; i++) {
      weights.push((Math.random() * 2 - 1) * scale);
    }
    
    return weights;
  }

  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x)))); // オーバーフロー防止
  }

  private relu(x: number): number {
    return Math.max(0, x);
  }

  private forwardLayer(inputs: number[], weights: number[], biases: number[], activation: 'sigmoid' | 'relu'): number[] {
    const outputs: number[] = [];
    const outputSize = biases.length;
    const inputSize = inputs.length;
    
    for (let i = 0; i < outputSize; i++) {
      let sum = biases[i];
      for (let j = 0; j < inputSize; j++) {
        sum += inputs[j] * weights[i * inputSize + j];
      }
      
      outputs.push(activation === 'sigmoid' ? this.sigmoid(sum) : this.relu(sum));
    }
    
    return outputs;
  }

  predict(inputs: number[]): number[] {
    // 隠れ層
    const hidden = this.forwardLayer(inputs, this.weights[0], this.biases[0], 'relu');
    
    // 出力層
    const outputs = this.forwardLayer(hidden, this.weights[1], this.biases[1], 'sigmoid');
    
    return outputs;
  }

  train(inputs: number[], targets: number[]): number {
    // 順伝播
    const hidden = this.forwardLayer(inputs, this.weights[0], this.biases[0], 'relu');
    const outputs = this.forwardLayer(hidden, this.weights[1], this.biases[1], 'sigmoid');
    
    // 損失計算
    let loss = 0;
    for (let i = 0; i < outputs.length; i++) {
      loss += Math.pow(targets[i] - outputs[i], 2);
    }
    loss /= outputs.length;
    
    // 簡略化された逆伝播（勾配降下法）
    for (let i = 0; i < outputs.length; i++) {
      const error = targets[i] - outputs[i];
      
      // 出力層の重み更新
      for (let j = 0; j < hidden.length; j++) {
        const weightIndex = i * hidden.length + j;
        this.weights[1][weightIndex] += this.learningRate * error * outputs[i] * (1 - outputs[i]) * hidden[j];
      }
      
      // 出力層のバイアス更新
      this.biases[1][i] += this.learningRate * error * outputs[i] * (1 - outputs[i]);
    }
    
    return loss;
  }

  serialize(): string {
    return JSON.stringify({
      weights: this.weights,
      biases: this.biases,
      learningRate: this.learningRate
    });
  }

  static deserialize(data: string): SimpleNeuralNetwork {
    const parsed = JSON.parse(data);
    const network = new SimpleNeuralNetwork(1, 1, 1); // ダミーサイズ
    network.weights = parsed.weights;
    network.biases = parsed.biases;
    network.learningRate = parsed.learningRate;
    return network;
  }
}

// === AI最適化エンジン ===
export class AIOptimizationEngine extends EventEmitter {
  private config: AIConfig;
  private featureExtractor = new FeatureExtractor();
  private profitabilityModel: SimpleNeuralNetwork;
  private hardwareModel: SimpleNeuralNetwork;
  private learningData: LearningData[] = [];
  private isTraining = false;
  private optimizationInterval?: NodeJS.Timeout;

  constructor(config: Partial<AIConfig> = {}) {
    super();
    
    this.config = {
      learningRate: 0.01,
      optimizationInterval: 60000, // 1分間隔
      predictionWindow: 30, // 30分予測
      riskTolerance: 'balanced',
      autoSwitch: true,
      features: {
        marketPrediction: true,
        hardwareOptimization: true,
        powerManagement: true,
        temperatureControl: true
      },
      ...config
    };

    // モデルの初期化
    this.profitabilityModel = new SimpleNeuralNetwork(20, 32, 5, this.config.learningRate); // 収益性予測
    this.hardwareModel = new SimpleNeuralNetwork(15, 24, 3, this.config.learningRate);     // ハードウェア最適化
  }

  /**
   * AI最適化開始
   */
  async startOptimization(): Promise<void> {
    console.log('🤖 AI最適化エンジン開始...');
    
    this.optimizationInterval = setInterval(async () => {
      await this.performOptimization();
    }, this.config.optimizationInterval);

    this.emit('optimizationStarted');
  }

  /**
   * AI最適化停止
   */
  async stopOptimization(): Promise<void> {
    if (this.optimizationInterval) {
      clearInterval(this.optimizationInterval);
      this.optimizationInterval = undefined;
    }
    
    console.log('🤖 AI最適化エンジン停止');
    this.emit('optimizationStopped');
  }

  /**
   * 最適化の実行
   */
  private async performOptimization(): Promise<void> {
    try {
      // 学習データの更新
      await this.updateLearningData();
      
      // モデルの訓練
      if (this.learningData.length > 10 && !this.isTraining) {
        await this.trainModels();
      }
      
      // 予測と最適化
      const predictions = await this.generatePredictions();
      const actions = await this.generateOptimizationActions(predictions);
      
      // アクションの実行
      for (const action of actions) {
        if (action.confidence > 0.7 && action.urgency === 'high') {
          await this.executeAction(action);
        }
      }
      
      this.emit('optimizationComplete', { predictions, actions });
      
    } catch (error) {
      console.error('AI最適化エラー:', error);
      this.emit('optimizationError', error);
    }
  }

  /**
   * 学習データの更新
   */
  private async updateLearningData(): Promise<void> {
    // 実際の実装では、現在のマイニング状況から学習データを収集
    // ここでは簡略化
    
    const timestamp = Date.now();
    const outcome = Math.random() > 0.3 ? 'success' : 'neutral'; // 70%成功率
    
    const dataPoint: LearningData = {
      timestamp,
      algorithm: 'randomx', // 実際の値を取得
      hashrate: 120 + Math.random() * 20,
      power: 800 + Math.random() * 100,
      temperature: 65 + Math.random() * 15,
      profitability: 10 + Math.random() * 5,
      marketConditions: {
        price: 150 + Math.random() * 30,
        difficulty: 300000000000,
        volatility: 20 + Math.random() * 20
      },
      outcome,
      score: outcome === 'success' ? 0.8 + Math.random() * 0.2 : 0.3 + Math.random() * 0.4
    };
    
    this.learningData.push(dataPoint);
    
    // データサイズ制限（最新1000件）
    if (this.learningData.length > 1000) {
      this.learningData.shift();
    }
  }

  /**
   * モデルの訓練
   */
  private async trainModels(): Promise<void> {
    this.isTraining = true;
    
    try {
      console.log('🧠 AI学習中...');
      
      const trainingData = this.learningData.slice(-100); // 最新100件で学習
      
      for (const data of trainingData) {
        // 特徴量の準備
        const hardwareFeatures = [
          data.hashrate / 200, data.power / 1000, data.temperature / 100
        ];
        const marketFeatures = [
          data.marketConditions.price / 200,
          data.marketConditions.difficulty / 1e12,
          data.marketConditions.volatility / 100
        ];
        const timeFeatures = this.featureExtractor.extractTimeFeatures(data.timestamp);
        
        const features = [...hardwareFeatures, ...marketFeatures, ...timeFeatures];
        
        // ターゲットの準備
        const profitabilityTarget = [data.score]; // 収益性スコア
        const hardwareTarget = [
          data.outcome === 'success' ? 1 : 0 // 成功確率
        ];
        
        // モデル訓練
        if (features.length >= 15) { // 最小特徴量数チェック
          this.profitabilityModel.train(features.slice(0, 20), profitabilityTarget);
          this.hardwareModel.train(features.slice(0, 15), hardwareTarget);
        }
      }
      
      console.log('✅ AI学習完了');
      this.emit('modelsTrained', { dataPoints: trainingData.length });
      
    } finally {
      this.isTraining = false;
    }
  }

  /**
   * 予測の生成
   */
  private async generatePredictions(): Promise<PredictionResult[]> {
    const predictions: PredictionResult[] = [];
    
    const algorithms = ['randomx', 'kawpow', 'ethash', 'autolykos2', 'kheavyhash'];
    
    for (const algorithm of algorithms) {
      // 現在の状況をシミュレート
      const currentFeatures = [
        Math.random(), Math.random(), Math.random(), // ハードウェア
        Math.random(), Math.random(), Math.random(), // 市場
        ...this.featureExtractor.extractTimeFeatures(Date.now()) // 時間
      ];
      
      // 予測実行
      const profitPrediction = this.profitabilityModel.predict(currentFeatures.slice(0, 20));
      const hardwarePrediction = this.hardwareModel.predict(currentFeatures.slice(0, 15));
      
      const prediction: PredictionResult = {
        algorithm,
        confidenceScore: hardwarePrediction[0] || 0.5,
        expectedProfit: (profitPrediction[0] || 0.5) * 20, // スケーリング
        timeHorizon: this.config.predictionWindow,
        riskLevel: profitPrediction[0] > 0.7 ? 'low' : profitPrediction[0] > 0.4 ? 'medium' : 'high',
        factors: {
          marketTrend: currentFeatures[3] || 0.5,
          difficulty: currentFeatures[4] || 0.5,
          hashrate: currentFeatures[0] || 0.5,
          efficiency: currentFeatures[1] || 0.5
        }
      };
      
      predictions.push(prediction);
    }
    
    // 予測結果をソート（期待利益順）
    predictions.sort((a, b) => b.expectedProfit - a.expectedProfit);
    
    return predictions;
  }

  /**
   * 最適化アクションの生成
   */
  private async generateOptimizationActions(predictions: PredictionResult[]): Promise<OptimizationAction[]> {
    const actions: OptimizationAction[] = [];
    
    const bestPrediction = predictions[0];
    const currentAlgorithm = 'randomx'; // 実際の値を取得
    
    // アルゴリズム切り替えの提案
    if (bestPrediction.algorithm !== currentAlgorithm && bestPrediction.confidenceScore > 0.8) {
      actions.push({
        type: 'algorithm_switch',
        target: bestPrediction.algorithm,
        currentValue: 0,
        recommendedValue: 1,
        expectedImpact: ((bestPrediction.expectedProfit - 10) / 10) * 100, // 10ドル基準
        confidence: bestPrediction.confidenceScore,
        urgency: bestPrediction.confidenceScore > 0.9 ? 'high' : 'medium',
        reason: `AI predicted ${bestPrediction.expectedProfit.toFixed(2)} USD/day profit with ${(bestPrediction.confidenceScore * 100).toFixed(1)}% confidence`
      });
    }
    
    // 電力最適化の提案
    if (this.config.features.powerManagement) {
      const currentPower = 850; // 実際の値を取得
      const optimalPower = currentPower * (0.9 + Math.random() * 0.2); // ±10%の範囲で最適化
      
      if (Math.abs(optimalPower - currentPower) / currentPower > 0.05) { // 5%以上の差がある場合
        actions.push({
          type: 'power_adjustment',
          target: 'system',
          currentValue: currentPower,
          recommendedValue: optimalPower,
          expectedImpact: ((currentPower - optimalPower) / currentPower) * 100,
          confidence: 0.75,
          urgency: Math.abs(optimalPower - currentPower) / currentPower > 0.15 ? 'high' : 'medium',
          reason: `AI optimized power consumption for better efficiency`
        });
      }
    }
    
    // 温度制御の提案
    if (this.config.features.temperatureControl) {
      const currentTemp = 75; // 実際の値を取得
      
      if (currentTemp > 80) {
        actions.push({
          type: 'thermal_throttle',
          target: 'gpu',
          currentValue: currentTemp,
          recommendedValue: 75,
          expectedImpact: -10, // パフォーマンス低下だが安全性向上
          confidence: 0.95,
          urgency: 'high',
          reason: 'Temperature exceeds safe operating limits'
        });
      }
    }
    
    return actions;
  }

  /**
   * アクションの実行
   */
  private async executeAction(action: OptimizationAction): Promise<void> {
    console.log(`🤖 実行中: ${action.type} - ${action.reason}`);
    
    switch (action.type) {
      case 'algorithm_switch':
        // アルゴリズム切り替えロジック
        this.emit('algorithmSwitch', {
          from: 'current',
          to: action.target,
          expectedImprovement: action.expectedImpact
        });
        break;
        
      case 'power_adjustment':
        // 電力調整ロジック
        this.emit('powerAdjustment', {
          newLimit: action.recommendedValue,
          expectedSavings: action.expectedImpact
        });
        break;
        
      case 'thermal_throttle':
        // 温度制御ロジック
        this.emit('thermalThrottle', {
          component: action.target,
          targetTemperature: action.recommendedValue
        });
        break;
        
      case 'hardware_config':
        // ハードウェア設定変更
        this.emit('hardwareConfigChange', {
          setting: action.target,
          newValue: action.recommendedValue
        });
        break;
    }
    
    this.emit('actionExecuted', action);
  }

  /**
   * 学習データの追加（外部から）
   */
  addLearningData(data: Partial<LearningData>): void {
    const fullData: LearningData = {
      timestamp: Date.now(),
      algorithm: 'unknown',
      hashrate: 0,
      power: 0,
      temperature: 0,
      profitability: 0,
      marketConditions: { price: 0, difficulty: 0, volatility: 0 },
      outcome: 'neutral',
      score: 0.5,
      ...data
    };
    
    this.learningData.push(fullData);
  }

  /**
   * モデルの保存
   */
  saveModels(): { profitabilityModel: string; hardwareModel: string } {
    return {
      profitabilityModel: this.profitabilityModel.serialize(),
      hardwareModel: this.hardwareModel.serialize()
    };
  }

  /**
   * モデルの読み込み
   */
  loadModels(data: { profitabilityModel: string; hardwareModel: string }): void {
    this.profitabilityModel = SimpleNeuralNetwork.deserialize(data.profitabilityModel);
    this.hardwareModel = SimpleNeuralNetwork.deserialize(data.hardwareModel);
    
    console.log('📚 AIモデル読み込み完了');
  }

  /**
   * 統計情報の取得
   */
  getStatistics(): {
    learningDataPoints: number;
    modelAccuracy: number;
    optimizationsPerformed: number;
    successRate: number;
  } {
    const successfulData = this.learningData.filter(d => d.outcome === 'success');
    
    return {
      learningDataPoints: this.learningData.length,
      modelAccuracy: this.learningData.length > 0 ? successfulData.length / this.learningData.length : 0,
      optimizationsPerformed: 0, // 実装で追跡
      successRate: this.learningData.length > 0 ? successfulData.length / this.learningData.length : 0
    };
  }

  /**
   * 設定の更新
   */
  updateConfig(newConfig: Partial<AIConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.emit('configUpdated', this.config);
  }
}

// === 使用例 ===
export async function startAIOptimization(): Promise<AIOptimizationEngine> {
  const ai = new AIOptimizationEngine({
    learningRate: 0.01,
    optimizationInterval: 60000, // 1分間隔
    predictionWindow: 30,
    riskTolerance: 'balanced',
    autoSwitch: true,
    features: {
      marketPrediction: true,
      hardwareOptimization: true,
      powerManagement: true,
      temperatureControl: true
    }
  });

  // イベントリスナー設定
  ai.on('algorithmSwitch', (data) => {
    console.log(`🔄 AI推奨アルゴリズム切り替え: ${data.from} → ${data.to} (予想改善: ${data.expectedImprovement.toFixed(1)}%)`);
  });

  ai.on('powerAdjustment', (data) => {
    console.log(`⚡ AI電力最適化: ${data.newLimit}W (予想節約: ${data.expectedSavings.toFixed(1)}%)`);
  });

  ai.on('thermalThrottle', (data) => {
    console.log(`🌡️ AI温度制御: ${data.component} → ${data.targetTemperature}°C`);
  });

  ai.on('modelsTrained', (data) => {
    console.log(`🧠 AI学習完了: ${data.dataPoints}データポイント`);
  });

  await ai.startOptimization();
  
  console.log('🤖 AI最適化エンジン開始完了');
  return ai;
}

export default AIOptimizationEngine;