/**
 * Otedama - 統合ハードウェア監視システム (軽量版)
 * 設計思想: John Carmack (効率性), Robert C. Martin (保守性), Rob Pike (シンプルさ)
 * 
 * 重複ファイル統合・最適化版
 * 機能:
 * - 軽量リアルタイム温度・電力監視
 * - 自動サーマルスロットリング
 * - 予防的アラート
 * - ハードウェア保護
 */

import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import * as os from 'os';

// === 統合型定義 ===
export interface UnifiedHardwareReading {
  timestamp: number;
  cpu: {
    temperature: number;    // °C
    power: number;         // Watts
    usage: number;         // %
    throttling: boolean;
  };
  gpu: Array<{
    id: number;
    name: string;
    temperature: number;   // °C
    power: number;         // Watts
    usage: number;         // %
    fanSpeed: number;      // %
    throttling: boolean;
  }>;
  system: {
    totalPower: number;    // Watts
    efficiency: number;    // H/W
    memoryUsage: number;   // %
  };
}

export interface SafetyAlert {
  id: string;
  timestamp: number;
  level: 'INFO' | 'WARNING' | 'CRITICAL' | 'EMERGENCY';
  device: string;
  message: string;
  temperature?: number;
  power?: number;
  actionTaken?: string;
}

export interface ThermalConfig {
  cpu: { warn: number; critical: number; emergency: number };
  gpu: { warn: number; critical: number; emergency: number };
  power: { warn: number; critical: number };
  updateIntervalMs: number;
  autoThrottle: boolean;
  emergencyShutdown: boolean;
}

// === 軽量ハードウェア監視クラス ===
export class UnifiedHardwareMonitor extends EventEmitter {
  private config: ThermalConfig;
  private monitoring = false;
  private interval?: NodeJS.Timeout;
  private alerts: SafetyAlert[] = [];
  private lastReading?: UnifiedHardwareReading;
  private readingHistory: UnifiedHardwareReading[] = [];

  constructor(config: Partial<ThermalConfig> = {}) {
    super();
    
    this.config = {
      cpu: { warn: 75, critical: 85, emergency: 95 },
      gpu: { warn: 80, critical: 88, emergency: 95 },
      power: { warn: 1500, critical: 2000 },
      updateIntervalMs: 3000, // 3秒間隔 (軽量化)
      autoThrottle: true,
      emergencyShutdown: true,
      ...config
    };
  }

  // === 監視開始/停止 ===
  async start(): Promise<void> {
    if (this.monitoring) return;
    
    console.log('🔍 統合ハードウェア監視開始...');
    this.monitoring = true;
    
    // 初回読み取り
    await this.collectReading();
    
    // 定期監視
    this.interval = setInterval(async () => {
      await this.collectReading();
    }, this.config.updateIntervalMs);
    
    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.monitoring) return;
    
