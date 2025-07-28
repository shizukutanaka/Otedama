/**
 * Advanced Hardware Optimizer
 * National-scale hardware optimization with AI-powered tuning
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const logger = createStructuredLogger('HardwareOptimizer');

// Optimization profiles
export const OptimizationProfile = {
  EFFICIENCY: 'efficiency',    // Maximum hash per watt
  PERFORMANCE: 'performance',  // Maximum hashrate
  QUIET: 'quiet',             // Low noise/temperature
  BALANCED: 'balanced',       // Balance of all factors
  CUSTOM: 'custom'            // User-defined
};

export class HardwareOptimizer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      profile: options.profile || OptimizationProfile.BALANCED,
      
      // Temperature limits (Celsius)
      cpuTempTarget: options.cpuTempTarget || 70,
      cpuTempMax: options.cpuTempMax || 85,
      gpuTempTarget: options.gpuTempTarget || 75,
      gpuTempMax: options.gpuTempMax || 83,
      
      // Power limits (percentage)
      cpuPowerLimit: options.cpuPowerLimit || 100,
      gpuPowerLimit: options.gpuPowerLimit || 100,
      
      // Performance tuning
      cpuThreads: options.cpuThreads || os.cpus().length,
      gpuIntensity: options.gpuIntensity || 100,
      
      // Memory settings
      enableHugePages: options.enableHugePages !== false,
      lockPagesInMemory: options.lockPagesInMemory || false,
      
      // GPU specific
      gpuMemoryOC: options.gpuMemoryOC || 0,  // Memory overclock MHz
      gpuCoreOC: options.gpuCoreOC || 0,     // Core overclock MHz
      
      // Monitoring
      monitoringInterval: options.monitoringInterval || 5000,
      adjustmentInterval: options.adjustmentInterval || 30000,
      
      // AI optimization
      enableAITuning: options.enableAITuning !== false,
      learningRate: options.learningRate || 0.01
    };
    
    // Hardware state
    this.hardwareState = {
      cpu: {
        temperature: 0,
        frequency: 0,
        utilization: 0,
        power: 0
      },
      gpus: new Map()
    };
    
    // Optimization history
    this.optimizationHistory = [];
    this.bestSettings = null;
    this.currentSettings = null;
    
    // Performance metrics
    this.metrics = {
      totalHashrate: 0,
      totalPower: 0,
      efficiency: 0,
      stability: 100
    };
    
    // AI optimization model (simplified)
    this.aiModel = {
      weights: new Map(),
      history: []
    };
  }

  async initialize() {
    logger.info('Initializing hardware optimizer', {
      profile: this.config.profile
    });
    
    // Setup huge pages if enabled
    if (this.config.enableHugePages) {
      await this.setupHugePages();
    }
    
    // Load optimization profiles
    this.loadOptimizationProfiles();
    
    // Start monitoring
    this.startMonitoring();
    
    this.emit('initialized');
  }

  loadOptimizationProfiles() {
    // Efficiency profile
    this.setProfile(OptimizationProfile.EFFICIENCY, {
      cpuPowerLimit: 65,
      gpuPowerLimit: 70,
      cpuThreads: Math.floor(os.cpus().length * 0.75),
      gpuIntensity: 80,
      gpuMemoryOC: -200,
      gpuCoreOC: -100
    });
    
    // Performance profile
    this.setProfile(OptimizationProfile.PERFORMANCE, {
      cpuPowerLimit: 100,
      gpuPowerLimit: 110,
      cpuThreads: os.cpus().length,
      gpuIntensity: 100,
      gpuMemoryOC: 500,
      gpuCoreOC: 100
    });
    
    // Quiet profile
    this.setProfile(OptimizationProfile.QUIET, {
      cpuPowerLimit: 50,
      gpuPowerLimit: 60,
      cpuThreads: Math.floor(os.cpus().length * 0.5),
      gpuIntensity: 60,
      gpuMemoryOC: 0,
      gpuCoreOC: -200
    });
    
    // Balanced profile (default)
    this.setProfile(OptimizationProfile.BALANCED, {
      cpuPowerLimit: 80,
      gpuPowerLimit: 85,
      cpuThreads: Math.floor(os.cpus().length * 0.85),
      gpuIntensity: 90,
      gpuMemoryOC: 200,
      gpuCoreOC: 0
    });
  }

  setProfile(name, settings) {
    this.optimizationHistory.push({
      profile: name,
      settings,
      timestamp: Date.now()
    });
  }

  async optimizeHardware(hardware) {
    logger.info('Starting hardware optimization', {
      hardwareCount: hardware.size,
      profile: this.config.profile
    });
    
    const optimizations = [];
    
    // Optimize each hardware component
    for (const [id, hw] of hardware) {
      const optimization = await this.optimizeComponent(hw);
      optimizations.push(optimization);
    }
    
    // Apply optimizations
    await this.applyOptimizations(optimizations);
    
    // If AI tuning is enabled, learn from results
    if (this.config.enableAITuning) {
      await this.aiTuneOptimizations(optimizations);
    }
    
    return optimizations;
  }

  async optimizeComponent(hardware) {
    const optimization = {
      id: hardware.id,
      type: hardware.type,
      original: { ...hardware.optimizations },
      optimized: {},
      improvement: 0
    };
    
    switch (hardware.type) {
      case 'cpu':
        optimization.optimized = await this.optimizeCPU(hardware);
        break;
        
      case 'gpu_nvidia':
        optimization.optimized = await this.optimizeNvidiaGPU(hardware);
        break;
        
      case 'gpu_amd':
        optimization.optimized = await this.optimizeAMDGPU(hardware);
        break;
        
      case 'asic':
        optimization.optimized = await this.optimizeASIC(hardware);
        break;
    }
    
    // Calculate improvement
    const originalScore = this.calculateScore(hardware, optimization.original);
    const optimizedScore = this.calculateScore(hardware, optimization.optimized);
    optimization.improvement = ((optimizedScore - originalScore) / originalScore) * 100;
    
    return optimization;
  }

  async optimizeCPU(cpu) {
    const settings = {
      threads: this.config.cpuThreads,
      affinity: this.calculateCPUAffinity(cpu),
      frequency: 'ondemand',
      hugePages: this.config.enableHugePages
    };
    
    // Adjust based on temperature
    if (cpu.temperature > this.config.cpuTempTarget) {
      settings.threads = Math.max(1, settings.threads - 1);
      settings.frequency = 'powersave';
    }
    
    // Apply CPU governor settings
    if (process.platform === 'linux') {
      try {
        await execAsync(`sudo cpufreq-set -g ${settings.frequency}`);
      } catch (error) {
        logger.warn('Failed to set CPU governor', { error: error.message });
      }
    }
    
    return settings;
  }

  async optimizeNvidiaGPU(gpu) {
    const settings = {
      powerLimit: this.config.gpuPowerLimit,
      memoryOC: this.config.gpuMemoryOC,
      coreOC: this.config.gpuCoreOC,
      fanSpeed: 'auto',
      intensity: this.config.gpuIntensity
    };
    
    // Adjust based on temperature
    if (gpu.temperature > this.config.gpuTempTarget) {
      settings.powerLimit = Math.max(50, settings.powerLimit - 10);
      settings.fanSpeed = Math.min(100, gpu.fanSpeed + 10);
    }
    
    // Apply settings using nvidia-smi
    if (process.platform === 'linux' || process.platform === 'win32') {
      try {
        // Set power limit
        await execAsync(`nvidia-smi -i ${gpu.index} -pl ${settings.powerLimit}`);
        
        // Set memory overclock
        if (settings.memoryOC !== 0) {
          await execAsync(`nvidia-smi -i ${gpu.index} -mo ${settings.memoryOC}`);
        }
        
        // Set GPU overclock
        if (settings.coreOC !== 0) {
          await execAsync(`nvidia-smi -i ${gpu.index} -lgc ${settings.coreOC}`);
        }
      } catch (error) {
        logger.warn('Failed to apply NVIDIA GPU settings', { 
          gpu: gpu.id, 
          error: error.message 
        });
      }
    }
    
    return settings;
  }

  async optimizeAMDGPU(gpu) {
    const settings = {
      powerLimit: this.config.gpuPowerLimit,
      memoryOC: this.config.gpuMemoryOC,
      coreOC: this.config.gpuCoreOC,
      fanSpeed: 'auto',
      intensity: this.config.gpuIntensity
    };
    
    // AMD GPU optimization using ROCm-SMI or similar
    if (process.platform === 'linux') {
      try {
        // Set power cap
        const powerCap = Math.floor((settings.powerLimit / 100) * gpu.maxPower);
        await execAsync(`rocm-smi -d ${gpu.index} --setpoweroverdrive ${powerCap}`);
        
        // Set memory clock
        if (settings.memoryOC !== 0) {
          const memClock = gpu.memoryFreq + settings.memoryOC;
          await execAsync(`rocm-smi -d ${gpu.index} --setmclk ${memClock}`);
        }
      } catch (error) {
        logger.warn('Failed to apply AMD GPU settings', {
          gpu: gpu.id,
          error: error.message
        });
      }
    }
    
    return settings;
  }

  async optimizeASIC(asic) {
    // ASIC-specific optimizations
    return {
      frequency: asic.frequency,
      voltage: asic.voltage,
      fanSpeed: 'auto'
    };
  }

  calculateCPUAffinity(cpu) {
    // Calculate optimal CPU affinity mask
    const cores = os.cpus().length;
    const threads = this.config.cpuThreads;
    
    // Use physical cores first
    const affinityMask = [];
    for (let i = 0; i < Math.min(threads, cores); i += 2) {
      affinityMask.push(i);
    }
    
    return affinityMask;
  }

  calculateScore(hardware, settings) {
    // Calculate optimization score based on profile
    let score = 0;
    
    switch (this.config.profile) {
      case OptimizationProfile.EFFICIENCY:
        score = hardware.hashrate / Math.max(1, hardware.power);
        break;
        
      case OptimizationProfile.PERFORMANCE:
        score = hardware.hashrate;
        break;
        
      case OptimizationProfile.QUIET:
        score = 100 - hardware.temperature;
        break;
        
      case OptimizationProfile.BALANCED:
        score = (hardware.hashrate * 0.5) + 
                ((hardware.hashrate / Math.max(1, hardware.power)) * 0.3) +
                ((100 - hardware.temperature) * 0.2);
        break;
    }
    
    return score;
  }

  async applyOptimizations(optimizations) {
    logger.info('Applying optimizations', {
      count: optimizations.length
    });
    
    for (const opt of optimizations) {
      this.currentSettings = opt.optimized;
      
      // Track best settings
      if (!this.bestSettings || opt.improvement > 0) {
        this.bestSettings = { ...opt.optimized };
      }
      
      this.emit('optimization:applied', {
        hardware: opt.id,
        improvement: opt.improvement,
        settings: opt.optimized
      });
    }
  }

  async aiTuneOptimizations(optimizations) {
    // Simple reinforcement learning for optimization tuning
    for (const opt of optimizations) {
      const key = `${opt.type}_${this.config.profile}`;
      
      // Update weights based on improvement
      let weights = this.aiModel.weights.get(key) || {
        powerLimit: 0,
        memoryOC: 0,
        coreOC: 0,
        threads: 0
      };
      
      // Adjust weights based on result
      const reward = opt.improvement / 100;
      for (const [param, value] of Object.entries(opt.optimized)) {
        if (weights[param] !== undefined) {
          weights[param] += this.config.learningRate * reward * value;
        }
      }
      
      this.aiModel.weights.set(key, weights);
      
      // Store in history
      this.aiModel.history.push({
        timestamp: Date.now(),
        type: opt.type,
        profile: this.config.profile,
        settings: opt.optimized,
        improvement: opt.improvement
      });
    }
    
    // Limit history size
    if (this.aiModel.history.length > 1000) {
      this.aiModel.history = this.aiModel.history.slice(-1000);
    }
  }

  async setupHugePages() {
    if (process.platform === 'linux') {
      try {
        // Calculate required huge pages (2MB each)
        const totalMemory = os.totalmem();
        const hugePages = Math.floor(totalMemory / (2 * 1024 * 1024) * 0.5); // Use 50% of RAM
        
        // Set huge pages
        await execAsync(`sudo sysctl -w vm.nr_hugepages=${hugePages}`);
        
        logger.info('Huge pages configured', { count: hugePages });
      } catch (error) {
        logger.error('Failed to setup huge pages', { error: error.message });
      }
    }
  }

  startMonitoring() {
    // Monitor hardware status
    this.monitoringInterval = setInterval(async () => {
      await this.updateHardwareState();
      
      // Check if adjustments needed
      if (this.needsAdjustment()) {
        await this.adjustSettings();
      }
      
      this.emit('status:update', {
        state: this.hardwareState,
        metrics: this.metrics
      });
    }, this.config.monitoringInterval);
    
    // Periodic optimization
    this.optimizationInterval = setInterval(async () => {
      if (this.config.enableAITuning) {
        await this.performAIOptimization();
      }
    }, this.config.adjustmentInterval);
  }

  async updateHardwareState() {
    // Update CPU state
    if (process.platform === 'linux') {
      try {
        const tempResult = await execAsync('sensors -j');
        const temps = JSON.parse(tempResult.stdout);
        // Parse temperature data
        this.hardwareState.cpu.temperature = this.parseCPUTemp(temps);
      } catch (error) {
        // Fallback temperature reading
      }
    }
    
    // Update GPU state
    try {
      const gpuResult = await execAsync('nvidia-smi --query-gpu=index,temperature.gpu,power.draw,utilization.gpu --format=csv,noheader,nounits');
      const gpus = gpuResult.stdout.trim().split('\n');
      
      for (const gpu of gpus) {
        const [index, temp, power, util] = gpu.split(', ');
        this.hardwareState.gpus.set(parseInt(index), {
          temperature: parseFloat(temp),
          power: parseFloat(power),
          utilization: parseFloat(util)
        });
      }
    } catch (error) {
      // GPU monitoring not available
    }
  }

  parseCPUTemp(sensorData) {
    // Parse lm-sensors JSON output
    let maxTemp = 0;
    
    for (const chip of Object.values(sensorData)) {
      for (const [key, value] of Object.entries(chip)) {
        if (key.includes('temp') && value['temp1_input']) {
          maxTemp = Math.max(maxTemp, value['temp1_input']);
        }
      }
    }
    
    return maxTemp;
  }

  needsAdjustment() {
    // Check if hardware needs adjustment
    if (this.hardwareState.cpu.temperature > this.config.cpuTempMax) {
      return true;
    }
    
    for (const gpu of this.hardwareState.gpus.values()) {
      if (gpu.temperature > this.config.gpuTempMax) {
        return true;
      }
    }
    
    return false;
  }

  async adjustSettings() {
    logger.info('Adjusting settings due to temperature/power limits');
    
    // Reduce power if overheating
    if (this.hardwareState.cpu.temperature > this.config.cpuTempMax) {
      this.config.cpuPowerLimit = Math.max(50, this.config.cpuPowerLimit - 5);
      this.config.cpuThreads = Math.max(1, this.config.cpuThreads - 1);
    }
    
    // Adjust GPU settings
    for (const [index, gpu] of this.hardwareState.gpus) {
      if (gpu.temperature > this.config.gpuTempMax) {
        // Reduce power limit
        await execAsync(`nvidia-smi -i ${index} -pl ${Math.max(50, this.config.gpuPowerLimit - 10)}`);
      }
    }
    
    this.emit('settings:adjusted', {
      cpu: {
        powerLimit: this.config.cpuPowerLimit,
        threads: this.config.cpuThreads
      },
      gpu: {
        powerLimit: this.config.gpuPowerLimit
      }
    });
  }

  async performAIOptimization() {
    // Use AI model to suggest better settings
    const suggestions = this.generateAISuggestions();
    
    if (suggestions.length > 0) {
      logger.info('Applying AI-suggested optimizations', {
        count: suggestions.length
      });
      
      await this.applyOptimizations(suggestions);
    }
  }

  generateAISuggestions() {
    const suggestions = [];
    
    // Generate suggestions based on learned weights
    for (const [key, weights] of this.aiModel.weights) {
      const [type, profile] = key.split('_');
      
      if (profile === this.config.profile) {
        suggestions.push({
          type,
          optimized: {
            powerLimit: Math.max(50, Math.min(110, 85 + weights.powerLimit)),
            memoryOC: Math.max(-500, Math.min(1000, weights.memoryOC)),
            coreOC: Math.max(-200, Math.min(200, weights.coreOC)),
            threads: Math.max(1, Math.min(os.cpus().length, os.cpus().length * 0.8 + weights.threads))
          }
        });
      }
    }
    
    return suggestions;
  }

  getMetrics() {
    return {
      ...this.metrics,
      currentProfile: this.config.profile,
      hardwareState: this.hardwareState,
      optimizationHistory: this.optimizationHistory.slice(-10)
    };
  }

  async stop() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    if (this.optimizationInterval) {
      clearInterval(this.optimizationInterval);
    }
    
    // Reset hardware to default settings
    await this.resetHardware();
    
    this.emit('stopped');
  }

  async resetHardware() {
    logger.info('Resetting hardware to default settings');
    
    // Reset GPU settings
    try {
      await execAsync('nvidia-smi -r');
    } catch (error) {
      // Ignore reset errors
    }
  }
}

export default HardwareOptimizer;