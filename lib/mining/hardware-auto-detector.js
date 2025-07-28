/**
 * Hardware Auto-Detection and Optimization System for Otedama
 * Automatically detects and optimizes CPU, GPU, and ASIC mining hardware
 * 
 * Design:
 * - Carmack: Fast hardware detection with minimal overhead
 * - Martin: Clean abstraction for different hardware types
 * - Pike: Simple interface for complex hardware management
 */

import { EventEmitter } from 'events';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { createStructuredLogger } from '../core/structured-logger.js';
import { readFile } from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);
const logger = createStructuredLogger('HardwareAutoDetector');

/**
 * Hardware types
 */
export const HardwareType = {
  CPU: 'cpu',
  GPU_NVIDIA: 'gpu_nvidia',
  GPU_AMD: 'gpu_amd',
  ASIC: 'asic',
  UNKNOWN: 'unknown'
};

/**
 * Mining algorithms by hardware type
 */
export const HardwareAlgorithms = {
  [HardwareType.CPU]: ['randomx', 'argon2', 'yescrypt'],
  [HardwareType.GPU_NVIDIA]: ['ethash', 'kawpow', 'octopus', 'autolykos2'],
  [HardwareType.GPU_AMD]: ['ethash', 'kawpow', 'autolykos2'],
  [HardwareType.ASIC]: ['sha256', 'scrypt', 'x11', 'blake2s']
};

/**
 * Hardware capability information
 */
export class HardwareCapability {
  constructor(type, id, name) {
    this.type = type;
    this.id = id;
    this.name = name;
    this.enabled = true;
    this.temperature = 0;
    this.power = 0;
    this.hashrate = 0;
    this.memory = 0;
    this.compute = 0;
    this.algorithms = [];
    this.optimizations = {};
  }
}

/**
 * Hardware Auto-Detection System
 */
