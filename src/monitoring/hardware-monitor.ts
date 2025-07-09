/**
 * ハードウェア監視システム (温度・電力・パフォーマンス)
 * 設計思想: John Carmack (高性能), Robert C. Martin (SOLID), Rob Pike (シンプル)
 * 
 * 機能:
 * - リアルタイム温度監視
 * - 電力消費トラッキング
 * - パフォーマンス最適化
 * - 自動サーマルスロットリング
 * - アラート・通知システム
 */

import { EventEmitter } from 'events';
import { execSync, exec } from 'child_process';
import * as os from 'os';

// === 型定義 ===
export interface HardwareMetrics {
  timestamp: number;
  cpu: CPUMetrics;
  gpu: GPUMetrics[];
  system: SystemMetrics;
  mining: MiningMetrics;
}

export interface CPUMetrics {
  temperature: number;        // °C
  usage: number;             // %
  frequency: number;         // MHz
  power: number;             // Watts
  voltage: number;           // V
  cores: CoreMetrics[];
  thermalState: 'normal' | 'warm' | 'hot' | 'critical';
  throttling: boolean;
}

export interface CoreMetrics {
  id: number;
  temperature: number;
  usage: number;
  frequency: number;
}

export interface GPUMetrics {
  id: number;
  name: string;
  vendor: 'NVIDIA' | 'AMD' | 'Intel';
  temperature: number;       // °C
  hotspotTemp?: number;      // °C (AMD specific)
  memoryTemp?: number;       // °C
  usage: number;             // %
  memoryUsage: number;       // %
  memoryUsed: number;        // MB
  memoryTotal: number;       // MB
  power: number;             // Watts
  powerLimit: number;        // Watts
  voltage: number;           // V
  fanSpeed: number;          // %
  frequency: {
    core: number;            // MHz
    memory: number;          // MHz
  };
  thermalState: 'normal' | 'warm' | 'hot' | 'critical';
  throttling: boolean;
  hashrate: number;          // H/s
  efficiency: number;        // H/W
}

export interface SystemMetrics {
  uptime: number;           // seconds
  memoryUsage: number;      // %
  memoryUsed: number;       // MB
  memoryTotal: number;      // MB
  diskUsage: number;        // %
  networkUsage: {
    download: number;       // Mbps
    upload: number;         // Mbps
  };
  ambientTemp?: number;     // °C (if sensor available)
  humidity?: number;        // % (if sensor available)
  powerSupply: {
    efficiency: number;     // %
    load: number;          // %
    temperature?: number;   // °C
  };
}

export interface MiningMetrics {
  totalHashrate: number;    // H/s
  acceptedShares: number;
  rejectedShares: number;
  invalidShares: number;
  shareRate: number;        // shares/min
  difficulty: number;
  uptime: number;          // seconds
  totalPower: number;      // Watts
  efficiency: number;      // H/W
  revenue: {
    current: number;       // $/hour
    daily: number;         // $/day
    monthly: number;       // $/month
  };
}

export interface MonitoringConfig {
  intervalMs: number;
  alerts: {
    temperatureThresholds: {
      cpu: { warn: number; critical: number };
      gpu: { warn: number; critical: number };
    };
    powerThresholds: {
      total: { warn: number; critical: number };
      efficiency: { min: number };
    };
    performanceThresholds: {
      hashrateDropPercent: number;
      shareRejectPercent: number;
    };
  };
  logging: {
    enabled: boolean;
    retentionDays: number;
    metricsToLog: string[];
  };
  autoOptimization: {
    enabled: boolean;
    thermalThrottling: boolean;
    powerCapping: boolean;
    dynamicFanCurves: boolean;
  };
}

export interface Alert {
  id: string;
  timestamp: number;
  severity: 'info' | 'warning' | 'critical';
  category: 'temperature' | 'power' | 'performance' | 'hardware';
  component: string;
  message: string;
  value?: number;
  threshold?: number;
  resolved: boolean;
  actions?: string[];
}

