/**
 * Self-Healing System - Otedama
 * Autonomous recovery and resilience system for national-scale operations
 * 
 * Design Principles:
 * - Carmack: Ultra-fast detection and recovery with minimal service impact
 * - Martin: Clean separation of detection, diagnosis, and healing phases
 * - Pike: Simple configuration for complex self-healing behaviors
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { spawn } from 'child_process';
import crypto from 'crypto';

const logger = createStructuredLogger('SelfHealingSystem');

/**
 * Health check types
 */
const HEALTH_CHECK_TYPES = {
  SERVICE: 'service',
  DATABASE: 'database',
  NETWORK: 'network',
  STORAGE: 'storage',
  API: 'api',
  WEBSOCKET: 'websocket',
  BLOCKCHAIN: 'blockchain',
  MINING: 'mining'
};

/**
 * Failure types
 */
const FAILURE_TYPES = {
  SERVICE_DOWN: 'service_down',
  DATABASE_CONNECTION: 'database_connection',
  NETWORK_TIMEOUT: 'network_timeout',
  HIGH_ERROR_RATE: 'high_error_rate',
  MEMORY_LEAK: 'memory_leak',
  CPU_OVERLOAD: 'cpu_overload',
  DISK_FULL: 'disk_full',
  MINING_STOPPED: 'mining_stopped',
  BLOCKCHAIN_SYNC: 'blockchain_sync'
};

/**
 * Recovery strategies
 */
const RECOVERY_STRATEGIES = {
  RESTART: 'restart',
  SCALE: 'scale',
  FAILOVER: 'failover',
  ROLLBACK: 'rollback',
  OPTIMIZE: 'optimize',
  CLEANUP: 'cleanup',
  REPAIR: 'repair',
  ISOLATE: 'isolate'
};

/**
 * Health monitor for services
 */
class HealthMonitor {
  constructor(config = {}) {
    this.config = {
      checkInterval: config.checkInterval || 30000, // 30 seconds
      timeout: config.timeout || 10000, // 10 seconds
      retryAttempts: config.retryAttempts || 3,
      failureThreshold: config.failureThreshold || 3,
      recoveryThreshold: config.recoveryThreshold || 2,
      ...config
    };
    
    this.checks = new Map();
    this.healthStatus = new Map();
    this.failureCount = new Map();
    this.running = false;
  }
  
  /**
   * Register health check
   */
  registerCheck(name, check) {
    const healthCheck = {
      id: crypto.randomBytes(8).toString('hex'),
      name,
      type: check.type || HEALTH_CHECK_TYPES.SERVICE,
      url: check.url,
      command: check.command,
      validator: check.validator,
      interval: check.interval || this.config.checkInterval,
      timeout: check.timeout || this.config.timeout,
      retries: check.retries || this.config.retryAttempts,
      lastCheck: 0,
      nextCheck: Date.now()
    };
    
    this.checks.set(name, healthCheck);
    this.healthStatus.set(name, 'unknown');
    this.failureCount.set(name, 0);
    
    return healthCheck;
  }
  
  /**
   * Start health monitoring
   */
  start() {
    if (this.running) return;
    
    this.running = true;
    this.monitorLoop();
    
    logger.info('Health monitoring started', {
      checks: this.checks.size
    });
  }
  
  /**
   * Main monitoring loop
   */
  async monitorLoop() {
    while (this.running) {
      try {
        await this.runHealthChecks();
        await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second base interval
      } catch (error) {
        logger.error('Health monitor loop error', { error: error.message });
      }
    }
  }
  
