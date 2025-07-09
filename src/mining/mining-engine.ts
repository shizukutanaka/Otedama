/**
 * マイニングエンジン - 高性能マルチアルゴリズム対応
 * 
 * 設計思想:
 * - John Carmack: 高性能・最適化・実用的
 * - Robert C. Martin: クリーンアーキテクチャ・SOLID原則  
 * - Rob Pike: シンプリシティ・必要最小限
 * 
 * 対応アルゴリズム（IMPROVEMENTS_300.md 1-15番対応）:
 * 1. Monero RandomX (CPU最高収益)
 * 2. Ravencoin KawPow (GPU最高収益) 
 * 3. Ethereum Classic Ethash (GPU安定)
 * 4. Bitcoin SHA-256 (ASIC主力)
 * 5. Ergo Autolykos v2 (GPU有望)
 */

import { EventEmitter } from 'events';
import { CPUMiner } from '../simple-cpu-miner-stub';
import { GPUMiner } from '../simple-gpu-miner-stub';
import { ASICMiner } from '../simple-asic-miner-stub';

export interface MiningConfig {
  algorithm: string;
  currency: string;
  address: string;
  workerName: string;
  difficulty: number;
  poolUrl?: string;
  intensity?: 'low' | 'medium' | 'high';
  power?: number;
}

export interface MiningStatistics {
  hashrate: number;
  sharesAccepted: number;
  sharesRejected: number;
  power: number;
  temperature: number;
  uptime: number;
  efficiency: number; // hash/watt
}

export interface HardwareInfo {
  cpu: {
    model: string;
    cores: number;
    threads: number;
    power: number;
  };
  gpu: Array<{
    name: string;
    memory: number;
    power: number;
    compute: string;
  }>;
  asic: Array<{
    name: string;
    power: number;
    hashrate: number;
  }>;
}

// アルゴリズム定義（最重要度の高い5つから開始）
export const SUPPORTED_ALGORITHMS = {
  // 1. Monero RandomX - CPU最高収益通貨 (676%収益性)
  RANDOMX: {
    name: 'RandomX',
    currency: 'XMR',
    hardware: 'CPU',
    profitability: 676,
    difficulty: 1000,
    blockTime: 120
  },
  
  // 2. Ravencoin KawPow - GPU最高収益通貨 (550%収益性)
  KAWPOW: {
    name: 'KawPow',
    currency: 'RVN', 
    hardware: 'GPU',
    profitability: 550,
    difficulty: 50000,
    blockTime: 60
  },
  
  // 3. Ethereum Classic Ethash - GPU安定通貨
  ETHASH: {
    name: 'Ethash',
    currency: 'ETC',
    hardware: 'GPU',
    profitability: 400,
    difficulty: 100000,
    blockTime: 13
  },
  
  // 4. Bitcoin SHA-256 - 主力ASIC通貨
  SHA256: {
    name: 'SHA-256',
    currency: 'BTC',
    hardware: 'ASIC',
    profitability: 350,
    difficulty: 1000000000,
    blockTime: 600
  },
  
  // 5. Ergo Autolykos v2 - 有望GPU通貨 (581%収益性)
  AUTOLYKOS2: {
    name: 'Autolykos v2',
    currency: 'ERG',
    hardware: 'GPU', 
    profitability: 581,
    difficulty: 75000,
    blockTime: 120
  }
} as const;

export class MiningEngine extends EventEmitter {
  private isRunning = false;
  private isPaused = false;
  private currentConfig: MiningConfig | null = null;
  private statistics: MiningStatistics;
  private logger: any;
  
  private cpuMiner: CPUMiner;
  private gpuMiner: GPUMiner;
  private asicMiner: ASICMiner;
  
  private startTime: number = 0;
  private statsInterval?: NodeJS.Timeout;

  constructor(logger: any) {
    super();
    
    this.logger = logger;
    this.cpuMiner = new CPUMiner();
    this.gpuMiner = new GPUMiner();
    this.asicMiner = new ASICMiner();
    
    this.statistics = this.initializeStatistics();
    this.setupMinerEvents();
  }

