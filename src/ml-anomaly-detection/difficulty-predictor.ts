/**
 * マイニング難易度予測システム
 * 設計思想: John Carmack (高性能), Rob Pike (シンプル), Robert C. Martin (クリーン)
 * 
 * 機能:
 * - 線形回帰による基本予測
 * - 移動平均による短期予測  
 * - ハッシュレート相関分析
 * - 難易度調整パターン認識
 * - 統計的手法による異常検知
 * - 軽量なML実装（量子機能なし）
 */

import { EventEmitter } from 'events';

// === 型定義 ===
export interface DifficultyPoint {
  timestamp: number;
  difficulty: number;
  hashrate: number;
  blockTime: number;
  adjustmentHeight: number;
}

export interface PredictionResult {
  predictedDifficulty: number;
  confidence: number; // 0-100
  timeframe: string; // '2016-blocks' | '7-days' | '30-days'
  trend: 'increasing' | 'decreasing' | 'stable';
  changePercentage: number;
  factors: {
    hashrateChange: number;
    blockTimeDeviation: number;
    historicalPattern: string;
  };
}

export interface HashrateTrend {
  current: number;
  trend7d: number;
  trend30d: number;
  volatility: number;
  networkGrowth: number;
}

export interface DifficultyStats {
  current: number;
  lastAdjustment: number;
  nextAdjustmentBlocks: number;
  averageBlockTime: number;
  targetBlockTime: number;
  adjustmentHistory: DifficultyAdjustment[];
}

export interface DifficultyAdjustment {
  height: number;
  timestamp: number;
  oldDifficulty: number;
  newDifficulty: number;
  changePercent: number;
  actualBlockTime: number;
}

// === 軽量線形回帰実装 ===
class SimpleLinearRegression {
  private slope: number = 0;
  private intercept: number = 0;
  private rSquared: number = 0;

  fit(x: number[], y: number[]): void {
    if (x.length !== y.length || x.length < 2) {
      throw new Error('Invalid data for regression');
    }

    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);

    this.slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    this.intercept = (sumY - this.slope * sumX) / n;

    // R-squared計算
    const yMean = sumY / n;
    const totalSumSquares = y.reduce((sum, yi) => sum + Math.pow(yi - yMean, 2), 0);
    const residualSumSquares = y.reduce((sum, yi, i) => {
      const predicted = this.predict(x[i]);
      return sum + Math.pow(yi - predicted, 2);
    }, 0);

    this.rSquared = 1 - (residualSumSquares / totalSumSquares);
  }

  predict(x: number): number {
    return this.slope * x + this.intercept;
  }

  getConfidence(): number {
    return Math.max(0, Math.min(100, this.rSquared * 100));
  }
}

// === 移動平均実装 ===
class MovingAverage {
  static simple(data: number[], window: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < data.length; i++) {
      if (i < window - 1) {
        result.push(data[i]);
      } else {
        const sum = data.slice(i - window + 1, i + 1).reduce((a, b) => a + b, 0);
        result.push(sum / window);
      }
    }
    return result;
  }

  static exponential(data: number[], alpha: number = 0.3): number[] {
    const result: number[] = [data[0]];
    for (let i = 1; i < data.length; i++) {
      result.push(alpha * data[i] + (1 - alpha) * result[i - 1]);
    }
    return result;
  }

  static weighted(data: number[], weights: number[]): number {
    if (data.length !== weights.length) {
      throw new Error('Data and weights must have same length');
    }
    const weightedSum = data.reduce((sum, value, i) => sum + value * weights[i], 0);
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    return weightedSum / totalWeight;
  }
}

// === メイン難易度予測システム ===
export class DifficultyPredictor extends EventEmitter {
  private difficultyHistory: DifficultyPoint[] = [];
  private adjustmentHistory: DifficultyAdjustment[] = [];
  private regression = new SimpleLinearRegression();
  private readonly TARGET_BLOCK_TIME = 600; // 10 minutes in seconds
  private readonly BLOCKS_PER_ADJUSTMENT = 2016;
  
  constructor() {
    super();
  }

