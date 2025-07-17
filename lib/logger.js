/**
 * Structured Logging System for Otedama
 * Implements comprehensive logging with multiple transports
 */

import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { hostname } from 'os';
import { inspect } from 'util';
import { EventEmitter } from 'events';

/**
 * Log levels
 */
export const LogLevel = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  HTTP: 3,
  VERBOSE: 4,
  DEBUG: 5,
  SILLY: 6
};

const LogLevelNames = {
  0: 'ERROR',
  1: 'WARN',
  2: 'INFO',
  3: 'HTTP',
  4: 'VERBOSE',
  5: 'DEBUG',
  6: 'SILLY'
};

/**
 * Log formatter interface
 */
class LogFormatter {
  format(logEntry) {
    throw new Error('format method must be implemented');
  }
}

/**
 * JSON formatter
 */
export class JSONFormatter extends LogFormatter {
  format(logEntry) {
    return JSON.stringify(logEntry) + '\n';
  }
}

/**
 * Pretty formatter for console output
 */
export class PrettyFormatter extends LogFormatter {
  constructor(options = {}) {
    super();
    this.colors = options.colors !== false;
    this.timestamp = options.timestamp !== false;
  }
  
  format(logEntry) {
    const { timestamp, level, message, ...meta } = logEntry;
    
    let output = '';
    
    // Timestamp
    if (this.timestamp) {
      const time = new Date(timestamp).toISOString();
      output += this.colors ? `\x1b[90m${time}\x1b[0m ` : `${time} `;
    }
    
    // Level
    const levelName = LogLevelNames[level];
    const levelColor = this.getLevelColor(level);
    output += this.colors ? `${levelColor}${levelName}\x1b[0m ` : `${levelName} `;
    
    // Message
    output += message;
    
    // Metadata
    if (Object.keys(meta).length > 0) {
      const metaStr = inspect(meta, { colors: this.colors, depth: 3 });
      output += ` ${metaStr}`;
    }
    
    return output + '\n';
  }
  
  getLevelColor(level) {
    const colors = {
      0: '\x1b[31m', // ERROR - red
      1: '\x1b[33m', // WARN - yellow
      2: '\x1b[32m', // INFO - green
      3: '\x1b[36m', // HTTP - cyan
      4: '\x1b[34m', // VERBOSE - blue
      5: '\x1b[35m', // DEBUG - magenta
      6: '\x1b[90m'  // SILLY - gray
    };
    return colors[level] || '\x1b[0m';
  }
}

/**
 * Log transport interface
 */
class LogTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    this.level = options.level !== undefined ? options.level : LogLevel.INFO;
    this.formatter = options.formatter || new JSONFormatter();
  }
  
  log(logEntry) {
    if (logEntry.level <= this.level) {
      this.write(logEntry);
    }
  }
  
  write(logEntry) {
    throw new Error('write method must be implemented');
  }
}

/**
 * Console transport
 */
export class ConsoleTransport extends LogTransport {
  constructor(options = {}) {
    super(options);
    this.formatter = options.formatter || new PrettyFormatter({ colors: true });
  }
  
  write(logEntry) {
    const formatted = this.formatter.format(logEntry);
    
    if (logEntry.level === LogLevel.ERROR) {
      process.stderr.write(formatted);
    } else {
      process.stdout.write(formatted);
    }
  }
}

/**
 * File transport
 */
export class FileTransport extends LogTransport {
  constructor(options = {}) {
    super(options);
    this.filename = options.filename || 'app.log';
    this.maxSize = options.maxSize || 10 * 1024 * 1024; // 10MB
    this.maxFiles = options.maxFiles || 5;
    this.stream = null;
    this.currentSize = 0;
    
    this.ensureDirectory();
    this.openStream();
  }
  
