import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Unified Logging System
 * Philosophy: Central logging with structured output (Martin)
 * Performance: Async logging, minimal overhead (Carmack)
 * Simplicity: Clear interface, automatic rotation (Pike)
 */

interface LoggingConfig {
  level: 'error' | 'warn' | 'info' | 'debug';
  format: 'json' | 'text';
  file: {
    enabled: boolean;
    path: string;
    maxSize: string;
    maxFiles: string;
    datePattern: string;
  };
  console: {
    enabled: boolean;
    colorize: boolean;
  };
}

interface LogContext {
  component?: string;
  operation?: string;
  minerId?: string;
  shareId?: string;
  blockHeight?: number;
  traceId?: string;
  duration?: number;
  [key: string]: any;
}

export class UnifiedLogger {
  private winston: winston.Logger;
  private defaultContext: LogContext = {};

  constructor(private config: LoggingConfig) {
    this.initializeLogger();
  }

  private initializeLogger(): void {
    const transports: winston.transport[] = [];

    // Console transport
    if (this.config.console.enabled) {
      transports.push(
        new winston.transports.Console({
          format: this.createConsoleFormat(),
          level: this.config.level
        })
      );
    }

    // File transport with rotation
    if (this.config.file.enabled) {
      this.ensureLogDirectory();
      
      // Error log (errors only)
      transports.push(
        new DailyRotateFile({
          filename: path.join(this.config.file.path, 'error', 'error-%DATE%.log'),
          datePattern: this.config.file.datePattern,
          level: 'error',
          maxSize: this.config.file.maxSize,
          maxFiles: this.config.file.maxFiles,
          format: this.createFileFormat(),
          handleExceptions: true,
          handleRejections: true
        })
      );

      // Combined log (all levels)
      transports.push(
        new DailyRotateFile({
          filename: path.join(this.config.file.path, 'combined', 'combined-%DATE%.log'),
          datePattern: this.config.file.datePattern,
          level: this.config.level,
          maxSize: this.config.file.maxSize,
          maxFiles: this.config.file.maxFiles,
          format: this.createFileFormat()
        })
      );

      // Performance log (for metrics)
      transports.push(
        new DailyRotateFile({
          filename: path.join(this.config.file.path, 'performance', 'performance-%DATE%.log'),
          datePattern: this.config.file.datePattern,
          level: 'info',
          maxSize: this.config.file.maxSize,
          maxFiles: this.config.file.maxFiles,
          format: this.createFileFormat(),
          filter: (info) => info.category === 'performance'
        })
      );
    }

    this.winston = winston.createLogger({
      level: this.config.level,
      transports,
      exitOnError: false,
      rejectionHandlers: [
        new winston.transports.File({ filename: path.join(this.config.file.path, 'rejections', 'rejections.log') })
      ],
      exceptionHandlers: [
        new winston.transports.File({ filename: path.join(this.config.file.path, 'exceptions', 'exceptions.log') })
      ]
    });
  }