    this.monitoring = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    
    console.log('⏹️ ハードウェア監視停止');
    this.emit('stopped');
  }

  // === データ収集 (軽量化) ===
  private async collectReading(): Promise<void> {
    try {
      const timestamp = Date.now();
      
      // 並列読み取り (軽量化のため最小限)
      const [cpu, gpu, system] = await Promise.all([
        this.readCPU(),
        this.readGPU(),
        this.readSystem()
      ]);

      const reading: UnifiedHardwareReading = {
        timestamp,
        cpu,
        gpu,
        system
      };

      this.lastReading = reading;
      this.addToHistory(reading);
      
      // 安全性チェック
      await this.checkSafety(reading);
      
      this.emit('reading', reading);
      
    } catch (error) {
      console.error('読み取りエラー:', error);
      this.emit('error', error);
    }
  }

  // === CPU監視 (軽量化) ===
  private async readCPU(): Promise<UnifiedHardwareReading['cpu']> {
    const [temperature, power, usage] = await Promise.all([
      this.getCPUTemperature(),
      this.getCPUPower(),
      this.getCPUUsage()
    ]);

    const throttling = temperature >= this.config.cpu.critical;

    return { temperature, power, usage, throttling };
  }

  private async getCPUTemperature(): Promise<number> {
    try {
      if (process.platform === 'linux') {
        // 最も一般的な方法
        const output = execSync('cat /sys/class/thermal/thermal_zone0/temp', 
          { encoding: 'utf8', timeout: 1000 });
        return parseInt(output.trim()) / 1000;
      } 
      
      if (process.platform === 'darwin') {
        // macOS (powermetrics は管理者権限が必要だが、フォールバック付き)
        try {
          const output = execSync('osx-cpu-temp', { encoding: 'utf8', timeout: 1000 });
          return parseFloat(output.replace('°C', '').trim());
        } catch {
          return 45; // Apple Silicon推定値
        }
      }
      
      if (process.platform === 'win32') {
        // Windows WMI
        try {
          const output = execSync(
            'wmic /namespace:\\\\root\\wmi PATH MSAcpi_ThermalZoneTemperature get CurrentTemperature /value',
            { encoding: 'utf8', timeout: 2000 }
          );
          const match = output.match(/CurrentTemperature=(\d+)/);
          if (match) {
            return (parseInt(match[1]) / 10) - 273.15;
          }
        } catch {
          // フォールバック: CPU負荷から推定
          const load = os.loadavg()[0];
          return 35 + (load * 8);
        }
      }
    } catch (error) {
      // エラー時フォールバック
    }
    
    // 最終フォールバック
    const load = os.loadavg()[0] || 1;
    return 40 + (load * 5);
  }

  private async getCPUPower(): Promise<number> {
    // CPU負荷ベースの電力推定 (軽量化)
    const usage = this.getCPUUsage();
    const cpuModel = os.cpus()[0].model.toLowerCase();
    
    let baseTDP = 65; // デフォルト
    if (cpuModel.includes('i9') || cpuModel.includes('ryzen 9')) baseTDP = 125;
    else if (cpuModel.includes('i7') || cpuModel.includes('ryzen 7')) baseTDP = 95;
    else if (cpuModel.includes('apple m')) baseTDP = 20;
    
    return baseTDP * (0.3 + 0.7 * (usage / 100));
  }

  private getCPUUsage(): number {
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

  // === GPU監視 (軽量化) ===
  private async readGPU(): Promise<UnifiedHardwareReading['gpu']> {
    const gpus: UnifiedHardwareReading['gpu'] = [];
    
    // NVIDIA GPU のみ軽量検出
    try {
      const output = execSync(
        'nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,power.draw,fan.speed --format=csv,noheader,nounits',
        { encoding: 'utf8', timeout: 3000 }
      );
      
      const lines = output.trim().split('\n');
      for (const line of lines) {
        const [index, name, temp, usage, power, fanSpeed] = line.split(', ');
        
        const temperature = parseFloat(temp);
        const throttling = temperature >= this.config.gpu.critical;
        
        gpus.push({
          id: parseInt(index),
          name: name.trim(),
          temperature,
          power: parseFloat(power),
          usage: parseFloat(usage),
          fanSpeed: parseFloat(fanSpeed) || 0,
          throttling
        });
      }
    } catch (error) {
      // GPU未検出時は空配列
      console.warn('GPU not detected or nvidia-smi unavailable');
    }
    
    return gpus;
  }

  // === システム監視 (軽量化) ===
  private async readSystem(): Promise<UnifiedHardwareReading['system']> {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const memoryUsage = ((totalMemory - freeMemory) / totalMemory) * 100;
    
    // 総電力 = CPU + GPU
    const cpuPower = await this.getCPUPower();
    const gpuPower = (await this.readGPU()).reduce((sum, gpu) => sum + gpu.power, 0);
    const totalPower = cpuPower + gpuPower;
    
    // 効率性 (ハッシュレートは外部から設定)
    const efficiency = totalPower > 0 ? (this.getHashrate() / totalPower) : 0;

    return {
      totalPower,
      efficiency,
      memoryUsage
    };
  }

  // === 安全性チェック ===
  private async checkSafety(reading: UnifiedHardwareReading): Promise<void> {
    // CPU安全性
    await this.checkCPUSafety(reading.cpu);
    
    // GPU安全性
    for (const gpu of reading.gpu) {
      await this.checkGPUSafety(gpu);
    }
    
    // 電力安全性
    await this.checkPowerSafety(reading.system);
  }

  private async checkCPUSafety(cpu: UnifiedHardwareReading['cpu']): Promise<void> {
    if (cpu.temperature >= this.config.cpu.emergency) {
      await this.emergencyAction('CPU', cpu.temperature, 'EMERGENCY_SHUTDOWN');
    } else if (cpu.temperature >= this.config.cpu.critical) {
      await this.criticalAction('CPU', cpu.temperature, 'THROTTLE');
    } else if (cpu.temperature >= this.config.cpu.warn) {
      this.createAlert('WARNING', 'CPU', `High temperature: ${cpu.temperature}°C`, cpu.temperature);
    }
  }

  private async checkGPUSafety(gpu: UnifiedHardwareReading['gpu'][0]): Promise<void> {
    if (gpu.temperature >= this.config.gpu.emergency) {
      await this.emergencyAction(`GPU${gpu.id}`, gpu.temperature, 'EMERGENCY_SHUTDOWN');
    } else if (gpu.temperature >= this.config.gpu.critical) {
      await this.criticalAction(`GPU${gpu.id}`, gpu.temperature, 'POWER_LIMIT');
    } else if (gpu.temperature >= this.config.gpu.warn) {
      this.createAlert('WARNING', `GPU${gpu.id}`, `High temperature: ${gpu.temperature}°C`, gpu.temperature);
    }
  }

  private async checkPowerSafety(system: UnifiedHardwareReading['system']): Promise<void> {
    if (system.totalPower >= this.config.power.critical) {
      await this.criticalAction('SYSTEM', system.totalPower, 'POWER_LIMIT');
    } else if (system.totalPower >= this.config.power.warn) {
      this.createAlert('WARNING', 'SYSTEM', `High power consumption: ${system.totalPower}W`, undefined, system.totalPower);
    }
  }

  // === 安全アクション ===
  private async emergencyAction(device: string, value: number, action: string): Promise<void> {
    console.log(`🚨 EMERGENCY: ${device} - ${value} - ${action}`);
    
    this.createAlert('EMERGENCY', device, `Emergency action: ${action}`, value, undefined, action);
    
    if (this.config.emergencyShutdown && action === 'EMERGENCY_SHUTDOWN') {
      this.emit('emergencyShutdown', { device, value });
    }
  }

  private async criticalAction(device: string, value: number, action: string): Promise<void> {
    console.log(`🔥 CRITICAL: ${device} - ${value} - ${action}`);
    
    this.createAlert('CRITICAL', device, `Critical action: ${action}`, value, undefined, action);
    
    if (this.config.autoThrottle) {
      if (action === 'THROTTLE') {
        this.emit('throttleRequest', { device, percentage: 75 });
      } else if (action === 'POWER_LIMIT') {
        this.emit('powerLimitRequest', { device, limit: value * 0.8 });
      }
    }
  }

  // === アラート管理 ===
  private createAlert(
    level: SafetyAlert['level'], 
    device: string, 
    message: string, 
    temperature?: number, 
    power?: number, 
    actionTaken?: string
  ): void {
    const alert: SafetyAlert = {
      id: `${level}_${device}_${Date.now()}`,
      timestamp: Date.now(),
      level,
      device,
      message,
      temperature,
      power,
      actionTaken
    };

    this.alerts.push(alert);
    
    // アラート数制限 (最新50件)
    if (this.alerts.length > 50) {
      this.alerts.shift();
    }

    this.emit('alert', alert);
  }

  // === 履歴管理 ===
  private addToHistory(reading: UnifiedHardwareReading): void {
    this.readingHistory.push(reading);
    
    // 履歴制限 (最新100件)
    if (this.readingHistory.length > 100) {
      this.readingHistory.shift();
    }
  }

  // === ユーティリティメソッド ===
  private getHashrate(): number {
    // 外部マイニングモジュールから取得 (デフォルト値)
    return (this as any)._hashrate || 0;
  }

  setHashrate(hashrate: number): void {
    // 外部からハッシュレート設定
    (this as any)._hashrate = hashrate;
  }

  // === 公開メソッド ===
  getCurrentReading(): UnifiedHardwareReading | undefined {
    return this.lastReading;
  }

  getRecentHistory(minutes: number = 10): UnifiedHardwareReading[] {
    const cutoff = Date.now() - (minutes * 60 * 1000);
    return this.readingHistory.filter(r => r.timestamp >= cutoff);
  }

  getActiveAlerts(): SafetyAlert[] {
    const recent = Date.now() - (30 * 60 * 1000); // 30分以内
    return this.alerts.filter(a => a.timestamp >= recent);
  }

  getSystemStatus(): {
    health: 'GOOD' | 'WARNING' | 'CRITICAL' | 'EMERGENCY';
    temperature: { cpu: number; maxGPU: number };
    power: number;
    alerts: number;
    monitoring: boolean;
  } {
    if (!this.lastReading) {
      return { health: 'CRITICAL', temperature: { cpu: 0, maxGPU: 0 }, power: 0, alerts: 0, monitoring: false };
    }

    const activeAlerts = this.getActiveAlerts();
    const emergencyAlerts = activeAlerts.filter(a => a.level === 'EMERGENCY').length;
    const criticalAlerts = activeAlerts.filter(a => a.level === 'CRITICAL').length;
    const warningAlerts = activeAlerts.filter(a => a.level === 'WARNING').length;

    let health: 'GOOD' | 'WARNING' | 'CRITICAL' | 'EMERGENCY' = 'GOOD';
    if (emergencyAlerts > 0) health = 'EMERGENCY';
    else if (criticalAlerts > 0) health = 'CRITICAL';
    else if (warningAlerts > 0) health = 'WARNING';

    const maxGPUTemp = this.lastReading.gpu.length > 0 
      ? Math.max(...this.lastReading.gpu.map(g => g.temperature))
      : 0;

    return {
      health,
      temperature: {
        cpu: this.lastReading.cpu.temperature,
        maxGPU: maxGPUTemp
      },
      power: this.lastReading.system.totalPower,
      alerts: activeAlerts.length,
      monitoring: this.monitoring
    };
  }

  updateConfig(newConfig: Partial<ThermalConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.emit('configUpdated', this.config);
  }
}

