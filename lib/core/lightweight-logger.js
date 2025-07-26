/**
 * Lightweight Logger - Otedama
 * Basic logging functionality for performance-critical components
 */

export const LogLevel = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

export function createLightweightLogger(label = 'Otedama') {
  return new LightweightLogger(label);
}

export class LightweightLogger {
  constructor(label = 'Otedama') {
    this.label = label;
    this.logLevel = process.env.LOG_LEVEL || 'info';
    this.levels = { error: 0, warn: 1, info: 2, debug: 3 };
  }

  shouldLog(level) {
    return this.levels[level] <= this.levels[this.logLevel];
  }

  error(message, meta = {}) {
    if (this.shouldLog('error')) {
      console.error(`[${this.label}] ERROR:`, message, meta);
    }
  }

  warn(message, meta = {}) {
    if (this.shouldLog('warn')) {
      console.warn(`[${this.label}] WARN:`, message, meta);
    }
  }

  info(message, meta = {}) {
    if (this.shouldLog('info')) {
      console.info(`[${this.label}] INFO:`, message, meta);
    }
  }

  debug(message, meta = {}) {
    if (this.shouldLog('debug')) {
      console.debug(`[${this.label}] DEBUG:`, message, meta);
    }
  }
}

export default LightweightLogger;