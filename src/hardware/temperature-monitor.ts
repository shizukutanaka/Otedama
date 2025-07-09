/**
 * Temperature Monitoring - Overheat Prevention
 * Following Carmack/Martin/Pike principles:
 * - Real-time temperature monitoring
 * - Automatic throttling to prevent damage
 * - Clean abstraction for different hardware
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { HardwareDetector, HardwareProfile } from './hardware-detector';
import { logger } from '../utils/logger';

const execAsync = promisify(exec);

interface TemperatureReading {
  device: string;
  type: 'cpu' | 'gpu' | 'motherboard' | 'storage';
  id: number;
  current: number;
  min: number;
  max: number;
  average: number;
  critical: number;
  timestamp: Date;
}

interface ThermalProfile {
  cpu: {
    warning: number;
    throttle: number;
    shutdown: number;
  };
  gpu: {
    warning: number;
    throttle: number;
    shutdown: number;
  };
}

interface ThrottleAction {
  device: string;
  type: 'reduce_frequency' | 'reduce_threads' | 'pause' | 'shutdown';
  level: number; // 0-100% throttle
  reason: string;
}

export class TemperatureMonitor extends EventEmitter {
  private hardwareDetector: HardwareDetector;
  private monitoringInterval?: NodeJS.Timer;
  private readings: Map<string, TemperatureReading[]> = new Map();
  private thermalProfile: ThermalProfile;
  private throttleState: Map<string, ThrottleAction> = new Map();
  private isMonitoring: boolean = false;

  constructor() {
    super();
    this.hardwareDetector = new HardwareDetector();
    
    // Default thermal profiles (conservative)
    this.thermalProfile = {
      cpu: {
        warning: 75,
        throttle: 85,
        shutdown: 95
      },
      gpu: {
        warning: 80,
        throttle: 85,
        shutdown: 90
      }
    };
  }

  /**
   * Start temperature monitoring
   */
  async start(interval: number = 2000): Promise<void> {
    if (this.isMonitoring) {
      logger.warn('Temperature monitoring already running');
      return;
    }

    logger.info('Starting temperature monitoring', { interval });
    this.isMonitoring = true;

    // Initial hardware detection
    const hardware = await this.hardwareDetector.detect();
    
    // Adjust thermal profiles based on hardware
    this.adjustThermalProfiles(hardware);

    // Start monitoring loop
    this.monitoringInterval = setInterval(async () => {
      try {
        await this.checkTemperatures();
      } catch (err) {
        logger.error('Temperature check failed', { error: err });
      }
    }, interval);

    this.emit('monitoring:started');
  }

  /**
   * Stop temperature monitoring
   */
  stop(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
    
    this.isMonitoring = false;
    this.emit('monitoring:stopped');
  }

  /**
   * Check all temperatures
   */
  private async checkTemperatures(): Promise<void> {
    const readings: TemperatureReading[] = [];

    // Check CPU temperatures
    const cpuTemps = await this.getCPUTemperatures();
    readings.push(...cpuTemps);

    // Check GPU temperatures
    const gpuTemps = await this.getGPUTemperatures();
    readings.push(...gpuTemps);

    // Check other temperatures
    const otherTemps = await this.getOtherTemperatures();
    readings.push(...otherTemps);

    // Process readings
    for (const reading of readings) {
      this.processReading(reading);
    }

    this.emit('temperatures:updated', readings);
  }

  /**
   * Get CPU temperatures
   */
  private async getCPUTemperatures(): Promise<TemperatureReading[]> {
    const readings: TemperatureReading[] = [];

    if (process.platform === 'linux') {
      // Check thermal zones
      try {
        const thermalZones = fs.readdirSync('/sys/class/thermal/');
        
        for (const zone of thermalZones) {
          if (!zone.startsWith('thermal_zone')) continue;
          
          try {
            const tempPath = `/sys/class/thermal/${zone}/temp`;
            const typePath = `/sys/class/thermal/${zone}/type`;
            
            const temp = parseInt(fs.readFileSync(tempPath, 'utf8')) / 1000;
            const type = fs.readFileSync(typePath, 'utf8').trim();
            
            if (type.includes('cpu') || type.includes('x86_pkg_temp')) {
              readings.push(this.createReading('CPU', 'cpu', 0, temp));
            }
          } catch {
            // Skip this zone
          }
        }
      } catch {
        // Thermal zones not available
      }

      // Check hwmon
      try {
        const hwmons = fs.readdirSync('/sys/class/hwmon/');
        
        for (const hwmon of hwmons) {
          try {
            const name = fs.readFileSync(`/sys/class/hwmon/${hwmon}/name`, 'utf8').trim();
            
            if (name.includes('coretemp') || name.includes('k10temp')) {
              const tempFiles = fs.readdirSync(`/sys/class/hwmon/${hwmon}/`)
                .filter(f => f.match(/^temp\d+_input$/));
              
              for (const tempFile of tempFiles) {
                const temp = parseInt(fs.readFileSync(`/sys/class/hwmon/${hwmon}/${tempFile}`, 'utf8')) / 1000;
                const coreId = parseInt(tempFile.match(/temp(\d+)_input/)![1]) - 1;
                readings.push(this.createReading(`CPU Core ${coreId}`, 'cpu', coreId, temp));
              }
            }
          } catch {
            // Skip this hwmon
          }
        }
      } catch {
        // hwmon not available
      }
    } else if (process.platform === 'win32') {
      try {
        const { stdout } = await execAsync('wmic /namespace:\\\\root\\wmi PATH MSAcpi_ThermalZoneTemperature get CurrentTemperature /value');
        const matches = stdout.matchAll(/CurrentTemperature=(\d+)/g);
        let coreId = 0;
        
        for (const match of matches) {
          const kelvin = parseInt(match[1]) / 10;
          const celsius = kelvin - 273.15;
          readings.push(this.createReading(`CPU Core ${coreId}`, 'cpu', coreId, celsius));
          coreId++;
        }
      } catch {
        // WMI not available or access denied
      }
    } else if (process.platform === 'darwin') {
      try {
        // macOS temperature monitoring requires third-party tools
        const { stdout } = await execAsync('osx-cpu-temp 2>/dev/null || echo "0"');
        const temp = parseFloat(stdout.trim());
        if (temp > 0) {
          readings.push(this.createReading('CPU', 'cpu', 0, temp));
        }
      } catch {
        // Tool not available
      }
    }

    return readings;
  }

  /**
   * Get GPU temperatures
   */
  private async getGPUTemperatures(): Promise<TemperatureReading[]> {
    const readings: TemperatureReading[] = [];

    // NVIDIA GPUs
    try {
      const { stdout } = await execAsync('nvidia-smi --query-gpu=index,temperature.gpu --format=csv,noheader,nounits');
      const lines = stdout.trim().split('\n');
      
      for (const line of lines) {
        const [index, temp] = line.split(',').map(v => v.trim());
        readings.push(this.createReading(`GPU ${index}`, 'gpu', parseInt(index), parseFloat(temp)));
      }
    } catch {
      // nvidia-smi not available
    }

    // AMD GPUs
    try {
      const { stdout } = await execAsync('rocm-smi -t --json');
      const data = JSON.parse(stdout);
      
      for (const [device, info] of Object.entries(data)) {
        if (typeof info === 'object' && info !== null && 'Temperature (Sensor edge) (C)' in info) {
          const temp = parseFloat(info['Temperature (Sensor edge) (C)']);
          const id = parseInt(device.replace('card', ''));
          readings.push(this.createReading(`GPU ${id}`, 'gpu', id, temp));
        }
      }
    } catch {
      // rocm-smi not available
    }

    // Intel GPUs
    if (process.platform === 'linux') {
      try {
        const hwmons = fs.readdirSync('/sys/class/hwmon/');
        
        for (const hwmon of hwmons) {
          try {
            const name = fs.readFileSync(`/sys/class/hwmon/${hwmon}/name`, 'utf8').trim();
            
            if (name.includes('i915')) {
              const temp = parseInt(fs.readFileSync(`/sys/class/hwmon/${hwmon}/temp1_input`, 'utf8')) / 1000;
              readings.push(this.createReading('Intel GPU', 'gpu', 0, temp));
            }
          } catch {
            // Skip
          }
        }
      } catch {
        // Not available
      }
    }

    return readings;
  }

  /**
   * Get other temperatures (motherboard, storage, etc.)
   */
  private async getOtherTemperatures(): Promise<TemperatureReading[]> {
    const readings: TemperatureReading[] = [];

    if (process.platform === 'linux') {
      // Check for motherboard sensors
      try {
        const { stdout } = await execAsync('sensors -u 2>/dev/null || echo ""');
        
        // Parse lm_sensors output
        const lines = stdout.split('\n');
        let currentChip = '';
        
        for (const line of lines) {
          if (line.includes('-')) {
            currentChip = line.split('-')[0].trim();
          } else if (line.includes('temp') && line.includes('_input:')) {
            const match = line.match(/temp\d+_input:\s*([\d.]+)/);
            if (match) {
              const temp = parseFloat(match[1]);
              if (currentChip.includes('nvme')) {
                readings.push(this.createReading('NVMe', 'storage', 0, temp));
              } else if (currentChip.includes('acpi')) {
                readings.push(this.createReading('Motherboard', 'motherboard', 0, temp));
              }
            }
          }
        }
      } catch {
        // sensors not available
      }

      // Check NVMe temperatures directly
      try {
        const nvmeDevices = fs.readdirSync('/sys/class/nvme/');
        
        for (const device of nvmeDevices) {
          try {
            const hwmons = fs.readdirSync(`/sys/class/nvme/${device}/hwmon/`);
            for (const hwmon of hwmons) {
              const temp = parseInt(fs.readFileSync(
                `/sys/class/nvme/${device}/hwmon/${hwmon}/temp1_input`, 'utf8'
              )) / 1000;
              readings.push(this.createReading(device, 'storage', 0, temp));
            }
          } catch {
            // Skip
          }
        }
      } catch {
        // Not available
      }
    }

    return readings;
  }

  /**
   * Create temperature reading
   */
  private createReading(
    device: string,
    type: 'cpu' | 'gpu' | 'motherboard' | 'storage',
    id: number,
    current: number
  ): TemperatureReading {
    const key = `${type}-${id}`;
    const history = this.readings.get(key) || [];
    
    const min = history.length > 0 ? Math.min(...history.map(r => r.current), current) : current;
    const max = history.length > 0 ? Math.max(...history.map(r => r.current), current) : current;
    const average = history.length > 0 
      ? (history.reduce((sum, r) => sum + r.current, 0) + current) / (history.length + 1)
      : current;

    const critical = type === 'cpu' ? this.thermalProfile.cpu.shutdown :
                    type === 'gpu' ? this.thermalProfile.gpu.shutdown :
                    100; // Default critical temp

    const reading: TemperatureReading = {
      device,
      type,
      id,
      current,
      min,
      max,
      average,
      critical,
      timestamp: new Date()
    };

    // Update history
    history.push(reading);
    if (history.length > 60) { // Keep last 60 readings
      history.shift();
    }
    this.readings.set(key, history);

    return reading;
  }

  /**
   * Process temperature reading and take action if needed
   */
  private processReading(reading: TemperatureReading): void {
    const profile = reading.type === 'cpu' ? this.thermalProfile.cpu :
                   reading.type === 'gpu' ? this.thermalProfile.gpu :
                   null;

    if (!profile) return;

    const key = `${reading.type}-${reading.id}`;

    // Check temperature thresholds
    if (reading.current >= profile.shutdown) {
      this.handleShutdown(reading);
    } else if (reading.current >= profile.throttle) {
      this.handleThrottle(reading, profile);
    } else if (reading.current >= profile.warning) {
      this.handleWarning(reading);
    } else {
      // Temperature is safe, remove any throttling
      if (this.throttleState.has(key)) {
        this.removeThrottle(key);
      }
    }
  }

  /**
   * Handle shutdown temperature
   */
  private handleShutdown(reading: TemperatureReading): void {
    logger.error('CRITICAL TEMPERATURE - INITIATING SHUTDOWN', {
      device: reading.device,
      temperature: reading.current,
      critical: reading.critical
    });

    const action: ThrottleAction = {
      device: reading.device,
      type: 'shutdown',
      level: 100,
      reason: `Temperature ${reading.current}°C exceeds critical ${reading.critical}°C`
    };

    this.throttleState.set(`${reading.type}-${reading.id}`, action);
    this.emit('temperature:critical', { reading, action });

    // Initiate emergency shutdown
    this.emergencyShutdown();
  }

  /**
   * Handle throttle temperature
   */
  private handleThrottle(reading: TemperatureReading, profile: any): void {
    const throttleRange = profile.shutdown - profile.throttle;
    const tempAboveThrottle = reading.current - profile.throttle;
    const throttleLevel = Math.min(100, (tempAboveThrottle / throttleRange) * 100);

    logger.warn('Temperature throttling activated', {
      device: reading.device,
      temperature: reading.current,
      throttleLevel: `${throttleLevel.toFixed(1)}%`
    });

    const action: ThrottleAction = {
      device: reading.device,
      type: throttleLevel > 75 ? 'pause' : 'reduce_frequency',
      level: throttleLevel,
      reason: `Temperature ${reading.current}°C exceeds throttle ${profile.throttle}°C`
    };

    this.throttleState.set(`${reading.type}-${reading.id}`, action);
    this.emit('temperature:throttle', { reading, action });
  }

  /**
   * Handle warning temperature
   */
  private handleWarning(reading: TemperatureReading): void {
    logger.warn('Temperature warning', {
      device: reading.device,
      temperature: reading.current
    });

    this.emit('temperature:warning', { reading });
  }

  /**
   * Remove throttling
   */
  private removeThrottle(key: string): void {
    const action = this.throttleState.get(key);
    if (action) {
      logger.info('Temperature normalized, removing throttle', {
        device: action.device
      });
      
      this.throttleState.delete(key);
      this.emit('temperature:normalized', { device: action.device });
    }
  }

  /**
   * Emergency shutdown procedure
   */
  private async emergencyShutdown(): Promise<void> {
    try {
      // Emit shutdown event
      this.emit('emergency:shutdown');

      // Give time for cleanup
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Force exit
      process.exit(1);
    } catch (err) {
      logger.error('Emergency shutdown failed', { error: err });
      process.exit(1);
    }
  }

  /**
   * Adjust thermal profiles based on hardware
   */
  private adjustThermalProfiles(hardware: HardwareProfile): void {
    // Intel CPUs
    if (hardware.cpu.vendor === 'Intel') {
      if (hardware.cpu.model.includes('i9') || hardware.cpu.model.includes('i7')) {
        // High-end Intel CPUs can run hotter
        this.thermalProfile.cpu.warning = 80;
        this.thermalProfile.cpu.throttle = 90;
        this.thermalProfile.cpu.shutdown = 100;
      }
    }
    
    // AMD CPUs
    else if (hardware.cpu.vendor === 'AMD') {
      if (hardware.cpu.model.includes('Ryzen 9') || hardware.cpu.model.includes('Threadripper')) {
        // AMD Ryzen can handle higher temps
        this.thermalProfile.cpu.warning = 80;
        this.thermalProfile.cpu.throttle = 90;
        this.thermalProfile.cpu.shutdown = 95;
      }
    }

    // GPU profiles
    for (const gpu of hardware.gpus) {
      if (gpu.vendor === 'nvidia') {
        // Modern NVIDIA GPUs
        if (gpu.model.includes('RTX 40') || gpu.model.includes('RTX 30')) {
          this.thermalProfile.gpu.warning = 83;
          this.thermalProfile.gpu.throttle = 87;
          this.thermalProfile.gpu.shutdown = 92;
        }
      } else if (gpu.vendor === 'amd') {
        // AMD GPUs typically have lower thermal limits
        this.thermalProfile.gpu.warning = 75;
        this.thermalProfile.gpu.throttle = 80;
        this.thermalProfile.gpu.shutdown = 85;
      }
    }
  }

  /**
   * Get current throttle state
   */
  getThrottleState(): Map<string, ThrottleAction> {
    return new Map(this.throttleState);
  }

  /**
   * Get temperature history
   */
  getTemperatureHistory(device?: string): TemperatureReading[] {
    if (device) {
      return this.readings.get(device) || [];
    }

    // Return all readings
    const allReadings: TemperatureReading[] = [];
    for (const readings of this.readings.values()) {
      allReadings.push(...readings);
    }
    return allReadings;
  }

  /**
   * Get current temperatures
   */
  getCurrentTemperatures(): TemperatureReading[] {
    const current: TemperatureReading[] = [];
    
    for (const readings of this.readings.values()) {
      if (readings.length > 0) {
        current.push(readings[readings.length - 1]);
      }
    }
    
    return current;
  }

  /**
   * Set custom thermal profile
   */
  setThermalProfile(profile: Partial<ThermalProfile>): void {
    this.thermalProfile = {
      ...this.thermalProfile,
      ...profile
    };
    
    logger.info('Thermal profile updated', this.thermalProfile);
  }
}

// Export types
export { TemperatureReading, ThermalProfile, ThrottleAction };