  private initializeStatistics(): MiningStatistics {
    return {
      hashrate: 0,
      sharesAccepted: 0,
      sharesRejected: 0,
      power: 0,
      temperature: 0,
      uptime: 0,
      efficiency: 0
    };
  }

  private setupMinerEvents(): void {
    // CPU Miner Events
    this.cpuMiner.on('hashrate', (hashrate: number) => {
      this.statistics.hashrate = hashrate;
      this.emit('hashrateUpdate', hashrate);
      this.logger?.debug(`CPU Hashrate: ${(hashrate / 1000).toFixed(2)} KH/s`);
    });

    this.cpuMiner.on('share', (share: any) => {
      if (share.valid) {
        this.statistics.sharesAccepted++;
        this.emit('shareAccepted', share);
        this.logger?.info(`✅ CPU Share accepted: ${share.id}`);
      } else {
        this.statistics.sharesRejected++;
        this.emit('shareRejected', share);
        this.logger?.warn(`❌ CPU Share rejected: ${share.id}`);
      }
    });

    // GPU Miner Events
    this.gpuMiner.on('hashrate', (deviceId: string, hashrate: number) => {
      this.statistics.hashrate = hashrate;
      this.emit('hashrateUpdate', hashrate);
      this.logger?.debug(`GPU ${deviceId} Hashrate: ${(hashrate / 1000000).toFixed(2)} MH/s`);
    });

    this.gpuMiner.on('share', (deviceId: string, share: any) => {
      if (share.valid) {
        this.statistics.sharesAccepted++;
        this.emit('shareAccepted', share);
        this.logger?.info(`✅ GPU ${deviceId} Share accepted: ${share.id}`);
      } else {
        this.statistics.sharesRejected++;
        this.emit('shareRejected', share);
        this.logger?.warn(`❌ GPU ${deviceId} Share rejected: ${share.id}`);
      }
    });

    // ASIC Miner Events
    this.asicMiner.on('hashrate', (deviceId: string, hashrate: number) => {
      this.statistics.hashrate = hashrate;
      this.emit('hashrateUpdate', hashrate);
      this.logger?.debug(`ASIC ${deviceId} Hashrate: ${(hashrate / 1000000000000).toFixed(2)} TH/s`);
    });

    this.asicMiner.on('share', (deviceId: string, share: any) => {
      if (share.valid) {
        this.statistics.sharesAccepted++;
        this.emit('shareAccepted', share);
        this.logger?.info(`✅ ASIC ${deviceId} Share accepted: ${share.id}`);
      } else {
        this.statistics.sharesRejected++;
        this.emit('shareRejected', share);
        this.logger?.warn(`❌ ASIC ${deviceId} Share rejected: ${share.id}`);
      }
    });
  }

  async initialize(): Promise<void> {
    this.logger?.info('🔧 Initializing Mining Engine...');
    
    try {
      // Initialize hardware detection
      await this.detectHardware();
      
      this.logger?.success('✅ Mining Engine initialized successfully');
    } catch (error) {
      this.logger?.error('❌ Failed to initialize Mining Engine:', error);
      throw error;
    }
  }

  async detectHardware(): Promise<HardwareInfo> {
    this.logger?.info('🔍 Detecting mining hardware...');
    
    try {
      // CPU Detection
      const cpuInfo = await this.cpuMiner.detectHardware();
      const cpu = {
        model: cpuInfo.name,
        cores: require('os').cpus().length,
        threads: require('os').cpus().length,
        power: cpuInfo.power || 65
      };

      // GPU Detection
      const gpuDevices = await this.gpuMiner.detectDevices();
      const gpu = gpuDevices.map(device => ({
        name: device.name,
        memory: 8192, // 仮値、実際は検出する
        power: device.power || 250,
        compute: '8.6' // 仮値、実際は検出する
      }));

      // ASIC Detection
      const asicDevices = await this.asicMiner.detectDevices();
      const asic = asicDevices.map(device => ({
        name: device.name,
        power: device.power || 3000,
        hashrate: 110000000000000 // 110 TH/s 仮値
      }));

      const hardwareInfo: HardwareInfo = { cpu, gpu, asic };
      
      this.logger?.info('💻 Hardware detected:', {
        CPU: cpu.model,
        GPUs: gpu.length,
        ASICs: asic.length
      });

      return hardwareInfo;
    } catch (error) {
      this.logger?.error('❌ Hardware detection failed:', error);
      throw error;
    }
  }

