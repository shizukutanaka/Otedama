/**
 * Hardware Performance Optimizer
 * Following Carmack/Martin/Pike principles:
 * - Adaptive optimization based on real performance
 * - Simple and effective tuning algorithms
 * - Minimal overhead monitoring
 */

import { EventEmitter } from 'events';
import { HardwareDetector, HardwareProfile } from '../hardware/hardware-detector';
import { MultiAlgorithmMiner } from '../mining/multi-algorithm-miner';
import { CPUMiner } from '../mining/cpu-miner';
import { GPUMiner } from '../mining/gpu-miner';
import * as os from 'os';

interface PerformanceProfile {
  hardware: string;
  algorithm: string;
  settings: OptimizationSettings;
  hashRate: number;
  powerConsumption: number;
  efficiency: number; // Hash per watt
  temperature: number;
  stability: number; // 0-100 score
  timestamp: number;
}

interface OptimizationSettings {
  // CPU settings
  cpuThreads?: number;
  cpuAffinity?: number[];
  cpuIntensity?: number;
  cpuPriority?: number;
  
  // GPU settings
  gpuIntensity?: number;
  gpuWorkSize?: number;
  gpuThreads?: number;
  memoryClockOffset?: number;
  coreClockOffset?: number;
  powerLimit?: number;
  
  // Memory settings
  memoryReserve?: number;
  hugePagesEnabled?: boolean;
  
  // General settings
  temperatureTarget?: number;
  autoFanControl?: boolean;
}

interface OptimizationResult {
  profile: PerformanceProfile;
  improvement: number; // Percentage improvement
  stable: boolean;
}

export class PerformanceOptimizer extends EventEmitter {
  private hardwareDetector: HardwareDetector;
  private miner?: MultiAlgorithmMiner;
  private profiles: Map<string, PerformanceProfile[]> = new Map();
  private currentSettings: Map<string, OptimizationSettings> = new Map();
  private isOptimizing = false;
  private monitoringInterval?: NodeJS.Timer;

  constructor() {
    super();
    this.hardwareDetector = new HardwareDetector();
  }

  /**
   * Initialize optimizer
   */
  async initialize(): Promise<void> {
    // Detect hardware
    const hardware = await this.hardwareDetector.detect();
    
    // Load existing profiles
    await this.loadProfiles();
    
    // Apply best known settings
    this.applyBestSettings(hardware);
    
    this.emit('initialized', { hardware });
  }

  /**
   * Optimize for specific algorithm
   */
  async optimizeAlgorithm(
    algorithm: string,
    duration: number = 300 // 5 minutes per test
  ): Promise<OptimizationResult> {
    this.isOptimizing = true;
    this.emit('optimization:start', { algorithm });
    
    const hardware = await this.hardwareDetector.detect();
    const baselineProfile = await this.measureBaseline(algorithm, duration);
    
    let bestProfile = baselineProfile;
    let bestImprovement = 0;
    
    // Try different optimization strategies
    const strategies = this.generateOptimizationStrategies(hardware, algorithm);
    
    for (const [name, settings] of strategies) {
      this.emit('optimization:testing', { strategy: name, settings });
      
      try {
        const profile = await this.testSettings(algorithm, settings, duration);
        const improvement = ((profile.hashRate - baselineProfile.hashRate) / baselineProfile.hashRate) * 100;
        
        if (profile.stability >= 95 && improvement > bestImprovement) {
          bestProfile = profile;
          bestImprovement = improvement;
        }
        
        this.emit('optimization:progress', {
          strategy: name,
          hashRate: profile.hashRate,
          improvement,
          stability: profile.stability
        });
      } catch (error) {
        this.emit('optimization:error', { strategy: name, error });
      }
    }
    
    // Save best profile
    this.saveProfile(bestProfile);
    
    this.isOptimizing = false;
    this.emit('optimization:complete', { profile: bestProfile, improvement: bestImprovement });
    
    return {
      profile: bestProfile,
      improvement: bestImprovement,
      stable: bestProfile.stability >= 95
    };
  }

