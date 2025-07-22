/**
 * Enhanced Health Check System for Otedama
 * Comprehensive monitoring with detailed diagnostics
 * 
 * Design principles:
 * - Carmack: Fast checks, minimal overhead
 * - Martin: Clear separation of concerns
 * - Pike: Simple and reliable
 */

import { EventEmitter } from 'events';
import { cpus, freemem, totalmem, loadavg, uptime, networkInterfaces } from 'os';
import { performance } from 'perf_hooks';
import { promises as fs } from 'fs';
import { getLogger } from '../core/logger.js';

const logger = getLogger('HealthCheck');

export const HealthStatus = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  UNKNOWN: 'unknown'
};

export const CheckStatus = {
  PASS: 'pass',
  WARN: 'warn',
  FAIL: 'fail',
  SKIP: 'skip'
};

export class EnhancedHealthCheck extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      timeout: options.timeout || 5000,
      interval: options.interval || 30000,
      detailedMetrics: options.detailedMetrics !== false,
      
      thresholds: {
        cpu: {
          warning: options.cpuWarning || 70,
          critical: options.cpuCritical || 90
        },
        memory: {
          warning: options.memoryWarning || 75,
          critical: options.memoryCritical || 90
        },
        disk: {
          warning: options.diskWarning || 80,
          critical: options.diskCritical || 95
        },
        responseTime: {
          warning: options.responseTimeWarning || 500,
          critical: options.responseTimeCritical || 2000
        },
        errorRate: {
          warning: options.errorRateWarning || 1,
          critical: options.errorRateCritical || 5
        },
        connections: {
          warning: options.connectionsWarning || 8000,
          critical: options.connectionsCritical || 9500
        }
      },
      
      ...options
    };
    
    // Check registry
    this.checks = new Map();
    this.dependencies = new Map();
    
    // Results cache
    this.lastResults = new Map();
    this.lastFullCheck = null;
    this.isChecking = false;
    
    // Metrics tracking
    this.metrics = {
      checksPerformed: 0,
      checksFailed: 0,
      totalDuration: 0,
      lastCheckDuration: 0
    };
    
    // CPU usage tracking
    this.cpuUsage = process.cpuUsage();
    this.lastCpuCheck = Date.now();
    
    // Register core checks
    this._registerCoreChecks();
  }
  
  _registerCoreChecks() {
    // System checks
    this.registerCheck('cpu', () => this._checkCPU(), {
      critical: true,
      description: 'CPU usage and load average'
    });
    
    this.registerCheck('memory', () => this._checkMemory(), {
      critical: true,
      description: 'Memory usage and availability'
    });
    
    this.registerCheck('disk', () => this._checkDisk(), {
      critical: true,
      description: 'Disk space availability'
    });
    
    this.registerCheck('process', () => this._checkProcess(), {
      critical: false,
      description: 'Node.js process health'
    });
    
    this.registerCheck('network', () => this._checkNetwork(), {
      critical: false,
      description: 'Network interface status'
    });
  }
  
  registerCheck(name, checkFn, options = {}) {
    this.checks.set(name, {
      name,
      fn: checkFn,
      timeout: options.timeout || this.options.timeout,
      critical: options.critical || false,
      enabled: options.enabled !== false,
      description: options.description || name,
      dependencies: options.dependencies || []
    });
  }
  
  registerDependency(name, dependency) {
    if (!this.dependencies.has(name)) {
      this.dependencies.set(name, []);
    }
    this.dependencies.get(name).push(dependency);
  }
  
  async performCheck(checkName = null) {
    const startTime = performance.now();
    
    if (this.isChecking) {
      return this._getCachedResults();
    }
    
    this.isChecking = true;
    const results = new Map();
    
    try {
      if (checkName) {
        // Single check
        const check = this.checks.get(checkName);
        if (check && check.enabled) {
          const result = await this._runCheck(check);
          results.set(checkName, result);
        }
      } else {
        // All checks
        const checkPromises = [];
        
        for (const [name, check] of this.checks) {
          if (check.enabled) {
            checkPromises.push(
              this._runCheck(check).then(result => ({ name, result }))
            );
          }
        }
        
        const checkResults = await Promise.all(checkPromises);
        
        for (const { name, result } of checkResults) {
          results.set(name, result);
        }
      }
      
      // Calculate overall status
      const overallStatus = this._calculateOverallStatus(results);
      
      // Build response
      const response = {
        status: overallStatus,
        timestamp: Date.now(),
        duration: performance.now() - startTime,
        checks: Object.fromEntries(results),
        metrics: this.options.detailedMetrics ? this._getDetailedMetrics() : undefined
      };
      
      // Update metrics
      this.metrics.checksPerformed++;
      this.metrics.lastCheckDuration = response.duration;
      this.metrics.totalDuration += response.duration;
      
      // Cache results
      this.lastResults = results;
      this.lastFullCheck = response;
      
      // Emit events
      this.emit('check', response);
      
      if (overallStatus === HealthStatus.UNHEALTHY) {
        this.emit('unhealthy', response);
      }
      
      return response;
    } finally {
      this.isChecking = false;
    }
  }
  
  async _runCheck(check) {
    const startTime = performance.now();
    
    try {
      // Check dependencies first
      if (check.dependencies.length > 0) {
        for (const dep of check.dependencies) {
          const depCheck = this.checks.get(dep);
          if (depCheck && !this.lastResults.has(dep)) {
            await this._runCheck(depCheck);
          }
          
          const depResult = this.lastResults.get(dep);
          if (depResult && depResult.status === CheckStatus.FAIL) {
            return {
              status: CheckStatus.SKIP,
              message: `Skipped due to failed dependency: ${dep}`,
              duration: performance.now() - startTime
            };
          }
        }
      }
      
      // Run check with timeout
      const result = await Promise.race([
        check.fn(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Check timeout')), check.timeout)
        )
      ]);
      
      return {
        ...result,
        duration: performance.now() - startTime
      };
    } catch (error) {
      this.metrics.checksFailed++;
      
      return {
        status: CheckStatus.FAIL,
        message: error.message,
        error: error.stack,
        duration: performance.now() - startTime
      };
    }
  }
  
  async _checkCPU() {
    const usage = process.cpuUsage(this.cpuUsage);
    const elapsed = Date.now() - this.lastCpuCheck;
    
    // Calculate percentage
    const userPercent = (usage.user / 1000 / elapsed) * 100;
    const systemPercent = (usage.system / 1000 / elapsed) * 100;
    const totalPercent = userPercent + systemPercent;
    
    // Update for next check
    this.cpuUsage = process.cpuUsage();
    this.lastCpuCheck = Date.now();
    
    // Get load average
    const load = loadavg();
    const numCPUs = cpus().length;
    const loadPerCPU = load[0] / numCPUs;
    
    // Determine status
    let status = CheckStatus.PASS;
    let message = 'CPU usage normal';
    
    if (totalPercent > this.options.thresholds.cpu.critical || loadPerCPU > 2) {
      status = CheckStatus.FAIL;
      message = 'CPU usage critical';
    } else if (totalPercent > this.options.thresholds.cpu.warning || loadPerCPU > 1) {
      status = CheckStatus.WARN;
      message = 'CPU usage elevated';
    }
    
    return {
      status,
      message,
      metrics: {
        usage: {
          user: userPercent.toFixed(2),
          system: systemPercent.toFixed(2),
          total: totalPercent.toFixed(2)
        },
        loadAverage: {
          '1m': load[0].toFixed(2),
          '5m': load[1].toFixed(2),
          '15m': load[2].toFixed(2),
          perCPU: loadPerCPU.toFixed(2)
        },
        cores: numCPUs
      }
    };
  }
  
  async _checkMemory() {
    const total = totalmem();
    const free = freemem();
    const used = total - free;
    const usagePercent = (used / total) * 100;
    
    // Process memory
    const processMemory = process.memoryUsage();
    const heapPercent = (processMemory.heapUsed / processMemory.heapTotal) * 100;
    
    let status = CheckStatus.PASS;
    let message = 'Memory usage normal';
    
    if (usagePercent > this.options.thresholds.memory.critical) {
      status = CheckStatus.FAIL;
      message = 'Memory usage critical';
    } else if (usagePercent > this.options.thresholds.memory.warning) {
      status = CheckStatus.WARN;
      message = 'Memory usage elevated';
    }
    
    return {
      status,
      message,
      metrics: {
        system: {
          total: (total / 1024 / 1024 / 1024).toFixed(2) + ' GB',
          free: (free / 1024 / 1024 / 1024).toFixed(2) + ' GB',
          used: (used / 1024 / 1024 / 1024).toFixed(2) + ' GB',
          usagePercent: usagePercent.toFixed(2)
        },
        process: {
          rss: (processMemory.rss / 1024 / 1024).toFixed(2) + ' MB',
          heapTotal: (processMemory.heapTotal / 1024 / 1024).toFixed(2) + ' MB',
          heapUsed: (processMemory.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
          heapPercent: heapPercent.toFixed(2),
          external: (processMemory.external / 1024 / 1024).toFixed(2) + ' MB'
        }
      }
    };
  }
  
  async _checkDisk() {
    try {
      // Check main data directory
      const dataPath = this.options.dataPath || './data';
      const stats = await fs.statfs(dataPath);
      
      const total = stats.blocks * stats.bsize;
      const free = stats.bfree * stats.bsize;
      const used = total - free;
      const usagePercent = (used / total) * 100;
      
      let status = CheckStatus.PASS;
      let message = 'Disk space adequate';
      
      if (usagePercent > this.options.thresholds.disk.critical) {
        status = CheckStatus.FAIL;
        message = 'Disk space critical';
      } else if (usagePercent > this.options.thresholds.disk.warning) {
        status = CheckStatus.WARN;
        message = 'Disk space low';
      }
      
      return {
        status,
        message,
        metrics: {
          total: (total / 1024 / 1024 / 1024).toFixed(2) + ' GB',
          free: (free / 1024 / 1024 / 1024).toFixed(2) + ' GB',
          used: (used / 1024 / 1024 / 1024).toFixed(2) + ' GB',
          usagePercent: usagePercent.toFixed(2)
        }
      };
    } catch (error) {
      return {
        status: CheckStatus.WARN,
        message: 'Unable to check disk space',
        error: error.message
      };
    }
  }
  
  async _checkProcess() {
    const processUptime = process.uptime();
    const systemUptime = uptime();
    
    const metrics = {
      pid: process.pid,
      version: process.version,
      uptime: {
        process: this._formatUptime(processUptime),
        system: this._formatUptime(systemUptime)
      },
      handles: process._getActiveHandles().length,
      requests: process._getActiveRequests().length
    };
    
    return {
      status: CheckStatus.PASS,
      message: 'Process healthy',
      metrics
    };
  }
  
  async _checkNetwork() {
    const interfaces = networkInterfaces();
    const activeInterfaces = [];
    
    for (const [name, addresses] of Object.entries(interfaces)) {
      if (addresses) {
        const ipv4 = addresses.find(addr => addr.family === 'IPv4' && !addr.internal);
        if (ipv4) {
          activeInterfaces.push({
            name,
            address: ipv4.address,
            mac: ipv4.mac
          });
        }
      }
    }
    
    return {
      status: activeInterfaces.length > 0 ? CheckStatus.PASS : CheckStatus.WARN,
      message: activeInterfaces.length > 0 ? 'Network interfaces active' : 'No active network interfaces',
      metrics: {
        interfaces: activeInterfaces
      }
    };
  }
  
  async checkComponent(name, component) {
    try {
      if (component.isHealthy && typeof component.isHealthy === 'function') {
        const healthy = await component.isHealthy();
        return {
          status: healthy ? CheckStatus.PASS : CheckStatus.FAIL,
          message: `${name} is ${healthy ? 'healthy' : 'unhealthy'}`
        };
      }
      
      if (component.getMetrics && typeof component.getMetrics === 'function') {
        const metrics = await component.getMetrics();
        return {
          status: CheckStatus.PASS,
          message: `${name} is operational`,
          metrics
        };
      }
      
      return {
        status: CheckStatus.PASS,
        message: `${name} check not implemented`
      };
    } catch (error) {
      return {
        status: CheckStatus.FAIL,
        message: `${name} check failed`,
        error: error.message
      };
    }
  }
  
  _calculateOverallStatus(results) {
    let hasFailure = false;
    let hasWarning = false;
    
    for (const [name, result] of results) {
      const check = this.checks.get(name);
      
      if (result.status === CheckStatus.FAIL) {
        if (check && check.critical) {
          return HealthStatus.UNHEALTHY;
        }
        hasFailure = true;
      } else if (result.status === CheckStatus.WARN) {
        hasWarning = true;
      }
    }
    
    if (hasFailure) {
      return HealthStatus.UNHEALTHY;
    } else if (hasWarning) {
      return HealthStatus.DEGRADED;
    }
    
    return HealthStatus.HEALTHY;
  }
  
  _getCachedResults() {
    if (this.lastFullCheck && 
        Date.now() - this.lastFullCheck.timestamp < this.options.interval) {
      return {
        ...this.lastFullCheck,
        cached: true
      };
    }
    
    return null;
  }
  
  _getDetailedMetrics() {
    return {
      checks: {
        total: this.checks.size,
        enabled: Array.from(this.checks.values()).filter(c => c.enabled).length,
        critical: Array.from(this.checks.values()).filter(c => c.critical).length
      },
      performance: {
        checksPerformed: this.metrics.checksPerformed,
        checksFailed: this.metrics.checksFailed,
        avgDuration: this.metrics.checksPerformed > 0 
          ? (this.metrics.totalDuration / this.metrics.checksPerformed).toFixed(2) 
          : 0,
        lastDuration: this.metrics.lastCheckDuration.toFixed(2)
      }
    };
  }
  
  _formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    
    return parts.join(' ') || '0m';
  }
  
  // Express middleware
  middleware() {
    return async (req, res) => {
      const result = await this.performCheck();
      
      const statusCode = result.status === HealthStatus.HEALTHY ? 200 :
                        result.status === HealthStatus.DEGRADED ? 200 : 503;
      
      res.status(statusCode).json(result);
    };
  }
  
  // Liveness probe (simple check)
  async liveness() {
    return {
      status: 'alive',
      timestamp: Date.now(),
      uptime: process.uptime()
    };
  }
  
  // Readiness probe (full check)
  async readiness() {
    const result = await this.performCheck();
    return {
      ready: result.status !== HealthStatus.UNHEALTHY,
      status: result.status,
      timestamp: result.timestamp
    };
  }
}

export default EnhancedHealthCheck;