  async startMining(config: MiningConfig): Promise<void> {
    if (this.isRunning) {
      throw new Error('Mining is already running');
    }

    this.logger?.info('⚡ Starting mining with configuration:', {
      algorithm: config.algorithm,
      currency: config.currency,
      worker: config.workerName
    });

    try {
      // Validate configuration
      this.validateConfig(config);
      
      // Set configuration
      this.currentConfig = config;
      this.isRunning = true;
      this.isPaused = false;
      this.startTime = Date.now();
      
      // Reset statistics
      this.statistics = this.initializeStatistics();
      
      // Start appropriate miner based on algorithm
      await this.startMinerByAlgorithm(config);
      
      // Start statistics update
      this.startStatsUpdate();
      
      this.emit('miningStarted', config);
      this.logger?.success(`✅ Mining started: ${config.currency} (${config.algorithm})`);
      
    } catch (error) {
      this.isRunning = false;
      this.currentConfig = null;
      this.logger?.error('❌ Failed to start mining:', error);
      throw error;
    }
  }

  private validateConfig(config: MiningConfig): void {
    if (!config.algorithm || !config.currency || !config.address) {
      throw new Error('Invalid mining configuration: algorithm, currency, and address are required');
    }

    const algorithm = Object.values(SUPPORTED_ALGORITHMS).find(
      alg => alg.name === config.algorithm || alg.currency === config.currency
    );

    if (!algorithm) {
      throw new Error(`Unsupported algorithm: ${config.algorithm}`);
    }
  }

  private async startMinerByAlgorithm(config: MiningConfig): Promise<void> {
    const algorithm = Object.values(SUPPORTED_ALGORITHMS).find(
      alg => alg.name === config.algorithm || alg.currency === config.currency
    );

    if (!algorithm) {
      throw new Error(`Algorithm not found: ${config.algorithm}`);
    }

    switch (algorithm.hardware) {
      case 'CPU':
        this.logger?.info('🔥 Starting CPU mining for RandomX (Monero)');
        await this.cpuMiner.start({
          algorithm: algorithm.name,
          threads: this.getOptimalThreadCount()
        });
        break;

      case 'GPU':
        this.logger?.info(`🎮 Starting GPU mining for ${algorithm.name} (${algorithm.currency})`);
        const gpuDevices = await this.gpuMiner.detectDevices();
        for (let i = 0; i < gpuDevices.length; i++) {
          await this.gpuMiner.startDevice(`gpu-${i}`, {
            algorithm: algorithm.name
          });
        }
        break;

      case 'ASIC':
        this.logger?.info('⚡ Starting ASIC mining for SHA-256 (Bitcoin)');
        const asicDevices = await this.asicMiner.detectDevices();
        for (let i = 0; i < asicDevices.length; i++) {
          await this.asicMiner.startDevice(`asic-${i}`, {
            algorithm: algorithm.name
          });
        }
        break;

      default:
        throw new Error(`Unsupported hardware type: ${algorithm.hardware}`);
    }
  }

  private getOptimalThreadCount(): number {
    const cpuCount = require('os').cpus().length;
    // CPUコア数 - 1 (システム用に1コア残す)
    return Math.max(1, cpuCount - 1);
  }