  /**
   * Auto-tune all hardware
   */
  async autoTune(): Promise<Map<string, OptimizationResult>> {
    const results = new Map<string, OptimizationResult>();
    const hardware = await this.hardwareDetector.detect();
    
    // Get supported algorithms
    const algorithms = Object.entries(hardware.capabilities.algorithms)
      .filter(([_, info]) => info.supported)
      .map(([algo]) => algo);
    
    for (const algorithm of algorithms) {
      this.emit('autotune:algorithm', { algorithm });
      
      try {
        const result = await this.optimizeAlgorithm(algorithm, 120); // 2 minutes quick tune
        results.set(algorithm, result);
      } catch (error) {
        this.emit('autotune:error', { algorithm, error });
      }
    }
    
    this.emit('autotune:complete', { results });
    return results;
  }

  /**
   * Measure baseline performance
   */
  private async measureBaseline(algorithm: string, duration: number): Promise<PerformanceProfile> {
    const hardware = await this.hardwareDetector.detect();
    const defaultSettings = this.getDefaultSettings(hardware);
    
    return this.testSettings(algorithm, defaultSettings, duration);
  }

  /**
   * Test specific settings
   */
  private async testSettings(
    algorithm: string,
    settings: OptimizationSettings,
    duration: number
  ): Promise<PerformanceProfile> {
    // Apply settings
    await this.applySettings(settings);
    
    // Start mining
    if (!this.miner) {
      this.miner = new MultiAlgorithmMiner();
      await this.miner.initializeMiners();
    }
    
    await this.miner.setAlgorithm(algorithm);
    await this.miner.start();
    
    // Collect metrics
    const metrics = await this.collectMetrics(duration);
    
    // Stop mining
    await this.miner.stop();
    
    // Calculate profile
    const profile: PerformanceProfile = {
      hardware: this.getHardwareId(),
      algorithm,
      settings,
      hashRate: metrics.avgHashRate,
      powerConsumption: metrics.avgPower,
      efficiency: metrics.avgHashRate / metrics.avgPower,
      temperature: metrics.avgTemperature,
      stability: metrics.stability,
      timestamp: Date.now()
    };
    
    return profile;
  }

  /**
   * Generate optimization strategies
   */
  private generateOptimizationStrategies(
    hardware: HardwareProfile,
    algorithm: string
  ): Map<string, OptimizationSettings> {
    const strategies = new Map<string, OptimizationSettings>();
    
    // CPU optimization strategies
    if (hardware.capabilities.algorithms[algorithm]?.hardware.includes('cpu')) {
      // Thread count variations
      const maxThreads = hardware.cpu.threads;
      
      strategies.set('cpu_threads_50%', {
        cpuThreads: Math.floor(maxThreads * 0.5),
        cpuIntensity: 100
      });
      
      strategies.set('cpu_threads_75%', {
        cpuThreads: Math.floor(maxThreads * 0.75),
        cpuIntensity: 100
      });
      
      strategies.set('cpu_threads_90%', {
        cpuThreads: Math.floor(maxThreads * 0.9),
        cpuIntensity: 100
      });
      
      // Intensity variations
      strategies.set('cpu_intensity_low', {
        cpuThreads: maxThreads - 1,
        cpuIntensity: 60
      });
      
      strategies.set('cpu_intensity_medium', {
        cpuThreads: maxThreads - 1,
        cpuIntensity: 80
      });
      
      // CPU affinity strategies
      if (hardware.cpu.cores > 1) {
        strategies.set('cpu_affinity_physical', {
          cpuThreads: hardware.cpu.cores,
          cpuAffinity: Array.from({ length: hardware.cpu.cores }, (_, i) => i * 2)
        });
      }
    }
    
    // GPU optimization strategies
    if (hardware.capabilities.algorithms[algorithm]?.hardware.includes('gpu')) {
      // Intensity variations
      strategies.set('gpu_intensity_70', {
        gpuIntensity: 70,
        temperatureTarget: 75
      });
      
      strategies.set('gpu_intensity_85', {
        gpuIntensity: 85,
        temperatureTarget: 80
      });
      
      strategies.set('gpu_intensity_95', {
        gpuIntensity: 95,
        temperatureTarget: 85
      });
      
      // Work size variations
      const baseWorkSize = 256 * 1024;
      
      strategies.set('gpu_worksize_small', {
        gpuWorkSize: baseWorkSize / 2,
        gpuIntensity: 80
      });
      
      strategies.set('gpu_worksize_large', {
        gpuWorkSize: baseWorkSize * 2,
        gpuIntensity: 80
      });
      
      // Memory optimizations
      if (algorithm === 'ethash' || algorithm === 'equihash') {
        strategies.set('gpu_memory_optimized', {
          gpuIntensity: 80,
          memoryReserve: 512 * 1024 * 1024, // 512MB
          hugePagesEnabled: true
        });
      }
    }
    
    // Combined CPU+GPU strategies
    if (hardware.capabilities.algorithms[algorithm]?.hardware.includes('cpu') &&
        hardware.capabilities.algorithms[algorithm]?.hardware.includes('gpu')) {
      strategies.set('hybrid_balanced', {
        cpuThreads: Math.floor(hardware.cpu.threads * 0.25),
        cpuIntensity: 60,
        gpuIntensity: 80
      });
      
      strategies.set('hybrid_gpu_focus', {
        cpuThreads: 1,
        cpuIntensity: 40,
        gpuIntensity: 95
      });
    }
    
    return strategies;
  }

