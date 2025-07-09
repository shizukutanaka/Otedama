/**
 * Multi-Algorithm Mining Manager
 * Following Carmack/Martin/Pike principles:
 * - Clean algorithm abstraction
 * - Efficient switching mechanism
 * - Simple configuration
 */

import { EventEmitter } from 'events';
import { CPUMiner } from './cpu-miner';
import { GPUMiner } from './gpu-miner';
import { ASICMiner } from './asic-miner';
import * as crypto from 'crypto';

interface Algorithm {
  name: string;
  family: 'sha' | 'scrypt' | 'ethash' | 'cryptonight' | 'x11' | 'equihash';
  memory: number; // Memory requirement in MB
  compatibility: {
    cpu: boolean;
    gpu: boolean;
    asic: boolean;
  };
  params: Record<string, any>;
}

interface MiningProfile {
  algorithm: string;
  intensity: number;
  threads?: number;
  workSize?: number;
}

interface ProfitabilityData {
  algorithm: string;
  difficulty: number;
  blockReward: number;
  price: number;
  hashRate: number;
  powerCost: number;
  profitPerDay: number;
}

export class MultiAlgorithmMiner extends EventEmitter {
  private algorithms: Map<string, Algorithm> = new Map();
  private currentAlgorithm?: Algorithm;
  private miners: {
    cpu?: CPUMiner;
    gpu?: GPUMiner;
    asic?: ASICMiner;
  } = {};
  private isRunning = false;
  private autoSwitch = false;
  private switchInterval?: NodeJS.Timer;
  private profitabilityData: Map<string, ProfitabilityData> = new Map();

  constructor() {
    super();
    this.initializeAlgorithms();
  }

  /**
   * Initialize supported algorithms
   */
  private initializeAlgorithms(): void {
    // SHA256 (Bitcoin)
    this.algorithms.set('sha256', {
      name: 'sha256',
      family: 'sha',
      memory: 0,
      compatibility: { cpu: true, gpu: true, asic: true },
      params: { rounds: 2 }
    });

    // Scrypt (Litecoin)
    this.algorithms.set('scrypt', {
      name: 'scrypt',
      family: 'scrypt',
      memory: 128,
      compatibility: { cpu: true, gpu: true, asic: true },
      params: { N: 1024, r: 1, p: 1 }
    });

    // Ethash (Ethereum)
    this.algorithms.set('ethash', {
      name: 'ethash',
      family: 'ethash',
      memory: 4096,
      compatibility: { cpu: false, gpu: true, asic: true },
      params: { dagSize: 4096, epochs: 1 }
    });

    // RandomX (Monero)
    this.algorithms.set('randomx', {
      name: 'randomx',
      family: 'cryptonight',
      memory: 2048,
      compatibility: { cpu: true, gpu: false, asic: false },
      params: { threads: 1, initThreads: 1 }
    });

    // X11
    this.algorithms.set('x11', {
      name: 'x11',
      family: 'x11',
      memory: 0,
      compatibility: { cpu: true, gpu: true, asic: true },
      params: { chainedHashes: 11 }
    });

    // Equihash (Zcash)
    this.algorithms.set('equihash', {
      name: 'equihash',
      family: 'equihash',
      memory: 144,
      compatibility: { cpu: true, gpu: true, asic: true },
      params: { n: 200, k: 9 }
    });

    // CryptoNight
    this.algorithms.set('cryptonight', {
      name: 'cryptonight',
      family: 'cryptonight',
      memory: 2,
      compatibility: { cpu: true, gpu: true, asic: false },
      params: { variant: 2 }
    });

    // Blake2s
    this.algorithms.set('blake2s', {
      name: 'blake2s',
      family: 'sha',
      memory: 0,
      compatibility: { cpu: true, gpu: true, asic: false },
      params: { outputLength: 32 }
    });

    // Argon2
    this.algorithms.set('argon2', {
      name: 'argon2',
      family: 'scrypt',
      memory: 64,
      compatibility: { cpu: true, gpu: false, asic: false },
      params: { timeCost: 3, memoryCost: 65536, parallelism: 1 }
    });
  }

  /**
   * Get available algorithms
   */
  getAvailableAlgorithms(): Algorithm[] {
    return Array.from(this.algorithms.values());
  }

  /**
   * Get compatible algorithms for hardware
   */
  getCompatibleAlgorithms(hardware: 'cpu' | 'gpu' | 'asic'): Algorithm[] {
    return Array.from(this.algorithms.values())
      .filter(algo => algo.compatibility[hardware]);
  }

  /**
   * Set current algorithm
   */
  async setAlgorithm(algorithmName: string): Promise<void> {
    const algorithm = this.algorithms.get(algorithmName);
    if (!algorithm) {
      throw new Error(`Unknown algorithm: ${algorithmName}`);
    }

    const wasRunning = this.isRunning;
    
    if (wasRunning) {
      await this.stop();
    }

    this.currentAlgorithm = algorithm;
    this.emit('algorithmChanged', algorithm);

    if (wasRunning) {
      await this.start();
    }
  }

