/**
 * Global Error Handler - Otedama
 * Centralized error handling with recovery strategies
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from './structured-logger.js';
import os from 'os';

const logger = createStructuredLogger('ErrorHandler');

// Error severity levels
export const ErrorSeverity = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

// Error categories
export const ErrorCategory = {
  NETWORK: 'network',
  DATABASE: 'database',
  VALIDATION: 'validation',
  AUTHENTICATION: 'authentication',
  AUTHORIZATION: 'authorization',
  CONFIGURATION: 'configuration',
  RESOURCE: 'resource',
  EXTERNAL_SERVICE: 'external_service',
  INTERNAL: 'internal',
  UNKNOWN: 'unknown'
};

// Custom error classes
export class OtedamaError extends Error {
  constructor(message, code, category = ErrorCategory.UNKNOWN, severity = ErrorSeverity.MEDIUM) {
    super(message);
    this.name = 'OtedamaError';
    this.code = code;
    this.category = category;
    this.severity = severity;
    this.timestamp = Date.now();
    this.context = {};
    
    Error.captureStackTrace(this, this.constructor);
  }
  
  withContext(context) {
    this.context = { ...this.context, ...context };
    return this;
  }
  
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      severity: this.severity,
      timestamp: this.timestamp,
      context: this.context,
      stack: this.stack
    };
  }
}

export class NetworkError extends OtedamaError {
  constructor(message, code = 'NETWORK_ERROR') {
    super(message, code, ErrorCategory.NETWORK, ErrorSeverity.HIGH);
    this.name = 'NetworkError';
  }
}

export class DatabaseError extends OtedamaError {
  constructor(message, code = 'DATABASE_ERROR') {
    super(message, code, ErrorCategory.DATABASE, ErrorSeverity.HIGH);
    this.name = 'DatabaseError';
  }
}

export class ValidationError extends OtedamaError {
  constructor(message, code = 'VALIDATION_ERROR', fields = []) {
    super(message, code, ErrorCategory.VALIDATION, ErrorSeverity.LOW);
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

export class AuthenticationError extends OtedamaError {
  constructor(message, code = 'AUTH_ERROR') {
    super(message, code, ErrorCategory.AUTHENTICATION, ErrorSeverity.MEDIUM);
    this.name = 'AuthenticationError';
  }
}

export class RateLimitError extends NetworkError {
  constructor(message, retryAfter) {
    super(message, 'RATE_LIMIT_EXCEEDED');
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Global Error Handler
 */