  /**
   * Apply optimization settings
   */
  private async applySettings(settings: OptimizationSettings): Promise<void> {
    // Apply CPU settings
    if (settings.cpuThreads !== undefined) {
      process.env.MINING_CPU_THREADS = String(settings.cpuThreads);
    }
    
    if (settings.cpuIntensity !== undefined) {
      process.env.MINING_CPU_INTENSITY = String(settings.cpuIntensity);
    }
    
    if (settings.cpuPriority !== undefined && os.platform() !== 'win32') {
      try {
        process.nice?.(settings.cpuPriority);
      } catch {
        // Ignore nice errors
      }
    }
    
    // Apply GPU settings
    if (settings.gpuIntensity !== undefined) {
      process.env.MINING_GPU_INTENSITY = String(settings.gpuIntensity);
    }
    
    if (settings.gpuWorkSize !== undefined) {
      process.env.MINING_GPU_WORKSIZE = String(settings.gpuWorkSize);
    }
    
    // Apply memory settings
    if (settings.hugePagesEnabled && os.platform() === 'linux') {
      try {
        // This would require root permissions
        // await execAsync('echo 1024 > /proc/sys/vm/nr_hugepages');
      } catch {
        // Ignore huge pages errors
      }
    }
    
    // Store current settings
    this.currentSettings.set(this.getHardwareId(), settings);
  }

  /**
   * Collect performance metrics
   */
  private async collectMetrics(duration: number): Promise<{
    avgHashRate: number;
    avgPower: number;
    avgTemperature: number;
    stability: number;
  }> {
    const samples: {
      hashRate: number[];
      power: number[];
      temperature: number[];
      errors: number;
    } = {
      hashRate: [],
      power: [],
      temperature: [],
      errors: 0
    };
    
    const startTime = Date.now();
    const sampleInterval = 1000; // 1 second
    
    return new Promise((resolve) => {
      const interval = setInterval(async () => {
        try {
          // Get current metrics
          const stats = this.miner?.getStats();
          if (stats) {
            samples.hashRate.push(stats.hashRates.total);
          }
          
          // Get hardware metrics
          const hardware = this.hardwareDetector.getProfile();
          if (hardware) {
            // CPU temperature
            if (hardware.cpu.temperature) {
              samples.temperature.push(hardware.cpu.temperature);
            }
            
            // GPU temperatures
            for (const gpu of hardware.gpus) {
              if (gpu.temperature) {
                samples.temperature.push(gpu.temperature);
              }
            }
            
            // Estimate power (simplified)
            const cpuPower = (hardware.cpu.threads * 15) * (stats?.hashRates.cpu ? 1 : 0);
            const gpuPower = hardware.gpus.reduce((sum, gpu) => 
              sum + (gpu.powerLimit || 150) * (stats?.hashRates.gpu ? 1 : 0), 0
            );
            samples.power.push(cpuPower + gpuPower);
          }
        } catch (error) {
          samples.errors++;
        }
        
        // Check if done
        if (Date.now() - startTime >= duration * 1000) {
          clearInterval(interval);
          
          // Calculate averages
          const avgHashRate = samples.hashRate.reduce((a, b) => a + b, 0) / samples.hashRate.length || 0;
          const avgPower = samples.power.reduce((a, b) => a + b, 0) / samples.power.length || 1;
          const avgTemperature = samples.temperature.reduce((a, b) => a + b, 0) / samples.temperature.length || 0;
          
          // Calculate stability (based on hash rate variance)
          const hashRateVariance = this.calculateVariance(samples.hashRate);
          const stability = Math.max(0, 100 - (hashRateVariance / avgHashRate) * 100);
          
          resolve({
            avgHashRate,
            avgPower,
            avgTemperature,
            stability
          });
        }
      }, sampleInterval);
    });
  }