  /**
   * Initialize miners based on available hardware
   */
  async initializeMiners(): Promise<void> {
    // Initialize CPU miner
    try {
      this.miners.cpu = new CPUMiner({
        autoTune: true
      });
      
      this.miners.cpu.on('share', (share) => {
        this.emit('share', { type: 'cpu', ...share });
      });
      
      this.miners.cpu.on('error', (error) => {
        this.emit('error', { type: 'cpu', error });
      });
    } catch (error) {
      this.emit('warning', { message: 'CPU mining not available', error });
    }

    // Initialize GPU miner
    try {
      this.miners.gpu = new GPUMiner({
        autoTune: true
      });
      
      await this.miners.gpu.initialize();
      
      this.miners.gpu.on('share', (share) => {
        this.emit('share', { type: 'gpu', ...share });
      });
      
      this.miners.gpu.on('error', (error) => {
        this.emit('error', { type: 'gpu', error });
      });
    } catch (error) {
      this.emit('warning', { message: 'GPU mining not available', error });
    }

    // Initialize ASIC miner
    try {
      this.miners.asic = new ASICMiner({
        autoDetect: true
      });
      
      await this.miners.asic.initialize();
      
      this.miners.asic.on('share', (share) => {
        this.emit('share', { type: 'asic', ...share });
      });
      
      this.miners.asic.on('error', (error) => {
        this.emit('error', { type: 'asic', error });
      });
    } catch (error) {
      this.emit('warning', { message: 'ASIC mining not available', error });
    }
  }

  /**
   * Start mining
   */
  async start(): Promise<void> {
    if (!this.currentAlgorithm) {
      throw new Error('No algorithm selected');
    }

    this.isRunning = true;

    // Start compatible miners
    const startPromises: Promise<void>[] = [];

    if (this.currentAlgorithm.compatibility.cpu && this.miners.cpu) {
      startPromises.push(this.miners.cpu.start({
        id: crypto.randomBytes(16).toString('hex'),
        algorithm: this.currentAlgorithm.name as any,
        blob: Buffer.alloc(32),
        target: Buffer.alloc(32),
        height: 0
      }));
    }

    if (this.currentAlgorithm.compatibility.gpu && this.miners.gpu) {
      startPromises.push(this.miners.gpu.start({
        id: crypto.randomBytes(16).toString('hex'),
        algorithm: this.currentAlgorithm.name,
        kernel: this.getKernelForAlgorithm(this.currentAlgorithm.name),
        blob: Buffer.alloc(32),
        target: Buffer.alloc(32),
        workSize: 256 * 1024,
        intensity: 80
      }));
    }

    if (this.currentAlgorithm.compatibility.asic && this.miners.asic) {
      startPromises.push(this.miners.asic.start(
        'stratum+tcp://pool.example.com:3333',
        'username',
        'password'
      ));
    }

    await Promise.all(startPromises);

    this.emit('start', { algorithm: this.currentAlgorithm.name });
  }

  /**
   * Stop mining
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    const stopPromises: Promise<void>[] = [];

    if (this.miners.cpu) {
      stopPromises.push(this.miners.cpu.stop());
    }

    if (this.miners.gpu) {
      stopPromises.push(this.miners.gpu.stop());
    }

    if (this.miners.asic) {
      stopPromises.push(this.miners.asic.stop());
    }

    await Promise.all(stopPromises);

    this.emit('stop');
  }

  /**
   * Enable automatic algorithm switching
   */
  enableAutoSwitch(intervalMinutes: number = 30): void {
    this.autoSwitch = true;

    // Clear existing interval
    if (this.switchInterval) {
      clearInterval(this.switchInterval);
    }

    // Check profitability immediately
    this.checkProfitability();

    // Set up periodic checks
    this.switchInterval = setInterval(() => {
      this.checkProfitability();
    }, intervalMinutes * 60 * 1000);

    this.emit('autoSwitchEnabled', { interval: intervalMinutes });
  }

  /**
   * Disable automatic algorithm switching
   */
  disableAutoSwitch(): void {
    this.autoSwitch = false;

    if (this.switchInterval) {
      clearInterval(this.switchInterval);
      this.switchInterval = undefined;
    }

    this.emit('autoSwitchDisabled');
  }

  /**
   * Update profitability data
   */
  updateProfitabilityData(data: ProfitabilityData[]): void {
    this.profitabilityData.clear();
    
    for (const item of data) {
      this.profitabilityData.set(item.algorithm, item);
    }

    if (this.autoSwitch) {
      this.checkProfitability();
    }
  }

