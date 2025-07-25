/**
 * Core Module - Otedama
 * Central utilities and base functionality
 * 
 * Design principles:
 * - Performance-first (Carmack)
 * - Clean interfaces (Martin)
 * - Simple and practical (Pike)
 */

// Logger - Unified structured logger with Winston compatibility
export { 
  createLogger, 
  createStructuredLogger,
  logger, 
  PerformanceLogger, 
  setLogLevel,
  getLogLevel,
  LogLevel,
  LogFormatter,
  JSONFormatter,
  HumanFormatter,
  FileHandler,
  ConsoleHandler,
  BufferHandler,
  StreamHandler
} from './structured-logger.js';

// Error handling - Unified error system
export {
  OtedamaError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NetworkError,
  DatabaseError,
  MiningError,
  PaymentError,
  ErrorCategory,
  ErrorSeverity,
  CircuitBreaker,
  ErrorHandler,
  getErrorHandler,
  withRetry,
  withTimeout,
  wrapAsync
} from './error-handler-unified.js';

// Performance utilities
export {
  BufferPool,
  WorkerPool,
  RingBuffer,
  PerformanceMonitor,
  LRUCache,
  fastHash,
  formatMemoryUsage,
  getCPUUsage,
  defaultBufferPool,
  performanceMonitor
} from './performance.js';

// Memory management
export { 
  memoryManager, 
  ObjectPool, 
  BufferPool as MemoryBufferPool,
  CircularBuffer,
  MemoryMonitor 
} from './memory-manager.js';

// Async utilities
export * from './async-utils.js';

// Configuration management
export { configManager, ConfigManager } from './config-manager.js';

// Validation
export { validator, Rules, Sanitizers, Schema } from './validator.js';

// Health check
export { healthCheckManager, HealthCheck } from './health-check.js';

// Profiler
export { profiler, Profiler } from './profiler.js';

// Rate limiting
export { rateLimiter, RateLimiter } from './rate-limiter.js';

// Authentication
export * from './auth.js';

// Migration
export { MigrationManager } from './migration.js';

// Backup
export { BackupManager } from './backup.js';

// Common utilities
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function retry(fn, options = {}) {
  const {
    attempts = 3,
    delay = 1000,
    backoff = 2,
    onError = null
  } = options;
  
  return async (...args) => {
    let lastError;
    
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn(...args);
      } catch (error) {
        lastError = error;
        
        if (onError) {
          onError(error, i + 1);
        }
        
        if (i < attempts - 1) {
          const waitTime = delay * Math.pow(backoff, i);
          await sleep(waitTime);
        }
      }
    }
    
    throw lastError;
  };
}

export function timeout(promise, ms, message = 'Operation timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(message)), ms)
    )
  ]);
}

export function debounce(fn, delay) {
  let timeoutId;
  
  return function(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
}

export function throttle(fn, limit) {
  let inThrottle;
  
  return function(...args) {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

// Configuration validator
export function validateConfig(config, schema) {
  const errors = [];
  
  for (const [key, rules] of Object.entries(schema)) {
    const value = config[key];
    
    // Required check
    if (rules.required && (value === undefined || value === null)) {
      errors.push(`${key} is required`);
      continue;
    }
    
    // Skip if not required and not provided
    if (!rules.required && (value === undefined || value === null)) {
      continue;
    }
    
    // Type check
    if (rules.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== rules.type) {
        errors.push(`${key} must be of type ${rules.type}`);
        continue;
      }
    }
    
    // Min/max for numbers
    if (typeof value === 'number') {
      if (rules.min !== undefined && value < rules.min) {
        errors.push(`${key} must be at least ${rules.min}`);
      }
      if (rules.max !== undefined && value > rules.max) {
        errors.push(`${key} must be at most ${rules.max}`);
      }
    }
    
    // Enum check
    if (rules.enum && !rules.enum.includes(value)) {
      errors.push(`${key} must be one of: ${rules.enum.join(', ')}`);
    }
    
    // Custom validator
    if (rules.validator) {
      const result = rules.validator(value);
      if (result !== true) {
        errors.push(result || `${key} validation failed`);
      }
    }
  }
  
  if (errors.length > 0) {
    throw new ValidationError(errors.join('; '));
  }
  
  return true;
}

// Event emitter with error handling
import { EventEmitter } from 'events';

export class SafeEventEmitter extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }
  
  emit(event, ...args) {
    try {
      return super.emit(event, ...args);
    } catch (error) {
      if (event !== 'error') {
        this.emit('error', error);
      }
      return false;
    }
  }
  
  async emitAsync(event, ...args) {
    const listeners = this.listeners(event);
    
    for (const listener of listeners) {
      try {
        await listener(...args);
      } catch (error) {
        this.emit('error', error);
      }
    }
  }
}

// Process utilities
export function gracefulShutdown(callback, timeout = 30000) {
  let shutdownInProgress = false;
  
  const shutdown = async (signal) => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    
    console.log(`\nReceived ${signal}, starting graceful shutdown...`);
    
    const shutdownTimeout = setTimeout(() => {
      console.error('Graceful shutdown timeout, forcing exit');
      process.exit(1);
    }, timeout);
    
    try {
      await callback(signal);
      clearTimeout(shutdownTimeout);
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      clearTimeout(shutdownTimeout);
      process.exit(1);
    }
  };
  
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Memory utilities
export function getMemoryStats() {
  const usage = process.memoryUsage();
  const stats = {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers || 0,
    heapUsedPercent: (usage.heapUsed / usage.heapTotal) * 100
  };
  
  // Add formatted values
  stats.formatted = {
    rss: formatBytes(stats.rss),
    heapTotal: formatBytes(stats.heapTotal),
    heapUsed: formatBytes(stats.heapUsed),
    external: formatBytes(stats.external),
    heapUsedPercent: stats.heapUsedPercent.toFixed(2) + '%'
  };
  
  return stats;
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let value = bytes;
  
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

// Default export
export default {
  // Logger
  createLogger,
  createStructuredLogger,
  logger,
  PerformanceLogger,
  setLogLevel,
  getLogLevel,
  
  // Error handling
  OtedamaError,
  ValidationError,
  NetworkError,
  DatabaseError,
  MiningError,
  ErrorHandler,
  getErrorHandler,
  
  // Performance
  BufferPool,
  WorkerPool,
  RingBuffer,
  PerformanceMonitor,
  LRUCache,
  fastHash,
  formatMemoryUsage,
  getCPUUsage,
  
  // Memory
  memoryManager,
  ObjectPool,
  
  // Utilities
  sleep,
  retry,
  timeout,
  debounce,
  throttle,
  validateConfig,
  SafeEventEmitter,
  gracefulShutdown,
  getMemoryStats,
  formatBytes,
  
  // Other exports
  configManager,
  validator,
  healthCheckManager,
  profiler,
  rateLimiter
};
