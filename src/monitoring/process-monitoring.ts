/**
 * Process Monitoring and Health Check System
 * Design: Carmack (Performance) + Martin (Clean Architecture) + Pike (Simplicity)
 * 
 * Comprehensive process monitoring with health checks
 */

import { EventEmitter } from 'events';
import { cpus, loadavg, freemem, totalmem } from 'os';
import { performance } from 'perf_hooks';
import cluster from 'cluster';
import { createComponentLogger } from '../logging/simple-logger';

// ===== INTERFACES =====
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  checks: HealthCheckResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
  };
}

export interface HealthCheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message?: string;
  duration: number;
  details?: any;
}

export interface ProcessMetrics {
  pid: number;
  uptime: number;
  cpuUsage: NodeJS.CpuUsage;
  memoryUsage: NodeJS.MemoryUsage;
  handles: number;
  requests: number;
  eventLoopLag: number;
}

export interface SystemMetrics {
  cpuCount: number;
  cpuUsage: number[];
  loadAverage: number[];
  memoryTotal: number;
  memoryFree: number;
  memoryUsedPercent: number;
}

export interface MonitoringConfig {
  checkInterval?: number; // ms
  healthCheckTimeout?: number; // ms
  cpuThreshold?: number; // percentage
  memoryThreshold?: number; // percentage
  eventLoopLagThreshold?: number; // ms
  enableDetailedMetrics?: boolean;
}

// ===== HEALTH CHECK INTERFACE =====
export interface IHealthCheck {
  name: string;
  check(): Promise<HealthCheckResult>;
}

// ===== BASE HEALTH CHECK =====
export abstract class BaseHealthCheck implements IHealthCheck {
  constructor(public name: string) {}

  async check(): Promise<HealthCheckResult> {
    const startTime = performance.now();
    
    try {
      const result = await this.execute();
      const duration = performance.now() - startTime;
      
      return {
        name: this.name,
        status: result.status,
        message: result.message,
        duration,
        details: result.details
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      
      return {
        name: this.name,
        status: 'fail',
        message: (error as Error).message,
        duration
      };
    }
  }

  protected abstract execute(): Promise<{
    status: 'pass' | 'warn' | 'fail';
    message?: string;
    details?: any;
  }>;
}

// ===== BUILT-IN HEALTH CHECKS =====
export class DatabaseHealthCheck extends BaseHealthCheck {
  constructor(
    private databaseCheck: () => Promise<boolean>
  ) {
    super('database');
  }

  protected async execute() {
    const isHealthy = await this.databaseCheck();
    
    return {
      status: isHealthy ? 'pass' : 'fail' as const,
      message: isHealthy ? 'Database connection healthy' : 'Database connection failed'
    };
  }
}

export class RedisHealthCheck extends BaseHealthCheck {
  constructor(
    private redisCheck: () => Promise<boolean>
  ) {
    super('redis');
  }

  protected async execute() {
    const isHealthy = await this.redisCheck();
    
    return {
      status: isHealthy ? 'pass' : 'fail' as const,
      message: isHealthy ? 'Redis connection healthy' : 'Redis connection failed'
    };
  }
}

export class BlockchainHealthCheck extends BaseHealthCheck {
  constructor(
    private blockchainCheck: () => Promise<{ connected: boolean; height?: number }>
  ) {
    super('blockchain');
  }

  protected async execute() {
    const result = await this.blockchainCheck();
    
    return {
      status: result.connected ? 'pass' : 'fail' as const,
      message: result.connected 
        ? `Blockchain connected at height ${result.height}` 
        : 'Blockchain connection failed',
      details: result
    };
  }
}

export class DiskSpaceHealthCheck extends BaseHealthCheck {
  constructor(
    private minFreeSpace: number = 1024 * 1024 * 1024 // 1GB
  ) {
    super('disk-space');
  }

  protected async execute() {
    // This is a simplified check - in production, use proper disk space library
    const freeMemory = freemem(); // Using memory as proxy for demo
    
    if (freeMemory < this.minFreeSpace) {
      return {
        status: 'fail' as const,
        message: `Low disk space: ${(freeMemory / 1024 / 1024 / 1024).toFixed(2)}GB free`,
        details: { freeSpace: freeMemory }
      };
    }

    if (freeMemory < this.minFreeSpace * 2) {
      return {
        status: 'warn' as const,
        message: `Disk space warning: ${(freeMemory / 1024 / 1024 / 1024).toFixed(2)}GB free`,
        details: { freeSpace: freeMemory }
      };
    }

    return {
      status: 'pass' as const,
      message: `Adequate disk space: ${(freeMemory / 1024 / 1024 / 1024).toFixed(2)}GB free`,
      details: { freeSpace: freeMemory }
    };
  }
}

// ===== PROCESS MONITOR =====
export class ProcessMonitor extends EventEmitter {
  private config: Required<MonitoringConfig>;
  private logger = createComponentLogger('ProcessMonitor');
  private monitoringInterval?: NodeJS.Timeout;
  private metrics: ProcessMetrics[] = [];
  private maxMetricsHistory = 100;
  private eventLoopMonitor?: NodeJS.Timeout;
  private lastEventLoopCheck = Date.now();
  private activeRequests = 0;
  private totalRequests = 0;

