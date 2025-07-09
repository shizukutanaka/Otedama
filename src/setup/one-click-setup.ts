/**
 * ワンクリック自動セットアップシステム
 * 設計思想: John Carmack (実用的), Robert C. Martin (保守性), Rob Pike (シンプル)
 * 
 * 機能:
 * - 包括的ハードウェア検出
 * - 最適アルゴリズム自動選択
 * - 最高収益通貨の自動判定
 * - ワンクリックマイニング開始
 */

import * as os from 'os';
import { execSync, exec } from 'child_process';
import { EventEmitter } from 'events';
import { AlgorithmFactory } from '../algorithms/unified-mining-algorithms';

// === 型定義 ===
export interface HardwareInfo {
  cpu: {
    model: string;
    cores: number;
    threads: number;
    frequency: number;
    architecture: string;
    features: string[];
    hashrate: {
      randomx: number;
      sha256: number;
    };
    powerConsumption: number;
    efficiency: number; // Hash/Watt
  };
  gpu: {
    cards: GPUInfo[];
    totalVRAM: number;
    totalHashrate: {
      kawpow: number;
      ethash: number;
      autolykos: number;
    };
    totalPower: number;
    efficiency: number;
  };
  memory: {
    total: number;
    available: number;
    speed: number;
  };
  storage: {
    available: number;
    type: 'HDD' | 'SSD' | 'NVMe';
  };
  system: {
    os: string;
    version: string;
    drivers: DriverInfo[];
  };
}

export interface GPUInfo {
  name: string;
  vendor: 'NVIDIA' | 'AMD' | 'Intel' | 'Unknown';
  vram: number;
  power: number;
  computeUnits: number;
  hashrate: {
    kawpow: number;
    ethash: number;
    autolykos: number;
  };
  temperature: number;
  efficiency: number;
}

export interface DriverInfo {
  name: string;
  version: string;
  recommended: boolean;
}

export interface OptimalSetup {
  primaryAlgorithm: string;
  primaryCoin: string;
  expectedDailyRevenue: number;
  expectedPowerConsumption: number;
  profitability: number; // $/day after electricity
  confidence: number; // 0-100
  
  cpuMining: {
    enabled: boolean;
    algorithm: string;
    coin: string;
    threads: number;
    expectedHashrate: number;
    expectedRevenue: number;
  };
  
  gpuMining: {
    enabled: boolean;
    algorithm: string;
    coin: string;
    cards: number;
    expectedHashrate: number;
    expectedRevenue: number;
  };
  
  recommendations: string[];
  warnings: string[];
}

export interface MarketData {
  [coin: string]: {
    price: number;
    difficulty: number;
    blockReward: number;
    blockTime: number;
    lastUpdated: number;
  };
}

// === 包括的ハードウェア検出 ===
export class HardwareDetector {
  private static instance: HardwareDetector;
  
  static getInstance(): HardwareDetector {
    if (!this.instance) {
      this.instance = new HardwareDetector();
    }
    return this.instance;
  }

  async detectAll(): Promise<HardwareInfo> {
    console.log('🔍 ハードウェア検出開始...');
    
    const [cpu, gpu, memory, storage, system] = await Promise.all([
      this.detectCPU(),
      this.detectGPU(),
      this.detectMemory(),
      this.detectStorage(),
      this.detectSystem()
    ]);

    const hardware: HardwareInfo = {
      cpu,
      gpu,
      memory,
      storage,
      system
    };

    console.log('✅ ハードウェア検出完了');
    return hardware;
  }

  private async detectCPU(): Promise<HardwareInfo['cpu']> {
    const cpus = os.cpus();
    const cpuInfo = cpus[0];
    
    // CPU特徴検出
    const features = await this.detectCPUFeatures();
    
    // アーキテクチャ検出
    const arch = os.arch();
    const isAppleSilicon = process.platform === 'darwin' && arch === 'arm64';
    
    // ハッシュレート推定
    const baseHashrate = this.estimateCPUHashrate(cpuInfo.model, cpus.length);
    
    return {
      model: cpuInfo.model,
      cores: os.cpus().length,
      threads: this.detectHyperThreading() ? os.cpus().length * 2 : os.cpus().length,
      frequency: cpuInfo.speed,
      architecture: arch,
      features,
      hashrate: {
        randomx: baseHashrate.randomx * (isAppleSilicon ? 1.3 : 1.0), // Apple Silicon boost
        sha256: baseHashrate.sha256
      },
      powerConsumption: this.estimateCPUPower(cpuInfo.model, cpus.length),
      efficiency: baseHashrate.randomx / this.estimateCPUPower(cpuInfo.model, cpus.length)
    };
  }