  /**
   * Calculate variance
   */
  private calculateVariance(values: number[]): number {
    if (values.length === 0) return 0;
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    
    return Math.sqrt(variance);
  }

  /**
   * Get default settings for hardware
   */
  private getDefaultSettings(hardware: HardwareProfile): OptimizationSettings {
    return {
      cpuThreads: Math.max(1, hardware.cpu.threads - 1),
      cpuIntensity: 80,
      gpuIntensity: 80,
      gpuWorkSize: 256 * 1024,
      temperatureTarget: 80,
      memoryReserve: hardware.memory.total * 0.1 // Reserve 10% of RAM
    };
  }

  /**
   * Apply best known settings
   */
  private applyBestSettings(hardware: HardwareProfile): void {
    const hardwareId = this.getHardwareId();
    
    // Look for best profile for each algorithm
    for (const [algorithm, info] of Object.entries(hardware.capabilities.algorithms)) {
      if (!info.supported) continue;
      
      const profiles = this.profiles.get(`${hardwareId}_${algorithm}`) || [];
      if (profiles.length === 0) continue;
      
      // Find best efficiency profile
      const bestProfile = profiles.reduce((best, current) => 
        current.efficiency > best.efficiency ? current : best
      );
      
      this.currentSettings.set(`${hardwareId}_${algorithm}`, bestProfile.settings);
    }
  }

  /**
   * Get hardware identifier
   */
  private getHardwareId(): string {
    const hardware = this.hardwareDetector.getProfile();
    if (!hardware) return 'unknown';
    
    const cpuId = hardware.cpu.model.replace(/\s+/g, '_');
    const gpuId = hardware.gpus.length > 0 
      ? hardware.gpus[0].model.replace(/\s+/g, '_')
      : 'no_gpu';
    
    return `${cpuId}_${gpuId}`;
  }

  /**
   * Save performance profile
   */
  private saveProfile(profile: PerformanceProfile): void {
    const key = `${profile.hardware}_${profile.algorithm}`;
    const profiles = this.profiles.get(key) || [];
    
    profiles.push(profile);
    
    // Keep only best 10 profiles
    profiles.sort((a, b) => b.efficiency - a.efficiency);
    if (profiles.length > 10) {
      profiles.length = 10;
    }
    
    this.profiles.set(key, profiles);
    
    // Persist to disk (simplified)
    this.persistProfiles();
  }

  /**
   * Load profiles from storage
   */
  private async loadProfiles(): Promise<void> {
    // This would load from a database or file
    // For now, using default profiles
  }

  /**
   * Persist profiles to storage
   */
  private persistProfiles(): void {
    // This would save to a database or file
  }

