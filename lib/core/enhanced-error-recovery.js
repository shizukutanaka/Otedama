/**
 * Enhanced Error Recovery System - Otedama
 * Advanced error recovery with automatic healing and fault tolerance
 * 
 * Design Principles:
 * - Carmack: Fail-fast with immediate recovery paths
 * - Martin: Clean separation of error detection, reporting, and recovery
 * - Pike: Simple recovery strategies for complex failure scenarios
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from './structured-logger.js';
import { OtedamaError, ErrorCategory, ErrorSeverity } from './error-handler-unified.js';

const logger = createStructuredLogger('ErrorRecovery');

/**
 * Recovery strategies
 */
export const RecoveryStrategy = {
  RESTART_COMPONENT: 'restart_component',
  FALLBACK_MODE: 'fallback_mode',
  CIRCUIT_BREAKER: 'circuit_breaker',
  RETRY_WITH_BACKOFF: 'retry_with_backoff',
  GRACEFUL_DEGRADATION: 'graceful_degradation',
  FAIL_FAST: 'fail_fast'
};

/**
 * Recovery context
 */
class RecoveryContext {
  constructor(error, component, attempt = 1) {
    this.error = error;
    this.component = component;
    this.attempt = attempt;
    this.maxAttempts = 3;
    this.startTime = Date.now();
    this.strategy = null;
    this.metadata = {};
  }
  
  /**
   * Check if should retry
   */
  shouldRetry() {
    return this.attempt < this.maxAttempts && 
           this.error.retryable && 
           (Date.now() - this.startTime) < 30000; // 30 second timeout
  }
  
  /**
   * Get next attempt
   */
  nextAttempt() {
    return new RecoveryContext(this.error, this.component, this.attempt + 1);
  }
  
  /**
   * Calculate backoff delay
   */
  getBackoffDelay() {
    return Math.min(1000 * Math.pow(2, this.attempt - 1), 10000); // Max 10 seconds
  }
}

/**
 * Enhanced error recovery system
 */
