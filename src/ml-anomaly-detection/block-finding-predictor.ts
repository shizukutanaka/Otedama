/**
 * ブロック発見予測システム
 * 設計思想: John Carmack (最適化), Rob Pike (シンプル), Robert C. Martin (明確性)
 * 
 * 機能:
 * - プール/ソロマイニングのブロック発見確率計算
 * - ポアソン分布による到着時間予測
 * - 期待収益計算
 * - リスク評価
 * - 統計的信頼区間
 * - 実際のハッシュレートデータに基づく予測
 */

import { EventEmitter } from 'events';

// === 型定義 ===
export interface MiningSetup {
  minerHashrate: number; // H/s
  poolHashrate?: number; // H/s (for pool mining)
  networkHashrate: number; // H/s
  difficulty: number;
  blockReward: number; // in satoshis
  poolFee?: number; // percentage
  electricityCost?: number; // USD per kWh
  powerConsumption?: number; // Watts
}

export interface BlockFindingPrediction {
  miningType: 'solo' | 'pool';
  probability: {
    nextBlock: number; // probability of finding next block
    next24h: number; // probability in next 24 hours
    next7days: number; // probability in next 7 days
    next30days: number; // probability in next 30 days
  };
  expectedTime: {
    mean: number; // Expected time in seconds
    median: number;
    percentile95: number; // 95% chance within this time
    confidenceInterval: [number, number]; // 95% CI
  };
  expectedValue: {
    daily: number; // Expected satoshis per day
    weekly: number;
    monthly: number;
    annual: number;
  };
  variance: {
    daily: number; // Daily variance in satoshis
    cv: number; // Coefficient of variation
  };
  riskMetrics: {
    probabilityOfLoss: number; // Probability of no rewards in 30 days
    timeToBreakeven: number; // Days to recover electricity costs
    maxDrawdown: number; // Maximum expected loss period
  };
}

export interface PoolMiningStats {
  expectedShares: number; // Shares per day
  varianceInShares: number;
  payoutFrequency: number; // Days between payouts
  payoutVariance: number;
  reducedVariance: number; // Variance reduction vs solo mining
}

export interface ProbabilityDistribution {
  type: 'poisson' | 'geometric' | 'exponential';
  parameters: Record<string, number>;
  cdf: (x: number) => number; // Cumulative distribution function
  pdf: (x: number) => number; // Probability density function
  quantile: (p: number) => number; // Inverse CDF
}

// === 確率分布ユーティリティ ===
class ProbabilityUtils {
  // ポアソン分布
  static poissonPdf(k: number, lambda: number): number {
    return (Math.pow(lambda, k) * Math.exp(-lambda)) / this.factorial(k);
  }

  static poissonCdf(k: number, lambda: number): number {
    let sum = 0;
    for (let i = 0; i <= k; i++) {
      sum += this.poissonPdf(i, lambda);
    }
    return sum;
  }

  // 指数分布
  static exponentialPdf(x: number, rate: number): number {
    return x < 0 ? 0 : rate * Math.exp(-rate * x);
  }

  static exponentialCdf(x: number, rate: number): number {
    return x < 0 ? 0 : 1 - Math.exp(-rate * x);
  }

  static exponentialQuantile(p: number, rate: number): number {
    return -Math.log(1 - p) / rate;
  }

  // 幾何分布
  static geometricPdf(k: number, p: number): number {
    return Math.pow(1 - p, k - 1) * p;
  }

  static geometricCdf(k: number, p: number): number {
    return 1 - Math.pow(1 - p, k);
  }

  // ガンマ関数近似（スターリング近似）
  static gamma(z: number): number {
    if (z < 0.5) {
      return Math.PI / (Math.sin(Math.PI * z) * this.gamma(1 - z));
    }
    z -= 1;
    const g = 7;
    const c = [
      0.99999999999980993,
      676.5203681218851,
      -1259.1392167224028,
      771.32342877765313,
      -176.61502916214059,
      12.507343278686905,
      -0.13857109526572012,
      9.9843695780195716e-6,
      1.5056327351493116e-7
    ];

    let x = c[0];
    for (let i = 1; i < g + 2; i++) {
      x += c[i] / (z + i);
    }

    const t = z + g + 0.5;
    return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
  }

  static factorial(n: number): number {
    if (n < 0) return NaN;
    if (n === 0 || n === 1) return 1;
    return n * this.factorial(n - 1);
  }