export class HardwareAutoDetector extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Detection settings
      detectCPU: options.detectCPU !== false,
      detectGPU: options.detectGPU !== false,
      detectASIC: options.detectASIC !== false,
      
      // Optimization settings
      autoOptimize: options.autoOptimize !== false,
      temperatureTarget: options.temperatureTarget || 75, // Celsius
      powerLimit: options.powerLimit || null, // Watts
      
      // Performance settings
      benchmarkDuration: options.benchmarkDuration || 60000, // 1 minute
      optimizationIterations: options.optimizationIterations || 5,
      
      // Update intervals
      statusUpdateInterval: options.statusUpdateInterval || 5000, // 5 seconds
      temperatureCheckInterval: options.temperatureCheckInterval || 10000, // 10 seconds
      
      ...options
    };
    
    // Detected hardware
    this.hardware = new Map();
    this.cpuInfo = null;
    this.gpuInfo = [];
    this.asicInfo = [];
    
    // Optimization state
    this.optimizationProfiles = new Map();
    this.currentOptimizations = new Map();
    
    // Monitoring
    this.monitoringEnabled = false;
    this.statusTimer = null;
    this.temperatureTimer = null;
    
    // Statistics
    this.stats = {
      detectedDevices: 0,
      cpuCores: 0,
      gpuCount: 0,
      asicCount: 0,
      totalHashrate: 0,
      totalPower: 0
    };
  }
  
  /**
   * Initialize hardware detection
   */
  async initialize() {
    logger.info('Initializing hardware auto-detection system');
    
    try {
      // Detect all hardware
      await this.detectAllHardware();
      
      // Load optimization profiles
      await this.loadOptimizationProfiles();
      
      // Apply auto-optimizations if enabled
      if (this.config.autoOptimize) {
        await this.optimizeAllHardware();
      }
      
      // Start monitoring
      this.startMonitoring();
      
      logger.info('Hardware detection completed', {
        devices: this.stats.detectedDevices,
        cpuCores: this.stats.cpuCores,
        gpuCount: this.stats.gpuCount,
        asicCount: this.stats.asicCount
      });
      
      this.emit('initialized', this.getHardwareSummary());
    } catch (error) {
      logger.error('Hardware detection failed:', error);
      throw error;
    }
  }
  
  /**
   * Detect all hardware
   */
  async detectAllHardware() {
    const detectionPromises = [];
    
    if (this.config.detectCPU) {
      detectionPromises.push(this.detectCPU());
    }
    
    if (this.config.detectGPU) {
      detectionPromises.push(this.detectGPU());
    }
    
    if (this.config.detectASIC) {
      detectionPromises.push(this.detectASIC());
    }
    
    await Promise.all(detectionPromises);
  }
  
  /**
   * Detect CPU hardware
   */
  async detectCPU() {
    logger.info('Detecting CPU hardware');
    
    try {
      const cpus = os.cpus();
      const cpuModel = cpus[0].model;
      const coreCount = cpus.length;
      
      // Get detailed CPU info
      let cpuDetails = {
        model: cpuModel,
        cores: coreCount,
        threads: coreCount,
        speed: cpus[0].speed,
        architecture: os.arch(),
        cache: await this.getCPUCache(),
        features: await this.getCPUFeatures()
      };
      
      // Detect hyper-threading
      if (process.platform === 'linux') {
        try {
          const { stdout } = await execAsync('lscpu | grep "Thread(s) per core:" | awk \'{print $4}\''');
          const threadsPerCore = parseInt(stdout.trim()) || 1;
          cpuDetails.threads = cpuDetails.cores * threadsPerCore;
        } catch (error) {
          // Fallback to core count
        }
      }
      
      // Create CPU hardware entry
      const cpu = new HardwareCapability(
        HardwareType.CPU,
        'cpu-0',
        cpuModel
      );
      
      cpu.cores = cpuDetails.cores;
      cpu.threads = cpuDetails.threads;
      cpu.compute = cpuDetails.speed * cpuDetails.threads;
      cpu.algorithms = HardwareAlgorithms[HardwareType.CPU];
      cpu.features = cpuDetails.features;
      
      // Determine optimal algorithms based on CPU features
      if (cpuDetails.features.includes('aes')) {
        cpu.algorithms.push('cryptonight');
      }
      if (cpuDetails.features.includes('avx2')) {
        cpu.algorithms.push('randomx');
      }
      
      this.hardware.set(cpu.id, cpu);
      this.cpuInfo = cpuDetails;
      this.stats.cpuCores = cpu.threads;
      this.stats.detectedDevices++;
      
      logger.info('CPU detected', {
        model: cpu.name,
        cores: cpu.cores,
        threads: cpu.threads
      });
      
      this.emit('hardware:detected', cpu);
    } catch (error) {
      logger.error('CPU detection failed:', error);
    }
  }
  
  /**
   * Get CPU cache information
   */
  async getCPUCache() {
    if (process.platform === 'linux') {
      try {
        const { stdout } = await execAsync('lscpu | grep cache');
        const cacheInfo = {};
        
        const lines = stdout.split('\n');
        for (const line of lines) {
          if (line.includes('L1d')) {
            cacheInfo.l1d = line.split(':')[1].trim();
          } else if (line.includes('L1i')) {
            cacheInfo.l1i = line.split(':')[1].trim();
          } else if (line.includes('L2')) {
            cacheInfo.l2 = line.split(':')[1].trim();
          } else if (line.includes('L3')) {
            cacheInfo.l3 = line.split(':')[1].trim();
          }
        }
        
        return cacheInfo;
      } catch (error) {
        return {};
      }
    }
    return {};
  }
  
  /**
   * Get CPU features
   */
  async getCPUFeatures() {
    const features = [];
    
    if (process.platform === 'linux') {
      try {
        const { stdout } = await execAsync('cat /proc/cpuinfo | grep flags | head -1');
        const flags = stdout.split(':')[1].trim().split(' ');
        
        // Important features for mining
        const importantFeatures = ['aes', 'avx', 'avx2', 'sse4_1', 'sse4_2', 'ssse3'];
        
        for (const feature of importantFeatures) {
          if (flags.includes(feature)) {
            features.push(feature);
          }
        }
      } catch (error) {
        // Fallback
      }
    } else if (process.platform === 'win32') {
      // Windows CPU feature detection
      try {
        const { stdout } = await execAsync('wmic cpu get name,numberofcores,numberoflogicalprocessors /format:list');
        // Parse Windows output
      } catch (error) {
        // Fallback
      }
    }
    
    return features;
  }
  
  /**
   * Detect GPU hardware
   */
  async detectGPU() {
    logger.info('Detecting GPU hardware');
    
    // Detect NVIDIA GPUs
    await this.detectNvidiaGPUs();
    
    // Detect AMD GPUs
    await this.detectAMDGPUs();
  }
  
  /**
   * Detect NVIDIA GPUs
   */
  async detectNvidiaGPUs() {
    try {
      // Check if nvidia-smi is available
      const { stdout } = await execAsync('nvidia-smi --query-gpu=index,name,memory.total,compute_cap,power.draw,temperature.gpu --format=csv,noheader,nounits');
      
      const lines = stdout.trim().split('\n');
      
      for (const line of lines) {
        const [index, name, memory, computeCap, power, temperature] = line.split(', ');
        
        const gpu = new HardwareCapability(
          HardwareType.GPU_NVIDIA,
          `gpu-nvidia-${index}`,
          name.trim()
        );
        
        gpu.index = parseInt(index);
        gpu.memory = parseInt(memory) * 1024 * 1024; // Convert to KB
        gpu.compute = parseFloat(computeCap);
        gpu.power = parseFloat(power) || 0;
        gpu.temperature = parseFloat(temperature) || 0;
        gpu.algorithms = HardwareAlgorithms[HardwareType.GPU_NVIDIA];
        
        // Determine optimal algorithms based on GPU model
        if (name.includes('RTX 30') || name.includes('RTX 40')) {
          gpu.algorithms.push('kawpow', 'octopus');
        } else if (name.includes('GTX 16') || name.includes('RTX 20')) {
          gpu.algorithms.push('ethash', 'kawpow');
        }
        
        this.hardware.set(gpu.id, gpu);
        this.gpuInfo.push(gpu);
        this.stats.gpuCount++;
        this.stats.detectedDevices++;
        
        logger.info('NVIDIA GPU detected', {
          index: gpu.index,
          name: gpu.name,
          memory: `${Math.round(gpu.memory / 1024 / 1024)}MB`,
          computeCap: gpu.compute
        });
        
        this.emit('hardware:detected', gpu);
      }
    } catch (error) {
      logger.debug('No NVIDIA GPUs detected or nvidia-smi not available');
    }
  }
  
  /**
   * Detect AMD GPUs
   */
  async detectAMDGPUs() {
    try {
      let command;
      
      if (process.platform === 'linux') {
        command = 'rocm-smi --showid --showtemp --showpower --showmeminfo vram --csv';
      } else if (process.platform === 'win32') {
        // Use AMD's GPU-Z or similar tool
        return;
      } else {
        return;
      }
      
      const { stdout } = await execAsync(command);
      const lines = stdout.trim().split('\n');
      
      // Skip header
      const dataLines = lines.slice(1);
      
      for (let i = 0; i < dataLines.length; i++) {
        const data = dataLines[i].split(',');
        
        const gpu = new HardwareCapability(
          HardwareType.GPU_AMD,
          `gpu-amd-${i}`,
          `AMD GPU ${i}`
        );
        
        gpu.index = i;
        gpu.temperature = parseFloat(data[1]) || 0;
        gpu.power = parseFloat(data[2]) || 0;
        gpu.memory = parseFloat(data[3]) * 1024 * 1024 || 0; // Convert to KB
        gpu.algorithms = HardwareAlgorithms[HardwareType.GPU_AMD];
        
        this.hardware.set(gpu.id, gpu);
        this.gpuInfo.push(gpu);
        this.stats.gpuCount++;
        this.stats.detectedDevices++;
        
        logger.info('AMD GPU detected', {
          index: gpu.index,
          name: gpu.name,
          memory: `${Math.round(gpu.memory / 1024 / 1024)}MB`
        });
        
        this.emit('hardware:detected', gpu);
      }
    } catch (error) {
      logger.debug('No AMD GPUs detected or rocm-smi not available');
    }
  }
  
  /**
   * Detect ASIC hardware
   */
  async detectASIC() {
    logger.info('Detecting ASIC hardware');
    
    try {
      // Check common ASIC connection methods
      
      // 1. Check USB devices for common ASIC controllers
      if (process.platform === 'linux') {
        const { stdout } = await execAsync('lsusb | grep -E "(CP210|FTDI|Silicon Labs)"');
        const usbDevices = stdout.trim().split('\n');
        
        for (let i = 0; i < usbDevices.length; i++) {
          if (usbDevices[i]) {
            const asic = new HardwareCapability(
              HardwareType.ASIC,
              `asic-${i}`,
              'USB ASIC Device'
            );
            
            asic.algorithms = HardwareAlgorithms[HardwareType.ASIC];
            asic.connection = 'USB';
            
            this.hardware.set(asic.id, asic);
            this.asicInfo.push(asic);
            this.stats.asicCount++;
            this.stats.detectedDevices++;
            
            logger.info('ASIC detected via USB');
            this.emit('hardware:detected', asic);
          }
        }
      }
      
      // 2. Check network for ASIC miners (common ports)
      // This would scan local network for ASIC devices
      // Implemented based on specific ASIC models
      
    } catch (error) {
      logger.debug('No ASIC devices detected');
    }
  }
  
  /**
   * Load optimization profiles
   */
  async loadOptimizationProfiles() {
    // Load predefined optimization profiles for known hardware
    
    // NVIDIA profiles
    this.optimizationProfiles.set('RTX 3080', {
      core: '+100',
      memory: '+1000',
      powerLimit: '220',
      targetTemp: '70'
    });
    
    this.optimizationProfiles.set('RTX 3070', {
      core: '+50',
      memory: '+1200',
      powerLimit: '130',
      targetTemp: '70'
    });
    
    this.optimizationProfiles.set('RTX 3060 Ti', {
      core: '0',
      memory: '+1300',
      powerLimit: '120',
      targetTemp: '70'
    });
    
    // AMD profiles
    this.optimizationProfiles.set('RX 6800 XT', {
      core: '1150',
      memory: '2150',
      powerLimit: '150',
      targetTemp: '70'
    });
    
    this.optimizationProfiles.set('RX 6700 XT', {
      core: '1100',
      memory: '2100',
      powerLimit: '120',
      targetTemp: '70'
    });
    
    logger.info(`Loaded ${this.optimizationProfiles.size} optimization profiles`);
  }
  
  /**
   * Optimize all hardware
   */
  async optimizeAllHardware() {
    logger.info('Optimizing all hardware');
    
    const optimizationPromises = [];
    
    for (const [id, hardware] of this.hardware) {
      if (hardware.type !== HardwareType.ASIC) {
        optimizationPromises.push(this.optimizeHardware(hardware));
      }
    }
    
    await Promise.all(optimizationPromises);
  }
  
  /**
   * Optimize specific hardware
   */
  async optimizeHardware(hardware) {
    logger.info(`Optimizing ${hardware.type} ${hardware.name}`);
    
    try {
      switch (hardware.type) {
        case HardwareType.CPU:
          await this.optimizeCPU(hardware);
          break;
          
        case HardwareType.GPU_NVIDIA:
          await this.optimizeNvidiaGPU(hardware);
          break;
          
        case HardwareType.GPU_AMD:
          await this.optimizeAMDGPU(hardware);
          break;
      }
      
      this.emit('hardware:optimized', hardware);
    } catch (error) {
      logger.error(`Failed to optimize ${hardware.id}:`, error);
    }
  }
  
  /**
   * Optimize CPU
   */
  async optimizeCPU(cpu) {
    const optimizations = {};
    
    // Set CPU affinity for mining threads
    const miningThreads = Math.max(1, cpu.threads - 1); // Leave 1 thread for system
    optimizations.threads = miningThreads;
    
    // Set process priority
    if (process.platform === 'linux') {
      try {
        await execAsync(`renice -n 10 -p ${process.pid}`);
        optimizations.priority = 'low';
      } catch (error) {
        logger.warn('Failed to set process priority');
      }
    }
    
    // Enable huge pages if available
    if (process.platform === 'linux') {
      try {
        const { stdout } = await execAsync('cat /proc/meminfo | grep HugePages_Free');
        const hugePages = parseInt(stdout.split(':')[1].trim());
        
        if (hugePages > 0) {
          optimizations.hugePages = true;
        }
      } catch (error) {
        // Huge pages not available
      }
    }
    
    cpu.optimizations = optimizations;
    this.currentOptimizations.set(cpu.id, optimizations);
    
    logger.info('CPU optimized', optimizations);
  }
  
  /**
   * Optimize NVIDIA GPU
   */
  async optimizeNvidiaGPU(gpu) {
    const optimizations = {};
    
    // Check for known optimization profile
    let profile = null;
    for (const [model, settings] of this.optimizationProfiles) {
      if (gpu.name.includes(model)) {
        profile = settings;
        break;
      }
    }
    
    if (profile) {
      // Apply profile settings
      try {
        // Set power limit
        if (profile.powerLimit) {
          await execAsync(`nvidia-smi -i ${gpu.index} -pl ${profile.powerLimit}`);
          optimizations.powerLimit = profile.powerLimit;
        }
        
        // Set memory and core clocks (requires nvidia-settings on Linux)
        if (process.platform === 'linux') {
          if (profile.memory) {
            await execAsync(`nvidia-settings -a "[gpu:${gpu.index}]/GPUMemoryTransferRateOffset[3]=${profile.memory}"`);
            optimizations.memoryOffset = profile.memory;
          }
          
          if (profile.core) {
            await execAsync(`nvidia-settings -a "[gpu:${gpu.index}]/GPUGraphicsClockOffset[3]=${profile.core}"`);
            optimizations.coreOffset = profile.core;
          }
        }
        
        // Set fan curve for target temperature
        await this.setGPUFanCurve(gpu, profile.targetTemp || this.config.temperatureTarget);
        optimizations.targetTemp = profile.targetTemp || this.config.temperatureTarget;
        
      } catch (error) {
        logger.error(`Failed to apply optimization profile for ${gpu.name}:`, error);
      }
    } else {
      // Generic optimization
      try {
        // Conservative power limit
        const powerLimit = Math.round(gpu.power * 0.8);
        await execAsync(`nvidia-smi -i ${gpu.index} -pl ${powerLimit}`);
        optimizations.powerLimit = powerLimit;
        
        // Set fan curve
        await this.setGPUFanCurve(gpu, this.config.temperatureTarget);
        optimizations.targetTemp = this.config.temperatureTarget;
        
      } catch (error) {
        logger.error(`Failed to apply generic optimizations for ${gpu.name}:`, error);
      }
    }
    
    gpu.optimizations = optimizations;
    this.currentOptimizations.set(gpu.id, optimizations);
    
    logger.info(`NVIDIA GPU ${gpu.name} optimized`, optimizations);
  }
  
  /**
   * Optimize AMD GPU
   */
  async optimizeAMDGPU(gpu) {
    const optimizations = {};
    
    // AMD GPU optimization using rocm-smi
    if (process.platform === 'linux') {
      try {
        // Set power limit
        const powerLimit = this.config.powerLimit || Math.round(gpu.power * 0.8);
        await execAsync(`rocm-smi --device ${gpu.index} --setpoweroverdrive ${powerLimit}`);
        optimizations.powerLimit = powerLimit;
        
        // Set fan speed for temperature target
        const fanSpeed = this.calculateFanSpeed(gpu.temperature, this.config.temperatureTarget);
        await execAsync(`rocm-smi --device ${gpu.index} --setfan ${fanSpeed}%`);
        optimizations.fanSpeed = fanSpeed;
        
      } catch (error) {
        logger.error(`Failed to optimize AMD GPU ${gpu.name}:`, error);
      }
    }
    
    gpu.optimizations = optimizations;
    this.currentOptimizations.set(gpu.id, optimizations);
    
    logger.info(`AMD GPU ${gpu.name} optimized`, optimizations);
  }
  
  /**
   * Set GPU fan curve
   */
  async setGPUFanCurve(gpu, targetTemp) {
    try {
      // Simple fan curve: increase fan speed as temperature rises
      const fanSpeed = this.calculateFanSpeed(gpu.temperature, targetTemp);
      
      await execAsync(`nvidia-smi -i ${gpu.index} --gpu-target-fan-speed=${fanSpeed}`);
      
      logger.debug(`Set GPU ${gpu.index} fan speed to ${fanSpeed}%`);
    } catch (error) {
      logger.error('Failed to set GPU fan curve:', error);
    }
  }
  
  /**
   * Calculate fan speed based on temperature
   */
  calculateFanSpeed(currentTemp, targetTemp) {
    if (currentTemp <= targetTemp - 10) {
      return 30; // Minimum fan speed
    } else if (currentTemp >= targetTemp + 10) {
      return 100; // Maximum fan speed
    } else {
      // Linear interpolation
      const ratio = (currentTemp - (targetTemp - 10)) / 20;
      return Math.round(30 + (70 * ratio));
    }
  }
  
  /**
   * Start hardware monitoring
   */
  startMonitoring() {
    this.monitoringEnabled = true;
    
    // Status updates
    this.statusTimer = setInterval(() => {
      this.updateHardwareStatus();
    }, this.config.statusUpdateInterval);
    
    // Temperature monitoring
    this.temperatureTimer = setInterval(() => {
      this.checkTemperatures();
    }, this.config.temperatureCheckInterval);
    
    logger.info('Hardware monitoring started');
  }
  
  /**
   * Update hardware status
   */
  async updateHardwareStatus() {
    for (const [id, hardware] of this.hardware) {
      try {
        switch (hardware.type) {
          case HardwareType.CPU:
            await this.updateCPUStatus(hardware);
            break;
            
          case HardwareType.GPU_NVIDIA:
            await this.updateNvidiaGPUStatus(hardware);
            break;
            
          case HardwareType.GPU_AMD:
            await this.updateAMDGPUStatus(hardware);
            break;
        }
      } catch (error) {
        logger.error(`Failed to update status for ${id}:`, error);
      }
    }
    
    // Calculate total stats
    this.calculateTotalStats();
    
    this.emit('status:updated', this.getHardwareSummary());
  }
  
  /**
   * Update CPU status
   */
  async updateCPUStatus(cpu) {
    // Get CPU usage
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(core => {
      for (const type in core.times) {
        totalTick += core.times[type];
      }
      totalIdle += core.times.idle;
    });
    
    cpu.usage = 100 - Math.round(100 * totalIdle / totalTick);
    
    // Get temperature (Linux only)
    if (process.platform === 'linux') {
      try {
        const { stdout } = await execAsync('sensors | grep "Core 0:" | awk \'{print $3}\' | sed \'s/+//g\' | sed \'s/°C//g\'');
        cpu.temperature = parseFloat(stdout.trim()) || 0;
      } catch (error) {
        // Temperature not available
      }
    }
  }
  
  /**
   * Update NVIDIA GPU status
   */
  async updateNvidiaGPUStatus(gpu) {
    try {
      const { stdout } = await execAsync(
        `nvidia-smi --query-gpu=power.draw,temperature.gpu,utilization.gpu,memory.used --format=csv,noheader,nounits -i ${gpu.index}`
      );
      
      const [power, temp, utilization, memoryUsed] = stdout.trim().split(', ');
      
      gpu.power = parseFloat(power) || 0;
      gpu.temperature = parseFloat(temp) || 0;
      gpu.usage = parseFloat(utilization) || 0;
      gpu.memoryUsed = parseFloat(memoryUsed) * 1024 * 1024 || 0; // Convert to KB
      
    } catch (error) {
      logger.error(`Failed to update NVIDIA GPU ${gpu.index} status:`, error);
    }
  }
  
  /**
   * Update AMD GPU status
   */
  async updateAMDGPUStatus(gpu) {
    if (process.platform === 'linux') {
      try {
        const { stdout } = await execAsync(
          `rocm-smi --device ${gpu.index} --showtemp --showpower --showuse --showmemuse --csv`
        );
        
        const lines = stdout.trim().split('\n');
        const data = lines[1].split(','); // Skip header
        
        gpu.temperature = parseFloat(data[1]) || 0;
        gpu.power = parseFloat(data[2]) || 0;
        gpu.usage = parseFloat(data[3]) || 0;
        gpu.memoryUsed = parseFloat(data[4]) * 1024 * 1024 || 0; // Convert to KB
        
      } catch (error) {
        logger.error(`Failed to update AMD GPU ${gpu.index} status:`, error);
      }
    }
  }
  
  /**
   * Check temperatures
   */
  async checkTemperatures() {
    for (const [id, hardware] of this.hardware) {
      if (hardware.temperature > this.config.temperatureTarget + 10) {
        logger.warn(`High temperature on ${hardware.name}: ${hardware.temperature}°C`);
        
        // Attempt to cool down
        if (hardware.type === HardwareType.GPU_NVIDIA || hardware.type === HardwareType.GPU_AMD) {
          await this.adjustCooling(hardware);
        }
        
        this.emit('temperature:high', {
          hardware: id,
          temperature: hardware.temperature,
          target: this.config.temperatureTarget
        });
      }
    }
  }
  
  /**
   * Adjust cooling for overheating hardware
   */
  async adjustCooling(hardware) {
    try {
      const newFanSpeed = Math.min(100, this.calculateFanSpeed(hardware.temperature, this.config.temperatureTarget) + 10);
      
      if (hardware.type === HardwareType.GPU_NVIDIA) {
        await execAsync(`nvidia-smi -i ${hardware.index} --gpu-target-fan-speed=${newFanSpeed}`);
      } else if (hardware.type === HardwareType.GPU_AMD) {
        await execAsync(`rocm-smi --device ${hardware.index} --setfan ${newFanSpeed}%`);
      }
      
      logger.info(`Increased fan speed to ${newFanSpeed}% for ${hardware.name}`);
    } catch (error) {
      logger.error('Failed to adjust cooling:', error);
    }
  }
  
  /**
   * Calculate total statistics
   */
  calculateTotalStats() {
    let totalHashrate = 0;
    let totalPower = 0;
    
    for (const [id, hardware] of this.hardware) {
      totalHashrate += hardware.hashrate || 0;
      totalPower += hardware.power || 0;
    }
    
    this.stats.totalHashrate = totalHashrate;
    this.stats.totalPower = totalPower;
  }
  
  /**
   * Get hardware summary
   */
  getHardwareSummary() {
    const summary = {
      devices: [],
      stats: this.stats,
      totalHashrate: this.stats.totalHashrate,
      totalPower: this.stats.totalPower,
      efficiency: this.stats.totalPower > 0 ? this.stats.totalHashrate / this.stats.totalPower : 0
    };
    
    for (const [id, hardware] of this.hardware) {
      summary.devices.push({
        id: hardware.id,
        type: hardware.type,
        name: hardware.name,
        enabled: hardware.enabled,
        temperature: hardware.temperature,
        power: hardware.power,
        hashrate: hardware.hashrate,
        usage: hardware.usage || 0,
        algorithms: hardware.algorithms,
        optimizations: hardware.optimizations
      });
    }
    
    return summary;
  }
  
  /**
   * Set hardware enabled/disabled
   */
  setHardwareEnabled(hardwareId, enabled) {
    const hardware = this.hardware.get(hardwareId);
    if (hardware) {
      hardware.enabled = enabled;
      logger.info(`Hardware ${hardwareId} ${enabled ? 'enabled' : 'disabled'}`);
      this.emit('hardware:toggled', { id: hardwareId, enabled });
    }
  }
  
  /**
   * Get hardware by type
   */
  getHardwareByType(type) {
    const devices = [];
    
    for (const [id, hardware] of this.hardware) {
      if (hardware.type === type) {
        devices.push(hardware);
      }
    }
    
    return devices;
  }
  
  /**
   * Get best hardware for algorithm
   */
  getBestHardwareForAlgorithm(algorithm) {
    let bestHardware = null;
    let bestScore = 0;
    
    for (const [id, hardware] of this.hardware) {
      if (!hardware.enabled || !hardware.algorithms.includes(algorithm)) {
        continue;
      }
      
      // Calculate score based on expected performance
      let score = 0;
      
      switch (hardware.type) {
        case HardwareType.ASIC:
          if (['sha256', 'scrypt'].includes(algorithm)) {
            score = 1000; // ASICs are best for their specific algorithms
          }
          break;
          
        case HardwareType.GPU_NVIDIA:
        case HardwareType.GPU_AMD:
          if (['ethash', 'kawpow', 'octopus'].includes(algorithm)) {
            score = 100 + (hardware.memory / 1024 / 1024); // Score based on memory
          }
          break;
          
        case HardwareType.CPU:
          if (['randomx', 'argon2'].includes(algorithm)) {
            score = 10 + hardware.threads;
          }
          break;
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestHardware = hardware;
      }
    }
    
    return bestHardware;
  }
  
  /**
   * Benchmark hardware
   */
  async benchmarkHardware(hardwareId, algorithm) {
    const hardware = this.hardware.get(hardwareId);
    if (!hardware) {
      throw new Error('Hardware not found');
    }
    
    logger.info(`Benchmarking ${hardware.name} with ${algorithm}`);
    
    const benchmark = {
      hardware: hardwareId,
      algorithm,
      startTime: Date.now(),
      hashrate: 0,
      power: 0,
      efficiency: 0
    };
    
    this.emit('benchmark:started', benchmark);
    
    // This would run actual mining benchmark
    // Implementation depends on specific mining software integration
    
    // Simulated benchmark result
    await new Promise(resolve => setTimeout(resolve, this.config.benchmarkDuration));
    
    benchmark.endTime = Date.now();
    benchmark.duration = benchmark.endTime - benchmark.startTime;
    benchmark.hashrate = Math.random() * 100 * 1e6; // Simulated hashrate
    benchmark.power = hardware.power;
    benchmark.efficiency = benchmark.power > 0 ? benchmark.hashrate / benchmark.power : 0;
    
    // Store benchmark result
    if (!hardware.benchmarks) {
      hardware.benchmarks = {};
    }
    hardware.benchmarks[algorithm] = benchmark;
    
    logger.info(`Benchmark complete for ${hardware.name}`, {
      algorithm,
      hashrate: `${(benchmark.hashrate / 1e6).toFixed(2)} MH/s`,
      power: `${benchmark.power}W`,
      efficiency: `${(benchmark.efficiency / 1e6).toFixed(2)} MH/W`
    });
    
    this.emit('benchmark:completed', benchmark);
    
    return benchmark;
  }
  
  /**
   * Export hardware configuration
   */
  exportConfiguration() {
    const config = {
      version: '1.0',
      timestamp: Date.now(),
      hardware: []
    };
    
    for (const [id, hardware] of this.hardware) {
      config.hardware.push({
        id: hardware.id,
        type: hardware.type,
        name: hardware.name,
        enabled: hardware.enabled,
        algorithms: hardware.algorithms,
        optimizations: hardware.optimizations,
        benchmarks: hardware.benchmarks || {}
      });
    }
    
    return config;
  }
  
  /**
   * Import hardware configuration
   */
  async importConfiguration(config) {
    if (config.version !== '1.0') {
      throw new Error('Unsupported configuration version');
    }
    
    for (const hwConfig of config.hardware) {
      const hardware = this.hardware.get(hwConfig.id);
      
      if (hardware) {
        hardware.enabled = hwConfig.enabled;
        hardware.algorithms = hwConfig.algorithms;
        hardware.optimizations = hwConfig.optimizations;
        hardware.benchmarks = hwConfig.benchmarks;
        
        // Apply optimizations
        if (this.config.autoOptimize && hardware.optimizations) {
          await this.applyOptimizations(hardware, hardware.optimizations);
        }
      }
    }
    
    logger.info('Hardware configuration imported');
    this.emit('config:imported', config);
  }
  
  /**
   * Apply specific optimizations
   */
  async applyOptimizations(hardware, optimizations) {
    // Apply saved optimizations to hardware
    // Implementation depends on hardware type
    this.currentOptimizations.set(hardware.id, optimizations);
  }
  
  /**
   * Stop monitoring
   */
  stopMonitoring() {
    this.monitoringEnabled = false;
    
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    
    if (this.temperatureTimer) {
      clearInterval(this.temperatureTimer);
      this.temperatureTimer = null;
    }
    
    logger.info('Hardware monitoring stopped');
  }
  
  /**
   * Shutdown hardware detector
   */
  async shutdown() {
    logger.info('Shutting down hardware auto-detector');
    
    this.stopMonitoring();
    
    // Reset any hardware modifications
    for (const [id, hardware] of this.hardware) {
      try {
        // Reset to defaults
        if (hardware.type === HardwareType.GPU_NVIDIA) {
          await execAsync(`nvidia-smi -i ${hardware.index} -pm 0`); // Reset power management
        }
      } catch (error) {
        // Ignore errors during shutdown
      }
    }
    
    this.emit('shutdown');
  }
}

export default HardwareAutoDetector;