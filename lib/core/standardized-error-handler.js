/**
 * Standardized Error Handler for Otedama
 * Provides consistent error handling patterns across the entire codebase
 * 
 * Design principles:
 * - Martin: Clean error interfaces and recovery strategies
 * - Carmack: Performance-focused error handling
 * - Pike: Simple but comprehensive error management
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { getLogger } from './logger.js';

// Comprehensive error categories
export const ErrorCategory = {
  // Technical errors
  DATABASE: 'DATABASE_ERROR',
  NETWORK: 'NETWORK_ERROR',
  FILE_IO: 'FILE_IO_ERROR',
  MEMORY: 'MEMORY_ERROR',
  TIMEOUT: 'TIMEOUT_ERROR',
  
  // Business logic errors
  VALIDATION: 'VALIDATION_ERROR',
  AUTHENTICATION: 'AUTHENTICATION_ERROR',
  AUTHORIZATION: 'AUTHORIZATION_ERROR',
  RATE_LIMIT: 'RATE_LIMIT_ERROR',
  CONFLICT: 'CONFLICT_ERROR',
  
  // Domain-specific errors
  MINING: 'MINING_ERROR',
  DEX: 'DEX_ERROR',
  DEFI: 'DEFI_ERROR',
  PAYMENT: 'PAYMENT_ERROR',
  BLOCKCHAIN: 'BLOCKCHAIN_ERROR',
  
  // External service errors
  EXTERNAL_API: 'EXTERNAL_API_ERROR',
  WEBSOCKET: 'WEBSOCKET_ERROR',
  THIRD_PARTY: 'THIRD_PARTY_ERROR',
  
  // System errors
  CONFIGURATION: 'CONFIGURATION_ERROR',
  STARTUP: 'STARTUP_ERROR',
  SHUTDOWN: 'SHUTDOWN_ERROR',
  UNKNOWN: 'UNKNOWN_ERROR'
};

// Error severity levels
export const ErrorSeverity = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

// Recovery strategies
export const RecoveryStrategy = {
  RETRY: 'retry',
  FALLBACK: 'fallback',
  CIRCUIT_BREAKER: 'circuit_breaker',
  GRACEFUL_DEGRADATION: 'graceful_degradation',
  FAIL_FAST: 'fail_fast',
  IGNORE: 'ignore'
};

/**
 * Enhanced Otedama Error class with comprehensive context
 */
export class OtedamaError extends Error {
  constructor(message, options = {}) {
    super(message);
    
    this.name = 'OtedamaError';
    this.category = options.category || ErrorCategory.UNKNOWN;
    this.severity = options.severity || ErrorSeverity.MEDIUM;
    this.code = options.code || this._generateErrorCode();
    this.details = options.details || {};
    this.context = options.context || {};
    this.timestamp = new Date();
    this.requestId = options.requestId || randomUUID();
    this.recoveryStrategy = options.recoveryStrategy || RecoveryStrategy.FAIL_FAST;
    this.retryable = options.retryable !== false;
    this.userMessage = options.userMessage || null;
    
    // Stack trace enhancement
    Error.captureStackTrace(this, OtedamaError);
    
    // Add operation context if provided
    if (options.operation) {
      this.operation = options.operation;
    }
    
    // Add timing information
    if (options.startTime) {
      this.duration = Date.now() - options.startTime;
    }
  }
  
