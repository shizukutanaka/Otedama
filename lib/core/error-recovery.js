/**
 * Automatic Error Recovery System for Otedama
 * Provides self-healing capabilities and error recovery
 * 
 * Design principles:
 * - Carmack: Fast recovery, minimal downtime
 * - Martin: Clear recovery strategies
 * - Pike: Simple and predictable behavior
 */

import { EventEmitter } from 'events';
import { logger } from './logger.js';
import CircuitBreaker from './circuit-breaker.js';

export const RecoveryStrategy = {
  RETRY: 'retry',
  RESTART: 'restart',
  FALLBACK: 'fallback',
  CIRCUIT_BREAK: 'circuit_break',
  ESCALATE: 'escalate'
};

export const ErrorSeverity = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

class ErrorContext {
  constructor(error, component, severity = ErrorSeverity.MEDIUM) {
    this.error = error;
    this.component = component;
    this.severity = severity;
    this.timestamp = Date.now();
    this.attempts = 0;
    this.recovered = false;
    this.strategy = null;
  }
}

export class ErrorRecoverySystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      maxRecoveryTime: options.maxRecoveryTime || 300000, // 5 minutes
      escalationThreshold: options.escalationThreshold || 10,
      
      strategies: {
        retry: options.enableRetry !== false,
        restart: options.enableRestart !== false,
        fallback: options.enableFallback !== false,
        circuitBreak: options.enableCircuitBreak !== false
      },
      
      ...options
    };
    
    // Error tracking
    this.errorHistory = [];
    this.activeRecoveries = new Map();
    this.componentErrors = new Map();
    
    // Recovery handlers
    this.recoveryHandlers = new Map();
    this.fallbackHandlers = new Map();
    
    // Circuit breakers for components
    this.circuitBreakers = new Map();
    
    // Metrics
    this.metrics = {
      totalErrors: 0,
      recoveredErrors: 0,
      failedRecoveries: 0,
      activeRecoveries: 0,
      avgRecoveryTime: 0
    };
    
    // Register default handlers
    this._registerDefaultHandlers();
  }
  
  _registerDefaultHandlers() {
    // Network errors
    this.registerHandler('ECONNREFUSED', async (context) => {
      return this._retryWithBackoff(context);
    });
    
    this.registerHandler('ETIMEDOUT', async (context) => {
      return this._retryWithBackoff(context);
    });
    
    this.registerHandler('ENOTFOUND', async (context) => {
      return this._fallbackOrEscalate(context);
    });
    
    // Database errors
    this.registerHandler('ER_CON_COUNT_ERROR', async (context) => {
      return this._circuitBreakAndRetry(context);
    });
    
    this.registerHandler('ECONNRESET', async (context) => {
      return this._retryWithBackoff(context);
    });
    
    // Generic errors
    this.registerHandler('ENOMEM', async (context) => {
      logger.error('Out of memory error detected');
      return this._restartComponent(context);
    });
    
    this.registerHandler('EMFILE', async (context) => {
      logger.error('Too many open files');
      return this._reduceLoadAndRetry(context);
    });
  }
  
  registerHandler(errorCode, handler) {
    this.recoveryHandlers.set(errorCode, handler);
  }
  
  registerFallback(component, fallbackFn) {
    this.fallbackHandlers.set(component, fallbackFn);
  }
  
  async handleError(error, component, options = {}) {
    this.metrics.totalErrors++;
    
    const context = new ErrorContext(
      error,
      component,
      options.severity || this._determineSeverity(error)
    );
    
    // Track error
    this._trackError(context);
    
    // Check if already recovering
    const recoveryKey = `${component}:${error.code || error.message}`;
    if (this.activeRecoveries.has(recoveryKey)) {
      logger.debug(`Recovery already in progress for ${recoveryKey}`);
      return this.activeRecoveries.get(recoveryKey);
    }
    
    // Start recovery
    const recoveryPromise = this._performRecovery(context);
    this.activeRecoveries.set(recoveryKey, recoveryPromise);
    this.metrics.activeRecoveries++;
    
    // Clean up when done
    recoveryPromise.finally(() => {
      this.activeRecoveries.delete(recoveryKey);
      this.metrics.activeRecoveries--;
    });
    
    return recoveryPromise;
  }
  
  async _performRecovery(context) {
    const startTime = Date.now();
    
    try {
      // Emit recovery start event
      this.emit('recoveryStart', context);
      
      // Try specific handler first
      const handler = this.recoveryHandlers.get(context.error.code) ||
                     this.recoveryHandlers.get(context.error.name);
      
      let result;
      if (handler) {
        result = await handler(context);
      } else {
        // Use default strategy based on severity
        result = await this._defaultRecoveryStrategy(context);
      }
      
      if (result.success) {
        context.recovered = true;
        context.strategy = result.strategy;
        this.metrics.recoveredErrors++;
        
        // Update recovery time metric
        const recoveryTime = Date.now() - startTime;
        this.metrics.avgRecoveryTime = 
          (this.metrics.avgRecoveryTime + recoveryTime) / 2;
        
        logger.info(`Successfully recovered from error in ${context.component}`, {
          error: context.error.message,
          strategy: result.strategy,
          attempts: context.attempts,
          duration: recoveryTime
        });
        
        this.emit('recoverySuccess', context);
        return result;
      } else {
        throw new Error(`Recovery failed: ${result.reason}`);
      }
    } catch (recoveryError) {
      this.metrics.failedRecoveries++;
      
      logger.error(`Failed to recover from error in ${context.component}`, {
        originalError: context.error.message,
        recoveryError: recoveryError.message,
        attempts: context.attempts
      });
      
      this.emit('recoveryFailed', context);
      
      // Escalate if critical
      if (context.severity === ErrorSeverity.CRITICAL) {
        await this._escalate(context);
      }
      
      throw recoveryError;
    }
  }
  
  async _defaultRecoveryStrategy(context) {
    // Based on severity and error type
    switch (context.severity) {
      case ErrorSeverity.LOW:
        return this._retryWithBackoff(context);
        
      case ErrorSeverity.MEDIUM:
        if (this.options.strategies.fallback) {
          return this._fallbackOrRetry(context);
        }
        return this._retryWithBackoff(context);
        
      case ErrorSeverity.HIGH:
        if (this.options.strategies.circuitBreak) {
          return this._circuitBreakAndRetry(context);
        }
        return this._restartComponent(context);
        
      case ErrorSeverity.CRITICAL:
        return this._escalate(context);
        
      default:
        return this._retryWithBackoff(context);
    }
  }
  
  async _retryWithBackoff(context) {
    if (context.attempts >= this.options.maxRetries) {
      return {
        success: false,
        strategy: RecoveryStrategy.RETRY,
        reason: 'Max retries exceeded'
      };
    }
    
    context.attempts++;
    
    // Calculate backoff delay
    const delay = Math.min(
      this.options.retryDelay * Math.pow(2, context.attempts - 1),
      30000 // Max 30 seconds
    );
    
    logger.debug(`Retrying ${context.component} after ${delay}ms (attempt ${context.attempts})`);
    
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Try to recover by re-initializing or reconnecting
    try {
      if (context.component.reconnect) {
        await context.component.reconnect();
      } else if (context.component.initialize) {
        await context.component.initialize();
      }
      
      return {
        success: true,
        strategy: RecoveryStrategy.RETRY,
        attempts: context.attempts
      };
    } catch (retryError) {
      // Recursive retry
      if (context.attempts < this.options.maxRetries) {
        return this._retryWithBackoff(context);
      }
      
      return {
        success: false,
        strategy: RecoveryStrategy.RETRY,
        reason: retryError.message
      };
    }
  }
  
  async _restartComponent(context) {
    logger.info(`Restarting component ${context.component.name || context.component.constructor.name}`);
    
    try {
      // Stop component
      if (context.component.stop) {
        await context.component.stop();
      } else if (context.component.close) {
        await context.component.close();
      }
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Start component
      if (context.component.start) {
        await context.component.start();
      } else if (context.component.initialize) {
        await context.component.initialize();
      }
      
      return {
        success: true,
        strategy: RecoveryStrategy.RESTART
      };
    } catch (restartError) {
      return {
        success: false,
        strategy: RecoveryStrategy.RESTART,
        reason: restartError.message
      };
    }
  }
  
  async _fallbackOrRetry(context) {
    const fallback = this.fallbackHandlers.get(context.component.name || context.component.constructor.name);
    
    if (fallback) {
      try {
        const result = await fallback(context);
        return {
          success: true,
          strategy: RecoveryStrategy.FALLBACK,
          result
        };
      } catch (fallbackError) {
        // Fallback failed, try retry
        return this._retryWithBackoff(context);
      }
    }
    
    return this._retryWithBackoff(context);
  }
  
  async _fallbackOrEscalate(context) {
    const fallback = this.fallbackHandlers.get(context.component.name || context.component.constructor.name);
    
    if (fallback) {
      try {
        const result = await fallback(context);
        return {
          success: true,
          strategy: RecoveryStrategy.FALLBACK,
          result
        };
      } catch (fallbackError) {
        return this._escalate(context);
      }
    }
    
    return this._escalate(context);
  }
  
  async _circuitBreakAndRetry(context) {
    const componentName = context.component.name || context.component.constructor.name;
    
    // Get or create circuit breaker
    if (!this.circuitBreakers.has(componentName)) {
      this.circuitBreakers.set(componentName, new CircuitBreaker({
        name: componentName,
        fn: async () => {
          if (context.component.reconnect) {
            return context.component.reconnect();
          } else if (context.component.initialize) {
            return context.component.initialize();
          }
        }
      }));
    }
    
    const breaker = this.circuitBreakers.get(componentName);
    
    try {
      await breaker.call();
      return {
        success: true,
        strategy: RecoveryStrategy.CIRCUIT_BREAK
      };
    } catch (error) {
      return {
        success: false,
        strategy: RecoveryStrategy.CIRCUIT_BREAK,
        reason: error.message
      };
    }
  }
  
  async _reduceLoadAndRetry(context) {
    // Implement load reduction logic
    if (context.component.reduceLoad) {
      await context.component.reduceLoad();
    }
    
    // Wait for system to stabilize
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    return this._retryWithBackoff(context);
  }
  
  async _escalate(context) {
    logger.error(`Escalating critical error in ${context.component.name || context.component.constructor.name}`, {
      error: context.error,
      attempts: context.attempts
    });
    
    // Emit escalation event
    this.emit('escalation', context);
    
    // Could trigger alerts, notifications, etc.
    
    return {
      success: false,
      strategy: RecoveryStrategy.ESCALATE,
      reason: 'Error escalated to administrators'
    };
  }
  
  _trackError(context) {
    // Add to history
    this.errorHistory.push(context);
    
    // Limit history size
    if (this.errorHistory.length > 1000) {
      this.errorHistory.shift();
    }
    
    // Track component errors
    const componentName = context.component.name || context.component.constructor.name;
    if (!this.componentErrors.has(componentName)) {
      this.componentErrors.set(componentName, []);
    }
    
    const componentHistory = this.componentErrors.get(componentName);
    componentHistory.push(context);
    
    // Check for error patterns
    this._detectErrorPatterns(componentName, componentHistory);
  }
  
  _detectErrorPatterns(componentName, history) {
    // Check for repeated errors
    const recentErrors = history.filter(
      e => Date.now() - e.timestamp < 300000 // Last 5 minutes
    );
    
    if (recentErrors.length >= this.options.escalationThreshold) {
      logger.warn(`Detected error pattern in ${componentName}: ${recentErrors.length} errors in 5 minutes`);
      
      // Increase severity for future errors
      const lastError = recentErrors[recentErrors.length - 1];
      if (lastError.severity !== ErrorSeverity.CRITICAL) {
        lastError.severity = ErrorSeverity.HIGH;
      }
    }
  }
  
  _determineSeverity(error) {
    // Determine severity based on error type
    if (error.code === 'ENOMEM' || error.code === 'ENOSPC') {
      return ErrorSeverity.CRITICAL;
    }
    
    if (error.code?.startsWith('E') || error.code?.startsWith('ER_')) {
      return ErrorSeverity.HIGH;
    }
    
    if (error.timeout || error.code === 'ETIMEDOUT') {
      return ErrorSeverity.MEDIUM;
    }
    
    return ErrorSeverity.LOW;
  }
  
  getMetrics() {
    return {
      ...this.metrics,
      errorRate: this.metrics.totalErrors > 0 
        ? ((this.metrics.totalErrors - this.metrics.recoveredErrors) / this.metrics.totalErrors * 100).toFixed(2) + '%'
        : '0%',
      recoveryRate: this.metrics.totalErrors > 0
        ? (this.metrics.recoveredErrors / this.metrics.totalErrors * 100).toFixed(2) + '%'
        : '0%'
    };
  }
  
  getComponentHealth() {
    const health = {};
    
    for (const [component, errors] of this.componentErrors) {
      const recentErrors = errors.filter(
        e => Date.now() - e.timestamp < 3600000 // Last hour
      );
      
      health[component] = {
        errorCount: recentErrors.length,
        lastError: recentErrors[recentErrors.length - 1]?.error.message,
        status: recentErrors.length === 0 ? 'healthy' :
                recentErrors.length < 5 ? 'degraded' : 'unhealthy'
      };
    }
    
    return health;
  }
  
  clearHistory() {
    this.errorHistory = [];
    this.componentErrors.clear();
  }
}

export default ErrorRecoverySystem;