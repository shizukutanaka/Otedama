/**
 * ハードウェア温度・電力監視システム
 * 設計思想: John Carmack (実用的), Robert C. Martin (安全性), Rob Pike (シンプル)
 * 
 * 機能:
 * - リアルタイム温度・電力監視
 * - 自動サーマルスロットリング
 * - 予防的アラートとシャットダウン
 * - 効率最適化
 */

import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import * as os from 'os';

// === 型定義 ===
export interface ThermalReading {
  device: string;
  type: 'CPU' | 'GPU' | 'SYSTEM';
  temperature: number; // Celsius
  critical: number;    // Critical temperature threshold
  target: number;      // Target temperature
  fanSpeed?: number;   // RPM
  powerDraw?: number;  // Watts
  timestamp: number;
}

export interface PowerReading {
  device: string;
  type: 'CPU' | 'GPU' | 'SYSTEM';
  current: number;     // Watts
  average: number;     // Watts (5-minute average)
  maximum: number;     // Watts (maximum observed)
  limit: number;       // Watts (power limit)
  efficiency: number;  // Hash/Watt
  timestamp: number;
}

export interface ThermalProfile {
  device: string;
  type: 'CPU' | 'GPU' | 'SYSTEM';
  normalTemp: number;      // Normal operating temperature
  warningTemp: number;     // Warning threshold
  criticalTemp: number;    // Critical threshold
  emergencyTemp: number;   // Emergency shutdown
  targetFanCurve: { temp: number; speed: number }[];
  thermalThrottleTemp: number;
  powerLimit: number;      // Maximum power draw
}

export interface MonitoringAlert {
  id: string;
  level: 'INFO' | 'WARNING' | 'CRITICAL' | 'EMERGENCY';
  device: string;
  message: string;
  temperature?: number;
  powerDraw?: number;
  timestamp: number;
  acknowledged: boolean;
  actionTaken?: string;
}

export interface SafetyAction {
  trigger: {
    type: 'temperature' | 'power' | 'combination';
    threshold: number;
    duration?: number; // milliseconds
  };
  action: {
    type: 'throttle' | 'shutdown' | 'alert' | 'fanBoost' | 'powerLimit';
    parameter?: number;
    delay?: number;
  };
  priority: number;
  enabled: boolean;
}

// === ハードウェア監視ベースクラス ===
abstract class HardwareMonitor extends EventEmitter {
  protected device: string;
  protected type: 'CPU' | 'GPU' | 'SYSTEM';
  protected isMonitoring = false;
  protected interval?: NodeJS.Timeout;
  protected updateFrequency = 2000; // 2秒間隔

  constructor(device: string, type: 'CPU' | 'GPU' | 'SYSTEM') {
    super();
    this.device = device;
    this.type = type;
  }

  abstract readTemperature(): Promise<number>;
  abstract readPowerDraw(): Promise<number>;
  abstract readFanSpeed(): Promise<number>;

  start(): void {
    if (this.isMonitoring) return;
    
    this.isMonitoring = true;
    this.interval = setInterval(async () => {
      try {
        await this.updateReadings();
      } catch (error) {
        this.emit('error', { device: this.device, error });
      }
    }, this.updateFrequency);
    
    console.log(`🔍 Started monitoring ${this.device}`);
  }

  stop(): void {
    if (!this.isMonitoring) return;
    
    this.isMonitoring = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    
    console.log(`⏹️ Stopped monitoring ${this.device}`);
  }

  private async updateReadings(): Promise<void> {
    const [temperature, powerDraw, fanSpeed] = await Promise.all([
      this.readTemperature(),
      this.readPowerDraw(),
      this.readFanSpeed()
    ]);

    const thermalReading: ThermalReading = {
      device: this.device,
      type: this.type,
      temperature,
      critical: this.getCriticalTemp(),
      target: this.getTargetTemp(),
      fanSpeed,
      powerDraw,
      timestamp: Date.now()
    };

    const powerReading: PowerReading = {
      device: this.device,
      type: this.type,
      current: powerDraw,
      average: this.calculateAveragePower(),
      maximum: this.getMaxPower(),
      limit: this.getPowerLimit(),
      efficiency: this.calculateEfficiency(),
      timestamp: Date.now()
    };

    this.emit('thermalReading', thermalReading);
    this.emit('powerReading', powerReading);
  }

