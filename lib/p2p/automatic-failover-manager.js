/**
 * Automatic Failover Manager for Otedama P2P Pool
 * Intelligent failover and recovery system
 * 
 * Design principles:
 * - Carmack: Zero-downtime failover with minimal latency
 * - Martin: Clean separation of failover strategies
 * - Pike: Simple but robust recovery mechanisms
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import crypto from 'crypto';

const logger = createStructuredLogger('AutomaticFailoverManager');

/**
 * Failover strategies
 */
const FAILOVER_STRATEGIES = {
  IMMEDIATE: 'immediate',         // Switch immediately on failure
  GRACEFUL: 'graceful',          // Wait for current operations to complete
  WEIGHTED: 'weighted',          // Choose based on node weights
  GEOGRAPHIC: 'geographic',      // Prefer geographically close nodes
  ADAPTIVE: 'adaptive'           // Learn from past failures
};

/**
 * Node health states
 */
const HEALTH_STATES = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  FAILED: 'failed',
  RECOVERING: 'recovering'
};

/**
 * Recovery actions
 */
const RECOVERY_ACTIONS = {
  RESTART: 'restart',
  RECONNECT: 'reconnect',
  RECONFIGURE: 'reconfigure',
  REPLACE: 'replace',
  ESCALATE: 'escalate'
};

/**
 * Health monitor for individual components
 */
class HealthMonitor {
  constructor(componentId, config = {}) {
    this.componentId = componentId;
    this.config = {
      checkInterval: config.checkInterval || 5000, // 5 seconds
      failureThreshold: config.failureThreshold || 3,
      recoveryThreshold: config.recoveryThreshold || 5,
      timeout: config.timeout || 3000,
      ...config
    };
    
    this.state = HEALTH_STATES.HEALTHY;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.lastCheck = Date.now();
    this.lastFailure = null;
    
    this.metrics = {
      totalChecks: 0,
      failures: 0,
      recoveries: 0,
      uptime: 0,
      downtime: 0,
      availability: 1.0
    };
    
    this.history = []; // Recent health check results
    this.maxHistory = 100;
  }
  
  /**
   * Perform health check
   */
  async check(checkFunction) {
    const startTime = Date.now();
    let result = {
      success: false,
      latency: 0,
      error: null,
      timestamp: startTime
    };
    
    try {
      // Execute health check with timeout
      const checkPromise = checkFunction();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Health check timeout')), this.config.timeout)
      );
      
      await Promise.race([checkPromise, timeoutPromise]);
      
      result.success = true;
      result.latency = Date.now() - startTime;
      
      this.handleSuccess(result);
      
    } catch (error) {
      result.error = error.message;
      result.latency = Date.now() - startTime;
      
      this.handleFailure(result);
    }
    
    // Update metrics
    this.metrics.totalChecks++;
    this.lastCheck = Date.now();
    
    // Add to history
    this.history.push(result);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
    