export class ErrorHandler extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      exitOnUncaught: options.exitOnUncaught !== false,
      logErrors: options.logErrors !== false,
      notifyOnCritical: options.notifyOnCritical !== false,
      maxErrorRate: options.maxErrorRate || 100, // errors per minute
      errorRateWindow: options.errorRateWindow || 60000, // 1 minute
      ...options
    };
    
    // Error tracking
    this.errors = [];
    this.errorCounts = new Map();
    this.recoveryStrategies = new Map();
    
    // Statistics
    this.stats = {
      total: 0,
      byCategory: {},
      bySeverity: {},
      recovered: 0,
      unrecoverable: 0
    };
    
    // Register default recovery strategies
    this.registerDefaultStrategies();
    
    // Setup global handlers
    this.setupGlobalHandlers();
  }
  
  /**
   * Register default recovery strategies
   */
  registerDefaultStrategies() {
    // Network errors - retry with backoff
    this.registerRecoveryStrategy(ErrorCategory.NETWORK, async (error, context) => {
      const maxRetries = 3;
      const baseDelay = 1000;
      
      for (let i = 0; i < maxRetries; i++) {
        try {
          if (context.retry) {
            return await context.retry();
          }
          break;
        } catch (retryError) {
          if (i === maxRetries - 1) throw retryError;
          
          const delay = baseDelay * Math.pow(2, i);
          logger.info(`Retrying after network error (attempt ${i + 1}/${maxRetries})`, {
            delay,
            error: error.message
          });
          
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    });
    
    // Database errors - reconnect
    this.registerRecoveryStrategy(ErrorCategory.DATABASE, async (error, context) => {
      if (context.reconnect) {
        logger.info('Attempting database reconnection');
        await context.reconnect();
      }
    });
    
    // Resource errors - cleanup and retry
    this.registerRecoveryStrategy(ErrorCategory.RESOURCE, async (error, context) => {
      if (context.cleanup) {
        logger.info('Cleaning up resources');
        await context.cleanup();
      }
      
      if (context.retry) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return await context.retry();
      }
    });
  }
  
  /**
   * Setup global error handlers
   */
  setupGlobalHandlers() {
    // Uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception', {
        error: error.message,
        stack: error.stack
      });
      
      this.handleError(error, {
        severity: ErrorSeverity.CRITICAL,
        category: ErrorCategory.INTERNAL
      });
      
      if (this.options.exitOnUncaught) {
        this.gracefulShutdown(1);
      }
    });
    
    // Unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled promise rejection', {
        reason,
        promise
      });
      
      const error = reason instanceof Error ? reason : new Error(String(reason));
      
      this.handleError(error, {
        severity: ErrorSeverity.HIGH,
        category: ErrorCategory.INTERNAL
      });
    });
    
    // Warning events
    process.on('warning', (warning) => {
      logger.warn('Process warning', {
        name: warning.name,
        message: warning.message,
        stack: warning.stack
      });
    });
  }
  
  /**
   * Handle error
   */
  async handleError(error, options = {}) {
    // Normalize error
    const otedamaError = this.normalizeError(error, options);
    
    // Track error
    this.trackError(otedamaError);
    
    // Log error
    if (this.options.logErrors) {
      this.logError(otedamaError);
    }
    
    // Check error rate
    if (this.checkErrorRate()) {
      logger.error('Error rate exceeded threshold', {
        rate: this.getErrorRate(),
        threshold: this.options.maxErrorRate
      });
      
      this.emit('error:rate_exceeded', {
        rate: this.getErrorRate(),
        threshold: this.options.maxErrorRate
      });
    }
    
    // Attempt recovery
    const recovered = await this.attemptRecovery(otedamaError, options.context);
    
    if (recovered) {
      this.stats.recovered++;
      this.emit('error:recovered', { error: otedamaError });
    } else {
      this.stats.unrecoverable++;
      this.emit('error:unrecoverable', { error: otedamaError });
      
      // Notify on critical errors
      if (otedamaError.severity === ErrorSeverity.CRITICAL && this.options.notifyOnCritical) {
        this.notifyCriticalError(otedamaError);
      }
    }
    
    return otedamaError;
  }
  
  /**
   * Normalize error to OtedamaError
   */
  normalizeError(error, options = {}) {
    if (error instanceof OtedamaError) {
      return error;
    }
    
    const category = options.category || this.categorizeError(error);
    const severity = options.severity || this.assessSeverity(error, category);
    const code = error.code || 'UNKNOWN_ERROR';
    
    const otedamaError = new OtedamaError(
      error.message || 'An unknown error occurred',
      code,
      category,
      severity
    );
    
    // Copy stack trace
    if (error.stack) {
      otedamaError.stack = error.stack;
    }
    
    // Copy additional properties
    if (options.context) {
      otedamaError.withContext(options.context);
    }
    
    return otedamaError;
  }
  
  /**
   * Categorize error
   */
  categorizeError(error) {
    const message = error.message?.toLowerCase() || '';
    const code = error.code?.toLowerCase() || '';
    
    if (message.includes('network') || code.includes('network') || code === 'econnrefused') {
      return ErrorCategory.NETWORK;
    }
    
    if (message.includes('database') || message.includes('sql') || code.includes('db')) {
      return ErrorCategory.DATABASE;
    }
    
    if (message.includes('validation') || message.includes('invalid')) {
      return ErrorCategory.VALIDATION;
    }
    
    if (message.includes('auth') || message.includes('unauthorized')) {
      return ErrorCategory.AUTHENTICATION;
    }
    
    if (message.includes('permission') || message.includes('forbidden')) {
      return ErrorCategory.AUTHORIZATION;
    }
    
    if (message.includes('config') || message.includes('missing')) {
      return ErrorCategory.CONFIGURATION;
    }
    
    if (code === 'emfile' || code === 'enomem' || message.includes('resource')) {
      return ErrorCategory.RESOURCE;
    }
    
    return ErrorCategory.UNKNOWN;
  }
  
  /**
   * Assess error severity
   */
  assessSeverity(error, category) {
    // Critical errors
    if (category === ErrorCategory.DATABASE || category === ErrorCategory.CONFIGURATION) {
      return ErrorSeverity.CRITICAL;
    }
    
    // High severity
    if (category === ErrorCategory.NETWORK || category === ErrorCategory.RESOURCE) {
      return ErrorSeverity.HIGH;
    }
    
    // Medium severity
    if (category === ErrorCategory.AUTHENTICATION || category === ErrorCategory.AUTHORIZATION) {
      return ErrorSeverity.MEDIUM;
    }
    
    // Low severity
    if (category === ErrorCategory.VALIDATION) {
      return ErrorSeverity.LOW;
    }
    
    return ErrorSeverity.MEDIUM;
  }
  
  /**
   * Track error
   */
  trackError(error) {
    // Add to recent errors
    this.errors.push({
      error,
      timestamp: Date.now()
    });
    
    // Clean old errors
    const cutoff = Date.now() - this.options.errorRateWindow;
    this.errors = this.errors.filter(e => e.timestamp > cutoff);
    
    // Update statistics
    this.stats.total++;
    this.stats.byCategory[error.category] = (this.stats.byCategory[error.category] || 0) + 1;
    this.stats.bySeverity[error.severity] = (this.stats.bySeverity[error.severity] || 0) + 1;
    
    // Update error counts
    const key = `${error.category}:${error.code}`;
    this.errorCounts.set(key, (this.errorCounts.get(key) || 0) + 1);
  }
  
  /**
   * Log error
   */
  logError(error) {
    const logData = {
      message: error.message,
      code: error.code,
      category: error.category,
      severity: error.severity,
      context: error.context,
      stack: error.stack
    };
    
    switch (error.severity) {
      case ErrorSeverity.CRITICAL:
        logger.error('Critical error', logData);
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
  
  /**
   * Check error rate
   */
  checkErrorRate() {
    return this.getErrorRate() > this.options.maxErrorRate;
  }
  
  /**
   * Get error rate (errors per minute)
   */
  getErrorRate() {
    const windowMs = this.options.errorRateWindow;
    const errorCount = this.errors.length;
    return (errorCount / windowMs) * 60000;
  }
  
  /**
   * Attempt recovery
   */
  async attemptRecovery(error, context = {}) {
    const strategy = this.recoveryStrategies.get(error.category);
    
    if (!strategy) {
      logger.debug('No recovery strategy for error category', {
        category: error.category
      });
      return false;
    }
    
    try {
      await strategy(error, context);
      logger.info('Error recovery successful', {
        category: error.category,
        code: error.code
      });
      return true;
    } catch (recoveryError) {
      logger.error('Error recovery failed', {
        originalError: error.message,
        recoveryError: recoveryError.message
      });
      return false;
    }
  }
  
  /**
   * Register recovery strategy
   */
  registerRecoveryStrategy(category, strategy) {
    this.recoveryStrategies.set(category, strategy);
  }
  
  /**
   * Notify critical error
   */
  notifyCriticalError(error) {
    // In production, this could send notifications via:
    // - Email
    // - Slack
    // - PagerDuty
    // - SMS
    
    this.emit('error:critical', {
      error,
      system: {
        hostname: os.hostname(),
        platform: os.platform(),
        uptime: os.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage()
      }
    });
  }
  
  /**
   * Graceful shutdown
   */
  async gracefulShutdown(exitCode = 0) {
    logger.info('Initiating graceful shutdown', { exitCode });
    
    try {
      // Emit shutdown event
      this.emit('shutdown', { exitCode });
      
      // Give time for cleanup
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      process.exit(exitCode);
    } catch (error) {
      logger.error('Error during shutdown', { error: error.message });
      process.exit(1);
    }
  }
  
  /**
   * Get error report
   */
  getErrorReport() {
    return {
      stats: this.stats,
      recentErrors: this.errors.slice(-10).map(e => ({
        message: e.error.message,
        code: e.error.code,
        category: e.error.category,
        severity: e.error.severity,
        timestamp: e.timestamp
      })),
      errorRate: this.getErrorRate(),
      topErrors: Array.from(this.errorCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([key, count]) => ({ error: key, count }))
    };
  }
  
  /**
   * Express error middleware
   */
  expressErrorHandler() {
    return async (err, req, res, next) => {
      const error = await this.handleError(err, {
        context: {
          method: req.method,
          url: req.url,
          ip: req.ip,
          userAgent: req.get('user-agent')
        }
      });
      
      const statusCode = this.getHttpStatusCode(error);
      
      res.status(statusCode).json({
        error: {
          message: error.message,
          code: error.code,
          category: error.category
        }
      });
    };
  }
  
  /**
   * Get HTTP status code for error
   */
  getHttpStatusCode(error) {
    switch (error.category) {
      case ErrorCategory.VALIDATION:
        return 400;
      case ErrorCategory.AUTHENTICATION:
        return 401;
      case ErrorCategory.AUTHORIZATION:
        return 403;
      case ErrorCategory.NETWORK:
        return 503;
      case ErrorCategory.DATABASE:
        return 503;
      default:
        return 500;
    }
  }
}

// Create singleton instance
export const globalErrorHandler = new ErrorHandler();

export default ErrorHandler;