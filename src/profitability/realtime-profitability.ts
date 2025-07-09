/**
 * リアルタイム収益計算・自動プロフィットスイッチングシステム
 * 設計思想: John Carmack (高性能), Robert C. Martin (クリーン), Rob Pike (シンプル)
 * 
 * 機能:
 * - リアルタイム市場データ取得
 * - 自動プロフィット切り替え (3-5分間隔)
 * - 電力効率最適化
 * - 収益性予測とアラート
 */

import { EventEmitter } from 'events';
import axios from 'axios';

// === 型定義 ===
export interface CoinData {
  symbol: string;
  name: string;
  price: number;
  difficulty: number;
  blockReward: number;
  blockTime: number;
  networkHashrate: number;
  algorithm: string;
  lastUpdated: number;
  source: string;
  confidence: number; // 0-100
}

export interface ProfitabilityData {
  coin: string;
  algorithm: string;
  grossRevenue: number; // $/day
  electricityCost: number; // $/day
  netProfit: number; // $/day
  profitMargin: number; // %
  paybackPeriod: number; // days
  hashrate: number;
  power: number; // watts
  efficiency: number; // hash/watt
  roi: number; // % annual
  lastCalculated: number;
}

export interface HardwareProfile {
  type: 'CPU' | 'GPU' | 'ASIC';
  name: string;
  algorithms: {
    [algorithm: string]: {
      hashrate: number;
      power: number;
      efficiency: number;
    };
  };
  electricityCost: number; // $/kWh
}

export interface SwitchingRule {
  id: string;
  name: string;
  enabled: boolean;
  minProfitIncrease: number; // % minimum profit increase to switch
  minDuration: number; // seconds to wait before switching
  maxSwitchesPerHour: number;
  algorithm?: string; // restrict to specific algorithm
  excludeCoins?: string[];
  priority: number;
}

export interface MarketDataSource {
  name: string;
  url: string;
  enabled: boolean;
  weight: number; // for weighted average
  rateLimit: number; // requests per minute
  lastRequest: number;
  endpoints: {
    [coin: string]: string;
  };
}

// === 市場データ取得 ===
export class MarketDataProvider extends EventEmitter {
  private sources: MarketDataSource[] = [];
  private cache = new Map<string, CoinData>();
  private requestQueue: Array<{ source: MarketDataSource; coin: string; resolve: Function; reject: Function }> = [];
  private isProcessing = false;
  
  constructor() {
    super();
    this.initializeDataSources();
    this.startUpdateCycle();
  }

  private initializeDataSources(): void {
    // 無料APIソース設定
    this.sources = [
      {
        name: 'CoinGecko',
        url: 'https://api.coingecko.com/api/v3',
        enabled: true,
        weight: 0.4,
        rateLimit: 50, // 50 requests per minute
        lastRequest: 0,
        endpoints: {
          'BTC': '/simple/price?ids=bitcoin&vs_currencies=usd',
          'XMR': '/simple/price?ids=monero&vs_currencies=usd',
          'RVN': '/simple/price?ids=ravencoin&vs_currencies=usd',
          'ETC': '/simple/price?ids=ethereum-classic&vs_currencies=usd',
          'ERG': '/simple/price?ids=ergo&vs_currencies=usd'
        }
      },
      {
        name: 'CryptoCompare',
        url: 'https://min-api.cryptocompare.com/data',
        enabled: true,
        weight: 0.3,
        rateLimit: 100,
        lastRequest: 0,
        endpoints: {
          'BTC': '/price?fsym=BTC&tsyms=USD',
          'XMR': '/price?fsym=XMR&tsyms=USD',
          'RVN': '/price?fsym=RVN&tsyms=USD',
          'ETC': '/price?fsym=ETC&tsyms=USD',
          'ERG': '/price?fsym=ERG&tsyms=USD'
        }
      },
      {
        name: 'WhatToMine',
        url: 'https://whattomine.com/coins',
        enabled: true,
        weight: 0.3,
        rateLimit: 30,
        lastRequest: 0,
        endpoints: {
          'BTC': '.json?sha256=true',
          'XMR': '.json?randomx=true',
          'RVN': '.json?kawpow=true',
          'ETC': '.json?ethash=true'
        }
      }
    ];
  }