    return result;
  }
  
  /**
   * Handle successful health check
   */
  handleSuccess(result) {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses++;
    
    // State transitions
    if (this.state === HEALTH_STATES.FAILED && 
        this.consecutiveSuccesses >= this.config.recoveryThreshold) {
      this.state = HEALTH_STATES.RECOVERING;
      this.metrics.recoveries++;
    } else if (this.state === HEALTH_STATES.RECOVERING &&
               this.consecutiveSuccesses >= this.config.recoveryThreshold * 2) {
      this.state = HEALTH_STATES.HEALTHY;
    } else if (this.state === HEALTH_STATES.DEGRADED &&
               this.consecutiveSuccesses >= this.config.recoveryThreshold) {
      this.state = HEALTH_STATES.HEALTHY;
    }
    
    // Update availability
    this.updateAvailability();
  }
  
  /**
   * Handle failed health check
   */
  handleFailure(result) {
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures++;
    this.lastFailure = Date.now();
    this.metrics.failures++;
    
    // State transitions
    if (this.state === HEALTH_STATES.HEALTHY &&
        this.consecutiveFailures >= Math.floor(this.config.failureThreshold / 2)) {
      this.state = HEALTH_STATES.DEGRADED;
    } else if (this.state === HEALTH_STATES.DEGRADED &&
               this.consecutiveFailures >= this.config.failureThreshold) {
      this.state = HEALTH_STATES.FAILED;
    } else if (this.state === HEALTH_STATES.RECOVERING) {
      this.state = HEALTH_STATES.FAILED;
    }
    
    // Update availability
    this.updateAvailability();
  }
  
  /**
   * Update availability metric
   */
  updateAvailability() {
    const recentHistory = this.history.slice(-50);
    if (recentHistory.length === 0) return;
    
    const successCount = recentHistory.filter(r => r.success).length;
    this.metrics.availability = successCount / recentHistory.length;
  }
  
  /**
   * Get health score (0-1)
   */
  getHealthScore() {
    const stateScores = {
      [HEALTH_STATES.HEALTHY]: 1.0,
      [HEALTH_STATES.DEGRADED]: 0.6,
      [HEALTH_STATES.RECOVERING]: 0.4,
      [HEALTH_STATES.UNHEALTHY]: 0.2,
      [HEALTH_STATES.FAILED]: 0.0
    };
    
    const stateScore = stateScores[this.state] || 0;
    const availabilityScore = this.metrics.availability;
    
    // Weight state more heavily than availability
    return stateScore * 0.7 + availabilityScore * 0.3;
  }
  
  /**
   * Predict failure probability
   */
  predictFailure() {
    if (this.history.length < 10) return 0;
    
    // Analyze recent trends
    const recent = this.history.slice(-20);
    const failures = recent.filter(r => !r.success).length;
    const avgLatency = recent.reduce((sum, r) => sum + r.latency, 0) / recent.length;
    const maxLatency = Math.max(...recent.map(r => r.latency));
    
    // Calculate failure probability
    let probability = failures / recent.length;
    
    // Increase probability if latency is increasing
    if (avgLatency > this.config.timeout * 0.5) {
      probability += 0.2;
    }
    
    if (maxLatency > this.config.timeout * 0.8) {
      probability += 0.1;
    }
    
    // Consider current state
    if (this.state === HEALTH_STATES.DEGRADED) {
      probability += 0.3;
    }
    
    return Math.min(1, probability);
  }
}

/**
 * Failover coordinator
 */
class FailoverCoordinator {
  constructor(config = {}) {
    this.config = {
      strategy: config.strategy || FAILOVER_STRATEGIES.ADAPTIVE,
      maxFailovers: config.maxFailovers || 3,
      failoverCooldown: config.failoverCooldown || 300000, // 5 minutes
      ...config
    };
    
    this.failoverHistory = [];
    this.activeFailovers = new Map();
    this.learningModel = {
      successfulPatterns: [],
      failurePatterns: []
    };
  }
  
  /**
   * Execute failover
   */
  async executeFailover(failedComponent, candidates, context = {}) {
    // Check failover limits
    const recentFailovers = this.failoverHistory.filter(
      f => Date.now() - f.timestamp < this.config.failoverCooldown
    );
    
    if (recentFailovers.length >= this.config.maxFailovers) {
      throw new Error('Failover limit exceeded');
    }
    
    // Select target based on strategy
    const target = await this.selectTarget(failedComponent, candidates, context);
    
    if (!target) {
      throw new Error('No suitable failover target found');
    }
    
    // Record failover
    const failover = {
      id: crypto.randomUUID(),
      source: failedComponent,
      target: target.id,
      strategy: this.config.strategy,
      timestamp: Date.now(),
      context
    };
    
    this.failoverHistory.push(failover);
    this.activeFailovers.set(failedComponent, failover);
    
    return target;
  }
  
