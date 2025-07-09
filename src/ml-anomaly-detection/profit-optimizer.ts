/**
 * 収益最適化・アルゴリズム選択システム
 * 設計思想: John Carmack (パフォーマンス), Rob Pike (シンプル), Robert C. Martin (クリーン)
 * 
 * 機能:
 * - 複数アルゴリズムの収益比較
 * - リアルタイム最適化
 * - ハードウェア適性分析
 * - 電力効率計算
 * - 自動切り替え推奨
 * - マルチプール対応
 * - 市場状況考慮
 */

import { EventEmitter } from 'events';

// === 型定義 ===
export interface MiningAlgorithm {
  name: string;
  coins: string[];
  difficulty: number;
  networkHashrate: number;
  blockReward: number;
  blockTime: number; // seconds
  poolFee: number; // percentage
  exchangeAvailable: boolean;
  marketCap: number;
}

export interface HardwareProfile {
  deviceType: 'CPU' | 'GPU' | 'ASIC';
  model: string;
  hashrates: Record<string, number>; // algorithm -> hashrate
  powerConsumption: number; // watts
  efficiency: Record<string, number>; // algorithm -> J/MH
  initialCost: number; // USD
  lifespan: number; // months
}

export interface MarketData {
  algorithm: string;
  coin: string;
  price: number; // USD
  volume24h: number;
  change24h: number;
  exchangeLiquidity: number;
  volatility: number;
  timestamp: number;
}

export interface ProfitabilityCalculation {
  algorithm: string;
  coin: string;
  hashrate: number;
  grossRevenue: {
    perHour: number;
    perDay: number;
    perWeek: number;
    perMonth: number;
  };
  expenses: {
    electricity: number;
    poolFees: number;
    exchangeFees: number;
    total: number;
  };
  netProfit: {
    perHour: number;
    perDay: number;
    perWeek: number;
    perMonth: number;
  };
  profitMargin: number; // percentage
  roi: {
    daily: number;
    breakeven: number; // days
  };
  riskMetrics: {
    volatilityAdjusted: number;
    liquidityRisk: number;
    overallRisk: number;
  };
}

export interface OptimizationResult {
  currentBest: ProfitabilityCalculation;
  alternatives: ProfitabilityCalculation[];
  recommendations: {
    immediate: OptimizationRecommendation[];
    strategic: OptimizationRecommendation[];
  };
  switchingAnalysis: {
    shouldSwitch: boolean;
    potentialGain: number;
    switchingCost: number;
    paybackPeriod: number;
  };
}

export interface OptimizationRecommendation {
  type: 'switch_algorithm' | 'switch_pool' | 'adjust_power' | 'upgrade_hardware' | 'wait';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  description: string;
  expectedBenefit: number; // USD per day
  implementationCost: number;
  timeframe: string;
  confidence: number; // 0-100
}

export interface OptimizationStrategy {
  name: string;
  objective: 'maximize_profit' | 'minimize_risk' | 'balance' | 'maximize_hashrate';
  weights: {
    profitability: number;
    stability: number;
    liquidity: number;
    growth: number;
  };
  constraints: {
    minProfitMargin: number;
    maxVolatility: number;
    minLiquidity: number;
    maxSwitchingFrequency: number; // times per day
  };
}

export interface PortfolioOptimization {
  allocations: Record<string, number>; // algorithm -> percentage
  expectedReturn: number;
  expectedRisk: number;
  sharpeRatio: number;
  diversificationBenefit: number;
}

// === アルゴリズムデータベース ===
class AlgorithmDatabase {
  private static algorithms: Record<string, MiningAlgorithm> = {
    'SHA256': {
      name: 'SHA256',
      coins: ['BTC', 'BCH', 'BSV'],
      difficulty: 0,
      networkHashrate: 0,
      blockReward: 0,
      blockTime: 600,
      poolFee: 1.0,
      exchangeAvailable: true,
      marketCap: 0
    },
    'Scrypt': {
      name: 'Scrypt',
      coins: ['LTC', 'DOGE'],
      difficulty: 0,
      networkHashrate: 0,
      blockReward: 0,
      blockTime: 150,
      poolFee: 1.0,
      exchangeAvailable: true,
      marketCap: 0
    },
    'Ethash': {
      name: 'Ethash',
      coins: ['ETC'],
      difficulty: 0,
      networkHashrate: 0,
      blockReward: 0,
      blockTime: 13,
      poolFee: 1.0,
      exchangeAvailable: true,
      marketCap: 0
    },
    'RandomX': {
      name: 'RandomX',
      coins: ['XMR'],
      difficulty: 0,
      networkHashrate: 0,
      blockReward: 0,
      blockTime: 120,
      poolFee: 1.0,
      exchangeAvailable: true,
      marketCap: 0
    },
    'Blake2B': {
      name: 'Blake2B',
      coins: ['SC'],
      difficulty: 0,
      networkHashrate: 0,
      blockReward: 0,
      blockTime: 600,
      poolFee: 1.5,
      exchangeAvailable: true,
      marketCap: 0
    },
    'X11': {
      name: 'X11',
      coins: ['DASH'],
      difficulty: 0,
      networkHashrate: 0,
      blockReward: 0,
      blockTime: 150,
      poolFee: 1.0,
      exchangeAvailable: true,
      marketCap: 0
    }
  };

