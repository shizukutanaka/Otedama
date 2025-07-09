/**
 * Process monitoring and health check system
 * Following principles: resilient, observable, maintainable
 */

import { EventEmitter } from 'events';
import * as os from 'os';
import { Logger } from '../logging/logger';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: Date;
  uptime: number;
  components: Map<string, ComponentHealth>;
  metrics: SystemMetrics;
}

export interface ComponentHealth {
  name: string;
  status: 'up' | 'down' | 'degraded';
  lastCheck: Date;
  message?: string;
  details?: any;
}

export interface SystemMetrics {
  cpu: {
    usage: number;
    loadAverage: number[];
  };
  memory: {
    total: number;
    used: number;
    free: number;
    percentage: number;
  };
  process: {
    pid: number;
    memory: number;
    cpu: number;
    handles: number;
  };
}

export interface MonitoringConfig {
  checkInterval: number;
  unhealthyThreshold: number;
  degradedThreshold: number;
  shutdownTimeout: number;
}

export class ProcessMonitor extends EventEmitter {
  private logger: Logger;
  private components = new Map<string, ComponentHealth>();
  private healthCheckTimer?: NodeJS.Timeout;
  private metricsTimer?: NodeJS.Timeout;
  private isShuttingDown = false;
  private startTime = Date.now();
  private lastCpuUsage = process.cpuUsage();
  private shutdownHandlers: Array<() => Promise<void>> = [];

  constructor(private config: MonitoringConfig) {
    super();
    this.logger = Logger.getInstance('ProcessMonitor');
    this.setupSignalHandlers();
  }

  start(): void {
    this.logger.info('Starting process monitor');
    
    // Start health checks
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.config.checkInterval);

    // Start metrics collection
    this.metricsTimer = setInterval(() => {
      this.collectMetrics();
    }, 10000); // Every 10 seconds

