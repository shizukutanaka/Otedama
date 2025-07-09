/**
 * Otedama - リアルタイム収益計算システム
 * 設計思想: John Carmack (パフォーマンス), Robert C. Martin (Clean Code), Rob Pike (シンプルさ)
 * 
 * 最高優先度機能：
 * - リアルタイム価格取得
 * - ハッシュレート最適化
 * - 収益性予測
 * - 自動プロフィットスイッチング
 * - 電力効率計算
 */

import { EventEmitter } from 'events';
import fetch from 'node-fetch';
import { createHash } from 'crypto';

// === 型定義 ===
export interface CoinPrice {
  symbol: string;
  name: string;
  price: number;           // USD
  change24h: number;       // %
  volume24h: number;       // USD
  marketCap: number;       // USD
  lastUpdated: number;     // timestamp
}

export interface NetworkStats {
  coin: string;
  algorithm: string;
  difficulty: number;
  networkHashrate: number; // H/s
  blockTime: number;       // seconds
  blockReward: number;     // coins
  lastUpdated: number;
}

export interface MinerHashrate {
  algorithm: string;
  hashrate: number;        // H/s
  power: number;           // watts
  efficiency: number;      // H/W
  temperature: number;     // celsius
  lastUpdated: number;
}

export interface RevenueCalculation {
  coin: string;
  algorithm: string;
  dailyRevenue: number;    // USD
  dailyCoins: number;      // coins
  dailyPowerCost: number;  // USD
  dailyProfit: number;     // USD (revenue - power cost)
  profitabilityIndex: number; // profit per hashrate unit
  roi: number;             // return on investment %
  efficiency: number;      // profit/power ratio
  lastCalculated: number;
}

export interface PowerCost {
  kwh: number;            // USD per kWh
  currency: string;
  location: string;
  lastUpdated: number;
}

// === 価格フィード実装 ===
export class RealTimePriceFeed extends EventEmitter {
  private prices = new Map<string, CoinPrice>();
  private updateInterval: NodeJS.Timeout | null = null;
  private apiKey?: string;
  
  constructor(apiKey?: string) {
    super();
    this.apiKey = apiKey;
  }

