/**
 * Enhanced Error Handling System
 * Design: Carmack (Performance) + Martin (Clean Architecture) + Pike (Simplicity)
 * 
 * Comprehensive error handling with proper try-catch coverage
 */

import { EventEmitter } from 'events';
import { createComponentLogger } from '../logging/simple-logger';

// ===== ERROR TYPES =====
export enum ErrorType {
  NETWORK = 'NETWORK',
  DATABASE = 'DATABASE',
  VALIDATION = 'VALIDATION',
  AUTHENTICATION = 'AUTHENTICATION',
  AUTHORIZATION = 'AUTHORIZATION',
  RATE_LIMIT = 'RATE_LIMIT',
  TIMEOUT = 'TIMEOUT',
  RESOURCE = 'RESOURCE',
  CONFLICT = 'CONFLICT',
  NOT_FOUND = 'NOT_FOUND',
  INTERNAL = 'INTERNAL',
  EXTERNAL = 'EXTERNAL',
  CONFIGURATION = 'CONFIGURATION',
  BLOCKCHAIN = 'BLOCKCHAIN'
}

export enum ErrorSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL'
}

// ===== BASE ERROR CLASS =====
export class PoolError extends Error {
  public readonly type: ErrorType;
  public readonly severity: ErrorSeverity;
  public readonly code: string;
  public readonly timestamp: number;
  public readonly context?: any;
  public readonly originalError?: Error;
  public readonly retryable: boolean;

  constructor(
    message: string,
    type: ErrorType,
    code: string,
    severity: ErrorSeverity = ErrorSeverity.MEDIUM,
    retryable: boolean = false,
    context?: any,
    originalError?: Error
  ) {
    super(message);
    this.name = 'PoolError';
    this.type = type;
    this.severity = severity;
    this.code = code;
    this.timestamp = Date.now();
    this.context = context;
    this.originalError = originalError;
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
      type: this.type,
      severity: this.severity,
      code: this.code,
      timestamp: this.timestamp,
      context: this.context,
      retryable: this.retryable,
      stack: this.stack
    };
  }
}

// ===== SPECIFIC ERROR CLASSES =====
export class NetworkError extends PoolError {
  constructor(
    message: string,
    code: string = 'NETWORK_ERROR',
    context?: any,
    originalError?: Error
  ) {
    super(message, ErrorType.NETWORK, code, ErrorSeverity.HIGH, true, context, originalError);
    this.name = 'NetworkError';
  }
}

export class DatabaseError extends PoolError {
  constructor(
    message: string,
    code: string = 'DATABASE_ERROR',
    context?: any,
    originalError?: Error
  ) {
    super(message, ErrorType.DATABASE, code, ErrorSeverity.HIGH, true, context, originalError);
    this.name = 'DatabaseError';
  }
}

