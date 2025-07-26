/**
 * Advanced Hardware Optimizer - Otedama
 * Dynamic GPU/ASIC optimization with real-time tuning
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execAsync = promisify(exec);
const logger = createStructuredLogger('HardwareOptimizer');

// Hardware types
export const HardwareType = {
  GPU_NVIDIA: 'gpu_nvidia',
  GPU_AMD: 'gpu_amd',
  GPU_INTEL: 'gpu_intel',
  ASIC_ANTMINER: 'asic_antminer',
  ASIC_WHATSMINER: 'asic_whatsminer',
  ASIC_AVALON: 'asic_avalon',
  FPGA: 'fpga',
  CPU: 'cpu'
};

// Optimization profiles
export const OptimizationProfile = {
  MAX_PERFORMANCE: 'max_performance',
  BALANCED: 'balanced',
  EFFICIENCY: 'efficiency',
  QUIET: 'quiet',
  CUSTOM: 'custom'
};

export class AdvancedHardwareOptimizer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Hardware detection
      autoDetect: options.autoDetect !== false,
      hardwareTypes: options.hardwareTypes || Object.values(HardwareType),
      
      // Optimization settings
      profile: options.profile || OptimizationProfile.BALANCED,
      targetTemperature: options.targetTemperature || 75, // °C
      maxTemperature: options.maxTemperature || 85, // °C
      targetPower: options.targetPower || null, // Watts
      
      // Tuning parameters
      coreClock: {
        min: options.minCoreClock || -200,
        max: options.maxCoreClock || 200,
        step: options.coreClockStep || 10
      },
      memoryClock: {
        min: options.minMemoryClock || -500,
        max: options.maxMemoryClock || 1000,
        step: options.memoryClockStep || 25
      },
      powerLimit: {
        min: options.minPowerLimit || 50,
        max: options.maxPowerLimit || 120,
        step: options.powerLimitStep || 5
      },
      fanSpeed: {
        min: options.minFanSpeed || 30,
        max: options.maxFanSpeed || 100,
        auto: options.autoFan !== false
      },
      voltage: {
        core: options.coreVoltage || null,
        memory: options.memoryVoltage || null,
        autoUnderVolt: options.autoUnderVolt !== false
      },
      
      // Timing settings
      tuningInterval: options.tuningInterval || 60000, // 1 minute
      stabilityTestDuration: options.stabilityTestDuration || 300000, // 5 minutes
      metricsSampleRate: options.metricsSampleRate || 1000, // 1 second
      
      // Features
      adaptiveTuning: options.adaptiveTuning !== false,
      thermalProtection: options.thermalProtection !== false,
      powerEfficiencyMode: options.powerEfficiencyMode || false,
      
      ...options
    };
    
    // Hardware inventory
    this.hardware = new Map();
    this.drivers = new Map();
    
    // Current settings per device
    this.deviceSettings = new Map();
    this.deviceMetrics = new Map();
    
    // Optimization state
    this.optimizationState = {
      isOptimizing: false,
      currentProfile: this.options.profile,
      lastOptimization: null,
      stabilityScores: new Map()
    };
    
    // Performance history
    this.performanceHistory = new Map();
    
    // Best known configurations
    this.optimalConfigs = new Map();
    
    // Statistics
    this.stats = {
      devicesOptimized: 0,
      performanceGain: 0,
      powerSaved: 0,
      errorsRecovered: 0,
      tuningCycles: 0
    };
    
    // Timers
    this.monitoringTimer = null;
    this.tuningTimer = null;
  }
  
  /**
   * Initialize hardware optimizer
   */
  async initialize() {
    logger.info('Initializing hardware optimizer');
    
    try {
      // Detect hardware
      if (this.options.autoDetect) {
        await this.detectHardware();
      }
      
      // Load drivers
      await this.loadDrivers();
      
      // Initialize devices
      await this.initializeDevices();
      
      // Load saved configurations
      await this.loadOptimalConfigs();
      
      // Start monitoring
      this.startMonitoring();
      
      // Start adaptive tuning if enabled
      if (this.options.adaptiveTuning) {
        this.startAdaptiveTuning();
      }
      
      logger.info('Hardware optimizer initialized', {
        devices: this.hardware.size,
        profile: this.options.profile
      });
      
      this.emit('initialized', {
        hardware: Array.from(this.hardware.values())
      });
      
    } catch (error) {
      logger.error('Failed to initialize hardware optimizer', { error: error.message });
      throw error;
    }
  }
  
  /**
   * Detect available hardware
   */
  async detectHardware() {
    logger.info('Detecting hardware');
    
    const detectedDevices = [];
    
    // Detect NVIDIA GPUs
    if (this.options.hardwareTypes.includes(HardwareType.GPU_NVIDIA)) {
      const nvidiaGPUs = await this.detectNvidiaGPUs();
      detectedDevices.push(...nvidiaGPUs);
    }
    
    // Detect AMD GPUs
    if (this.options.hardwareTypes.includes(HardwareType.GPU_AMD)) {
      const amdGPUs = await this.detectAMDGPUs();
      detectedDevices.push(...amdGPUs);
    }
    
    // Detect ASICs
    if (this.options.hardwareTypes.some(t => t.startsWith('asic_'))) {
      const asics = await this.detectASICs();
      detectedDevices.push(...asics);
    }
    
    // Register detected devices
    for (const device of detectedDevices) {
      this.registerDevice(device);
    }
    
    logger.info('Hardware detection complete', {
      totalDevices: detectedDevices.length,
      types: [...new Set(detectedDevices.map(d => d.type))]
    });
    
    return detectedDevices;
  }
  
  /**
   * Detect NVIDIA GPUs
   */
  async detectNvidiaGPUs() {
    const devices = [];
    
    try {
      // Use nvidia-smi to detect GPUs
      const { stdout } = await execAsync('nvidia-smi --query-gpu=index,name,uuid,memory.total,power.limit --format=csv,noheader,nounits');
      
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const [index, name, uuid, memory, powerLimit] = line.split(',').map(s => s.trim());
        
        devices.push({
          id: `nvidia_${index}`,
          type: HardwareType.GPU_NVIDIA,
          vendor: 'NVIDIA',
          model: name,
          index: parseInt(index),
          uuid,
          memory: parseInt(memory),
          maxPower: parseInt(powerLimit),
          capabilities: {
            overclocking: true,
            powerControl: true,
            fanControl: true,
            voltageControl: true,
            memoryTiming: true
          }
        });
      }
    } catch (error) {
      logger.debug('No NVIDIA GPUs detected or nvidia-smi not available');
    }
    
    return devices;
  }
  
  /**
   * Detect AMD GPUs
   */
  async detectAMDGPUs() {
    const devices = [];
    
    try {
      // Use rocm-smi or amdgpu-info
      const { stdout } = await execAsync('rocm-smi --showid --showname --showmeminfo vram --showpower');
      
      // Parse AMD GPU info
      // This is simplified - actual implementation would parse the output properly
      const gpuCount = (stdout.match(/GPU\[\d+\]/g) || []).length;
      
      for (let i = 0; i < gpuCount; i++) {
        devices.push({
          id: `amd_${i}`,
          type: HardwareType.GPU_AMD,
          vendor: 'AMD',
          model: 'AMD GPU', // Would parse actual model
          index: i,
          capabilities: {
            overclocking: true,
            powerControl: true,
            fanControl: true,
            voltageControl: true,
            memoryTiming: true
          }
        });
      }
    } catch (error) {
      logger.debug('No AMD GPUs detected or rocm-smi not available');
    }
    
    return devices;
  }
  
  /**
   * Detect ASICs
   */
  async detectASICs() {
    const devices = [];
    
    // Check for known ASIC APIs
    const asicEndpoints = [
      { type: HardwareType.ASIC_ANTMINER, port: 4028, api: 'cgminer' },
      { type: HardwareType.ASIC_WHATSMINER, port: 4028, api: 'btminer' },
      { type: HardwareType.ASIC_AVALON, port: 4028, api: 'cgminer' }
    ];
    
    for (const endpoint of asicEndpoints) {
      try {
        const device = await this.probeASIC('localhost', endpoint.port, endpoint.api);
        if (device) {
          device.type = endpoint.type;
          devices.push(device);
        }
      } catch (error) {
        // ASIC not found at this endpoint
      }
    }
    
    return devices;
  }
  
  /**
   * Register device
   */
  registerDevice(device) {
    device.registered = Date.now();
    device.status = 'idle';
    
    this.hardware.set(device.id, device);
    
    // Initialize device settings
    this.deviceSettings.set(device.id, {
      coreClock: 0,
      memoryClock: 0,
      powerLimit: 100,
      fanSpeed: 'auto',
      voltage: {
        core: null,
        memory: null
      }
    });
    
    // Initialize metrics storage
    this.deviceMetrics.set(device.id, {
      hashrate: 0,
      temperature: 0,
      power: 0,
      fanSpeed: 0,
      efficiency: 0,
      errors: 0,
      history: []
    });
    
    logger.info('Device registered', {
      id: device.id,
      type: device.type,
      model: device.model
    });
  }
  
  /**
   * Optimize device
   */
  async optimizeDevice(deviceId, profile = null) {
    const device = this.hardware.get(deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found`);
    }
    
    const optimizationProfile = profile || this.options.profile;
    
    logger.info('Optimizing device', {
      device: deviceId,
      profile: optimizationProfile
    });
    
    try {
      // Get current metrics
      const currentMetrics = await this.getDeviceMetrics(deviceId);
      
      // Determine optimization strategy
      const strategy = this.getOptimizationStrategy(device, optimizationProfile, currentMetrics);
      
      // Apply optimizations
      const result = await this.applyOptimizations(device, strategy);
      
      // Test stability
      if (strategy.requiresStabilityTest) {
        const isStable = await this.testStability(device, this.options.stabilityTestDuration);
        
        if (!isStable) {
          // Revert to previous settings
          await this.revertSettings(device);
          throw new Error('Optimization resulted in unstable configuration');
        }
      }
      
      // Update optimal config if better
      await this.updateOptimalConfig(device, result);
      
      this.stats.devicesOptimized++;
      
      logger.info('Device optimization complete', {
        device: deviceId,
        result
      });
      
      this.emit('device:optimized', {
        device: deviceId,
        profile: optimizationProfile,
        result
      });
      
      return result;
      
    } catch (error) {
      logger.error('Device optimization failed', {
        device: deviceId,
        error: error.message
      });
      
      throw error;
    }
  }
  
  /**
   * Get optimization strategy
   */
  getOptimizationStrategy(device, profile, metrics) {
    const strategy = {
      coreClock: 0,
      memoryClock: 0,
      powerLimit: 100,
      fanSpeed: 'auto',
      voltage: {},
      requiresStabilityTest: true
    };
    
    switch (profile) {
      case OptimizationProfile.MAX_PERFORMANCE:
        // Maximum performance, ignore power consumption
        strategy.coreClock = this.options.coreClock.max;
        strategy.memoryClock = this.options.memoryClock.max;
        strategy.powerLimit = this.options.powerLimit.max;
        strategy.fanSpeed = 100;
        break;
        
      case OptimizationProfile.EFFICIENCY:
        // Optimize for efficiency (hash/watt)
        strategy.coreClock = this.findEfficientCoreClock(device, metrics);
        strategy.memoryClock = this.findEfficientMemoryClock(device, metrics);
        strategy.powerLimit = 70; // Start with 70% power
        strategy.voltage.core = -50; // Undervolt by 50mV
        break;
        
      case OptimizationProfile.QUIET:
        // Minimize noise
        strategy.fanSpeed = 50;
        strategy.powerLimit = 60;
        strategy.coreClock = -100;
        break;
        
      case OptimizationProfile.BALANCED:
      default:
        // Balance between performance and efficiency
        strategy.coreClock = 50;
        strategy.memoryClock = 200;
        strategy.powerLimit = 85;
        strategy.fanSpeed = 'auto';
        break;
    }
    
    // Apply thermal protection
    if (this.options.thermalProtection && metrics.temperature > this.options.targetTemperature) {
      const tempDiff = metrics.temperature - this.options.targetTemperature;
      strategy.powerLimit = Math.max(50, strategy.powerLimit - tempDiff * 2);
      strategy.fanSpeed = Math.min(100, (strategy.fanSpeed === 'auto' ? 70 : strategy.fanSpeed) + tempDiff * 3);
    }
    
    return strategy;
  }
  
  /**
   * Apply optimizations to device
   */
  async applyOptimizations(device, strategy) {
    const startMetrics = await this.getDeviceMetrics(device.id);
    
    // Save current settings for rollback
    const previousSettings = { ...this.deviceSettings.get(device.id) };
    
    try {
      // Apply settings based on device type
      switch (device.type) {
        case HardwareType.GPU_NVIDIA:
          await this.applyNvidiaSettings(device, strategy);
          break;
          
        case HardwareType.GPU_AMD:
          await this.applyAMDSettings(device, strategy);
          break;
          
        case HardwareType.ASIC_ANTMINER:
        case HardwareType.ASIC_WHATSMINER:
        case HardwareType.ASIC_AVALON:
          await this.applyASICSettings(device, strategy);
          break;
          
        default:
          throw new Error(`Optimization not supported for ${device.type}`);
      }
      
      // Update device settings
      this.deviceSettings.set(device.id, strategy);
      
      // Wait for settings to stabilize
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Measure improvement
      const endMetrics = await this.getDeviceMetrics(device.id);
      
      const improvement = {
        hashrate: {
          before: startMetrics.hashrate,
          after: endMetrics.hashrate,
          gain: ((endMetrics.hashrate - startMetrics.hashrate) / startMetrics.hashrate) * 100
        },
        power: {
          before: startMetrics.power,
          after: endMetrics.power,
          saved: startMetrics.power - endMetrics.power
        },
        efficiency: {
          before: startMetrics.hashrate / startMetrics.power,
          after: endMetrics.hashrate / endMetrics.power,
          gain: ((endMetrics.hashrate / endMetrics.power) - (startMetrics.hashrate / startMetrics.power)) / (startMetrics.hashrate / startMetrics.power) * 100
        },
        temperature: {
          before: startMetrics.temperature,
          after: endMetrics.temperature
        }
      };
      
      // Update statistics
      if (improvement.hashrate.gain > 0) {
        this.stats.performanceGain += improvement.hashrate.gain;
      }
      if (improvement.power.saved > 0) {
        this.stats.powerSaved += improvement.power.saved;
      }
      
      return {
        settings: strategy,
        previousSettings,
        improvement,
        metrics: endMetrics
      };
      
    } catch (error) {
      // Rollback on error
      await this.applyOptimizations(device, previousSettings);
      throw error;
    }
  }
  
  /**
   * Apply NVIDIA GPU settings
   */
  async applyNvidiaSettings(device, settings) {
    const commands = [];
    
    // Set power limit
    if (settings.powerLimit !== 100) {
      const powerWatts = Math.round(device.maxPower * settings.powerLimit / 100);
      commands.push(`nvidia-smi -i ${device.index} -pl ${powerWatts}`);
    }
    
    // Set GPU clock offset
    if (settings.coreClock !== 0) {
      commands.push(`nvidia-settings -a [gpu:${device.index}]/GPUGraphicsClockOffsetAllPerformanceLevels=${settings.coreClock}`);
    }
    
    // Set memory clock offset
    if (settings.memoryClock !== 0) {
      commands.push(`nvidia-settings -a [gpu:${device.index}]/GPUMemoryTransferRateOffsetAllPerformanceLevels=${settings.memoryClock}`);
    }
    
    // Set fan speed
    if (settings.fanSpeed !== 'auto') {
      commands.push(`nvidia-settings -a [gpu:${device.index}]/GPUFanControlState=1`);
      commands.push(`nvidia-settings -a [fan:${device.index}]/GPUTargetFanSpeed=${settings.fanSpeed}`);
    }
    
    // Execute commands
    for (const cmd of commands) {
      try {
        await execAsync(cmd);
        logger.debug('Applied NVIDIA setting', { command: cmd });
      } catch (error) {
        logger.error('Failed to apply NVIDIA setting', {
          command: cmd,
          error: error.message
        });
      }
    }
  }
  
  /**
   * Apply AMD GPU settings
   */
  async applyAMDSettings(device, settings) {
    // Use rocm-smi or custom AMD tools
    const commands = [];
    
    // Set power limit
    if (settings.powerLimit !== 100) {
      const powerWatts = Math.round(device.maxPower * settings.powerLimit / 100);
      commands.push(`rocm-smi --setpoweroverdrive ${powerWatts} --device ${device.index}`);
    }
    
    // Set clocks
    if (settings.coreClock !== 0) {
      commands.push(`rocm-smi --setsclk 7 --device ${device.index}`); // Simplified
    }
    
    if (settings.memoryClock !== 0) {
      commands.push(`rocm-smi --setmclk 3 --device ${device.index}`); // Simplified
    }
    
    // Set fan speed
    if (settings.fanSpeed !== 'auto') {
      commands.push(`rocm-smi --setfan ${settings.fanSpeed} --device ${device.index}`);
    }
    
    // Execute commands
    for (const cmd of commands) {
      try {
        await execAsync(cmd);
        logger.debug('Applied AMD setting', { command: cmd });
      } catch (error) {
        logger.error('Failed to apply AMD setting', {
          command: cmd,
          error: error.message
        });
      }
    }
  }
  
  /**
   * Apply ASIC settings
   */
  async applyASICSettings(device, settings) {
    // Send commands via ASIC API
    const apiCommands = [];
    
    // Frequency settings
    if (settings.coreClock) {
      apiCommands.push({
        command: 'setconfig',
        parameter: 'freq',
        value: device.baseFreq + settings.coreClock
      });
    }
    
    // Fan settings
    if (settings.fanSpeed !== 'auto') {
      apiCommands.push({
        command: 'setconfig',
        parameter: 'fan',
        value: settings.fanSpeed
      });
    }
    
    // Send commands to ASIC
    for (const cmd of apiCommands) {
      await this.sendASICCommand(device, cmd);
    }
  }
  
  /**
   * Test stability
   */
  async testStability(device, duration) {
    logger.info('Testing stability', {
      device: device.id,
      duration
    });
    
    const startTime = Date.now();
    const errors = [];
    let stable = true;
    
    // Monitor for errors during test period
    const testInterval = setInterval(async () => {
      try {
        const metrics = await this.getDeviceMetrics(device.id);
        
        // Check for errors
        if (metrics.errors > 0) {
          errors.push({
            time: Date.now() - startTime,
            type: 'compute_error',
            count: metrics.errors
          });
        }
        
        // Check temperature
        if (metrics.temperature > this.options.maxTemperature) {
          errors.push({
            time: Date.now() - startTime,
            type: 'thermal_limit',
            temperature: metrics.temperature
          });
          stable = false;
        }
        
        // Check for hashrate drops
        const baseline = this.deviceMetrics.get(device.id).hashrate;
        if (metrics.hashrate < baseline * 0.9) {
          errors.push({
            time: Date.now() - startTime,
            type: 'hashrate_drop',
            drop: ((baseline - metrics.hashrate) / baseline) * 100
          });
        }
        
      } catch (error) {
        errors.push({
          time: Date.now() - startTime,
          type: 'monitoring_error',
          error: error.message
        });
      }
    }, 5000);
    
    // Wait for test duration
    await new Promise(resolve => setTimeout(resolve, duration));
    clearInterval(testInterval);
    
    // Calculate stability score
    const stabilityScore = 1 - (errors.length / (duration / 5000));
    this.optimizationState.stabilityScores.set(device.id, stabilityScore);
    
    logger.info('Stability test complete', {
      device: device.id,
      stable,
      errors: errors.length,
      score: stabilityScore
    });
    
    return stable && errors.length < 3; // Allow up to 2 errors
  }
  
  /**
   * Start adaptive tuning
   */
  startAdaptiveTuning() {
    this.tuningTimer = setInterval(async () => {
      if (this.optimizationState.isOptimizing) return;
      
      try {
        this.optimizationState.isOptimizing = true;
        
        // Check each device
        for (const [deviceId, device] of this.hardware) {
          const metrics = this.deviceMetrics.get(deviceId);
          const settings = this.deviceSettings.get(deviceId);
          
          // Determine if tuning is needed
          if (this.needsTuning(device, metrics, settings)) {
            await this.performAdaptiveTuning(device);
          }
        }
        
        this.stats.tuningCycles++;
        
      } catch (error) {
        logger.error('Adaptive tuning error', { error: error.message });
      } finally {
        this.optimizationState.isOptimizing = false;
      }
    }, this.options.tuningInterval);
  }
  
  /**
   * Check if device needs tuning
   */
  needsTuning(device, metrics, settings) {
    // Temperature too high
    if (metrics.temperature > this.options.targetTemperature + 5) {
      return true;
    }
    
    // Efficiency dropped
    const currentEfficiency = metrics.hashrate / metrics.power;
    const optimalEfficiency = this.optimalConfigs.get(device.id)?.efficiency || 0;
    if (currentEfficiency < optimalEfficiency * 0.95) {
      return true;
    }
    
    // Error rate too high
    if (metrics.errors > 10) {
      return true;
    }
    
    // Power target not met
    if (this.options.targetPower && Math.abs(metrics.power - this.options.targetPower) > 10) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Perform adaptive tuning
   */
  async performAdaptiveTuning(device) {
    const metrics = this.deviceMetrics.get(device.id);
    const currentSettings = this.deviceSettings.get(device.id);
    const newSettings = { ...currentSettings };
    
    // Temperature-based adjustments
    if (metrics.temperature > this.options.targetTemperature) {
      const tempDiff = metrics.temperature - this.options.targetTemperature;
      
      // Reduce power limit
      newSettings.powerLimit = Math.max(
        this.options.powerLimit.min,
        currentSettings.powerLimit - tempDiff
      );
      
      // Increase fan speed if not at max
      if (newSettings.fanSpeed !== 'auto' && newSettings.fanSpeed < 100) {
        newSettings.fanSpeed = Math.min(100, newSettings.fanSpeed + tempDiff * 2);
      }
      
      // Reduce clocks if still too hot
      if (tempDiff > 5) {
        newSettings.coreClock = Math.max(
          this.options.coreClock.min,
          currentSettings.coreClock - 25
        );
      }
    }
    
    // Efficiency optimization
    if (this.options.powerEfficiencyMode) {
      const efficiency = metrics.hashrate / metrics.power;
      const targetEfficiency = this.optimalConfigs.get(device.id)?.efficiency || efficiency;
      
      if (efficiency < targetEfficiency * 0.95) {
        // Try undervolting
        if (device.capabilities.voltageControl) {
          newSettings.voltage.core = (currentSettings.voltage.core || 0) - 10;
        }
        
        // Reduce power limit
        newSettings.powerLimit = Math.max(
          this.options.powerLimit.min,
          currentSettings.powerLimit - 5
        );
      }
    }
    
    // Apply new settings if changed
    if (JSON.stringify(newSettings) !== JSON.stringify(currentSettings)) {
      try {
        await this.applyOptimizations(device, newSettings);
        
        logger.info('Adaptive tuning applied', {
          device: device.id,
          changes: this.diffSettings(currentSettings, newSettings)
        });
        
        this.emit('tuning:applied', {
          device: device.id,
          before: currentSettings,
          after: newSettings,
          metrics
        });
        
      } catch (error) {
        logger.error('Adaptive tuning failed', {
          device: device.id,
          error: error.message
        });
        
        this.stats.errorsRecovered++;
      }
    }
  }
  
  /**
   * Find efficient core clock
   */
  findEfficientCoreClock(device, metrics) {
    // Use historical data to find most efficient clock
    const history = this.performanceHistory.get(device.id) || [];
    
    if (history.length < 10) {
      return 0; // Not enough data, use default
    }
    
    // Find clock with best efficiency
    let bestClock = 0;
    let bestEfficiency = 0;
    
    for (const entry of history) {
      const efficiency = entry.hashrate / entry.power;
      if (efficiency > bestEfficiency) {
        bestEfficiency = efficiency;
        bestClock = entry.settings.coreClock;
      }
    }
    
    return bestClock;
  }
  
  /**
   * Find efficient memory clock
   */
  findEfficientMemoryClock(device, metrics) {
    // Memory clock often has less impact on power
    // Start with moderate overclock
    return 500;
  }
  
  /**
   * Get device metrics
   */
  async getDeviceMetrics(deviceId) {
    const device = this.hardware.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not found`);
    
    let metrics = {
      hashrate: 0,
      temperature: 0,
      power: 0,
      fanSpeed: 0,
      efficiency: 0,
      errors: 0,
      timestamp: Date.now()
    };
    
    try {
      switch (device.type) {
        case HardwareType.GPU_NVIDIA:
          metrics = await this.getNvidiaMetrics(device);
          break;
          
        case HardwareType.GPU_AMD:
          metrics = await this.getAMDMetrics(device);
          break;
          
        case HardwareType.ASIC_ANTMINER:
        case HardwareType.ASIC_WHATSMINER:
        case HardwareType.ASIC_AVALON:
          metrics = await this.getASICMetrics(device);
          break;
      }
      
      // Calculate efficiency
      if (metrics.power > 0) {
        metrics.efficiency = metrics.hashrate / metrics.power;
      }
      
      // Update device metrics
      const deviceMetrics = this.deviceMetrics.get(deviceId);
      Object.assign(deviceMetrics, metrics);
      
      // Add to history
      deviceMetrics.history.push(metrics);
      if (deviceMetrics.history.length > 1000) {
        deviceMetrics.history.shift();
      }
      
    } catch (error) {
      logger.error('Failed to get device metrics', {
        device: deviceId,
        error: error.message
      });
    }
    
    return metrics;
  }
  
  /**
   * Get NVIDIA metrics
   */
  async getNvidiaMetrics(device) {
    const { stdout } = await execAsync(
      `nvidia-smi -i ${device.index} --query-gpu=temperature.gpu,power.draw,fan.speed,clocks.current.graphics,clocks.current.memory --format=csv,noheader,nounits`
    );
    
    const [temp, power, fan, coreClock, memClock] = stdout.trim().split(',').map(v => parseFloat(v.trim()));
    
    return {
      temperature: temp,
      power: power,
      fanSpeed: fan,
      coreClock: coreClock,
      memoryClock: memClock,
      hashrate: await this.getMinerHashrate(device.id),
      errors: 0 // Would get from miner
    };
  }
  
  /**
   * Get AMD metrics
   */
  async getAMDMetrics(device) {
    // Simplified - would use rocm-smi
    return {
      temperature: 70,
      power: 150,
      fanSpeed: 60,
      hashrate: await this.getMinerHashrate(device.id),
      errors: 0
    };
  }
  
  /**
   * Get ASIC metrics
   */
  async getASICMetrics(device) {
    // Would query ASIC API
    return {
      temperature: 75,
      power: 1200,
      fanSpeed: 80,
      hashrate: 100e12, // 100 TH/s
      errors: 0
    };
  }
  
  /**
   * Get miner hashrate for device
   */
  async getMinerHashrate(deviceId) {
    // This would interface with the actual miner
    // For now, return simulated value
    return Math.random() * 100e9 + 50e9; // 50-150 GH/s
  }
  
  /**
   * Update optimal configuration
   */
  async updateOptimalConfig(device, result) {
    const currentOptimal = this.optimalConfigs.get(device.id);
    
    if (!currentOptimal || result.improvement.efficiency.after > currentOptimal.efficiency) {
      this.optimalConfigs.set(device.id, {
        settings: result.settings,
        metrics: result.metrics,
        efficiency: result.improvement.efficiency.after,
        timestamp: Date.now()
      });
      
      // Save to persistent storage
      await this.saveOptimalConfigs();
      
      logger.info('Updated optimal configuration', {
        device: device.id,
        efficiency: result.improvement.efficiency.after
      });
    }
  }
  
  /**
   * Start monitoring
   */
  startMonitoring() {
    this.monitoringTimer = setInterval(async () => {
      for (const deviceId of this.hardware.keys()) {
        try {
          await this.getDeviceMetrics(deviceId);
        } catch (error) {
          logger.error('Monitoring error', {
            device: deviceId,
            error: error.message
          });
        }
      }
      
      this.emit('metrics:updated', {
        devices: Object.fromEntries(this.deviceMetrics)
      });
    }, this.options.metricsSampleRate);
  }
  
  /**
   * Get optimization status
   */
  getStatus() {
    const status = {
      hardware: [],
      optimizationState: this.optimizationState,
      stats: this.stats
    };
    
    for (const [id, device] of this.hardware) {
      const metrics = this.deviceMetrics.get(id);
      const settings = this.deviceSettings.get(id);
      const optimal = this.optimalConfigs.get(id);
      
      status.hardware.push({
        id,
        type: device.type,
        model: device.model,
        status: device.status,
        metrics,
        settings,
        optimal: optimal ? {
          efficiency: optimal.efficiency,
          timestamp: optimal.timestamp
        } : null
      });
    }
    
    return status;
  }
  
  /**
   * Shutdown optimizer
   */
  async shutdown() {
    // Stop timers
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
    }
    
    if (this.tuningTimer) {
      clearInterval(this.tuningTimer);
    }
    
    // Reset all devices to default
    for (const [deviceId, device] of this.hardware) {
      try {
        await this.resetDevice(device);
      } catch (error) {
        logger.error('Failed to reset device', {
          device: deviceId,
          error: error.message
        });
      }
    }
    
    // Save optimal configs
    await this.saveOptimalConfigs();
    
    logger.info('Hardware optimizer shutdown', this.stats);
  }
  
  // Utility methods
  
  async loadDrivers() {
    // Load device drivers
  }
  
  async initializeDevices() {
    // Initialize each device
  }
  
  async loadOptimalConfigs() {
    // Load from storage
  }
  
  async saveOptimalConfigs() {
    // Save to storage
  }
  
  async probeASIC(host, port, api) {
    // Probe ASIC at endpoint
    return null;
  }
  
  async sendASICCommand(device, command) {
    // Send command to ASIC
  }
  
  async revertSettings(device) {
    // Revert to previous settings
  }
  
  async resetDevice(device) {
    // Reset device to defaults
  }
  
  diffSettings(before, after) {
    const changes = {};
    for (const key in after) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changes[key] = { before: before[key], after: after[key] };
      }
    }
    return changes;
  }
}

export default AdvancedHardwareOptimizer;