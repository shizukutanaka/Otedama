/**
 * Error Recovery and Failover System for Otedama
 * Ensures high availability and automatic recovery from failures
 * 
 * Design principles:
 * - Carmack: Fast failure detection and recovery
 * - Martin: Clean separation of failure domains
 * - Pike: Simple but resilient
 */

import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import axios from 'axios';

// Service states
export const ServiceState = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  RECOVERING: 'recovering',
  FAILED: 'failed'
};

// Recovery strategies
export const RecoveryStrategy = {
  RESTART: 'restart',
  FAILOVER: 'failover',
  CIRCUIT_BREAKER: 'circuit_breaker',
  RETRY_WITH_BACKOFF: 'retry_with_backoff',
  DEGRADE_GRACEFULLY: 'degrade_gracefully',
  EMERGENCY_MODE: 'emergency_mode'
};

// Health check types
export const HealthCheckType = {
  HTTP: 'http',
  TCP: 'tcp',
  PROCESS: 'process',
  DATABASE: 'database',
  CUSTOM: 'custom'
};

/**
 * Circuit Breaker implementation
 */
class CircuitBreaker {
  constructor(options = {}) {
    this.threshold = options.threshold || 5;
    this.timeout = options.timeout || 60000; // 1 minute
    this.resetTimeout = options.resetTimeout || 120000; // 2 minutes
    
    this.state = 'closed'; // closed, open, half-open
    this.failures = 0;
    this.lastFailureTime = null;
    this.nextAttemptTime = null;
    this.successCount = 0;
    this.requests = {
      total: 0,
      failed: 0,
      successful: 0,
      rejected: 0
    };
  }

  async execute(fn) {
    this.requests.total++;
    
    if (this.state === 'open') {
      if (Date.now() < this.nextAttemptTime) {
        this.requests.rejected++;
        throw new Error('Circuit breaker is open');
      }
      // Try half-open
      this.state = 'half-open';
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.requests.successful++;
    this.failures = 0;
    
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= 3) {
        this.state = 'closed';
        this.successCount = 0;
      }
    }
  }

  onFailure() {
    this.requests.failed++;
    this.failures++;
    this.lastFailureTime = Date.now();
    this.successCount = 0;
    
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.nextAttemptTime = Date.now() + this.timeout;
    }
  }

  getState() {
    return {
      state: this.state,
      failures: this.failures,
      requests: this.requests,
      nextAttemptTime: this.nextAttemptTime
    };
  }

  reset() {
    this.state = 'closed';
    this.failures = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.nextAttemptTime = null;
  }
}

/**
 * Health Monitor for individual services
 */
class HealthMonitor {
  constructor(service, options = {}) {
    this.service = service;
    this.options = options;
    this.state = ServiceState.HEALTHY;
    this.consecutiveFailures = 0;
    this.lastCheck = null;
    this.lastError = null;
    this.metrics = {
      checks: 0,
      failures: 0,
      uptime: 0,
      availability: 100
    };
  }

  async check() {
    this.metrics.checks++;
    const startTime = Date.now();
    
    try {
      let healthy = false;
      
      switch (this.options.type) {
        case HealthCheckType.HTTP:
          healthy = await this.checkHTTP();
          break;
          
        case HealthCheckType.TCP:
          healthy = await this.checkTCP();
          break;
          
        case HealthCheckType.PROCESS:
          healthy = await this.checkProcess();
          break;
          
        case HealthCheckType.DATABASE:
          healthy = await this.checkDatabase();
          break;
          
        case HealthCheckType.CUSTOM:
          healthy = await this.options.checkFn();
          break;
          
        default:
          healthy = true;
      }
      
      if (healthy) {
        this.onHealthy();
      } else {
        this.onUnhealthy(new Error('Health check failed'));
      }
      
      return healthy;
      
    } catch (error) {
      this.onUnhealthy(error);
      return false;
    } finally {
      this.lastCheck = Date.now();
      const checkDuration = Date.now() - startTime;
      
      // Update availability
      const totalTime = this.metrics.checks * 1000; // Assume 1s between checks
      const downtime = this.metrics.failures * 1000;
      this.metrics.availability = ((totalTime - downtime) / totalTime * 100).toFixed(2);
    }
  }

  async checkHTTP() {
    const response = await axios.get(this.options.url, {
      timeout: this.options.timeout || 5000,
      validateStatus: null
    });
    
    const healthy = response.status === 200;
    
    if (this.options.validateResponse) {
      return healthy && this.options.validateResponse(response.data);
    }
    
    return healthy;
  }

