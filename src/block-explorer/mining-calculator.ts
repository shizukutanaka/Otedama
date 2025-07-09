/**
 * 軽量マイニングカリキュレーター
 * 設計思想: Carmack (シンプル・高速), Martin (クリーン), Pike (明瞭・効率性)
 * 
 * 主要機能:
 * - 収益計算
 * - ROI分析
 * - 電力コスト計算
 * - 複数通貨対応
 * - リアルタイム更新
 */

import { EventEmitter } from 'events';
import { LightPriceFeed, PriceData } from './price-feed';

// === 型定義 ===
interface MiningHardware {
  name: string;
  hashrate: number; // H/s
  powerConsumption: number; // Watts
  algorithm: string;
  price?: number; // USD
  efficiency?: number; // H/W
}

interface MiningConfig {
  hardware: MiningHardware;
  electricityCost: number; // USD per kWh
  poolFee: number; // percentage (0-100)
  uptime: number; // percentage (0-100)
  difficulty?: number;
  blockReward?: number;
  networkHashrate?: number;
}

interface RevenueCalculation {
  currency: string;
  timeframe: '1h' | '1d' | '1w' | '1m' | '1y';
  
  // Coins mined
  coinsPerHour: number;
  coinsPerDay: number;
  coinsPerWeek: number;
  coinsPerMonth: number;
  coinsPerYear: number;
  
  // Revenue (USD)
  revenuePerHour: number;
  revenuePerDay: number;
  revenuePerWeek: number;
  revenuePerMonth: number;
  revenuePerYear: number;
  
  // Costs
  electricityCostPerHour: number;
  electricityCostPerDay: number;
  electricityCostPerWeek: number;
  electricityCostPerMonth: number;
  electricityCostPerYear: number;
  
  // Profit
  profitPerHour: number;
  profitPerDay: number;
  profitPerWeek: number;
  profitPerMonth: number;
  profitPerYear: number;
  
  // Additional metrics
  breakEvenDays?: number;
  roi?: number; // percentage
  profitMargin: number; // percentage
}

interface NetworkInfo {
  symbol: string;
  algorithm: string;
  difficulty: number;
  blockReward: number;
  blockTime: number; // seconds
  networkHashrate: number;
  nextDifficultyChange?: number; // blocks
  estimatedDifficultyChange?: number; // percentage
}

interface CalculatorConfig {
  priceFeed: LightPriceFeed;
  updateInterval: number; // milliseconds
  supportedAlgorithms: string[];
  defaultNetworkInfo: Record<string, NetworkInfo>;
}

// === アルゴリズム別計算クラス ===
abstract class AlgorithmCalculator {
  abstract calculateHashesPerBlock(difficulty: number): number;
  abstract estimateBlocksPerDay(hashrate: number, networkHashrate: number): number;
  
  protected calculateShareOfNetwork(hashrate: number, networkHashrate: number): number {
    return hashrate / networkHashrate;
  }
  
  protected calculateBlockTime(networkHashrate: number, difficulty: number): number {
    // 一般的なブロック時間計算
    return difficulty * Math.pow(2, 32) / networkHashrate;
  }
}

class SHA256Calculator extends AlgorithmCalculator {
  calculateHashesPerBlock(difficulty: number): number {
    return difficulty * Math.pow(2, 32);
  }
  
  estimateBlocksPerDay(hashrate: number, networkHashrate: number): number {
    const shareOfNetwork = this.calculateShareOfNetwork(hashrate, networkHashrate);
    const blocksPerDay = (24 * 60 * 60) / 600; // Bitcoin: 10分間隔
    return shareOfNetwork * blocksPerDay;
  }
}

class ScryptCalculator extends AlgorithmCalculator {
  calculateHashesPerBlock(difficulty: number): number {
    return difficulty * Math.pow(2, 32);
  }
  
  estimateBlocksPerDay(hashrate: number, networkHashrate: number): number {
    const shareOfNetwork = this.calculateShareOfNetwork(hashrate, networkHashrate);
    const blocksPerDay = (24 * 60 * 60) / 150; // Litecoin: 2.5分間隔
    return shareOfNetwork * blocksPerDay;
  }
}

