// Health check system (Carmack-style simplicity)
import * as http from 'http';
import { createComponentLogger } from '../logging/logger';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  components: {
    [name: string]: {
      status: 'up' | 'down' | 'degraded';
      message?: string;
      metrics?: Record<string, any>;
    };
  };
}

export type HealthChecker = () => Promise<{
  status: 'up' | 'down' | 'degraded';
  message?: string;
  metrics?: Record<string, any>;
}>;

export class HealthCheckService {
  private logger = createComponentLogger('HealthCheck');
  private server: http.Server | null = null;
  private checkers = new Map<string, HealthChecker>();
  private startTime = Date.now();
  private lastCheck: HealthStatus | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  
  constructor(
    private port: number = 3000,
    private path: string = '/health'
  ) {}
  
  // Register a health checker for a component
  register(name: string, checker: HealthChecker): void {
    this.checkers.set(name, checker);
    this.logger.debug(`Registered health checker: ${name}`);
  }
  
  // Unregister a health checker
  unregister(name: string): void {
    this.checkers.delete(name);
  }
  
  // Perform health check
  async check(): Promise<HealthStatus> {
    const components: HealthStatus['components'] = {};
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    // Check each component
    for (const [name, checker] of this.checkers) {
      try {
        const result = await checker();
        components[name] = result;
        
        // Update overall status
        if (result.status === 'down') {
          overallStatus = 'unhealthy';
        } else if (result.status === 'degraded' && overallStatus === 'healthy') {
          overallStatus = 'degraded';
        }
      } catch (error) {
        // If checker throws, component is down
        components[name] = {
          status: 'down',
          message: error instanceof Error ? error.message : 'Check failed'
        };
        overallStatus = 'unhealthy';
      }
    }
    
    const status: HealthStatus = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Date.now() - this.startTime,
      components
    };
    
    this.lastCheck = status;
    return status;
  }
  
  // Start health check server
  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Health check server already running');
    }
    
    // Start periodic checks
    this.checkInterval = setInterval(async () => {
      try {
        await this.check();
      } catch (error) {
        this.logger.error('Health check failed', error as Error);
      }
    }, 30000); // Check every 30 seconds
    
    // Create HTTP server
    this.server = http.createServer(async (req, res) => {
      if (req.url === this.path && req.method === 'GET') {
        try {
          const status = await this.check();
          
          res.writeHead(status.status === 'healthy' ? 200 : 503, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache'
          });
          
          res.end(JSON.stringify(status, null, 2));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'error',
            message: 'Health check failed',
            error: error instanceof Error ? error.message : 'Unknown error'
          }));
        }
      } else if (req.url === `${this.path}/live` && req.method === 'GET') {
        // Simple liveness check
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
      } else if (req.url === `${this.path}/ready` && req.method === 'GET') {
        // Readiness check - use last check result
        const ready = this.lastCheck && this.lastCheck.status !== 'unhealthy';
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain' });
        res.end(ready ? 'Ready' : 'Not Ready');
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });
    
    // Start listening
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, () => {
        this.logger.info(`Health check server listening on port ${this.port}`);
        resolve();
      });
      
      this.server!.on('error', reject);
    });
    
    // Initial check
    await this.check();
  }
  
  // Stop health check server
  async stop(): Promise<void> {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          this.logger.info('Health check server stopped');
          resolve();
        });
      });
      
      this.server = null;
    }
  }
  
  // Get current status without performing check
  getStatus(): HealthStatus | null {
    return this.lastCheck;
  }
}

// Standard health checkers
export const createDatabaseHealthChecker = (db: any): HealthChecker => {
  return async () => {
    try {
      // Perform simple query
      const stats = await db.getPoolStats();
      
      return {
        status: 'up',
        metrics: {
          totalMiners: stats.totalMiners,
          activeMiners: stats.activeMiners,
          totalShares: stats.totalShares
        }
      };
    } catch (error) {
      return {
        status: 'down',
        message: 'Database query failed'
      };
    }
  };
};