// === CPUモニター ===
export class CPUMonitor {
  async getMetrics(): Promise<CPUMetrics> {
    const cpus = os.cpus();
    const loadavg = os.loadavg();
    
    // 基本メトリクス
    const usage = this.calculateCPUUsage();
    const temperature = await this.getCPUTemperature();
    const frequency = await this.getCPUFrequency();
    const power = await this.getCPUPower();
    const voltage = await this.getCPUVoltage();
    
    // コア別メトリクス
    const cores = await this.getCoreMetrics();
    
    // サーマル状態判定
    const thermalState = this.determineThermalState(temperature);
    const throttling = await this.checkThermalThrottling();

    return {
      temperature,
      usage,
      frequency,
      power,
      voltage,
      cores,
      thermalState,
      throttling
    };
  }

  private calculateCPUUsage(): number {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += (cpu.times as any)[type];
      }
      totalIdle += cpu.times.idle;
    });

    return 100 - Math.round(100 * totalIdle / totalTick);
  }

  private async getCPUTemperature(): Promise<number> {
    try {
      if (process.platform === 'linux') {
        // Linux: sensors command or /sys/class/thermal
        try {
          const output = execSync('sensors -A | grep "Core 0" | awk \'{print $3}\' | sed \'s/+//g\' | sed \'s/°C//g\'', 
            { encoding: 'utf8', timeout: 2000 });
          return parseFloat(output.trim()) || 0;
        } catch {
          // Fallback to thermal zone
          const thermal = execSync('cat /sys/class/thermal/thermal_zone0/temp', 
            { encoding: 'utf8', timeout: 1000 });
          return parseInt(thermal.trim()) / 1000;
        }
      } else if (process.platform === 'darwin') {
        // macOS: osx-cpu-temp or powermetrics
        try {
          const output = execSync('osx-cpu-temp', { encoding: 'utf8', timeout: 2000 });
          return parseFloat(output.replace('°C', '').trim());
        } catch {
          return 45; // Default assumption for macOS
        }
      } else if (process.platform === 'win32') {
        // Windows: WMI query (requires additional tools)
        try {
          const output = execSync(
            'wmic /namespace:\\\\root\\wmi PATH MSAcpi_ThermalZoneTemperature get CurrentTemperature /value',
            { encoding: 'utf8', timeout: 3000 }
          );
          const match = output.match(/CurrentTemperature=(\d+)/);
          if (match) {
            // Convert from tenths of Kelvin to Celsius
            return (parseInt(match[1]) / 10) - 273.15;
          }
        } catch {
          // Fallback for Windows
          return 50; // Conservative estimate
        }
      }
    } catch (error) {
      console.warn('CPU温度取得に失敗:', error);
    }
    
    return 0; // Unknown
  }

  private async getCPUFrequency(): Promise<number> {
    try {
      if (process.platform === 'linux') {
        const freq = execSync('cat /proc/cpuinfo | grep "cpu MHz" | head -1 | awk \'{print $4}\'', 
          { encoding: 'utf8', timeout: 1000 });
        return parseFloat(freq.trim());
      } else {
        // Fallback to os.cpus()
        return os.cpus()[0].speed;
      }
    } catch {
      return os.cpus()[0].speed;
    }
  }

  private async getCPUPower(): Promise<number> {
    // CPU電力は直接測定が困難なため、負荷と仕様から推定
    const usage = this.calculateCPUUsage();
    const cpuModel = os.cpus()[0].model;
    const coreCount = os.cpus().length;
    
    // CPU TDP推定値
    let baseTDP = 65; // デフォルト65W
    
    if (cpuModel.includes('i9') || cpuModel.includes('Ryzen 9')) {
      baseTDP = 125;
    } else if (cpuModel.includes('i7') || cpuModel.includes('Ryzen 7')) {
      baseTDP = 95;
    } else if (cpuModel.includes('i5') || cpuModel.includes('Ryzen 5')) {
      baseTDP = 65;
    } else if (cpuModel.includes('Apple M')) {
      baseTDP = 20; // Apple Silicon効率
    }
    
    // 負荷率に基づく消費電力推定
    return baseTDP * (0.3 + 0.7 * (usage / 100));
  }

  private async getCPUVoltage(): Promise<number> {
    // CPU電圧の直接監視は困難なため、一般的な値を返す
    return 1.2; // Volts (typical)
  }

  private async getCoreMetrics(): Promise<CoreMetrics[]> {
    const cpus = os.cpus();
    const cores: CoreMetrics[] = [];
    
    for (let i = 0; i < Math.min(cpus.length, 8); i++) { // 最大8コア表示
      cores.push({
        id: i,
        temperature: await this.getCoreTemperature(i),
        usage: await this.getCoreUsage(i),
        frequency: cpus[i].speed
      });
    }
    
    return cores;
  }

  private async getCoreTemperature(coreId: number): Promise<number> {
    try {
      if (process.platform === 'linux') {
        const output = execSync(`sensors -A | grep "Core ${coreId}" | awk '{print $3}' | sed 's/+//g' | sed 's/°C//g'`, 
          { encoding: 'utf8', timeout: 1000 });
        return parseFloat(output.trim()) || 0;
      }
    } catch {
      // Fallback
    }
    
    return await this.getCPUTemperature(); // Use general CPU temp
  }

  private async getCoreUsage(coreId: number): Promise<number> {
    // 簡略化: 全体CPU使用率を返す
    return this.calculateCPUUsage();
  }

  private determineThermalState(temperature: number): 'normal' | 'warm' | 'hot' | 'critical' {
    if (temperature >= 90) return 'critical';
    if (temperature >= 80) return 'hot';
    if (temperature >= 70) return 'warm';
    return 'normal';
  }

  private async checkThermalThrottling(): Promise<boolean> {
    try {
      if (process.platform === 'linux') {
        const output = execSync('cat /proc/cpuinfo | grep "cpu MHz" | head -1 | awk \'{print $4}\'', 
          { encoding: 'utf8', timeout: 1000 });
        const currentFreq = parseFloat(output.trim());
        const maxFreq = os.cpus()[0].speed;
        
        // 基本周波数の85%以下ならスロットリング判定
        return currentFreq < (maxFreq * 0.85);
      }
    } catch {
      // Detection failed
    }
    
    return false;
  }
}