export class EnhancedErrorRecovery extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      maxRecoveryAttempts: config.maxRecoveryAttempts || 3,
      recoveryTimeout: config.recoveryTimeout || 30000,
      enableAutoRecovery: config.enableAutoRecovery !== false,
      enableCircuitBreaker: config.enableCircuitBreaker !== false,
      enableFallbackMode: config.enableFallbackMode !== false,
      ...config
    };
    
    // Recovery state
    this.recoveryStrategies = new Map();
    this.componentStates = new Map();
    this.recoveryHistory = [];
    this.activeRecoveries = new Map();
    
    // Statistics  
    this.stats = {
      totalErrors: 0,
      recoveredErrors: 0,
      failedRecoveries: 0,
      componentRestarts: 0,
      circuitBreakerTrips: 0
    };
    
    this.logger = logger;
    
    this.initializeRecoveryStrategies();
  }
  
  /**
   * Initialize default recovery strategies
   */
  initializeRecoveryStrategies() {
    // Network errors - retry with exponential backoff
    this.registerStrategy(ErrorCategory.NETWORK, {
      strategy: RecoveryStrategy.RETRY_WITH_BACKOFF,
      maxAttempts: 3,
      backoffMultiplier: 2,
      handler: async (context) => {
        const delay = context.getBackoffDelay();
        logger.info('Network error recovery - retrying', { 
          delay, 
          attempt: context.attempt,
          error: context.error.message 
        });
        
        await this.delay(delay);
        return { recovered: true, strategy: RecoveryStrategy.RETRY_WITH_BACKOFF };
      }
    });
    
    // Database errors - circuit breaker
    this.registerStrategy(ErrorCategory.DATABASE, {
      strategy: RecoveryStrategy.CIRCUIT_BREAKER,
      maxAttempts: 2,
      handler: async (context) => {
        logger.warn('Database error - activating circuit breaker', {
          error: context.error.message,
          component: context.component
        });
        
        // Activate circuit breaker for component
        this.activateCircuitBreaker(context.component);
        this.stats.circuitBreakerTrips++;
        
        return { recovered: true, strategy: RecoveryStrategy.CIRCUIT_BREAKER };
      }
    });
    
    // Mining errors - graceful degradation
    this.registerStrategy(ErrorCategory.MINING, {
      strategy: RecoveryStrategy.GRACEFUL_DEGRADATION,
      maxAttempts: 2,
      handler: async (context) => {
        logger.info('Mining error - enabling graceful degradation', {
          error: context.error.message,
          component: context.component
        });
        
        // Switch to fallback mining mode
        await this.enableFallbackMode(context.component);
        
        return { recovered: true, strategy: RecoveryStrategy.GRACEFUL_DEGRADATION };
      }
    });
    
    // System errors - component restart
    this.registerStrategy(ErrorCategory.SYSTEM, {
      strategy: RecoveryStrategy.RESTART_COMPONENT,
      maxAttempts: 2,
      handler: async (context) => {
        logger.warn('System error - restarting component', {
          error: context.error.message,
          component: context.component
        });
        
        await this.restartComponent(context.component);
        this.stats.componentRestarts++;
        
        return { recovered: true, strategy: RecoveryStrategy.RESTART_COMPONENT };
      }
    });
    
    // Payment errors - fail fast (no recovery)
    this.registerStrategy(ErrorCategory.PAYMENT, {
      strategy: RecoveryStrategy.FAIL_FAST,
      maxAttempts: 1,
      handler: async (context) => {
        logger.error('Payment error - failing fast', {
          error: context.error.message,
          context: context.error.context
        });
        
        // Log for manual intervention
        this.emit('payment:error', {
          error: context.error,
          requiresManualIntervention: true
        });
        
        return { recovered: false, strategy: RecoveryStrategy.FAIL_FAST };
      }
    });
  }
  
  /**
   * Register recovery strategy
   */
  registerStrategy(category, strategyConfig) {
    this.recoveryStrategies.set(category, strategyConfig);
  }
  
  /**
   * Handle error with automatic recovery
   */
  async handleError(error, component = 'unknown') {
    this.stats.totalErrors++;
    
    const context = new RecoveryContext(error, component);
    const recoveryId = `${component}-${Date.now()}`;
    
    try {
      this.activeRecoveries.set(recoveryId, context);
      
      logger.info('Starting error recovery', {
        recoveryId,
        component,
        errorCategory: error.category,
        errorMessage: error.message,
        attempt: context.attempt
      });
      
      const result = await this.attemptRecovery(context);
      
      if (result.recovered) {
        this.stats.recoveredErrors++;
        this.recordRecoverySuccess(context, result.strategy);
        
        this.emit('recovery:success', {
          recoveryId,
          component,
          strategy: result.strategy,
          attempts: context.attempt
        });
        
        logger.info('Error recovery successful', {
          recoveryId,
          strategy: result.strategy,
          attempts: context.attempt
        });
        
        return { recovered: true, strategy: result.strategy };
      } else {
        throw new Error('Recovery failed');
      }
      
    } catch (recoveryError) {
      this.stats.failedRecoveries++;
      this.recordRecoveryFailure(context, recoveryError);
      
      this.emit('recovery:failed', {
        recoveryId,
        component,
        originalError: error,
        recoveryError: recoveryError.message,
        attempts: context.attempt
      });
      
      logger.error('Error recovery failed', {
        recoveryId,
        originalError: error.message,
        recoveryError: recoveryError.message,
        attempts: context.attempt
      });
      
      return { recovered: false, error: recoveryError };
      
    } finally {
      this.activeRecoveries.delete(recoveryId);
    }
  }
  
  /**
   * Attempt recovery using registered strategies
   */
  async attemptRecovery(context) {
    const strategy = this.recoveryStrategies.get(context.error.category);
    
    if (!strategy) {
      logger.warn('No recovery strategy found', {
        category: context.error.category,
        component: context.component
      });
      return { recovered: false };
    }
    
    if (!context.shouldRetry()) {
      logger.warn('Recovery attempts exhausted', {
        component: context.component,
        attempts: context.attempt,
        maxAttempts: context.maxAttempts
      });
      return { recovered: false };
    }
    
    try {
      const result = await strategy.handler(context);
      return result;
      
    } catch (error) {
      logger.error('Recovery strategy failed', {
        strategy: strategy.strategy,
        component: context.component,
        error: error.message
      });
      
      // Try next attempt if retryable
      if (context.shouldRetry()) {
        const nextContext = context.nextAttempt();
        return await this.attemptRecovery(nextContext);
      }
      
      return { recovered: false };
    }
  }
  
  /**
   * Activate circuit breaker for component
   */
  activateCircuitBreaker(component) {
    const state = this.componentStates.get(component) || {};
    state.circuitBreakerActive = true;
    state.circuitBreakerActivatedAt = Date.now();
    state.circuitBreakerTimeout = 60000; // 1 minute
    
    this.componentStates.set(component, state);
    
    // Auto-reset circuit breaker
    setTimeout(() => {
      this.resetCircuitBreaker(component);
    }, state.circuitBreakerTimeout);
  }
  
  /**
   * Reset circuit breaker
   */
  resetCircuitBreaker(component) {
    const state = this.componentStates.get(component);
    if (state) {
      state.circuitBreakerActive = false;
      state.circuitBreakerActivatedAt = null;
      this.componentStates.set(component, state);
      
      logger.info('Circuit breaker reset', { component });
      this.emit('circuitBreaker:reset', { component });
    }
  }
  
  /**
   * Enable fallback mode for component
   */
  async enableFallbackMode(component) {
    const state = this.componentStates.get(component) || {};
    state.fallbackMode = true;
    state.fallbackEnabledAt = Date.now();
    
    this.componentStates.set(component, state);
    
    logger.info('Fallback mode enabled', { component });
    this.emit('fallback:enabled', { component });
  }
  
  /**
   * Restart component
   */
  async restartComponent(component) {
    logger.info('Restarting component', { component });
    
    // Emit restart event for component manager to handle
    this.emit('component:restart', { 
      component,
      timestamp: Date.now()
    });
    
    // Update component state
    const state = this.componentStates.get(component) || {};
    state.lastRestart = Date.now();
    state.restartCount = (state.restartCount || 0) + 1;
    
    this.componentStates.set(component, state);
  }
  
  /**
   * Check if component is healthy
   */
  isComponentHealthy(component) {
    const state = this.componentStates.get(component);
    if (!state) return true;
    
    return !state.circuitBreakerActive && !state.fallbackMode;
  }
  
  /**
   * Record recovery success
   */
  recordRecoverySuccess(context, strategy) {
    const record = {
      timestamp: Date.now(),
      component: context.component,
      errorCategory: context.error.category,
      strategy,
      attempts: context.attempt,
      duration: Date.now() - context.startTime,
      success: true
    };
    
    this.recoveryHistory.push(record);
    this.maintainHistorySize();
  }
  
  /**
   * Record recovery failure
   */
  recordRecoveryFailure(context, recoveryError) {
    const record = {
      timestamp: Date.now(),
      component: context.component,
      errorCategory: context.error.category,
      originalError: context.error.message,
      recoveryError: recoveryError.message,
      attempts: context.attempt,
      duration: Date.now() - context.startTime,
      success: false
    };
    
    this.recoveryHistory.push(record);
    this.maintainHistorySize();
  }
  
  /**
   * Maintain recovery history size
   */
  maintainHistorySize() {
    const maxHistorySize = 1000;
    if (this.recoveryHistory.length > maxHistorySize) {
      this.recoveryHistory = this.recoveryHistory.slice(-maxHistorySize);
    }
  }
  
  /**
   * Utility: delay function
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Get recovery statistics
   */
  getStats() {
    const activeRecoveries = this.activeRecoveries.size;
    const componentStates = Object.fromEntries(this.componentStates);
    const recentRecoveries = this.recoveryHistory
      .filter(r => Date.now() - r.timestamp < 3600000) // Last hour
      .length;
    
    return {
      ...this.stats,
      activeRecoveries,
      componentStates,
      recentRecoveries,
      recoveryRate: this.stats.totalErrors > 0 ? 
        (this.stats.recoveredErrors / this.stats.totalErrors) * 100 : 0
    };
  }
  
  /**
   * Get recovery history
   */
  getRecoveryHistory(limit = 100) {
    return this.recoveryHistory
      .slice(-limit)
      .sort((a, b) => b.timestamp - a.timestamp);
  }
  
  /**
   * Clear component state
   */
  clearComponentState(component) {
    this.componentStates.delete(component);
    logger.info('Component state cleared', { component });
  }
  
  /**
   * Shutdown recovery system
   */
  shutdown() {
    this.activeRecoveries.clear();
    this.componentStates.clear();
    this.removeAllListeners();
    
    logger.info('Enhanced error recovery system shutdown');
  }
}

/**
 * Singleton instance for global use
 */
export const errorRecovery = new EnhancedErrorRecovery();

export default EnhancedErrorRecovery;