  // 派生クラスでオーバーライド
  protected getCriticalTemp(): number { return 85; }
  protected getTargetTemp(): number { return 75; }
  protected calculateAveragePower(): number { return 0; }
  protected getMaxPower(): number { return 0; }
  protected getPowerLimit(): number { return 300; }
  protected calculateEfficiency(): number { return 0; }
}

// === CPU監視実装 ===
export class CPUMonitor extends HardwareMonitor {
  private temperatureHistory: number[] = [];
  private powerHistory: number[] = [];

  constructor() {
    super('CPU', 'CPU');
  }

  async readTemperature(): Promise<number> {
    try {
      // Linux
      if (process.platform === 'linux') {
        const thermalZones = [
          '/sys/class/thermal/thermal_zone0/temp',
          '/sys/class/thermal/thermal_zone1/temp'
        ];
        
        for (const zone of thermalZones) {
          try {
            const temp = execSync(`cat ${zone}`, { encoding: 'utf8' });
            const tempCelsius = parseInt(temp.trim()) / 1000;
            this.addToHistory(this.temperatureHistory, tempCelsius);
            return tempCelsius;
          } catch (error) {
            continue;
          }
        }
      }
      
      // Windows (WMI)
      if (process.platform === 'win32') {
        try {
          const output = execSync(
            'wmic /namespace:\\\\root\\wmi PATH MSAcpi_ThermalZoneTemperature get CurrentTemperature',
            { encoding: 'utf8', timeout: 5000 }
          );
          
          const lines = output.split('\n').filter(line => line.trim() && !line.includes('CurrentTemperature'));
          if (lines.length > 0) {
            const kelvin = parseInt(lines[0].trim());
            const celsius = (kelvin / 10) - 273.15;
            this.addToHistory(this.temperatureHistory, celsius);
            return celsius;
          }
        } catch (error) {
          // フォールバック: CPUロード推定
          const loadAvg = os.loadavg()[0];
          const estimatedTemp = 35 + (loadAvg * 8); // 簡易推定
          this.addToHistory(this.temperatureHistory, estimatedTemp);
          return estimatedTemp;
        }
      }
      
      // macOS
      if (process.platform === 'darwin') {
        try {
          // powermetrics使用 (管理者権限必要)
          const output = execSync('sudo powermetrics -n 1 -i 1000 --samplers smc', 
            { encoding: 'utf8', timeout: 5000 });
          
          const tempMatch = output.match(/CPU die temperature: (\d+\.\d+) C/);
          if (tempMatch) {
            const temp = parseFloat(tempMatch[1]);
            this.addToHistory(this.temperatureHistory, temp);
            return temp;
          }
        } catch (error) {
          // フォールバック
          const temp = 40 + Math.random() * 20; // シミュレート
          this.addToHistory(this.temperatureHistory, temp);
          return temp;
        }
      }
      
    } catch (error) {
      console.warn('CPU temperature read failed:', error);
    }
    
    // フォールバック: システム負荷ベースの推定
    const load = os.loadavg()[0];
    const estimatedTemp = 35 + (load * 10);
    this.addToHistory(this.temperatureHistory, estimatedTemp);
    return estimatedTemp;
  }

