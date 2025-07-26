/**
 * Self-Healing Infrastructure - Otedama
 * Automatic detection and recovery from failures
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { spawn } from 'child_process';
import os from 'os';

const logger = createStructuredLogger('SelfHealing');

// Component states
export const ComponentState = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  FAILING: 'failing',
  FAILED: 'failed',
  RECOVERING: 'recovering',
  UNKNOWN: 'unknown'
};

// Healing strategies
export const HealingStrategy = {
  RESTART: 'restart',
  RECONNECT: 'reconnect',
  FAILOVER: 'failover',
  SCALE_UP: 'scale_up',
  ROLLBACK: 'rollback',
  CIRCUIT_BREAK: 'circuit_break',
  CACHE_CLEAR: 'cache_clear',
  RESOURCE_CLEANUP: 'resource_cleanup'
};

export class SelfHealingSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Health check settings
      checkInterval: options.checkInterval || 30000, // 30 seconds
      failureThreshold: options.failureThreshold || 3,
      recoveryThreshold: options.recoveryThreshold || 2,
      
      // Recovery settings
      maxRecoveryAttempts: options.maxRecoveryAttempts || 5,
      recoveryBackoff: options.recoveryBackoff || [5000, 10000, 30000, 60000, 300000],
      cooldownPeriod: options.cooldownPeriod || 300000, // 5 minutes
      
      // Circuit breaker
      circuitBreakerThreshold: options.circuitBreakerThreshold || 5,
      circuitBreakerTimeout: options.circuitBreakerTimeout || 60000,
      
      // Resource management
      memoryThreshold: options.memoryThreshold || 0.9, // 90%
      cpuThreshold: options.cpuThreshold || 0.85, // 85%
      diskThreshold: options.diskThreshold || 0.9, // 90%
      
      // Features
      autoRestart: options.autoRestart !== false,
      autoFailover: options.autoFailover !== false,
      predictiveHealing: options.predictiveHealing !== false,
      
      ...options
    };
    
    // Component registry
    this.components = new Map();
    this.dependencies = new Map();
    
    // Health states
    this.healthStates = new Map();
    this.failureCounts = new Map();
    this.recoveryAttempts = new Map();
    
    // Circuit breakers
    this.circuitBreakers = new Map();
    
    // Recovery queue
    this.recoveryQueue = [];
    this.activeRecoveries = new Map();
    
    // Metrics
    this.metrics = {
      healthChecks: 0,
      failuresDetected: 0,
      recoveriesAttempted: 0,
      recoveriesSuccessful: 0,
      circuitBreaksTriggered: 0
    };
    
    // Timers
    this.healthCheckTimer = null;
    this.recoveryTimer = null;
  }
  
  /**
   * Register a component for monitoring
   */
  registerComponent(name, config) {
    const component = {
      name,
      type: config.type || 'service',
      critical: config.critical || false,
      healthCheck: config.healthCheck,
      recovery: config.recovery || {},
      dependencies: config.dependencies || [],
      metadata: config.metadata || {},
      state: ComponentState.UNKNOWN,
      lastCheck: null,
      lastHealthy: null,
      ...config
    };
    
    this.components.set(name, component);
    
    // Initialize health state
    this.healthStates.set(name, {
      state: ComponentState.UNKNOWN,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastTransition: Date.now()
    });
    
    // Map dependencies
    component.dependencies.forEach(dep => {
      if (!this.dependencies.has(dep)) {
        this.dependencies.set(dep, new Set());
      }
      this.dependencies.get(dep).add(name);
    });
    
    // Initialize circuit breaker if needed
    if (component.circuitBreaker !== false) {
      this.circuitBreakers.set(name, {
        state: 'closed',
        failures: 0,
        lastFailure: null,
        nextRetry: null
      });
    }
    
    logger.info('Component registered', {
      name,
      type: component.type,
      critical: component.critical,
      dependencies: component.dependencies
    });
  }
  
  /**
   * Start self-healing system
   */
  async start() {
    logger.info('Starting self-healing system');
    
    // Initial health check
    await this.performHealthChecks();
    
    // Start periodic health checks
    this.healthCheckTimer = setInterval(async () => {
      await this.performHealthChecks();
    }, this.options.checkInterval);
    
    // Start recovery processor
    this.recoveryTimer = setInterval(() => {
      this.processRecoveryQueue();
    }, 5000);
    
    this.emit('started', {
      components: this.components.size,
      checkInterval: this.options.checkInterval
    });
  }
  
  /**
   * Perform health checks on all components
   */
  async performHealthChecks() {
    const startTime = Date.now();
    const results = new Map();
    
    // Check all components in parallel
    const checks = Array.from(this.components.entries()).map(async ([name, component]) => {
      try {
        const result = await this.checkComponentHealth(component);
        results.set(name, result);
        
        // Update component state
        await this.updateComponentState(component, result);
        
      } catch (error) {
        logger.error('Health check failed', {
          component: name,
          error: error.message
        });
        
        results.set(name, {
          healthy: false,
          state: ComponentState.FAILED,
          error: error.message
        });
      }
    });
    
    await Promise.allSettled(checks);
    
    this.metrics.healthChecks++;
    
    // Check for cascading failures
    this.checkCascadingFailures(results);
    
    // Trigger predictive healing if enabled
    if (this.options.predictiveHealing) {
      await this.performPredictiveHealing(results);
    }
    
    const duration = Date.now() - startTime;
    
    this.emit('health:checked', {
      results: Object.fromEntries(results),
      duration
    });
  }
  
  /**
   * Check individual component health
   */
  async checkComponentHealth(component) {
    // Check circuit breaker first
    if (this.isCircuitOpen(component.name)) {
      return {
        healthy: false,
        state: ComponentState.FAILED,
        reason: 'circuit_breaker_open'
      };
    }
    
    const startTime = Date.now();
    
    try {
      // Execute health check
      const result = await component.healthCheck();
      
      const duration = Date.now() - startTime;
      
      // Determine state based on result
      let state = ComponentState.HEALTHY;
      if (!result.healthy) {
        state = result.critical ? ComponentState.FAILED : ComponentState.DEGRADED;
      }
      
      return {
        healthy: result.healthy,
        state,
        duration,
        details: result.details || {},
        timestamp: Date.now()
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      return {
        healthy: false,
        state: ComponentState.FAILED,
        error: error.message,
        duration,
        timestamp: Date.now()
      };
    }
  }
  
  /**
   * Update component state based on health check
   */
  async updateComponentState(component, result) {
    const name = component.name;
    const healthState = this.healthStates.get(name);
    const previousState = healthState.state;
    
    // Update consecutive counts
    if (result.healthy) {
      healthState.consecutiveFailures = 0;
      healthState.consecutiveSuccesses++;
      
      if (result.healthy && healthState.consecutiveSuccesses >= this.options.recoveryThreshold) {
        healthState.state = ComponentState.HEALTHY;
      }
    } else {
      healthState.consecutiveSuccesses = 0;
      healthState.consecutiveFailures++;
      
      if (healthState.consecutiveFailures >= this.options.failureThreshold) {
        healthState.state = result.state || ComponentState.FAILED;
        this.metrics.failuresDetected++;
      }
    }
    
    // Handle state transitions
    if (previousState !== healthState.state) {
      healthState.lastTransition = Date.now();
      
      logger.info('Component state changed', {
        component: name,
        from: previousState,
        to: healthState.state
      });
      
      this.emit('component:state:changed', {
        component: name,
        previousState,
        newState: healthState.state,
        result
      });
      
      // Trigger recovery if needed
      if (healthState.state === ComponentState.FAILED || 
          healthState.state === ComponentState.DEGRADED) {
        await this.triggerRecovery(component, result);
      }
      
      // Clear recovery attempts on recovery
      if (healthState.state === ComponentState.HEALTHY) {
        this.recoveryAttempts.delete(name);
      }
    }
    
    // Update component
    component.state = healthState.state;
    component.lastCheck = Date.now();
    
    if (result.healthy) {
      component.lastHealthy = Date.now();
    }
  }
  
  /**
   * Trigger recovery for failed component
   */
  async triggerRecovery(component, failureResult) {
    const name = component.name;
    
    // Check if already recovering
    if (this.activeRecoveries.has(name)) {
      logger.debug('Recovery already in progress', { component: name });
      return;
    }
    
    // Check recovery attempts
    const attempts = this.recoveryAttempts.get(name) || 0;
    if (attempts >= this.options.maxRecoveryAttempts) {
      logger.error('Max recovery attempts reached', {
        component: name,
        attempts
      });
      
      this.emit('component:unrecoverable', {
        component: name,
        attempts,
        lastError: failureResult.error
      });
      
      return;
    }
    
    // Determine recovery strategy
    const strategy = this.determineRecoveryStrategy(component, failureResult);
    
    // Add to recovery queue
    this.recoveryQueue.push({
      component,
      strategy,
      failureResult,
      attempts,
      scheduledAt: Date.now()
    });
    
    logger.info('Recovery scheduled', {
      component: name,
      strategy: strategy.type,
      attempt: attempts + 1
    });
  }
  
  /**
   * Determine recovery strategy
   */
  determineRecoveryStrategy(component, failureResult) {
    // Check component-specific recovery config
    if (component.recovery && component.recovery.strategy) {
      return {
        type: component.recovery.strategy,
        params: component.recovery.params || {}
      };
    }
    
    // Determine based on failure type
    const error = failureResult.error || '';
    
    if (error.includes('ECONNREFUSED') || error.includes('ETIMEDOUT')) {
      return { type: HealingStrategy.RECONNECT };
    }
    
    if (error.includes('ENOMEM') || error.includes('memory')) {
      return { type: HealingStrategy.RESOURCE_CLEANUP };
    }
    
    if (component.type === 'process') {
      return { type: HealingStrategy.RESTART };
    }
    
    if (component.type === 'database') {
      return { type: HealingStrategy.RECONNECT };
    }
    
    if (component.replicas && component.replicas.length > 0) {
      return { type: HealingStrategy.FAILOVER };
    }
    
    // Default strategy
    return { type: HealingStrategy.RESTART };
  }
  
  /**
   * Process recovery queue
   */
  async processRecoveryQueue() {
    if (this.recoveryQueue.length === 0) return;
    
    // Process recoveries with backoff
    const now = Date.now();
    const toProcess = [];
    
    this.recoveryQueue = this.recoveryQueue.filter(item => {
      const attempts = this.recoveryAttempts.get(item.component.name) || 0;
      const backoffTime = this.options.recoveryBackoff[
        Math.min(attempts, this.options.recoveryBackoff.length - 1)
      ];
      
      if (now - item.scheduledAt >= backoffTime) {
        toProcess.push(item);
        return false;
      }
      
      return true;
    });
    
    // Execute recoveries
    for (const item of toProcess) {
      await this.executeRecovery(item);
    }
  }
  
  /**
   * Execute recovery action
   */
  async executeRecovery(recoveryItem) {
    const { component, strategy, failureResult, attempts } = recoveryItem;
    const name = component.name;
    
    logger.info('Executing recovery', {
      component: name,
      strategy: strategy.type,
      attempt: attempts + 1
    });
    
    this.activeRecoveries.set(name, {
      strategy,
      startTime: Date.now()
    });
    
    this.metrics.recoveriesAttempted++;
    this.recoveryAttempts.set(name, attempts + 1);
    
    try {
      let success = false;
      
      switch (strategy.type) {
        case HealingStrategy.RESTART:
          success = await this.restartComponent(component);
          break;
          
        case HealingStrategy.RECONNECT:
          success = await this.reconnectComponent(component);
          break;
          
        case HealingStrategy.FAILOVER:
          success = await this.failoverComponent(component);
          break;
          
        case HealingStrategy.SCALE_UP:
          success = await this.scaleUpComponent(component);
          break;
          
        case HealingStrategy.ROLLBACK:
          success = await this.rollbackComponent(component);
          break;
          
        case HealingStrategy.CIRCUIT_BREAK:
          success = await this.circuitBreakComponent(component);
          break;
          
        case HealingStrategy.CACHE_CLEAR:
          success = await this.clearComponentCache(component);
          break;
          
        case HealingStrategy.RESOURCE_CLEANUP:
          success = await this.cleanupResources(component);
          break;
          
        default:
          logger.warn('Unknown recovery strategy', { strategy: strategy.type });
      }
      
      if (success) {
        this.metrics.recoveriesSuccessful++;
        
        logger.info('Recovery successful', {
          component: name,
          strategy: strategy.type
        });
        
        this.emit('component:recovered', {
          component: name,
          strategy: strategy.type,
          attempts: attempts + 1
        });
        
        // Reset circuit breaker
        this.resetCircuitBreaker(name);
        
      } else {
        throw new Error('Recovery failed');
      }
      
    } catch (error) {
      logger.error('Recovery failed', {
        component: name,
        strategy: strategy.type,
        error: error.message
      });
      
      // Update circuit breaker
      this.recordCircuitBreakerFailure(name);
      
      this.emit('recovery:failed', {
        component: name,
        strategy: strategy.type,
        error: error.message,
        attempts: attempts + 1
      });
      
    } finally {
      this.activeRecoveries.delete(name);
    }
  }
  
  /**
   * Recovery strategies implementation
   */
  
  async restartComponent(component) {
    logger.info('Restarting component', { name: component.name });
    
    if (component.restart) {
      return await component.restart();
    }
    
    // Default restart logic for processes
    if (component.type === 'process' && component.pid) {
      try {
        // Kill process
        process.kill(component.pid, 'SIGTERM');
        
        // Wait for termination
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Start new process
        const proc = spawn(component.command, component.args || [], {
          detached: true,
          stdio: 'ignore'
        });
        
        component.pid = proc.pid;
        
        return true;
      } catch (error) {
        logger.error('Process restart failed', { error: error.message });
        return false;
      }
    }
    
    return false;
  }
  
  async reconnectComponent(component) {
    logger.info('Reconnecting component', { name: component.name });
    
    if (component.reconnect) {
      return await component.reconnect();
    }
    
    // Default reconnection for databases
    if (component.type === 'database' && component.connection) {
      try {
        await component.connection.close();
        await new Promise(resolve => setTimeout(resolve, 1000));
        await component.connection.connect();
        return true;
      } catch (error) {
        logger.error('Reconnection failed', { error: error.message });
        return false;
      }
    }
    
    return false;
  }
  
  async failoverComponent(component) {
    logger.info('Failing over component', { name: component.name });
    
    if (component.failover) {
      return await component.failover();
    }
    
    // Default failover logic
    if (component.replicas && component.replicas.length > 0) {
      const activeReplica = component.replicas.find(r => r.state === 'active');
      const standbyReplica = component.replicas.find(r => r.state === 'standby');
      
      if (activeReplica && standbyReplica) {
        try {
          // Promote standby
          standbyReplica.state = 'active';
          activeReplica.state = 'failed';
          
          // Switch traffic
          if (component.switchTraffic) {
            await component.switchTraffic(standbyReplica);
          }
          
          return true;
        } catch (error) {
          logger.error('Failover failed', { error: error.message });
          return false;
        }
      }
    }
    
    return false;
  }
  
  async scaleUpComponent(component) {
    logger.info('Scaling up component', { name: component.name });
    
    if (component.scaleUp) {
      return await component.scaleUp();
    }
    
    return false;
  }
  
  async rollbackComponent(component) {
    logger.info('Rolling back component', { name: component.name });
    
    if (component.rollback) {
      return await component.rollback();
    }
    
    return false;
  }
  
  async circuitBreakComponent(component) {
    logger.info('Circuit breaking component', { name: component.name });
    
    const circuitBreaker = this.circuitBreakers.get(component.name);
    if (circuitBreaker) {
      circuitBreaker.state = 'open';
      circuitBreaker.nextRetry = Date.now() + this.options.circuitBreakerTimeout;
      this.metrics.circuitBreaksTriggered++;
    }
    
    return true;
  }
  
  async clearComponentCache(component) {
    logger.info('Clearing component cache', { name: component.name });
    
    if (component.clearCache) {
      return await component.clearCache();
    }
    
    return false;
  }
  
  async cleanupResources(component) {
    logger.info('Cleaning up resources', { name: component.name });
    
    try {
      // Trigger garbage collection if available
      if (global.gc) {
        global.gc();
      }
      
      // Component-specific cleanup
      if (component.cleanup) {
        await component.cleanup();
      }
      
      return true;
    } catch (error) {
      logger.error('Resource cleanup failed', { error: error.message });
      return false;
    }
  }
  
  /**
   * Check for cascading failures
   */
  checkCascadingFailures(results) {
    const failedComponents = new Set();
    
    // Identify failed components
    for (const [name, result] of results) {
      if (!result.healthy) {
        failedComponents.add(name);
      }
    }
    
    // Check dependencies
    const cascadingFailures = new Set();
    
    for (const failed of failedComponents) {
      const dependents = this.dependencies.get(failed);
      if (dependents) {
        for (const dependent of dependents) {
          if (!failedComponents.has(dependent)) {
            cascadingFailures.add(dependent);
          }
        }
      }
    }
    
    if (cascadingFailures.size > 0) {
      logger.warn('Cascading failures detected', {
        failed: Array.from(failedComponents),
        affected: Array.from(cascadingFailures)
      });
      
      this.emit('cascading:failure', {
        failed: Array.from(failedComponents),
        affected: Array.from(cascadingFailures)
      });
    }
  }
  
  /**
   * Perform predictive healing
   */
  async performPredictiveHealing(results) {
    // Analyze trends
    for (const [name, component] of this.components) {
      const result = results.get(name);
      if (!result || !result.healthy) continue;
      
      // Check resource usage trends
      if (result.details) {
        const { cpu, memory, disk } = result.details;
        
        // Predict resource exhaustion
        if (memory && memory.usage > this.options.memoryThreshold * 0.8) {
          logger.warn('Memory usage trending high', {
            component: name,
            usage: memory.usage
          });
          
          // Proactive cleanup
          await this.cleanupResources(component);
        }
        
        if (cpu && cpu.usage > this.options.cpuThreshold * 0.8) {
          logger.warn('CPU usage trending high', {
            component: name,
            usage: cpu.usage
          });
          
          // Consider scaling
          if (component.scalable) {
            await this.scaleUpComponent(component);
          }
        }
      }
      
      // Check error rate trends
      if (result.details && result.details.errorRate > 0.05) {
        logger.warn('Error rate trending high', {
          component: name,
          errorRate: result.details.errorRate
        });
        
        // Preemptive circuit breaker
        this.recordCircuitBreakerFailure(name);
      }
    }
  }
  
  /**
   * Circuit breaker management
   */
  
  isCircuitOpen(componentName) {
    const breaker = this.circuitBreakers.get(componentName);
    if (!breaker) return false;
    
    if (breaker.state === 'open') {
      // Check if ready to retry
      if (Date.now() >= breaker.nextRetry) {
        breaker.state = 'half-open';
        return false;
      }
      return true;
    }
    
    return false;
  }
  
  recordCircuitBreakerFailure(componentName) {
    const breaker = this.circuitBreakers.get(componentName);
    if (!breaker) return;
    
    breaker.failures++;
    breaker.lastFailure = Date.now();
    
    if (breaker.failures >= this.options.circuitBreakerThreshold) {
      breaker.state = 'open';
      breaker.nextRetry = Date.now() + this.options.circuitBreakerTimeout;
      
      logger.warn('Circuit breaker opened', {
        component: componentName,
        failures: breaker.failures
      });
      
      this.emit('circuit:opened', {
        component: componentName,
        failures: breaker.failures
      });
    }
  }
  
  resetCircuitBreaker(componentName) {
    const breaker = this.circuitBreakers.get(componentName);
    if (!breaker) return;
    
    breaker.state = 'closed';
    breaker.failures = 0;
    breaker.lastFailure = null;
    breaker.nextRetry = null;
    
    logger.info('Circuit breaker reset', { component: componentName });
  }
  
  /**
   * Get system health report
   */
  getHealthReport() {
    const report = {
      overall: ComponentState.HEALTHY,
      components: {},
      issues: [],
      metrics: this.metrics
    };
    
    // Compile component states
    for (const [name, component] of this.components) {
      const healthState = this.healthStates.get(name);
      const circuitBreaker = this.circuitBreakers.get(name);
      
      report.components[name] = {
        state: healthState.state,
        type: component.type,
        critical: component.critical,
        lastCheck: component.lastCheck,
        lastHealthy: component.lastHealthy,
        circuitBreaker: circuitBreaker ? circuitBreaker.state : 'none',
        recoveryAttempts: this.recoveryAttempts.get(name) || 0
      };
      
      // Update overall state
      if (healthState.state === ComponentState.FAILED && component.critical) {
        report.overall = ComponentState.FAILED;
      } else if (healthState.state === ComponentState.DEGRADED && 
                 report.overall !== ComponentState.FAILED) {
        report.overall = ComponentState.DEGRADED;
      }
      
      // Collect issues
      if (healthState.state !== ComponentState.HEALTHY) {
        report.issues.push({
          component: name,
          state: healthState.state,
          duration: Date.now() - healthState.lastTransition
        });
      }
    }
    
    return report;
  }
  
  /**
   * Get recovery status
   */
  getRecoveryStatus() {
    return {
      activeRecoveries: Array.from(this.activeRecoveries.entries()).map(([name, recovery]) => ({
        component: name,
        strategy: recovery.strategy.type,
        duration: Date.now() - recovery.startTime
      })),
      queuedRecoveries: this.recoveryQueue.map(item => ({
        component: item.component.name,
        strategy: item.strategy.type,
        attempts: item.attempts,
        scheduledIn: item.scheduledAt + this.options.recoveryBackoff[item.attempts] - Date.now()
      })),
      recoveryAttempts: Object.fromEntries(this.recoveryAttempts)
    };
  }
  
  /**
   * Manual component recovery
   */
  async recoverComponent(componentName, strategy) {
    const component = this.components.get(componentName);
    if (!component) {
      throw new Error(`Component ${componentName} not found`);
    }
    
    logger.info('Manual recovery triggered', {
      component: componentName,
      strategy: strategy || 'auto'
    });
    
    const recoveryStrategy = strategy ? 
      { type: strategy } : 
      this.determineRecoveryStrategy(component, {});
    
    await this.executeRecovery({
      component,
      strategy: recoveryStrategy,
      failureResult: {},
      attempts: this.recoveryAttempts.get(componentName) || 0
    });
  }
  
  /**
   * Stop self-healing system
   */
  async stop() {
    logger.info('Stopping self-healing system');
    
    // Clear timers
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
    }
    
    // Wait for active recoveries
    const timeout = 30000;
    const startTime = Date.now();
    
    while (this.activeRecoveries.size > 0 && Date.now() - startTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    this.emit('stopped', {
      metrics: this.metrics,
      activeRecoveries: this.activeRecoveries.size
    });
  }
}

export default SelfHealingSystem;