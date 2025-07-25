/**
 * Enhanced Error Handler for Otedama
 * Unified error handling with performance and simplicity
 * 
 * Design principles:
 * - Carmack: Zero-allocation error paths, fast error recovery
 * - Martin: Clean error hierarchy and handling patterns
 * - Pike: Simple but effective error management
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { createStructuredLogger } from './structured-logger.js';

// Error categories
export const ErrorCategory = {
  VALIDATION: 'VALIDATION',
  AUTHENTICATION: 'AUTHENTICATION',
  AUTHORIZATION: 'AUTHORIZATION',
  NETWORK: 'NETWORK',
  DATABASE: 'DATABASE',
  MINING: 'MINING',
  PAYMENT: 'PAYMENT',
  BLOCKCHAIN: 'BLOCKCHAIN',
  DEX: 'DEX',
  SYSTEM: 'SYSTEM',
  UNKNOWN: 'UNKNOWN'
};

// Error severity
export const ErrorSeverity = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4
};

/**
 * Base error class with context
 */
export class OtedamaError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'OtedamaError';
    this.code = options.code || 'OTEDAMA_ERROR';
    this.category = options.category || ErrorCategory.UNKNOWN;
    this.severity = options.severity || ErrorSeverity.MEDIUM;
    this.timestamp = Date.now();
    this.id = options.id || randomUUID();
    this.context = options.context || {};
    this.retryable = options.retryable !== false;
    this.statusCode = options.statusCode || 500;
    
    Error.captureStackTrace(this, this.constructor);
  }
  
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      severity: this.severity,
      timestamp: this.timestamp,
      context: this.context,
      retryable: this.retryable,
      statusCode: this.statusCode,
      stack: this.stack
    };
  }
  
  static fromJSON(json) {
    const error = new OtedamaError(json.message, {
      code: json.code,
      category: json.category,
      severity: json.severity,
      id: json.id,
      context: json.context,
      retryable: json.retryable,
      statusCode: json.statusCode
    });
    error.timestamp = json.timestamp;
    error.stack = json.stack;
    return error;
  }
}

// Specific error types
export class ValidationError extends OtedamaError {
  constructor(message, field = null, value = null) {
    super(message, {
      code: 'VALIDATION_ERROR',
      category: ErrorCategory.VALIDATION,
      severity: ErrorSeverity.LOW,
      statusCode: 400,
      context: { field, value }
    });
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends OtedamaError {
  constructor(message = 'Authentication failed') {
    super(message, {
      code: 'AUTH_ERROR',
      category: ErrorCategory.AUTHENTICATION,
      severity: ErrorSeverity.MEDIUM,
      statusCode: 401
    });
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends OtedamaError {
  constructor(message = 'Access denied', resource = null) {
    super(message, {
      code: 'AUTHZ_ERROR',
      category: ErrorCategory.AUTHORIZATION,
      severity: ErrorSeverity.MEDIUM,
      statusCode: 403,
      context: { resource }
    });
    this.name = 'AuthorizationError';
  }
}

export class NetworkError extends OtedamaError {
  constructor(message, errno = null) {
    super(message, {
      code: 'NETWORK_ERROR',
      category: ErrorCategory.NETWORK,
      severity: ErrorSeverity.HIGH,
      statusCode: 503,
      context: { errno },
      retryable: true
    });
    this.name = 'NetworkError';
  }
}

export class DatabaseError extends OtedamaError {
  constructor(message, query = null) {
    super(message, {
      code: 'DATABASE_ERROR',
      category: ErrorCategory.DATABASE,
      severity: ErrorSeverity.HIGH,
      statusCode: 500,
      context: { query },
      retryable: true
    });
    this.name = 'DatabaseError';
  }
}

export class MiningError extends OtedamaError {
  constructor(message, reason = null) {
    super(message, {
      code: 'MINING_ERROR',
      category: ErrorCategory.MINING,
      severity: ErrorSeverity.MEDIUM,
      statusCode: 500,
      context: { reason }
    });
    this.name = 'MiningError';
  }
}

export class PaymentError extends OtedamaError {
  constructor(message, transactionId = null, amount = null) {
    super(message, {
      code: 'PAYMENT_ERROR',
      category: ErrorCategory.PAYMENT,
      severity: ErrorSeverity.CRITICAL,
      statusCode: 500,
      context: { transactionId, amount },
      retryable: false
    });
    this.name = 'PaymentError';
  }
}

/**
 * High-performance circuit breaker
 */
export class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 60000;
    this.state = 'closed'; // closed, open, half-open
    this.failures = 0;
    this.nextAttempt = 0;
    this.successCount = 0;
    this.halfOpenLimit = options.halfOpenLimit || 3;
  }
  
  async execute(operation, fallback = null) {
    if (this.state === 'open') {
      if (Date.now() < this.nextAttempt) {
        if (fallback) return fallback();
        throw new NetworkError(`Circuit breaker ${this.name} is open`);
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
      if (fallback) return fallback();
      throw error;
    }
  }
  
  onSuccess() {
    this.failures = 0;
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.halfOpenLimit) {
        this.state = 'closed';
      }
    }
  }
  
  onFailure() {
    this.failures++;
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.nextAttempt = Date.now() + this.resetTimeout;
    }
  }
  
