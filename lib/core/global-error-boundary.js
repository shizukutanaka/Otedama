/**
 * Global Error Boundary
 * Catches and handles all unhandled errors in the application
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from './structured-logger.js';
import { OtedamaError, ErrorSeverity } from './error-handler-unified.js';
import { getErrorRecoverySystem } from './error-recovery-system.js';

const logger = createStructuredLogger('GlobalErrorBoundary');

export class GlobalErrorBoundary extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      exitOnUncaughtException: options.exitOnUncaughtException || false,
      exitTimeout: options.exitTimeout || 5000,
      enableStackTrace: options.enableStackTrace !== false,
      enableHeapSnapshot: options.enableHeapSnapshot || false,
      alertOnCritical: options.alertOnCritical !== false
    };
    
    this.errorRecoverySystem = getErrorRecoverySystem();
    this.isShuttingDown = false;
    
    // Track error patterns
    this.errorPatterns = new Map();
    this.criticalErrors = [];
    
    this.setupHandlers();
  }

  setupHandlers() {
    // Uncaught exceptions
    process.on('uncaughtException', this.handleUncaughtException.bind(this));
    
    // Unhandled promise rejections
    process.on('unhandledRejection', this.handleUnhandledRejection.bind(this));
    
    // Warning events
    process.on('warning', this.handleWarning.bind(this));
    
    // Exit events
    process.on('exit', this.handleExit.bind(this));
    process.on('SIGINT', this.handleSignal.bind(this, 'SIGINT'));
    process.on('SIGTERM', this.handleSignal.bind(this, 'SIGTERM'));
    
    // Memory warnings
    if (global.gc) {
      setInterval(() => this.checkMemoryUsage(), 30000); // Every 30 seconds
    }
  }

  async handleUncaughtException(error, origin) {
    logger.error('Uncaught exception', {
      error: error.message,
      stack: error.stack,
      origin
    });
    
    // Track pattern
    this.trackErrorPattern(error);
    
    // Convert to OtedamaError
    const otedamaError = new OtedamaError(error.message, {
      code: 'UNCAUGHT_EXCEPTION',
      category: 'SYSTEM',
      severity: ErrorSeverity.CRITICAL,
      context: { origin, stack: error.stack },
      retryable: false
    });
    
    this.criticalErrors.push({
      error: otedamaError,
      timestamp: Date.now()
    });
    
    // Emit event
    this.emit('uncaughtException', otedamaError);
    
    // Try recovery
    try {
      await this.errorRecoverySystem.handleError(otedamaError, {
        operation: async () => {
          // Attempt to recover by restarting affected services
          logger.info('Attempting to recover from uncaught exception');
          this.emit('recovery:attempt', otedamaError);
        }
      });
    } catch (recoveryError) {
      logger.error('Recovery failed', { error: recoveryError.message });
    }
    
    // Graceful shutdown if configured
    if (this.config.exitOnUncaughtException && !this.isShuttingDown) {
      await this.gracefulShutdown('Uncaught exception');
    }
  }

  async handleUnhandledRejection(reason, promise) {
    logger.error('Unhandled promise rejection', {
      reason: reason?.message || reason,
      stack: reason?.stack
    });
    
    // Track pattern
    if (reason instanceof Error) {
      this.trackErrorPattern(reason);
    }
    
    // Convert to OtedamaError
    const error = new OtedamaError(
      reason?.message || 'Unhandled promise rejection',
      {
        code: 'UNHANDLED_REJECTION',
        category: 'SYSTEM',
        severity: ErrorSeverity.HIGH,
        context: { 
          reason: reason?.toString(),
          stack: reason?.stack 
        },
        retryable: true
      }
    );
    
    // Emit event
    this.emit('unhandledRejection', error);
    
    // Try recovery
    try {
      await this.errorRecoverySystem.handleError(error);
    } catch (recoveryError) {
      logger.error('Failed to handle unhandled rejection', { 
        error: recoveryError.message 
      });
    }
  }

  handleWarning(warning) {
    logger.warn('Process warning', {
      name: warning.name,
      message: warning.message,
      stack: warning.stack
    });
    
    this.emit('warning', warning);
  }

  trackErrorPattern(error) {
    const key = `${error.name}:${error.message}`;
    const pattern = this.errorPatterns.get(key) || {
      count: 0,
      firstSeen: Date.now(),
      lastSeen: Date.now()
    };
    
    pattern.count++;
    pattern.lastSeen = Date.now();
    
    this.errorPatterns.set(key, pattern);
    
    // Alert if error is recurring frequently
    if (pattern.count > 10) {
      const timeSpan = pattern.lastSeen - pattern.firstSeen;
      const rate = pattern.count / (timeSpan / 60000); // errors per minute
      
      if (rate > 1) {
        logger.error('High error rate detected', {
          pattern: key,
          count: pattern.count,
          ratePerMinute: rate.toFixed(2)
        });
        
        this.emit('highErrorRate', {
          pattern: key,
          count: pattern.count,
          rate
        });
      }
    }
  }

  checkMemoryUsage() {
    const usage = process.memoryUsage();
    const heapUsedPercent = (usage.heapUsed / usage.heapTotal) * 100;
    
    if (heapUsedPercent > 85) {
      logger.warn('High memory usage detected', {
        heapUsedPercent: heapUsedPercent.toFixed(2),
        heapUsed: (usage.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
        heapTotal: (usage.heapTotal / 1024 / 1024).toFixed(2) + ' MB'
      });
      
      this.emit('highMemoryUsage', {
        usage,
        heapUsedPercent
      });
      
      // Force garbage collection if available
      if (global.gc) {
        logger.info('Forcing garbage collection');
        global.gc();
      }
    }
  }

  async handleSignal(signal) {
    logger.info(`Received ${signal}`);
    await this.gracefulShutdown(signal);
  }

  handleExit(code) {
    logger.info('Process exiting', { code });
  }

  async gracefulShutdown(reason) {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress');
      return;
    }
    
    this.isShuttingDown = true;
    logger.info('Starting graceful shutdown', { reason });
    
    this.emit('shutdown:start', reason);
    
    // Set timeout for forced exit
    const forceExitTimer = setTimeout(() => {
      logger.error('Graceful shutdown timeout, forcing exit');
      process.exit(1);
    }, this.config.exitTimeout);
    
    try {
      // Emit shutdown event for services to clean up
      this.emit('shutdown', reason);
      
      // Wait a bit for cleanup
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      logger.info('Graceful shutdown complete');
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', { error: error.message });
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  }

  getErrorPatterns() {
    return Array.from(this.errorPatterns.entries()).map(([key, pattern]) => ({
      pattern: key,
      ...pattern
    }));
  }

  getCriticalErrors() {
    return this.criticalErrors;
  }

  clearErrorHistory() {
    this.errorPatterns.clear();
    this.criticalErrors = [];
  }

  // Middleware for Express apps
  expressErrorHandler() {
    return async (err, req, res, next) => {
      const error = err instanceof OtedamaError ? err : new OtedamaError(
        err.message || 'Internal server error',
        {
          code: err.code || 'INTERNAL_ERROR',
          category: 'SYSTEM',
          severity: ErrorSeverity.MEDIUM,
          statusCode: err.statusCode || 500,
          context: {
            method: req.method,
            path: req.path,
            ip: req.ip
          }
        }
      );
      
      // Try recovery
      try {
        await this.errorRecoverySystem.handleError(error, {
          req,
          res
        });
        
        // If recovery succeeded, continue
        next();
      } catch (recoveryError) {
        // Send error response
        res.status(error.statusCode).json({
          error: {
            id: error.id,
            message: error.message,
            code: error.code,
            timestamp: error.timestamp
          }
        });
      }
    };
  }
}

// Singleton instance
let instance = null;

export function setupGlobalErrorBoundary(options) {
  if (!instance) {
    instance = new GlobalErrorBoundary(options);
  }
  return instance;
}

export default GlobalErrorBoundary;