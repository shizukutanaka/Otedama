/**
 * Stability Manager for Otedama
 * Advanced error handling, recovery, and system stability management
 */

import { EventEmitter } from 'events';
import { getErrorHandler, OtedamaError, ErrorCategory } from './error-handler.js';
import { createHash } from 'crypto';

// Recovery strategies
export const RecoveryStrategy = {
  RETRY: 'retry',
  CIRCUIT_BREAKER: 'circuit_breaker',
  FALLBACK: 'fallback',
  GRACEFUL_DEGRADATION: 'graceful_degradation',
  AUTOMATIC_RESTART: 'automatic_restart',
  MANUAL_INTERVENTION: 'manual_intervention'
};

// System health states
export const HealthState = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  CRITICAL: 'critical',
  FAILING: 'failing',
  OFFLINE: 'offline'
};

// Component types
export const ComponentType = {
  DATABASE: 'database',
  P2P_NETWORK: 'p2p_network',
  MINING_POOL: 'mining_pool',
  DEX: 'dex',
  WEBSOCKET: 'websocket',
  API: 'api',
  CACHE: 'cache',
  EXTERNAL_API: 'external_api'
};

export class StabilityManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      // Health check intervals
      healthCheckInterval: options.healthCheckInterval || 30000, // 30 seconds
      detailedHealthCheckInterval: options.detailedHealthCheckInterval || 300000, // 5 minutes
      
      // Recovery settings
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      exponentialBackoff: options.exponentialBackoff !== false,
      
      // Circuit breaker settings
      circuitBreakerThreshold: options.circuitBreakerThreshold || 5,
      circuitBreakerTimeout: options.circuitBreakerTimeout || 60000,
      circuitBreakerHalfOpenAttempts: options.circuitBreakerHalfOpenAttempts || 3,
      
      // Auto-recovery settings
      enableAutoRecovery: options.enableAutoRecovery !== false,
      autoRestartThreshold: options.autoRestartThreshold || 10,
      gracefulShutdownTimeout: options.gracefulShutdownTimeout || 30000,
      
      // Monitoring settings
      enableMetrics: options.enableMetrics !== false,
      metricsRetentionPeriod: options.metricsRetentionPeriod || 86400000, // 24 hours
      
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    
    // System components registry
    this.components = new Map();
    
    // Health status
    this.healthStatus = {
      overall: HealthState.HEALTHY,
      components: new Map(),
      lastCheck: Date.now(),
      issues: []
    };
    
    // Error tracking
    this.errorStats = {
      totalErrors: 0,
      errorsByType: new Map(),
      errorsByComponent: new Map(),
      recentErrors: [],
      patterns: new Map()
    };
    
    // Circuit breakers
    this.circuitBreakers = new Map();
    
    // Recovery attempts
    this.recoveryAttempts = new Map();
    
    // Stability metrics
    this.metrics = {
      uptime: Date.now(),
      downtime: 0,
      mtbf: 0, // Mean Time Between Failures
      mttr: 0, // Mean Time To Recovery
      availability: 1.0,
      reliability: 1.0,
      lastFailure: null,
      lastRecovery: null
    };
    
    // Initialize stability management
    this.initialize();
  }
  
  /**
   * Initialize stability manager
   */
  async initialize() {
    // Start health monitoring
    this.startHealthMonitoring();
    
    // Setup error pattern detection
    this.setupErrorPatternDetection();
    
    // Register default components
    this.registerDefaultComponents();
    
    // Setup graceful shutdown
    this.setupGracefulShutdown();
    
    this.emit('initialized', {
      timestamp: Date.now(),
      healthStatus: this.healthStatus
    });
  }
  
  /**
   * Register a system component
   */
  registerComponent(name, type, healthCheck, options = {}) {
    const component = {
      name,
      type,
      healthCheck,
      state: HealthState.HEALTHY,
      lastCheck: Date.now(),
      errorCount: 0,
      consecutiveErrors: 0,
      options: {
        criticalComponent: options.criticalComponent || false,
        maxErrors: options.maxErrors || 5,
        timeout: options.timeout || 10000,
        ...options
      }
    };
    
    this.components.set(name, component);
    this.healthStatus.components.set(name, HealthState.HEALTHY);
    
    // Initialize circuit breaker
    if (options.enableCircuitBreaker !== false) {
      this.initializeCircuitBreaker(name);
    }
    
    this.emit('component:registered', {
      name,
      type,
      timestamp: Date.now()
    });
  }
  
  /**
   * Initialize circuit breaker for component
   */
  initializeCircuitBreaker(componentName) {
    this.circuitBreakers.set(componentName, {
      state: 'closed', // closed, open, half-open
      errorCount: 0,
      lastFailure: null,
      nextAttempt: Date.now(),
      successCount: 0
    });
  }
  
  /**
   * Register default system components
   */
  registerDefaultComponents() {
    // Database component
    this.registerComponent('database', ComponentType.DATABASE, async () => {
      // Database health check would be implemented here
      return { healthy: true, latency: 10 };
    }, { criticalComponent: true });
    
    // P2P network component
    this.registerComponent('p2p_network', ComponentType.P2P_NETWORK, async () => {
      // P2P network health check would be implemented here
      return { healthy: true, peers: 10 };
    });
    
    // Mining pool component
    this.registerComponent('mining_pool', ComponentType.MINING_POOL, async () => {
      // Mining pool health check would be implemented here
      return { healthy: true, hashrate: 1000000 };
    });
    
    // DEX component
    this.registerComponent('dex', ComponentType.DEX, async () => {
      // DEX health check would be implemented here
      return { healthy: true, orderBook: 'active' };
    });
  }
  
  /**
   * Start health monitoring
   */
  startHealthMonitoring() {
    // Regular health checks
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.options.healthCheckInterval);
    
    // Detailed health checks
    this.detailedHealthCheckInterval = setInterval(() => {
      this.performDetailedHealthCheck();
    }, this.options.detailedHealthCheckInterval);
    
    // Cleanup old metrics
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldMetrics();
    }, 3600000); // Every hour
  }
  
  /**
   * Perform basic health check
   */
  async performHealthCheck() {
    const startTime = Date.now();
    const issues = [];
    
    for (const [name, component] of this.components) {
      try {
        // Check circuit breaker
        if (this.isCircuitBreakerOpen(name)) {
          continue;
        }
        
        // Perform health check with timeout
        const result = await this.timeoutPromise(
          component.healthCheck(),
          component.options.timeout
        );
        
        if (result.healthy) {
          this.handleHealthyComponent(name, component);
        } else {
          issues.push(this.handleUnhealthyComponent(name, component, result));
        }
        
      } catch (error) {
        issues.push(this.handleComponentError(name, component, error));
      }
    }
    
    // Update overall health status
    this.updateOverallHealthStatus(issues);
    
    // Update metrics
    this.updateHealthMetrics(Date.now() - startTime);
    
    this.emit('health:check', {
      timestamp: Date.now(),
      duration: Date.now() - startTime,
      status: this.healthStatus.overall,
      issues
    });
  }
  
  /**
   * Handle healthy component
   */
  handleHealthyComponent(name, component) {
    component.state = HealthState.HEALTHY;
    component.consecutiveErrors = 0;
    component.lastCheck = Date.now();
    
    this.healthStatus.components.set(name, HealthState.HEALTHY);
    
    // Reset circuit breaker if applicable
    const breaker = this.circuitBreakers.get(name);
    if (breaker && breaker.state === 'half-open') {
      breaker.successCount++;
      if (breaker.successCount >= this.options.circuitBreakerHalfOpenAttempts) {
        breaker.state = 'closed';
        breaker.errorCount = 0;
        this.emit('circuit_breaker:closed', { component: name });
      }
    }
  }
  
  /**
   * Handle unhealthy component
   */
  handleUnhealthyComponent(name, component, result) {
    component.consecutiveErrors++;
    component.errorCount++;
    component.lastCheck = Date.now();
    
    const severity = this.determineSeverity(component, result);
    component.state = severity;
    
    this.healthStatus.components.set(name, severity);
    
    // Update circuit breaker
    this.updateCircuitBreaker(name, false);
    
    // Attempt recovery if enabled
    if (this.options.enableAutoRecovery) {
      this.attemptRecovery(name, component, result);
    }
    
    return {
      component: name,
      severity,
      issue: result.error || 'Health check failed',
      timestamp: Date.now()
    };
  }
  
  /**
   * Handle component error
   */
  handleComponentError(name, component, error) {
    component.consecutiveErrors++;
    component.errorCount++;
    component.lastCheck = Date.now();
    component.state = HealthState.CRITICAL;
    
    this.healthStatus.components.set(name, HealthState.CRITICAL);
    
    // Update circuit breaker
    this.updateCircuitBreaker(name, false);
    
    // Track error
    this.trackError(error, name);
    
    // Attempt recovery if enabled
    if (this.options.enableAutoRecovery) {
      this.attemptRecovery(name, component, { error });
    }
    
    return {
      component: name,
      severity: HealthState.CRITICAL,
      issue: error.message,
      timestamp: Date.now()
    };
  }
  
  /**
   * Determine severity level
   */
  determineSeverity(component, result) {
    if (component.consecutiveErrors >= component.options.maxErrors) {
      return HealthState.CRITICAL;
    } else if (component.consecutiveErrors >= component.options.maxErrors / 2) {
      return HealthState.DEGRADED;
    } else {
      return HealthState.FAILING;
    }
  }
  
  /**
   * Update circuit breaker state
   */
  updateCircuitBreaker(componentName, success) {
    const breaker = this.circuitBreakers.get(componentName);
    if (!breaker) return;
    
    if (success) {
      breaker.errorCount = 0;
      if (breaker.state === 'half-open') {
        breaker.successCount++;
      }
    } else {
      breaker.errorCount++;
      breaker.lastFailure = Date.now();
      
      if (breaker.errorCount >= this.options.circuitBreakerThreshold) {
        breaker.state = 'open';
        breaker.nextAttempt = Date.now() + this.options.circuitBreakerTimeout;
        this.emit('circuit_breaker:opened', { component: componentName });
      }
    }
  }
  
  /**
   * Check if circuit breaker is open
   */
  isCircuitBreakerOpen(componentName) {
    const breaker = this.circuitBreakers.get(componentName);
    if (!breaker) return false;
    
    if (breaker.state === 'open') {
      if (Date.now() >= breaker.nextAttempt) {
        breaker.state = 'half-open';
        breaker.successCount = 0;
        this.emit('circuit_breaker:half_open', { component: componentName });
        return false;
      }
      return true;
    }
    
    return false;
  }
  
  /**
   * Attempt component recovery
   */
  async attemptRecovery(componentName, component, issue) {
    const recoveryKey = `${componentName}:${Date.now()}`;
    
    if (this.recoveryAttempts.has(componentName)) {
      const lastAttempt = this.recoveryAttempts.get(componentName);
      if (Date.now() - lastAttempt.timestamp < 60000) { // 1 minute cooldown
        return;
      }
    }
    
    this.recoveryAttempts.set(componentName, {
      timestamp: Date.now(),
      attempts: (this.recoveryAttempts.get(componentName)?.attempts || 0) + 1
    });
    
    try {
      const strategy = this.getRecoveryStrategy(component.type);
      const result = await strategy(componentName, component, issue);
      
      if (result.success) {
        this.emit('recovery:success', {
          component: componentName,
          strategy: result.strategy,
          timestamp: Date.now()
        });
        
        this.metrics.lastRecovery = Date.now();
        this.calculateMTTR();
      } else {
        this.emit('recovery:failed', {
          component: componentName,
          error: result.error,
          timestamp: Date.now()
        });
      }
      
    } catch (error) {
      this.emit('recovery:error', {
        component: componentName,
        error: error.message,
        timestamp: Date.now()
      });
    }
  }
  
  /**
   * Get recovery strategy for component type
   */
  getRecoveryStrategy(componentType) {
    const strategies = {
      [ComponentType.DATABASE]: this.recoverDatabase.bind(this),
      [ComponentType.P2P_NETWORK]: this.recoverP2PNetwork.bind(this),
      [ComponentType.MINING_POOL]: this.recoverMiningPool.bind(this),
      [ComponentType.DEX]: this.recoverDEX.bind(this),
      [ComponentType.WEBSOCKET]: this.recoverWebSocket.bind(this),
      [ComponentType.API]: this.recoverAPI.bind(this),
      [ComponentType.CACHE]: this.recoverCache.bind(this),
      [ComponentType.EXTERNAL_API]: this.recoverExternalAPI.bind(this)
    };
    
    return strategies[componentType] || this.defaultRecoveryStrategy.bind(this);
  }
  
  /**
   * Database recovery strategy
   */
  async recoverDatabase(componentName, component, issue) {
    try {
      // Attempt connection pool refresh
      // This would integrate with the database optimizer
      return { success: true, strategy: 'connection_pool_refresh' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * P2P network recovery strategy
   */
  async recoverP2PNetwork(componentName, component, issue) {
    try {
      // Attempt peer reconnection
      // This would integrate with the P2P controller
      return { success: true, strategy: 'peer_reconnection' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Mining pool recovery strategy
   */
  async recoverMiningPool(componentName, component, issue) {
    try {
      // Attempt work distribution restart
      return { success: true, strategy: 'work_distribution_restart' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * DEX recovery strategy
   */
  async recoverDEX(componentName, component, issue) {
    try {
      // Attempt order book reconstruction
      return { success: true, strategy: 'order_book_reconstruction' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * WebSocket recovery strategy
   */
  async recoverWebSocket(componentName, component, issue) {
    try {
      // Attempt WebSocket reconnection
      return { success: true, strategy: 'websocket_reconnection' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * API recovery strategy
   */
  async recoverAPI(componentName, component, issue) {
    try {
      // Attempt API endpoint restart
      return { success: true, strategy: 'api_restart' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Cache recovery strategy
   */
  async recoverCache(componentName, component, issue) {
    try {
      // Attempt cache invalidation and refresh
      return { success: true, strategy: 'cache_refresh' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * External API recovery strategy
   */
  async recoverExternalAPI(componentName, component, issue) {
    try {
      // Attempt fallback to alternative API
      return { success: true, strategy: 'fallback_api' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Default recovery strategy
   */
  async defaultRecoveryStrategy(componentName, component, issue) {
    try {
      // Generic recovery attempt
      return { success: true, strategy: 'generic_restart' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Update overall health status
   */
  updateOverallHealthStatus(issues) {
    if (issues.length === 0) {
      this.healthStatus.overall = HealthState.HEALTHY;
    } else {
      const criticalIssues = issues.filter(i => i.severity === HealthState.CRITICAL);
      const degradedIssues = issues.filter(i => i.severity === HealthState.DEGRADED);
      
      if (criticalIssues.length > 0) {
        // Check if any critical component is failing
        const criticalComponents = criticalIssues.filter(issue => {
          const component = this.components.get(issue.component);
          return component?.options.criticalComponent;
        });
        
        if (criticalComponents.length > 0) {
          this.healthStatus.overall = HealthState.CRITICAL;
        } else {
          this.healthStatus.overall = HealthState.FAILING;
        }
      } else if (degradedIssues.length > 0) {
        this.healthStatus.overall = HealthState.DEGRADED;
      } else {
        this.healthStatus.overall = HealthState.FAILING;
      }
    }
    
    this.healthStatus.lastCheck = Date.now();
    this.healthStatus.issues = issues;
  }
  
  /**
   * Track error for pattern detection
   */
  trackError(error, componentName) {
    this.errorStats.totalErrors++;
    
    // Track by type
    const errorType = error.category || 'unknown';
    this.errorStats.errorsByType.set(
      errorType,
      (this.errorStats.errorsByType.get(errorType) || 0) + 1
    );
    
    // Track by component
    this.errorStats.errorsByComponent.set(
      componentName,
      (this.errorStats.errorsByComponent.get(componentName) || 0) + 1
    );
    
    // Track recent errors
    this.errorStats.recentErrors.push({
      error: error.message,
      component: componentName,
      timestamp: Date.now()
    });
    
    // Keep only last 100 errors
    if (this.errorStats.recentErrors.length > 100) {
      this.errorStats.recentErrors.shift();
    }
    
    // Update metrics
    this.metrics.lastFailure = Date.now();
    this.calculateMTBF();
  }
  
  /**
   * Setup error pattern detection
   */
  setupErrorPatternDetection() {
    setInterval(() => {
      this.detectErrorPatterns();
    }, 300000); // Every 5 minutes
  }
  
  /**
   * Detect error patterns
   */
  detectErrorPatterns() {
    const recentErrors = this.errorStats.recentErrors
      .filter(e => Date.now() - e.timestamp < 3600000); // Last hour
    
    if (recentErrors.length < 5) return;
    
    // Detect cascading failures
    const cascadingFailures = this.detectCascadingFailures(recentErrors);
    if (cascadingFailures.length > 0) {
      this.emit('pattern:cascading_failures', {
        failures: cascadingFailures,
        timestamp: Date.now()
      });
    }
    
    // Detect periodic failures
    const periodicFailures = this.detectPeriodicFailures(recentErrors);
    if (periodicFailures.length > 0) {
      this.emit('pattern:periodic_failures', {
        failures: periodicFailures,
        timestamp: Date.now()
      });
    }
  }
  
  /**
   * Detect cascading failures
   */
  detectCascadingFailures(errors) {
    const cascades = [];
    const timeWindow = 60000; // 1 minute
    
    for (let i = 0; i < errors.length - 1; i++) {
      const current = errors[i];
      const next = errors[i + 1];
      
      if (next.timestamp - current.timestamp < timeWindow) {
        cascades.push({
          primary: current,
          secondary: next,
          timeDiff: next.timestamp - current.timestamp
        });
      }
    }
    
    return cascades;
  }
  
  /**
   * Detect periodic failures
   */
  detectPeriodicFailures(errors) {
    const periodic = [];
    const componentErrors = new Map();
    
    // Group errors by component
    for (const error of errors) {
      if (!componentErrors.has(error.component)) {
        componentErrors.set(error.component, []);
      }
      componentErrors.get(error.component).push(error);
    }
    
    // Check for periodicity
    for (const [component, errorList] of componentErrors) {
      if (errorList.length < 3) continue;
      
      const intervals = [];
      for (let i = 1; i < errorList.length; i++) {
        intervals.push(errorList[i].timestamp - errorList[i - 1].timestamp);
      }
      
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const variance = intervals.reduce((acc, val) => acc + Math.pow(val - avgInterval, 2), 0) / intervals.length;
      
      if (variance < avgInterval * 0.1) { // Low variance indicates periodicity
        periodic.push({
          component,
          interval: avgInterval,
          confidence: 1 - (variance / avgInterval)
        });
      }
    }
    
    return periodic;
  }
  
  /**
   * Calculate Mean Time Between Failures
   */
  calculateMTBF() {
    if (this.errorStats.totalErrors < 2) return;
    
    const uptime = Date.now() - this.metrics.uptime;
    this.metrics.mtbf = uptime / this.errorStats.totalErrors;
  }
  
  /**
   * Calculate Mean Time To Recovery
   */
  calculateMTTR() {
    if (!this.metrics.lastFailure || !this.metrics.lastRecovery) return;
    
    const recoveryTime = this.metrics.lastRecovery - this.metrics.lastFailure;
    this.metrics.mttr = recoveryTime;
  }
  
  /**
   * Setup graceful shutdown
   */
  setupGracefulShutdown() {
    const gracefulShutdown = async (signal) => {
      this.emit('shutdown:starting', { signal, timestamp: Date.now() });
      
      // Stop health monitoring
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
      }
      if (this.detailedHealthCheckInterval) {
        clearInterval(this.detailedHealthCheckInterval);
      }
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
      }
      
      // Close circuit breakers
      for (const [name, breaker] of this.circuitBreakers) {
        breaker.state = 'closed';
      }
      
      this.emit('shutdown:completed', { signal, timestamp: Date.now() });
      
      // Exit after timeout
      setTimeout(() => {
        process.exit(0);
      }, this.options.gracefulShutdownTimeout);
    };
    
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
  }
  
  /**
   * Get current health status
   */
  getHealthStatus() {
    return {
      ...this.healthStatus,
      metrics: this.metrics,
      errorStats: this.errorStats
    };
  }
  
  /**
   * Utility: Promise with timeout
   */
  timeoutPromise(promise, timeout) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Health check timeout')), timeout);
      })
    ]);
  }
  
  /**
   * Cleanup old metrics
   */
  cleanupOldMetrics() {
    const cutoff = Date.now() - this.options.metricsRetentionPeriod;
    
    // Clean up recent errors
    this.errorStats.recentErrors = this.errorStats.recentErrors
      .filter(e => e.timestamp > cutoff);
    
    // Clean up recovery attempts
    for (const [key, attempt] of this.recoveryAttempts) {
      if (attempt.timestamp < cutoff) {
        this.recoveryAttempts.delete(key);
      }
    }
  }
  
  /**
   * Perform detailed health check
   */
  async performDetailedHealthCheck() {
    const startTime = Date.now();
    
    // Generate detailed health report
    const report = {
      timestamp: Date.now(),
      overall: this.healthStatus.overall,
      components: {},
      metrics: this.metrics,
      errorStats: this.errorStats,
      circuitBreakers: {},
      recommendations: []
    };
    
    // Component details
    for (const [name, component] of this.components) {
      report.components[name] = {
        state: component.state,
        errorCount: component.errorCount,
        consecutiveErrors: component.consecutiveErrors,
        lastCheck: component.lastCheck
      };
    }
    
    // Circuit breaker details
    for (const [name, breaker] of this.circuitBreakers) {
      report.circuitBreakers[name] = {
        state: breaker.state,
        errorCount: breaker.errorCount,
        lastFailure: breaker.lastFailure
      };
    }
    
    // Generate recommendations
    report.recommendations = this.generateRecommendations();
    
    this.emit('health:detailed_report', report);
    
    return report;
  }
  
  /**
   * Generate health recommendations
   */
  generateRecommendations() {
    const recommendations = [];
    
    // Check for frequently failing components
    for (const [name, component] of this.components) {
      if (component.errorCount > 10) {
        recommendations.push({
          type: 'component_instability',
          component: name,
          severity: 'high',
          message: `Component ${name} has ${component.errorCount} errors. Consider investigation.`
        });
      }
    }
    
    // Check for open circuit breakers
    for (const [name, breaker] of this.circuitBreakers) {
      if (breaker.state === 'open') {
        recommendations.push({
          type: 'circuit_breaker_open',
          component: name,
          severity: 'medium',
          message: `Circuit breaker for ${name} is open. Service may be unavailable.`
        });
      }
    }
    
    // Check overall error rate
    if (this.errorStats.totalErrors > 100) {
      recommendations.push({
        type: 'high_error_rate',
        severity: 'high',
        message: 'System has high error rate. Consider system-wide investigation.'
      });
    }
    
    return recommendations;
  }
  
  /**
   * Update health metrics
   */
  updateHealthMetrics(checkDuration) {
    this.metrics.availability = this.calculateAvailability();
    this.metrics.reliability = this.calculateReliability();
  }
  
  /**
   * Calculate system availability
   */
  calculateAvailability() {
    const totalTime = Date.now() - this.metrics.uptime;
    const availableTime = totalTime - this.metrics.downtime;
    return availableTime / totalTime;
  }
  
  /**
   * Calculate system reliability
   */
  calculateReliability() {
    if (this.errorStats.totalErrors === 0) return 1.0;
    
    const totalOperations = this.errorStats.totalErrors + 1000; // Estimate successful operations
    return (totalOperations - this.errorStats.totalErrors) / totalOperations;
  }
}

export default StabilityManager;