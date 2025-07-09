/**
 * Hardware-specific Performance Optimization
 * Following Carmack/Martin/Pike principles:
 * - Hardware-aware optimizations
 * - Data-oriented design
 * - Cache-friendly algorithms
 * - Zero-copy where possible
 */

import { EventEmitter } from 'events';
import * as os from 'os';
import { Worker } from 'worker_threads';
import { HardwareDetector, HardwareProfile, CPUInfo, GPUInfo } from '../hardware/hardware-detector';
import { logger } from '../utils/logger';

interface OptimizationProfile {
  cpu: CPUOptimizations;
  gpu: GPUOptimizations;
  memory: MemoryOptimizations;
  network: NetworkOptimizations;
}

interface CPUOptimizations {
  threads: number;
  affinity: number[];
  priority: 'realtime' | 'high' | 'normal' | 'low';
  prefetch: boolean;
  simd: boolean;
  cache: {
    lineSize: number;
    l1Size: number;
    l2Size: number;
    l3Size: number;
    sharing: 'exclusive' | 'shared';
  };
}

interface GPUOptimizations {
  devices: number[];
  batchSize: number;
  blockSize: number;
  gridSize: number;
  sharedMemory: number;
  registers: number;
  streams: number;
  asyncMode: boolean;
}

interface MemoryOptimizations {
  hugepages: boolean;
  numa: boolean;
  alignment: number;
  poolSize: number;
  prefaultPages: boolean;
  lockPages: boolean;
}

interface NetworkOptimizations {
  socketBufferSize: number;
  tcpNoDelay: boolean;
  keepAlive: boolean;
  reuseAddr: boolean;
  ipv6: boolean;
  multicast: boolean;
}

export class HardwareSpecificOptimizer extends EventEmitter {
  private hardwareDetector: HardwareDetector;
  private profile?: HardwareProfile;
  private optimizations?: OptimizationProfile;
  private workers: Map<string, Worker> = new Map();

  constructor() {
    super();
    this.hardwareDetector = new HardwareDetector();
  }

  /**
   * Initialize optimizer with hardware detection
   */
  async initialize(): Promise<void> {
    logger.info('Initializing hardware-specific optimizer');
    
    this.profile = await this.hardwareDetector.detect();
    this.optimizations = this.generateOptimizations(this.profile);
    
    await this.applyOptimizations();
    
    logger.info('Hardware-specific optimizations applied', {
      cpu: this.profile.cpu.model,
      gpus: this.profile.gpus.length,
      memory: `${(this.profile.memory.total / 1024 / 1024 / 1024).toFixed(2)} GB`
    });
  }

  /**
   * Generate optimization profile based on hardware
   */
  private generateOptimizations(profile: HardwareProfile): OptimizationProfile {
    return {
      cpu: this.generateCPUOptimizations(profile.cpu),
      gpu: this.generateGPUOptimizations(profile.gpus),
      memory: this.generateMemoryOptimizations(profile.memory, profile.cpu),
      network: this.generateNetworkOptimizations()
    };
  }

  /**
   * Generate CPU-specific optimizations
   */
  private generateCPUOptimizations(cpu: CPUInfo): CPUOptimizations {
    const opt: CPUOptimizations = {
      threads: this.calculateOptimalThreads(cpu),
      affinity: this.calculateCPUAffinity(cpu),
      priority: 'high',
      prefetch: true,
      simd: this.checkSIMDSupport(cpu),
      cache: {
        lineSize: 64, // Standard cache line size
        l1Size: cpu.cache.l1,
        l2Size: cpu.cache.l2,
        l3Size: cpu.cache.l3,
        sharing: cpu.threads > cpu.cores ? 'shared' : 'exclusive'
      }
    };

    // Intel-specific optimizations
    if (cpu.vendor === 'Intel') {
      opt.prefetch = true;
      // Intel CPUs benefit from hyperthreading for mining
      opt.threads = cpu.threads;
    }
    
    // AMD-specific optimizations
    else if (cpu.vendor === 'AMD') {
      // AMD Ryzen benefits from CCX-aware thread allocation
      if (cpu.model.includes('Ryzen')) {
        opt.affinity = this.calculateRyzenAffinity(cpu);
      }
    }
    
    // ARM-specific optimizations
    else if (cpu.vendor === 'ARM') {
      // ARM processors have different cache hierarchies
      opt.cache.lineSize = 128; // Some ARM processors use 128-byte cache lines
    }

    return opt;
  }

