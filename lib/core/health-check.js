/**
 * Health Check System - Otedama
 * Comprehensive health monitoring and reporting
 * 
 * Design: Observable systems (Carmack)
 */

import { EventEmitter } from 'events';
import { createLogger } from './logger.js';

const logger = createLogger('HealthCheck');

/**
 * Health status levels
 */
export const HealthStatus = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  UNKNOWN: 'unknown'
};

/**
 * Health check types
 */
export const CheckType = {
  LIVENESS: 'liveness',    // Is the service alive?
  READINESS: 'readiness',  // Is the service ready to accept traffic?
  STARTUP: 'startup'       // Has the service started successfully?
};

/**
 * Individual health check
 */
export class HealthCheck {
  constructor(name, check, options = {}) {
    this.name = name;
    this.check = check;
    this.options = {
      timeout: options.timeout || 5000,
      interval: options.interval || 30000,
      retries: options.retries || 0,
      critical: options.critical !== false,
      type: options.type || CheckType.LIVENESS,
      ...options
    };
    
    this.status = HealthStatus.UNKNOWN;
    this.lastCheck = null;
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.totalChecks = 0;
    this.totalFailures = 0;
  }
  
  async run() {
    this.totalChecks++;
    const startTime = Date.now();
    
    try {
      // Run check with timeout
      const result = await this.runWithTimeout();
      
      // Update status
      this.status = result.healthy ? HealthStatus.HEALTHY : HealthStatus.UNHEALTHY;
      this.lastCheck = Date.now();
      this.lastError = result.healthy ? null : result.message;
      
      // Reset consecutive failures on success
      if (result.healthy) {
        this.consecutiveFailures = 0;
      } else {
        this.consecutiveFailures++;
        this.totalFailures++;
      }
      
      return {
        name: this.name,
        status: this.status,
        duration: Date.now() - startTime,
        message: result.message,
        details: result.details,
        timestamp: this.lastCheck
      };
      
    } catch (error) {
      this.status = HealthStatus.UNHEALTHY;
      this.lastCheck = Date.now();
      this.lastError = error.message;
      this.consecutiveFailures++;
      this.totalFailures++;
      
      return {
        name: this.name,
        status: this.status,
        duration: Date.now() - startTime,
        message: error.message,
        error: true,
        timestamp: this.lastCheck
      };
    }
  }
  