  async getCoinData(symbol: string): Promise<CoinData | null> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.lastUpdated < 60000) { // 1分キャッシュ
      return cached;
    }

    try {
      const results = await Promise.allSettled(
        this.sources
          .filter(s => s.enabled && s.endpoints[symbol])
          .map(source => this.fetchFromSource(source, symbol))
      );

      const validResults = results
        .filter(r => r.status === 'fulfilled')
        .map(r => (r as PromiseFulfilledResult<CoinData>).value);

      if (validResults.length === 0) {
        return null;
      }

      // 重み付き平均で統合
      const aggregatedData = this.aggregateData(validResults);
      this.cache.set(symbol, aggregatedData);
      
      this.emit('dataUpdated', { symbol, data: aggregatedData });
      return aggregatedData;

    } catch (error) {
      console.error(`Failed to fetch data for ${symbol}:`, error);
      return cached || null;
    }
  }

  private async fetchFromSource(source: MarketDataSource, coin: string): Promise<CoinData> {
    // レート制限チェック
    const now = Date.now();
    const timeSinceLastRequest = now - source.lastRequest;
    const minInterval = 60000 / source.rateLimit; // milliseconds between requests

    if (timeSinceLastRequest < minInterval) {
      await new Promise(resolve => setTimeout(resolve, minInterval - timeSinceLastRequest));
    }

    source.lastRequest = Date.now();

    const endpoint = source.endpoints[coin];
    const url = `${source.url}${endpoint}`;

    try {
      const response = await axios.get(url, { timeout: 10000 });
      return this.parseResponse(source.name, coin, response.data);
    } catch (error) {
      throw new Error(`${source.name} API error: ${error.message}`);
    }
  }

  private parseResponse(sourceName: string, coin: string, data: any): CoinData {
    const coinConfig = this.getCoinConfig(coin);
    
    let price = 0;
    let difficulty = coinConfig.difficulty;
    let networkHashrate = coinConfig.networkHashrate;

    // ソース別パース処理
    switch (sourceName) {
      case 'CoinGecko':
        price = data[coinConfig.geckoId]?.usd || 0;
        break;
      case 'CryptoCompare':
        price = data.USD || 0;
        break;
      case 'WhatToMine':
        price = data.exchange_rate || 0;
        difficulty = data.difficulty || difficulty;
        networkHashrate = data.nethash || networkHashrate;
        break;
    }

    return {
      symbol: coin,
      name: coinConfig.name,
      price,
      difficulty,
      blockReward: coinConfig.blockReward,
      blockTime: coinConfig.blockTime,
      networkHashrate,
      algorithm: coinConfig.algorithm,
      lastUpdated: Date.now(),
      source: sourceName,
      confidence: price > 0 ? 90 : 0
    };
  }

  private getCoinConfig(symbol: string) {
    const configs = {
      'BTC': { 
        name: 'Bitcoin', 
        geckoId: 'bitcoin', 
        algorithm: 'sha256d', 
        blockReward: 6.25, 
        blockTime: 600, 
        difficulty: 50000000000000,
        networkHashrate: 400000000000000000000
      },
      'XMR': { 
        name: 'Monero', 
        geckoId: 'monero', 
        algorithm: 'randomx', 
        blockReward: 0.6, 
        blockTime: 120,
        difficulty: 300000000000,
        networkHashrate: 2500000000
      },
      'RVN': { 
        name: 'Ravencoin', 
        geckoId: 'ravencoin', 
        algorithm: 'kawpow', 
        blockReward: 2500, 
        blockTime: 60,
        difficulty: 120000000000,
        networkHashrate: 10000000000000
      },
      'ETC': { 
        name: 'Ethereum Classic', 
        geckoId: 'ethereum-classic', 
        algorithm: 'ethash', 
        blockReward: 2.56, 
        blockTime: 15,
        difficulty: 2000000000000000,
        networkHashrate: 150000000000000000
      },
      'ERG': { 
        name: 'Ergo', 
        geckoId: 'ergo', 
        algorithm: 'autolykos', 
        blockReward: 15, 
        blockTime: 120,
        difficulty: 1200000000000,
        networkHashrate: 15000000000000
      }
    };
    
    return configs[symbol] || configs['BTC'];
  }

  private aggregateData(results: CoinData[]): CoinData {
    if (results.length === 1) return results[0];

    // 重み付き平均
    let totalWeight = 0;
    let weightedPrice = 0;
    let weightedDifficulty = 0;
    let weightedHashrate = 0;

    results.forEach(result => {
      const source = this.sources.find(s => s.name === result.source);
      const weight = source?.weight || 0.1;
      
      totalWeight += weight;
      weightedPrice += result.price * weight;
      weightedDifficulty += result.difficulty * weight;
      weightedHashrate += result.networkHashrate * weight;
    });

    const base = results[0];
    return {
      ...base,
      price: weightedPrice / totalWeight,
      difficulty: weightedDifficulty / totalWeight,
      networkHashrate: weightedHashrate / totalWeight,
      source: 'aggregated',
      confidence: Math.min(95, results.reduce((sum, r) => sum + r.confidence, 0) / results.length),
      lastUpdated: Date.now()
    };
  }

  private startUpdateCycle(): void {
    // 主要コインを定期更新 (5分間隔)
    setInterval(async () => {
      const coins = ['BTC', 'XMR', 'RVN', 'ETC', 'ERG'];
      for (const coin of coins) {
        try {
          await this.getCoinData(coin);
        } catch (error) {
          console.error(`Failed to update ${coin}:`, error);
        }
        // レート制限対策で1秒待機
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }, 300000); // 5分
  }

  getAvailableCoins(): string[] {
    return ['BTC', 'XMR', 'RVN', 'ETC', 'ERG'];
  }

  getCachedData(): Map<string, CoinData> {
    return new Map(this.cache);
  }
}

