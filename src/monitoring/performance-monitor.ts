/**
 * Performance Monitor - システムパフォーマンス監視
 * 
 * 設計思想: John Carmack (高性能・最適化重視)
 * 
 * 機能:
 * - リアルタイムシステム監視
 * - ハードウェア状態追跡
 * - パフォーマンスメトリクス収集
 * - 最適化提案
 * - アラート・通知
 */

import { EventEmitter } from 'events';
import * as os from 'os';
import * as fs from 'fs';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface SystemMetrics {
  timestamp: number;
  cpu: {
    usage: number; // %
    cores: number;
    model: string;
    speed: number; // MHz
    temperature?: number; // °C
    loadAverage: number[];
  };
  memory: {
    total: number; // bytes
    used: number; // bytes
    free: number; // bytes
    usage: number; // %
    swap: {
      total: number;
      used: number;
      free: number;
    };
  };
  disk: {
    total: number; // bytes
    used: number; // bytes
    free: number; // bytes
    usage: number; // %
    readSpeed: number; // MB/s
    writeSpeed: number; // MB/s
  };
  network: {
    interfaces: NetworkInterface[];
    totalRx: number; // bytes
    totalTx: number; // bytes
    rxSpeed: number; // MB/s
    txSpeed: number; // MB/s
  };
  gpu?: GPUMetrics[];
  power?: {
    batteryLevel?: number; // %
    batteryCharging?: boolean;
    powerConsumption?: number; // watts
  };
  processes: {
    count: number;
    topCPU: ProcessInfo[];
    topMemory: ProcessInfo[];
  };
}

export interface NetworkInterface {
  name: string;
  address: string;
  rx: number; // bytes received
  tx: number; // bytes transmitted
  speed: number; // Mbps
}

export interface GPUMetrics {
  id: string;
  name: string;
  vendor: 'NVIDIA' | 'AMD' | 'Intel';
  temperature: number; // °C
  fanSpeed: number; // %
  powerUsage: number; // watts
  memoryUsed: number; // MB
  memoryTotal: number; // MB
  utilization: number; // %
  clockCore: number; // MHz
  clockMemory: number; // MHz
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number; // %
  memory: number; // bytes
}

export interface PerformanceAlert {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  component: string;
  message: string;
  value: number;
  threshold: number;
  timestamp: number;
  resolved?: boolean;
}

export interface OptimizationSuggestion {
  id: string;
  category: 'performance' | 'power' | 'thermal' | 'memory';
  title: string;
  description: string;
  impact: 'low' | 'medium' | 'high';
  difficulty: 'easy' | 'medium' | 'hard';
  actions: string[];
  estimatedGain: string;
}

export interface MonitoringConfig {
  updateInterval: number; // ms
  enableGPUMonitoring: boolean;
  enableNetworkMonitoring: boolean;
  enableProcessMonitoring: boolean;
  alertThresholds: {
    cpuUsage: number;
    memoryUsage: number;
    diskUsage: number;
    temperature: number;
    gpuTemperature: number;
  };
  historySize: number; // number of samples to keep
}

export class PerformanceMonitor extends EventEmitter {
  private logger: any;
  private config: MonitoringConfig;
  private metricsHistory: SystemMetrics[] = [];
  private alerts: Map<string, PerformanceAlert> = new Map();
  private monitoringTimer?: NodeJS.Timeout;
  private previousNetworkStats?: any;
  private previousDiskStats?: any;
  private isMonitoring = false;

  constructor(logger: any, config?: Partial<MonitoringConfig>) {
    super();
    this.logger = logger;
    this.config = {
      updateInterval: 5000, // 5秒
      enableGPUMonitoring: true,
      enableNetworkMonitoring: true,
      enableProcessMonitoring: true,
      alertThresholds: {
        cpuUsage: 90,
        memoryUsage: 85,
        diskUsage: 90,
        temperature: 85,
        gpuTemperature: 83
      },
      historySize: 1440, // 24時間分（5秒間隔）
      ...config
    };
  }

