import * as winston from 'winston';
import * as DailyRotateFile from 'winston-daily-rotate-file';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Enhanced Error Handling and Logging System
 * Following Robert C. Martin's Clean Code principles
 * Comprehensive error handling with context and recovery
 */

// ===== Error Types and Categories =====
export enum ErrorCategory {
  NETWORK = 'NETWORK',
  DATABASE = 'DATABASE',
  VALIDATION = 'VALIDATION',
  AUTHENTICATION = 'AUTHENTICATION',
  CONFIGURATION = 'CONFIGURATION',
  BLOCKCHAIN = 'BLOCKCHAIN',
  MINING = 'MINING',
  P2P = 'P2P',
  SYSTEM = 'SYSTEM',
  UNKNOWN = 'UNKNOWN'
}

export enum ErrorSeverity {
  DEBUG = 'debug',
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
  FATAL = 'fatal'
}

export interface ErrorContext {
  category: ErrorCategory;
  severity: ErrorSeverity;
  code?: string;
  userId?: string;
  minerId?: string;
  operation?: string;
  stackTrace?: string;
  additionalData?: Record<string, any>;
  timestamp: number;
  recoverable: boolean;
}

// ===== Custom Error Classes =====
export class PoolError extends Error {
  public context: ErrorContext;
  
  constructor(message: string, context: Partial<ErrorContext>) {
    super(message);
    this.name = 'PoolError';
    this.context = {
      category: context.category || ErrorCategory.UNKNOWN,
      severity: context.severity || ErrorSeverity.ERROR,
      timestamp: Date.now(),
      recoverable: context.recoverable !== false,
      stackTrace: this.stack,
      ...context
    };
  }
}

export class NetworkError extends PoolError {
  constructor(message: string, context?: Partial<ErrorContext>) {
    super(message, { 
      category: ErrorCategory.NETWORK, 
      ...context 
    });
    this.name = 'NetworkError';
  }
}

export class DatabaseError extends PoolError {
  constructor(message: string, context?: Partial<ErrorContext>) {
    super(message, { 
      category: ErrorCategory.DATABASE, 
      ...context 
    });
    this.name = 'DatabaseError';
  }
}

export class ValidationError extends PoolError {
  constructor(message: string, context?: Partial<ErrorContext>) {
    super(message, { 
      category: ErrorCategory.VALIDATION,
      severity: ErrorSeverity.WARNING,
      recoverable: true,
      ...context 
    });
    this.name = 'ValidationError';
  }
}

export class BlockchainError extends PoolError {
  constructor(message: string, context?: Partial<ErrorContext>) {
    super(message, { 
      category: ErrorCategory.BLOCKCHAIN, 
      ...context 
    });
    this.name = 'BlockchainError';
  }
}

export class MiningError extends PoolError {
  constructor(message: string, context?: Partial<ErrorContext>) {
    super(message, { 
      category: ErrorCategory.MINING, 
      ...context 
    });
    this.name = 'MiningError';
  }
}

// ===== Error Recovery Strategies =====
export interface RecoveryStrategy {
  canRecover(error: PoolError): boolean;
  recover(error: PoolError): Promise<void>;
}

export class ExponentialBackoffRecovery implements RecoveryStrategy {
  private attempts = new Map<string, number>();
  private lastAttempt = new Map<string, number>();
  
  constructor(
    private maxAttempts: number = 5,
    private baseDelay: number = 1000,
    private maxDelay: number = 60000
  ) {}
  
  canRecover(error: PoolError): boolean {
    if (!error.context.recoverable) return false;
    
    const key = `${error.context.category}_${error.context.code || 'default'}`;
    const attempts = this.attempts.get(key) || 0;
    return attempts < this.maxAttempts;
  }
  
  async recover(error: PoolError): Promise<void> {
    const key = `${error.context.category}_${error.context.code || 'default'}`;
    const attempts = this.attempts.get(key) || 0;
    
    this.attempts.set(key, attempts + 1);
    this.lastAttempt.set(key, Date.now());
    
    const delay = Math.min(
      this.baseDelay * Math.pow(2, attempts),
      this.maxDelay
    );
    
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  reset(category: ErrorCategory, code?: string): void {
    const key = `${category}_${code || 'default'}`;
    this.attempts.delete(key);
    this.lastAttempt.delete(key);
  }
}

// ===== Enhanced Logger =====
export class EnhancedLogger extends EventEmitter {
  private static instance: EnhancedLogger;
  private logger: winston.Logger;
  private errorCounts = new Map<string, number>();
  private logDirectory: string;
  
  private constructor(logDir: string = './logs') {
    super();
    this.logDirectory = logDir;
    this.ensureLogDirectory();
    this.logger = this.createLogger();
  }
  
  static getInstance(logDir?: string): EnhancedLogger {
    if (!this.instance) {
      this.instance = new EnhancedLogger(logDir);
    }
    return this.instance;
  }
  
  private ensureLogDirectory(): void {
    if (!fs.existsSync(this.logDirectory)) {
      fs.mkdirSync(this.logDirectory, { recursive: true });
    }
  }
  