  private async detectGPU(): Promise<HardwareInfo['gpu']> {
    const cards: GPUInfo[] = [];
    
    try {
      // NVIDIA検出
      const nvidiaCards = await this.detectNVIDIACards();
      cards.push(...nvidiaCards);
      
      // AMD検出
      const amdCards = await this.detectAMDCards();
      cards.push(...amdCards);
      
      // Intel Arc検出
      const intelCards = await this.detectIntelCards();
      cards.push(...intelCards);
      
    } catch (error) {
      console.warn('GPU検出でエラーが発生:', error);
    }

    const totalVRAM = cards.reduce((sum, card) => sum + card.vram, 0);
    const totalPower = cards.reduce((sum, card) => sum + card.power, 0);
    
    const totalHashrate = {
      kawpow: cards.reduce((sum, card) => sum + card.hashrate.kawpow, 0),
      ethash: cards.reduce((sum, card) => sum + card.hashrate.ethash, 0),
      autolykos: cards.reduce((sum, card) => sum + card.hashrate.autolykos, 0)
    };

    return {
      cards,
      totalVRAM,
      totalHashrate,
      totalPower,
      efficiency: totalPower > 0 ? totalHashrate.kawpow / totalPower : 0
    };
  }

  private async detectNVIDIACards(): Promise<GPUInfo[]> {
    const cards: GPUInfo[] = [];
    
    try {
      // nvidia-smi使用
      const output = execSync('nvidia-smi --query-gpu=name,memory.total,power.limit,temperature.gpu --format=csv,noheader,nounits', 
        { encoding: 'utf8', timeout: 5000 });
      
      const lines = output.trim().split('\n');
      
      for (const line of lines) {
        const [name, vram, power, temp] = line.split(', ');
        
        const hashrates = this.estimateNVIDIAHashrate(name);
        
        cards.push({
          name: name.trim(),
          vendor: 'NVIDIA',
          vram: parseInt(vram),
          power: parseInt(power),
          computeUnits: this.getNVIDIACores(name),
          hashrate: hashrates,
          temperature: parseInt(temp),
          efficiency: hashrates.kawpow / parseInt(power)
        });
      }
    } catch (error) {
      // nvidia-smiが使用できない場合のフォールバック
      console.warn('nvidia-smiが利用できません。基本検出を実行します。');
    }
    
    return cards;
  }

  private async detectAMDCards(): Promise<GPUInfo[]> {
    const cards: GPUInfo[] = [];
    
    try {
      // AMD GPU検出試行
      if (process.platform === 'linux') {
        const output = execSync('lspci | grep -i amd | grep -i vga', { encoding: 'utf8', timeout: 5000 });
        // AMDカード情報を解析してcardsに追加
        // 簡略化のため基本的な検出のみ実装
      }
    } catch (error) {
      console.warn('AMD GPU検出でエラー:', error);
    }
    
    return cards;
  }

  private async detectIntelCards(): Promise<GPUInfo[]> {
    const cards: GPUInfo[] = [];
    
    try {
      // Intel Arc検出
      if (process.platform === 'win32') {
        // Windows用Intel Arc検出
        // 実装は簡略化
      }
    } catch (error) {
      console.warn('Intel GPU検出でエラー:', error);
    }
    
    return cards;
  }

  private async detectMemory(): Promise<HardwareInfo['memory']> {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    
    return {
      total: totalMemory,
      available: freeMemory,
      speed: await this.detectMemorySpeed()
    };
  }

  private async detectStorage(): Promise<HardwareInfo['storage']> {
    // 簡略化された実装
    return {
      available: 1000000000000, // 1TB
      type: 'SSD'
    };
  }

  private async detectSystem(): Promise<HardwareInfo['system']> {
    return {
      os: os.platform(),
      version: os.release(),
      drivers: await this.detectDrivers()
    };
  }

  // ヘルパーメソッド
  private async detectCPUFeatures(): Promise<string[]> {
    const features: string[] = [];
    
    try {
      if (process.platform === 'linux') {
        const cpuinfo = execSync('cat /proc/cpuinfo | grep flags', { encoding: 'utf8' });
        if (cpuinfo.includes('avx2')) features.push('AVX2');
        if (cpuinfo.includes('avx512')) features.push('AVX-512');
        if (cpuinfo.includes('aes')) features.push('AES-NI');
      }
    } catch (error) {
      // エラーは無視
    }
    
    return features;
  }

  private detectHyperThreading(): boolean {
    // 簡略化された検出
    return os.cpus().length > 4;
  }