  async start(): Promise<void> {
    if (this.isMonitoring) return;

    this.logger.info('Starting Performance Monitor...');

    try {
      // 初期メトリクス収集
      await this.collectMetrics();

      // 定期監視開始
      this.monitoringTimer = setInterval(async () => {
        try {
          await this.collectMetrics();
        } catch (error) {
          this.logger.error('Failed to collect metrics:', error);
        }
      }, this.config.updateInterval);

      this.isMonitoring = true;
      this.logger.success('Performance Monitor started');

    } catch (error) {
      this.logger.error('Failed to start Performance Monitor:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isMonitoring) return;

    this.logger.info('Stopping Performance Monitor...');

    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = undefined;
    }

    this.isMonitoring = false;
    this.logger.success('Performance Monitor stopped');
  }

  private async collectMetrics(): Promise<void> {
    const startTime = Date.now();

    try {
      const metrics: SystemMetrics = {
        timestamp: startTime,
        cpu: await this.getCPUMetrics(),
        memory: await this.getMemoryMetrics(),
        disk: await this.getDiskMetrics(),
        network: await this.getNetworkMetrics(),
        processes: await this.getProcessMetrics()
      };

      // GPU監視
      if (this.config.enableGPUMonitoring) {
        metrics.gpu = await this.getGPUMetrics();
      }

      // 電力監視
      metrics.power = await this.getPowerMetrics();

      // メトリクス履歴に追加
      this.metricsHistory.push(metrics);
      if (this.metricsHistory.length > this.config.historySize) {
        this.metricsHistory.shift();
      }

      // アラートチェック
      this.checkAlerts(metrics);

      // イベント発行
      this.emit('metrics', metrics);

      const collectionTime = Date.now() - startTime;
      this.logger.logPerformance('metrics_collection', collectionTime, 'ms');

    } catch (error) {
      this.logger.error('Failed to collect metrics:', error);
    }
  }

  private async getCPUMetrics(): Promise<SystemMetrics['cpu']> {
    const cpus = os.cpus();
    const loadAvg = os.loadavg();
    
    // CPU使用率計算
    const usage = await this.calculateCPUUsage();
    
    // CPU温度取得（プラットフォーム依存）
    let temperature: number | undefined;
    try {
      temperature = await this.getCPUTemperature();
    } catch {
      // 温度取得に失敗した場合は無視
    }

    return {
      usage,
      cores: cpus.length,
      model: cpus[0]?.model || 'Unknown',
      speed: cpus[0]?.speed || 0,
      temperature,
      loadAverage: loadAvg
    };
  }

  private async calculateCPUUsage(): Promise<number> {
    return new Promise((resolve) => {
      const startUsage = process.cpuUsage();
      const startTime = process.hrtime();

      setTimeout(() => {
        const endUsage = process.cpuUsage(startUsage);
        const endTime = process.hrtime(startTime);

        const totalTime = endTime[0] * 1e6 + endTime[1] / 1e3; // マイクロ秒
        const totalUsage = endUsage.user + endUsage.system;
        const usage = (totalUsage / totalTime) * 100;

        resolve(Math.min(100, Math.max(0, usage)));
      }, 100);
    });
  }

  private async getCPUTemperature(): Promise<number> {
    const platform = os.platform();
    
    try {
      if (platform === 'linux') {
        // Linux: /sys/class/thermal/thermal_zone*/temp
        const tempFile = '/sys/class/thermal/thermal_zone0/temp';
        if (fs.existsSync(tempFile)) {
          const temp = fs.readFileSync(tempFile, 'utf8');
          return parseInt(temp) / 1000; // mC to C
        }
      } else if (platform === 'darwin') {
        // macOS: powermetrics or system_profiler
        const { stdout } = await execAsync('sudo powermetrics --poweravg 1 -n 1 -i 1000 | grep "CPU die temperature"');
        const match = stdout.match(/(\d+\.\d+)/);
        if (match) return parseFloat(match[1]);
      } else if (platform === 'win32') {
        // Windows: WMI or hardware monitoring
        const { stdout } = await execAsync('wmic /namespace:\\\\root\\cimv2 path Win32_PerfRawData_Counters_ThermalZoneInformation get Temperature');
        const lines = stdout.split('\n');
        for (const line of lines) {
          const temp = parseInt(line.trim());
          if (!isNaN(temp) && temp > 0) {
            return (temp - 2732) / 10; // Kelvin to Celsius
          }
        }
      }
    } catch (error) {
      // 温度取得に失敗
    }

    return 45; // デフォルト値
  }

  private async getMemoryMetrics(): Promise<SystemMetrics['memory']> {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const usage = (usedMem / totalMem) * 100;

    // スワップ情報取得
    let swap = { total: 0, used: 0, free: 0 };
    try {
      if (os.platform() === 'linux') {
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
        const swapTotal = meminfo.match(/SwapTotal:\s+(\d+)/);
        const swapFree = meminfo.match(/SwapFree:\s+(\d+)/);
        
        if (swapTotal && swapFree) {
          swap.total = parseInt(swapTotal[1]) * 1024;
          swap.free = parseInt(swapFree[1]) * 1024;
          swap.used = swap.total - swap.free;
        }
      }
    } catch (error) {
      // スワップ情報取得に失敗
    }

    return {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      usage,
      swap
    };
  }

  private async getDiskMetrics(): Promise<SystemMetrics['disk']> {
    let total = 0;
    let used = 0;
    let free = 0;
    let readSpeed = 0;
    let writeSpeed = 0;

    try {
      const platform = os.platform();
      
      if (platform === 'win32') {
        const { stdout } = await execAsync('wmic logicaldisk get size,freespace /value');
        const lines = stdout.split('\n');
        
        for (const line of lines) {
          if (line.includes('FreeSpace=')) {
            free += parseInt(line.split('=')[1]) || 0;
          }
          if (line.includes('Size=')) {
            total += parseInt(line.split('=')[1]) || 0;
          }
        }
        used = total - free;
      } else {
        const { stdout } = await execAsync('df -B1 /');
        const lines = stdout.split('\n');
        if (lines.length > 1) {
          const parts = lines[1].split(/\s+/);
          total = parseInt(parts[1]) || 0;
          used = parseInt(parts[2]) || 0;
          free = parseInt(parts[3]) || 0;
        }
      }

      // ディスクI/O速度計算
      const currentStats = await this.getDiskIOStats();
      if (this.previousDiskStats) {
        const timeDiff = (Date.now() - this.previousDiskStats.timestamp) / 1000;
        readSpeed = (currentStats.readBytes - this.previousDiskStats.readBytes) / timeDiff / 1024 / 1024;
        writeSpeed = (currentStats.writeBytes - this.previousDiskStats.writeBytes) / timeDiff / 1024 / 1024;
      }
      this.previousDiskStats = currentStats;

    } catch (error) {
      this.logger.debug('Failed to get disk metrics:', error);
    }

    const usage = total > 0 ? (used / total) * 100 : 0;

    return {
      total,
      used,
      free,
      usage,
      readSpeed: Math.max(0, readSpeed),
      writeSpeed: Math.max(0, writeSpeed)
    };
  }

  private async getDiskIOStats(): Promise<any> {
    const platform = os.platform();
    let readBytes = 0;
    let writeBytes = 0;

    try {
      if (platform === 'linux') {
        const diskstats = fs.readFileSync('/proc/diskstats', 'utf8');
        const lines = diskstats.split('\n');
        
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 14 && parts[2].startsWith('sd')) {
            readBytes += parseInt(parts[5]) * 512; // sectors to bytes
            writeBytes += parseInt(parts[9]) * 512;
          }
        }
      }
    } catch (error) {
      // I/O統計取得に失敗
    }