  reset() {
    this.state = 'closed';
    this.failures = 0;
    this.successCount = 0;
  }
  
  getState() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      isOpen: this.state === 'open'
    };
  }
}

/**
 * Unified error handler
 */
export class ErrorHandler extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.logger = createStructuredLogger('ErrorHandler');
    this.circuitBreakers = new Map();
    this.metrics = {
      total: 0,
      byCategory: new Map(),
      bySeverity: new Map(),
      recovered: 0
    };
    
    // Error recovery strategies
    this.recoveryStrategies = new Map();
    this.setupDefaultStrategies();
    
    // Setup global handlers if requested
    if (options.global) {
      this.setupGlobalHandlers();
    }
  }
  
  setupDefaultStrategies() {
    // Network errors: retry with exponential backoff
    this.recoveryStrategies.set(ErrorCategory.NETWORK, async (error, attempt = 0) => {
      if (attempt >= 3) return false;
      await this.sleep(Math.pow(2, attempt) * 1000);
      return true;
    });
    
    // Database errors: retry once after delay
    this.recoveryStrategies.set(ErrorCategory.DATABASE, async (error, attempt = 0) => {
      if (attempt >= 1) return false;
      await this.sleep(2000);
      return true;
    });
  }
  
  setupGlobalHandlers() {
    process.on('unhandledRejection', (reason, promise) => {
      this.handleError(new OtedamaError(`Unhandled rejection: ${reason}`, {
        code: 'UNHANDLED_REJECTION',
        severity: ErrorSeverity.HIGH
      }));
    });
    
    process.on('uncaughtException', (error) => {
      this.handleError(new OtedamaError(`Uncaught exception: ${error.message}`, {
        code: 'UNCAUGHT_EXCEPTION',
        severity: ErrorSeverity.CRITICAL,
        context: { originalError: error }
      }));
      
      // Give time for logging before exit
      setTimeout(() => process.exit(1), 1000);
    });
  }
  
  /**
   * Handle error with recovery
   */
  async handleError(error, options = {}) {
    // Convert to OtedamaError if needed
    const otedamaError = error instanceof OtedamaError 
      ? error 
      : new OtedamaError(error.message, {
          context: { originalError: error.name, stack: error.stack }
        });
    
    // Update metrics
    this.updateMetrics(otedamaError);
    
    // Log error
    this.logError(otedamaError);
    
    // Emit for monitoring
    this.emit('error', otedamaError);
    
    // Attempt recovery if enabled
    if (options.recover && otedamaError.retryable) {
      const recovered = await this.attemptRecovery(otedamaError, options);
      if (recovered) {
        this.metrics.recovered++;
        this.emit('recovered', otedamaError);
        return null;
      }
    }
    
    return otedamaError;
  }
  
  /**
   * Create or get circuit breaker
   */
  getCircuitBreaker(name, options) {
    if (!this.circuitBreakers.has(name)) {
      this.circuitBreakers.set(name, new CircuitBreaker(name, options));
    }
    return this.circuitBreakers.get(name);
  }
  
  /**
   * Execute with error handling
   */
  async execute(operation, options = {}) {
    const {
      name = 'operation',
      circuit = null,
      retry = true,
      fallback = null,
      timeout = null
    } = options;
    
    try {
      let promise = operation();
      
      // Apply timeout if specified
      if (timeout) {
        promise = Promise.race([
          promise,
          new Promise((_, reject) => 
            setTimeout(() => reject(new NetworkError('Operation timed out')), timeout)
          )
        ]);
      }
      
      // Apply circuit breaker if specified
      if (circuit) {
        const breaker = this.getCircuitBreaker(circuit.name || name, circuit);
        return await breaker.execute(() => promise, fallback);
      }
      
      return await promise;
      
    } catch (error) {
      const handled = await this.handleError(error, { recover: retry });
      if (handled && fallback) {
        return fallback(handled);
      }
      throw handled || error;
    }
  }
  
  /**
   * Express middleware
   */
  middleware() {
    return async (error, req, res, next) => {
      const otedamaError = await this.handleError(error);
      
      res.status(otedamaError.statusCode).json({
        error: {
          id: otedamaError.id,
          code: otedamaError.code,
          message: otedamaError.message,
          details: otedamaError.context
        }
      });
    };
  }
  
  // Private methods
  
  updateMetrics(error) {
    this.metrics.total++;
    
    const categoryCount = this.metrics.byCategory.get(error.category) || 0;
    this.metrics.byCategory.set(error.category, categoryCount + 1);
    
    const severityCount = this.metrics.bySeverity.get(error.severity) || 0;
    this.metrics.bySeverity.set(error.severity, severityCount + 1);
  }
  
  logError(error) {
    const logData = {
      id: error.id,
      code: error.code,
      category: error.category,
      severity: error.severity,
      message: error.message,
      context: error.context,
      stack: error.stack
    };
    
    switch (error.severity) {
      case ErrorSeverity.LOW:
        this.logger.warn('Error occurred', logData);
        break;
      case ErrorSeverity.MEDIUM:
      case ErrorSeverity.HIGH:
        this.logger.error('Error occurred', logData);
        break;
      case ErrorSeverity.CRITICAL:
        this.logger.error('CRITICAL ERROR', logData);
        break;
    }
  }
  
  async attemptRecovery(error, options) {
    const strategy = this.recoveryStrategies.get(error.category);
    if (!strategy) return false;
    
    const attempt = options.attempt || 0;
    return strategy(error, attempt);
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  getMetrics() {
    return {
      ...this.metrics,
      byCategory: Object.fromEntries(this.metrics.byCategory),
      bySeverity: Object.fromEntries(this.metrics.bySeverity),
      circuitBreakers: Array.from(this.circuitBreakers.values()).map(cb => cb.getState())
    };
  }
  
  reset() {
    this.metrics.total = 0;
    this.metrics.byCategory.clear();
    this.metrics.bySeverity.clear();
    this.metrics.recovered = 0;
    this.circuitBreakers.forEach(cb => cb.reset());
  }
}

// Singleton instance
let errorHandler = null;

export function getErrorHandler(options = {}) {
  if (!errorHandler) {
    errorHandler = new ErrorHandler(options);
  }
  return errorHandler;
}

// Utility functions
export async function withRetry(operation, maxAttempts = 3, delay = 1000) {
  let lastError;
  
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (i < maxAttempts - 1 && (!error.retryable || error.retryable)) {
        await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
      }
    }
  }
  
  throw lastError;
}

export function withTimeout(promise, ms, message = 'Operation timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new NetworkError(message)), ms)
    )
  ]);
}

export function wrapAsync(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Export all
export default {
  // Error classes
  OtedamaError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NetworkError,
  DatabaseError,
  MiningError,
  PaymentError,
  
  // Constants
  ErrorCategory,
  ErrorSeverity,
  
  // Classes
  CircuitBreaker,
  ErrorHandler,
  
  // Functions
  getErrorHandler,
  withRetry,
  withTimeout,
  wrapAsync
};
