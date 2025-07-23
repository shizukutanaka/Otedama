/**
 * GPU Mining Optimization Engine
 * Advanced GPU management and optimization for mining operations
 * 
 * Features:
 * - Multi-GPU support and load balancing
 * - Temperature and power management
 * - Memory timing optimization
 * - Algorithm-specific tuning
 * - Automatic overclock profiles
 * - Crash recovery and stability testing
 */

const { EventEmitter } = require('events');
const { exec } = require('child_process');
const { promisify } = require('util');
const { createLogger } = require('../core/logger');

const execAsync = promisify(exec);
const logger = createLogger('gpu-optimizer');

// GPU vendor detection
const GPUVendor = {
  NVIDIA: 'nvidia',
  AMD: 'amd',
  INTEL: 'intel'
};

// Optimization profiles
const OptimizationProfile = {
  EFFICIENCY: 'efficiency',    // Maximum hash per watt
  PERFORMANCE: 'performance',  // Maximum hashrate
  BALANCED: 'balanced',       // Balance between efficiency and performance
  QUIET: 'quiet',            // Low noise, reduced performance
  CUSTOM: 'custom'           // User-defined settings
};

// Algorithm GPU requirements
const ALGORITHM_REQUIREMENTS = {
  ethash: {
    minMemory: 4096,  // 4GB minimum
    memoryIntensive: true,
    preferredVendor: [GPUVendor.AMD, GPUVendor.NVIDIA]
  },
  kawpow: {
    minMemory: 3072,  // 3GB minimum
    coreIntensive: true,
    preferredVendor: [GPUVendor.NVIDIA]
  },
  octopus: {
    minMemory: 5120,  // 5GB minimum
    memoryIntensive: true,
    preferredVendor: [GPUVendor.NVIDIA]
  },
  randomx: {
    minMemory: 2048,  // 2GB minimum
    cpuFriendly: true,
    preferredVendor: []  // CPU preferred
  }
};

// GPU settings limits
const GPU_LIMITS = {
  nvidia: {
    powerLimit: { min: 50, max: 150 },      // Percentage
    memoryOffset: { min: -1000, max: 2000 }, // MHz
    coreOffset: { min: -200, max: 200 },     // MHz
    fanSpeed: { min: 30, max: 100 },        // Percentage
    tempTarget: { min: 50, max: 85 }        // Celsius
  },
  amd: {
    powerLimit: { min: -50, max: 50 },      // Percentage
    memorySpeed: { min: 300, max: 2500 },   // MHz absolute
    coreSpeed: { min: 300, max: 2000 },     // MHz absolute
    fanSpeed: { min: 0, max: 100 },         // Percentage
    voltage: { min: 750, max: 1200 }        // mV
  }
};

class GPUDevice {
  constructor(id, info) {
    this.id = id;
    this.index = info.index;
    this.name = info.name;
    this.vendor = info.vendor;
    this.memory = info.memory;
    this.busId = info.busId;
    
    // Current state
    this.enabled = true;
    this.mining = false;
    this.algorithm = null;
    this.hashrate = 0;
    
    // Monitoring data
    this.temperature = 0;
    this.power = 0;
    this.fanSpeed = 0;
    this.memoryUsed = 0;
    this.utilization = 0;
    
    // Settings
    this.settings = {
      powerLimit: 100,
      memoryOffset: 0,
      coreOffset: 0,
      fanSpeed: 'auto',
      targetTemp: 70
    };
    
    // Statistics
    this.stats = {
      totalShares: 0,
      acceptedShares: 0,
      rejectedShares: 0,
      crashes: 0,
      uptimeStart: Date.now()
    };
  }

  updateMonitoring(data) {
    this.temperature = data.temperature || this.temperature;
    this.power = data.power || this.power;
    this.fanSpeed = data.fanSpeed || this.fanSpeed;
    this.memoryUsed = data.memoryUsed || this.memoryUsed;
    this.utilization = data.utilization || this.utilization;
  }