export class ValidationError extends PoolError {
  constructor(
    message: string,
    code: string = 'VALIDATION_ERROR',
    context?: any
  ) {
    super(message, ErrorType.VALIDATION, code, ErrorSeverity.LOW, false, context);
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends PoolError {
  constructor(
    message: string,
    code: string = 'AUTH_ERROR',
    context?: any
  ) {
    super(message, ErrorType.AUTHENTICATION, code, ErrorSeverity.MEDIUM, false, context);
    this.name = 'AuthenticationError';
  }
}

export class RateLimitError extends PoolError {
  public readonly retryAfter?: number;

  constructor(
    message: string,
    retryAfter?: number,
    context?: any
  ) {
    super(message, ErrorType.RATE_LIMIT, 'RATE_LIMIT_EXCEEDED', ErrorSeverity.LOW, true, context);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class TimeoutError extends PoolError {
  constructor(
    message: string,
    code: string = 'TIMEOUT',
    context?: any
  ) {
    super(message, ErrorType.TIMEOUT, code, ErrorSeverity.MEDIUM, true, context);
    this.name = 'TimeoutError';
  }
}

export class BlockchainError extends PoolError {
  constructor(
    message: string,
    code: string = 'BLOCKCHAIN_ERROR',
    context?: any,
    originalError?: Error
  ) {
    super(message, ErrorType.BLOCKCHAIN, code, ErrorSeverity.HIGH, true, context, originalError);
    this.name = 'BlockchainError';
  }
}

// ===== ERROR HANDLER =====
export class ErrorHandler extends EventEmitter {
  private logger = createComponentLogger('ErrorHandler');
  private errorHistory: PoolError[] = [];
  private maxHistorySize = 1000;
  private errorCounters = new Map<string, number>();
  private errorHandlers = new Map<ErrorType, Array<(error: PoolError) => void>>();

  constructor() {
    super();
    this.setupGlobalHandlers();
  }

  private setupGlobalHandlers(): void {
    // Handle uncaught exceptions
    process.on('uncaughtException', (error: Error) => {
      this.handleUncaughtException(error);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
      this.handleUnhandledRejection(reason, promise);
    });

    // Handle warnings
    process.on('warning', (warning: Error) => {
      this.logger.warn('Node.js warning', { warning: warning.message });
    });
  }

  handleError(error: Error | PoolError, context?: any): PoolError {
    let poolError: PoolError;

    if (error instanceof PoolError) {
      poolError = error;
    } else {
      // Convert to PoolError
      poolError = this.convertToPoolError(error, context);
    }

    // Log error
    this.logError(poolError);

    // Update statistics
    this.updateErrorStats(poolError);

    // Store in history
    this.addToHistory(poolError);

    // Execute registered handlers
    this.executeHandlers(poolError);

    // Emit error event
    this.emit('error', poolError);

    return poolError;
  }

  private convertToPoolError(error: Error, context?: any): PoolError {
    // Analyze error to determine type
    const errorType = this.detectErrorType(error);
    const severity = this.determineSeverity(error, errorType);
    const code = this.generateErrorCode(error, errorType);
    const retryable = this.isRetryable(error, errorType);

    return new PoolError(
      error.message,
      errorType,
      code,
      severity,
      retryable,
      context,
      error
    );
  }

  private detectErrorType(error: Error): ErrorType {
    const message = error.message.toLowerCase();
    const name = error.name?.toLowerCase() || '';

    if (message.includes('network') || message.includes('econnrefused') || 
        message.includes('timeout') || message.includes('socket')) {
      return ErrorType.NETWORK;
    }

    if (message.includes('database') || message.includes('sql') || 
        message.includes('query')) {
      return ErrorType.DATABASE;
    }

    if (message.includes('validation') || message.includes('invalid') || 
        message.includes('required')) {
      return ErrorType.VALIDATION;
    }

    if (message.includes('auth') || message.includes('unauthorized') || 
        message.includes('forbidden')) {
      return ErrorType.AUTHENTICATION;
    }

    if (message.includes('rate limit') || message.includes('too many')) {
      return ErrorType.RATE_LIMIT;
    }

    if (message.includes('timeout') || name.includes('timeout')) {
      return ErrorType.TIMEOUT;
    }

    if (message.includes('not found') || message.includes('404')) {
      return ErrorType.NOT_FOUND;
    }

    if (message.includes('conflict') || message.includes('duplicate')) {
      return ErrorType.CONFLICT;
    }

    if (message.includes('blockchain') || message.includes('block') || 
        message.includes('transaction')) {
      return ErrorType.BLOCKCHAIN;
    }

    return ErrorType.INTERNAL;
  }

  private determineSeverity(error: Error, type: ErrorType): ErrorSeverity {
    // Critical errors
    if (type === ErrorType.DATABASE || type === ErrorType.BLOCKCHAIN) {
      return ErrorSeverity.CRITICAL;
    }

    // High severity
    if (type === ErrorType.NETWORK || type === ErrorType.INTERNAL) {
      return ErrorSeverity.HIGH;
    }

    // Medium severity
    if (type === ErrorType.AUTHENTICATION || type === ErrorType.TIMEOUT) {
      return ErrorSeverity.MEDIUM;
    }

    // Low severity
    return ErrorSeverity.LOW;
  }

  private generateErrorCode(error: Error, type: ErrorType): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 5);
    return `${type}_${timestamp}_${random}`.toUpperCase();
  }

  private isRetryable(error: Error, type: ErrorType): boolean {
    const retryableTypes = [
      ErrorType.NETWORK,
      ErrorType.DATABASE,
      ErrorType.TIMEOUT,
      ErrorType.RATE_LIMIT,
      ErrorType.BLOCKCHAIN
    ];

    return retryableTypes.includes(type);
  }

  private logError(error: PoolError): void {
    const logData = {
      code: error.code,
      type: error.type,
      severity: error.severity,
      message: error.message,
      context: error.context,
      retryable: error.retryable,
      stack: error.stack
    };

    switch (error.severity) {
      case ErrorSeverity.CRITICAL:
        this.logger.error('CRITICAL ERROR', error, logData);
        break;
      case ErrorSeverity.HIGH:
        this.logger.error('High severity error', error, logData);
        break;
      case ErrorSeverity.MEDIUM:
        this.logger.warn('Medium severity error', logData);
        break;
      case ErrorSeverity.LOW:
        this.logger.info('Low severity error', logData);
        break;
    }
  }

  private updateErrorStats(error: PoolError): void {
    const key = `${error.type}:${error.code}`;
    const count = this.errorCounters.get(key) || 0;
    this.errorCounters.set(key, count + 1);
  }

  private addToHistory(error: PoolError): void {
    this.errorHistory.push(error);
    
    // Trim history if needed
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  private executeHandlers(error: PoolError): void {
    const handlers = this.errorHandlers.get(error.type) || [];
    
    for (const handler of handlers) {
      try {
        handler(error);
      } catch (handlerError) {
        this.logger.error('Error in error handler', handlerError as Error);
      }
    }
  }

  private handleUncaughtException(error: Error): void {
    const poolError = new PoolError(
      `Uncaught exception: ${error.message}`,
      ErrorType.INTERNAL,
      'UNCAUGHT_EXCEPTION',
      ErrorSeverity.CRITICAL,
      false,
      { originalError: error.name },
      error
    );

    this.handleError(poolError);
    
    // Give some time for logging
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }

  private handleUnhandledRejection(reason: any, promise: Promise<any>): void {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    
    const poolError = new PoolError(
      `Unhandled promise rejection: ${error.message}`,
      ErrorType.INTERNAL,
      'UNHANDLED_REJECTION',
      ErrorSeverity.HIGH,
      false,
      { promise },
      error
    );

    this.handleError(poolError);
  }

  registerHandler(type: ErrorType, handler: (error: PoolError) => void): void {
    if (!this.errorHandlers.has(type)) {
      this.errorHandlers.set(type, []);
    }
    
    this.errorHandlers.get(type)!.push(handler);
  }

  getErrorStats(): any {
    const stats: any = {
      total: this.errorHistory.length,
      byType: {},
      bySeverity: {},
      recent: []
    };

    // Count by type
    for (const error of this.errorHistory) {
      stats.byType[error.type] = (stats.byType[error.type] || 0) + 1;
      stats.bySeverity[error.severity] = (stats.bySeverity[error.severity] || 0) + 1;
    }

    // Get recent errors
    stats.recent = this.errorHistory.slice(-10).map(e => ({
      code: e.code,
      type: e.type,
      severity: e.severity,
      message: e.message,
      timestamp: e.timestamp
    }));

    return stats;
  }

  clearHistory(): void {
    this.errorHistory = [];
    this.errorCounters.clear();
    this.emit('history:cleared');
  }
}

// ===== ERROR RECOVERY =====
export class ErrorRecovery {
  private logger = createComponentLogger('ErrorRecovery');
  private recoveryStrategies = new Map<ErrorType, Array<(error: PoolError) => Promise<boolean>>>();

  registerRecoveryStrategy(
    type: ErrorType, 
    strategy: (error: PoolError) => Promise<boolean>
  ): void {
    if (!this.recoveryStrategies.has(type)) {
      this.recoveryStrategies.set(type, []);
    }
    
    this.recoveryStrategies.get(type)!.push(strategy);
  }

  async attemptRecovery(error: PoolError): Promise<boolean> {
    if (!error.retryable) {
      return false;
    }

    const strategies = this.recoveryStrategies.get(error.type) || [];
    
    for (const strategy of strategies) {
      try {
        const recovered = await strategy(error);
        
        if (recovered) {
          this.logger.info('Error recovered', {
            code: error.code,
            type: error.type,
            strategy: strategies.indexOf(strategy)
          });
          
          return true;
        }
      } catch (recoveryError) {
        this.logger.warn('Recovery strategy failed', recoveryError as Error);
      }
    }

    return false;
  }
}

// ===== TRY-CATCH WRAPPER =====
export class SafeExecutor {
  private errorHandler: ErrorHandler;
  private errorRecovery: ErrorRecovery;
  private logger = createComponentLogger('SafeExecutor');

  constructor(errorHandler: ErrorHandler, errorRecovery: ErrorRecovery) {
    this.errorHandler = errorHandler;
    this.errorRecovery = errorRecovery;
  }

  /**
   * Execute async function with comprehensive error handling
   */
  async execute<T>(
    fn: () => Promise<T>,
    context?: any,
    options?: {
      retries?: number;
      retryDelay?: number;
      fallback?: () => T;
      critical?: boolean;
    }
  ): Promise<T | null> {
    const opts = {
      retries: 3,
      retryDelay: 1000,
      critical: false,
      ...options
    };

    let lastError: PoolError | null = null;

    for (let attempt = 0; attempt <= opts.retries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = this.errorHandler.handleError(error as Error, context);

        // Attempt recovery
        const recovered = await this.errorRecovery.attemptRecovery(lastError);
        
        if (recovered) {
          continue;
        }

        // Check if we should retry
        if (!lastError.retryable || attempt === opts.retries) {
          break;
        }

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, opts.retryDelay * (attempt + 1)));
      }
    }

    // Use fallback if provided
    if (opts.fallback && lastError) {
      try {
        return opts.fallback();
      } catch (fallbackError) {
        this.logger.error('Fallback failed', fallbackError as Error);
      }
    }

    // Re-throw if critical
    if (opts.critical && lastError) {
      throw lastError;
    }

    return null;
  }