// === 収益性計算エンジン ===
export class ProfitabilityCalculator {
  private marketData: MarketDataProvider;
  
  constructor(marketData: MarketDataProvider) {
    this.marketData = marketData;
  }

  async calculateProfitability(
    hardware: HardwareProfile,
    coin: string
  ): Promise<ProfitabilityData | null> {
    const coinData = await this.marketData.getCoinData(coin);
    if (!coinData) return null;

    const algorithmData = hardware.algorithms[coinData.algorithm];
    if (!algorithmData) return null;

    // 基本収益計算
    const dailyReward = this.calculateDailyReward(
      algorithmData.hashrate,
      coinData.networkHashrate,
      coinData.blockReward,
      coinData.blockTime
    );

    const grossRevenue = dailyReward * coinData.price;
    const electricityCost = (algorithmData.power / 1000) * 24 * hardware.electricityCost;
    const netProfit = grossRevenue - electricityCost;
    const profitMargin = grossRevenue > 0 ? (netProfit / grossRevenue) * 100 : -100;

    // ROI計算 (年率)
    const annualProfit = netProfit * 365;
    const hardwareCost = this.estimateHardwareCost(hardware);
    const roi = hardwareCost > 0 ? (annualProfit / hardwareCost) * 100 : 0;

    // ペイバック期間計算
    const paybackPeriod = netProfit > 0 ? hardwareCost / netProfit : Infinity;

    return {
      coin,
      algorithm: coinData.algorithm,
      grossRevenue,
      electricityCost,
      netProfit,
      profitMargin,
      paybackPeriod,
      hashrate: algorithmData.hashrate,
      power: algorithmData.power,
      efficiency: algorithmData.efficiency,
      roi,
      lastCalculated: Date.now()
    };
  }

  private calculateDailyReward(
    minerHashrate: number,
    networkHashrate: number,
    blockReward: number,
    blockTime: number
  ): number {
    const shareOfNetwork = minerHashrate / networkHashrate;
    const blocksPerDay = 86400 / blockTime;
    return shareOfNetwork * blocksPerDay * blockReward;
  }

  private estimateHardwareCost(hardware: HardwareProfile): number {
    // 簡略化されたハードウェアコスト推定
    const costs = {
      'CPU': 500,   // $500 average CPU
      'GPU': 1500,  // $1500 average GPU
      'ASIC': 3000  // $3000 average ASIC
    };
    
    return costs[hardware.type] || 1000;
  }

  async getBestProfitableCoins(
    hardware: HardwareProfile,
    count: number = 5
  ): Promise<ProfitabilityData[]> {
    const coins = this.marketData.getAvailableCoins();
    const profitabilities: ProfitabilityData[] = [];

    for (const coin of coins) {
      try {
        const profitability = await this.calculateProfitability(hardware, coin);
        if (profitability && profitability.netProfit > 0) {
          profitabilities.push(profitability);
        }
      } catch (error) {
        console.error(`Failed to calculate profitability for ${coin}:`, error);
      }
    }

    return profitabilities
      .sort((a, b) => b.netProfit - a.netProfit)
      .slice(0, count);
  }
}