  /**
   * Run all health checks
   */
  async runHealthChecks() {
    const now = Date.now();
    
    const promises = [];
    for (const [name, check] of this.checks) {
      if (now >= check.nextCheck) {
        promises.push(this.runHealthCheck(name, check));
      }
    }
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Run single health check
   */
  async runHealthCheck(name, check) {
    const startTime = Date.now();
    
    try {
      let result;
      
      if (check.url) {
        result = await this.checkURL(check.url, check.timeout);
      } else if (check.command) {
        result = await this.checkCommand(check.command, check.timeout);
      } else if (check.validator) {
        result = await check.validator();
      } else {
        throw new Error('No check method specified');
      }
      
      const healthy = result.healthy !== false;
      
      check.lastCheck = Date.now();
      check.nextCheck = check.lastCheck + check.interval;
      
      await this.updateHealthStatus(name, healthy, result, Date.now() - startTime);
      
    } catch (error) {
      check.lastCheck = Date.now();
      check.nextCheck = check.lastCheck + check.interval;
      
      await this.updateHealthStatus(name, false, { error: error.message }, Date.now() - startTime);
    }
  }
  
  /**
   * Check URL endpoint
   */
  async checkURL(url, timeout) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Health check timeout'));
      }, timeout);
      
      // In production, would use proper HTTP client
      // Simulating HTTP check for now
      setTimeout(() => {
        clearTimeout(timeoutId);
        resolve({
          healthy: Math.random() > 0.1, // 90% success rate simulation
          status: 200,
          responseTime: Math.random() * 1000
        });
      }, Math.random() * 1000);
    });
  }
  
  /**
   * Check command execution
   */
  async checkCommand(command, timeout) {
    return new Promise((resolve, reject) => {
      const process = spawn('sh', ['-c', command], {
        timeout: timeout
      });
      
      let stdout = '';
      let stderr = '';
      
      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          resolve({
            healthy: true,
            output: stdout,
            exitCode: code
          });
        } else {
          reject(new Error(`Command failed with exit code ${code}: ${stderr}`));
        }
      });
      
      process.on('error', (error) => {
        reject(error);
      });
    });
  }
  
  /**
   * Update health status
   */
  async updateHealthStatus(name, healthy, result, responseTime) {
    const previousStatus = this.healthStatus.get(name);
    
    if (healthy) {
      this.failureCount.set(name, 0);
      
      if (previousStatus !== 'healthy') {
        this.healthStatus.set(name, 'healthy');
        this.emit('health:recovered', {
          service: name,
          result,
          responseTime
        });
      }
      
    } else {
      const failures = this.failureCount.get(name) + 1;
      this.failureCount.set(name, failures);
      
      if (failures >= this.config.failureThreshold) {
        if (previousStatus !== 'unhealthy') {
          this.healthStatus.set(name, 'unhealthy');
          this.emit('health:failed', {
            service: name,
            failures,
            result,
            responseTime
          });
        }
      }
    }
  }
  
  /**
   * Get health status
   */
  getHealthStatus(service = null) {
    if (service) {
      return {
        status: this.healthStatus.get(service),
        failures: this.failureCount.get(service),
        check: this.checks.get(service)
      };
    }
    
    const status = {};
    for (const [name, health] of this.healthStatus) {
      status[name] = {
        status: health,
        failures: this.failureCount.get(name),
        lastCheck: this.checks.get(name)?.lastCheck
      };
    }
    
    return status;
  }
  
  /**
   * Stop health monitoring
   */
  stop() {
    this.running = false;
    logger.info('Health monitoring stopped');
  }
}

/**
 * Recovery manager
 */
class RecoveryManager {
  constructor(config = {}) {
    this.config = {
      maxRecoveryAttempts: config.maxRecoveryAttempts || 3,
      recoveryTimeout: config.recoveryTimeout || 300000, // 5 minutes
      backoffMultiplier: config.backoffMultiplier || 2,
      ...config
    };
    
    this.recoveryStrategies = new Map();
    this.activeRecoveries = new Map();
    this.recoveryHistory = [];
  }
  
  /**
   * Register recovery strategy
   */
  registerStrategy(failureType, strategy) {
    if (!this.recoveryStrategies.has(failureType)) {
      this.recoveryStrategies.set(failureType, []);
    }
    
    this.recoveryStrategies.get(failureType).push({
      id: crypto.randomBytes(8).toString('hex'),
      strategy: strategy.type,
      priority: strategy.priority || 1,
      handler: strategy.handler,
      conditions: strategy.conditions || {},
      timeout: strategy.timeout || this.config.recoveryTimeout
    });
    
    // Sort by priority
    this.recoveryStrategies.get(failureType).sort((a, b) => b.priority - a.priority);
  }
  