  static get(algorithm: string): MiningAlgorithm | undefined {
    return this.algorithms[algorithm];
  }

  static getAll(): MiningAlgorithm[] {
    return Object.values(this.algorithms);
  }

  static update(algorithm: string, data: Partial<MiningAlgorithm>): void {
    if (this.algorithms[algorithm]) {
      this.algorithms[algorithm] = { ...this.algorithms[algorithm], ...data };
    }
  }

  static getSupportedAlgorithms(hardwareType: HardwareProfile['deviceType']): string[] {
    switch (hardwareType) {
      case 'CPU':
        return ['RandomX', 'Blake2B'];
      case 'GPU':
        return ['Ethash', 'Blake2B', 'X11'];
      case 'ASIC':
        return ['SHA256', 'Scrypt', 'X11'];
      default:
        return [];
    }
  }
}

// === メイン収益最適化システム ===
export class ProfitOptimizer extends EventEmitter {
  private marketData = new Map<string, MarketData>();
  private hardwareProfiles = new Map<string, HardwareProfile>();
  private electricityCost: number = 0.10; // USD per kWh
  private lastOptimization: number = 0;
  private optimizationInterval: number = 300000; // 5 minutes
  private currentStrategy: OptimizationStrategy;

  constructor() {
    super();
    this.currentStrategy = this.getDefaultStrategy();
  }

  // === 設定 ===
  setElectricityCost(cost: number): void {
    this.electricityCost = cost;
    this.emit('configurationChanged', { electricityCost: cost });
  }

  setOptimizationStrategy(strategy: OptimizationStrategy): void {
    this.currentStrategy = strategy;
    this.emit('strategyChanged', strategy);
  }

  // === データ管理 ===
  updateMarketData(data: MarketData): void {
    const key = `${data.algorithm}_${data.coin}`;
    this.marketData.set(key, data);
    
    // アルゴリズムデータベース更新
    const algorithm = AlgorithmDatabase.get(data.algorithm);
    if (algorithm) {
      AlgorithmDatabase.update(data.algorithm, {
        difficulty: data.coin === algorithm.coins[0] ? algorithm.difficulty : algorithm.difficulty
      });
    }

    this.emit('marketDataUpdated', data);
    this.maybeOptimize();
  }

  addHardwareProfile(profile: HardwareProfile): void {
    this.hardwareProfiles.set(profile.model, profile);
    this.emit('hardwareAdded', profile);
  }