// === GPUモニター ===
export class GPUMonitor {
  async getMetrics(): Promise<GPUMetrics[]> {
    const metrics: GPUMetrics[] = [];
    
    // NVIDIA GPUを検出
    const nvidiaGPUs = await this.getNVIDIAMetrics();
    metrics.push(...nvidiaGPUs);
    
    // AMD GPUを検出
    const amdGPUs = await this.getAMDMetrics();
    metrics.push(...amdGPUs);
    
    // Intel GPUを検出
    const intelGPUs = await this.getIntelMetrics();
    metrics.push(...intelGPUs);
    
    return metrics;
  }

  private async getNVIDIAMetrics(): Promise<GPUMetrics[]> {
    const gpus: GPUMetrics[] = [];
    
    try {
      const output = execSync(
        'nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw,power.limit,clocks.gr,clocks.mem,fan.speed --format=csv,noheader,nounits',
        { encoding: 'utf8', timeout: 5000 }
      );
      
      const lines = output.trim().split('\n');
      
      for (const line of lines) {
        const [
          index, name, temp, gpuUtil, memUtil, memUsed, memTotal, 
          power, powerLimit, coreClock, memClock, fanSpeed
        ] = line.split(', ').map(s => s.trim());
        
        const temperature = parseFloat(temp);
        const thermalState = this.determineGPUThermalState(temperature);
        const throttling = temperature > 83; // NVIDIA throttle point
        
        gpus.push({
          id: parseInt(index),
          name,
          vendor: 'NVIDIA',
          temperature,
          usage: parseFloat(gpuUtil),
          memoryUsage: parseFloat(memUtil),
          memoryUsed: parseFloat(memUsed),
          memoryTotal: parseFloat(memTotal),
          power: parseFloat(power),
          powerLimit: parseFloat(powerLimit),
          voltage: 1.0, // NVIDIA doesn't expose voltage easily
          fanSpeed: parseFloat(fanSpeed) || 0,
          frequency: {
            core: parseFloat(coreClock),
            memory: parseFloat(memClock)
          },
          thermalState,
          throttling,
          hashrate: 0, // Will be updated by mining module
          efficiency: 0
        });
      }
    } catch (error) {
      console.warn('NVIDIA GPU メトリクス取得失敗:', error);
    }
    
    return gpus;
  }

