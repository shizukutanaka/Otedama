/**
 * Advanced Error Recovery System
 * National-scale error recovery with self-healing capabilities
 */

import { EventEmitter } from 'events';
import { OtedamaError, ErrorSeverity } from './error-handler-unified.js';
import { createStructuredLogger } from './structured-logger.js';

const logger = createStructuredLogger('ErrorRecoverySystem');

export class ErrorRecoverySystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      backoffMultiplier: options.backoffMultiplier || 2,
      maxBackoff: options.maxBackoff || 30000,
      
      // Circuit breaker settings
      circuitBreakerThreshold: options.circuitBreakerThreshold || 5,
      circuitBreakerTimeout: options.circuitBreakerTimeout || 60000,
      
      // Recovery strategies
      enableAutoRecovery: options.enableAutoRecovery !== false,
      enableCircuitBreaker: options.enableCircuitBreaker !== false,
      enableFallback: options.enableFallback !== false,
      
      // Persistence
      persistErrors: options.persistErrors || false,
      errorHistorySize: options.errorHistorySize || 1000
    };
    
    // Error tracking
    this.errorHistory = [];
    this.circuitBreakers = new Map();
    this.recoveryStrategies = new Map();
    this.fallbackHandlers = new Map();
    
    // Metrics
    this.metrics = {
      totalErrors: 0,
      recoveredErrors: 0,
      failedRecoveries: 0,
      circuitBreaksTriggered: 0,
      fallbacksUsed: 0
    };
    
    this.setupDefaultStrategies();
  }

  setupDefaultStrategies() {
    // Network errors - retry with backoff
    this.addRecoveryStrategy('NETWORK', async (error, context) => {
      return await this.retryWithBackoff(
        context.operation,
        context.maxRetries || this.config.maxRetries
      );
    });
    
    // Database errors - failover to replica
    this.addRecoveryStrategy('DATABASE', async (error, context) => {
      if (context.failoverOperation) {
        logger.warn('Failing over to database replica', { error: error.message });
        return await context.failoverOperation();
      }
      throw error;
    });
    
    // Mining errors - restart worker
    this.addRecoveryStrategy('MINING', async (error, context) => {
      if (context.restartWorker) {
        logger.info('Restarting mining worker', { workerId: context.workerId });
        await context.restartWorker();
        return await context.operation();
      }
      throw error;
    });
    
    // Payment errors - queue for retry
    this.addRecoveryStrategy('PAYMENT', async (error, context) => {
      if (context.queueForRetry) {
        logger.info('Queueing payment for retry', { paymentId: context.paymentId });
        await context.queueForRetry();
        return { queued: true, paymentId: context.paymentId };
      }
      throw error;
    });
  }

  async handleError(error, context = {}) {
    this.metrics.totalErrors++;
    
    // Convert to OtedamaError if needed
    if (!(error instanceof OtedamaError)) {
      error = new OtedamaError(error.message || 'Unknown error', {
        category: context.category || 'UNKNOWN',
        severity: context.severity || ErrorSeverity.MEDIUM,
        context: context
      });
    }
    
    // Log error
    this.logError(error);
    
    // Check circuit breaker
    if (this.config.enableCircuitBreaker && this.isCircuitOpen(error.category)) {
      this.metrics.circuitBreaksTriggered++;
      
      // Try fallback if available
      if (this.config.enableFallback) {
        const fallback = this.fallbackHandlers.get(error.category);
        if (fallback) {
          this.metrics.fallbacksUsed++;
          return await fallback(error, context);
        }
      }
      
      throw new OtedamaError('Circuit breaker is open', {
        code: 'CIRCUIT_BREAKER_OPEN',
        category: error.category,
        severity: ErrorSeverity.HIGH,
        retryable: false
      });
    }
    
    // Try recovery if enabled and error is retryable
    if (this.config.enableAutoRecovery && error.retryable) {
      try {
        const result = await this.attemptRecovery(error, context);
        this.metrics.recoveredErrors++;
        this.emit('error:recovered', { error, result });
        return result;
      } catch (recoveryError) {
        this.metrics.failedRecoveries++;
        this.updateCircuitBreaker(error.category, false);
        this.emit('error:recovery:failed', { error, recoveryError });
        throw recoveryError;
      }
    }
    
    // No recovery possible
    this.updateCircuitBreaker(error.category, false);
    throw error;
  }

  async attemptRecovery(error, context) {
    const strategy = this.recoveryStrategies.get(error.category);
    
    if (!strategy) {
      throw new OtedamaError('No recovery strategy available', {
        code: 'NO_RECOVERY_STRATEGY',
        category: error.category,
        severity: ErrorSeverity.HIGH,
        retryable: false
      });
    }
    
    logger.info('Attempting error recovery', {
      errorId: error.id,
      category: error.category,
      strategy: strategy.name
    });
    
    const result = await strategy(error, context);
    this.updateCircuitBreaker(error.category, true);
    
    return result;
  }

  async retryWithBackoff(operation, maxRetries = this.config.maxRetries) {
    let lastError;
    let delay = this.config.retryDelay;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.debug(`Retry attempt ${attempt}/${maxRetries}`);
        const result = await operation();
        return result;
      } catch (error) {
        lastError = error;
        
        if (attempt < maxRetries) {
          logger.warn(`Retry failed, waiting ${delay}ms before next attempt`, {
            attempt,
            error: error.message
          });
          
          await this.sleep(delay);
          delay = Math.min(delay * this.config.backoffMultiplier, this.config.maxBackoff);
        }
      }
    }
    
    throw lastError;
  }

  isCircuitOpen(category) {
    const breaker = this.circuitBreakers.get(category);
    if (!breaker) return false;
    
    // Check if timeout has passed
    if (Date.now() - breaker.lastFailure > this.config.circuitBreakerTimeout) {
      // Reset circuit breaker
      this.circuitBreakers.delete(category);
      return false;
    }
    
    return breaker.failures >= this.config.circuitBreakerThreshold;
  }

  updateCircuitBreaker(category, success) {
    let breaker = this.circuitBreakers.get(category);
    
    if (!breaker) {
      breaker = { failures: 0, lastFailure: 0 };
      this.circuitBreakers.set(category, breaker);
    }
    
    if (success) {
      // Reset on success
      breaker.failures = 0;
    } else {
      // Increment failures
      breaker.failures++;
      breaker.lastFailure = Date.now();
    }
  }

  addRecoveryStrategy(category, strategy) {
    this.recoveryStrategies.set(category, strategy);
  }

  addFallbackHandler(category, handler) {
    this.fallbackHandlers.set(category, handler);
  }

  logError(error) {
    // Add to history
    this.errorHistory.push({
      error: error.toJSON(),
      timestamp: Date.now()
    });
    
    // Trim history
    if (this.errorHistory.length > this.config.errorHistorySize) {
      this.errorHistory.shift();
    }
    
    // Log based on severity
    const logData = {
      id: error.id,
      category: error.category,
      code: error.code,
      context: error.context
    };
    
    switch (error.severity) {
      case ErrorSeverity.CRITICAL:
        logger.error('Critical error occurred', logData);
        this.emit('error:critical', error);
        break;
      case ErrorSeverity.HIGH:
        logger.error('High severity error', logData);
        break;
      case ErrorSeverity.MEDIUM:
        logger.warn('Medium severity error', logData);
        break;
      case ErrorSeverity.LOW:
        logger.info('Low severity error', logData);
        break;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getMetrics() {
    return {
      ...this.metrics,
      errorRate: this.metrics.totalErrors > 0 
        ? (this.metrics.failedRecoveries / this.metrics.totalErrors) 
        : 0,
      recoveryRate: this.metrics.totalErrors > 0
        ? (this.metrics.recoveredErrors / this.metrics.totalErrors)
        : 0,
      circuitBreakers: Array.from(this.circuitBreakers.entries()).map(([category, breaker]) => ({
        category,
        failures: breaker.failures,
        isOpen: this.isCircuitOpen(category)
      }))
    };
  }

  getErrorHistory(category = null) {
    if (category) {
      return this.errorHistory.filter(entry => entry.error.category === category);
    }
    return this.errorHistory;
  }

  clearHistory() {
    this.errorHistory = [];
  }

  reset() {
    this.circuitBreakers.clear();
    this.errorHistory = [];
    this.metrics = {
      totalErrors: 0,
      recoveredErrors: 0,
      failedRecoveries: 0,
      circuitBreaksTriggered: 0,
      fallbacksUsed: 0
    };
  }
}

// Singleton instance
let instance = null;

export function getErrorRecoverySystem(options) {
  if (!instance) {
    instance = new ErrorRecoverySystem(options);
  }
  return instance;
}

export default ErrorRecoverySystem;