  async runWithTimeout() {
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Health check ${this.name} timed out`));
      }, this.options.timeout);
      
      try {
        const result = await this.check();
        clearTimeout(timer);
        
        // Normalize result
        if (typeof result === 'boolean') {
          resolve({ healthy: result });
        } else if (result && typeof result === 'object') {
          resolve({
            healthy: result.healthy !== false,
            message: result.message,
            details: result.details
          });
        } else {
          resolve({ healthy: true });
        }
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  
  getStats() {
    const successRate = this.totalChecks > 0 
      ? (this.totalChecks - this.totalFailures) / this.totalChecks 
      : 0;
    
    return {
      name: this.name,
      type: this.options.type,
      status: this.status,
      lastCheck: this.lastCheck,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      totalChecks: this.totalChecks,
      totalFailures: this.totalFailures,
      successRate,
      critical: this.options.critical
    };
  }
}

/**
 * Health check manager
 */
export class HealthCheckManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      defaultInterval: options.defaultInterval || 30000,
      aggregateTimeout: options.aggregateTimeout || 10000,
      degradedThreshold: options.degradedThreshold || 0.8, // 80% healthy
      ...options
    };
    
    this.checks = new Map();
    this.timers = new Map();
    this.isRunning = false;
    this.overallStatus = HealthStatus.UNKNOWN;
  }
  
  /**
   * Register a health check
   */
  register(name, check, options = {}) {
    if (this.checks.has(name)) {
      throw new Error(`Health check ${name} already registered`);
    }
    
    const healthCheck = new HealthCheck(name, check, options);
    this.checks.set(name, healthCheck);
    
    logger.info(`Registered health check: ${name}`);
    
    // Start periodic check if running
    if (this.isRunning) {
      this.startCheck(name);
    }
    
    return healthCheck;
  }
  
  /**
   * Unregister a health check
   */
  unregister(name) {
    const check = this.checks.get(name);
    if (!check) return false;
    
    // Stop timer
    this.stopCheck(name);
    
    // Remove check
    this.checks.delete(name);
    
    logger.info(`Unregistered health check: ${name}`);
    
    return true;
  }
  
  /**
   * Start all health checks
   */
  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    
    // Start all checks
    for (const name of this.checks.keys()) {
      this.startCheck(name);
    }
    
    logger.info('Health check manager started');
    this.emit('started');
  }
  
  /**
   * Stop all health checks
   */
  stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    // Stop all timers
    for (const name of this.checks.keys()) {
      this.stopCheck(name);
    }
    
    logger.info('Health check manager stopped');
    this.emit('stopped');
  }
  
  /**
   * Start individual check
   */
  startCheck(name) {
    const check = this.checks.get(name);
    if (!check) return;
    
    // Run immediately
    this.runCheck(name);
    
    // Schedule periodic runs
    const interval = check.options.interval || this.options.defaultInterval;
    const timer = setInterval(() => {
      this.runCheck(name);
    }, interval);
    
    this.timers.set(name, timer);
  }
  
  /**
   * Stop individual check
   */
  stopCheck(name) {
    const timer = this.timers.get(name);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(name);
    }
  }
  
  /**
   * Run individual check
   */
  async runCheck(name) {
    const check = this.checks.get(name);
    if (!check) return;
    
    const result = await check.run();
    
    // Emit events
    this.emit('check:complete', result);
    
    if (result.status === HealthStatus.UNHEALTHY) {
      this.emit('check:unhealthy', result);
      
      if (check.options.critical) {
        this.emit('check:critical', result);
      }
    }
    
    // Update overall status
    this.updateOverallStatus();
    
    return result;
  }
  
  /**
   * Run all checks
   */
  async runAll(type = null) {
    const promises = [];
    
    for (const [name, check] of this.checks) {
      if (!type || check.options.type === type) {
        promises.push(this.runCheck(name));
      }
    }
    
    const results = await Promise.allSettled(promises);
    
    return results.map(r => r.status === 'fulfilled' ? r.value : r.reason);
  }
  
  /**
   * Get health status
   */
  async getHealth(type = null) {
    const checks = [];
    
    for (const check of this.checks.values()) {
      if (!type || check.options.type === type) {
        checks.push(check.getStats());
      }
    }
    
    return {
      status: this.overallStatus,
      timestamp: Date.now(),
      checks
    };
  }
  
  /**
   * Get detailed health report
   */
  async getDetailedHealth() {
    // Run all checks with fresh data
    const results = await this.runAll();
    
    const report = {
      status: this.overallStatus,
      timestamp: Date.now(),
      summary: {
        total: this.checks.size,
        healthy: 0,
        degraded: 0,
        unhealthy: 0,
        critical: 0
      },
      checks: {}
    };
    
    // Process results
    for (const result of results) {
      if (result.status === HealthStatus.HEALTHY) {
        report.summary.healthy++;
      } else if (result.status === HealthStatus.DEGRADED) {
        report.summary.degraded++;
      } else if (result.status === HealthStatus.UNHEALTHY) {
        report.summary.unhealthy++;
        
        const check = this.checks.get(result.name);
        if (check && check.options.critical) {
          report.summary.critical++;
        }
      }
      
      report.checks[result.name] = result;
    }
    
    return report;
  }
  
  /**
   * Update overall status
   */
  updateOverallStatus() {
    let healthy = 0;
    let total = 0;
    let hasCriticalFailure = false;
    
    for (const check of this.checks.values()) {
      total++;
      
      if (check.status === HealthStatus.HEALTHY) {
        healthy++;
      } else if (check.status === HealthStatus.UNHEALTHY && check.options.critical) {
        hasCriticalFailure = true;
      }
    }
    
    const oldStatus = this.overallStatus;
    
    if (total === 0) {
      this.overallStatus = HealthStatus.UNKNOWN;
    } else if (hasCriticalFailure) {
      this.overallStatus = HealthStatus.UNHEALTHY;
    } else if (healthy === total) {
      this.overallStatus = HealthStatus.HEALTHY;
    } else if (healthy / total >= this.options.degradedThreshold) {
      this.overallStatus = HealthStatus.DEGRADED;
    } else {
      this.overallStatus = HealthStatus.UNHEALTHY;
    }
    
    // Emit status change
    if (oldStatus !== this.overallStatus) {
      this.emit('status:changed', {
        oldStatus,
        newStatus: this.overallStatus,
        healthy,
        total
      });
    }
  }
  
  /**
   * Express/HTTP middleware
   */
  middleware(options = {}) {
    const {
      path = '/health',
      type = CheckType.LIVENESS
    } = options;
    
    return async (req, res, next) => {
      if (req.path !== path) {
        return next();
      }
      
      try {
        const health = await this.getHealth(type);
        const statusCode = health.status === HealthStatus.HEALTHY ? 200 : 503;
        
        res.status(statusCode).json(health);
      } catch (error) {
        res.status(500).json({
          status: HealthStatus.UNHEALTHY,
          error: error.message
        });
      }
    };
  }
}

/**
 * Common health checks
 */
export const CommonChecks = {
  // Database connectivity
  database: (db) => async () => {
    try {
      await db.get('SELECT 1');
      return { healthy: true };
    } catch (error) {
      return {
        healthy: false,
        message: `Database connection failed: ${error.message}`
      };
    }
  },
  
  // Cache connectivity
  cache: (cache) => async () => {
    try {
      const key = '__health_check__';
      const value = Date.now();
      
      cache.set(key, value, 1000);
      const retrieved = cache.get(key);
      cache.delete(key);
      
      return {
        healthy: retrieved === value,
        message: retrieved !== value ? 'Cache read/write mismatch' : undefined
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Cache operation failed: ${error.message}`
      };
    }
  },
  
  // Disk space
  diskSpace: (threshold = 0.9) => async () => {
    try {
      const os = require('os');
      const disk = require('diskusage');
      
      const usage = await disk.check(os.tmpdir());
      const usageRatio = usage.used / usage.total;
      
      return {
        healthy: usageRatio < threshold,
        message: usageRatio >= threshold ? 
          `Disk usage ${(usageRatio * 100).toFixed(1)}% exceeds threshold` : undefined,
        details: {
          used: usage.used,
          total: usage.total,
          ratio: usageRatio
        }
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Disk check failed: ${error.message}`
      };
    }
  },
  
  // Memory usage
  memory: (threshold = 0.9) => () => {
    const usage = process.memoryUsage();
    const heapRatio = usage.heapUsed / usage.heapTotal;
    
    return {
      healthy: heapRatio < threshold,
      message: heapRatio >= threshold ? 
        `Memory usage ${(heapRatio * 100).toFixed(1)}% exceeds threshold` : undefined,
      details: usage
    };
  },
  
  // External service
  externalService: (url, timeout = 5000) => async () => {
    try {
      const axios = require('axios');
      const response = await axios.get(url, { timeout });
      
      return {
        healthy: response.status >= 200 && response.status < 300,
        message: response.status >= 300 ? 
          `Service returned status ${response.status}` : undefined
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Service check failed: ${error.message}`
      };
    }
  }
};

// Singleton instance
export const healthCheckManager = new HealthCheckManager();

export default {
  HealthStatus,
  CheckType,
  HealthCheck,
  HealthCheckManager,
  CommonChecks,
  healthCheckManager
};