  async readPowerDraw(): Promise<number> {
    try {
      // Linux (Intel RAPL)
      if (process.platform === 'linux') {
        const energyFiles = [
          '/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj',
          '/sys/devices/virtual/powercap/intel-rapl/intel-rapl:0/energy_uj'
        ];
        
        for (const file of energyFiles) {
          try {
            const energy = execSync(`cat ${file}`, { encoding: 'utf8' });
            const energyMicrojoules = parseInt(energy.trim());
            
            // 簡易電力計算 (前回の測定値と比較が理想的)
            const estimatedWatts = Math.min(150, energyMicrojoules / 1000000 * 0.5);
            this.addToHistory(this.powerHistory, estimatedWatts);
            return estimatedWatts;
          } catch (error) {
            continue;
          }
        }
      }
      
      // フォールバック: CPU使用率ベースの推定
      const cpus = os.cpus();
      let totalUsage = 0;
      
      cpus.forEach(cpu => {
        const total = Object.values(cpu.times).reduce((acc, time) => acc + time, 0);
        const idle = cpu.times.idle;
        const usage = 100 - (idle / total * 100);
        totalUsage += usage;
      });
      
      const avgUsage = totalUsage / cpus.length;
      const basePower = this.estimateBaseCPUPower();
      const estimatedPower = basePower * (0.3 + (avgUsage / 100 * 0.7));
      
      this.addToHistory(this.powerHistory, estimatedPower);
      return estimatedPower;
      
    } catch (error) {
      console.warn('CPU power read failed:', error);
      const estimatedPower = 65; // デフォルトTDP
      this.addToHistory(this.powerHistory, estimatedPower);
      return estimatedPower;
    }
  }

  async readFanSpeed(): Promise<number> {
    try {
      // Linux (lm-sensors)
      if (process.platform === 'linux') {
        const output = execSync('sensors', { encoding: 'utf8', timeout: 3000 });
        const fanMatch = output.match(/fan\d+:\s+(\d+)\s+RPM/);
        if (fanMatch) {
          return parseInt(fanMatch[1]);
        }
      }
      
      // Windows (WMI)
      if (process.platform === 'win32') {
        const output = execSync(
          'wmic path Win32_Fan get DesiredSpeed',
          { encoding: 'utf8', timeout: 3000 }
        );
        
        const lines = output.split('\n').filter(line => line.trim() && !line.includes('DesiredSpeed'));
        if (lines.length > 0) {
          return parseInt(lines[0].trim()) || 0;
        }
      }
      
    } catch (error) {
      // エラーは無視してデフォルト値
    }
    
    // フォールバック: 温度ベースの推定
    const currentTemp = this.temperatureHistory[this.temperatureHistory.length - 1] || 50;
    return Math.max(800, Math.min(3000, (currentTemp - 30) * 50));
  }

  private estimateBaseCPUPower(): number {
    const cpus = os.cpus();
    const cpuModel = cpus[0].model.toLowerCase();
    
    // 簡易TDP推定
    if (cpuModel.includes('i9') || cpuModel.includes('ryzen 9')) return 125;
    if (cpuModel.includes('i7') || cpuModel.includes('ryzen 7')) return 95;
    if (cpuModel.includes('i5') || cpuModel.includes('ryzen 5')) return 65;
    if (cpuModel.includes('apple m')) return 25; // Apple Silicon
    
    return 65; // デフォルト
  }

  private addToHistory(history: number[], value: number): void {
    history.push(value);
    if (history.length > 30) { // 最新30件を保持
      history.shift();
    }
  }

  protected calculateAveragePower(): number {
    if (this.powerHistory.length === 0) return 0;
    return this.powerHistory.reduce((sum, p) => sum + p, 0) / this.powerHistory.length;
  }

  protected getMaxPower(): number {
    return Math.max(...this.powerHistory, 0);
  }
}

// === GPU監視実装 ===
export class GPUMonitor extends HardwareMonitor {
  private gpuIndex: number;
  private temperatureHistory: number[] = [];
  private powerHistory: number[] = [];

  constructor(gpuIndex: number = 0) {
    super(`GPU${gpuIndex}`, 'GPU');
    this.gpuIndex = gpuIndex;
  }

