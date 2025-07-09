import { EventEmitter } from 'events';

/**
 * Comprehensive Error Handling and Retry System
 * Following Clean Code principles: clear error types, predictable behavior
 */

// Error severity levels
export enum ErrorSeverity {
  DEBUG = 0,
  INFO = 1,
  WARNING = 2,
  ERROR = 3,
  CRITICAL = 4,
  FATAL = 5
}

// Error categories for better classification
export enum ErrorCategory {
  NETWORK = 'NETWORK',
  DATABASE = 'DATABASE',
  BLOCKCHAIN = 'BLOCKCHAIN',
  VALIDATION = 'VALIDATION',
  AUTHENTICATION = 'AUTHENTICATION',
  CONFIGURATION = 'CONFIGURATION',
  RESOURCE = 'RESOURCE',
  UNKNOWN = 'UNKNOWN'
}

// Custom error class with additional metadata
export class PoolError extends Error {
  public readonly code: string;
  public readonly category: ErrorCategory;
  public readonly severity: ErrorSeverity;
  public readonly context?: any;
  public readonly timestamp: number;
  public retryable: boolean;
  public retryCount: number = 0;

  constructor(
    message: string,
    code: string,
    category: ErrorCategory = ErrorCategory.UNKNOWN,
    severity: ErrorSeverity = ErrorSeverity.ERROR,
    context?: any,
    retryable: boolean = false
  ) {
    super(message);
    this.name = 'PoolError';
    this.code = code;
    this.category = category;
    this.severity = severity;
    this.context = context;
    this.timestamp = Date.now();
    this.retryable = retryable;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PoolError);
    }
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      severity: this.severity,
      context: this.context,
      timestamp: this.timestamp,
      retryable: this.retryable,
      retryCount: this.retryCount,
      stack: this.stack
    };
  }
}

// Retry configuration
export interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  jitter: boolean;
  retryCondition?: (error: any) => boolean;
}

// Default retry configurations for different scenarios
export const RetryProfiles = {
  // For quick operations that should fail fast
  FAST: {
    maxRetries: 3,
    initialDelay: 100,
    maxDelay: 1000,
    backoffMultiplier: 2,
    jitter: true
  },
  // For standard operations
  STANDARD: {
    maxRetries: 5,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
    jitter: true
  },
  // For critical operations that must succeed
  AGGRESSIVE: {
    maxRetries: 10,
    initialDelay: 1000,
    maxDelay: 60000,
    backoffMultiplier: 1.5,
    jitter: true
  },
  // For operations that can wait
  PATIENT: {
    maxRetries: 20,
    initialDelay: 5000,
    maxDelay: 300000,
    backoffMultiplier: 1.2,
    jitter: false
  }
};

/**
 * Retry mechanism with exponential backoff
 */
export class RetryHandler {
  private static calculateDelay(
    attempt: number,
    config: RetryConfig
  ): number {
    let delay = config.initialDelay * Math.pow(config.backoffMultiplier, attempt - 1);
    delay = Math.min(delay, config.maxDelay);

    if (config.jitter) {
      // Add random jitter (±25%)
      const jitter = delay * 0.25;
      delay += (Math.random() * 2 - 1) * jitter;
    }

    return Math.floor(delay);
  }

  static async retry<T>(
    operation: () => Promise<T>,
    config: RetryConfig = RetryProfiles.STANDARD,
    onRetry?: (error: any, attempt: number) => void
  ): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        // Check if we should retry
        if (config.retryCondition && !config.retryCondition(error)) {
          throw error;
        }

        // Check if error is explicitly non-retryable
        if (error instanceof PoolError && !error.retryable) {
          throw error;
        }

        // Don't retry on the last attempt
        if (attempt === config.maxRetries) {
          break;
        }

        // Calculate delay
        const delay = this.calculateDelay(attempt, config);

        // Call retry callback if provided
        if (onRetry) {
          onRetry(error, attempt);
        }

        // Update retry count if it's a PoolError
        if (error instanceof PoolError) {
          error.retryCount = attempt;
        }

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // All retries exhausted
    if (lastError instanceof PoolError) {
      lastError.message = `Failed after ${config.maxRetries} retries: ${lastError.message}`;
    }
    throw lastError;
  }

  /**
   * Retry with circuit breaker pattern
   */
  static createCircuitBreaker<T>(
    operation: () => Promise<T>,
    threshold: number = 5,
    timeout: number = 60000
  ) {
    let failures = 0;
    let lastFailureTime = 0;
    let isOpen = false;

    return async (): Promise<T> => {
      // Check if circuit is open
      if (isOpen) {
        const timeSinceLastFailure = Date.now() - lastFailureTime;
        if (timeSinceLastFailure < timeout) {
          throw new PoolError(
            'Circuit breaker is open',
            'CIRCUIT_BREAKER_OPEN',
            ErrorCategory.RESOURCE,
            ErrorSeverity.WARNING,
            { failures, timeout }
          );
        }
        // Try to close the circuit
        isOpen = false;
        failures = 0;
      }

      try {
        const result = await operation();
        failures = 0; // Reset on success
        return result;
      } catch (error) {
        failures++;
        lastFailureTime = Date.now();

        if (failures >= threshold) {
          isOpen = true;
        }

        throw error;
      }
    };
  }
}

/**
 * Global error handler for the pool
 */
export class ErrorHandler extends EventEmitter {
  private errorCounts = new Map<string, number>();
  private errorLog: PoolError[] = [];
  private readonly maxLogSize = 1000;

  constructor() {
    super();

    // Set up global handlers
    this.setupGlobalHandlers();
  }

