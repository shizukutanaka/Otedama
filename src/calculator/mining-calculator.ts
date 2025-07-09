/**
 * 高精度マイニングカリキュレーター（手数料0%対応）
 * 設計思想: John Carmack (高精度), Robert C. Martin (クリーン), Rob Pike (シンプル)
 * 
 * 特徴:
 * - 手数料0%での正確な収益計算
 * - リアルタイム価格統合
 * - 複数通貨対応
 * - 電力コスト計算
 * - ROI分析
 * - 難易度予測
 * - ハードウェア効率最適化
 */

import { EventEmitter } from 'events';
import axios from 'axios';

// === 型定義 ===
export interface MiningParams {
  hashrate: number; // H/s
  power: number; // W
  electricityCost: number; // USD per kWh
  poolFee: number; // % (常に0)
  hardwareCost?: number; // USD
  currency: string;
}

export interface NetworkParams {
  difficulty: number;
  blockReward: number;
  blockTime: number; // seconds
  networkHashrate: number; // H/s
}

export interface PriceData {
  currency: string;
  priceUSD: number;
  change24h: number;
  marketCap: number;
  volume24h: number;
  lastUpdated: number;
}

export interface CalculationResult {
  currency: string;
  timeframe: '1h' | '24h' | '7d' | '30d' | '1y';
  
  // 基本収益
  coinsEarned: number;
  revenueUSD: number;
  
  // コスト
  electricityCostUSD: number;
  poolFeeUSD: number; // 常に0
  
  // 利益
  profitUSD: number;
  profitMargin: number; // %
  
  // ROI
  roi: number; // %
  breakEvenDays: number;
  
  // 効率指標
  profitPerHashrate: number; // USD per H/s
  profitPerWatt: number; // USD per W
  
  // 予測
  difficulty: number;
  estimatedBlocksFound: number;
  
  timestamp: number;
}

export interface OptimizationSuggestion {
  type: 'hashrate' | 'power' | 'timing' | 'currency';
  description: string;
  impact: number; // % improvement
  implementation: string;
}

export interface HardwareProfile {
  id: string;
  name: string;
  hashrate: number;
  power: number;
  cost: number;
  algorithm: string;
  efficiency: number; // H/W
}

// === 価格フィードプロバイダー ===
export class PriceFeedProvider extends EventEmitter {
  private prices = new Map<string, PriceData>();
  private updateInterval: NodeJS.Timeout | null = null;
  private apiKeys: Map<string, string> = new Map();
  
  constructor() {
    super();
    this.setupAPIKeys();
  }

  private setupAPIKeys(): void {
    // 各価格APIのキー設定
    this.apiKeys.set('coingecko', process.env.COINGECKO_API_KEY || '');
    this.apiKeys.set('coinmarketcap', process.env.COINMARKETCAP_API_KEY || '');
    this.apiKeys.set('binance', process.env.BINANCE_API_KEY || '');
  }

  async startPriceFeed(currencies: string[], intervalMs = 60000): Promise<void> {
    console.log(`📈 Starting price feed for: ${currencies.join(', ')}`);
    
    // 初回取得
    for (const currency of currencies) {
      await this.updatePrice(currency);
    }

    // 定期更新
    this.updateInterval = setInterval(async () => {
      for (const currency of currencies) {
        try {
          await this.updatePrice(currency);
        } catch (error) {
          console.error(`Failed to update price for ${currency}:`, error);
        }
      }
    }, intervalMs);
  }

  async updatePrice(currency: string): Promise<PriceData | null> {
    try {
      // 複数のソースから価格を取得して平均化
      const sources = [
        () => this.fetchFromCoinGecko(currency),
        () => this.fetchFromCoinMarketCap(currency),
        () => this.fetchFromBinance(currency)
      ];

      const results: PriceData[] = [];
      
      for (const source of sources) {
        try {
          const price = await source();
          if (price) results.push(price);
        } catch (error) {
          // ソースエラーは無視して続行
        }
      }

      if (results.length === 0) {
        throw new Error(`No price data available for ${currency}`);
      }

      // 価格の平均値を計算
      const avgPrice: PriceData = {
        currency,
        priceUSD: results.reduce((sum, p) => sum + p.priceUSD, 0) / results.length,
        change24h: results.reduce((sum, p) => sum + p.change24h, 0) / results.length,
        marketCap: Math.max(...results.map(p => p.marketCap)),
        volume24h: results.reduce((sum, p) => sum + p.volume24h, 0) / results.length,
        lastUpdated: Date.now()
      };

      this.prices.set(currency, avgPrice);
      this.emit('priceUpdated', avgPrice);
      
      return avgPrice;
      
    } catch (error) {
      console.error(`Failed to update price for ${currency}:`, error);
      return null;
    }
  }