  /**
   * Generate unique error code
   */
  _generateErrorCode() {
    return `ERR_${Date.now()}_${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
  }
  
  /**
   * Convert to standard API response format
   */
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        category: this.category,
        severity: this.severity,
        details: this.details,
        context: this.context,
        timestamp: this.timestamp.toISOString(),
        requestId: this.requestId,
        retryable: this.retryable,
        userMessage: this.userMessage
      }
    };
  }
  
  /**
   * Convert to HTTP response format
   */
  toHttpResponse() {
    const statusCode = this._getHttpStatusCode();
    return {
      statusCode,
      body: this.toJSON()
    };
  }
  
  /**
   * Map error category to HTTP status code
   */
  _getHttpStatusCode() {
    switch (this.category) {
      case ErrorCategory.VALIDATION:
        return 400;
      case ErrorCategory.AUTHENTICATION:
        return 401;
      case ErrorCategory.AUTHORIZATION:
        return 403;
      case ErrorCategory.RATE_LIMIT:
        return 429;
      case ErrorCategory.CONFLICT:
        return 409;
      case ErrorCategory.TIMEOUT:
        return 408;
      case ErrorCategory.DATABASE:
      case ErrorCategory.FILE_IO:
      case ErrorCategory.MEMORY:
        return 500;
      case ErrorCategory.EXTERNAL_API:
      case ErrorCategory.THIRD_PARTY:
        return 502;
      case ErrorCategory.CONFIGURATION:
        return 503;
      default:
        return 500;
    }
  }
}

/**
 * Enhanced Circuit Breaker with multiple strategies
 */
export class EnhancedCircuitBreaker extends EventEmitter {
  constructor(name, options = {}) {
    super();
    
    this.name = name;
    this.options = {
      failureThreshold: options.failureThreshold || 5,
      successThreshold: options.successThreshold || 2,
      timeout: options.timeout || 60000,
      halfOpenMaxCalls: options.halfOpenMaxCalls || 3,
      ...options
    };
    
    this.state = 'closed'; // closed, open, half-open
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttempt = Date.now();
    this.halfOpenCount = 0;
    
    this.logger = getLogger(`CircuitBreaker:${name}`);
  }
  
  async execute(operation, fallback = null) {
    if (this.state === 'open') {
      if (Date.now() < this.nextAttempt) {
        return this._handleOpenState(fallback);
      }
      
      // Transition to half-open
      this.state = 'half-open';
      this.halfOpenCount = 0;
      this.logger.info(`Circuit breaker ${this.name} transitioning to half-open`);
      this.emit('stateChange', { state: this.state, name: this.name });
    }
    
    if (this.state === 'half-open') {
      if (this.halfOpenCount >= this.options.halfOpenMaxCalls) {
        return this._handleOpenState(fallback);
      }
      this.halfOpenCount++;
    }
    
    try {
      const result = await operation();
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure(error);
      
      if (fallback) {
        try {
          return await fallback(error);
        } catch (fallbackError) {
          throw new OtedamaError(`Circuit breaker ${this.name} operation and fallback failed`, {
            category: ErrorCategory.EXTERNAL_API,
            details: {
              originalError: error.message,
              fallbackError: fallbackError.message
            }
          });
        }
      }
      
      throw error;
    }
  }
  
  _handleOpenState(fallback) {
    if (fallback) {
      return fallback(new OtedamaError(`Circuit breaker ${this.name} is open`, {
        category: ErrorCategory.EXTERNAL_API,
        recoveryStrategy: RecoveryStrategy.CIRCUIT_BREAKER
      }));
    }
    
    throw new OtedamaError(`Circuit breaker ${this.name} is open`, {
      category: ErrorCategory.EXTERNAL_API,
      recoveryStrategy: RecoveryStrategy.CIRCUIT_BREAKER,
      retryable: true
    });
  }
  
  _onSuccess() {
    this.failureCount = 0;
    
    if (this.state === 'half-open') {
      this.successCount++;
      
      if (this.successCount >= this.options.successThreshold) {
        this.state = 'closed';
        this.successCount = 0;
        this.logger.info(`Circuit breaker ${this.name} closed`);
        this.emit('stateChange', { state: this.state, name: this.name });
      }
    }
  }
  
  _onFailure(error) {
    this.failureCount++;
    
    if (this.state === 'half-open') {
      this.state = 'open';
      this.nextAttempt = Date.now() + this.options.timeout;
      this.logger.warn(`Circuit breaker ${this.name} opened from half-open state`);
      this.emit('stateChange', { state: this.state, name: this.name });
    } else if (this.failureCount >= this.options.failureThreshold) {
      this.state = 'open';
      this.nextAttempt = Date.now() + this.options.timeout;
      this.logger.warn(`Circuit breaker ${this.name} opened due to failures`);
      this.emit('stateChange', { state: this.state, name: this.name });
    }
    
    this.emit('failure', { error, name: this.name, count: this.failureCount });
  }
  
  getStats() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      nextAttempt: this.nextAttempt,
      isOpen: this.state === 'open',
      isHalfOpen: this.state === 'half-open'
    };
  }
}

/**
 * Retry handler with exponential backoff
 */
export class RetryHandler {
  constructor(options = {}) {
    this.options = {
      maxRetries: options.maxRetries || 3,
      initialDelay: options.initialDelay || 1000,
      maxDelay: options.maxDelay || 30000,
      backoffFactor: options.backoffFactor || 2,
      jitter: options.jitter !== false,
      ...options
    };
  }
  
  async execute(operation, retryCondition = null) {
    let lastError;
    
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        
        // Check if we should retry
        if (attempt === this.options.maxRetries) {
          break;
        }
        
        if (retryCondition && !retryCondition(error, attempt)) {
          break;
        }
        
        if (error instanceof OtedamaError && !error.retryable) {
          break;
        }
        
        // Calculate delay with exponential backoff
        const delay = this._calculateDelay(attempt);
        await this._sleep(delay);
      }
    }
    
    throw new OtedamaError(`Operation failed after ${this.options.maxRetries + 1} attempts`, {
      category: ErrorCategory.NETWORK,
      details: {
        lastError: lastError.message,
        attempts: this.options.maxRetries + 1
      },
      retryable: false
    });
  }
  
  _calculateDelay(attempt) {
    const exponentialDelay = this.options.initialDelay * Math.pow(this.options.backoffFactor, attempt);
    const delay = Math.min(exponentialDelay, this.options.maxDelay);
    
    if (this.options.jitter) {
      // Add random jitter to prevent thundering herd
      return delay * (0.5 + Math.random() * 0.5);
    }
    
    return delay;
  }
  
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Centralized Error Handler Manager
 */
export class StandardizedErrorHandler extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableMetrics: options.enableMetrics !== false,
      enableCircuitBreakers: options.enableCircuitBreakers !== false,
      enableRetry: options.enableRetry !== false,
      logErrors: options.logErrors !== false,
      ...options
    };
    
    this.logger = getLogger('StandardizedErrorHandler');
    this.circuitBreakers = new Map();
    this.metrics = {
      totalErrors: 0,
      errorsByCategory: new Map(),
      errorsBySeverity: new Map(),
      recoveryAttempts: 0,
      successfulRecoveries: 0
    };
  }
  
  /**
   * Create standardized error with context
   */
  createError(message, options = {}) {
    const error = new OtedamaError(message, options);
    
    if (this.options.enableMetrics) {
      this._recordError(error);
    }
    
    return error;
  }
  
  /**
   * Handle error with appropriate recovery strategy
   */
  async handleError(error, recoveryOptions = {}) {
    let processedError = error;
    
    // Convert regular errors to OtedamaError
    if (!(error instanceof OtedamaError)) {
      processedError = new OtedamaError(error.message, {
        category: ErrorCategory.UNKNOWN,
        details: { originalError: error.name },
        context: recoveryOptions.context
      });
    }
    
    if (this.options.enableMetrics) {
      this._recordError(processedError);
    }
    
    this.emit('error', processedError);
    
    // Apply recovery strategy
    if (recoveryOptions.strategy) {
      return this._applyRecoveryStrategy(processedError, recoveryOptions);
    }
    
    return processedError;
  }
  
  /**
   * Get or create circuit breaker
   */
  getCircuitBreaker(name, options = {}) {
    if (!this.circuitBreakers.has(name)) {
      const breaker = new EnhancedCircuitBreaker(name, options);
      
      breaker.on('stateChange', (data) => {
        this.emit('circuitBreakerStateChange', data);
      });
      
      breaker.on('failure', (data) => {
        this.emit('circuitBreakerFailure', data);
      });
      
      this.circuitBreakers.set(name, breaker);
    }
    
    return this.circuitBreakers.get(name);
  }
  
  /**
   * Execute operation with error handling
   */
  async executeWithHandling(operation, options = {}) {
    const startTime = Date.now();
    
    try {
      // Apply circuit breaker if specified
      if (options.circuitBreaker) {
        const breaker = this.getCircuitBreaker(options.circuitBreaker.name, options.circuitBreaker);
        return await breaker.execute(operation, options.fallback);
      }
      
      // Apply retry if specified
      if (options.retry) {
        const retryHandler = new RetryHandler(options.retry);
        return await retryHandler.execute(operation, options.retryCondition);
      }
      
      return await operation();
      
    } catch (error) {
      const enhancedError = await this.handleError(error, {
        ...options,
        context: {
          operation: options.operationName,
          startTime,
          duration: Date.now() - startTime
        }
      });
      
      throw enhancedError;
    }
  }
  
  /**
   * Express.js error middleware
   */
  expressMiddleware() {
    return (error, req, res, next) => {
      let processedError = error;
      
      if (!(error instanceof OtedamaError)) {
        processedError = new OtedamaError(error.message, {
          category: ErrorCategory.API,
          context: {
            method: req.method,
            path: req.path,
            userAgent: req.get('User-Agent'),
            ip: req.ip
          },
          requestId: req.headers['x-request-id'] || randomUUID()
        });
      }
      
      const response = processedError.toHttpResponse();
      
      if (this.options.logErrors) {
        this.logger.error('API Error:', {
          error: processedError.toJSON(),
          request: {
            method: req.method,
            path: req.path,
            query: req.query,
            headers: req.headers
          }
        });
      }
      
      res.status(response.statusCode).json(response.body);
    };
  }
  
  /**
   * Get error statistics
   */
  getStats() {
    const circuitBreakerStats = {};
    for (const [name, breaker] of this.circuitBreakers) {
      circuitBreakerStats[name] = breaker.getStats();
    }
    
    return {
      metrics: {
        ...this.metrics,
        errorsByCategory: Object.fromEntries(this.metrics.errorsByCategory),
        errorsBySeverity: Object.fromEntries(this.metrics.errorsBySeverity)
      },
      circuitBreakers: circuitBreakerStats
    };
  }
  
  // Private methods
  
  _recordError(error) {
    this.metrics.totalErrors++;
    
    // Track by category
    const categoryCount = this.metrics.errorsByCategory.get(error.category) || 0;
    this.metrics.errorsByCategory.set(error.category, categoryCount + 1);
    
    // Track by severity
    const severityCount = this.metrics.errorsBySeverity.get(error.severity) || 0;
    this.metrics.errorsBySeverity.set(error.severity, severityCount + 1);
  }
  
  async _applyRecoveryStrategy(error, options) {
    this.metrics.recoveryAttempts++;
    
    try {
      switch (options.strategy) {
        case RecoveryStrategy.FALLBACK:
          if (options.fallback) {
            const result = await options.fallback(error);
            this.metrics.successfulRecoveries++;
            return result;
          }
          break;
          
        case RecoveryStrategy.GRACEFUL_DEGRADATION:
          if (options.degradedService) {
            const result = await options.degradedService(error);
            this.metrics.successfulRecoveries++;
            return result;
          }
          break;
          
        case RecoveryStrategy.IGNORE:
          this.metrics.successfulRecoveries++;
          return options.defaultValue || null;
          
        default:
          break;
      }
    } catch (recoveryError) {
      this.logger.error('Recovery strategy failed:', recoveryError);
    }
    
    throw error;
  }
}

// Global error handler instance
let globalErrorHandler = null;

/**
 * Get global error handler instance
 */
export function getErrorHandler(options = {}) {
  if (!globalErrorHandler) {
    globalErrorHandler = new StandardizedErrorHandler(options);
  }
  return globalErrorHandler;
}

/**
 * Utility functions for common error patterns
 */
export const ErrorUtils = {
  /**
   * Create validation error
   */
  validation: (message, details = {}) => new OtedamaError(message, {
    category: ErrorCategory.VALIDATION,
    severity: ErrorSeverity.LOW,
    details,
    userMessage: message
  }),
  
  /**
   * Create authentication error
   */
  authentication: (message = 'Authentication required', details = {}) => new OtedamaError(message, {
    category: ErrorCategory.AUTHENTICATION,
    severity: ErrorSeverity.MEDIUM,
    details,
    userMessage: 'Please log in to continue'
  }),
  
  /**
   * Create authorization error
   */
  authorization: (message = 'Insufficient permissions', details = {}) => new OtedamaError(message, {
    category: ErrorCategory.AUTHORIZATION,
    severity: ErrorSeverity.MEDIUM,
    details,
    userMessage: 'You do not have permission to perform this action'
  }),
  
  /**
   * Create database error
   */
  database: (message, details = {}) => new OtedamaError(message, {
    category: ErrorCategory.DATABASE,
    severity: ErrorSeverity.HIGH,
    details,
    retryable: true
  }),
  
  /**
   * Create external API error
   */
  externalApi: (message, details = {}) => new OtedamaError(message, {
    category: ErrorCategory.EXTERNAL_API,
    severity: ErrorSeverity.MEDIUM,
    details,
    retryable: true,
    recoveryStrategy: RecoveryStrategy.CIRCUIT_BREAKER
  }),
  
  /**
   * Create rate limit error
   */
  rateLimit: (message = 'Rate limit exceeded', retryAfter = 60) => new OtedamaError(message, {
    category: ErrorCategory.RATE_LIMIT,
    severity: ErrorSeverity.LOW,
    details: { retryAfter },
    userMessage: `Too many requests. Please try again in ${retryAfter} seconds.`,
    retryable: true
  })
};

export default StandardizedErrorHandler;