  /**
   * Check profitability and switch if needed
   */
  private async checkProfitability(): Promise<void> {
    if (!this.autoSwitch || this.profitabilityData.size === 0) {
      return;
    }

    // Find most profitable algorithm
    let bestAlgorithm: string | null = null;
    let bestProfit = -Infinity;

    for (const [algo, data] of this.profitabilityData) {
      // Check if we support this algorithm
      if (!this.algorithms.has(algo)) {
        continue;
      }

      // Check if we have compatible hardware
      const algorithm = this.algorithms.get(algo)!;
      const hasCompatibleHardware = 
        (algorithm.compatibility.cpu && this.miners.cpu) ||
        (algorithm.compatibility.gpu && this.miners.gpu) ||
        (algorithm.compatibility.asic && this.miners.asic);

      if (!hasCompatibleHardware) {
        continue;
      }

      if (data.profitPerDay > bestProfit) {
        bestProfit = data.profitPerDay;
        bestAlgorithm = algo;
      }
    }

    // Switch if different and more profitable
    if (bestAlgorithm && bestAlgorithm !== this.currentAlgorithm?.name) {
      const improvement = this.currentAlgorithm 
        ? ((bestProfit - (this.profitabilityData.get(this.currentAlgorithm.name)?.profitPerDay || 0)) / 
           (this.profitabilityData.get(this.currentAlgorithm.name)?.profitPerDay || 1)) * 100
        : 100;

      // Only switch if improvement is significant (>5%)
      if (improvement > 5) {
        this.emit('switchingAlgorithm', {
          from: this.currentAlgorithm?.name,
          to: bestAlgorithm,
          improvement: improvement.toFixed(2) + '%'
        });

        await this.setAlgorithm(bestAlgorithm);
      }
    }
  }

  /**
   * Get kernel for algorithm
   */
  private getKernelForAlgorithm(algorithm: string): string {
    // This would return the appropriate GPU kernel
    // Simplified for demonstration
    return `${algorithm}_kernel`;
  }

  /**
   * Get current statistics
   */
  getStats(): {
    algorithm: string;
    hashRates: {
      cpu?: number;
      gpu?: number;
      asic?: number;
      total: number;
    };
    profitability?: number;
  } {
    const hashRates = {
      cpu: this.miners.cpu?.getHashRate(),
      gpu: this.miners.gpu?.getHashRate(),
      asic: this.miners.asic?.getTotalHashRate(),
      total: 0
    };

    hashRates.total = (hashRates.cpu || 0) + (hashRates.gpu || 0) + (hashRates.asic || 0);

    return {
      algorithm: this.currentAlgorithm?.name || 'none',
      hashRates,
      profitability: this.currentAlgorithm 
        ? this.profitabilityData.get(this.currentAlgorithm.name)?.profitPerDay
        : undefined
    };
  }

  /**
   * Benchmark all algorithms
   */
  async benchmark(duration: number = 60): Promise<Map<string, number>> {
    const results = new Map<string, number>();
    const originalAlgorithm = this.currentAlgorithm?.name;

    for (const [name, algorithm] of this.algorithms) {
      this.emit('benchmarking', { algorithm: name });

      try {
        await this.setAlgorithm(name);
        await this.start();

        // Run for specified duration
        await new Promise(resolve => setTimeout(resolve, duration * 1000));

        const stats = this.getStats();
        results.set(name, stats.hashRates.total);

        await this.stop();
      } catch (error) {
        this.emit('benchmarkError', { algorithm: name, error });
        results.set(name, 0);
      }
    }

    // Restore original algorithm
    if (originalAlgorithm) {
      await this.setAlgorithm(originalAlgorithm);
    }

    this.emit('benchmarkComplete', { results });
    return results;
  }
}

/**
 * Algorithm-specific hash functions
 */
export class HashFunctions {
  static sha256(data: Buffer): Buffer {
    return crypto.createHash('sha256').update(data).digest();
  }

  static sha256d(data: Buffer): Buffer {
    return this.sha256(this.sha256(data));
  }

  static scrypt(data: Buffer, params: any): Buffer {
    return crypto.scryptSync(data, 'salt', 32, {
      N: params.N || 1024,
      r: params.r || 1,
      p: params.p || 1
    });
  }

  static blake2s(data: Buffer): Buffer {
    // Simplified - would use actual blake2s implementation
    return crypto.createHash('sha256').update(data).digest();
  }

  static x11(data: Buffer): Buffer {
    // X11 uses 11 different hash functions in sequence
    const algorithms = [
      'blake', 'bmw', 'groestl', 'jh', 'keccak',
      'skein', 'luffa', 'cubehash', 'shavite', 'simd', 'echo'
    ];

    let hash = data;
    for (const algo of algorithms) {
      // Simplified - each would be a different hash function
      hash = crypto.createHash('sha512').update(hash).digest();
    }

    return hash.slice(0, 32);
  }
}

// Export types
export { Algorithm, MiningProfile, ProfitabilityData };