  async checkTCP() {
    // TCP connection check
    return new Promise((resolve) => {
      const net = require('net');
      const socket = new net.Socket();
      
      socket.setTimeout(this.options.timeout || 5000);
      
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      
      socket.on('error', () => {
        resolve(false);
      });
      
      socket.connect(this.options.port, this.options.host);
    });
  }

  async checkProcess() {
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        const cmd = process.platform === 'win32' ? 'tasklist' : 'ps aux';
        const proc = spawn(cmd, [], { shell: true });
        
        let stdout = '';
        proc.stdout.on('data', (data) => stdout += data);
        proc.on('close', (code) => {
          if (code === 0) {
            resolve({ stdout });
          } else {
            reject(new Error(`Process check failed with code ${code}`));
          }
        });
      });
      
      return stdout.includes(this.options.processName);
    } catch (error) {
      return false;
    }
  }

  async checkDatabase() {
    try {
      const result = await this.options.db.get('SELECT 1');
      return !!result;
    } catch (error) {
      return false;
    }
  }

  onHealthy() {
    const previousState = this.state;
    this.consecutiveFailures = 0;
    this.lastError = null;
    
    if (this.state === ServiceState.RECOVERING) {
      this.state = ServiceState.HEALTHY;
    } else if (this.state === ServiceState.DEGRADED && this.consecutiveFailures === 0) {
      this.state = ServiceState.HEALTHY;
    }
    
    if (previousState !== this.state) {
      this.onStateChange(previousState, this.state);
    }
  }

  onUnhealthy(error) {
    const previousState = this.state;
    this.consecutiveFailures++;
    this.lastError = error;
    this.metrics.failures++;
    
    if (this.consecutiveFailures >= 3) {
      this.state = ServiceState.UNHEALTHY;
    } else if (this.consecutiveFailures >= 1) {
      this.state = ServiceState.DEGRADED;
    }
    
    if (previousState !== this.state) {
      this.onStateChange(previousState, this.state);
    }
  }

  onStateChange(from, to) {
    // Override in subclass
  }

  getStatus() {
    return {
      service: this.service,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastCheck: this.lastCheck,
      lastError: this.lastError?.message,
      metrics: this.metrics
    };
  }
}

/**
 * Service Recovery Manager
 */
class ServiceRecoveryManager extends EventEmitter {
  constructor(service, options = {}) {
    super();
    
    this.service = service;
    this.options = options;
    this.recoveryAttempts = 0;
    this.maxRecoveryAttempts = options.maxRecoveryAttempts || 3;
    this.recoveryDelay = options.recoveryDelay || 5000;
    this.isRecovering = false;
    
    // Circuit breaker for recovery attempts
    this.circuitBreaker = new CircuitBreaker({
      threshold: 3,
      timeout: 60000
    });
  }

  async recover(error, strategy = RecoveryStrategy.RESTART) {
    if (this.isRecovering) {
      return { success: false, reason: 'Recovery already in progress' };
    }
    
    this.isRecovering = true;
    this.recoveryAttempts++;
    
    this.emit('recovery:started', {
      service: this.service,
      strategy,
      attempt: this.recoveryAttempts,
      error: error.message
    });
    
    try {
      let result;
      
      switch (strategy) {
        case RecoveryStrategy.RESTART:
          result = await this.restartService();
          break;
          
        case RecoveryStrategy.FAILOVER:
          result = await this.failoverService();
          break;
          
        case RecoveryStrategy.CIRCUIT_BREAKER:
          result = await this.applyCircuitBreaker();
          break;
          
        case RecoveryStrategy.RETRY_WITH_BACKOFF:
          result = await this.retryWithBackoff();
          break;
          
        case RecoveryStrategy.DEGRADE_GRACEFULLY:
          result = await this.degradeGracefully();
          break;
          
        case RecoveryStrategy.EMERGENCY_MODE:
          result = await this.enterEmergencyMode();
          break;
          
        default:
          result = { success: false, reason: 'Unknown strategy' };
      }
      
      if (result.success) {
        this.recoveryAttempts = 0;
        this.emit('recovery:success', {
          service: this.service,
          strategy,
          result
        });
      } else {
        this.emit('recovery:failed', {
          service: this.service,
          strategy,
          attempt: this.recoveryAttempts,
          reason: result.reason
        });
        
        if (this.recoveryAttempts >= this.maxRecoveryAttempts) {
          this.emit('recovery:exhausted', {
            service: this.service,
            attempts: this.recoveryAttempts
          });
        }
      }
      
      return result;
      
    } catch (error) {
      this.emit('recovery:error', {
        service: this.service,
        strategy,
        error: error.message
      });
      
      return { success: false, reason: error.message };
      
    } finally {
      this.isRecovering = false;
      
      // Delay before next recovery attempt
      if (!result?.success && this.recoveryAttempts < this.maxRecoveryAttempts) {
        await new Promise(resolve => setTimeout(resolve, this.recoveryDelay * this.recoveryAttempts));
      }
    }
  }

