// Real Hardware Interface for Mining Operations
// Provides actual GPU/CPU control and monitoring

import EventEmitter from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { createLogger } from '../core/logger.js';

const execAsync = promisify(exec);
const logger = createLogger('hardware-interface');

// Platform-specific GPU control libraries
const GPU_LIBRARIES = {
  nvidia: {
    linux: 'nvidia-ml',
    win32: 'nvml.dll',
    darwin: null // NVIDIA not supported on macOS
  },
  amd: {
    linux: 'rocm-smi',
    win32: 'atiadlxx.dll',
    darwin: null // Use Metal on macOS
  }
};

export class HardwareInterface extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      pollingInterval: options.pollingInterval || 5000, // 5 seconds
      temperatureLimit: options.temperatureLimit || 83,
      powerLimit: options.powerLimit || 300, // Watts
      enableOverclocking: options.enableOverclocking || false,
      ...options
    };
    
    this.platform = os.platform();
    this.gpus = new Map();
    this.cpuInfo = null;
    this.monitoring = false;
  }

  async initialize() {
    logger.info('Initializing hardware interface');
    
    // Detect CPU
    this.cpuInfo = await this.detectCPU();
    
    // Detect GPUs
    await this.detectGPUs();
    
    // Start monitoring
    this.startMonitoring();
    
    return this;
  }

  async detectCPU() {
    const cpus = os.cpus();
    const cpuInfo = {
      model: cpus[0]?.model || 'Unknown',
      cores: cpus.length,
      speed: cpus[0]?.speed || 0,
      architecture: os.arch(),
      features: await this.getCPUFeatures()
    };
    
    logger.info(`CPU detected: ${cpuInfo.model} (${cpuInfo.cores} cores)`);
    
    return cpuInfo;
  }

  async getCPUFeatures() {
    const features = new Set();
    
    try {
      if (this.platform === 'linux') {
        const { stdout } = await execAsync('cat /proc/cpuinfo | grep flags | head -1');
        const flags = stdout.split(':')[1]?.trim().split(' ') || [];
        
        // Check for mining-relevant features
        const relevantFeatures = ['sse2', 'sse4_1', 'sse4_2', 'avx', 'avx2', 'aes', 'sha_ni'];
        for (const feature of relevantFeatures) {
          if (flags.includes(feature)) {
            features.add(feature);
          }
        }
      } else if (this.platform === 'win32') {
        // Windows CPU feature detection
        try {
          const { stdout } = await execAsync('wmic cpu get Architecture,Family,MaxClockSpeed /value');
          // Parse Windows output
          features.add('sse2'); // Most modern CPUs have SSE2
        } catch {
          // Fallback
        }
      }
    } catch (error) {
      logger.error('Error detecting CPU features:', error);
    }
    
    return Array.from(features);
  }

  async detectGPUs() {
    logger.info('Detecting GPUs...');
    
    // Detect NVIDIA GPUs
    const nvidiaGPUs = await this.detectNvidiaGPUs();
    for (const gpu of nvidiaGPUs) {
      this.gpus.set(`nvidia-${gpu.index}`, gpu);
    }
    
    // Detect AMD GPUs
    const amdGPUs = await this.detectAMDGPUs();
    for (const gpu of amdGPUs) {
      this.gpus.set(`amd-${gpu.index}`, gpu);
    }
    
    // Detect Intel GPUs
    const intelGPUs = await this.detectIntelGPUs();
    for (const gpu of intelGPUs) {
      this.gpus.set(`intel-${gpu.index}`, gpu);
    }
    
    logger.info(`Detected ${this.gpus.size} GPUs`);
    
    return Array.from(this.gpus.values());
  }

  async detectNvidiaGPUs() {
    const gpus = [];
    
    try {
      // Use nvidia-smi for detection
      const { stdout } = await execAsync('nvidia-smi --query-gpu=index,name,pci.bus_id,memory.total,power.limit,temperature.gpu,compute_cap,driver_version --format=csv,noheader');
      
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const [index, name, pciBusId, memory, powerLimit, temperature, computeCap, driverVersion] = line.split(',').map(s => s.trim());
        
        gpus.push({
          type: 'nvidia',
          index: parseInt(index),
          name: name,
          pciBusId: pciBusId,
          memory: parseInt(memory), // MB
          powerLimit: parseFloat(powerLimit), // W
          temperature: parseInt(temperature), // C
          computeCapability: computeCap,
          driverVersion: driverVersion,
          // Performance state
          performanceState: await this.getNvidiaPerformanceState(index),
          // Clock speeds
          clocks: await this.getNvidiaClocks(index),
          // Fan speed
          fanSpeed: await this.getNvidiaFanSpeed(index)
        });
      }
      
      logger.info(`Found ${gpus.length} NVIDIA GPUs`);
    } catch (error) {
      logger.debug('NVIDIA GPU detection failed:', error.message);
    }
    
    return gpus;
  }

  async getNvidiaPerformanceState(index) {
    try {
      const { stdout } = await execAsync(`nvidia-smi -i ${index} --query-gpu=pstate --format=csv,noheader`);
      return stdout.trim();
    } catch {
      return 'P0';
    }
  }

  async getNvidiaClocks(index) {
    try {
      const { stdout } = await execAsync(`nvidia-smi -i ${index} --query-gpu=clocks.gr,clocks.mem --format=csv,noheader`);
      const [core, memory] = stdout.trim().split(',').map(s => parseInt(s));
      return { core, memory };
    } catch {
      return { core: 0, memory: 0 };
    }
  }

  async getNvidiaFanSpeed(index) {
    try {
      const { stdout } = await execAsync(`nvidia-smi -i ${index} --query-gpu=fan.speed --format=csv,noheader`);
      return parseInt(stdout.trim());
    } catch {
      return 0;
    }
  }

  async detectAMDGPUs() {
    const gpus = [];
    
    try {
      if (this.platform === 'linux') {
        // Use rocm-smi for AMD GPUs on Linux
        const { stdout } = await execAsync('rocm-smi --showid --showtemp --showpower --showmeminfo vram --json');
        const data = JSON.parse(stdout);
        
        for (const [id, info] of Object.entries(data)) {
          if (id !== 'system') {
            gpus.push({
              type: 'amd',
              index: parseInt(id),
              name: info.name || 'AMD GPU',
              temperature: info.temperature || 0,
              power: info.power || 0,
              memory: info.vram?.total || 0,
              clocks: {
                core: info.sclk || 0,
                memory: info.mclk || 0
              },
              fanSpeed: info.fan || 0
            });
          }
        }
      } else if (this.platform === 'win32') {
        // Use ADL SDK on Windows
        // This would require native bindings to ADL
        logger.debug('AMD GPU detection on Windows requires ADL SDK');
      }
      
      logger.info(`Found ${gpus.length} AMD GPUs`);
    } catch (error) {
      logger.debug('AMD GPU detection failed:', error.message);
    }
    
    return gpus;
  }

  async detectIntelGPUs() {
    const gpus = [];
    
    try {
      if (this.platform === 'linux') {
        // Check for Intel integrated graphics
        const { stdout } = await execAsync('lspci | grep -i "vga\\|3d\\|display" | grep -i intel');
        const lines = stdout.trim().split('\n');
        
        for (let i = 0; i < lines.length; i++) {
          gpus.push({
            type: 'intel',
            index: i,
            name: 'Intel Integrated Graphics',
            integrated: true
          });
        }
      } else if (this.platform === 'win32') {
        // Use WMI on Windows
        const { stdout } = await execAsync('wmic path win32_videocontroller get name,status,videoprocessor /format:csv');
        // Parse output for Intel GPUs
      }
      
      logger.info(`Found ${gpus.length} Intel GPUs`);
    } catch (error) {
      logger.debug('Intel GPU detection failed:', error.message);
    }
    
    return gpus;
  }

  // GPU Control Methods
  async setGPUPowerLimit(gpuId, powerLimit) {
    const gpu = this.gpus.get(gpuId);
    if (!gpu) {
      throw new Error(`GPU ${gpuId} not found`);
    }
    
    if (!this.config.enableOverclocking) {
      throw new Error('Overclocking is disabled');
    }
    
    logger.info(`Setting power limit for ${gpuId} to ${powerLimit}W`);
    
    if (gpu.type === 'nvidia') {
      await this.setNvidiaPowerLimit(gpu.index, powerLimit);
    } else if (gpu.type === 'amd') {
      await this.setAMDPowerLimit(gpu.index, powerLimit);
    } else {
      throw new Error(`Power limit control not supported for ${gpu.type}`);
    }
    
    gpu.powerLimit = powerLimit;
  }

  async setNvidiaPowerLimit(index, powerLimit) {
    try {
      await execAsync(`nvidia-smi -i ${index} -pl ${powerLimit}`);
      logger.info(`Set NVIDIA GPU ${index} power limit to ${powerLimit}W`);
    } catch (error) {
      throw new Error(`Failed to set power limit: ${error.message}`);
    }
  }

  async setAMDPowerLimit(index, powerLimit) {
    try {
      if (this.platform === 'linux') {
        await execAsync(`rocm-smi -d ${index} --setpoweroverdrive ${powerLimit}`);
        logger.info(`Set AMD GPU ${index} power limit to ${powerLimit}W`);
      } else {
        throw new Error('AMD power limit control not implemented for this platform');
      }
    } catch (error) {
      throw new Error(`Failed to set power limit: ${error.message}`);
    }
  }

  async setGPUClocks(gpuId, coreClock, memoryClock) {
    const gpu = this.gpus.get(gpuId);
    if (!gpu) {
      throw new Error(`GPU ${gpuId} not found`);
    }
    
    if (!this.config.enableOverclocking) {
      throw new Error('Overclocking is disabled');
    }
    
    logger.info(`Setting clocks for ${gpuId}: Core=${coreClock}MHz, Memory=${memoryClock}MHz`);
    
    if (gpu.type === 'nvidia') {
      await this.setNvidiaClocks(gpu.index, coreClock, memoryClock);
    } else if (gpu.type === 'amd') {
      await this.setAMDClocks(gpu.index, coreClock, memoryClock);
    } else {
      throw new Error(`Clock control not supported for ${gpu.type}`);
    }
    
    gpu.clocks = { core: coreClock, memory: memoryClock };
  }

  async setNvidiaClocks(index, coreClock, memoryClock) {
    try {
      // Enable persistence mode
      await execAsync(`nvidia-smi -i ${index} -pm 1`);
      
      // Set application clocks
      await execAsync(`nvidia-smi -i ${index} -ac ${memoryClock},${coreClock}`);
      
      logger.info(`Set NVIDIA GPU ${index} clocks: Core=${coreClock}MHz, Memory=${memoryClock}MHz`);
    } catch (error) {
      throw new Error(`Failed to set clocks: ${error.message}`);
    }
  }

  async setAMDClocks(index, coreClock, memoryClock) {
    try {
      if (this.platform === 'linux') {
        // Set GPU clock
        await execAsync(`rocm-smi -d ${index} --setsclk ${coreClock}`);
        
        // Set memory clock
        await execAsync(`rocm-smi -d ${index} --setmclk ${memoryClock}`);
        
        logger.info(`Set AMD GPU ${index} clocks: Core=${coreClock}MHz, Memory=${memoryClock}MHz`);
      } else {
        throw new Error('AMD clock control not implemented for this platform');
      }
    } catch (error) {
      throw new Error(`Failed to set clocks: ${error.message}`);
    }
  }

  async setGPUFanSpeed(gpuId, fanSpeed) {
    const gpu = this.gpus.get(gpuId);
    if (!gpu) {
      throw new Error(`GPU ${gpuId} not found`);
    }
    
    logger.info(`Setting fan speed for ${gpuId} to ${fanSpeed}%`);
    
    if (gpu.type === 'nvidia') {
      await this.setNvidiaFanSpeed(gpu.index, fanSpeed);
    } else if (gpu.type === 'amd') {
      await this.setAMDFanSpeed(gpu.index, fanSpeed);
    } else {
      throw new Error(`Fan control not supported for ${gpu.type}`);
    }
    
    gpu.fanSpeed = fanSpeed;
  }

  async setNvidiaFanSpeed(index, fanSpeed) {
    try {
      // NVIDIA fan control requires X server on Linux
      if (this.platform === 'linux') {
        await execAsync(`nvidia-settings -a "[gpu:${index}]/GPUFanControlState=1" -a "[fan:${index}]/GPUTargetFanSpeed=${fanSpeed}"`);
      } else {
        throw new Error('NVIDIA fan control not implemented for this platform');
      }
    } catch (error) {
      throw new Error(`Failed to set fan speed: ${error.message}`);
    }
  }

  async setAMDFanSpeed(index, fanSpeed) {
    try {
      if (this.platform === 'linux') {
        await execAsync(`rocm-smi -d ${index} --setfan ${fanSpeed}`);
        logger.info(`Set AMD GPU ${index} fan speed to ${fanSpeed}%`);
      } else {
        throw new Error('AMD fan control not implemented for this platform');
      }
    } catch (error) {
      throw new Error(`Failed to set fan speed: ${error.message}`);
    }
  }

  // Monitoring Methods
  startMonitoring() {
    if (this.monitoring) return;
    
    this.monitoring = true;
    this.monitoringInterval = setInterval(() => {
      this.updateHardwareStats();
    }, this.config.pollingInterval);
    
    logger.info('Hardware monitoring started');
  }

  stopMonitoring() {
    if (!this.monitoring) return;
    
    this.monitoring = false;
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    logger.info('Hardware monitoring stopped');
  }

  async updateHardwareStats() {
    try {
      // Update CPU stats
      await this.updateCPUStats();
      
      // Update GPU stats
      for (const [id, gpu] of this.gpus) {
        await this.updateGPUStats(id, gpu);
      }
      
      this.emit('hardware-update', this.getStatistics());
    } catch (error) {
      logger.error('Error updating hardware stats:', error);
    }
  }

  async updateCPUStats() {
    const cpus = os.cpus();
    const loadAvg = os.loadavg();
    
    this.cpuInfo.usage = this.calculateCPUUsage(cpus);
    this.cpuInfo.loadAverage = loadAvg[0]; // 1-minute average
    this.cpuInfo.temperature = await this.getCPUTemperature();
  }

  calculateCPUUsage(cpus) {
    let totalIdle = 0;
    let totalTick = 0;
    
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    }
    
    return 100 - ~~(100 * totalIdle / totalTick);
  }

  async getCPUTemperature() {
    try {
      if (this.platform === 'linux') {
        const { stdout } = await execAsync('sensors -j');
        const data = JSON.parse(stdout);
        
        // Parse temperature from sensors output
        for (const [chip, values] of Object.entries(data)) {
          if (chip.includes('coretemp') || chip.includes('k10temp')) {
            for (const [key, value] of Object.entries(values)) {
              if (key.includes('Package') || key.includes('Tdie')) {
                return value[`${key}_input`];
              }
            }
          }
        }
      } else if (this.platform === 'win32') {
        // Windows temperature monitoring requires WMI or OpenHardwareMonitor
        return 0;
      }
    } catch (error) {
      logger.debug('CPU temperature reading failed:', error.message);
    }
    
    return 0;
  }

  async updateGPUStats(id, gpu) {
    try {
      if (gpu.type === 'nvidia') {
        await this.updateNvidiaStats(gpu);
      } else if (gpu.type === 'amd') {
        await this.updateAMDStats(gpu);
      }
      
      // Check for thermal throttling
      if (gpu.temperature > this.config.temperatureLimit) {
        this.emit('thermal-throttle', { gpuId: id, temperature: gpu.temperature });
      }
    } catch (error) {
      logger.error(`Error updating stats for GPU ${id}:`, error);
    }
  }

  async updateNvidiaStats(gpu) {
    try {
      const { stdout } = await execAsync(`nvidia-smi -i ${gpu.index} --query-gpu=temperature.gpu,power.draw,clocks.gr,clocks.mem,fan.speed,utilization.gpu,utilization.memory --format=csv,noheader`);
      
      const [temp, power, coreClock, memClock, fanSpeed, gpuUtil, memUtil] = stdout.trim().split(',').map(s => s.trim());
      
      gpu.temperature = parseInt(temp);
      gpu.power = parseFloat(power);
      gpu.clocks = {
        core: parseInt(coreClock),
        memory: parseInt(memClock)
      };
      gpu.fanSpeed = parseInt(fanSpeed);
      gpu.utilization = {
        gpu: parseInt(gpuUtil),
        memory: parseInt(memUtil)
      };
    } catch (error) {
      logger.error(`Failed to update NVIDIA GPU ${gpu.index} stats:`, error);
    }
  }

  async updateAMDStats(gpu) {
    try {
      if (this.platform === 'linux') {
        const { stdout } = await execAsync(`rocm-smi -d ${gpu.index} --showtemp --showpower --showuse --showmemuse --json`);
        const data = JSON.parse(stdout);
        
        const info = data[gpu.index.toString()];
        if (info) {
          gpu.temperature = info.temperature || gpu.temperature;
          gpu.power = info.power || gpu.power;
          gpu.utilization = {
            gpu: info.use || 0,
            memory: info.memuse || 0
          };
        }
      }
    } catch (error) {
      logger.error(`Failed to update AMD GPU ${gpu.index} stats:`, error);
    }
  }

  // Utility Methods
  getStatistics() {
    const stats = {
      cpu: {
        ...this.cpuInfo,
        uptime: os.uptime(),
        freeMemory: os.freemem(),
        totalMemory: os.totalmem()
      },
      gpus: {}
    };
    
    for (const [id, gpu] of this.gpus) {
      stats.gpus[id] = {
        type: gpu.type,
        name: gpu.name,
        index: gpu.index,
        temperature: gpu.temperature || 0,
        power: gpu.power || 0,
        clocks: gpu.clocks || { core: 0, memory: 0 },
        fanSpeed: gpu.fanSpeed || 0,
        utilization: gpu.utilization || { gpu: 0, memory: 0 },
        memory: gpu.memory || 0
      };
    }
    
    return stats;
  }

  async applyMiningProfile(profile) {
    logger.info(`Applying mining profile: ${profile.name}`);
    
    for (const [gpuId, settings] of Object.entries(profile.gpus || {})) {
      const gpu = this.gpus.get(gpuId);
      if (!gpu) continue;
      
      try {
        if (settings.powerLimit) {
          await this.setGPUPowerLimit(gpuId, settings.powerLimit);
        }
        
        if (settings.coreClock && settings.memoryClock) {
          await this.setGPUClocks(gpuId, settings.coreClock, settings.memoryClock);
        }
        
        if (settings.fanSpeed) {
          await this.setGPUFanSpeed(gpuId, settings.fanSpeed);
        }
      } catch (error) {
        logger.error(`Failed to apply profile to GPU ${gpuId}:`, error);
      }
    }
  }

  async resetGPUSettings(gpuId) {
    const gpu = this.gpus.get(gpuId);
    if (!gpu) {
      throw new Error(`GPU ${gpuId} not found`);
    }
    
    logger.info(`Resetting GPU ${gpuId} to default settings`);
    
    if (gpu.type === 'nvidia') {
      try {
        // Reset power limit
        await execAsync(`nvidia-smi -i ${gpu.index} -pl 0`);
        
        // Reset clocks
        await execAsync(`nvidia-smi -i ${gpu.index} -rac`);
        
        // Disable persistence mode
        await execAsync(`nvidia-smi -i ${gpu.index} -pm 0`);
      } catch (error) {
        logger.error(`Failed to reset NVIDIA GPU ${gpu.index}:`, error);
      }
    } else if (gpu.type === 'amd') {
      try {
        // Reset to default profile
        await execAsync(`rocm-smi -d ${gpu.index} --resetprofile`);
      } catch (error) {
        logger.error(`Failed to reset AMD GPU ${gpu.index}:`, error);
      }
    }
  }

  async shutdown() {
    logger.info('Shutting down hardware interface');
    
    this.stopMonitoring();
    
    // Reset all GPUs to default settings
    for (const [gpuId] of this.gpus) {
      try {
        await this.resetGPUSettings(gpuId);
      } catch (error) {
        logger.error(`Error resetting GPU ${gpuId}:`, error);
      }
    }
  }
}

export default HardwareInterface;