  private async fetchFromCoinGecko(currency: string): Promise<PriceData | null> {
    const id = this.getCoinGeckoId(currency);
    if (!id) return null;

    const response = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`,
      { timeout: 5000 }
    );

    const data = response.data[id];
    if (!data) return null;

    return {
      currency,
      priceUSD: data.usd,
      change24h: data.usd_24h_change || 0,
      marketCap: data.usd_market_cap || 0,
      volume24h: data.usd_24h_vol || 0,
      lastUpdated: Date.now()
    };
  }

  private async fetchFromCoinMarketCap(currency: string): Promise<PriceData | null> {
    const apiKey = this.apiKeys.get('coinmarketcap');
    if (!apiKey) return null;

    const response = await axios.get(
      `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${currency.toUpperCase()}`,
      {
        headers: { 'X-CMC_PRO_API_KEY': apiKey },
        timeout: 5000
      }
    );

    const data = response.data.data[currency.toUpperCase()];
    if (!data) return null;

    const quote = data.quote.USD;
    
    return {
      currency,
      priceUSD: quote.price,
      change24h: quote.percent_change_24h || 0,
      marketCap: quote.market_cap || 0,
      volume24h: quote.volume_24h || 0,
      lastUpdated: Date.now()
    };
  }

  private async fetchFromBinance(currency: string): Promise<PriceData | null> {
    const symbol = `${currency.toUpperCase()}USDT`;
    
    try {
      const [priceResponse, statsResponse] = await Promise.all([
        axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, { timeout: 5000 }),
        axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, { timeout: 5000 })
      ]);

      return {
        currency,
        priceUSD: parseFloat(priceResponse.data.price),
        change24h: parseFloat(statsResponse.data.priceChangePercent),
        marketCap: 0, // Binanceでは提供されない
        volume24h: parseFloat(statsResponse.data.volume) * parseFloat(priceResponse.data.price),
        lastUpdated: Date.now()
      };
    } catch (error) {
      return null;
    }
  }

  private getCoinGeckoId(currency: string): string | null {
    const mapping: Record<string, string> = {
      'BTC': 'bitcoin',
      'ETH': 'ethereum',
      'LTC': 'litecoin',
      'DOGE': 'dogecoin',
      'XMR': 'monero',
      'ZEC': 'zcash',
      'DASH': 'dash',
      'ETC': 'ethereum-classic'
    };
    
    return mapping[currency.toUpperCase()] || null;
  }

  getPrice(currency: string): PriceData | null {
    return this.prices.get(currency) || null;
  }

  getAllPrices(): Map<string, PriceData> {
    return new Map(this.prices);
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
}

// === メインマイニングカリキュレーター ===
export class MiningCalculator extends EventEmitter {
  private priceFeed: PriceFeedProvider;
  private hardwareProfiles = new Map<string, HardwareProfile>();
  private networkParams = new Map<string, NetworkParams>();
  
  constructor() {
    super();
    this.priceFeed = new PriceFeedProvider();
    this.setupDefaultHardware();
    this.setupDefaultNetworks();
    
    // 価格更新イベントの転送
    this.priceFeed.on('priceUpdated', (price) => {
      this.emit('priceUpdated', price);
    });
  }

  async initialize(currencies: string[]): Promise<void> {
    await this.priceFeed.startPriceFeed(currencies);
    console.log('💰 Mining calculator initialized');
  }

  // === メイン計算関数 ===
  async calculate(
    params: MiningParams,
    network: NetworkParams,
    timeframes: Array<'1h' | '24h' | '7d' | '30d' | '1y'> = ['24h']
  ): Promise<CalculationResult[]> {
    const price = this.priceFeed.getPrice(params.currency);
    if (!price) {
      throw new Error(`Price data not available for ${params.currency}`);
    }

    const results: CalculationResult[] = [];

    for (const timeframe of timeframes) {
      const result = await this.calculateForTimeframe(params, network, price, timeframe);
      results.push(result);
    }

    return results;
  }

  private async calculateForTimeframe(
    params: MiningParams,
    network: NetworkParams,
    price: PriceData,
    timeframe: '1h' | '24h' | '7d' | '30d' | '1y'
  ): Promise<CalculationResult> {
    const hours = this.getHoursForTimeframe(timeframe);
    const seconds = hours * 3600;

    // 基本計算
    const hashPortion = params.hashrate / network.networkHashrate;
    const blocksPerSecond = 1 / network.blockTime;
    const blocksFound = blocksPerSecond * seconds * hashPortion;
    const coinsEarned = blocksFound * network.blockReward;
    
    // 手数料0%なので全額受け取り
    const coinsAfterFee = coinsEarned; // 手数料0%
    const revenueUSD = coinsAfterFee * price.priceUSD;
    
    // コスト計算
    const powerKW = params.power / 1000;
    const electricityCostUSD = powerKW * hours * params.electricityCost;
    const poolFeeUSD = 0; // 手数料0%
    
    // 利益計算
    const profitUSD = revenueUSD - electricityCostUSD - poolFeeUSD;
    const profitMargin = revenueUSD > 0 ? (profitUSD / revenueUSD) * 100 : 0;
    
    // ROI計算
    const dailyProfit = timeframe === '24h' ? profitUSD : (profitUSD / hours) * 24;
    const roi = params.hardwareCost ? (dailyProfit * 365 / params.hardwareCost) * 100 : 0;
    const breakEvenDays = params.hardwareCost && dailyProfit > 0 ? params.hardwareCost / dailyProfit : Infinity;
    
    // 効率指標
    const profitPerHashrate = params.hashrate > 0 ? profitUSD / params.hashrate : 0;
    const profitPerWatt = params.power > 0 ? profitUSD / params.power : 0;

    return {
      currency: params.currency,
      timeframe,
      coinsEarned: coinsAfterFee,
      revenueUSD,
      electricityCostUSD,
      poolFeeUSD, // 常に0
      profitUSD,
      profitMargin,
      roi,
      breakEvenDays: isFinite(breakEvenDays) ? breakEvenDays : -1,
      profitPerHashrate,
      profitPerWatt,
      difficulty: network.difficulty,
      estimatedBlocksFound: blocksFound,
      timestamp: Date.now()
    };
  }

  // === 最適化提案 ===
  async getOptimizationSuggestions(
    params: MiningParams,
    network: NetworkParams
  ): Promise<OptimizationSuggestion[]> {
    const suggestions: OptimizationSuggestion[] = [];
    const currentResult = (await this.calculate(params, network, ['24h']))[0];
    
    // ハードウェア最適化
    const hardwareOptimization = this.analyzeHardwareOptimization(params, currentResult);
    if (hardwareOptimization) suggestions.push(hardwareOptimization);
    
    // 電力最適化
    const powerOptimization = this.analyzePowerOptimization(params, currentResult);
    if (powerOptimization) suggestions.push(powerOptimization);
    
    // タイミング最適化
    const timingOptimization = await this.analyzeTimingOptimization(params, network);
    if (timingOptimization) suggestions.push(timingOptimization);
    
    // 通貨最適化
    const currencyOptimization = await this.analyzeCurrencyOptimization(params, network);
    if (currencyOptimization) suggestions.push(currencyOptimization);

    return suggestions.sort((a, b) => b.impact - a.impact);
  }

  private analyzeHardwareOptimization(
    params: MiningParams,
    currentResult: CalculationResult
  ): OptimizationSuggestion | null {
    const efficiency = params.hashrate / params.power; // H/W
    const avgEfficiency = 100; // 平均的な効率の例
    
    if (efficiency < avgEfficiency * 0.8) {
      const improvementPotential = ((avgEfficiency - efficiency) / efficiency) * 100;
      
      return {
        type: 'hashrate',
        description: `ハードウェア効率が平均を下回っています。より効率的なマイニング機器への更新を検討してください。`,
        impact: Math.min(improvementPotential, 50),
        implementation: `効率性の高いASICまたはGPUへの更新。推奨効率: ${avgEfficiency.toFixed(2)} H/W以上`
      };
    }
    
    return null;
  }

  private analyzePowerOptimization(
    params: MiningParams,
    currentResult: CalculationResult
  ): OptimizationSuggestion | null {
    const powerCostRatio = currentResult.electricityCostUSD / currentResult.revenueUSD;
    
    if (powerCostRatio > 0.6) { // 電力コストが収益の60%を超える場合
      return {
        type: 'power',
        description: `電力コストが収益の${(powerCostRatio * 100).toFixed(1)}%を占めています。電力効率の改善が必要です。`,
        impact: Math.min((powerCostRatio - 0.3) * 100, 40),
        implementation: '電力効率の高い機器への更新、アンダーボルト設定、電力契約の見直し'
      };
    }
    
    return null;
  }

  private async analyzeTimingOptimization(
    params: MiningParams,
    network: NetworkParams
  ): Promise<OptimizationSuggestion | null> {
    // 難易度トレンド分析（簡略化）
    const difficultyTrend = 0.05; // 5%増加と仮定
    
    if (difficultyTrend > 0.03) { // 3%以上の増加傾向
      return {
        type: 'timing',
        description: `ネットワーク難易度が${(difficultyTrend * 100).toFixed(1)}%の増加傾向にあります。早期のマイニング開始を推奨します。`,
        impact: difficultyTrend * 100,
        implementation: '可能な限り早期にマイニングを開始し、難易度上昇前の高収益期間を活用'
      };
    }
    
    return null;
  }

  private async analyzeCurrencyOptimization(
    params: MiningParams,
    network: NetworkParams
  ): Promise<OptimizationSuggestion | null> {
    // 他の通貨との収益性比較（簡略化）
    const alternativeCurrencies = ['BTC', 'ETH', 'LTC'];
    let bestAlternative = '';
    let bestImprovement = 0;
    
    for (const currency of alternativeCurrencies) {
      if (currency === params.currency) continue;
      
      const altPrice = this.priceFeed.getPrice(currency);
      const altNetwork = this.networkParams.get(currency);
      
      if (altPrice && altNetwork) {
        try {
          const altParams = { ...params, currency };
          const altResult = (await this.calculate(altParams, altNetwork, ['24h']))[0];
          const improvement = ((altResult.profitUSD - (await this.calculate(params, network, ['24h']))[0].profitUSD) / (await this.calculate(params, network, ['24h']))[0].profitUSD) * 100;
          
          if (improvement > bestImprovement && improvement > 10) {
            bestImprovement = improvement;
            bestAlternative = currency;
          }
        } catch (error) {
          // 計算エラーは無視
        }
      }
    }
    
    if (bestAlternative && bestImprovement > 10) {
      return {
        type: 'currency',
        description: `${bestAlternative}のマイニングにより${bestImprovement.toFixed(1)}%の収益改善が期待できます。`,
        impact: bestImprovement,
        implementation: `マイニングプールまたはマイニングソフトウェアで${bestAlternative}への切り替えを検討`
      };
    }
    
    return null;
  }

  // === 比較分析 ===
  async compareScenarios(scenarios: Array<{name: string; params: MiningParams; network: NetworkParams}>): Promise<any> {
    const results = [];
    
    for (const scenario of scenarios) {
      try {
        const result = (await this.calculate(scenario.params, scenario.network, ['24h']))[0];
        results.push({
          name: scenario.name,
          ...result
        });
      } catch (error) {
        console.error(`Failed to calculate scenario ${scenario.name}:`, error);
      }
    }
    
    return results.sort((a, b) => b.profitUSD - a.profitUSD);
  }

  // === ハードウェアプロファイル管理 ===
  private setupDefaultHardware(): void {
    const profiles: HardwareProfile[] = [
      {
        id: 'antminer-s19',
        name: 'Antminer S19 Pro',
        hashrate: 110e12, // 110 TH/s
        power: 3250, // W
        cost: 2500, // USD
        algorithm: 'SHA256',
        efficiency: 110e12 / 3250
      },
      {
        id: 'rtx-4090',
        name: 'RTX 4090',
        hashrate: 120e6, // 120 MH/s for Ethereum
        power: 450, // W
        cost: 1600, // USD
        algorithm: 'Ethash',
        efficiency: 120e6 / 450
      },
      {
        id: 'antminer-l7',
        name: 'Antminer L7',
        hashrate: 9.5e9, // 9.5 GH/s
        power: 3425, // W
        cost: 6000, // USD
        algorithm: 'Scrypt',
        efficiency: 9.5e9 / 3425
      }
    ];

    profiles.forEach(profile => {
      this.hardwareProfiles.set(profile.id, profile);
    });
  }

  private setupDefaultNetworks(): void {
    this.networkParams.set('BTC', {
      difficulty: 25e12,
      blockReward: 6.25,
      blockTime: 600, // 10 minutes
      networkHashrate: 180e18 // 180 EH/s
    });

    this.networkParams.set('ETH', {
      difficulty: 12e15,
      blockReward: 2.0,
      blockTime: 13, // 13 seconds
      networkHashrate: 900e12 // 900 TH/s
    });

    this.networkParams.set('LTC', {
      difficulty: 15e6,
      blockReward: 12.5,
      blockTime: 150, // 2.5 minutes
      networkHashrate: 400e12 // 400 TH/s
    });
  }

  // === ユーティリティ ===
  private getHoursForTimeframe(timeframe: string): number {
    switch (timeframe) {
      case '1h': return 1;
      case '24h': return 24;
      case '7d': return 24 * 7;
      case '30d': return 24 * 30;
      case '1y': return 24 * 365;
      default: return 24;
    }
  }

  // === ゲッター ===
  getHardwareProfile(id: string): HardwareProfile | undefined {
    return this.hardwareProfiles.get(id);
  }

  getAllHardwareProfiles(): HardwareProfile[] {
    return Array.from(this.hardwareProfiles.values());
  }

  getNetworkParams(currency: string): NetworkParams | undefined {
    return this.networkParams.get(currency);
  }

  getCurrentPrice(currency: string): PriceData | null {
    return this.priceFeed.getPrice(currency);
  }

  // === 停止処理 ===
  stop(): void {
    this.priceFeed.stop();
    console.log('🛑 Mining calculator stopped');
  }
}

// === ヘルパークラス ===
export class MiningCalculatorHelper {
  static createBasicParams(
    hashrate: number,
    power: number,
    electricityCost: number,
    currency: string
  ): MiningParams {
    return {
      hashrate,
      power,
      electricityCost,
      poolFee: 0, // 常に0%
      currency
    };
  }

  static createNetworkParams(
    difficulty: number,
    blockReward: number,
    blockTime: number,
    networkHashrate: number
  ): NetworkParams {
    return {
      difficulty,
      blockReward,
      blockTime,
      networkHashrate
    };
  }

  static formatCurrency(amount: number, currency: string): string {
    if (currency === 'USD') {
      return `$${amount.toFixed(2)}`;
    }
    return `${amount.toFixed(8)} ${currency}`;
  }

  static formatHashrate(hashrate: number): string {
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
    let value = hashrate;
    let unitIndex = 0;
    
    while (value >= 1000 && unitIndex < units.length - 1) {
      value /= 1000;
      unitIndex++;
    }
    
    return `${value.toFixed(2)} ${units[unitIndex]}`;
  }

  static calculateBreakEven(hardwareCost: number, dailyProfit: number): number {
    return dailyProfit > 0 ? hardwareCost / dailyProfit : -1;
  }

  static isRentable(result: CalculationResult, minMargin = 20): boolean {
    return result.profitMargin >= minMargin && result.profitUSD > 0;
  }
}

export default MiningCalculator;