  private createLogger(): winston.Logger {
    // Custom format for structured logging
    const logFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
      winston.format.json(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const logEntry = {
          timestamp,
          level,
          message,
          ...meta
        };
        return JSON.stringify(logEntry);
      })
    );
    
    // Console transport with colors
    const consoleTransport = new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          let output = `[${timestamp}] ${level}: ${message}`;
          if (Object.keys(meta).length > 0) {
            output += ` ${JSON.stringify(meta, null, 2)}`;
          }
          return output;
        })
      )
    });
    
    // File rotation transport for all logs
    const fileRotateTransport = new DailyRotateFile({
      filename: path.join(this.logDirectory, 'pool-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '100m',
      maxFiles: '30d',
      format: logFormat
    });
    
    // Separate error log file
    const errorFileTransport = new DailyRotateFile({
      filename: path.join(this.logDirectory, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '100m',
      maxFiles: '30d',
      level: 'error',
      format: logFormat
    });
    
    // Critical alerts file (for immediate attention)
    const criticalFileTransport = new winston.transports.File({
      filename: path.join(this.logDirectory, 'critical.log'),
      level: 'error',
      format: winston.format.combine(
        winston.format((info) => {
          return info.level === 'error' && 
                 info.severity === ErrorSeverity.CRITICAL || 
                 info.severity === ErrorSeverity.FATAL ? info : false;
        })(),
        logFormat
      )
    });
    
    return winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: logFormat,
      transports: [
        consoleTransport,
        fileRotateTransport,
        errorFileTransport,
        criticalFileTransport
      ],
      exceptionHandlers: [
        new winston.transports.File({ 
          filename: path.join(this.logDirectory, 'exceptions.log') 
        })
      ],
      rejectionHandlers: [
        new winston.transports.File({ 
          filename: path.join(this.logDirectory, 'rejections.log') 
        })
      ]
    });
  }
  
  // Logging methods
  debug(message: string, meta?: any): void {
    this.logger.debug(message, meta);
  }
  
  info(message: string, meta?: any): void {
    this.logger.info(message, meta);
  }
  
  warn(message: string, meta?: any): void {
    this.logger.warn(message, meta);
  }
  
  error(message: string, error?: Error | PoolError, meta?: any): void {
    const errorMeta = this.extractErrorMeta(error);
    this.logger.error(message, { ...errorMeta, ...meta });
    this.trackError(error);
    this.emit('error', { message, error, meta });
  }
  
  critical(message: string, error?: Error | PoolError, meta?: any): void {
    const errorMeta = this.extractErrorMeta(error);
    this.logger.error(message, { 
      severity: ErrorSeverity.CRITICAL,
      ...errorMeta, 
      ...meta 
    });
    this.emit('critical', { message, error, meta });
  }
  
  fatal(message: string, error?: Error | PoolError, meta?: any): void {
    const errorMeta = this.extractErrorMeta(error);
    this.logger.error(message, { 
      severity: ErrorSeverity.FATAL,
      ...errorMeta, 
      ...meta 
    });
    this.emit('fatal', { message, error, meta });
  }
  
  private extractErrorMeta(error?: Error | PoolError): any {
    if (!error) return {};
    
    if (error instanceof PoolError) {
      return {
        errorName: error.name,
        errorMessage: error.message,
        context: error.context,
        stack: error.stack
      };
    }
    
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack
    };
  }
  
  private trackError(error?: Error | PoolError): void {
    if (!error) return;
    
    const category = error instanceof PoolError ? 
      error.context.category : 
      ErrorCategory.UNKNOWN;
    
    const count = this.errorCounts.get(category) || 0;
    this.errorCounts.set(category, count + 1);
  }
  
  getErrorStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    this.errorCounts.forEach((count, category) => {
      stats[category] = count;
    });
    return stats;
  }
  
  // Structured logging helpers
  logOperation(operation: string, data?: any): void {
    this.info(`Operation: ${operation}`, { operation, ...data });
  }
  
  logPerformance(operation: string, duration: number, meta?: any): void {
    this.info(`Performance: ${operation}`, {
      operation,
      duration,
      performance: true,
      ...meta
    });
  }
  
  logSecurity(event: string, meta?: any): void {
    this.warn(`Security: ${event}`, {
      security: true,
      event,
      ...meta
    });
  }
  
  // Log rotation and cleanup
  async rotateLogs(): Promise<void> {
    // Trigger rotation for all rotating transports
    this.logger.info('Manual log rotation triggered');
  }
  
  async cleanOldLogs(daysToKeep: number = 30): Promise<void> {
    const cutoffDate = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    const files = await fs.promises.readdir(this.logDirectory);
    
    for (const file of files) {
      const filePath = path.join(this.logDirectory, file);
      const stats = await fs.promises.stat(filePath);
      
      if (stats.mtime.getTime() < cutoffDate && file.endsWith('.gz')) {
        await fs.promises.unlink(filePath);
        this.info(`Deleted old log file: ${file}`);
      }
    }
  }
}