  // 信頼区間計算
  static poissonConfidenceInterval(observed: number, alpha: number = 0.05): [number, number] {
    // Garwood method for Poisson confidence intervals
    const z = this.normalQuantile(1 - alpha / 2);
    const lower = observed === 0 ? 0 : 
      Math.max(0, observed + z * z / 2 - z * Math.sqrt(observed + z * z / 4));
    const upper = observed + z * z / 2 + z * Math.sqrt(observed + z * z / 4);
    return [lower, upper];
  }

  static normalQuantile(p: number): number {
    // Approximation for normal distribution quantile
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    if (p === 0.5) return 0;

    const sign = p < 0.5 ? -1 : 1;
    const r = p < 0.5 ? p : 1 - p;

    const c0 = 2.515517;
    const c1 = 0.802853;
    const c2 = 0.010328;
    const d1 = 1.432788;
    const d2 = 0.189269;
    const d3 = 0.001308;

    const t = Math.sqrt(-2 * Math.log(r));
    const x = t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t);

    return sign * x;
  }
}

// === メインブロック発見予測システム ===
export class BlockFindingPredictor extends EventEmitter {
  private readonly SECONDS_PER_DAY = 86400;
  private readonly SATOSHIS_PER_BTC = 100000000;
  
  constructor() {
    super();
  }

  // === ソロマイニング予測 ===
  predictSoloMining(setup: MiningSetup): BlockFindingPrediction {
    const { minerHashrate, networkHashrate, difficulty, blockReward } = setup;
    
    // ブロック発見確率 = マイナーハッシュレート / ネットワークハッシュレート
    const blockProbability = minerHashrate / networkHashrate;
    
    // 平均ブロック時間（秒）
    const averageBlockTime = 600; // 10 minutes for Bitcoin
    
    // マイナーの期待ブロック発見時間
    const expectedBlockTime = averageBlockTime / blockProbability;
    
    // ポアソン分布のレート（ブロック/秒）
    const blockRate = 1 / expectedBlockTime;
    
    // 各期間でのブロック発見確率
    const probability = {
      nextBlock: blockProbability,
      next24h: 1 - Math.exp(-blockRate * this.SECONDS_PER_DAY),
      next7days: 1 - Math.exp(-blockRate * this.SECONDS_PER_DAY * 7),
      next30days: 1 - Math.exp(-blockRate * this.SECONDS_PER_DAY * 30)
    };

    // 期待時間統計
    const expectedTime = {
      mean: expectedBlockTime,
      median: ProbabilityUtils.exponentialQuantile(0.5, blockRate),
      percentile95: ProbabilityUtils.exponentialQuantile(0.95, blockRate),
      confidenceInterval: [
        ProbabilityUtils.exponentialQuantile(0.025, blockRate),
        ProbabilityUtils.exponentialQuantile(0.975, blockRate)
      ] as [number, number]
    };

    // 期待収益
    const dailyRate = blockRate * this.SECONDS_PER_DAY;
    const expectedValue = {
      daily: dailyRate * blockReward,
      weekly: dailyRate * 7 * blockReward,
      monthly: dailyRate * 30 * blockReward,
      annual: dailyRate * 365 * blockReward
    };

    // 分散計算（ポアソン分布では平均=分散）
    const dailyVariance = dailyRate * blockReward * blockReward;
    const cv = Math.sqrt(dailyVariance) / expectedValue.daily;

    // リスク指標
    const riskMetrics = this.calculateRiskMetrics(
      setup, 
      blockRate, 
      expectedValue.daily
    );

    return {
      miningType: 'solo',
      probability,
      expectedTime,
      expectedValue,
      variance: {
        daily: dailyVariance,
        cv
      },
      riskMetrics
    };
  }