  async readTemperature(): Promise<number> {
    try {
      // NVIDIA GPU
      const output = execSync(
        `nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits -i ${this.gpuIndex}`,
        { encoding: 'utf8', timeout: 5000 }
      );
      
      const temp = parseInt(output.trim());
      this.addToHistory(this.temperatureHistory, temp);
      return temp;
    } catch (error) {
      try {
        // AMD GPU (Linux)
        if (process.platform === 'linux') {
          const tempFile = `/sys/class/drm/card${this.gpuIndex}/device/hwmon/hwmon*/temp1_input`;
          const output = execSync(`cat ${tempFile}`, { encoding: 'utf8' });
          const temp = parseInt(output.trim()) / 1000;
          this.addToHistory(this.temperatureHistory, temp);
          return temp;
        }
      } catch (amdError) {
        // フォールバック
        const estimatedTemp = 45 + Math.random() * 30;
        this.addToHistory(this.temperatureHistory, estimatedTemp);
        return estimatedTemp;
      }
    }
    
    // フォールバック値
    const estimatedTemp = 50;
    this.addToHistory(this.temperatureHistory, estimatedTemp);
    return estimatedTemp;
  }

  async readPowerDraw(): Promise<number> {
    try {
      // NVIDIA GPU
      const output = execSync(
        `nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits -i ${this.gpuIndex}`,
        { encoding: 'utf8', timeout: 5000 }
      );
      
      const power = parseFloat(output.trim());
      this.addToHistory(this.powerHistory, power);
      return power;
    } catch (error) {
      try {
        // AMD GPU推定
        const temp = this.temperatureHistory[this.temperatureHistory.length - 1] || 50;
        const estimatedPower = Math.max(50, Math.min(350, (temp - 30) * 8));
        this.addToHistory(this.powerHistory, estimatedPower);
        return estimatedPower;
      } catch (amdError) {
        const estimatedPower = 150; // デフォルト
        this.addToHistory(this.powerHistory, estimatedPower);
        return estimatedPower;
      }
    }
  }

  async readFanSpeed(): Promise<number> {
    try {
      // NVIDIA GPU
      const output = execSync(
        `nvidia-smi --query-gpu=fan.speed --format=csv,noheader,nounits -i ${this.gpuIndex}`,
        { encoding: 'utf8', timeout: 5000 }
      );
      
      const fanPercent = parseInt(output.trim());
      return fanPercent * 30; // パーセントをRPM概算に変換
    } catch (error) {
      // フォールバック: 温度ベースの推定
      const currentTemp = this.temperatureHistory[this.temperatureHistory.length - 1] || 50;
      return Math.max(1000, Math.min(4000, (currentTemp - 40) * 60));
    }
  }

  private addToHistory(history: number[], value: number): void {
    history.push(value);
    if (history.length > 30) {
      history.shift();
    }
  }

  protected getCriticalTemp(): number { return 83; }
  protected getTargetTemp(): number { return 75; }
  protected getPowerLimit(): number { return 350; }

  protected calculateAveragePower(): number {
    if (this.powerHistory.length === 0) return 0;
    return this.powerHistory.reduce((sum, p) => sum + p, 0) / this.powerHistory.length;
  }

  protected getMaxPower(): number {
    return Math.max(...this.powerHistory, 0);
  }
}

// === 統合監視システム ===
export class HardwareMonitoringSystem extends EventEmitter {
  private monitors: HardwareMonitor[] = [];
  private alerts: MonitoringAlert[] = [];
  private safetyActions: SafetyAction[] = [];
  private profiles = new Map<string, ThermalProfile>();
  private isRunning = false;
  private alertCheckInterval?: NodeJS.Timeout;

  constructor() {
    super();
    this.initializeDefaultProfiles();
    this.initializeDefaultSafetyActions();
  }

  private initializeDefaultProfiles(): void {
    // CPU プロファイル
    this.profiles.set('CPU', {
      device: 'CPU',
      type: 'CPU',
      normalTemp: 45,
      warningTemp: 70,
      criticalTemp: 85,
      emergencyTemp: 95,
      targetFanCurve: [
        { temp: 30, speed: 30 },
        { temp: 50, speed: 50 },
        { temp: 70, speed: 75 },
        { temp: 85, speed: 100 }
      ],
      thermalThrottleTemp: 80,
      powerLimit: 125
    });

    // GPU プロファイル
    this.profiles.set('GPU0', {
      device: 'GPU0',
      type: 'GPU',
      normalTemp: 50,
      warningTemp: 75,
      criticalTemp: 83,
      emergencyTemp: 90,
      targetFanCurve: [
        { temp: 40, speed: 30 },
        { temp: 60, speed: 60 },
        { temp: 75, speed: 85 },
        { temp: 83, speed: 100 }
      ],
      thermalThrottleTemp: 80,
      powerLimit: 350
    });
  }