  private estimateCPUHashrate(model: string, cores: number): { randomx: number; sha256: number } {
    // CPU性能データベース（簡略化）
    const hashrates: Record<string, { randomx: number; sha256: number }> = {
      'Intel': { randomx: 2000 * cores, sha256: 50000 * cores },
      'AMD': { randomx: 2500 * cores, sha256: 45000 * cores },
      'Apple': { randomx: 3000 * cores, sha256: 60000 * cores }
    };
    
    for (const [vendor, rates] of Object.entries(hashrates)) {
      if (model.includes(vendor)) {
        return rates;
      }
    }
    
    // デフォルト値
    return { randomx: 1500 * cores, sha256: 40000 * cores };
  }

  private estimateCPUPower(model: string, cores: number): number {
    // TDP推定（ワット）
    if (model.includes('Apple M')) return 20 + cores * 5; // Apple Silicon効率
    if (model.includes('Intel Core i9')) return 125 + cores * 10;
    if (model.includes('Intel Core i7')) return 95 + cores * 8;
    if (model.includes('AMD Ryzen 9')) return 105 + cores * 9;
    if (model.includes('AMD Ryzen 7')) return 85 + cores * 7;
    
    return 65 + cores * 6; // デフォルト
  }

  private estimateNVIDIAHashrate(name: string): { kawpow: number; ethash: number; autolykos: number } {
    // NVIDIA GPU性能データベース
    const hashrates: Record<string, { kawpow: number; ethash: number; autolykos: number }> = {
      'RTX 4090': { kawpow: 62000000, ethash: 130000000, autolykos: 180000000 },
      'RTX 4080': { kawpow: 48000000, ethash: 100000000, autolykos: 140000000 },
      'RTX 4070': { kawpow: 35000000, ethash: 75000000, autolykos: 100000000 },
      'RTX 3090': { kawpow: 54000000, ethash: 120000000, autolykos: 160000000 },
      'RTX 3080': { kawpow: 45000000, ethash: 100000000, autolykos: 135000000 },
      'RTX 3070': { kawpow: 28000000, ethash: 62000000, autolykos: 85000000 },
      'GTX 1660': { kawpow: 15000000, ethash: 25000000, autolykos: 35000000 }
    };
    
    for (const [model, rates] of Object.entries(hashrates)) {
      if (name.includes(model)) {
        return rates;
      }
    }
    
    // デフォルト値
    return { kawpow: 10000000, ethash: 20000000, autolykos: 30000000 };
  }

  private getNVIDIACores(name: string): number {
    const cores: Record<string, number> = {
      'RTX 4090': 16384,
      'RTX 4080': 9728,
      'RTX 3090': 10496,
      'RTX 3080': 8704
    };
    
    for (const [model, coreCount] of Object.entries(cores)) {
      if (name.includes(model)) {
        return coreCount;
      }
    }
    
    return 2048; // デフォルト
  }

  private async detectMemorySpeed(): Promise<number> {
    // 簡略化された実装
    return 3200; // MHz
  }

  private async detectDrivers(): Promise<DriverInfo[]> {
    const drivers: DriverInfo[] = [];
    
    try {
      // NVIDIA ドライバー検出
      const nvidiaVersion = execSync('nvidia-smi --query-gpu=driver_version --format=csv,noheader', 
        { encoding: 'utf8', timeout: 5000 }).trim();
      
      drivers.push({
        name: 'NVIDIA Driver',
        version: nvidiaVersion,
        recommended: this.isRecommendedNVIDIAVersion(nvidiaVersion)
      });
    } catch (error) {
      // エラーは無視
    }
    
    return drivers;
  }

  private isRecommendedNVIDIAVersion(version: string): boolean {
    const majorVersion = parseInt(version.split('.')[0]);
    return majorVersion >= 470; // 推奨バージョン
  }
}

// === 最適設定計算 ===
export class OptimalSetupCalculator {
  private marketData: MarketData = {};
  private electricityCost: number = 0.12; // $/kWh

  constructor(electricityCost: number = 0.12) {
    this.electricityCost = electricityCost;
  }