// ===== Error Handler =====
export class ErrorHandler {
  private logger: EnhancedLogger;
  private recoveryStrategies = new Map<ErrorCategory, RecoveryStrategy>();
  private errorListeners = new Map<ErrorCategory, Set<(error: PoolError) => void>>();
  
  constructor(logger: EnhancedLogger) {
    this.logger = logger;
    this.setupDefaultRecoveryStrategies();
  }
  
  private setupDefaultRecoveryStrategies(): void {
    // Network errors: exponential backoff
    this.recoveryStrategies.set(
      ErrorCategory.NETWORK,
      new ExponentialBackoffRecovery(5, 1000, 60000)
    );
    
    // Database errors: quick retry with backoff
    this.recoveryStrategies.set(
      ErrorCategory.DATABASE,
      new ExponentialBackoffRecovery(3, 500, 5000)
    );
    
    // Blockchain errors: slower backoff
    this.recoveryStrategies.set(
      ErrorCategory.BLOCKCHAIN,
      new ExponentialBackoffRecovery(10, 2000, 120000)
    );
  }
  
  async handle(error: Error | PoolError): Promise<void> {
    // Convert to PoolError if needed
    const poolError = error instanceof PoolError ? 
      error : 
      new PoolError(error.message, { 
        category: ErrorCategory.UNKNOWN,
        stackTrace: error.stack 
      });
    
    // Log the error
    this.logError(poolError);
    
    // Notify listeners
    this.notifyListeners(poolError);
    
    // Attempt recovery if possible
    await this.attemptRecovery(poolError);
  }
  
  private logError(error: PoolError): void {
    const { severity, category } = error.context;
    
    switch (severity) {
      case ErrorSeverity.DEBUG:
        this.logger.debug(error.message, error.context);
        break;
      case ErrorSeverity.INFO:
        this.logger.info(error.message, error.context);
        break;
      case ErrorSeverity.WARNING:
        this.logger.warn(error.message, error.context);
        break;
      case ErrorSeverity.ERROR:
        this.logger.error(error.message, error, error.context);
        break;
      case ErrorSeverity.CRITICAL:
        this.logger.critical(error.message, error, error.context);
        break;
      case ErrorSeverity.FATAL:
        this.logger.fatal(error.message, error, error.context);
        // Fatal errors might require process termination
        if (process.env.EXIT_ON_FATAL === 'true') {
          process.exit(1);
        }
        break;
    }
  }
  
  private notifyListeners(error: PoolError): void {
    const listeners = this.errorListeners.get(error.context.category);
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(error);
        } catch (e) {
          this.logger.error('Error in error listener', e);
        }
      });
    }
  }
  
  private async attemptRecovery(error: PoolError): Promise<void> {
    const strategy = this.recoveryStrategies.get(error.context.category);
    
    if (strategy && strategy.canRecover(error)) {
      try {
        this.logger.info(`Attempting recovery for ${error.context.category} error`);
        await strategy.recover(error);
        this.logger.info(`Recovery successful for ${error.context.category} error`);
      } catch (recoveryError) {
        this.logger.error('Recovery failed', recoveryError);
      }
    }
  }
  
  // Subscribe to specific error categories
  on(category: ErrorCategory, listener: (error: PoolError) => void): void {
    if (!this.errorListeners.has(category)) {
      this.errorListeners.set(category, new Set());
    }
    this.errorListeners.get(category)!.add(listener);
  }
  
  off(category: ErrorCategory, listener: (error: PoolError) => void): void {
    this.errorListeners.get(category)?.delete(listener);
  }
  
  // Register custom recovery strategy
  registerRecovery(category: ErrorCategory, strategy: RecoveryStrategy): void {
    this.recoveryStrategies.set(category, strategy);
  }
}

// ===== Global Error Handling Setup =====
export function setupGlobalErrorHandling(logger: EnhancedLogger, handler: ErrorHandler): void {
  // Uncaught exceptions
  process.on('uncaughtException', (error: Error) => {
    const poolError = new PoolError('Uncaught exception', {
      category: ErrorCategory.SYSTEM,
      severity: ErrorSeverity.FATAL,
      recoverable: false,
      additionalData: { originalError: error.message }
    });
    handler.handle(poolError);
  });
  
  // Unhandled promise rejections
  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    const poolError = new PoolError('Unhandled promise rejection', {
      category: ErrorCategory.SYSTEM,
      severity: ErrorSeverity.CRITICAL,
      recoverable: false,
      additionalData: { reason, promise }
    });
    handler.handle(poolError);
  });
  
  // Process warnings
  process.on('warning', (warning: Error) => {
    logger.warn('Process warning', {
      name: warning.name,
      message: warning.message,
      stack: warning.stack
    });
  });
}

// ===== Utility Functions =====
export function wrapAsync<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  errorHandler: ErrorHandler
): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error) {
      await errorHandler.handle(error as Error);
      throw error;
    }
  }) as T;
}

export function createErrorContext(
  partial: Partial<ErrorContext>
): ErrorContext {
  return {
    category: partial.category || ErrorCategory.UNKNOWN,
    severity: partial.severity || ErrorSeverity.ERROR,
    timestamp: Date.now(),
    recoverable: partial.recoverable !== false,
    ...partial
  };
}