    // Initial check
    this.performHealthCheck();
  }

  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }

    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = undefined;
    }
  }

  // Component registration
  registerComponent(name: string, healthCheck: () => Promise<boolean>): void {
    this.components.set(name, {
      name,
      status: 'down',
      lastCheck: new Date()
    });

    // Store health check function
    this.componentHealthChecks.set(name, healthCheck);
  }

  private componentHealthChecks = new Map<string, () => Promise<boolean>>();

  // Health check
  private async performHealthCheck(): Promise<void> {
    const healthStatus = await this.getHealthStatus();
    
    this.emit('healthCheck', healthStatus);

    if (healthStatus.status === 'unhealthy') {
      this.logger.error('System unhealthy', { 
        components: Array.from(healthStatus.components.values())
          .filter(c => c.status !== 'up')
      });
    } else if (healthStatus.status === 'degraded') {
      this.logger.warn('System degraded', {
        components: Array.from(healthStatus.components.values())
          .filter(c => c.status === 'degraded')
      });
    }
  }

  async getHealthStatus(): Promise<HealthStatus> {
    // Check all components
    for (const [name, check] of this.componentHealthChecks) {
      try {
        const isHealthy = await check();
        const component = this.components.get(name)!;
        component.status = isHealthy ? 'up' : 'down';
        component.lastCheck = new Date();
        component.message = isHealthy ? 'OK' : 'Check failed';
      } catch (error) {
        const component = this.components.get(name)!;
        component.status = 'down';
        component.lastCheck = new Date();
        component.message = error instanceof Error ? error.message : 'Unknown error';
      }
    }

    // Determine overall status
    const componentStatuses = Array.from(this.components.values());
    const downCount = componentStatuses.filter(c => c.status === 'down').length;
    const degradedCount = componentStatuses.filter(c => c.status === 'degraded').length;

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (downCount >= this.config.unhealthyThreshold) {
      status = 'unhealthy';
    } else if (downCount > 0 || degradedCount >= this.config.degradedThreshold) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    return {
      status,
      timestamp: new Date(),
      uptime: Date.now() - this.startTime,
      components: new Map(this.components),
      metrics: this.collectSystemMetrics()
    };
  }

  // Metrics collection
  private collectSystemMetrics(): SystemMetrics {
    const cpuUsage = process.cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = process.cpuUsage();

    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    return {
      cpu: {
        usage: (cpuUsage.user + cpuUsage.system) / 1000000, // Convert to seconds
        loadAverage: os.loadavg()
      },
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        percentage: (usedMem / totalMem) * 100
      },
      process: {
        pid: process.pid,
        memory: memUsage.heapUsed + memUsage.external,
        cpu: (cpuUsage.user + cpuUsage.system) / 1000, // milliseconds
        handles: (process as any)._getActiveHandles?.()?.length || 0
      }
    };
  }

  private collectMetrics(): void {
    const metrics = this.collectSystemMetrics();
    
    this.emit('metrics', metrics);

    // Check for high resource usage
    if (metrics.memory.percentage > 90) {
      this.logger.warn('High memory usage', { percentage: metrics.memory.percentage });
    }

    if (metrics.cpu.loadAverage[0] > os.cpus().length * 2) {
      this.logger.warn('High CPU load', { loadAverage: metrics.cpu.loadAverage });
    }
  }

  // Graceful shutdown
  registerShutdownHandler(handler: () => Promise<void>): void {
    this.shutdownHandlers.push(handler);
  }

  private async gracefulShutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn('Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    this.logger.info(`Received ${signal}, starting graceful shutdown`);

    // Set shutdown timeout
    const shutdownTimer = setTimeout(() => {
      this.logger.error('Shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, this.config.shutdownTimeout);

    try {
      // Stop health checks
      this.stop();

      // Run shutdown handlers in reverse order
      for (const handler of this.shutdownHandlers.reverse()) {
        try {
          await handler();
        } catch (error) {
          this.logger.error('Shutdown handler error', error);
        }
      }

      // Clear timeout
      clearTimeout(shutdownTimer);

      this.logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      this.logger.error('Error during shutdown', error);
      process.exit(1);
    }
  }

  private setupSignalHandlers(): void {
    // Handle termination signals
    const signals = ['SIGTERM', 'SIGINT', 'SIGUSR2'];
    
    signals.forEach(signal => {
      process.on(signal as any, () => {
        this.gracefulShutdown(signal).catch(error => {
          this.logger.error('Failed to shutdown gracefully', error);
          process.exit(1);
        });
      });
    });

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception', error);
      this.gracefulShutdown('uncaughtException').catch(() => {
        process.exit(1);
      });
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled rejection', reason as Error, { promise });
      this.gracefulShutdown('unhandledRejection').catch(() => {
        process.exit(1);
      });
    });
  }

  // Express middleware for health endpoint
  healthCheckMiddleware() {
    return async (req: any, res: any) => {
      const health = await this.getHealthStatus();
      
      const statusCode = health.status === 'healthy' ? 200 :
                        health.status === 'degraded' ? 503 : 500;
      
      res.status(statusCode).json({
        status: health.status,
        timestamp: health.timestamp,
        uptime: Math.floor(health.uptime / 1000), // seconds
        components: Object.fromEntries(health.components),
        metrics: health.metrics
      });
    };
  }

  // Prometheus metrics endpoint
  metricsEndpoint() {
    return (req: any, res: any) => {
      const metrics = this.collectSystemMetrics();
      const health = this.getHealthStatus();

      // Format as Prometheus metrics
      const lines = [
        '# HELP pool_uptime_seconds Pool uptime in seconds',
        '# TYPE pool_uptime_seconds gauge',
        `pool_uptime_seconds ${Math.floor((Date.now() - this.startTime) / 1000)}`,
        '',
        '# HELP pool_cpu_usage_seconds CPU usage in seconds',
        '# TYPE pool_cpu_usage_seconds counter',
        `pool_cpu_usage_seconds ${metrics.cpu.usage}`,
        '',
        '# HELP pool_memory_usage_bytes Memory usage in bytes',
        '# TYPE pool_memory_usage_bytes gauge',
        `pool_memory_usage_bytes ${metrics.process.memory}`,
        '',
        '# HELP pool_memory_percentage Memory usage percentage',
        '# TYPE pool_memory_percentage gauge',
        `pool_memory_percentage ${metrics.memory.percentage}`,
        '',
        '# HELP pool_load_average System load average',
        '# TYPE pool_load_average gauge',
        `pool_load_average{period="1m"} ${metrics.cpu.loadAverage[0]}`,
        `pool_load_average{period="5m"} ${metrics.cpu.loadAverage[1]}`,
        `pool_load_average{period="15m"} ${metrics.cpu.loadAverage[2]}`,
        ''
      ];

      res.set('Content-Type', 'text/plain; version=0.0.4');
      res.send(lines.join('\n'));
    };
  }
}

// Resource monitor for detecting leaks
export class ResourceMonitor {
  private samples: SystemMetrics[] = [];
  private readonly maxSamples = 60; // 10 minutes of data
  private logger: Logger;

  constructor() {
    this.logger = Logger.getInstance('ResourceMonitor');
  }

  addSample(metrics: SystemMetrics): void {
    this.samples.push(metrics);
    
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }

    this.detectAnomalies();
  }

  private detectAnomalies(): void {
    if (this.samples.length < 10) return;

    // Check for memory leaks
    const memoryTrend = this.calculateTrend(
      this.samples.map(s => s.process.memory)
    );

    if (memoryTrend > 0.1) { // 10% increase per sample
      this.logger.warn('Possible memory leak detected', {
        trend: memoryTrend,
        current: this.samples[this.samples.length - 1].process.memory
      });
    }

    // Check for handle leaks
    const handleTrend = this.calculateTrend(
      this.samples.map(s => s.process.handles)
    );

    if (handleTrend > 0.05) { // 5% increase per sample
      this.logger.warn('Possible handle leak detected', {
        trend: handleTrend,
        current: this.samples[this.samples.length - 1].process.handles
      });
    }
  }

  private calculateTrend(values: number[]): number {
    if (values.length < 2) return 0;

    let sum = 0;
    for (let i = 1; i < values.length; i++) {
      const change = (values[i] - values[i - 1]) / values[i - 1];
      sum += change;
    }

    return sum / (values.length - 1);
  }
}
