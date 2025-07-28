/**
 * Error Boundary for Critical Components - Otedama
 * Provides error handling and recovery for critical system components
 */

import { createStructuredLogger } from './structured-logger.js';
import { EventEmitter } from 'events';

const logger = createStructuredLogger('ErrorBoundary');

export class ErrorBoundary extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      exponentialBackoff: options.exponentialBackoff !== false,
      captureStackTrace: options.captureStackTrace !== false,
      onError: options.onError || null,
      onRecovery: options.onRecovery || null,
      ...options
    };
    
    this.errorHistory = [];
    this.recoveryStrategies = new Map();
  }
  
  /**
   * Wrap a function with error boundary protection
   */
  wrap(fn, context = null) {
    return async (...args) => {
      let lastError;
      let retries = 0;
      
      while (retries <= this.options.maxRetries) {
        try {
          return await fn.apply(context, args);
        } catch (error) {
          lastError = error;
          
          // Log error
          logger.error('Error caught in boundary', {
            function: fn.name,
            error: error.message,
            stack: this.options.captureStackTrace ? error.stack : undefined,
            retry: retries,
            args: args.length
          });
          
          // Record error
          this.recordError(error, fn.name, args);
          
          // Call error handler
          if (this.options.onError) {
            await this.options.onError(error, { fn, args, retry: retries });
          }
          
          // Emit error event
          this.emit('error', {
            error,
            function: fn.name,
            retry: retries
          });
          
          // Check if we should retry
          if (retries >= this.options.maxRetries) {
            throw new BoundaryError(
              `Function ${fn.name} failed after ${retries} retries`,
              error
            );
          }
          
          // Try recovery strategy if available
          const recovered = await this.tryRecovery(error, fn.name);
          if (recovered) {
            return recovered;
          }
          
          // Calculate delay
          const delay = this.calculateDelay(retries);
          
          logger.info(`Retrying ${fn.name} after ${delay}ms`, {
            retry: retries + 1,
            maxRetries: this.options.maxRetries
          });
          
          // Wait before retry
          await this.delay(delay);
          
          retries++;
        }
      }
      
      throw lastError;
    };
  }
  
  /**
   * Wrap a class method with error boundary
   */
  wrapMethod(instance, methodName) {
    const original = instance[methodName];
    if (typeof original !== 'function') {
      throw new Error(`${methodName} is not a function`);
    }
    
    instance[methodName] = this.wrap(original, instance);
  }
  
  /**
   * Wrap all methods of a class instance
   */
  wrapAll(instance, exclude = []) {
    const proto = Object.getPrototypeOf(instance);
    const methodNames = Object.getOwnPropertyNames(proto)
      .filter(name => {
        return name !== 'constructor' &&
               !exclude.includes(name) &&
               typeof instance[name] === 'function';
      });
    
    for (const methodName of methodNames) {
      this.wrapMethod(instance, methodName);
    }
  }
  
  /**
   * Register recovery strategy
   */
  registerRecoveryStrategy(errorType, strategy) {
    this.recoveryStrategies.set(errorType, strategy);
  }
  
  /**
   * Try to recover from error
   */
  async tryRecovery(error, functionName) {
    const errorType = error.constructor.name;
    const strategy = this.recoveryStrategies.get(errorType);
    
    if (!strategy) {
      return null;
    }
    
    try {
      logger.info(`Attempting recovery for ${errorType}`, { function: functionName });
      const result = await strategy(error, functionName);
      
      if (result !== null && result !== undefined) {
        logger.info(`Recovery successful for ${errorType}`, { function: functionName });
        
        if (this.options.onRecovery) {
          await this.options.onRecovery(error, result);
        }
        
        this.emit('recovery', {
          error,
          function: functionName,
          result
        });
        
        return result;
      }
    } catch (recoveryError) {
      logger.error('Recovery strategy failed', {
        errorType,
        function: functionName,
        error: recoveryError.message
      });
    }
    
    return null;
  }
  
  /**
   * Record error for analysis
   */
  recordError(error, functionName, args) {
    const errorRecord = {
      timestamp: Date.now(),
      error: {
        message: error.message,
        type: error.constructor.name,
        stack: this.options.captureStackTrace ? error.stack : undefined
      },
      function: functionName,
      argsCount: args.length
    };
    
    this.errorHistory.push(errorRecord);
    
    // Keep only recent errors
    if (this.errorHistory.length > 1000) {
      this.errorHistory.shift();
    }
  }
  
  /**
   * Calculate retry delay with exponential backoff
   */
  calculateDelay(retryCount) {
    if (!this.options.exponentialBackoff) {
      return this.options.retryDelay;
    }
    
    return Math.min(
      this.options.retryDelay * Math.pow(2, retryCount),
      30000 // Max 30 seconds
    );
  }
  
  /**
   * Delay helper
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Get error statistics
   */
  getErrorStats() {
    const stats = {
      totalErrors: this.errorHistory.length,
      errorsByType: {},
      errorsByFunction: {},
      recentErrors: this.errorHistory.slice(-10)
    };
    
    for (const record of this.errorHistory) {
      // By type
      const type = record.error.type;
      stats.errorsByType[type] = (stats.errorsByType[type] || 0) + 1;
      
      // By function
      const func = record.function;
      stats.errorsByFunction[func] = (stats.errorsByFunction[func] || 0) + 1;
    }
    
    return stats;
  }
  
  /**
   * Clear error history
   */
  clearHistory() {
    this.errorHistory = [];
  }
}

/**
 * Custom error class for boundary errors
 */
export class BoundaryError extends Error {
  constructor(message, originalError) {
    super(message);
    this.name = 'BoundaryError';
    this.originalError = originalError;
  }
}

/**
 * Create a function-specific error boundary
 */
export function withErrorBoundary(fn, options = {}) {
  const boundary = new ErrorBoundary(options);
  return boundary.wrap(fn);
}

/**
 * Decorator for class methods
 */
export function errorBoundary(options = {}) {
  return function(target, propertyKey, descriptor) {
    const originalMethod = descriptor.value;
    const boundary = new ErrorBoundary(options);
    
    descriptor.value = boundary.wrap(originalMethod);
    
    return descriptor;
  };
}

/**
 * Global error boundary for uncaught errors
 */
export class GlobalErrorBoundary extends ErrorBoundary {
  constructor(options = {}) {
    super(options);
    this.installed = false;
  }
  
  /**
   * Install global handlers
   */
  install() {
    if (this.installed) {
      return;
    }
    
    // Uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception', {
        error: error.message,
        stack: error.stack
      });
      
      this.recordError(error, 'uncaughtException', []);
      this.emit('uncaughtException', error);
      
      // Attempt graceful shutdown
      if (this.options.onFatalError) {
        this.options.onFatalError(error);
      } else {
        process.exit(1);
      }
    });
    
    // Unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      
      logger.error('Unhandled rejection', {
        error: error.message,
        stack: error.stack
      });
      
      this.recordError(error, 'unhandledRejection', [promise]);
      this.emit('unhandledRejection', error, promise);
    });
    
    // Warning events
    process.on('warning', (warning) => {
      logger.warn('Process warning', {
        name: warning.name,
        message: warning.message,
        stack: warning.stack
      });
      
      this.emit('warning', warning);
    });
    
    this.installed = true;
    logger.info('Global error boundary installed');
  }
  
  /**
   * Uninstall global handlers
   */
  uninstall() {
    if (!this.installed) {
      return;
    }
    
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('warning');
    
    this.installed = false;
    logger.info('Global error boundary uninstalled');
  }
}

export default ErrorBoundary;