// === 自動プロフィットスイッチング ===
export class AutoProfitSwitcher extends EventEmitter {
  private calculator: ProfitabilityCalculator;
  private hardware: HardwareProfile;
  private rules: SwitchingRule[] = [];
  private currentCoin: string = '';
  private lastSwitch: number = 0;
  private switchHistory: Array<{ coin: string; timestamp: number; profit: number }> = [];
  private isEnabled: boolean = false;
  private checkInterval?: NodeJS.Timeout;

  constructor(calculator: ProfitabilityCalculator, hardware: HardwareProfile) {
    super();
    this.calculator = calculator;
    this.hardware = hardware;
    this.initializeDefaultRules();
  }

  private initializeDefaultRules(): void {
    this.rules = [
      {
        id: 'conservative',
        name: '保守的スイッチング',
        enabled: true,
        minProfitIncrease: 10, // 10%以上の利益増加で切り替え
        minDuration: 300,      // 5分間隔
        maxSwitchesPerHour: 6,
        priority: 1
      },
      {
        id: 'aggressive',
        name: '積極的スイッチング',
        enabled: false,
        minProfitIncrease: 5,  // 5%以上の利益増加で切り替え
        minDuration: 180,      // 3分間隔
        maxSwitchesPerHour: 12,
        priority: 2
      },
      {
        id: 'stable-only',
        name: '安定通貨のみ',
        enabled: false,
        minProfitIncrease: 15,
        minDuration: 600,      // 10分間隔
        maxSwitchesPerHour: 3,
        excludeCoins: ['ERG'], // 新興通貨除外
        priority: 3
      }
    ];
  }

  start(): void {
    if (this.isEnabled) return;
    
    this.isEnabled = true;
    console.log('🔄 Auto-profit switching started');
    
    // 定期チェック開始
    this.checkInterval = setInterval(() => {
      this.checkAndSwitch();
    }, 60000); // 1分間隔でチェック
    
    // 初回チェック
    this.checkAndSwitch();
  }

  stop(): void {
    if (!this.isEnabled) return;
    
    this.isEnabled = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
    
    console.log('⏹️ Auto-profit switching stopped');
  }

  private async checkAndSwitch(): Promise<void> {
    if (!this.isEnabled) return;

    try {
      const enabledRule = this.rules.find(r => r.enabled);
      if (!enabledRule) return;

      // 時間制限チェック
      const now = Date.now();
      const timeSinceLastSwitch = now - this.lastSwitch;
      if (timeSinceLastSwitch < enabledRule.minDuration * 1000) {
        return;
      }

      // 時間あたりスイッチ回数制限
      const recentSwitches = this.switchHistory.filter(
        s => now - s.timestamp < 3600000 // 1時間以内
      );
      if (recentSwitches.length >= enabledRule.maxSwitchesPerHour) {
        return;
      }

      // 最適な通貨を計算
      const bestCoins = await this.calculator.getBestProfitableCoins(this.hardware, 3);
      if (bestCoins.length === 0) return;

      const bestCoin = bestCoins[0];
      
      // 現在の通貨の収益性を取得
      let currentProfit = 0;
      if (this.currentCoin) {
        const currentProfitability = await this.calculator.calculateProfitability(
          this.hardware, 
          this.currentCoin
        );
        currentProfit = currentProfitability?.netProfit || 0;
      }

      // 切り替え判定
      const profitIncrease = currentProfit > 0 
        ? ((bestCoin.netProfit - currentProfit) / currentProfit) * 100 
        : 100; // 現在利益がない場合は切り替え

      if (profitIncrease >= enabledRule.minProfitIncrease) {
        await this.switchTo(bestCoin.coin, bestCoin.netProfit, enabledRule);
      }

    } catch (error) {
      console.error('Auto-switching check failed:', error);
    }
  }