  /**
   * Execute sync function with error handling
   */
  executeSync<T>(
    fn: () => T,
    context?: any,
    options?: {
      fallback?: () => T;
      critical?: boolean;
    }
  ): T | null {
    const opts = {
      critical: false,
      ...options
    };

    try {
      return fn();
    } catch (error) {
      const poolError = this.errorHandler.handleError(error as Error, context);

      // Use fallback if provided
      if (opts.fallback) {
        try {
          return opts.fallback();
        } catch (fallbackError) {
          this.logger.error('Fallback failed', fallbackError as Error);
        }
      }

      // Re-throw if critical
      if (opts.critical) {
        throw poolError;
      }

      return null;
    }
  }
}

// ===== ERROR BOUNDARY =====
export class ErrorBoundary {
  private errorHandler: ErrorHandler;
  private logger = createComponentLogger('ErrorBoundary');

  constructor(errorHandler: ErrorHandler) {
    this.errorHandler = errorHandler;
  }

  /**
   * Wrap a class method with error handling
   */
  wrap<T extends object>(
    target: T,
    methodName: keyof T,
    context?: any
  ): void {
    const originalMethod = target[methodName];
    
    if (typeof originalMethod !== 'function') {
      throw new Error(`${String(methodName)} is not a function`);
    }

    target[methodName] = (async (...args: any[]) => {
      try {
        return await originalMethod.apply(target, args);
      } catch (error) {
        this.errorHandler.handleError(error as Error, {
          ...context,
          method: String(methodName),
          args
        });
        throw error;
      }
    }) as any;
  }