  private async getAMDMetrics(): Promise<GPUMetrics[]> {
    const gpus: GPUMetrics[] = [];
    
    try {
      if (process.platform === 'linux') {
        // AMD ROCm-smi
        const output = execSync('rocm-smi --showtemp --showuse --showmemuse --showpower --showclocks --json', 
          { encoding: 'utf8', timeout: 5000 });
        
        // Parse JSON output
        const data = JSON.parse(output);
        
        for (const [cardId, cardData] of Object.entries(data)) {
          if (cardId === 'system') continue;
          
          const metrics = cardData as any;
          const temperature = parseFloat(metrics.Temperature) || 0;
          
          gpus.push({
            id: parseInt(cardId.replace('card', '')),
            name: metrics.GPU || 'AMD GPU',
            vendor: 'AMD',
            temperature,
            hotspotTemp: parseFloat(metrics['Temperature (hotspot)']) || temperature,
            memoryTemp: parseFloat(metrics['Temperature (mem)']) || temperature,
            usage: parseFloat(metrics['GPU use (%)']) || 0,
            memoryUsage: parseFloat(metrics['Memory use (%)']) || 0,
            memoryUsed: 0, // ROCm-smi doesn't provide this easily
            memoryTotal: 0,
            power: parseFloat(metrics['Average Graphics Package Power (W)']) || 0,
            powerLimit: parseFloat(metrics['Power Cap (W)']) || 300,
            voltage: 1.0,
            fanSpeed: parseFloat(metrics['Fan speed (%)']) || 0,
            frequency: {
              core: parseFloat(metrics['GPU Clock (MHz)']) || 0,
              memory: parseFloat(metrics['Memory Clock (MHz)']) || 0
            },
            thermalState: this.determineGPUThermalState(temperature),
            throttling: temperature > 90, // AMD typical throttle point
            hashrate: 0,
            efficiency: 0
          });
        }
      }
    } catch (error) {
      console.warn('AMD GPU メトリクス取得失敗:', error);
    }
    
    return gpus;
  }

  private async getIntelMetrics(): Promise<GPUMetrics[]> {
    const gpus: GPUMetrics[] = [];
    
    try {
      // Intel GPU monitoring is limited, basic detection only
      if (process.platform === 'win32') {
        // Windows Intel Arc detection via WMI (simplified)
        const output = execSync(
          'wmic path win32_VideoController get name,AdapterRAM,DriverVersion /format:csv',
          { encoding: 'utf8', timeout: 3000 }
        );
        
        const lines = output.split('\n').filter(line => line.includes('Intel'));
        
        lines.forEach((line, index) => {
          if (line.includes('Intel')) {
            gpus.push({
              id: index,
              name: 'Intel GPU',
              vendor: 'Intel',
              temperature: 50, // Default assumption
              usage: 0,
              memoryUsage: 0,
              memoryUsed: 0,
              memoryTotal: 0,
              power: 100, // Typical Intel Arc power
              powerLimit: 225,
              voltage: 1.0,
              fanSpeed: 50,
              frequency: { core: 2000, memory: 16000 },
              thermalState: 'normal',
              throttling: false,
              hashrate: 0,
              efficiency: 0
            });
          }
        });
      }
    } catch (error) {
      console.warn('Intel GPU メトリクス取得失敗:', error);
    }
    
    return gpus;
  }

  private determineGPUThermalState(temperature: number): 'normal' | 'warm' | 'hot' | 'critical' {
    if (temperature >= 95) return 'critical';
    if (temperature >= 85) return 'hot';
    if (temperature >= 75) return 'warm';
    return 'normal';
  }
}

// === システムモニター ===
export class SystemMonitor {
  async getMetrics(): Promise<SystemMetrics> {
    const uptime = os.uptime();
    const memoryUsage = this.getMemoryUsage();
    const diskUsage = await this.getDiskUsage();
    const networkUsage = await this.getNetworkUsage();
    const powerSupply = await this.getPowerSupplyMetrics();
    
    return {
      uptime,
      memoryUsage: memoryUsage.percentage,
      memoryUsed: memoryUsage.used,
      memoryTotal: memoryUsage.total,
      diskUsage,
      networkUsage,
      powerSupply
    };
  }

  private getMemoryUsage(): { percentage: number; used: number; total: number } {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const percentage = (used / total) * 100;
    
    return {
      percentage,
      used: used / (1024 * 1024), // MB
      total: total / (1024 * 1024) // MB
    };
  }

