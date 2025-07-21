/**
 * Health Check System for Otedama
 * Monitors system health and provides status endpoints
 * Following John Carmack's performance principles
 */

import { EventEmitter } from 'events';
import { cpus, freemem, totalmem, loadavg } from 'os';
import { performance } from 'perf_hooks';
import { existsSync, statSync } from 'fs';

// Health status constants
export const HealthStatus = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy'
};

// Check status
export const CheckStatus = {
  PASS: 'pass',
  WARN: 'warn',
  FAIL: 'fail'
};

export class HealthCheck extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      timeout: options.timeout || 5000,
      interval: options.interval || 30000,
      thresholds: {
        cpuUsage: options.cpuUsageThreshold || 80,
        memoryUsage: options.memoryUsageThreshold || 85,
        diskUsage: options.diskUsageThreshold || 90,
        responseTime: options.responseTimeThreshold || 1000,
        errorRate: options.errorRateThreshold || 5
      },
      ...options
    };
    
    this.checks = new Map();
    this.results = new Map();
    this.lastCheck = null;
    this.isChecking = false;
    
    // Register default checks
    this.registerDefaultChecks();
  }

  /**
   * Register default health checks
   */
  registerDefaultChecks() {
    // System checks
    this.registerCheck('system', async () => this.checkSystem());
    this.registerCheck('memory', async () => this.checkMemory());
    this.registerCheck('disk', async () => this.checkDisk());
    this.registerCheck('process', async () => this.checkProcess());
  }

  /**
   * Register a health check
   */
  registerCheck(name, checkFunction, options = {}) {
    this.checks.set(name, {
      name,
      check: checkFunction,
      timeout: options.timeout || this.options.timeout,
      critical: options.critical || false,
      enabled: options.enabled !== false
    });
  }

  /**
   * Register component-specific checks
   */
  registerComponentChecks(components) {
    if (components.database) {
      this.registerCheck('database', async () => this.checkDatabase(components.database), { critical: true });
    }
    
    if (components.cache) {
      this.registerCheck('cache', async () => this.checkCache(components.cache));
    }
    
    if (components.p2p) {
      this.registerCheck('p2p', async () => this.checkP2P(components.p2p));
    }
    
    if (components.websocket) {
      this.registerCheck('websocket', async () => this.checkWebSocket(components.websocket));
    }
    
    if (components.mining) {
      this.registerCheck('mining', async () => this.checkMining(components.mining));
    }
    
    if (components.dex) {
      this.registerCheck('dex', async () => this.checkDEX(components.dex));
    }
  }

  /**
   * Perform all health checks
   */
  async checkHealth() {
    if (this.isChecking) {
      return this.getLastResults();
    }
    
    this.isChecking = true;
    const startTime = performance.now();
    const results = {};
    let overallStatus = HealthStatus.HEALTHY;
    
    try {
      // Run all checks in parallel
      const checkPromises = [];
      
      for (const [name, check] of this.checks) {
        if (!check.enabled) continue;
        
        checkPromises.push(
          this.runCheck(name, check)
            .then(result => {
              results[name] = result;
              
              // Update overall status
              if (result.status === CheckStatus.FAIL) {
                overallStatus = HealthStatus.UNHEALTHY;
              } else if (result.status === CheckStatus.WARN && overallStatus === HealthStatus.HEALTHY) {
                overallStatus = HealthStatus.DEGRADED;
              }
            })
            .catch(error => {
              results[name] = {
                status: CheckStatus.FAIL,
                message: error.message,
                error: true
              };
              
              if (check.critical) {
                overallStatus = HealthStatus.UNHEALTHY;
              }
            })
        );
      }
      
      await Promise.all(checkPromises);
      
      // Calculate duration
      const duration = performance.now() - startTime;
      
      // Build response
      const response = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        uptime: process.uptime(),
        checks: results,
        duration: Math.round(duration)
      };
      
      // Store results
      this.lastCheck = Date.now();
      this.results = new Map(Object.entries(results));
      
      // Emit status
      this.emit('health-check', response);
      
      return response;
      
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Run individual check with timeout
   */
  async runCheck(name, check) {
    const startTime = performance.now();
    
    try {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Check timed out')), check.timeout);
      });
      
      const result = await Promise.race([
        check.check(),
        timeoutPromise
      ]);
      
      // Add latency
      result.latency = Math.round(performance.now() - startTime);
      
      return result;
    } catch (error) {
      return {
        status: CheckStatus.FAIL,
        message: error.message,
        latency: Math.round(performance.now() - startTime),
        error: true
      };
    }
  }

  /**
   * System health check
   */
  async checkSystem() {
    const load = loadavg();
    const cpuCount = cpus().length;
    const loadPercent = (load[0] / cpuCount) * 100;
    
    if (loadPercent > this.options.thresholds.cpuUsage) {
      return {
        status: CheckStatus.WARN,
        message: `High CPU load: ${loadPercent.toFixed(1)}%`,
        details: {
          load: load[0],
          cpus: cpuCount,
          percentage: loadPercent
        }
      };
    }
    
    return {
      status: CheckStatus.PASS,
      message: 'System load normal',
      details: {
        load: load[0],
        cpus: cpuCount,
        percentage: loadPercent
      }
    };
  }

  /**
   * Memory health check
   */
  async checkMemory() {
    const free = freemem();
    const total = totalmem();
    const used = total - free;
    const usagePercent = (used / total) * 100;
    
    if (usagePercent > this.options.thresholds.memoryUsage) {
      return {
        status: CheckStatus.WARN,
        message: `High memory usage: ${usagePercent.toFixed(1)}%`,
        details: {
          total: Math.round(total / 1024 / 1024),
          used: Math.round(used / 1024 / 1024),
          free: Math.round(free / 1024 / 1024),
          percentage: usagePercent
        }
      };
    }
    
    return {
      status: CheckStatus.PASS,
      message: 'Memory usage normal',
      details: {
        total: Math.round(total / 1024 / 1024),
        used: Math.round(used / 1024 / 1024),
        free: Math.round(free / 1024 / 1024),
        percentage: usagePercent
      }
    };
  }

  /**
   * Disk health check
   */
  async checkDisk() {
    try {
      const dbPath = process.env.DB_PATH || './otedama.db';
      
      if (!existsSync(dbPath)) {
        return {
          status: CheckStatus.WARN,
          message: 'Database file not found',
          details: { path: dbPath }
        };
      }
      
      const stats = statSync(dbPath);
      const sizeMB = stats.size / 1024 / 1024;
      
      return {
        status: CheckStatus.PASS,
        message: 'Disk access normal',
        details: {
          dbSize: sizeMB.toFixed(2) + ' MB',
          lastModified: stats.mtime
        }
      };
    } catch (error) {
      return {
        status: CheckStatus.FAIL,
        message: 'Disk check failed',
        error: error.message
      };
    }
  }

  /**
   * Process health check
   */
  async checkProcess() {
    const memUsage = process.memoryUsage();
    const heapPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    
    return {
      status: CheckStatus.PASS,
      message: 'Process healthy',
      details: {
        pid: process.pid,
        uptime: process.uptime(),
        memory: {
          rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
          heap: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
          heapPercent: heapPercent.toFixed(1) + '%'
        }
      }
    };
  }

  /**
   * Database health check
   */
  async checkDatabase(db) {
    try {
      const start = performance.now();
      
      // Simple query to check connection
      const result = await db.read('SELECT 1 as health');
      const latency = performance.now() - start;
      
      if (latency > this.options.thresholds.responseTime) {
        return {
          status: CheckStatus.WARN,
          message: `Database slow: ${latency.toFixed(0)}ms`,
          details: { latency }
        };
      }
      
      return {
        status: CheckStatus.PASS,
        message: 'Database connection healthy',
        details: { 
          latency: Math.round(latency),
          connections: db.getPoolStats ? db.getPoolStats() : undefined
        }
      };
    } catch (error) {
      return {
        status: CheckStatus.FAIL,
        message: 'Database connection failed',
        error: error.message
      };
    }
  }

  /**
   * Cache health check
   */
  async checkCache(cache) {
    try {
      const stats = cache.getStats ? await cache.getStats() : {};
      
      return {
        status: CheckStatus.PASS,
        message: 'Cache operational',
        details: stats
      };
    } catch (error) {
      return {
        status: CheckStatus.WARN,
        message: 'Cache check failed',
        error: error.message
      };
    }
  }

  /**
   * P2P network health check
   */
  async checkP2P(p2p) {
    try {
      const peerCount = p2p.getPeerCount ? p2p.getPeerCount() : 0;
      
      if (peerCount === 0) {
        return {
          status: CheckStatus.WARN,
          message: 'No P2P peers connected',
          details: { peers: 0 }
        };
      }
      
      return {
        status: CheckStatus.PASS,
        message: 'P2P network healthy',
        details: { 
          peers: peerCount,
          networkId: p2p.networkId
        }
      };
    } catch (error) {
      return {
        status: CheckStatus.FAIL,
        message: 'P2P check failed',
        error: error.message
      };
    }
  }

  /**
   * WebSocket health check
   */
  async checkWebSocket(ws) {
    try {
      const connections = ws.getConnectionCount ? ws.getConnectionCount() : 0;
      
      return {
        status: CheckStatus.PASS,
        message: 'WebSocket server healthy',
        details: { connections }
      };
    } catch (error) {
      return {
        status: CheckStatus.WARN,
        message: 'WebSocket check failed',
        error: error.message
      };
    }
  }

  /**
   * Mining pool health check
   */
  async checkMining(mining) {
    try {
      const stats = mining.getStats ? await mining.getStats() : {};
      
      return {
        status: CheckStatus.PASS,
        message: 'Mining pool operational',
        details: stats
      };
    } catch (error) {
      return {
        status: CheckStatus.WARN,
        message: 'Mining check failed',
        error: error.message
      };
    }
  }

  /**
   * DEX health check
   */
  async checkDEX(dex) {
    try {
      const stats = dex.getStats ? await dex.getStats() : {};
      
      return {
        status: CheckStatus.PASS,
        message: 'DEX operational',
        details: stats
      };
    } catch (error) {
      return {
        status: CheckStatus.WARN,
        message: 'DEX check failed',
        error: error.message
      };
    }
  }

  /**
   * Get last results
   */
  getLastResults() {
    if (!this.lastCheck) {
      return {
        status: HealthStatus.UNKNOWN,
        message: 'No health check performed yet'
      };
    }
    
    const results = {};
    for (const [name, result] of this.results) {
      results[name] = result;
    }
    
    return {
      status: this.determineOverallStatus(results),
      timestamp: new Date(this.lastCheck).toISOString(),
      checks: results
    };
  }

  /**
   * Determine overall status from check results
   */
  determineOverallStatus(results) {
    let hasFailure = false;
    let hasWarning = false;
    
    for (const result of Object.values(results)) {
      if (result.status === CheckStatus.FAIL) {
        hasFailure = true;
      } else if (result.status === CheckStatus.WARN) {
        hasWarning = true;
      }
    }
    
    if (hasFailure) return HealthStatus.UNHEALTHY;
    if (hasWarning) return HealthStatus.DEGRADED;
    return HealthStatus.HEALTHY;
  }

  /**
   * Start periodic health checks
   */
  startPeriodicChecks() {
    if (this.checkInterval) {
      return;
    }
    
    this.checkInterval = setInterval(async () => {
      try {
        await this.checkHealth();
      } catch (error) {
        this.emit('error', error);
      }
    }, this.options.interval);
    
    // Run initial check
    this.checkHealth().catch(error => this.emit('error', error));
  }

  /**
   * Stop periodic health checks
   */
  stopPeriodicChecks() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}

// Export singleton instance
export const healthCheck = new HealthCheck();

export default HealthCheck;