  async stopMining(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger?.info('⛏️ Stopping mining...');

    try {
      // Stop all miners
      await this.cpuMiner.stop();
      await this.gpuMiner.stop();
      await this.asicMiner.stop();
      
      // Stop statistics update
      this.stopStatsUpdate();
      
      // Reset state
      this.isRunning = false;
      this.isPaused = false;
      this.currentConfig = null;
      
      this.emit('miningStopped');
      this.logger?.success('✅ Mining stopped successfully');
      
    } catch (error) {
      this.logger?.error('❌ Error stopping mining:', error);
      throw error;
    }
  }

  async pauseMining(): Promise<void> {
    if (!this.isRunning || this.isPaused) {
      return;
    }

    this.logger?.info('⏸️ Pausing mining...');
    this.isPaused = true;
    
    // Note: 実際の実装では、マイナーを一時停止する機能を追加
    this.emit('miningPaused');
  }

  async resumeMining(): Promise<void> {
    if (!this.isRunning || !this.isPaused) {
      return;
    }

    this.logger?.info('▶️ Resuming mining...');
    this.isPaused = false;
    
    // Note: 実際の実装では、マイナーを再開する機能を追加
    this.emit('miningResumed');
  }

  private startStatsUpdate(): void {
    this.statsInterval = setInterval(() => {
      if (this.isRunning && !this.isPaused) {
        this.updateStatistics();
        this.emit('statisticsUpdate', this.statistics);
      }
    }, 5000); // 5秒間隔で統計更新
  }

  private stopStatsUpdate(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = undefined;
    }
  }

  private updateStatistics(): void {
    if (!this.isRunning) return;

    // Update uptime
    this.statistics.uptime = Math.floor((Date.now() - this.startTime) / 1000);
    
    // Update efficiency (hash/watt)
    if (this.statistics.power > 0) {
      this.statistics.efficiency = this.statistics.hashrate / this.statistics.power;
    }
    
    // Simulate temperature (実際の実装では、ハードウェアから取得)
    this.statistics.temperature = 65 + Math.random() * 20; // 65-85°C
    
    // Simulate power consumption (実際の実装では、ハードウェアから取得)
    if (this.currentConfig) {
      const algorithm = Object.values(SUPPORTED_ALGORITHMS).find(
        alg => alg.name === this.currentConfig!.algorithm || alg.currency === this.currentConfig!.currency
      );
      
      if (algorithm) {
        switch (algorithm.hardware) {
          case 'CPU':
            this.statistics.power = 65; // CPU power
            break;
          case 'GPU':
            this.statistics.power = 250; // GPU power
            break;
          case 'ASIC':
            this.statistics.power = 3250; // ASIC power
            break;
        }
      }
    }
  }

  // Getters
  getStatistics(): MiningStatistics {
    return { ...this.statistics };
  }

  getCurrentConfig(): MiningConfig | null {
    return this.currentConfig ? { ...this.currentConfig } : null;
  }

  getHashrate(): number {
    return this.statistics.hashrate;
  }

  isActive(): boolean {
    return this.isRunning && !this.isPaused;
  }

  getSupportedAlgorithms(): typeof SUPPORTED_ALGORITHMS {
    return SUPPORTED_ALGORITHMS;
  }

  // Algorithm-specific optimizations
  async optimizeForAlgorithm(algorithm: string): Promise<any> {
    const alg = Object.values(SUPPORTED_ALGORITHMS).find(a => a.name === algorithm);
    if (!alg) {
      throw new Error(`Unknown algorithm: ${algorithm}`);
    }

    const optimizations = {
      intensity: 'high',
      threads: this.getOptimalThreadCount(),
      difficulty: alg.difficulty,
      target: alg.blockTime
    };

    this.logger?.info(`🎯 Algorithm optimizations for ${algorithm}:`, optimizations);
    return optimizations;
  }

  async shutdown(): Promise<void> {
    this.logger?.info('🔄 Shutting down Mining Engine...');
    
    try {
      if (this.isRunning) {
        await this.stopMining();
      }
      
      this.removeAllListeners();
      this.logger?.success('✅ Mining Engine shutdown complete');
      
    } catch (error) {
      this.logger?.error('❌ Error during Mining Engine shutdown:', error);
      throw error;
    }
  }
}