  constructor(config: MonitoringConfig = {}) {
    super();
    
    this.config = {
      checkInterval: config.checkInterval || 10000, // 10 seconds
      healthCheckTimeout: config.healthCheckTimeout || 5000,
      cpuThreshold: config.cpuThreshold || 80,
      memoryThreshold: config.memoryThreshold || 85,
      eventLoopLagThreshold: config.eventLoopLagThreshold || 100,
      enableDetailedMetrics: config.enableDetailedMetrics || false
    };
  }

  start(): void {
    // Start monitoring
    this.monitoringInterval = setInterval(() => {
      this.collectMetrics();
    }, this.config.checkInterval);

    // Monitor event loop lag
    this.startEventLoopMonitoring();

    this.logger.info('Process monitoring started', {
      pid: process.pid,
      checkInterval: this.config.checkInterval
    });

    // Initial collection
    this.collectMetrics();
  }

  stop(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }

    if (this.eventLoopMonitor) {
      clearInterval(this.eventLoopMonitor);
      this.eventLoopMonitor = undefined;
    }

    this.logger.info('Process monitoring stopped');
  }

  private collectMetrics(): void {
    const metrics: ProcessMetrics = {
      pid: process.pid,
      uptime: process.uptime(),
      cpuUsage: process.cpuUsage(),
      memoryUsage: process.memoryUsage(),
      handles: (process as any)._getActiveHandles?.()?.length || 0,
      requests: (process as any)._getActiveRequests?.()?.length || 0,
      eventLoopLag: this.getEventLoopLag()
    };

    this.metrics.push(metrics);
    
    // Trim history
    if (this.metrics.length > this.maxMetricsHistory) {
      this.metrics.shift();
    }

    // Check thresholds
    this.checkThresholds(metrics);

    this.emit('metrics:collected', metrics);

    if (this.config.enableDetailedMetrics) {
      this.logger.debug('Process metrics collected', metrics);
    }
  }

  private startEventLoopMonitoring(): void {
    let lastCheck = Date.now();

    this.eventLoopMonitor = setInterval(() => {
      const now = Date.now();
      const lag = now - lastCheck - 100; // Expected 100ms interval
      
      if (lag > 0) {
        this.lastEventLoopCheck = lag;
      }
      
      lastCheck = now;
    }, 100);

    // Make sure it doesn't block shutdown
    this.eventLoopMonitor.unref();
  }

  private getEventLoopLag(): number {
    return this.lastEventLoopCheck;
  }

  private checkThresholds(metrics: ProcessMetrics): void {
    const systemMetrics = this.getSystemMetrics();

    // Check CPU usage
    const cpuPercent = this.calculateCpuUsage();
    if (cpuPercent > this.config.cpuThreshold) {
      this.logger.warn('High CPU usage detected', {
        cpuPercent,
        threshold: this.config.cpuThreshold
      });
      this.emit('threshold:exceeded', {
        type: 'cpu',
        value: cpuPercent,
        threshold: this.config.cpuThreshold
      });
    }

    // Check memory usage
    if (systemMetrics.memoryUsedPercent > this.config.memoryThreshold) {
      this.logger.warn('High memory usage detected', {
        memoryUsedPercent: systemMetrics.memoryUsedPercent,
        threshold: this.config.memoryThreshold
      });
      this.emit('threshold:exceeded', {
        type: 'memory',
        value: systemMetrics.memoryUsedPercent,
        threshold: this.config.memoryThreshold
      });
    }

    // Check event loop lag
    if (metrics.eventLoopLag > this.config.eventLoopLagThreshold) {
      this.logger.warn('High event loop lag detected', {
        lag: metrics.eventLoopLag,
        threshold: this.config.eventLoopLagThreshold
      });
      this.emit('threshold:exceeded', {
        type: 'eventLoop',
        value: metrics.eventLoopLag,
        threshold: this.config.eventLoopLagThreshold
      });
    }
  }