  ensureDirectory() {
    const dir = dirname(this.filename);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  
  openStream() {
    this.stream = createWriteStream(this.filename, { flags: 'a' });
    this.stream.on('error', (error) => {
      this.emit('error', error);
    });
  }
  
  write(logEntry) {
    const formatted = this.formatter.format(logEntry);
    const size = Buffer.byteLength(formatted);
    
    // Check if rotation needed
    if (this.currentSize + size > this.maxSize) {
      this.rotate();
    }
    
    this.stream.write(formatted);
    this.currentSize += size;
  }
  
  rotate() {
    this.stream.end();
    
    // Rename existing files
    for (let i = this.maxFiles - 1; i > 0; i--) {
      const oldFile = i === 1 ? this.filename : `${this.filename}.${i - 1}`;
      const newFile = `${this.filename}.${i}`;
      
      try {
        if (existsSync(oldFile)) {
          const { renameSync, unlinkSync } = require('fs');
          if (existsSync(newFile)) {
            unlinkSync(newFile);
          }
          renameSync(oldFile, newFile);
        }
      } catch (error) {
        this.emit('error', error);
      }
    }
    
    // Open new stream
    this.currentSize = 0;
    this.openStream();
  }
  
  close() {
    if (this.stream) {
      this.stream.end();
    }
  }
}

/**
 * HTTP transport for remote logging
 */
export class HTTPTransport extends LogTransport {
  constructor(options = {}) {
    super(options);
    this.url = options.url;
    this.method = options.method || 'POST';
    this.headers = options.headers || { 'Content-Type': 'application/json' };
    this.timeout = options.timeout || 5000;
    this.batch = [];
    this.batchSize = options.batchSize || 100;
    this.flushInterval = options.flushInterval || 5000;
    
    if (!this.url) {
      throw new Error('URL is required for HTTPTransport');
    }
    
    // Start flush interval
    this.intervalId = setInterval(() => this.flush(), this.flushInterval);
  }
  
  write(logEntry) {
    this.batch.push(logEntry);
    
    if (this.batch.length >= this.batchSize) {
      this.flush();
    }
  }
  
