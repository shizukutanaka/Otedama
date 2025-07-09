/**
 * Power Efficiency Calculator - Hash per Watt
 * Following Carmack/Martin/Pike principles:
 * - Accurate power measurement
 * - Real-time efficiency tracking
 * - Cost-benefit analysis
 */

import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import { HardwareDetector, HardwareProfile } from './hardware-detector';
import { logger } from '../utils/logger';

const execAsync = promisify(exec);

interface PowerReading {
  device: string;
  type: 'cpu' | 'gpu' | 'system';
  id: number;
  current: number; // Watts
  voltage?: number; // Volts
  amperage?: number; // Amps
  timestamp: Date;
}

interface EfficiencyMetrics {
  device: string;
  hashRate: number;
  powerConsumption: number;
  hashPerWatt: number;
  costPerHash: number;
  profitability: number;
  efficiency: 'excellent' | 'good' | 'average' | 'poor';
}

interface PowerProfile {
  idle: number;
  mining: number;
  peak: number;
  average: number;
  efficiency: number; // 0-100%
}

interface ElectricityCost {
  currency: string;
  pricePerKWh: number;
  peakHours?: {
    start: number;
    end: number;
    multiplier: number;
  };
}

export class PowerEfficiencyCalculator extends EventEmitter {
  private hardwareDetector: HardwareDetector;
  private monitoringInterval?: NodeJS.Timer;
  private powerReadings: Map<string, PowerReading[]> = new Map();
  private hashRates: Map<string, number> = new Map();
  private electricityCost: ElectricityCost;
  private isMonitoring: boolean = false;

  constructor(electricityCost?: ElectricityCost) {
    super();
    this.hardwareDetector = new HardwareDetector();
    
    // Default electricity cost (US average)
    this.electricityCost = electricityCost || {
      currency: 'USD',
      pricePerKWh: 0.12
    };
  }

  /**
   * Start power monitoring
   */
  async start(interval: number = 5000): Promise<void> {
    if (this.isMonitoring) {
      logger.warn('Power monitoring already running');
      return;
    }

    logger.info('Starting power efficiency monitoring', { interval });
    this.isMonitoring = true;

    // Initial hardware detection
    await this.hardwareDetector.detect();

    // Start monitoring loop
    this.monitoringInterval = setInterval(async () => {
      try {
        await this.measurePower();
        this.calculateEfficiency();
      } catch (err) {
        logger.error('Power measurement failed', { error: err });
      }
    }, interval);

    this.emit('monitoring:started');
  }

  /**
   * Stop power monitoring
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
   * Measure power consumption
   */
  private async measurePower(): Promise<void> {
    const readings: PowerReading[] = [];

    // Measure CPU power
    const cpuPower = await this.measureCPUPower();
    readings.push(...cpuPower);

    // Measure GPU power
    const gpuPower = await this.measureGPUPower();
    readings.push(...gpuPower);

    // Measure system power
    const systemPower = await this.measureSystemPower();
    if (systemPower) {
      readings.push(systemPower);
    }

    // Store readings
    for (const reading of readings) {
      const key = `${reading.type}-${reading.id}`;
      const history = this.powerReadings.get(key) || [];
      history.push(reading);
      
      // Keep last 60 readings (5 minutes at 5s interval)
      if (history.length > 60) {
        history.shift();
      }
      
      this.powerReadings.set(key, history);
    }

    this.emit('power:measured', readings);
  }