    return {
      timestamp: Date.now(),
      readBytes,
      writeBytes
    };
  }

  private async getNetworkMetrics(): Promise<SystemMetrics['network']> {
    if (!this.config.enableNetworkMonitoring) {
      return { interfaces: [], totalRx: 0, totalTx: 0, rxSpeed: 0, txSpeed: 0 };
    }

    const interfaces: NetworkInterface[] = [];
    let totalRx = 0;
    let totalTx = 0;
    let rxSpeed = 0;
    let txSpeed = 0;

    try {
      const networkInterfaces = os.networkInterfaces();
      
      for (const [name, addresses] of Object.entries(networkInterfaces)) {
        if (!addresses) continue;
        
        for (const addr of addresses) {
          if (addr.family === 'IPv4' && !addr.internal) {
            const stats = await this.getNetworkInterfaceStats(name);
            
            interfaces.push({
              name,
              address: addr.address,
              rx: stats.rx,
              tx: stats.tx,
              speed: stats.speed
            });
            
            totalRx += stats.rx;
            totalTx += stats.tx;
          }
        }
      }

      // ネットワーク速度計算
      if (this.previousNetworkStats) {
        const timeDiff = (Date.now() - this.previousNetworkStats.timestamp) / 1000;
        rxSpeed = (totalRx - this.previousNetworkStats.totalRx) / timeDiff / 1024 / 1024;
        txSpeed = (totalTx - this.previousNetworkStats.totalTx) / timeDiff / 1024 / 1024;
      }

      this.previousNetworkStats = { timestamp: Date.now(), totalRx, totalTx };

    } catch (error) {
      this.logger.debug('Failed to get network metrics:', error);
    }

    return {
      interfaces,
      totalRx,
      totalTx,
      rxSpeed: Math.max(0, rxSpeed),
      txSpeed: Math.max(0, txSpeed)
    };
  }

  private async getNetworkInterfaceStats(interfaceName: string): Promise<any> {
    const platform = os.platform();
    let rx = 0;
    let tx = 0;
    let speed = 0;

    try {
      if (platform === 'linux') {
        const rxFile = `/sys/class/net/${interfaceName}/statistics/rx_bytes`;
        const txFile = `/sys/class/net/${interfaceName}/statistics/tx_bytes`;
        
        if (fs.existsSync(rxFile) && fs.existsSync(txFile)) {
          rx = parseInt(fs.readFileSync(rxFile, 'utf8'));
          tx = parseInt(fs.readFileSync(txFile, 'utf8'));
        }
      } else if (platform === 'win32') {
        const { stdout } = await execAsync(`wmic path Win32_PerfRawData_Tcpip_NetworkInterface where "Name='${interfaceName}'" get BytesReceivedPerSec,BytesSentPerSec /value`);
        const rxMatch = stdout.match(/BytesReceivedPerSec=(\d+)/);
        const txMatch = stdout.match(/BytesSentPerSec=(\d+)/);
        
        if (rxMatch) rx = parseInt(rxMatch[1]);
        if (txMatch) tx = parseInt(txMatch[1]);
      }
    } catch (error) {
      // ネットワーク統計取得に失敗
    }

    return { rx, tx, speed };
  }

  private async getGPUMetrics(): Promise<GPUMetrics[]> {
    const gpus: GPUMetrics[] = [];

    try {
      // NVIDIA GPU
      const nvidiaGPUs = await this.getNVIDIAMetrics();
      gpus.push(...nvidiaGPUs);

      // AMD GPU
      const amdGPUs = await this.getAMDMetrics();
      gpus.push(...amdGPUs);

    } catch (error) {
      this.logger.debug('Failed to get GPU metrics:', error);
    }

    return gpus;
  }

  private async getNVIDIAMetrics(): Promise<GPUMetrics[]> {
    const gpus: GPUMetrics[] = [];

    try {
      const { stdout } = await execAsync('nvidia-smi --query-gpu=index,name,temperature.gpu,fan.speed,power.draw,memory.used,memory.total,utilization.gpu,clocks.gr,clocks.mem --format=csv,noheader,nounits');
      const lines = stdout.trim().split('\n');

      for (const line of lines) {
        const [index, name, temp, fan, power, memUsed, memTotal, util, clockCore, clockMem] = line.split(',').map(s => s.trim());

        gpus.push({
          id: `nvidia-${index}`,
          name,
          vendor: 'NVIDIA',
          temperature: parseInt(temp) || 0,
          fanSpeed: parseInt(fan) || 0,
          powerUsage: parseInt(power) || 0,
          memoryUsed: parseInt(memUsed) || 0,
          memoryTotal: parseInt(memTotal) || 0,
          utilization: parseInt(util) || 0,
          clockCore: parseInt(clockCore) || 0,
          clockMemory: parseInt(clockMem) || 0
        });
      }
    } catch (error) {
      // nvidia-smi not available
    }

    return gpus;
  }

  private async getAMDMetrics(): Promise<GPUMetrics[]> {
    const gpus: GPUMetrics[] = [];

    try {
      // ROCm monitoring tools
      const { stdout } = await execAsync('rocm-smi --showtemp --showfan --showpower --showmeminfo vram --showuse');
      // AMD GPU metrics parsing would go here
    } catch (error) {
      // ROCm tools not available
    }

    return gpus;
  }

  private async getPowerMetrics(): Promise<SystemMetrics['power']> {
    let batteryLevel: number | undefined;
    let batteryCharging: boolean | undefined;
    let powerConsumption: number | undefined;

    try {
      const platform = os.platform();

      if (platform === 'win32') {
        const { stdout } = await execAsync('wmic path Win32_Battery get BatteryStatus,EstimatedChargeRemaining /value');
        const levelMatch = stdout.match(/EstimatedChargeRemaining=(\d+)/);
        const statusMatch = stdout.match(/BatteryStatus=(\d+)/);
        
        if (levelMatch) batteryLevel = parseInt(levelMatch[1]);
        if (statusMatch) batteryCharging = statusMatch[1] === '2';
      } else if (platform === 'darwin') {
        const { stdout } = await execAsync('pmset -g batt');
        const match = stdout.match(/(\d+)%.*?(?:charging|discharging|charged)/);
        if (match) {
          batteryLevel = parseInt(match[1]);
          batteryCharging = stdout.includes('charging');
        }
      } else if (platform === 'linux') {
        const batteryPath = '/sys/class/power_supply/BAT0';
        if (fs.existsSync(batteryPath)) {
          const capacity = fs.readFileSync(`${batteryPath}/capacity`, 'utf8');
          const status = fs.readFileSync(`${batteryPath}/status`, 'utf8');
          
          batteryLevel = parseInt(capacity);
          batteryCharging = status.trim() === 'Charging';
        }
      }
    } catch (error) {
      // 電力情報取得に失敗
    }

    return {
      batteryLevel,
      batteryCharging,
      powerConsumption
    };
  }

  private async getProcessMetrics(): Promise<SystemMetrics['processes']> {
    if (!this.config.enableProcessMonitoring) {
      return { count: 0, topCPU: [], topMemory: [] };
    }

    let count = 0;
    const topCPU: ProcessInfo[] = [];
    const topMemory: ProcessInfo[] = [];

    try {
      const platform = os.platform();

      if (platform === 'win32') {
        const { stdout } = await execAsync('wmic process get ProcessId,Name,PageFileUsage,WorkingSetSize /format:csv');
        const lines = stdout.split('\n').slice(1);
        count = lines.filter(line => line.trim()).length;
        
        // Windows process parsing would go here
      } else {
        const { stdout } = await execAsync('ps aux --sort=-%cpu | head -10');
        const lines = stdout.split('\n').slice(1);
        count = parseInt((await execAsync('ps aux | wc -l')).stdout);

        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 11) {
            const pid = parseInt(parts[1]);
            const cpu = parseFloat(parts[2]);
            const memory = parseFloat(parts[3]);
            const name = parts.slice(10).join(' ');

            if (!isNaN(pid)) {
              topCPU.push({ pid, name, cpu, memory: memory * 1024 * 1024 });
            }
          }
        }

        // メモリ使用量でもソート
        topMemory.push(...topCPU.sort((a, b) => b.memory - a.memory).slice(0, 5));
        topCPU.splice(5);
      }
    } catch (error) {
      this.logger.debug('Failed to get process metrics:', error);
    }

    return { count, topCPU, topMemory };
  }

  private checkAlerts(metrics: SystemMetrics): void {
    const alerts: PerformanceAlert[] = [];

    // CPU使用率アラート
    if (metrics.cpu.usage > this.config.alertThresholds.cpuUsage) {
      alerts.push({
        id: 'cpu_high_usage',
        severity: metrics.cpu.usage > 95 ? 'critical' : 'high',
        component: 'CPU',
        message: `High CPU usage: ${metrics.cpu.usage.toFixed(1)}%`,
        value: metrics.cpu.usage,
        threshold: this.config.alertThresholds.cpuUsage,
        timestamp: metrics.timestamp
      });
    }

    // メモリ使用率アラート
    if (metrics.memory.usage > this.config.alertThresholds.memoryUsage) {
      alerts.push({
        id: 'memory_high_usage',
        severity: metrics.memory.usage > 95 ? 'critical' : 'high',
        component: 'Memory',
        message: `High memory usage: ${metrics.memory.usage.toFixed(1)}%`,
        value: metrics.memory.usage,
        threshold: this.config.alertThresholds.memoryUsage,
        timestamp: metrics.timestamp
      });
    }

    // ディスク使用率アラート
    if (metrics.disk.usage > this.config.alertThresholds.diskUsage) {
      alerts.push({
        id: 'disk_high_usage',
        severity: metrics.disk.usage > 95 ? 'critical' : 'high',
        component: 'Disk',
        message: `High disk usage: ${metrics.disk.usage.toFixed(1)}%`,
        value: metrics.disk.usage,
        threshold: this.config.alertThresholds.diskUsage,
        timestamp: metrics.timestamp
      });
    }

    // CPU温度アラート
    if (metrics.cpu.temperature && metrics.cpu.temperature > this.config.alertThresholds.temperature) {
      alerts.push({
        id: 'cpu_high_temperature',
        severity: metrics.cpu.temperature > 90 ? 'critical' : 'high',
        component: 'CPU',
        message: `High CPU temperature: ${metrics.cpu.temperature}°C`,
        value: metrics.cpu.temperature,
        threshold: this.config.alertThresholds.temperature,
        timestamp: metrics.timestamp
      });
    }

    // GPU温度アラート
    if (metrics.gpu) {
      for (const gpu of metrics.gpu) {
        if (gpu.temperature > this.config.alertThresholds.gpuTemperature) {
          alerts.push({
            id: `gpu_high_temperature_${gpu.id}`,
            severity: gpu.temperature > 90 ? 'critical' : 'high',
            component: `GPU ${gpu.id}`,
            message: `High GPU temperature: ${gpu.temperature}°C`,
            value: gpu.temperature,
            threshold: this.config.alertThresholds.gpuTemperature,
            timestamp: metrics.timestamp
          });
        }
      }
    }

    // アラートを保存・通知
    for (const alert of alerts) {
      if (!this.alerts.has(alert.id)) {
        this.alerts.set(alert.id, alert);
        this.emit('alert', alert);
        this.logger.warn(`Performance Alert: ${alert.message}`, alert);
      }
    }

    // 解決されたアラートをチェック
    for (const [id, alert] of this.alerts) {
      if (!alerts.find(a => a.id === id)) {
        alert.resolved = true;
        this.emit('alertResolved', alert);
        this.alerts.delete(id);
      }
    }
  }

  // Public methods
  getCurrentMetrics(): SystemMetrics | null {
    return this.metricsHistory.length > 0 ? 
      this.metricsHistory[this.metricsHistory.length - 1] : null;
  }

  getMetricsHistory(): SystemMetrics[] {
    return [...this.metricsHistory];
  }

  getActiveAlerts(): PerformanceAlert[] {
    return Array.from(this.alerts.values());
  }

  getSystemInfo(): any {
    return {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      uptime: os.uptime(),
      nodeVersion: process.version,
      cpus: os.cpus(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      networkInterfaces: os.networkInterfaces()
    };
  }

  generateOptimizationSuggestions(): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];
    const currentMetrics = this.getCurrentMetrics();
    
    if (!currentMetrics) return suggestions;

    // CPU最適化提案
    if (currentMetrics.cpu.usage > 80) {
      suggestions.push({
        id: 'cpu_optimization',
        category: 'performance',
        title: 'Reduce CPU Load',
        description: 'CPU usage is high. Consider reducing mining intensity or closing unnecessary applications.',
        impact: 'medium',
        difficulty: 'easy',
        actions: [
          'Reduce mining thread count',
          'Close unnecessary applications',
          'Check for background processes',
          'Consider CPU undervolting'
        ],
        estimatedGain: '10-20% performance improvement'
      });
    }

    // メモリ最適化提案
    if (currentMetrics.memory.usage > 85) {
      suggestions.push({
        id: 'memory_optimization',
        category: 'memory',
        title: 'Free up Memory',
        description: 'Memory usage is high. Free up RAM to improve system performance.',
        impact: 'medium',
        difficulty: 'easy',
        actions: [
          'Close unused applications',
          'Clear browser cache',
          'Restart memory-intensive processes',
          'Consider adding more RAM'
        ],
        estimatedGain: '15-25% memory freed'
      });
    }

    // 温度最適化提案
    if (currentMetrics.cpu.temperature && currentMetrics.cpu.temperature > 75) {
      suggestions.push({
        id: 'thermal_optimization',
        category: 'thermal',
        title: 'Improve Cooling',
        description: 'System temperature is elevated. Improve cooling to maintain performance.',
        impact: 'high',
        difficulty: 'medium',
        actions: [
          'Increase fan speeds',
          'Clean dust from components',
          'Improve case ventilation',
          'Consider undervolting',
          'Reduce ambient temperature'
        ],
        estimatedGain: '5-15°C temperature reduction'
      });
    }

    // GPU最適化提案
    if (currentMetrics.gpu && currentMetrics.gpu.length > 0) {
      const hotGPU = currentMetrics.gpu.find(gpu => gpu.temperature > 80);
      if (hotGPU) {
        suggestions.push({
          id: 'gpu_thermal_optimization',
          category: 'thermal',
          title: 'Optimize GPU Cooling',
          description: `GPU ${hotGPU.name} is running hot. Optimize cooling and power settings.`,
          impact: 'high',
          difficulty: 'medium',
          actions: [
            'Increase GPU fan curve',
            'Reduce power limit',
            'Undervolt GPU',
            'Improve case airflow',
            'Clean GPU heatsink'
          ],
          estimatedGain: '10-20°C GPU temperature reduction'
        });
      }
    }

    // 電力最適化提案
    if (currentMetrics.power?.batteryLevel && currentMetrics.power.batteryLevel < 30) {
      suggestions.push({
        id: 'power_optimization',
        category: 'power',
        title: 'Optimize Power Usage',
        description: 'Battery level is low. Switch to power saving mode for mining.',
        impact: 'high',
        difficulty: 'easy',
        actions: [
          'Enable power saving mode',
          'Reduce mining intensity',
          'Close non-essential applications',
          'Connect to AC power'
        ],
        estimatedGain: '30-50% battery life extension'
      });
    }

    return suggestions;
  }

  // Configuration methods
  updateConfig(config: Partial<MonitoringConfig>): void {
    this.config = { ...this.config, ...config };
  }

  setAlertThreshold(component: keyof MonitoringConfig['alertThresholds'], value: number): void {
    this.config.alertThresholds[component] = value;
  }

  // Export methods
  async exportMetrics(filePath: string, fromDate?: Date, toDate?: Date): Promise<void> {
    let metricsToExport = this.metricsHistory;

    if (fromDate || toDate) {
      metricsToExport = this.metricsHistory.filter(metric => {
        const metricDate = new Date(metric.timestamp);
        if (fromDate && metricDate < fromDate) return false;
        if (toDate && metricDate > toDate) return false;
        return true;
      });
    }

    const data = {
      exportTime: new Date().toISOString(),
      config: this.config,
      metrics: metricsToExport,
      alerts: Array.from(this.alerts.values()),
      suggestions: this.generateOptimizationSuggestions()
    };

    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
  }
}