  // === プールマイニング予測 ===
  predictPoolMining(setup: MiningSetup): BlockFindingPrediction {
    const { minerHashrate, poolHashrate, networkHashrate, difficulty, blockReward, poolFee } = setup;
    
    if (!poolHashrate) {
      throw new Error('Pool hashrate required for pool mining prediction');
    }

    // プールのブロック発見確率
    const poolBlockProbability = poolHashrate / networkHashrate;
    const poolBlockRate = poolBlockProbability / 600; // blocks per second
    
    // マイナーのプール内シェア
    const minerPoolShare = minerHashrate / poolHashrate;
    
    // 手数料後の収益
    const feeMultiplier = 1 - (poolFee || 0) / 100;
    const minerRewardPerBlock = blockReward * minerPoolShare * feeMultiplier;

    // プールのブロック発見統計
    const poolExpectedBlockTime = 600 / poolBlockProbability;
    const probability = {
      nextBlock: poolBlockProbability,
      next24h: 1 - Math.exp(-poolBlockRate * this.SECONDS_PER_DAY),
      next7days: 1 - Math.exp(-poolBlockRate * this.SECONDS_PER_DAY * 7),
      next30days: 1 - Math.exp(-poolBlockRate * this.SECONDS_PER_DAY * 30)
    };

    // 期待時間（プール全体のブロック発見時間）
    const expectedTime = {
      mean: poolExpectedBlockTime,
      median: ProbabilityUtils.exponentialQuantile(0.5, poolBlockRate),
      percentile95: ProbabilityUtils.exponentialQuantile(0.95, poolBlockRate),
      confidenceInterval: [
        ProbabilityUtils.exponentialQuantile(0.025, poolBlockRate),
        ProbabilityUtils.exponentialQuantile(0.975, poolBlockRate)
      ] as [number, number]
    };

    // 期待収益（プール内シェアベース）
    const dailyPoolBlocks = poolBlockRate * this.SECONDS_PER_DAY;
    const expectedValue = {
      daily: dailyPoolBlocks * minerRewardPerBlock,
      weekly: dailyPoolBlocks * 7 * minerRewardPerBlock,
      monthly: dailyPoolBlocks * 30 * minerRewardPerBlock,
      annual: dailyPoolBlocks * 365 * minerRewardPerBlock
    };

    // 分散（プールマイニングでは大幅に減少）
    const dailyVariance = dailyPoolBlocks * Math.pow(minerRewardPerBlock, 2);
    const cv = Math.sqrt(dailyVariance) / expectedValue.daily;

    // リスク指標
    const riskMetrics = this.calculateRiskMetrics(
      setup,
      poolBlockRate,
      expectedValue.daily
    );

    return {
      miningType: 'pool',
      probability,
      expectedTime,
      expectedValue,
      variance: {
        daily: dailyVariance,
        cv
      },
      riskMetrics
    };
  }

  // === プール統計計算 ===
  calculatePoolStats(setup: MiningSetup): PoolMiningStats {
    const { minerHashrate, poolHashrate, difficulty } = setup;
    
    if (!poolHashrate) {
      throw new Error('Pool hashrate required for pool statistics');
    }

    // 1日あたりの期待シェア数
    const shareTarget = Math.pow(2, 32); // Default pool share target
    const sharesPerSecond = minerHashrate / shareTarget;
    const expectedShares = sharesPerSecond * this.SECONDS_PER_DAY;
    
    // シェア分散（ポアソン分布）
    const varianceInShares = expectedShares;
    
    // 支払い頻度推定
    const poolBlocksPerDay = (poolHashrate / (difficulty * Math.pow(2, 32))) * this.SECONDS_PER_DAY;
    const payoutFrequency = 1 / poolBlocksPerDay; // Days between payouts
    
    // 支払い分散
    const minerPoolShare = minerHashrate / poolHashrate;
    const payoutVariance = varianceInShares / (poolBlocksPerDay || 1);
    
    // ソロマイニングと比較した分散減少
    const soloVariance = 1 / (minerHashrate / (difficulty * Math.pow(2, 32)) * this.SECONDS_PER_DAY);
    const reducedVariance = payoutVariance / soloVariance;

    return {
      expectedShares,
      varianceInShares,
      payoutFrequency,
      payoutVariance,
      reducedVariance
    };
  }

