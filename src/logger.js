/**
 * Otedama v6.0.0 - Commercial Grade Component
 * Optimized for production deployment
 * Part of the automated mining pool & DeFi ecosystem
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * High-performance production logger
 * Designed for commercial-grade applications with minimal overhead
 */
export class Logger {
  constructor(component = 'App') {
    this.component = component;
    this.logDir = 'logs';
    this.maxFileSize = 10 * 1024 * 1024; // 10MB
    this.maxFiles = 10;
    this.logLevel = process.env.LOG_LEVEL || 'info';
    
    // Log levels (lower number = higher priority)
    this.levels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
      trace: 4
    };
    
    // Create logs directory
    this.ensureLogDirectory();
    
    // Initialize log files
    this.errorLogPath = path.join(this.logDir, 'error.log');
    this.mainLogPath = path.join(this.logDir, 'otedama.log');
    this.feeLogPath = path.join(this.logDir, 'fees.log');
    this.securityLogPath = path.join(this.logDir, 'security.log');
    
    // Performance optimization: pre-allocate buffers
    this.logBuffer = [];
    this.bufferSize = 100;
    this.flushInterval = 5000; // 5 seconds
    
    // Start periodic flush
    this.startPeriodicFlush();
  }

  /**
   * Create logs directory if it doesn't exist
   */
  ensureLogDirectory() {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (error) {
      console.error('Failed to create log directory:', error);
    }
  }

  /**
   * Check if log level should be processed
   */
  shouldLog(level) {
    return this.levels[level] <= this.levels[this.logLevel];
  }

  /**
   * Format log message
   */
  formatMessage(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const pid = process.pid;
    const memory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    
    let formattedMessage = `[${timestamp}] [${pid}] [${memory}MB] [${level.toUpperCase()}] [${this.component}] ${message}`;
    
    if (data) {
      if (typeof data === 'object') {
        formattedMessage += ` ${JSON.stringify(data)}`;
      } else {
        formattedMessage += ` ${data}`;
      }
    }
    
    return formattedMessage;
  }

  /**
   * Write log message to file with rotation
   */
  writeToFile(filePath, message) {
    try {
      // Check file size and rotate if necessary
      this.rotateLogIfNeeded(filePath);
      
      // Append to file
      fs.appendFileSync(filePath, message + '\n');
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  /**
   * Rotate log file if it exceeds max size
   */
  rotateLogIfNeeded(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        return;
      }
      
      const stats = fs.statSync(filePath);
      if (stats.size < this.maxFileSize) {
        return;
      }
      
      // Rotate existing files
      const dir = path.dirname(filePath);
      const basename = path.basename(filePath, path.extname(filePath));
      const ext = path.extname(filePath);
      
      // Move old files
      for (let i = this.maxFiles - 1; i > 0; i--) {
        const oldFile = path.join(dir, `${basename}.${i}${ext}`);
        const newFile = path.join(dir, `${basename}.${i + 1}${ext}`);
        
        if (fs.existsSync(oldFile)) {
          if (i === this.maxFiles - 1) {
            fs.unlinkSync(oldFile); // Delete oldest
          } else {
            fs.renameSync(oldFile, newFile);
          }
        }
      }
      
      // Move current file to .1
      const rotatedFile = path.join(dir, `${basename}.1${ext}`);
      fs.renameSync(filePath, rotatedFile);
    } catch (error) {
      console.error('Failed to rotate log file:', error);
    }
  }

  /**
   * Add message to buffer for batch writing
   */
  addToBuffer(level, message, data = null) {
    const formattedMessage = this.formatMessage(level, message, data);
    
    this.logBuffer.push({
      level,
      message: formattedMessage,
      timestamp: Date.now()
    });
    
    // Flush if buffer is full
    if (this.logBuffer.length >= this.bufferSize) {
      this.flushBuffer();
    }
  }

  /**
   * Flush buffer to files
   */
  flushBuffer() {
    if (this.logBuffer.length === 0) return;
    
    try {
      for (const log of this.logBuffer) {
        // Write to main log
        this.writeToFile(this.mainLogPath, log.message);
        
        // Write errors to separate file
        if (log.level === 'error') {
          this.writeToFile(this.errorLogPath, log.message);
        }
        
        // Write fee-related logs to separate file
        if (log.message.includes('fee') || log.message.includes('operator') || log.message.includes('collection')) {
          this.writeToFile(this.feeLogPath, log.message);
        }
        
        // Write security logs to separate file
        if (log.message.includes('security') || log.message.includes('auth') || log.message.includes('tamper')) {
          this.writeToFile(this.securityLogPath, log.message);
        }
      }
      
      this.logBuffer = [];
    } catch (error) {
      console.error('Failed to flush log buffer:', error);
    }
  }

  /**
   * Start periodic buffer flush
   */
  startPeriodicFlush() {
    setInterval(() => {
      this.flushBuffer();
    }, this.flushInterval);
  }

  /**
   * Log error message
   */
  error(message, data = null) {
    if (!this.shouldLog('error')) return;
    
    // Always output errors to console immediately
    console.error(`[ERROR] [${this.component}] ${message}`, data || '');
    
    this.addToBuffer('error', message, data);
  }

  /**
   * Log warning message
   */
  warn(message, data = null) {
    if (!this.shouldLog('warn')) return;
    
    console.warn(`[WARN] [${this.component}] ${message}`, data || '');
    this.addToBuffer('warn', message, data);
  }

  /**
   * Log info message
   */
  info(message, data = null) {
    if (!this.shouldLog('info')) return;
    
    console.log(`[INFO] [${this.component}] ${message}`, data || '');
    this.addToBuffer('info', message, data);
  }

  /**
   * Log debug message
   */
  debug(message, data = null) {
    if (!this.shouldLog('debug')) return;
    
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[DEBUG] [${this.component}] ${message}`, data || '');
    }
    
    this.addToBuffer('debug', message, data);
  }

  /**
   * Log trace message
   */
  trace(message, data = null) {
    if (!this.shouldLog('trace')) return;
    
    this.addToBuffer('trace', message, data);
  }

  /**
   * Log fee collection event (special category)
   */
  logFeeCollection(currency, amount, btcAmount, status = 'success') {
    const feeMessage = `Fee collection: ${amount} ${currency} → ${btcAmount} BTC (${status})`;
    this.info(feeMessage, {
      type: 'fee_collection',
      currency,
      amount,
      btcAmount,
      status,
      operatorAddress: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
    });
  }

  /**
   * Log security event (special category)
   */
  logSecurity(event, details = null) {
    const securityMessage = `Security event: ${event}`;
    this.warn(securityMessage, {
      type: 'security',
      event,
      details,
      timestamp: Date.now(),
      component: this.component
    });
  }

  /**
   * Log performance metrics
   */
  logPerformance(metric, value, unit = '') {
    if (!this.shouldLog('debug')) return;
    
    const perfMessage = `Performance: ${metric} = ${value}${unit}`;
    this.debug(perfMessage, {
      type: 'performance',
      metric,
      value,
      unit,
      timestamp: Date.now()
    });
  }

  /**
   * Log business event (mining, trading, etc.)
   */
  logBusiness(event, data = null) {
    const businessMessage = `Business event: ${event}`;
    this.info(businessMessage, {
      type: 'business',
      event,
      data,
      timestamp: Date.now()
    });
  }

  /**
   * Get log statistics
   */
  getStats() {
    try {
      const stats = {
        component: this.component,
        logLevel: this.logLevel,
        bufferSize: this.logBuffer.length,
        files: {}
      };
      
      // Check file sizes
      const logFiles = [
        this.mainLogPath,
        this.errorLogPath,
        this.feeLogPath,
        this.securityLogPath
      ];
      
      for (const file of logFiles) {
        if (fs.existsSync(file)) {
          const fileStats = fs.statSync(file);
          const filename = path.basename(file);
          stats.files[filename] = {
            size: fileStats.size,
            modified: fileStats.mtime,
            sizeMB: Math.round(fileStats.size / 1024 / 1024 * 100) / 100
          };
        }
      }
      
      return stats;
    } catch (error) {
      this.error('Failed to get log stats:', error);
      return null;
    }
  }

  /**
   * Clean up old log files
   */
  cleanup() {
    try {
      const cutoffTime = Date.now() - (30 * 24 * 60 * 60 * 1000); // 30 days
      
      const files = fs.readdirSync(this.logDir);
      let cleanedCount = 0;
      
      for (const file of files) {
        const filePath = path.join(this.logDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime.getTime() < cutoffTime) {
          fs.unlinkSync(filePath);
          cleanedCount++;
        }
      }
      
      if (cleanedCount > 0) {
        this.info(`Cleaned up ${cleanedCount} old log files`);
      }
    } catch (error) {
      this.error('Failed to cleanup log files:', error);
    }
  }

  /**
   * Emergency flush and stop
   */
  stop() {
    this.flushBuffer();
    this.info(`Logger stopped for component: ${this.component}`);
  }

  /**
   * Create child logger with specific component name
   */
  child(componentName) {
    return new Logger(`${this.component}:${componentName}`);
  }

  /**
   * Create logger with request ID for tracing
   */
  withRequestId(requestId) {
    const childLogger = this.child(`Req:${requestId.substring(0, 8)}`);
    return childLogger;
  }
}