class EthashCalculator extends AlgorithmCalculator {
  calculateHashesPerBlock(difficulty: number): number {
    return difficulty;
  }
  
  estimateBlocksPerDay(hashrate: number, networkHashrate: number): number {
    const shareOfNetwork = this.calculateShareOfNetwork(hashrate, networkHashrate);
    const blocksPerDay = (24 * 60 * 60) / 13; // Ethereum: 13秒間隔
    return shareOfNetwork * blocksPerDay;
  }
}

// === ハードウェアデータベース ===
class HardwareDatabase {
  private static readonly HARDWARE_DATA: Record<string, MiningHardware[]> = {
    'sha256': [
      {
        name: 'Antminer S19 Pro',
        hashrate: 110e12, // 110 TH/s
        powerConsumption: 3250,
        algorithm: 'sha256',
        price: 2500,
        efficiency: 110e12 / 3250
      },
      {
        name: 'Antminer S21',
        hashrate: 200e12, // 200 TH/s
        powerConsumption: 3500,
        algorithm: 'sha256',
        price: 3500,
        efficiency: 200e12 / 3500
      },
      {
        name: 'Generic ASIC',
        hashrate: 100e12, // 100 TH/s
        powerConsumption: 3000,
        algorithm: 'sha256',
        efficiency: 100e12 / 3000
      }
    ],
    'scrypt': [
      {
        name: 'Antminer L7',
        hashrate: 9.5e9, // 9.5 GH/s
        powerConsumption: 3425,
        algorithm: 'scrypt',
        price: 4000,
        efficiency: 9.5e9 / 3425
      }
    ],
    'ethash': [
      {
        name: 'RTX 4090',
        hashrate: 120e6, // 120 MH/s
        powerConsumption: 450,
        algorithm: 'ethash',
        price: 1600,
        efficiency: 120e6 / 450
      },
      {
        name: 'RTX 3080',
        hashrate: 97e6, // 97 MH/s
        powerConsumption: 320,
        algorithm: 'ethash',
        price: 700,
        efficiency: 97e6 / 320
      }
    ]
  };

  static getHardware(algorithm: string): MiningHardware[] {
    return this.HARDWARE_DATA[algorithm.toLowerCase()] || [];
  }

  static findHardware(name: string, algorithm?: string): MiningHardware | null {
    const algorithms = algorithm ? [algorithm] : Object.keys(this.HARDWARE_DATA);
    
    for (const algo of algorithms) {
      const hardware = this.HARDWARE_DATA[algo.toLowerCase()]?.find(h => 
        h.name.toLowerCase().includes(name.toLowerCase())
      );
      if (hardware) return hardware;
    }
    
    return null;
  }

  static getAllHardware(): MiningHardware[] {
    return Object.values(this.HARDWARE_DATA).flat();
  }
}

// === 計算機ファクトリー ===
class CalculatorFactory {
  static create(algorithm: string): AlgorithmCalculator {
    switch (algorithm.toLowerCase()) {
      case 'sha256':
        return new SHA256Calculator();
      case 'scrypt':
        return new ScryptCalculator();
      case 'ethash':
        return new EthashCalculator();
      default:
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
  }
}

// === メインマイニングカリキュレーター ===
class LightMiningCalculator extends EventEmitter {
  private config: CalculatorConfig;
  private logger: any;
  private updateTimer?: NodeJS.Timeout;
  private networkInfoCache = new Map<string, NetworkInfo>();

  constructor(config: CalculatorConfig, logger?: any) {
    super();
    this.config = config;
    this.logger = logger || {
      info: (msg: string, data?: any) => console.log(`[INFO] ${msg}`, data || ''),
      error: (msg: string, err?: any) => console.error(`[ERROR] ${msg}`, err || ''),
      warn: (msg: string, data?: any) => console.warn(`[WARN] ${msg}`, data || '')
    };

    // デフォルトネットワーク情報をキャッシュに設定
    for (const [symbol, info] of Object.entries(config.defaultNetworkInfo)) {
      this.networkInfoCache.set(symbol, info);
    }

    this.startUpdateTimer();
  }

