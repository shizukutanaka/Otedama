/**
 * Structured Logger - Otedama
 * Enhanced logging with structured data support
 * 
 * Design: Observable systems need good logs (Carmack)
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';

/**
 * Log levels
 */
export const LogLevel = {
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
  FATAL: 60
};

/**
 * Log formatter interface
 */
export class LogFormatter {
  format(record) {
    throw new Error('Formatter must implement format method');
  }
}

/**
 * JSON formatter
 */
export class JSONFormatter extends LogFormatter {
  constructor(options = {}) {
    super();
    this.options = {
      pretty: options.pretty || false,
      includeStack: options.includeStack !== false,
      ...options
    };
  }
  
  format(record) {
    const formatted = {
      timestamp: record.timestamp.toISOString(),
      level: record.levelName,
      logger: record.logger,
      message: record.message,
      ...record.context
    };
    
    if (record.error) {
      formatted.error = {
        name: record.error.name,
        message: record.error.message,
        code: record.error.code
      };
      
      if (this.options.includeStack && record.error.stack) {
        formatted.error.stack = record.error.stack.split('\n');
      }
    }
    
    if (this.options.pretty) {
      return JSON.stringify(formatted, null, 2) + '\n';
    }
    
    return JSON.stringify(formatted) + '\n';
  }
}

/**
 * Human-readable formatter
 */
export class HumanFormatter extends LogFormatter {
  constructor(options = {}) {
    super();
    this.options = {
      colorize: options.colorize !== false,
      includeContext: options.includeContext !== false,
      ...options
    };
    
    this.colors = {
      TRACE: '\x1b[90m',  // Gray
      DEBUG: '\x1b[36m',  // Cyan
      INFO: '\x1b[32m',   // Green
      WARN: '\x1b[33m',   // Yellow
      ERROR: '\x1b[31m',  // Red
      FATAL: '\x1b[35m',  // Magenta
      RESET: '\x1b[0m'
    };
  }
  
  format(record) {
    const timestamp = record.timestamp.toISOString();
    const level = record.levelName.padEnd(5);
    const logger = `[${record.logger}]`;
    
    let line = `${timestamp} ${level} ${logger} ${record.message}`;
    
    if (this.options.colorize && process.stdout.isTTY) {
      const color = this.colors[record.levelName] || this.colors.RESET;
      line = `${color}${line}${this.colors.RESET}`;
    }
    
    if (this.options.includeContext && Object.keys(record.context).length > 0) {
      line += ` ${JSON.stringify(record.context)}`;
    }
    
    if (record.error) {
      line += `\n${record.error.stack || record.error.message}`;
    }
    
    return line + '\n';
  }
}

/**
 * Log handler interface
 */
export class LogHandler {
  constructor(options = {}) {
    this.level = options.level || LogLevel.INFO;
    this.formatter = options.formatter || new JSONFormatter();
  }
  
  shouldHandle(record) {
    return record.level >= this.level;
  }
  
  async handle(record) {
    throw new Error('Handler must implement handle method');
  }
  
  async close() {
    // Override in subclasses if needed
  }
}

/**
 * Console handler
 */
export class ConsoleHandler extends LogHandler {
  constructor(options = {}) {
    super(options);
    this.stream = options.stream || process.stdout;
  }
  
  async handle(record) {
    if (!this.shouldHandle(record)) return;
    
    const formatted = this.formatter.format(record);
    this.stream.write(formatted);
  }
}

/**
 * File handler with rotation
 */
export class FileHandler extends LogHandler {
  constructor(filename, options = {}) {
    super(options);
    
    this.filename = filename;
    this.options = {
      maxSize: options.maxSize || 10 * 1024 * 1024, // 10MB
      maxFiles: options.maxFiles || 5,
      compress: options.compress || false,
      ...options
    };
    
    this.stream = null;
    this.currentSize = 0;
    this.opening = false;
  }
  
  async open() {
    if (this.stream || this.opening) return;
    
    this.opening = true;
    
    try {
      // Create directory if needed
      const dir = path.dirname(this.filename);
      await fs.promises.mkdir(dir, { recursive: true });
      
      // Check if file exists and get size
      try {
        const stat = await fs.promises.stat(this.filename);
        this.currentSize = stat.size;
      } catch {
        this.currentSize = 0;
      }
      
      // Create write stream
      this.stream = createWriteStream(this.filename, {
        flags: 'a',
        encoding: 'utf8'
      });
      
      this.stream.on('error', (error) => {
        console.error('Log file error:', error);
        this.stream = null;
      });
      
    } finally {
      this.opening = false;
    }
  }
  
  async handle(record) {
    if (!this.shouldHandle(record)) return;
    
    await this.open();
    
    const formatted = this.formatter.format(record);
    const size = Buffer.byteLength(formatted);
    
    // Check if rotation needed
    if (this.currentSize + size > this.options.maxSize) {
      await this.rotate();
    }
    
    if (this.stream) {
      this.stream.write(formatted);
      this.currentSize += size;
    }
  }
  
