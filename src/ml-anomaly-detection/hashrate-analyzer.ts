/**
 * ハッシュレート統計分析システム
 * 設計思想: John Carmack (効率性), Rob Pike (明確性), Robert C. Martin (保守性)
 * 
 * 機能:
 * - リアルタイムハッシュレート監視
 * - 統計的異常検知
 * - トレンド分析と予測
 * - ネットワーク成長率計算
 * - マイナー分散度分析
 * - 地理的分布推定
 * - パフォーマンス効率分析
 */

import { EventEmitter } from 'events';

// === 型定義 ===
export interface HashrateDataPoint {
  timestamp: number;
  hashrate: number;
  difficulty: number;
  blockHeight: number;
  networkNodes: number;
  poolDistribution?: PoolShare[];
  geographicData?: GeographicDistribution;
}

export interface PoolShare {
  poolName: string;
  hashrate: number;
  percentage: number;
  blockCount24h: number;
}

export interface GeographicDistribution {
  region: string;
  country: string;
  estimatedHashrate: number;
  percentage: number;
  energyCost: number; // USD per kWh
}

export interface StatisticalSummary {
  mean: number;
  median: number;
  standardDeviation: number;
  variance: number;
  skewness: number;
  kurtosis: number;
  min: number;
  max: number;
  percentile25: number;
  percentile75: number;
  confidenceInterval95: [number, number];
}

export interface TrendAnalysis {
  direction: 'increasing' | 'decreasing' | 'stable' | 'volatile';
  slope: number;
  rSquared: number;
  growthRate: number; // percentage per period
  volatility: number;
  momentum: number;
  support: number;
  resistance: number;
}

export interface AnomalyDetection {
  isAnomaly: boolean;
  severity: 'low' | 'medium' | 'high';
  zScore: number;
  deviation: number;
  confidence: number;
  type: 'spike' | 'drop' | 'outlier' | 'pattern_break';
  description: string;
}

export interface NetworkHealth {
  score: number; // 0-100
  decentralization: number; // Herfindahl-Hirschman Index
  stability: number;
  growth: number;
  efficiency: number;
  resilience: number;
  concerns: string[];
  recommendations: string[];
}

export interface PredictionModel {
  type: 'linear' | 'exponential' | 'polynomial' | 'seasonal';
  accuracy: number;
  rmse: number;
  mae: number;
  parameters: Record<string, number>;
  confidence: number;
}

// === 統計ユーティリティ ===
class StatisticalUtils {
  static mean(data: number[]): number {
    return data.reduce((sum, value) => sum + value, 0) / data.length;
  }

