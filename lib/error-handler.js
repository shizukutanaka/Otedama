/**
 * Error Handler for Otedama
 * Centralized error handling with recovery strategies
 */

import { EventEmitter } from 'events';

// Error categories
export const ErrorCategory = {
  DATABASE: 'DATABASE_ERROR',
  NETWORK: 'NETWORK_ERROR',
  VALIDATION: 'VALIDATION_ERROR',
  PAYMENT: 'PAYMENT_ERROR',
  MINING: 'MINING_ERROR',
  WEBSOCKET: 'WEBSOCKET_ERROR',
  API: 'API_ERROR',
  FILE_IO: 'FILE_IO_ERROR',
  UNKNOWN: 'UNKNOWN_ERROR',
  EXTERNAL_API: 'EXTERNAL_API_ERROR',
  RATE_LIMIT: 'RATE_LIMIT_ERROR'
};

// Custom error class
export class OtedamaError extends Error {
  constructor(message, category = ErrorCategory.UNKNOWN, details = {}) {
    super(message);
    this.name = 'OtedamaError';
    this.category = category;
    this.details = details;
    this.timestamp = new Date();
  }
}

// Circuit Breaker class for handling external service failures
export class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 60000; // 1 minute
    this.successThreshold = options.successThreshold || 2;
    
    this.state = 'closed'; // closed, open, half-open
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttempt = Date.now();
  }

  async execute(operation, fallback = null) {
    if (this.state === 'open') {
      if (Date.now() < this.nextAttempt) {
        if (fallback) {
          return await fallback();
        }
        throw new OtedamaError(
          'Circuit breaker is open',
          ErrorCategory.EXTERNAL_API,
          { state: this.state, nextAttempt: this.nextAttempt }
        );
      }
      this.state = 'half-open';
      this.successCount = 0;
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      if (fallback && this.state === 'open') {
        return await fallback();
      }
      throw error;
    }
  }

  onSuccess() {
    this.failureCount = 0;
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'closed';
      }
    }
  }

  onFailure() {
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
      this.nextAttempt = Date.now() + this.resetTimeout;
    }
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      nextAttempt: this.nextAttempt
    };
  }
}