  async calculateRevenue(miningConfig: MiningConfig, currency: string): Promise<RevenueCalculation> {
    try {
      // 価格情報取得
      const priceData = await this.config.priceFeed.getPrice(currency);
      
      // ネットワーク情報取得
      const networkInfo = await this.getNetworkInfo(currency);
      
      // アルゴリズム計算機取得
      const calculator = CalculatorFactory.create(networkInfo.algorithm);
      
      // 基本計算
      const effectiveHashrate = miningConfig.hardware.hashrate * (miningConfig.uptime / 100);
      const blocksPerDay = calculator.estimateBlocksPerDay(
        effectiveHashrate,
        networkInfo.networkHashrate
      );
      
      // プール手数料適用
      const poolFeeMultiplier = (100 - miningConfig.poolFee) / 100;
      
      // コイン獲得量計算
      const coinsPerDay = blocksPerDay * networkInfo.blockReward * poolFeeMultiplier;
      const coinsPerHour = coinsPerDay / 24;
      const coinsPerWeek = coinsPerDay * 7;
      const coinsPerMonth = coinsPerDay * 30;
      const coinsPerYear = coinsPerDay * 365;
      
      // 収益計算（USD）
      const revenuePerHour = coinsPerHour * priceData.price;
      const revenuePerDay = coinsPerDay * priceData.price;
      const revenuePerWeek = coinsPerWeek * priceData.price;
      const revenuePerMonth = coinsPerMonth * priceData.price;
      const revenuePerYear = coinsPerYear * priceData.price;
      
      // 電力コスト計算
      const powerCostPerHour = (miningConfig.hardware.powerConsumption / 1000) * miningConfig.electricityCost;
      const electricityCostPerHour = powerCostPerHour * (miningConfig.uptime / 100);
      const electricityCostPerDay = electricityCostPerHour * 24;
      const electricityCostPerWeek = electricityCostPerDay * 7;
      const electricityCostPerMonth = electricityCostPerDay * 30;
      const electricityCostPerYear = electricityCostPerDay * 365;
      
      // 利益計算
      const profitPerHour = revenuePerHour - electricityCostPerHour;
      const profitPerDay = revenuePerDay - electricityCostPerDay;
      const profitPerWeek = revenuePerWeek - electricityCostPerWeek;
      const profitPerMonth = revenuePerMonth - electricityCostPerMonth;
      const profitPerYear = revenuePerYear - electricityCostPerYear;
      
      // 追加メトリクス
      const profitMargin = profitPerDay > 0 ? (profitPerDay / revenuePerDay) * 100 : 0;
      const breakEvenDays = miningConfig.hardware.price && profitPerDay > 0 
        ? miningConfig.hardware.price / profitPerDay 
        : undefined;
      const roi = miningConfig.hardware.price && profitPerYear > 0
        ? (profitPerYear / miningConfig.hardware.price) * 100
        : undefined;

      const result: RevenueCalculation = {
        currency,
        timeframe: '1d',
        coinsPerHour,
        coinsPerDay,
        coinsPerWeek,
        coinsPerMonth,
        coinsPerYear,
        revenuePerHour,
        revenuePerDay,
        revenuePerWeek,
        revenuePerMonth,
        revenuePerYear,
        electricityCostPerHour,
        electricityCostPerDay,
        electricityCostPerWeek,
        electricityCostPerMonth,
        electricityCostPerYear,
        profitPerHour,
        profitPerDay,
        profitPerWeek,
        profitPerMonth,
        profitPerYear,
        breakEvenDays,
        roi,
        profitMargin
      };

      this.emit('calculationCompleted', { config: miningConfig, result });
      return result;

    } catch (error) {
      this.logger.error('Failed to calculate mining revenue', error);
      throw error;
    }
  }

  async compareHardware(currency: string, algorithm: string, electricityCost: number): Promise<Array<{ hardware: MiningHardware; calculation: RevenueCalculation }>> {
    const hardwareList = HardwareDatabase.getHardware(algorithm);
    const results: Array<{ hardware: MiningHardware; calculation: RevenueCalculation }> = [];

    for (const hardware of hardwareList) {
      try {
        const config: MiningConfig = {
          hardware,
          electricityCost,
          poolFee: 0, // 0% for this pool
          uptime: 95 // 95% uptime assumption
        };

        const calculation = await this.calculateRevenue(config, currency);
        results.push({ hardware, calculation });
      } catch (error) {
        this.logger.warn(`Failed to calculate for ${hardware.name}`, error);
      }
    }

    // 日利益順でソート
    results.sort((a, b) => b.calculation.profitPerDay - a.calculation.profitPerDay);
    return results;
  }