export const createStratumHealthChecker = (stratum: any): HealthChecker => {
  return async () => {
    try {
      const stats = stratum.getStats();
      const connectedMiners = stats.connectedMiners || 0;
      
      // Consider degraded if no miners connected
      const status = connectedMiners > 0 ? 'up' : 'degraded';
      
      return {
        status,
        message: connectedMiners === 0 ? 'No miners connected' : undefined,
        metrics: {
          connectedMiners,
          totalConnections: stats.totalConnections || 0
        }
      };
    } catch (error) {
      return {
        status: 'down',
        message: 'Stratum server not responding'
      };
    }
  };
};

export const createBlockchainHealthChecker = (blockchain: any): HealthChecker => {
  return async () => {
    try {
      const info = await blockchain.getInfo();
      
      // Check if synced
      const progress = info.verificationprogress || 1;
      const synced = progress > 0.999;
      
      return {
        status: synced ? 'up' : 'degraded',
        message: synced ? undefined : 'Blockchain syncing',
        metrics: {
          blocks: info.blocks,
          connections: info.connections,
          syncProgress: progress
        }
      };
    } catch (error) {
      return {
        status: 'down',
        message: 'Cannot connect to Bitcoin node'
      };
    }
  };
};

export const createMemoryHealthChecker = (thresholdMB: number = 1024): HealthChecker => {
  return async () => {
    const usage = process.memoryUsage();
    const heapUsedMB = usage.heapUsed / 1024 / 1024;
    const rssMB = usage.rss / 1024 / 1024;
    
    // Warn if heap usage is high
    const status = heapUsedMB > thresholdMB ? 'degraded' : 'up';
    
    return {
      status,
      message: status === 'degraded' ? `High memory usage: ${heapUsedMB.toFixed(0)}MB` : undefined,
      metrics: {
        heapUsedMB: Math.round(heapUsedMB),
        heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
        rssMB: Math.round(rssMB),
        externalMB: Math.round(usage.external / 1024 / 1024)
      }
    };
  };
};

export const createDiskHealthChecker = (dataDir: string, minFreeMB: number = 100): HealthChecker => {
  return async () => {
    try {
      const os = await import('os');
      const { statfs } = await import('fs/promises');
      
      // Get disk stats for data directory
      const stats = await statfs(dataDir);
      const freeSpaceMB = (stats.bavail * stats.bsize) / 1024 / 1024;
      
      const status = freeSpaceMB < minFreeMB ? 'degraded' : 'up';
      
      return {
        status,
        message: status === 'degraded' ? `Low disk space: ${freeSpaceMB.toFixed(0)}MB free` : undefined,
        metrics: {
          freeSpaceMB: Math.round(freeSpaceMB),
          totalSpaceMB: Math.round((stats.blocks * stats.bsize) / 1024 / 1024),
          usedPercent: Math.round(((stats.blocks - stats.bavail) / stats.blocks) * 100)
        }
      };
    } catch (error) {
      // Fallback for systems without statfs
      return {
        status: 'up',
        message: 'Disk stats not available'
      };
    }
  };
};

// Process health checker
export const createProcessHealthChecker = (): HealthChecker => {
  return async () => {
    const uptime = process.uptime();
    const cpuUsage = process.cpuUsage();
    
    return {
      status: 'up',
      metrics: {
        uptimeSeconds: Math.round(uptime),
        cpuUserMs: cpuUsage.user / 1000,
        cpuSystemMs: cpuUsage.system / 1000,
        pid: process.pid,
        nodeVersion: process.version
      }
    };
  };
};

// Create composite health checker
export function createCompositeHealthChecker(checkers: Record<string, HealthChecker>): HealthChecker {
  return async () => {
    const results = await Promise.all(
      Object.entries(checkers).map(async ([name, checker]) => {
        try {
          const result = await checker();
          return { name, ...result };
        } catch (error) {
          return {
            name,
            status: 'down' as const,
            message: error instanceof Error ? error.message : 'Check failed'
          };
        }
      })
    );
    
    // Determine overall status
    const hasDown = results.some(r => r.status === 'down');
    const hasDegraded = results.some(r => r.status === 'degraded');
    
    const status = hasDown ? 'down' : hasDegraded ? 'degraded' : 'up';
    
    // Combine metrics
    const metrics: Record<string, any> = {};
    for (const result of results) {
      if (result.metrics) {
        metrics[result.name] = result.metrics;
      }
    }
    
    return {
      status,
      metrics,
      message: hasDown ? 'Some components are down' : hasDegraded ? 'Some components are degraded' : undefined
    };
  };
}