  // === 比較分析 ===
  compareMiningStrategies(
    soloSetup: MiningSetup,
    poolSetup: MiningSetup
  ): {
    solo: BlockFindingPrediction;
    pool: BlockFindingPrediction;
    recommendation: {
      strategy: 'solo' | 'pool';
      reasons: string[];
      riskTolerance: 'low' | 'medium' | 'high';
    };
  } {
    const soloPrediction = this.predictSoloMining(soloSetup);
    const poolPrediction = this.predictPoolMining(poolSetup);

    const reasons: string[] = [];
    let recommendedStrategy: 'solo' | 'pool' = 'pool';
    let riskTolerance: 'low' | 'medium' | 'high' = 'medium';

    // 期待収益比較
    const soloDaily = soloPrediction.expectedValue.daily;
    const poolDaily = poolPrediction.expectedValue.daily;
    
    if (soloDaily > poolDaily * 1.1) {
      reasons.push(`Solo mining has ${((soloDaily/poolDaily - 1) * 100).toFixed(1)}% higher expected return`);
    } else if (poolDaily > soloDaily * 1.05) {
      reasons.push(`Pool mining has ${((poolDaily/soloDaily - 1) * 100).toFixed(1)}% higher expected return`);
      recommendedStrategy = 'pool';
    }

    // リスク比較
    if (soloPrediction.variance.cv > 5) {
      reasons.push('Solo mining has very high variance (>500%)');
      recommendedStrategy = 'pool';
      riskTolerance = 'high';
    } else if (poolPrediction.variance.cv < 0.5) {
      reasons.push('Pool mining provides stable income (<50% CV)');
      riskTolerance = 'low';
    }

    // ブロック発見時間比較
    if (soloPrediction.expectedTime.mean > 365 * 24 * 3600) {
      reasons.push('Solo mining expected time >1 year');
      recommendedStrategy = 'pool';
    }

    // 損失確率比較
    if (soloPrediction.riskMetrics.probabilityOfLoss > 0.5) {
      reasons.push(`${(soloPrediction.riskMetrics.probabilityOfLoss * 100).toFixed(1)}% chance of no rewards in 30 days with solo mining`);
      recommendedStrategy = 'pool';
    }

    return {
      solo: soloPrediction,
      pool: poolPrediction,
      recommendation: {
        strategy: recommendedStrategy,
        reasons,
        riskTolerance
      }
    };
  }

  // === 動的難易度調整予測 ===
  predictWithDifficultyAdjustment(
    setup: MiningSetup,
    projectedDifficultyChange: number // percentage
  ): BlockFindingPrediction {
    const adjustedSetup = {
      ...setup,
      difficulty: setup.difficulty * (1 + projectedDifficultyChange / 100)
    };

    return setup.poolHashrate 
      ? this.predictPoolMining(adjustedSetup)
      : this.predictSoloMining(adjustedSetup);
  }

  // === プライベートヘルパー ===
  private calculateRiskMetrics(
    setup: MiningSetup,
    blockRate: number,
    dailyExpectedValue: number
  ): BlockFindingPrediction['riskMetrics'] {
    const { electricityCost = 0, powerConsumption = 0 } = setup;
    
    // 30日間で報酬なしの確率
    const probabilityOfLoss = Math.exp(-blockRate * this.SECONDS_PER_DAY * 30);
    
    // 損益分岐時間計算
    const dailyElectricityCost = (powerConsumption * 24 * electricityCost) / 1000;
    const netDailyValue = dailyExpectedValue / this.SATOSHIS_PER_BTC - dailyElectricityCost;
    const timeToBreakeven = netDailyValue > 0 ? 0 : Infinity;
    
    // 最大ドローダウン期間推定
    const maxDrawdown = ProbabilityUtils.exponentialQuantile(0.95, blockRate) / this.SECONDS_PER_DAY;

    return {
      probabilityOfLoss,
      timeToBreakeven,
      maxDrawdown
    };
  }

  // === シミュレーション ===
  simulateBlockFinding(
    setup: MiningSetup,
    simulationDays: number = 365,
    numSimulations: number = 1000
  ): {
    results: number[]; // Daily rewards for each simulation
    statistics: {
      mean: number;
      median: number;
      std: number;
      percentiles: Record<number, number>;
      probabilityOfProfit: number;
    };
  } {
    const prediction = setup.poolHashrate 
      ? this.predictPoolMining(setup)
      : this.predictSoloMining(setup);
    
    const dailyRate = prediction.expectedValue.daily / setup.blockReward;
    const results: number[] = [];

    for (let sim = 0; sim < numSimulations; sim++) {
      let totalReward = 0;
      
      for (let day = 0; day < simulationDays; day++) {
        // ポアソン分布からブロック数をサンプリング
        const blocksFound = this.samplePoisson(dailyRate);
        totalReward += blocksFound * setup.blockReward;
      }
      
      results.push(totalReward);
    }

    // 統計計算
    results.sort((a, b) => a - b);
    const mean = results.reduce((sum, r) => sum + r, 0) / results.length;
    const median = results[Math.floor(results.length / 2)];
    const variance = results.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / results.length;
    const std = Math.sqrt(variance);

    const percentiles: Record<number, number> = {};
    [5, 10, 25, 50, 75, 90, 95].forEach(p => {
      const index = Math.floor((p / 100) * results.length);
      percentiles[p] = results[index];
    });

    const electricityCosts = (setup.electricityCost || 0) * (setup.powerConsumption || 0) * 24 * simulationDays / 1000;
    const profitableResults = results.filter(r => r / this.SATOSHIS_PER_BTC > electricityCosts);
    const probabilityOfProfit = profitableResults.length / results.length;

    return {
      results,
      statistics: {
        mean,
        median,
        std,
        percentiles,
        probabilityOfProfit
      }
    };
  }