  /**
   * Measure CPU power consumption
   */
  private async measureCPUPower(): Promise<PowerReading[]> {
    const readings: PowerReading[] = [];

    if (process.platform === 'linux') {
      // Intel RAPL (Running Average Power Limit)
      try {
        const raplPath = '/sys/class/powercap/intel-rapl';
        if (fs.existsSync(raplPath)) {
          const domains = fs.readdirSync(raplPath)
            .filter(d => d.startsWith('intel-rapl:'));
          
          for (const domain of domains) {
            try {
              const namePath = `${raplPath}/${domain}/name`;
              const energyPath = `${raplPath}/${domain}/energy_uj`;
              
              const name = fs.readFileSync(namePath, 'utf8').trim();
              
              if (name === 'package-0' || name === 'cpu') {
                // Read energy twice with delay to calculate power
                const energy1 = parseInt(fs.readFileSync(energyPath, 'utf8'));
                await new Promise(resolve => setTimeout(resolve, 100));
                const energy2 = parseInt(fs.readFileSync(energyPath, 'utf8'));
                
                // Calculate power in watts
                const powerWatts = (energy2 - energy1) / 100000; // Convert from uJ to W
                
                readings.push({
                  device: 'CPU Package',
                  type: 'cpu',
                  id: 0,
                  current: powerWatts,
                  timestamp: new Date()
                });
              }
            } catch {
              // Skip this domain
            }
          }
        }
      } catch {
        // RAPL not available
      }

      // AMD CPU power via hwmon
      try {
        const hwmons = fs.readdirSync('/sys/class/hwmon/');
        
        for (const hwmon of hwmons) {
          try {
            const name = fs.readFileSync(`/sys/class/hwmon/${hwmon}/name`, 'utf8').trim();
            
            if (name === 'k10temp' || name === 'zenpower') {
              const powerFiles = fs.readdirSync(`/sys/class/hwmon/${hwmon}/`)
                .filter(f => f.match(/^power\d+_input$/));
              
              for (const powerFile of powerFiles) {
                const power = parseInt(fs.readFileSync(`/sys/class/hwmon/${hwmon}/${powerFile}`, 'utf8')) / 1000000; // Convert from uW to W
                
                readings.push({
                  device: 'CPU',
                  type: 'cpu',
                  id: 0,
                  current: power,
                  timestamp: new Date()
                });
              }
            }
          } catch {
            // Skip this hwmon
          }
        }
      } catch {
        // Not available
      }
    } else if (process.platform === 'win32') {
      // Windows WMI for CPU power
      try {
        const { stdout } = await execAsync('powershell "Get-WmiObject -Namespace root\\OpenHardwareMonitor -Class Sensor | Where-Object {$_.SensorType -eq \'Power\' -and $_.Name -like \'*CPU*\'} | Select-Object -ExpandProperty Value"');
        const power = parseFloat(stdout.trim());
        
        if (!isNaN(power)) {
          readings.push({
            device: 'CPU',
            type: 'cpu',
            id: 0,
            current: power,
            timestamp: new Date()
          });
        }
      } catch {
        // OpenHardwareMonitor not available or access denied
      }
    }

    // Fallback: Estimate based on TDP and utilization
    if (readings.length === 0) {
      const cpuInfo = os.cpus();
      const utilization = this.calculateCPUUtilization();
      const estimatedTDP = this.estimateCPUTDP();
      const estimatedPower = estimatedTDP * utilization;
      
      readings.push({
        device: 'CPU (Estimated)',
        type: 'cpu',
        id: 0,
        current: estimatedPower,
        timestamp: new Date()
      });
    }

    return readings;
  }