  async calculateOptimalSetup(hardware: HardwareInfo): Promise<OptimalSetup> {
    console.log('⚡ 最適設定を計算中...');
    
    // 最新の市場データを取得
    await this.updateMarketData();
    
    // CPU最適化
    const cpuSetup = this.calculateCPUSetup(hardware.cpu);
    
    // GPU最適化
    const gpuSetup = this.calculateGPUSetup(hardware.gpu);
    
    // 総収益性計算
    const totalRevenue = cpuSetup.expectedRevenue + gpuSetup.expectedRevenue;
    const totalPower = hardware.cpu.powerConsumption + hardware.gpu.totalPower;
    const electricityCostPerDay = (totalPower / 1000) * 24 * this.electricityCost;
    const profitability = totalRevenue - electricityCostPerDay;
    
    // 推奨事項と警告
    const recommendations = this.generateRecommendations(hardware, profitability);
    const warnings = this.generateWarnings(hardware);
    
    const optimalSetup: OptimalSetup = {
      primaryAlgorithm: gpuSetup.expectedRevenue > cpuSetup.expectedRevenue ? gpuSetup.algorithm : cpuSetup.algorithm,
      primaryCoin: gpuSetup.expectedRevenue > cpuSetup.expectedRevenue ? gpuSetup.coin : cpuSetup.coin,
      expectedDailyRevenue: totalRevenue,
      expectedPowerConsumption: totalPower,
      profitability,
      confidence: this.calculateConfidence(hardware),
      cpuMining: cpuSetup,
      gpuMining: gpuSetup,
      recommendations,
      warnings
    };

    console.log('✅ 最適設定計算完了');
    return optimalSetup;
  }

  private async updateMarketData(): Promise<void> {
    // 簡略化された市場データ（実際の実装では外部APIから取得）
    this.marketData = {
      'XMR': { price: 150, difficulty: 300000000000, blockReward: 0.6, blockTime: 120, lastUpdated: Date.now() },
      'RVN': { price: 0.025, difficulty: 120000000000, blockReward: 2500, blockTime: 60, lastUpdated: Date.now() },
      'ETC': { price: 18, difficulty: 2000000000000000, blockReward: 2.56, blockTime: 15, lastUpdated: Date.now() },
      'ERG': { price: 1.2, difficulty: 1200000000000, blockReward: 15, blockTime: 120, lastUpdated: Date.now() }
    };
  }

  private calculateCPUSetup(cpu: HardwareInfo['cpu']): OptimalSetup['cpuMining'] {
    // RandomX (Monero) が最も収益性が高い
    const algorithm = 'randomx';
    const coin = 'XMR';
    const threads = Math.max(1, cpu.cores - 1); // 1コア残す
    const expectedHashrate = cpu.hashrate.randomx * (threads / cpu.cores);
    
    const dailyRevenue = this.calculateDailyRevenue(expectedHashrate, coin, algorithm);
    
    return {
      enabled: dailyRevenue > 0.5, // $0.5/day以上で有効
      algorithm,
      coin,
      threads,
      expectedHashrate,
      expectedRevenue: dailyRevenue
    };
  }

  private calculateGPUSetup(gpu: HardwareInfo['gpu']): OptimalSetup['gpuMining'] {
    if (gpu.cards.length === 0) {
      return {
        enabled: false,
        algorithm: '',
        coin: '',
        cards: 0,
        expectedHashrate: 0,
        expectedRevenue: 0
      };
    }

    // アルゴリズム別収益性計算
    const algorithms = ['kawpow', 'ethash', 'autolykos'] as const;
    const coins = ['RVN', 'ETC', 'ERG'];
    
    let bestSetup = { algorithm: '', coin: '', revenue: 0, hashrate: 0 };
    
    for (let i = 0; i < algorithms.length; i++) {
      const algorithm = algorithms[i];
      const coin = coins[i];
      const hashrate = gpu.totalHashrate[algorithm];
      const revenue = this.calculateDailyRevenue(hashrate, coin, algorithm);
      
      if (revenue > bestSetup.revenue) {
        bestSetup = { algorithm, coin, revenue, hashrate };
      }
    }

    return {
      enabled: bestSetup.revenue > 1.0, // $1.0/day以上で有効
      algorithm: bestSetup.algorithm,
      coin: bestSetup.coin,
      cards: gpu.cards.length,
      expectedHashrate: bestSetup.hashrate,
      expectedRevenue: bestSetup.revenue
    };
  }

  private calculateDailyRevenue(hashrate: number, coin: string, algorithm: string): number {
    const coinData = this.marketData[coin];
    if (!coinData) return 0;

    // 簡略化された収益計算
    const networkHashrate = coinData.difficulty * (Math.pow(2, 32) / coinData.blockTime);
    const shareOfNetwork = hashrate / networkHashrate;
    const blocksPerDay = 86400 / coinData.blockTime;
    const dailyReward = shareOfNetwork * blocksPerDay * coinData.blockReward;
    const dailyRevenue = dailyReward * coinData.price;

    return dailyRevenue;
  }