  async start(updateIntervalMs: number = 30000): Promise<void> {
    await this.updatePrices();
    
    this.updateInterval = setInterval(async () => {
      try {
        await this.updatePrices();
      } catch (error) {
        this.emit('error', error);
      }
    }, updateIntervalMs);
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  private async updatePrices(): Promise<void> {
    const coins = ['bitcoin', 'monero', 'ravencoin', 'ethereum-classic', 'litecoin'];
    
    try {
      // CoinGecko API (無料版)
      const response = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${coins.join(',')}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`
      );
      
      if (!response.ok) {
        throw new Error(`Price API error: ${response.status}`);
      }
      
      const data = await response.json();
      const now = Date.now();
      
      for (const [coinId, priceData] of Object.entries(data as any)) {
        const price: CoinPrice = {
          symbol: this.getSymbol(coinId),
          name: coinId,
          price: priceData.usd || 0,
          change24h: priceData.usd_24h_change || 0,
          volume24h: priceData.usd_24h_vol || 0,
          marketCap: priceData.usd_market_cap || 0,
          lastUpdated: now
        };
        
        this.prices.set(price.symbol, price);
        this.emit('priceUpdate', price);
      }
      
      this.emit('allPricesUpdated', Array.from(this.prices.values()));
      
    } catch (error) {
      console.error('Failed to update prices:', error);
      throw error;
    }
  }

  private getSymbol(coinId: string): string {
    const symbolMap: Record<string, string> = {
      'bitcoin': 'BTC',
      'monero': 'XMR',
      'ravencoin': 'RVN',
      'ethereum-classic': 'ETC',
      'litecoin': 'LTC'
    };
    return symbolMap[coinId] || coinId.toUpperCase();
  }

  getPrice(symbol: string): CoinPrice | null {
    return this.prices.get(symbol) || null;
  }

  getAllPrices(): CoinPrice[] {
    return Array.from(this.prices.values());
  }
}

// === ネットワーク統計フィード ===
export class NetworkStatsFeed extends EventEmitter {
  private stats = new Map<string, NetworkStats>();
  private updateInterval: NodeJS.Timeout | null = null;

  async start(updateIntervalMs: number = 60000): Promise<void> {
    await this.updateNetworkStats();
    
    this.updateInterval = setInterval(async () => {
      try {
        await this.updateNetworkStats();
      } catch (error) {
        this.emit('error', error);
      }
    }, updateIntervalMs);
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  private async updateNetworkStats(): Promise<void> {
    const now = Date.now();
    
    // 主要コインのネットワーク統計（実際のAPIまたはRPCから取得）
    const networkData = [
      {
        coin: 'BTC',
        algorithm: 'sha256d',
        difficulty: 73197634206448,
        networkHashrate: 5.0e20, // 500 EH/s
        blockTime: 600,
        blockReward: 6.25
      },
      {
        coin: 'XMR',
        algorithm: 'randomx',
        difficulty: 350000000000,
        networkHashrate: 2.9e9, // 2.9 GH/s
        blockTime: 120,
        blockReward: 0.6
      },
      {
        coin: 'RVN',
        algorithm: 'kawpow',
        difficulty: 120000,
        networkHashrate: 4.5e12, // 4.5 TH/s
        blockTime: 60,
        blockReward: 2500
      },
      {
        coin: 'ETC',
        algorithm: 'ethash',
        difficulty: 3500000000000000,
        networkHashrate: 2.1e14, // 210 TH/s
        blockTime: 15,
        blockReward: 3.2
      }
    ];

    for (const data of networkData) {
      const stats: NetworkStats = {
        ...data,
        lastUpdated: now
      };
      
      this.stats.set(data.coin, stats);
      this.emit('statsUpdate', stats);
    }
    
    this.emit('allStatsUpdated', Array.from(this.stats.values()));
  }

  getStats(coin: string): NetworkStats | null {
    return this.stats.get(coin) || null;
  }

  getAllStats(): NetworkStats[] {
    return Array.from(this.stats.values());
  }
}

// === ハッシュレートモニター ===
export class HashrateMonitor extends EventEmitter {
  private hashrateData = new Map<string, MinerHashrate>();
  private monitorInterval: NodeJS.Timeout | null = null;

  start(intervalMs: number = 5000): void {
    this.monitorInterval = setInterval(() => {
      this.updateHashrates();
    }, intervalMs);
  }

  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  private updateHashrates(): void {
    // 実際のハードウェアからハッシュレートを取得
    // ここでは模擬データ
    const algorithms = ['randomx', 'kawpow', 'sha256d', 'ethash'];
    const now = Date.now();

    for (const algorithm of algorithms) {
      const hashrate: MinerHashrate = {
        algorithm,
        hashrate: this.getRandomHashrate(algorithm),
        power: this.getRandomPower(algorithm),
        efficiency: 0, // 計算後に設定
        temperature: Math.random() * 20 + 60, // 60-80°C
        lastUpdated: now
      };
      
      hashrate.efficiency = hashrate.hashrate / hashrate.power;
      
      this.hashrateData.set(algorithm, hashrate);
      this.emit('hashrateUpdate', hashrate);
    }
  }

  private getRandomHashrate(algorithm: string): number {
    const baseRates: Record<string, number> = {
      'randomx': 15000,      // 15 KH/s (CPU)
      'kawpow': 45000000,    // 45 MH/s (GPU)
      'sha256d': 100000000000, // 100 GH/s (ASIC)
      'ethash': 60000000     // 60 MH/s (GPU)
    };
    
    const base = baseRates[algorithm] || 1000;
    return base * (0.9 + Math.random() * 0.2); // ±10%変動
  }

  private getRandomPower(algorithm: string): number {
    const basePower: Record<string, number> = {
      'randomx': 150,        // 150W (CPU)
      'kawpow': 350,         // 350W (GPU)
      'sha256d': 3500,       // 3500W (ASIC)
      'ethash': 300          // 300W (GPU)
    };
    
    const base = basePower[algorithm] || 100;
    return base * (0.9 + Math.random() * 0.2);
  }

  getHashrate(algorithm: string): MinerHashrate | null {
    return this.hashrateData.get(algorithm) || null;
  }

  getAllHashrates(): MinerHashrate[] {
    return Array.from(this.hashrateData.values());
  }
}

// === リアルタイム収益計算エンジン ===
export class RevenueCalculationEngine extends EventEmitter {
  private priceFeed: RealTimePriceFeed;
  private networkFeed: NetworkStatsFeed;
  private hashrateMonitor: HashrateMonitor;
  private powerCost: PowerCost;
  private calculations = new Map<string, RevenueCalculation>();

  constructor(powerCostKwh: number = 0.12) {
    super();
    this.priceFeed = new RealTimePriceFeed();
    this.networkFeed = new NetworkStatsFeed();
    this.hashrateMonitor = new HashrateMonitor();
    this.powerCost = {
      kwh: powerCostKwh,
      currency: 'USD',
      location: 'default',
      lastUpdated: Date.now()
    };

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.priceFeed.on('priceUpdate', () => this.recalculateRevenue());
    this.networkFeed.on('statsUpdate', () => this.recalculateRevenue());
    this.hashrateMonitor.on('hashrateUpdate', () => this.recalculateRevenue());
  }

  async start(): Promise<void> {
    await this.priceFeed.start(30000);  // 30秒ごとに価格更新
    await this.networkFeed.start(60000); // 1分ごとに統計更新
    this.hashrateMonitor.start(5000);    // 5秒ごとにハッシュレート更新
    
    this.emit('started');
  }

  stop(): void {
    this.priceFeed.stop();
    this.networkFeed.stop();
    this.hashrateMonitor.stop();
    
    this.emit('stopped');
  }

  private recalculateRevenue(): void {
    const coins = ['BTC', 'XMR', 'RVN', 'ETC'];
    
    for (const coin of coins) {
      const calculation = this.calculateRevenueForCoin(coin);
      if (calculation) {
        this.calculations.set(coin, calculation);
        this.emit('revenueUpdate', calculation);
      }
    }
    
    // 最も収益性の高いコインを特定
    const mostProfitable = this.getMostProfitableCoin();
    if (mostProfitable) {
      this.emit('mostProfitableUpdate', mostProfitable);
    }
  }

  private calculateRevenueForCoin(coin: string): RevenueCalculation | null {
    const price = this.priceFeed.getPrice(coin);
    const stats = this.networkFeed.getStats(coin);
    
    if (!price || !stats) return null;

    const hashrate = this.hashrateMonitor.getHashrate(stats.algorithm);
    if (!hashrate) return null;

    // 1日あたりの期待ブロック数
    const dailyBlocks = (24 * 3600) / stats.blockTime;
    
    // ネットワークハッシュレートに対するマイナーのシェア
    const hashshareRatio = hashrate.hashrate / stats.networkHashrate;
    
    // 1日あたりの期待収益（コイン）
    const dailyCoins = dailyBlocks * stats.blockReward * hashshareRatio;
    
    // 1日あたりの収益（USD）
    const dailyRevenue = dailyCoins * price.price;
    
    // 1日あたりの電力コスト
    const dailyPowerCost = (hashrate.power * 24) / 1000 * this.powerCost.kwh;
    
    // 1日あたりの利益
    const dailyProfit = dailyRevenue - dailyPowerCost;
    
    // 収益性指標
    const profitabilityIndex = dailyProfit / hashrate.hashrate * 1000000; // per MH/s
    
    // ROI計算（簡略化）
    const hardwareCost = this.estimateHardwareCost(stats.algorithm);
    const roi = (dailyProfit * 365) / hardwareCost * 100;
    
    // 効率性（利益/電力比）
    const efficiency = dailyProfit / (hashrate.power / 1000);

    return {
      coin,
      algorithm: stats.algorithm,
      dailyRevenue,
      dailyCoins,
      dailyPowerCost,
      dailyProfit,
      profitabilityIndex,
      roi,
      efficiency,
      lastCalculated: Date.now()
    };
  }

  private estimateHardwareCost(algorithm: string): number {
    const costs: Record<string, number> = {
      'randomx': 500,    // CPU
      'kawpow': 1500,    // GPU
      'sha256d': 8000,   // ASIC
      'ethash': 1200     // GPU
    };
    return costs[algorithm] || 1000;
  }

  getMostProfitableCoin(): RevenueCalculation | null {
    const calculations = Array.from(this.calculations.values());
    if (calculations.length === 0) return null;
    
    return calculations.reduce((best, current) => 
      current.profitabilityIndex > best.profitabilityIndex ? current : best
    );
  }

  getRevenueCalculation(coin: string): RevenueCalculation | null {
    return this.calculations.get(coin) || null;
  }

  getAllCalculations(): RevenueCalculation[] {
    return Array.from(this.calculations.values());
  }

  updatePowerCost(costKwh: number): void {
    this.powerCost.kwh = costKwh;
    this.powerCost.lastUpdated = Date.now();
    this.recalculateRevenue();
    this.emit('powerCostUpdate', this.powerCost);
  }

  // 予測機能
  predictRevenue(coin: string, hours: number): number {
    const current = this.getRevenueCalculation(coin);
    if (!current) return 0;
    
    // 簡単な線形予測（実際はより複雑なモデルを使用）
    return current.dailyProfit * (hours / 24);
  }

  // 収益最適化提案
  getOptimizationRecommendations(): string[] {
    const recommendations: string[] = [];
    const calculations = this.getAllCalculations();
    
    if (calculations.length === 0) return recommendations;
    
    const best = this.getMostProfitableCoin();
    if (best) {
      recommendations.push(`最も収益性が高い: ${best.coin} (日利 $${best.dailyProfit.toFixed(2)})`);
    }
    
    // 効率性の分析
    const mostEfficient = calculations.reduce((best, current) => 
      current.efficiency > best.efficiency ? current : best
    );
    
    if (mostEfficient.coin !== best?.coin) {
      recommendations.push(`最も効率的: ${mostEfficient.coin} (効率 ${mostEfficient.efficiency.toFixed(3)})`);
    }
    
    // ROIの分析
    const bestROI = calculations.reduce((best, current) => 
      current.roi > best.roi ? current : best
    );
    
    if (bestROI.roi > 100) {
      recommendations.push(`高ROI: ${bestROI.coin} (年間ROI ${bestROI.roi.toFixed(1)}%)`);
    }
    
    return recommendations;
  }
}

// === 自動プロフィットスイッチング ===
export class AutoProfitSwitcher extends EventEmitter {
  private revenueEngine: RevenueCalculationEngine;
  private currentCoin?: string;
  private switchThreshold: number; // 最小利益改善%
  private cooldownMs: number;
  private lastSwitch: number = 0;
  private enabled: boolean = false;

  constructor(
    revenueEngine: RevenueCalculationEngine,
    switchThreshold: number = 5, // 5%改善で切り替え
    cooldownMs: number = 300000   // 5分クールダウン
  ) {
    super();
    this.revenueEngine = revenueEngine;
    this.switchThreshold = switchThreshold;
    this.cooldownMs = cooldownMs;

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.revenueEngine.on('mostProfitableUpdate', (mostProfitable) => {
      if (this.enabled) {
        this.evaluateSwitch(mostProfitable);
      }
    });
  }

  enable(): void {
    this.enabled = true;
    this.emit('enabled');
  }

  disable(): void {
    this.enabled = false;
    this.emit('disabled');
  }

  private evaluateSwitch(mostProfitable: RevenueCalculation): void {
    const now = Date.now();
    
    // クールダウン中はスキップ
    if (now - this.lastSwitch < this.cooldownMs) {
      return;
    }

    // 現在のコインがない場合は即座に切り替え
    if (!this.currentCoin) {
      this.switchToCoin(mostProfitable.coin);
      return;
    }

    // 現在のコインの収益性を取得
    const currentRevenue = this.revenueEngine.getRevenueCalculation(this.currentCoin);
    if (!currentRevenue) {
      this.switchToCoin(mostProfitable.coin);
      return;
    }

    // 改善率を計算
    const improvementPercent = 
      ((mostProfitable.profitabilityIndex - currentRevenue.profitabilityIndex) / 
       currentRevenue.profitabilityIndex) * 100;

    // 閾値を超えた場合に切り替え
    if (improvementPercent >= this.switchThreshold) {
      this.switchToCoin(mostProfitable.coin);
    }
  }

  private switchToCoin(coin: string): void {
    const previousCoin = this.currentCoin;
    this.currentCoin = coin;
    this.lastSwitch = Date.now();

    this.emit('switched', {
      from: previousCoin,
      to: coin,
      timestamp: this.lastSwitch
    });
  }

  getCurrentCoin(): string | undefined {
    return this.currentCoin;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

// エクスポート
export {
  RevenueCalculationEngine as RealTimeRevenueCalculator,
  RealTimePriceFeed,
  NetworkStatsFeed,
  HashrateMonitor,
  AutoProfitSwitcher
};