  /**
   * Calculate optimal thread count for mining
   */
  private calculateOptimalThreads(cpu: CPUInfo): number {
    // Leave one thread for system operations
    let threads = cpu.threads - 1;
    
    // For RandomX, use all physical cores
    if (cpu.features.includes('aes')) {
      threads = cpu.cores;
    }
    
    // Ensure at least 1 thread
    return Math.max(1, threads);
  }

  /**
   * Calculate CPU affinity for optimal cache usage
   */
  private calculateCPUAffinity(cpu: CPUInfo): number[] {
    const affinity: number[] = [];
    
    // Prefer physical cores first
    for (let i = 0; i < cpu.cores; i++) {
      affinity.push(i * 2); // Even numbered CPUs are usually physical cores
    }
    
    // Then add hyperthreads if beneficial
    if (cpu.threads > cpu.cores) {
      for (let i = 0; i < cpu.cores; i++) {
        affinity.push(i * 2 + 1); // Odd numbered CPUs are usually hyperthreads
      }
    }
    
    return affinity;
  }

  /**
   * Calculate Ryzen-specific CCX-aware affinity
   */
  private calculateRyzenAffinity(cpu: CPUInfo): number[] {
    const affinity: number[] = [];
    const coresPerCCX = 4; // Typical for Ryzen
    
    // Group threads by CCX for better cache locality
    for (let ccx = 0; ccx < cpu.cores / coresPerCCX; ccx++) {
      for (let core = 0; core < coresPerCCX; core++) {
        affinity.push(ccx * coresPerCCX + core);
      }
    }
    
    return affinity;
  }

  /**
   * Check SIMD support
   */
  private checkSIMDSupport(cpu: CPUInfo): boolean {
    const simdFeatures = ['avx', 'avx2', 'sse4_1', 'sse4_2', 'ssse3'];
    return simdFeatures.some(feature => cpu.features.includes(feature));
  }

  /**
   * Generate GPU-specific optimizations
   */
  private generateGPUOptimizations(gpus: GPUInfo[]): GPUOptimizations {
    const opt: GPUOptimizations = {
      devices: gpus.map(g => g.id),
      batchSize: 1024,
      blockSize: 256,
      gridSize: 1024,
      sharedMemory: 48 * 1024, // 48KB default
      registers: 32,
      streams: 2,
      asyncMode: true
    };

    if (gpus.length === 0) {
      return opt;
    }

    // NVIDIA-specific optimizations
    const nvidiaGPUs = gpus.filter(g => g.vendor === 'nvidia');
    if (nvidiaGPUs.length > 0) {
      const gpu = nvidiaGPUs[0];
      
      // Compute capability based optimizations
      if (gpu.computeCapability) {
        const [major, minor] = gpu.computeCapability.split('.').map(Number);
        
        // Ampere (8.x)
        if (major >= 8) {
          opt.blockSize = 512;
          opt.sharedMemory = 164 * 1024; // 164KB on Ampere
          opt.registers = 65536;
          opt.streams = 4;
        }
        // Turing (7.5)
        else if (major === 7 && minor >= 5) {
          opt.blockSize = 256;
          opt.sharedMemory = 64 * 1024;
          opt.registers = 65536;
          opt.streams = 2;
        }
        // Pascal (6.x)
        else if (major === 6) {
          opt.blockSize = 128;
          opt.sharedMemory = 48 * 1024;
          opt.registers = 32768;
        }
      }

      // Memory-based optimizations
      if (gpu.memory) {
        // Larger batch sizes for GPUs with more memory
        if (gpu.memory >= 8192) {
          opt.batchSize = 4096;
          opt.gridSize = 2048;
        } else if (gpu.memory >= 4096) {
          opt.batchSize = 2048;
          opt.gridSize = 1024;
        }
      }
    }

    // AMD-specific optimizations
    const amdGPUs = gpus.filter(g => g.vendor === 'amd');
    if (amdGPUs.length > 0) {
      opt.blockSize = 64; // AMD GPUs often prefer smaller workgroups
      opt.sharedMemory = 32 * 1024; // LDS size
      
      // RDNA optimizations
      if (amdGPUs[0].model.includes('RX 6') || amdGPUs[0].model.includes('RX 7')) {
        opt.blockSize = 128;
        opt.streams = 4;
      }
    }

    return opt;
  }