  /**
   * Get optimization recommendations
   */
  getRecommendations(): string[] {
    const recommendations: string[] = [];
    const hardware = this.hardwareDetector.getProfile();
    
    if (!hardware) {
      recommendations.push('Run hardware detection first');
      return recommendations;
    }
    
    // CPU recommendations
    if (hardware.cpu.temperature && hardware.cpu.temperature > 85) {
      recommendations.push('CPU temperature is high. Consider reducing CPU threads or intensity');
    }
    
    if (hardware.cpu.features.includes('avx2') && !hardware.cpu.features.includes('aes')) {
      recommendations.push('CPU supports AVX2 but not AES. Consider algorithms that benefit from AVX2');
    }
    
    // GPU recommendations
    for (const gpu of hardware.gpus) {
      if (gpu.temperature && gpu.temperature > 85) {
        recommendations.push(`GPU ${gpu.id} temperature is high. Reduce GPU intensity or improve cooling`);
      }
      
      if (gpu.memory < 4000 && hardware.capabilities.algorithms.ethash?.supported) {
        recommendations.push(`GPU ${gpu.id} has limited memory for Ethash. Consider other algorithms`);
      }
    }
    
    // Memory recommendations
    const memoryUsagePercent = (hardware.memory.used / hardware.memory.total) * 100;
    if (memoryUsagePercent > 90) {
      recommendations.push('System memory usage is high. Reduce mining intensity or close other applications');
    }
    
    // Algorithm recommendations
    const bestAlgorithms = this.getBestAlgorithms();
    if (bestAlgorithms.length > 0) {
      recommendations.push(`Best performing algorithms: ${bestAlgorithms.join(', ')}`);
    }
    
    return recommendations;
  }

  /**
   * Get best performing algorithms
   */
  private getBestAlgorithms(): string[] {
    const algorithms: { name: string; efficiency: number }[] = [];
    
    for (const [key, profiles] of this.profiles.entries()) {
      if (profiles.length === 0) continue;
      
      const algorithm = key.split('_').pop()!;
      const bestProfile = profiles[0]; // Already sorted by efficiency
      
      algorithms.push({
        name: algorithm,
        efficiency: bestProfile.efficiency
      });
    }
    
    // Sort by efficiency and return top 3
    algorithms.sort((a, b) => b.efficiency - a.efficiency);
    return algorithms.slice(0, 3).map(a => a.name);
  }

  /**
   * Start continuous optimization
   */
  startContinuousOptimization(interval: number = 3600000): void { // 1 hour default
    this.stopContinuousOptimization();
    
    this.monitoringInterval = setInterval(async () => {
      if (this.isOptimizing) return;
      
      // Check if performance has degraded
      const currentStats = this.miner?.getStats();
      if (!currentStats) return;
      
      const hardwareId = this.getHardwareId();
      const algorithm = currentStats.algorithm;
      const key = `${hardwareId}_${algorithm}`;
      
      const profiles = this.profiles.get(key) || [];
      if (profiles.length === 0) return;
      
      const bestProfile = profiles[0];
      const currentEfficiency = currentStats.hashRates.total / this.estimatePower();
      
      // If efficiency dropped by more than 10%, re-optimize
      if (currentEfficiency < bestProfile.efficiency * 0.9) {
        this.emit('performance:degraded', {
          current: currentEfficiency,
          best: bestProfile.efficiency
        });
        
        await this.optimizeAlgorithm(algorithm, 120); // Quick 2-minute optimization
      }
    }, interval);
  }

  /**
   * Stop continuous optimization
   */
  stopContinuousOptimization(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
  }

  /**
   * Estimate current power consumption
   */
  private estimatePower(): number {
    const hardware = this.hardwareDetector.getProfile();
    if (!hardware) return 1;
    
    const stats = this.miner?.getStats();
    if (!stats) return 1;
    
    let power = 0;
    
    // CPU power
    if (stats.hashRates.cpu) {
      const settings = this.currentSettings.get(this.getHardwareId());
      const threads = settings?.cpuThreads || hardware.cpu.threads;
      power += threads * 15; // 15W per thread estimate
    }
    
    // GPU power
    if (stats.hashRates.gpu) {
      for (const gpu of hardware.gpus) {
        power += gpu.powerLimit || 150;
      }
    }
    
    return Math.max(1, power);
  }
}

// Export types
export { PerformanceProfile, OptimizationSettings, OptimizationResult };
