/**
 * CPU Affinity Manager
 * CPUコア固定とワーカープロセス最適化
 */

import { Worker } from 'worker_threads';
import { cpus } from 'os';
import { EventEmitter } from 'events';

interface CpuCore {
  id: number;
  utilization: number;
  temperature?: number;
  frequency?: number;
  workers: Worker[];
}

interface AffinityConfig {
  enableAffinity: boolean;
  reservedCores: number[];
  miningCores: number[];
  systemCores: number[];
  autoBalance: boolean;
  maxWorkersPerCore: number;
}

export class CpuAffinityManager extends EventEmitter {
  private cores: Map<number, CpuCore> = new Map();
  private config: AffinityConfig;
  private monitoringInterval?: NodeJS.Timeout;
  private lastCpuUsage: any[] = [];

  constructor(config: Partial<AffinityConfig> = {}) {
    super();
    
    const coreCount = cpus().length;
    
    this.config = {
      enableAffinity: true,
      reservedCores: [0], // システム用にコア0を予約
      miningCores: Array.from({length: Math.max(1, coreCount - 2)}, (_, i) => i + 1),
      systemCores: [0, coreCount - 1], // システム処理用
      autoBalance: true,
      maxWorkersPerCore: 2,
      ...config
    };

    this.initializeCores();
    this.startMonitoring();
    
    console.log(`[CPU Affinity] Initialized with ${coreCount} cores`);
    console.log(`[CPU Affinity] Mining cores: ${this.config.miningCores.join(', ')}`);
    console.log(`[CPU Affinity] System cores: ${this.config.systemCores.join(', ')}`);
  }

  private initializeCores(): void {
    const cpuInfo = cpus();
    
    cpuInfo.forEach((cpu, index) => {
      this.cores.set(index, {
        id: index,
        utilization: 0,
        frequency: cpu.speed,
        workers: []
      });
    });
  }