  static median(data: number[]): number {
    const sorted = [...data].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  static standardDeviation(data: number[]): number {
    const mean = this.mean(data);
    const variance = data.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / data.length;
    return Math.sqrt(variance);
  }

  static variance(data: number[]): number {
    const mean = this.mean(data);
    return data.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / data.length;
  }

  static skewness(data: number[]): number {
    const mean = this.mean(data);
    const stdDev = this.standardDeviation(data);
    const n = data.length;
    const skew = data.reduce((sum, value) => sum + Math.pow((value - mean) / stdDev, 3), 0);
    return (n / ((n - 1) * (n - 2))) * skew;
  }

  static kurtosis(data: number[]): number {
    const mean = this.mean(data);
    const stdDev = this.standardDeviation(data);
    const n = data.length;
    const kurt = data.reduce((sum, value) => sum + Math.pow((value - mean) / stdDev, 4), 0);
    return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * kurt - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  }

  static percentile(data: number[], p: number): number {
    const sorted = [...data].sort((a, b) => a - b);
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index % 1;
    
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  static zScore(value: number, mean: number, stdDev: number): number {
    return (value - mean) / stdDev;
  }

  static correlation(x: number[], y: number[]): number {
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

  static linearRegression(x: number[], y: number[]): { slope: number; intercept: number; rSquared: number } {
    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    // R-squared
    const yMean = sumY / n;
    const totalSumSquares = y.reduce((sum, yi) => sum + Math.pow(yi - yMean, 2), 0);
    const residualSumSquares = y.reduce((sum, yi, i) => {
      const predicted = slope * x[i] + intercept;
      return sum + Math.pow(yi - predicted, 2);
    }, 0);

    const rSquared = 1 - (residualSumSquares / totalSumSquares);

    return { slope, intercept, rSquared };
  }

  static exponentialSmoothing(data: number[], alpha: number = 0.3): number[] {
    const result = [data[0]];
    for (let i = 1; i < data.length; i++) {
      result.push(alpha * data[i] + (1 - alpha) * result[i - 1]);
    }
    return result;
  }

  static seasonalDecomposition(data: number[], period: number): {
    trend: number[];
    seasonal: number[];
    residual: number[];
  } {
    // Simplified seasonal decomposition
    const trend = this.movingAverage(data, period);
    const seasonal: number[] = [];
    const residual: number[] = [];

    // Calculate seasonal component
    for (let i = 0; i < data.length; i++) {
      const seasonIndex = i % period;
      if (!seasonal[seasonIndex]) seasonal[seasonIndex] = 0;
      seasonal[seasonIndex] += (data[i] - (trend[i] || trend[trend.length - 1]));
    }

    // Average seasonal components
    for (let i = 0; i < seasonal.length; i++) {
      seasonal[i] /= Math.floor(data.length / period);
    }

    // Calculate residual
    for (let i = 0; i < data.length; i++) {
      const trendValue = trend[i] || trend[trend.length - 1];
      const seasonalValue = seasonal[i % period];
      residual.push(data[i] - trendValue - seasonalValue);
    }

    return { trend, seasonal, residual };
  }

  static movingAverage(data: number[], window: number): number[] {
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
}

// === メインハッシュレート分析システム ===
export class HashrateAnalyzer extends EventEmitter {
  private dataPoints: HashrateDataPoint[] = [];
  private readonly MAX_DATA_POINTS = 10000;
  private anomalyThreshold = 2.5; // Z-score threshold
  private trendWindow = 168; // 1 week in hours
  
  constructor() {
    super();
  }

  // === データ管理 ===
  addDataPoint(dataPoint: HashrateDataPoint): void {
    this.dataPoints.push(dataPoint);
    
    // データサイズ制限
    if (this.dataPoints.length > this.MAX_DATA_POINTS) {
      this.dataPoints.shift();
    }

    // 異常検知
    const anomaly = this.detectAnomalies([dataPoint])[0];
    if (anomaly?.isAnomaly) {
      this.emit('anomalyDetected', { dataPoint, anomaly });
    }

    this.emit('dataPointAdded', dataPoint);
  }

  addDataPoints(dataPoints: HashrateDataPoint[]): void {
    dataPoints.forEach(point => this.addDataPoint(point));
  }

  // === 統計分析 ===
  getStatisticalSummary(timeframeHours?: number): StatisticalSummary {
    const data = this.getTimeframeData(timeframeHours);
    const hashrates = data.map(d => d.hashrate);

    if (hashrates.length === 0) {
      throw new Error('No data available for analysis');
    }

    const mean = StatisticalUtils.mean(hashrates);
    const stdDev = StatisticalUtils.standardDeviation(hashrates);

    return {
      mean,
      median: StatisticalUtils.median(hashrates),
      standardDeviation: stdDev,
      variance: StatisticalUtils.variance(hashrates),
      skewness: StatisticalUtils.skewness(hashrates),
      kurtosis: StatisticalUtils.kurtosis(hashrates),
      min: Math.min(...hashrates),
      max: Math.max(...hashrates),
      percentile25: StatisticalUtils.percentile(hashrates, 25),
      percentile75: StatisticalUtils.percentile(hashrates, 75),
      confidenceInterval95: [
        mean - 1.96 * stdDev,
        mean + 1.96 * stdDev
      ]
    };
  }

  // === トレンド分析 ===
  analyzeTrend(timeframeHours: number = this.trendWindow): TrendAnalysis {
    const data = this.getTimeframeData(timeframeHours);
    if (data.length < 10) {
      throw new Error('Insufficient data for trend analysis');
    }

    const hashrates = data.map(d => d.hashrate);
    const timeIndices = data.map((_, i) => i);

    const regression = StatisticalUtils.linearRegression(timeIndices, hashrates);
    const growthRate = (regression.slope / StatisticalUtils.mean(hashrates)) * 100;
    
    // ボラティリティ計算
    const returns = hashrates.slice(1).map((rate, i) => 
      (rate - hashrates[i]) / hashrates[i]
    );
    const volatility = StatisticalUtils.standardDeviation(returns) * 100;

    // モーメンタム計算（短期vs長期移動平均）
    const shortMA = StatisticalUtils.movingAverage(hashrates, Math.min(24, hashrates.length));
    const longMA = StatisticalUtils.movingAverage(hashrates, Math.min(72, hashrates.length));
    const momentum = shortMA[shortMA.length - 1] / longMA[longMA.length - 1] - 1;

    // サポート・レジスタンス計算
    const recentData = hashrates.slice(-48); // Last 48 hours
    const support = Math.min(...recentData);
    const resistance = Math.max(...recentData);

    let direction: TrendAnalysis['direction'];
    if (Math.abs(growthRate) < 0.1) {
      direction = 'stable';
    } else if (volatility > 5) {
      direction = 'volatile';
    } else {
      direction = growthRate > 0 ? 'increasing' : 'decreasing';
    }

    return {
      direction,
      slope: regression.slope,
      rSquared: regression.rSquared,
      growthRate,
      volatility,
      momentum: momentum * 100,
      support,
      resistance
    };
  }

  // === 異常検知 ===
  detectAnomalies(targetData?: HashrateDataPoint[], lookbackHours: number = 168): AnomalyDetection[] {
    const historicalData = this.getTimeframeData(lookbackHours);
    const dataToAnalyze = targetData || this.dataPoints.slice(-1);

    if (historicalData.length < 50) {
      return dataToAnalyze.map(() => ({
        isAnomaly: false,
        severity: 'low' as const,
        zScore: 0,
        deviation: 0,
        confidence: 0,
        type: 'outlier' as const,
        description: 'Insufficient historical data'
      }));
    }

    const historicalHashrates = historicalData.map(d => d.hashrate);
    const mean = StatisticalUtils.mean(historicalHashrates);
    const stdDev = StatisticalUtils.standardDeviation(historicalHashrates);

    return dataToAnalyze.map(dataPoint => {
      const zScore = StatisticalUtils.zScore(dataPoint.hashrate, mean, stdDev);
      const isAnomaly = Math.abs(zScore) > this.anomalyThreshold;
      const deviation = ((dataPoint.hashrate - mean) / mean) * 100;

      let severity: AnomalyDetection['severity'] = 'low';
      let type: AnomalyDetection['type'] = 'outlier';
      let description = 'Normal hashrate';

      if (isAnomaly) {
        if (Math.abs(zScore) > 4) {
          severity = 'high';
        } else if (Math.abs(zScore) > 3) {
          severity = 'medium';
        }

        if (zScore > 0) {
          type = 'spike';
          description = `Hashrate spike: ${deviation.toFixed(1)}% above normal`;
        } else {
          type = 'drop';
          description = `Hashrate drop: ${Math.abs(deviation).toFixed(1)}% below normal`;
        }
      }

      return {
        isAnomaly,
        severity,
        zScore,
        deviation,
        confidence: Math.min(95, (Math.abs(zScore) / this.anomalyThreshold) * 100),
        type,
        description
      };
    });
  }

  // === ネットワーク健全性評価 ===
  assessNetworkHealth(timeframeHours: number = 168): NetworkHealth {
    const data = this.getTimeframeData(timeframeHours);
    const poolData = this.getLatestPoolDistribution();
    
    if (data.length === 0) {
      throw new Error('No data available for health assessment');
    }

    // 分散度計算（Herfindahl-Hirschman Index）
    let decentralization = 100;
    if (poolData.length > 0) {
      const hhi = poolData.reduce((sum, pool) => 
        sum + Math.pow(pool.percentage, 2), 0
      );
      decentralization = Math.max(0, 100 - (hhi / 100));
    }

    // 安定性評価
    const hashrates = data.map(d => d.hashrate);
    const cv = StatisticalUtils.standardDeviation(hashrates) / StatisticalUtils.mean(hashrates);
    const stability = Math.max(0, 100 - (cv * 100));

    // 成長評価
    const trend = this.analyzeTrend(timeframeHours);
    const growth = Math.max(0, Math.min(100, 50 + trend.growthRate * 10));

    // 効率性評価（難易度調整の適切性）
    const efficiency = this.calculateMiningEfficiency(data);

    // 復旧力評価（異常からの回復速度）
    const resilience = this.calculateNetworkResilience(data);

    const score = (decentralization * 0.3 + stability * 0.25 + growth * 0.2 + efficiency * 0.15 + resilience * 0.1);

    const concerns: string[] = [];
    const recommendations: string[] = [];

    if (decentralization < 70) {
      concerns.push('Mining centralization risk');
      recommendations.push('Encourage smaller pool participation');
    }
    if (stability < 80) {
      concerns.push('High hashrate volatility');
      recommendations.push('Monitor for large miner movements');
    }
    if (growth < 40) {
      concerns.push('Declining network security');
      recommendations.push('Investigate economic factors');
    }

    return {
      score: Math.round(score),
      decentralization: Math.round(decentralization),
      stability: Math.round(stability),
      growth: Math.round(growth),
      efficiency: Math.round(efficiency),
      resilience: Math.round(resilience),
      concerns,
      recommendations
    };
  }

  // === 予測モデル ===
  buildPredictionModel(timeframeHours: number = 168, modelType: PredictionModel['type'] = 'linear'): PredictionModel {
    const data = this.getTimeframeData(timeframeHours);
    const hashrates = data.map(d => d.hashrate);
    const timeIndices = data.map((_, i) => i);

    if (data.length < 20) {
      throw new Error('Insufficient data for prediction model');
    }

    let parameters: Record<string, number> = {};
    let predictions: number[] = [];

    switch (modelType) {
      case 'linear':
        const linearReg = StatisticalUtils.linearRegression(timeIndices, hashrates);
        parameters = { slope: linearReg.slope, intercept: linearReg.intercept };
        predictions = timeIndices.map(x => linearReg.slope * x + linearReg.intercept);
        break;

      case 'exponential':
        // Simplified exponential fit
        const smoothed = StatisticalUtils.exponentialSmoothing(hashrates, 0.3);
        parameters = { alpha: 0.3, trend: smoothed[smoothed.length - 1] - smoothed[smoothed.length - 2] };
        predictions = smoothed;
        break;

      case 'seasonal':
        const decomp = StatisticalUtils.seasonalDecomposition(hashrates, 24); // 24-hour cycle
        parameters = { period: 24, trendSlope: 0 };
        predictions = decomp.trend;
        break;

      default:
        throw new Error(`Unsupported model type: ${modelType}`);
    }

    // Calculate accuracy metrics
    const rmse = Math.sqrt(
      hashrates.reduce((sum, actual, i) => 
        sum + Math.pow(actual - predictions[i], 2), 0
      ) / hashrates.length
    );

    const mae = hashrates.reduce((sum, actual, i) => 
      sum + Math.abs(actual - predictions[i]), 0
    ) / hashrates.length;

    const mean = StatisticalUtils.mean(hashrates);
    const accuracy = Math.max(0, 100 - (rmse / mean) * 100);

    return {
      type: modelType,
      accuracy: Math.round(accuracy),
      rmse,
      mae,
      parameters,
      confidence: Math.min(95, accuracy)
    };
  }

  // === プライベートヘルパー ===
  private getTimeframeData(timeframeHours?: number): HashrateDataPoint[] {
    if (!timeframeHours) return [...this.dataPoints];
    
    const cutoffTime = Date.now() - (timeframeHours * 60 * 60 * 1000);
    return this.dataPoints.filter(d => d.timestamp >= cutoffTime);
  }

  private getLatestPoolDistribution(): PoolShare[] {
    const latest = this.dataPoints[this.dataPoints.length - 1];
    return latest?.poolDistribution || [];
  }

  private calculateMiningEfficiency(data: HashrateDataPoint[]): number {
    if (data.length < 2) return 50;

    // 理想的なブロック時間との差を評価
    const blockTimes = data.slice(1).map((point, i) => 
      (point.timestamp - data[i].timestamp) / 1000 / 60 // minutes
    );

    const targetBlockTime = 10; // minutes
    const deviations = blockTimes.map(time => Math.abs(time - targetBlockTime));
    const avgDeviation = deviations.reduce((a, b) => a + b, 0) / deviations.length;
    
    return Math.max(0, 100 - (avgDeviation / targetBlockTime) * 100);
  }

  private calculateNetworkResilience(data: HashrateDataPoint[]): number {
    const anomalies = this.detectAnomalies(undefined, data.length);
    const anomalyCount = anomalies.filter(a => a.isAnomaly).length;
    const anomalyRate = anomalyCount / data.length;
    
    // Lower anomaly rate = higher resilience
    return Math.max(0, 100 - (anomalyRate * 100));
  }

  // === パブリックユーティリティ ===
  setAnomalyThreshold(threshold: number): void {
    this.anomalyThreshold = Math.max(1, Math.min(5, threshold));
  }

  getDataPointCount(): number {
    return this.dataPoints.length;
  }

  getTimeRange(): { start: number; end: number } | null {
    if (this.dataPoints.length === 0) return null;
    return {
      start: this.dataPoints[0].timestamp,
      end: this.dataPoints[this.dataPoints.length - 1].timestamp
    };
  }

  exportData(timeframeHours?: number): HashrateDataPoint[] {
    return this.getTimeframeData(timeframeHours);
  }

  clearData(): void {
    this.dataPoints = [];
    this.emit('dataCleared');
  }

  // === モックデータ生成 ===
  generateMockData(hours: number, baseHashrate: number = 400e18): HashrateDataPoint[] {
    const dataPoints: HashrateDataPoint[] = [];
    const startTime = Date.now() - (hours * 60 * 60 * 1000);
    
    for (let i = 0; i < hours; i++) {
      const timestamp = startTime + (i * 60 * 60 * 1000);
      
      // Add realistic variations
      const trend = 1 + (i / hours) * 0.1; // 10% growth over time
      const noise = 1 + (Math.random() - 0.5) * 0.1; // ±5% random noise
      const seasonal = 1 + Math.sin((i / 24) * 2 * Math.PI) * 0.05; // Daily cycle
      
      const hashrate = baseHashrate * trend * noise * seasonal;
      
      dataPoints.push({
        timestamp,
        hashrate,
        difficulty: hashrate * 7000000, // Simplified difficulty calculation
        blockHeight: 800000 + (i * 6), // ~6 blocks per hour
        networkNodes: 10000 + Math.floor(Math.random() * 1000),
        poolDistribution: this.generateMockPoolDistribution(hashrate),
        geographicData: this.generateMockGeographicData()
      });
    }
    
    return dataPoints;
  }

  private generateMockPoolDistribution(totalHashrate: number): PoolShare[] {
    const pools = ['AntPool', 'F2Pool', 'BTC.com', 'Poolin', 'ViaBTC'];
    const shares = [25, 20, 15, 15, 10]; // Base percentages
    
    return pools.map((name, i) => {
      const percentage = shares[i] + (Math.random() - 0.5) * 5; // ±2.5% variation
      return {
        poolName: name,
        hashrate: totalHashrate * (percentage / 100),
        percentage,
        blockCount24h: Math.floor((percentage / 100) * 144) // ~144 blocks per day
      };
    });
  }

  private generateMockGeographicData(): GeographicDistribution {
    const regions = [
      { region: 'Asia', country: 'China', percentage: 45, energyCost: 0.08 },
      { region: 'North America', country: 'USA', percentage: 25, energyCost: 0.12 },
      { region: 'Asia', country: 'Kazakhstan', percentage: 15, energyCost: 0.06 },
      { region: 'Europe', country: 'Germany', percentage: 10, energyCost: 0.25 },
      { region: 'Other', country: 'Various', percentage: 5, energyCost: 0.15 }
    ];
    
    const selected = regions[Math.floor(Math.random() * regions.length)];
    return {
      ...selected,
      estimatedHashrate: 0 // Will be calculated by consumer
    };
  }
}

// === エクスポートヘルパー ===
export class HashrateAnalyzerHelper {
  static formatHashrate(hashrate: number): string {
    const units = [
      { value: 1e18, label: 'EH/s' },
      { value: 1e15, label: 'PH/s' },
      { value: 1e12, label: 'TH/s' },
      { value: 1e9, label: 'GH/s' },
      { value: 1e6, label: 'MH/s' },
      { value: 1e3, label: 'KH/s' }
    ];

    for (const unit of units) {
      if (hashrate >= unit.value) {
        return `${(hashrate / unit.value).toFixed(2)} ${unit.label}`;
      }
    }

    return `${hashrate.toFixed(2)} H/s`;
  }

  static formatPercentage(value: number, decimals: number = 1): string {
    return `${value.toFixed(decimals)}%`;
  }

  static formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toISOString();
  }

  static createHealthReport(health: NetworkHealth): string {
    const lines = [
      `Network Health Score: ${health.score}/100`,
      `Decentralization: ${health.decentralization}%`,
      `Stability: ${health.stability}%`,
      `Growth: ${health.growth}%`,
      `Efficiency: ${health.efficiency}%`,
      `Resilience: ${health.resilience}%`
    ];

    if (health.concerns.length > 0) {
      lines.push('', 'Concerns:');
      health.concerns.forEach(concern => lines.push(`- ${concern}`));
    }

    if (health.recommendations.length > 0) {
      lines.push('', 'Recommendations:');
      health.recommendations.forEach(rec => lines.push(`- ${rec}`));
    }

    return lines.join('\n');
  }
}

export default HashrateAnalyzer;