  /**
   * Measure GPU power consumption
   */
  private async measureGPUPower(): Promise<PowerReading[]> {
    const readings: PowerReading[] = [];

    // NVIDIA GPUs
    try {
      const { stdout } = await execAsync('nvidia-smi --query-gpu=index,power.draw --format=csv,noheader,nounits');
      const lines = stdout.trim().split('\n');
      
      for (const line of lines) {
        const [index, power] = line.split(',').map(v => v.trim());
        
        readings.push({
          device: `GPU ${index}`,
          type: 'gpu',
          id: parseInt(index),
          current: parseFloat(power),
          timestamp: new Date()
        });
      }
    } catch {
      // nvidia-smi not available
    }

    // AMD GPUs
    try {
      const { stdout } = await execAsync('rocm-smi -P --json');
      const data = JSON.parse(stdout);
      
      for (const [device, info] of Object.entries(data)) {
        if (typeof info === 'object' && info !== null && 'Average Graphics Package Power (W)' in info) {
          const power = parseFloat(info['Average Graphics Package Power (W)']);
          const id = parseInt(device.replace('card', ''));
          
          readings.push({
            device: `GPU ${id}`,
            type: 'gpu',
            id,
            current: power,
            timestamp: new Date()
          });
        }
      }
    } catch {
      // rocm-smi not available
    }

    // Intel GPUs via hwmon
    if (process.platform === 'linux') {
      try {
        const hwmons = fs.readdirSync('/sys/class/hwmon/');
        
        for (const hwmon of hwmons) {
          try {
            const name = fs.readFileSync(`/sys/class/hwmon/${hwmon}/name`, 'utf8').trim();
            
            if (name.includes('i915')) {
              const powerFile = `${hwmon}/power1_input`;
              if (fs.existsSync(`/sys/class/hwmon/${powerFile}`)) {
                const power = parseInt(fs.readFileSync(`/sys/class/hwmon/${powerFile}`, 'utf8')) / 1000000;
                
                readings.push({
                  device: 'Intel GPU',
                  type: 'gpu',
                  id: 0,
                  current: power,
                  timestamp: new Date()
                });
              }
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
   * Measure system power consumption
   */
  private async measureSystemPower(): Promise<PowerReading | null> {
    // Check for smart power supplies or UPS
    if (process.platform === 'linux') {
      // Check for UPS via NUT (Network UPS Tools)
      try {
        const { stdout } = await execAsync('upsc ups@localhost 2>/dev/null | grep "ups.load\\|input.power" || echo ""');
        const lines = stdout.trim().split('\n');
        let load = 0;
        let power = 0;
        
        for (const line of lines) {
          if (line.includes('ups.load:')) {
            load = parseFloat(line.split(':')[1].trim());
          } else if (line.includes('input.power:')) {
            power = parseFloat(line.split(':')[1].trim());
          }
        }
        
        if (power > 0) {
          return {
            device: 'System',
            type: 'system',
            id: 0,
            current: power,
            timestamp: new Date()
          };
        }
      } catch {
        // NUT not available
      }

      // Check for power supplies with PMBus
      try {
        const i2cDevices = fs.readdirSync('/sys/class/i2c-adapter/');
        // Would check for PMBus devices here
      } catch {
        // Not available
      }
    }

    return null;
  }

  /**
   * Calculate CPU utilization
   */
  private calculateCPUUtilization(): number {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    }

    return 1 - (totalIdle / totalTick);
  }

  /**
   * Estimate CPU TDP
   */
  private estimateCPUTDP(): number {
    const cpuModel = os.cpus()[0].model.toLowerCase();
    
    // Intel desktop CPUs
    if (cpuModel.includes('i9')) return 125;
    if (cpuModel.includes('i7')) return 95;
    if (cpuModel.includes('i5')) return 65;
    if (cpuModel.includes('i3')) return 45;
    
    // AMD desktop CPUs
    if (cpuModel.includes('ryzen 9')) return 105;
    if (cpuModel.includes('ryzen 7')) return 65;
    if (cpuModel.includes('ryzen 5')) return 65;
    if (cpuModel.includes('ryzen 3')) return 45;
    
    // Server CPUs
    if (cpuModel.includes('xeon')) return 150;
    if (cpuModel.includes('epyc')) return 180;
    
    // Default
    return 65;
  }

  /**
   * Update hash rate for a device
   */
  updateHashRate(device: string, hashRate: number): void {
    this.hashRates.set(device, hashRate);
  }

  /**
   * Calculate efficiency metrics
   */
  private calculateEfficiency(): void {
    const metrics: EfficiencyMetrics[] = [];

    // Calculate for each device
    for (const [key, readings] of this.powerReadings) {
      if (readings.length === 0) continue;

      const latestReading = readings[readings.length - 1];
      const hashRate = this.hashRates.get(key) || 0;
      
      if (hashRate === 0) continue;

      // Calculate average power over last minute
      const recentReadings = readings.slice(-12); // Last minute at 5s interval
      const avgPower = recentReadings.reduce((sum, r) => sum + r.current, 0) / recentReadings.length;

      // Calculate hash per watt
      const hashPerWatt = hashRate / avgPower;

      // Calculate cost
      const powerKWh = avgPower / 1000;
      const costPerHour = powerKWh * this.getCurrentElectricityPrice();
      const costPerHash = costPerHour / (hashRate * 3600);

      // Calculate profitability (simplified - would need coin price and difficulty)
      const profitability = this.calculateProfitability(hashRate, avgPower);

      // Determine efficiency rating
      const efficiency = this.rateEfficiency(latestReading.type, hashPerWatt);

      const metric: EfficiencyMetrics = {
        device: latestReading.device,
        hashRate,
        powerConsumption: avgPower,
        hashPerWatt,
        costPerHash,
        profitability,
        efficiency
      };

      metrics.push(metric);
    }

    this.emit('efficiency:calculated', metrics);
  }

  /**
   * Get current electricity price (considering peak hours)
   */
  private getCurrentElectricityPrice(): number {
    if (!this.electricityCost.peakHours) {
      return this.electricityCost.pricePerKWh;
    }

    const now = new Date();
    const hour = now.getHours();
    
    if (hour >= this.electricityCost.peakHours.start && 
        hour < this.electricityCost.peakHours.end) {
      return this.electricityCost.pricePerKWh * this.electricityCost.peakHours.multiplier;
    }

    return this.electricityCost.pricePerKWh;
  }

  /**
   * Calculate profitability (simplified)
   */
  private calculateProfitability(hashRate: number, power: number): number {
    // This is a simplified calculation
    // In reality, would need:
    // - Current coin price
    // - Network difficulty
    // - Block reward
    // - Pool fees
    
    const revenuePerHash = 0.00000001; // Example value
    const revenuePerHour = hashRate * revenuePerHash * 3600;
    
    const powerKWh = power / 1000;
    const costPerHour = powerKWh * this.getCurrentElectricityPrice();
    
    return revenuePerHour - costPerHour;
  }

  /**
   * Rate efficiency based on device type and hash per watt
   */
  private rateEfficiency(type: string, hashPerWatt: number): 'excellent' | 'good' | 'average' | 'poor' {
    // These thresholds would vary by algorithm
    // Example for SHA256
    if (type === 'gpu') {
      if (hashPerWatt > 10000) return 'excellent';
      if (hashPerWatt > 5000) return 'good';
      if (hashPerWatt > 2000) return 'average';
      return 'poor';
    } else if (type === 'cpu') {
      if (hashPerWatt > 1000) return 'excellent';
      if (hashPerWatt > 500) return 'good';
      if (hashPerWatt > 100) return 'average';
      return 'poor';
    }
    
    return 'average';
  }

  /**
   * Get power profile for a device
   */
  getPowerProfile(device: string): PowerProfile | null {
    const readings = this.powerReadings.get(device);
    if (!readings || readings.length === 0) return null;

    const powers = readings.map(r => r.current);
    const idle = Math.min(...powers);
    const peak = Math.max(...powers);
    const average = powers.reduce((sum, p) => sum + p, 0) / powers.length;
    const mining = average; // Assume average is mining power
    
    // Efficiency as percentage of theoretical maximum
    const theoreticalMax = this.getTheoreticalMaxEfficiency(device);
    const actualEfficiency = this.hashRates.get(device) || 0;
    const efficiency = theoreticalMax > 0 ? (actualEfficiency / theoreticalMax) * 100 : 0;

    return {
      idle,
      mining,
      peak,
      average,
      efficiency
    };
  }

  /**
   * Get theoretical maximum efficiency
   */
  private getTheoreticalMaxEfficiency(device: string): number {
    // This would be based on hardware specs
    // Example values
    if (device.includes('GPU')) {
      return 100000000; // 100 MH/s
    } else if (device.includes('CPU')) {
      return 10000000; // 10 MH/s
    }
    return 0;
  }

  /**
   * Generate efficiency report
   */
  generateReport(): string {
    const metrics = this.getCurrentMetrics();
    const totalPower = metrics.reduce((sum, m) => sum + m.powerConsumption, 0);
    const totalHashRate = metrics.reduce((sum, m) => sum + m.hashRate, 0);
    const totalHashPerWatt = totalPower > 0 ? totalHashRate / totalPower : 0;
    const hourlyPowerCost = (totalPower / 1000) * this.getCurrentElectricityPrice();
    const dailyPowerCost = hourlyPowerCost * 24;
    const monthlyPowerCost = dailyPowerCost * 30;

    let report = `# Power Efficiency Report\n\n`;
    report += `## Summary\n`;
    report += `- Total Power Consumption: ${totalPower.toFixed(2)} W\n`;
    report += `- Total Hash Rate: ${(totalHashRate / 1000000).toFixed(2)} MH/s\n`;
    report += `- Overall Efficiency: ${(totalHashPerWatt / 1000).toFixed(2)} KH/W\n`;
    report += `- Electricity Cost: ${this.electricityCost.pricePerKWh} ${this.electricityCost.currency}/kWh\n`;
    report += `- Hourly Cost: ${hourlyPowerCost.toFixed(2)} ${this.electricityCost.currency}\n`;
    report += `- Daily Cost: ${dailyPowerCost.toFixed(2)} ${this.electricityCost.currency}\n`;
    report += `- Monthly Cost: ${monthlyPowerCost.toFixed(2)} ${this.electricityCost.currency}\n\n`;

    report += `## Device Metrics\n`;
    for (const metric of metrics) {
      report += `\n### ${metric.device}\n`;
      report += `- Hash Rate: ${(metric.hashRate / 1000000).toFixed(2)} MH/s\n`;
      report += `- Power: ${metric.powerConsumption.toFixed(2)} W\n`;
      report += `- Efficiency: ${(metric.hashPerWatt / 1000).toFixed(2)} KH/W (${metric.efficiency})\n`;
      report += `- Cost per GH: ${(metric.costPerHash * 1000000000).toFixed(6)} ${this.electricityCost.currency}\n`;
      report += `- Profitability: ${metric.profitability.toFixed(2)} ${this.electricityCost.currency}/hour\n`;
    }

    return report;
  }

  /**
   * Get current efficiency metrics
   */
  getCurrentMetrics(): EfficiencyMetrics[] {
    const metrics: EfficiencyMetrics[] = [];

    for (const [key, readings] of this.powerReadings) {
      if (readings.length === 0) continue;

      const latestReading = readings[readings.length - 1];
      const hashRate = this.hashRates.get(key) || 0;
      
      if (hashRate === 0) continue;

      const avgPower = readings.slice(-12).reduce((sum, r) => sum + r.current, 0) / Math.min(readings.length, 12);
      const hashPerWatt = hashRate / avgPower;
      const costPerHash = (avgPower / 1000 * this.getCurrentElectricityPrice()) / (hashRate * 3600);
      const profitability = this.calculateProfitability(hashRate, avgPower);
      const efficiency = this.rateEfficiency(latestReading.type, hashPerWatt);

      metrics.push({
        device: latestReading.device,
        hashRate,
        powerConsumption: avgPower,
        hashPerWatt,
        costPerHash,
        profitability,
        efficiency
      });
    }

    return metrics;
  }

  /**
   * Set electricity cost
   */
  setElectricityCost(cost: ElectricityCost): void {
    this.electricityCost = cost;
    logger.info('Electricity cost updated', cost);
  }
}

// Export types
export { PowerReading, EfficiencyMetrics, PowerProfile, ElectricityCost };