  async flush() {
    if (this.batch.length === 0) return;
    
    const logs = [...this.batch];
    this.batch = [];
    
    try {
      const response = await fetch(this.url, {
        method: this.method,
        headers: this.headers,
        body: JSON.stringify({ logs }),
        signal: AbortSignal.timeout(this.timeout)
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      this.emit('error', error);
      // Re-add logs to batch for retry
      this.batch.unshift(...logs);
    }
  }
  
  close() {
    clearInterval(this.intervalId);
    this.flush();
  }
}

/**
 * Main Logger class
 */
export class Logger extends EventEmitter {
  constructor(options = {}) {
    super();
    this.level = options.level !== undefined ? options.level : LogLevel.INFO;
    this.defaultMeta = options.defaultMeta || {};
    this.transports = [];
    this.exitOnError = options.exitOnError !== false;
    
    // Add default console transport if none provided
    if (!options.transports || options.transports.length === 0) {
      this.add(new ConsoleTransport());
    } else {
      options.transports.forEach(transport => this.add(transport));
    }
    
    // Handle uncaught exceptions
    if (options.handleExceptions) {
      process.on('uncaughtException', (error) => {
        this.error('Uncaught Exception', { error: error.stack });
        if (this.exitOnError) {
          process.exit(1);
        }
      });
    }
    
    // Handle unhandled rejections
    if (options.handleRejections) {
      process.on('unhandledRejection', (reason, promise) => {
        this.error('Unhandled Rejection', { reason, promise });
        if (this.exitOnError) {
          process.exit(1);
        }
      });
    }
  }
  
  add(transport) {
    this.transports.push(transport);
    transport.on('error', (error) => {
      this.emit('error', error);
    });
    return this;
  }
  
  remove(transport) {
    const index = this.transports.indexOf(transport);
    if (index > -1) {
      this.transports.splice(index, 1);
    }
    return this;
  }
  
  log(level, message, meta = {}) {
    if (level > this.level) return;
    
    const logEntry = {
      timestamp: Date.now(),
      level,
      message,
      hostname: hostname(),
      pid: process.pid,
      ...this.defaultMeta,
      ...meta
    };
    
    // Add error stack if present
    if (meta.error instanceof Error) {
      logEntry.error = {
        message: meta.error.message,
        stack: meta.error.stack,
        name: meta.error.name
      };
    }
    
    // Send to all transports
    this.transports.forEach(transport => {
      try {
        transport.log(logEntry);
      } catch (error) {
        this.emit('error', error);
      }
    });
    
    this.emit('logged', logEntry);
  }
  
  // Convenience methods
  error(message, meta) {
    this.log(LogLevel.ERROR, message, meta);
  }
  
  warn(message, meta) {
    this.log(LogLevel.WARN, message, meta);
  }
  
  info(message, meta) {
    this.log(LogLevel.INFO, message, meta);
  }
  
  http(message, meta) {
    this.log(LogLevel.HTTP, message, meta);
  }
  
  verbose(message, meta) {
    this.log(LogLevel.VERBOSE, message, meta);
  }
  
  debug(message, meta) {
    this.log(LogLevel.DEBUG, message, meta);
  }
  
  silly(message, meta) {
    this.log(LogLevel.SILLY, message, meta);
  }
  
  // Create child logger with additional metadata
  child(defaultMeta) {
    return new Logger({
      level: this.level,
      defaultMeta: { ...this.defaultMeta, ...defaultMeta },
      transports: this.transports
    });
  }
  
  // Performance logging
  startTimer() {
    const start = process.hrtime.bigint();
    
    return {
      done: (message, meta = {}) => {
        const end = process.hrtime.bigint();
        const duration = Number(end - start) / 1e6; // Convert to milliseconds
        
        this.info(message, {
          ...meta,
          duration,
          durationPretty: `${duration.toFixed(2)}ms`
        });
      }
    };
  }
  
  // Profile method execution
  profile(id) {
    const start = Date.now();
    
    if (!this.profiles) {
      this.profiles = {};
    }
    
    if (this.profiles[id]) {
      const duration = Date.now() - this.profiles[id];
      delete this.profiles[id];
      
      this.info(`Profile '${id}' completed`, {
        profile: id,
        duration,
        durationPretty: `${duration}ms`
      });
    } else {
      this.profiles[id] = start;
    }
  }
  
  // Query logging
  query(sql, params, duration) {
    this.log(LogLevel.DEBUG, 'Database query', {
      sql,
      params,
      duration,
      type: 'query'
    });
  }
  
  // Request logging
  request(req, res, duration) {
    const meta = {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration,
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent'],
      type: 'request'
    };
    
    const level = res.statusCode >= 500 ? LogLevel.ERROR
      : res.statusCode >= 400 ? LogLevel.WARN
      : LogLevel.HTTP;
    
    this.log(level, `${req.method} ${req.url} ${res.statusCode}`, meta);
  }
  
  // Close all transports
  close() {
    this.transports.forEach(transport => {
      if (transport.close) {
        transport.close();
      }
    });
  }
}

/**
 * Create default logger instance
 */
export const createLogger = (options = {}) => {
  const env = process.env.NODE_ENV || 'development';
  const logDir = options.logDir || './logs';
  
  const transports = [];
  
  // Console transport
  transports.push(new ConsoleTransport({
    level: options.consoleLevel || (env === 'production' ? LogLevel.INFO : LogLevel.DEBUG),
    formatter: new PrettyFormatter({
      colors: env !== 'production',
      timestamp: true
    })
  }));
  
  // File transports
  if (options.file !== false) {
    // Error log
    transports.push(new FileTransport({
      level: LogLevel.ERROR,
      filename: join(logDir, 'error.log'),
      formatter: new JSONFormatter()
    }));
    
    // Combined log
    transports.push(new FileTransport({
      level: LogLevel.INFO,
      filename: join(logDir, 'combined.log'),
      formatter: new JSONFormatter()
    }));
    
    // Debug log (development only)
    if (env !== 'production') {
      transports.push(new FileTransport({
        level: LogLevel.DEBUG,
        filename: join(logDir, 'debug.log'),
        formatter: new JSONFormatter()
      }));
    }
  }
  
  // HTTP transport for remote logging
  if (options.httpUrl) {
    transports.push(new HTTPTransport({
      url: options.httpUrl,
      level: LogLevel.WARN
    }));
  }
  
  return new Logger({
    level: options.level || (env === 'production' ? LogLevel.INFO : LogLevel.DEBUG),
    defaultMeta: {
      service: 'otedama',
      version: '0.6.1-enhanced',
      env,
      ...options.defaultMeta
    },
    transports,
    handleExceptions: true,
    handleRejections: true,
    exitOnError: env === 'production'
  });
};

// Export default logger
export default createLogger();