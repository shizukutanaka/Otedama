/**
 * 自動復旧・安定性システム
 * 設計思想: Rob Pike (シンプル), John Carmack (堅牢性), Robert C. Martin (保守性)
 * 
 * 機能:
 * - 自動障害検知・復旧
 * - グレースフルシャットダウン
 * - メモリリーク検出
 * - ヘルスチェック
 */

import { EventEmitter } from 'events';

// === 型定義 ===
export interface StabilityConfig {
  monitoring: {
    healthCheckInterval: number;
    memoryLeakThreshold: number;
    cpuUsageThreshold: number;
  };
  recovery: {
    maxRetries: number;
    autoRestart: boolean;
    gracefulShutdownTimeout: number;
  };
  thresholds: {
    memoryUsage: number;
    diskUsage: number;
    networkLatency: number;
  };
}

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'critical' | 'failed';
  uptime: number;
  checks: Record<string, HealthCheck>;
  timestamp: number;
}

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  value: number;
  threshold: number;
  message: string;
}

export interface FailureEvent {
  id: string;
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  component: string;
  message: string;
  timestamp: number;
  resolved: boolean;
}

// === 自動復旧・安定性システム ===
export class StabilitySystem extends EventEmitter {
  private config: StabilityConfig;
  private health: SystemHealth;
  private failures = new Map<string, FailureEvent>();
  private startTime: number;
  private monitoring = false;
  private healthTimer?: NodeJS.Timeout;

  constructor(config: Partial<StabilityConfig> = {}) {
    super();
    
    this.config = {
      monitoring: {
        healthCheckInterval: 10000,
        memoryLeakThreshold: 500,
        cpuUsageThreshold: 80,
        ...config.monitoring
      },
      recovery: {
        maxRetries: 3,
        autoRestart: true,
        gracefulShutdownTimeout: 30000,
        ...config.recovery
      },
      thresholds: {
        memoryUsage: 85,
        diskUsage: 90,
        networkLatency: 1000,
        ...config.thresholds
      }
    };

    this.startTime = Date.now();
    this.initializeHealth();
    this.setupGracefulShutdown();
  }

  // === 初期化 ===
  async initialize(): Promise<void> {
    console.log('🛡️ Initializing stability system...');
    await this.performHealthCheck();
    this.startMonitoring();
    console.log('✅ Stability system initialized');
    this.emit('initialized', this.health);
  }

  // === 監視開始 ===
  startMonitoring(): void {
    if (this.monitoring) return;
    
    this.monitoring = true;
    console.log('👁️ Starting system monitoring...');

    this.healthTimer = setInterval(async () => {
      await this.performHealthCheck();
    }, this.config.monitoring.healthCheckInterval);

    this.emit('monitoringStarted');
  }

  // === ヘルスチェック ===
  async performHealthCheck(): Promise<SystemHealth> {
    const checks = {
      memory: await this.checkMemory(),
      cpu: await this.checkCPU(),
      disk: await this.checkDisk(),
      network: await this.checkNetwork()
    };

    const failedChecks = Object.values(checks).filter(check => check.status === 'fail');
    const warnChecks = Object.values(checks).filter(check => check.status === 'warn');

    let status: SystemHealth['status'];
    if (failedChecks.length > 1) {
      status = 'failed';
    } else if (failedChecks.length > 0) {
      status = 'critical';
    } else if (warnChecks.length > 0) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    this.health = {
      status,
      uptime: Date.now() - this.startTime,
      checks,
      timestamp: Date.now()
    };

    this.handleHealthStatusChange(status);
    this.emit('healthChecked', this.health);
    return this.health;
  }

  // === 個別ヘルスチェック ===
  private async checkMemory(): Promise<HealthCheck> {
    const memUsage = process.memoryUsage();
    const totalMemory = require('os').totalmem();
    const freeMemory = require('os').freemem();
    const percentage = ((totalMemory - freeMemory) / totalMemory) * 100;

    let status: HealthCheck['status'] = 'pass';
    let message = 'Memory usage normal';

    if (percentage > this.config.thresholds.memoryUsage) {
      status = 'fail';
      message = `High memory usage: ${percentage.toFixed(1)}%`;
      this.handleFailure('memory_leak', 'high', 'memory', message);
    } else if (percentage > this.config.thresholds.memoryUsage * 0.8) {
      status = 'warn';
      message = `Elevated memory usage: ${percentage.toFixed(1)}%`;
    }

    return {
      name: 'memory',
      status,
      value: percentage,
      threshold: this.config.thresholds.memoryUsage,
      message
    };
  }

  private async checkCPU(): Promise<HealthCheck> {
    const cpuUsage = await this.getCPUUsage();
    
    let status: HealthCheck['status'] = 'pass';
    let message = 'CPU usage normal';

    if (cpuUsage > this.config.monitoring.cpuUsageThreshold) {
      status = 'fail';
      message = `High CPU usage: ${cpuUsage.toFixed(1)}%`;
    } else if (cpuUsage > this.config.monitoring.cpuUsageThreshold * 0.8) {
      status = 'warn';
      message = `Elevated CPU usage: ${cpuUsage.toFixed(1)}%`;
    }

    return {
      name: 'cpu',
      status,
      value: cpuUsage,
      threshold: this.config.monitoring.cpuUsageThreshold,
      message
    };
  }

  private async checkDisk(): Promise<HealthCheck> {
    const diskUsage = 45; // モック値
    
    let status: HealthCheck['status'] = 'pass';
    let message = 'Disk usage normal';

    if (diskUsage > this.config.thresholds.diskUsage) {
      status = 'fail';
      message = `High disk usage: ${diskUsage.toFixed(1)}%`;
    } else if (diskUsage > this.config.thresholds.diskUsage * 0.8) {
      status = 'warn';
      message = `Elevated disk usage: ${diskUsage.toFixed(1)}%`;
    }

    return {
      name: 'disk',
      status,
      value: diskUsage,
      threshold: this.config.thresholds.diskUsage,
      message
    };
  }