  private samplePoisson(lambda: number): number {
    // Knuth's algorithm for Poisson sampling
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;

    do {
      k++;
      p *= Math.random();
    } while (p > L);

    return k - 1;
  }

  // === データエクスポート ===
  generateReport(prediction: BlockFindingPrediction): string {
    const lines = [
      `=== Block Finding Prediction Report ===`,
      `Mining Type: ${prediction.miningType}`,
      ``,
      `Probabilities:`,
      `- Next Block: ${(prediction.probability.nextBlock * 100).toFixed(6)}%`,
      `- Next 24h: ${(prediction.probability.next24h * 100).toFixed(2)}%`,
      `- Next 7 days: ${(prediction.probability.next7days * 100).toFixed(2)}%`,
      `- Next 30 days: ${(prediction.probability.next30days * 100).toFixed(2)}%`,
      ``,
      `Expected Time to Block:`,
      `- Mean: ${this.formatTime(prediction.expectedTime.mean)}`,
      `- Median: ${this.formatTime(prediction.expectedTime.median)}`,
      `- 95th Percentile: ${this.formatTime(prediction.expectedTime.percentile95)}`,
      ``,
      `Expected Rewards (satoshis):`,
      `- Daily: ${prediction.expectedValue.daily.toFixed(0)}`,
      `- Weekly: ${prediction.expectedValue.weekly.toFixed(0)}`,
      `- Monthly: ${prediction.expectedValue.monthly.toFixed(0)}`,
      `- Annual: ${prediction.expectedValue.annual.toFixed(0)}`,
      ``,
      `Risk Metrics:`,
      `- Daily Variance: ${prediction.variance.daily.toFixed(0)}`,
      `- Coefficient of Variation: ${(prediction.variance.cv * 100).toFixed(1)}%`,
      `- Probability of Loss (30d): ${(prediction.riskMetrics.probabilityOfLoss * 100).toFixed(1)}%`,
      `- Max Drawdown: ${prediction.riskMetrics.maxDrawdown.toFixed(1)} days`
    ];

    return lines.join('\n');
  }

  private formatTime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else {
      return `${minutes}m ${Math.floor(seconds % 60)}s`;
    }
  }
}

// === ヘルパークラス ===
export class BlockFindingHelper {
  static createMiningSetup(
    minerHashrate: number,
    networkHashrate: number,
    difficulty: number,
    blockReward: number = 625000000, // 6.25 BTC in satoshis
    poolHashrate?: number,
    poolFee?: number
  ): MiningSetup {
    return {
      minerHashrate,
      networkHashrate,
      difficulty,
      blockReward,
      poolHashrate,
      poolFee
    };
  }

  static formatHashrate(hashrate: number): string {
    const units = [
      { value: 1e18, label: 'EH/s' },
      { value: 1e15, label: 'PH/s' },
      { value: 1e12, label: 'TH/s' },
      { value: 1e9, label: 'GH/s' }
    ];

    for (const unit of units) {
      if (hashrate >= unit.value) {
        return `${(hashrate / unit.value).toFixed(2)} ${unit.label}`;
      }
    }

    return `${hashrate.toFixed(0)} H/s`;
  }

  static formatSatoshis(satoshis: number): string {
    const btc = satoshis / 100000000;
    if (btc >= 1) {
      return `${btc.toFixed(8)} BTC`;
    } else if (satoshis >= 1000) {
      return `${(satoshis / 1000).toFixed(3)}k sats`;
    } else {
      return `${satoshis.toFixed(0)} sats`;
    }
  }

  static calculateBreakevenHashrate(
    difficulty: number,
    electricityCost: number, // USD per kWh
    efficiency: number, // J/TH
    blockReward: number = 625000000,
    btcPrice: number = 50000 // USD
  ): number {
    // Calculate minimum hashrate to break even on electricity
    const secondsPerBlock = 600;
    const hashratePerDifficulty = Math.pow(2, 32);
    
    const powerCostPerSecond = (efficiency * electricityCost) / (1000 * 3600);
    const revenuePerHash = (blockReward / 100000000 * btcPrice) / (difficulty * hashratePerDifficulty * secondsPerBlock);
    
    return powerCostPerSecond / revenuePerHash;
  }
}

export default BlockFindingPredictor;