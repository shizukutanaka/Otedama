/**
 * Enhanced logging system with structured logging and rotation
 * Following principles: clear, efficient, maintainable
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { createWriteStream, WriteStream } from 'fs';

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4
}

export interface LogConfig {
  level: LogLevel;
  console: boolean;
  file: boolean;
  filePath: string;
  maxFileSize: number; // bytes
  maxFiles: number;
  jsonFormat: boolean;
  includeTimestamp: boolean;
  includeLevel: boolean;
}

export interface LogEntry {
  timestamp: Date;
  level: string;
  message: string;
  context?: any;
  error?: Error;
  tags?: string[];
}

export class Logger extends EventEmitter {
  private static instances = new Map<string, Logger>();
  private config: LogConfig;
  private fileStream?: WriteStream;
  private currentFileSize = 0;
  private fileIndex = 0;
  private buffer: LogEntry[] = [];
  private flushTimer?: NodeJS.Timeout;

  constructor(private name: string, config: Partial<LogConfig> = {}) {
    super();
    
    this.config = {
      level: LogLevel.INFO,
      console: true,
      file: true,
      filePath: path.join(process.cwd(), 'logs', `${name}.log`),
      maxFileSize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      jsonFormat: false,
      includeTimestamp: true,
      includeLevel: true,
      ...config
    };

    if (this.config.file) {
      this.initializeFileLogging();
    }

    this.startFlushTimer();
  }

  static getInstance(name: string = 'default', config?: Partial<LogConfig>): Logger {
    if (!this.instances.has(name)) {
      this.instances.set(name, new Logger(name, config));
    }
    return this.instances.get(name)!;
  }

  private initializeFileLogging(): void {
    const dir = path.dirname(this.config.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.openLogFile();
  }

  private openLogFile(): void {
    const filename = this.getLogFilename();
    
    if (fs.existsSync(filename)) {
      this.currentFileSize = fs.statSync(filename).size;
    }

    this.fileStream = createWriteStream(filename, { flags: 'a' });
    
    this.fileStream.on('error', (error) => {
      console.error('Log file error:', error);
      this.emit('error', error);
    });
  }

  private getLogFilename(): string {
    if (this.fileIndex === 0) {
      return this.config.filePath;
    }
    
    const ext = path.extname(this.config.filePath);
    const base = path.basename(this.config.filePath, ext);
    const dir = path.dirname(this.config.filePath);
    
    return path.join(dir, `${base}.${this.fileIndex}${ext}`);
  }

  private rotateLogFile(): void {
    if (this.fileStream) {
      this.fileStream.end();
    }

    // Rotate files
    for (let i = this.config.maxFiles - 1; i > 0; i--) {
      const oldFile = this.getLogFilenameWithIndex(i - 1);
      const newFile = this.getLogFilenameWithIndex(i);
      
      if (fs.existsSync(oldFile)) {
        if (fs.existsSync(newFile)) {
          fs.unlinkSync(newFile);
        }
        fs.renameSync(oldFile, newFile);
      }
    }

    this.fileIndex = 0;
    this.currentFileSize = 0;
    this.openLogFile();
  }

  private getLogFilenameWithIndex(index: number): string {
    if (index === 0) {
      return this.config.filePath;
    }
    
    const ext = path.extname(this.config.filePath);
    const base = path.basename(this.config.filePath, ext);
    const dir = path.dirname(this.config.filePath);
    
    return path.join(dir, `${base}.${index}${ext}`);
  }

  error(message: string, error?: Error | any, context?: any): void {
    this.log(LogLevel.ERROR, message, context, error);
  }

  warn(message: string, context?: any): void {
    this.log(LogLevel.WARN, message, context);
  }

  info(message: string, context?: any): void {
    this.log(LogLevel.INFO, message, context);
  }

  debug(message: string, context?: any): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  trace(message: string, context?: any): void {
    this.log(LogLevel.TRACE, message, context);
  }

  private log(level: LogLevel, message: string, context?: any, error?: Error | any): void {
    if (level > this.config.level) return;

    const entry: LogEntry = {
      timestamp: new Date(),
      level: LogLevel[level],
      message,
      context,
      error: error instanceof Error ? {
        message: error.message,
        stack: error.stack,
        name: error.name
      } : error
    };

    this.buffer.push(entry);

    // Immediate flush for errors
    if (level === LogLevel.ERROR) {
      this.flush();
    }
  }

  private format(entry: LogEntry): string {
    if (this.config.jsonFormat) {
      return JSON.stringify({
        ...entry,
        logger: this.name,
        timestamp: entry.timestamp.toISOString()
      });
    }

    const parts: string[] = [];

    if (this.config.includeTimestamp) {
      parts.push(`[${entry.timestamp.toISOString()}]`);
    }

    if (this.config.includeLevel) {
      parts.push(`[${entry.level}]`);
    }

    parts.push(`[${this.name}]`);
    parts.push(entry.message);

    if (entry.context) {
      parts.push(JSON.stringify(entry.context));
    }

    if (entry.error) {
      parts.push(`\nError: ${entry.error.message}`);
      if (entry.error.stack) {
        parts.push(`\nStack: ${entry.error.stack}`);
      }
    }

    return parts.join(' ');
  }

  private flush(): void {
    if (this.buffer.length === 0) return;

    const entries = [...this.buffer];
    this.buffer = [];

    for (const entry of entries) {
      const formatted = this.format(entry);

      // Console output
      if (this.config.console) {
        switch (entry.level) {
          case 'ERROR':
            console.error(formatted);
            break;
          case 'WARN':
            console.warn(formatted);
            break;
          case 'DEBUG':
          case 'TRACE':
            console.debug(formatted);
            break;
          default:
            console.log(formatted);
        }
      }

      // File output
      if (this.config.file && this.fileStream) {
        const line = formatted + '\n';
        const bytes = Buffer.byteLength(line);

        // Check if rotation needed
        if (this.currentFileSize + bytes > this.config.maxFileSize) {
          this.rotateLogFile();
        }

        this.fileStream.write(line);
        this.currentFileSize += bytes;
      }

      // Emit for external handlers
      this.emit('log', entry);
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, 1000); // Flush every second
  }

  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  addTag(tag: string): Logger {
    // Return a child logger with tags
    const childLogger = new Logger(`${this.name}:${tag}`, this.config);
    return childLogger;
  }

  child(context: any): Logger {
    // Return a child logger with context
    const childLogger = new Logger(this.name, this.config);
    childLogger.defaultContext = context;
    return childLogger;
  }

  private defaultContext?: any;

  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    this.flush();

    if (this.fileStream) {
      this.fileStream.end();
    }
  }

  static closeAll(): void {
    for (const logger of this.instances.values()) {
      logger.close();
    }
    this.instances.clear();
  }
}

// Structured logging helpers
export class LogContext {
  private data: Record<string, any> = {};

  add(key: string, value: any): LogContext {
    this.data[key] = value;
    return this;
  }

  addError(error: Error): LogContext {
    this.data.error = {
      message: error.message,
      stack: error.stack,
      name: error.name
    };
    return this;
  }

  addDuration(startTime: number): LogContext {
    this.data.duration = Date.now() - startTime;
    return this;
  }

  addMiner(minerId: string, address?: string): LogContext {
    this.data.minerId = minerId;
    if (address) this.data.minerAddress = address;
    return this;
  }

  addShare(shareData: any): LogContext {
    this.data.share = shareData;
    return this;
  }

  addNetwork(ip?: string, port?: number): LogContext {
    if (ip) this.data.ip = ip;
    if (port) this.data.port = port;
    return this;
  }

  build(): Record<string, any> {
    return { ...this.data };
  }
}

// Performance logging decorator
export function logPerformance(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
  const originalMethod = descriptor.value;
  const logger = Logger.getInstance(target.constructor.name);

  descriptor.value = async function (...args: any[]) {
    const startTime = Date.now();
    const context = new LogContext()
      .add('method', propertyKey)
      .add('args', args);

    try {
      const result = await originalMethod.apply(this, args);
      
      context.addDuration(startTime);
      logger.debug(`${propertyKey} completed`, context.build());
      
      return result;
    } catch (error) {
      context.addDuration(startTime).addError(error as Error);
      logger.error(`${propertyKey} failed`, error, context.build());
      throw error;
    }
  };

  return descriptor;
}

// Global error handler
export function setupGlobalErrorHandlers(logger: Logger): void {
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection', reason as Error, { promise });
  });

  process.on('warning', (warning) => {
    logger.warn('Process warning', { warning });
  });
}