  async restartService() {
    if (this.options.restart) {
      return await this.options.restart();
    }
    
    // Default PM2 restart
    try {
      await new Promise((resolve, reject) => {
        spawn('pm2', ['restart', this.service], { shell: true })
          .on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`PM2 restart failed with code ${code}`));
          });
      });
      
      // Wait for service to come up
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      return { success: true };
    } catch (error) {
      return { success: false, reason: error.message };
    }
  }

  async failoverService() {
    if (!this.options.failoverTarget) {
      return { success: false, reason: 'No failover target configured' };
    }
    
    try {
      // Activate failover
      await this.options.failoverTarget.activate();
      
      // Update routing/DNS if needed
      if (this.options.updateRouting) {
        await this.options.updateRouting(this.options.failoverTarget);
      }
      
      return { success: true, target: this.options.failoverTarget.name };
    } catch (error) {
      return { success: false, reason: error.message };
    }
  }

  async applyCircuitBreaker() {
    return await this.circuitBreaker.execute(async () => {
      if (this.options.serviceFunction) {
        await this.options.serviceFunction();
        return { success: true };
      }
      return { success: false, reason: 'No service function provided' };
    });
  }

  async retryWithBackoff() {
    const delays = [1000, 2000, 4000, 8000, 16000];
    const maxAttempts = Math.min(this.recoveryAttempts, delays.length);
    
    for (let i = 0; i < maxAttempts; i++) {
      try {
        if (this.options.retryFunction) {
          await this.options.retryFunction();
          return { success: true, attempts: i + 1 };
        }
      } catch (error) {
        if (i < maxAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, delays[i]));
        }
      }
    }
    
    return { success: false, reason: 'All retry attempts failed' };
  }

  async degradeGracefully() {
    if (this.options.degradedMode) {
      await this.options.degradedMode.enable();
      return { success: true, mode: 'degraded' };
    }
    
    return { success: false, reason: 'No degraded mode configured' };
  }

  async enterEmergencyMode() {
    if (this.options.emergencyMode) {
      await this.options.emergencyMode.activate();
      return { success: true, mode: 'emergency' };
    }
    
    return { success: false, reason: 'No emergency mode configured' };
  }
}

/**
 * Main Failover System
 */