  /**
   * Wrap all methods of a class
   */
  wrapClass<T extends object>(target: T, context?: any): void {
    const prototype = Object.getPrototypeOf(target);
    const methodNames = Object.getOwnPropertyNames(prototype);

    for (const methodName of methodNames) {
      if (methodName === 'constructor') continue;
      
      const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
      
      if (descriptor && typeof descriptor.value === 'function') {
        this.wrap(target, methodName as keyof T, context);
      }
    }
  }
}

// ===== SINGLETON ERROR MANAGER =====
export class ErrorManager {
  private static instance: ErrorManager;
  
  public readonly handler: ErrorHandler;
  public readonly recovery: ErrorRecovery;
  public readonly executor: SafeExecutor;
  public readonly boundary: ErrorBoundary;

  private constructor() {
    this.handler = new ErrorHandler();
    this.recovery = new ErrorRecovery();
    this.executor = new SafeExecutor(this.handler, this.recovery);
    this.boundary = new ErrorBoundary(this.handler);

    this.setupDefaultRecoveryStrategies();
  }

  static getInstance(): ErrorManager {
    if (!ErrorManager.instance) {
      ErrorManager.instance = new ErrorManager();
    }
    return ErrorManager.instance;
  }

  private setupDefaultRecoveryStrategies(): void {
    // Network error recovery
    this.recovery.registerRecoveryStrategy(ErrorType.NETWORK, async (error) => {
      // Wait and retry
      await new Promise(resolve => setTimeout(resolve, 5000));
      return true;
    });

    // Database error recovery
    this.recovery.registerRecoveryStrategy(ErrorType.DATABASE, async (error) => {
      // Reconnect to database
      // Implementation depends on database client
      return false;
    });

    // Rate limit recovery
    this.recovery.registerRecoveryStrategy(ErrorType.RATE_LIMIT, async (error) => {
      if (error instanceof RateLimitError && error.retryAfter) {
        await new Promise(resolve => setTimeout(resolve, error.retryAfter! * 1000));
        return true;
      }
      return false;
    });
  }
}