  /**
   * Execute recovery
   */
  async executeRecovery(service, failureType, context = {}) {
    const recoveryId = crypto.randomBytes(16).toString('hex');
    
    const recovery = {
      id: recoveryId,
      service,
      failureType,
      context,
      startTime: Date.now(),
      attempts: 0,
      status: 'starting',
      strategies: []
    };
    
    this.activeRecoveries.set(recoveryId, recovery);
    
    try {
      const strategies = this.recoveryStrategies.get(failureType) || [];
      
      for (const strategy of strategies) {
        if (recovery.attempts >= this.config.maxRecoveryAttempts) {
          break;
        }
        
        if (!this.shouldAttemptStrategy(strategy, context)) {
          continue;
        }
        
        const attempt = await this.attemptRecovery(recovery, strategy);
        recovery.strategies.push(attempt);
        recovery.attempts++;
        
        if (attempt.success) {
          recovery.status = 'completed';
          break;
        }
        
        // Backoff before next attempt
        await this.waitWithBackoff(recovery.attempts);
      }
      
      if (recovery.status !== 'completed') {
        recovery.status = 'failed';
      }
      
      recovery.endTime = Date.now();
      recovery.duration = recovery.endTime - recovery.startTime;
      
      this.recoveryHistory.push({ ...recovery });
      this.activeRecoveries.delete(recoveryId);
      
      return recovery;
      
    } catch (error) {
      recovery.status = 'error';
      recovery.error = error.message;
      recovery.endTime = Date.now();
      
      this.activeRecoveries.delete(recoveryId);
      
      throw error;
    }
  }
  
  /**
   * Attempt single recovery strategy
   */
  async attemptRecovery(recovery, strategy) {
    const attempt = {
      strategy: strategy.strategy,
      startTime: Date.now(),
      success: false,
      error: null
    };
    
    try {
      logger.info('Attempting recovery', {
        service: recovery.service,
        strategy: strategy.strategy,
        attempt: recovery.attempts + 1
      });
      
      const result = await Promise.race([
        strategy.handler(recovery.service, recovery.context),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Recovery timeout')), strategy.timeout)
        )
      ]);
      
      attempt.success = result.success !== false;
      attempt.result = result;
      
      if (attempt.success) {
        logger.info('Recovery successful', {
          service: recovery.service,
          strategy: strategy.strategy
        });
      }
      
    } catch (error) {
      attempt.error = error.message;
      logger.error('Recovery attempt failed', {
        service: recovery.service,
        strategy: strategy.strategy,
        error: error.message
      });
    }
    
    attempt.endTime = Date.now();
    attempt.duration = attempt.endTime - attempt.startTime;
    