  // === 収益性計算 ===
  calculateProfitability(
    algorithm: string,
    coin: string,
    hardware: HardwareProfile
  ): ProfitabilityCalculation {
    const marketKey = `${algorithm}_${coin}`;
    const market = this.marketData.get(marketKey);
    const algoData = AlgorithmDatabase.get(algorithm);

    if (!market || !algoData) {
      throw new Error(`Missing data for ${algorithm}/${coin}`);
    }

    const hashrate = hardware.hashrates[algorithm];
    if (!hashrate) {
      throw new Error(`Hardware ${hardware.model} doesn't support ${algorithm}`);
    }

    // 時間あたりの期待ブロック数
    const hashrateShare = hashrate / algoData.networkHashrate;
    const blocksPerSecond = 1 / algoData.blockTime;
    const minerBlocksPerSecond = blocksPerSecond * hashrateShare;

    // 収益計算
    const revenuePerSecond = minerBlocksPerSecond * algoData.blockReward * market.price;
    const grossRevenue = {
      perHour: revenuePerSecond * 3600,
      perDay: revenuePerSecond * 86400,
      perWeek: revenuePerSecond * 86400 * 7,
      perMonth: revenuePerSecond * 86400 * 30
    };

    // 費用計算
    const powerCostPerHour = (hardware.powerConsumption * this.electricityCost) / 1000;
    const poolFeesPerHour = grossRevenue.perHour * (algoData.poolFee / 100);
    const exchangeFeesPerHour = grossRevenue.perHour * 0.001; // 0.1% exchange fee

    const expenses = {
      electricity: powerCostPerHour * 24,
      poolFees: poolFeesPerHour * 24,
      exchangeFees: exchangeFeesPerHour * 24,
      total: (powerCostPerHour + poolFeesPerHour + exchangeFeesPerHour) * 24
    };

    // 純利益
    const netProfitPerHour = grossRevenue.perHour - powerCostPerHour - poolFeesPerHour - exchangeFeesPerHour;
    const netProfit = {
      perHour: netProfitPerHour,
      perDay: netProfitPerHour * 24,
      perWeek: netProfitPerHour * 24 * 7,
      perMonth: netProfitPerHour * 24 * 30
    };

    const profitMargin = grossRevenue.perDay > 0 ? (netProfit.perDay / grossRevenue.perDay) * 100 : 0;

    // ROI計算
    const roi = {
      daily: (netProfit.perDay / hardware.initialCost) * 100,
      breakeven: hardware.initialCost / (netProfit.perDay || 1)
    };

    // リスク指標
    const riskMetrics = this.calculateRiskMetrics(market, netProfit.perDay);

    return {
      algorithm,
      coin,
      hashrate,
      grossRevenue,
      expenses,
      netProfit,
      profitMargin,
      roi,
      riskMetrics
    };
  }

  // === 最適化実行 ===
  optimize(hardware: HardwareProfile): OptimizationResult {
    const supportedAlgorithms = AlgorithmDatabase.getSupportedAlgorithms(hardware.deviceType);
    const profitabilities: ProfitabilityCalculation[] = [];

    // 全ての対応アルゴリズム/コインの組み合わせを計算
    for (const algorithm of supportedAlgorithms) {
      const algoData = AlgorithmDatabase.get(algorithm);
      if (!algoData) continue;

      for (const coin of algoData.coins) {
        try {
          const profitability = this.calculateProfitability(algorithm, coin, hardware);
          profitabilities.push(profitability);
        } catch (error) {
          // データ不足の場合はスキップ
          continue;
        }
      }
    }

    if (profitabilities.length === 0) {
      throw new Error('No profitable algorithms found');
    }

    // 戦略に基づいてソート
    const scored = profitabilities.map(p => ({
      ...p,
      score: this.calculateStrategyScore(p)
    }));

    scored.sort((a, b) => b.score - a.score);

    const currentBest = scored[0];
    const alternatives = scored.slice(1, 6); // Top 5 alternatives

    // 切り替え分析
    const switchingAnalysis = this.analyzeSwitching(currentBest, alternatives[0]);

    // 推奨事項生成
    const recommendations = this.generateRecommendations(scored, hardware);

    return {
      currentBest,
      alternatives,
      recommendations,
      switchingAnalysis
    };
  }

  // === ポートフォリオ最適化 ===
  optimizePortfolio(
    hardware: HardwareProfile[],
    targetReturn?: number,
    maxRisk?: number
  ): PortfolioOptimization {
    const algorithms = new Set<string>();
    const profitabilities = new Map<string, ProfitabilityCalculation[]>();

    // 全ハードウェアの収益性を計算
    for (const hw of hardware) {
      const result = this.optimize(hw);
      const algo = result.currentBest.algorithm;
      algorithms.add(algo);
      
      if (!profitabilities.has(algo)) {
        profitabilities.set(algo, []);
      }
      profitabilities.get(algo)!.push(result.currentBest);
    }

    // 単純な等ウェイト配分から開始
    const allocations: Record<string, number> = {};
    const algoArray = Array.from(algorithms);
    const equalWeight = 1 / algoArray.length;

    for (const algo of algoArray) {
      allocations[algo] = equalWeight;
    }

    // 期待リターンとリスクを計算
    const expectedReturn = this.calculatePortfolioReturn(allocations, profitabilities);
    const expectedRisk = this.calculatePortfolioRisk(allocations, profitabilities);
    const sharpeRatio = expectedRisk > 0 ? expectedReturn / expectedRisk : 0;

    // 分散効果
    const averageReturn = algoArray.reduce((sum, algo) => {
      const profits = profitabilities.get(algo) || [];
      const avgProfit = profits.reduce((s, p) => s + p.netProfit.perDay, 0) / profits.length;
      return sum + avgProfit;
    }, 0) / algoArray.length;

    const diversificationBenefit = expectedReturn / averageReturn - 1;

    return {
      allocations,
      expectedReturn,
      expectedRisk,
      sharpeRatio,
      diversificationBenefit
    };
  }