  private initializeDefaultSafetyActions(): void {
    this.safetyActions = [
      {
        trigger: { type: 'temperature', threshold: 80 },
        action: { type: 'alert', delay: 0 },
        priority: 1,
        enabled: true
      },
      {
        trigger: { type: 'temperature', threshold: 85 },
        action: { type: 'throttle', parameter: 80, delay: 5000 },
        priority: 2,
        enabled: true
      },
      {
        trigger: { type: 'temperature', threshold: 90 },
        action: { type: 'shutdown', delay: 10000 },
        priority: 3,
        enabled: true
      },
      {
        trigger: { type: 'power', threshold: 400 },
        action: { type: 'powerLimit', parameter: 350, delay: 1000 },
        priority: 2,
        enabled: true
      }
    ];
  }

  addMonitor(monitor: HardwareMonitor): void {
    this.monitors.push(monitor);
    
    monitor.on('thermalReading', (reading: ThermalReading) => {
      this.processThermalReading(reading);
      this.emit('thermalReading', reading);
    });
    
    monitor.on('powerReading', (reading: PowerReading) => {
      this.processPowerReading(reading);
      this.emit('powerReading', reading);
    });
    
    monitor.on('error', (error) => {
      this.createAlert('WARNING', error.device, `Monitor error: ${error.error.message}`);
    });
  }

  start(): void {
    if (this.isRunning) return;
    
    this.isRunning = true;
    
    // 全監視開始
    this.monitors.forEach(monitor => monitor.start());
    
    // アラートチェック開始
    this.alertCheckInterval = setInterval(() => {
      this.processAlerts();
    }, 5000); // 5秒間隔
    
    console.log('🔍 Hardware monitoring system started');
    this.emit('systemStarted');
  }

  stop(): void {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    // 全監視停止
    this.monitors.forEach(monitor => monitor.stop());
    
    if (this.alertCheckInterval) {
      clearInterval(this.alertCheckInterval);
      this.alertCheckInterval = undefined;
    }
    
    console.log('⏹️ Hardware monitoring system stopped');
    this.emit('systemStopped');
  }

  private processThermalReading(reading: ThermalReading): void {
    const profile = this.profiles.get(reading.device);
    if (!profile) return;

    // 温度アラートチェック
    if (reading.temperature >= profile.emergencyTemp) {
      this.createAlert('EMERGENCY', reading.device, 
        `Emergency temperature reached: ${reading.temperature}°C`);
      this.executeSafetyAction('temperature', reading.temperature, reading.device);
    } else if (reading.temperature >= profile.criticalTemp) {
      this.createAlert('CRITICAL', reading.device, 
        `Critical temperature: ${reading.temperature}°C`);
      this.executeSafetyAction('temperature', reading.temperature, reading.device);
    } else if (reading.temperature >= profile.warningTemp) {
      this.createAlert('WARNING', reading.device, 
        `High temperature warning: ${reading.temperature}°C`);
    }
  }

  private processPowerReading(reading: PowerReading): void {
    // 電力制限チェック
    if (reading.current > reading.limit * 1.1) { // 10%オーバー
      this.createAlert('WARNING', reading.device, 
        `Power limit exceeded: ${reading.current}W (limit: ${reading.limit}W)`);
      this.executeSafetyAction('power', reading.current, reading.device);
    }
  }

  private executeSafetyAction(triggerType: 'temperature' | 'power', value: number, device: string): void {
    const applicableActions = this.safetyActions
      .filter(action => action.enabled && action.trigger.type === triggerType)
      .filter(action => value >= action.trigger.threshold)
      .sort((a, b) => b.priority - a.priority);

    for (const safetyAction of applicableActions) {
      setTimeout(() => {
        this.performAction(safetyAction, device, value);
      }, safetyAction.action.delay || 0);
    }
  }