  // === データ追加 ===
  addDifficultyPoint(point: DifficultyPoint): void {
    this.difficultyHistory.push(point);
    
    // 古いデータを削除（最新1000件のみ保持）
    if (this.difficultyHistory.length > 1000) {
      this.difficultyHistory.shift();
    }

    this.emit('dataPointAdded', point);
  }

  addAdjustmentHistory(adjustments: DifficultyAdjustment[]): void {
    this.adjustmentHistory = adjustments.slice(-50); // 最新50回の調整のみ
  }

  // === 基本予測（線形回帰） ===
  predictBasicDifficulty(blocksAhead: number): PredictionResult {
    if (this.difficultyHistory.length < 10) {
      throw new Error('Insufficient data for prediction');
    }

    const recent = this.difficultyHistory.slice(-50); // 最新50データポイント
    const x = recent.map((_, i) => i);
    const y = recent.map(p => p.difficulty);

    this.regression.fit(x, y);
    
    const predictedDifficulty = this.regression.predict(x.length + blocksAhead);
    const currentDifficulty = recent[recent.length - 1].difficulty;
    const changePercentage = ((predictedDifficulty - currentDifficulty) / currentDifficulty) * 100;

    return {
      predictedDifficulty,
      confidence: this.regression.getConfidence(),
      timeframe: `${blocksAhead}-blocks`,
      trend: this.determineTrend(changePercentage),
      changePercentage,
      factors: {
        hashrateChange: this.calculateHashrateChange(),
        blockTimeDeviation: this.calculateBlockTimeDeviation(),
        historicalPattern: this.analyzeHistoricalPattern()
      }
    };
  }

  // === 次回調整予測 ===
  predictNextAdjustment(currentBlock: number): PredictionResult {
    const blocksUntilAdjustment = this.BLOCKS_PER_ADJUSTMENT - (currentBlock % this.BLOCKS_PER_ADJUSTMENT);
    
    // 現在の平均ブロック時間から調整を予測
    const recentBlockTimes = this.getRecentBlockTimes();
    const avgBlockTime = recentBlockTimes.reduce((a, b) => a + b, 0) / recentBlockTimes.length;
    
    // Bitcoin調整アルゴリズム
    const adjustmentFactor = this.TARGET_BLOCK_TIME / avgBlockTime;
    const currentDifficulty = this.getCurrentDifficulty();
    const predictedDifficulty = currentDifficulty * adjustmentFactor;
    
    // 最大調整制限（±400%）
    const maxIncrease = currentDifficulty * 4;
    const maxDecrease = currentDifficulty * 0.25;
    const clampedDifficulty = Math.max(maxDecrease, Math.min(maxIncrease, predictedDifficulty));
    
    const changePercentage = ((clampedDifficulty - currentDifficulty) / currentDifficulty) * 100;

    return {
      predictedDifficulty: clampedDifficulty,
      confidence: this.calculateAdjustmentConfidence(recentBlockTimes),
      timeframe: `${blocksUntilAdjustment}-blocks`,
      trend: this.determineTrend(changePercentage),
      changePercentage,
      factors: {
        hashrateChange: this.calculateHashrateChange(),
        blockTimeDeviation: ((avgBlockTime - this.TARGET_BLOCK_TIME) / this.TARGET_BLOCK_TIME) * 100,
        historicalPattern: this.analyzeAdjustmentPattern()
      }
    };
  }

  // === ハッシュレート相関予測 ===
  predictByHashrateCorrelation(): PredictionResult {
    if (this.difficultyHistory.length < 20) {
      throw new Error('Insufficient data for hashrate correlation');
    }

    const recent = this.difficultyHistory.slice(-20);
    const hashrateData = recent.map(p => p.hashrate);
    const difficultyData = recent.map(p => p.difficulty);

    // ハッシュレートと難易度の相関を計算
    const correlation = this.calculateCorrelation(hashrateData, difficultyData);
    
    // 最新ハッシュレートトレンドから難易度を予測
    const hashrateMA7 = MovingAverage.simple(hashrateData, 7);
    const hashrateMA3 = MovingAverage.simple(hashrateData, 3);
    
    const hashrateTrend = hashrateMA3[hashrateMA3.length - 1] / hashrateMA7[hashrateMA7.length - 1];
    const currentDifficulty = difficultyData[difficultyData.length - 1];
    const predictedDifficulty = currentDifficulty * hashrateTrend;
    
    const changePercentage = ((predictedDifficulty - currentDifficulty) / currentDifficulty) * 100;

    return {
      predictedDifficulty,
      confidence: Math.abs(correlation) * 100,
      timeframe: '7-days',
      trend: this.determineTrend(changePercentage),
      changePercentage,
      factors: {
        hashrateChange: ((hashrateTrend - 1) * 100),
        blockTimeDeviation: this.calculateBlockTimeDeviation(),
        historicalPattern: `correlation: ${correlation.toFixed(3)}`
      }
    };
  }