export class ErrorHandler extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.errorCounts = new Map();
    this.circuitBreakers = new Map();
    
    // Error categories
    this.ERROR_TYPES = {
      DATABASE: 'DATABASE_ERROR',
      NETWORK: 'NETWORK_ERROR',
      VALIDATION: 'VALIDATION_ERROR',
      PAYMENT: 'PAYMENT_ERROR',
      MINING: 'MINING_ERROR',
      WEBSOCKET: 'WEBSOCKET_ERROR',
      API: 'API_ERROR',
      FILE_IO: 'FILE_IO_ERROR',
      UNKNOWN: 'UNKNOWN_ERROR'
    };
    
    // Circuit breaker settings
    this.CIRCUIT_BREAKER = {
      threshold: 5, // errors before opening
      timeout: 60000, // 1 minute cooldown
      halfOpenAttempts: 3 // attempts in half-open state
    };
  }

  /**
   * Handle error with appropriate strategy
   */
  async handleError(error, context = {}) {
    const errorType = this.categorizeError(error);
    const errorId = this.generateErrorId();
    
    // Log error with context
    this.logError(error, errorType, context, errorId);
    
    // Update error counts
    this.updateErrorCounts(errorType);
    
    // Check circuit breaker
    if (context.service) {
      const breaker = this.getCircuitBreaker(context.service);
      if (breaker.state === 'open') {
        throw new Error(`Service ${context.service} is temporarily unavailable`);
      }
    }
    
    // Apply recovery strategy
    const recoveryStrategy = this.getRecoveryStrategy(errorType);
    if (recoveryStrategy) {
      try {
        return await recoveryStrategy(error, context);
      } catch (recoveryError) {
        this.logger.error(`Recovery failed for ${errorType}:`, recoveryError);
      }
    }
    
    // Emit error event for monitoring
    this.emit('error', {
      errorId,
      type: errorType,
      error,
      context,
      timestamp: Date.now()
    });
    
    throw error;
  }

  /**
   * Categorize error by type
   */
  categorizeError(error) {
    const message = error.message?.toLowerCase() || '';
    const code = error.code || '';
    
    if (message.includes('database') || message.includes('sqlite') || code.includes('SQLITE')) {
      return this.ERROR_TYPES.DATABASE;
    }
    if (message.includes('network') || message.includes('fetch') || code.includes('ECONN')) {
      return this.ERROR_TYPES.NETWORK;
    }
    if (message.includes('validation') || message.includes('invalid')) {
      return this.ERROR_TYPES.VALIDATION;
    }
    if (message.includes('payment') || message.includes('payout')) {
      return this.ERROR_TYPES.PAYMENT;
    }
    if (message.includes('mining') || message.includes('share')) {
      return this.ERROR_TYPES.MINING;
    }
    if (message.includes('websocket') || message.includes('ws')) {
      return this.ERROR_TYPES.WEBSOCKET;
    }
    if (message.includes('api') || code.includes('HTTP')) {
      return this.ERROR_TYPES.API;
    }
    if (code.includes('ENOENT') || code.includes('EACCES')) {
      return this.ERROR_TYPES.FILE_IO;
    }
    
    return this.ERROR_TYPES.UNKNOWN;
  }

  /**
   * Log error with full context
   */
  logError(error, type, context, errorId) {
    const errorDetails = {
      errorId,
      type,
      message: error.message,
      stack: error.stack,
      code: error.code,
      context,
      timestamp: new Date().toISOString()
    };
    
    this.logger.error(`[${type}] ${error.message}`, errorDetails);
  }

  /**
   * Update error counts for monitoring
   */
  updateErrorCounts(type) {
    const count = this.errorCounts.get(type) || 0;
    this.errorCounts.set(type, count + 1);
    
    // Check if circuit breaker should open
    if (count >= this.CIRCUIT_BREAKER.threshold) {
      this.openCircuitBreaker(type);
    }
  }

  /**
   * Get circuit breaker for service
   */
  getCircuitBreaker(service) {
    if (!this.circuitBreakers.has(service)) {
      this.circuitBreakers.set(service, {
        state: 'closed',
        failures: 0,
        lastFailure: null,
        nextAttempt: null
      });
    }
    return this.circuitBreakers.get(service);
  }

  /**
   * Open circuit breaker for service
   */
  openCircuitBreaker(service) {
    const breaker = this.getCircuitBreaker(service);
    breaker.state = 'open';
    breaker.nextAttempt = Date.now() + this.CIRCUIT_BREAKER.timeout;
    
    this.logger.warn(`Circuit breaker opened for ${service}`);
    
    // Schedule half-open transition
    setTimeout(() => {
      breaker.state = 'half-open';
      breaker.failures = 0;
    }, this.CIRCUIT_BREAKER.timeout);
  }

  /**
   * Get recovery strategy for error type
   */
  getRecoveryStrategy(type) {
    const strategies = {
      [this.ERROR_TYPES.DATABASE]: async (error, context) => {
        // Retry with exponential backoff
        if (context.retryCount < 3) {
          const delay = Math.pow(2, context.retryCount) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
          context.retryCount = (context.retryCount || 0) + 1;
          throw error; // Retry
        }
      },
      
      [this.ERROR_TYPES.NETWORK]: async (error, context) => {
        // Use fallback URL or cached data
        if (context.fallbackUrl) {
          return { usedFallback: true, url: context.fallbackUrl };
        }
        if (context.cachedData) {
          return { usedCache: true, data: context.cachedData };
        }
      },
      
      [this.ERROR_TYPES.PAYMENT]: async (error, context) => {
        // Queue for retry
        if (context.payment) {
          await this.queuePaymentRetry(context.payment);
          return { queued: true, paymentId: context.payment.id };
        }
      }
    };
    
    return strategies[type];
  }

  /**
   * Queue payment for retry
   */
  async queuePaymentRetry(payment) {
    // Implementation would queue the payment for later retry
    this.logger.info(`Payment ${payment.id} queued for retry`);
  }

  /**
   * Generate unique error ID
   */
  generateErrorId() {
    return `ERR_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get error statistics
   */
  getStats() {
    const stats = {
      errors: Object.fromEntries(this.errorCounts),
      circuitBreakers: Object.fromEntries(
        Array.from(this.circuitBreakers.entries()).map(([service, breaker]) => [
          service,
          { state: breaker.state, failures: breaker.failures }
        ])
      )
    };
    return stats;
  }

  /**
   * Reset error counts
   */
  resetCounts() {
    this.errorCounts.clear();
  }
}

/**
 * Create wrapped function with error handling
 */
export function withErrorHandling(fn, errorHandler, context = {}) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return errorHandler.handleError(error, { ...context, function: fn.name });
    }
  };
}

/**
 * Retry decorator with exponential backoff
 */
export function retry(attempts = 3, delay = 1000) {
  return function(target, propertyKey, descriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function(...args) {
      let lastError;
      
      for (let i = 0; i < attempts; i++) {
        try {
          return await originalMethod.apply(this, args);
        } catch (error) {
          lastError = error;
          if (i < attempts - 1) {
            const waitTime = delay * Math.pow(2, i);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
      }
      
      throw lastError;
    };
    
    return descriptor;
  };
}

// Global error handler instance
let globalErrorHandler = null;

/**
 * Initialize the global error handler
 */
export function initializeErrorHandler(options = {}) {
  if (!globalErrorHandler) {
    // Create a simple logger if none provided
    const logger = options.logger || {
      error: (msg, details) => console.error(msg, details),
      warn: (msg) => console.warn(msg),
      info: (msg) => console.info(msg)
    };
    
    globalErrorHandler = new ErrorHandler(logger);
  }
  return globalErrorHandler;
}

/**
 * Get the global error handler
 */
export function getErrorHandler() {
  if (!globalErrorHandler) {
    // Auto-initialize with default settings if not already initialized
    console.warn('Error handler not initialized, auto-initializing with defaults');
    initializeErrorHandler({ logger: console });
  }
  return globalErrorHandler;
}

/**
 * Safe execution wrapper with error handling
 */
export async function safeExecute(fn, options = {}) {
  const {
    service = 'unknown',
    maxRetries = 3,
    retryDelay = 1000,
    fallback,
    context = {}
  } = options;
  
  const errorHandler = getErrorHandler();
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Log the error
      errorHandler.handleError(error, {
        service,
        attempt: attempt + 1,
        ...context
      }).catch(() => {}); // Don't throw from error handler
      
      // If this is not the last attempt, wait and retry
      if (attempt < maxRetries - 1) {
        const delay = retryDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // All retries failed
  if (fallback) {
    return fallback(lastError);
  }
  
  throw lastError;
}