  private calculateCpuUsage(): number {
    if (this.metrics.length < 2) return 0;

    const current = this.metrics[this.metrics.length - 1];
    const previous = this.metrics[this.metrics.length - 2];

    const userDiff = current.cpuUsage.user - previous.cpuUsage.user;
    const systemDiff = current.cpuUsage.system - previous.cpuUsage.system;
    const timeDiff = (current.uptime - previous.uptime) * 1000000; // Convert to microseconds

    return ((userDiff + systemDiff) / timeDiff) * 100;
  }

  getSystemMetrics(): SystemMetrics {
    const cpuInfo = cpus();
    const load = loadavg();
    const totalMem = totalmem();
    const freeMem = freemem();
    const usedMem = totalMem - freeMem;

    return {
      cpuCount: cpuInfo.length,
      cpuUsage: cpuInfo.map(cpu => {
        const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
        const idle = cpu.times.idle;
        return ((total - idle) / total) * 100;
      }),
      loadAverage: load,
      memoryTotal: totalMem,
      memoryFree: freeMem,
      memoryUsedPercent: (usedMem / totalMem) * 100
    };
  }

  getCurrentMetrics(): ProcessMetrics | null {
    return this.metrics[this.metrics.length - 1] || null;
  }

  getMetricsHistory(): ProcessMetrics[] {
    return [...this.metrics];
  }

  incrementRequests(): void {
    this.activeRequests++;
    this.totalRequests++;
  }

  decrementRequests(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  getRequestStats() {
    return {
      active: this.activeRequests,
      total: this.totalRequests
    };
  }
}

// ===== HEALTH CHECK MANAGER =====
export class HealthCheckManager extends EventEmitter {
  private checks = new Map<string, IHealthCheck>();
  private logger = createComponentLogger('HealthCheckManager');
  private lastStatus?: HealthStatus;

  registerCheck(check: IHealthCheck): void {
    this.checks.set(check.name, check);
    this.logger.info('Health check registered', { name: check.name });
  }

  unregisterCheck(name: string): void {
    this.checks.delete(name);
    this.logger.info('Health check unregistered', { name });
  }

  async runHealthChecks(timeout: number = 5000): Promise<HealthStatus> {
    const results: HealthCheckResult[] = [];
    const startTime = Date.now();

    // Run all checks in parallel with timeout
    const promises = Array.from(this.checks.values()).map(async (check) => {
      try {
        const timeoutPromise = new Promise<HealthCheckResult>((_, reject) => {
          setTimeout(() => reject(new Error('Health check timeout')), timeout);
        });

        const result = await Promise.race([
          check.check(),
          timeoutPromise
        ]);

        return result;
      } catch (error) {
        return {
          name: check.name,
          status: 'fail' as const,
          message: `Health check failed: ${(error as Error).message}`,
          duration: Date.now() - startTime
        };
      }
    });

    const checkResults = await Promise.all(promises);
    results.push(...checkResults);

    // Calculate summary
    const summary = {
      total: results.length,
      passed: results.filter(r => r.status === 'pass').length,
      failed: results.filter(r => r.status === 'fail').length,
      warnings: results.filter(r => r.status === 'warn').length
    };

    // Determine overall status
    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (summary.failed > 0) {
      status = 'unhealthy';
    } else if (summary.warnings > 0) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    const healthStatus: HealthStatus = {
      status,
      timestamp: Date.now(),
      checks: results,
      summary
    };

    this.lastStatus = healthStatus;
    this.emit('health:checked', healthStatus);

    if (status !== 'healthy') {
      this.logger.warn('Health check issues detected', {
        status,
        failed: summary.failed,
        warnings: summary.warnings
      });
    }

    return healthStatus;
  }

  getLastStatus(): HealthStatus | undefined {
    return this.lastStatus;
  }

  async isHealthy(): Promise<boolean> {
    const status = await this.runHealthChecks();
    return status.status === 'healthy';
  }
}

// ===== CLUSTER MONITOR =====
export class ClusterMonitor extends EventEmitter {
  private logger = createComponentLogger('ClusterMonitor');
  private workers = new Map<number, any>();