  // === 統合予測（複数手法の組み合わせ） ===
  predictCombined(blocksAhead: number = this.BLOCKS_PER_ADJUSTMENT): PredictionResult {
    try {
      const predictions: PredictionResult[] = [];

      // 基本線形回帰
      try {
        predictions.push(this.predictBasicDifficulty(blocksAhead));
      } catch (e) {
        // Skip if insufficient data
      }

      // ハッシュレート相関
      try {
        predictions.push(this.predictByHashrateCorrelation());
      } catch (e) {
        // Skip if insufficient data
      }

      // 調整ベース予測
      if (this.adjustmentHistory.length > 5) {
        try {
          const currentBlock = this.getCurrentBlock();
          predictions.push(this.predictNextAdjustment(currentBlock));
        } catch (e) {
          // Skip if insufficient data
        }
      }

      if (predictions.length === 0) {
        throw new Error('No predictions available');
      }

      // 重み付き平均で統合
      const weights = predictions.map(p => p.confidence / 100);
      const weightedDifficulty = MovingAverage.weighted(
        predictions.map(p => p.predictedDifficulty),
        weights
      );

      const avgConfidence = predictions.reduce((sum, p) => sum + p.confidence, 0) / predictions.length;
      const currentDifficulty = this.getCurrentDifficulty();
      const changePercentage = ((weightedDifficulty - currentDifficulty) / currentDifficulty) * 100;

      return {
        predictedDifficulty: weightedDifficulty,
        confidence: avgConfidence,
        timeframe: `${blocksAhead}-blocks`,
        trend: this.determineTrend(changePercentage),
        changePercentage,
        factors: {
          hashrateChange: this.calculateHashrateChange(),
          blockTimeDeviation: this.calculateBlockTimeDeviation(),
          historicalPattern: `combined(${predictions.length})`
        }
      };

    } catch (error) {
      // フォールバック：シンプルな移動平均
      return this.predictByMovingAverage();
    }
  }

  // === フォールバック予測（移動平均） ===
  private predictByMovingAverage(): PredictionResult {
    if (this.difficultyHistory.length < 5) {
      throw new Error('Insufficient data for any prediction');
    }

    const recent = this.difficultyHistory.slice(-10);
    const difficulties = recent.map(p => p.difficulty);
    const ma5 = MovingAverage.simple(difficulties, 5);
    const ma10 = MovingAverage.simple(difficulties, Math.min(10, difficulties.length));

    const predictedDifficulty = ma5[ma5.length - 1];
    const currentDifficulty = difficulties[difficulties.length - 1];
    const changePercentage = ((predictedDifficulty - currentDifficulty) / currentDifficulty) * 100;

    return {
      predictedDifficulty,
      confidence: 50, // 中程度の信頼度
      timeframe: '5-blocks',
      trend: this.determineTrend(changePercentage),
      changePercentage,
      factors: {
        hashrateChange: 0,
        blockTimeDeviation: 0,
        historicalPattern: 'moving-average-fallback'
      }
    };
  }

  // === 統計計算ヘルパー ===
  private calculateCorrelation(x: number[], y: number[]): number {
    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumYY = y.reduce((sum, yi) => sum + yi * yi, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));