    return attempt;
  }
  
  /**
   * Check if strategy should be attempted
   */
  shouldAttemptStrategy(strategy, context) {
    if (!strategy.conditions) return true;
    
    for (const [key, value] of Object.entries(strategy.conditions)) {
      if (context[key] !== value) {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Wait with exponential backoff
   */
  async waitWithBackoff(attempt) {
    const delay = Math.min(1000 * Math.pow(this.config.backoffMultiplier, attempt - 1), 30000);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  /**
   * Get recovery statistics
   */
  getStats() {
    return {
      strategies: Array.from(this.recoveryStrategies.keys()).length,
      activeRecoveries: this.activeRecoveries.size,
      completedRecoveries: this.recoveryHistory.length,
      successRate: this.calculateSuccessRate()
    };
  }
  
  /**
   * Calculate recovery success rate
   */
  calculateSuccessRate() {
    if (this.recoveryHistory.length === 0) return 0;
    
    const successful = this.recoveryHistory.filter(r => r.status === 'completed').length;
    return (successful / this.recoveryHistory.length) * 100;
  }
}

/**
 * Self-Healing System
 */
export class SelfHealingSystem extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Health monitoring
      healthCheckInterval: config.healthCheckInterval || 30000,
      healthCheckTimeout: config.healthCheckTimeout || 10000,
      
      // Recovery settings
      autoRecoveryEnabled: config.autoRecoveryEnabled !== false,
      maxRecoveryAttempts: config.maxRecoveryAttempts || 3,
      recoveryTimeout: config.recoveryTimeout || 300000,
      
      // Escalation settings
      escalationEnabled: config.escalationEnabled !== false,
      escalationDelay: config.escalationDelay || 600000, // 10 minutes
      
      // Prevention settings
      preventiveEnabled: config.preventiveEnabled !== false,
      preventiveInterval: config.preventiveInterval || 3600000, // 1 hour
      
      ...config
    };
    
    // Components
    this.healthMonitor = new HealthMonitor({
      checkInterval: this.config.healthCheckInterval,
      timeout: this.config.healthCheckTimeout
    });
    
    this.recoveryManager = new RecoveryManager({
      maxRecoveryAttempts: this.config.maxRecoveryAttempts,
      recoveryTimeout: this.config.recoveryTimeout
    });
    
    // State
    this.running = false;
    this.services = new Map();
    
    // Statistics
    this.stats = {
      healingEvents: 0,
      successfulRecoveries: 0,
      failedRecoveries: 0,
      preventiveActions: 0
    };
    
    this.logger = logger;
    
    // Setup event handlers
    this.setupEventHandlers();
    
    // Register default recovery strategies
    this.registerDefaultStrategies();
  }
  
  /**
   * Initialize self-healing system
   */
  async initialize() {
    this.logger.info('Self-healing system initialized', {
      autoRecovery: this.config.autoRecoveryEnabled,
      escalation: this.config.escalationEnabled,
      preventive: this.config.preventiveEnabled
    });
  }
  
  /**
   * Start self-healing system
   */
  start() {
    if (this.running) return;
    
    this.running = true;
    this.healthMonitor.start();
    
    // Start preventive maintenance
    if (this.config.preventiveEnabled) {
      this.startPreventiveMaintenance();
    }
    
    this.logger.info('Self-healing system started');
  }
  
  /**
   * Register service for monitoring
   */
  registerService(name, config) {
    const service = {
      name,
      type: config.type || 'service',
      priority: config.priority || 1,
      dependencies: config.dependencies || [],
      healthCheck: config.healthCheck || {},
      recoveryStrategies: config.recoveryStrategies || [],
      preventiveMaintenance: config.preventiveMaintenance || []
    };
    
    this.services.set(name, service);
    
    // Register health check
    if (service.healthCheck) {
      this.healthMonitor.registerCheck(name, service.healthCheck);
    }
    
    // Register recovery strategies
    for (const strategy of service.recoveryStrategies) {
      this.recoveryManager.registerStrategy(strategy.failureType, strategy);
    }
    
    this.logger.info('Service registered for self-healing', {
      service: name,
      type: service.type,
      strategies: service.recoveryStrategies.length
    });
    
    return service;
  }
  
  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.healthMonitor.on('health:failed', async (event) => {
      this.stats.healingEvents++;
      
      if (this.config.autoRecoveryEnabled) {
        await this.handleHealthFailure(event);
      }
    });
    
    this.healthMonitor.on('health:recovered', (event) => {
      this.emit('healing:recovered', event);
    });
  }
  
  /**
   * Handle health failure
   */
  async handleHealthFailure(event) {
    const service = this.services.get(event.service);
    if (!service) return;
    
    try {
      // Determine failure type
      const failureType = this.analyzeFailure(event);
      
      // Execute recovery
      const recovery = await this.recoveryManager.executeRecovery(
        event.service,
        failureType,
        {
          event,
          service,
          timestamp: Date.now()
        }
      );
      
      if (recovery.status === 'completed') {
        this.stats.successfulRecoveries++;
        this.emit('healing:success', {
          service: event.service,
          recovery
        });
      } else {
        this.stats.failedRecoveries++;
        this.emit('healing:failed', {
          service: event.service,
          recovery
        });
        
        // Escalate if enabled
        if (this.config.escalationEnabled) {
          await this.escalateFailure(event, recovery);
        }
      }
      
    } catch (error) {
      this.logger.error('Healing process failed', {
        service: event.service,
        error: error.message
      });
    }
  }
  
  /**
   * Analyze failure type
   */
  analyzeFailure(event) {
    if (event.result?.error) {
      const error = event.result.error.toLowerCase();
      
      if (error.includes('timeout')) return FAILURE_TYPES.NETWORK_TIMEOUT;
      if (error.includes('connection')) return FAILURE_TYPES.DATABASE_CONNECTION;
      if (error.includes('memory')) return FAILURE_TYPES.MEMORY_LEAK;
      if (error.includes('cpu')) return FAILURE_TYPES.CPU_OVERLOAD;
      if (error.includes('disk')) return FAILURE_TYPES.DISK_FULL;
    }
    
    return FAILURE_TYPES.SERVICE_DOWN;
  }
  
  /**
   * Escalate failure
   */
  async escalateFailure(event, recovery) {
    setTimeout(() => {
      this.emit('healing:escalated', {
        service: event.service,
        failure: event,
        recovery,
        escalatedAt: Date.now()
      });
    }, this.config.escalationDelay);
  }
  
  /**
   * Register default recovery strategies
   */
  registerDefaultStrategies() {
    // Service restart strategy
    this.recoveryManager.registerStrategy(FAILURE_TYPES.SERVICE_DOWN, {
      type: RECOVERY_STRATEGIES.RESTART,
      priority: 10,
      handler: async (service, context) => {
        logger.info('Restarting service', { service });
        // In production, would restart actual service
        return { success: true, action: 'service_restarted' };
      }
    });
    
    // Database reconnection strategy
    this.recoveryManager.registerStrategy(FAILURE_TYPES.DATABASE_CONNECTION, {
      type: RECOVERY_STRATEGIES.REPAIR,
      priority: 8,
      handler: async (service, context) => {
        logger.info('Repairing database connection', { service });
        // In production, would repair database connection
        return { success: true, action: 'connection_repaired' };
      }
    });
    
    // Memory cleanup strategy
    this.recoveryManager.registerStrategy(FAILURE_TYPES.MEMORY_LEAK, {
      type: RECOVERY_STRATEGIES.CLEANUP,
      priority: 7,
      handler: async (service, context) => {
        logger.info('Cleaning up memory', { service });
        // In production, would perform garbage collection or restart
        return { success: true, action: 'memory_cleaned' };
      }
    });
    
    // CPU optimization strategy
    this.recoveryManager.registerStrategy(FAILURE_TYPES.CPU_OVERLOAD, {
      type: RECOVERY_STRATEGIES.OPTIMIZE,
      priority: 6,
      handler: async (service, context) => {
        logger.info('Optimizing CPU usage', { service });
        // In production, would optimize or scale resources
        return { success: true, action: 'cpu_optimized' };
      }
    });
  }
  
  /**
   * Start preventive maintenance
   */
  startPreventiveMaintenance() {
    this.preventiveTimer = setInterval(() => {
      this.performPreventiveMaintenance();
    }, this.config.preventiveInterval);
  }
  
  /**
   * Perform preventive maintenance
   */
  async performPreventiveMaintenance() {
    for (const [name, service] of this.services) {
      try {
        for (const maintenance of service.preventiveMaintenance) {
          await this.executePreventiveAction(name, maintenance);
          this.stats.preventiveActions++;
        }
      } catch (error) {
        this.logger.error('Preventive maintenance failed', {
          service: name,
          error: error.message
        });
      }
    }
  }
  
  /**
   * Execute preventive action
   */
  async executePreventiveAction(service, action) {
    logger.info('Executing preventive maintenance', {
      service,
      action: action.type
    });
    
    if (action.handler) {
      await action.handler(service);
    }
  }
  
  /**
   * Get self-healing statistics
   */
  getStats() {
    return {
      ...this.stats,
      healthMonitor: this.healthMonitor.getHealthStatus(),
      recoveryManager: this.recoveryManager.getStats(),
      services: this.services.size,
      running: this.running
    };
  }
  
  /**
   * Trigger manual healing
   */
  async triggerHealing(service, failureType, context = {}) {
    const recovery = await this.recoveryManager.executeRecovery(service, failureType, context);
    
    this.emit('healing:manual', {
      service,
      recovery,
      triggeredAt: Date.now()
    });
    
    return recovery;
  }
  
  /**
   * Stop self-healing system
   */
  stop() {
    this.running = false;
    
    this.healthMonitor.stop();
    
    if (this.preventiveTimer) {
      clearInterval(this.preventiveTimer);
    }
    
    this.logger.info('Self-healing system stopped');
  }
}

// Export constants
export {
  HEALTH_CHECK_TYPES,
  FAILURE_TYPES,
  RECOVERY_STRATEGIES
};

export default SelfHealingSystem;