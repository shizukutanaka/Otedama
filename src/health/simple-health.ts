/**
 * Simple Health Check - Essential System Monitoring
 * Design: Rob Pike (Simple) + John Carmack (Fast)
 */

import * as http from 'http';
import * as os from 'os';
import { createComponentLogger } from '../logging/simple-logger';

interface HealthStatus {
  healthy: boolean;
  timestamp: number;
  uptime: number;
  checks: Record<string, CheckResult>;
  system: SystemInfo;
}

interface CheckResult {
  healthy: boolean;
  message?: string;
  duration: number;
  timestamp: number;
}

interface SystemInfo {
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  cpu: {
    loadAverage: number[];
    cores: number;
  };
  process: {
    pid: number;
    uptime: number;
    memoryUsage: NodeJS.MemoryUsage;
  };
}

type HealthChecker = () => Promise<CheckResult> | CheckResult;

class SimpleHealthCheck {
  private server: http.Server;
  private checkers: Map<string, HealthChecker> = new Map();
  private lastStatus: HealthStatus | null = null;
  private startTime: number = Date.now();
  private logger = createComponentLogger('HealthCheck');
  
  constructor(
    private port: number = 3001,
    private endpoint: string = '/health'
  ) {
    this.server = http.createServer(this.handleRequest.bind(this));
    this.registerDefaultCheckers();
  }
  
  private registerDefaultCheckers(): void {
    // Memory check
    this.register('memory', () => {
      const memInfo = this.getMemoryInfo();
      const healthy = memInfo.percentage < 90; // Alert if over 90%
      
      return {
        healthy,
        message: healthy ? 'Memory usage normal' : 'High memory usage',
        duration: 0,
        timestamp: Date.now()
      };
    });
    
    // Process health check
    this.register('process', () => {
      const memUsage = process.memoryUsage();
      const heapUsedPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
      const healthy = heapUsedPercent < 85;
      
      return {
        healthy,
        message: healthy ? 'Process healthy' : 'High heap usage',
        duration: 0,
        timestamp: Date.now()
      };
    });
    
    // CPU check
    this.register('cpu', () => {
      const loadAvg = os.loadavg();
      const cores = os.cpus().length;
      const load1min = loadAvg[0];
      const healthy = load1min < cores * 0.8; // Alert if load > 80% of cores
      
      return {
        healthy,
        message: healthy ? 'CPU load normal' : 'High CPU load',
        duration: 0,
        timestamp: Date.now()
      };
    });
  }
  
  // Register custom health checker
  register(name: string, checker: HealthChecker): void {
    this.checkers.set(name, checker);
    this.logger.debug('Health checker registered', { name });
  }
  
  // Remove health checker
  unregister(name: string): boolean {
    const removed = this.checkers.delete(name);
    if (removed) {
      this.logger.debug('Health checker unregistered', { name });
    }
    return removed;
  }
  
  // Perform all health checks
  async performChecks(): Promise<HealthStatus> {
    const timestamp = Date.now();
    const checks: Record<string, CheckResult> = {};
    let allHealthy = true;
    
    // Run all registered checks
    for (const [name, checker] of this.checkers.entries()) {
      try {
        const start = process.hrtime.bigint();
        const result = await checker();
        const end = process.hrtime.bigint();
        
        result.duration = Number(end - start) / 1e6; // Convert to milliseconds
        result.timestamp = timestamp;
        
        checks[name] = result;
        
        if (!result.healthy) {
          allHealthy = false;
        }
        
      } catch (error) {
        this.logger.error('Health check failed', error as Error, { checker: name });
        
        checks[name] = {
          healthy: false,
          message: `Check failed: ${(error as Error).message}`,
          duration: 0,
          timestamp
        };
        
        allHealthy = false;
      }
    }
    
    const status: HealthStatus = {
      healthy: allHealthy,
      timestamp,
      uptime: timestamp - this.startTime,
      checks,
      system: this.getSystemInfo()
    };
    
    this.lastStatus = status;
    return status;
  }
  
