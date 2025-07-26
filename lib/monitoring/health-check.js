/**
 * Health Check System - Otedama
 * Comprehensive health monitoring and status reporting
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import os from 'os';
import { performance } from 'perf_hooks';

const logger = createStructuredLogger('HealthCheck');

export class HealthCheckSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      checkInterval: options.checkInterval || 30000, // 30 seconds
      unhealthyThreshold: options.unhealthyThreshold || 3,
      healthyThreshold: options.healthyThreshold || 2,
      timeout: options.timeout || 5000,
      ...options
    };
    
    // Component checks
    this.checks = new Map();
    this.checkResults = new Map();
    this.checkHistory = new Map();
    
    // System status
    this.status = {
      healthy: true,
      lastCheck: null,
      components: {},
      metrics: {}
    };
    
    // Register default checks
    this.registerDefaultChecks();
    
    // Start health check timer
    this.checkTimer = null;
  }
  
  /**
   * Register default health checks
   */
  registerDefaultChecks() {
    // System resources
    this.registerCheck('system:cpu', async () => {
      const load = os.loadavg()[0];
      const cpus = os.cpus().length;
      const threshold = cpus * 0.8;
      
      return {
        healthy: load < threshold,
        message: `CPU load: ${load.toFixed(2)} (${cpus} cores)`,
        metrics: { load, cpus, utilization: (load / cpus * 100).toFixed(2) + '%' }
      };
    });
    
    this.registerCheck('system:memory', async () => {
      const total = os.totalmem();
      const free = os.freemem();
      const used = total - free;
      const usagePercent = (used / total) * 100;
      
      return {
        healthy: usagePercent < 90,
        message: `Memory: ${this.formatBytes(used)} / ${this.formatBytes(total)} (${usagePercent.toFixed(1)}%)`,
        metrics: { 
          total: this.formatBytes(total), 
          free: this.formatBytes(free), 
          used: this.formatBytes(used),
          percent: usagePercent.toFixed(1) + '%'
        }
      };
    });
    
    this.registerCheck('system:disk', async () => {
      // This is a placeholder - in production, use proper disk checking
      // For example, using 'diskusage' npm package
      return {
        healthy: true,
        message: 'Disk space check not implemented',
        metrics: {}
      };
    });
    
    // Process health
    this.registerCheck('process:uptime', async () => {
      const uptime = process.uptime();
      return {
        healthy: true,
        message: `Process uptime: ${this.formatDuration(uptime)}`,
        metrics: { uptime, formatted: this.formatDuration(uptime) }
      };
    });
    
    this.registerCheck('process:memory', async () => {
      const mem = process.memoryUsage();
      const heapPercent = (mem.heapUsed / mem.heapTotal) * 100;
      
      return {
        healthy: heapPercent < 90,
        message: `Heap: ${this.formatBytes(mem.heapUsed)} / ${this.formatBytes(mem.heapTotal)} (${heapPercent.toFixed(1)}%)`,
        metrics: {
          rss: this.formatBytes(mem.rss),
          heapTotal: this.formatBytes(mem.heapTotal),
          heapUsed: this.formatBytes(mem.heapUsed),
          external: this.formatBytes(mem.external),
          heapPercent: heapPercent.toFixed(1) + '%'
        }
      };
    });
    
    this.registerCheck('process:handles', async () => {
      // Get active handles count
      const handles = process._getActiveHandles().length;
      const requests = process._getActiveRequests().length;
      
      return {
        healthy: handles < 1000 && requests < 100,
        message: `Active handles: ${handles}, requests: ${requests}`,
        metrics: { handles, requests }
      };
    });
  }
  
  /**
   * Register a health check
   */
  registerCheck(name, checkFn, options = {}) {
    this.checks.set(name, {
      fn: checkFn,
      options: {
        critical: options.critical || false,
        timeout: options.timeout || this.options.timeout,
        ...options
      }
    });
    
    // Initialize history
    this.checkHistory.set(name, []);
    
    logger.debug('Health check registered', { name, critical: options.critical });
  }
  
  /**
   * Unregister a health check
   */
  unregisterCheck(name) {
    this.checks.delete(name);
    this.checkResults.delete(name);
    this.checkHistory.delete(name);
  }
  
  /**
   * Run all health checks
   */
  async runChecks() {
    const startTime = performance.now();
    const results = new Map();
    
    // Run all checks in parallel
    const checkPromises = Array.from(this.checks.entries()).map(async ([name, check]) => {
      try {
        const checkStart = performance.now();
        
        // Run with timeout
        const result = await this.runWithTimeout(
          check.fn(),
          check.options.timeout
        );
        
        const duration = performance.now() - checkStart;
        
        return {
          name,
          ...result,
          duration,
          timestamp: Date.now(),
          error: null
        };
      } catch (error) {
        logger.error('Health check failed', { name, error: error.message });
        
        return {
          name,
          healthy: false,
          message: error.message,
          metrics: {},
          duration: performance.now() - checkStart,
          timestamp: Date.now(),
          error: error.message
        };
      }
    });
    
    // Wait for all checks
    const checkResults = await Promise.all(checkPromises);
    
    // Process results
    let overallHealthy = true;
    const componentStatus = {};
    
    for (const result of checkResults) {
      results.set(result.name, result);
      
      // Update history
      const history = this.checkHistory.get(result.name) || [];
      history.push({
        healthy: result.healthy,
        timestamp: result.timestamp
      });
      
      // Keep only recent history
      if (history.length > 10) {
        history.shift();
      }
      this.checkHistory.set(result.name, history);
      
      // Determine component health based on history
      const recentResults = history.slice(-this.options.unhealthyThreshold);
      const healthyCount = recentResults.filter(r => r.healthy).length;
      const componentHealthy = healthyCount >= this.options.healthyThreshold;
      
      componentStatus[result.name] = {
        healthy: componentHealthy,
        lastCheck: result,
        history: history.length
      };
      
      // Check if critical component is unhealthy
      const check = this.checks.get(result.name);
      if (check.options.critical && !componentHealthy) {
        overallHealthy = false;
      }
    }
    
    // Update status
    this.status = {
      healthy: overallHealthy,
      lastCheck: Date.now(),
      duration: performance.now() - startTime,
      components: componentStatus,
      metrics: this.collectMetrics(results)
    };
    
    // Store results
    this.checkResults = results;
    
    // Emit status
    this.emit('health:checked', this.status);
    
    if (!overallHealthy) {
      this.emit('health:unhealthy', this.status);
    }
    
    return this.status;
  }
  
  /**
   * Run function with timeout
   */
  async runWithTimeout(promise, timeout) {
    return Promise.race([
      promise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Health check timeout')), timeout)
      )
    ]);
  }
  
  /**
   * Collect metrics from results
   */
  collectMetrics(results) {
    const metrics = {};
    
    for (const [name, result] of results) {
      if (result.metrics) {
        metrics[name] = result.metrics;
      }
    }
    
    return metrics;
  }
  
  /**
   * Start health monitoring
   */
  start() {
    if (this.checkTimer) {
      return;
    }
    
    // Run initial check
    this.runChecks();
    
    // Start periodic checks
    this.checkTimer = setInterval(() => {
      this.runChecks();
    }, this.options.checkInterval);
    
    logger.info('Health monitoring started', {
      interval: this.options.checkInterval,
      checks: Array.from(this.checks.keys())
    });
  }
  
  /**
   * Stop health monitoring
   */
  stop() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    
    logger.info('Health monitoring stopped');
  }
  
  /**
   * Get current health status
   */
  getStatus() {
    return {
      ...this.status,
      checkCount: this.checks.size,
      uptime: process.uptime()
    };
  }
  
  /**
   * Get detailed health report
   */
  getDetailedReport() {
    const report = {
      status: this.status.healthy ? 'healthy' : 'unhealthy',
      timestamp: Date.now(),
      lastCheck: this.status.lastCheck,
      uptime: process.uptime(),
      system: {
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        cpus: os.cpus().length,
        totalMemory: this.formatBytes(os.totalmem()),
        loadAverage: os.loadavg()
      },
      process: {
        pid: process.pid,
        uptime: this.formatDuration(process.uptime()),
        memory: process.memoryUsage(),
        cpuUsage: process.cpuUsage()
      },
      checks: {}
    };
    
    // Add check results
    for (const [name, result] of this.checkResults) {
      report.checks[name] = {
        healthy: result.healthy,
        message: result.message,
        duration: result.duration,
        lastRun: result.timestamp,
        metrics: result.metrics,
        history: this.checkHistory.get(name) || []
      };
    }
    
    return report;
  }
  
  /**
   * Express middleware for health endpoint
   */
  expressMiddleware() {
    return async (req, res) => {
      const status = await this.runChecks();
      const statusCode = status.healthy ? 200 : 503;
      
      res.status(statusCode).json({
        status: status.healthy ? 'ok' : 'error',
        timestamp: new Date().toISOString(),
        checks: Object.entries(status.components).map(([name, component]) => ({
          name,
          status: component.healthy ? 'ok' : 'error',
          message: component.lastCheck.message,
          metrics: component.lastCheck.metrics
        }))
      });
    };
  }
  
  /**
   * Readiness check (for k8s)
   */
  async checkReadiness() {
    // Run only critical checks
    const criticalChecks = Array.from(this.checks.entries())
      .filter(([_, check]) => check.options.critical);
    
    for (const [name, check] of criticalChecks) {
      try {
        const result = await check.fn();
        if (!result.healthy) {
          return { ready: false, reason: `${name}: ${result.message}` };
        }
      } catch (error) {
        return { ready: false, reason: `${name}: ${error.message}` };
      }
    }
    
    return { ready: true };
  }
  
  /**
   * Liveness check (for k8s)
   */
  async checkLiveness() {
    // Simple check - if we can respond, we're alive
    return { alive: true, timestamp: Date.now() };
  }
  
  /**
   * Format bytes to human readable
   */
  formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }
  
  /**
   * Format duration to human readable
   */
  formatDuration(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0) parts.push(`${secs}s`);
    
    return parts.join(' ') || '0s';
  }
}

export default HealthCheckSystem;