  getEfficiency() {
    if (this.power === 0) return 0;
    return this.hashrate / this.power; // Hash per watt
  }

  isOverheating() {
    return this.temperature > this.settings.targetTemp + 10;
  }

  needsThrottling() {
    return this.temperature > this.settings.targetTemp + 5;
  }
}

class GPUOptimizer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      monitoringInterval: options.monitoringInterval || 5000,  // 5 seconds
      optimizationInterval: options.optimizationInterval || 60000, // 1 minute
      stabilityTestDuration: options.stabilityTestDuration || 300000, // 5 minutes
      autoTuning: options.autoTuning !== false,
      crashRecovery: options.crashRecovery !== false,
      temperatureControl: options.temperatureControl !== false,
      profile: options.profile || OptimizationProfile.BALANCED,
      ...options
    };
    
    this.gpus = new Map();
    this.profiles = new Map();
    this.monitoringInterval = null;
    this.optimizationInterval = null;
    
    // Optimization state
    this.isOptimizing = false;
    this.optimizationQueue = [];
    
    // Load default profiles
    this.loadDefaultProfiles();
  }

  loadDefaultProfiles() {
    // Efficiency profile
    this.profiles.set(OptimizationProfile.EFFICIENCY, {
      powerLimit: 70,
      memoryOffset: 1000,
      coreOffset: 0,
      fanSpeed: 'auto',
      targetTemp: 65
    });
    
    // Performance profile
    this.profiles.set(OptimizationProfile.PERFORMANCE, {
      powerLimit: 110,
      memoryOffset: 1500,
      coreOffset: 100,
      fanSpeed: 80,
      targetTemp: 75
    });
    
    // Balanced profile
    this.profiles.set(OptimizationProfile.BALANCED, {
      powerLimit: 85,
      memoryOffset: 1200,
      coreOffset: 50,
      fanSpeed: 'auto',
      targetTemp: 70
    });
    
    // Quiet profile
    this.profiles.set(OptimizationProfile.QUIET, {
      powerLimit: 60,
      memoryOffset: 800,
      coreOffset: -50,
      fanSpeed: 50,
      targetTemp: 65
    });
  }

  async initialize() {
    logger.info('Initializing GPU optimizer...');
    
    // Detect GPUs
    await this.detectGPUs();
    
    // Start monitoring
    this.startMonitoring();
    
    // Start optimization loop
    if (this.config.autoTuning) {
      this.startOptimization();
    }
    
    logger.info(`GPU optimizer initialized with ${this.gpus.size} GPUs`);
  }

  async detectGPUs() {
    const gpuList = [];
    
    // Try NVIDIA detection
    try {
      const nvidiaGPUs = await this.detectNvidiaGPUs();
      gpuList.push(...nvidiaGPUs);
    } catch (error) {
      logger.debug('NVIDIA detection failed:', error.message);
    }
    
    // Try AMD detection
    try {
      const amdGPUs = await this.detectAMDGPUs();
      gpuList.push(...amdGPUs);
    } catch (error) {
      logger.debug('AMD detection failed:', error.message);
    }
    
    // Add detected GPUs
    for (const gpuInfo of gpuList) {
      const gpu = new GPUDevice(gpuInfo.id, gpuInfo);
      this.gpus.set(gpuInfo.id, gpu);
      
      this.emit('gpu:detected', {
        id: gpu.id,
        name: gpu.name,
        vendor: gpu.vendor,
        memory: gpu.memory
      });
    }
  }

  async detectNvidiaGPUs() {
    const gpus = [];
    
    try {
      // Use nvidia-smi to detect GPUs
      const { stdout } = await execAsync('nvidia-smi --query-gpu=index,name,memory.total,pci.bus_id --format=csv,noheader,nounits');
      
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const [index, name, memory, busId] = line.split(', ');
        
        gpus.push({
          id: `nvidia_${index}`,
          index: parseInt(index),
          name: name.trim(),
          vendor: GPUVendor.NVIDIA,
          memory: parseInt(memory),
          busId: busId.trim()
        });
      }
    } catch (error) {
      throw new Error('NVIDIA GPU detection failed');
    }
    
    return gpus;
  }

  async detectAMDGPUs() {
    const gpus = [];
    
    try {
      // Use rocm-smi or similar for AMD GPUs
      const { stdout } = await execAsync('rocm-smi --showid --showmeminfo vram --csv');
      
      // Parse AMD GPU information
      // This is a simplified example - actual implementation would need proper parsing
      const lines = stdout.trim().split('\n').slice(1); // Skip header
      for (let i = 0; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length >= 2) {
          gpus.push({
            id: `amd_${i}`,
            index: i,
            name: `AMD GPU ${i}`,
            vendor: GPUVendor.AMD,
            memory: parseInt(parts[1]) || 8192, // Default 8GB
            busId: parts[0]
          });
        }
      }
    } catch (error) {
      throw new Error('AMD GPU detection failed');
    }
    
    return gpus;
  }

  startMonitoring() {
    this.monitoringInterval = setInterval(async () => {
      await this.updateGPUStats();
    }, this.config.monitoringInterval);
  }

  async updateGPUStats() {
    for (const [id, gpu] of this.gpus) {
      try {
        const stats = await this.getGPUStats(gpu);
        gpu.updateMonitoring(stats);
        
        // Check for issues
        if (gpu.isOverheating()) {
          this.handleOverheating(gpu);
        }
        
        // Emit monitoring update
        this.emit('gpu:stats', {
          id: gpu.id,
          temperature: gpu.temperature,
          power: gpu.power,
          hashrate: gpu.hashrate,
          efficiency: gpu.getEfficiency()
        });
      } catch (error) {
        logger.error(`Failed to update stats for GPU ${id}:`, error);
      }
    }
  }

  async getGPUStats(gpu) {
    if (gpu.vendor === GPUVendor.NVIDIA) {
      return this.getNvidiaStats(gpu);
    } else if (gpu.vendor === GPUVendor.AMD) {
      return this.getAMDStats(gpu);
    }
    
    return {};
  }

  async getNvidiaStats(gpu) {
    try {
      const { stdout } = await execAsync(
        `nvidia-smi -i ${gpu.index} --query-gpu=temperature.gpu,power.draw,fan.speed,memory.used,utilization.gpu --format=csv,noheader,nounits`
      );
      
      const [temp, power, fan, memUsed, util] = stdout.trim().split(', ');
      
      return {
        temperature: parseFloat(temp),
        power: parseFloat(power),
        fanSpeed: parseFloat(fan),
        memoryUsed: parseFloat(memUsed),
        utilization: parseFloat(util)
      };
    } catch (error) {
      logger.error(`Failed to get NVIDIA stats for GPU ${gpu.id}:`, error);
      return {};
    }
  }

  async getAMDStats(gpu) {
    try {
      // Use rocm-smi for AMD GPUs
      const { stdout } = await execAsync(
        `rocm-smi -d ${gpu.index} -t -p -f -u`
      );
      
      // Parse output (simplified)
      const stats = {};
      const lines = stdout.split('\n');
      
      for (const line of lines) {
        if (line.includes('Temperature')) {
          stats.temperature = parseFloat(line.match(/\d+/)?.[0] || 0);
        } else if (line.includes('Power')) {
          stats.power = parseFloat(line.match(/\d+/)?.[0] || 0);
        } else if (line.includes('Fan')) {
          stats.fanSpeed = parseFloat(line.match(/\d+/)?.[0] || 0);
        }
      }
      
      return stats;
    } catch (error) {
      logger.error(`Failed to get AMD stats for GPU ${gpu.id}:`, error);
      return {};
    }
  }

  startOptimization() {
    this.optimizationInterval = setInterval(async () => {
      if (!this.isOptimizing && this.config.autoTuning) {
        await this.optimizeGPUs();
      }
    }, this.config.optimizationInterval);
  }

  async optimizeGPUs() {
    this.isOptimizing = true;
    
    try {
      for (const [id, gpu] of this.gpus) {
        if (gpu.enabled && gpu.mining) {
          await this.optimizeGPU(gpu);
        }
      }
    } finally {
      this.isOptimizing = false;
    }
  }

  async optimizeGPU(gpu) {
    logger.info(`Optimizing GPU ${gpu.id}...`);
    
    // Get current performance baseline
    const baseline = {
      hashrate: gpu.hashrate,
      power: gpu.power,
      temperature: gpu.temperature,
      efficiency: gpu.getEfficiency()
    };
    
    // Apply optimization based on profile
    const profile = this.profiles.get(this.config.profile);
    if (!profile) {
      logger.error(`Unknown profile: ${this.config.profile}`);
      return;
    }
    
    // Calculate optimal settings
    const optimalSettings = await this.calculateOptimalSettings(gpu, profile, baseline);
    
    // Apply settings if they improve performance
    if (this.shouldApplySettings(gpu, optimalSettings, baseline)) {
      await this.applyGPUSettings(gpu, optimalSettings);
      
      // Test stability
      if (await this.testStability(gpu, this.config.stabilityTestDuration)) {
        gpu.settings = optimalSettings;
        
        this.emit('gpu:optimized', {
          id: gpu.id,
          oldSettings: baseline,
          newSettings: {
            hashrate: gpu.hashrate,
            power: gpu.power,
            efficiency: gpu.getEfficiency()
          }
        });
      } else {
        // Revert to previous settings
        await this.applyGPUSettings(gpu, gpu.settings);
        logger.warn(`GPU ${gpu.id} failed stability test, reverting settings`);
      }
    }
  }

  async calculateOptimalSettings(gpu, profile, baseline) {
    const settings = { ...gpu.settings };
    
    // Adjust based on current metrics
    if (gpu.temperature > profile.targetTemp) {
      // Reduce power if overheating
      settings.powerLimit = Math.max(
        profile.powerLimit - 10,
        GPU_LIMITS[gpu.vendor].powerLimit.min
      );
    } else if (gpu.temperature < profile.targetTemp - 10) {
      // Can increase power if cool
      settings.powerLimit = Math.min(
        profile.powerLimit + 5,
        GPU_LIMITS[gpu.vendor].powerLimit.max
      );
    }
    
    // Memory optimization for memory-intensive algorithms
    if (ALGORITHM_REQUIREMENTS[gpu.algorithm]?.memoryIntensive) {
      settings.memoryOffset = profile.memoryOffset;
      settings.coreOffset = Math.min(profile.coreOffset, 0); // Reduce core for memory algorithms
    } else {
      settings.coreOffset = profile.coreOffset;
      settings.memoryOffset = profile.memoryOffset * 0.7; // Less memory OC for core algorithms
    }
    
    // Fan speed based on temperature
    if (profile.fanSpeed === 'auto') {
      if (gpu.temperature > profile.targetTemp) {
        settings.fanSpeed = Math.min(gpu.fanSpeed + 10, 100);
      } else if (gpu.temperature < profile.targetTemp - 5) {
        settings.fanSpeed = Math.max(gpu.fanSpeed - 5, 40);
      }
    } else {
      settings.fanSpeed = profile.fanSpeed;
    }
    
    return settings;
  }

  shouldApplySettings(gpu, newSettings, baseline) {
    // Don't apply if GPU is overheating
    if (gpu.isOverheating()) {
      return false;
    }
    
    // Check if settings are significantly different
    const significantChange = 
      Math.abs(newSettings.powerLimit - gpu.settings.powerLimit) > 5 ||
      Math.abs(newSettings.memoryOffset - gpu.settings.memoryOffset) > 100 ||
      Math.abs(newSettings.coreOffset - gpu.settings.coreOffset) > 25;
    
    return significantChange;
  }

  async applyGPUSettings(gpu, settings) {
    logger.info(`Applying settings to GPU ${gpu.id}:`, settings);
    
    try {
      if (gpu.vendor === GPUVendor.NVIDIA) {
        await this.applyNvidiaSettings(gpu, settings);
      } else if (gpu.vendor === GPUVendor.AMD) {
        await this.applyAMDSettings(gpu, settings);
      }
      
      this.emit('gpu:settings:applied', {
        id: gpu.id,
        settings
      });
    } catch (error) {
      logger.error(`Failed to apply settings to GPU ${gpu.id}:`, error);
      throw error;
    }
  }

  async applyNvidiaSettings(gpu, settings) {
    const commands = [];
    
    // Power limit
    if (settings.powerLimit !== undefined) {
      commands.push(`nvidia-smi -i ${gpu.index} -pl ${Math.round(gpu.power * settings.powerLimit / 100)}`);
    }
    
    // Memory offset
    if (settings.memoryOffset !== undefined) {
      commands.push(`nvidia-settings -a [gpu:${gpu.index}]/GPUMemoryTransferRateOffset[3]=${settings.memoryOffset}`);
    }
    
    // Core offset
    if (settings.coreOffset !== undefined) {
      commands.push(`nvidia-settings -a [gpu:${gpu.index}]/GPUGraphicsClockOffset[3]=${settings.coreOffset}`);
    }
    
    // Fan speed
    if (settings.fanSpeed !== undefined && settings.fanSpeed !== 'auto') {
      commands.push(`nvidia-settings -a [gpu:${gpu.index}]/GPUFanControlState=1`);
      commands.push(`nvidia-settings -a [fan:${gpu.index}]/GPUTargetFanSpeed=${settings.fanSpeed}`);
    }
    
    // Execute commands
    for (const cmd of commands) {
      await execAsync(cmd);
    }
  }

  async applyAMDSettings(gpu, settings) {
    const commands = [];
    
    // Power limit (AMD uses percentage offset)
    if (settings.powerLimit !== undefined) {
      const offset = settings.powerLimit - 100;
      commands.push(`rocm-smi -d ${gpu.index} --setpoweroverdrive ${offset}`);
    }
    
    // Memory clock
    if (settings.memoryOffset !== undefined) {
      // AMD uses absolute clocks, need to calculate from base
      const memClock = 1750 + settings.memoryOffset; // Assuming 1750 base
      commands.push(`rocm-smi -d ${gpu.index} --setmclk ${memClock}`);
    }
    
    // Core clock
    if (settings.coreOffset !== undefined) {
      const coreClock = 1500 + settings.coreOffset; // Assuming 1500 base
      commands.push(`rocm-smi -d ${gpu.index} --setsclk ${coreClock}`);
    }
    
    // Fan speed
    if (settings.fanSpeed !== undefined && settings.fanSpeed !== 'auto') {
      commands.push(`rocm-smi -d ${gpu.index} --setfan ${settings.fanSpeed}%`);
    }
    
    // Execute commands
    for (const cmd of commands) {
      await execAsync(cmd);
    }
  }

  async testStability(gpu, duration) {
    logger.info(`Testing stability for GPU ${gpu.id} for ${duration/1000}s...`);
    
    const startTime = Date.now();
    const initialHashrate = gpu.hashrate;
    let stable = true;
    
    // Monitor for crashes or hashrate drops
    const checkInterval = setInterval(() => {
      if (gpu.hashrate < initialHashrate * 0.9) {
        stable = false;
      }
      
      if (gpu.temperature > gpu.settings.targetTemp + 15) {
        stable = false;
      }
    }, 5000);
    
    // Wait for test duration
    await new Promise(resolve => setTimeout(resolve, duration));
    
    clearInterval(checkInterval);
    
    logger.info(`Stability test for GPU ${gpu.id} completed: ${stable ? 'PASSED' : 'FAILED'}`);
    
    return stable;
  }

  handleOverheating(gpu) {
    logger.warn(`GPU ${gpu.id} is overheating: ${gpu.temperature}°C`);
    
    // Immediate actions
    if (gpu.temperature > 85) {
      // Emergency throttle
      this.emergencyThrottle(gpu);
    } else if (gpu.needsThrottling()) {
      // Gradual throttle
      this.throttleGPU(gpu);
    }
    
    this.emit('gpu:overheating', {
      id: gpu.id,
      temperature: gpu.temperature,
      targetTemp: gpu.settings.targetTemp
    });
  }

  async emergencyThrottle(gpu) {
    const emergencySettings = {
      ...gpu.settings,
      powerLimit: 60,
      fanSpeed: 100
    };
    
    await this.applyGPUSettings(gpu, emergencySettings);
    
    logger.warn(`Emergency throttle applied to GPU ${gpu.id}`);
  }

  async throttleGPU(gpu) {
    const throttledSettings = {
      ...gpu.settings,
      powerLimit: Math.max(gpu.settings.powerLimit - 10, 60),
      fanSpeed: Math.min(gpu.fanSpeed + 10, 100)
    };
    
    await this.applyGPUSettings(gpu, throttledSettings);
  }

  // Public API methods

  async setProfile(profile) {
    if (!Object.values(OptimizationProfile).includes(profile)) {
      throw new Error(`Invalid profile: ${profile}`);
    }
    
    this.config.profile = profile;
    
    // Apply profile to all GPUs
    for (const [id, gpu] of this.gpus) {
      if (gpu.enabled) {
        const profileSettings = this.profiles.get(profile);
        await this.applyGPUSettings(gpu, profileSettings);
      }
    }
  }

  async setGPUEnabled(gpuId, enabled) {
    const gpu = this.gpus.get(gpuId);
    if (!gpu) {
      throw new Error(`GPU ${gpuId} not found`);
    }
    
    gpu.enabled = enabled;
    
    if (!enabled) {
      // Reset to default settings when disabled
      await this.resetGPU(gpu);
    }
  }

  async resetGPU(gpu) {
    const defaultSettings = {
      powerLimit: 100,
      memoryOffset: 0,
      coreOffset: 0,
      fanSpeed: 'auto'
    };
    
    await this.applyGPUSettings(gpu, defaultSettings);
  }

  getGPUStatus(gpuId) {
    const gpu = this.gpus.get(gpuId);
    if (!gpu) return null;
    
    return {
      id: gpu.id,
      name: gpu.name,
      vendor: gpu.vendor,
      enabled: gpu.enabled,
      mining: gpu.mining,
      algorithm: gpu.algorithm,
      hashrate: gpu.hashrate,
      temperature: gpu.temperature,
      power: gpu.power,
      efficiency: gpu.getEfficiency(),
      settings: gpu.settings,
      stats: gpu.stats
    };
  }

  getAllGPUStatus() {
    const status = [];
    
    for (const [id, gpu] of this.gpus) {
      status.push(this.getGPUStatus(id));
    }
    
    return status;
  }

  getTotalHashrate() {
    let total = 0;
    
    for (const [id, gpu] of this.gpus) {
      if (gpu.enabled && gpu.mining) {
        total += gpu.hashrate;
      }
    }
    
    return total;
  }

  getTotalPower() {
    let total = 0;
    
    for (const [id, gpu] of this.gpus) {
      if (gpu.enabled && gpu.mining) {
        total += gpu.power;
      }
    }
    
    return total;
  }

  getAverageEfficiency() {
    const enabledGPUs = Array.from(this.gpus.values())
      .filter(gpu => gpu.enabled && gpu.mining);
    
    if (enabledGPUs.length === 0) return 0;
    
    const totalEfficiency = enabledGPUs.reduce((sum, gpu) => {
      return sum + gpu.getEfficiency();
    }, 0);
    
    return totalEfficiency / enabledGPUs.length;
  }

  async stop() {
    // Stop monitoring
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    if (this.optimizationInterval) {
      clearInterval(this.optimizationInterval);
    }
    
    // Reset all GPUs
    for (const [id, gpu] of this.gpus) {
      await this.resetGPU(gpu);
    }
    
    this.removeAllListeners();
  }
}

module.exports = GPUOptimizer;