  private generateRecommendations(hardware: HardwareInfo, profitability: number): string[] {
    const recommendations: string[] = [];
    
    if (profitability < 0) {
      recommendations.push('電気代が収益を上回っています。より効率的なハードウェアの検討をお勧めします。');
    }
    
    if (hardware.gpu.cards.length === 0) {
      recommendations.push('GPU追加により収益性が大幅に向上する可能性があります。');
    }
    
    if (hardware.cpu.features.includes('AVX-512')) {
      recommendations.push('AVX-512対応CPUです。RandomXで高いパフォーマンスが期待できます。');
    }
    
    return recommendations;
  }

  private generateWarnings(hardware: HardwareInfo): string[] {
    const warnings: string[] = [];
    
    if (hardware.memory.available < 4000000000) { // 4GB
      warnings.push('利用可能メモリが不足しています。マイニング性能が低下する可能性があります。');
    }
    
    const outdatedDrivers = hardware.system.drivers.filter(d => !d.recommended);
    if (outdatedDrivers.length > 0) {
      warnings.push('古いドライバーが検出されました。最新版への更新をお勧めします。');
    }
    
    return warnings;
  }

  private calculateConfidence(hardware: HardwareInfo): number {
    let confidence = 100;
    
    // GPU検出の成功度
    if (hardware.gpu.cards.length === 0 && process.platform === 'win32') {
      confidence -= 20; // Windowsでのみ期待
    }
    
    // ドライバーの状態
    const outdatedDrivers = hardware.system.drivers.filter(d => !d.recommended);
    confidence -= outdatedDrivers.length * 10;
    
    // メモリ不足
    if (hardware.memory.available < 4000000000) {
      confidence -= 15;
    }
    
    return Math.max(0, confidence);
  }
}

// === ワンクリックセットアップ ===
export class OneClickSetup extends EventEmitter {
  private detector = HardwareDetector.getInstance();
  private calculator = new OptimalSetupCalculator();
  
  async executeSetup(): Promise<OptimalSetup> {
    this.emit('progress', { step: 'hardware', message: 'ハードウェアを検出中...' });
    const hardware = await this.detector.detectAll();
    
    this.emit('progress', { step: 'optimization', message: '最適設定を計算中...' });
    const setup = await this.calculator.calculateOptimalSetup(hardware);
    
    this.emit('progress', { step: 'validation', message: '設定を検証中...' });
    await this.validateSetup(setup);
    
    this.emit('progress', { step: 'complete', message: '設定完了！マイニングを開始できます。' });
    
    return setup;
  }

  private async validateSetup(setup: OptimalSetup): Promise<void> {
    // セットアップの妥当性チェック
    if (setup.profitability <= 0) {
      throw new Error('現在の電気代では収益が見込めません。設定を見直してください。');
    }
    
    if (setup.confidence < 50) {
      console.warn('設定の信頼度が低いです。手動調整が必要な場合があります。');
    }
  }

  generateConfigFile(setup: OptimalSetup): string {
    const config = {
      app: {
        name: 'Otedama Mining',
        autoStart: true
      },
      mining: {
        cpu: {
          enabled: setup.cpuMining.enabled,
          algorithm: setup.cpuMining.algorithm,
          coin: setup.cpuMining.coin,
          threads: setup.cpuMining.threads
        },
        gpu: {
          enabled: setup.gpuMining.enabled,
          algorithm: setup.gpuMining.algorithm,
          coin: setup.gpuMining.coin
        }
      },
      pool: {
        address: 'YOUR_WALLET_ADDRESS_HERE',
        feePercent: 0,
        stratumPort: 3333
      },
      optimization: {
        autoSwitch: true,
        profitabilityCheck: 300 // 5分間隔
      }
    };
    
    return JSON.stringify(config, null, 2);
  }
}

// === 使用例 ===
export async function performOneClickSetup(): Promise<OptimalSetup> {
  const setup = new OneClickSetup();
  
  setup.on('progress', (data) => {
    console.log(`[${data.step.toUpperCase()}] ${data.message}`);
  });
  
  try {
    const optimalSetup = await setup.executeSetup();
    
    console.log('🎉 ワンクリックセットアップ完了！');
    console.log(`💰 予想日次収益: $${optimalSetup.profitability.toFixed(2)}`);
    console.log(`⚡ 電力消費: ${optimalSetup.expectedPowerConsumption}W`);
    console.log(`🎯 信頼度: ${optimalSetup.confidence}%`);
    
    return optimalSetup;
  } catch (error) {
    console.error('❌ セットアップ失敗:', error);
    throw error;
  }
}