  /**
   * Select failover target
   */
  async selectTarget(failedComponent, candidates, context) {
    if (candidates.length === 0) return null;
    
    switch (this.config.strategy) {
      case FAILOVER_STRATEGIES.IMMEDIATE:
        return this.selectImmediate(candidates);
        
      case FAILOVER_STRATEGIES.GRACEFUL:
        return this.selectGraceful(candidates, context);
        
      case FAILOVER_STRATEGIES.WEIGHTED:
        return this.selectWeighted(candidates);
        
      case FAILOVER_STRATEGIES.GEOGRAPHIC:
        return this.selectGeographic(candidates, context);
        
      case FAILOVER_STRATEGIES.ADAPTIVE:
        return this.selectAdaptive(candidates, context);
        
      default:
        return candidates[0];
    }
  }
  
  /**
   * Immediate selection - pick first available
   */
  selectImmediate(candidates) {
    return candidates.find(c => c.state === HEALTH_STATES.HEALTHY) || candidates[0];
  }
  
  /**
   * Graceful selection - consider load and capacity
   */
  selectGraceful(candidates, context) {
    const healthy = candidates.filter(c => c.state === HEALTH_STATES.HEALTHY);
    
    if (healthy.length === 0) return null;
    
    // Sort by available capacity
    healthy.sort((a, b) => {
      const capacityA = (a.maxCapacity || 100) - (a.currentLoad || 0);
      const capacityB = (b.maxCapacity || 100) - (b.currentLoad || 0);
      return capacityB - capacityA;
    });
    
    return healthy[0];
  }
  
  /**
   * Weighted selection - use health scores
   */
  selectWeighted(candidates) {
    const weights = candidates.map(c => ({
      candidate: c,
      weight: c.healthScore || 0.5
    }));
    
    // Weighted random selection
    const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const item of weights) {
      random -= item.weight;
      if (random <= 0) {
        return item.candidate;
      }
    }
    
    return weights[0].candidate;
  }
  
  /**
   * Geographic selection - prefer nearby nodes
   */
  selectGeographic(candidates, context) {
    if (!context.location) {
      return this.selectWeighted(candidates);
    }
    
    // Calculate distances (simplified)
    const withDistance = candidates.map(c => ({
      candidate: c,
      distance: this.calculateDistance(context.location, c.location)
    }));
    
    // Sort by distance
    withDistance.sort((a, b) => a.distance - b.distance);
    
    // Return closest healthy node
    const healthy = withDistance.find(
      w => w.candidate.state === HEALTH_STATES.HEALTHY
    );
    
    return healthy ? healthy.candidate : withDistance[0].candidate;
  }
  
  /**
   * Adaptive selection - learn from history
   */
  selectAdaptive(candidates, context) {
    // Score each candidate based on historical performance
    const scores = candidates.map(c => ({
      candidate: c,
      score: this.calculateAdaptiveScore(c, context)
    }));
    
    // Sort by score
    scores.sort((a, b) => b.score - a.score);
    
    return scores[0].candidate;
  }
  
  /**
   * Calculate adaptive score
   */
  calculateAdaptiveScore(candidate, context) {
    let score = candidate.healthScore || 0.5;
    
    // Check historical success with this candidate
    const history = this.failoverHistory.filter(
      f => f.target === candidate.id
    );
    
    if (history.length > 0) {
      const successRate = history.filter(f => f.successful).length / history.length;
      score = score * 0.7 + successRate * 0.3;
    }
    
    // Apply learned patterns
    for (const pattern of this.learningModel.successfulPatterns) {
      if (this.matchesPattern(candidate, context, pattern)) {
        score += 0.1;
      }
    }
    
    for (const pattern of this.learningModel.failurePatterns) {
      if (this.matchesPattern(candidate, context, pattern)) {
        score -= 0.2;
      }
    }
    
    return Math.max(0, Math.min(1, score));
  }
  
  /**
   * Calculate distance between locations
   */
  calculateDistance(loc1, loc2) {
    if (!loc1 || !loc2) return Infinity;
    
    // Simplified distance calculation
    const dlat = loc2.lat - loc1.lat;
    const dlon = loc2.lon - loc1.lon;
    return Math.sqrt(dlat * dlat + dlon * dlon);
  }
  
  /**
   * Check if candidate matches pattern
   */
  matchesPattern(candidate, context, pattern) {
    // Simple pattern matching
    for (const [key, value] of Object.entries(pattern)) {
      if (candidate[key] !== value && context[key] !== value) {
        return false;
      }
    }
    return true;
  }
  
  /**
   * Update learning model
   */
  updateLearning(failoverId, successful) {
    const failover = this.failoverHistory.find(f => f.id === failoverId);
    if (!failover) return;
    
    failover.successful = successful;
    
    const pattern = {
      targetType: failover.targetType,
      contextType: failover.context.type,
      timeOfDay: new Date(failover.timestamp).getHours()
    };
    
    if (successful) {
      this.learningModel.successfulPatterns.push(pattern);
    } else {
      this.learningModel.failurePatterns.push(pattern);
    }
    
    // Keep only recent patterns
    const maxPatterns = 100;
    if (this.learningModel.successfulPatterns.length > maxPatterns) {
      this.learningModel.successfulPatterns.shift();
    }
    if (this.learningModel.failurePatterns.length > maxPatterns) {
      this.learningModel.failurePatterns.shift();
    }
  }
}