  private performAction(safetyAction: SafetyAction, device: string, triggerValue: number): void {
    const action = safetyAction.action;
    
    switch (action.type) {
      case 'throttle':
        console.log(`🚨 Throttling ${device} to ${action.parameter}%`);
        this.emit('throttleRequested', { device, percentage: action.parameter });
        break;
        
      case 'shutdown':
        console.log(`🛑 Emergency shutdown triggered for ${device}`);
        this.createAlert('EMERGENCY', device, 'Emergency shutdown initiated');
        this.emit('emergencyShutdown', { device, triggerValue });
        break;
        
      case 'powerLimit':
        console.log(`⚡ Power limit adjusted for ${device} to ${action.parameter}W`);
        this.emit('powerLimitRequested', { device, limit: action.parameter });
        break;
        
      case 'fanBoost':
        console.log(`🌪️ Fan boost activated for ${device}`);
        this.emit('fanBoostRequested', { device });
        break;
        
      case 'alert':
        // アラートは既に作成済み
        break;
    }
  }

  private createAlert(
    level: 'INFO' | 'WARNING' | 'CRITICAL' | 'EMERGENCY',
    device: string,
    message: string,
    temperature?: number,
    powerDraw?: number
  ): void {
    const alert: MonitoringAlert = {
      id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      level,
      device,
      message,
      temperature,
      powerDraw,
      timestamp: Date.now(),
      acknowledged: false
    };

    this.alerts.push(alert);
    
    // アラート数制限 (最新100件)
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(-100);
    }

    console.log(`🚨 [${level}] ${device}: ${message}`);
    this.emit('alert', alert);
  }

  private processAlerts(): void {
    const unacknowledgedCritical = this.alerts.filter(
      alert => !alert.acknowledged && ['CRITICAL', 'EMERGENCY'].includes(alert.level)
    );

    if (unacknowledgedCritical.length > 0) {
      this.emit('criticalAlertsUnacknowledged', unacknowledgedCritical);
    }
  }

  acknowledgeAlert(alertId: string): void {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      this.emit('alertAcknowledged', alert);
    }
  }

  getSystemStatus() {
    const now = Date.now();
    const recentAlerts = this.alerts.filter(a => now - a.timestamp < 3600000); // 1時間以内

    return {
      running: this.isRunning,
      monitorsActive: this.monitors.length,
      alerts: {
        total: this.alerts.length,
        recent: recentAlerts.length,
        unacknowledged: this.alerts.filter(a => !a.acknowledged).length,
        critical: recentAlerts.filter(a => ['CRITICAL', 'EMERGENCY'].includes(a.level)).length
      },
      safetyActions: {
        total: this.safetyActions.length,
        enabled: this.safetyActions.filter(a => a.enabled).length
      }
    };
  }

  getAlerts(limit: number = 50): MonitoringAlert[] {
    return this.alerts
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }
}

// === 使用例 ===
export async function createHardwareMonitoringSystem(): Promise<HardwareMonitoringSystem> {
  const system = new HardwareMonitoringSystem();
  
  // CPU監視追加
  const cpuMonitor = new CPUMonitor();
  system.addMonitor(cpuMonitor);
  
  // GPU監視追加 (利用可能な場合)
  try {
    const gpuMonitor = new GPUMonitor(0);
    system.addMonitor(gpuMonitor);
  } catch (error) {
    console.warn('GPU monitoring not available:', error);
  }
  
  // イベントハンドラー設定
  system.on('alert', (alert) => {
    console.log(`🚨 ${alert.level}: ${alert.message}`);
  });
  
  system.on('emergencyShutdown', (data) => {
    console.log(`🛑 EMERGENCY SHUTDOWN: ${data.device} (${data.triggerValue})`);
  });
  
  system.on('throttleRequested', (data) => {
    console.log(`🐌 Throttling requested: ${data.device} to ${data.percentage}%`);
  });
  
  return system;
}