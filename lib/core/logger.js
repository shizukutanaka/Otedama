/**
 * Production-Ready Logging System for Otedama
 * 
 * Design principles:
 * - Carmack: Minimal performance impact, async where possible
 * - Martin: Clean interfaces, structured logging
 * - Pike: Simple but comprehensive
 */

import { EventEmitter } from 'events';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'fs';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { hostname } from 'os';
import { gzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);

// Log levels
export const LogLevel = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
  TRACE: 4
};

// Log level names
const LOG_LEVEL_NAMES = {
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.TRACE]: 'TRACE'
};

// ANSI color codes for console output
const COLORS = {
  ERROR: '\x1b[31m', // Red
  WARN: '\x1b[33m',  // Yellow
  INFO: '\x1b[36m',  // Cyan
  DEBUG: '\x1b[90m', // Gray
  TRACE: '\x1b[35m', // Magenta
  RESET: '\x1b[0m'
};

/**
 * Circular buffer for in-memory log storage
 */
class CircularBuffer {
  constructor(size) {
    this.size = size;
    this.buffer = new Array(size);
    this.head = 0;
    this.length = 0;
  }

  push(item) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.size;
    if (this.length < this.size) {
      this.length++;
    }
  }

  toArray() {
    if (this.length < this.size) {
      return this.buffer.slice(0, this.length);
    }
    
    return [
      ...this.buffer.slice(this.head),
      ...this.buffer.slice(0, this.head)
    ];
  }

  clear() {
    this.buffer = new Array(this.size);
    this.head = 0;
    this.length = 0;
  }
}

/**
 * Log formatter for structured logging
 */
class LogFormatter {
  constructor(options = {}) {
    this.includeTimestamp = options.includeTimestamp !== false;
    this.includeLevel = options.includeLevel !== false;
    this.includeHostname = options.includeHostname || false;
    this.includePid = options.includePid || false;
    this.includeContext = options.includeContext !== false;
    this.dateFormat = options.dateFormat || 'ISO'; // ISO or UNIX
  }

  format(level, message, context = {}) {
    const log = {};
    
    // Timestamp
    if (this.includeTimestamp) {
      log.timestamp = this.dateFormat === 'UNIX' ? 
        Date.now() : new Date().toISOString();
    }
    
    // Level
    if (this.includeLevel) {
      log.level = LOG_LEVEL_NAMES[level];
    }
    
    // Message
    log.message = message;
    
    // Context
    if (this.includeContext && Object.keys(context).length > 0) {
      // Extract error if present
      if (context.error instanceof Error) {
        log.error = {
          message: context.error.message,
          stack: context.error.stack,
          code: context.error.code
        };
        
        // Don't duplicate error in context
        const { error, ...restContext } = context;
        if (Object.keys(restContext).length > 0) {
          log.context = restContext;
        }
      } else {
        log.context = context;
      }
    }
    
    // System info
    if (this.includeHostname) {
      log.hostname = hostname();
    }
    
    if (this.includePid) {
      log.pid = process.pid;
    }
    
    return log;
  }

  formatConsole(level, message, context = {}) {
    const levelName = LOG_LEVEL_NAMES[level];
    const color = COLORS[levelName] || '';
    const timestamp = new Date().toISOString();
    
    let output = `${color}[${timestamp}] [${levelName}]${COLORS.RESET} ${message}`;
    
    // Add context if present
    if (Object.keys(context).length > 0) {
      if (context.error instanceof Error) {
        output += `\n${context.error.stack}`;
      } else {
        const contextStr = JSON.stringify(context, null, 2);
        if (contextStr !== '{}') {
          output += `\n${contextStr}`;
        }
      }
    }
    
    return output;
  }
}

/**
 * File transport for logging to files
 */
class FileTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.filename = options.filename || 'otedama.log';
    this.dirname = options.dirname || './logs';
    this.maxSize = options.maxSize || 100 * 1024 * 1024; // 100MB
    this.maxFiles = options.maxFiles || 10;
    this.compress = options.compress || false;
    this.bufferSize = options.bufferSize || 4096;
    
    this.stream = null;
    this.size = 0;
    this.buffer = [];
    this.draining = false;
    
    this.ensureDirectory();
    this.openStream();
  }

  ensureDirectory() {
    if (!existsSync(this.dirname)) {
      mkdirSync(this.dirname, { recursive: true });
    }
  }

  openStream() {
    const filepath = join(this.dirname, this.filename);
    
    // Get current file size
    try {
      const stats = statSync(filepath);
      this.size = stats.size;
    } catch (error) {
      this.size = 0;
    }
    
    this.stream = createWriteStream(filepath, {
      flags: 'a',
      encoding: 'utf8',
      highWaterMark: this.bufferSize
    });
    
    this.stream.on('error', (error) => {
      this.emit('error', error);
    });
    
    this.stream.on('drain', () => {
      this.draining = false;
      this.flush();
    });
  }

  async write(log) {
    const line = JSON.stringify(log) + '\n';
    const size = Buffer.byteLength(line);
    
    // Check if rotation needed
    if (this.size + size > this.maxSize) {
      await this.rotate();
    }
    
    // Buffer the write
    this.buffer.push(line);
    this.size += size;
    
    // Flush if not draining
    if (!this.draining) {
      this.flush();
    }
  }

  flush() {
    if (this.buffer.length === 0 || !this.stream || this.draining) {
      return;
    }
    
    const chunk = this.buffer.join('');
    this.buffer = [];
    
    const written = this.stream.write(chunk);
    if (!written) {
      this.draining = true;
    }
  }

  async rotate() {
    // Close current stream
    if (this.stream) {
      this.flush();
      await new Promise(resolve => this.stream.end(resolve));
    }
    
    const filepath = join(this.dirname, this.filename);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotatedName = `${this.filename}.${timestamp}`;
    const rotatedPath = join(this.dirname, rotatedName);
    
    try {
      // Rename current file
      await fs.rename(filepath, rotatedPath);
      
      // Compress if enabled
      if (this.compress) {
        await this.compressFile(rotatedPath);
      }
      
      // Clean old files
      await this.cleanOldFiles();
      
    } catch (error) {
      this.emit('error', error);
    }
    
    // Open new stream
    this.size = 0;
    this.openStream();
  }

  async compressFile(filepath) {
    try {
      const content = await fs.readFile(filepath);
      const compressed = await gzipAsync(content);
      await fs.writeFile(`${filepath}.gz`, compressed);
      await fs.unlink(filepath);
    } catch (error) {
      this.emit('error', error);
    }
  }

  async cleanOldFiles() {
    try {
      const files = await fs.readdir(this.dirname);
      const logFiles = files
        .filter(f => f.startsWith(this.filename) && f !== this.filename)
        .map(f => ({
          name: f,
          path: join(this.dirname, f),
          time: statSync(join(this.dirname, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);
      
      // Remove old files
      const toRemove = logFiles.slice(this.maxFiles);
      for (const file of toRemove) {
        await fs.unlink(file.path);
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  async close() {
    this.flush();
    if (this.stream) {
      await new Promise(resolve => this.stream.end(resolve));
    }
  }
}

/**
 * Production Logger with multiple transports
 */
export class ProductionLogger extends EventEmitter {
  constructor(name, options = {}) {
    super();
    
    this.name = name;
    this.level = this.parseLevel(options.level || 'info');
    
    // Formatter
    this.formatter = new LogFormatter({
      includeTimestamp: true,
      includeLevel: true,
      includeHostname: options.includeHostname || false,
      includePid: options.includePid || false,
      dateFormat: options.dateFormat || 'ISO'
    });
    
    // Transports
    this.transports = new Map();
    
    // Console transport
    if (options.console !== false) {
      this.transports.set('console', {
        type: 'console',
        level: this.parseLevel(options.consoleLevel || options.level || 'info')
      });
    }
    
    // File transport
    if (options.file) {
      const fileTransport = new FileTransport({
        filename: options.file.filename || `${name}.log`,
        dirname: options.file.dirname || './logs',
        maxSize: options.file.maxSize,
        maxFiles: options.file.maxFiles,
        compress: options.file.compress
      });
      
      fileTransport.on('error', (error) => {
        this.emit('error', error);
      });
      
      this.transports.set('file', {
        type: 'file',
        level: this.parseLevel(options.file.level || options.level || 'info'),
        transport: fileTransport
      });
    }
    
    // In-memory buffer for debugging
    this.memoryBuffer = new CircularBuffer(options.bufferSize || 1000);
    
    // Error tracking
    this.errorCounts = new Map();
    this.errorRateWindow = options.errorRateWindow || 60000; // 1 minute
    
    // Performance tracking
    this.logCounts = {
      [LogLevel.ERROR]: 0,
      [LogLevel.WARN]: 0,
      [LogLevel.INFO]: 0,
      [LogLevel.DEBUG]: 0,
      [LogLevel.TRACE]: 0
    };
    
    // Child loggers
    this.children = new Map();
  }

  parseLevel(level) {
    if (typeof level === 'number') {
      return level;
    }
    
    const upperLevel = level.toUpperCase();
    return LogLevel[upperLevel] ?? LogLevel.INFO;
  }

  shouldLog(level) {
    return level <= this.level;
  }

  log(level, message, context = {}) {
    if (!this.shouldLog(level)) {
      return;
    }
    
    // Format log
    const log = this.formatter.format(level, message, {
      ...context,
      logger: this.name
    });
    
    // Add to memory buffer
    this.memoryBuffer.push(log);
    
    // Update counters
    this.logCounts[level]++;
    
    // Track errors
    if (level === LogLevel.ERROR) {
      this.trackError(message, context);
    }
    
    // Send to transports
    for (const [name, transport] of this.transports) {
      if (level <= transport.level) {
        this.writeToTransport(transport, level, message, context);
      }
    }
    
    // Emit log event
    this.emit('log', log);
  }

  writeToTransport(transport, level, message, context) {
    try {
      switch (transport.type) {
        case 'console':
          const formatted = this.formatter.formatConsole(level, message, context);
          if (level <= LogLevel.ERROR) {
            console.error(formatted);
          } else if (level === LogLevel.WARN) {
            console.warn(formatted);
          } else {
            console.log(formatted);
          }
          break;
          
        case 'file':
          const log = this.formatter.format(level, message, {
            ...context,
            logger: this.name
          });
          transport.transport.write(log).catch(error => {
            this.emit('error', error);
          });
          break;
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  trackError(message, context) {
    const now = Date.now();
    const key = `${message}:${context.error?.code || 'unknown'}`;
    
    // Get or create error entry
    let entry = this.errorCounts.get(key);
    if (!entry) {
      entry = { count: 0, times: [] };
      this.errorCounts.set(key, entry);
    }
    
    // Add timestamp
    entry.times.push(now);
    entry.count++;
    
    // Clean old timestamps
    const cutoff = now - this.errorRateWindow;
    entry.times = entry.times.filter(t => t > cutoff);
    
    // Check for high error rate
    if (entry.times.length > 10) {
      this.emit('high-error-rate', {
        message,
        count: entry.times.length,
        window: this.errorRateWindow
      });
    }
  }

  // Convenience methods
  error(message, context) {
    this.log(LogLevel.ERROR, message, context);
  }

  warn(message, context) {
    this.log(LogLevel.WARN, message, context);
  }

  info(message, context) {
    this.log(LogLevel.INFO, message, context);
  }

  debug(message, context) {
    this.log(LogLevel.DEBUG, message, context);
  }

  trace(message, context) {
    this.log(LogLevel.TRACE, message, context);
  }

  // Child logger
  child(name, context = {}) {
    const childName = `${this.name}.${name}`;
    
    if (this.children.has(childName)) {
      return this.children.get(childName);
    }
    
    const child = new ProductionLogger(childName, {
      level: this.level,
      console: false, // Inherit from parent
      file: false // Inherit from parent
    });
    
    // Override log method to use parent's transports
    child.log = (level, message, childContext = {}) => {
      this.log(level, message, {
        ...context,
        ...childContext,
        logger: childName
      });
    };
    
    this.children.set(childName, child);
    return child;
  }

  // Get buffered logs
  getBuffer(filter = {}) {
    let logs = this.memoryBuffer.toArray();
    
    if (filter.level !== undefined) {
      const minLevel = this.parseLevel(filter.level);
      logs = logs.filter(log => {
        const logLevel = Object.entries(LOG_LEVEL_NAMES)
          .find(([_, name]) => name === log.level)?.[0];
        return logLevel && parseInt(logLevel) <= minLevel;
      });
    }
    
    if (filter.since) {
      logs = logs.filter(log => {
        const timestamp = log.timestamp;
        if (typeof timestamp === 'number') {
          return timestamp > filter.since;
        }
        return new Date(timestamp).getTime() > filter.since;
      });
    }
    
    if (filter.search) {
      const searchLower = filter.search.toLowerCase();
      logs = logs.filter(log => 
        log.message.toLowerCase().includes(searchLower) ||
        JSON.stringify(log.context).toLowerCase().includes(searchLower)
      );
    }
    
    return logs;
  }

  // Get statistics
  getStats() {
    const totalLogs = Object.values(this.logCounts).reduce((sum, count) => sum + count, 0);
    
    return {
      name: this.name,
      level: LOG_LEVEL_NAMES[this.level],
      counts: {
        error: this.logCounts[LogLevel.ERROR],
        warn: this.logCounts[LogLevel.WARN],
        info: this.logCounts[LogLevel.INFO],
        debug: this.logCounts[LogLevel.DEBUG],
        trace: this.logCounts[LogLevel.TRACE],
        total: totalLogs
      },
      errorRate: this.getErrorRate(),
      bufferSize: this.memoryBuffer.length,
      children: this.children.size
    };
  }

  getErrorRate() {
    const now = Date.now();
    const cutoff = now - this.errorRateWindow;
    let count = 0;
    
    for (const entry of this.errorCounts.values()) {
      count += entry.times.filter(t => t > cutoff).length;
    }
    
    return count;
  }

  // Clear buffer
  clearBuffer() {
    this.memoryBuffer.clear();
  }

  // Shutdown
  async shutdown() {
    // Close file transports
    for (const [name, transport] of this.transports) {
      if (transport.type === 'file' && transport.transport) {
        await transport.transport.close();
      }
    }
    
    // Clear references
    this.transports.clear();
    this.children.clear();
    this.errorCounts.clear();
    
    this.emit('shutdown');
  }
}

/**
 * Logger factory
 */
export class LoggerFactory {
  constructor(options = {}) {
    this.defaultOptions = options;
    this.loggers = new Map();
  }

  getLogger(name, options = {}) {
    if (this.loggers.has(name)) {
      return this.loggers.get(name);
    }
    
    const logger = new ProductionLogger(name, {
      ...this.defaultOptions,
      ...options
    });
    
    this.loggers.set(name, logger);
    return logger;
  }

  async shutdown() {
    const promises = [];
    
    for (const logger of this.loggers.values()) {
      promises.push(logger.shutdown());
    }
    
    await Promise.all(promises);
    this.loggers.clear();
  }
}

// Global logger factory
export const loggerFactory = new LoggerFactory({
  level: process.env.LOG_LEVEL || 'info',
  file: process.env.LOG_FILE ? {
    filename: 'otedama.log',
    dirname: process.env.LOG_DIR || './logs',
    maxSize: 100 * 1024 * 1024, // 100MB
    maxFiles: 10,
    compress: true
  } : undefined
});

// Convenience function
export function getLogger(name, options) {
  return loggerFactory.getLogger(name, options);
}

// Default export
export default ProductionLogger;