  /**
   * Generate memory-specific optimizations
   */
  private generateMemoryOptimizations(memory: any, cpu: CPUInfo): MemoryOptimizations {
    const totalMemoryGB = memory.total / 1024 / 1024 / 1024;
    
    const opt: MemoryOptimizations = {
      hugepages: totalMemoryGB >= 8 && os.platform() === 'linux',
      numa: cpu.cores >= 16 && os.platform() === 'linux',
      alignment: 64, // Cache line alignment
      poolSize: Math.min(memory.total * 0.7, 32 * 1024 * 1024 * 1024), // Max 32GB
      prefaultPages: totalMemoryGB >= 16,
      lockPages: os.platform() === 'linux' && totalMemoryGB >= 32
    };

    // NUMA optimizations for multi-socket systems
    if (opt.numa) {
      // Would check /sys/devices/system/node/ on Linux
    }

    return opt;
  }

  /**
   * Generate network-specific optimizations
   */
  private generateNetworkOptimizations(): NetworkOptimizations {
    return {
      socketBufferSize: 4 * 1024 * 1024, // 4MB socket buffers
      tcpNoDelay: true, // Disable Nagle's algorithm for low latency
      keepAlive: true,
      reuseAddr: true,
      ipv6: true,
      multicast: false
    };
  }

  /**
   * Apply all optimizations
   */
  private async applyOptimizations(): Promise<void> {
    if (!this.optimizations) return;

    await Promise.all([
      this.applyCPUOptimizations(),
      this.applyGPUOptimizations(),
      this.applyMemoryOptimizations(),
      this.applyNetworkOptimizations()
    ]);
  }

  /**
   * Apply CPU optimizations
   */
  private async applyCPUOptimizations(): Promise<void> {
    if (!this.optimizations?.cpu) return;

    const opt = this.optimizations.cpu;

    // Set process priority
    if (os.platform() === 'win32') {
      try {
        const priority = {
          realtime: 24,
          high: 13,
          normal: 8,
          low: 4
        }[opt.priority];
        
        process.priority = priority;
      } catch (err) {
        logger.warn('Failed to set process priority', { error: err });
      }
    } else if (os.platform() === 'linux') {
      try {
        const { exec } = require('child_process');
        const nice = {
          realtime: -20,
          high: -10,
          normal: 0,
          low: 10
        }[opt.priority];
        
        exec(`renice -n ${nice} -p ${process.pid}`);
      } catch (err) {
        logger.warn('Failed to set process nice value', { error: err });
      }
    }

    // Apply CPU affinity
    if (os.platform() === 'linux' && opt.affinity.length > 0) {
      try {
        const taskset = require('taskset');
        taskset.setAffinity(process.pid, opt.affinity);
      } catch (err) {
        logger.warn('Failed to set CPU affinity', { error: err });
      }
    }

    this.emit('cpu:optimized', opt);
  }

  /**
   * Apply GPU optimizations
   */
  private async applyGPUOptimizations(): Promise<void> {
    if (!this.optimizations?.gpu || this.optimizations.gpu.devices.length === 0) return;

    const opt = this.optimizations.gpu;

    // Set CUDA environment variables for NVIDIA GPUs
    if (this.profile?.gpus.some(g => g.vendor === 'nvidia')) {
      process.env.CUDA_CACHE_DISABLE = '0';
      process.env.CUDA_CACHE_MAXSIZE = '268435456'; // 256MB
      process.env.CUDA_LAUNCH_BLOCKING = opt.asyncMode ? '0' : '1';
      process.env.CUDA_DEVICE_ORDER = 'PCI_BUS_ID';
    }

    // Set ROCm environment variables for AMD GPUs
    if (this.profile?.gpus.some(g => g.vendor === 'amd')) {
      process.env.HSA_ENABLE_SDMA = '1';
      process.env.GPU_MAX_HEAP_SIZE = '100';
      process.env.GPU_MAX_ALLOC_PERCENT = '100';
    }

    this.emit('gpu:optimized', opt);
  }