  private setupGlobalHandlers() {
    // Handle uncaught exceptions
    process.on('uncaughtException', (error: Error) => {
      const poolError = this.wrapError(error, ErrorCategory.UNKNOWN, ErrorSeverity.FATAL);
      this.handle(poolError);
      
      // Give time to flush logs before exiting
      setTimeout(() => process.exit(1), 1000);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      const poolError = this.wrapError(error, ErrorCategory.UNKNOWN, ErrorSeverity.CRITICAL);
      this.handle(poolError);
    });

    // Handle warnings
    process.on('warning', (warning: Error) => {
      const poolError = this.wrapError(warning, ErrorCategory.UNKNOWN, ErrorSeverity.WARNING);
      this.handle(poolError);
    });
  }

  /**
   * Wrap standard errors in PoolError
   */
  wrapError(
    error: Error | any,
    category: ErrorCategory = ErrorCategory.UNKNOWN,
    severity: ErrorSeverity = ErrorSeverity.ERROR
  ): PoolError {
    if (error instanceof PoolError) {
      return error;
    }

    // Determine category and severity from error type
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      category = ErrorCategory.NETWORK;
    } else if (error.message?.includes('database') || error.message?.includes('sqlite')) {
      category = ErrorCategory.DATABASE;
    } else if (error.message?.includes('blockchain') || error.message?.includes('rpc')) {
      category = ErrorCategory.BLOCKCHAIN;
    }

    const retryable = category === ErrorCategory.NETWORK || category === ErrorCategory.DATABASE;

    return new PoolError(
      error.message || 'Unknown error',
      error.code || 'UNKNOWN',
      category,
      severity,
      { originalError: error },
      retryable
    );
  }

  /**
   * Handle an error
   */
  handle(error: PoolError | Error | any): void {
    const poolError = error instanceof PoolError ? error : this.wrapError(error);

    // Update error counts
    const errorKey = `${poolError.category}:${poolError.code}`;
    this.errorCounts.set(errorKey, (this.errorCounts.get(errorKey) || 0) + 1);

    // Add to log
    this.errorLog.unshift(poolError);
    if (this.errorLog.length > this.maxLogSize) {
      this.errorLog.pop();
    }

    // Emit events based on severity
    this.emit('error', poolError);

    if (poolError.severity >= ErrorSeverity.ERROR) {
      this.emit('severe-error', poolError);
    }

    if (poolError.severity >= ErrorSeverity.CRITICAL) {
      this.emit('critical-error', poolError);
    }

    // Log to console based on severity
    this.logError(poolError);
  }

  private logError(error: PoolError): void {
    const timestamp = new Date(error.timestamp).toISOString();
    const prefix = `[${timestamp}] [${ErrorSeverity[error.severity]}] [${error.category}]`;

    switch (error.severity) {
      case ErrorSeverity.DEBUG:
        if (process.env.DEBUG) {
          console.debug(prefix, error.message, error.context);
        }
        break;
      case ErrorSeverity.INFO:
        console.info(prefix, error.message);
        break;
      case ErrorSeverity.WARNING:
        console.warn(prefix, error.message);
        break;
      case ErrorSeverity.ERROR:
      case ErrorSeverity.CRITICAL:
      case ErrorSeverity.FATAL:
        console.error(prefix, error.message, '\n', error.stack);
        if (error.context) {
          console.error('Context:', error.context);
        }
        break;
    }
  }

  /**
   * Get error statistics
   */
  getStats() {
    const stats = {
      total: this.errorLog.length,
      bySeverity: {} as Record<string, number>,
      byCategory: {} as Record<string, number>,
      topErrors: [] as Array<{ key: string; count: number }>,
      recentErrors: this.errorLog.slice(0, 10).map(e => ({
        message: e.message,
        code: e.code,
        category: e.category,
        severity: ErrorSeverity[e.severity],
        timestamp: e.timestamp
      }))
    };

    // Count by severity
    for (const error of this.errorLog) {
      const severity = ErrorSeverity[error.severity];
      stats.bySeverity[severity] = (stats.bySeverity[severity] || 0) + 1;
    }

    // Count by category
    for (const error of this.errorLog) {
      stats.byCategory[error.category] = (stats.byCategory[error.category] || 0) + 1;
    }

    // Get top errors
    const sortedErrors = Array.from(this.errorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    stats.topErrors = sortedErrors.map(([key, count]) => ({ key, count }));

    return stats;
  }

  /**
   * Clear error history
   */
  clear(): void {
    this.errorCounts.clear();
    this.errorLog = [];
  }
}

/**
 * Decorator for automatic retry
 */
export function WithRetry(config: RetryConfig = RetryProfiles.STANDARD) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      return RetryHandler.retry(
        () => originalMethod.apply(this, args),
        config,
        (error, attempt) => {
          console.warn(`Retry attempt ${attempt} for ${propertyKey}:`, error.message);
        }
      );
    };

    return descriptor;
  };
}

/**
 * Decorator for error handling
 */
export function HandleErrors(category: ErrorCategory = ErrorCategory.UNKNOWN) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      try {
        return await originalMethod.apply(this, args);
      } catch (error: any) {
        const errorHandler = new ErrorHandler();
        const poolError = errorHandler.wrapError(error, category);
        errorHandler.handle(poolError);
        throw poolError;
      }
    };

    return descriptor;
  };
}

/**
 * Timeout wrapper for operations
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  errorMessage: string = 'Operation timed out'
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new PoolError(
        errorMessage,
        'TIMEOUT',
        ErrorCategory.RESOURCE,
        ErrorSeverity.ERROR,
        { timeout: timeoutMs },
        true
      ));
    }, timeoutMs);
  });

  return Promise.race([operation, timeoutPromise]);
}

// Export singleton error handler
export const globalErrorHandler = new ErrorHandler();