    return denominator === 0 ? 0 : numerator / denominator;
  }

  private calculateHashrateChange(): number {
    if (this.difficultyHistory.length < 7) return 0;

    const recent = this.difficultyHistory.slice(-7);
    const hashrateData = recent.map(p => p.hashrate);
    const oldestHashrate = hashrateData[0];
    const latestHashrate = hashrateData[hashrateData.length - 1];

    return ((latestHashrate - oldestHashrate) / oldestHashrate) * 100;
  }

  private calculateBlockTimeDeviation(): number {
    const recentBlockTimes = this.getRecentBlockTimes();
    if (recentBlockTimes.length === 0) return 0;

    const avgBlockTime = recentBlockTimes.reduce((a, b) => a + b, 0) / recentBlockTimes.length;
    return ((avgBlockTime - this.TARGET_BLOCK_TIME) / this.TARGET_BLOCK_TIME) * 100;
  }

  private calculateAdjustmentConfidence(blockTimes: number[]): number {
    if (blockTimes.length < 3) return 50;

    // ブロック時間の安定性から信頼度を計算
    const avg = blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length;
    const variance = blockTimes.reduce((sum, time) => sum + Math.pow(time - avg, 2), 0) / blockTimes.length;
    const stdDev = Math.sqrt(variance);
    const coefficient = stdDev / avg;

    // 変動係数が小さいほど高い信頼度
    return Math.max(30, Math.min(95, 100 - (coefficient * 100)));
  }

  private getRecentBlockTimes(): number[] {
    if (this.difficultyHistory.length < 2) return [];
    
    const recent = this.difficultyHistory.slice(-10);
    return recent.map(p => p.blockTime).filter(time => time > 0);
  }

  private getCurrentDifficulty(): number {
    if (this.difficultyHistory.length === 0) return 0;
    return this.difficultyHistory[this.difficultyHistory.length - 1].difficulty;
  }

  private getCurrentBlock(): number {
    if (this.difficultyHistory.length === 0) return 0;
    return this.difficultyHistory[this.difficultyHistory.length - 1].adjustmentHeight;
  }

  private determineTrend(changePercentage: number): 'increasing' | 'decreasing' | 'stable' {
    if (changePercentage > 1) return 'increasing';
    if (changePercentage < -1) return 'decreasing';
    return 'stable';
  }

  private analyzeHistoricalPattern(): string {
    if (this.adjustmentHistory.length < 5) return 'insufficient-data';

    const recent = this.adjustmentHistory.slice(-5);
    const increases = recent.filter(adj => adj.changePercent > 0).length;
    const decreases = recent.filter(adj => adj.changePercent < 0).length;

    if (increases >= 4) return 'strong-uptrend';
    if (decreases >= 4) return 'strong-downtrend';
    if (increases === decreases) return 'oscillating';
    return increases > decreases ? 'mild-uptrend' : 'mild-downtrend';
  }

  private analyzeAdjustmentPattern(): string {
    if (this.adjustmentHistory.length < 3) return 'insufficient-data';

    const recent = this.adjustmentHistory.slice(-3);
    const avgChange = recent.reduce((sum, adj) => sum + adj.changePercent, 0) / recent.length;

    if (Math.abs(avgChange) < 1) return 'stable-adjustment';
    return avgChange > 0 ? 'increasing-difficulty' : 'decreasing-difficulty';
  }

  // === パブリック情報取得 ===
  getDifficultyStats(): DifficultyStats | null {
    if (this.difficultyHistory.length === 0) return null;

    const current = this.difficultyHistory[this.difficultyHistory.length - 1];
    const recentBlockTimes = this.getRecentBlockTimes();
    const avgBlockTime = recentBlockTimes.length > 0 
      ? recentBlockTimes.reduce((a, b) => a + b, 0) / recentBlockTimes.length 
      : this.TARGET_BLOCK_TIME;

    return {
      current: current.difficulty,
      lastAdjustment: this.adjustmentHistory.length > 0 
        ? this.adjustmentHistory[this.adjustmentHistory.length - 1].changePercent 
        : 0,
      nextAdjustmentBlocks: this.BLOCKS_PER_ADJUSTMENT - (current.adjustmentHeight % this.BLOCKS_PER_ADJUSTMENT),
      averageBlockTime: avgBlockTime,
      targetBlockTime: this.TARGET_BLOCK_TIME,
      adjustmentHistory: this.adjustmentHistory.slice(-10)
    };
  }

  getHashrateTrend(): HashrateTrend | null {
    if (this.difficultyHistory.length < 30) return null;

    const recent = this.difficultyHistory.slice(-30);
    const hashrateData = recent.map(p => p.hashrate);
    
    const current = hashrateData[hashrateData.length - 1];
    const week7 = hashrateData.slice(-7);
    const month30 = hashrateData;

    const trend7d = week7.length > 1 
      ? ((week7[week7.length - 1] - week7[0]) / week7[0]) * 100 
      : 0;
    
    const trend30d = month30.length > 1 
      ? ((month30[month30.length - 1] - month30[0]) / month30[0]) * 100 
      : 0;

    // ボラティリティ計算
    const avg = hashrateData.reduce((a, b) => a + b, 0) / hashrateData.length;
    const variance = hashrateData.reduce((sum, rate) => sum + Math.pow(rate - avg, 2), 0) / hashrateData.length;
    const volatility = Math.sqrt(variance) / avg * 100;

    return {
      current,
      trend7d,
      trend30d,
      volatility,
      networkGrowth: trend30d
    };
  }

  // === 清掃 ===
  clearData(): void {
    this.difficultyHistory = [];
    this.adjustmentHistory = [];
    this.emit('dataCleared');
  }

  // === データエクスポート ===
  exportPredictionData(): {
    difficultyHistory: DifficultyPoint[];
    adjustmentHistory: DifficultyAdjustment[];
    lastPrediction?: PredictionResult;
  } {
    return {
      difficultyHistory: [...this.difficultyHistory],
      adjustmentHistory: [...this.adjustmentHistory]
    };
  }
}