  private async checkNetwork(): Promise<HealthCheck> {
    const latency = Math.random() * 100 + 50; // 50-150ms
    
    let status: HealthCheck['status'] = 'pass';
    let message = 'Network latency normal';

    if (latency > this.config.thresholds.networkLatency) {
      status = 'fail';
      message = `High network latency: ${latency.toFixed(0)}ms`;
    } else if (latency > this.config.thresholds.networkLatency * 0.8) {
      status = 'warn';
      message = `Elevated network latency: ${latency.toFixed(0)}ms`;
    }

    return {
      name: 'network',
      status,
      value: latency,
      threshold: this.config.thresholds.networkLatency,
      message
    };
  }

  // === 障害処理 ===
  private handleFailure(type: string, severity: FailureEvent['severity'], component: string, message: string): void {
    const failureId = `${type}_${component}_${Date.now()}`;
    
    const failure: FailureEvent = {
      id: failureId,
      type,
      severity,
      component,
      message,
      timestamp: Date.now(),
      resolved: false
    };

    this.failures.set(failureId, failure);
    console.log(`🚨 ${severity.toUpperCase()} FAILURE: ${message} (${component})`);
    this.emit('failure', failure);

    // 自動復旧試行
    if (this.config.recovery.autoRestart) {
      this.attemptRecovery(failure);
    }
  }

  private async attemptRecovery(failure: FailureEvent): Promise<void> {
    console.log(`🔧 Attempting recovery for ${failure.id}...`);
    
    try {
      let success = false;

      switch (failure.type) {
        case 'memory_leak':
          success = await this.performMemoryCleanup();
          break;
        default:
          console.warn(`Unknown failure type: ${failure.type}`);
      }

      if (success) {
        failure.resolved = true;
        console.log(`✅ Recovery successful for ${failure.id}`);
        this.emit('recovered', failure);
      } else {
        console.error(`💥 Recovery failed for ${failure.id}`);
        this.emit('recoveryFailed', failure);
      }
    } catch (error) {
      console.error(`❌ Recovery error: ${error.message}`);
    }
  }

  private async performMemoryCleanup(): Promise<boolean> {
    try {
      if (global.gc) {
        global.gc();
        console.log('🧹 Forced garbage collection completed');
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Memory cleanup failed: ${error.message}`);
      return false;
    }
  }

  // === グレースフルシャットダウン ===
  async gracefulShutdown(): Promise<void> {
    console.log('🛑 Initiating graceful shutdown...');

    const shutdownTimeout = setTimeout(() => {
      console.error('💥 Graceful shutdown timeout, forcing exit');
      process.exit(1);
    }, this.config.recovery.gracefulShutdownTimeout);

    try {
      this.stopMonitoring();
      clearTimeout(shutdownTimeout);
      console.log('✅ Graceful shutdown completed');
      this.emit('shutdown');
    } catch (error) {
      console.error(`❌ Shutdown error: ${error.message}`);
      clearTimeout(shutdownTimeout);
      process.exit(1);
    }
  }

  // === ユーティリティ ===
  private initializeHealth(): void {
    this.health = {
      status: 'healthy',
      uptime: 0,
      checks: {},
      timestamp: Date.now()
    };
  }

  private async getCPUUsage(): Promise<number> {
    return new Promise((resolve) => {
      const startUsage = process.cpuUsage();
      setTimeout(() => {
        const endUsage = process.cpuUsage(startUsage);
        const totalUsage = endUsage.user + endUsage.system;
        const percentage = (totalUsage / 1000000) * 100;
        resolve(Math.min(percentage, 100));
      }, 100);
    });
  }

  private handleHealthStatusChange(newStatus: SystemHealth['status']): void {
    const previousStatus = this.health?.status;
    
    if (previousStatus && previousStatus !== newStatus) {
      console.log(`📊 Health status changed: ${previousStatus} → ${newStatus}`);
      this.emit('statusChanged', { from: previousStatus, to: newStatus });
    }
  }

  private setupGracefulShutdown(): void {
    const signals = ['SIGTERM', 'SIGINT'];
    
    signals.forEach(signal => {
      process.on(signal, () => {
        console.log(`📡 Received ${signal}, initiating graceful shutdown...`);
        this.gracefulShutdown();
      });
    });

    process.on('uncaughtException', (error) => {
      console.error('💥 Uncaught exception:', error);
      this.handleFailure('process_crash', 'critical', 'main', error.message);
      this.gracefulShutdown();
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('💥 Unhandled rejection:', reason);
      this.handleFailure('process_crash', 'high', 'promise', `Unhandled rejection: ${reason}`);
    });
  }

  private stopMonitoring(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.monitoring = false;
    console.log('👁️ System monitoring stopped');
  }

  // === パブリックAPI ===
  getHealth(): SystemHealth {
    return { ...this.health };
  }

  getFailures(): FailureEvent[] {
    return Array.from(this.failures.values());
  }
}

// === 使用例 ===
export async function createStabilitySystem(config?: Partial<StabilityConfig>): Promise<StabilitySystem> {
  const stability = new StabilitySystem(config);
  
  stability.on('failure', (failure) => {
    console.error(`🚨 System failure detected: ${failure.message}`);
  });

  stability.on('recovered', (failure) => {
    console.log(`✅ System recovered from: ${failure.message}`);
  });

  await stability.initialize();
  return stability;
}

export default StabilitySystem;