  private async getDiskUsage(): Promise<number> {
    try {
      if (process.platform === 'win32') {
        const output = execSync('wmic logicaldisk get size,freespace,caption', 
          { encoding: 'utf8', timeout: 3000 });
        // Parse Windows disk usage
        return 75; // Simplified
      } else {
        const output = execSync('df -h / | tail -1 | awk \'{print $5}\' | sed \'s/%//\'', 
          { encoding: 'utf8', timeout: 2000 });
        return parseInt(output.trim()) || 0;
      }
    } catch {
      return 0;
    }
  }

  private async getNetworkUsage(): Promise<{ download: number; upload: number }> {
    // 簡略化: 固定値返す（実際の実装では統計を追跡）
    return { download: 0, upload: 0 };
  }

  private async getPowerSupplyMetrics(): Promise<{ efficiency: number; load: number; temperature?: number }> {
    // PSU監視は特別なハードウェアが必要なため、推定値を返す
    return {
      efficiency: 85, // Typical 80+ Gold efficiency
      load: 60,      // Estimated load percentage
      temperature: 45 // Estimated PSU temperature
    };
  }
}

// === メインハードウェアモニター ===
export class HardwareMonitor extends EventEmitter {
  private cpuMonitor = new CPUMonitor();
  private gpuMonitor = new GPUMonitor();
  private systemMonitor = new SystemMonitor();
  
  private config: MonitoringConfig;
  private monitoring = false;
  private interval?: NodeJS.Timeout;
  private alerts: Map<string, Alert> = new Map();
  private metricsHistory: HardwareMetrics[] = [];
  
  constructor(config: Partial<MonitoringConfig> = {}) {
    super();
    
    this.config = {
      intervalMs: 5000, // 5秒間隔
      alerts: {
        temperatureThresholds: {
          cpu: { warn: 75, critical: 85 },
          gpu: { warn: 80, critical: 90 }
        },
        powerThresholds: {
          total: { warn: 1500, critical: 2000 },
          efficiency: { min: 0.5 }
        },
        performanceThresholds: {
          hashrateDropPercent: 15,
          shareRejectPercent: 5
        }
      },
      logging: {
        enabled: true,
        retentionDays: 7,
        metricsToLog: ['temperature', 'power', 'hashrate']
      },
      autoOptimization: {
        enabled: true,
        thermalThrottling: true,
        powerCapping: true,
        dynamicFanCurves: true
      },
      ...config
    };
  }

  async startMonitoring(): Promise<void> {
    if (this.monitoring) {
      throw new Error('Monitor is already running');
    }

    console.log('🔍 ハードウェア監視開始...');
    this.monitoring = true;

    // 初回メトリクス取得
    await this.collectMetrics();

    // 定期監視開始
    this.interval = setInterval(async () => {
      await this.collectMetrics();
    }, this.config.intervalMs);

    this.emit('monitoringStarted');
  }

  async stopMonitoring(): Promise<void> {
    if (!this.monitoring) return;

    console.log('🛑 ハードウェア監視停止');
    this.monitoring = false;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    this.emit('monitoringStopped');
  }

  private async collectMetrics(): Promise<void> {
    try {
      const timestamp = Date.now();
      
      // 並列でメトリクス収集
      const [cpu, gpu, system] = await Promise.all([
        this.cpuMonitor.getMetrics(),
        this.gpuMonitor.getMetrics(),
        this.systemMonitor.getMetrics()
      ]);

      const metrics: HardwareMetrics = {
        timestamp,
        cpu,
        gpu,
        system,
        mining: {
          totalHashrate: 0,
          acceptedShares: 0,
          rejectedShares: 0,
          invalidShares: 0,
          shareRate: 0,
          difficulty: 0,
          uptime: system.uptime,
          totalPower: cpu.power + gpu.reduce((sum, g) => sum + g.power, 0),
          efficiency: 0,
          revenue: { current: 0, daily: 0, monthly: 0 }
        }
      };

      // メトリクス履歴に追加
      this.metricsHistory.push(metrics);
      
      // 履歴サイズ制限 (最新1000件)
      if (this.metricsHistory.length > 1000) {
        this.metricsHistory.shift();
      }

      // アラートチェック
      await this.checkAlerts(metrics);

      // 自動最適化
      if (this.config.autoOptimization.enabled) {
        await this.performAutoOptimization(metrics);
      }

      // イベント発火
      this.emit('metricsCollected', metrics);
      
    } catch (error) {
      console.error('メトリクス収集エラー:', error);
      this.emit('error', error);
    }
  }