// === ファクトリー関数 ===
export async function createUnifiedHardwareMonitor(config?: Partial<ThermalConfig>): Promise<UnifiedHardwareMonitor> {
  const monitor = new UnifiedHardwareMonitor(config);
  
  // 基本イベントハンドラー
  monitor.on('alert', (alert: SafetyAlert) => {
    const emoji = {
      'INFO': 'ℹ️',
      'WARNING': '⚠️',
      'CRITICAL': '🔥',
      'EMERGENCY': '🚨'
    };
    console.log(`${emoji[alert.level]} ${alert.device}: ${alert.message}`);
  });

  monitor.on('emergencyShutdown', (data) => {
    console.log(`🛑 EMERGENCY SHUTDOWN: ${data.device} (${data.value})`);
  });

  monitor.on('throttleRequest', (data) => {
    console.log(`🐌 Throttle requested: ${data.device} to ${data.percentage}%`);
  });

  monitor.on('powerLimitRequest', (data) => {
    console.log(`⚡ Power limit requested: ${data.device} to ${data.limit}W`);
  });

  return monitor;
}

// === 使用例 ===
export async function startHardwareProtection(): Promise<UnifiedHardwareMonitor> {
  const monitor = await createUnifiedHardwareMonitor({
    cpu: { warn: 75, critical: 85, emergency: 95 },
    gpu: { warn: 80, critical: 88, emergency: 95 },
    power: { warn: 1500, critical: 2000 },
    updateIntervalMs: 3000,
    autoThrottle: true,
    emergencyShutdown: true
  });

  await monitor.start();
  
  console.log('✅ ハードウェア保護システム開始');
  return monitor;
}