/**
 * Automatic Failover Manager
 */
export class AutomaticFailoverManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Health monitoring
      healthCheckInterval: config.healthCheckInterval || 5000,
      failureThreshold: config.failureThreshold || 3,
      recoveryThreshold: config.recoveryThreshold || 5,
      
      // Failover configuration
      failoverStrategy: config.failoverStrategy || FAILOVER_STRATEGIES.ADAPTIVE,
      maxFailovers: config.maxFailovers || 3,
      failoverCooldown: config.failoverCooldown || 300000,
      
      // Recovery configuration
      autoRecovery: config.autoRecovery !== false,
      recoveryDelay: config.recoveryDelay || 60000,
      maxRecoveryAttempts: config.maxRecoveryAttempts || 3,
      
      // Prediction
      enablePrediction: config.enablePrediction || true,
      predictionThreshold: config.predictionThreshold || 0.7,
      
      ...config
    };
    
    // Component management
    this.components = new Map(); // componentId -> component info
    this.monitors = new Map(); // componentId -> HealthMonitor
    this.dependencies = new Map(); // componentId -> [dependentIds]
    
    // Failover coordination
    this.coordinator = new FailoverCoordinator({
      strategy: this.config.failoverStrategy,
      maxFailovers: this.config.maxFailovers,
      failoverCooldown: this.config.failoverCooldown
    });
    
    // Recovery tracking
    this.recoveryQueue = [];
    this.recoveryAttempts = new Map();
    
    // Statistics
    this.stats = {
      totalFailovers: 0,
      successfulFailovers: 0,
      failedFailovers: 0,
      totalRecoveries: 0,
      predictedFailures: 0,
      preventedFailures: 0
    };
    
    this.logger = logger;
  }
  
  /**
   * Register component for monitoring
   */
  registerComponent(componentId, info = {}) {
    const component = {
      id: componentId,
      type: info.type || 'generic',
      critical: info.critical || false,
      healthCheck: info.healthCheck || (() => Promise.resolve()),
      failoverCandidates: info.failoverCandidates || [],
      recoveryAction: info.recoveryAction || RECOVERY_ACTIONS.RESTART,
      metadata: info.metadata || {},
      state: HEALTH_STATES.HEALTHY,
      healthScore: 1.0
    };
    
    this.components.set(componentId, component);
    
    // Create health monitor
    const monitor = new HealthMonitor(componentId, {
      checkInterval: this.config.healthCheckInterval,
      failureThreshold: this.config.failureThreshold,
      recoveryThreshold: this.config.recoveryThreshold
    });
    
    this.monitors.set(componentId, monitor);
    
    // Register dependencies
    if (info.dependencies) {
      this.dependencies.set(componentId, info.dependencies);
    }
    
    this.logger.info('Component registered', {
      componentId,
      type: component.type,
      critical: component.critical
    });
  }
  
  /**
   * Start failover manager
   */
  async start() {
    // Start health monitoring
    this.startHealthMonitoring();
    
    // Start recovery processor
    if (this.config.autoRecovery) {
      this.startRecoveryProcessor();
    }
    
    // Start prediction if enabled
    if (this.config.enablePrediction) {
      this.startPredictionMonitoring();
    }
    
    this.logger.info('Automatic failover manager started', {
      components: this.components.size,
      strategy: this.config.failoverStrategy
    });
  }
  
  /**
   * Start health monitoring
   */
  startHealthMonitoring() {
    this.healthInterval = setInterval(async () => {
      const checks = [];
      
      for (const [componentId, component] of this.components) {
        checks.push(this.checkComponentHealth(componentId));
      }
      
      await Promise.allSettled(checks);
    }, this.config.healthCheckInterval);
  }
  
  /**
   * Check component health
   */
  async checkComponentHealth(componentId) {
    const component = this.components.get(componentId);
    const monitor = this.monitors.get(componentId);
    
    if (!component || !monitor) return;
    
    const result = await monitor.check(component.healthCheck);
    
    // Update component state
    const previousState = component.state;
    component.state = monitor.state;
    component.healthScore = monitor.getHealthScore();
    
    // Handle state changes
    if (previousState !== component.state) {
      this.handleStateChange(componentId, previousState, component.state);
    }
    
    // Check for prediction
    if (this.config.enablePrediction) {
      const failureProbability = monitor.predictFailure();
      if (failureProbability > this.config.predictionThreshold) {
        this.handlePredictedFailure(componentId, failureProbability);
      }
    }
  }
  
  /**
   * Handle component state change
   */
  async handleStateChange(componentId, previousState, newState) {
    const component = this.components.get(componentId);
    
    this.logger.info('Component state changed', {
      componentId,
      previousState,
      newState,
      critical: component.critical
    });
    
    this.emit('stateChanged', {
      componentId,
      previousState,
      newState,
      component
    });
    
    // Handle failure
    if (newState === HEALTH_STATES.FAILED) {
      await this.handleComponentFailure(componentId);
    }
    
    // Handle recovery
    if (previousState === HEALTH_STATES.FAILED && 
        newState === HEALTH_STATES.RECOVERING) {
      this.emit('componentRecovering', { componentId });
    }
    
    if (previousState !== HEALTH_STATES.HEALTHY && 
        newState === HEALTH_STATES.HEALTHY) {
      this.handleComponentRecovered(componentId);
    }
  }
  
  /**
   * Handle component failure
   */
  async handleComponentFailure(componentId) {
    const component = this.components.get(componentId);
    
    this.emit('componentFailed', {
      componentId,
      component,
      critical: component.critical
    });
    
    // Check if failover is needed
    if (component.failoverCandidates.length > 0) {
      try {
        await this.performFailover(componentId);
      } catch (error) {
        this.logger.error('Failover failed', {
          componentId,
          error: error.message
        });
        this.stats.failedFailovers++;
        
        // Escalate if critical
        if (component.critical) {
          this.escalateFailure(componentId, error);
        }
      }
    }
    
    // Queue for recovery if enabled
    if (this.config.autoRecovery) {
      this.queueRecovery(componentId);
    }
  }
  
  /**
   * Perform failover
   */
  async performFailover(componentId) {
    const component = this.components.get(componentId);
    
    // Get healthy candidates
    const candidates = [];
    for (const candidateId of component.failoverCandidates) {
      const candidate = this.components.get(candidateId);
      if (candidate) {
        candidates.push({
          id: candidateId,
          ...candidate
        });
      }
    }
    
    if (candidates.length === 0) {
      throw new Error('No failover candidates available');
    }
    
    // Execute failover
    const target = await this.coordinator.executeFailover(
      componentId,
      candidates,
      {
        type: component.type,
        location: component.metadata.location
      }
    );
    
    this.stats.totalFailovers++;
    
    this.logger.info('Failover executed', {
      source: componentId,
      target: target.id
    });
    
    this.emit('failoverExecuted', {
      source: componentId,
      target: target.id,
      component,
      targetComponent: target
    });
    
    // Update routing or configuration
    await this.updateConfiguration(componentId, target.id);
    
    this.stats.successfulFailovers++;
    
    // Update learning model
    this.coordinator.updateLearning(
      this.coordinator.activeFailovers.get(componentId).id,
      true
    );
  }
  
  /**
   * Update configuration after failover
   */
  async updateConfiguration(failedId, targetId) {
    // This would update load balancers, DNS, etc.
    // Implementation depends on infrastructure
    
    this.emit('configurationUpdated', {
      failedId,
      targetId
    });
  }
  
  /**
   * Handle predicted failure
   */
  async handlePredictedFailure(componentId, probability) {
    this.stats.predictedFailures++;
    
    this.logger.warn('Failure predicted', {
      componentId,
      probability
    });
    
    this.emit('failurePredicted', {
      componentId,
      probability
    });
    
    // Take preventive action
    const component = this.components.get(componentId);
    
    if (component.critical && probability > 0.9) {
      // Proactive failover for critical components
      try {
        await this.performFailover(componentId);
        this.stats.preventedFailures++;
      } catch (error) {
        this.logger.error('Preventive failover failed', {
          componentId,
          error: error.message
        });
      }
    } else {
      // Try recovery action
      this.queueRecovery(componentId, true); // High priority
    }
  }
  
  /**
   * Queue component for recovery
   */
  queueRecovery(componentId, highPriority = false) {
    const existing = this.recoveryQueue.find(r => r.componentId === componentId);
    
    if (!existing) {
      const recovery = {
        componentId,
        queuedAt: Date.now(),
        priority: highPriority ? 1 : 0
      };
      
      if (highPriority) {
        this.recoveryQueue.unshift(recovery);
      } else {
        this.recoveryQueue.push(recovery);
      }
    }
  }
  
  /**
   * Start recovery processor
   */
  startRecoveryProcessor() {
    this.recoveryInterval = setInterval(async () => {
      if (this.recoveryQueue.length === 0) return;
      
      const recovery = this.recoveryQueue.shift();
      
      // Check if still failed
      const component = this.components.get(recovery.componentId);
      if (!component || component.state !== HEALTH_STATES.FAILED) {
        return;
      }
      
      // Check recovery attempts
      const attempts = this.recoveryAttempts.get(recovery.componentId) || 0;
      if (attempts >= this.config.maxRecoveryAttempts) {
        this.logger.error('Max recovery attempts exceeded', {
          componentId: recovery.componentId,
          attempts
        });
        return;
      }
      
      // Wait for recovery delay
      if (Date.now() - recovery.queuedAt < this.config.recoveryDelay) {
        this.recoveryQueue.unshift(recovery); // Put back
        return;
      }
      
      // Attempt recovery
      await this.attemptRecovery(recovery.componentId);
      
    }, 5000); // Check every 5 seconds
  }
  
  /**
   * Attempt component recovery
   */
  async attemptRecovery(componentId) {
    const component = this.components.get(componentId);
    if (!component) return;
    
    this.recoveryAttempts.set(
      componentId,
      (this.recoveryAttempts.get(componentId) || 0) + 1
    );
    
    this.logger.info('Attempting recovery', {
      componentId,
      action: component.recoveryAction,
      attempt: this.recoveryAttempts.get(componentId)
    });
    
    try {
      switch (component.recoveryAction) {
        case RECOVERY_ACTIONS.RESTART:
          await this.restartComponent(componentId);
          break;
          
        case RECOVERY_ACTIONS.RECONNECT:
          await this.reconnectComponent(componentId);
          break;
          
        case RECOVERY_ACTIONS.RECONFIGURE:
          await this.reconfigureComponent(componentId);
          break;
          
        case RECOVERY_ACTIONS.REPLACE:
          await this.replaceComponent(componentId);
          break;
          
        default:
          throw new Error(`Unknown recovery action: ${component.recoveryAction}`);
      }
      
      this.stats.totalRecoveries++;
      
      this.emit('recoveryAttempted', {
        componentId,
        action: component.recoveryAction,
        success: true
      });
      
    } catch (error) {
      this.logger.error('Recovery failed', {
        componentId,
        error: error.message
      });
      
      this.emit('recoveryAttempted', {
        componentId,
        action: component.recoveryAction,
        success: false,
        error: error.message
      });
      
      // Re-queue if not max attempts
      if (this.recoveryAttempts.get(componentId) < this.config.maxRecoveryAttempts) {
        this.queueRecovery(componentId);
      }
    }
  }
  
  /**
   * Component recovery actions
   */
  async restartComponent(componentId) {
    // Implementation depends on component type
    this.emit('componentRestarting', { componentId });
  }
  
  async reconnectComponent(componentId) {
    // Implementation depends on component type
    this.emit('componentReconnecting', { componentId });
  }
  
  async reconfigureComponent(componentId) {
    // Implementation depends on component type
    this.emit('componentReconfiguring', { componentId });
  }
  
  async replaceComponent(componentId) {
    // Implementation depends on component type
    this.emit('componentReplacing', { componentId });
  }
  
  /**
   * Handle component recovered
   */
  handleComponentRecovered(componentId) {
    // Clear recovery attempts
    this.recoveryAttempts.delete(componentId);
    
    // Clear active failover if any
    this.coordinator.activeFailovers.delete(componentId);
    
    this.emit('componentRecovered', { componentId });
  }
  
  /**
   * Escalate critical failure
   */
  escalateFailure(componentId, error) {
    this.emit('criticalFailure', {
      componentId,
      error: error.message,
      timestamp: Date.now()
    });
    
    // Additional escalation actions
    // - Send alerts
    // - Trigger emergency procedures
    // - Notify operators
  }
  
  /**
   * Start prediction monitoring
   */
  startPredictionMonitoring() {
    this.predictionInterval = setInterval(() => {
      // Analyze trends across all components
      const predictions = [];
      
      for (const [componentId, monitor] of this.monitors) {
        const probability = monitor.predictFailure();
        if (probability > 0.5) {
          predictions.push({
            componentId,
            probability,
            healthScore: monitor.getHealthScore()
          });
        }
      }
      
      if (predictions.length > 0) {
        this.emit('failurePredictions', { predictions });
      }
      
    }, 30000); // Every 30 seconds
  }
  
  /**
   * Get failover statistics
   */
  getStatistics() {
    const componentStats = [];
    
    for (const [componentId, component] of this.components) {
      const monitor = this.monitors.get(componentId);
      componentStats.push({
        componentId,
        type: component.type,
        state: component.state,
        healthScore: component.healthScore,
        critical: component.critical,
        metrics: monitor ? monitor.metrics : null
      });
    }
    
    return {
      components: componentStats,
      failover: {
        ...this.stats,
        activeFailovers: this.coordinator.activeFailovers.size,
        failoverHistory: this.coordinator.failoverHistory.length
      },
      recovery: {
        queueSize: this.recoveryQueue.length,
        activeAttempts: this.recoveryAttempts.size
      }
    };
  }
  
  /**
   * Stop failover manager
   */
  async stop() {
    // Clear intervals
    if (this.healthInterval) clearInterval(this.healthInterval);
    if (this.recoveryInterval) clearInterval(this.recoveryInterval);
    if (this.predictionInterval) clearInterval(this.predictionInterval);
    
    this.logger.info('Automatic failover manager stopped');
  }
}

// Export constants
export {
  FAILOVER_STRATEGIES,
  HEALTH_STATES,
  RECOVERY_ACTIONS
};

export default AutomaticFailoverManager;