export class FailoverSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      healthCheckInterval: options.healthCheckInterval || 5000,
      recoveryStrategies: options.recoveryStrategies || {},
      alerting: options.alerting || {},
      persistence: options.persistence || {}
    };
    
    // Service registry
    this.services = new Map();
    this.monitors = new Map();
    this.recoveryManagers = new Map();
    
    // System state
    this.systemHealth = ServiceState.HEALTHY;
    this.activeFailovers = new Map();
    
    // Statistics
    this.stats = {
      totalFailures: 0,
      totalRecoveries: 0,
      failoverEvents: 0,
      currentlyUnhealthy: 0,
      uptimePercentage: 100
    };
    
    // Start monitoring
    this.monitoringInterval = null;
  }

  /**
   * Register a service for monitoring
   */
  registerService(name, options) {
    const service = {
      name,
      ...options,
      dependencies: options.dependencies || [],
      priority: options.priority || 1,
      critical: options.critical || false
    };
    
    this.services.set(name, service);
    
    // Create health monitor
    const monitor = new HealthMonitor(name, options.healthCheck);
    monitor.onStateChange = (from, to) => this.onServiceStateChange(name, from, to);
    this.monitors.set(name, monitor);
    
    // Create recovery manager
    const recoveryManager = new ServiceRecoveryManager(name, {
      ...options.recovery,
      maxRecoveryAttempts: options.maxRecoveryAttempts || 3
    });
    
    recoveryManager.on('recovery:success', (event) => {
      this.stats.totalRecoveries++;
      this.emit('service:recovered', event);
    });
    
    recoveryManager.on('recovery:exhausted', (event) => {
      this.onServiceFailed(name);
    });
    
    this.recoveryManagers.set(name, recoveryManager);
    
    this.emit('service:registered', { name, service });
  }

  /**
   * Start monitoring all services
   */
  start() {
    if (this.monitoringInterval) {
      return;
    }
    
    this.monitoringInterval = setInterval(() => {
      this.checkAllServices();
    }, this.config.healthCheckInterval);
    
    // Initial check
    this.checkAllServices();
    
    this.emit('monitoring:started');
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    
    this.emit('monitoring:stopped');
  }

  /**
   * Check all services
   */
  async checkAllServices() {
    const checks = [];
    
    for (const [name, monitor] of this.monitors) {
      checks.push(
        monitor.check()
          .then(healthy => ({ name, healthy, error: null }))
          .catch(error => ({ name, healthy: false, error }))
      );
    }
    
    const results = await Promise.all(checks);
    
    // Update system health
    this.updateSystemHealth(results);
    
    // Emit status
    this.emit('health:checked', {
      results,
      systemHealth: this.systemHealth,
      timestamp: Date.now()
    });
  }

  /**
   * Handle service state change
   */
  async onServiceStateChange(serviceName, from, to) {
    this.emit('service:state-changed', {
      service: serviceName,
      from,
      to,
      timestamp: Date.now()
    });
    
    const service = this.services.get(serviceName);
    
    if (to === ServiceState.UNHEALTHY) {
      this.stats.totalFailures++;
      this.stats.currentlyUnhealthy++;
      
      // Determine recovery strategy
      const strategy = this.determineRecoveryStrategy(serviceName, from, to);
      
      // Attempt recovery
      const recoveryManager = this.recoveryManagers.get(serviceName);
      const monitor = this.monitors.get(serviceName);
      
      if (recoveryManager && monitor) {
        const result = await recoveryManager.recover(
          monitor.lastError || new Error('Service unhealthy'),
          strategy
        );
        
        if (!result.success && service.critical) {
          // Critical service failed - may need system-wide action
          this.onCriticalServiceFailure(serviceName);
        }
      }
    } else if (from === ServiceState.UNHEALTHY && to === ServiceState.HEALTHY) {
      this.stats.currentlyUnhealthy = Math.max(0, this.stats.currentlyUnhealthy - 1);
    }
    
    // Check dependencies
    if (to !== ServiceState.HEALTHY) {
      await this.checkDependencies(serviceName);
    }
  }

  /**
   * Determine recovery strategy
   */
  determineRecoveryStrategy(serviceName, from, to) {
    const service = this.services.get(serviceName);
    const customStrategy = this.config.recoveryStrategies[serviceName];
    
    if (customStrategy) {
      return customStrategy;
    }
    
    // Default strategies based on service configuration
    if (service.critical) {
      return RecoveryStrategy.FAILOVER;
    }
    
    if (from === ServiceState.DEGRADED) {
      return RecoveryStrategy.RETRY_WITH_BACKOFF;
    }
    
    return RecoveryStrategy.RESTART;
  }

  /**
   * Handle critical service failure
   */
  onCriticalServiceFailure(serviceName) {
    this.emit('critical:failure', {
      service: serviceName,
      timestamp: Date.now()
    });
    
    // Enter emergency mode if configured
    if (this.config.emergencyMode) {
      this.enterSystemEmergencyMode();
    }
  }

  /**
   * Handle complete service failure
   */
  onServiceFailed(serviceName) {
    const service = this.services.get(serviceName);
    
    this.emit('service:failed', {
      service: serviceName,
      critical: service.critical,
      timestamp: Date.now()
    });
    
    // Initiate failover if available
    if (service.failoverTarget) {
      this.initiateFailover(serviceName, service.failoverTarget);
    }
  }

  /**
   * Initiate failover
   */
  async initiateFailover(fromService, toService) {
    this.stats.failoverEvents++;
    
    const failover = {
      from: fromService,
      to: toService,
      startTime: Date.now(),
      status: 'in-progress'
    };
    
    this.activeFailovers.set(fromService, failover);
    
    this.emit('failover:started', failover);
    
    try {
      // Activate target service
      const targetService = this.services.get(toService);
      if (targetService && targetService.activate) {
        await targetService.activate();
      }
      
      // Update routing
      if (this.config.updateRouting) {
        await this.config.updateRouting(fromService, toService);
      }
      
      failover.status = 'completed';
      failover.endTime = Date.now();
      
      this.emit('failover:completed', failover);
      
    } catch (error) {
      failover.status = 'failed';
      failover.error = error.message;
      
      this.emit('failover:failed', failover);
    }
  }

  /**
   * Check service dependencies
   */
  async checkDependencies(serviceName) {
    const service = this.services.get(serviceName);
    
    if (!service.dependencies || service.dependencies.length === 0) {
      return;
    }
    
    for (const depName of service.dependencies) {
      const depMonitor = this.monitors.get(depName);
      
      if (depMonitor && depMonitor.state !== ServiceState.HEALTHY) {
        // Dependent service is also unhealthy
        this.emit('dependency:unhealthy', {
          service: serviceName,
          dependency: depName,
          state: depMonitor.state
        });
        
        // May need to cascade recovery
        const depService = this.services.get(depName);
        if (depService && !depService.isRecovering) {
          const recoveryManager = this.recoveryManagers.get(depName);
          if (recoveryManager) {
            await recoveryManager.recover(
              new Error('Dependency recovery'),
              RecoveryStrategy.RESTART
            );
          }
        }
      }
    }
  }

  /**
   * Update overall system health
   */
  updateSystemHealth(results) {
    const unhealthyCount = results.filter(r => !r.healthy).length;
    const totalCount = results.length;
    
    const previousHealth = this.systemHealth;
    
    if (unhealthyCount === 0) {
      this.systemHealth = ServiceState.HEALTHY;
    } else if (unhealthyCount < totalCount * 0.3) {
      this.systemHealth = ServiceState.DEGRADED;
    } else {
      this.systemHealth = ServiceState.UNHEALTHY;
    }
    
    // Update uptime percentage
    const healthyCount = results.filter(r => r.healthy).length;
    this.stats.uptimePercentage = totalCount > 0 ?
      (healthyCount / totalCount * 100).toFixed(2) : 100;
    
    if (previousHealth !== this.systemHealth) {
      this.emit('system:health-changed', {
        from: previousHealth,
        to: this.systemHealth,
        unhealthyServices: results.filter(r => !r.healthy).map(r => r.name)
      });
    }
  }

  /**
   * Enter system emergency mode
   */
  enterSystemEmergencyMode() {
    this.emit('system:emergency-mode', {
      timestamp: Date.now(),
      unhealthyServices: this.stats.currentlyUnhealthy
    });
    
    // Implement emergency procedures
    // - Disable non-critical features
    // - Route traffic to backup systems
    // - Alert administrators
    // - Begin data preservation
  }

  /**
   * Get system status
   */
  getStatus() {
    const serviceStatuses = {};
    
    for (const [name, monitor] of this.monitors) {
      serviceStatuses[name] = monitor.getStatus();
    }
    
    const circuitBreakers = {};
    
    for (const [name, manager] of this.recoveryManagers) {
      if (manager.circuitBreaker) {
        circuitBreakers[name] = manager.circuitBreaker.getState();
      }
    }
    
    return {
      systemHealth: this.systemHealth,
      services: serviceStatuses,
      circuitBreakers,
      activeFailovers: Array.from(this.activeFailovers.values()),
      stats: this.stats,
      timestamp: Date.now()
    };
  }

  /**
   * Manual failover
   */
  async manualFailover(fromService, toService) {
    return this.initiateFailover(fromService, toService);
  }

  /**
   * Force service recovery
   */
  async forceRecover(serviceName, strategy = RecoveryStrategy.RESTART) {
    const recoveryManager = this.recoveryManagers.get(serviceName);
    
    if (!recoveryManager) {
      throw new Error(`Service ${serviceName} not found`);
    }
    
    return recoveryManager.recover(
      new Error('Manual recovery triggered'),
      strategy
    );
  }

  /**
   * Reset service state
   */
  resetService(serviceName) {
    const monitor = this.monitors.get(serviceName);
    const recoveryManager = this.recoveryManagers.get(serviceName);
    
    if (monitor) {
      monitor.state = ServiceState.HEALTHY;
      monitor.consecutiveFailures = 0;
      monitor.lastError = null;
    }
    
    if (recoveryManager) {
      recoveryManager.recoveryAttempts = 0;
      recoveryManager.circuitBreaker.reset();
    }
    
    this.emit('service:reset', { service: serviceName });
  }

  /**
   * Shutdown
   */
  shutdown() {
    this.stop();
    this.emit('shutdown');
  }
}

// Factory function
export function createFailoverSystem(options) {
  return new FailoverSystem(options);
}

// Default export
export default FailoverSystem;