  // === 自動最適化 ===
  startAutoOptimization(intervalMinutes: number = 5): void {
    this.optimizationInterval = intervalMinutes * 60000;
    
    const interval = setInterval(() => {
      this.performAutoOptimization();
    }, this.optimizationInterval);

    this.emit('autoOptimizationStarted', { intervalMinutes });
  }

  private performAutoOptimization(): void {
    for (const [model, hardware] of this.hardwareProfiles) {
      try {
        const result = this.optimize(hardware);
        
        // 高優先度の推奨事項があれば通知
        const urgentRecommendations = result.recommendations.immediate
          .filter(r => r.priority === 'urgent' || r.priority === 'high');

        if (urgentRecommendations.length > 0) {
          this.emit('urgentOptimization', {
            hardware: model,
            recommendations: urgentRecommendations,
            currentBest: result.currentBest
          });
        }

        this.emit('optimizationCompleted', {
          hardware: model,
          result
        });

      } catch (error) {
        this.emit('optimizationError', {
          hardware: model,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  // === プライベートヘルパー ===
  private calculateRiskMetrics(market: MarketData, dailyProfit: number): ProfitabilityCalculation['riskMetrics'] {
    // ボラティリティ調整利益
    const volatilityAdjusted = dailyProfit * (1 - market.volatility / 100);
    
    // 流動性リスク
    const liquidityRisk = Math.max(0, 1 - market.exchangeLiquidity / 1000000); // $1M baseline
    
    // 総合リスク
    const overallRisk = (market.volatility + liquidityRisk * 100) / 2;

    return {
      volatilityAdjusted,
      liquidityRisk,
      overallRisk
    };
  }

  private calculateStrategyScore(profitability: ProfitabilityCalculation): number {
    const weights = this.currentStrategy.weights;
    
    // 正規化された指標
    const profitScore = Math.max(0, profitability.netProfit.perDay) / 100; // Normalize to $100/day
    const stabilityScore = Math.max(0, 100 - profitability.riskMetrics.overallRisk) / 100;
    const liquidityScore = Math.max(0, 1 - profitability.riskMetrics.liquidityRisk);
    const roiScore = Math.max(0, Math.min(1, profitability.roi.daily / 10)); // 10% daily ROI = 1.0

    return (
      profitScore * weights.profitability +
      stabilityScore * weights.stability +
      liquidityScore * weights.liquidity +
      roiScore * weights.growth
    );
  }

  private analyzeSwitching(
    current: ProfitabilityCalculation,
    alternative?: ProfitabilityCalculation
  ): OptimizationResult['switchingAnalysis'] {
    if (!alternative) {
      return {
        shouldSwitch: false,
        potentialGain: 0,
        switchingCost: 0,
        paybackPeriod: Infinity
      };
    }

    const potentialGain = alternative.netProfit.perDay - current.netProfit.perDay;
    const switchingCost = 10; // Estimated switching cost in USD
    const paybackPeriod = switchingCost / (potentialGain || 1);

    return {
      shouldSwitch: potentialGain > 5 && paybackPeriod < 7, // $5/day gain, <7 days payback
      potentialGain,
      switchingCost,
      paybackPeriod
    };
  }

  private generateRecommendations(
    scored: Array<ProfitabilityCalculation & { score: number }>,
    hardware: HardwareProfile
  ): OptimizationResult['recommendations'] {
    const immediate: OptimizationRecommendation[] = [];
    const strategic: OptimizationRecommendation[] = [];

    const best = scored[0];
    const second = scored[1];

    // 即座の推奨事項
    if (second && second.netProfit.perDay > best.netProfit.perDay * 1.1) {
      immediate.push({
        type: 'switch_algorithm',
        priority: 'high',
        description: `Switch to ${second.algorithm}/${second.coin} for ${((second.netProfit.perDay - best.netProfit.perDay)).toFixed(2)} USD/day more profit`,
        expectedBenefit: second.netProfit.perDay - best.netProfit.perDay,
        implementationCost: 10,
        timeframe: 'immediate',
        confidence: 85
      });
    }

    // 電力効率の推奨
    if (best.profitMargin < 50) {
      immediate.push({
        type: 'adjust_power',
        priority: 'medium',
        description: 'Consider reducing power limit to improve profit margin',
        expectedBenefit: best.grossRevenue.perDay * 0.05,
        implementationCost: 0,
        timeframe: 'immediate',
        confidence: 70
      });
    }

    // 戦略的推奨事項
    if (best.roi.breakeven > 365) {
      strategic.push({
        type: 'upgrade_hardware',
        priority: 'low',
        description: 'Hardware ROI is poor. Consider upgrading to more efficient equipment',
        expectedBenefit: best.netProfit.perDay * 0.5,
        implementationCost: hardware.initialCost,
        timeframe: '3-6 months',
        confidence: 60
      });
    }

    return { immediate, strategic };
  }

  private calculatePortfolioReturn(
    allocations: Record<string, number>,
    profitabilities: Map<string, ProfitabilityCalculation[]>
  ): number {
    let totalReturn = 0;
    
    for (const [algo, weight] of Object.entries(allocations)) {
      const profits = profitabilities.get(algo) || [];
      const avgProfit = profits.reduce((sum, p) => sum + p.netProfit.perDay, 0) / profits.length;
      totalReturn += weight * avgProfit;
    }
    
    return totalReturn;
  }

  private calculatePortfolioRisk(
    allocations: Record<string, number>,
    profitabilities: Map<string, ProfitabilityCalculation[]>
  ): number {
    let totalRisk = 0;
    
    for (const [algo, weight] of Object.entries(allocations)) {
      const profits = profitabilities.get(algo) || [];
      const avgRisk = profits.reduce((sum, p) => sum + p.riskMetrics.overallRisk, 0) / profits.length;
      totalRisk += weight * weight * avgRisk;
    }
    
    return Math.sqrt(totalRisk);
  }

  private maybeOptimize(): void {
    const now = Date.now();
    if (now - this.lastOptimization > this.optimizationInterval) {
      this.lastOptimization = now;
      this.performAutoOptimization();
    }
  }

  private getDefaultStrategy(): OptimizationStrategy {
    return {
      name: 'Balanced',
      objective: 'balance',
      weights: {
        profitability: 0.4,
        stability: 0.3,
        liquidity: 0.2,
        growth: 0.1
      },
      constraints: {
        minProfitMargin: 20,
        maxVolatility: 50,
        minLiquidity: 100000,
        maxSwitchingFrequency: 4
      }
    };
  }

  // === パブリックユーティリティ ===
  getTopAlgorithms(hardware: HardwareProfile, count: number = 5): ProfitabilityCalculation[] {
    const result = this.optimize(hardware);
    return [result.currentBest, ...result.alternatives].slice(0, count);
  }

  estimateHardwareUpgrade(
    currentHardware: HardwareProfile,
    newHardware: HardwareProfile
  ): {
    profitIncrease: number;
    paybackPeriod: number;
    recommendation: boolean;
  } {
    const currentProfit = this.optimize(currentHardware).currentBest.netProfit.perDay;
    const newProfit = this.optimize(newHardware).currentBest.netProfit.perDay;
    
    const profitIncrease = newProfit - currentProfit;
    const upgradeCost = newHardware.initialCost - (currentHardware.initialCost * 0.3); // 30% resale
    const paybackPeriod = upgradeCost / (profitIncrease || 1);

    return {
      profitIncrease,
      paybackPeriod,
      recommendation: profitIncrease > 5 && paybackPeriod < 365
    };
  }

  generateOptimizationReport(hardware: HardwareProfile): string {
    const result = this.optimize(hardware);
    const best = result.currentBest;

    const lines = [
      `=== Profit Optimization Report ===`,
      `Hardware: ${hardware.model}`,
      `Optimization Strategy: ${this.currentStrategy.name}`,
      ``,
      `Current Best: ${best.algorithm}/${best.coin}`,
      `- Net Profit: $${best.netProfit.perDay.toFixed(2)}/day`,
      `- Profit Margin: ${best.profitMargin.toFixed(1)}%`,
      `- ROI: ${best.roi.daily.toFixed(2)}%/day`,
      `- Breakeven: ${best.roi.breakeven.toFixed(0)} days`,
      ``,
      `Risk Metrics:`,
      `- Overall Risk: ${best.riskMetrics.overallRisk.toFixed(1)}%`,
      `- Liquidity Risk: ${(best.riskMetrics.liquidityRisk * 100).toFixed(1)}%`,
      ``,
      `Immediate Recommendations:`,
      ...result.recommendations.immediate.map(r => 
        `- ${r.description} (${r.priority} priority)`
      ),
      ``,
      `Top Alternatives:`,
      ...result.alternatives.slice(0, 3).map(alt => 
        `- ${alt.algorithm}/${alt.coin}: $${alt.netProfit.perDay.toFixed(2)}/day`
      )
    ];

    return lines.join('\n');
  }

  // === モックデータ生成 ===
  generateMockMarketData(): MarketData[] {
    const mockData: MarketData[] = [];
    const algorithms = AlgorithmDatabase.getAll();

    for (const algo of algorithms) {
      for (const coin of algo.coins) {
        mockData.push({
          algorithm: algo.name,
          coin,
          price: Math.random() * 1000 + 10,
          volume24h: Math.random() * 10000000 + 1000000,
          change24h: (Math.random() - 0.5) * 20,
          exchangeLiquidity: Math.random() * 5000000 + 500000,
          volatility: Math.random() * 30 + 10,
          timestamp: Date.now()
        });
      }
    }

    return mockData;
  }

  createMockHardwareProfile(type: HardwareProfile['deviceType']): HardwareProfile {
    const baseHashrates: Record<string, Record<string, number>> = {
      'CPU': {
        'RandomX': 15000,
        'Blake2B': 2000000000
      },
      'GPU': {
        'Ethash': 60000000,
        'Blake2B': 5000000000,
        'X11': 45000000
      },
      'ASIC': {
        'SHA256': 110000000000000,
        'Scrypt': 9500000000,
        'X11': 300000000000
      }
    };

    return {
      deviceType: type,
      model: `Mock ${type} Device`,
      hashrates: baseHashrates[type] || {},
      powerConsumption: type === 'ASIC' ? 3250 : type === 'GPU' ? 300 : 150,
      efficiency: {},
      initialCost: type === 'ASIC' ? 8000 : type === 'GPU' ? 500 : 200,
      lifespan: type === 'ASIC' ? 24 : 36
    };
  }
}

// === ヘルパークラス ===
export class ProfitOptimizerHelper {
  static createOptimizationStrategy(
    objective: OptimizationStrategy['objective'],
    customWeights?: Partial<OptimizationStrategy['weights']>
  ): OptimizationStrategy {
    const baseWeights = {
      'maximize_profit': { profitability: 0.7, stability: 0.1, liquidity: 0.1, growth: 0.1 },
      'minimize_risk': { profitability: 0.2, stability: 0.5, liquidity: 0.2, growth: 0.1 },
      'balance': { profitability: 0.4, stability: 0.3, liquidity: 0.2, growth: 0.1 },
      'maximize_hashrate': { profitability: 0.3, stability: 0.2, liquidity: 0.1, growth: 0.4 }
    };

    return {
      name: objective.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase()),
      objective,
      weights: { ...baseWeights[objective], ...customWeights },
      constraints: {
        minProfitMargin: 10,
        maxVolatility: 80,
        minLiquidity: 50000,
        maxSwitchingFrequency: 6
      }
    };
  }

  static formatProfit(profit: number): string {
    if (Math.abs(profit) >= 1000) {
      return `$${(profit / 1000).toFixed(1)}k`;
    }
    return `$${profit.toFixed(2)}`;
  }

  static formatHashrate(hashrate: number, algorithm: string): string {
    const units = algorithm === 'SHA256' ? 'TH/s' : 
                  algorithm === 'Scrypt' ? 'MH/s' :
                  algorithm === 'Ethash' ? 'MH/s' : 'KH/s';
    
    const divisor = algorithm === 'SHA256' ? 1e12 :
                    algorithm === 'Scrypt' ? 1e6 :
                    algorithm === 'Ethash' ? 1e6 : 1e3;
    
    return `${(hashrate / divisor).toFixed(2)} ${units}`;
  }

  static calculateEfficiencyRating(profitability: ProfitabilityCalculation): number {
    const efficiency = profitability.netProfit.perDay / (profitability.expenses.electricity || 1);
    return Math.min(100, Math.max(0, efficiency * 10));
  }
}

export default ProfitOptimizer;