  private startMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }

    this.monitoringInterval = setInterval(() => {
      this.updateCpuUsage();
      
      if (this.config.autoBalance) {
        this.balanceWorkers();
      }
      
      this.emit('stats', this.getStats());
    }, 5000); // 5秒間隔で監視
  }

  private updateCpuUsage(): void {
    const currentUsage = cpus();
    
    if (this.lastCpuUsage.length === 0) {
      this.lastCpuUsage = currentUsage;
      return;
    }

    currentUsage.forEach((cpu, index) => {
      const lastCpu = this.lastCpuUsage[index];
      if (!lastCpu) return;

      const currentIdle = cpu.times.idle;
      const currentTotal = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const lastIdle = lastCpu.times.idle;
      const lastTotal = Object.values(lastCpu.times).reduce((a, b) => a + b, 0);

      const idleDiff = currentIdle - lastIdle;
      const totalDiff = currentTotal - lastTotal;
      
      const utilization = totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0;
      
      const core = this.cores.get(index);
      if (core) {
        core.utilization = Math.round(utilization * 100) / 100;
      }
    });

    this.lastCpuUsage = currentUsage;
  }

  private balanceWorkers(): void {
    if (!this.config.autoBalance) return;

    const miningCores = this.config.miningCores
      .map(id => this.cores.get(id))
      .filter(core => core !== undefined)
      .sort((a, b) => a!.utilization - b!.utilization);

    // 負荷の高いコアからワーカーを移動
    miningCores.forEach(core => {
      if (core!.utilization > 80 && core!.workers.length > 1) {
        const worker = core!.workers.pop();
        if (worker) {
          const targetCore = miningCores.find(c => 
            c!.utilization < 60 && 
            c!.workers.length < this.config.maxWorkersPerCore
          );
          
          if (targetCore) {
            targetCore.workers.push(worker);
            console.log(`[CPU Affinity] Moved worker from core ${core!.id} to core ${targetCore.id}`);
          }
        }
      }
    });
  }

  /**
   * マイニングワーカーを最適なコアに割り当て
   */
  public assignWorkerToCore(worker: Worker, preferredCore?: number): number {
    if (!this.config.enableAffinity) {
      return -1; // アフィニティ無効
    }

    let targetCoreId: number;

    if (preferredCore !== undefined && this.config.miningCores.includes(preferredCore)) {
      targetCoreId = preferredCore;
    } else {
      // 最も負荷の低いマイニング用コアを選択
      const availableCores = this.config.miningCores
        .map(id => ({ id, core: this.cores.get(id) }))
        .filter(({ core }) => core && core.workers.length < this.config.maxWorkersPerCore)
        .sort((a, b) => a.core!.utilization - b.core!.utilization);

      if (availableCores.length === 0) {
        console.warn('[CPU Affinity] No available cores for new worker');
        return -1;
      }

      targetCoreId = availableCores[0].id;
    }

    const targetCore = this.cores.get(targetCoreId);
    if (targetCore) {
      targetCore.workers.push(worker);
      
      // Linuxの場合、tasksetでアフィニティを設定
      if (process.platform === 'linux') {
        try {
          const { exec } = require('child_process');
          exec(`taskset -cp ${targetCoreId} ${worker.threadId}`, (error) => {
            if (error) {
              console.warn(`[CPU Affinity] Failed to set affinity: ${error.message}`);
            } else {
              console.log(`[CPU Affinity] Worker ${worker.threadId} assigned to core ${targetCoreId}`);
            }
          });
        } catch (error) {
          console.warn('[CPU Affinity] taskset not available');
        }
      }

      this.emit('workerAssigned', { workerId: worker.threadId, coreId: targetCoreId });
      return targetCoreId;
    }

    return -1;
  }

  /**
   * ワーカーをコアから除去
   */
  public removeWorkerFromCore(worker: Worker): void {
    for (const [coreId, core] of this.cores) {
      const index = core.workers.findIndex(w => w.threadId === worker.threadId);
      if (index !== -1) {
        core.workers.splice(index, 1);
        console.log(`[CPU Affinity] Worker ${worker.threadId} removed from core ${coreId}`);
        this.emit('workerRemoved', { workerId: worker.threadId, coreId });
        break;
      }
    }
  }

  /**
   * システム処理用コアの負荷チェック
   */
  public isSystemCoreOverloaded(): boolean {
    const systemCores = this.config.systemCores
      .map(id => this.cores.get(id))
      .filter(core => core !== undefined);

    const avgUtilization = systemCores.reduce((sum, core) => sum + core!.utilization, 0) / systemCores.length;
    return avgUtilization > 85;
  }

  /**
   * 最適なコア設定を提案
   */
  public getOptimizedConfig(): Partial<AffinityConfig> {
    const coreCount = cpus().length;
    const highPerformanceCores = Array.from(this.cores.values())
      .sort((a, b) => (b.frequency || 0) - (a.frequency || 0))
      .slice(0, Math.floor(coreCount * 0.8))
      .map(core => core.id);

    return {
      miningCores: highPerformanceCores.slice(1), // 最高性能コア以外をマイニングに
      systemCores: [0, highPerformanceCores[0]], // コア0と最高性能コアをシステムに
      maxWorkersPerCore: coreCount > 8 ? 2 : 1,
    };
  }

  /**
   * 統計情報取得
   */
  public getStats() {
    const coreStats = Array.from(this.cores.values()).map(core => ({
      id: core.id,
      utilization: core.utilization,
      frequency: core.frequency,
      workerCount: core.workers.length,
      type: this.config.miningCores.includes(core.id) ? 'mining' : 
            this.config.systemCores.includes(core.id) ? 'system' : 'available'
    }));

    const totalUtilization = coreStats.reduce((sum, core) => sum + core.utilization, 0) / coreStats.length;
    const miningUtilization = coreStats
      .filter(core => core.type === 'mining')
      .reduce((sum, core) => sum + core.utilization, 0) / 
      Math.max(1, coreStats.filter(core => core.type === 'mining').length);

    return {
      cores: coreStats,
      totalUtilization: Math.round(totalUtilization * 100) / 100,
      miningUtilization: Math.round(miningUtilization * 100) / 100,
      totalWorkers: coreStats.reduce((sum, core) => sum + core.workerCount, 0),
      config: this.config
    };
  }

  /**
   * 設定更新
   */
  public updateConfig(newConfig: Partial<AffinityConfig>): void {
    this.config = { ...this.config, ...newConfig };
    console.log('[CPU Affinity] Configuration updated:', this.config);
    this.emit('configUpdated', this.config);
  }

  /**
   * リソース解放
   */
  public destroy(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
    
    this.cores.clear();
    this.removeAllListeners();
    console.log('[CPU Affinity] Manager destroyed');
  }
}

export default CpuAffinityManager;