  async rotate() {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    
    // Rotate files
    for (let i = this.options.maxFiles - 1; i > 0; i--) {
      const oldFile = i === 1 ? this.filename : `${this.filename}.${i - 1}`;
      const newFile = `${this.filename}.${i}`;
      
      try {
        await fs.promises.rename(oldFile, newFile);
      } catch {
        // File doesn't exist
      }
    }
    
    // Compress if enabled
    if (this.options.compress) {
      const lastFile = `${this.filename}.${this.options.maxFiles}`;
      try {
        await this.compressFile(lastFile);
      } catch {
        // Ignore compression errors
      }
    }
    
    this.currentSize = 0;
    await this.open();
  }
  
  async compressFile(filename) {
    const zlib = require('zlib');
    const source = createReadStream(filename);
    const destination = createWriteStream(`${filename}.gz`);
    const gzip = zlib.createGzip();
    
    await pipeline(source, gzip, destination);
    await fs.promises.unlink(filename);
  }
  
  async close() {
    if (this.stream) {
      await new Promise(resolve => {
        this.stream.end(resolve);
      });
      this.stream = null;
    }
  }
}

/**
 * Buffer handler for testing
 */
export class BufferHandler extends LogHandler {
  constructor(options = {}) {
    super(options);
    this.buffer = [];
    this.maxSize = options.maxSize || 1000;
  }
  
  async handle(record) {
    if (!this.shouldHandle(record)) return;
    
    this.buffer.push(record);
    
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }
  
  getRecords() {
    return [...this.buffer];
  }
  
  clear() {
    this.buffer = [];
  }
}

/**
 * Stream handler for log aggregation
 */
export class StreamHandler extends LogHandler {
  constructor(stream, options = {}) {
    super(options);
    this.stream = stream;
  }
  
