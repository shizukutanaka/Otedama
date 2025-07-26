/**
 * Structured Logger - Otedama
 * Wrapper for lightweight logger with backward compatibility
 * 
 * Design: Unified lightweight logging (Carmack/Pike principles)
 */

import { createLightweightLogger, LogLevel as LightweightLogLevel } from './lightweight-logger.js';

/**
 * Log levels for backward compatibility
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
 * Create structured logger that wraps lightweight logger
 */
export function createStructuredLogger(name) {
  const logger = createLightweightLogger(name);
  
  // Add backward compatible methods
  logger.trace = (...args) => logger.debug(...args);
  logger.fatal = (...args) => logger.error('[FATAL]', ...args);
  
  // Add structured logging support
  const originalInfo = logger.info.bind(logger);
  const originalWarn = logger.warn.bind(logger);
  const originalError = logger.error.bind(logger);
  const originalDebug = logger.debug.bind(logger);
  
  logger.info = (message, context) => {
    if (context && typeof context === 'object') {
      originalInfo(message, JSON.stringify(context));
    } else {
      originalInfo(message);
    }
  };
  
  logger.warn = (message, context) => {
    if (context && typeof context === 'object') {
      originalWarn(message, JSON.stringify(context));
    } else {
      originalWarn(message);
    }
  };
  
  logger.error = (message, error, context) => {
    if (error instanceof Error) {
      originalError(message, error.message);
      if (error.stack && logger.level >= LightweightLogLevel.DEBUG) {
        originalDebug(error.stack);
      }
    } else if (typeof error === 'object') {
      originalError(message, JSON.stringify(error));
    } else {
      originalError(message, error);
    }
    
    if (context && typeof context === 'object') {
      originalDebug('Context:', JSON.stringify(context));
    }
  };
  
  logger.debug = (message, context) => {
    if (context && typeof context === 'object') {
      originalDebug(message, JSON.stringify(context));
    } else {
      originalDebug(message);
    }
  };
  
  // Add child logger support for compatibility
  logger.child = (context) => {
    const childLogger = createStructuredLogger(`${name}:${context.component || 'child'}`);
    return childLogger;
  };
  
  return logger;
}

/**
 * Legacy formatter classes for compatibility
 */
export class LogFormatter {
  format(record) {
    return JSON.stringify(record);
  }
}

export class JSONFormatter extends LogFormatter {}
export class HumanFormatter extends LogFormatter {}

/**
 * Legacy logger class for compatibility
 */
export class StructuredLogger {
  constructor(name, options = {}) {
    this.logger = createStructuredLogger(name);
  }
  
  trace(...args) { this.logger.trace(...args); }
  debug(...args) { this.logger.debug(...args); }
  info(...args) { this.logger.info(...args); }
  warn(...args) { this.logger.warn(...args); }
  error(...args) { this.logger.error(...args); }
  fatal(...args) { this.logger.fatal(...args); }
  
  child(context) { return this.logger.child(context); }
}

// Backward compatibility alias
export const createLogger = createStructuredLogger;

// Default logger instance for direct import
export const logger = createStructuredLogger('Default');

// Additional compatibility exports
export const PerformanceLogger = createStructuredLogger;
export const setLogLevel = (level) => { /* compatibility stub */ };
export const getLogLevel = () => 'info';

// Handler classes for compatibility
export class FileHandler {}
export class ConsoleHandler {}
export class BufferHandler {}
export class StreamHandler {}

export default createStructuredLogger;