  private async switchTo(coin: string, expectedProfit: number, rule: SwitchingRule): Promise<void> {
    if (coin === this.currentCoin) return;

    const previousCoin = this.currentCoin;
    this.currentCoin = coin;
    this.lastSwitch = Date.now();

    // 履歴記録
    this.switchHistory.push({
      coin,
      timestamp: this.lastSwitch,
      profit: expectedProfit
    });

    // 古い履歴削除 (24時間より古い)
    this.switchHistory = this.switchHistory.filter(
      s => this.lastSwitch - s.timestamp < 86400000
    );

    console.log(`🔄 Switched from ${previousCoin || 'none'} to ${coin} (Expected: $${expectedProfit.toFixed(2)}/day)`);

    this.emit('coinSwitched', {
      fromCoin: previousCoin,
      toCoin: coin,
      expectedProfit,
      rule: rule.name,
      timestamp: this.lastSwitch
    });
  }

  addRule(rule: SwitchingRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => a.priority - b.priority);
  }

  updateRule(ruleId: string, updates: Partial<SwitchingRule>): void {
    const ruleIndex = this.rules.findIndex(r => r.id === ruleId);
    if (ruleIndex >= 0) {
      this.rules[ruleIndex] = { ...this.rules[ruleIndex], ...updates };
    }
  }

  getCurrentCoin(): string {
    return this.currentCoin;
  }

  getSwitchHistory(): Array<{ coin: string; timestamp: number; profit: number }> {
    return [...this.switchHistory];
  }

  getStats() {
    const now = Date.now();
    const last24h = this.switchHistory.filter(s => now - s.timestamp < 86400000);
    const lastHour = this.switchHistory.filter(s => now - s.timestamp < 3600000);

    return {
      enabled: this.isEnabled,
      currentCoin: this.currentCoin,
      lastSwitch: this.lastSwitch,
      switchesToday: last24h.length,
      switchesLastHour: lastHour.length,
      averageProfitToday: last24h.reduce((sum, s) => sum + s.profit, 0) / Math.max(1, last24h.length),
      activeRule: this.rules.find(r => r.enabled)?.name || 'none'
    };
  }
}

// === 統合システム ===
export class RealTimeProfitabilitySystem extends EventEmitter {
  private marketData: MarketDataProvider;
  private calculator: ProfitabilityCalculator;
  private autoSwitcher: AutoProfitSwitcher;
  private isRunning: boolean = false;

  constructor(hardware: HardwareProfile) {
    super();
    
    this.marketData = new MarketDataProvider();
    this.calculator = new ProfitabilityCalculator(this.marketData);
    this.autoSwitcher = new AutoProfitSwitcher(this.calculator, hardware);

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.marketData.on('dataUpdated', (data) => {
      this.emit('marketDataUpdated', data);
    });

    this.autoSwitcher.on('coinSwitched', (data) => {
      this.emit('coinSwitched', data);
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;
    this.autoSwitcher.start();
    
    console.log('🚀 Real-time profitability system started');
    this.emit('systemStarted');
  }

  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    this.autoSwitcher.stop();
    
    console.log('⏹️ Real-time profitability system stopped');
    this.emit('systemStopped');
  }

  async getProfitabilitySnapshot(): Promise<ProfitabilityData[]> {
    return await this.calculator.getBestProfitableCoins(
      this.autoSwitcher['hardware'], // private アクセス
      10
    );
  }

  enableAutoSwitching(ruleId?: string): void {
    if (ruleId) {
      this.autoSwitcher.updateRule(ruleId, { enabled: true });
      // 他のルールを無効化
      this.autoSwitcher['rules'].forEach(rule => {
        if (rule.id !== ruleId) {
          rule.enabled = false;
        }
      });
    }
    this.autoSwitcher.start();
  }

  disableAutoSwitching(): void {
    this.autoSwitcher.stop();
  }

  getSystemStats() {
    return {
      running: this.isRunning,
      marketData: {
        availableCoins: this.marketData.getAvailableCoins(),
        cachedEntries: this.marketData.getCachedData().size
      },
      autoSwitcher: this.autoSwitcher.getStats()
    };
  }
}

// === 使用例 ===
export async function createProfitabilitySystem(hardware: HardwareProfile): Promise<RealTimeProfitabilitySystem> {
  const system = new RealTimeProfitabilitySystem(hardware);
  
  system.on('coinSwitched', (data) => {
    console.log(`💰 Profit switch: ${data.fromCoin} → ${data.toCoin} (+$${data.expectedProfit.toFixed(2)}/day)`);
  });
  
  system.on('marketDataUpdated', (data) => {
    console.log(`📊 Market update: ${data.symbol} = $${data.data.price.toFixed(4)}`);
  });
  
  await system.start();
  return system;
}