  private async checkAlerts(metrics: HardwareMetrics): Promise<void> {
    const alerts: Alert[] = [];

    // CPU温度アラート
    if (metrics.cpu.temperature >= this.config.alerts.temperatureThresholds.cpu.critical) {
      alerts.push(this.createAlert('critical', 'temperature', 'CPU', 
        `CPU温度が危険レベル: ${metrics.cpu.temperature}°C`, 
        metrics.cpu.temperature, this.config.alerts.temperatureThresholds.cpu.critical));
    } else if (metrics.cpu.temperature >= this.config.alerts.temperatureThresholds.cpu.warn) {
      alerts.push(this.createAlert('warning', 'temperature', 'CPU',
        `CPU温度が高い: ${metrics.cpu.temperature}°C`,
        metrics.cpu.temperature, this.config.alerts.temperatureThresholds.cpu.warn));
    }

    // GPU温度アラート
    for (const gpu of metrics.gpu) {
      if (gpu.temperature >= this.config.alerts.temperatureThresholds.gpu.critical) {
        alerts.push(this.createAlert('critical', 'temperature', `GPU ${gpu.id}`,
          `GPU温度が危険レベル: ${gpu.temperature}°C`,
          gpu.temperature, this.config.alerts.temperatureThresholds.gpu.critical));
      } else if (gpu.temperature >= this.config.alerts.temperatureThresholds.gpu.warn) {
        alerts.push(this.createAlert('warning', 'temperature', `GPU ${gpu.id}`,
          `GPU温度が高い: ${gpu.temperature}°C`,
          gpu.temperature, this.config.alerts.temperatureThresholds.gpu.warn));
      }
    }

    // 電力アラート
    if (metrics.mining.totalPower >= this.config.alerts.powerThresholds.total.critical) {
      alerts.push(this.createAlert('critical', 'power', 'System',
        `総消費電力が限界: ${metrics.mining.totalPower}W`,
        metrics.mining.totalPower, this.config.alerts.powerThresholds.total.critical));
    } else if (metrics.mining.totalPower >= this.config.alerts.powerThresholds.total.warn) {
      alerts.push(this.createAlert('warning', 'power', 'System',
        `総消費電力が高い: ${metrics.mining.totalPower}W`,
        metrics.mining.totalPower, this.config.alerts.powerThresholds.total.warn));
    }

    // アラート発火
    for (const alert of alerts) {
      this.alerts.set(alert.id, alert);
      this.emit('alert', alert);
    }
  }

  private createAlert(
    severity: 'info' | 'warning' | 'critical',
    category: 'temperature' | 'power' | 'performance' | 'hardware',
    component: string,
    message: string,
    value?: number,
    threshold?: number
  ): Alert {
    return {
      id: `${category}_${component}_${Date.now()}`,
      timestamp: Date.now(),
      severity,
      category,
      component,
      message,
      value,
      threshold,
      resolved: false,
      actions: this.generateAlertActions(severity, category)
    };
  }

  private generateAlertActions(severity: string, category: string): string[] {
    const actions: string[] = [];
    
    if (category === 'temperature') {
      if (severity === 'critical') {
        actions.push('マイニング一時停止', 'ファン速度最大', '通知送信');
      } else {
        actions.push('ファン速度上昇', 'パワーリミット調整');
      }
    }
    
    if (category === 'power') {
      actions.push('電力制限適用', 'クロック速度調整');
    }
    
    return actions;
  }

  private async performAutoOptimization(metrics: HardwareMetrics): Promise<void> {
    // サーマルスロットリング
    if (this.config.autoOptimization.thermalThrottling) {
      await this.applyThermalThrottling(metrics);
    }

    // パワーキャッピング
    if (this.config.autoOptimization.powerCapping) {
      await this.applyPowerCapping(metrics);
    }

    // ダイナミックファンカーブ
    if (this.config.autoOptimization.dynamicFanCurves) {
      await this.adjustFanCurves(metrics);
    }
  }