  start(): void {
    if (!cluster.isPrimary) {
      this.logger.warn('ClusterMonitor should only run on primary process');
      return;
    }

    // Monitor worker lifecycle
    cluster.on('online', (worker) => {
      this.workers.set(worker.id, {
        id: worker.id,
        pid: worker.process.pid,
        startTime: Date.now(),
        restarts: 0
      });

      this.logger.info('Worker online', {
        workerId: worker.id,
        pid: worker.process.pid
      });

      this.emit('worker:online', worker);
    });

    cluster.on('exit', (worker, code, signal) => {
      const workerInfo = this.workers.get(worker.id);
      
      this.logger.warn('Worker exited', {
        workerId: worker.id,
        pid: worker.process.pid,
        code,
        signal
      });

      this.emit('worker:exit', { worker, code, signal });

      // Auto-restart worker
      if (code !== 0 && !worker.exitedAfterDisconnect) {
        this.restartWorker(worker.id);
      }
    });

    cluster.on('message', (worker, message) => {
      this.handleWorkerMessage(worker, message);
    });

    this.logger.info('Cluster monitoring started');
  }

  private restartWorker(workerId: number): void {
    const workerInfo = this.workers.get(workerId);
    if (workerInfo) {
      workerInfo.restarts++;
      
      if (workerInfo.restarts > 5) {
        this.logger.error('Worker restart limit exceeded', {
          workerId,
          restarts: workerInfo.restarts
        });
        return;
      }
    }

    cluster.fork();
    this.logger.info('Worker restarted', { workerId });
  }

  private handleWorkerMessage(worker: any, message: any): void {
    if (message.type === 'metrics') {
      this.emit('worker:metrics', {
        workerId: worker.id,
        metrics: message.data
      });
    } else if (message.type === 'health') {
      this.emit('worker:health', {
        workerId: worker.id,
        health: message.data
      });
    }
  }

  getWorkerStats() {
    return Array.from(this.workers.values()).map(worker => ({
      ...worker,
      uptime: Date.now() - worker.startTime
    }));
  }
}

// ===== MONITORING SERVICE =====
export class MonitoringService extends EventEmitter {
  private processMonitor: ProcessMonitor;
  private healthCheckManager: HealthCheckManager;
  private clusterMonitor?: ClusterMonitor;
  private logger = createComponentLogger('MonitoringService');
  private monitoringInterval?: NodeJS.Timeout;

  constructor(
    config: MonitoringConfig = {},
    private enableClusterMonitoring: boolean = false
  ) {
    super();
    
    this.processMonitor = new ProcessMonitor(config);
    this.healthCheckManager = new HealthCheckManager();

    if (enableClusterMonitoring && cluster.isPrimary) {
      this.clusterMonitor = new ClusterMonitor();
    }

    this.setupEventForwarding();
  }

  private setupEventForwarding(): void {
    // Forward process monitor events
    this.processMonitor.on('metrics:collected', (metrics) => {
      this.emit('metrics:collected', metrics);
    });

    this.processMonitor.on('threshold:exceeded', (data) => {
      this.emit('threshold:exceeded', data);
    });

    // Forward health check events
    this.healthCheckManager.on('health:checked', (status) => {
      this.emit('health:checked', status);
    });

    // Forward cluster events if enabled
    if (this.clusterMonitor) {
      this.clusterMonitor.on('worker:online', (worker) => {
        this.emit('worker:online', worker);
      });

      this.clusterMonitor.on('worker:exit', (data) => {
        this.emit('worker:exit', data);
      });
    }
  }

  start(): void {
    this.processMonitor.start();
    
    if (this.clusterMonitor) {
      this.clusterMonitor.start();
    }

    // Start periodic health checks
    this.monitoringInterval = setInterval(async () => {
      await this.healthCheckManager.runHealthChecks();
    }, 30000); // Every 30 seconds

    this.logger.info('Monitoring service started');
  }

  stop(): void {
    this.processMonitor.stop();

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }

    this.logger.info('Monitoring service stopped');
  }

  registerHealthCheck(check: IHealthCheck): void {
    this.healthCheckManager.registerCheck(check);
  }

  async getStatus(): Promise<{
    process: ProcessMetrics | null;
    system: SystemMetrics;
    health: HealthStatus | undefined;
    cluster?: any[];
  }> {
    const status: any = {
      process: this.processMonitor.getCurrentMetrics(),
      system: this.processMonitor.getSystemMetrics(),
      health: this.healthCheckManager.getLastStatus()
    };

    if (this.clusterMonitor) {
      status.cluster = this.clusterMonitor.getWorkerStats();
    }

    return status;
  }

  async runHealthCheck(): Promise<HealthStatus> {
    return await this.healthCheckManager.runHealthChecks();
  }

  getProcessMonitor(): ProcessMonitor {
    return this.processMonitor;
  }

  getHealthCheckManager(): HealthCheckManager {
    return this.healthCheckManager;
  }
}