  /**
   * Apply memory optimizations
   */
  private async applyMemoryOptimizations(): Promise<void> {
    if (!this.optimizations?.memory) return;

    const opt = this.optimizations.memory;

    // Enable transparent hugepages on Linux
    if (opt.hugepages && os.platform() === 'linux') {
      try {
        const { exec } = require('child_process');
        exec('echo always > /sys/kernel/mm/transparent_hugepage/enabled');
        exec('echo always > /sys/kernel/mm/transparent_hugepage/defrag');
      } catch (err) {
        logger.warn('Failed to enable hugepages', { error: err });
      }
    }

    // Lock pages in memory
    if (opt.lockPages && os.platform() === 'linux') {
      try {
        const { exec } = require('child_process');
        exec(`ulimit -l ${opt.poolSize / 1024}`); // Convert to KB
      } catch (err) {
        logger.warn('Failed to lock pages', { error: err });
      }
    }

    this.emit('memory:optimized', opt);
  }

  /**
   * Apply network optimizations
   */
  private async applyNetworkOptimizations(): Promise<void> {
    if (!this.optimizations?.network) return;

    const opt = this.optimizations.network;

    // These would typically be applied when creating sockets
    // Store them for use by network components
    process.env.SOCKET_BUFFER_SIZE = opt.socketBufferSize.toString();
    process.env.TCP_NODELAY = opt.tcpNoDelay ? '1' : '0';
    process.env.SO_KEEPALIVE = opt.keepAlive ? '1' : '0';
    process.env.SO_REUSEADDR = opt.reuseAddr ? '1' : '0';

    this.emit('network:optimized', opt);
  }

  /**
   * Create optimized worker for specific algorithm
   */
  async createOptimizedWorker(algorithm: string, options: any = {}): Promise<Worker> {
    const workerData = {
      algorithm,
      optimizations: this.optimizations,
      hardware: this.profile,
      ...options
    };

    const worker = new Worker(
      `${__dirname}/workers/${algorithm}-worker.js`,
      { workerData }
    );

    // Apply worker-specific optimizations
    if (this.optimizations?.cpu.affinity.length > 0) {
      // Would set worker thread affinity here
    }

    this.workers.set(algorithm, worker);
    return worker;
  }

  /**
   * Get optimization recommendations
   */
  getRecommendations(): string[] {
    const recommendations: string[] = [];

    if (!this.profile) {
      return ['Run hardware detection first'];
    }

    // CPU recommendations
    if (this.profile.cpu.features.includes('aes')) {
      recommendations.push('CPU supports AES-NI, recommended for RandomX mining');
    }

    if (this.profile.cpu.threads > this.profile.cpu.cores) {
      recommendations.push('Hyperthreading detected, may reduce efficiency for some algorithms');
    }

    // GPU recommendations
    if (this.profile.gpus.length === 0) {
      recommendations.push('No GPUs detected, limited to CPU mining algorithms');
    } else {
      for (const gpu of this.profile.gpus) {
        if (gpu.memory && gpu.memory < 4096) {
          recommendations.push(`GPU ${gpu.id} has limited memory (${gpu.memory}MB), may not support all algorithms`);
        }
      }
    }

    // Memory recommendations
    const memoryGB = this.profile.memory.total / 1024 / 1024 / 1024;
    if (memoryGB < 8) {
      recommendations.push('Low system memory, may limit mining performance');
    }

    if (memoryGB >= 32 && os.platform() === 'linux') {
      recommendations.push('Consider enabling hugepages for better performance');
    }

    return recommendations;
  }

  /**
   * Get current optimization profile
   */
  getOptimizations(): OptimizationProfile | undefined {
    return this.optimizations;
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    // Terminate all workers
    for (const [algo, worker] of this.workers) {
      await worker.terminate();
    }
    this.workers.clear();

    // Stop hardware monitoring
    this.hardwareDetector.stopMonitoring();
  }
}

// Export types
export { OptimizationProfile, CPUOptimizations, GPUOptimizations, MemoryOptimizations, NetworkOptimizations };