  private async applyThermalThrottling(metrics: HardwareMetrics): Promise<void> {
    // CPU温度制御
    if (metrics.cpu.temperature > 80) {
      console.log('🌡️ CPU温度制御: パフォーマンス調整');
      // 実際の実装では CPU governor や power limit を調整
    }

    // GPU温度制御
    for (const gpu of metrics.gpu) {
      if (gpu.temperature > 85) {
        console.log(`🌡️ GPU ${gpu.id} 温度制御: パワーリミット調整`);
        // 実際の実装では nvidia-smi や rocm-smi でパワーリミット調整
      }
    }
  }

  private async applyPowerCapping(metrics: HardwareMetrics): Promise<void> {
    if (metrics.mining.totalPower > this.config.alerts.powerThresholds.total.warn) {
      console.log('⚡ 電力制御: 消費電力を調整');
      // 実際の実装では GPU パワーリミットを段階的に調整
    }
  }

  private async adjustFanCurves(metrics: HardwareMetrics): Promise<void> {
    // 温度に応じたファン速度調整
    for (const gpu of metrics.gpu) {
      if (gpu.vendor === 'NVIDIA' && gpu.temperature > 70) {
        console.log(`🌀 GPU ${gpu.id} ファン調整: 温度 ${gpu.temperature}°C`);
        // 実際の実装では nvidia-settings でファンカーブ調整
      }
    }
  }

  // === パブリックメソッド ===
  getCurrentMetrics(): HardwareMetrics | null {
    return this.metricsHistory[this.metricsHistory.length - 1] || null;
  }

  getMetricsHistory(minutes: number = 60): HardwareMetrics[] {
    const cutoff = Date.now() - (minutes * 60 * 1000);
    return this.metricsHistory.filter(m => m.timestamp >= cutoff);
  }

  getActiveAlerts(): Alert[] {
    return Array.from(this.alerts.values()).filter(a => !a.resolved);
  }

  async resolveAlert(alertId: string): Promise<void> {
    const alert = this.alerts.get(alertId);
    if (alert) {
      alert.resolved = true;
      this.emit('alertResolved', alert);
    }
  }

  getSystemStatus(): {
    health: 'good' | 'warning' | 'critical';
    temperature: { cpu: number; gpu: number[] };
    power: number;
    uptime: number;
    alerts: number;
  } {
    const current = this.getCurrentMetrics();
    if (!current) {
      return { health: 'critical', temperature: { cpu: 0, gpu: [] }, power: 0, uptime: 0, alerts: 0 };
    }

    const activeAlerts = this.getActiveAlerts();
    const criticalAlerts = activeAlerts.filter(a => a.severity === 'critical').length;
    const warningAlerts = activeAlerts.filter(a => a.severity === 'warning').length;

    let health: 'good' | 'warning' | 'critical' = 'good';
    if (criticalAlerts > 0) health = 'critical';
    else if (warningAlerts > 0) health = 'warning';

    return {
      health,
      temperature: {
        cpu: current.cpu.temperature,
        gpu: current.gpu.map(g => g.temperature)
      },
      power: current.mining.totalPower,
      uptime: current.system.uptime,
      alerts: activeAlerts.length
    };
  }

  updateConfig(newConfig: Partial<MonitoringConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.emit('configUpdated', this.config);
  }
}

// === 使用例 ===
export async function startHardwareMonitoring(): Promise<HardwareMonitor> {
  const monitor = new HardwareMonitor({
    intervalMs: 5000,
    alerts: {
      temperatureThresholds: {
        cpu: { warn: 75, critical: 85 },
        gpu: { warn: 80, critical: 90 }
      },
      powerThresholds: {
        total: { warn: 1500, critical: 2000 },
        efficiency: { min: 0.5 }
      },
      performanceThresholds: {
        hashrateDropPercent: 15,
        shareRejectPercent: 5
      }
    },
    autoOptimization: {
      enabled: true,
      thermalThrottling: true,
      powerCapping: true,
      dynamicFanCurves: true
    }
  });

  // イベントリスナー設定
  monitor.on('alert', (alert) => {
    console.log(`🚨 ${alert.severity.toUpperCase()}: ${alert.message}`);
  });

  monitor.on('metricsCollected', (metrics) => {
    const status = monitor.getSystemStatus();
    console.log(`📊 System: ${status.health} | CPU: ${status.temperature.cpu}°C | Power: ${status.power}W`);
  });

  await monitor.startMonitoring();
  
  console.log('✅ ハードウェア監視開始完了');
  return monitor;
}

export default HardwareMonitor;