  async getOptimalHardware(currency: string, algorithm: string, budget: number, electricityCost: number): Promise<MiningHardware | null> {
    const comparisons = await this.compareHardware(currency, algorithm, electricityCost);
    
    // 予算内で最も効率的なハードウェアを探す
    const affordable = comparisons.filter(({ hardware }) => 
      hardware.price && hardware.price <= budget
    );

    if (affordable.length === 0) return null;

    // ROIが最も高いものを選択
    const bestROI = affordable.reduce((best, current) => {
      const bestROI = best.calculation.roi || 0;
      const currentROI = current.calculation.roi || 0;
      return currentROI > bestROI ? current : best;
    });

    return bestROI.hardware;
  }

  private async getNetworkInfo(currency: string): Promise<NetworkInfo> {
    // キャッシュから取得
    const cached = this.networkInfoCache.get(currency);
    if (cached) return cached;

    // デフォルト設定から取得
    const defaultInfo = this.config.defaultNetworkInfo[currency];
    if (defaultInfo) {
      this.networkInfoCache.set(currency, defaultInfo);
      return defaultInfo;
    }

    throw new Error(`Network information not available for ${currency}`);
  }

  updateNetworkInfo(currency: string, info: Partial<NetworkInfo>): void {
    const current = this.networkInfoCache.get(currency) || this.config.defaultNetworkInfo[currency];
    if (current) {
      const updated = { ...current, ...info };
      this.networkInfoCache.set(currency, updated);
      this.emit('networkInfoUpdated', { currency, info: updated });
    }
  }

  getHardwareByAlgorithm(algorithm: string): MiningHardware[] {
    return HardwareDatabase.getHardware(algorithm);
  }

  findHardware(name: string, algorithm?: string): MiningHardware | null {
    return HardwareDatabase.findHardware(name, algorithm);
  }

  getSupportedAlgorithms(): string[] {
    return this.config.supportedAlgorithms;
  }

  getSupportedCurrencies(): string[] {
    return Object.keys(this.config.defaultNetworkInfo);
  }

  private startUpdateTimer(): void {
    if (this.config.updateInterval > 0) {
      this.updateTimer = setInterval(() => {
        this.emit('updateTick');
      }, this.config.updateInterval);
    }
  }

  async calculateBreakEvenPrice(miningConfig: MiningConfig, currency: string): Promise<number> {
    const networkInfo = await this.getNetworkInfo(currency);
    const calculator = CalculatorFactory.create(networkInfo.algorithm);
    
    const effectiveHashrate = miningConfig.hardware.hashrate * (miningConfig.uptime / 100);
    const blocksPerDay = calculator.estimateBlocksPerDay(effectiveHashrate, networkInfo.networkHashrate);
    const poolFeeMultiplier = (100 - miningConfig.poolFee) / 100;
    const coinsPerDay = blocksPerDay * networkInfo.blockReward * poolFeeMultiplier;
    
    const electricityCostPerDay = ((miningConfig.hardware.powerConsumption / 1000) * 
                                  miningConfig.electricityCost * 24 * 
                                  (miningConfig.uptime / 100));
    
    return coinsPerDay > 0 ? electricityCostPerDay / coinsPerDay : 0;
  }

  getStats() {
    return {
      supportedAlgorithms: this.config.supportedAlgorithms,
      supportedCurrencies: this.getSupportedCurrencies(),
      cachedNetworkInfo: Array.from(this.networkInfoCache.keys()),
      totalHardware: HardwareDatabase.getAllHardware().length,
      updateInterval: this.config.updateInterval
    };
  }

  stop(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = undefined;
    }
    this.logger.info('Mining calculator stopped');
  }
}

export {
  LightMiningCalculator,
  MiningHardware,
  MiningConfig,
  RevenueCalculation,
  NetworkInfo,
  CalculatorConfig,
  HardwareDatabase,
  CalculatorFactory
};