  async handle(record) {
    if (!this.shouldHandle(record)) return;
    
    const formatted = this.formatter.format(record);
    
    return new Promise((resolve, reject) => {
      this.stream.write(formatted, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  
  async close() {
    if (this.stream && this.stream.end) {
      await new Promise(resolve => {
        this.stream.end(resolve);
      });
    }
  }
}

/**
 * Enhanced logger with structured logging
 */
export class StructuredLogger extends EventEmitter {
  constructor(name, options = {}) {
    super();
    
    this.name = name;
    this.level = options.level || LogLevel.INFO;
    this.handlers = [];
    this.context = {};
    this.children = new Map();
  }
  
  addHandler(handler) {
    this.handlers.push(handler);
  }
  
  removeHandler(handler) {
    const index = this.handlers.indexOf(handler);
    if (index !== -1) {
      this.handlers.splice(index, 1);
    }
  }
  
  setLevel(level) {
    this.level = level;
  }
  
  setContext(context) {
    this.context = { ...this.context, ...context };
  }
  
  clearContext() {
    this.context = {};
  }
  
  child(name, context = {}) {
    const childName = `${this.name}.${name}`;
    
    if (!this.children.has(childName)) {
      const child = new StructuredLogger(childName, { level: this.level });
      
      // Inherit handlers
      this.handlers.forEach(handler => child.addHandler(handler));
      
      this.children.set(childName, child);
    }
    
    const child = this.children.get(childName);
    child.setContext({ ...this.context, ...context });
    
    return child;
  }
  
  async log(level, message, context = {}) {
    if (level < this.level) return;
    
    const record = {
      timestamp: new Date(),
      level,
      levelName: this.getLevelName(level),
      logger: this.name,
      message,
      context: { ...this.context, ...context },
      error: context.error || context.err
    };
    
    // Remove error from context to avoid duplication
    delete record.context.error;
    delete record.context.err;
    
    // Emit for monitoring
    this.emit('log', record);
    
    // Send to handlers
    await Promise.all(
      this.handlers.map(handler => 
        handler.handle(record).catch(error => {
          console.error('Log handler error:', error);
        })
      )
    );
  }
  
  trace(message, context) {
    return this.log(LogLevel.TRACE, message, context);
  }
  
  debug(message, context) {
    return this.log(LogLevel.DEBUG, message, context);
  }
  
  info(message, context) {
    return this.log(LogLevel.INFO, message, context);
  }
  
  warn(message, context) {
    return this.log(LogLevel.WARN, message, context);
  }
  
  error(message, context) {
    if (message instanceof Error) {
      return this.log(LogLevel.ERROR, message.message, {
        ...context,
        error: message
      });
    }
    return this.log(LogLevel.ERROR, message, context);
  }
  
  fatal(message, context) {
    return this.log(LogLevel.FATAL, message, context);
  }
  
  getLevelName(level) {
    for (const [name, value] of Object.entries(LogLevel)) {
      if (value === level) return name;
    }
    return 'UNKNOWN';
  }
  
  async close() {
    await Promise.all(
      this.handlers.map(handler => handler.close())
    );
  }
}

/**
 * Log manager singleton
 */
export class LogManager {
  constructor() {
    this.loggers = new Map();
    this.defaultHandlers = [];
    this.defaultLevel = LogLevel.INFO;
  }
  
  getLogger(name) {
    if (!this.loggers.has(name)) {
      const logger = new StructuredLogger(name, {
        level: this.defaultLevel
      });
      
      // Add default handlers
      this.defaultHandlers.forEach(handler => {
        logger.addHandler(handler);
      });
      
      this.loggers.set(name, logger);
    }
    
    return this.loggers.get(name);
  }
  
  addDefaultHandler(handler) {
    this.defaultHandlers.push(handler);
    
    // Add to existing loggers
    for (const logger of this.loggers.values()) {
      logger.addHandler(handler);
    }
  }
  
  setDefaultLevel(level) {
    this.defaultLevel = level;
    
    // Update existing loggers
    for (const logger of this.loggers.values()) {
      logger.setLevel(level);
    }
  }
  
  async close() {
    // Close all logger handlers
    await Promise.all(
      Array.from(this.loggers.values()).map(logger => logger.close())
    );
    
    // Clear
    this.loggers.clear();
    this.defaultHandlers = [];
  }
}

// Singleton instance
export const logManager = new LogManager();

// Setup default console handler
if (process.env.NODE_ENV !== 'test') {
  const formatter = process.env.LOG_FORMAT === 'json' 
    ? new JSONFormatter()
    : new HumanFormatter();
  
  logManager.addDefaultHandler(new ConsoleHandler({ formatter }));
}

// Convenience function
export function createStructuredLogger(name) {
  return logManager.getLogger(name);
}

// Winston-compatible API wrapper
export function createLogger(moduleName) {
  const logger = createStructuredLogger(moduleName);
  
  // Add Winston-compatible methods
  const winstonLogger = {
    module: moduleName,
    
    error: (message, ...args) => {
      const meta = args[0] || {};
      logger.error(message, meta);
    },
    
    warn: (message, ...args) => {
      const meta = args[0] || {};
      logger.warn(message, meta);
    },
    
    info: (message, ...args) => {
      const meta = args[0] || {};
      logger.info(message, meta);
    },
    
    debug: (message, ...args) => {
      const meta = args[0] || {};
      logger.debug(message, meta);
    },
    
    trace: (message, ...args) => {
      const meta = args[0] || {};
      logger.trace(message, meta);
    },
    
    log: (level, message, ...args) => {
      const meta = args[0] || {};
      const levelMap = {
        error: LogLevel.ERROR,
        warn: LogLevel.WARN,
        info: LogLevel.INFO,
        debug: LogLevel.DEBUG,
        trace: LogLevel.TRACE
      };
      logger.log(levelMap[level] || LogLevel.INFO, message, meta);
    },
    
    child: (metadata) => {
      return logger.child(metadata.label || 'child', metadata);
    }
  };
  
  return winstonLogger;
}

// Performance logger (Winston-compatible)
export class PerformanceLogger {
  constructor(module) {
    this.module = module;
    this.logger = createLogger(module);
    this.timers = new Map();
  }
  
  start(operation) {
    this.timers.set(operation, process.hrtime.bigint());
  }
  
  end(operation, metadata = {}) {
    const startTime = this.timers.get(operation);
    if (!startTime) {
      this.logger.warn(`No start time found for operation: ${operation}`);
      return;
    }
    
    const duration = Number(process.hrtime.bigint() - startTime) / 1e6; // Convert to ms
    this.timers.delete(operation);
    
    this.logger.debug(`${operation} completed`, {
      duration: `${duration.toFixed(2)}ms`,
      ...metadata
    });
    
    return duration;
  }
}

// Utility functions
export function setLogLevel(level) {
  const levelMap = {
    error: LogLevel.ERROR,
    warn: LogLevel.WARN,
    info: LogLevel.INFO,
    debug: LogLevel.DEBUG,
    trace: LogLevel.TRACE
  };
  
  const mappedLevel = levelMap[level];
  if (mappedLevel !== undefined) {
    logManager.setDefaultLevel(mappedLevel);
  }
}

export function getLogLevel() {
  const currentLevel = logManager.defaultLevel;
  for (const [name, value] of Object.entries(LogLevel)) {
    if (value === currentLevel) return name.toLowerCase();
  }
  return 'info';
}

// Export default logger for direct use
export const logger = createLogger('App');

export default {
  LogLevel,
  LogFormatter,
  JSONFormatter,
  HumanFormatter,
  LogHandler,
  ConsoleHandler,
  FileHandler,
  BufferHandler,
  StreamHandler,
  StructuredLogger,
  LogManager,
  logManager,
  createStructuredLogger
};