  private createConsoleFormat(): winston.Logform.Format {
    if (this.config.console.colorize) {
      return winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${level}] ${message}${metaStr}`;
        })
      );
    } else {
      return winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      );
    }
  }

  private createFileFormat(): winston.Logform.Format {
    return winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    );
  }

  private ensureLogDirectory(): void {
    const base = this.config.file.path;
    const subDirs = ['error', 'combined', 'performance', 'exceptions', 'rejections'];

    if (!fs.existsSync(base)) {
      fs.mkdirSync(base, { recursive: true });
    }

    for (const dir of subDirs) {
      const subPath = path.join(base, dir);
      if (!fs.existsSync(subPath)) {
        fs.mkdirSync(subPath, { recursive: true });
      }
    }
  }

  // Core logging methods
  public error(message: string, context?: LogContext | Error): void {
    this.log('error', message, context);
  }

  public warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  public info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  public debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  private log(level: string, message: string, context?: LogContext | Error): void {
    const logData: any = {
      ...this.defaultContext,
      message
    };

    if (context instanceof Error) {
      logData.error = {
        name: context.name,
        message: context.message,
        stack: context.stack
      };
    } else if (context) {
      Object.assign(logData, context);
    }

    this.winston.log(level, logData);
  }

  // Mining-specific logging methods
  public shareSubmitted(minerId: string, shareData: any): void {
    this.info('Share submitted', {
      component: 'mining',
      operation: 'share_submitted',
      minerId,
      shareId: shareData.id,
      difficulty: shareData.difficulty,
      target: shareData.target
    });
  }

  public shareAccepted(minerId: string, shareData: any): void {
    this.info('Share accepted', {
      component: 'mining',
      operation: 'share_accepted',
      minerId,
      shareId: shareData.id,
      difficulty: shareData.difficulty
    });
  }

  public shareRejected(minerId: string, shareData: any, reason: string): void {
    this.warn('Share rejected', {
      component: 'mining',
      operation: 'share_rejected',
      minerId,
      shareId: shareData.id,
      reason
    });
  }

  public blockFound(blockData: any): void {
    this.info('Block found!', {
      component: 'mining',
      operation: 'block_found',
      blockHeight: blockData.height,
      blockHash: blockData.hash,
      finder: blockData.finder
    });
  }

  public payoutProcessed(payoutData: any): void {
    this.info('Payout processed', {
      component: 'payment',
      operation: 'payout_processed',
      amount: payoutData.amount,
      recipients: payoutData.recipients?.length,
      transactionId: payoutData.txId
    });
  }

  // Performance logging
  public performance(operation: string, duration: number, context?: LogContext): void {
    this.info(`Performance: ${operation}`, {
      category: 'performance',
      operation,
      duration,
      ...context
    });
  }

  // Security logging
  public securityEvent(event: string, context?: LogContext): void {
    this.warn(`Security: ${event}`, {
      category: 'security',
      event,
      ...context
    });
  }

  // P2P logging
  public peerConnected(peerId: string, address: string): void {
    this.info('Peer connected', {
      component: 'p2p',
      operation: 'peer_connected',
      peerId,
      address
    });
  }

  public peerDisconnected(peerId: string, reason?: string): void {
    this.info('Peer disconnected', {
      component: 'p2p',
      operation: 'peer_disconnected',
      peerId,
      reason
    });
  }

  // Database logging
  public dbOperation(operation: string, table: string, duration: number, rowsAffected?: number): void {
    if (duration > 100) { // Log slow queries
      this.warn('Slow database operation', {
        component: 'database',
        operation,
        table,
        duration,
        rowsAffected
      });
    } else {
      this.debug('Database operation', {
        component: 'database',
        operation,
        table,
        duration,
        rowsAffected
      });
    }
  }

  // Context management
  public withContext(context: LogContext): UnifiedLogger {
    const logger = new UnifiedLogger(this.config);
    logger.winston = this.winston;
    logger.defaultContext = { ...this.defaultContext, ...context };
    return logger;
  }

  public setDefaultContext(context: LogContext): void {
    this.defaultContext = { ...this.defaultContext, ...context };
  }

  // Utility methods
  public startTimer(operation: string): () => void {
    const start = Date.now();
    return () => {
      const duration = Date.now() - start;
      this.performance(operation, duration);
    };
  }

  public async timeAsync<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - start;
      this.performance(operation, duration);
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      this.error(`Operation failed: ${operation}`, {
        operation,
        duration,
        error: error instanceof Error ? error : new Error(String(error))
      });
      throw error;
    }
  }

  // Stream interface for external libraries
  public createWriteStream(level: string = 'info'): NodeJS.WritableStream {
    return {
      write: (message: string) => {
        this.winston.log(level, message.trim());
        return true;
      }
    } as NodeJS.WritableStream;
  }

  // Graceful shutdown
  public async close(): Promise<void> {
    return new Promise((resolve) => {
      this.winston.end(() => {
        resolve();
      });
    });
  }

  // Log level management
  public setLevel(level: string): void {
    this.winston.level = level;
    this.winston.transports.forEach(transport => {
      transport.level = level;
    });
  }

  public getLevel(): string {
    return this.winston.level;
  }

  // Health check
  public isHealthy(): boolean {
    try {
      // Test if we can write to log
      this.debug('Health check');
      return true;
    } catch {
      return false;
    }
  }

  // Metrics for monitoring
  public getMetrics(): any {
    return {
      level: this.winston.level,
      transports: this.winston.transports.length,
      // Add transport-specific metrics if needed
    };
  }
}