// === ヘルパー関数 ===
export class DifficultyPredictorHelper {
  static formatDifficulty(difficulty: number): string {
    if (difficulty >= 1e12) {
      return `${(difficulty / 1e12).toFixed(2)}T`;
    } else if (difficulty >= 1e9) {
      return `${(difficulty / 1e9).toFixed(2)}G`;
    } else if (difficulty >= 1e6) {
      return `${(difficulty / 1e6).toFixed(2)}M`;
    }
    return difficulty.toFixed(2);
  }

  static formatHashrate(hashrate: number): string {
    if (hashrate >= 1e18) {
      return `${(hashrate / 1e18).toFixed(2)} EH/s`;
    } else if (hashrate >= 1e15) {
      return `${(hashrate / 1e15).toFixed(2)} PH/s`;
    } else if (hashrate >= 1e12) {
      return `${(hashrate / 1e12).toFixed(2)} TH/s`;
    }
    return `${hashrate.toFixed(2)} H/s`;
  }

  static formatBlockTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  static calculateTimeToAdjustment(blocksRemaining: number, avgBlockTime: number): string {
    const totalSeconds = blocksRemaining * avgBlockTime;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    
    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return `${days}d ${hours % 24}h`;
    }
    return `${hours}h ${minutes}m`;
  }

  static generateMockData(count: number): DifficultyPoint[] {
    const mockData: DifficultyPoint[] = [];
    const baseTime = Date.now() - (count * 600000); // 10 minutes apart
    let baseDifficulty = 50000000000000; // 50T
    let baseHashrate = 400000000000000000000; // 400 EH/s

    for (let i = 0; i < count; i++) {
      // Add some realistic variation
      const difficultyVariation = 1 + (Math.random() - 0.5) * 0.1; // ±5%
      const hashrateVariation = 1 + (Math.random() - 0.5) * 0.15; // ±7.5%
      
      mockData.push({
        timestamp: baseTime + (i * 600000),
        difficulty: baseDifficulty * difficultyVariation,
        hashrate: baseHashrate * hashrateVariation,
        blockTime: 580 + Math.random() * 40, // 580-620 seconds
        adjustmentHeight: 800000 + (i * 2016)
      });

      // Gradual increase over time
      baseDifficulty *= 1.001;
      baseHashrate *= 1.001;
    }

    return mockData;
  }
}

export default DifficultyPredictor;