  private getSystemInfo(): SystemInfo {
    const memInfo = this.getMemoryInfo();
    const memUsage = process.memoryUsage();
    
    return {
      memory: memInfo,
      cpu: {
        loadAverage: os.loadavg(),
        cores: os.cpus().length
      },
      process: {
        pid: process.pid,
        uptime: process.uptime(),
        memoryUsage: memUsage
      }
    };
  }
  
  private getMemoryInfo() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    return {
      used: usedMem,
      total: totalMem,
      percentage: (usedMem / totalMem) * 100
    };
  }
  
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    if (req.url === this.endpoint || req.url === this.endpoint + '/') {
      await this.handleHealthCheck(req, res);
    } else if (req.url === this.endpoint + '/ready') {
      await this.handleReadinessCheck(req, res);
    } else if (req.url === this.endpoint + '/live') {
      await this.handleLivenessCheck(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }
  
  private async handleHealthCheck(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const status = await this.performChecks();
      const statusCode = status.healthy ? 200 : 503;
      
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));
      
    } catch (error) {
      this.logger.error('Health check endpoint error', error as Error);
      
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        healthy: false,
        error: 'Health check failed',
        timestamp: Date.now()
      }));
    }
  }
  
  private async handleReadinessCheck(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Readiness check - can the service handle requests?
    const ready = this.lastStatus ? this.lastStatus.healthy : false;
    const statusCode = ready ? 200 : 503;
    
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ready,
      timestamp: Date.now()
    }));
  }
  
  private async handleLivenessCheck(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Liveness check - is the service alive?
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      alive: true,
      timestamp: Date.now(),
      uptime: Date.now() - this.startTime
    }));
  }
  
  // Start health check server
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, (error?: Error) => {
        if (error) {
          reject(error);
        } else {
          this.logger.info('Health check server started', { 
            port: this.port, 
            endpoint: this.endpoint 
          });
          resolve();
        }
      });
    });
  }
  
  // Stop health check server
  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        this.logger.info('Health check server stopped');
        resolve();
      });
    });
  }
  
  // Get last status without running checks
  getLastStatus(): HealthStatus | null {
    return this.lastStatus;
  }
  
  // Quick health check (synchronous)
  quickCheck(): boolean {
    if (!this.lastStatus) return false;
    
    // Check if status is recent (within last 60 seconds)
    const age = Date.now() - this.lastStatus.timestamp;
    return this.lastStatus.healthy && age < 60000;
  }
  
  // Get specific check result
  getCheckResult(name: string): CheckResult | null {
    return this.lastStatus?.checks[name] || null;
  }
  
  // List registered checkers
  listCheckers(): string[] {
    return Array.from(this.checkers.keys());
  }
}

// Factory functions for common checkers
export function createDatabaseChecker(db: any): HealthChecker {
  return async () => {
    const start = Date.now();
    
    try {
      // Try a simple query
      await db.getPoolStats();
      
      return {
        healthy: true,
        message: 'Database connection healthy',
        duration: Date.now() - start,
        timestamp: Date.now()
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Database error: ${(error as Error).message}`,
        duration: Date.now() - start,
        timestamp: Date.now()
      };
    }
  };
}

export function createNetworkChecker(host: string, port: number): HealthChecker {
  return async () => {
    const start = Date.now();
    
    return new Promise<CheckResult>((resolve) => {
      const net = require('net');
      const socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({
          healthy: false,
          message: `Network timeout: ${host}:${port}`,
          duration: Date.now() - start,
          timestamp: Date.now()
        });
      }, 5000);
      
      socket.connect(port, host, () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({
          healthy: true,
          message: `Network connection healthy: ${host}:${port}`,
          duration: Date.now() - start,
          timestamp: Date.now()
        });
      });
      
      socket.on('error', (error) => {
        clearTimeout(timeout);
        resolve({
          healthy: false,
          message: `Network error: ${error.message}`,
          duration: Date.now() - start,
          timestamp: Date.now()
        });
      });
    });
  };
}

export { SimpleHealthCheck, HealthStatus, CheckResult, SystemInfo, HealthChecker };
